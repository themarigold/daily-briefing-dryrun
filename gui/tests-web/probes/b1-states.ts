/**
 * Briefing redesign wave 2, B1-M6-T19 — the SEEDED STATES of the live git check, for the screenshot pass (both
 * themes, fixtures only: wave 1's OPEN-5 method) and for `deck-render.check.ts`'s B1 renders, which draw these same
 * states, so a state the screenshots show is one a test has drawn.
 *
 * Each state is a briefing page (rendered by the engine's own `renderBriefing`, read-only import) and the
 * `GitDetailInput` Today would hold for it (`git-live.ts`'s state, with `os`): pass both to `deckView` and render
 * `DeckOrClassic`, as `deck-render.check.ts`'s `gitHtml` does.
 *
 * ⚠ FIXTURES ONLY. No repo, no Rust, no engine run, no clock: every time is a fixed local wall time on the page's
 * day. It reads and writes nothing (`tests-web/probes/`: outside `bun run test`'s one-level glob, a `.ts` with
 * static imports only, nothing reaching the scheduler installer; `coexistence.check.ts` and
 * `test/schedule.install.test.ts` scan it).
 *
 * The reply builders mirror `git-detail.check.ts`'s (`all`, `label`, `repo`); they are test fixtures, kept here so
 * the screenshot pass can import them without importing a check file.
 */
import { renderBriefing } from "../../../src/render";
import type { BriefingStruct as EngineStruct } from "../../../src/types";

import { mergeReply, type GitDetailInput, type GitHeld, type LabelView, type ReplyRow, type ReposAllReply, type ReposIpcReply, type RepoView } from "../../src/lib/git-detail";
import type { Os } from "../../src/lib/platform";

/** The page's date in every state: a Friday. */
export const B1_TODAY = "2026-10-16";
/** 10:00 local on that day: the deck's clock in every state. */
export const B1_NOW = new Date(2026, 9, 16, 10, 0).getTime();

/** A local wall time on the page's day, as the engine's ISO `checkedAt` carries it. */
export const at = (h: number, m: number, d = 16): string => new Date(2026, 9, d, h, m).toISOString();

/** A full 40-character SHA beginning with the page's 7-character token. */
export const sha = (token: string): string => (token + "0".repeat(40)).slice(0, 40);

export const page = (s: Partial<EngineStruct> = {}, date = B1_TODAY): string =>
  renderBriefing({ date, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [], ...s });

/** A full `all` reply with every field empty, then the parts given. */
export function all(p: Partial<ReposAllReply> = {}, extra: { gate?: "ran" | "held"; unknownRepos?: string[]; uncommittedAt?: string } = {}): ReposIpcReply {
  const checkedAt = p.checkedAt ?? at(9, 10);
  return {
    schemaVersion: 1,
    scope: "all",
    checkedAt,
    record: { accepted: false, windowStartUtc: null },
    windowStartUtc: null,
    repoViews: [],
    labels: [],
    branchLines: [],
    pushCards: [],
    actions: [],
    tile: { commits: 0, branches: 0 },
    hidden: { complete: false, perLabel: {} },
    ...p,
    gate: extra.gate ?? "ran",
    heldAt: 1_760_000_000,
    uncommittedAt: extra.uncommittedAt ?? checkedAt,
    unknownRepos: extra.unknownRepos ?? [],
  };
}

/** One card's answer: its rows, with the PR numbers and the "only here" count the engine derives from them. */
export const label = (key: string, repoKey: string | null, rows: ReplyRow[], o: Partial<LabelView> = {}): LabelView => ({
  key,
  repoKey,
  state: "ok",
  rows,
  notMatched: 0,
  prNumbers: [...new Set(rows.flatMap((r) => (r.kind === "pr" ? [r.number] : [])))].sort((a, b) => a - b),
  onlyHere: rows.reduce((n, r) => n + ((r.kind === "branch" || r.kind === "default") && r.push !== null ? r.push.notPushed : 0), 0),
  ...o,
});

