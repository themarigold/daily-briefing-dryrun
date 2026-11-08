/**
 * A-M1-T2 — the webview's app-preference store (`src/lib/app-prefs-store.ts`; redesign A spec, "The slides
 * switch" and "First name"): module state over the two Rust commands `app_prefs_get` and `app_prefs_set`.
 *
 * What is pinned here:
 *   1. "loaded" means SETTLED: a rejected `app_prefs_get` leaves the defaults (name unset, slides and links on, no
 *      editor choices) and records a one-line failure for the Settings rows, and `loadAppPrefs()` itself never rejects;
 *   2. a set sends `{ patch: { firstName } }`, `{ patch: { slides } }` or `{ patch: { githubLinks } }` and updates the
 *      store from Rust's answer on success (Rust trims the name, so the answer is what is kept), and keeps the old value
 *      on failure, answering the refusal's sentence for the row to show inline;
 *   3. B2-M4-T10: the store mirrors `githubLinks` and `editorChoices`, the `preferences-full` refusal maps to its fixed
 *      sentence, and the editor token union equals `src-tauri/src/editor.rs`'s list.
 *
 * ⚠ THE IPC IS A RECORDER, NOT TAURI (the `provider-flows.check.ts` pattern): `invoke` calls
 * `window.__TAURI_INTERNALS__.invoke(cmd, args)`, installed per test. Nothing here reaches a real store.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import {
  APP_PREFS_DEFAULTS,
  appPrefs,
  appPrefsLoadFailure,
  loadAppPrefs,
  appPrefsSettled,
  onAppPrefsChange,
  setFirstName,
  setGithubLinks,
  setSlides,
  type AppPrefs,
} from "../src/lib/app-prefs-store";
import { deckView } from "../src/lib/deck";
import { todayModel } from "../src/lib/today";

type Json = Record<string, unknown>;
let calls: [string, Json | undefined][] = [];
let handler: (command: string, args: Json | undefined) => unknown;
const g = globalThis as { window?: unknown };
let hadWindow = false;
let windowBefore: unknown;

beforeEach(() => {
  calls = [];
  handler = () => {
    throw new Error("no handler set");
  };
  hadWindow = "window" in g;
  windowBefore = g.window;
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: Json | undefined) => {
        calls.push([command, args === undefined ? undefined : structuredClone(args)]);
        try {
          return Promise.resolve(handler(command, args));
        } catch (e) {
          return Promise.reject(e);
        }
      },
    },
  };
});

afterEach(() => {
  if (hadWindow) g.window = windowBefore;
  else delete g.window;
});

/** The whole stored value for a name and a slides setting, with the two B2 values at their defaults. */
function stored(firstName: string | null, slides: boolean): AppPrefs {
  return { firstName, slides, githubLinks: true, editorChoices: {} };
}

const STORE_FAILURE = { kind: "store", detail: "this app's data directory could not be resolved: no home" };
const TOO_LONG = {
  kind: "invalidInput",
  field: "firstName",
  reason: "Your first name can be at most 40 characters.",
};

test("the defaults are name unset, slides and links on, and no editor choices", () => {
  expect(APP_PREFS_DEFAULTS).toEqual(stored(null, true));
});

test("a load reads Rust's answer; an absent firstName is unset", async () => {
  handler = () => ({ firstName: "Sam", slides: false });
  await loadAppPrefs();
  expect(appPrefs()).toEqual(stored("Sam", false));
  expect(appPrefsLoadFailure()).toBe("");
  expect(calls.map(([c]) => c)).toEqual(["app_prefs_get"]);

  handler = () => ({ slides: true });
  await loadAppPrefs();
  expect(appPrefs()).toEqual(stored(null, true));
});

test("a rejected get settles to the defaults and records the failure; the load itself never rejects", async () => {
  // A loaded non-default state first, so "the defaults" cannot be a leftover.
  handler = () => ({ firstName: "Sam", slides: false });
  await loadAppPrefs();
  expect(appPrefs()).toEqual(stored("Sam", false));

  handler = () => {
    throw STORE_FAILURE;
  };
  await expect(loadAppPrefs()).resolves.toBeUndefined();
  expect(appPrefs()).toEqual(APP_PREFS_DEFAULTS);
  expect(appPrefsLoadFailure()).toBe(STORE_FAILURE.detail);

  // A later successful load clears the failure line.
  handler = () => ({ slides: true });
  await loadAppPrefs();
  expect(appPrefsLoadFailure()).toBe("");
});

