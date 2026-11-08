/** B2-M5-T13/T14: pure action models and deferred inventory reads. No real opener/editor/clipboard. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderBriefing } from "../../src/render";
import type { BriefingStruct } from "../../src/types";
import { actionKey, actionRuns, actionsPageKey, COPIED_LINE_MS, actionsView, choiceRefusalText, chooseAndOpen, chooserView, copyReplyLines, EDITOR_FLOW_IDLE, editorClick, editorFlow, lineOf, liveEditorButton, EDITOR_LABELS, editorOpenText, githubReplyText, onNewPage, reopensChooser, resumeTiles, type ActionLine, type GithubButton, type ActionsInput, type EditorButton, type EditorFlowState } from "../src/lib/actions";
import { actionsLive, editorLinksLive, type ActionsLiveState, type EditorLinksState } from "../src/lib/actions-live";
import { appPrefs, loadAppPrefs, setGithubLinks, type AppPrefsSetOutcome, type EditorChoice, type EditorId } from "../src/lib/app-prefs-store";
import { renderMarkdown } from "../src/lib/briefing-md";
import { DECK_INPUT_WITHOUT_RESERVED, deckView, mapPage, type DeckPage } from "../src/lib/deck";
import type { CopyPushCommandReply, EditorChoiceSetReply, EditorListReply, EditorOpenReply, OpenGithubReply } from "../src/lib/engine";
import { gitDetailView, launchpadHeading, launchpadTiles, mergeReply, type ActionCard, type GitHeld, type PushCard, type RepoView, type ReposAllReply, type ReposHeldReply, type ReposIpcReply, type ReplyRow } from "../src/lib/git-detail";
import { gitLive, liveActionCards } from "../src/lib/git-live";
import type { Os } from "../src/lib/platform";
import { todayModel } from "../src/lib/today";

const TODAY = "2026-10-16";
const SHA = "abcdef0123456789012345678901234567890123";
const OTHER = "abcdef0999999999999999999999999999999999";
const text = renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude",
  resume: [{ repo: "app", text: "keep going" }], branchState: [{ repo: "app", text: "On branch feature (ahead 1, behind 0)" }],
  recap: [{ repo: "app", text: "shipped", evidence: SHA.slice(0, 7) }],
  suggestions: [{ repo: "app", text: "Review #12" }],
} as BriefingStruct);
const mapped = mapPage(renderMarkdown(text), TODAY);
if (!mapped.ok) throw new Error("action fixture must map");
const page = mapped.page;
const handle = (target: ActionCard["handles"][number]["target"], id: string = target, extra: Partial<ActionCard["handles"][number]> = {}): ActionCard["handles"][number] => ({
  handle: id, target, row: null, sha: null, project: null, label: null, ...extra,
});
const card = (cardKind: ActionCard["cardKind"], handles: ActionCard["handles"], cardId = "app", repoKey = "r1"): ActionCard => ({ repoKey, cardKind, cardId, handles });
const repo = { key: "r1", name: "app", state: "ok" as const, noRemote: false, uncommitted: { count: 0 }, storeKey: "s1", treeKey: "t1" };
const branch: ReplyRow = { kind: "branch", name: "feature", push: { state: "partly", notPushed: 1 }, commits: [{ sha: SHA, token: SHA.slice(0, 7) }, { sha: OTHER, token: null, subject: "another" }] };
const pr: ReplyRow = { kind: "pr", number: 12, title: "shipped", commits: [{ sha: SHA, token: SHA.slice(0, 7) }] };
function replyOf(cards: ActionCard[], rows: ReplyRow[] = [pr], patch: Partial<ReposAllReply> = {}): ReposIpcReply {
  return { schemaVersion: 1, scope: "all", checkedAt: "2026-10-16T09:00:00Z", record: { accepted: false, windowStartUtc: null }, windowStartUtc: null,
    repoViews: [repo], labels: [{ key: "app", repoKey: "r1", state: "ok", rows, notMatched: 0, prNumbers: [12], onlyHere: 1 }],
    branchLines: [{ key: "app", name: "feature", state: "live", notPushed: 1, neverPushed: false, behind: 0 }],
    pushCards: [{ repoKey: "r1", storeKey: "s1", firstLabel: "app", repoName: "app", branches: [{ name: "feature", commits: 1 }], onDefault: { name: "main", commits: 1 } }],
    actions: cards, tile: { commits: 2, branches: 2 }, hidden: { complete: true, perLabel: {} }, ...patch,
    gate: "held", heldAt: 1, uncommittedAt: "2026-10-16T09:00:00Z", unknownRepos: [],
  };
}
function held(cards: ActionCard[], rows: ReplyRow[] = [pr], patch: Partial<ReposAllReply> = {}): GitHeld {
  const h = mergeReply(null, replyOf(cards, rows, patch));
  if (h === null) throw new Error("held fixture");
  return h;
}
function input(cards: ActionCard[], patch: Partial<ActionsInput> = {}): ActionsInput {
  return { cards, githubLinks: true, os: "macos", choices: new Map(), error: null, ...patch };
}
const EMPTY = { did: [], leftOff: [], push: [], suggestions: [], tile: null, resume: [], editorError: null };
const allCards = [
  card("did", [handle("pr", "pr", { row: 0 }), handle("commit", "commit", { row: 0, sha: SHA }), handle("copy", "never-did-copy", { row: 0 })]),
  card("leftOff", [handle("branch"), handle("compare", "compare", { label: "trunk" }), handle("copy"), handle("editor", "editor", { project: "p1" })]),
  card("push", [handle("copy", "push-feature"), handle("copy", "push-main")], "push:r1"),
  card("tile", [handle("copy", "tile-feature"), handle("copy", "tile-main")], "onlyHere"),
];
const model = (cards = allCards, p = page, h: GitHeld | null = held(cards), patch: Partial<ActionsInput> = {}) => actionsView(p, input(cards, patch), h);

describe("the card models use held groups and opaque handles", () => {
  test("PR row has only Open PR; commits have their own reachable full-SHA handle, never Copy", () => {
    const out = model();
    expect(out.did[0]!.key).toBe("app");
    expect(out.did[0]!.rows[0]!.button).toEqual({ target: "pr", handle: "pr", label: "Open PR ↗" });
    expect(out.did[0]!.rows[0]!.commits).toEqual([{ sha: SHA, button: { target: "commit", handle: "commit", label: "Open on GitHub" } }]);
    expect(JSON.stringify(out.did)).not.toContain("never-did-copy");
    expect(out.leftOff[0]!.buttons.map((b) => b.label)).toEqual(["Open branch ↗", "Compare with trunk", "Open in editor…"]);
    expect(out.leftOff[0]!.copy).toEqual({ handles: ["copy"], label: "Copy push command", suffix: null });
    expect(out.push[0]).toEqual({ key: "push:r1", copy: { handles: ["push-feature", "push-main"], label: "Copy push command", suffix: null } });
  });

  test.each(["branch", "remoteBranch", "default", "tag", "detached", "orphan"] as const)("%s row controls and individually reachable commits, including hidden ones", (kind) => {
    const row: ReplyRow = kind === "branch" || kind === "default" ? { ...branch, kind }
      : kind === "remoteBranch" || kind === "tag" ? { kind, name: "origin/feature", commits: branch.commits }
      : { kind, commits: branch.commits };
    const cards = [card("did", [handle("branch", "branch", { row: 0 }), handle("compare", "no-self-compare", { row: 0, label: "main" }), handle("pr", "not-a-pr", { row: 0 }), handle("commit", "reachable", { row: 0, sha: OTHER })])];
    const rowView = model(cards, page, held(cards, [row])).did[0]!.rows[0]!;
    expect(rowView.button?.label ?? null).toBe(["branch", "remoteBranch", "default"].includes(kind) ? "Open branch ↗" : null);
    expect(rowView.commits).toEqual([{ sha: OTHER, button: { target: "commit", handle: "reachable", label: "Open on GitHub" } }]);
    expect(JSON.stringify(rowView)).not.toContain(SHA);
  });

  test("never-pushed work has no branch link without a handle; wrong card kind/id/row/SHA never decorates it", () => {
    const cards = [card("did", [handle("branch", "wrong-row", { row: 1 }), handle("commit", "wrong-sha", { row: 0, sha: "f".repeat(40) })]), card("did", [handle("branch", "wrong-card", { row: 0 })], "lib"), card("leftOff", [handle("branch", "wrong-kind", { row: 0 })])];
    const out = model(cards, page, held(cards, [{ ...branch, push: { state: "never", notPushed: 2 } }]));
    expect(out.did[0]!.rows[0]).toEqual({ row: 0, button: null, commits: [] });
  });

  test("noRemote allows only editor; missing or detached branches have no left-off targets", () => {
    const noRemote = held(allCards, [pr], { repoViews: [{ ...repo, noRemote: true }], branchLines: [{ key: "app", name: "feature", state: "noRemote" }] });
    const out = model(allCards, page, noRemote);
    expect(out.did).toEqual([]);
    expect(out.push).toEqual([]);
    expect(out.leftOff[0]!.buttons.map((b) => b.target)).toEqual(["editor"]);
    expect(out.leftOff[0]!.copy).toBeNull();
    expect(model(allCards, page, held(allCards, [pr], { branchLines: [{ key: "app", name: "feature", state: "missing" }] })).leftOff).toEqual([]);
    const detached: DeckPage = { ...page, leftOff: { ...page.leftOff, cards: page.leftOff.cards.map((c) => ({ ...c, branch: { kind: "detached", sha: "abcdef0" } })) } };
    expect(model(allCards, detached).leftOff).toEqual([]);
    expect(model(allCards, page, held(allCards, [pr], { branchLines: [] })).leftOff).toEqual([]);
  });

  test("left-off copy requires B1's live push tag; saved-page ahead words never supply it", () => {
    const noTag = held(allCards, [pr], { branchLines: [{ key: "app", name: "feature", state: "live", notPushed: 0, neverPushed: false, behind: 0 }] });
    expect(model(allCards, page, noTag).leftOff[0]!.copy).toBeNull();
    const never = held(allCards, [pr], { branchLines: [{ key: "app", name: "feature", state: "live", notPushed: 0, neverPushed: true, behind: 0 }] });
    expect(model(allCards, page, never).leftOff[0]!.copy?.handles).toEqual(["copy"]);
  });

  test("older pages hide every T13 surface; before any answer and after invalidation there are no actions", () => {
    expect(model(allCards, { ...page, stale: true })).toEqual(EMPTY);
    expect(model(allCards, page, null)).toEqual(EMPTY);
    expect(model([], page, held([])).did[0]!.rows[0]!.button).toBeNull();
    expect(model([], page, held([])).leftOff).toEqual([]);
    expect(model([], page, held([])).push).toEqual([]);
    const h = held(allCards);
    h.asOf.repos.r1 = h.reply.checkedAt;
    expect(model(allCards, page, h).push).toEqual([]);
    expect(model(allCards, page, h).did).toEqual([]);
    expect(model(allCards, page, h).leftOff).toEqual([]);
  });

  test("links off hides GitHub and Compare immediately, preserving editor and copy on every OS", () => {
    for (const os of ["macos", "linux", "windows", "other"] as const) {
      const out = model(allCards, page, held(allCards), { githubLinks: false, os });
      expect(out.did[0]!.rows[0]!.button).toBeNull();
      expect(out.did[0]!.rows[0]!.commits).toEqual([]);
      expect(out.suggestions[0]!.button).toBeNull();
      expect(out.leftOff[0]!.buttons.map((b) => b.target)).toEqual(os === "macos" ? ["editor"] : []);
      expect(out.leftOff[0]!.copy?.suffix).toBe(os === "windows" ? "for Git Bash" : null);
      expect(out.push[0]!.copy.suffix).toBe(os === "windows" ? "for Git Bash" : null);
    }
  });

  test("editor labels match project keys and the pinned closed enum; unknown/ask/null all ask", () => {
    expect(Object.values(EDITOR_LABELS)).toEqual(["VS Code", "Cursor", "Windsurf", "Zed", "Sublime Text", "Xcode", "IntelliJ IDEA", "PyCharm", "WebStorm", "GoLand", "RustRover", "CLion", "Rider", "RubyMine", "PhpStorm", "DataGrip"]);
    for (const choice of [undefined, null, "ask", "cursor"] as const) {
      const choices = choice === undefined ? new Map() : new Map([["p1", choice], ["other", "zed" as const]]);
      const editor = model(allCards, page, held(allCards), { choices }).leftOff[0]!.buttons.find((b) => b.target === "editor")!;
      expect(editor.label).toBe(choice === "cursor" ? "Open in Cursor" : "Open in editor…");
      expect(editor).toMatchObject({ project: "p1", choice });
    }
  });

  test("the editor labels equal Rust's table, id by id and in its order", () => {
    const rust = readFileSync(new URL("../src-tauri/src/editor.rs", import.meta.url), "utf8");
    const ids = new Map([...rust.matchAll(/#\[serde\(rename = "([^"]+)"\)\]\s+(\w+),/g)].map((m) => [m[2]!, m[1]!]));
    const body = /pub fn label\(self\) -> &'static str \{([\s\S]*?)\n {4}\}/.exec(rust)?.[1];
    if (body === undefined) throw new Error("editor.rs has no label table");
    const table = [...body.matchAll(/Self::(\w+) => "([^"]+)"/g)].map((m) => [ids.get(m[1]!), m[2]!]);
    expect(table).toHaveLength(16);
    expect(table).toEqual(Object.entries(EDITOR_LABELS));
  });

  test("deck input stays optional and publishes actions separately from B1 and the reserved A2 input", () => {
    expect(deckView(DECK_INPUT_WITHOUT_RESERVED).kind).toBe("single");
    const args = { model: todayModel({ snapshot: null, latest: { state: "loaded", file: { path: "/fixture/page.md", text, bytes: text.length } }, lastRun: null, today: TODAY }), today: TODAY, firstName: null };
    const gitDetail = { reply: held(allCards), fresh: true, os: "macos" as const, greenSince: {} };
    const view = deckView({ ...args, gitDetail, actions: input(allCards) });
    if (view.kind !== "slides") throw new Error("slides");
    expect(view.actions).toEqual(model());
    expect(view.git).not.toBeNull();
    const omitted = deckView(args);
    if (omitted.kind !== "slides") throw new Error("slides");
    expect(omitted.actions).toBeNull();
  });
});

describe("suggestions match only their own held groups", () => {
  const suggestion = (text: string, key: string | null = "app"): DeckPage => ({ ...page, suggested: { ...page.suggested, cards: [{ n: 1, text, key, label: key, slot: 0, marker: null }] } });
  const inline = (text: string, cards = allCards, rows: ReplyRow[] = [pr], key: string | null = "app") => model(cards, suggestion(text, key), held(cards, rows)).suggestions[0]!.button;
  test("one PR target counted once even when mentioned repeatedly; no cross-project or null-key match", () => {
    expect(inline("Review #12, then #12")?.handle).toBe("pr");
    expect(inline("Review #12", allCards, [pr], "lib")).toBeNull();
    expect(inline("Review #12", allCards, [pr], null)).toBeNull();
    expect(inline("Review #99")).toBeNull();
    expect(inline("Review #12 and " + SHA)).toBeNull();
  });
  test("7–40 hex prefixes must be unique among all the card's commits, including commits without a handle", () => {
    const cards = [card("did", [handle("commit", "sha", { row: 0, sha: SHA })])];
    expect(inline(SHA, cards, [branch])?.handle).toBe("sha");
    expect(inline(SHA.slice(0, 8), cards, [branch])?.handle).toBe("sha");
    expect(inline(SHA.slice(0, 7), cards, [branch])).toBeNull(); // OTHER shares that prefix, without a handle.
    expect(inline(SHA.slice(0, 6), cards, [branch])).toBeNull();
    expect(inline(SHA + "0", cards, [branch])).toBeNull();
    expect(inline("x" + SHA, cards, [branch])).toBeNull();
    expect(inline(SHA + " " + SHA, cards, [branch])?.handle).toBe("sha");
  });
  test("a long PR number is not also interpreted as a SHA prefix", () => {
    const number = 1234567;
    const sha = "1234567" + "a".repeat(33);
    const rows: ReplyRow[] = [{ ...pr, number }, { ...branch, commits: [{ sha, token: sha.slice(0, 7) }] }];
    const cards = [card("did", [handle("pr", "pr-number", { row: 0 }), handle("commit", "numeric-sha", { row: 1, sha })])];
    expect(inline("Review #1234567", cards, rows)?.handle).toBe("pr-number");
    expect(inline("Review 1234567", cards, rows)?.handle).toBe("numeric-sha");
  });
  test("#N written as another repo's reference is not this project's PR", () => {
    for (const other of ["Review other-org/other-repo#12", "See lib#12", "See lib/#12", "See v1.#12", "See x-#12"]) expect(inline(other)).toBeNull();
    for (const own of ["Review #12", "(#12)", "PR: #12, soon", "#12"]) expect(inline(own)?.handle).toBe("pr");
  });
  test("a SHA written inside another reference is not this project's commit", () => {
    const cards = [card("did", [handle("commit", "sha", { row: 0, sha: SHA })])];
    const prefix = SHA.slice(0, 8);
    for (const other of [`other/repo@${prefix}`, `https://github.com/other/repo/commit/${prefix}`, `.../commit/${prefix}`, `v1.${prefix}`, `fix-${prefix}`, `#${prefix}`]) expect(inline(other, cards, [branch])).toBeNull();
    for (const own of [prefix, `(${prefix})`, `Look at ${prefix}, then ship`]) expect(inline(own, cards, [branch])?.handle).toBe("sha");
  });
  describe("two references joined by a separator are two targets, whatever the left guards say", () => {
    const second = "1234567" + "b".repeat(33);
    const prefix = SHA.slice(0, 8);
    const pr13: ReplyRow = { ...pr, number: 13 };
    const onlyPr = [card("did", [handle("pr", "pr-12", { row: 0 })])];
    const onlyCommit = [card("did", [handle("commit", "sha", { row: 0, sha: SHA })])];
    const twoCommits: ReplyRow[] = [{ ...pr, commits: [{ sha: SHA, token: SHA.slice(0, 7) }, { sha: second, token: second.slice(0, 7) }] }];
    test.each(["Review #12/#13", "Review #13/#12", "#12-#13", "#13-#12", "#12..#13", "#13...#12"])("%s has no button, with both in the group or one outside it", (text) => {
      expect(inline(text, onlyPr, [pr, pr13])).toBeNull();
      expect(inline(text, onlyPr, [pr])).toBeNull();
    });
    test.each([[prefix, "1234567"], ["1234567", prefix]])("the SHAs %s and %s joined by .., ..., / or - have no button, in either order", (a, b) => {
      for (const joiner of ["..", "...", "/", "-"]) {
        expect(inline(`${a}${joiner}${b}`, onlyCommit, twoCommits)).toBeNull();
        expect(inline(`${a}${joiner}${b}`, onlyCommit, [pr])).toBeNull();
      }
    });
    test.each([`#12/${prefix}`, `${prefix}/#12`, `#12-${prefix}`, `${prefix}-#12`])("a PR and a SHA joined as %s have no button", (text) => {
      expect(inline(text, onlyPr, [pr])).toBeNull();
    });
    test("another repo's reference still gets none, and a lone reference beside plain words still gets its button", () => {
      for (const other of ["owner/repo#12", "lib#12", "See lib/#12", "See v1.#12", "See x-#12"]) expect(inline(other, onlyPr, [pr])).toBeNull();
      for (const own of ["Review #12/fix", "#12-fix", "#12.", "fix/#12 no", "#12 / #13"]) {
        expect(inline(own, onlyPr, [pr])?.handle ?? null).toBe(own === "fix/#12 no" ? null : "pr-12");
      }
      expect(inline("Review #12, #13", onlyPr, [pr, pr13])).toBeNull(); // Plain counting: two standalone targets.
      for (const own of [`${prefix}-dirty`, `${prefix}.`, `${prefix}/x`]) expect(inline(own, onlyCommit, [pr])?.handle).toBe("sha");
    });
  });
  describe("every target in the group counts, handled or not; exactly one, and it must have a handle", () => {
    const other = "1111111" + "2".repeat(33);
    const rows: ReplyRow[] = [pr, { ...branch, commits: [{ sha: other, token: other.slice(0, 7) }] }];
    const commitOnly = [card("did", [handle("commit", "commit-only", { row: 1, sha: other })])];
    const prOnly = [card("did", [handle("pr", "pr-only", { row: 0 })])];
    test("an unhandled PR and a handled commit are two targets, in either order", () => {
      expect(inline(`Review #12 then ${other.slice(0, 8)}`, commitOnly, rows)).toBeNull();
      expect(inline(`Review ${other.slice(0, 8)} then #12`, commitOnly, rows)).toBeNull();
    });
    test("a handled PR and an unhandled commit are two targets, in either order", () => {
      expect(inline(`Review #12 then ${other.slice(0, 8)}`, prOnly, rows)).toBeNull();
      expect(inline(`Review ${other.slice(0, 8)} then #12`, prOnly, rows)).toBeNull();
    });
    test("one target with no handle answers null; one with a handle answers its button", () => {
      expect(inline("Review #12", commitOnly, rows)).toBeNull();
      expect(inline(`Look at ${other.slice(0, 8)}`, prOnly, rows)).toBeNull();
      expect(inline("Review #12", prOnly, rows)?.handle).toBe("pr-only");
      expect(inline(`Look at ${other.slice(0, 8)}`, commitOnly, rows)?.handle).toBe("commit-only");
    });
    test("a PR on two rows is one target, and either row's handle answers for it", () => {
      expect(inline("Review #12", [card("did", [handle("pr", "second-row", { row: 1 })])], [pr, { ...pr }])?.handle).toBe("second-row");
      expect(inline("Review #12", [card("did", [handle("pr", "first-row", { row: 0 })])], [pr, { ...pr }])?.handle).toBe("first-row");
    });
    test("an ambiguous prefix answers null beside #N, in either order", () => {
      const both: ReplyRow[] = [{ ...pr, commits: branch.commits }];
      expect(inline("Review #12", prOnly, both)?.handle).toBe("pr-only");
      expect(inline(`Review #12 then ${SHA.slice(0, 7)}`, prOnly, both)).toBeNull();
      expect(inline(`${SHA.slice(0, 7)} then #12`, prOnly, both)).toBeNull();
    });
  });
  test("a commit handle counts only on a row of this group that holds that commit", () => {
    const second: ReplyRow = { ...branch, name: "second", commits: [{ sha: "9".repeat(40), token: "9999999" }] };
    for (const row of [null, 1, 7]) {
      expect(inline(SHA, [card("did", [handle("commit", "elsewhere", { row, sha: SHA })])], [{ ...pr, commits: [{ sha: SHA, token: SHA.slice(0, 7) }] }, second])).toBeNull();
    }
    expect(inline(SHA, [card("did", [handle("commit", "elsewhere", { row: 1, sha: SHA }), handle("commit", "own", { row: 0, sha: SHA })])], [{ ...pr, commits: [{ sha: SHA, token: SHA.slice(0, 7) }] }, second])?.handle).toBe("own");
  });
  test("stale labels and rows with no reachability handle provide no inline target", () => {
    const h = held(allCards);
    h.asOf.labels.app = h.reply.checkedAt;
    expect(model(allCards, page, h).suggestions[0]!.button).toBeNull();
    expect(inline("#12", [], [pr])).toBeNull();
  });
});

describe("guards that keep each action on its own label, branch and repo", () => {
  const label = (key: string, repoKey: string | null, rows: ReplyRow[] = [pr]) => ({ key, repoKey, state: "ok" as const, rows, notMatched: 0, prNumbers: [12], onlyHere: 1 });
  const line = (key: string, name = "feature") => ({ key, name, state: "live" as const, notPushed: 1, neverPushed: false, behind: 0 });
  const twoText = renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude",
    resume: [{ repo: "app", text: "keep going" }, { repo: "lib", text: "keep going" }],
    branchState: [{ repo: "app", text: "On branch feature (ahead 1, behind 0)" }, { repo: "lib", text: "On branch feature (ahead 1, behind 0)" }],
    recap: [{ repo: "app", text: "shipped", evidence: SHA.slice(0, 7) }, { repo: "lib", text: "shipped", evidence: "1234567" }],
    suggestions: [{ repo: "app", text: "Review #12" }, { repo: "lib", text: "Review #12" }],
  } as BriefingStruct);
  const twoMapped = mapPage(renderMarkdown(twoText), TODAY);
  if (!twoMapped.ok) throw new Error("two-repo fixture must map");
  const twoPage = twoMapped.page;
  const repo2 = { ...repo, key: "r2", name: "lib", storeKey: "s2", treeKey: "t2" };
  const pushOf = (repoKey: string, firstLabel: string, storeKey: string) => ({ repoKey, storeKey, firstLabel, repoName: firstLabel, branches: [{ name: "feature", commits: 1 }], onDefault: null });
  const two = (cards: ActionCard[], patch: Partial<ReposAllReply> = {}): GitHeld => held(cards, [pr], {
    repoViews: [repo, repo2], labels: [label("app", "r1"), label("lib", "r2")], branchLines: [line("app"), line("lib")],
    pushCards: [pushOf("r1", "app", "s1"), pushOf("r2", "lib", "s2")], ...patch,
  });
  const twoCards = [
    card("did", [handle("pr", "app-pr", { row: 0 })], "app", "r1"), card("did", [handle("pr", "lib-pr", { row: 0 })], "lib", "r2"),
    card("leftOff", [handle("branch", "app-branch"), handle("editor", "app-editor", { project: "p1" })], "app", "r1"), card("leftOff", [handle("branch", "lib-branch"), handle("editor", "lib-editor", { project: "p2" })], "lib", "r2"),
    card("push", [handle("copy", "app-copy")], "push:r1", "r1"), card("push", [handle("copy", "lib-copy")], "push:r2", "r2"),
  ];
  const keys = (list: { key: string }[]): string[] => list.map((x) => x.key);

  test("the fixture's two repos each get their own actions", () => {
    const out = model(twoCards, twoPage, two(twoCards));
    expect(keys(out.did)).toEqual(["app", "lib"]);
    expect(out.did.map((d) => d.rows[0]!.button?.handle)).toEqual(["app-pr", "lib-pr"]);
    expect(out.leftOff.map((l) => [l.key, l.buttons[0]!.handle])).toEqual([["app", "app-branch"], ["lib", "lib-branch"]]);
    expect(out.push).toEqual([{ key: "push:r1", copy: { handles: ["app-copy"], label: "Copy push command", suffix: null } }, { key: "push:r2", copy: { handles: ["lib-copy"], label: "Copy push command", suffix: null } }]);
    expect(out.suggestions.map((s) => s.button?.handle)).toEqual(["app-pr", "lib-pr"]);
  });
  test("a did card filed under one label by another repo decorates nothing", () => {
    const crossed = [card("did", [handle("pr", "wired-to-r2", { row: 0 })], "app", "r2"), card("did", [handle("pr", "app-pr", { row: 0 })], "app", "r1")];
    expect(model(crossed, twoPage, two(crossed)).did[0]!.rows[0]!.button?.handle).toBe("app-pr");
    const only = [crossed[0]!];
    const out = model(only, twoPage, two(only));
    expect(out.did[0]!.rows[0]!.button).toBeNull();
    expect(out.suggestions[0]!.button).toBeNull();
  });
  test("a push card filed under one store's key by another repo adds nothing to its copy", () => {
    const crossed = [card("push", [handle("copy", "wired-to-r2")], "push:r1", "r2"), card("push", [handle("copy", "app-copy")], "push:r1", "r1")];
    expect(model(crossed, twoPage, two(crossed)).push).toEqual([{ key: "push:r1", copy: { handles: ["app-copy"], label: "Copy push command", suffix: null } }]);
    const only = [crossed[0]!];
    expect(model(only, twoPage, two(only)).push).toEqual([]);
  });
  test("a push card Rust minted no copy handles for has no button, and the other card keeps its own", () => {
    const minted = twoCards.filter((c) => !(c.cardKind === "push" && c.repoKey === "r1"));
    const out = model(minted, twoPage, two(minted));
    expect(out.push).toEqual([{ key: "push:r2", copy: { handles: ["lib-copy"], label: "Copy push command", suffix: null } }]);
    expect(keys(out.leftOff)).toEqual(["app", "lib"]); // nothing else on that repo goes with it
  });
  test("one repo with no remote loses only its own GitHub actions and push copy", () => {
    const out = model(twoCards, twoPage, two(twoCards, { repoViews: [repo, { ...repo2, noRemote: true }] }));
    expect(keys(out.did)).toEqual(["app"]);
    expect(keys(out.push)).toEqual(["push:r1"]);
    expect(out.leftOff.find((l) => l.key === "app")!.buttons.map((b) => b.target)).toEqual(["branch", "editor"]);
    expect(out.leftOff.find((l) => l.key === "lib")!.buttons.map((b) => b.target)).toEqual(["editor"]);
  });
  test("one repo held over loses all its actions while the other keeps its own", () => {
    const h = two(twoCards);
    h.asOf.repos.r2 = h.reply.checkedAt;
    const out = model(twoCards, twoPage, h);
    expect(keys(out.did)).toEqual(["app"]);
    expect(keys(out.leftOff)).toEqual(["app"]);
    expect(keys(out.push)).toEqual(["push:r1"]);
    expect(out.suggestions.map((s) => s.button?.handle ?? null)).toEqual(["app-pr", null]);
  });
  test("a PR only in another project's group never matches", () => {
    const rows: ReposAllReply["labels"] = [label("app", "r1"), label("lib", "r2", [{ ...pr, number: 77 }])];
    const page77: DeckPage = { ...twoPage, suggested: { ...twoPage.suggested, cards: [{ n: 1, text: "Review #77", key: "app", label: "app", slot: 0, marker: null }, { n: 2, text: "Review #77", key: "lib", label: "lib", slot: 1, marker: null }] } };
    expect(model(twoCards, page77, two(twoCards, { labels: rows })).suggestions.map((s) => s.button?.handle ?? null)).toEqual([null, "lib-pr"]);
  });
  test("a label with no single repo gets no row or suggestion actions", () => {
    const h = held(allCards, [pr], { labels: [label("app", null)] });
    const out = model(allCards, page, h);
    expect(out.did).toEqual([]);
    expect(out.suggestions[0]!.button).toBeNull();
    expect(keys(out.leftOff)).toEqual(["app"]);
  });
  test("left-off: a held-over label has no targets though its repo is current", () => {
    const h = held(allCards);
    h.asOf.labels.app = h.reply.checkedAt;
    expect(Object.keys(h.asOf.repos)).toEqual([]);
    expect(model(allCards, page, h).leftOff).toEqual([]);
  });
  test("left-off: the live branch line must be this card's own branch of this card's own label", () => {
    expect(model(allCards, page, held(allCards, [pr], { branchLines: [line("app", "another-branch")] })).leftOff).toEqual([]);
    expect(model(allCards, page, held(allCards, [pr], { branchLines: [line("lib")] })).leftOff).toEqual([]);
  });
  test("left-off: a live branch on a repo with no remote allows only the editor, even when another contributing repo has one", () => {
    const single = model(allCards, page, held(allCards, [pr], { repoViews: [{ ...repo, noRemote: true }] })).leftOff[0]!;
    expect(single.buttons.map((b) => b.target)).toEqual(["editor"]);
    expect(single.copy).toBeNull();
    const cards = [card("leftOff", [handle("branch"), handle("compare", "compare", { label: "trunk" }), handle("copy"), handle("editor", "editor", { project: "p1" })], "app", "r1"), card("leftOff", [handle("branch", "second")], "app", "r2")];
    const mixed = model(cards, page, held(cards, [pr], { repoViews: [repo, { ...repo2, noRemote: true }] })).leftOff[0]!;
    expect(mixed.buttons.map((b) => b.target)).toEqual(["editor"]);
    expect(mixed.copy).toBeNull();
  });
  test("a card the page draws in page mode gets no row actions; one with an unlisted commit or page commits does", () => {
    const noCommits: DeckPage = { ...page, whatYouDid: { ...page.whatYouDid, cards: page.whatYouDid.cards.map((c) => ({ ...c, commits: 0 })) } };
    expect(page.whatYouDid.cards[0]!.commits).toBeGreaterThan(0);
    expect(model(allCards, noCommits, held(allCards, [pr])).did).toEqual([]);
    expect(keys(model(allCards, noCommits, held(allCards, [branch])).did)).toEqual(["app"]); // `branch` holds a commit with a null token.
    expect(keys(model(allCards, page, held(allCards, [pr])).did)).toEqual(["app"]);
  });
});

const flush = async (): Promise<void> => { await new Promise((resolve) => setTimeout(resolve, 0)); };
const inventory = (choice: "cursor" | "zed" | null = "cursor"): EditorListReply => ({ editors: [{ editor: "cursor", label: "Cursor" }], projects: [
  { project: "p1", label: "app", choice, availability: "ready" }, { project: null, label: "Not checked yet", choice: null, availability: "not-checked" },
], discoveryConfigured: false });
function driver(os: Os = "macos") {
  const calls: { args: unknown[]; resolve: (r: EditorListReply) => void; reject: (e: unknown) => void }[] = [];
  const states: ActionsLiveState[] = [];
  const live = actionsLive({ os, editorList: (...args) => new Promise((resolve, reject) => calls.push({ args, resolve, reject })), publish: (s) => states.push(s) });
  return { live, calls, states };
}
const editors = (keys: string[], generation = "1"): ActionCard[] => keys.map((project) => card("leftOff", [handle("editor", generation + project, { project })]));

describe("per-mount actionsLive inventory", () => {
  test("mount and changed editor-key sets coalesce; same keys, ordering and new handles/generations read nothing", async () => {
    const h = driver();
    h.live.onActions(editors(["p1"]));
    expect(h.calls).toHaveLength(0);
    h.live.mount(); h.live.onActions(editors(["p1", "p2"])); h.live.onActions(editors(["p2", "p1"]));
    await flush();
    expect(h.calls).toHaveLength(1); expect(h.calls[0]!.args).toEqual([]);
    h.calls[0]!.resolve(inventory()); await flush();
    expect([...h.live.state().choices]).toEqual([["p1", "cursor"]]);
    h.live.onActions(editors(["p1", "p2", "p1"], "2")); await flush();
    expect(h.calls).toHaveLength(1);
    h.live.onActions([]);
    expect(h.live.state().choices.size).toBe(0); // invalidation is synchronous, before any promise settles.
    await flush(); expect(h.calls).toHaveLength(2);
    h.live.onActions(editors(["p1"])); await flush(); expect(h.calls).toHaveLength(3);
    h.calls[2]!.resolve(inventory("zed")); await flush();
    h.calls[1]!.resolve(inventory("cursor")); await flush();
    expect(h.live.state().choices.get("p1")).toBe("zed");
    h.live.dispose();
  });

  test("each remount reads once even with no handles, and non-editor/null project changes do not refresh", async () => {
    for (let visit = 0; visit < 2; visit++) {
      const h = driver(); h.live.mount();
      await flush(); expect(h.calls).toHaveLength(1);
      const published = h.states.length;
      h.live.onActions([card("did", [handle("branch", "branch", { project: "not-an-editor" })]), card("leftOff", [handle("editor")])]); // handle()'s project is null.
      expect(h.states).toHaveLength(published);
      await flush();
      expect(h.calls).toHaveLength(1); expect(h.states).toHaveLength(published);
      h.live.dispose();
    }
  });

  test.each(["linux", "windows", "other"] as const)("%s never detects editors", async (os) => {
    const h = driver(os); h.live.mount(); h.live.onActions(editors(["p1"])); await flush(); expect(h.calls).toHaveLength(0); h.live.dispose();
  });

  test("failures clear choices and use fixed approved text; disposed/older replies cannot republish", async () => {
    const h = driver(); h.live.mount(); await flush(); h.calls[0]!.resolve(inventory()); await flush();
    h.live.onActions(editors(["p1"])); expect(h.live.state().choices.size).toBe(0); await flush();
    h.calls[1]!.reject(new Error("secret path")); await flush();
    expect(h.live.state().error).toBe("Could not list installed editors");
    for (const [answer, message] of [[{ refused: "stale" }, "This work has changed since this briefing."], [{ refused: "unsupported" }, "Opening an editor is only available on macOS."], [{ failed: "detection" }, "Could not list installed editors"]] as const) {
      h.live.onActions(editors([message])); await flush(); h.calls.at(-1)!.resolve(answer); await flush();
      expect(h.live.state().choices.size).toBe(0); expect(h.live.state().error).toBe(message);
    }
    h.live.onActions([]); await flush(); const count = h.states.length; h.live.dispose();
    h.calls.at(-1)!.resolve(inventory()); await flush();
    expect(h.states).toHaveLength(count);
    h.live.mount(); h.live.onActions(editors(["ignored"])); h.live.applySaved("p1", "zed"); await flush();
    expect(h.states).toHaveLength(count);
  });

  test("dispose before the queued refresh makes no read or publication", async () => {
    const h = driver(); h.live.mount(); const count = h.states.length; h.live.dispose(); await flush();
    expect(h.calls).toHaveLength(0); expect(h.states).toHaveLength(count);
  });

  test("a synchronous inventory failure is caught and never restores a direct launch choice", async () => {
    const states: ActionsLiveState[] = [];
    const live = actionsLive({ os: "macos", editorList: () => { throw new Error("secret path"); }, publish: (s) => states.push(s) });
    live.mount(); await flush();
    expect(live.state()).toEqual({ choices: new Map(), error: "Could not list installed editors" });
    live.dispose();
  });

  test("applySaved publishes locally with zero reads and invalidates a pre-save inventory reply", async () => {
    const h = driver(); h.live.mount(); await flush();
    const reads = h.calls.length;
    h.live.applySaved("p1", "zed");
    expect(h.live.state().choices.get("p1")).toBe("zed"); expect(h.calls).toHaveLength(reads);
    h.calls[0]!.resolve(inventory("cursor")); await flush();
    expect(h.live.state().choices.get("p1")).toBe("zed");
    h.live.applySaved("p1", "ask"); expect(h.live.state().choices.get("p1")).toBe("ask");
    h.live.dispose();
  });

  test("a save in the same turn as a key-set change keeps the queued read, so the new project becomes known", async () => {
    const h = driver(); h.live.mount(); await flush(); h.calls[0]!.resolve(inventory()); await flush();
    h.live.onActions(editors(["p1", "p2"]));
    h.live.applySaved("p1", "zed");
    expect([...h.live.state().choices]).toEqual([["p1", "zed"]]);
    await flush();
    expect(h.calls).toHaveLength(2);
    h.calls[1]!.resolve({ ...inventory(), projects: [{ project: "p1", label: "app", choice: "zed", availability: "ready" }, { project: "p2", label: "lib", choice: "cursor", availability: "ready" }] });
    await flush();
    expect([...h.live.state().choices]).toEqual([["p1", "zed"], ["p2", "cursor"]]);
    h.live.dispose();
  });

  test("a save keeps a failed inventory's error, because every other project stays unknown", async () => {
    const h = driver(); h.live.mount(); await flush(); h.calls[0]!.reject(new Error("secret path")); await flush();
    h.live.applySaved("p1", "zed");
    expect(h.live.state()).toEqual({ choices: new Map([["p1", "zed"]]), error: "Could not list installed editors" });
    h.live.dispose();
  });

  describe("a save while a read is outstanding (Q-M6)", () => {
    const both = { ...inventory(), projects: [{ project: "p1", label: "app", choice: "cursor" as const, availability: "ready" as const }, { project: "p2", label: "lib", choice: "cursor" as const, availability: "ready" as const }] };
    test("the older reply still answers every other project, and never the one saved since it was sent", async () => {
      const h = driver(); h.live.mount(); await flush();
      h.live.applySaved("p1", "zed");
      h.calls[0]!.resolve(both); await flush();
      expect([...h.live.state().choices].sort()).toEqual([["p1", "zed"], ["p2", "cursor"]]);
      expect(h.calls).toHaveLength(1); // Zero extra reads.
      h.live.dispose();
    });
    test("a project the older reply does not list still keeps its save", async () => {
      const h = driver(); h.live.mount(); await flush();
      h.live.applySaved("p9", "zed");
      h.calls[0]!.resolve(both); await flush();
      expect(h.live.state().choices.get("p9")).toBe("zed");
      expect(h.live.state().choices.get("p2")).toBe("cursor");
      h.live.dispose();
    });
    test("an older read that fails keeps the save and says it could not list", async () => {
      const h = driver(); h.live.mount(); await flush();
      h.live.applySaved("p1", "zed");
      h.calls[0]!.reject(new Error("secret path")); await flush();
      expect(h.live.state()).toEqual({ choices: new Map([["p1", "zed"]]), error: "Could not list installed editors" });
      h.live.dispose();
    });
    test("a save before the next read goes out is that read's to answer, so it is not kept over it", async () => {
      const h = driver(); h.live.mount(); await flush();
      h.live.applySaved("p1", "zed");
      h.calls[0]!.resolve(both); await flush();
      h.live.onActions(editors(["p1", "p2"])); await flush();
      h.calls[1]!.resolve({ ...both, projects: [{ project: "p1", label: "app", choice: "ask", availability: "ready" }] }); await flush();
      expect([...h.live.state().choices]).toEqual([["p1", "ask"]]); // Settings changed it since; the save above is history.
      h.live.dispose();
    });
    test("a key-set change still discards the older reply, save or no save", async () => {
      const h = driver(); h.live.mount(); await flush();
      h.live.applySaved("p1", "zed");
      h.live.onActions(editors(["p1", "p2"])); await flush();
      expect(h.calls).toHaveLength(2);
      h.calls[1]!.resolve({ ...both, projects: [{ project: "p1", label: "app", choice: "zed", availability: "ready" }, { project: "p2", label: "lib", choice: "zed", availability: "ready" }] }); await flush();
      h.calls[0]!.resolve(both); await flush();
      expect([...h.live.state().choices].sort()).toEqual([["p1", "zed"], ["p2", "zed"]]);
      h.live.dispose();
    });
  });
});

describe("noResult hides the action buttons and keeps B1's rows (B2 :35)", () => {
  const args = { model: todayModel({ snapshot: null, latest: { state: "loaded", file: { path: "/fixture/page.md", text, bytes: text.length } }, lastRun: null, today: TODAY }), today: TODAY, firstName: null };
  const NO_RESULT: ReposIpcReply = { gate: "noResult", heldAt: null, uncommittedAt: null, unknownRepos: [] };
  function harness() {
    const calls: { resolve: (r: ReposIpcReply) => void; reject: (e: unknown) => void }[] = [];
    const live = gitLive({ invoke: () => new Promise<ReposIpcReply>((resolve, reject) => calls.push({ resolve, reject })), clock: () => 0, onchange: () => {}, timer: () => () => {} });
    const deck = deckView(args);
    if (deck.kind !== "slides") throw new Error("slides");
    live.onCurrent("launchpad", deck);
    live.onPageKey("k1", deck);
    const view = () => {
      const s = live.state();
      const v = deckView({ ...args, gitDetail: { ...s, os: "macos" }, actions: input(liveActionCards(s)) });
      if (v.kind !== "slides" || v.actions === null || v.git === null) throw new Error("slides");
      return { actions: v.actions, card: v.git.cards[0]! };
    };
    return { live, calls, deck, view };
  }
  test("a positive answer, noResult, then a real answer: buttons go and come back, the rows stay", async () => {
    const h = harness();
    h.calls[0]!.resolve(replyOf(allCards)); await flush();
    const before = h.view();
    expect(before.card.mode).toBe("detail");
    expect(before.actions.did[0]!.rows[0]!.button?.handle).toBe("pr");
    expect(before.actions.leftOff).toHaveLength(1);
    expect(before.actions.push).toHaveLength(1);
    expect(before.actions.suggestions[0]!.button?.handle).toBe("pr");

    h.live.onFocus(h.deck); await flush();
    h.calls[1]!.resolve(NO_RESULT); await flush();
    expect(liveActionCards(h.live.state())).toEqual([]);
    const hidden = h.view();
    expect(hidden.card).toEqual(before.card);
    expect(hidden.actions.did[0]!.rows[0]).toEqual({ row: 0, button: null, commits: [] });
    expect(hidden.actions.leftOff).toEqual([]);
    expect(hidden.actions.push).toEqual([]);
    expect(hidden.actions.suggestions[0]!.button).toBeNull();

    h.live.onFocus(h.deck); await flush();
    h.calls[2]!.resolve(replyOf(allCards)); await flush();
    expect(liveActionCards(h.live.state())).toHaveLength(allCards.length);
    expect(h.view().actions).toEqual(before.actions);
    h.live.dispose();
  });
  test("only a real answer clears it: an IPC failure keeps the buttons hidden; a new page starts clear", async () => {
    const h = harness();
    h.calls[0]!.resolve(replyOf(allCards)); await flush();
    h.live.onFocus(h.deck); await flush();
    h.calls[1]!.resolve(NO_RESULT); await flush();
    h.live.onFocus(h.deck); await flush();
    h.calls[2]!.reject(new Error("the check failed")); await flush();
    expect(liveActionCards(h.live.state())).toEqual([]);
    expect(h.live.state().reply).not.toBeNull();
    h.live.onPageKey("k2", h.deck);
    expect(h.live.state().noResult).toBe(false);
    h.live.dispose();
  });
  test("a repeated noResult publishes nothing and asks nothing, so Today makes no inventory read for it", async () => {
    const calls: { resolve: (r: ReposIpcReply) => void }[] = [];
    const inventoryReads: unknown[] = [];
    const inventoryLive = actionsLive({ os: "macos", editorList: () => { inventoryReads.push(1); return new Promise(() => {}); }, publish: () => {} });
    let changes = 0;
    const live = gitLive({
      invoke: () => new Promise<ReposIpcReply>((resolve) => calls.push({ resolve })), clock: () => 0, timer: () => () => {},
      onchange: (s) => { changes++; inventoryLive.onActions(liveActionCards(s)); },
    });
    const deck = deckView(args);
    if (deck.kind !== "slides") throw new Error("slides");
    inventoryLive.mount(); await flush();
    live.onCurrent("launchpad", deck); live.onPageKey("k1", deck);
    calls[0]!.resolve(replyOf(allCards)); await flush();
    live.onFocus(deck); await flush();
    calls[1]!.resolve(NO_RESULT); await flush();
    expect(live.state().noResult).toBe(true);
    const seen = changes;
    const reads = inventoryReads.length;
    const held0 = live.state();
    live.onFocus(deck); await flush();
    calls[2]!.resolve(NO_RESULT); await flush();
    expect(changes).toBe(seen);
    expect(live.state()).toBe(held0);
    expect(inventoryReads).toHaveLength(reads);
    expect(calls).toHaveLength(3); // The focus's own ask, and nothing the answer set off.
    live.dispose(); inventoryLive.dispose();
  });
  test("a noResult for a page no longer current changes nothing", async () => {
    const h = harness();
    h.live.onPageKey("k2", h.deck);
    h.calls[0]!.resolve(NO_RESULT); await flush();
    expect(h.live.state().noResult).toBe(false);
    h.live.dispose();
  });
});

describe("the launchpad tile's Copy push command (B2 :46)", () => {
  const repo2 = { ...repo, key: "r2", name: "lib", storeKey: "s2", treeKey: "t2" };
  const pushOf = (repoKey: string, storeKey: string, onDefault: PushCard["onDefault"] = null): PushCard => ({ repoKey, storeKey, firstLabel: null, repoName: repoKey, branches: [{ name: "feature", commits: 1 }], onDefault });
  const tileCards = [card("tile", [handle("copy", "t-feature"), handle("copy", "t-main")], "onlyHere", "r1"), card("tile", [handle("copy", "t-lib")], "onlyHere", "r2")];
  const both: Partial<ReposAllReply> = { repoViews: [repo, repo2], pushCards: [pushOf("r1", "s1", { name: "main", commits: 1 }), pushOf("r2", "s2")], tile: { commits: 3, branches: 3 } };
  /** Every offered copy also proves its second reading of "current" agrees with B1's `pushTime`: a tile with Copy is never dated. */
  const tileOf = (h: GitHeld, patch: Partial<ActionsInput> = {}, p = page) => {
    const tile = actionsView(p, input(h.reply.actions, patch), h).tile;
    if (tile !== null) expect(gitDetailView(p, { reply: h, fresh: true, os: "macos", greenSince: {} }, TODAY).tiles[0]!.asOf).toBeNull();
    return tile;
  };
  const reply = (patch: Partial<ReposHeldReply> = {}): ReposHeldReply => ({ ...(replyOf(tileCards, [pr], both) as ReposHeldReply), ...patch });
  const merged = (prev: GitHeld | null, next: ReposHeldReply): GitHeld => {
    const h = mergeReply(prev, next);
    if (h === null) throw new Error("merged fixture");
    return h;
  };

  test("the push cards' complete list, across repos in the reply's order, on every OS; Windows adds the suffix", () => {
    const h = held(tileCards, [pr], both);
    expect(tileOf(h)).toEqual({ handles: ["t-feature", "t-main", "t-lib"], label: "Copy push command", suffix: null });
    for (const os of ["macos", "linux", "other"] as const) expect(tileOf(h, { os })?.suffix).toBeNull();
    expect(tileOf(h, { os: "windows" })).toEqual({ handles: ["t-feature", "t-main", "t-lib"], label: "Copy push command", suffix: "for Git Bash" });
    expect(tileOf(h, { githubLinks: false })?.handles).toHaveLength(3);
    const words = (os: Os) => gitDetailView(page, { reply: h, fresh: true, os, greenSince: {} }, TODAY).tiles[0]!.label;
    expect(words("macos")).toBe("Only on this Mac");
    expect(words("windows")).toBe("Only on this computer"); // B1's hereWords, untouched; the copy adds no words of its own.
  });

  test("the list is deduplicated by store and local branch: two checkouts of one store share one handle", () => {
    const shared: Partial<ReposAllReply> = { repoViews: [repo, { ...repo2, storeKey: "s1" }], pushCards: [pushOf("r1", "s1"), pushOf("r2", "s1")] };
    const one = [card("tile", [handle("copy", "t-feature")], "onlyHere", "r1")];
    expect(tileOf(held(one, [pr], shared))?.handles).toEqual(["t-feature"]);
    const twice = [card("tile", [handle("copy", "t-feature"), handle("copy", "t-again")], "onlyHere", "r1")];
    expect(tileOf(held(twice, [pr], shared))).toBeNull();
    const sameNameOtherStore = [card("tile", [handle("copy", "t-a")], "onlyHere", "r1"), card("tile", [handle("copy", "t-b")], "onlyHere", "r2")];
    expect(tileOf(held(sameNameOtherStore, [pr], { repoViews: [repo, repo2], pushCards: [pushOf("r1", "s1"), pushOf("r2", "s2")] }))?.handles).toEqual(["t-a", "t-b"]);
  });

  test("never a partial list: a missing handle, or a handle for no listed branch, hides it", () => {
    expect(tileOf(held([card("tile", [handle("copy", "t-feature"), handle("copy", "t-lib")], "onlyHere", "r1")], [pr], both))).toBeNull();
    expect(tileOf(held([], [pr], both))).toBeNull();
    expect(tileOf(held([...tileCards, card("tile", [handle("copy", "t-extra")], "onlyHere", "r1")], [pr], both))).toBeNull();
    const notCopy = [card("tile", [handle("copy", "t-feature"), handle("copy", "t-main"), handle("branch", "t-lib")], "onlyHere", "r1")];
    expect(tileOf(held(notCopy, [pr], both))).toBeNull();
    const onRow = [card("tile", [handle("copy", "t-feature"), handle("copy", "t-main"), handle("copy", "t-lib", { row: 0 })], "onlyHere", "r1")];
    expect(tileOf(held(onRow, [pr], both))).toBeNull();
  });

  test("a tile Rust minted no handles for has no button, keeps its words and count, and each card's own button stays", () => {
    const pushes = [card("push", [handle("copy", "p-feature"), handle("copy", "p-main")], "push:r1", "r1"), card("push", [handle("copy", "p-lib")], "push:r2", "r2")];
    const none = held(pushes, [pr], both);
    const out = actionsView(page, input(pushes), none);
    expect(out.tile).toBeNull();
    expect(out.push.map((p) => p.key)).toEqual(["push:r1", "push:r2"]);
    const words = gitDetailView(page, { reply: none, fresh: true, os: "macos", greenSince: {} }, TODAY).tiles[0]!;
    const control = gitDetailView(page, { reply: held(tileCards, [pr], both), fresh: true, os: "macos", greenSince: {} }, TODAY).tiles[0]!;
    expect(words).toEqual(control); // the tile's words read the reply's count, never its handles
    expect(words.label).toBe("Only on this Mac");
    expect(tileOf(held(tileCards, [pr], both))?.handles).toHaveLength(3); // the control: minted, it draws
  });
  test("only the tile's own handles count, and the tile must be the one drawn", () => {
    const wrongId = [card("tile", [handle("copy", "a"), handle("copy", "b"), handle("copy", "c")], "elsewhere", "r1")];
    expect(tileOf(held(wrongId, [pr], both))).toBeNull();
    const wrongKind = [card("push", [handle("copy", "a"), handle("copy", "b"), handle("copy", "c")], "onlyHere", "r1")];
    expect(tileOf(held(wrongKind, [pr], both))).toBeNull();
    expect(tileOf(held(tileCards, [pr], { ...both, tile: { commits: 0, branches: 0 } }))).toBeNull();
  });

  test("a held-over repo hides the whole copy despite the other repo's handles, and both current shows it again", () => {
    const first = merged(null, reply());
    expect(tileOf(first)?.handles).toHaveLength(3);
    const over = merged(first, reply({ unknownRepos: ["r2"] }));
    expect(over.reply.actions.map((c) => c.repoKey)).toEqual(["r1"]); // The other repo's own handles are still held.
    expect(over.reply.pushCards.map((c) => c.repoKey)).toEqual(["r1", "r2"]);
    expect(tileOf(over)).toBeNull();
    expect(tileOf(merged(over, reply()))?.handles).toEqual(["t-feature", "t-main", "t-lib"]);
  });

  const unknownView = (storeKey: string | null): RepoView => ({ key: "r2", name: "lib", state: "unknown", reason: "timeout", noRemote: false, uncommitted: { unknown: true }, storeKey, treeKey: "t2" });
  const r1Only = [card("tile", [handle("copy", "t-feature")], "onlyHere", "r1")];
  const onlyR1 = (r2: RepoView): ReposHeldReply => ({ ...(replyOf(r1Only, [pr], { repoViews: [repo, r2], pushCards: [pushOf("r1", "s1")], tile: { commits: 1, branches: 1 } }) as ReposHeldReply) });

  test("an unknown repo with no earlier answer is an unknown contribution, so the copy is hidden", () => {
    const h = merged(null, onlyR1(unknownView("s2")));
    expect(tileOf(h)).toBeNull();
    expect(tileOf(merged(null, onlyR1(unknownView(null))))).toBeNull();
    expect(tileOf(merged(null, onlyR1(repo2)))?.handles).toEqual(["t-feature"]);
  });

  test("a stale checkout whose store a current checkout answers contributes nothing of its own", () => {
    expect(tileOf(merged(null, onlyR1(unknownView("s1")))))
      .toEqual({ handles: ["t-feature"], label: "Copy push command", suffix: null });
  });

  test("two stale checkouts of one store do not answer each other: with a third, current repo the copy stays hidden", () => {
    const stale = (key: string): RepoView => ({ ...repo2, key, name: key, storeKey: "s9", treeKey: `t-${key}` });
    const h = merged(null, { ...(replyOf(r1Only, [pr], { repoViews: [repo, stale("r2"), stale("r3")], pushCards: [pushOf("r1", "s1")], tile: { commits: 1, branches: 1 } }) as ReposHeldReply) });
    expect(tileOf(h)?.handles).toEqual(["t-feature"]); // All three current: the copy is whole.
    h.asOf.repos.r2 = h.reply.checkedAt;
    h.asOf.repos.r3 = h.reply.checkedAt;
    expect(tileOf(h)).toBeNull();
    expect(gitDetailView(page, { reply: h, fresh: true, os: "macos", greenSince: {} }, TODAY).tiles[0]!.asOf).not.toBeNull();
  });

  test("a held-over repo with no remote has no push work, so it does not hide the copy", () => {
    const h = merged(null, onlyR1({ ...repo2, noRemote: true }));
    h.asOf.repos.r2 = h.reply.checkedAt;
    expect(tileOf(h)?.handles).toEqual(["t-feature"]);
    expect(tileOf(merged(null, onlyR1({ ...unknownView("s2"), noRemote: true })))?.handles).toEqual(["t-feature"]);
  });

  test("a push card on a stale or remote-less repo hides the copy", () => {
    const h = held(tileCards, [pr], both);
    h.asOf.repos.r2 = h.reply.checkedAt;
    expect(tileOf(h)).toBeNull();
    expect(tileOf(held(tileCards, [pr], { ...both, repoViews: [repo, { ...repo2, noRemote: true }] }))).toBeNull();
    expect(tileOf(held(tileCards, [pr], { ...both, repoViews: [repo] }))).toBeNull();
  });

  test("a push card kept on a stale checkout hides the copy even when a current checkout answers its store", () => {
    const shared: Partial<ReposAllReply> = { repoViews: [repo, { ...repo2, storeKey: "s1" }], pushCards: [pushOf("r2", "s1")], tile: { commits: 1, branches: 1 } };
    const h = held(r1Only, [pr], shared);
    expect(tileOf(h)?.handles).toEqual(["t-feature"]);
    h.asOf.repos.r2 = h.reply.checkedAt;
    expect(tileOf(h)).toBeNull();
  });

  test("a tile card for a repo not current hides the copy rather than shortening it", () => {
    const h = held(tileCards, [pr], { ...both, repoViews: [repo, repo2] });
    const cards = [...tileCards.slice(0, 1), card("tile", [handle("copy", "t-lib")], "onlyHere", "gone")];
    expect(actionsView(page, input(cards), h).tile).toBeNull();
  });

  test("older pages, no answer and invalidated handles offer no copy", () => {
    const h = held(tileCards, [pr], both);
    expect(tileOf(h, {}, { ...page, stale: true })).toBeNull();
    expect(actionsView(page, input(tileCards), null).tile).toBeNull();
    expect(actionsView(page, input([]), h).tile).toBeNull();
    expect(liveActionCards({ noResult: true, reply: h } as Parameters<typeof liveActionCards>[0])).toEqual([]);
  });
});

