// src/calendar/pipeline.ts — THE CALENDAR STEP (v0.3.0 plan M4; spec r4 §3 "Pipeline", §4.2, §5, §7).
//
// `createCalendarStep(resolved, deps)` builds the `CalendarStep` (`./step.ts`) that `runCore` runs as
// `RunDeps.calendar`: resolve the sources → read each (a link: credential ladder → fetch → `parseCalendarLink` in
// the hard-bounded child; the Mac source: the installed Calendar Reader through its FIFO hand-off, `./mac-source.ts`,
// and it does not exist off macOS, `resolveCalendar` drops it) → reconcile (gate G6's switches stay off) → the RESTRICTED
// struct (`CalendarStruct`, built field by field, never by serialising a `CalEvent`) and both prompt variants.
//
// ⚠ NEVER THROWS, ALWAYS RESOLVES. The whole read is raced against ONE overall bound measured from `ctx.startedAt`
// — the moment the network gate resolved (spec §3: "the whole step is raced against an overall 30 s bound measured
// from that moment") — and every link fetch carries its own 10 s deadline from that same moment
// (`./link-fetch.ts`). A source still unread at the bound is `timeout`; its fetch or parse keeps running into
// nothing (the parse child is SIGKILLed at the time it was given, which is never past the bound). `runCore` races
// the step once more, so even a step that ignored all of this could not hold the morning.
//
// ⚠ ONE UNREACHABLE HOST IS NOT "OFFLINE" (spec §3): `offline` is the caller's machine-level verdict. Only then is a
// connection failure `offline`; otherwise it is `incomplete` and the briefing stamps. The empty-day offline rule
// (`skipOffline`) is decided here because only the step knows whether there are links to wait for.
//
// What leaves this module: the struct (titles, times, locations, attendee COUNTS), the two prompt blocks (built by
// `./prompt.ts`, whose locked variant is the only place attendee names and descriptions ever go), and — for an
// owned run — the health record (statuses and reason codes only, `./health.ts`).
//
// ── THE DETAILS MODE (redesign C, wave-2 plan C-M2-T5) — the live details read (`./details.ts`) ONLY ─────────
// `readCalendar` takes five more deps, every one absent on the morning path (`run` and `calendar test` hand none:
// `CalendarStepDeps` omits them and `createCalendarStep` strips them, `morningDeps`):
//   • `details`: each producer puts each run-date copy's RAW details on the copy (`CalEvent.details`), and the read
//     returns `links`, the link report — `{ id, entryHash, url? }` for every command-sourced link — and `skipped`;
//   • `handed`: URLs Rust remembered from an earlier report, by link id. For a `command` link a handed URL whose
//     `entryHash` is 64 lowercase hex characters and equals the entry's current hash (`linkEntryHash`), and that
//     passes the length check a command's output gets (LINK_URL_MAX_BYTES), is used INSTEAD OF RUNNING THE COMMAND.
//     One for an env or file link, an unknown id or another hash is ignored and never returned;
//   • `skipCommands`: a command link with no usable handed URL is SKIPPED — its command is not run and no slot is
//     read for it; `skipMac`: the Mac source is skipped. A skipped source produces no `CalendarSourceRead` (skipped is
//     a flag, never a `CalendarReadStatus`) and is listed in `skipped`;
//   • `refreshWait`: the Mac reader's `--refresh-wait`, sent only to a copy that is not outdated (`./mac-source.ts`).
// The report's `url` is the handed or freshly resolved URL UNLESS THE LINK IS DEAD: its own transfer ended
// `link-refused`, `link-redirected` or the transfer's `malformed`. Offline or unreachable, a timeout, a server error,
// too large, a parse failure, and a handed URL the read never reached keep it. A credential failure (`malformed` with
// the ladder's reason) produced no URL, so it reports none. The report is the ONLY place a URL leaves this module.
import { createHash } from "node:crypto";
import type { ResolvedCalendar, ResolvedCalendarLink } from "./config";
import { calEventEnded, calSeriesRepeats } from "./budget";
import { LINK_URL_MAX_BYTES, resolveLinkUrl, type LinkUrlOpts, type LinkUrlOutcome } from "./link-url";
import { fetchCalendarUrl, linkByteBudget, type CalendarFetch } from "./link-fetch";
import { parseCalendarLink } from "./link-parse";
import { CAL_PARSE_MAX_EVENTS } from "./ics";
import { reconcileCalendar } from "./reconcile";
import { buildCalendarPromptBlocks, type CalendarPromptBlocks } from "./prompt";
import { CALENDAR_MACOS_SOURCE_ID, CALENDAR_MAX_EVENT_LINES } from "./render-contract";
import { writeCalendarHealth, type CalendarHealthSource } from "./health";
import { readMacCalendar, type MacRead, type MacReadOpts, type ReaderExec } from "./mac-source";
import type { CalendarMacosSelection } from "./config";
import type { CalendarStep, CalendarStepContext, CalendarStepResult } from "./step";
import type {
  CalDate, CalEvent, CalUidIndex, CalendarReadStatus, CalendarSourceKind, CalendarSourceNotice, CalendarStruct,
  CalendarStructEvent, CalendarStructSource,
} from "./types";

