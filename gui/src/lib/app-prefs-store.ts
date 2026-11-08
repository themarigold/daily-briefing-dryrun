/**
 * A-M1-T2 — the app's own preferences, as the webview holds them (redesign A spec, "The slides switch" and "First
 * name"): the first name (used only in the greeting), the slides switch and (B2-M4-T10) the GitHub links switch and
 * each project's editor choice. Module-level state, the pattern of `keepSettings` in `settings-model.ts`, because Today
 * unmounts on every route change.
 *
 * ⚠ THE STORE IS RUST'S (`src-tauri/src/app_prefs.rs`, `app-prefs.json` under the app's data folder). Validation of
 * the name lives there, the one copy; this module sends what the user typed and keeps what Rust answers. It is not
 * part of the config draft, and the first name is never sent to the engine or the AI.
 *
 * "Loaded" means SETTLED: when `app_prefs_get` itself fails, the defaults stand (name unset, slides and links on, no
 * editor choices) — unless an
 * answer with a revision is already held (post-cap L4: the values Rust gave stay) — the failure is kept for the Settings
 * rows' one line, and `loadAppPrefs()` still resolves, so Today mounts as usual.
 *
 * Round-1 M1: a reader that must FOLLOW the values (Today) subscribes with `onAppPrefsChange`, and hears every value
 * the store settles on (a load, a set that succeeded). A set still in flight when Today mounted (the user typed a name
 * on Settings and went straight to Today) then changes the greeting and the mode when it lands, not at a remount.
 *
 * SETTLED (round-3 M1, round-4 M3): `appPrefsSettled()` is true once a load has finished and while NO load and NO set
 * is in flight, so the Settings rows wait for it (as Today waits for the load), and a Settings visit reopened while an
 * earlier visit's set is still in flight draws the rows only once it lands. Every time it turns true the subscribers
 * hear it (round-4 L4), even when the answer that ended the wait was dropped, so a waiting gate never stays waiting.
 *
 * THE NEWEST ANSWER WINS. Each answer is the whole store. Sets go one at a time, in call order (the queue below), so
 * two sets never cross; only a set and the one load (startup's `app_prefs_get`) can be in flight together and arrive in
 * either order. Rust numbers its writes under the store's mutex (`revision`, in every answer; round-4 L1), and an answer
 * with a LOWER revision than one already kept is dropped: the backstop for that crossing.
 */
import { invoke } from "@tauri-apps/api/core";

/** The supported editors: `src-tauri/src/editor.rs`'s `EditorId`, in its order. `app-prefs.check.ts` pins the two lists
 *  equal. */
export type EditorId =
  | "vs-code"
  | "cursor"
  | "windsurf"
  | "zed"
  | "sublime-text"
  | "xcode"
  | "intellij-idea"
  | "pycharm"
  | "webstorm"
  | "goland"
  | "rustrover"
  | "clion"
  | "rider"
  | "rubymine"
  | "phpstorm"
  | "datagrip";

/** What a project can have stored: an editor, or ask each time. "Never chosen" is no entry. */
export type EditorChoice = EditorId | "ask";

export interface AppPrefs {
  /** `null` = unset: the greeting is "Good morning". */
  firstName: string | null;
  /** Show the briefing as slides. On unless the user turned it off. */
  slides: boolean;
  /** Show the buttons that open checked work on GitHub. On unless the user turned it off. */
  githubLinks: boolean;
  /** Each project's stored editor choice, by its opaque project key, as of the last set or load: `editor_choice_set`
   *  writes these in Rust and does not pass through this store, so this mirror is stale until the next set or load.
   *  Read choices from `editor_list` (R2-O6), not from here. */
  editorChoices: Record<string, EditorChoice>;
}

/** What both commands answer (`app_prefs.rs`'s `AppPrefsAnswer`): `firstName` is absent while unset; `revision` is the
 *  store's write count this session. Rust always sends `githubLinks` and `editorChoices`. (A fake with no revision — test
 *  fakes — is kept, and orders nothing; a fake with neither B2 value reads as their defaults.) */
interface AppPrefsWire {
  firstName?: string;
  slides: boolean;
  githubLinks?: boolean;
  editorChoices?: Record<string, EditorChoice>;
  revision?: number;
}

export const APP_PREFS_DEFAULTS: Readonly<AppPrefs> = Object.freeze({
  firstName: null,
  slides: true,
  githubLinks: true,
  editorChoices: Object.freeze({}),
});

/** A copy that shares nothing with the store: the choice map is copied too. */
function copyOf(prefs: Readonly<AppPrefs>): AppPrefs {
  return { ...prefs, editorChoices: { ...prefs.editorChoices } };
}

/** A set's answer: the row shows "saved" or the message, inline. `refused`: Rust refused the VALUE (`invalidInput`, or
 *  `preferences-full`: the file has no room for it, which `full` says), so sending it again changes nothing; otherwise the
 *  store itself failed, and the same value may be retried. */
export type AppPrefsSetOutcome = { ok: true } | { ok: false; message: string; refused: boolean; full?: true };

let current: AppPrefs = copyOf(APP_PREFS_DEFAULTS);
let loadFailure = "";
const listeners = new Set<(prefs: AppPrefs) => void>();
/** The highest revision kept; null while none is. */
let newestRevision: number | null = null;
/** A load has finished at least once, and how many loads and sets are in flight now. */
let loadedOnce = false;
let inFlight = 0;

