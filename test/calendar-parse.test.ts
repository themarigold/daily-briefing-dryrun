// test/calendar-parse.test.ts — the vendored parser and the hard-bounded parse child (calendar v0.3.0, plan M2b/M2c;
// spec r4 §3 "Hard bound on work", §4.2 "Parse", §10 "the vendored ical.js licence file is present"). The parser's own
// rules are test/calendar-ics.test.ts; the parent's identity and wrapper, test/calendar-link-parse.test.ts.
//
// Four layers:
//   1. THE VENDORED FILE: both sha256 values pinned (nobody edits ical.js silently), the MPL-2.0 notice and the
//      README present, and src/ reaching ical.js only through parse-job.ts's DYNAMIC import.
//   2. THE JOB, in process: the request checked field by field, events and the index out, the awaited write, and
//      the fixed error codes (no feed text ever leaves).
//   3. THE RUNNER, against fixture children (`bun -e …` — never the engine): the deadline SIGKILLs a CPU-bound child
//      and the caller resolves on time; every way a child can misbehave maps to one outcome; the child's
//      environment is empty and its cwd is `/`; nothing the child writes reaches the outcome unvalidated, and no text
//      that is not already CLEAN; a large answer arrives whole; hostile feeds end within the deadline.
//   4. THE REAL ROUTE: `src/main.ts calendar-parse` in a real process with HOME, XDG_CONFIG_HOME,
//      DAILY_BRIEFING_STATE_DIR and the cwd all empty temp dirs — it answers, and every one of them is still empty
//      afterwards (the "dispatch before any config/state" promise, measured rather than read).
// The compiled-binary half of M2b (the same route inside `bun build --compile`, from a source-free directory) cannot
// run in this suite; its measurements are recorded in src/calendar/parse-runner.ts's header.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Glob } from "bun";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { heavyFeed } from "./fixtures/calendar-heavy-feed";
import { CALENDAR_PARSE_PROTOCOL, calendarParseJob, calendarParseMain, type CalendarParseRequest, type CalendarParseResult } from "../src/calendar/parse-job";
import {
  CALENDAR_PARSE_MAX_OUTPUT_BYTES, CALENDAR_PARSE_SUBCOMMAND, calendarParseCommand, calendarParseCwd, runCalendarParse,
} from "../src/calendar/parse-runner";
import { CAL_EVENTS_BUDGET_BYTES, CAL_INDEX_BUDGET_BYTES } from "../src/calendar/ics";

const SRC = resolve(import.meta.dir, "../src");
const VENDOR = join(SRC, "calendar/vendor");
const PARSE_JOB = join(SRC, "calendar/parse-job.ts");
const MAIN = join(SRC, "main.ts");
const sha256 = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

const ICS = [
  "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//t//t//EN",
  "BEGIN:VEVENT", "UID:a@x", "DTSTAMP:20261009T000000Z", "DTSTART:20261009T100000Z", "SUMMARY:one", "END:VEVENT",
  "BEGIN:VTODO", "UID:t@x", "DTSTAMP:20261009T000000Z", "SUMMARY:not an event", "END:VTODO",
  "BEGIN:VEVENT", "UID:b@x", "DTSTAMP:20261009T000000Z", "DTSTART:20261009T110000Z", "SUMMARY:two", "END:VEVENT",
  "END:VCALENDAR", "",
].join("\r\n");
const req = (ics: string): CalendarParseRequest => ({
  v: CALENDAR_PARSE_PROTOCOL, ics, sourceId: "work", runDate: "2026-10-09", zone: "UTC", identity: { self: [] }, maxEvents: 5_000,
});
/** The titles of an ok answer's events, in feed order. */
const titlesOf = (r: CalendarParseResult): string[] => (r.ok ? r.events.map((e) => e.title) : [`error:${r.error}`]);

/** A fixture child: `bun -e <code>`. Never the engine. */
const child = (code: string) => [process.execPath, "-e", code];
/** A fixture child that runs the REAL job module, the way `src/main.ts`'s arm does, without main.ts. */
const JOB_CHILD = child(`import { calendarParseMain } from ${JSON.stringify(PARSE_JOB)}; process.exit(await calendarParseMain());`);
const SENTINEL = "ZZCHILDTEXTcafe0000";
const EMPTY_ANSWER = `{"v":${CALENDAR_PARSE_PROTOCOL},"ok":true,"events":[],"index":[],"incomplete":[]}`;

