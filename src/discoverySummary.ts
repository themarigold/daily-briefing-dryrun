// src/discoverySummary.ts — v0.2.1 §2.4 (D-10 option a): say WHICH folders discovery could not read, and
// decide when an unreadable SEARCH FOLDER means the day must not be marked done.
//
// WHY THIS EXISTS. Discovery issues (a denied, unreadable or missing folder) reached stderr, briefing.log
// and the `run --json` envelope, but never the briefing. So a denied search folder holding every repo
// produced a stamped "(no commits in the window)" briefing — a quiet day with no explanation, which is the
// one thing a beta tester would read as "the app is broken".
//
// THREE EXPORTS, ONE INPUT. `countedIssues` decides which discovery issues are worth telling the user
// about; `discoverySummary` turns them into ONE sentence for the briefing, stderr and the skip detail;
// `discoveryBlocked` decides whether they block the day. All three are pure — no fs, no clock, no env — so
// core.ts (the run) and json.ts (`doctor`) apply literally the same rule. The predicate lives HERE and not
// in core.ts so json.ts can import it without pulling in core's import closure.
//
// ⚠ RUNTIME CODE, NOT EVAL CODE. Runtime modules may not import `src/eval/**` (spec §1: it would couple
// the shipped engine to the release gate's own vocabulary). `LABEL_DENYLIST` is therefore a MIRROR of eval
// vocabulary, and test/discoverySummary.test.ts reads `src/eval/posture.ts` as TEXT and fails if the mirror
// misses an entry.
import { sep } from "node:path";
import { isExcludedRepo } from "./config";
import { isInaccessible, type PathIssue } from "./protectedPath";
import { stripControl } from "./render";
import type { Config } from "./types";

/** Text a folder LABEL must never carry, because the summary lands in `struct.warnings` and the rendered
 *  `⚠` line, where substring readers classify warnings:
 *   - the 6 `POSTURE_MARKERS` of `src/eval/posture.ts` — a label carrying one would make the summary read
 *     as a hardening-posture warning to `isPostureWarning` (a folder literally named "working directory");
 *   - the 4 exported sentinels of the same file (`TRUNCATION_SENTINEL`, `API_TRUNCATION_SENTINEL`,
 *     `API_TRANSPORT_SENTINEL`, `API_CLEARTEXT_SENTINEL`);
 *   - "didn't resolve": the eval's grounding check reads a warning carrying it as the generator's
 *     SHA-removal notice (`src/eval/checks.ts`), and `src/audit.ts` skips any briefing line carrying it.
 *  Generation posture is not computed for real runs today, so this is defence in depth (spec §2.4.2).
 *  ⚠ A MIRROR: test/discoverySummary.test.ts pins it against the eval source. */
export const LABEL_DENYLIST: readonly string[] = Object.freeze([
  "provider hardening",
  "did not inject",
  "rejected an injected",
  "hardening flags are disabled",
  "widens what the provider can do",
  "working directory",
  "its output stream never closed",
  "stopped at its output-token limit",
  "no CLI process to harden",
  "sent in cleartext over plain http",
  "didn't resolve",
]);

/** What a label that matched `LABEL_DENYLIST` is shown as. The real path stays in the per-folder
 *  `warnFor` line that stderr (and so briefing.log) carries for every issue. */
export const HIDDEN_LABEL = "a folder whose name can't be shown here (see briefing.log)";

/** At most this many folders are named per clause; the rest are counted ("and 2 more"). */
export const MAX_LABELS_PER_CLAUSE = 3;

