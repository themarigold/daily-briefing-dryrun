import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute } from "node:path";
import { render } from "svelte/server";
import { deckView, type SummaryInput } from "../src/lib/deck";
import DeckOrClassic from "../src/lib/deck/DeckOrClassic.svelte";
import { briefingHash } from "../src/lib/deck-state";
import type { BriefingFile } from "../src/lib/files";
import type { SummaryReply } from "../src/lib/engine";
import type { Snapshot } from "../src/lib/state";
import { summaryRevisionOf, summaryStatusOf, summaryStatusFromStatus, todayModel } from "../src/lib/today";
import { summaryStatusDriver, type KeptSummary, type SummaryKept, type SummaryStatusState } from "../src/lib/summary-status";
import { summaryReader } from "../src/lib/summary-reader";

const DATE = "2026-01-11";
const ID = { pageHash: "a".repeat(64), pageVersion: "b".repeat(64) };
const NEXT = { pageHash: ID.pageHash, pageVersion: "c".repeat(64) };
const POINT = "Harvest view storage handoff is ready.";
const SENTENCE = "The orchard handoff is ready for the next pass.";
const PAGE = `☀️  Daily briefing — ${DATE}  (this machine: fixture)
▶ Where you left off
   • [Orchard] Finish the harvest view
▶ What you did
   • [Orchard] Added the fallback point
▶ Suggested next
   • [Orchard] Check the harvest view
`;
const file = (id = ID, text = PAGE): BriefingFile => ({ path: "/fixture/briefing-latest.md", text, bytes: Buffer.byteLength(text), ...id });
const ready = (id = ID): SummaryReply => ({ state: "ready", ...id, revision: 1,
  projects: [{ key: "project:orchard", points: [POINT] }], goodMorningSentence: SENTENCE, warnings: [] });
const snapshot = (enabled = true, revision = 1, id = ID, mtime = "unchanged"): Snapshot => ({
  status: { latestBriefingMtime: mtime, aiSummaryStatus: { enabled, warnings: [] },
    latestSummaryRevision: { ...id, revision, state: revision === 0 ? "pending" : "ready" } },
  lastSkip: null, schedule: null, scheduleStale: false, scheduleState: null, error: null, updatesStopped: false,
});
/** What the watcher emits each minute before the morning time: only `minutesUntilFloor` moved (`schedule_state.rs`). */
const countdown = (minutes: number, base = snapshot()): Snapshot =>
  ({ ...base, scheduleState: { minutesUntilFloor: minutes } as unknown as Snapshot["scheduleState"] });
const failedSnapshot = (error: string | null = "fixture status failure"): Snapshot =>
  ({ status: null, lastSkip: null, schedule: null, scheduleStale: false, scheduleState: null, error, updatesStopped: false });
const state = (enabled = true, revision = 1, id = ID): SummaryStatusState => ({ known: true,
  status: summaryStatusOf(snapshot(enabled, revision, id)), revision: summaryRevisionOf(snapshot(enabled, revision, id)) });
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const settle = async () => { for (let n = 0; n < 12; n++) await Promise.resolve(); };
function view(summary: SummaryInput | null, page = file(), today = DATE) {
  const model = todayModel({ snapshot: null, latest: { state: "loaded", file: page }, lastRun: null, today });
  return { model, deck: deckView({ model, today, firstName: null, summary }) };
}
function html(summary: SummaryInput | null, page = file(), today = DATE) {
  const { model, deck } = view(summary, page, today);
  return render(DeckOrClassic, { props: { model, deck, now: new Date(2026, 0, 11, 8).getTime(),
    briefingKey: briefingHash(page.text), slides: true, running: false, progress: [], runResult: "", detailsOpen: false,
    onrun: () => {}, onhistory: () => {} } }).body.replace(/<!--[\s\S]*?-->/g, "");
}
const input = (id = ID): SummaryInput => ({ ...id, projects: [{ key: "project:orchard", points: [POINT] }], goodMorningSentence: SENTENCE });

/** `delivery: "microtask"` is production's order: App's state reaches Today's reader through Today's `$effect`, later. */
function harness(options: { delivery?: "sync" | "microtask"; page?: BriefingFile } = {}) {
  let shown: SummaryInput | null = null;
  let calls = 0;
  let refreshes = 0;
  const reads: ReturnType<typeof deferred<SummaryReply>>[] = [];
  const snapshots: ReturnType<typeof deferred<Snapshot>>[] = [];
  const errors: unknown[] = [];
  let recoveries = 0;
  const shownLog: (SummaryInput | null)[] = [];
  const publications: SummaryStatusState[] = [];
  const driver = summaryStatusDriver({ readSnapshot: () => { const d = deferred<Snapshot>(); snapshots.push(d); return d.promise; },
    publish: (s) => {
      publications.push(s);
      if (options.delivery === "microtask") queueMicrotask(() => reader.onSnapshot(s)); else reader.onSnapshot(s);
    }, onerror: (e) => { errors.push(e); }, onrecovered: () => { recoveries++; } });
  const newReader = () => summaryReader({ readLatestSummary: () => { calls++; const d = deferred<SummaryReply>(); reads.push(d); return d.promise; },
    refreshStatus: () => { refreshes++; return driver.refresh(); }, kept: driver.kept, publish: (s) => { shown = s; shownLog.push(s); } });
  let reader = newReader();
  reader.onPage(options.page ?? file());
  /** Today unmounts: its reader goes, App's driver stays. */
  const leave = () => { reader.dispose(); };
  /** Today mounts again, in production's order: its page and App's held state reach the new reader, then onMount. The new
   *  Today's own text starts empty, and the log starts again, so what follows is this mount's alone. */
  const back = (page = file()) => {
    reader = newReader(); shown = null; shownLog.length = 0;
    reader.onPage(page);
    reader.onSnapshot(publications.at(-1) ?? { known: false, status: { enabled: false, warnings: [] }, revision: null });
    reader.onMount();
  };
  return { driver, get reader() { return reader; }, leave, back, reads, snapshots, errors, publications, shownLog, shown: () => shown, calls: () => calls, refreshes: () => refreshes, recoveries: () => recoveries };
}
async function mounted(h: ReturnType<typeof harness>) {
  h.reader.onMount(); h.snapshots[0]!.resolve(snapshot()); await settle();
  h.reads[0]!.resolve(ready()); await settle();
  expect(h.shown()).toEqual(input());
}
/** A reader with no App behind it: a holder of its own. */
function ownKept(): SummaryKept {
  let held: KeptSummary | null = null;
  return { read: () => held, write: (next) => { held = next; } };
}

describe("summary status envelope", () => {
  test("reads the raw engine envelope and fails closed on malformed values", () => {
    expect(summaryStatusOf(snapshot())).toEqual({ enabled: true, warnings: [] });
    expect(summaryRevisionOf(snapshot())).toEqual({ ...ID, revision: 1, state: "ready" });
    for (const raw of [null, [], {}, { aiSummaryStatus: { enabled: "true", warnings: [] } },
      { aiSummaryStatus: { enabled: true, warnings: null } }]) {
      expect(summaryStatusFromStatus(raw)).toEqual({ enabled: false, warnings: [] });
    }
    for (const latestSummaryRevision of [{ ...ID, revision: -1, state: "ready" }, { ...ID, revision: 1, state: "raw" },
      { ...ID, pageHash: "/a/path", revision: 1, state: "ready" }]) {
      expect(summaryRevisionOf({ ...snapshot(), status: { latestSummaryRevision } })).toBeNull();
    }
    expect(summaryStatusFromStatus({ aiSummaryStatus: { enabled: false, warnings: ["summary-config-invalid"] } }))
      .toEqual({ enabled: false, warnings: ["summary-config-invalid"] });
  });
});