// ── 1. the vendored file ──────────────────────────────────────────────────────────────────────────────

describe("the vendored ical.js", () => {
  test("is byte-for-byte ical.js 2.2.1's dist/ical.js, and its MPL-2.0 licence is beside it (sha256 pins)", () => {
    // To upgrade: replace both files from a verified release tarball, then these pins, README.md and the version.
    expect(sha256(join(VENDOR, "ical.js"))).toBe("396c1349c899974b1048460e3c7495ec394ff1a86941ab5bf6291b272b8d53c2");
    expect(readFileSync(join(VENDOR, "ical.js")).byteLength).toBe(267_656);
    expect(sha256(join(VENDOR, "LICENSE.ical.js"))).toBe("1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5");
    expect(readFileSync(join(VENDOR, "LICENSE.ical.js"), "utf8").startsWith("Mozilla Public License Version 2.0")).toBe(true);
    // The file's own MPL header stays at its top (the notice travels with the code).
    expect(readFileSync(join(VENDOR, "ical.js"), "utf8").slice(0, 200)).toContain("Mozilla Public");
  });

  test("README.md names the package, version, source, both sha256 values and the licence", () => {
    const readme = readFileSync(join(VENDOR, "README.md"), "utf8");
    for (const needle of ["ical.js 2.2.1", "registry.npmjs.org/ical.js/-/ical.js-2.2.1.tgz", "Mozilla Public License 2.0",
      "396c1349c899974b1048460e3c7495ec394ff1a86941ab5bf6291b272b8d53c2", "1f256ecad192880510e84ad60474eab7589218784b9a50bc7ceee34c2b91f1d5"]) {
      expect(`README mentions ${needle}: ${readme.includes(needle)}`).toBe(`README mentions ${needle}: true`);
    }
  });

  test("src/ reaches it only through parse-job.ts's DYNAMIC import", async () => {
    // Spec §4.2: loaded with a dynamic import, only when calendar is on. A static value import anywhere would
    // evaluate 268 KB of parser on every run, calendar on or off.
    const hits: string[] = [];
    for await (const f of new Glob("**/*.ts").scan({ cwd: SRC })) {
      if (f.startsWith("calendar/vendor/")) continue;
      const src = readFileSync(join(SRC, f), "utf8");
      for (const line of src.split("\n")) if (/["'][^"']*vendor\/ical(?:\.js)?["']/.test(line) && !/^\s*\/\//.test(line)) hits.push(`${f}: ${line.trim()}`);
    }
    // (ics.ts, the parser, names the slice of ical.js it drives structurally and receives the module as an argument.)
    expect(hits.map((h) => h.replace(/\s+\/\/.*$/, ""))).toEqual([
      'calendar/parse-job.ts: const { default: ICAL } = await import("./vendor/ical.js");',
    ]);
  });
});

// ── 2. the job ────────────────────────────────────────────────────────────────────────────────────────

describe("calendarParseJob", () => {
  test("parses each top-level VCALENDAR's VEVENTs into cleaned events (not VTODOs), over several calendars", async () => {
    expect(titlesOf(await calendarParseJob(req(ICS)))).toEqual(["one", "two"]);
    expect(titlesOf(await calendarParseJob(req(ICS + ICS)))).toEqual(["one", "two", "one", "two"]);
    expect(await calendarParseJob(req("BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR\r\n"))).toEqual({ v: CALENDAR_PARSE_PROTOCOL, ok: true, events: [], index: [], incomplete: [] });
    const r = await calendarParseJob(req(ICS));
    expect(r.ok && r.index.map((e) => e.uid)).toEqual(["a@x", "b@x"]);
  });

  test("a heavy multi-year feed parses whole, keeping only the window's events (the G5 shape, small enough for the suite)", async () => {
    const r = await calendarParseJob(req(heavyFeed({ events: 2_000, years: 10 })));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.index).toHaveLength(2_000);                // every block is indexed …
    expect(r.events.length).toBeLessThan(100);          // … only the window's occurrences are events
    expect(r.incomplete).toEqual([]);
  });

  test("text that is not an iCalendar feed is `parse-error` — a fixed code, never the parser's message", async () => {
    const r = await calendarParseJob(req(`BEGIN:VEVENT\r\nSUMMARY:${SENTINEL}\r\nEND:VEVENT\r\n`));
    expect(r).toEqual({ v: CALENDAR_PARSE_PROTOCOL, ok: false, error: "parse-error" });
    expect(JSON.stringify(r)).not.toContain(SENTINEL);
    // A feed cut off inside a component still answers, flagged — and the unclosed event's text is not in it.
    const cut = await calendarParseJob(req(`BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nDTSTART:20261009T100000Z\r\nSUMMARY:${SENTINEL}\r\n`));
    expect(cut).toEqual({ v: CALENDAR_PARSE_PROTOCOL, ok: true, events: [], index: [], incomplete: ["truncated"] });
  });

  test("anything but a well-formed request of this protocol version is `bad-request`", async () => {
    const good = req(ICS);
    const bads: unknown[] = [undefined, null, 7, "x", [], {}, { ...good, v: 1 }, { v: CALENDAR_PARSE_PROTOCOL }, { ...good, ics: 3 },
      { ...good, sourceId: "Bad Id" }, { ...good, sourceId: undefined }, { ...good, runDate: "2026-02-30" }, { ...good, runDate: "today" },
      { ...good, zone: "Mars/Olympus" }, { ...good, zone: "" }, { ...good, maxEvents: 5_001 }, { ...good, maxEvents: -1 }, { ...good, maxEvents: 1.5 },
      { ...good, identity: undefined }, { ...good, identity: { self: ["Not An Email"] } }, { ...good, identity: { self: "a@b.co" } },
      { ...good, identity: { self: ["a@b.co"], verifiedOrganizer: "c@d.co" } }, { ...good, identity: { self: Array(65).fill("a@b.co") } }];
    for (const bad of bads) expect(await calendarParseJob(bad)).toEqual({ v: CALENDAR_PARSE_PROTOCOL, ok: false, error: "bad-request" });
  });

  test("calendarParseMain: one request from stdin to EOF, one JSON line to stdout, exit 0 for any answer — and it AWAITS the write", async () => {
    const out: string[] = [];
    const io = (input: string) => ({ readStdin: async () => input, writeStdout: (s: string) => { out.push(s); } });
    expect(await calendarParseMain(io(JSON.stringify(req("BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n"))))).toBe(0);
    expect(await calendarParseMain(io("not json"))).toBe(0);
    expect(await calendarParseMain({ readStdin: async () => { throw new Error(SENTINEL); }, writeStdout: (s) => { out.push(s); } })).toBe(0);
    expect(out).toEqual([
      `{"v":${CALENDAR_PARSE_PROTOCOL},"ok":true,"events":[],"index":[],"incomplete":[]}\n`,
      `{"v":${CALENDAR_PARSE_PROTOCOL},"ok":false,"error":"bad-request"}\n`,
      `{"v":${CALENDAR_PARSE_PROTOCOL},"ok":false,"error":"bad-request"}\n`,
    ]);
    // M2b checkpoint MEDIUM: the exit code is returned only once an async write has finished.
    let finished = false;
    const slow = { readStdin: async () => "x", writeStdout: async () => { await Bun.sleep(30); finished = true; } };
    expect(await calendarParseMain(slow)).toBe(0);
    expect(finished).toBe(true);
  });
});

