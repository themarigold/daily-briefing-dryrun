// test/calendar-reader-source.test.ts — the Mac Calendar Reader's SOURCE SCAN (v0.3.0 plan M10a; spec r4 §4.1, §10).
//
// Swift is not built or run on Linux, so the properties the spec asks of the helper are pinned here as text, over
// comment-stripped sources; the public ci.yml's macOS job and a local Mac build it (reader/build.sh, reader/smoke.sh):
//   • `requestFullAccessToEvents` appears ONLY in the request mode's file — a scheduled run (read/list/status) can
//     never raise the dialog;
//   • read/list/status never construct `EKEventStore` themselves: the one non-request construction is in
//     `authorizedStore`, AFTER the authorization status is known to be full access;
//   • no EventKit write call appears anywhere, and nothing networks;
//   • the FIFO writer derives its folder from the bundle, refuses non-FIFOs, opens without following links, gives up
//     after 10 s with no reader, and caps the document at 4 MB; the read clamps its own window and stops at 500;
//   • Info.plist carries the names, identifier, OS floor, usage text and version the engine expects.
import { test, expect } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CALENDAR_READER_APP, CALENDAR_READER_IDENTIFIER, CALENDAR_READER_NAME, CALENDAR_READER_VERSION,
} from "../src/calendar/reader";

const READER = join(import.meta.dir, "..", "reader");
const SOURCES = join(READER, "Sources");

/** Swift source without `//` line comments and `/* */` blocks. Safe here because no string literal in the helper
 *  contains `//` or `/*` — asserted below, so a future one cannot silently turn code into "comment". */