import { CALENDAR_STEP_BOUND_MS } from "./bounds";
export { CALENDAR_STEP_BOUND_MS, CALENDAR_STEP_WORST_MS } from "./bounds";

/** One source as configured: the Mac source (id `macos`) first when it exists on this system, then the links in
 *  config order. The order every struct, prompt notice, health record and `calendar … --json` uses. */
export type CalendarConfiguredSource = { id: string; kind: CalendarSourceKind };

export function configuredCalendarSources(resolved: ResolvedCalendar, platform: NodeJS.Platform = process.platform): CalendarConfiguredSource[] {
  const out: CalendarConfiguredSource[] = [];
  if (resolved.macos !== undefined && platform === "darwin") out.push({ id: CALENDAR_MACOS_SOURCE_ID, kind: "macos" });
  for (const l of resolved.links) out.push({ id: l.id, kind: "link" });
  return out;
}

/** One source's read, in full — what `calendar test --json` reports and the health file keeps (minus counts). */
export type CalendarSourceRead = CalendarConfiguredSource & {
  status: CalendarReadStatus;
  notices?: CalendarSourceNotice[];
  /** A machine reason code; never text from a feed, never the URL. */
  reason?: string;
  /** Events overlapping today that this source contributed after the merge; `null` when nothing was read. */
  eventsToday: number | null;
  durationMs: number;
};

export type CalendarRead = {
  /** Today's events: merged, filtered, in display order (`reconcileCalendar`). Engine-internal: never persisted. */
  events: CalEvent[];
  sources: CalendarSourceRead[];
  /** When the reads finished — the "now" the struct's `ended` flags and the prompt's header are decided against. */
  nowMs: number;
  /** DETAILS MODE ONLY (see the header): the link report, one entry per command-sourced link, in config order. */
  links?: CalendarLinkReport[];
  /** DETAILS MODE ONLY: the sources `skipCommands` / `skipMac` skipped, in configured order. */
  skipped?: CalendarConfiguredSource[];
};

/** One command-sourced link in the details read's report: its id, its entry's hash, and the URL it read with
 *  unless the link is dead (see the header). The `url` is a SECRET: it goes only to Rust's sealed path. */
export type CalendarLinkReport = { id: string; entryHash: string; url?: string };

/** A handed URL's entry hash must be exactly this (lowercase hex SHA-256), checked on every read of one. */
export const LINK_ENTRY_HASH_RE = /^[0-9a-f]{64}$/;

/** The hash of ONE link's own entry (redesign C, round-5 items C3, C11): SHA-256 (hex) of `JSON.stringify` of its keys
 *  in the fixed order `id, name, owner, confirmedOwner, urlEnv, urlCommand` (the entry's key list, `./config.ts`),
 *  absent keys omitted, from the PARSED config (never the file's bytes, which Settings re-serialises on every save).
 *  Rust never computes it; it stores the engine's string and hands it back. */
