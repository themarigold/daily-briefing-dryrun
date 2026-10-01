import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// gui-tauri T2/T3/T4 — `status --json`, `doctor --json`, `config validate --json`.
//
// All three are READ-ONLY surfaces the desktop shell polls. The assertions that matter are therefore
// negative ones: status creates and modifies ZERO files (its one trap is `checkRanToday`, which
// REPAIRS, i.e. writes); doctor never generates and never stamps; config validate is the SAME
// validator `loadConfig` uses, pinned by a shared fixture so the two cannot drift.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  statusReport, doctorReport, validateCandidate, parseTickLine, statePaths, SKIP_REASONS,
  type DoctorDeps,
} from "../src/json";
import { loadConfig } from "../src/config";
import { DEFAULT_MORNING_TIME } from "../src/schedule";
import type { Config } from "../src/types";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const PROV = { cli: "claude", argv: ["-p"], promptVia: "stdin" as const };

function withEnv(cfgObj?: unknown): { stateDir: string; cfgHome: string; cleanup: () => void } {
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cfg-")));
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-state-")));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  if (cfgObj !== undefined) {
    writeFileSync(join(cfgHome, "daily-briefing", "config.json"),
      typeof cfgObj === "string" ? cfgObj : JSON.stringify(cfgObj));
  }
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  // ⚠ CLAUDE_CONFIG_DIR too, saved and restored like the other two. `resolveAccounts` warns whenever
  // it is set (config.ts:357) because the variable ALSO resolves the transcript scan root — so an
  // author whose shell exports it would see every `verdict: "ready"` assertion below flip to
  // "degraded" for a reason that has nothing to do with the code under test.
  const prevClaude = process.env.CLAUDE_CONFIG_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  delete process.env.CLAUDE_CONFIG_DIR;
  return {
    stateDir, cfgHome,
    cleanup: () => {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
      if (prevClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = prevClaude;
    },
  };
}

/** Every entry under `dir`, recursively, as `path → mtimeMs:size`. A missing directory is an EMPTY
 *  snapshot rather than a throw, so "the call must not CREATE the state dir" is expressible. */
async function snapshot(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (d: string, prefix: string): Promise<void> => {
    let names: string[];
    try { names = await readdir(d); } catch { return; }
    for (const n of names.sort()) {
      const p = join(d, n);
      const s = statSync(p);
      out[`${prefix}${n}`] = `${s.mtimeMs}:${s.size}`;
      if (s.isDirectory()) await walk(p, `${prefix}${n}/`);
    }
  };
  await walk(dir, "");
  return out;
}

// ── T2: status --json ────────────────────────────────────────────────────────────────────────────

