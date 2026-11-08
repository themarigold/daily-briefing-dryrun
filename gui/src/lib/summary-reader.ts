/** Today's payload reader. Every reply, including identity-free absence, belongs to the request sent. */
import type { SummaryInput } from "./deck";
import type { SummaryReply } from "./engine";
import type { BriefingFile } from "./files";
import type { SummaryKept, SummaryStatusState } from "./summary-status";

export function summaryReader(deps: {
  readLatestSummary: (pageHash: string, pageVersion: string) => Promise<SummaryReply>;
  /** True when the ordered read answered: a failed one knows nothing. */
  refreshStatus: () => Promise<boolean>;
  /** App's holder, so a return to Today shows the last accepted payload at once, under the same key. */
  kept: SummaryKept;
  publish: (summary: SummaryInput | null) => void;
}) {
  let disposed = false;
  let mounted = false;
  let page: { pageHash: string; pageVersion: string } | null = null;
  let status: SummaryStatusState = { known: false, status: { enabled: false, warnings: [] }, revision: null };
  let confirmedOn = false;
  /** A status read has answered since this mount. Until then a known-on is App's older state, so no payload is read: it
   *  can only show what App kept under that key. Once true it stays: a later failed read keeps the last state, and the text. */
  let answered = false;
  let force = false;
  let queued = false;
  let refreshing = false;
  let refreshGeneration = 0;
  let generation = 0;
  let activeKey: string | null = null;
  let pendingKey: string | null = null;
  let cache: { key: string; summary: SummaryInput | null } | null = null;

  function gateKey(): string | null {
    if (!mounted || !page || !status.known || !status.status.enabled) return null;
    const revision = status.revision;
    if (revision && (revision.pageHash !== page.pageHash || revision.pageVersion !== page.pageVersion)) return null;
    return `${page.pageHash}:${page.pageVersion}:${revision?.state ?? "absent"}:${revision?.revision ?? "absent"}`;
  }
  function queue(): void {
    if (disposed || queued) return;
    queued = true;
    queueMicrotask(() => { queued = false; void read(); });
  }
  function changed(): void {
    const key = gateKey();
    if (key !== activeKey) {
      activeKey = key;
      generation++;
      pendingKey = null;
      const kept = key === null ? null : deps.kept.read();
      if (kept !== null && kept.key === key) {
        cache = kept;
        deps.publish(kept.summary);
      } else deps.publish(null);
    }
    queue();
  }
  async function read(): Promise<void> {
    const key = gateKey();
    if (disposed || refreshing || !answered || key === null || page === null) return;
    if (!force && cache?.key === key) { deps.publish(cache.summary); return; }
    if (!force && pendingKey === key) return;
    force = false;
    const requested = { ...page };
    const mine = ++generation;
    pendingKey = key;
    let summary: SummaryInput | null = null;
    let threw = false;
    try {
      const reply = await deps.readLatestSummary(requested.pageHash, requested.pageVersion);
      if (reply.state === "ready" && reply.pageHash === requested.pageHash && reply.pageVersion === requested.pageVersion
        && (status.revision === null || (reply.revision === status.revision.revision && status.revision.state === "ready"))) {
        summary = { ...requested, projects: reply.projects, goodMorningSentence: reply.goodMorningSentence };
      }
    } catch { threw = true; /* A file read failure is ordinary fallback, just like Rust's unavailable reply. */ }
    if (disposed || mine !== generation || key !== gateKey()) return;
    pendingKey = null;
    // A throw is no answer, so it keeps the last accepted payload at this key. A real non-ready answer replaces it.
    if (threw && cache?.key === key) summary = cache.summary;
    cache = { key, summary };
    deps.kept.write(summary && { key, summary });
    deps.publish(summary);
  }
  async function refresh(): Promise<void> {
    if (disposed) return;
    force = true;
    refreshing = true;
    const mine = ++refreshGeneration;
    let ok = false;
    try { ok = await deps.refreshStatus(); }
    finally {
      if (ok) answered = true;
      if (!disposed && mine === refreshGeneration) {
        // The payload read asks status itself, so this same failure would answer as ordinary absence and take the text.
        if (!ok) force = false;
        refreshing = false;
        queue();
      }
    }
  }
  return {
    onPage(file: BriefingFile | null): void {
      const next = file && /^[a-f0-9]{64}$/.test(file.pageHash ?? "") && /^[a-f0-9]{64}$/.test(file.pageVersion ?? "")
        ? { pageHash: file.pageHash!, pageVersion: file.pageVersion! } : null;
      if (next?.pageHash === page?.pageHash && next?.pageVersion === page?.pageVersion) return;
      page = next;
      changed();
    },
    onSnapshot(next: SummaryStatusState): void {
      if (disposed) return;
      if (next.known) {
        if (next.status.enabled && !confirmedOn) force = true;
        confirmedOn = next.status.enabled;
        // After a failed mount read, App's state changes only when a later read answers, so this is that answer. Its text
        // may be only what App kept, so it re-reads.
        if (mounted && !refreshing && !answered) { answered = true; force = true; }
      }
      status = next;
      changed();
    },
    onMount(): void { if (!disposed) { mounted = true; changed(); void refresh(); } },
    onFocus(): void { if (mounted) void refresh(); },
    dispose(): void { disposed = true; generation++; refreshGeneration++; },
  };
}
