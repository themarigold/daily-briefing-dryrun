// src/schedule/units.ts — Slice 4 T1: the PURE per-OS unit-file generators.
//
// No I/O, no `process.*` reads, no clock. Everything comes in through `ScheduleOpts` so the whole
// per-OS surface is golden-string testable off the platform it targets — the same posture
// `test/plist.test.ts` already had against the checked-in template, now pointed at the one remaining
// source (T2).
//
// ⚠ WHY A GENERATOR AND NOT A TEMPLATE. A downloaded artifact is a single binary: no checkout, no
// `install/` directory, no `sed`. `scripts/install.sh:83` substituted three placeholders into a
// checked-in plist, which is unreachable from a binary and — the sharper problem — a SECOND spelling
// of the unit that could drift from whatever the binary itself would write. Folding the template in
// here leaves exactly one.
//
// ⚠ ONE RULE HOLDS ON EVERY OS: the unit points at a STABLE MANAGED COPY under the app's own data
// dir, never at the artifact the user downloaded. On Linux that is load-bearing rather than tidy —
// an AppImage's interior path is an ephemeral `/tmp/.mount_XXXX/…` that changes every launch, so a
// unit pointing inside the mount is broken on the second boot. `install.ts` enforces it; these
// generators simply never invent a path of their own (`binPath` is supplied, and
// `assertNoMountPath` below is the belt to that braces).

/** Everything a unit file needs. Supplied by the caller; nothing is read from the environment here. */
export type ScheduleOpts = {
  /** ABSOLUTE path to the managed copy of the engine binary. Never `process.argv[0]` (which is the
   *  literal string "bun" inside a bun-compiled binary) and never a path inside an AppImage mount. */
  binPath: string;
  /** The agent/unit/task label. EXACTLY `local.daily-briefing` in production — see install.ts's
   *  exact-match rule and `test/schedule.units.test.ts`'s sibling-safety cases. */
  label: string;
  /** StandardOut/StandardErrorPath. Both point at the SAME file today, which audit.lastBriefing
   *  depends on; see src/json.ts's RunOutput docstring. */
  logPath: string;
  /** Minutes-since-midnight of the morning floor, from `parseFloor(cfg.morningTime)` — NEVER a
   *  literal 7/20. A user who moves their floor moves the calendar trigger with it. */
  floorMinutes: number;
  /** The polling interval. 600 in production (`StartInterval`, `OnUnitActiveSec`, `PT10M`). */
  intervalSec: number;
  /** PATH for the agent's environment: launchd/systemd give a minimal one. */
  pathEnv: string;
};

/** The one label this project installs. Exported so install.ts, the status surface and the tests all
 *  compare against ONE string — an exact match against a sibling agent (`local.daily_briefing`,
 *  `local.daily_briefing_timer`, the author's unrelated personal pipeline) must never succeed. */
export const SCHEDULE_LABEL = "local.daily-briefing";

/** The production polling interval, in seconds. */
export const DEFAULT_INTERVAL_SEC = 600;

/** The systemd unit basenames, derived from nothing so they cannot drift across install/uninstall/status. */
export const SYSTEMD_SERVICE_NAME = "daily-briefing.service";
export const SYSTEMD_TIMER_NAME = "daily-briefing.timer";

/** The Windows task name. */
export const WINDOWS_TASK_NAME = "DailyBriefing";