describe("Resume tiles (B2 :45, :47)", () => {
  const template = page.leftOff.cards[0]!;
  const named = (key: string) => ({ ...template, key, label: `Project ${key}` });
  const live = (key: string) => ({ key, name: "feature", state: "live" as const, notPushed: 1, neverPushed: false, behind: 0 });
  const editorCard = (key: string, project = `p-${key}`) => card("leftOff", [handle("editor", `ed-${key}`, { project })], key);
  const pageOf = (cards: DeckPage["leftOff"]["cards"]): DeckPage => ({ ...page, leftOff: { ...page.leftOff, cards } });
  const heldOf = (cards: ActionCard[], keys: string[], patch: Partial<ReposAllReply> = {}) => held(cards, [pr], { branchLines: keys.map(live), ...patch });
  const six = ["a", "b", "c", "d", "e", "f"];
  const sixCards = six.map((k) => editorCard(k));
  const sixPage = pageOf(six.map(named));
  const resume = (p: DeckPage, cards: ActionCard[], h: GitHeld, patch: Partial<ActionsInput> = {}) => actionsView(p, input(cards, patch), h).resume;

  test("one per project, in Where-you-left-off order, its own cap of 3, the first 3 eligible", () => {
    const out = resume(sixPage, sixCards, heldOf(sixCards, six));
    expect(out.map((t) => t.button.handle)).toEqual(["ed-a", "ed-b", "ed-c"]);
    expect(out.map((t) => t.key)).toEqual(["a", "b", "c"]);
    const cards = pageOf([{ ...named("a"), branch: { kind: "detached", sha: "abcdef0" } }, { ...named("b"), branch: null }, ...["c", "d", "e", "f"].map(named)]);
    const lines: ReposAllReply["branchLines"] = [{ key: "c", name: "feature", state: "missing" }, ...["d", "e", "f"].map(live)];
    expect(resume(cards, sixCards, heldOf(sixCards, [], { branchLines: lines })).map((t) => t.key)).toEqual(["d", "e", "f"]);
  });

  test("neutral, with the G-TEXT words before and after a choice, from the card's safe label", () => {
    const cards = [editorCard("a"), editorCard("b"), editorCard("c")];
    const out = resume(pageOf(["a", "b", "c"].map(named)), cards, heldOf(cards, ["a", "b", "c"]), { choices: new Map<string, EditorChoice | null>([["p-a", "cursor"], ["p-b", "ask"], ["p-c", null]]) });
    expect(out.map((t) => t.label)).toEqual(["Resume · Project a · Open in Cursor", "Resume · Project b · Open in editor…", "Resume · Project c · Open in editor…"]);
    expect(out.map((t) => t.state)).toEqual(["neutral", "neutral", "neutral"]);
    expect(out.map((t) => t.button.choice)).toEqual(["cursor", "ask", null]);
    const unknown = resume(pageOf([named("a")]), [editorCard("a")], heldOf([editorCard("a")], ["a"]));
    expect(unknown[0]!.label).toBe("Resume · Project a · Open in editor…");
    expect(unknown[0]!.button.choice).toBeUndefined();
  });

  test("two cards naming one project are one tile, and do not use up the cap", () => {
    const cards = [editorCard("a", "same"), editorCard("b", "same"), editorCard("c"), editorCard("d"), editorCard("e")];
    const out = resume(pageOf(["a", "b", "c", "d", "e"].map(named)), cards, heldOf(cards, ["a", "b", "c", "d", "e"]));
    expect(out.map((t) => t.key)).toEqual(["a", "c", "d"]);
  });

  test("a remote-less live line still resumes; a card with no editor target does not", () => {
    const cards = [editorCard("a"), card("leftOff", [handle("branch", "b-branch")], "b")];
    const out = resume(pageOf(["a", "b"].map(named)), cards, held(cards, [pr], { branchLines: [{ key: "a", name: "feature", state: "noRemote" }, live("b")], repoViews: [{ ...repo, noRemote: true }] }));
    expect(out.map((t) => t.key)).toEqual(["a"]);
  });

  test.each(["linux", "windows", "other"] as const)("%s draws no Resume tile", (os) => {
    const h = heldOf(sixCards, six);
    expect(resume(sixPage, sixCards, h, { os })).toEqual([]);
    expect(resumeTiles(actionsView(sixPage, input(sixCards), h), h, os)).toEqual([]);
  });

  test("older pages and missing answers have none", () => {
    expect(resume({ ...sixPage, stale: true }, sixCards, heldOf(sixCards, six))).toEqual([]);
    expect(actionsView(sixPage, input(sixCards), null).resume).toEqual([]);
    expect(resume(sixPage, [], heldOf([], six))).toEqual([]);
  });

  describe("resumeTiles reads B1's live state itself", () => {
    const h = heldOf(sixCards, six);
    const view = actionsView(sixPage, input(sixCards), h);
    test("no held answer gives none", () => { expect(resumeTiles(view, null, "macos")).toEqual([]); });
    test("a missing or absent branch line is left out and the next eligible card takes the slot", () => {
      const lines: ReposAllReply["branchLines"] = [{ key: "a", name: "feature", state: "missing" }, ...["c", "d", "e", "f"].map(live)];
      expect(resumeTiles(view, heldOf(sixCards, [], { branchLines: lines }), "macos").map((t) => t.key)).toEqual(["c", "d", "e"]);
    });
    test("a held-over card is left out", () => {
      const over = heldOf(sixCards, six);
      over.asOf.labels.a = over.reply.checkedAt;
      expect(resumeTiles(view, over, "macos").map((t) => t.key)).toEqual(["b", "c", "d"]);
    });
  });

  describe("beside B1's launchpad", () => {
    const dirty = ["a", "b", "c", "d"].map((k): RepoView => ({ ...repo, key: `r${k}`, name: k, treeKey: `t${k}`, uncommitted: { count: 2 } }));
    const gitOf = (h: GitHeld) => gitDetailView(sixPage, { reply: h, fresh: true, os: "macos", greenSince: {} }, TODAY);
    test("Resume does not move the heading: all set stays all set with Resume tiles showing", () => {
      const h = heldOf(sixCards, six, { pushCards: [], tile: { commits: 0, branches: 0 } });
      expect(resume(sixPage, sixCards, h)).toHaveLength(3);
      expect(launchpadHeading(gitOf(h))).toBe("You're all set");
      expect(launchpadTiles(gitOf(h), 0)).toEqual({ tiles: [], more: null, moreAsOf: null, waiting: 0 });
    });
    test("Resume takes no B1 slot: B1's tile, its 3 and the overflow line stand with all 3 Resume tiles", () => {
      const h = heldOf(sixCards, six, { repoViews: [repo, ...dirty] });
      const tiles = launchpadTiles(gitOf(h), 0);
      expect(tiles.tiles.map((t) => t.key)).toEqual(["onlyHere", "uncommitted:ra", "uncommitted:rb", "uncommitted:rc"]);
      expect(tiles.more).toBe("+1 more repo not committed");
      expect(launchpadHeading(gitOf(h))).toBe("Before you start");
      expect(resume(sixPage, sixCards, h)).toHaveLength(3);
    });
    test("launchpadTiles knows nothing of Resume", () => {
      const source = readFileSync(new URL("../src/lib/git-detail.ts", import.meta.url), "utf8");
      expect(source).not.toContain("Resume ·");
      expect(source).not.toContain("resumeTiles");
    });
  });
});