export function linkEntryHash(link: ResolvedCalendarLink): string {
  const entry: Record<string, unknown> = { id: link.id };
  if (link.name !== undefined) entry.name = link.name;
  if (link.owner !== undefined) entry.owner = link.owner;
  if (link.confirmedOwner !== undefined) entry.confirmedOwner = link.confirmedOwner;
  if (link.urlFrom === "env") entry.urlEnv = link.urlEnv;
  if (link.urlFrom === "command") entry.urlCommand = link.urlCommand;
  return createHash("sha256").update(JSON.stringify(entry)).digest("hex");
}

/** The transfer outcomes that make a link DEAD: its URL is not returned (user decision (1), 2026-10-24). */
const DEAD_TRANSFER: ReadonlySet<string> = new Set(["link-refused", "link-redirected", "malformed"]);

export type CalendarReadDeps = {
  /** The engine state folder (`supportDir()` in production). REQUIRED: nothing here may default to the real one. */
  stateDir: string;
  /** Defaults to `process.platform`. */
  platform?: NodeJS.Platform;
  /** The credential ladder's environment (`urlEnv`). Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** The `urlCommand` runner. Defaults to `proc.run`. */
  exec?: LinkUrlOpts["exec"];
  /** Defaults to the global `fetch`. Every test injects one (with `netGuard` installed). */
  fetch?: CalendarFetch;
  /** Defaults to `Date.now`. */
  now?: () => number;
  /** TEST seam: the parse child's argv (`parseCalendarLink`'s `command`). Production re-invokes the engine. */
  parseCommand?: string[];
  /** TEST seam: the zone the parse child treats as local. */
  zone?: string;
  /** TEST seam: the overall bound. Production: CALENDAR_STEP_BOUND_MS. */
  boundMs?: number;
  /** Runs the Mac reader's `mkfifo` and `open` (`./mac-source.ts`). Defaults to `proc.run`; tests inject one. */
  macExec?: ReaderExec;
  /** TEST seam: `os.release()` for the Mac source's macOS 14 check. */
  osRelease?: string;
  /** TEST seam: the whole Mac read. Production: `readMacCalendar` with the deps above. */
  readMac?: (sel: CalendarMacosSelection, emails: readonly string[], opts?: MacReadOpts) => Promise<MacRead>;
  // ── DETAILS MODE ONLY (see the header); every one absent on the morning path ──
  /** Remembered command-link URLs, by link id, each with the entry hash it was reported under. */
  handed?: ReadonlyMap<string, { entryHash: string; url: string }>;
  /** Skip every command link that has no usable handed URL (its command is not run). */
  skipCommands?: true;
  /** Skip the Mac source. */
  skipMac?: true;
  /** Raw details on each run-date copy, and the link report. */
  details?: true;
  /** The Mac reader's refresh wait in seconds (0 to 2), details mode only. */
  refreshWait?: number;
};

/** The five details-mode deps (see the header). */
type CalendarDetailsField = "handed" | "skipCommands" | "skipMac" | "details" | "refreshWait";

/** The morning's deps: the details-mode fields stripped, whatever the caller's object holds at run time. */
function morningDeps<D extends CalendarReadDeps>(deps: D): Omit<D, CalendarDetailsField> {
  const { handed: _h, skipCommands: _c, skipMac: _m, details: _d, refreshWait: _w, ...rest } = deps;
  return rest;
}

type Slot = CalendarConfiguredSource & {
  t0: number;
  read?: Omit<CalendarSourceRead, "id" | "kind" | "eventsToday" | "durationMs"> & { durationMs: number };
  events: CalEvent[];
  index?: CalUidIndex;
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, Math.max(0, ms)));

/** Fix-round 1: the events one link's parse may return — an even share of what is LEFT of the total among the links
 *  still to be read (itself included), rounded up. The total was first-come in fetch order, so one flooding feed
 *  that landed first could zero every later link. A share a link leaves unused stays in `left` for the later ones,
 *  so the redistribution is automatic; the sum never exceeds the total, because each share is ≤ what is left. */
export function calendarLinkShare(left: number, pendingLinks: number): number {
  return Math.max(0, Math.min(left, Math.ceil(left / Math.max(1, pendingLinks))));
}

/** Read every configured source under the overall bound, then reconcile. Never throws for anything a source can do;
 *  a throw from the reconcile itself is the caller's (the step turns it into a failed result). */
