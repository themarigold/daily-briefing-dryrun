/**
 * Redesign D — Settings as a sidebar of seven pages: the pure page logic.
 *
 * Which page a field is on, which pages are changed or need a look, the JSON editor's leave guard, and the page a
 * mount opens. Pure: no Svelte, no IPC. `tests-web` renders on the server only, with no DOM and no events, so this
 * is where the sidebar's behaviour is tested (`tests-web/settings-pages.check.ts`; hub testing rule 4).
 *
 * The draft and the save path stay in `routes/Settings.svelte`; this module only reads them.
 */
import type { UninstallReport } from "../app-uninstall";
import type { ConfigDocument, SaveOutcome } from "../files";
import { isObject, plain, readProviderList } from "../provider-list";
import {
  fieldIsLive,
  getPath,
  isDirty,
  jsonEqual,
  liveErrors,
  parseDraft,
  readField,
  SECTIONS,
  TEST_FAILED_PREFIX,
  TOOL_ROW_FIELDS,
  type ConfigPage,
  type Draft,
  type Field,
  type ProvidersView,
} from "../settings-model";

/* ── the pages ─────────────────────────────────────────────────────────────────────────────────── */

export type PageId = ConfigPage | "calendar" | "editor" | "about";

export interface PageDef {
  id: PageId;
  label: string;
  /** Drawn after the sidebar's "More" divider. */
  more: boolean;
  /** Not drawn in the sidebar. None is since B2-M6-T16 gave Editor & links its content. */
  hidden: boolean;
  /** The line under the page's title (the S-A mockup's), or "" for none. About's is its version, which AboutPage
   *  draws from its own prop. */
  lead: string;
  /** Replaces `lead` off macOS, for a page that says so. */
  leadOffMacos?: string;
}

/** The sidebar, in order: seven entries, a "More" divider before the last two. */
export const PAGES: readonly PageDef[] = [
  { id: "general", label: "General", more: false, hidden: false, lead: "When your briefing arrives and how it reaches you." },
  { id: "projects", label: "Projects", more: false, hidden: false, lead: "Which work goes into your briefing." },
  {
    id: "providers",
    label: "AI providers",
    more: false,
    hidden: false,
    lead: "Who writes your briefing. The first one that works is used; the rest are fallbacks.",
  },
  // The mockup's "Details are read live and never saved." is left out: the briefing file itself lists the meetings.
  { id: "calendar", label: "Calendar", more: false, hidden: false, lead: "Show today's meetings in your briefing." },
  {
    id: "editor",
    label: "Editor & links",
    more: false,
    hidden: false,
    lead: "Choose how projects open and whether GitHub links are shown.",
    leadOffMacos: "Opening an editor is only available on macOS.",
  },
  // "Most": the page also holds the Terminal command and the JSON editor, which are not about the AI.
  { id: "advanced", label: "Advanced", more: true, hidden: false, lead: "You should not need these. Most change how the engine talks to the AI." },
  { id: "about", label: "About & uninstall", more: true, hidden: false, lead: "" },
];

/** What a config page (Projects, AI providers, Advanced) shows instead of its form when the config cannot be loaded
 *  (a read failure, no file, a file that is not a JSON object). General shows the reason itself. */
export const CONFIG_UNAVAILABLE_LINE = "The settings file cannot be shown here: General says why.";

/** What each place holding config fields shows while the JSON editor is open (`tab === "raw"`): the fields stay
 *  mounted but hidden, so no form edit can be overwritten when the text is parsed back. Advanced shows the editor. */
export const RAW_TAB_LINE = "The JSON editor is open on Advanced. Finish or leave it there first.";

/** The config's state as the pages draw it: loaded and shown, still loading, or not loadable (General says why). */
export type ConfigState = "ready" | "loading" | "unavailable";

/** The config's state from the shell's own (`loadFailure`, the document, the draft), for the pages and the shell
 *  alike. Unavailable: a read failure, no file, a parse error, or a file that is JSON but not an object (no draft). */
export function configState(loadFailure: string, doc: ConfigDocument | null, draft: Draft | null): ConfigState {
  if (loadFailure !== "") return "unavailable";
  if (doc === null) return "loading";
  return !doc.exists || doc.parseError !== null || draft === null ? "unavailable" : "ready";
}

/** General's attention dot: the config failed to load — unavailable for any reason but a missing file (which the
 *  Setup wizard creates, and is not a failure). */
export function configLoadFailed(loadFailure: string, doc: ConfigDocument | null, draft: Draft | null): boolean {
  if (loadFailure !== "") return true;
  return doc !== null && doc.exists && configState(loadFailure, doc, draft) === "unavailable";
}

/** The pages in `marked`, in the sidebar's order. */
function inOrder(marked: ReadonlySet<PageId>): PageId[] {
  return PAGES.filter((p) => marked.has(p.id)).map((p) => p.id);
}

/* ── which page is changed ─────────────────────────────────────────────────────────────────────── */

/** What `changedPages` and `saveBarShown` read: the screen's config state, and nothing else. App preferences and
 *  apply-at-once controls are not inputs, so they can never mark a page or show the bar. */
