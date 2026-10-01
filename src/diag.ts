// src/diag.ts — THE stderr sink for a diagnostic built from text the engine did not author.
//
// T8.1 redacts the BRIEFING (`redactCredentials(renderBriefing(r.struct))`, main.ts) and main.ts's own
// comment there names sinks 1-3 as "stdout, briefing-latest.md, briefing.log". briefing.log is the one
// that was only half true: under launchd StandardOutPath AND StandardErrorPath point at it, so every
// stderr line lands in the file the redaction claim is about — and the diagnostics are built from
// `r.struct` fields, a provider CLI's own output and git-derived text, none of which pass through
// `rendered`. Measured 2026-09-16: `postcheck [suggestion-restates]: … "Rotate ghp_…"` reached stderr
// with the token intact while the briefing file and the envelope's markdown were correctly `[redacted]`.
//
// The desktop app widens it from a log file to a screen: gui/src-tauri/src/engine.rs spawns the engine
// as a child and streams its stderr to the webview VERBATIM as `engine:progress`
// ("Everything the engine wrote to stderr, verbatim"), so the engine-side fix is what covers the GUI —
// there is no second place to redact.
//
// ⚠ WHY A FUNCTION AND NOT A `console.error` PATCH AT THE ENTRY POINT. Measured on bun 1.3.14:
// `console.error` does NOT route through `process.stderr.write` (a probe that wrapped
// `process.stderr.write` captured a direct `write` and neither a `console.error` nor a `console.warn`),
// so there is no true byte-level sink to wrap — the only global option is monkey-patching `console`
// itself, which is invisible at the call site, and which the suite's own capture idiom
// (`console.error = (...) => lines.push(...)`, used in a dozen files) would silently displace. An
// explicit sink is visible in the diff, survives `runCore` being driven by the eval harness rather than
// by `run()`, and cannot be defeated by whoever replaced `console.error` last.
//
// ⚠ SCOPE — this is for UNTRUSTED text, not for every line. A message the engine wrote itself
// (a usage string, "Already ran today", a net-gate timing) has nothing to redact, and routing it here
// would say it does. The rule is the SOURCE, not the severity: model output, a provider CLI's stdout or
// stderr, a commit subject, a branch name, a repo path.
import { redactCredentials } from "./transcripts/credentials";

/** Write one diagnostic line to stderr with known-shaped credentials redacted in place.
 *
 *  REDACT, NEVER DROP — the same posture as the output-side scan: a diagnostic is how a broken morning
 *  is explained, and withholding the line would cost more than the span it was hiding. Callers keep
 *  their own `stripControl` where they already had it; the two do different jobs (control bytes vs.
 *  credential shapes) and neither subsumes the other. */
export function diagError(line: string): void {
  console.error(redactCredentials(line));
}

/** The CRASH line, for an error that escaped every handler on the way to the process entry.
 *
 *  ⚠ WHY THIS EXISTS AT ALL — `diagError` cannot reach it. An unhandled throw is printed by BUN's own
 *  top-level handler, not by any line in this codebase, so no sink of ours sees it: measured
 *  2026-09-16, a non-`ProviderError` rethrown by `run()` ("rethrow to preserve the crash exit",
 *  main.ts) printed `error: generator blew up on ghp_…` to fd 2 — which under launchd is briefing.log,
 *  the file the whole redaction claim is about. The rethrow is deliberate and stays; what changes is
 *  who prints.
 *
 *  ⚠ IT KEEPS THE STACK. The obvious objection is that catching costs the trace — measured, it does
 *  not: printing a redacted `e.stack` reproduced all three frames and the same exit code 1. What is
 *  lost is bun's two-line source EXCERPT and its version footer. The excerpt is a slice of this
 *  project's own source, never a secret, and the frame it points at is still the first line of the
 *  stack, so the trade is an excerpt for a redaction rather than a trace for a redaction.
 *
 *  NOT COVERED, deliberately: a rejection from a promise nobody awaited still reaches bun's handler.
 *  Nothing on the run path is unawaited today, and a global `unhandledRejection` hook would change
 *  crash semantics far beyond this. */
export function diagCrash(e: unknown): void {
  diagError(e instanceof Error ? (e.stack ?? `${e.name}: ${e.message}`) : String(e));
}
