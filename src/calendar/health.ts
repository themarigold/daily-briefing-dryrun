// src/calendar/health.ts — `<state>/calendar/health.json`, each source's LAST READ per trigger (v0.3.0 plan M4;
// spec r4 §3 "Health", §8 "last scheduled read").
//
// Written ONLY by an owned run (`deps.provider === undefined` in `runCore`) — never by the eval, never by a test
// that injects its provider, never by `calendar test` (an attended read is not evidence that the unattended path
// works). Read by `calendar status --json`, `status --json` and `doctor --json`, which show the LAST SCHEDULED read
// ("not yet", "ok at 07:21", or the failure).
//
// ⚠ WHAT IT HOLDS, AND ALL IT HOLDS: per source, its id (the link's configured id, whose grammar admits no feed
// text, or `macos`), its kind, its read status, its notices and a machine reason CODE (from the fixed vocabularies of
// `./link-url.ts`, `./link-fetch.ts` and the parse step) — plus the time and the trigger. Never a URL, a title, an
// attendee or a description: nothing in this module accepts one, and `test/calendar-step.test.ts` drives a
// sentinel-rich feed through a real step and searches the written file.
//
// The two triggers are kept SEPARATELY so a manual run (the app's "Run now", a terminal `--force`) cannot overwrite
// the scheduled record the Settings screen exists to show. Written atomically (a temp file, then rename), the folder
// 0700 and the file 0600. Every read is total: a missing or corrupt file reads as "no record".
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import type { CalendarReadStatus, CalendarSourceKind, CalendarSourceNotice } from "./types";

export type CalendarHealthSource = {
  id: string;
  kind: CalendarSourceKind;
  status: CalendarReadStatus;
  notices?: CalendarSourceNotice[];
  /** A machine reason code (`file-missing`, `http-refused`, `parse-error`, …). Never text taken from a feed. */
  reason?: string;
};

export type CalendarHealthRun = { at: string; trigger: "scheduled" | "manual"; sources: CalendarHealthSource[] };

export type CalendarHealth = { schemaVersion: 1; scheduled: CalendarHealthRun | null; manual: CalendarHealthRun | null };

/** `<state>/calendar`. */
export function calendarStateDir(stateDir: string): string {
  return join(stateDir, "calendar");
}

/** `<state>/calendar/health.json`. */
export function calendarHealthPath(stateDir: string): string {
  return join(calendarStateDir(stateDir), "health.json");
}

const READ_STATUSES: ReadonlySet<string> = new Set<CalendarReadStatus>([
  "ok", "not-granted", "write-only", "denied", "restricted", "unsupported-os", "helper-missing", "timeout", "offline",
  "link-refused", "link-redirected", "malformed", "too-large", "incomplete",
]);
const NOTICES: ReadonlySet<string> = new Set<CalendarSourceNotice>(["helper-outdated", "identity-unknown"]);
const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const REASON_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;

function sourceOk(x: unknown): x is CalendarHealthSource {
  if (typeof x !== "object" || x === null) return false;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) return false;
  if (o.kind !== "macos" && o.kind !== "link") return false;
  if (typeof o.status !== "string" || !READ_STATUSES.has(o.status)) return false;
  if (o.notices !== undefined && !(Array.isArray(o.notices) && o.notices.every((n) => typeof n === "string" && NOTICES.has(n)))) return false;
  if (o.reason !== undefined && !(typeof o.reason === "string" && REASON_RE.test(o.reason))) return false;
  return true;
}

function runOk(x: unknown): CalendarHealthRun | null {
  if (typeof x !== "object" || x === null) return null;
  const o = x as Record<string, unknown>;
  if (typeof o.at !== "string" || Number.isNaN(Date.parse(o.at))) return null;
  if (o.trigger !== "scheduled" && o.trigger !== "manual") return null;
  if (!Array.isArray(o.sources) || !o.sources.every(sourceOk)) return null;
  return {
    at: o.at, trigger: o.trigger,
    sources: (o.sources as CalendarHealthSource[]).map((s) => ({
      id: s.id, kind: s.kind, status: s.status,
      ...(s.notices?.length ? { notices: [...s.notices] } : {}),
      ...(s.reason !== undefined ? { reason: s.reason } : {}),
    })),
  };
}

/** The record, or an empty one when the file is missing, unreadable or malformed. Never throws. Each run is
 *  validated whole: a run with one bad source reads as no record for that trigger (the file is ours; a run that
 *  does not parse was not written by this build). */
export async function readCalendarHealth(stateDir: string): Promise<CalendarHealth> {
  const empty: CalendarHealth = { schemaVersion: 1, scheduled: null, manual: null };
  try {
    const raw = JSON.parse(await Bun.file(calendarHealthPath(stateDir)).text()) as Record<string, unknown>;
    if (typeof raw !== "object" || raw === null || raw.schemaVersion !== 1) return empty;
    return { schemaVersion: 1, scheduled: runOk(raw.scheduled), manual: runOk(raw.manual) };
  } catch {
    return empty;
  }
}

/** A reason code is kept only when it is one (lower-case letters, digits and hyphens): the vocabularies it comes
 *  from are fixed, and this stops anything else from ever reaching the file. */
export function healthReason(reason: string | undefined): string | undefined {
  return reason !== undefined && REASON_RE.test(reason) ? reason : undefined;
}

/** Record one run's outcome under its trigger, keeping the other trigger's record. Atomic; 0700 folder, 0600 file.
 *  Never throws — a health record that could not be written must never cost the briefing. */
export async function writeCalendarHealth(stateDir: string, run: CalendarHealthRun): Promise<void> {
  const dir = calendarStateDir(stateDir);
  const tmp = join(dir, `.health.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const prior = await readCalendarHealth(stateDir);
    const clean: CalendarHealthRun = {
      at: run.at, trigger: run.trigger,
      // An off-vocabulary reason is dropped BEFORE the shape check, so it costs only itself, never the source's
      // status line (integration LOW: `sourceOk` refuses a source whose reason fails REASON_RE).
      sources: run.sources.map((s) => {
        const reason = healthReason(s.reason);
        return {
          id: s.id, kind: s.kind, status: s.status,
          ...(s.notices?.length ? { notices: [...s.notices] } : {}),
          ...(reason !== undefined ? { reason } : {}),
        };
      }).filter(sourceOk),
    };
    const next: CalendarHealth = { ...prior, [run.trigger]: clean };
    const fh = await open(tmp, "wx", 0o600);
    try {
      await fh.writeFile(`${JSON.stringify(next, null, 2)}\n`);
      await fh.sync().catch(() => undefined);
    } finally {
      await fh.close().catch(() => undefined);
    }
    await rename(tmp, calendarHealthPath(stateDir));
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
  }
}
