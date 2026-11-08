import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/calendar-details.verb.test.ts — `calendar details --json` (redesign C, wave-2 plan C-M2-T6): its arguments and
// STDIN, the refusal while the calendar is off, the sealed document, `rowText` as the page's own line (over the 60-line
// cap too), the reader's version gating through the details path, the maximal handback, and the no-write jail. Every
// read here uses an injected runner, an injected fetch (netGuard installed), the real parse job as a `bun -e` child
// and, for the Mac source, a fake trigger that plays the helper through a real FIFO. Nothing touches the real
// Calendar, the real reader, a real calendar link, or the real state, config or home.
import { test, expect, describe } from "bun:test";
import { closeSync, constants, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, writeFileSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import ts from "typescript";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { calendarMain, type CalendarCliDeps } from "../src/calendar/cli";
import { DETAILS_STDIN_MAX_BYTES, LIVE_READ_REFRESH_WAIT, type CalendarDetailsJson } from "../src/calendar/details";
import { linkEntryHash, readCalendar, toCalendarStruct } from "../src/calendar/pipeline";
import { parseCalendarLink } from "../src/calendar/link-parse";
import { resolveCalendar } from "../src/calendar/config";
import { renderCalendarSection } from "../src/render";
import { CALENDAR_LINE_PREFIX } from "../src/calendar/render-contract";
import { calendarReaderCopy, calendarReaderRunDir, readerExecutable } from "../src/calendar/reader";
import { localDateStr } from "../src/marker";
import type { RunResult } from "../src/proc";
import type { ReaderExec } from "../src/calendar/mac-source";

guardNetworkForThisFile();

const ROOT = resolve(import.meta.dir, "..");
const PARSE_JOB = join(ROOT, "src/calendar/parse-job.ts");
const JOB_CHILD = [process.execPath, "-e", `import { calendarParseMain } from ${JSON.stringify(PARSE_JOB)}; process.exit(await calendarParseMain());`];
const TODAY = localDateStr(new Date());
/** A local wall time today (or `dayOffset` days away) as an iCalendar UTC date-time. */
const at = (h: number, m = 0, s = 0, dayOffset = 0): string => {
  const d = new Date(); d.setHours(h, m, s, 0); d.setDate(d.getDate() + dayOffset);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
};
const feed = (...events: string[][]): string => ["BEGIN:VCALENDAR", "VERSION:2.0", ...events.flat(), "END:VCALENDAR", ""].join("\r\n");
let uidN = 0;
const ev = (...lines: string[]): string[] => ["BEGIN:VEVENT", `UID:v${++uidN}@test`, ...lines, "END:VEVENT"];
const ics = (body: string): Response => new Response(body, { status: 200, headers: { "content-type": "text/calendar" } });

const SECRET = "s3cr3tDetT0ken";
const WORK_URL = `https://cal.example/${SECRET}/work.ics`;
const HOME_URL = `https://home.example/${SECRET}/home.ics`;
const SENT_NAME = "Zelda SNTLNAME", SENT_NOTE = "SNTLNOTE agenda";

const OK: RunResult = { out: "", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false };
function runner(url: string | null) {
  const calls: string[][] = [];
  const exec = (async (argv: string[]) => { calls.push([...argv]); return url === null ? { ...OK, code: 1 } : { ...OK, out: `${url}\n` }; }) as unknown as NonNullable<CalendarCliDeps["exec"]>;
  return { exec, calls };
}
function fakeFetch(routes: Record<string, Response | "reject">) {
  const seen: string[] = [];
  return { seen, fetch: async (url: string): Promise<Response> => { seen.push(url); const r = routes[url]; if (r === undefined || r === "reject") throw new Error("x"); return r.clone(); } };
}

type Env = { dir: string; state: string; configFile: string };
function env(calendar: unknown): Env {
  const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-caldet-verb-")));
  const state = join(dir, "state");
  mkdirSync(state, { recursive: true });
  const configFile = join(dir, "config.json");
  writeFileSync(configFile, JSON.stringify(calendar === undefined ? {} : { calendar }));
  return { dir, state, configFile };
}
async function details(e: Env, args: string[], over: Partial<CalendarCliDeps> = {}) {
  const out: string[] = [], err: string[] = [];
  const code = await calendarMain(["details", ...args], {
    stateDir: e.state, configFile: e.configFile, platform: "linux", parseCommand: JOB_CHILD, isTTY: false, readStdin: async () => "", env: { HOME_URL },
    out: (s) => out.push(s), err: (s) => err.push(s), ...over,
  });
  return { code, out, err, doc: out.length === 1 ? JSON.parse(out[0]!) : undefined };
}
const WORK = { id: "work", urlCommand: ["pw", "show", "work"] };
const HOME = { id: "home", urlEnv: "HOME_URL" };

/** The webview's card model (`gui/src/lib/calendar-detail.ts`), loaded at run time by path. A static import would
 *  pull the GUI's module graph into the engine's `tsc --noEmit`, and that graph's type imports reach
 *  `@tauri-apps/api`, which only the GUI package installs (CI type-checks the engine before it installs the GUI).
 *  At run time those are type imports and are erased. `test/engine-imports-no-gui.test.ts` keeps engine files from
 *  importing GUI code statically.
 *  The inputs are typed by mirrors of the GUI's own types (`gui/src/lib/engine.ts`), so a wrong call fails here as it
 *  would there. The test "the mirrored GUI types match gui/src/lib/engine.ts" below reads THESE declarations and the
 *  GUI's as syntax and fails when they differ. A live event is an opaque handle: only `liveEvent`'s result fits. */
type GuiCalendarDetailsEvent = {
  handle: string;
  title: string;
  location: string | null;
  rowText: string;
  time: unknown;
  status: string;
  ended: boolean;
  linkState: "none" | "one" | "several";
  joinHost: string | null;
  serviceName?: string;
  needsConfirm: boolean;
  fromMac: boolean;
};
type GuiCalendarDetailsGetReply =
  | { people: { name: string | null; organiser: boolean }[] | null; notes: string | null; otherNotes?: { title: string | null; notes: string }[] }
  | { refused: "stale" };
declare const LIVE_EVENT: unique symbol;
type GuiLiveEvent = { readonly [LIVE_EVENT]: true };
type CardModel = {
  liveEvent: (e: GuiCalendarDetailsEvent) => GuiLiveEvent | null;
  cardDetailsReply: (h: string, card: { kind: "live"; event: GuiLiveEvent; footnote: string; lines: string[] }, day: string,
    reply: GuiCalendarDetailsGetReply, now: number) =>
    { kind: "drop" } | { kind: "stale" } | { kind: "details"; details: { people: unknown; notes: unknown } };
};
const loadCardModel = async (): Promise<CardModel> =>
  (await import(join(ROOT, "gui/src/lib/calendar-detail.ts"))) as CardModel;

test("the mirrored GUI types match gui/src/lib/engine.ts (both read as syntax, neither loaded)", () => {
  const parse = (path: string): ts.SourceFile =>
    ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true);
  const flat = (n: ts.Node, sf: ts.SourceFile): string => n.getText(sf).replace(/\s+/g, " ");
  const members = (list: ts.NodeArray<ts.TypeElement>, sf: ts.SourceFile): Record<string, string> =>
    Object.fromEntries(list.map((m) => {
      if (!ts.isPropertySignature(m) || m.type === undefined) throw new Error(`unexpected member: ${m.getText(sf)}`);
      return [m.name.getText(sf) + (m.questionToken ? "?" : ""), flat(m.type, sf)];
    }));
  const unionParts = (t: ts.TypeNode, sf: ts.SourceFile): string[] =>
    (ts.isUnionTypeNode(t) ? [...t.types] : [t]).map((p) => flat(p, sf));
  const gui = parse(join(ROOT, "gui/src/lib/engine.ts"));
  const here = parse(import.meta.path);
  const guiEvent = gui.statements.find((s): s is ts.InterfaceDeclaration =>
    ts.isInterfaceDeclaration(s) && s.name.text === "CalendarDetailsEvent");
  const guiReply = gui.statements.find((s): s is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(s) && s.name.text === "CalendarDetailsGetReply");
  const alias = (name: string): ts.TypeAliasDeclaration | undefined => here.statements.find((s): s is ts.TypeAliasDeclaration =>
    ts.isTypeAliasDeclaration(s) && s.name.text === name);
  const mirrorEvent = alias("GuiCalendarDetailsEvent");
  const mirrorReply = alias("GuiCalendarDetailsGetReply");
  if (!guiEvent || !guiReply || !mirrorEvent || !mirrorReply || !ts.isTypeLiteralNode(mirrorEvent.type)) {
    throw new Error("a GUI type or its mirror was not found");
  }
  expect(members(mirrorEvent.type.members, here)).toEqual(members(guiEvent.members, gui));
  expect(Object.keys(members(guiEvent.members, gui)).length).toBeGreaterThan(10);
  expect(unionParts(mirrorReply.type, here)).toEqual(unionParts(guiReply.type, gui));
});

