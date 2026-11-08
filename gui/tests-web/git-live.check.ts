/**
 * Briefing redesign wave 2, B1-M5-T16 — the live git check's driver (`src/lib/git-live.ts`): the small state machine
 * Today calls at its four driver points and on the page key (plan §1.2, B1-M5-T16).
 *
 * The invoke is a mock whose promises the test settles, and the clock is injected: nothing here reaches Tauri, a
 * repo, the Keychain or the user's state. The decks are A's real `deckView` over engine-rendered pages.
 */
import { describe, expect, test } from "bun:test";

import { renderBriefing } from "../../src/render";
import type { BriefingStruct as EngineStruct } from "../../src/types";

import { deckView, type DeckView } from "../src/lib/deck";
import type { ReposStatusRequest } from "../src/lib/engine";
import type { ReposAllReply, ReposIpcReply } from "../src/lib/git-detail";
import { ASK_LIMIT_MS, gitLive, type GitLiveState } from "../src/lib/git-live";
import { gitDetailView, launchpadTiles } from "../src/lib/git-detail";
import { todayModel, type LatestLoad } from "../src/lib/today";

const TODAY = "2026-10-16";
const T0 = new Date(2026, 9, 16, 9, 0).getTime();

const page = (s: Partial<EngineStruct> = {}): string =>
  renderBriefing({ date: TODAY, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [], ...s });
const deckOf = (latest: LatestLoad): DeckView =>
  deckView({ model: todayModel({ snapshot: null, latest, lastRun: null, today: TODAY }), today: TODAY, firstName: null });
const loaded = (text: string): DeckView => deckOf({ state: "loaded", file: { path: "/state/briefing-latest.md", text, bytes: text.length } });

const A = loaded(page({ recap: [{ repo: "app", text: "shipped", evidence: "a1b2c3d" }] }));
const B = loaded(page({ recap: [{ repo: "lib", text: "fixed", evidence: "b2c3d4e" }] }));
const LOADING = deckOf({ state: "loading" });

const reply = (o: Partial<ReposAllReply> = {}): ReposIpcReply => ({
  schemaVersion: 1,
  scope: "all",
  checkedAt: new Date(T0).toISOString(),
  record: { accepted: false, windowStartUtc: null },
  windowStartUtc: null,
  repoViews: [],
  labels: [],
  branchLines: [],
  pushCards: [],
  actions: [],
  tile: { commits: 0, branches: 0 },
  hidden: { complete: false, perLabel: {} },
  ...o,
  gate: "ran",
  heldAt: 1,
  uncommittedAt: new Date(T0).toISOString(),
  unknownRepos: [],
});

interface Call {
  request: ReposStatusRequest;
  resolve: (r: ReposIpcReply) => void;
  reject: (e: unknown) => void;
}

