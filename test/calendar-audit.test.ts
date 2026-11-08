import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/calendar-audit.test.ts — THE AUDIT AND THE CALENDAR SECTION (v0.3.0 plan M6a, user-directed; spec r4 §10).
//
// Four things are pinned here:
//   1. the SECTION-BOUNDED exclusion — `extractCitedShas`, `missingSameDay` and `coverageGaps` skip the calendar
//      heading and the `CALENDAR_LINE_PREFIX` lines up to the next `▶ ` line, and NOTHING else: a briefing with no
//      section is the same string, a stray prefixed line outside the section is scored as before;
//   2. the UNLOCKED projection — built from fixed strings and a strict span, so no title, location or feed zone
//      name from the frozen fixture survives it;
//   3. `featuresLine` prints `calendar=OFF` / `calendar=on` through the engine's resolver;
//   4. END TO END through `scripts/audit.ts`'s `main`: real hardened providers against fake `claude` CLIs that log
//      every spawn's argv and stdin — a locked spawn gets the titles, a CLI that REJECTS the flags (and
//      `harden: false`) gets none of them on stdin or argv, and the report states residual 16a.
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  extractCitedShas, missingSameDay, coverageGaps, withoutCalendarSection, calendarSectionLineIndexes,
  projectCalendarLine, calendarJudgeViews, buildAuditPrompt, featuresLine, CALENDAR_JUDGE_RESIDUAL_NOTICE,
} from "../src/audit";
import { CALENDAR_HEADING, CALENDAR_LINE_PREFIX } from "../src/calendar/render-contract";
import { calEventLine, renderBriefing, renderCalendarSection } from "../src/render";
import type { BriefingStruct } from "../src/types";
import type { CalendarStruct, CalendarStructEvent } from "../src/calendar/types";
import { SECTION_SOURCES } from "./fixtures/calendar/contract";
import { main as auditMain } from "../scripts/audit";
import { buildRepo } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

/** The frozen rendered-section fixture's variants, by name (the M0 contract file's own format). */
function fixtureSections(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let name: string | undefined;
  for (const line of readFileSync(join(import.meta.dir, "fixtures/calendar/rendered-section.txt"), "utf8").split("\n")) {
    if (line.startsWith("#")) continue;
    if (line.startsWith("@@ ")) { name = line.slice(3).trim(); out.set(name, []); continue; }
    if (line === "") { name = undefined; continue; }
    if (name) out.get(name)!.push(line);
  }
  return out;
}
const SECTIONS = fixtureSections();
const FULL_DAY = SECTIONS.get("full-day")!;

/** A briefing page in the rendered layout, with `section` placed where spec §7 puts it (after "Today so far",
 *  before "Suggested next"). Only the calendar lines vary between the cases below. */
function page(section: string[], opts: { recap?: string[]; suggestions?: string[]; before?: string[] } = {}): string {
  return [
    "☀️  Daily briefing — 2026-10-09  (this machine: fixture)",
    "▶ Where you left off  (state as of 15:00)",
    "   • [parser] finish the empty-input handling",
    ...(opts.before ?? []),
    "",
    "▶ What you did — 1 commit",
    ...(opts.recap ?? ["   • [parser] handled empty input (abc1234)"]),
    "",
    "▶ Today so far",
    "   • [parser] feat: morning work (def5678)",
    "",
    ...section,
    "",
    "▶ Suggested next",
    ...(opts.suggestions ?? ["   • [parser] add a whitespace test"]),
    "",
  ].join("\n");
}

