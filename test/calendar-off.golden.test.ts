import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/calendar-off.golden.test.ts — the CALENDAR-OFF GOLDENS (v0.3.0 plan M0; spec r4 §1, §10).
//
// The calendar feature's hard invariant: with calendar OFF — the default, and every config today — the
// prompt, the briefing, the `run --json` envelope, the eval and the audit output are BYTE-IDENTICAL to
// before, with one user-directed exception: the audit report's features line gains `calendar=OFF`. These
// snapshots were captured against the code at the build's base (5ff9ba80cc, no calendar code), so every
// later milestone proves the invariant by keeping them green WITHOUT re-recording. A milestone that needs
// to re-record one of them has broken the invariant; that is a pause for the hub, not a snapshot update.
//
// What is pinned, and through which door:
//   • the PROMPT — `buildPrompt` over an existing fixture (pure), and the prompt the provider actually
//     receives from `runCore` (the eval's and `run`'s, end to end);
//   • the BRIEFING — `renderBriefing` over an existing fixture, an explicit `calendar: undefined` over the
//     whole render corpus (whose bytes `render.golden.test.ts` already freezes), and the end-to-end pages;
//   • the ENVELOPE — `envelopeFrom` + `redactEnvelope` over a fixture struct, and `run --json`'s stdout;
//   • the AUDIT — `scripts/audit.ts`'s whole report, its features line minus ONLY the ` · calendar=…` token,
//     with the judge prompt inside it (the judge is `echo`, so its "verdict" is the prompt it was sent), plus
//     `buildAuditPrompt` over fixed parts. (M0 dropped the whole features line; the M0 checkpoint review
//     found that left the line's other bytes unpinned, and the hub directed the one re-record that adds it,
//     2026-10-09 — the test keeps its M0 name because the name is the snapshot key.)
//   • the EVAL — the exact `GOLD_CASES` list and content, and the prompt the eval builds for three cases.
//
// DETERMINISM, and what it rests on. The clock is pinned (`setSystemTime`) for every run that reads it, and
// every fixture date derives from that one instant, so commit SHAs, windows, `state as of` and dates are
// fixed. Git runs with the global and system configs off, so a developer's `~/.gitconfig` cannot shape the
// output. What still varies per run is replaced by a NAMED placeholder, never a wildcard: temp-dir paths
// and their basenames (repo labels), the state and config dirs, and the hostname. The zone must be UTC —
// `bun test`'s default; a run with `TZ` set fails loudly here rather than diffing confusingly.
//
// ⚠ `setSystemTime` is PROCESS-WIDE (test/postcheck.suggestion-volume-sameday.test.ts says why that bites):
// every pin is undone in a `finally` and again in `afterEach`, and every pinned test has a generous budget so
// a slow machine does not time it out mid-run with the clock still frozen.
import { test, expect, describe, afterEach, setSystemTime } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildPrompt } from "../src/generator";
import { renderBriefing } from "../src/render";
import { envelopeFrom, redactEnvelope } from "../src/json";
import { buildAuditPrompt } from "../src/audit";
import { run } from "../src/main";
import { runCase } from "../src/eval/run-case";
import { echoProvider } from "../src/eval/echo";
import { GOLD_CASES } from "../src/eval/cases";
import type { CoreResult } from "../src/core";
import type { BriefingStruct, DoneItem, Provider } from "../src/types";
import { main as auditMain } from "../scripts/audit";
import { MORNING_COMMITS, MORNING_STRUCT } from "./fixtures/campaign-morning";
import { RENDER_CORPUS } from "./fixtures/render-corpus";
import { buildRepo, commitFiles, branchCommit, mergeBranchWith } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

/** THE instant every pinned run lives at: a Wednesday, 18:00 UTC — after the default 07:20 floor, and late
 *  enough in the day for same-day commits on both sides of a 15:00 generation stamp. */
const PIN = new Date("2026-09-16T18:00:00.000Z");
const PIN_DATE = "2026-09-16";
const YESTERDAY = "2026-09-15";
const E2E_TIMEOUT = 60_000;

afterEach(() => { setSystemTime(); });