test("M2: the 2 MiB details cap survives the verb reply through the card model, separately from Just you", async () => {
  const { liveEvent, cardDetailsReply } = await loadCardModel();
  const attendees = Array.from({ length: 200 }, (_, i) => `ATTENDEE;CN=Attendee Number ${i} With A Long Name:mailto:a${i}@example.com`);
  const events = Array.from({ length: 400 }, (_, i) => ev(`SUMMARY:Meeting ${i}`, `DTSTART:${at(12, 0, i)}`, "DURATION:PT1M", ...attendees));
  const body = feed(ev("SUMMARY:Solo", `DTSTART:${at(11)}`, "DURATION:PT1M"), ...events);
  const r = await details(env({ enabled: true, links: [HOME] }), ["--json"], {
    now: () => new Date().setHours(9, 0, 0, 0), fetch: fakeFetch({ [HOME_URL]: ics(body) }).fetch,
  });
  expect([r.code, r.err]).toEqual([0, []]);
  const doc = r.doc as CalendarDetailsJson;
  expect(doc.events).toHaveLength(401);
  expect(doc.sources).toEqual([{ id: "home", kind: "link", command: false, status: "ok" }]);
  const omitted = doc.events.filter((e) => e.people === null);
  expect(omitted.length).toBeGreaterThan(0);
  expect(doc.events.some((e) => e.people !== null && e.people.length === 200)).toBe(true);
  const solo = doc.events.find((e) => e.title === "Solo")!;
  expect(solo.people).toEqual([]);
  for (const e of [...omitted, solo]) {
    const handle = `card-${e.title}`;
    const event = liveEvent({ ...e, handle, linkState: "none", joinHost: null, needsConfirm: false });
    if (event === null) throw new Error("expected a live event");
    // Rust keeps these two fields verbatim; its parse → held map → get boundary has a separate Rust test.
    const card = cardDetailsReply(handle, { kind: "live", event, footnote: "", lines: [] }, TODAY,
      { people: e.people, notes: e.notes }, Date.parse(doc.readAt));
    expect(card.kind).toBe("details");
    if (card.kind !== "details") throw new Error("expected card details");
    expect(card.details.people).toEqual({ text: e === solo ? "Just you" : "Details not available", chips: [] });
    expect(card.details.notes).toEqual([]);   // no notes: no boxes (the people line above still tells the two apart)
  }
}, 60_000);