describe("summary status ordering and payload reader", () => {
  test("mount/page/revision/focus coalesce, and unknown hides without erasing the accepted cache", async () => {
    const h = harness();
    h.reader.onMount(); h.reader.onFocus(); h.reader.onPage(file());
    h.snapshots[0]!.resolve(snapshot()); h.snapshots[1]!.resolve(snapshot()); await settle();
    expect(h.calls()).toBe(1);
    h.reads[0]!.resolve(ready()); await settle();
    expect(html(h.shown())).toContain(SENTENCE);
    const fresh = h.driver.refresh();
    h.snapshots[2]!.resolve(snapshot()); await fresh; await settle();
    expect(h.calls()).toBe(1); expect(h.shown()).toEqual(input());
    h.reader.onSnapshot(state()); await settle();
    expect(h.calls()).toBe(1); expect(h.refreshes()).toBe(2);
    h.reader.onSnapshot({ ...state(), known: false }); expect(h.shown()).toBeNull();
    h.reader.onSnapshot(state()); await settle();
    expect(h.calls()).toBe(1); expect(h.shown()).toEqual(input());
    h.reader.onFocus();
    h.snapshots[3]!.resolve(snapshot()); await settle();
    expect(h.calls()).toBe(2);
  });

  test("a focus keeps a ready summary shown through both reads, and updates it in place", async () => {
    const h = harness(); await mounted(h);
    const shownBefore = h.shownLog.length, publishedBefore = h.publications.length;
    h.reader.onFocus();
    // The status read is out: nothing is published, and the text stays.
    expect(h.publications).toHaveLength(publishedBefore); expect(h.shown()).toEqual(input());
    await settle(); expect(h.publications).toHaveLength(publishedBefore); expect(h.shown()).toEqual(input());
    h.snapshots[1]!.resolve(snapshot()); await settle();
    // The status answered and the payload read is out: still shown.
    expect(h.publications.at(-1)).toEqual(state()); expect(h.calls()).toBe(2); expect(h.shown()).toEqual(input());
    h.reads[1]!.resolve({ ...ready(), goodMorningSentence: "A newer sentence." }); await settle();
    expect(h.shown()).toEqual({ ...input(), goodMorningSentence: "A newer sentence." });
    // Not once in all of that did the reader publish an empty summary.
    expect(h.shownLog.slice(shownBefore)).not.toContain(null);
    expect(h.publications.slice(publishedBefore).filter((p) => !p.known)).toEqual([]);
  });

  test("a watcher-triggered read keeps the text the same way", async () => {
    const h = harness(); await mounted(h);
    const shownBefore = h.shownLog.length;
    const touched = snapshot(true, 1, ID, "touched");
    h.driver.onWatcher(touched); await settle();
    expect(h.snapshots).toHaveLength(2); expect(h.shown()).toEqual(input());
    h.snapshots[1]!.resolve(touched); await settle();
    expect(h.shownLog.slice(shownBefore)).not.toContain(null);
  });

  test("a focus read that fails keeps the last state and the text", async () => {
    const h = harness(); await mounted(h);
    const publishedBefore = h.publications.length;
    h.reader.onFocus(); h.snapshots[1]!.reject(new Error("fixture")); await settle();
    expect(h.publications).toHaveLength(publishedBefore); expect(h.errors).toHaveLength(1); expect(h.shown()).toEqual(input());
    h.reader.onFocus(); h.snapshots[2]!.resolve(failedSnapshot()); await settle();
    expect(h.publications).toHaveLength(publishedBefore); expect(h.shown()).toEqual(input());
  });

  test("a focus right after a save stays hidden until its own read answers", async () => {
    const h = harness(); await mounted(h);
    const save = h.driver.saved();
    expect(h.shown()).toBeNull();
    h.reader.onFocus(); await settle(); expect(h.shown()).toBeNull();
    let saveSettled = false; void save.then(() => { saveSettled = true; });
    h.snapshots[1]!.resolve(snapshot()); await settle();                     // the save's read, now superseded
    expect(h.publications.at(-1)?.known).toBe(false); expect(h.shown()).toBeNull(); expect(h.calls()).toBe(1);
    expect(saveSettled).toBe(false);                                         // it settles with the newest read, not with its own
    h.snapshots[2]!.resolve(snapshot(false)); await settle();
    expect(saveSettled).toBe(true);
    expect(h.publications.at(-1)).toEqual(state(false)); expect(h.shown()).toBeNull(); expect(h.calls()).toBe(1);
  });

  test("a late focus reply after a save cannot restore the text, even when it says on", async () => {
    const h = harness(); await mounted(h);
    h.reader.onFocus();
    const save = h.driver.saved();
    expect(h.publications.at(-1)?.known).toBe(false); expect(h.shown()).toBeNull();
    h.snapshots[1]!.resolve(snapshot()); await settle();
    expect(h.publications.at(-1)?.known).toBe(false); expect(h.shown()).toBeNull(); expect(h.calls()).toBe(1);
    h.snapshots[2]!.resolve(snapshot(false)); await save; await settle();
    expect(h.publications.at(-1)).toEqual(state(false)); expect(h.shown()).toBeNull();
  });

  test("sidecar ready revision with unchanged page mtime reads once and renders new points", async () => {
    const h = harness(); h.reader.onMount();
    h.snapshots[0]!.resolve(snapshot(true, 0)); await settle();
    h.reads[0]!.resolve({ state: "pending", warnings: [] }); await settle();
    expect(h.shown()).toBeNull();
    const refresh = h.driver.refresh(); h.snapshots[1]!.resolve(snapshot()); await refresh; await settle();
    expect(h.calls()).toBe(2); h.reads[1]!.resolve(ready()); await settle();
    const rendered = html(h.shown());
    expect(rendered).toContain(POINT); expect(rendered).toContain(SENTENCE);
    expect(rendered).not.toContain("Added the fallback point");
  });

  test("saved synchronously invalidates, off hides, and an older enabled read cannot restore text", async () => {
    const h = harness(); await mounted(h);
    const older = h.driver.refresh();
    const saved = h.driver.saved();
    expect(h.publications.at(-1)?.known).toBe(false); expect(h.shown()).toBeNull();
    h.snapshots[2]!.resolve(snapshot(false)); await saved;
    h.snapshots[1]!.resolve(snapshot()); await older; await settle();
    expect(h.publications.at(-1)).toEqual(state(false)); expect(h.shown()).toBeNull();
    expect(html(h.shown())).not.toContain(SENTENCE);
    h.reader.onFocus(); h.snapshots[3]!.resolve(snapshot(false)); await settle();
    expect(h.calls()).toBe(1);
    const on = h.driver.refresh(); h.snapshots[4]!.resolve(snapshot()); await on; await settle();
    expect(h.calls()).toBe(2);
  });

  test("external off edit is learned on focus without watcher or minute work", async () => {
    const h = harness(); await mounted(h);
    h.reader.onSnapshot(state()); await settle(); expect(h.refreshes()).toBe(1); expect(h.calls()).toBe(1);
    // Config is not watched, so the watcher's held state keeps saying on: it can never carry this edit.
    h.driver.onWatcher(countdown(40)); await settle();
    expect(h.snapshots).toHaveLength(1); expect(h.shown()).toEqual(input());
    h.reader.onFocus(); await settle();
    expect(h.shown()).toEqual(input());                                      // until that read answers
    h.snapshots[1]!.resolve(snapshot(false)); await settle();
    expect(h.shown()).toBeNull(); expect(h.calls()).toBe(1);
    const count = h.publications.length;
    h.driver.onWatcher(countdown(39)); await settle();
    expect(h.snapshots).toHaveLength(2); expect(h.publications).toHaveLength(count); expect(h.shown()).toBeNull();
  });

  test("failed save refresh resolves without rejecting and independent App instances and dispose stay ordered", async () => {
    const h = harness(); const other = harness(); await mounted(h); await mounted(other);
    const save = h.driver.saved(); h.snapshots[1]!.reject(new Error("fixture"));
    await expect(save).resolves.toBeUndefined(); expect(h.shown()).toBeNull(); expect(h.errors).toHaveLength(1);
    expect(other.shown()).toEqual(input());
    const late = other.driver.refresh(); other.driver.dispose(); other.reader.dispose();
    const count = other.publications.length; other.snapshots[1]!.resolve(snapshot()); await late;
    expect(other.publications).toHaveLength(count);
  });

  test("unknown focus never reads; mismatched status and ready identities fail closed", async () => {
    const h = harness(); h.reader.onSnapshot({ ...state(), known: false }); await settle(); expect(h.calls()).toBe(0);
    h.reader.onMount(); h.reader.onFocus(); h.snapshots[0]!.resolve(snapshot(true, 1, NEXT)); h.snapshots[1]!.resolve(snapshot(true, 1, NEXT)); await settle(); expect(h.calls()).toBe(0);
    h.reader.onSnapshot(state()); await settle(); expect(h.calls()).toBe(1);
    h.reads[0]!.resolve(ready(NEXT)); await settle(); expect(h.shown()).toBeNull();
  });

  test.each(["pending", "unavailable", "ready"] as const)("late %s reply for the old requested identity cannot clear the new ready page", async (kind) => {
    const h = harness(); h.reader.onMount(); h.snapshots[0]!.resolve(snapshot()); await settle();
    h.reader.onPage(file(NEXT)); h.reader.onSnapshot(state(true, 1, NEXT)); await settle();
    h.reads[1]!.resolve(ready(NEXT)); await settle(); expect(h.shown()).toEqual(input(NEXT));
    h.reads[0]!.resolve(kind === "ready" ? ready() : { state: kind, warnings: [] }); await settle();
    expect(h.shown()).toEqual(input(NEXT));
  });

  test("late same-identity revision, off-state and disposed replies never publish", async () => {
    const h = harness(); h.reader.onMount(); h.snapshots[0]!.resolve(snapshot(true, 0)); await settle();
    h.reader.onSnapshot(state()); await settle();
    h.reads[1]!.resolve(ready()); await settle();
    h.reads[0]!.resolve({ state: "pending", warnings: [] }); await settle(); expect(h.shown()).toEqual(input());
    // Through the driver, the only source of these states: an off that App never heard would leave its holder full.
    const off = h.driver.refresh(); h.snapshots[1]!.resolve(snapshot(false)); await off; await settle(); expect(h.shown()).toBeNull();
    const on = h.driver.refresh(); h.snapshots[2]!.resolve(snapshot()); await on; await settle(); expect(h.calls()).toBe(3); h.reader.dispose();
    h.reads[2]!.resolve(ready()); await settle(); expect(h.shown()).toBeNull();
  });

  test("payload read failure is ordinary fallback and a later focus can retry", async () => {
    const h = harness(); h.reader.onMount(); h.snapshots[0]!.resolve(snapshot()); await settle();
    h.reads[0]!.reject(new Error("fixture")); await settle(); expect(h.shown()).toBeNull();
    h.reader.onFocus(); h.snapshots[1]!.resolve(snapshot()); await settle(); expect(h.calls()).toBe(2);
  });

  test("a thrown read keeps the accepted payload; a real non-ready answer replaces it", async () => {
    const h = harness(); await mounted(h);
    h.reader.onFocus(); h.snapshots[1]!.resolve(snapshot()); await settle();
    expect(h.calls()).toBe(2); expect(h.shown()).toEqual(input());
    h.reads[1]!.reject(new Error("fixture")); await settle();
    expect(h.shown()).toEqual(input());
    h.reader.onSnapshot({ ...state(), known: false }); expect(h.shown()).toBeNull();
    h.reader.onSnapshot(state()); await settle();
    expect(h.calls()).toBe(2); expect(h.shown()).toEqual(input());
    h.reader.onFocus(); h.snapshots[2]!.resolve(snapshot()); await settle();
    h.reads[2]!.resolve({ state: "unavailable", warnings: [] }); await settle();
    expect(h.shown()).toBeNull();
    h.reader.onSnapshot({ ...state(), known: false }); h.reader.onSnapshot(state()); await settle();
    expect(h.calls()).toBe(3); expect(h.shown()).toBeNull();
  });

  test("a late reply at the same key from a superseded read is dropped and the summary stays", async () => {
    const h = harness(); h.reader.onMount(); h.snapshots[0]!.resolve(snapshot()); await settle();
    expect(h.calls()).toBe(1);
    h.reader.onSnapshot({ ...state(), known: false }); h.reader.onSnapshot(state()); await settle();
    expect(h.calls()).toBe(2);
    h.reads[1]!.resolve(ready()); await settle(); expect(h.shown()).toEqual(input());
    h.reads[0]!.resolve({ state: "unavailable", warnings: [] }); await settle();
    expect(h.shown()).toEqual(input());
  });

  test.each([
    ["pending, replying a later revision", { ...ID, revision: 0, state: "pending" }, 1],
    ["pending, replying the same revision", { ...ID, revision: 0, state: "pending" }, 0],
    ["unavailable, replying the same revision", { ...ID, revision: 1, state: "unavailable" }, 1],
    ["ready, replying another revision", { ...ID, revision: 1, state: "ready" }, 2],
  ] as const)("a ready reply while status says %s publishes nothing", async (_name, revision, replied) => {
    let shown: SummaryInput | null = null;
    let calls = 0;
    const reader = summaryReader({ readLatestSummary: async () => { calls++; return { ...ready(), revision: replied }; },
      refreshStatus: async () => true, kept: ownKept(), publish: (s) => { shown = s; } });
    reader.onPage(file()); reader.onSnapshot({ known: true, status: { enabled: true, warnings: [] }, revision: { ...revision } });
    reader.onMount(); await settle();
    expect(calls).toBe(1); expect(shown).toBeNull();
  });
  test("the same ready reply is published when status agrees", async () => {
    let shown: SummaryInput | null = null;
    const reader = summaryReader({ readLatestSummary: async () => ready(), refreshStatus: async () => true, kept: ownKept(), publish: (s) => { shown = s; } });
    reader.onPage(file()); reader.onSnapshot(state()); reader.onMount(); await settle();
    expect(shown).toEqual(input());
  });

  test.each([
    ["no identity", { path: "/fixture/briefing-latest.md", text: PAGE, bytes: Buffer.byteLength(PAGE) }],
    ["half an identity", { path: "/fixture/briefing-latest.md", text: PAGE, bytes: Buffer.byteLength(PAGE), pageHash: ID.pageHash }],
  ] as [string, BriefingFile][])("a file with %s (an older engine, Windows) makes no read and shows the fallback", async (_name, page) => {
    // Such a page has no revision in status either, so only the page's own missing identity can stop the read.
    const noRevision: Snapshot = { ...snapshot(), status: { latestBriefingMtime: "unchanged", aiSummaryStatus: { enabled: true, warnings: [] } } };
    const h = harness({ page }); h.reader.onMount(); h.snapshots[0]!.resolve(noRevision); await settle();
    expect(h.publications.at(-1)).toEqual({ known: true, status: { enabled: true, warnings: [] }, revision: null });
    expect(h.calls()).toBe(0); expect(h.shown()).toBeNull();
    const rendered = html(h.shown(), page);
    expect(rendered).toContain("Added the fallback point"); expect(rendered).not.toContain(POINT);
    // Even a payload in hand cannot bind to a page with no identity.
    const handed = html(input(), page);
    expect(handed).toContain("Added the fallback point"); expect(handed).not.toContain(SENTENCE);
  });
  test("a loaded page losing its identity hides the summary it had", async () => {
    const h = harness(); await mounted(h);
    h.reader.onPage({ path: "/fixture/briefing-latest.md", text: PAGE, bytes: Buffer.byteLength(PAGE) }); await settle();
    expect(h.shown()).toBeNull(); expect(h.calls()).toBe(1);
  });

  test("delivered a microtask later, a publication cannot start a read before the ordered snapshot answers", async () => {
    const h = harness({ delivery: "microtask" });
    // App already holds a known status when Today mounts, so the old one is what a queued read would see.
    h.reader.onSnapshot(state()); h.reader.onMount(); await settle();
    expect(h.refreshes()).toBe(1); expect(h.calls()).toBe(0);
    h.snapshots[0]!.resolve(snapshot()); await settle();
    expect(h.calls()).toBe(1);
    h.reads[0]!.resolve(ready()); await settle(); expect(h.shown()).toEqual(input());
    // The same order on focus: its re-read waits for the ordered answer, and is not spent early.
    h.reader.onSnapshot(state()); h.reader.onFocus(); await settle();
    expect(h.calls()).toBe(1);
    h.snapshots[1]!.resolve(snapshot()); await settle();
    expect(h.calls()).toBe(2);
    h.reads[1]!.resolve(ready()); await settle(); expect(h.shown()).toEqual(input());
  });

  test("a superseded status read does not end the mount's wait: no payload is read until the newest read answers", async () => {
    const h = harness({ delivery: "microtask" });
    h.reader.onSnapshot(state()); h.reader.onMount(); await settle();        // a stale known-on, and the mount's read out
    h.driver.onWatcher(snapshot(false)); await settle();                     // App's own read takes over
    expect(h.snapshots).toHaveLength(2);
    h.snapshots[0]!.resolve(snapshot()); await settle();                     // the mount's read answers first, and is dropped
    expect(h.calls()).toBe(0); expect(h.shown()).toBeNull();
    h.snapshots[1]!.resolve(snapshot(false)); await settle();                // off: the stale on never read a payload
    expect(h.publications.at(-1)).toEqual(state(false));
    expect(h.calls()).toBe(0); expect(h.shown()).toBeNull();
  });

  test("the mount's wait ends with the newest read when that read says on", async () => {
    const h = harness({ delivery: "microtask" });
    h.reader.onSnapshot(state()); h.reader.onMount(); await settle();
    const newer = h.driver.refresh();
    h.snapshots[0]!.resolve(snapshot()); await settle();
    expect(h.calls()).toBe(0);
    h.snapshots[1]!.resolve(snapshot()); await newer; await settle();
    expect(h.calls()).toBe(1);
    h.reads[0]!.resolve(ready()); await settle(); expect(h.shown()).toEqual(input());
  });

  test.each(["answers", "rejects"] as const)("a focus read superseded by App's own, whose reply %s, re-reads no payload until the newest answers", async (reply) => {
    const h = harness({ delivery: "microtask" }); await mounted(h);
    h.reader.onFocus(); await settle();
    const newer = h.driver.refresh();
    if (reply === "answers") h.snapshots[1]!.resolve(snapshot()); else h.snapshots[1]!.reject(new Error("fixture"));
    await settle();
    expect(h.calls()).toBe(1); expect(h.errors).toEqual([]);                 // a dropped reply reports nothing, either way
    h.snapshots[2]!.resolve(snapshot()); await newer; await settle();
    expect(h.calls()).toBe(2);
  });

  describe.each(["rejected", "status null"] as const)("a mount whose status read fails (%s), with nothing kept, shows no text on a stale known-on", (kind) => {
    const fail = (h: ReturnType<typeof harness>, n: number) => {
      if (kind === "rejected") h.snapshots[n]!.reject(new Error("fixture")); else h.snapshots[n]!.resolve(failedSnapshot());
    };
    test("no payload is read, and a focus's good read then reads it", async () => {
      const h = harness({ delivery: "microtask" });
      h.reader.onSnapshot(state()); h.reader.onMount(); await settle();
      fail(h, 0); await settle();
      expect(h.errors).toHaveLength(1); expect(h.calls()).toBe(0); expect(h.shown()).toBeNull();
      h.reader.onFocus(); await settle();
      fail(h, 1); await settle();
      expect(h.calls()).toBe(0);                                             // a second failure changes nothing
      h.reader.onFocus(); await settle();
      h.snapshots[2]!.resolve(snapshot()); await settle();
      expect(h.calls()).toBe(1);
      h.reads[0]!.resolve(ready()); await settle(); expect(h.shown()).toEqual(input());
    });
    test("App's old state delivered again while the read is out is no answer", async () => {
      const h = harness({ delivery: "microtask" });
      h.reader.onSnapshot(state()); h.reader.onMount(); await settle();
      h.reader.onSnapshot(state());
      fail(h, 0); await settle();
      expect(h.calls()).toBe(0); expect(h.shown()).toBeNull();
    });
    test("App's own later good read ends the wait too", async () => {
      const h = harness({ delivery: "microtask" });
      h.reader.onSnapshot(state()); h.reader.onMount(); await settle();
      fail(h, 0); await settle();
      expect(h.calls()).toBe(0);
      const later = h.driver.refresh(); h.snapshots[1]!.resolve(snapshot()); await later; await settle();
      expect(h.calls()).toBe(1);
    });
    test("the newest read failing, after a superseded one, leaves the wait unanswered", async () => {
      const h = harness({ delivery: "microtask" });
      h.reader.onSnapshot(state()); h.reader.onMount(); await settle();
      const newer = h.driver.refresh();
      h.snapshots[0]!.resolve(snapshot()); await settle();
      fail(h, 1); await newer; await settle();
      expect(h.calls()).toBe(0); expect(h.shown()).toBeNull();
    });
  });

  test("once a status read has answered, a failed focus read keeps the text and a new page still reads", async () => {
    const h = harness({ delivery: "microtask" }); await mounted(h);
    h.reader.onFocus(); h.snapshots[1]!.reject(new Error("fixture")); await settle();
    expect(h.shown()).toEqual(input()); expect(h.calls()).toBe(1);
    h.reader.onPage(file(NEXT)); await settle();
    expect(h.calls()).toBe(1); expect(h.shown()).toBeNull();                 // the status still names the old page
    h.reader.onSnapshot(state(true, 1, NEXT)); await settle();
    expect(h.calls()).toBe(2);
  });

  // Rust's payload read asks status itself, and answers ordinary absence when that fails (`summary.rs`, `absent()`). So the
  // same failure would reach a forced payload read as a real non-ready answer, and the text would go.
  test.each(["rejected", "status null"] as const)("a focus whose status read fails (%s) issues no payload read, so the failure's own unavailable reply cannot take the text", async (kind) => {
    const h = harness({ delivery: "microtask" }); await mounted(h);
    const shownBefore = h.shownLog.length;
    h.reader.onFocus();
    if (kind === "rejected") h.snapshots[1]!.reject(new Error("fixture")); else h.snapshots[1]!.resolve(failedSnapshot());
    await settle();
    expect(h.calls()).toBe(1);
    h.reads[1]?.resolve({ state: "unavailable", warnings: [] }); await settle();
    expect(h.shown()).toEqual(input()); expect(h.shownLog.slice(shownBefore)).not.toContain(null);
    // The next read that answers re-reads as usual: the failed one spent nothing.
    h.reader.onFocus(); h.snapshots[2]!.resolve(snapshot()); await settle();
    expect(h.calls()).toBe(2);
    h.reads[1]!.resolve({ ...ready(), goodMorningSentence: "A newer sentence." }); await settle();
    expect(h.shown()).toEqual({ ...input(), goodMorningSentence: "A newer sentence." });
  });
});

