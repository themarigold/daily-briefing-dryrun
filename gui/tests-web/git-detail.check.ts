/**
 * Briefing redesign wave 2, B1-M5 — the webview's git-detail model (`src/lib/git-detail.ts`): the request it sends,
 * the reply it reads, and every word, count and state the slides draw from it (plan B1-M5-T14, T15).
 *
 * ⚠ THE MODEL READS ONLY WHAT RUST LETS THROUGH. `repos.rs`'s `sanitize_reply` admits each member only in its own
 * object and drops everything else; `git-detail.ts`'s reply types are exactly that projection (the type probe below
 * compiles the mirror against the engine's own `ReposReply`), and a reply that still carried a dropped member (a
 * path, a raw refname, a raw commit subject, an error text) changes nothing the model gives (the runtime half).
 *
 * ⚠ PAGES ARE THE ENGINE'S. Each page is rendered by the engine's `renderBriefing` and mapped by A's `mapPage`, as
 * `deck.check.ts` does; only the request's limit cases build their cards by hand (no engine label can carry a bidi
 * control).
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ts from "typescript";

import { renderBriefing } from "../../src/render";
import type { BriefingStruct as EngineStruct } from "../../src/types";

import { renderMarkdown } from "../src/lib/briefing-md";
import { deckView, isCalendarDate, mapPage, moodLine, type DeckPage, type MeetingTile, type ProjectCard, type ResumeCard } from "../src/lib/deck";
import {
  gitDetailView,
  isRefusedCharacter,
  launchpadHeading,
  launchpadTiles,
  liveMoodLine,
  mergeReply,
  needsALookShown,
  noSuggestionsShown,
  PUSH_WHY,
  reposRequest,
  REPOS_BRANCH_MAX_BYTES,
  REPOS_KEY_MAX_SCALARS,
  REPOS_MAX_BRANCHES,
  REPOS_MAX_LABELS,
  REPOS_TOKENS_PER_LABEL,
  REPOS_TOKENS_TOTAL,
  type GitDetailInput,
  type GitHeld,
  type LabelView,
  type ReposAllReply,
  type ReposIpcReply,
  type ReplyRow,
} from "../src/lib/git-detail";
import { todayModel } from "../src/lib/today";
import { reposStatus } from "../../src/repos/status";
import { g, isolatedGit, newRepo, withGit, commitAt, scratch } from "../../test/fixtures/repos-fixtures";

const TODAY = "2026-10-16"; // a Friday

const page = (s: Partial<EngineStruct> = {}, date = TODAY): string =>
  renderBriefing({ date, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [], ...s });

function mapped(text: string, today = TODAY): DeckPage {
  const r = mapPage(renderMarkdown(text), today);
  if (!r.ok) throw new Error(`expected the page to map, got ${r.reason}: ${r.line}`);
  return r.page;
}

/** A local wall time on the page's day, as the engine's ISO `checkedAt` carries it. */
const at = (h: number, m: number, d = 16): string => new Date(2026, 9, d, h, m).toISOString();

const SHA = (c: string): string => c.repeat(40).slice(0, 40);

