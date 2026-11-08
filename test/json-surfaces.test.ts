import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// gui-tauri T2/T3/T4 — `status --json`, `doctor --json`, `config validate --json`.
//
// All three are READ-ONLY surfaces the desktop shell polls. The assertions that matter are therefore
// negative ones: status creates and modifies ZERO files (its one trap is `checkRanToday`, which
// REPAIRS, i.e. writes); doctor never generates and never stamps; config validate is the SAME
// validator `loadConfig` uses, pinned by a shared fixture so the two cannot drift.
import { test, expect, describe, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, statSync, existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  statusReport, doctorReport, validateCandidate, parseTickLine, statePaths, SKIP_REASONS, PARTIAL_CLONE_NOTE,
  type DoctorDeps,
} from "../src/json";
import { loadConfig } from "../src/config";
import { REPO_SCAN_CONCURRENCY } from "../src/extractor";
import { DEFAULT_MORNING_TIME, parseFloor } from "../src/schedule";
import { REDACTION } from "../src/transcripts/credentials";
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

  // Round-2 harden (D-M1, a round-1 REGRESSION): `loadConfig` deliberately does not validate
  // `morningTime` (config.ts — `parseFloor` degrades a bad one), so a hand-edited NON-STRING reaches
  // `statusReport`, whose redaction of `value` called `.replace` on it and threw — `status --json`
  // crashed where it used to report the value and a warning. `value` stays a STRING (its declared type):
  // the JSON spelling of what the file holds.
  test("a NON-STRING morningTime is reported as its JSON spelling, with the warning — never a throw", async () => {
    for (const [mt, shown] of [[720, "720"], [true, "true"], [{}, "{}"], [[], "[]"]] as const) {
      const env = withEnv({ repos: [], provider: PROV, morningTime: mt });
      try {
        const s = await statusReport();
        expect(s.configError).toBeNull();                         // PREMISE: loadConfig accepted it
        expect(s.morningTime).toEqual({
          value: shown,
          minutes: parseFloor(DEFAULT_MORNING_TIME).minutes,
          warning: `invalid morningTime ${shown} — using the default ${DEFAULT_MORNING_TIME}`,
        });
        const d = await doctorReport(OFFLINE_DEPS);               // the other config-echo surface, same file
        expect(d.config.valid).toBe(true);
        expect(d.config.warnings.map((w) => w.field)).toContain("morningTime");
      } finally { env.cleanup(); }
    }
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

  // Known item 1 ("A+", user-approved): doctor NAMES a partial clone, with one note, from a read-only
  // `git config` — real fixture repos, so the detection itself is exercised, not a stand-in.
  test("a PARTIAL clone is named with a note — by remote.<name>.promisor or by extensions.partialClone — and the verdict is untouched", async () => {
    const { buildRepo } = await import("./fixtures/build-repo");
    const day = new Date(Date.now() - 864e5).toISOString();
    const [plain, promisor, ext, bare, falsy, two, zero] = await Promise.all([0, 1, 2, 3, 4, 5, 6].map(() => buildRepo([{ file: "a.txt", content: "a", isoDate: day }])));
    const git = async (repo: string, ...args: string[]) => {
      const p = Bun.spawn(["git", "-C", repo, ...args], { stdout: "ignore", stderr: "pipe" });
      if ((await p.exited) !== 0) throw new Error(`git ${args.join(" ")}: ${await new Response(p.stderr).text()}`);
    };
    await git(promisor!, "config", "remote.origin.url", "https://example.invalid/r.git");
    await git(promisor!, "config", "remote.origin.promisor", "true");
    await git(ext!, "config", "extensions.partialClone", "origin");
    // A bare boolean key — `[remote "origin"]\n\tpromisor` with no `=` — is TRUE to git, and must be here.
    await Bun.write(join(bare!, ".git", "config"), (await Bun.file(join(bare!, ".git", "config")).text()) + `[remote "upstream"]\n\tpromisor\n`);
    await git(falsy!, "config", "remote.origin.promisor", "false");
    // Round-2 harden (gpt R7): git reads ANY nonzero integer as true and 0 as false — its own boolean
    // parser decides, not a list of spellings (`true/yes/on/1` missed `promisor=2`).
    await git(two!, "config", "remote.origin.promisor", "2");
    await git(zero!, "config", "remote.origin.promisor", "0");
    const env = withEnv({ repos: [plain, promisor, ext, bare, falsy, two, zero], provider: PROV });
    try {
      const d = await doctorReport({ ...OFFLINE_DEPS, discover: async () => ({ repos: [plain!, promisor!, ext!, bare!, falsy!, two!, zero!], issues: [] }) });
      const row = (p: string) => d.repos.find((r) => r.path === p)!;
      for (const p of [promisor!, ext!, bare!, two!]) {
        expect({ p, partialClone: row(p).partialClone, notes: row(p).notes }).toEqual({ p, partialClone: true, notes: [PARTIAL_CLONE_NOTE] });
        expect(row(p).ok).toBe(true);                            // a fact, not a fault
      }
      for (const p of [plain!, falsy!, zero!]) {
        expect({ p, keys: Object.keys(row(p)).sort() }).toEqual({ p, keys: ["advice", "issueKind", "ok", "path"] });   // the pre-existing shape, unchanged
      }
      expect(d.verdict).toBe("ready");
      expect(PARTIAL_CLONE_NOTE).toContain("own remote");
      expect(JSON.stringify(d)).not.toContain("example.invalid");   // the note never carries a remote URL
    } finally { env.cleanup(); }
  });

  // Round-3 harden G3-3, corrected in round 4 (A4-L1 / B4-L1). `--get-regexp` lists OVERRIDDEN values
  // too, and the three keys resolve differently in git — each expectation below was measured on git
  // 2.50.1 by whether git lazily fetches a missing object from a local `file://` remote (src/git.ts
  // `isPartialClone`). An `include.path` file is read where it sits, BEFORE (`earlier`) or AFTER
  // (`later`) the repo's own section — for the two `remote.*` keys. NOT for `extensions.partialClone`:
  // git honours that key from the repository's own config file only and never follows an include for
  // it (round 3 wrongly took an include to stand in for an earlier level there), so an included value
  // of it is IGNORED, whichever side it sits on.
  test("partial-clone keys resolve as git resolves them: extensions.partialClone repo-own LAST value; remote.*.promisor ANY true; remote.*.partialclonefilter ANY", async () => {
    const { buildRepo } = await import("./fixtures/build-repo");
    const day = new Date(Date.now() - 864e5).toISOString();
    const [extIncludedOriginOwnEmpty, extIncludedEmptyOwnOrigin, extOwnOriginLaterIncludedEmpty, extIncludedOnly,
      extOwnLastEmpty, extOwnLastOrigin, promisorOverridden, promisorSameFile, promisorLaterTrue,
      filterOnly, filterBesidePromisorFalse, filterIncludedOnly] =
      await Promise.all(Array.from({ length: 12 }, () => buildRepo([{ file: "a.txt", content: "a", isoDate: day }])));
    const append = async (repo: string, text: string) =>
      Bun.write(join(repo, ".git", "config"), (await Bun.file(join(repo, ".git", "config")).text()) + text);
    const included = (repo: string, name: string, text: string) => { const f = join(repo, name); writeFileSync(f, text); return `[include]\n\tpath = ${f}\n`; };
    const earlier = (repo: string, text: string) => included(repo, "earlier.cfg", text);
    const later = (repo: string, text: string) => included(repo, "later.cfg", text);
    // extensions.partialClone — the included value is ignored; the repo's own LAST value decides.
    await append(extIncludedOriginOwnEmpty!, earlier(extIncludedOriginOwnEmpty!, "[extensions]\n\tpartialClone = origin\n") + "[extensions]\n\tpartialClone =\n");
    await append(extIncludedEmptyOwnOrigin!, earlier(extIncludedEmptyOwnOrigin!, "[extensions]\n\tpartialClone =\n") + "[extensions]\n\tpartialClone = origin\n");
    // The round-4 case: own `origin`, then an included EMPTY value AFTER it — git still fetches.
    await append(extOwnOriginLaterIncludedEmpty!, "[extensions]\n\tpartialClone = origin\n" + later(extOwnOriginLaterIncludedEmpty!, "[extensions]\n\tpartialClone =\n"));
    await append(extIncludedOnly!, earlier(extIncludedOnly!, "[extensions]\n\tpartialClone = origin\n"));
    // In the repo's own file the key is single-valued: `origin` then EMPTY → git cannot fetch; the reverse can.
    await append(extOwnLastEmpty!, "[extensions]\n\tpartialClone = origin\n\tpartialClone =\n");
    await append(extOwnLastOrigin!, "[extensions]\n\tpartialClone =\n\tpartialClone = origin\n");
    // remote.<name>.promisor: an earlier-level `true` under a later `false` — git STILL treats the remote
    // as a promisor (a later false never unmarks it), so this is partial, NOT "overridden".
    await append(promisorOverridden!, earlier(promisorOverridden!, `[remote "origin"]\n\tpromisor = true\n`) + `[remote "origin"]\n\tpromisor = false\n`);
    await append(promisorSameFile!, `[remote "origin"]\n\tpromisor = true\n\tpromisor = false\n`);
    await append(promisorLaterTrue!, earlier(promisorLaterTrue!, `[remote "origin"]\n\tpromisor = false\n`) + `[remote "origin"]\n\tpromisor = true\n`);
    // remote.<name>.partialclonefilter alone makes the remote a promisor — beside `promisor = false` too,
    // and from an included file (it is ordinary config, read at every level).
    await append(filterOnly!, `[remote "origin"]\n\tpartialclonefilter = blob:none\n`);
    await append(filterBesidePromisorFalse!, `[remote "origin"]\n\tpromisor = false\n\tpartialclonefilter = blob:none\n`);
    await append(filterIncludedOnly!, earlier(filterIncludedOnly!, `[remote "origin"]\n\tpartialclonefilter = blob:none\n`));
    const repos = [extIncludedOriginOwnEmpty!, extIncludedEmptyOwnOrigin!, extOwnOriginLaterIncludedEmpty!, extIncludedOnly!,
      extOwnLastEmpty!, extOwnLastOrigin!, promisorOverridden!, promisorSameFile!, promisorLaterTrue!,
      filterOnly!, filterBesidePromisorFalse!, filterIncludedOnly!];
    const env = withEnv({ repos, provider: PROV });
    try {
      const d = await doctorReport({ ...OFFLINE_DEPS, discover: async () => ({ repos, issues: [] }) });
      const verdict = (p: string) => d.repos.find((r) => r.path === p)!.partialClone === true;
      expect({
        extIncludedOriginOwnEmpty: verdict(extIncludedOriginOwnEmpty!), extIncludedEmptyOwnOrigin: verdict(extIncludedEmptyOwnOrigin!),
        extOwnOriginLaterIncludedEmpty: verdict(extOwnOriginLaterIncludedEmpty!), extIncludedOnly: verdict(extIncludedOnly!),
        extOwnLastEmpty: verdict(extOwnLastEmpty!), extOwnLastOrigin: verdict(extOwnLastOrigin!),
        promisorOverridden: verdict(promisorOverridden!), promisorSameFile: verdict(promisorSameFile!),
        promisorLaterTrue: verdict(promisorLaterTrue!),
        filterOnly: verdict(filterOnly!), filterBesidePromisorFalse: verdict(filterBesidePromisorFalse!),
        filterIncludedOnly: verdict(filterIncludedOnly!),
      }).toEqual({
        extIncludedOriginOwnEmpty: false, extIncludedEmptyOwnOrigin: true,
        extOwnOriginLaterIncludedEmpty: true, extIncludedOnly: false,
        extOwnLastEmpty: false, extOwnLastOrigin: true,
        promisorOverridden: true, promisorSameFile: true,
        promisorLaterTrue: true,
        filterOnly: true, filterBesidePromisorFalse: true,
        filterIncludedOnly: true,
      });
    } finally { env.cleanup(); }
  });

  // Round-4 harden A4-L1: the GLOBAL level. `runGit` inherits the environment the test process started
  // with (Bun.spawn does not see a later `process.env` write — measured on Bun 1.3.14), so a pass-through
  // spy hands git ONE controlled global file (and no system file) instead. Measured on git 2.50.1: a
  // global `extensions.partialClone = origin` never fetches; a global `partialclonefilter` alone does.
  // The second is also this test's PREMISE — it proves the injected global file is the one git read.
  test("partial-clone keys at the GLOBAL level: extensions.partialClone is ignored there; partialclonefilter counts", async () => {
    const { buildRepo } = await import("./fixtures/build-repo");
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date(Date.now() - 864e5).toISOString() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const realSpawn = Bun.spawn;
    const underGlobal = async (name: string, text: string) => {
      const file = join(env.cfgHome, name);
      writeFileSync(file, text);
      let gitSpawns = 0;
      const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: Parameters<typeof Bun.spawn>[0], opts?: Parameters<typeof Bun.spawn>[1]) => {
        if (Array.isArray(cmd) && cmd[0] === "git") gitSpawns++;
        return realSpawn(cmd as string[], { ...(opts as object), env: { ...process.env, GIT_CONFIG_GLOBAL: file, GIT_CONFIG_SYSTEM: "/dev/null" } } as Parameters<typeof Bun.spawn>[1]);
      }) as unknown as typeof Bun.spawn);
      try {
        const d = await doctorReport({ ...OFFLINE_DEPS, discover: async () => ({ repos: [repo], issues: [] }) });
        return { partial: d.repos[0]!.partialClone === true, gitSpawns };
      } finally { spy.mockRestore(); }
    };
    try {
      expect(await underGlobal("global-filter.gitconfig", `[remote "origin"]\n\tpartialclonefilter = blob:none\n`))
        .toEqual({ partial: true, gitSpawns: 3 });   // PREMISE: the injected global file is read
      expect(await underGlobal("global-ext.gitconfig", "[extensions]\n\tpartialClone = origin\n"))
        .toEqual({ partial: false, gitSpawns: 3 });
    } finally { env.cleanup(); }
  });

  // Round-3 harden A3-L1 (= D3-L2): a probe failure is a "no", whenever it lands. Before the fix an early
  // rejection made doctorReport throw (mapLimit → Promise.race). A LATE one never escaped, measured: the
  // race had already attached a handler to the pass, so it was handled, not lost — but it is pinned here
  // anyway, because `bun test` fails the running test on any unhandled rejection (measured with a
  // control), and the sleep below keeps this test running until both late probes have rejected.
  test("a partial-clone probe that throws or rejects — early, or after the deadline — costs a note, never the report", async () => {
    const env = withEnv({ repos: ["/r1", "/r2"], provider: PROV });
    try {
      const early = await doctorReport({ ...OFFLINE_DEPS, partialClone: async () => { throw new Error("early"); } });
      expect([early.verdict, early.repos.map((r) => r.partialClone)]).toEqual(["ready", [undefined, undefined]]);
      const sync = await doctorReport({ ...OFFLINE_DEPS, partialClone: () => { throw new Error("sync"); } });
      expect([sync.verdict, sync.repos.map((r) => r.partialClone)]).toEqual(["ready", [undefined, undefined]]);
      // Late: both probes reject 40 ms AFTER a 20 ms deadline — doctor has already answered by then.
      const late = await doctorReport({
        ...OFFLINE_DEPS, partialClone: () => new Promise<boolean>((_, reject) => setTimeout(() => reject(new Error("late")), 60)), partialCloneMs: 20,
      });
      expect([late.verdict, late.repos.map((r) => r.partialClone)]).toEqual(["ready", [undefined, undefined]]);
      await Bun.sleep(150);   // past the late rejections, so an unhandled one would fail THIS test
    } finally { env.cleanup(); }
  });

  test("the partial-clone pass is bounded: a probe that never answers costs at most its budget and adds no note", async () => {
    const env = withEnv({ repos: ["/r1", "/r2"], provider: PROV });
    try {
      const t0 = Date.now();
      const d = await doctorReport({ ...OFFLINE_DEPS, partialClone: () => new Promise<boolean>(() => {}), partialCloneMs: 50 });
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(d.repos.map((r) => r.partialClone)).toEqual([undefined, undefined]);
      expect(d.verdict).toBe("ready");
    } finally { env.cleanup(); }
  });

  // Round-2 harden (gpt R6): the race above only stopped AWAITING the scan. Every worker kept taking
  // queued repos after doctor returned, each a `git config` spawn, so the bound covered the answer and
  // not the pass. Controllable probes make it deterministic: the first wave is held past the deadline,
  // then answered — under a race-only bound each freed worker starts the next repo at once.
  test("the partial-clone pass has ONE deadline: no queued probe starts after it, and doctor does not wait on those in flight", async () => {
    const many = Array.from({ length: 3 * REPO_SCAN_CONCURRENCY }, (_, i) => `/r${String(i).padStart(2, "0")}`);
    const env = withEnv({ repos: many, provider: PROV });
    try {
      const held: ((v: boolean) => void)[] = [];
      const probe = () => new Promise<boolean>((r) => { held.push(r); });
      const d = await doctorReport({ ...OFFLINE_DEPS, discover: async () => ({ repos: many, issues: [] }), partialClone: probe, partialCloneMs: 50 });
      // PREMISE: doctor returned at the deadline with a full first wave in flight, none of it answered.
      expect(held.length).toBe(REPO_SCAN_CONCURRENCY);
      expect(d.repos.length).toBe(many.length);
      expect(d.repos.every((r) => r.partialClone === undefined)).toBe(true);
      // The in-flight probes answer AFTER the deadline, freeing every worker.
      for (const answer of held.splice(0)) answer(true);
      await Bun.sleep(20);
      expect(`probes started after the deadline: ${held.length}`).toBe("probes started after the deadline: 0");
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
  // A hand-edited NON-STRING degrades the same way (round-2 harden D-M1: status --json used to throw on it).
  { name: "a non-string morningTime (720) degrades with a warning", raw: { provider: PROV, morningTime: 720 }, valid: true, warns: "morningTime" },
  { name: "a non-string morningTime (true) degrades with a warning", raw: { provider: PROV, morningTime: true }, valid: true, warns: "morningTime" },
  { name: "a non-string morningTime ({}) degrades with a warning", raw: { provider: PROV, morningTime: {} }, valid: true, warns: "morningTime" },
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
  // `noteSkip(` too (provider fallback P1-M9-T1): the record writer the parse-empty, write-fail and marker-fail
  // returns call directly, beside `last-failure.json`.
  for (const call of src.matchAll(/(?:skip|noteSkip)\(([^)]*)\)/g)) {
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

// ── E11 (Phase E final harden; deferred M1a A3/A4): config-ECHO strings leave the read-only surfaces
// redacted, exactly as the run envelope already redacts them. Each plant is first shown raw at its source.
describe("config-echo warnings and errors are redacted on status / doctor / config validate, and on `Config error:`", () => {
  const GH = "ghp_AbCdEfGhIjKlMnOpQrStUv123456";
  const base = { repos: [], provider: PROV, networkProbeHosts: [] };

  test("config validate: an echoed morningTime, an echoed bad regex, and a validator error that quotes the value", () => {
    // PREMISES: the sources really echo the value.
    expect(parseFloor(GH).warning).toContain(GH);
    const warned = validateCandidate({ ...base, morningTime: GH, excludeCommitPatterns: [`${GH}[`] });
    expect(warned.valid).toBe(true);
    expect(warned.warnings.map((w) => w.field).sort()).toEqual(["excludeCommitPatterns", "morningTime"]);
    expect(JSON.stringify(warned.warnings)).not.toContain(GH);
    expect(warned.warnings.every((w) => w.message.includes(REDACTION))).toBe(true);
    expect(warned.normalized?.morningTime).toBe(GH);           // the caller's own config is handed back untouched

    const failed = validateCandidate({ ...base, lookbackCapDays: GH });
    expect(failed.valid).toBe(false);
    expect(failed.errors[0]!.field).toBe("lookbackCapDays");
    expect(failed.errors[0]!.message).toContain(REDACTION);
    expect(JSON.stringify(failed)).not.toContain(GH);
  });

  test("status --json: configError and morningTime.warning", async () => {
    for (const [cfg, pick] of [
      [{ ...base, lookbackCapDays: GH }, (s: Awaited<ReturnType<typeof statusReport>>) => s.configError],
      [{ ...base, morningTime: GH }, (s: Awaited<ReturnType<typeof statusReport>>) => s.morningTime.warning],
      // A NON-STRING carrying one (round-2 D-M1): `value` is its JSON spelling, redacted like any string.
      [{ ...base, morningTime: [GH] }, (s: Awaited<ReturnType<typeof statusReport>>) => s.morningTime.value],
      [{ ...base, morningTime: { t: GH } }, (s: Awaited<ReturnType<typeof statusReport>>) => s.morningTime.warning],
    ] as const) {
      const env = withEnv(cfg);
      try {
        const s = await statusReport();
        expect(pick(s)).toContain(REDACTION);                    // PREMISE: the field was populated
        expect(JSON.stringify(s)).not.toContain(GH);
      } finally { env.cleanup(); }
    }
  });

  test("doctor --json: the config block's errors and warnings", async () => {
    for (const cfg of [{ ...base, lookbackCapDays: GH }, { ...base, morningTime: GH }, { ...base, morningTime: [GH] }]) {
      const env = withEnv(cfg);
      try {
        const d = await doctorReport(OFFLINE_DEPS);
        const notes = [...d.config.errors, ...d.config.warnings];
        expect(notes.length).toBeGreaterThan(0);
        expect(notes.some((n) => n.message.includes(REDACTION))).toBe(true);
        expect(JSON.stringify(d)).not.toContain(GH);
      } finally { env.cleanup(); }
    }
  });

  test("`Config error:` on stderr (fd 2 is briefing.log under launchd), forced and scheduled alike", async () => {
    const { run } = await import("../src/main");
    for (const force of [true, false]) {
      const env = withEnv({ ...base, lookbackCapDays: GH });
      const err: string[] = [];
      const oErr = console.error;
      console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
      let code: number;
      try { code = await run(force, { interactive: false }); } finally { console.error = oErr; env.cleanup(); }
      expect(code!).toBe(2);
      const text = err.join("\n");
      expect(text).toContain("Config error:");                    // PREMISE: the line was printed
      expect(text).toContain(REDACTION);
      expect(text).not.toContain(GH);
    }
  });
});

// ── v0.2.1 §2.4.5 (plan T1.4): doctor applies the run's DISCOVERY-BLOCKED rule to its own walk ─────────
// The pre-existing `anyInaccessible` rule is unchanged (the TCC-denied test above, and the incidental-
// Desktop case below); the addition is only the MISSING configured search folder with no repo found,
// which `anyInaccessible` cannot see (`not-found` is not inaccessible) while every run is blocked by it.
// REAL walks: `preflight` and `discover` are not injected, so this is the code doctor actually runs.
describe("doctor --json: the discovery-blocked rule (v0.2.1)", () => {
  const REAL_WALK: DoctorDeps = { ...OFFLINE_DEPS, preflight: undefined, discover: undefined, partialClone: async () => false };
  const scratch = (p: string) => removeAtRunEnd(mkdtempSync(join(tmpdir(), p)));

  test("a MISSING configured search folder with zero repos → blocked (it read 'ready' before)", async () => {
    const missing = join(scratch("dba-v021-doc-"), "Projcts");
    const env = withEnv({ discoverRoots: [missing], provider: PROV });
    try {
      const d = await doctorReport(REAL_WALK);
      // PREMISE: the row is there and is NOT inaccessible, so `anyInaccessible` cannot be what blocks.
      expect(d.repos.map((r) => [r.path, r.issueKind])).toEqual([[missing, "not-found"]]);
      expect(d.discoveredCount).toBe(0);
      expect(d.verdict).toBe("blocked");
    } finally { env.cleanup(); }
  });

  test("the same missing folder BESIDE a found repo is not blocked — the run would deliver", async () => {
    const { buildRepo } = await import("./fixtures/build-repo");
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date(Date.now() - 864e5).toISOString() }]);
    const missing = join(scratch("dba-v021-doc2-"), "Projcts");
    const env = withEnv({ discoverRoots: [repo, missing], provider: PROV });
    try {
      const d = await doctorReport(REAL_WALK);
      expect(d.discoveredCount).toBe(1);
      expect(d.verdict).toBe("ready");
    } finally { env.cleanup(); }
  });

  test("an INCIDENTAL denied Desktop under a search folder stays 'blocked' through the EXISTING anyInaccessible rule", async () => {
    const home = scratch("dba-v021-doc-home-");
    const desktop = join(home, "Desktop");
    mkdirSync(desktop);
    const { chmodSync } = await import("node:fs");
    chmodSync(desktop, 0o000);
    const env = withEnv({ discoverRoots: [home], provider: PROV });
    try {
      const d = await doctorReport(REAL_WALK);
      expect(d.repos.find((r) => r.path === desktop)?.issueKind).toBe("unreadable");   // PREMISE
      expect(d.verdict).toBe("blocked");
    } finally { env.cleanup(); chmodSync(desktop, 0o755); }
  });

  test("an explicit `repos` list never discovers in a run, so its missing discoverRoot cannot block doctor — even with every listed repo excluded", async () => {
    // preflight still walks discoverRoots beside explicit repos (to surface a blocked root up front), and
    // excluding the only listed repo leaves zero found — exactly the inputs the predicate would block on.
    // The run, though, short-circuits discovery for explicit `repos`: no discovery issue, a stamped quiet
    // day. Doctor must agree with the run.
    const missing = join(scratch("dba-v021-doc3-"), "Projcts");
    const env = withEnv({ repos: ["/r1"], excludeRepos: ["/r1"], discoverRoots: [missing], provider: PROV });
    try {
      const d = await doctorReport(REAL_WALK);
      expect(d.repos.map((r) => [r.path, r.issueKind])).toEqual([[missing, "not-found"]]);   // PREMISE: the root walk ran
      expect(d.discoveredCount).toBe(0);
      expect(d.verdict).toBe("ready");
    } finally { env.cleanup(); }
  });
});

