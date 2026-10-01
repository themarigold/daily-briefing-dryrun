import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// Slice 4 T4 — `schedule` argv wiring, in the shape dispatch.test.ts / dispatch.json.test.ts already
// established.
//
// ⚠ THE H2 LESSON IS AGAIN THE WHOLE FILE, and this slice reopens it twice over. `schedule` is a new
// command token, so `daily-briefing --json schedule install` must not route to `run`; and `schedule`
// has VERBS, so a missing or typo'd verb must not fall through to anything stateful. Every assertion
// below is a variant of "and it did NOT invoke run(), and it did NOT reach a scheduler".
import { test, expect, describe } from "bun:test";
import { dispatch } from "../src/main";
// ⚠ The REAL mapping, not a re-implementation: the point of the exit-code tests below is that the
// arm in `dispatch` uses THIS function, so a spy carrying its own copy would pin nothing. Importing
// it reaches no scheduler — `verifyExitCode` is a pure switch over the result object.
import { verifyExitCode, type VerifyResult } from "../src/schedule/install";

const VERIFIED: VerifyResult = { kickstarted: true, outcome: "delivered", skipReason: null, detail: null, iterations: 1 };

function spy(verify: VerifyResult = VERIFIED) {
  const seen = {
    ran: 0, inited: 0, status: 0, doctor: 0, validated: 0,
    installed: 0, uninstalled: 0, verified: 0, schedStatus: 0,
    lastInstall: undefined as unknown, lastUninstall: undefined as unknown,
    out: [] as string[], err: [] as string[],
  };
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { seen.out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { seen.err.push(a.map(String).join(" ")); };
  const deps = {
    run: (async () => { seen.ran++; return 0; }) as never,
    init: (async () => { seen.inited++; return 0; }) as never,
    status: (async () => { seen.status++; return { schemaVersion: 1 } as never; }) as never,
    doctor: (async () => { seen.doctor++; return { schemaVersion: 1 } as never; }) as never,
    configValidate: (() => { seen.validated++; return { schemaVersion: 1, valid: true, errors: [], warnings: [], normalized: null } as never; }) as never,
    // ⚠ The scheduling modules are injected WHOLE, so no `launchctl`, `systemctl` or `schtasks` is
    // reachable from a routing test — the property scanner 4 asserts statically, asserted here
    // dynamically as well.
    schedule: {
      installSchedule: async (o: unknown) => { seen.installed++; seen.lastInstall = o; return 0; },
      uninstallSchedule: async (o: unknown) => { seen.uninstalled++; seen.lastUninstall = o; return 0; },
      verifySchedule: async () => { seen.verified++; return verify; },
      verdictLine: () => "verdict",
      verifyExitCode,
    } as never,
    scheduleStatus: {
      scheduleStatusReport: async () => { seen.schedStatus++; return { schemaVersion: 1, registered: true } as never; },
      renderScheduleStatus: () => "human status",
    } as never,
  };
  return { seen, deps, restore: () => { console.log = oLog; console.error = oErr; } };
}

describe("the four verbs route", () => {
  test("install / uninstall / status / verify each reach exactly their own surface", async () => {
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "schedule", "install"], s.deps)).toBe(0);
      expect(await dispatch(["bun", "bin", "schedule", "uninstall"], s.deps)).toBe(0);
      expect(await dispatch(["bun", "bin", "schedule", "status"], s.deps)).toBe(0);
      expect(await dispatch(["bun", "bin", "schedule", "verify"], s.deps)).toBe(0);
      expect([s.seen.installed, s.seen.uninstalled, s.seen.schedStatus, s.seen.verified]).toEqual([1, 1, 1, 1]);
      expect([s.seen.ran, s.seen.inited]).toEqual([0, 0]);
    } finally { s.restore(); }
  });

  test("`schedule status` has a HUMAN form; --json switches it, and the two come from one report", async () => {
    // Unlike the A1 surfaces, this one is not --json-only: T6 specifies human output. So --json is
    // optional here rather than required, and `renderScheduleStatus` is a pure function of the same
    // object that gets serialised — they cannot disagree.
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "schedule", "status"], s.deps)).toBe(0);
      expect(s.seen.out.at(-1)).toBe("human status");
      expect(await dispatch(["bun", "bin", "schedule", "status", "--json"], s.deps)).toBe(0);
      expect(JSON.parse(s.seen.out.at(-1)!).schemaVersion).toBe(1);
      expect(s.seen.schedStatus).toBe(2);
    } finally { s.restore(); }
  });

  test("⚠ `schedule verify` EXITS ON THE OUTCOME — it used to return a hardcoded 0", async () => {
    // A hardcoded 0 meant a kickstart the scheduler REFUSED, and a poll that found nothing, both
    // exited "success" while the printed verdict said otherwise — so a GUI or a script switching on
    // the documented codes (the whole reason they are documented) was told every verify passed. The
    // mapping: 0 evidence appeared · 1 accepted but no NEW evidence · 3 the kick could not be issued.
    const cases: Array<[Partial<VerifyResult>, number, string]> = [
      [{ outcome: "delivered" }, 0, "a delivery is evidence"],
      [{ outcome: "skipped", skipReason: "already-ran" }, 0, "a skip the engine wrote is evidence too"],
      [{ outcome: "no-evidence" }, 1, "accepted, but nothing appeared"],
      [{ outcome: "already-delivered-before-kick" }, 1, "today's delivery predates the kick — it proves nothing"],
      [{ kickstarted: false, outcome: "no-evidence" }, 3, "the scheduler refused the kick"],
    ];
    for (const [patch, code, why] of cases) {
      const s = spy({ ...VERIFIED, ...patch });
      try {
        expect(`${patch.outcome}/kicked=${patch.kickstarted ?? true} → ${await dispatch(["bun", "bin", "schedule", "verify"], s.deps)} (${why})`)
          .toBe(`${patch.outcome}/kicked=${patch.kickstarted ?? true} → ${code} (${why})`);
        expect(s.seen.ran).toBe(0);   // …and never a briefing run, whatever the outcome
      } finally { s.restore(); }
    }
  });
});