/** A full `all` reply with every field empty, then the parts given. */
function all(p: Partial<ReposAllReply> = {}, extra: { gate?: "ran" | "held"; unknownRepos?: string[]; uncommittedAt?: string } = {}): ReposIpcReply {
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

const NO_RESULT: ReposIpcReply = { gate: "noResult", heldAt: null, uncommittedAt: null, unknownRepos: [] };

test("aggregate pushed success requires every repo known, including one with no earlier result", () => {
  const p = mapped(page({ recap: [{ repo: "app", text: "work", evidence: "a1b2c3d" }] }));
  const unknown = { key: "r2", name: "other", state: "unknown" as const, reason: "error" as const, noRemote: false as const, uncommitted: { unknown: true as const }, storeKey: null, treeKey: null };
  const before = held(all({ repoViews: [view("r1"), unknown], tile: { commits: 1, branches: 1 } }));
  const after = held(all({ repoViews: [view("r1"), unknown], tile: { commits: 0, branches: 0 } }), before);
  const tiles = gitDetailView(p, input(after, { greenSince: { onlyHere: 1 } }), TODAY).tiles;
  expect(tiles.some((t) => t.key === "onlyHere")).toBe(false);
  const recovered = held(all({ repoViews: [view("r1"), view("r2")] }), after);
  expect(gitDetailView(p, input(recovered, { greenSince: { onlyHere: 1 } }), TODAY).tiles.find((t) => t.key === "onlyHere")?.value).toBe("All your work is pushed");
});

const label = (key: string, repoKey: string | null, rows: ReplyRow[], o: Partial<LabelView> = {}): LabelView => ({
  key,
  repoKey,
  state: "ok",
  rows,
  notMatched: 0,
  prNumbers: [...new Set(rows.flatMap((r) => (r.kind === "pr" ? [r.number] : [])))].sort((a, b) => a - b),
  onlyHere: rows.reduce((n, r) => n + ((r.kind === "branch" || r.kind === "default") && r.push !== null ? r.push.notPushed : 0), 0),
  ...o,
});

/** A repo view; each repo its own store and its own working tree unless `store` / `tree` say otherwise. */
const view = (key: string, o: { noRemote?: boolean; count?: number | null; name?: string; unknown?: boolean; store?: string; tree?: string } = {}) =>
  o.unknown === true
    ? ({ key, name: o.name ?? key, state: "unknown", reason: "timeout", noRemote: false, uncommitted: { unknown: true }, storeKey: o.store ?? null, treeKey: o.tree ?? null } as const)
    : ({ key, name: o.name ?? key, state: "ok", noRemote: o.noRemote ?? false, uncommitted: o.count === null ? { unknown: true } : { count: o.count ?? 0 }, storeKey: o.store ?? `s-${key}`, treeKey: o.tree ?? `t-${key}` } as const);

const held = (r: ReposIpcReply, prev: GitHeld | null = null): GitHeld => {
  const h = mergeReply(prev, r);
  if (h === null) throw new Error("expected a held reply");
  return h;
};

const input = (h: GitHeld | null, o: Partial<GitDetailInput> = {}): GitDetailInput => ({ reply: h, fresh: true, os: "macos", greenSince: {}, ...o });

/** Today's page with one app card: two commits on a branch and one on main. */
const APP = page({
  recap: [
    { repo: "app", text: "shipped the importer", evidence: "a1b2c3d" },
    { repo: "app", text: "fixed the parser", evidence: "b2c3d4e" },
    { repo: "app", text: "tidied the docs", evidence: "c3d4e5f" },
  ],
});

/* ── B1-M5-T14: the request ─────────────────────────────────────────────────────────────────────── */

describe("reposRequest: what the webview sends", () => {
  test("one entry per What-you-did card, in card order, with its page lines' tokens; never a \"Today so far\" SHA or a 🔀 line", () => {
    const text = page({
      recap: [
        { repo: "app", text: "shipped the importer", evidence: "a1b2c3d, b2c3d4e" },
        { repo: "lib", text: "fixed two parser bugs", evidence: "c3d4e5f" },
        { repo: "", text: "an unlabelled one", evidence: "d4e5f6a" },
      ],
      windowMerges: [{ repo: "app", text: "🔀 Merged #12 (feat/x) (Oct 14)  (9f8e7d6)" }],
      today: [{ repo: "app", text: "a commit made this morning  (e5f6a7b)" }],
    } as Partial<EngineStruct>);
    expect(text).toContain("9f8e7d6"); // PREMISE: the 🔀 line and the Today-so-far line are on the page
    expect(text).toContain("e5f6a7b");
    const p = mapped(text);
    const r = reposRequest(p);
    expect(r.pageDate).toBe(TODAY);
    expect(r.labels).toEqual([
      { key: "app", tokens: ["a1b2c3d", "b2c3d4e"] },
      { key: "lib", tokens: ["c3d4e5f"] },
      { key: "", tokens: ["d4e5f6a"] },
    ]);
    const sent = JSON.stringify(r);
    expect(sent).not.toContain("9f8e7d6");
    expect(sent).not.toContain("e5f6a7b");
  });

  test("a Where-you-left-off card with a named branch sends `{ key, name }`; a detached HEAD and a card with no branch send none", () => {
    const p = mapped(
      page({
        branchState: [
          { repo: "app", text: "On branch feat/deck (ahead 2, behind 1)" },
          { repo: "tool", text: "Detached HEAD at abc1234" },
        ],
        resume: [{ repo: "lib", text: "tag the release" }],
      }),
    );
    expect(reposRequest(p).branches).toEqual([{ key: "app", name: "feat/deck" }]);
  });

  test("P5-M9: one odd card never blanks the feature: every limit of B1-M4-T11 holds and every other card's tokens and branches are in it", () => {
    const base = mapped(APP);
    const hex = (i: number, width = 7): string => i.toString(16).padStart(width, "0");
    const card = (key: string, tokens: string[]): ProjectCard => ({
      key, label: key, slot: null, lines: tokens.map((t) => ({ kind: "bullet", text: `x  (${t})`, header: false })),
      mergedLines: [], todaySoFar: [], commits: tokens.length, merged: [], mergedRow: null, points: [], why: [],
    });
    const resume = (key: string, name: string): ResumeCard => ({ key, label: key, slot: null, items: [], branch: { kind: "branch", name, ahead: null, behind: null }, why: [] });
    const long81 = "k".repeat(81);
    const bidi = "evil‮name";
    const lone = "half\uD800surrogate";
    const many = Array.from({ length: 600 }, (_, i) => hex(0x1000000 + i));
    const cards: ProjectCard[] = [
      card(long81, ["aaaaaaa"]),
      card(bidi, ["bbbbbbb"]),
      card(lone, ["ccccccc"]),
      card("big", many.flatMap((t) => [t, t])),
      ...Array.from({ length: 70 }, (_, i) => card(`p${i}`, [hex(0x2000000 + i)])),
    ];
    const p: DeckPage = {
      ...base,
      whatYouDid: { ...base.whatYouDid, cards },
      leftOff: {
        empty: false,
        cards: [
          resume("ascii", "b".repeat(300)),
          resume("euro", "€".repeat(100)),
          resume("ok", "feat/fine"),
          resume(bidi, "feat/under-a-bad-key"),
          resume("ctl", "feat/a\u0007bell"),
          resume("fmt", "feat/​zero-width"),
          resume("max", "€".repeat(85)), // 255 bytes exactly
          ...Array.from({ length: 70 }, (_, i) => resume(`branch${i}`, `feat/${i}`)),
        ],
      },
    };
    expect([..."€".repeat(100)].length).toBe(100); // PREMISE: 100 UTF-16 units, 300 UTF-8 bytes
    expect(new TextEncoder().encode("€".repeat(100)).length).toBe(300);
    const r = reposRequest(p);
    // Inside every limit Rust enforces.
    expect(r.labels.length).toBeLessThanOrEqual(REPOS_MAX_LABELS);
    expect(r.branches.length).toBeLessThanOrEqual(REPOS_MAX_BRANCHES);
    for (const l of r.labels) {
      expect([...l.key].length).toBeLessThanOrEqual(REPOS_KEY_MAX_SCALARS);
      expect([...l.key].some(isRefusedCharacter)).toBe(false);
      expect(l.tokens.length).toBeLessThanOrEqual(REPOS_TOKENS_PER_LABEL);
      for (const t of l.tokens) expect(t).toMatch(/^[0-9a-f]{1,40}$/);
    }
    expect(r.labels.reduce((n, l) => n + l.tokens.length, 0)).toBeLessThanOrEqual(REPOS_TOKENS_TOTAL);
    for (const b of r.branches) {
      expect(new TextEncoder().encode(b.name).length).toBeLessThanOrEqual(REPOS_BRANCH_MAX_BYTES);
      expect([...b.name].some(isRefusedCharacter)).toBe(false);
      expect(b.key.isWellFormed()).toBe(true);
    }
    // The odd cards are left out; every other one is in, in card order, the first 64.
    const keys = r.labels.map((l) => l.key);
    expect(keys).not.toContain(long81);
    expect(keys).not.toContain(bidi);
    expect(keys).not.toContain(lone);
    expect(keys).toEqual(["big", ...Array.from({ length: 63 }, (_, i) => `p${i}`)]);
    expect(r.labels[0]!.tokens).toEqual(many.slice(0, 512));
    expect(r.labels[1]!.tokens).toEqual([hex(0x2000000)]);
    expect(r.branches).toEqual([
      { key: "ok", name: "feat/fine" },
      { key: "max", name: "€".repeat(85) },
      ...Array.from({ length: 62 }, (_, i) => ({ key: `branch${i}`, name: `feat/${i}` })),
    ]);
  });

  test("the 4 096-token total is applied in card order", () => {
    const base = mapped(APP);
    const cards: ProjectCard[] = Array.from({ length: 10 }, (_, c) => ({
      key: `c${c}`, label: `c${c}`, slot: null,
      lines: Array.from({ length: 500 }, (_, i) => ({ kind: "bullet" as const, text: `x  (${(c * 1000 + i + 0x1000000).toString(16)})`, header: false })).flatMap((l) => [l, l]),
      mergedLines: [], todaySoFar: [], commits: 500, merged: [], mergedRow: null, points: [], why: [],
    }));
    const r = reposRequest({ ...base, whatYouDid: { ...base.whatYouDid, cards } });
    expect(r.labels.map((l) => l.tokens.length)).toEqual([500, 500, 500, 500, 500, 500, 500, 500, 96, 0]);
    expect(r.labels.map((l) => l.tokens)).toEqual(Array.from({ length: 10 }, (_, c) =>
      Array.from({ length: c < 8 ? 500 : c === 8 ? 96 : 0 }, (_, i) => (c * 1000 + i + 0x1000000).toString(16))));
  });

  test("PC-M3: the six limits equal the shared fixture's, and the predicate classes every fixture character as Rust does", () => {
    const fx = JSON.parse(readFileSync(new URL("../src-tauri/tests/fixtures/repos-request-limits.json", import.meta.url), "utf8")) as {
      limits: Record<string, number>;
      chars: { cp: string; refused: boolean }[];
    };
    expect({ REPOS_MAX_LABELS, REPOS_MAX_BRANCHES, REPOS_KEY_MAX_SCALARS, REPOS_TOKENS_PER_LABEL, REPOS_TOKENS_TOTAL, REPOS_BRANCH_MAX_BYTES }).toEqual(
      fx.limits as never,
    );
    expect(fx.chars.length).toBeGreaterThan(40); // PREMISE: the fixture's edges are there
    for (const { cp, refused } of fx.chars) {
      const c = String.fromCodePoint(Number.parseInt(cp.slice(2), 16));
      expect({ cp, refused: isRefusedCharacter(c) }).toEqual({ cp, refused });
    }
  });
});

/* ── B1-M5-T14: mergeReply and `fresh` ──────────────────────────────────────────────────────────── */

const branchRow = (name: string, shas: string[], push: { state: "pushed" | "partly" | "never"; notPushed: number } | null = { state: "pushed", notPushed: 0 }): ReplyRow => ({
  kind: "branch", name, push, commits: shas.map((s) => ({ sha: SHA(s), token: s.repeat(7) })),
});
const defaultRow = (name: string, shas: string[], push: { state: "pushed" | "partly" | "never"; notPushed: number } | null = { state: "pushed", notPushed: 0 }): ReplyRow => ({
  kind: "default", name, push, commits: shas.map((s) => ({ sha: SHA(s), token: s.repeat(7) })),
});

describe("mergeReply: what is kept from the last answer", () => {
  const first = all({
    checkedAt: at(9, 0),
    repoViews: [view("r1", { count: 2 }), view("r2", { count: 1 })],
    labels: [label("app", "r1", [branchRow("feat/a", ["a"])]), label("lib", "r2", [defaultRow("main", ["b"])])],
    pushCards: [{ repoKey: "r1", storeKey: "s-r1", firstLabel: "app", repoName: "app", branches: [{ name: "feat/a", commits: 1 }], onDefault: null }],
    tile: { commits: 1, branches: 1 },
    branchLines: [{ key: "app", name: "feat/a", state: "live", notPushed: 1, neverPushed: false, behind: 0 }],
  });

  test("with no previous answer the reply is held as it is, every repo current", () => {
    const h = held(first);
    expect(h.reply.labels.map((l) => l.key)).toEqual(["app", "lib"]);
    expect(h.asOf).toEqual({ repos: {}, labels: {}, uncommitted: {} });
  });

  test("a repo `unknown` in the next reply keeps the previous data for it and its labels, marked not current with the previous time", () => {
    const next = all({
      checkedAt: at(9, 30),
      repoViews: [view("r1", { unknown: true }), view("r2", { count: 3 })],
      labels: [label("app", "r1", [], { state: "unknown" }), label("lib", "r2", [defaultRow("main", ["b", "c"])])],
      tile: { commits: 0, branches: 0 },
    });
    const h = held(next, held(first));
    expect(h.reply.repoViews).toEqual([view("r1", { count: 2 }), view("r2", { count: 3 })]);
    expect(h.reply.labels.find((l) => l.key === "app")!.rows).toEqual([branchRow("feat/a", ["a"])]);
    expect(h.reply.labels.find((l) => l.key === "lib")!.rows).toEqual([defaultRow("main", ["b", "c"])]);
    expect(h.reply.pushCards.map((c) => c.repoKey)).toEqual(["r1"]);
    // Its card's branch line comes back with it (the next reply has none for an unknown repo).
    expect(h.reply.branchLines).toEqual([{ key: "app", name: "feat/a", state: "live", notPushed: 1, neverPushed: false, behind: 0 }]);
    expect(h.reply.tile).toEqual({ commits: 1, branches: 1 }); // r1's card counted back in
    expect(h.asOf.repos).toEqual({ r1: at(9, 0) });
    expect(h.asOf.labels).toEqual({ app: at(9, 0) });
    // …and the "(+N more)" line can no longer be dropped.
    expect(h.reply.hidden.complete).toBe(false);
  });

  test("a repo listed in `unknownRepos` is kept the same way; a third answer still unknown keeps the FIRST time", () => {
    const second = all({ ...(first as ReposAllReply), checkedAt: at(9, 30) }, { unknownRepos: ["r1"] });
    const h2 = held(second, held(first));
    expect(h2.asOf.repos).toEqual({ r1: at(9, 0) });
    const third = all({ ...(first as ReposAllReply), checkedAt: at(9, 45), repoViews: [view("r1", { unknown: true }), view("r2", { count: 1 })] });
    expect(held(third, h2).asOf.repos).toEqual({ r1: at(9, 0) });
  });

  test("otherwise the next reply wins whole, and the repo is current again", () => {
    const back = all({ checkedAt: at(10, 0), repoViews: [view("r1", { count: 0 }), view("r2", { count: 0 })], labels: [label("app", "r1", []), label("lib", "r2", [])] });
    const h = held(back, held(all({ ...(first as ReposAllReply), checkedAt: at(9, 30) }, { unknownRepos: ["r1"] }), held(first)));
    expect(h.asOf).toEqual({ repos: {}, labels: {}, uncommitted: {} });
    expect(h.reply.labels.every((l) => l.rows.length === 0)).toBe(true);
  });

  test("an unknown \"Not committed\" count keeps the previous count, as of the previous `uncommittedAt`", () => {
    const a = all({ checkedAt: at(9, 0), repoViews: [view("r1", { count: 4 })] }, { uncommittedAt: at(9, 5) });
    const b = all({ checkedAt: at(9, 0), repoViews: [view("r1", { count: null })] }, { uncommittedAt: at(9, 6) });
    const h = held(b, held(a));
    expect(h.reply.repoViews[0]!.uncommitted).toEqual({ count: 4 });
    expect(h.asOf.uncommitted).toEqual({ r1: at(9, 5) });
  });

  test("`noResult` (Rust holds nothing for this page yet) changes nothing; with nothing held it holds nothing", () => {
    const h = held(first);
    expect(mergeReply(h, NO_RESULT)).toBe(h);
    expect(mergeReply(null, NO_RESULT)).toBeNull();
  });
});

describe("`fresh: false` (R3-M8): the held answer marked not current", () => {
  const p = mapped(APP);
  const r = all(
    { checkedAt: at(9, 10), repoViews: [view("r1", { count: 2 })], labels: [label("app", "r1", [branchRow("feat/a", ["a"])])] },
    { uncommittedAt: at(9, 14) },
  );
  const card = (fresh: boolean) => {
    const g = gitDetailView(p, input(held(r), { fresh }), TODAY);
    const c = g.cards.find((x) => x.key === "app")!;
    if (c.mode !== "detail") throw new Error("expected the detail");
    return c;
  };

  test("the card's summary line says \"as of 09:10\"; with `fresh: true` it does not (a case that fails if the flag is ignored either way)", () => {
    expect(card(false).asOf).toBe("as of 09:10");
    expect(card(true).asOf).toBeNull();
  });
});

/* ── B1-M5-T14: lines attached to commits (E1), the card's mode, what no row holds ──────────────── */

describe("the rows of a card: lines attached to commits by SHA prefix", () => {
  const text = page({
    recap: [
      { repo: "app", text: "shipped the importer", evidence: "a1b2c3d" },
      { repo: "app", text: "split the job across two commits", evidence: "b2c3d4e, c3d4e5f" },
      { repo: "app", text: "a short cite", evidence: "d4e5f" },
      { repo: "app", text: "nobody holds this one", evidence: "9999999" },
    ],
    recapCoverage: { shown: 4, total: 7, notShown: [{ label: "app", sha: "e5f6a7b", subject: "tidy the readme" }] },
    windowMerges: [
      { repo: "app", text: "🔀 Merged #12 (feat/x) (Oct 14)  (9f8e7d6)" },
      { repo: "app", text: "🔀 Merged #13 (feat/y) (Oct 14)  (8e7d6c5)" },
    ],
  });
  const p = mapped(text);
  const full = (prefix: string): string => (prefix + "0".repeat(40)).slice(0, 40);
  const r = all({
    repoViews: [view("r1")],
    labels: [
      label("app", "r1", [
        { kind: "pr", number: 12, title: "the importer", commits: [{ sha: full("a1b2c3d"), token: "a1b2c3d" }, { sha: full("b2c3d4e"), token: "b2c3d4e" }] },
        branchRow("feat/z", []),
        {
          kind: "default",
          name: "main",
          push: { state: "pushed", notPushed: 0 },
          commits: [
            { sha: full("c3d4e5f"), token: "c3d4e5f" },
            { sha: full("d4e5f6a"), token: "d4e5f6a" },
            { sha: full("e5f6a7b"), token: "e5f6a7b" },
            { sha: full("f6a7b8c"), token: null, subject: "a hidden commit's subject" },
          ],
        },
      ]),
    ],
  });
  const g = gitDetailView(p, input(held(r)), TODAY);
  const c = g.cards.find((x) => x.key === "app")!;

  test("PREMISE: the page holds a 5-character cite, a NOT-shown line and two 🔀 PRs", () => {
    expect(text).toContain("(d4e5f)");
    expect(text).toContain("e5f6a7b tidy the readme");
    expect(p.whatYouDid.cards[0]!.merged).toEqual([12, 13]);
  });

  test("each commit carries its short SHA and the page's sentences for it, in page order; a line citing two SHAs shows in each row", () => {
    if (c.mode !== "detail") throw new Error("expected the detail");
    const pr = c.rows[0]!;
    expect(pr.commits.map((x) => [x.short, x.lines])).toEqual([
      ["a1b2c3d", [{ text: "shipped the importer", muted: false }]],
      ["b2c3d4e", [{ text: "split the job across two commits", muted: false }]],
    ]);
    const main = c.rows[2]!;
    expect(main.commits.map((x) => [x.short, x.lines])).toEqual([
      ["c3d4e5f", [{ text: "split the job across two commits", muted: false }]],
      // A 5-character token attaches its line (E1: 4- to 6-character tokens included).
      ["d4e5f6a", [{ text: "a short cite", muted: false }]],
      // A NOT-shown line shows its subject part, in grey.
      ["e5f6a7b", [{ text: "tidy the readme", muted: true }]],
      // A hidden commit shows its subject, in grey.
      ["f6a7b8c", [{ text: "a hidden commit's subject", muted: true }]],
    ]);
  });

  test("the lines no row holds, and the 🔀 PRs no PR row holds, are drawn after the rows as A draws them", () => {
    if (c.mode !== "detail") throw new Error("expected the detail");
    expect(c.rest.map((l) => l.text)).toEqual(["nobody holds this one  (9999999)"]);
    expect(c.restMerged).toBe("Merged: #13");
  });

  test("A's disclosure stays: with no reply, for a card whose repo answers unknown, and for a card with no SHA", () => {
    expect(gitDetailView(p, input(null), TODAY).cards.map((x) => x.mode)).toEqual(["page"]);
    const unknown = all({ repoViews: [view("r1", { unknown: true })], labels: [label("app", "r1", [], { state: "unknown" })] });
    expect(gitDetailView(p, input(held(unknown)), TODAY).cards.map((x) => x.mode)).toEqual(["page"]);
    const noSha = mapped(page({ recap: [{ repo: "app", text: "a bullet whose evidence was stripped" }] }));
    expect(noSha.whatYouDid.cards[0]!.commits).toBe(0); // PREMISE
    expect(gitDetailView(noSha, input(held(all({ labels: [label("app", "r1", [])] }))), TODAY).cards.map((x) => x.mode)).toEqual(["page"]);
  });
});

/* ── polish §2: pile headings in an opened card ────────────────────────────────────────────────── */

describe("polish §2: `rest` drops a heading whose commits all moved into rows and shortens the rest", () => {
  const FILE_WIDE = "src/a.ts — 2 of 5 commits touching it (grouped: Oct 14–15)";   // generator.ts, the widened file form
  const FILE = "src/b.ts — 3 commits (Oct 14–15)";                                // "X — N commits (dates)"
  const NAMING = "parser — 2 of 4 commits naming it (grouped: Oct 14)";            // generator.ts, the campaign form
  const CAMPAIGN = "the billing rewrite — 3 commits";                               // Tier B (recapCampaigns.ts)
  const GROUP = "invoices — 2 commits (Oct 14)";                                    // a group inside the campaign
  const ALL_HELD = "the docs pass — 2 commits";
  const ALL_HELD_GROUP = "guides — 2 commits (Oct 15)";
  const LOOSE = "loose ends";                                                       // a heading with no " — "
  const r = (text: string, evidence: string | undefined, o: { group?: string; campaign?: string } = {}) => ({ repo: "app", text, ...(evidence !== undefined ? { evidence } : {}), ...o });
  const text = page({
    recap: [
      r("a1", "a1b2c3d", { group: FILE_WIDE }),
      r("a2", "b2c3d4e", { group: FILE_WIDE }),
      r("b1", "c3d4e5f", { group: FILE }),
      r("b2 cites two", "d4e5f6a, 1234abc", { group: FILE }),
      r("b3 repeats b1's commit", "c3d4e5f", { group: FILE }),
      r("b4 cites none", undefined, { group: FILE }),
      r("p1 cites none", undefined, { group: NAMING }),
      r("p2", "e6f7a8b", { group: NAMING }),
      r("i1", "f7a8b9c", { campaign: CAMPAIGN, group: GROUP }),
      r("i2", "0a1b2c3", { campaign: CAMPAIGN, group: GROUP }),
      r("c1", "1b2c3d4", { campaign: CAMPAIGN }),
      r("g1", "2c3d4e5", { campaign: ALL_HELD, group: ALL_HELD_GROUP }),
      r("g2", "3d4e5f6", { campaign: ALL_HELD, group: ALL_HELD_GROUP }),
      r("l1", "4e5f6a7", { group: LOOSE }),
      r("flat", "5f6a7b8"),
    ],
    recapCoverage: { shown: 15, total: 18, notShown: [{ label: "app", sha: "e5f6a7b", subject: "tidy the readme" }] },
  });
  const full = (prefix: string): string => (prefix + "0".repeat(40)).slice(0, 40);
  const commit = (t: string) => ({ sha: full(t), token: t });
  // The rows hold a1, a2, p2, i1, c1, g1, g2 (and the NOT-shown e5f6a7b only in the second reply).
  const reply = (extra: string[] = []) =>
    all({
      repoViews: [view("r1")],
      labels: [
        label("app", "r1", [
          { kind: "pr", number: 12, title: "the importer", commits: ["a1b2c3d", "b2c3d4e", "e6f7a8b"].map(commit) },
          { kind: "default", name: "main", push: { state: "pushed", notPushed: 0 }, commits: ["f7a8b9c", "1b2c3d4", "2c3d4e5", "3d4e5f6", ...extra].map(commit) },
        ]),
      ],
    });
  const restOf = (p: DeckPage, h = held(reply())) => {
    const c = gitDetailView(p, input(h), TODAY).cards.find((x) => x.key === "app")!;
    if (c.mode !== "detail") throw new Error("expected the detail");
    return c.rest;
  };

  test("PREMISE: the page writes the four heading forms and the Tier-B nesting (campaign `bullet`, group `nested`, members `nested2`), marked by `header`", () => {
    const lines = mapped(text).whatYouDid.cards[0]!.lines;
    const heads = lines.filter((l) => l.header).map((l) => [l.kind, l.text]);
    expect(heads).toEqual([
      ["bullet", FILE_WIDE], ["bullet", FILE], ["bullet", NAMING], ["bullet", CAMPAIGN], ["nested", GROUP],
      ["bullet", ALL_HELD], ["nested", ALL_HELD_GROUP], ["bullet", LOOSE],
    ]);
    expect(lines.filter((l) => l.kind === "nested2").map((l) => l.text)).toEqual(["i1  (f7a8b9c)", "i2  (0a1b2c3)", "g1  (2c3d4e5)", "g2  (3d4e5f6)"]);
    expect(lines[0]).toEqual({ kind: "notShown", text: "e5f6a7b tidy the readme", header: false });
    expect(text).toContain("(+2 more)");   // the second NOT-shown form, in the subtitle's remainder, not on the card
  });

  test("each heading: dropped when empty, shortened to \"{name} · {K} commits\" when not; depth from `kind`", () => {
    expect(restOf(mapped(text)).map((l) => [l.kind, l.text, l.header])).toEqual([
      ["notShown", "e5f6a7b tidy the readme", false],   // kept as now: no row holds it
      // FILE_WIDE: a1 and a2 both moved into the PR row, so the heading is dropped.
      // FILE: c3d4e5f, d4e5f6a, 1234abc — a line with two SHAs counts 2, a repeated SHA once, a line with none 0.
      ["bullet", "src/b.ts · 3 commits", true],
      ["nested", "b1  (c3d4e5f)", false],
      ["nested", "b2 cites two  (d4e5f6a, 1234abc)", false],
      ["nested", "b3 repeats b1's commit  (c3d4e5f)", false],
      ["nested", "b4 cites none", false],
      // NAMING: only the line with no SHA is left, so K = 0 and the name stands alone.
      ["bullet", "parser", true],
      ["nested", "p1 cites none", false],
      // CAMPAIGN keeps its nested group (i2 is left) and is re-counted over its whole span: i2 only ("· 1 commit").
      ["bullet", "the billing rewrite · 1 commit", true],
      ["nested", "invoices · 1 commit", true],
      ["nested2", "i2  (0a1b2c3)", false],
      // ALL_HELD and its group: every commit moved into a row, both dropped.
      // LOOSE has no " — ": kept as written.
      ["bullet", LOOSE, true],
      ["nested", "l1  (4e5f6a7)", false],
      ["bullet", "flat  (5f6a7b8)", false],
    ]);
  });

  test("a NOT-shown line is never under a heading and never counted, in either form; held by a row it leaves `rest` as now", () => {
    // The page writes NOT-shown lines before the recap, so splice both forms into a heading's span by hand: the rule
    // must skip them when it measures the span and counts K, never close the span on them.
    const p = mapped(text);
    const card = p.whatYouDid.cards[0]!;
    const notShown = card.lines[0]!;
    const more = { kind: "notShown" as const, text: "(+2 more)", header: false };
    const at = card.lines.findIndex((l) => l.text === "i1  (f7a8b9c)");
    const spliced = [...card.lines.slice(1, at), notShown, more, ...card.lines.slice(at)];
    const p2: DeckPage = { ...p, whatYouDid: { ...p.whatYouDid, cards: [{ ...card, lines: spliced }] } };
    const rest = restOf(p2).map((l) => l.text);
    expect(rest.slice(rest.indexOf("the billing rewrite · 1 commit"), rest.indexOf("i2  (0a1b2c3)") + 1)).toEqual([
      "the billing rewrite · 1 commit", "invoices · 1 commit", "e5f6a7b tidy the readme", "(+2 more)", "i2  (0a1b2c3)",
    ]);
    // A heading whose only line left is a NOT-shown one is dropped: e5f6a7b and "(+2 more)" spliced under ALL_HELD.
    const g = card.lines.findIndex((l) => l.text === "g1  (2c3d4e5)");
    const underAllHeld = [...card.lines.slice(1, g), notShown, more, ...card.lines.slice(g)];
    expect(underAllHeld.slice(g - 3, g + 2).map((l) => l.text)).toEqual([ALL_HELD, ALL_HELD_GROUP, "e5f6a7b tidy the readme", "(+2 more)", "g1  (2c3d4e5)"]);   // PREMISE
    const p3: DeckPage = { ...p, whatYouDid: { ...p.whatYouDid, cards: [{ ...card, lines: underAllHeld }] } };
    const rest3 = restOf(p3).map((l) => l.text);
    expect(rest3).not.toContain(ALL_HELD);
    expect(rest3.some((t) => t.startsWith("the docs pass") || t.startsWith("guides"))).toBe(false);
    expect(rest3).toContain("e5f6a7b tidy the readme");
    expect(rest3).toContain("(+2 more)");
    // Held by a row (e5f6a7b in main's commits), the NOT-shown line leaves `rest`, as before.
    expect(restOf(mapped(text), held(reply(["e5f6a7b"]))).map((l) => l.text)).not.toContain("e5f6a7b tidy the readme");
  });

  test("\"· 1 commit\", K counted from `lineTokens` (lower-cased, `isCountedToken`-filtered)", () => {
    const G = "src/c.ts — 3 commits (Oct 14)";
    // ABCDEF1 and abcdef1 are one commit (a case-sensitive K would read 2); "added" is not a counted token.
    const one = mapped(page({ recap: [r("x1", "ABCDEF1", { group: G }), r("x2 says added", "added", { group: G }), r("x3", "abcdef1", { group: G })] }));
    const c = gitDetailView(one, input(held(all({ repoViews: [view("r1")], labels: [label("app", "r1", [branchRow("feat/z", [])])] }))), TODAY).cards[0]!;
    if (c.mode !== "detail") throw new Error("expected the detail");
    expect(c.rest.map((l) => l.text)).toEqual(["src/c.ts · 1 commit", "x1  (ABCDEF1)", "x2 says added  (added)", "x3  (abcdef1)"]);
  });

  test("a span ends on a SHALLOWER line too: an all-held group heading that is its campaign's last line is dropped, with its campaign, and the flat line after them is kept", () => {
    const C = "the release — 2 commits";
    const GRP = "notes — 2 commits (Oct 14)";
    const t = page({ recap: [r("n1", "a1b2c3d", { campaign: C, group: GRP }), r("n2", "b2c3d4e", { campaign: C, group: GRP }), r("flat after", "9a8b7c6")] });
    const p = mapped(t);
    // PREMISE: the group (◦) and its members (▪) are the campaign's last lines, and a flat • line follows directly.
    expect(p.whatYouDid.cards[0]!.lines.map((l) => [l.kind, l.text])).toEqual([
      ["bullet", C], ["nested", GRP], ["nested2", "n1  (a1b2c3d)"], ["nested2", "n2  (b2c3d4e)"], ["bullet", "flat after  (9a8b7c6)"],
    ]);
    const h = held(all({ repoViews: [view("r1")], labels: [label("app", "r1", [{ kind: "default", name: "main", push: { state: "pushed", notPushed: 0 }, commits: ["a1b2c3d", "b2c3d4e"].map(commit) }])] }));
    expect(restOf(p, h).map((l) => [l.kind, l.text, l.header])).toEqual([["bullet", "flat after  (9a8b7c6)", false]]);
  });

  test("the page's lines are untouched: the same objects with the same texts, a kept heading a NEW line", () => {
    const p = mapped(text);
    const lines = p.whatYouDid.cards[0]!.lines;
    const before = lines.map((l) => ({ ...l }));
    const same = [...lines];
    const rest = restOf(p);
    expect(p.whatYouDid.cards[0]!.lines).toEqual(before);
    expect(p.whatYouDid.cards[0]!.lines.every((l, i) => l === same[i])).toBe(true);
    for (const l of rest) expect({ text: l.text, pageObject: lines.includes(l) }).toEqual({ text: l.text, pageObject: !l.header });
  });

  test("A's flat list keeps the page's words: deckView's page lines are the engine's, only the detail's `rest` is shortened", () => {
    const model = todayModel({ snapshot: null, latest: { state: "loaded", file: { path: "/state/briefing-latest.md", text, bytes: text.length } }, lastRun: null, today: TODAY });
    const before = deckView({ model, today: TODAY, firstName: null });
    const after = deckView({ model, today: TODAY, firstName: null, gitDetail: input(held(reply())) });
    if (before.kind !== "slides" || after.kind !== "slides") throw new Error("expected slides");
    const words = (d: typeof after) => d.page.whatYouDid.cards[0]!.lines.filter((l) => l.header).map((l) => l.text);
    expect(words(before)).toEqual([FILE_WIDE, FILE, NAMING, CAMPAIGN, GROUP, ALL_HELD, ALL_HELD_GROUP, LOOSE]);
    expect(words(after)).toEqual(words(before));
    const c = after.git!.cards.find((x) => x.key === "app")!;
    if (c.mode !== "detail") throw new Error("expected the detail");
    expect(c.rest.filter((l) => l.header).map((l) => l.text)).toEqual(["src/b.ts · 3 commits", "parser", "the billing rewrite · 1 commit", "invoices · 1 commit", LOOSE]);
  });
});

/* ── B1-M5-T14: the rows' tags and words ───────────────────────────────────────────────────────── */

describe("the rows' tags, words and counts (scheme 1)", () => {
  const p = mapped(APP);
  const rowsOf = (rows: ReplyRow[], os: GitDetailInput["os"] = "macos") => {
    const c = gitDetailView(p, input(held(all({ repoViews: [view("r1")], labels: [label("app", "r1", rows)] })), { os }), TODAY).cards[0]!;
    if (c.mode !== "detail") throw new Error("expected the detail");
    return c.rows.map(({ tag, name, count, amber, here }) => ({ tag, name, count, amber, here }));
  };

  test("each row kind", () => {
    expect(
      rowsOf([
        { kind: "pr", number: 644, title: "Always-on server deploy", commits: [{ sha: SHA("a"), token: "a1b2c3d" }] },
        branchRow("research/m1-a", ["a", "b"]),
        branchRow("feat/live-card", ["c"], { state: "partly", notPushed: 3 }),
        branchRow("spike/kelly", ["d"], { state: "never", notPushed: 5 }),
        { kind: "remoteBranch", name: "origin/feat/old", commits: [{ sha: SHA("e"), token: "eeeeeee" }] },
        defaultRow("main", ["f", "9"], { state: "never", notPushed: 2 }),
        { kind: "tag", name: "v1.2", commits: [{ sha: SHA("1"), token: "1111111" }] },
        { kind: "detached", commits: [{ sha: SHA("2"), token: "2222222" }] },
        { kind: "orphan", commits: [{ sha: SHA("3"), token: "3333333" }] },
      ]),
    ).toEqual([
      { tag: { kind: "merged", label: "PR #644" }, name: "Always-on server deploy", count: "1 commit", amber: null, here: null },
      { tag: { kind: "branch", label: "branch" }, name: "research/m1-a", count: "2 commits", amber: null, here: null },
      { tag: { kind: "branch", label: "branch" }, name: "feat/live-card", count: "1 commit", amber: "3 not pushed", here: null },
      { tag: { kind: "local", label: "branch" }, name: "spike/kelly", count: "1 commit", amber: "never pushed", here: "only on this Mac" },
      { tag: { kind: "branch", label: "branch" }, name: "origin/feat/old", count: "1 commit", amber: null, here: null },
      // The default row with no pushed commit: tag "main", no name after it, "2 commits · not pushed" (tag-colors.html:36).
      { tag: { kind: "local", label: "main" }, name: null, count: "2 commits", amber: "not pushed", here: "only on this Mac" },
      { tag: { kind: "main", label: "tag v1.2" }, name: null, count: "1 commit", amber: null, here: null },
      { tag: { kind: "main", label: "detached HEAD" }, name: null, count: "1 commit", amber: null, here: null },
      { tag: { kind: "main", label: "no longer on a branch" }, name: null, count: "1 commit", amber: null, here: null },
    ]);
  });

  test("a pushed default row is the grey tag with its name; partly pushed adds the amber \"N not pushed\"; no remote has no push words", () => {
    expect(rowsOf([defaultRow("trunk", ["a"])])).toEqual([{ tag: { kind: "main", label: "trunk" }, name: null, count: "1 commit", amber: null, here: null }]);
    expect(rowsOf([defaultRow("main", ["a", "b"], { state: "partly", notPushed: 1 })])[0]!.amber).toBe("1 not pushed");
    expect(rowsOf([branchRow("feat/a", ["a"], null), defaultRow("main", ["b"], null)]).map((r) => [r.tag.kind, r.amber, r.here])).toEqual([
      ["branch", null, null],
      ["main", null, null],
    ]);
  });

  test("a row's count is its distinct commits", () => {
    const sq = { kind: "pr" as const, number: 7, title: "squash", commits: [{ sha: SHA("a"), token: "aaaaaaa" }, { sha: SHA("a"), token: "aaaaaaa" }, { sha: SHA("b"), token: "bbbbbbb" }] };
    expect(rowsOf([sq])[0]!.count).toBe("2 commits");
  });
});

/* ── B1-M5-T14: the summary line ───────────────────────────────────────────────────────────────── */

describe("the card's summary line", () => {
  const p = mapped(
    page({
      recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }],
      windowMerges: [{ repo: "app", text: "🔀 Merged #20 (feat/q) (Oct 14)  (9f8e7d6)" }],
    }),
  );
  const summary = (rows: ReplyRow[], o: { notMatched?: number; noRemote?: boolean; os?: GitDetailInput["os"] } = {}) => {
    const r = all({ repoViews: [view("r1", { noRemote: o.noRemote ?? false })], labels: [label("app", "r1", rows, { notMatched: o.notMatched ?? 0 })] });
    const c = gitDetailView(p, input(held(r), { os: o.os ?? "macos" }), TODAY).cards[0]!;
    if (c.mode !== "detail") throw new Error("expected the detail");
    return c.summary;
  };

  test("every part, with its plurals, only when non-zero, in the spec's order", () => {
    expect(
      summary([
        { kind: "pr", number: 1, title: "one", commits: [{ sha: SHA("a"), token: "aaaaaaa" }] },
        branchRow("feat/a", ["b"]),
        branchRow("feat/b", ["c"], { state: "partly", notPushed: 4 }),
        defaultRow("main", ["d", "e", "f"], { state: "partly", notPushed: 6 }),
      ]),
    ).toEqual([
      { text: "2 PRs merged", tone: "plain" }, // #1 from its row, #20 from the card's 🔀 line (the card rule)
      { text: "2 branches in progress", tone: "plain" },
      { text: "3 on main", tone: "plain" },
      { text: "10 only on this Mac", tone: "plain" },
    ]);
  });

  test("singulars; a remote-only branch is a branch in progress; the default part names the repo's default", () => {
    expect(summary([{ kind: "remoteBranch", name: "origin/x", commits: [{ sha: SHA("a"), token: "aaaaaaa" }] }, defaultRow("trunk", ["b"])])).toEqual([
      { text: "1 PR merged", tone: "plain" },
      { text: "1 branch in progress", tone: "plain" },
      { text: "1 on trunk", tone: "plain" },
    ]);
  });

  test("\"· no remote\" (grey) for a repo with none, then \"· N not matched\" (muted); tag, detached and orphan rows are not counted", () => {
    expect(summary([{ kind: "tag", name: "v1", commits: [{ sha: SHA("a"), token: "aaaaaaa" }] }], { noRemote: true, notMatched: 2 })).toEqual([
      { text: "1 PR merged", tone: "plain" },
      { text: "no remote", tone: "grey" },
      { text: "2 not matched", tone: "muted" },
    ]);
  });

  test("D6: off macOS the push part reads \"only on this computer\"", () => {
    expect(summary([branchRow("feat/a", ["a"], { state: "never", notPushed: 1 })], { os: "windows" }).at(-1)).toEqual({ text: "1 only on this computer", tone: "plain" });
  });
});

