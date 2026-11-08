// src/calendar/status.ts — the calendar's configuration plus each source's LAST SCHEDULED read (v0.3.0 plan M5; spec
// r4 §3 "Health", §8). One builder for three surfaces, so they cannot disagree: `calendar status --json` (the whole
// `CalendarStatusJson`), and the `calendar` block of `status --json` and `doctor --json`.
//
// Reads only: the config value it is handed and `<state>/calendar/health.json`. No network, no prompt, no write.
// Never a URL: a link's `name` passes the calendar link scrub (a schemeless address can sit in a name — the resolver
// refuses only `://`), and the config warnings are `resolveCalendar`'s fixed texts.
import { resolveCalendar, type ResolvedCalendar } from "./config";
import { readCalendarHealth } from "./health";
import { macOsSupported } from "./reader";
import { scrubCalendarLinks } from "./link-scrub";
import { CALENDAR_MACOS_SOURCE_ID } from "./render-contract";
import type { CalendarLastRead, CalendarStatusJson } from "./types";

/** A link's display name as any calendar surface prints it: scrubbed of anything link-shaped. */
export function shownLinkName(name: string | undefined): string | undefined {
  return name === undefined ? undefined : scrubCalendarLinks(name);
}

/** True when the raw block carries an `enabled` the resolver reads as a value: an OWN data property that is not
 *  `null` (config.ts's `own()` rule). Read by descriptor, so an accessor is never invoked (and is not a value).
 *  A value whose inspection throws (a hostile or revoked Proxy) is not set, as `resolveCalendar`'s catch reads it
 *  off: `calendarStatus` never throws. */
function enabledIsSet(raw: unknown): boolean {
  try {
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
    const d = Object.getOwnPropertyDescriptor(raw, "enabled");
    return d !== undefined && "value" in d && d.value !== null && d.value !== undefined;
  } catch {
    return false;
  }
}

/** `CalendarStatusJson` for this raw `calendar` config value. Never throws. `platform` and `osRelease` default to this
 *  machine's (`os.release()`); `calendar status --json` passes its deps' so tests can set both. */
export async function calendarStatus(
  raw: unknown, stateDir: string, opts: { platform?: NodeJS.Platform; osRelease?: string; resolved?: ResolvedCalendar } = {},
): Promise<CalendarStatusJson> {
  const platform = opts.platform ?? process.platform;
  const resolved = opts.resolved ?? resolveCalendar(raw, { platform });
  const health = await readCalendarHealth(stateDir);
  const last = (id: string, kind: "macos" | "link"): CalendarLastRead | null => {
    const s = health.scheduled?.sources.find((x) => x.id === id && x.kind === kind);
    if (!health.scheduled || !s) return null;
    return {
      at: health.scheduled.at, status: s.status,
      ...(s.notices?.length ? { notices: [...s.notices] } : {}),
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
    };
  };
  const sources: CalendarStatusJson["sources"] = [];
  if (resolved.macos !== undefined && platform === "darwin") {
    sources.push({ id: CALENDAR_MACOS_SOURCE_ID, kind: "macos", lastScheduledRead: last(CALENDAR_MACOS_SOURCE_ID, "macos") });
  }
  for (const l of resolved.links) {
    const name = shownLinkName(l.name);
    sources.push({ id: l.id, kind: "link", ...(name !== undefined ? { name } : {}), lastScheduledRead: last(l.id, "link") });
  }
  return {
    schemaVersion: 1, enabled: resolved.enabled, enabledSet: enabledIsSet(raw),
    // `calendar connect mac`'s own check (cli.ts), so the app offers Mac Calendar only where connect can work.
    macSupported: platform === "darwin" && macOsSupported(opts.osRelease),
    configWarnings: [...resolved.warnings], sources,
  };
}
