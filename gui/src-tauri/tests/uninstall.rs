//! B25 (T25) — the uninstall action: bounded-list parity, the consent gate, and the
//! never-recursive rule.
//!
//! ## What is real here and what is not
//!
//! The FILE legs run against the REAL filesystem — [`SystemFs`] over scratch directories, the
//! `cli_shim` posture. ⚠ What keeps the real `app_data_dir` / engine state dir unreachable is
//! NOT the sink — the sink here IS the real filesystem: it is the `with_app_data_dir` /
//! `with_app_config_dir` overrides on every fixture plus the fake sidecar, whose `status --json`
//! answer points the engine leg at a scratch state dir — and, since round 3, the `with_home_dir`
//! override, so the scheduler-unit check looks under a scratch home, never the developer's real
//! `~/Library/LaunchAgents`. That convention is pinned MECHANICALLY by
//! `every_default_uninstall_state_in_tests_overrides_its_real_paths` below (round-1 fix M7 — the
//! ConfigSaver/AccessState trap's fourth recurrence gets a mechanism, not a reminder). The
//! AUTOSTART leg is a recording sink only; its real `disable()` removes a
//! `~/Library/LaunchAgents` plist and is VM-gated with the rest of T19
//! (`docs/gui-seam.md` §12c, §16c).
//!
//! ⚠ **THE ENGINE IS ALWAYS A FAKE, AND SINCE BATCH 2 THAT IS WHAT KEEPS THE LIVE SCHEDULER SAFE.**
//! `uninstall_execute` now runs `schedule uninstall` (spec 3.3.4.3), which against the real engine
//! would unregister the developer's live `local.daily-briefing` job BY UID — a scratch `HOME` does
//! not isolate launchd or systemd. Every test that reaches `uninstall_execute` therefore runs a
//! script under its own `ScratchDir` through `EngineClient::with_program` (`status_sidecar`,
//! `preview_sidecar`, `fake_sidecar`), never the bundled sidecar: the client clears its environment
//! before every spawn, so the engine's own `DBA_TEST_UNIT_DIR` refusal would be no backstop here.
//! Every path a fake reports is under its `ScratchDir`, the test `ConfigSaver` stages under scratch
//! too (`app_managing`), and the tests whose scheduler step asks the engine to REMOVE take
//! `common::serialise()`'s turn, because the in-flight guard the removal takes is process-global.
//! The `keep` tests, the unanswerable-engine test and `removeOwn`'s refusals spawn nothing
//! mutating, so they take none.
//!
//! ## The parity pin (the T9 pattern)
//!
//! [`ENGINE_STATE_REMOVALS`] must be `scripts/uninstall.sh`'s `$SUPPORT`-rooted list, token for
//! token. The test PARSES the script at test time — the same anti-drift shape as
//! `tests/engine_env.rs`'s `pathEnv` parse — so editing either side alone goes red. The one line the
//! parse allows by exact text is the printed manual step (`PARSE_ALLOW_LIST`, M9 round 3); the
//! script's old `$DBA_TEST_DIR/sentinel` test-mode removal, which no test seeded or asserted, is gone
//! (M9 LOW pass, L9), and its allow-list entry with it. The launchd unit (`$PLIST`) is not removed by
//! the script at all since Batch 2 (spec 3.6.6): it is `schedule uninstall`'s territory.

mod common;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use std::sync::atomic::{AtomicU32, Ordering};
use std::time::Duration;

use common::{fake_sidecar, serialise, sq, RecordingAutostartSink, ScratchDir};
use daily_briefing_gui_lib::autostart::AutostartState;
use daily_briefing_gui_lib::config_save::{
    config_create, config_offer_notify_auto, config_save, ConfigSaver, SaveError,
    SETTINGS_REMOVED_BY_UNINSTALL,
};
use daily_briefing_gui_lib::engine::{Engine, EngineClient, EngineError, NoProgress, Operation};
use daily_briefing_gui_lib::briefing_files::ReadRefusal;
use daily_briefing_gui_lib::uninstall::{
    config_link_note, config_other_link_note, engine_copy_leg, handled_with, leftover_commands,
    managed_engine_copies, refused_for_unit, relative_key_reason, remove_app_files,
    remove_engine_state, schedule_unit_files, settings_folder_link, settings_leg,
    staged_copies_note, uninstall_execute, uninstall_preview, unit_command_note,
    unit_uninstall_command, ActionReport, EngineEntry, EntryKind, Lstat, LstatKind, Outcome,
    PathOutcome, PathReport, ScheduleSeen, SchedulerChoice, SchedulerOutcome, SettingsReport,
    SystemFs, UninstallError, UninstallFs, UninstallPreview, UninstallReport, UninstallState,
    APP_CONFIG_FILES, APP_DATA_DIRS, APP_DATA_FILES, COPY_NOT_ASKED, ENGINE_STATE_REMOVALS,
    LAUNCHD_UNIT, OTHER_LINK_NOTE, REFUSED_FOR_KEPT_SCHEDULER, REFUSED_FOR_SCHEDULE,
    REFUSED_FOR_UNIT_RULE, SCHEDULE_RECORD, SCHEDULE_STATUS_UNREADABLE, SETTINGS_BACKUP,
    SETTINGS_CONFIG, SYSTEMD_UNITS,
};
use serde_json::json;
use tauri::test::{mock_builder, MockRuntime};
use tauri::{App, Manager};

/* ── the parity pin ───────────────────────────────────────────────────────────────────────────── */

/// The uninstall script, relative to this crate — the same addressing as `engine_env.rs`'s
/// `UNIT_GENERATOR`.
const UNINSTALL_SH: &str = "../../scripts/uninstall.sh";

/// Every `$SUPPORT`-rooted removal in the script, PARSED: `(token, recursive)` per `rm` operand
/// spelled `"$SUPPORT"/<token>`. The flag word decides `recursive`: `-rf` is, `-f` is not, and since M9
/// round 4 every other flag word is refused (below); the token keeps the script's own spelling, glob
/// star included.
///
/// ⚠ THE COVERAGE GUARD (round-1 fix M1, measured): the parse recognises exactly ONE spelling,
/// so before it, a bare `rm -rf "$SUPPORT"` (the forbidden recursive delete itself), the
/// `"${SUPPORT}"` brace form and an unquoted `$SUPPORT/x` were all INVISIBLE — the set-equality
/// below stayed green while the script deleted everything. Now every `SUPPORT` mention on a
/// non-comment `rm` line must produce a parsed token, and a spelling the parse cannot see is a
/// loud failure instead of a silent hole.
///
/// ⚠ HARDENED in Batch 2 M7 (the two blind spots Checkpoint M5b found, plus a third of the same
/// class). Each was seen GREEN under the old parse and RED under this one, on a scratch mutation
/// of the script that was then restored:
///   * a backslash continuation was read as two lines, so `rm -f \` with its `"$SUPPORT"/…`
///     operand on the next line parsed no token and failed nothing. Continued lines are now
///     JOINED before anything is read;
///   * a deleter other than `rm` — `unlink`, `rmdir`, `find … -delete` — on a line naming SUPPORT
///     was invisible. Such a line now fails loudly, like an `rm` in a shape the parse cannot read;
///   * `rm<TAB>-f …` was neither an `rm` line nor a line holding `rm `. Tabs now read as spaces.
///
/// ⚠ AND IN CHECKPOINT M7 (GPT, Fable): the join inserted a space where bash removes
/// backslash-newline outright, so `r\` + `m -f …` read as `r m`; and the comment rule cut every line
/// at its FIRST `#`, quoted or mid-word, so `printf '%s\n' '#'; rm -f "$SUPPORT"/x` lost its rm. The
/// lines are now read the way bash reads them ([`bash_code_lines`]), shown on crafted text by the
/// regression tests below rather than on a mutated script.
///
/// ⚠ AND IN M9 ROUND 2 (GPT, R10 lens) it stopped modelling more bash and FAILS CLOSED instead: a
/// carriage return anywhere, a trailing comment that names SUPPORT or a deleter ([`bash_code_lines`]),
/// and a backslash on an rm line that names SUPPORT ([`support_removals_in`]) are each refused.
///
/// ⚠ AND IN M9 ROUND 3 (three Opus lenses, GPT) it FAILS CLOSED BY ALLOW-LIST, not by another blocklist.
/// Round 2 still read only lines that NAMED `SUPPORT`, so `mv "$SUPPORT"/x …`, a quoted or escaped command
/// word (`"rm"`, `r\m`, `${RM:-rm}`), `xargs rm` ending a line, `shred`, and indirection through a
/// SUPPORT-derived variable (`rm -f "$RECORD"`), a `cd` or `${!V}` each removed something under SUPPORT with
/// this test green. Now every code line that [`names_a_deleter`] must be a fully parsed `rm` line whose
/// every operand is `"$SUPPORT"/<name>` ([`parse_support_rm`]), or one of [`PARSE_ALLOW_LIST`]'s exact lines,
/// each in its exact place; anything else fails loudly, naming the line. Any whitespace but space, tab and
/// newline fails like the carriage return. (Round 3 also read `-R` as recursive like `-r`; round 4, below,
/// retired both readings by refusing every flag word but `-f` and `-rf`.)
///
/// ⚠ AND IN M9 ROUND 4 (GPT: three more shapes, reasoned from this code) it refuses ANSI-C and locale
/// quoting (`$'…'`, `$"…"`) on any line it reads, a deleter line in a here-document body unless it is the
/// allow-listed manual step under its exact opener, and every rm flag word but `-f` and `-rf` (so `-r`, `-R`
/// and `-fr` are refused now, not read as recursive). This parse is the FIRST line only: since round 4
/// `test/uninstall.test.ts` decides parity BEHAVIOURALLY — bash runs the script against a scratch folder
/// seeded with exactly this list's names plus names no list holds, and every run that carries on must
/// remove the first and leave the second byte for byte.
fn script_support_removals() -> ParsedScript {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(UNINSTALL_SH);
    let text = std::fs::read_to_string(&source).unwrap_or_else(|e| {
        panic!(
            "could not read the CLI uninstaller at {} ({e}). If it moved, this test must follow \
             it — the whole point is that the bounded list has ONE definition.",
            source.display()
        )
    });
    parse_script(&text)
}

/// The parse's ONE deleter matcher's words (M9 round 3), shared by the code-line rule ([`parse_script`])
/// and the comment rule ([`comment_may_hide_a_removal`]) through [`names_a_deleter`]. ⚠ THE SOURCE OF THE
/// LIST: test/uninstall.test.ts's PLIST pin reads this line and must find its own copy equal, so the lists
/// cannot drift again — keep the line's shape (`const DELETER_WORDS: [&str; N] = [...];`).
const DELETER_WORDS: [&str; 5] = ["rm", "rmdir", "unlink", "mv", "shred"];

/// Whether `text` names a deleter: once every `\`, `"` and `'` is deleted (so `r\m`, `"rm"` and `r''m` read
/// as `rm`), a whole word — split on anything not `[A-Za-z0-9_]`, so `/bin/rm`, `${RM:-rm}` and `xargs rm`
/// count while `confirm` and `format` do not — equal to one of [`DELETER_WORDS`], CASE-FOLDED (macOS looks a
/// command up case-insensitively on its default volume, so `RM` runs rm); or find's `-delete` anywhere. A
/// false alarm is loud and cheap to fix; a miss is silent.
fn names_a_deleter(text: &str) -> bool {
    let bare: String = text
        .chars()
        .filter(|c| !matches!(c, '\\' | '"' | '\''))
        .collect::<String>()
        .to_ascii_lowercase();
    bare.contains("-delete")
        || bare
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .any(|word| DELETER_WORDS.contains(&word))
}

/// A line the parse lets name a deleter without being a parsed SUPPORT rm line — EXACT text (after tabs and
/// a string's newlines read as spaces, trimmed), in an exact place: as code (`here_doc_of: None`), or as a
/// body line of the here-document opened by exactly that command line. A body is fed to whatever its command
/// is — `bash <<'EOF'` runs it, quoted delimiter or not — so a body line is allowed only under its own opener.
struct Allowed {
    line: &'static str,
    here_doc_of: Option<&'static str>,
}

/// The script's lines that name a deleter and are not SUPPORT removals. The parity test requires each to be
/// found EXACTLY ONCE in the real script, so an entry left unused or matched twice fails as loudly as a line
/// missing from it. (M9 LOW pass, L9: the test-mode sentinel's line, the other entry since round 3, is gone
/// from the script — no test seeded or asserted the sentinel — and so from here.)
const PARSE_ALLOW_LIST: [Allowed; 1] = [
    // Step 4 of the printed manual steps: text inside the QUOTED here-document `manual_steps` prints with
    // builtins, for the user's own terminal — never run here.
    Allowed {
        line: r#"rm -f -- "$HOME"/'Library/LaunchAgents/local.daily-briefing.plist' "$HOME"/'Library/Application Support/daily-briefing/schedule.json'"#,
        here_doc_of: Some(
            r#"while IFS= read -r line; do printf '%s\n' "$line" >&2; done <<'EOF_STEPS'"#,
        ),
    },
];

/// What the parse reads from a script: its SUPPORT removals, `(token, recursive)` per operand, and how many
/// times each [`PARSE_ALLOW_LIST`] entry was met (by index).
struct ParsedScript {
    removals: Vec<(String, bool)>,
    allowed_hits: [usize; PARSE_ALLOW_LIST.len()],
}

/// The parse itself, over any script text: the parity test feeds it the real script, and the
/// regression tests below feed it crafted shapes.
fn support_removals_in(text: &str) -> Vec<(String, bool)> {
    parse_script(text).removals
}

/// Every code line [`bash_logical_lines`] reads, judged (M9 round 3): a line that names no deleter removes
/// nothing and is passed over; one that does is an allow-listed line in its place, or a fully parsed SUPPORT
/// `rm` line, or the parse fails, naming it. Whole-line comments are already gone, and a trailing one that
/// names SUPPORT or a deleter has already failed (M9 round 2). Tabs, and the newlines a multi-line string
/// keeps, read as spaces.
fn parse_script(text: &str) -> ParsedScript {
    let mut removals = Vec::new();
    let mut allowed_hits = [0usize; PARSE_ALLOW_LIST.len()];
    let blanks = |s: &str| s.replace(['\t', '\n'], " ").trim().to_string();
    for logical in bash_logical_lines(text) {
        let trimmed = blanks(&logical.text);
        // M9 round 4 (GPT): ANSI-C and locale quoting, refused on every line read — code or here-document
        // body — before the deleter matcher: an escape inside `$'…'` can spell any word (`$'r\x6d'` is
        // `rm`), and the matcher, which only deletes quotes and backslashes, would read no deleter there.
        assert!(
            !trimmed.contains("$'") && !trimmed.contains("$\""),
            "scripts/uninstall.sh holds ANSI-C or locale quoting (`$'…'` or `$\"…\"`): {trimmed:?}. An escape \
             inside it can spell any command word (`$'r\\x6d'` is `rm`) where the deleter matcher sees none, so \
             the parity parse refuses it anywhere it reads; write the word plainly."
        );
        if trimmed.is_empty() || !names_a_deleter(&trimmed) {
            continue;
        }
        let opener = logical.here_doc_of.as_deref().map(blanks);
        if let Some(i) = PARSE_ALLOW_LIST
            .iter()
            .position(|a| a.line == trimmed && a.here_doc_of == opener.as_deref())
        {
            allowed_hits[i] += 1;
            continue;
        }
        // M9 round 4 (GPT): a deleter line in a here-document body is never read as a removal — the body is
        // text to its command, printed (`cat`) or run (`bash`), and neither can be counted toward parity.
        let parsed = match opener.as_deref() {
            Some(opener) => Err(format!(
                "it is a here-document body line (the body of {opener:?}): a body is text to its command — \
                 printed by `cat`, run by `bash` — so a removal there is never counted toward parity; the one \
                 body line that may name a deleter is PARSE_ALLOW_LIST's manual step, under its exact opener"
            )),
            None => parse_support_rm(&trimmed),
        };
        match parsed {
            Ok(tokens) => removals.extend(tokens),
            Err(reason) => panic!(
                "scripts/uninstall.sh has a line that may delete something and is not a parsed SUPPORT rm \
                 line: {trimmed:?} — {reason}. The parity parse reads only code lines `rm -f|-rf \
                 \"$SUPPORT\"/<name>… [2>/dev/null || true]`, plus PARSE_ALLOW_LIST's exact lines in their \
                 places; every other line naming rm, rmdir, unlink, mv, shred or -delete (quotes and \
                 backslashes ignored) is refused, so a removal the parity comparison cannot see fails here \
                 instead of passing."
            ),
        }
    }
    ParsedScript { removals, allowed_hits }
}

/// One `rm` line, read WHOLE (M9 round 3): `rm `, then flag words — since M9 round 4 only `-f` or `-rf`,
/// the two forms the script uses, each a whole word (`-rf` makes the line recursive); any other is refused,
/// since an invalid one makes rm delete nothing behind `2>/dev/null || true` — then one or more
/// `"$SUPPORT"/<name>` operands — `<name>` letters, digits, `.`, `_`, `-`
/// and `*`, never `.` or `..` — then nothing, or exactly ` 2>/dev/null || true`. Every word is accounted
/// for, or the reason it is not is returned. Operands are split on spaces; a backslash would make bash read
/// a word differently from that split, so a line holding one is refused (M9 round 2).
fn parse_support_rm(line: &str) -> Result<Vec<(String, bool)>, String> {
    let Some(rest) = line.strip_prefix("rm ") else {
        return Err("it is in a line shape this parse cannot read (only a line that starts with `rm ` is \
                    parsed; extend the parse, or add the exact line to PARSE_ALLOW_LIST if it removes \
                    nothing under SUPPORT)"
            .to_string());
    };
    if line.contains('\\') {
        return Err("it holds a backslash: the parse splits operands on blanks, and bash does not split \
                    on an escaped one, so the two may read different files — rewrite the line without it"
            .to_string());
    }
    let rest = rest.strip_suffix(" 2>/dev/null || true").unwrap_or(rest);
    let mut recursive = false;
    let mut tokens = Vec::new();
    for word in rest.split(' ').filter(|w| !w.is_empty()) {
        if tokens.is_empty() && word.starts_with('-') {
            match word {
                "-f" => {}
                "-rf" => recursive = true,
                _ => {
                    return Err(format!(
                        "its flag word {word:?} is not `-f` or `-rf`, the only two forms the script uses (an \
                         invalid flag makes rm delete nothing, its error hidden by `2>/dev/null || true`, \
                         while the operand would still be counted)"
                    ))
                }
            }
            continue;
        }
        let Some(name) = word.strip_prefix("\"$SUPPORT\"/") else {
            return Err(format!(
                "its word {word:?} is not a \"$SUPPORT\"/<name> operand (a bare \"$SUPPORT\", a brace or \
                 unquoted spelling, another folder, or anything after the operands but \
                 ` 2>/dev/null || true`)"
            ));
        };
        if name == "."
            || name == ".."
            || name.is_empty()
            || !name.chars().all(|c| c.is_ascii_alphanumeric() || "._-*".contains(c))
        {
            return Err(format!("its operand {word:?} names no plain entry directly under SUPPORT"));
        }
        tokens.push((name.to_string(), recursive));
    }
    if tokens.is_empty() {
        return Err("it has no \"$SUPPORT\"/<name> operand".to_string());
    }
    Ok(tokens)
}

/// The script's CODE as bash reads it, one logical line per command line:
///   * a `#` starts a comment only in code — outside single, double and `$'…'` quotes and `${…}`,
///     not backslash-escaped — and only at the start of a word (line start, or after an UNESCAPED
///     blank or one of `;&|()<>`: bash reads `\ #` and `\;#` as one word each). The comment, to the
///     end of its physical line, is dropped. (Inside a backtick substitution a `#` is kept as code:
///     reading more is the safe direction);
///   * backslash-newline is removed with nothing put in its place (bash's continuation), except
///     inside single quotes, where it is text. A comment's trailing backslash is comment, so a
///     comment never continues;
///   * a newline inside a quote or a substitution (`$(…)`, a backtick) is kept on the SAME logical
///     line, as bash keeps that command whole;
///   * a here-document's body lines follow its command line, each a logical line of its own, RAW:
///     bash reads no quotes or comments in a body, so neither does this (a body fed to a shell
///     still has every line read). Body continuations are joined the same way.
///
/// Its errors lean one way, by construction: inside any quote, substitution or expansion nothing is
/// dropped and no line is split, so a misjudged quote can only MERGE lines (read as more code, a
/// loud failure at worst), never hide one. What it does not model it refuses, loudly: an
/// unterminated quote, substitution or here-document, any `<<` inside a substitution (a
/// here-document there, or an arithmetic shift), and `case` inside one (its `pattern)` would close
/// the substitution early).
///
/// ⚠ AND WHERE A MISJUDGED WORD BOUNDARY COULD HIDE CODE, IT FAILS CLOSED (M9 round 2). A `#` it
/// wrongly reads as a comment start drops real code, and the reviews kept finding boundaries it judged
/// differently from bash — an escaped blank (round 1), a `)` closing a substitution, a carriage return.
/// Rather than model each, it refuses: a carriage return ANYWHERE (bash does not split words on one),
/// and any comment that follows code on the same logical line and names SUPPORT or a deleter
/// ([`comment_may_hide_a_removal`]) — "a comment after code holds what may be code". A false alarm is
/// loud and cheap to fix; a miss is silent. Whole-line comments are still dropped unread.
///
/// ⚠ AND THE CARRIAGE RETURN WAS ONE OF A CLASS (M9 round 3, GPT): Rust's `is_whitespace` reads VT, FF,
/// NBSP and every other Unicode space as a blank too, and bash splits words on none of them, so a vertical
/// tab before `#` made this drop a comment bash would run. ANY whitespace but space, tab and newline now
/// fails the same way.
fn bash_code_lines(text: &str) -> Vec<String> {
    bash_logical_lines(text).into_iter().map(|l| l.text).collect()
}

/// One logical line [`bash_logical_lines`] reads: its text, and — for a here-document's body line — the
/// command line that opened that here-document (M9 round 3: [`PARSE_ALLOW_LIST`] allows a body line only
/// under its own opener).
struct LogicalLine {
    text: String,
    here_doc_of: Option<String>,
}

/// [`bash_code_lines`], each line with where it stands.
fn bash_logical_lines(text: &str) -> Vec<LogicalLine> {
    assert!(
        !text.contains('\r'),
        "the script holds a carriage return: bash does not split words on one, while this parse \
         reads it as a blank — so a `#` after it, or an operand ending in it, would be read \
         differently from bash. Remove it (a CRLF line ending, typically)."
    );
    if let Some(c) = text.chars().find(|&c| c.is_whitespace() && !matches!(c, ' ' | '\t' | '\n')) {
        panic!(
            "the script holds U+{:04X}, whitespace other than space, tab and newline: bash splits words \
             on none of it, while this parse reads it as a blank — so a `#` after it, or an operand \
             holding it, would be read differently from bash. Remove it.",
            c as u32
        );
    }
    #[derive(Clone, Copy, PartialEq)]
    enum Frame {
        /// Code: the script's own (`subst: false`), or a `$(…)`'s, closed by its unmatched `)`.
        Code { subst: bool, parens: u32 },
        /// A backtick substitution's code, closed by the next unescaped backtick.
        Backtick,
        Single,
        /// `$'…'`: a backslash escapes the next character, `\'` included.
        AnsiC,
        Double,
        /// `${…}`: no comments; quotes nest; `depth` counts inner `{`.
        Brace { depth: u32 },
    }
    let chars: Vec<char> = text.chars().collect();
    let n = chars.len();
    let mut stack = vec![Frame::Code { subst: false, parens: 0 }];
    let mut lines: Vec<LogicalLine> = Vec::new();
    let mut cur = String::new();
    // Here-documents opened on the current logical line: (delimiter, `<<-` strips leading tabs).
    let mut heredocs: Vec<(String, bool)> = Vec::new();
    // `cur`'s length just after an ESCAPED character was pushed onto it. While `cur` still has that
    // length, its last character is escaped — part of a word whatever it is, a blank or `;` included —
    // so it ends no word, and a `#` after it is mid-word (M9 round 1: `echo \ #; rm …` is `echo ' #'`
    // then the rm). Cleared with `cur`, so a later line of the same length is never mistaken for it.
    let mut escaped_end: Option<usize> = None;
    let word_start = |cur: &str, escaped_end: Option<usize>| {
        escaped_end != Some(cur.len())
            && cur
                .chars()
                .next_back()
                .is_none_or(|p| p.is_whitespace() || ";&|()<>".contains(p))
    };
    let mut i = 0;
    while i < n {
        let c = chars[i];
        let next = chars.get(i + 1).copied();
        let top = *stack.last().expect("the script's own frame is never popped");
        match top {
            Frame::Single => {
                cur.push(c);
                if c == '\'' {
                    stack.pop();
                }
                i += 1;
                continue;
            }
            Frame::AnsiC => {
                cur.push(c);
                if c == '\\' {
                    if let Some(d) = next {
                        cur.push(d);
                        i += 1;
                    }
                } else if c == '\'' {
                    stack.pop();
                }
                i += 1;
                continue;
            }
            _ => {}
        }
        let in_code = matches!(top, Frame::Code { .. } | Frame::Backtick);
        // Backslash: a continuation is removed outright; anything else is escaped, both kept — and the
        // escaped character noted, so it never reads as a word boundary.
        if c == '\\' {
            match next {
                Some('\n') => i += 2,
                Some(d) => {
                    cur.push(c);
                    cur.push(d);
                    escaped_end = Some(cur.len());
                    i += 2;
                }
                None => {
                    cur.push(c);
                    i += 1;
                }
            }
            continue;
        }
        if c == '$' && next == Some('(') {
            cur.push_str("$(");
            stack.push(Frame::Code { subst: true, parens: 0 });
            i += 2;
            continue;
        }
        if c == '$' && next == Some('{') {
            cur.push_str("${");
            stack.push(Frame::Brace { depth: 0 });
            i += 2;
            continue;
        }
        if c == '$' && next == Some('\'') && top != Frame::Double {
            cur.push_str("$'");
            stack.push(Frame::AnsiC);
            i += 2;
            continue;
        }
        if c == '`' {
            cur.push(c);
            if top == Frame::Backtick {
                stack.pop();
            } else {
                stack.push(Frame::Backtick);
            }
            i += 1;
            continue;
        }
        if c == '"' {
            cur.push(c);
            if top == Frame::Double {
                stack.pop();
            } else {
                stack.push(Frame::Double);
            }
            i += 1;
            continue;
        }
        if top == Frame::Double {
            // Everything else in a double-quoted string is text, newlines and `#` included.
            cur.push(c);
            i += 1;
            continue;
        }
        if c == '\'' {
            cur.push(c);
            stack.push(Frame::Single);
            i += 1;
            continue;
        }
        if let Frame::Brace { depth } = top {
            let last = stack.last_mut().expect("a brace frame is on the stack");
            if c == '{' {
                *last = Frame::Brace { depth: depth + 1 };
            } else if c == '}' {
                if depth == 0 {
                    stack.pop();
                } else {
                    *last = Frame::Brace { depth: depth - 1 };
                }
            }
            cur.push(c);
            i += 1;
            continue;
        }
        // Code (the script's own, a `$(…)`'s or a backtick's) from here on.
        debug_assert!(in_code);
        let subst = stack.len() > 1;
        if c == '#' && top != Frame::Backtick && word_start(&cur, escaped_end) {
            let end = chars[i..].iter().position(|&d| d == '\n').map_or(n, |p| i + p);
            let comment: String = chars[i..end].iter().collect();
            // A comment after code on the same logical line (M9 round 2): if it names SUPPORT or a
            // deleter, the `#` may have been misjudged and the "comment" be code — refuse it.
            assert!(
                cur.trim().is_empty() || !comment_may_hide_a_removal(&comment),
                "a comment after code holds what may be code; rewrite the line: {:?}. A `#` this \
                 parse reads as a comment start may be mid-word to bash, and a trailing comment that \
                 names SUPPORT or a deleter is where that would hide a removal.",
                format!("{}{comment}", cur.trim_start())
            );
            i = end;
            continue;
        }
        let keyword_case = chars[i..].starts_with(&['c', 'a', 's', 'e'])
            && chars
                .get(i + 4)
                .is_none_or(|&d| d.is_whitespace() || ";&|()<>".contains(d));
        assert!(
            !(subst && keyword_case && word_start(&cur, escaped_end)),
            "the parse does not model `case` inside a substitution (its `pattern)` would close it \
             early); near {:?}",
            chars[i.saturating_sub(40)..(i + 40).min(n)].iter().collect::<String>()
        );
        if let Frame::Code { subst: true, parens } = top {
            let last = stack.last_mut().expect("a substitution frame is on the stack");
            if c == '(' {
                *last = Frame::Code { subst: true, parens: parens + 1 };
            } else if c == ')' {
                if parens == 0 {
                    stack.pop();
                } else {
                    *last = Frame::Code { subst: true, parens: parens - 1 };
                }
            }
        }
        if c == '<' && next == Some('<') {
            if chars.get(i + 2) == Some(&'<') {
                cur.push_str("<<<"); // a here-string: its word is ordinary code
                i += 3;
                continue;
            }
            assert!(
                !subst,
                "the parse does not model `<<` inside a substitution (a here-document, or an \
                 arithmetic shift); near {:?}",
                chars[i.saturating_sub(40)..(i + 40).min(n)].iter().collect::<String>()
            );
            cur.push_str("<<");
            i += 2;
            let strip = chars.get(i) == Some(&'-');
            if strip {
                cur.push('-');
                i += 1;
            }
            while i < n && (chars[i] == ' ' || chars[i] == '\t') {
                cur.push(chars[i]);
                i += 1;
            }
            // The delimiter word, its quotes removed (any quoting makes the body literal, which
            // changes nothing here: every body line is read raw).
            let mut delimiter = String::new();
            while i < n && !chars[i].is_whitespace() && !";&|()<>".contains(chars[i]) {
                let d = chars[i];
                cur.push(d);
                i += 1;
                if d == '\'' || d == '"' {
                    while i < n && chars[i] != d {
                        delimiter.push(chars[i]);
                        cur.push(chars[i]);
                        i += 1;
                    }
                    if i < n {
                        cur.push(chars[i]);
                        i += 1;
                    }
                } else if d == '\\' && i < n {
                    delimiter.push(chars[i]);
                    cur.push(chars[i]);
                    i += 1;
                } else {
                    delimiter.push(d);
                }
            }
            assert!(!delimiter.is_empty(), "a here-document operator with no delimiter word");
            heredocs.push((delimiter, strip));
            continue;
        }
        if c == '\n' && !subst {
            let opener = std::mem::take(&mut cur);
            lines.push(LogicalLine { text: opener.clone(), here_doc_of: None });
            escaped_end = None;
            i += 1;
            // The bodies of the here-documents this line opened, in order, each up to its
            // delimiter line.
            for (delimiter, strip) in std::mem::take(&mut heredocs) {
                let mut carry = String::new();
                loop {
                    assert!(
                        i < n,
                        "a here-document's body never reaches its delimiter {delimiter:?}"
                    );
                    let end = chars[i..].iter().position(|&d| d == '\n').map_or(n, |p| i + p);
                    let line: String = chars[i..end].iter().collect();
                    i = (end + 1).min(n);
                    let bare = if strip { line.trim_start_matches('\t') } else { line.as_str() };
                    if carry.is_empty() && bare == delimiter {
                        break;
                    }
                    let backslashes = line.len() - line.trim_end_matches('\\').len();
                    if backslashes % 2 == 1 {
                        carry.push_str(&line[..line.len() - 1]);
                        continue;
                    }
                    carry.push_str(&line);
                    lines.push(LogicalLine {
                        text: std::mem::take(&mut carry),
                        here_doc_of: Some(opener.clone()),
                    });
                }
            }
            continue;
        }
        cur.push(c);
        i += 1;
    }
    assert!(
        stack.len() == 1,
        "the script ends inside an unterminated quote, substitution or expansion — the parse \
         cannot read it, and would rather fail than guess"
    );
    assert!(
        heredocs.is_empty(),
        "the script ends on a here-document operator with no body"
    );
    if !cur.is_empty() {
        lines.push(LogicalLine { text: cur, here_doc_of: None });
    }
    lines
}

/// Whether a comment's text names what a misread `#` could hide (M9 round 2): `SUPPORT` anywhere, or a
/// deleter by the code rule's own matcher, [`names_a_deleter`] (M9 round 3: ONE matcher, so `shred`, `r\m`
/// and `RM` count here too; `/bin/rm` and `"rm"` count, while `confirm` and `format` do not).
fn comment_may_hide_a_removal(comment: &str) -> bool {
    comment.contains("SUPPORT") || names_a_deleter(comment)
}

/// The pin itself: set-equality between the parsed script and the Rust list, kinds included.
///
/// ⚠ Seen red on a disposable copy both ways: adding a `File` token the script does not remove to
/// the Rust list fails with the extra token named (the measured mutation added `File("last-run")`,
/// which Batch 2 has since put on BOTH lists, spec 3.5.1), and adding `rm -f "$SUPPORT"/extra-file`
/// to a script copy fails with the missing token named (mutation ledger, `docs/gui-seam.md` §16d).
#[test]
fn the_engine_list_is_the_scripts_support_rooted_list() {
    let ParsedScript { removals: parsed, allowed_hits } = script_support_removals();

    // M9 round 3: each allow-listed line is the script's, found EXACTLY ONCE in its place — an entry left
    // unused is an exemption nothing needs, and one matched twice is a second line riding on it.
    for (entry, hits) in PARSE_ALLOW_LIST.iter().zip(allowed_hits) {
        assert_eq!(
            hits, 1,
            "PARSE_ALLOW_LIST's {:?} (here-document of {:?}) was found {hits} time(s) in \
             scripts/uninstall.sh; it must be found exactly once",
            entry.line, entry.here_doc_of
        );
    }

    // prove-it 3b: a parse that silently matched nothing would make the comparison vacuous for
    // an empty Rust list. The script's shape is known: at least sixteen entries (sixteen at M9 round 3),
    // the archive dir recursive, the audit glob present.
    assert!(
        parsed.len() >= 16,
        "the parse found only {parsed:?} — the script's rm lines changed shape and the parity \
         comparison below would be vacuous; fix the parse, not the assertion"
    );
    assert!(
        parsed.iter().any(|(t, r)| t == "briefings" && *r),
        "the parse lost the recursive briefings entry: {parsed:?}"
    );
    // Batch 2 (spec 3.5.1): the provider's scratch working folder is the other recursive entry.
    assert!(
        parsed.iter().any(|(t, r)| t == "provider-cwd" && *r),
        "the parse lost the recursive provider-cwd entry: {parsed:?}"
    );
    assert!(
        parsed.iter().any(|(t, _)| t.contains('*')),
        "the parse lost the audit glob: {parsed:?}"
    );
    // Token for token, not just as sets: a token the script removes twice, or one the set below
    // would fold into another, is a drift too.
    assert_eq!(
        parsed.len(),
        ENGINE_STATE_REMOVALS.len(),
        "the parse read {} removal(s) for {} list entries: {parsed:?}",
        parsed.len(),
        ENGINE_STATE_REMOVALS.len()
    );

    let script: BTreeSet<(String, EntryKind)> = parsed
        .into_iter()
        .map(|(token, recursive)| {
            let kind = if recursive {
                EntryKind::Dir
            } else if token.contains('*') {
                EntryKind::Glob
            } else {
                EntryKind::File
            };
            (token, kind)
        })
        .collect();
    let rust: BTreeSet<(String, EntryKind)> = ENGINE_STATE_REMOVALS
        .iter()
        .map(|e| (e.token.to_string(), e.kind))
        .collect();
    assert_eq!(
        rust, script,
        "uninstall::ENGINE_STATE_REMOVALS and scripts/uninstall.sh's $SUPPORT-rooted list have \
         diverged. They are the same contract: the app's consented removal must touch exactly \
         what `bash scripts/uninstall.sh` would, and not one file more."
    );
}