/* ── B1-M5-T14: the PR count (section rule), the subtitle and the work line ────────────────────── */

describe("the PR count: the section rule, in the subtitle and Good morning's work line", () => {
  const text = page({
    recap: [
      { repo: "app", text: "shipped", evidence: "a1b2c3d" },
      { repo: "lib", text: "fixed", evidence: "b2c3d4e" },
    ],
    windowMerges: [{ repo: "app", text: "🔀 Merged #20 (feat/q) (Oct 14)  (9f8e7d6)" }],
  });
  const p = mapped(text);

  test("PREMISE: the page's own count is A's", () => {
    expect(p.whatYouDid.subtitle).toBe("2 projects · 2 commits · 1 PR merged");
  });

  test("before the detail the page's count stays; after it, distinct (card, PR) pairs over every card's PR rows and 🔀 lines", () => {
    const before = gitDetailView(p, input(null), TODAY);
    expect(before.subtitle).toBe("2 projects · 2 commits · 1 PR merged");
    expect(before.workLine).toBe("Your recent work: 2 projects · 2 commits · 1 PR merged");
    const r = all({
      labels: [
        // #20 again (its 🔀 line) and a PR merged after the page was saved, #21.
        label("app", "r1", [
          { kind: "pr", number: 20, title: "q", commits: [{ sha: SHA("a"), token: "a1b2c3d" }] },
          { kind: "pr", number: 21, title: "r", commits: [] },
        ]),
        // The same number under another card counts again: the pairs are (card, PR).
        label("lib", "r1", [{ kind: "pr", number: 21, title: "r", commits: [{ sha: SHA("b"), token: "b2c3d4e" }] }]),
      ],
      repoViews: [view("r1")],
    });
    const after = gitDetailView(p, input(held(r)), TODAY);
    expect(after.subtitle).toBe("2 projects · 2 commits · 3 PRs merged");
    expect(after.workLine).toBe("Your recent work: 2 projects · 2 commits · 3 PRs merged");
  });
});