describe("status --json", () => {
  test("an ABSENT state dir reports nulls, and does not create the directory", async () => {
    const env = withEnv();
    const ghost = join(env.stateDir, "not-created-yet");
    process.env.DAILY_BRIEFING_STATE_DIR = ghost;
    try {
      const s = await statusReport();
      expect(existsSync(ghost)).toBe(false);          // the read created nothing
      expect(s.lastRunDate).toBeNull();
      expect(s.lastTick).toBeNull();
      expect(s.latestBriefingMtime).toBeNull();
      expect(s.logBytes).toBeNull();
      expect(s.archivedDates).toEqual([]);
      expect(s.paths.stateDir).toBe(ghost);
      expect(s.lastSkip).toBeNull();
    } finally { env.cleanup(); }
  });

  // ── review LOW #5 / LOW #14 ──────────────────────────────────────────────────────────────────
  test("the reported morningTime default is the ENGINE's, not a second literal", async () => {
    // `minutes` comes from parseFloor (which derives from DEFAULT_MORNING_TIME) while `value` used to
    // carry its own "07:20". They agree today, so nothing could fail — until the constant changes and
    // the SAME object goes internally inconsistent: `value` the old default, `minutes` the new one.
    const env = withEnv({ repos: [], provider: PROV });          // no morningTime configured
    try {
      const s = await statusReport({ now: () => new Date(2026, 8, 14, 9, 0) });
      const [h, m] = DEFAULT_MORNING_TIME.split(":").map(Number);
      expect(s.morningTime.value).toBe(DEFAULT_MORNING_TIME);
      expect(s.morningTime.minutes).toBe(h! * 60 + m!);          // the two halves cannot drift apart
    } finally { env.cleanup(); }
  });

  test("the last-skip record is CARRIED, not just located — and a corrupt one reads as null", async () => {
    // `readLastSkip` had no src/ caller at all; status exposed only `paths.lastSkipPath`, i.e. it told
    // the shell to open and parse a second file and re-implement the corrupt-record tolerance that
    // already exists. This is the surface whose stated job is "did the run decline, and why".
    const env = withEnv({ repos: [], provider: PROV });
    try {
      const rec = { iso: "2026-09-14T15:00:00.000Z", localDate: "2026-09-14", reason: "offline", detail: "no network after ~25s" };
      writeFileSync(join(env.stateDir, "last-skip.json"), `${JSON.stringify(rec)}\n`);
      expect((await statusReport()).lastSkip).toEqual(rec);
      writeFileSync(join(env.stateDir, "last-skip.json"), "{ half-written");
      expect((await statusReport()).lastSkip).toBeNull();        // total read: corrupt ⇒ null, never a throw
    } finally { env.cleanup(); }
  });

  test("a populated state dir reports every field as written", async () => {
    const env = withEnv({ repos: [], provider: PROV, morningTime: "06:45" });
    try {
      writeFileSync(join(env.stateDir, "last-run"), "2026-09-13");
      writeFileSync(join(env.stateDir, "last-tick"), "2026-09-14T14:46:58.223Z local=2026-09-14 today=6\n");
      writeFileSync(join(env.stateDir, "briefing-latest.md"), "☀️  briefing — 2026-09-13\n");
      writeFileSync(join(env.stateDir, "briefing.log"), "x".repeat(321));
      mkdirSync(join(env.stateDir, "briefings"), { recursive: true });
      writeFileSync(join(env.stateDir, "briefings", "2026-09-13.md"), "b");
      writeFileSync(join(env.stateDir, "briefings", "2026-09-12.md"), "b");
      writeFileSync(join(env.stateDir, "briefings", "notes.md"), "not a dated archive");

      const s = await statusReport({ now: () => new Date(2026, 8, 14, 9, 0) });
      expect(s.schemaVersion).toBe(1);
      expect(s.lastRunDate).toBe("2026-09-13");
      expect(s.lastTick).toEqual({ iso: "2026-09-14T14:46:58.223Z", localDate: "2026-09-14", count: 6 });
      expect(s.archivedDates).toEqual(["2026-09-12", "2026-09-13"]);   // sorted, and `notes.md` excluded
      expect(s.logBytes).toBe(321);
      expect(s.latestBriefingMtime).not.toBeNull();
      expect(s.configExists).toBe(true);
      expect(s.configError).toBeNull();
      expect(s.morningTime).toEqual({ value: "06:45", minutes: 6 * 60 + 45, warning: null });
      expect(s.isPastFloor).toBe(true);
      // ADDITIVE beyond the task spec, and the reason is version SKEW between a bundled engine and a
      // separately-installed managed copy — a state the Schedule panel has to be able to show.
      expect(s.engineVersion).toMatch(/^\d+\.\d+\.\d+/);
      expect(s.platform).toBe(process.platform);
    } finally { env.cleanup(); }
  });

  test("statePaths are reported so nothing downstream reimplements stateDirFor", async () => {
    const env = withEnv({ repos: [], provider: PROV });
    try {
      const s = await statusReport();
      expect(s.paths).toEqual(statePaths());
      // Every path must sit under the state dir except the config, which has its own XDG rule.
      for (const [k, v] of Object.entries(s.paths)) {
        if (k === "stateDir" || k === "configPath") continue;
        expect(`${k}:${v.startsWith(env.stateDir)}`).toBe(`${k}:true`);
      }
      expect(s.paths.configPath.startsWith(env.cfgHome)).toBe(true);
    } finally { env.cleanup(); }
  });

  test("a LEGACY tick line without `local=` reads as no tick, and does not throw", async () => {
    // The pre-day-35 format. `stampTick`'s own reset branch treats it as unparseable; a status
    // surface that threw on it would take the GUI down on a machine that had merely been upgraded.
    const env = withEnv({ repos: [], provider: PROV });
    try {
      writeFileSync(join(env.stateDir, "last-tick"), "2026-08-19T00:00:00.000Z today=4\n");
      expect((await statusReport()).lastTick).toBeNull();
    } finally { env.cleanup(); }
    expect(parseTickLine("garbage")).toBeNull();
    expect(parseTickLine("2026-09-14T00:00:00Z local=2026-09-14 today=2")).toEqual({
      iso: "2026-09-14T00:00:00Z", localDate: "2026-09-14", count: 2,
    });
  });

  test("an UNREADABLE marker reads as null and is NEVER repaired — status must not mutate", async () => {
    // The one trap in this surface: `checkRanToday` (marker.ts:200) unlinks and rewrites an
    // unreadable marker. A polled repair is a write loop, so status reads the file directly.
    const env = withEnv({ repos: [], provider: PROV });
    try {
      writeFileSync(join(env.stateDir, "last-run"), "not-a-date");
      const before = await snapshot(env.stateDir);
      const s = await statusReport();
      expect(s.lastRunDate).toBeNull();
      expect(await snapshot(env.stateDir)).toEqual(before);
    } finally { env.cleanup(); }
  });

  test("a MALFORMED config is reported as an error rather than silently defaulting morningTime", async () => {
    const env = withEnv({ morningTime: "06:00" });   // no `provider` ⇒ validateConfig throws
    try {
      const s = await statusReport();
      expect(s.configExists).toBe(true);
      expect(s.configError).toContain("provider");
      // The floor falls back, but `configError` is what stops the GUI reporting 07:20 as configured.
      expect(s.morningTime.minutes).toBe(7 * 60 + 20);
    } finally { env.cleanup(); }
  });

  test("status creates and modifies ZERO files — snapshot before and after", async () => {
    const env = withEnv({ repos: [], provider: PROV, morningTime: "07:20" });
    try {
      writeFileSync(join(env.stateDir, "last-run"), "2026-09-13");
      writeFileSync(join(env.stateDir, "last-tick"), "2026-09-14T14:46:58.223Z local=2026-09-14 today=6\n");
      mkdirSync(join(env.stateDir, "briefings"), { recursive: true });
      writeFileSync(join(env.stateDir, "briefings", "2026-09-13.md"), "b");
      const before = await snapshot(env.stateDir);
      const beforeCfg = await snapshot(env.cfgHome);
      await statusReport();
      await statusReport();          // twice: a first call that CREATED something would show here too
      expect(await snapshot(env.stateDir)).toEqual(before);
      expect(await snapshot(env.cfgHome)).toEqual(beforeCfg);
      expect(Object.keys(before).length).toBeGreaterThan(0);   // non-vacuous: the snapshot sees files
    } finally { env.cleanup(); }
  });
});

