//! Briefing redesign B1, wave-2 plan B1-M4-T12 / T13 — the live git check's Rust half (`src/repos.rs`).
//!
//! - **The gate** (`repos::decide`) is a pure function of injected inputs, tested row by row; the bookkeeping
//!   around it (`ReposState::gate`: an owed `first`, the ungated minute ask armed once per key) as sequences.
//! - **The stat check** (`repos::stat_fingerprint`) on scratch git repos built with `git` in a temp folder, each
//!   under its own `HOME` with no global or system config: it fires only on change, never follows a symlink,
//!   requires a check past its cap, treats an absent file as an entry and any other error as an
//!   error.
//!
//! No test reads the user's repos, HOME or git config.

mod common;

use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::process::Command;

use common::ScratchDir;
use daily_briefing_gui_lib::engine::{ReposBranch, ReposLabel, ReposRequest, ReposScope};
use daily_briefing_gui_lib::live_gate::{CurrentSlide, Visibility};
use daily_briefing_gui_lib::repos::{
    decide, stat_fingerprint, stat_paths, Ask, Decision, Fingerprint, GateInput, Reason,
    RepoStatTarget, ReposState, RequestKey, StatOutcome, REPLY_KEYS, STAT_CAP,
};
use serde_json::{json, Map, Value};

const SHOWN: Visibility = Visibility {
    visible: true,
    minimized: false,
};
const HIDDEN: Visibility = Visibility {
    visible: false,
    minimized: false,
};
const MINIMISED: Visibility = Visibility {
    visible: true,
    minimized: true,
};
const ALL: Decision = Decision::Run(ReposScope::All);
const UNCOMMITTED: Decision = Decision::Run(ReposScope::Uncommitted);

/* ── the pure gate ────────────────────────────────────────────────────────────────────────────── */

/// A held result for this key, shown, on What you did, nothing owed, no stat change.
fn base(reason: Reason) -> GateInput {
    GateInput {
        shown: SHOWN,
        current: Some(CurrentSlide::WhatYouDid),
        reason,
        key_matches: true,
        has_held: true,
        first_owed: false,
        ungated_once: false,
        stat: StatOutcome::Unchanged,
    }
}

const REASONS: [Reason; 3] = [Reason::First, Reason::Focus, Reason::Minute];

#[test]
fn row_1_no_current_slide_is_no_check_whatever_else_holds() {
    for reason in REASONS {
        for (has_held, key_matches) in [(false, false), (true, false), (true, true)] {
            let i = GateInput {
                current: None,
                has_held,
                key_matches,
                first_owed: true,
                ungated_once: true,
                stat: StatOutcome::Changed,
                ..base(reason)
            };
            assert_eq!(decide(i), Decision::Held, "{i:?}");
        }
    }
}

#[test]
fn row_2_a_window_not_shown_is_no_check() {
    for shown in [HIDDEN, MINIMISED] {
        for reason in REASONS {
            for has_held in [false, true] {
                let i = GateInput {
                    shown,
                    has_held,
                    key_matches: has_held,
                    first_owed: true,
                    stat: StatOutcome::Changed,
                    ..base(reason)
                };
                assert_eq!(decide(i), Decision::Held, "{i:?}");
            }
        }
    }
}

#[test]
fn row_3_no_held_result_for_this_key_runs_all_whatever_the_reason() {
    for reason in REASONS {
        for current in [CurrentSlide::WhatYouDid, CurrentSlide::Launchpad, CurrentSlide::Calendar] {
            // Nothing held at all, and something held for ANOTHER key: both "no held result".
            for (has_held, key_matches) in [(false, false), (true, false)] {
                let i = GateInput {
                    current: Some(current),
                    has_held,
                    key_matches,
                    ..base(reason)
                };
                assert_eq!(decide(i), ALL, "{i:?}");
            }
        }
    }
}

#[test]
fn row_4_first_focus_or_an_owed_first_run_all_without_the_stat_gate() {
    for reason in [Reason::First, Reason::Focus] {
        assert_eq!(decide(base(reason)), ALL, "{reason:?}");
    }
    let owed = GateInput {
        first_owed: true,
        ..base(Reason::Minute)
    };
    assert_eq!(decide(owed), ALL);
    // On the launchpad too: the owed first is a full check, not the minute status.
    let on_launchpad = GateInput {
        current: Some(CurrentSlide::Launchpad),
        ..owed
    };
    assert_eq!(decide(on_launchpad), ALL);
}

#[test]
fn row_5_the_minute_ask_is_gated_by_the_stat_check_and_the_launchpad() {
    // No change: Held on every slide but the launchpad, where the minute status runs.
    for current in [
        CurrentSlide::GoodMorning,
        CurrentSlide::WhatYouDid,
        CurrentSlide::LeftOff,
        CurrentSlide::Suggested,
        CurrentSlide::Calendar,
    ] {
        let i = GateInput {
            current: Some(current),
            ..base(Reason::Minute)
        };
        assert_eq!(decide(i), Decision::Held, "{current:?}");
    }
    let launchpad = GateInput {
        current: Some(CurrentSlide::Launchpad),
        ..base(Reason::Minute)
    };
    assert_eq!(decide(launchpad), UNCOMMITTED);
    // A stat change, or the armed ungated ask, runs everything, on any slide.
    for current in [CurrentSlide::WhatYouDid, CurrentSlide::Launchpad] {
        let changed = GateInput {
            current: Some(current),
            stat: StatOutcome::Changed,
            ..base(Reason::Minute)
        };
        assert_eq!(decide(changed), ALL, "{current:?}");
        let ungated = GateInput {
            current: Some(current),
            ungated_once: true,
            ..base(Reason::Minute)
        };
        assert_eq!(decide(ungated), ALL, "{current:?}");
    }
    // The stat outcome is read on the minute path only: a first or a focus runs either way.
    for reason in [Reason::First, Reason::Focus] {
        let i = GateInput {
            stat: StatOutcome::Changed,
            ..base(reason)
        };
        assert_eq!(decide(i), ALL);
    }
}

/* ── the bookkeeping, as sequences through ReposState ─────────────────────────────────────────── */

fn key_for(page_date: &str, labels: &[(&str, &[&str])]) -> RequestKey {
    let labels = labels
        .iter()
        .map(|(k, ts)| ReposLabel {
            key: k.to_string(),
            tokens: ts.iter().map(|t| t.to_string()).collect(),
        })
        .collect();
    let branches = vec![ReposBranch {
        key: "app".into(),
        name: "feat/x".into(),
    }];
    RequestKey::of(
        &ReposRequest::new(ReposScope::All, page_date, labels, branches).expect("valid"),
    )
}

fn key_a() -> RequestKey {
    key_for("2026-10-24", &[("app", &["abc1234"])])
}

/// A canned `all` document (the engine's `ReposReply` shape), its record accepted or not.
fn doc(accepted: bool, checked_at: &str) -> Map<String, Value> {
    json!({
        "schemaVersion": 1,
        "scope": "all",
        "checkedAt": checked_at,
        "record": { "accepted": accepted, "windowStartUtc": null },
        "windowStartUtc": null,
        "repoViews": [{ "key": "rA", "name": "a", "state": "ok", "noRemote": false, "uncommitted": { "count": 2 } }],
        "labels": [],
        "branchLines": [],
        "pushCards": [],
        "tile": { "commits": 0, "branches": 0 },
        "hidden": { "complete": false, "perLabel": {} }
    })
    .as_object()
    .expect("an object")
    .clone()
}

fn ask(reason: Reason, current: CurrentSlide) -> Ask {
    Ask {
        shown: SHOWN,
        current: Some(current),
        reason,
    }
}

#[test]
fn a_hidden_first_is_owed_and_the_next_shown_ask_runs_all_without_the_stat_gate() {
    let mut s = ReposState::default();
    let key = key_a();
    s.hold_all(key.clone(), doc(true, "t0"), vec![], 100, vec![], vec![]);
    // A new page while hidden: no check, and the first is owed.
    let hidden_first = Ask {
        shown: HIDDEN,
        ..ask(Reason::First, CurrentSlide::WhatYouDid)
    };
    assert_eq!(s.gate(hidden_first, &key, STAT_CAP), Decision::Held);
    // The next minute, shown, on a slide where a quiet minute would be Held: the owed first runs.
    assert_eq!(
        s.gate(ask(Reason::Minute, CurrentSlide::WhatYouDid), &key, STAT_CAP),
        ALL
    );
    // It was settled by that run: the minute after is quiet again.
    assert_eq!(
        s.gate(ask(Reason::Minute, CurrentSlide::WhatYouDid), &key, STAT_CAP),
        Decision::Held
    );
    // The same through focus.
    assert_eq!(s.gate(hidden_first, &key, STAT_CAP), Decision::Held);
    assert_eq!(
        s.gate(ask(Reason::Focus, CurrentSlide::WhatYouDid), &key, STAT_CAP),
        ALL
    );
    assert_eq!(
        s.gate(ask(Reason::Minute, CurrentSlide::WhatYouDid), &key, STAT_CAP),
        Decision::Held
    );
    // A hidden focus or minute owes nothing; nor does a first with no current slide (row 1).
    for owes_nothing in [
        Ask {
            shown: HIDDEN,
            ..ask(Reason::Focus, CurrentSlide::WhatYouDid)
        },
        Ask {
            shown: HIDDEN,
            ..ask(Reason::Minute, CurrentSlide::WhatYouDid)
        },
        Ask {
            current: None,
            ..hidden_first
        },
    ] {
        assert_eq!(s.gate(owes_nothing, &key, STAT_CAP), Decision::Held);
        assert_eq!(
            s.gate(ask(Reason::Minute, CurrentSlide::WhatYouDid), &key, STAT_CAP),
            Decision::Held,
            "{owes_nothing:?} owed a first"
        );
    }
}

/// Round 1, H6: with the record permanently missing, ONE ungated minute ask per key — not one per
/// unsuccessful reply, which would make a missing record a full scan every minute.
#[test]
fn a_rejected_record_leaves_one_minute_ask_ungated_per_key() {
    let mut s = ReposState::default();
    let key = key_a();
    let on = CurrentSlide::WhatYouDid;
    assert_eq!(s.gate(ask(Reason::First, on), &key, STAT_CAP), ALL);
    s.hold_all(key.clone(), doc(false, "t1"), vec![], 101, vec![], vec![]);
    // The first unchanged minute runs everything (ungated, once); its reply is rejected again.
    assert_eq!(s.gate(ask(Reason::Minute, on), &key, STAT_CAP), ALL);
    s.hold_all(key.clone(), doc(false, "t2"), vec![], 102, vec![], vec![]);
    // The second and third are quiet: the arming was spent and the same key is not re-armed.
    assert_eq!(s.gate(ask(Reason::Minute, on), &key, STAT_CAP), Decision::Held);
    assert_eq!(s.gate(ask(Reason::Minute, on), &key, STAT_CAP), Decision::Held);
    // A focus re-check with the record still missing does not re-arm it either.
    assert_eq!(s.gate(ask(Reason::Focus, on), &key, STAT_CAP), ALL);
    s.hold_all(key.clone(), doc(false, "t3"), vec![], 103, vec![], vec![]);
    assert_eq!(s.gate(ask(Reason::Minute, on), &key, STAT_CAP), Decision::Held);

    // A new key (a new page) re-arms once.
    let key_b = key_for("2026-10-25", &[("app", &["abc1234"])]);
    assert_eq!(s.gate(ask(Reason::First, on), &key_b, STAT_CAP), ALL);
    s.hold_all(key_b.clone(), doc(false, "t4"), vec![], 104, vec![], vec![]);
    assert_eq!(s.gate(ask(Reason::Minute, on), &key_b, STAT_CAP), ALL);
    s.hold_all(key_b.clone(), doc(false, "t5"), vec![], 105, vec![], vec![]);
    assert_eq!(s.gate(ask(Reason::Minute, on), &key_b, STAT_CAP), Decision::Held);

    // An accepted record arms nothing.
    let key_c = key_for("2026-10-26", &[("app", &[])]);
    assert_eq!(s.gate(ask(Reason::First, on), &key_c, STAT_CAP), ALL);
    s.hold_all(key_c.clone(), doc(true, "t6"), vec![], 106, vec![], vec![]);
    assert_eq!(s.gate(ask(Reason::Minute, on), &key_c, STAT_CAP), Decision::Held);
}

#[test]
fn a_changed_key_is_no_held_result_and_the_launchpad_minute_runs_the_status_alone() {
    let mut s = ReposState::default();
    let key = key_a();
    s.hold_all(key.clone(), doc(true, "t0"), vec![], 100, vec![], vec![]);
    assert_eq!(
        s.gate(ask(Reason::Minute, CurrentSlide::Launchpad), &key, STAT_CAP),
        UNCOMMITTED
    );
    assert_eq!(
        s.gate(ask(Reason::Minute, CurrentSlide::Suggested), &key, STAT_CAP),
        Decision::Held
    );
    // The same cards with one more token: a different key, so nothing held answers it.
    let other_tokens = key_for("2026-10-24", &[("app", &["abc1234", "def5678"])]);
    let other_branch = {
        let request = ReposRequest::new(
            ReposScope::All,
            "2026-10-24",
            vec![ReposLabel {
                key: "app".into(),
                tokens: vec!["abc1234".into()],
            }],
            vec![ReposBranch {
                key: "app".into(),
                name: "feat/y".into(),
            }],
        )
        .expect("valid");
        RequestKey::of(&request)
    };
    for other in [other_tokens, other_branch] {
        assert_ne!(other, key);
        assert_eq!(
            s.gate(ask(Reason::Minute, CurrentSlide::Suggested), &other, STAT_CAP),
            ALL
        );
        let reply = s.reply(&other, daily_briefing_gui_lib::repos::Gate::Held);
        assert_eq!(reply["gate"], "noResult", "{reply}");
    }
    // The scope is not part of the key: the uncommitted request answers the same held result.
    let same = RequestKey::of(
        &ReposRequest::new(
            ReposScope::Uncommitted,
            "2026-10-24",
            vec![ReposLabel {
                key: "app".into(),
                tokens: vec!["abc1234".into()],
            }],
            vec![ReposBranch {
                key: "app".into(),
                name: "feat/x".into(),
            }],
        )
        .expect("valid"),
    );
    assert_eq!(same, key);
}

#[test]
fn the_held_reply_carries_its_time_and_an_uncommitted_reply_changes_only_the_counts() {
    let mut s = ReposState::default();
    let key = key_a();
    s.hold_all(key.clone(), doc(true, "2026-10-24T09:10:00.000Z"), vec![], 1_000, vec![], vec![]);
    let held = s.reply(&key, daily_briefing_gui_lib::repos::Gate::Held);
    assert_eq!(held["gate"], "held");
    assert_eq!(held["heldAt"], 1_000);
    assert_eq!(held["uncommittedAt"], "2026-10-24T09:10:00.000Z");
    assert_eq!(held["unknownRepos"], json!([]));
    let before = held.clone();
    let partial = json!({
        "schemaVersion": 1, "scope": "uncommitted", "checkedAt": "2026-10-24T09:14:00.000Z",
        "repoViews": [{ "key": "rA", "uncommitted": { "unknown": true } }, { "key": "rZ", "uncommitted": { "count": 9 } }]
    });
    s.merge_uncommitted(&key, partial.as_object().expect("an object"));
    let after = s.reply(&key, daily_briefing_gui_lib::repos::Gate::Ran);
    assert_eq!(after["repoViews"][0]["uncommitted"], json!({ "unknown": true }));
    assert_eq!(after["uncommittedAt"], "2026-10-24T09:14:00.000Z");
    assert_eq!(after["checkedAt"], "2026-10-24T09:10:00.000Z");
    assert_eq!(after["repoViews"].as_array().expect("views").len(), 1, "rZ is not added");
    for field in ["record", "labels", "branchLines", "pushCards", "tile", "hidden", "heldAt"] {
        assert_eq!(after[field], before[field], "{field}");
    }
    // For another key, nothing is merged.
    let other = key_for("2026-10-25", &[]);
    s.merge_uncommitted(&other, partial.as_object().expect("an object"));
    assert_eq!(s.reply(&other, daily_briefing_gui_lib::repos::Gate::Ran)["gate"], "noResult");
}

/* ── the stat check, on scratch git repos ─────────────────────────────────────────────────────── */

