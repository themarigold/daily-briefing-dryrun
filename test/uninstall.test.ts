// test/uninstall.test.ts — scripts/uninstall.sh (Phase E, E10): the schedule record it now hands to the
// engine, and the opt-in --remove-signing-identity flag.
//
// ⚠ NOTHING HERE MAY REACH THE REAL KEYCHAIN, LAUNCHD OR INSTALLED BINARY. Every run is boxed in four ways,
// and `run()` asserts the first two before it spawns anything:
//   • PATH is ONE scratch directory holding recording stubs for the keychain tool, launchd's tool and pmset,
//     plus links to the two real utilities the script needs (rm, grep). The real binaries are not on PATH
//     at all, so a stub that went missing would be "command not found", never the real thing.
//   • DBA_TEST_DIR, DBA_TEST_PLIST and DBA_TEST_KEYCHAIN point at scratch paths (the keychain INSIDE
//     DBA_TEST_DIR, which the script now requires), and HOME is scratch. The cases that test the keychain
//     variable's own validation pass a bad value or omit DBA_TEST_DIR on purpose; the stub PATH and the
//     scratch HOME still box them, and each asserts the script refused before calling anything.
//   • The fixture plist is label-less (`<plist/>`, as in maintenance.test.ts), so even a real unload could
//     unload nothing live.
//   • The "managed binary" at $DBA_TEST_DIR/daily-briefing is a link to a stub that records its argv, HOME
//     and state dir, writes one line to stderr, and exits with the case's code (0 also unlinks the record,
//     as the engine does; STUB_MANAGED_RECORD=keep|drop overrides that for the anomalous shapes).
// The two binary names are built by concatenation: test/isolation.meta.test.ts flags any literal that
// names them in command position, and this file adds no exemption.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = resolve(import.meta.dir, "..");
// Spelled as one literal so test/isolation.meta.test.ts's INSTALLER_REDIRECTABLE scan sees this spawn and
// holds it to DBA_TEST_DIR + DBA_TEST_PLIST (it reads code, not comments).
const SCRIPT = join(ROOT, "scripts/uninstall.sh");
const BASH = Bun.which("bash")!;
const KEYCHAIN_TOOL = "sec" + "urity";
const LAUNCHD_TOOL = "launch" + "ctl";
const SIGN_ID = "Daily Briefing (local) Signing";
const FLAG = "--remove-signing-identity";
/** Everything uninstall.sh removes from the support dir, created first so removal is meaningful. */
const ARTIFACTS = [
  "daily-briefing", "wake-schedule.json", "briefing.log", "briefing-latest.md",
  "briefing.log.1", "transcript-health.json", "audit-2026-07-30.md", "audit-2026-07-31.md",
];

interface Fx {
  base: string; support: string; plist: string; home: string; keychain: string; calls: string; managedLog: string; record: string;
  /** The support-dir artifacts this fixture actually created (the managed binary depends on the case). */
  created: string[];
  managedRc: number | null; keychainRc: number;
}

/** The stubs, written ONCE per file and shared: on macOS the first exec of a freshly written executable
 *  cost ~0.2 s each here (measured), so per-fixture stubs made this file several times slower. Each stub reads
 *  where to record, and what to exit with, from the run's environment. */