export interface ChangeInput {
  tab: "form" | "raw";
  /** The config text as loaded (`config_read`), or `null` before the config is loaded. */
  loadedText: string | null;
  draft: Draft | null;
  /** The JSON editor's text. */
  raw: string;
  /** A provider Add or Replace is pending: running, or waiting for its own Save or Discard. */
  flowPending: boolean;
  /** Round 9 (L6): per path (its keys joined by "."), the page whose field last wrote it since the draft was drawn
   *  (`writtenBy`). Absent: each path marks the page that owns it. */
  writtenOn?: Readonly<Record<string, ConfigPage>> | undefined;
}

/**
 * Round 9 (L6): the paths a field's write sets, each with the page the user made it on — the field's own section's
 * page. Most fields write their own path only. The Tool choice (`kind: "tool"`) also writes `argv` and `promptVia`,
 * which Advanced draws, and Other's two rows (`TOOL_ROW_FIELDS`, drawn under the Tool choice) write `provider.cli` and
 * `provider.argv`: those edits were made on AI providers, so that is the page they mark (`changedPages`). An edit
 * made on Advanced's own `provider.argv` field afterwards writes "advanced" over it, so a real Advanced edit is never
 * hidden.
 *
 * Round 10 (L1): given the draft before and after the write (`was`, `now`), only the paths whose value CHANGED are
 * marked — choosing "Other…" writes nothing, and a named tool keeps the arguments it already had, so neither moves an
 * earlier Advanced edit's mark to AI providers. Without them, every path the field can write.
 */
export function writtenBy(field: Field, was?: Draft, now?: Draft): Record<string, ConfigPage> {
  const tool = SECTIONS.find((s) => s.fields.some((f) => f.kind === "tool"));
  const page: ConfigPage | undefined = TOOL_ROW_FIELDS.includes(field) ? tool?.page : SECTIONS.find((s) => s.fields.includes(field))?.page;
  if (page === undefined) return {};
  const block = field.path.slice(0, -1);
  const paths = field.kind === "tool" ? [field.path, [...block, "argv"], [...block, "promptVia"]] : [field.path];
  const moved = (p: string[]): boolean => was === undefined || now === undefined || !jsonEqual(getPath(was, p), getPath(now, p));
  return Object.fromEntries(paths.filter(moved).map((p) => [p.join("."), page]));
}

/** The providers list's own paths: the list editor changes these, so they belong to AI providers whatever the
 *  model says (`provider-list.ts`; `provider.api.apiKey` is what the stored-key notice removes). */
const LIST_PATHS: readonly (readonly string[])[] = [
  ["provider", "label"],
  ["provider", "accounts"],
  ["provider", "configDir"],
  ["fallbacks"],
  ["provider", "api", "apiKey"],
];

/** Every path some page owns, with its page: the list's paths, then each model field's. */
const OWNED: readonly { path: readonly string[]; page: ConfigPage }[] = [
  ...LIST_PATHS.map((path) => ({ path, page: "providers" as const })),
  ...SECTIONS.flatMap((s) => s.fields.map((f) => ({ path: f.path, page: s.page }))),
];

const startsWith = (path: readonly string[], prefix: readonly string[]): boolean =>
  prefix.length <= path.length && prefix.every((k, i) => path[i] === k);

/** The paths at which `a` and `b` differ as JSON values: two objects are compared key by key; anything else (an
 *  array, a scalar, or an object against something that is not one) differs or not as a whole. */
function diffPaths(a: unknown, b: unknown, path: string[], out: string[][]): void {
  if (isObject(a) && isObject(b)) {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) diffPaths(a[k], b[k], [...path, k], out);
  } else if (!jsonEqual(a, b)) {
    out.push(path);
  }
}

/** The providers list's entries as the list shows them — labels, order and login folders — or `null` when the list
 *  cannot be read. */
function listShape(d: Draft): string | null {
  const read = readProviderList(plain(d));
  return read.ok ? JSON.stringify(read.entries.map((e) => [e.label, e.configDir ?? null])) : null;
}

/** `input` as the `KeptSettings` shape `isDirty` reads (its `base` and `errors` play no part there). */
const asKept = (input: ChangeInput, loadedText: string) => ({
  base: "",
  loadedText,
  tab: input.tab,
  draft: input.draft,
  raw: input.raw,
  errors: {},
});

/**
 * The pages with an edit not yet saved, in the sidebar's order (D spec, "Which page is changed"). Compared with
 * `parseDraft(loadedText)`, never `base` (the conflict token).
 *
 * - Form tab: a model field that differs marks its section's page, `provider.*` fields on Advanced included; the
 *   list's own paths, and a pending Add or Replace, mark AI providers. When the list's entries differ (a move or a
 *   removal of row 1 replaces `provider` wholesale), every `provider.*` difference is AI providers'. A container
 *   that differs as a whole marks the pages of the fields below it. A difference at a path no field owns
 *   (`transcripts`, `verdictPaths`, `recapCampaigns`, `calendar`, an unknown key) marks Advanced.
 * - JSON editor open: only Advanced can be marked, and only when `isDirty`'s raw branch says the text changed.
 */