export async function readCalendar(
  resolved: ResolvedCalendar, ctx: Pick<CalendarStepContext, "runDate" | "startedAt" | "offline">, deps: CalendarReadDeps,
): Promise<CalendarRead> {
  const now = deps.now ?? Date.now;
  const platform = deps.platform ?? process.platform;
  const deadline = ctx.startedAt + (deps.boundMs ?? CALENDAR_STEP_BOUND_MS);
  const budget = linkByteBudget();
  let closed = false;
  let eventsLeft = CAL_PARSE_MAX_EVENTS;

  const links = new Map(resolved.links.map((l) => [l.id, l]));
  // DETAILS MODE (see the header): the usable handed URL of a command link, the URLs read with, and what is skipped.
  const usableHanded = (link: ResolvedCalendarLink): string | undefined => {
    if (link.urlFrom !== "command") return undefined;
    const h = deps.handed?.get(link.id);
    if (h === undefined || typeof h.entryHash !== "string" || !LINK_ENTRY_HASH_RE.test(h.entryHash) || h.entryHash !== linkEntryHash(link)) return undefined;
    if (typeof h.url !== "string" || h.url === "" || Buffer.byteLength(h.url, "utf8") > LINK_URL_MAX_BYTES) return undefined;
    return h.url;
  };
  const readWith = new Map<string, { url: string; dead: boolean }>();
  const skips = (s: CalendarConfiguredSource): boolean => s.kind === "macos"
    ? deps.skipMac === true
    : deps.skipCommands === true && links.get(s.id)?.urlFrom === "command" && usableHanded(links.get(s.id)!) === undefined;
  const configured = configuredCalendarSources(resolved, platform);
  const skipped = configured.filter(skips);
  const slots: Slot[] = configured.filter((s) => !skips(s)).map((s) => ({ ...s, t0: now(), events: [] }));
  const settle = (slot: Slot, read: NonNullable<Slot["read"]>, events: CalEvent[] = [], index?: CalUidIndex): void => {
    if (closed || slot.read) return;
    slot.read = read;
    slot.events = events;
    if (index) slot.index = index;
  };

  // The Mac source (plan M10c): the installed reader, triggered through LaunchServices and read through its FIFO,
  // abandoned at 15 s (`./mac-source.ts`); it never copies, signs or prompts. Runs alongside the link fetches.
  const readMac = deps.readMac ?? ((sel: CalendarMacosSelection, emails: readonly string[], opts?: MacReadOpts) => readMacCalendar(sel, emails, {
    stateDir: deps.stateDir, platform, now,
    ...(deps.macExec ? { exec: deps.macExec } : {}), ...(deps.osRelease !== undefined ? { osRelease: deps.osRelease } : {}),
  }, opts));
  const macOpts: MacReadOpts | undefined = deps.details === true
    ? { details: { runDate: ctx.runDate }, ...(deps.refreshWait !== undefined ? { refreshWait: deps.refreshWait } : {}) } : undefined;
  const macTasks = slots.filter((s) => s.kind === "macos").map(async (slot) => {
    try {
      const r = await (macOpts ? readMac(resolved.macos?.calendars ?? "editable", resolved.emails, macOpts) : readMac(resolved.macos?.calendars ?? "editable", resolved.emails));
      settle(slot, {
        status: r.status, ...(r.reason !== undefined ? { reason: r.reason } : {}),
        ...(r.notices?.length ? { notices: [...r.notices] } : {}), durationMs: now() - slot.t0,
      }, r.status === "ok" || r.status === "incomplete" ? r.events : []);
    } catch {
      settle(slot, { status: "incomplete", reason: "internal", durationMs: now() - slot.t0 });
    }
  });

  // Parses run ONE AT A TIME, each given A FAIR SHARE of what is left of the bound and of spec §3's 5,000-event
  // total (`calendarLinkShare`, both); fetches run concurrently and queue their parse as they land.
  let parseChain: Promise<void> = Promise.resolve();
  const readLink = async (slot: Slot, link: ResolvedCalendarLink): Promise<void> => {
    const handed = usableHanded(link);
    const credential: LinkUrlOutcome = handed !== undefined
      ? { status: "ok", from: "command", url: handed }
      : await resolveLinkUrl(link, { stateDir: deps.stateDir, env: deps.env, platform, exec: deps.exec });
    if (deps.details === true && link.urlFrom === "command" && credential.status === "ok") readWith.set(link.id, { url: credential.url, dead: false });
    if (credential.status !== "ok") {
      // Credential failures are `malformed` + M1's reason code (hub decision for M2a, kept for M4/M5).
      settle(slot, { status: "malformed", reason: credential.reason, durationMs: now() - slot.t0 });
      return;
    }
    const fetched = await fetchCalendarUrl(credential.url, {
      stateDir: deps.stateDir, startedAt: ctx.startedAt, budget, offline: ctx.offline,
      ...(deps.fetch ? { fetch: deps.fetch } : {}), now,
    });
    if (fetched.status !== "ok") {
      if (DEAD_TRANSFER.has(fetched.status)) { const w = readWith.get(link.id); if (w && !closed) w.dead = true; }
      settle(slot, { status: fetched.status, reason: fetched.reason, durationMs: now() - slot.t0 });
      return;
    }
    const url = credential.url;
    const ics = new TextDecoder("utf-8", { fatal: false }).decode(fetched.body);
    const job = parseChain.then(async () => {
      if (closed) return;
      const left = deadline - now();
      if (left <= 0) return;   // the bound will mark it `timeout`
      // Every link still unsettled — this one, the ones queued behind it, and those still fetching — has a claim on
      // what is left, of the TIME (final harden r3) as of the events; a link that settles without parsing (a failed
      // credential or fetch) releases its share. Time was `deadline - now()` whole, so a slow (hostile) first feed
      // spent the bound and every later link timed out unparsed. An unused share passes on, as for events.
      const pending = slots.filter((s) => s.kind === "link" && !s.read).length;
      const timeoutMs = calendarLinkShare(left, pending);
      const parsed = await parseCalendarLink({
        link, url, emails: resolved.emails, ics, runDate: ctx.runDate, timeoutMs,
        maxEvents: calendarLinkShare(eventsLeft, pending),
        ...(deps.details === true ? { details: true as const } : {}),
        ...(deps.parseCommand ? { command: deps.parseCommand } : {}), ...(deps.zone ? { zone: deps.zone } : {}),
      });
      const durationMs = now() - slot.t0;
      switch (parsed.status) {
        case "ok": {
          eventsLeft = Math.max(0, eventsLeft - parsed.events.length);
          const notices = parsed.notices.length ? { notices: [...parsed.notices] } : {};
          settle(slot, parsed.incomplete.length
            ? { status: "incomplete", reason: parsed.incomplete[0], ...notices, durationMs }
            : { status: "ok", ...notices, durationMs }, parsed.events, parsed.index);
          return;
        }
        case "parse-error": settle(slot, { status: "malformed", reason: "parse-error", durationMs }); return;
        case "timeout": settle(slot, { status: "timeout", reason: "parse-deadline", durationMs }); return;
        default:
          settle(slot, parsed.reason === "output-too-large"
            ? { status: "too-large", reason: parsed.reason, durationMs }
            : { status: "malformed", reason: parsed.reason, durationMs });
      }
    });
    parseChain = job.catch(() => undefined);
    await job;
  };

  const tasks = slots.filter((s) => s.kind === "link").map((slot) =>
    readLink(slot, links.get(slot.id)!).catch(() => settle(slot, { status: "incomplete", reason: "internal", durationMs: now() - slot.t0 })));
  await Promise.race([Promise.all([...tasks, ...macTasks]), sleep(deadline - now())]);
  closed = true;
  const doneAt = now();
  for (const slot of slots) if (!slot.read) slot.read = { status: "timeout", reason: "step-deadline", durationMs: doneAt - slot.t0 };

  const read = slots.filter((s) => s.read!.status === "ok" || s.read!.status === "incomplete");
  const events = reconcileCalendar({
    runDate: ctx.runDate,
    copies: read.flatMap((s) => s.events),
    indexes: read.flatMap((s) => (s.index ? [s.index] : [])),
    ...(deps.details === true ? { details: true as const } : {}),
  });
  const contributed = (s: Slot): number => events.filter((e) => e.sources.some((r) => r.kind === s.kind && r.id === s.id)).length;
  return {
    events,
    sources: slots.map((s) => ({
      id: s.id, kind: s.kind, status: s.read!.status,
      ...(s.read!.notices?.length ? { notices: s.read!.notices } : {}),
      ...(s.read!.reason !== undefined ? { reason: s.read!.reason } : {}),
      eventsToday: s.read!.status === "ok" || s.read!.status === "incomplete" ? contributed(s) : null,
      durationMs: Math.max(0, s.read!.durationMs),
    })),
    nowMs: doneAt,
    ...(deps.details === true ? {
      links: resolved.links.filter((l) => l.urlFrom === "command").map((l): CalendarLinkReport => {
        const w = readWith.get(l.id);
        return { id: l.id, entryHash: linkEntryHash(l), ...(w !== undefined && !w.dead ? { url: w.url } : {}) };
      }),
      skipped: skipped.map((s) => ({ id: s.id, kind: s.kind })),
    } : {}),
  };
}

