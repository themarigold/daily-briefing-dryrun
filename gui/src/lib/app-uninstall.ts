/**
 * B25 (T25) — the "Uninstall app" Settings action's webview half.
 *
 * ⚠ THIS FILE IS THE WIRE CONTRACT for `src-tauri/src/uninstall.rs`: every field and every tag
 * mirrors the Rust `Serialize` types exactly. Change them together or not at all.
 *
 * ⚠ NO DECISION LIVES HERE. WHAT may be removed is Rust's: the app-file list is enumerated in
 * `uninstall.rs` (the module constants), the engine-state list mirrors `scripts/uninstall.sh`'s
 * bounded list and is pinned against it at test time, and the engine state dir is the ENGINE's
 * answer — the webview can name no path. What lives here is the invoke wrappers, the consent
 * boolean, and the WORDING — which must name the briefing archive out loud, because the
 * consented leg is the one surface in this app that can remove it.
 */
import { invoke } from "@tauri-apps/api/core";

export type EntryKind = "file" | "glob" | "dir";

export type PreviewEntry = { name: string; kind: EntryKind; present: boolean };

export type UninstallPreview = {
  appDataDir: string;
  appConfigDir: string;
  appEntries: PreviewEntry[];
  /** `status --json`'s `paths.stateDir`; `null` with `engineError` set when the engine could not answer. */
  engineStateDir: string | null;
  engineError: string | null;
  engineEntries: PreviewEntry[];
  /** `is_enabled()`'s answer; `null` when it could not be read. */
  autostartEnabled: boolean | null;
  autostartError: string | null;
};

export type RemovalOutcome =
  | { result: "removed" }
  | { result: "absent" }
  | { result: "failed"; detail: string };

export type ActionReport = { name: string; outcome: RemovalOutcome };

export type UninstallReport = {
  autostart: RemovalOutcome;
  app: ActionReport[];
  /** True when at least one engine entry was ACTUALLY removed — derived from the outcomes, not
   *  echoed from the consent flag (consent over an empty dir, or with every removal refused,
   *  reports false). */
  engineStateRemoved: boolean;
  engine: ActionReport[];
  /** The directory the consented engine leg targeted (`status --json` re-resolved at execute
   *  time, the same call path the preview used); `null` when the leg was not attempted or the
   *  engine could not answer. The done view renders it so the consented target is auditable. */
  engineStateDir: string | null;
  engineError: string | null;
};

/** Read-only: one engine spawn (`status --json`), one `is_enabled()` read, and `lstat`s. */
export function uninstallPreview(): Promise<UninstallPreview> {
  return invoke<UninstallPreview>("uninstall_preview");
}

/** Perform it. `removeEngineState` is the EXPLICIT consent for the engine-data leg. */
export function uninstallExecute(removeEngineState: boolean): Promise<UninstallReport> {
  return invoke<UninstallReport>("uninstall_execute", { removeEngineState });
}

/* ── the wording, pure so `tests-web` can pin it ──────────────────────────────────────────────── */

/** What the un-consented action does — the app's own pieces only. */
export const UNINSTALL_EXPLANATION =
  "Removes this app's background pieces: its start-at-login entry and its own settings files. " +
  "Your briefings, your configuration and the background engine are not touched unless you also " +
  "tick the box below. The app itself is removed by dragging it out of Applications afterwards.";

/**
 * The consent checkbox's label. ⚠ It NAMES the archive and the engine copy — this is the one
 * surface in the app that can remove the briefing history, and a consent that does not say so is
 * not consent (`docs/gui-seam.md` §16, deviation 159).
 */
export function consentLabel(preview: UninstallPreview): string {
  const where = preview.engineStateDir === null ? "" : ` in ${preview.engineStateDir}`;
  return (
    `Also remove the engine's data${where}: the whole briefing archive and its log — your ` +
    "briefing history, which cannot be recovered — plus the background engine copy the " +
    "command-line tool and scheduler use. Exactly what `bash scripts/uninstall.sh` would " +
    "remove; nothing else in that folder is touched."
  );
}

/** One sentence for the scheduler, which this action deliberately does NOT touch. */
export const SCHEDULER_NOTE =
  "The background scheduler itself is not changed here — remove or hand it over from the " +
  "Schedule screen first if you no longer want scheduled briefings.";

/** One line per report entry, for the done view. */
export function outcomeLine(report: ActionReport): string {
  switch (report.outcome.result) {
    case "removed":
      return `${report.name}: removed`;
    case "absent":
      return `${report.name}: was not there`;
    case "failed":
      return `${report.name}: could not be removed (${report.outcome.detail})`;
  }
}

/** The autostart leg's line, worded as the login item it is. */
export function autostartLine(outcome: RemovalOutcome): string {
  switch (outcome.result) {
    case "removed":
      return "Start-at-login entry: removed";
    case "absent":
      return "Start-at-login entry: was not enabled";
    case "failed":
      return `Start-at-login entry: could not be removed (${outcome.detail})`;
  }
}