/// `git` in `dir` under a scratch HOME with no system or global config, or panic with its stderr.
fn git(home: &Path, dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git")
        .args(args)
        .current_dir(dir)
        .env_clear()
        .env("PATH", std::env::var_os("PATH").unwrap_or_default())
        .env("HOME", home)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", home.join("gitconfig"))
        .env("GIT_AUTHOR_NAME", "t")
        .env("GIT_AUTHOR_EMAIL", "t@example.invalid")
        .env("GIT_COMMITTER_NAME", "t")
        .env("GIT_COMMITTER_EMAIL", "t@example.invalid")
        .output()
        .expect("git runs");
    assert!(
        out.status.success(),
        "git {args:?} failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    String::from_utf8_lossy(&out.stdout).trim_end().to_string()
}

/// A scratch repo: `git init` with `extra` init flags, one commit.
struct Repo {
    scratch: ScratchDir,
    dir: PathBuf,
}

impl Repo {
    fn new(tag: &str, init: &[&str]) -> Self {
        Self::configured(tag, init, &[])
    }

    /// `git init`, then each `git config` pair, then the one commit.
    fn configured(tag: &str, init: &[&str], config: &[(&str, &str)]) -> Self {
        let scratch = ScratchDir::new(tag);
        let dir = scratch.join("repo");
        std::fs::create_dir_all(&dir).expect("repo dir");
        std::fs::write(scratch.join("gitconfig"), "").expect("empty global config");
        let mut args = vec!["init", "-q", "-b", "main"];
        args.extend_from_slice(init);
        let r = Repo { scratch, dir };
        r.git(&args);
        for (k, v) in config {
            r.git(&["config", k, v]);
        }
        std::fs::write(r.dir.join("f"), "1").expect("a file");
        r.git(&["add", "f"]);
        r.git(&["commit", "-q", "-m", "one"]);
        r
    }

    fn git(&self, args: &[&str]) -> String {
        git(&self.scratch.path, &self.dir, args)
    }

    fn git_in(&self, dir: &Path, args: &[&str]) -> String {
        git(&self.scratch.path, dir, args)
    }

    /// The engine's own resolution (B1-M1-T2's first call): both directories absolute.
    fn target_at(&self, dir: &Path, key: &str) -> RepoStatTarget {
        let out = self.git_in(
            dir,
            &["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir"],
        );
        let mut lines = out.lines();
        let git_dir = lines.next().expect("git dir").to_string();
        let common_dir = lines.next().expect("common dir").to_string();
        let reftable = Path::new(&common_dir).join("reftable").is_dir();
        RepoStatTarget {
            key: key.into(),
            git_dir,
            common_dir,
            reftable,
        }
    }

    fn target(&self) -> RepoStatTarget {
        self.target_at(&self.dir, "rA")
    }
}

fn print(t: &RepoStatTarget) -> Fingerprint {
    stat_fingerprint(t, STAT_CAP).expect("the repo stats")
}

/// git's ref writes are lock-then-rename and its mtimes are nanoseconds; a pause well past the
/// coarsest filesystem tick keeps "changed" from depending on two writes landing in one tick.
fn tick() {
    std::thread::sleep(std::time::Duration::from_millis(20));
}

#[test]
fn the_fingerprint_paths_are_exactly_joins_of_the_strings_git_gave() {
    for (git_dir, common_dir) in [
        ("/x/repo/.git", "/x/repo/.git"),
        ("/x/main/.git/worktrees/wt", "/x/main/.git"),
        ("/x/a b/.git/", "/x/a b/.git/"),
    ] {
        for reftable in [false, true] {
            let t = RepoStatTarget {
                key: "r".into(),
                git_dir: git_dir.into(),
                common_dir: common_dir.into(),
                reftable,
            };
            let g = PathBuf::from(git_dir);
            let c = PathBuf::from(common_dir);
            let mut want = vec![
                (g.clone(), g.join("HEAD")),
                (g.clone(), g.join("index")),
                (g.clone(), g.join("logs/HEAD")),
                (c.clone(), c.join("packed-refs")),
            ];
            want.push((c.clone(), if reftable { c.join("reftable/tables.list") } else { c.join("refs") }));
            assert_eq!(stat_paths(&t), want, "{t:?}");
            // Each path lies beneath the root it is paired with, whatever the order.
            assert!(stat_paths(&t).iter().all(|(root, path)| path.starts_with(root)));
        }
    }
    // A relative directory from the engine is an error, never resolved against this process's cwd.
    let relative = RepoStatTarget {
        key: "r".into(),
        git_dir: ".git".into(),
        common_dir: ".git".into(),
        reftable: false,
    };
    assert!(stat_fingerprint(&relative, STAT_CAP).is_err());
}

#[test]
fn the_stat_check_fires_only_on_change() {
    let r = Repo::new("statchange", &[]);
    let head = r.git(&["rev-parse", "HEAD"]);
    r.git(&["update-ref", "refs/remotes/origin/main", &head]);
    r.git(&["branch", "feat/x"]);
    let t = r.target();
    let a = print(&t);
    assert!(matches!(a, Fingerprint::Full(_)));
    assert_eq!(a, print(&t), "two unchanged ticks");

    // A commit made elsewhere, so the moves below touch one ref each.
    let tree = r.git(&["rev-parse", "HEAD^{tree}"]);
    let next = r.git(&["commit-tree", &tree, "-p", &head, "-m", "two"]);

    // A push: only `refs/remotes/origin/…` moves.
    tick();
    r.git(&["update-ref", "--no-deref", "refs/remotes/origin/main", &next]);
    let b = print(&t);
    assert_ne!(a, b, "a push touching only refs/remotes/origin/main");
    assert_eq!(b, print(&t));

    // A commit on feat/x: only `refs/heads/feat/x` (and its directory) moves.
    tick();
    r.git(&["update-ref", "--no-deref", "refs/heads/feat/x", &next]);
    let c = print(&t);
    assert_ne!(b, c, "a commit on feat/x");

    // An index rewrite alone — the IDE case: it opens the gate (the stated residual).
    tick();
    let index = PathBuf::from(&t.git_dir).join("index");
    let bytes = std::fs::read(&index).expect("the index");
    std::fs::write(&index, &bytes).expect("rewritten, unchanged bytes");
    let d = print(&t);
    assert_ne!(c, d, "an index rewrite with no other change");
    let changed: Vec<&PathBuf> = c
        .entries()
        .iter()
        .zip(d.entries())
        .filter(|(x, y)| x != y)
        .map(|(x, _)| &x.path)
        .collect();
    assert_eq!(changed, [&index], "only the index entry moved");
}

#[test]
fn a_linked_worktree_is_gated_by_its_own_git_dir_and_the_common_dir() {
    let r = Repo::new("statworktree", &[]);
    let wt = r.scratch.join("wt");
    r.git(&["worktree", "add", "-q", "-b", "wt", wt.to_str().expect("utf-8")]);
    assert!(wt.join(".git").is_file(), "a linked worktree's .git is a file");
    let t = r.target_at(&wt, "rW");
    assert!(t.git_dir.contains("/worktrees/"), "{t:?}");
    assert_ne!(t.git_dir, t.common_dir);
    let a = print(&t);
    assert_eq!(a, print(&t));
    tick();
    std::fs::write(wt.join("g"), "2").expect("a file");
    r.git_in(&wt, &["add", "g"]);
    r.git_in(&wt, &["commit", "-q", "-m", "in the worktree"]);
    let b = print(&t);
    assert_ne!(a, b, "a commit in the linked worktree");
    let wt_index = PathBuf::from(&t.git_dir).join("index");
    let moved: Vec<&PathBuf> = a
        .entries()
        .iter()
        .zip(b.entries())
        .filter(|(x, y)| x != y)
        .map(|(x, _)| &x.path)
        .collect();
    assert!(moved.contains(&&wt_index), "{moved:?}");
}

#[test]
fn a_reftable_repo_is_gated_by_tables_list() {
    let probe = ScratchDir::new("reftableprobe");
    let ok = Command::new("git")
        .args(["init", "-q", "--ref-format=reftable"])
        .current_dir(&probe.path)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !ok {
        eprintln!("SKIPPED: this git has no --ref-format=reftable (git 2.45+)");
        return;
    }
    let r = Repo::new("statreftable", &["--ref-format=reftable"]);
    let t = r.target();
    assert!(t.reftable, "{t:?}");
    let tables = PathBuf::from(&t.common_dir).join("reftable/tables.list");
    let a = print(&t);
    assert!(a.entries().iter().any(|e| e.path == tables && e.stamp.is_some()));
    assert!(
        !a.entries().iter().any(|e| e.path.starts_with(PathBuf::from(&t.common_dir).join("refs"))),
        "no refs/ walk for a reftable repo: {a:?}"
    );
    assert_eq!(a, print(&t));
    tick();
    let head = r.git(&["rev-parse", "HEAD"]);
    r.git(&["update-ref", "refs/remotes/origin/main", &head]);
    assert_ne!(a, print(&t), "a ref update rewrites tables.list");
}

#[cfg(unix)]
#[test]
fn a_symlink_under_refs_is_not_followed() {
    let r = Repo::new("statsymlink", &[]);
    let t = r.target();
    let outside = r.scratch.join("outside");
    std::fs::create_dir_all(&outside).expect("outside dir");
    std::fs::write(outside.join("a"), "x").expect("a file outside");
    let link = PathBuf::from(&t.common_dir).join("refs/heads/link");
    std::os::unix::fs::symlink(&outside, &link).expect("a symlinked directory under refs/heads");
    let a = print(&t);
    assert!(a.entries().iter().any(|e| e.path == link), "the link itself is an entry");
    assert!(
        !a.entries().iter().any(|e| e.path.starts_with(&link) && e.path != link),
        "the walk descended the symlink: {a:?}"
    );
    tick();
    std::fs::write(outside.join("a"), "changed").expect("rewrite outside");
    std::fs::write(outside.join("b"), "new").expect("a new file outside");
    assert_eq!(a, print(&t), "a change behind the symlink is not seen");
}

#[test]
fn a_repo_over_the_cap_always_requires_a_check_instead_of_using_partial_directory_times() {
    let r = Repo::new("statcap", &[]);
    let head = r.git(&["rev-parse", "HEAD"]);
    for i in 0..12 {
        r.git(&["update-ref", &format!("refs/tags/t{i}"), &head]);
    }
    let t = r.target();
    for _ in 0..3 {
        assert_eq!(stat_fingerprint(&t, 5).unwrap(), Fingerprint::OverCap);
    }
    assert!(matches!(print(&t), Fingerprint::Full(_)));
}

#[test]
fn an_absent_file_is_an_entry_and_its_appearance_is_a_change() {
    // A fresh repo with one commit has no packed-refs; with core.logAllRefUpdates=false, no logs/HEAD.
    let r = Repo::new("statabsent", &[]);
    let no_logs = Repo::configured("statnologs", &[], &[("core.logAllRefUpdates", "false")]);
    for (repo, absent) in [(&r, "packed-refs"), (&no_logs, "logs/HEAD")] {
        let t = repo.target();
        let path = if absent == "packed-refs" {
            PathBuf::from(&t.common_dir).join(absent)
        } else {
            PathBuf::from(&t.git_dir).join(absent)
        };
        assert!(!path.exists(), "{path:?} exists");
        let a = print(&t);
        let entry = a.entries().iter().find(|e| e.path == path).expect("an entry for it");
        assert_eq!(entry.stamp, None, "absent");
        assert_eq!(a, print(&t), "two ticks, no change");
        assert_eq!(a, print(&t));
    }
    // packed-refs appearing is a change.
    let t = r.target();
    let a = print(&t);
    tick();
    r.git(&["pack-refs", "--all"]);
    assert!(PathBuf::from(&t.common_dir).join("packed-refs").exists());
    assert_ne!(a, print(&t), "packed-refs appeared");
}

/// A stat error is a change ONCE; after that the repo alone is `unknown` (listed in `unknownRepos`)
/// while the others keep their gate.
#[cfg(unix)]
#[test]
fn a_permission_error_is_a_change_once_then_that_repo_alone_is_unknown() {
    use std::os::unix::fs::PermissionsExt;
    let bad = Repo::new("staterr", &[]);
    let good = Repo::new("statok", &[]);
    let tb = bad.target_at(&bad.dir, "rBad");
    let tg = good.target_at(&good.dir, "rGood");
    let key = key_a();
    let mut s = ReposState::default();
    let on = CurrentSlide::WhatYouDid;
    assert_eq!(s.gate(ask(Reason::First, on), &key, STAT_CAP), ALL);
    let before = vec![(tb.clone(), Some(print(&tb))), (tg.clone(), Some(print(&tg)))];
    s.hold_all(key.clone(), doc(true, "t0"), vec![tb.clone(), tg.clone()], 1, before, vec![]);
    assert_eq!(s.gate(ask(Reason::Minute, on), &key, STAT_CAP), Decision::Held, "quiet");

    let heads = PathBuf::from(&tb.common_dir).join("refs/heads");
    std::fs::set_permissions(&heads, std::fs::Permissions::from_mode(0o000)).expect("chmod 000");
    struct Restore(PathBuf);
    impl Drop for Restore {
        fn drop(&mut self) {
            let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
        }
    }
    let _restore = Restore(heads.clone());
    if std::fs::read_dir(&heads).is_ok() {
        eprintln!("SKIPPED: running with permissions that ignore chmod 000");
        return;
    }
    assert!(stat_fingerprint(&tb, STAT_CAP).is_err(), "the unreadable refs/heads is an error");
    // The first error is a change: everything runs.
    assert_eq!(s.gate(ask(Reason::Minute, on), &key, STAT_CAP), ALL);
    let before = s.prints_before_run(STAT_CAP);
    s.hold_all(key.clone(), doc(true, "t1"), vec![tb.clone(), tg.clone()], 2, before, vec![]);
    let reply = s.reply(&key, daily_briefing_gui_lib::repos::Gate::Ran);
    assert_eq!(reply["unknownRepos"], json!(["rBad"]));
    // After that, the error alone is not a change: quiet again, the bad repo still unknown.
    assert_eq!(s.gate(ask(Reason::Minute, on), &key, STAT_CAP), Decision::Held);
    assert_eq!(s.reply(&key, daily_briefing_gui_lib::repos::Gate::Held)["unknownRepos"], json!(["rBad"]));
    // …while the other repo keeps its own gate: a change there opens it.
    tick();
    let head = good.git(&["rev-parse", "HEAD"]);
    good.git(&["update-ref", "refs/remotes/origin/main", &head]);
    assert_eq!(s.gate(ask(Reason::Minute, on), &key, STAT_CAP), ALL);
}

/* ── B1-M4-T13: the command, through its inner function, against a fake sidecar ───────────────── */
//
// `repos::status` is what `repos_status` calls; the tests call it directly with an injected clock
// (`LiveEnv::with_clock`), a visibility closure the test flips, and a fake sidecar that records each
// spawn's stdin (`stdin.<n>`), appends a line per spawn to `count`, blocks while a `hold` file exists,
// and answers a canned `uncommitted.json` for an uncommitted request and `all.json` otherwise.

mod command {
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    use super::common::{fake_sidecar, sq, ScratchDir};
    use daily_briefing_gui_lib::engine::{EngineClient, EngineError};
    use daily_briefing_gui_lib::live_gate::{LiveEnv, Visibility};
    use daily_briefing_gui_lib::repos::{status, ReposIpcReply, ReposIpcRequest, ReposLive};
    use daily_briefing_gui_lib::schedule_state::Now;
    use serde_json::{json, Value};

    pub struct Rig {
        pub scratch: ScratchDir,
        pub client: EngineClient,
        pub env: LiveEnv,
        pub live: ReposLive,
        pub shown: Arc<AtomicBool>,
        pub clock: Arc<AtomicI64>,
    }

    impl Rig {
        pub fn new(tag: &str) -> Self {
            let scratch = ScratchDir::new(tag);
            let dir = scratch.path.display().to_string();
            let body = format!(
                "d={d}\nn=$(cat \"$d/count\" 2>/dev/null | wc -l | tr -d ' ')\necho x >> \"$d/count\"\n\
                 cat > \"$d/stdin.$n\"\nwhile [ -e \"$d/hold\" ]; do sleep 0.02; done\n\
                 if [ -e \"$d/fail\" ]; then echo 'secret stderr /Users/someone/repo' >&2; exit 1; fi\n\
                 if grep -q '\"scope\":\"uncommitted\"' \"$d/stdin.$n\"; then cat \"$d/uncommitted.json\"; else cat \"$d/all.json\"; fi",
                d = sq(&dir)
            );
            let program = fake_sidecar(&scratch.path, "engine.sh", &body);
            let shown = Arc::new(AtomicBool::new(true));
            let clock = Arc::new(AtomicI64::new(1_000));
            let (s, c) = (shown.clone(), clock.clone());
            let env = LiveEnv::default()
                .with_visibility(Arc::new(move || Visibility {
                    visible: s.load(Ordering::SeqCst),
                    minimized: false,
                }))
                .with_clock(Arc::new(move || Now {
                    local_date: "2026-10-24".into(),
                    minutes: 600,
                    epoch_secs: c.load(Ordering::SeqCst),
                }));
            let rig = Rig {
                scratch,
                client: EngineClient::with_program(program),
                env,
                live: ReposLive::default(),
                shown,
                clock,
            };
            let mut initial = all_doc(true, "2026-10-24T09:10:00.000Z", &rig.scratch.path);
            initial["repos"] = json!([]); // Quiet gate fixtures have no newly discovered targets.
            rig.answer_all(&initial);
            rig.answer_uncommitted(&json!({
                "schemaVersion": 1, "scope": "uncommitted", "checkedAt": "2026-10-24T09:14:00.000Z",
                "repoViews": [{ "key": "rA", "uncommitted": { "count": 7 } }]
            }));
            rig
        }

        pub fn answer_all(&self, doc: &Value) {
            std::fs::write(self.scratch.join("all.json"), doc.to_string()).expect("all.json");
        }

        pub fn answer_uncommitted(&self, doc: &Value) {
            std::fs::write(self.scratch.join("uncommitted.json"), doc.to_string())
                .expect("uncommitted.json");
        }

        pub fn spawns(&self) -> usize {
            std::fs::read_to_string(self.scratch.join("count"))
                .map(|s| s.lines().count())
                .unwrap_or(0)
        }

        pub fn stdin(&self, n: usize) -> Value {
            let text = std::fs::read_to_string(self.scratch.join(&format!("stdin.{n}")))
                .unwrap_or_else(|e| panic!("stdin.{n}: {e}"));
            serde_json::from_str(&text).expect("the request is JSON")
        }

        pub fn hold(&self) -> PathBuf {
            let p = self.scratch.join("hold");
            std::fs::write(&p, "").expect("hold");
            p
        }

        pub async fn ask(&self, body: Value) -> Result<ReposIpcReply, EngineError> {
            let request: ReposIpcRequest =
                serde_json::from_value(body).expect("a well-formed IPC request");
            let shown = self.shown.clone();
            tokio::time::timeout(
                Duration::from_secs(20),
                status(
                    &self.client,
                    &self.env,
                    move || Visibility {
                        visible: shown.load(Ordering::SeqCst),
                        minimized: false,
                    },
                    &self.live,
                    request,
                ),
            )
            .await
            .expect("the ask answered")
        }
    }

    /// The IPC request for `reason` on `current`, for the cards in `labels`.
    pub fn req(reason: &str, current: Value, labels: Value) -> Value {
        json!({
            "labels": labels,
            "branches": [{ "key": "app", "name": "feat/x" }],
            "pageDate": "2026-10-24",
            "reason": reason,
            "current": current,
        })
    }

    pub fn cards() -> Value {
        json!([{ "key": "app", "tokens": ["abc1234"] }, { "key": "", "tokens": [] }])
    }

    /// A canned `all` document, with an engine-only `repos` list naming paths under `root`, and
    /// members the reply types do not declare at three depths.
    pub fn all_doc(accepted: bool, checked_at: &str, root: &Path) -> Value {
        let r = root.display().to_string();
        json!({
            "schemaVersion": 1,
            "scope": "all",
            "checkedAt": checked_at,
            "record": { "accepted": accepted, "windowStartUtc": "2026-10-23T22:00:00.000Z" },
            "windowStartUtc": "2026-10-23T22:00:00.000Z",
            "repoViews": [{ "key": "rA", "name": "app", "state": "ok", "noRemote": false,
                            "uncommitted": { "count": 2 }, "storeKey": "s0123456789ab", "treeKey": "t0123456789ab",
                            "message": format!("fatal: {r}/repo") }],
            "labels": [{ "key": "app", "repoKey": "rA", "state": "ok", "notMatched": 0, "prNumbers": [12],
                         "onlyHere": 1, "rows": [
                { "kind": "pr", "number": 12, "title": "Add the thing", "commits": [{ "sha": "abc1234def", "token": "abc1234" }] },
                { "kind": "branch", "name": "feat/x", "push": { "state": "partly", "notPushed": 1 },
                  "ref": "refs/heads/feat/x", "commits": [{ "sha": "0123456789", "token": null, "subject": "hidden one", "rawSubject": "raw" }] }
            ] }],
            "branchLines": [{ "key": "app", "name": "feat/x", "state": "live", "notPushed": 1, "neverPushed": false, "behind": 0 }],
            "pushCards": [{ "repoKey": "rA", "storeKey": "s0123456789ab", "firstLabel": "app", "repoName": "app",
                            "branches": [{ "name": "feat/x", "commits": 1 }], "onDefault": null }],
            "tile": { "commits": 1, "branches": 1 },
            "hidden": { "complete": true, "perLabel": { "app": 1, "bad": "x" } },
            "debugPath": format!("{r}/repo/.git"),
            "repos": [{ "key": "rA", "path": format!("{r}/repo"), "gitDir": format!("{r}/repo/.git"),
                        "commonDir": format!("{r}/repo/.git"), "reftable": false }]
        })
    }

    /// Every string in `v`, at every depth, keys included.
    pub fn strings(v: &Value, out: &mut Vec<String>) {
        match v {
            Value::String(s) => out.push(s.clone()),
            Value::Array(a) => a.iter().for_each(|x| strings(x, out)),
            Value::Object(m) => {
                for (k, x) in m {
                    out.push(k.clone());
                    strings(x, out);
                }
            }
            _ => {}
        }
    }
}

use command::{all_doc, cards, req, strings, Rig};

/// Wait (bounded) until `cond` holds.
async fn until(what: &str, cond: impl Fn() -> bool) {
    for _ in 0..500 {
        if cond() {
            return;
        }
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;
    }
    panic!("timed out waiting for {what}");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn focus_forces_a_check_and_a_gated_out_minute_gets_the_held_reply_with_its_time() {
    let rig = Rig::new("cmdfocus");
    let first = rig.ask(req("first", json!("whatYouDid"), cards())).await.expect("first");
    assert_eq!(first.0["gate"], "ran");
    assert_eq!(first.0["heldAt"], 1_000);
    assert_eq!(rig.spawns(), 1);
    // The request reached the engine whole, on stdin, scope `all`.
    assert_eq!(
        rig.stdin(0),
        json!({ "scope": "all", "pageDate": "2026-10-24", "labels": cards(),
                "branches": [{ "key": "app", "name": "feat/x" }] })
    );
    rig.clock.store(2_000, std::sync::atomic::Ordering::SeqCst);
    // A quiet minute on What you did: the held reply, unchanged, with its own time.
    let minute = rig.ask(req("minute", json!("whatYouDid"), cards())).await.expect("minute");
    assert_eq!(rig.spawns(), 1, "a quiet minute spawned");
    assert_eq!(minute.0["gate"], "held");
    assert_eq!(minute.0["heldAt"], 1_000);
    let mut a = first.0.clone();
    let mut b = minute.0.clone();
    a.as_object_mut().unwrap().remove("gate");
    b.as_object_mut().unwrap().remove("gate");
    assert_eq!(a, b, "the held reply is unchanged");
    // Focus forces a check, whatever the stat gate says.
    let focus = rig.ask(req("focus", json!("whatYouDid"), cards())).await.expect("focus");
    assert_eq!(rig.spawns(), 2);
    assert_eq!(focus.0["gate"], "ran");
    assert_eq!(focus.0["heldAt"], 2_000);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn no_current_slide_or_a_hidden_window_spawns_nothing_and_the_next_focus_runs() {
    let rig = Rig::new("cmdhidden");
    for reason in ["first", "focus", "minute"] {
        let r = rig.ask(req(reason, Value::Null, cards())).await.expect("asked");
        assert_eq!(r.0["gate"], "noResult", "{reason}: {}", r.0);
    }
    rig.shown.store(false, std::sync::atomic::Ordering::SeqCst);
    for reason in ["first", "focus", "minute"] {
        let r = rig.ask(req(reason, json!("launchpad"), cards())).await.expect("asked");
        assert_eq!(r.0["gate"], "noResult", "{reason}");
    }
    assert_eq!(rig.spawns(), 0, "nothing ran for the slides off, the Full briefing view or a hidden window");
    // A noResult reply carries nothing of the engine's.
    let r = rig.ask(req("minute", Value::Null, cards())).await.expect("asked");
    let mut keys: Vec<String> = r.0.as_object().unwrap().keys().cloned().collect();
    keys.sort();
    assert_eq!(keys, ["gate", "heldAt", "uncommittedAt", "unknownRepos"]);
    rig.shown.store(true, std::sync::atomic::Ordering::SeqCst);
    let r = rig.ask(req("focus", json!("whatYouDid"), cards())).await.expect("focus");
    assert_eq!(r.0["gate"], "ran");
    assert_eq!(rig.spawns(), 1);
}

/// Round 4, R4-M3: the waiter re-samples the window after taking the lock, so a window hidden
/// during the wait gets `Held` and no second scan.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_first_that_waits_on_an_in_flight_run_while_the_window_hides_answers_held() {
    let rig = Rig::new("cmdwaithide");
    let hold = rig.hold();
    let running = rig.ask(req("focus", json!("whatYouDid"), cards()));
    let waiting = rig.ask(req("first", json!("whatYouDid"), cards()));
    let driver = async {
        until("the first spawn and the owed waiter", || rig.spawns() == 1 && rig.live.is_owed()).await;
        rig.shown.store(false, std::sync::atomic::Ordering::SeqCst);
        std::fs::remove_file(&hold).expect("release");
    };
    let (ran, waited, ()) = tokio::join!(running, waiting, driver);
    assert_eq!(ran.expect("ran").0["gate"], "ran");
    let waited = waited.expect("waited");
    assert_eq!(waited.0["gate"], "held", "{}", waited.0);
    assert_eq!(rig.spawns(), 1, "no second scan for a hidden window");
    // The hidden first is owed: the next shown minute runs it.
    rig.shown.store(true, std::sync::atomic::Ordering::SeqCst);
    let r = rig.ask(req("minute", json!("whatYouDid"), cards())).await.expect("minute");
    assert_eq!(r.0["gate"], "ran");
    assert_eq!(rig.spawns(), 2);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn two_focus_asks_racing_for_the_waiting_slot_one_waits_and_one_is_held() {
    let rig = Rig::new("cmdrace");
    rig.ask(req("first", json!("whatYouDid"), cards())).await.expect("first");
    let hold = rig.hold();
    let running = rig.ask(req("focus", json!("whatYouDid"), cards()));
    let a = rig.ask(req("focus", json!("whatYouDid"), cards()));
    let b = rig.ask(req("focus", json!("whatYouDid"), cards()));
    let driver = async {
        until("the in-flight spawn and one waiter", || rig.spawns() == 2 && rig.live.is_owed()).await;
        // Give the other asker every chance to wait too, then release.
        tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        std::fs::remove_file(&hold).expect("release");
    };
    let (ran, a, b, ()) = tokio::join!(running, a, b, driver);
    assert_eq!(ran.expect("ran").0["gate"], "ran");
    let mut gates = vec![
        a.expect("a").0["gate"].as_str().unwrap().to_string(),
        b.expect("b").0["gate"].as_str().unwrap().to_string(),
    ];
    gates.sort();
    assert_eq!(gates, ["held", "ran"], "exactly one asker waited and ran");
    assert_eq!(rig.spawns(), 3);
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_first_during_an_in_flight_run_is_owed_and_runs_after_it_with_its_own_key() {
    let rig = Rig::new("cmdowed");
    let hold = rig.hold();
    let new_cards = json!([{ "key": "app", "tokens": ["abc1234", "def5678"] }]);
    let third_cards = json!([{ "key": "other", "tokens": [] }]);
    let running = rig.ask(req("first", json!("whatYouDid"), cards()));
    let owed = rig.ask(req("first", json!("whatYouDid"), new_cards.clone()));
    let late = async {
        until("the in-flight spawn and the owed waiter", || rig.spawns() == 1 && rig.live.is_owed()).await;
        // A second waiter while the slot is taken, and a minute ask: both answered at once.
        let second = rig.ask(req("first", json!("whatYouDid"), third_cards.clone())).await;
        let minute = rig.ask(req("minute", json!("whatYouDid"), cards())).await;
        assert_eq!(rig.spawns(), 1, "neither waited for the run");
        std::fs::remove_file(&hold).expect("release");
        (second, minute)
    };
    let (ran, owed, (second, minute)) = tokio::join!(running, owed, late);
    assert_eq!(ran.expect("ran").0["gate"], "ran");
    assert_eq!(owed.expect("owed").0["gate"], "ran");
    assert_eq!(second.expect("second").0["gate"], "noResult", "nothing held for its key");
    assert_eq!(minute.expect("minute").0["gate"], "noResult", "the run in flight had not answered yet");
    assert_eq!(rig.spawns(), 2);
    assert_eq!(rig.stdin(1)["labels"], new_cards, "the second run is the new key's");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_missing_record_leaves_the_next_minute_ungated_once() {
    let rig = Rig::new("cmdungated");
    let mut missing_record = all_doc(false, "2026-10-24T09:10:00.000Z", &rig.scratch.path);
    missing_record["repos"] = json!([]);
    rig.answer_all(&missing_record);
    rig.ask(req("first", json!("whatYouDid"), cards())).await.expect("first");
    let r = rig.ask(req("minute", json!("whatYouDid"), cards())).await.expect("minute");
    assert_eq!(r.0["gate"], "ran");
    assert_eq!(rig.spawns(), 2, "the one ungated minute");
    for _ in 0..2 {
        let r = rig.ask(req("minute", json!("whatYouDid"), cards())).await.expect("minute");
        assert_eq!(r.0["gate"], "held");
    }
    assert_eq!(rig.spawns(), 2, "the arming was spent");
}

/// Round 1, M15: a quiet launchpad minute runs `scope: "uncommitted"`, and its reply changes only
/// the counts and `uncommittedAt`.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_quiet_launchpad_minute_runs_the_status_alone_and_merges_only_the_counts() {
    let rig = Rig::new("cmduncommitted");
    let full = rig.ask(req("first", json!("launchpad"), cards())).await.expect("first");
    assert_eq!(full.0["uncommittedAt"], "2026-10-24T09:10:00.000Z");
    let part = rig.ask(req("minute", json!("launchpad"), cards())).await.expect("minute");
    assert_eq!(rig.spawns(), 2);
    assert_eq!(rig.stdin(1)["scope"], "uncommitted");
    assert_eq!(rig.stdin(1)["labels"], cards(), "the same request, another scope");
    assert_eq!(part.0["gate"], "ran");
    assert_eq!(part.0["repoViews"][0]["uncommitted"], json!({ "count": 7 }));
    assert_eq!(part.0["uncommittedAt"], "2026-10-24T09:14:00.000Z");
    for field in ["checkedAt", "record", "windowStartUtc", "labels", "branchLines", "pushCards", "tile", "hidden", "heldAt"] {
        assert_eq!(part.0[field], full.0[field], "{field} changed");
    }
    let (mut a, mut b) = (full.0["repoViews"][0].clone(), part.0["repoViews"][0].clone());
    a.as_object_mut().unwrap().remove("uncommitted");
    b.as_object_mut().unwrap().remove("uncommitted");
    assert_eq!(a, b, "only the count moved in the repo view");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_changed_key_answers_no_result_until_its_own_run_answers() {
    let rig = Rig::new("cmdnewkey");
    rig.ask(req("first", json!("whatYouDid"), cards())).await.expect("first");
    let new_cards = json!([{ "key": "app", "tokens": ["fff0000"] }]);
    rig.shown.store(false, std::sync::atomic::Ordering::SeqCst);
    let r = rig.ask(req("first", json!("whatYouDid"), new_cards.clone())).await.expect("hidden");
    assert_eq!(r.0["gate"], "noResult", "the old key's reply does not answer the new key");
    rig.shown.store(true, std::sync::atomic::Ordering::SeqCst);
    let r = rig.ask(req("minute", json!("whatYouDid"), new_cards)).await.expect("minute");
    assert_eq!(r.0["gate"], "ran", "the owed first ran for the new key");
    assert_eq!(rig.spawns(), 2);
}

/// What crosses into the webview: no `repos`, no path, and no member the reply types do not declare
/// (a raw refname, a raw subject, an error's message text), at any depth.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn the_reply_carries_no_repos_no_path_and_no_undeclared_member() {
    let rig = Rig::new("cmdscrub");
    let r = rig.ask(req("first", json!("whatYouDid"), cards())).await.expect("first");
    let reply = &r.0;
    assert!(reply.get("repos").is_none());
    let mut all = Vec::new();
    strings(reply, &mut all);
    let root = rig.scratch.path.display().to_string();
    for s in &all {
        assert!(!s.contains(&root), "a path reached the reply: {s}");
        assert!(!s.contains("refs/heads"), "a raw refname reached the reply: {s}");
        assert!(!s.contains("fatal:"), "an error's text reached the reply: {s}");
    }
    for undeclared in ["repos", "debugPath", "message", "ref", "rawSubject", "path", "gitDir"] {
        assert!(!all.iter().any(|s| s == undeclared), "{undeclared} reached the reply");
    }
    assert_eq!(reply["hidden"]["perLabel"], json!({ "app": 1 }), "a non-number count is dropped");
    // The declared ones are all still there.
    assert_eq!(reply["labels"][0]["rows"][1]["commits"][0]["subject"], "hidden one");
    assert_eq!(reply["labels"][0]["rows"][0]["title"], "Add the thing");
    assert_eq!(reply["repoViews"][0]["name"], "app");
    // final4 M1/L2: the path-free store and tree keys cross; the common dir they hash does not.
    assert_eq!(reply["repoViews"][0]["storeKey"], "s0123456789ab");
    assert_eq!(reply["repoViews"][0]["treeKey"], "t0123456789ab");
    assert_eq!(reply["pushCards"][0]["storeKey"], "s0123456789ab");
    assert!(!all.iter().any(|s| s == "commonDir"), "commonDir reached the reply");
}

/// A failed engine run is an error, its stderr never echoed, and what was held stays held.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_failed_run_is_an_error_and_the_held_reply_stays() {
    let rig = Rig::new("cmdfail");
    rig.ask(req("first", json!("whatYouDid"), cards())).await.expect("first");
    std::fs::write(rig.scratch.join("fail"), "").expect("fail");
    let err = rig
        .ask(req("focus", json!("whatYouDid"), cards()))
        .await
        .expect_err("a failed run");
    let text = serde_json::to_string(&err).expect("serialises");
    assert!(!text.contains("/Users/someone"), "stderr was echoed: {text}");
    assert!(!text.contains("secret"), "stderr was echoed: {text}");
    std::fs::remove_file(rig.scratch.join("fail")).expect("unfail");
    let held = rig.ask(req("minute", json!("whatYouDid"), cards())).await.expect("minute");
    assert_eq!(held.0["gate"], "held");
    assert_eq!(held.0["heldAt"], 1_000);
    // A reply of the wrong shape is refused the same way.
    rig.answer_all(&json!({ "schemaVersion": 2, "scope": "all" }));
    assert!(rig.ask(req("focus", json!("whatYouDid"), cards())).await.is_err());
    rig.answer_all(&json!({ "schemaVersion": 1, "scope": "uncommitted", "repoViews": [] }));
    assert!(rig.ask(req("focus", json!("whatYouDid"), cards())).await.is_err());
}

/// The IPC request is closed (`deny_unknown_fields`) and validated before anything runs.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn the_ipc_request_is_closed_and_validated_before_any_spawn() {
    let rig = Rig::new("cmdinvalid");
    let mut extra = req("first", json!("whatYouDid"), cards());
    extra["scope"] = json!("all");
    assert!(serde_json::from_value::<daily_briefing_gui_lib::repos::ReposIpcRequest>(extra).is_err(), "the webview cannot choose the scope");
    let mut bad_card = req("first", json!("whatYouDid"), cards());
    bad_card["labels"][0]["extra"] = json!(1);
    assert!(serde_json::from_value::<daily_briefing_gui_lib::repos::ReposIpcRequest>(bad_card).is_err());
    let err = rig
        .ask(req("first", json!("whatYouDid"), json!([{ "key": "app", "tokens": ["xyz"] }])))
        .await
        .expect_err("a non-hex token");
    assert!(matches!(err, daily_briefing_gui_lib::engine::EngineError::InvalidInput { .. }), "{err:?}");
    let mut bad_date = req("first", json!("whatYouDid"), cards());
    bad_date["pageDate"] = json!("2026-02-30");
    let request = serde_json::from_value(bad_date).expect("well-formed");
    let err = daily_briefing_gui_lib::repos::status(
        &rig.client,
        &rig.env,
        || Visibility { visible: true, minimized: false },
        &rig.live,
        request,
    )
    .await
    .expect_err("an impossible date");
    assert!(matches!(err, daily_briefing_gui_lib::engine::EngineError::InvalidInput { .. }), "{err:?}");
    assert_eq!(rig.spawns(), 0);
}


// B1-M4 hardening: each regression is also run against its matching disposable mutant.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn resolution_failure_through_the_command_is_fixed_and_path_free() {
    use daily_briefing_gui_lib::engine::{Engine, EngineError};
    use daily_briefing_gui_lib::live_gate::LiveEnv;
    use daily_briefing_gui_lib::repos::{repos_status, ReposLive};
    use tauri::Manager;
    let app = tauri::test::mock_builder()
        .manage(Engine(Err(EngineError::SidecarUnresolved {
            detail: "/private/secret/sidecar: missing".into(),
        })))
        .manage(LiveEnv::default())
        .manage(ReposLive::default())
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .expect("mock app");
    let err = repos_status(
        app.handle().clone(),
        app.state(),
        app.state(),
        app.state(),
        serde_json::from_value(req("first", json!("whatYouDid"), cards())).unwrap(),
    )
    .await
    .expect_err("resolution failed");
    assert_eq!(
        serde_json::to_value(err).unwrap(),
        json!({
            "kind": "spawn", "detail": "the live git check could not be completed"
        })
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn invocation_failure_through_status_is_fixed_and_path_free() {
    use daily_briefing_gui_lib::engine::EngineClient;
    let rig = Rig::new("spawnfailure");
    rig.ask(req("first", json!("whatYouDid"), cards()))
        .await
        .unwrap();
    let missing = EngineClient::with_program(rig.scratch.join("private-sidecar-missing"))
        .with_caffeinate_path(rig.scratch.join("missing-caffeinate"));
    let err = daily_briefing_gui_lib::repos::status(
        &missing,
        &rig.env,
        || SHOWN,
        &rig.live,
        serde_json::from_value(req("focus", json!("whatYouDid"), cards())).unwrap(),
    )
    .await
    .expect_err("spawn failed");
    assert_eq!(
        serde_json::to_value(err).unwrap(),
        json!({
            "kind": "spawn", "detail": "the live git check could not be completed"
        })
    );
    assert_eq!(
        rig.ask(req("minute", json!("whatYouDid"), cards()))
            .await
            .unwrap()
            .0["heldAt"],
        1000
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn reply_members_are_filtered_by_context_and_reason_codes_are_closed() {
    let rig = Rig::new("contexts");
    let mut d = all_doc(true, "t0", &rig.scratch.path);
    d["record"]["subject"] = json!("/private/secret");
    d["record"]["count"] = json!(42);
    d["tile"]["title"] = json!("wrong depth");
    d["labels"][0]["rows"][0]["name"] = json!("wrong pr variant");
    d["repoViews"][0]["subject"] = json!("wrong view");
    rig.answer_all(&d);
    let r = rig
        .ask(req("first", json!("whatYouDid"), cards()))
        .await
        .unwrap()
        .0;
    assert!(r["record"].get("subject").is_none());
    assert!(r["record"].get("count").is_none());
    assert!(r["tile"].get("title").is_none());
    assert!(r["labels"][0]["rows"][0].get("name").is_none());
    assert!(r["repoViews"][0].get("subject").is_none());
    for reason in [
        "git-too-old",
        "dubious-ownership",
        "required-filter",
        "partial-clone",
        "elsewhere",
        "timeout",
        "budget",
        "error",
    ] {
        d["repoViews"][0]["state"] = json!("unknown");
        d["repoViews"][0]["reason"] = json!(reason);
        rig.answer_all(&d);
        assert_eq!(
            rig.ask(req("focus", json!("whatYouDid"), cards()))
                .await
                .unwrap()
                .0["repoViews"][0]["reason"],
            reason
        );
    }
    d["repoViews"][0]["reason"] = json!("timeout");
    d["repoViews"][0]["storeKey"] = Value::Null;
    d["repoViews"][0]["treeKey"] = Value::Null;
    rig.answer_all(&d);
    let r = rig.ask(req("focus", json!("whatYouDid"), cards())).await.unwrap().0;
    assert_eq!((r["repoViews"][0]["storeKey"].clone(), r["repoViews"][0]["treeKey"].clone()), (Value::Null, Value::Null));
    for pointer in ["/repoViews/0/storeKey", "/pushCards/0/storeKey"] {
        let mut ok = all_doc(true, "t0", &rig.scratch.path);
        *ok.pointer_mut(pointer).unwrap() = Value::Null;
        rig.answer_all(&ok);
        assert!(rig.ask(req("focus", json!("whatYouDid"), cards())).await.is_err(), "{pointer} null on an ok view or a card");
    }
    for reason in [
        json!("fatal: /private/secret"),
        json!(123),
        json!({"error": "raw"}),
    ] {
        d["repoViews"][0]["reason"] = reason;
        rig.answer_all(&d);
        assert!(
            rig.ask(req("focus", json!("whatYouDid"), cards()))
                .await
                .is_err(),
            "free text or mistyped reason passed"
        );
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn missing_or_mistyped_required_fields_preserve_the_held_reply_for_both_scopes() {
    let rig = Rig::new("required");
    let held = rig
        .ask(req("first", json!("whatYouDid"), cards()))
        .await
        .unwrap()
        .0;
    let valid = all_doc(true, "t1", &rig.scratch.path);
    for field in [
        "checkedAt",
        "record",
        "windowStartUtc",
        "repoViews",
        "labels",
        "branchLines",
        "pushCards",
        "tile",
        "hidden",
        "repos",
    ] {
        for missing in [true, false] {
            let mut d = valid.clone();
            if missing {
                d.as_object_mut().unwrap().remove(field);
            } else {
                d[field] = json!(42);
            }
            rig.answer_all(&d);
            let err = rig
                .ask(req("focus", json!("whatYouDid"), cards()))
                .await
                .expect_err(field);
            assert_eq!(
                serde_json::to_value(err).unwrap()["detail"],
                "the live git check could not be completed"
            );
            let mut after = rig
                .ask(req("minute", json!("whatYouDid"), cards()))
                .await
                .unwrap()
                .0;
            after["gate"] = json!("ran");
            assert_eq!(after, held, "held changed for {field}, missing={missing}");
        }
    }
    for (pointer, value) in [
        ("/record/accepted", json!("yes")),
        ("/record/windowStartUtc", json!(false)),
        ("/repoViews/0/uncommitted/count", json!("2")),
        ("/repoViews/0/noRemote", json!(0)),
        ("/labels/0/notMatched", json!(-1)),
        ("/labels/0/prNumbers/0", json!("12")),
        ("/labels/0/rows/0/number", json!(false)),
        ("/tile/commits", json!("1")),
        ("/repos/0/path", json!(false)),
        ("/repos/0/reftable", json!("false")),
    ] {
        let mut d = valid.clone();
        *d.pointer_mut(pointer).unwrap() = value;
        rig.answer_all(&d);
        assert!(
            rig.ask(req("focus", json!("whatYouDid"), cards()))
                .await
                .is_err(),
            "{pointer}"
        );
    }
    for field in ["checkedAt", "repoViews"] {
        for missing in [true, false] {
            let mut d = json!({"schemaVersion": 1, "scope": "uncommitted", "checkedAt": "t2", "repoViews": [{"key": "rA", "uncommitted": {"count": 9}}]});
            if missing {
                d.as_object_mut().unwrap().remove(field);
            } else {
                d[field] = json!(42);
            }
            rig.answer_uncommitted(&d);
            assert!(
                rig.ask(req("minute", json!("launchpad"), cards()))
                    .await
                    .is_err(),
                "{field}"
            );
            let mut after = rig
                .ask(req("minute", json!("whatYouDid"), cards()))
                .await
                .unwrap()
                .0;
            after["gate"] = json!("ran");
            assert_eq!(after, held);
        }
    }
}

#[test]
fn a_target_discovered_during_a_run_requires_a_followup_even_if_its_ref_changed_before_the_reply() {
    let r = Repo::new("newtarget", &[]);
    let t = r.target();
    let key = key_a();
    let mut s = ReposState::default();
    let before = s.prints_before_run(STAT_CAP);
    let old = print(&t); // The engine read this state.
    tick();
    std::fs::write(
        Path::new(&t.common_dir).join("refs/heads/main"),
        "changed during first run",
    )
    .unwrap();
    assert_ne!(old, print(&t));
    s.hold_all(
        key.clone(),
        doc(true, "old answer"),
        vec![t.clone()],
        1,
        before,
        vec![],
    );
    assert_eq!(
        s.gate(
            ask(Reason::Minute, CurrentSlide::WhatYouDid),
            &key,
            STAT_CAP
        ),
        ALL
    );
    let before = s.prints_before_run(STAT_CAP);
    s.hold_all(
        key.clone(),
        doc(true, "fresh answer"),
        vec![t],
        2,
        before,
        vec![],
    );
    assert_eq!(
        s.gate(
            ask(Reason::Minute, CurrentSlide::WhatYouDid),
            &key,
            STAT_CAP
        ),
        Decision::Held
    );
}

#[test]
fn an_unknown_repo_keeps_omitted_targets_and_recovers_on_a_later_ref_change() {
    let r = Repo::new("omitted", &[]);
    let t = r.target();
    let key = key_a();
    let mut s = ReposState::default();
    s.hold_all(
        key.clone(),
        doc(true, "ok"),
        vec![t.clone()],
        1,
        vec![(t.clone(), Some(print(&t)))],
        vec![],
    );
    let before = s.prints_before_run(STAT_CAP);
    let mut unknown = doc(true, "unknown");
    unknown["repoViews"][0]["state"] = json!("unknown");
    unknown["repoViews"][0]["reason"] = json!("error");
    s.hold_all(key.clone(), unknown, vec![], 2, before, vec![]);
    assert_eq!(
        s.gate(
            ask(Reason::Minute, CurrentSlide::WhatYouDid),
            &key,
            STAT_CAP
        ),
        Decision::Held
    );
    tick();
    std::fs::write(
        Path::new(&t.common_dir).join("refs/heads/main"),
        "recovered ref",
    )
    .unwrap();
    assert_eq!(
        s.gate(
            ask(Reason::Minute, CurrentSlide::WhatYouDid),
            &key,
            STAT_CAP
        ),
        ALL
    );
    let before = s.prints_before_run(STAT_CAP);
    s.hold_all(
        key.clone(),
        doc(true, "recovered"),
        vec![t],
        3,
        before,
        vec![],
    );
    assert_eq!(
        s.gate(
            ask(Reason::Minute, CurrentSlide::WhatYouDid),
            &key,
            STAT_CAP
        ),
        Decision::Held
    );
}

#[test]
fn an_unknown_repo_without_targets_retries_at_a_bounded_interval_until_recovery() {
    let key = key_a();
    let mut s = ReposState::default();
    let mut unknown = doc(true, "unknown");
    unknown["repoViews"][0]["state"] = json!("unknown");
    unknown["repoViews"][0]["reason"] = json!("error");
    for round in 0..2 {
        s.hold_all(
            key.clone(),
            unknown.clone(),
            vec![],
            round,
            vec![],
            vec![],
        );
        for _ in 0..4 {
            assert_eq!(
                s.gate(
                    ask(Reason::Minute, CurrentSlide::WhatYouDid),
                    &key,
                    STAT_CAP
                ),
                Decision::Held
            );
        }
        assert_eq!(
            s.gate(
                ask(Reason::Minute, CurrentSlide::WhatYouDid),
                &key,
                STAT_CAP
            ),
            ALL,
            "unknown repos must recover"
        );
    }
    s.hold_all(
        key.clone(),
        doc(true, "recovered"),
        vec![],
        3,
        vec![],
        vec![],
    );
    for _ in 0..10 {
        assert_eq!(
            s.gate(
                ask(Reason::Minute, CurrentSlide::WhatYouDid),
                &key,
                STAT_CAP
            ),
            Decision::Held
        );
    }
}

#[test]
fn overflow_cannot_hide_a_ref_update_beyond_the_directory_cutoff() {
    let r = Repo::new("overflow", &[]);
    let t = r.target();
    let refs = Path::new(&t.common_dir).join("refs");
    for i in 0..20 {
        std::fs::create_dir_all(refs.join(format!("remotes/r{i:02}"))).unwrap();
        std::fs::write(refs.join(format!("remotes/r{i:02}/main")), "old").unwrap();
    }
    let key = key_a();
    let mut s = ReposState::default();
    s.hold_all(
        key.clone(),
        doc(true, "old"),
        vec![t.clone()],
        1,
        vec![(t.clone(), stat_fingerprint(&t, 5).ok())],
        vec![],
    );
    // Rewrite an existing ref; none of its ancestor directories changes.
    std::fs::write(refs.join("remotes/r19/main"), "a later ref update").unwrap();
    assert_eq!(
        s.gate(ask(Reason::Minute, CurrentSlide::WhatYouDid), &key, 5),
        ALL
    );
}

#[cfg(unix)]
#[test]
fn a_symlinked_refs_root_is_not_followed() {
    let r = Repo::new("symlinkroot", &[]);
    let t = r.target();
    let refs = Path::new(&t.common_dir).join("refs");
    let outside = r.scratch.join("outside-refs");
    std::fs::rename(&refs, &outside).unwrap();
    std::os::unix::fs::symlink(&outside, &refs).unwrap();
    let a = print(&t);
    assert!(
        !a.entries()
            .iter()
            .any(|e| e.path.starts_with(&refs) && e.path != refs),
        "root symlink was descended"
    );
    std::fs::write(outside.join("heads/main"), "outside update").unwrap();
    assert_eq!(a, print(&t));
}

#[cfg(unix)]
#[test]
fn fixed_metadata_paths_do_not_follow_symlinked_parents() {
    for (parent, leaf, reftable) in [("logs", "HEAD", false), ("reftable", "tables.list", true)] {
        let r = Repo::new("symlinkparent", &[]);
        let mut t = r.target();
        t.reftable = reftable;
        let link = Path::new(&t.git_dir).join(parent);
        let outside = r.scratch.join("outside");
        if link.exists() {
            std::fs::rename(&link, &outside).unwrap();
        } else {
            std::fs::create_dir(&outside).unwrap();
        }
        std::fs::write(outside.join(leaf), "outside metadata").unwrap();
        std::os::unix::fs::symlink(&outside, &link).unwrap();
        let before = print(&t);
        std::fs::write(outside.join(leaf), "changed outside metadata with a different length").unwrap();
        assert_eq!(before, print(&t), "followed {parent}/{leaf} through its parent");
        // A real directory replacing the link must restore normal change detection.
        std::fs::remove_file(&link).unwrap();
        std::fs::rename(&outside, &link).unwrap();
        let real_before = print(&t);
        std::fs::write(link.join(leaf), "real directory update").unwrap();
        assert_ne!(real_before, print(&t));
    }
}

#[cfg(unix)]
#[test]
fn the_stat_gate_uses_the_blocking_pool_and_leaves_held_answers_responsive() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .max_blocking_threads(1)
        .build()
        .unwrap();
    runtime.block_on(async {
        let rig = Rig::new("blockinggate");
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (release_tx, release_rx) = std::sync::mpsc::channel();
        struct Release(Option<std::sync::mpsc::Sender<()>>);
        impl Drop for Release {
            fn drop(&mut self) {
                if let Some(tx) = self.0.take() {
                    let _ = tx.send(());
                }
            }
        }
        let release = Release(Some(release_tx));
        let occupied = tokio::task::spawn_blocking(move || {
            started_tx.send(()).unwrap();
            release_rx.recv().unwrap();
        });
        started_rx.recv().unwrap();
        let finished = std::cell::Cell::new(false);
        let running = async {
            // A held decision has no engine I/O that could also wait on the blocking pool.
            let r = rig.ask(req("first", Value::Null, cards())).await;
            finished.set(true);
            r
        };
        let driver = async {
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
            let held = tokio::time::timeout(
                std::time::Duration::from_secs(1),
                rig.ask(req("minute", json!("whatYouDid"), cards())),
            )
            .await;
            let completed_inline = finished.get();
            let spawns = rig.spawns();
            drop(release); // Always release the blocking worker before asserting.
            assert!(
                !completed_inline,
                "gate ran on the async executor instead of the occupied pool"
            );
            assert_eq!(spawns, 0, "engine ran before the blocking stat job");
            assert_eq!(
                held.expect("state lock remained available").unwrap().0["gate"],
                "noResult"
            );
        };
        let (ran, ()) = tokio::join!(running, driver);
        assert_eq!(ran.unwrap().0["gate"], "noResult");
        occupied.await.unwrap();
    });
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn malformed_replies_do_not_spend_the_owed_ungated_minute() {
    let rig = Rig::new("atomicmalformed");
    let mut valid = all_doc(false, "t0", &rig.scratch.path);
    valid["repos"] = json!([]);
    rig.answer_all(&valid);
    rig.ask(req("first", json!("whatYouDid"), cards()))
        .await
        .unwrap();
    let mut bad = valid.clone();
    bad.as_object_mut().unwrap().remove("checkedAt");
    rig.answer_all(&bad);
    assert!(rig
        .ask(req("minute", json!("whatYouDid"), cards()))
        .await
        .is_err());
    rig.answer_all(&valid);
    assert_eq!(
        rig.ask(req("minute", json!("whatYouDid"), cards()))
            .await
            .unwrap()
            .0["gate"],
        "ran"
    );
    assert_eq!(
        rig.ask(req("minute", json!("whatYouDid"), cards()))
            .await
            .unwrap()
            .0["gate"],
        "held"
    );
}

#[test]
fn final3_unknown_repo_with_stat_target_retries_even_when_its_refs_stay_unchanged() {
    let r = Repo::new("timeout-with-target", &[]);
    let t = r.target();
    let key = key_a();
    let mut s = ReposState::default();
    s.hold_all(key.clone(), doc(true, "ok"), vec![t.clone()], 1,
        vec![(t.clone(), Some(print(&t)))], vec![]);
    // The first transient answer retries next minute; a second in a row waits two (final4 M2's backoff).
    for (reason, wait) in [("timeout", 1), ("budget", 2)] {
        let before = s.prints_before_run(STAT_CAP);
        let mut unknown = doc(true, "unknown");
        unknown["repoViews"][0]["state"] = json!("unknown");
        unknown["repoViews"][0]["reason"] = json!(reason);
        s.hold_all(key.clone(), unknown, vec![t.clone()], 2, before, vec![]);
        for _ in 1..wait {
            assert_eq!(s.gate(ask(Reason::Minute, CurrentSlide::WhatYouDid), &key, STAT_CAP), Decision::Held);
        }
        assert_eq!(s.gate(ask(Reason::Minute, CurrentSlide::WhatYouDid), &key, STAT_CAP), ALL,
            "a transient engine failure must retry, even with a stat target");
    }
    let before = s.prints_before_run(STAT_CAP);
    s.hold_all(key.clone(), doc(true, "recovered"), vec![t], 3, before, vec![]);
    for _ in 0..6 {
        assert_eq!(s.gate(ask(Reason::Minute, CurrentSlide::WhatYouDid), &key, STAT_CAP), Decision::Held);
    }
}

fn unknown_doc(reason: &str) -> Map<String, Value> {
    let mut d = doc(true, "unknown");
    d["repoViews"][0]["state"] = json!("unknown");
    d["repoViews"][0]["reason"] = json!(reason);
    d
}

fn minute(s: &mut ReposState, key: &RequestKey) -> Decision {
    s.gate(ask(Reason::Minute, CurrentSlide::WhatYouDid), key, STAT_CAP)
}

/// Final review 4, M2: a repo that keeps timing out must not cost a full check every minute. Consecutive
/// transient (`timeout`/`budget`) answers wait 1, 2, 4, then 5 minutes (the cap) before the next check;
/// an answer from every repo, or one with nothing transient left, resets it.
#[test]
fn final4_transient_unknowns_back_off_1_2_4_5_minutes_and_reset() {
    let key = key_a();
    let mut s = ReposState::default();
    for (round, wait) in [1, 2, 4, 5, 5].into_iter().enumerate() {
        let reason = if round % 2 == 0 { "timeout" } else { "budget" };
        s.hold_all(key.clone(), unknown_doc(reason), vec![], round as i64, vec![], vec![]);
        for quiet in 1..wait {
            assert_eq!(minute(&mut s, &key), Decision::Held, "round {round}, quiet minute {quiet}");
        }
        assert_eq!(minute(&mut s, &key), ALL, "round {round} retries after {wait} minute(s)");
    }
    // Every repo answering resets the backoff (and a full answer retries nothing).
    s.hold_all(key.clone(), doc(true, "ok"), vec![], 10, vec![], vec![]);
    for _ in 0..6 {
        assert_eq!(minute(&mut s, &key), Decision::Held);
    }
    s.hold_all(key.clone(), unknown_doc("timeout"), vec![], 11, vec![], vec![]);
    assert_eq!(minute(&mut s, &key), ALL, "one minute again after a full answer");
    s.hold_all(key.clone(), unknown_doc("timeout"), vec![], 12, vec![], vec![]);
    assert_eq!(minute(&mut s, &key), Decision::Held);
    assert_eq!(minute(&mut s, &key), ALL);
    // Nothing transient left (a non-transient unknown alone) keeps the five-ask cadence and resets it too.
    s.hold_all(key.clone(), unknown_doc("error"), vec![], 13, vec![], vec![]);
    for _ in 0..4 {
        assert_eq!(minute(&mut s, &key), Decision::Held);
    }
    assert_eq!(minute(&mut s, &key), ALL);
    s.hold_all(key.clone(), unknown_doc("timeout"), vec![], 14, vec![], vec![]);
    assert_eq!(minute(&mut s, &key), ALL, "one minute again once nothing transient remained");
}

/// Final review 5, L2: a stat that never returns (a dead network mount) must not hold the run latch.
/// Past `STAT_LIMIT` the ask fails with the fixed sentence and nothing runs; the latch is free, so the
/// next ask is answered. The stall stands in for the stat (`ReposLive::with_stat_stall`).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn a_stat_check_that_never_returns_fails_the_ask_and_frees_the_latch() {
    use daily_briefing_gui_lib::engine::EngineError;
    use daily_briefing_gui_lib::repos::{ReposLive, STAT_LIMIT};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let mut rig = Rig::new("cmdstall");
    let stalled = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicUsize::new(0));
    let s = stalled.clone();
    let c = calls.clone();
    rig.live = ReposLive::default().with_stat_stall(Arc::new(move || {
        c.fetch_add(1, Ordering::SeqCst);
        let until = Instant::now() + Duration::from_secs(60); // bounded, so a red run still ends
        while s.load(Ordering::SeqCst) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
    }));
    let first = rig.ask(req("first", json!("whatYouDid"), cards())).await.expect("first");
    assert_eq!(first.0["gate"], "ran");
    assert_eq!(rig.spawns(), 1);
    assert!(STAT_LIMIT >= Duration::from_secs(1) && STAT_LIMIT <= Duration::from_secs(10), "{STAT_LIMIT:?}");
    stalled.store(true, Ordering::SeqCst);
    let started = Instant::now();
    let err = rig
        .ask(req("minute", json!("whatYouDid"), cards()))
        .await
        .expect_err("a stat past its limit fails the ask");
    let took = started.elapsed();
    assert!(took >= STAT_LIMIT && took < STAT_LIMIT + Duration::from_secs(5), "{took:?}");
    assert!(
        matches!(&err, EngineError::Spawn { detail } if detail == "the live git check could not be completed"),
        "{err:?}"
    );
    assert_eq!(rig.spawns(), 1, "nothing ran past a stuck stat");
    assert_eq!(calls.load(Ordering::SeqCst), 2);
    // Final review 6, M1: while that stat is still blocked, every ask fails at once and starts no other
    // stat work (no second blocked thread, no second clone of the state).
    for reason in ["minute", "focus", "first"] {
        let started = Instant::now();
        let err = rig
            .ask(req(reason, json!("whatYouDid"), cards()))
            .await
            .expect_err("an ask while the stat is still blocked fails");
        assert!(started.elapsed() < Duration::from_secs(1), "{reason}: {:?}", started.elapsed());
        assert!(
            matches!(&err, EngineError::Spawn { detail } if detail == "the live git check could not be completed"),
            "{reason}: {err:?}"
        );
        assert_eq!(calls.load(Ordering::SeqCst), 2, "{reason} started a second stat");
    }
    assert!(rig.live.is_stat_busy());
    // The latch is free: once the stat returns, the next ask stats and runs.
    stalled.store(false, Ordering::SeqCst);
    until("the blocked stat ended", || !rig.live.is_stat_busy()).await;
    let focus = rig.ask(req("focus", json!("whatYouDid"), cards())).await.expect("focus");
    assert_eq!(focus.0["gate"], "ran");
    assert_eq!(rig.spawns(), 2);
    assert_eq!(calls.load(Ordering::SeqCst), 3);
    assert!(!rig.live.is_owed());
    // And a later minute ask stats normally (a quiet one: the held reply).
    let minute = rig.ask(req("minute", json!("whatYouDid"), cards())).await.expect("minute");
    assert_eq!(minute.0["gate"], "held");
    assert_eq!(calls.load(Ordering::SeqCst), 4);
    assert!(!rig.live.is_stat_busy());
}

/* ── B2-M2-T5: Rust strips the private `actionFacts` and always inserts `actions` ─────────────── */
//
// B2 `:23-28` and `:120`: the engine's private facts never cross; `actions` is always on the `all`
// reply (`[]` when nothing is minted, which is every reply until B2-M2-T6 mints); a missing or
// malformed private member gives empty facts and `actions: []`, never `check_failed`, while a missing
// or malformed `repos` still fails the check. Minting is T6.

/// The shared engine↔Rust contract fixture (plan R5-H1), a checked-in literal no test regenerates.
const ACTION_FACTS_VECTORS: &str = include_str!("fixtures/action-facts-vectors.json");

/// The fixture's `actionFacts`, its `/fixture` placeholder rebased to `root`.
fn fixture_facts(root: &Path) -> Value {
    let text = ACTION_FACTS_VECTORS.replace("/fixture", &root.display().to_string());
    serde_json::from_str::<Value>(&text).expect("the fixture is JSON")["actionFacts"].clone()
}

/// Every object member name anywhere in `v`, except inside `perLabel`, whose keys are card keys, not names.
fn object_keys(v: &Value, out: &mut BTreeSet<String>) {
    match v {
        Value::Array(a) => a.iter().for_each(|x| object_keys(x, out)),
        Value::Object(m) => {
            for (k, x) in m {
                out.insert(k.clone());
                if k != "perLabel" {
                    object_keys(x, out);
                }
            }
        }
        _ => {}
    }
}

/// One public handle of `target`, with the nullable members its target requires.
fn action_handle(target: &str) -> Value {
    json!({
        "handle": format!("00000000000000a1.0.{target}"),
        "target": target,
        "row": 0,
        "sha": null,
        "project": if target == "editor" { json!("032fa4562bc7b051317d2a37a7291db8") } else { Value::Null },
        "label": if target == "compare" { json!("main") } else { Value::Null },
    })
}

fn action_card(handles: Vec<Value>) -> Value {
    json!({ "repoKey": "rA", "cardKind": "did", "cardId": "app", "handles": handles })
}

/// A projectable `all` document (path-free: its `repos` list is emptied) with `actions` set.
fn all_with_actions(actions: Value) -> Value {
    let mut d = all_doc(true, "t0", Path::new("/nowhere"));
    d["repos"] = json!([]);
    d["actions"] = actions;
    d
}

#[test]
fn b2_actions_keeps_its_fixed_name_array_shape_through_sanitize_reply() {
    use daily_briefing_gui_lib::repos::sanitize_reply;
    let mut commit = action_handle("commit");
    commit["sha"] = json!("0123456789012345678901234567890123456789");
    commit["row"] = Value::Null;
    let mut dirty_commit = commit.clone();
    dirty_commit["url"] = json!("https://github.com/org/repo/commit/0123");
    dirty_commit["path"] = json!("/private/secret/repo");
    let targets = ["pr", "branch", "compare", "editor", "copy"];
    let mut dirty = action_card(
        std::iter::once(dirty_commit)
            .chain(targets.iter().map(|t| action_handle(t)))
            .collect(),
    );
    dirty["path"] = json!("/private/secret/repo");
    dirty["branchName"] = json!("feature/x");
    let clean = action_card(
        std::iter::once(commit)
            .chain(targets.iter().map(|t| action_handle(t)))
            .collect(),
    );
    let out = sanitize_reply(all_with_actions(json!([dirty])));
    assert!(!out.is_null(), "a well-formed actions member projects");
    assert_eq!(out["actions"], json!([clean]), "unknown card and handle members are dropped");
    let card_keys: Vec<&String> = out["actions"][0].as_object().unwrap().keys().collect();
    assert_eq!(card_keys.len(), 4, "{card_keys:?}");
    for h in out["actions"][0]["handles"].as_array().unwrap() {
        assert_eq!(h.as_object().unwrap().len(), 6, "{h}");
    }
    for kind in ["did", "leftOff", "push", "tile"] {
        let mut c = action_card(vec![action_handle("pr")]);
        c["cardKind"] = json!(kind);
        assert_eq!(sanitize_reply(all_with_actions(json!([c.clone()])))["actions"], json!([c]), "{kind}");
    }
    assert_eq!(sanitize_reply(all_with_actions(json!([])))["actions"], json!([]));
    let mut none = all_with_actions(json!([]));
    none.as_object_mut().unwrap().remove("actions");
    assert!(sanitize_reply(none).is_null(), "actions is a required member of the all projection");
}

#[test]
fn b2_a_non_array_actions_or_a_malformed_card_or_handle_nulls_the_document() {
    use daily_briefing_gui_lib::repos::sanitize_reply;
    let mut bad: Vec<(String, Value)> = Vec::new();
    for v in [json!("x"), json!(42), json!({}), Value::Null, json!({ "rA": [] }), json!(["x"])] {
        bad.push((format!("actions = {v}"), v));
    }
    let good = action_card(vec![action_handle("pr")]);
    for k in ["repoKey", "cardKind", "cardId", "handles"] {
        let mut c = good.clone();
        c.as_object_mut().unwrap().remove(k);
        bad.push((format!("card without {k}"), json!([c])));
    }
    for (k, v) in [
        ("repoKey", json!(3)),
        ("repoKey", Value::Null),
        ("cardKind", json!("bogus")),
        ("cardKind", json!("Did")),
        ("cardId", json!(7)),
        ("cardId", Value::Null),
        ("handles", json!("x")),
        ("handles", json!({})),
    ] {
        let mut c = good.clone();
        c[k] = v.clone();
        bad.push((format!("card {k} = {v}"), json!([c])));
    }
    for k in ["handle", "target", "row", "sha", "project", "label"] {
        let mut h = action_handle("pr");
        h.as_object_mut().unwrap().remove(k);
        bad.push((format!("handle without {k}"), json!([action_card(vec![h])])));
    }
    let hex32 = "032fa4562bc7b051317d2a37a7291db8";
    for (target, k, v) in [
        ("pr", "handle", json!(1)),
        ("pr", "handle", Value::Null),
        ("pr", "target", json!("url")),
        ("pr", "target", json!("PR")),
        ("pr", "target", Value::Null),
        ("pr", "row", json!(-1)),
        ("pr", "row", json!("0")),
        ("pr", "row", json!(1.5)),
        ("pr", "sha", json!(40)),
        ("editor", "project", Value::Null),
        ("editor", "project", json!(hex32.to_uppercase())),
        ("editor", "project", json!(&hex32[..31])),
        ("editor", "project", json!(format!("{hex32}0"))),
        ("editor", "project", json!(format!("{}g", &hex32[..31]))),
        ("editor", "project", json!(1)),
        ("editor", "label", json!("main")),
        ("compare", "label", Value::Null),
        ("compare", "label", json!("")),
        ("compare", "label", json!("[redacted]")),
        ("compare", "label", json!("ma\u{202e}in")),
        ("compare", "label", json!("ma\u{0007}in")),
        ("compare", "label", json!(5)),
        ("compare", "project", json!(hex32)),
        ("pr", "project", json!(hex32)),
        ("pr", "label", json!("main")),
        ("branch", "label", json!("main")),
        ("commit", "project", json!(hex32)),
        ("copy", "label", json!("main")),
        ("copy", "project", json!(hex32)),
    ] {
        let mut h = action_handle(target);
        h[k] = v.clone();
        bad.push((format!("{target} handle {k} = {v}"), json!([action_card(vec![h])])));
    }
    for (what, actions) in bad {
        assert!(sanitize_reply(all_with_actions(actions)).is_null(), "{what} passed the projection");
    }
}

#[test]
fn b2_held_actions_survive_an_uncommitted_merge_untouched() {
    let mut s = ReposState::default();
    let key = key_a();
    let actions = json!([action_card(vec![action_handle("pr"), action_handle("editor")])]);
    let mut d = doc(true, "2026-10-24T09:10:00.000Z");
    d.insert("actions".into(), actions.clone());
    s.hold_all(key.clone(), d, vec![], 1_000, vec![], vec![]);
    let partial = json!({
        "schemaVersion": 1, "scope": "uncommitted", "checkedAt": "2026-10-24T09:14:00.000Z",
        "repoViews": [{ "key": "rA", "uncommitted": { "count": 9 } }]
    });
    s.merge_uncommitted(&key, partial.as_object().expect("an object"));
    let after = s.reply(&key, daily_briefing_gui_lib::repos::Gate::Ran);
    assert_eq!(after["repoViews"][0]["uncommitted"], json!({ "count": 9 }));
    assert_eq!(after["actions"], actions, "an uncommitted merge leaves held actions as they were");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn b2_actions_is_always_present_and_missing_or_malformed_facts_change_nothing_else() {
    let rig = Rig::new("b2facts");
    let mut base = all_doc(true, "t0", &rig.scratch.path);
    base["repos"] = json!([]); // no stat targets: every reply below is decided the same way
    rig.answer_all(&base);
    let plain = rig
        .ask(req("first", json!("whatYouDid"), cards()))
        .await
        .expect("an all reply with no actionFacts is not a failure")
        .0;
    assert_eq!(plain["actions"], json!([]), "actions is always on the all reply");
    let good = fixture_facts(&rig.scratch.path);
    let mut variants = vec![("the fixture's facts".to_string(), good.clone())];
    for v in [json!("x"), json!(42), json!({}), Value::Null, json!([{}]), json!([1])] {
        variants.push((format!("actionFacts = {v}"), v));
    }
    for k in good[0].as_object().expect("an entry").keys() {
        let mut e = good.clone();
        e[0].as_object_mut().unwrap().remove(k);
        variants.push((format!("an entry without {k}"), e));
    }
    for (k, v) in [("repoKey", json!(3)), ("path", Value::Null), ("remotes", json!("x")), ("unknownFact", json!(true))] {
        let mut e = good.clone();
        e[0][k] = v.clone();
        variants.push((format!("an entry with {k} = {v}"), e));
    }
    for (what, facts) in variants {
        let mut d = base.clone();
        d["actionFacts"] = facts;
        // The engine never mints: an `actions` member it printed is replaced, never passed through.
        d["actions"] = json!([action_card(vec![action_handle("pr")])]);
        rig.answer_all(&d);
        let r = rig
            .ask(req("focus", json!("whatYouDid"), cards()))
            .await
            .unwrap_or_else(|e| panic!("{what}: {e:?}"))
            .0;
        assert_eq!(r, plain, "{what}: B1's rows unchanged and actions: []");
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn b2_a_missing_or_malformed_repos_still_fails_beside_well_formed_facts() {
    let rig = Rig::new("b2repos");
    for repos in [None, Some(json!(42)), Some(json!([{ "key": "rA" }]))] {
        let mut d = all_doc(true, "t0", &rig.scratch.path);
        d["actionFacts"] = fixture_facts(&rig.scratch.path);
        match &repos {
            None => {
                d.as_object_mut().unwrap().remove("repos");
            }
            Some(v) => d["repos"] = v.clone(),
        }
        rig.answer_all(&d);
        let err = rig
            .ask(req("focus", json!("whatYouDid"), cards()))
            .await
            .expect_err("repos is still required");
        assert_eq!(
            serde_json::to_value(err).unwrap()["detail"],
            "the live git check could not be completed",
            "{repos:?}"
        );
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn b2_held_actions_ride_on_the_reply_after_an_uncommitted_merge() {
    let rig = Rig::new("b2merge");
    let full = rig.ask(req("first", json!("launchpad"), cards())).await.expect("first").0;
    assert_eq!(full["actions"], json!([]));
    let part = rig.ask(req("minute", json!("launchpad"), cards())).await.expect("minute").0;
    assert_eq!(rig.stdin(1)["scope"], "uncommitted", "the minute ran the status alone");
    assert_eq!(part["repoViews"][0]["uncommitted"], json!({ "count": 7 }));
    assert_eq!(part["actions"], full["actions"], "the held actions are still on the reply");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn b2_the_ipc_reply_never_carries_action_facts_or_a_path() {
    let rig = Rig::new("b2scrub");
    let mut d = all_doc(true, "t0", &rig.scratch.path);
    d["actionFacts"] = fixture_facts(&rig.scratch.path);
    rig.answer_all(&d);
    let r = rig.ask(req("first", json!("whatYouDid"), cards())).await.expect("first").0;
    assert_eq!(r["actions"], json!([]));
    let mut all = Vec::new();
    strings(&r, &mut all);
    let root = rig.scratch.path.display().to_string();
    for s in &all {
        assert!(!s.contains(&root), "a path reached the reply: {s}");
    }
    // The private names come from the fixture's own keys, so a field the engine adds to the facts is
    // scanned for without editing this test. A name the public reply also declares is not private.
    let mut private = BTreeSet::new();
    object_keys(&fixture_facts(&rig.scratch.path), &mut private);
    private.retain(|k| !REPLY_KEYS.contains(&k.as_str()));
    private.insert("actionFacts".to_string());
    for expected in ["path", "remotes", "transport", "owner", "checkoutPath", "prEvidence", "statInputs"] {
        assert!(private.contains(expected), "the derived list lost {expected}: {private:?}");
    }
    let mut reply_keys = BTreeSet::new();
    object_keys(&r, &mut reply_keys);
    let leaked: Vec<&String> = private.intersection(&reply_keys).collect();
    assert!(leaked.is_empty(), "private names reached the reply: {leaked:?}");
}

/* ── B2-M2-T6: minted handles through the command ──────────────────────────────────────────────── */

/// The fixture's real reply as the engine prints it, with its facts rebased to `root` and materialised there, so their
/// stamps describe the disk and Rust accepts them, and no stat targets.
fn minting_doc(root: &Path) -> Value {
    let fx: Value = serde_json::from_str(ACTION_FACTS_VECTORS).expect("the fixture is JSON");
    let mut d = fx["reply"].clone();
    d["repos"] = json!([]);
    d["actionFacts"] = common::materialise_action_facts(root, &fx["actionFacts"]);
    d
}

/// The ask the fixture's reply answers.
fn minting_ask(reason: &str, page: &str) -> Value {
    json!({
        "labels": [{ "key": "repo", "tokens": [] }, { "key": "gui", "tokens": ["5fab0a2"] }],
        "branches": [{ "key": "gui", "name": "feature/contract" }],
        "pageDate": page,
        "reason": reason,
        "current": "launchpad",
    })
}

fn handles_of(reply: &Value) -> Vec<String> {
    let mut out = Vec::new();
    for card in reply["actions"].as_array().expect("actions") {
        for h in card["handles"].as_array().expect("handles") {
            out.push(h["handle"].as_str().expect("handle").to_string());
        }
    }
    out
}

fn targets_of(reply: &Value) -> BTreeSet<String> {
    reply["actions"].as_array().expect("actions").iter()
        .flat_map(|c| c["handles"].as_array().expect("handles"))
        .map(|h| h["target"].as_str().expect("target").to_string())
        .collect()
}

/// The stat target a repo reports under `key`, as the engine's `repos` list prints it.
fn target_json(repo: &Repo, key: &Value) -> Value {
    let t = repo.target();
    json!({ "key": key, "path": repo.dir.display().to_string(), "gitDir": t.git_dir, "commonDir": t.common_dir, "reftable": t.reftable })
}

/// A repo whose `refs/heads` cannot be read until this drops: its stat errors for a reason other than "not there".
#[cfg(unix)]
struct BrokenStat(PathBuf);

#[cfg(unix)]
impl BrokenStat {
    fn of(repo: &Repo) -> Self {
        use std::os::unix::fs::PermissionsExt;
        let heads = repo.dir.join(".git/refs/heads");
        std::fs::set_permissions(&heads, std::fs::Permissions::from_mode(0o000)).expect("chmod 000");
        BrokenStat(heads)
    }

    /// A process whose permissions ignore chmod 000 cannot run this case (as the older stat test skips it).
    fn ignored(&self) -> bool {
        let ignored = std::fs::read_dir(&self.0).is_ok();
        if ignored {
            eprintln!("SKIPPED: running with permissions that ignore chmod 000");
        }
        ignored
    }
}

#[cfg(unix)]
impl Drop for BrokenStat {
    fn drop(&mut self) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&self.0, std::fs::Permissions::from_mode(0o755));
    }
}

/// LOW 7: the IPC scan over a reply with MINTED handles, not `[]`.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn b2_minted_handles_cross_with_no_path_and_no_private_name() {
    let rig = Rig::new("b2mintscan");
    let root = rig.scratch.path.clone();
    rig.answer_all(&minting_doc(&root));
    let r = rig.ask(minting_ask("first", "2026-01-11")).await.expect("first").0;
    let handles = handles_of(&r);
    assert!(handles.len() >= 6, "the scan needs real handles: {r}");
    assert_eq!(targets_of(&r).len(), 6, "every target kind is in the scan");
    assert!(handles.iter().all(|h| rig.live.holds_handle(h)), "every crossing handle is held");
    let mut all = Vec::new();
    strings(&r, &mut all);
    let root = root.display().to_string();
    for s in &all {
        assert!(!s.contains(&root), "a path reached the reply: {s}");
    }
    let actions = r["actions"].to_string();
    for private in ["org", "origin", "apps/gui", "feature/contract", "unknownRepos"] {
        assert!(!actions.contains(private), "{private} crossed in actions: {actions}");
    }
    let mut private = BTreeSet::new();
    object_keys(&fixture_facts(rig.scratch.path.as_path()), &mut private);
    private.retain(|k| !REPLY_KEYS.contains(&k.as_str()));
    private.insert("actionFacts".to_string());
    for expected in ["statInputs", "stamp", "mtimeNs", "size"] {
        assert!(private.contains(expected), "the derived list lost {expected}: {private:?}");
    }
    let mut reply_keys = BTreeSet::new();
    object_keys(&r, &mut reply_keys);
    let leaked: Vec<&String> = private.intersection(&reply_keys).collect();
    assert!(leaked.is_empty(), "private names reached the reply: {leaked:?}");
}

/// LOW 7: an uncommitted merge through `status` keeps minted handles on the reply and held.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn b2_minted_handles_survive_an_uncommitted_merge_through_the_command() {
    let rig = Rig::new("b2mintmerge");
    rig.answer_all(&minting_doc(&rig.scratch.path));
    let full = rig.ask(minting_ask("first", "2026-01-11")).await.expect("first").0;
    let handles = handles_of(&full);
    assert!(!handles.is_empty());
    let key = full["repoViews"][0]["key"].clone();
    rig.answer_uncommitted(&json!({
        "schemaVersion": 1, "scope": "uncommitted", "checkedAt": "2026-01-11T00:05:00.000Z",
        "repoViews": [{ "key": key, "uncommitted": { "count": 7 } }]
    }));
    let part = rig.ask(minting_ask("minute", "2026-01-11")).await.expect("minute").0;
    assert_eq!(rig.stdin(1)["scope"], "uncommitted", "the minute ran the status alone");
    assert_eq!(part["repoViews"][0]["uncommitted"], json!({ "count": 7 }));
    assert_eq!(part["actions"], full["actions"], "an uncommitted merge mints nothing and clears nothing");
    assert!(handles.iter().all(|h| rig.live.holds_handle(h)));
}

/// MED 1 (B2 `:25`): a malformed private fact costs only its handle, never `check_failed` or B1's rows.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn b2_a_non_hex_project_or_a_redacted_default_gives_an_ok_reply_unchanged_rows_and_no_such_handle() {
    let rig = Rig::new("b2mintbad");
    let root = rig.scratch.path.clone();
    let good = minting_doc(&root);
    rig.answer_all(&good);
    let control = rig.ask(minting_ask("first", "2026-01-11")).await.expect("first").0;
    assert!(targets_of(&control).contains("editor") && targets_of(&control).contains("compare"), "the control has both");
    let without = |v: &Value| {
        let mut v = v.clone();
        let m = v.as_object_mut().unwrap();
        for k in ["actions", "gate", "heldAt", "uncommittedAt"] { m.remove(k); }
        v
    };
    let bad_project: Vec<(&str, Value)> = vec![
        ("uppercase", json!("9FBB6E9F98A6074F844482CDA9171850")), ("short", json!("9fbb")), ("non-hex", json!("zzbb6e9f98a6074f844482cda9171850")),
    ];
    for (what, project) in bad_project {
        let mut d = good.clone();
        d["actionFacts"][0]["roots"][1]["project"] = project;
        rig.answer_all(&d);
        let r = rig.ask(minting_ask("focus", "2026-01-11")).await.unwrap_or_else(|e| panic!("{what}: {e:?}")).0;
        assert_eq!(without(&r), without(&control), "{what}: B1's rows unchanged");
        let t = targets_of(&r);
        assert!(!t.contains("editor"), "{what}: {r}");
        assert!(t.contains("compare") && t.contains("copy"), "{what}: only that action goes: {r}");
    }
    for label in ["[redacted]", "a\u{202e}b"] {
        let mut d = good.clone();
        d["actionFacts"][0]["remotes"][0]["defaultBranch"] = json!(label);
        rig.answer_all(&d);
        let r = rig.ask(minting_ask("focus", "2026-01-11")).await.unwrap_or_else(|e| panic!("{label}: {e:?}")).0;
        assert_eq!(without(&r), without(&control), "{label}: B1's rows unchanged");
        let t = targets_of(&r);
        assert!(!t.contains("compare"), "{label}: {r}");
        assert!(t.contains("editor") && t.contains("branch"), "{label}: only that action goes: {r}");
    }
}

/// B2 `:30`: a replacing check, a new page and a repo turning unknown each end the old handles.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn b2_a_replacing_check_replaces_every_handle() {
    let rig = Rig::new("b2mintreplace");
    rig.answer_all(&minting_doc(&rig.scratch.path));
    let first = rig.ask(minting_ask("first", "2026-01-11")).await.expect("first").0;
    let old = handles_of(&first);
    let second = rig.ask(minting_ask("focus", "2026-01-11")).await.expect("focus").0;
    let new = handles_of(&second);
    assert_eq!(new.len(), old.len());
    assert!(new.iter().all(|h| !old.contains(h) && rig.live.holds_handle(h)));
    assert!(old.iter().all(|h| !rig.live.holds_handle(h)), "the old ones are stale");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn b2_a_new_page_clears_handles_even_when_its_check_fails() {
    let rig = Rig::new("b2mintpage");
    rig.answer_all(&minting_doc(&rig.scratch.path));
    let first = rig.ask(minting_ask("first", "2026-01-11")).await.expect("first").0;
    let old = handles_of(&first);
    assert!(!old.is_empty());
    std::fs::write(rig.scratch.join("fail"), "").expect("fail");
    assert!(rig.ask(minting_ask("first", "2026-01-12")).await.is_err(), "the new page's check fails");
    assert!(old.iter().all(|h| !rig.live.holds_handle(h)), "a new page ended them regardless");
    std::fs::remove_file(rig.scratch.join("fail")).expect("fail");
    rig.shown.store(false, std::sync::atomic::Ordering::SeqCst);
    let back = rig.ask(minting_ask("minute", "2026-01-11")).await.expect("held").0;
    assert_eq!(back["gate"], "held");
    assert_eq!(back["actions"], json!([]), "the held document's actions were replaced before any next reply");
    assert_eq!(back["repoViews"], first["repoViews"], "B1's rows stay");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn b2_a_repo_turning_unknown_clears_handles_on_the_held_reply_and_when_its_rerun_fails() {
    let rig = Rig::new("b2mintunknown");
    let repo = Repo::new("b2mintunknown-target", &[]);
    let mut doc = minting_doc(&rig.scratch.path);
    doc["repos"] = json!([target_json(&repo, &doc["repoViews"][0]["key"])]);
    rig.answer_all(&doc);
    // Twice, so the target has the baseline a pre-run fingerprint gives.
    rig.ask(minting_ask("first", "2026-01-11")).await.expect("first");
    let settled = rig.ask(minting_ask("focus", "2026-01-11")).await.expect("focus").0;
    let old = handles_of(&settled);
    assert!(!old.is_empty(), "minted over a stat target: {settled}");
    // The stat now errors for a reason other than "not there", and the check it triggers fails.
    let broken = BrokenStat::of(&repo);
    if broken.ignored() {
        return;
    }
    std::fs::write(rig.scratch.join("fail"), "").expect("fail");
    let turned = rig.ask(minting_ask("minute", "2026-01-11")).await;
    assert!(turned.is_err(), "the check the change triggers fails");
    assert!(old.iter().all(|h| !rig.live.holds_handle(h)), "a failed run still does not bring them back");
    rig.shown.store(false, std::sync::atomic::Ordering::SeqCst);
    let held = rig.ask(minting_ask("minute", "2026-01-11")).await.expect("held").0;
    assert_eq!(held["gate"], "held");
    assert_eq!(held["actions"], json!([]), "the held document's actions were replaced before any next reply");
    assert_eq!(held["repoViews"], settled["repoViews"], "B1's rows stay");
}

/// `before` says the repo's stat failed: this reply lists it unknown, so its handles are never minted.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn b2_a_repo_listed_in_unknown_repos_by_the_same_reply_gets_no_handles() {
    let rig = Rig::new("b2mintlisted");
    let repo = Repo::new("b2mintlisted-target", &[]);
    let mut doc = minting_doc(&rig.scratch.path);
    doc["repos"] = json!([target_json(&repo, &doc["repoViews"][0]["key"])]);
    rig.answer_all(&doc);
    rig.ask(minting_ask("first", "2026-01-11")).await.expect("first");
    let broken = BrokenStat::of(&repo);
    if broken.ignored() {
        return;
    }
    let r = rig.ask(minting_ask("focus", "2026-01-11")).await.expect("focus").0;
    drop(broken);
    assert_eq!(r["unknownRepos"], json!([doc["repoViews"][0]["key"]]), "{r}");
    assert_eq!(r["actions"], json!([]), "{r}");
}

#[test]
fn b2_held_facts_are_replaced_with_the_held_all_reply_and_answer_only_its_key() {
    use daily_briefing_gui_lib::repos::parse_action_facts;
    let facts = parse_action_facts(Some(fixture_facts(Path::new("/fixture"))));
    assert_eq!(facts.len(), 1, "the fixture's facts parse");
    let mut s = ReposState::default();
    let key = key_a();
    s.hold_all(key.clone(), doc(true, "t0"), vec![], 1, vec![], facts.clone());
    assert_eq!(s.held_facts(&key), facts.as_slice());
    assert!(s.held_facts(&key_for("2026-10-25", &[])).is_empty(), "another key holds no facts");
    let partial = json!({ "schemaVersion": 1, "scope": "uncommitted", "checkedAt": "t1",
                          "repoViews": [{ "key": "rA", "uncommitted": { "count": 1 } }] });
    s.merge_uncommitted(&key, partial.as_object().expect("an object"));
    assert_eq!(s.held_facts(&key), facts.as_slice(), "an uncommitted merge keeps the facts");
    s.hold_all(key.clone(), doc(true, "t2"), vec![], 2, vec![], vec![]);
    assert!(s.held_facts(&key).is_empty(), "a replacing all reply drops the old facts");
}

#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn b2_the_command_holds_the_parsed_facts_and_drops_malformed_ones_to_empty() {
    use daily_briefing_gui_lib::repos::parse_action_facts;
    let rig = Rig::new("b2held");
    let key = key_for("2026-10-24", &[("app", &["abc1234"]), ("", &[])]);
    let good = fixture_facts(&rig.scratch.path);
    let mut d = all_doc(true, "t0", &rig.scratch.path);
    d["repos"] = json!([]);
    d["actionFacts"] = good.clone();
    rig.answer_all(&d);
    rig.ask(req("first", json!("whatYouDid"), cards())).await.expect("first");
    let held = rig.live.held_facts(&key);
    assert_eq!(held.len(), 1, "the command held the fixture's facts");
    assert_eq!(held, parse_action_facts(Some(good)));
    let mut bad = d.clone();
    bad["actionFacts"] = json!([{ "repoKey": "rA" }]);
    rig.answer_all(&bad);
    rig.ask(req("focus", json!("whatYouDid"), cards())).await.expect("malformed facts are not a failure");
    assert!(rig.live.held_facts(&key).is_empty(), "malformed facts are held as empty facts");
    rig.answer_all(&d);
    rig.ask(req("focus", json!("whatYouDid"), cards())).await.expect("focus");
    assert_eq!(rig.live.held_facts(&key).len(), 1);
    let mut none = d.clone();
    none.as_object_mut().unwrap().remove("actionFacts");
    rig.answer_all(&none);
    rig.ask(req("focus", json!("whatYouDid"), cards())).await.expect("no facts is not a failure");
    assert!(rig.live.held_facts(&key).is_empty(), "a reply without facts replaces the held ones");
}

/* ── B2-M2-T7: B2's own stat state ─────────────────────────────────────────────────────────────────── */

/// A stamp as the engine prints it, read straight from the disk and independently of the production sampler.
#[cfg(unix)]
fn stamp_json(path: &Path) -> Value {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return json!({ "mtimeNs": "0", "size": "0", "kind": "missing", "target": null });
    };
    let ns = meta.modified().unwrap().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos();
    let (kind, target) = if meta.file_type().is_symlink() {
        ("symlink", json!(std::fs::read_link(path).unwrap().to_str().unwrap()))
    } else if meta.is_dir() {
        ("dir", Value::Null)
    } else {
        ("file", Value::Null)
    };
    json!({ "mtimeNs": ns.to_string(), "size": meta.len().to_string(), "kind": kind, "target": target })
}

/// One rig with a canonical root, and the sources B2 watches: an include, a symlinked config and its target, the repo's
/// config, a missing global candidate, a missing legacy directory, a linked worktree's reciprocal file and its gitfile.
#[cfg(unix)]
struct Watched {
    rig: Rig,
    root: PathBuf,
    /// The fixture's reply and facts, materialised once under `root`: the sources below are changed afterwards.
    base: Value,
}

#[cfg(unix)]
impl Watched {
    fn new(tag: &str) -> Self {
        let rig = Rig::new(tag);
        let root = std::fs::canonicalize(&rig.scratch.path).unwrap();
        let base = minting_doc(&root);
        let w = Watched { rig, root, base };
        for (path, text) in [
            ("watched.config", "[a]\n\tb = 1\n"),
            ("dots/real.config", "[a]\n\tc = 1\n"),
            ("dots/other.config", "[a]\n\tc = 2\n"),
            ("repo/.git/config", "[remote \"origin\"]\n\turl = https://github.com/org/repo.git\n"),
            ("repo/.git/worktrees/wt/gitdir", "/somewhere/wt/.git\n"),
            ("wt/.git", "gitdir: x\n"),
            ("gitstore/config", "[core]\n"),
            ("gitstore2/config", "[core]\n"),
        ] {
            let p = w.root.join(path);
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            std::fs::write(p, text).unwrap();
        }
        std::os::unix::fs::symlink("dots/real.config", w.root.join("linked.config")).unwrap();
        std::fs::create_dir_all(w.root.join("dotgit")).unwrap();
        std::os::unix::fs::symlink("../gitstore", w.root.join("dotgit/.git")).unwrap();
        w.answer_with_real_stamps();
        w
    }

    fn sources(&self) -> Vec<String> {
        [
            "watched.config", "dots/real.config", "dots/other.config", "linked.config", "repo/.git/config", "repo/.git/remotes",
            "repo/.git/worktrees/wt/gitdir", "wt/.git", "home/.gitconfig", "xdg/git/config",
            "dotgit/.git", "gitstore/config", "gitstore2/config",
        ]
        .iter()
        .map(|p| self.root.join(p).to_str().unwrap().to_string())
        .collect()
    }

    /// The engine's reply when its pre-read stamps are what is on disk now.
    fn doc(&self) -> Value {
        let mut d = self.base.clone();
        let inputs: Vec<Value> = self.sources().iter()
            .map(|p| json!({ "path": p, "stamp": stamp_json(Path::new(p)) }))
            .collect();
        d["actionFacts"][0]["statInputs"] = json!(inputs);
        d
    }

    fn answer_with_real_stamps(&self) {
        self.rig.answer_all(&self.doc());
    }

    fn path(&self, p: &str) -> PathBuf {
        self.root.join(p)
    }
}

/// Every B2 source the plan names, and one way of changing it. All are metadata B1's stat never looks at.
#[cfg(unix)]
type Change = (&'static str, fn(&Watched));

#[cfg(unix)]
const CHANGES: &[Change] = &[
    ("an include's content", |w| std::fs::write(w.path("watched.config"), "[a]\n\tb = 22\n").unwrap()),
    ("a push URL", |w| std::fs::write(w.path("repo/.git/config"), "[remote \"origin\"]\n\tpushurl = https://evil.example/x.git\n").unwrap()),
    ("a config symlink's target", |w| {
        std::fs::remove_file(w.path("linked.config")).unwrap();
        std::os::unix::fs::symlink("dots/other.config", w.path("linked.config")).unwrap();
    }),
    ("the file behind a config symlink", |w| std::fs::write(w.path("dots/real.config"), "[a]\n\tc = 111\n").unwrap()),
    ("a global candidate appearing", |w| {
        std::fs::create_dir_all(w.path("home")).unwrap();
        std::fs::write(w.path("home/.gitconfig"), "[a]\n\tb = 1\n").unwrap();
    }),
    ("an XDG candidate appearing", |w| {
        std::fs::create_dir_all(w.path("xdg/git")).unwrap();
        std::fs::write(w.path("xdg/git/config"), "[a]\n\tb = 1\n").unwrap();
    }),
    ("a legacy entry appearing", |w| std::fs::create_dir_all(w.path("repo/.git/remotes")).unwrap()),
    ("a worktree moving", |w| std::fs::write(w.path("repo/.git/worktrees/wt/gitdir"), "/moved/elsewhere/wt/.git\n").unwrap()),
    ("a worktree's gitfile going", |w| std::fs::remove_file(w.path("wt/.git")).unwrap()),
    ("a .git symlink's target", |w| {
        std::fs::remove_file(w.path("dotgit/.git")).unwrap();
        std::os::unix::fs::symlink("../gitstore2", w.path("dotgit/.git")).unwrap();
    }),
];

fn b2_ask(reason: &str, current: Value) -> Value {
    json!({
        "labels": [{ "key": "repo", "tokens": [] }, { "key": "gui", "tokens": ["5fab0a2"] }],
        "branches": [{ "key": "gui", "name": "feature/contract" }],
        "pageDate": "2026-01-11",
        "reason": reason,
        "current": current,
    })
}

/// The reply without what B2 owns. The rigs' clocks stand still, so `heldAt` compares too.
fn b1_part(v: &Value) -> Value {
    let mut v = v.clone();
    v.as_object_mut().unwrap().remove("actions");
    v
}

/// A change to any B2 source, on every ask shape that reaches the gate: the reply already has `actions: []`, the old
/// handles are stale, and nothing of B1's moved (same gate word, same rows, no extra or different engine run).
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_every_source_change_clears_actions_on_held_and_uncommitted_asks() {
    for (what, change) in CHANGES {
        for (shape, reason, current, shown, gate, scope) in [
            ("a quiet shown minute", "minute", json!("whatYouDid"), true, "held", None),
            ("a hidden minute", "minute", json!("launchpad"), false, "held", None),
            ("a hidden first", "first", json!("launchpad"), false, "held", None),
            ("no current slide", "minute", Value::Null, true, "held", None),
            ("a launchpad minute", "minute", json!("launchpad"), true, "ran", Some("uncommitted")),
        ] {
            let w = Watched::new("t7chg");
            let first = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
            let old = handles_of(&first);
            assert!(!old.is_empty(), "{what}: minted first: {first}");
            change(&w);
            w.rig.shown.store(shown, std::sync::atomic::Ordering::SeqCst);
            let spawns = w.rig.spawns();
            let r = w.rig.ask(b2_ask(reason, current.clone())).await.expect("the ask").0;
            assert_eq!(r["actions"], json!([]), "{what} on {shape}: {r}");
            assert!(old.iter().all(|h| !w.rig.live.holds_handle(h)), "{what} on {shape}: a handle survived");
            assert_eq!(r["gate"], gate, "{what} on {shape}: B1's gate moved");
            assert_eq!(r["repoViews"], first["repoViews"], "{what} on {shape}: B1's rows moved");
            assert_eq!(r["unknownRepos"], json!([]), "{what} on {shape}");
            assert_eq!(w.rig.spawns(), spawns + usize::from(scope.is_some()), "{what} on {shape}: B2 opened B1's gate");
            if let Some(s) = scope {
                assert_eq!(w.rig.stdin(spawns)["scope"], s, "{what} on {shape}");
            }
        }
    }
}

/// With nothing changed, the same asks keep every handle: the check is not simply always red.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_with_no_change_the_same_asks_keep_their_handles() {
    let w = Watched::new("t7quiet");
    let first = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
    let old = handles_of(&first);
    assert!(!old.is_empty());
    for (reason, current, shown) in [
        ("minute", json!("whatYouDid"), true),
        ("minute", json!("launchpad"), false),
        ("minute", Value::Null, true),
        ("minute", json!("launchpad"), true),
    ] {
        w.rig.shown.store(shown, std::sync::atomic::Ordering::SeqCst);
        let r = w.rig.ask(b2_ask(reason, current.clone())).await.expect("the ask").0;
        assert_eq!(r["actions"], first["actions"], "{reason} {current} {shown}");
    }
    w.rig.live.check_before_sink().await;
    assert!(old.iter().all(|h| w.rig.live.holds_handle(h)), "the click check found no change");
}

/// R2-O3: the same check immediately before a sink. T8, T9 and T11 call it before each of their sinks.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_the_check_before_a_sink_clears_old_handles_and_the_next_reply() {
    for (what, change) in CHANGES {
        let w = Watched::new("t7sink");
        let first = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
        let old = handles_of(&first);
        assert!(!old.is_empty());
        change(&w);
        assert!(old.iter().all(|h| w.rig.live.holds_handle(h)), "{what}: nothing looked yet");
        w.rig.live.check_before_sink().await;
        assert!(old.iter().all(|h| !w.rig.live.holds_handle(h)), "{what}: a handle survived the click check");
        w.rig.shown.store(false, std::sync::atomic::Ordering::SeqCst);
        let r = w.rig.ask(b2_ask("minute", json!("launchpad"))).await.expect("held").0;
        assert_eq!(r["actions"], json!([]), "{what}: {r}");
        assert_eq!(r["repoViews"], first["repoViews"], "{what}: B1's rows stay");
    }
}

/// Unreadable, not changed: a parent the process cannot search. B2's handles go and B1 does not notice.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_an_unreadable_input_invalidates_b2_without_changing_b1() {
    use std::os::unix::fs::PermissionsExt;
    let w = Watched::new("t7eacces");
    let first = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
    let old = handles_of(&first);
    assert!(!old.is_empty());
    let dots = w.path("dots");
    std::fs::set_permissions(&dots, std::fs::Permissions::from_mode(0o000)).unwrap();
    if std::fs::read_dir(&dots).is_ok() {
        eprintln!("SKIPPED: running with permissions that ignore chmod 000");
        return;
    }
    let spawns = w.rig.spawns();
    let r = w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.expect("B1 still answers").0;
    assert_eq!(r["gate"], "held");
    assert_eq!(r["actions"], json!([]), "{r}");
    assert_eq!(r["repoViews"], first["repoViews"]);
    assert_eq!(r["unknownRepos"], json!([]), "B2's input is no repo of B1's");
    assert_eq!(w.rig.spawns(), spawns);
    assert!(old.iter().all(|h| !w.rig.live.holds_handle(h)));
    // A full run while it is still unreadable: the reply is B1's, and nothing is minted.
    let full = w.rig.ask(b2_ask("focus", json!("whatYouDid"))).await.expect("focus").0;
    assert_eq!(full["gate"], "ran");
    assert_eq!(full["actions"], json!([]), "{full}");
    std::fs::set_permissions(&dots, std::fs::Permissions::from_mode(0o755)).unwrap();
    let back = w.rig.ask(b2_ask("focus", json!("whatYouDid"))).await.expect("focus").0;
    assert!(!handles_of(&back).is_empty(), "readable again, the next full run mints: {back}");
}

/// An edit during the full run, with the engine's pre-read stamps from before it: the post-run sample disagrees, so this
/// reply mints nothing and no later ask finds handles to restore.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_an_edit_during_a_full_run_stays_changed_against_the_pre_read_stamps() {
    for (what, change) in CHANGES {
        let w = Watched::new("t7during");
        let first = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
        assert!(!handles_of(&first).is_empty());
        let hold = w.rig.hold();
        let spawns = w.rig.spawns();
        let run = w.rig.ask(b2_ask("focus", json!("whatYouDid")));
        let edit = async {
            until("the run started", || w.rig.spawns() > spawns).await;
            change(&w);
            std::fs::remove_file(&hold).expect("release");
        };
        let (r, ()) = tokio::join!(run, edit);
        let r = r.expect("the run").0;
        assert_eq!(r["gate"], "ran", "{what}");
        assert_eq!(r["actions"], json!([]), "{what}: {r}");
        let next = w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.expect("minute").0;
        assert_eq!(next["actions"], json!([]), "{what}: {next}");
    }
}

/// The before-run baseline (R2-O3), for an exact matching set: the engine read after an edit that Rust's pre-run sample
/// missed, so its stamps agree with the post-run sample but not with the baseline Rust retained. No post-run stat may
/// quietly become the baseline. With a NEW set there is no such baseline, and agreeing pre-read stamps are what mints.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_a_matching_set_is_held_to_the_before_run_sample_and_a_new_set_to_its_pre_read_stamps() {
    let w = Watched::new("t7before");
    assert!(!handles_of(&w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0).is_empty());
    let hold = w.rig.hold();
    let spawns = w.rig.spawns();
    let run = w.rig.ask(b2_ask("focus", json!("whatYouDid")));
    let edit = async {
        until("the run started", || w.rig.spawns() > spawns).await;
        std::fs::write(w.path("watched.config"), "[a]\n\tb = 22\n").unwrap();
        w.answer_with_real_stamps();
        std::fs::remove_file(&hold).expect("release");
    };
    let (r, ()) = tokio::join!(run, edit);
    assert_eq!(r.expect("the run").0["actions"], json!([]), "the same set, changed since the before-run sample");
    // That run accepted nothing, so no baseline and no before-run sample remain: the next run is a new set, held to its
    // pre-read stamps and the post-run sample, which now agree.
    let again = w.rig.ask(b2_ask("focus", json!("whatYouDid"))).await.expect("focus").0;
    assert!(!handles_of(&again).is_empty(), "{again}");

    // A new set: the engine reports one more input, with a stamp taken after that edit. Nothing before the run saw it.
    let hold = w.rig.hold();
    let spawns = w.rig.spawns();
    let run = w.rig.ask(b2_ask("focus", json!("whatYouDid")));
    let edit = async {
        until("the run started", || w.rig.spawns() > spawns).await;
        std::fs::write(w.path("new.config"), "[a]\n\td = 1\n").unwrap();
        let mut d = w.doc();
        let path = w.path("new.config");
        d["actionFacts"][0]["statInputs"].as_array_mut().unwrap()
            .push(json!({ "path": path.to_str().unwrap(), "stamp": stamp_json(&path) }));
        w.rig.answer_all(&d);
        std::fs::remove_file(&hold).expect("release");
    };
    let (r, ()) = tokio::join!(run, edit);
    let r = r.expect("the run").0;
    assert!(!handles_of(&r).is_empty(), "a new set with trustworthy pre-read stamps mints: {r}");
    // And that input is now watched.
    std::fs::write(w.path("new.config"), "[a]\n\td = 22\n").unwrap();
    let held = w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.expect("minute").0;
    assert_eq!(held["actions"], json!([]), "{held}");
}