// ── 3. the runner ─────────────────────────────────────────────────────────────────────────────────────

describe("calendarParseCommand", () => {
  test("the compiled binary re-invokes itself with the subcommand; from source it names the entry; anything else: none", () => {
    expect(CALENDAR_PARSE_SUBCOMMAND).toBe("calendar-parse");
    // Measured in the compiled binary (macOS, bun 1.3.14): Bun.main = "/$bunfs/root/<outfile name>".
    expect(calendarParseCommand("/$bunfs/root/daily-briefing", "/Apps/db")).toEqual(["/Apps/db", "calendar-parse"]);
    expect(calendarParseCommand("B:\\~BUN\\root\\daily-briefing.exe", "C:\\db.exe")).toEqual(["C:\\db.exe", "calendar-parse"]);
    expect(calendarParseCommand("/repo/daily_briefing_application/src/main.ts", "/usr/bin/bun"))
      .toEqual(["/usr/bin/bun", "/repo/daily_briefing_application/src/main.ts", "calendar-parse"]);
    expect(calendarParseCommand("C:\\repo\\src\\main.ts", "C:\\bun.exe")).toEqual(["C:\\bun.exe", "C:\\repo\\src\\main.ts", "calendar-parse"]);
    // A test runner's entry is a test file: re-running it would run the tests. Never.
    expect(calendarParseCommand("/repo/test/calendar-parse.test.ts", "/usr/bin/bun")).toBeUndefined();
    expect(calendarParseCommand("/repo/scripts/audit.ts", "/usr/bin/bun")).toBeUndefined();
    expect(calendarParseCommand("/repo/src/main.tsx", "/usr/bin/bun")).toBeUndefined();
    // …and THIS process is `bun test`.
    expect(calendarParseCommand()).toBeUndefined();
  });
});

