/**
 * The briefing redesign's B1 (wave-2 plan B1-M5): the webview's model of the live git check — the request it sends
 * (`reposRequest`), the reply it reads (`ReposIpcReply`, held through `mergeReply`), and everything the slides draw
 * from it (`gitDetailView`): the What-you-did rows and summary lines, the PR count, the window title, the "(+N more)"
 * rule, and (B1-M5-T15) the launchpad tiles, the push cards, Good morning's line and Where-you-left-off's words.
 *
 * ⚠ PURE. No I/O and no clock of its own: `now` is a parameter wherever a word depends on it (the green tiles,
 * [`launchpadTiles`]), and the "as of HH:MM" times are the reply's own. Every value is plain text for a text node.
 *
 * ⚠ THE REPLY TYPES ARE EXACTLY WHAT RUST LETS THROUGH (`gui/src-tauri/src/repos.rs`, `sanitize_reply`): each member
 * only in the object it belongs to, reason codes from a closed set, no path, no raw refname, no raw commit subject and
 * no error text. They MIRROR the engine's `ReposReply` (`src/repos/types.ts`); the webview never imports engine source
 * (`calendar-contract.ts`'s rule), and `tests-web/git-detail.check.ts` compiles the mirror against the engine's type.
 * The model reads nothing else, so a member the filter would drop is never drawn.
 *
 * ⚠ THE REQUEST NEVER HOLDS WHAT RUST REFUSES. Rust refuses the WHOLE request on one bad entry (B1-M4-T11), which
 * would turn every tick into an IPC error and switch B1 off for the page; so an entry that would break a rule is left
 * out here (that card keeps A's view). The six limits and the character rule are B1-M4-T11's, written once below and
 * pinned both ways through one shared fixture (`gui/src-tauri/tests/fixtures/repos-request-limits.json`).
 */
import {
  branchCounts,
  clockTime,
  lineTokens,
  longDate,
  moodLine,
  sentenceOf,
  subtitleOf,
  WORK_LABEL,
  type CardLine,
  type DeckPage,
  type MeetingTile,
  type ProjectCard,
  type ResumeCard,
  type Suggested,
} from "./deck";
import type { ReposStatusRequest } from "./engine";
import { hereWords, type Os } from "./platform";
import { localDate } from "./today";
import type { Kind } from "./ui/tag-kind";

/* ── the request (B1-M4-T11's rules) ──────────────────────────────────────────────────────────── */

/** At most this many cards (`engine::REPOS_MAX_LABELS`). */
export const REPOS_MAX_LABELS = 64;
/** At most this many Where-you-left-off branch entries (`engine::REPOS_MAX_BRANCHES`). */
export const REPOS_MAX_BRANCHES = 64;
/** A card key (and a branch entry's key) of at most this many Unicode scalar values (`engine::REPOS_KEY_MAX_SCALARS`). */
export const REPOS_KEY_MAX_SCALARS = 80;
/** At most this many tokens per card (`engine::REPOS_TOKENS_PER_LABEL`). */
export const REPOS_TOKENS_PER_LABEL = 512;
/** At most this many tokens in all (`engine::REPOS_TOKENS_TOTAL`). */
export const REPOS_TOKENS_TOTAL = 4096;
/** A branch name of at most this many UTF-8 bytes (`engine::REPOS_BRANCH_MAX_BYTES`). */
export const REPOS_BRANCH_MAX_BYTES = 255;

/** `engine::REFUSED_FORMAT_CHARACTERS`, as code-point ranges (inclusive). */
const REFUSED_FORMAT_RANGES: readonly (readonly [number, number])[] = [
  [0x00ad, 0x00ad],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xfff9, 0xfffb],
  [0xe0001, 0xe0001],
  [0xe0020, 0xe007f],
];

/** Rust's character rule for keys and branch names: `char::is_control(c) || engine::is_refused_format_character(c)`.
 *  `c` is one code point (an element of `[...s]`). */
export function isRefusedCharacter(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  if (cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f)) return true;
  return REFUSED_FORMAT_RANGES.some(([lo, hi]) => cp >= lo && cp <= hi);
}

/** A lone surrogate is not a scalar value: serde refuses the string, so the whole request would fail. */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

/** The label-key rule (a branch entry's key follows it too); `""`, the Other card, is admitted. */
function keyOk(key: string): boolean {
  if (LONE_SURROGATE.test(key)) return false;
  const chars = [...key];
  return chars.length <= REPOS_KEY_MAX_SCALARS && !chars.some(isRefusedCharacter);
}

/** A branch name: at most 255 UTF-8 BYTES (never `.length`, which counts UTF-16 units), no refused character. */
function branchNameOk(name: string): boolean {
  if (LONE_SURROGATE.test(name)) return false;
  return new TextEncoder().encode(name).length <= REPOS_BRANCH_MAX_BYTES && ![...name].some(isRefusedCharacter);
}

const TOKEN = /^[0-9a-f]{1,40}$/;

/** What the webview sends, before Today adds `reason` and `current`. */
export type GitRequest = Omit<ReposStatusRequest, "reason" | "current">;

/**
 * The request for `page`: one `{ key, tokens }` per What-you-did card in card order, its tokens from A's
 * `lineTokens` over the card's page lines (never its "Today so far" lines, never its 🔀 lines, which A keeps apart),
 * and one `{ key, name }` per Where-you-left-off card with a named branch. Inside every limit of B1-M4-T11: a card
 * whose key breaks the key rule is left out and its tokens count nowhere; the first 512 distinct tokens per card and
 * 4 096 in all, in card order; the first 64 cards and 64 branch entries.
 */