/// Everything that mints nothing while B1's reply stands.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_an_input_set_that_cannot_be_trusted_mints_nothing_and_b1_is_unchanged() {
    let w = Watched::new("t7refuse");
    let control = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
    assert!(!handles_of(&control).is_empty());
    std::fs::create_dir_all(w.path("real-dir")).unwrap();
    std::fs::write(w.path("real-dir/inside.config"), "x").unwrap();
    std::os::unix::fs::symlink("real-dir", w.path("dir-link")).unwrap();
    let through = w.path("dir-link/inside.config");
    let link = w.path("linked.config");
    let real = w.path("dots/real.config");
    let root = w.root.to_str().unwrap().to_string();
    let good = stamp_json(&w.path("watched.config"));
    let cases: Vec<(&str, Value)> = vec![
        ("no inputs reported", Value::Null),
        ("an empty list", json!([])),
        ("no stamp on one input", json!([{ "path": w.path("watched.config").to_str().unwrap(), "stamp": null }])),
        ("a link on the way that was not reported", json!([{ "path": through.to_str().unwrap(), "stamp": stamp_json(&through) }])),
        ("a symlink whose resolution was not reported", json!([{ "path": link.to_str().unwrap(), "stamp": stamp_json(&link) }])),
        ("a relative path", json!([{ "path": "watched.config", "stamp": good }])),
        ("a dot-dot path", json!([{ "path": format!("{root}/dots/../watched.config"), "stamp": good }])),
        ("a doubled slash", json!([{ "path": format!("{root}//watched.config"), "stamp": good }])),
        ("a duplicated path", json!([{ "path": real.to_str().unwrap(), "stamp": stamp_json(&real) }, { "path": real.to_str().unwrap(), "stamp": stamp_json(&real) }])),
        ("over the cap", json!((0..=STAT_CAP).map(|i| json!({ "path": format!("{root}/absent/{i}"), "stamp": { "mtimeNs": "0", "size": "0", "kind": "missing", "target": null } })).collect::<Vec<_>>())),
    ];
    for (what, inputs) in cases {
        let mut d = w.doc();
        d["actionFacts"][0]["statInputs"] = inputs;
        w.rig.answer_all(&d);
        let r = w.rig.ask(b2_ask("focus", json!("whatYouDid"))).await.unwrap_or_else(|e| panic!("{what}: {e:?}")).0;
        assert_eq!(r["gate"], "ran", "{what}");
        assert_eq!(r["actions"], json!([]), "{what}: {r}");
        assert_eq!(r["repoViews"], control["repoViews"], "{what}: B1's rows moved");
        assert_eq!(r["labels"], control["labels"], "{what}: B1's rows moved");
    }
    // A symlink on the way that WAS reported, with its resolution, is what the engine sends for a real one.
    let mut d = w.doc();
    d["actionFacts"][0]["statInputs"] = json!([
        { "path": link.to_str().unwrap(), "stamp": stamp_json(&link) },
        { "path": real.to_str().unwrap(), "stamp": stamp_json(&real) },
        { "path": w.path("dir-link").to_str().unwrap(), "stamp": stamp_json(&w.path("dir-link")) },
        { "path": w.path("real-dir/inside.config").to_str().unwrap(), "stamp": stamp_json(&w.path("real-dir/inside.config")) },
    ]);
    w.rig.answer_all(&d);
    let r = w.rig.ask(b2_ask("focus", json!("whatYouDid"))).await.expect("focus").0;
    assert!(!handles_of(&r).is_empty(), "every link reported: {r}");
}

