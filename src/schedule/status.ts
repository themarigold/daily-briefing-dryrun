// src/schedule/status.ts — Slice 4 T6: `schedule status` + THE GUI'S SCHEDULING CONTRACT.
//
// ⚠⚠ `ScheduleStatusReport` IS FROZEN ADDITIVE-ONLY. It is Slice 5's ENTIRE API for scheduling — the
// desktop app cannot import this engine (15 of 26 src modules use Bun.* APIs), so its whole view of
// "am I scheduled, did it tick, when did it last deliver" is this object. Only NEW, OPTIONAL fields
// may be appended. Renaming a field, retyping one, or narrowing a union is a BREAKING change and must
// bump `JSON_SCHEMA_VERSION` in src/json.ts — the same rule and the same version field the A1
// surfaces carry, deliberately, so a GUI has one number to check rather than two.
//
// ⚠ READ-ONLY, and it must stay safe to poll every few seconds. It reuses A1's `statusReport`
// internals (`parseTickLine`, `statePaths`, `readLastRunDate`, `readLastSkip`) rather than
// re-deriving them — a second implementation of the tick format or the state paths is exactly the
// drift `StatePaths`' own docstring exists to prevent. What it adds that touches the OS — the
// registration check (`probeRegistration`, the ONE check, shared with uninstall) and the Linux linger
// read — goes through the injected exec like everything else in this module, every exec capped at 5 s
// so status always answers well inside the app's 30 s read timeout (Batch 2, spec 3.1.5).
import pkg from "../../package.json";
import { parseTickLine, statePaths, JSON_SCHEMA_VERSION } from "../json";
import { stripControl } from "../render";
import { readLastRunDate, readLastSkip, localDateStr, type LastSkip } from "../marker";
import { parseFloor, isPastFloor, DEFAULT_MORNING_TIME } from "../schedule";
import { loadConfig } from "../config";
import { DEFAULT_INTERVAL_SEC } from "./units";
import {
  readScheduleRecord, schedulePath, unitPaths, primaryUnitPath, kindFor, lingerState,
  probeRegistration, pathPresent, manualRemoveSteps,
  resolveScheduleDeps as resolveDeps,
  type ScheduleDeps, type ScheduleKind, type ScheduleOwner, type LingerState, type RegistrationReason,
} from "./install";

/** The cap on each exec status makes — the three (macOS) or two (Linux) probe commands and the Linux
 *  linger read — so the whole report stays well inside the app's 30 s engine read timeout (spec 3.1.5). */
const STATUS_EXEC_TIMEOUT_MS = 5_000;

/**
 * ⚠ THE LAST-TICK TRUST STATE, and why it is three values rather than a number-or-null.
 *
 * `stampTick` wrote `<iso> today=<n>` before the day-35 fix and `<iso> local=<date> today=<n>` after
 * it. A pre-fix line does not parse — and reporting an unparseable line as `ticksToday: 0` would be
 * the day-35 trap all over again, because 0 is precisely the value STATE.md's watch 1 reads as
 * "launchd never fired". A machine that has been ticking happily all morning would be reported as a
 * dead scheduler. So an unparseable line is UNTRUSTWORTHY, which is a different fact from both "no
 * ticks" and "no heartbeat file at all".
 *   "absent"      — no heartbeat file: nothing has ticked since the state dir was created.
 *   "legacy"      — a line exists and does not parse (pre-fix format, or corruption). Count unknown.
 *   "ok"          — parsed.
 */
export type LastTickState = "absent" | "legacy" | "ok";