/* ── the parse's own regression cases (Checkpoint M7 F4, F5) ───────────────────────────────────── */
//
// Crafted script text, never the script itself: the parse is proved on shapes it must read or refuse,
// without mutating `scripts/uninstall.sh`. For every shape the outcome must be the `extra` removal or a
// loud refusal — never a silent miss.

/// The parse's refusal for `text` (its panic message), or `None` when it parsed.
fn parse_refusal(text: &str) -> Option<String> {
    std::panic::catch_unwind(|| support_removals_in(text))
        .err()
        .map(|payload| {
            payload
                .downcast_ref::<String>()
                .cloned()
                .or_else(|| payload.downcast_ref::<&str>().map(|s| s.to_string()))
                .unwrap_or_default()
        })
}

/// The one removal every readable shape below spells.
fn extra() -> Vec<(String, bool)> {
    vec![("extra".to_string(), false)]
}

#[test]
fn a_continuation_inserts_nothing_so_a_split_word_reads_whole() {
    // bash removes backslash-newline outright: `r\` + `m` is `rm`, and a quoted operand split the
    // same way is one operand (GPT, Checkpoint M7 F4).
    assert_eq!(support_removals_in("r\\\nm -f \"$SUPPORT\"/extra\n"), extra());
    assert_eq!(support_removals_in("rm -f \"$SUP\\\nPORT\"/extra\n"), extra());
    // An even run is escaped backslashes, not a continuation: two lines, and the second is read.
    assert_eq!(support_removals_in("echo \\\\\nrm -f \"$SUPPORT\"/extra\n"), extra());
}

#[test]
fn a_hash_that_is_quoted_escaped_or_mid_word_starts_no_comment() {
    for (text, line) in [
        // GPT shape 2: a quoted `#` on a continued rm line — the line continues, its operand is kept.
        ("rm -f '#' \\\n  \"$SUPPORT\"/extra\n", "rm -f '#'   \"$SUPPORT\"/extra"),
        ("rm -f \"#\" \"$SUPPORT\"/extra\n", "rm -f \"#\" \"$SUPPORT\"/extra"),
        // `${x##*/}`: mid-word, and inside a parameter expansion.
        ("rm -f ${x##*/} \"$SUPPORT\"/extra\n", "rm -f ${x##*/} \"$SUPPORT\"/extra"),
    ] {
        // The lexer reads no comment: the line is kept whole, its SUPPORT operand included …
        assert_eq!(bash_code_lines(text), [line], "{text:?}");
        // … and since M9 round 3 every operand of a parsed rm line must be a SUPPORT one, so the parse
        // refuses these lines for their other operand rather than reading `extra` from them.
        let refusal = parse_refusal(text)
            .unwrap_or_else(|| panic!("{text:?} parsed silently to {:?}", support_removals_in(text)));
        assert!(
            refusal.contains("is not a \"$SUPPORT\"/<name> operand"),
            "{text:?} was refused for another reason: {refusal}"
        );
    }
    // An escaped `#`, and one after ANSI-C quoting's `\'` (which does not end the quote): the lexer still
    // reads no comment, so the line is kept whole — but since M9 round 2 any backslash on an rm line that
    // names SUPPORT is refused (`a_backslash_on_an_rm_line_that_names_support_is_refused`), and since M9
    // round 4 any ANSI-C quote is refused before that (`ansi_c_and_locale_quoting_are_refused_anywhere`), so
    // the parse refuses these lines rather than reading `extra` from them.
    for (text, reason) in [
        ("rm -f \\# \"$SUPPORT\"/extra\n", "holds a backslash"),
        ("rm -f $'\\'#' \"$SUPPORT\"/extra\n", "ANSI-C or locale quoting"),
    ] {
        assert_eq!(bash_code_lines(text), [text.trim_end_matches('\n')], "{text:?}");
        let refusal = parse_refusal(text)
            .unwrap_or_else(|| panic!("{text:?} parsed silently to {:?}", support_removals_in(text)));
        assert!(refusal.contains(reason), "{text:?} was refused for another reason: {refusal}");
    }
}

#[test]
fn code_after_a_quoted_hash_is_read_or_refused_never_dropped() {
    for text in [
        // GPT shape 1: the `#` is quoted, so the rm after it is code — on a line shape the parse does
        // not read, which it refuses.
        "printf '%s\\n' '#'; rm -f \"$SUPPORT\"/extra\n",
        // A `#` inside a string that spans physical lines.
        "x=\"abc\n #def\"; rm -f \"$SUPPORT\"/extra\n",
        // ...inside a string nested in a command substitution nested in a string.
        "y=\"$(printf '%s' \"a #b\")\"; rm -f \"$SUPPORT\"/extra\n",
        // ...after a blank inside `${…}`.
        "z=${x:- #}; rm -f \"$SUPPORT\"/extra\n",
    ] {
        let refusal = parse_refusal(text).unwrap_or_else(|| {
            panic!(
                "{text:?} parsed silently to {:?}",
                support_removals_in(text)
            )
        });
        assert!(
            refusal.contains("line shape this parse cannot read"),
            "{text:?} was refused for another reason: {refusal}"
        );
    }
}

#[test]
fn a_real_comment_is_dropped_and_never_continues() {
    // A trailing comment that names neither SUPPORT nor a deleter is dropped, quotes in it included.
    // (Until M9 round 2 one naming SUPPORT was dropped too — round-1 verify LOW-2. It is now refused:
    // `a_trailing_comment_that_may_hold_code_is_refused`.)
    assert_eq!(
        support_removals_in("rm -f \"$SUPPORT\"/extra # the note's \"quoted\" part\n"),
        extra()
    );
    // A whole-line comment is dropped whatever it names, SUPPORT and deleters included.
    assert_eq!(
        support_removals_in("  # never rm -rf \"$SUPPORT\" itself\nrm -f \"$SUPPORT\"/extra\n"),
        extra()
    );
    // A comment ending in a backslash — a whole-line one or a trailing one — does not swallow the
    // next line.
    assert_eq!(support_removals_in("# a note \\\nrm -f \"$SUPPORT\"/extra\n"), extra());
    assert_eq!(support_removals_in("true # a note \\\nrm -f \"$SUPPORT\"/extra\n"), extra());
}

/// M9 ROUND 2 (GPT, main-session decision): a comment that follows code on the same logical line and
/// names SUPPORT or a deleter is REFUSED, not dropped. Each misread `#` the reviews found was a word
/// boundary the lexer judged differently from bash — an escaped blank (round 1), a `)` closing a
/// command substitution, a carriage return (round 2) — and what it dropped as "comment" was code.
/// Rather than model one more boundary, the parse fails closed on what such a misread could hide: a
/// false alarm is loud and cheap to fix (rewrite the line), a miss is silent. This REVERSES round-1
/// verify LOW-2, which let a trailing `# … SUPPORT …` comment pass. Whole-line comments are still
/// dropped (`a_real_comment_is_dropped_and_never_continues`).
#[test]
fn a_trailing_comment_that_may_hold_code_is_refused() {
    for text in [
        // Round-1 verify LOW-2's own shape, which used to read `extra`.
        "rm -f \"$SUPPORT\"/extra # SUPPORT's note, \"quoted\"\n",
        // GPT, M9 round 2: bash keeps the `)` that closes a substitution inside its word, so `$(printf x)#`
        // is ONE word and the rm after the `;` runs; the lexer read the `)` as a word boundary.
        "echo $(printf x)#; rm -f \"$SUPPORT\"/extra\n",
        // An UNESCAPED blank does end a word: bash reads this `#` as a comment too. Refused all the same —
        // the rule judges what a comment could hide, not whether the lexer is right this time.
        "echo a #; rm -f \"$SUPPORT\"/x\n",
        // Each deleter, without SUPPORT: as a whole word, anywhere in the comment.
        "true # then rm it\n",
        "true # /bin/rm\n",
        "true # rmdir the folder\n",
        "true # unlink it\n",
        "true # mv it away\n",
        "true # find . -delete\n",
        // A comment inside a multi-line substitution follows that logical line's code too.
        "x=$(\n  # rm here\n  echo)\n",
    ] {
        let refusal = parse_refusal(text)
            .unwrap_or_else(|| panic!("{text:?} parsed silently to {:?}", support_removals_in(text)));
        assert!(
            refusal.contains("a comment after code holds what may be code"),
            "{text:?} was refused for another reason: {refusal}"
        );
    }
    // The deleters are matched as whole words: `confirm`, `format` and `inform` hold `rm` but are not one.
    assert_eq!(
        support_removals_in("rm -f \"$SUPPORT\"/extra # confirm the format, then inform\n"),
        extra()
    );
}

/// M9 ROUND 2 (GPT, main-session decision): a carriage return ANYWHERE fails the parse. Rust's
/// `is_whitespace` and `split_whitespace` treat `\r` as a blank; bash does not split words on it, so
/// `a\r#` is one word (the `#` starts no comment) and `"$SUPPORT"/extra\r` removes a file named
/// `extra\r`. The script has none today; a CRLF edit is refused, never read differently from bash.
#[test]
fn a_carriage_return_anywhere_is_refused() {
    for text in [
        // GPT's shape: the lexer read the CR as a blank, so the rm after `;` was dropped as a comment.
        "echo a\r#; rm -f \"$SUPPORT\"/extra\n",
        // A CRLF line: the parse would read the token `extra`; bash's operand is `extra\r`.
        "rm -f \"$SUPPORT\"/extra\r\n",
        // Anywhere at all — in a whole-line comment too.
        "# a note\r\nrm -f \"$SUPPORT\"/extra\n",
    ] {
        let refusal = parse_refusal(text)
            .unwrap_or_else(|| panic!("{text:?} parsed silently to {:?}", support_removals_in(text)));
        assert!(refusal.contains("carriage return"), "{text:?} was refused for another reason: {refusal}");
    }
}

/// M9 ROUND 2 (R10 lens): any backslash on an `rm` line that names SUPPORT fails the parse. Operands are
/// split with `split_whitespace()`, so `rm -f \ "$SUPPORT"/x` reads the token `x` — while bash reads ONE
/// word, ` "$SUPPORT"/x` with a leading space, and removes nothing there: the Rust list would then remove
/// a file the script does not. Round 1's `rm -f \ # "$SUPPORT"/extra` case changes from "reads extra" to
/// this refusal. None of the script's rm lines holds a backslash today.
#[test]
fn a_backslash_on_an_rm_line_that_names_support_is_refused() {
    for text in [
        "rm -f \\ \"$SUPPORT\"/x\n",
        // Round 1's escaped-blank operands, which used to read `extra`.
        "rm -f \\ # \"$SUPPORT\"/extra\n",
        "rm -f \\\t# \"$SUPPORT\"/extra\n",
        // Inside the operand itself.
        "rm -f \"$SUPPORT\"/ext\\ra\n",
    ] {
        let refusal = parse_refusal(text)
            .unwrap_or_else(|| panic!("{text:?} parsed silently to {:?}", support_removals_in(text)));
        assert!(refusal.contains("holds a backslash"), "{text:?} was refused for another reason: {refusal}");
    }
    // A continuation is removed before the line is read, so a continued rm line holds no backslash and
    // its operand is read.
    assert_eq!(support_removals_in("rm -f \\\n  \"$SUPPORT\"/extra\n"), extra());
}

#[test]
fn an_escaped_blank_or_operator_ends_no_word_so_the_hash_after_it_is_code() {
    // bash reads `\ #` as ONE word (` #`) and `\;#` as one (`;#`): the escaped character is part of the
    // word, so the `#` after it is mid-word and starts no comment (M9 round 1, GPT). The parse used to look
    // only at the character before the `#`, so an escaped blank or operator read as a word boundary and
    // everything after it was dropped as a comment — `echo \ #; rm -f …` lost its rm, silently.
    for text in [
        "echo \\ #; rm -f \"$SUPPORT\"/extra\n",
        "echo \\\t#; rm -f \"$SUPPORT\"/extra\n",
        "echo \\;#; rm -f \"$SUPPORT\"/extra\n",
        "echo \\|#; rm -f \"$SUPPORT\"/extra\n",
    ] {
        // The rm after the `;` is code on a line shape the parse does not read, which it refuses.
        let refusal = parse_refusal(text).unwrap_or_else(|| {
            panic!(
                "{text:?} parsed silently to {:?}",
                support_removals_in(text)
            )
        });
        assert!(
            refusal.contains("line shape this parse cannot read"),
            "{text:?} was refused for another reason: {refusal}"
        );
    }
    // On an rm line the lexer keeps the operand after the escaped blank: ` #` is part of a word, not a
    // comment. (The parse then refuses such a line for its backslash, M9 round 2:
    // `a_backslash_on_an_rm_line_that_names_support_is_refused`.)
    for text in [
        "rm -f \\ # \"$SUPPORT\"/extra\n",
        "rm -f \\\t# \"$SUPPORT\"/extra\n",
    ] {
        assert_eq!(bash_code_lines(text), [text.trim_end_matches('\n')], "{text:?}");
    }
    // An UNESCAPED blank still ends a word: that `#` starts a comment, dropped to the end of its line.
    // (One that names SUPPORT or a deleter after code is refused instead, M9 round 2:
    // `a_trailing_comment_that_may_hold_code_is_refused`.)
    assert_eq!(bash_code_lines("echo a #; a note\n"), ["echo a "]);
}

#[test]
fn a_here_document_body_is_read_raw_and_its_quotes_do_not_leak() {
    // An apostrophe in a body is text, not a quote: the code after the body is read, and its own
    // comment dropped.
    assert_eq!(
        support_removals_in("cat <<'EOF'\ndon't\nEOF\nrm -f \"$SUPPORT\"/extra # it's a note\n"),
        extra()
    );
    // The body is still READ, line by line, the way it always was: an rm of SUPPORT there is
    // refused, never skipped — a body fed to a shell runs.
    assert!(parse_refusal("bash <<EOF\nx; rm -f \"$SUPPORT\"/extra\nEOF\n").is_some());
    // ...and a continued body line is joined, so its operand is never split off onto a line of its own: the
    // refusal names the JOINED line. (Until M9 round 4 the parse read `extra` from it; a deleter line in a
    // body is refused since — `a_deleter_line_in_a_here_document_body_is_refused_unless_allow_listed`.)
    let refusal = parse_refusal("bash <<'EOF'\nrm -f \\\n\"$SUPPORT\"/extra\nEOF\n")
        .expect("a deleter line in a here-document body is refused");
    assert!(
        refusal.contains(&format!("{:?}", "rm -f \"$SUPPORT\"/extra")) && refusal.contains("here-document body"),
        "the continued body line was not refused whole: {refusal}"
    );
}

#[test]
fn shapes_the_scan_does_not_model_are_refused() {
    for text in [
        "rm -f \"$SUPPORT\"/extra '\n",          // an unterminated quote
        "x=$(echo a\n",                          // an unterminated substitution
        "cat <<'EOF'\nno end\n",                 // a here-document that never ends
        "x=$(case a in a) echo ;; esac)\n",      // `case` inside a substitution
        "x=$(cat <<EOF\nbody\nEOF\n)\n",         // a here-document inside one
    ] {
        assert!(
            parse_refusal(text).is_some(),
            "{text:?} parsed to {:?}",
            support_removals_in(text)
        );
    }
}

/// M9 ROUND 3 (three Opus lenses, GPT; main-session decision): the parse FAILS CLOSED BY ALLOW-LIST.
/// Round 2 refused only what it knew to look for on lines that NAMED `SUPPORT`, so each of these shapes
/// removed something under SUPPORT with the parity test green (reasoned by the reviewers; shown here on
/// crafted text): another deleter (`mv`, `shred`), a quoted or escaped command word, `xargs rm` ending the
/// line, and indirection through a SUPPORT-derived variable, a `cd`, or `${!V}`. Now every code line that
/// names a deleter — `rm`, `rmdir`, `unlink`, `mv` or `shred` as a whole word once every `\`, `"` and `'`
/// is deleted, or `-delete` — must be a fully parsed `rm` line whose every operand is `"$SUPPORT"/<name>`,
/// or one of the script's exact allow-listed lines. Anything else fails loudly, naming the line.
#[test]
fn a_deleter_line_that_is_not_a_parsed_support_rm_line_is_refused() {
    for (text, line) in [
        ("mv \"$SUPPORT\"/x /elsewhere\n", "mv \"$SUPPORT\"/x /elsewhere"),
        ("\"rm\" -f \"$SUPPORT\"/x\n", "\"rm\" -f \"$SUPPORT\"/x"),
        ("r\\m -f \"$SUPPORT\"/x\n", "r\\m -f \"$SUPPORT\"/x"),
        ("${RM:-rm} -rf \"$SUPPORT\"\n", "${RM:-rm} -rf \"$SUPPORT\""),
        ("printf '%s\\0' \"$SUPPORT\"/x | xargs -0 rm\n", "printf '%s\\0' \"$SUPPORT\"/x | xargs -0 rm"),
        ("shred -u \"$SUPPORT\"/x\n", "shred -u \"$SUPPORT\"/x"),
        // Indirection: RECORD and BIN are assigned from SUPPORT (uninstall.sh's own `RECORD=` line).
        ("RECORD=\"$SUPPORT/schedule.json\"\nrm -f \"$RECORD\"\n", "rm -f \"$RECORD\""),
        ("X=\"$SUPPORT/briefings\"\nrm -rf \"$X\"\n", "rm -rf \"$X\""),
        ("X=\"$SUPPORT/briefings\"; rm -rf \"$X\"\n", "X=\"$SUPPORT/briefings\"; rm -rf \"$X\""),
        ("cd \"$SUPPORT\" && rm -rf ./*\n", "cd \"$SUPPORT\" && rm -rf ./*"),
        ("rm -rf \"${!V}\"\n", "rm -rf \"${!V}\""),
        // macOS looks a command up case-insensitively on its default volume, so `RM` runs rm.
        ("RM -f \"$SUPPORT\"/x\n", "RM -f \"$SUPPORT\"/x"),
        // A parsed rm line's EVERY operand is a SUPPORT one, and nothing follows but `2>/dev/null || true`.
        ("rm -f \"$SUPPORT\"/x \"$HOME\"/y\n", "rm -f \"$SUPPORT\"/x \"$HOME\"/y"),
        ("rm -f \"$SUPPORT\"/x && rm -rf \"$SUPPORT\"\n", "rm -f \"$SUPPORT\"/x && rm -rf \"$SUPPORT\""),
        ("rm -f \"$SUPPORT\"/x;y\n", "rm -f \"$SUPPORT\"/x;y"),
        // The allow-listed line only where it is allowed: the printed manual step inside its own
        // here-document, never as code or in a body fed to a shell.
        (
            "rm -f -- \"$HOME\"/'Library/LaunchAgents/local.daily-briefing.plist' \"$HOME\"/'Library/Application Support/daily-briefing/schedule.json'\n",
            "rm -f -- \"$HOME\"/'Library/LaunchAgents/local.daily-briefing.plist' \"$HOME\"/'Library/Application Support/daily-briefing/schedule.json'",
        ),
        (
            "bash <<'EOF_STEPS'\n   rm -f -- \"$HOME\"/'Library/LaunchAgents/local.daily-briefing.plist' \"$HOME\"/'Library/Application Support/daily-briefing/schedule.json'\nEOF_STEPS\n",
            "rm -f -- \"$HOME\"/'Library/LaunchAgents/local.daily-briefing.plist' \"$HOME\"/'Library/Application Support/daily-briefing/schedule.json'",
        ),
    ] {
        let refusal = parse_refusal(text)
            .unwrap_or_else(|| panic!("{text:?} parsed silently to {:?}", support_removals_in(text)));
        assert!(
            refusal.contains("not a parsed SUPPORT rm line") && refusal.contains(&format!("{line:?}")),
            "{text:?} was refused for another reason, or without naming {line:?}: {refusal}"
        );
    }
    // A line that names no deleter is not a removal, whatever it names: the variable's own definition.
    assert_eq!(support_removals_in("X=\"$SUPPORT/x\"\nrm -f \"$SUPPORT\"/extra\n"), extra());
}

/// M9 ROUND 3: the allow-list counts each line it lets through, in its place — what the parity test's
/// "found exactly once" reads — so an entry matched twice, or in the wrong place, cannot pass unseen.
#[test]
fn the_allow_list_counts_each_line_in_its_place() {
    let [steps] = &PARSE_ALLOW_LIST;
    let opener = steps.here_doc_of.expect("the manual step is a here-document body line");
    let body = |line: &str| format!("{opener}\n   {line}\nEOF_STEPS\n");
    assert_eq!(parse_script(&body(steps.line)).allowed_hits, [1]);
    assert_eq!(
        parse_script(&format!("{}{}", body(steps.line), body(steps.line))).allowed_hits,
        [2]
    );
    // It lets nothing else through beside it.
    let beside = format!("{}rm -f \"$SUPPORT\"/extra\n", body(steps.line));
    let parsed = parse_script(&beside);
    assert_eq!((parsed.allowed_hits, parsed.removals), ([1], extra()));
}

/// M9 ROUND 3: the comment rule shares the code rule's ONE deleter matcher, so `shred`, an escaped or quoted
/// deleter and an upper-case one are each a deleter in a trailing comment too.
#[test]
fn a_trailing_comment_naming_any_deleter_the_matcher_knows_is_refused() {
    for text in [
        "true # shred it\n",
        "true # r\\m it\n",
        "true # \"rm\" it\n",
        "true # RM it\n",
        "true # ${RM:-rm}\n",
    ] {
        let refusal = parse_refusal(text)
            .unwrap_or_else(|| panic!("{text:?} parsed silently to {:?}", support_removals_in(text)));
        assert!(
            refusal.contains("a comment after code holds what may be code"),
            "{text:?} was refused for another reason: {refusal}"
        );
    }
}

/// M9 ROUND 4 (GPT): only the two flag forms the script uses, `-f` and `-rf`, each a whole word, are read;
/// any other flag word fails loudly. An invalid one (`-fz`) makes rm delete NOTHING — its error hidden by
/// `2>/dev/null || true` — while the round-3 parse, which took any `-` and letters, still counted the
/// operand. This SUPERSEDES round 3's "`-R` is recursive like `-r`" (that test's own shapes are below):
/// `-R`, `-Rf`, `-fR`, `-r` and `-fr` are refused now rather than read, which is the stricter direction.
#[test]
fn only_the_f_and_rf_flag_forms_are_read() {
    for text in [
        // GPT's shape: an invalid flag, its error hidden.
        "rm -fz \"$SUPPORT\"/extra 2>/dev/null || true\n",
        // Round 3's capital-R shapes, and the other recursive spellings.
        "rm -Rf \"$SUPPORT\"/extra\n",
        "rm -fR \"$SUPPORT\"/extra\n",
        "rm -R \"$SUPPORT\"/extra\n",
        "rm -r \"$SUPPORT\"/extra\n",
        "rm -fr \"$SUPPORT\"/extra\n",
        // Any other letter, a doubled one, a lone dash, the end-of-options marker.
        "rm -v \"$SUPPORT\"/extra\n",
        "rm -ff \"$SUPPORT\"/extra\n",
        "rm - \"$SUPPORT\"/extra\n",
        "rm -- \"$SUPPORT\"/extra\n",
        "rm -f -i \"$SUPPORT\"/extra\n",
    ] {
        let refusal = parse_refusal(text)
            .unwrap_or_else(|| panic!("{text:?} parsed silently to {:?}", support_removals_in(text)));
        assert!(
            refusal.contains("not a parsed SUPPORT rm line") && refusal.contains("is not `-f` or `-rf`"),
            "{text:?} was refused for another reason: {refusal}"
        );
    }
    // The two forms the script uses are read, and only `-rf` is recursive.
    assert_eq!(support_removals_in("rm -rf \"$SUPPORT\"/extra\n"), vec![("extra".to_string(), true)]);
    assert_eq!(support_removals_in("rm -f \"$SUPPORT\"/extra\n"), extra());
    assert_eq!(support_removals_in("rm -f \"$SUPPORT\"/extra 2>/dev/null || true\n"), extra());
}

/// M9 ROUND 4 (GPT): ANSI-C (`$'…'`) and locale (`$"…"`) quoting are refused anywhere the parse reads — a
/// code line or a here-document body. Inside `$'…'` a backslash escape can spell any word: `$'r\x6d'` is
/// `rm`, yet once the matcher deletes its quotes and backslashes it reads `$rx6d`, no deleter, so the line
/// was passed over and bash removed the whole folder. The script uses neither form.
#[test]
fn ansi_c_and_locale_quoting_are_refused_anywhere() {
    for text in [
        // GPT's shape: the command word spelled by an escape.
        "$'r\\x6d' -rf \"$SUPPORT\"\n",
        // The same word built into a variable first, then run through it.
        "D=$'\\x72\\x6d'\n$D -rf \"$SUPPORT\"\n",
        // Locale quoting.
        "echo $\"a note\"\n",
        // In a here-document body, which a shell may run.
        "bash <<'EOF'\n$'r\\x6d' -rf \"$SUPPORT\"\nEOF\n",
        // On a line that also names a deleter: refused for the quote itself, first.
        "rm -f $'\\x2e' \"$SUPPORT\"/extra\n",
    ] {
        let refusal = parse_refusal(text)
            .unwrap_or_else(|| panic!("{text:?} parsed silently to {:?}", support_removals_in(text)));
        assert!(
            refusal.contains("ANSI-C or locale quoting"),
            "{text:?} was refused for another reason: {refusal}"
        );
    }
}

/// M9 ROUND 4 (GPT): a line that names a deleter inside a here-document body is refused, whatever the
/// body's command — unless it is PARSE_ALLOW_LIST's manual step under its exact opener. Round 3 still PARSED
/// such a line as a SUPPORT removal, so `rm -f "$SUPPORT"/x` moved into `cat <<'EOF'` … `EOF` counted
/// toward parity although bash only prints it, and the Rust list kept removing a file the script no
/// longer did. A body is text to its command — printed by `cat`, run by `bash` — so neither reading can
/// be counted; the body is still read line by line, so nothing in it is skipped either.
#[test]
fn a_deleter_line_in_a_here_document_body_is_refused_unless_allow_listed() {
    for (text, line) in [
        // GPT's shape: a printing here-document.
        ("cat <<'EOF'\nrm -f \"$SUPPORT\"/extra\nEOF\n", "rm -f \"$SUPPORT\"/extra"),
        // Unquoted delimiter, tab-stripped, and the builtins-only printer the script itself uses.
        ("cat <<EOF\nrm -f \"$SUPPORT\"/extra\nEOF\n", "rm -f \"$SUPPORT\"/extra"),
        ("cat <<-EOF\n\trm -rf \"$SUPPORT\"/extra\n\tEOF\n", "rm -rf \"$SUPPORT\"/extra"),
        (
            "while IFS= read -r line; do printf '%s\\n' \"$line\"; done <<'EOF'\nrm -f \"$SUPPORT\"/extra\nEOF\n",
            "rm -f \"$SUPPORT\"/extra",
        ),
        // A body fed to a shell: refused the same way.
        ("bash <<'EOF'\nrm -f \"$SUPPORT\"/extra\nEOF\n", "rm -f \"$SUPPORT\"/extra"),
    ] {
        let refusal = parse_refusal(text)
            .unwrap_or_else(|| panic!("{text:?} parsed silently to {:?}", support_removals_in(text)));
        assert!(
            refusal.contains("not a parsed SUPPORT rm line")
                && refusal.contains(&format!("{line:?}"))
                && refusal.contains("here-document body"),
            "{text:?} was refused for another reason, or without naming {line:?}: {refusal}"
        );
    }
    // The manual step under its exact opener is still the one body line allowed, and a body line that names
    // no deleter is text, passed over.
    let [steps] = &PARSE_ALLOW_LIST;
    let opener = steps.here_doc_of.expect("the manual step is a here-document body line");
    let parsed = parse_script(&format!("{opener}\n   {}\nwait a few seconds\nEOF_STEPS\n", steps.line));
    assert_eq!((parsed.allowed_hits, parsed.removals), ([1], vec![]));
}

/// M9 ROUND 3 (GPT): any whitespace other than space, tab and newline fails the parse, like the carriage
/// return. Rust's `is_whitespace` and `split_whitespace` read VT, FF, NBSP and every other Unicode space as a
/// blank, while bash splits words only on space, tab and newline — so `a<VT>#` is one word to bash (the `#`
/// starts no comment) and an operand holding an NBSP is one file, not two.
#[test]
fn whitespace_other_than_space_tab_and_newline_is_refused() {
    for text in [
        // GPT's shape: a vertical tab before `#` made the lexer drop a comment bash would run.
        "echo a\u{0b}#; rm -f \"$SUPPORT\"/x\n",
        "echo a\u{0c}#; rm -f \"$SUPPORT\"/x\n",
        // An NBSP or an em space inside an operand: bash removes `x<NBSP>y`, the split would read `x`.
        "rm -f \"$SUPPORT\"/x\u{a0}y\n",
        "rm -f \"$SUPPORT\"/x\u{2003}y\n",
        // Anywhere at all — a whole-line comment included.
        "# a note\u{85}\nrm -f \"$SUPPORT\"/extra\n",
    ] {
        let refusal = parse_refusal(text)
            .unwrap_or_else(|| panic!("{text:?} parsed silently to {:?}", support_removals_in(text)));
        assert!(
            refusal.contains("other than space, tab and newline"),
            "{text:?} was refused for another reason: {refusal}"
        );
    }
}

/// No token is a path, and each glob carries exactly one star — the shapes the remover joins onto
/// the engine's state dir without any further validation.
#[test]
fn the_tokens_are_names_not_paths_and_globs_carry_one_star() {
    for EngineEntry { token, kind } in ENGINE_STATE_REMOVALS {
        assert!(
            !token.contains('/') && !token.contains("..") && !token.is_empty(),
            "{token:?} is not a bare direct-child name"
        );
        let stars = token.matches('*').count();
        match kind {
            EntryKind::Glob => {
                assert_eq!(stars, 1, "{token:?} must carry exactly one star");
                // Round-1 fix F6: `glob_matches("*", name)` matches EVERY direct child — a lone
                // star is a sweep of the state dir wearing a glob's clothes, and this guard read
                // as if it prevented that without actually checking.
                assert_ne!(
                    *token, "*",
                    "a bare `*` glob token matches every direct child of the state dir — never a \
                     bounded removal"
                );
            }
            _ => assert_eq!(stars, 0, "{token:?} must carry no star"),
        }
    }
    // And the app-side lists obey the same rule.
    for name in APP_DATA_FILES
        .iter()
        .chain(APP_DATA_DIRS)
        .chain(APP_CONFIG_FILES)
    {
        assert!(
            !name.contains('/') && !name.contains(".."),
            "{name:?} is not a bare direct-child name"
        );
    }
}

/* ── the real-dirs default trap, pinned mechanically (round-1 fix M7) ─────────────────────────── */

/// Every `.rs` file under `dir`, recursively.
fn collect_rs_files(dir: &Path, out: &mut Vec<PathBuf>) {
    for entry in std::fs::read_dir(dir).expect("tests dir is readable") {
        let path = entry.expect("dir entry").path();
        if path.is_dir() {
            collect_rs_files(&path, out);
        } else if path.extension().is_some_and(|e| e == "rs") {
            out.push(path);
        }
    }
}

/// `text` with every `//`-to-end-of-line stretch removed (`///` and `//!` included), so the pin
/// below searches CODE, not prose about the code — its own doc comment names the construct it
/// hunts. Cutting at a `//` inside a string literal could truncate a line, but a truncated real
/// chain fails the assert LOUDLY, which is the safe direction.
fn without_line_comments(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for line in text.lines() {
        out.push_str(line.split("//").next().unwrap_or(""));
        out.push('\n');
    }
    out
}

/// The method names chained onto the expression `rest` starts after: `.name(args)` repeated,
/// stopping at the first non-`.` continuation. Line comments between calls are skipped; paren
/// depth tracks the argument lists (good enough for this crate's builder chains — no string
/// literal in them carries an unbalanced paren, and a false stop fails LOUD, not silent).
fn chained_methods(rest: &str) -> Vec<String> {
    let mut methods = Vec::new();
    let mut chars = rest.char_indices().peekable();
    loop {
        // Skip whitespace and `//` comments.
        while let Some(&(i, c)) = chars.peek() {
            if c.is_whitespace() {
                chars.next();
            } else if rest[i..].starts_with("//") {
                for (_, c2) in chars.by_ref() {
                    if c2 == '\n' {
                        break;
                    }
                }
            } else {
                break;
            }
        }
        match chars.peek() {
            Some(&(_, '.')) => {
                chars.next();
            }
            _ => return methods,
        }
        let mut name = String::new();
        while let Some(&(_, c)) = chars.peek() {
            if c.is_ascii_alphanumeric() || c == '_' {
                name.push(c);
                chars.next();
            } else {
                break;
            }
        }
        methods.push(name);
        // Consume the balanced `(…)` argument list, if any.
        if let Some(&(_, '(')) = chars.peek() {
            let mut depth = 0i32;
            for (_, c) in chars.by_ref() {
                if c == '(' {
                    depth += 1;
                } else if c == ')' {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                }
            }
        }
    }
}

/// The FOURTH recurrence of the ConfigSaver/AccessState trap gets a MECHANISM (round-1 fix M7).
///
/// `UninstallState::default()` is the real `SystemFs` over the real `app_data_dir()` /
/// `app_config_dir()` — measured on the `MockRuntime`: it resolves the developer's live
/// `~/Library/Application Support/com.themarigold.daily-briefing`, not a sandbox — and
/// `uninstall_execute` DELETES files. Two remembered builder calls were all that kept every test
/// off those directories. The T9 source-parse idiom, applied to ourselves: every
/// `UninstallState::default()` under `tests/` must chain BOTH dir overrides in the same
/// expression — and, since round 3 (D3-L4), the HOME override too: the default looks for the
/// scheduler unit files under the REAL home, where the developer's live
/// `local.daily-briefing.plist` sits, so a test without it would be refused by that machine's own
/// schedule (and would read a real `~/Library/LaunchAgents`).
#[test]
fn every_default_uninstall_state_in_tests_overrides_its_real_paths() {
    let tests_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests");
    // Concatenated so this test's own string never satisfies its own search.
    let needle: String = ["UninstallState::", "default()"].concat();
    let mut sources = Vec::new();
    collect_rs_files(&tests_dir, &mut sources);
    let mut occurrences = 0usize;
    for path in &sources {
        let raw = std::fs::read_to_string(path).expect("test source is readable");
        let text = without_line_comments(&raw);
        // The stripper cuts at the FIRST `//` on a line, including one inside a string
        // literal — which would swallow a needle to its right and skip the walk for it
        // entirely (round-1 verify LOW-1). Compare against the raw CODE lines (whole-line
        // comments excluded — doc comments name the needle legitimately): a mismatch means
        // a needle hides behind a mid-line `//`. Refuse it instead of silently not seeing it.
        let raw_code_count: usize = raw
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .map(|l| l.matches(&needle).count())
            .sum();
        assert_eq!(
            raw_code_count,
            text.matches(&needle).count(),
            "{}: a `{needle}` sits after a `//` on its line (e.g. inside a string literal) — \
             the comment stripper cannot see it, so this pin cannot walk its chain. Move it to \
             its own line.",
            path.display()
        );
        let mut from = 0usize;
        while let Some(at) = text[from..].find(&needle) {
            let start = from + at + needle.len();
            from = start;
            occurrences += 1;
            let methods = chained_methods(&text[start..]);
            let has = |m: &str| methods.iter().any(|name| name == m);
            assert!(
                has("with_app_data_dir") && has("with_app_config_dir") && has("with_home_dir"),
                "{}: a `{needle}` does not chain with_app_data_dir, with_app_config_dir AND \
                 with_home_dir (chained: {methods:?}). The default is the REAL filesystem over the \
                 REAL app directories and the REAL home's scheduler units, and uninstall_execute \
                 deletes files — override all three, always.",
                path.display()
            );
        }
    }
    // prove-it 3b: a parse that found nothing would pass vacuously; the two known fixtures
    // (this file's and tests/capability.rs's) must be visible to it.
    assert!(
        occurrences >= 2,
        "the source parse found only {occurrences} `{needle}` occurrence(s) under tests/ — the \
         pin's own search broke; fix the parse, not the assertion"
    );

    // Batch 2 (spec 3.5.4, 3.7): the test `ConfigSaver` stages under a SCRATCH candidate folder.
    // `uninstall_execute` takes its lock (spec 3.3.4.2), so every file that builds an uninstall
    // state manages one — and `ConfigSaver::default()` resolves the developer's REAL
    // `app_data_dir()` on `MockRuntime` (the ConfigSaver/AccessState trap). So in each such file,
    // every `ConfigSaver::` in code is `with_candidate_dir`, and there is at least one.
    let saver_any: String = ["Config", "Saver::"].concat();
    let saver_scratch: String = ["Config", "Saver::with_candidate_dir("].concat();
    let mut saver_files = 0usize;
    for path in &sources {
        let text = without_line_comments(&std::fs::read_to_string(path).expect("readable"));
        if !text.contains(&needle) {
            continue;
        }
        saver_files += 1;
        let scratch_count = text.matches(&saver_scratch).count();
        // (The message spells neither needle, so this pin's own text cannot satisfy it.)
        assert!(
            scratch_count >= 1 && text.matches(&saver_any).count() == scratch_count,
            "{}: builds an uninstall state, so its ConfigSaver must be built with a scratch \
             candidate dir, and only so ({scratch_count} of {} constructions are)",
            path.display(),
            text.matches(&saver_any).count()
        );
    }
    assert!(saver_files >= 2, "premise: both fixtures were scanned");

    // Batch 2 (spec 3.5.2, 3.5.4): an overridden home also drops the ambient `XDG_DATA_HOME`, so a
    // test can never resolve a developer's real Linux engine copy.
    an_overridden_home_drops_the_ambient_xdg_data_home();
}