export function changedPages(input: ChangeInput): PageId[] {
  if (input.loadedText === null) return [];
  if (input.tab === "raw") return isDirty(asKept(input, input.loadedText)) ? ["advanced"] : [];
  const marked = new Set<PageId>();
  if (input.flowPending) marked.add("providers");
  const loaded = parseDraft(input.loadedText);
  const draft = input.draft;
  if (draft !== null && loaded !== null) {
    const listMoved = listShape(draft) !== listShape(loaded);
    const paths: string[][] = [];
    diffPaths(plain(draft), loaded, [], paths);
    for (const p of paths) {
      if (listMoved && p[0] === "provider") {
        marked.add("providers");
        continue;
      }
      // No owned path lies inside another, so at most one owns `p`.
      const owner = OWNED.find((o) => startsWith(p, o.path));
      if (owner !== undefined) {
        // Round 9 (L6): the page the user wrote it on, when a field on another page wrote it last (`writtenBy`).
        marked.add(input.writtenOn?.[owner.path.join(".")] ?? owner.page);
        continue;
      }
      // A container that differs as a whole (added, removed, left `{}` after a field was typed and cleared, or
      // replaced by another type) belongs to the pages of the fields below it; Advanced only when none.
      const below = OWNED.filter((o) => startsWith(o.path, p));
      if (below.length === 0) marked.add("advanced");
      for (const o of below) marked.add(o.page);
    }
  }
  return inOrder(marked);
}

/** Is the save bar shown? When the draft, or the JSON editor's text, differs from what was loaded — `isDirty`, as
 *  today's whole-draft test. A pending Add or Replace alone does not show it: its Save and Discard are its own.
 *  Only over a config the pages show (`config` ready): a draft kept from an earlier visit over a file that has since
 *  become unreadable, or a reload that failed under an edit, shows no Save; General says why, and its Reload or Try
 *  again is the way out. */
export function saveBarShown(input: ChangeInput, config: ConfigState): boolean {
  return config === "ready" && input.loadedText !== null && isDirty(asKept(input, input.loadedText));
}

/* ── which page needs a look ───────────────────────────────────────────────────────────────────── */

/** The pages holding a save-blocking live field error (`liveErrors`), in the sidebar's order: the save bar names
 *  them as buttons that open the page. (Round 11, M1: row 1's tool rows never hold one — `fieldEdited`.) */
export function blockedPages(draft: Draft | null, errors: Record<string, string>): PageId[] {
  if (draft === null) return [];
  const live = liveErrors(draft, errors);
  return inOrder(new Set(SECTIONS.filter((s) => s.fields.some((f) => live[f.id] !== undefined)).map((s) => s.page)));
}

/* ── which fields are drawn again ───────────────────────────────────────────────────────────────── */

/**
 * Final round 3 (R3-M1, R3-M2; replaces round 2's one shared `formEpoch`): the fields whose input may show something
 * the draft does not hold, and how often each was drawn again. A value the form refuses is never written into the
 * draft, so its input still shows the typed text, and Svelte does not rewrite an input whose value prop did not
 * change. Where the shell resets the errors (a load: Discard, Reload, after a save; the JSON editor left), each MARKED
 * field is drawn again from the draft and the marks are cleared. `SettingsForm` keys every field on its own count, so a
 * field the user is typing in is drawn again — destroying its input and the text in it — only when it is itself
 * marked; and a reload the user did not ask for (a Calendar write, the engine-notify offer) neither draws a marked
 * field again nor clears its error (post-cap, R5-H1: `backgroundReloadApplies`), so it never touches one.
 */
export interface Redraw {
  /** The marked fields' ids, in the order they were marked. */
  pending: string[];
  /** Per field id, how many times it was drawn again (absent: never). */
  count: Record<string, number>;
}

export const NO_REDRAW: Redraw = { pending: [], count: {} };

const marked = (r: Redraw, id: string): Redraw => (r.pending.includes(id) ? r : { pending: [...r.pending, id], count: r.count });

/** `onfield`'s answer for field `id`: refused, it is marked; taken, its input shows what the draft now holds, so its
 *  mark goes. */
export function redrawAfterField(r: Redraw, id: string, refused: boolean): Redraw {
  if (refused) return marked(r, id);
  return r.pending.includes(id) ? { pending: r.pending.filter((p) => p !== id), count: r.count } : r;
}

/** The engine-default toggle on field `id`. Final round 4 (R4-M1): its list is drawn again from the draft AT ONCE
 *  (SettingsForm keys it on the toggle) and the box shows the draft's state, so the field shows what the draft holds:
 *  its mark goes, as for a value taken. (Round 3 marked it, and then a reload landing after a tick and an untick drew
 *  the list again under the user typing in it.) */
export function redrawAfterDefault(r: Redraw, id: string): Redraw {
  return redrawAfterField(r, id, false);
}

/**
 * Post-cap (R5-H1, codex R5-M1; replaces round 4's `backgroundReloadWaits`): a reload the user did not ask for (the
 * Calendar's write, the engine-notify offer) compares the screen when it is asked (`asked`) and again when its read
 * has answered (`now`). It draws what it read only when, at both moments, the form and the JSON editor hold no unsaved
 * edit and no save is in flight, and nothing was typed or refused in between. A field still showing a value the form
 * refused does NOT hold it back: the shell's background path keeps every error and mark as they are and draws no field
 * again, so a field the user is correcting keeps its input, focus and text (R4-M2), while the rest of the screen shows
 * the file. Otherwise the reload is owed, not lost (`owedReloadRuns`).
 */
