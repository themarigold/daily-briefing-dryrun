import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/calendar-mac-source.test.ts — the Mac source's FIFO hand-off and normalisation (v0.3.0 plan M10c), the
// attended install of the reader copy and `calendar connect mac` (M10b) (spec r4 §4.1, §5, §10). REAL named pipes (the FIFO code under test is the production code, on Linux here and on macOS
// in a local run), a FAKE trigger: the injected exec makes the FIFO with the real `mkfifo` and, when asked to start
// the reader, plays the helper itself — opens the pipe's write end and writes canned JSON. Nothing launches an app.
import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync, closeSync, constants, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, renameSync, statSync, symlinkSync, utimesSync, writeFileSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import {
  listMacCalendars, macCalendarSelected, readMacCalendar, requestMacAccess, runReader, selectionArgs, sweepStaleFifos,
  READER_STALE_MS, type ReaderExec,
} from "../src/calendar/mac-source";
import { macEventFrom, macEventsFrom } from "../src/calendar/mac-events";
import type { CalEvent } from "../src/calendar/types";
import { calendarReaderCopy, calendarReaderRunDir, readerExecutable, CALENDAR_READER_VERSION } from "../src/calendar/reader";
import { readCalendar } from "../src/calendar/pipeline";
import { resolveCalendar } from "../src/calendar/config";
import { localDateStr } from "../src/marker";
import type { RunResult } from "../src/proc";
import { installReaderCopy } from "../src/calendar/reader-install";
import { calendarMain } from "../src/calendar/cli";
import type { Exec } from "../src/schedule/install";

const ID = "0123456789abcdef0123456789abcdef";
const OK: RunResult = { out: "", err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false };

function stateWithCopy(version: number | null = CALENDAR_READER_VERSION): string {
  const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-macsrc-")));
  const app = calendarReaderCopy(state);
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(readerExecutable(app), "#!/bin/sh\n", { mode: 0o755 });
  if (version !== null) {
    writeFileSync(join(app, "Contents", "Info.plist"), `<plist><dict><key>CFBundleVersion</key>\n\t<string>${version}</string></dict></plist>\n`);
  }
  return state;
}

type Play = (fifo: string, id: string) => void | Promise<void>;
type Fake = { exec: ReaderExec; calls: string[][] };

/** The injected exec: a real FIFO for `mkfifo`; for the trigger, `play` acts as the helper. `exit` decides whether
 *  the trigger "exits" after playing (true), or never does (a hang). */
function fake(play: Play, opts: { exit?: boolean; mkfifoFails?: boolean } = {}): Fake {
  const calls: string[][] = [];
  const exec: ReaderExec = async (cmd) => {
    calls.push([...cmd]);
    if (cmd[0] === "mkfifo") {
      if (opts.mkfifoFails) return { ...OK, code: 1 };
      const p = Bun.spawnSync(["mkfifo", ...cmd.slice(1)]);
      return { ...OK, code: p.exitCode ?? 1 };
    }
    const fifo = cmd[cmd.indexOf("--fifo") + 1]!, id = cmd[cmd.indexOf("--id") + 1]!;
    await new Promise((r) => setTimeout(r, 5));
    await play(fifo, id);
    if (opts.exit === false) return new Promise<RunResult>(() => {});
    return OK;
  };
  return { exec, calls };
}

/** Write lines to the FIFO as the helper does (the engine holds the read end, so a non-blocking open succeeds). */
function writeLines(fifo: string, ...lines: string[]): void {
  const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
  try { for (const l of lines) writeSync(fd, l); } finally { closeSync(fd); }
}
const doc = (id: string, extra: Record<string, unknown> = {}): string => `${JSON.stringify({ v: 1, id, status: "ok", helperVersion: "1", ...extra })}\n`;

