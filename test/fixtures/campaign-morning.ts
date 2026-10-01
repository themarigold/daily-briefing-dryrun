// test/fixtures/campaign-morning.ts — the §5.3 FIXTURE MORNING (tier B), shared by the D10 layout pin
// (T1.3), the validation and apply cases (T1.4) and the replay's dry-run self-test (T5.4): seven offered
// items and two unresolved bullets, Stage-1 count 9, two labels. Stated in the spec in full; built here
// ONCE so the three consumers cannot drift apart. NOT a test file — importing one re-registers its tests.
//
//   G1  accountant_ai  group  header `queue.py retry path reworked — 2 commits`
//                             bullets `queue.py retry path reworked twice` (A), `retry backoff added` (B)
//   G2  accountant_ai  single `retry backoff tuned for the queue` (C)
//   G3  quant_stocks   single `sharpe ratio guard added` (D)
//   G4  accountant_ai  single `deadbeef1 landed on the queue` (E)
//   —   unresolved            `a bullet with no evidence` (entry 5)
//   G5  accountant_ai  single `work on accountant_ai queue continued` (F)
//   G6  accountant_ai  single `the queue.py retry path reworked again` (G)
//   G7  accountant_ai  single `retry backoff also landed here` (H)
//   —   unresolved            `cites nothing real` (entry 9; `9999999` clears the 7-char floor and hits nothing)
//
// Ids follow the index of each item's first member entry (§4.3), which is why G3 is the quant_stocks bullet
// at entry 3 and the label blocks come out accountant_ai first.
import type { Activity, BriefingStruct } from "../../src/types";

/** Full 40-char ids from an 8-char prefix, so `sha8` in the prompt reads as the prefix itself and a 7-char
 *  cite is a genuine prefix. */
export const full = (prefix8: string): string => (prefix8 + "0123456789abcdef0123456789abcdef").slice(0, 40);

const T = "2026-09-23T10:00:00-07:00";
const commit = (prefix8: string, subject: string, diffstat: { file: string; added: number; removed: number }[]): Activity =>
  ({ source: "git", kind: "commit", event_id: full(prefix8), repo: "/r", timestamp: T, text: subject, meta: { diffstat } });
const row = (file: string, added: number, removed = 0) => ({ file, added, removed });

export const A = full("a1a1a1a1"), B = full("b2b2b2b2"), C = full("c3c3c3c3"), D = full("d4d4d4d4");
export const E = full("e5e5e5e5"), F = full("f6f6f6f6"), G = full("a7a7a7a7"), H = full("b8b8b8b8");

/** The ctx commit population (`kind === "commit"`, string `event_id`), in window. */
export const MORNING_COMMITS: Activity[] = [
  commit("a1a1a1a1", "fix(queue): retry path reworked twice", [row("queue.py", 30, 4), row("retry.py", 5)]),
  commit("b2b2b2b2", "feat(queue): retry backoff added", [row("queue.py", 20)]),
  // churn-ASCENDING on purpose (harden r1, C5): the prompt's `files:` line is the three MOST-changed files,
  // `queue.py, config.py, docs/queue.md` — the D10 layout pin reads that order only if `topFiles` sorts
  commit("c3c3c3c3", "feat(queue): retry backoff tuned", [row("tests/test_queue.py", 1), row("docs/queue.md", 2), row("config.py", 4), row("queue.py", 10)]),
  commit("d4d4d4d4", "feat(quant): sharpe ratio guard", [row("quant_stocks/guard.py", 12)]),
  commit("e5e5e5e5", "chore(queue): deadbeef1 landed", [row("queue.py", 3)]),
  commit("f6f6f6f6", "chore: queue work continued", [row("queue.py", 2)]),
  commit("a7a7a7a7", "fix(queue): retry path reworked again", [row("queue.py", 8)]),
  commit("b8b8b8b8", "feat(queue): retry backoff also landed", [row("backoff.py", 6)]),
];

export const MORNING_COMMITS_BY_ID: ReadonlyMap<string, Activity> = new Map(MORNING_COMMITS.map((a) => [a.event_id, a]));

const HEADER = "queue.py retry path reworked — 2 commits";

/** The Stage-1 recap as `clusterRecap` would have stamped it (the group at entries 0–1). */
export const MORNING_RECAP: BriefingStruct["recap"] = [
  { repo: "accountant_ai", text: "queue.py retry path reworked twice", evidence: "a1a1a1a", group: HEADER },
  { repo: "accountant_ai", text: "retry backoff added", evidence: "b2b2b2b", group: HEADER },
  { repo: "accountant_ai", text: "retry backoff tuned for the queue", evidence: "c3c3c3c" },
  { repo: "quant_stocks", text: "sharpe ratio guard added", evidence: "d4d4d4d" },
  { repo: "accountant_ai", text: "deadbeef1 landed on the queue", evidence: "e5e5e5e" },
  { repo: "accountant_ai", text: "a bullet with no evidence" },
  { repo: "accountant_ai", text: "work on accountant_ai queue continued", evidence: "f6f6f6f" },
  { repo: "accountant_ai", text: "the queue.py retry path reworked again", evidence: "a7a7a7a" },
  { repo: "accountant_ai", text: "retry backoff also landed here", evidence: "b8b8b8b" },
  { repo: "accountant_ai", text: "cites nothing real", evidence: "9999999" },
];

/** The struct around it: `stateAsOf` present so the page carries a stamp, everything else quiet. */
export const MORNING_STRUCT: BriefingStruct = {
  date: "2026-09-24", machineScope: "fixture", provider: "canned",
  resume: [], suggestions: [], stateAsOf: "07:24", recap: MORNING_RECAP,
};

/** Every configured label of the fixture deployment (rule 5's universe, check (c)'s rows). */
export const MORNING_LABELS = ["accountant_ai", "quant_stocks"];
