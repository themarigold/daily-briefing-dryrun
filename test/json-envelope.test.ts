import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// gui-tauri T1 — `run --json` and `run --json-out <path>`.
//
// The property under test is NOT "the envelope has the right fields". It is that adding either flag
// changes NOTHING about the briefing: same markdown, same stderr, same files, same exit codes — and,
// for `--json-out`, the same stdout byte for byte, because briefing.log is launchd's StandardOutPath
// and `audit.lastBriefing` grades whatever sits after the last `☀️ … briefing —` header in it.
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepo } from "./fixtures/build-repo";
import { run } from "../src/main";
import { envelopeFrom, gateEnvelope, resolveJsonOutPath, statePaths, type RunEnvelope } from "../src/json";
import { lastBriefing } from "../src/audit";
import type { CoreResult } from "../src/core";
import { ProviderError, type BriefingStruct, type Provider } from "../src/types";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { unstamp } from "./helpers/unstamp";
import { recapCampaignsPath } from "../src/marker";

const yesterdayISO = () => new Date(Date.now() - 864e5).toISOString();
const PROV = { cli: "claude", argv: ["-p"], promptVia: "stdin" as const };
const MODEL_OUT = "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x | evidence: abc123\n## SUGGESTIONS\n- do y";

function fakeProvider() {
  let calls = 0;
  const provider: Provider = { async generate() { calls++; return MODEL_OUT; } };
  return { provider, calls: () => calls };
}

/** Same isolation shape as `main.test.ts`'s `withEnv` — a private config dir AND a private state dir,
 *  both restored. Duplicated rather than shared because that helper is file-local there and hoisting
 *  it would touch a 1113-line test file this task has no business editing. */
function withEnv(cfgObj?: unknown): { stateDir: string; cleanup: () => void } {
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-cfg-")));
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-state-")));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  if (cfgObj !== undefined) writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify(cfgObj));
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  return {
    stateDir,
    cleanup: () => {
      if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
      if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
    },
  };
}

function captureConsole() {
  const out: string[] = [], err: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return { out, err, restore: () => { console.log = oLog; console.error = oErr; } };
}

const AFTER_FLOOR = () => new Date(2026, 6, 16, 9, 0);

// `unstamp` (the cross-run `state as of HH:MM` normaliser) lives in test/helpers/unstamp.ts — see there.

// ── unit: envelopeFrom over each CoreResult family ───────────────────────────────────────────────

const STRUCT: BriefingStruct = {
  date: "2026-09-14", machineScope: "host", provider: "claude",
  resume: [], recap: [], suggestions: [],
};

function coreResult(over: Partial<CoreResult> = {}): CoreResult {
  return {
    emptyWindow: false, blocked: false, offlineSkipped: false,
    net: { online: true, waitedMs: 0 },
    struct: STRUCT, rawText: MODEL_OUT, promptText: "p",
    ctx: { repos: [] }, units: [], activities: [], repos: [],
    runDate: "2026-09-14", discIssues: [], extrIssues: [],
    warnings: [], today: [], windowStartUtc: "2026-09-10T00:00:00.000Z",
    ...over,
  };
}