export interface ScreenStamp {
  /** The form or the JSON editor holds an unsaved edit (`isDirty`). */
  editing: boolean;
  /** A save is in flight. */
  saving: boolean;
  /** The edit as it stands: the tab, then the draft's JSON or the editor's text. */
  text: string;
  /** The marked fields (`Redraw.pending`). */
  marked: readonly string[];
}

export function backgroundReloadApplies(asked: ScreenStamp, now: ScreenStamp): boolean {
  const quiet = (s: ScreenStamp): boolean => !s.editing && !s.saving;
  return quiet(asked) && quiet(now) && asked.text === now.text && asked.marked.join("\n") === now.marked.join("\n");
}

/** An owed background reload runs as soon as the draft is clean again (a save landed, a Discard, or edits that bring
 *  it back to the file) and no save is in flight — and, final small fix (F3, delta MED 1), never while the JSON editor
 *  is open (`tab === "raw"`): the editor's text is bound per keystroke, so a keystroke that made it equal the file ran
 *  the reload, which rewrote the text under the caret. It runs when the editor is left (the tab back to the form), or a
 *  save or a Discard pays it. */
export function owedReloadRuns(owed: boolean, now: { editing: boolean; saving: boolean; tab: "form" | "raw" }): boolean {
  return owed && !now.editing && !now.saving && now.tab === "form";
}

/**
 * Final small fix (F1, codex and cold): whether a load makes the user's resets — each marked field drawn again, the
 * errors cleared. A load the user asked for (Discard, Reload) does. The reload after a save that LANDED makes none: the
 * form's Save and the provider flows refuse while a field shows a refused value, so a mark on screen when a save lands
 * was made while it was in flight (or stands beside a clean draft, as before a key action, which does not read the
 * form), and it stays with its text and its error. Drawing that field again lost the text and the focus, and in
 * Chromium the teardown fired `change`, re-marking it with a stale error under a valid value that blocked the next Save.
 */
export function loadResets(landed: boolean): boolean {
  return !landed;
}

/** Final small fix (codex MED 2, high-rigor L4, delta L5): whether a reload is still owed once a user load has drawn
 *  what it read. A load reads the latest file, so it pays what is owed — unless a background reload was asked (the
 *  Calendar's or the engine-notify offer's write, or an owed one run; the shell counts them as `backgroundReload`
 *  starts) after its read started: the file it drew may predate that write, so the reload is still owed (at worst one
 *  read more). `stillOwed`: owed for the load's own reason (a kept edit on the text sent). */
export function owedAfterLoad(stillOwed: boolean, asksAtRead: number, asksNow: number): boolean {
  return stillOwed || asksNow !== asksAtRead;
}

/** A reset of the errors: each marked field's count goes up by one (and only theirs), and the marks are cleared. */
export function redrawAfterReset(r: Redraw): Redraw {
  if (r.pending.length === 0) return r;
  const count = { ...r.count };
  for (const id of r.pending) count[id] = (count[id] ?? 0) + 1;
  return { pending: [], count };
}

/* ── round 10 (M1), round 11 (M1): row 1's tool rows ───────────────────────────────────────────── */

/** The fields drawn as row 1's tool: the Tool choice, and Other's command and arguments under it. */
export const TOOL_FIELD_IDS: readonly string[] = [
  ...SECTIONS.flatMap((s) => s.fields).filter((f) => f.kind === "tool").map((f) => f.id),
  ...TOOL_ROW_FIELDS.map((f) => f.id),
];

/** Round 11 (L2): every field drawn as row 1's own setting — each whose path is under `provider` (the Tool and Account
 *  on AI providers; the arguments, prompt passing, hardening, timeout and the API fields on Advanced). */
export const ROW_ONE_FIELD_IDS: readonly string[] = SECTIONS.flatMap((s) => s.fields)
  .filter((f) => f.path[0] === "provider")
  .map((f) => f.id);

/** Row 1 as the providers list names it — its label — or `null` (no draft, or a list that cannot be read). */
export function firstRowLabel(draft: Draft | null): string | null {
  if (draft === null) return null;
  const read = readProviderList(plain(draft));
  return read.ok ? (read.entries[0]?.label ?? null) : null;
}

/** Round 11 (M1): the note under the tool control whose value was just refused — the control's field id and the
 *  refusal's sentence. Round 12: stamped when it was born (`NoteStamp`). */
export interface ToolNote {
  id: string;
  text: string;
  /** Round 12 (M1): the user's gesture it was born in — the shell counts every pointer press and key press. */
  seq: number;
  /** Round 12 (L1): row 1's logins (`provider.accounts`) when it was born, as JSON (`accountsKey`). */
  accounts: string;
}

/** Round 12: what a note is stamped with when it is born (`fieldEdited`): the gesture and row 1's logins. */
export interface NoteStamp {
  seq: number;
  accounts: string;
}

/** Round 12 (L1): row 1's logins as JSON — the condition a tool refusal names ("… has a login folder"). */
export function accountsKey(draft: Draft): string {
  return JSON.stringify(getPath(draft, ["provider", "accounts"]) ?? null);
}

/** The stamp for a note born now, in gesture `seq`, over `draft`. */
export function noteStamp(draft: Draft, seq: number): NoteStamp {
  return { seq, accounts: accountsKey(draft) };
}

