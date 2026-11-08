/** B2-M5-T13/T14: pure card actions, the launchpad's copy and Resume tiles, and the chooser model. Rust grants targets;
 * this model only places held handles beside their rows. Older pages and missing/unknown live answers grant nothing.
 * No URL, path or command is constructed here.
 * B2-M6-T15: each reply code's fixed text and the click drivers the deck components inject the `engine.ts` wrappers into.
 */
import type { EditorChoice, EditorId } from "./app-prefs-store";
import type { DeckPage, SuggestionCard } from "./deck";
import type { CopyPushCommandReply, EditorChoiceSetReply, EditorListReply, EditorOpenReply, OpenGithubReply } from "./engine";
import type { ActionCard, GitHeld, LabelView, ReplyRow } from "./git-detail";
import type { Os } from "./platform";

export interface ActionsInput {
  cards: ActionCard[];
  githubLinks: boolean;
  os: Os;
  /** No entry means unknown (inventory pending/failed); null means never chosen. */
  choices: ReadonlyMap<string, EditorChoice | null>;
  /** The inventory read's fixed failure text (`actionsLive`), or null. */
  error: string | null;
}

/** G-TEXT's closed editor labels, in Rust's enum order. */
export const EDITOR_LABELS: Readonly<Record<EditorId, string>> = {
  "vs-code": "VS Code", cursor: "Cursor", windsurf: "Windsurf", zed: "Zed", "sublime-text": "Sublime Text",
  xcode: "Xcode", "intellij-idea": "IntelliJ IDEA", pycharm: "PyCharm", webstorm: "WebStorm", goland: "GoLand",
  rustrover: "RustRover", clion: "CLion", rider: "Rider", rubymine: "RubyMine", phpstorm: "PhpStorm", datagrip: "DataGrip",
};

type ActionHandle = ActionCard["handles"][number];
export interface GithubButton {
  target: "pr" | "branch" | "commit" | "compare";
  handle: string;
  label: string;
}
export interface EditorButton {
  target: "editor";
  handle: string;
  project: string;
  choice: EditorChoice | null | undefined;
  label: string;
}
export interface CopyButton {
  handles: string[];
  label: string;
  suffix: string | null;
}
export interface RowActions {
  row: number;
  button: GithubButton | null;
  /** Only commits with their own reachable target, including those behind (+N more). */
  commits: { sha: string; button: GithubButton }[];
}
export interface ResumeTile {
  /** The Where-you-left-off card's id. */
  key: string;
  /** Never `wait`: a Resume tile is not something waiting, so it cannot move the launchpad's heading. */
  state: "neutral";
  label: string;
  button: EditorButton;
}
export interface ActionsView {
  did: { key: string; rows: RowActions[] }[];
  /** `label` is the card's own display label, the only project name Resume draws. */
  leftOff: { key: string; label: string; buttons: (GithubButton | EditorButton)[]; copy: CopyButton | null }[];
  push: { key: string; copy: CopyButton }[];
  suggestions: { n: number; button: GithubButton | null }[];
  /** The `onlyHere` tile's Copy push command: its complete list or nothing. */
  tile: CopyButton | null;
  resume: ResumeTile[];
  /** The inventory's failure, while an editor control it left unknown is showing. */
  editorError: string | null;
}

function githubButton(handle: ActionHandle, on: boolean): GithubButton | null {
  if (!on) return null;
  switch (handle.target) {
    case "pr": return { target: "pr", handle: handle.handle, label: "Open PR ↗" };
    case "branch": return { target: "branch", handle: handle.handle, label: "Open branch ↗" };
    case "commit": return { target: "commit", handle: handle.handle, label: "Open on GitHub" };
    case "compare": return handle.label === null ? null : { target: "compare", handle: handle.handle, label: `Compare with ${handle.label}` };
    default: return null;
  }
}

function rowActions(row: ReplyRow, index: number, handles: ActionHandle[], on: boolean): RowActions {
  const own = handles.filter((h) => h.row === index);
  const target = row.kind === "pr" ? "pr" : ["branch", "remoteBranch", "default"].includes(row.kind) ? "branch" : null;
  const control = own.find((h) => h.target === target);
  return {
    row: index,
    button: control === undefined ? null : githubButton(control, on),
    commits: row.commits.flatMap((c) => {
      const h = own.find((h) => h.target === "commit" && h.sha === c.sha);
      const button = h === undefined ? null : githubButton(h, on);
      return button === null ? [] : [{ sha: c.sha, button }];
    }),
  };
}