function code(file: string): string {
  return readFileSync(join(SOURCES, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
const files = readdirSync(SOURCES).filter((f) => f.endsWith(".swift")).sort();
const all = (): string => files.map(code).join("\n");

test("the helper is the expected set of files, one per mode", () => {
  expect(files).toEqual(["Fifo.swift", "ModeList.swift", "ModeRead.swift", "ModeRequest.swift", "ModeStatus.swift", "Store.swift", "main.swift"]);
  expect(code("ModeRequest.swift")).toContain("func runRequest(");
  expect(code("ModeRead.swift")).toContain("func runRead(");
  expect(code("ModeList.swift")).toContain("func runList(");
  expect(code("ModeStatus.swift")).toContain("func runStatus()");
  for (const mode of ["runRequest(invocation)", "runRead(invocation)", "runList(invocation)", "runStatus()"]) expect(code("main.swift")).toContain(mode);
});

test("no string literal carries a comment marker (the stripper above relies on it)", () => {
  for (const f of files) {
    const raw = readFileSync(join(SOURCES, f), "utf8");
    for (const lit of raw.match(/"(?:[^"\\\n]|\\.)*"/g) ?? []) expect(`${f}: ${lit}`).not.toMatch(/\/\/|\/\*/);
  }
});

test("requestFullAccessToEvents is called only by the request mode", () => {
  for (const f of files) {
    const n = (code(f).match(/requestFullAccessToEvents/g) ?? []).length;
    expect(`${f}: ${n}`).toBe(`${f}: ${f === "ModeRequest.swift" ? 1 : 0}`);
  }
  // Neither the pre-14 request nor a write-only one.
  expect(all()).not.toMatch(/requestAccess\s*\(\s*to|requestWriteOnlyAccessToEvents/);
});

test("read, list and status construct no store of their own: the gate does, after full access", () => {
  for (const f of ["ModeRead.swift", "ModeList.swift", "ModeStatus.swift", "Fifo.swift", "main.swift"]) {
    expect(`${f}: ${code(f).includes("EKEventStore(")}`).toBe(`${f}: false`);
  }
  const store = code("Store.swift");
  expect((store.match(/EKEventStore\(/g) ?? []).length).toBe(1);
  const gate = store.slice(store.indexOf("func authorizedStore"));
  expect(gate.indexOf('guard status == "ok"')).toBeGreaterThan(0);
  expect(gate.indexOf('guard status == "ok"')).toBeLessThan(gate.indexOf("EKEventStore("));
  // The status comes from the class method, which creates nothing.
  expect(store).toContain("EKEventStore.authorizationStatus(for: .event)");
  // The two data modes start at the gate.
  for (const f of ["ModeRead.swift", "ModeList.swift"]) {
    const body = code(f).slice(code(f).indexOf(f === "ModeRead.swift" ? "func runRead(" : "func runList("));
    expect(body.indexOf("authorizedStore()")).toBeGreaterThan(0);
    expect(body.indexOf("authorizedStore()")).toBeLessThan(body.indexOf("store."));
  }
});

test("runRequest is reached only from main.swift's request case", () => {
  for (const f of files) {
    const calls = (code(f).match(/runRequest\s*\(/g) ?? []).length;
    const want = f === "ModeRequest.swift" ? 1 : f === "main.swift" ? 1 : 0;   // its definition; the dispatch
    expect(`${f}: ${calls}`).toBe(`${f}: ${want}`);
  }
  expect(code("main.swift")).toContain('case "request": document = runRequest(invocation)');
  // `--wait` is the request's only knob, bounded, and only for `request`.
  expect(code("main.swift")).toContain('guard wait == nil, mode == "request", let n = Int(value), n >= 10, n <= 120 else { return nil }');
  expect(code("ModeRequest.swift")).toContain("min(requestTimeout, inv.wait)");
  // `--refresh-wait` bounds the read's wait (redesign C, C-M1-T1): `read` only, an integer 0 to 2, at most once;
  // the read's refresh wait uses it, and without it the wait stays the constant `refreshWait`.
  expect(code("main.swift")).toContain('case "--refresh-wait":');
  expect(code("main.swift")).toContain('guard refresh == nil, mode == "read", let n = Int(value), n >= 0, n <= 2 else { return nil }');
  expect(code("main.swift")).toContain("refreshWait: refresh.map { TimeInterval($0) } ?? refreshWait");
  expect(code("ModeRead.swift")).toContain("pumpRunLoop(until: Date().addingTimeInterval(inv.refreshWait)) { changed.isRaised }");
  expect(code("ModeRead.swift")).not.toContain("addingTimeInterval(refreshWait)");
  // No other spelling of a store construction anywhere.
  expect(all()).not.toMatch(/EKEventStore\s*\.\s*init\s*\(|:\s*EKEventStore\s*=\s*\.init|=\s*\.init\s*\(\s*\)/);
});

test("output goes only to the FIFO: no file writes, no stdout", () => {
  const src = all();
  for (const w of [/FileManager/, /FileHandle/, /\.write\s*\(\s*to\s*:/, /\bfopen\s*\(/, /\bcreat\s*\(/, /O_CREAT/, /\bprint\s*\(/,
    /\bstdout\b/, /\bstderr\b/, /NSLog|os_log|Logger\s*\(/, /\bmkfifo\s*\(|\bmkdir\s*\(|\bunlink\s*\(|\brename\s*\(/]) {
    expect(`${w}: ${w.test(src)}`).toBe(`${w}: false`);
  }
  // The one write call is Darwin.write on the FIFO's descriptor.
  expect((src.match(/Darwin\.write\s*\(/g) ?? []).length).toBe(1);
  const f = code("Fifo.swift");
  expect(f).toContain("(dst.st_mode & S_IFMT) == S_IFDIR, dst.st_uid == getuid()");
  expect(f).toContain("JSONSerialization.isValidJSONObject(doc)");
  expect(f).toMatch(/let writeTimeout: TimeInterval = 10\b/);
});

test("day strings use the Gregorian calendar, never the user's", () => {
  const src = all();
  expect(src).not.toContain("Calendar.current");
  expect(code("Store.swift")).toContain("Calendar(identifier: .gregorian)");
});

test("no EventKit write call and no network API anywhere", () => {
  const src = all();
  for (const w of [/\.save\s*\(/, /\.remove\s*\(/, /\.commit\s*\(/, /\.reset\s*\(/, /saveCalendar|removeCalendar|saveReminder|removeReminder/,
    /EKEvent\s*\(\s*eventStore/, /EKCalendar\s*\(\s*for/, /EKReminder/, /URLSession|NSURLConnection|CFNetwork|Network\b/]) {
    expect(`${w}: ${w.test(src)}`).toBe(`${w}: false`);
  }
  // The environment is never read: LaunchServices passes none, and the pipe's folder must come from the bundle.
  expect(src).not.toMatch(/ProcessInfo|getenv|environment/);
});

test("the FIFO writer's rules", () => {
  const f = code("Fifo.swift");
  expect(f).toContain("Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent(\"run\"");
  expect(f).toContain("resolvingSymlinksInPath()");
  expect(f).toContain("(st.st_mode & S_IFMT) == S_IFIFO");
  expect(f).toContain("(fst.st_mode & S_IFMT) == S_IFIFO");
  expect(f).toContain("O_WRONLY | O_NONBLOCK | O_NOFOLLOW");
  expect(f).toContain("errno == ENXIO");
  expect(f).toMatch(/let noReaderTimeout: TimeInterval = 10\b/);
  expect(f).toMatch(/let payloadCapBytes = 4 \* 1024 \* 1024\b/);
  expect(f).toContain('doc["id"] = id');
  // The pipe is validated and connected before any EventKit work.
  const main = code("main.swift");
  expect(main.indexOf("FifoWriter(path:")).toBeGreaterThan(0);
  expect(main.indexOf("FifoWriter(path:")).toBeLessThan(main.indexOf("switch invocation.mode"));
});

test("the read clamps its own window to yesterday 00:00 .. tomorrow 24:00 and stops at 500", () => {
  const r = code("ModeRead.swift");
  expect(r).toContain("let cal = gregorian()");
  expect(r).toContain("cal.startOfDay(for: Date())");
  expect(r).toContain("byAdding: .day, value: -1, to: today");
  expect(r).toContain("byAdding: .day, value: 2, to: today");
  expect(r).toMatch(/let readMaxEvents = 500\b/);
  expect(r).toContain("stop.pointee = true");
  expect(r).toContain("store.predicateForEvents(withStart: start, end: end, calendars: calendars)");
  expect((r.match(/predicateForEvents/g) ?? []).length).toBe(1);
  expect(r).toContain("refreshSourcesIfNecessary()");
  expect(r).toMatch(/let refreshWait: TimeInterval = 2\b/);
  expect(r).toContain("if calendars.isEmpty");
  // No argument can carry a window: the parser knows exactly these flags.
  expect(code("main.swift")).not.toMatch(/--(start|end|from|to|window|days)\b/);
  expect(code("ModeRequest.swift")).toMatch(/let requestTimeout: TimeInterval = 120\b/);
  // A self-deadline, so a helper stuck in EventKit after the engine gave up does not live on.
  expect(code("main.swift")).toContain('let selfLimit: TimeInterval = invocation.mode == "request" ? requestTimeout + 15 : 30');
  expect(code("main.swift")).toContain("DispatchQueue.global().asyncAfter(deadline: .now() + selfLimit) { exit(3) }");
  // The engine's all-day end comes from the helper's own zone.
  expect(r).toContain('"lastDay": localDay(lastMoment(e))');
  // The event's own URL field (redesign C, C-M1-T1), capped like the location.
  expect(r).toContain('if withUrl, let url = capped(e.url?.absoluteString, 1000) { out["url"] = url }');
});

test("Info.plist names, identifier, floor, usage text and version match the engine", () => {
  const plist = readFileSync(join(READER, "Info.plist"), "utf8");
  const key = (k: string): string | undefined => new RegExp(`<key>${k}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1];
  expect(key("CFBundleExecutable")).toBe(CALENDAR_READER_NAME);
  expect(key("CFBundleName")).toBe(CALENDAR_READER_NAME);
  expect(key("CFBundleIdentifier")).toBe(CALENDAR_READER_IDENTIFIER);
  expect(key("LSMinimumSystemVersion")).toBe("14.0");
  expect(key("CFBundleVersion")).toBe(String(CALENDAR_READER_VERSION));
  // Version 2: the read's URL field and `--refresh-wait` (redesign C, C-M1-T1). Bump both together.
  expect(CALENDAR_READER_VERSION).toBe(2);
  expect(key("NSCalendarsFullAccessUsageDescription")?.length ?? 0).toBeGreaterThan(40);
  expect(plist).toMatch(/<key>LSUIElement<\/key>\s*<true\/>/);
  expect(CALENDAR_READER_APP).toBe("Daily Briefing Calendar Reader.app");
});

test("build.sh builds universal for macOS 14 and verifies both slices", () => {
  const b = readFileSync(join(READER, "build.sh"), "utf8");
  expect(b).toContain('MIN_OS="14.0"');
  expect(b).toContain("for arch in arm64 x86_64");
  expect(b).toContain('lipo -archs "$APP/Contents/MacOS/$NAME"');
  expect(b).toContain("no arm64 slice");
  expect(b).toContain("no x86_64 slice");
  expect(b).toContain(`NAME="${CALENDAR_READER_NAME}"`);
  expect(b).toContain("--timestamp=none");
});


test("M2: --with-url is read-only, once, consumes no value, defaults off and reaches eventRecord", () => {
  const main = code("main.swift").replace(/\s+/g, " ");
  expect(main).toContain('var withUrl = false');
  expect(main).toContain('if flag == "--with-url" { guard mode == "read", !withUrl else { return nil } withUrl = true i += 1 continue }');
  expect(main.indexOf('if flag == "--with-url"')).toBeLessThan(main.indexOf('guard i + 1 < args.count'));
  expect(main).toContain('withUrl: withUrl');
  const read = code("ModeRead.swift");
  expect(read).toContain('func eventRecord(_ e: EKEvent, withUrl: Bool)');
  expect(read).toContain('eventRecord(e, withUrl: inv.withUrl)');
  expect((read.match(/out\["url"\] =/g) ?? []).length).toBe(1);
});
