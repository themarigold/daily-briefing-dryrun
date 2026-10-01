/**
 * T20's post-install verification loop, as pure rules (tested in `gui/tests-web/access.check.ts`).
 *
 * ⚠ THE EXIT CODE IS NOT THE VERDICT, AND THAT IS THE WHOLE REASON THIS MODULE EXISTS.
 * `schedule verify` exits `0` when evidence appeared, `1` when the kick was accepted and produced
 * NO NEW evidence, and `3` when the scheduler refused it (`src/main.ts`, `verifyExitCode`). B3's
 * classifier maps `1` to `{ kind: "failed" }` and `3` to `{ kind: "failed", reason: "exit-3" }` —
 * so a panel switching on the OUTCOME KIND would report an ordinary inconclusive result as a
 * failure, and would have no way at all to see the one answer that must never read as success.
 *
 * ⚠ `already-delivered-before-kick` IS NOT A PASS. `docs/gui-seam.md` §3: today's delivery was
 * recorded BEFORE the kick, so the result proves nothing about the trigger — *"never render it as a
 * successful verification"*. It also cannot be retried today: the day marker makes the engine
 * decline, so the honest answer is to say what is and is not known and fall through to the
 * next-tick watch.
 *
 * ⚠ AND A DELIVERY DOES NOT LOOP. Plan R1 (final-check M3): on a fresh install the kickstarted run
 * exercises the repo reads and may deliver a THIN briefing; *"if the first iteration DELIVERS, do
 * not loop — fall through to the steady-state next-tick WATCH and let `doctor`'s 'repos need
 * access' carry the thin-ness"*. Retrying would generate a second briefing for no new fact.
 */
import type { EngineOutcome } from "./engine";

/** The engine's own `VerifyResult` (`src/schedule/install.ts`), as it arrives on `payload`. */
export interface VerifyEnvelope {
  kickstarted: boolean;
  /** ⚠ ADDITIVE. A value this app does not know must be treated as "not verified", never as a pass. */
  outcome: "delivered" | "skipped" | "no-evidence" | "already-delivered-before-kick" | string;
  skipReason: string | null;
  detail: string | null;
  iterations: number;
}

export type VerifyStage =
  | { stage: "idle" }
  | { stage: "verifying"; attempt: number }
  /** Verified, or as verified as it can be today: stop kicking and watch the next tick. */
  | { stage: "watching"; message: string }
  /** The trigger reached the engine and the run declined; another kick may find the reason gone. */
  | { stage: "retrying"; attempt: number; message: string }
  /** The honest end of the loop: what is known, what is not, and what to do next. */
  | { stage: "stopped"; message: string }
  /** The scheduler refused the kick (exit 3), or the command never ran. */
  | { stage: "refused"; message: string };

/**
 * How many kicks the loop will issue in total.
 *
 * ⚠ BOUNDED, BECAUSE EACH ONE CAN GENERATE A BRIEFING. The engine's own `verifySchedule` already
 * polls twice internally (`maxIterations: 2`); this is the app's bound on how many times it asks
 * again after a skip whose reason a later tick might clear. Three is a judgement call, not a
 * measurement — widen it deliberately, with a test.
 */
export const MAX_VERIFY_ATTEMPTS = 3;

/** The envelope, when the payload is one. `null` for anything else — including a missing payload. */
export function verifyEnvelope(payload: unknown): VerifyEnvelope | null {
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.kickstarted !== "boolean" || typeof p.outcome !== "string") return null;
  return {
    kickstarted: p.kickstarted,
    outcome: p.outcome,
    skipReason: typeof p.skipReason === "string" ? p.skipReason : null,
    detail: typeof p.detail === "string" ? p.detail : null,
    iterations: typeof p.iterations === "number" ? p.iterations : 0,
  };
}

/**
 * What the panel shows after one `schedule verify`, and whether the loop continues.
 *
 * @param attempt which kick this was, 1-based
 */