describe("arguments, STDIN and the refusal", () => {
  test("only --json, --skip-mac and --skip-commands, once each; --json is required; a fixed code on stderr", async () => {
    const e = env({ enabled: true, links: [HOME] });
    for (const args of [["--json", "--verbose"], ["--json", "--skip-mac", "--skip-mac"], ["--skip-mac"], ["--json", "x"]]) {
      const r = await details(e, args);
      expect([args.join(" "), r.code, r.out]).toEqual([args.join(" "), 2, []]);
    }
    const r = await details(e, ["--json", "--verbose"]);
    expect(r.err).toEqual(["calendar details: bad-arguments"]);
  });
  test("refuses while the engine-resolved enabled is false: exit 0 and the sealed refusal; nothing is read", async () => {
    for (const calendar of [{ enabled: false, links: [WORK] }, undefined, { links: [WORK] }]) {
      const run = runner(WORK_URL);
      const r = await details(env(calendar), ["--json"], { exec: run.exec });
      expect([r.code, r.doc]).toEqual([0, { schemaVersion: 1, refused: "calendar-off" }]);
      expect(run.calls).toEqual([]);
    }
  });
  test("STDIN: empty means none; one byte over 128 KiB is refused with exit 2; not a document is refused", async () => {
    const e = env({ enabled: true, links: [HOME] });
    const f = () => fakeFetch({ [HOME_URL]: ics(feed()) }).fetch;
    expect((await details(e, ["--json"], { fetch: f(), readStdin: async () => "" })).code).toBe(0);
    expect(DETAILS_STDIN_MAX_BYTES).toBe(128 * 1024);
    const over = await details(e, ["--json"], { fetch: f(), readStdin: async () => " ".repeat(DETAILS_STDIN_MAX_BYTES + 1) });
    expect([over.code, over.out, over.err]).toEqual([2, [], ["calendar details: stdin-too-large"]]);
    const atCap = await details(e, ["--json"], { fetch: f(), readStdin: async () => " ".repeat(DETAILS_STDIN_MAX_BYTES) });
    expect(atCap.code).toBe(0);
    for (const bad of ["{", "[]", '{"links":3}']) expect((await details(e, ["--json"], { fetch: f(), readStdin: async () => bad })).code).toBe(2);
  });
  test("a STDIN link with a malformed entryHash is dropped: the command runs", async () => {
    const e = env({ enabled: true, links: [WORK] });
    const hash = linkEntryHash(resolveCalendar({ enabled: true, links: [WORK] }).links[0]!);
    for (const entryHash of [hash.toUpperCase(), hash.slice(1), `${hash.slice(0, 63)}"`]) {
      const run = runner(WORK_URL);
      const r = await details(e, ["--json"], { exec: run.exec, fetch: fakeFetch({ [WORK_URL]: ics(feed()) }).fetch,
        readStdin: async () => JSON.stringify({ links: [{ id: "work", entryHash, url: "https://other.example/x" }] }) });
      expect([r.code, run.calls.length]).toEqual([0, 1]);
      expect(JSON.stringify(r.doc)).not.toContain("other.example");
    }
    // The well-formed one is used.
    const run = runner(WORK_URL);
    const r = await details(e, ["--json"], { exec: run.exec, fetch: fakeFetch({ [WORK_URL]: ics(feed()) }).fetch,
      readStdin: async () => JSON.stringify({ links: [{ id: "work", entryHash: hash, url: WORK_URL }] }) });
    expect([r.code, run.calls.length, r.doc.links]).toEqual([0, 0, [{ id: "work", entryHash: hash, url: WORK_URL }]]);
  });
  test("TTY stdin reads as empty without calling the injected reader", async () => {
    let reads = 0;
    const r = await details(env({ enabled: false }), ["--json"], {
      isTTY: true, readStdin: async () => { reads++; return "{"; },
    });
    expect([r.code, r.doc, r.err, reads]).toEqual([0, { schemaVersion: 1, refused: "calendar-off" }, [], 0]);
  });
});