/** The tool rows' own state, kept by the shell: the row 1 they are drawn for (`firstRowLabel`), whether "Other…" was
 *  chosen on it, and (round 11, M1) the note under the tool control whose value was just refused, or `null`. */
export interface ToolRows {
  label: string | null;
  other: boolean;
  note: ToolNote | null;
}
export const NO_TOOL_ROWS: ToolRows = { label: null, other: false, note: null };

/** The form's state that a field edit moves: the errors, the marks (`Redraw`) and the tool rows. */
export interface FieldMarks {
  errors: Record<string, string>;
  redraw: Redraw;
  tool: ToolRows;
}

/**
 * Round 11 (M1; replaces rounds 9 and 10's tool-row errors) — what an edit of `field` to `value` leaves, given what
 * `writeField` answered (`refused`: why not, or `null`: written). THE RULE THAT MAKES THE CLASS IMPOSSIBLE: a refused
 * value on row 1's tool controls (the Tool choice, Other's command and arguments: `TOOL_FIELD_IDS`) NEVER enters
 * `errors`. A refused value is never written, so the draft holds nothing that needs Save to wait: there is no error to
 * hide, to strand on another row, or to outlive the text it was about. Instead the control shows the draft again (the
 * form puts the draft's value back into it, `SettingsForm`) and the refusal's sentence is a note under it (`note`), which
 * blocks nothing. The note goes with the next edit of a tool control, a row 1 change (`toolRowsAfter`), the user's
 * load (Discard, Reload) and a save that lands (`toolRowsAfterSave`). A value taken closes nothing and opens "Other…" as
 * chosen: the Tool choice's own value, or a typed command or argument (which keeps Other open even when the result reads
 * as a named tool). Every other field keeps the old rule: a refused value is an error, and its input is marked.
 * Round 12: a note is stamped with when it was born (`born`: the gesture, row 1's logins — `toolRowsAfterSave`,
 * `toolRowsDrawn`).
 */
export function fieldEdited(marks: FieldMarks, field: Field, value: string, refused: string | null, born: NoteStamp): FieldMarks {
  if (TOOL_FIELD_IDS.includes(field.id)) {
    const tool: ToolRows =
      refused !== null
        ? { ...marks.tool, note: { id: field.id, text: refused, ...born } }
        : { ...marks.tool, other: field.kind === "tool" ? value === "other" : true, note: null };
    return { ...marks, tool };
  }
  return { errors: { ...marks.errors, [field.id]: refused ?? "" }, redraw: redrawAfterField(marks.redraw, field.id, refused !== null), tool: marks.tool };
}

/** What a tool control shows (round 11, M1): the draft's tool — the named one its command, arguments and prompt passing
 *  match, else "Other…" — or "Other…" while the user has chosen it on the current row 1 (`other`). Other's command and
 *  arguments show the draft's (`readField`). */
export function toolShown(draft: Draft, field: Field, other: boolean): string {
  return field.kind === "tool" && other ? "other" : readField(draft, field);
}

/** Round 11 (M1, the delta reviewer's LOW): after a save that LANDED, the note goes, and "Other…" stays chosen only while
 *  the user is typing in the tool rows (`typing`: the focus is in one of them) — else the Tool shows the saved file's
 *  tool, so "Other…" is never left open over a file whose tool is a named one.
 *
 *  Round 12 (M1): only a note born BEFORE the gesture that sent the save goes (`sent`: that gesture, the shell's count
 *  when Save was pressed). A note born in that gesture or after it stays — a refused command typed in Other's row and
 *  then Save clicked: the click's press moved the focus, the field's `change` refused the command, and the save the same
 *  click sent did not carry it, so the note is the user's only sign of that — and while it is under one of Other's rows,
 *  "Other…" stays open with it, so it stays drawn (`toolRowsDrawn`). */
export function toolRowsAfterSave(rows: ToolRows, typing: boolean, sent: number): ToolRows {
  const note = rows.note !== null && rows.note.seq >= sent ? rows.note : null;
  const onOther = note !== null && TOOL_ROW_FIELDS.some((f) => f.id === note.id);
  return { ...rows, other: (rows.other && typing) || onOther, note };
}

/** The Tool choice (`kind: "tool"`), row 1's. */
const TOOL_FIELD: Field | undefined = SECTIONS.flatMap((s) => s.fields).find((f) => f.kind === "tool");

/**
 * Round 12 (L1): the note only while it describes something on screen. It goes when its control stops being drawn —
 * row 1 is no command-line tool any more (no Tool choice), or, for a note under Other's command or arguments, Other's
 * rows are not shown (`toolShown`: the draft's tool reads as a named one again and "Other…" is not chosen) — so it never
 * comes back with them later; and when row 1's logins (`provider.accounts`) are not what they were when it was born, so
 * it never outlives the condition it names (a login's folder cleared, a login removed or added). A page change or a
 * closed row does not draw the form's rows differently, and keeps it. `rows` itself when nothing changes.
 */
export function toolRowsDrawn(draft: Draft | null, rows: ToolRows): ToolRows {
  const note = rows.note;
  if (note === null) return rows;
  const drawn =
    draft !== null &&
    TOOL_FIELD !== undefined &&
    fieldIsLive(draft, TOOL_FIELD) &&
    (note.id === TOOL_FIELD.id || toolShown(draft, TOOL_FIELD, rows.other) === "other") &&
    accountsKey(draft) === note.accounts;
  return drawn ? rows : { ...rows, note: null };
}

