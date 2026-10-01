// src/types.ts — FROZEN CONTRACTS. Only ADDITIVE, optional fields may be appended (e.g. BriefingStruct.today);
// never rename/remove/retype an existing field or change required-ness — later-slice consumers depend on the shape.

export type ActivityMeta = {
  /** `renamedFrom` (additive, defect C — EVAL day 32): the OLD path of a rename row, so evidence
   *  renderers can show the delete half; `file` stays the new-path side and remains the attribution
   *  key everywhere (subprojects/reduce untouched). */
  diffstat?: { file: string; added: number; removed: number; renamedFrom?: string }[];
  aheadBehind?: { ahead: number; behind: number };
  /** Additive: FALSE when the branch has no upstream at all. Without it `{ahead:0,behind:0}` is
   *  emitted for a purely local branch and reads as "in sync with origin" — a false claim in the
   *  day-16 B3 family. `git rev-list ...@{u}` exits 128 with no upstream and `git.ts` swallows it,
   *  leaving the zeros indistinguishable from genuine parity. MEASURED, not inferred. */
  hasUpstream?: boolean;
  /** Additive: TRUE when this branch is the repo's default (from `origin/HEAD`, falling back to a
   *  main/master heuristic). Drives suppression — see `branchStateLines`. */
  isDefaultBranch?: boolean;
  dirty?: boolean;
  uncommittedFiles?: string[]; // additive: structured working-tree paths (uncommitted kind); eventId-neutral
  [k: string]: unknown;
};

export type Activity = {
  source: "git" | "claude-code" | "codex" | "gemini" | "copilot" | "cursor"; // required
  kind: "commit" | "edit" | "command" | "prompt" | "response"
      | "uncommitted" | "branch" | "stash";                                  // required
  event_id: string;        // required — dedup / high-water-mark key
  session_id?: string;     // grouping key for map-reduce (1.5+)
  repo?: string;
  timestamp?: string;      // ISO-8601 with offset
  actor?: "user" | "assistant" | "system";
  target?: string;
  text?: string;
  meta?: ActivityMeta;
};

export type ReducedContext = {
  repos: { repo: string; summary: string; activities: Activity[] }[];
  note?: string;
};