/** The goldens are UTC bytes. Fail with the reason instead of a wall of diff when a run sets `TZ`. */
function requireUtc(): void {
  const offsets = [PIN.getTimezoneOffset(), new Date(2026, 0, 15).getTimezoneOffset()];
  if (offsets.some((o) => o !== 0)) {
    throw new Error(`the calendar-off goldens are pinned in UTC (bun test's default zone), but this run's zone is offset ${offsets.join("/")} min — unset TZ and re-run`);
  }
}

type World = { stateDir: string; cfgHome: string };

/** Run `body` at PIN, with a private state dir and config dir and git's global/system config off; every
 *  change is undone afterwards (the isolation variables are restored by assignment, never cleared). */
async function inPinnedWorld<T>(body: (w: World) => Promise<T>): Promise<T> {
  requireUtc();
  const prevState = process.env.DAILY_BRIEFING_STATE_DIR!, prevXdg = process.env.XDG_CONFIG_HOME!;
  const prevGitGlobal = process.env.GIT_CONFIG_GLOBAL, prevGitNoSystem = process.env.GIT_CONFIG_NOSYSTEM;
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-caloff-state-")));
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-caloff-cfg-")));
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.GIT_CONFIG_GLOBAL = "/dev/null";
  process.env.GIT_CONFIG_NOSYSTEM = "1";
  setSystemTime(PIN);
  try {
    return await body({ stateDir, cfgHome });
  } finally {
    setSystemTime();
    process.env.DAILY_BRIEFING_STATE_DIR = prevState;
    process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevGitGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = prevGitGlobal;
    if (prevGitNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM; else process.env.GIT_CONFIG_NOSYSTEM = prevGitNoSystem;
  }
}

/** Replace every run-specific string with its named placeholder: each path in both its given and its
 *  resolved spelling (macOS `/var` vs `/private/var`), longest first so a path is never half-replaced. */
function placeholders(pairs: [string, string][]): (s: string) => string {
  const all: [string, string][] = [];
  for (const [value, name] of pairs) {
    all.push([value, name]);
    try { const real = realpathSync(value); if (real !== value) all.push([real, name]); } catch { /* not a path */ }
  }
  all.sort((a, b) => b[0].length - a[0].length);
  return (s) => all.reduce((acc, [value, name]) => acc.split(value).join(name), s);
}

/** The hostname, which `runCore` stamps into `machineScope` and the page header. Replaced only where it
 *  is printed, so a short hostname cannot rewrite unrelated text. */
function unhost(s: string): string {
  const h = hostname();
  return s
    .split(`(this machine: ${h})`).join("(this machine: {{HOST}})")
    .split(`"machineScope":${JSON.stringify(h)}`).join(`"machineScope":"{{HOST}}"`);
}

function captureConsole() {
  const out: string[] = [], err: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return { out, err, restore: () => { console.log = oLog; console.error = oErr; } };
}

/** A provider that records every prompt it is sent and answers like `inner`. */
function recording(inner: Provider): { provider: Provider; prompts: string[] } {
  const prompts: string[] = [];
  return { prompts, provider: { generate: async (p: string) => { prompts.push(p); return inner.generate(p); } } };
}

/** The golden morning repo: two window commits and a PR merge yesterday, two same-day commits (09:00 and
 *  16:00), and an untracked file — enough for recap, the merge foot, "Today so far", the uncommitted line
 *  and, for the audit, a same-day miss, a post-generation landing and an unsurfaced working state. All
 *  dates are literal, so the SHAs are the same on every run and every machine. */
async function goldenMorningRepo(): Promise<{ dir: string; parserSha: string }> {
  const dir = await buildRepo([{ file: "src/parser.ts", content: "export const parse = (s: string) => s;\n", isoDate: `${YESTERDAY}T10:00:00Z` }]);
  const parserSha = await commitFiles(dir, ["src/parser.ts", "test/parser.test.ts"], {
    message: "fix(parser): handle empty input", isoDate: `${YESTERDAY}T11:00:00Z`, content: "export const parse = (s: string) => s ?? '';\n",
  });
  await branchCommit(dir, "feat/export", "src/export.ts", `${YESTERDAY}T12:00:00Z`);
  await mergeBranchWith(dir, "feat/export", "Merge pull request #12 from someone/feat/export", `${YESTERDAY}T12:30:00Z`);
  await commitFiles(dir, ["src/today.ts"], { message: "feat: same-day morning work", isoDate: `${PIN_DATE}T09:00:00Z` });
  await commitFiles(dir, ["src/later.ts"], { message: "chore: after the briefing", isoDate: `${PIN_DATE}T16:00:00Z` });
  writeFileSync(join(dir, "notes.md"), "draft\n");
  return { dir, parserSha };
}

function writeConfig(cfgHome: string, cfg: Record<string, unknown>): void {
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify(cfg));
}