/** The display status spec §7 stores: tentative when the event's own STATUS is, or your answer is. */
function displayStatus(ev: CalEvent): CalendarStructEvent["status"] {
  return ev.status === "tentative" || ev.selfStatus === "tentative" ? "tentative" : "confirmed";
}

/** The order the struct stores `events` in. Display order — EXCEPT (fix-round 1) when there are more than the
 *  section's `CALENDAR_MAX_EVENT_LINES`: then the first that-many are the ones the section shows, chosen distinct
 *  events first and further repeats of one series (`calSeriesRepeats`) after, each part in display order. Both
 *  renderers (the engine's and the app's) show the first N and count the rest as `+N more`, so neither changes. */
export function sectionOrder<T extends Pick<CalEvent, "uid">>(events: readonly T[]): T[] {
  if (events.length <= CALENDAR_MAX_EVENT_LINES) return [...events];
  const repeat = calSeriesRepeats(events);
  const ranked = [...events.keys()].sort((a, b) => Number(repeat[a]) - Number(repeat[b]) || a - b);
  const shown = new Set(ranked.slice(0, CALENDAR_MAX_EVENT_LINES));
  return [...events.filter((_, i) => shown.has(i)), ...events.filter((_, i) => !shown.has(i))];
}

/** `BriefingStruct.calendar`, FIELD BY FIELD from the merged events — never a spread of a `CalEvent`, so attendee
 *  names and emails and descriptions cannot reach the struct, the archive or the envelope by any later field. An
 *  empty location is dropped (it would render as `()`). Events in `sectionOrder`. */
