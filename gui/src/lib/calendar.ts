/**
 * v0.3.0 (calendar connection, plan M8) — the webview's three calendar LINK commands. Rust owns every
 * path and every rule: `src-tauri/src/calendar.rs`. The four calendar ENGINE operations (status,
 * list, test, connect mac) are in `lib/engine.ts`.
 *
 * ⚠ THIS FILE IS THE WIRE CONTRACT for M9's Settings → Calendar: the argument names, the payload
 * shapes and every `kind` below mirror the Rust `Serialize` types exactly. Change them together or
 * not at all.
 *
 * ⚠ A LINK'S URL IS A SECRET (spec r4 §2). It goes to `calendarLinkWrite` and nowhere else: never
 * into the `calendar` block (a key spelled `url`, or a URL in a name, owner or email, is refused in
 * Rust before anything runs), never into a log, never back from any command — no answer and no error
 * here carries it, and nothing can read it back. NOTHING HERE TAKES A PATH: the link file is
 * `<state>/calendar/links/<id>.url` under the state folder the ENGINE reports.
 *
 * The Settings order for adding or replacing a link: `calendarLinkWrite(id, url)` first, THEN
 * `calendarConfigSave(block)` with the link's entry (and any `confirmedOwner` the user just
 * confirmed). A write that REPLACES a different URL first clears that link's `confirmedOwner`
 * (`confirmationCleared: true`), because the confirmation was of the old URL's address (spec §4.2).
 */
import { invoke } from "@tauri-apps/api/core";
import type { FieldNote, SaveError, SaveOutcome } from "./files";

/** What `calendarLinkWrite` did. Never the URL. */
export interface LinkWritten {
  id: string;
  /** `<state>/calendar/links/<id>.url`, for display. */
  path: string;
  /** A previous URL for this id was replaced. */
  replaced: boolean;
  /** The link's `confirmedOwner` was removed from the config first, because a different URL
   *  replaced the one it confirmed. Ask the user to confirm the new address again. */
  confirmationCleared: boolean;
}

export type FileRemoval = "removed" | "absent";

/** What `calendarLinkRemove` did. */
export interface LinkRemoved {
  id: string;
  file: FileRemoval;
  /** The config step — `unchanged` when there was no entry for this id; `null` when there is no
   *  config file at all. */
  config: SaveOutcome | null;
}

/** Why a calendar link command did not do what it was asked. No variant carries a URL, and none
 *  carries a link id that failed the grammar. */
export type CalendarError =
  /** The id failed `^[a-z0-9][a-z0-9-]{0,31}$`, or is the reserved `macos`. Nothing ran. */
  | { kind: "invalidId"; reason: string }
  /** The URL failed the minimal check (https/webcal, no whitespace or control character, ≤ 4096
   *  bytes, a host). Nothing ran. `reason` names the class, never the value. */
  | { kind: "invalidUrl"; reason: string }
  /** The `calendar` block breaks the engine resolver's rules (closed key sets, field types, …). */
  | { kind: "invalidBlock"; reason: string }
  | { kind: "duplicateId"; id: string }
  /** A link URL was about to land in config.json: a `url` key, or a URL in a name/owner/email.
   *  `field` is the position (`links[2].name`), never the value. */
  | { kind: "urlInConfig"; field: string }
  | { kind: "tooManyLinks"; limit: number }
  /** `status --json` could not say where the engine's state folder or config is. */
  | { kind: "engine"; detail: string }
  /** `<state>/calendar` or `…/links` is a symlink, not a folder, another user's or not private. */
  | { kind: "linkFolder"; path: string; detail: string }
  /** Something other than a regular file is at `<id>.url` (left alone), or the write failed. */
  | { kind: "linkFile"; path: string; detail: string }
  /** The config step's own error (`lib/files.ts`'s `SaveError`), verbatim. */
  | { kind: "config"; error: SaveError }
  /** A replacing write could not clear the stale confirmation: the engine refused the config.
   *  NOTHING was written — the old URL and its confirmation still stand together. */
  | { kind: "configInvalid"; errors: FieldNote[]; warnings: FieldNote[] }
  /** The link file was dealt with, THEN the config step failed: its entry is still in the config. */
  | { kind: "configAfterRemoval"; removed: FileRemoval; error: SaveError }
  /** A replacing write removed the stale confirmation from the config, THEN the link file write failed
   *  (`error`): the old URL stays, unconfirmed. The config DID change — Settings must reload it. */
  | { kind: "writeAfterConfirmationCleared"; error: CalendarError; confirmationCleared: true };

/** Write one link's URL to its managed file (0600 in a 0700 folder, atomic). See the header for the
 *  order relative to `calendarConfigSave`. */
export function calendarLinkWrite(id: string, url: string): Promise<LinkWritten> {
  return invoke<LinkWritten>("calendar_link_write", { id, url });
}

/** Remove one link: its managed file, then its entry in `calendar.links`. Idempotent. */
export function calendarLinkRemove(id: string): Promise<LinkRemoved> {
  return invoke<LinkRemoved>("calendar_link_remove", { id });
}

/**
 * Replace the config's `calendar` block through the one config-write path (engine-validated, atomic,
 * `.bak` kept, every other field preserved). Errors block; the engine's warnings come back on a
 * `saved` outcome. The block must use ONLY the keys the engine reads — `enabled`, `emails`, `macos`,
 * `links`; each link `id`, `name`, `owner`, `confirmedOwner`, `urlEnv`, `urlCommand` (an argv array) —
 * or Rust refuses it: the engine's resolver turns the WHOLE block off for one unknown key.
 */
export function calendarConfigSave(block: Record<string, unknown>): Promise<SaveOutcome> {
  return invoke<SaveOutcome>("calendar_config_save", { text: JSON.stringify(block) });
}