/** Match only this suggestion's own live groups. Every target in the group counts, with or without a handle, and
 * repeated mentions/rows of one target count once; exactly one target, holding a handle, gets the button. An
 * ambiguous SHA prefix is never rescued by a different match. The complete group, including unlinked commits, sets
 * uniqueness. The left guards refuse another repo's reference: `other/repo#12`, `lib#12`, `other/repo@abcdef01`. They
 * would also turn `#12/#13` or `abcdef0..1234567` into one target, so a reference joined straight onto one answers null.
 */
const JOINED_REFERENCES = /(?:(?<![\w/.\-])#[1-9][0-9]*|(?<![\w#/.@\-])[0-9a-f]{7,40})(?!\w)[/.\-]+(?:#[1-9][0-9]*|[0-9a-f]{7,40})(?!\w)/i;

function suggestionButton(s: SuggestionCard, label: LabelView | undefined, handles: ActionHandle[], on: boolean): GithubButton | null {
  if (!on || s.key === null || label === undefined || JOINED_REFERENCES.test(s.text)) return null;
  const targets = new Map<string, ActionHandle | undefined>();
  for (const match of s.text.matchAll(/(?<![\w/.\-])#([1-9][0-9]*)\b/g)) {
    const number = Number(match[1]);
    label.rows.forEach((row, index) => {
      if (row.kind !== "pr" || row.number !== number) return;
      const key = `pr:${number}`;
      targets.set(key, targets.get(key) ?? handles.find((h) => h.target === "pr" && h.row === index));
    });
  }
  const commits = [...new Set(label.rows.flatMap((row) => row.commits.map((c) => c.sha)))];
  for (const match of s.text.matchAll(/(?<![\w#/.@\-])[0-9a-f]{7,40}(?![\w])/gi)) {
    const prefix = match[0].toLowerCase();
    const found = commits.filter((sha) => sha.toLowerCase().startsWith(prefix));
    if (found.length > 1) return null;
    const sha = found[0];
    if (sha === undefined) continue;
    targets.set(`commit:${sha}`, handles.find((h) => h.target === "commit" && h.sha === sha && h.row !== null && label.rows[h.row]?.commits.some((c) => c.sha === sha)));
  }
  if (targets.size !== 1) return null;
  const [handle] = targets.values();
  return handle === undefined ? null : githubButton(handle, on);
}

/** `held` supplies B1's groups and live branch state. `input.cards` is Today's immediately replaced action carrier. */
export function actionsView(page: DeckPage, input: ActionsInput, held: GitHeld | null): ActionsView {
  const out: ActionsView = { did: [], leftOff: [], push: [], suggestions: [], tile: null, resume: [], editorError: null };
  if (page.stale || held === null) return out;
  const reply = held.reply;
  const current = new Set(reply.repoViews.filter((v) => v.state === "ok" && !Object.hasOwn(held.asOf.repos, v.key)).map((v) => v.key));
  const hasRemote = (key: string): boolean => reply.repoViews.some((v) => v.key === key && v.state === "ok" && !v.noRemote);
  const cardsFor = (kind: ActionCard["cardKind"], id: string): ActionCard[] => input.cards.filter((c) => c.cardKind === kind && c.cardId === id && current.has(c.repoKey));
  const liveLabel = (key: string): LabelView | undefined => reply.labels.find((l) => l.key === key && l.state === "ok" && l.repoKey !== null && current.has(l.repoKey) && hasRemote(l.repoKey) && !Object.hasOwn(held.asOf.labels, key));
  const didHandles = (label: LabelView): ActionHandle[] => cardsFor("did", label.key).filter((c) => c.repoKey === label.repoKey).flatMap((c) => c.handles);
  const copy = (handles: ActionHandle[]): CopyButton | null => {
    const targets = handles.filter((h) => h.target === "copy" && h.row === null).map((h) => h.handle);
    return targets.length === 0 ? null : { handles: targets, label: "Copy push command", suffix: input.os === "windows" ? "for Git Bash" : null };
  };

  for (const card of page.whatYouDid.cards) {
    const label = liveLabel(card.key);
    if (label === undefined || (card.commits === 0 && !label.rows.some((row) => row.commits.some((c) => c.token === null)))) continue;
    const handles = didHandles(label);
    out.did.push({ key: card.key, rows: label.rows.map((row, i) => rowActions(row, i, handles, input.githubLinks)) });
  }
  for (const card of page.leftOff.cards) {
    if (card.branch?.kind !== "branch" || Object.hasOwn(held.asOf.labels, card.key)) continue;
    const name = card.branch.name;
    const line = reply.branchLines.find((b) => b.key === card.key && b.name === name);
    if (line === undefined || line.state === "missing") continue;
    const cards = cardsFor("leftOff", card.key);
    if (cards.length === 0) continue;
    const remote = line.state === "live" && cards.every((c) => hasRemote(c.repoKey));
    const handles = cards.flatMap((c) => c.handles).filter((h) => h.row === null);
    const buttons: (GithubButton | EditorButton)[] = [];
    for (const target of ["branch", "compare", "editor"] as const) {
      const h = handles.find((h) => h.target === target);
      if (h === undefined) continue;
      if (h.target === "editor") {
        if (input.os !== "macos" || h.project === null) continue;
        const choice = input.choices.get(h.project);
        const label = choice === undefined || choice === null || choice === "ask" ? "Open in editor…" : `Open in ${EDITOR_LABELS[choice]}`;
        buttons.push({ target: "editor", handle: h.handle, project: h.project, choice, label });
      } else {
        const button = githubButton(h, input.githubLinks && remote);
        if (button !== null) buttons.push(button);
      }
    }
    out.leftOff.push({ key: card.key, label: card.label, buttons, copy: remote && line.state === "live" && (line.neverPushed || line.notPushed > 0) ? copy(handles) : null });
  }
  for (const card of reply.pushCards) {
    if (!hasRemote(card.repoKey) || !current.has(card.repoKey)) continue;
    const key = `push:${card.repoKey}`;
    const button = copy(cardsFor("push", key).filter((c) => c.repoKey === card.repoKey).flatMap((c) => c.handles));
    if (button !== null) out.push.push({ key, copy: button });
  }
  out.suggestions = page.suggested.cards.map((s) => {
    const label = s.key === null ? undefined : liveLabel(s.key);
    return { n: s.n, button: suggestionButton(s, label, label === undefined ? [] : didHandles(label), input.githubLinks) };
  });
  out.tile = tileCopy(input.cards.filter((c) => c.cardKind === "tile" && c.cardId === "onlyHere"), held, current, hasRemote, copy);
  out.resume = resumeTiles(out, held, input.os);
  if (out.leftOff.some((card) => card.buttons.some((b) => b.target === "editor"))) out.editorError = input.error;
  return out;
}

/**
 * The launchpad tile's Copy push command (B2 :46): the push cards' complete branch list or nothing, never a partial one.
 * `mergeReply` keeps a held-over repo's push card and tile share but drops its handles, so the handles alone would make
 * a shorter list look whole. Every repo that could contribute must be current, as B1's push time reads it: a stale
 * checkout whose store a current checkout answers contributes nothing of its own. Handles are opaque, so "complete" is
 * one held handle for each distinct store and local branch the cards list, which is what Rust mints.
 */
function tileCopy(
  cards: ActionCard[],
  held: GitHeld,
  current: ReadonlySet<string>,
  hasRemote: (key: string) => boolean,
  copy: (handles: ActionHandle[]) => CopyButton | null,
): CopyButton | null {
  const reply = held.reply;
  if (reply.tile.commits === 0) return null;
  const answered = new Set(reply.repoViews.flatMap((v) => (v.state === "ok" && current.has(v.key) ? [v.storeKey] : [])));
  const heldOver = reply.repoViews.some((v) => v.state !== "noRepos" && !v.noRemote && !current.has(v.key) && (v.storeKey === null || !answered.has(v.storeKey)));
  if (heldOver || !reply.pushCards.every((c) => current.has(c.repoKey) && hasRemote(c.repoKey))) return null;
  if (!cards.every((c) => current.has(c.repoKey))) return null;
  const listed = new Set(reply.pushCards.flatMap((c) => [...c.branches, ...(c.onDefault === null ? [] : [c.onDefault])].map((b) => JSON.stringify([c.storeKey, b.name]))));
  const button = copy(cards.flatMap((c) => c.handles));
  return button?.handles.length === listed.size ? button : null;
}

/** At most this many Resume tiles, after B1's tiles and its overflow line; they take none of B1's slots (B2 :47). */
export const RESUME_TILE_CAP = 3;

/**
 * Today's Resume tiles (B2 :45, :47): macOS only, one per Where-you-left-off project with an editor target, in `view`'s
 * card order, the first 3 eligible. `held` is B1's live state: a card whose branch line is missing or absent (which
 * covers Detached HEAD, never asked about) or held over has no tile. They stay out of B1's tiles (`launchpadTiles`), so
 * they cannot move its heading, its cap or its overflow line.
 */
export function resumeTiles(view: Pick<ActionsView, "leftOff">, held: GitHeld | null, os: Os): ResumeTile[] {
  if (os !== "macos" || held === null) return [];
  const out: ResumeTile[] = [];
  const projects = new Set<string>();
  for (const card of view.leftOff) {
    if (out.length === RESUME_TILE_CAP) break;
    const button = card.buttons.find((b): b is EditorButton => b.target === "editor");
    if (button === undefined || projects.has(button.project) || Object.hasOwn(held.asOf.labels, card.key)) continue;
    if (!held.reply.branchLines.some((b) => b.key === card.key && b.state !== "missing")) continue;
    projects.add(button.project);
    out.push({ key: card.key, state: "neutral", label: `Resume · ${card.label} · ${button.label}`, button });
  }
  return out;
}

/* ── the chooser model (B2 :71-73). T15's `EditorChooser` draws it; the key is always the handle's, never derived here. ── */

/** A click launches directly only on a stored editor without ⌥. `undefined` (not known yet) never launches. */
export function editorClick(choice: EditorChoice | null | undefined, option: boolean): { kind: "choose" } | { kind: "launch"; editor: EditorId } {
  return option || choice === undefined || choice === null || choice === "ask" ? { kind: "choose" } : { kind: "launch", editor: choice };
}

/** A remembered editor since removed: the launch's own refusal reopens the chooser (inventory replies drop the list). */
export function reopensChooser(reply: EditorOpenReply): boolean {
  return "refused" in reply && reply.refused === "no-editor";
}

export type ChooserView =
  | { state: "choose"; editors: { editor: EditorId; label: string }[]; selected: EditorId; remember: boolean }
  | { state: "failed"; message: string };

/**
 * The chooser from the clicked handle's `editor_list`. Its project row is newer than the published `known`, and settles
 * an unknown. "Always use this for this project" starts checked only for a project known to be never chosen (`null`):
 * `"ask"`, a stored editor asked again and a still-unknown choice all start unchecked, so nothing stored is replaced
 * without a tick. The preselection only highlights an installed editor.
 */
export function chooserView(reply: EditorListReply, project: string, known: EditorChoice | null | undefined): ChooserView {
  if ("failed" in reply) return { state: "failed", message: "Could not list installed editors" };
  if ("refused" in reply) return { state: "failed", message: reply.refused === "unsupported" ? "Opening an editor is only available on macOS." : "This work has changed since this briefing." };
  const first = reply.editors[0];
  if (first === undefined) return { state: "failed", message: "No supported editor installed" };
  const row = reply.projects.find((p) => p.project === project);
  const preselect = reply.editors.find((e) => e.editor === reply.preselect);
  return { state: "choose", editors: reply.editors, selected: (preselect ?? first).editor, remember: (row === undefined ? known : row.choice) === null };
}

/** G-TEXT's `editor_choice_set` rows; null when the save landed. */
export function choiceRefusalText(reply: EditorChoiceSetReply): string | null {
  if ("saved" in reply) return null;
  if ("failed" in reply) return "Could not save editor choice";
  switch (reply.refused) {
    case "unsupported": return "Opening an editor is only available on macOS.";
    case "stale": return "This project has changed since this briefing.";
    case "unknown-editor": return "Choose a supported editor.";
    case "preferences-full": return "Editor choices could not be saved: preferences are full.";
  }
}

/**
 * The chooser's answer, in order (Q-M6). Ticked: save first, publish a landed save, then launch once. A refused or failed
 * save still launches once with the chosen editor: the stored choice stays as it was, and `saveLine` is that code's fixed
 * row. Unticked: no save, one launch. A wrapper that throws is its fixed failure, so no error text can reach the screen.
 */
export async function chooseAndOpen(
  answer: { handle: string; project: string; editor: EditorId; remember: boolean },
  deps: {
    editorChoiceSet: (project: string, editor: EditorChoice) => Promise<EditorChoiceSetReply>;
    editorOpen: (handle: string, editor: EditorId) => Promise<EditorOpenReply>;
    applySaved: (project: string, choice: EditorChoice) => void;
  },
): Promise<{ saveLine: string | null; open: EditorOpenReply }> {
  let saveLine: string | null = null;
  if (answer.remember) {
    let saved: EditorChoiceSetReply;
    try {
      saved = await deps.editorChoiceSet(answer.project, answer.editor);
    } catch {
      saved = { failed: "preferences" };
    }
    saveLine = choiceRefusalText(saved);
    if ("saved" in saved) {
      try {
        deps.applySaved(answer.project, answer.editor);
      } catch {
        // The save landed; only this screen's copy is behind, and the launch below still runs once.
      }
    }
  }
  try {
    return { saveLine, open: await deps.editorOpen(answer.handle, answer.editor) };
  } catch {
    return { saveLine, open: { failed: "editor" } };
  }
}

/* ── B2-M6-T15: each reply's fixed text (§0's table; nothing from a reply is interpolated) and the click drivers. ── */

const STALE_WORK = "This work has changed since this briefing.";
const NOT_CHECKED = "This repository has not been checked.";
const MACOS_ONLY = "Opening an editor is only available on macOS.";

/** `open_github`'s fixed row; null when it opened. */
export function githubReplyText(reply: OpenGithubReply): string | null {
  if ("opened" in reply) return null;
  if ("failed" in reply) return "Could not open GitHub";
  switch (reply.refused) {
    case "stale": return STALE_WORK;
    case "links-off": return "GitHub links are off.";
    case "unknown-repo": return NOT_CHECKED;
    case "not-pushed": return "This work is not on GitHub yet.";
    case "invalid-target": return "This GitHub target is unavailable.";
    case "ambiguous": return "This work has more than one possible GitHub destination.";
    case "host": return "This repository does not have a supported GitHub link.";
  }
}

/** `copy_push_command`'s local status (B2 :108): a refusal is the fixed heading, then that code's explanation. */
export function copyReplyLines(reply: CopyPushCommandReply): string[] {
  if ("copied" in reply) return ["Copied"];
  if ("copiedToOrigin" in reply) return ["Copied. Pushes to origin."];
  if ("failed" in reply) return ["Could not copy push command"];
  return ["Push command unavailable for this work", copyRefusalText(reply.refused)];
}

function copyRefusalText(code: Extract<CopyPushCommandReply, { refused: unknown }>["refused"]): string {
  switch (code) {
    case "stale": return STALE_WORK;
    case "unknown-repo": return NOT_CHECKED;
    case "unsafe-name": return "A push command cannot be copied safely for this work.";
    case "no-remote": return "This work has no push destination.";
    case "ambiguous": return "The push destination could not be established.";
    case "name-mismatch": return "This branch pushes to a differently named branch; push it yourself";
    case "transport": return "This push destination isn't one the app can copy a command for.";
  }
}

/** `editor_open`'s fixed row; null when it opened. */
export function editorOpenText(reply: EditorOpenReply): string | null {
  if ("opened" in reply) return null;
  if ("failed" in reply) return "Could not open editor";
  switch (reply.refused) {
    case "unsupported": return MACOS_ONLY;
    case "stale": return STALE_WORK;
    case "no-editor": return "No supported editor installed";
    case "invalid-folder": return "This project folder is unavailable.";
  }
}

/** The last GitHub or copy answer on a component's own buttons. `key` is the button's stable key, never a handle: a full
 *  check re-mints every handle, and a refusal is what sets one off, so a line under a handle would vanish as it arrives. */
export interface ActionLine {
  key: string;
  lines: string[];
}

/** The stable key of one of a card's several buttons. */
export const actionKey = (card: string, what: string): string => `${card}\0${what}`;

/** The answer's lines when it is on one of this card's buttons (`actionKey`). */
export const lineOf = (answer: ActionLine | null, card: string): string[] => (answer !== null && answer.key.startsWith(`${card}\0`) ? answer.lines : []);

/** What `ACTIONS_PAGE` reports: the briefing, and whether it has gone stale, because the day can roll over with no new page.
 *  A chooser left open then would still send, and a line would sit beside buttons that have gone. `null` is no page. */
export function actionsPageKey(briefing: string | null, stale: boolean): string | null {
  return briefing === null ? null : `${briefing}\0${stale ? "stale" : "today"}`;
}

/**
 * What a component's stable-keyed lines and flow do when the briefing changes: `clear` runs on a new page key, since every
 * slide stays mounted and a stable key would carry a line onto the new page, or beside a button that now works. A key held
 * since the first is not a change, and `null` is not a page (`git-live.ts`'s rule): a read error and the same page back keeps
 * them. The key is the page's, so a full check on one page still keeps a refusal under its button, as `ActionLine` needs.
 */
export function onNewPage(clear: () => void): (key: string | null) => void {
  let shown: string | null = null;
  return (key) => {
    if (key === null || key === shown) return;
    if (shown !== null) clear();
    shown = key;
  };
}

/** How long a successful copy's line stays. It reports one moment, and the facts behind it can change while the page stays
 *  open, even taking the button away. A refusal or a failure stays: it says why nothing was copied. */
export const COPIED_LINE_MS = 8_000;

const afterMs = (ms: number, fire: () => void): (() => void) => {
  const id = setTimeout(fire, ms);
  return () => clearTimeout(id);
};

/**
 * One component's GitHub and copy clicks. A wrapper that throws is its fixed failure, so no error text can reach the
 * screen; a repeat while one is outstanding sends nothing, so one activation is one browser tab. The call sites pass
 * the literal wrapper. `announce` is Today's one live region (`ACTIONS_ANNOUNCE`). `reset` is a new page: the line goes, and
 * an answer still outstanding says nothing there. `timer` is a parameter so the tests can fire it.
 */
export function actionRuns(publish: (line: ActionLine | null) => void, announce: (text: string) => void, timer: (ms: number, fire: () => void) => () => void = afterMs): {
  github: (key: string, handle: string, openGithub: (handle: string) => Promise<OpenGithubReply>) => Promise<void>;
  copy: (key: string, handles: string[], copyPushCommand: (handles: string[]) => Promise<CopyPushCommandReply>) => Promise<void>;
  reset: () => void;
} {
  let running = new Set<string>();
  let cancelFade = (): void => {};
  // Every line goes through here, so a fade only ever takes the line it was set for.
  function say(line: ActionLine | null): void {
    cancelFade();
    cancelFade = () => {};
    publish(line);
  }
  async function run(key: string, call: () => Promise<string[]>, fades: () => boolean = () => false): Promise<void> {
    if (running.has(key)) return;
    const mine = running;
    mine.add(key);
    say(null);
    const lines = await call();
    mine.delete(key);
    if (mine !== running) return;
    say(lines.length === 0 ? null : { key, lines });
    if (lines.length > 0) announce(lines.join(": "));
    if (lines.length > 0 && fades()) cancelFade = timer(COPIED_LINE_MS, () => say(null));
  }
  return {
    reset() {
      running = new Set();
      say(null);
    },
    github: (key, handle, openGithub) => run(key, async () => {
      try {
        const text = githubReplyText(await openGithub(handle));
        return text === null ? [] : [text];
      } catch {
        return [githubReplyText({ failed: "opener" })!];
      }
    }),
    copy: (key, handles, copyPushCommand) => {
      let copied = false;
      return run(key, async () => {
        try {
          const reply = await copyPushCommand(handles);
          copied = "copied" in reply || "copiedToOrigin" in reply;
          return copyReplyLines(reply);
        } catch {
          return copyReplyLines({ failed: "clipboard" });
        }
      }, () => copied);
    },
  };
}

/** What a component with editor controls draws, under this card's control. A card and a project, never a handle: a full
 *  check re-mints every handle, and that must not close a chooser mid-choice. */
export interface EditorFlowState {
  card: string | null;
  project: string | null;
  chooser: Extract<ChooserView, { state: "choose" }> | null;
  /** The fixed line of the list or the launch. */
  line: string | null;
  /** The chooser's refused save (`chooseAndOpen`). It stays while a `no-editor` launch reopens the chooser. */
  saveLine: string | null;
  busy: boolean;
}
export const EDITOR_FLOW_IDLE: EditorFlowState = { card: null, project: null, chooser: null, line: null, saveLine: null, busy: false };

/** The current handles' button for a project, for Open to send: what was clicked may have been re-minted since. */
export function liveEditorButton(buttons: readonly (GithubButton | EditorButton)[], project: string | null): EditorButton | null {
  return buttons.find((b): b is EditorButton => b.target === "editor" && b.project === project) ?? null;
}

/**
 * One component's editor controls (B2 :71-73). Every launch, direct or from the chooser, goes through `chooseAndOpen`;
 * a list that throws is `{failed: "detection"}`. The chooser is closed before anything is sent and nothing is sent while
 * busy, so a double activation of Open launches once. Open sends the handle of `live`, the card's button as it is now; with
 * none it sends the clicked one, which Rust no longer holds and so answers `stale`. `reset` is a new page: the chooser and
 * the lines go, and an answer still outstanding says nothing there and reopens nothing.
 */
export function editorFlow(deps: {
  editorList: (handle: string) => Promise<EditorListReply>;
  editorOpen: (handle: string, editor: EditorId) => Promise<EditorOpenReply>;
  editorChoiceSet: (project: string, editor: EditorChoice) => Promise<EditorChoiceSetReply>;
  applySaved: (project: string, choice: EditorChoice) => void;
  publish: (state: EditorFlowState) => void;
  announce: (text: string) => void;
}): { click: (card: string, button: EditorButton, option: boolean) => void; open: (editor: EditorId, remember: boolean, live?: EditorButton | null) => void; cancel: () => void; reset: () => void } {
  let state = EDITOR_FLOW_IDLE;
  /** Moves on at `reset`: an answer to an earlier page's call finds it changed. */
  let page = 0;
  const set = (patch: Partial<EditorFlowState>): void => { state = { ...state, ...patch }; deps.publish(state); };
  const say = (...lines: (string | null)[]): void => {
    const text = lines.filter((l) => l !== null).join(" ");
    if (text !== "") deps.announce(text);
  };

  async function choose(button: EditorButton): Promise<void> {
    const mine = page;
    let reply: EditorListReply;
    try {
      reply = await deps.editorList(button.handle);
    } catch {
      reply = { failed: "detection" };
    }
    if (mine !== page) return;
    const view = chooserView(reply, button.project, button.choice);
    set(view.state === "choose" ? { chooser: view, line: null, busy: false } : { chooser: null, line: view.message, busy: false });
    if (view.state !== "choose") say(view.message);
  }
  async function launch(button: EditorButton, editor: EditorId, remember: boolean): Promise<void> {
    const mine = page;
    const { saveLine, open } = await chooseAndOpen({ handle: button.handle, project: button.project, editor, remember }, deps);
    if (mine !== page) return;
    if (reopensChooser(open)) {
      set({ saveLine });
      say(saveLine);
      await choose(button);
    } else {
      const line = editorOpenText(open);
      set({ line, saveLine, busy: false });
      say(saveLine, line);
    }
  }

  let target: EditorButton | null = null;
  return {
    click(card, button, option) {
      if (state.busy) return;
      target = button;
      const step = editorClick(button.choice, option);
      set({ card, project: button.project, chooser: null, line: null, saveLine: null, busy: true });
      void (step.kind === "launch" ? launch(button, step.editor, false) : choose(button));
    },
    open(editor, remember, live) {
      if (state.busy || state.chooser === null || target === null) return;
      target = live ?? target;
      set({ chooser: null, busy: true });
      void launch(target, editor, remember);
    },
    cancel() {
      if (state.busy) return;
      target = null;
      state = EDITOR_FLOW_IDLE;
      deps.publish(state);
    },
    reset() {
      page += 1;
      state = EDITOR_FLOW_IDLE;
      deps.publish(state);
    },
  };
}
