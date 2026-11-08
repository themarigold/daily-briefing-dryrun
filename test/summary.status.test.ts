import "./fixtures/isolate-state";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { statusReport, statePaths, type StatusReport } from "../src/json";
import * as summaryConfig from "../src/summary/config";
import { readPageIdentity } from "../src/summary/page-version";
import { summaryRecordPath, type SummaryBinding, type SummaryRecord } from "../src/summary/store";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const DATE = "2026-01-11";
const NOW = () => new Date(2026, 0, 12, 0, 1);
const PROVIDER = { cli: "summary-status-never-run", argv: [], promptVia: "stdin" };
const PAGE = "▶ What you did\n   • [Orchard] Shipped the harvest view\n";
const ENV_KEYS = ["HOME", "XDG_CONFIG_HOME", "TMPDIR", "DAILY_BRIEFING_STATE_DIR"] as const;
let root: string;
let previous: (string | undefined)[];

beforeEach(() => {
  root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-summary-status-")));
  previous = ENV_KEYS.map((key) => process.env[key]);
  for (const [key, dir] of [["HOME", "home"], ["XDG_CONFIG_HOME", "xdg"], ["TMPDIR", "tmp"], ["DAILY_BRIEFING_STATE_DIR", "state"]] as const) {
    const path = join(root, dir);
    mkdirSync(path);
    process.env[key] = path;
  }
  writeConfig({ enabled: true });
});
afterEach(() => {
  ENV_KEYS.forEach((key, i) => {
    if (previous[i] === undefined) delete process.env[key]; else process.env[key] = previous[i];
  });
});

function writeConfig(aiSummary?: unknown): void {
  const path = statePaths().configPath;
  mkdirSync(join(process.env.XDG_CONFIG_HOME!, "daily-briefing"), { recursive: true });
  writeFileSync(path, JSON.stringify({ repos: [], provider: PROVIDER, morningTime: "06:45", ...(aiSummary === undefined ? {} : { aiSummary }) }));
}

async function seedPage(): Promise<SummaryBinding> {
  const paths = statePaths();
  mkdirSync(paths.briefingsDir);
  writeFileSync(paths.markerPath, DATE);
  writeFileSync(paths.latestBriefingPath, PAGE);
  // A delivery just before midnight, queried at 00:01 the next day.
  const delivered = new Date(2026, 0, 11, 23, 59);
  utimesSync(paths.latestBriefingPath, delivered, delivered);
  writeFileSync(paths.tickPath, "2026-01-11T23:59:00.000Z local=2026-01-11 today=1\n");
  writeFileSync(paths.logPath, "existing log\n");
  writeFileSync(join(paths.briefingsDir, `${DATE}.md`), PAGE);
  const identity = await readPageIdentity(paths.latestBriefingPath);
  if (identity === null) throw new Error("The fixture page needs a reliable identity");
  return { pageDate: DATE, ...identity };
}

function record(binding: SummaryBinding, state: SummaryRecord["state"] = "ready", warnings: SummaryRecord["warnings"] = []): SummaryRecord {
  return {
    schemaVersion: 1, ...binding, state, revision: state === "pending" ? 0 : 1,
    // This key is deliberately absent from PAGE: status uses the Rust reader's rules,
    // with membership deferred to the GUI, without another page read.
    projects: state === "ready" ? [{ key: "project:another-card", points: ["The harvest view is ready."] }] : [],
    goodMorningSentence: state === "ready" ? "The harvest view is ready for another pass." : null,
    warnings,
  };
}
function writeRecord(value: SummaryRecord): string {
  const path = summaryRecordPath(statePaths().briefingsDir, value);
  writeFileSync(path, JSON.stringify(value));
  return path;
}
function legacy(report: StatusReport): string {
  const { latestSummaryRevision, aiSummaryStatus, ...rest } = report;
  return JSON.stringify(rest);
}