describe("runReader — the FIFO hand-off", () => {
  test("no copy installed → helper-missing, nothing run", async () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-macsrc-")));
    const f = fake(() => {});
    expect(await runReader("read", [], { stateDir: state, exec: f.exec })).toEqual({ ok: false, status: "helper-missing", reason: "no-copy" });
    expect(f.calls).toEqual([]);
  });

  test("a document with this invocation's id is returned; the trigger is LaunchServices with the FIFO and id; the FIFO is removed", async () => {
    const state = stateWithCopy();
    const f = fake((fifo, id) => writeLines(fifo, doc(id, { events: [] })));
    const r = await runReader("read", ["--select", "editable"], { stateDir: state, exec: f.exec, newId: () => ID });
    expect(r).toEqual({ ok: true, doc: { v: 1, id: ID, status: "ok", helperVersion: "1", events: [] } });
    const fifo = join(calendarReaderRunDir(state), `${ID}.fifo`);
    expect(f.calls[0]).toEqual(["mkfifo", "-m", "600", fifo]);
    const trigger = f.calls[1]!;
    expect(trigger[0]).toBe("open");
    expect(trigger.slice(1)).toEqual(["-g", "-j", "-n", "-W", calendarReaderCopy(state), "--args", "read", "--fifo", fifo, "--id", ID, "--select", "editable"]);
    expect(existsSync(fifo)).toBe(false);
    expect(statSync(calendarReaderRunDir(state)).mode & 0o777).toBe(0o700);
  });

  test("a document with another id is ignored; the right one after it is taken", async () => {
    const state = stateWithCopy();
    const f = fake((fifo, id) => writeLines(fifo, doc("f".repeat(32), { events: ["not mine"] }), doc(id, { events: [] })));
    const r = await runReader("read", [], { stateDir: state, exec: f.exec });
    expect(r.ok && r.doc.events).toEqual([]);
  });

  test("only a wrong id, then a hang → timeout at the abandonment deadline, FIFO removed", async () => {
    const state = stateWithCopy();
    const f = fake((fifo) => writeLines(fifo, doc("f".repeat(32))), { exit: false });
    const t0 = Date.now();
    const r = await runReader("read", [], { stateDir: state, exec: f.exec, abandonMs: 300, newId: () => ID });
    expect(r).toEqual({ ok: false, status: "timeout", reason: "helper-abandoned" });
    expect(Date.now() - t0).toBeLessThan(2_000);
    expect(readdirSync(calendarReaderRunDir(state))).toEqual([]);
  });

  test("a hang with nothing written → timeout; a crash (exit, nothing written) → helper-exited, before the deadline", async () => {
    const hung = await runReader("status", [], { stateDir: stateWithCopy(), exec: fake(() => {}, { exit: false }).exec, abandonMs: 250 });
    expect(hung).toEqual({ ok: false, status: "timeout", reason: "helper-abandoned" });
    const t0 = Date.now();
    const crashed = await runReader("status", [], { stateDir: stateWithCopy(), exec: fake(() => {}).exec, abandonMs: 10_000 });
    expect(crashed).toEqual({ ok: false, status: "malformed", reason: "helper-exited" });
    expect(Date.now() - t0).toBeLessThan(5_000);
  });

  test("the trigger's exit status is not trusted: a document arrives though the trigger 'failed'", async () => {
    const state = stateWithCopy();
    const base = fake((fifo, id) => writeLines(fifo, doc(id)));
    const exec: ReaderExec = async (cmd, o) => ({ ...(await base.exec(cmd, o)), code: cmd[0] === "mkfifo" ? 0 : 1 });
    expect((await runReader("status", [], { stateDir: state, exec })).ok).toBe(true);
  });

  test("a document split across writes is reassembled", async () => {
    const state = stateWithCopy();
    const f = fake(async (fifo, id) => {
      const d = doc(id, { events: [] });
      const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      writeSync(fd, d.slice(0, 10));
      await new Promise((r) => setTimeout(r, 80));
      writeSync(fd, d.slice(10));
      closeSync(fd);
    });
    expect((await runReader("read", [], { stateDir: state, exec: f.exec })).ok).toBe(true);
  });

  test("a line that is not JSON is ignored like another id's; an oversize document and a failed mkfifo are malformed", async () => {
    const r = await runReader("read", [], { stateDir: stateWithCopy(), exec: fake((fifo, id) => writeLines(fifo, "{not json\n", doc(id, { events: [] }))).exec });
    expect(r.ok).toBe(true);
    expect(await runReader("read", [], { stateDir: stateWithCopy(), exec: fake((fifo) => writeLines(fifo, "{not json\n"), { exit: false }).exec, abandonMs: 250 }))
      .toEqual({ ok: false, status: "timeout", reason: "helper-abandoned" });
    expect(await runReader("read", [], { stateDir: stateWithCopy(), exec: fake((fifo) => writeLines(fifo, "x".repeat(2048))).exec, maxDocumentBytes: 1024 }))
      .toEqual({ ok: false, status: "malformed", reason: "document-too-large" });
    expect(await runReader("read", [], { stateDir: stateWithCopy(), exec: fake(() => {}, { mkfifoFails: true }).exec }))
      .toEqual({ ok: false, status: "malformed", reason: "mkfifo-failed" });
  });

  test("a crash mid-document (a partial line, then exit) is helper-exited; both pipe ends are closed every time", async () => {
    const fds = (): number => readdirSync("/dev/fd").length;   // Linux and macOS alike
    const before = fds();
    const r = await runReader("read", [], { stateDir: stateWithCopy(), exec: fake((fifo, id) => writeLines(fifo, doc(id).slice(0, 20))).exec });
    expect(r).toEqual({ ok: false, status: "malformed", reason: "helper-exited" });
    await runReader("read", [], { stateDir: stateWithCopy(), exec: fake(() => {}, { exit: false }).exec, abandonMs: 200 });
    await runReader("read", [], { stateDir: stateWithCopy(), exec: fake((fifo, id) => writeLines(fifo, doc(id))).exec });
    expect(fds()).toBe(before);
  });

  test("a writer streaming junk lines cannot hold the read past its deadline", async () => {
    const state = stateWithCopy();
    let stop = false;
    const f = fake(async (fifo) => {
      const fd = openSync(fifo, constants.O_WRONLY | constants.O_NONBLOCK);
      const junk = `${JSON.stringify({ v: 1, id: "f".repeat(32) })}\n`.repeat(100);
      while (!stop) { try { writeSync(fd, junk); } catch { /* pipe full */ } await new Promise((r) => setTimeout(r, 1)); }
      closeSync(fd);
    }, { exit: false });
    const t0 = Date.now();
    const r = await runReader("read", [], { stateDir: state, exec: f.exec, abandonMs: 400 });
    stop = true;
    expect(r.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(3_000);
  });

  test("runReader sweeps a stale FIFO from run/ at its start and leaves a fresh one (a concurrent invocation's)", async () => {
    const state = stateWithCopy();
    const run = calendarReaderRunDir(state);
    mkdirSync(run, { recursive: true, mode: 0o700 });
    for (const n of ["stale.fifo", "fresh.fifo"]) Bun.spawnSync(["mkfifo", "-m", "600", join(run, n)]);
    const old = (Date.now() - READER_STALE_MS - 60_000) / 1000;
    utimesSync(join(run, "stale.fifo"), old, old);
    await runReader("status", [], { stateDir: state, exec: fake((fifo, id) => writeLines(fifo, doc(id))).exec });
    expect(readdirSync(run)).toEqual(["fresh.fifo"]);
  });

  test("a relative state folder still hands the helper absolute paths", async () => {
    const state = stateWithCopy();
    const f = fake((fifo, id) => writeLines(fifo, doc(id)));
    const rel = relative(process.cwd(), state);
    expect(rel.startsWith("/")).toBe(false);
    expect((await runReader("status", [], { stateDir: rel, exec: f.exec })).ok).toBe(true);
    for (const a of f.calls[1]!.filter((x) => x.includes("/"))) expect(a.startsWith("/")).toBe(true);
  });

  test("a symlinked run folder is refused before anything runs", async () => {
    const state = stateWithCopy();
    const elsewhere = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-macsrc-x-")));
    Bun.spawnSync(["ln", "-s", elsewhere, calendarReaderRunDir(state)]);
    const f = fake(() => {});
    expect(await runReader("read", [], { stateDir: state, exec: f.exec })).toEqual({ ok: false, status: "malformed", reason: "dir-symlink" });
    expect(f.calls).toEqual([]);
  });

  test("stale FIFOs are swept at the start; fresh ones and other names are kept", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-macsrc-sweep-")));
    for (const n of ["old.fifo", "new.fifo", "keep.txt"]) writeFileSync(join(dir, n), "");
    const old = (Date.now() - READER_STALE_MS - 60_000) / 1000;
    utimesSync(join(dir, "old.fifo"), old, old);
    utimesSync(join(dir, "keep.txt"), old, old);
    expect(await sweepStaleFifos(dir, Date.now())).toBe(1);
    expect(readdirSync(dir).sort()).toEqual(["keep.txt", "new.fifo"]);
  });
});