describe("envelopeFrom", () => {
  test("a delivered run: ok, delivered, no skip reason", () => {
    const e = envelopeFrom(coreResult(), "# md", 0);
    expect(e.schemaVersion).toBe(1);
    expect([e.ok, e.delivered, e.skipReason]).toEqual([true, true, null]);
    expect(e.markdown).toBe("# md");
    expect(e.struct).toBe(STRUCT);
  });

  test("a quiet day (emptyWindow) is a DELIVERY, not a skip — it stamps the marker", () => {
    // The distinction the field exists for: `emptyWindow` renders, writes and stamps, so a GUI must
    // show it as "today's briefing is here and it is quiet", never as "nothing happened, retry".
    const e = envelopeFrom(coreResult({ emptyWindow: true, rawText: "", net: null }), "# quiet", 0);
    expect([e.emptyWindow, e.delivered, e.skipReason]).toEqual([true, true, null]);
  });

  test("blocked: exit 1, delivered false, and the reason is named even though CoreResult has no field for it", () => {
    const e = envelopeFrom(coreResult({ blocked: true, net: null }), "", 1);
    expect([e.ok, e.delivered, e.blocked, e.skipReason]).toEqual([false, false, true, "blocked"]);
  });

  test("offlineSkipped: exit 0 but NOT delivered — the two must never be conflated", () => {
    // Exit 0 is the launchd contract for a legitimate skip (the tick retries in ~10 min). A consumer
    // reading only the exit code would call this a success; `delivered` is what disagrees.
    const e = envelopeFrom(coreResult({ offlineSkipped: true, skipReason: "offline", net: { online: false, waitedMs: 25_000 } }), "", 0);
    expect([e.ok, e.delivered, e.skipReason]).toEqual([true, false, "offline"]);
    expect(e.net).toEqual({ online: false, waitedMs: 25_000 });
  });

  test("limited: the account payload rides along so the GUI can say WHICH account and until when", () => {
    const limited = { label: "work", until: "3pm", isProbe: false, exhausted: false };
    const e = envelopeFrom(coreResult({ offlineSkipped: true, skipReason: "limited", limited, net: null }), "", 0);
    expect([e.delivered, e.skipReason]).toEqual([false, "limited"]);
    expect(e.limited).toEqual(limited);
  });

  test("darkwake keeps its own reason rather than collapsing into offline", () => {
    // Distinct because the REMEDY differs — an undistinguished failure block was misdiagnosed twice
    // on 2026-08-08 before `pmset` settled it (main.ts's own note on this branch).
    const e = envelopeFrom(coreResult({ offlineSkipped: true, skipReason: "darkwake", net: null }), "", 0);
    expect(e.skipReason).toBe("darkwake");
  });

  test("the two shell-side failures are NOT guessable from the exit code, so they are passed in", () => {
    // Both exit 1 with a CoreResult in hand. Without the explicit argument one of them is mislabelled
    // — which is a wrong cause shown to a user, the defect class this project keeps filing.
    const r = coreResult();
    expect(envelopeFrom(r, "# md", 1, "parse-empty").skipReason).toBe("parse-empty");
    expect(envelopeFrom(r, "# md", 1, "marker-fail").skipReason).toBe("marker-fail");
  });

  test("exitCode and skipReason agree: a null reason implies exit 0, and a reason never claims delivery", () => {
    const cases: RunEnvelope[] = [
      envelopeFrom(coreResult(), "# md", 0),
      envelopeFrom(coreResult({ emptyWindow: true }), "# md", 0),
      envelopeFrom(coreResult({ blocked: true }), "", 1),
      envelopeFrom(coreResult({ offlineSkipped: true, skipReason: "offline" }), "", 0),
      envelopeFrom(coreResult({ offlineSkipped: true, skipReason: "limited" }), "", 0),
      gateEnvelope({ exitCode: 0, runDate: "2026-09-14", skipReason: "already-ran" }),
      gateEnvelope({ exitCode: 2, runDate: "2026-09-14", skipReason: "config-error" }),
    ];
    for (const e of cases) {
      expect(`${e.skipReason}:${e.ok}`).toBe(`${e.skipReason}:${e.exitCode === 0}`);
      if (e.skipReason !== null) expect(`${e.skipReason} delivered=${e.delivered}`).toBe(`${e.skipReason} delivered=false`);
      if (e.delivered) expect(e.exitCode).toBe(0);
    }
  });

  test("a gate envelope says `null` struct rather than synthesising an empty briefing", () => {
    // An empty BriefingStruct would claim the pipeline RAN and found nothing — a different fact from
    // "the run returned before the pipeline started", and the one a Today screen would render wrong.
    const e = gateEnvelope({ exitCode: 0, runDate: "2026-09-14", skipReason: "below-floor" });
    expect(e.struct).toBeNull();
    expect(e.markdown).toBe("");
    expect(e.paths.stateDir).toBe(process.env.DAILY_BRIEFING_STATE_DIR!);
  });
});