const NO_REPOS_LEAD = "No repositories were found in Folders to search.";
const READ_LEAD = "Couldn't read ";
const FIND_LEAD = "Couldn't find ";
/** The three ways a summary can BEGIN (spec §2.4.2 r9, user-directed 2026-10-03, Q2 = D): the no-repos
 *  sentence, then the first clause that applies — tcc-denied and unreadable both open with "Couldn't read",
 *  not-found with "Couldn't find". `discoverySummary` below builds every clause FROM these constants, so the
 *  list cannot drift from the builder, and test/discoverySummary.test.ts checks every kind combination.
 *  Readers that must tell the summary apart from other warnings use `isDiscoverySummary`, never a literal:
 *   - `src/render.ts` puts each summary on its OWN `⚠` line, after the joined line of every other warning;
 *   - `src/audit.ts` `coverageGaps` drops that line from its haystack (the LEGEND_PREFIX precedent): the
 *     summary names folders and "System Settings … (in the app: …)", so a repo labelled `settings` or
 *     `app` must not count as mentioned by it.
 *  No other warning source in `src/` begins with one of these (pinned by the same test file).
 *  ⚠ MIRRORED in gui/src/lib/briefing-struct.ts; gui/tests-web/briefing.check.ts deep-equals the two. */
export const DISCOVERY_SUMMARY_LEADS: readonly string[] = Object.freeze([NO_REPOS_LEAD, READ_LEAD, FIND_LEAD]);

/** True when a warning element is a discovery summary: it starts with one of `DISCOVERY_SUMMARY_LEADS`. */
export function isDiscoverySummary(w: string): boolean {
  return DISCOVERY_SUMMARY_LEADS.some((lead) => w.startsWith(lead));
}

/** Trailing separators of THIS platform. On POSIX only `/` separates: a backslash is an ordinary filename
 *  character, so a folder literally named `Desktop\` is a different folder from `Desktop` and must not be
 *  conflated with a configured root of that name. On Windows (`sep` is `\`) both `\` and `/` separate. */
const TRAILING_SEP = sep === "\\" ? /[\\/]+$/ : /\/+$/;

/** One spelling per folder, so `[~, ~/Desktop/]` and the walk of `~` reaching `~/Desktop` compare equal.
 *  Used for BOTH the dedupe and the configured-root test, so the two can never disagree about which entry
 *  survived (a dedupe that kept the walked spelling while the predicate looked for the configured one
 *  would silently un-block a denied search folder). */
function samePath(p: string): string {
  return p.length > 1 ? p.replace(TRAILING_SEP, "") || p.slice(0, 1) : p;
}

/** The discovery issues worth telling the user about, deduplicated by path, in first-seen order.
 *  - `tcc-denied` and `unreadable` at ANY depth: a folder we could not look inside may hold repos.
 *  - `not-found` ONLY for a configured search folder itself (a typo, a removed folder). A missing path
 *    met while walking is a race, not a setting the user can fix.
 *  - never `not-a-repo`, and never a path `excludeRepos` excludes (the check discovery applies to repos).
 *  Issues are not deduplicated upstream (only found repos are), so with search folders `~` and
 *  `~/Desktop` one denial arrives twice. */
export function countedIssues(
  issues: readonly PathIssue[],
  cfg: Pick<Config, "discoverRoots" | "excludeRepos">,
): PathIssue[] {
  const roots = new Set((cfg.discoverRoots ?? []).map(samePath));
  const seen = new Set<string>();
  const out: PathIssue[] = [];
  for (const issue of issues) {
    const key = samePath(issue.path);
    const counts = isInaccessible(issue) || (issue.kind === "not-found" && roots.has(key));
    if (!counts || isExcludedRepo(issue.path, cfg.excludeRepos) || seen.has(key)) continue;
    seen.add(key);
    out.push(issue);
  }
  return out;
}

/** The DISCOVERY-BLOCKED rule (spec §2.4.5, Q1 = B): discovery found no repos at all (after
 *  `excludeRepos`) AND a counted issue is for a configured search folder ITSELF. A folder merely reached
 *  while walking a root — `~/Desktop` under `~` — never blocks: blocking on it would recreate the
 *  permanent no-stamp loop that `blockedDelivery`'s comment in core.ts exists to prevent, for a user who
 *  never asked about that folder. `configuredRoots` is `cfg.discoverRoots` as expanded at config load,
 *  the same strings `discoverRepos` classifies roots under. */
