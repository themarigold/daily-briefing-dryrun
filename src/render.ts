// src/render.ts
import type { BriefingStruct } from "./types";
import { norm } from "./generator";
import { LEGEND_PREFIX, NOT_SHOWN_PREFIX, VERDICT_MARKER_PREFIX } from "./subprojects";
import { renderWhy } from "./transcripts/frame";

/** The VERDICT-PATH MARKER's body (IN-2), rendered after `VERDICT_MARKER_PREFIX` under a suggestion
 *  whose `verdictPath` is set. A FIXED sentence, deliberately — no matched path, no SHA, no label:
 *    - it states only what the code established (the suggestion cites a commit on a configured
 *      path), not what the work IS — the key cannot tell a graduation-gate change from a test run
 *      under the same folder, so the line must not claim to;
 *    - it carries no hex run, no parenthesis and no `evidence:`, so `extractCitedShas`,
 *      `missingSameDay` and the same-day/fabrication flags read the same text with it or without it
 *      (`coverageGaps` is the one text reader it could reach, and that one excludes it by prefix).
 *  ⚠ IT ONCE ENDED "— gate-class work, not routine next work", and that clause broke the first rule
 *  above (IN-2 cold review, lens 1 MED-1): of the 6 suggestions the first cut marked on days
 *  49-64, four ask to ADD a test or RUN the suite (days 56, 62, 63, 64), which no guardrail gates.
 *  The line also reaches the audit judge's prompt verbatim, where Act is scored on whether suggestions
 *  are real next work — so a clause asserting "not routine" is an input to that verdict, not just a
 *  label (lens 2).
 *  The sentence now says what the key knows and nothing else; whether the work is gate-class is the
 *  reader's call. Pinned literal, hex-free and paren-free by test/in2-verdict-marker.test.ts. */
export const VERDICT_MARKER_TEXT = "human gate: cites a commit on a configured verdict path";

/** Tier B (Stage-2 recap campaigns, spec §4.7): the LEVEL-3 line prefix — nine spaces, U+25AA, one
 *  space — under which a Stage-1 group's members render when their group sits inside a campaign.
 *  ⚠ LOAD-BEARING FOR A COUNTED FLAG: it begins with none of `LEGEND_PREFIX`, `NOT_SHOWN_PREFIX` or
 *  `VERDICT_MARKER_PREFIX` (subprojects.ts), the three prefixes `audit.coverageGaps` filters OUT of
 *  its haystack — so a member line stays in that haystack at level 3 exactly as it did at level 2, and
 *  no label goes uncovered because a campaign absorbed its group. Pinned against the exported
 *  constants, never literals (spec §5.4) — and, like those three, never spelled here as a glyph:
 *  their wiring pins read this file's text. */
export const CAMPAIGN_L3_PREFIX = "         ▪ ";

/** IN-10: the provenance label on a code-built stash suggestion (`core.stashSuggestions`), appended
 *  after its text the way `(from resume)` is — e.g. `  (from stash · no branch · 14 days old)`.
 *  The age lives HERE, outside `text`, because the text's token count is what keeps the counted
 *  restatement rule unable to fire (see `stashSuggestions`). The label is not scored by postcheck.
 *
 *  ⚠ IT CARRIES NO GIT-SUPPLIED TEXT — ONLY FIXED WORDS AND A DAY COUNT — AND THAT IS A MEASURED
 *  CONSTRAINT. A branch name (`on <branch>`, the first version) lands in text that three COUNTED audit
 *  checks read, and review round 1 moved each of them end to end (temp repos → real runCore → real
 *  `scripts/audit.ts --no-judge`): a stash on `fix/accountant_ai-sync` HID an "uncommitted not
 *  surfaced" flag for a separate `accountant_ai` repo or lane (1 flag → 0, `coverageGaps`); a branch
 *  `x,aaaa111,bbbb222,y` INVENTED two fabricated SHAs and failed SHA grounding (`extractCitedShas`);
 *  a branch `bisect/<same-day sha7>` reported a missing same-day commit as present (`missingSameDay`).
 *  So only a branchless stash says so (`no branch`); a named branch renders nothing. Both
 *  alternatives were rejected. Filtering the label out of the audit's text: it shares its line with
 *  the `[repo]` bracket (no prefix to cut on), git allows parentheses in a branch name (no reliable
 *  suffix), and it would change the flag logic of three counted checks. Vetting branch names at
 *  generation: it cannot be complete — the audit reads the tree LATER, and in the lane case above
 *  `accountant_ai` was not yet a unit when the briefing was written.
 *  ⚠ The RESUME backfill (`subprojects.ts`) still prints git's `On <branch>: …` for the first two
 *  stashes — that pre-existing leak is unchanged; closing it means changing the audit's flag logic.
 *  ⚠ MIRRORED in gui/src/lib/briefing-struct.ts — the GUI shows its struct view only when it renders to
 *  the file's exact text, so a change here without the mirror silently drops the app to its markdown
 *  view on every stash morning. gui/tests-web/briefing.check.ts pins the two against each other. */
