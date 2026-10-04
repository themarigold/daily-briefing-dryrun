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
import { readFileSync } from "node:fs";
import { compile } from "svelte/compiler";
import { render } from "svelte/server";

import { API_NOTICE_TEXTS, renderBriefing } from "../../src/render";
import { REDACTION, redactCredentials } from "../../src/transcripts/credentials";
import type { BriefingStruct as EngineStruct } from "../../src/types";

import { detailsOpen, type EngineOutcome, type Outcome } from "../src/lib/engine";
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
    props: { model, running: false, progress: [], runResult: "", detailsOpen: false, onrun: () => {}, ...extra },
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
    // v0.2.1 §2.2: which copy was rendered is no longer said on screen (`source.kind` stays in the model).
    expect(body).not.toContain("Shown from briefing-latest.md.");
    expect(body).not.toContain("Shown from the run this app just started.");
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
    // v0.2.1 §3.1: one name for the setting, "morning time".
    expect(body).toContain("on the first check after your morning time once the machine is awake");
    expect(body).toContain("once your morning time has passed.");
    expect(body).not.toContain("floor");
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
    // v0.2.1 §2.2: the source line is gone; the model still knows (asserted above).
    expect(body).not.toContain("Shown from the run this app just started.");
    expect(body).not.toContain("Shown from briefing-latest.md.");
    expect(body).not.toContain('class="source');
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
    expect(body).toContain("Generates today's briefing if it has not been generated yet and your morning time has passed.");
    expect(body).not.toContain("floor");
  });
});

/* ── v0.2.1 §2.1: the engine's stderr behind a "Details" disclosure ─────────────────────────────── */