export type BriefingStruct = {
  date: string;            // ISO date
  machineScope: string;    // hostname etc.
  provider: string;        // which CLI produced it
  resume: { repo: string; text: string; ref?: string }[];
  /** `group?` (additive, T1.3): display-cluster stamp — entries sharing a stamp render nested under
   *  one code-built story line ("<file> — N commits (dates)", or since IN-3 Stage 1b
   *  "<campaign> — N commits (dates)" / "<campaign> — N of M commits naming it (grouped: dates)" when
   *  the members' RAW git subjects share a campaign token or leading phrase within one git unit; the
   *  campaign key is read from git data, never from model prose. The bullet's label still SPLITS a
   *  group along the lines render.ts nests by, as it does for a file cluster; and since render.ts nests
   *  by label + stamp TEXT, two campaigns that would print one name under one label are dissolved to
   *  file clusters rather than joined under one header). Entries
   *  are never merged, dropped or reordered in the struct, and every existing consumer that ignores
   *  the field sees the exact pre-T1.3 shape; the audit's per-commit SHA reconciliation reads member
   *  lines unchanged.
   *
   *  `campaign?` (additive, tier B — Stage-2 recap campaigns, spec §4.7): the CAMPAIGN header text,
   *  `<title> — N commits`, spelled identically on every member entry, exactly as `group` carries
   *  Stage 1's header text one level down. Stamped in code by `applyCampaigns` from a validated model
   *  reply, only in mode `on` and only on an `applied` morning; members are identified by
   *  `(norm(repo), campaign)`, never by array index. A campaign absorbs whole Stage-1 groups (it never
   *  splits one), so an entry may carry BOTH stamps: `campaign` is the level-1 header, `group` the
   *  level-2 header beneath it. Absent ⇒ every renderer walks the pre-B two-level shape byte for
   *  byte; the default mode `off` never sets it. */
  recap: { repo: string; text: string; evidence?: string; group?: string; campaign?: string }[];
  /** `promoted?` (additive, S1 — EVAL day 43): TRUE when this suggestion was BUILT BY CODE from an
   *  explicit next action a RESUME bullet already stated ("Resume: audit day-42 briefing next"), not
   *  written by the model. Two consecutive mornings ended a resume bullet with an explicit action that
   *  never appeared under "Suggested next"; the day-43 judge: "any Resume: action must become
   *  suggestion #1 or the block is redundant."
   *
   *  Promoted entries are PREPENDED by `promoteResumeActions`, so they lead the block as the judge
   *  required. The flag itself marks the CHANNEL, not the rank — position carries the rank, and two
   *  consumers read the flag precisely because they need to tell the channels apart:
   *  `render.ts` labels the line `(from resume)` so the reader can see the provenance, and
   *  `postcheck.checkSuggestionRestatement` SKIPS it (a verbatim promotion restates its bullet BY
   *  CONSTRUCTION; that rule grades model behaviour, and scoring this channel would report 1.000
   *  containment every morning). Literal `true` rather than `boolean` so `promoted: false` — which
   *  would read as "the model wrote it", a claim this field cannot make — is not expressible. */
  /** `repo` (additive, EVAL day 51): the source unit of a PROMOTED suggestion, so render.ts can
   *  bracket it the way recap bullets are bracketed. S1's first live fire rendered its promotions
   *  with no lane at all while the model-authored suggestions beside them carried theirs. Present
   *  only on CODE-BUILT entries (promoted, and IN-10's `stash`) — a model-authored suggestion writes
   *  its own `[label]` inline. */
  /** `verdictPath?` (additive, IN-2 — EVAL days 51/52): TRUE when the suggestion CITES a commit whose
   *  diffstat touches an operator-configured verdict path (`Config.verdictPaths`). Stamped in code by
   *  `core.markVerdictPathSuggestions`, never by the model, and ONLY when that config key is set — so
   *  every existing install ships the pre-IN-2 struct and render. `render.ts` answers it with one
   *  marker line under the suggestion; the suggestion itself is never dropped, reordered or re-worded
   *  (annotate, not suppress — suppression is day 48's separate seal-lift rule). Literal `true` for
   *  the same reason as `promoted`: `false` would claim "checked and clean", which an unset key
   *  cannot. */
  /** `stash?` (additive, IN-10 — EVAL days 47/57/58/60/63): PRESENT when this suggestion was BUILT BY
   *  CODE from a persisting git stash (`core.stashSuggestions`), never by the model. Its presence marks
   *  the CHANNEL, like `promoted` — and it is deliberately NOT `promoted`: that flag makes
   *  `checkSuggestionRestatement` (and so eval check G6) skip the entry, a narrowing still pending
   *  operator ack, and this channel must not widen it. `render.ts` answers it with a provenance label
   *  outside the text, `(from stash · no branch · <age>)`. `branch` is git's own literal from the stash
   *  subject, `(no branch)` included; absent when the subject has no recognisable form. The label
   *  renders ONLY the `(no branch)` case — a branch NAME must not reach the page (`stashLabel`).
   *  `ageDays` is whole local calendar days since the stash was made; absent when its date cannot be
   *  read or falls after the run date (clock skew). */
  suggestions: { text: string; repo?: string; promoted?: true; verdictPath?: true; stash?: { branch?: string; ageDays?: number } }[];
  today?: { repo: string; text: string }[]; // additive: deterministic "today so far" commits (#1)
  /** Additive: a usage-limit outage that ENDED with this briefing. `missedDays` counts briefings that
   *  did not happen, not elapsed days — see core.ts. Present only when at least one was missed, so the
   *  ordinary failover day (delivered ~10 minutes late) renders nothing. */
  outage?: { missedDays: number; label: string };
  /** Additive (defect D — EVAL day 33, user-directed): PR merges that landed IN-WINDOW (before
   *  today). Rendered deterministically as dated 🔀 lines at the foot of "What you did" — the
   *  window-shaped half of the day-9 fix (`mergedToday` covers only the same-day half). Never sent
   *  to the LLM; like `today`, it cannot be hallucinated. */
  windowMerges?: { repo: string; text: string }[];
  warnings?: string[];
  stateAsOf?: string;      // additive: local HH:MM the working-tree state was captured (volatile facts get a timestamp)
  /** Additive (day-23): the configured morning floor as "HH:MM", printed beside `stateAsOf` so a
   *  reader can see AT A GLANCE whether the briefing arrived on time or late.
   *
   *  ⚠ It states two facts and asserts NO cause. On 2026-08-08 the laptop was lid-closed until 13:01
   *  and the briefing landed at 13:08 — which MEETS this project's stated success criterion ("ready
   *  when the user first sits down", 2026-07-16 design). With no floor printed, both the author and
   *  the assistant read that as a delivery failure; an EVAL row was filed as FAILED, retracted, and
   *  then its retraction re-framed. Two printed timestamps would have prevented all of it.
   *
   *  Deliberately NOT "late because the machine was asleep": inferring a cause means asserting one,
   *  and the two most recent confident causal claims in this project — the zero-yield trigger's
   *  "allowlist decay" and the assistant's retry-loop story — were both wrong. */
  morningFloor?: string;
  /** Additive (day-21 audit): CODE-RENDERED branch state per repo, shown inside "Where you left off".
   *  Never model-authored — the day-21 failure was the claim VANISHING (`quant_stocks` sat on
   *  `chore/sign-live-policy`, the briefing never said so, and its only suggestion was framed wrong
   *  as a result). A prompt instruction cannot fix a claim that gets dropped; a deterministic render
   *  can. Same pattern as `today`. Empty/absent when every repo has nothing worth saying. */
  branchState?: { repo: string; text: string }[];
  /** Additive (judge days 41/43/44): the SUB-PROJECT LABEL LEGEND — per parent repo, the labels that
   *  are AREAS OF that repo rather than peer repos. Built deterministically by
   *  `subprojects.subprojectLegend` from `Unit.root`, never model-authored, and rendered as ONE line
   *  under the header. ABSENT (not `[]`) when no sub-project units exist, which is the common
   *  single-project install — the renderer emits nothing and its output is byte-identical to before.
   *
   *  Same pattern as `branchState` and `today`: the containment relation lived only in `Unit.root`,
   *  two layers upstream of the artifact, so no prompt instruction could restore it — only a
   *  deterministic render can. */
  labelLegend?: { repo: string; labels: string[] }[];
  /** Additive (EVAL day 49): RECAP COVERAGE — in-window commits that no recap bullet accounts for.
   *  Built deterministically by `generator.recapCoverage`, never model-authored.
   *
   *  Day 49 rendered "What you did — 44 commits" over a 45-commit window: the number was the BULLET
   *  count, so it agreed with the render and not with the world, and a total derived from what was
   *  shown structurally cannot report what was not. The lost commit added a CI workflow.
   *
   *  ABSENT (not a zero record) when every in-window commit is covered — a complete morning renders
   *  byte-identically to before, exactly as `branchState` and `labelLegend` do. `notShown` is capped
   *  at `NOT_SHOWN_CAP` with the count carried by `total - shown`, so a pathological morning cannot
   *  turn this into a second recap.
   *
   *  ⚠ BOTH numbers are COMMIT counts drawn from ONE array, and that is the whole point — an earlier
   *  draft made `shown` the bullet count and `total` a bullet/commit sum, which is the defect this
   *  field exists to remove. `shown` will legitimately differ from the number of bullets below it: a
   *  bullet citing two commits covers two, and two bullets citing one commit cover one. */
  recapCoverage?: {
    shown: number;   // in-window commits a recap bullet resolves to — NOT the bullet count
    total: number;   // in-window commits, full stop (`commits.length`); `total - shown` is the gap
    notShown: { label: string; sha: string; subject: string }[];
  };
  /** Slice 1.5b (§3.5). Unit LABEL (normalised) -> the BARE anchored turn.
   *  ⚠ The BARE turn, never the framed line: the `— you wrote: "…"` frame is applied by
   *  `renderBriefing` via `transcripts/frame.ts`. This keeps G5's `verbatim` check a plain equality
   *  against `textSha` instead of requiring it to parse a frame back off, and keeps the app-owned
   *  frame out of the emittable set. */
  whys?: Record<string, string>;
};

