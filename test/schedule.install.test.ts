import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Slice 4 T3/T8/T9 — the effectful half, driven entirely through the INJECTED exec and
// DBA_TEST_UNIT_DIR.
//
// ⚠ NOT ONE REAL SCHEDULER COMMAND RUNS IN THIS FILE. Every invocation is recorded by `fakeExec` and
// asserted as ARGV; nothing is spawned. That is not politeness — the suite runs on the author's live
// machine, where a real `launchctl unload` takes down the LIVE briefing agent and costs a morning.
// `test/isolation.meta.test.ts` scanner 4 is what makes the property checkable rather than habitual.
import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync, chmodSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import {
  installSchedule, uninstallSchedule, verifySchedule, readScheduleRecord, writeScheduleRecord,
  schedulePath, managedBinPath, unitDir, unitPaths, primaryUnitPath, ownsLabel, kindFor,
  resolveIdentity, lingerCommand, isRegistered, verdictLine, verifyExitCode,
  EXIT_OK, EXIT_NONE, EXIT_FOREIGN, EXIT_ERROR, DEFAULT_SIGN_IDENTITY, SCHEDULE_EXEC_TIMEOUT_MS,
  type Exec, type ScheduleDeps,
} from "../src/schedule/install";
import { SCHEDULE_LABEL, SYSTEMD_SERVICE_NAME, SYSTEMD_TIMER_NAME, WINDOWS_TASK_NAME } from "../src/schedule/units";
import { markerPath, lastSkipPath, localDateStr } from "../src/marker";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

/** Records every command and answers each with a scripted result. The DEFAULT is success, because the
 *  interesting assertions are about WHAT was invoked; failures are scripted per-test. */
function fakeExec(script: Record<string, { code?: number; out?: string; err?: string }> = {}) {
  const calls: string[][] = [];
  /** ⚠ SIDE EFFECTS OF A KICK, keyed by command substring. This is what lets a verification test
   *  assert "the kick CAUSED the evidence" rather than "the evidence was already there": the fixture
   *  writes the marker or the last-skip file from INSIDE the fake `launchctl start`, exactly where the
   *  real scheduler would have reached the engine. Tests that seeded the evidence before the call
   *  passed against a kick that did nothing at all. */
  const effects: Array<{ match: string; fn: () => void }> = [];
  const exec: Exec = async (cmd) => {
    calls.push(cmd);
    const line = cmd.join(" ");
    for (const e of effects) if (line.includes(e.match)) e.fn();
    for (const [k, v] of Object.entries(script)) {
      if (line.includes(k)) return { code: v.code ?? 0, out: v.out ?? "", err: v.err ?? "" };
    }
    return { code: 0, out: "", err: "" };
  };
  return {
    exec, calls,
    ran: (bin: string) => calls.filter((c) => c[0] === bin || c[0]?.endsWith(`/${bin}`)),
    onCall: (match: string, fn: () => void) => { effects.push({ match, fn }); },
  };
}

let HOME = "", UNITS = "", STATE = "", SRC_BIN = "";
const said: string[] = [], warned: string[] = [];
let prevUnitDir: string | undefined, prevState: string | undefined;

/**
 * ⚠ A FRESH STATE DIR PER TEST, not just per FILE. `schedulePath()` resolves through `supportDir()`
 * like every other state helper (ambient, by design — `markerPath`, `tickPath` and the rest all do),
 * so the shared `isolate-state` scratch directory is one directory for the whole PROCESS. Written
 * that way, `schedule.json` from one test was still there for the next, and a `--take-over` case left
 * a foreign owner that made three later installs exit 2. Measured, then fixed here rather than worked
 * around with ordering.
 *
 * Save-and-restore rather than `delete`: `bun test` runs the whole suite in ONE process, so clearing
 * the variable would un-isolate every file scheduled after this one — the exact ordering leak
 * `isolation.meta.test.ts`'s disarm scanner exists to catch.
 */
beforeEach(() => {
  HOME = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-sched-home-")));
  UNITS = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-sched-units-")));
  STATE = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-sched-state-")));
  // A stand-in for the engine binary the user downloaded. Content is asserted after the copy.
  SRC_BIN = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-sched-src-"))), "daily-briefing");
  writeFileSync(SRC_BIN, "#!/bin/sh\nexit 0\n");
  chmodSync(SRC_BIN, 0o755);
  said.length = 0; warned.length = 0;
  prevUnitDir = process.env.DBA_TEST_UNIT_DIR;
  prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.DAILY_BRIEFING_STATE_DIR = STATE;
});

afterEach(() => {
  if (prevUnitDir === undefined) delete process.env.DBA_TEST_UNIT_DIR; else process.env.DBA_TEST_UNIT_DIR = prevUnitDir;
  if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
});

/** The env the installer sees. Identical to the ambient one for the two variables that matter, so
 *  `deps.env`-derived paths and `supportDir()`-derived paths cannot disagree — which they did, and
 *  the disagreement is what the per-test dirs above remove. */
