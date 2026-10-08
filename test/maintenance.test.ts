// Slice 1.5 T4.7 — maintenance with transcript dependencies.
// ⚠ The plan notes NO harness existed for uninstall. This writes one: it CREATES every artifact
// first, then asserts removal — a harness that only checks "the dir is gone" would pass against an
// uninstall that never knew those files existed.
import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { archivedBriefingPath } from "../src/marker";
import { join, dirname, basename, resolve } from "node:path";
import { auditFilesToPrune, AUDIT_RETENTION, lastBriefing, LAST_BRIEFING_SCAN_BYTES } from "../src/audit";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

test("T4.7: uninstall removes briefing.log.1, audit-*.md and transcript-health.json", async () => {
  const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-uninst-")));
  const dir = join(base, "support");
  const home = join(base, "home");
  const stubs = join(base, "bin");
  const log = join(base, "calls.log");
  for (const d of [dir, home, stubs]) mkdirSync(d);
  // Never written (Batch 2, spec 3.6.6): a plist with no usable engine now STOPS the script, a case
  // test/uninstall.test.ts covers. The path is still passed as DBA_TEST_PLIST, so the script's PLIST can
  // never resolve to the real LaunchAgents file (test/isolation.meta.test.ts demands both variables).
  const plist = join(base, "fake.plist");
  const artifacts = [
    "daily-briefing", "wake-schedule.json", "briefing.log", "briefing-latest.md",
    "briefing.log.1", "transcript-health.json", "audit-2026-07-30.md", "audit-2026-07-31.md",
    "update-check.json",   // Phase E (E11): the opt-in update check's record
  ];
  for (const f of artifacts) writeFileSync(join(dir, f), "x");
  // The dated archive is a DIRECTORY — a glob `rm -f` would leave the user's whole briefing history
  // behind, which is exactly the "removal was never added" defect uninstall.sh records for
  // briefing.log.1. Asserted separately below because `artifacts` is a flat file list.
  // Derived from the implementation, NOT the literal "briefings": if the archive directory is ever
  // renamed, this test must follow it rather than silently creating-and-removing a directory the app
  // no longer writes to, which would pass while nothing cleaned the real one.
  const archiveDir = basename(dirname(archivedBriefingPath("2026-08-14")));
  mkdirSync(join(dir, archiveDir), { recursive: true });
  writeFileSync(join(dir, archiveDir, "2026-08-14.md"), "x");
  expect(existsSync(plist)).toBe(false);
  for (const f of artifacts) expect(existsSync(join(dir, f))).toBe(true);   // created, so removal is meaningful

  // The same interlocks as test/uninstall.test.ts (Phase E E10, Checkpoint M7 F2), so the run never reaches
  // a real machine-wide tool (R10). PATH is the stub directory ALONE: recording stubs for the tools
  // uninstall.sh drives by name, plus links to the two real utilities it needs (rm, grep). The real tools are
  // not on PATH at all, so a stub that went missing is "command not found", never the real thing. The env is
  // explicit (nothing inherited), HOME is scratch, and bash is spawned by absolute path. launchd's stub runs
  // nothing: it records its argv, answers the read-only verbs (`print`, `list`) "Could not find service"
  // with exit 113, and refuses every other verb (exit 99). The `daily-briefing` above is not executable, so
  // with no record and no plist the script makes its one read-only launchd check (spec 3.6.6), and the
  // not-found answers let the run carry on. Names by concatenation for the isolation scanner.
  const LAUNCHD = "launch" + "ctl";
  const KEYCHAIN = "sec" + "urity";
  const record = (name: string) => `{ printf '%s' "${name}"; for a in "$@"; do printf '\\t%s' "$a"; done; printf '\\n'; } >> "$STUB_LOG"`;
  writeFileSync(join(stubs, LAUNCHD), [
    "#!/bin/sh",
    record(LAUNCHD),
    'case "$1" in print|list) echo "Could not find service" >&2; exit 113 ;; esac',
    'echo "stub: refused, not a read-only verb: $*" >&2',
    "exit 99",
    "",
  ].join("\n"), { mode: 0o755 });
  // Never called without --remove-signing-identity, so it refuses whatever it is sent.
  writeFileSync(join(stubs, KEYCHAIN), `#!/bin/sh\n${record(KEYCHAIN)}\nexit 99\n`, { mode: 0o755 });
  writeFileSync(join(stubs, "pmset"), `#!/bin/sh\n${record("pmset")}\nexit 0\n`, { mode: 0o755 });
  for (const real of ["rm", "grep"]) symlinkSync(Bun.which(real)!, join(stubs, real));

  // prove-it 3b: the refusal is real — a verb other than print/list sent to the stub (by absolute path; it
  // runs nothing) is recorded and refused, so the "only print and list" check after the run is not vacuous.
  const probeLog = join(base, "probe.log");
  expect(readFileSync(join(stubs, LAUNCHD), "utf8")).toContain("stub: refused, not a read-only verb");   // the stub, not a tool
  const probe = Bun.spawnSync([join(stubs, LAUNCHD), "bootout", "gui/0/probe"], { env: { STUB_LOG: probeLog }, stdout: "pipe", stderr: "pipe" });
  expect(probe.exitCode).toBe(99);
  expect(readFileSync(probeLog, "utf8")).toBe(`${LAUNCHD}\tbootout\tgui/0/probe\n`);

  const BASH = Bun.which("bash")!;
  const SCRIPT = join(resolve(import.meta.dir, ".."), "scripts/uninstall.sh");
  const env: Record<string, string> = { PATH: stubs, HOME: home, DBA_TEST_DIR: dir, DBA_TEST_PLIST: plist, STUB_LOG: log };
  // The interlocks, asserted before anything runs: PATH is the stub directory alone, each name resolves to
  // its stub or link there, and every redirected path is scratch.
  expect(BASH.startsWith("/")).toBe(true);
  expect(env.PATH).toBe(stubs);
  for (const name of [LAUNCHD, KEYCHAIN, "pmset", "rm", "grep"]) expect(Bun.which(name, { PATH: env.PATH })).toBe(join(stubs, name));
  expect([env.HOME, env.DBA_TEST_DIR, env.DBA_TEST_PLIST].every((p) => p!.startsWith(base + "/"))).toBe(true);
  const proc = Bun.spawn([BASH, SCRIPT], { cwd: base, env, stdout: "pipe", stderr: "pipe" });
  const code = await proc.exited;
  expect(code, await new Response(proc.stderr).text()).toBe(0);
  // Only the read-only verbs reached launchd's stub — the one check, once each — and nothing reached the
  // keychain tool.
  const calls = existsSync(log) ? readFileSync(log, "utf8").trimEnd().split("\n").filter(Boolean).map((l) => l.split("\t")) : [];
  const launchd = calls.filter((c) => c[0] === LAUNCHD);
  for (const c of launchd) expect(["print", "list"]).toContain(c[1]!);
  expect(launchd.map((c) => c[1])).toEqual(["print", "print", "list"]);
  expect(calls.filter((c) => c[0] === KEYCHAIN)).toEqual([]);
  // This checks 9 of the script's 16 names and plants no survivor (M9 LOW pass, L17). The same path — no record,
  // no plist, no new enough engine, the one read-only check answering not found — is decided BYTE FOR BYTE in
  // test/uninstall.test.ts, against a support dir seeded with every name the desktop app's list removes plus
  // near misses no list holds: "uninstall.sh: the one-shot read-only check …" › "each reports not found -> it
  // carries on" and "3.1.5's not-found rule …" (each `left(fx)` = ALL_REMOVED), and the parity cases ›
  // "ALL_REMOVED and nothingRemoved decide both ways". Its fixture is that file's own, so it is not repeated here.
  const left = readdirSync(dir);
  for (const f of artifacts) expect(left).not.toContain(f);
  expect(left).not.toContain(archiveDir);
});