/** Fields `ids` drawn again from the draft and their errors cleared, TOGETHER: each one that carries an error or is
 *  marked (`Redraw.pending`: its input may show a value the draft does not hold) has its count go up and its mark go,
 *  and its error is cleared — so no input keeps a refused text whose error is gone, and no error stays on an input
 *  drawn afresh. The inputs are unchanged. */
export function resetFields(
  errors: Readonly<Record<string, string>>,
  redraw: Redraw,
  ids: readonly string[],
): { errors: Record<string, string>; redraw: Redraw } {
  const hit = ids.filter((id) => (errors[id] ?? "") !== "" || redraw.pending.includes(id));
  if (hit.length === 0) return { errors: { ...errors }, redraw };
  const count = { ...redraw.count };
  for (const id of hit) count[id] = (count[id] ?? 0) + 1;
  const out = { ...errors };
  for (const id of hit) if (out[id] !== undefined) out[id] = "";
  return { errors: out, redraw: { pending: redraw.pending.filter((id) => !hit.includes(id)), count } };
}

/**
 * Round 10 (M1; replaces round 9's three separate clearings) — ONE rule for row 1's own settings: the "Other…" choice,
 * the tool rows' note (round 11, M1) and — round 11 (L2) — every row 1 field's error and what its input shows
 * (`ROW_ONE_FIELD_IDS`: Advanced's arguments, hardening, timeout and API fields too) belong to ROW 1 AS THE LIST NAMES IT
 * (`firstRowLabel`). When another provider becomes row 1 — a move or a removal puts it on top, a load draws a file whose
 * row 1 is another — they reset together (`resetFields`, Other closed, the note gone), so an error never sits on the
 * next row 1 for the outgoing one's value. An edit that keeps row 1 — its login folder, a backup moved, a background
 * reload of the same file — keeps them as they are. `null`: row 1 is the same, nothing changes. (The user's own resets —
 * Discard, Reload, the JSON editor left — clear every error and draw every marked field again already; the shell closes
 * Other and drops the note with them.)
 */
export function toolRowsAfter(
  prev: ToolRows,
  label: string | null,
  errors: Readonly<Record<string, string>>,
  redraw: Redraw,
): { rows: ToolRows; errors: Record<string, string>; redraw: Redraw } | null {
  if (label === prev.label) return null;
  return { rows: { label, other: false, note: null }, ...resetFields(errors, redraw, ROW_ONE_FIELD_IDS) };
}

/* ── where a user action's result is shown ───────────────────────────────────────────────────────── */

/**
 * Final round 3 (R3-M3, R3-M4; replaces round 2's SaveBar flags): ONE request, from the shell, for where the result
 * of what the user just did is shown, numbered so that each request is acted on exactly once — an identical second
 * result too — and nothing stays armed. Only a user's action asks (the bar's Save and Discard, the Add and Replace
 * flows' own Saves, a refused page change), never a background reload; SettingsPages acts on each new number.
 *
 * - `outcome`: the outcome area (under the bar) is scrolled into view. It also takes the focus when `focus` is true,
 *   or when the action left the focus on no control — the pressed button disabled while it ran, or gone.
 * - `field`: the open page's first marked field is scrolled into view whole — its control and its error (final small
 *   fix, F4) — and its control takes the focus.
 * - `title`: the open page's title takes the focus and is scrolled into view — unless the user moved the focus to
 *   another control meanwhile (`revealTakesFocus`, final round 4).
 */
export type RevealTarget = "outcome" | "field" | "title";
export interface Reveal {
  seq: number;
  target: RevealTarget;
  focus: boolean;
  /** Final round 4 (R4-M6): a provider flow's Save, which may wait (a briefing holding the run lock: 15 s a try) —
   *  and, post-cap (R5-M5), the bar's Save — when it was pressed (`performance.now()`): the request acts only if the
   *  user has not pressed, typed or scrolled since (`revealStillWanted`). */
  since?: number;
}
export const NO_REVEAL: Reveal = { seq: 0, target: "title", focus: false };

/** What asked: the bar's Save or Discard, a provider flow's own Save, a page change refused (the JSON editor left
 *  with text that is not an object), the bar's "fix the marked fields on <page>" (final round 4, R4-M7). */
export type RevealAction = "save" | "discard" | "flow-save" | "refused-page" | "fix-page";

/** Where, and when, the user pressed a provider flow's Save (R4-M6) or the bar's Save (post-cap, R5-M5). */
export interface Pressed {
  page: PageId;
  at: number;
}

/** The outcome area shows something: the one test SaveBar draws it by, and the shell reveals it by. */
export function hasOutcome(o: { outcome: SaveOutcome | null; failure: string; keyLines: readonly string[]; judgeLine: string | null }): boolean {
  return o.outcome !== null || o.failure !== "" || o.keyLines.length > 0 || o.judgeLine !== null;
}

