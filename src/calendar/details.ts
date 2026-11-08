// src/calendar/details.ts — `daily-briefing calendar details --json`, the LIVE DETAILS READ (redesign C, "The command";
// wave-2 plan C-M2-T6). INTERNAL and `--json` only: it prints meeting links, notes and names, so it is not in the
// CLI's usage line or its help, and only the desktop app's Rust side runs it, as a typed `Operation`, through its
// sealed spawn tail (C-M3-T7), which parses stdout inside Rust and drops the text.
//
//   ARGUMENTS  `--json`, `--skip-mac`, `--skip-commands`, nothing else (exit 2). Rust builds them; never the webview.
//   STDIN      `{ "links": [{ "id", "entryHash", "url" }] }`, the command-link URLs Rust remembered, read to its end
//              under DETAILS_STDIN_MAX_BYTES (over it, exit 2); empty means none. A link whose `entryHash` is not
//              64 lowercase hex characters is dropped here; the pipeline ignores any other mismatch (./pipeline.ts).
//   STDOUT     one sealed document (`CalendarDetailsJson`), or `{ schemaVersion: 1, refused: "calendar-off" }` with exit 0
//              while the engine-resolved `enabled` is false (D's rule; this is new: `calendar test` reads regardless).
//   STDERR     nothing but a fixed failure code (`calendar details: <code>`); never a URL, a name or a note. Rust never
//              forwards it in any case.
//
// It selects sources exactly as the morning does (`resolveCalendar`), reads through `readCalendar` in DETAILS MODE
// (./pipeline.ts's header), runs no machine-level network probe (as `calendar test`), and writes no health file, no
// diagnostics and nothing else (test/calendar-details.verb.test.ts's jail). Raw notes never leave the engine: the
// document carries the lightly cleaned notes (./notes.ts) and the Join candidate (./join.ts) taken from the raw fields.
import { calEventLine } from "../render";
import { localDateStr } from "../marker";
import { readStdinBounded } from "../providerCli";
import { cleanCalendarText, cleanEmail } from "./clean";
import { joinAcross, joinCandidate, type JoinCandidate } from "./join";
import { cleanNotes } from "./notes";
import { nearDupTitle } from "./reconcile";
import {
  configuredCalendarSources, LINK_ENTRY_HASH_RE, readCalendar, toStructEvent, type CalendarLinkReport, type CalendarReadDeps,
} from "./pipeline";
import { CALENDAR_LINK_ID_RE, type ResolvedCalendar } from "./config";
import type { CalendarReadStatus, CalendarSourceKind, CalendarStructEvent, CalEvent } from "./types";

/** The reader's `--refresh-wait` for the live read: NOT SENT in this release (`undefined` keeps the reader's 2 s
 *  wait). Whether skipping it is safe can only be measured against a real calendar, which no test may touch;
 *  `UNVERIFIED: skipping the reader's 2 s refresh wait is safe (source: C spec)`. The argument ships in reader
 *  version 2 so a later change needs no helper rebuild; the card's loading line covers the first read's wait. */
export const LIVE_READ_REFRESH_WAIT: number | undefined = undefined;

/** The STDIN ceiling: above the largest document Rust can write (wave-2 plan C-M2-T6, round 5 P5-M6): at most 10
 *  links (`CALENDAR_MAX_LINKS`; Rust's `MAX_LINKS`), each `{"id":"…","entryHash":"…","url":"…"}` with a 32-character
 *  id, a 64-character hash and a URL of at most 4 096 bytes (Rust's `MAX_LINK_URL_BYTES`) escaped to at most 8 192
 *  (Rust escapes only `"` and `\`): 8 321 bytes a link, 83 231 in all with the brackets and commas. */
export const DETAILS_STDIN_MAX_BYTES = 128 * 1024;

export type CalendarDetailsPerson = { name: string | null; organiser: boolean };

export type CalendarDetailsEvent = {
  title: string;
  location: string | null;
  /** The event's page projection: the page's own line for it, by construction (`calEventLine` over `toStructEvent`). */
  rowText: string;
  time: CalendarStructEvent["time"];
  status: CalendarStructEvent["status"];
  ended: boolean;
  /** Has a copy from the Mac source (Open in Calendar shows for it). */
  fromMac: boolean;
  /** Null when the raw details were unavailable (for example, omitted by the details byte budget). */
  people: CalendarDetailsPerson[] | null;
  /** The lightly cleaned notes, or null. On a key-c merged event, the CORE view's only (spec §5 "Details JSON contract"). */
  notes: string | null;
  join: JoinCandidate | null;
  /** A key-c merged event only (spec §5): the other non-cancelled views in merge order, each with its own cleaned notes
   *  (empty when it has none) and its title, null when that equals the shown title after key-c title normalisation.
   *  Absent on an unmerged or older event. */
  otherNotes?: { title: string | null; notes: string }[];
};