/* ── B1-M5-T14: the "(+N more)" line ───────────────────────────────────────────────────────────── */

describe("A's \"(+N more)\" line: dropped only when the hidden commits are complete and their count equals N", () => {
  const p = mapped(
    page({
      recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }],
      recapCoverage: { shown: 1, total: 4, notShown: [{ label: "app", sha: "d4e5f6a", subject: "tidy" }] },
    }),
  );
  const rem = (h: GitHeld | null) => gitDetailView(p, input(h), TODAY).remainder;

  test("PREMISE: the page has the coverage header and \"(+2 more)\"", () => {
    expect(p.whatYouDid.remainder).toEqual({ header: "⚠ 3 in-window commit(s) NOT shown above:", more: "(+2 more)", moreCount: 2 });
  });

  test("dropped when complete and equal (the header stays)", () => {
    const rows: ReplyRow[] = [{ kind: "orphan", commits: [
      { sha: SHA("e"), token: null, subject: "hidden one" },
      { sha: SHA("f"), token: null, subject: "hidden two" },
    ] }];
    expect(rem(held(all({ labels: [label("app", "r1", rows)], hidden: { complete: true, perLabel: { app: 2 } } })))).toEqual({ header: "⚠ 3 in-window commit(s) NOT shown above:", more: null });
  });

  test("kept with no reply (no record), with `complete: false`, and with a count mismatch", () => {
    const kept = { header: "⚠ 3 in-window commit(s) NOT shown above:", more: "(+2 more)" };
    expect(rem(null)).toEqual(kept);
    expect(rem(held(all({ hidden: { complete: false, perLabel: { app: 2 } } })))).toEqual(kept);
    expect(rem(held(all({ hidden: { complete: true, perLabel: { app: 1 } } })))).toEqual(kept);
  });
});

/* ── B1-M5-T14: the window title ──────────────────────────────────────────────────────────────── */

describe("the window title, counted from the page's date", () => {
  const title = (startLocal: Date | null, o: { accepted?: boolean; date?: string; today?: string; quiet?: boolean } = {}) => {
    const date = o.date ?? TODAY;
    const text = o.quiet === true ? page({ recap: [] }, date) : page({ recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }] }, date);
    const p = mapped(text, o.today ?? TODAY);
    const iso = startLocal === null ? null : startLocal.toISOString();
    return gitDetailView(p, input(held(all({ record: { accepted: o.accepted ?? true, windowStartUtc: iso } }))), o.today ?? TODAY).title;
  };

  test("the day before: \"Yesterday\"; 2 to 6 days: \"Since {weekday}\"; 7 or more: \"Since {weekday} {day} {month}\"", () => {
    expect(title(new Date(2026, 9, 15))).toBe("Yesterday");
    expect(title(new Date(2026, 9, 14))).toBe("Since Wednesday");
    expect(title(new Date(2026, 9, 10))).toBe("Since Saturday");
    expect(title(new Date(2026, 9, 9))).toBe("Since Friday 9 October");
    expect(title(new Date(2026, 9, 1))).toBe("Since Thursday 1 October");
  });

  test("the year is added when the window starts in another year than the current one", () => {
    expect(title(new Date(2025, 11, 24), { date: "2026-01-05", today: "2026-01-05" })).toBe("Since Wednesday 24 December 2025");
  });

  test("\"What you did\" without a record, with a record not accepted, and on a quiet page", () => {
    expect(gitDetailView(mapped(APP), input(null), TODAY).title).toBe("What you did");
    expect(title(new Date(2026, 9, 15), { accepted: false })).toBe("What you did");
    expect(title(null)).toBe("What you did");
    expect(title(new Date(2026, 9, 15), { quiet: true })).toBe("What you did");
  });

  test("a stale page: its record (accepted only for the page's date) gives its title; without it, \"What you did\"", () => {
    expect(title(new Date(2026, 9, 12), { date: "2026-10-14" })).toBe("Since Monday");
    expect(title(new Date(2026, 9, 12), { date: "2026-10-14", accepted: false })).toBe("What you did");
  });
});

/* ── B1-M5-T14: deckView carries the view ─────────────────────────────────────────────────────── */

describe("deckView passes `gitDetail` to the model", () => {
  const model = todayModel({ snapshot: null, latest: { state: "loaded", file: { path: "/state/briefing-latest.md", text: APP, bytes: APP.length } }, lastRun: null, today: TODAY });

  test("no `gitDetail`, no view (A's slides unchanged); with one, the model's view", () => {
    const a = deckView({ model, today: TODAY, firstName: null });
    expect(a.kind === "slides" && a.git).toBeNull();
    const b = deckView({ model, today: TODAY, firstName: null, gitDetail: input(null) });
    expect(b.kind === "slides" && b.git !== null && b.git.title).toBe("What you did");
  });
});

/* ── the reply the model reads is exactly what Rust lets through ───────────────────────────────── */