export function stashLabel(s: { branch?: string; ageDays?: number }): string {
  const where = s.branch === "(no branch)" ? "no branch" : null;
  const age = s.ageDays === undefined ? null
    : s.ageDays === 0 ? "made today" : `${s.ageDays} day${s.ageDays === 1 ? "" : "s"} old`;
  return `  (${["from stash", where, age].filter((x) => x !== null).join(" · ")})`;
}

/** Max sub-project labels listed per parent repo in the legend, with a `(+N more)` tail beyond it.
 *  Same anti-blowup idiom as `activityLine`'s 8-file cap and `STAGE1_LIST_CAP`. MEASURED: 40
 *  sub-projects rendered a 704-char single line, which is not a legend a reader parses — it is a
 *  wall. The legend's job is to teach the SHAPE (these labels are areas of that repo), and a
 *  truncated list still teaches it. */
export const LEGEND_LABEL_CAP = 8;

// ── The 🔀 foot block: ONE line per label (shape S3b, user-directed 2026-09-24) ────────────────────
// `core.ts` emits one `windowMerges` entry per in-window PR landing, each with the text
// `🔀 Merged #N (branch) (Mon D)  (sha7)`. On a busy morning that was a measured mean of 9.56 foot
// lines (2026-09-23: 13 of 32 top-level recap lines). They collapse HERE, at render time, to
//   `🔀 2 PRs merged (#533, #531) (Sep 21–Sep 22)  (e7b732b, d27d108)`
// per label. Two properties of that shape are load-bearing, and both were MEASURED before it was chosen:
//   • The 7-hex SHAs sit in their OWN trailing paren group, comma-separated, nothing else in it.
//     `audit.extractCitedShas` mines a paren group only when ≥50% of its comma-separated parts are lone
//     hex tokens, so `(#529 abc1234, #531 def5678)` would NOT be mined and every cited SHA on the page
//     would vanish from the count. With the SHAs alone in their group, the four archived pages with a
//     SUBSTANTIAL foot block kept 76/97/95/66 cited SHAs exactly; every other shape tried lost 11–26
//     per page. (Re-measured 2026-09-24 against this code: those four numbers reproduce exactly, and
//     the count is unchanged — 0 cited SHAs lost — on all eight archived pages that carry any 🔀 line
//     at all. ⚠ Only FOUR of those eight are evidence: the other four (2026-08-15..18, 54/19/30/55)
//     carry the SINGLE-space "Today so far" shape, which this cannot parse and never touches, so
//     their "0 lost" is vacuous. Cold verify 2026-09-24 corrected an earlier draft of this line that
//     presented all eight as load-bearing.)
//     ⚠ "IDENTICAL" IS ABOUT MERGE SHAS, NOT THE WHOLE MINED SET, and the difference is not cosmetic.
//     The collapse deletes the BRANCH NAME from the page, and a branch name is git-supplied text the
//     miner reads: a branch that is a lone 4–40-hex token, or a comma list ≥50% of whose parts are,
//     is mined TODAY as a top-level paren group and is NOT mined after. Measured on this code
//     (2026-09-24): `🔀 Merged #123 (deadbeef) (Sep 22)  (abc1234)` mines `[deadbeef, abc1234]` before
//     and `[abc1234]` after; a branch `aaaa111,bbbb222` mines both before and neither after. The
//     DIRECTION is safe — it removes a pseudo-citation that reads as a fabricated SHA (the same class
//     `stashLabel`'s header records paying for) — but the claim is "no merge SHA is lost", not "the
//     mined set is unchanged". `test/merge-foot-collapse.test.ts` pins the measured case.
//   • It happens at RENDER time, and `struct.windowMerges[].text` keeps the per-merge shape all the way
//     through `core.ts` and `generator.ts`. `dropMergedPrSuggestions` (generator.ts) mines PR numbers
//     from those texts with the literal `/🔀 Merged #(\d+)/g` to drop a "Suggested next" item that
//     names an already-merged PR; measured, every collapsed shape breaks that guard SILENTLY when it
//     reaches the struct (the suggestion just survives, no warning). So the struct is never reshaped
//     and the guard keeps reading uncollapsed data. `test/merge-foot-collapse.test.ts` pins both.
// A text that does not parse as the `core.ts` shape (an older fixture, a hand-built struct) is
// re-emitted VERBATIM, under its own label — this function never drops or rewords a line it cannot
// read. ⚠ ITS POSITION IS NOT PRESERVED: unparsed texts are emitted AFTER their label's collapsed
// line, so an unparsed text that sat BETWEEN two parsed merges moves below both. Nothing else about
// it changes. (A struct mixing the two shapes under one label is not something `core.ts` can produce
// — it is an older archived struct or a hand-built one.)
// ⚠ MIRRORED in gui/src/lib/briefing-struct.ts (`collapseWindowMerges`) — the GUI cannot import the
// engine (docs/gui-seam.md §1), so it carries a byte-parallel copy that gui/tests-web/briefing.check.ts
// pins against this one. Change both or the GUI silently drops to its markdown view.