describe("the sealed document", () => {
  const WORK_FEED = () => feed(
    ev("SUMMARY:Planning", `DTSTART:${at(9)}`, `DTEND:${at(10)}`, "URL:https://zoom.us/j/111", "LOCATION:Room A",
      `DESCRIPTION:${SENT_NOTE}<br>Passcode:\\n99887766`, `ORGANIZER;CN=${SENT_NAME}:mailto:z@x.example`, "ATTENDEE;CN=Sam Lee:mailto:sam@x.example",
      "ATTENDEE;CN=Me:mailto:me@x.example", "STATUS:TENTATIVE"),
    ev("SUMMARY:Lunch", `DTSTART:${at(12)}`, `DTEND:${at(13)}`),
  );
  test("ICS address-only names are null and real names beside addresses are kept", async () => {
    const body = feed(ev("SUMMARY:People", `DTSTART:${at(9)}`, `DTEND:${at(10)}`,
      "ORGANIZER;CN=Alice@Example.com:mailto:alice@example.com",
      "ATTENDEE;CN=alias@example.com:mailto:other@example.com",
      "ATTENDEE;CN=Sam Lee:mailto:sam@example.com"));
    const r = await details(env({ enabled: true, links: [HOME] }), ["--json"], {
      fetch: fakeFetch({ [HOME_URL]: ics(body) }).fetch,
    });
    expect([r.code, r.doc.events[0].people]).toEqual([0, [
      { name: null, organiser: true }, { name: null, organiser: false }, { name: "Sam Lee", organiser: false },
    ]]);
  });
  test.each([
    ['Ada https://private.example/person?pwd=secret', 'Ada private.example link'],
    ['Sam\u202e Lee', 'Sam Lee'],
  ])("shownName cleans ICS CN %s before stdout", async (name, shown) => {
    const body = feed(ev("SUMMARY:Clean names", `DTSTART:${at(9)}`, `DTEND:${at(10)}`,
      `ATTENDEE;CN="${name}":mailto:person@example.com`));
    const r = await details(env({ enabled: true, links: [HOME] }), ["--json"], {
      fetch: fakeFetch({ [HOME_URL]: ics(body) }).fetch,
    });
    expect([r.code, r.doc.events[0].people]).toEqual([0, [{ name: shown, organiser: false }]]);
  });
  test("details-capped later events are listed with no people, notes or join", async () => {
    const people = Array.from({ length: 200 }, (_, i) => `ATTENDEE;CN=Person ${i} ${"N".repeat(190)}:mailto:p${i}@example.com`);
    const body = feed(...Array.from({ length: 60 }, (_, i) => ev(`SUMMARY:Capped ${i}`,
      `DTSTART:${at(Math.floor(i / 4), (i % 4) * 15)}`, "DURATION:PT10M", "URL:https://zoom.us/j/111",
      `DESCRIPTION:${"agenda ".repeat(600)}`, ...people)));
    const parsed = await parseCalendarLink({ link: { id: "home" }, url: HOME_URL, ics: body, emails: [],
      runDate: TODAY, timeoutMs: 20_000, details: true, command: JOB_CHILD });
    const r = await details(env({ enabled: true, links: [HOME] }), ["--json"], {
      fetch: fakeFetch({ [HOME_URL]: ics(body) }).fetch,
    });
    const later = r.doc.events.filter((x: { title: string }) => Number(x.title.slice(7)) >= 55);
    expect([parsed.status === "ok" && parsed.detailsCapped, r.code, r.doc.sources, r.doc.events.length, r.doc.events[0].people.length,
      later.map((x: { title: string; people: unknown[] | null; notes: string | null; join: unknown }) => [x.title, x.people, x.notes, x.join])])
      .toEqual([true, 0, [{ id: "home", kind: "link", command: false, status: "ok" }], 60, 200,
        Array.from({ length: 5 }, (_, i) => [`Capped ${55 + i}`, null, null, null])]);
  });
  test("its shape, every source's status, the link report; you left out; notes lightly cleaned; Join from the raw fields", async () => {
    const e = env({ enabled: true, emails: ["me@x.example"], links: [WORK, HOME] });
    const r = await details(e, ["--json"], { exec: runner(WORK_URL).exec,
      fetch: fakeFetch({ [WORK_URL]: ics(WORK_FEED()), [HOME_URL]: new Response("no", { status: 404 }) }).fetch });
    expect(r.code).toBe(0);
    // No `macConfigured`: nothing read it (Rust's sealed parse has no such field; the webview's comes from `calendar status`).
    expect(Object.keys(r.doc).sort()).toEqual(["events", "links", "readAt", "readerOutdated", "schemaVersion", "sources"]);
    expect([r.doc.schemaVersion, r.doc.readerOutdated]).toEqual([1, false]);
    expect(r.doc.sources).toEqual([{ id: "work", kind: "link", command: true, status: "ok" }, { id: "home", kind: "link", command: false, status: "link-refused", reason: "http-refused" }]);
    const plan = r.doc.events.find((x: { title: string }) => x.title === "Planning");
    expect(Object.keys(plan).sort()).toEqual(["ended", "fromMac", "join", "location", "notes", "people", "rowText", "status", "time", "title"]);
    expect(plan.people).toEqual([{ name: SENT_NAME, organiser: true }, { name: "Sam Lee", organiser: false }]);
    expect(plan.notes).toBe(`${SENT_NOTE}\nPasscode: [redacted]`);
    expect(plan.join).toEqual({ kind: "known", url: "https://zoom.us/j/111", host: "zoom.us" });
    expect([plan.status, plan.ended, plan.fromMac, plan.location]).toEqual(["tentative", Date.now() >= plan.time.endMs, false, "Room A"]);
    const lunch = r.doc.events.find((x: { title: string }) => x.title === "Lunch");
    expect([lunch.people, lunch.notes, lunch.join, lunch.location]).toEqual([[], null, null, null]);
    expect(r.doc.links).toEqual([{ id: "work", entryHash: expect.stringMatching(/^[0-9a-f]{64}$/), url: WORK_URL }]);
    expect(Date.parse(r.doc.readAt)).toBeGreaterThan(0);
  });
  test("a skipped source carries no status: { id, kind, skipped: true }", async () => {
    const e = env({ enabled: true, links: [WORK, HOME] });
    const run = runner(WORK_URL);
    const r = await details(e, ["--json", "--skip-commands"], { exec: run.exec, fetch: fakeFetch({ [HOME_URL]: ics(feed()) }).fetch });
    expect(run.calls).toEqual([]);
    expect(r.doc.sources).toEqual([{ id: "work", kind: "link", command: true, skipped: true }, { id: "home", kind: "link", command: false, status: "ok" }]);
    expect(r.doc.links).toEqual([{ id: "work", entryHash: expect.stringMatching(/^[0-9a-f]{64}$/) }]);
  });
  test("stderr carries no URL, name or note, on a read and on a failure", async () => {
    const e = env({ enabled: true, links: [WORK] });
    const runs = [
      await details(e, ["--json"], { exec: runner(WORK_URL).exec, fetch: fakeFetch({ [WORK_URL]: ics(WORK_FEED()) }).fetch }),
      await details(e, ["--json"], { exec: runner(null).exec, fetch: fakeFetch({}).fetch }),
      await details(e, ["--json", "--nope"], {}),
      await details(e, ["--json"], { readStdin: async () => `{"links":[{"id":"work","entryHash":"${"a".repeat(64)}","url":"${WORK_URL}"` }),
    ];
    expect([runs[3]!.code, runs[3]!.out, runs[3]!.err]).toEqual([2, [], ["calendar details: stdin-invalid"]]);
    for (const r of runs) {
      const text = r.err.join("\n");
      for (const s of [SECRET, "zoom.us", SENT_NAME, "SNTLNOTE", "99887766"]) expect(`${s} in stderr: ${text.includes(s)}`).toBe(`${s} in stderr: false`);
      for (const line of r.err) expect(line).toMatch(/^calendar details: [a-z-]+$/);
    }
  });
  test("an internal exception prints only the fixed code, never its URL-bearing message", async () => {
    const r = await details(env({ enabled: true, links: [HOME] }), ["--json"], {
      now: () => { throw new Error(`internal ${WORK_URL} ${SENT_NAME} ${SENT_NOTE}`); },
    });
    expect([r.code, r.out, r.err]).toEqual([1, [], ["calendar details: internal"]]);
  });
});