// ── the prompt ─────────────────────────────────────────────────────────────────────────────────────

describe("calendar off: the prompt", () => {
  test("buildPrompt over the campaign-morning fixture", () => {
    requireUtc();
    const ctx = { repos: [{ repo: "/work/accountant_ai", summary: "8 commits", activities: MORNING_COMMITS }] };
    expect(buildPrompt(ctx, [])).toMatchSnapshot("plain");
    const done: DoneItem[] = [
      { label: "accountant_ai", subject: "fix(queue): same-day retry tweak", whenMs: Date.parse("2026-09-24T09:00:00Z") },
      { label: "quant_stocks", subject: "docs: note the sharpe guard", whenMs: Date.parse("2026-09-24T10:30:00Z") },
    ];
    expect(buildPrompt({ ...ctx, note: "1 repo trimmed to fit the budget" }, [], undefined, done)).toMatchSnapshot("with a note and an ALREADY DONE block");
  });
});

// ── the briefing ───────────────────────────────────────────────────────────────────────────────────

describe("calendar off: the rendered briefing", () => {
  test("renderBriefing over the campaign-morning struct", () => {
    expect(renderBriefing(MORNING_STRUCT)).toMatchSnapshot();
  });

  test("an explicit `calendar: undefined` renders every corpus struct byte-identically", () => {
    // The corpus's bytes are frozen by render.golden.test.ts; this pins that an absent-by-undefined field
    // is the same as an absent field — the shape a spread over a calendar-off result produces.
    expect(RENDER_CORPUS.length).toBeGreaterThanOrEqual(11);   // later milestones may add corpus entries
    for (const { name, struct } of RENDER_CORPUS) {
      const off: BriefingStruct = { ...struct, calendar: undefined };
      expect(`${name}: ${renderBriefing(off) === renderBriefing(struct)}`).toBe(`${name}: true`);
    }
  });
});

// ── the envelope ───────────────────────────────────────────────────────────────────────────────────

describe("calendar off: the run --json envelope", () => {
  test("envelopeFrom + redactEnvelope over the rich corpus struct, serialised as `run --json` prints it", async () => {
    await inPinnedWorld(async ({ stateDir, cfgHome }) => {
      const struct = RENDER_CORPUS.find((c) => c.name === "rich")!.struct;
      const r: CoreResult = {
        emptyWindow: false, blocked: false, discoveryBlocked: false, offlineSkipped: false,
        net: { online: true, waitedMs: 0 }, struct, rawText: "## RESUME\n- [r] x", promptText: "p",
        ctx: { repos: [] }, units: [], activities: [], repos: [], runDate: struct.date,
        discIssues: [], extrIssues: [], warnings: ["a pipeline warning"], today: [],
        windowStartUtc: "2026-09-15T00:00:00.000Z",
      };
      const line = JSON.stringify(redactEnvelope(envelopeFrom(r, renderBriefing(struct), 0)));
      expect(JSON.parse(line).struct).not.toHaveProperty("calendar");
      expect(placeholders([[stateDir, "{{STATE_DIR}}"], [cfgHome, "{{CONFIG_DIR}}"]])(line)).toMatchSnapshot();
    });
  });

  test("`run --json` end to end: the envelope on stdout and the prompt the provider received", async () => {
    await inPinnedWorld(async ({ stateDir, cfgHome }) => {
      const { dir } = await goldenMorningRepo();
      writeConfig(cfgHome, {
        repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30, author: { emails: ["test@example.com"] },
        provider: { cli: "echo", argv: [], promptVia: "stdin" },
      });
      const rec = recording(echoProvider());
      const cap = captureConsole();
      let code: number;
      try {
        code = await run(true, { provider: rec.provider, now: () => PIN, netProbe: async () => true, netGraceMs: 30, netPollMs: 10 }, { json: true });
      } finally { cap.restore(); }
      expect(code).toBe(0);
      expect(cap.out).toHaveLength(1);
      expect(rec.prompts).toHaveLength(1);
      const clean = placeholders([[dir, "{{REPO_DIR}}"], [basename(dir), "{{REPO_LABEL}}"], [stateDir, "{{STATE_DIR}}"], [cfgHome, "{{CONFIG_DIR}}"]]);
      const envelope = JSON.parse(cap.out[0]!);
      expect(envelope.delivered).toBe(true);
      expect(envelope.struct).not.toHaveProperty("calendar");
      expect(clean(unhost(cap.out[0]!))).toMatchSnapshot("envelope");
      expect(clean(rec.prompts[0]!)).toMatchSnapshot("prompt");
    });
  }, E2E_TIMEOUT);
});