describe("Details: the run's engine lines, collapsed unless they explain a problem (v0.2.1 §2.1)", () => {
  const finished = (outcome: Outcome): { outcome: EngineOutcome } => ({
    outcome: { operation: "run", outcome, exitCode: null, payload: null, stdout: "", stderr: "" },
  });

  test("detailsOpen: no run → closed; the catch path → open; failed and configError → open; delivered and skipped → closed", () => {
    expect(detailsOpen(null)).toBe(false);
    expect(detailsOpen({ threw: true })).toBe(true);
    expect(detailsOpen(finished({ kind: "failed", reason: null }))).toBe(true);
    expect(detailsOpen(finished({ kind: "failed", reason: "blocked" }))).toBe(true);   // a blocked run exits 1
    expect(detailsOpen(finished({ kind: "configError" }))).toBe(true);
    expect(detailsOpen(finished({ kind: "delivered" }))).toBe(false);
    expect(detailsOpen(finished({ kind: "skipped", reason: "offline" }))).toBe(false);
  });

  const m = () => todayModel({ snapshot: snapshot(null), latest: loaded(DELIVERED), lastRun: null, today: TODAY });
  const lines = ["postcheck-info [suggestion-restates-near]: below threshold", "waited ~0s for the network to come up", HOSTILE];
  const disclosure = (body: string) => /<details\b[^>]*>\s*<summary\b[^>]*>Details<\/summary>/.exec(body);
  const isOpen = (body: string) => /\bopen\b/.test(/<details\b([^>]*)>/.exec(body)?.[1] ?? "");

  test("prop false: a closed Details disclosure holding every line, verbatim and escaped", () => {
    const body = view(m(), { progress: lines, detailsOpen: false });
    expect(disclosure(body)).not.toBeNull();
    expect(isOpen(body)).toBe(false);
    expect(body).toContain("postcheck-info [suggestion-restates-near]: below threshold");
    expect(body).toContain("waited ~0s for the network to come up");
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img src=x");
  });

  test("prop true: the same disclosure, open, and the text still escaped", () => {
    const body = view(m(), { progress: lines, detailsOpen: true });
    expect(disclosure(body)).not.toBeNull();
    expect(isOpen(body)).toBe(true);
    expect(body).toContain("waited ~0s for the network to come up");
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img src=x");
  });

  test("no engine lines → no disclosure at all", () => {
    expect(view(m(), { progress: [], detailsOpen: true })).not.toContain("<details");
  });

  test("the result line sits ABOVE the disclosure it points at (\"see Details below\")", () => {
    const refused = "The engine refused to run — see Details below.";
    // PREMISE: the sentence is App.svelte's own configError text, so "below" is the wording under test.
    expect(readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8")).toContain(`"${refused}"`);
    const body = view(m(), { progress: lines, detailsOpen: true, runResult: refused });
    const result = body.indexOf(`<p class="result`);
    const details = body.indexOf("<details");
    expect([result > -1, details > -1, body.includes(refused)]).toEqual([true, true, true]);
    expect(result).toBeLessThan(details);
  });

  /* M2 checkpoint: the disclosure follows the prop only when the PROP changes, and the user's toggle
     otherwise. A server render runs no effects and has no `toggle` event, so it can show only the
     initial state (the two tests above). The rest is pinned on the CLIENT build — compiled by the
     installed compiler, as Vite compiles it — because the defect lived there: `open={detailsOpen}`
     compiled into the same render effect as the `<pre>` text, so every streamed stderr line re-applied
     the prop. ⚠ NOT EXECUTED HERE: no DOM is installed in this harness, so the click → `toggle` →
     state round trip, and the element actually staying open while lines stream, are not run by any
     test; Svelte 5.57.0's writable-derived semantics the fix relies on were measured outside the suite
     (the M2 fixer's report). */
  const VIEW_SRC = readFileSync(new URL("../src/routes/TodayView.svelte", import.meta.url), "utf8");
  const clientJs = (source: string) =>
    compile(source, { filename: "TodayView.svelte", generate: "client", runes: true }).js.code;
  const OPEN_WRITE = /\b\w+\.open\s*=\s*[^=\s]/;

  test("client build: `open` is a derived of the prop, read and written by `bind:open` alone — never by the text effect", () => {
    const js = clientJs(VIEW_SRC);
    expect(js).toContain('$$props.progress.join("\\n")');   // PREMISE: the streamed text is in this build
    const derived = /let (\w+) = \$\.derived\(\(\) => \$\$props\.detailsOpen\);/.exec(js);
    expect(derived).not.toBeNull();
    const binds = [
      ...js.matchAll(/\$\.bind_property\('open', 'toggle', details, \(\$\$value\) => \$\.set\((\w+), \$\$value\), \(\) => \$\.get\((\w+)\)\);/g),
    ].map((b) => [b[1], b[2]]);
    expect(binds).toEqual([[derived![1], derived![1]]]);
    expect(js).not.toMatch(OPEN_WRITE);
  });

  test("prove-it 3b: the pre-fix markup DOES write `open` in the effect that sets the streamed text", () => {
    const old = VIEW_SRC.replace('<details class="details" bind:open>', '<details class="details" open={detailsOpen}>');
    expect(old).not.toBe(VIEW_SRC);   // PREMISE: the reversion applied
    const js = clientJs(old);
    expect(js).toMatch(OPEN_WRITE);
    expect(js).not.toContain("bind_property('open'");
    expect(js).toMatch(/details\.open = \$\$props\.detailsOpen;\s*\$\.set_text\(\w+, \$0\);/);
  });

  test("App passes `detailsOpen` as an explicit `$derived` value, not an inline call", () => {
    // The writable derived above re-derives when the PROP changes; App holding the value in its own
    // `$derived` is what makes a false → false run end no change, rather than a compiler detail.
    const app = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8");
    const passed = /\bdetailsOpen=\{(\w+)\}/.exec(app);
    expect(passed).not.toBeNull();
    expect(app).toMatch(new RegExp(`\\bconst ${passed![1]} = \\$derived\\(detailsOpen\\(lastRunResult\\)\\);`));
    expect(app).not.toContain("detailsOpen={detailsOpen(");
  });
});

/* ── v0.2.1 §2.4.3: the quiet-day line points at a DISPLAYED warning ────────────────────────────── */

describe("the quiet-day line (v0.2.1 §2.4.3)", () => {
  const delivered = state({ phase: "delivered", at: "2026-09-16T07:24:00.000Z" }, "Delivered 07:24");
  const SUMMARY = "Couldn't read 1 folder (~/Desktop) because macOS blocked access, so repos in it may be missing.";
  const NEW = "A quiet day: no commits in the window. See the warning below.";
  const OLD = "A quiet day: there were no commits in the briefing's window.";

  test("a quiet day WITH a displayed warnings block says to see it — from the file and from the struct", () => {
    const warned: BriefingStruct = { ...QUIET, warnings: [SUMMARY] };
    for (const lastRun of [null, envelope(warned)]) {
      const mm = todayModel({ snapshot: snapshot(delivered), latest: loaded(warned), lastRun, today: TODAY });
      expect(mm.source.kind).toBe(lastRun === null ? "markdown" : "struct");   // PREMISE: both renderers
      expect([mm.quiet, mm.quietWithWarning]).toEqual([true, true]);
      const body = view(mm);
      expect(body).toContain(NEW);
      expect(body).not.toContain(OLD);
      expect(body).toContain(`⚠ ${SUMMARY}`);
    }
  });

  test("r9: the summary on its OWN ⚠ line beside other warnings (or beside the dropped API notice) still points at them", () => {
    for (const warnings of [["a real warning", SUMMARY], [API_NOTICE_TEXTS[0]!, SUMMARY]]) {
      const warned: BriefingStruct = { ...QUIET, warnings };
      const shown = warnings[0] === "a real warning" ? ["⚠ a real warning", `⚠ ${SUMMARY}`] : [`⚠ ${SUMMARY}`];
      expect(md(warned).split("\n").filter((l) => l.startsWith("⚠ "))).toEqual(shown);   // PREMISE: the engine's lines
      for (const lastRun of [null, envelope(warned)]) {
        const mm = todayModel({ snapshot: snapshot(delivered), latest: loaded(warned), lastRun, today: TODAY });
        expect(mm.source.kind).toBe(lastRun === null ? "markdown" : "struct");   // both renderers, and they agree
        expect([mm.quiet, mm.quietWithWarning]).toEqual([true, true]);
        const body = view(mm);
        expect(body).toContain(NEW);
        for (const line of shown) expect(body).toContain(line);
        expect(body).not.toContain("provider hardening");
      }
    }
  });

  test("a quiet day WITHOUT a warnings block keeps the old line", () => {
    const mm = todayModel({ snapshot: snapshot(delivered), latest: loaded(QUIET), lastRun: null, today: TODAY });
    expect([mm.quiet, mm.quietWithWarning]).toEqual([true, false]);
    const body = view(mm);
    expect(body).toContain(OLD);
    expect(body).not.toContain(NEW);
  });

  test("an API run's quiet day whose ONLY warning is the API notice keeps the old line: the notice is never displayed", () => {
    const api: BriefingStruct = { ...QUIET, provider: "anthropic: claude-x", warnings: [API_NOTICE_TEXTS[0]!] };
    expect(md(api)).not.toContain("⚠");   // PREMISE: the engine leaves the notice out of the file
    for (const lastRun of [null, envelope(api)]) {
      const mm = todayModel({ snapshot: snapshot(delivered), latest: loaded(api), lastRun, today: TODAY });
      expect(mm.source.kind).toBe(lastRun === null ? "markdown" : "struct");
      expect([mm.quiet, mm.quietWithWarning]).toEqual([true, false]);
      const body = view(mm);
      expect(body).toContain(OLD);
      expect(body).not.toContain(NEW);
      expect(body).not.toContain("provider hardening");
    }
  });

  test("a busy day with a warning shows no quiet line at all", () => {
    const busy: BriefingStruct = { ...DELIVERED, warnings: [SUMMARY] };
    const mm = todayModel({ snapshot: snapshot(delivered), latest: loaded(busy), lastRun: null, today: TODAY });
    expect([mm.quiet, mm.quietWithWarning]).toEqual([false, false]);
    const body = view(mm);
    expect(body).not.toContain(NEW);
    expect(body).not.toContain(OLD);
  });
});
