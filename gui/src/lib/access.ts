/**
 * T17's four commands, and the rules the panel applies to their answers.
 *
 * ⚠ THIS FILE IS THE WIRE CONTRACT for T16's wizard (`docs/gui-seam.md` §11): every field and every
 * `kind` below mirrors the Rust `Serialize` types in `src-tauri/src/access.rs` exactly. Change them
 * together or not at all.
 *
 * ⚠ NOTHING HERE TAKES A PATH OR A URL. `accessProbe` takes a `ProtectedRootKey` — one of four
 * fixed strings, resolved against the app's own `HOME` in Rust — and `accessOpenSettings` takes a
 * `SettingsPane`, mapped to one of three fixed URLs in Rust. There is no argument on this seam that
 * could name another directory or another destination, which is why the capability grants the
 * opener plugin nothing at all (`src-tauri/capabilities/README.md`).
 *
 * ⚠ AND THE LAUNCH-TIME PROBE IS GATED BY RUST, NOT BY THIS FILE'S OPINION. `AccessSnapshot`
 * carries `probeAdvice`; `launchActions` below is the only place that reads it, and it is what
 * keeps plan R1's rule — *"ONLY a revocation detector … never an acquisition trigger outside the
 * guided flow"* — true on the webview side.
 */
import { invoke } from "@tauri-apps/api/core";

/** The four macOS-protected folders, as the operand `accessProbe` takes. */
export type ProtectedRootKey = "desktop" | "documents" | "downloads" | "icloud";

/** Which System Settings pane to open. */
export type SettingsPane = "files-and-folders" | "full-disk-access" | "privacy-root";

/** What one directory read from the app process said. */
export type DirAccess =
  /** It opened and enumerated. `entries` is a COUNT — no name and no byte is read. */
  | { kind: "ok"; entries: number }
  /** `EPERM` (a TCC denial on macOS) or `EACCES` (ordinary permissions). */
  | { kind: "denied"; errno: number }
  | { kind: "notFound" }
  | { kind: "notADirectory" }
  | { kind: "error"; detail: string };

/** A repo the engine classified `tcc-denied`, with the engine's own advice. */
export interface DeniedPath {
  path: string;
  /**
   * ⚠ `doctor --json`'s `advice`, VERBATIM — it is the engine's `warnFor(issue)`
   * (`src/protectedPath.ts`) and appendix T17 requires it *"displayed unmodified"*. Render it as
   * text; never rewrite, trim or re-word it.
   */
  advice: string;
}

export interface RootInScope {
  key: ProtectedRootKey;
  /** The folder's absolute path, for display. */
  path: string;
  denied: DeniedPath[];
  /** Why it is in scope: the configured or reported paths that reach it. Display only. */
  because: string[];
}

export type VersionChange =
  | { kind: "firstLaunch" }
  | { kind: "same" }
  | { kind: "changed"; from: string };

export interface AccessSnapshot {
  /** False off macOS — the whole flow is then absent (appendix T17). */
  supported: boolean;
  roots: RootInScope[];
  /** `doctor --json`'s verdict, verbatim. */
  doctorVerdict: string | null;
  /** True when doctor's repo walk hit its deadline, so `roots` is PARTIAL. */
  reposTimedOut: boolean;
  grantObserved: boolean;
  probeAdvice: "none" | "revocation-check";
  probeRoot: ProtectedRootKey | null;
  versionChange: VersionChange;
  appVersion: string;
  /** The managed engine copy, from `schedule status --json`'s `binPath`. Display only. */
  managedEnginePath: string | null;
  /**
   * v0.2.1 §3.4: true only when doctor said `config.exists: false` — setup has not written a config
   * yet. The panel then shows "Engine check: available once setup is finished." instead of the
   * verdict, and Rust adds no "config could not be read" note. False when doctor did not say.
   */
  configMissing: boolean;
  /** Non-fatal trouble, in the app's own words. */
  notes: string[];
}

export interface ProbeResult {
  root: ProtectedRootKey;
  path: string;
  access: DirAccess;
  recorded: boolean;
  note: string | null;
}

export type AccessError =
  | { kind: "engine"; detail: string }
  | { kind: "unsupported"; detail: string }
  | { kind: "noManagedEngine"; detail: string }
  | { kind: "opener"; detail: string }
  | { kind: "store"; detail: string }
  /** B8 (T16): the wizard's draft paths were refused before anything ran. */
  | { kind: "invalidDraft"; detail: string };