test("appPrefs() hands out a copy, so a caller cannot change the store", async () => {
  handler = () => ({ firstName: "Sam", slides: true });
  await loadAppPrefs();
  const got = appPrefs();
  got.slides = false;
  got.firstName = "Alex";
  got.githubLinks = false;
  got.editorChoices.a = "zed";
  expect(appPrefs()).toEqual(stored("Sam", true));
});

test("setSlides sends one named patch and keeps Rust's answer on success", async () => {
  handler = () => ({ firstName: "Sam", slides: true });
  await loadAppPrefs();
  calls = [];
  handler = () => ({ firstName: "Sam", slides: false });
  expect(await setSlides(false)).toEqual({ ok: true });
  expect(calls).toEqual([["app_prefs_set", { patch: { slides: false } }]]);
  expect(appPrefs()).toEqual(stored("Sam", false));
});

test("setFirstName sends one named patch and keeps Rust's trimmed answer on success", async () => {
  handler = () => ({ slides: true });
  await loadAppPrefs();
  calls = [];
  handler = () => ({ firstName: "Sam", slides: true });
  expect(await setFirstName("  Sam ")).toEqual({ ok: true });
  expect(calls).toEqual([["app_prefs_set", { patch: { firstName: "  Sam " } }]]);
  expect(appPrefs()).toEqual(stored("Sam", true));

  // An empty name unsets it (Rust answers no firstName).
  handler = () => ({ slides: true });
  expect(await setFirstName("")).toEqual({ ok: true });
  expect(appPrefs()).toEqual(stored(null, true));
});

test("a refused set keeps the old value and answers the refusal's own sentence", async () => {
  handler = () => ({ firstName: "Sam", slides: false });
  await loadAppPrefs();
  handler = () => {
    throw TOO_LONG;
  };
  expect(await setFirstName("a".repeat(41))).toEqual({ ok: false, message: TOO_LONG.reason, refused: true });
  expect(appPrefs()).toEqual(stored("Sam", false));

  handler = () => {
    throw STORE_FAILURE;
  };
  expect(await setSlides(true)).toEqual({ ok: false, message: STORE_FAILURE.detail, refused: false });
  expect(appPrefs()).toEqual(stored("Sam", false));

  handler = () => {
    throw "a plain string";
  };
  expect(await setSlides(true)).toEqual({ ok: false, message: "a plain string", refused: false });
  expect(appPrefs()).toEqual(stored("Sam", false));
});

/* ── round-1 M1: a reader can FOLLOW the store (Today) ────────────────────────────────────────── */

test("M1: a subscriber hears every value the store settles on — a load and a successful set; a refused or failed set changes no value (round-4 L4: it is heard as the store settling, with the values unchanged)", async () => {
  handler = () => ({ firstName: "Sam", slides: true });
  await loadAppPrefs();
  const heard: AppPrefs[] = [];
  const stop = onAppPrefsChange((p) => heard.push(p));
  try {
    handler = () => ({ firstName: "Alex", slides: true });
    await setFirstName("Alex");
    handler = () => ({ firstName: "Alex", slides: false });
    await setSlides(false);
    handler = () => {
      throw TOO_LONG;
    };
    await setFirstName("a".repeat(41));
    handler = () => {
      throw STORE_FAILURE;
    };
    await setSlides(true);
    expect(heard).toEqual([
      stored("Alex", true),
      stored("Alex", false),
      stored("Alex", false),   // refused: settled again, nothing changed
      stored("Alex", false),   // the store failed: the same
    ]);
    // A load is heard too, the failed one included (it settles to the defaults).
    await loadAppPrefs();
    expect(heard.at(-1)).toEqual(APP_PREFS_DEFAULTS);
    // Each subscriber gets its own copy: changing it does not change the store.
    heard.at(-1)!.firstName = "Mallory";
    expect(appPrefs().firstName).toBeNull();
  } finally {
    stop();
  }
  // Unsubscribed: nothing more is heard.
  const before = heard.length;
  handler = () => ({ firstName: "Zed", slides: true });
  await setFirstName("Zed");
  expect(heard.length).toBe(before);
});