export function afterVerify(outcome: EngineOutcome, attempt: number): VerifyStage {
  const stderr = outcome.stderr.trim();
  const envelope = verifyEnvelope(outcome.payload);
  if (envelope === null) {
    // No envelope at all: the engine did not run, or printed something this app cannot read. Say so
    // with its own words rather than inventing a verdict.
    return {
      stage: "refused",
      message:
        stderr !== ""
          ? stderr
          : "The background scheduler could not be asked to run a check, and the engine said nothing about why.",
    };
  }
  if (!envelope.kickstarted) {
    return {
      stage: "refused",
      message:
        "The scheduler refused to start a check run, so nothing could be confirmed. " +
        (stderr !== "" ? stderr : "Try repairing the background scheduler."),
    };
  }
  switch (envelope.outcome) {
    case "delivered":
      // The same stage a delivery PUSHED by the watcher produces (`deliveredWatch`): the two
      // routes to "confirmed by a delivery" must not drift apart in wording.
      return deliveredWatch();
    case "skipped": {
      const reason = envelope.skipReason ?? "no reason given";
      const detail = envelope.detail ?? "";
      // ⚠ SETTLED REASONS STOP THE LOOP, mirroring the ENGINE's own settled set
      // (`src/schedule/install.ts`: *"'already-ran' and 'below-floor' both PROVE the trigger
      // reached the engine … neither is improved by another iteration"*). Re-kicking them would run
      // a live scheduler to re-learn a fact the engine has declared final for today — and on a
      // fresh install `already-ran` is the INSTALL'S OWN first run, so warn-toned "declined N
      // checks" copy would read as trouble where there is none. Both land in `watching`: the
      // trigger is confirmed, and the next tick is the thing to watch. Reasons OUTSIDE this set —
      // including ones this version does not know — keep the bounded retry below (the additive
      // rule cuts the other way for retries: an unknown reason may clear, so it is worth asking
      // again, up to the bound).
      if (envelope.skipReason === "already-ran") {
        return {
          stage: "watching",
          message:
            "Confirmed: the background scheduler reached the engine. It declined to generate " +
            "again because today's briefing had already been generated — after an install, that " +
            "is the install's own first run. The next scheduled check runs as normal.",
        };
      }
      if (envelope.skipReason === "below-floor") {
        return {
          stage: "watching",
          message:
            "Confirmed: the background scheduler reached the engine. It declined because it is " +
            "before your morning time; the first check after it will generate the briefing.",
        };
      }
      const confirmed = `Confirmed: the background scheduler reached the engine, which declined this run (${reason}).`;
      if (attempt < MAX_VERIFY_ATTEMPTS) {
        return {
          stage: "retrying",
          attempt: attempt + 1,
          message: `${confirmed} Waiting for the next check to see whether that clears.${detail !== "" ? ` ${detail}` : ""}`,
        };
      }
      return {
        stage: "stopped",
        message:
          `${confirmed} It declined ${MAX_VERIFY_ATTEMPTS} checks in a row, so the trigger works and ` +
          `the engine's reason is what to look at.${detail !== "" ? ` ${detail}` : ""}`,
      };
    }
    case "already-delivered-before-kick":
      // ⚠ NEVER A SUCCESS, and never retried today: today's briefing was already on disk before the
      // kick, so nothing this kick did could be observed, and the day marker makes every further
      // kick decline the same way.
      return {
        stage: "stopped",
        message:
          "Not confirmed: today's briefing had already been generated before this check, so it " +
          "shows nothing about whether the background scheduler still reaches the engine. The next " +
          "scheduled check will, and the counts above say whether checks are firing.",
      };
    case "no-evidence":
      if (attempt < MAX_VERIFY_ATTEMPTS) {
        return {
          stage: "retrying",
          attempt: attempt + 1,
          message:
            "The check was accepted but nothing has come back yet. Waiting for the next sign of life.",
        };
      }
      return {
        stage: "stopped",
        message:
          "Not confirmed: the check was accepted and nothing came back. The background scheduler " +
          "may simply be slow — the check counts above are the thing to watch — or it may not be " +
          "reaching the engine.",
      };
    default:
      // An outcome this app does not know. gui-seam §3's additive rule: treat it as NOT verified.
      return {
        stage: "stopped",
        message: `Not confirmed: the engine reported an outcome this version does not recognise (${envelope.outcome}).`,
      };
  }
}