describe("readMacCalendar / listMacCalendars / requestMacAccess", () => {
  const mac = { platform: "darwin" as const, osRelease: "24.1.0" };

  test("M2: details v2 gets --with-url; morning argv and outdated-copy argv stay unchanged", async () => {
    for (const [version, detailsMode, flags] of [[2, true, ["--with-url", "--refresh-wait", "0"]], [2, false, []], [1, true, []]] as const) {
      const f = fake((fifo, id) => writeLines(fifo, doc(id, { events: [] })));
      const state = stateWithCopy(version);
      const r = await readMacCalendar("editable", [], { ...mac, stateDir: state, exec: f.exec, newId: () => ID },
        { ...(detailsMode ? { details: { runDate: localDateStr(new Date()) } } : {}), refreshWait: 0 });
      expect(r.status).toBe("ok");
      const trigger = f.calls[1]!;
      expect(trigger[0]).toBe("open");
      expect(trigger.slice(1)).toEqual(["-g", "-j", "-n", "-W", calendarReaderCopy(state), "--args", "read", "--fifo", join(calendarReaderRunDir(state), `${ID}.fifo`), "--id", ID, "--select", "editable", ...flags]);
    }
    const f = fake((fifo, id) => writeLines(fifo, doc(id, { events: [] })));
    await readMacCalendar("editable", [], { ...mac, stateDir: stateWithCopy(2), exec: f.exec }, { details: { runDate: localDateStr(new Date()) } });
    expect(f.calls.find((c) => c[0] === "open")!.slice(-1)).toEqual(["--with-url"]);
  });

  test("every helper status maps through; unknown ones are malformed", async () => {
    for (const status of ["not-granted", "write-only", "denied", "restricted"]) {
      const r = await readMacCalendar("editable", [], { ...mac, stateDir: stateWithCopy(), exec: fake((f, id) => writeLines(f, doc(id, { status }))).exec });
      expect(r).toEqual({ status: status as never, reason: `helper-${status}`, events: [] });
    }
    for (const [status, want] of [["unsupported-os", { status: "unsupported-os", reason: "helper-unsupported-os", events: [] }], ["error", { status: "malformed", reason: "helper-status", events: [] }], ["weird", { status: "malformed", reason: "helper-status", events: [] }]] as const) {
      const r = await readMacCalendar("editable", [], { ...mac, stateDir: stateWithCopy(), exec: fake((f, id) => writeLines(f, doc(id, { status }))).exec });
      expect(r).toEqual(want as never);
    }
    // An `ok` read or list without its array fails closed: no array is not a free day, nor an empty Mac.
    expect(await readMacCalendar("editable", [], { ...mac, stateDir: stateWithCopy(), exec: fake((f, id) => writeLines(f, doc(id))).exec }))
      .toEqual({ status: "malformed", reason: "no-events", events: [] });
    expect(await listMacCalendars("editable", { ...mac, stateDir: stateWithCopy(), exec: fake((f, id) => writeLines(f, doc(id))).exec }))
      .toEqual({ status: "malformed", reason: "no-calendars", calendars: [] });
  });

  test("macOS 13, Linux and an explicit empty choice launch nothing", async () => {
    const f = fake(() => {});
    expect((await readMacCalendar("editable", [], { platform: "darwin", osRelease: "22.6.0", stateDir: stateWithCopy(), exec: f.exec })).status).toBe("unsupported-os");
    expect((await readMacCalendar("all", [], { platform: "linux", stateDir: stateWithCopy(), exec: f.exec })).status).toBe("unsupported-os");
    expect(await readMacCalendar([], [], { ...mac, stateDir: stateWithCopy(), exec: f.exec })).toEqual({ status: "ok", events: [] });
    expect((await requestMacAccess({ platform: "darwin", osRelease: "22.6.0", stateDir: stateWithCopy(), exec: f.exec })).status).toBe("unsupported-os");
    expect(f.calls).toEqual([]);
  });

  test("an older copy reads with the helper-outdated notice; truncated and missing calendars are incomplete", async () => {
    const outdated = await readMacCalendar("editable", [], { ...mac, stateDir: stateWithCopy(0), exec: fake((f, id) => writeLines(f, doc(id, { events: [] }))).exec });
    expect(outdated).toEqual({ status: "ok", notices: ["helper-outdated"], events: [] });
    const truncated = await readMacCalendar("all", [], { ...mac, stateDir: stateWithCopy(), exec: fake((f, id) => writeLines(f, doc(id, { events: [], truncated: true }))).exec });
    expect(truncated).toEqual({ status: "incomplete", reason: "truncated", events: [] });
    const missing = await readMacCalendar([{ id: "gone", title: "t", account: "a" }], [], { ...mac, stateDir: stateWithCopy(), exec: fake((f, id) => writeLines(f, doc(id, { events: [], missingCalendars: 1 }))).exec });
    expect(missing).toEqual({ status: "incomplete", reason: "calendar-missing", events: [] });
  });

  test("selection arguments and the engine's mirror of the helper's 'editable' rule", () => {
    expect(selectionArgs("editable")).toEqual(["--select", "editable"]);
    expect(selectionArgs("all")).toEqual(["--select", "all"]);
    expect(selectionArgs([{ id: "a", title: "A", account: "x" }, { id: "b", title: "B", account: "y" }])).toEqual(["--calendar", "a", "--calendar", "b"]);
    expect(macCalendarSelected({ id: "1", editable: true, type: "birthdays" }, "editable")).toBe(false);
    expect(macCalendarSelected({ id: "1", editable: false, type: "standard" }, "editable")).toBe(false);
    expect(macCalendarSelected({ id: "1", editable: false, type: "subscribed" }, "all")).toBe(true);
    expect(macCalendarSelected({ id: "1", editable: true, type: "standard" }, [{ id: "2", title: "", account: "" }])).toBe(false);
  });

  test("list: calendars validated, cleaned and marked selected", async () => {
    const calendars = [
      { id: "w", title: "Work", account: "iCloud", editable: true, type: "standard" },
      { id: "b", title: "Birthdays", account: "Other", editable: false, type: "birthdays" },
      { id: "", title: "bad", account: "x", editable: true, type: "standard" },
      { id: "z", title: "Zed", account: "x", editable: true, type: "weird" },
    ];
    const r = await listMacCalendars("editable", { ...mac, stateDir: stateWithCopy(), exec: fake((f, id) => writeLines(f, doc(id, { calendars }))).exec });
    expect(r).toEqual({ status: "ok", calendars: [
      { id: "w", title: "Work", account: "iCloud", editable: true, type: "standard", selected: true },
      { id: "b", title: "Birthdays", account: "Other", editable: false, type: "birthdays", selected: false },
    ] });
  });

  test("request: the attended mode, its timeout and a grant", async () => {
    const f = fake((fifo, id) => writeLines(fifo, doc(id)));
    expect(await requestMacAccess({ ...mac, stateDir: stateWithCopy(), exec: f.exec })).toEqual({ status: "ok" });
    expect(f.calls[1]![7]).toBe("request");
    // The helper waits a little less than the engine (`--wait`), so its own `timeout` arrives in time.
    expect(f.calls[1]!.slice(-2)).toEqual(["--wait", "120"]);   // 128 s − 6, capped at the helper's 120
    const short = fake((fifo, id) => writeLines(fifo, doc(id)));
    await requestMacAccess({ ...mac, stateDir: stateWithCopy(), exec: short.exec, abandonMs: 30_000 });
    expect(short.calls[1]!.slice(-2)).toEqual(["--wait", "24"]);
    expect(await requestMacAccess({ ...mac, stateDir: stateWithCopy(), exec: fake((x, id) => writeLines(x, doc(id, { status: "timeout" }))).exec }))
      .toEqual({ status: "timeout", reason: "helper-timeout" });
    // A grant in the last moments: the request timed out, the status re-check says ok — granted.
    const late = fake((x, id) => {
      const mode = late.calls.at(-1)![7];
      writeLines(x, doc(id, { status: mode === "request" ? "timeout" : "ok" }));
    });
    expect(await requestMacAccess({ ...mac, stateDir: stateWithCopy(), exec: late.exec })).toEqual({ status: "ok" });
    expect(late.calls.filter((c) => c[0] !== "mkfifo").map((c) => c[7])).toEqual(["request", "status"]);
  });
});

