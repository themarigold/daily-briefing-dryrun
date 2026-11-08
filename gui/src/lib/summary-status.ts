/** One ordered summary-status reader per App. Only a save hides old text, synchronously; every other read keeps the
 *  last state until it answers, then updates in place, so a focus does not make the summary flicker. */
import type { SummaryInput } from "./deck";
import type { Snapshot } from "./state";
import { latestMtime, summaryRevisionOf, summaryStatusOf, type SummaryRevision, type SummaryStatus } from "./today";

export interface SummaryStatusState {
  known: boolean;
  status: SummaryStatus;
  revision: SummaryRevision | null;
}

/** The last accepted payload and the reader's key for it: the page's identity and the status revision. */
export interface KeptSummary {
  key: string;
  summary: SummaryInput;
}

/** App's one holder of that payload. It outlives Today's per-mount readers, so a return shows the text at once. */
export interface SummaryKept {
  read: () => KeptSummary | null;
  write: (next: KeptSummary | null) => void;
}

/** The three summary fields a watcher event can trigger on. A trigger only: its values are never published. */
function triggerOf(snapshot: Snapshot): string {
  return JSON.stringify([summaryRevisionOf(snapshot), summaryStatusOf(snapshot), latestMtime(snapshot)]);
}

export function summaryStatusDriver(deps: {
  readSnapshot: () => Promise<Snapshot>;
  publish: (state: SummaryStatusState) => void;
  onerror: (error: unknown) => void;
  /** A read was applied, so whatever `onerror` last reported is over. */
  onrecovered: () => void;
}) {
  let generation = 0;
  let disposed = false;
  let held: SummaryStatusState = { known: false, status: { enabled: false, warnings: [] }, revision: null };
  /** ⚠ TWO "last seen"s, because the watcher can lag an ordered read for good. Config is not watched, so after a save
   *  or an external edit reads off, the watcher keeps re-emitting its held on with each countdown. Compared only to
   *  the last read, that would re-read every minute before the morning time. Compared only to the last event, a read
   *  that ran ahead would be repeated when its event arrives. An event is news only if it differs from both. */
  let lastEvent: string | null = null;
  /** What the newest applied read saw; null after a failed read, which knows nothing. */
  let lastRead: string | null = null;
  let newest: Promise<boolean> = Promise.resolve(false);
  /** `onerror` has reported a failure that nothing has ended yet, the same span as App's `summaryStatusError`. */
  let failed = false;
  let kept: KeptSummary | null = null;
  function fail(error: unknown): void {
    failed = true;
    deps.onerror(error);
  }
  function recover(): void {
    failed = false;
    deps.onrecovered();
  }
  async function read(mine: number): Promise<boolean> {
    try {
      const snapshot = await deps.readSnapshot();
      if (disposed) return false;
      if (mine !== generation) return newest;
      // `state_snapshot` folds a failed status read into `status: null`: that is a failed read, not off (M12).
      if (snapshot.status === null) {
        lastRead = null;
        if (snapshot.error !== null) fail(snapshot.error);
        return false;
      }
      lastRead = triggerOf(snapshot);
      held = { known: true, status: summaryStatusOf(snapshot), revision: summaryRevisionOf(snapshot) };
      // A read answering off forgets the text, so turning it on again later cannot bring it back ahead of its own read.
      if (!held.status.enabled) kept = null;
      deps.publish(held);
      recover();
      return true;
    } catch (error) {
      if (disposed) return false;
      if (mine !== generation) return newest;
      lastRead = null;
      fail(error);
      return false;
    }
  }
  /** Settles when the newest read has, which may be a later one than this call started: a caller waiting on the answer
   *  (the reader's mount) must not go on while one is still out. True when that read answered and was published. */
  function refresh(): Promise<boolean> {
    if (disposed) return Promise.resolve(false);
    newest = read(++generation);
    return newest;
  }
  /** A settings save: an older enabled read must not restore text, so this hides it before anything else and then reads.
   *  The new generation drops any read still out. Hidden stays hidden until a later read answers. */
  async function saved(): Promise<void> {
    if (disposed) return;
    held = { ...held, known: false };
    deps.publish(held);
    await refresh();
  }
  /** A snapshot read outside this driver. Any with a status proves status reads again, so the failure line is over. */
  function noteStatus(next: Snapshot): void {
    if (!disposed && failed && next.status !== null) recover();
  }
  /** A `state:changed` payload. Before the morning time one arrives every minute (`minutesUntilFloor`), and each
   *  refresh costs engine processes, so only a change in the summary's fields reads (R5-M3).
   *  A snapshot with no status says nothing about them, so it is neither a trigger nor remembered. A failed read is
   *  not retried by the next event: focus, mount or a real change reads again. The event does end its failure line. */
  function onWatcher(next: Snapshot): void {
    noteStatus(next);
    if (next.status === null) return;
    const trigger = triggerOf(next);
    const seen = trigger === lastEvent || trigger === lastRead;
    lastEvent = trigger;
    if (!seen) void refresh();
  }
  /** For where the failure line shows with no reader to read again: History, Schedule. No timer calls this. */
  function retryIfFailed(): void {
    if (failed) void refresh();
  }
  /** Writes only while this driver's own state is known-on: a reply landing behind a save's hide keeps nothing. */
  const keptSummary: SummaryKept = {
    read: () => kept,
    write: (next) => { if (!disposed && held.known && held.status.enabled) kept = next; },
  };
  return { refresh, saved, onWatcher, noteStatus, retryIfFailed, kept: keptSummary, dispose: () => { disposed = true; generation++; } };
}