// ⚠ The plan's exact receipt: 61 audit files ⇒ 60 remain.
test("T4.7: audit retention keeps the newest 60 and prunes the rest", () => {
  const names: string[] = [];
  for (let i = 1; i <= 61; i++) names.push(`audit-2026-${String(Math.floor((i - 1) / 31) + 6).padStart(2, "0")}-${String(((i - 1) % 31) + 1).padStart(2, "0")}.md`);
  const pruned = auditFilesToPrune(names);
  expect(names.length).toBe(61);
  expect(pruned.length).toBe(1);
  expect(names.length - pruned.length).toBe(AUDIT_RETENTION);
  // The OLDEST goes: `audit-YYYY-MM-DD.md` sorts lexicographically == chronologically.
  expect(pruned[0]).toBe([...names].sort()[0]);

  expect(auditFilesToPrune(names.slice(0, 60))).toEqual([]);   // exactly at the limit: nothing pruned
  // Non-audit files are never touched, whatever else lives in the support dir.
  expect(auditFilesToPrune(["briefing.log", "daily-briefing", "transcript-health.json"])).toEqual([]);
});

test("T4.7: lastBriefing scans a bounded tail, and still returns a WHOLE briefing", () => {
  const header = (d: string) => `☀️  Morning briefing — ${d}  (this machine: t)\n`;
  const one = (d: string) => header(d) + "body ".repeat(50) + "\n";

  // Normal case: the last of several blocks.
  expect(lastBriefing(one("2026-07-29") + one("2026-07-30")).startsWith(header("2026-07-30"))).toBe(true);

  // A log far larger than the bound: only the tail is scanned, and the result is a complete block.
  const huge = "noise\n".repeat(LAST_BRIEFING_SCAN_BYTES / 3) + one("2026-07-31");
  expect(huge.length).toBeGreaterThan(LAST_BRIEFING_SCAN_BYTES);
  const got = lastBriefing(huge);
  expect(got.startsWith(header("2026-07-31"))).toBe(true);

  // ⚠ The fallback that keeps the bound safe. The discriminating shape needs TWO headers, both
  // OUTSIDE the scanned tail: without the fallback the tail contains no header at all and the
  // function returns a raw fragment — handing the audit a briefing missing its head, which is worse
  // than doing no bounding. (A one-header fixture does NOT discriminate: it returns the whole text
  // either way. Measured — removing the fallback left that version green.)
  const twoFarBack = one("2026-07-01") + one("2026-07-02") + "z".repeat(LAST_BRIEFING_SCAN_BYTES + 10);
  const fell = lastBriefing(twoFarBack);
  expect(fell.startsWith(header("2026-07-02"))).toBe(true);   // the LAST briefing, whole
  expect(fell.startsWith("z")).toBe(false);                   // never a headerless fragment
});
