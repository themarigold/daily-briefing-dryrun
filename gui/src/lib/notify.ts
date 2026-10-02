/**
 * T18/T19 — the webview's view of the app's notification opt-in and the autostart toggle.
 *
 * ⚠ NO DECISION LIVES HERE. Which snapshot fires a notification, the never-notify table, the
 * dedupe and the engine-ownership predicate are all Rust (`src-tauri/src/notifications.rs`);
 * this file carries the wire types, the invoke wrappers and the WORDING for the states the
 * Settings/Schedule UI shows. A TypeScript copy of the ownership predicate is exactly the drift
 * `docs/gui-seam.md` §4 warns about — `notifyStatus().engine.willNotify` IS the predicate's
 * answer, computed once, in Rust.
 *
 * ⚠ THE AUTOSTART CALLS (Phase E M5b): the READ is the plugin's own `is_enabled` (the one
 * autostart plugin grant left, `autostart:allow-is-enabled`) — the REAL state, a stat of the
 * LaunchAgent plist, which is why the toggle re-asks on every render instead of caching a
 * boolean. ON/OFF are the APP command `autostart_set_enabled`, which on macOS also brands the
 * plist the plugin writes (`AssociatedBundleIdentifiers`, `src-tauri/src/autostart.rs`) — the
 * plugin's own `enable`/`disable` are no longer granted, so there is no unbranded ON. The wizard's
 * last step reads its pre-tick from `autostart_wizard_default`. There is no
 * `@tauri-apps/plugin-autostart` JS package in this build — plain `invoke` calls need no client
 * library.
 */
import { invoke } from "@tauri-apps/api/core";

/** One suppressed firing, for the "a notification was withheld" line. */
export interface Suppressed {
  class: "delivered" | "failed" | "blocked";
  date: string;
  reason: "never-asked" | "disabled" | "engine-notifies" | "post-failed";
}

/** What the ENGINE's `notify` config resolves to — computed in Rust, displayed here. */
export interface EngineNotifyProbe {
  value: "off" | "auto" | "custom" | "invalid" | "no-config" | "unreadable";
  /** `notifyArgv(...) !== null` on this platform: true = the engine's setting claims the
   *  delivery — the engine is the one EXPECTED to post its own notification, if your setup
   *  shows its banner (deviation 119: the osascript banner may not post from a launchd agent)
   *  — and the app suppresses its DELIVERED banner either way. */
  willNotify: boolean;
}

export interface NotifyStatus {
  /** The app's opt-in: `null` = never asked (the UI surfaces the explained ask). */
  enabled: boolean | null;
  engine: EngineNotifyProbe;
  suppressed: Suppressed[];
}

/** One `status --json` spawn (to locate the config) plus a local read — never on a timer. */
export function notifyStatus(): Promise<NotifyStatus> {
  return invoke<NotifyStatus>("notify_status");
}

/** The explained ask's answer — a user gesture in Settings/Schedule (and B8's wizard step). */
export function notifySetEnabled(enabled: boolean): Promise<{ enabled: boolean | null }> {
  return invoke<{ enabled: boolean | null }>("notify_set_enabled", { enabled });
}

/* ── the login item: the plugin's read, and the app's two commands ───────────────────────────── */

/** REAL state: a stat of `~/Library/LaunchAgents/<app name>.plist` — never cached app-side. */
export function autostartIsEnabled(): Promise<boolean> {
  return invoke<boolean>("plugin:autostart|is_enabled");
}

/** Turn the login item on (writes the plist and, on macOS, labels it as this app) or off
 *  (removes it), and record that a choice was made. The Settings toggle and the wizard's last
 *  step both come through here. After an OFF from Settings the caller offers engine
 *  `notify: "auto"` (T11 rework): with autostart off, the app may not be running at 07:20 to
 *  notify. */
export function autostartSetEnabled(enabled: boolean): Promise<void> {
  return invoke<void>("autostart_set_enabled", { enabled });
}

