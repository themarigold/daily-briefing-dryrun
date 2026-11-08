/** B2-M5-T13: Today's per-mount editor inventory. Pure of Tauri: the literal wrapper is injected by Today.
 * Only mount and a changed set of editor project keys read inventory. Same-turn triggers coalesce; each trigger
 * invalidates choices synchronously. New handles for the same keys do not reread. A save is laid over any reply to a
 * read sent before it, so a slow pre-save read cannot restore an old remembered launch and still answers for every other
 * project. A read queued but not yet sent is kept: it goes out after the save and answers for every project. A save
 * leaves an inventory error in place, since it makes only its own project known.
 *
 * B2-M6-T16: `editorLinksLive`, Settings' own per-mount driver for Editor & links (P-M8). Its IPC wrappers and setter are
 * injected too; the switch's value is the app-prefs store's (`appPrefs` / `onAppPrefsChange`), so it holds no second copy.
 */
import { choiceRefusalText } from "./actions";
import { appPrefs, onAppPrefsChange, type AppPrefsSetOutcome, type EditorChoice, type EditorId } from "./app-prefs-store";
import type { EditorChoiceSetReply, EditorListReply, EditorProjectRow } from "./engine";
import type { ActionCard } from "./git-detail";
import type { Os } from "./platform";

export interface ActionsLiveState {
  choices: ReadonlyMap<string, EditorChoice | null>;
  error: string | null;
}
export interface ActionsLive {
  mount(): void;
  onActions(cards: ActionCard[]): void;
  applySaved(project: string, choice: EditorChoice): void;
  dispose(): void;
  state(): ActionsLiveState;
}
/** T15: Today's `applySaved`, reaching the chooser by CONTEXT rather than a prop through DeckOrClassic (`CALENDAR_STALE`'s rule). */
export const ACTIONS_SAVED: unique symbol = Symbol("actions-saved");
export type ActionsSaved = ActionsLive["applySaved"];
/** Today's one live region, for a click's result line: a slide can go `inert`, and nothing there holds an `aria-live`. */
export const ACTIONS_ANNOUNCE: unique symbol = Symbol("actions-announce");
export type ActionsAnnounce = (line: string) => void;
/** Today's page (`actionsPageKey`), read through this so a component can clear its stable-keyed lines when the page changes or goes stale (`onNewPage`). */
export const ACTIONS_PAGE: unique symbol = Symbol("actions-page");
export type ActionsPage = () => string | null;

export function actionsLive(deps: { os: Os; editorList: () => Promise<EditorListReply>; publish: (state: ActionsLiveState) => void }): ActionsLive {
  let mounted = false;
  let disposed = false;
  let sequence = 0;
  let queued = false;
  let keys = new Set<string>();
  let state: ActionsLiveState = { choices: new Map(), error: null };
  /** Saved since the current read was sent: that read cannot know them. */
  const savedSinceSent = new Map<string, EditorChoice>();
  const publish = (next: ActionsLiveState): void => { state = next; deps.publish(next); };

  function refresh(): void {
    if (!mounted || disposed || deps.os !== "macos") return;
    sequence++;
    publish({ choices: new Map(), error: null });
    if (queued) return;
    queued = true;
    queueMicrotask(async () => {
      if (!queued || disposed) return;
      queued = false;
      const sent = sequence;
      savedSinceSent.clear();
      const fail = (error: string): void => {
        if (!disposed && sent === sequence) publish({ choices: new Map(savedSinceSent), error });
      };
      try {
        const reply = await deps.editorList();
        if (disposed || sent !== sequence) return;
        if ("editors" in reply) {
          publish({ choices: new Map([...reply.projects.flatMap((p) => p.project === null ? [] : [[p.project, p.choice] as const]), ...savedSinceSent]), error: null });
        } else {
          fail("refused" in reply ? reply.refused === "unsupported" ? "Opening an editor is only available on macOS." : "This work has changed since this briefing." : "Could not list installed editors");
        }
      } catch {
        fail("Could not list installed editors");
      }
    });
  }
  return {
    mount() { if (mounted || disposed) return; mounted = true; refresh(); },
    onActions(cards) {
      if (disposed) return;
      const next = new Set(cards.flatMap((c) => c.handles.flatMap((h) => h.target === "editor" && h.project !== null ? [h.project] : [])));
      if (next.size === keys.size && [...next].every((key) => keys.has(key))) return;
      keys = next;
      refresh();
    },
    applySaved(project, choice) {
      if (disposed || deps.os !== "macos") return;
      savedSinceSent.set(project, choice);
      const choices = new Map(state.choices);
      choices.set(project, choice);
      publish({ choices, error: state.error });
    },
    dispose() { disposed = true; queued = false; sequence++; },
    state: () => state,
  };
}