describe("the editor chooser model (B2 :71-73)", () => {
  const editorsOf = (...ids: EditorId[]) => ids.map((editor) => ({ editor, label: EDITOR_LABELS[editor] }));
  const listed = (choice: EditorChoice | null | "no-row", patch: Partial<Extract<EditorListReply, { editors: unknown }>> = {}): EditorListReply => ({
    editors: editorsOf("vs-code", "cursor"),
    projects: [{ project: null, label: "Not checked yet", choice: null, availability: "not-checked" }, { project: "other", label: "lib", choice: "zed", availability: "ready" }, ...(choice === "no-row" ? [] : [{ project: "p1", label: "app", choice, availability: "ready" as const }])],
    discoveryConfigured: false,
    preselect: "cursor",
    ...patch,
  });
  const started = (reply: EditorListReply, known?: EditorChoice | null) => {
    const view = chooserView(reply, "p1", known);
    if (view.state !== "choose") throw new Error("expected the chooser");
    return view;
  };

  test("a click launches directly only on a known stored editor without ⌥; every other state asks", () => {
    expect(editorClick("cursor", false)).toEqual({ kind: "launch", editor: "cursor" });
    expect(editorClick("cursor", true)).toEqual({ kind: "choose" });
    for (const choice of [null, "ask", undefined] as const) for (const option of [false, true]) expect(editorClick(choice, option)).toEqual({ kind: "choose" });
  });

  test("a removed editor reopens the chooser from the launch's own reply; nothing else does", () => {
    expect(reopensChooser({ refused: "no-editor" })).toBe(true);
    for (const reply of [{ opened: true }, { refused: "stale" }, { refused: "invalid-folder" }, { refused: "unsupported" }, { failed: "editor" }] as const) expect(reopensChooser(reply)).toBe(false);
  });

  test("never chosen starts the box checked; ask each time starts it unchecked on every click", () => {
    expect(started(listed(null), null).remember).toBe(true);
    expect(started(listed("ask"), "ask").remember).toBe(false);
  });

  test("the click's reply settles an unknown choice; with no answer an unknown is not never-chosen", () => {
    expect(started(listed(null), undefined).remember).toBe(true);
    expect(started(listed("ask"), undefined).remember).toBe(false);
    expect(started(listed("no-row"), undefined).remember).toBe(false);
    expect(started(listed("no-row"), null).remember).toBe(true);
    expect(started(listed("ask"), null).remember).toBe(false); // The reply is newer than the published inventory.
  });

  test("a project's row is its own: another project's choice never starts this box", () => {
    const reply: EditorListReply = { ...listed("no-row"), projects: [{ project: "other", label: "lib", choice: null, availability: "ready" }] } as EditorListReply;
    expect(started(reply, undefined).remember).toBe(false);
  });

  test("a stored editor asked again (⌥-click, or removed) writes nothing unless the box is ticked", () => {
    expect(started(listed("cursor"), "cursor").remember).toBe(false);
  });

  test("the list comes from the reply, and the reply's preselect highlights only an installed editor", () => {
    expect(started(listed(null))).toEqual({ state: "choose", editors: editorsOf("vs-code", "cursor"), selected: "cursor", remember: true });
    expect(started(listed(null, { preselect: "zed" })).selected).toBe("vs-code");
    expect(started(listed(null, { preselect: null })).selected).toBe("vs-code");
    const none: EditorListReply = { editors: editorsOf("zed"), projects: [], discoveryConfigured: false };
    expect(started(none).selected).toBe("zed");
  });

  test("none installed says the spec's words; list refusals use their fixed rows", () => {
    expect(chooserView(listed(null, { editors: [], preselect: null }), "p1", null)).toEqual({ state: "failed", message: "No supported editor installed" });
    expect(chooserView({ refused: "unsupported" }, "p1", null)).toEqual({ state: "failed", message: "Opening an editor is only available on macOS." });
    expect(chooserView({ refused: "stale" }, "p1", null)).toEqual({ state: "failed", message: "This work has changed since this briefing." });
    expect(chooserView({ failed: "detection" }, "p1", null)).toEqual({ state: "failed", message: "Could not list installed editors" });
  });

  describe("chooseAndOpen (Q-M6)", () => {
    const OPENED: EditorOpenReply = { opened: true };
    function wrappers(save: EditorChoiceSetReply | Error = { saved: true, revision: 2 }, open: EditorOpenReply | Error = OPENED) {
      const calls: unknown[][] = [];
      return { calls, deps: {
        editorChoiceSet: async (project: string, editor: EditorChoice) => { calls.push(["set", project, editor]); if (save instanceof Error) throw save; return save; },
        editorOpen: async (handle: string, editor: EditorId) => { calls.push(["open", handle, editor]); if (open instanceof Error) throw open; return open; },
        applySaved: (project: string, choice: EditorChoice) => { calls.push(["applied", project, choice]); },
      } };
    }
    const answer = { handle: "h1", project: "p1", editor: "zed" as const, remember: true };

    test("ticked: saves first, publishes the landed save once, then launches once", async () => {
      const w = wrappers();
      expect(await chooseAndOpen(answer, w.deps)).toEqual({ saveLine: null, open: OPENED });
      expect(w.calls).toEqual([["set", "p1", "zed"], ["applied", "p1", "zed"], ["open", "h1", "zed"]]);
    });

    test("the launch waits for the save's answer", async () => {
      const order: string[] = [];
      let release = (_: EditorChoiceSetReply): void => {};
      const done = chooseAndOpen(answer, {
        editorChoiceSet: () => new Promise((resolve) => { release = resolve; }),
        editorOpen: async () => { order.push("open"); return OPENED; },
        applySaved: () => { order.push("applied"); },
      });
      await flush();
      expect(order).toEqual([]);
      release({ saved: true, revision: 1 });
      await done;
      expect(order).toEqual(["applied", "open"]);
    });

    test.each([
      [{ refused: "preferences-full" } as const, "Editor choices could not be saved: preferences are full."],
      [{ refused: "stale" } as const, "This project has changed since this briefing."],
      [{ refused: "unsupported" } as const, "Opening an editor is only available on macOS."],
      [{ refused: "unknown-editor" } as const, "Choose a supported editor."],
      [{ failed: "preferences" } as const, "Could not save editor choice"],
    ])("a refused or failed save %j still launches once, shows its row and stores nothing", async (reply, text) => {
      const w = wrappers(reply);
      expect(await chooseAndOpen(answer, w.deps)).toEqual({ saveLine: text, open: OPENED });
      expect(w.calls).toEqual([["set", "p1", "zed"], ["open", "h1", "zed"]]);
      expect(choiceRefusalText(reply)).toBe(text);
    });

    test("a save that throws is the fixed failure, never its message, and still launches once", async () => {
      const w = wrappers(new Error("/secret/path/app-prefs.json"));
      expect(await chooseAndOpen(answer, w.deps)).toEqual({ saveLine: "Could not save editor choice", open: OPENED });
      expect(w.calls).toEqual([["set", "p1", "zed"], ["open", "h1", "zed"]]);
    });

    test("unticked: no save, no publication, one launch", async () => {
      const w = wrappers();
      expect(await chooseAndOpen({ ...answer, remember: false }, w.deps)).toEqual({ saveLine: null, open: OPENED });
      expect(w.calls).toEqual([["open", "h1", "zed"]]);
    });

    test("the launch's own reply comes back; a launch that throws is the fixed failure", async () => {
      expect((await chooseAndOpen(answer, wrappers({ saved: true, revision: 1 }, { refused: "invalid-folder" }).deps)).open).toEqual({ refused: "invalid-folder" });
      expect((await chooseAndOpen(answer, wrappers({ saved: true, revision: 1 }, new Error("/secret")).deps)).open).toEqual({ failed: "editor" });
    });

    test("a wrapper that throws before it returns a promise is the same fixed failure", async () => {
      const calls: string[] = [];
      const out = await chooseAndOpen(answer, {
        editorChoiceSet: () => { calls.push("set"); throw new Error("/secret"); },
        editorOpen: () => { calls.push("open"); throw new Error("/secret"); },
        applySaved: () => { calls.push("applied"); },
      });
      expect(out).toEqual({ saveLine: "Could not save editor choice", open: { failed: "editor" } });
      expect(calls).toEqual(["set", "open"]);
    });

    test("a publication that throws still launches once, with the save's answer and no raw text", async () => {
      const calls: string[] = [];
      const out = await chooseAndOpen(answer, {
        editorChoiceSet: async () => ({ saved: true, revision: 1 }),
        editorOpen: async () => { calls.push("open"); return OPENED; },
        applySaved: () => { calls.push("applied"); throw new Error("/secret"); },
      });
      expect(out).toEqual({ saveLine: null, open: OPENED });
      expect(calls).toEqual(["applied", "open"]);
    });

    test("a save refused and a launch refused each keep their own answer", async () => {
      expect(await chooseAndOpen(answer, wrappers({ refused: "stale" }, { refused: "no-editor" }).deps)).toEqual({ saveLine: "This project has changed since this briefing.", open: { refused: "no-editor" } });
    });
  });

  test("two sub-projects remember independently through the real driver; the webview never derives a key", async () => {
    const h = driver(); h.live.mount(); await flush();
    h.calls[0]!.resolve({ editors: editorsOf("cursor", "zed"), projects: [{ project: "sub-a", label: "a", choice: "ask", availability: "ready" }, { project: "sub-b", label: "b", choice: null, availability: "ready" }], discoveryConfigured: false });
    await flush();
    const saved: unknown[][] = [];
    const deps = { editorChoiceSet: async (project: string, editor: EditorChoice): Promise<EditorChoiceSetReply> => { saved.push([project, editor]); return { saved: true, revision: saved.length }; }, editorOpen: async (): Promise<EditorOpenReply> => ({ opened: true }), applySaved: h.live.applySaved };
    const cards = [card("leftOff", [handle("editor", "ed-a", { project: "sub-a" })], "app")];
    const before = actionsView(page, input(cards, { choices: h.live.state().choices }), held(cards));
    expect((before.leftOff[0]!.buttons[0] as EditorButton).choice).toBe("ask");
    await chooseAndOpen({ handle: "ed-a", project: "sub-a", editor: "zed", remember: true }, deps);
    expect(saved).toEqual([["sub-a", "zed"]]);
    expect(h.live.state().choices.get("sub-a")).toBe("zed");
    expect(h.live.state().choices.get("sub-b")).toBeNull();
    const after = actionsView(page, input(cards, { choices: h.live.state().choices }), held(cards));
    expect(after.resume[0]!.label).toBe("Resume · app · Open in Zed");
    expect(editorClick(after.resume[0]!.button.choice, false)).toEqual({ kind: "launch", editor: "zed" });
    await chooseAndOpen({ handle: "ed-b", project: "sub-b", editor: "cursor", remember: true }, deps);
    expect(saved).toEqual([["sub-a", "zed"], ["sub-b", "cursor"]]);
    expect(h.live.state().choices.get("sub-a")).toBe("zed");
    expect(h.live.state().choices.get("sub-b")).toBe("cursor");
    h.live.dispose();
  });

  test("a refused save leaves the published choice as it was", async () => {
    const h = driver(); h.live.mount(); await flush();
    h.calls[0]!.resolve({ editors: editorsOf("cursor", "zed"), projects: [{ project: "sub-a", label: "a", choice: "cursor", availability: "ready" }], discoveryConfigured: false });
    await flush();
    await chooseAndOpen({ handle: "ed-a", project: "sub-a", editor: "zed", remember: true }, { editorChoiceSet: async () => ({ refused: "preferences-full" }), editorOpen: async () => ({ opened: true }), applySaved: h.live.applySaved });
    expect(h.live.state().choices.get("sub-a")).toBe("cursor");
    h.live.dispose();
  });
});