describe("returning to Today keeps the last accepted payload, per App", () => {
  const live = () => harness({ delivery: "microtask" });
  const NEWER = "A newer sentence.";

  test("the same key shows it at once with no null in between, then re-reads in place", async () => {
    const h = live(); await mounted(h); h.leave();
    h.back();
    expect(h.shown()).toEqual(input());                                      // synchronously, before any read has answered
    expect(h.calls()).toBe(1); expect(h.refreshes()).toBe(2);
    await settle(); expect(h.calls()).toBe(1);                               // the payload read still waits for the ordered answer
    h.snapshots[1]!.resolve(snapshot()); await settle();
    expect(h.calls()).toBe(2); expect(h.shown()).toEqual(input());
    h.reads[1]!.resolve({ ...ready(), goodMorningSentence: NEWER }); await settle();
    expect(h.shown()).toEqual({ ...input(), goodMorningSentence: NEWER });
    expect(h.shownLog).not.toContain(null);
    // And that newer one is what the next return shows.
    h.leave(); h.back();
    expect(h.shown()).toEqual({ ...input(), goodMorningSentence: NEWER });
  });

  test("another page's identity shows nothing", async () => {
    const h = live(); await mounted(h); h.leave();
    // App's state still names the kept page, and the page Today holds is another: the gate is closed.
    h.back(file(NEXT));
    expect(h.shown()).toBeNull();
    // App's state moves on to that page: a different key, with nothing kept for it.
    h.snapshots[1]!.resolve(snapshot(true, 1, NEXT)); await settle();
    expect(h.shown()).toBeNull(); expect(h.calls()).toBe(2);
    h.reads[1]!.resolve(ready(NEXT)); await settle();
    expect(h.shown()).toEqual(input(NEXT));
    expect(h.shownLog).not.toContainEqual(input());
  });

  test("another revision of the same page shows nothing until its own read", async () => {
    const h = live(); await mounted(h); h.leave();
    const moved = h.driver.refresh(); h.snapshots[1]!.resolve(snapshot(true, 2)); await moved; await settle();
    h.back();
    expect(h.shown()).toBeNull();
    h.snapshots[2]!.resolve(snapshot(true, 2)); await settle();
    expect(h.calls()).toBe(2); expect(h.shown()).toBeNull();
    h.reads[1]!.resolve({ ...ready(), revision: 2 }); await settle();
    expect(h.shown()).toEqual(input());
    expect(h.shownLog.filter((s) => s !== null)).toHaveLength(1);
  });

  test("off saved while away shows nothing, whether or not that save's read has answered", async () => {
    for (const answered of [true, false]) {
      const h = live(); await mounted(h); h.leave();
      const save = h.driver.saved();
      if (answered) { h.snapshots[1]!.resolve(snapshot(false)); await save; await settle(); }
      h.back();
      expect(h.shown()).toBeNull();
      await settle();
      // The read this mount sent supersedes a save's read still out.
      if (!answered) h.snapshots[1]!.resolve(snapshot()); // dropped: older than the mount's own
      h.snapshots[2]!.resolve(snapshot(false)); await settle();
      expect(h.shown()).toBeNull(); expect(h.calls()).toBe(1);
      expect(h.shownLog.filter((s) => s !== null)).toEqual([]);
    }
  });

  test("a save that turned it off drops the payload: turning it on again does not bring the old text back early", async () => {
    const h = live(); await mounted(h); h.leave();
    const off = h.driver.saved(); h.snapshots[1]!.resolve(snapshot(false)); await off; await settle();
    expect(h.driver.kept.read()).toBeNull();
    const on = h.driver.saved(); h.snapshots[2]!.resolve(snapshot()); await on; await settle();
    h.back();
    expect(h.shown()).toBeNull();
    h.snapshots[3]!.resolve(snapshot()); await settle();
    expect(h.calls()).toBe(2); expect(h.shown()).toBeNull();
    h.reads[1]!.resolve(ready()); await settle();
    expect(h.shown()).toEqual(input());
  });

  test("a save that left it on hides it until that save's read answers, then the payload is back at once", async () => {
    const h = live(); await mounted(h); h.leave();
    const save = h.driver.saved();
    h.back();
    expect(h.shown()).toBeNull(); await settle(); expect(h.shown()).toBeNull();
    h.snapshots[1]!.resolve(snapshot(false));                                // the save's read, superseded by the mount's
    await settle(); expect(h.shown()).toBeNull();
    h.snapshots[2]!.resolve(snapshot()); await save; await settle();
    expect(h.shown()).toEqual(input()); expect(h.calls()).toBe(2);
    expect(h.shownLog).not.toContain(null);
  });

  test("a save's hide wins over a payload accepted after it: while hidden the holder takes nothing", async () => {
    const h = live(); await mounted(h);
    const before = h.driver.kept.read();
    const save = h.driver.saved();
    h.driver.kept.write({ key: "late", summary: input() });
    expect(h.driver.kept.read()).toBe(before);
    h.snapshots[1]!.resolve(snapshot(false)); await save; await settle();
    h.driver.kept.write({ key: "late", summary: input() });
    expect(h.driver.kept.read()).toBeNull();
  });

  test("an external off edit shows until the mount's read answers, and then the payload is gone", async () => {
    const h = live(); await mounted(h); h.leave();
    h.back();
    expect(h.shown()).toEqual(input());
    h.snapshots[1]!.resolve(snapshot(false)); await settle();
    expect(h.shown()).toBeNull(); expect(h.driver.kept.read()).toBeNull(); expect(h.calls()).toBe(1);
  });

  test.each(["rejected", "status null"] as const)("a return whose status read fails (%s) keeps the text and reads no payload; the next good read re-reads", async (kind) => {
    const h = live(); await mounted(h); h.leave();
    h.back();
    if (kind === "rejected") h.snapshots[1]!.reject(new Error("fixture")); else h.snapshots[1]!.resolve(failedSnapshot());
    await settle();
    expect(h.calls()).toBe(1); expect(h.shown()).toEqual(input());
    const later = h.driver.refresh(); h.snapshots[2]!.resolve(snapshot()); await later; await settle();
    expect(h.calls()).toBe(2); expect(h.shown()).toEqual(input());
    expect(h.shownLog).not.toContain(null);
  });

  test("a real non-ready answer drops it, and a thrown read does not", async () => {
    const h = live(); await mounted(h);
    h.reader.onFocus(); h.snapshots[1]!.resolve(snapshot()); await settle();
    h.reads[1]!.reject(new Error("fixture")); await settle();
    h.leave(); h.back();
    expect(h.shown()).toEqual(input());
    // The return's own read throws: this reader has read nothing, so what it keeps is what App kept.
    h.snapshots[2]!.resolve(snapshot()); await settle();
    h.reads[2]!.reject(new Error("fixture")); await settle();
    expect(h.shown()).toEqual(input()); expect(h.driver.kept.read()?.summary).toEqual(input());
    expect(h.shownLog).not.toContain(null);
    h.reader.onFocus(); h.snapshots[3]!.resolve(snapshot()); await settle();
    h.reads[3]!.resolve({ state: "unavailable", warnings: [] }); await settle();
    expect(h.shown()).toBeNull();
    h.leave(); h.back();
    expect(h.shown()).toBeNull();
  });

  test("a reply landing after Today left keeps nothing", async () => {
    const h = live(); await mounted(h);
    h.reader.onFocus(); h.snapshots[1]!.resolve(snapshot()); await settle();
    expect(h.calls()).toBe(2);
    h.leave();
    h.reads[1]!.resolve({ ...ready(), goodMorningSentence: NEWER }); await settle();
    h.back();
    expect(h.shown()).toEqual(input());
  });

  test("independent App instances share nothing", async () => {
    const h = live(), other = live();
    await mounted(h);
    // The other App knows the same key is on, and has read no payload of its own.
    const read = other.driver.refresh(); other.snapshots[0]!.resolve(snapshot()); await read; await settle();
    other.leave(); other.back();
    expect(other.driver.kept.read()).toBeNull(); expect(other.shown()).toBeNull();
    expect(h.driver.kept.read()?.summary).toEqual(input());
    h.leave(); h.back();
    expect(h.shown()).toEqual(input()); expect(other.shown()).toBeNull();
  });

  test("a disposed App's holder takes nothing", async () => {
    const h = live(); await mounted(h);
    const before = h.driver.kept.read();
    h.driver.dispose();
    h.driver.kept.write(null);
    expect(h.driver.kept.read()).toBe(before);
  });
});