/// The T6 review's HIGH: `*live.state() = state` wrote back a clone taken before the engine ran, so a click-time clear
/// during an uncommitted run would have put the old handles and old `actions` back.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_a_clear_during_an_in_flight_uncommitted_run_survives_the_commit() {
    let w = Watched::new("t7race");
    let first = w.rig.ask(b2_ask("first", json!("launchpad"))).await.expect("first").0;
    let old = handles_of(&first);
    assert!(!old.is_empty());
    w.rig.answer_uncommitted(&json!({
        "schemaVersion": 1, "scope": "uncommitted", "checkedAt": "2026-01-11T00:05:00.000Z",
        "repoViews": [{ "key": first["repoViews"][0]["key"], "uncommitted": { "count": 7 } }]
    }));
    let hold = w.rig.hold();
    let spawns = w.rig.spawns();
    let run = w.rig.ask(b2_ask("minute", json!("launchpad")));
    let click = async {
        until("the uncommitted run started", || w.rig.spawns() > spawns).await;
        std::fs::write(w.path("watched.config"), "[a]\n\tb = 22\n").unwrap();
        w.rig.live.check_before_sink().await;
        assert!(old.iter().all(|h| !w.rig.live.holds_handle(h)), "the click cleared them");
        std::fs::remove_file(&hold).expect("release");
    };
    let (r, ()) = tokio::join!(run, click);
    let r = r.expect("the run").0;
    assert_eq!(w.rig.stdin(spawns)["scope"], "uncommitted");
    assert_eq!(r["actions"], json!([]), "the commit put the old actions back: {r}");
    assert_eq!(r["repoViews"][0]["uncommitted"], json!({ "count": 7 }), "the merge itself still landed");
    assert!(old.iter().all(|h| !w.rig.live.holds_handle(h)), "the commit put the old handles back");
    w.rig.shown.store(false, std::sync::atomic::Ordering::SeqCst);
    let held = w.rig.ask(b2_ask("minute", json!("launchpad"))).await.expect("held").0;
    assert_eq!(held["actions"], json!([]), "{held}");
}

