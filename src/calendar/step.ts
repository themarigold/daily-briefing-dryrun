// The calendar step's seam (spec r4 §3): `RunDeps.calendar` in `src/core.ts` has this type. Types only.
// Fixed by the hub before chunk A (M4+M5: implements the step, render, CLI) and chunk B (M6a+M6b+M7:
// the audit and the calendar eval set consume it) start in parallel, so both build against one contract.

import type { CalendarPromptBlocks } from "./prompt";
import type { CalDate, CalendarStruct } from "./types";

export type CalendarStepContext = {
  /** The run's local date, captured once at run start. */
  runDate: CalDate;
  /** Epoch ms when the network gate resolved — every link deadline and the 30 s bound start here. */
  startedAt: number;
  /** The machine-level network probe failed (spec §3 offline rule). */
  offline: boolean;
  /** `--force`: render what is available even when offline. */
  force: boolean;
  /** A real run (`deps.provider === undefined`): only these write the health file. */
  owned: boolean;
  /** Scheduled or manual trigger, recorded in the health file. */
  trigger: "scheduled" | "manual";
};

export type CalendarStepResult = {
  /** The restricted struct (spec §7) — the only calendar data that is rendered or persisted. */
  struct: CalendarStruct;
  /** Both prompt variants, or `null` when no block is sent (no sources, or the budget omits it). */
  promptBlocks: CalendarPromptBlocks | null;
  /** The empty-day offline rule says this run must skip without stamping (spec §3). */
  skipOffline: boolean;
};

/** Never throws and always resolves (spec §3); `undefined` result = calendar off. */
export type CalendarStep = (ctx: CalendarStepContext) => Promise<CalendarStepResult | undefined>;
