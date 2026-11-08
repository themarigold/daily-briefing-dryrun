// src/providerStatus.ts — `<state>/provider-status.json`, the per-entry status the app's provider list reads
// (provider-fallback plan P1-M5-T2; spec r9 §5 Reporting).
//
// Keyed by LABEL (identity is the label, never the position). Each record carries the entry's `revision`
// (`entryRevision`), its newest walk observation (`lastRun`) and key test (`lastTest`), `failingSince` (set by the
// first failure after the last ok, carrying the revision it was observed at, so an edited entry never inherits an
// old failure), and the quick-check latch (`quickCheck`, P1-M7-T4). The transitions are PURE; the file I/O is
// atomic and NON-FATAL, like every other piece of advisory state. Nothing here carries key bytes or provider
// text: an observation's `reason` is a classifier reason (src/failover.ts), never a message.
import { writePrivateAtomic } from "./strictFile";
import { providerStatusPath } from "./marker";
import type { MarkReason } from "./account";
import { FAILOVER_REASONS, type FailoverReason } from "./failover";

/** One observation of an entry, from a walk (`lastRun`) or a key test (`lastTest`). `reason` is the classifier's,
 *  for a failure. */
export type Observation = { at: string; revision: string; ok: boolean; reason?: FailoverReason };

export type LabelRecord = {
  revision?: string;
  lastTest?: Observation;
  lastRun?: Observation;
  failingSince?: { at: string; revision: string };
  quickCheck?: { localDate: string; revision: string };
  /** The newest `HISTORY_LIMIT` observations, oldest first — when, whether ok, at which revision, nothing else — kept
   *  because the two slots alone cannot order a late result between earlier ones, and `failingSince` is rebuilt from
   *  this timeline on every observation (see `observe`). */
  history?: { at: string; ok: boolean; revision: string }[];
};

/** How many observations `history` keeps (codex review LOW). */
export const HISTORY_LIMIT = 16;

export type ProviderStatus = { labels: Record<string, LabelRecord> };

/** A label no longer in the saved config is kept this long after its newest observation, so a quick undo of a
 *  removal does not lose the row's history. */
export const STATUS_PRUNE_MS = 7 * 24 * 60 * 60 * 1000;

const ms = (iso: string): number => Date.parse(iso);

/**
 * Apply one observation. Observations can arrive OUT OF ORDER — `provider test` probes unlocked and applies its
 * result later (spec r9g), so a test begun before a walk can land after it — so `at`, not arrival, decides:
 *   • the observation replaces its own slot only when it is at least as new as what that slot holds;
 *   • the record's `revision` follows the NEWEST observation overall, never a late one;
 *   • `failingSince` is REBUILT from the timeline at the current revision — the bounded `history`, ordered by `at` —
 *     as the earliest failure after the newest ok, keeping a previous start that still qualifies. Any ok newer than every failure clears it; a revision change starts afresh, never
 *     inheriting an older revision's failure.
 * ⚠ Accepted, in the safe direction (P1-M5 checkpoint LOW 6): a key test of an UNSAVED candidate revision is the
 * newest observation, so it moves `revision` and resets the saved entry's `failingSince` — the saved entry's next
 * failure starts a fresh one. It never makes a failure look older than it is.
 */
function observe(rec: LabelRecord | undefined, obs: Observation, slot: "lastRun" | "lastTest"): LabelRecord {
  const prev = rec ?? {};
  const out: LabelRecord = { ...prev };
  const held = prev[slot];
  if (held === undefined || ms(obs.at) >= ms(held.at)) out[slot] = { ...obs };
  if (prev.revision === undefined || ms(obs.at) >= newestAt(prev)) out.revision = obs.revision;   // `newestAt`, the one copy (L8)
  const revision = out.revision!;
  const history = [...(prev.history ?? []), { at: obs.at, ok: obs.ok, revision: obs.revision }]
    .sort((a, b) => ms(a.at) - ms(b.at))
    .slice(-HISTORY_LIMIT);
  out.history = history;
  const atRevision = history.filter((h) => h.revision === revision);
  const okAt = Math.max(Number.NEGATIVE_INFINITY, ...atRevision.filter((h) => h.ok).map((h) => ms(h.at)));
  const failures = atRevision.filter((h) => !h.ok && ms(h.at) > okAt).map((h) => h.at);
  // A start that fell out of the bounded window is kept while nothing newer at this revision was ok.
  if (prev.failingSince?.revision === revision && ms(prev.failingSince.at) > okAt) failures.push(prev.failingSince.at);
  const start = failures.sort((a, b) => ms(a) - ms(b))[0];
  if (start === undefined) delete out.failingSince;
  else out.failingSince = { at: start, revision };
  return out;
}

