/**
 * The Today store (wave-2 polish spec §3 "The Today store", §4, §5): module state with a listener set and a subscribe
 * function — the pattern of `app-prefs-store.ts` — so Today, Settings → Calendar and the wizard all see its changes
 * across routes (Today unmounts on every route change).
 *
 * Sections, each filled by its own task:
 *   - `briefing` (PB-M1-T1, here): the last loaded briefing file, its key, and the snapshot's `latestMtime` it was read
 *     under, so a Today remount whose snapshot still names that file starts `loaded` (no Good-morning flash);
 *   - `status` and the read-ordering counters (PB-M3-T1);
 *   - `flow`, the calendar question's flow (PB-M5-T2).
 * The full state shape is declared from the start; later tasks add transitions, never fields.
 *
 * ⚠ NEVER LOADED BY AN ENGINE TEST, NEVER IMPORTED FROM A `RUNTIME_GUI_MODULES` CHAIN (plan §0.6). Engine calls reach
 * this module as injected functions (the read, the write, the flows' `io`), never by import. Its run-time imports —
 * `calendar-settings.ts` (`parseStatus`, `CONFIG_OFF_SUFFIX`, `editBlock`, `withEnabled`), `calendar-question.ts` (the
 * flows' starting state and result lines) and `files.ts` (`describeFailure`) — reach `@tauri-apps/api/core`: that is
 * why no engine test may load it.
 */
import type { LinkRemoved } from "./calendar";
import type { CalendarStatusJson } from "./calendar-contract";
import {
  accessRefusedLine,
  accessThrewLine,
  MAC_NOT_ADDED_LINE,
  MAC_NOT_CHECKED_LINE,
  ON_LINE,
  startingState,
} from "./calendar-question";
import { CONFIG_OFF_SUFFIX, editBlock, parseStatus, withEnabled, type CalendarDeps } from "./calendar-settings";
import type { EngineOutcome } from "./engine";
import { describeFailure, type BriefingFile, type ConfigDocument } from "./files";
import type { LatestLoad } from "./today";

export interface KeptBriefing {
  file: BriefingFile;
  key: string;
  mtime: string | null;
}

export interface FlowRunning {
  origin: "today" | "wizard";
  phase: "access" | "saving";
}

export interface FlowResult {
  origin: "today" | "wizard";
  line: string;
  answered: boolean;
  drawn: boolean;
  pendingWrite: { enabled: boolean; then: string | null } | null;
}

export interface TodayStoreState {
  briefing: KeptBriefing | null;
  status: CalendarStatusJson | null;
  writesInFlight: number;
  /** A monotonic event count and the origin of the last settled "Not now"; initially 0 / null. */
  notNowSettled: number;
  notNowOrigin: "today" | "wizard" | null;
  flow: { running: FlowRunning | null; result: FlowResult | null };
}

function initialState(): TodayStoreState {
  return {
    briefing: null,
    status: null,
    writesInFlight: 0,
    notNowSettled: 0,
    notNowOrigin: null,
    flow: { running: null, result: null },
  };
}

let state: TodayStoreState = initialState();
const listeners = new Set<(s: Readonly<TodayStoreState>) => void>();

/** Replace the state and tell every subscriber. */
function publish(next: TodayStoreState): void {
  state = next;
  for (const listener of [...listeners]) listener(state);
}

/** The current state (read-only; every transition replaces it, so a held snapshot never changes underneath). */
export function todayStore(): Readonly<TodayStoreState> {
  return state;
}

/** Hear the current state at once, then every published transition. Returns the unsubscribe. */
export function onTodayStore(fn: (s: Readonly<TodayStoreState>) => void): () => void {
  listeners.add(fn);
  fn(state);
  return () => {
    listeners.delete(fn);
  };
}

/* ── briefing (PB-M1-T1) ──────────────────────────────────────────────────────────────────────── */