export type TokenBudget = { maxChars: number };

/** Stable transport labels. The value `validateConfig` SYNTHESIZES into `provider.cli` when
 *  `provider.api` is present, so the frozen required triple stays `string`/`string[]`/union for all of
 *  this file's importers and no consumer ever sees `undefined`.
 *
 *  ⚠ NEITHER MAY EVER EQUAL `"claude"`. `claudeShaped` (harden.ts) is an exact, lower-cased,
 *  launcher-extension-stripped BASENAME check, and three gates fall the SAFE way for an API provider
 *  purely because it returns false for these two strings: the transcripts warning (core.ts), the
 *  transcript scan gate (core.ts), and `auditMayCarryRawTurn` (audit.ts). That is a load-bearing
 *  property of the LITERAL, not of any code, so it is pinned by a test rather than left to reading. */
export const API_LABEL_ANTHROPIC = "anthropic-api";
export const API_LABEL_OPENAI = "openai-compatible";

/** The API-transport block. PRESENCE selects the HTTP transport; it is MUTUALLY EXCLUSIVE with
 *  `cli`/`argv`/`promptVia` and `validateConfig` THROWS (naming every offending key) when both appear,
 *  because silently preferring one transport over the other makes "which credential did this spend"
 *  invisible state — the failure class that already cost this project weeks of mis-billed API credits.
 *
 *  KEY SOURCING is a four-rung, first-hit-wins ladder, and only CONFIGURED rungs are tried: there is no
 *  silent ambient-env fallback once the user has named a file or a command. See `src/apiKey.ts`.
 *  `apiKey` (literal plaintext) is supported, warns on every run, and `init` chmods the config to 0600
 *  when it writes one — refusing it outright only pushes people to a machine-wide `export`, which is
 *  the ambient-key pattern this project's README already warns about.
 *
 *  `harden`, `credential` and `accounts` DO NOT APPLY to an API provider: every one of them is a
 *  property of a spawned child process (injected argv, a withheld env var, a `CLAUDE_CONFIG_DIR`), and
 *  each is warned about rather than silently ignored. */