/**
 * Where `action`'s result is shown, from the screen after it: the open page, the pages holding a save-blocking field
 * (`blockedPages`, as the bar names them), and whether the outcome area shows anything. `null`: nothing to show.
 * - a Discard: the title (the reload cleared the outcome);
 * - the bar's Save refused for a marked field on the open page: that field (a scroll to the page's bottom took it out
 *   of view); any other result: the outcome; nothing at all to show: the title. Post-cap (R5-M5): given where it was
 *   `pressed` (the shell always gives it), nothing when the user is on another page now, else stamped with the press
 *   (`since`), as a flow's Save is;
 * - a flow's Save, a refused page change: the outcome, or nothing — never the focus taken from where it is. A flow's
 *   Save given where it was `pressed` (the shell always gives it, R4-M6): nothing when the user is on another page
 *   now, else the outcome stamped with the press (`since`);
 * - the bar's "fix the marked fields on <page>" (R4-M7): that page's first marked field (its title when none is drawn).
 */
export function revealFor(
  action: RevealAction,
  here: { page: PageId; blocked: readonly PageId[]; outcomeShown: boolean; pressed?: Pressed | undefined },
): Omit<Reveal, "seq"> | null {
  if (action === "discard") return { target: "title", focus: true };
  if (action === "fix-page") return { target: "field", focus: true };
  if (action === "save") {
    if (here.pressed !== undefined && here.pressed.page !== here.page) return null;
    const since = here.pressed === undefined ? {} : { since: here.pressed.at };
    if (here.blocked.includes(here.page)) return { target: "field", focus: true, ...since };
    return here.outcomeShown ? { target: "outcome", focus: false, ...since } : { target: "title", focus: true, ...since };
  }
  if (action === "flow-save" && here.pressed !== undefined) {
    if (here.pressed.page !== here.page || !here.outcomeShown) return null;
    return { target: "outcome", focus: false, since: here.pressed.at };
  }
  return here.outcomeShown ? { target: "outcome", focus: false } : null;
}

/** R4-M6: a request stamped `since` (a flow's Save) stands only while the user has done nothing since the press —
 *  `lastInput`, the last pointer press, key or wheel (`performance.now()`, SettingsPages). Otherwise neither the view
 *  nor the focus moves: the outcome area is a polite live region, so the result is still announced. */
export function revealStillWanted(r: Reveal, lastInput: number): boolean {
  return r.since === undefined || lastInput <= r.since;
}

/** Where the focus is when a request acts: on nothing (the body), on a disabled control (the pressed button while its
 *  step ran), inside the save dock (the bar's own buttons), or on anything else. */
export type FocusAt = "nothing" | "disabled" | "dock" | "elsewhere";

/** Whether a request for `target` moves the focus there (`asked`: the request's `focus`):
 *  - the outcome: when asked, or when the action left the focus on nothing or a disabled control (final round 3);
 *  - the title (final round 4, R4-L1; a Discard's, or a refused Save's whose marked field is not drawn): only from
 *    nothing, a disabled control or the dock — never from a control the user moved to while a slow Discard ran;
 *  - the marked field: always (the bar's refused Save, or its fix button, answered at once). */
export function revealTakesFocus(target: RevealTarget, asked: boolean, at: FocusAt): boolean {
  if (target === "field") return true;
  if (target === "title") return at !== "elsewhere";
  return asked || at === "nothing" || at === "disabled";
}

/** A box's top and bottom in the window (`getBoundingClientRect`). */
export interface Span {
  top: number;
  bottom: number;
}

/** Final round 3 (R3-H1), final round 4 (R4-M5): whether a page's control that has just taken the focus is scrolled
 *  clear of the save dock. Only a focus the browser shows (`focusVisible`) that did NOT come from a pointer press —
 *  a pressed text field matches `:focus-visible` too, and moving it under the pointer between press and release
 *  selected the wrong text (drag, double-click) — and only while it overlaps a drawn dock. */
export function keepClearScrolls(i: { pointer: boolean; focusVisible: boolean; el: Span; dock: Span }): boolean {
  return !i.pointer && i.focusVisible && i.dock.bottom > i.dock.top && i.el.bottom > i.dock.top && i.el.top < i.dock.bottom;
}

/** Final round 4 (R4-L3): `:focus-visible` for `el`; an engine without the selector (WebKitGTK before 2.36, outside
 *  the documented matrix) throws on it, and the focus then counts as shown — `keepClearScrolls`' pointer test still
 *  keeps a press from moving anything. */
export function shownFocus(el: { matches(selector: string): boolean }): boolean {
  try {
    return el.matches(":focus-visible");
  } catch {
    return true;
  }
}

/** The next request: a new number, or (nothing to show) the last request unchanged. */
export function nextReveal(last: Reveal, next: Omit<Reveal, "seq"> | null): Reveal {
  return next === null ? last : { seq: last.seq + 1, ...next };
}

export interface AttentionInput {
  /** The providers list's view (`providersView`), or `null` while there is none. */
  providers: ProvidersView | null;
  /** `CalendarSettings`' `onstatus`: whether every source is ok, or `null` before it has reported. */
  calendarOk: boolean | null;
  /** The config failed to load. */
  loadFailed: boolean;
  draft: Draft | null;
  errors: Record<string, string>;
}

/**
 * The pages with an attention dot, in the sidebar's order, from today's messages only:
 * - AI providers: a row the engine reports as failing (its status line in the "bad" tone: not working, invalid, or
 *   "key moved"), or whose last Test failed (its result line, which shows even when the engine could not record it);
 * - Calendar: a source that is not ok;
 * - General: a config that failed to load;
 * - every page holding a live field error, independent of the save bar (a rejected value never reaches the draft,
 *   so a live error can sit beside a clean draft).
 */