function env(): NodeJS.ProcessEnv {
  return { ...process.env, DBA_TEST_UNIT_DIR: UNITS, DAILY_BRIEFING_STATE_DIR: STATE, USER: "tester" };
}

/** Where the managed copy lands for this test. Derived, never spelled out twice. */
function managed(platform: NodeJS.Platform = "darwin"): string {
  return managedBinPath(platform, env(), HOME);
}

function deps(platform: NodeJS.Platform, exec: Exec, extra: Partial<ScheduleDeps> = {}): ScheduleDeps {
  return {
    exec, platform, home: HOME, execPath: SRC_BIN,
    env: env(),
    now: () => new Date("2026-09-14T12:00:00.000Z"),
    say: (l) => said.push(l), warn: (l) => warned.push(l),
    ...extra,
  };
}

describe("paths and the managed-copy rule", () => {
  test("DBA_TEST_UNIT_DIR overrides the real unit directory on every platform", () => {
    const env = { DBA_TEST_UNIT_DIR: UNITS } as NodeJS.ProcessEnv;
    for (const p of ["darwin", "linux", "win32"] as NodeJS.Platform[]) {
      expect(unitDir(p, env, HOME)).toBe(UNITS);
    }
    // …and without it, the REAL locations — which is exactly why the override must exist.
    expect(unitDir("darwin", {} as NodeJS.ProcessEnv, HOME)).toBe(join(HOME, "Library", "LaunchAgents"));
    expect(unitDir("linux", {} as NodeJS.ProcessEnv, HOME)).toBe(join(HOME, ".config", "systemd", "user"));
  });

  test("the managed copy lives under the app's own data dir, per platform", () => {
    const env = {} as NodeJS.ProcessEnv;
    expect(managedBinPath("darwin", env, HOME)).toBe(join(HOME, "Library", "Application Support", "daily-briefing", "daily-briefing"));
    expect(managedBinPath("linux", env, HOME)).toBe(join(HOME, ".local", "share", "daily-briefing", "bin", "daily-briefing"));
    // …and DAILY_BRIEFING_STATE_DIR relocates the darwin copy, because that is where install.sh
    // already puts it — one rule, not two.
    expect(managedBinPath("darwin", { DAILY_BRIEFING_STATE_DIR: "/s" } as NodeJS.ProcessEnv, HOME)).toBe(join("/s", "daily-briefing"));
  });

  test("kindFor maps the three supported platforms and refuses the rest", () => {
    expect([kindFor("darwin"), kindFor("linux"), kindFor("win32"), kindFor("freebsd")])
      .toEqual(["launchd", "systemd", "schtasks", null]);
  });
});

// ── ⚠ SIBLING SAFETY. The author's machine runs UNRELATED personal-pipeline agents whose labels
// differ from ours by one character class. A prefix, substring or glob match would select them, and
// `uninstall` / `--take-over` would then unload somebody else's agent.
describe("sibling safety — the label match is EXACT", () => {
  test("ownsLabel accepts ONLY local.daily-briefing", () => {
    expect(ownsLabel(SCHEDULE_LABEL)).toBe(true);
    // The negatives, written out rather than described:
    for (const sibling of [
      "local.daily_briefing",            // the personal pipeline's wake agent — underscores
      "local.daily_briefing_timer",      // its 07:20/13:00 calendar agent
      "local.daily-briefing.timer",      // a plausible future sibling of OURS
      "local.daily-briefing2",
      "com.local.daily-briefing",        // a suffix match would take this
      "local.daily-briefing ",           // trailing space
      "LOCAL.DAILY-BRIEFING",            // case
      "",
    ]) {
      expect(`${sibling} → ${ownsLabel(sibling)}`).toBe(`${sibling} → false`);
    }
  });

  test("every path the installer touches is built from the exact label — no sibling is addressable", () => {
    const env = { DBA_TEST_UNIT_DIR: UNITS } as NodeJS.ProcessEnv;
    expect(unitPaths("darwin", env, HOME)).toEqual([join(UNITS, "local.daily-briefing.plist")]);
    expect(primaryUnitPath("linux", env, HOME)).toBe(join(UNITS, SYSTEMD_TIMER_NAME));
    expect(primaryUnitPath("win32", env, HOME)).toBe(join(UNITS, `${WINDOWS_TASK_NAME}.xml`));
  });

  test("uninstall unloads the OUR-LABEL plist path and nothing else, even with sibling files present", async () => {
    // Put the siblings in the very directory uninstall operates on. A glob would sweep them.
    writeFileSync(join(UNITS, "local.daily_briefing.plist"), "<plist/>");
    writeFileSync(join(UNITS, "local.daily_briefing_timer.plist"), "<plist/>");
    writeFileSync(join(UNITS, `${SCHEDULE_LABEL}.plist`), "<plist/>");
    const f = fakeExec();
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_OK);
    const unloaded = f.ran("launchctl").map((c) => c.join(" "));
    expect(unloaded).toEqual([`launchctl unload ${join(UNITS, `${SCHEDULE_LABEL}.plist`)}`]);
    expect(existsSync(join(UNITS, `${SCHEDULE_LABEL}.plist`))).toBe(false);
    // ⚠ THE POINT: both siblings survive untouched.
    expect(existsSync(join(UNITS, "local.daily_briefing.plist"))).toBe(true);
    expect(existsSync(join(UNITS, "local.daily_briefing_timer.plist"))).toBe(true);
  });
});