/// The narrower window: a clear while the gate's own stat work runs on its clone, before any engine run. Neither the
/// Held commit nor the commit after an uncommitted run may put the old handles back.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_a_clear_while_the_gate_works_on_its_clone_survives_the_commit() {
    use daily_briefing_gui_lib::repos::ReposLive;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    for (shape, reason, shown, current, gate) in [
        ("held", "minute", true, json!("whatYouDid"), "held"),
        ("uncommitted", "minute", true, json!("launchpad"), "ran"),
        ("an owed first", "first", false, json!("whatYouDid"), "held"),
    ] {
        let mut w = Watched::new("t7gaterace");
        let calls = Arc::new(AtomicUsize::new(0));
        let block_call = Arc::new(AtomicUsize::new(usize::MAX));
        let released = Arc::new(AtomicBool::new(false));
        let (c, b, r) = (calls.clone(), block_call.clone(), released.clone());
        w.rig.live = ReposLive::default().with_stat_stall(Arc::new(move || {
            let n = c.fetch_add(1, Ordering::SeqCst);
            let until = Instant::now() + Duration::from_secs(4); // inside STAT_LIMIT, so a red run still ends
            while n == b.load(Ordering::SeqCst) && !r.load(Ordering::SeqCst) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
        }));
        let first = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
        let old = handles_of(&first);
        assert!(!old.is_empty(), "{shape}");
        // This ask's B2 sample comes first and returns; its gate work is the next call, and it waits here.
        let at = calls.load(Ordering::SeqCst);
        block_call.store(at + 1, Ordering::SeqCst);
        w.rig.shown.store(shown, Ordering::SeqCst);
        let ask = w.rig.ask(b2_ask(reason, current.clone()));
        let click = async {
            until("the gate is working on its clone", || calls.load(Ordering::SeqCst) > at + 1).await;
            std::fs::write(w.path("watched.config"), "[a]\n\tb = 22\n").unwrap();
            w.rig.live.check_before_sink().await;
            assert!(old.iter().all(|h| !w.rig.live.holds_handle(h)), "{shape}: the click cleared them");
            released.store(true, Ordering::SeqCst);
        };
        let (reply, ()) = tokio::join!(ask, click);
        let reply = reply.expect("the ask").0;
        assert_eq!(reply["gate"], gate, "{shape}");
        assert_eq!(reply["actions"], json!([]), "{shape}: the commit put the old actions back: {reply}");
        assert!(old.iter().all(|h| !w.rig.live.holds_handle(h)), "{shape}: the commit put the old handles back");
        if !shown {
            // The gate's own bookkeeping on that clone landed too: the hidden first is still owed.
            w.rig.shown.store(true, Ordering::SeqCst);
            let spawns = w.rig.spawns();
            let owed = w.rig.ask(b2_ask("minute", current.clone())).await.expect("minute").0;
            assert_eq!(owed["gate"], "ran", "{shape}: the owed first was lost: {owed}");
            assert_eq!(w.rig.stdin(spawns)["scope"], "all", "{shape}");
        }
    }
}