export type CalendarDetailsSource = { command?: boolean } & (
  | { id: string; kind: CalendarSourceKind; status: CalendarReadStatus; reason?: string }
  | { id: string; kind: CalendarSourceKind; skipped: true });

export type CalendarDetailsJson = {
  schemaVersion: 1;
  readAt: string;
  events: CalendarDetailsEvent[];
  sources: CalendarDetailsSource[];
  readerOutdated: boolean;
  links: CalendarLinkReport[];
};

export type CalendarDetailsRefused = { schemaVersion: 1; refused: "calendar-off" };

export type DetailsVerbDeps = {
  json: boolean;
  stateDir: string;
  platform: NodeJS.Platform;
  /** The resolved calendar block, or why the config could not be read (`calendar …`'s own reader, ./cli.ts). */
  resolveConfig: () => Promise<{ r: ResolvedCalendar } | { why: string }>;
  out: (s: string) => void;
  err: (s: string) => void;
  env?: Record<string, string | undefined>;
  exec?: CalendarReadDeps["exec"];
  fetch?: CalendarReadDeps["fetch"];
  parseCommand?: string[];
  macExec?: CalendarReadDeps["macExec"];
  osRelease?: string;
  now?: () => number;
  /** TEST seam: STDIN, read under the byte bound. Default `readStdinBounded`; a terminal STDIN reads as empty. */
  readStdin?: (maxBytes: number) => Promise<string>;
  isTTY?: boolean;
  /** TEST seam over LIVE_READ_REFRESH_WAIT (present, even as `undefined`, means "use this"). */
  liveRefreshWait?: number | undefined;
};

/** A fixed failure code on stderr, never anything read or configured. */
function failed(d: DetailsVerbDeps, code: "bad-arguments" | "stdin-too-large" | "stdin-invalid" | "config-unreadable" | "internal", exit: number): number {
  d.err(`calendar details: ${code}`);
  return exit;
}

/** STDIN's links: `undefined` when the document is not one this verb reads. A link with a malformed `entryHash`, an
 *  id outside the grammar or no string URL is dropped. */
function handedFrom(text: string): Map<string, { entryHash: string; url: string }> | undefined {
  const handed = new Map<string, { entryHash: string; url: string }>();
  if (text.trim() === "") return handed;
  let doc: unknown;
  try { doc = JSON.parse(text); } catch { return undefined; }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return undefined;
  const links = (doc as Record<string, unknown>).links;
  if (!Array.isArray(links)) return undefined;
  for (const l of links) {
    if (typeof l !== "object" || l === null) continue;
    const { id, entryHash, url } = l as Record<string, unknown>;
    if (typeof id !== "string" || !CALENDAR_LINK_ID_RE.test(id)) continue;
    if (typeof entryHash !== "string" || !LINK_ENTRY_HASH_RE.test(entryHash)) continue;
    if (typeof url !== "string" || url === "" || handed.has(id)) continue;
    handed.set(id, { entryHash, url });
  }
  return handed;
}

/** A shown name: the morning's title cleaning (a web address becomes "<host> link", no control characters, a cap),
 *  `null` for an address-only person or when nothing is left. */
function shownName(name: string | null): string | null {
  if (name === null || cleanEmail(name.normalize("NFKC")) !== undefined) return null;
  const n = cleanCalendarText(name, "title");
  return n === "" || cleanEmail(n) !== undefined ? null : n;
}

/** The card's people from a key-c merge's views (spec §5 "People"): null only when no view has details; otherwise the
 *  union of the views' raw people after `shownName`, named people deduped by NFKC, case and collapsed whitespace (the
 *  first spelling in core-first order, an organiser when ANY entry says so), nameless people from the core only, and
 *  organisers first (order otherwise kept). The email-based attendee union for engine counts is a separate thing. */
function peopleAcross(views: NonNullable<CalEvent["viewDetails"]>): CalendarDetailsPerson[] | null {
  if (views.every((v) => v.details === undefined)) return null;
  const out: CalendarDetailsPerson[] = [];
  const byName = new Map<string, CalendarDetailsPerson>();
  views.forEach((v, i) => {
    for (const p of v.details?.people ?? []) {
      const name = shownName(p.name);
      if (name === null) { if (i === 0) out.push({ name: null, organiser: p.organiser }); continue; }
      const key = name.normalize("NFKC").toLowerCase().replace(/\s+/gu, " ").trim();
      const seen = byName.get(key);
      if (seen !== undefined) { seen.organiser ||= p.organiser; continue; }
      const person = { name, organiser: p.organiser };
      byName.set(key, person);
      out.push(person);
    }
  });
  return [...out.filter((p) => p.organiser), ...out.filter((p) => !p.organiser)];
}

/** One event's card details, the verb's per-event projection (pure; the direct test seam for the card's merge rules).
 *  An unmerged event reads `ev.details`; a key-c merge with `viewDetails` (details mode, two or more views) takes its
 *  people, notes, `otherNotes` and Join from the views, the core first (spec §5). */