/** The exact text `core.ts` builds for a window merge. The date tag is absent when the merge carried
 *  no parseable timestamp.
 *
 *  ⚠ THE BRANCH GROUP IS `\S*?` — SPACE-FREE — AND THAT IS WHAT MAKES THE PARSE SOUND, not the
 *  anchored `  (sha7)$` tail the first version of this comment credited. The tail alone does not
 *  disambiguate: with a branch group that could contain a space, a lazy `(.+?)` happily swallows a
 *  well-formed date tag to reach it, and the date is then dropped from the collapsed line with no
 *  warning. Measured on the pre-2026-09-24 form: `🔀 Merged #3 () (Sep 22)  (ccc1234)` — reachable,
 *  because `listPrMerges` captures the branch with `(\S+)` and a subject ending `from owner/` yields
 *  `branch === ""` (git.ts) — parsed as branch `") (Sep 22"` and rendered `🔀 1 PR merged (#3)  (…)`,
 *  losing the date.
 *  The real guarantee is that `listPrMerges`'s `(\S+)` means a branch can NEVER contain a space, and
 *  `\S*?` now ENCODES that guarantee instead of relying on it unstated: `*` (not `+`) admits the
 *  empty branch, so its date survives, and `\S` makes the date-swallowing match impossible to form.
 *  A text that genuinely does not fit the shape — a branch with a space in it could only come from a
 *  hand-built struct — fails to match and passes through instead of rendering a wrong line.
 *  Parentheses in a ref name are still legal and still parse (`fix/(paren)`), which is why the group
 *  stays lazy. */
const WINDOW_MERGE_TEXT =
  /^🔀 Merged #(\d+) \((\S*?)\)(?: \(((?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{1,2})\))?  \(([0-9a-f]{7})\)$/;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** `(Sep 22)` for one distinct date, `(Sep 21–Sep 22)` for a span, `""` when no line carried a date.
 *  Chronological, not line order.
 *
 *  ⚠ THE `Mon D` TAGS CARRY NO YEAR, SO THE BRIEFING'S OWN DATE SUPPLIES ONE. Every window merge
 *  landed on or before the run date (`core.ts` computes `runDate` after the extractor has filtered the
 *  window to `< now`), so a `Mon D` later in the year than the run date can only belong to the
 *  PREVIOUS year. That reads the wrap off a fact instead of guessing it.
 *  ⚠ IT USED TO GUESS, and the guess inverted real spans (cold review 2026-09-24, MED): "a span wider
 *  than half a year can only be a Dec→Jan window" is false as soon as the window IS wider than half a
 *  year, and it is reachable by config — `config.ts` validates `lookbackCapDays` as nothing more than
 *  a finite number (`DEFAULT_LOOKBACK_CAP_DAYS` is 4, but the test suite itself runs 30). Measured on
 *  the old form: `[(Mar 1), (Oct 15)]` rendered `(Oct 15–Mar 1)`. Narrowing the guess to "the set
 *  contains both a Dec and a Jan date" does not work either — measured on the same form, a
 *  `[(Nov 20), (Jan 5)]` window contains neither pair and wraps correctly today, and would stop.
 *  The run date is the only input that answers it, and it is already on the struct.
 *
 *  `runDate` is `YYYY-MM-DD` (`marker.localDateStr`). Anything else — no struct ever carries it — is
 *  treated as no anchor at all: the tags are ordered on the bare month*31+day ordinal and no wrap is
 *  applied, which is right for any window inside one year and merely mis-orders a year-crossing one.
 *  ⚠ THE ANCHOR ITSELF IS ONLY CORRECT FOR A WINDOW OF AT MOST ONE YEAR, because `Mon D` carries no
 *  year: a merge from more than a year back is folded into the current year and drops out of the span
 *  (cold verify 2026-09-24, LOW — `lookbackCapDays` is unbounded, so it is config-reachable). A window
 *  that wide would need the year on the struct, not a re-parse of the rendered tag. */