/** Keep the briefing Today just read (or `null`: no file, or the read failed — the kept one is dropped). */
export function keepBriefing(b: KeptBriefing | null): void {
  publish({ ...state, briefing: b });
}

/**
 * Today's first `latest` on mount: `loaded` from the kept briefing only when the current snapshot's `latestMtime` is
 * non-null and equals the one it was read under; otherwise `loading`, as before. A null `latestMtime` (no snapshot yet,
 * or an older engine) never matches.
 */
export function startingLatest(kept: KeptBriefing | null, mtime: string | null): LatestLoad {
  if (mtime !== null && kept !== null && kept.mtime === mtime) return { state: "loaded", file: kept.file };
  return { state: "loading" };
}

/**
 * One Today mount's reads of the latest briefing (checkpoint MED): each `load(forMtime)` reads, and — unless a fresher
 * read on this mount, or the mount's `dispose()` (its unmount), has overtaken it — keeps what it read under the mtime it
 * was read for (`null` for no file; an error drops the kept briefing) and answers Today's next `latest`. An overtaken
 * read keeps nothing and answers `null`, so an old mount's late answer can never overwrite what a newer mount kept.
 * The read, the error's sentence and the key are passed in (`readLatestBriefing`, `describeFailure`, `briefingHash`),
 * so this module keeps no run-time import.
 */
export function briefingReads(
  read: () => Promise<BriefingFile | null>,
  describe: (e: unknown) => string,
  keyOf: (text: string) => string,
): { load(forMtime: string | null): Promise<LatestLoad | null>; dispose(): void } {
  let seq = 0;
  return {
    async load(forMtime) {
      const mine = ++seq;
      try {
        const file = await read();
        if (mine !== seq) return null;
        keepBriefing(file === null ? null : { file, key: keyOf(file.text), mtime: forMtime });
        return file === null ? { state: "none" } : { state: "loaded", file };
      } catch (e) {
        if (mine !== seq) return null;
        keepBriefing(null);
        return { state: "error", message: describe(e) };
      }
    },
    dispose() {
      seq++;
    },
  };
}

/* ── status, its ordering, and the write chokepoint (PB-M3-T1, spec §5) ───────────────────────────── */

/**
 * ORDERING. A status read is applied only when it can describe the config as it is now: it started with no calendar
 * write in flight, no write started or settled while it ran (`gen` is bumped at both edges), and no newer read has been
 * applied. Anything else is `dropped`; a throw or an unparseable reply is `failed`. Dropped and failed change nothing.
 */
let inFlight = 0;
let gen = 0;
let seq = 0;
let lastApplied = 0;

/** Read `calendar status --json` through the store (every reader: App's start, Today's driver, Settings' refresh, the
 *  wizard). The caller still gets the outcome (or the thrown error) for its own display. */
export async function readStatusThroughStore(
  read: () => Promise<EngineOutcome>,
): Promise<{ outcome: EngineOutcome | null; error: unknown; verdict: "applied" | "dropped" | "failed" }> {
  const t = { seq: ++seq, gen, clean: inFlight === 0 };
  let outcome: EngineOutcome;
  try {
    outcome = await read();
  } catch (e) {
    return { outcome: null, error: e, verdict: "failed" };
  }
  const parsed = parseStatus(outcome.payload);
  if (parsed === null) return { outcome, error: null, verdict: "failed" };
  if (!(t.clean && gen === t.gen && t.seq > lastApplied)) return { outcome, error: null, verdict: "dropped" };
  lastApplied = t.seq;
  publish({ ...state, status: parsed });
  return { outcome, error: null, verdict: "applied" };
}

/**
 * Bracket every calendar write: in flight (published) before it starts, settled (published) after it answers, also on
 * a rejection or a throw, which is rethrown. `accepted` is the call site's own rule for "this wrote" (a block save that
 * is not `invalid`, a link written or removed, `connectWrote` for Allow access).
 *
 * A LATER CHOICE WINS (spec §4): an accepted write drops a held result that carries a `pendingWrite`, so a stale
 * "Try again" can never undo a change made since — unless the write IS that result's own retry (`retryOf`, passed only
 * by its "Try again"). A rejected or invalid write drops nothing.
 */