/// R4-M3 still holds across B2's sample, which can wait: the gate reads the window as it is after that wait.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_the_gate_reads_the_window_after_b2s_sample() {
    use daily_briefing_gui_lib::repos::ReposLive;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let mut w = Watched::new("t7window");
    let calls = Arc::new(AtomicUsize::new(0));
    let block_call = Arc::new(AtomicUsize::new(usize::MAX));
    let released = Arc::new(AtomicBool::new(false));
    let (c, b, r) = (calls.clone(), block_call.clone(), released.clone());
    w.rig.live = ReposLive::default().with_stat_stall(Arc::new(move || {
        let n = c.fetch_add(1, Ordering::SeqCst);
        let until = Instant::now() + Duration::from_millis(800); // inside B2's limit, so the sample itself is clean
        while n == b.load(Ordering::SeqCst) && !r.load(Ordering::SeqCst) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(5));
        }
    }));
    w.rig.ask(b2_ask("first", json!("launchpad"))).await.expect("first");
    let at = calls.load(Ordering::SeqCst);
    block_call.store(at, Ordering::SeqCst);
    let spawns = w.rig.spawns();
    let ask = w.rig.ask(b2_ask("minute", json!("launchpad")));
    let hide = async {
        until("B2's sample is waiting", || calls.load(Ordering::SeqCst) > at).await;
        w.rig.shown.store(false, Ordering::SeqCst);
        released.store(true, Ordering::SeqCst);
    };
    let (r, ()) = tokio::join!(ask, hide);
    assert_eq!(r.expect("the ask").0["gate"], "held", "the gate read the window from before the wait");
    assert_eq!(w.rig.spawns(), spawns, "a hidden window ran the launchpad status");
}