/** ⚠ BUN'S OWN CRASH REPORTER, turned off for every scheduled run whose environment this file writes.
 *  The engine is a `bun build --compile` binary, and Bun (v1.3.14, `src/crash_handler/crash_handler.zig`
 *  `isReportingEnabled`) uploads a crash trace to `bun.report` when the RUNTIME itself panics or
 *  segfaults — by default on macOS and Windows, not on Linux. It reads `BUN_ENABLE_CRASH_REPORTING`
 *  through libc `getenv` when it decides, and `"0"` turns the upload off. launchd and systemd give the
 *  agent the environment written below rather than the user's shell's, so this is where it has to be.
 *  The desktop app sets the same variable on its own spawns (`gui/src-tauri/src/engine.rs`,
 *  `BUN_CRASH_REPORTING_OFF`). NOT in the Windows task: a Task Scheduler `<Exec>` action has no
 *  environment element, and the README's Privacy section says so.
 *
 *  ⚠ AND `BUN_CRASH_REPORT_URL` IS SET, TO THE EMPTY STRING, beside it. Bun checks that variable FIRST:
 *  a non-empty value turns reporting ON (to that URL) whatever `BUN_ENABLE_CRASH_REPORTING` says, and an
 *  empty one turns it off. "Nothing here sets one" was not enough: a LaunchAgent also inherits the
 *  user-domain environment (`launchctl setenv`) and a systemd user unit the manager's
 *  (`environment.d`, `systemctl --user set-environment`), so an inherited URL would have re-enabled
 *  uploads — to an arbitrary host. An explicit empty value in the unit itself wins over both. */
export const BUN_CRASH_REPORTING_OFF = { name: "BUN_ENABLE_CRASH_REPORTING", value: "0" } as const;
export const BUN_CRASH_REPORT_URL_EMPTY = { name: "BUN_CRASH_REPORT_URL", value: "" } as const;

/** ⚠ THE WINDOWS ENCODING CONTRACT, pinned as a constant so a test can assert it without a Windows
 *  runtime. `schtasks /Create /XML` REJECTS a UTF-8 file — this is the classic trap — so the writer
 *  emits UTF-16LE **with a BOM**. Asserted in `test/schedule.units.test.ts` against
 *  `windowsTaskXmlBytes`'s first two bytes, which is the only half of the Windows leg this repo can
 *  produce evidence for. */
export const WINDOWS_XML_ENCODING = "utf-16le" as const;
export const WINDOWS_XML_BOM = Uint8Array.from([0xff, 0xfe]);

/** Minutes-since-midnight → {hour, minute}. Total over any finite input: a floor outside 0..1439 is
 *  clamped rather than throwing, because the ONLY producer is `parseFloor`, which already degrades a
 *  bad `morningTime` to the default — and a generator that threw here would turn a config typo into a
 *  failed `schedule install` instead of a warned-about one. */
export function floorClock(floorMinutes: number): { hour: number; minute: number } {
  const m = Number.isFinite(floorMinutes) ? Math.trunc(floorMinutes) : 0;
  const clamped = Math.min(Math.max(m, 0), 24 * 60 - 1);
  return { hour: Math.floor(clamped / 60), minute: clamped % 60 };
}

/** XML text escaping for the three interpolated paths. The `sed` this replaces did NOT escape, so a
 *  home directory containing `&` produced a malformed plist that `launchctl load` silently refused.
 *  No production path on this machine contains one, which is why it never bit — and is exactly why it
 *  belongs in the generator rather than in a reviewer's memory. Escaping is byte-invisible for every
 *  path that does not need it, so it does not disturb the T2 byte-diff. */
function xmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // `'` is inert in every context these generators emit today (element text and double-quoted
    // attributes), and escaped anyway: the one thing that turns it load-bearing is a future
    // single-quoted attribute, and an escaper that covers four of the five predefined entities is a
    // trap for whoever adds one. Byte-invisible for every path that contains no apostrophe.
    .replace(/'/g, "&apos;");
}

/**
 * ⚠ SYSTEMD VALUE QUOTING. A path with a SPACE — `/home/john smith/…`, ordinary on a Mac-style
 * account name and legal everywhere — is WORD-SPLIT by systemd: `ExecStart=/home/john smith/bin/db run`
 * becomes the binary `/home/john` with the arguments `smith/bin/db run`, and the unit fails at every
 * fire. systemd parses `ExecStart=` and `Environment=` with shell-like quoting rules, so the fix is
 * the same one a shell needs: wrap the value in double quotes and escape what the quotes cannot hold.
 * Applied unconditionally rather than only-when-needed — a conditional quoter is a second code path
 * that only the rare input exercises.
 */