test("M1: a name and a slides set still IN FLIGHT when Today mounted change its greeting and its mode when they land (Today's wiring: the store's value at mount, then the listener)", async () => {
  handler = () => ({ firstName: "Sam", slides: true });
  await loadAppPrefs();
  // Two sets sent from Settings, answered only later.
  const answers: ((v: unknown) => void)[] = [];
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: Json | undefined) => {
        calls.push([command, args === undefined ? undefined : structuredClone(args)]);
        return new Promise((resolve) => answers.push(resolve));
      },
    },
  };
  const nameSet = setFirstName("Alex");
  const slidesSet = setSlides(false);
  // Today mounts while both are in flight: `let prefs = $state(appPrefs())`, then `onAppPrefsChange((next) => (prefs = next))`.
  let prefs = appPrefs();
  const stop = onAppPrefsChange((next) => (prefs = next));
  try {
    const greeting = () => {
      const model = todayModel({ snapshot: null, latest: { state: "none" }, lastRun: null, today: "2026-10-16" });
      const v = deckView({ model, today: "2026-10-16", firstName: prefs.firstName });
      return v.kind === "classic" ? null : v.goodMorning.greeting;
    };
    expect([greeting(), prefs.slides]).toEqual(["Good morning, Sam", true]);
    answers[0]!({ firstName: "Alex", slides: true });
    await nameSet;
    expect([greeting(), prefs.slides]).toEqual(["Good morning, Alex", true]);
    answers[1]!({ firstName: "Alex", slides: false });
    await slidesSet;
    expect([greeting(), prefs.slides]).toEqual(["Good morning, Alex", false]);
  } finally {
    stop();
  }
});

/* ── round 3: the settled flag (M1) and answers out of order (L3) ─────────────────────────────── */

/** The per-test recorder IPC again (beforeEach's), answering from `handler`. */
function installRecorder(): void {
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: Json | undefined) => {
        calls.push([command, args === undefined ? undefined : structuredClone(args)]);
        try {
          return Promise.resolve(handler(command, args));
        } catch (e) {
          return Promise.reject(e);
        }
      },
    },
  };
}

/** An IPC whose every call waits for the test to answer it (each answer is the next resolver, in call order). */
function deferredIpc(): ((v: unknown) => void)[] {
  const answers: ((v: unknown) => void)[] = [];
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: Json | undefined) => {
        calls.push([command, args === undefined ? undefined : structuredClone(args)]);
        return new Promise((resolve) => answers.push(resolve));
      },
    },
  };
  return answers;
}

test("round-3 M1: the store is SETTLED only while no load is in flight (a failed load settles too)", async () => {
  handler = () => ({ slides: true });
  await loadAppPrefs();
  expect(appPrefsSettled()).toBe(true);
  const answers = deferredIpc();
  const load = loadAppPrefs();
  expect(appPrefsSettled()).toBe(false);
  // A subscriber hearing the load's answer already sees it settled (the Settings rows' gate relies on it).
  let seenSettled: boolean | null = null;
  const stop = onAppPrefsChange(() => (seenSettled = appPrefsSettled()));
  answers[0]!({ firstName: "Sam", slides: true });
  await load;
  stop();
  expect([appPrefsSettled(), seenSettled]).toEqual([true, true]);
});

