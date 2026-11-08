/**
 * The Schedule screen's Login Items banner (spec 2026-10-11 login-items-off).
 *
 * macOS lets the user switch the background item off in System Settings › General › Login Items &
 * Extensions; launchd then cannot find the job and briefings silently stop. The ENGINE decides this
 * (`schedule status --json`'s `registeredHint`, `src/schedule/status.ts`); this file only reads that one
 * field from the raw envelope the watcher passes through untouched (`Snapshot.schedule`) and supplies the
 * copy. Read here rather than through `ScheduleState` so the Rust shell needs no change for it.
 *
 * ⚠ TEXT ONLY, NO "Open Login Items" BUTTON. The only URL opener the webview may reach is
 * `access_open_settings`, whose closed enum names three Privacy panes and not Login Items; adding a
 * member, a command or a capability is out of scope by the spec's rule.
 */

/** ⚠ A MIRROR of the engine's `LOGIN_ITEMS_OFF_HINT` (`src/schedule/units.ts`) — the webview cannot import
 *  the engine. `gui/tests-web/render.check.ts` pins the two to one string. */
export const LOGIN_ITEMS_OFF_HINT =
  "Probably switched off in System Settings › General › Login Items & Extensions ('daily-briefing'). Switch it on to get briefings.";

/** The banner text when the raw `schedule status --json` envelope carries the hint, else `null` — an older
 *  engine (no field), a missing envelope and every other value alike. */
export function loginItemsOffHint(schedule: unknown): string | null {
  if (typeof schedule !== "object" || schedule === null) return null;
  return (schedule as { registeredHint?: unknown }).registeredHint === "login-items-off" ? LOGIN_ITEMS_OFF_HINT : null;
}