function mergeDateRange(dates: string[], runDate: string): string {
  if (!dates.length) return "";
  const ord = (d: string) => MONTHS.indexOf(d.slice(0, 3)) * 31 + Number(d.slice(4));
  const a = /^\d{4}-(\d{2})-(\d{2})$/.exec(runDate);
  const anchor = a ? (Number(a[1]) - 1) * 31 + Number(a[2]) : null;
  // Past the anchor ⇒ last year. `- 372` keeps the ordinal ordering intact across the boundary.
  const os = dates.map((d) => { const o = ord(d); return { d, o: anchor !== null && o > anchor ? o - 372 : o }; });
  const first = os.reduce((x, y) => (y.o < x.o ? y : x));
  const last = os.reduce((x, y) => (y.o > x.o ? y : x));
  return first.d === last.d ? ` (${first.d})` : ` (${first.d}–${last.d})`;
}

/** The foot block as rendered: labels in the stable sort the foot has always used, then one collapsed
 *  line per label (PR numbers and SHAs in the label's original order), then any text under that label
 *  this could not parse, in its original order. Empty in → empty out.
 *
 *  ⚠ IT DOES NOT TOUCH ITS ARGUMENT — `[...merges]`, not `merges.sort(…)`. The caller is
 *  `renderBriefing`, which hands it `struct.windowMerges` itself, and the STRUCT is the value
 *  `dropMergedPrSuggestions` and the `run --json` envelope read: an in-place sort here would silently
 *  reorder the caller's data as a side effect of rendering it. Nothing about the rendered page would
 *  change (the sort is idempotent, so even a second render agrees), which is exactly why it needs an
 *  assertion rather than a comment — `test/merge-foot-collapse.test.ts` deep-snapshots
 *  `struct.windowMerges` across a render.
 *
 *  ⚠ LABELS ARE GROUPED ON `norm(label)`, NOT THE RAW STRING, and sorted with an EXPLICIT `"en"`
 *  locale. `norm` is the key every other label consumer uses — the renderer's own recap-cluster key
 *  two hundred lines below, `coverageGaps`, `whyFor` — and since 2026-09-24 the label is a GROUPING
 *  key here too, so `Mono` and `mono` must not produce two collapsed lines. The group renders under
 *  the first raw label the struct gave it; an unparsed passthrough keeps its own. And an ordering that
 *  is now visible to the reader must not depend on the host's default locale, which differs between
 *  the CLI process and the GUI's webview. */
export function collapseWindowMerges(
  merges: { repo: string; text: string }[], runDate: string,
): { repo: string; text: string }[] {
  type Slot = { label: string; parsed: { pr: string; date?: string; sha: string }[]; rest: { repo: string; text: string }[] };
  const byLabel = new Map<string, Slot>();
  for (const m of [...merges].sort((a, z) => norm(a.repo).localeCompare(norm(z.repo), "en"))) {
    let slot = byLabel.get(norm(m.repo));
    if (!slot) { slot = { label: m.repo, parsed: [], rest: [] }; byLabel.set(norm(m.repo), slot); }
    const hit = WINDOW_MERGE_TEXT.exec(m.text);
    if (hit) slot.parsed.push(hit[3] ? { pr: hit[1]!, date: hit[3], sha: hit[4]! } : { pr: hit[1]!, sha: hit[4]! });
    else slot.rest.push(m);
  }
  const out: { repo: string; text: string }[] = [];
  for (const { label, parsed, rest } of byLabel.values()) {
    if (parsed.length) {
      const n = parsed.length;
      const prs = parsed.map((p) => `#${p.pr}`).join(", ");
      const shas = parsed.map((p) => p.sha).join(", ");
      const when = mergeDateRange(parsed.flatMap((p) => (p.date ? [p.date] : [])), runDate);
      out.push({ repo: label, text: `🔀 ${n} PR${n === 1 ? "" : "s"} merged (${prs})${when}  (${shas})` });
    }
    for (const m of rest) out.push({ repo: m.repo, text: m.text });
  }
  return out;
}

