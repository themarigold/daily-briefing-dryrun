/**
 * B8 (dev 63) — the "install command-line tool" Settings action's webview half.
 *
 * ⚠ THIS FILE IS THE WIRE CONTRACT for `src-tauri/src/cli_shim.rs`: every field and every `kind`
 * mirrors the Rust `Serialize` types exactly. Change them together or not at all.
 *
 * ⚠ NO DECISION LIVES HERE. What counts as OURS (removable, replaceable) versus FOREIGN (never
 * touched) is `cli_shim::classify`, in Rust, judged against the target the ENGINE reports — the
 * webview cannot name a path, a target or a directory. This file carries the invoke wrappers and
 * the WORDING, including the exact manual command shown when `/usr/local/bin` needs authority
 * this app does not have (the app never runs `sudo`; the user does, in their own terminal).
 */
import { invoke } from "@tauri-apps/api/core";
import type { Os } from "./platform";

/** What sits at the shim name, judged by Rust against the engine's reported target. */
export type ShimPlacement =
  | { state: "absent" }
  | { state: "current" }
  | { state: "stale"; pointsTo: string }
  | { state: "foreign"; pointsTo: string | null; detail: string };

export type CliShimStatus = {
  /** False off unix — the whole action is then absent from Settings. */
  supported: boolean;
  /** `/usr/local/bin/daily-briefing`, for display. */
  shimPath: string;
  /** The managed engine copy an install would link to; `null` until a scheduler is installed. */
  target: string | null;
} & ShimPlacement;

export type ShimError =
  | { kind: "engine"; detail: string }
  | { kind: "unsupported"; detail: string }
  | { kind: "noManagedEngine"; detail: string }
  | { kind: "foreign"; path: string; detail: string }
  /** The filesystem refused; `command` is the exact line the user can run themselves. */
  | { kind: "needsManualStep"; command: string; detail: string }
  | { kind: "sink"; detail: string };

/** Two engine spawns (`schedule status --json`, `status --json`) plus one `lstat`. Read-only. */
export function cliShimStatus(): Promise<CliShimStatus> {
  return invoke<CliShimStatus>("cli_shim_status");
}

/** Write the symlink (or repair a stale one of ours). Refuses a foreign file; never escalates. */
export function cliShimInstall(): Promise<CliShimStatus> {
  return invoke<CliShimStatus>("cli_shim_install");
}

/** Remove the symlink — only one that is ours. Refuses a foreign file; absent is a no-op. */
export function cliShimRemove(): Promise<CliShimStatus> {
  return invoke<CliShimStatus>("cli_shim_remove");
}

/* ── the wording, pure so `tests-web` can pin it ──────────────────────────────────────────────── */

/** One sentence for what currently holds the name. */
export function placementLine(status: CliShimStatus): string {
  switch (status.state) {
    case "absent":
      return `Nothing is installed at ${status.shimPath} yet.`;
    case "current":
      return `${status.shimPath} points at the background engine copy — \`daily-briefing\` works in a terminal.`;
    case "stale":
      return `${status.shimPath} is Daily Briefing's link, but it points at ${status.pointsTo}, which is not the current engine copy. Installing again repairs it.`;
    case "foreign":
      return `${status.shimPath} is ${status.detail}${status.pointsTo !== null ? ` (it points at ${status.pointsTo})` : ""}. Daily Briefing will not replace or remove a file it did not make.`;
  }
}

/** One sentence for a rejection from these commands. Plain text.
 *
 *  `os` because the refusal names who refused: `cli_shim.rs` supports every unix, so a Linux user can
 *  reach `needsManualStep` too. On macOS the text is the v0.2.0 text, byte for byte; anywhere else it
 *  says "The system" (as `notifyAskExplanation` in `notify.ts` does). Required, so a caller that
 *  forgets it fails `svelte-check` rather than showing a Linux user macOS's name. */
export function describeShimFailure(e: unknown, os: Os): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (typeof e !== "object" || e === null) return JSON.stringify(e);
  const tagged = e as Record<string, unknown>;
  const f = (k: string) => String(tagged[k] ?? "");
  switch (tagged.kind) {
    case "engine":
    case "unsupported":
    case "sink":
      return f("detail");
    case "noManagedEngine":
      return `${f("detail")} Install the background scheduler first — the copy it makes is what the command-line tool links to.`;
    case "foreign":
      return `${f("path")} is already taken by ${f("detail")}. Daily Briefing will not replace or remove a file it did not make; move it aside yourself if you want the name.`;
    case "needsManualStep":
      return `${os === "macos" ? "macOS" : "The system"} did not let this app write there (${f("detail")}). Run this in a terminal instead:\n${f("command")}`;
    default:
      return JSON.stringify(e);
  }
}
