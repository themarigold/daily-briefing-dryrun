/**
 * T12 — the Today screen: which renderer, which states, and the four snapshot states the appendix
 * names (quiet day, blocked, offline, limited) plus no-briefing-yet and stale, rendered by the real
 * compiler from `TodayView.svelte`.
 *
 * The skip states are built from `ScheduleState` values of the shape Rust's `derive` emits, and the
 * screen is asserted to RENDER them — the status line and the engine's own `detail` line — never to
 * recompute them.
 */
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";

import { renderBriefing } from "../../src/render";
import { REDACTION, redactCredentials } from "../../src/transcripts/credentials";
import type { BriefingStruct as EngineStruct } from "../../src/types";

import { describeFailure, type BriefingFile } from "../src/lib/files";
import type { Phase, ScheduleState, Snapshot } from "../src/lib/state";
import {
  briefingDate,
  chooseSource,
  envelopeOf,
  latestMtime,
  localDate,
  todayModel,
  type LatestLoad,
  type RunEnvelope,
} from "../src/lib/today";
import type { BriefingStruct } from "../src/lib/briefing-struct";
import TodayView from "../src/routes/TodayView.svelte";

const TODAY = "2026-09-16";
const HOSTILE = '<img src=x onerror="alert(1)">';

const DELIVERED: BriefingStruct = {
  date: TODAY,
  machineScope: "mac",
  provider: "claude",
  resume: [{ repo: "app", text: `resume ${HOSTILE}` }],
  recap: [{ repo: "app", text: "shipped the thing", evidence: "abc1234" }],
  suggestions: [{ text: "next step" }],
};
const QUIET: BriefingStruct = { date: TODAY, machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [] };
const YESTERDAY: BriefingStruct = { ...DELIVERED, date: "2026-09-15" };

const md = (s: BriefingStruct) => renderBriefing(s as EngineStruct);
const file = (text: string): BriefingFile => ({ path: "/state/briefing-latest.md", text, bytes: text.length });
const loaded = (s: BriefingStruct): LatestLoad => ({ state: "loaded", file: file(md(s)) });

function state(phase: Phase, statusLine: string): ScheduleState {
  return {
    phase,
    statusLine,
    floor: "07:20",
    floorWarning: null,
    firstWake: "",
    ticksToday: 11,
    ticksExpectedSinceFloor: 11,
    lastTick: null,
    owner: "app",
    invoker: "app",
    unitPath: null,
    registered: true,
    recordPresent: true,
    unitPresent: true,
    engineVersion: "0.1.1",
    installedEngineVersion: "0.1.1",
    engineUpdateAvailable: false,
    intervalSec: 600,
    experimental: false,
    lingerState: null,
  };
}

function snapshot(s: ScheduleState | null, extra: Partial<Snapshot> = {}): Snapshot {
  return {
    status: { latestBriefingMtime: "2026-09-16T07:24:00.000Z", archivedDates: [] },
    lastSkip: null,
    schedule: null,
    scheduleStale: false,
    scheduleState: s,
    error: null,
    updatesStopped: false,
    ...extra,
  };
}

const envelope = (s: BriefingStruct, extra: Partial<RunEnvelope> = {}): RunEnvelope => ({
  runDate: s.date,
  delivered: true,
  markdown: md(s),
  struct: s,
  ...extra,
});

function view(model: ReturnType<typeof todayModel>, extra: Record<string, unknown> = {}): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(TodayView as any, {
    props: { model, running: false, progress: [], runResult: "", onrun: () => {}, ...extra },
  })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");
}