/** What the loop watches for between kicks — the B4 `state:changed` facts, nothing else. */
export interface VerifyEvidence {
  /** `Snapshot.lastSkip`'s `iso`, or `null` when there is no skip record. */
  skipIso: string | null;
  /** True when `ScheduleState.phase.phase === "delivered"`. */
  delivered: boolean;
}

/**
 * Whether a `state:changed` is the NEW evidence the loop was waiting for.
 *
 * ⚠ IT NEVER POLLS `launchctl`, AND IT NEVER POLLS AT ALL. The loop is driven by B4's watcher: a
 * new `last-skip.json` (a different `iso` — the engine writes a fresh timestamp on every decline,
 * `src/schedule/install.ts`'s `skipFingerprint`) or a delivery is what makes another kick worth
 * issuing. A tick that changed neither says nothing new.
 *
 * ⚠ A DELIVERY ENDS THE LOOP RATHER THAN CONTINUING IT. Round 1: this comment used to promise
 * that and no caller kept it — the loop now lives in [`onEvidence`], which REFINES this predicate
 * (own-kick absorption, the predates-the-kick delivery rule) rather than calling it. This
 * function remains the plain definition of "new evidence", kept with its test as the table the
 * refinement is judged against — and judged for real: `tests-web/access.check.ts` drives this
 * predicate and [`onEvidence`] over the same evidence/baseline table and requires agreement
 * wherever the refinement is inert (round 2, so the two cannot drift silently); the component no
 * longer wires it directly.
 */
export function isNewEvidence(evidence: VerifyEvidence, seenSkipIso: string | null): boolean {
  if (evidence.delivered) return true;
  return evidence.skipIso !== null && evidence.skipIso !== seenSkipIso;
}

/* ── the loop itself, as a pure state machine (round 1) ───────────────────────────────────────── */

/**
 * Everything the loop remembers between events. The component holds ONE of these and feeds it
 * three kinds of event: a kick being issued ([`beginKick`]), the kick's IPC completing
 * ([`afterKick`] / [`afterKickRefusal`]) and a watcher push arriving ([`onEvidence`]).
 *
 * ⚠ WHY THIS EXISTS AT ALL (round 1, HIGH): the shipped B6 loop captured its skip baseline BEFORE
 * the kick, so the skip record the kick ITSELF produced read as "new evidence" and immediately
 * re-armed the next kick — three back-to-back live kicks on the mainline fresh-install path,
 * ending amber. The loop's baseline was vacuous against its own output. Everything below is
 * KICK-RELATIVE (which record was on the books when this kick was issued), never clock-relative —
 * the same discipline the engine's own `verifySchedule` was built around.
 */
export interface LoopState {
  stage: VerifyStage;
  /** The last skip record the loop has ACCOUNTED FOR — new evidence is judged against it. */
  seenSkipIso: string | null;
  /** `evidence.skipIso` at the moment the in-flight kick was issued; `null` between kicks. */
  kickBaselineIso: string | null;
  /**
   * True when today's delivery predated the in-flight kick. A `delivered` push is then NOT the
   * loop's confirmation — §3: `already-delivered-before-kick` must never render as a success, and
   * the envelope is the honest answer for that case.
   */
  deliveredAtKick: boolean;
  /**
   * True while the loop is `retrying` and the skip record its own kick produced may not have been
   * PUSHED yet (the watcher's ~250 ms debounce usually beats the IPC return, but that ordering is
   * not guaranteed). The FIRST new iso is then absorbed as that record; only the one after it arms
   * the next kick.
   */
  ownSkipPending: boolean;
}

export function initialLoop(): LoopState {
  return {
    stage: { stage: "idle" },
    seenSkipIso: null,
    kickBaselineIso: null,
    deliveredAtKick: false,
    ownSkipPending: false,
  };
}

/** The confirmed-by-delivery watch stage — plan R1 (final-check M3): a delivery does not loop. */
export function deliveredWatch(): VerifyStage {
  return {
    stage: "watching",
    message:
      "Confirmed: the background scheduler reached the engine and it generated a briefing. " +
      "If any folders below still need access, that briefing may be thin — the checks above say which.",
  };
}