/** One repo's view: `ok` with its "Not committed" count, or `unknown` (a timed-out check). */
export const repo = (key: string, o: { noRemote?: boolean; count?: number | null; name?: string; unknown?: boolean } = {}): RepoView =>
  o.unknown === true
    ? { key, name: o.name ?? key, state: "unknown", reason: "timeout", noRemote: false, uncommitted: { unknown: true }, storeKey: null, treeKey: null }
    : { key, name: o.name ?? key, state: "ok", noRemote: o.noRemote ?? false, uncommitted: o.count === null ? { unknown: true } : { count: o.count ?? 0 }, storeKey: `s-${key}`, treeKey: `t-${key}` };

/** A commit the page cites (by its 7-character token). */
export const cited = (token: string) => ({ sha: sha(token), token });

export function held(r: ReposIpcReply, prev: GitHeld | null = null): GitHeld {
  const h = mergeReply(prev, r);
  if (h === null) throw new Error("expected a held reply");
  return h;
}

export const input = (h: GitHeld | null, o: Partial<GitDetailInput> = {}): GitDetailInput => ({ reply: h, fresh: true, os: "macos", greenSince: {}, ...o });

/* ── the page every state draws ──────────────────────────────────────────────────────────────────── */

/**
 * Today's page: an `app` card with four commits (a merged PR, a never-pushed branch, an unpushed commit on main and
 * one already pushed on a kept branch), a `lib` card with one commit on main, a resume card for each (app on its
 * branch with "Uncommitted changes: …"), and one page suggestion.
 */
export const B1_PAGE = page({
  recap: [
    { repo: "app", text: "merged the importer", evidence: "a1b2c3d" },
    { repo: "app", text: "started the kelly sizing spike", evidence: "b2c3d4e" },
    { repo: "app", text: "tidied the docs", evidence: "c3d4e5f" },
    { repo: "app", text: "pushed the parser fix", evidence: "e5f6a7b" },
    { repo: "lib", text: "fixed the loader", evidence: "d4e5f6a" },
  ],
  windowMerges: [{ repo: "app", text: "🔀 Merged #12 (feat/importer) (Oct 15)  (a1b2c3d)" }],
  branchState: [
    { repo: "app", text: "On branch spike/kelly (ahead 2, behind 1)" },
    { repo: "lib", text: "On branch main (ahead 0, behind 0)" },
  ],
  resume: [
    { repo: "app", text: "finish the sizing spike" },
    { repo: "app", text: "Uncommitted changes: a.ts, b.ts" },
    { repo: "lib", text: "release the loader" },
  ],
  suggestions: [{ repo: "lib", text: "review the loader fix" }],
});

/** The app card's rows: PR #12, the never-pushed spike, the partly pushed parser branch, main with nothing pushed. */
export const APP_ROWS: ReplyRow[] = [
  { kind: "pr", number: 12, title: "Importer for the bank exports", commits: [cited("a1b2c3d")] },
  { kind: "branch", name: "spike/kelly", push: { state: "never", notPushed: 1 }, commits: [cited("b2c3d4e")] },
  { kind: "branch", name: "fix/parser", push: { state: "partly", notPushed: 2 }, commits: [cited("e5f6a7b")] },
  { kind: "default", name: "main", push: { state: "never", notPushed: 1 }, commits: [cited("c3d4e5f")] },
];

/** APP_ROWS with every branch and main pushed (`pushed`), or with no push words at all (`none`: a repo with no remote). */
const appRows = (push: "pushed" | "none"): ReplyRow[] =>
  APP_ROWS.map((r) => (r.kind === "branch" || r.kind === "default" ? { ...r, push: push === "pushed" ? { state: "pushed", notPushed: 0 } : null } : r));