let shared: { bin: string; engine: string } | undefined;
function stubs(): { bin: string; engine: string } {
  if (shared) return shared;
  const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-uninstall-stubs-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const stub = (name: string, rcVar: string) => writeFileSync(join(bin, name),
    `#!/bin/sh\n{ printf '%s' "${name}"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$STUB_LOG"\nexit "\${${rcVar}:-0}"\n`,
    { mode: 0o755 });
  stub(KEYCHAIN_TOOL, "STUB_KEYCHAIN_RC");
  stub(LAUNCHD_TOOL, "STUB_LAUNCHD_RC");
  stub("pmset", "STUB_PMSET_RC");
  for (const real of ["rm", "grep"]) symlinkSync(Bun.which(real)!, join(bin, real));
  // The managed binary: records its argv, HOME and state dir; exit 0 = removed, so it unlinks the record
  // the way the engine does (src/schedule/install.ts uninstallSchedule). Outside PATH.
  const engine = join(dir, "engine");
  writeFileSync(engine, [
    "#!/bin/sh",
    'printf \'%s\\n\' "$*" "$HOME" "$DAILY_BRIEFING_STATE_DIR" > "$STUB_MANAGED_LOG"',
    'echo "stub engine: schedule uninstall -> exit ${STUB_MANAGED_RC:-0}" >&2',
    'case "${STUB_MANAGED_RECORD:-}" in',
    '  keep) ;;',
    '  drop) rm -f "$DAILY_BRIEFING_STATE_DIR/schedule.json" ;;',
    '  *) if [ "${STUB_MANAGED_RC:-0}" = 0 ]; then rm -f "$DAILY_BRIEFING_STATE_DIR/schedule.json"; fi ;;',
    "esac",
    'exit "${STUB_MANAGED_RC:-0}"',
    "",
  ].join("\n"), { mode: 0o755 });
  return (shared = { bin, engine });
}

/** `managed`: absent, present but not executable, executable but impossible to run, or an executable stub
 *  exiting with that code. */
function fixture(opts: { record?: boolean; managed?: "absent" | "not-executable" | "unrunnable" | number; keychainExit?: number } = {}): Fx {
  const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-uninstall-")));
  const support = join(base, "support");
  const home = join(base, "home");
  for (const d of [support, home, join(base, "LaunchAgents")]) mkdirSync(d, { recursive: true });
  const managed = opts.managed ?? "absent";
  const fx: Fx = {
    base, support, home,
    plist: join(base, "LaunchAgents", "fake.plist"),
    keychain: join(support, "scratch.keychain-db"),
    calls: join(base, "calls.log"),
    managedLog: join(base, "managed.log"),
    record: join(support, "schedule.json"),
    created: [],
    managedRc: typeof managed === "number" ? managed : null,
    keychainRc: opts.keychainExit ?? 0,
  };
  // The managed binary is one of the artifacts, but its shape is the case's: absent, inert, or the stub.
  for (const f of ARTIFACTS) if (f !== "daily-briefing") writeFileSync(join(support, f), "x");
  mkdirSync(join(support, "briefings"));
  writeFileSync(join(support, "briefings", "2026-08-14.md"), "x");
  writeFileSync(fx.plist, "<plist/>");
  if (opts.record) writeFileSync(fx.record, '{"owner":"cli","unitPath":"/nowhere"}\n');
  if (managed === "not-executable") writeFileSync(join(support, "daily-briefing"), "x", { mode: 0o644 });
  // Executable, but exec fails: its interpreter does not exist.
  else if (managed === "unrunnable") writeFileSync(join(support, "daily-briefing"), "#!/nonexistent/interpreter\n", { mode: 0o755 });
  else if (typeof managed === "number") symlinkSync(stubs().engine, join(support, "daily-briefing"));
  fx.created = ARTIFACTS.filter((f) => existsSync(join(support, f)));
  return fx;
}

interface Run { code: number; out: string; calls: string[][]; managed: { argv: string; home: string; stateDir: string } | null }

/** `keychain`: the scratch keychain inside DBA_TEST_DIR (default), omitted (false), or an explicit value
 *  for the variable's own validation cases. `testDir: false` omits DBA_TEST_DIR (HOME stays scratch).
 *  `record`: the stub engine's STUB_MANAGED_RECORD. */