// ── the --json-out path shape guard ──────────────────────────────────────────────────────────────

describe("resolveJsonOutPath", () => {
  test("refuses traversal — the measured escape archivedBriefingPath was fixed for", () => {
    for (const bad of ["../../etc/x", "..", "a/../../b", "sub/../../../tmp/x"]) {
      expect(() => resolveJsonOutPath(bad, "/state")).toThrow(/\.\./);
    }
  });
  test("refuses an empty path and a NUL byte", () => {
    expect(() => resolveJsonOutPath("", "/state")).toThrow();
    expect(() => resolveJsonOutPath("   ", "/state")).toThrow();
    expect(() => resolveJsonOutPath("a\0b", "/state")).toThrow(/NUL/);
  });
  test("an absolute path is taken as given; a relative one lands UNDER the state dir", () => {
    expect(resolveJsonOutPath("/tmp/env.json", "/state")).toBe("/tmp/env.json");
    expect(resolveJsonOutPath("env.json", "/state")).toBe("/state/env.json");
    expect(resolveJsonOutPath("sub/env.json", "/state")).toBe("/state/sub/env.json");
  });
  test("a leading `..` hidden behind a backslash separator is still refused", () => {
    // Windows-shaped separators reach this on a cross-platform binary; splitting on BOTH is what
    // makes the guard a guard rather than a POSIX-only one.
    expect(() => resolveJsonOutPath("a\\..\\..\\x", "/state")).toThrow(/\.\./);
  });

  // ── review MEDIUM #3: a target the engine OWNS is refused ─────────────────────────────────────
  //
  // The traversal check was inherited from `archivedBriefingPath`; the NAMING constraint that made
  // that model safe (`YYYY-MM-DD.md`) was not. So every engine state file was an addressable target
  // and the state dir was the DEFAULT resolution root, while `emit` writes with truncating Bun.write:
  //   --json-out briefing.log → truncates the append-only launchd log that audit.lastBriefing grades
  //   --json-out last-run     → worse, because of ORDER: emit runs AFTER stampToday, so the run
  //                             delivers, stamps, then overwrites the marker with the envelope, and
  //                             the next tick regenerates the day.
  describe("a target the engine owns is refused", () => {
    test("every statePaths() file, by relative name AND by absolute path", () => {
      const env = withEnv();
      try {
        const sp = statePaths();
        const owned: [string, string][] = [
          ["briefing.log", sp.logPath], ["last-run", sp.markerPath], ["last-tick", sp.tickPath],
          ["briefing-latest.md", sp.latestBriefingPath], ["last-skip.json", sp.lastSkipPath],
          ["run.lock", sp.runLockPath], ["account-state.json", sp.accountStatePath],
          ["recap-campaigns.jsonl", sp.recapCampaignsPath],
        ];
        for (const [name, abs] of owned) {
          expect(`${name} (relative) → ${(() => { try { resolveJsonOutPath(name); return "allowed"; } catch { return "refused"; } })()}`)
            .toBe(`${name} (relative) → refused`);
          expect(`${name} (absolute) → ${(() => { try { resolveJsonOutPath(abs); return "allowed"; } catch { return "refused"; } })()}`)
            .toBe(`${name} (absolute) → refused`);
        }
        // The config file lives OUTSIDE the state dir (XDG), so only the absolute form can name it.
        expect(() => resolveJsonOutPath(sp.configPath)).toThrow();
      } finally { env.cleanup(); }
    });

    // Spec §4.10 1 "State-file registration" + §5.4 "State paths": tier B's record joins StatePaths, so
    // `status --json` lists it, and engineOwns, so `--json-out` can never truncate it.
    test("[TB-P14] the recap-campaigns record is a state path, and --json-out naming it is refused as \"recap-campaigns record\"", () => {
      const env = withEnv();
      try {
        const sp = statePaths();
        expect(sp.recapCampaignsPath.endsWith("recap-campaigns.jsonl")).toBe(true);
        expect(sp.recapCampaignsPath).toBe(join(env.stateDir, "recap-campaigns.jsonl"));
        expect(sp.recapCampaignsPath).toBe(recapCampaignsPath());   // one definition: marker.ts (D17)
        for (const target of ["recap-campaigns.jsonl", sp.recapCampaignsPath]) {   // bare under the state dir, and absolute
          expect(() => resolveJsonOutPath(target)).toThrow("is the engine's recap-campaigns record");
        }
      } finally { env.cleanup(); }
    });

    test("the state directory itself and the dated-archive directory are refused", () => {
      const env = withEnv();
      try {
        const sp = statePaths();
        expect(() => resolveJsonOutPath(sp.stateDir)).toThrow();
        expect(() => resolveJsonOutPath(sp.briefingsDir)).toThrow();
        expect(() => resolveJsonOutPath("briefings")).toThrow();
        // …and an archived briefing inside it, which a `--json-out briefings/2026-01-01.md` would clobber.
        expect(() => resolveJsonOutPath("briefings/2026-01-01.md")).toThrow();
        expect(() => resolveJsonOutPath(join(sp.briefingsDir, "2026-01-01.md"))).toThrow();
      } finally { env.cleanup(); }
    });

    test("an ordinary sidecar name still resolves — the guard did not become a ban", () => {
      const env = withEnv();
      try {
        const sp = statePaths();
        expect(resolveJsonOutPath("envelope.json")).toBe(join(sp.stateDir, "envelope.json"));
        expect(resolveJsonOutPath("sub/envelope.json")).toBe(join(sp.stateDir, "sub", "envelope.json"));
        expect(resolveJsonOutPath("/tmp/envelope.json")).toBe("/tmp/envelope.json");
        // A reserved BASENAME somewhere else entirely is fine — it is the engine's copy that is protected.
        expect(resolveJsonOutPath("/tmp/briefing.log")).toBe("/tmp/briefing.log");
      } finally { env.cleanup(); }
    });
  });
});