describe("B2-M6-T15: every reply code's fixed text (§0's table)", () => {
  test.each([
    [{ refused: "stale" }, "This work has changed since this briefing."],
    [{ refused: "links-off" }, "GitHub links are off."],
    [{ refused: "unknown-repo" }, "This repository has not been checked."],
    [{ refused: "not-pushed" }, "This work is not on GitHub yet."],
    [{ refused: "invalid-target" }, "This GitHub target is unavailable."],
    [{ refused: "ambiguous" }, "This work has more than one possible GitHub destination."],
    [{ refused: "host" }, "This repository does not have a supported GitHub link."],
    [{ failed: "opener" }, "Could not open GitHub"],
    [{ opened: true }, null],
  ] as const)("open_github %j", (reply, text) => { expect(githubReplyText(reply)).toBe(text); });

  const HEAD = "Push command unavailable for this work";
  test.each([
    [{ refused: "stale" }, [HEAD, "This work has changed since this briefing."]],
    [{ refused: "unknown-repo" }, [HEAD, "This repository has not been checked."]],
    [{ refused: "unsafe-name" }, [HEAD, "A push command cannot be copied safely for this work."]],
    [{ refused: "no-remote" }, [HEAD, "This work has no push destination."]],
    [{ refused: "ambiguous" }, [HEAD, "The push destination could not be established."]],
    [{ refused: "name-mismatch" }, [HEAD, "This branch pushes to a differently named branch; push it yourself"]],
    [{ refused: "transport" }, [HEAD, "This push destination isn't one the app can copy a command for."]],
    [{ failed: "clipboard" }, ["Could not copy push command"]],
    [{ copied: true }, ["Copied"]],
    [{ copiedToOrigin: true }, ["Copied. Pushes to origin."]],
  ] as const)("copy_push_command %j", (reply, lines) => { expect(copyReplyLines(reply)).toEqual([...lines]); });

  test.each([
    [{ refused: "unsupported" }, "Opening an editor is only available on macOS."],
    [{ refused: "stale" }, "This work has changed since this briefing."],
    [{ refused: "no-editor" }, "No supported editor installed"],
    [{ refused: "invalid-folder" }, "This project folder is unavailable."],
    [{ failed: "editor" }, "Could not open editor"],
    [{ opened: true }, null],
  ] as const)("editor_open %j", (reply, text) => { expect(editorOpenText(reply)).toBe(text); });
});