describe("the section-bounded exclusion (all three text checks)", () => {
  test("no calendar section ⇒ the SAME string comes back, and the checks score it exactly as before", () => {
    const p = page([]);
    expect(withoutCalendarSection(p)).toBe(p);
    expect(calendarSectionLineIndexes(p.split("\n")).size).toBe(0);
    expect(calendarJudgeViews(p)).toBeNull();
  });

  test("extractCitedShas: a SHA-shaped citation inside an event title is not mined; the same line OUTSIDE the section is", () => {
    const evil = `${CALENDAR_LINE_PREFIX}09:00–09:30  Review fix (f00dfa1)`;
    expect(extractCitedShas(page([CALENDAR_HEADING, evil]))).toEqual(["abc1234", "def5678"]);
    // Stray prefix before the heading (not in a section): scored like any other line.
    expect(extractCitedShas(page([CALENDAR_HEADING], { before: [evil] }))).toContain("f00dfa1");
    // After the section has ended (past the next `▶ `): scored too.
    expect(extractCitedShas(page([CALENDAR_HEADING], { suggestions: [evil] }))).toContain("f00dfa1");
  });

  test("missingSameDay: a same-day SHA prefix in an event title does not clear the miss", () => {
    const day = ["1234567aaaa"];
    expect(missingSameDay(day, page([CALENDAR_HEADING, `${CALENDAR_LINE_PREFIX}10:00–11:00  Talk about 1234567`]))).toEqual(day);
    expect(missingSameDay(day, page([CALENDAR_HEADING], { suggestions: [`   • [parser] look at 1234567`] }))).toEqual([]);
  });

  test("coverageGaps: a meeting named after a repo does not cover it, nor does the heading cover a repo called `calendar`", () => {
    const repos = [{ repo: "/w/quant_stocks", labels: ["quant_stocks"] }, { repo: "/w/calendar", labels: ["calendar"] }];
    const sec = [`${CALENDAR_HEADING} (incomplete)`, `${CALENDAR_LINE_PREFIX}11:00–12:00  quant_stocks sync · tentative`];
    expect(coverageGaps(repos, page(sec)).map((g) => g.repo)).toEqual(["/w/quant_stocks", "/w/calendar"]);
    // A stray prefixed line outside the section still counts — the exclusion is the section, not the prefix.
    expect(coverageGaps(repos, page(sec, { before: [`${CALENDAR_LINE_PREFIX}quant_stocks`] })).map((g) => g.repo)).toEqual(["/w/calendar"]);
  });

  test("both headings (complete and `(incomplete)`) open a section; it ends at the next `▶ ` line", () => {
    for (const heading of [CALENDAR_HEADING, `${CALENDAR_HEADING} (incomplete)`]) {
      const lines = page([heading, `${CALENDAR_LINE_PREFIX}a`, `${CALENDAR_LINE_PREFIX}b`], { suggestions: [`${CALENDAR_LINE_PREFIX}after`] }).split("\n");
      const idx = [...calendarSectionLineIndexes(lines)].map((i) => lines[i]);
      expect(idx).toEqual([heading, `${CALENDAR_LINE_PREFIX}a`, `${CALENDAR_LINE_PREFIX}b`]);
    }
  });

  test("every frozen fixture variant is wholly removed from what the checks read", () => {
    for (const [name, sec] of SECTIONS) {
      const without = withoutCalendarSection(page(sec));
      expect(`${name}: ${without}`).toBe(`${name}: ${page([])}`);
    }
  });
});