/**
 * What arming the loop (a COMPLETED install) does.
 *
 * ⚠ A DELIVERY ALREADY ON THE BOOKS IS R1 M3's ANSWER DIRECTLY: the install's own kickstart
 * delivered, so the panel confirms and watches — it does not issue a live kick whose only possible
 * answers (`already-ran`, `already-delivered-before-kick`) restate or weaken what is already
 * known. The MANUAL button is deliberately not routed through this: an explicit "check now" gets a
 * real kick, and §3's never-a-success rule covers the answer it gets back.
 */
export function armLoop(evidence: VerifyEvidence): { state: LoopState; kick: 1 | null } {
  if (evidence.delivered) {
    return { state: { ...initialLoop(), stage: deliveredWatch() }, kick: null };
  }
  return { state: beginKick(evidence, 1), kick: 1 };
}

/** The state the moment a kick's IPC is issued: the baseline is captured HERE, kick-relative. */
export function beginKick(evidence: VerifyEvidence, attempt: number): LoopState {
  return {
    stage: { stage: "verifying", attempt },
    seenSkipIso: evidence.skipIso,
    kickBaselineIso: evidence.skipIso,
    deliveredAtKick: evidence.delivered,
    ownSkipPending: false,
  };
}

/**
 * Fold the kick's IPC completion into the loop.
 *
 * ⚠ A LOOP THE EVIDENCE ALREADY SETTLED STAYS SETTLED: if a delivery moved the stage to `watching`
 * while the IPC was in flight, the late answer is dropped — it was a question about a state that
 * no longer needs asking, and overwriting the confirmation with it would un-confirm a delivery.
 *
 * On entering `retrying`, the baseline is RE-CAPTURED (post-kick, not pre-kick), and
 * `ownSkipPending` records whether the record the engine says it saw (`skipped`) — or a record a
 * slow kicked run may still write (`no-evidence`) — has been pushed yet: unchanged-since-kick
 * means it has not, so the first new iso to arrive is the kick's own output, not the next tick's.
 */
export function afterKick(
  state: LoopState,
  outcome: EngineOutcome,
  attempt: number,
  evidence: VerifyEvidence,
): LoopState {
  if (state.stage.stage !== "verifying") return state;
  const stage = afterVerify(outcome, attempt);
  return {
    stage,
    seenSkipIso: evidence.skipIso,
    kickBaselineIso: null,
    deliveredAtKick: state.deliveredAtKick,
    ownSkipPending:
      stage.stage === "retrying" && evidence.skipIso === state.kickBaselineIso,
  };
}

/** An IPC rejection (a `busy` refusal, typically) — nothing was started. Same settled-stays rule. */
export function afterKickRefusal(state: LoopState, message: string): LoopState {
  if (state.stage.stage !== "verifying") return state;
  return { ...state, stage: { stage: "refused", message }, kickBaselineIso: null };
}

/**
 * Fold a watcher push into the loop: the ONE place that decides whether evidence arms a kick.
 *
 * The rules, in order:
 *  1. A delivery that does NOT predate the kick ends the loop in `watching` — never a kick
 *     (plan R1 M3; round 1: the shipped loop kicked on it).
 *  2. A skip record produced by the loop's OWN kick never arms the next one, in BOTH windows:
 *     while `verifying` (absorbed into the baseline) and shortly after entering `retrying`
 *     (`ownSkipPending` absorbs the first new iso).
 *  3. Only a new iso beyond those, while `retrying`, arms the next kick.
 *
 * Returns the SAME state object when nothing changed, so a reactive caller can compare by
 * reference and reach a fixed point.
 */
export function onEvidence(
  state: LoopState,
  evidence: VerifyEvidence,
): { state: LoopState; kick: number | null } {
  const { stage } = state;
  if (stage.stage !== "verifying" && stage.stage !== "retrying") return { state, kick: null };
  if (evidence.delivered && !state.deliveredAtKick) {
    return {
      state: { ...state, stage: deliveredWatch(), kickBaselineIso: null, ownSkipPending: false },
      kick: null,
    };
  }
  if (evidence.skipIso === null || evidence.skipIso === state.seenSkipIso) {
    return { state, kick: null };
  }
  if (stage.stage === "verifying" || state.ownSkipPending) {
    return {
      state: { ...state, seenSkipIso: evidence.skipIso, ownSkipPending: false },
      kick: null,
    };
  }
  return { state, kick: stage.attempt };
}
