// src/keep-awake.ts — the scheduled run's idle-sleep guard on macOS.
//
// The LaunchAgent used to wrap the engine in it (`ProgramArguments = [/usr/bin/caffeinate, -i, <bin>,
// run]`), and macOS names a launchd job after the basename of ProgramArguments[0] — so System Settings'
// App Background Activity listed Daily Briefing as "caffeinate", an unidentified item a user could
// reasonably switch off. The plist now starts the engine directly and sets DAILY_BRIEFING_KEEP_AWAKE=1
// (`src/schedule/units.ts`, `KEEP_AWAKE_ENV`); `dispatch`'s `run` branch (src/main.ts) calls this on
// darwin when it sees that variable. Same scope as the old wrapper: scheduled runs only. A run the
// desktop app starts is wrapped by the app itself (`gui/src-tauri/src/engine.rs`, `CAFFEINATE`).
//
// ⚠ NOT UNDER src/schedule/, deliberately: test/isolation.meta.test.ts's R1 forbids any spawn there.
//
// ⚠ `-w <pid>`, NEVER AWAITED, NEVER KILLED. caffeinate holds the PreventUserIdleSystemSleep assertion
// until the named pid exits, so the engine's exit ends it — including a crash or a SIGKILL, where no
// cleanup of ours would run. The child is unref'd with stdio ignored, so it cannot hold the engine's
// event loop open or write into the launchd log.

import { existsSync } from "node:fs";

export const CAFFEINATE = "/usr/bin/caffeinate";

/** Injectable so a test asserts the argv without ever starting a real caffeinate. */
export type KeepAwakeDeps = {
  exists?: (path: string) => boolean;
  spawn?: (argv: string[]) => { unref(): void };
  warn?: (line: string) => void;
};

/** Hold idle sleep off until `pid` exits. FALL BACK, NEVER FAIL: a missing binary or a spawn that throws
 *  is one warning line on stderr (the log, under launchd) and the run goes on — the rule the app's own
 *  spawn wrapper follows. A briefing that may be interrupted by idle sleep beats no briefing. */
export function startKeepAwake(pid: number, deps: KeepAwakeDeps = {}): void {
  const warn = deps.warn ?? ((line: string) => console.error(line));
  try {
    if (!(deps.exists ?? existsSync)(CAFFEINATE)) {
      warn(`daily-briefing: ${CAFFEINATE} is missing — running without it. A long provider call may be interrupted by idle sleep.`);
      return;
    }
    const spawn = deps.spawn ?? ((argv: string[]) => Bun.spawn(argv, { stdio: ["ignore", "ignore", "ignore"] }));
    spawn([CAFFEINATE, "-i", "-w", String(pid)]).unref();
  } catch (e) {
    warn(`daily-briefing: could not start ${CAFFEINATE} (${e instanceof Error ? e.message : String(e)}) — running without it. A long provider call may be interrupted by idle sleep.`);
  }
}