// Integration (chunk B INFO): the boundary measured on chunk A's REAL renderer, not only on the hand-built
// `page()` above. For every frozen variant, the lines the audit skips are exactly what `renderCalendarSection`
// put in the page, and the page with them removed is the calendar-off page plus the section's one blank line.
describe("the section boundary on the real renderer (renderBriefing)", () => {
  const struct = (calendar?: CalendarStruct): BriefingStruct => ({
    date: "2026-10-14", machineScope: "h", provider: "claude", resume: [], recap: [],
    suggestions: [{ repo: "app", text: "ship it" }], today: [{ repo: "app", text: "fix (abc1234)" }],
    ...(calendar ? { calendar } : {}),
  });
  test("every variant: the skipped lines are the rendered section, nothing more or less", () => {
    expect(SECTION_SOURCES.map((s) => s.name)).toEqual([...SECTIONS.keys()]);
    for (const src of SECTION_SOURCES) {
      const lines = renderBriefing(struct(src.calendar)).split("\n");
      const skipped = [...calendarSectionLineIndexes(lines)].sort((a, b) => a - b);
      expect({ name: src.name, lines: skipped.map((i) => lines[i]) }).toEqual({ name: src.name, lines: renderCalendarSection(src.calendar, src.date) });
      expect(skipped.at(-1)! - skipped[0]! + 1).toBe(skipped.length);   // one contiguous run
      const off = renderBriefing(struct()).split("\n");
      const at = off.indexOf("▶ Suggested next");
      expect(withoutCalendarSection(lines.join("\n"))).toBe([...off.slice(0, at), "", ...off.slice(at)].join("\n"));
    }
  });
});