/** The reply for B1_PAGE: everything current, the record accepted (the window started yesterday). */
export function richReply(o: { checkedAt?: string; appCount?: number; libCount?: number } = {}): ReposIpcReply {
  return all({
    checkedAt: o.checkedAt ?? at(9, 10),
    record: { accepted: true, windowStartUtc: at(0, 0, 15) },
    windowStartUtc: at(0, 0, 15),
    repoViews: [repo("app", { count: o.appCount ?? 2 }), repo("lib", { count: o.libCount ?? 0 })],
    labels: [label("app", "app", APP_ROWS), label("lib", "lib", [{ kind: "default", name: "main", push: { state: "pushed", notPushed: 0 }, commits: [cited("d4e5f6a")] }])],
    branchLines: [{ key: "app", name: "spike/kelly", state: "live", notPushed: 1, neverPushed: true, behind: 1 }],
    // The branches in the engine's order: `src/repos/push.ts` sorts them by name (`byteCmp`).
    pushCards: [{ repoKey: "app", storeKey: "s-app", firstLabel: "app", repoName: "app", branches: [{ name: "fix/parser", commits: 2 }, { name: "spike/kelly", commits: 1 }], onDefault: { name: "main", commits: 1 } }],
    tile: { commits: 4, branches: 3 },
    hidden: { complete: true, perLabel: {} },
  });
}

/* ── the states ──────────────────────────────────────────────────────────────────────────────────── */

export interface B1State {
  /** What the screenshot shows, in a few words. */
  what: string;
  text: string;
  gitDetail: GitDetailInput;
  now: number;
}

const state = (what: string, gitDetail: GitDetailInput, o: { text?: string; now?: number } = {}): B1State => ({ what, text: o.text ?? B1_PAGE, gitDetail, now: o.now ?? B1_NOW });

/** Every state the screenshot pass covers, by name. */
export function b1States(os: Os = "macos"): Record<string, B1State> {
  const rich = held(richReply());
  return {
    beforeTheDetail: state("before the first reply: A's slides, unchanged", input(null, { os })),
    noResult: state("Rust holds nothing yet (noResult): A's slides, unchanged", input(mergeReply(null, { gate: "noResult", heldAt: null, uncommittedAt: null, unknownRepos: [] }), { os })),
    live: state("every part current: rows, the push card, the tiles, the mood line", input(rich, { os })),
    notCurrent: state("an IPC error after the reply: every part \"as of 09:10\" (the counts \"as of 09:14\")", input(held(all({ ...richReply(), checkedAt: at(9, 10) } as Partial<ReposAllReply>, { uncommittedAt: at(9, 14) })), { os, fresh: false })),
    pushedAndClean: state("the work pushed and committed since: green tiles, no push card, no Good-morning line", input(held(all({ ...(richReply() as ReposAllReply), pushCards: [], tile: { commits: 0, branches: 0 }, repoViews: [repo("app", { count: 0 }), repo("lib", { count: 0 })], labels: [label("app", "app", appRows("pushed")), (richReply() as ReposAllReply).labels[1]!], branchLines: [{ key: "app", name: "spike/kelly", state: "live", notPushed: 0, neverPushed: false, behind: 1 }] })), { os, greenSince: { onlyHere: B1_NOW - 60_000, "uncommitted:app": B1_NOW - 60_000 } })),
    manyDirty: state("five repos not committed: three tiles and \"+2 more repos not committed\"", input(held(all({ ...(richReply() as ReposAllReply), repoViews: ["app", "lib", "tool", "site", "notes"].map((k, i) => repo(k, { count: i + 1 })) })), { os })),
    noRemote: state("a repo with no remote: \"no remote\" in grey, no push card, no amber", input(held(all({ ...(richReply() as ReposAllReply), repoViews: [repo("app", { count: 0, noRemote: true }), repo("lib", { count: 0 })], labels: [label("app", "app", appRows("none")), (richReply() as ReposAllReply).labels[1]!], branchLines: [{ key: "app", name: "spike/kelly", state: "noRemote" }], pushCards: [], tile: { commits: 0, branches: 0 } })), { os })),
    unknownRepo: state("app's check timed out with nothing earlier: A's disclosure stays on its card", input(held(all({ ...(richReply() as ReposAllReply), repoViews: [repo("app", { unknown: true }), repo("lib", { count: 0 })], labels: [{ ...label("app", "app", []), state: "unknown" }, label("lib", "lib", [{ kind: "default", name: "main", push: { state: "pushed", notPushed: 0 }, commits: [cited("d4e5f6a")] }])], branchLines: [], pushCards: [], tile: { commits: 0, branches: 0 } })), { os })),
  };
}