export function attentionPages(input: AttentionInput): PageId[] {
  const marked = new Set<PageId>(blockedPages(input.draft, input.errors));
  const view = input.providers;
  if (view !== null && view.readable && view.rows.some((r) => r.status.tone === "bad" || r.notes.some((n) => n.startsWith(TEST_FAILED_PREFIX)))) {
    marked.add("providers");
  }
  if (input.calendarOk === false) marked.add("calendar");
  if (input.loadFailed) marked.add("general");
  return inOrder(marked);
}

/* ── the JSON editor ───────────────────────────────────────────────────────────────────────────── */

const NOT_AN_OBJECT = "The JSON is not a JSON object, so the form cannot show it. Fix it or reload.";

/**
 * Final small fix (F2, high-rigor M1 and M2): while any save is in flight — one through the one save path (`saving`: the
 * bar's Save, an Add's, a key action's) or a Replace's Save from its press on, its wait on a running briefing included
 * (`replaceSaving`) — the JSON editor is read-only. Text typed there while a save ran was either thrown away when it
 * landed or kept over the text the save wrote, so the next Save undid it (an added provider dropped, its key left in the
 * Keychain); now nothing can be typed then. Read-only, not disabled: the editor keeps the focus, the selection and its
 * scroll, and it can be opened during a save (`JSON_SAVING_LINE` says why it cannot be typed in).
 */
export function jsonEditorReadOnly(s: { saving: boolean; replaceSaving: boolean }): boolean {
  return s.saving || s.replaceSaving;
}

export const JSON_SAVING_LINE = "Saving — you can edit again when it finishes.";

/** Leaving the JSON editor parses its text back into the draft; text that is not a JSON object is refused. */
export function leaveJson(raw: string): { ok: true; draft: Draft } | { ok: false; message: string } {
  const draft = parseDraft(raw);
  return draft === null ? { ok: false, message: NOT_AN_OBJECT } : { ok: true, draft };
}

/** What a page change does. `left-json` carries all of today's `showTab("form")` effect, for the shell to apply
 *  whole: the parsed draft, the errors and the failure line cleared, the form tab. */
export type Navigation =
  | { kind: "moved"; page: PageId; tab: "form" | "raw" }
  | { kind: "left-json"; page: PageId; tab: "form"; draft: Draft; errors: Record<string, string>; failure: "" }
  | { kind: "refused"; page: PageId; message: string };

/**
 * A page change from `from` to `to`. Only leaving Advanced while the JSON editor is open (`tab === "raw"`) parses
 * the text: refused, it stays on Advanced with the message; parsed, it moves with the form tab. Any other change
 * keeps the tab as it is, so a raw tab carried onto another page (after an uninstall report opened About) is never
 * parsed there and never blocks leaving that page.
 *
 * `editorDrawn`: whether Advanced can draw the editor at all (the config is ready). When it cannot — the file became
 * unreadable or not an object while the editor was open, and Discard or a save reloaded it — there is no editor to
 * leave: every change moves, with the form tab, so General (which says why, with Reload) is always reachable and a
 * later Reload shows the form rather than pointing at an editor nobody reopened.
 */
export function navigate(from: PageId, to: PageId, tab: "form" | "raw", raw: string, editorDrawn: boolean): Navigation {
  if (!editorDrawn) return { kind: "moved", page: to, tab: "form" };
  if (from !== "advanced" || to === "advanced" || tab !== "raw") return { kind: "moved", page: to, tab };
  const left = leaveJson(raw);
  if (!left.ok) return { kind: "refused", page: from, message: left.message };
  return { kind: "left-json", page: to, tab: "form", draft: left.draft, errors: {}, failure: "" };
}

/* ── the page a mount opens: module state, as `keepSettings` keeps the draft ───────────────────── */

// Module state outlives Settings unmounting on a route change and remounting when an uninstall report arrives
// (`{#key uninstallReportSeq}` in `App.svelte`). In memory only: an app restart starts on General again.
let remembered: PageId | null = null;
let shownReport: UninstallReport | null = null;

/** The last page opened, remembered for the session. Every page change calls it. */
export function rememberPage(page: PageId): void {
  remembered = page;
}

export function rememberedPage(): PageId | null {
  return remembered;
}

/** The uninstall report the screen last opened About for. */
export function rememberShownReport(report: UninstallReport | null): void {
  shownReport = report;
}

export function lastShownReport(): UninstallReport | null {
  return shownReport;
}

/**
 * The page a mount opens. A newer uninstall report (non-null, and not the object last shown: App passes the same
 * object to every mount until a new report replaces it) opens About, over a kept JSON editor too, whose state stays
 * kept. Else a kept raw tab opens Advanced, where the editor is; else the remembered page, or General.
 * When this answers About, the shell calls `rememberShownReport(report)` and `rememberPage("about")`.
 */
export function initialPage(input: {
  remembered: PageId | null;
  kept: { tab: "form" | "raw" } | null;
  report: UninstallReport | null;
  lastShownReport: UninstallReport | null;
}): PageId {
  if (input.report !== null && input.report !== input.lastShownReport) return "about";
  if (input.kept?.tab === "raw") return "advanced";
  return input.remembered ?? "general";
}
