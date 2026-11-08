/**
 * The briefing redesign's B1 (wave-2 plan B1-M5-T16): the live git check's DRIVER. Today calls it at its driver points
 * (plan §1.2): the page key (one keyed effect on `briefingKey`), `onCurrent`, `onMinute` and `onFocus`; B1 does not
 * use `onMove`. It asks `repos_status` and holds the answer; RUST GATES every ask (visibility, the current slide, the
 * stat check, one check in flight), so an ask is cheap when nothing changed.
 *
 * - `first` whenever the page key takes a new non-null value with the slides showing — any loaded page, a stale one
 *   included (its launchpad tiles still show). With no current slide (the slides off, or the Full briefing view) the
 *   `first` is OWED and sent when a slide becomes current. One `first` per key.
 * - `focus` on window focus; `minute` on the tick. Every ask carries the current slide; with none, nothing is sent.
 * - At most one ask outstanding and one queued: an ask made while one is outstanding replaces the queued one, keeping
 *   the stronger reason (`first` over `focus` over `minute`) and the latest request; it is sent when the outstanding
 *   answer arrives. An answer for a page key that is no longer current is dropped.
 * - An answer is applied through `mergeReply`. A `noResult` answer leaves B1's held rows as they are and sets
 *   `noResult`, which empties B2's action carrier (`liveActionCards`) until the next real answer. An IPC error (Rust's 30 s bound, a crashed sidecar, any rejected
 *   invoke) keeps the previous answer, marked not current (`fresh: false`); the next ask proceeds normally. An ask
 *   still outstanding after `ASK_LIMIT_MS` fails the same way and frees the slot; its late answer is dropped.
 * - `greenSince`: a tile's count reaching zero (from above zero) stamps the INJECTED CLOCK at the moment the answer is
 *   applied (R4-M4: Today's `now` moves only on a tick or a focus); a count above zero clears it. It never hides a
 *   tile itself: the model decides each green tile's life (`launchpadTiles`).
 *
 * ⚠ PURE OF TAURI. The invoke and the clock are injected (Today passes `reposStatus` and `Date.now`), so the tests
 * settle every promise themselves.
 */
import type { DeckView, SlideId } from "./deck";
import type { ReposReason, ReposStatusRequest } from "./engine";
import { mergeReply, reposRequest, type ActionCard, type GitHeld, type ReposIpcReply } from "./git-detail";

/** What Today passes to the deck as `gitDetail` (with the OS). */
export interface GitLiveState {
  reply: GitHeld | null;
  /** Push/group freshness; a status-only check cannot clear a full-check failure. */
  fresh: boolean;
  uncommittedFresh: boolean;
  greenSince: Readonly<Record<string, number>>;
  /** The latest answer for this page was `noResult`; the next real answer clears it. It leaves B1's held rows alone. */
  noResult: boolean;
}

/** B2's action carrier: Today's `actions` input and inventory driver read this. `noResult` grants no action (B2 :35). */
export function liveActionCards(state: GitLiveState): ActionCard[] {
  return state.noResult ? [] : (state.reply?.reply.actions ?? []);
}

export interface GitLiveDeps {
  invoke: (request: ReposStatusRequest) => Promise<ReposIpcReply>;
  /** Read when an answer is applied (the green tiles' stamp). */
  clock: () => number;
  /** Every change of state, as a new object. */
  onchange: (state: GitLiveState) => void;
  /** Calls `fire` after `ms` unless the returned cancel runs first (default `setTimeout`; the tests fire it). */
  timer?: (ms: number, fire: () => void) => () => void;
}

/** An ask outstanding this long fails (final review 5, L2): Rust's worst case, a stuck B2 sample (1 s), B1's stat work
 *  (5 s), the engine's bound (30 s) and a stuck acceptance (1 s), so a check that never answers (a stat stuck on a dead
 *  mount) dates the page "as of" instead of leaving it claimed current. */
export const ASK_LIMIT_MS = 37_000;

const realTimer = (ms: number, fire: () => void): (() => void) => {
  const id = setTimeout(fire, ms);
  return () => clearTimeout(id);
};

export interface GitLive {
  onPageKey(key: string | null, deck: DeckView): void;
  onCurrent(slide: SlideId | null, deck: DeckView): void;
  onFocus(deck: DeckView): void;
  onMinute(deck: DeckView): void;
  dispose(): void;
  state(): GitLiveState;
}

const STRENGTH: Readonly<Record<ReposReason, number>> = { first: 3, focus: 2, minute: 1 };

/** Each tile's count in a held answer, by the model's tile key; an unknown count is left out. */
function tileCounts(h: GitHeld): Map<string, number> {
  const out = new Map<string, number>([["onlyHere", h.reply.tile.commits]]);
  for (const v of h.reply.repoViews) if (v.state !== "noRepos" && "count" in v.uncommitted) out.set(`uncommitted:${v.key}`, v.uncommitted.count);
  return out;
}