export function reposRequest(page: DeckPage): GitRequest {
  const labels: GitRequest["labels"] = [];
  let total = 0;
  for (const card of page.whatYouDid.cards) {
    if (labels.length === REPOS_MAX_LABELS) break;
    if (!keyOk(card.key)) continue;
    const own = [...new Set(card.lines.flatMap(lineTokens))].filter((t) => TOKEN.test(t)).slice(0, REPOS_TOKENS_PER_LABEL);
    const tokens = own.slice(0, Math.max(0, REPOS_TOKENS_TOTAL - total));
    total += tokens.length;
    labels.push({ key: card.key, tokens });
  }
  // Resume-only cards need the engine's explicit repoKey too (including cards with no branch).
  // Empty tokens ask for ownership without borrowing SHAs from outside What you did.
  for (const card of page.leftOff.cards) {
    if (labels.length === REPOS_MAX_LABELS) break;
    if (!keyOk(card.key) || labels.some((l) => l.key === card.key)) continue;
    labels.push({ key: card.key, tokens: [] });
  }
  const branches: GitRequest["branches"] = [];
  for (const card of page.leftOff.cards) {
    if (branches.length === REPOS_MAX_BRANCHES) break;
    if (card.branch === null || card.branch.kind !== "branch") continue;
    if (!keyOk(card.key) || !branchNameOk(card.branch.name)) continue;
    branches.push({ key: card.key, name: card.branch.name });
  }
  return { labels, branches, pageDate: page.pageDate };
}

/* ── the reply: the mirror of the engine's `ReposReply`, as `sanitize_reply` admits it ─────────── */

export type RepoUnknownReason =
  | "git-too-old"
  | "dubious-ownership"
  | "required-filter"
  | "partial-clone"
  | "elsewhere"
  | "timeout"
  | "budget"
  | "error";

export type Uncommitted = { count: number } | { unknown: true };

/** `storeKey` (the git common dir's hash: linked worktrees and a configured subdirectory share it) and `treeKey` (the
 *  working tree's hash: a configured subdirectory shares its checkout's) are path-free; null on an unknown view whose
 *  hardening did not answer. */
export type RepoView =
  | { key: string; name: string; state: "ok"; noRemote: boolean; uncommitted: Uncommitted; storeKey: string; treeKey: string }
  | {
      key: string;
      name: string;
      state: "unknown";
      reason: RepoUnknownReason;
      noRemote: false;
      uncommitted: Uncommitted;
      storeKey: string | null;
      treeKey: string | null;
    }
  | { key: ""; name: ""; state: "noRepos"; noRemote: false; uncommitted: { unknown: true } };

export type ReplyCommit = { sha: string; token: string } | { sha: string; token: null; subject: string };

export type PushWords = { state: "pushed" | "partly" | "never"; notPushed: number };

export type ReplyRow =
  | { kind: "pr"; number: number; title: string; commits: ReplyCommit[] }
  | { kind: "branch"; name: string; push: PushWords | null; commits: ReplyCommit[] }
  | { kind: "remoteBranch"; name: string; commits: ReplyCommit[] }
  | { kind: "default"; name: string; push: PushWords | null; commits: ReplyCommit[] }
  | { kind: "tag"; name: string; commits: ReplyCommit[] }
  | { kind: "detached"; commits: ReplyCommit[] }
  | { kind: "orphan"; commits: ReplyCommit[] };

export type LabelView = {
  key: string;
  repoKey: string | null;
  state: "ok" | "unknown";
  rows: ReplyRow[];
  notMatched: number;
  prNumbers: number[];
  onlyHere: number;
};

export type BranchLine =
  | { key: string; name: string; state: "live"; notPushed: number; neverPushed: boolean; behind: number }
  | { key: string; name: string; state: "missing" }
  | { key: string; name: string; state: "noRemote" };

/** One per store with work only on this machine, at the store's first readable checkout (`repoKey`). */
export type PushCard = {
  repoKey: string;
  storeKey: string;
  firstLabel: string | null;
  repoName: string;
  branches: { name: string; commits: number }[];
  onDefault: { name: string; commits: number } | null;
};

/** Rust-minted handles; independent mirror of the public engine contract. */
export type ActionCard = {
  repoKey: string;
  cardKind: "did" | "leftOff" | "push" | "tile";
  cardId: string;
  handles: {
    handle: string;
    target: "pr" | "branch" | "commit" | "compare" | "editor" | "copy";
    row: number | null;
    sha: string | null;
    project: string | null;
    label: string | null;
  }[];
};

/** The all document as it crosses: repos/actionFacts removed, actions added by Rust. */
export type ReposAllReply = {
  schemaVersion: 1;
  scope: "all";
  checkedAt: string;
  record: { accepted: boolean; windowStartUtc: string | null };
  windowStartUtc: string | null;
  repoViews: RepoView[];
  labels: LabelView[];
  branchLines: BranchLine[];
  pushCards: PushCard[];
  actions: ActionCard[];
  tile: { commits: number; branches: number };
  hidden: { complete: boolean; perLabel: Record<string, number> };
};

/**
 * `repos_status`'s answer (`repos::ReposIpcReply`): the held document with Rust's four fields — `gate` (`ran`, or
 * `held` when the gate kept it: still current), `heldAt` (Rust's epoch seconds when that check was decided),
 * `uncommittedAt` (the `checkedAt` its "Not committed" counts are as of) and `unknownRepos` (repo keys whose stat
 * errored: unknown over their last answer); or, with nothing held for the page, those four alone (`noResult`).
 */
export type ReposIpcReply =
  | (ReposAllReply & { gate: "ran" | "held"; heldAt: number; uncommittedAt: string; unknownRepos: string[] })
  | { gate: "noResult"; heldAt: null; uncommittedAt: null; unknownRepos: [] };

export type ReposHeldReply = Extract<ReposIpcReply, { gate: "ran" | "held" }>;

/** A record keyed by repo text (a card key can be `constructor` or `__proto__`): no prototype to reach. */
function dict<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}
const own = <T>(r: Readonly<Record<string, T>>, k: string): T | undefined => (Object.hasOwn(r, k) ? r[k] : undefined);

/**
 * What the model holds (B1 "as of HH:MM"): the reply to draw, and the time each part of it that is NOT CURRENT is as
 * of — by repo key, by card key, and for the "Not committed" counts, by repo key. Empty maps: every part current.
 */
export interface GitHeld {
  reply: ReposHeldReply;
  asOf: { repos: Record<string, string>; labels: Record<string, string>; uncommitted: Record<string, string> };
}

const contrib = (c: PushCard | undefined): { commits: number; branches: number } =>
  c === undefined
    ? { commits: 0, branches: 0 }
    : {
        commits: c.branches.reduce((n, b) => n + b.commits, 0) + (c.onDefault?.commits ?? 0),
        branches: c.branches.length + (c.onDefault !== null ? 1 : 0),
      };