describe("mac-events — the read document → CalEvent", () => {
  const day = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime();

  test("a timed event with your acceptance; key a spelled as epoch ms; text cleaned", () => {
    const ev = macEventFrom({
      calendarId: "cal1", editable: true, allDay: false, startMs: day(2026, 10, 14, 9), endMs: day(2026, 10, 14, 9, 30),
      title: "Standup https://meet.example.com/abc", uid: "U1", occurrenceMs: day(2026, 10, 14, 9), location: "Room 4",
      notes: "Passcode: 12345", lastModifiedMs: 5, availability: "busy", status: "confirmed",
      organizer: { name: "Boss", email: "boss@example.com", isCurrentUser: false },
      attendees: [{ name: "Me", email: "ME@example.com", status: "accepted", isCurrentUser: true }, { email: "x@example.com", status: "declined", isCurrentUser: false }],
    }, new Set())!;
    expect(ev.time).toEqual({ kind: "timed", startMs: day(2026, 10, 14, 9), endMs: day(2026, 10, 14, 9, 30) });
    expect(ev.recurrenceKey).toBe(String(day(2026, 10, 14, 9)));
    expect(ev.sources).toEqual([{ kind: "macos", id: "macos", calendarId: "cal1" }]);
    expect(ev.selfStatus).toBe("accepted");
    expect(ev.organizerVerified).toBe(false);
    expect(ev.title).not.toContain("https://");
    expect(ev.description).not.toContain("12345");
    expect(ev.attendees.map((a) => a.email)).toEqual(["me@example.com", "x@example.com"]);
  });

  test("all-day: the helper's own day strings win over this process's zone (LaunchServices passes no TZ)", () => {
    const a = macEventFrom({ calendarId: "c", allDay: true, title: "Trip", uid: "R", startMs: day(2026, 10, 14, 12), endMs: day(2026, 10, 14, 13),
      startDay: "2026-10-20", lastDay: "2026-10-21", occurrenceMs: day(2026, 10, 14, 12), occurrenceDay: "2026-10-20" }, new Set())!;
    expect(a.time).toEqual({ kind: "allDay", startDate: "2026-10-20", endDateExclusive: "2026-10-22" });
    expect(a.recurrenceKey).toBe("2026-10-20");
    // Not a real date: the fallback.
    const b = macEventFrom({ calendarId: "c", allDay: true, title: "T", startMs: day(2026, 10, 14), endMs: day(2026, 10, 15) - 1000, startDay: "2026-02-31", lastDay: "x" }, new Set())!;
    expect(b.time).toEqual({ kind: "allDay", startDate: "2026-10-14", endDateExclusive: "2026-10-15" });
  });

  test("all-day: EventKit's inclusive last moment and a next-midnight end both normalise to the exclusive date", () => {
    const a = macEventFrom({ calendarId: "c", allDay: true, title: "Trip", startMs: day(2026, 10, 14), endMs: day(2026, 10, 15) - 1000, occurrenceMs: day(2026, 10, 14), uid: "R" }, new Set())!;
    expect(a.time).toEqual({ kind: "allDay", startDate: "2026-10-14", endDateExclusive: "2026-10-15" });
    expect(a.recurrenceKey).toBe("2026-10-14");
    const b = macEventFrom({ calendarId: "c", allDay: true, title: "Trip", startMs: day(2026, 10, 14), endMs: day(2026, 10, 16) }, new Set())!;
    expect(b.time).toEqual({ kind: "allDay", startDate: "2026-10-14", endDateExclusive: "2026-10-16" });
  });

  test("identity: a decline by you wins; calendar.emails count; organizer only with isCurrentUser on an EDITABLE calendar", () => {
    const base = { calendarId: "c", title: "M", startMs: 1, endMs: 2 };
    expect(macEventFrom({ ...base, attendees: [{ email: "me@x.com", status: "accepted" }, { isCurrentUser: true, status: "declined" }] }, new Set(["me@x.com"]))!.selfStatus).toBe("declined");
    expect(macEventFrom({ ...base, attendees: [{ email: "me@x.com", status: "tentative" }] }, new Set(["me@x.com"]))!.selfStatus).toBe("tentative");
    const mine = macEventFrom({ ...base, editable: true, organizer: { isCurrentUser: true, email: "me@x.com" } }, new Set())!;
    expect([mine.selfStatus, mine.organizerVerified]).toEqual(["organizer", true]);
    const shared = macEventFrom({ ...base, editable: false, organizer: { isCurrentUser: true } }, new Set())!;
    expect([shared.selfStatus, shared.organizerVerified]).toEqual(["unknown", false]);
    // A configured address never makes you the organizer.
    const byEmail = macEventFrom({ ...base, editable: true, organizer: { email: "me@x.com", isCurrentUser: false } }, new Set(["me@x.com"]))!;
    expect([byEmail.selfStatus, byEmail.organizerVerified]).toEqual(["unknown", false]);
  });

  test("UIDs follow the link parser's rule: long or control-bearing ones are hashed, so both sources spell them alike", () => {
    const base = { calendarId: "c", title: "M", startMs: 1, endMs: 2 };
    const long = "x".repeat(600);
    const a = macEventFrom({ ...base, uid: long }, new Set())!, b = macEventFrom({ ...base, uid: `${long}y` }, new Set())!;
    expect(a.uid).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(a.uid).not.toBe(b.uid);   // no collision on a shared prefix
    expect(macEventFrom({ ...base, uid: "a\nb" }, new Set())!.uid).toMatch(/^sha256:/);
    expect(macEventFrom({ ...base, uid: " plain@google.com " }, new Set())!.uid).toBe("plain@google.com");
  });

  test("a record's url key (reader version 2) never reaches the morning's event", () => {
    const rec = {
      calendarId: "c", editable: true, startMs: day(2026, 10, 14, 9), endMs: day(2026, 10, 14, 10), title: "Sync",
      location: "Room 1", notes: "Agenda", organizer: { name: "Boss", isCurrentUser: false }, attendees: [{ name: "Ana", status: "accepted", isCurrentUser: false }],
    };
    const withUrl = macEventFrom({ ...rec, url: "https://zoom.us/j/123456789?pwd=secret" }, new Set());
    expect(withUrl).toEqual(macEventFrom(rec, new Set()));
    expect(JSON.stringify(withUrl)).not.toContain("zoom.us");
    expect(macEventsFrom([{ ...rec, url: "https://x.example/j" }], [])).toEqual(macEventsFrom([rec], []));
  });

  test("malformed records are dropped and counted; more than 500 count as dropped", () => {
    const good = { calendarId: "c", title: "ok", startMs: 1, endMs: 2 };
    const r = macEventsFrom([good, { title: "no calendar", startMs: 1, endMs: 2 }, { ...good, startMs: "x" }, null, 7], []);
    expect([r.events.length, r.dropped]).toEqual([1, 4]);
    expect(macEventsFrom(Array.from({ length: 503 }, () => good), []).dropped).toBe(3);
    expect(macEventsFrom(undefined, [])).toEqual({ events: [], dropped: 0 });
    expect(macEventsFrom("nope", [])).toEqual({ events: [], dropped: 1 });
  });
});