describe("the model reads only the filtered reply's fields", () => {
  test("a reply still carrying members the Rust filter drops (paths, raw refnames, raw subjects, error text) changes nothing the model gives", () => {
    const p = mapped(
      page({
        recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }],
        branchState: [{ repo: "app", text: "On branch feat/a (ahead 1, behind 0)" }],
      }),
    );
    const clean = all({
      record: { accepted: true, windowStartUtc: new Date(2026, 9, 15).toISOString() },
      repoViews: [view("r1", { count: 3 })],
      labels: [label("app", "r1", [branchRow("feat/a", ["a"], { state: "partly", notPushed: 1 })])],
      branchLines: [{ key: "app", name: "feat/a", state: "live", notPushed: 1, neverPushed: false, behind: 2 }],
      pushCards: [{ repoKey: "r1", storeKey: "s-r1", firstLabel: "app", repoName: "app", branches: [{ name: "feat/a", commits: 1 }], onDefault: null }],
      tile: { commits: 1, branches: 1 },
      hidden: { complete: true, perLabel: { app: 0 } },
    });
    const SECRETS = ["/Users/someone/secret-repo", "refs/heads/feat/a", "RAW SUBJECT ghp_abcdefghijklmnopqrstuvwxyz0123456789", "fatal: detected dubious ownership"];
    const dirty = JSON.parse(JSON.stringify(clean)) as Record<string, unknown> & ReposAllReply;
    Object.assign(dirty, { repos: [{ key: "r1", path: SECRETS[0], gitDir: SECRETS[0], commonDir: SECRETS[0], reftable: false }], message: SECRETS[3] });
    Object.assign(dirty.repoViews[0]!, { path: SECRETS[0], message: SECRETS[3] });
    Object.assign(dirty.labels[0]!, { path: SECRETS[0] });
    Object.assign(dirty.labels[0]!.rows[0]!, { ref: SECRETS[1] });
    Object.assign(dirty.labels[0]!.rows[0]!.commits[0]!, { subject: SECRETS[2] });
    Object.assign(dirty.branchLines[0]!, { ref: SECRETS[1] });
    Object.assign(dirty.pushCards[0]!, { path: SECRETS[0] });
    Object.assign(dirty.pushCards[0]!.branches[0]!, { ref: SECRETS[1] });
    Object.assign(dirty.record, { path: SECRETS[0] });
    const out = (r: ReposIpcReply) => JSON.stringify(gitDetailView(p, input(held(r)), TODAY));
    const a = out(clean);
    const b = out(dirty as ReposIpcReply);
    expect(b).toBe(a);
    for (const s of SECRETS) expect(b).not.toContain(s);
  });

  test("type level: the mirror equals the engine's `ReposReply`, and a member the filter drops is not readable (compiled)", () => {
    const dir = mkdtempSync(join(tmpdir(), "git-detail-types-"));
    try {
      const gui = new URL("../src/lib/git-detail.ts", import.meta.url).pathname.replace(/\.ts$/, "");
      const eng = new URL("../../src/repos/types.ts", import.meta.url).pathname.replace(/\.ts$/, "");
      const probe = join(dir, "probe.ts");
      writeFileSync(
        probe,
        [
          `import type { ReposAllReply, RepoView, ReplyRow, ReplyCommit, LabelView, BranchLine, PushCard, ActionCard, ReposIpcReply } from ${JSON.stringify(gui)};`,
          `import type { ReposReply, ReposEngineReply, RepoStatTarget, RepoFacts, ActionFacts, ActionCard as EngineActionCard } from ${JSON.stringify(eng)};`,
          "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
          "export const same: Equal<ReposAllReply, ReposReply> = true;",
          'type ExpectedActionCard = { repoKey: string; cardKind: "did" | "leftOff" | "push" | "tile"; cardId: string; handles: { handle: string; target: "pr" | "branch" | "commit" | "compare" | "editor" | "copy"; row: number | null; sha: string | null; project: string | null; label: string | null }[] };',
          "export const actions: Equal<ActionCard, ExpectedActionCard> = true;",
          "export const actionMirror: Equal<ActionCard, EngineActionCard> = true;",
          "export const requiredActions: Equal<ReposAllReply['actions'], ActionCard[]> = true;",
          "export const privateFacts: Equal<ActionFacts, RepoFacts[]> = true;",
          'export const engine: Equal<ReposEngineReply, Omit<ReposReply, "actions"> & { repos: RepoStatTarget[]; actionFacts: ActionFacts }> = true;',
          "declare const engineReply: ReposEngineReply;",
          "// @ts-expect-error actions are minted by Rust, never printed by the engine",
          "export const privateOnly = engineReply.actions;",
          "type Held = Exclude<ReposIpcReply, { gate: \"noResult\" }>;",
          "type RustFields = { gate: \"ran\" | \"held\"; heldAt: number; uncommittedAt: string; unknownRepos: string[] };",
          "export const rust: Equal<Pick<Held, keyof RustFields>, RustFields> = true;",
          "export const base: Equal<Omit<Held, keyof RustFields>, Omit<ReposReply & RustFields, keyof RustFields>> = true;",
          "export const none: Equal<Extract<ReposIpcReply, { gate: \"noResult\" }>, { gate: \"noResult\"; heldAt: null; uncommittedAt: null; unknownRepos: [] }> = true;",
          "declare const v: RepoView; declare const row: ReplyRow; declare const c: Extract<ReplyCommit, { token: string }>;",
          "declare const l: LabelView; declare const b: BranchLine; declare const p: PushCard; declare const r: ReposAllReply;",
          "// @ts-expect-error a path never crosses",
          "export const a1 = v.path;",
          "// @ts-expect-error nor an error message",
          "export const a2 = v.message;",
          "// @ts-expect-error a row has no raw refname",
          "export const a3 = row.ref;",
          "// @ts-expect-error a page commit has no subject",
          "export const a4 = c.subject;",
          "// @ts-expect-error",
          "export const a5 = l.path;",
          "// @ts-expect-error",
          "export const a6 = b.ref;",
          "// @ts-expect-error",
          "export const a7 = p.path;",
          "// @ts-expect-error the stat list is Rust's alone",
          "export const a8 = r.repos;",
          "// @ts-expect-error private action facts never cross IPC",
          "export const a9 = r.actionFacts;",
          "",
        ].join("\n"),
      );
      const program = ts.createProgram([probe], {
        strict: true,
        noEmit: true,
        skipLibCheck: true,
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        allowImportingTsExtensions: false,
        types: [],
        lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
        exactOptionalPropertyTypes: true,
      });
      const diags = ts.getPreEmitDiagnostics(program).map((d) => {
        const line = d.file !== undefined && d.start !== undefined ? d.file.getLineAndCharacterOfPosition(d.start).line + 1 : 0;
        return `probe.ts:${line}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`;
      });
      expect(diags).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});

/* ── B1-M5-T15: the launchpad tiles, their life cycle and the mood line ─────────────────────────── */

const MIN = 60_000;

describe("B1-M5 fixes: ownership, retention and freshness", () => {
  test("page dates follow Rust's archive_date at the year boundaries", () => {
    for (const date of ["0000-01-01", "0000-02-29", "0000-12-31"]) {
      expect(isCalendarDate(date)).toBe(false);
      expect(mapPage(renderMarkdown(page({}, date)), TODAY).ok).toBe(false);
    }
    for (const date of ["0001-01-01", "9999-12-31", "2000-02-29"]) {
      expect(isCalendarDate(date)).toBe(true);
      expect(reposRequest(mapped(page({}, date))).pageDate).toBe(date);
    }
    expect(isCalendarDate("1900-02-29")).toBe(false);
  });

  test("a successful independent status survives two unknown repo views at its original time, then recovers", () => {
    const a = held(all({ repoViews: [{ ...view("r1", { unknown: true }), uncommitted: { count: 4 } }] }, { uncommittedAt: at(9, 14) }));
    const b = held(all({ checkedAt: at(9, 20), repoViews: [view("r1", { unknown: true })] }), a);
    const c = held(all({ checkedAt: at(9, 30), repoViews: [view("r1", { unknown: true })] }), b);
    expect(c.reply.repoViews[0]!.uncommitted).toEqual({ count: 4 });
    expect(c.asOf.uncommitted).toEqual({ r1: at(9, 14) });
    const tiles = gitDetailView(mapped(APP), input(c), TODAY).tiles;
    expect(tiles.find((t) => t.key === "uncommitted:r1")?.asOf).toBe("as of 09:14");
    const recovered = held(all({ repoViews: [{ ...view("r1", { unknown: true }), uncommitted: { count: 0 } }] }), c);
    expect(recovered.reply.repoViews[0]!.uncommitted).toEqual({ count: 0 });
    expect(recovered.asOf.uncommitted).toEqual({});
  });

  const resumePage = mapped(page({
    resume: [{ repo: "app", text: "Uncommitted changes: a.ts, b.ts" }, { repo: "docs", text: "finish notes" }],
    branchState: [{ repo: "app", text: "On branch feat/a (ahead 2, behind 1)" }],
  }));

  test("resume-only cards request explicit ownership, including cards without branches, without duplicate labels", () => {
    expect(resumePage.whatYouDid.cards).toEqual([]);
    expect(reposRequest(resumePage).labels).toEqual([{ key: "app", tokens: [] }, { key: "docs", tokens: [] }]);
    const mixed = mapped(page({ recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }], resume: [{ repo: "app", text: "continue" }, { repo: "docs", text: "notes" }] }));
    expect(reposRequest(mixed).labels).toEqual([{ key: "app", tokens: ["a1b2c3d"] }, { key: "docs", tokens: [] }]);
  });

  test("resume-only seeded dirty words clear on live zero and branch words survive unknown replies", () => {
    expect(gitDetailView(resumePage, input(null), TODAY).leftOff[0]!.uncommitted).toBe("2 files not committed");
    // The engine returns ownership for the labels actually requested, even with no SHA tokens.
    const labels = reposRequest(resumePage).labels.filter((l) => l.key === "app").map((l) => label(l.key, "r1", []));
    const first = held(all({ checkedAt: at(9, 0), labels, repoViews: [view("r1")],
      branchLines: [{ key: "app", name: "feat/a", state: "live", notPushed: 3, neverPushed: false, behind: 4 }] }));
    expect(gitDetailView(resumePage, input(first), TODAY).leftOff[0]).toMatchObject({ uncommitted: null, pushTag: "3 not pushed", counts: ["behind 4"], asOf: null });
    const next = held(all({ checkedAt: at(9, 30), labels: labels.map((l) => ({ ...l, state: "unknown" })), repoViews: [view("r1", { unknown: true })] }), first);
    expect(gitDetailView(resumePage, input(next), TODAY).leftOff[0]).toMatchObject({ uncommitted: null, pushTag: "3 not pushed", counts: ["behind 4"], asOf: "as of 09:00" });
  });

  test("a multi-repo label is conservatively stale when any repo is unknown, including the first held reply", () => {
    const make = (time: string, unknownRepos: string[] = []) => all({ checkedAt: time, repoViews: [view("r1"), view("r2")],
      labels: [label("app", null, [branchRow("feat/a", ["a"])]), label("lib", "r2", [])] }, { unknownRepos });
    const a = held(make(at(9, 0)));
    const b = held(make(at(9, 30), ["r1"]), a);
    const c = held(make(at(9, 45), ["r1"]), b);
    const card = gitDetailView(mapped(APP), input(c), TODAY).cards[0]!;
    expect(card.mode === "detail" ? card.asOf : "page").toBe("as of 09:00");
    expect(c.asOf.labels.lib).toBeUndefined();
    expect(held(make(at(9, 30), ["r1"])).asOf.labels.app).toBe(at(9, 30));
    expect(held(make(at(10, 0)), c).asOf.labels).toEqual({});
  });

  test("hidden commits with no page SHA are represented before dropping the remainder; undisplayed owners keep it", () => {
    const p = mapped(page({ recap: [{ repo: "app", text: "uncited work" }], recapCoverage: { shown: 0, total: 2, notShown: [] } }));
    expect(p.whatYouDid.cards[0]!.commits).toBe(0);
    expect(p.whatYouDid.remainder.more).toBe("(+2 more)");
    const rows: ReplyRow[] = [{ kind: "orphan", commits: [
      { sha: SHA("e"), token: null, subject: "hidden one" }, { sha: SHA("f"), token: null, subject: "hidden two" },
    ] }];
    const model = (key: string, shownRows: ReplyRow[] = rows) => gitDetailView(p, input(held(all({ labels: [label(key, "r1", shownRows)], hidden: { complete: true, perLabel: { [key]: 2 } } }))), TODAY);
    const shown = model("app");
    const card = shown.cards[0]!;
    expect(card.mode).toBe("detail");
    if (card.mode !== "detail") throw new Error("hidden rows must be represented");
    expect(card.rows.flatMap((r) => r.commits.flatMap((c) => c.lines.map((l) => l.text)))).toEqual(["hidden one", "hidden two"]);
    expect(shown.remainder.more).toBeNull();
    expect(model("absent").remainder.more).toBe("(+2 more)");
    expect(model("app", []).remainder.more).toBe("(+2 more)");
    expect(model("app", [{ kind: "orphan", commits: [rows[0]!.commits[0]!, rows[0]!.commits[0]!] }]).remainder.more).toBe("(+2 more)");
  });

  test("both green tile variants carry their own freshness after IPC errors and retained unknown replies", () => {
    const zero = held(all({ checkedAt: at(9, 10), repoViews: [view("r1")] }, { uncommittedAt: at(9, 14) }));
    const greenSince = { onlyHere: 1, "uncommitted:r1": 1 };
    const times = (h: GitHeld, fresh: boolean) => gitDetailView(mapped(APP), input(h, { fresh, greenSince }), TODAY).tiles.map((t) => t.asOf);
    expect(times(zero, true)).toEqual([null, null]);
    expect(times(zero, false)).toEqual(["as of 09:10", "as of 09:14"]);
    const unknown = held(all({ checkedAt: at(9, 30), repoViews: [view("r1", { unknown: true })] }), zero);
    expect(times(unknown, true)).toEqual(["as of 09:10", "as of 09:14"]);
  });

  test("Good morning's aggregate carries freshness after an IPC error or a partial repo failure", () => {
    const first = held(all({ checkedAt: at(9, 10), repoViews: [view("r1"), view("r2")], tile: { commits: 3, branches: 1 },
      pushCards: [{ repoKey: "r1", storeKey: "s-r1", repoName: "app", firstLabel: "app", branches: [], onDefault: { name: "main", commits: 3 } }] }));
    const model = (h: GitHeld, fresh: boolean) => gitDetailView(mapped(APP), input(h, { fresh }), TODAY);
    expect(model(first, true).goodMorningAsOf).toBeNull();
    expect(model(first, false).goodMorningAsOf).toBe("as of 09:10");
    const partial = held(all({ checkedAt: at(9, 30), repoViews: [view("r1", { unknown: true }), view("r2")] }), first);
    expect(model(partial, true).goodMorningLine).toBe("3 commits exist only on this Mac. See Suggested.");
    expect(model(partial, true).goodMorningAsOf).toBe("as of 09:10");
    expect(gitDetailView(mapped(APP), input(null), TODAY).goodMorningAsOf).toBeNull();
  });
});