// ── the audit ──────────────────────────────────────────────────────────────────────────────────────

const FEATURES_LINE_PREFIX = "- features (deployed config): ";
/** The ONE token the calendar-off audit may differ by (spec §10, user decision 15c): ` · calendar=OFF`, or
 *  ` · calendar=on`, as a whole ` · `-separated item — followed by the next separator or the line's end. */
const CALENDAR_FEATURE_TOKEN_RE = / · calendar=(?:OFF|on)(?= · |$)/;

describe("calendar off: the audit", () => {
  test("scripts/audit.ts's whole report, minus ONLY the features line, with the judge prompt inside it", async () => {
    await inPinnedWorld(async ({ stateDir, cfgHome }) => {
      const { dir, parserSha } = await goldenMorningRepo();
      // `echo` as the judge, prompt as an argument: the report's judge section is then the exact prompt the
      // judge was sent — `buildAuditPrompt` as `main` assembles it, git ground truth and all.
      writeConfig(cfgHome, {
        repos: [dir], excludeCommitPatterns: [], lookbackCapDays: 30, author: { emails: ["test@example.com"] },
        provider: { cli: "echo", argv: [], promptVia: "arg", harden: false },
      });
      // The briefing under audit: one real citation, one that resolves nowhere, no mention of the same-day
      // commit at 09:00 (before the 15:00 stamp) and no mention of the repo's untracked file — so the
      // three text checks calendar's M6a will touch (`extractCitedShas`, `missingSameDay`, `coverageGaps`)
      // all produce output here.
      const briefing: BriefingStruct = {
        date: PIN_DATE, machineScope: "fixture", provider: "echo", stateAsOf: "15:00", morningFloor: "07:20",
        resume: [{ repo: "parser", text: "finish the empty-input handling" }],
        recap: [
          { repo: "parser", text: "handled empty input in the parser", evidence: parserSha.slice(0, 7) },
          { repo: "parser", text: "a change nobody made", evidence: "f00dfa1" },
        ],
        suggestions: [{ text: "[parser] add a test for whitespace-only input in test/parser.test.ts" }],
      };
      const briefingPath = join(stateDir, "briefing-under-audit.md");
      writeFileSync(briefingPath, renderBriefing(briefing));
      const cap = captureConsole();
      try { await auditMain([briefingPath]); } finally { cap.restore(); }
      const report = cap.out.join("\n");
      const lines = report.split("\n");
      const features = lines.filter((l) => l.startsWith(FEATURES_LINE_PREFIX));
      expect(features).toHaveLength(1);                     // exactly one features line — the exemption's target
      // The features line is KEPT, minus only the one user-directed token (spec §10: `calendar=OFF` / `on`),
      // so the rest of it — every other feature and the ` · ` separator — stays pinned. Dropping the whole
      // line (the M0 version) let a separator change pass every golden (M0 checkpoint review, 2026-10-09).
      // At M0/M1 the token is not printed yet and this is a no-op; after M6a it removes exactly the token.
      const kept = lines.map((l) => (l.startsWith(FEATURES_LINE_PREFIX) ? l.replace(CALENDAR_FEATURE_TOKEN_RE, "") : l)).join("\n");
      // Non-vacuous: the judge section really is the judge prompt, and the three text checks fired.
      expect(kept).toContain("You are an ADVERSARIAL evaluator");
      expect(kept).toContain("SAME-DAY BLINDNESS");
      expect(kept).toContain("UNCOMMITTED NOT SURFACED");
      expect(kept).toContain("FABRICATED SHA(s)");
      const clean = placeholders([[dir, "{{REPO_DIR}}"], [basename(dir), "{{REPO_LABEL}}"], [stateDir, "{{STATE_DIR}}"], [cfgHome, "{{CONFIG_DIR}}"]]);
      expect(clean(kept)).toMatchSnapshot();
    });
  }, E2E_TIMEOUT);

  test("buildAuditPrompt over fixed parts: no popup; popup and quoted turns; popup unavailable", () => {
    const briefing = renderBriefing(RENDER_CORPUS.find((c) => c.name === "rich")!.struct);
    const gitFacts = "### quant_stocks\nin-window commits (1) the briefing SHOULD recap:\n  abc1234 feat: audit notes\ncurrent resumption state:\n  (none)\n";
    const deterministic = ["SAME-DAY BLINDNESS: 1/2 of your 2026-09-16 commits are absent from the briefing: def5678", "(FYI) a note"];
    expect(buildAuditPrompt({ briefing, gitFacts, popup: null, deterministic })).toMatchSnapshot("no popup configured");
    expect(buildAuditPrompt({
      briefing, gitFacts, popup: "VAULT: 3 notes\nCALENDAR (popup): standup 09:00", popupConfigured: true, deterministic: [],
      whyGroundTruth: [{ quotation: "finish the sharpe audit", sessionId: "0123456789abcdef", tsUtc: "2026-09-16T08:00:00Z" }],
    })).toMatchSnapshot("popup and quoted turns");
    expect(buildAuditPrompt({ briefing, gitFacts, popup: null, popupConfigured: true, deterministic })).toMatchSnapshot("popup configured but unavailable");
  });
});

