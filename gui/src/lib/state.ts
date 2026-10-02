/**
 * The webview's view of T10's `state:changed` payload and T14's derived state.
 *
 * ⚠ **THE STATE IS COMPUTED IN RUST, ONCE.** `src-tauri/src/schedule_state.rs`'s `derive` is the
 * only place that decides what the engine's files mean; the tray status line and the Schedule
 * screen are two RENDERINGS of one `ScheduleState`. Nothing in this file recomputes a phase, a
 * staleness threshold, a tick count or a delivery date, and nothing should: a second
 * implementation in TypeScript is exactly the drift `src/json.ts`'s `StatePaths` docstring exists
 * to prevent, and the failure would be a screen that disagrees with the menu bar about whether
 * today's briefing arrived.
 *
 * ⚠ **RENDER EVERYTHING HERE AS TEXT** (`docs/gui-seam.md` §5). `Phase.detail` is the ENGINE's own
 * stderr/skip line and interpolates repo-controlled strings; `unitPath`, `floorWarning` and
 * `error` are equally attacker-influenceable in the general case. Svelte's `{}` escapes;
 * `{@html}` does not and must never appear on any of it.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * `src/json.ts`'s `SKIP_REASONS`, plus the open end.
 *
 * ⚠ `(string & {})` IS THE OPEN END, AND IT IS DELIBERATE. `schedule status --json` is frozen
 * ADDITIVE-ONLY, so a future engine may write a reason this build has never heard of; Rust maps it
 * to a typed `Unknown` carrying the raw string rather than failing, and the union mirrors that.
 * A closed union here would make the honest case a type error.
 */
export type SkipReason =
  | "already-ran"
  | "no-config"
  | "config-error"
  | "below-floor"
  | "concurrent"
  | "offline"
  | "darkwake"
  | "limited"
  | "blocked"
  | "provider-fail"
  | "parse-empty"
  | "marker-fail"
  | "crashed"
  | (string & Record<never, never>);

/** Why a heartbeat cannot be judged (`schedule_state::TickProblem`). */
export type TickProblem = "legacy" | "unreadable-instant" | "future";

/** The heartbeat line, already parsed by the engine: `<iso> local=<YYYY-MM-DD> today=<n>`. */
export interface TickLine {
  iso: string;
  localDate: string;
  count: number;
}

/** `<state>/last-skip.json`. ⚠ Its PRESENCE means nothing — switch on `reason`. */
export interface LastSkip {
  iso: string;
  localDate: string;
  reason: SkipReason;
  detail: string | null;
}

/**
 * Exactly one of these, from `schedule_state::derive`.
 *
 * ⚠ `waiting-for-wake` IS INFORMATIONAL, NEVER AN ERROR. It is the ordinary morning where the
 * laptop was shut at the floor, and the appendix's stated risk for this screen is a GUI that
 * renders it red and makes the tool feel broken every day.
 */
export type Phase =
  | { phase: "not-configured" }
  /** The config exists and does not load. `detail` is the loader's message, verbatim. A delivery
   *  that already happened today stays visible — the error outranks it, it does not erase it. */
  | { phase: "config-error"; detail: string; deliveredToday: boolean; deliveredAt: string | null }
  | { phase: "not-scheduled" }
  /** A schedule record exists, but its unit file is gone or the OS does not have it loaded
   *  (`unitPresent` / `registered` on the state say which). Nothing will run on its own. */
  | { phase: "scheduler-broken" }
  /** `at` is `briefing-latest.md`'s mtime, in UTC. */
  | { phase: "delivered"; at: string | null }
  | { phase: "waiting-for-floor"; floor: string; minutesUntilFloor: number }
  | { phase: "waiting-for-wake" }
  /** `detail` is the engine's own line, verbatim. For `limited` it names a reset time only when
   *  the engine parsed one — never synthesise one here. */
  | { phase: "skipped"; reason: SkipReason; detail: string | null; iso: string | null }
  | { phase: "agent-stale"; lastTick: string | null; staleAfterSecs: number }
  | { phase: "unknown-tick"; cause: TickProblem };

