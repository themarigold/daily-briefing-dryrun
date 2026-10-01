// src/notify.ts — Slice 4 T7: the optional desktop notification, DEFAULT OFF.
//
// ⚠ DEFAULT "off" IS NOT TIMIDITY, it is what the CLI can honestly deliver. An `osascript` banner is
// attributed to Script Editor, cannot open a file on click without a bundled app, and may not post at
// all from a launchd agent; `notify-send` is not guaranteed present; Windows has no built-in CLI
// toast. Default-off is also what makes the GUI seam free — with the engine silent unless a human
// turned it on, the desktop app posts its own native notification and there is nothing to contend
// with.
//
// ⚠ THE BODY IS A FIXED TEMPLATE — date plus path — and NEVER briefing text. This is the standing
// terminal/prompt-injection finding, not a hypothetical: repo-controlled filenames, commit subjects
// and branch names flow raw through this codebase, and a notification body is another render surface
// that would have to re-implement the sanitization boundary. A fixed template kills the entire class
// rather than sanitizing around it. `stripControl` is applied anyway, to the path, because a path is
// the one caller-supplied component.
//
// ⚠ ZERO NEW DEPENDENCIES. Everything goes through the existing `src/proc.ts` `run()` seam — the same
// injectable OS-command runner `src/power.ts` uses — so there is nothing new to sign, notarize or
// audit, and the whole surface is testable with an injected exec.
//
// ⚠ IT WRITES NOTHING TO STDOUT OR STDERR, EVER, and that is a firewall rather than hygiene. The
// launchd plist points StandardOutPath AND StandardErrorPath at `briefing.log`, and
// `audit.lastBriefing` slices from the last "☀️ … briefing —" header to EOF as the text it grades —
// so a byte written here, after the render, would be fed to the audit judge as part of the briefing.
// `proc.run` pipes both of the child's streams (src/proc.ts:98-110) rather than inheriting them, and
// nothing in this module logs. The call site's `.catch(() => {})` completes the guarantee.
import { run } from "./proc";
import { stripControl } from "./render";
import type { Config } from "./types";

/** The three shapes of `Config.notify`. Additive-optional: an absent field is "off". */
export type NotifyConfig = "off" | "auto" | { command: string[] };

export type NotifyPayload = { title: string; body: string; path: string };

/** The notification title. Fixed; carries no caller text at all. */
export const NOTIFY_TITLE = "Daily Briefing";

/** How long a notifier may take before it is abandoned. Short on purpose: this runs AFTER the day is
 *  stamped, so the worst case is a cosmetic miss — but the process should not linger for it. */
export const NOTIFY_TIMEOUT_MS = 5_000;

/** THE FIXED BODY TEMPLATE. Date plus path, nothing else, ever. `stripControl` on the path because a
 *  state-dir path is the one component a caller supplies; the rest is a literal. */
export function notifyBody(dateStr: string, path: string): string {
  return `Your briefing for ${stripControl(dateStr)} is ready — ${stripControl(path)}`;
}

/** Build the payload for a delivered run. Separate from `notifyArgv` so the GUI-suppression predicate
 *  (below) can be evaluated without inventing a payload. */
export function notifyPayload(dateStr: string, path: string): NotifyPayload {
  return { title: NOTIFY_TITLE, body: notifyBody(dateStr, path), path };
}

/** AppleScript string escaping. `display notification "…"` takes an AppleScript string literal, so a
 *  backslash or a double quote in the path would terminate it early — and the path is the one piece of
 *  the body that is not a literal. Order matters: backslashes first. */
function applescriptString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Substitute the three placeholders inside ONE argv element.
 *
 *  ⚠ PER-ELEMENT, never across elements, and never through a shell. A value containing a space or a
 *  semicolon stays ONE argument — that is the whole reason `command` is `string[]` and not a command
 *  line, and `test/notify.test.ts` pins it with exactly such a value. There is no `sh -c` anywhere in
 *  this module. */
function substitute(element: string, p: NotifyPayload): string {
  return element
    .replaceAll("{title}", p.title)
    .replaceAll("{body}", p.body)
    .replaceAll("{path}", p.path);
}

/** Normalise whatever the config carried into one of the three shapes, or `null` when it is absent,
 *  "off", or malformed. TOTAL — a typo'd notify block must degrade to silence, never throw on the
 *  delivery path (the B1 style `resolveTranscripts`/`resolveProbeHosts` already use).
 *
 *  A malformed value returns a WARNING alongside, which `config validate --json` surfaces; the
 *  pipeline itself only needs the resolved value. */