describe("rowText is the page's own line", () => {
  test("an overnight start, a start with seconds, an untitled event, all-day and \"time unclear\"", async () => {
    const e = env({ enabled: true, links: [HOME] });
    const body = feed(
      ev("SUMMARY:Overnight", `DTSTART:${at(22, 0, 0, -1)}`, `DTEND:${at(1)}`),
      ev("SUMMARY:Seconds", `DTSTART:${at(9, 30, 15)}`, `DTEND:${at(10, 0, 45)}`, "LOCATION:Room 9"),
      ev("SUMMARY:", `DTSTART:${at(11)}`, `DTEND:${at(11, 30)}`),
      ev("SUMMARY:Holiday", `DTSTART;VALUE=DATE:${TODAY.replace(/-/g, "")}`),
      ev("SUMMARY:Mars call", `DTSTART;TZID=Mars/Olympus:${TODAY.replace(/-/g, "")}T090000`, `DTEND;TZID=Mars/Olympus:${TODAY.replace(/-/g, "")}T100000`),
    );
    const r = await details(e, ["--json"], { fetch: fakeFetch({ [HOME_URL]: ics(body) }).fetch });
    // The page's own lines for the same read: the morning's struct, rendered.
    const res = resolveCalendar({ enabled: true, links: [HOME] }, { platform: "linux" });
    const read = await readCalendar(res, { runDate: TODAY, startedAt: Date.now(), offline: false },
      { stateDir: e.state, platform: "linux", env: { HOME_URL }, parseCommand: JOB_CHILD, fetch: fakeFetch({ [HOME_URL]: ics(body) }).fetch });
    const page = renderCalendarSection(toCalendarStruct(read.events, read.sources, read.nowMs), TODAY)
      .filter((l) => l.startsWith(CALENDAR_LINE_PREFIX)).map((l) => l.slice(CALENDAR_LINE_PREFIX.length))
      .filter((l) => !l.startsWith("home: "));   // the source's status line (the unclear time makes it incomplete)
    const rows: string[] = r.doc.events.map((x: { rowText: string }) => x.rowText);
    expect(rows.length).toBe(5);
    expect([...rows].sort()).toEqual([...page].sort());
    expect(rows.some((t) => t.startsWith("since yesterday"))).toBe(true);
    expect(rows.some((t) => t.includes("(no title)"))).toBe(true);
    expect(rows.some((t) => t.startsWith("all day — Holiday"))).toBe(true);
    expect(rows.some((t) => t.startsWith("time unclear (09:00–10:00"))).toBe(true);
    expect(rows.find((t) => t.includes("Seconds"))!.startsWith(`${at(9, 30).slice(0, 0)}`)).toBe(true);
    const unclear = r.doc.events.find((x: { title: string }) => x.title === "Mars call");
    expect(unclear.time.kind).toBe("unclear");
  });
  test("over the 60-line cap, with a series whose repeats sectionOrder moves: each rowText is its own event's, with its own details", async () => {
    const e = env({ enabled: true, links: [HOME] });
    const oneOffs = Array.from({ length: 50 }, (_, i) => ev(`SUMMARY:Meeting ${i}`, `DTSTART:${at(Math.floor(i / 4) + 8, (i % 4) * 15)}`,
      `DTEND:${at(Math.floor(i / 4) + 8, (i % 4) * 15 + 10)}`, `URL:https://zoom.us/j/${1000 + i}`));
    const series = ["BEGIN:VEVENT", "UID:tick@test", `DTSTART:${at(0, 5)}`, "DURATION:PT5M", "RRULE:FREQ=HOURLY", "SUMMARY:Tick", "URL:https://zoom.us/j/9999", "END:VEVENT"];
    const r = await details(e, ["--json"], { fetch: fakeFetch({ [HOME_URL]: ics(feed(...oneOffs, series)) }).fetch });
    expect(r.doc.events.length).toBeGreaterThan(60);
    const hhmm = (ms: number): string => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };
    for (const x of r.doc.events as { title: string; rowText: string; time: { kind: string; startMs: number }; join: { url: string } }[]) {
      expect(x.rowText.startsWith(hhmm(x.time.startMs))).toBe(true);
      expect(x.rowText).toContain(`  ${x.title}`);
      const n = x.title === "Tick" ? "9999" : String(1000 + Number(x.title.slice("Meeting ".length)));
      expect(x.join.url).toBe(`https://zoom.us/j/${n}`);
    }
  }, 30_000);
});

