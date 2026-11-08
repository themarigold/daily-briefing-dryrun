/**
 * B5's five commands — the two briefing READS (T12/T13) and the config read / save / Quit offer
 * (T15) — plus B8's `configCreate` (T16), six in all. Rust owns every path:
 * `src-tauri/src/briefing_files.rs` and `src-tauri/src/config_save.rs`.
 *
 * ⚠ THIS FILE IS THE WIRE CONTRACT for T16/T18 (docs/gui-seam.md §10e): the argument names, the
 * payload shapes and every `kind` below mirror the Rust `Serialize` types exactly. Change them
 * together or not at all.
 *
 * ⚠ NOTHING HERE TAKES A PATH. `readArchivedBriefing` takes a date string, which Rust parses into a
 * real calendar date before it asks the engine anything; `configSave` takes JSON TEXT plus the
 * `base` token `configRead` returned. Do not pre-validate either here — a second copy of the rules
 * in TypeScript is the drift the Rust newtypes exist to prevent.
 */
import { invoke } from "@tauri-apps/api/core";

/* ── briefings ────────────────────────────────────────────────────────────────────────────────── */

export interface BriefingFile {
  /** Opaque identities from the same Rust file read; absent on older engines and Windows. */
  pageHash?: string;
  pageVersion?: string;
  /** The engine's path, for display only. */
  path: string;
  /** ⚠ UNTRUSTED git-derived text. Render it through `briefing-md.ts`, never as markup. */
  text: string;
  bytes: number;
}

export type BriefingError =
  | { kind: "invalidDate"; reason: string }
  | { kind: "engine"; detail: string }
  | { kind: "notFound"; path: string }
  | { kind: "unreadable"; path: string; detail: string };

/** `briefing-latest.md`, or `null` before the engine has written one. */
export function readLatestBriefing(): Promise<BriefingFile | null> {
  return invoke<BriefingFile | null>("read_latest_briefing");
}

/** `briefings/<date>.md`. READ-ONLY: nothing in this app writes, prunes or deletes the archive. */
export function readArchivedBriefing(date: string): Promise<BriefingFile> {
  return invoke<BriefingFile>("read_archived_briefing", { date });
}

/* ── config ───────────────────────────────────────────────────────────────────────────────────── */

export interface FieldNote {
  field: string;
  message: string;
}

/** What `config_read` shows in place of the value at EVERY `apiKey` slot (item 1's, each `fallbacks` entry's, any
 *  spelling anywhere — `config_save::redact`). `config_save` restores the stored key when this comes back unchanged
 *  at the same pointer, under the same entry (by a label no other entry shares), sent to the same `api.kind` and
 *  endpoint origin; anything else is `apiKeyChanged` (`config_save::restore_api_key`, `REDACTED_API_KEY`). */
export const REDACTED_API_KEY = "(a literal API key is stored in config.json; Daily Briefing never displays it)";

/** Where the user edits the settings as JSON text: the button on Settings' Advanced page (Redesign D). Every sentence
 *  that sends the user there uses this phrase — set once here, the leaf every one of them already reaches — so a
 *  renamed button or page is one edit, not a dozen. */
export const EDIT_AS_JSON = "Edit settings as JSON on Settings → Advanced";

export interface ConfigDocument {
  /** `status --json`'s `paths.configPath`. */
  path: string;
  exists: boolean;
  /** The config as the save writes it, a literal API key replaced by a placeholder. */
  text: string | null;
  /** Send back with the save; a different file on disk is refused as a conflict. */
  base: string | null;
  parseError: string | null;
  apiKeyRedacted: boolean;
}

export type SaveOutcome =
  | { kind: "saved"; path: string; backupPath: string; warnings: FieldNote[] }
  /** B8 (T16): `config_create` wrote the FIRST config. No backup — there was no previous file. */
  | { kind: "created"; path: string; warnings: FieldNote[] }
  | { kind: "unchanged"; path: string }
  | { kind: "invalid"; errors: FieldNote[]; warnings: FieldNote[] };

export type SaveError =
  | { kind: "engine"; detail: string }
  | { kind: "noConfig"; path: string }
  /** B8 (T16): `config_create` found something already at the config path — a config a terminal
   *  `daily-briefing init` wrote while the wizard was open, a dotfiles symlink, anything. It is
   *  never replaced; the wizard re-reads and switches to the edit path. */
  | { kind: "alreadyExists"; path: string }
  | { kind: "configUnreadable"; path: string; detail: string }
  | { kind: "onDiskNotJson"; path: string; detail: string }
  | { kind: "notJson"; detail: string }
  | { kind: "tooLarge"; bytes: number; limit: number }
  | { kind: "conflict"; path: string }
  | { kind: "transcriptsChanged" }
  | { kind: "apiKeyChanged" }
  | { kind: "candidateDir"; detail: string }
  | { kind: "write"; path: string; detail: string }
  | { kind: "backupNotAFile"; path: string; detail: string }
  | { kind: "unsupported"; detail: string };

