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

/** What `config_read` shows in place of a stored literal `provider.api.apiKey` — `config_save`
 *  restores the stored key when this comes back unchanged (`config_save::REDACTED_API_KEY`). */
export const REDACTED_API_KEY = "(a literal API key is stored in config.json; Daily Briefing never displays it)";

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

/** One sentence for any rejection from these commands (or the engine commands). Plain text. */
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
      return "Not saved: a literal API key cannot be set or changed from this app. Point provider.api.apiKeyFile or provider.api.apiKeyCommand at it instead; removing a stored key is allowed.";
    case "candidateDir":
      return `Not saved: ${f("detail")}`;
    case "write":
      return `Not saved: ${f("path")} could not be written (${f("detail")}). The previous config is unchanged.`;
    case "backupNotAFile":
      return `Not saved: the config's backup, ${f("path")}, is ${f("detail")}, not a regular file, so it cannot be replaced. Move it out of the way and save again; the config and that backup are unchanged.`;
    case "unsupported":
      return f("detail");
    default:
      return JSON.stringify(e);
  }
}