test("round-4 L1: the answer with the HIGHER revision wins — a load overtaken by a set, and (the backstop) an older answer arriving last", async () => {
  handler = () => ({ firstName: "Sam", slides: true, revision: 0 });
  await loadAppPrefs();
  // Two sets in a row (serialized: the second goes out once the first settles), revisions rising in call order.
  {
    const answers = deferredIpc();
    const heard: AppPrefs[] = [];
    const stop = onAppPrefsChange((p) => heard.push(p));
    const nameSet = setFirstName("Alex");
    const slidesSet = setSlides(false);
    answers[0]!({ firstName: "Alex", slides: true, revision: 11 });
    await nameSet;
    answers[1]!({ firstName: "Alex", slides: false, revision: 12 });
    expect(await slidesSet).toEqual({ ok: true });
    stop();
    expect(appPrefs()).toEqual(stored("Alex", false));
    expect(heard.at(-1)).toEqual(stored("Alex", false));
  }
  // A load whose answer (an older revision) lands after a set's: dropped.
  const answers = deferredIpc();
  const load = loadAppPrefs();
  const set = setSlides(true);
  answers[1]!({ firstName: "Alex", slides: true, revision: 30 });
  await set;
  answers[0]!({ firstName: "Alex", slides: false, revision: 22 });
  await load;
  expect(appPrefs()).toEqual(stored("Alex", true));
  // The backstop: an answer with a LOWER revision than one kept is dropped, whenever it arrives (serialized sets make
  // this Rust's own order; the check stays for anything that is not a set, and as a guard).
  const crossed = deferredIpc();
  const sentFirst = setSlides(false);
  crossed[0]!({ firstName: "Bea", slides: false, revision: 32 });
  await sentFirst;
  const sentSecond = setFirstName("Bea");
  crossed[1]!({ firstName: "Bea", slides: true, revision: 31 });
  await sentSecond;
  expect(appPrefs()).toEqual(stored("Bea", false));
  handler = () => ({ firstName: "Alex", slides: true, revision: 40 });
  installRecorder();
  await setSlides(true);
  // An EQUAL revision is kept, even with different values (post-cap L5): after Uninstall removed the file, a get answers
  // the defaults at the same revision (no write landed), and those are what is stored now.
  handler = () => ({ slides: true, revision: 40 });
  installRecorder();
  await loadAppPrefs();
  expect(appPrefs()).toEqual(stored(null, true));
});

test("round-4 L4: a waiting reader hears the store become settled even when the answer that ended the wait was DROPPED", async () => {
  handler = () => ({ firstName: "Zed", slides: true, revision: 100 });
  await loadAppPrefs();
  const answers = deferredIpc();
  const set = setSlides(false);
  const load = loadAppPrefs();
  expect(appPrefsSettled()).toBe(false);
  const heard: boolean[] = [];
  const stop = onAppPrefsChange(() => heard.push(appPrefsSettled()));
  answers[1]!({ firstName: "Zed", slides: false, revision: 101 });   // the load (newer): kept, not yet settled
  await load;
  answers[0]!({ firstName: "Zed", slides: true, revision: 100 });   // the set (older): dropped, and NOW settled
  await set;
  stop();
  expect(heard).toEqual([false, true]);
  expect(appPrefs()).toEqual(stored("Zed", false));
});

test("round-4 M3: SETTLED waits for sets too — a set in flight makes it false until it lands", async () => {
  handler = () => ({ slides: true, revision: 200 });
  await loadAppPrefs();
  const answers = deferredIpc();
  const set = setFirstName("Q");
  expect(appPrefsSettled()).toBe(false);
  answers[0]!({ firstName: "Q", slides: true, revision: 201 });
  await set;
  expect(appPrefsSettled()).toBe(true);
  // A refused set settles too.
  const refusing = deferredIpc();
  g.window = {
    __TAURI_INTERNALS__: { invoke: () => new Promise((_, reject) => refusing.push(reject as (v: unknown) => void)) },
  };
  const bad = setFirstName("x".repeat(41));
  expect(appPrefsSettled()).toBe(false);
  refusing[0]!(TOO_LONG);
  expect((await bad).ok).toBe(false);
  expect(appPrefsSettled()).toBe(true);
});

test("post-cap L4: a failed LOAD after Rust answered with a revision keeps those values (and records the failure); with no revision held it is the defaults", async () => {
  handler = () => ({ firstName: "Kim", slides: false, revision: 500 });
  await loadAppPrefs();
  expect(appPrefs()).toEqual(stored("Kim", false));
  handler = () => {
    throw STORE_FAILURE;
  };
  await loadAppPrefs();
  expect(appPrefs()).toEqual(stored("Kim", false));
  expect(appPrefsLoadFailure()).toBe(STORE_FAILURE.detail);
  expect(appPrefsSettled()).toBe(true);
});

