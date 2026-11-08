import "./fixtures/isolate-state";
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { resolveCalendar } from "../src/calendar/config";
import { discoverySummary } from "../src/discoverySummary";
import { CALENDAR_OMITTED_LINE, calendarAllowance } from "../src/calendar/budget";
import { createCalendarStep } from "../src/calendar/pipeline";
import type { CalendarStepResult } from "../src/calendar/step";
import type { CalEvent } from "../src/calendar/types";
import { NOTICE_PREFIX } from "../src/failover";
import { providerLabel } from "../src/providerFactory";
import { renderBriefing, renderCalendarSection } from "../src/render";
import { renderWhy } from "../src/transcripts/frame";
import type { BriefingStruct } from "../src/types";
import { summaryInput } from "../src/summary/input";
import type { CapturedCalendar } from "../src/summary/input";

guardNetworkForThisFile();
const RUN = "2026-01-11";
const now = new Date(2026, 0, 11, 8).getTime();
const sentinels = ["PRIVATE_MEETING_TITLE", "PRIVATE_ROOM", "PRIVATE_ORGANIZER", "PRIVATE_ATTENDEE", "PRIVATE_NOTES"];
const event = (): CalEvent => ({
  uid: "summary-input-fixture", sources: [{ kind: "macos", id: "macos", calendarId: "fixture" }],
  time: { kind: "timed", startMs: now + 2 * 3600000, endMs: now + 3 * 3600000 },
  title: sentinels[0]!, location: sentinels[1]!, organizer: { name: sentinels[2]! },
  attendees: [{ name: sentinels[3]!, email: "fixture@example.com", status: "accepted" }],
  description: sentinels[4]!, selfStatus: "accepted", organizerVerified: false,
  transparency: "busy", status: "confirmed", provenance: {},
});

/** Real pipeline/budget projections; only the source reader is a recording fixture. */
async function snapshot(options: { configured?: boolean; events?: boolean; incomplete?: boolean; maxChars?: number } = {}): Promise<CalendarStepResult> {
  const configured = options.configured !== false;
  const resolved = resolveCalendar({ enabled: true, ...(configured ? { macos: {} } : {}) }, { platform: "darwin" });
  const step = createCalendarStep(resolved, {
    stateDir: removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-summary-input-"))),
    platform: "darwin", env: {}, now: () => now, maxChars: options.maxChars ?? 200000,
    readMac: async () => ({ status: options.incomplete ? "incomplete" : "ok", events: options.events === false ? [] : [event()] }),
    fetch: async () => { throw new Error("A summary-input fixture must never fetch"); },
  });
  const result = await step({ runDate: RUN, startedAt: now, offline: false, force: false, owned: false, trigger: "manual" });
  if (result === undefined) throw new Error("Expected enabled fixture calendar");
  return result;
}
const capture = (r: CalendarStepResult): CapturedCalendar => ({
  unlockedBlock: r.promptBlocks?.unlocked ?? null, hasEvents: r.struct.events.length > 0,
});
const prefix = `☀️  Daily briefing — ${RUN}  (this machine: fixture)\n`
  + "▶ Where you left off\n   • [Orchard] unfinished work  \n\n"
  + "▶ What you did\n   • [Orchard] shipped a view\n\n";
const suffix = "▶ Today so far\n   • [Orchard] checked the view\n\n"
  + "▶ Suggested next\n   • [Orchard] keep the next step\n— generated via fixture\n";
/** What the request carries of a page with no warning lines: spelled here, not derived from the code under test. */
const sent = (page: string): string => page.replace("  (this machine: fixture)", "").replace("— generated via fixture\n", "");
const section = (r: CalendarStepResult): string => renderCalendarSection(r.struct, RUN).join("\n");

describe("summary input calendar lock matrix", () => {
  test.each([false, true])("a locked summary receives the page, meeting text included (morning locked: %s)", async (morningLocked) => {
    const r = await snapshot();
    const page = prefix + section(r) + "\n\n" + suffix;
    expect(page).toContain(sentinels[0]!);
    expect(summaryInput(page, morningLocked, true, capture(r))).toBe(sent(page));
    const noBlock = await snapshot({ maxChars: 1 });
    expect(noBlock.promptBlocks).toBeNull();
    expect(summaryInput(page, morningLocked, true, capture(noBlock))).toBe(sent(page));
  });

  test("locked morning to unlocked summary refuses even when meeting text escaped into Suggested next", async () => {
    const r = await snapshot();
    const echoed = suffix + `   • [Orchard] prepare for ${sentinels[0]}\n`;
    expect(summaryInput(prefix + section(r) + "\n" + echoed, true, false, capture(r))).toBeNull();
    expect(summaryInput(prefix + echoed, true, false, capture(r))).toBeNull();
  });
});