describe("a successful copy's line fades (actionRuns)", () => {
  type Pending = { ms: number; fire: () => void; cancelled: boolean };
  function rig() {
    const lines: (ActionLine | null)[] = [];
    const pending: Pending[] = [];
    const announced: string[] = [];
    const live = actionRuns((l) => lines.push(l), (t) => announced.push(t), (ms, fire) => {
      const timer: Pending = { ms, fire, cancelled: false };
      pending.push(timer);
      return () => { timer.cancelled = true; };
    });
    const armed = (): Pending[] => pending.filter((p) => !p.cancelled);
    return { lines, pending, announced, live, armed, last: (): ActionLine | null | undefined => lines.at(-1) };
  }
  const replying = (reply: CopyPushCommandReply) => async (): Promise<CopyPushCommandReply> => reply;

  test("both copied replies fade, after COPIED_LINE_MS", async () => {
    expect(COPIED_LINE_MS).toBe(8_000);
    for (const [reply, line] of [[{ copied: true }, "Copied"], [{ copiedToOrigin: true }, "Copied. Pushes to origin."]] as const) {
      const r = rig();
      await r.live.copy("k", ["h"], replying(reply));
      expect(r.last()).toEqual({ key: "k", lines: [line] });
      expect(r.announced).toEqual([line]);
      expect(r.armed().map((p) => p.ms)).toEqual([COPIED_LINE_MS]);
      r.armed()[0]!.fire();
      expect(r.last()).toBeNull();
    }
  });
  test("a refusal, a failure and a throw stay: they say why nothing was copied", async () => {
    for (const call of [replying({ refused: "ambiguous" }), replying({ failed: "clipboard" }), async (): Promise<CopyPushCommandReply> => { throw new Error("x"); }]) {
      const r = rig();
      await r.live.copy("k", ["h"], call);
      expect(r.last()).not.toBeNull();
      expect(r.pending).toEqual([]);
    }
  });
  test("a GitHub refusal stays too", async () => {
    const r = rig();
    await r.live.github("k", "h", async () => ({ refused: "not-pushed" }));
    expect(r.last()).toEqual({ key: "k", lines: ["This work is not on GitHub yet."] });
    expect(r.pending).toEqual([]);
  });
  test("a later line cancels the fade, so it never takes a line it wasn't set for", async () => {
    const r = rig();
    await r.live.copy("a", ["h"], replying({ copied: true }));
    const first = r.pending[0]!;
    await r.live.copy("b", ["h"], replying({ refused: "ambiguous" }));
    expect(first.cancelled).toBe(true);
    expect(r.armed()).toEqual([]);
    expect(r.last()).toEqual({ key: "b", lines: expect.any(Array) });
  });
  test("a click whose answer is outstanding has already cancelled the fade", async () => {
    const r = rig();
    await r.live.copy("a", ["h"], replying({ copied: true }));
    let answer: (reply: CopyPushCommandReply) => void = () => {};
    const outstanding = r.live.copy("b", ["h"], () => new Promise((resolve) => { answer = resolve; }));
    expect(r.pending[0]!.cancelled).toBe(true);
    answer({ copied: true });
    await outstanding;
    expect(r.armed()).toHaveLength(1);
  });
  test("a new page cancels the fade", async () => {
    const r = rig();
    await r.live.copy("k", ["h"], replying({ copied: true }));
    r.live.reset();
    expect(r.last()).toBeNull();
    expect(r.armed()).toEqual([]);
  });
});