/** What Editor & links draws in its editors region. `idle`: off macOS, or before the first read. */
export type EditorLinksView =
  | { state: "idle" }
  | { state: "loading" }
  | { state: "failed" }
  | { state: "ready"; editors: { editor: EditorId; label: string }[]; projects: EditorProjectRow[]; discoveryConfigured: boolean };
export interface EditorLinksLine {
  ok: boolean;
  text: string;
}
export interface EditorLinksState {
  githubLinks: boolean;
  linksBusy: boolean;
  linksLine: EditorLinksLine | null;
  editors: EditorLinksView;
  choiceLines: ReadonlyMap<string, EditorLinksLine>;
}
export interface EditorLinksLive {
  open(): void;
  setLinks(on: boolean): Promise<void>;
  setChoice(project: string, choice: EditorChoice): Promise<void>;
  dispose(): void;
  state(): EditorLinksState;
}

const LINKS_FULL = "This setting could not be saved: preferences are full.";
const LINKS_FAILED = "Could not save the GitHub links setting.";

/**
 * Reads on opening the page and once after a landed choice; a links save reads nothing, since `editor_list` carries no
 * links value. A newer read drops an older reply, so a read sent before a save landed cannot restore the old choice.
 * Rows stay drawn during a re-read: `loading` would remove the select that has the focus. Saves go one at a time, in call
 * order, as `app-prefs-store`'s do, because two commands sent together could commit in either order; a queued save still
 * goes after dispose, since the user made it, and only its publish and re-read are dropped.
 */
export function editorLinksLive(deps: {
  os: Os;
  editorList: () => Promise<EditorListReply>;
  editorChoiceSet: (project: string, editor: EditorChoice) => Promise<EditorChoiceSetReply>;
  setGithubLinks: (on: boolean) => Promise<AppPrefsSetOutcome>;
  publish: (state: EditorLinksState) => void;
}): EditorLinksLive {
  let disposed = false;
  let sequence = 0;
  let saves: Promise<void> = Promise.resolve();
  let state: EditorLinksState = { githubLinks: appPrefs().githubLinks, linksBusy: false, linksLine: null, editors: { state: "idle" }, choiceLines: new Map() };
  const publish = (next: Partial<EditorLinksState>): void => { state = { ...state, ...next }; deps.publish(state); };
  const stop = onAppPrefsChange((prefs) => publish({ githubLinks: prefs.githubLinks }));

  async function read(): Promise<void> {
    const sent = ++sequence;
    if (state.editors.state !== "ready") publish({ editors: { state: "loading" } });
    let view: EditorLinksView = { state: "failed" };
    try {
      const reply = await deps.editorList();
      if ("editors" in reply) view = { state: "ready", editors: reply.editors, projects: reply.projects, discoveryConfigured: reply.discoveryConfigured };
    } catch {
      // The fixed failure: no thrown text reaches the screen.
    }
    if (sent === sequence) publish({ editors: view });
  }

  function withLine(project: string, line: EditorLinksLine | null): ReadonlyMap<string, EditorLinksLine> {
    const lines = new Map(state.choiceLines);
    if (line === null) lines.delete(project);
    else lines.set(project, line);
    return lines;
  }

  async function save(project: string, choice: EditorChoice): Promise<void> {
    let reply: EditorChoiceSetReply;
    try {
      reply = await deps.editorChoiceSet(project, choice);
    } catch {
      reply = { failed: "preferences" };
    }
    if (disposed) return;
    const text = choiceRefusalText(reply);
    if (text !== null) {
      publish({ choiceLines: withLine(project, { ok: false, text }) });
      return;
    }
    const view = state.editors;
    publish({
      // Cleared here too: an earlier queued save's refusal can land after this save's own call cleared the line.
      choiceLines: withLine(project, null),
      editors: view.state === "ready" ? { ...view, projects: view.projects.map((p) => (p.project === project ? { ...p, choice } : p)) } : view,
    });
    void read();
  }

  return {
    open() {
      if (disposed) return;
      if (deps.os !== "macos") publish({ editors: { state: "idle" } });
      else void read();
    },
    async setLinks(on) {
      if (disposed || state.linksBusy) return;
      publish({ linksBusy: true, linksLine: null });
      let line: EditorLinksLine | null = null;
      try {
        const outcome = await deps.setGithubLinks(on);
        if (!outcome.ok) line = { ok: false, text: outcome.full === true ? LINKS_FULL : LINKS_FAILED };
      } catch {
        line = { ok: false, text: LINKS_FAILED };
      }
      if (!disposed) publish({ linksBusy: false, linksLine: line });
    },
    setChoice(project, choice) {
      if (disposed || deps.os !== "macos") return Promise.resolve();
      publish({ choiceLines: withLine(project, null) });
      saves = saves.then(() => save(project, choice));
      return saves;
    },
    dispose() { disposed = true; sequence++; stop(); },
    state: () => state,
  };
}