/// The marker on the pin's re-run (M9 round 3): set only on that re-run's command (and by the test that
/// drives a marked child), and read only by the pin itself.
const XDG_PIN_CHILD: &str = "DBA_TEST_XDG_PIN_CHILD";

/// The `XDG_DATA_HOME` half of the pin above. Measured, never assumed: when this process has no
/// ambient `XDG_DATA_HOME` (the prescribed `env -u XDG_DATA_HOME` run), the check would be vacuous,
/// so the pin re-runs ITSELF — this test binary, that one test, `--exact` — with one set, which is
/// a child's own environment from its start (no `set_var` race in this multi-threaded process). In
/// either process nothing is removed: the check only resolves paths.
///
/// ⚠ AND SO DOES AN AMBIENT VALUE THAT ADDS NO CANDIDATE (M9 round 1, GPT): a relative one (ignored,
/// as the XDG base-directory spec requires) or the default spelled out resolves the same copies as
/// none, so the equality holds whether or not the drop happens. Then the pin re-runs too, with the
/// controlled value — absolute, under scratch, not the default — which the child's own premise
/// proves would add one. That child takes the premise arm, so it never re-runs again.
///
/// ⚠ AND THE RE-RUN IS MARKED (M9 round 3, GPT): "it never re-runs again" held only while the controlled
/// value added a candidate. A regression that made it add none would send the child down the "adds no
/// candidate" arm to re-run ITSELF, forever — a hang, not a failure. So the re-run carries
/// [`XDG_PIN_CHILD`], set on that command only, and a marked child that would re-run fails its premise
/// instead (`a_marked_re_run_whose_value_adds_no_candidate_fails_instead_of_re_running`).
fn an_overridden_home_drops_the_ambient_xdg_data_home() {
    const PIN: &str = "every_default_uninstall_state_in_tests_overrides_its_real_paths";
    let scratch = ScratchDir::new("uninstall-xdg-data");
    let home = scratch.join("home");
    let rerun_with_a_controlled_value = || {
        let ambient = scratch.join("ambient-xdg-data");
        let out = std::process::Command::new(
            std::env::current_exe().expect("this test binary's path"),
        )
        .args([PIN, "--exact", "--test-threads=1"])
        .env("XDG_DATA_HOME", &ambient)
        .env(XDG_PIN_CHILD, "1")
        .output()
        .expect("this test binary re-runs");
        let stdout = String::from_utf8_lossy(&out.stdout);
        assert!(
            out.status.success() && stdout.contains("test result: ok. 1 passed"),
            "the pin, re-run with XDG_DATA_HOME={}, did not pass exactly once:\n{stdout}\n{}",
            ambient.display(),
            String::from_utf8_lossy(&out.stderr)
        );
    };
    // The re-run's own process: it re-runs nothing, whatever it finds.
    let marked = std::env::var_os(XDG_PIN_CHILD).is_some();
    match std::env::var_os("XDG_DATA_HOME") {
        Some(ambient) => {
            let ambient = PathBuf::from(ambient);
            let state = UninstallState::default()
                .with_app_data_dir(scratch.join("app-data"))
                .with_app_config_dir(scratch.join("app-config"))
                .with_home_dir(home.clone());
            let copies = state.engine_copies_on("linux");
            assert_eq!(
                copies,
                managed_engine_copies("linux", &home, None),
                "an overridden home must resolve the engine copies under it alone"
            );
            let with_ambient = managed_engine_copies("linux", &home, Some(&ambient));
            if with_ambient == managed_engine_copies("linux", &home, None) {
                // This value adds no candidate, so the equality above proved nothing: prove the drop
                // with one that does — unless this IS that re-run, whose value was chosen to add one.
                assert!(
                    !marked,
                    "premise: the controlled XDG_DATA_HOME must add a candidate, and {} added none, so \
                     the drop is unproved; this re-run fails rather than re-running itself",
                    ambient.display()
                );
                rerun_with_a_controlled_value();
            } else {
                // prove-it 3b: with the ambient value NOT dropped, the answer would differ.
                assert_eq!(
                    with_ambient.len(),
                    2,
                    "premise: the ambient XDG_DATA_HOME would add a candidate"
                );
            }
        }
        None => {
            assert!(
                !marked,
                "premise: the controlled XDG_DATA_HOME must add a candidate, and none reached this re-run"
            );
            rerun_with_a_controlled_value();
        }
    }
}

/// M9 ROUND 3 (GPT): the pin's re-run is MARKED, and a marked child whose value adds no candidate fails the
/// premise instead of re-running — so a regression that made the controlled value add none is a failure,
/// not a re-run of a re-run, forever. Driven here with a RELATIVE value (ignored, as the XDG base-directory
/// spec requires, so it adds no candidate) — never a real XDG path — and the marker set by hand: the child
/// must fail, naming the premise. Without the marker check it re-ran itself with the controlled value and
/// passed.
#[test]
fn a_marked_re_run_whose_value_adds_no_candidate_fails_instead_of_re_running() {
    let out = std::process::Command::new(std::env::current_exe().expect("this test binary's path"))
        .args([
            "every_default_uninstall_state_in_tests_overrides_its_real_paths",
            "--exact",
            "--test-threads=1",
        ])
        .env("XDG_DATA_HOME", "relative/xdg-data")
        .env(XDG_PIN_CHILD, "1")
        .output()
        .expect("this test binary re-runs");
    let both = format!(
        "{}\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(
        !out.status.success() && both.contains("the controlled XDG_DATA_HOME must add a candidate"),
        "a marked child whose XDG_DATA_HOME adds no candidate must fail its premise, not re-run:\n{both}"
    );
}

/* ── the removals, against the real filesystem in scratch ─────────────────────────────────────── */

fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("scratch parent");
    }
    std::fs::write(path, text).expect("scratch file");
}

fn outcome_of<'r>(report: &'r [ActionReport], name: &str) -> &'r Outcome {
    &report
        .iter()
        .find(|r| r.name == name)
        .unwrap_or_else(|| panic!("no report line for {name:?}: {report:?}"))
        .outcome
}

/// Every file Batch 2 added to the bounded list (spec 3.5.1): the rest of what the engine owns at
/// the state root (`src/json.ts`'s `engineOwns` — the day marker, the tick, the skip record, the
/// run lock, the account store, the recap-campaigns record). `provider-cwd` is the added DIRECTORY.
const BATCH2_ENGINE_FILES: [&str; 6] = [
    "last-run",
    "last-tick",
    "last-skip.json",
    "run.lock",
    "account-state.json",
    "recap-campaigns.jsonl",
];

/// The consented leg removes exactly the bounded list — and the survivors PROVE the rule that
/// matters most: never a recursive delete of the state dir. A file this module has never heard of
/// (and the audit glob's near-misses) all outlive the uninstall; the only directories removed with
/// their contents are the two the list names, `briefings` and `provider-cwd`.
#[test]
fn a_consented_removal_touches_exactly_the_bounded_list() {
    let scratch = ScratchDir::new("uninstall-engine");
    let state = scratch.join("state");

    let mut targets = vec![
        "daily-briefing",
        "wake-schedule.json",
        "briefing.log",
        "briefing-latest.md",
        "briefing.log.1",
        "transcript-health.json",
        "audit-2026-09-01.md",
        "audit-2026-09-02.md",
        // Phase E (E11): the opt-in update check's record.
        "update-check.json",
    ];
    targets.extend(BATCH2_ENGINE_FILES);
    for name in &targets {
        write(&state.join(name), name);
    }
    write(&state.join("briefings").join("2026-09-01.md"), "archived");
    write(&state.join("briefings").join("2026-09-02.md"), "archived");
    // Batch 2 (spec 3.5.1): the provider's scratch working folder, with something in it.
    write(&state.join("provider-cwd").join("scratch.txt"), "provider");
    // ⚠ NO `schedule.json` HERE (Phase E final harden, round 2): a schedule record REFUSES the
    // whole leg, so this — the list removed in full — is the NO-record case. The record's case is
    // `a_schedule_record_refuses_the_whole_engine_leg_whoever_owns_it`.
    let survivors = [
        "somebody-elses-notes.txt",
        // Glob near-misses: the audit glob must not overreach.
        "audit-2026-09-01.txt",
        "not-audit-2026-09-01.md.bak",
    ];
    for name in survivors {
        write(&state.join(name), name);
    }

    let report =
        remove_engine_state(&SystemFs, &state, &[]).expect("no schedule record: the leg runs");

    for EngineEntry { token, .. } in ENGINE_STATE_REMOVALS {
        assert_eq!(
            outcome_of(&report, token),
            &Outcome::Removed,
            "{token} was planted and must be reported removed"
        );
    }
    for name in &targets {
        assert!(!state.join(name).exists(), "{name} must be gone");
    }
    assert!(
        !state.join("briefings").exists(),
        "the archive dir must be gone"
    );
    assert!(
        !state.join("provider-cwd").exists(),
        "the provider's scratch working folder must be gone, with its contents"
    );
    for name in survivors {
        assert!(
            state.join(name).exists(),
            "{name} is OUTSIDE the bounded list and must survive"
        );
    }
    assert!(state.exists(), "the state dir itself must survive");
}

/// Every entry under `dir` with its bytes — a symlink as its target, a directory as a marker — so
/// "nothing removed" can be asserted as NOTHING CHANGED rather than as "the files I thought of".
fn tree(dir: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn walk(root: &Path, dir: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        for entry in std::fs::read_dir(dir).expect("scratch dir is readable") {
            let path = entry.expect("dir entry").path();
            let rel = path.strip_prefix(root).expect("under root").to_path_buf();
            let meta = std::fs::symlink_metadata(&path).expect("lstat");
            if meta.file_type().is_symlink() {
                let target = std::fs::read_link(&path).expect("readlink");
                out.insert(rel, format!("-> {}", target.display()).into_bytes());
            } else if meta.is_dir() {
                out.insert(rel, b"<dir>".to_vec());
                walk(root, &path, out);
            } else {
                out.insert(rel, std::fs::read(&path).expect("read"));
            }
        }
    }
    let mut out = BTreeMap::new();
    walk(dir, dir, &mut out);
    out
}

/// THE GUI-SIDE H1 GUARD, round 2 (Phase E final harden, A-M1 — superseding round 1's "keep only
/// the engine copy"). `scripts/uninstall.sh` removes nothing while `$RECORD` exists until the
/// engine has removed its own schedule (its scheduler block, Batch 2 spec 3.6.6). Round 1's app
/// leg kept `daily-briefing` and deleted the rest, so the schedule went on running the kept copy,
/// calling the provider every morning and RE-CREATING the archive and log the user had consented
/// to delete. Now a record refuses the WHOLE leg: the state dir is byte-for-byte what it was, and the
/// answer is the one refusal that names the way out. Whoever owns the record — this app, the CLI,
/// or nobody legible (an unparseable record; a dangling symlink, which `exists`'s `lstat` still
/// sees) — it refuses the same way: the owner is not read, and an unreadable record fails toward
/// not deleting. With the record gone, the same directory loses exactly the bounded list again.
#[test]
fn a_schedule_record_refuses_the_whole_engine_leg_whoever_owns_it() {
    for record_kind in ["app-owned", "cli-owned", "unparseable", "dangling-symlink"] {
        let scratch = ScratchDir::new("uninstall-scheduled");
        let state = scratch.join("state");
        let mut targets = vec![
            "daily-briefing",
            "wake-schedule.json",
            "briefing.log",
            "briefing-latest.md",
            "briefing.log.1",
            "transcript-health.json",
            "audit-2026-09-01.md",
            "update-check.json",
        ];
        targets.extend(BATCH2_ENGINE_FILES);
        for name in &targets {
            write(&state.join(name), name);
        }
        write(&state.join("briefings").join("2026-09-01.md"), "archived");
        write(&state.join("provider-cwd").join("scratch.txt"), "provider");
        write(&state.join("somebody-elses-notes.txt"), "not the engine's");
        let record = |owner: &str| {
            format!(
                r#"{{"owner":"{owner}","invoker":"{owner}","unitPath":"/u/local.daily-briefing.plist","binPath":"{}","installedAt":"2026-09-17T07:00:00.000Z"}}"#,
                state.join("daily-briefing").display()
            )
        };
        match record_kind {
            "app-owned" => write(&state.join(SCHEDULE_RECORD), &record("app")),
            "cli-owned" => write(&state.join(SCHEDULE_RECORD), &record("cli")),
            "unparseable" => write(&state.join(SCHEDULE_RECORD), "{ half"),
            _ => {
                #[cfg(unix)]
                std::os::unix::fs::symlink(scratch.join("nowhere"), state.join(SCHEDULE_RECORD))
                    .expect("a dangling record");
                #[cfg(not(unix))]
                write(&state.join(SCHEDULE_RECORD), "{}");
            }
        }
        let before = tree(&state);
        // prove-it 3b: an empty picture would make the equality below vacuous.
        assert!(
            before.len() >= targets.len() + 4,
            "{record_kind}: premise — the fixture planted the tree: {before:?}"
        );

        let refused = remove_engine_state(&SystemFs, &state, &[]);

        assert_eq!(
            refused,
            Err(REFUSED_FOR_SCHEDULE.to_string()),
            "{record_kind}: a schedule record must refuse the whole engine leg"
        );
        assert_eq!(
            tree(&state),
            before,
            "{record_kind}: the refused leg changed the state dir — it must remove NOTHING"
        );

        // The same directory with the record gone: the bounded list goes, as it always did.
        std::fs::remove_file(state.join(SCHEDULE_RECORD)).expect("remove the record");
        let report = remove_engine_state(&SystemFs, &state, &[])
            .unwrap_or_else(|why| panic!("{record_kind}: refused with no record: {why}"));
        for EngineEntry { token, .. } in ENGINE_STATE_REMOVALS {
            assert_eq!(
                outcome_of(&report, token),
                &Outcome::Removed,
                "{record_kind}: {token} was planted and must go once the record is gone"
            );
        }
        for name in &targets {
            assert!(
                !state.join(name).exists(),
                "{record_kind}: {name} must be gone once the record is"
            );
        }
        assert!(
            !state.join("provider-cwd").exists(),
            "{record_kind}: provider-cwd must be gone once the record is"
        );
        assert!(
            state.join("somebody-elses-notes.txt").exists(),
            "outside the bounded list"
        );
    }
}

/// The refusal names the way out EXACTLY: the Schedule screen's real removal button — read from
/// the component that draws it, so a renamed button cannot leave this text pointing at nothing —
/// the engine's own subcommand for a schedule installed from a terminal, and "then Uninstall
/// again". The rule sentence is the webview's (`tests-web/coexistence.check.ts` holds this text to
/// it). Batch 2 (spec 3.6.1, 3.6.4): it speaks of "these files", since it refuses the settings step
/// too, and the old stale-record clause ("delete `schedule.json`") is GONE — both ways out now reach
/// every record (the Schedule screen's button shows for the record FILE, readable or not, and the
/// engine removes a malformed or dangling record), so no record is a dead end.
#[test]
fn the_refusal_names_the_real_way_out() {
    const BUTTON: &str = "Remove background scheduler…";
    let component =
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/lib/ScheduleUninstall.svelte");
    let source = std::fs::read_to_string(&component)
        .unwrap_or_else(|e| panic!("could not read {} ({e})", component.display()));
    assert!(
        source.contains(&format!("\"{BUTTON}\"")),
        "ScheduleUninstall.svelte no longer draws a {BUTTON:?} button — REFUSED_FOR_SCHEDULE and \
         SCHEDULE_WAY_OUT (lib/app-uninstall.ts) name it as the way out; rename all three together"
    );
    for part in [
        format!("Schedule screen → {BUTTON}"),
        "`daily-briefing schedule uninstall`".to_string(),
        "if you installed it from the terminal".to_string(),
        "then run Uninstall again".to_string(),
        "Uninstall removes none of these files while a background schedule is installed"
            .to_string(),
        SCHEDULE_RECORD.to_string(),
        // Round 4 (B4-L6): the RECORD's refusal opens on the record alone — a record-less unit
        // has its own (`refused_for_unit`, below), so this text no longer names a unit file. The
        // gate look comes after the scheduler step, so the record is one still there.
        "a background schedule's record (schedule.json) is still there,".to_string(),
        "it keeps running the background engine copy, which needs these files.".to_string(),
    ] {
        assert!(
            REFUSED_FOR_SCHEDULE.contains(&part),
            "the refusal does not say {part:?}: {REFUSED_FOR_SCHEDULE}"
        );
    }
    for absent in [
        "unit file",
        // The stale-record clause, and the premise it rested on.
        "stale",
        "delete",
        "reports nothing installed",
        // Not only the engine's data any more: the settings step is refused with the same text.
        "the engine's data",
    ] {
        assert!(
            !REFUSED_FOR_SCHEDULE.contains(absent),
            "the record's refusal says {absent:?} again: {REFUSED_FOR_SCHEDULE}"
        );
    }
    assert!(
        REFUSED_FOR_SCHEDULE.ends_with("then run Uninstall again."),
        "the way out ends the refusal: {REFUSED_FOR_SCHEDULE}"
    );
}

/// THE RECORD-LESS UNIT'S REFUSAL IS ITS OWN (round 4, B4-L6). It used to be the RECORD's refusal
/// with the unit appended: a stale-RECORD clause ("delete `schedule.json`") for a case with no
/// record, and the way out that applies — `daily-briefing schedule uninstall`, which removes a
/// present unit with no record (`src/schedule/install.ts`, `uninstallSchedule`: it unregisters the
/// job by its label, then deletes the unit files) — LAST. Now it names the unit, then
/// `REFUSED_FOR_UNIT_RULE`, whose first instruction is that command; it carries no record clause,
/// and no Schedule-screen button either. Batch 2 rewrote that reason (spec 3.6.4; the doc comment on
/// `REFUSED_FOR_UNIT_RULE`): the screen does offer a unit's removal now (spec 3.4.1), but only for a
/// unit the app-spawned engine sees, and such a unit is removed by the scheduler step before the
/// gate look — so the unit this refusal names is one that screen never shows. Of "these files", as
/// the record's refusal is. `tests-web/coexistence.check.ts` holds the rule to the webview's
/// `SCHEDULE_UNIT_RULE`, word for word.
#[test]
fn a_record_less_units_refusal_names_its_own_way_out_first() {
    let unit = Path::new("/h/Library/LaunchAgents/local.daily-briefing.plist");
    let refused = refused_for_unit(unit);
    assert!(
        refused.contains("(/h/Library/LaunchAgents/local.daily-briefing.plist)"),
        "{refused}"
    );
    assert!(
        refused.starts_with(
            "a background scheduler unit file (/h/Library/LaunchAgents/local.daily-briefing.plist) \
             is still there with no schedule record, and while it is installed it keeps running \
             the background engine copy, which needs these files. "
        ),
        "{refused}"
    );
    assert!(refused.ends_with(REFUSED_FOR_UNIT_RULE), "{refused}");
    assert_eq!(
        REFUSED_FOR_UNIT_RULE,
        "Uninstall removes none of these files while a background scheduler unit file is there: \
         run `daily-briefing schedule uninstall` in a terminal, which removes that scheduler and \
         its unit file, then run Uninstall again."
    );
    for absent in [
        SCHEDULE_RECORD,
        "stale",
        "Schedule screen",
        "if you installed it from the terminal",
        "the engine's data",
        "an older install",
    ] {
        assert!(
            !refused.contains(absent),
            "a record-less unit's refusal says {absent:?}: {refused}"
        );
    }
    assert!(
        !refused.starts_with(REFUSED_FOR_SCHEDULE) && !refused.contains(REFUSED_FOR_SCHEDULE),
        "{refused}"
    );
    // The macOS plist gets no command of its own: `daily-briefing schedule uninstall` as the rule
    // says always looks in `~/Library/LaunchAgents` (cap round, G5-2 — Linux only).
    assert_eq!(unit_command_note(unit), None);
}

/// A LINUX UNIT'S WAY OUT IS A COMMAND FOR ITS OWN DIRECTORY (cap round, G5-2). This app looks under
/// both `$XDG_CONFIG_HOME/systemd/user` and `~/.config/systemd/user` (`schedule_unit_files`), but
/// `daily-briefing schedule uninstall` looks only under the one its environment names
/// (`src/schedule/install.ts`, `unitDir`), so from a terminal with another `XDG_CONFIG_HOME` it
/// reports nothing installed and the unit keeps refusing. For EACH directory the app looks in — one
/// spelled with a space, a quote and a `$` — the refusal is the rule, then the command with
/// `XDG_CONFIG_HOME` set to that unit's own config directory; and a real `/bin/sh` proves the quoting
/// hands a program exactly that directory. (Only the `XDG_CONFIG_HOME=…` prefix is run, in front of
/// `printenv` — the command's own program is stripped off first and never runs.)
#[cfg(unix)]
#[test]
fn a_linux_units_refusal_names_the_command_for_its_own_directory() {
    let home = Path::new("/h");
    let custom = "/x/my cfg/it's $HOME";
    let units = schedule_unit_files("linux", home, Some(Path::new(custom)));
    assert_eq!(units.len(), 4, "premise: both directories, both units");
    for (unit, config, quoted) in [
        (&units[0], custom, r"'/x/my cfg/it'\''s $HOME'"),
        (&units[1], custom, r"'/x/my cfg/it'\''s $HOME'"),
        (&units[2], "/h/.config", "'/h/.config'"),
        (&units[3], "/h/.config", "'/h/.config'"),
    ] {
        let command = unit_uninstall_command(unit).expect("a systemd unit has a command");
        assert_eq!(
            command,
            format!("XDG_CONFIG_HOME={quoted} daily-briefing schedule uninstall"),
            "{unit:?}"
        );
        let refused = refused_for_unit(unit);
        assert!(
            refused.ends_with(&format!(
                "{REFUSED_FOR_UNIT_RULE} To remove this unit file from a terminal, run \
                 `{command}`: `daily-briefing schedule uninstall` looks for it only under \
                 `$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user` when \
                 XDG_CONFIG_HOME is unset."
            )),
            "{refused}"
        );
        assert!(
            refused.contains(&format!("({})", unit.display())),
            "{refused}"
        );

        // The quoting, measured: the prefix alone, in front of `printenv`, through a real shell.
        let prefix = command
            .strip_suffix(" daily-briefing schedule uninstall")
            .expect("the command ends with the engine's subcommand");
        let out = std::process::Command::new("/bin/sh")
            .arg("-c")
            .arg(format!("{prefix} /usr/bin/printenv XDG_CONFIG_HOME"))
            .env_clear()
            .env("PATH", "/usr/bin:/bin")
            .output()
            .expect("/bin/sh runs");
        assert!(out.status.success(), "{out:?}");
        assert_eq!(
            String::from_utf8_lossy(&out.stdout),
            format!("{config}\n"),
            "the shell must hand the program exactly the unit's config directory"
        );
    }
    // Byte for byte, the sentence the done screen shows verbatim for the same unit (Batch 2: the
    // webview builds no copy of it; `tests-web` pins its last clause, `UNIT_DIR_CLAUSE`).
    assert_eq!(
        unit_command_note(Path::new("/h/.config/systemd/user/daily-briefing.timer")).as_deref(),
        Some(
            "To remove this unit file from a terminal, run `XDG_CONFIG_HOME='/h/.config' \
             daily-briefing schedule uninstall`: `daily-briefing schedule uninstall` looks for it \
             only under `$XDG_CONFIG_HOME/systemd/user`, or `~/.config/systemd/user` when \
             XDG_CONFIG_HOME is unset."
        )
    );
}

/// The engine's own source, relative to this crate (the `UNINSTALL_SH` addressing).
const ENGINE_UNITS_TS: &str = "../../src/schedule/units.ts";
const ENGINE_INSTALL_TS: &str = "../../src/schedule/install.ts";

/// `export const <name> = "<value>";` from an engine source file — the T9 parse idiom.
fn engine_string_const(source: &str, name: &str) -> String {
    let marker = format!("export const {name} = \"");
    let at = source
        .find(&marker)
        .unwrap_or_else(|| panic!("the engine source no longer declares {name} as a string"));
    let rest = &source[at + marker.len()..];
    rest[..rest.find('"').expect("a closing quote")].to_string()
}

/// THE UNIT FILES ARE THE ENGINE'S (round 3, D3-L4). The names are PARSED from
/// `src/schedule/units.ts` and the directories held to `src/schedule/install.ts`'s `unitDir`, so
/// a renamed label or unit cannot leave the record-less-unit refusal looking for a file nobody
/// writes. `schedule_unit_files` is pure: both platforms' answers are pinned on either.
#[test]
fn the_unit_files_are_the_engines() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let units = std::fs::read_to_string(root.join(ENGINE_UNITS_TS)).expect("units.ts is readable");
    assert_eq!(
        LAUNCHD_UNIT,
        format!("{}.plist", engine_string_const(&units, "SCHEDULE_LABEL"))
    );
    assert_eq!(
        SYSTEMD_UNITS,
        [
            engine_string_const(&units, "SYSTEMD_SERVICE_NAME"),
            engine_string_const(&units, "SYSTEMD_TIMER_NAME"),
        ]
    );
    let install =
        std::fs::read_to_string(root.join(ENGINE_INSTALL_TS)).expect("install.ts is readable");
    for spelling in [
        r#"if (platform === "darwin") return join(home, "Library", "LaunchAgents");"#,
        r#"if (platform === "linux") return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user");"#,
    ] {
        assert!(
            install.contains(spelling),
            "install.ts's unitDir no longer reads {spelling:?} — schedule_unit_files mirrors it"
        );
    }

    let home = Path::new("/h");
    assert_eq!(
        schedule_unit_files("macos", home, None),
        [PathBuf::from(
            "/h/Library/LaunchAgents/local.daily-briefing.plist"
        )]
    );
    assert_eq!(
        schedule_unit_files("linux", home, None),
        [
            PathBuf::from("/h/.config/systemd/user/daily-briefing.service"),
            PathBuf::from("/h/.config/systemd/user/daily-briefing.timer"),
        ]
    );
    // `$XDG_CONFIG_HOME` is looked under AS WELL — the engine's own pick when set — never instead.
    assert_eq!(
        schedule_unit_files("linux", home, Some(Path::new("/x"))),
        [
            PathBuf::from("/x/systemd/user/daily-briefing.service"),
            PathBuf::from("/x/systemd/user/daily-briefing.timer"),
            PathBuf::from("/h/.config/systemd/user/daily-briefing.service"),
            PathBuf::from("/h/.config/systemd/user/daily-briefing.timer"),
        ]
    );
    assert_eq!(
        schedule_unit_files("linux", home, Some(Path::new("/h/.config"))).len(),
        2,
        "the default spelled out is not looked for twice"
    );
    assert_eq!(
        schedule_unit_files("linux", home, Some(Path::new(""))).len(),
        2,
        "an empty $XDG_CONFIG_HOME is no directory"
    );
    assert!(schedule_unit_files("windows", home, None).is_empty());
}

/// THE RECORD-LESS UNIT GUARD (round 3, D3-L4). An older install can leave the engine's unit with
/// no `schedule.json`, and that unit runs the very engine copy the consented leg deletes. So, with
/// no record, each of this platform's unit files — a regular file, or a dangling symlink (`lstat`)
/// — refuses the whole leg: the state dir is byte-for-byte what it was, the unit is untouched (a
/// presence check, never a scheduler call), and the refusal is `refused_for_unit`: the unit's path,
/// then `REFUSED_FOR_UNIT_RULE` with the command that removes it (round 4, B4-L6). The unit gone,
/// the bounded list goes.
#[test]
fn a_record_less_unit_file_refuses_the_whole_engine_leg() {
    let scratch = ScratchDir::new("uninstall-unit");
    let home = scratch.join("home");
    let units = schedule_unit_files(std::env::consts::OS, &home, None);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    assert!(!units.is_empty(), "premise: this platform has unit files");
    for unit in &units {
        for shape in ["file", "dangling-symlink"] {
            let state = scratch.join("state");
            write(&state.join("daily-briefing"), "#!/bin/sh\n");
            write(&state.join("briefing.log"), "log");
            write(&state.join("briefings").join("2026-09-01.md"), "archived");
            match shape {
                "file" => write(unit, "<plist/>"),
                _ => {
                    std::fs::create_dir_all(unit.parent().expect("a parent")).expect("unit dir");
                    #[cfg(unix)]
                    std::os::unix::fs::symlink(scratch.join("nowhere"), unit)
                        .expect("a dangling unit");
                    #[cfg(not(unix))]
                    write(unit, "<plist/>");
                }
            }
            let before = tree(&state);
            assert!(before.len() >= 4, "premise — the fixture planted the tree");

            let refused = remove_engine_state(&SystemFs, &state, &units);

            let expected = refused_for_unit(unit);
            assert_eq!(refused, Err(expected.clone()), "{unit:?} ({shape})");
            // The rule ends it — then, for a systemd unit, the exact command for the unit's own
            // directory (cap round, G5-2).
            let tail = unit_command_note(unit).map_or(REFUSED_FOR_UNIT_RULE.to_string(), |note| {
                format!("{REFUSED_FOR_UNIT_RULE} {note}")
            });
            assert!(
                expected.contains(&unit.display().to_string()) && expected.ends_with(&tail),
                "the refusal names the unit and the command that removes it: {expected}"
            );
            assert_eq!(
                tree(&state),
                before,
                "{unit:?} ({shape}): NOTHING may be removed"
            );
            assert!(
                std::fs::symlink_metadata(unit).is_ok(),
                "{unit:?}: the unit file is the scheduler's — never removed here"
            );

            std::fs::remove_file(unit).expect("remove the unit");
            let report = remove_engine_state(&SystemFs, &state, &units)
                .unwrap_or_else(|why| panic!("{unit:?} ({shape}): refused with no unit: {why}"));
            assert_eq!(outcome_of(&report, "daily-briefing"), &Outcome::Removed);
            assert_eq!(outcome_of(&report, "briefings"), &Outcome::Removed);
        }
    }
}

/// AN `lstat` THAT CANNOT ANSWER IS NOT "ABSENT" (round 4, A4-L3). `SystemFs::exists` was
/// `symlink_metadata(path).is_ok()`, so a unit file in a directory this user cannot search
/// (`EACCES`) read as absent — and the gate whose own docs say a file that cannot be told absent
/// refuses let the leg run. Now only "no such entry" (`NotFound`) and "a component is not a
/// directory" (`NotADirectory`) are absent. On the REAL filesystem: the unit's directory is made
/// non-searchable (mode 000; restored by a drop guard, so the scratch dir can be removed even when an
/// assertion fails), and the leg must refuse with the state dir untouched; a missing path and a path
/// through a regular file stay absent. ⚠ As root, or with `CAP_DAC_OVERRIDE`, mode 000 does not deny
/// `lstat` (cap round, G5-L2): when a probe shows `lstat` succeeding through it, the EACCES subcase's
/// premise cannot hold, so that subcase alone is SKIPPED, saying why; any other `lstat` failure still
/// fails the premise loudly, and the `NotFound` / `NotADirectory` cases always run.
#[cfg(unix)]
#[test]
fn a_path_lstat_cannot_answer_for_counts_as_present() {
    use std::os::unix::fs::PermissionsExt;
    /// Puts the unit's directory back to 0755 when dropped — on a panicking assertion too.
    struct RestoreMode(PathBuf);
    impl Drop for RestoreMode {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
        }
    }
    let scratch = ScratchDir::new("uninstall-eacces");
    let units = schedule_unit_files(std::env::consts::OS, &scratch.join("home"), None);
    let unit = units
        .first()
        .expect("premise: this platform has unit files")
        .clone();
    write(&unit, "<plist/>");
    let state = scratch.join("state");
    write(&state.join("briefing.log"), "log");
    let locked = unit.parent().expect("the unit's directory").to_path_buf();

    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o000))
        .expect("chmod 000 the unit's directory");
    let restore = RestoreMode(locked);
    let lstat = std::fs::symlink_metadata(&unit)
        .map(|_| ())
        .map_err(|e| e.kind());
    if lstat.is_ok() {
        drop(restore);
        eprintln!(
            "a_path_lstat_cannot_answer_for_counts_as_present: SKIPPED the EACCES subcase — lstat \
             succeeded through a mode-000 directory (root, or CAP_DAC_OVERRIDE), so its premise \
             cannot hold here; the NotFound and NotADirectory cases still run"
        );
    } else {
        let exists = SystemFs.exists(&unit);
        let refused = remove_engine_state(&SystemFs, &state, &units);
        let log_left = state.join("briefing.log").exists();
        drop(restore);

        assert_eq!(
            lstat,
            Err(std::io::ErrorKind::PermissionDenied),
            "premise: lstat under a mode-000 directory fails with EACCES"
        );
        assert!(exists, "an lstat that failed with EACCES read as absent");
        assert_eq!(
            refused,
            Err(refused_for_unit(&unit)),
            "a unit that cannot be ruled out must refuse the leg"
        );
        assert!(log_left, "the refused leg removed engine data");
    }

    assert!(!SystemFs.exists(&scratch.join("nothing-here")), "NotFound");
    assert!(
        !SystemFs.exists(&state.join("briefing.log").join("under-a-file")),
        "NotADirectory: nothing can be under a regular file"
    );
}

/// An empty state dir: every entry reports `absent`, nothing is created, nothing fails.
#[test]
fn a_consented_removal_of_nothing_reports_absent() {
    let scratch = ScratchDir::new("uninstall-empty");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");

    let report =
        remove_engine_state(&SystemFs, &state, &[]).expect("no schedule record: the leg runs");
    for line in &report {
        assert_eq!(line.outcome, Outcome::Absent, "{line:?}");
    }
    assert_eq!(report.len(), ENGINE_STATE_REMOVALS.len());
}

/// The app-file leg: the records and the candidate dir go from `data`, the window-state file
/// from `config`, and nothing else in either directory is touched — including a config dir that
/// doubles as something else's home (the macOS reality, where both resolve to the same
/// `Application Support` folder).
#[test]
fn the_app_leg_removes_the_enumerated_files_and_leaves_the_rest() {
    let scratch = ScratchDir::new("uninstall-app");
    let data = scratch.join("app-data");
    let config = scratch.join("app-config");

    for name in APP_DATA_FILES {
        write(&data.join(name), name);
    }
    write(
        &data.join(APP_DATA_DIRS[0]).join("candidate-1-1.json"),
        "{}",
    );
    for name in APP_CONFIG_FILES {
        write(&config.join(name), name);
    }
    write(&data.join("unrelated.json"), "not ours to remove");
    write(&config.join("unrelated.json"), "not ours to remove");

    let report = remove_app_files(&SystemFs, &data, &config);

    for name in APP_DATA_FILES.iter().chain(APP_CONFIG_FILES) {
        assert_eq!(outcome_of(&report, name), &Outcome::Removed, "{name}");
    }
    assert_eq!(outcome_of(&report, APP_DATA_DIRS[0]), &Outcome::Removed);
    assert!(!data.join(APP_DATA_DIRS[0]).exists());
    assert!(
        data.join("unrelated.json").exists(),
        "the data dir is not swept"
    );
    assert!(
        config.join("unrelated.json").exists(),
        "the config dir is not swept"
    );
    assert!(
        data.exists() && config.exists(),
        "the directories themselves survive"
    );
}

