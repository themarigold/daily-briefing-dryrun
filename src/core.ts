// src/core.ts — the pure pipeline core. runCore() computes the whole briefing (discover → extract →
// resolve units → today/mergedToday → reduce → net-gate → generate → working-tree-drift) and RETURNS
// a CoreResult (struct + raw model text + context + net/offlineSkipped flags), doing NO render/write/
// stamp I/O and making NO exit-code decisions. It is the SINGLE pipeline: production main.ts run() is
// a thin shell around it (gates → runCore → render/stamp/exit), and the eval harness scores the very
// same runCore, so there is no second copy to drift.
import { hostname, homedir } from "node:os";
import { discoverRepos, DEFAULT_BUDGET, DEFAULT_NETWORK_PROBE_HOSTS, repoLabel, resolveTranscripts, resolveAccounts, resolveVerdictPaths, resolveRecapCampaigns } from "./config";
import { shaPrefixMatch } from "./sha";
import { gitActivity, mapLimit, REPO_SCAN_CONCURRENCY, type RepoProbe } from "./extractor";
import { reduce } from "./reduce";
import { generateBriefing, norm, countPipelessRecapEvidence } from "./generator";
// The output-side DIAGNOSTICS, called near the foot of `runCore`. They live at this layer — not in
// `generateBriefing` — because the struct is not final until this file stops writing to it.
import { checkResumeFreshness, checkSuggestionRestatement, checkSuggestionVolume, type PostFinding } from "./postcheck";
import { diagError } from "./diag";
import { parseFloor } from "./schedule";
import { resolveAccount, effectiveAccounts, loadAccountState, recordLimit, recordAuthProbe, clearMark, parseResetInstant, outageReport } from "./account";
import { withRetry, withHardeningLadder, TIMEOUT_MS } from "./provider";
import { type HardenedProvider } from "./harden";
import { buildProvider, providerLabel } from "./providerFactory";
import { deriveProbeHosts } from "./providers/endpoint";

/** Read a provider's accumulated DYNAMIC warnings (C1/B8). Structural rather than an `instanceof` so an
 *  injected test double can carry them and a plain `Provider` is simply a no-op — the wire should work
 *  for any provider that offers them, not only the one this module happens to construct. */
function runtimeWarningsOf(p: Provider): readonly string[] {
  const rw = (p as Partial<HardenedProvider>).runtimeWarnings;
  return Array.isArray(rw) ? rw : [];
}

/** Append `extra` to `base`, skipping values already present. `base` is preserved EXACTLY, duplicates
 *  and order included: de-duplicating what was already there would be a silent behaviour change beyond
 *  this fix's scope. Only the additions are de-duplicated, because withRetry can raise the same probe
 *  anomaly on all three attempts and the operator should read it once. */
function appendUnique(base: readonly string[], extra: readonly string[]): string[] {
  const seen = new Set(base);
  const out = [...base];
  for (const w of extra) if (!seen.has(w)) { seen.add(w); out.push(w); }
  return out;
}
import { localDateStr, supportDir, readLastRunDate, recapCampaignsPath } from "./marker";
import { join } from "node:path";
import { appendFile } from "node:fs/promises";
// Tier B (Stage-2 recap campaigns). The phase module never imports this file (plan §2 / D17; pinned by
// test/recap-campaigns.imports.test.ts), so this edge cannot close a cycle.
import { runRecapCampaignsPhase } from "./recapCampaignsPhase";
import { branchWords, type RecapImpl } from "./recapCampaigns";
import { REDACTION } from "./transcripts/credentials";

/** A PR branch as a printed `🔀 Merged` line shows it: verbatim, unless `branchWords` — Stage 2's
 *  any-case, before-and-after-the-strip credential decision — redacts it, in which case all of it. */
const shownBranch = (branch: string): string => (branchWords(branch) === REDACTION ? REDACTION : branch);
import { claudeShaped } from "./harden";
import { scanTranscripts } from "./transcripts/scan";
import { whySourceFor } from "./transcripts/join";

/** §3.1's read-window margin — the plan chose 24 h: it covers "started last evening, committed this
 *  morning", while a wider window admits stale claimants. */
export const TRANSCRIPT_READ_MARGIN_MS = 24 * 3_600_000;
import { isInaccessible, warnFor, type PathIssue, type GuardOpts } from "./protectedPath";
import { countedIssues, discoveryBlocked, discoverySummary } from "./discoverySummary";
import { uncommittedFileList, isBranchNotable } from "./git";
import { ProviderError, type DoneItem, type Provider, type BriefingStruct, type Activity, type Config, type ReducedContext } from "./types";
import { resolveUnits, unitForCommit, unitForFiles, repoLabelFor, rootsForRepo, unitKey, subprojectLegend, INFRA_DENYLIST, labelBoundary, type Unit } from "./subprojects";
import { resolveProbeHosts, waitForNetwork, defaultNetProbe, realSleep } from "./net";
import { isFullyAwake } from "./power";

export type RunDeps = {
  provider?: Provider;   // default: hardenedProvider(cfg.provider, …) — which wraps a BYOCliProvider
  guard?: GuardOpts;     // §5.11 classification injection (tests)
  probe?: RepoProbe;     // repo-readability probe (tests)
  retryDelaysMs?: number[];              // transient-provider retry schedule (tests inject short ones)
  sleep?: (ms: number) => Promise<void>; // injectable for tests
  statusNow?: (repo: string) => Promise<string>; // render-time working-tree re-check (tests inject drift)
  netProbe?: () => Promise<boolean>;     // network-reachability probe (tests)
  /** Injected power probe (tests). Production uses `isFullyAwake`'s default `pmset` call. */
  powerProbe?: (args: string[]) => Promise<{ code: number; out: string }>;
  /**
   * Injected platform (tests). Production leaves it undefined so `isFullyAwake` reads
   * `process.platform`.
   *
   * ⚠ WITHOUT THIS THE DARKWAKE TESTS SILENTLY STOP TESTING ANYTHING OFF macOS, which is what
   * happened: `isFullyAwake` returns true immediately on non-darwin (fail-open, deliberate — see
   * power.ts), so on ubuntu CI the injected `powerProbe` was never consulted, the gate never
   * engaged, and `run() SKIPS a scheduled tick in darkwake` failed. CI was red on `main` from
   * `5c1a6fda` (2026-08-09) for 7 consecutive merges before anyone noticed, because the suite is
   * green on the author's macOS.
   */
  powerPlatform?: NodeJS.Platform;
  netGraceMs?: number;                   // network-gate bounds (tests inject short ones)
  netPollMs?: number;
  /** §3.2's ambiguity policy, threaded to the join. Declaring the field without threading it is the
   *  defect T3.3 made it injectable to avoid — MUT2 is the only detector that the drop is live. */
  onAmbiguity?: "drop" | "keep-earliest";
  /** Injected clock (`clockNow` below). It was introduced owning exactly TWO call sites — the scan's
   *  localDay bucketing and the read window's `now` end; outage computation, account selection and limit
   *  recording joined later (each noted where `clockNow` is hoisted), and tier B's PR-fact window
   *  `[windowStart, now)` is one more owned site (spec Appendix D14). It does NOT replace
   *  runDate/stateAsOf/extractor time, which are existing behaviour with existing tests; replacing those
   *  would change behaviour for every current user. */
  now?: () => Date;
  /** Injected transcript reader, so the scan is testable without a real corpus. */
  scan?: typeof import("./transcripts/scan").scanTranscripts;
  /** Injected health writer, so T4.9's ordering is assertable without touching the real state dir. */
  persistHealth?: (date: string, counters: import("./transcripts/scan").TranscriptRunCounters) => Promise<void>;
  /** Prior health history, so §3.8's multi-day triggers (zero-yield) are testable without a state dir. */
  priorHealth?: import("./transcripts/health").TranscriptHealth;
  preWarnings?: string[];                // shell-supplied warnings (e.g. floor.warning) folded in BEFORE the empty/blocked return, so they reach the struct exactly as production run() surfaced them
  /** Tier-B transport: the raw provider reply text for one prompt. Production wraps the run's own
   *  provider instance; tests and the offline replay inject canned text or a thrown ProviderError.
   *  It returns TEXT, never campaigns — validation and apply run on the engine side of this seam.
   *  (Spec §4.2.) Unset with an injected `provider` ⇒ B records `skipped`/`no-grouper`. */
  grouper?: (prompt: string) => Promise<string>;
  /** Tier-B record writer (spec §4.10 1; the `persistHealth` seam pattern). Unset ⇒ one line appended to
   *  `recapCampaignsPath()` in the state dir. `main.ts` never sets it. */
  persistRecapRecord?: (line: string) => Promise<void>;
  /** Spec Appendix D8: who invoked the run and whether it was `run --json`, copied into B's record.
   *  `main.ts` passes it; absent ⇒ `"invoker":"unknown"`, `json` defaults to `false`. */
  recapInvocation?: { invoker: string; json: boolean };
  /** Tests only, passed through to the phase as `seams`: a short `D_call` (F17/P9), a git budget
   *  (P10's 0), and the implementation seam (F20–F22). Production leaves all three unset. */
  recapCallDeadlineMs?: number;
  recapGitBudgetMs?: number;
  recapImpl?: Partial<RecapImpl>;
};

// The launchd 7:20 job coalesces to fire the moment a slept-through-7:20 laptop wakes — often
// seconds BEFORE wifi re-associates — and there is exactly one trigger per day. A transient
// provider failure (network-down nonzero exit, timeout) is therefore retried on a short bounded
// schedule instead of burning the morning. missing-binary is permanent and never retried.
export const PROVIDER_RETRY_DELAYS_MS = [45_000, 90_000];

// Render-time freshness re-check (audit 2026-07-10 #1): the briefing's uncommitted-files claims are
// captured at extraction, but generation takes seconds-to-minutes and repos change underneath (the
// vault auto-commits every ~10 min — this produced a briefing whose top two suggestions rested on
// files that were already committed). Re-read each claimed repo's working tree just before writing
// the briefing; any drift becomes an explicit warning rather than a silently-stale "fact".
/** CODE-RENDERED branch state for "Where you left off" (day-21 audit).
 *
 *  WHY DETERMINISTIC. On 2026-08-06 `personal_code` sat on `chore/sign-live-policy`; the briefing
 *  never said so, and framed the loose `policy.toml` edit as an item23 tail, advising the reader to
 *  commit it "tying it to that work". It was a signing chore. The branch name alone would have
 *  flipped that guidance from wrong to right — and the branch line DID reach the prompt, in the
 *  repo-level catch-all block, while the resume item was written against a sub-project unit. The
 *  model never made the join. A prompt instruction asks it to try again; this cannot be dropped.
 *
 *  SUPPRESSION — the predicate is "is there anything worth saying", NOT "is this the default
 *  branch". Suppressing every default-branch line would also suppress `main (ahead 12, behind 12)`,
 *  which is the exact day-16 B3 case the project ruled must always print its numbers. So:
 *    - detached HEAD              -> always (you are not on a branch; work can be lost)
 *    - a non-default branch       -> always (the day-21 case)
 *    - any divergence, or NO upstream -> always (B3: never a sync claim without the numbers, and
 *                                     "no upstream" is not parity — see git.ts)
 *    - default branch, in sync    -> nothing to say -> silent
 */
export function branchStateLines(
  activities: Activity[], repoPaths: string[],
): { repo: string; text: string }[] {
  const out: { repo: string; text: string }[] = [];
  for (const a of activities) {
    if (a.kind !== "branch" || !a.repo || !a.text) continue;
    if (!isBranchNotable(a)) continue;   // ONE predicate, shared with the prompt — see git.ts
    out.push({ repo: repoLabel(a.repo, repoPaths), text: a.text });
  }
  return out;
}

/** IN-10: a stash message that states its own HOLD or OWNERSHIP ("not mine", "parked for relay
 *  start", "keep for later", "Sam's WIP", "don't drop"). Read ONLY from the `<msg>` half of the
 *  user's own `On <branch>: <msg>` stash message — never the branch (a branch named `parked/x` says
 *  nothing about this stash), and never git's automatic `WIP on <branch>: <sha> <subject>`, whose text
 *  is the HEAD commit's subject and says nothing about the stash.
 *
 *  This is the generation prompt's own marker rule (generator.ts: SUGGESTIONS must not propose lifting
 *  a condition someone set deliberately) applied to the code-built channel. "Pop or drop" on someone
 *  else's parked work is that proposal, and the day-50 judge asked for the parked stash to stay in
 *  "Where you left off" only.
 *
 *  ⚠ THE COSTS ARE LOPSIDED, SO THE VOCABULARY LEANS TOWARD SUPPRESSION ON PURPOSE. A false match is
 *  silence — exactly the pre-IN-10 briefing, and the stash still renders on its RESUME line. A MISS is
 *  a daily "drop" nag about work the user said to leave, possibly someone else's. So the list is wide
 *  (keep, leave, hold, park, pause, later, until, backup, archive, skip, ignore, pending review, a
 *  possessive, do-not-X …), and a work message that uses a hold phrase literally ("blocked on the
 *  mutex fix", "held for the new API") is accepted as silence.
 *
 *  ⚠ …BUT IT MATCHES WHOLE WORDS, AND `-`, `_` AND `/` DO NOT END A WORD HERE. `\b` breaks on a
 *  hyphen, so `parked-car detector`, `not mine-sweeper` and `frozen until-loop refactor` read as holds
 *  — compound names, not statements. Hyphenated HOLD forms (`do-not-drop`, `dont-drop`) are spelled
 *  out inside the phrases instead.
 *
 *  MEASURED on review round 1's phrasings (43 ways of saying "leave this", 22 ordinary work messages):
 *  the first list held 6/43 and silenced 10/22; this one holds 42/43 and silences 6/22. The one hold
 *  phrasing left unmatched is "old attempt" — it calls the stash obsolete, which is what "drop"
 *  proposes. The six silenced work messages each use a hold phrase literally — the accepted
 *  direction. The archive's own two messages: `not mine, parked for relay start` matches;
 *  `pre-HEAD-fix: local STATE.md edits` does not. ⚠ Still NOT calibrated on real stash messages: the
 *  whole archive holds two. */