// ── the eval ───────────────────────────────────────────────────────────────────────────────────────

describe("calendar off: the eval baseline", () => {
  test("GOLD_CASES is exactly these eight cases, in this order, with this content", () => {
    // Eval-integrity: calendar's eval set (M6b) is SEPARATE and must leave this list, and every case in it,
    // untouched. The name list is spelled out so a diff names the case; the content snapshot catches an edit
    // to any field of any case.
    expect(GOLD_CASES.map((c) => c.name)).toEqual([
      "day1-fabrication", "day8-tie", "nested-root", "monorepo-detect", "day5-worktrees", "no-files-date",
      "transcript-why", "same-day-recency",
    ]);
    expect(JSON.stringify(GOLD_CASES, null, 2)).toMatchSnapshot();
  });

  // Three cases (the brief asks for 2–3), chosen for distinct prompt shapes: one catch-all unit; nested
  // sub-project roots; same-day commits (the ALREADY DONE block). All eight are pinned by name and content
  // above, and every one still runs end to end in test/eval/gold.test.ts.
  for (const name of ["day1-fabrication", "nested-root", "same-day-recency"]) {
    test(`the eval's prompt and page for ${name}`, async () => {
      await inPinnedWorld(async () => {
        const gc = GOLD_CASES.find((c) => c.name === name)!;
        const rec = recording(echoProvider());
        const { pass, struct } = await runCase(gc, rec.provider);
        expect(pass).toBe(true);
        expect(rec.prompts).toHaveLength(1);
        expect(struct).not.toHaveProperty("calendar");
        // The harness builds its repo under a fresh `mkdtemp` dir, `dba-eval-repo-XXXXXX`, and a catch-all
        // unit is labelled with that basename (sub-project units carry their root's name instead).
        const clean = (s: string) => s.replace(/\bdba-eval-repo-[A-Za-z0-9]{6}\b/g, "{{REPO_LABEL}}");
        const prompt = rec.prompts[0]!;
        expect(prompt).not.toContain(tmpdir());              // nothing else run-specific reaches the prompt
        expect(clean(prompt)).toMatchSnapshot("prompt");
        expect(clean(unhost(renderBriefing(struct)))).toMatchSnapshot("page");
      });
    }, E2E_TIMEOUT);
  }
});
