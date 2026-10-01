/**
 * The colour a derived state is painted in — informational · attention · problem.
 *
 * Moved here verbatim from `routes/Schedule.svelte` (B5) because the Today screen shows the same
 * `statusLine` badge, and the two screens must not colour one state two ways. It is presentation
 * only: which phase applies is `schedule_state::derive`'s decision, in Rust.
 *
 * ⚠ WAITING-FOR-WAKE IS INFORMATIONAL. It is the ordinary morning where the laptop was shut at
 * the floor; the appendix's stated risk for this screen is a GUI that renders it as an error.
 */
import type { ScheduleState } from "./state";

export type Tone = "info" | "warn" | "bad";

export function tone(s: ScheduleState): Tone {
  switch (s.phase.phase) {
    case "delivered":
    case "waiting-for-floor":
    case "waiting-for-wake":
      return "info";
    case "unknown-tick":
      return "warn";
    case "not-configured":
    case "config-error":
    case "not-scheduled":
    case "scheduler-broken":
    case "agent-stale":
      return "bad";
    case "skipped":
      // ⚠ `darkwake` AND `offline` ARE ORDINARY. The engine will retry at the next tick and the
      // briefing still arrives; painting them red teaches the user to ignore the colour.
      return s.phase.reason === "offline" || s.phase.reason === "darkwake" ? "info" : "warn";
  }
}