/// A stuck click is bounded, and only one thread stays blocked: the first click waits for its sample, a later one for
/// the lane. With nothing live there is nothing to check, so the click returns at once and samples nothing.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_a_stalled_click_is_bounded_and_blocks_one_thread_only() {
    use daily_briefing_gui_lib::repos::{ReposLive, STAT_LIMIT};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let mut w = Watched::new("t7clickstall");
    let calls = Arc::new(AtomicUsize::new(0));
    let block_call = Arc::new(AtomicUsize::new(usize::MAX));
    let released = Arc::new(AtomicBool::new(false));
    let (c, b, r) = (calls.clone(), block_call.clone(), released.clone());
    w.rig.live = ReposLive::default().with_stat_stall(Arc::new(move || {
        let n = c.fetch_add(1, Ordering::SeqCst);
        let until = Instant::now() + Duration::from_secs(60);
        while n == b.load(Ordering::SeqCst) && !r.load(Ordering::SeqCst) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
    }));
    let first = handles_of(&w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0);
    assert!(!first.is_empty());
    block_call.store(calls.load(Ordering::SeqCst), Ordering::SeqCst);
    let started = Instant::now();
    w.rig.live.check_before_sink().await;
    let took = started.elapsed();
    assert!(took >= STAT_LIMIT && took < STAT_LIMIT + Duration::from_secs(4), "first click: {took:?}");
    assert!(first.iter().all(|h| !w.rig.live.holds_handle(h)), "a stuck sample is not a clean one");
    // A fresh mint (asks have their own lane), then a second click while the first sample is still stuck.
    let second = handles_of(&w.rig.ask(b2_ask("focus", json!("whatYouDid"))).await.expect("focus").0);
    assert!(!second.is_empty());
    let at = calls.load(Ordering::SeqCst);
    let started = Instant::now();
    w.rig.live.check_before_sink().await;
    let took = started.elapsed();
    assert!(took >= STAT_LIMIT && took < STAT_LIMIT + Duration::from_secs(4), "second click: {took:?}");
    assert_eq!(calls.load(Ordering::SeqCst), at, "a second click started a second sample");
    assert!(second.iter().all(|h| !w.rig.live.holds_handle(h)));
    // Nothing live: at once, past the lane, and no sample.
    let started = Instant::now();
    w.rig.live.check_before_sink().await;
    assert!(started.elapsed() < Duration::from_millis(500), "{:?}", started.elapsed());
    assert_eq!(calls.load(Ordering::SeqCst), at);
    released.store(true, Ordering::SeqCst);
}

/// A click's sample of an older baseline must not end what a full run minted while it ran, and one that lands with
/// nothing live must not cost a run in flight its mint.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_a_click_that_outlives_its_baseline_leaves_a_fresh_mint_alone() {
    use daily_briefing_gui_lib::repos::ReposLive;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    for during_run in [false, true] {
        let mut w = Watched::new("t7clickorder");
        let calls = Arc::new(AtomicUsize::new(0));
        let block_call = Arc::new(AtomicUsize::new(usize::MAX));
        let released = Arc::new(AtomicBool::new(false));
        let (c, b, r) = (calls.clone(), block_call.clone(), released.clone());
        w.rig.live = ReposLive::default().with_stat_stall(Arc::new(move || {
            let n = c.fetch_add(1, Ordering::SeqCst);
            let until = Instant::now() + Duration::from_secs(4); // inside STAT_LIMIT, so a red run still ends
            while n == b.load(Ordering::SeqCst) && !r.load(Ordering::SeqCst) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(5));
            }
        }));
        let first = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
        assert!(!handles_of(&first).is_empty());
        std::fs::write(w.path("watched.config"), "[a]\n\tb = 22\n").unwrap();
        w.answer_with_real_stamps();
        let at = calls.load(Ordering::SeqCst);
        block_call.store(at, Ordering::SeqCst); // the click's sample, of the old baseline
        let hold = during_run.then(|| w.rig.hold());
        let spawns = w.rig.spawns();
        let click = w.rig.live.check_before_sink();
        let ask = async {
            until("the click is sampling", || calls.load(Ordering::SeqCst) > at).await;
            let run = w.rig.ask(b2_ask("focus", json!("whatYouDid")));
            let release = async {
                if let Some(hold) = &hold {
                    // The run has cleared the old handles and is in flight. The click lands now, with nothing live.
                    until("the run started", || w.rig.spawns() > spawns).await;
                    released.store(true, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    std::fs::remove_file(hold).expect("release");
                }
            };
            let (r, ()) = tokio::join!(run, release);
            released.store(true, Ordering::SeqCst);
            r
        };
        let ((), r) = tokio::join!(click, ask);
        let r = r.expect("the run").0;
        let fresh = handles_of(&r);
        assert!(!fresh.is_empty(), "during_run {during_run}: the run minted: {r}");
        assert!(fresh.iter().all(|h| w.rig.live.holds_handle(h)), "during_run {during_run}: the click cleared a fresh mint");
    }
}

/// A click on an old handle after everything was cleared has nothing to end: a full run in flight, whose engine read
/// the changed file, keeps its fresh mint.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_a_click_with_nothing_live_does_not_cost_a_run_its_mint() {
    let w = Watched::new("t7idleclick");
    let first = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
    assert!(!handles_of(&first).is_empty());
    std::fs::write(w.path("watched.config"), "[a]\n\tb = 22\n").unwrap();
    let cleared = w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.expect("minute").0;
    assert_eq!(cleared["actions"], json!([]));
    w.answer_with_real_stamps();
    let hold = w.rig.hold();
    let spawns = w.rig.spawns();
    let run = w.rig.ask(b2_ask("focus", json!("whatYouDid")));
    let click = async {
        until("the run started", || w.rig.spawns() > spawns).await;
        w.rig.live.check_before_sink().await;
        std::fs::remove_file(&hold).expect("release");
    };
    let (r, ()) = tokio::join!(run, click);
    let r = r.expect("the run").0;
    assert!(!handles_of(&r).is_empty(), "the old baseline still differs, but nothing was live to clear: {r}");
}

/// The same race across a full run: what it minted was checked before the clear, so it is not put on the reply; and
/// no handle minted later can repeat a generation an older handle carried.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_a_clear_during_an_in_flight_full_run_survives_the_commit() {
    let w = Watched::new("t7racefull");
    let repo = Repo::new("t7racefull-target", &[]);
    let first = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
    let old = handles_of(&first);
    assert!(!old.is_empty());
    let hold = w.rig.hold();
    let spawns = w.rig.spawns();
    let run = w.rig.ask(b2_ask("focus", json!("whatYouDid")));
    let click = async {
        until("the run started", || w.rig.spawns() > spawns).await;
        let path = w.path("watched.config");
        let (text, mtime) = (std::fs::read(&path).unwrap(), std::fs::metadata(&path).unwrap().modified().unwrap());
        std::fs::write(&path, "[a]\n\tb = 22\n").unwrap();
        w.rig.live.check_before_sink().await;
        assert!(old.iter().all(|h| !w.rig.live.holds_handle(h)), "the click cleared them");
        // Put the file back, time included: the post-run sample agrees, so only the carried clear can keep this reply empty.
        std::fs::write(&path, text).unwrap();
        std::fs::File::options().write(true).open(&path).unwrap().set_modified(mtime).unwrap();
        // A visibly different document, with a stat target the old state never had: B1's half of the commit must land.
        let mut d = w.doc();
        d["repoViews"][0]["uncommitted"] = json!({ "count": 9 });
        d["repos"] = json!([target_json(&repo, &d["repoViews"][0]["key"])]);
        w.rig.answer_all(&d);
        std::fs::remove_file(&hold).expect("release");
    };
    let (r, ()) = tokio::join!(run, click);
    let r = r.expect("the run").0;
    assert_eq!(r["actions"], json!([]), "{r}");
    assert_eq!(r["repoViews"][0]["uncommitted"], json!({ "count": 9 }), "the new document was not held: {r}");
    let later = w.rig.ask(b2_ask("focus", json!("whatYouDid"))).await.expect("focus").0;
    let new = handles_of(&later);
    assert!(!new.is_empty(), "the next full run mints: {later}");
    assert!(new.iter().all(|h| !old.contains(h)), "a generation repeated");
    // The new target was committed too: quiet is quiet, and a ref change against it runs.
    let quiet = w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.expect("minute").0;
    assert_eq!(quiet["gate"], "held", "{quiet}");
    tick();
    repo.git(&["branch", "side"]);
    let spawns = w.rig.spawns();
    let changed = w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.expect("minute").0;
    assert_eq!(changed["gate"], "ran", "a stat change against the new target did not run: {changed}");
    assert_eq!(w.rig.stdin(spawns)["scope"], "all");
}

/// A failed run commits nothing, and a clear made during it stays made.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_a_clear_during_a_run_that_fails_stays() {
    let w = Watched::new("t7racefail");
    let first = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
    let old = handles_of(&first);
    let hold = w.rig.hold();
    std::fs::write(w.rig.scratch.join("fail"), "").unwrap();
    let spawns = w.rig.spawns();
    let run = w.rig.ask(b2_ask("focus", json!("whatYouDid")));
    let click = async {
        until("the run started", || w.rig.spawns() > spawns).await;
        std::fs::write(w.path("watched.config"), "[a]\n\tb = 22\n").unwrap();
        w.rig.live.check_before_sink().await;
        std::fs::remove_file(&hold).expect("release");
    };
    let (r, ()) = tokio::join!(run, click);
    assert!(r.is_err());
    std::fs::remove_file(w.rig.scratch.join("fail")).unwrap();
    assert!(old.iter().all(|h| !w.rig.live.holds_handle(h)));
    w.rig.shown.store(false, std::sync::atomic::Ordering::SeqCst);
    let held = w.rig.ask(b2_ask("minute", json!("launchpad"))).await.expect("held").0;
    assert_eq!(held["actions"], json!([]));
    assert_eq!(held["repoViews"], first["repoViews"]);
}

/// R3-L9: the run-latch-busy Held answers and `stat_busy` neither sample nor mint. They give what is already held, or
/// the existing error, on a document already cleared.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_the_busy_paths_start_no_sampler_and_keep_the_cleared_document() {
    use daily_briefing_gui_lib::repos::ReposLive;
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let mut w = Watched::new("t7busy");
    let stalled = Arc::new(AtomicBool::new(false));
    let calls = Arc::new(AtomicUsize::new(0));
    let block_call = Arc::new(AtomicUsize::new(usize::MAX));
    let (s, c, b) = (stalled.clone(), calls.clone(), block_call.clone());
    w.rig.live = ReposLive::default().with_stat_stall(Arc::new(move || {
        let n = c.fetch_add(1, Ordering::SeqCst);
        let until = Instant::now() + Duration::from_secs(60);
        while n == b.load(Ordering::SeqCst) && s.load(Ordering::SeqCst) && Instant::now() < until {
            std::thread::sleep(Duration::from_millis(10));
        }
    }));
    let first = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
    assert!(!handles_of(&first).is_empty());
    std::fs::write(w.path("watched.config"), "[a]\n\tb = 22\n").unwrap();
    let cleared = w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.expect("minute").0;
    assert_eq!(cleared["actions"], json!([]));

    // Busy: a run in flight. A minute ask, a waiter and a second waiter all answer from what is held, sampling nothing.
    let hold = w.rig.hold();
    let spawns = w.rig.spawns();
    let run = w.rig.ask(b2_ask("focus", json!("whatYouDid")));
    let waiter = w.rig.ask(b2_ask("focus", json!("whatYouDid")));
    let during = async {
        until("the run and its waiter", || w.rig.spawns() > spawns && w.rig.live.is_owed()).await;
        let at = calls.load(Ordering::SeqCst);
        let busy_minute = w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.expect("minute").0;
        let busy_owed = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
        assert_eq!(calls.load(Ordering::SeqCst), at, "a busy ask started a sampler");
        assert_eq!(busy_minute["gate"], "held");
        assert_eq!(busy_owed["gate"], "held");
        assert_eq!(busy_minute["actions"], json!([]), "{busy_minute}");
        assert_eq!(busy_owed["actions"], json!([]), "{busy_owed}");
        std::fs::remove_file(&hold).expect("release");
    };
    let (a, b, ()) = tokio::join!(run, waiter, during);
    a.expect("the run");
    b.expect("the waiter");

    // Mint again, clear again and block the stat work: past the limit the ask fails; while it is blocked, every ask fails
    // at once.
    w.answer_with_real_stamps();
    let again = w.rig.ask(b2_ask("focus", json!("whatYouDid"))).await.expect("focus").0;
    assert!(!handles_of(&again).is_empty(), "{again}");
    std::fs::write(w.path("watched.config"), "[a]\n\tb = 333\n").unwrap();
    let cleared = w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.expect("minute").0;
    assert_eq!(cleared["actions"], json!([]));
    stalled.store(true, Ordering::SeqCst);
    // Block B1's stat work alone (B2's sample comes first and returns), so B2's lane is free and only the order of the
    // checks can keep a later ask from sampling.
    block_call.store(calls.load(Ordering::SeqCst) + 1, Ordering::SeqCst);
    assert!(w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.is_err(), "the stat stalled");
    assert!(w.rig.live.is_stat_busy());
    let at = calls.load(Ordering::SeqCst);
    let started = Instant::now();
    let err = w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.expect_err("stat_busy stays the existing error");
    assert!(started.elapsed() < Duration::from_secs(1));
    assert_eq!(serde_json::to_value(err).unwrap()["detail"], "the live git check could not be completed");
    assert_eq!(calls.load(Ordering::SeqCst), at, "stat_busy started a sampler");
    stalled.store(false, Ordering::SeqCst);
    until("the blocked stat ended", || !w.rig.live.is_stat_busy()).await;
    w.rig.shown.store(false, Ordering::SeqCst);
    let held = w.rig.ask(b2_ask("minute", json!("launchpad"))).await.expect("held").0;
    assert_eq!(held["actions"], json!([]), "Held stays cleared");
}