/** The whole verdict: the phase plus everything rendered beside it. */
export interface ScheduleState {
  phase: Phase;
  /** The one-line status. The tray shows exactly this, and so does the Schedule screen's badge —
   *  render it, never a mapping of your own from `phase` (or a skip token) to words. */
  statusLine: string;
  /** The floor IN FORCE (`HH:MM`). For an invalid configured value this is the default the engine
   *  uses, and `floorWarning` says so. */
  floor: string;
  floorWarning: string | null;
  /** The one sentence that says the floor SUPPRESSES rather than schedules. */
  firstWake: string;
  /** ⚠ `null`, NEVER `0`, when the heartbeat could not be parsed. Rendering a null as 0 shows a
   *  healthy machine as a dead scheduler (`docs/gui-seam.md` §2). */
  ticksToday: number | null;
  ticksExpectedSinceFloor: number | null;
  lastTick: TickLine | null;
  owner: "cli" | "app" | null;
  invoker: "cli" | "app" | null;
  unitPath: string | null;
  registered: boolean | null;
  recordPresent: boolean;
  unitPresent: boolean;
  engineVersion: string | null;
  installedEngineVersion: string | null;
  /** The "update background engine" prompt: re-run `schedule install --invoker app`, which
   *  PRESERVES the existing notify value and owner (plan R1). Only ever true for an APP-owned
   *  schedule — a CLI-owned one refreshes through install.sh. */
  engineUpdateAvailable: boolean;
  /** `null` when missing, or outside 1..86400 — an interval no staleness is computed from. */
  intervalSec: number | null;
  experimental: boolean;
  lingerState: string | null;
}

/** The `state:changed` payload, and what `state_snapshot` returns. */
export interface Snapshot {
  /** The raw `status --json` envelope, uninterpreted. */
  status: unknown | null;
  lastSkip: LastSkip | null;
  /** The raw `schedule status --json` envelope, uninterpreted, read in the SAME batch as
   *  `status` — unless `scheduleStale` is true. */
  schedule: unknown | null;
  /** True when `schedule` is the last good envelope from an EARLIER read, because this batch's
   *  `schedule status` failed (`error` says why). The per-read figures in `scheduleState`
   *  (`ticksToday`, `ticksExpectedSinceFloor`) are then `null`, i.e. unknown — never an earlier
   *  moment's numbers shown as current. Say so beside anything schedule-derived. */
  scheduleStale: boolean;
  /** `null` when `status` could not be read — there is nothing honest to derive from. */
  scheduleState: ScheduleState | null;
  /** Why part of this snapshot is missing or stale, carrying the engine's stderr verbatim where
   *  it wrote any: a `status` read that failed (every other field is then null), a
   *  `schedule status` read that failed (see `scheduleStale`), or — with `updatesStopped` — the
   *  watcher itself. Render as text. */
  error: string | null;
  /** True when live updates have STOPPED (the watcher failed) and nothing will update this
   *  snapshot again until the app restarts. The tray says so; `error` says why. */
  updatesStopped: boolean;
}

/** The Quit dialog's copy, owned in Rust (`shell::quit_dialog`) so there is one of it. */
export interface QuitDialog {
  title: string;
  body: string;
  /** The engine-notification offer's label; `null` when the notice has NO offer section — before
   *  setup is finished (Rust's `QuitCopy::NotSetUp`), where there is no engine setting to offer. */
  offerLabel: string | null;
  /** True where the offer can work (B5: not on Windows, not without a usable config or a state). */
  offerAvailable: boolean;
  offerUnavailableReason: string | null;
  /** A button that opens the Schedule screen instead of quitting — present when the body points
   *  there (nothing scheduled, a broken unit, a config that does not load, or no state yet); never
   *  before setup is finished. */
  scheduleLabel: string | null;
  confirmLabel: string;
  cancelLabel: string;
}