function systemdQuote(s: string): string {
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** The AppImage rule, as an assertion rather than a convention. `install.ts` calls this on the
 *  GENERATED TEXT (not merely on `binPath`), so any future field that could smuggle a mount path into
 *  a unit is covered by construction. */
export const MOUNT_PATH_RE = /\/(?:tmp\/)?\.mount_|\/tmp\/\.mount/;

export function assertNoMountPath(unitText: string, what: string): void {
  if (MOUNT_PATH_RE.test(unitText)) {
    throw new Error(
      `${what} references an AppImage mount path (/tmp/.mount_…). That path is recreated on every launch, so the unit would work exactly once. Install the managed copy instead — this is the managed-copy rule (src/schedule/units.ts).`,
    );
  }
}

// ── launchd (macOS) ─────────────────────────────────────────────────────────────────────────────

/**
 * The macOS LaunchAgent.
 *
 * ⚠ BYTE-COMPATIBLE WITH THE TEMPLATE IT REPLACES, and deliberately so: T2's verification seam is a
 * byte-diff of this output against a read-only capture of the author's LIVE
 * `~/Library/LaunchAgents/local.daily-briefing.plist`, whose only permitted delta is the
 * StartCalendarInterval block added by T5. That includes the first-line comment, which the old `sed`
 * mangled (`__BIN__` was substituted inside it too, so the installed file reads "<binpath> is
 * replaced by install.sh"). Reproducing the mangle verbatim keeps the diff a ONE-LINE addition and
 * therefore keeps the receipt unambiguous.
 *   ⚠ FOLLOW-UP, stated rather than silently carried: that sentence now names a file this slice
 *   DELETES and a mechanism it replaces. Refreshing it is a one-line change, but it re-baselines the
 *   byte-diff, so it belongs with the next deliberate re-baseline (Phase E's docs pass) rather than
 *   inside the change whose whole evidence is that diff.
 *
 * ⚠ THE ARGV ORDER IS THE CONTRACT: `/usr/bin/caffeinate -i <bin> run`. `caffeinate -i` holds idle
 * sleep off for the length of the run; putting it after the binary would make it an argument TO the
 * briefing rather than a wrapper around it. `test/plist.test.ts` asserts the full ordered array for
 * exactly this reason.
 *
 * ⚠ TWO TRIGGERS, NOT ONE (T5 — the 110-minute mitigation). `StartInterval` + `RunAtLoad` are kept
 * unchanged and `StartCalendarInterval` is ADDED at the morning floor, so a withheld or coalesced
 * interval tick is no longer a single point of failure. The once-per-day marker dedupes the extra
 * fire, so the cost is one no-op run per day. The mechanism behind day 34 stays recorded as
 * unexplained — this is defence in depth, not a diagnosis.
 */
export function launchdPlist(opts: ScheduleOpts): string {
  const bin = xmlEscape(opts.binPath);
  const log = xmlEscape(opts.logPath);
  const { hour, minute } = floorClock(opts.floorMinutes);
  return `<!-- install/local.daily-briefing.plist ; ${bin} is replaced by install.sh -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${xmlEscape(opts.label)}</string>
  <key>ProgramArguments</key><array><string>/usr/bin/caffeinate</string><string>-i</string><string>${bin}</string><string>run</string></array>
  <key>StartInterval</key><integer>${Math.trunc(opts.intervalSec)}</integer>
  <key>RunAtLoad</key><true/>
  <key>StartCalendarInterval</key><dict><key>Hour</key><integer>${hour}</integer><key>Minute</key><integer>${minute}</integer></dict>
  <key>StandardOutPath</key><string>${log}</string>
  <key>StandardErrorPath</key><string>${log}</string>
  <key>EnvironmentVariables</key><dict><key>PATH</key><string>${xmlEscape(opts.pathEnv)}</string><key>${BUN_CRASH_REPORTING_OFF.name}</key><string>${BUN_CRASH_REPORTING_OFF.value}</string><key>${BUN_CRASH_REPORT_URL_EMPTY.name}</key><string>${BUN_CRASH_REPORT_URL_EMPTY.value}</string></dict>
</dict></plist>
`;
}

// ── systemd (Linux) ─────────────────────────────────────────────────────────────────────────────

/**
 * The Linux user service + timer.
 *
 * ⚠ `ExecStart` IS ABSOLUTE — systemd rejects a relative one outright, and the managed-copy rule makes
 * the absolute path a stable one rather than whatever the user's shell would have resolved.
 *
 * ⚠ WHY THERE IS AN `OnCalendar=` AND NOT ONLY `OnUnitActiveSec=`, which is a CORRECTION to the task
 * text rather than an embellishment. The task specifies `OnBootSec`, `OnUnitActiveSec=10min` and
 * `Persistent=true`. But systemd's own documentation scopes `Persistent=` to calendar timers —
 * "only has an effect on timers configured with OnCalendar=" — so on a monotonic-only timer the flag
 * is inert and the catch-up behaviour it was specified FOR (the Linux analogue of launchd running a
 * missed calendar fire at wake) would not exist. Adding `OnCalendar=` at the morning floor makes
 * `Persistent=true` load-bearing AND gives Linux the same two-trigger shape T5 gives macOS, from the
 * same floor value. The monotonic arm is unchanged.
 *
 * ⚠ NO RUNTIME EVIDENCE. Nothing in this repo has ever executed a systemd unit; `systemd-analyze
 * verify` is run by the test when that binary exists and skipped otherwise. Treat the Linux leg as
 * "generates, lints where lintable, unexercised" until a real run says otherwise.
 */
export function systemdUnits(opts: ScheduleOpts): { service: string; timer: string } {
  const { hour, minute } = floorClock(opts.floorMinutes);
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const everyMin = Math.max(1, Math.round(opts.intervalSec / 60));
  const service = `[Unit]
Description=Daily Briefing — a resumption-focused briefing from your local git activity
Documentation=https://github.com/themarigold/daily-briefing
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
ExecStart=${systemdQuote(opts.binPath)} run
Environment=${systemdQuote(`PATH=${opts.pathEnv}`)}
Environment=${systemdQuote(`${BUN_CRASH_REPORTING_OFF.name}=${BUN_CRASH_REPORTING_OFF.value}`)}
Environment=${systemdQuote(`${BUN_CRASH_REPORT_URL_EMPTY.name}=${BUN_CRASH_REPORT_URL_EMPTY.value}`)}
`;
  const timer = `[Unit]
Description=Daily Briefing — poll for the first wake past your morning time

[Timer]
OnBootSec=2min
OnUnitActiveSec=${everyMin}min
OnCalendar=*-*-* ${hh}:${mm}:00
Persistent=true
Unit=${SYSTEMD_SERVICE_NAME}

[Install]
WantedBy=timers.target
`;
  return { service, timer };
}

// ── Task Scheduler (Windows) ────────────────────────────────────────────────────────────────────

/**
 * The Windows task definition. EXPERIMENTAL on every surface — see install.ts's gate.
 *
 * ⚠ `<CalendarTrigger>`, NOT `<TimeTrigger>`, and this is a NAMED DEVIATION from the task text
 * ("a daily TimeTrigger"). Task Scheduler's `TimeTrigger` is a ONE-SHOT trigger: with a
 * `<Repetition><Duration>P1D</Duration>` it repeats for one day and then never fires again, which is
 * a definitively broken daily schedule. The "daily trigger" of the Task Scheduler UI is
 * `CalendarTrigger` + `ScheduleByDay`, which is what is emitted here; the PT10M repetition the task
 * actually pins lives inside it unchanged. Since there is zero runtime evidence either way, the
 * schema-correct shape is the only defensible choice — an unrunnable one buys nothing.
 *
 * ⚠ `SessionStateChangeTrigger`/`SessionUnlock` is the first-wake analogue and `StartWhenAvailable`
 * is the catch-up analogue of systemd's `Persistent=true`; `IgnoreNew` is what keeps the two triggers
 * from producing overlapping runs, the same job the day marker does on the other two platforms.
 *
 * ⚠ The `<StartBoundary>` date is a FIXED past date, never "today": the boundary only anchors the
 * time-of-day for a daily schedule, and deriving it from a clock would make this function impure and
 * its golden test time-dependent.
 *
 * ⚠ THE CHILD ORDER OF `<CalendarTrigger>` IS THE XSD'S `xs:sequence`, NOT A STYLE CHOICE, and it is
 * asserted as an ORDER (not as presence) in `test/schedule.units.test.ts`. `triggerBaseType` sequences
 * Enabled → StartBoundary → EndBoundary → Repetition → ExecutionTimeLimit, and `calendarTriggerType`
 * extends it with RandomDelay → the ScheduleByX choice — so a schema-valid calendar trigger emits
 * Enabled, StartBoundary, Repetition, ScheduleByDay in that order. This generator used to emit
 * StartBoundary, Enabled, ScheduleByDay, Repetition. Real-world Task Scheduler is lenient about it and
 * there is (as everywhere on this leg) ZERO runtime evidence either way, so the schema-correct order
 * is the only defensible one — the same argument that chose CalendarTrigger over TimeTrigger above.
 * Checked against the published schema: learn.microsoft.com/en-us/windows/win32/taskschd/
 * taskschedulerschema-triggerbasetype-complextype and …-calendartriggertype-complextype.
 */
export function windowsTaskXml(opts: ScheduleOpts): string {
  const { hour, minute } = floorClock(opts.floorMinutes);
  const hh = String(hour).padStart(2, "0");
  const mm = String(minute).padStart(2, "0");
  const everyMin = Math.max(1, Math.round(opts.intervalSec / 60));
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>Daily Briefing (EXPERIMENTAL — no Windows runtime evidence exists for this task)</Description>
    <URI>\\${xmlEscape(WINDOWS_TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <CalendarTrigger>
      <Enabled>true</Enabled>
      <StartBoundary>2026-01-01T${hh}:${mm}:00</StartBoundary>
      <Repetition>
        <Interval>PT${everyMin}M</Interval>
        <Duration>P1D</Duration>
        <StopAtDurationEnd>false</StopAtDurationEnd>
      </Repetition>
      <ScheduleByDay>
        <DaysInterval>1</DaysInterval>
      </ScheduleByDay>
    </CalendarTrigger>
    <SessionStateChangeTrigger>
      <Enabled>true</Enabled>
      <StateChange>SessionUnlock</StateChange>
    </SessionStateChangeTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <Enabled>true</Enabled>
    <ExecutionTimeLimit>PT1H</ExecutionTimeLimit>
    <Priority>7</Priority>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xmlEscape(opts.binPath)}</Command>
      <Arguments>run</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/** The XML as BYTES, in the one encoding `schtasks /XML` accepts. Separate from the string form so a
 *  test can assert the BOM and the encoding without a Windows runtime — and so no caller can
 *  accidentally `Bun.write` the string (which would emit UTF-8 and be rejected). */
export function windowsTaskXmlBytes(xml: string): Uint8Array {
  const body = new Uint8Array(xml.length * 2);
  for (let i = 0; i < xml.length; i++) {
    const code = xml.charCodeAt(i);
    body[i * 2] = code & 0xff;
    body[i * 2 + 1] = code >> 8;
  }
  const out = new Uint8Array(WINDOWS_XML_BOM.length + body.length);
  out.set(WINDOWS_XML_BOM, 0);
  out.set(body, WINDOWS_XML_BOM.length);
  return out;
}