describe("the watcher only triggers the ordered read", () => {
  const known = async (h: ReturnType<typeof harness>) => { await mounted(h); expect(h.snapshots).toHaveLength(1); };

  test("countdown-only events make no read and no publication, for any route", async () => {
    const h = harness(); await known(h);
    const count = h.publications.length;
    for (const minutes of [41, 40, 39]) h.driver.onWatcher(countdown(minutes));
    await settle();
    expect(h.snapshots).toHaveLength(1); expect(h.publications).toHaveLength(count);
    expect(h.calls()).toBe(1); expect(h.shown()).toEqual(input());
  });

  test("with Today unmounted, the first event reads once and later countdown events do not", async () => {
    const publications: SummaryStatusState[] = [];
    let reads = 0;
    const driver = summaryStatusDriver({ readSnapshot: async () => { reads++; return snapshot(); },
      publish: (s) => { publications.push(s); }, onerror: () => {}, onrecovered: () => {} });
    driver.onWatcher(countdown(41)); await settle();
    expect(reads).toBe(1); expect(publications.at(-1)?.known).toBe(true);
    const count = publications.length;
    driver.onWatcher(countdown(40)); driver.onWatcher(countdown(39)); await settle();
    expect(reads).toBe(1); expect(publications).toHaveLength(count);
  });

  test("a sidecar landing makes one status read and one payload read, with the page mtime unchanged", async () => {
    const h = harness(); h.reader.onMount();
    h.snapshots[0]!.resolve(snapshot(true, 0)); await settle();
    h.reads[0]!.resolve({ state: "pending", warnings: [] }); await settle();
    h.driver.onWatcher(snapshot(true)); h.driver.onWatcher(countdown(40)); await settle();
    expect(h.snapshots).toHaveLength(2);
    h.snapshots[1]!.resolve(snapshot(true)); await settle();
    expect(h.calls()).toBe(2);
    h.reads[1]!.resolve(ready()); await settle(); expect(html(h.shown())).toContain(POINT);
    h.driver.onWatcher(countdown(39)); await settle();
    expect(h.snapshots).toHaveLength(2); expect(h.calls()).toBe(2);
  });

  test("a new page makes one status read and one payload read", async () => {
    const h = harness(); await known(h);
    const next = snapshot(true, 1, NEXT, "new page mtime");
    h.driver.onWatcher(next); await settle();
    expect(h.snapshots).toHaveLength(2); expect(h.shown()).toEqual(input());
    h.reader.onPage(file(NEXT)); expect(h.shown()).toBeNull();               // the old page's text goes with its page
    h.snapshots[1]!.resolve(next); await settle();
    expect(h.calls()).toBe(2);
    h.reads[1]!.resolve(ready(NEXT)); await settle(); expect(h.shown()).toEqual(input(NEXT));
    h.driver.onWatcher(countdown(30, next)); await settle();
    expect(h.snapshots).toHaveLength(2); expect(h.calls()).toBe(2);
  });

  test("a page mtime alone reads status once and reuses the payload", async () => {
    const h = harness(); await known(h);
    const touched = snapshot(true, 1, ID, "touched");
    h.driver.onWatcher(touched); await settle(); expect(h.snapshots).toHaveLength(2);
    h.snapshots[1]!.resolve(touched); await settle();
    expect(h.calls()).toBe(1); expect(h.shown()).toEqual(input());
  });

  test("the event's fields are never published: only the read it triggered is", async () => {
    const h = harness(); await known(h);
    const count = h.publications.length;
    h.driver.onWatcher(snapshot(true, 0)); await settle();
    expect(h.publications).toHaveLength(count);
    h.snapshots[1]!.resolve(snapshot(false)); await settle();
    expect(h.publications.at(-1)).toEqual(state(false));
    expect(h.publications.some((p) => p.revision?.state === "pending")).toBe(false);
  });

  test("an event the ordered read already saw makes no read", async () => {
    const h = harness(); h.reader.onMount();
    h.snapshots[0]!.resolve(snapshot(true, 0)); await settle();
    h.driver.onWatcher(snapshot(true, 0)); await settle(); expect(h.snapshots).toHaveLength(1);
    h.reader.onFocus(); h.snapshots[1]!.resolve(snapshot()); await settle();
    h.driver.onWatcher(snapshot()); await settle();
    expect(h.snapshots).toHaveLength(2);
  });

  test("after a save read off, the watcher's stale on makes no minute-tick read, and a real change still reads", async () => {
    const h = harness(); await known(h);
    h.driver.onWatcher(countdown(41)); await settle(); expect(h.snapshots).toHaveLength(1);
    const save = h.driver.saved(); h.snapshots[1]!.resolve(snapshot(false)); await save; await settle();
    const count = h.publications.length;
    for (const minutes of [40, 39, 38]) h.driver.onWatcher(countdown(minutes));
    await settle();
    expect(h.snapshots).toHaveLength(2); expect(h.publications).toHaveLength(count); expect(h.shown()).toBeNull();
    // The watcher's own next read catches up: the same state as the save's read, so nothing new.
    h.driver.onWatcher(snapshot(false)); await settle(); expect(h.snapshots).toHaveLength(2);
    const later = snapshot(false, 1, ID, "later");
    h.driver.onWatcher(later); await settle(); expect(h.snapshots).toHaveLength(3);
  });

  test("a save whose read failed stays hidden through countdown events, and focus or a real change reads again", async () => {
    const h = harness(); await known(h);
    h.driver.onWatcher(countdown(41));
    const save = h.driver.saved(); h.snapshots[1]!.reject(new Error("fixture")); await save; await settle();
    h.driver.onWatcher(countdown(40)); await settle();
    expect(h.snapshots).toHaveLength(2); expect(h.shown()).toBeNull();
    expect(h.publications.at(-1)?.known).toBe(false);
    h.driver.onWatcher(snapshot(false)); await settle();
    expect(h.snapshots).toHaveLength(3);
  });

  test.each(["rejected", "status null"] as const)("a %s read forgets what the last read saw, so that state's event reads again", async (kind) => {
    const h = harness(); await known(h);
    h.driver.onWatcher(snapshot(true, 0)); await settle(); expect(h.snapshots).toHaveLength(2);
    if (kind === "rejected") h.snapshots[1]!.reject(new Error("fixture")); else h.snapshots[1]!.resolve(failedSnapshot());
    await settle();
    h.driver.onWatcher(snapshot()); await settle();
    expect(h.snapshots).toHaveLength(3);
  });

  test("a watcher event with no status is no trigger, and recovering to the same state is none either", async () => {
    const h = harness(); await known(h);
    h.driver.onWatcher(snapshot());
    const count = h.publications.length;
    h.driver.onWatcher(failedSnapshot()); await settle();
    expect(h.snapshots).toHaveLength(1); expect(h.publications).toHaveLength(count); expect(h.shown()).toEqual(input());
    h.driver.onWatcher(countdown(40)); await settle();
    expect(h.snapshots).toHaveLength(1);
    h.driver.onWatcher(snapshot(true, 0)); await settle();
    expect(h.snapshots).toHaveLength(2);
  });

  test("a disposed driver ignores events", async () => {
    const h = harness(); await known(h);
    h.driver.dispose(); h.driver.onWatcher(snapshot(false)); await settle();
    expect(h.snapshots).toHaveLength(1);
  });
});