describe("install (darwin)", () => {
  test("copies from process.execPath — NOT argv[0], which is the literal string \"bun\"", async () => {
    // ⚠ MEASURED, not assumed: inside a bun-compiled binary `process.argv[0]` is "bun" and a unit
    // built from it points at nothing. `execPath` is the binary's own absolute path.
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
    const dest = managed();
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe(readFileSync(SRC_BIN, "utf8"));
    const plist = readFileSync(join(UNITS, `${SCHEDULE_LABEL}.plist`), "utf8");
    expect(plist).toContain(`<string>${dest}</string>`);
    expect(plist).not.toContain("<string>bun</string>");
  });

  test("strips quarantine and signs THE COPY with --identifier local.daily-briefing", async () => {
    const f = fakeExec({ "find-identity": { out: `1) ABC "${DEFAULT_SIGN_IDENTITY}"` } });
    await installSchedule({ noVerify: true }, deps("darwin", f.exec));
    const dest = managed();
    expect(f.calls.map((c) => c.join(" "))).toContain(`xattr -d com.apple.quarantine ${dest}`);
    expect(f.calls.map((c) => c.join(" ")))
      .toContain(`codesign --force --sign ${DEFAULT_SIGN_IDENTITY} --timestamp=none --identifier ${SCHEDULE_LABEL} ${dest}`);
    // ⚠ THE SOURCE is never signed — you cannot cleanly re-sign the binary that is executing.
    expect(f.calls.some((c) => c[0] === "codesign" && c.includes(SRC_BIN))).toBe(false);
  });

  test("⚠ WHEN THE SOURCE IS ALREADY THE MANAGED COPY, NOTHING SIGNS THE EXECUTING BINARY", async () => {
    // This is the REAL `scripts/install.sh` path, not a curiosity: the script builds straight to the
    // managed location and then runs `"$BIN" schedule install --invoker cli`, so `execPath ===
    // managedBinPath`. The code skipped the COPY for that case and then signed anyway — `codesign
    // --force` (or the `-s - -f` ad-hoc fallback) on the binary that is executing, which is exactly
    // what install.ts's own header forbids, and install.sh:66 had signed that same file moments
    // earlier. Asserted as "no codesign call NAMES this path", not as "codesign was not called with
    // --force": the ad-hoc fallback spells it `-f` and would have slipped through the narrower check.
    const dest = managed();
    writeFileSync(dest, "#!/bin/sh\nexit 0\n");
    const f = fakeExec({ "find-identity": { out: `1) ABC "${DEFAULT_SIGN_IDENTITY}"` } });
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec, { execPath: dest }))).toBe(EXIT_OK);
    expect(f.calls.filter((c) => c[0] === "codesign" && c.includes(dest)).map((c) => c.join(" "))).toEqual([]);
    expect(f.ran("codesign")).toEqual([]);
    expect(f.ran("xattr")).toEqual([]);          // …and no quarantine call on it either
    expect(said.join("\n")).toContain("re-signing a running image");
    // The install still completes: the unit is written and loaded.
    expect(f.ran("launchctl").map((c) => c.join(" ")))
      .toContain(`launchctl load ${join(UNITS, `${SCHEDULE_LABEL}.plist`)}`);
  });

  test("a signing failure DEGRADES to ad-hoc with a warning — it never aborts the install", async () => {
    // install.sh:69-77's behaviour exactly: an unloaded agent costs a morning, a missing grant costs a
    // re-prompt. The trade is not close.
    const f = fakeExec({ "find-identity": { code: 1 }, "openssl": { code: 1 }, "version": { code: 1 } });
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
    expect(warned.join("\n")).toContain("falling back to an ad-hoc signature");
    expect(f.calls.map((c) => c.join(" ")).some((c) => c.startsWith("codesign -s - -f"))).toBe(true);
    // Phase E M5b checkpoint: NEITHER signature may ask a timestamp server — codesign's default for
    // that is per-identity and unspecified, and the README promises nothing else is contacted. (The
    // source install's own codesign lines are pinned in test/isolation.meta.test.ts, the one test file
    // allowed to name that script.)
    const signs = f.ran("codesign").map((c) => c.join(" "));
    expect(signs.length).toBeGreaterThan(0);
    expect(signs.filter((c) => !c.split(" ").includes("--timestamp=none"))).toEqual([]);
    expect(f.ran("launchctl").map((c) => c.join(" "))).toContain(`launchctl load ${join(UNITS, `${SCHEDULE_LABEL}.plist`)}`);
  });

  test("the identity is parameterized — --identity beats DBA_SIGN_IDENTITY beats the default", () => {
    expect(resolveIdentity({ identity: "Developer ID Application: X" }, { DBA_SIGN_IDENTITY: "env" } as NodeJS.ProcessEnv))
      .toBe("Developer ID Application: X");
    expect(resolveIdentity({}, { DBA_SIGN_IDENTITY: "env" } as NodeJS.ProcessEnv)).toBe("env");
    expect(resolveIdentity({}, {} as NodeJS.ProcessEnv)).toBe(DEFAULT_SIGN_IDENTITY);
  });

  test("registers via launchctl unload-then-load, and records the owner in schedule.json", async () => {
    const f = fakeExec();
    expect(await installSchedule({ invoker: "app", noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
    const unit = join(UNITS, `${SCHEDULE_LABEL}.plist`);
    expect(f.ran("launchctl").map((c) => c.join(" "))).toEqual([`launchctl unload ${unit}`, `launchctl load ${unit}`]);
    const rec = await readScheduleRecord();
    expect(rec).toMatchObject({ owner: "app", invoker: "app", kind: "launchd", unitPath: unit });
    expect(rec!.installedAt).toBe("2026-09-14T12:00:00.000Z");
    expect(rec!.engineVersion).toBeTruthy();
  });

  test("a failing launchctl load is exit 3 — a unit nobody loaded is not an install", async () => {
    const f = fakeExec({ "launchctl load": { code: 1, err: "Load failed: 5: Input/output error" } });
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_ERROR);
    expect(warned.join("\n")).toContain("launchctl load failed");
    // ⚠ And NO record is written: schedule.json claiming ownership of a trigger that is not running
    // would make `status` lie and would make a later `uninstall` think it had something to remove.
    expect(await readScheduleRecord()).toBeNull();
  });
});