describe("B2-M6-T15: a GitHub or copy click (actionRuns)", () => {
  function runs(github: OpenGithubReply | Error | Promise<OpenGithubReply> = { opened: true }, clip: CopyPushCommandReply | Error = { copied: true }) {
    const calls: unknown[][] = [];
    const lines: (ActionLine | null)[] = [];
    const announced: string[] = [];
    const live = actionRuns((l) => lines.push(l), (text) => announced.push(text));
    const openGithub = (handle: string): Promise<OpenGithubReply> => { calls.push(["github", handle]); if (github instanceof Error) throw github; return Promise.resolve(github); };
    const copyPushCommand = async (handles: string[]): Promise<CopyPushCommandReply> => { calls.push(["copy", handles]); if (clip instanceof Error) throw clip; return clip; };
    return { driver: { github: (handle: string, key = handle) => live.github(key, handle, openGithub), copy: (handles: string[], key = handles[0]!) => live.copy(key, handles, copyPushCommand) }, calls, lines, announced };
  }
  test("a landed open says nothing; a refusal draws its row under its own button", async () => {
    const ok = runs(); await ok.driver.github("h1");
    expect(ok.calls).toEqual([["github", "h1"]]); expect(ok.lines.at(-1)).toBeNull();
    const no = runs({ refused: "not-pushed" }); await no.driver.github("h1");
    expect(no.lines.at(-1)).toEqual({ key: "h1", lines: ["This work is not on GitHub yet."] });
  });
  test("a wrapper that throws is the fixed failure, never its message", async () => {
    const g = runs(new Error("/secret/path")); await g.driver.github("h1");
    expect(g.lines.at(-1)).toEqual({ key: "h1", lines: ["Could not open GitHub"] });
    const c = runs({ opened: true }, new Error("/secret/path")); await c.driver.copy(["h1", "h2"]);
    expect(c.lines.at(-1)).toEqual({ key: "h1", lines: ["Could not copy push command"] });
    expect(JSON.stringify([g.lines, c.lines])).not.toContain("secret");
  });
  test("a copy sends the complete list once and answers under the list's own key", async () => {
    const c = runs(); await c.driver.copy(["h1", "h2"]);
    expect(c.calls).toEqual([["copy", ["h1", "h2"]]]);
    expect(c.lines.at(-1)).toEqual({ key: "h1", lines: ["Copied"] });
    const origin = runs({ opened: true }, { copiedToOrigin: true }); await origin.driver.copy(["h1", "h2"]);
    expect(origin.calls).toEqual([["copy", ["h1", "h2"]]]);
    expect(origin.lines.at(-1)).toEqual({ key: "h1", lines: ["Copied. Pushes to origin."] });
    const no = runs({ opened: true }, { refused: "name-mismatch" }); await no.driver.copy(["h1"]);
    expect(no.lines.at(-1)).toEqual({ key: "h1", lines: ["Push command unavailable for this work", "This branch pushes to a differently named branch; push it yourself"] });
  });
  test("a second activation while the first is outstanding sends nothing; a later one does", async () => {
    let release = (_: OpenGithubReply): void => {};
    const r = runs(new Promise<OpenGithubReply>((resolve) => { release = resolve; }));
    const first = r.driver.github("h1"); void r.driver.github("h1");
    expect(r.calls).toHaveLength(1);
    release({ opened: true }); await first;
    await r.driver.github("h1");
    expect(r.calls).toHaveLength(2);
  });
  test("a line is under the button's own key, not its handle, so a re-mint keeps it; a repeat with the new handle still waits", async () => {
    let release = (_: OpenGithubReply): void => {};
    const r = runs(new Promise<OpenGithubReply>((resolve) => { release = resolve; }));
    const first = r.driver.github("old", actionKey("app", "branch"));
    void r.driver.github("new", actionKey("app", "branch"));
    expect(r.calls).toEqual([["github", "old"]]);
    release({ refused: "stale" }); await first;
    expect(r.lines.at(-1)).toEqual({ key: actionKey("app", "branch"), lines: ["This work has changed since this briefing."] });
    expect(lineOf(r.lines.at(-1)!, "app")).toEqual(["This work has changed since this briefing."]);
    expect(lineOf(r.lines.at(-1)!, "ap")).toEqual([]);
    expect(lineOf(null, "app")).toEqual([]);
  });
  test("a line is announced once, all of it; a landed open announces nothing", async () => {
    const ok = runs(); await ok.driver.github("h1");
    expect(ok.announced).toEqual([]);
    const no = runs({ opened: true }, { refused: "name-mismatch" }); await no.driver.copy(["h1"]);
    expect(no.announced).toEqual(["Push command unavailable for this work: This branch pushes to a differently named branch; push it yourself"]);
    expect(no.lines.at(-1)).toEqual({ key: "h1", lines: ["Push command unavailable for this work", "This branch pushes to a differently named branch; push it yourself"] });
    const copied = runs(); await copied.driver.copy(["h1"]);
    expect(copied.announced).toEqual(["Copied"]);
    const origin = runs({ opened: true }, { copiedToOrigin: true }); await origin.driver.copy(["h1"]);
    expect(origin.announced).toEqual(["Copied. Pushes to origin."]);
  });
  test("a new click clears the last line at once", async () => {
    const r = runs({ refused: "stale" }); await r.driver.github("h1");
    expect(r.lines.at(-1)).not.toBeNull();
    const pending = r.driver.github("h2");
    expect(r.lines.at(-1)).toBeNull();
    await pending;
  });
  describe("a new page", () => {
    const pendingRuns = () => {
      const lines: (ActionLine | null)[] = [];
      const announced: string[] = [];
      const resolvers: ((reply: OpenGithubReply) => void)[] = [];
      const calls: string[] = [];
      const live = actionRuns((l) => lines.push(l), (text) => announced.push(text));
      const openGithub = (handle: string): Promise<OpenGithubReply> => { calls.push(handle); return new Promise((resolve) => resolvers.push(resolve)); };
      return { live, openGithub, lines, announced, resolvers, calls };
    };
    test("clears the line, so a refusal does not stay beside a button that now works", async () => {
      const r = pendingRuns();
      const first = r.live.github("k", "h1", r.openGithub); r.resolvers[0]!({ refused: "not-pushed" }); await first;
      expect(r.lines.at(-1)).toEqual({ key: "k", lines: ["This work is not on GitHub yet."] });
      r.live.reset();
      expect(r.lines.at(-1)).toBeNull();
    });
    test("an answer still outstanding says nothing on the later page: no line, no announcement", async () => {
      const r = pendingRuns();
      const first = r.live.github("k", "h1", r.openGithub);
      r.live.reset();
      r.resolvers[0]!({ refused: "not-pushed" }); await first;
      expect(r.lines.at(-1)).toBeNull();
      expect(r.announced).toEqual([]);
    });
    test("the later page's own click is not held back by the outstanding one, and the old answer does not free it", async () => {
      const r = pendingRuns();
      const first = r.live.github("k", "h1", r.openGithub);
      r.live.reset();
      const second = r.live.github("k", "h2", r.openGithub);
      expect(r.calls).toEqual(["h1", "h2"]);
      r.resolvers[0]!({ refused: "stale" }); await first;
      void r.live.github("k", "h3", r.openGithub); // still outstanding: one activation is one browser tab
      expect(r.calls).toEqual(["h1", "h2"]);
      r.resolvers[1]!({ refused: "not-pushed" }); await second;
      expect(r.lines.at(-1)).toEqual({ key: "k", lines: ["This work is not on GitHub yet."] });
      expect(r.announced).toEqual(["This work is not on GitHub yet."]);
    });
  });
  describe("actionsPageKey: the day rolling over on a page that stays", () => {
    test("the same briefing is a different page once it is stale, and stays one page while it is", () => {
      expect(actionsPageKey("h", false)).not.toBe(actionsPageKey("h", true));
      expect(actionsPageKey("h", true)).toBe(actionsPageKey("h", true));
      expect(actionsPageKey("h", false)).toBe(actionsPageKey("h", false));
      expect(actionsPageKey("h", true)).not.toBe(actionsPageKey("i", true));
    });
    test("no briefing is no page, stale or not", () => {
      expect(actionsPageKey(null, false)).toBeNull();
      expect(actionsPageKey(null, true)).toBeNull();
    });
    test("rollover: a chooser left open closes and Open sends nothing; a line goes; an answer outstanding says nothing", async () => {
      const opened: string[] = [];
      let flow: EditorFlowState = EDITOR_FLOW_IDLE;
      const editors = editorFlow({
        editorList: async () => ({ editors: [{ editor: "zed", label: "Zed" }], projects: [], preselect: null }) as never,
        editorOpen: async (handle) => { opened.push(handle); return { opened: true } as never; },
        editorChoiceSet: async () => ({ saved: true }) as never,
        applySaved: () => {},
        publish: (s) => { flow = s; },
        announce: () => {},
      });
      let line: ActionLine | null = null;
      const announced: string[] = [];
      const runs = actionRuns((l) => { line = l; }, (t) => announced.push(t));
      const newPage = onNewPage(() => { runs.reset(); editors.reset(); });
      newPage(actionsPageKey("h", false));
      editors.click("card", { target: "editor", handle: "e1", project: "p".repeat(32), choice: null, label: "" } as never, false);
      await Bun.sleep(0);
      expect(flow.chooser).not.toBeNull();
      await runs.github("k", "g1", async () => ({ refused: "stale" }) as never);
      expect(line).not.toBeNull();
      let answer!: (r: never) => void;
      const outstanding = runs.github("k2", "g2", () => new Promise((r) => { answer = r as never; }));
      announced.length = 0;
      newPage(actionsPageKey("h", true));
      expect(flow).toEqual(EDITOR_FLOW_IDLE);
      expect(line).toBeNull();
      editors.open("zed" as never, false);
      await Bun.sleep(0);
      expect(opened).toEqual([]);
      answer({ refused: "stale" } as never);
      await outstanding;
      expect(line).toBeNull();
      expect(announced).toEqual([]);
    });
  });
  describe("onNewPage: what counts as a new page", () => {
    const counted = () => {
      let cleared = 0;
      return { key: onNewPage(() => { cleared += 1; }), cleared: () => cleared };
    };
    test("the first key and a repeat of it clear nothing; a different key does", () => {
      const p = counted();
      p.key("a"); p.key("a");
      expect(p.cleared()).toBe(0);
      p.key("b");
      expect(p.cleared()).toBe(1);
      p.key("b");
      expect(p.cleared()).toBe(1);
      p.key("a");
      expect(p.cleared()).toBe(2);
    });
    test("null is not a page: a read error and the same page back clears nothing, and a different page after it does", () => {
      const p = counted();
      p.key(null); p.key("a");
      expect(p.cleared()).toBe(0);
      p.key(null); p.key("a");
      expect(p.cleared()).toBe(0);
      p.key(null); p.key("b");
      expect(p.cleared()).toBe(1);
    });
  });
});