/**
 * The store's one write, when a load or set ends: keep `answer` unless one with a higher revision was kept already
 * (`null`: a failed load, which leaves the defaults unless a revision is held, or a failed set, which changes nothing),
 * then tell every subscriber —
 * when something was kept, or when the store has just become settled. Each subscriber gets its own copy.
 */
function finish(answer: AppPrefsWire | null, isLoad: boolean): void {
  inFlight--;
  if (isLoad) loadedOnce = true;
  let kept = false;
  if (answer === null) {
    // A failed LOAD: the defaults — unless Rust already answered with a revision, whose values stay (post-cap L4; the
    // failure is still recorded). A failed SET changes no value.
    if (isLoad && newestRevision === null) {
      current = copyOf(APP_PREFS_DEFAULTS);
      kept = true;
    }
  } else if (answer.revision === undefined || newestRevision === null || answer.revision >= newestRevision) {
    if (answer.revision !== undefined) newestRevision = answer.revision;
    current = {
      firstName: answer.firstName ?? null,
      slides: answer.slides,
      githubLinks: answer.githubLinks ?? APP_PREFS_DEFAULTS.githubLinks,
      editorChoices: { ...answer.editorChoices },
    };
    kept = true;
  }
  if (kept || appPrefsSettled()) for (const listener of [...listeners]) listener(copyOf(current));
}

/** Hear every value the store settles on from now (a load, a successful set), and every time it becomes settled; a
 *  refused or failed set changes no value. Returns the unsubscribe. */
export function onAppPrefsChange(listener: (prefs: AppPrefs) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The fixed sentence for `app_prefs_set`'s `preferences-full` refusal. */
const PREFERENCES_FULL = "This setting could not be saved: preferences are full.";

/** One sentence for a rejection from either command. Plain text. A refusal of the name carries the sentence the
 *  Settings row shows (`app_prefs.rs`'s `FIRST_NAME_*`); the size bound's is a code, mapped here, never shown raw. */
function describeAppPrefsFailure(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (typeof e === "object" && e !== null) {
    const tagged = e as Record<string, unknown>;
    if (tagged.kind === "invalidInput" && typeof tagged.reason === "string") return tagged.reason;
    if (tagged.kind === "store" && typeof tagged.detail === "string") return tagged.detail;
    if (tagged.kind === "preferences-full") return PREFERENCES_FULL;
  }
  return JSON.stringify(e);
}

/** Read the store once (App, at mount). Never rejects: a failed read leaves the defaults and records why. */
export async function loadAppPrefs(): Promise<void> {
  inFlight++;
  let answer: AppPrefsWire | null;
  try {
    answer = await invoke<AppPrefsWire>("app_prefs_get");
    loadFailure = "";
  } catch (e) {
    loadFailure = describeAppPrefsFailure(e);
    answer = null;
  }
  finish(answer, true);
}

/** A load has finished (a failed one too: the defaults stand) and no load or set is in flight. */
export function appPrefsSettled(): boolean {
  return loadedOnce && inFlight === 0;
}

/** The current values (a copy). */
export function appPrefs(): AppPrefs {
  return copyOf(current);
}

/** Why the last load failed, or "" when it did not. */
export function appPrefsLoadFailure(): string {
  return loadFailure;
}

/**
 * SETS GO ONE AT A TIME, IN CALL ORDER (serialized sets): each waits for the previous set to settle, success or failure,
 * before it invokes `app_prefs_set`. Tauri runs async commands as separate tasks, so two sets sent together could commit
 * in either order — a name flushed on unmount ("Alex") could land before the save still pending ("Al") and lose to it.
 * Queued, Rust's revisions rise in call order and the newest change wins; the revision check stays as a backstop. A
 * queued set counts as in flight from the moment it is called, so `appPrefsSettled()` waits for the whole queue. The one
 * load (App's mount) is not queued.
 */
let setQueue: Promise<void> = Promise.resolve();
/** Sets called and not yet settled: with none, a new set invokes at once (no wait at all). */
let setsQueued = 0;

async function set(
  patch: { firstName: string } | { slides: boolean } | { githubLinks: boolean },
): Promise<AppPrefsSetOutcome> {
  inFlight++;
  const previous = setsQueued > 0 ? setQueue : null;
  setsQueued++;
  let release: () => void = () => {};
  setQueue = new Promise<void>((resolve) => (release = resolve));
  if (previous !== null) await previous;
  try {
    let answer: AppPrefsWire;
    try {
      answer = await invoke<AppPrefsWire>("app_prefs_set", { patch });
    } catch (e) {
      finish(null, false);
      const kind = typeof e === "object" && e !== null ? (e as Record<string, unknown>).kind : undefined;
      const refused = kind === "invalidInput" || kind === "preferences-full";
      return { ok: false, message: describeAppPrefsFailure(e), refused, ...(kind === "preferences-full" ? { full: true as const } : {}) };
    }
    finish(answer, false);
    return { ok: true };
  } finally {
    setsQueued--;
    release();
  }
}

/** Save the first name as typed; Rust trims it, and an empty one unsets it. */
export function setFirstName(value: string): Promise<AppPrefsSetOutcome> {
  return set({ firstName: value });
}

/** Turn the slides on or off. */
export function setSlides(on: boolean): Promise<AppPrefsSetOutcome> {
  return set({ slides: on });
}

/** Turn the GitHub links on or off. */
export function setGithubLinks(on: boolean): Promise<AppPrefsSetOutcome> {
  return set({ githubLinks: on });
}