describe("single-owner coexistence", () => {
  test("a FOREIGN owner is refused with exit 2, and NOTHING is written", async () => {
    await writeScheduleRecord({
      owner: "app", invoker: "app", kind: "launchd", unitPath: "/somewhere/app.plist",
      binPath: "/somewhere/bin", installedAt: "2026-09-01T00:00:00.000Z", engineVersion: "0.1.9",
    });
    const f = fakeExec();
    expect(await installSchedule({ invoker: "cli", noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_FOREIGN);
    expect(f.calls).toEqual([]);                                   // no exec at all
    expect(existsSync(join(UNITS, `${SCHEDULE_LABEL}.plist`))).toBe(false);  // no unit
    expect((await readScheduleRecord())!.owner).toBe("app");       // record untouched
    expect(warned.join("\n")).toContain("--take-over");
  });

  test("--take-over claims it, and the record flips owner", async () => {
    await writeScheduleRecord({
      owner: "app", invoker: "app", kind: "launchd", unitPath: "/somewhere/app.plist",
      binPath: "/somewhere/bin", installedAt: "2026-09-01T00:00:00.000Z", engineVersion: "0.1.9",
    });
    const f = fakeExec();
    expect(await installSchedule({ invoker: "cli", takeOver: true, noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
    expect((await readScheduleRecord())!.owner).toBe("cli");
  });

  test("re-installing under the SAME owner is a refresh, not a refusal", async () => {
    const f = fakeExec();
    await installSchedule({ invoker: "cli", noVerify: true }, deps("darwin", f.exec));
    expect(await installSchedule({ invoker: "cli", noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
  });

  test("uninstall refuses a foreign owner (exit 2) and removes nothing", async () => {
    writeFileSync(join(UNITS, `${SCHEDULE_LABEL}.plist`), "<plist/>");
    await writeScheduleRecord({
      owner: "app", invoker: "app", kind: "launchd", unitPath: join(UNITS, `${SCHEDULE_LABEL}.plist`),
      binPath: "/b", installedAt: "2026-09-01T00:00:00.000Z", engineVersion: "0.1.9",
    });
    const f = fakeExec();
    expect(await uninstallSchedule({ invoker: "cli" }, deps("darwin", f.exec))).toBe(EXIT_FOREIGN);
    expect(f.calls).toEqual([]);
    expect(existsSync(join(UNITS, `${SCHEDULE_LABEL}.plist`))).toBe(true);
  });

  test("uninstall with nothing installed is exit 1 — 'none', not an error and not a success", async () => {
    const f = fakeExec();
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_NONE);
  });

  test("uninstall leaves the engine BINARY alone — removing a schedule is not removing the tool", async () => {
    const f = fakeExec();
    await installSchedule({ noVerify: true }, deps("darwin", f.exec));
    const dest = managed();
    expect(await uninstallSchedule({}, deps("darwin", f.exec))).toBe(EXIT_OK);
    expect(existsSync(dest)).toBe(true);
    expect(existsSync(schedulePath())).toBe(false);
  });
});

describe("linux (T8)", () => {
  test("writes both units, daemon-reloads and enables --now, through the injected exec", async () => {
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec))).toBe(EXIT_OK);
    expect(existsSync(join(UNITS, "daily-briefing.service"))).toBe(true);
    expect(existsSync(join(UNITS, SYSTEMD_TIMER_NAME))).toBe(true);
    const cmds = f.ran("systemctl").map((c) => c.join(" "));
    expect(cmds).toContain("systemctl --user daemon-reload");
    expect(cmds).toContain(`systemctl --user enable --now ${SYSTEMD_TIMER_NAME}`);
    // No signing on linux — that whole branch is a macOS TCC problem.
    expect(f.ran("codesign")).toEqual([]);
    expect(f.ran("security")).toEqual([]);
  });

  test("the unit points at the managed copy under ~/.local/share — never at the source artifact", async () => {
    const f = fakeExec();
    await installSchedule({ noVerify: true }, deps("linux", f.exec));
    const service = readFileSync(join(UNITS, "daily-briefing.service"), "utf8");
    expect(service).toContain(`ExecStart="${join(HOME, ".local", "share", "daily-briefing", "bin", "daily-briefing")}" run`);
    expect(service).not.toContain(SRC_BIN);
  });

  test("⚠ THE APPIMAGE RULE: an execPath inside a mount is COPIED OUT, and no unit references the mount", async () => {
    // An AppImage's interior path is recreated on every launch, so a unit pointing inside it works
    // exactly once. The managed copy is what makes the rule hold; `assertNoMountPath` is the belt.
    const mountBin = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-mountish-"))), ".mount_dbaXYZ");
    writeFileSync(mountBin, "#!/bin/sh\nexit 0\n");
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec, { execPath: mountBin }))).toBe(EXIT_OK);
    const service = readFileSync(join(UNITS, "daily-briefing.service"), "utf8");
    expect(service).not.toContain(".mount_");
    expect(service).toContain(join(HOME, ".local", "share", "daily-briefing", "bin", "daily-briefing"));
  });

  test("linger: disabled is reported LOUDLY with the exact command, and the install still succeeds", async () => {
    const f = fakeExec({ "show-user": { out: "Linger=no\n" } });
    expect(await installSchedule({ noVerify: true }, deps("linux", f.exec))).toBe(EXIT_OK);
    expect(warned.join("\n")).toContain("LINGERING IS DISABLED");
    expect(warned.join("\n")).toContain("loginctl enable-linger tester");
    expect(f.ran("loginctl").some((c) => c.includes("enable-linger"))).toBe(false);   // not without the flag
    expect(lingerCommand({ USER: "tester" } as NodeJS.ProcessEnv)).toBe("loginctl enable-linger tester");
  });

  test("linger: --enable-linger runs the command; enabled needs neither", async () => {
    const off = fakeExec({ "show-user": { out: "Linger=no\n" } });
    await installSchedule({ noVerify: true, enableLinger: true }, deps("linux", off.exec));
    expect(off.ran("loginctl").map((c) => c.join(" "))).toContain("loginctl enable-linger tester");

    said.length = 0; warned.length = 0;
    const on = fakeExec({ "show-user": { out: "Linger=yes\n" } });
    await installSchedule({ noVerify: true }, deps("linux", on.exec));
    expect(said.join("\n")).toContain("Lingering is enabled");
    expect(on.ran("loginctl").some((c) => c.includes("enable-linger"))).toBe(false);
  });
});

describe("windows (T9) — gated and labelled", () => {
  test("WITHOUT --confirm-experimental: XML written, command PRINTED, schtasks NOT run — and EXIT 2, no record", async () => {
    const f = fakeExec();
    // ⚠ EXIT 2, NOT 0. This returned EXIT_OK and wrote `schedule.json` while registering NOTHING —
    // so a GUI switching on the documented codes (which is the reason they are documented) was told
    // "installed, and ours" about a task that does not exist, `status` would have reported
    // `recordPresent: true`, and `uninstall` would have thought it had something to remove. 2 is the
    // contract's own code for "the caller refused a required confirmation" (install.ts's exit-code
    // contract). The XML stays the deliverable: it is written either way.
    expect(await installSchedule({ noVerify: true }, deps("win32", f.exec))).toBe(EXIT_FOREIGN);
    const xml = join(UNITS, `${WINDOWS_TASK_NAME}.xml`);
    expect(existsSync(xml)).toBe(true);
    // ⚠ UTF-16LE with a BOM on disk — schtasks /XML rejects UTF-8.
    const bytes = new Uint8Array(readFileSync(xml));
    expect([bytes[0], bytes[1]]).toEqual([0xff, 0xfe]);
    expect(f.ran("schtasks")).toEqual([]);                       // ⚠ the gate
    expect(await readScheduleRecord()).toBeNull();               // ⚠ and nothing claims ownership
    expect(existsSync(schedulePath())).toBe(false);
    expect(said.join("\n")).toContain("schtasks /Create /XML");  // …but the exact command is printed
    expect(said.join("\n")).toContain("EXPERIMENTAL");
    expect(said.join("\n")).toContain("--confirm-experimental");
  });

  test("WITH --confirm-experimental: schtasks IS invoked, a record IS written, still labelled experimental", async () => {
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true, confirmExperimental: true }, deps("win32", f.exec))).toBe(EXIT_OK);
    expect(f.ran("schtasks").map((c) => c.join(" ")))
      .toContain(`schtasks /Create /XML ${join(UNITS, `${WINDOWS_TASK_NAME}.xml`)} /TN ${WINDOWS_TASK_NAME} /F`);
    // The other half of the pair above: ownership IS recorded once something was actually registered.
    expect(await readScheduleRecord()).toMatchObject({ owner: "cli", kind: "schtasks" });
    expect(said.join("\n")).toContain("EXPERIMENTAL");
  });

  test("a FAILING schtasks is exit 3 and writes no record either", async () => {
    const f = fakeExec({ "schtasks /Create": { code: 1, err: "ERROR: Access is denied." } });
    expect(await installSchedule({ noVerify: true, confirmExperimental: true }, deps("win32", f.exec))).toBe(EXIT_ERROR);
    expect(await readScheduleRecord()).toBeNull();
  });
});