/** The wizard's initial "Start Daily Briefing at login" value: ON for a fresh install (plan R1),
 *  otherwise the REAL current state — so finishing the wizard again never re-creates a login item
 *  the user removed. A READ: it enables nothing. It REJECTS when a choice is recorded but the
 *  current state cannot be read; the wizard then changes nothing unless the user chooses
 *  (`lib/wizard.ts`'s `loginItemPlan`). */
export function autostartWizardDefault(): Promise<boolean> {
  return invoke<boolean>("autostart_wizard_default");
}

/* ── the wording, pure so `tests-web` can pin it ──────────────────────────────────────────────── */

/** The explanation the ask carries — shown BEFORE any notification can exist. Plan T18's
 *  "requested with an explanation, never on first fire": nothing posts, and no OS prompt can
 *  appear, until this has been answered with Enable. */
export const NOTIFY_ASK_EXPLANATION =
  "Daily Briefing can show a system notification when your morning briefing arrives — and when " +
  "a run fails or is blocked, so a silent morning is never a mystery. Nothing is shown until " +
  "you turn this on; macOS may ask for its own permission the first time one appears.";

/** One line for the engine's resolved notify value, so Settings can say who notifies.
 *
 *  ⚠ THE willNotify LINE IS HEDGED, DELIBERATELY (deviation 119): the engine's own header says
 *  its macOS "auto" banner (osascript) "may not post at all from a launchd agent" — which is
 *  exactly how the engine runs — so this copy must not promise the engine's banner works, only
 *  that the app stays quiet because the engine's setting claims the delivery. */
export function engineNotifyLine(probe: EngineNotifyProbe): string {
  if (probe.willNotify) {
    return "The engine's own notification setting is active on this platform, so the engine " +
      "is the one expected to post the arrival notification — if your setup shows its banner — " +
      "and this app stays quiet about deliveries (failures are still this app's to report).";
  }
  switch (probe.value) {
    case "auto":
      // `willNotify` false with "auto" configured: the platform resolves it to nothing.
      return 'The engine\'s notification setting is "auto", which posts nothing on this ' +
        "platform — this app is the notifier here.";
    case "custom":
      return "The engine is configured with a custom notification command that resolves to " +
        "nothing here — this app is the notifier.";
    case "invalid":
      return "The engine's configured notification setting is not one it accepts (it posts " +
        "nothing) — this app is the notifier. The Settings form below can fix the value.";
    case "no-config":
      return "The engine has no config yet, so it posts nothing itself.";
    case "unreadable":
      return "The engine's config could not be read just now, so what the engine itself would " +
        "post is unknown; this app notifies when enabled.";
    case "off":
      return "The engine's own notifications are off (the default) — this app is the notifier " +
        "when enabled here.";
  }
}

/** The one-line record of a withheld notification, newest last in `suppressed`. */
export function suppressedLine(s: Suppressed): string {
  const what =
    s.class === "delivered"
      ? `Your briefing for ${s.date} arrived`
      : s.class === "blocked"
        ? `A run on ${s.date} was blocked`
        : `A run on ${s.date} failed`;
  switch (s.reason) {
    case "never-asked":
      return `${what}, but notifications have not been enabled here yet.`;
    case "disabled":
      return `${what}; notifications are turned off here.`;
    case "engine-notifies":
      // Hedged (deviation 119): "covered it" claimed an observed post; the app only knows the
      // engine's setting claims the delivery, not that its banner appeared.
      return `${what}; the engine's own notifier is configured to cover it, so this app stayed quiet.`;
    case "post-failed":
      // ⚠ Reachable today only through the test sink (deviation 120): the shipped 2.4.0 plugin
      // discards post errors, so Rust cannot record this reason from a real failed post. The
      // string is kept for the sink path and for a future plugin version that reports errors.
      return `${what}, but the system notification could not be posted.`;
  }
}