describe("which renderer Today uses", () => {
  test("the struct only when the app's own envelope IS the file on disk", () => {
    const text = md(DELIVERED);
    expect(chooseSource(file(text), envelope(DELIVERED)).kind).toBe("struct");
    // A later CLI --force rewrote the file: the file wins.
    const rewritten = md({ ...DELIVERED, suggestions: [{ text: "a different step" }] });
    expect(chooseSource(file(rewritten), envelope(DELIVERED)).kind).toBe("markdown");
    // Delivered by launchd (the common case): no envelope at all.
    expect(chooseSource(file(text), null).kind).toBe("markdown");
    // A skipped run carries no struct.
    expect(chooseSource(file(text), envelope(DELIVERED, { delivered: false, struct: null })).kind).toBe("markdown");
    expect(chooseSource(null, envelope(DELIVERED)).kind).toBe("none");
  });

  test("a delivered run that did NOT stamp (marker-fail) is shown from the file", () => {
    // `envelopeFrom(r, rendered, 1, "marker-fail")`: a struct and the file's markdown, delivered false.
    const text = md(DELIVERED);
    const failed = envelope(DELIVERED, { delivered: false });
    expect(failed.struct).not.toBeNull();
    expect(failed.markdown).toBe(text);
    expect(chooseSource(file(text), failed).kind).toBe("markdown");
    // prove-it 3b: the same envelope, delivered, IS the struct source.
    expect(chooseSource(file(text), envelope(DELIVERED)).kind).toBe("struct");
  });

  test("the struct is never shown when the engine redacted the file (review round 1, H1)", () => {
    // Key-SHAPED strings, assembled at run time so no key-shaped literal sits in the source.
    const ghToken = ["ghp", "_", "A1b2C3d4E5f6G7h8I9j0K1l2M3n4"].join("");
    const apiKey = ["sk", "-ant-api03-", "abcDEF0123456789abcDEF0123"].join("");
    const leaky: BriefingStruct = {
      ...DELIVERED,
      resume: [{ repo: "app", text: `export GH=${ghToken} before the release` }],
      recap: [{ repo: "app", text: `rotated ${apiKey}`, evidence: "abc1234" }],
      recapCoverage: { shown: 1, total: 2, notShown: [{ label: "app", sha: "def5678", subject: `leak ${ghToken}` }] },
      suggestions: [{ text: `revoke ${apiKey}` }],
    };
    // What a PRE-E1 engine does (src/main.ts, src/json.ts): the RENDERED string is redacted, the struct is
    // not. Since Phase E's E1, `emit` redacts the envelope's struct/warnings/discIssues (`redactStruct`),
    // but this check is the fail-closed fallback for older engines and the measured D2 shape, so the
    // fixture keeps the raw struct deliberately.
    const markdown = redactCredentials(renderBriefing(leaky as EngineStruct));
    const env: RunEnvelope = { runDate: TODAY, delivered: true, markdown, struct: leaky };
    // The fixture is what it claims to be: the file hides both keys, the struct still carries them.
    expect(markdown).toContain(REDACTION);
    expect(markdown).not.toContain("ghp_");
    expect(markdown).not.toContain("sk-ant-api03-");
    expect(JSON.stringify(env.struct)).toContain(ghToken);
    expect(JSON.stringify(env.struct)).toContain(apiKey);

    const source = chooseSource(file(markdown), env);
    expect(source.kind).toBe("markdown");

    const m = todayModel({
      snapshot: snapshot(state({ phase: "delivered", at: "2026-09-16T07:24:00.000Z" }, "Delivered 07:24")),
      latest: { state: "loaded", file: file(markdown) },
      lastRun: env,
      today: TODAY,
    });
    const body = view(m);
    expect(body).toContain(REDACTION);
    expect(body).not.toContain("ghp_");
    expect(body).not.toContain("sk-ant-api03-");
    expect(body).toContain("Shown from briefing-latest.md.");
  });

  test("both renderers show the same lines for the same briefing", () => {
    const viaStruct = chooseSource(file(md(RICH_ENOUGH)), envelope(RICH_ENOUGH));
    const viaFile = chooseSource(file(md(RICH_ENOUGH)), null);
    if (viaStruct.kind === "none" || viaFile.kind === "none") throw new Error("expected a briefing");
    expect(viaStruct.kind).toBe("struct");
    expect(viaFile.kind).toBe("markdown");
    const text = (b: typeof viaStruct.blocks) => b.map((x) => x.spans.map((s) => s.text).join(""));
    expect(text(viaStruct.blocks)).toEqual(text(viaFile.blocks));
  });

  test("the briefing's own date, the local date, the envelope and the mtime key", () => {
    const src = chooseSource(file(md(YESTERDAY)), null);
    expect(src.kind === "markdown" ? briefingDate(src.blocks) : null).toBe("2026-09-15");
    expect(localDate(new Date(2026, 8, 6, 23, 59))).toBe("2026-09-06");
    expect(envelopeOf({ markdown: "x", runDate: TODAY, delivered: true, struct: null })?.markdown).toBe("x");
    expect(envelopeOf({ skipReason: "offline" })).toBeNull();
    // A real skip envelope (no struct, empty markdown) parses and is never the struct source.
    expect(envelopeOf({ markdown: "", runDate: TODAY, delivered: false, struct: null })?.struct).toBeNull();
    expect(envelopeOf(null)).toBeNull();
    expect(latestMtime(snapshot(null))).toBe("2026-09-16T07:24:00.000Z");
    expect(latestMtime(null)).toBeNull();
  });
});

const RICH_ENOUGH: BriefingStruct = {
  ...DELIVERED,
  stateAsOf: "07:24",
  morningFloor: "07:20",
  recap: [
    { repo: "app", text: "a", evidence: "abc1234", group: "g" },
    { repo: "app", text: "b", group: "g" },
  ],
  warnings: ["w"],
};