export function resolveNotify(raw: unknown): { cfg: NotifyConfig; warning?: string } {
  if (raw === undefined || raw === null || raw === "off") return { cfg: "off" };
  if (raw === "auto") return { cfg: "auto" };
  if (typeof raw === "object" && !Array.isArray(raw)) {
    const cmd = (raw as { command?: unknown }).command;
    if (Array.isArray(cmd) && cmd.length > 0 && cmd.every((x) => typeof x === "string")) {
      return { cfg: { command: cmd as string[] } };
    }
  }
  return {
    cfg: "off",
    warning: `invalid notify ${JSON.stringify(raw)} — expected "off", "auto" or { command: [string, …] }; notifications are disabled`,
  };
}

/**
 * THE PURE RESOLVER, and the GUI's suppression predicate.
 *
 * ⚠ THE DESKTOP APP SUPPRESSES ITS OWN NOTIFICATION ONLY WHEN THIS RETURNS NON-NULL (plan T18,
 * resolved-capability form). "Configured ≠ off" is NOT the test: `notify: "auto"` on Windows resolves
 * to nothing at all, so keying suppression off the CONFIG VALUE would produce a double silence — the
 * engine posting nothing because it cannot, and the app posting nothing because it thought the engine
 * would. Keying off the RESOLVED capability cannot produce that.
 *
 * ⚠ PURE by contract — no PATH lookup, no filesystem, no clock — because the GUI evaluates it as a
 * predicate, and a predicate that spawns `which` is not one. That leaves ONE residual, stated rather
 * than hidden: on Linux, `"auto"` resolves to a `notify-send` argv whether or not that binary is
 * installed, so on a Linux box without it the engine posts nothing while an app keying on this would
 * have suppressed itself. It is a narrow case and not a contended one — a Linux machine running the
 * desktop app has a notification daemon, and an `--invoker app` install leaves engine notify "off"
 * anyway (plan T18), so the app is the notifier in exactly the configuration where both exist.
 * `notify()` below checks PATH before spawning, so the engine never spawns a missing binary.
 */
export function notifyArgv(
  platform: NodeJS.Platform,
  cfg: Pick<Config, "notify">,
  payload: NotifyPayload,
): string[] | null {
  const { cfg: resolved } = resolveNotify(cfg.notify);
  if (resolved === "off") return null;
  if (typeof resolved === "object") {
    const argv = resolved.command.map((e) => substitute(e, payload));
    // A command whose executable substituted away to "" is not a command.
    return argv[0] ? argv : null;
  }
  // "auto" — best effort, per platform.
  if (platform === "darwin") {
    return [
      "osascript",
      "-e",
      `display notification "${applescriptString(payload.body)}" with title "${applescriptString(payload.title)}"`,
    ];
  }
  if (platform === "linux") return ["notify-send", payload.title, payload.body];
  return null;   // win32 and everything else: no built-in CLI toast. Honest null beats a broken argv.
}

export type NotifyDeps = {
  platform?: NodeJS.Platform;
  /** Injected for tests AND for the PATH check below; defaults to `proc.run`. */
  exec?: (cmd: string[], opts?: { timeoutMs?: number }) => Promise<{ code: number }>;
  /** Resolve a bare command name on PATH, or `undefined`. Injected so the Linux branch is testable
   *  off Linux and so no test ever depends on the runner's PATH. */
  which?: (cmd: string) => Promise<string | undefined>;
};

/**
 * Post the notification, best effort.
 *
 * ⚠ TOTAL — it swallows everything, logs nothing, and returns whether it spawned so a TEST can assert
 * the decision. The call site adds `.catch(() => {})` on top; two layers because the failure being
 * defended against is a hung notifier costing a morning that has ALREADY been delivered and stamped.
 */
export async function notify(
  cfg: Pick<Config, "notify">,
  payload: NotifyPayload,
  deps: NotifyDeps = {},
): Promise<boolean> {
  try {
    const platform = deps.platform ?? process.platform;
    const argv = notifyArgv(platform, cfg, payload);
    if (!argv) return false;
    // Only for a BARE command name (no separator): an absolute path the user configured is theirs to
    // get right, and `which` would answer for the wrong thing.
    const head = argv[0]!;
    if (!head.includes("/") && !head.includes("\\")) {
      const which = deps.which ?? (async (c: string) => {
        const r = await run(["which", c], { timeoutMs: NOTIFY_TIMEOUT_MS });
        const first = r.code === 0 ? r.out.trim().split("\n")[0] : undefined;
        return first || undefined;
      });
      if (!(await which(head))) return false;   // absent notifier ⇒ silence, never an error
    }
    const exec = deps.exec ?? ((cmd: string[], o?: { timeoutMs?: number }) => run(cmd, o));
    await exec(argv, { timeoutMs: NOTIFY_TIMEOUT_MS });
    return true;
  } catch {
    return false;   // a notification must never be the reason anything else fails
  }
}