export function configRead(): Promise<ConfigDocument> {
  return invoke<ConfigDocument>("config_read");
}

/** Validate with the engine, then replace the config atomically (`.bak` kept). Errors block; warnings do not. */
export function configSave(text: string, base: string): Promise<SaveOutcome> {
  return invoke<SaveOutcome>("config_save", { text, base });
}

/** The Quit dialog's offer: the engine's `notify` → `"auto"`, through the same save. */
export function configOfferNotifyAuto(): Promise<SaveOutcome> {
  return invoke<SaveOutcome>("config_offer_notify_auto");
}

/**
 * B8 (T16): create the FIRST config — the wizard's one write. JSON text in, never a path; the
 * engine validates it (`config validate --file`); the create is EXCLUSIVE, so anything already at
 * the config path is refused as `alreadyExists` and never replaced (initConfig's
 * leave-existing-alone semantics). A literal API key is refused outright — since round 1 as a
 * recursive scan for any object key spelled `apiKey` in any letter case, anywhere in the document
 * (`apiKeyFile`/`apiKeyCommand` stay legal: the wizard's native-key path carries those
 * REFERENCES, never a key value) — and so is any `transcripts` block.
 */
export function configCreate(text: string): Promise<SaveOutcome> {
  return invoke<SaveOutcome>("config_create", { text });
}

/* ── wording ──────────────────────────────────────────────────────────────────────────────────── */

function isTagged(e: unknown): e is { kind: string } & Record<string, unknown> {
  return typeof e === "object" && e !== null && typeof (e as { kind?: unknown }).kind === "string";
}

/** One sentence for any rejection from these commands (or the engine commands, or the calendar link
 *  commands — `lib/calendar.ts`'s `CalendarError`, v0.3.0). Plain text.
 *
 *  ⚠ A CALENDAR ERROR NEVER CARRIES A LINK'S URL (Rust names the class of a problem, a field's
 *  POSITION, a path under the state folder or a link id that passed the grammar), so nothing here
 *  can echo one — and nothing here is handed one to echo. */
