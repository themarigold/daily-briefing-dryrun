// src/calendar/reconcile.ts — today's window and RECONCILE, THEN FILTER (v0.3.0, plan M3a; spec r4 §5).
//
// Pure: no I/O, no clock (the run date and every instant are inputs), never throws on any CalEvent shape the
// type allows. It consumes `CalEvent` values from every source — the link parser (M2c) and the Mac reader
// (M10c) — already CLEANED (`./clean.ts`, at read time), and returns today's events in display order. It
// does not depend on either producer; its tests build `CalEvent`s directly.
//
// The steps, in spec §5's order:
//   0. per copy: gate `organizerVerified` behind gate G6 for the copy's source kind (`CALENDAR_G6_PASSED`,
//      shipped OFF), and rebuild its provenance from the copy itself;
//   1. tombstones are kept (dropped only at step 4); a copy that ITS OWN link's UID index (`CalUidIndex`) shows
//      was moved OUT of the reconcile window, in a provably newer revision, is superseded;
//   2. key a (UID + recurrenceKey, any sources) groups copies — then splits a group whose sources disagree about
//      the time (below); key b (normalised title + identical `time` + the same organizer email when both have
//      one) then joins groups ONLY across different sources and ONLY on an unambiguous match — anything else is
//      left unmerged ("a visible duplicate beats a hidden meeting");
//   3. each group merges into one event (`mergeCopies`);
//   3c. key c (calendar near-duplicates, spec 2026-10-31 §3, user-directed exception to decision 19): over the
//      completed step-3 outputs, bucketed by `timeKey` alone, views whose every pair passes rules 1–5 (same time,
//      related titles, the same place or meeting, compatible organizers) merge as ONE event (`mergeNearDuplicates`),
//      all or nothing per cluster; key a and key b merges are never undone, and an all-cancelled cluster passes
//      through unmerged. Each view counts as its own source (spec §2 guarantees): the result is declined only when
//      every non-cancelled view declines (`crossSourceSelfStatus`), never cancelled (an all-cancelled cluster does not
//      merge), and never moved (the times are identical);
//
// ⚠ THE CROSS-SOURCE RULE (decision 19, 2026-10-09, user-directed). A visible duplicate or an outdated time beats
// a hidden meeting. So a copy from a DIFFERENT source may MERGE with an event — its attendees and sources are
// unioned, and text and provenance come from the most recent copy as always — but it may never CANCEL, MOVE or
// SUPERSEDE another source's copy: those effects need evidence from the SAME source. Concretely: a link's UID index
// supersedes only that link's copies (`supersededByIndex`); cancellation and the moved time are decided within each
// source (`mergeWithinSource`), and the merged event is cancelled only when every source's own copy is; sources
// whose copies disagree about the time are not merged at all (`splitBySourceTime`) — each shows at its own time.
// And a `declined` answer hides the meeting only when it comes from the provably newest revision of it
// (`selfStatusOf`): a stale or unprovable decline does not.
//   4. keep what overlaps today; drop cancelled and declined;
//   5. `unknown` reads as not accepted (`isNotAccepted`, for M3b);
//   6. all-day first, then by start.
import { createHash } from "node:crypto";
import type {
  CalAllDay, CalDate, CalEvent, CalProvenance, CalSelfStatus, CalSourceRef, CalTextField, CalTime, CalUidIndex,
  CalUidIndexEntry, CalendarSourceKind,
} from "./types";

// ── gate G6 (spec §9) ────────────────────────────────────────────────────────────────────────────────

/** Has gate G6 passed for this source kind? (spec §9: "Each source kind that passes may set
 *  `organizerVerified`; one that fails never does".) EventKit and Google links are measured separately.
 *  ⚠ SHIPPED OFF. Flip one only on a recorded G6 pass for that kind — the user runs G6 (plan §1); until
 *  then nothing is ever organizer-verified, whatever a source reports, so every unlocked attempt sees busy
 *  blocks only (§6). A link that is not a Google secret address never carries the trusted signal in the
 *  first place (the M2c parser sets it only for a Google link whose URL-path owner the user confirmed).
 *  G6 FAILED for BOTH kinds on 2026-10-12 (W3 VM sitting): a forged invite naming the user as organizer, opened on a
 *  Mac and added to a Google calendar, read as organizer-verified in EventKit (`isCurrentUser` on an editable
 *  calendar) AND on the Google secret link (ORGANIZER = the URL-path owner). The Google-link switch, briefly on in
 *  PR 2's branch on the strength of the Gmail-only case 1, stays OFF (user decision 2026-10-12). */
export const CALENDAR_G6_PASSED: Readonly<CalG6Switches> = Object.freeze({ eventkit: false, googleLink: false });

export type CalG6Switches = { eventkit: boolean; googleLink: boolean };

/** Has gate G6 passed for this source kind, under these switches? THE one kind→switch mapping: reconcile's step 0
 *  and the prompt's unlocked boundary (`./prompt.ts`) both read it from here, so the two can never disagree about
 *  which switch governs which source. Fail-safe: a kind it does not know is never verified. */
export function g6PassedFor(kind: CalendarSourceKind, g6: CalG6Switches): boolean {
  return kind === "macos" ? g6.eventkit === true : kind === "link" ? g6.googleLink === true : false;
}

// ── dates and windows ────────────────────────────────────────────────────────────────────────────────

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const WALL_RE = /^(\d{2}):(\d{2})$/;

function parseDate(d: CalDate): [number, number, number] | null {
  const m = DATE_RE.exec(d);
  if (!m) return null;
  const y = Number(m[1]), mo = Number(m[2]), da = Number(m[3]);
  // Round-trip, so 2026-02-30 is refused rather than rolled into March.
  const t = new Date(Date.UTC(y, mo - 1, da));
  return t.getUTCFullYear() === y && t.getUTCMonth() === mo - 1 && t.getUTCDate() === da ? [y, mo, da] : null;
}

/** `date` plus `n` calendar days, as `YYYY-MM-DD`. Pure date arithmetic (UTC fields), so no zone or DST
 *  can move it. Throws on a malformed date — callers pass the run date or a validated date. */
export function addDays(date: CalDate, n: number): CalDate {
  const p = parseDate(date);
  if (!p) throw new Error(`calendar: expected a YYYY-MM-DD date, got ${JSON.stringify(date)}`);
  return new Date(Date.UTC(p[0], p[1] - 1, p[2] + n)).toISOString().slice(0, 10);
}

/** The first instant of `date` in the process's LOCAL zone — `new Date(y, m, d)`, the DST-safe idiom of
 *  `src/time.ts`. On a day whose midnight does not exist (a zone whose DST starts at 00:00) that is the
 *  first instant that does. */
export function localMidnight(date: CalDate): number {
  const p = parseDate(date);
  if (!p) throw new Error(`calendar: expected a YYYY-MM-DD date, got ${JSON.stringify(date)}`);
  return new Date(p[0], p[1] - 1, p[2]).getTime();
}

export type CalWindow = { startMs: number; endMs: number };

/** TODAY (spec §5): `[local midnight of runDate, local midnight of the next day)`, by DATE arithmetic — so a
 *  23- or 25-hour DST day is exactly that long, and a run that crosses midnight keeps the day it started
 *  on, because the run date is the input (core.ts captures it once at run start) and no clock is read. */