describe("captured real-pipeline calendar rows", () => {
  test.each([false, true])("row 1 replaces only the complete/incomplete section body (incomplete: %s)", async (incomplete) => {
    const r = await snapshot({ incomplete });
    expect(r.struct.events).toHaveLength(1);
    expect(r.promptBlocks).not.toBeNull();
    expect(r.promptBlocks!.unlocked).not.toBe("");
    for (const sentinel of sentinels) expect(r.promptBlocks!.locked).toContain(sentinel);
    const savedSection = section(r), heading = savedSection.split("\n")[0]!;
    expect(heading.includes("(incomplete)")).toBe(incomplete);
    const page = prefix + savedSection + "\n\n" + suffix;
    const input = summaryInput(page, false, false, capture(r));
    expect(input).toBe(sent(prefix) + heading + "\n" + r.promptBlocks!.unlocked + "\n" + sent(suffix));
    for (const sentinel of sentinels) expect(input).not.toContain(sentinel);
    expect(input!.startsWith(sent(prefix) + heading + "\n")).toBe(true);
    expect(input!.endsWith(sent(suffix))).toBe(true);
    expect(page).toContain(sentinels[0]!); // The saved page was never rewritten.
  });

  test("row 1 also replaces the body when the non-null source block has no events", async () => {
    const r = await snapshot({ events: false });
    expect(r.promptBlocks).not.toBeNull(); expect(r.struct.events).toHaveLength(0);
    const heading = section(r).split("\n")[0]!;
    expect(summaryInput(prefix + section(r) + "\n" + suffix, false, false, capture(r)))
      .toBe(sent(prefix) + heading + "\n" + r.promptBlocks!.unlocked + "\n" + sent(suffix));
  });

  test("row 2 retains the no-source code-written body byte for byte", async () => {
    const r = await snapshot({ configured: false });
    expect(r.promptBlocks).toBeNull(); expect(r.struct.events).toHaveLength(0);
    const page = prefix + section(r) + "\n\n" + suffix;
    expect(page).toContain("No calendar is connected");
    expect(summaryInput(page, false, false, capture(r))).toBe(sent(page));
  });

  test("row 3 refuses when the actual budget drops both blocks but events survive", async () => {
    const maxChars = (CALENDAR_OMITTED_LINE.length - 1) * 10;
    expect(calendarAllowance(maxChars)).toBeLessThan(CALENDAR_OMITTED_LINE.length);
    const r = await snapshot({ maxChars });
    expect(r.promptBlocks).toBeNull(); expect(r.struct.events).toHaveLength(1);
    const page = prefix + section(r) + "\n" + suffix;
    expect(page).toContain(sentinels[0]!);
    expect(summaryInput(page, false, false, capture(r))).toBeNull();
  });

  test("the omitted line replaces the body when the budget leaves room only for it, and the call goes with no meeting text", async () => {
    const r = await snapshot({ maxChars: CALENDAR_OMITTED_LINE.length * 10 });
    expect(r.promptBlocks!.unlocked).toBe(CALENDAR_OMITTED_LINE); expect(r.struct.events).toHaveLength(1);
    const savedSection = section(r), heading = savedSection.split("\n")[0]!;
    const page = prefix + savedSection + "\n" + suffix;
    expect(page).toContain(sentinels[0]!);
    const input = summaryInput(page, false, false, capture(r));
    expect(input).toBe(sent(prefix) + heading + "\n" + CALENDAR_OMITTED_LINE + "\n" + sent(suffix));
    for (const sentinel of sentinels) expect(input).not.toContain(sentinel);
  });

  test("an absent section is never added, including null-block/events captures", async () => {
    for (const r of [await snapshot(), await snapshot({ maxChars: 1 })]) {
      const page = prefix + suffix;
      expect(summaryInput(page, false, false, capture(r))).toBe(sent(page));
      const inlineHeading = page + "inline ▶ Today's calendar\nordinary text\n";
      expect(summaryInput(inlineHeading, false, false, capture(r))).toBe(sent(inlineHeading));
    }
  });

  test("a calendar at EOF gets exactly the captured block; CRLF heading bytes survive", async () => {
    const r = await snapshot();
    const heading = section(r).split("\n")[0]!;
    expect(summaryInput(prefix + section(r), false, false, capture(r))).toBe(sent(prefix) + heading + "\n" + r.promptBlocks!.unlocked);
    expect(summaryInput(prefix + heading + "\r\nold body\r\n" + suffix, false, false, capture(r)))
      .toBe(sent(prefix) + heading + "\r\n" + r.promptBlocks!.unlocked + "\n" + sent(suffix));
    expect(summaryInput(prefix + heading, false, false, capture(r))).toBe(sent(prefix) + heading + "\n" + r.promptBlocks!.unlocked);
  });
});