export function gitLive(deps: GitLiveDeps): GitLive {
  let pageKey: string | null = null;
  let current: SlideId | null = null;
  /** A `first` not yet sent (or queued) for `pageKey`. */
  let firstOwed = false;
  let outstanding = false;
  let disposed = false;
  let queued: { key: string; reason: ReposReason; request: ReposStatusRequest } | null = null;
  let state: GitLiveState = { reply: null, fresh: true, uncommittedFresh: true, greenSince: {}, noResult: false };
  const counts = new Map<string, number>();

  const set = (next: GitLiveState): void => {
    state = next;
    deps.onchange(state);
  };

  function ask(reason: ReposReason, deck: DeckView): void {
    const r: ReposReason = firstOwed ? "first" : reason;
    if (disposed || pageKey === null || current === null || deck.kind !== "slides") return;
    const request: ReposStatusRequest = { ...reposRequest(deck.page), reason: r, current };
    if (r === "first") firstOwed = false;
    if (outstanding) {
      const keep = queued !== null && queued.key === pageKey && STRENGTH[queued.reason] > STRENGTH[r] ? queued.reason : r;
      queued = { key: pageKey, reason: keep, request: { ...request, reason: keep } };
      return;
    }
    send(pageKey, request);
  }

  function send(key: string, request: ReposStatusRequest): void {
    if (disposed) return;
    outstanding = true;
    let invoked: Promise<ReposIpcReply>;
    try {
      invoked = deps.invoke(request);
    } catch (e) {
      invoked = Promise.reject(e);
    }
    // Settled by the invoke or by the time limit, whichever comes first; the other is then a no-op.
    const pending = new Promise<ReposIpcReply>((resolve, reject) => {
      const cancel = (deps.timer ?? realTimer)(ASK_LIMIT_MS, () => reject(new Error("the live git check took too long")));
      invoked.then(
        (reply) => {
          cancel();
          resolve(reply);
        },
        (e: unknown) => {
          cancel();
          reject(e);
        },
      );
    });
    pending
      .then(
        (reply) => apply(key, request, reply),
        () => fail(key),
      )
      .finally(() => {
        outstanding = false;
        const q = queued;
        queued = null;
        if (disposed || q === null || q.key !== pageKey) return;
        if (current === null) {
          // The slides went away while it waited: nothing is sent; a `first` stays owed.
          if (q.reason === "first") firstOwed = true;
          return;
        }
        send(q.key, { ...q.request, current });
      });
  }

  function apply(key: string, request: ReposStatusRequest, reply: ReposIpcReply): void {
    if (disposed || key !== pageKey) return;
    if (reply.gate === "noResult") {
      if (!state.noResult) set({ ...state, noResult: true });
      return;
    }
    const previous = state.reply?.reply;
    // Rust updates checkedAt/heldAt only on a full check, and uncommittedAt on either scope.
    // first/focus always run the full scope, even if the injected clock did not move. A held
    // answer can carry a newer check from another caller, but an unchanged one proves no recheck.
    // With no GUI baseline after a failure, a ran minute is full only when both engine
    // timestamps agree (hold_all sets them together; status-only runs keep the older checkedAt).
    const fullChecked = (previous === undefined
      ? state.fresh || (reply.gate === "ran" && reply.checkedAt === reply.uncommittedAt)
      : reply.checkedAt !== previous.checkedAt || reply.heldAt !== previous.heldAt)
      || (reply.gate === "ran" && request.reason !== "minute");
    const statusChecked = fullChecked || reply.gate === "ran"
      || (previous !== undefined && reply.uncommittedAt !== previous.uncommittedAt);
    const held = mergeReply(state.reply, reply);
    if (held === null) return;
    const at = deps.clock();
    let greenSince = state.greenSince;
    for (const [k, n] of tileCounts(held)) {
      const before = counts.get(k);
      counts.set(k, n);
      if (n === 0 && before !== undefined && before > 0) greenSince = { ...greenSince, [k]: at };
      else if (n > 0 && Object.hasOwn(greenSince, k)) {
        const { [k]: _cleared, ...rest } = greenSince;
        greenSince = rest;
      }
    }
    set({ reply: held, fresh: fullChecked || state.fresh, uncommittedFresh: statusChecked || state.uncommittedFresh, greenSince, noResult: false });
  }

  function fail(key: string): void {
    if (disposed || key !== pageKey) return;
    set({ ...state, fresh: false, uncommittedFresh: false });
  }

  return {
    onPageKey(key, deck) {
      // `null` is no page (Today mounts with `latest` loading; a read error): never a key change.
      if (disposed || key === null || key === pageKey) return;
      pageKey = key;
      firstOwed = true;
      if (queued !== null && queued.key !== key) queued = null;
      counts.clear();
      set({ reply: null, fresh: true, uncommittedFresh: true, greenSince: {}, noResult: false });
      ask("first", deck);
    },
    onCurrent(slide, deck) {
      if (disposed) return;
      current = slide;
      if (slide !== null && firstOwed) ask("first", deck);
    },
    onFocus(deck) {
      ask("focus", deck);
    },
    onMinute(deck) {
      ask("minute", deck);
    },
    dispose() {
      disposed = true;
      queued = null;
      pageKey = null;
      current = null;
      firstOwed = false;
      counts.clear();
    },
    state: () => state,
  };
}