function run(fx: Fx, args: string[] = [], opts: { keychain?: boolean | string; testDir?: boolean; record?: "keep" | "drop" } = {}): Run {
  const { bin } = stubs();
  const keychain = opts.keychain === undefined || opts.keychain === true ? fx.keychain : opts.keychain;
  const env: Record<string, string> = {
    PATH: bin,
    HOME: fx.home,
    ...(opts.testDir === false ? {} : { DBA_TEST_DIR: fx.support }),
    DBA_TEST_PLIST: fx.plist,
    ...(keychain === false ? {} : { DBA_TEST_KEYCHAIN: keychain }),
    STUB_LOG: fx.calls,
    STUB_MANAGED_LOG: fx.managedLog,
    STUB_MANAGED_RC: String(fx.managedRc ?? 0),
    STUB_KEYCHAIN_RC: String(fx.keychainRc),
    ...(opts.record ? { STUB_MANAGED_RECORD: opts.record } : {}),
  };
  // The interlocks, asserted before anything runs: PATH is the stub directory alone, the stubs are what it
  // resolves, and every redirected path is scratch (HOME too, which is where the default support dir and
  // keychain would resolve when DBA_TEST_DIR is omitted).
  expect(env.PATH).toBe(bin);
  for (const name of [KEYCHAIN_TOOL, LAUNCHD_TOOL, "pmset"]) expect(Bun.which(name, { PATH: env.PATH })).toBe(join(bin, name));
  expect([env.HOME, env.DBA_TEST_DIR, env.DBA_TEST_PLIST].filter((p) => p !== undefined).every((p) => p!.startsWith(fx.base + "/"))).toBe(true);
  if (args.includes(FLAG) && opts.keychain === undefined) expect(env.DBA_TEST_KEYCHAIN!.startsWith(fx.support + "/")).toBe(true);

  const r = Bun.spawnSync([BASH, SCRIPT, ...args], { cwd: fx.base, env, stdout: "pipe", stderr: "pipe" });
  const calls = existsSync(fx.calls) ? readFileSync(fx.calls, "utf8").trimEnd().split("\n").filter(Boolean).map((l) => l.split("\t")) : [];
  let managed: Run["managed"] = null;
  if (existsSync(fx.managedLog)) {
    const [argv, home, stateDir] = readFileSync(fx.managedLog, "utf8").split("\n");
    managed = { argv: argv!, home: home!, stateDir: stateDir! };
  }
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString(), calls, managed };
}

const callsTo = (r: Run, name: string) => r.calls.filter((c) => c[0] === name).map((c) => c.slice(1));
/** What is still on disk. */
function left(fx: Fx) {
  return {
    artifacts: ARTIFACTS.filter((f) => existsSync(join(fx.support, f))),
    archive: existsSync(join(fx.support, "briefings")),
    plist: existsSync(fx.plist),
    record: existsSync(fx.record),
  };
}
const nothingRemoved = (fx: Fx) => ({ artifacts: fx.created, archive: true, plist: true });
const ALL_REMOVED = { artifacts: [], archive: false, plist: false };

/** The refusal's recovery text for a record nobody owns. */
const STALE_HINT = "the record is stale: delete";