describe("mac-events — producer keys (near-duplicates T1.2: P06, P07)", () => {
  const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
  const day = (y: number, m: number, d: number, h = 0, min = 0): number => new Date(y, m - 1, d, h, min).getTime();
  const rec = (over: Record<string, unknown>) => ({ calendarId: "c", startMs: day(2026, 10, 14, 9), endMs: day(2026, 10, 14, 10), title: "X", ...over });
  /** The record read in both modes: the morning (no details) and the details read for its day (url field present). */
  const both = (r: Record<string, unknown>): CalEvent[] => [
    macEventsFrom([r], []).events[0]!, macEventsFrom([r], [], { detailsFor: "2026-10-14" }).events[0]!,
  ];
  const keys = (e: CalEvent) => ({ meetingKey: e.meetingKey, placeKey: e.placeKey, linkKeys: e.linkKeys });

  test("P07 the meeting key reads raw location, then raw notes, in both modes; placeKey and linkKeys read only the location", () => {
    const loc = rec({ location: "Clinic North, https://zoom.us/j/111", notes: "https://zoom.us/j/222" });
    for (const e of both(loc)) {
      expect(keys(e)).toEqual({ meetingKey: sha("zoom\u0000111"), placeKey: sha("clinic north"), linkKeys: [sha("zoom.us/j/111")] });
      // The fields survive cleaning (cleanCalEvent spreads the event) while the cleaned text loses the link.
      expect(e.location).not.toContain("https://");
    }
    for (const e of both(rec({ location: "Room 4", notes: "Join: https://zoom.us/j/222" }))) {
      expect(keys(e)).toEqual({ meetingKey: sha("zoom\u0000222"), placeKey: sha("room 4"), linkKeys: undefined });
      expect("linkKeys" in e).toBe(false);
    }
    expect(both(rec({ location: "Room 4" })).map((e) => "meetingKey" in e)).toEqual([false, false]);
    expect(both(rec({ notes: "Clinic North" })).map((e) => "placeKey" in e)).toEqual([false, false]);
    expect(macEventFrom(rec({ location: "Clinic North" }), new Set())!.placeKey).toBe(sha("clinic north"));
  });
  test("P07 a meeting held only in the url field gives no key, in either mode", () => {
    for (const e of both(rec({ url: "https://zoom.us/j/333", location: "Room 4", notes: "Agenda" }))) {
      expect(e.meetingKey).toBeUndefined();
      expect(JSON.stringify(keys(e))).not.toContain(sha("zoom\u0000333"));
    }
  });
  test("P06 a conflicting url-field link never sets the key: location /j/222 decides, and both modes agree", () => {
    const [morning, live] = both(rec({ url: "https://zoom.us/j/111", location: "https://zoom.us/j/222" }));
    expect(morning!.meetingKey).toBe(sha("zoom\u0000222"));
    expect(keys(live!)).toEqual(keys(morning!));
    expect(live!.details?.url).toBe("https://zoom.us/j/111");
    expect(morning!.details).toBeUndefined();
  });
});

describe("the pipeline's Mac source", () => {
  const runDate = localDateStr(new Date());
  const resolvedMac = resolveCalendar({ enabled: true, macos: {} }, { platform: "darwin" });

  test("events from the Mac read reach the merged day with the source's status and notices", async () => {
    const now = Date.now();
    const start = new Date(); start.setHours(23, 0, 0, 0);
    const ev = macEventFrom({ calendarId: "c", title: "Late call", startMs: start.getTime(), endMs: start.getTime() + 15 * 60_000 }, new Set())!;
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-macsrc-pipe-")));
    const read = await readCalendar(resolvedMac, { runDate, startedAt: now, offline: false }, {
      stateDir: state, platform: "darwin", readMac: async () => ({ status: "ok", notices: ["helper-outdated"], events: [ev] }),
    });
    expect(read.sources).toEqual([{ id: "macos", kind: "macos", status: "ok", notices: ["helper-outdated"], eventsToday: 1, durationMs: read.sources[0]!.durationMs }]);
    expect(read.events.map((e) => e.title)).toEqual(["Late call"]);
  });

  test("a throwing Mac read is incomplete; one that never resolves times out at the bound", async () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-macsrc-pipe-")));
    const thrown = await readCalendar(resolvedMac, { runDate, startedAt: Date.now(), offline: false }, {
      stateDir: state, platform: "darwin", readMac: async () => { throw new Error("boom"); },
    });
    expect(thrown.sources[0]).toMatchObject({ status: "incomplete", reason: "internal", eventsToday: 0 });
    const hung = await readCalendar(resolvedMac, { runDate, startedAt: Date.now(), offline: false }, {
      stateDir: state, platform: "darwin", boundMs: 150, readMac: () => new Promise(() => {}),
    });
    expect(hung.sources[0]).toMatchObject({ status: "timeout", reason: "step-deadline" });
  });

  test("the production wiring: createCalendarStep hands the selection to the reader and calendar.emails to identity", async () => {
    const { createCalendarStep } = await import("../src/calendar/pipeline");
    const state = stateWithCopy();
    const start = new Date(); start.setHours(23, 0, 0, 0);
    const f = fake((fifo, id) => writeLines(fifo, doc(id, { events: [
      { calendarId: "w", title: "Mine", startMs: start.getTime(), endMs: start.getTime() + 600_000, attendees: [{ email: "me@x.com", status: "declined" }] },
      { calendarId: "w", title: "Kept", startMs: start.getTime(), endMs: start.getTime() + 600_000 },
    ] })));
    const resolved = resolveCalendar({ enabled: true, emails: ["me@x.com"], macos: { calendars: [{ id: "w", title: "Work", account: "iCloud" }] } }, { platform: "darwin" });
    const r = (await createCalendarStep(resolved, { stateDir: state, platform: "darwin", osRelease: "24.0.0", macExec: f.exec, maxChars: 200_000 })({
      runDate, startedAt: Date.now(), offline: false, force: false, owned: false, trigger: "manual",
    } as never))!;
    expect(f.calls[1]!.slice(-2)).toEqual(["--calendar", "w"]);
    // The declined one (by a calendar.emails address) is dropped; the other is today's event.
    expect(r.struct.events.map((e) => e.title)).toEqual(["Kept"]);
    expect(r.struct.sources).toEqual([{ id: "macos", kind: "macos", status: "ok" }]);
  });

  test("with no copy installed the production read is helper-missing and launches nothing", async () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-macsrc-pipe-")));
    const f = fake(() => {});
    const read = await readCalendar(resolvedMac, { runDate, startedAt: Date.now(), offline: false }, {
      stateDir: state, platform: "darwin", osRelease: "24.0.0", macExec: f.exec,
    });
    expect(read.sources[0]).toMatchObject({ status: "helper-missing", eventsToday: null });
    expect(f.calls).toEqual([]);
  });
});