// ── T3: doctor --json ────────────────────────────────────────────────────────────────────────────

/** Injected seams that keep doctor off the network, off `pmset` and off a real `--help` spawn. */
const OFFLINE_DEPS: DoctorDeps = {
  netProbe: async () => true,
  powerPlatform: "linux",                     // isFullyAwake fails open off darwin — no pmset spawn
  which: async () => "/usr/local/bin/claude",
  capabilities: async () => ({ kind: "ok", supported: new Set(["--tools", "--setting-sources", "--strict-mcp-config", "--no-session-persistence"]) }),
  preflight: async () => [],
  discover: async () => ({ repos: ["/r1", "/r2"], issues: [] }),
};

describe("doctor --json", () => {
  test("a healthy machine: verdict ready, flags reported, nothing written", async () => {
    const env = withEnv({ repos: ["/r1", "/r2"], provider: PROV });
    try {
      const before = await snapshot(env.stateDir);
      const d = await doctorReport(OFFLINE_DEPS);
      expect(d.verdict).toBe("ready");
      expect(d.provider.found).toBe(true);
      expect(d.provider.hardeningAvailable).toBe(true);
      expect(d.provider.flags).toContain("--tools");
      expect(d.provider.anomalies).toEqual([]);
      expect(d.discoveredCount).toBe(2);
      expect(d.repos.every((r) => r.ok)).toBe(true);
      expect(await snapshot(env.stateDir)).toEqual(before);   // never stamps, never writes
    } finally { env.cleanup(); }
  });

  test("a TCC-denied ~/Desktop repo yields the advice text and verdict 'blocked'", async () => {
    const env = withEnv({ repos: ["/Users/me/Desktop/repo"], provider: PROV });
    try {
      const d = await doctorReport({
        ...OFFLINE_DEPS,
        preflight: async () => [{ path: "/Users/me/Desktop/repo", kind: "tcc-denied", protectedRoot: "/Users/me/Desktop" }],
        discover: async () => ({ repos: [], issues: [] }),
      });
      const row = d.repos.find((r) => r.path === "/Users/me/Desktop/repo")!;
      expect(row.ok).toBe(false);
      expect(row.issueKind).toBe("tcc-denied");
      // The SAME sentence the CLI prints — `warnFor`, not a second copy of the wording.
      expect(row.advice).toContain("System Settings → Privacy & Security");
      expect(d.verdict).toBe("blocked");
    } finally { env.cleanup(); }
  });

  test("a missing provider binary: found false, verdict blocked, and the call still succeeds", async () => {
    // doctor REPORTS a problem, it never becomes one — `dispatch` returns 0 regardless of verdict.
    const env = withEnv({ repos: [], provider: { ...PROV, cli: "definitely-not-installed" } });
    try {
      const d = await doctorReport({ ...OFFLINE_DEPS, which: async () => undefined });
      expect(d.provider.found).toBe(false);
      expect(d.provider.path).toBeNull();
      expect(d.provider.hardeningAvailable).toBe(false);
      expect(d.verdict).toBe("blocked");
    } finally { env.cleanup(); }
  });

  test("EMPTY networkProbeHosts is reported as DISABLED, not as unreachable", async () => {
    // `[]` is the documented skip switch (net.ts:29) for a local/offline provider. Reporting it as a
    // fault would hand that user a permanent red light they cannot clear.
    const env = withEnv({ repos: [], provider: PROV, networkProbeHosts: [] });
    let probed = 0;
    try {
      const d = await doctorReport({ ...OFFLINE_DEPS, netProbe: async () => { probed++; return true; } });
      expect(d.network).toEqual({ hostsConfigured: 0, enabled: false, reachable: false, waitedMs: 0 });
      expect(probed).toBe(0);                 // disabled means NOT probed, not probed-and-failed
      expect(d.verdict).toBe("ready");        // …and it is not a degradation either
    } finally { env.cleanup(); }
  });

  test("an unreachable configured network degrades, it does not block", async () => {
    const env = withEnv({ repos: [], provider: PROV });
    try {
      const d = await doctorReport({ ...OFFLINE_DEPS, netProbe: async () => false });
      expect(d.network.enabled).toBe(true);
      expect(d.network.reachable).toBe(false);
      expect(d.verdict).toBe("degraded");
    } finally { env.cleanup(); }
  });

  test("a probe anomaly is surfaced and degrades; a non-claude CLI is named, not called a malfunction", async () => {
    const env = withEnv({ repos: [], provider: PROV });
    try {
      const d = await doctorReport({ ...OFFLINE_DEPS, capabilities: async () => ({ kind: "anomaly", reason: "`claude --help` exited 3" }) });
      expect(d.provider.anomalies).toEqual(["`claude --help` exited 3"]);
      expect(d.verdict).toBe("degraded");
    } finally { env.cleanup(); }

    const env2 = withEnv({ repos: [], provider: { ...PROV, cli: "codex" } });
    try {
      const d = await doctorReport({ ...OFFLINE_DEPS, which: async () => "/usr/local/bin/codex" });
      expect(d.provider.hardeningAvailable).toBe(false);
      expect(d.provider.anomalies.join(" ")).toContain("not recognised as the claude CLI");
      expect(d.verdict).toBe("degraded");
    } finally { env2.cleanup(); }
  });

  test("a slow repo walk is BOUNDED, and its incompleteness is reported rather than hidden", async () => {
    // `preflightRepos` descends discoverRoots; on a big home directory that is slow. A short list
    // that merely LOOKED complete would be the dangerous outcome, so the flag is asserted.
    const env = withEnv({ discoverRoots: ["/"], provider: PROV });
    try {
      const d = await doctorReport({
        ...OFFLINE_DEPS,
        preflight: () => new Promise(() => {}),     // never settles
        discover: () => new Promise(() => {}),
        walkMs: 20,
      });
      expect(d.reposTimedOut).toBe(true);
      expect(d.repos).toEqual([]);
      expect(d.verdict).toBe("degraded");
    } finally { env.cleanup(); }
  });

  test("the REAL repo walk runs — no injected preflight, no module cycle, no 20-second deadline", async () => {
    // ⚠ REGRESSION GUARD, written against a measured bug rather than a hypothesis. The first version
    // reached `preflightRepos` through `await import("./main")` to dodge a static cycle; when main.ts
    // is the process ENTRY its top-level `await dispatch(...)` has not finished, so that import never
    // settles. MEASURED: `bun src/main.ts doctor --json` took 20.04 s and returned
    // `reposTimedOut: true`, rescued only by doctor's own deadline. Every other doctor test injects
    // `preflight`, so none of them could see it — the default path needs its own test.
    const env = withEnv({ repos: [], discoverRoots: [], provider: PROV });
    try {
      const started = Date.now();
      const d = await doctorReport({ ...OFFLINE_DEPS, preflight: undefined, discover: undefined, walkMs: 5_000 });
      expect(`reposTimedOut=${d.reposTimedOut}`).toBe("reposTimedOut=false");
      expect(Date.now() - started).toBeLessThan(4_000);
    } finally { env.cleanup(); }
  }, 20_000);

  test("`doctor --json` in a REAL process finishes fast — the entry-point half the in-process test cannot reach", async () => {
    // The cycle only exists when main.ts is the entry, which no in-process test reproduces.
    const env = withEnv({ repos: [], discoverRoots: [], provider: { cli: "definitely-not-installed", argv: [], promptVia: "stdin" }, networkProbeHosts: [] });
    try {
      const entry = resolve(new URL("../src/main.ts", import.meta.url).pathname);
      const started = Date.now();
      const p = Bun.spawn(["bun", entry, "doctor", "--json"], {
        env: { ...process.env, XDG_CONFIG_HOME: env.cfgHome, DAILY_BRIEFING_STATE_DIR: env.stateDir },
        stdout: "pipe", stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      expect(`exit=${p.exitCode} stderr=${err}`).toBe(`exit=0 stderr=${err}`);
      const d = JSON.parse(out);
      expect(`reposTimedOut=${d.reposTimedOut}`).toBe("reposTimedOut=false");
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(d.verdict).toBe("blocked");      // the provider is genuinely absent
      // …and it wrote nothing: the state dir holds only what this test put there (nothing).
      expect(await snapshot(env.stateDir)).toEqual({});
    } finally { env.cleanup(); }
  }, 30_000);

  test("doctor constructs no provider and calls no generate — enforced against the SOURCE", async () => {
    // A runtime assertion could only prove that THIS path did not generate. The claim is stronger:
    // the module has no way to. Same shape as posture.test.ts's structural guards.
    const src = await Bun.file(new URL("../src/json.ts", import.meta.url)).text();
    const offenders = [/hardenedProvider\s*\(/, /\.generate\s*\(/, /stampToday\s*\(/, /checkRanToday\s*\(/]
      .filter((re) => re.test(src))
      .map((re) => `src/json.ts matches ${re} — the read-only contract is broken`);
    expect(offenders).toEqual([]);
    // Non-vacuous: the same scan over the SHELL, which legitimately does all four, must find them.
    const shell = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();
    expect([/stampToday\s*\(/, /checkRanToday\s*\(/].every((re) => re.test(shell))).toBe(true);
  });
});

// ── T4: config validate --json ───────────────────────────────────────────────────────────────────

/** The known degradation cases, as ONE table read by both assertions below — the wrapper's answer and
 *  `loadConfig`'s answer for the same input. A shared fixture is the only thing that can stop the two
 *  drifting, because they are two call sites of one validator with different failure surfaces. */
const CASES: { name: string; raw: unknown; valid: boolean; warns?: string; errField?: string }[] = [
  { name: "a complete config", raw: { repos: [], provider: PROV }, valid: true },
  // schedule.ts:19-21 degrades a bad floor to 07:20 + a warning ON PURPOSE — never an error, or a
  // typo'd time would cost every morning until someone noticed.
  { name: "invalid morningTime degrades with a warning", raw: { provider: PROV, morningTime: "25:99" }, valid: true, warns: "morningTime" },
  { name: "a malformed transcripts block warns and disables", raw: { provider: PROV, transcripts: "yes" }, valid: true, warns: "transcripts" },
  { name: "malformed networkProbeHosts falls back to the defaults", raw: { provider: PROV, networkProbeHosts: "1.1.1.1" }, valid: true, warns: "networkProbeHosts" },
  { name: "an uncompilable exclude pattern warns, it is not fatal", raw: { provider: PROV, excludeCommitPatterns: ["("] }, valid: true, warns: "excludeCommitPatterns" },
  { name: "a missing provider is an ERROR", raw: { repos: [] }, valid: false, errField: "provider" },
  { name: 'lookbackCapDays: "4" (a string) is an ERROR', raw: { provider: PROV, lookbackCapDays: "4" }, valid: false, errField: "lookbackCapDays" },
  { name: "a non-object config is an ERROR", raw: 42, valid: false },
  { name: "author.emails as a bare string is an ERROR", raw: { provider: PROV, author: { emails: "me@x.com" } }, valid: false, errField: "author.emails" },
];

// ── review MEDIUM #4: a SYNTAX error must be named as one ────────────────────────────────────────
describe("doctor --json names the config's REAL problem", () => {
  test("a trailing comma is reported as the parse error it is — and doctor now AGREES with status", async () => {
    // The commonest config breakage there is. `doctorReport` used to read the file with
    // `.json().catch(() => undefined)` and feed `undefined` to validateCandidate, which then reported
    // "the config is not a JSON object" with an EMPTY `field` — the wrong cause, from the one surface
    // whose entire purpose is diagnosis, and a Settings screen highlighting errors[0].field would
    // highlight nothing. Meanwhile `status --json`, which reads through loadConfig, reported the truth.
    const env = withEnv(`{ "repos": ["/tmp/x"],\n}`);
    try {
      const d = await doctorReport(OFFLINE_DEPS);
      const s = await statusReport();
      expect(d.config.exists).toBe(true);
      expect(d.config.valid).toBe(false);
      expect(d.config.errors.length).toBe(1);
      // The file IS a JSON object; it has a syntax error. So the message must not claim otherwise.
      expect(d.config.errors[0]!.message).not.toContain("not a JSON object");
      // ⚠ THE AGREEMENT, which is the real property: two surfaces the same GUI polls, one file.
      expect(`doctor: ${d.config.errors[0]!.message} | status: ${s.configError}`)
        .toBe(`doctor: ${s.configError} | status: ${s.configError}`);
      expect(s.configExists).toBe(true);
      expect(d.verdict).toBe("blocked");        // unchanged: an unparseable config still blocks
    } finally { env.cleanup(); }
  });

  test("a config that parses but is not an object still says exactly that", async () => {
    // The counter-case, so the fix above did not just relabel every config problem as a parse error.
    const env = withEnv(`42`);
    try {
      const d = await doctorReport(OFFLINE_DEPS);
      expect(d.config.valid).toBe(false);
      expect(d.config.errors[0]!.message).toContain("not a JSON object");
    } finally { env.cleanup(); }
  });
});

describe("config validate --json", () => {
  test.each(CASES.map((c) => [c.name, c] as const))("%s", async (_name, c) => {
    const r = validateCandidate(c.raw, "/home/me", {});
    expect(`${c.name}: valid=${r.valid}`).toBe(`${c.name}: valid=${c.valid}`);
    if (c.errField) expect(r.errors[0]!.field).toBe(c.errField);
    if (c.valid) {
      expect(r.errors).toEqual([]);
      expect(r.normalized).not.toBeNull();
    } else {
      expect(r.normalized).toBeNull();
      expect(r.errors.length).toBe(1);
    }
    if (c.warns) expect(r.warnings.map((w) => w.field)).toContain(c.warns);
  });

  test("the wrapper and loadConfig agree on EVERY case — the shared fixture that stops them drifting", async () => {
    for (const c of CASES) {
      const env = withEnv(c.raw);
      try {
        const report = validateCandidate(c.raw, "/home/me", {});
        let loadThrew: string | null = null;
        try { await loadConfig(); } catch (e) { loadThrew = e instanceof Error ? e.message : String(e); }
        expect(`${c.name}: wrapper=${report.valid} load=${loadThrew === null}`)
          .toBe(`${c.name}: wrapper=${report.valid} load=${report.valid}`);
        // …and when both reject, they reject with the SAME sentence, not merely both-reject.
        if (!report.valid) expect(loadThrew).toBe(report.errors[0]!.message);
      } finally { env.cleanup(); }
    }
  });

  test("normalized carries the ~-expansion the pipeline would see", async () => {
    const r = validateCandidate({ provider: PROV, repos: ["~/code/x"], discoverRoots: ["~"] }, "/home/me", {});
    expect((r.normalized as Config).repos).toEqual(["/home/me/code/x"]);
    expect((r.normalized as Config).discoverRoots).toEqual(["/home/me"]);
  });

  test("validity is the PAYLOAD, never an exception — validateCandidate is total", () => {
    for (const hostile of [undefined, null, [], "", 0, { provider: null }, { provider: { cli: 1 } }]) {
      expect(() => validateCandidate(hostile, "/home/me", {})).not.toThrow();
      expect(validateCandidate(hostile, "/home/me", {}).valid).toBe(false);
    }
  });
});

// ── the closed skip vocabulary ───────────────────────────────────────────────────────────────────

test("SKIP_REASONS covers every non-delivering return in run(), and nothing else", async () => {
  // The vocabulary is what a GUI switches on, so a reason invented at one return site is a silent
  // gap in that switch. This reads main.ts's SOURCE: every `skip("x", …)` / `reason: "x"` literal in
  // the shell must be a member, and every member must be reachable from the shell.
  const src = await Bun.file(new URL("../src/main.ts", import.meta.url)).text();
  const used = new Set<string>();
  // Scoped to the ARGUMENTS of `skip(...)`, not to the whole file: one reason reaches it through a
  // ternary (`noConfig ? "no-config" : "config-error"`), and a bare ternary scan instead swept up
  // `interactive ? "cli" : "scheduled"` — the lock's invoker, which is not a skip reason at all.
  // A bare-word literal is only a candidate here; a detail string has spaces and cannot match.
  for (const call of src.matchAll(/skip\(([^)]*)\)/g)) {
    for (const q of call[1]!.matchAll(/"([a-z-]+)"/g)) used.add(q[1]!);
  }
  for (const m of src.matchAll(/reason:\s*"([a-z-]+)"/g)) used.add(m[1]!);
  // A floor, so a regex that silently stops matching fails loudly instead of passing vacuously.
  expect(used.size).toBeGreaterThanOrEqual(9);
  expect([...used].filter((u) => !(SKIP_REASONS as readonly string[]).includes(u))).toEqual([]);

  // ── review LOW #12: the OTHER direction, which this test's title claimed and never checked ────
  //
  // Everything above scrapes reason LITERALS and asserts each is a member. It never enumerates
  // run()'s RETURN STATEMENTS, so a future non-delivering `return 0;` that writes no record at all
  // was invisible to it — precisely the failure mode a closed vocabulary exists to prevent. The
  // shipped instance of exactly that was the rethrown non-ProviderError, which left neither a
  // last-skip entry nor an envelope, making a crash indistinguishable from "the scheduler never ran".
  const start = src.indexOf("export async function run(");
  const end = src.indexOf("export async function init(");
  expect(`run() body located: ${start > 0 && end > start}`).toBe("run() body located: true");
  const body = src.slice(start, end);
  // A bare numeric return is the shape that carries no envelope and no record.
  expect([...body.matchAll(/\breturn\s+-?\d+\s*;/g)].map((m) => m[0])).toEqual([]);
  // …and what remains is emit-shaped. A floor, so a regex that stops matching fails loudly.
  const emitting = [...body.matchAll(/\breturn\s+(?:await\s+)?(?:skip|emit)\(/g)];
  expect(emitting.length).toBeGreaterThanOrEqual(11);
  // The three the shell reads off CoreResult rather than writing as a literal.
  for (const fromPipeline of ["offline", "darkwake", "limited"]) {
    expect(`${fromPipeline} in SKIP_REASONS`).toBe(
      (SKIP_REASONS as readonly string[]).includes(fromPipeline) ? `${fromPipeline} in SKIP_REASONS` : "MISSING");
  }
});