/**
 * What the panel knows about folder access — and the once-per-launch post-update check.
 *
 * ⚠ THREE ENGINE SPAWNS (`status --json`, `doctor --json`, `schedule status --json`), the middle
 * one being a repo walk that can take up to 20 s. Call it on mount and from the Re-check button;
 * never on a timer, and never from the `state:changed` handler.
 *
 * ⚠ IT ADVANCES THE RECORDED APP VERSION — unless doctor's repo walk TIMED OUT, in which case the
 * recorded version is left alone (round 1: `roots` is empty then, no display path can show the
 * notice, and advancing anyway consumed it unseen). So the first call after an update whose walk
 * FINISHES reports `versionChange.kind === "changed"`; every later one reports `"same"`, which
 * means a manual Re-check replaces a `changed` snapshot with a `same` one and the notice goes
 * away — the launch-time gate is `launchActions`, not this call.
 */
export function accessSnapshot(draft?: string[]): Promise<AccessSnapshot> {
  // `draft` (B8, T16): paths the WIZARD's not-yet-saved draft names (`repos` + `discoverRoots`
  // as typed), unioned into scope Rust-side so the wizard's folder-access step can guide grants
  // for a configuration that exists nowhere on disk yet. Bounded and character-checked in Rust
  // before any engine spawn; omitted by every non-wizard caller.
  return invoke<AccessSnapshot>("access_snapshot", draft !== undefined ? { draft } : {});
}

/**
 * Read one protected folder from the app process — on macOS, the system prompt's trigger.
 *
 * ⚠ CALL THIS ONLY FROM THE GUIDED FLOW, OR WHEN `probeAdvice` SAYS `revocation-check`. Rust cannot
 * tell a guided click from an ungated one; `launchActions` is what honours plan R1's rule, and a
 * call outside it is an unexplained system dialog.
 */
export function accessProbe(root: ProtectedRootKey): Promise<ProbeResult> {
  return invoke<ProbeResult>("access_probe", { root });
}

/** Reveal the managed engine copy in Finder. Its path is re-read from `schedule status --json`. */
export function accessRevealEngine(): Promise<string> {
  return invoke<string>("access_reveal_engine");
}

/** Open one of three fixed System Settings panes. Returns the URL that was opened. */
export function accessOpenSettings(pane: SettingsPane): Promise<string> {
  return invoke<string>("access_open_settings", { pane });
}

/* ── the rules ────────────────────────────────────────────────────────────────────────────────── */

/** What a launch should do about access, given the snapshot Rust just answered with. */
export interface LaunchActions {
  /** Read a protected folder now — ONLY as a revocation check. */
  probe: ProtectedRootKey | null;
  /** Say that macOS may have dropped the grant because the app version changed. */
  postUpdateNotice: boolean;
}

/**
 * Plan R1's launch rules, on the webview side.
 *
 * ⚠ `probe` MIRRORS RUST'S GATE AND ADDS NOTHING. `probeAdvice` is already the two-input decision
 * (`access::probe_advice`: in scope AND a grant recorded); re-deriving it here from `roots` and
 * `grantObserved` would be a second copy that could disagree with the one the Rust tests pin.
 *
 * ⚠ THE POST-UPDATE NOTICE IS CONDITIONAL ON SCOPE. A new version with nothing protected in scope
 * has no grant to have lost, and telling the user about one would be a warning with no action.
 */
export function launchActions(snapshot: AccessSnapshot): LaunchActions {
  if (!snapshot.supported) return { probe: null, postUpdateNotice: false };
  return {
    probe: snapshot.probeAdvice === "revocation-check" ? snapshot.probeRoot : null,
    postUpdateNotice: snapshot.versionChange.kind === "changed" && snapshot.roots.length > 0,
  };
}

/** One sentence for a directory read's answer. Plain text; the engine's advice is shown separately. */
export function describeAccess(result: ProbeResult): string {
  switch (result.access.kind) {
    case "ok":
      return `Daily Briefing can read ${result.path}.`;
    case "denied":
      return `Daily Briefing cannot read ${result.path}. macOS is refusing it, which is what the steps below fix.`;
    case "notFound":
      return `${result.path} does not exist on this Mac, so there is nothing to grant access to.`;
    case "notADirectory":
      return `${result.path} is not a folder, so it cannot be read as one.`;
    case "error":
      return `${result.path} could not be read (${result.access.detail}).`;
  }
}

/** One sentence for a rejection from these commands. Plain text. */
export function describeAccessFailure(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  if (typeof e !== "object" || e === null) return JSON.stringify(e);
  const tagged = e as Record<string, unknown>;
  const detail = typeof tagged.detail === "string" ? tagged.detail : "";
  switch (tagged.kind) {
    case "engine":
    case "store":
    case "opener":
    case "unsupported":
    case "invalidDraft":
      return detail;
    case "noManagedEngine":
      return `${detail} Install the background scheduler first — the copy it makes is the file macOS needs to know about.`;
    default:
      return JSON.stringify(e);
  }
}