/// A file that cannot be removed is a per-entry `failed`, and the other entries still proceed —
/// one unremovable file must not hide what WAS removed.
#[cfg(unix)]
#[test]
fn a_refused_removal_is_reported_and_does_not_stop_the_rest() {
    use std::os::unix::fs::PermissionsExt;
    let scratch = ScratchDir::new("uninstall-refused");
    let state = scratch.join("state");
    // `briefings` holds a file inside a directory whose write bit is off, so unlinking the child
    // fails — remove_dir_all cannot clear it.
    write(&state.join("briefings").join("2026-09-01.md"), "archived");
    let locked = state.join("briefings");
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o555))
        .expect("lock the dir");
    write(&state.join("briefing.log"), "log");

    let report =
        remove_engine_state(&SystemFs, &state, &[]).expect("no schedule record: the leg runs");

    // Restore the write bit FIRST so the scratch's Drop can clean up whatever the assertions say.
    std::fs::set_permissions(&locked, std::fs::Permissions::from_mode(0o755))
        .expect("unlock the dir");

    assert!(
        matches!(outcome_of(&report, "briefings"), Outcome::Failed { .. }),
        "{report:?}"
    );
    assert_eq!(
        outcome_of(&report, "briefing.log"),
        &Outcome::Removed,
        "{report:?}"
    );
}

/* ── the commands, over a mock app ────────────────────────────────────────────────────────────── */

/// The removal steps the fixture's `schedule status --json` reports by default — any text, so a
/// test can tell the engine's steps from Rust's `null`.
const FAKE_REMOVE_STEPS: &str =
    "Run these in a terminal (bash or zsh) inside your desktop session.\n(the fake engine's steps)";

/// The engine's genuine "nothing to remove" line (`src/schedule/install.ts`, `uninstallSchedule`):
/// exit 1 WITH it on stdout is the only exit 1 Rust reads as `absent` (spec 3.3.4.3).
const NOTHING_INSTALLED: &str = "Nothing installed by daily-briefing was found.";

/// The fixture's `schedule status --json` view: "nothing installed" — `registered: false`, and
/// `recordPresent`, `recordFilePresent` and `unitPresent` false — with `facts` laid over it.
fn schedule_view(facts: serde_json::Value) -> serde_json::Value {
    let mut view = json!({
        "registered": false,
        "registeredReason": null,
        "recordPresent": false,
        "recordFilePresent": false,
        "unitPresent": false,
        "owner": null,
        "invoker": null,
        "removeSteps": FAKE_REMOVE_STEPS,
    });
    for (key, value) in facts.as_object().expect("facts are an object") {
        view[key] = value.clone();
    }
    view
}

/// The uninstall fixture's fake engine (spec 3.7, "Rust: Fixtures") — a script under the test's
/// own `ScratchDir`, driven through `EngineClient::with_program`, NEVER the bundled sidecar: this
/// command now runs `schedule uninstall`, which against the real engine would unregister the
/// developer's live job by uid, and `EngineClient` clears its environment, so the engine-side
/// `DBA_TEST_UNIT_DIR` refusal is no backstop here (§1.1, "The Rust walk").
///
/// * **Every call is LOGGED**, its argv space-joined, one line per call ([`engine_calls`]), so
///   "the engine was not asked to remove anything" is an assertion, not an inference.
/// * **Every answer can be scripted** ([`script_answer`]): before its default, a call sources
///   `answer-<arg1>-<arg2>.sh` from `dir` when that file is there. A fragment that ends in `exit`
///   replaces the default; one that does not runs first and falls through to it.
/// * **The defaults:** `status --json` names `state_dir`, and a `configPath` in a `settings` folder
///   of its OWN under `dir` (never `{state}/config.json`, so a settings leg has a separate folder);
///   `schedule status --json` is [`schedule_view`]'s "nothing installed"; and `schedule uninstall`
///   exits 1 with [`NOTHING_INSTALLED`] on stdout — the engine's genuine "nothing to remove", so a
///   test with nothing on disk reads outcome `absent`. Every path it reports is under `dir`.
fn status_sidecar(dir: &Path, state_dir: &Path) -> PathBuf {
    let status = json!({
        "paths": {
            "stateDir": state_dir.display().to_string(),
            "configPath": dir.join("settings").join("config.json").display().to_string(),
        }
    });
    let body = format!(
        r#"dir={dir}
printf '%s\n' "$*" >> "$dir/engine-calls.log"
script="$dir/answer-$1-$2.sh"
[ -f "$script" ] && . "$script"
case "$1:$2" in
  status:--json) printf '%s' {status} ;;
  schedule:status) printf '%s' {view} ;;
  schedule:uninstall) printf '%s\n' {nothing}; exit 1 ;;
esac
exit 0"#,
        dir = sq(&dir.display().to_string()),
        status = sq(&status.to_string()),
        view = sq(&schedule_view(json!({})).to_string()),
        nothing = sq(NOTHING_INSTALLED),
    );
    fake_sidecar(dir, "engine.sh", &body)
}

/// Script [`status_sidecar`]'s answer to `call` (`"status --json"`, `"schedule status"`,
/// `"schedule uninstall"` — its first two words): `fragment` is sourced before the default, with
/// `$dir` (the fake's directory) and `$script` (this fragment's own file) set.
fn script_answer(dir: &Path, call: &str, fragment: &str) {
    let mut words = call.split(' ');
    let (first, second) = (
        words.next().expect("a verb"),
        words.next().expect("a second word"),
    );
    write(&dir.join(format!("answer-{first}-{second}.sh")), fragment);
}

/// A scripted `schedule status --json` answer: [`schedule_view`] over `facts`, exit 0.
fn view_answer(facts: serde_json::Value) -> String {
    format!(
        "printf '%s' {}\nexit 0\n",
        sq(&schedule_view(facts).to_string())
    )
}

/// A scripted answer: `stdout` and `stderr` (each printed only when non-empty), then `exit code`.
fn exit_answer(code: i32, stdout: &str, stderr: &str) -> String {
    let mut fragment = String::new();
    if !stdout.is_empty() {
        fragment.push_str(&format!("printf '%s\\n' {}\n", sq(stdout)));
    }
    if !stderr.is_empty() {
        fragment.push_str(&format!("printf '%s\\n' {} >&2\n", sq(stderr)));
    }
    fragment.push_str(&format!("exit {code}\n"));
    fragment
}

/// A fragment that touches `<dir>/<flag>`, then waits — up to 20 s, so a failed test cannot leave
/// it running — for `<dir>/release`, and falls through to the default answer. `once` removes the
/// fragment first, so only the first such call waits.
fn hold_answer(flag: &str, once: bool) -> String {
    format!(
        r#"{remove}: > "$dir/{flag}"
i=0
while [ ! -f "$dir/release" ] && [ "$i" -lt 400 ]; do sleep 0.05; i=$((i+1)); done
"#,
        remove = if once { "rm -f \"$script\"\n" } else { "" },
    )
}

/// Every call the fake engine in `dir` received, in order, its argv space-joined.
fn engine_calls(dir: &Path) -> Vec<String> {
    std::fs::read_to_string(dir.join("engine-calls.log"))
        .map(|log| log.lines().map(str::to_string).collect())
        .unwrap_or_default()
}

/// The argv `uninstall_execute`'s scheduler step sends (`Operation::ScheduleUninstall`, invoker
/// fixed to `app`), space-joined as [`engine_calls`] logs it.
const REMOVE_OWN_CALL: &str = "schedule uninstall --invoker app";
const REMOVE_ANY_CALL: &str = "schedule uninstall --invoker app --take-over";

/// How many times the fake engine in `dir` was asked to remove the scheduler.
fn removals(dir: &Path) -> usize {
    engine_calls(dir)
        .iter()
        .filter(|call| call.starts_with("schedule uninstall"))
        .count()
}

/// Whether the fake engine in `dir` was asked to remove the scheduler at all.
fn removal_called(dir: &Path) -> bool {
    removals(dir) > 0
}

/// Wait, up to 10 s, for `path` to exist.
async fn wait_for(path: &Path) {
    for _ in 0..500 {
        if path.exists() {
            return;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    panic!("{} never appeared", path.display());
}

struct Fixture {
    app: App<MockRuntime>,
    autostart: Arc<RecordingAutostartSink>,
    _scratch: ScratchDir,
}

/// The uninstall state every fixture starts from: the real `SystemFs` over the scratch app
/// directories, and a scratch HOME for the scheduler unit files. A test chains its own `with_fs` or
/// `with_xdg_config_home` onto it.
fn scratch_uninstall_state(scratch: &ScratchDir) -> UninstallState {
    UninstallState::default()
        .with_app_data_dir(scratch.join("app-data"))
        .with_app_config_dir(scratch.join("app-config"))
        .with_home_dir(scratch.join("home"))
}

/// ONE `generate_context!` call site for the whole binary — a second one collides on the macOS
/// `_EMBED_INFO_PLIST` static (the exact linker story `src/commands.rs`'s module doc records).
///
/// ⚠ THE `ConfigSaver` IS A SCRATCH ONE, and it has to be managed at all: `uninstall_execute`
/// takes the save lock (spec 3.3.4.2), and `ConfigSaver::default()` resolves the developer's REAL
/// `app_data_dir()` on `MockRuntime` (the ConfigSaver/AccessState trap).
fn app_managing(
    engine: Engine,
    scratch: &ScratchDir,
    autostart: Arc<RecordingAutostartSink>,
    uninstall_state: UninstallState,
) -> App<MockRuntime> {
    mock_builder()
        .manage(engine)
        .manage(AutostartState::default().with_sink(autostart))
        .manage(uninstall_state)
        .manage(ConfigSaver::with_candidate_dir(
            scratch.join("config-candidates"),
        ))
        .build(tauri::generate_context!())
        .expect("mock app")
}

/// The usual app: `program` (a fake under `scratch`) as the engine. `fs`: `None` = the real
/// `SystemFs` over the scratch dirs; `Some` = an injected sink (the all-failures fixture below).
fn app_with(
    program: PathBuf,
    scratch: &ScratchDir,
    autostart: Arc<RecordingAutostartSink>,
    fs: Option<Arc<dyn UninstallFs>>,
) -> App<MockRuntime> {
    let mut uninstall_state = scratch_uninstall_state(scratch);
    if let Some(fs) = fs {
        uninstall_state = uninstall_state.with_fs(fs);
    }
    app_managing(
        Engine(Ok(EngineClient::with_program(program))),
        scratch,
        autostart,
        uninstall_state,
    )
}

/// One `uninstall_execute`, its arguments as the webview sends them; `removeSettings` is left out,
/// so it defaults to false and the settings leg does not run ([`execute_with`] sends it).
async fn execute(
    app: &App<MockRuntime>,
    remove_engine_state: bool,
    schedule: Option<SchedulerChoice>,
) -> Result<UninstallReport, UninstallError> {
    execute_with(app, remove_engine_state, None, schedule).await
}

/// [`execute`] with `removeSettings` too (Batch 2, spec 3.3.2).
async fn execute_with(
    app: &App<MockRuntime>,
    remove_engine_state: bool,
    remove_settings: Option<bool>,
    schedule: Option<SchedulerChoice>,
) -> Result<UninstallReport, UninstallError> {
    uninstall_execute(
        app.handle().clone(),
        app.state(),
        app.state(),
        app.state(),
        remove_engine_state,
        remove_settings,
        schedule,
    )
    .await
}

fn fixture(scratch: ScratchDir, autostart: Arc<RecordingAutostartSink>) -> Fixture {
    let state_dir = scratch.join("state");
    std::fs::create_dir_all(&state_dir).expect("state dir");
    let program = status_sidecar(&scratch.path, &state_dir);
    let app = app_with(program, &scratch, autostart.clone(), None);
    Fixture {
        app,
        autostart,
        _scratch: scratch,
    }
}

/// Round-1 fix F4's fixture: a filesystem where every removal is refused (EPERM-shaped) and the
/// glob leg finds a match to fail on — so a consented run produces an engine report whose lines
/// are ALL `Failed`. Everything reads as present EXCEPT the schedule record and the scheduler unit
/// files: either refuses the whole leg before any removal is attempted (rounds 2 and 3), and this
/// fixture is about attempts.
struct RefusingFs;

impl UninstallFs for RefusingFs {
    fn exists(&self, path: &Path) -> bool {
        path.file_name().is_none_or(|name| {
            name != SCHEDULE_RECORD
                && name != LAUNCHD_UNIT
                && !SYSTEMD_UNITS.contains(&&*name.to_string_lossy())
        })
    }
    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("refused: {}", path.display()),
        ))
    }
    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("refused: {}", path.display()),
        ))
    }
    fn list_dir(&self, _dir: &Path) -> std::io::Result<Vec<String>> {
        Ok(vec!["audit-2026-09-01.md".into()])
    }
    // Batch 2 (spec 3.5.4): the reads are the real filesystem's (a scratch home and state dir, so a
    // Linux engine copy is simply absent); the one new removal is refused like the others.
    fn kind(&self, path: &Path) -> std::io::Result<Lstat> {
        SystemFs.kind(path)
    }
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf> {
        SystemFs.canonicalize(path)
    }
    fn read_small(&self, path: &Path, max_bytes: u64) -> Result<String, ReadRefusal> {
        SystemFs.read_small(path, max_bytes)
    }
    fn remove_empty_dir(&self, path: &Path) -> std::io::Result<()> {
        Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!("refused: {}", path.display()),
        ))
    }
}

/// The consent gate, end to end over the command: `false` leaves every planted engine file in
/// place while the app files go; `true` removes the bounded list. The same run also pins the
/// autostart reuse: an enabled login item is disabled exactly once, through T19's sink. Batch 2: the
/// call sends no `schedule`, so it means `removeOwn`; nothing is installed, so the scheduler step
/// asks the engine (no take-over), whose genuine exit 1 reads `absent` — consented or not.
#[tokio::test(flavor = "multi_thread")]
async fn the_consent_flag_gates_the_engine_leg() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("uninstall-consent");
    let state = scratch.join("state");
    write(&state.join("briefing.log"), "log");
    write(&state.join("briefing-latest.md"), "latest");
    write(&state.join("briefings").join("2026-09-01.md"), "archived");
    write(&state.join("last-run"), "2026-09-17");
    write(&state.join("somebody-elses-notes.txt"), "not the engine's");
    write(&scratch.join("app-data").join(APP_DATA_FILES[0]), "{}");
    let f = fixture(
        scratch,
        Arc::new(RecordingAutostartSink::reporting_enabled(true)),
    );

    // Without consent: the engine's files all survive; the app record went; autostart disabled.
    let report = execute(&f.app, false, None)
        .await
        .expect("uninstall_execute answers");
    assert_eq!(
        report.schedule.outcome,
        SchedulerOutcome::Absent,
        "{report:?}"
    );
    assert_eq!(
        engine_calls(&f._scratch.path),
        ["status --json", "schedule status --json", REMOVE_OWN_CALL],
        "the two reads, then the removal — no take-over without a choice"
    );
    assert!(!report.engine_state_removed);
    assert!(report.engine.is_empty(), "{report:?}");
    assert_eq!(report.engine_error, None, "{report:?}");
    assert_eq!(
        report.engine_refused, None,
        "no consent, nothing to refuse: {report:?}"
    );
    assert_eq!(
        report.engine_state_dir, None,
        "no consent, no target dir to report: {report:?}"
    );
    let state = f._scratch.join("state");
    for name in [
        "briefing.log",
        "briefing-latest.md",
        "last-run",
        "somebody-elses-notes.txt",
    ] {
        assert!(
            state.join(name).exists(),
            "{name} must survive an unconsented uninstall"
        );
    }
    assert!(state.join("briefings").exists());
    assert!(!f._scratch.join("app-data").join(APP_DATA_FILES[0]).exists());
    assert_eq!(report.autostart, Outcome::Removed, "{report:?}");
    assert_eq!(
        f.autostart.disables(),
        1,
        "T19's disable, reused — exactly once"
    );
    assert_eq!(f.autostart.enables(), 0);

    // With consent: the bounded list goes — the day marker with it since Batch 2 (spec 3.5.1) — and
    // a file outside the list still survives.
    let report = execute(&f.app, true, None)
        .await
        .expect("uninstall_execute answers");
    assert_eq!(
        report.schedule.outcome,
        SchedulerOutcome::Absent,
        "{report:?}"
    );
    assert!(report.engine_state_removed, "{report:?}");
    assert_eq!(report.engine.len(), ENGINE_STATE_REMOVALS.len());
    assert_eq!(
        report.engine_refused, None,
        "no schedule record, no refusal: {report:?}"
    );
    // Round-1 fix M3: the report names the directory the consented leg targeted — the fixture
    // sidecar's `status --json` answer, the same resolution the preview rendered consent from.
    assert_eq!(
        report.engine_state_dir.as_deref(),
        state.to_str(),
        "{report:?}"
    );
    assert!(!state.join("briefing.log").exists());
    assert!(!state.join("briefings").exists());
    assert!(!state.join("last-run").exists(), "on the bounded list");
    assert!(
        state.join("somebody-elses-notes.txt").exists(),
        "outside the bounded list"
    );
    // The second run found the login item already disabled (the recorder flipped its state).
    assert_eq!(report.autostart, Outcome::Absent, "{report:?}");
    assert_eq!(
        f.autostart.disables(),
        1,
        "no second disable for an absent entry"
    );
}

/// Phase E M5b checkpoint: leg 1's `disable()` runs under the login-item change lock — the one the
/// toggle's ON holds across its branding `rename`, which would otherwise re-create the plist this
/// leg just removed. Asked from INSIDE the recording sink's `disable()`; released afterwards.
#[tokio::test(flavor = "multi_thread")]
async fn the_autostart_leg_disables_under_the_change_lock() {
    let _turn = serialise().await;
    let f = fixture(
        ScratchDir::new("uninstall-lock"),
        Arc::new(RecordingAutostartSink::reporting_enabled(true)),
    );
    f.autostart.observe_lock_of(f.app.handle().clone());
    let report = execute(&f.app, false, None)
        .await
        .expect("uninstall_execute answers");
    assert_eq!(
        report.schedule.outcome,
        SchedulerOutcome::Absent,
        "{report:?}"
    );
    assert_eq!(report.autostart, Outcome::Removed, "{report:?}");
    assert_eq!(
        f.autostart.locked_during(),
        [("disable", true)],
        "the uninstall's disable ran WITHOUT the login-item change lock"
    );
    assert!(
        !f.app.state::<AutostartState>().changes_locked(),
        "the change lock is still held after the uninstall returned"
    );
}

/// The preview is read-only: it names what is present and removes nothing.
#[tokio::test(flavor = "multi_thread")]
async fn the_preview_reports_presence_and_removes_nothing() {
    let scratch = ScratchDir::new("uninstall-preview");
    let state = scratch.join("state");
    write(&state.join("briefing.log"), "log");
    write(&state.join("audit-2026-09-01.md"), "report");
    write(&scratch.join("app-data").join(APP_DATA_FILES[1]), "{}");
    let f = fixture(
        scratch,
        Arc::new(RecordingAutostartSink::reporting_enabled(true)),
    );

    let preview = uninstall_preview(f.app.handle().clone(), f.app.state(), f.app.state())
        .await
        .expect("uninstall_preview answers");

    assert_eq!(preview.autostart_enabled, Some(true));
    assert_eq!(preview.autostart_error, None);
    assert!(preview.engine_state_dir.is_some(), "{preview:?}");
    let engine_present: Vec<(&str, bool)> = preview
        .engine_entries
        .iter()
        .map(|e| (e.name.as_str(), e.present))
        .collect();
    assert!(
        engine_present.contains(&("briefing.log", true)),
        "{engine_present:?}"
    );
    assert!(
        engine_present.contains(&("audit-*.md", true)),
        "the glob probes matches"
    );
    assert!(
        engine_present.contains(&("briefings", false)),
        "{engine_present:?}"
    );
    let app_present: Vec<(&str, bool)> = preview
        .app_entries
        .iter()
        .map(|e| (e.name.as_str(), e.present))
        .collect();
    assert!(
        app_present.contains(&(APP_DATA_FILES[1], true)),
        "{app_present:?}"
    );
    assert!(
        app_present.contains(&(APP_DATA_FILES[0], false)),
        "{app_present:?}"
    );

    // Read-only: everything planted is still there, and nothing was disabled.
    let state = f._scratch.join("state");
    assert!(state.join("briefing.log").exists());
    assert!(state.join("audit-2026-09-01.md").exists());
    assert!(f._scratch.join("app-data").join(APP_DATA_FILES[1]).exists());
    assert_eq!(f.autostart.disables(), 0);
}

/// A fake for the preview's TWO reads, each scripted on its own: `status --json` prints
/// `status_json`, and `schedule status --json` runs `schedule_arm`, a shell fragment. Built on
/// [`fake_sidecar`] (`status_sidecar` answers `status --json` only), so it is never the real
/// engine; every path its `status_json` names is the caller's, under its `ScratchDir`.
fn preview_sidecar(dir: &Path, name: &str, status_json: &str, schedule_arm: &str) -> PathBuf {
    let body = format!(
        "case \"$1:$2\" in\n  status:--json) printf '%s' {} ;;\n  schedule:status) {schedule_arm} ;;\nesac\nexit 0",
        sq(status_json),
    );
    fake_sidecar(dir, name, &body)
}

/// One `uninstall_preview` over a mock app driving `program`, against `scratch`'s dirs.
async fn preview_with(program: PathBuf, scratch: &ScratchDir) -> UninstallPreview {
    let app = app_with(
        program,
        scratch,
        Arc::new(RecordingAutostartSink::reporting_enabled(false)),
        None,
    );
    uninstall_preview(app.handle().clone(), app.state(), app.state())
        .await
        .expect("uninstall_preview answers")
}

/// Batch 2, spec 3.3.1: the preview's SECOND read, `schedule status --json`, and the seven fields
/// it feeds. The cases the spec separates, each with its own scripted fake:
///   * a read that fails, or prints an envelope this app cannot read, is
///     `scheduleStatusUnreadable: true`, with every schedule fact unknown;
///   * an ALL-DEFAULT read is NOT unreadable — "the check ran and found nothing" and "the check
///     could not be read" are different facts, and only the second may block a removal;
///   * `settingsFolder` is `configPath`'s parent, and `null` when `configPath` is unknown (missing,
///     or relative — the engine's paths are never resolved against this app's working directory).
///
/// A full read reaches the preview verbatim, under the camelCase keys `app-uninstall.ts` mirrors.
#[tokio::test(flavor = "multi_thread")]
async fn the_preview_reads_the_scheduler_status_and_says_when_it_could_not() {
    let scratch = ScratchDir::new("uninstall-preview-schedule");
    let state = scratch.join("state");
    let settings = scratch.join("settings");
    std::fs::create_dir_all(&state).expect("state dir");
    let status_json = format!(
        r#"{{"paths":{{"stateDir":"{}","configPath":"{}"}}}}"#,
        state.display(),
        settings.join("config.json").display()
    );
    let steps = "Run these in a terminal (bash or zsh) inside your desktop session.";

    // ── unreadable: the read exits non-zero.
    let failed = preview_with(
        preview_sidecar(
            &scratch.path,
            "failed.sh",
            &status_json,
            "printf '%s\\n' 'the user manager did not answer' >&2; exit 2",
        ),
        &scratch,
    )
    .await;
    assert!(failed.schedule_status_unreadable, "{failed:?}");
    assert_eq!(failed.schedule_owner, None, "{failed:?}");
    assert_eq!(failed.schedule_registered, None, "{failed:?}");
    assert_eq!(failed.schedule_registered_reason, None, "{failed:?}");
    assert_eq!(failed.schedule_remove_steps, None, "{failed:?}");
    assert!(!failed.schedule_record_file_present, "{failed:?}");
    // The FIRST read still answered: its state dir and settings folder are known.
    assert_eq!(
        failed.engine_state_dir.as_deref(),
        state.to_str(),
        "{failed:?}"
    );
    assert_eq!(
        failed.settings_folder.as_deref(),
        settings.to_str(),
        "{failed:?}"
    );

    // ── unreadable: exit 0, but an envelope that does not parse as the schedule view.
    let garbled = preview_with(
        preview_sidecar(
            &scratch.path,
            "garbled.sh",
            &status_json,
            &format!("printf '%s' {}", sq(r#"{"registered":"yes"}"#)),
        ),
        &scratch,
    )
    .await;
    assert!(garbled.schedule_status_unreadable, "{garbled:?}");
    assert_eq!(garbled.schedule_registered, None, "{garbled:?}");

    // ── an all-default read: readable, and nothing reported.
    let empty = preview_with(
        preview_sidecar(&scratch.path, "empty.sh", &status_json, "printf '%s' '{}'"),
        &scratch,
    )
    .await;
    assert!(
        !empty.schedule_status_unreadable,
        "an all-default read is not an unreadable one: {empty:?}"
    );
    assert_eq!(empty.schedule_owner, None);
    assert_eq!(empty.schedule_registered, None);
    assert!(!empty.schedule_record_file_present);

    // ── a full read, carried verbatim.
    let full = preview_with(
        preview_sidecar(
            &scratch.path,
            "full.sh",
            &status_json,
            &format!(
                "printf '%s' {}",
                sq(&format!(
                    r#"{{"registered":null,"registeredReason":"no-user-manager","recordPresent":true,"recordFilePresent":true,"unitPresent":true,"owner":"cli","removeSteps":"{steps}"}}"#
                ))
            ),
        ),
        &scratch,
    )
    .await;
    assert!(!full.schedule_status_unreadable, "{full:?}");
    assert_eq!(full.schedule_owner.as_deref(), Some("cli"));
    assert_eq!(full.schedule_registered, None);
    assert_eq!(
        full.schedule_registered_reason.as_deref(),
        Some("no-user-manager")
    );
    assert_eq!(full.schedule_remove_steps.as_deref(), Some(steps));
    assert!(full.schedule_record_file_present);
    let wire = serde_json::to_value(&full).expect("an UninstallPreview serialises");
    assert_eq!(wire["scheduleOwner"], "cli", "{wire}");
    assert_eq!(
        wire["scheduleRegistered"],
        serde_json::Value::Null,
        "{wire}"
    );
    assert_eq!(
        wire["scheduleRegisteredReason"],
        "no-user-manager",
        "{wire}"
    );
    assert_eq!(wire["scheduleRemoveSteps"], steps, "{wire}");
    assert_eq!(wire["scheduleStatusUnreadable"], false, "{wire}");
    assert_eq!(wire["scheduleRecordFilePresent"], true, "{wire}");
    assert_eq!(wire["settingsFolder"], settings.to_str().unwrap(), "{wire}");

    // ── configPath unknown: missing, then relative. The state dir is unaffected.
    for (name, status_json) in [
        (
            "no-config.sh",
            format!(r#"{{"paths":{{"stateDir":"{}"}}}}"#, state.display()),
        ),
        (
            "relative-config.sh",
            format!(
                r#"{{"paths":{{"stateDir":"{}","configPath":"relative/config.json"}}}}"#,
                state.display()
            ),
        ),
    ] {
        let unknown = preview_with(
            preview_sidecar(&scratch.path, name, &status_json, "printf '%s' '{}'"),
            &scratch,
        )
        .await;
        assert_eq!(unknown.settings_folder, None, "{name}: {unknown:?}");
        assert_eq!(
            serde_json::to_value(&unknown).expect("serialises")["settingsFolder"],
            serde_json::Value::Null
        );
        assert_eq!(
            unknown.engine_state_dir.as_deref(),
            state.to_str(),
            "{name}: {unknown:?}"
        );
    }
}

/// Spec 3.3.7: `UninstallError`'s three new variants on the wire, tagged by `kind` exactly as the
/// existing `store` is — the shapes `app-uninstall.ts`'s `UninstallError` union mirrors.
#[test]
fn the_uninstall_errors_are_tagged_by_kind() {
    for (error, expected) in [
        (
            UninstallError::Store { detail: "d".into() },
            serde_json::json!({ "kind": "store", "detail": "d" }),
        ),
        (
            UninstallError::ScheduleForeign {
                message: "m".into(),
            },
            serde_json::json!({ "kind": "scheduleForeign", "message": "m" }),
        ),
        (
            UninstallError::ScheduleFailed {
                message: "m".into(),
            },
            serde_json::json!({ "kind": "scheduleFailed", "message": "m" }),
        ),
        (
            UninstallError::Busy {
                message: "m".into(),
            },
            serde_json::json!({ "kind": "busy", "message": "m" }),
        ),
    ] {
        assert_eq!(serde_json::to_value(&error).expect("serialises"), expected);
    }
}

/// The schedule-record gate over the commands (Phase E final harden, round 2 — A-M1): the PREVIEW
/// says a record is there before consent is given (`scheduleRecordPresent`, which the consent
/// wording reads), and a consented EXECUTE removes NOTHING of the engine's — every planted file
/// and the archive survive byte-for-byte — reports the ONE refusal (`engineRefused`) and the
/// directory it examined, and still runs the OTHER legs: the login item is disabled and the app's
/// own record removed, exactly as without a schedule.
///
/// Batch 2 (spec 3.3.3, 3.7 "the gate look"): Rust takes the owner ONLY from the status read, so
/// the engine reports this app's record; the call sends no `schedule` (`removeOwn`), so the engine
/// is asked to remove it — and here it exits 0 yet the record is STILL there. The gate look after
/// the step sees it, so the leg is refused all the same, the outcome is `removed` (the engine's
/// answer), and `leftover` names the record the gate still saw.
#[tokio::test(flavor = "multi_thread")]
async fn a_consented_uninstall_under_a_schedule_record_refuses_the_engine_leg_only() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("uninstall-record-cmd");
    let state = scratch.join("state");
    write(&state.join("daily-briefing"), "#!/bin/sh\n");
    write(&state.join("briefing.log"), "log");
    write(&state.join("briefings").join("2026-09-01.md"), "archived");
    write(&scratch.join("app-data").join(APP_DATA_FILES[0]), "{}");
    let f = fixture(
        scratch,
        Arc::new(RecordingAutostartSink::reporting_enabled(true)),
    );
    let state = f._scratch.join("state");

    let preview = uninstall_preview(f.app.handle().clone(), f.app.state(), f.app.state())
        .await
        .expect("uninstall_preview answers");
    assert!(
        !preview.schedule_record_present,
        "no record yet: {preview:?}"
    );
    write(
        &state.join(SCHEDULE_RECORD),
        r#"{"owner":"app","invoker":"app"}"#,
    );
    let preview = uninstall_preview(f.app.handle().clone(), f.app.state(), f.app.state())
        .await
        .expect("uninstall_preview answers");
    assert!(
        preview.schedule_record_present,
        "the preview must report the record before consent is asked for: {preview:?}"
    );
    let before = tree(&state);
    // This app's own record, as the engine reports it; its removal answers 0 and leaves the file.
    script_answer(
        &f._scratch.path,
        "schedule status",
        &view_answer(json!({
            "registered": true,
            "recordPresent": true,
            "recordFilePresent": true,
            "owner": "app",
            "invoker": "app",
        })),
    );
    script_answer(
        &f._scratch.path,
        "schedule uninstall",
        &exit_answer(0, "Removed the background scheduler.", ""),
    );

    let report = execute(&f.app, true, None)
        .await
        .expect("uninstall_execute answers");

    assert_eq!(
        engine_calls(&f._scratch.path).last().map(String::as_str),
        Some(REMOVE_OWN_CALL),
        "this app's own scheduler is removed without take-over"
    );
    assert_eq!(
        report.schedule.outcome,
        SchedulerOutcome::Removed,
        "{report:?}"
    );
    assert_eq!(
        report.schedule.leftover,
        [state.join(SCHEDULE_RECORD).display().to_string()],
        "the gate look still saw the record: {report:?}"
    );
    assert_eq!(
        report.schedule.remove_steps.as_deref(),
        Some(FAKE_REMOVE_STEPS)
    );
    assert_eq!(
        report.engine_refused.as_deref(),
        Some(REFUSED_FOR_SCHEDULE),
        "{report:?}"
    );
    assert!(
        report.engine.is_empty(),
        "a refused leg attempts no entry: {report:?}"
    );
    assert!(!report.engine_state_removed, "{report:?}");
    assert_eq!(report.engine_error, None, "{report:?}");
    assert_eq!(
        report.engine_state_dir.as_deref(),
        state.to_str(),
        "the refusal names the directory whose record refused it: {report:?}"
    );
    assert_eq!(
        tree(&state),
        before,
        "the refused engine leg changed the state dir — it must remove NOTHING"
    );
    // The other legs ran as before.
    assert_eq!(report.autostart, Outcome::Removed, "{report:?}");
    assert_eq!(f.autostart.disables(), 1);
    assert_eq!(
        outcome_of(&report.app, APP_DATA_FILES[0]),
        &Outcome::Removed
    );
    assert!(!f._scratch.join("app-data").join(APP_DATA_FILES[0]).exists());

    // The wire shape the webview's `UninstallReport` mirrors (`gui/src/lib/app-uninstall.ts`).
    let wire = serde_json::to_value(&report).expect("JSON");
    assert_eq!(
        wire["schedule"],
        json!({
            "outcome": "removed",
            "leftover": [state.join(SCHEDULE_RECORD).display().to_string()],
            "leftoverCommands": [],
            "removeSteps": FAKE_REMOVE_STEPS,
        }),
        "{wire}"
    );
    assert_eq!(wire["engineRefused"], REFUSED_FOR_SCHEDULE, "{wire}");
    assert_eq!(wire["engine"], serde_json::json!([]), "{wire}");
    assert_eq!(wire["engineStateRemoved"], false, "{wire}");
    assert_eq!(wire["scheduleRecordPresent"], true, "{wire}");
    assert_eq!(wire["scheduleUnitFile"], serde_json::Value::Null, "{wire}");
    assert_eq!(wire["os"], std::env::consts::OS, "{wire}");
    let wire = serde_json::to_value(&preview).expect("JSON");
    assert_eq!(wire["scheduleRecordPresent"], true, "{wire}");
    assert_eq!(wire["scheduleUnitFile"], serde_json::Value::Null, "{wire}");
    assert_eq!(wire["os"], std::env::consts::OS, "{wire}");
}

/// An engine that cannot answer `status --json` fails ONLY the engine leg — consented or not,
/// the app files still go, and the report says why the engine leg could not run.
///
/// Batch 2: every engine call exits 2, so the scheduler's status is unreadable too, and the default
/// `removeOwn` would refuse the whole run (`ScheduleFailed`, spec 3.3.4.3). The call therefore says
/// `keep`: nothing is detected — no state folder to look in, no unit under the scratch home — so
/// nothing is refused (spec 3.3.5.1), the outcome is `notChecked`, the engine is never asked to
/// remove anything, and the point stands that only the engine leg fails.
#[tokio::test(flavor = "multi_thread")]
async fn an_unanswerable_engine_fails_only_its_own_leg() {
    let scratch = ScratchDir::new("uninstall-noengine");
    // A sidecar that prints nothing and exits 2: `status --json` yields no envelope.
    let program = fake_sidecar(&scratch.path, "engine.sh", "exit 2");
    write(&scratch.join("app-data").join(APP_DATA_FILES[0]), "{}");
    let autostart = Arc::new(RecordingAutostartSink::default());
    let app = app_with(program, &scratch, autostart.clone(), None);

    let report = execute(&app, true, Some(SchedulerChoice::Keep))
        .await
        .expect("uninstall_execute answers");
    assert_eq!(
        report.schedule.outcome,
        SchedulerOutcome::NotChecked,
        "{report:?}"
    );
    assert_eq!(report.schedule.remove_steps, None, "an unreadable status");
    assert_eq!(
        report.engine_refused, None,
        "nothing detected: nothing is kept for: {report:?}"
    );
    assert!(!report.engine_state_removed, "{report:?}");
    assert!(report.engine.is_empty());
    assert!(report.engine_error.is_some(), "{report:?}");
    assert_eq!(
        report.engine_state_dir, None,
        "an unresolvable state dir must not be named: {report:?}"
    );
    assert!(
        !scratch.join("app-data").join(APP_DATA_FILES[0]).exists(),
        "the app leg proceeds regardless"
    );
}

/// M9 round 2 (GPT MED; spec 3.3.5's order): with the engine's state folder UNKNOWN, a gate look that
/// still sees a unit refuses the consented engine leg with that unit's own refusal — the order the
/// settings leg already keeps (a kept scheduler, then the gate, then the unknown path) — and the unknown
/// folder is said after it, as it is for a kept scheduler. Before, the report gave only the resolution
/// error. Nothing is removed either way. The removal itself ran (exit 0, `removeAny`); this fake leaves
/// the unit file in place, which is what the gate look sees.
#[tokio::test(flavor = "multi_thread")]
async fn with_the_state_folder_unknown_the_gate_refusal_still_leads_the_engine_leg() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("uninstall-gate-before-unknown-folder");
    let program = status_sidecar(&scratch.path, &scratch.join("state"));
    // `status --json` names no usable state folder: a relative one, which is never resolved here.
    let status = json!({
        "paths": {
            "stateDir": "relative/state",
            "configPath": scratch.join("settings").join("config.json").display().to_string(),
        }
    });
    script_answer(
        &scratch.path,
        "status --json",
        &format!("printf '%s' {}\nexit 0\n", sq(&status.to_string())),
    );
    script_answer(
        &scratch.path,
        "schedule uninstall",
        &exit_answer(0, "Removed the background scheduler.", ""),
    );
    let Some(unit) = schedule_unit_files(std::env::consts::OS, &scratch.join("home"), None)
        .last()
        .cloned()
    else {
        return; // no desktop build ships where the engine writes no unit
    };
    write(&unit, "<plist/>");
    let app = app_with(
        program,
        &scratch,
        Arc::new(RecordingAutostartSink::default()),
        None,
    );

    let report = execute(&app, true, Some(SchedulerChoice::RemoveAny))
        .await
        .expect("uninstall_execute answers");
    assert!(
        engine_calls(&scratch.path).contains(&REMOVE_ANY_CALL.to_string()),
        "{:?}",
        engine_calls(&scratch.path)
    );
    assert_eq!(report.schedule.outcome, SchedulerOutcome::Removed, "{report:?}");
    assert_eq!(report.schedule_unit_file.as_deref(), unit.to_str(), "{report:?}");
    assert_eq!(
        report.engine_refused,
        Some(refused_for_unit(&unit)),
        "the gate's refusal comes before the unknown folder: {report:?}"
    );
    let error = report
        .engine_error
        .clone()
        .expect("the folder is still unknown, and still said");
    assert!(error.contains("paths.stateDir"), "{error}");
    assert!(report.engine.is_empty(), "{report:?}");
    assert!(!report.engine_state_removed, "{report:?}");
    assert_eq!(report.engine_state_dir, None, "{report:?}");
    assert!(unit.exists(), "the gate removes nothing");
}

/// Round-1 fixes M3 + F4, pinned together over the command:
/// - M3: the report NAMES the directory the consented leg targeted (`engine_state_dir`), equal
///   to the fixture sidecar's `status --json` answer.
/// - F4: `engine_state_removed` derives from the OUTCOMES — consent given, dir resolved, every
///   entry `Failed` must report FALSE. (The pre-fix spelling, consent && no resolution error,
///   reported true here: a machine-readable claim of removal over eight failures.)
#[tokio::test(flavor = "multi_thread")]
async fn a_consented_run_names_its_target_and_all_failures_report_nothing_removed() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("uninstall-allfail");
    let state_dir = scratch.join("state");
    std::fs::create_dir_all(&state_dir).expect("state dir");
    let program = status_sidecar(&scratch.path, &state_dir);
    let autostart = Arc::new(RecordingAutostartSink::default());
    let app = app_with(program, &scratch, autostart, Some(Arc::new(RefusingFs)));

    let report = execute(&app, true, None)
        .await
        .expect("uninstall_execute answers");
    // Nothing installed, so the default `removeOwn` asked the engine, whose exit 1 reads `absent`.
    assert_eq!(
        report.schedule.outcome,
        SchedulerOutcome::Absent,
        "{report:?}"
    );

    assert_eq!(
        report.engine_state_dir.as_deref(),
        state_dir.to_str(),
        "{report:?}"
    );
    assert_eq!(report.engine.len(), ENGINE_STATE_REMOVALS.len());
    for line in &report.engine {
        assert!(
            matches!(line.outcome, Outcome::Failed { .. }),
            "RefusingFs must fail every entry it is asked to remove: {line:?}"
        );
    }
    assert!(
        !report.engine_state_removed,
        "nothing removed (all failed) must not read as removed: {report:?}"
    );
    assert_eq!(report.engine_error, None, "{report:?}");
    assert_eq!(
        report.engine_refused, None,
        "a failed attempt is not a refusal: {report:?}"
    );
}