export function describeFailure(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (!isTagged(e)) return JSON.stringify(e);
  const f = (k: string) => String(e[k] ?? "");
  switch (e.kind) {
    case "invalidDate":
      return `That is not an archive date: it ${f("reason")}.`;
    case "engine":
    case "spawn":
    case "sidecarUnresolved":
      return f("detail");
    case "busy":
      return `Another engine operation is already running (${f("running")}), so this one was not started.`;
    case "timeout":
      return `The engine's ${f("operation")} did not finish within ${f("seconds")} seconds and was stopped.`;
    case "invalidInput":
      return `${f("field")} ${f("reason")}`;
    case "notFound":
      return `${f("path")} does not exist.`;
    case "unreadable":
    case "configUnreadable":
      return f("detail");
    case "noConfig":
      return `There is no config at ${f("path")} yet. The setup wizard creates one (or run \`daily-briefing init\` in a terminal); this screen edits an existing config.`;
    case "alreadyExists":
      return `Not created: a config already exists at ${f("path")}. Nothing was replaced — the wizard has reloaded it, so the steps now show what it says; review them and save again.`;
    case "onDiskNotJson":
      return `${f("path")} could not be read as a JSON object (${f("detail")}). Fix it in an editor, or restore config.json.bak; this app will not replace a file it cannot read.`;
    case "notJson":
      return `Not saved: the text could not be read as a JSON object (${f("detail")}).`;
    case "tooLarge":
      return `Not saved: the config would be ${f("bytes")} bytes, over the ${f("limit")}-byte limit.`;
    case "conflict":
      return `Not saved: ${f("path")} changed on disk after it was loaded. Reload it and make the change again.`;
    case "transcriptsChanged":
      return "Not saved: the transcripts setting cannot be changed from this app. Re-enabling transcripts is a maintainer decision.";
    case "apiKeyChanged":
      return `Not saved: an API key written into config.json cannot be set or changed from this app, cannot move to another provider, to another kind of API, or to another address (host or port), and cannot stay with a provider whose name another provider also uses. A key the saved settings already hold: move it to the app's key store first (the provider's Move this key button), or remove it. A key typed in here: remove it with ${EDIT_AS_JSON} (or discard your changes), then give the provider its key with Replace key. For a provider not saved yet, Replace key is not offered: save it without the key first, or remove it and add it with Add a provider, which takes a pasted key.`;
    case "candidateDir":
      return `Not saved: ${f("detail")}`;
    case "write":
      return `Not saved: ${f("path")} could not be written (${f("detail")}). The previous config is unchanged.`;
    case "backupNotAFile":
      return `Not saved: the config's backup, ${f("path")}, is ${f("detail")}, not a regular file, so it cannot be replaced. Move it out of the way and save again; the config and that backup are unchanged.`;
    case "unsupported":
      return f("detail");
    /* v0.3.0 (plan M9): `CalendarError` (`src-tauri/src/calendar.rs`). */
    case "invalidId":
      // From a link write the reason is the bare refusal ("is empty"); from a block save it names the
      // field's position ("calendar.links[2].id is missing or not text").
      return f("reason").startsWith("calendar.")
        ? `Not saved: ${f("reason")}.`
        : `Not saved: the link's short name ${f("reason")}.`;
    case "invalidUrl":
      return `Not saved: the calendar link ${f("reason")}. Nothing was written.`;
    case "invalidBlock":
      return `Not saved: ${f("reason")}.`;
    case "duplicateId":
      return `Not saved: two calendar links are both called "${f("id")}".`;
    case "urlInConfig":
      return `Not saved: ${f("field")} looks like a calendar link. A link's address is a secret and is never stored in the config — paste it into the link field instead.`;
    case "tooManyLinks":
      return `Not saved: at most ${f("limit")} calendar links can be connected.`;
    case "linkFolder":
      return `The calendar links folder could not be used: ${f("path")} ${f("detail")}. Nothing was changed.`;
    case "linkFile":
      return `${f("path")} ${f("detail")}.`;
    case "config":
      return describeFailure(e["error"]);
    case "configInvalid": {
      const notes = Array.isArray(e["errors"]) ? (e["errors"] as FieldNote[]) : [];
      const listed = notes.map((n) => (n.field !== "" ? `${n.field}: ${n.message}` : n.message)).join("; ");
      return `The link was not replaced: the engine refused the config${listed !== "" ? ` (${listed})` : ""}. The old link and its confirmed address still stand.`;
    }
    case "writeAfterConfirmationCleared":
      return `The link was not replaced: ${describeFailure(e["error"])} Its confirmed address was already removed from the settings, so confirm it again after the link is saved.`;
    case "configAfterRemoval":
      return `The link file was ${f("removed") === "removed" ? "removed" : "already gone"}, but its entry is still in the config: ${describeFailure(e["error"])}`;
    default:
      return JSON.stringify(e);
  }
}

/** Post-cap (R5-M3, pre-existing on main): the Settings screen's words for a save it sent that was refused. A conflict
 *  (the file changed after it was loaded) says what that screen offers — with an unsaved edit on screen (`editing`),
 *  the save bar's Discard, which loads the file; with none, the file is loaded again at once (`reload`: the screen owes
 *  the reload, `owedReloadRuns`). Every other refusal, and every other caller (the wizard re-reads by itself, the
 *  Calendar panel has no bar), keeps `describeFailure`'s words.
 *
 *  Final small fix (the LOWs): an Add's or a Replace's Save (`flow`, pending) on a clean draft says what works — Save
 *  again, which tests the provider on the file first (its draft changed, `addSaveDecision`), then Save once more (tiny
 *  fix, delta L1: the first Save only tests) — not "make the change again"; and `loaded` is the line once the owed
 *  reload has drawn the file, which the screen shows in place of a conflict line still pointing at Discard. */
export function settingsSaveRefusal(e: unknown, on: { editing: boolean; flow: boolean }): { line: string; reload: boolean; loaded: string } {
  if (!isTagged(e) || e.kind !== "conflict") {
    const line = describeFailure(e);
    return { line, reload: false, loaded: line };
  }
  const changed = `Not saved: ${String(e["path"] ?? "")} changed on disk after it was loaded.`;
  const loaded = `${changed} It is loaded again now: ${on.flow ? "Save again: it tests the provider first, then Save once more." : "make the change again."}`;
  return { line: on.editing ? `${changed} Discard to load it, then make the change again.` : loaded, reload: true, loaded };
}