describe("the launchpad's git tiles (S1's order, after A's meeting tile)", () => {
  const p = mapped(APP);
  const g = (r: ReposIpcReply, o: Partial<GitDetailInput> = {}, prev: GitHeld | null = null) => gitDetailView(p, input(held(r, prev), o), TODAY);
  const NOW = new Date(2026, 9, 16, 9, 30).getTime();

  test("\"Only on this Mac · N commits on M branches\", one tile for all repos, with its singulars", () => {
    expect(launchpadTiles(g(all({ tile: { commits: 10, branches: 2 } })), NOW).tiles).toEqual([
      { key: "onlyHere", state: "wait", label: "Only on this Mac", value: "10 commits on 2 branches", asOf: null },
    ]);
    expect(launchpadTiles(g(all({ tile: { commits: 1, branches: 1 } })), NOW).tiles[0]!.value).toBe("1 commit on 1 branch");
  });

  test("\"Not committed · N files in {name}\" per repo in the reply's order, at most 3, then \"+N more repos not committed\"", () => {
    const views = [view("r1", { count: 6, name: "Cedar Notes" }), view("r2", { count: 1, name: "app" }), view("r3", { count: 0 }), view("r4", { count: 2, name: "lib" }), view("r5", { count: 3 }), view("r6", { count: 4 })];
    const t = launchpadTiles(g(all({ repoViews: views })), NOW);
    expect(t.tiles).toEqual([
      { key: "uncommitted:r1", state: "wait", label: "Not committed", value: "6 files in Cedar Notes", asOf: null },
      { key: "uncommitted:r2", state: "wait", label: "Not committed", value: "1 file in app", asOf: null },
      { key: "uncommitted:r4", state: "wait", label: "Not committed", value: "2 files in lib", asOf: null },
    ]);
    expect(t.more).toBe("+2 more repos not committed");
    expect(t.waiting).toBe(5);
    expect(launchpadTiles(g(all({ repoViews: views.slice(0, 5) })), NOW).more).toBe("+1 more repo not committed");
    expect(launchpadTiles(g(all({ repoViews: views.slice(0, 4) })), NOW).more).toBeNull();
  });

  test("an unknown count with nothing earlier gives no tile; a failed check dims the tile it kept, \"as of HH:MM\"", () => {
    expect(launchpadTiles(g(all({ repoViews: [view("r1", { count: null })] })), NOW).tiles).toEqual([]);
    const a = all({ checkedAt: at(9, 0), repoViews: [view("r1", { count: 2 })], pushCards: [{ repoKey: "r1", storeKey: "s-r1", firstLabel: "app", repoName: "app", branches: [], onDefault: { name: "main", commits: 3 } }], tile: { commits: 3, branches: 1 } }, { uncommittedAt: at(9, 2) });
    const b = all({ checkedAt: at(9, 20), repoViews: [view("r1", { unknown: true })] }, { uncommittedAt: at(9, 20) });
    const t = launchpadTiles(gitDetailView(p, input(held(b, held(a))), TODAY), NOW).tiles;
    expect(t).toEqual([
      { key: "onlyHere", state: "wait", label: "Only on this Mac", value: "3 commits on 1 branch", asOf: "as of 09:00" },
      { key: "uncommitted:r1", state: "wait", label: "Not committed", value: "2 files in r1", asOf: "as of 09:02" },
    ]);
  });

  test("R3-M8 `fresh: false`: the tiles say \"as of\" at their own times, the push tile `checkedAt` and Not committed `uncommittedAt`; with `fresh: true` neither does", () => {
    const r = all({ checkedAt: at(9, 10), repoViews: [view("r1", { count: 2 })], tile: { commits: 1, branches: 1 } }, { uncommittedAt: at(9, 14) });
    expect(launchpadTiles(g(r, { fresh: false }), NOW).tiles.map((x) => x.asOf)).toEqual(["as of 09:10", "as of 09:14"]);
    expect(launchpadTiles(g(r, { fresh: true }), NOW).tiles.map((x) => x.asOf)).toEqual([null, null]);
  });

  test("polish §6: the launchpad's heading is \"Before you start\" while any amber (waiting) tile shows, else \"You're all set\"", () => {
    // Amber "Only on this Mac".
    expect(launchpadHeading(g(all({ tile: { commits: 2, branches: 1 } })))).toBe("Before you start");
    // An amber "Not committed" beyond the 3-tile cap still counts: the first three are green (shown, `done`).
    const since = NOW - MIN;
    const views = [view("r1", { count: 0 }), view("r2", { count: 0 }), view("r3", { count: 0 }), view("r4", { count: 2 })];
    const capped = g(all({ repoViews: views }), { greenSince: { "uncommitted:r1": since, "uncommitted:r2": since, "uncommitted:r3": since } });
    const t = launchpadTiles(capped, NOW);
    expect([t.tiles.map((x) => x.state), t.more]).toEqual([["done", "done", "done"], "+1 more repo not committed"]);   // PREMISE
    expect(launchpadHeading(capped)).toBe("Before you start");
    // Green only.
    const zero = all({ repoViews: [view("r1", { count: 0 })], tile: { commits: 0, branches: 0 } });
    const green = g(zero, { greenSince: { onlyHere: since, "uncommitted:r1": since } });
    expect(launchpadTiles(green, NOW).tiles.map((x) => x.state)).toEqual(["done", "done"]);   // PREMISE
    expect(launchpadHeading(green)).toBe("You're all set");
    // No detail (none yet, or no reply held).
    expect(launchpadHeading(null)).toBe("You're all set");
    expect(launchpadHeading(gitDetailView(p, input(null), TODAY))).toBe("You're all set");
  });

  test("a tile at zero turns green and leaves at the first tick 5 minutes after it turned green, not before", () => {
    const zero = all({ repoViews: [view("r1", { count: 0, name: "Cedar Notes" })], tile: { commits: 0, branches: 0 } });
    const since = NOW - 3 * MIN;
    const v = g(zero, { greenSince: { onlyHere: since, "uncommitted:r1": since } });
    expect(launchpadTiles(v, since + 4 * MIN + 59_000).tiles).toEqual([
      { key: "onlyHere", state: "done", label: "✓ Pushed", value: "All your work is pushed", asOf: null },
      { key: "uncommitted:r1", state: "done", label: "✓ Committed", value: "Cedar Notes is clean", asOf: null },
    ]);
    expect(launchpadTiles(v, since + 5 * MIN).tiles).toEqual([]);
    // A zero with no `greenSince` (it was never amber here) is no tile at all.
    expect(launchpadTiles(g(zero), NOW).tiles).toEqual([]);
  });

  test("no git detail, no tiles", () => {
    expect(launchpadTiles(null, NOW)).toEqual({ tiles: [], more: null, moreAsOf: null, waiting: 0 });
  });

  test("overflow retains the oldest failed count's date across midnight and clears it on recovery", () => {
    const views = [1, 2, 3, 4, 5].map((n) => view(`r${n}`, { count: n }));
    const beforeMidnight = new Date(2026, 9, 15, 23, 50).toISOString();
    const afterMidnight = new Date(2026, 9, 16, 0, 10).toISOString();
    const initial = held(all({ repoViews: views }, { uncommittedAt: beforeMidnight }));
    const first = held(all({ repoViews: views.map((v, i) => i === 3 ? view(v.key, { unknown: true }) : v) }, { uncommittedAt: afterMidnight }), initial);
    const second = held(all({ repoViews: views.map((v, i) => i >= 3 ? view(v.key, { unknown: true }) : v) }), first);
    const tiles = launchpadTiles(gitDetailView(p, input(second), TODAY), NOW);
    expect(tiles.more).toBe("+2 more repos not committed");
    expect(tiles.moreAsOf).toBe("as of 23:50");
    expect(tiles.tiles.every((t) => t.asOf === null)).toBe(true);
    const recovered = launchpadTiles(gitDetailView(p, input(held(all({ repoViews: views }), second)), TODAY), NOW);
    expect(recovered.moreAsOf).toBeNull();
    expect(launchpadTiles(gitDetailView(p, input(initial, { fresh: false }), TODAY), NOW).moreAsOf).toBe("as of 23:50");
  });
});

describe("the mood line: a meeting wins; else the amber tiles; else A's line", () => {
  const p = mapped(APP);
  const NOW = new Date(2026, 9, 16, 9, 30).getTime();
  const tiles = (commits: number, dirty: number[], greenSince: Record<string, number> = {}) =>
    launchpadTiles(gitDetailView(p, input(held(all({ tile: { commits, branches: commits > 0 ? 1 : 0 }, repoViews: dirty.map((n, i) => view(`r${i}`, { count: n })) })), { greenSince }), TODAY), NOW);
  const meeting: MeetingTile = { state: "soon", minutes: 12, event: { title: "standup", startMs: NOW + 12 * MIN, endMs: NOW + 27 * MIN, since: null, tentative: false, ended: false } };

  test("two or more amber tiles, one, none; a green tile never counts; a meeting line wins; A's own `moodLine` unchanged", () => {
    expect(liveMoodLine(null, tiles(3, [2]))).toBe("A couple of things are waiting.");
    expect(liveMoodLine(null, tiles(3, []))).toBe("One thing is waiting.");
    expect(liveMoodLine(null, tiles(0, [0], { onlyHere: NOW - MIN, "uncommitted:r0": NOW - MIN }))).toBe("Nothing needs you right now.");
    expect(liveMoodLine(null, tiles(0, [0, 1], { onlyHere: NOW - MIN }))).toBe("One thing is waiting.");
    expect(liveMoodLine(meeting, tiles(3, [2]))).toBe(moodLine(meeting));
    expect(liveMoodLine(null, null)).toBe(moodLine(null));
  });

  // PB-M4-T1: on a live calendar day Launchpad supplies the calendar's chosen line (liveDayLine) as a third argument.
  const LINES = ["Reading your calendar…", "Couldn't read your calendar just now", "No calendar is connected", "Calendar unavailable today"];
  test("PB-M4-T1: a supplied calendar line is the mood line when nothing is waiting; waiting git tiles still win; never \"Nothing needs you right now.\"", () => {
    for (const line of LINES) {
      expect(liveMoodLine(null, null, line)).toBe(line);
      expect(liveMoodLine(null, tiles(0, [0], { onlyHere: NOW - MIN, "uncommitted:r0": NOW - MIN }), line)).toBe(line);
      expect(liveMoodLine(null, tiles(3, []), line)).toBe("One thing is waiting.");
      expect(liveMoodLine(null, tiles(3, [2]), line)).toBe("A couple of things are waiting.");
    }
  });

  test("PB-M4-T1: no calendar line (absent or null): the two-argument rule, unchanged", () => {
    for (const line of [undefined, null]) {
      expect(liveMoodLine(null, null, line)).toBe(moodLine(null));
      expect(liveMoodLine(null, tiles(0, [0], { onlyHere: NOW - MIN, "uncommitted:r0": NOW - MIN }), line)).toBe("Nothing needs you right now.");
      expect(liveMoodLine(null, tiles(3, []), line)).toBe("One thing is waiting.");
      expect(liveMoodLine(meeting, tiles(3, [2]), line)).toBe(moodLine(meeting));
    }
  });

  test("PB-M4-T1 (source): git-detail.ts imports nothing from calendar-detail (Launchpad chooses the line; no new cycle)", () => {
    const src = readFileSync(new URL("../src/lib/git-detail.ts", import.meta.url), "utf8");
    expect(src).not.toMatch(/from "\.\/calendar-detail"/);
  });
});

/* ── B1-M5-T15: the push cards (U3) ────────────────────────────────────────────────────────────── */

describe("\"Push your work\": one unnumbered card per repo, first in Suggested", () => {
  const text = page({
    recap: [
      { repo: "btc_forecaster_live", text: "shipped", evidence: "a1b2c3d" },
      { repo: "lib", text: "fixed", evidence: "b2c3d4e" },
    ],
    suggestions: [{ repo: "lib", text: "add the test" }],
  } as Partial<EngineStruct>);
  const p = mapped(text);
  const card = (c: Partial<ReposAllReply["pushCards"][number]> & { repoKey: string }) => ({ storeKey: `s-${c.repoKey}`, firstLabel: null, repoName: c.repoKey, branches: [], onDefault: null, ...c });
  const push = (cards: ReposAllReply["pushCards"], o: { os?: GitDetailInput["os"]; noRemote?: string[]; page?: DeckPage } = {}) =>
    gitDetailView(o.page ?? p, input(held(all({ pushCards: cards, repoViews: cards.map((c) => view(c.repoKey, { noRemote: o.noRemote?.includes(c.repoKey) ?? false })) })), { os: o.os ?? "macos" }), TODAY).pushCards;

  test("the template, count first (polish §6): branches, then the default branch, each \"{count} on {name}\", only the first with the noun; \"exist\" / \"exists\"", () => {
    const texts = push([
      card({ repoKey: "r1", branches: [{ name: "spike/kelly", commits: 5 }], onDefault: { name: "main", commits: 2 } }),
      card({ repoKey: "r2", branches: [{ name: "a", commits: 1 }, { name: "b", commits: 2 }, { name: "c", commits: 3 }] }),
      card({ repoKey: "r3", onDefault: { name: "main", commits: 1 } }),
      card({ repoKey: "r4", branches: [{ name: "x", commits: 1 }, { name: "y", commits: 1 }] }),
      card({ repoKey: "r5", branches: [{ name: "only", commits: 1 }] }),
    ]).map((c) => c.text);
    expect(texts).toEqual([
      "Push your work: 5 commits on spike/kelly and 2 on main exist only on this Mac",
      "Push your work: 1 commit on a, 2 on b and 3 on c exist only on this Mac",
      "Push your work: 1 commit on main exists only on this Mac",
      "Push your work: 1 commit on x and 1 on y exist only on this Mac",
      "Push your work: 1 commit on only exists only on this Mac",
    ]);
  });

  test("distinct keys `push:<repo>`, the why line `PUSH_WHY` on each, the first label's pill, or the repo's name with no label", () => {
    const cs = push([
      card({ repoKey: "r1", firstLabel: "btc_forecaster_live", repoName: "btc", onDefault: { name: "main", commits: 2 } }),
      card({ repoKey: "r2", repoName: "scratch", onDefault: { name: "main", commits: 1 } }),
    ]);
    expect(PUSH_WHY).toBe("Not backed up anywhere yet");
    expect(cs.map(({ key, pill, name, why }) => ({ key, pill, name, why }))).toEqual([
      { key: "push:r1", pill: { label: "btc_forecaster_live", slot: p.whatYouDid.cards[0]!.slot }, name: null, why: PUSH_WHY },
      { key: "push:r2", pill: null, name: "scratch", why: PUSH_WHY },
    ]);
    expect(new Set(cs.map((c) => c.key)).size).toBe(cs.length);
  });

  test("none on a stale page (\"Suggested then\"), none for a repo with no remote (OD3)", () => {
    const stale = mapped(page({ recap: [{ repo: "lib", text: "fixed", evidence: "b2c3d4e" }] }, "2026-10-14"));
    expect(push([card({ repoKey: "r1", onDefault: { name: "main", commits: 2 } })], { page: stale })).toEqual([]);
    expect(push([card({ repoKey: "r1", onDefault: { name: "main", commits: 2 } })], { noRemote: ["r1"] })).toEqual([]);
  });

  test("polish §6: the spec's five shapes, on macOS and off it", () => {
    const shapes = [
      card({ repoKey: "r1", branches: [{ name: "research/round2", commits: 3 }] }),
      card({ repoKey: "r2", branches: [{ name: "research/round2", commits: 1 }] }),
      card({ repoKey: "r3", branches: [{ name: "spike/kelly", commits: 5 }], onDefault: { name: "main", commits: 2 } }),
      card({ repoKey: "r4", branches: [{ name: "a", commits: 1 }, { name: "b", commits: 2 }, { name: "c", commits: 1 }] }),
      card({ repoKey: "r5", onDefault: { name: "main", commits: 2 } }),
    ];
    const words = [
      "3 commits on research/round2 exist",
      "1 commit on research/round2 exists",
      "5 commits on spike/kelly and 2 on main exist",
      "1 commit on a, 2 on b and 1 on c exist",
      "2 commits on main exist",
    ];
    for (const [os, here] of [["macos", "on this Mac"], ["linux", "on this computer"]] as const) {
      expect(push(shapes, { os }).map((c) => c.text)).toEqual(words.map((w) => `Push your work: ${w} only ${here}`));
    }
  });

  test("D6: \"only on this computer\" off macOS", () => {
    expect(push([card({ repoKey: "r1", onDefault: { name: "main", commits: 2 } })], { os: "linux" })[0]!.text).toBe("Push your work: 2 commits on main exist only on this computer");
  });

  test("with no page suggestions a push card still shows and \"No suggestions in this briefing.\" does not; Good morning's first-suggestion tile stays the page's first card", () => {
    const none = mapped(page({ recap: [{ repo: "lib", text: "fixed", evidence: "b2c3d4e" }] }));
    const one = [card({ repoKey: "r1", onDefault: { name: "main", commits: 2 } })];
    const g = gitDetailView(none, input(held(all({ pushCards: one, repoViews: [view("r1")] }))), TODAY);
    expect(none.suggested.cards).toEqual([]); // PREMISE
    expect(noSuggestionsShown(none.suggested, g)).toBe(false);
    expect(noSuggestionsShown(none.suggested, null)).toBe(true);
    expect(noSuggestionsShown(none.suggested, gitDetailView(none, input(null), TODAY))).toBe(true);
    const model = todayModel({ snapshot: null, latest: { state: "loaded", file: { path: "/state/briefing-latest.md", text, bytes: text.length } }, lastRun: null, today: TODAY });
    const d = deckView({ model, today: TODAY, firstName: null, gitDetail: input(held(all({ pushCards: one, repoViews: [view("r1")] }))) });
    if (d.kind !== "slides") throw new Error("expected slides");
    expect(d.git!.pushCards.length).toBe(1); // PREMISE: a push card is there
    expect(d.goodMorning.firstSuggestion).toEqual(p.suggested.cards[0]!);
  });
});