describe("the Mac source through the details path", () => {
  function macEnv(version: number) {
    const e = env({ enabled: true, macos: {} });
    const app = calendarReaderCopy(e.state);
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(readerExecutable(app), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(app, "Contents", "Info.plist"), `<plist><dict><key>CFBundleVersion</key><string>${version}</string></dict></plist>\n`);
    return e;
  }
  const hour = (h: number): number => { const d = new Date(); d.setHours(h, 0, 0, 0); return d.getTime(); };
  function macFake(events: unknown[]) {
    const calls: string[][] = [];
    const exec = (async (cmd: string[]) => {
      calls.push([...cmd]);
      if (cmd[0] === "mkfifo") return { ...OK, code: Bun.spawnSync(["mkfifo", ...cmd.slice(1)]).exitCode ?? 1 };
      const fifo = cmd[cmd.indexOf("--fifo") + 1]!, id = cmd[cmd.indexOf("--id") + 1]!;
      const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      try { writeSync(fd, `${JSON.stringify({ v: 1, id, status: "ok", helperVersion: "1", events })}\n`); } finally { closeSync(fd); }
      return OK;
    }) as unknown as ReaderExec;
    return { exec, calls };
  }
  const MAC = { platform: "darwin" as const, osRelease: "23.6.0" };
  const trigger = (calls: string[][]) => calls.find((c) => c[0] === "open")!;

  test("Mac address-only names are null and real names beside addresses are kept", async () => {
    const f = macFake([{ calendarId: "c", title: "People", startMs: hour(9), endMs: hour(10),
      organizer: { name: "Alice@Example.com", email: "alice@example.com", isCurrentUser: false },
      attendees: [{ name: "alias@example.com", email: "other@example.com", isCurrentUser: false },
        { name: "Sam Lee", email: "sam@example.com", isCurrentUser: false }] }]);
    const r = await details(macEnv(2), ["--json"], { ...MAC, macExec: f.exec });
    expect([r.code, r.doc.events[0].people]).toEqual([0, [
      { name: null, organiser: true }, { name: null, organiser: false }, { name: "Sam Lee", organiser: false },
    ]]);
  });
  test("an outdated (version 1) copy still reads: people, notes, a location or notes link; readerOutdated", async () => {
    const e = macEnv(1);
    const f = macFake([{ calendarId: "c", title: "Standup", startMs: hour(9), endMs: hour(9) + 900_000, location: "https://meet.google.com/abc-defg-hij",
      notes: "Agenda: demo", attendees: [{ name: "Ana Novak", isCurrentUser: false }, { name: "Me", isCurrentUser: true }] }]);
    const r = await details(e, ["--json"], { ...MAC, macExec: f.exec });
    expect([r.code, r.doc.readerOutdated, "macConfigured" in r.doc]).toEqual([0, true, false]);
    expect(r.doc.sources).toEqual([{ id: "macos", kind: "macos", status: "ok" }]);
    const x = r.doc.events[0];
    expect([x.fromMac, x.people, x.notes, x.join]).toEqual([true, [{ name: "Ana Novak", organiser: false }], "Agenda: demo",
      { kind: "known", url: "https://meet.google.com/abc-defg-hij", host: "meet.google.com" }]);
    expect(trigger(f.calls)).not.toContain("--refresh-wait");
  });
  test("version gating: with LIVE_READ_REFRESH_WAIT injected as 0, a version-2 copy gets --refresh-wait 0 and a version-1 copy none; as shipped, none", async () => {
    expect(LIVE_READ_REFRESH_WAIT).toBeUndefined();
    const v2 = macFake([]), v1 = macFake([]), shipped = macFake([]);
    await details(macEnv(2), ["--json"], { ...MAC, macExec: v2.exec, liveRefreshWait: 0 });
    await details(macEnv(1), ["--json"], { ...MAC, macExec: v1.exec, liveRefreshWait: 0 });
    await details(macEnv(2), ["--json"], { ...MAC, macExec: shipped.exec });
    expect(trigger(v2.calls).slice(-2)).toEqual(["--refresh-wait", "0"]);
    expect(trigger(v1.calls)).not.toContain("--refresh-wait");
    expect(trigger(shipped.calls)).not.toContain("--refresh-wait");
  });
  test("--skip-mac skips the Mac source: no trigger, listed as skipped", async () => {
    const f = macFake([]);
    const r = await details(macEnv(2), ["--json", "--skip-mac"], { ...MAC, macExec: f.exec });
    expect(f.calls).toEqual([]);
    expect(r.doc.sources).toEqual([{ id: "macos", kind: "macos", skipped: true }]);
  });
});