describe("uninstall.sh: the schedule record goes to the engine first", () => {
  test("record + managed binary exiting 0 -> the removals proceed; the binary saw the redirected HOME and state dir", () => {
    const fx = fixture({ record: true, managed: 0 });
    const r = run(fx);
    expect(r.code).toBe(0);
    expect(r.managed).toEqual({ argv: "schedule uninstall", home: join(fx.support, "home"), stateDir: fx.support });
    expect(left(fx)).toEqual({ ...ALL_REMOVED, record: false });   // the engine unlinked it
    expect(callsTo(r, LAUNCHD_TOOL)).toEqual([["unload", fx.plist]]);
    expect(callsTo(r, KEYCHAIN_TOOL)).toEqual([]);
    // The engine's stderr is captured and printed back.
    expect(r.out).toContain("stub engine: schedule uninstall -> exit 0");
    expect(r.out).toMatch(/^Uninstalled\.$/m);
  });

  test("record + managed binary exiting 1 with the record still there -> an error, nothing removed (the engine returns 1 only when it finds no record)", () => {
    const fx = fixture({ record: true, managed: 1 });
    const r = run(fx);
    expect(r.code).toBe(1);
    expect(r.managed?.argv).toBe("schedule uninstall");
    expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: true });
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("reported nothing installed (exit 1), yet the record is still");
    expect(r.out).toContain(STALE_HINT);
    expect(r.out).toContain("stub engine: schedule uninstall -> exit 1");
  });

  test("record + managed binary exiting 1 with the record gone -> the removals proceed", () => {
    const fx = fixture({ record: true, managed: 1 });
    const r = run(fx, [], { record: "drop" });
    expect(r.code).toBe(0);
    expect(left(fx)).toEqual({ ...ALL_REMOVED, record: false });
    expect(callsTo(r, LAUNCHD_TOOL)).toEqual([["unload", fx.plist]]);
  });

  test("record + managed binary exiting 2 (another owner, typically the app) -> REFUSED: non-zero, nothing removed, no launchd or keychain call", () => {
    const fx = fixture({ record: true, managed: 2 });
    const r = run(fx);
    expect(r.code).toBe(1);
    expect(r.managed?.argv).toBe("schedule uninstall");
    // The managed binary the app's trigger runs is still there, and so is everything else.
    expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: true });
    expect(existsSync(join(fx.support, "daily-briefing"))).toBe(true);
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("owned by another principal (typically the desktop app)");
    expect(r.out).toContain("Schedule screen (or uninstall the app) and re-run");
    // The other source of exit 2: an old engine with no `schedule` command, whose record is stale.
    expect(r.out).toContain("old engine without a `schedule` command");
    expect(r.out).toContain(STALE_HINT);
    expect(r.out).not.toMatch(/^Uninstalled/m);
  });

  test("record + managed binary exiting 3 (error) -> non-zero, nothing removed, the engine's stderr shown", () => {
    const fx = fixture({ record: true, managed: 3 });
    const r = run(fx);
    expect(r.code).toBe(3);
    expect(r.managed?.argv).toBe("schedule uninstall");
    expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: true });
    expect(r.calls).toEqual([]);
    expect(r.out).toContain("schedule uninstall failed (exit 3). Nothing was removed.");
    expect(r.out).toContain("stub engine: schedule uninstall -> exit 3");
  });

  test("a managed binary that cannot be run at all -> non-zero (never read as \"nothing installed\"), nothing removed", () => {
    const fx = fixture({ record: true, managed: "unrunnable" });
    const r = run(fx);
    expect(r.code === 126 || r.code === 127).toBe(true);
    expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: true });
    expect(r.calls).toEqual([]);
  });

  test("an exit code outside the contract is an error too -> non-zero, nothing removed", () => {
    const fx = fixture({ record: true, managed: 7 });
    const r = run(fx);
    expect(r.code).toBe(7);
    expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: true });
  });

  test("no record + a managed binary (a pre-schedule install, or an old binary that would exit 2) -> not asked; the raw path runs as before", () => {
    const fx = fixture({ record: false, managed: 2 });
    const r = run(fx);
    expect(r.code).toBe(0);
    expect(r.managed).toBeNull();
    expect(callsTo(r, LAUNCHD_TOOL)).toEqual([["unload", fx.plist]]);
    expect(left(fx)).toEqual({ ...ALL_REMOVED, record: false });
  });

  test("no record + a managed binary that is not executable (test/maintenance.test.ts's shape) -> not asked; the raw path runs", () => {
    const fx = fixture({ record: false, managed: "not-executable" });
    const r = run(fx);
    expect(r.code).toBe(0);
    expect(r.managed).toBeNull();
    expect(callsTo(r, LAUNCHD_TOOL)).toEqual([["unload", fx.plist]]);
    expect(left(fx)).toEqual({ ...ALL_REMOVED, record: false });
  });

  test("record + a managed binary that is absent or not executable -> REFUSED: the owner cannot be asked, so the raw path never runs", () => {
    for (const managed of ["absent", "not-executable"] as const) {
      const fx = fixture({ record: true, managed });
      const r = run(fx);
      expect(`${managed}: ${r.code}`).toBe(`${managed}: 1`);
      expect(r.managed).toBeNull();
      expect(r.out).not.toMatch(/Permission denied/);   // not even attempted
      expect(r.calls).toEqual([]);                      // no unload, no keychain call
      expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: true });
      expect(r.out).toContain("the managed binary that owns it is missing or");
      expect(r.out).toContain(STALE_HINT);
    }
  });
});