export function discoveryBlocked(
  repos: readonly string[],
  counted: readonly PathIssue[],
  configuredRoots: readonly string[],
): boolean {
  if (repos.length > 0) return false;
  const roots = new Set(configuredRoots.map(samePath));
  return counted.some((i) => roots.has(samePath(i.path)));
}

/** `~` for a path under `home`, the path itself otherwise (the briefing stays on this machine). Control
 *  characters are stripped BEFORE the deny-list test, so the label is checked as it will be displayed —
 *  "working \ndirectory" must not slip past the test and then render as "working directory". The test is
 *  case-insensitive: a hidden folder name costs a "see briefing.log", a missed one costs a misread line.
 *  The path is put through `samePath` first, like `home`: a configured `~/Desktop/` is shown as `~/Desktop`,
 *  and `home` spelled with a trailing separator is shown as `~`, not `~/`. */
function label(raw: string, home: string): string {
  const path = samePath(raw);
  const h = samePath(home);
  const tilded = h.length > 1 && path === h ? "~"
    : h.length > 1 && path.startsWith(h + sep) ? `~${path.slice(h.length)}`
    : path;
  const shown = stripControl(tilded);
  const lower = shown.toLowerCase();
  return LABEL_DENYLIST.some((d) => lower.includes(d.toLowerCase())) ? HIDDEN_LABEL : shown;
}

function labelList(paths: readonly string[], home: string): string {
  const named = paths.slice(0, MAX_LABELS_PER_CLAUSE).map((p) => label(p, home));
  const more = paths.length - named.length;
  return `(${named.join(", ")}${more > 0 ? `, and ${more} more` : ""})`;
}

const folders = (n: number): string => `${n} folder${n === 1 ? "" : "s"}`;

/** ONE sentence group explaining the counted issues, or `undefined` when there are none. The wording is
 *  keyed on the issue's KIND, not the platform: macOS can produce `tcc-denied` and `unreadable` in the same
 *  run. It says "may be missing" because an empty window, or zero repos, cannot be attributed to a
 *  particular folder. It names System Settings as well as the app's screen, because CLI-only installs
 *  have no Schedule screen (`warnFor` already names System Settings). */
export function discoverySummary(
  counted: readonly PathIssue[],
  opts: { noRepos: boolean; home: string },
): string | undefined {
  const of = (kind: PathIssue["kind"]) => counted.filter((i) => i.kind === kind).map((i) => i.path);
  const clauses: string[] = [];
  const tcc = of("tcc-denied");
  if (tcc.length) {
    const it = tcc.length === 1 ? "it" : "them";
    clauses.push(`${READ_LEAD}${folders(tcc.length)} ${labelList(tcc, opts.home)} because macOS blocked access, so repos in ${it} may be missing. Allow access in System Settings → Privacy & Security → Files & Folders (in the app: Schedule → Folder access).`);
  }
  const unreadable = of("unreadable");
  if (unreadable.length) {
    const one = unreadable.length === 1;
    clauses.push(`${READ_LEAD}${folders(unreadable.length)} ${labelList(unreadable, opts.home)} — check ${one ? "its" : "their"} permissions — so repos in ${one ? "it" : "them"} may be missing.`);
  }
  const missing = of("not-found");
  if (missing.length) clauses.push(`${FIND_LEAD}${folders(missing.length)} listed in Folders to search ${labelList(missing, opts.home)}.`);
  // No clause, no summary — including for an issue of a kind `countedIssues` never keeps (`not-a-repo`):
  // an empty string, or the no-repos sentence alone, would be a warning that names no folder, and would
  // not begin with a clause lead. Every summary therefore starts with one of DISCOVERY_SUMMARY_LEADS.
  if (clauses.length === 0) return undefined;
  return [...(opts.noRepos ? [NO_REPOS_LEAD] : []), ...clauses].join(" ");
}