export type ProviderApi = {
  kind: "anthropic" | "openai-compatible";
  /** REQUIRED and deliberately never defaulted: a silently-chosen model changes briefing content
   *  without a config change, which is exactly the provenance failure EVAL.md rows exist to prevent. */
  model: string;
  /** Anthropic: defaults to `https://api.anthropic.com`; set it to front a gateway or proxy.
   *  openai-compatible: REQUIRED in practice (there is no universal default endpoint). */
  baseUrl?: string;
  /** Anthropic REQUIRES `max_tokens`, so an absent value means the built-in default. For the
   *  openai-compatible kind an absent value means the key is OMITTED from the body entirely — see
   *  `src/providers/openaiCompatible.ts` for why omission is the compatible superset. */
  maxTokens?: number;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  apiKeyCommand?: string[];
  apiKey?: string;
};

export interface Provider {
  generate(prompt: string): Promise<string>; // throws ProviderError on failure
}

// `usage-limit`: the CLI reported a subscription usage wall (weekly or session) with a reset time.
// PERMANENT for this run — retrying cannot succeed until the reset — so it bypasses BOTH withRetry's
// schedule and withHardeningLadder's rungs. See provider.ts for the classification rules (shape-gated,
// so a briefing that merely QUOTES a limit message is not mistaken for one).
export type ProviderErrorCode = "missing-binary" | "nonzero-exit" | "empty-output" | "timeout" | "usage-limit";

export class ProviderError extends Error {
  // `warnings`: pre-formatted, ready-to-print pipeline-warning strings (discIssues + warnings) carried
  // out by core.ts so the shell can still print them on a provider failure (T1 fix — see core.ts).
  // `net`: the net-gate outcome, likewise attached so the shell still prints the "waited…/calling
  // anyway (forced run)" diagnostic on a provider failure (the single most useful line when the
  // failure was network-caused). Both are set by runCore's catch, read by run()'s catch.
  net?: { online: boolean; waitedMs: number };
  // `durationMs`: how long the failing attempt took (C1/B6). Load-bearing, not diagnostic garnish —
  // `withRetry` sleeps 135s internally and passes nothing out, so an outer wrapper cannot time the final
  // attempt itself. Without this the ladder's "failed fast, so it smells like a usage error rather than a
  // network hiccup" trigger has no way to fire at all.
  durationMs?: number;
  /** True when the message may contain bytes from a stream that never reached EOF or that errored
   *  mid-read (C1). The B6 fast path refuses to latch `disableHardening` on such an error: its
   *  evidence is a rejection phrase found in output that is, by construction, possibly truncated —
   *  and the timing argument that used to cover this is FALSE for an errored sink, which resolves
   *  fast enough to pass the fail-fast gate. */
  partialRead?: boolean;
  /** `resetAt` (additive, Slice 2/A3): an ISO-8601 instant at which a `usage-limit` is expected to
   *  clear, supplied by a transport that KNOWS it — an HTTP `retry-after` header, or a spend-cap body
   *  that names the resume time. `core.ts` prefers it over `parseResetInstant(e.message, now)`, which
   *  text-matches an English CLI sentence and falls back to a one-hour probe mark when it cannot read
   *  one. The CLI path never sets this field, so its behaviour is byte-identical to before.
   *
   *  A field on the CLASS, exactly as `durationMs` and `partialRead` above are — NOT a sixth member of
   *  `ProviderErrorCode`, whose count is frozen at five and pinned by test/types.test.ts. */
  resetAt?: string;
  constructor(public code: ProviderErrorCode, message: string, public warnings?: string[]) {
    super(message);
    this.name = "ProviderError";
  }
}