// Neutralize terminal-escape / control-character injection. Git-derived filenames and branch names —
// and raw provider text — can carry ANSI escapes or C0/C1 control bytes (all legal in POSIX filenames,
// droppable into a working tree by a cloned repo's build script or a checked-out PR branch). This
// string is written BOTH to the user's terminal and to briefing-latest.md, so an unsanitized
// `\x1b]0;pwned\x07` or a CSI sequence would execute against the terminal. Strip every C0 control
// (incl. newline/CR/tab), DEL, and C1 (0x80–0x9f) byte. Applied PER LINE, before the structural
// newlines are re-added by join(), so an embedded newline in a field can't forge an extra bullet
// either. Emoji and non-Latin filenames (U+00A0 and up) are untouched. Removing just the control byte
// leaves any escape sequence as inert, visible text (e.g. `\x1b[31m` → `[31m`), flagging the tampering.
// Deliberately NOT stripped: Unicode bidi overrides (U+202A–202E / U+2066–2069, the "Trojan Source"
// visual-reordering class) and U+2028/U+2029 — these can't execute an escape or forge a line (neither
// the terminal nor CommonMark treats U+2028/9 as a line break), and stripping the bidi range would
// corrupt legitimate right-to-left filenames. That's a visual-spoofing concern, out of this scope.
export const stripControl = (s: string): string => s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");

// Sanitize a FREE-FORM multi-line string: strip control bytes from each real line but KEEP the
// line structure. Use this (not stripControl on the whole string, which would delete the newlines,
// nor a per-array-element map, which flattens any element that is itself multi-line) for text with
// genuine internal newlines — e.g. the audit report's LLM-judge verdict.
export const stripControlLines = (s: string): string => s.split("\n").map(stripControl).join("\n");