/** The record after a walk observed the entry (won, or failed with `reason`). PURE. */
export function observeRun(rec: LabelRecord | undefined, obs: Observation): LabelRecord {
  return observe(rec, obs, "lastRun");
}

/** The record after a key test of the entry. PURE. */
export function observeTest(rec: LabelRecord | undefined, obs: Observation): LabelRecord {
  return observe(rec, obs, "lastTest");
}

/** Is the quick-check latch on for this record (spec r9 §5 step 4)? It holds today's local date and the entry's CURRENT
 *  revision, and the newest observation at that revision is not ok — an ok run, or a passing key test (PR 2), clears it,
 *  as do a revision change and a new local date. PURE. */
export function quickCheckActive(rec: LabelRecord | undefined, revision: string, localDate: string): boolean {
  const qc = rec?.quickCheck;
  if (qc === undefined || qc.localDate !== localDate || qc.revision !== revision) return false;
  const newest = [rec!.lastRun, rec!.lastTest]
    .filter((o): o is Observation => o !== undefined && o.revision === revision)
    .sort((a, b) => ms(b.at) - ms(a.at))[0];
  return newest?.ok !== true;
}

export type RowStatus =
  | { kind: "invalid"; reason: string }
  | { kind: "out-of-usage"; until: string }
  | { kind: "paused"; until: string; reason: MarkReason }
  | { kind: "not-working"; since: string; reason: string }
  | { kind: "working"; at: string }
  | { kind: "key-accepted"; at: string }
  | { kind: "not-tested" };

/**
 * One row's status, by precedence: out of usage → paused → the newest
 * observation AT THE ENTRY'S CURRENT REVISION (failed → not working since `failingSince`; ok run → working; ok
 * test → key accepted) → not tested. `marks` are the `skipped` list of `markFilter` (with the current item 1), so
 * an hour mark on item 1 has already been dropped and item 1 never reads "paused". A DROPPED entry's row is built by
 * its caller (`status --json`'s `providerRows`: kind `invalid`, its scrubbed warning) — the one path (round 5 L6). PURE.
 */
export function rowStatus(
  entry: { label: string; revision: string },
  rec: LabelRecord | undefined,
  marks: readonly { entry: { label: string }; reason: MarkReason; until: string }[],
  now: Date,
): RowStatus {
  const mine = marks.filter((m) => m.entry.label === entry.label && Date.parse(m.until) > now.getTime());
  const usage = mine.find((m) => m.reason === "usage");
  if (usage) return { kind: "out-of-usage", until: usage.until };
  const hour = mine[0];
  if (hour) return { kind: "paused", until: hour.until, reason: hour.reason };
  const candidates = [rec?.lastRun && { obs: rec.lastRun, from: "run" as const }, rec?.lastTest && { obs: rec.lastTest, from: "test" as const }]
    .filter((c): c is { obs: Observation; from: "run" | "test" } => !!c && c.obs.revision === entry.revision)
    .sort((a, b) => Date.parse(b.obs.at) - Date.parse(a.obs.at));
  const newest = candidates[0];
  if (!newest) return { kind: "not-tested" };
  if (!newest.obs.ok) {
    const since = rec?.failingSince?.revision === entry.revision ? rec.failingSince.at : newest.obs.at;
    return { kind: "not-working", since, reason: newest.obs.reason ?? "failed" };
  }
  return newest.from === "run" ? { kind: "working", at: newest.obs.at } : { kind: "key-accepted", at: newest.obs.at };
}

const newestAt = (r: LabelRecord): number =>
  Math.max(...[r.lastRun?.at, r.lastTest?.at].map((a) => (a === undefined ? Number.NEGATIVE_INFINITY : Date.parse(a))));

/** Drop a label that is absent from the saved config once its newest observation is older than
 *  `STATUS_PRUNE_MS` (a label with no observation at all counts as old). Labels in the config are kept. PURE. */