/* ── B1-M5-T15: Good morning's live line ───────────────────────────────────────────────────────── */

describe("Good morning: \"N commits exist only on this Mac. See Suggested.\"", () => {
  const p = mapped(APP);
  const gm = (commits: number, o: { page?: DeckPage; os?: GitDetailInput["os"] } = {}) =>
    gitDetailView(o.page ?? p, input(held(all({ tile: { commits, branches: 1 } })), { os: o.os ?? "macos" }), TODAY).goodMorningLine;

  test("the tile's N, its singular, none at zero, none on a stale page, \"on this computer\" off macOS", () => {
    expect(gm(10)).toBe("10 commits exist only on this Mac. See Suggested.");
    expect(gm(1)).toBe("1 commit exists only on this Mac. See Suggested.");
    expect(gm(0)).toBeNull();
    expect(gm(3, { page: mapped(page({ recap: [{ repo: "app", text: "x", evidence: "a1b2c3d" }] }, "2026-10-14")) })).toBeNull();
    expect(gm(2, { os: "other" })).toBe("2 commits exist only on this computer. See Suggested.");
  });

  test("the Needs-a-look tile shows with only the live line, with only page lines, and not with neither", () => {
    const g = gitDetailView(p, input(held(all({ tile: { commits: 2, branches: 1 } }))), TODAY);
    expect(needsALookShown([], g)).toBe(true);
    expect(needsALookShown(["⚠ a warning"], null)).toBe(true);
    expect(needsALookShown([], gitDetailView(p, input(held(all())), TODAY))).toBe(false);
    expect(needsALookShown([], null)).toBe(false);
  });
});

/* ── B1-M5-T15: Where you left off (D1) and the "not committed" tag ───────────────────────────── */

describe("Where you left off: the live branch words and the \"not committed\" tag", () => {
  const text = page({
    recap: [
      { repo: "app", text: "shipped", evidence: "a1b2c3d" },
      { repo: "lib", text: "fixed", evidence: "b2c3d4e" },
    ],
    branchState: [
      { repo: "app", text: "On branch feat/a (ahead 2, behind 1)" },
      { repo: "lib", text: "On branch main (ahead 1, behind 0)" },
      { repo: "tool", text: "Detached HEAD at abc1234" },
    ],
    resume: [
      { repo: "lib", text: "Uncommitted changes: a.ts, b.ts, c.ts" },
      { repo: "notes", text: "Uncommitted changes: one.md" },
      { repo: "other", text: "uncommitted changes: x.md" },
    ],
  });
  const p = mapped(text);
  const lo = (r: ReposIpcReply | null, o: Partial<GitDetailInput> = {}) => {
    const v = gitDetailView(p, input(r === null ? null : held(r), o), TODAY);
    return Object.fromEntries(v.leftOff.map((c) => [c.key, { counts: c.counts, pushTag: c.pushTag, asOf: c.asOf, uncommitted: c.uncommitted, uncommittedAsOf: c.uncommittedAsOf }]));
  };

  test("before the check: A's words, and the seed from a bullet starting exactly \"Uncommitted changes: \"", () => {
    expect(lo(null)).toEqual({
      app: { counts: ["ahead 2", "behind 1"], pushTag: null, asOf: null, uncommitted: null, uncommittedAsOf: null },
      lib: { counts: ["ahead 1"], pushTag: null, asOf: null, uncommitted: "3 files not committed", uncommittedAsOf: null },
      tool: { counts: [], pushTag: null, asOf: null, uncommitted: null, uncommittedAsOf: null },
      notes: { counts: [], pushTag: null, asOf: null, uncommitted: "1 file not committed", uncommittedAsOf: null },
      other: { counts: [], pushTag: null, asOf: null, uncommitted: null, uncommittedAsOf: null },
    });
  });

  test("a `live` line replaces A's words: \"N not pushed\" or \"never pushed\" (the dashed tag) and a muted \"behind N\"", () => {
    const r = all({
      labels: [label("app", "r1", []), label("lib", "r2", [])],
      repoViews: [view("r1", { count: 0 }), view("r2", { count: 5 })],
      branchLines: [
        { key: "app", name: "feat/a", state: "live", notPushed: 3, neverPushed: false, behind: 4 },
        { key: "lib", name: "main", state: "live", notPushed: 2, neverPushed: true, behind: 0 },
      ],
    });
    const out = lo(r);
    expect(out["app"]).toEqual({ counts: ["behind 4"], pushTag: "3 not pushed", asOf: null, uncommitted: null, uncommittedAsOf: null });
    // The live count replaces the seed; a live 0 removes the tag.
    expect(out["lib"]).toEqual({ counts: [], pushTag: "never pushed", asOf: null, uncommitted: "5 files not committed", uncommittedAsOf: null });
  });

  test("`missing`, `noRemote` (OD3) or no entry keeps A's words; with `fresh: false` they say \"as of\"", () => {
    const r = all({
      checkedAt: at(9, 10),
      labels: [label("app", "r1", []), label("lib", "r2", [])],
      repoViews: [view("r1", { count: 1 }), view("r2", { count: 0, noRemote: true })],
      branchLines: [
        { key: "app", name: "feat/a", state: "missing" },
        { key: "lib", name: "main", state: "noRemote" },
      ],
    }, { uncommittedAt: at(9, 14) });
    const out = lo(r);
    expect(out["app"]).toEqual({ counts: ["ahead 2", "behind 1"], pushTag: null, asOf: null, uncommitted: "1 file not committed", uncommittedAsOf: null });
    expect(out["lib"]).toEqual({ counts: ["ahead 1"], pushTag: null, asOf: null, uncommitted: null, uncommittedAsOf: null });
    const stale = lo(r, { fresh: false });
    expect(stale["app"]).toEqual({ counts: ["ahead 2", "behind 1"], pushTag: null, asOf: "as of 09:10", uncommitted: "1 file not committed", uncommittedAsOf: "as of 09:14" });
    // A detached HEAD shows A's words and nothing live.
    expect(stale["tool"]).toEqual({ counts: [], pushTag: null, asOf: null, uncommitted: null, uncommittedAsOf: null });
  });

  test("R3-M8: a live line from a held answer with `fresh: false` says \"as of 09:10\"", () => {
    const r = all({ checkedAt: at(9, 10), labels: [label("app", "r1", [])], branchLines: [{ key: "app", name: "feat/a", state: "live", notPushed: 1, neverPushed: false, behind: 0 }] });
    expect(lo(r, { fresh: false })["app"]!.asOf).toBe("as of 09:10");
    expect(lo(r, { fresh: true })["app"]!.asOf).toBeNull();
  });
});

test("final3 L6 a first partial answer dates the aggregate at the result shown", () => {
  const p = mapped(APP);
  const h = held(all({ repoViews: [view("r1"), view("r2", { unknown: true })], tile: { commits: 3, branches: 1 } }));
  const g = gitDetailView(p, input(h), TODAY);
  expect(g.tiles.find((t) => t.key === "onlyHere")?.asOf).toBe("as of 09:10");
  expect(g.goodMorningLine).toBe("3 commits exist only on this Mac. See Suggested.");
  expect(g.goodMorningAsOf).toBe("as of 09:10");
  const later = held(all({ checkedAt: at(9, 20), repoViews: [view("r1"), view("r2", { unknown: true })], tile: { commits: 4, branches: 1 } }), h);
  const g2 = gitDetailView(p, input(later), TODAY);
  expect(g2.tiles.find((t) => t.key === "onlyHere")?.asOf).toBe("as of 09:20");
  const recovered = held(all({ checkedAt: at(9, 30), repoViews: [view("r1"), view("r2")], tile: { commits: 4, branches: 1 } }), later);
  expect(gitDetailView(p, input(recovered), TODAY).goodMorningAsOf).toBeNull();
});

test("final3 L3 push card words omit zero-share branches and default parts", () => {
  const g = gitDetailView(mapped(APP), input(held(all({ repoViews: [view("r1")], pushCards: [{
    repoKey: "r1", storeKey: "s-r1", repoName: "app", firstLabel: "app", branches: [{ name: "feat", commits: 1 }, { name: "feat-backup", commits: 0 }], onDefault: { name: "main", commits: 0 },
  }], tile: { commits: 1, branches: 2 } }))), TODAY);
  expect(g.pushCards[0]?.text).toBe("Push your work: 1 commit on feat exists only on this Mac");
});

for (const recorded of [false, true]) test(`final3 M1 Good morning uses one common store (record=${recorded})`, async () => {
  const { env } = isolatedGit();
  const repo = await newRepo();
  await g(repo, ["remote", "add", "origin", join(scratch("unused-remote"), "origin.git")], env);
  await g(repo, ["update-ref", "refs/remotes/origin/main", "main"], env);
  await g(repo, ["checkout", "-q", "-b", "feat"], env);
  const shas = [];
  for (let n = 0; n < 3; n++) shas.push(await commitAt(repo, env, { [`f${n}.txt`]: "work" }, "work", "2026-10-16T08:00:00Z"));
  const wt = join(scratch("linked"), "wt");
  await g(repo, ["worktree", "add", "-q", "--detach", wt, "main"], env);
  const sub = join(repo, "sub"); mkdirSync(sub);
  const paths = [repo, wt, sub];
  const { result } = await withGit(env, () => reposStatus({ scope: "all", pageDate: TODAY, labels: [{ key: "app", tokens: shas.map((s) => s.slice(0, 7)) }], branches: [] }, {
    now: () => new Date(at(9, 10)), tmpRoot: scratch("squash"), loadConfig: async () => ({ repos: paths }),
    readRecord: async () => recorded ? { accepted: true, record: { schemaVersion: 1, date: TODAY, repos: paths, windowStartUtc: "2026-10-15T00:00:00Z", labels: { app: { repo, root: null } }, commits: [], missing: [] } } : { accepted: false },
  }));
  if (result.scope !== "all") throw new Error("expected all");
  const detail = gitDetailView(mapped(APP), input(held(all(result))), TODAY);
  expect(detail.goodMorningLine).toBe("3 commits exist only on this Mac. See Suggested.");
  expect(detail.tiles.find((t) => t.key === "onlyHere")?.value).toBe("3 commits on 1 branch");
  expect(detail.pushCards).toHaveLength(1);
  expect(result.labels[0]?.notMatched).toBe(0);
});

test("final3 L3 a held same-tip card preserves both branches in the aggregate M", () => {
  const p = mapped(APP);
  const first = held(all({ repoViews: [view("r1")], pushCards: [{ repoKey: "r1", storeKey: "s-r1", repoName: "app", firstLabel: "app", branches: [{ name: "feat", commits: 1 }, { name: "feat-backup", commits: 0 }], onDefault: null }], tile: { commits: 1, branches: 2 } }));
  const failed = held(all({ checkedAt: at(9, 20), repoViews: [view("r1", { unknown: true })] }), first);
  expect(gitDetailView(p, input(failed), TODAY).tiles.find((t) => t.key === "onlyHere")?.value).toBe("1 commit on 2 branches");
});