const STASH_WORD_START = "(?<![\\p{L}\\p{N}_/-])";
const STASH_WORD_END = "(?![\\p{L}\\p{N}_/-])";
const STASH_HOLD_PHRASES = [
  // ownership
  "not[\\s-]+(?:mine|yours|ours|my|for[\\s-]+me)",
  "(?:someone|somebody|anyone)[\\s-]+else['’]?s",
  "\\p{L}+['’]s[\\s-]+(?:changes|wip|work|edits|stash|stuff|patch|diff|code|copy|version|branch|experiment|review)",
  // keep / leave / hold / park / pause
  "keep(?![\\s-]+(?:going|trying|working|up|on|at)(?![\\p{L}\\p{N}_]))",
  "leave[\\s-]+(?:it|this|alone|as[\\s-]+is|be)",
  "hold(?:ing)?", "held[\\s-]+(?:for|until|till|back|off)", "on[\\s-]+(?:hold|ice)",
  "park(?:ed)?", "parking[\\s-]+(?:this|it|here)",
  "paus(?:e|ed|ing)", "postponed?",
  // deferred to a time or a condition
  "later", "some[\\s-]?day", "until", "till",
  "for[\\s-]+(?:now|tomorrow|next[\\s-]+(?:week|sprint|release)|(?:mon|tues|wednes|thurs|fri|satur|sun)day)",
  "(?:blocked|frozen|deferred)[\\s-]+(?:on|by|until|till|for|to|behind)",
  "wait(?:ing)?[\\s-]+(?:for|on|until|till)",
  "(?:needs?|pending|awaiting|await|for)[\\s-]+review",
  // kept as a copy, or not to be acted on
  "backup", "back[\\s-]+up", "bak", "bkp", "(?:reference|ref)[\\s-]+only", "for[\\s-]+reference", "archived?",
  "skip", "ignored?",
  // do not X
  "(?:do(?:[\\s-]+not|n['’]?t)|never)[\\s-]+(?:touch|pop|apply|drop|delete|remove|clear|lose|merge|commit|use)",
];
export const STASH_INTENT_RE = new RegExp(`${STASH_WORD_START}(?:${STASH_HOLD_PHRASES.join("|")})${STASH_WORD_END}`, "iu");

/** At most this many stash lines per briefing. The archive's measured need is one (a single unmarked
 *  stash across 33 days); the bound keeps a stash hoarder from burying the model's forward work. */
export const STASH_SUGGESTIONS_MAX = 1;

type StashSuggestion = BriefingStruct["suggestions"][number];

/** IN-10 — PERSISTING STASHES BECOME A SUGGESTION (EVAL days 47, 57, 58, 60, 63). The briefing named
 *  both stashes in "Where you left off" on 25 of 26 mornings since 08-22 and proposed an action on two;
 *  the judge filed the missing "apply or drop" line on days 51, 57, 63 and praised it on day 62. Returns
 *  the entries to APPEND — LAST, after the model's suggestions: stash housekeeping must not displace
 *  forward work. Code-built from the raw stash activities (git.ts `resumptionSignals`), so a budget
 *  trim cannot drop it — the reasoning `branchStateLines` gives above. `[]` when nothing qualifies, so
 *  a stash-free morning ships the pre-IN-10 struct.
 *
 *  A stash QUALIFIES when (a) its ref is `stash@{N}` (it can be named), (b) its own message carries no
 *  intent marker (`STASH_INTENT_RE`), and (c) no existing suggestion already names that ref for that
 *  repo — under ANY of the repo's lane labels, not only the catch-all's: an S1 promotion or a model
 *  line written under a sub-project bracket (`[parser] pop stash@{0}`) is the same stash (the model
 *  wrote the line itself on days 53 and 62). The ref match is exact (`stash@{N}`); prose that names a
 *  stash without its ref ("the pre-HEAD-fix stash") is not parsed. The OLDEST qualifier wins — the
 *  day-63 judge asked for age-weighting. NO AGE THRESHOLD: the archive holds no short-lived stash to
 *  calibrate one against, and the judge asked for this stash on its creation day (day 51, age 0) as
 *  well as at ages 6 and 12.
 *
 *  ⚠ THE TEXT IS FIXED AT `Pop or drop stash@{N}` AND THAT IS A MEASURED CONSTRAINT, NOT STYLE. `Pop`,
 *  not `Apply`: `git stash apply` KEEPS the stash, so after apply-and-commit the identical line would
 *  return the next morning. (EVAL rows 51 and 62 quote "needs pop/drop" and "keep-or-drop" — those are
 *  the BRIEFING's own RESUME lines quoted by the row, not the judge's wording.)
 *  The line is scored by `postcheck.checkSuggestionRestatement` like any
 *  suggestion — this channel adds NO skip there or anywhere else, so G6 and the delivery-path
 *  diagnostic see exactly what they saw before (an eval check's observed set is an eval-integrity
 *  decision; see the PENDING OPERATOR ACK on S1's skip). The text has THREE topical tokens (pop, drop,
 *  stash) for every ref below 100, so it can share at most 3 with any bullet, and the COUNTED
 *  `suggestion-restates` rule cannot fire on it. ⚠ That rests on `MIN_SHARED_TOKENS = 4` ALONE, not on
 *  the containment score: against a RESUME line that itself says "pop" and "drop" beside the stash the
 *  line scores 1.00 on 3 shared tokens — far above `RESTATEMENT_THRESHOLD` — and only the token floor
 *  holds it back (the first wording already scored 0.67 on 2 shared on 09-05, whose stash line EVAL
 *  day 51 quotes as "needs pop/drop"). Lower that floor to 3 and this line trips the counted rule.
 *  MEASURED for the first wording (`Apply or drop …`, the same three-token shape) by replaying this
 *  function over the real archive (32 real days plus the recovered day 61): the line lands on 10
 *  mornings, the archive's counted findings are unchanged (10 before, 10 after), and a text carrying
 *  the stash message would trip the counted rule on all 10. `Pop` cannot change the counted side —
 *  three tokens either way, and suggestions are scored one at a time. Pinned by
 *  test/in10-stash-suggestions.test.ts.
 *
 *  The stash's own message is USUALLY on the RESUME line above — but not always, so the line does not
 *  lean on it: the deterministic backfill lists only the first `STASH_NOTES_SHOWN` (2) stashes and then
 *  `+N more`, so an OLDEST stash at index ≥ 2 has no message anywhere on the page; and when the model
 *  writes its own RESUME bullet for the unit the backfill does not run at all. The ref and the age are
 *  what the reader needs to find it (`git stash list`).
 *
 *  ⚠ CALIBRATION CONSUMERS (repeated beside NEAR_MISS_FLOOR and S1's skip in postcheck.ts): it DOES log
 *  near-miss telemetry (`postcheck-info [suggestion-restates-near]`, info-only, uncounted) whenever a
 *  RESUME bullet shares one of its tokens. MEASURED for the shipped `Pop` wording (archive read in
 *  place, 33 days incl. the real day 61 recovered from briefing.log): 8 of the 13 near-miss rows over
 *  09-05..09-18 (61.5%). Two score ABOVE RESTATEMENT_THRESHOLD — 09-05 at 1.00 with 3 shared tokens and
 *  09-09 at 0.67 with 2 — and are held back only by MIN_SHARED_TOKENS = 4. Anyone building a threshold corpus from
 *  near-miss rows must filter suggestions matching `^Pop or drop stash@\{\d+\}$`: they are this
 *  code-built line, not model behaviour. Excluding them at the source was ruled out (operator ruling,
 *  IN-10 design approval): it would narrow what a counted diagnostic observes — the class of change
 *  S1's skip is still pending operator ack for.
 *  ⚠ S3 TOO: the entry carries `repo` (the catch-all label), which `checkSuggestionVolume` folds into
 *  the text — so the line counts as a forward step "mentioning" that unit and can silence an info-only
 *  `suggestion-volume-miss` row for it (measured by review round 1 on a constructed case; no row in
 *  briefing.log names the stash's repo, so no historical row moves). IN-4's SAME-DAY leg does NOT count
 *  it (nor S1 promotions): replayed over the archive, counting it would have silenced day 64's
 *  `personal_code` same-day row — see `checkSuggestionVolume`'s "WHICH LINES COUNT".
 *
 *  Age goes in `stash`, rendered as a label OUTSIDE the text (`render.ts stashLabel`), the way
 *  `(from resume)` is — so it never reaches the restatement score, and the text carries no hex run for
 *  IN-2's `markVerdictPathSuggestions` to read as a citation. `stash.branch` keeps git's literal, but
 *  the label shows only `no branch` — see `stashLabel` for why a branch name must not render. */
export function stashSuggestions(
  activities: readonly Activity[], repoPaths: string[], units: readonly Unit[],
  existing: readonly StashSuggestion[], runDate: string,
): StashSuggestion[] {
  const REF = /^stash@\{(\d+)\}$/;
  const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const candidates: { entry: StashSuggestion; when: number; n: number }[] = [];
  for (const a of activities) {
    if (a.kind !== "stash" || !a.repo || !a.target) continue;
    const m = REF.exec(a.target);
    if (!m) continue;                                                   // (a) unnameable
    // git.ts writes `${ref}: ${%gs}`; %gs is `On <branch>: <msg>` (stash push -m) or
    // `WIP on <branch>: <sha> <subject>` (plain stash). A branch name cannot contain ":" (git
    // check-ref-format), so the first ": " ends it.
    const gs = (a.text ?? "").startsWith(`${a.target}: `) ? (a.text ?? "").slice(a.target.length + 2) : "";
    const own = /^On (.+?): ([\s\S]*)$/.exec(gs);
    const wip = own ? null : /^WIP on (.+?): /.exec(gs);
    if (own && STASH_INTENT_RE.test(own[2]!)) continue;                  // (b) the user said hold
    const label = units.find((u) => u.repo === a.repo && u.root === null)?.label ?? repoLabelFor(a.repo, repoPaths);
    const text = `Pop or drop ${a.target}`;
    const lanes = [...new Set([label, ...units.filter((u) => u.repo === a.repo).map((u) => u.label)])].map((l) => labelBoundary(norm(l)));
    const named = existing.some((s) => s.text.toLowerCase().includes(a.target!.toLowerCase())
      && lanes.some((bounded) => bounded.test(norm(s.repo ? `[${s.repo}] ${s.text}` : s.text))));
    if (named) continue;                                                // (c) already on the list
    const when = Date.parse(a.timestamp ?? "");
    const days = Number.isFinite(when) ? Math.round((dayMs(runDate) - dayMs(localDateStr(new Date(when)))) / 86_400_000) : NaN;
    // A date AFTER the run date is clock skew: omit the age rather than claim "made today" beside a
    // RESUME line that prints the future date. (git.ts's `date || now` fallback for a stash with NO
    // date still reads as "made today" — that fallback feeds other consumers and is left alone.)
    const age = days >= 0 ? days : NaN;
    const branch = (own ?? wip)?.[1];
    candidates.push({
      entry: { text, repo: label, stash: { ...(branch !== undefined ? { branch } : {}), ...(Number.isFinite(age) ? { ageDays: age } : {}) } },
      when: Number.isFinite(when) ? when : Infinity, n: Number(m[1]),
    });
  }
  // Oldest first; on an equal date the deeper stack entry (larger N) is the older one.
  candidates.sort((x, y) => x.when - y.when || y.n - x.n);
  return candidates.slice(0, STASH_SUGGESTIONS_MAX).map((c) => c.entry);
}

/** One repo whose working tree changed between extraction and render. `resolved` is the files that
 *  WERE dirty and no longer are — the only ones that can make a suggestion stale. */
export type WorkingTreeDrift = { label: string; was: string; now: string; resolved: string[] };

// ⚠ EXACT-TOKEN membership against the ", "-joined string, NOT a re-split of it. Splitting is
// unfixable by choice of separator: `,` shattered "has,comma.md", and `", "` still shatters
// "x, y.md" — both desynchronise the two sides of the set-difference once `was` comes from the
// structured `meta.uncommittedFiles`, so a STILL-DIRTY file drops out and is reported resolved,
// marking LIVE work "already committed" (the direction this file's tests call worse than the bug
// being fixed). Anchoring each candidate at a delimiter boundary instead has no such failure mode:
// the separator is only ever consulted around a known filename, never used to guess where one ends.
const joinedListHas = (joined: string, f: string): boolean =>
  joined === f || joined.startsWith(`${f}, `) || joined.endsWith(`, ${f}`) || joined.includes(`, ${f}, `);
const fileList = (s: string) => s.split(", ").map((f) => f.trim()).filter(Boolean);
/** INFRA (agent-scratch) paths, dropped from a file list. See the denylist note in
 *  `computeWorkingTreeDrift` for why this gates the EMISSION and not only `resolved`. */
const dropInfra = (files: string[]) => files.filter((f) => !INFRA_DENYLIST.some((d) => f.includes(d)));
const hasInfra = (joined: string) => INFRA_DENYLIST.some((d) => joined.includes(d));

/** The measurement half of the drift re-check, split out so the warning text and the suggestion
 *  annotation are computed from ONE `statusNow` read per repo rather than two.
 *
 *  ⚠ BIDIRECTIONAL (day-20 finding, two sightings). This used to walk `uncommitted` — i.e. only the
 *  repos that were ALREADY DIRTY at extraction — so drift could only ever be observed in the
 *  dirty→clean direction. A repo that was CLEAN at extraction and picked up edits during generation
 *  was structurally invisible: the loop had no entry to iterate for it. That is the half of the
 *  window where "Where you left off" is most wrong, because the briefing asserts nothing is pending
 *  in a repo that now has pending work. Every CONFIGURED repo is re-read now, clean or not.
 *
 *  ⚠ CONCURRENTLY, with the extractor's own bound. The extraction scan already decided that per-repo
 *  git reads are independent and must not serialize (one repo on a hung network mount would otherwise
 *  hold the whole render behind it) — and this re-check runs at the very end of a run, after the
 *  model call, where a serial walk over every configured repo is the worst place to add wall time.
 *  `mapLimit`/`REPO_SCAN_CONCURRENCY` are imported rather than re-derived so the two scans cannot
 *  drift apart on the bound; `mapLimit` is order-preserving, so the emitted order is `repoPaths`
 *  order regardless of which repo's `git status` returns first.
 *
 *  The unverifiable-goes-silent branch is unchanged — a `statusNow` that throws still yields NOTHING
 *  for that repo rather than a guess, in both directions.
 *
 *  ⚠ THE TWO DIRECTIONS HAVE DIFFERENT AUDIENCES, and that asymmetry is deliberate (round-2 review).
 *    - clean→dirty: `contributing` only — the repos that actually produced briefing content. This
 *      direction makes no claim stale; it is pure advice to re-verify "Where you left off", which
 *      only means something for a repo the briefing said something about. Discovery walks two levels
 *      under each root, so `repoPaths` is routinely dozens of repos (vendored clones, scratch
 *      checkouts) the author-filtered briefing never mentions; warning about a build artefact
 *      landing in one of those is advice about work the reader was never shown — and each re-probe
 *      is a `git status` bounded only by GIT_TIMEOUT_MS, paid after the model call.
 *    - dirty→clean: EVERY repo dirty at extraction, contributing or not. Its files can annotate a
 *      suggestion (`resolved` → `annotateStaleSuggestions`), so this direction can invalidate a
 *      claim the briefing already made; narrowing it would drop a correction, not just an advisory.
 *
 *  ⚠ THE INFRA_DENYLIST GATES EMISSION AND RENDER, NOT JUST `resolved` (round-2 review). Both sides
 *  are filtered BEFORE the compare, and `was`/`now` are built from the filtered lists — so a repo
 *  whose only delta is an agent worktree appearing or vanishing emits nothing at all. Filtering only
 *  `resolved` (the shape this shipped as) left the decision to warn, and the printed paths, on the
 *  raw `git status` strings: `resolveUnits` (subprojects.ts) and `applySuggestionGuards` (generator.ts) strip INFRA paths before
 *  the prompt and before suggestions, so the model PROVABLY never saw one, and a warning built on
 *  one tells the reader their pending work changed on the strength of something they were never
 *  shown. Raw strings are kept verbatim when they carry no INFRA path, so the no-split invariant
 *  `joinedListHas` exists to protect is untouched on every real-world path. */