describe("the unlocked projection", () => {
  test("the full-day fixture, line by line: times and marks only", () => {
    expect(FULL_DAY.map(projectCalendarLine)).toEqual([
      "▶ Today's calendar (incomplete)",
      "   ◦ work: the link was refused — it may have been reset; add it again",
      "   ◦ team: only partly read — some events may be missing",
      "   ◦ all day  (title withheld)",
      "   ◦ all day  (title withheld) · tentative",
      "   ◦ since Oct 12 → 12:00  (title withheld)",
      "   ◦ since yesterday → 02:00  (title withheld) · ended",
      "   ◦ 07:30–07:45  (title withheld) · tentative · ended",
      "   ◦ 08:00–08:30  (title withheld) · ended",
      "   ◦ 09:00–09:30  (title withheld)",
      "   ◦ 11:00–12:00  (title withheld) · tentative",
      "   ◦ 12:00  (title withheld)",
      "   ◦ time unclear  (title withheld)",
      "   ◦ 15:00–15:30  (title withheld)",
      "   ◦ 22:00 → Oct 16 18:00  (title withheld)",
      "   ◦ 23:00 → 01:00 tomorrow  (title withheld)",
      "   ◦ 23:30–24:00  (title withheld)",
    ]);
  });

  test("fixed-text lines survive; a forged status line or heading does not carry text through", () => {
    for (const name of ["unavailable", "quiet", "no-sources"]) expect(SECTIONS.get(name)!.map(projectCalendarLine)).toEqual(SECTIONS.get(name)!);
    expect(projectCalendarLine(`${CALENDAR_LINE_PREFIX}+3 more`)).toBe(`${CALENDAR_LINE_PREFIX}+3 more`);
    // An event whose TITLE ends in a status sentence: its "label" is no source id, so it is projected.
    expect(projectCalendarLine(`${CALENDAR_LINE_PREFIX}09:00–10:00  SECRET plan: did not answer in time`)).toBe(`${CALENDAR_LINE_PREFIX}09:00–10:00  (title withheld)`);
    expect(projectCalendarLine(`${CALENDAR_HEADING} SECRET`)).toBe(CALENDAR_HEADING);
    // Nothing parseable: no part of the line is kept.
    expect(projectCalendarLine(`${CALENDAR_LINE_PREFIX}SECRET 09:00 x`)).toBe(`${CALENDAR_LINE_PREFIX}(event — details withheld)`);
    // A span lookalike made of title words is not a span (only the twelve month names may appear).
    expect(projectCalendarLine(`${CALENDAR_LINE_PREFIX}since SECRET 12 → 12:00  x`)).toBe(`${CALENDAR_LINE_PREFIX}(event — details withheld)`);
  });

  test("R07 a key-c merged line (calendar near-duplicates, spec §6): the merge mark is dropped, never kept; span, (title withheld) and the status marks stay", () => {
    // Rendered by the real renderer from struct events carrying the decided `merged` mark (src/audit.ts unchanged).
    const DATE = "2026-10-09";
    const at = (h: number, m = 0): number => new Date(2026, 9, 9, h, m).getTime();
    const ev = (over: Partial<CalendarStructEvent>): CalendarStructEvent =>
      ({ time: { kind: "timed", startMs: at(14), endMs: at(22) }, title: "Ticket: SECRET show", location: "SECRET Hall", status: "confirmed", transparency: "busy", attendeeCount: 0, ...over });
    const cases: [CalendarStructEvent, string][] = [
      [ev({ status: "tentative", merged: { mark: "calendars", count: 2 } }), "14:00–22:00  (title withheld) · tentative"],
      [ev({ status: "tentative", ended: true, merged: { mark: "copies", count: 12 } }), "14:00–22:00  (title withheld) · tentative · ended"],
      [ev({ merged: { mark: "calendars", count: 3 } }), "14:00–22:00  (title withheld)"],
      [ev({ time: { kind: "allDay", startDate: DATE, endDateExclusive: "2026-10-10" }, status: "tentative", merged: { mark: "copies", count: 2 } }), "all day  (title withheld) · tentative"],
      [ev({ time: { kind: "unclear", startDate: DATE, endDate: DATE, wallStart: "14:00", wallEnd: "15:00", tzid: "SECRET/Zone" }, merged: { mark: "calendars", count: 4 } }), "time unclear  (title withheld)"],
    ];
    for (const [e, want] of cases) {
      const line = CALENDAR_LINE_PREFIX + calEventLine(e, DATE);
      // PREMISE: the rendered line carries the merge mark (T6.0), before any status mark.
      expect(/ · (on \d+ calendars|\d+ copies)( · tentative)?( · ended)?$/.test(line)).toBe(true);
      const projected = projectCalendarLine(line);
      expect(projected).toBe(CALENDAR_LINE_PREFIX + want);
      expect(projected).not.toMatch(/calendars|copies|SECRET/);
    }
  });

  test("calendarJudgeViews: locked = the briefing and the section verbatim; unlocked = no title anywhere", () => {
    const p = page(FULL_DAY);
    const v = calendarJudgeViews(p)!;
    expect(v.locked.briefing).toBe(p);
    expect(v.locked.calendar).toContain("CALENDAR (as generated, untrusted data)");
    expect(v.locked.calendar).toContain(FULL_DAY.join("\n"));
    const titles = ["Company offsite", "Lisbon", "Conference week", "On-call", "Overnight deploy", "Gym", "Breakfast", "Café Nero", "Standup", "Room 4",
      "Design review", "zoom.us", "Submit timesheet", "Custom/Lunar Base", "Vendor sync", "(no title)", "Hackathon", "Release night", "APAC"];
    for (const t of titles) {
      expect(v.locked.briefing).toContain(t);
      expect(v.unlocked.briefing, `unlocked briefing carried ${t}`).not.toContain(t);
      expect(v.unlocked.calendar, `unlocked CALENDAR carried ${t}`).not.toContain(t);
    }
    expect(v.unlocked.calendar).toContain("Do NOT score claims about meeting titles");
    // Outside the section, the briefing is untouched.
    expect(v.unlocked.briefing.replace(/\n {3}◦ [^\n]*/g, "")).toBe(p.replace(/\n {3}◦ [^\n]*/g, ""));
  });

  test("buildAuditPrompt: no `calendar` ⇒ byte-identical to before; with one, the block follows the deterministic checks", () => {
    const parts = { briefing: "B", gitFacts: "G", popup: null, deterministic: ["d1"] };
    expect(buildAuditPrompt({ ...parts, calendar: undefined })).toBe(buildAuditPrompt(parts));
    const withCal = buildAuditPrompt({ ...parts, calendar: "CALENDAR X" });
    expect(withCal).toContain("- d1\n\nCALENDAR X\n");
  });
});