describe("verify — the engine-side kickstart (plan R1)", () => {
  const V = { pollMs: 1, deadlineMs: 40 };
  /** ⚠ The evidence date must come from the INJECTED clock, not from `new Date()`. `deps()` pins
   *  `now` at 2026-09-14T12:00Z, and a test written against the wall clock passes or fails depending
   *  on what day the suite happens to run — measured here, where the runner's local date was already
   *  the 15th and every evidence file was silently keyed to a day `verifySchedule` was not looking at. */
  const EVIDENCE_DATE = localDateStr(new Date("2026-09-14T12:00:00.000Z"));

  test("kicks through the SCHEDULER, by exact label — not by calling run() directly", async () => {
    // The fact under test is "does the trigger reach the engine". A direct run would answer a
    // different question and pass while the schedule was dead.
    const f = fakeExec();
    await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    expect(f.ran("launchctl").map((c) => c.join(" "))).toContain(`launchctl start ${SCHEDULE_LABEL}`);
  });

  test("linux: the kick is `systemctl --user start --no-block <service>` — queued, never waited on (P9)", async () => {
    const f = fakeExec();
    await verifySchedule({ kind: "systemd", ...V }, deps("linux", f.exec));
    const starts = f.ran("systemctl").filter((c) => c.includes("start")).map((c) => c.join(" "));
    expect(starts[0]).toBe(`systemctl --user start --no-block ${SYSTEMD_SERVICE_NAME}`);
    expect(starts.every((s) => s.includes("--no-block"))).toBe(true);
  });

  test("linux: a run longer than the exec ceiling is observed, not reported as a kick that could not start (P9)", async () => {
    // A model of SYSTEMD's semantics, not of the code under test: `start` on a `Type=oneshot` unit
    // returns only when the run exits, unless `--no-block` queues the job and returns at once. The run
    // modelled here outlasts SCHEDULE_EXEC_TIMEOUT_MS, so a blocking `start` comes back as the exec's
    // timeout failure (the systemctl client killed) while the run itself goes on to deliver.
    const marker = markerPath();   // resolved now: the per-test state dir, even if a timer fires late
    const exec: Exec = async (cmd) => {
      if (cmd[0] === "systemctl" && cmd.includes("start")) {
        setTimeout(() => writeFileSync(marker, EVIDENCE_DATE), 5);   // the run delivers a moment later
        if (!cmd.includes("--no-block")) return { code: 1, out: "", err: `timed out after ${SCHEDULE_EXEC_TIMEOUT_MS}ms` };
      }
      return { code: 0, out: "", err: "" };
    };
    const v = await verifySchedule({ kind: "systemd", pollMs: 1, deadlineMs: 2_000 }, deps("linux", exec));
    expect(v).toMatchObject({ kickstarted: true, outcome: "delivered" });
    expect(verdictLine(v)).not.toContain("could not be started");
  });

  test("a DELIVERY ends the loop immediately — it does not retry for a fatter briefing", async () => {
    // Plan R1: if the first iteration delivers (possibly thin), fall through to the steady-state
    // next-tick watch and let doctor's "repos need access" carry the thin-ness.
    //
    // ⚠ THE EVIDENCE IS WRITTEN BY THE KICK, not before the call. Written the other way — marker
    // seeded, then verify — this test passed against a `kick` THAT DID NOTHING AT ALL, because the
    // poll merely asked "does the marker say today". Writing it from inside the fake exec is what
    // makes the assertion "the kick caused this" instead of "this was already true".
    const f = fakeExec();
    f.onCall("launchctl start", () => writeFileSync(markerPath(), EVIDENCE_DATE));
    const v = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    expect(v).toMatchObject({ kickstarted: true, outcome: "delivered", iterations: 1 });
    expect(f.ran("launchctl").filter((c) => c[1] === "start").length).toBe(1);
  });

  test("a SETTLED skip (already-ran / below-floor) proves the trigger works and does not loop", async () => {
    const f = fakeExec();
    f.onCall("launchctl start", () => writeFileSync(lastSkipPath(), JSON.stringify({
      iso: "2026-09-14T12:00:00.000Z", localDate: EVIDENCE_DATE, reason: "already-ran",
    })));
    const v = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    expect(v).toMatchObject({ outcome: "skipped", skipReason: "already-ran", iterations: 1 });
  });

  // ── ⚠⚠ THE BASELINE. Only a CHANGE from the pre-kick state is evidence. ────────────────────────
  //
  // Measured against the pre-fix code: with the marker already carrying today — the ORDINARY state,
  // since the morning briefing is delivered long before anyone runs `schedule verify` — a fake exec
  // that ran nothing at all was reported as "the kickstarted run DELIVERED a briefing", in 13ms. The
  // three tests below are the ones that fail against that code.
  test("⚠ A DEAD TRIGGER IS NOT A DELIVERY: pre-existing evidence does not satisfy the poll", async () => {
    writeFileSync(markerPath(), EVIDENCE_DATE);      // today's briefing, delivered BEFORE this call
    const f = fakeExec();                            // …and a kick that changes nothing
    const v = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    expect(v).toMatchObject({ kickstarted: true, outcome: "already-delivered-before-kick" });
    // The verdict must never claim the kicked run delivered.
    const line = verdictLine(v);
    expect(line).toContain("NOT VERIFIED");
    expect(line.toLowerCase()).not.toContain("delivered a briefing");
    // …and the exit code is not a pass.
    expect(verifyExitCode(v)).toBe(EXIT_NONE);
  });

  test("a pre-existing SKIP carrying today is not evidence either — it is no-evidence, not 'skipped'", async () => {
    writeFileSync(lastSkipPath(), JSON.stringify({
      iso: "2026-09-14T11:00:00.000Z", localDate: EVIDENCE_DATE, reason: "already-ran",
    }));
    const f = fakeExec();
    const v = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    // No marker, so not "already-delivered-before-kick" either: nothing was learned at all.
    expect(v).toMatchObject({ kickstarted: true, outcome: "no-evidence", skipReason: null });
  });

  test("a NEW skip written after the kick IS evidence, even when a skip for today was already on disk", async () => {
    // The distinguishing fact is the timestamp: the engine writes a fresh `iso` on every decline, so
    // the second decline is visibly not the first. Without this, the baseline would have blinded the
    // verifier to the most common true positive on a machine that has already run today.
    writeFileSync(lastSkipPath(), JSON.stringify({
      iso: "2026-09-14T11:00:00.000Z", localDate: EVIDENCE_DATE, reason: "already-ran",
    }));
    const f = fakeExec();
    f.onCall("launchctl start", () => writeFileSync(lastSkipPath(), JSON.stringify({
      iso: "2026-09-14T12:00:05.000Z", localDate: EVIDENCE_DATE, reason: "already-ran", detail: "second tick",
    })));
    const v = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    expect(v).toMatchObject({ outcome: "skipped", skipReason: "already-ran", detail: "second tick" });
    expect(verifyExitCode(v)).toBe(EXIT_OK);
  });

  test("the exit-code mapping is the documented one — and `no-evidence` is NOT a pass", async () => {
    const refused = fakeExec({ "launchctl start": { code: 1 } });
    const r = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", refused.exec));
    expect(`kick refused → ${verifyExitCode(r)}`).toBe(`kick refused → ${EXIT_ERROR}`);

    const silent = fakeExec();
    const s = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", silent.exec));
    expect(`accepted, nothing appeared → ${s.outcome}/${verifyExitCode(s)}`).toBe(`accepted, nothing appeared → no-evidence/${EXIT_NONE}`);

    const good = fakeExec();
    good.onCall("launchctl start", () => writeFileSync(markerPath(), EVIDENCE_DATE));
    const g = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", good.exec));
    expect(`delivered → ${verifyExitCode(g)}`).toBe(`delivered → ${EXIT_OK}`);
  });

  test("a kickstart the scheduler refuses is reported honestly, never as success", async () => {
    const f = fakeExec({ "launchctl start": { code: 1 } });
    const v = await verifySchedule({ kind: "launchd", ...V }, deps("darwin", f.exec));
    expect(v).toMatchObject({ kickstarted: false, outcome: "no-evidence" });
  });

  test("install runs verify as its LAST step, and --no-verify skips exactly that", async () => {
    const withVerify = fakeExec();
    // Evidence from the kick, not seeded — same reason as the delivery test above.
    withVerify.onCall("launchctl start", () => writeFileSync(markerPath(), EVIDENCE_DATE));
    await installSchedule({ verify: V }, deps("darwin", withVerify.exec));
    const order = withVerify.ran("launchctl").map((c) => c[1]);
    expect(order).toEqual(["unload", "load", "start"]);   // ⚠ start is LAST

    said.length = 0;
    const without = fakeExec();
    await installSchedule({ noVerify: true, verify: V }, deps("darwin", without.exec));
    expect(without.ran("launchctl").map((c) => c[1])).toEqual(["unload", "load"]);
    expect(said.join("\n")).toContain("Skipped the verification kickstart");
  });
});