export async function computeWorkingTreeDrift(
  uncommitted: Activity[], repoPaths: string[],
  statusNow: (repo: string) => Promise<string> = uncommittedFileList,
  contributing: string[] = repoPaths,
): Promise<WorkingTreeDrift[]> {
  // Extraction-time dirty state, indexed by repo. A repo with NO entry here was clean at extraction:
  // `was` is "" — a real measurement, not a missing one, which is exactly why it can drift.
  const wasByRepo = new Map<string, Activity>();
  for (const a of uncommitted) {
    if (a.kind !== "uncommitted" || !a.repo) continue;
    if (!wasByRepo.has(a.repo)) wasByRepo.set(a.repo, a);   // first entry wins — one status read per repo
  }
  // `contributing` FIRST (it defines the scan set, and defaults to `repoPaths`), then any dirty repo
  // outside it — dropping those would turn this widening into a regression for the one-directional
  // case it is meant to preserve. Labels still disambiguate against the FULL `repoPaths`, so a
  // narrower scan cannot change how a repo is named.
  const targets = [...new Set([...contributing, ...wasByRepo.keys()])];

  const measured = await mapLimit(targets, REPO_SCAN_CONCURRENCY, async (repo): Promise<WorkingTreeDrift | null> => {
    const a = wasByRepo.get(repo);
    const wasRaw = (a?.text ?? "").replace(/^Uncommitted changes: /, "");
    const nowRaw = await statusNow(repo).catch(() => null);
    if (nowRaw === null) return null;             // unverifiable → stay silent

    // ⚠ Prefer the STRUCTURED list. `was` is recovered by regex-stripping rendered prose and then
    // re-splitting on ","; that was harmless while it only fed display text, but it now feeds a
    // MATCHING decision. A path containing a comma shatters into short tokens ("has,comma.md" →
    // ["has", "comma.md"]) and a 3-char token matches ordinary English prose, producing a false
    // "already committed" on an unrelated suggestion. `meta.uncommittedFiles` is the real array the
    // git layer already carries; the split stays only as a fallback for activities without it.
    // For a clean-at-extraction repo this is `[]`, so the clean→dirty direction contributes a
    // WARNING and nothing else: there is no prior claim for it to invalidate. An activity carrying
    // an EMPTY list is the same measurement as no activity at all — both are "nothing was pending",
    // and the two must stay indistinguishable downstream.
    const wasFiles = dropInfra(a?.meta?.uncommittedFiles ?? fileList(wasRaw));
    // ⚠ Split ONLY when there is something to strip. Re-splitting a `git status` join is the hazard
    // `joinedListHas` exists to avoid (a path containing ", " shatters), so the raw string is passed
    // through verbatim unless it actually carries an INFRA path — which is every real repo, every
    // day, except the one this filter is for.
    const was = hasInfra(wasRaw) ? wasFiles.join(", ") : wasRaw;
    const now = hasInfra(nowRaw) ? dropInfra(fileList(nowRaw)).join(", ") : nowRaw;
    if (now === was) return null;                 // unchanged once agent scratch is excluded → fine

    return {
      label: repoLabel(repo, repoPaths), was, now,
      // `wasFiles` is already INFRA-filtered, so nothing agent-scratch can reach an annotation:
      // any match against a resolved agent-scratch path would be coincidental by construction, and
      // annotating on it marks live work done.
      resolved: wasFiles.filter((f) => !joinedListHas(now, f)),
    };
  });
  return measured.filter((d): d is WorkingTreeDrift => d !== null);
}

export function driftWarnings(drifts: WorkingTreeDrift[]): string[] {
  return drifts.map((d) =>
    // ⚠ `was ""` would be the literal rendering for the clean→dirty direction, which reads as a bug
    // rather than as a measurement. Spelled out, symmetrically with the `now` side. Only the
    // dirty→clean branch is legacy text, and it is byte-identical to what it always was.
    `working-tree changed while generating: [${d.label}] ` +
    `${d.was === "" ? "was clean" : `was "${d.was}"`} → ` +
    `${d.now === "" ? "now clean (auto-committed?)" : `now "${d.now}"`} — re-verify "Where you left off" before acting`);
}

/** Propagate drift INTO the items it invalidates (day-20 audit). The footer warning alone left the
 *  briefing recommending work it had already detected was done: on 2026-08-04 the footer said the
 *  vault was "now clean (auto-committed?)" while suggestion #1 still said to commit those exact
 *  files. A reader acting top-down follows the stale instruction and never reaches the correction.
 *
 *  Matching is on the RESOLVED file paths only — files that were dirty and no longer are. A repo
 *  that merely changed (some files committed, others still dirty) annotates only the suggestions
 *  naming the committed ones. Matching is boundary-aware (see `mentionsPath`) — deliberately NOT the
 *  bare `includes` that `generator.ts`'s INFRA_DENYLIST filter uses; an earlier comment claimed the
 *  two mirrored each other, which stopped being true once boundaries landed. The model quotes paths
 *  from the data block, so full-path hits are the common case and a unique basename covers the rest.
 *
 *  ⚠ Deliberately ANNOTATES rather than DROPS. A suggestion can name a resolved file incidentally
 *  while still proposing real work, and this match is a substring test on model prose — not strong
 *  enough evidence to silently delete a recommendation. Being told "verify this first" costs the
 *  reader a moment; losing a genuine next step costs them the point of the briefing. */
// ⚠ "no longer in the working tree", NOT "committed". `resolved` means it left `git status` — which
// is equally true after a stash, a restore, a delete, a rename, or a .gitignore change, where the
// work is GONE rather than DONE. Asserting the cause would be a claim the evidence cannot support.
export const STALE_NOTE = " ⚠ no longer in the working tree (committed, stashed or reverted) — verify before acting";

/** Substring match with PATH BOUNDARIES on both sides. A bare `includes` produced three measured
 *  classes of false "already committed":
 *    - basename containment between DIFFERENT files — `core.ts` is a substring of `score.ts`
 *      (77 such basename pairs measured in this workspace alone);
 *    - cross-project basename collision — a resolved `daily_briefing_application/STATE.md` matching
 *      "update quant_stocks/STATE.md" (7 tracked `STATE.md` paths here);
 *    - untracked DIRECTORIES — git collapses them to `src/`, which then matched any file under it.
 *  Requiring a non-path character (or a string edge) on both sides kills all three while still
 *  matching the normal cases, where the model writes the name in prose, in quotes, or in backticks.
 *  A leading "/" counts as a path char, which is what makes the cross-project collision miss. */
const PATH_CHAR = /[A-Za-z0-9._/-]/;
/** ⚠ A "." only continues a path when a WORD CHARACTER follows it. Treating "." as a path character
 *  unconditionally — the first version of this — made a SENTENCE-FINAL period defeat the match:
 *  "Commit done.md." missed, while every other punctuation shape matched. That is the single most
 *  common way a suggestion ends, so the guard would have silently failed on the majority of real
 *  cases while all four boundary tests stayed green. `done.md.bak` must still miss, which is why the
 *  rule is "dot + word char", not "dot never counts". */
const continuesPath = (text: string, j: number): boolean => {
  const c = text[j];
  if (c === undefined) return false;                       // end of string is always a boundary
  // Lookahead mirrors PATH_CHAR's word members (adds _ and -), so `done.md._old` correctly
  // continues the path rather than matching `done.md`.
  if (c === ".") return /[A-Za-z0-9_-]/.test(text[j + 1] ?? "");
  return PATH_CHAR.test(c);
};
/** Exported for tests only — the empty-name hang guard is unreachable through
 *  `annotateStaleSuggestions` (its caller filters empty names out), so only a direct call can pin it. */
export function mentionsPath(text: string, name: string): boolean {
  // ⚠ NON-TERMINATION GUARD, and it must be LOCAL. `"abc".indexOf("", n)` CLAMPS to `text.length`
  // rather than returning -1, so an empty `name` makes the loop below spin forever — in an
  // unattended 07:20 launchd job that is a HANG, not a failed briefing. An empty name is reachable:
  // git renders an untracked directory as "sub/", whose basename is "". The caller filters those
  // out, but a guard thirteen lines away in another function is not a guard.
  if (!name) return false;
  for (let i = text.indexOf(name); i !== -1; i = text.indexOf(name, i + 1)) {
    const beforeOk = i === 0 || !PATH_CHAR.test(text[i - 1]!);
    if (beforeOk && !continuesPath(text, i + name.length)) return true;
  }
  return false;
}

export function annotateStaleSuggestions<T extends { text: string }>(
  suggestions: T[], drifts: WorkingTreeDrift[],
): T[] {
  const resolved = drifts.flatMap((d) => d.resolved);
  if (!resolved.length) return suggestions;
  // ⚠ `.filter(Boolean)` IS LOAD-BEARING, not defensive tidiness. `git status --porcelain` renders an
  // untracked DIRECTORY with a trailing slash ("?? sub/"), so its basename is the EMPTY STRING — and
  // `s.text.includes("")` is true for every string, which would annotate EVERY suggestion as already
  // committed. MEASURED: with the guard, an unrelated suggestion is untouched; without it, all of
  // them are marked. (`?? f` was dropped: `split` always returns at least one element, so `pop()`
  // never yields undefined — it was unreachable dead code masquerading as a guard.)
  // ⚠ FULL PATHS ONLY — the bare-basename fallback is GONE. Three independent reviews plus a fuzz
  // pass converged on it as the last false-positive shape: MEASURED 28 false positives across 1836
  // prose cases, every one of them "same leaf, different directory" (`quant_stocks/STATE.md`
  // resolved, "rewrite the STATE.md in daily_briefing_application" annotated). 36 duplicate
  // basenames across 757 tracked files here; `STATE.md` x7, `README.md` x11.
  //
  // Uniqueness-within-`resolved` was tried first and is INSUFFICIENT: with a single resolved
  // `quant_stocks/STATE.md` the leaf is trivially unique, so the bare `STATE.md` still matched — the
  // measured case above. Repo-scoping does not fix it either, because `personal_code` is ONE repo
  // holding every sub-project.
  //
  // The cost is false NEGATIVES when the model writes a bare leaf, and that is the correct trade:
  // this file's own tests call a false "already done" worse than the bug being fixed, because the
  // reader skips real work. The prompt prints repo-relative paths under a `UNIT <label>` banner
  // (`generator.ts`), so the common case is the model quoting the same form `resolved` holds.
  const names = [...new Set(resolved)].filter(Boolean);
  return suggestions.map((s) =>
    s.text.includes(STALE_NOTE) || !names.some((n) => mentionsPath(s.text, n))
      ? s
      : { ...s, text: s.text + STALE_NOTE });
}

/** What the verdict-path key reads as a commit citation: a run of 7–40 hex characters not glued to a
 *  letter or digit on either side — at least the 7-char abbreviation the prompt itself prints
 *  (`activityLine`, generator.ts), the same 7-char floor `eval/checks.ts`' `evidenceCandidates`
 *  extracts on. Shorter runs are ignored rather than tried: prose is full of 4–6-char hex-shaped words
 *  and numbers (`decade`, `e2e4`, `2026`), and this key must never mark a suggestion on a coincidental
 *  prefix. All-digit 7+ abbreviations ARE admitted (the `4760499` class `recapCoverage` and
 *  `clusterRecap` both had to learn about) — a run only counts once it resolves to exactly one real
 *  commit, below. Case-insensitive; `shaPrefixMatch` lower-cases both sides.
 *
 *  ⚠ A SCAN, NOT `sha.ts`' `evidenceTokens` + `bareToken`, which the first cut used (IN-2 cold review,
 *  lens 1 LOW-1). Those split on commas/whitespace and strip EDGE adornments only, so a citation joined
 *  to other text — `6645a53's`, `a/b`, `a..b`, `sha—`, `sha:path`, `x@sha`, `sha…` — was never read:
 *  5 of the 71 hex runs in the archived suggestions, one of them a real miss (day 57's "confirm
 *  6645a53's undated-flow rejection" cites an in-window `quant_stocks/live` commit). Widening those
 *  helpers instead would move `verifyEvidence`, `clusterRecap` and `recapCoverage` — EVAL-recorded
 *  paths — mid-batch, so they are untouched. What the helpers read is still read: their token is hex
 *  bounded by whitespace, commas, parens or edge adornments, none of them a letter or digit (the one
 *  exception, hex split by a parenthesis that the helpers glued back — `ab(12345678)` — is not a
 *  citation anyone writes). */
const CITED_SHA = /(?<![0-9a-z])[0-9a-f]{7,40}(?![0-9a-z])/gi;

