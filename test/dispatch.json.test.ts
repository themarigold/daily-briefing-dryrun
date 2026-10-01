import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// A1 argv wiring, in the shape `dispatch.test.ts` already established.
//
// THE H2 LESSON IS THE WHOLE FILE: no new flag or subcommand may fall through to a briefing run or a
// day-stamp. The old catch-all routed ANY leading flag — `--help` included — straight into a full
// generate + stamp, and every assertion below is a variant of "and it did NOT invoke run()".
import { test, expect, describe } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { dispatch } from "../src/main";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

/** Routes every command through injected stand-ins, so a routing test never executes a real surface
 *  (`doctorReport` spawns `which`, a provider `--help` and a TCP probe) and every `ran`/`inited`
 *  assertion below is about ROUTING rather than about side effects. */
function spy() {
  const seen = { ran: 0, inited: 0, status: 0, doctor: 0, validated: 0, out: [] as string[], err: [] as string[] };
  let lastRunOut: unknown;
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { seen.out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { seen.err.push(a.map(String).join(" ")); };
  const deps = {
    run: (async (_f: boolean, _d: unknown, o: unknown) => { seen.ran++; lastRunOut = o; return 0; }) as never,
    init: (async () => { seen.inited++; return 0; }) as never,
    status: (async () => { seen.status++; return { schemaVersion: 1 } as never; }) as never,
    doctor: (async () => { seen.doctor++; return { schemaVersion: 1 } as never; }) as never,
    configValidate: ((raw: unknown) => { seen.validated++; return { schemaVersion: 1, valid: true, errors: [], warnings: [], normalized: raw } as never; }) as never,
  };
  return { seen, deps, runOut: () => lastRunOut as { json?: boolean; jsonOut?: string }, restore: () => { console.log = oLog; console.error = oErr; } };
}

describe("run's new output flags", () => {
  test("`run --json` reaches run() with json:true and nothing else changed", async () => {
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "run", "--json"], s.deps)).toBe(0);
      expect(s.seen.ran).toBe(1);
      expect(s.runOut().json).toBe(true);
      expect(s.runOut().jsonOut).toBeUndefined();
    } finally { s.restore(); }
  });

  test("`run --json-out <path>` reaches run() with that path", async () => {
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "run", "--json-out", "/tmp/env.json"], s.deps)).toBe(0);
      expect(s.runOut()).toMatchObject({ json: false, jsonOut: "/tmp/env.json" });
    } finally { s.restore(); }
  });

  test("both flags at once are both passed through", async () => {
    const s = spy();
    try {
      await dispatch(["bun", "bin", "run", "--json", "--json-out", "/tmp/e.json", "--force"], s.deps);
      expect(s.runOut()).toMatchObject({ json: true, jsonOut: "/tmp/e.json" });
    } finally { s.restore(); }
  });

  test("a BARE leading --json / --json-out still means the default `run`", async () => {
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "--json"], s.deps)).toBe(0);
      expect(s.runOut().json).toBe(true);
      expect(await dispatch(["bun", "bin", "--json-out", "/tmp/e.json"], s.deps)).toBe(0);
      expect(s.runOut().jsonOut).toBe("/tmp/e.json");
      expect(s.seen.ran).toBe(2);
    } finally { s.restore(); }
  });

  test("`--json-out` with NO path exits 2 and does NOT run — the H2 class exactly", async () => {
    // Without this it would fall through to a full generate + day-stamp and write no envelope, so the
    // caller would see a consumed morning and an empty file it was waiting for.
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "run", "--json-out"], s.deps)).toBe(2);
      expect(await dispatch(["bun", "bin", "run", "--json-out", "--force"], s.deps)).toBe(2);
      expect(s.seen.ran).toBe(0);
      expect(s.seen.err.join("\n")).toContain("--json-out needs a path");
    } finally { s.restore(); }
  });

  test("a traversal path exits 2 BEFORE run() is entered", async () => {
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "run", "--json-out", "../../etc/x"], s.deps)).toBe(2);
      expect(s.seen.ran).toBe(0);
      expect(s.seen.err.join("\n")).toContain("--json-out");
    } finally { s.restore(); }
  });

  // ── review MEDIUM #3 ─────────────────────────────────────────────────────────────────────────
  test("a --json-out target that collides with an engine state file exits 2 BEFORE run() is entered", async () => {
    const s = spy();
    try {
      for (const target of ["briefing.log", "last-run", "last-tick", "run.lock", "last-skip.json",
                            "briefing-latest.md", "account-state.json", "briefings", "briefings/2026-01-01.md",
                            // Slice 4's own state file, protected by EXISTING in statePaths() rather
                            // than by being remembered here — which is the property engineOwns claims.
                            "schedule.json",
                            // tier B's trial record, protected the same way (StatePaths.recapCampaignsPath)
                            "recap-campaigns.jsonl"]) {
        expect(`${target} → ${await dispatch(["bun", "bin", "run", "--json-out", target], s.deps)}`)
          .toBe(`${target} → 2`);
      }
      expect(s.seen.ran).toBe(0);                    // no tick, no provider call, no stamp
      expect(s.seen.err.join("\n")).toContain("--json-out");
    } finally { s.restore(); }
  });

  // ── review HIGH-2: a LEADING run-flag must never swallow a subcommand ────────────────────────
  //
  // `cmd` is argv[2] only when it does not start with `-`, so `--json status` routed to `run` and the
  // `status` token was discarded SILENTLY: a Schedule panel polling `daily-briefing --json status`
  // every few seconds performed a full pipeline run — provider call, briefing-latest.md, archive, day
  // stamp — and exited 0 with an envelope a status parser does not recognise. The first such poll of
  // the morning consumed the morning.
  test("a leading run-flag followed by a KNOWN subcommand REFUSES (exit 2) instead of running", async () => {
    const s = spy();
    try {
      const cases: string[][] = [
        ["--json", "status"], ["--json", "doctor"], ["--json", "init"], ["--json", "config", "validate"],
        ["--json", "run"], ["--json", "help"],
        ["--force", "status"], ["--force", "doctor"], ["-f", "status"], ["-f", "init"],
        ["--json-out", "/tmp/x.json", "status", "--json"],
        ["--json-out", "/tmp/x.json", "doctor", "--json"],
        ["--json-out", "/tmp/x.json", "config", "validate", "--json"],
        ["--json", "--json-out", "/tmp/x.json", "init"],
        ["--json-out", "status"],                 // the flag's own operand is scanned too — see below
        ["--force", "--json", "status", "--json"],
        ["run", "status"], ["run", "--json", "doctor"],   // the explicit-`run` spelling of the same trap
      ];
      for (const argv of cases) {
        expect(`${argv.join(" ")} → ${await dispatch(["bun", "bin", ...argv], s.deps)}`)
          .toBe(`${argv.join(" ")} → 2`);
      }
      // ⚠ THE POINT: nothing was executed on ANY of them.
      expect([s.seen.ran, s.seen.inited, s.seen.status, s.seen.doctor, s.seen.validated]).toEqual([0, 0, 0, 0, 0]);
      expect(s.seen.err.join("\n")).toContain("must come FIRST");
    } finally { s.restore(); }
  });

  test("…and the legitimate spellings still route exactly as before", async () => {
    const s = spy();
    const candidate = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cand-"))), "c.json");
    writeFileSync(candidate, JSON.stringify({ provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } }));
    try {
      // A subcommand FIRST is the supported form and is untouched.
      expect(await dispatch(["bun", "bin", "status", "--json"], s.deps)).toBe(0);
      expect(await dispatch(["bun", "bin", "doctor", "--json"], s.deps)).toBe(0);
      expect(await dispatch(["bun", "bin", "config", "validate", "--json", "--file", candidate], s.deps)).toBe(0);
      // Bare leading flags, and `run` with flags, still mean the default run.
      expect(await dispatch(["bun", "bin", "--json"], s.deps)).toBe(0);
      expect(await dispatch(["bun", "bin", "--json-out", "/tmp/e.json"], s.deps)).toBe(0);
      expect(await dispatch(["bun", "bin", "run", "--json", "--force"], s.deps)).toBe(0);
      // A PATH that merely contains a subcommand word is not a subcommand token.
      expect(await dispatch(["bun", "bin", "run", "--json-out", "/tmp/status"], s.deps)).toBe(0);
      expect(await dispatch(["bun", "bin", "run", "--json-out", "status.json"], s.deps)).toBe(0);
      expect([s.seen.ran, s.seen.status, s.seen.doctor, s.seen.validated]).toEqual([5, 1, 1, 1]);
      expect(s.seen.inited).toBe(0);
    } finally { s.restore(); }
  });

  test("an unknown leading flag is still refused — the new allowlist did not widen into a catch-all", async () => {
    const s = spy();
    try {
      for (const bad of ["--jsonn", "--json-o", "--frce", "-j"]) {
        expect(`${bad} → ${await dispatch(["bun", "bin", bad], s.deps)}`).toBe(`${bad} → 2`);
      }
      expect(s.seen.ran).toBe(0);
    } finally { s.restore(); }
  });
});