export function calendarToday(runDate: CalDate): CalWindow {
  return { startMs: localMidnight(runDate), endMs: localMidnight(addDays(runDate, 1)) };
}

/** The RECONCILE window (spec §5 step 1): today ± 2 days for links, ± 1 day for the Mac source (the helper
 *  clamps itself to yesterday 00:00 – tomorrow 24:00, §4.1). Producers collect occurrences in it; the
 *  link pre-filter (M2c) uses the link window; `reconcileCalendar` uses it for far-moved copies. */
export function reconcileWindow(runDate: CalDate, kind: CalendarSourceKind): CalWindow {
  const pad = kind === "macos" ? 1 : 2;
  return { startMs: localMidnight(addDays(runDate, -pad)), endMs: localMidnight(addDays(runDate, pad + 1)) };
}

/** An all-day event from an INCLUSIVE last day (EventKit's convention), normalised to iCalendar's exclusive
 *  end (spec §5: "both are normalised to dates"). A last day before the first reads as a one-day event. The
 *  Mac reader (M10c) builds its all-day `CalTime` through this. */
export function allDayFromInclusiveEnd(startDate: CalDate, lastDateInclusive: CalDate): CalAllDay {
  const last = lastDateInclusive < startDate ? startDate : lastDateInclusive;
  return { kind: "allDay", startDate, endDateExclusive: addDays(last, 1) };
}

/** The local instant of a wall time on a date — how an `unclear` event is ORDERED among timed ones (it is
 *  never placed for free/busy purposes: its zone is unknown). NaN when either part is malformed. */
function localWall(date: CalDate, wall: string): number {
  const p = parseDate(date), w = WALL_RE.exec(wall);
  if (!p || !w) return Number.NaN;
  return new Date(p[0], p[1] - 1, p[2], Number(w[1]), Number(w[2])).getTime();
}

/** Does `time` overlap today? A zero-length timed event overlaps when it falls inside the day; an event that
 *  ends exactly at today's first instant is yesterday's. An all-day event whose exclusive end is not after
 *  its start is read as one day. A malformed date never overlaps (producers emit validated shapes; garbage
 *  must not reach the prompt). */
export function overlapsToday(time: CalTime, runDate: CalDate): boolean {
  switch (time.kind) {
    case "timed": {
      const { startMs, endMs } = calendarToday(runDate);
      if (!Number.isFinite(time.startMs) || !Number.isFinite(time.endMs)) return false;
      if (time.endMs <= time.startMs) return time.startMs >= startMs && time.startMs < endMs;
      return time.startMs < endMs && time.endMs > startMs;
    }
    case "allDay": {
      if (!parseDate(time.startDate) || !parseDate(time.endDateExclusive)) return false;
      const end = time.endDateExclusive > time.startDate ? time.endDateExclusive : addDays(time.startDate, 1);
      return time.startDate <= runDate && end > runDate;
    }
    case "unclear": {
      if (!parseDate(time.startDate) || !parseDate(time.endDate)) return false;
      return time.startDate <= runDate && time.endDate >= runDate;
    }
  }
}

// ── revisions ────────────────────────────────────────────────────────────────────────────────────────

type Revision = { sequence?: number; lastModified?: number };

const num = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** Is `a` PROVABLY a later revision than `b`? SEQUENCE first when both carry one and they differ, else
 *  LAST-MODIFIED when both carry one. Anything else is "cannot tell" — false — because every use of this
 *  relation can HIDE an event (a superseded copy, a cancelled merge), and an unknown must keep it visible. */
export function newerThan(a: Revision, b: Revision): boolean {
  if (num(a.sequence) && num(b.sequence) && a.sequence !== b.sequence) return a.sequence > b.sequence;
  if (num(a.lastModified) && num(b.lastModified)) return a.lastModified > b.lastModified;
  return false;
}

/** A TOTAL preorder for ranking copies when nothing is provable: LAST-MODIFIED, then SEQUENCE, each with a
 *  missing value lowest — a plain lexicographic key, so it is transitive whatever mix of fields the copies carry.
 *  Positive when `a` ranks after `b`.
 *  ⚠ NOT "SEQUENCE when both carry one, else LAST-MODIFIED": that rule cycles when only some copies have a
 *  SEQUENCE ({seq 1, lm 10} > {lm 5} > {seq 2, lm 1} > {seq 1, lm 10}), and a sort with a cyclic comparator
 *  returns an input-order-dependent result (M2b checkpoint LOW). SEQUENCE still decides first wherever it is
 *  PROVABLE: `latestCopy` ranks only copies no other copy is `newerThan`, and two such copies never carry two
 *  different SEQUENCE values. */