describe("isRegistered", () => {
  test("probes with the EXACT label per platform", async () => {
    const d = fakeExec(); await isRegistered(deps("darwin", d.exec));
    expect(d.calls.map((c) => c.join(" "))).toEqual([`launchctl list ${SCHEDULE_LABEL}`]);
    const l = fakeExec(); await isRegistered(deps("linux", l.exec));
    expect(l.calls.map((c) => c.join(" "))).toEqual([`systemctl --user is-enabled ${SYSTEMD_TIMER_NAME}`]);
    const w = fakeExec(); await isRegistered(deps("win32", w.exec));
    expect(w.calls.map((c) => c.join(" "))).toEqual([`schtasks /Query /TN ${WINDOWS_TASK_NAME}`]);
  });

  test("a non-zero probe means NOT registered, and a throwing exec does not propagate", async () => {
    const f = fakeExec({ "launchctl list": { code: 1 } });
    expect(await isRegistered(deps("darwin", f.exec))).toBe(false);
    const boom: Exec = async () => { throw new Error("no such binary"); };
    expect(await isRegistered(deps("darwin", boom))).toBe(false);
  });
});

describe("atomic writes — no reader ever sees half a file", () => {
  /** A file is written atomically iff, at the moment it appears (or changes), it is COMPLETE. The
   *  observable proxy for that in a single-process test is the one that actually catches the bug:
   *  the final file must have arrived by RENAME, so the directory must hold no leftover temp and the
   *  content must be whole. The negative — a truncating write — is what leaves a readable partial. */
  const isJsonWhole = (p: string) => { try { JSON.parse(readFileSync(p, "utf8")); return true; } catch { return false; } };

  test("schedule.json is written temp-then-rename, and a torn read is what that prevents", async () => {
    const f = fakeExec();
    await installSchedule({ noVerify: true }, deps("darwin", f.exec));
    expect(isJsonWhole(schedulePath())).toBe(true);
    // No temp survives a successful write, in the record's directory or the unit's.
    const strays = readdirSync(STATE).filter((n) => n.includes(".tmp-"));
    expect(strays).toEqual([]);
    expect(readdirSync(UNITS).filter((n) => n.includes(".tmp-"))).toEqual([]);
    // ⚠ WHY THIS MATTERS AND WHERE IT BITES: a torn record does not fail loudly. `readScheduleRecord`
    // is TOTAL, so a partial file parses as `null` — and `null` means "nobody owns this", which OPENS
    // the single-owner gate. Pinned here so the consequence is on the record next to the mechanism.
    writeFileSync(schedulePath(), '{"owner":"app","unitPa');   // a plausible truncation point
    expect(await readScheduleRecord()).toBeNull();
    const g = fakeExec();
    expect(await installSchedule({ invoker: "cli", noVerify: true }, deps("darwin", g.exec))).toBe(EXIT_OK);
  });

  test("the managed binary is replaced by rename, not copied over in place", async () => {
    // A refresh copies a NEW binary over the path the OS trigger points at — and, on the install.sh
    // path, over a file that may be executing in a concurrent scheduled tick. In place, that truncates
    // before it fills.
    const dest = managed();
    writeFileSync(dest, "#!/bin/sh\necho OLD\n");
    writeFileSync(SRC_BIN, "#!/bin/sh\necho NEW-AND-LONGER-THAN-THE-OLD-ONE\n");
    const f = fakeExec();
    expect(await installSchedule({ noVerify: true }, deps("darwin", f.exec))).toBe(EXIT_OK);
    expect(readFileSync(dest, "utf8")).toBe("#!/bin/sh\necho NEW-AND-LONGER-THAN-THE-OLD-ONE\n");
    expect(statSync(dest).mode & 0o777).toBe(0o755);
    expect(readdirSync(dirname(dest)).filter((n) => n.includes(".tmp-"))).toEqual([]);
  });

  test("every unit file lands whole, on every platform", async () => {
    for (const [platform, names] of [
      ["darwin", [`${SCHEDULE_LABEL}.plist`]],
      ["linux", ["daily-briefing.service", SYSTEMD_TIMER_NAME]],
      ["win32", [`${WINDOWS_TASK_NAME}.xml`]],
    ] as const) {
      const f = fakeExec();
      await installSchedule({ noVerify: true, confirmExperimental: true }, deps(platform, f.exec));
      for (const n of names) expect(`${platform}/${n} exists: ${existsSync(join(UNITS, n))}`).toBe(`${platform}/${n} exists: true`);
      expect(`${platform} strays: ${readdirSync(UNITS).filter((x) => x.includes(".tmp-")).join(",")}`).toBe(`${platform} strays: `);
    }
  });
});

test("an unsupported platform is refused rather than half-installed", async () => {
  const f = fakeExec();
  expect(await installSchedule({}, deps("freebsd", f.exec))).toBe(EXIT_ERROR);
  expect(await uninstallSchedule({}, deps("freebsd", f.exec))).toBe(EXIT_ERROR);
  expect(f.calls).toEqual([]);
});