// ── M10b: the attended install of the copy, and `calendar connect mac` ────────────────────────────────────────────

/** A shipped reader bundle somewhere outside the state folder, with its executable's exec bit DROPPED (a packager
 *  that lost it must not leave a reader that cannot start). */
function shipped(version = CALENDAR_READER_VERSION): string {
  const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-shipped-")));
  const app = join(root, "Daily Briefing Calendar Reader.app");
  mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
  writeFileSync(readerExecutable(app), "#!/bin/sh\n", { mode: 0o644 });
  writeFileSync(join(app, "Contents", "Info.plist"), `<plist><dict><key>CFBundleVersion</key><string>${version}</string></dict></plist>\n`);
  return app;
}
/** The signing exec: every command "succeeds" and the identity is "found", so the copy is signed stable. Records argv. */
function signer(code = 0): { exec: Exec; calls: string[][] } {
  const calls: string[][] = [];
  return { calls, exec: async (cmd) => { calls.push([...cmd]); return { code, out: code === 0 ? "Daily Briefing (local) Signing" : "", err: "" }; } };
}
const quiet = { say: () => {}, warn: () => {} };

describe("installReaderCopy — attended only", () => {
  test("no shipped reader → helper-missing, nothing signed", async () => {
    const s = signer();
    expect(await installReaderCopy({ stateDir: stateWithCopy(null), exec: s.exec, home: "/nonexistent", identity: "Daily Briefing (local) Signing", ...quiet, findShipped: async () => null }))
      .toEqual({ status: "helper-missing" });
    expect(s.calls).toEqual([]);
  });

  test("copies, restores the exec bit, signs the TEMP copy under the reader identifier, then renames into place", async () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-install-")));
    const s = signer();
    const r = await installReaderCopy({ stateDir: state, exec: s.exec, home: "/nonexistent", identity: "Daily Briefing (local) Signing", ...quiet, findShipped: async () => shipped() });
    expect(r).toEqual({ status: "ok", action: "copied", signature: "stable" });
    const copy = calendarReaderCopy(state);
    expect(statSync(readerExecutable(copy)).mode & 0o777).toBe(0o755);
    const sign = s.calls.find((c) => c.includes("--identifier"))!;
    expect(sign).toContain("local.daily-briefing.calendar");
    expect(sign).toContain("--timestamp=none");
    expect(sign.at(-1)).toMatch(/\/\.copy-[0-9a-f]{12}\.app$/);
    expect(readdirSync(join(state, "calendar", "reader"))).toEqual(["Daily Briefing Calendar Reader.app"]);
    expect(statSync(join(state, "calendar", "reader")).mode & 0o777).toBe(0o700);
  });

  test("an up-to-date copy is left alone — no copy, no keychain, no signing", async () => {
    const s = signer();
    const state = stateWithCopy(CALENDAR_READER_VERSION);
    expect(await installReaderCopy({ stateDir: state, exec: s.exec, home: "/nonexistent", identity: "x", ...quiet, findShipped: async () => shipped() }))
      .toEqual({ status: "ok", action: "up-to-date" });
    expect(s.calls).toEqual([]);
  });

  test("an older copy is replaced; an OLD leftover temp copy is removed, a fresh one (a concurrent install's) kept", async () => {
    const state = stateWithCopy(0);
    const reader = join(state, "calendar", "reader");
    mkdirSync(join(reader, ".copy-abcdef123456.app"));
    mkdirSync(join(reader, ".copy-000000000000.app"));
    const old = (Date.now() - 11 * 60_000) / 1000;
    utimesSync(join(reader, ".copy-abcdef123456.app"), old, old);
    const s = signer();
    const r = await installReaderCopy({ stateDir: state, exec: s.exec, home: "/nonexistent", identity: "Daily Briefing (local) Signing", ...quiet, findShipped: async () => shipped(2) });
    expect(r).toEqual({ status: "ok", action: "copied", signature: "stable" });
    expect(readFileSync(join(calendarReaderCopy(state), "Contents", "Info.plist"), "utf8")).toContain("<string>2</string>");
    expect(readdirSync(reader).sort()).toEqual([".copy-000000000000.app", "Daily Briefing Calendar Reader.app"]);
    // Quarantine is stripped from every file of the bundle, not only its top folder.
    expect(s.calls.find((c) => c.includes("com.apple.quarantine"))!.slice(0, 2)).toEqual(["xattr", "-dr"]);
  });

  test("a failed re-sign never replaces a working copy; an unsigned copy is never installed; ad hoc only as a first install", async () => {
    const adhocOnly = (): Exec => async (cmd) => ({ code: (cmd[1] === "-s" && cmd[2] === "-") || cmd[0] === "xattr" ? 0 : 1, out: "", err: "" });
    const state = stateWithCopy(0);
    expect(await installReaderCopy({ stateDir: state, exec: adhocOnly(), home: "/nonexistent", identity: "x", ...quiet, findShipped: async () => shipped(2) }))
      .toEqual({ status: "malformed", reason: "sign-failed" });
    expect(readFileSync(join(calendarReaderCopy(state), "Contents", "Info.plist"), "utf8")).toContain("<string>0</string>");
    expect(readdirSync(join(state, "calendar", "reader"))).toEqual(["Daily Briefing Calendar Reader.app"]);
    const fresh = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-install-")));
    expect(await installReaderCopy({ stateDir: fresh, exec: signer(1).exec, home: "/nonexistent", identity: "x", ...quiet, findShipped: async () => shipped() }))
      .toEqual({ status: "malformed", reason: "sign-failed" });
    expect(existsSync(calendarReaderCopy(fresh))).toBe(false);
    expect(await installReaderCopy({ stateDir: fresh, exec: adhocOnly(), home: "/nonexistent", identity: "x", ...quiet, findShipped: async () => shipped() }))
      .toEqual({ status: "ok", action: "copied", signature: "adhoc" });
  });

  test("an ad-hoc first install never replaces a copy a concurrent install put in place while it was signing", async () => {
    // codex W3 review: the "is there a copy?" check is made AFTER signing, which can wait on a keychain prompt.
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-install-")));
    const exec: Exec = async (cmd) => {
      if (cmd[1] === "-s" && cmd[2] === "-") {
        mkdirSync(join(calendarReaderCopy(state), "Contents", "MacOS"), { recursive: true });
        writeFileSync(readerExecutable(calendarReaderCopy(state)), "#!/bin/sh\n", { mode: 0o755 });
        writeFileSync(join(calendarReaderCopy(state), "Contents", "Info.plist"), "<plist><dict><key>CFBundleVersion</key><string>7</string></dict></plist>\n");
        return { code: 0, out: "", err: "" };
      }
      return { code: cmd[0] === "xattr" ? 0 : 1, out: "", err: "" };
    };
    expect(await installReaderCopy({ stateDir: state, exec, home: "/nonexistent", identity: "x", ...quiet, findShipped: async () => shipped() }))
      .toEqual({ status: "malformed", reason: "sign-failed" });
    expect(readFileSync(join(calendarReaderCopy(state), "Contents", "Info.plist"), "utf8")).toContain("<string>7</string>");
    expect(readdirSync(join(state, "calendar", "reader"))).toEqual(["Daily Briefing Calendar Reader.app"]);
  });

  test("the identity '-' is ad hoc: it never replaces a working copy, even when an identity check would pass", async () => {
    // codex W3 review: `DBA_SIGN_IDENTITY=-` used to come back "stable" from signManagedCopy.
    const s: { calls: string[][]; exec: Exec } = { calls: [], exec: async (cmd) => { s.calls.push([...cmd]); return { code: 0, out: '1) ABC "-"', err: "" }; } };
    const state = stateWithCopy(0);
    expect(await installReaderCopy({ stateDir: state, exec: s.exec, home: "/nonexistent", identity: "-", ...quiet, findShipped: async () => shipped(2) }))
      .toEqual({ status: "malformed", reason: "sign-failed" });
    expect(readFileSync(join(calendarReaderCopy(state), "Contents", "Info.plist"), "utf8")).toContain("<string>0</string>");
    expect(s.calls.some((c) => c.includes("find-identity"))).toBe(false);
  });

  test("a copy an interrupted swap left aside is put back first — never swept, never traded for an ad-hoc one", async () => {
    // W3 checkpoint: killed between `rename(copy, aside)` and `rename(tmp, copy)`, the granted copy sits under its
    // aside name with nothing at the real name. The next attended install restores it before anything else.
    const state = stateWithCopy(CALENDAR_READER_VERSION);
    const reader = join(state, "calendar", "reader");
    renameSync(calendarReaderCopy(state), join(reader, ".old-abcdef123456.app"));
    const old = (Date.now() - 60 * 60_000) / 1000;
    utimesSync(join(reader, ".old-abcdef123456.app"), old, old);
    const s = signer();
    expect(await installReaderCopy({ stateDir: state, exec: s.exec, home: "/nonexistent", identity: "x", ...quiet, findShipped: async () => shipped() }))
      .toEqual({ status: "ok", action: "up-to-date" });
    expect(s.calls).toEqual([]);
    expect(readdirSync(reader)).toEqual(["Daily Briefing Calendar Reader.app"]);
    // With a copy in place, a leftover aside (a swap that finished but was killed before its cleanup) is removed.
    mkdirSync(join(reader, ".old-000000000000.app"));
    expect(await installReaderCopy({ stateDir: state, exec: s.exec, home: "/nonexistent", identity: "x", ...quiet, findShipped: async () => shipped() }))
      .toEqual({ status: "ok", action: "up-to-date" });
    expect(readdirSync(reader)).toEqual(["Daily Briefing Calendar Reader.app"]);
  });

  test("findShippedReader prefers a reader at least as new as the engine's over a nearer stale one", async () => {
    const { findShippedReader } = await import("../src/calendar/reader");
    const stale = shipped(0), current = shipped(CALENDAR_READER_VERSION);
    expect(await findShippedReader([stale, current])).toBe(current);
    expect(await findShippedReader([stale])).toBe(stale);
    expect(await findShippedReader(["/nonexistent/x.app"])).toBeNull();
  });

  test("a symlinked reader folder is refused", async () => {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-install-")));
    mkdirSync(join(state, "calendar"), { mode: 0o700 });
    symlinkSync(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-install-x-"))), join(state, "calendar", "reader"));
    const s = signer();
    expect(await installReaderCopy({ stateDir: state, exec: s.exec, home: "/nonexistent", identity: "x", ...quiet, findShipped: async () => shipped() }))
      .toEqual({ status: "malformed", reason: "dir-symlink" });
    expect(s.calls).toEqual([]);
  });
});