/** Which screen the tray asked for (`app:navigate`'s payload). */
export type NavigateTarget = "today" | "schedule" | "settings";

/** Every screen the window has. History and the first-run wizard (B8, T16) are reached from the
 *  window only — the tray menu is fixed and `NavigateTarget` did not grow (deviation 54's rule). */
export type Route = NavigateTarget | "history" | "wizard";

/* ── commands ─────────────────────────────────────────────────────────────────────────────────── */

/**
 * The current state, on demand. Called ONCE at startup; after that the watcher pushes.
 *
 * Rejects with the serialised `EngineError` when the sidecar could not be resolved — the same
 * shape every engine command uses.
 */
export function stateSnapshot(): Promise<Snapshot> {
  return invoke<Snapshot>("state_snapshot");
}

/**
 * Show and focus the window, on the Today screen (it emits `app:navigate` "today").
 *
 * ⚠ A RUST COMMAND, because this webview's capability grants no window permission at all (and
 * even `core:window:default` would not grant `show` or `set_focus`). There is no webview-side
 * equivalent.
 *
 * ⚠ NOTHING IN B4 CALLS THIS FROM THE WEBVIEW — the tray and the single-instance callback reach
 * `shell::open_today` directly, as a Rust function. It is a granted command, and this binding
 * exists, because T16's wizard and T18's notification click both need the webview to be able to
 * raise its own window and there is no other way to do it. The grant's blast radius is showing the
 * window the user is already looking at; contrast `tauri-plugin-window-state`, whose three commands
 * write to `app_config_dir` and are deliberately NOT granted (`capabilities/README.md`).
 */
export function openToday(): Promise<void> {
  return invoke<void>("open_today");
}

/**
 * Exit the app.
 *
 * ⚠ IT REFUSES UNTIL THE QUIT NOTICE HAS BEEN SHOWN THIS SESSION. Call it from the dialog's
 * confirm button and nowhere else.
 */
export function appQuit(): Promise<void> {
  return invoke<void>("app_quit");
}

/* ── events ───────────────────────────────────────────────────────────────────────────────────── */

/** A CLI run, a launchd tick or a schedule change landed (debounced ~250 ms in Rust; both
 *  envelopes re-read) — or time changed the answer: a re-derive between boundaries, a fresh read
 *  at midnight / the floor / the stale deadline, or the 5-minute re-read of an unhealthy state —
 *  or live updates stopped (`updatesStopped`). */
export function onStateChanged(handler: (snapshot: Snapshot) => void): Promise<UnlistenFn> {
  return listen<Snapshot>("state:changed", (e) => handler(e.payload));
}

/** The first quit request this session: tray Quit, the app menu's Quit (⌘Q), or closing the
 *  window where there is no tray to hide into. The copy is worded for the state Rust last
 *  announced — render it; do not add to it. */
export function onQuitRequested(handler: (dialog: QuitDialog) => void): Promise<UnlistenFn> {
  return listen<QuitDialog>("app:quit-requested", (e) => handler(e.payload));
}

/** The tray asked for a screen. */
export function onNavigate(handler: (route: NavigateTarget) => void): Promise<UnlistenFn> {
  return listen<NavigateTarget>("app:navigate", (e) => handler(e.payload));
}

/** The tray's "Run Now" was clicked. The RUN happens here, in the webview, so its progress is
 *  visible — `engine:progress` has nowhere to land otherwise. */
export function onRunNow(handler: () => void): Promise<UnlistenFn> {
  return listen<null>("app:run-now", () => handler());
}

/** The tray could not be built (delivered once, on the first `state_snapshot` after listeners are
 *  registered). The payload is the notice to show, as text. */
export function onTrayUnavailable(handler: (notice: string) => void): Promise<UnlistenFn> {
  return listen<string>("app:tray-unavailable", (e) => handler(e.payload));
}
