// src/attemptBounds.ts — how long ONE provider attempt can take, whichever way it ends (provider fallback, hub Q24;
// spec r9j §5 step 4). Shared by the walk's per-attempt deadline (src/core.ts `attemptDeadlineMs`) and the run lock's
// heartbeat cap (src/runlock.ts), so the deadline and the time the lock is kept fresh for it cannot drift apart.
//
// ⚠ A deadline must NEVER cut an attempt today's code would settle. The CLI term mirrors `recapCallDeadlineMs`
// (src/recapBudget.ts): one `hardenedProvider.generate` probes `--help` once (bounded by PROBE_MS, then its flush) and
// spawns at most twice (the cwd respawn), each spawn settling within `t + KILL_GRACE_MS + flushWindowMs(false)` —
// plus the key bound in front. Measured at the P1-M6 checkpoint: the earlier `key + t + grace` cut an 8 s probe plus a
// held-pipe flush 11 s short.
import { KEY_COMMAND_TIMEOUT_MS } from "./apiKey";
import { PROBE_MS, PROBE_FLUSH_MS } from "./probe";
import { KILL_GRACE_MS, flushWindowMs } from "./provider";
import { sanitizeTimeoutMs } from "./recapBudget";
import type { ListEntry } from "./providerList";

/** An HTTP attempt's overrun past its own timeout, budgeted. MEASURED 2026-10-16 (bun 1.3.14, loopback): a POST
 *  stalled before its headers, and one stalled mid-body, each rejected 2–4 ms after `postJson`'s timeout fired (ten
 *  runs of each). 1 s is ~250× that. */
export const API_TRANSPORT_MARGIN_MS = 1_000;

/** A CLI attempt's worst case at timeout `t`: key + `--help` probe and flush + two spawns, each `t + kill grace +
 *  post-exit flush`. */
export function cliAttemptBoundMs(timeoutMs: number): number {
  return KEY_COMMAND_TIMEOUT_MS + PROBE_MS + PROBE_FLUSH_MS + 2 * (sanitizeTimeoutMs(timeoutMs) + KILL_GRACE_MS + flushWindowMs(false, {}));
}

/** An API attempt's worst case at timeout `t`: key + the transport's own timeout + the measured margin. */
export function apiAttemptBoundMs(timeoutMs: number): number {
  return KEY_COMMAND_TIMEOUT_MS + sanitizeTimeoutMs(timeoutMs) + API_TRANSPORT_MARGIN_MS;
}

/** The larger of the two, for a bound that does not know the entry's kind (the heartbeat cap). */
export function attemptBoundMs(timeoutMs: number): number {
  return Math.max(cliAttemptBoundMs(timeoutMs), apiAttemptBoundMs(timeoutMs));
}

// ── `provider test`: the probe's timeout, and the app's bound for the whole Test (spec r9 §6) ─────────────────────
// Here rather than in src/providerCli.ts (which re-exports them) so `config validate` (src/json.ts) can report the
// app-side bound per entry from the same constants (PR 2 final harden round 1, B1): the app never re-implements
// "loopback" (`ListEntry.isLoopback`, src/providers/endpoint.ts `isLoopbackHost`) or the effective `timeoutMs`.

/** A remote entry's Test timeout (spec r9 §6 "Timeouts: remote 60 s"), whatever the entry's own `timeoutMs`. */
export const PROBE_REMOTE_TIMEOUT_MS = 60_000;
/** The app's cap on a loopback Test's bound (plan Q12, P3-M1-T1: "capped at a named maximum (30 min)"). No shared
 *  constant exists — the app's lives in its Rust, which this engine cannot import — so the value is restated here. */
export const APP_LOOPBACK_TEST_CAP_MS = 30 * 60_000;
/** What the app adds to a loopback Test's probe timeout for its own bound (spec §6, amended at the P2-M4 checkpoint). */
export const APP_LOOPBACK_TEST_EXTRA_MS = 17_000;
/** The largest probe timeout a loopback Test runs under, so the app's bound (`probe + 17 s`) stays under its 30-minute
 *  cap: a hand-edited `timeoutMs` above it would otherwise make every Test answer arrive after the app gave up. */
export const PROBE_LOOPBACK_MAX_TIMEOUT_MS = APP_LOOPBACK_TEST_CAP_MS - APP_LOOPBACK_TEST_EXTRA_MS;
/** The app's bound on a remote or CLI entry's Test: the engine's worst case (≈ 72.5 s, src/providerCli.ts
 *  `probeDeadlineMs`) + 5 s, rounded up (spec §6, amended at the P2-M4 checkpoint). */
export const APP_REMOTE_TEST_TIMEOUT_MS = 80_000;

/** The transport timeout a Test of `entry` runs under (spec r9 §6): 60 s for a remote entry — every CLI entry is
 *  remote — and a loopback entry's own `timeoutMs` (a local model may legitimately take minutes to load), capped at
 *  `PROBE_LOOPBACK_MAX_TIMEOUT_MS` so the answer arrives inside the app's capped bound (plan Q12). PURE. */
export function probeTimeoutMs(entry: Pick<ListEntry, "isLoopback" | "timeoutMs">): number {
  return entry.isLoopback ? Math.min(entry.timeoutMs, PROBE_LOOPBACK_MAX_TIMEOUT_MS) : PROBE_REMOTE_TIMEOUT_MS;
}

/** How long the APP waits for `provider test` of `entry` (B1; `config validate`'s `providers[].testTimeoutMs`): 80 s for
 *  a remote or CLI entry; for a loopback one its effective `timeoutMs`, capped as the probe is, + 17 s — so never more
 *  than the app's 30-minute cap. Integer milliseconds, rounded UP (r2 L3: `timeoutMs` may be fractional, and a bound
 *  rounded down could undercut the engine's worst case). PURE. */
export function appTestTimeoutMs(entry: Pick<ListEntry, "isLoopback" | "timeoutMs">): number {
  return entry.isLoopback ? Math.ceil(probeTimeoutMs(entry) + APP_LOOPBACK_TEST_EXTRA_MS) : APP_REMOTE_TEST_TIMEOUT_MS;
}