describe("a failed status read inside a snapshot", () => {
  test("status null stays unknown and goes to the error callback, never known and off", async () => {
    const h = harness(); await mounted(h);
    const save = h.driver.saved(); h.snapshots[1]!.resolve(failedSnapshot()); await save; await settle();
    expect(h.publications.at(-1)?.known).toBe(false);
    expect(h.publications.filter((p) => p.known && !p.status.enabled)).toHaveLength(0);
    expect(h.errors).toEqual(["fixture status failure"]); expect(h.shown()).toBeNull();
    h.reader.onFocus(); h.snapshots[2]!.resolve(snapshot()); await settle();
    expect(h.publications.at(-1)).toEqual(state()); expect(h.calls()).toBe(2);
    h.reads[1]!.resolve(ready()); await settle(); expect(h.shown()).toEqual(input());
  });
  test("status null with no error text stays unknown and reports nothing", async () => {
    const h = harness(); await mounted(h);
    const save = h.driver.saved(); h.snapshots[1]!.resolve(failedSnapshot(null)); await save; await settle();
    expect(h.publications.at(-1)?.known).toBe(false); expect(h.errors).toEqual([]);
  });
  test("the failure line lasts until the driver's next good read, and a superseded or failed read does not clear it", async () => {
    const h = harness(); await mounted(h);
    expect(h.recoveries()).toBe(1);                                          // the mount's own good read
    const first = h.driver.refresh(); h.snapshots[1]!.reject(new Error("fixture")); await first;
    expect(h.errors).toHaveLength(1); expect(h.recoveries()).toBe(1);
    const failed = h.driver.refresh(); h.snapshots[2]!.resolve(failedSnapshot()); await failed;
    expect(h.errors).toHaveLength(2); expect(h.recoveries()).toBe(1);
    const older = h.driver.refresh(); const newer = h.driver.refresh();
    h.snapshots[3]!.resolve(snapshot()); await settle();
    expect(h.recoveries()).toBe(1);
    h.snapshots[4]!.resolve(snapshot()); await newer; await older;
    expect(h.recoveries()).toBe(2); expect(h.errors).toHaveLength(2);
  });
  test("App holds the driver's failure in its own slot, shown where a snapshot's is, cleared only through the driver", () => {
    const app = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(app).toContain("onerror: (error) => { summaryStatusError = describeFailure(error); }, onrecovered: () => { summaryStatusError = null; } });");
    expect(app).toContain("<History dates={archive} error={snapshotError ?? summaryStatusError}");
    expect(app.match(/<Schedule state=\{snapshot\?\.scheduleState \?\? null\} error=\{snapshotError \?\? summaryStatusError\}/g)).toHaveLength(1);
    expect(app.match(/summaryStatusError = /g)).toHaveLength(3);             // its declaration and the two callbacks; applySnapshot writes only its own slot
  });
  test("App reads again on window focus off Today and on entering History or Schedule, and every snapshot it reads can clear the line", () => {
    const app = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(app.match(/<svelte:window onfocus=\{onWindowFocus\} \/>/g)).toHaveLength(1);
    expect(app).toContain('function onWindowFocus(): void { if (route !== "today") summaryStatus.retryIfFailed(); }');
    expect(app).toContain('$effect(() => { if (route === "history" || route === "schedule") summaryStatus.retryIfFailed(); });');
    expect(app).toContain("const next = await stateSnapshot(); applySnapshot(next); summaryStatus.noteStatus(next);");
    expect(app).not.toContain("setInterval(() => summaryStatus");
  });
  test.each(["rejected", "status null"] as const)("retryIfFailed reads again only while a %s read's failure stands", async (kind) => {
    const h = harness(); await mounted(h);
    h.driver.retryIfFailed(); expect(h.snapshots).toHaveLength(1);            // nothing failed
    const fail = (n: number) => { if (kind === "rejected") h.snapshots[n]!.reject(new Error("fixture")); else h.snapshots[n]!.resolve(failedSnapshot()); };
    const first = h.driver.refresh(); fail(1); await first;
    expect(h.errors).toHaveLength(1);
    h.driver.retryIfFailed(); expect(h.snapshots).toHaveLength(3);
    fail(2); await settle();
    expect(h.errors).toHaveLength(2); expect(h.recoveries()).toBe(1);
    h.driver.retryIfFailed(); expect(h.snapshots).toHaveLength(4);
    h.snapshots[3]!.resolve(snapshot()); await settle();
    expect(h.recoveries()).toBe(2);
    h.driver.retryIfFailed(); expect(h.snapshots).toHaveLength(4);            // over
  });
  test("a status null with no error text reported nothing, so there is nothing to read again", async () => {
    const h = harness(); await mounted(h);
    const read = h.driver.refresh(); h.snapshots[1]!.resolve(failedSnapshot(null)); await read;
    h.driver.retryIfFailed(); expect(h.snapshots).toHaveLength(2);
  });
  test("a state:changed with a status clears the line with no read of its own; one with no status does not, and countdowns never re-read", async () => {
    const h = harness(); await mounted(h);
    h.driver.onWatcher(snapshot());
    const read = h.driver.refresh(); h.snapshots[1]!.reject(new Error("fixture")); await read;
    expect(h.errors).toHaveLength(1); expect(h.recoveries()).toBe(1);
    const reads = h.snapshots.length, published = h.publications.length;
    for (let n = 0; n < 3; n++) h.driver.onWatcher(failedSnapshot());
    await settle();
    expect(h.recoveries()).toBe(1); expect(h.snapshots).toHaveLength(reads);
    h.driver.onWatcher(countdown(40)); await settle();
    expect(h.recoveries()).toBe(2); expect(h.snapshots).toHaveLength(reads); expect(h.publications).toHaveLength(published);
    h.driver.onWatcher(countdown(39)); await settle();
    expect(h.recoveries()).toBe(2);                                           // the line is already gone: reported once
    h.driver.retryIfFailed(); expect(h.snapshots).toHaveLength(reads);
  });
  test("a snapshot App read for itself clears the line when it has a status, so a cleared snapshot error cannot surface an old summary failure", async () => {
    const h = harness(); await mounted(h);
    const read = h.driver.refresh(); h.snapshots[1]!.reject(new Error("fixture")); await read;
    h.driver.noteStatus(failedSnapshot()); expect(h.recoveries()).toBe(1);
    h.driver.noteStatus(snapshot()); expect(h.recoveries()).toBe(2);
    h.driver.noteStatus(snapshot()); expect(h.recoveries()).toBe(2);
    expect(h.snapshots).toHaveLength(2);                                      // it reads nothing itself
  });
  test("a disposed driver neither reads again nor reports recovery", async () => {
    const h = harness(); await mounted(h);
    const read = h.driver.refresh(); h.snapshots[1]!.reject(new Error("fixture")); await read;
    h.driver.dispose();
    h.driver.retryIfFailed(); h.driver.noteStatus(snapshot()); h.driver.onWatcher(snapshot(false));
    expect(h.snapshots).toHaveLength(2); expect(h.recoveries()).toBe(1);
  });
  test("a late failed snapshot from a superseded read reports nothing", async () => {
    const h = harness(); await mounted(h);
    const older = h.driver.refresh(); const newer = h.driver.refresh();
    h.snapshots[2]!.resolve(snapshot()); await newer;
    h.snapshots[1]!.resolve(failedSnapshot()); await older; await settle();
    expect(h.errors).toEqual([]); expect(h.publications.at(-1)).toEqual(state());
  });
});