describe("what the request leaves out, read from the real renderer", () => {
  const HOST = "PRIVATE-HOST.local";
  const KEY_PATH = "/private/keys/PRIVATE-KEY-FILE.key";
  const CLI_PATH = "/Users/PRIVATE-USER/.local/bin/claude";
  const FOOTER = "\u2014 generated via ";
  const NOTICE = `${NOTICE_PREFIX}Skipped "PRIVATE-ENTRY": it failed \u2014 used "Backup"`;
  const KEY_WARNING = `api key: refusing to read provider.api.apiKeyFile ${KEY_PATH} \u2014 it is group- or world-readable (mode 644); run \`chmod 600\` on it`;
  const SEARCH_WARNING = discoverySummary([{ path: "/private/PRIVATE-FOLDER", kind: "tcc-denied", protectedRoot: "/private/PRIVATE-FOLDER" }], { noRepos: true, home: "/private" })!;
  const WHY_TURN = "tidy the harvest view";
  const struct =(extra: Partial<BriefingStruct> = {}): BriefingStruct => ({
    date: RUN, machineScope: HOST, provider: CLI_PATH,
    resume: [{ repo: "Orchard", text: "the (this machine: kept) words stay" }],
    recap: [{ repo: "Orchard", text: "\u26a0 a bullet may start like this" }],
    suggestions: [{ repo: "Orchard", text: `${FOOTER}a bullet may say this too` }],
    whys: { orchard: WHY_TURN },
    notices: [NOTICE], outage: { missedDays: 2, label: "PRIVATE-ACCOUNT" }, warnings: [KEY_WARNING, SEARCH_WARNING],
    recapCoverage: { total: 3, shown: 2, notShown: [{ label: "Orchard", sha: "abc1234", subject: "a commit kept" }] },
    ...extra,
  });
  const NONE: CapturedCalendar = { unlockedBlock: null, hasEvents: false };
  const page = renderBriefing(struct());
  const left = (text: string): string[] => text.split("\n");
  const LEFT_OUT = [HOST, "this machine: ", KEY_PATH, "PRIVATE-KEY-FILE", "PRIVATE-FOLDER", "PRIVATE-ENTRY", "PRIVATE-ACCOUNT", NOTICE_PREFIX, "No briefing for", CLI_PATH, "PRIVATE-USER"];

  test("the premise: the saved page really holds every line named here", () => {
    for (const fact of [HOST, KEY_PATH, "PRIVATE-FOLDER", "PRIVATE-ENTRY", "PRIVATE-ACCOUNT"]) expect(page).toContain(fact);
    expect(left(page).filter((l) => l.startsWith("\u26a0 "))).toHaveLength(2);
    expect(left(page).at(-1)).toBe(FOOTER + CLI_PATH);
  });

  test.each([[false, true], [true, true], [false, false]])("morning locked %s, summary locked %s: the title keeps its date and loses the host", (morningLocked, summaryLocked) => {
    const input = summaryInput(page, morningLocked, summaryLocked, NONE)!;
    for (const fact of LEFT_OUT) {
      if (fact === "this machine: ") expect(left(input).filter((l) => l.startsWith("\u2600")).join("\n")).not.toContain(fact);
      else expect(input).not.toContain(fact);
    }
    expect(left(input)).toContain(`\u2600\uFE0F  Daily briefing \u2014 ${RUN}`);
  });

  test("each form goes on its own: a page with only one of them", () => {
    const only = (extra: Partial<BriefingStruct>) => renderBriefing(struct({ notices: undefined, outage: undefined, warnings: undefined, ...extra } as Partial<BriefingStruct>));
    const none = summaryInput(only({}), false, true, NONE)!;
    expect(summaryInput(only({ notices: [NOTICE] }), false, true, NONE)).toBe("\n" + none);
    expect(summaryInput(only({ outage: { missedDays: 1, label: "PRIVATE-ACCOUNT" } }), false, true, NONE)).not.toContain("PRIVATE-ACCOUNT");
    expect(summaryInput(only({ warnings: [KEY_WARNING] }), false, true, NONE)).not.toContain(KEY_PATH);
    expect(summaryInput(only({ warnings: [SEARCH_WARNING] }), false, true, NONE)).not.toContain("PRIVATE-FOLDER");
  });

  test.each([
    ["a CLI path", providerLabel({ cli: CLI_PATH, argv: [], promptVia: "stdin" })],
    ["a CLI path with a space", "/Users/PRIVATE-USER/my tools/claude"],
    ["a CLI path holding a newline", "/Users/PRIVATE-USER/one\ntwo/claude"],
    ["a CLI path holding a carriage return", "/Users/PRIVATE-USER/one\r\ntwo/claude"],
    ["an API entry with its model", "anthropic-api (PRIVATE-USER-model)"],
  ])("the closing line goes whatever the provider's name holds: %s", (_name, provider) => {
    const saved = renderBriefing(struct({ provider }));
    expect(saved).toContain("PRIVATE-USER");
    for (const [morningLocked, summaryLocked] of [[false, true], [true, true], [false, false]] as const) {
      const input = summaryInput(saved, morningLocked, summaryLocked, NONE)!;
      expect(input).not.toContain("PRIVATE-USER");
      expect(left(input).filter((l) => l.startsWith(FOOTER))).toEqual([]);
    }
  });

  test("every other line is kept byte for byte, including the commit-coverage lines and look-alike words", () => {
    const input = summaryInput(page, false, true, NONE)!;
    const saved = left(page);
    const dropped = saved.filter((l) => l.startsWith(NOTICE_PREFIX) || l.startsWith("\u26a0 ") || l.startsWith("\u26a0\uFE0F  No briefing for ") || l.startsWith(FOOTER));
    expect(dropped).toHaveLength(5);
    const title = saved.findIndex((l) => l.startsWith("\u2600"));
    const kept = saved.map((l, i) => i === title ? l.slice(0, l.indexOf("  (this machine: ")) : l).filter((l) => !dropped.includes(l));
    expect(left(input)).toEqual(kept);
    // The disclosed quote: a rendered `whyFor` line, in the saved page and in the request.
    expect(left(page)).toContain(renderWhy(WHY_TURN));
    expect(left(input)).toContain(renderWhy(WHY_TURN));
    expect(input).toContain("   \u26a0 1 in-window commit(s) NOT shown above:");
    expect(input).toContain("a commit kept");
    expect(input).toContain("the (this machine: kept) words stay");
    expect(input).toContain("\u26a0 a bullet may start like this");
    expect(input).toContain(`${FOOTER}a bullet may say this too`);
  });

  test("a title with no machine clause, as a hand-written page has, is left alone", () => {
    const bare = `\u2600\uFE0F  Daily briefing \u2014 ${RUN}\n\u25b6 What you did\n   \u2022 [Orchard] x\n`;
    expect(summaryInput(bare, false, true, NONE)).toBe(bare);
  });

  test("the unlocked calendar swap still works on what is left", async () => {
    const r = await snapshot();
    const withCalendar = renderBriefing(struct({ calendar: r.struct }));
    const input = summaryInput(withCalendar, false, false, capture(r))!;
    for (const fact of LEFT_OUT.filter((f) => f !== "this machine: ")) expect(input).not.toContain(fact);
    expect(input).toContain(r.promptBlocks!.unlocked);
    for (const sentinel of sentinels) expect(input).not.toContain(sentinel);
    expect(withCalendar).toContain(KEY_PATH);                  // the saved page was not rewritten
    expect(withCalendar).toContain(CLI_PATH);
  });
});