describe("⚠ the H2 class — no schedule invocation may fall through to a briefing run", () => {
  test("`schedule` with NO verb exits 2 and runs nothing", async () => {
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "schedule"], s.deps)).toBe(2);
      expect([s.seen.ran, s.seen.installed, s.seen.uninstalled, s.seen.schedStatus, s.seen.verified]).toEqual([0, 0, 0, 0, 0]);
      expect(s.seen.err.join("\n")).toContain("a verb is required");
    } finally { s.restore(); }
  });

  test("an UNKNOWN or malformed verb is refused — never defaulted to install or status", async () => {
    const s = spy();
    try {
      for (const bad of ["--nonsense", "instal", "Install", "start", "--json", "-f", "install2"]) {
        expect(`schedule ${bad} → ${await dispatch(["bun", "bin", "schedule", bad], s.deps)}`)
          .toBe(`schedule ${bad} → 2`);
      }
      expect([s.seen.ran, s.seen.installed, s.seen.uninstalled, s.seen.schedStatus, s.seen.verified]).toEqual([0, 0, 0, 0, 0]);
    } finally { s.restore(); }
  });

  test("⚠ a LEADING run-flag followed by `schedule` REFUSES rather than running a briefing", async () => {
    // `cmd` is argv[2] only when it does not start with `-`. Without `schedule` in KNOWN_COMMANDS,
    // `daily-briefing --json schedule install` would route to `run`, discard the token silently and
    // perform a full pipeline run — provider call, archive, day stamp — consuming the morning.
    const s = spy();
    try {
      for (const argv of [
        ["--json", "schedule"], ["--json", "schedule", "status"], ["--force", "schedule", "install"],
        ["-f", "schedule"], ["run", "schedule", "install"], ["--json-out", "/tmp/x.json", "schedule", "status"],
        ["--json-out", "schedule"],
      ]) {
        expect(`${argv.join(" ")} → ${await dispatch(["bun", "bin", ...argv], s.deps)}`)
          .toBe(`${argv.join(" ")} → 2`);
      }
      expect([s.seen.ran, s.seen.installed, s.seen.uninstalled, s.seen.schedStatus, s.seen.verified]).toEqual([0, 0, 0, 0, 0]);
      expect(s.seen.err.join("\n")).toContain("must come FIRST");
    } finally { s.restore(); }
  });

  test("`--json-out` is refused on schedule — it promises an envelope and would deliver a side effect", async () => {
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "schedule", "install", "--json-out", "/tmp/e.json"], s.deps)).toBe(2);
      expect(s.seen.installed).toBe(0);
      expect(s.seen.err.join("\n")).toContain("flag of `run`");
    } finally { s.restore(); }
  });
});