// ── Provider fallback P1-M10-T1: `status --json` `providers` and `lastFailure`; `doctor` `providers` ─────────────────
describe("P1-M10-T1: provider rows", () => {
  const LOCAL = { api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:9/v1" } };
  const inAnHour = () => new Date(Date.now() + 3600e3).toISOString();
  async function seedState(stateDir: string, cfg: Config, extra: { marks?: Record<string, unknown>; status?: Record<string, unknown> }) {
    const { accountStatePath } = await import("../src/account");
    const { writeProviderStatus } = await import("../src/providerStatus");
    mkdirSync(stateDir, { recursive: true });
    if (extra.marks) writeFileSync(accountStatePath(stateDir), JSON.stringify({ accounts: extra.marks }));
    if (extra.status) await writeProviderStatus({ labels: extra.status as never });
    void cfg;
  }

  test("status --json: one row per entry and per dropped entry, in rowStatus precedence; item 1's hour mark is not 'paused'", async () => {
    const cfgObj = { repos: ["/r1"], provider: { ...PROV, accounts: [{ label: "A" }, { label: "B", configDir: tmpdir() }] },
      fallbacks: [{ label: "Usage", ...LOCAL }, { label: "Paused", ...LOCAL }, { label: "Failing", ...LOCAL }, { label: "Working", ...LOCAL }, { label: "Broken" }] };
    const env = withEnv(cfgObj);
    try {
      const cfg = await loadConfig();
      const { resolveProviderList, entryRevision } = await import("../src/providerList");
      const list = resolveProviderList(cfg, process.env.HOME ?? "");
      const rev = (l: string) => entryRevision(list.entries.find((e) => e.label === l)!);
      const at = new Date(Date.now() - 600e3).toISOString();
      await seedState(env.stateDir, cfg, {
        marks: { A: { limitedUntil: inAnHour(), isProbe: true, reason: "auth" }, Usage: { limitedUntil: inAnHour(), isProbe: false, reason: "usage" },
          Paused: { limitedUntil: inAnHour(), isProbe: true, reason: "not-found" } },
        status: {
          A: { revision: rev("A"), lastRun: { at, revision: rev("A"), ok: true } },
          Failing: { revision: rev("Failing"), lastRun: { at, revision: rev("Failing"), ok: false, reason: "unreachable" }, failingSince: { at, revision: rev("Failing") } },
          Working: { revision: rev("Working"), lastRun: { at, revision: rev("Working"), ok: true } },
        },
      });
      const s = await statusReport();
      expect(s.providers.map((p) => [p.label, p.kind, p.status.kind])).toEqual([
        ["A", "cli", "working"],                        // an hour mark on item 1 is ignored: its newest observation decides
        ["B", "cli", "not-tested"],
        ["Usage", "openai-compatible", "out-of-usage"],
        ["Paused", "openai-compatible", "paused"],
        ["Failing", "openai-compatible", "not-working"],
        ["Working", "openai-compatible", "working"],
        ["Broken", "invalid", "invalid"],
      ]);
      expect(s.providers.find((p) => p.label === "Usage")?.until).toBeDefined();
      expect(s.providers.find((p) => p.label === "Failing")?.failingSince).toBe(at);
      expect(s.lastFailure).toBeNull();
    } finally { env.cleanup(); }
  });

  test("status --json: lastFailure is null without the file and the record with it", async () => {
    const env = withEnv({ repos: ["/r1"], provider: PROV });
    try {
      expect((await statusReport()).lastFailure).toBeNull();
      const { writeLastFailure } = await import("../src/marker");
      await writeLastFailure({ localDate: "2026-10-16", reason: "provider-fail", detail: "1 provider failed — open Settings → Providers" });
      expect((await statusReport()).lastFailure).toEqual({ localDate: "2026-10-16", reason: "provider-fail", detail: "1 provider failed — open Settings → Providers" });
    } finally { env.cleanup(); }
  });

  test("doctor --json: a providers array with each entry's key source and mark, and it never spawns a key command", async () => {
    const env = withEnv({ repos: ["/r1"], provider: PROV,
      fallbacks: [{ label: "Key", api: { kind: "anthropic", model: "m", baseUrl: "https://api.example/v1", apiKeyCommand: ["/nonexistent/bin/key-helper", "get"] } }, { label: "Local", ...LOCAL }] });
    try {
      const { accountStatePath } = await import("../src/account");
      mkdirSync(env.stateDir, { recursive: true });
      writeFileSync(accountStatePath(env.stateDir), JSON.stringify({ accounts: { Local: { limitedUntil: inAnHour(), isProbe: false, reason: "usage" } } }));
      const spawnSpy = spyOn(Bun, "spawn");
      let d: Awaited<ReturnType<typeof doctorReport>>;
      try { d = await doctorReport(OFFLINE_DEPS); } finally { spawnSpy.mockRestore(); }
      expect(spawnSpy.mock.calls.filter((c) => JSON.stringify(c).includes("key-helper"))).toEqual([]);
      expect(d.providers.map((p) => [p.label, p.kind])).toEqual([["default", "cli"], ["Key", "anthropic"], ["Local", "openai-compatible"]]);
      const key = d.providers.find((p) => p.label === "Key")!;
      expect(key.keySource).toEqual({ source: expect.any(String), found: null, detail: expect.any(String), executed: false });
      expect(d.providers.find((p) => p.label === "Local")?.mark?.reason).toBe("usage");
      expect(d.providers.find((p) => p.label === "default")?.mark).toBeNull();
    } finally { env.cleanup(); }
  });

  test("doctor --json: a DROPPED fallback is 'degraded', not 'blocked' — the run still delivers from item 1", async () => {
    const env = withEnv({ repos: ["/r1"], provider: PROV, fallbacks: [{ label: "Broken" }] });
    try {
      const d = await doctorReport(OFFLINE_DEPS);
      expect(d.config.valid).toBe(false);                            // the premise: config validate still refuses it
      expect(d.verdict).toBe("degraded");
      expect(d.providers.find((p) => p.label === "Broken")?.kind).toBe("invalid");
    } finally { env.cleanup(); }
  });
});

// ── P1-M10 checkpoint: doctor's dropped-fallback rule is ONLY for dropped fallbacks (MED 3), and labels that are keys
// or calendar links never reach the report surfaces raw (MED 4, hub Q25) ─────────────────────────────────────────────
describe("P1-M10 checkpoint: doctor verdicts and safe provider labels", () => {
  const KEY = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
  const LINK = "https://calendar.google.com/calendar/ical/me%40example.org/private-0123456789abcdef/basic.ics";
  const LOCAL = { api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:9/v1" } };

  test("a dropped fallback PLUS another config error stays 'blocked' (invalid provider.label; a literal calendar url)", async () => {
    for (const extra of [{ provider: { ...PROV, label: "" } }, { calendar: { enabled: true, links: [{ id: "work", url: LINK }] } }]) {
      const env = withEnv({ repos: ["/r1"], provider: PROV, fallbacks: [{ label: "Broken" }], ...extra });
      try {
        const d = await doctorReport(OFFLINE_DEPS);
        expect(d.config.errors.some((e) => e.field.startsWith("fallbacks["))).toBe(true);   // the premise: both kinds of error
        expect(d.config.errors.some((e) => !e.field.startsWith("fallbacks"))).toBe(true);
        expect(`${Object.keys(extra)[0]}: ${d.verdict}`).toBe(`${Object.keys(extra)[0]}: blocked`);
      } finally { env.cleanup(); }
    }
  });

  test("status --json and doctor --json show a key- or link-shaped label masked; config validate warns by position and never echoes it", async () => {
    const env = withEnv({ repos: ["/r1"], provider: PROV,
      fallbacks: [{ label: `Key ${KEY}`, ...LOCAL }, { label: `Cal ${LINK}`, ...LOCAL }, { label: "Plain local", ...LOCAL }, { label: `Broken ${KEY}` }] });
    try {
      const s = JSON.stringify((await statusReport()).providers);
      const d = await doctorReport(OFFLINE_DEPS);
      for (const text of [s, JSON.stringify(d.providers)]) {
        expect(text).not.toContain("Zq9xR2bT7mVwK4pL");
        expect(text).not.toContain("calendar.google.com");
        expect(text).toContain("Plain local");                       // an ordinary label is untouched
      }
      const raw = JSON.parse(readFileSync(join(env.cfgHome, "daily-briefing", "config.json"), "utf8"));
      const v = validateCandidate(raw);
      const labelWarnings = v.warnings.filter((w) => w.message.includes("reports show it masked"));
      expect(labelWarnings.map((w) => w.field)).toEqual(["fallbacks[0]", "fallbacks[1]"]);
      expect(JSON.stringify(v)).not.toContain("Zq9xR2bT7mVwK4pL");
      expect(JSON.stringify(v)).not.toContain("calendar.google.com");
    } finally { env.cleanup(); }
  });

  test("an ordinary config gets no label warning", () => {
    const v = validateCandidate({ repos: ["/r1"], provider: { ...PROV, accounts: [{ label: "Claude login 1" }, { label: "Work", configDir: tmpdir() }] }, fallbacks: [{ label: "Local model", ...LOCAL }] });
    expect(v.warnings.filter((w) => w.message.includes("reports show it masked"))).toEqual([]);
  });
});

test("P1-M10 checkpoint (Q25 (3)): a key-shaped LOGIN label is warned by its accounts position; item 1's own label by provider.label", () => {
  const KEY = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
  const v1 = validateCandidate({ repos: ["/r1"], provider: { ...PROV, accounts: [{ label: "Login 1" }, { label: `Login ${KEY}`, configDir: tmpdir() }] } });
  expect(v1.valid).toBe(true);                                       // a warning, never an error (requirement 9)
  expect(v1.warnings.filter((w) => w.message.includes("reports show it masked")).map((w) => w.field)).toEqual(["provider.accounts[1]"]);
  const v2 = validateCandidate({ repos: ["/r1"], provider: { ...PROV, label: `Main ${KEY}` } });
  expect(v2.warnings.filter((w) => w.message.includes("reports show it masked")).map((w) => w.field)).toEqual(["provider.label"]);
  // The notes never echo it (`normalized` is the caller's own config handed back, by design, so it is not checked).
  expect(JSON.stringify([v1.warnings, v1.errors, v2.warnings, v2.errors])).not.toContain("Zq9xR2bT7mVwK4pL");
});

describe("PR 1 final review round 1: doctor's gate and verdict follow the run", () => {
  const LOCAL = { api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:9/v1" } };
  test("M10: a loopback item 1 with a remote fallback reports the network gate the WALK uses (enabled), single-entry unchanged", async () => {
    const env = withEnv({ repos: ["/r1"], provider: { ...LOCAL },
      fallbacks: [{ label: "Remote", api: { kind: "anthropic", model: "m", baseUrl: "https://api.anthropic.com" } }] });
    try {
      const d = await doctorReport(OFFLINE_DEPS);
      expect(d.network.enabled).toBe(true);
      expect(d.network.hostsConfigured).toBeGreaterThan(0);
    } finally { env.cleanup(); }
    // Single entry: a loopback API item 1 alone disables the gate, exactly as before.
    const env2 = withEnv({ repos: ["/r1"], provider: { ...LOCAL } });
    try { expect((await doctorReport(OFFLINE_DEPS)).network).toMatchObject({ enabled: false, hostsConfigured: 0 }); } finally { env2.cleanup(); }
    const env3 = withEnv({ repos: ["/r1"], provider: PROV });
    try { expect((await doctorReport(OFFLINE_DEPS)).network.hostsConfigured).toBe(2); } finally { env3.cleanup(); }
  });

  test("M11: an openai-compatible item 1 with NO baseUrl stays 'blocked' even when its only config errors are dropped fallbacks", async () => {
    const env = withEnv({ repos: ["/r1"], provider: { api: { kind: "openai-compatible", model: "m" } }, fallbacks: [{ label: "Broken" }] });
    try {
      const d = await doctorReport(OFFLINE_DEPS);
      expect(d.config.errors.every((e) => e.field.startsWith("fallbacks"))).toBe(true);   // the premise
      expect(d.verdict).toBe("blocked");
    } finally { env.cleanup(); }
  });
});

test("round 2 L4: an item 1 without a baseUrl is 'blocked' only when NO valid fallback survives", async () => {
  const env = withEnv({ repos: ["/r1"], provider: { api: { kind: "openai-compatible", model: "m" } },
    fallbacks: [{ label: "Broken" }, { label: "Local", api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:9/v1" } }] });
  try {
    const d = await doctorReport(OFFLINE_DEPS);
    expect(d.config.errors.every((e) => e.field.startsWith("fallbacks"))).toBe(true);   // the premise
    expect(d.verdict).toBe("degraded");                                                // the walk moves on to Local
  } finally { env.cleanup(); }
});

// ── PR 1 final review round 3 ──────────────────────────────────────────────────────────────────────────────────────
describe("PR 1 final review round 3: provider rows carry their position (M1); one path for drop warnings (L6)", () => {
  const KEY = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
  const LOCAL = { api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:9/v1" } };
  const LINK = "https://calendar.google.com:99999/calendar/ical/abc%40group.calendar.google.com/private-0123456789abcdef0123456789abcdef/basic.ics";

  test("M1: status and doctor rows carry index (display position as written), source and fallbackIndex — two masked labels and a duplicate stay joinable", async () => {
    const env = withEnv({ repos: ["/r1"], provider: { ...PROV, accounts: [{ label: "A" }, { label: "B", configDir: tmpdir() }] },
      fallbacks: [{ label: `Key ${KEY}`, ...LOCAL }, { label: "Broken" }, { label: `Other ${KEY}x`, ...LOCAL }, { label: "A", ...LOCAL }] });
    try {
      const s = await statusReport();
      const d = await doctorReport(OFFLINE_DEPS);
      for (const rows of [s.providers, d.providers] as { label: string; index: number; source: string; fallbackIndex?: number }[][]) {
        expect(rows.map((r) => [r.index, r.source, r.fallbackIndex ?? null])).toEqual([
          [0, "provider", null], [1, "provider", null],
          [2, "fallback", 0], [3, "fallback", 1], [4, "fallback", 2], [5, "fallback", 3],
        ]);
        // The premise: two rows read the same masked text, and the duplicate-label row reads its twin's label.
        expect(rows[2]!.label).toBe(rows[4]!.label);
        expect(rows[5]!.label).toBe(rows[0]!.label);
      }
    } finally { env.cleanup(); }
  });

  test("M1: a whole-list drop (fallbacks not an array) is one fallback row with no fallbackIndex, after item 1", async () => {
    const env = withEnv({ repos: ["/r1"], provider: PROV, fallbacks: { label: "not a list" } });
    try {
      const rows = (await statusReport()).providers;
      expect(rows.map((r) => [r.index, r.source, "fallbackIndex" in r])).toEqual([[0, "provider", false], [1, "fallback", false]]);
    } finally { env.cleanup(); }
  });

  test("L6: config validate's dropped-entry error goes through the same scrub as the status row's reason", async () => {
    const env = withEnv({ repos: ["/r1"], provider: PROV, fallbacks: [{ label: "Cal", api: { kind: "openai-compatible", model: "m", baseUrl: LINK } }] });
    try {
      const raw = JSON.parse(readFileSync(join(env.cfgHome, "daily-briefing", "config.json"), "utf8"));
      const v = validateCandidate(raw);
      const err = v.errors.find((e) => e.field === "fallbacks[0]");
      expect(err?.message).toContain("is not a valid URL");                 // the premise: the warning quotes the value
      expect(err?.message).not.toContain("private-0123456789abcdef");
      const row = (await statusReport()).providers.find((p) => p.status.kind === "invalid");
      expect(row?.status).toEqual({ kind: "invalid", reason: err!.message });
    } finally { env.cleanup(); }
  });
});

// PR 1 final review round 4 M3: a structurally broken `provider.accounts` ("— account failover disabled") collapses
// item 1 to ONE row while the written list has N logins, so `index` is not the written position there (and `--index`
// refuses that config). Pinned as the documented collapsed shape; docs/gui-seam.md §1 tells the app not to join then.
test("round 4 M3: accounts [A, A] + one fallback — status and doctor rows collapse item 1, and the warning says why", async () => {
  const env = withEnv({ repos: ["/r1"], provider: { ...PROV, accounts: [{ label: "A" }, { label: "A" }] },
    fallbacks: [{ label: "Key", api: { kind: "anthropic", model: "m", apiKeyEnv: "K" } }] });
  try {
    const s = await statusReport();
    const d = await doctorReport(OFFLINE_DEPS);
    for (const rows of [s.providers, d.providers] as { index: number; source: string; fallbackIndex?: number }[][]) {
      expect(rows.map((r) => [r.index, r.source, "fallbackIndex" in r ? r.fallbackIndex : "absent"])).toEqual([[0, "provider", "absent"], [1, "fallback", 0]]);
    }
    expect(d.config.warnings.some((w) => w.field === "provider.accounts" && w.message.includes("account failover disabled"))).toBe(true);
  } finally { env.cleanup(); }
});