describe("runCalendarParse", () => {
  test("the real job in a child: ok, with the child's peak memory", async () => {
    const r = await runCalendarParse(req(ICS), { timeoutMs: 20_000, command: JOB_CHILD });
    expect(r.status).toBe("ok");
    if (r.status !== "ok") return;
    expect(titlesOf(r.result)).toEqual(["one", "two"]);
    expect(r.maxRss).toBeGreaterThan(1_000_000);
    expect(r.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  test("⚠ THE HARD BOUND: a CPU-bound child is SIGKILLed at the deadline, the caller resolves on time, the child is gone", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-calparse-spin-")));
    const pidFile = join(dir, "pid");
    // The child records its pid, then spins forever without yielding — no await, no timer, nothing to cancel.
    const spin = child(`require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); let x = 0; for (;;) { x = (x + 1) | 0; }`);
    const deadline = 1_500;
    const t0 = performance.now();
    const r = await runCalendarParse(req(ICS), { timeoutMs: deadline, command: spin });
    const took = performance.now() - t0;
    expect(r).toEqual({ status: "timeout", elapsedMs: r.elapsedMs });
    expect(took).toBeGreaterThanOrEqual(deadline - 5);
    expect(took).toBeLessThan(deadline + 1_000);
    // It really was running (it wrote its pid) — and it really is dead (not merely abandoned).
    expect(existsSync(pidFile)).toBe(true);
    const pid = Number(readFileSync(pidFile, "utf8"));
    let alive = true;
    for (let i = 0; i < 60 && alive; i++) {
      try { process.kill(pid, 0); await Bun.sleep(50); } catch { alive = false; }
    }
    expect(`child ${pid} alive after the deadline: ${alive}`).toBe(`child ${pid} alive after the deadline: false`);
  });

  test("a child that never reads its stdin (a 4 MB request) and never exits: timeout, nothing unhandled", async () => {
    const r = await runCalendarParse(req("x".repeat(4 * 1024 * 1024)), { timeoutMs: 400, command: child("setInterval(() => {}, 1000);") });
    expect(r.status).toBe("timeout");
  });

  test("a zero or negative deadline resolves at once as a timeout", async () => {
    for (const timeoutMs of [0, -5]) expect((await runCalendarParse(req(ICS), { timeoutMs, command: child("setInterval(() => {}, 1000);") })).status).toBe("timeout");
  });

  test("an answer written without reading the request is still an answer", async () => {
    const r = await runCalendarParse(req("y".repeat(4 * 1024 * 1024)), { timeoutMs: 20_000, command: child(`process.stdout.write(${JSON.stringify(EMPTY_ANSWER)});`) });
    expect(r).toMatchObject({ status: "ok", result: { v: CALENDAR_PARSE_PROTOCOL, ok: true, events: [] } });
  });

  test("every other way a child can fail maps to one fixed outcome, and none carries the child's text", async () => {
    const w = (answer: unknown) => child(`process.stdout.write(${JSON.stringify(JSON.stringify(answer))});`);
    const ok = (over: Record<string, unknown>) => ({ v: CALENDAR_PARSE_PROTOCOL, ok: true, events: [], index: [], incomplete: [], ...over });
    const ev = (over: Record<string, unknown>) => ({ time: { kind: "timed", startMs: 1, endMs: 2 }, title: "t", attendees: [], selfStatus: "unknown",
      organizerVerified: false, transparency: "busy", status: "confirmed", ...over });
    const cases: [string, string[], string, number?][] = [
      ["exits non-zero", child(`process.stdout.write(${JSON.stringify(EMPTY_ANSWER)}); process.exit(3);`), "exit-nonzero"],
      ["killed by a signal of its own", child(`process.kill(process.pid, "SIGTERM"); setInterval(() => {}, 1000);`), "exit-nonzero"],
      ["writes text, not JSON", child(`process.stdout.write(${JSON.stringify(SENTINEL)}); console.error(${JSON.stringify(SENTINEL)});`), "bad-output"],
      ["writes nothing", child(""), "bad-output"],
      ["writes two answers", child(`process.stdout.write(${JSON.stringify(EMPTY_ANSWER + "\n" + EMPTY_ANSWER)});`), "bad-output"],
      ["answers another protocol version", w(ok({ v: 1 })), "bad-output"],
      ["answers with an extra field", w(ok({ note: SENTINEL })), "bad-output"],
      ["answers an unknown error code", w({ v: CALENDAR_PARSE_PROTOCOL, ok: false, error: SENTINEL }), "bad-output"],
      ["answers an unknown incomplete reason", w(ok({ incomplete: [SENTINEL] })), "bad-output"],
      ["answers a repeated incomplete reason", w(ok({ incomplete: ["truncated", "truncated"] })), "bad-output"],
      // Cleaning is the child's job; the parent refuses anything it did not do (parse-job.ts, "why the child").
      ["sends a title with a line break", w(ok({ events: [ev({ title: `a\nEVENT ${SENTINEL}` })] })), "bad-output"],
      ["sends a title with a TAG character", w(ok({ events: [ev({ title: `a\u{e0041}${SENTINEL}` })] })), "bad-output"],
      ["sends an over-cap description", w(ok({ events: [ev({ description: `${SENTINEL} ${"x".repeat(400)}` })] })), "bad-output"],
      ["sends an unclean attendee name", w(ok({ events: [ev({ attendees: [{ name: `a\u202e${SENTINEL}` }] })] })), "bad-output"],
      ["sends an attendee email that is not one", w(ok({ events: [ev({ attendees: [{ email: `${SENTINEL} <x@y.z>` }] })] })), "bad-output"],
      ["sends an event with a sources field", w(ok({ events: [ev({ sources: [{ kind: "link", id: SENTINEL, calendarId: "x" }] })] })), "bad-output"],
      ["sends an unknown event field", w(ok({ events: [ev({ note: SENTINEL })] })), "bad-output"],
      ["sends a bad time", w(ok({ events: [ev({ time: { kind: "timed", startMs: 2, endMs: 1 } })] })), "bad-output"],
      ["sends a bad recurrenceKey", w(ok({ events: [ev({ recurrenceKey: SENTINEL })] })), "bad-output"],
      ["sends a bad selfStatus", w(ok({ events: [ev({ selfStatus: SENTINEL })] })), "bad-output"],
      ["sends an index entry with a non-numeric start", w(ok({ index: [{ uid: "u", startMs: SENTINEL }] })), "bad-output"],
      ["sends an index entry with recurs: false", w(ok({ index: [{ uid: "u", startMs: null, recurs: false }] })), "bad-output"],
      // M2c review LOW: the UID was the one text field never checked for line breaks or control characters.
      ["sends an event uid with a line break", w(ok({ events: [ev({ uid: `a\nEVENT ${SENTINEL}` })] })), "bad-output"],
      ["sends an index entry uid with a control character", w(ok({ index: [{ uid: `u\u0007${SENTINEL}`, startMs: null }] })), "bad-output"],
      ["floods stdout past the cap", child(`const b = "x".repeat(65536); for (;;) process.stdout.write(b);`), "output-too-large", 100_000],
      ["cannot be spawned at all", ["/nonexistent/dba-calendar-parse-child"], "spawn-failed"],
      ["has no argv", [], "no-runner"],
    ];
    for (const [label, command, reason, maxOutputBytes] of cases) {
      const r = await runCalendarParse(req(ICS), { timeoutMs: 20_000, command, ...(maxOutputBytes !== undefined ? { maxOutputBytes } : {}) });
      expect(`${label}: ${r.status}/${r.status === "failed" ? r.reason : "-"}`).toBe(`${label}: failed/${reason}`);
      expect(`${label}: ${JSON.stringify(r)}`).not.toContain(SENTINEL);
      expect(Object.keys(r).sort()).toEqual(["elapsedMs", "reason", "status"]);
    }
  });

  test("a well-formed `ok: false` answer is passed through as the job's answer", async () => {
    const r = await runCalendarParse(req(`BEGIN:VEVENT\r\nEND:VEVENT\r\n`), { timeoutMs: 20_000, command: JOB_CHILD });
    expect(r).toMatchObject({ status: "ok", result: { v: CALENDAR_PARSE_PROTOCOL, ok: false, error: "parse-error" } });
  });

  test("with no injected argv under `bun test` there is no runner — and nothing is spawned", async () => {
    // calendarParseCommand() is undefined here (see above), so the default must refuse rather than guess.
    expect(await runCalendarParse(req(ICS), { timeoutMs: 1_000 })).toMatchObject({ status: "failed", reason: "no-runner" });
  });

  test("the child's environment is EMPTY — no API key, no link-URL variable reaches the parser", async () => {
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-calparse-env-")));
    const envFile = join(dir, "env.json");
    process.env.DBA_CALPARSE_PROBE_SECRET = SENTINEL;   // a variable the parent HAS
    try {
      const r = await runCalendarParse(req(ICS), {
        timeoutMs: 20_000,
        command: child(`require("node:fs").writeFileSync(${JSON.stringify(envFile)}, JSON.stringify(process.env)); process.stdout.write(${JSON.stringify(EMPTY_ANSWER)});`),
      });
      expect(r.status).toBe("ok");
    } finally { delete process.env.DBA_CALPARSE_PROBE_SECRET; }
    const seen = Object.keys(JSON.parse(readFileSync(envFile, "utf8")) as Record<string, string>);
    // win32 alone passes SystemRoot (see parse-runner.ts's header); everywhere else, nothing at all.
    expect(seen.filter((k) => !(process.platform === "win32" && k === "SystemRoot"))).toEqual([]);
  });

  test("⚠ the child runs in `/`, not the parent's cwd: a `.env` and a `bunfig.toml` preload there reach nothing", async () => {
    // M2b checkpoint MEDIUM. Bun (the compiled binary included) loads `<cwd>/.env` and runs a `<cwd>/bunfig.toml`
    // preload even with `env: {}` — so a parent sitting in a repository or a download folder must not lend it its cwd.
    const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-calparse-cwd-")));
    const out = join(dir, "seen.json"), marker = join(dir, "preload-ran");
    writeFileSync(join(dir, ".env"), `DBA_CALPARSE_DOTENV=${SENTINEL}\n`);
    writeFileSync(join(dir, "preload.ts"), `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "1");\n`);
    writeFileSync(join(dir, "bunfig.toml"), `preload = ["./preload.ts"]\n`);
    const before = process.cwd();
    process.chdir(dir);
    try {
      const r = await runCalendarParse(req(ICS), {
        timeoutMs: 20_000,
        command: child(`require("node:fs").writeFileSync(${JSON.stringify(out)}, JSON.stringify({ env: process.env, cwd: process.cwd() })); process.stdout.write(${JSON.stringify(EMPTY_ANSWER)});`),
      });
      expect(r.status).toBe("ok");
    } finally { process.chdir(before); }
    const seen = JSON.parse(readFileSync(out, "utf8")) as { env: Record<string, string>; cwd: string };
    expect(Object.keys(seen.env).filter((k) => !(process.platform === "win32" && k === "SystemRoot"))).toEqual([]);
    expect(JSON.stringify(seen)).not.toContain(SENTINEL);
    expect(existsSync(marker)).toBe(false);
    expect(seen.cwd).toBe(calendarParseCwd());
    expect(calendarParseCwd("darwin")).toBe("/");
    expect(calendarParseCwd("linux")).toBe("/");
    expect(calendarParseCwd("win32", "C:\\Windows")).toBe("C:\\Windows");
    expect(calendarParseCwd("win32", undefined)).toBe("C:\\");
  });

  test("⚠ a LARGE answer (over 1 MiB) arrives whole through the real child — the write is awaited before exit", async () => {
    // M2b checkpoint MEDIUM: `process.stdout.write` then an immediate `process.exit` delivered only 512–786 KiB of a
    // 1–32 MiB answer, at random, with exit 0. The real job's answer carries the index of every block.
    const r = await runCalendarParse(req(heavyFeed({ events: 20_000, years: 10, descriptionChars: 0, attendees: 0 })), { timeoutMs: 60_000, command: JOB_CHILD });
    expect(r.status).toBe("ok");
    if (r.status !== "ok" || !r.result.ok) throw new Error(`no answer: ${JSON.stringify(r).slice(0, 200)}`);
    expect(r.result.index).toHaveLength(20_000);
    expect(Buffer.byteLength(JSON.stringify(r.result))).toBeGreaterThan(2 * 1024 * 1024);
  }, 90_000);

  test("hostile feeds — deep nesting, huge lines, malformed dates, a spinning rule — end WITHIN the deadline, answered", async () => {
    const deep = Array.from({ length: 200_000 }, (_, i) => `BEGIN:X${i % 5}`).join("\r\n");
    const feeds: [string, string][] = [
      ["nesting", `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:n\r\nDTSTART:20261009T100000Z\r\n${deep}\r\nEND:VEVENT\r\n${deep}\r\n`],
      ["huge line", `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:h\r\nDTSTART:20261009T100000Z\r\nDESCRIPTION:${"w ".repeat(6_000_000)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`],
      ["malformed dates", `BEGIN:VCALENDAR\r\n${["20261345T250000Z", "99999999T999999", "x", ""].map((d, i) => `BEGIN:VEVENT\r\nUID:m${i}\r\nDTSTART:${d}\r\nEND:VEVENT`).join("\r\n")}\r\nEND:VCALENDAR\r\n`],
      ["spinning rule", `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:s\r\nDTSTART:20261001T100000Z\r\nRRULE:FREQ=DAILY;BYMONTH=2;BYMONTHDAY=30\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`],
    ];
    for (const [label, ics] of feeds) {
      const r = await runCalendarParse(req(ics), { timeoutMs: 15_000, command: JOB_CHILD });
      expect(`${label}: ${r.status}/${r.status === "ok" ? (r.result.ok ? r.result.incomplete.join(",") || "clean" : r.result.error) : "-"}`).toMatch(new RegExp(`^${label}: ok/`));
      expect(r.elapsedMs).toBeLessThan(15_000);
    }
  }, 90_000);

  test("the output cap is the child's two budgets plus room for the envelope (10 MiB + 64 KiB)", () => {
    expect(CALENDAR_PARSE_MAX_OUTPUT_BYTES).toBe(CAL_EVENTS_BUDGET_BYTES + CAL_INDEX_BUDGET_BYTES + 64 * 1024);
    expect(CALENDAR_PARSE_MAX_OUTPUT_BYTES).toBe(10 * 1024 * 1024 + 64 * 1024);
  });
});

// ── 4. the real route ─────────────────────────────────────────────────────────────────────────────────

describe("producer keys on the wire, protocol 3 (near-duplicates P01, P02)", () => {
  const hex = (n: number) => createHash("sha256").update(`k${n}`).digest("hex");
  const H = hex(0), LINKS = Array.from({ length: 9 }, (_, i) => hex(i + 1)).sort();
  const w = (answer: unknown) => child(`process.stdout.write(${JSON.stringify(JSON.stringify(answer))});`);
  const ok = (events: unknown[], over: Record<string, unknown> = {}) => ({ v: CALENDAR_PARSE_PROTOCOL, ok: true, events, index: [], incomplete: [], ...over });
  const ev = (over: Record<string, unknown>) => ({ time: { kind: "timed", startMs: 1, endMs: 2 }, title: "t", attendees: [], selfStatus: "unknown",
    organizerVerified: false, transparency: "busy", status: "confirmed", ...over });
  const status = async (answer: unknown) => {
    const r = await runCalendarParse(req(ICS), { timeoutMs: 20_000, command: w(answer) });
    return r.status === "ok" ? "ok" : `${r.status}/${r.status === "failed" ? r.reason : "-"}`;
  };

  test("the protocol is 3", () => {
    expect(CALENDAR_PARSE_PROTOCOL).toBe(3);
  });
  test("P01 accepted: each field alone and all three together, carried through unchanged", async () => {
    for (const over of [{ meetingKey: H }, { placeKey: H }, { linkKeys: [LINKS[0]] }, { linkKeys: LINKS.slice(0, 8) },
      { meetingKey: H, placeKey: hex(42), linkKeys: LINKS.slice(2, 5) }]) {
      const r = await runCalendarParse(req(ICS), { timeoutMs: 20_000, command: w(ok([ev(over)])) });
      expect(`${JSON.stringify(over)}: ${r.status}`).toBe(`${JSON.stringify(over)}: ok`);
      if (r.status === "ok" && r.result.ok) expect(r.result.events[0]).toEqual(ev(over) as never);
    }
  }, 60_000);
  test("P01 refused: a malformed meetingKey or placeKey (length, case, hex, type)", async () => {
    for (const field of ["meetingKey", "placeKey"]) {
      for (const bad of [H.slice(1), `${H}0`, H.toUpperCase(), `g${H.slice(1)}`, 7, null, [H], ""]) {
        expect(`${field}=${JSON.stringify(bad)}: ${await status(ok([ev({ [field]: bad })]))}`).toBe(`${field}=${JSON.stringify(bad)}: failed/bad-output`);
      }
    }
  }, 60_000);
  test("P01 refused: linkKeys that is not a non-empty, strictly ascending array of at most 8 keys", async () => {
    for (const bad of [LINKS[0], [], [LINKS[1], LINKS[0]], [LINKS[0], LINKS[0]], LINKS, [LINKS[0]!.toUpperCase()], [LINKS[0]!.slice(1)], [7], null]) {
      expect(`linkKeys=${JSON.stringify(bad)}: ${await status(ok([ev({ linkKeys: bad })]))}`).toBe(`linkKeys=${JSON.stringify(bad)}: failed/bad-output`);
    }
  }, 60_000);
  test("P01 protocol skew: a protocol-2 answer is refused by this parent; a protocol-2 request is refused by this child", async () => {
    expect(await status(ok([ev({ meetingKey: H })], { v: 2 }))).toBe("failed/bad-output");
    expect(await status(ok([], { v: 2 }))).toBe("failed/bad-output");
    expect(await status(ok([]))).toBe("ok");
    expect(await calendarParseJob({ ...req(ICS), v: 2 })).toEqual({ v: CALENDAR_PARSE_PROTOCOL, ok: false, error: "bad-request" });
  }, 60_000);
  test("P02 refused: a wire event carrying viewDetails or nearDuplicate", async () => {
    const view = [{ title: "t", tier: 2, details: undefined }];
    for (const over of [{ viewDetails: view }, { viewDetails: [] }, { nearDuplicate: { mark: "calendars", count: 2 } }]) {
      expect(`${JSON.stringify(over)}: ${await status(ok([ev(over)]))}`).toBe(`${JSON.stringify(over)}: failed/bad-output`);
    }
  }, 60_000);
});

describe("src/main.ts calendar-parse, in a real process", () => {
  /** Empty temp dirs for every place the engine could read or write config or state, plus the cwd. */
  function sandbox() {
    const root = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-calparse-main-")));
    const dirs = { home: join(root, "home"), xdg: join(root, "xdg"), state: join(root, "state"), cwd: join(root, "cwd") };
    for (const d of Object.values(dirs)) mkdirSync(d);
    return dirs;
  }

  test("answers on stdout, writes nothing to stderr, and leaves HOME, XDG_CONFIG_HOME, the state dir and the cwd EMPTY", async () => {
    const d = sandbox();
    const p = Bun.spawn([process.execPath, MAIN, "calendar-parse"], {
      cwd: d.cwd,
      // A fresh env with every location the engine resolves pointed at an empty temp dir (isolation scanner 6).
      // BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 turns off BUN's own cache, which a run FROM SOURCE writes under
      // $HOME/Library/Caches/bun (measured: nine `.pile` files) — the runtime, not the engine; the compiled
      // binary transpiles nothing and wrote nothing in M2b's source-free probe. Off, so an engine write shows.
      env: { PATH: "/usr/bin:/bin", HOME: d.home, XDG_CONFIG_HOME: d.xdg, DAILY_BRIEFING_STATE_DIR: d.state, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdin: new TextEncoder().encode(JSON.stringify(req(ICS))),
      stdout: "pipe", stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ code, err }).toEqual({ code: 0, err: "" });
    expect(titlesOf(JSON.parse(out))).toEqual(["one", "two"]);
    expect(out.endsWith("}\n")).toBe(true);
    for (const [name, dir] of Object.entries(d)) expect(`${name}: ${JSON.stringify(readdirSync(dir))}`).toBe(`${name}: []`);
  });

  test("with any argument it refuses (exit 2) before reading stdin", async () => {
    const d = sandbox();
    const p = Bun.spawn([process.execPath, MAIN, "calendar-parse", "--json"], {
      cwd: d.cwd,
      env: { PATH: "/usr/bin:/bin", HOME: d.home, XDG_CONFIG_HOME: d.xdg, DAILY_BRIEFING_STATE_DIR: d.state, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
    });
    // stdin is left OPEN: a child that read it would hang here until the test's own timeout.
    const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    expect({ code, out }).toEqual({ code: 2, out: "" });
    expect(err).toContain("calendar-parse: internal command");
    for (const [name, dir] of Object.entries(d)) expect(`${name}: ${JSON.stringify(readdirSync(dir))}`).toBe(`${name}: []`);
  });
});