/** Include bytes and no-follow metadata, including directories and links. Reads may change atime. */
function snapshot(): string {
  const entries: unknown[] = [];
  function walk(path: string): void {
    const stat = lstatSync(path, { bigint: true });
    const bytes = stat.isFile() ? createHash("sha256").update(readFileSync(path)).digest("hex") : null;
    entries.push([path, stat.ino.toString(), stat.mode.toString(), stat.size.toString(), stat.mtimeNs.toString(), stat.ctimeNs.toString(), bytes, stat.isSymbolicLink() ? readlinkSync(path) : null]);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) walk(join(path, name));
  }
  walk(root);
  return JSON.stringify(entries);
}
async function readOnly(deps: Parameters<typeof statusReport>[0] = {}): Promise<StatusReport> {
  const before = snapshot();
  const report = await statusReport({ now: NOW, ...deps });
  expect(snapshot()).toBe(before);
  return report;
}

describe("summary status without a sidecar", () => {
  test.each([undefined, {}, { enabled: false }])("off (%j) omits the revision and never reads page identity", async (value) => {
    writeFileSync(statePaths().latestBriefingPath, PAGE);
    writeFileSync(statePaths().markerPath, DATE);
    writeConfig(value);
    let calls = 0;
    const report = await readOnly({ readPageIdentity: async () => { calls++; throw new Error("must not read"); } });
    expect(report.aiSummaryStatus).toEqual({ enabled: false, warnings: [] });
    expect(report).not.toHaveProperty("latestSummaryRevision");
    expect(calls).toBe(0);
  });
  test("enabled, with no state files, reports enabled without creating a directory or a revision", async () => {
    const report = await readOnly();
    expect(report.aiSummaryStatus).toEqual({ enabled: true, warnings: [] });
    expect(report).not.toHaveProperty("latestSummaryRevision");
  });
  test("a missing config resolves off and preserves the existing config report", async () => {
    unlinkSync(statePaths().configPath);
    const report = await readOnly();
    expect(report.configExists).toBe(false);
    expect(report.configError).toBeNull();
    expect(report.aiSummaryStatus).toEqual({ enabled: false, warnings: [] });
  });
  test("an unparseable config keeps its existing error and resolves off", async () => {
    writeFileSync(statePaths().configPath, "{ broken");
    const report = await readOnly();
    expect(report.configError).not.toBeNull();
    expect(report.aiSummaryStatus).toEqual({ enabled: false, warnings: [] });
  });
});