describe("init refuses run's flags", () => {
  test("`init --json` and `init --json-out x` exit 2 without invoking init()", async () => {
    // `init` WRITES a config and walks the home directory for repos. A caller that thought it was
    // asking for an envelope would get a side effect and no answer.
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "init", "--json"], s.deps)).toBe(2);
      expect(await dispatch(["bun", "bin", "init", "--json-out", "/tmp/e.json"], s.deps)).toBe(2);
      expect(s.seen.inited).toBe(0);
      expect(s.seen.ran).toBe(0);
      expect(s.seen.err.join("\n")).toContain("flags of `run`");
      // …and a plain `init` still works, so the guard did not swallow the command.
      expect(await dispatch(["bun", "bin", "init"], s.deps)).toBe(0);
      expect(s.seen.inited).toBe(1);
    } finally { s.restore(); }
  });
});

describe("the read-only subcommands", () => {
  test("`status --json` prints JSON, exits 0, and never touches run() or init()", async () => {
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "status", "--json"], s.deps)).toBe(0);
      expect(s.seen.status).toBe(1);
      expect([s.seen.ran, s.seen.inited]).toEqual([0, 0]);
      expect(JSON.parse(s.seen.out[0]!).schemaVersion).toBe(1);
    } finally { s.restore(); }
  });

  test("`doctor --json` prints JSON, exits 0, and never touches run() or init()", async () => {
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "doctor", "--json"], s.deps)).toBe(0);
      expect(s.seen.doctor).toBe(1);
      expect([s.seen.ran, s.seen.inited]).toEqual([0, 0]);
    } finally { s.restore(); }
  });

  test("`config validate --json --file <path>` prints JSON, exits 0, and never touches run() or init()", async () => {
    const s = spy();
    const candidate = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cand-"))), "candidate.json");
    writeFileSync(candidate, JSON.stringify({ provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } }));
    try {
      expect(await dispatch(["bun", "bin", "config", "validate", "--json", "--file", candidate], s.deps)).toBe(0);
      expect(s.seen.validated).toBe(1);
      expect([s.seen.ran, s.seen.inited]).toEqual([0, 0]);
      expect(JSON.parse(s.seen.out[0]!).valid).toBe(true);
    } finally { s.restore(); }
  });

  test("a CANDIDATE source is required — it never silently validates the installed config", async () => {
    // ⚠ Found by the redirected-HOME probe, not by reasoning: the first version defaulted to
    // `configPath()`, so the command's answer depended on $HOME and the test failed under a scratch
    // HOME. Beyond the flake it was the wrong question — the installed config's validity is what
    // `doctor --json` reports; this command exists for the config a Settings screen is about to WRITE.
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "config", "validate", "--json"], s.deps)).toBe(2);
      expect(s.seen.validated).toBe(0);
      expect(s.seen.err.join("\n")).toContain("--file");
      // …and a `--file` with no path is refused rather than swallowing the next flag.
      expect(await dispatch(["bun", "bin", "config", "validate", "--json", "--file"], s.deps)).toBe(2);
      expect(await dispatch(["bun", "bin", "config", "validate", "--json", "--file", "--stdin"], s.deps)).toBe(2);
      expect(s.seen.validated).toBe(0);
    } finally { s.restore(); }
  });

  test("an unreadable --file exits 2; a file that is not JSON is an INVALID CANDIDATE, exit 0", async () => {
    // The distinction the exit code carries: "I could not look" versus "I looked and it is wrong".
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cand-")));
    const notJson = join(dir, "broken.json");
    writeFileSync(notJson, "{ this is not json");
    const s = spy();
    try {
      expect(await dispatch(["bun", "bin", "config", "validate", "--json", "--file", join(dir, "absent.json")], s.deps)).toBe(2);
      expect(s.seen.validated).toBe(0);
      expect(await dispatch(["bun", "bin", "config", "validate", "--json", "--file", notJson], s.deps)).toBe(0);
      expect(s.seen.validated).toBe(1);
    } finally { s.restore(); }
  });

  test("--stdin reads the candidate from stdin — exercised in a real process, since a test cannot fake Bun.stdin", async () => {
    const entry = resolve(new URL("../src/main.ts", import.meta.url).pathname);
    const p = Bun.spawn(["bun", entry, "config", "validate", "--json", "--stdin"], {
      // Without `env` the child gets bun's STARTUP environment, not the isolated one this file's fixture
      // armed, and would resolve the REAL state and config dirs (isolation.meta.test.ts, scanner 6).
      env: { ...process.env },
      stdin: new TextEncoder().encode(JSON.stringify({ provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" }, morningTime: "99:99" })),
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    await p.exited;
    expect(`exit=${p.exitCode} stderr=${err}`).toBe(`exit=0 stderr=${err}`);
    const report = JSON.parse(out);
    expect(report.valid).toBe(true);                                  // a bad floor DEGRADES, never fails
    expect(report.warnings.map((w: { field: string }) => w.field)).toContain("morningTime");
  }, 20_000);

  test("each one REQUIRES --json rather than silently falling through to a briefing run", async () => {
    // The H2 shape again: the dangerous failure is not "exit 2", it is `status` reaching the default
    // `run` case and consuming the day.
    const s = spy();
    try {
      for (const argv of [["status"], ["doctor"], ["config", "validate", "--file", "/tmp/x.json"]]) {
        expect(`${argv.join(" ")} → ${await dispatch(["bun", "bin", ...argv], s.deps)}`).toBe(`${argv.join(" ")} → 2`);
      }
      expect([s.seen.ran, s.seen.inited, s.seen.status, s.seen.doctor, s.seen.validated]).toEqual([0, 0, 0, 0, 0]);
      expect(s.seen.err.join("\n")).toContain("--json is required");
    } finally { s.restore(); }
  });

  test("`config` with a missing or unknown sub-verb exits 2 and runs nothing", async () => {
    const s = spy();
    try {
      for (const argv of [["config"], ["config", "edit"], ["config", "--json"]]) {
        expect(`${argv.join(" ")} → ${await dispatch(["bun", "bin", ...argv], s.deps)}`).toBe(`${argv.join(" ")} → 2`);
      }
      expect([s.seen.ran, s.seen.validated]).toEqual([0, 0]);
    } finally { s.restore(); }
  });

  test("an unknown subcommand is STILL refused — the new cases did not become a catch-all", async () => {
    const s = spy();
    try {
      // ⚠ `schedule` was in this list until Slice 4, correctly — it was not a command then. It IS one
      // now (KNOWN_COMMANDS + its own dispatch arm), so keeping it here would assert the opposite of
      // what the binary does. Its own refusal cases live in test/dispatch.schedule.test.ts.
      for (const bad of ["statuss", "doctorr", "validate", "scheduled"]) {
        expect(`${bad} → ${await dispatch(["bun", "bin", bad, "--json"], s.deps)}`).toBe(`${bad} → 2`);
      }
      expect(s.seen.ran).toBe(0);
    } finally { s.restore(); }
  });
});

test("--help documents every new flag and subcommand", async () => {
  // A surface the desktop shell is built against is not discoverable unless `--help` says it exists.
  const s = spy();
  try {
    expect(await dispatch(["bun", "bin", "--help"], s.deps)).toBe(0);
    const help = s.seen.out.join("\n");
    for (const needle of ["--json", "--json-out", "status --json", "doctor --json", "config validate --json"]) {
      expect(`help mentions ${needle}: ${help.includes(needle)}`).toBe(`help mentions ${needle}: true`);
    }
    expect(s.seen.ran).toBe(0);
  } finally { s.restore(); }
});