describe("uninstall.sh --remove-signing-identity", () => {
  test("flag + no record -> exactly one delete-identity call, naming the identity and the scratch keychain, never the login keychain", () => {
    const fx = fixture({ record: false, managed: "not-executable" });
    const r = run(fx, [FLAG]);
    expect(r.code).toBe(0);
    expect(callsTo(r, KEYCHAIN_TOOL)).toEqual([["delete-identity", "-c", SIGN_ID, fx.keychain]]);
    expect(r.calls.flat().some((a) => /login\.keychain/.test(a))).toBe(false);
    expect(left(fx)).toEqual({ ...ALL_REMOVED, record: false });
    expect(r.out).toContain(`Removed the '${SIGN_ID}' code-signing identity`);
  });

  test("flag + record whose binary is absent or not executable -> refused, non-zero, nothing removed, no keychain call", () => {
    for (const managed of ["absent", "not-executable"] as const) {
      const fx = fixture({ record: true, managed });
      const r = run(fx, [FLAG]);
      expect(`${managed}: ${r.code}`).toBe(`${managed}: 1`);
      expect(r.calls).toEqual([]);
      expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: true });
      expect(r.out).toContain(STALE_HINT);
    }
  });

  test("flag + a record the engine reported removing (exit 0) but left behind -> the flag's own refusal: nothing removed, no keychain call", () => {
    const fx = fixture({ record: true, managed: 0 });
    const r = run(fx, [FLAG], { record: "keep" });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: true });
    expect(r.out).toContain("refusing --remove-signing-identity: a schedule record still exists");
    expect(r.out).toContain(STALE_HINT);
    // Without the flag the same shape proceeds: the engine removed the trigger, so nothing still runs the
    // binary; only the identity is held back by the leftover record.
    const fx2 = fixture({ record: true, managed: 0 });
    const r2 = run(fx2, [], { record: "keep" });
    expect(r2.code).toBe(0);
    expect(left(fx2)).toEqual({ ...ALL_REMOVED, record: true });
  });

  test("flag + record kept by another owner (exit 2) -> refused: nothing removed, no keychain or launchd call", () => {
    const fx = fixture({ record: true, managed: 2 });
    const r = run(fx, [FLAG]);
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: true });
  });

  test("flag + a record the engine removes (exit 0) -> the removals proceed and the identity is deleted", () => {
    const fx = fixture({ record: true, managed: 0 });
    const r = run(fx, [FLAG]);
    expect(r.code).toBe(0);
    expect(left(fx)).toEqual({ ...ALL_REMOVED, record: false });
    expect(callsTo(r, KEYCHAIN_TOOL)).toEqual([["delete-identity", "-c", SIGN_ID, fx.keychain]]);
  });

  test("no flag -> no keychain call, in every shape above", () => {
    for (const opts of [{}, { record: true, managed: 0 }, { record: true, managed: 2 }, { record: false, managed: "not-executable" as const }]) {
      const r = run(fixture(opts));
      expect(callsTo(r, KEYCHAIN_TOOL)).toEqual([]);
    }
  });

  test("DBA_TEST_DIR set without DBA_TEST_KEYCHAIN -> the flag refuses before anything runs", () => {
    const fx = fixture({ record: true, managed: 0 });
    const r = run(fx, [FLAG], { keychain: false });
    expect(r.code).toBe(1);
    expect(r.calls).toEqual([]);
    expect(r.managed).toBeNull();
    expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: true });
    expect(r.out).toContain("DBA_TEST_DIR is set without DBA_TEST_KEYCHAIN");
  });

  test("a DBA_TEST_KEYCHAIN that is not an absolute path inside DBA_TEST_DIR -> refused before anything runs (an option like -t never reaches the keychain tool)", () => {
    for (const value of [
      "-t",                                    // would parse as delete-identity's -t, leaving no keychain operand
      "-",
      "scratch.keychain-db",                   // relative
      "/elsewhere/scratch.keychain-db",        // absolute, outside DBA_TEST_DIR
    ]) {
      for (const args of [[FLAG], []]) {
        const fx = fixture({ record: true, managed: 0 });
        const r = run(fx, args, { keychain: value });
        expect(`${value} ${args.join(" ")}: ${r.code}`).toBe(`${value} ${args.join(" ")}: 1`);
        expect(r.calls).toEqual([]);
        expect(r.managed).toBeNull();
        expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: true });
        expect(r.out).toContain("DBA_TEST_KEYCHAIN must be an absolute path inside DBA_TEST_DIR");
      }
    }
    // Outside DBA_TEST_DIR by a sibling path, and by a ".." escape (spelled out: join() would normalise it).
    for (const make of [(fx: Fx) => join(fx.base, "outside.keychain-db"), (fx: Fx) => `${fx.support}/../outside.keychain-db`, (fx: Fx) => `${fx.support}-sibling/x.keychain-db`, (fx: Fx) => fx.support, (fx: Fx) => `${fx.support}/`]) {
      const fx = fixture({ record: false, managed: "not-executable" });
      const value = make(fx);
      const r = run(fx, [FLAG], { keychain: value });
      expect(`${value}: ${r.code}`).toBe(`${value}: 1`);
      expect(r.calls).toEqual([]);
      expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: false });
    }
  });

  test("DBA_TEST_KEYCHAIN without DBA_TEST_DIR -> refused before anything runs, with or without the flag", () => {
    for (const args of [[FLAG], []]) {
      const fx = fixture({ record: false, managed: "not-executable" });
      // Without DBA_TEST_DIR the support dir resolves under HOME, which is scratch: seed it, so a run that
      // got past the refusal would visibly remove something.
      const defaultSupport = join(fx.home, "Library", "Application Support", "daily-briefing");
      mkdirSync(defaultSupport, { recursive: true });
      writeFileSync(join(defaultSupport, "briefing.log"), "x");
      const r = run(fx, args, { testDir: false });
      expect(`${args.join(" ")}: ${r.code}`).toBe(`${args.join(" ")}: 1`);
      expect(r.calls).toEqual([]);
      expect(r.managed).toBeNull();
      expect(existsSync(join(defaultSupport, "briefing.log"))).toBe(true);
      expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: false });
      expect(r.out).toContain("DBA_TEST_KEYCHAIN is set but DBA_TEST_DIR is not");
    }
  });

  test("a failed deletion -> the files are still removed, and the exit is non-zero with a warning and an honest last line", () => {
    const fx = fixture({ record: false, keychainExit: 44 });
    const r = run(fx, [FLAG]);
    expect(r.code).toBe(1);
    expect(left(fx)).toEqual({ ...ALL_REMOVED, record: false });
    expect(r.out).toContain("WARN: could not delete");
    expect(r.out).toContain(`Uninstalled, except the '${SIGN_ID}' identity, which could not be deleted`);
    expect(r.out).not.toMatch(/^Uninstalled\.$/m);
  });

  test("an unknown argument -> usage, exit 2, nothing removed and nothing called", () => {
    const fx = fixture({ record: false });
    const r = run(fx, ["--remove-signing-identiy"]);
    expect(r.code).toBe(2);
    expect(r.calls).toEqual([]);
    expect(left(fx)).toEqual({ ...nothingRemoved(fx), record: false });
  });

  test("the script calls the keychain tool by NAME, never by an absolute path (the PATH stub must be able to intercept it)", () => {
    const src = readFileSync(SCRIPT, "utf8");
    for (const dir of ["/usr/bin/", "/bin/", "/usr/local/bin/", "/opt/homebrew/bin/"]) expect(src).not.toContain(dir + KEYCHAIN_TOOL);
    const code = src.split("\n").filter((l) => !l.trimStart().startsWith("#"));
    const uses = code.filter((l) => new RegExp(`(^|[\\s;&|(])\\S*${KEYCHAIN_TOOL}\\s`).test(l));
    expect(uses.map((l) => l.trim())).toEqual([`if ${KEYCHAIN_TOOL} delete-identity -c "$SIGN_ID" "$KEYCHAIN"; then`]);
  });
});