/* ── serialized sets: one at a time, in call order ────────────────────────────────────────────── */

test("serialized sets: back to back, the second invoke is NOT made until the first settles — so a fake that would answer the second first cannot, and the second value is what is kept", async () => {
  handler = () => ({ firstName: "Sam", slides: true, revision: 600 });
  await loadAppPrefs();
  const answers = deferredIpc();
  calls = [];
  const al = setFirstName("Al");
  const alex = setFirstName("Alex");
  // Only "Al" has gone out; "Alex" waits in the queue.
  expect(calls.map(([, a]) => a)).toEqual([{ patch: { firstName: "Al" } }]);
  expect(answers.length).toBe(1);
  await Promise.resolve();
  expect(answers.length).toBe(1);
  answers[0]!({ firstName: "Al", slides: true, revision: 601 });
  await al;
  // Now "Alex" goes out, and Rust's revision for it is the higher one.
  expect(calls.map(([, a]) => a)).toEqual([{ patch: { firstName: "Al" } }, { patch: { firstName: "Alex" } }]);
  answers[1]!({ firstName: "Alex", slides: true, revision: 602 });
  await alex;
  expect(appPrefs()).toEqual(stored("Alex", true));
});

test("serialized sets: a FAILED first set still lets the second run", async () => {
  handler = () => ({ firstName: "Sam", slides: true, revision: 700 });
  await loadAppPrefs();
  const settle: { resolve: (v: unknown) => void; reject: (e: unknown) => void }[] = [];
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: (command: string, args: Json | undefined) => {
        calls.push([command, args === undefined ? undefined : structuredClone(args)]);
        return new Promise((resolve, reject) => settle.push({ resolve, reject }));
      },
    },
  };
  const bad = setFirstName("x".repeat(41));
  const good = setSlides(false);
  expect(settle.length).toBe(1);
  settle[0]!.reject(TOO_LONG);
  expect((await bad).ok).toBe(false);
  expect(settle.length).toBe(2);
  settle[1]!.resolve({ firstName: "Sam", slides: false, revision: 701 });
  expect(await good).toEqual({ ok: true });
  expect(appPrefs()).toEqual(stored("Sam", false));
});

test("serialized sets: appPrefsSettled() is false while ANY set is queued, and true only when the queue is empty", async () => {
  handler = () => ({ firstName: "Sam", slides: true, revision: 800 });
  await loadAppPrefs();
  const answers = deferredIpc();
  // What a waiting gate sees each time the store settles a value: the first answer must NOT read as settled, the
  // second still being queued (a gate opened there would draw the rows before the second set lands).
  const seen: boolean[] = [];
  const stop = onAppPrefsChange(() => seen.push(appPrefsSettled()));
  const one = setSlides(false);
  const two = setSlides(true);
  expect(appPrefsSettled()).toBe(false);
  answers[0]!({ firstName: "Sam", slides: false, revision: 801 });
  await one;
  expect(seen).toEqual([false]);
  expect(appPrefsSettled()).toBe(false);   // the second is still queued / in flight
  answers[1]!({ firstName: "Sam", slides: true, revision: 802 });
  await two;
  stop();
  expect(seen).toEqual([false, true]);
  expect(appPrefsSettled()).toBe(true);
});

/* ── serialized sets: the queue's harder cases (the test-strength reviewer's probes, adopted) ──── */

/** The store seeded at `revision` (Sam, slides on), then an IPC whose sets wait for the test to answer them. */
async function seededQueue(revision: number): Promise<((v: unknown) => void)[]> {
  handler = () => ({ firstName: "Sam", slides: true, revision });
  installRecorder();
  await loadAppPrefs();
  const answers = deferredIpc();
  calls = [];
  return answers;
}
/** The patches sent so far, in order. */
const sent = (): unknown[] => calls.map(([, args]) => args);
const AL = { patch: { firstName: "Al" } };
const ALEX = { patch: { firstName: "Alex" } };
const OFF = { patch: { slides: false } };

