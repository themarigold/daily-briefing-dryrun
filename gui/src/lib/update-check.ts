/**
 * Phase E (E12) — the opt-in update check, webview side: the wording, and the reading of the two
 * payloads that carry a result. Pure, so `tests-web/update.check.ts` pins it.
 *
 * ⚠ THE WEBVIEW NEVER MAKES THE REQUEST. The ENGINE does (`src/updateCheck.ts`): the app's
 * capability grants `engine_update_check` (`update --check --json`, the "Check now" button) and the
 * CSP (`tauri.conf.json`, `default-src 'self'`) permits no remote connection at all. This module
 * only words what the engine reported.
 *
 * ⚠ NOTHING HERE STARTS A CHECK. The one call site of `updateCheck()` is the Check-now handler in
 * `UpdateCheck.svelte`; the wizard's consent step only records an answer in the draft, and a fresh
 * profile therefore makes no request until the user both answers "yes" AND a scheduled run DELIVERS a
 * briefing with a check due (Phase E M5b: never after a skipped or failed run) — or presses the button.
 *
 * ⚠ EVERY STRING FROM THE ENGINE IS RENDERED AS TEXT (`docs/gui-seam.md` §5). `latest` and `url`
 * arrived over a network; the engine already bounds them (a version string; this project's release
 * page), and they are still `{}`-interpolated, never `{@html}`, and never made into a link the
 * webview would navigate to.
 */
import type { EngineOutcome, StatusReport, UpdateCheckResult } from "./engine";

const STATUSES = ["up-to-date", "newer", "unknown"] as const;

/** A result object, checked field by field — the engine's `update --check --json` payload or
 *  `status --json`'s `updateCheck`. `null` for anything that is not one (a missing payload, an older
 *  engine without the field, a corrupt record the engine already reported as `null`). */
export function parseUpdateResult(v: unknown): UpdateCheckResult | null {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (!STATUSES.includes(o.status as UpdateCheckResult["status"])) return null;
  if (typeof o.current !== "string" || typeof o.checkedAt !== "string") return null;
  return {
    status: o.status as UpdateCheckResult["status"],
    current: o.current,
    ...(typeof o.latest === "string" ? { latest: o.latest } : {}),
    ...(typeof o.url === "string" ? { url: o.url } : {}),
    checkedAt: o.checkedAt,
  };
}

/** The last recorded answer, from a `status()` outcome — `null` when there is none to show. */
export function updateFromStatus(outcome: EngineOutcome<StatusReport> | null): UpdateCheckResult | null {
  return parseUpdateResult(outcome?.payload?.updateCheck ?? null);
}

/** `checkedAt` for a human — local date and time; the raw value when it does not parse. */
export function checkedAtLine(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The one line the Settings panel shows for a result (or for none yet). */
export function updateLine(r: UpdateCheckResult | null): string {
  if (r === null) return "No update check has run yet.";
  const when = ` (checked ${checkedAtLine(r.checkedAt)})`;
  switch (r.status) {
    case "newer":
      return `A newer version is available: ${r.latest ?? "?"} — you have ${r.current}${when}.`;
    case "up-to-date":
      return `Up to date — you have ${r.current}, the latest release${when}.`;
    default:
      return `The last check could not be completed — GitHub did not answer, or its answer could not be read${when}. Nothing was downloaded.`;
  }
}

/** Where a newer release is, as text to copy — only for a `newer` result that carries one. */
export function releasePage(r: UpdateCheckResult | null): string | null {
  return r !== null && r.status === "newer" && typeof r.url === "string" ? r.url : null;
}

/* ── the first-run consent step ──────────────────────────────────────────────────────────────── */

/** The consent step's title. */
export const CONSENT_TITLE = "Check for new versions?";

/**
 * The consent step's copy, paragraph by paragraph — exported so the test can pin it against the
 * request the engine actually builds (`src/updateCheck.ts`'s `query`).
 *
 * ⚠ IT SAYS EXACTLY WHAT IS SENT, AND NOTHING THAT IS NOT TRUE. The request carries the engine's
 * version in its User-Agent and no identifier. Two further facts are stated rather than rounded
 * away: GitHub sees the request's IP address (true of any request), and repeat checks send back
 * GitHub's own cache tag for the release (`If-None-Match`, the same value for every client).
 */
export const CONSENT_PARAGRAPHS: readonly string[] = [
  "Daily Briefing can check whether a newer version has been released. It only tells you: nothing is ever downloaded or installed.",
  "What is sent: one HTTPS request to api.github.com asking for this project's latest release. It carries the engine's version number in its User-Agent header (daily-briefing/<version>) and nothing else about you — no account, no machine or install ID, nothing about your repositories or briefings. As with any web request, GitHub sees your IP address; after the first check the request also sends back GitHub's own cache tag for the release, which is the same for everyone.",
  "If you say yes, the background schedule checks at most once a day by default, right after it has delivered that day's briefing — never on a run that skipped or failed. No briefing ever waits for it, and neither do you: Run now and a run in a terminal never check. Saying no means no check is ever made on its own. Either way, the Settings screen can change this, or check once by hand.",
];

/** The two answers, in the order shown. "No" comes first and is the default. */
export const CONSENT_NO = "No — don't check for new versions";
export const CONSENT_YES = "Yes — check for new versions and tell me";