/**
 * The next reply over what is held (B1 "as of HH:MM"). A repo `unknown` in `next`, or listed in `next.unknownRepos`,
 * keeps `prev`'s data for that repo and its cards (their rows, branch lines, push card, hidden counts and their share
 * of the tile), marked not current with `prev`'s time — the time of the result shown, which a repo unknown twice
 * keeps from the first time; but never a push card or tile share for a store `next` answers through another,
 * current checkout (final review 4, M1). An unknown "Not committed" count keeps `prev`'s count the same way.
 * Otherwise `next` wins. `noResult` (Rust holds nothing for this page yet) changes nothing.
 */
export function mergeReply(prev: GitHeld | null, next: ReposIpcReply): GitHeld | null {
  if (next.gate === "noResult") return prev;
  const p = prev?.reply ?? null;
  const asOf: GitHeld["asOf"] = { repos: dict(), labels: dict(), uncommitted: dict() };
  const stale = new Set([...next.repoViews.filter((v) => v.state === "unknown").map((v) => v.key), ...next.unknownRepos]);
  const prevRepoTime = (k: string): string => (prev === null ? next.checkedAt : (own(prev.asOf.repos, k) ?? prev.reply.checkedAt));
  const prevUncommittedTime = (k: string): string => (prev === null ? next.uncommittedAt : (own(prev.asOf.uncommitted, k) ?? prev.reply.uncommittedAt));

  /** The repos whose data is `prev`'s. */
  const fromPrev = new Set<string>();
  const repoViews = next.repoViews.map((v): RepoView => {
    const previous = p?.repoViews.find((x) => x.key === v.key);
    const old = previous?.state === "ok" ? previous : undefined;
    let out: RepoView = v;
    if (stale.has(v.key)) {
      if (old !== undefined) {
        fromPrev.add(v.key);
        asOf.repos[v.key] = prevRepoTime(v.key);
        out = old;
      } else {
        // With no earlier result, date the partial answer being shown (the reply's checkedAt).
        asOf.repos[v.key] = next.checkedAt;
      }
    }
    if (out.state === "noRepos") return out;
    // The "Not committed" count is its own check (the minute status): a count `next` has is current, kept view or not.
    if ("count" in v.uncommitted) return out === v ? out : ({ ...out, uncommitted: v.uncommitted } as RepoView);
    if (previous !== undefined && "count" in previous.uncommitted) {
      asOf.uncommitted[v.key] = prevUncommittedTime(v.key);
      return { ...out, uncommitted: previous.uncommitted } as RepoView;
    }
    return out;
  });

  const kept = new Set<string>();
  const labels = next.labels.map((l): LabelView => {
    // A null repoKey may combine several repos. The wire has no contributing-key list;
    // any unknown repo could own these rows, so conservatively retain and date the label.
    if (!((l.repoKey === null ? stale.size > 0 : stale.has(l.repoKey)) || l.state === "unknown")) return l;
    const old = p?.labels.find((x) => x.key === l.key && x.state === "ok");
    if (old !== undefined) {
      kept.add(l.key);
      asOf.labels[l.key] =
        own(prev!.asOf.labels, l.key) ?? (old.repoKey !== null ? own(prev!.asOf.repos, old.repoKey) : undefined) ?? prev!.reply.checkedAt;
      return old;
    }
    if (l.state === "ok") asOf.labels[l.key] = (l.repoKey !== null ? own(asOf.repos, l.repoKey) : undefined) ?? next.checkedAt;
    return l;
  });

  const branchLines = [
    ...next.branchLines.filter((b) => !kept.has(b.key)),
    ...[...kept].flatMap((k) => {
      const old = p?.branchLines.filter((b) => b.key === k) ?? [];
      return old.length > 0 ? old : next.branchLines.filter((b) => b.key === k);
    }),
  ];

  const labelIndex = (k: string | null): number => {
    const i = k === null ? -1 : next.labels.findIndex((l) => l.key === k);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  let tile = { ...next.tile };
  const cards = next.pushCards.filter((c) => !fromPrev.has(c.repoKey));
  // A store's push work is counted once, at one checkout, and that host moves when it cannot answer (a removed
  // linked worktree, a timeout). A store that `next` answers through a current checkout (an ok view, or its card)
  // keeps `next`'s answer: an old card or tile share of another checkout of it would count the same commits twice.
  const currentStores = new Set<string>([
    ...next.repoViews.flatMap((v) => (v.state === "ok" && !stale.has(v.key) ? [v.storeKey] : [])),
    ...cards.map((c) => c.storeKey),
  ]);
  for (const k of fromPrev) {
    const mine = next.pushCards.find((c) => c.repoKey === k);
    const old = p?.pushCards.find((c) => c.repoKey === k);
    const kept = p?.repoViews.find((x) => x.key === k);
    const store = old?.storeKey ?? (kept !== undefined && kept.state !== "noRepos" ? kept.storeKey : null);
    if (store !== null && currentStores.has(store)) {
      if (mine !== undefined) cards.push(mine);
      continue;
    }
    const a = contrib(mine);
    const b = contrib(old);
    tile = { commits: Math.max(0, tile.commits - a.commits + b.commits), branches: Math.max(0, tile.branches - a.branches + b.branches) };
    if (old !== undefined) cards.push(old);
  }
  const pushCards = cards
    .map((c, i) => ({ c, i }))
    .sort((x, y) => labelIndex(x.c.firstLabel) - labelIndex(y.c.firstLabel) || x.i - y.i)
    .map((x) => x.c);

  const perLabel = dict<number>();
  for (const [k, n] of Object.entries(next.hidden.perLabel)) perLabel[k] = n;
  for (const k of kept) {
    const n = p === null ? undefined : own(p.hidden.perLabel, k);
    if (n !== undefined) perLabel[k] = n;
  }
  const complete = next.hidden.complete && stale.size === 0 && kept.size === 0;

  // B2: only the next reply grants handles, and only for repos it answers as current. Rows kept above never
  // carry their former launch/copy authority with them (an empty next.actions also clears an invalidated hold).
  const currentRepos = new Set(next.repoViews.filter((v) => v.state === "ok" && !stale.has(v.key)).map((v) => v.key));
  const actions = next.actions.filter((card) => currentRepos.has(card.repoKey));
  return { reply: { ...next, repoViews, labels, branchLines, pushCards, actions, tile, hidden: { complete, perLabel } }, asOf };
}

/* ── the model's input and view ───────────────────────────────────────────────────────────────── */

/**
 * `DeckInput.gitDetail` (plan B1-M5-T14): what `git-live.ts` holds for today's page. `reply` is the held answer
 * (null before the first); `fresh` describes the full check; `uncommittedFresh` describes the status counts
 * (defaults to `fresh` for callers with one freshness flag). An IPC error marks both stale; a successful
 * status-only check refreshes only the counts, leaving push/group data stale until a full check succeeds.
 * `os` picks "on this Mac" or "on this computer" (`hereWords`); `greenSince` holds, per tile key, when that tile's
 * count reached zero (sampled when the reply was applied, R4-M4), so the model alone decides each green tile's life.
 */
export type GitDetailInput = { reply: GitHeld | null; fresh: boolean; uncommittedFresh?: boolean; os: Os; greenSince: Readonly<Record<string, number>> };

/** One part of a card's summary line. `grey` is "no remote"; `muted` the "N not matched" tail. */
export interface SummaryPart {
  text: string;
  tone: "plain" | "grey" | "muted";
}

/** A commit in a row: its short SHA and the lines it shows (the page's sentences; a not-shown or hidden subject muted). */
export interface GitCommit {
  /** The full SHA: B2's per-commit button is matched by this, since two commits can share a short one. */
  sha: string;
  short: string;
  lines: { text: string; muted: boolean }[];
}

/** One row (scheme 1, `tag-colors.html:32-36`). */
export interface GitRow {
  key: string;
  /** The status tag: its kind and the words it draws. */
  tag: { kind: Kind; label: string };
  /** The PR title or the branch name after the tag; null for the default row and the grey rows. */
  name: string | null;
  /** "N commits": the distinct commits the row lists. */
  count: string;
  /** The amber words: "N not pushed", "never pushed", or the default row's "not pushed". */
  amber: string | null;
  /** The row's right-hand words, "only on this Mac", for work no remote holds. */
  here: string | null;
  commits: GitCommit[];
}

/** A What-you-did card's detail: A's disclosure (`page`), or the rows. */
export type GitCard =
  | { key: string; mode: "page" }
  | {
      key: string;
      mode: "detail";
      /** Replaces A's "N commits ›" / "Details ›" button as the card's disclosure. */
      summary: SummaryPart[];
      rows: GitRow[];
      /** The page lines no row holds, drawn after the rows as A draws them; a heading with nothing left under it
       *  dropped, the rest shortened (polish §2, [`pileRest`]). */
      rest: CardLine[];
      /** "Merged: #…" for the 🔀 PRs no PR row holds; null when every one is a row. */
      restMerged: string | null;
      /** "as of HH:MM" when this card's answer is not current. */
      asOf: string | null;
    };

/** What the slides draw from the live git check (`DeckView`'s `git`). */
export interface GitDetailView {
  /** The What-you-did heading: the window title, or "What you did". */
  title: string;
  /** A's subtitle form with the section-rule PR count; the page's count before the detail. */
  subtitle: string;
  /** Good morning's "Your recent work:" line, the same way; null with nothing to count. */
  workLine: string | null;
  /** The subtitle disclosure's lines: A's coverage header, and "(+N more)" unless the rule drops it. */
  remainder: { header: string | null; more: string | null };
  /** One per What-you-did card, in the page's card order. */
  cards: GitCard[];
  /** The launchpad's git tiles before the clock is applied: [`launchpadTiles`] decides which show at `now`. */
  tiles: TileCandidate[];
  /** "Push your work" (U3): unnumbered, drawn before Suggested's `<ol>`; none on a stale page. */
  pushCards: PushCardView[];
  /** Good morning's live line, appended after the page's Needs-a-look lines; null with none (and on a stale page). */
  goodMorningLine: string | null;
  /** The live aggregate's held time, in the same words as the push tile; null when current or absent. */
  goodMorningAsOf: string | null;
  /** One per Where-you-left-off card, in the page's card order. */
  leftOff: LeftOffGit[];
}

/** A launchpad tile as the reply gives it: amber (`wait`) while its count is above zero; green (`done`) once it
 *  reached zero, from `greenSince` (when it did). */
export interface TileCandidate {
  key: string;
  state: "wait" | "done";
  label: string;
  value: string;
  /** "as of HH:MM" when its count is from a check that is not current (the tile is then dimmed). */
  asOf: string | null;
  /** For a green tile: when its count reached zero (`GitDetailInput.greenSince`). */
  greenSince: number | null;
  /** Full timestamp for comparing freshness across dates before formatting an overflow tile. */
  asOfAt: string | null;
}

/** A tile the launchpad draws. Colour is never the only signal: `label` says the state in words. */
export type GitTile = Omit<TileCandidate, "greenSince" | "asOfAt">;

/** What the launchpad draws at `now`. `waiting` counts the amber tiles shown or behind `more` (the mood line's). */
export interface LaunchpadTiles {
  tiles: GitTile[];
  /** "+N more repos not committed", past the cap of 3 Not-committed tiles; null with none. */
  more: string | null;
  /** Oldest stale count behind `more`, formatted as on the individual tiles. */
  moreAsOf: string | null;
  waiting: number;
}

/** "Push your work"'s why line (U3; `deck.html:138`). */
export const PUSH_WHY = "Not backed up anywhere yet";

/** One "Push your work" card. `pill` is the repo's first card's (What-you-did card order); with none, `name`. */
export interface PushCardView {
  key: string;
  pill: { label: string; slot: number | null } | null;
  name: string | null;
  text: string;
  why: string;
  asOf: string | null;
}

/** Where-you-left-off's live words for one card (D1). */
export interface LeftOffGit {
  key: string;
  /** The muted words beside the branch tag: "behind N" from a live line, else A's `branchCounts`. */
  counts: string[];
  /** The dashed amber tag beside the branch tag: "N not pushed" or "never pushed"; null when neither applies. */
  pushTag: string | null;
  /** "as of HH:MM" when the branch words are from a check that is not current; null with no words to date. */
  asOf: string | null;
  /** The "not committed" tag (`StatusTag kind="local"`): "N files not committed"; null with none. */
  uncommitted: string | null;
  uncommittedAsOf: string | null;
}

/** How long a green tile stays: it leaves at the first tick 5 minutes after it turned green (the S1 mockup). */
export const GREEN_MS = 5 * 60_000;
/** At most this many "Not committed" tiles; the rest are counted on one more line (proposed). */
export const UNCOMMITTED_TILE_CAP = 3;

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;
const asOfWords = (iso: string): string => `as of ${clockTime(Date.parse(iso))}`;

/** A card's "as of": its own time when not current; with `fresh: false`, every answer's own time. */
function cardTime(h: GitHeld, fresh: boolean, key: string): string | null {
  const t = own(h.asOf.labels, key);
  return t !== undefined ? t : fresh ? null : h.reply.checkedAt;
}

/** The text a page line shows inside a row: a NOT-shown line's subject (after its SHA), muted; else its sentence. */
function lineShown(line: CardLine): { text: string; muted: boolean } {
  if (line.kind === "notShown") return { text: line.text.slice(line.text.indexOf(" ") + 1), muted: true };
  return { text: sentenceOf(line.text), muted: false };
}

/** A page line's depth, from its marker (`•` 0, `◦` 1, `▪` 2): `CardLine.kind` carries it (polish §2). */
const DEPTH = { bullet: 0, nested: 1, nested2: 2 } as const;

/**
 * The card's page lines no row holds, drawn after the rows (polish §2, "Pile headings in an opened card"). A heading
 * (`CardLine.header`, never a text test) carries no SHA, so no row holds it: it is DROPPED when none of the non-heading
 * lines under it is left here, and otherwise SHORTENED to "{name} · {K} commits" ("· 1 commit"; the name alone when
 * K is 0; the text as written when it has no " — "). "Under it" is every following line of the card up to the next
 * line of the same or a shallower depth, so a nested heading that keeps lines keeps its parent. K is the number of
 * distinct counted tokens (`lineTokens`, the card count's rule) over those lines. Every NOT-shown line (a commit the
 * recap did not cover, or "(+N more)") is skipped when the span and K are measured, and kept as before when no row
 * holds it. A kept heading is a NEW line: the page's own objects, shared with A's flat list, are never changed.
 */
function pileRest(lines: readonly CardLine[], held: ReadonlySet<CardLine>): CardLine[] {
  const rest: CardLine[] = [];
  lines.forEach((line, i) => {
    if (held.has(line)) return;
    if (line.kind === "notShown" || !line.header) {
      rest.push(line);
      return;
    }
    const depth = DEPTH[line.kind];
    const tokens = new Set<string>();
    let left = 0;
    for (const x of lines.slice(i + 1)) {
      if (x.kind === "notShown") continue;
      if (DEPTH[x.kind] <= depth) break;
      if (x.header || held.has(x)) continue;
      left += 1;
      for (const t of lineTokens(x)) tokens.add(t);
    }
    if (left === 0) return;
    const at = line.text.indexOf(" — ");
    const name = at === -1 ? null : line.text.slice(0, at);
    const k = tokens.size;
    rest.push({ ...line, text: name === null ? line.text : k === 0 ? name : `${name} · ${plural(k, "commit", "commits")}` });
  });
  return rest;
}

function rowOf(row: ReplyRow, i: number, card: ProjectCard, tokens: string[][], os: Os, held: Set<CardLine>): GitRow {
  const seen = new Set<string>();
  const commits: GitCommit[] = [];
  for (const c of row.commits) {
    if (seen.has(c.sha)) continue;
    seen.add(c.sha);
    const attached = card.lines.filter((_, j) => tokens[j]!.some((t) => c.sha.startsWith(t)));
    for (const l of attached) held.add(l);
    commits.push({
      sha: c.sha,
      short: c.sha.slice(0, 7),
      lines: [...attached.map(lineShown), ...(c.token === null ? [{ text: c.subject, muted: true }] : [])],
    });
  }
  const count = plural(commits.length, "commit", "commits");
  const here = `only ${hereWords(os)}`;
  // "N not pushed" counts the window's unpushed commits: a partly pushed branch whose unpushed ones all predate the
  // window has no amber words (Where you left off's rule too).
  const partly = (p: PushWords): string | null => (p.notPushed > 0 ? `${p.notPushed} not pushed` : null);
  const base = { key: `${i}`, count, commits };
  switch (row.kind) {
    case "pr":
      return { ...base, tag: { kind: "merged", label: `PR #${row.number}` }, name: row.title, amber: null, here: null };
    case "branch": {
      const never = row.push?.state === "never";
      return {
        ...base,
        tag: { kind: never ? "local" : "branch", label: "branch" },
        name: row.name,
        amber: row.push === null || row.push.state === "pushed" ? null : never ? "never pushed" : partly(row.push),
        here: never ? here : null,
      };
    }
    case "remoteBranch":
      return { ...base, tag: { kind: "branch", label: "branch" }, name: row.name, amber: null, here: null };
    case "default": {
      const never = row.push?.state === "never";
      return {
        ...base,
        tag: { kind: never ? "local" : "main", label: row.name },
        name: null,
        amber: row.push === null || row.push.state === "pushed" ? null : never ? "not pushed" : partly(row.push),
        here: never ? here : null,
      };
    }
    case "tag":
      return { ...base, tag: { kind: "main", label: `tag ${row.name}` }, name: null, amber: null, here: null };
    case "detached":
      return { ...base, tag: { kind: "main", label: "detached HEAD" }, name: null, amber: null, here: null };
    case "orphan":
      return { ...base, tag: { kind: "main", label: "no longer on a branch" }, name: null, amber: null, here: null };
  }
}

/** The card rule's PR numbers: its PR rows' and its own 🔀 lines' (`card.merged`), distinct. */
function cardPrs(card: ProjectCard, rows: readonly ReplyRow[]): Set<number> {
  return new Set([...card.merged, ...rows.flatMap((r) => (r.kind === "pr" ? [r.number] : []))]);
}

function summaryOf(card: ProjectCard, l: LabelView, repo: RepoView | undefined, os: Os): SummaryPart[] {
  const parts: SummaryPart[] = [];
  const prs = cardPrs(card, l.rows).size;
  if (prs > 0) parts.push({ text: `${plural(prs, "PR", "PRs")} merged`, tone: "plain" });
  const branches = l.rows.filter((r) => r.kind === "branch" || r.kind === "remoteBranch").length;
  if (branches > 0) parts.push({ text: `${plural(branches, "branch", "branches")} in progress`, tone: "plain" });
  const onDefault = new Map<string, number>();
  for (const r of l.rows) if (r.kind === "default") onDefault.set(r.name, (onDefault.get(r.name) ?? 0) + new Set(r.commits.map((c) => c.sha)).size);
  for (const [name, n] of onDefault) if (n > 0) parts.push({ text: `${n} on ${name}`, tone: "plain" });
  if (l.onlyHere > 0) parts.push({ text: `${l.onlyHere} only ${hereWords(os)}`, tone: "plain" });
  if (repo !== undefined && repo.noRemote) parts.push({ text: "no remote", tone: "grey" });
  if (l.notMatched > 0) parts.push({ text: `${l.notMatched} not matched`, tone: "muted" });
  return parts;
}

/** Days since 1970-01-01 of a `YYYY-MM-DD`, by integer arithmetic (no zone can move it). */
function dayNumber(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/**
 * The window title (B1 "Hand-offs from A"), from the accepted record's window start in local dates, counted from the
 * page's date: "Yesterday"; "Since {weekday}" from 2 to 6 days; "Since {weekday} {day} {month}" from 7, with the
 * year when it is not `today`'s. "What you did" without an accepted record, and on a quiet page.
 */
function windowTitle(page: DeckPage, r: ReposHeldReply | null, today: string): string {
  if (r === null || !r.record.accepted || r.record.windowStartUtc === null || page.whatYouDid.quiet) return "What you did";
  const startMs = Date.parse(r.record.windowStartUtc);
  if (Number.isNaN(startMs)) return "What you did";
  const start = localDate(new Date(startMs));
  const days = dayNumber(page.pageDate) - dayNumber(start);
  if (days < 1) return "What you did";
  if (days === 1) return "Yesterday";
  const long = longDate(start);
  if (days <= 6) return `Since ${long.slice(0, long.indexOf(" "))}`;
  const year = start.slice(0, 4);
  return `Since ${long}${year !== today.slice(0, 4) ? ` ${year}` : ""}`;
}

/** The live check's view of `page` (plan B1-M5-T14). `today` is `DeckInput.today` (the title's "current year"). */
export function gitDetailView(page: DeckPage, input: GitDetailInput, today: string): GitDetailView {
  const w = page.whatYouDid;
  const h = input.reply;
  const r = h?.reply ?? null;
  let livePrs = 0;
  const cards = w.cards.map((card): GitCard => {
    const l = r?.labels.find((x) => x.key === card.key);
    if (h === null || r === null || l === undefined || l.state !== "ok" || (card.commits === 0 && !l.rows.some((row) => row.commits.some((c) => c.token === null)))) {
      livePrs += new Set(card.merged).size;
      return { key: card.key, mode: "page" };
    }
    const tokens = card.lines.map(lineTokens);
    const held = new Set<CardLine>();
    const rows = l.rows.map((row, i) => rowOf(row, i, card, tokens, input.os, held));
    const prRows = new Set(l.rows.flatMap((x) => (x.kind === "pr" ? [x.number] : [])));
    const restPrs = card.merged.filter((n) => !prRows.has(n));
    livePrs += cardPrs(card, l.rows).size;
    const t = cardTime(h, input.fresh, card.key);
    return {
      key: card.key,
      mode: "detail",
      summary: summaryOf(card, l, l.repoKey === null ? undefined : r.repoViews.find((v) => v.key === l.repoKey), input.os),
      rows,
      rest: pileRest(card.lines, held),
      restMerged: restPrs.length > 0 ? `Merged: ${restPrs.map((n) => `#${n}`).join(", ")}` : null,
      asOf: t === null ? null : asOfWords(t),
    };
  });
  const prs = r === null ? w.prs : livePrs;
  const subtitle = subtitleOf(w.projects, w.commits, prs);
  const hiddenCount = r === null ? 0 : Object.values(r.hidden.perLabel).reduce((n, x) => n + x, 0);
  const hiddenShown = r !== null && Object.entries(r.hidden.perLabel).every(([key, n]) => {
    if (n === 0) return true;
    if (!cards.some((c) => c.key === key && c.mode === "detail")) return false;
    const l = r.labels.find((l) => l.key === key);
    return new Set(l?.rows.flatMap((row) => row.commits.filter((c) => c.token === null).map((c) => c.sha))).size === n;
  });
  const dropMore = r !== null && r.hidden.complete && hiddenShown && w.remainder.more !== null && hiddenCount === w.remainder.moreCount;
  return {
    title: windowTitle(page, r, today),
    subtitle,
    workLine: w.projects > 0 || w.commits > 0 || prs > 0 ? `${WORK_LABEL} ${subtitle}` : null,
    remainder: { header: w.remainder.header, more: dropMore ? null : w.remainder.more },
    cards,
    tiles: h === null ? [] : tileCandidates(h, input),
    pushCards: h === null || page.stale ? [] : pushCardViews(page, h, input),
    goodMorningLine: r === null || page.stale || r.tile.commits === 0 ? null : goodMorningLine(r.tile.commits, input.os),
    goodMorningAsOf: h === null || r === null || page.stale || r.tile.commits === 0 ? null : asOfOrNull(pushTime(h, input.fresh)),
    leftOff: page.leftOff.cards.map((card) => leftOffOf(card, h, input.fresh, input.uncommittedFresh ?? input.fresh)),
  };
}

/* ── B1-M5-T15: the tiles, the mood line, the push cards, Good morning, Where you left off ──────── */

const asOfOrNull = (t: string | null | undefined): string | null => (t === null || t === undefined ? null : asOfWords(t));

/** The oldest of ISO times (they are all `toISOString`'s UTC form, so they sort as strings). */
const oldest = (ts: readonly string[]): string | null => (ts.length === 0 ? null : [...ts].sort()[0]!);

/** Freshness of the aggregate push count (amber tile, green tile and Good morning). A stale checkout whose store a
 *  current checkout answered does not date it: the store's push work is that current answer. */
function pushTime(h: GitHeld, fresh: boolean): string | null {
  const views = h.reply.repoViews;
  const current = new Set(views.flatMap((v) => (v.state === "ok" && own(h.asOf.repos, v.key) === undefined ? [v.storeKey] : [])));
  const times = views
    .filter((v) => v.state !== "noRepos" && !v.noRemote && own(h.asOf.repos, v.key) !== undefined && !(v.storeKey !== null && current.has(v.storeKey)))
    .map((v) => h.asOf.repos[v.key]!);
  return oldest(fresh ? times : [...times, h.reply.checkedAt]);
}

/** "Only on this Mac" (one tile) and "Not committed" (one per working tree, at its first repo in the reply's order:
 *  card order, then by path). */
function tileCandidates(h: GitHeld, input: GitDetailInput): TileCandidate[] {
  const r = h.reply;
  const out: TileCandidate[] = [];
  const pushAsOf = pushTime(h, input.fresh);
  if (r.tile.commits > 0) {
    out.push({
      key: "onlyHere",
      state: "wait",
      label: `Only ${hereWords(input.os)}`,
      value: `${plural(r.tile.commits, "commit", "commits")} on ${plural(r.tile.branches, "branch", "branches")}`,
      asOf: asOfOrNull(pushAsOf),
      asOfAt: pushAsOf,
      greenSince: null,
    });
  } else if (own(input.greenSince, "onlyHere") !== undefined && r.repoViews.every((v) => v.state === "ok" && !v.noRemote)) {
    // Proposed wording (the mockup's "All your work is on GitHub" names a host B1 does not know).
    out.push({ key: "onlyHere", state: "done", label: "✓ Pushed", value: "All your work is pushed", asOf: asOfOrNull(pushAsOf), asOfAt: pushAsOf, greenSince: input.greenSince["onlyHere"]! });
  }
  // One tile per working tree: a configured subdirectory's status is its checkout's whole tree (final review 4, L2).
  // It sits at the tree's first view and is named from the view AT the tree's top level when the list has one and its
  // count is current, else from the tree's first view with a current count, else from the top-level view, else from
  // that first view (final review 5, L3; final review 6, L3: a count carried forward "as of" loses to a current one).
  // The engine hashes one real path into both keys (`pathKey`: "r" or "t" + 12 hex), so a top-level view's repo key
  // and tree key share their hex.
  type Counted = Exclude<RepoView, { state: "noRepos" }>;
  const inTree = new Map<string, Counted[]>();
  for (const v of r.repoViews) {
    if (v.state !== "noRepos" && v.treeKey !== null && "count" in v.uncommitted) inTree.set(v.treeKey, [...(inTree.get(v.treeKey) ?? []), v]);
  }
  const isCurrent = (v: Counted): boolean => own(h.asOf.uncommitted, v.key) === undefined;
  const trees = new Set<string>();
  for (const first of r.repoViews) {
    if (first.state === "noRepos" || !("count" in first.uncommitted)) continue;
    if (first.treeKey !== null) {
      if (trees.has(first.treeKey)) continue;
      trees.add(first.treeKey);
    }
    const views = first.treeKey !== null ? inTree.get(first.treeKey)! : [first];
    const top = views.find((x) => x.treeKey !== null && x.key.slice(1) === x.treeKey.slice(1));
    const v = (top !== undefined && isCurrent(top) ? top : views.find(isCurrent)) ?? top ?? first;
    if (!("count" in v.uncommitted)) continue; // never: `inTree` holds counted views only (narrows the type)
    const key = `uncommitted:${v.key}`;
    const n = v.uncommitted.count;
    const t = own(h.asOf.uncommitted, v.key) ?? ((input.uncommittedFresh ?? input.fresh) ? null : r.uncommittedAt);
    if (n > 0) {
      out.push({ key, state: "wait", label: "Not committed", value: `${plural(n, "file", "files")} in ${v.name}`, asOf: asOfOrNull(t), asOfAt: t, greenSince: null });
    } else if (own(input.greenSince, key) !== undefined) {
      out.push({ key, state: "done", label: "✓ Committed", value: `${v.name} is clean`, asOf: asOfOrNull(t), asOfAt: t, greenSince: input.greenSince[key]! });
    }
  }
  return out;
}

/**
 * The launchpad's heading (polish §6): "Before you start" while any amber ("waiting") tile shows, the ones past the
 * 3-tile cap included; "You're all set" otherwise, and with no detail. No clock: a green tile on its way out is `done`,
 * never `wait`. `slideHeadings` (the dots) and `Launchpad.svelte` (the drawn `<h2>`) both call it, so they cannot
 * disagree; an older page's live tiles count too.
 */
export function launchpadHeading(git: GitDetailView | null): string {
  return git?.tiles.some((t) => t.state === "wait") === true ? "Before you start" : "You're all set";
}

/**
 * The tiles the launchpad draws at `now` (plan B1-M5-T15): every amber tile, and each green one while
 * `now − greenSince < 5 min`, so it is gone from the first draw at or past it (Today's minute tick moves `now`).
 * "Only on this Mac" first, then at most 3 "Not committed" tiles and "+N more repos not committed" for the amber rest.
 * `now` is the deck's clock, passed to the slides (`DeckOrClassic`'s `now`); `deckView` never reads it (round-1 L4).
 */
export function launchpadTiles(git: GitDetailView | null, now: number): LaunchpadTiles {
  if (git === null) return { tiles: [], more: null, moreAsOf: null, waiting: 0 };
  const shown = git.tiles.filter((t) => t.state === "wait" || (t.greenSince !== null && now - t.greenSince < GREEN_MS));
  const strip = ({ greenSince: _drop, asOfAt: _time, ...t }: TileCandidate): GitTile => t;
  const onlyHere = shown.filter((t) => t.key === "onlyHere");
  const dirty = shown.filter((t) => t.key !== "onlyHere");
  const overflow = dirty.slice(UNCOMMITTED_TILE_CAP).filter((t) => t.state === "wait");
  const rest = overflow.length;
  return {
    tiles: [...onlyHere, ...dirty.slice(0, UNCOMMITTED_TILE_CAP)].map(strip),
    more: rest > 0 ? `+${rest} more ${rest === 1 ? "repo" : "repos"} not committed` : null,
    moreAsOf: asOfOrNull(oldest(overflow.flatMap((t) => t.asOfAt === null ? [] : [t.asOfAt]))),
    waiting: shown.filter((t) => t.state === "wait").length,
  };
}

/**
 * The launchpad's mood line (B1 "The launchpad"): A's meeting line wins; else "A couple of things are waiting." with
 * two or more amber tiles, "One thing is waiting." with one (proposed wording); green tiles never count; else A's
 * "Nothing needs you right now.". A's `moodLine` is unchanged and still decides the meeting and the quiet lines.
 */
export function liveMoodLine(tile: MeetingTile | null, gitTiles: LaunchpadTiles | null, calendarLine?: string | null): string {
  const waiting = gitTiles?.waiting ?? 0;
  if (tile !== null) return moodLine(tile);
  if (waiting > 0) return waiting >= 2 ? "A couple of things are waiting." : "One thing is waiting.";
  // PB-M4: on a live calendar day before a good read, the calendar's own line (Launchpad chooses it): never a free day.
  return calendarLine ?? moodLine(null);
}

/** "a", "a and b", "a, b and c". */
function listWords(parts: readonly string[]): string {
  return parts.length <= 1 ? (parts[0] ?? "") : `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]!}`;
}

function pushCardViews(page: DeckPage, h: GitHeld, input: GitDetailInput): PushCardView[] {
  const r = h.reply;
  const out: PushCardView[] = [];
  for (const c of r.pushCards) {
    const v = r.repoViews.find((x) => x.key === c.repoKey);
    if (v !== undefined && v.noRemote) continue;
    // Count first (polish §6): the branches as the engine sorts them, then the default branch, each "{count} on
    // {name}"; only the first part carries the noun ("3 commits on a, 2 on b and 1 on main").
    const shares = [
      ...c.branches.filter((b) => b.commits > 0),
      ...(c.onDefault !== null && c.onDefault.commits > 0 ? [c.onDefault] : []),
    ];
    const parts = shares.map((b, i) => `${i === 0 ? plural(b.commits, "commit", "commits") : b.commits} on ${b.name}`);
    const total = c.branches.reduce((n, b) => n + b.commits, 0) + (c.onDefault?.commits ?? 0);
    if (parts.length === 0 || total === 0) continue;
    const card = c.firstLabel === null || c.firstLabel === "" ? undefined : page.whatYouDid.cards.find((x) => x.key === c.firstLabel);
    const t = own(h.asOf.repos, c.repoKey) ?? (input.fresh ? null : r.checkedAt);
    out.push({
      key: `push:${c.repoKey}`,
      pill: card === undefined ? null : { label: card.label, slot: card.slot },
      name: card === undefined ? c.repoName : null,
      text: `Push your work: ${listWords(parts)} ${total === 1 ? "exists" : "exist"} only ${hereWords(input.os)}`,
      why: PUSH_WHY,
      asOf: asOfOrNull(t),
    });
  }
  return out;
}

function goodMorningLine(n: number, os: Os): string {
  return `${plural(n, "commit", "commits")} ${n === 1 ? "exists" : "exist"} only ${hereWords(os)}. See Suggested.`;
}

/** The engine's resume text for a dirty tree (`src/git.ts`): the names after it, joined with ", ". */
const UNCOMMITTED_PREFIX = "Uncommitted changes: ";

function leftOffOf(card: ResumeCard, h: GitHeld | null, fresh: boolean, uncommittedFresh: boolean): LeftOffGit {
  const r = h?.reply ?? null;
  const pageWords = card.branch === null ? [] : branchCounts(card.branch);
  const l = r?.labels.find((x) => x.key === card.key);
  // The branch words.
  let counts = pageWords;
  let pushTag: string | null = null;
  let asOf: string | null = null;
  if (h !== null && r !== null && card.branch !== null && card.branch.kind === "branch") {
    const line = r.branchLines.find((b) => b.key === card.key);
    if (line !== undefined && line.state === "live") {
      counts = line.behind > 0 ? [`behind ${line.behind}`] : [];
      pushTag = line.neverPushed ? "never pushed" : line.notPushed > 0 ? `${line.notPushed} not pushed` : null;
    }
    // Only words beside the tag are dated: with none, "as of" would date nothing (the screenshot pass's 05d).
    if (counts.length > 0 || pushTag !== null) asOf = asOfOrNull(own(h.asOf.labels, card.key) ?? (fresh ? null : r.checkedAt));
  }
  // The "not committed" tag: the card repo's live count, else the page's seed.
  const v = l?.repoKey === null || l === undefined ? undefined : r?.repoViews.find((x) => x.key === l.repoKey);
  let uncommitted: string | null;
  let uncommittedAsOf: string | null = null;
  if (h !== null && r !== null && v !== undefined && v.state !== "noRepos" && "count" in v.uncommitted) {
    const n = v.uncommitted.count;
    uncommitted = n > 0 ? `${plural(n, "file", "files")} not committed` : null;
    if (n > 0) uncommittedAsOf = asOfOrNull(own(h.asOf.uncommitted, v.key) ?? (uncommittedFresh ? null : r.uncommittedAt));
  } else {
    const seed = card.items.find((i) => i.startsWith(UNCOMMITTED_PREFIX));
    const n = seed === undefined ? 0 : seed.slice(UNCOMMITTED_PREFIX.length).split(", ").filter((x) => x !== "").length;
    uncommitted = n > 0 ? `${plural(n, "file", "files")} not committed` : null;
  }
  return { key: card.key, counts, pushTag, asOf, uncommitted, uncommittedAsOf };
}

/** Good morning's Needs-a-look tile shows with the page's lines or the live line, either alone (B1 "Good morning"). */
export function needsALookShown(needsALook: readonly string[], git: GitDetailView | null): boolean {
  return needsALook.length > 0 || (git?.goodMorningLine ?? null) !== null;
}

/** Suggested's "No suggestions in this briefing." line: only with neither a page suggestion nor a push card. */
export function noSuggestionsShown(suggested: Suggested, git: GitDetailView | null): boolean {
  return suggested.cards.length === 0 && (git?.pushCards.length ?? 0) === 0;
}