test("serialized sets: THREE back to back go out one at a time, in call order (a name save, a Turn off, then the unmount flush)", async () => {
  const answers = await seededQueue(900);
  const al = setFirstName("Al");
  const off = setSlides(false);
  const alex = setFirstName("Alex");   // the flush on unmount, with "Al" still in flight
  expect(sent()).toEqual([AL]);
  await Promise.resolve();
  expect(sent()).toEqual([AL]);
  answers[0]!({ firstName: "Al", slides: true, revision: 901 });
  await al;
  expect(sent()).toEqual([AL, OFF]);
  answers[1]!({ firstName: "Al", slides: false, revision: 902 });
  await off;
  expect(sent()).toEqual([AL, OFF, ALEX]);
  answers[2]!({ firstName: "Alex", slides: false, revision: 903 });
  await alex;
  expect(appPrefs()).toEqual(stored("Alex", false));
});

test("serialized sets: a set called while the SECOND of two is in flight (the first settled) waits for it", async () => {
  const answers = await seededQueue(1000);
  const al = setFirstName("Al");
  const alex = setFirstName("Alex");
  answers[0]!({ firstName: "Al", slides: true, revision: 1001 });
  await al;
  expect(sent()).toEqual([AL, ALEX]);   // "Alex" is in flight now
  const off = setSlides(false);
  expect(sent()).toEqual([AL, ALEX]);   // it waits for "Alex"
  await Promise.resolve();
  expect(sent()).toEqual([AL, ALEX]);
  answers[1]!({ firstName: "Alex", slides: true, revision: 1002 });
  await alex;
  expect(sent()).toEqual([AL, ALEX, OFF]);
  answers[2]!({ firstName: "Alex", slides: false, revision: 1003 });
  await off;
  expect(appPrefs()).toEqual(stored("Alex", false));
});

test("serialized sets: a set called from a microtask a subscriber scheduled while an earlier set settled joins the END of the queue", async () => {
  const answers = await seededQueue(1100);
  const al = setFirstName("Al");
  const alex = setFirstName("Alex");
  let third: Promise<unknown> | undefined;
  const stop = onAppPrefsChange(() => {
    if (third === undefined) third = Promise.resolve().then(() => setSlides(false));
  });
  answers[0]!({ firstName: "Al", slides: true, revision: 1101 });
  await al;
  stop();
  await Promise.resolve();
  await Promise.resolve();
  expect(sent()).toEqual([AL, ALEX]);   // "Alex" (queued first) went out; the slides set waits behind it
  answers[1]!({ firstName: "Alex", slides: true, revision: 1102 });
  await alex;
  expect(sent()).toEqual([AL, ALEX, OFF]);
  answers[2]!({ firstName: "Alex", slides: false, revision: 1103 });
  await third;
  expect(appPrefs()).toEqual(stored("Alex", false));
});

test("serialized sets: after a REFUSED set, the next set invokes at once, two back to back are still serialized, and \"Alex\" wins", async () => {
  await seededQueue(1200);
  g.window = { __TAURI_INTERNALS__: { invoke: () => Promise.reject(TOO_LONG) } };
  expect((await setFirstName("x".repeat(41))).ok).toBe(false);
  const answers = deferredIpc();
  calls = [];
  const al = setFirstName("Al");
  const alex = setFirstName("Alex");
  expect(sent()).toEqual([AL]);   // the first goes out at once; the second waits
  await Promise.resolve();
  expect(sent()).toEqual([AL]);
  answers[0]!({ firstName: "Al", slides: true, revision: 1201 });
  await al;
  expect(sent()).toEqual([AL, ALEX]);
  answers[1]!({ firstName: "Alex", slides: true, revision: 1202 });
  await alex;
  expect(appPrefs().firstName).toBe("Alex");
});

/* ── B2-M4-T10: the GitHub links switch, the editor choices and the full refusal ────────────────── */

const KEY_A = "032fa4562bc7b051317d2a37a7291db8";
const KEY_B = "9fbb6e9f98a6074f844482cda9171850";
const PREFERENCES_FULL = "This setting could not be saved: preferences are full.";