// ── golden: the flags change no content ──────────────────────────────────────────────────────────

describe("run --json / --json-out on a real fixture repo", () => {
  test("--json-out: the envelope's markdown is BYTE-IDENTICAL to the stdout of the same run", async () => {
    // The no-content-change proof, with zero clock volatility: one run, one render, two readers.
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const outPath = join(env.stateDir, "envelope.json");
    const cap = captureConsole();
    try {
      const code = await run(true, { provider: fakeProvider().provider, now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 }, { jsonOut: outPath });
      expect(code).toBe(0);
      const stdout = cap.out.join("\n");
      const envelope = JSON.parse(readFileSync(outPath, "utf8")) as RunEnvelope;
      expect(envelope.markdown).toBe(stdout);
      expect(envelope.delivered).toBe(true);
      expect(envelope.struct).not.toBeNull();
      // …and the file is the envelope, not the markdown: a shell reading it must not have to sniff.
      expect(envelope.schemaVersion).toBe(1);
      expect(envelope.paths.stateDir).toBe(env.stateDir);
    } finally { cap.restore(); env.cleanup(); }
  });

  test("--json: stdout is ONE JSON line, the markdown is inside it, and no line starts with the briefing header", async () => {
    const repo = await buildRepo([{ file: "b.txt", content: "b", isoDate: yesterdayISO() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const cap = captureConsole();
    try {
      const code = await run(true, { provider: fakeProvider().provider, now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 }, { json: true });
      expect(code).toBe(0);
      expect(cap.out).toHaveLength(1);                       // exactly one console.log — the envelope
      const stdout = cap.out[0]!;
      expect(stdout.includes("\n")).toBe(false);             // JSON.stringify escapes every newline
      const envelope = JSON.parse(stdout) as RunEnvelope;
      expect(envelope.markdown).toContain("briefing —");     // the briefing is CARRIED, not lost
      // THE LOG-CONTAMINATION GUARD. `audit.lastBriefing` anchors on a `☀️ … briefing —` header at a
      // LINE START; a single JSON line cannot present one, so this stdout can never become the text
      // the judge grades.
      expect([...stdout.matchAll(/^☀️.*[Bb]riefing —/gm)]).toHaveLength(0);
    } finally { cap.restore(); env.cleanup(); }
  });

  test("appending --json stdout to briefing.log does NOT re-anchor lastBriefing", async () => {
    // ⚠ STATED DEVIATION from the task's wording ("lastBriefing over a log containing it returns ''").
    // That is unreachable BY CONSTRUCTION: with no header anywhere, `lastBriefing` deliberately falls
    // back to returning the WHOLE text (audit.ts:222-225) rather than a truncated fragment. The real
    // risk it guards — the JSON becoming, or displacing, the graded briefing — is asserted directly.
    const repo = await buildRepo([{ file: "c.txt", content: "c", isoDate: yesterdayISO() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const cap = captureConsole();
    try {
      await run(true, { provider: fakeProvider().provider, now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 }, { json: true });
      const jsonLine = cap.out[0]!;
      cap.out.length = 0;
      const priorLog = [
        "☀️  Morning briefing — 2026-09-12\n\nolder briefing body\n",
        "☀️  briefing — 2026-09-13\n\nyesterday's body\n",
      ].join("\n");
      expect(lastBriefing(priorLog)).toStartWith("☀️  briefing — 2026-09-13");
      const contaminated = `${priorLog}\n${jsonLine}\n`;
      expect(lastBriefing(contaminated)).toStartWith("☀️  briefing — 2026-09-13");
    } finally { cap.restore(); env.cleanup(); }
  });

  test("--json-out leaves stdout as a plain run's, and --json's envelope carries that same markdown", async () => {
    // Cross-run comparison, so the one real-clock field is normalised — see `unstamp`.
    const repo = await buildRepo([{ file: "d.txt", content: "d", isoDate: yesterdayISO() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const deps = { now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 };
    try {
      const plainCap = captureConsole();
      let plain: string;
      try { await run(true, { ...deps, provider: fakeProvider().provider }); plain = plainCap.out.join("\n"); }
      finally { plainCap.restore(); }

      const outCap = captureConsole();
      let viaOut: string;
      const outPath = join(env.stateDir, "e2.json");
      try { await run(true, { ...deps, provider: fakeProvider().provider }, { jsonOut: outPath }); viaOut = outCap.out.join("\n"); }
      finally { outCap.restore(); }

      const jsonCap = captureConsole();
      let envelope: RunEnvelope;
      try {
        await run(true, { ...deps, provider: fakeProvider().provider }, { json: true });
        envelope = JSON.parse(jsonCap.out[0]!) as RunEnvelope;
      } finally { jsonCap.restore(); }

      expect(unstamp(viaOut)).toBe(unstamp(plain));            // --json-out: stdout untouched
      expect(unstamp(envelope.markdown)).toBe(unstamp(plain)); // --json: same briefing, relocated
      expect(plain).toContain("briefing —");                   // non-vacuous: there WAS a briefing
    } finally { env.cleanup(); }
  });

  test("neither flag changes the files written or the exit code", async () => {
    const repo = await buildRepo([{ file: "e.txt", content: "e", isoDate: yesterdayISO() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const cap = captureConsole();
    try {
      const outPath = join(env.stateDir, "e3.json");
      const code = await run(true, { provider: fakeProvider().provider, now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 }, { json: true, jsonOut: outPath });
      expect(code).toBe(0);
      expect(existsSync(join(env.stateDir, "briefing-latest.md"))).toBe(true);
      expect(existsSync(join(env.stateDir, "last-run"))).toBe(true);
      expect(existsSync(outPath)).toBe(true);
      // Both flags together: stdout is the envelope, and the file is the envelope too.
      expect(JSON.parse(cap.out[0]!).markdown).toBe(JSON.parse(readFileSync(outPath, "utf8")).markdown);
    } finally { cap.restore(); env.cleanup(); }
  });

  test("a gate skip still produces an envelope on BOTH channels — the mornings that matter most", async () => {
    // Nothing is delivered and nothing is rendered, so without this the GUI would learn only that the
    // process exited 0 — indistinguishable from a delivered briefing it failed to find.
    const env = withEnv();           // no config written at all
    const cap = captureConsole();
    try {
      const outPath = join(env.stateDir, "skip.json");
      const code = await run(false, { now: AFTER_FLOOR }, { json: true, jsonOut: outPath });
      expect(code).toBe(0);
      const envelope = JSON.parse(cap.out[0]!) as RunEnvelope;
      expect([envelope.skipReason, envelope.delivered, envelope.struct]).toEqual(["no-config", false, null]);
      expect(JSON.parse(readFileSync(outPath, "utf8")).skipReason).toBe("no-config");
    } finally { cap.restore(); env.cleanup(); }
  });

  test("--json-out refuses a traversal path BEFORE the tick heartbeat is written", async () => {
    // "Before any write" is the claim, so it is asserted against the FIRST thing run() writes.
    const env = withEnv({ repos: [], provider: PROV });
    const cap = captureConsole();
    try {
      await expect(run(true, { now: AFTER_FLOOR }, { jsonOut: "../../etc/x" })).rejects.toThrow(/\.\./);
      expect(existsSync(join(env.stateDir, "last-tick"))).toBe(false);
      expect(existsSync(join(env.stateDir, "last-run"))).toBe(false);
    } finally { cap.restore(); env.cleanup(); }
  });

  // ── review LOW #6: the provider-fail envelope carries the net record the shell just printed ───
  test("a provider failure's envelope reports the network, not null", async () => {
    // The catch block calls `emitNetMessage(err.net)` — the run HAS net information and puts it on
    // stderr — and then returned through `skip()`, whose gateEnvelope hardcoded `net: null`. A GUI
    // reading the envelope for the most operationally interesting failure could not tell whether the
    // network was up or how long the gate waited, though the CLI had just said so.
    const repo = await buildRepo([{ file: "n.txt", content: "n", isoDate: yesterdayISO() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const cap = captureConsole();
    try {
      const code = await run(true, {
        now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10,
        retryDelaysMs: [], sleep: async () => {},
        provider: { async generate() { throw new ProviderError("nonzero-exit", "boom"); } },
      }, { json: true });
      expect(code).toBe(1);
      const envelope = JSON.parse(cap.out[cap.out.length - 1]!) as RunEnvelope;
      expect(envelope.skipReason).toBe("provider-fail");
      expect(envelope.net).not.toBeNull();
      expect(typeof envelope.net!.online).toBe("boolean");
      expect(typeof envelope.net!.waitedMs).toBe("number");
    } finally { cap.restore(); env.cleanup(); }
  });

  // ── review LOW #8: a crash leaves a FRESH envelope, not the previous run's ────────────────────
  test("a non-ProviderError crash emits a `crashed` envelope and a skip record, then still rethrows", async () => {
    // Every other return in run() emits; the rethrow did not, so `--json-out <p>` left whatever was at
    // <p> from the PREVIOUS run untouched and a GUI polling the sidecar read yesterday's delivered
    // envelope as today's outcome. It also left no last-skip entry, making a crash indistinguishable
    // from "the scheduler never ran" — the question last-skip.json exists to answer.
    const repo = await buildRepo([{ file: "x.txt", content: "x", isoDate: yesterdayISO() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const outPath = join(env.stateDir, "sidecar.json");
    writeFileSync(outPath, `${JSON.stringify({ stale: true, delivered: true, runDate: "1999-01-01" })}\n`);
    const cap = captureConsole();
    try {
      await expect(run(true, {
        now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10,
        retryDelaysMs: [], sleep: async () => {},
        provider: { async generate() { throw new TypeError("crash"); } },
      }, { jsonOut: outPath })).rejects.toThrow("crash");     // ⚠ the crash exit is PRESERVED
      const written = JSON.parse(readFileSync(outPath, "utf8")) as RunEnvelope;
      expect(written.skipReason).toBe("crashed");             // …and the stale sidecar is gone
      expect(written.delivered).toBe(false);
      expect(written.exitCode).toBe(1);
      expect(JSON.parse(readFileSync(join(env.stateDir, "last-skip.json"), "utf8")).reason).toBe("crashed");
      expect(existsSync(join(env.stateDir, "last-run"))).toBe(false);   // nothing was stamped
    } finally { cap.restore(); env.cleanup(); }
  });

  // ── review MEDIUM #10: no diagnostic may land after the render ────────────────────────────────
  test("an unwritable --json-out is reported BEFORE the briefing, so the audit slice stays clean", async () => {
    // The plist points StandardOutPath AND StandardErrorPath at the same briefing.log, and
    // `lastBriefing` slices from the last "☀️ … briefing —" header to EOF. `emit` runs at the END of
    // the delivering path — after `console.log(rendered)` — so its write-failure line was measured
    // landing INSIDE that slice, i.e. fed to the audit judge as part of the briefing text it grades.
    // One array for both streams in call order, as account.failover.integration.test.ts:274 does.
    const repo = await buildRepo([{ file: "o.txt", content: "o", isoDate: yesterdayISO() }]);
    const env = withEnv({ repos: [repo], provider: PROV });
    const ro = join(env.stateDir, "ro");
    mkdirSync(ro, { recursive: true });
    const combined: string[] = [];
    const oLog = console.log, oErr = console.error;
    console.log = (...a: unknown[]) => { combined.push(a.map(String).join(" ")); };
    console.error = (...a: unknown[]) => { combined.push(a.map(String).join(" ")); };
    try {
      chmodSync(ro, 0o500);                                   // readable, not writable
      const code = await run(true, { provider: fakeProvider().provider, now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 }, { jsonOut: join(ro, "env.json") });
      expect(code).toBe(0);                                   // a DELIVERED run: the sidecar never moves the exit code
      const all = combined.join("\n");
      expect(all).toContain("--json-out");                    // …and the failure IS still reported
      // ⚠ THE PROPERTY: nothing about --json-out survives into what the audit judge would grade.
      expect(lastBriefing(all)).not.toContain("--json-out");
      // …asserted the other way too, so a test that stopped finding the header cannot pass vacuously.
      expect(all.indexOf("--json-out")).toBeLessThan(all.lastIndexOf("briefing —"));
      // …and the probe does NOT cry wolf on a nested path Bun.write would have created itself.
      const quiet = captureConsole();
      let ok = -1;
      try { ok = await run(true, { provider: fakeProvider().provider, now: AFTER_FLOOR, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 }, { jsonOut: join(env.stateDir, "deep", "nested", "env.json") }); }
      finally { quiet.restore(); }
      expect(ok).toBe(0);
      expect(quiet.err.join("\n")).not.toContain("--json-out");
      expect(existsSync(join(env.stateDir, "deep", "nested", "env.json"))).toBe(true);
    } finally {
      console.log = oLog; console.error = oErr;
      chmodSync(ro, 0o700); env.cleanup();
    }
  });

  test("--json-out at an engine state file is refused BEFORE the tick heartbeat — the log and the marker survive", async () => {
    // The two measured consequences, end to end. `briefing.log` is the append-only audit corpus and
    // `emit` writes with TRUNCATING Bun.write; `last-run` is overwritten AFTER stampToday, so the
    // next tick's readLastRunDate sees an envelope blob instead of today and regenerates the day.
    for (const target of ["briefing.log", "last-run", "run.lock", "last-skip.json", "briefing-latest.md"]) {
      const env = withEnv({ repos: [], provider: PROV });
      const cap = captureConsole();
      try {
        const victim = join(env.stateDir, target);
        writeFileSync(victim, "PRE-EXISTING CONTENT THAT MUST SURVIVE\n");
        await expect(run(true, { now: AFTER_FLOOR }, { jsonOut: target })).rejects.toThrow();
        expect(`${target} survived: ${readFileSync(victim, "utf8")}`)
          .toBe(`${target} survived: PRE-EXISTING CONTENT THAT MUST SURVIVE\n`);
        expect(`${target} wrote a heartbeat: ${existsSync(join(env.stateDir, "last-tick"))}`)
          .toBe(`${target} wrote a heartbeat: false`);
      } finally { cap.restore(); env.cleanup(); }
    }
  });
});