export async function storeWrite<T>(write: () => Promise<T>, accepted: (value: T) => boolean, retryOf?: FlowResult): Promise<T> {
  inFlight++;
  gen++;
  publish({ ...state, writesInFlight: inFlight });
  let wrote = false;
  try {
    const value = await write();
    wrote = accepted(value);
    return value;
  } finally {
    inFlight--;
    gen++;
    const held = state.flow.result;
    const drop = wrote && held !== null && held.pendingWrite !== null && held !== retryOf;
    publish({ ...state, writesInFlight: inFlight, flow: drop ? { ...state.flow, result: null } : state.flow });
  }
}

/** Allow access's acceptance (and the question's Mac path's): `calendar connect mac` wrote the `macos` source into the
 *  config (`payload.configUpdated === true`). `already`, a refusal and a failed insertion write nothing. The one copy. */
export function connectWrote(outcome: EngineOutcome): boolean {
  const p = outcome.payload;
  return typeof p === "object" && p !== null && !Array.isArray(p) && (p as Record<string, unknown>)["configUpdated"] === true;
}

/**
 * `CalendarDeps.saveBlock` through the store: every `editBlock` save (the switch, a source, an owner, a link's entry)
 * is a write, and an accepted one (any kind but `invalid`) patches the stored reply's `enabled` and `enabledSet` from
 * the block it wrote — when that block has an own, non-null boolean `enabled` — so the answer holds even if the
 * re-read after it fails.
 */
export function storeSaveBlock(save: CalendarDeps["saveBlock"], retryOf?: FlowResult): CalendarDeps["saveBlock"] {
  return (block) =>
    storeWrite(
      async () => {
        const outcome = await save(block);
        const enabled = Object.hasOwn(block, "enabled") ? block["enabled"] : undefined;
        if (outcome.kind !== "invalid" && typeof enabled === "boolean" && state.status !== null) {
          publish({ ...state, status: { ...state.status, enabled, enabledSet: true } });
        }
        return outcome;
      },
      (outcome) => outcome.kind !== "invalid",
      retryOf,
    );
}

/**
 * `calendarLinkRemove` through the store. A removal that RESOLVED wrote when it changed something: its link file was
 * deleted (`file: "removed"` — Rust deletes the file before it edits the config, `calendar_link_remove`, so a config
 * step that then came back `invalid` still changed what the calendar reads), or its config step saved. A resolved
 * removal with the file already `absent` and a config step `unchanged`, `invalid` or none (no config) changed nothing
 * (PB r1 X8). A rejection wrote nothing, EXCEPT Rust's `configAfterRemoval` with `removed: "removed"`: the file was
 * deleted, then the config step failed (PB-M5-T2). The rejection is carried through `storeWrite` as a value, so its
 * settle can count it, and rethrown after.
 */
export function storeLinkRemove(remove: (id: string) => Promise<LinkRemoved>): (id: string) => Promise<LinkRemoved> {
  return async (id) => {
    const r = await storeWrite(
      () => remove(id).then((value) => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error })),
      (settled) => (settled.ok ? settled.value.file === "removed" || settled.value.config?.kind === "saved" : fileRemovedBeforeFailure(settled.error)),
    );
    if (!r.ok) throw r.error;
    return r.value;
  };
}

/** Rust's `CalendarError::ConfigAfterRemoval` after it deleted the link's file (`calendar.ts`'s `configAfterRemoval`). */
function fileRemovedBeforeFailure(e: unknown): boolean {
  if (typeof e !== "object" || e === null) return false;
  const r = e as { kind?: unknown; removed?: unknown };
  return r.kind === "configAfterRemoval" && r.removed === "removed";
}

/** The generation a live calendar read was sent at (the driver keeps it for `applyCalendarOff`). */
export function liveReadSent(): number {
  return gen;
}