export function detailsEventOf(ev: CalEvent, nowMs: number, runDate: string): CalendarDetailsEvent {
  const s = toStructEvent(ev, nowMs);
  const raw = ev.details;
  const notesOf = (d: CalEvent["details"]): string => (d?.notes !== undefined ? cleanNotes(d.notes) : "");
  const views = ev.viewDetails;
  const notes = notesOf(views !== undefined ? views[0]?.details : raw);
  const shown = nearDupTitle(s.title);
  return {
    title: s.title, location: s.location ?? null, rowText: calEventLine(s, runDate), time: s.time, status: s.status,
    ended: s.ended === true, fromMac: ev.sources.some((r) => r.kind === "macos"),
    people: views !== undefined ? peopleAcross(views) : raw ? raw.people.map((p) => ({ name: shownName(p.name), organiser: p.organiser })) : null,
    notes: notes === "" ? null : notes,
    // Across views (spec §5 "Join"): each view with details gives its own candidate, in viewDetails order (core first,
    // then merge order), with its tier for the tier-gated precedence and URL sort. Unmerged: joinCandidate, unchanged.
    join: views !== undefined
      ? joinAcross(views.flatMap((v) => (v.details !== undefined ? [{ fields: v.details, tier: v.tier }] : [])))
      : raw ? joinCandidate(raw) : null,
    ...(views !== undefined
      ? { otherNotes: views.slice(1).map((v) => ({ title: nearDupTitle(v.title) === shown ? null : v.title, notes: notesOf(v.details) })) }
      : {}),
  };
}

/** `calendar details --json` (see the header). */
export async function detailsVerb(args: string[], d: DetailsVerbDeps): Promise<number> {
  try {
    const flags = new Set<string>();
    for (const a of args) {
      if ((a !== "--skip-mac" && a !== "--skip-commands") || flags.has(a)) return failed(d, "bad-arguments", 2);
      flags.add(a);
    }
    if (!d.json) return failed(d, "bad-arguments", 2);
    const stdin = d.isTTY ?? process.stdin.isTTY ? "" : await (d.readStdin ?? readStdinBounded)(DETAILS_STDIN_MAX_BYTES);
    if (Buffer.byteLength(stdin, "utf8") > DETAILS_STDIN_MAX_BYTES) return failed(d, "stdin-too-large", 2);
    const handed = handedFrom(stdin);
    if (handed === undefined) return failed(d, "stdin-invalid", 2);
    const res = await d.resolveConfig();
    if ("why" in res) return failed(d, "config-unreadable", 1);
    if (!res.r.enabled) {
      const refused: CalendarDetailsRefused = { schemaVersion: 1, refused: "calendar-off" };
      d.out(JSON.stringify(refused));
      return 0;
    }
    const now = d.now ?? Date.now;
    const startedAt = now();
    const runDate = localDateStr(new Date(startedAt));
    const refreshWait = "liveRefreshWait" in d ? d.liveRefreshWait : LIVE_READ_REFRESH_WAIT;
    const read = await readCalendar(res.r, { runDate, startedAt, offline: false }, {
      stateDir: d.stateDir, platform: d.platform, now,
      ...(d.env ? { env: d.env } : {}), ...(d.exec ? { exec: d.exec } : {}), ...(d.fetch ? { fetch: d.fetch } : {}),
      ...(d.parseCommand ? { parseCommand: d.parseCommand } : {}),
      ...(d.macExec ? { macExec: d.macExec } : {}), ...(d.osRelease !== undefined ? { osRelease: d.osRelease } : {}),
      details: true, handed,
      ...(flags.has("--skip-commands") ? { skipCommands: true as const } : {}), ...(flags.has("--skip-mac") ? { skipMac: true as const } : {}),
      ...(refreshWait !== undefined ? { refreshWait } : {}),
    });
    const events = read.events.map((ev) => detailsEventOf(ev, read.nowMs, runDate));
    const answered = new Map(read.sources.map((s) => [s.id, s]));
    const skipped = new Set((read.skipped ?? []).map((s) => s.id));
    const sources: CalendarDetailsSource[] = configuredCalendarSources(res.r, d.platform).flatMap((c): CalendarDetailsSource[] => {
      const origin = c.kind === "link" ? { command: res.r.links.find((l) => l.id === c.id)?.urlFrom === "command" } : {};
      if (skipped.has(c.id)) return [{ id: c.id, kind: c.kind, ...origin, skipped: true }];
      const s = answered.get(c.id);
      return s ? [{ id: s.id, kind: s.kind, ...origin, status: s.status, ...(s.reason !== undefined ? { reason: s.reason } : {}) }] : [];
    });
    const doc: CalendarDetailsJson = {
      schemaVersion: 1, readAt: new Date(read.nowMs).toISOString(), events, sources,
      readerOutdated: read.sources.some((s) => s.kind === "macos" && s.notices?.includes("helper-outdated") === true),
      links: read.links ?? [],
    };
    d.out(JSON.stringify(doc));
    return 0;
  } catch {
    return failed(d, "internal", 1);
  }
}