/**
 * IN-2 (EVAL days 51/52) — stamp `verdictPath: true` on each suggestion that CITES a commit whose
 * diffstat touches an operator-configured verdict path. Pure; `prefixes` comes from
 * `resolveVerdictPaths`, so `[]` (the default — key unset) returns `suggestions` itself, untouched.
 *
 * ⚠ THE KEY IS GIT-DERIVED, NOT PROSE, and that was the whole design question. A suggestion is model
 * prose: its `[label]` is model-typed (IN-3's cold review, lens 1 MED-1, flagged a recap lane read
 * from exactly that bracket), its `repo` field on a promoted entry is copied from a model-typed RESUME
 * bracket, and the paths it names are free text. What CAN be checked against ground truth is a cited
 * SHA: a token either resolves to ONE real commit in this run's git activity or it does not, and a
 * resolved commit's diffstat is git's own record of what it touched. The model still chooses WHICH commit to cite — that is what
 * "the suggestion is about" means — but it cannot relabel, garble or invent its way to a marker: a
 * fabricated or ambiguous token resolves to nothing and marks nothing. MEASURED on the 15 archived
 * briefings of days 49-64 (37 suggestions; commits re-listed per day through `listCommits`, pooled up
 * to each briefing's date — a superset of the production window): 18 cite a 7+-hex token and all 18
 * resolve uniquely; 6 resolve to a commit under `quant_stocks/`/`quant_options/`, every one touching
 * ONLY those paths. Three of those six carry NO `[label]`, day 52's own example among them — the item
 * that cleared the evidence gate — so a label key would have missed the one case the feature exists
 * for, while its cited `0d741d9` marks it. RE-MEASURED with the `CITED_SHA` scan (IN-2 round 1; each
 * day's production window via `windowStart` plus that day's commits before its `state as of`): 7 of
 * 37 marked on days 49-64 — those six plus day 57's possessive `6645a53's` — and 10 of 68 across the
 * whole 33-briefing archive; no suggestion loses a token the first cut read.
 *
 * FAILURE MODES, stated rather than elided:
 *   - FALSE NEGATIVE, no citation: a suggestion about verdict-path work that cites no SHA stays
 *     unmarked. In the corpus that is the `(from resume)` promotions — verbatim resume tails that
 *     carry no SHA (two `[quant_stocks]` echoes on days 56 and 63, plus day 51's unlabelled "wiring
 *     that input into rule 2"). An unmarked suggestion is exactly today's rendering, so this errs
 *     toward the status quo, never toward a false claim.
 *   - FALSE NEGATIVE, unresolvable citation: a SHA outside this run's window + today (an older
 *     commit), an abbreviation shorter than 7, one ambiguous across the pool, or a run glued to a
 *     letter or digit (`g0d741d9`, git-describe's suffix) resolves to nothing.
 *   - OVER-MARKING, by construction: the key is a PATH, not a class of change. A suggestion to RUN the
 *     suite on a commit under `quant_stocks/` is marked exactly like one to wire a graduation gate,
 *     because both cite gate-path commits — on days 49-64, five of the seven marks ask to add a test
 *     or run something and confirm (days 56, 57, 62, 63, 64). So the marker text says only what the key
 *     established ("cites a commit on a configured verdict path"), never that the work is gate-class.
 *   - OVER-MARKING, mixed and bookkeeping commits: ANY file of the cited commit under a prefix marks
 *     it, so a cross-lane sweep touching one quant file marks a suggestion about another lane. None
 *     on days 49-64; on the whole archive, day 31's `20d5300` (per-lane `.vscode/settings.json` across
 *     three lanes plus `quant_stocks/STATE.md`, cited by a suggestion about editor setup) is one.
 *     Bookkeeping commits are the same class: the nightly autolog's status-sync commits touch
 *     `quant_stocks/STATE.md` (9 of 19 between 08-14 and 09-18), so a suggestion citing one is marked.
 *     NOT special-cased: the marker claims only that the cited commit touches the path, which is true
 *     of those too. Any-file rather than all-files because the guardrail is "anywhere under" the path,
 *     and a missed gate costs more than an extra flag.
 * Never removes, reorders or re-words a suggestion — the returned array is the input with at most a
 * field added. `renamedFrom` counts: a rename OUT of a verdict path touched it.
 */
export function markVerdictPathSuggestions<T extends { text: string; verdictPath?: true }>(
  suggestions: T[], commits: readonly Activity[], prefixes: readonly string[],
): T[] {
  if (!prefixes.length) return suggestions;
  const pool = commits.filter((a) => a.kind === "commit" && typeof a.event_id === "string");
  // CASE-INSENSITIVE (IN-2 cold review, lenses 1 and 3): git records a path's exact case, but on this
  // platform's default case-insensitive filesystem `Quant_Stocks/` and `quant_stocks/` ARE the same
  // directory, so a wrong-case entry was a marker that silently never fired. The price is an extra mark
  // where two directories differ only in case — the cheaper error, by the same asymmetry that makes
  // this rule any-file. `f === p` is kept: a configured FILE path, or a submodule's gitlink path.
  const lower = prefixes.map((p) => p.toLowerCase());
  const under = (f: string) => { const x = f.toLowerCase(); return lower.some((p) => x === p || x.startsWith(`${p}/`)); };
  const touches = (a: Activity) => (a.meta?.diffstat ?? [])
    .some((d) => under(d.file) || (d.renamedFrom !== undefined && under(d.renamedFrom)));
  return suggestions.map((s) => {
    const cited = [...s.text.matchAll(CITED_SHA)].map((m) => m[0]);
    const marked = cited.some((t) => {
      // EXACTLY one, the `recapCoverage` / `clusterRecap` uniqueness rule: an ambiguous prefix
      // "cannot tell", and a marker we cannot justify is one we do not render.
      const hits = pool.filter((a) => shaPrefixMatch(a.event_id!, t));
      return hits.length === 1 && touches(hits[0]!);
    });
    return marked ? { ...s, verdictPath: true as const } : s;
  });
}

export async function workingTreeDriftWarnings(
  uncommitted: Activity[], repoPaths: string[],
  statusNow: (repo: string) => Promise<string> = uncommittedFileList,
  contributing: string[] = repoPaths,
): Promise<string[]> {
  return driftWarnings(await computeWorkingTreeDrift(uncommitted, repoPaths, statusNow, contributing));
}

// A run must NOT stamp the day (retryable) — `CoreResult.blocked` — under either of TWO rules:
//  1. EXTRACTION-BLOCKED (this function): it produced nothing AND at least one repo we actually tried
//     to read was inaccessible — TCC- OR ordinary-perms-blocked. The emptiness may be caused by that
//     block, so consuming the day would silently drop that repo's work. A genuine quiet day (all repos
//     readable, just no activity) or a merely-absent (not-a-repo) path still stamps.
//  2. DISCOVERY-BLOCKED (`discoveryBlocked`, src/discoverySummary.ts — v0.2.1 §2.4.5): discovery found
//     NO repos at all AND a folder the user LISTED in Folders to search (`discoverRoots`, as expanded at
//     load) was itself denied, unreadable or missing. The user named that folder, so an empty day is a
//     delivery failure with a remedy, and not stamping is what lets the same day deliver once access is
//     granted (or the typo is fixed).
// NB: rule 1 is keyed on RESOLVED-repo issues and rule 2 on CONFIGURED roots only — never on a folder
// merely reached while walking a root (e.g. ~/Desktop under ~). That is what keeps an incidental
// blocked folder, for a user with genuinely no repos, from creating a permanent non-stamping loop: it is
// named in the quiet day's warning (`discoverySummary`) and the day still stamps.
export function blockedDelivery(activityCount: number, resolvedRepoIssues: PathIssue[]): boolean {
  return activityCount === 0 && resolvedRepoIssues.some(isInaccessible);
}

export type CoreResult = {
  emptyWindow: boolean; blocked: boolean;
  /** v0.2.1 §2.4.5: `blocked` came from the DISCOVERY rule (no repos found, and a configured search
   *  folder itself could not be read or was missing) — the shell words its stderr line for that case.
   *  False on every path that is not blocked by that rule, including an extraction-blocked run. */
  discoveryBlocked: boolean;
  /** v0.2.1 §2.4.2: the one-sentence explanation of the folders discovery could not read, set only when a
   *  counted issue exists, on exactly two paths:
   *   - the EARLY-RETURN path (empty window, extraction-blocked or discovery-blocked): it is ALSO in the
   *     pipeline `warnings` (so stderr prints it and a delivered quiet day shows it), and carried here so
   *     the shell can use it as the skip detail of a blocked run;
   *   - the PROVIDER path when the window has NO commits (r7 — every readable repo contributes a `branch`
   *     activity, so a found repo makes `emptyWindow` false and this is the common quiet day): it is in
   *     `struct.warnings` (the rendered ⚠ line, folded in with the late warnings) AND, since r8, at the
   *     end of the pipeline `warnings` (so stderr, briefing.log and the `run --json` envelope carry it).
   *  A window with commits never gets one: the folders stay in stderr/briefing.log only (§2.4.4). */
  discoverySummary?: string;
  /** Why a scheduled run declined to call the provider. "offline" = the net gate never came up;
   *  "darkwake" = the machine is in a maintenance wake where the provider call cannot complete even
   *  though a TCP probe succeeds. Distinct because the REMEDY differs and, on 2026-08-08, an
   *  undistinguished failure block was misdiagnosed twice. */
  skipReason?: "offline" | "darkwake" | "limited";
  /** Set whenever `skipReason === "limited"`. `until` is what the shell prints; `isProbe` says whether
   *  it is a PARSED reset or merely a probe deadline — the message may only say "resets at…" for the
   *  former, because a probe deadline is a one-hour guess the system explicitly does not trust. */
  /** `exhausted` says whether ANY account remains selectable after this tick's mark — it is the
   *  difference between "the fallback delivers in ten minutes" and "there is nothing left until the
   *  reset", and the shell states one or the other. It is COMPUTED (re-resolved against the state as
   *  written), never assumed: until 2026-08-24 the shell asserted "no other account is available" as a
   *  hardcoded literal, so the live failover test printed it while the fallback sat unmarked and ready. */
  limited?: { label: string; until: string; isProbe: boolean; exhausted: boolean };
  offlineSkipped: boolean;                       // scheduled run, still offline after the grace → provider NOT called; shell returns 0, no stamp
  net: { online: boolean; waitedMs: number } | null; // net-gate outcome; null when the gate wasn't reached (empty/blocked)
  struct: BriefingStruct; rawText: string;      // rawText = "" when emptyWindow (contract: model output only)
  promptText: string;                            // "" when emptyWindow
  ctx: ReducedContext; units: Unit[];
  activities: Activity[]; repos: string[];       // raw — shell needs neither now, but kept for drift/debug
  runDate: string;                               // localDateStr(new Date()) computed ONCE (no re-stamp drift)
  discIssues: PathIssue[]; extrIssues: PathIssue[];
  warnings: string[]; today: { repo: string; text: string }[];
  /** §4. Lives OUTSIDE ReducedContext and never reaches the prompt; carried so the eval harness and
   *  the `whys` projection can read it. Absent when the feature is off or degraded to git-only. */
  transcripts?: import("./transcripts/scan").TranscriptEvidence;
  /** The account label that actually produced this briefing, on the SUCCESS path. Set only when
   *  `provider.accounts` is configured: on a single-account machine there is no choice to record, and
   *  logging the synthesised "default" every morning would add a line to briefing.log for nothing.
   *  Exists because the 2026-08-24 live failover test had no way to prove which account had delivered
   *  except the mtime of a session directory under the fallback's config dir — incidental evidence
   *  that would not survive the next CLI change, for the one fact the whole feature turns on. */
  account?: string;
  /** The git window's start, carried onward for the eval harness (§3.1). */
  windowStartUtc: string;
  /** The SAME-DAY items rendered into the prompt's ALREADY DONE TODAY block, exactly as derived
   *  here — carried (not recomputed) for the eval harness's G7 `recency`. Same rationale as
   *  `transcripts` above: the harness must read what the model was shown, and a second derivation of
   *  the unit LABEL (unitForCommit + repoLabelFor) would be free to drift from this one. `[]` on a
   *  day with no same-day commits, which is what G7's no-op predicate gates on.
   *
   *  ⚠ OPTIONAL, and the reason is semantic rather than convenience: the three early-return paths
   *  (empty window, darkwake, offline) return BEFORE this is derived, and on those paths no prompt
   *  was ever built — so there is no "what the model was shown" to report. `undefined` says that;
   *  `[]` would falsely claim "the model was shown nothing today". G7 treats both as no-op. */
  todaySuppress?: DoneItem[];
};

/** The pure pipeline: cfg + injected deps → the computed briefing struct (+ raw model text/context).
 *  Does NO render/write/stamp I/O and makes NO exit-code decisions — run() (the shell) owns those. */