export function pruneStatus(status: ProviderStatus, savedLabels: ReadonlySet<string>, now: Date): ProviderStatus {
  const labels: Record<string, LabelRecord> = Object.create(null);
  for (const [label, rec] of Object.entries(status.labels)) {
    if (savedLabels.has(label) || now.getTime() - newestAt(rec) <= STATUS_PRUNE_MS) labels[label] = rec;
  }
  return { labels };
}

const isStr = (v: unknown): v is string => typeof v === "string";

const isDate = (v: unknown): v is string => isStr(v) && Number.isFinite(Date.parse(v));
/** `YYYY-MM-DD`, and a real calendar day. */
const isLocalDate = (v: unknown): v is string =>
  isStr(v) && /^\d{4}-\d{2}-\d{2}$/.test(v) && isDate(`${v}T00:00:00Z`) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;
const isReason = (v: unknown): v is FailoverReason => isStr(v) && Object.hasOwn(FAILOVER_REASONS, v);

/** An observation as stored, or undefined: a bad date, or a reason this engine does not know, drops it. */
function readObservation(v: unknown): Observation | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o = v as Record<string, unknown>;
  if (!isDate(o.at) || !isStr(o.revision) || typeof o.ok !== "boolean") return undefined;
  if (o.reason !== undefined && !isReason(o.reason)) return undefined;
  return { at: o.at, revision: o.revision, ok: o.ok, ...(o.reason !== undefined ? { reason: o.reason as FailoverReason } : {}) };
}

function readRecord(v: unknown): LabelRecord | undefined {
  if (!v || typeof v !== "object" || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const out: LabelRecord = {};
  if (isStr(r.revision)) out.revision = r.revision;
  const lastRun = readObservation(r.lastRun), lastTest = readObservation(r.lastTest);
  if (lastRun) out.lastRun = lastRun;
  if (lastTest) out.lastTest = lastTest;
  const fs = r.failingSince as Record<string, unknown> | undefined;
  if (fs && isDate(fs.at) && isStr(fs.revision)) out.failingSince = { at: fs.at, revision: fs.revision };
  const qc = r.quickCheck as Record<string, unknown> | undefined;
  if (qc && isLocalDate(qc.localDate) && isStr(qc.revision)) out.quickCheck = { localDate: qc.localDate, revision: qc.revision };
  if (Array.isArray(r.history)) {
    const h = (r.history as unknown[]).filter((x): x is { at: string; ok: boolean; revision: string } => {
      const o = x as Record<string, unknown> | null;
      return !!o && isDate(o.at) && typeof o.ok === "boolean" && isStr(o.revision);
    }).map((o) => ({ at: o.at, ok: o.ok, revision: o.revision })).slice(-HISTORY_LIMIT);
    if (h.length) out.history = h;
  }
  return out;
}

/** The status file, or `undefined` when it is missing, unreadable or not the expected shape. A malformed label
 *  record is dropped and a malformed field within one is ignored. Never throws. */
export async function readProviderStatus(path: string = providerStatusPath()): Promise<ProviderStatus | undefined> {
  let raw: unknown;
  try { raw = await Bun.file(path).json(); } catch { return undefined; }
  if (!raw || typeof raw !== "object") return undefined;
  const labelsIn = (raw as { labels?: unknown }).labels;
  if (!labelsIn || typeof labelsIn !== "object" || Array.isArray(labelsIn)) return undefined;
  const labels: Record<string, LabelRecord> = Object.create(null);
  for (const [label, v] of Object.entries(labelsIn as Record<string, unknown>)) {
    const rec = readRecord(v);
    if (rec) labels[label] = rec;
  }
  return { labels };
}

/** Write the status file atomically (a unique temp file, then a rename in the same folder). NON-FATAL: returns
 *  `false` on any failure, never throws — a lost status write costs a stale row, never a run. */
export async function writeProviderStatus(status: ProviderStatus, path: string = providerStatusPath()): Promise<boolean> {
  // 0600 and atomic through the one shared writer: the file names the user's providers, and its mode must not
  // depend on the umask.
  try { await writePrivateAtomic(path, JSON.stringify(status, null, 2)); return true; } catch { return false; }
}