describe("B2-M6-T15: the editor control's flow (editorFlow)", () => {
  const editorsOf = (...ids: EditorId[]) => ids.map((editor) => ({ editor, label: EDITOR_LABELS[editor] }));
  const button = (choice: EditorChoice | null | undefined, handle = "h1"): EditorButton => ({ target: "editor", handle, project: "p1", choice, label: "Open in editor…" });
  const listing = (choice: EditorChoice | null): EditorListReply => ({ editors: editorsOf("vs-code", "zed"), projects: [{ project: "p1", label: "app", choice, availability: "ready" }], discoveryConfigured: false, preselect: "zed" });
  function flowOf(o: { list?: EditorListReply | Error | Promise<EditorListReply>; open?: (EditorOpenReply | Error | Promise<EditorOpenReply>)[]; save?: EditorChoiceSetReply } = {}) {
    const calls: unknown[][] = [];
    const states: EditorFlowState[] = [];
    const announced: string[] = [];
    const opens = [...(o.open ?? [{ opened: true } as EditorOpenReply | Error | Promise<EditorOpenReply>])];
    const flow = editorFlow({
      announce: (text) => { announced.push(text); },
      editorList: (handle) => { calls.push(["list", handle]); const l = o.list ?? listing(null); if (l instanceof Error) throw l; return Promise.resolve(l); },
      editorOpen: async (handle, editor) => { calls.push(["open", handle, editor]); const r = await (opens.shift() ?? { opened: true }); if (r instanceof Error) throw r; return r; },
      editorChoiceSet: async (project, editor) => { calls.push(["set", project, editor]); return o.save ?? { saved: true, revision: 1 }; },
      applySaved: (project, choice) => { calls.push(["applied", project, choice]); },
      publish: (s) => states.push(s),
    });
    return { flow, calls, states, announced, now: () => states.at(-1) ?? EDITOR_FLOW_IDLE };
  }

  test("a stored editor launches directly, once, with no list and no save; it goes through chooseAndOpen's guard", async () => {
    const f = flowOf(); f.flow.click("app", button("zed"), false);
    expect(f.now().busy).toBe(true); await flush();
    expect(f.calls).toEqual([["open", "h1", "zed"]]);
    expect(f.now()).toEqual({ card: "app", project: "p1", chooser: null, line: null, saveLine: null, busy: false });
    const thrown = flowOf({ open: [new Error("/secret")] }); thrown.flow.click("app", button("zed"), false); await flush();
    expect(thrown.now().line).toBe("Could not open editor");
    expect(JSON.stringify(thrown.states)).not.toContain("secret");
  });

  test.each([[null, true], ["ask", false], [undefined, false]] as const)("choice %j asks first, and the box starts %j from the clicked handle's reply", async (choice, remember) => {
    const f = flowOf({ list: { ...listing(null), projects: choice === undefined ? [] : [{ project: "p1", label: "app", choice, availability: "ready" }] } as EditorListReply });
    f.flow.click("app", button(choice), false); await flush();
    expect(f.calls).toEqual([["list", "h1"]]);
    expect(f.now().chooser).toMatchObject({ state: "choose", selected: "zed", remember });
    expect(f.now().busy).toBe(false);
  });

  test("⌥ asks again even with a stored editor, and starts unticked", async () => {
    const f = flowOf({ list: listing("zed") }); f.flow.click("app", button("zed"), true); await flush();
    expect(f.calls).toEqual([["list", "h1"]]);
    expect(f.now().chooser?.remember).toBe(false);
  });

  test("a list that throws is the fixed detection failure, never its message; a refusal uses its row", async () => {
    const f = flowOf({ list: new Error("/secret") }); f.flow.click("app", button(null), false); await flush();
    expect(f.now()).toEqual({ card: "app", project: "p1", chooser: null, line: "Could not list installed editors", saveLine: null, busy: false });
    expect(JSON.stringify(f.states)).not.toContain("secret");
    const stale = flowOf({ list: { refused: "stale" } }); stale.flow.click("app", button(null), false); await flush();
    expect(stale.now().line).toBe("This work has changed since this briefing.");
    const none = flowOf({ list: { ...listing(null), editors: [] } as EditorListReply }); none.flow.click("app", button(null), false); await flush();
    expect(none.now().line).toBe("No supported editor installed");
  });

  test("Open: ticked saves, publishes, then launches once; the chooser is gone before anything is sent", async () => {
    const f = flowOf(); f.flow.click("app", button(null), false); await flush(); f.calls.length = 0;
    f.flow.open("zed", true);
    expect(f.now().chooser).toBeNull(); expect(f.now().busy).toBe(true);
    await flush();
    expect(f.calls).toEqual([["set", "p1", "zed"], ["applied", "p1", "zed"], ["open", "h1", "zed"]]);
    expect(f.now()).toEqual({ card: "app", project: "p1", chooser: null, line: null, saveLine: null, busy: false });
  });

  test("a double activation of Open launches once", async () => {
    const f = flowOf(); f.flow.click("app", button(null), false); await flush(); f.calls.length = 0;
    f.flow.open("zed", false); f.flow.open("zed", false); f.flow.open("vs-code", true);
    await flush();
    expect(f.calls).toEqual([["open", "h1", "zed"]]);
    f.flow.open("zed", false); await flush(); // Nothing is open now.
    expect(f.calls).toEqual([["open", "h1", "zed"]]);
  });

  test("a second click while busy sends nothing", async () => {
    const f = flowOf(); f.flow.click("app", button("zed"), false); f.flow.click("app", button("zed"), false); f.flow.click("app", button(null, "h2"), false); await flush();
    expect(f.calls).toEqual([["open", "h1", "zed"]]);
  });

  test("a removed editor reopens the chooser from the launch's own reply, unticked for a stored one", async () => {
    const f = flowOf({ open: [{ refused: "no-editor" }], list: listing("cursor") }); f.flow.click("app", button("cursor"), false); await flush();
    expect(f.calls).toEqual([["open", "h1", "cursor"], ["list", "h1"]]);
    expect(f.now().chooser).toMatchObject({ state: "choose", remember: false });
    expect(f.now().line).toBeNull();
    const none = flowOf({ open: [{ refused: "no-editor" }], list: { ...listing(null), editors: [] } as EditorListReply }); none.flow.click("app", button("cursor"), false); await flush();
    expect(none.now().line).toBe("No supported editor installed");
    expect(none.now().chooser).toBeNull();
  });

  test("a refused save's line survives the launch's no-editor reopen", async () => {
    const f = flowOf({ save: { refused: "preferences-full" }, open: [{ refused: "no-editor" }] });
    f.flow.click("app", button(null), false); await flush();
    f.flow.open("zed", true); await flush();
    expect(f.now().chooser).not.toBeNull();
    expect(f.now().saveLine).toBe("Editor choices could not be saved: preferences are full.");
    expect(f.calls.filter((c) => c[0] === "list")).toHaveLength(2);
    const landed = flowOf({ save: { refused: "stale" } }); landed.flow.click("app", button(null), false); await flush();
    landed.flow.open("zed", true); await flush();
    expect(landed.now()).toEqual({ card: "app", project: "p1", chooser: null, line: null, saveLine: "This project has changed since this briefing.", busy: false });
  });

  describe("a re-mint while the chooser is open", () => {
    test("the state names a card and a project, so Open finds the re-minted button by project and sends its handle, once", async () => {
      const f = flowOf(); f.flow.click("app", button(null, "old"), false); await flush();
      expect(f.now().chooser).not.toBeNull();
      f.calls.length = 0;
      // A full check gives the card new buttons with new handles, as `LeftOff` passes them: the flow is not told.
      const reminted: (GithubButton | EditorButton)[] = [{ target: "branch", handle: "b2", label: "Open branch ↗" }, button(null, "new")];
      f.flow.open("zed", false, liveEditorButton(reminted, f.now().project)); await flush();
      expect(f.calls).toEqual([["open", "new", "zed"]]);
    });
    test("a ticked answer saves its project and launches the live handle", async () => {
      const f = flowOf(); f.flow.click("app", button(null, "old"), false); await flush(); f.calls.length = 0;
      f.flow.open("zed", true, button(null, "new")); await flush();
      expect(f.calls).toEqual([["set", "p1", "zed"], ["applied", "p1", "zed"], ["open", "new", "zed"]]);
    });
    test("with no live button the old handle goes, and answers stale in its fixed row", async () => {
      const f = flowOf({ open: [{ refused: "stale" }] }); f.flow.click("app", button(null, "old"), false); await flush(); f.calls.length = 0;
      f.flow.open("zed", false, null); await flush();
      expect(f.calls).toEqual([["open", "old", "zed"]]);
      expect(f.now().line).toBe("This work has changed since this briefing.");
      expect(f.now().chooser).toBeNull();
    });
    test("a removed editor's reopen lists with the live handle", async () => {
      const f = flowOf({ open: [{ refused: "no-editor" }] }); f.flow.click("app", button(null, "old"), false); await flush(); f.calls.length = 0;
      f.flow.open("zed", false, button(null, "new")); await flush();
      expect(f.calls).toEqual([["open", "new", "zed"], ["list", "new"]]);
    });
    test("the live button is found by project among a card's buttons, an editor's only", () => {
      const live = button(null, "new");
      const branch: GithubButton = { target: "branch", handle: "b1", label: "Open branch ↗" };
      expect(liveEditorButton([branch, live], "p1")).toBe(live);
      expect(liveEditorButton([branch, live], "p2")).toBeNull();
      expect(liveEditorButton([branch], "p1")).toBeNull();
      expect(liveEditorButton([live], null)).toBeNull();
    });
  });

  test("the flow's lines are announced, each once; a chooser opening says nothing", async () => {
    const chooser = flowOf(); chooser.flow.click("app", button(null), false); await flush();
    expect(chooser.announced).toEqual([]);
    const refused = flowOf({ open: [{ refused: "invalid-folder" }] }); refused.flow.click("app", button("zed"), false); await flush();
    expect(refused.announced).toEqual(["This project folder is unavailable."]);
    const list = flowOf({ list: { failed: "detection" } }); list.flow.click("app", button(null), false); await flush();
    expect(list.announced).toEqual(["Could not list installed editors"]);
    const both = flowOf({ save: { refused: "stale" }, open: [{ refused: "invalid-folder" }] }); both.flow.click("app", button(null), false); await flush();
    both.flow.open("zed", true); await flush();
    expect(both.announced).toEqual(["This project has changed since this briefing. This project folder is unavailable."]);
    const reopen = flowOf({ save: { refused: "preferences-full" }, open: [{ refused: "no-editor" }] }); reopen.flow.click("app", button(null), false); await flush();
    reopen.flow.open("zed", true); await flush();
    expect(reopen.announced).toEqual(["Editor choices could not be saved: preferences are full."]);
    const opened = flowOf(); opened.flow.click("app", button("zed"), false); await flush();
    expect(opened.announced).toEqual([]);
  });

  test("a launch refused draws its row", async () => {
    const f = flowOf({ open: [{ refused: "invalid-folder" }] }); f.flow.click("app", button("zed"), false); await flush();
    expect(f.now().line).toBe("This project folder is unavailable.");
  });

  describe("a new page", () => {
    test("closes the chooser and clears the lines, whatever the flow's state", async () => {
      const open = flowOf(); open.flow.click("app", button(null), false); await flush();
      expect(open.now().chooser).not.toBeNull();
      open.flow.reset();
      expect(open.now()).toEqual(EDITOR_FLOW_IDLE);
      const line = flowOf({ open: [{ refused: "invalid-folder" }] }); line.flow.click("app", button("zed"), false); await flush();
      expect(line.now().line).not.toBeNull();
      line.flow.reset();
      expect(line.now()).toEqual(EDITOR_FLOW_IDLE);
    });
    test("a list still outstanding opens no chooser on the later page, and a later click is not held back", async () => {
      let release = (_: EditorListReply): void => {};
      const f = flowOf({ list: new Promise<EditorListReply>((resolve) => { release = resolve; }) });
      f.flow.click("app", button(null, "h1"), false);
      expect(f.now().busy).toBe(true);
      f.flow.reset();
      expect(f.now()).toEqual(EDITOR_FLOW_IDLE);
      release(listing(null)); await flush();
      expect(f.now()).toEqual(EDITOR_FLOW_IDLE);
      expect(f.announced).toEqual([]);
      f.flow.click("app", button("zed", "h2"), false); await flush();
      expect(f.calls.at(-1)).toEqual(["open", "h2", "zed"]);
    });
    test("a launch still outstanding says nothing on the later page, and does not reopen a chooser there", async () => {
      for (const reply of [{ refused: "invalid-folder" }, { refused: "no-editor" }] as EditorOpenReply[]) {
        let release = (_: EditorOpenReply): void => {};
        const f = flowOf({ open: [new Promise<EditorOpenReply>((resolve) => { release = resolve; })] });
        f.flow.click("app", button("zed", "h1"), false);
        f.flow.reset();
        f.calls.length = 0;
        release(reply); await flush();
        expect(f.now()).toEqual(EDITOR_FLOW_IDLE);
        expect(f.announced).toEqual([]);
        expect(f.calls).toEqual([]);
      }
    });
    test("Open does nothing after it: the answer belonged to the earlier page", async () => {
      const f = flowOf(); f.flow.click("app", button(null, "h1"), false); await flush();
      f.flow.reset(); f.calls.length = 0;
      f.flow.open("zed", true, button(null, "h2")); await flush();
      expect(f.calls).toEqual([]);
    });
  });

  test("Cancel closes it and sends nothing; a later click starts clean", async () => {
    const f = flowOf({ list: { failed: "detection" } }); f.flow.click("app", button(null), false); await flush();
    expect(f.now().line).not.toBeNull();
    const g = flowOf(); g.flow.click("app", button(null), false); await flush(); g.calls.length = 0;
    g.flow.cancel();
    expect(g.now()).toEqual(EDITOR_FLOW_IDLE);
    await flush(); expect(g.calls).toEqual([]);
    g.flow.click("app", button(null, "h2"), false);
    expect(g.now()).toEqual({ card: "app", project: "p1", chooser: null, line: null, saveLine: null, busy: true });
    await flush();
  });
});

describe("B2-M6-T15: the inventory's failure reaches the view (T13's actionState.error)", () => {
  const withError = (patch: Partial<ActionsInput> = {}, p = page, cards = allCards) => actionsView(p, input(cards, { error: "Could not list installed editors", ...patch }), held(cards));
  test("drawn while an editor button is showing, on macOS, and nowhere else", () => {
    expect(withError().editorError).toBe("Could not list installed editors");
    expect(model().editorError).toBeNull();
    for (const os of ["linux", "windows", "other"] as const) expect(withError({ os }).editorError).toBeNull();
    expect(withError({}, { ...page, stale: true }).editorError).toBeNull();
    const noEditor = [card("leftOff", [handle("branch")])];
    expect(withError({}, page, noEditor).editorError).toBeNull();
  });
});

test("Today wires one per-mount driver, prefs subscription and live handles without new props/tick/focus reads", () => {
  const source = readFileSync(new URL("../src/routes/Today.svelte", import.meta.url), "utf8");
  const flat = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "").replace(/\s+/g, " ");
  expect(flat).toContain('import { ACTIONS_ANNOUNCE, ACTIONS_PAGE, ACTIONS_SAVED, actionsLive, type ActionsLiveState } from "../lib/actions-live";');
  expect(flat).toContain("actionsLive({ os, editorList, publish: (s) => (actionState = s) })");
  expect(flat).toContain("$effect(() => { actionLive.mount(); return () => actionLive.dispose(); });");
  expect(flat).toContain('import { gitLive, liveActionCards, type GitLiveState } from "../lib/git-live";');
  expect(flat).toContain("const actionCards = $derived(liveActionCards(gitState));");
  expect(flat).toContain("$effect(() => { const cards = actionCards; untrack(() => actionLive.onActions(cards)); });");
  expect(flat).toContain("{ cards: actionCards, githubLinks: prefs.githubLinks, os, choices: actionState.choices, error: actionState.error }");
  expect(flat).toContain("setContext(ACTIONS_SAVED, actionLive.applySaved);");
  expect(flat).toContain("setContext(ACTIONS_ANNOUNCE, (line: string) => { liveText = nextLiveText(liveText, line); });");
  expect(flat).toContain('setContext(ACTIONS_PAGE, () => actionsPageKey(briefingKey, deck.kind === "slides" && deck.page.stale));');
  expect(flat).toContain("return onAppPrefsChange((next) => (prefs = next));");
  // B2's `actions` argument, with room for A2's approved trailing input (plan §1.3).
  expect(flat).toMatch(/deckView\(\{ model, today, firstName: prefs\.firstName, gitDetail, calendarDetail, calendarOn, actions(?:, \w+)* \}\)/);
  expect(source.match(/actionsLive\(/g)).toHaveLength(1);
  expect(source).not.toMatch(/actionLive\.(onFocus|onMinute)|actionsConfigRevision|onactionsconfigsaved/);
});

/* ── B2-M6-T16: Settings' own editor inventory (P-M8). The harness runs no effects, so the driver is tested directly here. ── */