describe("featuresLine: calendar=OFF / calendar=on (user decision 15c)", () => {
  const tx = { enabled: false, root: "/x" };
  test("absent, off, malformed ⇒ OFF; enabled ⇒ on; always the last item", () => {
    expect(featuresLine({ provider: {} }, tx)).toMatch(/ · calendar=OFF$/);
    expect(featuresLine({ provider: {}, calendar: { enabled: false } }, tx)).toMatch(/ · calendar=OFF$/);
    expect(featuresLine({ provider: {}, calendar: { enabled: "yes" } }, tx)).toMatch(/ · calendar=OFF$/);
    expect(featuresLine({ provider: {}, calendar: { enabled: true } }, tx)).toMatch(/ · calendar=on$/);
  });
});

// ── end to end through scripts/audit.ts ─────────────────────────────────────────────────────────────

const FULL_HELP = "--tools --setting-sources --strict-mcp-config --no-session-persistence";
type Spawn = { argv: string; stdin: string; hardened: boolean };

/** A fake `claude` that answers `--help`, logs each spawn's argv and stdin, and — in `reject` mode — refuses
 *  `--tools=` with a real rejection phrase (the hardened provider's B6 fast path then retries bare). */
async function fakeClaude(mode: "ok" | "reject") {
  const dir = removeAtRunEnd(await mkdtemp(join(tmpdir(), "dba-calaudit-cli-")));
  const cli = join(dir, "claude");
  const reject = mode === "reject" ? `case " $* " in *" --tools= "*) echo "error: unknown option '--tools'" >&2; exit 2;; esac` : "";
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '${FULL_HELP}'; exit 0; fi
n=$(cat '${dir}/count' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${dir}/count'
printf '%s' "$*" > '${dir}/argv.'$n
cat > '${dir}/stdin.'$n
${reject}
printf 'JUDGED: fine\\nVERDICT — Ground: PASS · Actionable: YES\\n'
`, { mode: 0o755 });
  const spawns = async (): Promise<Spawn[]> => {
    let n = 0;
    try { n = Number((await readFile(join(dir, "count"), "utf8")).trim()); } catch { /* none */ }
    const out: Spawn[] = [];
    for (let i = 1; i <= n; i++) {
      const argv = await readFile(join(dir, `argv.${i}`), "utf8");
      const toks = argv.split(/\s+/);
      out.push({ argv, stdin: await readFile(join(dir, `stdin.${i}`), "utf8"), hardened: toks.includes("--tools=") && toks.includes("--strict-mcp-config") });
    }
    return out;
  };
  return { cli, spawns };
}

/** Titles on the briefing's calendar section — none may reach an unlocked judge spawn. The AI text of the
 *  briefing quotes none of them, so residual 16a does not apply to this fixture. */
const SNTL = ["SNTL-TITLE-ONE", "SNTL-LOC", "SNTL-TITLE-TWO", "SNTL-ZONE"];
const SNTL_SECTION = [
  `${CALENDAR_HEADING}`,
  `${CALENDAR_LINE_PREFIX}09:00–09:30  SNTL-TITLE-ONE (SNTL-LOC)`,
  `${CALENDAR_LINE_PREFIX}14:00–15:00  SNTL-TITLE-TWO · tentative`,
  `${CALENDAR_LINE_PREFIX}time unclear (16:00–17:00 SNTL-ZONE)  SNTL-TITLE-ONE again`,
];

let repo = "";
let cfgHome = "";
let briefingPath = "";
let prevXdg: string | undefined;

beforeAll(async () => {
  prevXdg = process.env.XDG_CONFIG_HOME;
  cfgHome = removeAtRunEnd(await mkdtemp(join(tmpdir(), "dba-calaudit-cfg-")));
  process.env.XDG_CONFIG_HOME = cfgHome;
  repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
  const work = removeAtRunEnd(await mkdtemp(join(tmpdir(), "dba-calaudit-brief-")));
  briefingPath = join(work, "briefing.md");
  await writeFile(briefingPath, page(SNTL_SECTION));
});
afterAll(() => { if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg; });

async function audit(provider: Record<string, unknown>): Promise<string> {
  await mkdir(join(cfgHome, "daily-briefing"), { recursive: true });
  await writeFile(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify({
    repos: [repo], excludeCommitPatterns: [], lookbackCapDays: 30, provider: { argv: [], timeoutMs: 30_000, ...provider },
  }));
  const out: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = () => {};
  try { await auditMain([briefingPath]); } finally { console.log = oLog; console.error = oErr; }
  return out.join("\n");
}

const noSentinel = (where: string, s: string): void => { for (const x of SNTL) expect(s, `${where} carried ${x}`).not.toContain(x); };

describe("scripts/audit.ts end to end: the judge's spawn gets the variant its argv allows", () => {
  test("a hardened claude fake: ONE spawn, LOCKED — the titles reach it, and the report says so", async () => {
    const f = await fakeClaude("ok");
    const report = await audit({ cli: f.cli, promptVia: "stdin" });
    const spawns = await f.spawns();
    expect(spawns.map((s) => s.hardened)).toEqual([true]);
    expect(spawns[0]!.stdin).toContain("SNTL-TITLE-ONE");
    expect(spawns[0]!.stdin).toContain("CALENDAR (as generated, untrusted data) —");
    expect(report).toContain("- calendar: the judge was LOCKED");
    expect(report).not.toContain(CALENDAR_JUDGE_RESIDUAL_NOTICE);
    expect(report).toMatch(/ · calendar=OFF\n/);   // features line: this config has no calendar block
  }, 60_000);

  test.each(["stdin", "arg"] as const)("a claude fake that REJECTS `--tools`: the bare retry carries no calendar title (promptVia %s)", async (promptVia) => {
    const f = await fakeClaude("reject");
    const report = await audit({ cli: f.cli, promptVia });
    const spawns = await f.spawns();
    expect(spawns.map((s) => s.hardened)).toEqual([true, false]);
    noSentinel("bare judge spawn (stdin + argv)", `${spawns[1]!.stdin}\n${spawns[1]!.argv}`);
    const bare = `${spawns[1]!.stdin}\n${spawns[1]!.argv}`;
    expect(bare).toContain("TITLES WITHHELD from this judge");
    expect(bare).toContain(`${CALENDAR_LINE_PREFIX}09:00–09:30  (title withheld)`);
    expect(report).toContain(CALENDAR_JUDGE_RESIDUAL_NOTICE);
  }, 60_000);

  test("`harden: false`: the only spawn is unlocked and carries no title; residual 16a is reported", async () => {
    const f = await fakeClaude("ok");
    const report = await audit({ cli: f.cli, promptVia: "stdin", harden: false });
    const spawns = await f.spawns();
    expect(spawns.map((s) => s.hardened)).toEqual([false]);
    noSentinel("unhardened judge spawn", `${spawns[0]!.stdin}\n${spawns[0]!.argv}`);
    expect(report).toContain(CALENDAR_JUDGE_RESIDUAL_NOTICE);
  }, 60_000);

  test("a briefing with no calendar section: no calendar line in the report, and the prompt has no CALENDAR block", async () => {
    const f = await fakeClaude("ok");
    const prev = briefingPath;
    const work = removeAtRunEnd(await mkdtemp(join(tmpdir(), "dba-calaudit-plain-")));
    briefingPath = join(work, "briefing.md");
    await writeFile(briefingPath, page([]));
    try {
      const report = await audit({ cli: f.cli, promptVia: "stdin" });
      const [s] = await f.spawns();
      expect(s!.stdin).not.toContain("CALENDAR (as generated");
      expect(report).not.toMatch(/^- calendar:/m);
    } finally { briefingPath = prev; }
  }, 60_000);
});