describe("Today's states", () => {
  const delivered = state({ phase: "delivered", at: "2026-09-16T07:24:00.000Z" }, "Delivered 07:24");

  test("no briefing yet", () => {
    const m = todayModel({
      snapshot: snapshot(state({ phase: "waiting-for-floor", floor: "07:20", minutesUntilFloor: 30 }, "Waiting — first check after 07:20")),
      latest: { state: "none" },
      lastRun: null,
      today: TODAY,
    });
    expect(m.empty).toBe(true);
    const body = view(m);
    expect(body).toContain("No briefing yet");
    expect(body).toContain("Waiting — first check after 07:20");
    expect(body).not.toContain('class="briefing');
  });

  test("a delivered briefing, shown from the struct, with hostile text kept literal", () => {
    const m = todayModel({ snapshot: snapshot(delivered), latest: loaded(DELIVERED), lastRun: envelope(DELIVERED), today: TODAY });
    expect(m.source.kind).toBe("struct");
    expect(m.staleDate).toBeNull();
    const body = view(m);
    expect(body).toContain('class="badge info');
    expect(body).toContain("Delivered 07:24");
    expect(body).not.toContain("<img");
    expect(body).toContain("resume &lt;img src=x onerror=");
    expect(body).toContain("Shown from the run this app just started.");
  });

  test("SNAPSHOT quiet day: the real quiet briefing, labelled, never an error", () => {
    const m = todayModel({ snapshot: snapshot(delivered), latest: loaded(QUIET), lastRun: null, today: TODAY });
    expect(m.quiet).toBe(true);
    expect(m.banners).toEqual([]);
    const body = view(m);
    expect(body).toContain("A quiet day: there were no commits in the briefing's window.");
    expect(body).toContain("(no commits in the window)");
    expect(body).toContain("(nothing in progress)");
    expect(body).not.toMatch(/class="[^"]*\bbad\b/);
    expect(body).toMatchSnapshot();
  });

  test("SNAPSHOT blocked: the engine's line, verbatim, and yesterday's briefing labelled stale", () => {
    const detail = `blocked: 2 repos could not be read (${HOSTILE}); not marking today done`;
    const m = todayModel({
      snapshot: snapshot(state({ phase: "skipped", reason: "blocked", detail, iso: "2026-09-16T07:30:00.000Z" }, "Blocked — repos need access")),
      latest: loaded(YESTERDAY),
      lastRun: null,
      today: TODAY,
    });
    expect(m.staleDate).toBe("2026-09-15");
    expect(m.banners).toEqual([{ tone: "warn", text: detail }]);
    const body = view(m);
    expect(body).toContain('class="badge warn');
    expect(body).toContain("Blocked — repos need access");
    expect(body).toContain("from 2026-09-15 — not today's");
    expect(body).not.toContain("<img");
    expect(body).toMatchSnapshot();
  });

  test("SNAPSHOT offline: informational, not an error", () => {
    const detail = "offline: the network did not come up within 90s; will retry next interval";
    const m = todayModel({
      snapshot: snapshot(state({ phase: "skipped", reason: "offline", detail, iso: null }, "Offline — will retry")),
      latest: loaded(YESTERDAY),
      lastRun: null,
      today: TODAY,
    });
    expect(m.banners).toEqual([{ tone: "info", text: detail }]);
    const body = view(m);
    expect(body).toContain('class="badge info');
    expect(body).toContain('class="banner info');
    expect(body).toContain(detail);
    expect(body).toMatchSnapshot();
  });

  test("SNAPSHOT limited: the engine's line and nothing invented beside it", () => {
    const detail = 'skipped: account "primary" is unavailable — no other account is available; will retry next interval';
    const m = todayModel({
      snapshot: snapshot(state({ phase: "skipped", reason: "limited", detail, iso: null }, "Usage limit — skipped")),
      latest: loaded(YESTERDAY),
      lastRun: null,
      today: TODAY,
    });
    const body = view(m);
    expect(body).toContain(detail);
    expect(body).toContain("Usage limit — skipped");
    // No reset time is synthesised by this screen.
    expect(body).not.toMatch(/resets?\b/i);
    expect(body).toMatchSnapshot();
  });

  test("a failed read and a snapshot error are shown, as text", () => {
    const m = todayModel({
      snapshot: snapshot(null, { error: `status failed: ${HOSTILE}` }),
      latest: { state: "error", message: describeFailure({ kind: "unreadable", path: "/p", detail: "/p is a symbolic link" }) },
      lastRun: null,
      today: TODAY,
    });
    expect(m.status).toBeNull();
    const body = view(m);
    expect(body).toContain("Checking…");
    expect(body).toContain("/p is a symbolic link");
    expect(body).not.toContain("<img");
  });

  test("Run Now: progress lines verbatim, a busy refusal says what is running", () => {
    const m = todayModel({ snapshot: snapshot(delivered), latest: loaded(DELIVERED), lastRun: null, today: TODAY });
    const busy = describeFailure({ kind: "busy", running: "schedule-install" });
    expect(busy).toBe("Another engine operation is already running (schedule-install), so this one was not started.");
    const body = view(m, { running: true, progress: ["waiting for network…", HOSTILE], runResult: busy });
    expect(body).toContain("Running…");
    expect(body).toContain("disabled");
    expect(body).toContain("waiting for network…");
    expect(body).toContain("&lt;img src=x");
    expect(body).toContain(busy);
    expect(body).toContain("Generates today's briefing if it has not been generated yet.");
  });
});