describe("B2-M6-T16: editorLinksLive", () => {
  const g = globalThis as unknown as { window?: unknown };
  /** The real app-prefs store over a fake IPC, so "the store's settled value" is the store's. Left at its defaults afterwards. */
  async function withStore(answer: (command: string, args: unknown) => unknown, run: () => Promise<void>): Promise<void> {
    const had = "window" in g;
    const before = g.window;
    let current = answer;
    g.window = { __TAURI_INTERNALS__: { invoke: (command: string, args: unknown) => { try { return Promise.resolve(current(command, args)); } catch (e) { return Promise.reject(e); } } } };
    try {
      await run();
    } finally {
      current = () => ({ slides: true, githubLinks: true });
      await loadAppPrefs();
      if (had) g.window = before;
      else delete g.window;
    }
  }
  const stored = (githubLinks: boolean) => ({ slides: true, githubLinks });
  type ReadCall = { args: unknown[]; resolve: (r: EditorListReply) => void; reject: (e: unknown) => void };
  type SaveCall = { project: string; choice: EditorChoice; resolve: (r: EditorChoiceSetReply) => void; reject: (e: unknown) => void };
  function links(os: Os = "macos", setter: (on: boolean) => Promise<AppPrefsSetOutcome> = () => Promise.resolve({ ok: true })) {
    const reads: ReadCall[] = [];
    const saves: SaveCall[] = [];
    const sets: boolean[] = [];
    const states: EditorLinksState[] = [];
    const live = editorLinksLive({
      os,
      editorList: (...args: unknown[]) => new Promise((resolve, reject) => reads.push({ args, resolve, reject })),
      editorChoiceSet: (project, choice) => new Promise((resolve, reject) => saves.push({ project, choice, resolve, reject })),
      setGithubLinks: (on) => { sets.push(on); return setter(on); },
      publish: (s) => states.push(s),
    });
    return { live, reads, saves, sets, states };
  }
  const list = (choice: EditorChoice | null = null, patch: Partial<Extract<EditorListReply, { editors: unknown }>> = {}): EditorListReply => ({
    editors: [{ editor: "cursor", label: "Cursor" }, { editor: "zed", label: "Zed" }],
    projects: [{ project: "p1", label: "app", choice, availability: "ready" }, { project: null, label: "web", choice: null, availability: "not-checked" }],
    discoveryConfigured: false,
    ...patch,
  });
  const ready = (reply: EditorListReply) => {
    if (!("editors" in reply)) throw new Error("fixture");
    return { state: "ready" as const, editors: reply.editors, projects: reply.projects, discoveryConfigured: reply.discoveryConfigured };
  };

  describe("the open trigger", () => {
    test("nothing is read before the page is opened; opening sends one list with no handle, draws loading, then ready", async () => {
      const h = links();
      expect(h.live.state().editors).toEqual({ state: "idle" });
      expect(h.reads).toHaveLength(0);
      h.live.open();
      expect(h.reads).toHaveLength(1);
      expect(h.reads[0]!.args).toEqual([]);
      expect(h.live.state().editors).toEqual({ state: "loading" });
      h.reads[0]!.resolve(list());
      await flush();
      expect(h.live.state().editors).toEqual(ready(list()));
      expect(h.states.at(-1)).toEqual(h.live.state());
    });

    test("the reply's members are the view's and no others: `preselect` belongs to a handle's ask", async () => {
      const h = links();
      h.live.open();
      h.reads[0]!.resolve(list(null, { preselect: "zed", discoveryConfigured: true }));
      await flush();
      expect(Object.keys(h.live.state().editors).sort()).toEqual(["discoveryConfigured", "editors", "projects", "state"]);
      const view = h.live.state().editors;
      expect(view.state === "ready" && view.discoveryConfigured).toBe(true);
    });

    test("opening again reads again, and keeps the drawn rows until the answer: loading would drop the focus from a select", async () => {
      const h = links();
      h.live.open();
      h.reads[0]!.resolve(list());
      await flush();
      const drawn = h.live.state().editors;
      h.live.open();
      expect(h.reads).toHaveLength(2);
      expect(h.live.state().editors).toBe(drawn);
      h.reads[1]!.resolve(list("zed"));
      await flush();
      expect(h.live.state().editors).toEqual(ready(list("zed")));
    });

    test("off macOS: no read, ever, and idle is published", async () => {
      for (const os of ["linux", "windows"] as const) {
        const h = links(os);
        h.live.open();
        await flush();
        expect(h.reads).toHaveLength(0);
        expect(h.states.at(-1)!.editors).toEqual({ state: "idle" });
        await h.live.setChoice("p1", "zed");
        expect(h.saves).toHaveLength(0);
      }
    });
  });

  describe("failures", () => {
    test("every unanswered list is failed, and carries no text from the failure", async () => {
      const answers: ((c: ReadCall) => void)[] = [
        (c) => c.resolve({ failed: "detection" }),
        (c) => c.resolve({ refused: "stale" }),
        (c) => c.resolve({ refused: "unsupported" }),
        (c) => c.reject(new Error("/Users/x/secret")),
      ];
      for (const answer of answers) {
        const h = links();
        h.live.open();
        answer(h.reads[0]!);
        await flush();
        expect(h.live.state().editors).toEqual({ state: "failed" });
      }
    });

    test("a wrapper that throws at the call is failed too", async () => {
      const states: EditorLinksState[] = [];
      const live = editorLinksLive({ os: "macos", editorList: () => { throw new Error("/Users/x/secret"); }, editorChoiceSet: () => new Promise(() => {}), setGithubLinks: () => Promise.resolve({ ok: true }), publish: (s) => states.push(s) });
      live.open();
      await flush();
      expect(live.state().editors).toEqual({ state: "failed" });
    });

    test("a failed read can be opened again", async () => {
      const h = links();
      h.live.open();
      h.reads[0]!.resolve({ failed: "detection" });
      await flush();
      h.live.open();
      expect(h.live.state().editors).toEqual({ state: "loading" });
      h.reads[1]!.resolve(list());
      await flush();
      expect(h.live.state().editors).toEqual(ready(list()));
    });
  });

  describe("a choice", () => {
    async function opened() {
      const h = links();
      h.live.open();
      h.reads[0]!.resolve(list());
      await flush();
      return h;
    }

    test("a landed save re-reads the inventory exactly once, and draws the saved choice meanwhile", async () => {
      const h = await opened();
      const done = h.live.setChoice("p1", "zed");
      await flush();
      expect(h.saves.map((s) => [s.project, s.choice])).toEqual([["p1", "zed"]]);
      expect(h.reads).toHaveLength(1);
      h.saves[0]!.resolve({ saved: true, revision: 3 });
      await done;
      await flush();
      expect(h.reads).toHaveLength(2);
      expect(h.reads[1]!.args).toEqual([]);
      const view = h.live.state().editors;
      expect(view.state === "ready" && view.projects.map((p) => p.choice)).toEqual(["zed", null]);
      expect(h.live.state().choiceLines.size).toBe(0);
      h.reads[1]!.resolve(list("zed"));
      await flush();
      expect(h.live.state().editors).toEqual(ready(list("zed")));
      expect(h.reads).toHaveLength(2);
    });

    test("a refused or failed save re-reads nothing, changes no row, and shows that code's fixed row on that project only", async () => {
      const cases: [(c: SaveCall) => void, string][] = [
        [(c) => c.resolve({ refused: "stale" }), "This project has changed since this briefing."],
        [(c) => c.resolve({ refused: "unsupported" }), "Opening an editor is only available on macOS."],
        [(c) => c.resolve({ refused: "unknown-editor" }), "Choose a supported editor."],
        [(c) => c.resolve({ refused: "preferences-full" }), "Editor choices could not be saved: preferences are full."],
        [(c) => c.resolve({ failed: "preferences" }), "Could not save editor choice"],
        [(c) => c.reject(new Error("/Users/x/secret")), "Could not save editor choice"],
      ];
      for (const [answer, text] of cases) {
        const h = await opened();
        const before = h.live.state().editors;
        const done = h.live.setChoice("p1", "zed");
        await flush();
        answer(h.saves[0]!);
        await done;
        await flush();
        expect(h.reads).toHaveLength(1);
        expect(h.live.state().editors).toBe(before);
        expect([...h.live.state().choiceLines]).toEqual([["p1", { ok: false, text }]]);
      }
    });

    test("trying again clears that project's line at once, and leaves another project's", async () => {
      const h = await opened();
      const first = h.live.setChoice("p1", "zed");
      await flush();
      h.saves[0]!.resolve({ refused: "preferences-full" });
      await first;
      const other = h.live.setChoice("p2", "zed");
      await flush();
      h.saves[1]!.resolve({ refused: "stale" });
      await other;
      expect(h.live.state().choiceLines.size).toBe(2);
      void h.live.setChoice("p1", "ask");
      expect([...h.live.state().choiceLines.keys()]).toEqual(["p2"]);
    });

    test("saves go one at a time, in call order: two commands sent together could commit in either order", async () => {
      const h = await opened();
      void h.live.setChoice("p1", "zed");
      const last = h.live.setChoice("p1", "cursor");
      await flush();
      expect(h.saves.map((s) => s.choice)).toEqual(["zed"]);
      h.saves[0]!.resolve({ saved: true, revision: 1 });
      await flush();
      expect(h.saves.map((s) => s.choice)).toEqual(["zed", "cursor"]);
      h.saves[1]!.resolve({ saved: true, revision: 2 });
      await last;
    });

    test("a save refused or thrown does not stop the next one in the queue", async () => {
      const h = await opened();
      void h.live.setChoice("p1", "zed");
      const last = h.live.setChoice("p1", "cursor");
      await flush();
      h.saves[0]!.reject(new Error("boom"));
      await flush();
      expect(h.saves).toHaveLength(2);
      h.saves[1]!.resolve({ saved: true, revision: 2 });
      await last;
      expect(h.live.state().choiceLines.size).toBe(0);
    });
  });

  describe("ordering and disposal", () => {
    test("an older reply, late or early, never replaces a newer read", async () => {
      const h = links();
      h.live.open();
      h.live.open();
      h.reads[1]!.resolve(list("zed"));
      await flush();
      h.reads[0]!.resolve(list("cursor"));
      await flush();
      expect(h.live.state().editors).toEqual(ready(list("zed")));
      const quiet = links();
      quiet.live.open();
      quiet.live.open();
      quiet.reads[0]!.resolve(list("cursor"));
      await flush();
      expect(quiet.live.state().editors).toEqual({ state: "loading" });
      quiet.reads[1]!.reject(new Error("x"));
      await flush();
      expect(quiet.live.state().editors).toEqual({ state: "failed" });
    });

    test("a read sent before a save landed cannot restore the old choice", async () => {
      const h = links();
      h.live.open();
      h.reads[0]!.resolve(list());
      await flush();
      h.live.open();
      const done = h.live.setChoice("p1", "zed");
      await flush();
      h.saves[0]!.resolve({ saved: true, revision: 1 });
      await done;
      await flush();
      h.reads[1]!.resolve(list("cursor"));
      await flush();
      const view = h.live.state().editors;
      expect(view.state === "ready" && view.projects[0]!.choice).toBe("zed");
      h.reads[2]!.resolve(list("zed"));
      await flush();
      expect(h.live.state().editors).toEqual(ready(list("zed")));
    });

    test("dispose: a late list or save publishes nothing, a landed save re-reads nothing, and later calls do nothing", async () => {
      const h = links();
      h.live.open();
      const done = h.live.setChoice("p1", "zed");
      await flush();
      h.live.dispose();
      const seen = h.states.length;
      h.reads[0]!.resolve(list());
      h.saves[0]!.resolve({ saved: true, revision: 1 });
      await done;
      await flush();
      h.live.open();
      await h.live.setChoice("p1", "cursor");
      await h.live.setLinks(false);
      expect(h.states).toHaveLength(seen);
      expect(h.reads).toHaveLength(1);
      expect(h.saves).toHaveLength(1);
      expect(h.sets).toEqual([]);
    });

    test("dispose unsubscribes from the store: a later settled value publishes nothing", async () => {
      await withStore(() => stored(true), async () => {
        const h = links();
        h.live.dispose();
        const seen = h.states.length;
        await loadAppPrefs();
        expect(h.states).toHaveLength(seen);
      });
    });

    test("a queued save still goes after dispose: the user made it, only its publish and re-read are dropped", async () => {
      const h = links();
      const first = h.live.setChoice("p1", "zed");
      void h.live.setChoice("p1", "cursor");
      await flush();
      h.live.dispose();
      h.saves[0]!.resolve({ saved: true, revision: 1 });
      await first;
      await flush();
      expect(h.saves.map((s) => s.choice)).toEqual(["zed", "cursor"]);
      expect(h.reads).toHaveLength(0);
    });
  });

  describe("the GitHub links switch", () => {
    test("starts from the store and follows a value that settles later", async () => {
      let answer = stored(false);
      await withStore(() => answer, async () => {
        await loadAppPrefs();
        const h = links();
        expect(h.live.state().githubLinks).toBe(false);
        answer = stored(true);
        await loadAppPrefs();
        expect(h.live.state().githubLinks).toBe(true);
        expect(h.states.at(-1)!.githubLinks).toBe(true);
        h.live.dispose();
      });
    });

    test("a save goes through the setter, publishes busy then the store's settled value, and makes no editor_list call", async () => {
      await withStore((command, args) => {
        if (command === "app_prefs_set") return stored((args as { patch: { githubLinks: boolean } }).patch.githubLinks);
        return stored(true);
      }, async () => {
        await loadAppPrefs();
        const h = links("macos", setGithubLinks);
        const done = h.live.setLinks(false);
        expect(h.live.state().linksBusy).toBe(true);
        await done;
        expect(h.sets).toEqual([false]);
        expect(h.live.state()).toMatchObject({ githubLinks: false, linksBusy: false, linksLine: null });
        expect(appPrefs().githubLinks).toBe(false);
        expect(h.reads).toHaveLength(0);
        h.live.dispose();
      });
    });

    test("the switch works off macOS, and still reads no inventory", async () => {
      await withStore((command) => (command === "app_prefs_set" ? stored(false) : stored(true)), async () => {
        await loadAppPrefs();
        const h = links("linux", setGithubLinks);
        await h.live.setLinks(false);
        expect(h.live.state().githubLinks).toBe(false);
        expect(h.reads).toHaveLength(0);
        h.live.dispose();
      });
    });

    test("a store error shows the fixed sentence and no path, and the value stays (P-M10)", async () => {
      const detail = "could not write /Users/x/Library/Application Support/app-prefs.json";
      await withStore((command) => {
        if (command === "app_prefs_set") throw { kind: "store", detail };
        return stored(true);
      }, async () => {
        await loadAppPrefs();
        const h = links("macos", setGithubLinks);
        await h.live.setLinks(false);
        expect(h.live.state()).toMatchObject({ githubLinks: true, linksBusy: false, linksLine: { ok: false, text: "Could not save the GitHub links setting." } });
        expect(JSON.stringify(h.states)).not.toContain("/Users/x");
        h.live.dispose();
      });
    });

    test("a preferences-full refusal shows that row's sentence", async () => {
      await withStore((command) => {
        if (command === "app_prefs_set") throw { kind: "preferences-full" };
        return stored(true);
      }, async () => {
        await loadAppPrefs();
        const h = links("macos", setGithubLinks);
        await h.live.setLinks(false);
        expect(h.live.state().linksLine).toEqual({ ok: false, text: "This setting could not be saved: preferences are full." });
        h.live.dispose();
      });
    });

    test("no other refusal's words reach the screen, and a setter that throws is the fixed sentence", async () => {
      for (const setter of [
        () => Promise.resolve({ ok: false as const, message: "/Users/x/secret", refused: true }),
        () => Promise.resolve({ ok: false as const, message: "/Users/x/secret", refused: false }),
        // The kind decides, not the words: the same sentence with no `full` is not this refusal.
        () => Promise.resolve({ ok: false as const, message: "This setting could not be saved: preferences are full.", refused: true }),
        () => Promise.reject(new Error("/Users/x/secret")),
      ]) {
        const h = links("macos", setter);
        await h.live.setLinks(false);
        expect(h.live.state().linksLine).toEqual({ ok: false, text: "Could not save the GitHub links setting." });
        expect(h.live.state().linksBusy).toBe(false);
      }
    });

    test("a second click while a save is in flight sends nothing, and a new save clears the old line", async () => {
      let release: (o: AppPrefsSetOutcome) => void = () => {};
      const h = links("macos", () => new Promise((resolve) => (release = resolve)));
      const done = h.live.setLinks(false);
      await h.live.setLinks(true);
      expect(h.sets).toEqual([false]);
      release({ ok: false, message: "x", refused: false });
      await done;
      expect(h.live.state().linksLine).not.toBeNull();
      void h.live.setLinks(false);
      expect(h.live.state().linksLine).toBeNull();
    });
  });
});