export type ScheduleStatusReport = {
  schemaVersion: typeof JSON_SCHEMA_VERSION;
  engineVersion: string;
  platform: NodeJS.Platform;

  /** Is the trigger registered with the OS right now? `probeRegistration` mapped: present → true,
   *  gone → false, and `null` whenever the check could not say — a manager out of reach, no desktop
   *  session, a timeout, a command that could not run, an unsupported platform. `registeredReason` says
   *  which. NOT the same as `recordPresent` — a record without a registration is the "somebody deleted
   *  my plist" case a Schedule panel must be able to show. */
  registered: boolean | null;
  /** Is `<state>/schedule.json` a READABLE record — a regular file of at most 64 KiB that parses (the
   *  bounded read, spec 3.1.2)? A symlinked, oversized or malformed record reads false here and true in
   *  `recordFilePresent`. */
  recordPresent: boolean;
  /** Does a unit file exist on disk, by `lstat` (a dangling symlink counts)? The third leg of the same
   *  triangle. */
  unitPresent: boolean;

  owner: ScheduleOwner | null;
  invoker: ScheduleOwner | null;
  kind: ScheduleKind | null;
  unitPath: string | null;
  binPath: string | null;
  installedAt: string | null;
  /** The engine version recorded AT INSTALL TIME. Compared against `engineVersion` above, this is the
   *  engine/app skew the Schedule panel shows and the "update background engine" prompt keys on. */
  installedEngineVersion: string | null;

  /** Linux only; "not-applicable" elsewhere. Without lingering, systemd user timers do not run while
   *  logged out — the difference between working and silently never firing on a headless box. */
  lingerState: LingerState;

  lastTickState: LastTickState;
  lastTick: { iso: string; localDate: string; count: number } | null;
  /** Ticks recorded for TODAY, or `null` when `lastTickState` is not "ok" — see LastTickState. */
  ticksToday: number | null;
  /** How many ticks SHOULD have fired between the floor and now at the configured interval. The
   *  ticks-today-vs-expected pair is the day-34 diagnostic: a briefing at 09:10 alongside a healthy
   *  count proves ticks were firing and the GATE is the defect; a count near 1 proves they were not. */
  ticksExpectedSinceFloor: number | null;

  lastDelivery: string | null;
  lastSkip: LastSkip | null;

  morningTime: { value: string; minutes: number; warning: string | null };
  isPastFloor: boolean;
  intervalSec: number;

  /** True on any platform whose scheduling leg carries no runtime evidence. Windows today. A GUI must
   *  label such a schedule experimental rather than presenting it as working. */
  experimental: boolean;

  paths: { schedulePath: string; unitPaths: string[] };

  // ── Batch 2 (spec 3.1.5), appended. Always present; no existing key changed name or type, so
  // JSON_SCHEMA_VERSION stands. A consumer built against an older engine must treat them as absent.
  /** Why `registered` is `null` — the check's reason — and `null` whenever `registered` is not. */
  registeredReason: RegistrationReason | null;
  /** Is ANYTHING at `<state>/schedule.json`, by `lstat`, readable or not (spec 3, "three record facts")? */
  recordFilePresent: boolean;
  /** The manual removal steps for this machine's paths (spec 3.1.8), framing line first and NO closing
   *  line — each surface adds its own. `null` where launchd and systemd do not apply (Windows and
   *  unsupported platforms). */
  removeSteps: string | null;
};

export type ScheduleStatusDeps = ScheduleDeps & { now?: () => Date };

/** Ticks expected between the floor and now, inclusive of the floor tick itself. `null` before the
 *  floor, where "expected" has no meaning — a scheduled tick below the floor no-ops by design. */
export function expectedTicks(now: Date, floorMinutes: number, intervalSec: number): number | null {
  const minutesNow = now.getHours() * 60 + now.getMinutes();
  if (minutesNow < floorMinutes) return null;
  const perTickMin = Math.max(1, intervalSec / 60);
  return Math.floor((minutesNow - floorMinutes) / perTickMin) + 1;
}

export async function scheduleStatusReport(deps: ScheduleStatusDeps = {}): Promise<ScheduleStatusReport> {
  const d = resolveDeps(deps);
  const now = d.now();
  const sp = statePaths();
  const kind = kindFor(d.platform);

  let cfg;
  try { cfg = await loadConfig(); } catch { cfg = undefined; }
  const floor = parseFloor(cfg?.morningTime);

  const record = await readScheduleRecord();
  const recordPath = schedulePath();
  const recordFilePresent = await pathPresent(recordPath);   // beside the read, so both facts are one moment's
  const units = unitPaths(d.platform, d.env, d.home);
  let unitPresent = false;
  for (const p of units) if (await pathPresent(p)) { unitPresent = true; break; }
  // The ONE registration check, shared with uninstall. It never throws: a thrown exec counts as -2.
  const check = await probeRegistration(d, { timeoutMs: STATUS_EXEC_TIMEOUT_MS });

  const tickText = await Bun.file(sp.tickPath).text().catch(() => null);
  const parsed = tickText === null ? null : parseTickLine(tickText);
  const lastTickState: LastTickState =
    tickText === null || tickText.trim() === "" ? "absent" : parsed ? "ok" : "legacy";
  // ⚠ Today's count only. A parsed line from YESTERDAY is not today's tick count, and reporting it as
  // one would overstate a scheduler that has not fired since.
  const ticksToday = parsed && parsed.localDate === localDateStr(now) ? parsed.count : parsed ? 0 : null;

  return {
    schemaVersion: JSON_SCHEMA_VERSION,
    engineVersion: pkg.version,
    platform: d.platform,

    registered: check.state === "present" ? true : check.state === "gone" ? false : null,
    recordPresent: record !== null,
    unitPresent,

    owner: record?.owner ?? null,
    invoker: record?.invoker ?? null,
    kind: record?.kind ?? kind,
    unitPath: record?.unitPath ?? primaryUnitPath(d.platform, d.env, d.home),
    binPath: record?.binPath || null,
    installedAt: record?.installedAt || null,
    installedEngineVersion: record?.engineVersion || null,

    lingerState: await lingerState(d, { timeoutMs: STATUS_EXEC_TIMEOUT_MS }),

    lastTickState,
    lastTick: parsed,
    ticksToday,
    ticksExpectedSinceFloor: expectedTicks(now, floor.minutes, DEFAULT_INTERVAL_SEC),

    lastDelivery: (await readLastRunDate()) ?? null,
    lastSkip: (await readLastSkip()) ?? null,

    morningTime: {
      value: cfg?.morningTime ?? DEFAULT_MORNING_TIME,
      minutes: floor.minutes,
      warning: floor.warning ?? null,
    },
    isPastFloor: isPastFloor(now, floor.minutes),
    // ⚠ HONEST BY CONSTRUCTION, not by coincidence: `installSchedule` generates the unit from this
    // same constant and carries no interval knob (see InstallOpts), so the number reported here is
    // the number installed. A future per-install interval must be persisted in `ScheduleRecord` and
    // read back HERE, or this line silently becomes a guess.
    intervalSec: DEFAULT_INTERVAL_SEC,

    experimental: d.platform === "win32",

    paths: { schedulePath: recordPath, unitPaths: units },

    registeredReason: check.state === "unknown" ? check.reason : null,
    recordFilePresent,
    removeSteps: kind === "launchd" || kind === "systemd"
      ? manualRemoveSteps(kind, { units, record: recordPath, home: d.home })
      : null,
  };
}