/**
 * A live read was refused `calendar-off` (spec §5): the ORDERING verdict — no calendar write started since it was sent
 * and none is in flight. On true, a stored reply's `enabled` is patched false (published); with no stored reply status
 * stays null (nothing is fabricated) and the verdict is still true. False only when a write overtook the read.
 */
export function applyCalendarOff(sentGen: number): boolean {
  if (gen !== sentGen || inFlight !== 0) return false;
  if (state.status !== null) publish({ ...state, status: { ...state.status, enabled: false } });
  return true;
}

/** "On" (spec §5): a stored reply that says enabled. No reply yet counts as off. */
export function calendarOn(s: CalendarStatusJson | null): boolean {
  return s !== null && s.enabled === true;
}

/** "Never asked" (spec §4): a stored reply whose block carries no own, non-null `enabled`. */
export function neverAsked(s: CalendarStatusJson | null): boolean {
  return s !== null && !s.enabledSet;
}

/** The engine switched the calendar off for a malformed block (a warning ending `CONFIG_OFF_SUFFIX`). */
export function malformed(s: CalendarStatusJson): boolean {
  return s.configWarnings.some((w) => w.endsWith(CONFIG_OFF_SUFFIX));
}

/* ── the calendar question's flows (PB-M5-T2, spec §4 "Flows") ───────────────────────────────────── */

/** The engine calls a flow makes, injected (in the app: `calendarStatus`, `calendarConnectMac`, `readConfig`,
 *  `calendarConfigSave`). Every save goes through `storeSaveBlock`, the connect through `storeWrite`. */
export interface FlowIo {
  status: () => Promise<EngineOutcome>;
  connectMac: () => Promise<EngineOutcome>;
  readConfig: () => Promise<ConfigDocument>;
  saveBlock: CalendarDeps["saveBlock"];
}

/**
 * How a flow (or a press that started none) ended, for the card and the wizard:
 * - `on` / `off`: answered — the calendar turned on, or a failure written off (`flow.result` holds its line);
 * - `notNow`: "Not now" (or its retry) settled — no result; `notNowSettled` counted it;
 * - `failed`: a follow-up write failed — the result carries `pendingWrite` ("Try again");
 * - `busy`: the Mac connect call was refused `busy` — nothing written, no result (the card's own line);
 * - `unanswered`: a link session closed without turning the calendar on;
 * - `link`: Show my calendar on the Link path — no flow; the card opens its link session;
 * - `blocked`: nothing started (a flow running, a write in flight, no stored status, or nothing to retry).
 */
export type FlowEnd = "on" | "off" | "notNow" | "failed" | "busy" | "unanswered" | "link" | "blocked";

/** Set by `leaveWizard` while a wizard flow runs: its result (pendingWrite included) is dropped when it settles. */
let dropWhenSettled = false;

/** A flow can start: none running and no calendar write in flight (Settings' included). */
export function canStart(): boolean {
  return state.flow.running === null && inFlight === 0;
}

function setPhase(origin: FlowRunning["origin"], phase: FlowRunning["phase"]): void {
  publish({ ...state, flow: { ...state.flow, running: { origin, phase } } });
}

/** Run a flow: `running` set (synchronously, so a second press finds it), the body's writes, patches and re-reads,
 *  then `running` cleared with the body's result in one publish — `undefined` leaves the held result as it is.
 *  The store holds ONE result: a flow's result (a failed write's included) replaces whatever is held. The one exception
 *  is a flow `leaveWizard` abandoned (`dropWhenSettled`): its own result is dropped, and a held result of the OTHER
 *  origin — one it never replaced, e.g. a Today "Try again" — is kept (PB r1 X7); its accepted write has already dropped
 *  a held write by the later-choice rule (`storeWrite`). */