function harness() {
  const calls: Call[] = [];
  const states: GitLiveState[] = [];
  let clock = T0;
  /** Each ask's time limit, which the test fires itself (no real timer runs). */
  const timers: { ms: number; fire: () => void; cancelled: boolean }[] = [];
  const live = gitLive({
    invoke: (request) => new Promise<ReposIpcReply>((resolve, reject) => calls.push({ request, resolve, reject })),
    clock: () => clock,
    onchange: (s) => states.push(s),
    timer: (ms, fire) => {
      const t = { ms, fire, cancelled: false };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
  });
  return {
    live,
    calls,
    timers,
    set clock(t: number) {
      clock = t;
    },
    state: (): GitLiveState => live.state(),
    reasons: (): string[] => calls.map((c) => c.request.reason),
  };
}

/** Let the settled promise's handlers run. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

test("removing the last remote clears local-only work without claiming it was pushed", async () => {
  const h = harness();
  const repo = { key: "r1", name: "app", state: "ok" as const, noRemote: false, uncommitted: { count: 0 }, storeKey: "s-r1", treeKey: "t-r1" };
  h.live.onCurrent("launchpad", A);
  h.live.onPageKey("k1", A);
  h.calls[0]!.resolve(reply({ repoViews: [repo], tile: { commits: 2, branches: 1 } }));
  await flush();
  if (A.kind !== "slides") throw new Error("slides fixture");
  const tiles = () => launchpadTiles(gitDetailView(A.page, { ...h.state(), os: "macos" }, TODAY), T0).tiles;
  expect(tiles().find((t) => t.key === "onlyHere")?.state).toBe("wait");
  h.live.onFocus(A);
  h.calls[1]!.resolve(reply({ repoViews: [{ ...repo, noRemote: true }] }));
  await flush();
  expect(tiles().some((t) => t.key === "onlyHere")).toBe(false);
  // Another repo's successful push cannot qualify this no-remote repo for aggregate success either.
  h.live.onFocus(A);
  h.calls[2]!.resolve(reply({ repoViews: [{ ...repo, noRemote: true }, { ...repo, key: "r2" }] }));
  await flush();
  expect(tiles().some((t) => t.label === "✓ Pushed")).toBe(false);
});

test("a failed first full check cannot certify an older held reply", async () => {
  const h = harness();
  h.live.onCurrent("whatYouDid", A);
  h.live.onPageKey("k1", A);
  h.calls[0]!.reject(new Error("failed first full check"));
  await flush();
  h.live.onMinute(A);
  const cached = reply({ tile: { commits: 3, branches: 1 } });
  h.calls[1]!.resolve({ ...cached, gate: "held" });
  await flush();
  expect(h.state().reply).not.toBeNull();
  expect(h.state().fresh).toBe(false);
  expect(h.state().uncommittedFresh).toBe(false);
  h.live.onFocus(A);
  h.calls[2]!.resolve(cached);
  await flush();
  expect(h.state().fresh).toBe(true);
});

for (const statusOnly of [false, true]) test(`after a failed initial check a ran minute refreshes ${statusOnly ? "status only" : "both scopes"}`, async () => {
  const h = harness();
  h.live.onCurrent("launchpad", A);
  h.live.onPageKey("k1", A);
  h.calls[0]!.reject(new Error("failed first full check"));
  await flush();
  h.live.onMinute(A);
  const recovered = reply({ checkedAt: new Date(T0 + 60_000).toISOString() });
  if (recovered.gate === "noResult") throw new Error("full fixture");
  h.calls[1]!.resolve({ ...recovered, checkedAt: statusOnly ? new Date(T0).toISOString() : recovered.checkedAt, uncommittedAt: new Date(T0 + 60_000).toISOString() });
  await flush();
  expect(h.state().fresh).toBe(!statusOnly);
  expect(h.state().uncommittedFresh).toBe(true);
});

for (const statusOnly of [false, true]) test(`a failed full check stays stale after ${statusOnly ? "a status-only run" : "an unchanged held reply"}`, async () => {
  const h = harness();
  const initial = reply({
    tile: { commits: 3, branches: 1 },
    repoViews: [{ key: "r1", name: "app", state: "ok", noRemote: false, uncommitted: { count: 2 }, storeKey: "s-r1", treeKey: "t-r1" }],
  });
  if (initial.gate === "noResult") throw new Error("full fixture");
  h.live.onCurrent("whatYouDid", A);
  h.live.onPageKey("k1", A);
  h.calls[0]!.resolve(initial);
  await flush();
  h.live.onFocus(A);
  h.calls[1]!.reject(new Error("failed full check"));
  await flush();
  if (statusOnly) h.live.onCurrent("launchpad", A);
  h.live.onMinute(A);
  expect(h.calls[2]!.request.reason).toBe("minute"); // the plan's next normal ask, no new retry timer
  h.calls[2]!.resolve({ ...initial, gate: statusOnly ? "ran" : "held", uncommittedAt: statusOnly ? new Date(T0 + 60_000).toISOString() : initial.uncommittedAt });
  await flush();
  expect(h.state().fresh).toBe(false);
  if (A.kind !== "slides") throw new Error("slides fixture");
  const shown = gitDetailView(A.page, { ...h.state(), os: "macos" }, TODAY);
  expect(shown.tiles.find((t) => t.key === "onlyHere")?.asOf).toBe("as of 09:00");
  expect(shown.tiles.find((t) => t.key === "uncommitted:r1")?.asOf).toBe(statusOnly ? null : "as of 09:00");
  h.live.onFocus(A);
  h.calls[3]!.resolve({ ...initial, checkedAt: new Date(T0 + 120_000).toISOString(), uncommittedAt: new Date(T0 + 120_000).toISOString(), heldAt: 121 });
  await flush();
  expect(h.state().fresh).toBe(true);
  expect(gitDetailView(A.page, { ...h.state(), os: "macos" }, TODAY).tiles.every((t) => t.asOf === null)).toBe(true);
});

describe("the asks: which reason, when, and only with a current slide", () => {
  test("not on mount with no page (`latest` loading: the key is null); `first` on the first non-null key with a slides deck", () => {
    const h = harness();
    h.live.onCurrent("goodMorning", LOADING);
    h.live.onPageKey(null, LOADING);
    expect(h.calls).toEqual([]);
    h.live.onPageKey("k1", A);
    expect(h.reasons()).toEqual(["first"]);
    expect(h.calls[0]!.request).toEqual({ labels: [{ key: "app", tokens: ["a1b2c3d"] }], branches: [], pageDate: TODAY, reason: "first", current: "goodMorning" });
  });

  test("both effect orders on mount (the key effect first, or `oncurrent` first) send exactly one `first`", () => {
    const keyFirst = harness();
    keyFirst.live.onPageKey("k1", A);
    expect(keyFirst.calls).toEqual([]); // no current slide yet: owed
    keyFirst.live.onCurrent("goodMorning", A);
    expect(keyFirst.reasons()).toEqual(["first"]);
    const currentFirst = harness();
    currentFirst.live.onCurrent("goodMorning", A);
    currentFirst.live.onPageKey("k1", A);
    expect(currentFirst.reasons()).toEqual(["first"]);
  });

  test("`onPageKey` with a deck that is not the slides (loading) sends nothing; one `first` per key, whatever moves after", async () => {
    const h = harness();
    h.live.onCurrent("goodMorning", A);
    h.live.onPageKey("k1", LOADING);
    expect(h.calls).toEqual([]);
    h.live.onPageKey("k1", A); // the same key again: not a new page
    expect(h.calls).toEqual([]);
    h.live.onCurrent("whatYouDid", A); // owed since the deck was not the slides: sent now
    expect(h.reasons()).toEqual(["first"]);
    h.calls[0]!.resolve(reply());
    await flush();
    h.live.onCurrent("leftOff", A);
    h.live.onPageKey("k1", A);
    expect(h.reasons()).toEqual(["first"]);
  });

  test("a `first` owed while the slides are off (no current slide) is sent when a slide becomes current", () => {
    const h = harness();
    h.live.onCurrent(null, A);
    h.live.onPageKey("k1", A);
    h.live.onFocus(A);
    h.live.onMinute(A);
    expect(h.calls).toEqual([]); // nothing is sent with `current: null`
    h.live.onCurrent("launchpad", A);
    expect(h.reasons()).toEqual(["first"]);
    expect(h.calls[0]!.request.current).toBe("launchpad");
  });

  test("`focus` and `minute` asks carry the current slide", async () => {
    const h = harness();
    h.live.onCurrent("goodMorning", A);
    h.live.onPageKey("k1", A);
    h.calls[0]!.resolve(reply());
    await flush();
    h.live.onCurrent("launchpad", A);
    h.live.onFocus(A);
    h.calls[1]!.resolve(reply());
    await flush();
    h.live.onMinute(A);
    expect(h.calls.slice(1).map((c) => [c.request.reason, c.request.current])).toEqual([
      ["focus", "launchpad"],
      ["minute", "launchpad"],
    ]);
  });
});

describe("one ask outstanding, one queued", () => {
  test("R2-M1: a `first` queued behind an outstanding `minute`, then replaced by a `minute`, is sent as `first` with the latest request", async () => {
    const h = harness();
    h.live.onCurrent("goodMorning", A);
    h.live.onPageKey("k1", A);
    h.calls[0]!.resolve(reply());
    await flush();
    h.live.onMinute(A); // outstanding
    h.live.onPageKey("k2", B); // the new page's `first`, queued
    h.live.onCurrent("suggested", B);
    h.live.onMinute(B); // replaces it, but stays `first`
    expect(h.reasons()).toEqual(["first", "minute"]);
    h.calls[1]!.resolve(reply());
    await flush();
    expect(h.reasons()).toEqual(["first", "minute", "first"]);
    expect(h.calls[2]!.request.labels).toEqual([{ key: "lib", tokens: ["b2c3d4e"] }]);
    expect(h.calls[2]!.request.current).toBe("suggested");
  });

  test("two asks made during one outstanding ask leave only the latest queued, with the stronger reason", async () => {
    const h = harness();
    h.live.onCurrent("goodMorning", A);
    h.live.onPageKey("k1", A);
    h.live.onFocus(A);
    h.live.onMinute(A);
    expect(h.reasons()).toEqual(["first"]);
    h.calls[0]!.resolve(reply());
    await flush();
    expect(h.reasons()).toEqual(["first", "focus"]);
    h.calls[1]!.resolve(reply());
    await flush();
    expect(h.calls.length).toBe(2);
  });

  test("a page change during an outstanding ask: the new key's `first` is queued, sent after the old reply, and the old reply is dropped", async () => {
    const h = harness();
    h.live.onCurrent("goodMorning", A);
    h.live.onPageKey("k1", A);
    h.live.onPageKey("k2", B);
    expect(h.reasons()).toEqual(["first"]);
    h.calls[0]!.resolve(reply({ tile: { commits: 7, branches: 1 } }));
    await flush();
    expect(h.state().reply).toBeNull(); // k1's answer is not k2's
    expect(h.reasons()).toEqual(["first", "first"]);
    expect(h.calls[1]!.request.labels[0]!.key).toBe("lib");
    h.calls[1]!.resolve(reply({ tile: { commits: 2, branches: 1 } }));
    await flush();
    expect(h.state().reply!.reply.tile).toEqual({ commits: 2, branches: 1 });
  });
});

describe("applying the answer", () => {
  test("dispose clears queued asks, ignores late successes and errors, and makes every entry point inert", async () => {
    for (const reject of [false, true]) {
      const h = harness();
      h.live.onCurrent("launchpad", A);
      h.live.onPageKey("k1", A);
      h.live.onFocus(A);
      const before = h.state();
      h.live.dispose();
      h.live.dispose();
      if (reject) h.calls[0]!.reject(new Error("late failure"));
      else h.calls[0]!.resolve(reply({ tile: { commits: 3, branches: 1 } }));
      await flush();
      expect(h.state()).toBe(before);
      expect(h.calls).toHaveLength(1);
      h.live.onPageKey("k2", B);
      h.live.onCurrent("goodMorning", B);
      h.live.onFocus(B);
      h.live.onMinute(B);
      await flush();
      expect(h.state()).toBe(before);
      expect(h.calls).toHaveLength(1);
    }
  });

  test("a page change resets count and green history: the new page's first zero never shows Pushed", async () => {
    for (const alreadyGreen of [false, true]) {
      const h = harness();
      h.live.onCurrent("launchpad", A);
      h.live.onPageKey("k1", A);
      h.calls[0]!.resolve(reply({ tile: { commits: 3, branches: 1 } }));
      await flush();
      if (alreadyGreen) {
        h.live.onMinute(A);
        h.calls[1]!.resolve(reply());
        await flush();
        expect(h.state().greenSince.onlyHere).toBe(T0);
      }
      h.live.onPageKey("k2", B);
      expect(h.state().greenSince).toEqual({});
      h.calls.at(-1)!.resolve(reply());
      await flush();
      expect(h.state().greenSince).toEqual({});
      if (B.kind !== "slides") throw new Error("expected slides");
      expect(launchpadTiles(gitDetailView(B.page, { ...h.state(), os: "macos" }, TODAY), T0).tiles).toEqual([]);
    }
  });

  test("R2-M11: an invoke that rejects keeps the previous reply with `fresh: false`; the next success sets `fresh: true`", async () => {
    const h = harness();
    h.live.onCurrent("goodMorning", A);
    h.live.onPageKey("k1", A);
    h.calls[0]!.resolve(reply({ tile: { commits: 3, branches: 1 } }));
    await flush();
    expect(h.state().fresh).toBe(true);
    h.live.onFocus(A);
    h.calls[1]!.reject(new Error("the live git check could not be completed"));
    await flush();
    expect(h.state().fresh).toBe(false);
    expect(h.state().reply!.reply.tile).toEqual({ commits: 3, branches: 1 });
    h.live.onMinute(A); // the next ask proceeds normally
    h.calls[2]!.resolve(reply({ checkedAt: new Date(T0 + 60_000).toISOString(), tile: { commits: 4, branches: 1 } }));
    await flush();
    expect(h.state().fresh).toBe(true);
    expect(h.state().reply!.reply.tile).toEqual({ commits: 4, branches: 1 });
  });

  test("final5 L2: an ask still outstanding after 37 s fails (`fresh: false`), frees the slot, and its late answer is dropped", async () => {
    const h = harness();
    h.live.onCurrent("goodMorning", A);
    h.live.onPageKey("k1", A);
    h.calls[0]!.resolve(reply({ tile: { commits: 3, branches: 1 } }));
    await flush();
    expect(h.timers[0]!.cancelled).toBe(true); // an answered ask's limit is cleared
    h.live.onFocus(A);
    h.live.onMinute(A); // queued behind the outstanding focus
    expect(h.calls).toHaveLength(2);
    expect(h.timers[1]!.ms).toBe(ASK_LIMIT_MS);
    expect(ASK_LIMIT_MS).toBeGreaterThanOrEqual(37_000); // Rust's worst case: 1 s B2 sample + 5 s stat + 30 s engine + 1 s acceptance
    expect(ASK_LIMIT_MS).toBeLessThanOrEqual(40_000);
    expect(h.state().fresh).toBe(true);
    h.timers[1]!.fire();
    await flush();
    expect(h.state().fresh).toBe(false);
    expect(h.state().uncommittedFresh).toBe(false);
    expect(h.state().reply!.reply.tile).toEqual({ commits: 3, branches: 1 });
    expect(h.reasons()).toEqual(["first", "focus", "minute"]); // the queued ask went out
    h.calls[1]!.resolve(reply({ checkedAt: new Date(T0 + 60_000).toISOString(), tile: { commits: 9, branches: 2 } }));
    await flush();
    expect(h.state().fresh).toBe(false); // the late answer is not applied
    expect(h.state().reply!.reply.tile).toEqual({ commits: 3, branches: 1 });
  });

  test("with no previous reply a failure leaves nothing held (A's disclosure stays)", async () => {
    const h = harness();
    h.live.onCurrent("goodMorning", A);
    h.live.onPageKey("k1", A);
    h.calls[0]!.reject(new Error("timed out"));
    await flush();
    expect(h.state().reply).toBeNull();
  });

  test("a reply is applied through `mergeReply` (a repo unknown keeps its last answer, not current)", async () => {
    const h = harness();
    h.live.onCurrent("goodMorning", A);
    h.live.onPageKey("k1", A);
    const view = { key: "r1", name: "app", state: "ok", noRemote: false, uncommitted: { count: 2 }, storeKey: "s-r1", treeKey: "t-r1" } as const;
    h.calls[0]!.resolve(reply({ repoViews: [view] }));
    await flush();
    h.live.onFocus(A);
    h.calls[1]!.resolve(reply({ checkedAt: new Date(T0 + 600_000).toISOString(), repoViews: [{ key: "r1", name: "app", state: "unknown", reason: "timeout", noRemote: false, uncommitted: { unknown: true }, storeKey: "s-r1", treeKey: "t-r1" }] }));
    await flush();
    expect(h.state().reply!.reply.repoViews).toEqual([view]);
    expect(h.state().reply!.asOf.repos).toEqual({ r1: new Date(T0).toISOString() });
  });
});

describe("`greenSince`: set at the first reply that brings a count to zero, on the clock when the reply is applied", () => {
  const dirty = (n: number) => ({ key: "r1", name: "app", state: "ok" as const, noRemote: false, uncommitted: { count: n }, storeKey: "s-r1", treeKey: "t-r1" });

  test("R4-M4: a reply landing 40 s after the last tick stamps the clock at that moment, not the tick's; a rise clears it", async () => {
    const h = harness();
    h.live.onCurrent("launchpad", A);
    h.live.onPageKey("k1", A);
    h.calls[0]!.resolve(reply({ tile: { commits: 3, branches: 1 }, repoViews: [dirty(2)] }));
    await flush();
    expect(h.state().greenSince).toEqual({});
    h.clock = T0 + 60_000;
    h.live.onMinute(A); // the tick
    h.clock = T0 + 100_000; // the reply lands 40 s later
    h.calls[1]!.resolve(reply({ tile: { commits: 0, branches: 0 }, repoViews: [dirty(0)] }));
    await flush();
    expect(h.state().greenSince).toEqual({ onlyHere: T0 + 100_000, "uncommitted:r1": T0 + 100_000 });
    // Still zero: the stamp stays where it was.
    h.clock = T0 + 160_000;
    h.live.onMinute(A);
    h.calls[2]!.resolve(reply({ tile: { commits: 0, branches: 0 }, repoViews: [dirty(0)] }));
    await flush();
    expect(h.state().greenSince).toEqual({ onlyHere: T0 + 100_000, "uncommitted:r1": T0 + 100_000 });
    // A count that rises again clears its stamp.
    h.live.onMinute(A);
    h.calls[3]!.resolve(reply({ tile: { commits: 0, branches: 0 }, repoViews: [dirty(1)] }));
    await flush();
    expect(h.state().greenSince).toEqual({ onlyHere: T0 + 100_000 });
  });

  test("a count that is zero at the first answer (it was never amber) is not green", async () => {
    const h = harness();
    h.live.onCurrent("launchpad", A);
    h.live.onPageKey("k1", A);
    h.calls[0]!.resolve(reply({ repoViews: [dirty(0)] }));
    await flush();
    expect(h.state().greenSince).toEqual({});
  });

  test("Today hears every change of state (`onchange`), and the held state is a new object each time", async () => {
    const states: GitLiveState[] = [];
    const calls: Call[] = [];
    const live = gitLive({
      invoke: (request) => new Promise<ReposIpcReply>((resolve, reject) => calls.push({ request, resolve, reject })),
      clock: () => T0,
      onchange: (s) => states.push(s),
    });
    live.onCurrent("goodMorning", A);
    live.onPageKey("k1", A);
    calls[0]!.resolve(reply());
    await flush();
    expect(states.length).toBeGreaterThan(0);
    expect(states.at(-1)).toBe(live.state());
    expect(states.at(-1)!.reply).not.toBeNull();
  });
});