describe("summary deck and plain-text render", () => {
  test("exact membership drops only the unknown key, including control and bidi keys", () => {
    for (const key of ["project:unknown", "project:orchard\u0001", "project:orchard\u202e"]) {
      const summary = { ...input(), projects: [...input().projects, { key, points: ["Unknown entry must not render"] }] };
      const result = view(summary);
      expect(result.deck.kind).toBe("slides");
      if (result.deck.kind !== "slides") throw new Error("slides");
      expect(result.deck.page.whatYouDid.cards[0]!.points).toEqual([{ text: POINT }]);
      const rendered = html(summary); expect(rendered).toContain(POINT); expect(rendered).not.toContain("Unknown entry must not render");
      expect(rendered).not.toContain(key);
    }
  });
  test("wire keys are exact, a replacement is exactly its points, and a project with no entry keeps its own", () => {
    const page = file(ID, `☀️  Daily briefing — ${DATE}  (this machine: fixture)
▶ What you did
   • [Alpha] First thing
   • [Alpha] Second thing
   • [Alpha] Third thing
   • [Beta] Beta one
   • [Beta] Beta two
   • [Orchard] Orchard kept
   • [unlabelled] A project with a plain name
   • A line with no label
▶ Where you left off
   • [Alpha] Finish the alpha view
▶ Suggested next
   • [Alpha] Check the alpha view
`);
    const summary: SummaryInput = { ...ID, goodMorningSentence: null, projects: [
      { key: "project:alpha", points: ["Alpha in one point."] },
      { key: "other:", points: ["The other card's point."] },
      { key: "project:Orchard", points: ["A wrong-case key must not apply."] },
      { key: "project:", points: ["An empty project key must not apply."] },
    ] };
    const result = view(summary, page);
    if (result.deck.kind !== "slides") throw new Error("slides");
    const points = Object.fromEntries(result.deck.page.whatYouDid.cards.map((card) => [card.key, card.points.map((p) => p.text)]));
    expect(points).toEqual({
      alpha: ["Alpha in one point."],
      beta: ["Beta one", "Beta two"],
      orchard: ["Orchard kept"],
      unlabelled: ["A project with a plain name"],
      "": ["The other card's point."],
    });
    const rendered = html(summary, page);
    expect(rendered).not.toContain("A wrong-case key must not apply."); expect(rendered).not.toContain("An empty project key must not apply.");
  });
  test("an entry with no points leaves the card's own points", () => {
    const result = view({ ...input(), projects: [{ key: "project:orchard", points: [] }] });
    if (result.deck.kind !== "slides") throw new Error("slides");
    expect(result.deck.page.whatYouDid.cards[0]!.points).toEqual([{ text: "Added the fallback point" }]);
  });
  test("sentence is a separate escaped paragraph before counts; old pages keep their bound summary", () => {
    const counted = file(ID, PAGE.replace("Added the fallback point", "Added the fallback point  (a1b2c3d)"));
    const rendered = html(input(), counted, "2026-01-12");
    expect(rendered).toContain(SENTENCE); expect(rendered).toContain("Your recent work:");
    expect(rendered.indexOf(SENTENCE)).toBeLessThan(rendered.indexOf("Your recent work:"));
    // Below the date and the status row: the row RunControls draws (its one button with this name) comes first.
    expect(rendered.indexOf('aria-label="What Run now does"')).toBeGreaterThan(-1);
    expect(rendered.indexOf('aria-label="What Run now does"')).toBeLessThan(rendered.indexOf(SENTENCE));
    expect(rendered).toMatch(new RegExp(`<p class="ai-sentence[^>]*>${SENTENCE.replaceAll(".", "\\.")}</p>`));
    const special = { ...input(), goodMorningSentence: "Work & tests are ready." };
    expect(html(special)).toContain("Work &amp; tests are ready.");
    expect(html(input(NEXT))).not.toContain(SENTENCE);
  });
  test("loading/error/empty and quiet omit the sentence; arrival preserves deck state and original details", () => {
    for (const latest of [{ state: "loading" }, { state: "none" }, { state: "error", message: "fixture" }] as const) {
      const model = todayModel({ snapshot: null, latest, lastRun: null, today: DATE });
      const deck = deckView({ model, today: DATE, firstName: null, summary: input() });
      if (deck.kind === "classic") throw new Error("single");
      expect(deck.goodMorning.aiSentence).toBeNull();
    }
    const quiet = file(ID, `☀️  Daily briefing — ${DATE}  (this machine: fixture)\n▶ What you did\n   (no commits in the window)\n`);
    expect(html(input(), quiet)).not.toContain(SENTENCE);
    const before = view(null).deck, after = view(input()).deck;
    if (before.kind !== "slides" || after.kind !== "slides") throw new Error("slides");
    expect(after.slides).toEqual(before.slides);
    expect(after.page.whatYouDid.cards[0]!.lines).toEqual(before.page.whatYouDid.cards[0]!.lines);
    expect(after.goodMorning.workLine).toBe(before.goodMorning.workLine);
    const todaySource = readFileSync(new URL("../src/routes/Today.svelte", import.meta.url), "utf8");
    expect(todaySource).toContain('latest.state === "loaded" ? briefingHash(latest.file.text) : null');
    const deckSource = readFileSync(new URL("../src/lib/deck/DeckOrClassic.svelte", import.meta.url), "utf8");
    expect(deckSource).toContain("const key = briefingKey");
  });
});