export async function runCore(cfg: Config, deps: RunDeps, force = false): Promise<CoreResult> {
  const { repos, issues: discIssues } = await discoverRepos(cfg, deps.guard);
  const { activities, warnings, issues: extrIssues, today: todayActs, mergedToday, windowMerges, windowStartUtc } =
    await gitActivity(cfg, repos, { ...deps.guard, probe: deps.probe });

  // Resolve sub-project units ONCE (Task 15): the window activity + today's commits are both
  // attributed against the same unit set, and any resolution warnings (unknown subprojects repo,
  // zero-glob roots, workspace-detection failure, ...) are merged into the run's warnings so they
  // surface on BOTH the normal briefing and the zero-activity early-return below.
  const { units, warnings: unitWarnings, rootsByRepo } = await resolveUnits(activities, todayActs, repos, cfg);

  // Merge attribution (T1.3): label a PR merge by the UNIQUE plurality unit of its first-parent
  // numstat files — the SAME rule commits use (unitForFiles is unitForCommit's extracted core), so
  // one PR's commits and its merge line finally carry one label instead of splitting the story
  // across `[unit]` and `[bare-repo]` tags (day-34: `#257 feat/tick-kill-switch` — pure
  // accountant_ai work filed under `[personal_code]`). Fallbacks preserve today's exact behaviour:
  // tie or no files (old git, degraded parse) → bare repo label; a unit resolveUnits never created
  // (merge-only activity under a root) → bare repo label rather than a label coverageGaps and the
  // whys projection have never seen.
  const mergeLabel = (m: { repo: string; files: string[] }): string => {
    const root = unitForFiles(m.files, rootsByRepo.get(m.repo) ?? rootsForRepo(units, m.repo));
    return units.find((u) => u.repo === m.repo && u.root === root)?.label ?? repoLabelFor(m.repo, repos);
  };
  warnings.push(...unitWarnings);
  warnings.push(...(deps.preWarnings ?? [])); // shell-supplied (e.g. floor.warning), BEFORE the empty return so it reaches the struct
  // Resolve the probe hosts ONCE, up front — so a malformed-networkProbeHosts warning lands in the
  // (possibly empty) struct exactly as production run() surfaced it, before the empty/blocked return.
  // A3/T9: the FALLBACK is derived from the API endpoint when the config names no hosts — probing the
  // endpoint the run will actually use catches DNS failure, a blocking proxy and a down gateway, none
  // of which anycast sees, and a LOOPBACK endpoint disables the gate so a user on a plane with a local
  // model does not wait 25s for two unreachable hosts before every briefing. `undefined` from the
  // derivation means "no opinion" (an unparseable endpoint), which keeps the anycast default rather
  // than silently disabling the gate on a typo. An explicit config value, `[]` included, still wins.
  const { hosts: probeHosts, warning: probeWarning } = resolveProbeHosts(
    cfg.networkProbeHosts,
    (cfg.provider.api !== undefined ? deriveProbeHosts(cfg.provider.api) : undefined) ?? DEFAULT_NETWORK_PROBE_HOSTS,
  );
  if (probeWarning) warnings.push(probeWarning);
  // §3.6 requires a malformed `transcripts` block to degrade "with a config-blaming warning" at the
  // consumer boundary. Found at C1 with no reader at all: config.ts produced this warning and nothing
  // consumed it, which is the same defect class as a DropReason with no writer.
  const tx = resolveTranscripts(cfg.transcripts, homedir());
  if (tx.warning) warnings.push(tx.warning);
  // IN-2: resolved up front for the same reason — a malformed `verdictPaths` warning must reach the
  // struct on every path, the empty-window one included, even though only the success path marks.
  const verdict = resolveVerdictPaths(cfg.verdictPaths);
  if (verdict.warning) warnings.push(verdict.warning);
  // Tier B (spec §4.8): the SECOND of `resolveRecapCampaigns`' two call sites (the first is `main.ts`'s
  // lock), on the same raw key, so the two cannot disagree. Resolved up front with the same reasoning as
  // `verdictPaths`: a malformed key's warning reaches the struct on every path, and B stays `off`.
  const recapCfg = resolveRecapCampaigns(cfg.recapCampaigns);
  if (recapCfg.warning) warnings.push(recapCfg.warning);
  // A4 — transcripts require a claude-shaped CLI, as PRODUCT SCOPE (transcript support is for Claude
  // Code users). The predicate is a filename check and cannot see a proxy; that residual is stated in
  // §3.4, not solved here. A silent no-op would be the worse failure: the user enabled a feature and
  // would never learn why nothing appeared.
  if (tx.enabled && !claudeShaped(cfg.provider.cli)) {
    warnings.push(`transcripts.enabled is set, but "${cfg.provider.cli}" is not a Claude Code CLI — transcript evidence is off for this run.`);
  }

  // (Wake-schedule drift removed with the pmset-wake mechanism — PR #81 replaced RTC-wake scheduling
  // with a StartInterval self-gating launchd agent, so there is no external repeat schedule to drift.)

  // Deterministic "today so far" (#1): commits made today (excluded from the window). Formatted here,
  // never sent to the LLM, so it can't be hallucinated — this rendered `today` list is the ONLY thing
  // shown to a human. Today's raw subjects are ALSO handed to the model as SHA-free suppress-only
  // context (todaySuppress, below) so it doesn't re-suggest work already done today, but only when the
  // window has real activity (buildDoneBlock no-ops on an empty body). Labeled by the RESOLVED unit's
  // label (not the bare repo label) so a same-day-only sub-project commit shows its sub-project, not
  // just its repo. Buckets against resolveUnits' REAL roots (rootsByRepo), not the survivor subset
  // (rootsForRepo), which can mis-attribute a commit for nested project roots (see subprojects.ts's
  // resolveUnits).
  const realTodayActs = todayActs.filter((a) => !a.meta?.excluded);
  const today = realTodayActs.map((a) => {
    const root = unitForCommit(a, rootsByRepo.get(a.repo ?? "") ?? rootsForRepo(units, a.repo ?? ""));
    const label = units.find((u) => u.repo === a.repo && u.root === root)?.label ?? repoLabelFor(a.repo ?? "", repos);
    return { repo: label, text: `${a.text ?? ""} (${(a.event_id ?? "").slice(0, 7)})`.trim() };
  });
  // Landed-PR events for today (audit 2026-07-16): merges are dropped from the recap as padding, but a
  // PR merging today is a real same-day event — without it the briefing mis-frames merged work as
  // "resume the review". Labeled by the merge's first-parent file plurality (mergeLabel above; bare
  // repo on tie/no-files) and, like the rest of "today so far", rendered deterministically and never
  // sent to the LLM.
  // ⚠ THE BRANCH IS SHOWN THROUGH STAGE 2's FAIL-CLOSED DECISION (`branchWords`, #567): a branch carrying
  // a known-shaped credential in ANY case renders as `[redacted]`. The case-sensitive pass the briefing
  // and envelope get downstream misses a lower-cased one (`fix/akia…`), which this line used to print
  // raw while the Stage-2 record of the same merge redacted it. Only the PRINTED lines change: the
  // prompt's suppress subject below keeps the raw branch, like every other raw subject sent there.
  for (const m of mergedToday) {
    today.push({ repo: mergeLabel(m), text: `🔀 Merged #${m.prNum} (${shownBranch(m.branch)}) (${(m.sha ?? "").slice(0, 7)})` });
  }
  // In-window PR landings (defect D — EVAL day 33, user-directed): same deterministic treatment,
  // rendered as dated lines at the foot of "What you did" (render.ts). Dated like recap bullets —
  // "(Aug 17)" — because "which morning did this land" is exactly the question the line answers.
  // Render-only: NOT added to todaySuppress (that list is same-day context by contract, and the
  // freshness postcheck keys on it — types.ts:149); the model stays blind to landings, which is the
  // stated residual of this fix, and the READER no longer is.
  const windowMergeLines = windowMerges.map((m) => {
    const d = new Date(m.timestamp ?? 0);
    const dateTag = isNaN(d.getTime()) ? "" : ` (${d.toLocaleDateString("en-US", { month: "short", day: "numeric" })})`;
    return { repo: mergeLabel(m), text: `🔀 Merged #${m.prNum} (${shownBranch(m.branch)})${dateTag}  (${(m.sha ?? "").slice(0, 7)})` };
  });

  // SHA-free suppress-context for the prompt (design 2026-07-19): raw subjects + a whenMs sort key so
  // buildPrompt can keep the newest 30. Never rendered, never in the struct. Commit dates from
  // Activity.timestamp; merge dates from MergedToday.timestamp. Empty subjects dropped.
  const todaySuppress: DoneItem[] = [];
  for (const a of realTodayActs) {
    const subject = (a.text ?? "").trim();
    if (!subject) continue;
    const root = unitForCommit(a, rootsByRepo.get(a.repo ?? "") ?? rootsForRepo(units, a.repo ?? ""));
    const label = units.find((u) => u.repo === a.repo && u.root === root)?.label ?? repoLabelFor(a.repo ?? "", repos);
    todaySuppress.push({ label, subject, whenMs: new Date(a.timestamp ?? 0).getTime() });
  }
  for (const m of mergedToday) {
    todaySuppress.push({ label: mergeLabel(m), subject: `Merged #${m.prNum} (${m.branch})`, whenMs: new Date(m.timestamp ?? 0).getTime() });
  }

  // Capture the run's date ONCE: the retry schedule can carry a run across midnight, and recomputing
  // at render/stamp time would date the briefing — and, worse, the day marker — as TOMORROW, silently
  // skipping the next scheduled run (final-review finding).
  const runDate = localDateStr(new Date());
  // When the working-tree ("resume") facts were captured — rendered on the resume header so a reader
  // hours later knows the claims' vintage (they're volatile; see workingTreeDriftWarnings).
  const stateAsOf = new Date().toTimeString().slice(0, 5);
  // Day-23: printed beside stateAsOf so on-time vs late is legible without inferring a cause.
  const fm = parseFloor(cfg.morningTime).minutes;
  const morningFloor = `${String(Math.floor(fm / 60)).padStart(2, "0")}:${String(fm % 60).padStart(2, "0")}`;
  // A provider-less BriefingStruct (empty-window / offline-skip): identical but for the provider label.
  // Hoisted here because both the outage computation below and account selection need it. `deps.now`'s
  // own docstring said it owned exactly two call sites; this is the third and fourth.
  const clockNow = deps.now ?? (() => new Date());

  // Computed BEFORE the provider call and applied to every struct this function can return: the
  // empty-window and blocked paths build their own structs and still get rendered and written, so a
  // recovery day that happens to be an empty-window day must still carry the line.
  const outage = outageReport(await readLastRunDate(), (await loadAccountState()).lastLimit, clockNow());
  const mkStruct = (provider: string): BriefingStruct => ({
    date: runDate, machineScope: hostname(), provider, resume: [], recap: [], suggestions: [], today, windowMerges: windowMergeLines, stateAsOf, morningFloor, warnings,
    ...(outage ? { outage } : {}),
  });

  // ctx is a pure, provider-independent transform of the activities; computed here so the CoreResult
  // always carries it (harmlessly {repos:[]} when there's no window activity).
  // `meta.excluded` commits (bot/auto-commit noise) are retained through `resolveUnits` so they can vote
  // for a root and mark window content — but they are invisible to EVERY other consumer. Filtering once,
  // here, covers `reduce` and therefore `knownShas`, `bucketActivities` and `buildPrompt` downstream.
  const realActivities = activities.filter((a) => !a.meta?.excluded);
  const ctx = reduce(realActivities, cfg.tokenBudget ?? DEFAULT_BUDGET);

  // A bot-commit-only day is an HONEST empty window: it must skip the provider, exactly as a silent day
  // does. Counting excluded commits here would call the provider with nothing real to say.
  const emptyWindow = realActivities.length === 0;
  // Empty run + an inaccessible repo we tried to read = delivery FAILURE, not a quiet day (§5.11):
  // the shell must NOT stamp and must exit non-zero so the next run retries once access is fixed.
  // BUT if there IS today's work (from readable repos), don't discard it — not blocked; the shell
  // renders it via the emptyWindow path (the block still shows as a warning).
  // v0.2.1 §2.4: the discovery issues worth naming (deduped; excludeRepos applied), and the second
  // blocked rule — see the comment above `blockedDelivery`. `repos` is discovery's own output, already
  // after `excludeRepos`; an explicit `repos` config yields no discovery issues, so neither can fire there.
  const counted = countedIssues(discIssues, cfg);
  const discBlocked = discoveryBlocked(repos, counted, cfg.discoverRoots ?? []);
  const blocked = (blockedDelivery(realActivities.length, extrIssues) && today.length === 0) || discBlocked;

  if (blocked || emptyWindow) {
    // Zero activity is an HONEST empty briefing enforced in code (§7): skip the provider entirely so a
    // quiet day can never be hallucinated. A day with only resumption signals (a half-done branch) is
    // NOT empty and still briefs.
    // v0.2.1 §2.4.2: name the folders discovery could not read — an otherwise-empty briefing is exactly
    // where a blocked folder can be the reason. (The provider path does the same for a window with no
    // commits; see `quietSummary` near the `late` warnings fold.) Pushed onto the shared `warnings`
    // (mkStruct below shares the array), so stderr prints it after the per-folder `warnFor` lines and a
    // delivered quiet day carries it on its ⚠ line; returned as well for the blocked run's skip detail.
    const summary = discoverySummary(counted, { noRepos: repos.length === 0, home: homedir() });
    if (summary !== undefined) warnings.push(summary);
    const empty = mkStruct("(no window activity)");
    return {
      emptyWindow, blocked, discoveryBlocked: discBlocked, offlineSkipped: false, net: null, struct: empty, rawText: "", promptText: "",
      ctx, units, activities, repos, runDate, discIssues, extrIssues, warnings, today, windowStartUtc,
      ...(summary !== undefined ? { discoverySummary: summary } : {}),
    };
  }

  // Hoisted above account selection, which needs it: `deps.now`'s own docstring says it owns exactly two
  // call sites, and account selection is the third — the sticky/revert behaviour is untestable without
  // an injectable clock.
  // ── Account selection ───────────────────────────────────────────────────────────────────────────
  // Resolved UNCONDITIONALLY, before the `deps.provider` ternary: the catch below records a limit
  // against "the label this run resolved", and an injected-provider path would otherwise have none.
  // (Recording itself is still gated on having built the provider — see the catch.)
  // Validated HERE, not in validateConfig: a malformed list disables failover with a warning the user
  // can see, rather than throwing (which would cost the briefing every tick) or silently stripping
  // (which would destroy the diagnostic). Same shape as resolveTranscripts above.
  // A3/T7(b): an API provider sits OUTSIDE the accounts ladder. An `accounts` entry is
  // `{label, configDir}` where configDir is literally a CLAUDE_CONFIG_DIR handed to a spawned child —
  // there is no HTTP analogue, and multi-key API failover is a different config shape and a different
  // slice. So the list is treated as ABSENT here, which makes `resolveAccount` return the single
  // implicit account. The user is told rather than left to wonder: `buildProvider` hands the ignored
  // list to the key ladder, which raises the "does not apply to an API provider" warning into the
  // provider's runtimeWarnings — the same channel every other provider-side warning uses.
  //
  // ⚠ ONLY the LADDER is skipped, not the limit machinery. A credit-exhausted API key still throws
  // `usage-limit`, still records against the implicit label, still takes the quiet `return 0` skip and
  // still produces the recovery outage line — that half is genuinely transport-agnostic and is the one
  // failure mode API users will actually hit.
  const acc = resolveAccounts(cfg.provider.api !== undefined ? undefined : cfg.provider.accounts, homedir());
  for (const w of acc.warnings) warnings.push(w);
  const accountState = await loadAccountState();
  const account = resolveAccount(acc.accounts, accountState, clockNow());

  // No usable account: every configured login is walled off (or the single implicit one is). Skip
  // WITHOUT constructing a provider or spawning anything — this is a known wall, not an error, so it
  // takes the same quiet `return 0` path the offline/darkwake skips take rather than the error path,
  // which would print a failure line every 600s for the length of the outage.
  if (!account) {
    // ⚠ label, until and isProbe must come from the SAME account. They did not until 2026-08-24:
    // `label` was read from `lastLimit` (whichever account most recently walled) while `until`/`isProbe`
    // were read from the FIRST account's mark unconditionally — so with a walled primary (resets in 3
    // days) and a later-walled fallback (resets in 9 hours) the shell printed the fallback's NAME beside
    // the primary's RESET, and in the mirror case printed an untrusted probe deadline as a parsed reset.
    // Same falsehood class as the hardcoded clause above, in the same sentence.
    const reportLabel = accountState.lastLimit?.label ?? effectiveAccounts(acc.accounts)[0]!.label;
    const walled = accountState.accounts[reportLabel];
    const skip = mkStruct("(skipped: limited)");
    return {
      emptyWindow: false, blocked: false, discoveryBlocked: false, offlineSkipped: true, skipReason: "limited",
      limited: {
        label: reportLabel,
        until: walled?.limitedUntil ?? "",
        isProbe: walled?.isProbe ?? true,
        exhausted: true,        // this branch IS "resolveAccount found nothing selectable"
      },
      net: null, struct: skip, rawText: "", promptText: "",
      ctx, units, activities, repos, runDate, discIssues, extrIssues, warnings, today, windowStartUtc,
    };
  }

  // Kept as a typed local so the B6 ladder and B8's warning merge can reach the wrapper's own members.
  // An injected `deps.provider` (tests, the eval) is a plain Provider and simply gets neither.
  // `CLAUDE_CONFIG_DIR` is passed as a PER-SPAWN env option and must never be written to process.env:
  // that variable also resolves the transcript scan root (config.ts resolveTranscripts), so exporting
  // it would silently point transcript discovery at the fallback's directory on exactly the days
  // failover engages, with claudeShaped still passing and nothing warning.
  // ⚠ A3/T7 — THE OVERLOADED LOCAL, SPLIT. Until this slice one local named `hardened` meant TWO
  // different things at once, and they were the same thing only because the CLI was the only transport:
  //
  //   "WE OWN THE TRANSPORT (it is not deps.provider)"  → gates limit recording, recordAuthProbe and
  //                                                       clearMark, i.e. every WRITE to live state.
  //   "WE HAVE LADDER MEMBERS"                          → gates withHardeningLadder.
  //
  // An API provider is OWNED but has NO LADDER, so the two meanings diverge and a single local must
  // answer one of the two questions wrongly. Both wrong answers are silent:
  //   • using the ladder meaning for the recording gates DROPS limit recording for every API run — an
  //     outage with no mark, no quiet skip and no recovery line;
  //   • using the ownership meaning for the ladder branch feeds `withHardeningLadder` a provider with
  //     no `hardeningActive`/`probeWithoutHardening`, which is a TypeError on the failure path.
  // Hence two explicit locals, each used for exactly one question. The comments at each of the four
  // sites below name WHICH question they are asking, because the old comments justified the conflated
  // form and would have read as approval of either meaning.
  const owned = deps.provider === undefined;
  const built = owned
    ? buildProvider(cfg.provider, {
        timeoutMs: cfg.provider.timeoutMs,          // #8: honor the config timeout knob (both transports)
        // CLAUDE_CONFIG_DIR selects a CLI LOGIN DIRECTORY. It is passed as a PER-SPAWN env option and
        // must never be written to process.env (it also resolves the transcript scan root). For an API
        // provider there is no spawn and no login directory, and `account` is the implicit one by
        // construction (see resolveAccounts above), so this branch cannot be reached with a configDir —
        // the guard is spelled out anyway so the invariant is local rather than three screens away.
        ...(cfg.provider.api === undefined && account.configDir !== undefined
          ? { env: { CLAUDE_CONFIG_DIR: account.configDir } }
          : {}),
      })
    : undefined;
  /** Ladder members, or undefined for an API provider AND for an injected one. Answers ONLY the
   *  "is there a hardening ladder to run" question. */
  const laddered: HardenedProvider | undefined = built?.laddered;
  const provider: Provider = deps.provider ?? built!.provider;
  const delays = deps.retryDelaysMs ?? PROVIDER_RETRY_DELAYS_MS;

  // Gate the provider call on real connectivity (bounded). A scheduled (non-forced) run still offline
  // after the grace SKIPS without calling the provider — the shell returns 0, does NOT stamp, and the
  // ~10-min interval loop retries; a forced run proceeds (its own retry schedule is the fallback). The
  // net OUTCOME is RETURNED (not printed here) so the shell (run()) owns all I/O. probeHosts was
  // resolved up front (above), so its malformed-config warning is already in `warnings`.
  // ⚠ DARKWAKE GATE, BEFORE the network gate — deliberately, because the network gate PASSES here.
  // `pmset` keeps TCPKeepAlive active through clamshell sleep, so the anycast TCP probe answers in
  // ~0s while the provider call cannot complete; on 2026-08-08 that cost three timeouts and a failure
  // block that was misdiagnosed twice. A scheduled run in a darkwake declines exactly as an offline
  // one does: no provider call, no stamp, retry next tick.
  //
  // A FORCED run is never gated — the user is present and asking, which is the same carve-out the
  // network gate makes.
  if (!force && !(await isFullyAwake(deps.powerPlatform, deps.powerProbe))) {
    const skip = mkStruct("(skipped: darkwake)");
    return {
      emptyWindow: false, blocked: false, discoveryBlocked: false, offlineSkipped: true, skipReason: "darkwake",
      net: null, struct: skip, rawText: "", promptText: "",
      ctx, units, activities, repos, runDate, discIssues, extrIssues, warnings, today, windowStartUtc,
    };
  }

  const net = await waitForNetwork(deps.netProbe ?? defaultNetProbe(probeHosts), deps.sleep ?? realSleep, deps.netGraceMs, deps.netPollMs);
  if (!net.online && !force) {
    // scheduled + offline: don't call the provider. struct is unused by the shell (it returns 0 on offlineSkipped).
    const skip = mkStruct("(skipped: offline)");
    return {
      emptyWindow: false, blocked: false, discoveryBlocked: false, offlineSkipped: true, skipReason: "offline", net, struct: skip, rawText: "", promptText: "",
      ctx, units, activities, repos, runDate, discIssues, extrIssues, warnings, today, windowStartUtc,
    };
  }

  // Capturing wrapper: record the EXACT prompt built by buildPrompt and the raw model output, so the
  // eval harness can score both without re-running the pipeline. On a retry the last attempt wins —
  // matching the struct withRetry returns. (deps.provider is the injected/BYO provider.)
  // ── T4.3: the transcript scan runs CONCURRENTLY with generation.
  //
  // Started here (after the net gate and after the emptyWindow/blocked returns), awaited after the
  // provider call. Overlapping it is the whole reason the reader yields: a synchronous multi-megabyte
  // parse would stall the very call it overlaps with.
  //
  // ⚠ The rejection is neutralised AT CREATION with `.catch`, not at the await. If the provider
  // throws — which it does, and runCore rethrows — the await is never reached, and an unhandled
  // rejection from an in-flight scan would crash the process on a path that is otherwise a clean
  // exit-1. Invariant 8: the transcript feature must never take the briefing down.
  const scanFn = deps.scan ?? scanTranscripts;
  const scanPromise: Promise<import("./transcripts/scan").ScanOutcome | null> =
    tx.enabled && claudeShaped(cfg.provider.cli)
      ? scanFn({
          root: tx.root,
          // §3.1: [gitWindowStart - margin, now]. The margin covers "started last evening, committed
          // this morning"; the plan chose 24 h.
          window: {
            startUtc: new Date(Date.parse(windowStartUtc) - TRANSCRIPT_READ_MARGIN_MS).toISOString(),
            endUtc: clockNow().toISOString(),
          },
          repos, cfg, activities, units, rootsByRepo,
          onAmbiguity: deps.onAmbiguity,
        }).catch(() => null)
      : Promise.resolve(null);

  let promptText = "", rawText = "";
  const capturing: Provider = {
    generate: async (prompt) => { promptText = prompt; const t = await provider.generate(prompt); rawText = t; return t; },
  };

  // withRetry / generateBriefing may throw ProviderError; it propagates out of runCore so the shell
  // (run()) can log it and return 1. reduce() ran OUTSIDE this so a reduce bug isn't masked as one.
  // Carry the pre-provider diagnostics OUT on the error so the shell's catch can still surface them —
  // pre-refactor run() printed the pipeline warnings AND the net-gate line BEFORE the provider call,
  // so a failure (especially a network-caused one) must not silently drop them. Attached to any Error
  // (a generic generate/parse crash gets them too); printing stays the shell's job.
  let struct: BriefingStruct;
  // ONE attempt, shared by withRetry and the C1/B6 ladder. The ladder's rungs must be single attempts:
  // re-running the whole retry schedule per rung would cost 9 provider calls and ~10 minutes rather than
  // the intended worst case of 5 calls.
  const attempt = () => generateBriefing(ctx, capturing, {
    // A3/T10: `providerLabel` returns `cfg.cli` VERBATIM for a CLI run — existing briefing headers are
    // byte-identical — and `<label> (<model>)` for an API run, because the model is the provenance fact
    // that changes briefing content and the header is where a reader would look for it.
    date: runDate, machineScope: hostname(), provider: providerLabel(cfg.provider), warnings, today, windowMerges: windowMergeLines, stateAsOf, morningFloor, todaySuppress,
  }, units, rootsByRepo);
  try {
    // The ladder wraps the withRetry CALL (C1/B6): it only acts once the schedule is exhausted, which is
    // what moves the "a network failure looks like a usage error" window from t~0.09s — peak
    // wake-before-wifi hazard — out to t~135s. A plain `Provider` (an injected test double) has no
    // ladder members, so it runs unwrapped.
    // LADDER question. `laddered`, not `owned`: an API provider is owned but has nothing to back off
    // from — no flags were injected, so "would it have worked without our flags?" has no meaning, and
    // the ladder's rungs would cost two extra HTTP calls per tick to answer it.
    struct = laddered
      ? await withHardeningLadder(laddered, () => withRetry(attempt, delays, deps.sleep), attempt, cfg.provider.timeoutMs)
      : await withRetry(attempt, delays, deps.sleep);
  } catch (e) {
    if (e instanceof Error) {
      // Fold in the provider's DYNAMIC warnings (C1/B8). This is the most valuable case for them:
      // "hardening was disabled, and then the call failed anyway" — without this the shell logs a bare
      // ProviderError and the operator never learns hardening was off.
      (e as ProviderError).warnings = appendUnique([...discIssues.map(warnFor), ...warnings], runtimeWarningsOf(provider));
      (e as ProviderError).net = net;
    }
    // A usage wall is a KNOWN, timed outage, not a failure: mark the account that hit it and exit by the
    // same quiet path as the offline/darkwake skips. This tick produces no briefing — the cost of
    // resolving the account before the call — and the next provider-calling tick selects the fallback.
    //
    // ⚠ OWNERSHIP question — `owned`, NOT `laddered`. Recording is gated on THIS run having built the
    // provider and resolved the account. An injected `deps.provider` means the caller supplied the
    // transport: the eval harness runs the real pipeline through runCore that way (src/eval/run-case.ts),
    // so recording here would let a developer's eval write a mark — and a reportable outage — into the
    // user's live state. Tests inject the same way.
    // ⚠ A3: gating this on `laddered` instead would silently DROP limit recording for every API run,
    // which is the exact failure the split exists to prevent — an API key that hits its wall would
    // produce a bare error line every 600s with no mark, no quiet skip and no recovery report.
    if (e instanceof ProviderError && e.code === "usage-limit" && owned) {
      const now = clockNow();
      // A3: prefer the STRUCTURED reset a transport supplies over text-matching an English CLI
      // sentence. `parseResetInstant` falls back to a one-hour PROBE mark when it cannot read one, so
      // an HTTP `retry-after` (or a spend-cap body naming its resume instant) would otherwise be
      // downgraded to a guess we already have the real answer for. The CLI path never sets `resetAt`,
      // so its behaviour here is byte-identical to before. A malformed value falls back rather than
      // producing an Invalid Date that would serialize as null into live state.
      const fromError = e.resetAt !== undefined && !Number.isNaN(Date.parse(e.resetAt))
        ? { until: new Date(e.resetAt), isProbe: false }
        : undefined;
      const reset = fromError ?? parseResetInstant(e.message, now);
      await recordLimit(account.label, reset.until, now, { isProbe: reset.isProbe });
      // Re-resolve against the state AS WRITTEN rather than reasoning about what the mark implies:
      // this is the only honest answer to "is anything left?", and the shell prints one of two
      // opposite sentences from it. Costs one extra state read, on the limited path only.
      const remaining = resolveAccount(acc.accounts, await loadAccountState(), now);
      const skip = mkStruct("(skipped: limited)");
      return {
        emptyWindow: false, blocked: false, discoveryBlocked: false, offlineSkipped: true, skipReason: "limited",
        limited: { label: account.label, until: reset.until.toISOString(), isProbe: reset.isProbe, exhausted: !remaining },
        net, struct: skip, rawText: "", promptText: "",
        ctx, units, activities, repos, runDate, discIssues, extrIssues, warnings, today, windowStartUtc,
      };
    }
    // §4a — a NON-limit failure on a FALLBACK account. The likeliest cause is a config dir that was
    // never logged into, and without this the ladder re-runs against that broken login every 600s for
    // the whole outage: ~135s of backoff plus a failure line per tick, strictly worse than the defect
    // this feature exists to fix. A one-hour probe mark backs off without benching it for the week.
    // Never applies to the first entry — see recordAuthProbe.
    // OWNERSHIP question again, and for the same reason: this WRITES a probe mark into live state.
    // Inert for an API provider in practice — `recordAuthProbe` never applies to the first entry and an
    // API run always has exactly the single implicit account — so the gate is about the injected-provider
    // case, which is the one that must never write.
    if (e instanceof ProviderError && owned) await recordAuthProbe(account.label, acc.accounts, clockNow());
    throw e;
  }
  // The SUCCESS struct comes from generateBriefing, not from mkStruct — so it needs the outage attached
  // here or the line renders on every path EXCEPT the one that actually delivers a briefing. Caught by
  // the end-to-end recovery test; the unit tests for the formula and the render slot both passed while
  // the two never met.
  if (outage) struct.outage = outage;

  // Success clears ONLY this account's mark — clearing broadly would erase a walled account's mark the
  // moment the fallback succeeds, so the next tick would retry the wall and stickiness would be gone.
  // OWNERSHIP question. A successful API run must clear its own mark, or a wall recorded yesterday
  // would keep benching the implicit label after the credit was topped up.
  if (owned) await clearMark(account.label);

  // Volatile-state re-check just before returning (see workingTreeDriftWarnings) — merged into the
  // struct's own warnings (surfaced in the rendered briefing), not the pipeline `warnings` the shell prints.
  // ⚠ THE clean→dirty SCAN SET IS NARROWER THAN `repos`, on two counts (round-2 review):
  //   - a repo classified INACCESSIBLE at discovery or extraction can contribute no trustworthy
  //     measurement — extraction already skipped it (`readable`, extractor.ts) — so re-probing it
  //     here only buys a fresh `git status` bounded by GIT_TIMEOUT_MS (30s) per repo, paid at the
  //     very end of the run, after the model call and immediately before the briefing is written;
  //   - a repo that produced NO briefing content has no "Where you left off" for the advisory to
  //     point at (see computeWorkingTreeDrift's header for why the two directions differ).
  // `units` is the resolved set that produced content. The dirty→clean direction is unaffected: it
  // keys off the uncommitted activities below, which is the wider audience it needs.
  const inaccessible = new Set([...discIssues, ...extrIssues].map((i) => i.path));
  const contributing = [...new Set(units.map((u) => u.repo))].filter((r) => !inaccessible.has(r));
  const drifts = await computeWorkingTreeDrift(
    activities.filter((a) => a.kind === "uncommitted"), repos, deps.statusNow, contributing);
  const drift = driftWarnings(drifts);
  // C1/B8: merge the provider's dynamic warnings here, EXPLICITLY. They are only known during
  // generate(), i.e. after the pipeline `warnings` list above was assembled — and pushing onto that
  // shared array would not work, because `generator.ts` passes it by reference but then REASSIGNS
  // `struct.warnings` whenever a cited SHA fails verification, detaching the alias. That reassignment
  // is conditional, so aliasing survives on some mornings and not others; relying on it would make a
  // warning appear or vanish depending on whether a SHA happened to fail that day.
  //
  // v0.2.1 §2.4.2 (r7): the discovery summary on the PROVIDER path, for a window with NO commits — the
  // approved rule is "the warning appears only on briefings with no commits in the window", and this is
  // the common such day: every readable repo contributes a `branch` resumption activity (git.ts
  // `resumptionSignals`), so a found repo makes `emptyWindow` false and the early return above never
  // runs. Folded in with `late` for the reason given just above — `struct.warnings` may no longer alias
  // the pipeline `warnings`, so pushing there would make the ⚠ line depend on SHA verification.
  // r8 (M1 checkpoint): it is ALSO pushed onto the pipeline `warnings`, AFTER the fold below, so stderr
  // (the shell's `r.warnings` loop, after every per-folder `warnFor` line), briefing.log and the
  // `run --json` envelope's `warnings` carry it on this quiet day exactly as on the early-return path.
  // The order is load-bearing: a non-empty `late` makes `appendUnique` return a FRESH array, so by the
  // time of the push `struct.warnings` no longer aliases `warnings` whatever the generator did, and the
  // push cannot move or duplicate the summary inside the rendered ⚠ line.
  // "No commits" = no `kind === "commit"` among `realActivities`: bot-excluded commits do not count (they
  // are invisible to every other consumer), and a MERGE-ONLY window counts as no commits — `listCommits`
  // drops every merge, so merges are never activities, and a merge-only briefing renders "(no commits in
  // the window)" with its 🔀 lines beneath, which is where this ⚠ line belongs. Not blocked by
  // construction: every blocked run took the early return. Same `counted` and `noRepos` as there.
  const quietSummary = realActivities.some((a) => a.kind === "commit")
    ? undefined
    : discoverySummary(counted, { noRepos: repos.length === 0, home: homedir() });
  const late = [...drift, ...runtimeWarningsOf(provider), ...(quietSummary !== undefined ? [quietSummary] : [])];
  if (late.length) struct.warnings = appendUnique(struct.warnings ?? [], late);
  if (quietSummary !== undefined) warnings.push(quietSummary);   // r8: after the fold — see above

  // ── T4.3: await the scan started before generation. ── T4.4: route EVERY degradation.
  const scanned = await scanPromise;
  let transcripts = scanned?.evidence;
  if (scanned) {
    // ⚠ Each trigger's SINK is non-negotiable (§3.8). Routing a degradation to telemetry alone is
    // precisely the silent decay this tier forbids — so every code below emits a `struct.warnings`
    // line as well as being counted. Rev 2 wrote only the parse-failure warning.
    const LOUD: Record<string, string> = {
      "cap-tripped": "transcript scan exceeded its time budget — all transcript evidence was discarded for this run (the briefing is git-only).",
      "self-test-mismatch": "transcript pipeline self-test FAILED — transcript evidence is off for this run (the briefing is git-only). This is a systematic failure, not a quiet day.",
      "parse-failure-rate": "transcript scan could not parse enough of the corpus to be trusted — all transcript evidence was discarded for this run (the briefing is git-only).",
      "subsystem-throw": "transcript scan failed — the briefing is git-only for this run.",
    };
    for (const code of scanned.degraded) if (LOUD[code]) struct.warnings = appendUnique(struct.warnings ?? [], [LOUD[code]!]);
    if (scanned.degraded.length) transcripts = undefined;   // git-only: never a partial evidence set
  }

  // ── T7.3: the `whys` PROJECTION. Runs here, in runCore, after generateBriefing and BEFORE
  // CoreResult is assembled — NOT in main.ts beside renderBriefing. The eval harness calls runCore
  // directly and builds CheckInput from the returned result, so a main.ts projection would leave
  // every G5 check running against a struct with no `whys`.
  //
  // `sources` is keyed by `unitKey` (injective); struct bullets carry a LABEL. The projection maps
  // one to the other through `units`, keyed by `norm(label)` because struct bullets hold RAW MODEL
  // TEXT — an exact lookup would silently miss `[**app**]`, `[App]`, `[app.]`.
  if (transcripts) {
    // ⚠ THE COLLISION TEST RANGES OVER ALL UNITS, not only those that produced a why.
    //
    // Scoping it to why-producing units is the obvious implementation and it leaves the defect wide
    // open: if unit A has a why and unit B shares `norm(label)` but has none, there is no collision
    // to detect — and the render join walks EVERY bullet's label, so A's quotation lands above B's
    // bullets. That is cross-repo mis-attribution, the class Q2 exists to forbid, and nothing
    // downstream catches it. `repoLabel` is NOT injective and the codebase has already been burned
    // by assuming otherwise (config.ts: "a collision deleted one repo's diagnosis entirely").
    const byNorm = new Map<string, number>();
    for (const u of units) byNorm.set(norm(u.label), (byNorm.get(norm(u.label)) ?? 0) + 1);
    // ⚠ Pre-mortem risk 5's writer. Counts the COLLIDING UNITS themselves, which is deliberately
    // wider than `drops["label-collision"]` (only collisions that cost a why). Without it, how often
    // the norm(label) keying decision bites at all stays unknown until 1.5b — i.e. until after the
    // gate that depends on knowing.
    transcripts.counters.labelCollisions += units.filter((u) => (byNorm.get(norm(u.label)) ?? 0) > 1).length;

    const whys: Record<string, string> = {};
    for (const u of units) {
      const key = norm(u.label);
      if ((byNorm.get(key) ?? 0) > 1) {
        // Fail-closed, identical in posture to §3.2's drop-on-ambiguity. Counted so 1.5b can measure
        // what the norm(label) keying decision costs — the dark launch's whole deliverable.
        // ⚠ Counts against the ADOPTED curve, not against conservative alone — otherwise a why that
        // only strict-majority resolved would be dropped by the collision guard and never counted,
        // under-reporting exactly what the norm(label) keying costs.
        if (whySourceFor(transcripts, unitKey(u.repo, u.root))) {
          transcripts.counters.drops["label-collision"]++;
        }
        continue;
      }
      const src = whySourceFor(transcripts, unitKey(u.repo, u.root));
      if (src) whys[key] = src.text;          // the BARE turn; the frame is render's job
    }
    if (Object.keys(whys).length) struct.whys = whys;
  }

  // ── T8.4a: G5 WIRING into the delivery path.
  //
  // ⚠ A `fail` becomes a DropReason plus a `struct.warnings` line and NEVER throws. G5 is a
  // correctness check on the why, not a release gate on the briefing — an exception here would let
  // the eval layer take down the morning briefing, which invariant 8 forbids outright.
  //
  // ⚠ Only G5 runs here, deliberately. Running the existing `CHECKS` array would put G1–G4 — which
  // are EVAL gates for gold cases — on every production run.
  if (transcripts && struct.whys && Object.keys(struct.whys).length > 0) {
    try {
      const { g5Whys } = await import("./eval/checks");
      const findings = g5Whys({
        caseName: "live", struct, rawText, promptText, ctx, units,
        emptyWindow: false, gitShaSet: new Set(), fileInventory: new Set(),
        shaToUnit: new Map(), commitMessages: new Map(), denylist: [],
        transcripts,
        // Only G5 runs here, so this is unread — but it is the REAL list rather than `[]`, because a
        // stub would become a lie the moment another check is added to this call.
        doneToday: todaySuppress,
      });
      const failed = findings.filter((f) => f.severity === "fail");
      if (failed.length) {
        // Drop every why rather than ship one G5 says is wrong. Fail-closed, matching the posture of
        // §3.2's ambiguity drop and §3.3's credential rule.
        // ⚠ COUNT THE WHYS WITHHELD, NOT THE FINDINGS. `failed.length` is the number of fail
        // FINDINGS, which is neither the number of whys deleted nor one-per-unit: `g5Whys` can fire
        // several rules for ONE label (verbatim + scope + why-attribution), and `surface` findings
        // are per-BULLET, not per-why. So one bad why among three recorded 3 drops, while one
        // finding that deleted three whys recorded 1. One drop per why withheld is the only reading
        // under which `drops` still answers its own question — "why did this unit not yield?" — once
        // for each unit that did not.
        // ⚠ It does NOT restore the join identity `unitsEligible == adopted + Σdrops` in telemetry,
        // and an earlier draft of this comment claimed it did. That identity is asserted against
        // `joinEvidence`'s OWN return value (transcripts-join.test.ts); `counters.drops` is a
        // separate accumulated record (scan.ts) that also carries per-line and per-path codes, and
        // `whysConservative`/`whysStrictMajority` are written from the join's map sizes and are
        // never decremented when this deletes the whys. No value here could hold that identity —
        // this is the honest per-unit count, not an invariant repair.
        // Captured BEFORE the delete, because after it there is nothing left to count.
        const whysWithheld = Object.keys(struct.whys ?? {}).length;
        delete struct.whys;
        // ⚠ The BUCKET is reused rather than invented: `DropReason` is a closed enumerated set
        // (scan.ts), and adding a member is an eval-integrity decision for the operator, not a
        // detail of this fix. `no-qualifying-turn` is the nearest honest existing code — the why was
        // produced but did not survive validation. Flagged in the review rather than changed here.
        transcripts.counters.drops["no-qualifying-turn"] += whysWithheld;
        struct.warnings = appendUnique(struct.warnings ?? [], [
          `transcript quotations failed a correctness check (${[...new Set(failed.map((f) => f.rule))].join(", ")}) and were withheld from this briefing. The briefing itself is unaffected.`,
        ]);
      }
    } catch { /* the eval layer must never break the briefing */ }
  }

  // Day-20 audit: the drift FOOTER is not enough on its own — propagate the drift into the
  // SUGGESTIONS it invalidates, or the briefing keeps recommending work it has already detected as
  // done.
  //
  // ⚠ POSITION IS LOAD-BEARING: AFTER the G5 block above, BEFORE render. Placed before G5 (where it
  // first landed) it SILENTLY DEFEATS the `surface` check: that check's first clause is
  // `whyValues.has(s.text)` — byte equality against the BARE anchored turn (`eval/checks.ts`) — so
  // appending STALE_NOTE makes a why that leaked into SUGGESTIONS stop matching. MEASURED: the same
  // struct yields 1 `surface` finding unannotated and 0 annotated. Clause 2 (`parseWhy`) does not
  // backstop it — a bare why carries no frame, so `parseWhy` returns null. Net effect was that a
  // leaked quotation naming a drift-resolved file shipped unchecked. T7.6-style ordering assertion
  // below pins this.
  struct.suggestions = annotateStaleSuggestions(struct.suggestions, drifts);

  // ── IN-10: PERSISTING STASHES → ONE CODE-BUILT SUGGESTION, APPENDED LAST (see `stashSuggestions`).
  // AFTER `annotateStaleSuggestions`, so the drift annotation can never append to the fixed text whose
  // token count keeps the counted restatement rule unable to fire; BEFORE the IN-2 marker and the
  // postcheck block, so both grade the list that ships. From the RAW activities, like `branchState`
  // below. No stash qualifying ⇒ nothing appended and the list is shaped exactly as before.
  const stashLines = stashSuggestions(activities, repos, units, struct.suggestions, runDate);
  if (stashLines.length) struct.suggestions = [...struct.suggestions, ...stashLines];

  // Day-21: branch state, CODE-RENDERED into "Where you left off". Computed from the raw activities
  // (not the reduced copies) so a budget trim can never drop it. Left ABSENT rather than set to an
  // empty array when no repo has anything worth saying — render treats both identically, and the
  // struct stays free of empty keys.
  const bs = branchStateLines(activities, repos);
  if (bs.length) struct.branchState = bs;

  // ── SUB-PROJECT LABEL LEGEND (judge days 41/43/44). Deterministic, code-built from `Unit.root` —
  // the ONLY place the label→parent-repo containment relation exists — and attached here, ABOVE the
  // postcheck block, per that block's "place any new struct writer above this" rule. Assigned only
  // when non-empty so a single-project install's struct is shaped exactly as before (render then
  // emits nothing and its briefing is byte-identical).
  const legend = subprojectLegend(units, repos);
  if (legend.length) struct.labelLegend = legend;

  // ── IN-2: VERDICT-PATH MARKER (EVAL days 51/52). A struct writer, so ABOVE the postcheck block per
  // its rule. AFTER `annotateStaleSuggestions`, the last writer of suggestion text, and after the IN-10
  // stash append (the last writer of the list), so the key reads the text that ships — a stash line is
  // hex-free by construction and never marks. Keyed on the RAW activities (window + today, bot commits excluded — the same
  // population the model's evidence could have come from), not the reduced ctx: a budget trim drops
  // diffstat detail, and the marker must not vanish on a heavy morning — the reasoning `branchState`
  // gives above. With `verdictPaths` unset, `verdict.paths` is `[]` and this returns the array
  // untouched — no field, no line, byte-identical.
  struct.suggestions = markVerdictPathSuggestions(struct.suggestions, [...realActivities, ...realTodayActs], verdict.paths);

  // ── TIER B (Stage-2 recap campaigns), spec §4.2: its ONE slot — after the last struct writer above the
  // postcheck block (the IN-2 marker just above), and therefore after the provider-warning fold
  // (`const late = [...drift, ...runtimeWarningsOf(provider)]`, further up), so `recap` and its `group`
  // stamps are final and nothing reads the provider's `runtimeWarnings` again: B's own call's warnings
  // go to its record, never onto the page, in any outcome. `off` is decided HERE (§4.1 step 1: B does
  // nothing at all — no gate, no git read, no call, no record, no stderr line); the phase is never called
  // with it. Never inside `generateBriefing` (the retried unit) and never through `capturing` (its
  // prompt/raw text are the main call's).
  if (recapCfg.mode !== "off") {
    const commitActs = ctx.repos.flatMap((r) => r.activities).filter((a) => a.kind === "commit");
    const res = await runRecapCampaignsPhase({
      mode: recapCfg.mode,
      struct,
      gateCommits: commitActs.length,
      // `clusterRecap`'s own population (generator.ts:929) — the commits Stage 1 resolved against.
      ctxCommits: commitActs.filter((a) => typeof a.event_id === "string"),
      unitLabels: units.map((u) => u.label),
      repoLabels: repos.map((r) => repoLabelFor(r, repos)),
      windowStart: new Date(windowStartUtc),
      clockNow,
      runDate,
      force,
      invocation: deps.recapInvocation,
      // The RESOLVED grouper (§4.1 step 2): production reuses the run's own provider instance — no second
      // construction; an injected `deps.provider` with no `deps.grouper` resolves to none.
      grouper: deps.grouper ?? (owned ? (p: string) => built!.provider.generate(p) : undefined),
      warningsOf: () => runtimeWarningsOf(provider),
      hardeningOf: () => (laddered ? (laddered.hardeningActive() ? "on" : "off") : "n/a"),
      timeoutMs: cfg.provider.timeoutMs ?? TIMEOUT_MS,
      persist: deps.persistRecapRecord ?? ((line: string) => appendFile(recapCampaignsPath(), line + "\n")),
      seams: { callDeadlineMs: deps.recapCallDeadlineMs, gitBudgetMs: deps.recapGitBudgetMs, impl: deps.recapImpl },
    });
    // Step 12, and the ONLY struct write B makes: `applied` (mode `on`, every check passed) returns the
    // candidate's `recap`; every other outcome returns nothing and the page is Stage 1's.
    if (res.recap) struct.recap = res.recap;
  }
  // ⚠ AFTER-SLOT INVARIANT (spec §4.2): no struct writer below this line may read `struct.recap`. The one
  // writer below — the transcript-health notices (`struct.warnings`, after the postcheck block) — reads
  // the health record, never `recap`, and adds the same line whether or not B applied, so every relation
  // live checks (a)–(f) certified still holds on the delivered page (pinned at delivery by [TB-P6]).

  // ── OUTPUT-SIDE CHECKS (postcheck). MOVED HERE from `generateBriefing` on 2026-08-11 — see the
  // tombstone there for the defect. This is the first point at which `struct` is genuinely final:
  // `annotateStaleSuggestions` (just above) and `struct.branchState` (immediately above) are both
  // writers that ran AFTER the generator returned, and both feed these checks.
  //
  // ⚠ PLACE ANY NEW `struct` WRITER ABOVE THIS BLOCK. Below it, the writer is ungraded and nothing
  // fails — which is exactly how the branch-state gap survived undetected until a live morning.
  //
  // ⚠ RESTATEMENT IS SCORED AGAINST THE RESUME SECTION AS DELIVERED — `branchState` FIRST, then the
  // model's bullets, which is render.ts's own order. Render puts branch-state lines inside
  // "Where you left off", so a reader cannot tell them from model prose, and a suggestion that
  // restates one is the same defect whichever half it echoes. Scoring only `struct.resume` is what
  // returned 0 findings on 2026-08-11 against a 1.000-containment restatement of the
  // `[personal_code]` branch line.
  //
  // ⚠ FRESHNESS IS DELIBERATELY *NOT* WIDENED THE SAME WAY, and the asymmetry is the point rather
  // than an oversight. `checkResumeFreshness` asks whether a bullet ANCHORED on a stale commit, and
  // it detects that by matching backtick-quoted commit subjects. Branch-state lines are
  // CODE-rendered (`On branch X (ahead N, behind M)`, git.ts) — they quote no subject, cannot
  // anchor, and can therefore only add pairs that are structurally incapable of firing. Passing
  // them would look symmetrical and buy nothing.
  //
  // DIAGNOSTIC ONLY (unchanged by the move): writes to stderr → briefing.log, never to
  // `struct.warnings`, so the DELIVERED briefing is byte-identical either way. Promoting either rule
  // to a counted defect remains an eval-integrity decision for the operator.
  //
  // ⚠ ONE SIDE EFFECT OF THE MOVE, and it is an improvement worth naming: `generateBriefing` is the
  // retried unit (`withRetry`), so the old site re-ran these checks on every provider attempt and a
  // retried morning logged each finding twice. Here they run exactly once, on the struct that ships.
  //
  // ⚠ WRAPPED, and not as defensive boilerplate — it is this file's own rule for anything
  // observational on the delivery path (the eval layer above is guarded the same way). A DIAGNOSTIC
  // that can abort the 07:20 briefing is strictly worse than one that misses a finding.
  //
  // ⚠ TWO `try`s, NOT ONE (IN-4 review round 1). The COUNTED checks (freshness, restatement) and the
  // INFO-ONLY S3 counter used to share one block, so a throw anywhere in S3 erased that morning's
  // COUNTED rows too — measured: counted 1 → 0 with an injected throw. An info-only diagnostic must
  // never be able to delete a counted one, so S3 now runs in its own block AFTER the counted rows are
  // printed. Output order is unchanged (counted checks first, S3 last, as before). ONE print template
  // for both blocks, so the `postcheck` / `postcheck-info` split cannot drift between them.
  // The converse also changed, and it is the one reading it moves: if the COUNTED block throws, the S3
  // info rows now still print (before, they were lost with it). That touches only row 34's aggregate
  // `grep -c "postcheck-info"` reading, and only on such a morning; `grep -c "postcheck \["` cannot move.
  const printPostFinding = (p: PostFinding) => diagError(`${p.info ? "postcheck-info" : "postcheck"} [${p.rule}]: ${p.detail}`);
  try {
    const post = [
      ...checkResumeFreshness(struct.resume, todaySuppress),
      ...checkSuggestionRestatement(struct.suggestions, [...(struct.branchState ?? []), ...struct.resume]),
    ];
    // `postcheck-info` for telemetry rows: the EVAL convention counts `grep -c "postcheck \["`, and
    // "postcheck-info [" does not match it — near-misses must never move a flag count (thresholds.ts).
    // ⚠ `diagError`, NOT `console.error`: every `detail` is built from the model's own suggestion and
    // resume text or from a git commit subject, and this line goes to stderr → briefing.log → the
    // desktop app's progress feed. It was the measured leak (2026-09-16) — the briefing was redacted
    // and its diagnostic was not. The `postcheck` / `postcheck-info` prefixes are OUTSIDE the untrusted
    // span and unchanged, so the EVAL convention's `grep -c "postcheck \["` count cannot move.
    for (const p of post) printPostFinding(p);
  } catch (e) {
    // The throw can carry the same text the details would have — an interpolated struct field lands in
    // `${e}` just as readily.
    diagError(`postcheck skipped (non-fatal): ${e}`); // never let a diagnostic cost a morning
  }
  try {
    const volume = [
      // S3 floor telemetry (INFO-only, never a finding — see checkSuggestionVolume). Reads the same
      // `units` SET the prompt was built from; `windowCommits` is the non-excluded in-window count,
      // absent ⇒ 0.
      //
      // ⚠ THE UNIT SET IS SHARED; THE COUNTS ARE NOT WHAT THE MODEL SAW. These counts come from
      // `resolveUnits`, i.e. the FULL activity list, while the prompt is built from the post-`reduce`
      // ctx — and `reduce` drops activity detail at stage 2 and whole repos at stage 3 under budget
      // pressure (reduce.ts). So on a trimmed morning this diagnostic can name a unit whose commits
      // the model was never shown, and "the model ignored the floor" is then the wrong reading. One
      // more reason it is INFO-only telemetry to accumulate rather than an accusation to act on.
      //
      // IN-4: the THIRD argument is the SAME-DAY leg's input — `todayCommits`, the non-excluded commits
      // "Today so far" renders, counted per unit in `resolveUnits` (git-derived). The model is still fed
      // same-day subjects only as suppress-context (`todaySuppress`, above), and this leg exists to
      // measure exactly that; it reads the counts and changes nothing the model sees.
      ...checkSuggestionVolume(struct.suggestions, units.map((u) => ({ label: u.label, commits: u.windowCommits ?? 0 })),
        units.map((u) => ({ label: u.label, commits: u.todayCommits ?? 0 }))),
    ];
    for (const p of volume) printPostFinding(p);    // every row info:true BY TYPE (PostFinding)
  } catch (e) {
    // Same wording as the counted block's, so a reader grepping "postcheck skipped" finds both; it
    // matches neither `postcheck [` nor `postcheck-info`, so no EVAL count moves on a throw.
    diagError(`postcheck skipped (non-fatal, S3 volume counter): ${e}`);
  }
  // ── RECAP format-drift telemetry (2026-09-22, review round 1 L4). `parseBriefing` now recovers a
  // bullet whose model dropped the prompt's `| evidence:` pipe, so the eval's G1 `evidence`/`coverage`
  // checks no longer fail on that drift — scoring unchanged, only its input. This ONE line per briefing
  // keeps the drift visible: stderr → briefing.log only (same sink as the postcheck rows, never
  // `struct.warnings`, so the delivered page is byte-identical). Prefix `parse-info`, deliberately
  // neither `postcheck [` (the EVAL count) nor `postcheck-info` (row 34's aggregate reading), so no
  // EVAL grep moves. Counted from `rawText` — the final attempt's model output, the text the shipped
  // struct was parsed from — so a retried morning logs once. Own `try`: it can never cost a morning.
  try {
    const drift = countPipelessRecapEvidence(rawText);
    if (drift.recovered) diagError(`parse-info [recap-evidence-pipeless]: ${drift.recovered} of ${drift.total} recap bullet(s) cited evidence without the prompt's "| evidence:" pipe; recovered by the trailing-form fallback`);
  } catch (e) {
    diagError(`parse-info skipped (non-fatal, recap evidence drift): ${e}`);
  }

  // ── T4.9: the health-JSON WRITE call site.
  //
  // ⚠ IT MUST RUN AFTER THE `whys` PROJECTION, because §4 makes that projection a SECOND writer to
  // `counters.drops` (`label-collision`). A write placed naturally where the scan completes would
  // silently lose every collision count — the one counter the dark launch exists to produce. The
  // projection is T7.3 (M7); this call site is deliberately positioned after where it will land, and
  // T7.6 is the paired assertion that the ordering holds.
  //
  // ⚠ RULE 1: only a run that ACTUALLY EXECUTED THE SCAN writes a day record. Most runs return before
  // the insertion point (empty window, blocked, offline); a non-scanning run stamping a record whose
  // derived sets are all zero would zero the day under last-run-wins and fire the zero-yield trigger
  // every single day.
  // ⚠ RULE 1 keys on "did the scan actually RUN", NOT on "is there usable evidence". A cap-tripped or
  // throwing run DID scan, and its counters — `capTripped`, `filesScanned`, the parse-failure rate —
  // are precisely what diagnose the degradation. Keying on `transcripts` instead made every
  // degradation invisible in telemetry (found at C4). Runs that returned before the scan (empty
  // window, blocked, offline, feature off) still write nothing, which is what RULE 1 protects.
  if (scanned) {
    // ⚠ §3.8's TRIGGERS are evaluated HERE, against the MERGED history — not against this run alone.
    // The zero-yield trigger fires after N=3 consecutive QUALIFYING days (days where sessions were
    // found) that produced no why, which is the signal that the allowlist or the discriminator has
    // silently decayed. It cannot be evaluated from one run's counters, which is why it lives at the
    // persist step where the history is in hand.
    //
    // ⚠ Each trigger's SINK is non-negotiable: routing these to telemetry alone is precisely the
    // silent degradation §3.8 forbids, so every fired code also emits a struct.warnings line.
    const { fired, health } = await evaluateHealthTriggers(runDate, scanned.evidence.counters, deps);
    // ⚠ The zero-yield notice is BUILT FROM THE HEALTH RECORD, not a fixed string. The fixed string
    // asserted "allowlist or discriminator decay" and both hypotheses were refuted by the very
    // telemetry the trigger reads (day 21). See `zeroYieldNotice`.
    const { zeroYieldEvidence, zeroYieldNotice } = await import("./transcripts/health");
    const TRIGGER_NOTICE: Record<string, string> = {
      "zero-yield": zeroYieldNotice(zeroYieldEvidence(health)),
      "parse-failure-rate": "transcript parse-failure rate is above threshold — treat this run's transcript telemetry as unreliable.",
      "cap-tripped": "transcript scan hit its time cap — evidence was discarded for this run.",
    };
    for (const code of fired) {
      if (TRIGGER_NOTICE[code]) struct.warnings = appendUnique(struct.warnings ?? [], [TRIGGER_NOTICE[code]!]);
    }
  }

  return {
    emptyWindow: false, blocked: false, discoveryBlocked: false, offlineSkipped: false, net, struct, rawText, promptText,
    ctx, units, activities, repos, runDate, discIssues, extrIssues, warnings, today, windowStartUtc,
    transcripts,
    // Provenance, only when there was a real choice to make — see CoreResult.account.
    // `?.length` not a truthy test: `resolveAccounts([])` returns an ACCEPTED empty array (no warning),
    // and `effectiveAccounts([])` synthesises "default" — so a truthy test logs `account "default"`
    // every morning for a user who emptied the list to turn the feature off.
    // OWNERSHIP question, for the same reason recordLimit/clearMark/recordAuthProbe are: an injected
    // `deps.provider` means the resolved label never reached a spawn, so attributing the output to it
    // would be a claim about a process that never ran. The eval harness calls runCore exactly that way.
    // ⚠ A3: `acc.accounts` is forced to undefined for an API provider (see resolveAccounts above), so
    // this stays absent on an API run — which is correct, because there was no account CHOICE to record.
    ...(owned && acc.accounts?.length ? { account: account.label } : {}),
    // Purely ADDITIVE, for the eval harness's G7 (`recency`). Exposing the list rather than letting
    // the harness rebuild it from `today` is deliberate: `todaySuppress` carries the resolved unit
    // LABEL (unitForCommit + repoLabelFor) and the merge-derived entries, and a second derivation of
    // that would be free to drift from this one — the defect fixed in #177. Existing destructurers
    // are unaffected.
    todaySuppress,
    // v0.2.1 §2.4.2 (r7): the same value folded into `struct.warnings` above, so a caller reads the
    // summary from one field whichever path produced it.
    ...(quietSummary !== undefined ? { discoverySummary: quietSummary } : {}),
  };
}