export type Config = {
  repos?: string[];
  discoverRoots?: string[];
  excludeRepos?: string[]; // repos to drop from BOTH explicit `repos` and discovery — by absolute path or basename (e.g. a stale/work checkout you don't want in the briefing)
  author?: { names?: string[]; emails?: string[] };
  // `harden` (C1/B9, additive+optional per this file's frozen-contract rule): default TRUE. All-or-nothing —
  // a partial opt-out (re-enabling tools via `--tools default`) would silently drop ALL MCP servers, measured
  // 2 → 0, with no way for the user to decline. `false` also skips the capability probe entirely.
  // `credential` picks WHICH credential the spawned CLI may use, by controlling whether
  // `ANTHROPIC_API_KEY` is passed to it. "subscription" (the default, and what an omitted field
  // resolves to) withholds the key so the CLI uses its logged-in session; "env-api-key" passes
  // whatever is in the environment through. Default-on because the failure it prevents is silent
  // and costs money: an ambient key re-billed a subscription to API credits for weeks.
  // `accounts`: ordered failover list. Absent/empty ⇒ the CLI's own default login, i.e. today's behaviour
  // exactly (no CLAUDE_CONFIG_DIR is set). `label` is what limit marks are keyed by and must be unique;
  // `configDir` absent means "use the default login", which is how the primary is expressed without
  // rewriting a working setup. NEVER written to process.env — that variable also resolves the transcript
  // scan root (config.ts resolveTranscripts), so exporting it would silently blank transcript evidence.
  // `api` (Slice 2/A3, additive+optional): present ⇒ the briefing is generated over HTTP by one of the
  // two native transports instead of by spawning a CLI. See ProviderApi below for the whole contract.
  provider: { cli: string; argv: string[]; promptVia: "stdin" | "arg"; timeoutMs?: number; harden?: boolean; credential?: "subscription" | "env-api-key"; accounts?: { label: string; configDir?: string }[]; api?: ProviderApi };
  /** Extra argv for the AUDIT JUDGE only — the briefing generator never sees it.
   *
   *  ⚠ The judge is the INSTRUMENT; the briefing is what it measures. You want the instrument at
   *  least as sharp as the thing it grades, and the judge's findings have been the sharpest signal in
   *  this project's record (it caught the day-21 branch misframing, the day-22 self-referential
   *  blindness, and the suggestion duplication). Degrading it to save allowance is the worst trade
   *  available, so it gets its own knob rather than inheriting the generator's.
   *
   *  Typical use: `["--model", "opus"]` while `provider.argv` pins a cheaper model for the daily run.
   *  Appended AFTER `provider.argv`, so it wins on a repeated flag. */
  auditJudgeArgv?: string[]; // timeoutMs: per-provider-call timeout (default 120s) — raise for a slow local model / big multi-repo window
  tokenBudget?: TokenBudget;
  lookbackCapDays?: number;
  excludeCommitPatterns?: string[]; // subjects matching any (regex) are tagged `meta.excluded` as bot/auto noise (#3)
  subprojects?: { repo: string; roots: string[] }[]; // additive: per-repo project-root globs; [] = force single-unit despite a manifest
  morningTime?: string;              // additive: 24h "HH:MM" local floor; below it, scheduled runs no-op. Default "07:20".
  // Slice 1.5 (§3.6). `enabled` defaults FALSE — 1.5a is a dark launch. `root` overrides the
  // resolution order in resolveTranscripts(); omit it and the default `~/.claude/projects` applies,
  // which is REQUIRED rather than a convenience: initConfig returns early when a config already
  // exists (config.ts), so every existing install would otherwise have no root and the feature
  // would be inert with no diagnostic. Shape errors WARN and disable — never throw (B1 style).
  transcripts?: { enabled?: boolean; root?: string };
  networkProbeHosts?: { host: string; port: number }[]; // additive: TCP connectivity-probe targets; [] disables the gate (local/offline providers). Default anycast 1.1.1.1:443 / 8.8.8.8:443.
  /** Slice 4 T7 — the optional desktop notification. ADDITIVE-OPTIONAL, default `"off"`.
   *
   *  `"off"` (and an absent field) — the CLI story is the briefing file plus the terminal. This is the
   *  default because it is what the CLI can honestly deliver, and because it makes the GUI seam free:
   *  the desktop app posts its own native notification and has nothing to contend with.
   *  `"auto"` — best effort per OS: `osascript` on darwin, `notify-send` on linux, NOTHING on win32.
   *  `{ command: [...] }` — an explicit argv with `{title}`/`{body}`/`{path}` substituted into
   *  SEPARATE elements, never a shell string. This is what the self-hosted push recipe uses.
   *
   *  ⚠ The BODY is a fixed template (date + path) on every branch — never briefing text. See
   *  src/notify.ts. A malformed value degrades to "off" with a warning (B1 style); it never throws. */
  notify?: "off" | "auto" | { command: string[] };
  /** IN-2 (EVAL days 51/52) — the VERDICT-PATH MARKER. ADDITIVE-OPTIONAL, default OFF.
   *
   *  Repo-relative directory paths the operator rules VERDICT-PATH: work under them is gate-class
   *  (a human signs off), so a suggestion citing a commit that touches one renders with a marker line
   *  saying so. The line states what the key established — a cited commit touches a configured path —
   *  and never classifies the work itself (render.ts `VERDICT_MARKER_TEXT`). Day 52's judge: the
   *  suggestion "is genuine and well-grounded; the framing is the defect".
   *
   *  Absent or `[]` ⇒ nothing is marked and the briefing is byte-identical to before IN-2. Which paths
   *  qualify is an OPERATOR RULING the tool cannot infer, so there is no default and none is seeded
   *  by `init`. The seed for this workspace's own quant guardrail would be
   *  `["quant_stocks/", "quant_options/"]` — written here as documentation, enabled nowhere.
   *
   *  Matched against each cited commit's diffstat paths in EVERY configured repo, as a directory
   *  prefix (`quant_stocks` matches `quant_stocks/x.py`, never `quant_stocks_old/x.py`),
   *  case-insensitively. Each entry is a LITERAL path relative to the ROOT of the configured repo —
   *  no globs (unlike `subprojects[].roots`, which does take them), no backslashes, and no repo-name
   *  prefix: in a repo `personal_code`, write `quant_stocks/`, not `personal_code/quant_stocks/`.
   *  A malformed value WARNS and disables the marker (`config.resolveVerdictPaths`) — it never throws,
   *  because an annotation must not cost the morning its briefing (B1 style, like `transcripts`). */
  verdictPaths?: string[];
  /** Tier B (Stage-2 recap campaigns, spec §4.8) — ADDITIVE-OPTIONAL, default OFF.
   *
   *  The documented shape is `{ mode: "off" | "trial" | "on" }`, but it is declared `unknown` ON
   *  PURPOSE and `validateConfig` does not look at it (unknown keys spread through, config.ts): the ONE
   *  reader is `config.resolveRecapCampaigns(raw)`, the `resolveVerdictPaths` pattern — absent
   *  (`undefined`/`null`) ⇒ `off` with no warning; anything that is not exactly that shape ⇒ `off` plus
   *  a warning that reaches the page; it never throws (Appendix D7). Typing it as the shape here would
   *  let a malformed value fail at the type boundary instead of degrading to `off` with a visible
   *  warning, which is the B1-style contract every optional key in this file keeps.
   *
   *  `off` ⇒ B does nothing and the briefing is byte-identical to before B existed. `trial` and `on`
   *  each spend one extra model call on a busy morning and widen the run lock's staleness bound
   *  (§4.9). New installs default to `off`; nothing is seeded by `init`. */
  recapCampaigns?: unknown;
};

/**
 * One piece of TODAY's work handed to the model as suppress-context, and the unit of comparison for
 * `postcheck`'s freshness check. Built in `core.ts` from same-day activities AND same-day merges.
 *
 * ⚠ Named here because this shape was spelled INLINE in four places — `Meta`, `buildDoneBlock`,
 * `buildPrompt` and `core.ts`'s builder — while `postcheck` declared a named copy. Four spellings of
 * one contract is how the two sides drift, which is the same class of defect that put a divergent
 * `norm` in `postcheck` (see `subprojects.ts`).
 *
 * `subject` is the RAW, untruncated commit subject (or `Merged #N (branch)` for a merge). The prompt
 * shows a `STAGE1_TEXT_CAP`-sliced copy, so anything matching against it must consider both forms.
 */
export type DoneItem = { label: string; subject: string; whenMs: number };