function revisionOrder(a: Revision, b: Revision): number {
  const key = (r: Revision, f: "lastModified" | "sequence"): number => (num(r[f]) ? r[f] : -Infinity);
  for (const f of ["lastModified", "sequence"] as const) {
    const x = key(a, f), y = key(b, f);
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// ── step 0: normalise one copy ───────────────────────────────────────────────────────────────────────

const TEXT_FIELDS: readonly CalTextField[] = ["title", "location", "description"];

/** The copy as reconcile sees it: `organizerVerified` gated by G6 for EVERY source the copy names (a copy
 *  with no source can never be verified), and provenance rebuilt from the copy itself — a producer's own
 *  provenance is not trusted, and the gated flag is what M3b's unlocked variant reads per field (§6). */
function normaliseCopy(ev: CalEvent, g6: CalG6Switches): CalEvent {
  const sources = Array.isArray(ev.sources) ? ev.sources : [];
  const verified = ev.organizerVerified === true && sources.length > 0 && sources.every((s) => g6PassedFor(s.kind, g6));
  const provenance: Partial<Record<CalTextField, CalProvenance>> = {};
  const origin = sources[0];
  if (origin) {
    for (const f of TEXT_FIELDS) {
      if (typeof ev[f] === "string") provenance[f] = { kind: origin.kind, id: origin.id, calendarId: origin.calendarId, organizerVerified: verified };
    }
  }
  return { ...ev, sources, attendees: Array.isArray(ev.attendees) ? ev.attendees : [], organizerVerified: verified, provenance };
}

// ── step 1: far-moved copies (the UID index) ─────────────────────────────────────────────────────────

/** Per (UID, recurrence id): at most ONE entry per source (`collapseIndexEntry`). */
type IndexByKey = Map<string, Map<string, CalUidIndexEntry>>;

const occurrenceKey = (uid: string, rid: string | undefined): string => `${uid}\u0000${rid ?? ""}`;

/** Final harden r3: two index entries of ONE source for the same (UID, recurrence id), folded into one — the
 *  newest revision by `revisionOrder` (a total preorder, so the fold is order-independent), carrying `recurs` when
 *  EITHER does, and a `startMs` only when every entry of that newest revision agrees on it (conflicting evidence
 *  cannot show the copy moved). The fold only ever REMOVES supersession: the kept entry is one of the originals with
 *  `recurs` possibly added and `startMs` possibly nulled, each of which supersedes less. Without it a feed of
 *  300,000 duplicate-UID entries made one reconcile pass 37.8 s (every copy of that UID walked every entry), past the
 *  step's outer timer. Applied in the parse CHILD (`ics.ts`) and again here, so the parent's cost is bounded by the
 *  number of distinct keys whatever the child sends. */
export function collapseIndexEntry(a: CalUidIndexEntry, b: CalUidIndexEntry): CalUidIndexEntry {
  const order = revisionOrder(a, b);
  const recurs = a.recurs === true || b.recurs === true;
  const base = order >= 0 ? a : b;
  const startMs = order !== 0 || a.startMs === b.startMs ? base.startMs : null;
  const out: CalUidIndexEntry = { ...base, startMs };
  if (recurs) out.recurs = true;
  return out;
}

/** The key `collapseIndexEntry` folds on — exported for the parse child. */
export const indexEntryKey = (e: Pick<CalUidIndexEntry, "uid" | "recurrenceId">): string => occurrenceKey(e.uid, e.recurrenceId);

/** The entries of every index, by (UID, recurrence id) and then source, one entry each (`collapseIndexEntry`) —
 *  built once in one linear pass, so a lookup costs at most one entry per source. */
function indexByKey(indexes: readonly CalUidIndex[]): IndexByKey {
  const by: IndexByKey = new Map();
  for (const idx of indexes) {
    for (const e of idx.entries) {
      if (typeof e.uid !== "string" || e.uid === "") continue;
      const k = occurrenceKey(e.uid, e.recurrenceId);
      let perSource = by.get(k);
      if (!perSource) { perSource = new Map(); by.set(k, perSource); }
      const had = perSource.get(idx.sourceId);
      perSource.set(idx.sourceId, had ? collapseIndexEntry(had, e) : e);
    }
  }
  return by;
}

/** Does some index entry show a provably newer revision of this occurrence that now STARTS outside the
 *  reconcile window (spec §5 step 1)? Same UID, same recurrence id (both absent, or equal). An entry whose
 *  start is inside the window does not supersede: that copy, if real, was parsed into an event of its own
 *  and meets this one under key a; if it was not (a parse failure), the stale copy stays visible.
 *  A series MASTER's entry (`recurs`) never supersedes: its start is the series' first, and a copy of that
 *  series with no `recurrenceKey` shares its key — the master would hide a real meeting today (M3a checkpoint).
 *  ⚠ ONLY THE COPY'S OWN LINK'S INDEX (the cross-source rule, header): another source carrying the same UID with a
 *  higher SEQUENCE and a far start must not make a real meeting vanish. */
function supersededByIndex(ev: CalEvent, by: IndexByKey, win: CalWindow): boolean {
  if (typeof ev.uid !== "string" || ev.uid === "") return false;
  for (const [sourceId, e] of by.get(occurrenceKey(ev.uid, ev.recurrenceKey)) ?? []) {
    if (!ev.sources.some((s) => s.kind === "link" && s.id === sourceId)) continue;
    if (e.recurs === true) continue;
    if (!num(e.startMs) || (e.startMs >= win.startMs && e.startMs < win.endMs)) continue;
    if (newerThan(e, ev)) return true;
  }
  return false;
}

// ── step 2: key a, key b ─────────────────────────────────────────────────────────────────────────────

const sourceKey = (s: CalSourceRef): string => `${s.kind}\u0000${s.id}`;

/** Key b's title comparison: NFKC, case-folded, whitespace collapsed. */
export function normaliseTitle(title: string): string {
  return (typeof title === "string" ? title : "").normalize("NFKC").toLowerCase().replace(/\s+/g, " ").trim();
}

function timeKey(t: CalTime): string {
  switch (t.kind) {
    case "timed": return `t\u0000${t.startMs}\u0000${t.endMs}`;
    case "allDay": return `a\u0000${t.startDate}\u0000${t.endDateExclusive}`;
    case "unclear": return `u\u0000${t.startDate}\u0000${t.endDate}\u0000${t.wallStart}\u0000${t.wallEnd}\u0000${t.tzid}`;
  }
}

const orgEmail = (ev: CalEvent): string | undefined =>
  typeof ev.organizer?.email === "string" && ev.organizer.email !== "" ? ev.organizer.email.toLowerCase() : undefined;

/** Key b's third condition: the same organizer email when BOTH have one. */
function organizersCompatible(a: CalEvent, b: CalEvent): boolean {
  const ea = orgEmail(a), eb = orgEmail(b);
  return ea === undefined || eb === undefined || ea === eb;
}

/** A bucket (same normalised title, same `time`) larger than this skips key b altogether: its members are
 *  left unmerged. Bounds the pairwise check on a hostile feed (5,000 identical events), and a crowd of
 *  identical events is the ambiguous case anyway.
 *  Also caps key c's bucket by time alone. */
const KEY_B_BUCKET_MAX = 50;

class UnionFind {
  private parent: number[];
  constructor(n: number) { this.parent = Array.from({ length: n }, (_, i) => i); }
  find(i: number): number {
    while (this.parent[i] !== i) { const p = this.parent[i]!; this.parent[i] = this.parent[p]!; i = this.parent[i]!; }
    return i;
  }
  union(a: number, b: number): void { const ra = this.find(a), rb = this.find(b); if (ra !== rb) this.parent[Math.max(ra, rb)] = Math.min(ra, rb); }
}

function groupsOf(uf: UnionFind, n: number): number[][] {
  const by = new Map<number, number[]>();
  for (let i = 0; i < n; i++) { const r = uf.find(i); const g = by.get(r); if (g) g.push(i); else by.set(r, [i]); }
  return [...by.values()];
}

// ── step 3: merge ────────────────────────────────────────────────────────────────────────────────────

const SELF_RANK: Readonly<Record<Exclude<CalSelfStatus, "declined">, number>> = {
  organizer: 4, accepted: 3, tentative: 2, "needs-action": 1, unknown: 0,
};

/** The order copies are ranked in, most recent first: `revisionOrder`; then, when that cannot tell them apart
 *  (equal or absent LAST-MODIFIED, no differing SEQUENCE), the copy that overlaps `runDate` first — so the
 *  merged event keeps a time that is today and stays visible — and then a STABLE source order (kind, id,
 *  calendar id). Never input order: the same copies must merge the same way whichever source answered first
 *  (M3a checkpoint LOW). `runDate` absent (a direct caller): the overlap step is skipped. */
function copyOrder(runDate: CalDate | undefined): (a: CalEvent, b: CalEvent) => number {
  const today = (c: CalEvent): number => (runDate !== undefined && overlapsToday(c.time, runDate) ? 1 : 0);
  const src = (c: CalEvent): string => { const s = c.sources[0]; return s ? `${s.kind}\u0000${s.id}\u0000${s.calendarId}` : ""; };
  return (a, b) => revisionOrder(b, a) || today(b) - today(a) || (src(a) < src(b) ? -1 : src(a) > src(b) ? 1 : 0);
}

/** The copy whose text, time and status the merged event takes WITHIN ONE SOURCE — "the most recently modified
 *  copy" (§5 step 3). Among the copies no other copy is provably newer than, the highest-ranked NOT-cancelled one
 *  wins, so a cancellation hides the event only when the cancelled copy is provably the latest; an unknown or a
 *  tie keeps the meeting visible. Called per source only (`mergeWithinSource`): across sources no copy can cancel
 *  or move another (the header's cross-source rule). */
function latestCopy(copies: readonly CalEvent[], runDate: CalDate | undefined): CalEvent {
  const order = copyOrder(runDate);
  const ranked = copies.map((c, i) => ({ c, i })).sort((x, y) => order(x.c, y.c) || x.i - y.i).map((x) => x.c);
  const maximal = ranked.filter((c) => !copies.some((o) => o !== c && newerThan(o, c)));
  const pool = maximal.length > 0 ? maximal : ranked;
  return pool.find((c) => c.status !== "cancelled") ?? pool[0]!;
}

/** `selfStatus` over every copy of one event: `declined` ONLY when a declined copy is the provably newest revision
 *  — `newerThan` every copy that does not decline (decision 19). A stale decline (an older SEQUENCE than an
 *  accept), or one no revision can order, does not hide the meeting: then the strongest remaining answer, organizer
 *  > accepted > tentative > needs-action > unknown. Every copy declining is a decline. */
function selfStatusOf(copies: readonly CalEvent[]): CalSelfStatus {
  const others = copies.filter((c) => c.selfStatus !== "declined");
  const declines = copies.filter((c) => c.selfStatus === "declined");
  if (declines.length > 0 && (others.length === 0 || declines.some((d) => others.every((o) => newerThan(d, o))))) return "declined";
  let best: Exclude<CalSelfStatus, "declined"> = "unknown";
  for (const c of others) {
    const st = c.selfStatus as Exclude<CalSelfStatus, "declined">;
    if ((SELF_RANK[st] ?? 0) > SELF_RANK[best]) best = st;
  }
  return best;
}

/** The merged event from `base` (whose text, time, status, transparency and organizer it takes) and the rest, most
 *  recent first: sources unioned; attendees unioned by email (each from the most recent copy listing it; attendees
 *  with no email, which cannot be matched, from `base` only); `selfStatus` over `allCopies` (`selfStatusOf`);
 *  `organizerVerified` when any copy is (each field's provenance carries its own copy's flag). The live read's raw
 *  `details` (redesign C; absent on the morning path, where no copy carries them) come whole from ONE of `detailsFrom`:
 *  the first Mac one with details, else the first with details, else none. WITHIN one source `detailsFrom` is only
 *  the copy whose text and time are kept (`mergeWithinSource`), so when it has none (for example, the ICS details
 *  budget ran out before it) the event has none and shows "Details not available": an older revision's people,
 *  notes and Join link are never taken in its place. ACROSS sources it is the sources' own views, each of which took
 *  its details that way, so a view without details may take another source's own view's (same event, same time). */
function assemble(base: CalEvent, byRecency: readonly CalEvent[], allCopies: readonly CalEvent[], detailsFrom: readonly CalEvent[]): CalEvent {
  const sources: CalSourceRef[] = [];
  const seenSource = new Set<string>();
  for (const c of allCopies) {
    for (const s of c.sources) {
      const k = `${sourceKey(s)}\u0000${s.calendarId}`;
      if (!seenSource.has(k)) { seenSource.add(k); sources.push(s); }
    }
  }
  const attendees: CalEvent["attendees"] = [];
  const seenEmail = new Set<string>();
  for (const c of byRecency) {
    for (const a of c.attendees) {
      const e = typeof a.email === "string" && a.email !== "" ? a.email.toLowerCase() : undefined;
      if (e === undefined) { if (c === base) attendees.push(a); continue; }
      if (!seenEmail.has(e)) { seenEmail.add(e); attendees.push(a); }
    }
  }
  const lastModified = allCopies.reduce<number | undefined>((m, c) => (num(c.lastModified) && (m === undefined || c.lastModified > m) ? c.lastModified : m), undefined);
  const merged: CalEvent = {
    ...base,
    sources,
    uid: base.uid ?? allCopies.find((c) => c.uid !== undefined)?.uid,
    recurrenceKey: base.recurrenceKey ?? allCopies.find((c) => c.recurrenceKey !== undefined)?.recurrenceKey,
    organizer: base.organizer ?? byRecency.find((c) => c.organizer !== undefined)?.organizer,
    attendees,
    selfStatus: selfStatusOf(allCopies),
    organizerVerified: allCopies.some((c) => c.organizerVerified),
    lastModified,
    details: detailsFrom.find((c) => c.sources[0]?.kind === "macos" && c.details !== undefined)?.details
      ?? detailsFrom.find((c) => c.details !== undefined)?.details,
  };
  for (const k of ["uid", "recurrenceKey", "organizer", "lastModified", "details"] as const) if (merged[k] === undefined) delete merged[k];
  return merged;
}

/** The copies of ONE source, merged: text, time and status (so a same-source "cancelled" and "moved") from its
 *  latest copy (`latestCopy`). */
function mergeWithinSource(copies: readonly CalEvent[], runDate: CalDate | undefined): CalEvent {
  const latest = latestCopy(copies, runDate);
  if (copies.length === 1) return { ...latest, selfStatus: selfStatusOf(copies) };
  const order = copyOrder(runDate);
  const byRecency = [latest, ...copies.filter((c) => c !== latest).map((c, i) => ({ c, i }))
    .sort((x, y) => order(x.c, y.c) || x.i - y.i).map((x) => x.c)];
  return assemble(latest, byRecency, copies, [latest]);
}

/** A copy's source identity: its sources' kind and id (two calendars of the Mac source are ONE source). */
const copySource = (c: CalEvent): string => [...new Set(c.sources.map(sourceKey))].sort().join("\u0001");

/** `copies` split by source, in first-appearance order. */
function bySource(copies: readonly CalEvent[]): CalEvent[][] {
  const parts = new Map<string, CalEvent[]>();
  for (const c of copies) { const k = copySource(c); const p = parts.get(k); if (p) p.push(c); else parts.set(k, [c]); }
  return [...parts.values()];
}

/** Merge the copies of ONE event (§5 step 3, under the header's cross-source rule). Each source's copies first
 *  merge on their own (`mergeWithinSource`: its latest copy's text, time and status). Across sources the views only
 *  MERGE: the base is the most recent view by the copy order that is NOT cancelled — so the event is cancelled only
 *  when every source's own copy is — and never a newer-by-revision view of another source over a live one; sources
 *  and attendees unioned, `selfStatus` per source and then across them (`crossSourceSelfStatus`: declined only when
 *  every source's own view declines).
 *  ⚠ TAKES G6-NORMALISED COPIES ONLY — copies that have been through `reconcileCalendar`'s step 0
 *  (`normaliseCopy`), which gates `organizerVerified` by G6 and rebuilds `provenance`. Exported for tests; a
 *  caller handing it raw producer copies would carry an ungated `organizerVerified` straight into the result.
 *  `runDate` breaks revision ties toward the copy that overlaps today (see `copyOrder`). `reconcileCalendar` hands
 *  it only copies whose sources agree on the time (`splitBySourceTime`). */
export function mergeCopies(copies: readonly CalEvent[], runDate?: CalDate): CalEvent {
  const views = bySource(copies).map((part) => mergeWithinSource(part, runDate));
  if (views.length === 1) return views[0]!;
  const order = copyOrder(runDate);
  const ranked = views.map((v, i) => ({ v, i })).sort((x, y) => order(x.v, y.v) || x.i - y.i).map((x) => x.v);
  const base = ranked.find((v) => v.status !== "cancelled") ?? ranked[0]!;
  const byRecency = [base, ...ranked.filter((v) => v !== base)];
  return { ...assemble(base, byRecency, copies, byRecency), selfStatus: crossSourceSelfStatus(views) };
}

/** Final harden r3: `selfStatus` ACROSS sources, from each source's own view (`selfStatusOf` over that source's
 *  copies). A decline HIDES the meeting, and decision 19 says another calendar's copy may never cancel, move or hide
 *  one — so `declined` only when EVERY source's own newest answer declines; otherwise the strongest answer any
 *  source gives. `selfStatusOf` over the copies of all sources let link B's decline at SEQUENCE 99 out-rank link A's
 *  accept at SEQUENCE 1, although the two numbers count revisions of different calendars. */
function crossSourceSelfStatus(views: readonly CalEvent[]): CalSelfStatus {
  if (views.every((v) => v.selfStatus === "declined")) return "declined";
  let best: Exclude<CalSelfStatus, "declined"> = "unknown";
  for (const v of views) {
    if (v.selfStatus === "declined") continue;
    const st = v.selfStatus as Exclude<CalSelfStatus, "declined">;
    if ((SELF_RANK[st] ?? 0) > SELF_RANK[best]) best = st;
  }
  return best;
}

/** Key a's group, split where its SOURCES DISAGREE ABOUT THE TIME (the cross-source rule): each source's copies
 *  merge on their own, and sources whose merged times are identical stay together; a source with another time
 *  becomes its own group — a visible duplicate, never a moved or hidden meeting. A group from one source is
 *  returned whole. */
function splitBySourceTime(group: CalEvent[], runDate: CalDate): CalEvent[][] {
  const parts = bySource(group);
  if (parts.length === 1) return [group];
  const byTime = new Map<string, CalEvent[]>();
  for (const part of parts) {
    const k = timeKey(mergeWithinSource(part, runDate).time);
    const g = byTime.get(k);
    if (g) g.push(...part); else byTime.set(k, [...part]);
  }
  return [...byTime.values()];
}

// ── step 3c: key c, near-duplicates across calendars (spec 2026-10-31 §3) ─────────────────────────────

/** Key c's title normalisation (spec §3 rule 3): NFKC, case-folded (`toLowerCase`, plan §1.1), every Unicode
 *  punctuation and symbol character turned into a space, whitespace collapsed and trimmed. Key b's
 *  `normaliseTitle` is a different, unchanged function. Exported for details.ts' `otherNotes` title test (one
 *  function, two callers). */
export function nearDupTitle(title: string): string {
  return (typeof title === "string" ? title : "").normalize("NFKC").toLowerCase()
    .replace(/[\p{P}\p{S}]/gu, " ").replace(/\s+/gu, " ").trim();
}

/** Rule 3: are two titles related? An empty normalised title never matches. Sharing a calendar needs equal
 *  normalised titles; otherwise equal, or one containing the other as contiguous whole tokens. */
export function titlesRelated(a: string, b: string, sharedCalendar: boolean): boolean {
  const na = nearDupTitle(a), nb = nearDupTitle(b);
  if (na === "" || nb === "") return false;
  if (na === nb) return true;
  if (sharedCalendar) return false;
  const [short, long] = na.length <= nb.length ? [na.split(" "), nb.split(" ")] : [nb.split(" "), na.split(" ")];
  for (let i = 0; i + short.length <= long.length; i++) {
    if (short.every((t, j) => long[i + j] === t)) return true;
  }
  return false;
}

/** One step-3 output's key facts (spec §3 "Keep facts over each view's constituent copies"), built from its
 *  constituent copies and kept in reconcile's local map, never on `CalEvent`: the distinct placeKeys (P), linkKeys
 *  (L) and meeting keys, absent producer keys omitted, and its calendars as `kind\0id\0calendarId`. */
export type KeyCFacts = {
  P: ReadonlySet<string>;
  L: ReadonlySet<string>;
  meetingKeys: ReadonlySet<string>;
  calendars: ReadonlySet<string>;
};

const calendarKey = (s: CalSourceRef): string => `${s.kind}\u0000${s.id}\u0000${s.calendarId}`;

/** The facts of one step-3 output from its constituent copies (an accepted key-b component's flattened groups, or a
 *  refused output's own group). */
function keyCFactsOf(constituents: readonly CalEvent[]): KeyCFacts {
  const P = new Set<string>(), L = new Set<string>(), meetingKeys = new Set<string>(), calendars = new Set<string>();
  for (const c of constituents) {
    if (typeof c.placeKey === "string") P.add(c.placeKey);
    if (Array.isArray(c.linkKeys)) for (const k of c.linkKeys) if (typeof k === "string") L.add(k);
    if (typeof c.meetingKey === "string") meetingKeys.add(c.meetingKey);
    for (const s of c.sources) calendars.add(calendarKey(s));
  }
  return { P, L, meetingKeys, calendars };
}

const intersects = (a: ReadonlySet<string>, b: ReadonlySet<string>): boolean => {
  for (const x of a) if (b.has(x)) return true;
  return false;
};

/** Rule 4(b): both views carry the same SINGLE meeting key. */
function sameMeetingId(a: KeyCFacts, b: KeyCFacts): boolean {
  return a.meetingKeys.size === 1 && b.meetingKeys.size === 1 && intersects(a.meetingKeys, b.meetingKeys);
}

/** Rule 4's vetoes, in spec order, for one pair: true when a veto STANDS after (b) is applied. The meeting-key vetoes
 *  (either view with two or more keys; two non-empty disjoint key sets) always stand. The cross-kind veto (both
 *  location-fact sets F = P ∪ L ∪ meeting keys non-empty, sharing no placeKey, linkKey or meeting key) stands when it
 *  fires; it cannot fire when (b) holds. The place veto (both P non-empty and disjoint) stands unless (b) holds. The
 *  link veto is subsumed by the cross-kind veto (rule 4.4) and has no check of its own. */
export function placeFactsVeto(a: KeyCFacts, b: KeyCFacts): boolean {
  if (a.meetingKeys.size >= 2 || b.meetingKeys.size >= 2) return true;
  if (a.meetingKeys.size > 0 && b.meetingKeys.size > 0 && !intersects(a.meetingKeys, b.meetingKeys)) return true;
  const fa = a.P.size + a.L.size + a.meetingKeys.size, fb = b.P.size + b.L.size + b.meetingKeys.size;
  if (fa > 0 && fb > 0 && !intersects(a.P, b.P) && !intersects(a.L, b.L) && !intersects(a.meetingKeys, b.meetingKeys)) return true;
  if (a.P.size > 0 && b.P.size > 0 && !intersects(a.P, b.P) && !sameMeetingId(a, b)) return true;
  return false;
}

/** Rules 1–5 for one pair of step-3 views (spec §3): the same `timeKey`; related titles, strictly equal when the views
 *  share a calendar; no standing rule-4 veto, and then (a) a shared placeKey, (b) the same single meeting key or equal
 *  normalised titles; compatible organizers. */
function pairPasses(a: CalEvent, fa: KeyCFacts, b: CalEvent, fb: KeyCFacts): boolean {
  if (timeKey(a.time) !== timeKey(b.time)) return false;
  if (!titlesRelated(a.title, b.title, intersects(fa.calendars, fb.calendars))) return false;
  if (placeFactsVeto(fa, fb)) return false;
  if (!(intersects(fa.P, fb.P) || sameMeetingId(fa, fb) || nearDupTitle(a.title) === nearDupTitle(b.title))) return false;
  return organizersCompatible(a, b);
}

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
const NO_FACTS: KeyCFacts = { P: new Set(), L: new Set(), meetingKeys: new Set(), calendars: new Set() };

/** A deterministic serialisation: object keys sorted recursively, keys holding `undefined` left out, array order kept. */
function canonicalJson(x: unknown): string {
  if (Array.isArray(x)) return `[${x.map(canonicalJson).join(",")}]`;
  if (x !== null && typeof x === "object") {
    const o = x as Record<string, unknown>;
    return `{${Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
  }
  return JSON.stringify(x) ?? "undefined";
}

/** The final merge-order tie-break (spec §3 "Merge order"): SHA-256 of a canonical serialisation of every
 *  output-relevant field of the view and its own key facts. Each field is written as `[name]` when absent and
 *  `[name, value]` when present, in a fixed field order; objects are serialised with sorted keys; sources and the key
 *  sets are sorted; attendees, details' people and other arrays keep their order. */
export function canonicalViewHash(view: CalEvent, facts: KeyCFacts): string {
  const sortedSources = (Array.isArray(view.sources) ? view.sources : []).map((s) => ({ s, k: calendarKey(s) }))
    .sort((a, b) => cmpStr(a.k, b.k)).map((x) => x.s);
  const fields: [string, unknown][] = [
    ["time", view.time], ["title", view.title], ["location", view.location], ["description", view.description], ["uid", view.uid],
    ["recurrenceKey", view.recurrenceKey], ["sequence", view.sequence], ["lastModified", view.lastModified], ["status", view.status],
    ["selfStatus", view.selfStatus], ["transparency", view.transparency], ["organizer", view.organizer], ["attendees", view.attendees],
    ["organizerVerified", view.organizerVerified], ["provenance", view.provenance], ["details", view.details],
    ["meetingKey", view.meetingKey], ["placeKey", view.placeKey], ["linkKeys", view.linkKeys],
    ["P", [...facts.P].sort()], ["L", [...facts.L].sort()], ["meetingKeys", [...facts.meetingKeys].sort()], ["sources", sortedSources],
  ];
  return sha256(canonicalJson(fields.map(([name, value]) => (value === undefined ? [name] : [name, value]))));
}

/** Key c's merge order (spec §3 "Merge order"), most recent first: `copyOrder`'s revision and overlap-today steps;
 *  then each view's sorted MINIMUM source (kind, id, calendarId), where `copyOrder` reads `sources[0]`; then uid,
 *  absent last; then SHA-256 of title, location and description (absent text as empty); then `canonicalViewHash`. A
 *  complete tie means either view gives identical output. `copyOrder` itself is unchanged for keys a and b. */
export function keyCOrder(runDate: CalDate, facts: ReadonlyMap<CalEvent, KeyCFacts>): (a: CalEvent, b: CalEvent) => number {
  const today = (c: CalEvent): number => (overlapsToday(c.time, runDate) ? 1 : 0);
  const minSource = (c: CalEvent): string => (Array.isArray(c.sources) ? c.sources : []).map(calendarKey).sort()[0] ?? "";
  const uid = (a: CalEvent, b: CalEvent): number => {
    const ua = typeof a.uid === "string" ? a.uid : undefined, ub = typeof b.uid === "string" ? b.uid : undefined;
    return ua === ub ? 0 : ua === undefined ? 1 : ub === undefined ? -1 : cmpStr(ua, ub);
  };
  const text = (c: CalEvent): string => sha256(`${c.title ?? ""}\u0000${c.location ?? ""}\u0000${c.description ?? ""}`);
  const canon = (c: CalEvent): string => canonicalViewHash(c, facts.get(c) ?? NO_FACTS);
  return (a, b) => revisionOrder(b, a) || today(b) - today(a) || cmpStr(minSource(a), minSource(b)) || uid(a, b)
    || cmpStr(text(a), text(b)) || cmpStr(canon(a), canon(b));
}

/** A view's trust tier (spec §3 "Trust tier", D3), from its OWN fields, never the merged answer: 1 answered
 *  (`accepted`, `tentative`, or `organizer` verified after step 0 — never while G6 is off); 2 own entry (`unknown`
 *  with no organizer and no attendees, or an unverified `organizer` with no attendees); 3 everything else. */
export function tierOf(view: CalEvent): 1 | 2 | 3 {
  const attendees = Array.isArray(view.attendees) ? view.attendees.length : 0;
  switch (view.selfStatus) {
    case "accepted": case "tentative": return 1;
    case "organizer": return view.organizerVerified === true ? 1 : attendees === 0 ? 2 : 3;
    case "unknown": return view.organizer === undefined && attendees === 0 ? 2 : 3;
    default: return 3;
  }
}

/** The core ranking (spec §3 "Core = base"): tier, then the shortest key-c-normalised title in Unicode scalars, then
 *  `keyCOrder`. Pure; never mutates its inputs. */
export function coreOrder(runDate: CalDate, facts: ReadonlyMap<CalEvent, KeyCFacts>): (a: CalEvent, b: CalEvent) => number {
  const merge = keyCOrder(runDate, facts);
  const scalars = (c: CalEvent): number => [...nearDupTitle(c.title)].length;
  return (a, b) => tierOf(a) - tierOf(b) || scalars(a) - scalars(b) || merge(a, b);
}

/** The core of a key-c cluster: the best non-cancelled view by `coreOrder`, the original object; undefined when
 *  every view is cancelled. Pure; never mutates its inputs. */
export function selectNearDupCore(views: readonly CalEvent[], runDate: CalDate, facts: ReadonlyMap<CalEvent, KeyCFacts>): CalEvent | undefined {
  const order = coreOrder(runDate, facts);
  let best: CalEvent | undefined;
  for (const v of views) if (v.status !== "cancelled" && (best === undefined || order(v, best) < 0)) best = v;
  return best;
}

/** One key-c cluster (at least one view not cancelled), merged (spec §3 "How a key-c component merges"): each view is
 *  its own source. The core is the base: `assemble(core, live, live, [core])` where `live` is the core and then the
 *  other non-cancelled views in merge order, and the sources are replaced by the union over EVERY view in merge order,
 *  cancelled views last. Then, over the non-cancelled views only (spec §2 guarantees; §3 "Status", "Transparency",
 *  "Organizer", "Location fallback"; §6):
 *  - `status` from the highest tier present: confirmed if any view there is, else tentative;
 *  - `selfStatus` across the views (`crossSourceSelfStatus`): declined only when every one declines, so a provably newer
 *    decline in one calendar never hides another calendar's view, as `assemble`'s within-source `selfStatusOf` would;
 *  - busy if any view that does not decline is busy, counting them all when every one declines;
 *  - the organizer is the core's, else the first tier-1 view's in merge order;
 *  - text is the core's; with no core location, the first view with one by (tier, merge order) supplies it and its
 *    location provenance; the description is always the core's;
 *  - the decided mark `nearDuplicate`.
 *  Never through `mergeCopies` or `mergeWithinSource`: a newer view in another Mac calendar must not hide a live one.
 *  `opts.details` is the details-mode switch: set, the result carries `viewDetails` (two or more non-cancelled views). */
function mergeNearDuplicates(views: readonly CalEvent[], opts: { runDate: CalDate; facts: ReadonlyMap<CalEvent, KeyCFacts>; details: boolean }): CalEvent {
  const order = keyCOrder(opts.runDate, opts.facts);
  const ordered = views.map((v, i) => ({ v, i })).sort((x, y) => order(x.v, y.v) || x.i - y.i).map((x) => x.v);
  // Defensive fallback: the only caller skips all-cancelled clusters before selecting a core.
  const core = selectNearDupCore(views, opts.runDate, opts.facts) ?? ordered[0]!;
  const live = [core, ...ordered.filter((v) => v !== core && v.status !== "cancelled")];
  const merged = assemble(core, live, live, [core]);
  const sources: CalSourceRef[] = [];
  const seen = new Set<string>();
  for (const v of [...ordered.filter((x) => x.status !== "cancelled"), ...ordered.filter((x) => x.status === "cancelled")]) {
    for (const s of v.sources) {
      const k = calendarKey(s);
      if (!seen.has(k)) { seen.add(k); sources.push(s); }
    }
  }
  const topTier = Math.min(...live.map(tierOf));
  const top = live.filter((v) => tierOf(v) === topTier);
  const answering = live.filter((v) => v.selfStatus !== "declined");
  const result: CalEvent = {
    ...merged,
    sources,
    status: top.some((v) => v.status === "confirmed") ? "confirmed" : "tentative",
    selfStatus: crossSourceSelfStatus(live),
    transparency: (answering.length > 0 ? answering : live).some((v) => v.transparency === "busy") ? "busy" : "free",
    // The core's organizer, else the first tier-1 view's in merge order (never `assemble`'s any-view fallback).
    organizer: core.organizer ?? live.find((v) => v !== core && tierOf(v) === 1 && v.organizer !== undefined)?.organizer,
  };
  if (result.organizer === undefined) delete result.organizer;
  // The per-view carrier (spec §5 "Per-view carrier"), details mode only and only with two or more non-cancelled views:
  // the core first, then merge order, each view's cleaned title, trust tier and its own step-3 details (kept, possibly
  // undefined: never another revision's). `details` itself is the core's (`assemble` with `detailsFrom = [core]`).
  if (opts.details && live.length >= 2) result.viewDetails = live.map((v) => ({ title: v.title, tier: tierOf(v), details: v.details }));
  // The decided mark (spec §6), over the non-cancelled views, each counting once whatever calendars it spans: pairwise
  // disjoint calendar sets → `calendars` with the distinct calendars, else `copies` with the views; none below two.
  // `count` is always ≥ 2: views naming no source have empty (trivially disjoint) calendar sets, so a union of fewer
  // than two calendars falls back to `copies`, which counts the two or more live views.
  if (live.length >= 2) {
    // Defensive fallback: the only caller supplies facts for every output view.
    const sets = live.map((v) => opts.facts.get(v)?.calendars ?? new Set(v.sources.map(calendarKey)));
    const union = new Set<string>();
    let disjoint = true;
    for (const set of sets) {
      if (intersects(set, union)) disjoint = false;
      for (const c of set) union.add(c);
    }
    result.nearDuplicate = disjoint && union.size >= 2 ? { mark: "calendars", count: union.size } : { mark: "copies", count: live.length };
  }
  // Text (title, location, description) and provenance are the core's (`assemble`'s base); with no core location, the
  // first other view with one by (tier, merge order) supplies it, its location provenance with it.
  const hasLocation = (v: CalEvent): boolean => typeof v.location === "string" && v.location !== "";
  if (!hasLocation(core)) {
    const from = live.slice(1).map((v, i) => ({ v, i })).sort((x, y) => tierOf(x.v) - tierOf(y.v) || x.i - y.i).map((x) => x.v).find(hasLocation);
    if (from !== undefined) {
      result.location = from.location;
      const provenance = { ...core.provenance };
      if (from.provenance?.location !== undefined) provenance.location = from.provenance.location; else delete provenance.location;
      result.provenance = provenance;
    }
  }
  return result;
}

/** Key c over the completed step-3 outputs (spec §3 "Where it runs"), `facts[i]` the key facts of `out[i]`: each
 *  bucket by `timeKey` alone of 2 to `KEY_B_BUCKET_MAX` views gets its own union-find over the pairs that pass rules
 *  1–5; a cluster merges only when EVERY pair in it passes (rule 6), and an all-cancelled cluster passes through. A
 *  merged cluster takes the place of its first member; the others leave the list. */
function nearDuplicateMerge(out: readonly CalEvent[], facts: readonly KeyCFacts[], runDate: CalDate, details: boolean): CalEvent[] {
  const factsOfView = new Map<CalEvent, KeyCFacts>(out.map((e, i) => [e, facts[i]!]));
  const buckets = new Map<string, number[]>();
  out.forEach((e, i) => {
    const k = timeKey(e.time);
    const b = buckets.get(k);
    if (b) b.push(i); else buckets.set(k, [i]);
  });
  const replaced = new Map<number, CalEvent | null>();
  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > KEY_B_BUCKET_MAX) continue;
    const passes = bucket.map(() => new Array<boolean>(bucket.length).fill(false));
    const uf = new UnionFind(bucket.length);
    for (let x = 0; x < bucket.length; x++) {
      for (let y = x + 1; y < bucket.length; y++) {
        const i = bucket[x]!, j = bucket[y]!;
        if (pairPasses(out[i]!, facts[i]!, out[j]!, facts[j]!)) { passes[x]![y] = passes[y]![x] = true; uf.union(x, y); }
      }
    }
    for (const cluster of groupsOf(uf, bucket.length)) {
      if (cluster.length < 2) continue;
      if (!cluster.every((x) => cluster.every((y) => x === y || passes[x]![y]))) continue;
      const views = cluster.map((x) => out[bucket[x]!]!);
      if (views.every((v) => v.status === "cancelled")) continue;
      const first = Math.min(...cluster.map((x) => bucket[x]!));
      replaced.set(first, mergeNearDuplicates(views, { runDate, facts: factsOfView, details }));
      for (const x of cluster) if (bucket[x]! !== first) replaced.set(bucket[x]!, null);
    }
  }
  const result: CalEvent[] = [];
  out.forEach((e, i) => {
    const r = replaced.get(i);
    if (r === undefined) result.push(e); else if (r !== null) result.push(r);
  });
  return result;
}

// ── the whole pass ───────────────────────────────────────────────────────────────────────────────────

export type ReconcileInput = {
  /** The run's local date, captured once at run start. */
  runDate: CalDate;
  /** Every copy from every source, in the sources' reconcile windows, CLEANED, tombstones included. */
  copies: readonly CalEvent[];
  /** The link parsers' UID indexes (one per link); none for the Mac source. */
  indexes?: readonly CalUidIndex[];
  /** TEST-ONLY override of `CALENDAR_G6_PASSED`. Production passes nothing — pinned by a scan of src/ in
   *  test/calendar-reconcile.test.ts (only this file and `./prompt.ts`, the two definitions, name `g6`; each
   *  reads its override exactly once). In this file the one reader is `reconcileBeforeFilter`, the second function
   *  that takes a `ReconcileInput`; it is called only by `reconcileCalendar` and by tests, so no production caller
   *  passes the override through it either. */
  g6?: CalG6Switches;
  /** The live details read (spec §5): key c then records each merged view's details (`CalEvent.viewDetails`). Passed
   *  explicitly by the details read, never inferred from whether a copy happens to carry details; the morning path
   *  passes nothing. */
  details?: true;
};

/** Spec §5 "Reconcile, then filter", steps 1–6. Returns today's events, merged, without cancelled or
 *  declined ones, all-day first and then by start. Steps 0–3c are `reconcileBeforeFilter`. */
export function reconcileCalendar(input: ReconcileInput): CalEvent[] {
  // 4 and 6.
  return reconcileBeforeFilter(input)
    .filter((e) => e.status !== "cancelled" && e.selfStatus !== "declined" && overlapsToday(e.time, input.runDate))
    .map((e, i) => ({ e, i }))
    .sort((a, b) => compareForDisplay(a.e, b.e) || a.i - b.i)
    .map((x) => x.e);
}

/** Steps 0–3 and key c (3c): the completed merge outputs immediately before step 4's filter, cancelled, declined
 *  and not-today ones included. The production path of `reconcileCalendar`, exported so tests can observe what the
 *  filter hides. */
export function reconcileBeforeFilter(input: ReconcileInput): CalEvent[] {
  const g6 = input.g6 ?? CALENDAR_G6_PASSED;
  const linkWindow = reconcileWindow(input.runDate, "link");
  const index = indexByKey(input.indexes ?? []);

  // 0–1
  const copies = input.copies.map((c) => normaliseCopy(c, g6)).filter((c) => !supersededByIndex(c, index, linkWindow));

  // 2a. key a — any sources, including within one (the same event in two Mac calendars).
  const ufA = new UnionFind(copies.length);
  const byKeyA = new Map<string, number>();
  copies.forEach((c, i) => {
    if (typeof c.uid !== "string" || c.uid === "") return;
    const k = occurrenceKey(c.uid, c.recurrenceKey);
    const first = byKeyA.get(k);
    if (first === undefined) byKeyA.set(k, i); else ufA.union(first, i);
  });
  const groups = groupsOf(ufA, copies.length).flatMap((idx) => splitBySourceTime(idx.map((i) => copies[i]!), input.runDate));
  const views = groups.map((g) => mergeCopies(g, input.runDate));
  const groupSources = groups.map((g) => new Set(g.flatMap((c) => c.sources.map(sourceKey))));

  // 2b. key b — across different sources only, unambiguous matches only.
  const ufB = new UnionFind(groups.length);
  const buckets = new Map<string, number[]>();
  views.forEach((v, i) => {
    const k = `${normaliseTitle(v.title)}\u0001${timeKey(v.time)}`;
    const b = buckets.get(k);
    if (b) b.push(i); else buckets.set(k, [i]);
  });
  // Disjoint and both non-empty: a copy that names no source can never be shown to come from a DIFFERENT one.
  const disjoint = (a: Set<string>, b: Set<string>): boolean => {
    if (a.size === 0 || b.size === 0) return false;
    for (const x of a) if (b.has(x)) return false;
    return true;
  };
  for (const bucket of buckets.values()) {
    if (bucket.length < 2 || bucket.length > KEY_B_BUCKET_MAX) continue;
    const candidates = new Map<number, number[]>(bucket.map((i) => [i, []]));
    for (let x = 0; x < bucket.length; x++) {
      for (let y = x + 1; y < bucket.length; y++) {
        const i = bucket[x]!, j = bucket[y]!;
        if (disjoint(groupSources[i]!, groupSources[j]!) && organizersCompatible(views[i]!, views[j]!)) {
          candidates.get(i)!.push(j); candidates.get(j)!.push(i);
        }
      }
    }
    // A pair is unambiguous when, for every source the other group has, it is the ONLY candidate holding that
    // source — from both sides. Two lookalikes in one source make every pair with them ambiguous.
    const onlyOne = (i: number, j: number): boolean => {
      for (const s of groupSources[j]!) if (candidates.get(i)!.filter((k) => groupSources[k]!.has(s)).length !== 1) return false;
      return true;
    };
    for (const i of bucket) for (const j of candidates.get(i)!) if (i < j && onlyOne(i, j) && onlyOne(j, i)) ufB.union(i, j);
  }

  // 3. merge — a key-b component is accepted only if every pair in it is itself a valid key-b match
  // (pairwise disjoint sources, organizers pairwise compatible); a chain that joins two different organizers
  // through a copy that has none is split back into its groups.
  const out: CalEvent[] = [];
  // Each output's constituent copies, for key c's facts: an accepted component's flattened groups, else the
  // output's own group.
  const constituents: CalEvent[][] = [];
  for (const comp of groupsOf(ufB, groups.length)) {
    let ok = true;
    for (let x = 0; ok && x < comp.length; x++) {
      for (let y = x + 1; ok && y < comp.length; y++) {
        const i = comp[x]!, j = comp[y]!;
        ok = disjoint(groupSources[i]!, groupSources[j]!) && organizersCompatible(views[i]!, views[j]!);
      }
    }
    if (ok) out.push(comp.length === 1 ? views[comp[0]!]! : mergeCopies(comp.flatMap((i) => groups[i]!), input.runDate));
    else for (const i of comp) out.push(views[i]!);
    constituents.push(...(ok ? [comp.flatMap((i) => groups[i]!)] : comp.map((i) => groups[i]!)));
  }

  // 3c. key c, after every step-3 output is complete and before step 4.
  return nearDuplicateMerge(out, constituents.map(keyCFactsOf), input.runDate, input.details === true);
}

/** Step 5: `unknown` is treated as NOT accepted, like `needs-action` (M3b withholds descriptions from such
 *  events in the locked variant and shows "invited, not accepted" in the unlocked one, spec §6). */
export function isNotAccepted(ev: Pick<CalEvent, "selfStatus">): boolean {
  return ev.selfStatus === "needs-action" || ev.selfStatus === "unknown";
}

/** Sort key for step 6: an all-day event before anything timed; then by start (an `unclear` one at its wall
 *  time read locally), then end, then title. */
function startKey(t: CalTime): number {
  switch (t.kind) {
    case "timed": return t.startMs;
    case "allDay": return localWall(t.startDate, "00:00");
    case "unclear": return localWall(t.startDate, t.wallStart);
  }
}
function endKey(t: CalTime): number {
  switch (t.kind) {
    case "timed": return t.endMs;
    case "allDay": return localWall(t.endDateExclusive, "00:00");
    case "unclear": return localWall(t.endDate, t.wallEnd);
  }
}

function compareForDisplay(a: CalEvent, b: CalEvent): number {
  const ad = a.time.kind === "allDay" ? 0 : 1, bd = b.time.kind === "allDay" ? 0 : 1;
  if (ad !== bd) return ad - bd;
  const cmp = (x: number, y: number): number => (Number.isNaN(x) ? (Number.isNaN(y) ? 0 : 1) : Number.isNaN(y) ? -1 : x - y);
  return cmp(startKey(a.time), startKey(b.time)) || cmp(endKey(a.time), endKey(b.time)) || (a.title < b.title ? -1 : a.title > b.title ? 1 : 0);
}