describe.skipIf(process.platform === "win32")("bound summary status", () => {
  test.each(["pending", "ready", "unavailable"] as const)("%s exposes only identity, revision and state", async (state) => {
    const binding = await seedPage();
    const baseline = await readOnly();
    const value = record(binding, state, ["summary-text-omitted", "summary-usage-limit"]);
    writeRecord(value);
    let reads = 0;
    const report = await readOnly({ readPageIdentity: async (path) => {
      expect(path).toBe(statePaths().latestBriefingPath);
      reads++;
      return readPageIdentity(path);
    } });
    expect(report.latestSummaryRevision).toEqual({ pageHash: binding.pageHash, pageVersion: binding.pageVersion, revision: value.revision, state });
    expect(report.aiSummaryStatus).toEqual({ enabled: true, warnings: value.warnings });
    expect(legacy(report)).toBe(legacy(baseline));
    expect(reads).toBe(1);
    expect(JSON.stringify(report)).not.toContain("The harvest view is ready.");
  });
  test("the marker date finds a 23:59 delivery at 00:01; tomorrow's sidecar is ignored", async () => {
    const binding = await seedPage();
    writeRecord(record({ ...binding, pageDate: "2026-01-12" }, "unavailable", ["summary-unavailable"]));
    expect((await readOnly()).latestSummaryRevision).toBeUndefined();
    writeRecord(record(binding));
    const report = await readOnly();
    expect(report.lastRunDate).toBe(DATE);
    expect(report.latestSummaryRevision).toEqual({ pageHash: binding.pageHash, pageVersion: binding.pageVersion, revision: 1, state: "ready" });
    expect(report.aiSummaryStatus).toEqual({ enabled: true, warnings: [] });
  });
  test.each(["missing", "malformed", "impossible date"])("a %s marker supplies no revision", async (kind) => {
    const binding = await seedPage();
    writeRecord(record(binding, "unavailable", ["summary-unavailable"]));
    if (kind === "missing") unlinkSync(statePaths().markerPath);
    else writeFileSync(statePaths().markerPath, kind === "malformed" ? "not a date" : "2026-02-30");
    // Hand-named, since `summaryRecordPath` refuses this date: only the date check can refuse it.
    if (kind === "impossible date") {
      const name = `2026-02-30.${binding.pageHash}.${binding.pageVersion}.summary.json`;
      writeFileSync(join(statePaths().briefingsDir, name), JSON.stringify(record({ ...binding, pageDate: "2026-02-30" }, "ready")));
    }
    const report = await readOnly();
    expect(report).not.toHaveProperty("latestSummaryRevision");
    expect(report.aiSummaryStatus).toEqual({ enabled: true, warnings: [] });
  });
  test.each(["page", "sidecar"])("a FIFO %s supplies no revision and does not hang status", async (kind) => {
    const binding = await seedPage();
    const baseline = legacy(await statusReport({ now: NOW }));
    const paths = statePaths();
    const fifo = kind === "page" ? paths.latestBriefingPath : summaryRecordPath(paths.briefingsDir, binding);
    if (kind === "page") unlinkSync(fifo);
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const report = await readOnly();
    expect(report).not.toHaveProperty("latestSummaryRevision");
    expect(report.aiSummaryStatus).toEqual({ enabled: true, warnings: [] });
    if (kind === "sidecar") expect(legacy(report)).toBe(baseline);
  }, 5_000);
  test("the switch hides a ready record and its diagnostic", async () => {
    const binding = await seedPage();
    writeRecord(record(binding, "ready", ["summary-text-omitted"]));
    writeConfig({ enabled: false });
    const report = await readOnly();
    expect(report).not.toHaveProperty("latestSummaryRevision");
    expect(report.aiSummaryStatus).toEqual({ enabled: false, warnings: [] });
  });
  test("invalid config emits only the fixed status code and no stored diagnostic", async () => {
    const binding = await seedPage();
    writeRecord(record(binding, "unavailable", ["summary-unavailable"]));
    writeConfig({ enabled: "SUMMARY_CONFIG_SENTINEL" });
    const report = await readOnly();
    expect(report).not.toHaveProperty("latestSummaryRevision");
    expect(report.aiSummaryStatus).toEqual({ enabled: false, warnings: ["summary-config-invalid"] });
    expect(JSON.stringify(report)).not.toContain("SUMMARY_CONFIG_SENTINEL");
  });
  test("an off resolver's repeated warning is reported once", async () => {
    await seedPage();
    const resolver = spyOn(summaryConfig, "resolveAiSummary").mockReturnValue({ enabled: false, warnings: ["summary-config-invalid", "summary-config-invalid"] });
    try {
      expect((await readOnly()).aiSummaryStatus).toEqual({ enabled: false, warnings: ["summary-config-invalid"] });
    } finally { resolver.mockRestore(); }
  });
  test("warning codes are deduplicated across the resolved status inputs (a mocked state, pinning the merge)", async () => {
    const binding = await seedPage();
    writeRecord(record(binding, "unavailable", ["summary-unavailable", "summary-usage-limit"]));
    const resolver = spyOn(summaryConfig, "resolveAiSummary").mockReturnValue({ enabled: true, warnings: ["summary-config-invalid", "summary-config-invalid"] });
    try {
      expect((await readOnly()).aiSummaryStatus).toEqual({ enabled: true, warnings: ["summary-config-invalid", "summary-unavailable", "summary-usage-limit"] });
    } finally { resolver.mockRestore(); }
  });
  test.each(["old version", "other identity", "other date"])("a diagnostic for an %s never contributes", async (kind) => {
    const binding = await seedPage();
    if (kind === "old version") {
      writeRecord(record(binding, "unavailable", ["summary-unavailable"]));
      const replacement = join(root, "replacement.md");
      writeFileSync(replacement, PAGE);
      renameSync(replacement, statePaths().latestBriefingPath);
      const current = await readPageIdentity(statePaths().latestBriefingPath);
      expect(current?.pageHash).toBe(binding.pageHash);
      expect(current?.pageVersion).not.toBe(binding.pageVersion);
    } else {
      writeRecord(record({ ...binding, ...(kind === "other date" ? { pageDate: "2026-01-10" } : { pageHash: "a".repeat(64) }) }, "unavailable", ["summary-unavailable"]));
    }
    const report = await readOnly();
    expect(report).not.toHaveProperty("latestSummaryRevision");
    expect(report.aiSummaryStatus).toEqual({ enabled: true, warnings: [] });
  });
  test.each(["malformed", "symlinked", "oversized", "duplicate warnings", "arbitrary warning", "wrong binding", "invalid text", "unknown member"])("a %s record leaves all other report bytes unchanged and writes nothing", async (kind) => {
    const binding = await seedPage();
    const baseline = await readOnly();
    const value = record(binding, "ready", ["summary-text-omitted"]);
    const path = summaryRecordPath(statePaths().briefingsDir, binding);
    if (kind === "symlinked") {
      const target = join(root, "link-target.json");
      writeFileSync(target, JSON.stringify(value));
      symlinkSync(target, path);
    } else {
      const raw = kind === "malformed" ? "{ torn"
        : kind === "oversized" ? JSON.stringify(value) + " ".repeat(65536)
        : JSON.stringify({ ...value,
          ...(kind === "duplicate warnings" ? { warnings: ["summary-text-omitted", "summary-text-omitted"] } : {}),
          ...(kind === "arbitrary warning" ? { warnings: ["SECRET_ARBITRARY_WARNING"] } : {}),
          ...(kind === "wrong binding" ? { pageVersion: "b".repeat(64) } : {}),
          ...(kind === "invalid text" ? { goodMorningSentence: "https://example.invalid/private" } : {}),
          ...(kind === "unknown member" ? { rawResponse: "SECRET_RAW_RESPONSE" } : {}),
        });
      writeFileSync(path, raw);
    }
    const report = await readOnly();
    expect(report).not.toHaveProperty("latestSummaryRevision");
    expect(report.aiSummaryStatus).toEqual({ enabled: true, warnings: [] });
    expect(legacy(report)).toBe(legacy(baseline));
  });
  test.each(["torn", "throws"])("an identity reader that %s leaves all other report bytes unchanged", async (kind) => {
    const binding = await seedPage();
    const baseline = await readOnly();
    writeRecord(record(binding, "unavailable", ["summary-unavailable"]));
    const report = await readOnly({ readPageIdentity: async () => {
      if (kind === "throws") throw new Error("SECRET_IDENTITY_FAILURE");
      return null;
    } });
    expect(report).not.toHaveProperty("latestSummaryRevision");
    expect(report.aiSummaryStatus).toEqual({ enabled: true, warnings: [] });
    expect(legacy(report)).toBe(legacy(baseline));
  });
  test("a throwing resolver resolves unknown/off without affecting the rest of status", async () => {
    await seedPage();
    const baseline = await readOnly();
    const resolver = spyOn(summaryConfig, "resolveAiSummary").mockImplementation(() => { throw new Error("SECRET_RESOLVER_FAILURE"); });
    try {
      const report = await readOnly();
      expect(report).not.toHaveProperty("latestSummaryRevision");
      expect(report.aiSummaryStatus).toEqual({ enabled: false, warnings: [] });
      expect(legacy(report)).toBe(legacy(baseline));
    } finally { resolver.mockRestore(); }
  });
});