// ⚠ A module-level `persistHealth` USED TO SIT HERE and was deleted on 2026-08-11. It had NO
// caller — `evaluateHealthTriggers` below inlines the same read-merge-write — so it was a second
// copy of the telemetry write path that nothing exercised, and the two had already drifted (only
// the live one guards its `Bun.write` with `.catch`). Kept as a tombstone rather than silently
// removed because "persist" and "evaluate" read like separate steps a caller might want: they are
// deliberately ONE, since the triggers are defined over the merged history, not over a single run.
// Do not reintroduce a standalone writer; extend `evaluateHealthTriggers` instead.

/** Merge this run into the day record, then evaluate §3.8's triggers over the RESULT. Returns the
 *  fired codes so the caller can emit each one's warning. Persisting and evaluating are one step
 *  because the triggers are defined over the merged history, not over a single run. */
async function evaluateHealthTriggers(
  date: string, counters: import("./transcripts/scan").TranscriptRunCounters, deps: RunDeps,
): Promise<{ fired: string[]; health: import("./transcripts/health").TranscriptHealth }> {
  const { mergeRun, emptyHealth, serialiseHealth, evaluateTriggers } = await import("./transcripts/health");
  if (deps.persistHealth) {
    // Injected writer (tests): still evaluate, against this run merged onto `deps.priorHealth` when
    // one is supplied and an empty history otherwise — `priorHealth` exists precisely so a test can
    // seed history (see RunDeps). Said "an empty history" unconditionally until 2026-08-11.
    await deps.persistHealth(date, counters).catch(() => {});
    const merged = mergeRun(deps.priorHealth ?? emptyHealth(), date, counters);
    return { fired: evaluateTriggers(merged, merged.days.find((d) => d.date === date)), health: merged };
  }
  const path = join(supportDir(), "transcript-health.json");
  let prior = emptyHealth();
  try {
    const f = Bun.file(path);
    if (await f.exists()) prior = { ...emptyHealth(), ...(await f.json()) };
  } catch { /* a corrupt record is replaced, not fatal */ }
  const merged = mergeRun(prior, date, counters);
  await Bun.write(path, serialiseHealth(merged)).catch(() => {});
  return { fired: evaluateTriggers(merged, merged.days.find((d) => d.date === date)), health: merged };
}