/** The human rendering. Deliberately a pure function of the report, so the text and the JSON cannot
 *  disagree about what the engine believes — the same relationship `envelopeFrom` has with stdout. */
export function renderScheduleStatus(r: ScheduleStatusReport): string {
  const lines: string[] = [];
  const yn = (b: boolean | null) => (b === null ? "unknown" : b ? "yes" : "no");
  // ⚠ EVERY INTERPOLATED VALUE IS SANITISED, because almost none of them are ours: `unitPath`,
  // `binPath`, `installedAt` and `installedEngineVersion` are read back out of `schedule.json`,
  // `morningTime.value` out of the config, and `lastSkip.detail` out of last-skip.json — all files a
  // human or another process can edit. An ESC sequence in any of them rewrites the terminal around
  // the report. Every neighbouring surface (`install.ts`'s warnings, `main.ts`'s error arms) already
  // does this; this one was the exception. `stripControl` is byte-invisible for ordinary values.
  const s = (v: unknown) => stripControl(String(v));
  if (r.experimental) lines.push("⚠ EXPERIMENTAL platform — this scheduling leg has no runtime evidence.");
  lines.push(`registered:      ${yn(r.registered)}${r.unitPresent ? "" : "  (no unit file on disk)"}`);
  lines.push(`owner:           ${r.owner ? s(r.owner) : "—"}${r.invoker && r.invoker !== r.owner ? ` (invoked as ${s(r.invoker)})` : ""}`);
  lines.push(`kind:            ${r.kind ? s(r.kind) : "—"}`);
  lines.push(`unit:            ${r.unitPath ? s(r.unitPath) : "—"}`);
  lines.push(`binary:          ${r.binPath ? s(r.binPath) : "—"}`);
  lines.push(`installed:       ${r.installedAt ? s(r.installedAt) : "—"}${r.installedEngineVersion ? ` (engine ${s(r.installedEngineVersion)})` : ""}`);
  if (r.installedEngineVersion && r.installedEngineVersion !== r.engineVersion) {
    const refresh = r.owner === "app"
      ? "click Update background engine on the app's Schedule screen to refresh it"
      : "re-run \`schedule install\` to refresh it";
    lines.push(`  ⚠ engine skew: the scheduled copy is ${s(r.installedEngineVersion)}, this binary is ${s(r.engineVersion)} — ${refresh}.`);
  }
  if (r.lingerState !== "not-applicable") lines.push(`linger:          ${s(r.lingerState)}`);
  // v0.2.1 §3.1: the setting is called "Morning time" everywhere a user reads it. The label is a lookup
  // key in docs/TROUBLESHOOTING.md's `schedule status` table — change the two together.
  lines.push(`morning time:    ${s(r.morningTime.value)} (${r.isPastFloor ? "past" : "not yet reached"})`);
  lines.push(
    r.lastTickState === "ok"
      ? `ticks today:     ${r.ticksToday} of ~${r.ticksExpectedSinceFloor ?? 0} expected since the morning time`
      : r.lastTickState === "legacy"
        // ⚠ NOT "0". See LastTickState — 0 is the value that reads as "launchd never fired".
        ? `ticks today:     UNKNOWN — the heartbeat file is in a pre-2026-08-20 format and cannot be counted (this is not the same as zero)`
        : `ticks today:     none recorded — no heartbeat file yet`,
  );
  lines.push(`last delivery:   ${r.lastDelivery ? s(r.lastDelivery) : "never"}`);
  if (r.lastSkip) lines.push(`last skip:       ${s(r.lastSkip.reason)} (${s(r.lastSkip.localDate)})${r.lastSkip.detail ? ` — ${s(r.lastSkip.detail)}` : ""}`);
  return lines.join("\n");
}