/// The record-less unit guard over the commands (round 3, D3-L4), with a FAKE home: the preview
/// names the unit file it found (`scheduleUnitFile`) beside `scheduleRecordPresent: false`, and a
/// consented execute removes nothing of the engine's, reports `refused_for_unit` once — the unit's
/// path included — and still runs the other legs. Nothing outside the scratch home is looked at:
/// the fixture overrides it (`every_default_uninstall_state_in_tests_overrides_its_real_paths`).
///
/// Batch 2 (spec 3.3.3, 3.3.4.3): a unit with no record has no `app` owner, so a call without
/// `schedule` (`removeOwn`) is refused as `ScheduleForeign` BEFORE anything — no engine removal, no
/// login item, no app file, no engine file. The consented call says `removeAny`: the engine is asked
/// with take-over, exits 0 and leaves the unit, and the gate look after the step still refuses with
/// `refused_for_unit` and names the unit in `leftover`. (`keep` would refuse with
/// `REFUSED_FOR_KEPT_SCHEDULER` instead, spec 3.3.5's first rule — the `keep` tests cover that.)
#[tokio::test(flavor = "multi_thread")]
async fn a_consented_uninstall_under_a_record_less_unit_refuses_and_names_it() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("uninstall-unit-cmd");
    let state = scratch.join("state");
    write(&state.join("daily-briefing"), "#!/bin/sh\n");
    write(&state.join("briefing.log"), "log");
    write(&scratch.join("app-data").join(APP_DATA_FILES[0]), "{}");
    let f = fixture(
        scratch,
        Arc::new(RecordingAutostartSink::reporting_enabled(true)),
    );
    let state = f._scratch.join("state");
    let units = schedule_unit_files(std::env::consts::OS, &f._scratch.join("home"), None);
    let Some(unit) = units.last() else {
        // No desktop build ships where the engine writes no unit file (`schedule_unit_files`).
        return;
    };
    write(unit, "<plist/>");

    let preview = uninstall_preview(f.app.handle().clone(), f.app.state(), f.app.state())
        .await
        .expect("uninstall_preview answers");
    assert!(!preview.schedule_record_present, "{preview:?}");
    assert_eq!(
        preview.schedule_unit_file.as_deref(),
        unit.to_str(),
        "the preview must name the unit before consent is asked for: {preview:?}"
    );
    let before = tree(&state);

    // No choice sent: `removeOwn`, and a unit with no record is not this app's to remove.
    let foreign = execute(&f.app, true, None).await;
    match &foreign {
        Err(UninstallError::ScheduleForeign { message }) => assert!(
            message.contains(&unit.display().to_string()) && message.contains("go-ahead"),
            "the refusal names the unit it found: {message}"
        ),
        other => panic!("a record-less unit under removeOwn must be ScheduleForeign: {other:?}"),
    }
    assert!(
        !removal_called(&f._scratch.path),
        "removeOwn asked the engine to remove a scheduler it did not install"
    );
    assert_eq!(tree(&state), before, "an Err removes NOTHING");
    assert!(
        f._scratch.join("app-data").join(APP_DATA_FILES[0]).exists(),
        "an Err runs no later step: the app files stay"
    );
    assert_eq!(f.autostart.disables(), 0, "an Err leaves the login item");

    // `removeAny`: the engine removes with take-over, answers 0, and the unit is still there.
    script_answer(
        &f._scratch.path,
        "schedule uninstall",
        &exit_answer(0, "Removed the background scheduler.", ""),
    );
    let report = execute(&f.app, true, Some(SchedulerChoice::RemoveAny))
        .await
        .expect("uninstall_execute answers");

    assert_eq!(
        engine_calls(&f._scratch.path).last().map(String::as_str),
        Some(REMOVE_ANY_CALL)
    );
    assert_eq!(
        report.schedule.outcome,
        SchedulerOutcome::Removed,
        "{report:?}"
    );
    assert_eq!(
        report.schedule.leftover,
        [unit.display().to_string()],
        "the gate look still saw the unit: {report:?}"
    );
    assert_eq!(
        report.engine_refused,
        Some(refused_for_unit(unit)),
        "{report:?}"
    );
    assert!(report.engine.is_empty(), "{report:?}");
    assert!(!report.engine_state_removed, "{report:?}");
    assert_eq!(tree(&state), before, "the refused leg must remove NOTHING");
    assert!(unit.exists(), "the unit is never removed here");
    assert_eq!(report.schedule_record_present, Some(false), "{report:?}");
    assert_eq!(
        report.schedule_unit_file.as_deref(),
        unit.to_str(),
        "{report:?}"
    );
    assert_eq!(report.autostart, Outcome::Removed, "{report:?}");
    assert!(!f._scratch.join("app-data").join(APP_DATA_FILES[0]).exists());
}

/// THE DONE VIEW'S SCHEDULE FACTS ARE THE EXECUTE-TIME ONES, ticked or not (round 3, A3-L2). The
/// done view used to warn from the PREVIEW's `scheduleRecordPresent`: a schedule removed between
/// preview and execute still warned, and a preview that could not resolve the state dir never did.
/// Now `uninstall_execute` reads the record (and the unit files) itself, whether or not consent was
/// given: a record the preview saw and that is gone by execute reports `Some(false)`; a record
/// there at execute reports `Some(true)` with the engine untouched and no refusal (no consent, no
/// leg); an engine that cannot name its state dir reports `None` — unknown, not "absent".
///
/// Batch 2 (spec 3.7, rewritten): the facts are the GATE look's, taken after the scheduler step,
/// and the report's `schedule` says what that step did. A `cli` record and a record-less unit have
/// no `app` owner, so the default `removeOwn` refuses them (`ScheduleForeign`, nothing touched);
/// with `keep` the engine is not asked, the outcome is `kept`, and `leftover` names what the gate
/// look saw. An engine that cannot answer makes the status unreadable: `removeOwn` refuses
/// (`ScheduleFailed`), `keep` keeps the unit it can still see — and, consented, refuses the leg for
/// it (spec 3.3.5.1) while the engine error says the folder was unknown too.
#[tokio::test(flavor = "multi_thread")]
async fn the_report_carries_the_execute_time_schedule_facts_ticked_or_not() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("uninstall-exec-facts");
    let state = scratch.join("state");
    write(&state.join("briefing.log"), "log");
    write(&state.join(SCHEDULE_RECORD), r#"{"owner":"app"}"#);
    let f = fixture(scratch, Arc::new(RecordingAutostartSink::default()));
    let state = f._scratch.join("state");
    let dir = f._scratch.path.clone();

    // The preview sees the record; the user then removes the schedule before clicking. Nothing is
    // installed by execute time, so `removeOwn` asks the engine and its exit 1 reads `absent`.
    let preview = uninstall_preview(f.app.handle().clone(), f.app.state(), f.app.state())
        .await
        .expect("uninstall_preview answers");
    assert!(preview.schedule_record_present, "{preview:?}");
    std::fs::remove_file(state.join(SCHEDULE_RECORD)).expect("the schedule is removed");
    let report = execute(&f.app, false, None)
        .await
        .expect("uninstall_execute answers");
    assert_eq!(
        report.schedule_record_present,
        Some(false),
        "UNTICKED, the execute-time record check still ran and found the record gone: {report:?}"
    );
    assert_eq!(report.schedule_unit_file, None, "{report:?}");
    assert_eq!(report.schedule.outcome, SchedulerOutcome::Absent);
    assert!(report.schedule.leftover.is_empty(), "{report:?}");
    assert_eq!(report.os, std::env::consts::OS);

    // A `cli` record there at execute, box unticked.
    write(&state.join(SCHEDULE_RECORD), r#"{"owner":"cli"}"#);
    script_answer(
        &dir,
        "schedule status",
        &view_answer(json!({
            "registered": true,
            "recordPresent": true,
            "recordFilePresent": true,
            "owner": "cli",
            "invoker": "cli",
        })),
    );
    let calls = engine_calls(&dir).len();
    // `removeOwn`: not this app's — refused before anything, the engine never asked to remove it.
    match execute(&f.app, false, None).await {
        Err(UninstallError::ScheduleForeign { message }) => {
            assert!(message.contains("set up from the terminal"), "{message}")
        }
        other => panic!("a cli record under removeOwn must be ScheduleForeign: {other:?}"),
    }
    assert_eq!(
        engine_calls(&dir)[calls..],
        ["status --json", "schedule status --json"],
        "the two reads only — no removal"
    );
    // `keep`: reported, and nothing of the engine's touched. (The first call above, with nothing
    // installed, did ask the engine; `keep` must add no removal of its own.)
    let removed_before = removals(&dir);
    let report = execute(&f.app, false, Some(SchedulerChoice::Keep))
        .await
        .expect("uninstall_execute answers");
    assert_eq!(report.schedule_record_present, Some(true), "{report:?}");
    assert_eq!(report.schedule.outcome, SchedulerOutcome::Kept);
    assert_eq!(
        report.schedule.leftover,
        [state.join(SCHEDULE_RECORD).display().to_string()]
    );
    assert_eq!(
        report.schedule.remove_steps.as_deref(),
        Some(FAKE_REMOVE_STEPS)
    );
    assert_eq!(
        report.engine_refused, None,
        "no consent, no leg to refuse: {report:?}"
    );
    assert!(
        report.engine.is_empty() && report.engine_state_dir.is_none(),
        "{report:?}"
    );
    assert!(state.join("briefing.log").exists());
    assert_eq!(
        removals(&dir),
        removed_before,
        "keep never asks the engine to remove"
    );

    // A record-less unit there at execute, box UNTICKED: the unit is read ticked or not too (round
    // 4, B4-L8 — until then only a TICKED execute pinned it, so a read made only under consent
    // passed). The engine reports nothing of it; Rust's own look is what sees it.
    std::fs::remove_file(state.join(SCHEDULE_RECORD)).expect("the record is removed");
    std::fs::remove_file(dir.join("answer-schedule-status.sh")).expect("back to the default");
    let units = schedule_unit_files(std::env::consts::OS, &f._scratch.join("home"), None);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    assert!(!units.is_empty(), "premise: this platform has unit files");
    if let Some(unit) = units.last() {
        write(unit, "<plist/>");
        let report = execute(&f.app, false, Some(SchedulerChoice::Keep))
            .await
            .expect("uninstall_execute answers");
        assert_eq!(
            report.schedule_unit_file.as_deref(),
            unit.to_str(),
            "UNTICKED, the execute-time unit check still ran and found the unit: {report:?}"
        );
        assert_eq!(report.schedule_record_present, Some(false), "{report:?}");
        assert_eq!(report.schedule.outcome, SchedulerOutcome::Kept);
        assert_eq!(report.schedule.leftover, [unit.display().to_string()]);
        assert_eq!(
            report.engine_refused, None,
            "no consent, no leg to refuse: {report:?}"
        );
        assert!(unit.exists(), "the unit is never removed here");
    }
    assert_eq!(
        removals(&dir),
        removed_before,
        "keep never asks the engine to remove"
    );

    // An engine that cannot name its state dir: unknown, not absent — ticked or not. The unit
    // files are under the home, not the state dir, so they are still looked at.
    let scratch = ScratchDir::new("uninstall-exec-facts-noengine");
    let program = fake_sidecar(&scratch.path, "engine.sh", "exit 2");
    let unit = schedule_unit_files(std::env::consts::OS, &scratch.join("home"), None)
        .last()
        .cloned();
    if let Some(unit) = &unit {
        write(unit, "<plist/>");
    }
    let app = app_with(
        program,
        &scratch,
        Arc::new(RecordingAutostartSink::default()),
        None,
    );
    // `removeOwn` cannot tell whose scheduler it would remove: refused (spec 3.3.4.3).
    assert_eq!(
        execute(&app, true, None).await,
        Err(UninstallError::ScheduleFailed {
            message: SCHEDULE_STATUS_UNREADABLE.to_string()
        })
    );
    for consent in [false, true] {
        let report = execute(&app, consent, Some(SchedulerChoice::Keep))
            .await
            .expect("uninstall_execute answers");
        assert_eq!(
            report.schedule_record_present, None,
            "consent={consent}: {report:?}"
        );
        assert_eq!(
            report.schedule_unit_file.as_deref(),
            unit.as_deref().and_then(Path::to_str),
            "consent={consent}: with no state dir the unit is still looked for: {report:?}"
        );
        assert_eq!(report.schedule.remove_steps, None, "an unreadable status");
        assert_eq!(
            report.engine_error.is_some(),
            consent,
            "the engine error belongs to the consented leg only: {report:?}"
        );
        // The unit is a detected scheduler, and `keep` keeps it: a consented leg is refused for it.
        let kept = unit.is_some();
        assert_eq!(
            report.schedule.outcome,
            if kept {
                SchedulerOutcome::Kept
            } else {
                SchedulerOutcome::NotChecked
            },
            "consent={consent}: {report:?}"
        );
        assert_eq!(
            report.engine_refused.as_deref(),
            (consent && kept).then_some(REFUSED_FOR_KEPT_SCHEDULER),
            "consent={consent}: {report:?}"
        );
    }
}

/// A filesystem that is the real one, except that ONE path — a scheduler unit or the record —
/// APPEARS on its `appears_at`-th presence check (1-based) and stays: what a schedule installed
/// while `uninstall_execute` runs looks like to it.
struct AppearsFs {
    path: PathBuf,
    appears_at: u32,
    checks: std::sync::atomic::AtomicU32,
}

impl UninstallFs for AppearsFs {
    fn exists(&self, path: &Path) -> bool {
        if path == self.path {
            let n = self
                .checks
                .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
                + 1;
            return n >= self.appears_at;
        }
        SystemFs.exists(path)
    }
    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        SystemFs.remove_file(path)
    }
    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()> {
        SystemFs.remove_dir_all(path)
    }
    fn list_dir(&self, dir: &Path) -> std::io::Result<Vec<String>> {
        SystemFs.list_dir(dir)
    }
    fn kind(&self, path: &Path) -> std::io::Result<Lstat> {
        SystemFs.kind(path)
    }
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf> {
        SystemFs.canonicalize(path)
    }
    fn read_small(&self, path: &Path, max_bytes: u64) -> Result<String, ReadRefusal> {
        SystemFs.read_small(path, max_bytes)
    }
    fn remove_empty_dir(&self, path: &Path) -> std::io::Result<()> {
        SystemFs.remove_empty_dir(path)
    }
}

/// THE REPORT SAYS WHAT THE GATE SAW (round 4, G4-L1). `uninstall_execute` used to sample the unit
/// BEFORE its `status --json` spawn and the record after it, while the gate looked again before the
/// first removal; a unit that appeared in between was refused on and reported absent, and the done
/// view gave the stale-RECORD warning for a unit refusal. Now one look feeds both. Driven by a unit,
/// then a record, that appears on its 1st, 2nd or 3rd presence check: whatever happens, the
/// consented report must agree with its own refusal — refused on the unit ⇒ the report names that
/// unit and no record; refused on the record ⇒ it says a record; not refused ⇒ it names neither
/// (and the leg ran). The 1st-check case is refused, so the agreement is never vacuous.
///
/// Batch 2 (spec 3.3.4.5, 3.7): the meaning is kept, the setup changes. `uninstall_execute` now
/// looks TWICE — a first look before the scheduler step (check 1), and the gate look after it
/// (check 2), which is the one the gate refuses on and the report states, `leftover` included. The
/// call says `removeAny`, and the engine answers 0, so every case reaches the gate: appearing at
/// check 1 or 2, the thing is there at the gate look and refuses; at check 3 the gate never sees
/// it and the leg runs.
#[tokio::test(flavor = "multi_thread")]
async fn the_report_states_the_look_the_gate_refused_on() {
    let _turn = serialise().await;
    for target in ["unit", "record"] {
        let mut refusals = 0;
        for appears_at in 1..=3 {
            let scratch = ScratchDir::new("uninstall-one-look");
            let state = scratch.join("state");
            write(&state.join("briefing.log"), "log");
            let units = schedule_unit_files(std::env::consts::OS, &scratch.join("home"), None);
            let Some(unit) = units.first().cloned() else {
                // No desktop build ships where the engine writes no unit file.
                return;
            };
            let path = match target {
                "unit" => unit.clone(),
                _ => state.join(SCHEDULE_RECORD),
            };
            let fs = Arc::new(AppearsFs {
                path: path.clone(),
                appears_at,
                checks: AtomicU32::new(0),
            });
            let program = status_sidecar(&scratch.path, &state);
            script_answer(
                &scratch.path,
                "schedule uninstall",
                &exit_answer(0, "Removed the background scheduler.", ""),
            );
            let app = app_with(
                program,
                &scratch,
                Arc::new(RecordingAutostartSink::default()),
                Some(fs.clone()),
            );
            let report = execute(&app, true, Some(SchedulerChoice::RemoveAny))
                .await
                .expect("uninstall_execute answers");
            let at = format!("{target} appearing at check {appears_at}");
            assert_eq!(
                fs.checks.load(Ordering::SeqCst),
                2,
                "{at}: one first look and one gate look"
            );
            assert_eq!(
                report.schedule.outcome,
                SchedulerOutcome::Removed,
                "{at}: {report:?}"
            );
            match report.engine_refused.as_deref() {
                Some(refused) if refused == REFUSED_FOR_SCHEDULE => {
                    refusals += 1;
                    assert_eq!(target, "record", "{at}: refused on a record: {report:?}");
                    assert_eq!(
                        report.schedule_record_present,
                        Some(true),
                        "{at}: refused on a record the report does not state: {report:?}"
                    );
                    assert_eq!(
                        report.schedule.leftover,
                        [path.display().to_string()],
                        "{at}: refused on a record the leftover does not name: {report:?}"
                    );
                }
                Some(refused) => {
                    refusals += 1;
                    assert_eq!(refused, refused_for_unit(&unit), "{at}: {report:?}");
                    assert_eq!(
                        report.schedule_unit_file.as_deref(),
                        unit.to_str(),
                        "{at}: refused on a unit the report does not name: {report:?}"
                    );
                    assert_eq!(report.schedule_record_present, Some(false), "{at}");
                    assert_eq!(
                        report.schedule.leftover,
                        [unit.display().to_string()],
                        "{at}: refused on a unit the leftover does not name: {report:?}"
                    );
                }
                None => {
                    assert_eq!(report.schedule_unit_file, None, "{at}: {report:?}");
                    assert_eq!(report.schedule_record_present, Some(false), "{at}");
                    assert!(report.schedule.leftover.is_empty(), "{at}: {report:?}");
                    assert!(report.engine_state_removed, "{at}: the leg ran: {report:?}");
                }
            }
        }
        assert_eq!(
            refusals, 2,
            "premise: a {target} there by the gate look (check 2) must refuse, and only then"
        );
    }
}

/* ── Batch 2: the scheduler step (spec 3.3.2-3.3.6, 3.7 "Rust") ───────────────────────────────── */

/// A planted machine for the scheduler-step tests: engine files and the archive under `state`, the
/// app's own record, and an ENABLED login item — so "Rust removed nothing" (every `Err`'s contract,
/// spec 3.3.4.3) is checkable as: the state tree is byte-for-byte what it was, the app record is
/// still there, and the login item was never disabled. The engine is [`status_sidecar`].
struct Planted {
    f: Fixture,
    state: PathBuf,
    before: BTreeMap<PathBuf, Vec<u8>>,
}

fn planted(tag: &str) -> Planted {
    let scratch = ScratchDir::new(tag);
    let state = scratch.join("state");
    write(&state.join("daily-briefing"), "#!/bin/sh\n");
    write(&state.join("briefing.log"), "log");
    write(&state.join("briefings").join("2026-09-01.md"), "archived");
    write(&scratch.join("app-data").join(APP_DATA_FILES[0]), "{}");
    let f = fixture(
        scratch,
        Arc::new(RecordingAutostartSink::reporting_enabled(true)),
    );
    let state = f._scratch.join("state");
    let before = tree(&state);
    assert!(before.len() >= 4, "premise: the fixture planted the tree");
    Planted { f, state, before }
}

impl Planted {
    /// The fake engine's directory (its scripts and its call log).
    fn dir(&self) -> &Path {
        &self.f._scratch.path
    }

    fn assert_nothing_removed(&self, what: &str) {
        assert_eq!(
            tree(&self.state),
            self.before,
            "{what}: an Err must remove NOTHING of the engine's"
        );
        assert!(
            self.f
                ._scratch
                .join("app-data")
                .join(APP_DATA_FILES[0])
                .exists(),
            "{what}: an Err runs no later step — the app files must stay"
        );
        assert_eq!(
            self.f.autostart.disables(),
            0,
            "{what}: an Err runs no later step — the login item must stay"
        );
    }
}