async function runFlow(
  origin: FlowRunning["origin"],
  phase: FlowRunning["phase"],
  body: () => Promise<{ end: FlowEnd; result?: FlowResult | null; notNow?: boolean }>,
): Promise<FlowEnd> {
  dropWhenSettled = false;
  setPhase(origin, phase);
  let out: { end: FlowEnd; result?: FlowResult | null; notNow?: boolean } = { end: "blocked" };
  try {
    out = await body();
    return out.end;
  } finally {
    const held = state.flow.result;
    const kept = held !== null && held.origin !== origin ? held : null;
    const result = out.result === undefined ? held : dropWhenSettled ? kept : out.result;
    dropWhenSettled = false;
    publish({
      ...state,
      ...(out.notNow ? { notNowSettled: state.notNowSettled + 1, notNowOrigin: origin } : {}),
      flow: { running: null, result },
    });
  }
}

/** One `enabled` write through `editBlock` (the store's save, which patches `enabled`/`enabledSet`), then one re-read
 *  whatever the write did (a failed re-read leaves the patch standing). `then` is the line on success; `null` is
 *  "Not now", which has none. A failure holds the write as `pendingWrite` for "Try again". */
async function writeEnabled(
  origin: FlowRunning["origin"],
  io: FlowIo,
  enabled: boolean,
  then: string | null,
  retryOf?: FlowResult,
): Promise<{ end: FlowEnd; result: FlowResult | null; notNow?: boolean }> {
  const saved = await editBlock(
    (block) => withEnabled(block, enabled),
    { readConfig: io.readConfig, saveBlock: storeSaveBlock(io.saveBlock, retryOf) },
    describeFailure,
  );
  await readStatusThroughStore(io.status);
  if (!saved.ok) {
    return { end: "failed", result: { origin, line: saved.message, answered: false, drawn: false, pendingWrite: { enabled, then } } };
  }
  if (then === null) return { end: "notNow", result: null, notNow: true };
  return { end: enabled ? "on" : "off", result: { origin, line: then, answered: true, drawn: false, pendingWrite: null } };
}

/** Whether the config lists a `macos` source, from up to two status reads (a second only when the first failed or was
 *  dropped); `null` when neither answered. */
async function macListed(io: FlowIo): Promise<boolean | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await readStatusThroughStore(io.status);
    if (r.verdict === "applied" && state.status !== null) return state.status.sources.some((s) => s.kind === "macos");
  }
  return null;
}

/**
 * "Show my calendar", by the stored status's starting state (spec §4):
 * - a `link` source (D3): turn the calendar on with it — one `withEnabled(true)`;
 * - Mac (`macSupported`): phase `access` runs `calendar connect mac` (a write when it `connectWrote`); then phase
 *   `saving`: a grant re-reads (twice if needed) for the `macos` source and turns the calendar on, else writes it off
 *   with the line saying why; a refusal or failure writes it off with `connectMacMessage`'s line; a thrown `busy` is no
 *   answer (nothing written, no result); any other throw writes it off with its line;
 * - the Link path: no flow (`link`) — the card opens a link session and later calls `closeLinkSession`.
 */
export async function startShow(origin: FlowRunning["origin"], io: FlowIo): Promise<FlowEnd> {
  if (!canStart() || state.status === null) return "blocked";
  switch (startingState(state.status)) {
    case "linkPath":
      return "link";
    case "link":
      return runFlow(origin, "saving", () => writeEnabled(origin, io, true, ON_LINE));
    case "mac":
      return runFlow(origin, "access", async () => {
        let outcome: EngineOutcome;
        try {
          outcome = await storeWrite(io.connectMac, connectWrote);
        } catch (e) {
          if (typeof e === "object" && e !== null && (e as { kind?: unknown }).kind === "busy") return { end: "busy" };
          setPhase(origin, "saving");
          return writeEnabled(origin, io, false, accessThrewLine(e));
        }
        setPhase(origin, "saving");
        const refused = accessRefusedLine(outcome);
        if (refused !== null) return writeEnabled(origin, io, false, refused);
        const listed = await macListed(io);
        if (listed === true) return writeEnabled(origin, io, true, ON_LINE);
        return writeEnabled(origin, io, false, listed === false ? MAC_NOT_ADDED_LINE : MAC_NOT_CHECKED_LINE);
      });
  }
}