describe("flags", () => {
  test("--invoker defaults to cli, accepts app|cli, and REFUSES anything else or a missing value", async () => {
    const s = spy();
    try {
      await dispatch(["bun", "bin", "schedule", "install"], s.deps);
      expect((s.seen.lastInstall as { invoker: string }).invoker).toBe("cli");
      await dispatch(["bun", "bin", "schedule", "install", "--invoker", "app"], s.deps);
      expect((s.seen.lastInstall as { invoker: string }).invoker).toBe("app");
      // A missing value must not silently install under the wrong principal.
      expect(await dispatch(["bun", "bin", "schedule", "install", "--invoker"], s.deps)).toBe(2);
      expect(await dispatch(["bun", "bin", "schedule", "install", "--invoker", "--take-over"], s.deps)).toBe(2);
      expect(await dispatch(["bun", "bin", "schedule", "install", "--invoker", "gui"], s.deps)).toBe(2);
      expect(s.seen.installed).toBe(2);   // only the two legitimate ones
    } finally { s.restore(); }
  });

  test("the boolean flags reach installSchedule as themselves", async () => {
    const s = spy();
    try {
      await dispatch([
        "bun", "bin", "schedule", "install",
        "--take-over", "--no-verify", "--enable-linger", "--confirm-experimental",
        "--identity", "Developer ID Application: X",
      ], s.deps);
      expect(s.seen.lastInstall).toMatchObject({
        takeOver: true, noVerify: true, enableLinger: true, confirmExperimental: true,
        identity: "Developer ID Application: X", invoker: "cli",
      });
      // …and the floor is DERIVED, never a literal: parseFloor's default with no config.
      expect((s.seen.lastInstall as { floorMinutes: number }).floorMinutes).toBe(7 * 60 + 20);
    } finally { s.restore(); }
  });

  test("--identity with no value is refused rather than swallowing the next flag", async () => {
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "schedule", "install", "--identity"], s.deps)).toBe(2);
      expect(await dispatch(["bun", "bin", "schedule", "install", "--identity", "--take-over"], s.deps)).toBe(2);
      expect(s.seen.installed).toBe(0);
    } finally { s.restore(); }
  });

  test("uninstall carries invoker and --take-over too", async () => {
    const s = spy();
    try {
      await dispatch(["bun", "bin", "schedule", "uninstall", "--invoker", "app", "--take-over"], s.deps);
      expect(s.seen.lastUninstall).toMatchObject({ invoker: "app", takeOver: true });
    } finally { s.restore(); }
  });
});

test("--help documents the schedule subcommand and every one of its flags", async () => {
  // A surface the desktop shell is built against is not discoverable unless --help says it exists.
  const s = spy();
  try {
    expect(await dispatch(["bun", "bin", "--help"], s.deps)).toBe(0);
    const help = s.seen.out.join("\n");
    for (const needle of [
      "schedule install|uninstall|status|verify",
      "--invoker app|cli", "--take-over", "--identity", "--no-verify", "--enable-linger",
      "--confirm-experimental", "DBA_SIGN_IDENTITY",
    ]) {
      expect(`help mentions ${needle}: ${help.includes(needle)}`).toBe(`help mentions ${needle}: true`);
    }
    expect(s.seen.ran).toBe(0);
  } finally { s.restore(); }
});