describe("calendar connect mac", () => {
  function setup(): { state: string; configFile: string } {
    const state = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-connect-")));
    const configFile = join(state, "config.json");
    writeFileSync(configFile, `${JSON.stringify({ repos: [], calendar: { enabled: true, links: [] } }, null, 2)}\n`);
    return { state, configFile };
  }
  async function connect(over: Record<string, unknown>): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [], err: string[] = [];
    const code = await calendarMain(["connect", "mac", "--json"], { out: (s) => out.push(s), err: (s) => err.push(s), home: "/nonexistent", env: {}, ...over });
    return { code, out, err };
  }

  test("off macOS, or on macOS 13: unsupported-os, nothing installed", async () => {
    const { state, configFile } = setup();
    const s = signer();
    for (const over of [{ platform: "linux" }, { platform: "darwin", osRelease: "22.6.0" }]) {
      const r = await connect({ stateDir: state, configFile, signExec: s.exec, findShippedReader: async () => shipped(), ...over });
      expect([r.code, JSON.parse(r.out[0]!)]).toEqual([1, { schemaVersion: 1, status: "unsupported-os" }]);
    }
    expect(s.calls).toEqual([]);
  });

  test("no shipped reader: helper-missing", async () => {
    const { state, configFile } = setup();
    const r = await connect({ stateDir: state, configFile, platform: "darwin", osRelease: "24.0.0", signExec: signer().exec, findShippedReader: async () => null });
    expect([r.code, JSON.parse(r.out[0]!)]).toEqual([1, { schemaVersion: 1, status: "helper-missing" }]);
  });

  test("installs, asks, and on a grant turns the Mac source on in the config (signing chatter on stderr only)", async () => {
    const { state, configFile } = setup();
    const f = fake((fifo, id) => writeLines(fifo, doc(id)));
    const r = await connect({ stateDir: state, configFile, platform: "darwin", osRelease: "24.0.0", signExec: signer().exec, macExec: f.exec, findShippedReader: async () => shipped() });
    expect(r.out.length).toBe(1);
    expect([r.code, JSON.parse(r.out[0]!)]).toEqual([0, { schemaVersion: 1, status: "ok", install: "copied", signature: "stable", configUpdated: true }]);
    expect(f.calls[1]![7]).toBe("request");
    expect(JSON.parse(readFileSync(configFile, "utf8")).calendar).toEqual({ enabled: true, links: [], macos: {} });
  });

  test("one deadline: when installing used up the budget, connect stops before asking (the app kills at 150 s)", async () => {
    const { state, configFile } = setup();
    let t = 0;
    const slowSign: Exec = async (_cmd, o) => { t += 50_000; expect(o?.timeoutMs ?? 0).toBeLessThanOrEqual(30_000); return { code: 0, out: "Daily Briefing (local) Signing", err: "" }; };
    const f = fake((fifo, id) => writeLines(fifo, doc(id)));
    const r = await connect({ stateDir: state, configFile, platform: "darwin", osRelease: "24.0.0", signExec: slowSign, macExec: f.exec, findShippedReader: async () => shipped(), clock: () => t });
    expect([r.code, JSON.parse(r.out[0]!)]).toEqual([1, { schemaVersion: 1, status: "timeout", reason: "connect-deadline", install: "copied", signature: "stable", configUpdated: false }]);
    expect(f.calls).toEqual([]);
  });

  test("a slow signing leaves a FRACTIONAL budget, and the reader is still launched with whole-number timeouts (W3 VM)", async () => {
    // Measured on the VM: after a keychain-prompted signing, the request's spawn timeout came out fractional, Bun.spawn
    // refused it, and the reader was never started — no Calendars dialog. Here each signing command takes 6,000.37 ms.
    const { state, configFile } = setup();
    let t = 0.25;
    const slowSign: Exec = async (_cmd, o) => {
      t += 6_000.37;
      expect(Number.isInteger(o?.timeoutMs)).toBe(true);
      return { code: 0, out: "Daily Briefing (local) Signing", err: "" };
    };
    const f = fake((fifo, id) => writeLines(fifo, doc(id)));
    const timeouts: unknown[] = [];
    const macExec: ReaderExec = async (cmd, o) => { timeouts.push(o?.timeoutMs); return f.exec(cmd, o); };
    const r = await connect({ stateDir: state, configFile, platform: "darwin", osRelease: "24.0.0", signExec: slowSign, macExec, findShippedReader: async () => shipped(), clock: () => t });
    expect([r.code, JSON.parse(r.out[0]!).status]).toEqual([0, "ok"]);
    expect(f.calls[1]![7]).toBe("request");
    expect(timeouts.length).toBeGreaterThan(1);
    expect(timeouts.every((x) => Number.isInteger(x))).toBe(true);
  });

  test("a denial leaves the config alone and exits 1", async () => {
    const { state, configFile } = setup();
    const before = readFileSync(configFile, "utf8");
    const r = await connect({ stateDir: state, configFile, platform: "darwin", osRelease: "24.0.0", signExec: signer().exec,
      macExec: fake((fifo, id) => writeLines(fifo, doc(id, { status: "denied" }))).exec, findShippedReader: async () => shipped() });
    expect([r.code, JSON.parse(r.out[0]!)]).toEqual([1, { schemaVersion: 1, status: "denied", reason: "helper-denied", install: "copied", signature: "stable", configUpdated: false }]);
    expect(readFileSync(configFile, "utf8")).toBe(before);
  });

  test("the text answer names a failed request's reason code, and says why the config was not changed (W3 VM sitting)", async () => {
    const text = async (configFile: string, play: Play): Promise<{ code: number; out: string[] }> => {
      const out: string[] = [];
      const code = await calendarMain(["connect", "mac"], { out: (s) => out.push(s), err: () => {}, home: "/nonexistent", env: {},
        stateDir: removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-connect-"))), configFile, platform: "darwin", osRelease: "24.0.0",
        signExec: signer().exec, macExec: fake(play).exec, findShippedReader: async () => shipped() });
      return { code, out: out.slice(-1) };   // the answer; the install's signing lines come first in text mode
    };
    const { configFile } = setup();
    // The helper exits without writing (step 2 on the VM): the reason is printed, not only "could not be read".
    expect(await text(configFile, () => {})).toEqual({ code: 1, out: ["Mac Calendar: the calendar could not be read [helper-exited]."] });
    // A grant with no config file: say so, and what to run.
    const none = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-connect-"))), "config.json");
    const r = await text(none, (fifo, id) => writeLines(fifo, doc(id)));
    expect(r.code).toBe(0);
    expect(r.out[0]).toContain("access granted — not added to the config: there is no config yet. Run `daily-briefing init`");
    expect(existsSync(none)).toBe(false);
    // Connecting again once it is on: already in the config.
    expect((await text(configFile, (fifo, id) => writeLines(fifo, doc(id)))).out[0]).toBe("Mac Calendar: access granted — added to the config (editable calendars).");
    expect((await text(configFile, (fifo, id) => writeLines(fifo, doc(id)))).out[0]).toBe("Mac Calendar: access granted — already in the config.");
    // Final review: a broken `macos` value is reported as broken, not "already"; `macos: null` counts as none.
    const grant = (fifo: string, id: string): void => writeLines(fifo, doc(id));
    const cfgWith = (calendar: unknown): string => {
      const f = join(removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-connect-"))), "config.json");
      writeFileSync(f, `${JSON.stringify({ repos: [], calendar })}\n`);
      return f;
    };
    expect((await text(cfgWith({ enabled: true, macos: "bad" }), grant)).out[0])
      .toBe("Mac Calendar: access granted — not added to the config: its calendar block is invalid — fix it first.");
    const nul = cfgWith({ enabled: true, macos: null });
    expect((await text(nul, grant)).out[0]).toBe("Mac Calendar: access granted — added to the config (editable calendars).");
    expect(JSON.parse(readFileSync(nul, "utf8")).calendar).toEqual({ enabled: true, macos: {} });
    // …and a config that cannot be written says so (its folder is read-only — which root ignores, so not as root).
    if (process.getuid?.() !== 0) {
      const ro = cfgWith({ enabled: true });
      chmodSync(join(ro, ".."), 0o500);
      try {
        expect((await text(ro, grant)).out[0]).toBe("Mac Calendar: access granted — not added to the config: it could not be written.");
      } finally { chmodSync(join(ro, ".."), 0o700); }
    }
  });
});