export function toCalendarStruct(events: readonly CalEvent[], sources: readonly CalendarSourceRead[], nowMs: number): CalendarStruct {
  const structSources: CalendarStructSource[] = sources.map((s) => ({
    id: s.id, kind: s.kind, status: s.status, ...(s.notices?.length ? { notices: [...s.notices] } : {}),
  }));
  return {
    events: sectionOrder(events).map((ev) => toStructEvent(ev, nowMs)),
    sources: structSources,
    incomplete: structSources.some((s) => s.status !== "ok"),
  };
}

/** One merged event as the struct stores it, FIELD BY FIELD (`toCalendarStruct`'s per-event body, extracted
 *  unchanged for the live details read's `rowText`, redesign C: projecting per event, never by index, keeps each
 *  projection with its own event when `sectionOrder` reorders). Never carries `details`, `viewDetails` or the producer
 *  keys; `merged` is the decided `nearDuplicate` mark, copied field by field. */
export function toStructEvent(ev: CalEvent, nowMs: number): CalendarStructEvent {
  const location = typeof ev.location === "string" && ev.location.trim() !== "" ? ev.location : undefined;
  return {
    time: { ...ev.time },
    title: ev.title,
    ...(location !== undefined ? { location } : {}),
    status: displayStatus(ev),
    transparency: ev.transparency,
    attendeeCount: ev.attendees.length,
    ...(calEventEnded(ev, nowMs) ? { ended: true as const } : {}),
    // The decided merge mark (calendar near-duplicates, spec §6), field by field; absent on every unmerged event.
    ...(ev.nearDuplicate !== undefined ? { merged: { mark: ev.nearDuplicate.mark, count: ev.nearDuplicate.count } } : {}),
  };
}