/// What a scheduler-step case must produce.
#[derive(Debug)]
enum Want {
    Outcome(SchedulerOutcome),
    /// `ScheduleForeign` whose message is exactly this (the engine's stderr).
    Foreign(&'static str),
    /// `ScheduleForeign` with Rust's own sentence, which contains this.
    ForeignSaying(&'static str),
    /// `ScheduleFailed` whose message is exactly this (the engine's stderr).
    Failed(&'static str),
    /// `ScheduleFailed` with Rust's own sentence, which contains this.
    FailedSaying(&'static str),
}

/// The engine's own refusal, verbatim in shape (`src/schedule/install.ts`, `uninstallSchedule`).
const ENGINE_FOREIGN: &str = "This background scheduler wasn't set up by this app (a schedule \
     record set up from the terminal at /s/schedule.json, with no unit file). Removing it needs \
     your go-ahead.";

/// A stable-reason failure leads with the manual steps (spec 3.1.7), and is shown verbatim.
const ENGINE_STEPS_FIRST: &str = "Run these in a terminal (bash or zsh) inside your desktop \
     session.\n  launchctl bootout gui/$(id -u)/local.daily-briefing\nCouldn't check whether a \
     background scheduler is registered (no-gui-session). Nothing was removed.";

/// Spec 3.3.4.3, 3.7 "The scheduler step": every engine answer maps as the spec says, and on EVERY
/// `Err` Rust has removed nothing — no engine file, no app file, no login item — because the step
/// runs before all of them. The engine is asked exactly once, without `--take-over` for `removeOwn`
/// and with it for `removeAny`. The exit-1 rule reads stdout AND the step-1 facts: a genuine exit 1
/// always prints its line, a crash does not, and a fact the engine reported a moment earlier
/// (`recordFilePresent`, `unitPresent`, `registered: true`) contradicts "nothing installed" — each
/// ON ITS OWN, so each has a row where it is the only contradiction — while `registered: null`
/// does not, because the engine's own check has just run again. And only a step-1 read that
/// SUCCEEDED can vouch for an exit 1: `removeAny` reaches the engine with the read unreadable, and
/// its exit 1, line and all, is still `ScheduleFailed` (Checkpoint M5a: neither half was pinned).
#[tokio::test(flavor = "multi_thread")]
async fn the_scheduler_step_maps_each_engine_answer_and_an_err_removes_nothing() {
    let _turn = serialise().await;
    let app_owned = json!({
        "registered": true,
        "recordPresent": true,
        "recordFilePresent": true,
        "owner": "app",
        "invoker": "app",
    });
    // Each row: its name, the choice, the scripted `schedule status` answer (step 1's read), the
    // scripted `schedule uninstall` answer, and what the step must produce.
    let cases: Vec<(&str, SchedulerChoice, String, String, Want)> = vec![
        (
            "exit 0",
            SchedulerChoice::RemoveOwn,
            view_answer(json!({})),
            exit_answer(0, "Removed the background scheduler.", ""),
            Want::Outcome(SchedulerOutcome::Removed),
        ),
        (
            "exit 1 with its line, nothing installed",
            SchedulerChoice::RemoveOwn,
            view_answer(json!({})),
            exit_answer(1, NOTHING_INSTALLED, ""),
            Want::Outcome(SchedulerOutcome::Absent),
        ),
        (
            "exit 1 with its line after a step-1 `registered: null`",
            SchedulerChoice::RemoveOwn,
            view_answer(json!({ "registered": null, "registeredReason": "no-user-manager" })),
            exit_answer(1, NOTHING_INSTALLED, ""),
            Want::Outcome(SchedulerOutcome::Absent),
        ),
        (
            "exit 1 with its line against this app's record file",
            SchedulerChoice::RemoveOwn,
            view_answer(app_owned.clone()),
            exit_answer(1, NOTHING_INSTALLED, ""),
            Want::FailedSaying("nothing to remove"),
        ),
        (
            "exit 1 with its line against this app's record file alone (`registered: null`)",
            SchedulerChoice::RemoveOwn,
            view_answer(json!({
                "registered": null,
                "registeredReason": "no-user-manager",
                "recordPresent": true,
                "recordFilePresent": true,
                "owner": "app",
                "invoker": "app",
            })),
            exit_answer(1, NOTHING_INSTALLED, ""),
            Want::FailedSaying("nothing to remove"),
        ),
        (
            "exit 1 with its line against a record file alone (`registered: false`)",
            SchedulerChoice::RemoveAny,
            view_answer(json!({ "recordFilePresent": true })),
            exit_answer(1, NOTHING_INSTALLED, ""),
            Want::FailedSaying("nothing to remove"),
        ),
        (
            "exit 1 with its line against a unit the engine saw",
            SchedulerChoice::RemoveAny,
            view_answer(json!({ "unitPresent": true })),
            exit_answer(1, NOTHING_INSTALLED, ""),
            Want::FailedSaying("nothing to remove"),
        ),
        (
            "exit 1 with its line against a registration",
            SchedulerChoice::RemoveAny,
            view_answer(json!({ "registered": true })),
            exit_answer(1, NOTHING_INSTALLED, ""),
            Want::FailedSaying("nothing to remove"),
        ),
        (
            "exit 1 with its line after an UNREADABLE step-1 read",
            SchedulerChoice::RemoveAny,
            exit_answer(2, "", "the user manager did not answer"),
            exit_answer(1, NOTHING_INSTALLED, ""),
            Want::FailedSaying("nothing to remove"),
        ),
        (
            "exit 1 with an empty stdout (a crash)",
            SchedulerChoice::RemoveOwn,
            view_answer(json!({})),
            exit_answer(1, "", "TypeError: undefined is not a function"),
            Want::Failed("TypeError: undefined is not a function"),
        ),
        (
            "exit 1 with nothing on either stream",
            SchedulerChoice::RemoveOwn,
            view_answer(json!({})),
            exit_answer(1, "", ""),
            Want::FailedSaying("exit status 1"),
        ),
        (
            "exit 2 without take-over",
            SchedulerChoice::RemoveOwn,
            view_answer(json!({})),
            exit_answer(2, "", ENGINE_FOREIGN),
            Want::Foreign(ENGINE_FOREIGN),
        ),
        (
            "exit 2 with take-over",
            SchedulerChoice::RemoveAny,
            view_answer(json!({})),
            exit_answer(2, "", ENGINE_FOREIGN),
            Want::Failed(ENGINE_FOREIGN),
        ),
        (
            "exit 3 with a stable reason's steps first",
            SchedulerChoice::RemoveOwn,
            view_answer(json!({})),
            exit_answer(3, "", ENGINE_STEPS_FIRST),
            Want::Failed(ENGINE_STEPS_FIRST),
        ),
        (
            "exit 3 with an empty stderr",
            SchedulerChoice::RemoveAny,
            view_answer(json!({})),
            exit_answer(3, "", ""),
            Want::FailedSaying("exit status 3"),
        ),
        (
            "an exit code the engine never uses",
            SchedulerChoice::RemoveOwn,
            view_answer(json!({})),
            exit_answer(7, "", "something odd"),
            Want::Failed("something odd"),
        ),
        (
            "a signal death",
            SchedulerChoice::RemoveOwn,
            view_answer(json!({})),
            "kill -9 $$\n".to_string(),
            Want::FailedSaying("signal"),
        ),
    ];
    for (name, choice, status_answer, answer, want) in cases {
        let p = planted("uninstall-step");
        script_answer(p.dir(), "schedule status", &status_answer);
        script_answer(p.dir(), "schedule uninstall", &answer);

        let result = execute(&p.f.app, true, Some(choice)).await;

        assert_eq!(
            engine_calls(p.dir()),
            [
                "status --json",
                "schedule status --json",
                match choice {
                    SchedulerChoice::RemoveAny => REMOVE_ANY_CALL,
                    _ => REMOVE_OWN_CALL,
                },
            ],
            "{name}: the two reads, then ONE removal"
        );
        match (&want, &result) {
            (Want::Outcome(outcome), Ok(report)) => {
                assert_eq!(report.schedule.outcome, *outcome, "{name}: {report:?}");
                assert!(report.engine_state_removed, "{name}: the leg ran: {report:?}");
            }
            (Want::Foreign(message), Err(UninstallError::ScheduleForeign { message: got })) => {
                assert_eq!(got, message, "{name}");
                p.assert_nothing_removed(name);
            }
            (Want::Failed(message), Err(UninstallError::ScheduleFailed { message: got })) => {
                assert_eq!(got, message, "{name}: the engine's stderr, verbatim");
                p.assert_nothing_removed(name);
            }
            (Want::FailedSaying(part), Err(UninstallError::ScheduleFailed { message: got })) => {
                assert!(got.contains(part), "{name}: Rust's own sentence: {got}");
                p.assert_nothing_removed(name);
            }
            _ => panic!("{name}: wanted {want:?}, got {result:?}"),
        }
    }
}

/// Spec 3.3.4.3, 3.7: `removeOwn` against a scheduler without an `app` owner — a `cli` record, a
/// record whose owner cannot be read (the engine's lstat, or only Rust's), a unit with no record, a
/// registration with no files — is `ScheduleForeign`, and against an unreadable status (a failed
/// read, an envelope Rust cannot parse) `ScheduleFailed`, each WITHOUT asking the engine to remove
/// anything and each removing nothing. The owner comes ONLY from the status read (spec 3.3.3).
#[tokio::test(flavor = "multi_thread")]
async fn remove_own_refuses_what_it_did_not_install_without_calling_the_engine() {
    for (name, plant, schedule_answer, want) in [
        (
            "a cli record",
            "",
            view_answer(json!({
                "registered": true,
                "recordPresent": true,
                "recordFilePresent": true,
                "owner": "cli",
                "invoker": "cli",
            })),
            Want::ForeignSaying("set up from the terminal"),
        ),
        (
            "a record whose owner the engine cannot read",
            "",
            view_answer(json!({ "recordFilePresent": true })),
            Want::ForeignSaying("owner can't be read"),
        ),
        (
            "a record only Rust's look sees",
            "record",
            view_answer(json!({})),
            Want::ForeignSaying("owner can't be read"),
        ),
        (
            "a unit with no record",
            "unit",
            view_answer(json!({})),
            Want::ForeignSaying("with no schedule record"),
        ),
        (
            "a registration with no files",
            "",
            view_answer(json!({ "registered": true })),
            Want::ForeignSaying("a registration with no files"),
        ),
        (
            "an unreadable status (a failed read)",
            "",
            exit_answer(2, "", "the user manager did not answer"),
            Want::Failed(SCHEDULE_STATUS_UNREADABLE),
        ),
        (
            "an unreadable status (an envelope Rust cannot read)",
            "",
            format!("printf '%s' {}\nexit 0\n", sq(r#"{"registered":"yes"}"#)),
            Want::Failed(SCHEDULE_STATUS_UNREADABLE),
        ),
    ] {
        let p = planted("uninstall-own");
        let unit = schedule_unit_files(std::env::consts::OS, &p.f._scratch.join("home"), None)
            .last()
            .cloned();
        match plant {
            "record" => write(&p.state.join(SCHEDULE_RECORD), r#"{"owner":"app"}"#),
            "unit" => match &unit {
                Some(unit) => write(unit, "<plist/>"),
                None => continue, // no desktop build ships where the engine writes no unit
            },
            _ => {}
        }
        let p = Planted {
            before: tree(&p.state),
            ..p
        };
        script_answer(p.dir(), "schedule status", &schedule_answer);

        let result = execute(&p.f.app, true, Some(SchedulerChoice::RemoveOwn)).await;

        assert!(
            !removal_called(p.dir()),
            "{name}: removeOwn asked the engine to remove a scheduler it did not install"
        );
        match (&want, &result) {
            // A foreign scheduler: the message says what was found, in the engine's words.
            (Want::ForeignSaying(part), Err(UninstallError::ScheduleForeign { message })) => {
                assert!(
                    message.contains(part) && message.ends_with("Removing it needs your go-ahead."),
                    "{name}: {message}"
                );
                if plant == "unit" {
                    let unit = unit.as_ref().expect("planted");
                    assert!(message.contains(&unit.display().to_string()), "{message}");
                }
            }
            (Want::Failed(message), Err(UninstallError::ScheduleFailed { message: got })) => {
                assert_eq!(got, message, "{name}")
            }
            _ => panic!("{name}: wanted {want:?}, got {result:?}"),
        }
        p.assert_nothing_removed(name);
        if let (Some(unit), "unit") = (&unit, plant) {
            assert!(unit.exists(), "{name}: the unit is never removed here");
        }
    }
}

/// Spec 3.3.2, 3.7: a MISSING `schedule` means `removeOwn` — tested with a detected app-owned
/// scheduler (the engine is asked, without take-over; it removes the record and exits 0, so the gate
/// look sees nothing and the consented leg RUNS — spec 3.7's "exit 0 with the record gone lets the
/// consented legs run") and with a `cli` one (`ScheduleForeign`, the engine never asked).
#[tokio::test(flavor = "multi_thread")]
async fn a_missing_schedule_choice_means_remove_own() {
    let _turn = serialise().await;
    let record = |owner: &str| {
        view_answer(json!({
            "registered": true,
            "recordPresent": true,
            "recordFilePresent": true,
            "owner": owner,
            "invoker": owner,
        }))
    };

    // This app's own: removed, and with it gone the consented leg runs.
    let p = planted("uninstall-default-app");
    write(&p.state.join(SCHEDULE_RECORD), r#"{"owner":"app"}"#);
    script_answer(p.dir(), "schedule status", &record("app"));
    script_answer(
        p.dir(),
        "schedule uninstall",
        &format!(
            "rm -f -- {}\n{}",
            sq(&p.state.join(SCHEDULE_RECORD).display().to_string()),
            exit_answer(0, "Removed the background scheduler.", "")
        ),
    );
    let report = execute(&p.f.app, true, None)
        .await
        .expect("uninstall_execute answers");
    assert_eq!(
        engine_calls(p.dir()).last().map(String::as_str),
        Some(REMOVE_OWN_CALL)
    );
    assert_eq!(report.schedule.outcome, SchedulerOutcome::Removed);
    assert!(report.schedule.leftover.is_empty(), "{report:?}");
    assert_eq!(report.schedule_record_present, Some(false), "{report:?}");
    assert_eq!(report.engine_refused, None, "{report:?}");
    assert!(report.engine_state_removed, "{report:?}");
    assert!(!p.state.join("briefing.log").exists(), "the leg ran");
    assert_eq!(report.autostart, Outcome::Removed, "{report:?}");

    // A terminal one: refused before anything.
    let p = planted("uninstall-default-cli");
    script_answer(p.dir(), "schedule status", &record("cli"));
    match execute(&p.f.app, true, None).await {
        Err(UninstallError::ScheduleForeign { message }) => {
            assert!(message.contains("set up from the terminal"), "{message}")
        }
        other => panic!("a cli scheduler with no choice must be ScheduleForeign: {other:?}"),
    }
    assert!(!removal_called(p.dir()), "the engine was asked to remove it");
    p.assert_nothing_removed("a cli scheduler with no choice");
}

/// Spec 3.3.4.3, 3.7: busy — another engine operation holds the in-flight guard — is `Busy`; an
/// unresolved sidecar is `ScheduleFailed` with the error's text under `removeAny` (and, under
/// `removeOwn`, the unreadable status refuses first). Each removes nothing. With `keep` an
/// unresolved sidecar refuses nothing: no state folder, no unit, nothing detected — `notChecked`.
#[tokio::test(flavor = "multi_thread")]
async fn busy_and_an_unresolved_sidecar_are_errors_that_remove_nothing() {
    let _turn = serialise().await;

    // Busy: a run is in flight (a fake that stays up until this test drops it).
    let p = planted("uninstall-busy");
    let started = p.f._scratch.join("run-started");
    let blocker = fake_sidecar(
        p.dir(),
        "blocker.sh",
        &format!(": > {}\nexec /bin/sleep 30", sq(&started.display().to_string())),
    );
    let client = EngineClient::with_program(blocker);
    let mut run = Box::pin(client.invoke(
        Operation::Run {
            force: false,
            json_out: None,
        },
        &NoProgress,
    ));
    for _ in 0..500 {
        if started.exists() {
            break;
        }
        if let Ok(done) = tokio::time::timeout(Duration::from_millis(20), &mut run).await {
            panic!("the blocking run ended early: {done:?}");
        }
    }
    assert!(started.exists(), "premise: the blocking run is in flight");
    let busy = execute(&p.f.app, true, None).await;
    drop(run); // kills the blocker's process group
    match &busy {
        Err(UninstallError::Busy { message }) => {
            assert!(message.contains("already running"), "{message}")
        }
        other => panic!("a scheduler step under a run in flight must be Busy: {other:?}"),
    }
    p.assert_nothing_removed("busy");

    // An unresolved sidecar.
    let scratch = ScratchDir::new("uninstall-no-sidecar");
    write(&scratch.join("app-data").join(APP_DATA_FILES[0]), "{}");
    let autostart = Arc::new(RecordingAutostartSink::reporting_enabled(true));
    let app = app_managing(
        Engine(Err(EngineError::SidecarUnresolved {
            detail: "no sidecar beside this test".into(),
        })),
        &scratch,
        autostart.clone(),
        scratch_uninstall_state(&scratch),
    );
    match execute(&app, true, Some(SchedulerChoice::RemoveAny)).await {
        Err(UninstallError::ScheduleFailed { message }) => assert!(
            message.contains("could not locate the bundled engine")
                && message.contains("no sidecar beside this test"),
            "{message}"
        ),
        other => panic!("removeAny with no sidecar must be ScheduleFailed: {other:?}"),
    }
    assert_eq!(
        execute(&app, true, Some(SchedulerChoice::RemoveOwn)).await,
        Err(UninstallError::ScheduleFailed {
            message: SCHEDULE_STATUS_UNREADABLE.to_string()
        })
    );
    assert!(scratch.join("app-data").join(APP_DATA_FILES[0]).exists());
    assert_eq!(autostart.disables(), 0, "an Err leaves the login item");
    let report = execute(&app, true, Some(SchedulerChoice::Keep))
        .await
        .expect("keep with nothing detected answers");
    assert_eq!(report.schedule.outcome, SchedulerOutcome::NotChecked);
    assert_eq!(report.engine_refused, None, "{report:?}");
    assert!(report.engine_error.is_some(), "{report:?}");
}

/// Spec 3.3.4.3, 3.3.6, 3.7 "The gate look after the scheduler step": a unit only Rust can see —
/// the engine reports none, and its removal genuinely finds nothing (exit 1 with its line) —
/// continues as `absent`. The gate look then reports it in `leftover`, with its per-path command in
/// `leftoverCommands` when it lies outside the unit folder of the engine THIS app spawns (a custom
/// `$XDG_CONFIG_HOME`, which only Linux has), and `removeSteps` stays the engine's. With no data leg
/// consented nothing is refused; consented, the leg is refused with the unit's own refusal. Under
/// `removeOwn` that unit is detected with no `app` owner: `ScheduleForeign`.
#[tokio::test(flavor = "multi_thread")]
async fn a_unit_only_rust_sees_is_left_over_with_its_command_after_exit_1() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("uninstall-rust-only-unit");
    let state = scratch.join("state");
    write(&state.join("briefing.log"), "log");
    let xdg = scratch.join("xdg");
    let units = schedule_unit_files(std::env::consts::OS, &scratch.join("home"), Some(&xdg));
    let Some(unit) = units
        .iter()
        .find(|u| u.starts_with(&xdg))
        .or(units.last())
        .cloned()
    else {
        return; // no desktop build ships where the engine writes no unit file
    };
    write(&unit, "<plist/>");
    // Only a systemd unit under the custom folder is outside the engine's own: the macOS plist has
    // one folder, and its way out is the engine's own steps.
    let expected: Vec<String> = if unit.starts_with(&xdg) {
        vec![format!(
            "XDG_CONFIG_HOME='{}' daily-briefing schedule uninstall",
            xdg.display()
        )]
    } else {
        Vec::new()
    };
    #[cfg(target_os = "linux")]
    assert!(
        !expected.is_empty(),
        "premise: on Linux the unit sits in the custom folder"
    );
    let app = app_managing(
        Engine(Ok(EngineClient::with_program(status_sidecar(
            &scratch.path,
            &state,
        )))),
        &scratch,
        Arc::new(RecordingAutostartSink::default()),
        scratch_uninstall_state(&scratch).with_xdg_config_home(&xdg),
    );
    let before = tree(&state);

    for consent in [false, true] {
        let report = execute(&app, consent, Some(SchedulerChoice::RemoveAny))
            .await
            .expect("uninstall_execute answers");
        assert_eq!(
            engine_calls(&scratch.path).last().map(String::as_str),
            Some(REMOVE_ANY_CALL)
        );
        assert_eq!(
            report.schedule.outcome,
            SchedulerOutcome::Absent,
            "{report:?}"
        );
        assert_eq!(report.schedule.leftover, [unit.display().to_string()]);
        assert_eq!(report.schedule.leftover_commands, expected, "{report:?}");
        assert_eq!(
            report.schedule.remove_steps.as_deref(),
            Some(FAKE_REMOVE_STEPS),
            "removeSteps stays strictly the engine's"
        );
        assert_eq!(
            report.engine_refused,
            consent.then(|| refused_for_unit(&unit)),
            "consent={consent}: {report:?}"
        );
        assert_eq!(tree(&state), before, "consent={consent}: nothing removed");
        assert!(unit.exists(), "the unit is never removed here");
    }
    // `removeOwn`: a unit with no record has no `app` owner.
    assert!(matches!(
        execute(&app, true, None).await,
        Err(UninstallError::ScheduleForeign { .. })
    ));
}

/// The per-path commands of spec 3.3.6, pure: only a leftover systemd unit OUTSIDE the unit folder
/// of the engine this app spawns gets one — that engine sees no `$XDG_CONFIG_HOME`, so its folder is
/// the home's — and the command is `unit_uninstall_command`'s, for the unit's own folder.
#[test]
fn leftover_commands_name_only_a_unit_outside_the_engines_own_folder() {
    let home = Path::new("/h");
    let engine = schedule_unit_files("linux", home, None);
    assert_eq!(
        leftover_commands(
            Some(Path::new("/x/systemd/user/daily-briefing.timer")),
            &engine
        ),
        ["XDG_CONFIG_HOME='/x' daily-briefing schedule uninstall"]
    );
    for own in &engine {
        assert!(
            leftover_commands(Some(own), &engine).is_empty(),
            "{own:?}: the engine's own steps name it"
        );
    }
    assert!(leftover_commands(None, &engine).is_empty());
    let mac = schedule_unit_files("macos", home, None);
    assert!(leftover_commands(Some(&mac[0]), &mac).is_empty());
    assert!(
        leftover_commands(
            Some(Path::new("/elsewhere/local.daily-briefing.plist")),
            &mac
        )
        .is_empty(),
        "a plist has no command of its own"
    );
}

/// M9 LOW pass (L8): the gate look keeps EVERY unit file there, in the order it was given — the platform's,
/// [`schedule_unit_files`]' — while `unit`, the one the refusal names and the report's `scheduleUnitFile`, stays
/// the first of them. Platform-free: the look takes the unit list it is handed.
#[test]
fn the_gate_look_keeps_every_unit_file_there_in_order() {
    let scratch = ScratchDir::new("uninstall-seen-units");
    let state = scratch.join("state");
    let units: Vec<PathBuf> = ["a.service", "a.timer", "b.service", "b.timer"]
        .iter()
        .map(|name| scratch.join("units").join(name))
        .collect();
    write(&units[1], "x");
    write(&units[3], "x");

    let seen = ScheduleSeen::look(&SystemFs, &state, &units);

    assert!(!seen.record, "{seen:?}");
    assert_eq!(seen.units, [units[1].clone(), units[3].clone()], "{seen:?}");
    assert_eq!(seen.unit.as_deref(), Some(units[1].as_path()), "{seen:?}");
    assert_eq!(seen.refusal(), Some(refused_for_unit(&units[1])));
    // None of them there: none kept, and nothing refuses.
    let none = ScheduleSeen::look(&SystemFs, &state, &units[..1]);
    assert!(
        none.units.is_empty() && none.unit.is_none() && none.refusal().is_none(),
        "{none:?}"
    );
}

/// M9 LOW pass (L8): `schedule.leftover` names EVERY unit file the gate look saw, in the platform's order —
/// on Linux the service AND the timer, where it used to name the first alone, so "Still on this machine"
/// listed the service and not the timer — while `scheduleUnitFile` stays the first. `keep`, unticked: the
/// engine is never asked, and nothing is removed. (macOS has one unit file, so there this pins the one;
/// [`the_gate_look_keeps_every_unit_file_there_in_order`] pins the order on any platform.)
#[tokio::test(flavor = "multi_thread")]
async fn the_leftover_names_every_unit_file_the_gate_look_saw() {
    let p = planted("uninstall-every-unit");
    let units = schedule_unit_files(std::env::consts::OS, &p.f._scratch.join("home"), None);
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    assert!(!units.is_empty(), "premise: this platform has unit files");
    #[cfg(target_os = "linux")]
    assert_eq!(units.len(), 2, "premise: the service and the timer");
    for unit in &units {
        write(unit, "<unit/>");
    }

    let report = execute(&p.f.app, false, Some(SchedulerChoice::Keep))
        .await
        .expect("uninstall_execute answers");

    assert!(!removal_called(p.dir()), "keep asked the engine to remove");
    assert_eq!(report.schedule.outcome, SchedulerOutcome::Kept, "{report:?}");
    assert_eq!(
        report.schedule.leftover,
        units
            .iter()
            .map(|unit| unit.display().to_string())
            .collect::<Vec<_>>(),
        "{report:?}"
    );
    assert_eq!(
        report.schedule_unit_file.as_deref(),
        units.first().and_then(|unit| unit.to_str()),
        "{report:?}"
    );
    for unit in &units {
        assert!(unit.exists(), "the unit is never removed here: {}", unit.display());
    }
    assert_eq!(tree(&p.state), p.before, "keep, unticked: nothing of the engine's is removed");
}

/// Spec 3.3.5.1, 3.7 "`keep`": with `keep` and a scheduler DETECTED — a registration with no files,
/// this app's own record, a unit — the engine is never asked to remove anything, the outcome is
/// `kept`, and the consented engine leg is refused with `REFUSED_FOR_KEPT_SCHEDULER`, before the
/// gate's own refusal would apply (a record or unit there). Nothing of the engine's is removed; the
/// other legs run. The settings box is ticked too (T5.4): "it refuses the engine AND settings legs"
/// — the settings leg is refused with the same text, nothing in its folder goes, and no latch.
#[tokio::test(flavor = "multi_thread")]
async fn keep_refuses_the_engine_leg_for_a_detected_scheduler_and_never_calls_the_engine() {
    for (name, plant, facts) in [
        (
            "a registration with no files",
            "",
            json!({ "registered": true }),
        ),
        (
            "this app's own record",
            "record",
            json!({
                "registered": true,
                "recordPresent": true,
                "recordFilePresent": true,
                "owner": "app",
                "invoker": "app",
            }),
        ),
        ("a unit file", "unit", json!({})),
    ] {
        let p = planted("uninstall-keep");
        let unit = schedule_unit_files(std::env::consts::OS, &p.f._scratch.join("home"), None)
            .last()
            .cloned();
        let leftover = match plant {
            "record" => {
                write(&p.state.join(SCHEDULE_RECORD), r#"{"owner":"app"}"#);
                vec![p.state.join(SCHEDULE_RECORD).display().to_string()]
            }
            "unit" => match &unit {
                Some(unit) => {
                    write(unit, "<plist/>");
                    vec![unit.display().to_string()]
                }
                None => continue,
            },
            _ => Vec::new(),
        };
        let before = tree(&p.state);
        script_answer(p.dir(), "schedule status", &view_answer(facts));
        // T5.4's half (spec 3.7 "`keep`"): the settings box is ticked too, over a planted folder.
        let folder = plant_settings(p.dir());
        let settings_before = tree(&folder);

        let report = execute_with(&p.f.app, true, Some(true), Some(SchedulerChoice::Keep))
            .await
            .expect("uninstall_execute answers");

        assert!(!removal_called(p.dir()), "{name}: keep asked the engine");
        assert_eq!(report.schedule.outcome, SchedulerOutcome::Kept, "{name}");
        assert_eq!(
            report.settings,
            SettingsReport {
                asked: true,
                folder: Some(folder.display().to_string()),
                refused: Some(REFUSED_FOR_KEPT_SCHEDULER.to_string()),
                ..SettingsReport::default()
            },
            "{name}: keep refuses the settings leg too"
        );
        assert_eq!(tree(&folder), settings_before, "{name}: NOTHING of the settings removed");
        assert!(
            !p.f.app.state::<ConfigSaver>().settings_removed(),
            "{name}: a refused leg sets no latch"
        );
        assert_eq!(report.schedule.leftover, leftover, "{name}: {report:?}");
        assert_eq!(
            report.schedule.remove_steps.as_deref(),
            Some(FAKE_REMOVE_STEPS)
        );
        assert_eq!(
            report.engine_refused.as_deref(),
            Some(REFUSED_FOR_KEPT_SCHEDULER),
            "{name}: {report:?}"
        );
        assert_eq!(
            report.engine_state_dir.as_deref(),
            p.state.to_str(),
            "{name}: the refused leg still names its folder"
        );
        assert!(report.engine.is_empty() && !report.engine_state_removed);
        assert_eq!(tree(&p.state), before, "{name}: NOTHING of the engine's removed");
        // The other legs ran.
        assert_eq!(report.autostart, Outcome::Removed, "{name}");
        assert!(!p
            .f
            ._scratch
            .join("app-data")
            .join(APP_DATA_FILES[0])
            .exists());
    }
}

/// Spec 3.3.5.1, 3.7 "`keep`": with nothing detected `keep` refuses nothing — a check that ran and
/// found nothing is `absent`; one that could not run (`registered: null`, or the status unreadable)
/// with nothing on disk is `notChecked` (decision A, round-5 cap). The consented leg runs either
/// way, and the engine is never asked to remove anything.
#[tokio::test(flavor = "multi_thread")]
async fn keep_refuses_nothing_when_no_scheduler_is_detected() {
    for (name, schedule_answer, outcome, steps) in [
        (
            "a check that ran",
            view_answer(json!({})),
            SchedulerOutcome::Absent,
            Some(FAKE_REMOVE_STEPS),
        ),
        (
            "a check that could not run",
            view_answer(json!({ "registered": null, "registeredReason": "no-gui-session" })),
            SchedulerOutcome::NotChecked,
            Some(FAKE_REMOVE_STEPS),
        ),
        (
            "an unreadable status",
            exit_answer(3, "", "status exploded"),
            SchedulerOutcome::NotChecked,
            None,
        ),
    ] {
        let p = planted("uninstall-keep-nothing");
        script_answer(p.dir(), "schedule status", &schedule_answer);
        // T5.4's half: with nothing detected the settings leg is not refused either.
        let folder = plant_settings(p.dir());

        let report = execute_with(&p.f.app, true, Some(true), Some(SchedulerChoice::Keep))
            .await
            .expect("uninstall_execute answers");

        assert!(!removal_called(p.dir()), "{name}: keep asked the engine");
        assert_eq!(report.schedule.outcome, outcome, "{name}: {report:?}");
        assert_eq!(report.settings.refused, None, "{name}: {report:?}");
        assert_eq!(report.settings.removed, [SETTINGS_CONFIG], "{name}: {report:?}");
        assert!(!folder.exists(), "{name}: the leg ran: {report:?}");
        assert_eq!(report.schedule.remove_steps.as_deref(), steps, "{name}");
        assert_eq!(report.engine_refused, None, "{name}: {report:?}");
        assert!(report.engine_state_removed, "{name}: the leg ran: {report:?}");
        assert!(!p.state.join("briefing.log").exists(), "{name}");
        let wire = serde_json::to_value(&report).expect("JSON");
        assert_eq!(
            wire["schedule"],
            json!({
                "outcome": serde_json::to_value(outcome).expect("JSON"),
                "leftover": [],
                "leftoverCommands": [],
                "removeSteps": steps,
            }),
            "{name}: {wire}"
        );
    }
}

/// The new arguments on the wire (spec 3.3.2, 3.3.7): the three choices and four outcomes are
/// camelCase strings, the shapes `lib/app-uninstall.ts` mirrors; anything else is refused.
#[test]
fn the_scheduler_choice_and_outcome_are_camel_case_on_the_wire() {
    for (wire, choice) in [
        ("removeOwn", SchedulerChoice::RemoveOwn),
        ("removeAny", SchedulerChoice::RemoveAny),
        ("keep", SchedulerChoice::Keep),
    ] {
        assert_eq!(
            serde_json::from_value::<SchedulerChoice>(json!(wire)).expect("a choice"),
            choice
        );
    }
    assert!(serde_json::from_value::<SchedulerChoice>(json!("remove")).is_err());
    for (outcome, wire) in [
        (SchedulerOutcome::Removed, "removed"),
        (SchedulerOutcome::Absent, "absent"),
        (SchedulerOutcome::Kept, "kept"),
        (SchedulerOutcome::NotChecked, "notChecked"),
    ] {
        assert_eq!(serde_json::to_value(outcome).expect("JSON"), json!(wire));
    }
}

/// Spec 3.3.4.2, 3.7 "The settings lock" (its ordering; the leg waiting a save out is
/// `after_the_settings_leg_every_settings_write_refuses_and_uninstall_does_not`): with
/// `removeSettings`, `uninstall_execute` takes the save lock AFTER its reads and first look and
/// BEFORE the scheduler step — so before the gate look, and nothing is awaited between that look
/// and the legs. Driven against a save that holds the lock (its `status --json` read waits on a
/// flag): the uninstall reads, looks once, then waits — no removal asked, no gate look — and goes on
/// once the save is done. Without `removeSettings` it takes no lock and does not wait.
#[tokio::test(flavor = "multi_thread")]
async fn a_settings_removal_takes_the_save_lock_before_the_scheduler_step_and_the_gate_look() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("uninstall-lock-order");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    let dir = scratch.path.clone();
    // Counts the presence checks of the record — one per look; it never appears.
    let fs = Arc::new(AppearsFs {
        path: state.join(SCHEDULE_RECORD),
        appears_at: u32::MAX,
        checks: AtomicU32::new(0),
    });
    let app = app_with(
        status_sidecar(&dir, &state),
        &scratch,
        Arc::new(RecordingAutostartSink::default()),
        Some(fs.clone()),
    );

    // ── removeSettings: waits for the save.
    script_answer(&dir, "status --json", &hold_answer("save-held", true));
    let save = config_save(
        app.handle().clone(),
        app.state(),
        app.state(),
        "{}".into(),
        "base".into(),
    );
    let uninstall = async {
        wait_for(&dir.join("save-held")).await;
        let mut run = Box::pin(uninstall_execute(
            app.handle().clone(),
            app.state(),
            app.state(),
            app.state(),
            false,
            Some(true),
            None,
        ));
        // Step 1 runs: its two reads and its first look.
        for _ in 0..500 {
            if let Ok(done) = tokio::time::timeout(Duration::from_millis(20), &mut run).await {
                panic!("the uninstall finished while a save held the settings lock: {done:?}");
            }
            if engine_calls(&dir).iter().any(|c| c == "schedule status --json")
                && fs.checks.load(Ordering::SeqCst) == 1
            {
                break;
            }
        }
        assert_eq!(
            fs.checks.load(Ordering::SeqCst),
            1,
            "premise: the first look ran"
        );
        // …and then it waits for the lock.
        assert!(
            tokio::time::timeout(Duration::from_millis(400), &mut run)
                .await
                .is_err(),
            "the uninstall went on while a save held the settings lock"
        );
        assert!(
            !removal_called(&dir),
            "the scheduler step ran before the settings lock was taken: {:?}",
            engine_calls(&dir)
        );
        assert_eq!(
            fs.checks.load(Ordering::SeqCst),
            1,
            "the gate look ran before the settings lock was taken"
        );
        write(&dir.join("release"), "");
        run.await
    };
    let (saved, report) = tokio::join!(save, uninstall);
    assert!(saved.is_err(), "the save had no config to save over");
    let report = report.expect("uninstall_execute answers");
    assert_eq!(report.schedule.outcome, SchedulerOutcome::Absent);
    assert_eq!(fs.checks.load(Ordering::SeqCst), 2, "the gate look, once");
    assert_eq!(
        engine_calls(&dir),
        [
            "status --json", // the save's, held
            "status --json",
            "schedule status --json",
            REMOVE_OWN_CALL,
            // the save went on (its read answered) and found no config; the uninstall then ran
        ],
    );

    // ── no removeSettings: no lock, no wait. A fresh app (T5.4): the run above removed the settings
    // (its folder was absent, so its `config.json` step completed), which latches THIS app's saver,
    // and a latched save refuses before it reads the engine — it would never reach the held read.
    assert!(
        app.state::<ConfigSaver>().settings_removed(),
        "premise: the settings leg above set the latch"
    );
    let scratch = ScratchDir::new("uninstall-lock-order-none");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    let dir = scratch.path.clone();
    let app = app_with(
        status_sidecar(&dir, &state),
        &scratch,
        Arc::new(RecordingAutostartSink::default()),
        None,
    );
    script_answer(&dir, "status --json", &hold_answer("save-held-again", true));
    let save = config_save(
        app.handle().clone(),
        app.state(),
        app.state(),
        "{}".into(),
        "base".into(),
    );
    let uninstall = async {
        wait_for(&dir.join("save-held-again")).await;
        let report = tokio::time::timeout(Duration::from_secs(10), execute(&app, false, None))
            .await
            .expect("an uninstall that removes no settings must not wait for the save lock");
        write(&dir.join("release"), "");
        report
    };
    let (saved, report) = tokio::join!(save, uninstall);
    assert!(saved.is_err());
    assert_eq!(
        report.expect("answers").schedule.outcome,
        SchedulerOutcome::Absent
    );
}

/// Spec 3.3.4.2: the save lock, once taken, is HELD through the scheduler step (and so through the
/// gate look and the legs, which await nothing): a save started while the engine is removing the
/// scheduler does not even read the engine until the uninstall has returned. Catches a lock taken
/// and dropped at once (`let _ = lock().await`), which the ordering test above cannot see. Since
/// T5.4 the settings leg runs before the lock is let go (its folder is absent here, so its
/// `config.json` step completes and the latch is set, spec 3.5.3 step 6), so the queued save then
/// refuses with "Settings were removed by Uninstall." — still without ever reading the engine.
#[tokio::test(flavor = "multi_thread")]
async fn the_save_lock_is_held_through_the_scheduler_step() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("uninstall-lock-held");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    let dir = scratch.path.clone();
    let app = app_with(
        status_sidecar(&dir, &state),
        &scratch,
        Arc::new(RecordingAutostartSink::default()),
        None,
    );
    script_answer(
        &dir,
        "schedule uninstall",
        &format!(
            "{}{}",
            hold_answer("removing", false),
            exit_answer(0, "Removed the background scheduler.", "")
        ),
    );
    let uninstall = uninstall_execute(
        app.handle().clone(),
        app.state(),
        app.state(),
        app.state(),
        false,
        Some(true),
        None,
    );
    let save = async {
        wait_for(&dir.join("removing")).await;
        let mut save = Box::pin(config_save(
            app.handle().clone(),
            app.state(),
            app.state(),
            "{}".into(),
            "base".into(),
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(400), &mut save)
                .await
                .is_err(),
            "a save finished while the uninstall held the settings lock"
        );
        assert_eq!(
            engine_calls(&dir),
            ["status --json", "schedule status --json", REMOVE_OWN_CALL],
            "a save read the engine while the uninstall held the settings lock"
        );
        write(&dir.join("release"), "");
        save.await
    };
    let (report, saved) = tokio::join!(uninstall, save);
    assert_eq!(
        report.expect("answers").schedule.outcome,
        SchedulerOutcome::Removed
    );
    assert_eq!(
        saved,
        Err(SaveError::Unsupported {
            detail: SETTINGS_REMOVED_BY_UNINSTALL.into()
        }),
        "the queued save took the lock after the leg had latched"
    );
    assert_eq!(
        engine_calls(&dir),
        ["status --json", "schedule status --json", REMOVE_OWN_CALL],
        "the queued save refused before it read the engine"
    );
}

/// Spec 3.3.5.1: `keep`'s refusal counts a scheduler detected "in step 1 OR BY THE GATE LOOK". A
/// record that appears after the first look (on the gate look's check, the 2nd) is kept, and the
/// consented leg is refused with `REFUSED_FOR_KEPT_SCHEDULER` — which comes before the gate's own
/// `REFUSED_FOR_SCHEDULE` — and the report states the gate look's record.
#[tokio::test(flavor = "multi_thread")]
async fn keep_refuses_for_a_scheduler_only_the_gate_look_sees() {
    let scratch = ScratchDir::new("uninstall-keep-gate");
    let state = scratch.join("state");
    write(&state.join("briefing.log"), "log");
    let fs = Arc::new(AppearsFs {
        path: state.join(SCHEDULE_RECORD),
        appears_at: 2,
        checks: AtomicU32::new(0),
    });
    let app = app_with(
        status_sidecar(&scratch.path, &state),
        &scratch,
        Arc::new(RecordingAutostartSink::default()),
        Some(fs.clone()),
    );

    let report = execute(&app, true, Some(SchedulerChoice::Keep))
        .await
        .expect("uninstall_execute answers");

    assert_eq!(fs.checks.load(Ordering::SeqCst), 2, "a first look, then the gate look");
    assert!(!removal_called(&scratch.path), "keep asked the engine");
    assert_eq!(report.schedule.outcome, SchedulerOutcome::Kept, "{report:?}");
    assert_eq!(
        report.engine_refused.as_deref(),
        Some(REFUSED_FOR_KEPT_SCHEDULER),
        "{report:?}"
    );
    assert_eq!(report.schedule_record_present, Some(true), "{report:?}");
    assert_eq!(
        report.schedule.leftover,
        [state.join(SCHEDULE_RECORD).display().to_string()]
    );
    assert!(state.join("briefing.log").exists(), "nothing removed");
}

/* ── Batch 2: directory removal, the new sink methods and the Linux engine copies (spec 3.5) ─── */

/// THE LINUX COPIES ARE THE ENGINE'S (spec 3.5.2), in `the_unit_files_are_the_engines`' pattern:
/// `src/schedule/install.ts`'s `managedBinPath` is held to its two lines, and
/// `managed_engine_copies` answers for an unset `XDG_DATA_HOME` and for absolute ones. A value that
/// is NOT absolute is ignored, as the XDG base-directory spec requires, so a relative one can never
/// point the removal at the app's working folder. macOS has no candidates (spec question SQ5: its
/// copy is the state dir's `daily-briefing`, on the bounded list), and neither does Windows.
#[test]
fn the_managed_engine_copies_are_the_engines() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR"));
    let install =
        std::fs::read_to_string(root.join(ENGINE_INSTALL_TS)).expect("install.ts is readable");
    for spelling in [
        r#"const data = env.XDG_DATA_HOME ?? join(home, ".local", "share");"#,
        r#"return join(data, "daily-briefing", "bin", "daily-briefing");"#,
    ] {
        assert!(
            install.contains(spelling),
            "install.ts's managedBinPath no longer reads {spelling:?} — managed_engine_copies \
             mirrors it"
        );
    }

    let home = Path::new("/h");
    let default = PathBuf::from("/h/.local/share/daily-briefing/bin/daily-briefing");
    assert_eq!(managed_engine_copies("linux", home, None), [default.clone()]);
    assert_eq!(
        managed_engine_copies("linux", home, Some(Path::new("/x"))),
        [
            default.clone(),
            PathBuf::from("/x/daily-briefing/bin/daily-briefing")
        ],
        "an absolute XDG_DATA_HOME is looked under as well — the engine's own pick when set"
    );
    assert_eq!(
        managed_engine_copies("linux", home, Some(Path::new("/h/.local/share"))),
        [default.clone()],
        "the default spelled out is not looked at twice"
    );
    for relative in ["", "x", "./data", "relative/data", "~/data"] {
        assert_eq!(
            managed_engine_copies("linux", home, Some(Path::new(relative))),
            [default.clone()],
            "{relative:?} is not absolute, so it is ignored"
        );
    }
    assert!(managed_engine_copies("macos", home, None).is_empty());
    assert!(managed_engine_copies("macos", home, Some(Path::new("/x"))).is_empty());
    assert!(managed_engine_copies("windows", home, None).is_empty());
}

/// `remove_empty_dir` NEVER RECURSES (spec 3.5.4, 3.7 "Directory removal"): a folder with anything
/// in it is refused and keeps everything, a file is not a folder, a link to an empty folder removes
/// neither, and only an empty folder goes.
#[test]
fn remove_empty_dir_is_non_recursive() {
    let scratch = ScratchDir::new("uninstall-rmdir");
    let full = scratch.join("full");
    write(&full.join("inner").join("kept.txt"), "kept");
    assert!(
        SystemFs.remove_empty_dir(&full).is_err(),
        "a folder with something in it must be refused"
    );
    assert!(full.join("inner").join("kept.txt").exists());

    let file = scratch.join("a-file");
    write(&file, "x");
    assert!(SystemFs.remove_empty_dir(&file).is_err(), "a file is not a folder");
    assert!(file.exists());

    #[cfg(unix)]
    {
        let target = scratch.join("empty-target");
        std::fs::create_dir_all(&target).expect("an empty folder");
        let link = scratch.join("link-to-empty");
        std::os::unix::fs::symlink(&target, &link).expect("a link to it");
        assert!(
            SystemFs.remove_empty_dir(&link).is_err(),
            "a link is not a folder, even to an empty one"
        );
        assert!(target.exists() && std::fs::symlink_metadata(&link).is_ok());
    }

    let empty = scratch.join("empty");
    std::fs::create_dir_all(&empty).expect("an empty folder");
    SystemFs
        .remove_empty_dir(&empty)
        .expect("an empty folder is removed");
    assert!(!empty.exists());
    assert_eq!(
        SystemFs.remove_empty_dir(&empty).map_err(|e| e.kind()),
        Err(std::io::ErrorKind::NotFound)
    );
}

/// `provider-cwd` AS A SYMLINK IS REMOVED WITHOUT FOLLOWING IT (spec 3.5.1, 3.7 "Directory
/// removal"): it is an `EntryKind::Dir` entry, removed the way `briefings` is, and
/// `remove_dir_all` on a top-level symlink unlinks the link itself — what it points at is
/// untouched.
#[cfg(unix)]
#[test]
fn a_provider_cwd_symlink_is_removed_without_following_it() {
    let scratch = ScratchDir::new("uninstall-provider-cwd-link");
    let state = scratch.join("state");
    let outside = scratch.join("outside");
    write(&outside.join("not-the-engines.txt"), "keep me");
    std::fs::create_dir_all(&state).expect("state dir");
    std::os::unix::fs::symlink(&outside, state.join("provider-cwd")).expect("a linked cwd");

    let report =
        remove_engine_state(&SystemFs, &state, &[]).expect("no schedule record: the leg runs");

    assert_eq!(outcome_of(&report, "provider-cwd"), &Outcome::Removed);
    assert!(
        std::fs::symlink_metadata(state.join("provider-cwd")).is_err(),
        "the link itself must be gone"
    );
    assert!(
        outside.join("not-the-engines.txt").exists(),
        "what the link pointed at must be untouched"
    );
}

/// The sink's new reads (spec 3.5.4), on the real filesystem: `kind` is an `lstat` — the entry's
/// own type, owner, identity, link count and, for a symlink, its target text, never its target's —
/// `canonicalize` resolves, and `read_small` reads a small regular file and refuses a link, a
/// folder, an oversized file and a missing one.
#[cfg(unix)]
#[test]
fn the_sinks_new_reads_are_lstats_and_never_follow() {
    use std::os::unix::fs::MetadataExt;
    let scratch = ScratchDir::new("uninstall-kind");
    let file = scratch.join("file");
    write(&file, r#"{"a":1}"#);
    let dir = scratch.join("dir");
    std::fs::create_dir_all(&dir).expect("a folder");
    let link = scratch.join("link");
    std::os::unix::fs::symlink(&file, &link).expect("a link");
    let meta = std::fs::metadata(&file).expect("stat");

    let stat = SystemFs.kind(&file).expect("lstat a file");
    assert_eq!(stat.kind, LstatKind::File);
    assert_eq!(stat.uid, Some(meta.uid()));
    assert_eq!(stat.id, Some((meta.dev(), meta.ino())));
    assert_eq!(stat.links, Some(1));
    assert_eq!(stat.link_target, None);

    std::fs::hard_link(&file, scratch.join("hard")).expect("a hard link");
    let hard = SystemFs.kind(&scratch.join("hard")).expect("lstat a hard link");
    assert_eq!(hard.id, stat.id, "the same file by identity");
    assert_eq!(hard.links, Some(2));

    let linked = SystemFs.kind(&link).expect("lstat a link");
    assert_eq!(linked.kind, LstatKind::Symlink);
    assert_eq!(linked.link_target.as_deref(), Some(file.as_path()));
    assert_ne!(linked.id, stat.id, "the link's own lstat, never its target's");

    assert_eq!(SystemFs.kind(&dir).expect("lstat a folder").kind, LstatKind::Dir);
    assert_eq!(
        SystemFs
            .kind(&scratch.join("nothing"))
            .map(|_| ())
            .map_err(|e| e.kind()),
        Err(std::io::ErrorKind::NotFound)
    );

    assert_eq!(
        SystemFs.canonicalize(&link).expect("resolves"),
        std::fs::canonicalize(&file).expect("resolves")
    );
    assert_eq!(SystemFs.read_small(&file, 1024), Ok(r#"{"a":1}"#.to_string()));
    assert_eq!(SystemFs.read_small(&link, 1024), Err(ReadRefusal::Symlink));
    assert_eq!(SystemFs.read_small(&dir, 1024), Err(ReadRefusal::NotAFile));
    assert!(matches!(
        SystemFs.read_small(&file, 3),
        Err(ReadRefusal::TooLarge { .. })
    ));
    assert_eq!(
        SystemFs.read_small(&scratch.join("nothing"), 1024),
        Err(ReadRefusal::NotFound)
    );
}

/// The Linux engine copy under `home` (no `XDG_DATA_HOME`), as `managed_engine_copies` names it.
fn linux_copy(home: &Path) -> PathBuf {
    managed_engine_copies("linux", home, None)
        .into_iter()
        .next()
        .expect("linux has a copy")
}

/// How the report shows the default Linux copy: `~` for home (spec 3.3.7).
const LINUX_COPY_SHOWN: &str = "~/.local/share/daily-briefing/bin/daily-briefing";

/// THE LINUX COPY'S OWNERSHIP CHECKS (spec 3.5.2, 3.7 "Linux engine-copy candidates"), on the real
/// filesystem under a scratch home. When the engine-data step runs, a copy is removed only if
/// `daily-briefing/` and `bin/` are real folders, not links, the copy is a file or a link, and all
/// three are this user's; then `bin/` and `daily-briefing/` go only if empty (`remove_empty_dir`).
/// Otherwise the copy is kept and the report says why, and nothing outside the copy's two folders
/// is touched. When the step does not run, a copy that is there is kept with the given reason.
#[cfg(unix)]
#[test]
fn a_linux_engine_copy_goes_only_when_it_and_its_folders_are_this_users() {
    use std::os::unix::fs::MetadataExt;
    let leg = |home: &Path, uid: u32, kept_because: Option<&str>| -> PathReport {
        let mut reports = engine_copy_leg(
            &SystemFs,
            &[linux_copy(home)],
            home,
            Some(uid),
            kept_because,
        );
        assert_eq!(reports.len(), 1, "one candidate, one line: {reports:?}");
        reports.remove(0)
    };
    let fresh = |tag: &str| -> (ScratchDir, PathBuf, u32) {
        let scratch = ScratchDir::new(tag);
        let home = scratch.join("home");
        std::fs::create_dir_all(home.join(".local").join("share")).expect("a data root");
        let uid = std::fs::metadata(&home).expect("stat").uid();
        (scratch, home, uid)
    };

    // ── A plain copy: removed, and its two folders with it, now empty; the data root stays.
    let (_s, home, uid) = fresh("uninstall-copy-plain");
    let copy = linux_copy(&home);
    write(&copy, "#!/bin/sh\n");
    let report = leg(&home, uid, None);
    assert_eq!(
        report,
        PathReport {
            path: LINUX_COPY_SHOWN.to_string(),
            outcome: PathOutcome::Removed,
            reason: None,
        }
    );
    let folder = home.join(".local/share/daily-briefing");
    assert!(!copy.exists() && !folder.exists(), "the copy and its empty folders go");
    assert!(home.join(".local/share").exists(), "the data root itself stays");

    // ── Something else in `bin/`: the copy goes, the folders stay (never a recursive delete).
    let (_s, home, uid) = fresh("uninstall-copy-neighbour");
    let copy = linux_copy(&home);
    write(&copy, "#!/bin/sh\n");
    let neighbour = copy.with_file_name("somebody-elses-tool");
    write(&neighbour, "keep");
    assert_eq!(leg(&home, uid, None).outcome, PathOutcome::Removed);
    assert!(
        !copy.exists() && neighbour.exists(),
        "only the copy goes; `bin/` and `daily-briefing/` stay, not empty"
    );

    // ── The copy is a link: the link goes, never what it points at.
    let (s, home, uid) = fresh("uninstall-copy-link");
    let copy = linux_copy(&home);
    let target = s.join("elsewhere").join("daily-briefing");
    write(&target, "#!/bin/sh\n");
    std::fs::create_dir_all(copy.parent().expect("bin")).expect("bin");
    std::os::unix::fs::symlink(&target, &copy).expect("a linked copy");
    assert_eq!(leg(&home, uid, None).outcome, PathOutcome::Removed);
    assert!(std::fs::symlink_metadata(&copy).is_err() && target.exists());

    // ── A symlinked `bin/`, then a symlinked `daily-briefing/`: kept, and the real files behind
    // the links untouched.
    for linked in ["bin", "daily-briefing"] {
        let (s, home, uid) = fresh("uninstall-copy-linked-folder");
        let copy = linux_copy(&home);
        let bin = copy.parent().expect("bin").to_path_buf();
        let link = match linked {
            "bin" => bin.clone(),
            _ => bin.parent().expect("daily-briefing/").to_path_buf(),
        };
        // The real folder the link points at, holding what the copy's path names below the link.
        let real = s.join("real");
        let real_copy = real.join(copy.strip_prefix(&link).expect("the copy is below the link"));
        write(&real_copy, "#!/bin/sh\n");
        std::fs::create_dir_all(link.parent().expect("a parent")).expect("parent");
        std::os::unix::fs::symlink(&real, &link).expect("a linked folder");
        let report = leg(&home, uid, None);
        assert_eq!(report.outcome, PathOutcome::Kept, "{linked}: {report:?}");
        assert!(
            report.reason.as_deref().is_some_and(|r| r.contains("link")),
            "{linked}: the report says why: {report:?}"
        );
        assert!(copy.exists() && real_copy.exists(), "{linked}: nothing removed");
    }

    // ── The copy is a folder: kept.
    let (_s, home, uid) = fresh("uninstall-copy-is-a-folder");
    let copy = linux_copy(&home);
    write(&copy.join("inside"), "x");
    let report = leg(&home, uid, None);
    assert_eq!(report.outcome, PathOutcome::Kept, "{report:?}");
    assert!(copy.join("inside").exists());

    // ── Another user's copy (a shared, writable data root): kept — unlink permission comes from
    // the folder, so this check is what stops it. Driven by naming another uid as "this" one.
    let (_s, home, uid) = fresh("uninstall-copy-other-uid");
    let copy = linux_copy(&home);
    write(&copy, "#!/bin/sh\n");
    let report = leg(&home, uid.wrapping_add(1), None);
    assert_eq!(report.outcome, PathOutcome::Kept, "{report:?}");
    assert!(
        report
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("another user")),
        "{report:?}"
    );
    assert!(copy.exists(), "another user's copy must survive");

    // ── No copy: absent.
    let (_s, home, uid) = fresh("uninstall-copy-absent");
    assert_eq!(
        leg(&home, uid, None),
        PathReport {
            path: LINUX_COPY_SHOWN.to_string(),
            outcome: PathOutcome::Absent,
            reason: None,
        }
    );

    // ── The step does not run: a copy that is there is kept with the given reason, untouched; one
    // that is not is still absent.
    let (_s, home, uid) = fresh("uninstall-copy-not-asked");
    let copy = linux_copy(&home);
    write(&copy, "#!/bin/sh\n");
    assert_eq!(
        leg(&home, uid, Some(COPY_NOT_ASKED)),
        PathReport {
            path: LINUX_COPY_SHOWN.to_string(),
            outcome: PathOutcome::Kept,
            reason: Some("not asked".to_string()),
        }
    );
    assert!(copy.exists(), "a copy nobody asked to remove stays");
    std::fs::remove_file(&copy).expect("remove the plant");
    assert_eq!(
        leg(&home, uid, Some(COPY_NOT_ASKED)).outcome,
        PathOutcome::Absent
    );
    assert!(
        copy.parent().expect("bin").exists(),
        "a step that does not run tidies no folder either"
    );
}

/// EACH OF THE THREE OWNERSHIP CHECKS HOLDS ON ITS OWN (spec 3.5.2; checkpoint M5b F1). The
/// other-user case above names another uid as "this" one, so the copy, `bin/` and `daily-briefing/`
/// all mismatch at once and one surviving check is enough to keep the copy. Here a sink reports
/// another uid for exactly ONE of the three, the other two this user's: the copy is kept, the
/// reason names that one entry as another user's, and nothing at all is removed — no unlink, no
/// folder tidy. The control — the other uid on the data root above them, which is not one of the
/// three — still removes the copy, so the sink keeps nothing by itself.
#[cfg(unix)]
#[test]
fn a_linux_engine_copy_is_kept_when_any_one_of_the_three_is_another_users() {
    use std::os::unix::fs::MetadataExt;
    for one in ["the copy", "bin/", "daily-briefing/", "control"] {
        let scratch = ScratchDir::new("uninstall-copy-one-foreign");
        let home = scratch.join("home");
        let copy = linux_copy(&home);
        write(&copy, "#!/bin/sh\n");
        let bin = copy.parent().expect("bin/").to_path_buf();
        let folder = bin.parent().expect("daily-briefing/").to_path_buf();
        let foreign = match one {
            "the copy" => copy.clone(),
            "bin/" => bin.clone(),
            "daily-briefing/" => folder.clone(),
            _ => folder.parent().expect("the data root").to_path_buf(),
        };
        let uid = std::fs::metadata(&copy).expect("stat").uid();
        for owned in [&copy, &bin, &folder] {
            assert_eq!(
                std::fs::symlink_metadata(owned).expect("stat").uid(),
                uid,
                "premise: all three are really this user's"
            );
        }
        let fs = SettingsFs {
            foreign: Some(foreign.clone()),
            ..SettingsFs::default()
        };

        let reports = engine_copy_leg(&fs, &[copy.clone()], &home, Some(uid), None);

        if one == "control" {
            assert_eq!(
                reports,
                [PathReport {
                    path: LINUX_COPY_SHOWN.to_string(),
                    outcome: PathOutcome::Removed,
                    reason: None,
                }],
                "control"
            );
            assert!(
                !copy.exists() && !folder.exists(),
                "control: the copy and its folders go"
            );
            continue;
        }
        let named = format!(
            "~/{}",
            foreign
                .strip_prefix(&home)
                .expect("under the scratch home")
                .display()
        );
        assert_eq!(
            reports,
            [PathReport {
                path: LINUX_COPY_SHOWN.to_string(),
                outcome: PathOutcome::Kept,
                reason: Some(format!("{named} belongs to another user")),
            }],
            "{one} is another user's"
        );
        assert!(
            fs.removals().is_empty(),
            "{one}: nothing removed: {:?}",
            fs.removals()
        );
        assert!(
            copy.exists() && bin.exists() && folder.exists(),
            "{one}: the copy and both folders stay"
        );
    }
}

/// A COPY THAT IS NOT THERE TIDIES NO FOLDER, even when the step runs (spec 3.5.2: `bin/` and
/// `daily-briefing/` are removed only if empty AFTER the copy is removed; checkpoint M5b F6). An
/// empty `daily-briefing/bin/`, this user's, with no copy in it: the copy is `absent`, and both
/// folders stay — nothing is removed at all. (Unix: off it no uid is known, so no folder could be
/// tidied anyway, and this would pass for the wrong reason.)
#[cfg(unix)]
#[test]
fn an_absent_copy_tidies_no_folder_when_the_step_runs() {
    use std::os::unix::fs::MetadataExt;
    let scratch = ScratchDir::new("uninstall-copy-absent-folders");
    let home = scratch.join("home");
    let copy = linux_copy(&home);
    let bin = copy.parent().expect("bin/").to_path_buf();
    let folder = bin.parent().expect("daily-briefing/").to_path_buf();
    std::fs::create_dir_all(&bin).expect("an empty daily-briefing/bin/");
    let uid = std::fs::metadata(&bin).expect("stat").uid();
    assert_eq!(
        std::fs::metadata(&folder).expect("stat").uid(),
        uid,
        "premise: both folders are this user's, so only the rule keeps them"
    );
    let fs = SettingsFs::default();

    let reports = engine_copy_leg(&fs, &[copy.clone()], &home, Some(uid), None);

    assert_eq!(
        reports,
        [PathReport {
            path: LINUX_COPY_SHOWN.to_string(),
            outcome: PathOutcome::Absent,
            reason: None,
        }]
    );
    assert!(
        fs.removals().is_empty(),
        "nothing removed: {:?}",
        fs.removals()
    );
    assert!(bin.is_dir() && folder.is_dir(), "both empty folders stay");
}

/// A fixture whose uninstall state looks at `copies` — Linux-shaped paths under the scratch home —
/// as its engine copies, whatever this platform is, so the wiring of spec 3.5.2 is driven here on
/// macOS too. Everything else is [`fixture`]'s.
fn fixture_with_copies(scratch: ScratchDir, program: PathBuf, copies: Vec<PathBuf>) -> Fixture {
    let autostart = Arc::new(RecordingAutostartSink::default());
    let app = app_managing(
        Engine(Ok(EngineClient::with_program(program))),
        &scratch,
        autostart.clone(),
        scratch_uninstall_state(&scratch).with_engine_copies(copies),
    );
    Fixture {
        app,
        autostart,
        _scratch: scratch,
    }
}

/// RUST ALWAYS LOOKS AT THE COPIES, AND REMOVES THEM ONLY WHEN THE ENGINE-DATA STEP RUNS (spec
/// 3.5.2, 3.7), over the command: unticked, it is kept with "not asked"; refused — a kept
/// scheduler, or the gate look's record — it is kept with the refusal's own text, because a kept
/// scheduler may still run that binary; with the state folder unknown, it is kept with the
/// engine's error; and only a consented, unrefused step with a known folder removes it. The copy is
/// a real file under the scratch home throughout; `engineCopies` carries the one line, `~` for
/// home.
#[tokio::test(flavor = "multi_thread")]
async fn the_engine_copies_are_kept_unless_the_engine_data_step_runs() {
    let _turn = serialise().await;
    let planted = |tag: &str| -> (ScratchDir, PathBuf, PathBuf) {
        let scratch = ScratchDir::new(tag);
        let state = scratch.join("state");
        write(&state.join("briefing.log"), "log");
        let copy = linux_copy(&scratch.join("home"));
        write(&copy, "#!/bin/sh\n");
        (scratch, state, copy)
    };
    let line = |report: &UninstallReport| -> PathReport {
        assert_eq!(report.engine_copies.len(), 1, "{report:?}");
        report.engine_copies[0].clone()
    };

    // ── Unticked: kept, "not asked".
    let (scratch, state, copy) = planted("uninstall-copies-unticked");
    let program = status_sidecar(&scratch.path, &state);
    let f = fixture_with_copies(scratch, program, vec![copy.clone()]);
    let report = execute(&f.app, false, None).await.expect("answers");
    assert_eq!(
        line(&report),
        PathReport {
            path: LINUX_COPY_SHOWN.to_string(),
            outcome: PathOutcome::Kept,
            reason: Some(COPY_NOT_ASKED.to_string()),
        }
    );
    assert!(copy.exists(), "unticked: the copy stays");
    let wire = serde_json::to_value(&report).expect("JSON");
    assert_eq!(
        wire["engineCopies"],
        json!([{ "path": LINUX_COPY_SHOWN, "outcome": "kept", "reason": "not asked" }]),
        "{wire}"
    );

    // ── `keep` with a scheduler detected: the step is refused, so the copy is kept with that text.
    let (scratch, state, copy) = planted("uninstall-copies-kept-scheduler");
    let program = status_sidecar(&scratch.path, &state);
    script_answer(
        &scratch.path,
        "schedule status",
        &view_answer(json!({ "registered": true })),
    );
    let f = fixture_with_copies(scratch, program, vec![copy.clone()]);
    let report = execute(&f.app, true, Some(SchedulerChoice::Keep))
        .await
        .expect("answers");
    assert_eq!(
        report.engine_refused.as_deref(),
        Some(REFUSED_FOR_KEPT_SCHEDULER)
    );
    assert_eq!(line(&report).outcome, PathOutcome::Kept, "{report:?}");
    assert_eq!(
        line(&report).reason.as_deref(),
        Some(REFUSED_FOR_KEPT_SCHEDULER)
    );
    assert!(copy.exists(), "a kept scheduler may still run it: the copy stays");

    // ── The gate look's record refuses the step: kept, with that refusal.
    let (scratch, state, copy) = planted("uninstall-copies-record");
    write(&state.join(SCHEDULE_RECORD), r#"{"owner":"cli"}"#);
    let program = status_sidecar(&scratch.path, &state);
    script_answer(
        &scratch.path,
        "schedule uninstall",
        &exit_answer(0, "Removed the background scheduler.", ""),
    );
    let f = fixture_with_copies(scratch, program, vec![copy.clone()]);
    let report = execute(&f.app, true, Some(SchedulerChoice::RemoveAny))
        .await
        .expect("answers");
    assert_eq!(report.engine_refused.as_deref(), Some(REFUSED_FOR_SCHEDULE));
    assert_eq!(line(&report).outcome, PathOutcome::Kept, "{report:?}");
    assert_eq!(line(&report).reason.as_deref(), Some(REFUSED_FOR_SCHEDULE));
    assert!(copy.exists());

    // ── The state folder unknown (the engine answers nothing): kept, with the engine's error.
    let (scratch, _state, copy) = planted("uninstall-copies-no-state");
    let program = fake_sidecar(&scratch.path, "engine.sh", "exit 2");
    let f = fixture_with_copies(scratch, program, vec![copy.clone()]);
    let report = execute(&f.app, true, Some(SchedulerChoice::Keep))
        .await
        .expect("answers");
    let error = report.engine_error.clone().expect("the folder is unknown");
    assert_eq!(report.engine_refused, None, "nothing detected: {report:?}");
    assert_eq!(line(&report).outcome, PathOutcome::Kept, "{report:?}");
    assert_eq!(line(&report).reason, Some(error));
    assert!(copy.exists());

    // ── Consented, nothing refused, the folder known: the copy and its empty folders go.
    let (scratch, state, copy) = planted("uninstall-copies-removed");
    let program = status_sidecar(&scratch.path, &state);
    let f = fixture_with_copies(scratch, program, vec![copy.clone()]);
    let report = execute(&f.app, true, None).await.expect("answers");
    assert!(report.engine_state_removed, "the step ran: {report:?}");
    assert_eq!(
        line(&report),
        PathReport {
            path: LINUX_COPY_SHOWN.to_string(),
            outcome: PathOutcome::Removed,
            reason: None,
        }
    );
    assert!(!copy.exists());
    assert!(!f
        ._scratch
        .join("home")
        .join(".local/share/daily-briefing")
        .exists());
}

/// `engineCopies` IS ALWAYS ON THE REPORT (spec 3.3.7), as an array — this platform's own
/// candidates under the scratch home: none on macOS (spec question SQ5), so `[]`; on Linux the
/// `~/.local/share` copy, `absent` here because nothing is planted.
#[tokio::test(flavor = "multi_thread")]
async fn engine_copies_are_always_on_the_report() {
    let _turn = serialise().await;
    let f = fixture(
        ScratchDir::new("uninstall-copies-default"),
        Arc::new(RecordingAutostartSink::default()),
    );
    let report = execute(&f.app, true, None).await.expect("answers");
    let expected: Vec<PathReport> =
        managed_engine_copies(std::env::consts::OS, &f._scratch.join("home"), None)
            .iter()
            .map(|_| PathReport {
                path: LINUX_COPY_SHOWN.to_string(),
                outcome: PathOutcome::Absent,
                reason: None,
            })
            .collect();
    assert_eq!(report.engine_copies, expected, "{report:?}");
    let wire = serde_json::to_value(&report).expect("JSON");
    assert!(wire["engineCopies"].is_array(), "{wire}");
    #[cfg(target_os = "macos")]
    assert_eq!(wire["engineCopies"], json!([]), "SQ5: no copy outside the state dir on macOS");
}

/* ── Batch 2: the settings leg and the latch (spec 3.5.3, 3.7 "Key-file and settings safety") ─── */

// ⚠ EVERY SETTINGS FOLDER HERE IS UNDER THE TEST'S OWN `ScratchDir`. The leg is driven directly
// (`settings_leg`) with a config path AND a home under the scratch, or through `uninstall_execute`,
// whose fake engine reports a `configPath` in a `settings` folder of its own under the same scratch
// (`status_sidecar`), with the scratch home of `scratch_uninstall_state`. A `~` in a key path
// expands against that SCRATCH home. The developer's real settings folder — their config and API
// key file — is never named, resolved or touched here.

/// A config whose `provider.api.apiKeyFile` is `key`, as people write it.
fn naming(key: &str) -> String {
    json!({ "provider": { "api": { "kind": "anthropic", "model": "m", "apiKeyFile": key } } })
        .to_string()
}

/// `<dir>/settings` — the folder [`status_sidecar`]'s `configPath` names — planted with a
/// `config.json` naming an `api-key` beside it, and that key file. Returns the folder.
fn plant_settings(dir: &Path) -> PathBuf {
    let folder = dir.join("settings");
    let key = folder.join("api-key");
    write(&key, "sk-test-not-a-real-key");
    write(&folder.join(SETTINGS_CONFIG), &naming(&shown(&key)));
    folder
}

fn shown(path: &Path) -> String {
    path.display().to_string()
}

/// What `uninstall_execute`'s three settings writes answer once the latch is set.
fn latched<T>() -> Result<T, SaveError> {
    Err(SaveError::Unsupported {
        detail: SETTINGS_REMOVED_BY_UNINSTALL.into(),
    })
}

/// A settings leg's world, all under one `ScratchDir`: a scratch home, and under it the folder the
/// engine's `configPath` names, `<home>/.config/daily-briefing`.
struct Settings {
    scratch: ScratchDir,
    home: PathBuf,
    folder: PathBuf,
}

fn settings(tag: &str) -> Settings {
    let scratch = ScratchDir::new(tag);
    let home = scratch.join("home");
    let folder = home.join(".config").join("daily-briefing");
    std::fs::create_dir_all(&folder).expect("a settings folder");
    Settings {
        scratch,
        home,
        folder,
    }
}

impl Settings {
    fn config(&self) -> PathBuf {
        self.folder.join(SETTINGS_CONFIG)
    }
    fn bak(&self) -> PathBuf {
        self.folder.join(SETTINGS_BACKUP)
    }
    fn key(&self) -> PathBuf {
        self.folder.join("api-key")
    }
    /// A path OUTSIDE the settings folder, still under the scratch.
    fn elsewhere(&self, name: &str) -> PathBuf {
        self.scratch.join("elsewhere").join(name)
    }
    fn shown_folder(&self) -> Option<String> {
        Some(shown(&self.folder))
    }
    /// The leg over this folder, then the check that it reached nothing outside it.
    fn run(&self, fs: &SettingsFs) -> (SettingsReport, bool) {
        let (report, latch) = settings_leg(fs, &self.config(), &self.home);
        fs.assert_inside(&self.folder);
        (report, latch)
    }
}

/// The real filesystem for the settings leg's tests (and the Linux copy's one-foreign-owner and
/// absent-copy tests), LOGGING every removal it is asked for, with three knobs: `fold_case`
/// lower-cases each path's last component first — a case-insensitive volume, on any platform
/// (`CONFIG.JSON.BAK` then IS `config.json.bak`, by identity) — `refuse` is a path whose
/// `remove_file` fails, EPERM-shaped, and `foreign` is a path whose `lstat` (`kind`) reports
/// ANOTHER uid, the real owner's + 1, so exactly one entry is someone else's while everything
/// around it is this user's.
#[derive(Default)]
struct SettingsFs {
    fold_case: bool,
    refuse: Option<PathBuf>,
    foreign: Option<PathBuf>,
    removals: std::sync::Mutex<Vec<(&'static str, PathBuf)>>,
}

impl SettingsFs {
    fn fold(&self, path: &Path) -> PathBuf {
        match path.file_name() {
            Some(name) if self.fold_case => {
                path.with_file_name(name.to_string_lossy().to_lowercase())
            }
            _ => path.to_path_buf(),
        }
    }
    fn log(&self, op: &'static str, path: &Path) {
        self.removals
            .lock()
            .expect("log")
            .push((op, path.to_path_buf()));
    }
    fn removals(&self) -> Vec<(&'static str, PathBuf)> {
        self.removals.lock().expect("log").clone()
    }
    /// ⚠ THE LEG'S WHOLE REACH: every removal it asked for is a direct child of the settings folder
    /// (`remove_file`), or the folder itself through the NON-recursive `remove_empty_dir` — never
    /// anything else, and never a recursive removal.
    fn assert_inside(&self, folder: &Path) {
        for (op, path) in self.removals() {
            match op {
                "file" => assert_eq!(
                    path.parent(),
                    Some(folder),
                    "a removal outside the settings folder: {}",
                    path.display()
                ),
                "empty_dir" => assert_eq!(path, folder, "a folder removal of another folder"),
                other => panic!(
                    "the settings leg asked for a {other} removal of {}",
                    path.display()
                ),
            }
        }
    }
}

impl UninstallFs for SettingsFs {
    fn exists(&self, path: &Path) -> bool {
        SystemFs.exists(&self.fold(path))
    }
    fn remove_file(&self, path: &Path) -> std::io::Result<()> {
        self.log("file", path);
        if self.refuse.as_deref() == Some(path) {
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                format!("refused: {}", path.display()),
            ));
        }
        SystemFs.remove_file(&self.fold(path))
    }
    fn remove_dir_all(&self, path: &Path) -> std::io::Result<()> {
        self.log("dir_all", path);
        SystemFs.remove_dir_all(&self.fold(path))
    }
    fn list_dir(&self, dir: &Path) -> std::io::Result<Vec<String>> {
        SystemFs.list_dir(dir)
    }
    fn kind(&self, path: &Path) -> std::io::Result<Lstat> {
        let mut stat = SystemFs.kind(&self.fold(path))?;
        if self.foreign.as_deref() == Some(path) {
            stat.uid = stat.uid.map(|uid| uid.wrapping_add(1));
        }
        Ok(stat)
    }
    fn canonicalize(&self, path: &Path) -> std::io::Result<PathBuf> {
        SystemFs.canonicalize(&self.fold(path))
    }
    fn read_small(&self, path: &Path, max_bytes: u64) -> Result<String, ReadRefusal> {
        SystemFs.read_small(&self.fold(path), max_bytes)
    }
    fn remove_empty_dir(&self, path: &Path) -> std::io::Result<()> {
        self.log("empty_dir", path);
        SystemFs.remove_empty_dir(&self.fold(path))
    }
}

/// Spec 3.5.3 steps 1-5, IN ORDER, on a plain folder: the key file `config.json` names (by `~`,
/// expanded against the scratch home) and `config.json.bak` names again (by its absolute path: one
/// file, one line) goes FIRST, then `config.json`, then `config.json.bak`, then the folder — now
/// empty — with the non-recursive remove; its parent stays. Step 3 completed: the latch is due.
#[test]
fn the_settings_leg_removes_the_key_first_then_both_configs_then_the_empty_folder() {
    let s = settings("settings-plain");
    write(&s.key(), "sk-test");
    write(&s.config(), &naming("~/.config/daily-briefing/api-key"));
    write(&s.bak(), &naming(&shown(&s.key())));
    let fs = SettingsFs::default();

    let (report, latch) = s.run(&fs);

    assert_eq!(
        report,
        SettingsReport {
            asked: true,
            folder: s.shown_folder(),
            key_files: vec![PathReport {
                path: shown(&s.key()),
                outcome: PathOutcome::Removed,
                reason: None,
            }],
            removed: vec![SETTINGS_CONFIG.into(), SETTINGS_BACKUP.into()],
            ..SettingsReport::default()
        }
    );
    assert!(latch, "step 3 completed: the latch is due");
    assert_eq!(
        fs.removals(),
        [
            ("file", s.key()),
            ("file", s.config()),
            ("file", s.bak()),
            ("empty_dir", s.folder.clone()),
        ],
        "keys first, then config.json, then config.json.bak, then the folder"
    );
    assert!(!s.folder.exists(), "the empty folder goes");
    assert!(s.home.join(".config").exists(), "its parent stays");
}

/// Spec 3.5.3 step 2's conditions, each on its own folder: a key file is removed only when its path
/// is absolute, its folder IS the settings folder (by identity, after `canonicalize`) and an `lstat`
/// shows a regular file. A link (and what it points at), a file outside the folder — also one in a
/// sibling folder whose NAME starts like it — a relative path (with spec 3.5.3's own reason) and a
/// folder are kept, each saying why; a key file already gone is `absent`; a key named only by
/// `config.json.bak` is still found and removed.
#[cfg(unix)]
#[test]
fn a_key_file_goes_only_from_the_folder_by_identity_and_only_as_a_regular_file() {
    let kept = |report: &SettingsReport, path: &Path, why: &str| {
        assert_eq!(report.key_files.len(), 1, "{report:?}");
        let line = &report.key_files[0];
        assert_eq!(
            (line.path.as_str(), line.outcome),
            (shown(path).as_str(), PathOutcome::Kept),
            "{report:?}"
        );
        assert!(
            line.reason.as_deref().is_some_and(|r| r.contains(why)),
            "the reason says why ({why}): {report:?}"
        );
    };

    // ── A link in the folder: kept; the link and what it points at both stay.
    let s = settings("settings-key-link");
    let target = s.elsewhere("api-key");
    write(&target, "sk-test");
    std::os::unix::fs::symlink(&target, s.key()).expect("a linked key");
    write(&s.config(), &naming(&shown(&s.key())));
    let (report, latch) = s.run(&SettingsFs::default());
    kept(&report, &s.key(), "link");
    assert!(std::fs::symlink_metadata(s.key()).is_ok() && target.exists());
    assert_eq!(report.remaining, ["api-key"], "the kept link is still in the folder");
    assert_eq!(report.removed, [SETTINGS_CONFIG]);
    assert!(latch);

    // ── Outside the folder, and in a SIBLING folder whose name starts with the folder's: kept.
    for outside in ["elsewhere", "sibling"] {
        let s = settings("settings-key-outside");
        let key = match outside {
            "elsewhere" => s.elsewhere("api-key"),
            _ => s.folder.with_file_name("daily-briefing-old").join("api-key"),
        };
        write(&key, "sk-test");
        write(&s.config(), &naming(&shown(&key)));
        let (report, _) = s.run(&SettingsFs::default());
        kept(&report, &key, "isn't in the settings folder");
        assert!(key.exists(), "{outside}: a key outside the folder stays");
        assert!(!s.folder.exists(), "{outside}: the folder was emptied and removed");
    }

    // ── A relative path: kept, with spec 3.5.3's own reason; the same-named file in the folder
    // stays, and is listed among the names still there.
    let s = settings("settings-key-relative");
    write(&s.key(), "sk-test");
    write(&s.config(), &naming("api-key"));
    let (report, _) = s.run(&SettingsFs::default());
    assert_eq!(
        report.key_files,
        [PathReport {
            path: "api-key".into(),
            outcome: PathOutcome::Kept,
            reason: Some(relative_key_reason("api-key")),
        }]
    );
    assert_eq!(
        relative_key_reason("api-key"),
        "your settings name it by a relative path (api-key); if it is in this folder it is listed \
         below"
    );
    assert_eq!(report.remaining, ["api-key"]);
    assert!(s.key().exists());

    // ── A folder: kept, with what is in it.
    let s = settings("settings-key-dir");
    write(&s.key().join("inside"), "x");
    write(&s.config(), &naming(&shown(&s.key())));
    let (report, _) = s.run(&SettingsFs::default());
    kept(&report, &s.key(), "folder");
    assert!(s.key().join("inside").exists());
    assert_eq!(report.remaining, ["api-key"]);

    // ── Already gone: absent.
    let s = settings("settings-key-missing");
    write(&s.config(), &naming(&shown(&s.key())));
    let (report, latch) = s.run(&SettingsFs::default());
    assert_eq!(
        report.key_files,
        [PathReport {
            path: shown(&s.key()),
            outcome: PathOutcome::Absent,
            reason: None,
        }]
    );
    assert!(latch && !s.folder.exists());

    // ── Named only by config.json.bak (config.json names none): removed.
    let s = settings("settings-key-bak-only");
    write(&s.key(), "sk-test");
    write(&s.config(), &json!({ "provider": { "cli": "claude" } }).to_string());
    write(&s.bak(), &naming(&shown(&s.key())));
    let (report, _) = s.run(&SettingsFs::default());
    assert_eq!(
        report.key_files,
        [PathReport {
            path: shown(&s.key()),
            outcome: PathOutcome::Removed,
            reason: None,
        }]
    );
    assert!(!report.key_refs_unknown);
    assert!(!s.key().exists() && !s.folder.exists());
}

/// Spec 3.5.3 step 2: a key path that IS `config.json` — by its absolute path, or by `~` — is not
/// removed as a key file: it is left to step 3 and reported "handled with config.json below", with
/// that step's outcome. `config.json` is removed once.
#[cfg(unix)]
#[test]
fn a_key_path_naming_config_json_is_handled_with_it() {
    assert_eq!(handled_with(SETTINGS_CONFIG), "handled with config.json below");
    for named in ["absolute", "tilde"] {
        let s = settings("settings-key-is-config");
        let key = match named {
            "absolute" => shown(&s.config()),
            _ => "~/.config/daily-briefing/config.json".to_string(),
        };
        write(&s.config(), &naming(&key));
        let fs = SettingsFs::default();
        let (report, latch) = s.run(&fs);
        assert_eq!(
            report.key_files,
            [PathReport {
                path: shown(&s.config()),
                outcome: PathOutcome::Removed,
                reason: Some(handled_with(SETTINGS_CONFIG)),
            }],
            "{named}"
        );
        assert_eq!(report.removed, [SETTINGS_CONFIG], "{named}");
        assert!(latch, "{named}");
        assert_eq!(
            fs.removals().iter().filter(|(_, p)| *p == s.config()).count(),
            1,
            "{named}: config.json is removed once, by step 3"
        );
    }
}

/// Spec 3.5.3 "A config that cannot be read or parsed is still removed": an unparseable or an
/// oversized `config.json`, and the same for `config.json.bak`. Its key reference cannot be
/// identified, so `keyRefsUnknown` is set, and the key file it may name — a direct child of the
/// folder — survives and is listed among the names still there. The oversized one DOES name the
/// key, past the 1 MiB cap, so the cap is what keeps it.
#[test]
fn an_unreadable_config_is_still_removed_and_its_key_reference_is_unknown() {
    for (case, name) in [
        ("unparseable", SETTINGS_CONFIG),
        ("oversized", SETTINGS_CONFIG),
        ("unparseable", SETTINGS_BACKUP),
        ("oversized", SETTINGS_BACKUP),
    ] {
        let s = settings("settings-unreadable");
        write(&s.key(), "sk-test");
        let text = match case {
            "unparseable" => "{ \"provider\": ".to_string(),
            _ => format!("{}{}", naming(&shown(&s.key())), " ".repeat(1024 * 1024)),
        };
        write(&s.folder.join(name), &text);
        let (report, latch) = s.run(&SettingsFs::default());
        assert_eq!(
            report,
            SettingsReport {
                asked: true,
                folder: s.shown_folder(),
                key_refs_unknown: true,
                removed: vec![name.into()],
                remaining: vec!["api-key".into()],
                ..SettingsReport::default()
            },
            "{case} {name}"
        );
        assert!(!s.folder.join(name).exists(), "{case} {name}: still removed");
        assert!(s.key().exists(), "{case} {name}: the key it may name survives, listed");
        assert!(latch, "{case} {name}: config.json removed or absent");
    }
}

/// Spec 3.5.3 step 2: an eligible key file that will not unlink STOPS THE LEG THERE — both configs
/// are kept, so another Uninstall can still identify the key — and the report says why. A second
/// key file after it is not attempted, nothing else is removed, and no latch is due.
#[test]
fn a_key_file_that_will_not_unlink_stops_the_leg_with_both_configs_kept() {
    let s = settings("settings-key-stop");
    let second = s.folder.join("second-key");
    write(&s.key(), "sk-test");
    write(&second, "sk-test-2");
    write(&s.config(), &naming(&shown(&s.key())));
    write(&s.bak(), &naming(&shown(&second)));
    let fs = SettingsFs {
        refuse: Some(s.key()),
        ..SettingsFs::default()
    };

    let (report, latch) = s.run(&fs);

    assert!(!latch, "a stopped leg sets no latch");
    assert_eq!(report.key_files.len(), 2, "{report:?}");
    assert_eq!(
        (report.key_files[0].path.as_str(), report.key_files[0].outcome),
        (shown(&s.key()).as_str(), PathOutcome::Failed)
    );
    assert!(
        report.key_files[0]
            .reason
            .as_deref()
            .is_some_and(|r| r.contains("refused")),
        "the failed line carries the error: {report:?}"
    );
    assert_eq!(
        (report.key_files[1].path.as_str(), report.key_files[1].outcome),
        (shown(&second).as_str(), PathOutcome::Kept),
        "not attempted: {report:?}"
    );
    assert!(report.error.is_some(), "the report says why it stopped: {report:?}");
    assert!(report.removed.is_empty(), "{report:?}");
    assert_eq!(
        report.remaining,
        ["api-key", SETTINGS_CONFIG, SETTINGS_BACKUP, "second-key"]
    );
    assert_eq!(
        fs.removals(),
        [("file", s.key())],
        "nothing after the failed key was attempted"
    );
    assert!(s.config().exists() && s.bak().exists() && second.exists());
}

/// Spec r10 3.5.3, 3.7: a key path that is `config.json.bak` UNDER ANOTHER NAME is compared by
/// identity (device and inode), whatever its name or link count, and left to step 4 — reported
/// "handled with config.json.bak below", with step 4's outcome:
///   * a HARD LINK to it under another name: that other name still holds the file, so it is listed
///     among the names still in the folder, and `.bak`'s own removal carries the other-link note;
///   * a CASE-INSENSITIVE SPELLING (`CONFIG.JSON.BAK`, on a case-folding fixture, so on any
///     platform): never removed as a key file; when step 4 fails, so does its line.
#[cfg(unix)]
#[test]
fn a_key_path_that_is_config_json_bak_by_another_name_is_handled_with_it() {
    assert_eq!(
        handled_with(SETTINGS_BACKUP),
        "handled with config.json.bak below"
    );
    // ── A hard link under another name.
    let s = settings("settings-key-bak-hardlink");
    write(&s.bak(), r#"{"provider":{"api":{"kind":"anthropic","apiKey":"sk-inline"}}}"#);
    let other = s.folder.join("key.txt");
    std::fs::hard_link(s.bak(), &other).expect("a second name for .bak");
    write(&s.config(), &naming(&shown(&other)));
    let (report, latch) = s.run(&SettingsFs::default());
    assert_eq!(
        report.key_files,
        [PathReport {
            path: shown(&other),
            outcome: PathOutcome::Removed,
            reason: Some(handled_with(SETTINGS_BACKUP)),
        }]
    );
    assert_eq!(report.removed, [SETTINGS_CONFIG, SETTINGS_BACKUP]);
    assert_eq!(report.remaining, ["key.txt"], "the other name still holds the file");
    assert_eq!(report.notes, [config_other_link_note(SETTINGS_BACKUP)]);
    assert!(other.exists() && !s.bak().exists() && latch);

    // ── A case-insensitive spelling, with step 4 succeeding and then failing.
    for refuse_bak in [false, true] {
        let s = settings("settings-key-bak-case");
        write(&s.bak(), "{}");
        let spelled = s.folder.join("CONFIG.JSON.BAK");
        write(&s.config(), &naming(&shown(&spelled)));
        let fs = SettingsFs {
            fold_case: true,
            refuse: refuse_bak.then(|| s.bak()),
            ..SettingsFs::default()
        };
        let (report, _) = s.run(&fs);
        let step4 = if refuse_bak {
            PathOutcome::Failed
        } else {
            PathOutcome::Removed
        };
        assert_eq!(
            report.key_files,
            [PathReport {
                path: shown(&spelled),
                outcome: step4,
                reason: Some(handled_with(SETTINGS_BACKUP)),
            }],
            "refuse .bak: {refuse_bak}"
        );
        assert!(
            fs.removals().iter().all(|(_, p)| *p != spelled),
            "never removed as a key file"
        );
        assert_eq!(s.bak().exists(), refuse_bak);
    }
}

/// Spec 3.5.3: a file with another link elsewhere is removed, WITH the other-link note — a key
/// file in its line's reason ("API key file removed (<name>); another link to the same file still
/// exists"), and `config.json` in the notes (steps 3-4 add the same note: it can hold an inline
/// key). The other links stay.
#[cfg(unix)]
#[test]
fn a_file_with_another_link_is_removed_with_the_other_link_note() {
    assert_eq!(OTHER_LINK_NOTE, "another link to the same file still exists");
    assert_eq!(
        config_other_link_note(SETTINGS_CONFIG),
        "config.json removed; another link to the same file still exists"
    );
    let s = settings("settings-other-links");
    write(&s.key(), "sk-test");
    write(&s.config(), &naming(&shown(&s.key())));
    std::fs::create_dir_all(s.scratch.join("elsewhere")).expect("elsewhere");
    let (key_copy, config_copy) = (s.elsewhere("key-copy"), s.elsewhere("config-copy.json"));
    std::fs::hard_link(s.key(), &key_copy).expect("another link to the key");
    std::fs::hard_link(s.config(), &config_copy).expect("another link to config.json");

    let (report, latch) = s.run(&SettingsFs::default());

    assert_eq!(
        report.key_files,
        [PathReport {
            path: shown(&s.key()),
            outcome: PathOutcome::Removed,
            reason: Some(OTHER_LINK_NOTE.into()),
        }]
    );
    assert_eq!(report.removed, [SETTINGS_CONFIG]);
    assert_eq!(report.notes, [config_other_link_note(SETTINGS_CONFIG)]);
    assert!(key_copy.exists() && config_copy.exists());
    assert!(latch && !s.folder.exists());
}

/// Spec 3.5.3 step 1: a `config.json` that is a SYMLINK (a dotfiles manager) is read THROUGH the
/// link — `notifications::read_engine_config_text`'s follow-the-link, non-blocking, 1 MiB read —
/// only to find its key reference; step 3 then unlinks the link itself, never its target, and the
/// report says the target was kept and may hold the key. A link whose target cannot be read that
/// way (dangling, a folder, over 1 MiB) sets `keyRefsUnknown`, and the link still goes.
#[cfg(unix)]
#[test]
fn a_linked_config_is_read_through_for_its_key_and_only_the_link_goes() {
    let s = settings("settings-config-link");
    write(&s.key(), "sk-test");
    let target = s.scratch.join("dotfiles").join("config.json");
    write(&target, &naming(&shown(&s.key())));
    std::os::unix::fs::symlink(&target, s.config()).expect("a linked config");
    let (report, latch) = s.run(&SettingsFs::default());
    assert_eq!(
        report,
        SettingsReport {
            asked: true,
            folder: s.shown_folder(),
            key_files: vec![PathReport {
                path: shown(&s.key()),
                outcome: PathOutcome::Removed,
                reason: None,
            }],
            removed: vec![SETTINGS_CONFIG.into()],
            notes: vec![config_link_note(SETTINGS_CONFIG, &target)],
            ..SettingsReport::default()
        }
    );
    assert_eq!(
        config_link_note(SETTINGS_CONFIG, &target),
        format!(
            "config.json was a link to {}; that file was kept and may hold your API key.",
            target.display()
        )
    );
    assert!(latch && target.exists() && std::fs::symlink_metadata(s.config()).is_err());

    for unreadable in ["dangling", "a folder", "oversized"] {
        let s = settings("settings-config-link-unreadable");
        write(&s.key(), "sk-test");
        let target = s.scratch.join("dotfiles").join("config.json");
        match unreadable {
            "dangling" => {}
            "a folder" => std::fs::create_dir_all(&target).expect("a folder"),
            _ => write(
                &target,
                &format!("{}{}", naming(&shown(&s.key())), " ".repeat(1024 * 1024)),
            ),
        }
        std::os::unix::fs::symlink(&target, s.config()).expect("a linked config");
        let (report, _) = s.run(&SettingsFs::default());
        assert!(report.key_refs_unknown, "{unreadable}: {report:?}");
        assert!(report.key_files.is_empty(), "{unreadable}: {report:?}");
        assert_eq!(
            report.removed,
            [SETTINGS_CONFIG],
            "{unreadable}: the link itself still goes"
        );
        assert_eq!(report.remaining, ["api-key"], "{unreadable}");
        assert!(s.key().exists(), "{unreadable}");
        let note = match unreadable {
            // Nothing is there: the note must not say a file was kept (checkpoint M5b F3).
            "dangling" => format!(
                "config.json was a link to {}, which isn't there.",
                target.display()
            ),
            _ => config_link_note(SETTINGS_CONFIG, &target),
        };
        assert_eq!(report.notes, [note], "{unreadable}");
    }
}

/// A LINKED CONFIG'S NOTE TELLS THE TRUTH ABOUT ITS TARGET AFTER THE LEG (spec 3.5.3; checkpoint
/// M5b F3). `config.json.bak` is a link to the API key file `config.json` names, in the folder —
/// written absolute, then relative: step 2 removes that key file (the settings name it), step 4
/// unlinks the link, and the note says the target was removed as the API key file, never that it
/// "was kept and may hold your API key". (Read through, the link finds key text, not JSON:
/// `keyRefsUnknown`.) A link to the OTHER config, which steps 3-4 remove — either way round, so the
/// note is decided after BOTH steps — says its target isn't there.
#[cfg(unix)]
#[test]
fn a_linked_configs_note_says_what_became_of_its_target() {
    // ── `config.json.bak` → the key file: removed as the key file.
    for written in ["absolute", "relative"] {
        let s = settings("settings-link-to-key");
        write(&s.key(), "sk-test-not-a-real-key");
        write(&s.config(), &naming(&shown(&s.key())));
        let target = match written {
            "absolute" => s.key(),
            _ => PathBuf::from("api-key"),
        };
        std::os::unix::fs::symlink(&target, s.bak()).expect("a .bak linked to the key file");

        let (report, latch) = s.run(&SettingsFs::default());

        assert_eq!(
            report,
            SettingsReport {
                asked: true,
                folder: s.shown_folder(),
                key_files: vec![PathReport {
                    path: shown(&s.key()),
                    outcome: PathOutcome::Removed,
                    reason: None,
                }],
                key_refs_unknown: true,
                removed: vec![SETTINGS_CONFIG.into(), SETTINGS_BACKUP.into()],
                notes: vec![format!(
                    "config.json.bak was a link to {}, which was removed as your API key file.",
                    target.display()
                )],
                ..SettingsReport::default()
            },
            "{written}"
        );
        assert!(
            std::fs::symlink_metadata(s.key()).is_err()
                && std::fs::symlink_metadata(s.bak()).is_err(),
            "{written}: the key file and the link both went"
        );
        assert!(latch && !s.folder.exists(), "{written}");
    }

    // ── A link to the other config: `config.json.bak` → `config.json` (step 3 removes it), and
    // `config.json` → `config.json.bak` (step 4 removes it, AFTER step 3 unlinked the link).
    for (link, other) in [
        (SETTINGS_BACKUP, SETTINGS_CONFIG),
        (SETTINGS_CONFIG, SETTINGS_BACKUP),
    ] {
        let s = settings("settings-link-to-config");
        write(&s.key(), "sk-test-not-a-real-key");
        write(&s.folder.join(other), &naming(&shown(&s.key())));
        std::os::unix::fs::symlink(other, s.folder.join(link))
            .expect("a config linked to the other");

        let (report, latch) = s.run(&SettingsFs::default());

        assert_eq!(
            report.notes,
            [format!("{link} was a link to {other}, which isn't there.")],
            "{link} -> {other}: {report:?}"
        );
        assert_eq!(report.removed, [SETTINGS_CONFIG, SETTINGS_BACKUP], "{link}");
        assert_eq!(report.key_files[0].outcome, PathOutcome::Removed, "{link}");
        assert!(latch && !s.folder.exists(), "{link}");
    }
}

/// M9 LOW pass (L6): two configs that are the ONLY two links to one file, both removed, leave no link behind —
/// so neither gets the other-link note, which each used to get from its link count of 2. The links this leg
/// removed are counted out first: with a THIRD link elsewhere, both say another link still exists; with only
/// `config.json` removed (`.bak`'s unlink refused), `.bak` still holds the file, and `config.json` says so.
#[cfg(unix)]
#[test]
fn hard_linked_configs_both_removed_get_no_other_link_note() {
    // ── The only two links, both removed.
    let s = settings("settings-configs-hard-linked");
    write(&s.config(), "{}");
    std::fs::hard_link(s.config(), s.bak()).expect("config.json.bak as a second name");
    let (report, latch) = s.run(&SettingsFs::default());
    assert_eq!(report.removed, [SETTINGS_CONFIG, SETTINGS_BACKUP], "{report:?}");
    assert!(report.notes.is_empty(), "no link survives the leg: {report:?}");
    assert!(latch && !s.folder.exists());

    // ── A third link elsewhere: it survives, so both notes stand.
    let s = settings("settings-configs-hard-linked-third");
    write(&s.config(), "{}");
    std::fs::hard_link(s.config(), s.bak()).expect("config.json.bak as a second name");
    std::fs::create_dir_all(s.scratch.join("elsewhere")).expect("elsewhere");
    let third = s.elsewhere("third.json");
    std::fs::hard_link(s.config(), &third).expect("a third name");
    let (report, _) = s.run(&SettingsFs::default());
    assert_eq!(report.removed, [SETTINGS_CONFIG, SETTINGS_BACKUP], "{report:?}");
    assert_eq!(
        report.notes,
        [
            config_other_link_note(SETTINGS_CONFIG),
            config_other_link_note(SETTINGS_BACKUP)
        ]
    );
    assert!(third.exists());

    // ── Only config.json removed: `.bak`, whose unlink failed, still holds the file.
    let s = settings("settings-configs-hard-linked-one-fails");
    write(&s.config(), "{}");
    std::fs::hard_link(s.config(), s.bak()).expect("config.json.bak as a second name");
    let fs = SettingsFs {
        refuse: Some(s.bak()),
        ..SettingsFs::default()
    };
    let (report, _) = s.run(&fs);
    assert_eq!(report.removed, [SETTINGS_CONFIG], "{report:?}");
    assert_eq!(report.notes, [config_other_link_note(SETTINGS_CONFIG)]);
    assert!(s.bak().exists());
}

/// M9 LOW pass (L7): a linked config the leg KEEPS — it stopped at a key file that would not unlink, or the
/// config's own unlink failed — gets the same "<name> was a link to <target>…" note a removed one does (the
/// target was kept, and may hold the key), from what its target is after the leg; the link stays, and so
/// does its target. One whose target is not there says so, as a removed one does.
#[cfg(unix)]
#[test]
fn a_linked_config_the_leg_keeps_still_gets_its_note() {
    // ── The leg stops at a key file: both configs kept.
    let s = settings("settings-kept-link-stop");
    write(&s.key(), "sk-test-not-a-real-key");
    let target = s.scratch.join("dotfiles").join("config.json");
    write(&target, &naming(&shown(&s.key())));
    std::os::unix::fs::symlink(&target, s.config()).expect("a linked config");
    let fs = SettingsFs {
        refuse: Some(s.key()),
        ..SettingsFs::default()
    };
    let (report, latch) = s.run(&fs);
    assert!(!latch, "a stopped leg sets no latch");
    assert!(report.removed.is_empty(), "{report:?}");
    assert_eq!(report.notes, [config_link_note(SETTINGS_CONFIG, &target)], "{report:?}");
    assert!(std::fs::symlink_metadata(s.config()).is_ok() && target.exists());

    // ── The config's own unlink fails.
    let s = settings("settings-kept-link-failed");
    let target = s.scratch.join("dotfiles").join("config.json");
    write(&target, "{}");
    std::os::unix::fs::symlink(&target, s.config()).expect("a linked config");
    let fs = SettingsFs {
        refuse: Some(s.config()),
        ..SettingsFs::default()
    };
    let (report, latch) = s.run(&fs);
    assert!(!latch, "config.json was not removed");
    assert!(
        report
            .error
            .as_deref()
            .is_some_and(|e| e.contains("config.json couldn't be removed")),
        "{report:?}"
    );
    assert_eq!(report.notes, [config_link_note(SETTINGS_CONFIG, &target)], "{report:?}");
    assert!(std::fs::symlink_metadata(s.config()).is_ok() && target.exists());

    // ── Kept, its target not there: never "that file was kept".
    let s = settings("settings-kept-link-dangling");
    write(&s.key(), "sk-test-not-a-real-key");
    write(&s.bak(), &naming(&shown(&s.key())));
    let target = s.scratch.join("dotfiles").join("gone.json");
    std::os::unix::fs::symlink(&target, s.config()).expect("a dangling linked config");
    let fs = SettingsFs {
        refuse: Some(s.key()),
        ..SettingsFs::default()
    };
    let (report, _) = s.run(&fs);
    assert_eq!(
        report.notes,
        [format!(
            "config.json was a link to {}, which isn't there.",
            target.display()
        )],
        "{report:?}"
    );
}

/// Spec 3.5.3: a settings folder that is a SYMLINK is not entered — nothing inside it is removed,
/// whatever it holds — and the report says "The settings folder is a link to <target>; nothing
/// inside it was removed." No latch.
#[cfg(unix)]
#[test]
fn a_linked_settings_folder_is_not_entered() {
    let scratch = ScratchDir::new("settings-folder-link");
    let home = scratch.join("home");
    let real = scratch.join("dotfiles").join("daily-briefing");
    write(&real.join("api-key"), "sk-test");
    write(&real.join(SETTINGS_CONFIG), &naming(&shown(&real.join("api-key"))));
    let folder = home.join(".config").join("daily-briefing");
    std::fs::create_dir_all(folder.parent().expect("a parent")).expect("<home>/.config");
    std::os::unix::fs::symlink(&real, &folder).expect("a linked folder");
    let before = tree(&real);
    let fs = SettingsFs::default();

    let (report, latch) = settings_leg(&fs, &folder.join(SETTINGS_CONFIG), &home);

    assert_eq!(
        report,
        SettingsReport {
            asked: true,
            folder: Some(shown(&folder)),
            refused: Some(settings_folder_link(&real)),
            ..SettingsReport::default()
        }
    );
    assert_eq!(
        settings_folder_link(&real),
        format!(
            "The settings folder is a link to {}; nothing inside it was removed.",
            real.display()
        )
    );
    assert!(!latch, "nothing was removed: no latch");
    assert!(fs.removals().is_empty(), "{:?}", fs.removals());
    assert_eq!(tree(&real), before);
}

/// Spec 3.5.3 (decision A): `.config.json.save-*` — a killed save's staged copies, which may hold a
/// key — are NAMED, not removed: they stay, are listed among the names still in the folder, and the
/// report describes them. So the folder stays too.
#[test]
fn staged_copies_of_earlier_settings_are_named_not_removed() {
    let s = settings("settings-staged");
    write(&s.config(), "{}");
    let staged = [".config.json.save-4242-1", ".config.json.save-4242-1.bak"];
    for name in staged {
        write(
            &s.folder.join(name),
            r#"{"provider":{"api":{"kind":"anthropic","apiKey":"sk-inline"}}}"#,
        );
    }
    let staged_names = staged.map(String::from);

    let (report, latch) = s.run(&SettingsFs::default());

    assert_eq!(report.removed, [SETTINGS_CONFIG]);
    assert_eq!(report.remaining, staged);
    assert_eq!(report.notes, [staged_copies_note(&staged_names)]);
    assert_eq!(
        staged_copies_note(&staged_names),
        ".config.json.save-4242-1, .config.json.save-4242-1.bak: staged copies of earlier \
         settings, which may hold a key"
    );
    assert!(staged.iter().all(|name| s.folder.join(name).exists()) && latch);
}

/// Spec 3.3.7, 3.5.3: unticked (`removeSettings` missing or false) the leg does not run, and the
/// report only names the folder that stays — `configPath`'s parent, as the preview names it — on
/// the wire in the shape `lib/app-uninstall.ts` mirrors. Nothing in the folder is touched; no latch.
#[tokio::test(flavor = "multi_thread")]
async fn the_settings_box_unticked_only_names_the_folder_that_stays() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("settings-unticked");
    let folder = plant_settings(&scratch.path);
    let before = tree(&folder);
    let f = fixture(scratch, Arc::new(RecordingAutostartSink::default()));
    for remove_settings in [None, Some(false)] {
        let report = execute_with(&f.app, true, remove_settings, None)
            .await
            .expect("answers");
        assert_eq!(
            report.settings,
            SettingsReport {
                folder: Some(shown(&folder)),
                ..SettingsReport::default()
            },
            "{remove_settings:?}"
        );
        let wire = serde_json::to_value(&report).expect("JSON");
        assert_eq!(
            wire["settings"],
            json!({
                "asked": false,
                "folder": shown(&folder),
                "keyFiles": [],
                "keyRefsUnknown": false,
                "removed": [],
                "remaining": [],
                "refused": null,
                "error": null,
                "notes": [],
            }),
            "{wire}"
        );
        assert_eq!(tree(&folder), before, "{remove_settings:?}: nothing touched");
    }
    assert!(!f.app.state::<ConfigSaver>().settings_removed());
}

/// Spec 3.3.5.3: the settings step only is refused WITH AN ERROR, and removes nothing, when the
/// engine's `configPath` is unknown — not reported, or relative (never resolved against this app's
/// working folder). The engine leg is unaffected. No latch.
#[tokio::test(flavor = "multi_thread")]
async fn an_unknown_config_path_refuses_the_settings_leg_with_an_error() {
    let _turn = serialise().await;
    for (case, config_path) in [("missing", None), ("relative", Some("settings/config.json"))] {
        let scratch = ScratchDir::new("settings-unknown-config");
        let state = scratch.join("state");
        write(&state.join("briefing.log"), "log");
        let folder = plant_settings(&scratch.path);
        let before = tree(&folder);
        let mut paths = json!({ "stateDir": shown(&state) });
        if let Some(path) = config_path {
            paths["configPath"] = json!(path);
        }
        script_answer(
            &scratch.path,
            "status --json",
            &format!(
                "printf '%s' {}\nexit 0\n",
                sq(&json!({ "paths": paths }).to_string())
            ),
        );
        let f = fixture(scratch, Arc::new(RecordingAutostartSink::default()));

        let report = execute_with(&f.app, true, Some(true), None)
            .await
            .expect("answers");

        assert!(
            report.engine_state_removed,
            "{case}: the engine leg is unaffected: {report:?}"
        );
        let settings = &report.settings;
        assert!(settings.asked && settings.folder.is_none(), "{case}: {report:?}");
        assert!(
            settings
                .error
                .as_deref()
                .is_some_and(|e| e.contains("configPath")),
            "{case}: {report:?}"
        );
        assert_eq!(settings.refused, None, "{case}");
        assert!(settings.key_files.is_empty() && settings.removed.is_empty(), "{case}");
        assert_eq!(tree(&folder), before, "{case}: nothing removed");
        assert!(!f.app.state::<ConfigSaver>().settings_removed(), "{case}");
    }
}

/// Spec 3.3.5.2: the gate look's refusal — a schedule record still there after the scheduler step —
/// refuses the settings leg too, with the engine leg's own text. Nothing in the settings folder is
/// removed, and no latch.
#[tokio::test(flavor = "multi_thread")]
async fn a_schedule_record_at_the_gate_look_refuses_the_settings_leg_too() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("settings-gate-record");
    let folder = plant_settings(&scratch.path);
    let before = tree(&folder);
    write(&scratch.join("state").join(SCHEDULE_RECORD), r#"{"owner":"cli"}"#);
    script_answer(
        &scratch.path,
        "schedule uninstall",
        &exit_answer(0, "Removed the background scheduler.", ""),
    );
    let f = fixture(scratch, Arc::new(RecordingAutostartSink::default()));

    let report = execute_with(&f.app, false, Some(true), Some(SchedulerChoice::RemoveAny))
        .await
        .expect("answers");

    assert_eq!(report.schedule_record_present, Some(true), "{report:?}");
    assert_eq!(
        report.settings,
        SettingsReport {
            asked: true,
            folder: Some(shown(&folder)),
            refused: Some(REFUSED_FOR_SCHEDULE.to_string()),
            ..SettingsReport::default()
        }
    );
    assert_eq!(tree(&folder), before, "nothing of the settings removed");
    assert!(!f.app.state::<ConfigSaver>().settings_removed());
}

/// Spec 3.5.3 step 6, 3.7 "The settings lock": the leg runs UNDER the save lock, so a save started
/// while it is pending WAITS for it; once the leg's `config.json` step has completed the latch is
/// set before the lock is let go, so that queued save, a later save, the Quit dialog's notification
/// offer and `config_create` all refuse with "Settings were removed by Uninstall." — before any of
/// them reads the engine — and nothing re-creates the settings. Uninstall itself is never refused by
/// the latch: a second run finishes what the first left.
#[tokio::test(flavor = "multi_thread")]
async fn after_the_settings_leg_every_settings_write_refuses_and_uninstall_does_not() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("settings-latch");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    let dir = scratch.path.clone();
    let folder = plant_settings(&dir);
    let key = folder.join("api-key");
    let app = app_with(
        status_sidecar(&dir, &state),
        &scratch,
        Arc::new(RecordingAutostartSink::default()),
        None,
    );
    script_answer(&dir, "schedule uninstall", &hold_answer("removing", false));

    let uninstall = execute_with(&app, false, Some(true), None);
    let save = async {
        wait_for(&dir.join("removing")).await;
        let mut save = Box::pin(config_save(
            app.handle().clone(),
            app.state(),
            app.state(),
            "{}".into(),
            "base".into(),
        ));
        assert!(
            tokio::time::timeout(Duration::from_millis(400), &mut save)
                .await
                .is_err(),
            "a save went on while the settings leg was pending"
        );
        assert!(
            key.exists() && folder.join(SETTINGS_CONFIG).exists(),
            "premise: the leg has not run yet"
        );
        write(&dir.join("release"), "");
        save.await
    };
    let (report, saved) = tokio::join!(uninstall, save);

    let report = report.expect("answers");
    assert_eq!(
        report.settings,
        SettingsReport {
            asked: true,
            folder: Some(shown(&folder)),
            key_files: vec![PathReport {
                path: shown(&key),
                outcome: PathOutcome::Removed,
                reason: None,
            }],
            removed: vec![SETTINGS_CONFIG.into()],
            ..SettingsReport::default()
        }
    );
    let wire = serde_json::to_value(&report).expect("JSON");
    assert_eq!(
        wire["settings"]["keyFiles"],
        json!([{ "path": shown(&key), "outcome": "removed", "reason": null }]),
        "{wire}"
    );
    assert!(!folder.exists(), "the key, the config and the empty folder went");
    assert!(app.state::<ConfigSaver>().settings_removed(), "the latch is set");
    assert_eq!(saved, latched(), "the queued save waited for the leg, then refused");

    // Later writes: refused, and none reads the engine or re-creates a file.
    assert_eq!(
        config_save(
            app.handle().clone(),
            app.state(),
            app.state(),
            "{}".into(),
            "base".into()
        )
        .await,
        latched()
    );
    #[cfg(not(windows))]
    assert_eq!(
        config_offer_notify_auto(app.handle().clone(), app.state(), app.state()).await,
        latched()
    );
    assert_eq!(
        config_create(
            app.handle().clone(),
            app.state(),
            app.state(),
            json!({ "provider": { "cli": "claude" } }).to_string()
        )
        .await,
        latched()
    );
    assert!(!folder.exists(), "nothing re-created the settings");
    assert_eq!(
        engine_calls(&dir),
        ["status --json", "schedule status --json", REMOVE_OWN_CALL],
        "no refused write read the engine"
    );

    // A second Uninstall is NOT refused by the latch: it finishes what the first left.
    write(&folder.join(SETTINGS_BACKUP), "{}");
    let report = execute_with(&app, false, Some(true), None)
        .await
        .expect("a second Uninstall is never refused by the latch");
    assert_eq!(
        report.settings,
        SettingsReport {
            asked: true,
            folder: Some(shown(&folder)),
            removed: vec![SETTINGS_BACKUP.into()],
            ..SettingsReport::default()
        }
    );
    assert!(!folder.exists());
}

/// Spec 3.5.3 step 6: the latch is set once the `config.json` step has COMPLETED — also when it
/// found `config.json` already absent — and never after a leg that stopped at a key file that would
/// not unlink (both configs kept). (A refused leg sets none either: the `keep` and gate-look tests.)
#[tokio::test(flavor = "multi_thread")]
async fn the_latch_is_set_only_once_the_config_json_step_completed() {
    let _turn = serialise().await;

    // ── `config.json` already absent, only its backup there: set.
    let scratch = ScratchDir::new("settings-latch-absent");
    write(&scratch.join("settings").join(SETTINGS_BACKUP), "{}");
    let f = fixture(scratch, Arc::new(RecordingAutostartSink::default()));
    let report = execute_with(&f.app, false, Some(true), None)
        .await
        .expect("answers");
    assert_eq!(report.settings.removed, [SETTINGS_BACKUP], "{report:?}");
    assert!(
        f.app.state::<ConfigSaver>().settings_removed(),
        "config.json was absent: its step completed"
    );

    // ── Stopped at a key file that will not unlink: none, and both configs kept.
    let scratch = ScratchDir::new("settings-latch-stopped");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    let folder = plant_settings(&scratch.path);
    write(&folder.join(SETTINGS_BACKUP), "{}");
    let key = folder.join("api-key");
    let fs: Arc<dyn UninstallFs> = Arc::new(SettingsFs {
        refuse: Some(key.clone()),
        ..SettingsFs::default()
    });
    let app = app_with(
        status_sidecar(&scratch.path, &state),
        &scratch,
        Arc::new(RecordingAutostartSink::default()),
        Some(fs),
    );
    let report = execute_with(&app, false, Some(true), None)
        .await
        .expect("answers");
    assert_eq!(
        report.settings.key_files[0].outcome,
        PathOutcome::Failed,
        "{report:?}"
    );
    assert!(report.settings.error.is_some(), "{report:?}");
    assert!(folder.join(SETTINGS_CONFIG).exists() && folder.join(SETTINGS_BACKUP).exists());
    assert!(key.exists());
    assert!(
        !app.state::<ConfigSaver>().settings_removed(),
        "a stopped leg sets no latch"
    );
}

/// Spec 3.5.3 step 6 (checkpoint M5b F2): the latch needs step 3 to have COMPLETED, not merely the
/// leg to have got past step 2. Here no key file stops the leg — the key goes — but `config.json`'s
/// own UNLINK fails: no latch, so a later `config_save` is not refused (it gets past the latch to
/// the engine and the file, and answers the base conflict — nothing is written). The failure is
/// reported, `config.json` is still among the names in the folder, and step 4 is still tried:
/// `config.json.bak` goes.
#[tokio::test(flavor = "multi_thread")]
async fn a_config_json_that_will_not_unlink_sets_no_latch() {
    let _turn = serialise().await;
    let scratch = ScratchDir::new("settings-latch-config-refused");
    let state = scratch.join("state");
    std::fs::create_dir_all(&state).expect("state dir");
    let folder = plant_settings(&scratch.path);
    let (key, config, bak) = (
        folder.join("api-key"),
        folder.join(SETTINGS_CONFIG),
        folder.join(SETTINGS_BACKUP),
    );
    write(&bak, "{}");
    let sink = Arc::new(SettingsFs {
        refuse: Some(config.clone()),
        ..SettingsFs::default()
    });
    let fs: Arc<dyn UninstallFs> = sink.clone();
    let app = app_with(
        status_sidecar(&scratch.path, &state),
        &scratch,
        Arc::new(RecordingAutostartSink::default()),
        Some(fs),
    );

    let report = execute_with(&app, false, Some(true), None)
        .await
        .expect("answers");

    let settings = &report.settings;
    assert_eq!(
        settings.key_files,
        [PathReport {
            path: shown(&key),
            outcome: PathOutcome::Removed,
            reason: None,
        }],
        "no key file stopped the leg: {report:?}"
    );
    assert_eq!(settings.removed, [SETTINGS_BACKUP], "step 4 still tried: {report:?}");
    assert_eq!(settings.remaining, [SETTINGS_CONFIG], "{report:?}");
    assert!(
        settings
            .error
            .as_deref()
            .is_some_and(|e| e.contains("config.json couldn't be removed")),
        "the report says config.json failed: {report:?}"
    );
    let removals = sink.removals();
    assert!(
        removals.contains(&("file", config.clone())) && removals.contains(&("file", bak.clone())),
        "both config steps were tried: {removals:?}"
    );
    assert!(config.exists() && !bak.exists() && !key.exists());
    assert!(
        !app.state::<ConfigSaver>().settings_removed(),
        "config.json's step did not complete: no latch"
    );
    let before = std::fs::read_to_string(&config).expect("config.json is still there");
    let saved = config_save(
        app.handle().clone(),
        app.state(),
        app.state(),
        "{}".into(),
        "base".into(),
    )
    .await;
    assert!(
        matches!(saved, Err(SaveError::Conflict { .. })),
        "a later save is not refused by a latch, it reaches the file: {saved:?}"
    );
    assert_eq!(
        std::fs::read_to_string(&config).expect("still there"),
        before,
        "nothing written"
    );
}