/* ── B1 final review round 4 ───────────────────────────────────────────────────────────────────── */

describe("final4 M1: a store's push work is held once, whichever of its checkouts hosts it", () => {
  const p = mapped(APP);
  const card = (repoKey: string) => ({ repoKey, storeKey: "S", firstLabel: "app", repoName: "app", branches: [{ name: "feat", commits: 2 }], onDefault: null });
  const first = all({ checkedAt: at(9, 0), repoViews: [view("rA", { store: "S" }), view("rB", { store: "S" })], pushCards: [card("rA")], tile: { commits: 2, branches: 1 } });

  test("A hosts, then A answers unknown and B hosts: one card, B's; the tile and Good morning count it once, current", () => {
    const next = all({ checkedAt: at(9, 30), repoViews: [view("rA", { unknown: true }), view("rB", { store: "S" })], pushCards: [card("rB")], tile: { commits: 2, branches: 1 } });
    const h = held(next, held(first));
    expect(h.reply.pushCards.map((c) => c.repoKey)).toEqual(["rB"]);
    expect(h.reply.tile).toEqual({ commits: 2, branches: 1 });
    expect(h.asOf.repos).toEqual({ rA: at(9, 0) });                   // A's own checkout data is still kept, dated
    const v = gitDetailView(p, input(h), TODAY);
    expect(v.pushCards.map((c) => c.key)).toEqual(["push:rB"]);
    expect(v.goodMorningLine).toBe("2 commits exist only on this Mac. See Suggested.");
    expect(v.goodMorningAsOf).toBeNull();                            // B answered the store just now
    expect(v.tiles.find((t) => t.key === "onlyHere")).toMatchObject({ value: "2 commits on 1 branch", asOf: null });
  });

  test("a current checkout of the store with no card means nothing to push: A's old card and share are not restored", () => {
    const next = all({ checkedAt: at(9, 30), repoViews: [view("rA", { unknown: true }), view("rB", { store: "S" })], tile: { commits: 0, branches: 0 } });
    const h = held(next, held(first));
    expect(h.reply.pushCards).toEqual([]);
    expect(h.reply.tile).toEqual({ commits: 0, branches: 0 });
  });

  test("B hosted while A was unknown; A answers and hosts while B is stale: one card, A's", () => {
    const prev = all({ checkedAt: at(9, 0), repoViews: [view("rA", { unknown: true }), view("rB", { store: "S" })], pushCards: [card("rB")], tile: { commits: 2, branches: 1 } });
    const next = all({ checkedAt: at(9, 30), repoViews: [view("rA", { store: "S" }), view("rB", { store: "S" })], pushCards: [card("rA")], tile: { commits: 2, branches: 1 } }, { unknownRepos: ["rB"] });
    const h = held(next, held(prev));
    expect(h.reply.pushCards.map((c) => c.repoKey)).toEqual(["rA"]);
    expect(h.reply.tile).toEqual({ commits: 2, branches: 1 });
  });

  test("control: with no current checkout of the store, A's card and its share still come back", () => {
    const next = all({ checkedAt: at(9, 30), repoViews: [view("rA", { unknown: true }), view("rB", { unknown: true })], tile: { commits: 0, branches: 0 } });
    const h = held(next, held(first));
    expect(h.reply.pushCards.map((c) => c.repoKey)).toEqual(["rA"]);
    expect(h.reply.tile).toEqual({ commits: 2, branches: 1 });
    expect(gitDetailView(p, input(h), TODAY).goodMorningAsOf).toBe("as of 09:00");
  });
});

test("final4 L1 a partly pushed row whose unpushed commits are all outside the window draws no amber \"0 not pushed\"", () => {
  const rows = [branchRow("feat/a", ["a"], { state: "partly", notPushed: 0 }), defaultRow("main", ["b"], { state: "partly", notPushed: 0 }), branchRow("feat/b", ["c"], { state: "partly", notPushed: 2 }), defaultRow("trunk", ["d"], { state: "partly", notPushed: 1 })];
  const c = gitDetailView(mapped(APP), input(held(all({ repoViews: [view("r1")], labels: [label("app", "r1", rows)] }))), TODAY).cards[0]!;
  if (c.mode !== "detail") throw new Error("expected the detail");
  expect(c.rows.map((r) => r.amber)).toEqual([null, null, "2 not pushed", "1 not pushed"]);
});

test("final4 L2 a repo and its configured subdirectory share one working tree: one \"Not committed\" tile; linked worktrees stay separate", () => {
  const p = mapped(APP);
  const NOW = new Date(2026, 9, 16, 9, 30).getTime();
  const tiles = (views: ReposAllReply["repoViews"]) => launchpadTiles(gitDetailView(p, input(held(all({ repoViews: views }))), TODAY), NOW);
  const shared = tiles([view("r1", { count: 2, name: "app", store: "S", tree: "T" }), view("r2", { count: 2, name: "app/sub", store: "S", tree: "T" })]);
  expect(shared.tiles.map((t) => [t.key, t.value])).toEqual([["uncommitted:r1", "2 files in app"]]);
  expect(shared.waiting).toBe(1);
  expect(liveMoodLine(null, shared)).toBe("One thing is waiting.");
  const linked = tiles([view("r1", { count: 2, store: "S", tree: "T1" }), view("r3", { count: 1, store: "S", tree: "T2" })]);
  expect(linked.tiles.map((t) => t.key)).toEqual(["uncommitted:r1", "uncommitted:r3"]);
  expect(liveMoodLine(null, linked)).toBe("A couple of things are waiting.");
});

test("final5 L3 a shared working tree's \"Not committed\" tile names the view at the tree's top level, whatever the reply's order", () => {
  const p = mapped(APP);
  const NOW = new Date(2026, 9, 16, 9, 30).getTime();
  const tiles = (views: ReposAllReply["repoViews"]) => launchpadTiles(gitDetailView(p, input(held(all({ repoViews: views }))), TODAY), NOW);
  // The engine hashes the same real path into a repo key ("r" + 12 hex) and a tree key ("t" + 12 hex), so the
  // top-level view's key and its tree key share their hex (`src/repos/status.ts`'s `pathKey`).
  const top = view("raaaaaaaaaaaa", { count: 3, name: "app", store: "saaaaaaaaaaaa", tree: "taaaaaaaaaaaa" });
  const sub = view("rbbbbbbbbbbbb", { count: 3, name: "app/sub", store: "saaaaaaaaaaaa", tree: "taaaaaaaaaaaa" });
  for (const views of [[sub, top], [top, sub]]) {
    expect(tiles(views).tiles.map((t) => [t.key, t.value])).toEqual([["uncommitted:raaaaaaaaaaaa", "3 files in app"]]);
  }
  // With no top-level view in the list (two subdirectories), the first view in the reply's order names it.
  const sub2 = view("rcccccccccccc", { count: 3, name: "app/other", store: "saaaaaaaaaaaa", tree: "taaaaaaaaaaaa" });
  expect(tiles([sub2, sub]).tiles.map((t) => t.value)).toEqual(["3 files in app/other"]);
  // The tile keeps the first view's place: a tree listed before another stays before it.
  const lib = view("rdddddddddddd", { count: 1, name: "lib" });
  expect(tiles([sub, lib, top]).tiles.map((t) => t.value)).toEqual(["3 files in app", "1 file in lib"]);
});

test("final6 L3 a shared working tree's tile prefers a view whose count is current over a top-level view's carried count", () => {
  const p = mapped(APP);
  const NOW = new Date(2026, 9, 16, 9, 30).getTime();
  const T = { store: "saaaaaaaaaaaa", tree: "taaaaaaaaaaaa" };
  const top = (count: number | null) => view("raaaaaaaaaaaa", { count, name: "app", ...T });
  const sub = (count: number | null) => view("rbbbbbbbbbbbb", { count, name: "app/sub", ...T });
  const before = held(all({ repoViews: [sub(3), top(3)] }, { uncommittedAt: at(9, 14) }));
  const tile = (h: GitHeld) => {
    const t = launchpadTiles(gitDetailView(p, input(h), TODAY), NOW).tiles;
    return t.map((x) => [x.key, x.value, x.asOf]);
  };
  // The top-level view's count is carried forward ("as of"), the subdirectory's is current: the current one names it.
  const topStale = held(all({ repoViews: [sub(5), top(null)] }, { uncommittedAt: at(9, 20) }), before);
  expect(topStale.asOf.uncommitted).toEqual({ raaaaaaaaaaaa: at(9, 14) });               // PREMISE: the top's count is stale
  expect(tile(topStale)).toEqual([["uncommitted:rbbbbbbbbbbbb", "5 files in app/sub", null]]);
  // Whatever the reply's order.
  expect(tile(held(all({ repoViews: [top(null), sub(5)] }, { uncommittedAt: at(9, 20) }), before))).toEqual([["uncommitted:rbbbbbbbbbbbb", "5 files in app/sub", null]]);
  // No view in the tree is current: the top-level view names it, with its time.
  const allStale = held(all({ repoViews: [sub(null), top(null)] }, { uncommittedAt: at(9, 20) }), before);
  expect(tile(allStale)).toEqual([["uncommitted:raaaaaaaaaaaa", "3 files in app", "as of 09:14"]]);
  // A current top-level view still wins over a current subdirectory view (final5 L3).
  expect(tile(held(all({ repoViews: [sub(5), top(5)] }), before))).toEqual([["uncommitted:raaaaaaaaaaaa", "5 files in app", null]]);
});

test("final4 L7 Where you left off with only the status counts current: the branch words say \"as of\", the not-committed tag does not", () => {
  const p = mapped(page({ recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }], branchState: [{ repo: "app", text: "On branch feat/a (ahead 2, behind 1)" }] }));
  const r = held(all({
    checkedAt: at(9, 10), labels: [label("app", "r1", [])], repoViews: [view("r1", { count: 2 })],
    branchLines: [{ key: "app", name: "feat/a", state: "live", notPushed: 1, neverPushed: false, behind: 0 }],
  }, { uncommittedAt: at(9, 14) }));
  expect(gitDetailView(p, input(r, { fresh: false, uncommittedFresh: true }), TODAY).leftOff[0]).toMatchObject({ asOf: "as of 09:10", uncommitted: "2 files not committed", uncommittedAsOf: null });
  expect(gitDetailView(p, input(r, { fresh: false }), TODAY).leftOff[0]).toMatchObject({ asOf: "as of 09:10", uncommittedAsOf: "as of 09:14" });
});

test("screenshot 05d: Where you left off dates no branch that has no words beside it", () => {
  const p = mapped(page({ recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }], branchState: [{ repo: "app", text: "On branch main (ahead 0, behind 0)" }] }));
  const at910 = (branchLines: ReposAllReply["branchLines"]) =>
    gitDetailView(p, input(held(all({ checkedAt: at(9, 10), labels: [label("app", "r1", [])], repoViews: [view("r1", { count: 0 })], branchLines })), { fresh: false }), TODAY).leftOff[0];
  // No line for the branch and no page words: nothing to date (the notCurrent screenshot's lib card).
  expect(at910([])).toMatchObject({ counts: [], pushTag: null, asOf: null });
  // A live line with nothing to say (pushed, not behind): nothing to date either.
  expect(at910([{ key: "app", name: "main", state: "live", notPushed: 0, neverPushed: false, behind: 0 }])).toMatchObject({ counts: [], pushTag: null, asOf: null });
  // CONTROL: the same answer with words beside the tag is dated.
  expect(at910([{ key: "app", name: "main", state: "live", notPushed: 1, neverPushed: false, behind: 0 }])).toMatchObject({ pushTag: "1 not pushed", asOf: "as of 09:10" });
  expect(at910([{ key: "app", name: "main", state: "live", notPushed: 0, neverPushed: false, behind: 2 }])).toMatchObject({ counts: ["behind 2"], asOf: "as of 09:10" });
});



describe("B2-M5-T13: handles belong only to the next current repos", () => {
  const action = (repoKey: string, handle: string): ReposAllReply["actions"][number] => ({
    repoKey, cardKind: "did", cardId: repoKey,
    handles: [{ handle, target: "branch", row: 0, sha: null, project: null, label: null }],
  });
  const first = all({ repoViews: [view("r1"), view("r2")], actions: [action("r1", "old-r1"), action("r2", "old-r2")] });

  test("drops handles for an unknown repo even when mergeReply retains its old rows", () => {
    const next = all({ repoViews: [view("r1", { unknown: true }), view("r2")], actions: [action("r1", "bad-r1"), action("r2", "new-r2"), action("absent", "bad-absent")] });
    const h = held(next, held(first));
    expect(h.reply.repoViews[0]!.state).toBe("ok");
    expect(h.asOf.repos.r1).toBeDefined();
    expect(h.reply.actions).toEqual([action("r2", "new-r2")]);
  });

  test("unknownRepos drops handles; a current held reply uses only next, including an empty invalidation", () => {
    expect(held(all({ repoViews: [view("r1"), view("r2")], actions: [action("r1", "bad"), action("r2", "new")] }, { gate: "held", unknownRepos: ["r1"] }), held(first)).reply.actions).toEqual([action("r2", "new")]);
    expect(held(all({ repoViews: [view("r1")] }, { gate: "held" }), held(first)).reply.actions).toEqual([]);
    expect(held(all({ repoViews: [view("r1")], actions: [action("r1", "current")] }, { gate: "held" }), held(first)).reply.actions).toEqual([action("r1", "current")]);
  });

  test("noResult keeps the previous object; before any result there are no handles", () => {
    const before = held(first);
    expect(mergeReply(before, NO_RESULT)).toBe(before);
    expect(mergeReply(null, NO_RESULT)).toBeNull();
  });
});