/** Both prompt blocks, or `null` when the budget leaves room for neither (spec §6: below the allowance there is no
 *  block at all). Never throws: a formatter failure costs the AI its calendar block, never the briefing. */
function promptBlocksFor(
  events: readonly CalEvent[], sources: readonly CalendarStructSource[], runDate: CalDate, nowMs: number, maxChars: number,
): CalendarPromptBlocks | null {
  try {
    const b = buildCalendarPromptBlocks({ events, sources, runDate, nowMs, maxChars });
    return b.locked === "" && b.unlocked === "" ? null : b;
  } catch {
    return null;
  }
}

/** The result for a step that could not read at all — every configured source carries `status`, no events. Used
 *  when the step threw or overran (`runCore`'s outer race) and for the empty-day offline skip. `undefined` when the
 *  calendar is off. */
export function calendarFailedResult(
  resolved: ResolvedCalendar, status: CalendarReadStatus, runDate: CalDate, nowMs: number, maxChars: number,
  opts: { platform?: NodeJS.Platform; skipOffline?: boolean } = {},
): CalendarStepResult | undefined {
  if (!resolved.enabled) return undefined;
  const sources = configuredCalendarSources(resolved, opts.platform).map((s) => ({ ...s, status, eventsToday: null, durationMs: 0 }));
  const struct = toCalendarStruct([], sources, nowMs);
  return {
    struct,
    promptBlocks: sources.length && !opts.skipOffline ? promptBlocksFor([], struct.sources, runDate, nowMs, maxChars) : null,
    skipOffline: opts.skipOffline === true,
  };
}

export type CalendarStepDeps = Omit<CalendarReadDeps, CalendarDetailsField> & {
  /** `tokenBudget.maxChars` — the prompt block's allowance is a share of it (spec §6). */
  maxChars: number;
};

/** The production `CalendarStep` for one run's resolved config. See the header. */
export function createCalendarStep(resolved: ResolvedCalendar, deps: CalendarStepDeps): CalendarStep {
  return async (ctx: CalendarStepContext): Promise<CalendarStepResult | undefined> => {
    if (!resolved.enabled) return undefined;
    const now = deps.now ?? Date.now;
    try {
      const configured = configuredCalendarSources(resolved, deps.platform);
      // Calendar on, nothing to read (spec §7, build decision 2026-10-09): the heading and "No calendar is
      // connected"; no prompt block.
      if (configured.length === 0) return { struct: { events: [], sources: [], incomplete: false }, promptBlocks: null, skipOffline: false };
      // The empty-day offline rule (spec §3): a machine that is offline with links to read skips without stamping,
      // so a later tick retries — except under --force, which renders what it has.
      if (ctx.offline && !ctx.force && resolved.links.length > 0) {
        return calendarFailedResult(resolved, "offline", ctx.runDate, now(), deps.maxChars, { platform: deps.platform, skipOffline: true });
      }
      const read = await readCalendar(resolved, ctx, morningDeps(deps));
      const struct = toCalendarStruct(read.events, read.sources, read.nowMs);
      const promptBlocks = promptBlocksFor(read.events, struct.sources, ctx.runDate, read.nowMs, deps.maxChars);
      // Provider fallback (P1-M8 checkpoint LOW 7): this write runs BEFORE the walk, so no `lockStillHeld` check guards
      // it; only re-check point 1 (`verifyOwnership`, right after the walk) covers a holder that lost the lock, as
      // spec r9 §5 "Run lock" allows for writes outside the walk.
      if (ctx.owned) {
        await writeCalendarHealth(deps.stateDir, {
          at: new Date(read.nowMs).toISOString(), trigger: ctx.trigger,
          sources: read.sources.map((s): CalendarHealthSource => ({
            id: s.id, kind: s.kind, status: s.status,
            ...(s.notices?.length ? { notices: s.notices } : {}), ...(s.reason !== undefined ? { reason: s.reason } : {}),
          })),
        });
      }
      return { struct, promptBlocks, skipOffline: false };
    } catch {
      try { return calendarFailedResult(resolved, "malformed", ctx.runDate, now(), deps.maxChars, { platform: deps.platform }); }
      catch { return undefined; }
    }
  };
}