/** "Not now": `enabled: false`, with no result line; a settled one is counted (`notNowSettled`, `notNowOrigin`). */
export async function notNow(origin: FlowRunning["origin"], io: FlowIo): Promise<FlowEnd> {
  if (!canStart()) return "blocked";
  return runFlow(origin, "saving", () => writeEnabled(origin, io, false, null));
}

/** "Try again": the held result's one write, as its own retry (the settle hook never drops the result it retries). */
export async function tryAgain(io: FlowIo): Promise<FlowEnd> {
  const held = state.flow.result;
  if (!canStart() || held === null || held.pendingWrite === null) return "blocked";
  const { enabled, then } = held.pendingWrite;
  return runFlow(held.origin, "saving", () => writeEnabled(held.origin, io, enabled, then, held));
}

/** The Link session closed with no link left over: phase `saving`, one re-read, no write. The calendar on (the stored
 *  status, patched by the panel's own save, says `enabledSet`) answers "Your calendar is on."; else unanswered.
 *  Blocked only by a running flow — a write in flight does not block it (it checks `running`, not `canStart()`). That
 *  is harmless: it writes nothing, and its re-read, overlapped by the write, is dropped by the ordering rule, so it
 *  decides from the stored status, whose `enabled`/`enabledSet` an accepted block save patches (`storeSaveBlock`). */
export async function closeLinkSession(origin: FlowRunning["origin"], io: FlowIo): Promise<FlowEnd> {
  if (state.flow.running !== null) return "blocked";
  return runFlow(origin, "saving", async () => {
    await readStatusThroughStore(io.status);
    if (state.status?.enabledSet !== true) return { end: "unanswered" };
    return { end: "on", result: { origin, line: ON_LINE, answered: true, drawn: false, pendingWrite: null } };
  });
}

/** A Today page drew the held Today result for the first time: mark it drawn and answer its line (for Today's live
 *  region) — once. `null` otherwise. */
export function markDrawn(): string | null {
  const r = state.flow.result;
  if (r === null || r.origin !== "today" || r.drawn) return null;
  publish({ ...state, flow: { ...state.flow, result: { ...r, drawn: true } } });
  return r.line;
}

/** Close: the result goes (its pendingWrite too). Nothing on disk changes. */
export function close(): void {
  if (state.flow.result !== null) publish({ ...state, flow: { ...state.flow, result: null } });
}

/** Today unmounts: a Today result it drew, with no pendingWrite, goes. One with a pendingWrite survives (a remount
 *  shows "Try again" again); one not drawn yet waits for the next Today view with a page. */
export function leaveToday(): void {
  const r = state.flow.result;
  if (r !== null && r.origin === "today" && r.drawn && r.pendingWrite === null) close();
}

/** The wizard's step unmounts: its result and pendingWrite go; a wizard flow still running drops both when it
 *  settles. A Today result is never touched. */
export function leaveWizard(): void {
  if (state.flow.running?.origin === "wizard") dropWhenSettled = true;
  if (state.flow.result?.origin === "wizard") close();
}

/* ── tests only ───────────────────────────────────────────────────────────────────────────────── */

/** TEST-ONLY: set fields directly (e.g. a held flow result, without running a flow), with no notification. */
export function seedTodayStoreForTests(patch: Partial<TodayStoreState>): void {
  state = { ...state, ...patch };
}

/** TEST-ONLY: restore every section, counter and the listener set to the initial state (plan §0.6). */
export function resetTodayStoreForTests(): void {
  state = initialState();
  listeners.clear();
  inFlight = 0;
  gen = 0;
  seq = 0;
  lastApplied = 0;
  dropWhenSettled = false;
}