/// A B2 input that never returns (a dead mount) is B2's problem alone: the ask still answers from B1's own stat work,
/// the handles go, and while that one sample is blocked no second one starts.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_a_b2_sample_that_never_returns_costs_b2_alone_and_only_one_thread() {
    use daily_briefing_gui_lib::repos::{ReposLive, B2_SAMPLE_LIMIT, STAT_LIMIT};
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let mut w = Watched::new("t7hang");
    let calls = Arc::new(AtomicUsize::new(0));
    let block_call = Arc::new(AtomicUsize::new(usize::MAX));
    let released = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let (c, b, r) = (calls.clone(), block_call.clone(), released.clone());
    w.rig.live = ReposLive::default().with_stat_stall(Arc::new(move || {
        let n = c.fetch_add(1, Ordering::SeqCst);
        if n == b.load(Ordering::SeqCst) {
            let until = Instant::now() + Duration::from_secs(60);
            while !r.load(Ordering::SeqCst) && Instant::now() < until {
                std::thread::sleep(Duration::from_millis(10));
            }
        }
    }));
    let first = w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.expect("first").0;
    let old = handles_of(&first);
    assert!(!old.is_empty());
    // The next stall call is the B2 sample of the next ask, which comes before B1's stat work.
    block_call.store(calls.load(Ordering::SeqCst), Ordering::SeqCst);
    let started = Instant::now();
    let r1 = w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.expect("B1 still answers").0;
    let took = started.elapsed();
    assert_eq!(B2_SAMPLE_LIMIT, Duration::from_millis(1_000));
    assert!(took >= B2_SAMPLE_LIMIT && took < STAT_LIMIT, "B2's sample has its own limit, not B1's: {took:?}");
    assert_eq!(r1["gate"], "held");
    assert_eq!(r1["actions"], json!([]), "{r1}");
    assert_eq!(r1["repoViews"], first["repoViews"]);
    assert!(old.iter().all(|h| !w.rig.live.holds_handle(h)));
    // Still blocked: answers at once, one more stall call (B1's own stat work), no second B2 sample.
    let at = calls.load(Ordering::SeqCst);
    let started = Instant::now();
    let r2 = w.rig.ask(b2_ask("minute", json!("whatYouDid"))).await.expect("B1 still answers").0;
    assert!(started.elapsed() < Duration::from_secs(1), "{:?}", started.elapsed());
    assert_eq!(r2["gate"], "held");
    assert_eq!(calls.load(Ordering::SeqCst), at + 1, "a second B2 sample started");
    // A full run while it is blocked: B1 runs, and with no sample to accept against, nothing is minted.
    let full = w.rig.ask(b2_ask("focus", json!("whatYouDid"))).await.expect("focus").0;
    assert_eq!(full["gate"], "ran");
    assert_eq!(full["actions"], json!([]), "{full}");
    assert_eq!(calls.load(Ordering::SeqCst), at + 2, "only B1's stat work");
    // Released, a full run mints again once the blocked thread has ended (bounded, so a red run still ends).
    released.store(true, Ordering::SeqCst);
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let back = w.rig.ask(b2_ask("focus", json!("whatYouDid"))).await.expect("focus").0;
        if !handles_of(&back).is_empty() {
            break;
        }
        assert!(Instant::now() < deadline, "no mint after the sample ended: {back}");
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    // The acceptance has the same short limit: a stuck one costs that reply its handles, and B1's reply still lands.
    // Its call comes after this ask's B2 sample and B1's stat work.
    released.store(false, Ordering::SeqCst);
    block_call.store(calls.load(Ordering::SeqCst) + 2, Ordering::SeqCst);
    let started = Instant::now();
    let stuck = w.rig.ask(b2_ask("focus", json!("whatYouDid"))).await.expect("B1 still answers").0;
    let took = started.elapsed();
    released.store(true, Ordering::SeqCst);
    assert!(took >= B2_SAMPLE_LIMIT && took < STAT_LIMIT, "{took:?}");
    assert_eq!(stuck["gate"], "ran");
    assert_eq!(stuck["actions"], json!([]), "{stuck}");
}

/// The gate word each step of the parity walk must reach, so the walk cannot quietly stop covering a row.
fn expected_gate(step: &str) -> &'static str {
    match step {
        "hidden first (row 2, owed)" | "no slide (row 1)" => "noResult",
        "quiet minute (row 5, held)" | "hidden minute (row 2)" | "hidden first (owed again)" => "held",
        _ => "ran",
    }
}

/// B2's inputs do not perturb B1: across every existing gate row, with B2's sources changing all the while, the only
/// member that may differ is `actions`. Both arms run this code, one with stat inputs and one with none, so this says
/// the new state leaves B1 alone; it is no comparison with the code from before B2.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_b2_inputs_do_not_perturb_b1_across_every_gate_row() {
    let on = Watched::new("t7paron");
    let off = Watched::new("t7paroff");
    let (on_repo, off_repo) = (Repo::new("t7paron-target", &[]), Repo::new("t7paroff-target", &[]));
    let answer_on = || {
        let mut d = on.doc();
        d["repos"] = json!([target_json(&on_repo, &d["repoViews"][0]["key"])]);
        on.rig.answer_all(&d);
    };
    let mut plain = off.base.clone();
    plain["actionFacts"] = json!([]);
    plain["repos"] = json!([target_json(&off_repo, &plain["repoViews"][0]["key"])]);
    off.rig.answer_all(&plain);
    let other_page = json!({
        "labels": [{ "key": "repo", "tokens": [] }], "branches": [], "pageDate": "2026-01-12",
        "reason": "minute", "current": "whatYouDid",
    });
    let steps: Vec<(&str, bool, Value)> = vec![
        ("hidden first (row 2, owed)", false, b2_ask("first", json!("whatYouDid"))),
        ("no slide (row 1)", true, b2_ask("minute", Value::Null)),
        ("the owed first runs (row 3)", true, b2_ask("minute", json!("whatYouDid"))),
        ("the follow-up a new stat target needs (row 5)", true, b2_ask("minute", json!("whatYouDid"))),
        ("quiet minute (row 5, held)", true, b2_ask("minute", json!("whatYouDid"))),
        ("launchpad minute (row 5, uncommitted)", true, b2_ask("minute", json!("launchpad"))),
        ("focus (row 4)", true, b2_ask("focus", json!("whatYouDid"))),
        ("first (row 4)", true, b2_ask("first", json!("launchpad"))),
        ("a ref change (row 5)", true, b2_ask("minute", json!("whatYouDid"))),
        ("hidden minute (row 2)", false, b2_ask("minute", json!("launchpad"))),
        ("hidden first (owed again)", false, b2_ask("first", json!("launchpad"))),
        ("the owed first, on a minute (row 5)", true, b2_ask("minute", json!("launchpad"))),
        ("a new page (row 3)", true, other_page),
        ("back (row 3)", true, b2_ask("minute", json!("whatYouDid"))),
    ];
    for (n, (what, shown, ask)) in steps.into_iter().enumerate() {
        // Each step changes one of B2's sources on the enabled side first, so B2 is clearing throughout.
        (CHANGES[n % 2].1)(&on);
        answer_on();
        if what.starts_with("a ref change") {
            tick();
            on_repo.git(&["branch", "side"]);
            off_repo.git(&["branch", "side"]);
        }
        for rig in [&on.rig, &off.rig] {
            rig.shown.store(shown, std::sync::atomic::Ordering::SeqCst);
        }
        let a = on.rig.ask(ask.clone()).await.unwrap_or_else(|e| panic!("{what}: {e:?}")).0;
        let b = off.rig.ask(ask).await.unwrap_or_else(|e| panic!("{what}: {e:?}")).0;
        assert_eq!(b1_part(&a), b1_part(&b), "{what}: B1's reply differs with B2 on");
        assert_eq!(a["gate"], expected_gate(what), "{what}: the walk did not reach this row");
        assert_eq!(on.rig.spawns(), off.rig.spawns(), "{what}: B1's runs differ with B2 on");
        for i in 0..on.rig.spawns() {
            assert_eq!(on.rig.stdin(i), off.rig.stdin(i), "{what}: run {i}");
        }
    }
}

/// The same two arms over B1's bookkeeping: the ungated arming of a rejected record, the backoff for a repo that keeps
/// timing out, and an errored stat listed in `unknownRepos`, with B2 clearing throughout.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_b2_inputs_do_not_perturb_b1_bookkeeping() {
    let on = Watched::new("t7bookon");
    let off = Watched::new("t7bookoff");
    let (on_repo, off_repo) = (Repo::new("t7bookon-target", &[]), Repo::new("t7bookoff-target", &[]));
    let answer = |bend: &dyn Fn(&mut Value)| {
        let mut a = on.doc();
        a["repos"] = json!([target_json(&on_repo, &a["repoViews"][0]["key"])]);
        bend(&mut a);
        on.rig.answer_all(&a);
        let mut b = off.base.clone();
        b["actionFacts"] = json!([]);
        b["repos"] = json!([target_json(&off_repo, &b["repoViews"][0]["key"])]);
        bend(&mut b);
        off.rig.answer_all(&b);
    };
    // B2's source changes before every step, on the enabled arm only: `touch` then `answer` is a fresh mint, and `touch`
    // alone is a clear on the next ask.
    let edits = std::cell::Cell::new(0usize);
    let touch = || {
        std::fs::write(on.path("watched.config"), format!("[a]\n\tb = {}\n", edits.get())).unwrap();
        edits.set(edits.get() + 1);
    };
    let walk = |what: &'static str, reason: &'static str| {
        let (on, off) = (&on, &off);
        async move {
            let ask = b2_ask(reason, json!("whatYouDid"));
            let a = on.rig.ask(ask.clone()).await.unwrap_or_else(|e| panic!("{what}: {e:?}")).0;
            let b = off.rig.ask(ask).await.unwrap_or_else(|e| panic!("{what}: {e:?}")).0;
            assert_eq!(b1_part(&a), b1_part(&b), "{what}: B1's reply differs with B2 on");
            assert_eq!(on.rig.spawns(), off.rig.spawns(), "{what}: B1's runs differ with B2 on");
            for i in 0..on.rig.spawns() {
                assert_eq!(on.rig.stdin(i), off.rig.stdin(i), "{what}: run {i}");
            }
            a
        }
    };
    let plain = |_: &mut Value| {};
    touch();
    answer(&plain);
    walk("first run", "first").await;
    touch();
    answer(&plain);
    assert!(!handles_of(&walk("baseline run", "focus").await).is_empty(), "the enabled arm mints");

    // A rejected record arms one ungated minute, and the armed minute spends it.
    let rejected = |d: &mut Value| d["record"]["accepted"] = json!(false);
    touch();
    answer(&rejected);
    walk("rejected record", "focus").await;
    touch();
    answer(&rejected);
    assert_eq!(walk("the armed minute", "minute").await["gate"], "ran");
    touch();
    assert_eq!(walk("the arming is spent, and B2 clears", "minute").await["gate"], "held");

    // A repo timing out backs off: 1, then 2 eligible minutes.
    let timing_out = |d: &mut Value| {
        d["repoViews"][0]["state"] = json!("unknown");
        d["repoViews"][0]["reason"] = json!("timeout");
    };
    touch();
    answer(&timing_out);
    walk("a timeout", "focus").await;
    touch();
    assert_eq!(walk("retry after one minute", "minute").await["gate"], "ran");
    touch();
    assert_eq!(walk("the wait doubled", "minute").await["gate"], "held");
    touch();
    assert_eq!(walk("retry after two minutes", "minute").await["gate"], "ran");

    // Recovered: mint again, and a change clears on a held reply.
    touch();
    answer(&plain);
    assert!(!handles_of(&walk("recovered", "focus").await).is_empty(), "the enabled arm mints again");
    touch();
    let quiet = walk("a quiet minute clears B2 alone", "minute").await;
    assert_eq!(quiet["gate"], "held");
    assert_eq!(quiet["actions"], json!([]), "B2 did not clear, so this walk would prove nothing: {quiet}");

    // An errored stat: listed in `unknownRepos` once it fails, on both arms alike, and a change again when it recovers.
    let broken = (BrokenStat::of(&on_repo), BrokenStat::of(&off_repo));
    if broken.0.ignored() {
        return;
    }
    touch();
    let turned = walk("the stat errors", "minute").await;
    assert_eq!(turned["unknownRepos"], json!([turned["repoViews"][0]["key"]]), "{turned}");
    touch();
    let again = walk("a repeated error is no change", "minute").await;
    assert_eq!(again["gate"], "held");
    assert_eq!(again["unknownRepos"], turned["unknownRepos"]);
    drop(broken);
    touch();
    let back = walk("the stat recovers", "minute").await;
    assert_eq!(back["gate"], "ran");
    assert_eq!(back["unknownRepos"], json!([]));
}


/// A full run can replace the generation while accepting exactly the same source set and stamps. The old click's
/// timeout belongs only to its old generation, even though comparing inputs alone cannot distinguish the two.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_an_old_click_timeout_leaves_an_identical_input_fresh_generation_alone() {
    use daily_briefing_gui_lib::repos::{ReposLive, STAT_LIMIT};
    use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let mut w = Watched::new("sameinputs");
    let calls = Arc::new(AtomicUsize::new(0));
    let blocked = Arc::new(AtomicUsize::new(usize::MAX));
    let release = Arc::new(AtomicBool::new(false));
    let (c, b, r) = (calls.clone(), blocked.clone(), release.clone());
    w.rig.live = ReposLive::default().with_stat_stall(Arc::new(move || {
        let n = c.fetch_add(1, Ordering::SeqCst);
        let deadline = Instant::now() + STAT_LIMIT + Duration::from_secs(2);
        while n == b.load(Ordering::SeqCst) && !r.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(5));
        }
    }));
    let old = handles_of(&w.rig.ask(b2_ask("first", json!("whatYouDid"))).await.unwrap().0);
    assert!(!old.is_empty());
    let at = calls.load(Ordering::SeqCst);
    blocked.store(at, Ordering::SeqCst);
    let click = w.rig.live.check_before_sink();
    let run = async {
        until("the old click is sampling", || calls.load(Ordering::SeqCst) > at).await;
        let reply = w.rig.ask(b2_ask("focus", json!("whatYouDid"))).await.unwrap().0;
        let fresh = handles_of(&reply);
        assert!(!fresh.is_empty() && fresh.iter().all(|h| !old.contains(h) && w.rig.live.holds_handle(h)));
        fresh
    };
    let ((), fresh) = tokio::join!(click, run);
    release.store(true, Ordering::SeqCst);
    assert!(fresh.iter().all(|h| w.rig.live.holds_handle(h)), "the old timeout cleared a fresh generation with identical inputs");
}

/// Real engine facts, Rust acceptance, and held-handle checks share one isolated scratch tree. The PATH wrapper only
/// supplies the git fixture's config isolation after cleanGitEnv removes inherited GIT_*; all git commands stay real.
#[cfg(unix)]
#[tokio::test(flavor = "multi_thread")]
async fn t7_real_engine_worktree_scope_and_kernel_order_include_are_accepted() {
    use daily_briefing_gui_lib::engine::{bundled_sidecar_path, EngineClient, NoProgress, Operation, Outcome};
    use daily_briefing_gui_lib::repos::{accept_stat_inputs, parse_action_facts, B2StatInputs};
    for case in ["kernel-include", "candidate-enotdir", "unshown", "shown"] {
        let r = Repo::new(case, &["--template="]);
        let root = std::fs::canonicalize(&r.scratch.path).unwrap();
        let repo = std::fs::canonicalize(&r.dir).unwrap();
        r.git(&["remote", "add", "origin", "https://github.com/org/repo.git"]);
        r.git(&["update-ref", "refs/remotes/origin/main", "HEAD"]);
        r.git(&["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
        let sha = r.git(&["rev-parse", "HEAD"]);
        let linked = root.join("linked");
        r.git(&["worktree", "add", "-q", "-b", "linked", linked.to_str().unwrap()]);
        let bin = root.join("bin");
        std::fs::create_dir(&bin).unwrap();
        let git_path = Command::new("sh").args(["-c", "command -v git"]).output().unwrap();
        assert!(git_path.status.success());
        let git_path = String::from_utf8(git_path.stdout).unwrap().trim().to_string();
        common::fake_sidecar(&bin, "git", &format!(
            "GIT_CONFIG_NOSYSTEM=1 GIT_CONFIG_GLOBAL={} exec {} \"$@\"",
            common::sq(root.join("gitconfig").to_str().unwrap()), common::sq(&git_path)
        ));
        let mut client = EngineClient::with_program(bundled_sidecar_path().unwrap())
            .with_path_override(format!("{}:{}", bin.display(), std::env::var("PATH").unwrap()))
            .with_env("HOME", root.as_os_str()).with_env("TMPDIR", root.as_os_str());
        for (k, v) in common::sandbox_env(&root) { client = client.with_env(k, v); }
        let config_dir = root.join("config/daily-briefing");
        std::fs::create_dir_all(&config_dir).unwrap();
        std::fs::write(config_dir.join("config.json"), json!({
            "repos": [repo], "provider": { "cli": "unused", "argv": [], "promptVia": "stdin" }
        }).to_string()).unwrap();
        if case == "kernel-include" {
            std::fs::create_dir_all(root.join("far/sub")).unwrap();
            std::fs::create_dir(root.join("near")).unwrap();
            std::os::unix::fs::symlink(root.join("far/sub"), root.join("near/link")).unwrap();
            std::fs::write(root.join("far/kernel.config"), "[fixture]\n\ta = 1\n").unwrap();
            r.git(&["config", "include.path", &format!("{}/near/link/../kernel.config", root.display())]);
        } else if case == "candidate-enotdir" {
            std::fs::write(root.join("plain"), "x").unwrap();
            std::os::unix::fs::symlink("plain/child", root.join(".gitconfig")).unwrap();
        }
        let shown = case == "shown";
        let branch = if shown { "linked" } else { "main" };
        let request = ReposRequest::new(ReposScope::All, "2026-01-11",
            vec![ReposLabel { key: "repo".into(), tokens: vec![sha] }],
            vec![ReposBranch { key: "repo".into(), name: branch.into() }]).unwrap();
        let result = client.invoke(Operation::ReposStatus { request }, &NoProgress).await.unwrap();
        assert_eq!(result.outcome, Outcome::Delivered, "{case}: {result:?}");
        let doc = result.payload.unwrap();
        let facts = parse_action_facts(doc.get("actionFacts").cloned());
        assert_eq!(facts.len(), 1, "{case}: {doc}");
        let accepted = accept_stat_inputs(&facts, &B2StatInputs::default());
        assert!(accepted.holds(&facts[0].repo_key), "{case}: real engine inputs were refused: {facts:?}");
        if case == "kernel-include" {
            let paths: Vec<&str> = facts[0].stat_inputs.as_ref().unwrap().iter().map(|i| i.path.as_str()).collect();
            assert!(paths.contains(&root.join("near/link").to_str().unwrap()));
            assert!(paths.contains(&root.join("far/kernel.config").to_str().unwrap()));
            // A new link inside the hop's resolution is unreported even though the hop's own text and final input
            // stamps are unchanged. Accepting directory hops must still detect this resolution change.
            std::fs::create_dir(root.join("other")).unwrap();
            std::fs::remove_dir(root.join("far/sub")).unwrap();
            std::os::unix::fs::symlink(root.join("other"), root.join("far/sub")).unwrap();
            assert!(accept_stat_inputs(&facts, &B2StatInputs::default()).is_empty(), "an unreported link in a directory hop was accepted");
            std::fs::remove_file(root.join("far/sub")).unwrap();
            std::fs::create_dir(root.join("far/sub")).unwrap();
        }
        let rig = Rig::new(case);
        rig.answer_all(&doc);
        let ask = json!({ "labels": [{ "key": "repo", "tokens": [] }],
            "branches": [{ "key": "repo", "name": branch }], "pageDate": "2026-01-11",
            "reason": "first", "current": "leftOff" });
        let held = handles_of(&rig.ask(ask).await.unwrap().0);
        assert!(!held.is_empty(), "{case}: the real facts minted no handles: {doc}");
        r.git(&["worktree", "remove", "--force", linked.to_str().unwrap()]);
        rig.live.check_before_sink().await;
        assert_eq!(held.iter().all(|h| rig.live.holds_handle(h)), !shown, "{case}: removal invalidated the wrong scope");
    }
}