const handoffRoot = process.env.DBA_SUMMARY_ROUNDTRIP_DIR;
const required = process.env.DBA_SUMMARY_ROUNDTRIP_REQUIRED === "1";
if (!handoffRoot && !required) console.log("summary-handoff: skipped (no handoff directory)");
test.skipIf(!handoffRoot && !required)("summary-handoff: production deck render", async () => {
  expect(handoffRoot).toBeTruthy();
  const root = realpathSync(handoffRoot!);
  const artifact = (name: string) => JSON.parse(readFileSync(join(root, name), "utf8"));
  const pageReceipt = artifact("page-receipt.json");
  expect(artifact("reader-receipt.json")).toEqual(pageReceipt);
  const captured = artifact("ipc-reply.json");
  const statusReport = artifact("status-report.json");
  const statusModel = artifact("status-model.json");
  const id = { pageHash: captured.pageHash, pageVersion: captured.pageVersion };
  expect(id).toEqual({ pageHash: pageReceipt.pageHash, pageVersion: pageReceipt.pageVersion });
  expect(captured.pageDate).toBe(pageReceipt.HANDOFF_DATE);
  expect(statusModel.lastRunDate).toBe(pageReceipt.HANDOFF_DATE);
  const rel = relative(root, realpathSync(captured.pagePath));
  expect(rel !== "" && rel !== ".." && !rel.startsWith("../") && !isAbsolute(rel)).toBe(true);
  const snap = { ...snapshot(), status: statusReport };
  expect(summaryStatusOf(snap)).toEqual(statusModel.aiSummaryStatus);
  expect(summaryRevisionOf(snap)).toEqual(statusModel.latestSummaryRevision);
  expect(summaryStatusOf(snap).enabled).toBe(true);
  expect(summaryRevisionOf(snap)).toEqual({ ...id, revision: captured.reply.revision, state: "ready" });
  expect(captured.reply).toEqual({ state: "ready", ...id, revision: 1, projects: pageReceipt.projects,
    goodMorningSentence: pageReceipt.goodMorningSentence, warnings: [] });
  const page = { ...file(id, readFileSync(captured.pagePath, "utf8")), path: captured.pagePath };
  let shown: SummaryInput | null = null;
  let calls = 0;
  const driver = summaryStatusDriver({ readSnapshot: async () => snap,
    publish: (s) => reader.onSnapshot(s), onerror: (e) => { throw e; }, onrecovered: () => {} });
  const reader = summaryReader({ readLatestSummary: async (hash, version) => {
    expect({ pageHash: hash, pageVersion: version }).toEqual(id); calls++; return captured.reply;
  }, refreshStatus: () => driver.refresh(), kept: driver.kept, publish: (s) => { shown = s; } });
  reader.onPage(page); reader.onMount(); await settle(); expect(calls).toBe(1); expect(shown).not.toBeNull();
  const rendered = html(shown, page, captured.pageDate);
  for (const project of pageReceipt.projects) for (const point of project.points) expect(rendered).toContain(point);
  expect(rendered).toContain(pageReceipt.goodMorningSentence);
  const cards = view(shown, page, captured.pageDate).deck;
  if (cards.kind !== "slides") throw new Error("summary-handoff: slides required");
  expect(cards.page.whatYouDid.cards.flatMap((card) => card.points.map((point) => point.text)))
    .toEqual(pageReceipt.projects.flatMap((project: { points: string[] }) => project.points));
  expect(rendered).not.toContain("Added the fallback point");
  reader.dispose(); driver.dispose();
  console.log("\nsummary-handoff: render ok");
});