describe("the maximal handback", () => {
  test("ten links with 32-character ids and 4 096-byte URLs of `\"` and `\\` (escaped as Rust writes them) are read whole", async () => {
    const ids = Array.from({ length: 10 }, (_, i) => `l${String(i).padStart(31, "x")}`);
    const urlOf = (i: number): string => `https://h/${(i % 2 ? '"\\' : '\\"').repeat(2048)}`.slice(0, 4096);
    const links = ids.map((id) => ({ id, urlCommand: ["pw", "show", id] }));
    const res = resolveCalendar({ enabled: true, links }, { platform: "linux" });
    expect(res.links.length).toBe(10);
    // Rust's snapshot (C-M3-T8): only `"` and `\` escaped, the hash unescaped hex.
    const esc = (s: string): string => s.replace(/[\\"]/g, (c) => `\\${c}`);
    const stdin = `{"links":[${res.links.map((l, i) => `{"id":"${l.id}","entryHash":"${linkEntryHash(l)}","url":"${esc(urlOf(i))}"}`).join(",")}]}`;
    expect(Buffer.byteLength(stdin)).toBeLessThanOrEqual(83_231);
    expect(Buffer.byteLength(urlOf(0))).toBe(4096);
    const run = runner(null);
    const f = fakeFetch({});
    const r = await details(env({ enabled: true, links }), ["--json"], { exec: run.exec, fetch: f.fetch, readStdin: async () => stdin });
    expect(r.code).toBe(0);
    expect(run.calls).toEqual([]);   // every link's handed URL was used: the document was read whole
    expect(r.doc.sources.length).toBe(10);
  });
});

describe("no file is written during a read (the jail)", () => {
  test("the state dir, TMPDIR, HOME and the app data dir hold the same regular files before and after; the reader FIFO is gone", async () => {
    // RESIDUAL (C "Tests"): a file written and deleted again inside the read leaves no trace in this snapshot.
    const jail = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-caldet-jail-")));
    const dirs = { home: join(jail, "home"), tmp: join(jail, "tmp"), xdg: join(jail, "xdg"), state: join(jail, "state"), appData: join(jail, "home", "Library", "Application Support", "Daily Briefing") };
    for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });
    const configFile = join(dirs.xdg, "daily-briefing", "config.json");
    mkdirSync(join(dirs.xdg, "daily-briefing"), { recursive: true });
    writeFileSync(configFile, JSON.stringify({ calendar: { enabled: true, macos: {}, links: [WORK, HOME] } }));
    writeFileSync(join(dirs.appData, "prefs.json"), "{}");
    const app = calendarReaderCopy(dirs.state);
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    writeFileSync(readerExecutable(app), "#!/bin/sh\n", { mode: 0o755 });
    writeFileSync(join(app, "Contents", "Info.plist"), "<plist><dict><key>CFBundleVersion</key><string>2</string></dict></plist>\n");
    mkdirSync(calendarReaderRunDir(dirs.state), { recursive: true, mode: 0o700 });   // run/ created beforehand
    const snapshot = (): string[] => {
      const out: string[] = [];
      const walk = (d: string): void => {
        for (const n of readdirSync(d)) {
          const p = join(d, n), st = lstatSync(p);
          if (st.isDirectory()) walk(p);
          else out.push(`${p.slice(jail.length)} ${st.isFile() ? "file" : st.isFIFO() ? "fifo" : "other"} ${st.size} ${st.mtimeMs} ${st.ino}`);
        }
      };
      walk(jail);
      return out.sort();
    };
    // The read runs in a child process whose HOME, TMPDIR, XDG_CONFIG_HOME and state dir are the jail's, so a write
    // through any of them lands here. Its fakes (runner, fetch, the Mac trigger) are the same as this file's.
    const scripts = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-caldet-jail-script-")));
    const script = join(scripts, "read.ts");
    writeFileSync(script, `
      import { closeSync, constants, openSync, writeSync } from "node:fs";
      import { calendarMain } from ${JSON.stringify(join(ROOT, "src/calendar/cli.ts"))};
      const OK = { out: "", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false };
      const feed = ${JSON.stringify(feed(ev("SUMMARY:Planning", `DTSTART:${at(9)}`, `DTEND:${at(10)}`, "URL:https://zoom.us/j/1", `DESCRIPTION:${SENT_NOTE}`)))};
      const macExec = async (cmd) => {
        if (cmd[0] === "mkfifo") return { ...OK, code: Bun.spawnSync(["mkfifo", ...cmd.slice(1)]).exitCode ?? 1 };
        const fifo = cmd[cmd.indexOf("--fifo") + 1], id = cmd[cmd.indexOf("--id") + 1];
        const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
        const start = new Date(); start.setHours(11, 0, 0, 0);
        try { writeSync(fd, JSON.stringify({ v: 1, id, status: "ok", helperVersion: "2", events: [{ calendarId: "c", title: "Mac thing", startMs: start.getTime(), endMs: start.getTime() + 600000, url: "https://zoom.us/j/2" }] }) + "\\n"); } finally { closeSync(fd); }
        return OK;
      };
      const out = [];
      const code = await calendarMain(["details", "--json"], {
        stateDir: ${JSON.stringify(dirs.state)}, configFile: ${JSON.stringify(configFile)}, platform: "darwin", osRelease: "23.6.0",
        parseCommand: ${JSON.stringify(JOB_CHILD)}, env: { HOME_URL: ${JSON.stringify(HOME_URL)} }, macExec,
        exec: async () => ({ ...OK, out: ${JSON.stringify(WORK_URL)} + "\\n" }),
        fetch: async (url) => url === ${JSON.stringify(WORK_URL)} ? new Response(feed, { status: 200 }) : new Response("busy", { status: 503 }),
        readStdin: async () => "", out: (s) => out.push(s), err: (s) => process.stderr.write(s + "\\n"),
      });
      await Bun.write(Bun.stdout, JSON.stringify({ code, out }));
      process.exit(0);   // as src/main.ts does: the read's overall-bound timer is not awaited
    `);
    const before = snapshot();
    const p = Bun.spawnSync([process.execPath, script], {
      // BUN_RUNTIME_TRANSPILER_CACHE_PATH=0: this TEST runs the engine from source, and Bun's transpiler cache (a
      // property of the test runner, not of the compiled engine, which transpiles nothing) would land in HOME.
      // Keep the fixture's UTC day in the isolated child too, even when the host's local day differs.
      cwd: dirs.tmp, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", TZ: Intl.DateTimeFormat().resolvedOptions().timeZone, HOME: dirs.home, TMPDIR: dirs.tmp, XDG_CONFIG_HOME: dirs.xdg, DAILY_BRIEFING_STATE_DIR: dirs.state, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdout: "pipe", stderr: "pipe",
    });
    const result = JSON.parse(p.stdout.toString()) as { code: number; out: string[] };
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out[0]!);
    expect(doc.events.map((x: { title: string }) => x.title).sort()).toEqual(["Mac thing", "Planning"]);
    expect(p.stderr.toString()).toBe("");
    expect(snapshot()).toEqual(before);
    expect(readdirSync(calendarReaderRunDir(dirs.state))).toEqual([]);   // the FIFO is gone
  }, 60_000);
});


test("M3: details sources identify command, env and file links independently of the command report", async () => {
  const e = env({ enabled: true, links: [WORK, HOME, { id: "file" }] });
  mkdirSync(join(e.state, "calendar", "links"), { recursive: true, mode: 0o700 });
  writeFileSync(join(e.state, "calendar", "links", "file.url"), "https://file.example/cal.ics\n", { mode: 0o600 });
  const r = await details(e, ["--json"], { exec: runner(WORK_URL).exec,
    fetch: fakeFetch({ [WORK_URL]: ics(feed()), [HOME_URL]: ics(feed()), "https://file.example/cal.ics": ics(feed()) }).fetch });
  expect(r.code).toBe(0);
  expect(r.doc.sources).toEqual([
    { id: "work", kind: "link", command: true, status: "ok" },
    { id: "home", kind: "link", command: false, status: "ok" },
    { id: "file", kind: "link", command: false, status: "ok" },
  ]);
  expect(r.doc.links.map((l: { id: string }) => l.id)).toEqual(["work"]);
});