test("the store mirrors Rust's githubLinks and editorChoices", async () => {
  handler = () => ({ slides: true, githubLinks: false, editorChoices: { [KEY_A]: "zed", [KEY_B]: "ask" } });
  await loadAppPrefs();
  expect(appPrefs()).toEqual({
    firstName: null,
    slides: true,
    githubLinks: false,
    editorChoices: { [KEY_A]: "zed", [KEY_B]: "ask" },
  });
  // A later answer replaces both, and a caller's copy never reaches the store.
  const got = appPrefs();
  got.editorChoices[KEY_B] = "cursor";
  expect(appPrefs().editorChoices[KEY_B]).toBe("ask");
  handler = () => ({ slides: true, githubLinks: true, editorChoices: {} });
  await loadAppPrefs();
  expect(appPrefs()).toEqual(stored(null, true));
});

test("setGithubLinks sends one named patch, keeps Rust's answer and tells the subscribers", async () => {
  handler = () => ({ slides: true, githubLinks: true, editorChoices: {} });
  await loadAppPrefs();
  calls = [];
  handler = () => ({ slides: true, githubLinks: false, editorChoices: { [KEY_A]: "zed" } });
  const heard: AppPrefs[] = [];
  const stop = onAppPrefsChange((p) => heard.push(p));
  try {
    expect(await setGithubLinks(false)).toEqual({ ok: true });
  } finally {
    stop();
  }
  expect(calls).toEqual([["app_prefs_set", { patch: { githubLinks: false } }]]);
  expect(appPrefs().githubLinks).toBe(false);
  expect(appPrefs().editorChoices).toEqual({ [KEY_A]: "zed" });
  expect(heard.at(-1)!.githubLinks).toBe(false);
});

test("a failed setGithubLinks leaves the value", async () => {
  handler = () => ({ slides: true, githubLinks: true, editorChoices: {} });
  await loadAppPrefs();
  handler = () => {
    throw STORE_FAILURE;
  };
  expect(await setGithubLinks(false)).toEqual({ ok: false, message: STORE_FAILURE.detail, refused: false });
  expect(appPrefs().githubLinks).toBe(true);
});

for (const [what, send] of [
  ["first name", () => setFirstName("Sam")],
  ["slides", () => setSlides(false)],
  ["GitHub links", () => setGithubLinks(false)],
] as const) {
  test(`a ${what} set refused as preferences-full answers the fixed sentence, refused, and keeps the value`, async () => {
    handler = () => ({ firstName: "Kept", slides: true, githubLinks: true, editorChoices: {} });
    await loadAppPrefs();
    handler = () => {
      throw { kind: "preferences-full" };
    };
    expect(await send()).toEqual({ ok: false, message: PREFERENCES_FULL, refused: true, full: true });
    expect(appPrefs()).toEqual(stored("Kept", true));
  });
}

/** R5-M11: the union in the store and the enum in Rust, each read as text, in B2 `:67`'s order. */
test("the editor token union equals editor.rs's token list", () => {
  const rust = readFileSync(new URL("../src-tauri/src/editor.rs", import.meta.url), "utf8");
  const store = readFileSync(new URL("../src/lib/app-prefs-store.ts", import.meta.url), "utf8");
  const enumBody = rust.match(/pub enum EditorId \{([^}]*)\}/)?.[1] ?? "";
  const unionBody = store.match(/export type EditorId =([^;]*);/)?.[1] ?? "";
  const rustTokens = [...enumBody.matchAll(/#\[serde\(rename = "([^"]+)"\)\]/g)].map((m) => m[1]);
  const unionTokens = [...unionBody.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
  const expected = [
    "vs-code", "cursor", "windsurf", "zed", "sublime-text", "xcode", "intellij-idea", "pycharm",
    "webstorm", "goland", "rustrover", "clion", "rider", "rubymine", "phpstorm", "datagrip",
  ];
  expect(rustTokens).toEqual(expected);
  expect(unionTokens).toEqual(expected);
  expect(store).toContain('export type EditorChoice = EditorId | "ask";');
  // Every variant carries a token: a variant with none would serialize under its Rust name.
  expect(enumBody.match(/^\s*[A-Z]\w*,$/gm)?.length).toBe(expected.length);
});