export function renderBriefing(b: BriefingStruct): string {
  const L: string[] = [];
  // ⚠ "Morning" was DROPPED 2026-08-17 (scope decision, user-directed): the deliverable is a
  // FIRST-WAKE briefing, not an 07:20 one, and the old header promised a time the product never
  // offered — `morningTime` only SUPPRESSES ticks below the floor (`main.ts:96`), it never requires
  // delivery at it. Day-31's judge put it exactly: "a 12:41 'morning briefing' against a 07:20 floor
  // is stale by name."
  // ⚠ ANY change to this string is a PARSER change too: `audit.ts`'s `lastBriefing` splits
  // `briefing.log` into per-day blocks by matching it, and 31 days of archived briefings carry the
  // OLD text — so its matcher accepts both spellings and must keep doing so. See
  // `BRIEFING_HEADER_RE` in audit.ts (named rather than line-cited: a line number in a comment goes
  // stale silently, and this workspace has already shipped one such citation off by three).
  L.push(`☀️  Daily briefing — ${b.date}  (this machine: ${b.machineScope})`);
  L.push("");
  // The outage line OPENS the briefing — the silence is what made the 2026-08-23 outage invisible for a
  // day and a half, so the recovery notice cannot be a trailing warning. Deliberately NOT the `warnings`
  // channel below, which renders after "Suggested next", semicolon-joined with unrelated text.
  if (b.outage) {
    L.push(`⚠️  No briefing for ${b.outage.missedDays} day${b.outage.missedDays === 1 ? "" : "s"} — account "${b.outage.label}" was at its usage limit.`);
    L.push("");
  }
  // ── SUB-PROJECT LABEL LEGEND (judge days 41, 43, 44). ONE code-built line, directly under the
  // header/outage area and ABOVE "Where you left off" — it is the frame every `[label]` below is read
  // in, and the same reasoning that put `branchState` above the resume bullets applies: a legend
  // printed after the labels it explains arrives too late to have prevented the misreading.
  //
  // ⚠ THE DEFECT IT CLOSES. Sub-project labels are folder basenames (`labelUnits`), so
  // `[accountant_ai]` and `[personal_code]` render as peers while one is a FOLDER INSIDE the other.
  // Day 44: "[personal_code] no window work pending" — true of that unit, and read as the whole repo
  // being idle, while 36 commits had landed in it under sibling labels.
  //
  // ⚠ ABSENT ⇒ NOTHING RENDERED, not an empty line. A single-project install has no sub-project units,
  // so its briefing is byte-identical to before this existed. Pinned by test.
  //
  // ⚠ THE LINE'S PREFIX IS A SHARED CONSTANT (`LEGEND_PREFIX`, subprojects.ts) BECAUSE IT HAS A
  // SECOND READER: `audit.coverageGaps` excludes lines carrying it from its haystack. This line names
  // every label AND its parent repo, so leaving it in that haystack makes the `UNCOMMITTED NOT
  // SURFACED` flag unfireable for any repo with a sub-project (measured: 1 gap → 0). Change the
  // marker here and the excluder there stops matching, silently — hence one constant, not two.
  const legend = (b.labelLegend ?? []).filter((g) => g.labels.length > 0);
  if (legend.length) {
    // Grammar is minimal on purpose (one repo may legitimately expose a single sub-project unit on a
    // quiet day); groups are joined with "; " so multiple parent repos still occupy exactly one line.
    const groups = legend.map((g) => {
      const shown = g.labels.slice(0, LEGEND_LABEL_CAP);
      const more = g.labels.length - shown.length;
      // Plurality follows the TRUE count, not the shown count — "…(+32 more) is an area" would be
      // wrong the moment the cap bites.
      return `${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""} ${g.labels.length === 1 ? "is an area" : "are areas"} of repo ${g.repo}`;
    });
    L.push(`${LEGEND_PREFIX}${groups.join("; ")})`);
    L.push("");
  }
  // Working-tree facts are volatile (repos auto-commit, the user works while the provider runs) —
  // stamp when they were true instead of presenting them as durable (audit 2026-07-10 #1).
  // ── Slice 1.5b (§3.5): the why lines.
  //
  // ⚠ PRE-PASS FIRST, because this renderer emits RESUME BEFORE RECAP. A unit whose label appears in
  // RECAP gets its line in RECAP ONLY; every other unit with a why gets it in RESUME. Emitting
  // inline in document order would put every line in RESUME first, which is the opposite of intent.
  //
  // ⚠ Walks ONLY `resume` and `recap`. NEVER `today` — its bullets carry the same unit labels and
  // render as a third section, so a generic "walk each section" loop would quote an in-window turn
  // against commits §3.2 deliberately excludes from `unitFiles`. `today` joins `suggestions` on the
  // "Not:" list.
  //
  // ⚠ This WHYS pre-pass does NOT group or reorder anything — a transcript-side feature changing
  // the rendered shape of the GIT-ONLY briefing is what invariant 8 forbids. (The recap's own
  // display clustering below is a deliberate product change to the git briefing itself, driven by
  // the code-side `group` stamp — different author, different rule.)
  const whys = b.whys ?? {};
  const recapKeys = new Set(b.recap.map((r) => norm(r.repo)));
  const emitted = new Set<string>();
  /** The why line for this bullet, or null. Emitted once, before the FIRST bullet with that key —
   *  non-contiguous bullets for one label are fine. Invariant 1 is structural here: this is only
   *  ever reached from inside a bullet's own map, so a why can never create a bullet. */
  const whyFor = (label: string, section: "resume" | "recap"): string | null => {
    const key = norm(label);
    const turn = whys[key];
    if (turn === undefined || emitted.has(key)) return null;
    const home = recapKeys.has(key) ? "recap" : "resume";   // the pre-pass decision
    if (home !== section) return null;
    emitted.add(key);
    return renderWhy(turn);
  };

  // Day-23: floor AND actual time, both stated, no cause inferred. A briefing that lands hours after
  // the floor is CORRECT behaviour for a lid-closed laptop (2026-07-16 design: "ready when the user
  // first sits down") — but with only one timestamp printed it is indistinguishable from a failure,
  // and on 2026-08-08 it was misread as one by two readers in sequence.
  // ⚠ RE-FRAMED 2026-08-17, not re-plumbed. The floor is still PRINTED — the day-23 property above
  // (both times stated, so a late delivery is not indistinguishable from a failure) is exactly the
  // confusion the scope decision fixes, so it gets stronger, not weaker. What changed is what the
  // floor is called: it is the time below which ticks are suppressed, NOT a delivery target, so the
  // stamp now names the delivery as "first wake" and the floor as the thing it is past.
  const stamp = b.stateAsOf
    ? `  (${b.morningFloor ? `first wake past ${b.morningFloor} · ` : "first wake · "}state as of ${b.stateAsOf})`
    : "";
  L.push(`▶ Where you left off${stamp}`);
  // Branch state FIRST, above the model's resume bullets: it is the frame those bullets are read
  // in. On 2026-08-06 the only resume item was interpreted wrongly for want of exactly this line,
  // and a correction placed after the thing it corrects is read too late (the same reasoning that
  // moved drift out of the footer and into the suggestions themselves).
  L.push(...(b.branchState ?? []).map((s) => `   • [${s.repo}] ${s.text}`));
  L.push(...(b.resume.length
    ? b.resume.flatMap((r) => { const w = whyFor(r.repo, "resume"); const line = `   • [${r.repo}] ${r.text}`; return w ? [w, line] : [line]; })
    : ["   (nothing in progress)"]));
  L.push("");
  // Recap count in the header (day-16 finding 4: with no count, suppression is invisible). Suffix
  // only — every consumer substring-matches "What you did"; nothing parses this line.
  // Day 49: the count above agreed with the render and not with the world — it was the BULLET count,
  // so a commit the model silently dropped could never show up in it. `recapCoverage` is ABSENT
  // whenever every in-window commit is accounted for, so this whole block is inert on a complete
  // morning and the header is byte-identical to before.
  // Both numbers are COMMIT counts (cold review MEDIUM-2): `shown` is in-window commits a bullet
  // resolves to, not the bullet count. Mixing the two is the original defect — and this file already
  // ruled on it once, at clusterRecap's `nCommits` ("the model can cite one commit twice, and the
  // code-built line must never make a wrong numeric claim").
  const cov = b.recapCoverage;
  // The count is driven by coverage when present, and by the bullet count otherwise. It must NOT be
  // gated on `b.recap.length`: a briefing whose RECAP section came back empty over a non-empty
  // window is exactly the case this feature exists for, and gating there printed no count, then the
  // drop list, then "(no commits in the window)" underneath it (cold review HIGH-1).
  const headCount = cov ? `${cov.shown} of ${cov.total}` : (b.recap.length ? `${b.recap.length}` : "");
  const headPlural = (cov ? cov.total : b.recap.length) === 1 ? "" : "s";
  L.push(`▶ What you did${headCount ? ` \u2014 ${headCount} commit${headPlural}` : ""}`);
  if (cov) {
    const hidden = cov.total - cov.shown - cov.notShown.length;
    L.push(`   \u26a0 ${cov.total - cov.shown} in-window commit(s) NOT shown above:`);
    // ⚠ PREFIX IS A SHARED CONSTANT (`NOT_SHOWN_PREFIX`, subprojects.ts) because it has a SECOND
    // READER: `audit.coverageGaps` excludes these lines from its haystack. Same guard, and same
    // reason, as the legend line above — see that constant's header.
    for (const n of cov.notShown) L.push(`${NOT_SHOWN_PREFIX}[${n.label}] ${n.sha} ${n.subject}`);
    if (hidden > 0) L.push(`${NOT_SHOWN_PREFIX}(+${hidden} more)`);
  }
  if (b.recap.length) {
    // Group-aware walk (T1.3): the FIRST entry of each `group` emits a code-built story line, then
    // every member of that cluster nested (\u25e6, two extra spaces) — each member keeps its exact
    // flat-line content (label, text, evidence), so every SHA/label the audit mines is still on its
    // own line. Later occurrences of an emitted cluster are skipped in the main walk (their lines
    // already rendered under the story). Ungrouped entries render byte-identically to the old shape.
    // Every entry renders exactly once — the skip test is the emitted-cluster set, nothing else.
    const emittedClusters = new Set<string>();
    const bulletOf = (r: (typeof b.recap)[number], indent: string, glyph: string) =>
      `${indent}${glyph} [${r.repo}] ${r.text}${r.evidence ? `  (${r.evidence})` : ""}`;
    // ── Tier B (spec §4.7 "Render"): ONE new branch, active only when an entry carries `campaign`
    // (`!== undefined`, D16 — an absent field is the whole pre-B page, byte for byte; T1.0's render
    // golden is the proof). A campaign renders at the position of its FIRST member as a level-1 header,
    // its members beneath it in Stage-1 order: a member's Stage-1 group as a level-2 header with that
    // group's members at level 3 (`CAMPAIGN_L3_PREFIX`), a single member as a level-2 bullet.
    // `emittedClusters` is SHARED with the Stage-1 walk below — keyed exactly as it always was — so a
    // group emitted under a campaign is never re-emitted at level 1, and a group emitted at level 1 is
    // never re-emitted under a campaign. `whyFor` is memoised per `norm(label)`, so the why line precedes
    // the campaign header and is emitted at most once per label.
    const emittedCampaigns = new Set<string>();
    const l3Of = (r: (typeof b.recap)[number]) =>
      `${CAMPAIGN_L3_PREFIX}[${r.repo}] ${r.text}${r.evidence ? `  (${r.evidence})` : ""}`;
    for (const r of b.recap) {
      if (r.campaign !== undefined) {
        const ck = `${norm(r.repo)}\x1f${r.campaign}`;
        if (emittedCampaigns.has(ck)) continue;   // members already nested under the campaign header
        emittedCampaigns.add(ck);
        const w = whyFor(r.repo, "recap");
        if (w) L.push(w);
        L.push(`   • [${r.repo}] ${r.campaign}`);
        for (const m of b.recap) {
          if (m.campaign !== r.campaign || norm(m.repo) !== norm(r.repo)) continue;
          if (m.group !== undefined) {
            const gk = `${norm(m.repo)}\x1f${m.group}`;
            if (emittedClusters.has(gk)) continue;
            emittedClusters.add(gk);
            L.push(`      ◦ [${m.repo}] ${m.group}`);
            for (const g of b.recap) {
              if (g.group === m.group && norm(g.repo) === norm(m.repo)) L.push(l3Of(g));
            }
          } else {
            L.push(bulletOf(m, "      ", "◦"));
          }
        }
        continue;
      }
      if (!r.group) {
        const w = whyFor(r.repo, "recap");
        if (w) L.push(w);
        L.push(bulletOf(r, "   ", "\u2022"));
        continue;
      }
      const ck = `${norm(r.repo)}\x1f${r.group}`;
      if (emittedClusters.has(ck)) continue;   // members already nested under the story line
      emittedClusters.add(ck);
      const w = whyFor(r.repo, "recap");
      if (w) L.push(w);
      L.push(`   \u2022 [${r.repo}] ${r.group}`);
      for (const m of b.recap) {
        if (m.group === r.group && norm(m.repo) === norm(r.repo)) L.push(bulletOf(m, "      ", "\u25e6"));
      }
    }
  } else if (!cov) {
    // Only when coverage has nothing to say. With `cov` present the window is NOT empty — the drop
    // list above just named its commits — so the old line would contradict the three lines above it.
    L.push("   (no commits in the window)");
  }
  // In-window PR landings (defect D — EVAL day 33): deterministic dated 🔀 lines at the FOOT of the
  // recap, code-rendered like `today`'s merge lines so they cannot be hallucinated. Foot, not
  // interleaved: the recap above is model prose in model order, and these carry their own dates.
  // Stable label sort (T1.3): with real unit labels the foot reads grouped per unit; within a
  // label the original (date) order is preserved (Array.sort is stable). Since 2026-09-24 the block
  // is ONE line per label (S3b) — the collapse is render-time only; see `collapseWindowMerges`.
  L.push(...collapseWindowMerges(b.windowMerges ?? [], b.date).map((m) => `   • [${m.repo}] ${m.text}`));
  L.push("");
  if (b.today?.length) {
    L.push("▶ Today so far");
    L.push(...b.today.map((t) => `   • [${t.repo}] ${t.text}`));
    L.push("");
  }
  L.push("▶ Suggested next");
  // `(from resume)` (S1): PROVENANCE, not decoration. A promoted line is the verbatim tail of a
  // RESUME bullet the reader has already seen 20 lines up, so without the label it reads as the model
  // repeating itself — the exact redundancy the day-43 judge called out. The label says "this is the
  // action you stated, carried down here", which is why the duplication is the point.
  //
  // ── IN-2: the VERDICT-PATH MARKER — one extra line UNDER a suggestion stamped `verdictPath`
  // (core.markVerdictPathSuggestions, keyed on the cited commit's git diffstat, never on prose).
  // ANNOTATE, NEVER SUPPRESS: the suggestion's own line is emitted first and byte-identical to the
  // unmarked form, so every reader of that line — the audit's text predicates, the GUI's bullet
  // classifier, a human skimming — sees exactly what it saw before. Absent field ⇒ no line, so with
  // `Config.verdictPaths` unset (the default) this block renders byte-identically to pre-IN-2.
  // ⚠ The line's PREFIX is `VERDICT_MARKER_PREFIX` (subprojects.ts), SHARED with `audit.coverageGaps`'
  // haystack exclusion — the LEGEND_PREFIX / NOT_SHOWN_PREFIX pattern above, for the same reason.
  L.push(...(b.suggestions.length
    ? b.suggestions.flatMap((s) => {
      // IN-10: `(from stash · …)` is the same provenance idea for the stash channel — see `stashLabel`.
      const line = `   • ${s.repo ? `[${s.repo}] ` : ""}${s.text}${s.promoted ? "  (from resume)" : ""}${s.stash ? stashLabel(s.stash) : ""}`;
      return s.verdictPath ? [line, `${VERDICT_MARKER_PREFIX}${VERDICT_MARKER_TEXT}`] : [line];
    })
    : ["   (none)"]));
  if (b.warnings?.length) { L.push(""); L.push("⚠ " + b.warnings.join("; ")); }
  L.push("");
  // "generated via", not "generated locally via" (known item 10, Phase E final harden): the text is
  // produced by the model behind `<provider>` — a remote API for an HTTP provider, and for the default
  // CLI provider too, whose CLI sends the prompt to its own service. Only a local model (Ollama, …)
  // generates on this machine, so "locally" was false for nearly every briefing.
  L.push(`— generated via ${b.provider}`);
  // Sanitize each line, THEN join — structural newlines are added here, so no field can inject one.
  return L.map(stripControl).join("\n");
}
