/**
 * The Svelte screens, rendered by the real compiler (see `svelte-loader.ts`) and asserted as markup.
 *
 * What only a render can pin, and the Rust suite cannot: that WAITING-FOR-WAKE is painted as
 * information rather than as an error, that a null tick count reads "unknown" and never "0", that
 * every engine-supplied string stays TEXT, that the Quit dialog adds no claim of its own, and that
 * the foreign-owner dialog puts KEEP-EXISTING first.
 */
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";

import ForeignOwnerDialog from "../src/lib/ForeignOwnerDialog.svelte";
import QuitDialog from "../src/lib/QuitDialog.svelte";
import ScheduleInstall from "../src/lib/ScheduleInstall.svelte";
import ScheduleUninstall from "../src/lib/ScheduleUninstall.svelte";
import Schedule from "../src/routes/Schedule.svelte";
import { UNINSTALL_TIME_SENTENCE } from "../src/lib/app-uninstall";
import { afterInstall, armsVerify } from "../src/lib/install-flow";
import { afterKeep, afterUninstall, uninstallLine, type UninstallLine } from "../src/lib/uninstall-flow";
import type { EngineOutcome } from "../src/lib/engine";
import type { Phase, ScheduleState } from "../src/lib/state";

const HOSTILE = '<img src=x onerror="alert(1)">';

function state(phase: Phase, statusLine: string, extra: Partial<ScheduleState> = {}): ScheduleState {
  return {
    phase,
    statusLine,
    floor: "07:20",
    floorWarning: null,
    firstWake:
      "Your briefing is generated on the first check after 07:20 once your machine is awake — not at 07:20.",
    ticksToday: 11,
    ticksExpectedSinceFloor: 11,
    lastTick: { iso: "2026-09-16T16:05:00.000Z", localDate: "2026-09-16", count: 11 },
    owner: "app",
    invoker: "app",
    unitPath: "/Users/x/Library/LaunchAgents/local.daily-briefing.plist",
    registered: true,
    recordPresent: true,
    unitPresent: true,
    engineVersion: "0.1.1",
    installedEngineVersion: "0.1.1",
    engineUpdateAvailable: false,
    intervalSec: 600,
    experimental: false,
    lingerState: "not-applicable",
    recordFilePresent: true,
    registeredReason: null,
    removeSteps: "Run these in a terminal (bash or zsh) inside your desktop session.",
    ...extra,
  };
}

/** The rendered HTML, with Svelte's hydration comments removed and whitespace collapsed (the
 *  source wraps prose across lines). */
function html(component: unknown, props: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(component as any, { props })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");
}

function badge(body: string): { tone: string; text: string } {
  const m = /<div class="badge (\w+)[^"]*">([\s\S]*?)<\/div>/.exec(body);
  if (m === null) throw new Error(`no badge in: ${body}`);
  return { tone: m[1] ?? "", text: (m[2] ?? "").trim() };
}

function ticksCell(body: string): string {
  const m = /<dd class="ticks[^"]*">([\s\S]*?)<\/dd>/.exec(body);
  if (m === null) throw new Error(`no ticks cell in: ${body}`);
  return (m[1] ?? "").trim();
}

function buttons(body: string): { cls: string; text: string }[] {
  return [...body.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
    cls: /class="([^"]*)"/.exec(m[1] ?? "")?.[1] ?? "",
    text: (m[2] ?? "").trim(),
  }));
}

describe("Schedule.svelte", () => {
  test("WAITING-FOR-WAKE is informational, never the problem tone", () => {
    const body = html(Schedule, {
      state: state({ phase: "waiting-for-wake" }, "Waiting — first wake past 07:20"),
    });
    const b = badge(body);
    expect(b.tone).toBe("info");
    expect(b.text).toBe("Waiting — first wake past 07:20");
    expect(body).toContain("The checks are running");
  });

  test("the tones: problems are bad, ordinary skips are info, the rest warn", () => {
    const cases: [Phase, string][] = [
      [{ phase: "waiting-for-floor", floor: "07:20", minutesUntilFloor: 80 }, "info"],
      [{ phase: "delivered", at: null }, "info"],
      [{ phase: "not-scheduled" }, "bad"],
      [{ phase: "scheduler-broken" }, "bad"],
      [{ phase: "config-error", detail: "x", deliveredToday: false, deliveredAt: null }, "bad"],
      [{ phase: "agent-stale", lastTick: null, staleAfterSecs: 1200 }, "bad"],
      [{ phase: "unknown-tick", cause: "legacy" }, "warn"],
      [{ phase: "skipped", reason: "offline", detail: null, iso: null }, "info"],
      [{ phase: "skipped", reason: "darkwake", detail: null, iso: null }, "info"],
      [{ phase: "skipped", reason: "provider-fail", detail: null, iso: null }, "warn"],
    ];
    for (const [phase, tone] of cases) {
      expect([phase.phase, badge(html(Schedule, { state: state(phase, "line") })).tone]).toEqual([
        phase.phase,
        tone,
      ]);
    }
  });

  test("the badge is the Rust status line — a skip shows words, never the raw token", () => {
    const body = html(Schedule, {
      state: state(
        { phase: "skipped", reason: "provider-fail", detail: "provider exited 1", iso: null },
        "The provider failed",
      ),
    });
    expect(badge(body).text).toBe("The provider failed");
    expect(body).not.toContain("provider-fail");
  });

  test("a null tick count reads 'unknown', never 0; a real 0 is shown as 0", () => {
    const unknown = html(Schedule, {
      state: state({ phase: "unknown-tick", cause: "legacy" }, "Heartbeat unreadable", {
        ticksToday: null,
        ticksExpectedSinceFloor: null,
      }),
    });
    expect(ticksCell(unknown)).toBe("unknown");
    expect(unknown).toContain("<strong>unknown</strong>");

    const zero = html(Schedule, {
      state: state({ phase: "waiting-for-wake" }, "Waiting", { ticksToday: 0 }),
    });
    expect(ticksCell(zero).startsWith("0")).toBe(true);
  });

  test("engine strings stay text, wherever they appear", () => {
    const rendered = [
      html(Schedule, {
        state: state(
          { phase: "skipped", reason: "blocked", detail: HOSTILE, iso: null },
          "Blocked — a folder or repo could not be read or found",
          { unitPath: HOSTILE, floorWarning: HOSTILE },
        ),
        error: HOSTILE,
      }),
      html(Schedule, {
        state: state(
          { phase: "config-error", detail: HOSTILE, deliveredToday: false, deliveredAt: null },
          "Config has an error",
        ),
      }),
      html(Schedule, {
        state: state({ phase: "skipped", reason: HOSTILE, detail: null, iso: null }, HOSTILE),
      }),
    ];
    for (const body of rendered) {
      expect(body).not.toContain("<img");
      expect(body).toContain("&lt;img src=x onerror=");
    }
  });

  test("config-error says what is wrong and keeps today's delivery visible", () => {
    const body = html(Schedule, {
      state: state(
        {
          phase: "config-error",
          detail: "Unexpected token } in JSON",
          deliveredToday: true,
          deliveredAt: "2026-09-16T14:24:00.000Z",
        },
        "Delivered 07:24 · config has an error",
      ),
    });
    expect(badge(body).text).toBe("Delivered 07:24 · config has an error");
    expect(body).toContain("could not be loaded");
    expect(body).toContain("Unexpected token } in JSON");
    expect(body).toContain("already been delivered");
    expect(body).not.toContain("declined to generate");
  });

  test("a broken scheduler offers ONE repair control, and says which leg is missing", () => {
    const body = html(Schedule, {
      state: state({ phase: "scheduler-broken" }, "Scheduler not loaded", { unitPresent: false }),
    });
    expect(body).toContain("its trigger file is missing");
    // R2-14: the repair, and not also the generic install/repair button beneath it. B6 adds the
    // verification and removal controls beside it — a BROKEN scheduler still has a record, which is
    // exactly the state where "check it" and "remove it" are the two useful answers.
    expect(buttons(body).map((b) => b.text)).toEqual([
      "Repair background scheduler",
      "Check the background scheduler now",
      "Remove background scheduler…",
    ]);
    const unloaded = html(Schedule, {
      state: state({ phase: "scheduler-broken" }, "Scheduler not loaded", { registered: false }),
    });
    expect(unloaded).toContain("does not have it loaded");
  });

  test("the marker-fail copy agrees with the tray: delivered, but not recorded", () => {
    const body = html(Schedule, {
      state: state(
        { phase: "skipped", reason: "marker-fail", detail: "EACCES", iso: null },
        "Delivered, but the day marker failed",
      ),
    });
    expect(badge(body).text).toBe("Delivered, but the day marker failed");
    expect(body).toContain("briefing was written");
    expect(body).not.toContain("did not generate a briefing");
  });

  test("agent-stale with no tick recorded gets its own sentence", () => {
    const body = html(Schedule, {
      state: state(
        { phase: "agent-stale", lastTick: null, staleAfterSecs: 1200 },
        "Scheduler has not checked in",
        { lastTick: null },
      ),
    });
    expect(body).toContain("No check has been recorded at all");
    expect(body).not.toContain("never recorded, which is");
  });

  test("each unknown-tick cause has its own explanation", () => {
    const text = (cause: "legacy" | "unreadable-instant" | "future") =>
      html(Schedule, { state: state({ phase: "unknown-tick", cause }, "Heartbeat") });
    expect(text("legacy")).toContain("format this version does not recognise");
    expect(text("unreadable-instant")).toContain("cannot read");
    expect(text("future")).toContain("later than this machine's clock");
  });

  test("the update prompt appears only when the state says so", () => {
    const no = html(Schedule, { state: state({ phase: "waiting-for-wake" }, "Waiting") });
    expect(no).not.toContain("Update background engine");
    const yes = html(Schedule, {
      state: state({ phase: "waiting-for-wake" }, "Waiting", {
        engineUpdateAvailable: true,
        installedEngineVersion: "0.1.0",
      }),
    });
    expect(buttons(yes).map((b) => b.text)).toContain("Update background engine");
  });

  test("every other phase has exactly one install/repair control", () => {
    const phases: Phase[] = [
      { phase: "not-scheduled" },
      { phase: "waiting-for-wake" },
      { phase: "delivered", at: null },
      { phase: "agent-stale", lastTick: null, staleAfterSecs: 1200 },
    ];
    for (const phase of phases) {
      const labels = buttons(html(Schedule, { state: state(phase, "line") })).map((b) => b.text);
      // ONE install/repair control, still — B6's two are a verification and a removal, neither of
      // which installs anything.
      expect([phase.phase, labels.filter((l) => /Install|Repair|Update/.test(l))]).toEqual([
        phase.phase,
        ["Install / repair scheduler"],
      ]);
    }
  });

  // B6 (T20) + Batch 2 (spec 3.4.1): verification keys on `recordPresent`, which gui-seam §3 calls
  // authoritative — a READABLE record to verify. The removal keys on anything of a scheduler the
  // engine sees: the record FILE (readable or not), a unit file, or a registration with no files — so
  // a job left loaded after its files went, or a malformed record, can still be removed from this
  // screen. Neither keys on the phase.
  test("verify needs a readable record; remove shows for a record file, a unit or a registration (spec 3.4.1)", () => {
    const VERIFY = "Check the background scheduler now";
    const REMOVE = "Remove background scheduler…";
    const nothing: Partial<ScheduleState> = {
      recordPresent: false,
      recordFilePresent: false,
      unitPresent: false,
      registered: false,
      owner: null,
      invoker: null,
      unitPath: null,
    };
    const drawn = (extra: Partial<ScheduleState>): string[] =>
      buttons(html(Schedule, { state: state({ phase: "not-scheduled" }, "Nothing scheduled", { ...nothing, ...extra }) }))
        .map((b) => b.text)
        .filter((t) => t === VERIFY || t === REMOVE);

    // A readable record (and its file): both, verify first.
    const withRecord = buttons(html(Schedule, { state: state({ phase: "waiting-for-wake" }, "Waiting") })).map((b) => b.text);
    expect(withRecord.filter((t) => t === VERIFY || t === REMOVE)).toEqual([VERIFY, REMOVE]);
    expect(drawn({ recordPresent: true, recordFilePresent: true })).toEqual([VERIFY, REMOVE]);
    // The record file with no readable record (malformed, a dangling link): remove only.
    expect(drawn({ recordFilePresent: true })).toEqual([REMOVE]);
    // A unit file with no record: remove only.
    expect(drawn({ unitPresent: true, unitPath: "/Users/x/Library/LaunchAgents/local.daily-briefing.plist" })).toEqual([
      REMOVE,
    ]);
    // A registration with no files (a job left loaded): remove only.
    expect(drawn({ registered: true })).toEqual([REMOVE]);
    // Nothing on disk and nothing registered — or the check could not say: neither.
    expect(drawn({})).toEqual([]);
    expect(drawn({ registered: null, registeredReason: "no-user-manager" })).toEqual([]);

    // Nothing at all: the one install control and nothing else.
    const noRecord = buttons(
      html(Schedule, { state: state({ phase: "not-scheduled" }, "Nothing scheduled", { ...nothing, registered: null }) }),
    ).map((b) => b.text);
    expect(noRecord).toEqual(["Install / repair scheduler"]);
  });

  test("a stale schedule half says so, and its counts read unknown", () => {
    const stale = html(Schedule, {
      state: state({ phase: "waiting-for-wake" }, "Waiting", {
        ticksToday: null,
        ticksExpectedSinceFloor: null,
      }),
      stale: true,
      error: "`schedule status --json` failed: launchctl: timed out",
    });
    expect(stale).toContain("from an earlier check");
    expect(ticksCell(stale)).toBe("unknown");
    const fresh = html(Schedule, { state: state({ phase: "waiting-for-wake" }, "Waiting") });
    expect(fresh).not.toContain("from an earlier check");
  });

  test("the error heading follows the error's kind: a failed read, or stopped live updates", () => {
    const failedRead = html(Schedule, {
      state: state({ phase: "waiting-for-wake" }, "Waiting"),
      error: "`schedule status --json` failed: launchctl: timed out",
    });
    expect(failedRead).toContain("Part of the engine's state could not be read:");
    expect(failedRead).not.toContain("no longer updating");
    const stopped = html(Schedule, {
      state: state({ phase: "waiting-for-wake" }, "Waiting"),
      error:
        "Live updates have stopped: the state-directory watcher failed (boom). What is shown will not change on its own; restart Daily Briefing to resume live updates.",
      stopped: true,
    });
    expect(stopped).toContain("This screen is no longer updating on its own:");
    expect(stopped).not.toContain("could not be read");
    expect(stopped).toContain("Live updates have stopped");
    // No error, no heading of either kind.
    const clean = html(Schedule, { state: state({ phase: "waiting-for-wake" }, "Waiting") });
    expect(clean).not.toContain("could not be read");
    expect(clean).not.toContain("no longer updating");
  });

  test("before the first snapshot it says it is checking", () => {
    expect(html(Schedule, { state: null })).toContain("Checking…");
  });
});

/** What a reader sees: the render with its tags dropped, Svelte's entities read back, and whitespace
 *  collapsed (the source wraps prose across lines). */
function readable(body: string): string {
  return body
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
}

/** The render as-is (hydration comments removed), so a `<pre>`'s line breaks survive. */
function raw(component: unknown, props: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(component as any, { props }).body.replace(/<!--[\s\S]*?-->/g, "");
}

/** Every `<pre>`'s text, its entities read back. */
function pres(body: string): string[] {
  return [...body.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/g)].map((m) =>
    (m[1] ?? "")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, "&"),
  );
}

/** In a component's source, the index just past the `{/if}` that closes the `{#if …}` opening at `at`
 *  (nested `{#if}` blocks counted; `{:else if}` opens none), or -1. */
function closeOf(source: string, at: number): number {
  if (at < 0) return -1;
  const tags = /\{#if\b|\{\/if\}/g;
  tags.lastIndex = at;
  let depth = 0;
  for (let m = tags.exec(source); m !== null; m = tags.exec(source)) {
    depth += m[0] === "{/if}" ? -1 : 1;
    if (depth === 0) return m.index + m[0].length;
  }
  return -1;
}

describe("Schedule.svelte — Batch 2's lines (spec 3.4.2, 3.4.9)", () => {
  const PLIST = "/Users/x/Library/LaunchAgents/local.daily-briefing.plist";
  const REMOVE = "Remove background scheduler…";
  // The engine's `removeSteps` (spec 3.1.8): the framing line, then the steps, with NO closing line.
  const STEPS = [
    "Run these in a terminal (bash or zsh) inside your desktop session.",
    "1. Unregister the job:",
    "   launchctl bootout gui/$(id -u)/local.daily-briefing; launchctl bootout user/$(id -u)/local.daily-briefing",
    `4. Delete the files:\n   rm -f -- "$HOME"/'Library/LaunchAgents/local.daily-briefing.plist'`,
  ].join("\n");
  const CLOSING = "Then press Remove again, or run Uninstall again.";
  const nothing: Partial<ScheduleState> = {
    recordPresent: false,
    recordFilePresent: false,
    unitPresent: false,
    registered: false,
    owner: null,
    invoker: null,
    // What `schedule status --json` reports with no record: the COMPUTED default path (`status.ts`).
    unitPath: PLIST,
  };
  const notScheduled = (extra: Partial<ScheduleState>): ScheduleState =>
    state({ phase: "not-scheduled" }, "Scheduler not installed", { ...nothing, ...extra });
  const removeButtons = (body: string): string[] => buttons(body).map((b) => b.text).filter((t) => t === REMOVE);

  test("registered === null: one line with the reason in words, the engine's steps verbatim, then the app's closing line once — alone with nothing on disk (spec 3.4.2; SQ6)", () => {
    const unknown = { registered: null, registeredReason: "no-user-manager", removeSteps: STEPS };
    const body = raw(Schedule, { state: notScheduled(unknown) });
    const text = readable(body);
    const LINE = "Couldn't check whether the scheduler is registered (the system's user services couldn't be reached).";
    expect(text).toContain(LINE);
    // The reason is a phrase, never its token.
    expect(text).not.toContain("no-user-manager");
    // The steps verbatim — line breaks and quoting intact — then the closing line, once, after them.
    expect(pres(body)).toContain(STEPS);
    expect(text.split(CLOSING).length - 1).toBe(1);
    expect(text.indexOf(CLOSING)).toBeGreaterThan(text.indexOf("rm -f --"));
    expect(text.indexOf("rm -f --")).toBeGreaterThan(text.indexOf(LINE));
    // Nothing on disk: the line stands alone, with no remove control.
    expect(removeButtons(body)).toEqual([]);

    // With files, the remove control shows as well (spec 3.4.1): a record file, a unit, or both.
    for (const files of [
      { recordFilePresent: true },
      { unitPresent: true },
      { recordPresent: true, recordFilePresent: true, unitPresent: true },
    ]) {
      const withFiles = raw(Schedule, {
        state: state({ phase: "waiting-for-wake" }, "Waiting", { ...nothing, ...files, ...unknown }),
      });
      expect([files, readable(withFiles).includes(LINE)]).toEqual([files, true]);
      expect([files, pres(withFiles).includes(STEPS)]).toEqual([files, true]);
      expect([files, removeButtons(withFiles)]).toEqual([files, [REMOVE]]);
    }

    // Each reason in its own words; an unknown or missing one reads as the unexpected answer it is.
    for (const [reason, words] of [
      ["no-gui-session", "this isn't a desktop session"],
      ["timeout", "the check took too long"],
      ["spawn", "the check couldn't start"],
      ["unexpected", "the system gave an unexpected answer"],
      ["some-newer-token", "the system gave an unexpected answer"],
      [null, "the system gave an unexpected answer"],
    ] as const) {
      expect(readable(raw(Schedule, { state: notScheduled({ ...unknown, registeredReason: reason }) }))).toContain(
        `Couldn't check whether the scheduler is registered (${words}).`,
      );
    }

    // No steps where spec 3.1 does not apply (`removeSteps: null`): the line alone, and no closing line.
    const noSteps = raw(Schedule, { state: notScheduled({ ...unknown, removeSteps: null }) });
    expect(readable(noSteps)).toContain(LINE);
    expect(readable(noSteps)).not.toContain(CLOSING);
    expect(pres(noSteps)).toEqual([]);

    // A check that ran says nothing of the kind.
    for (const registered of [true, false]) {
      const ran = readable(raw(Schedule, { state: notScheduled({ registered, removeSteps: STEPS }) }));
      expect(ran).not.toContain("Couldn't check whether");
      expect(ran).not.toContain(CLOSING);
    }

    // The steps are engine text: drawn as text, never markup.
    const hostile = raw(Schedule, { state: notScheduled({ ...unknown, removeSteps: HOSTILE }) });
    expect(hostile).not.toContain("<img");
    expect(pres(hostile)).toContain(HOSTILE);
  });

  test("the not-scheduled line's three wordings: a unit with no record, a record that can't be read, a registration with no files (spec 3.4.9)", () => {
    /** The muted line under "Nothing owns the background trigger…", or null. */
    const second = (extra: Partial<ScheduleState>): string | null => {
      const body = raw(Schedule, { state: notScheduled(extra) });
      const sentence = /<div class="sentence[^"]*">([\s\S]*?)<\/div>/.exec(body)?.[1] ?? "";
      const muted = /<p class="muted[^"]*">([\s\S]*?)<\/p>/.exec(sentence)?.[1];
      return muted === undefined ? null : readable(muted).trim();
    };

    // 1. A unit file and no record FILE: there is no ownership record, and the unit is named.
    expect(second({ unitPresent: true })).toBe(
      `A scheduler unit does exist on this machine (${PLIST}), but there is no ownership record beside it — so Daily Briefing cannot tell what it will do.`,
    );
    expect(second({ unitPresent: true, registered: true })).toContain("there is no ownership record");

    // 2. A record FILE that can't be read (malformed, a dangling link, oversized): never "no ownership
    // record", because there is one; the unit is named only when it is there.
    const malformed = second({ recordFilePresent: true });
    expect(malformed).toBe(
      "There is a schedule record on this machine, but it can't be read — so Daily Briefing cannot tell who set the scheduler up or what it will do.",
    );
    expect(malformed).not.toContain(PLIST);
    const malformedWithUnit = second({ recordFilePresent: true, unitPresent: true, registered: true });
    expect(malformedWithUnit).toContain("it can't be read");
    expect(malformedWithUnit).toContain(`(${PLIST})`);
    expect(malformedWithUnit).not.toContain("no ownership record");

    // 3. A registration with no files: no unit file is present, and the computed path is NOT named.
    const loaded = second({ registered: true });
    expect(loaded).toBe(
      "A background scheduler is registered with the operating system, but no unit file is present and there is no ownership record — so Daily Briefing cannot tell what it will do.",
    );
    expect(loaded).not.toContain(PLIST);

    // Nothing of a scheduler at all: no second line.
    expect(second({})).toBeNull();
    expect(second({ registered: null, registeredReason: "timeout" })).toBeNull();

    // Every path stays text.
    const hostile = raw(Schedule, { state: notScheduled({ unitPresent: true, unitPath: HOSTILE }) });
    expect(hostile).not.toContain("<img");
  });

  test("M9 round 2 + 3: the not-scheduled intro says no briefing will arrive on its own only when NOTHING of a scheduler is there and the registration check ran — never above a line saying Daily Briefing cannot tell, or couldn't check (spec 3.4.9, 3.4.2)", () => {
    /** The first paragraph of the phase's sentence. */
    const intro = (extra: Partial<ScheduleState>): string => {
      const body = raw(Schedule, { state: notScheduled(extra) });
      const sentence = /<div class="sentence[^"]*">([\s\S]*?)<\/div>/.exec(body)?.[1] ?? "";
      const first = /<p[^>]*>([\s\S]*?)<\/p>/.exec(sentence)?.[1];
      if (first === undefined) throw new Error(`no intro in: ${body}`);
      return readable(first).trim();
    };
    const FULL =
      "Nothing owns the background trigger, so no briefing will arrive on its own. Installing one takes a second and does not change anything else.";
    const SHORT = "Nothing owns the background trigger. Installing one takes a second and does not change anything else.";
    // Nothing at all, and the check RAN and found nothing registered: the full intro.
    expect(intro({})).toBe(FULL);
    // A unit file, a record file (unreadable), or a registration with no files: what it will do is unknown, so
    // the intro claims nothing about whether a briefing arrives.
    for (const extra of [
      { unitPresent: true },
      { recordFilePresent: true },
      { registered: true },
      { recordFilePresent: true, unitPresent: true, registered: true },
      { unitPresent: true, registered: null, registeredReason: "timeout" },
    ] satisfies Partial<ScheduleState>[]) {
      expect([extra, intro(extra)]).toEqual([extra, SHORT]);
      expect([extra, readable(raw(Schedule, { state: notScheduled(extra) })).includes("cannot tell")]).toEqual([extra, true]);
    }
    // M9 round 3: nothing on disk and the check COULD NOT RUN (`registered === null`) — the engine treats that
    // state as not-nothing (exit 3), and the line right below says the check couldn't run, so the intro claims
    // nothing about whether a briefing arrives either.
    const unchecked = raw(Schedule, { state: notScheduled({ registered: null, registeredReason: "timeout" }) });
    expect(intro({ registered: null, registeredReason: "timeout" })).toBe(SHORT);
    expect(readable(unchecked)).toContain("Couldn't check whether the scheduler is registered (the check took too long).");
    expect(readable(unchecked)).not.toContain("no briefing will arrive on its own");
  });

  test("checkpoint M6b (F6): the facts row names a trigger file only when one is there — never the computed default (spec 3.4.8, 3.4.9)", () => {
    const triggerFile = (extra: Partial<ScheduleState>, phase: Phase = { phase: "not-scheduled" }): string => {
      const body = raw(Schedule, { state: state(phase, "line", { ...nothing, ...extra }) });
      const m = /<dt[^>]*>Trigger file<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/.exec(body);
      if (m === null) throw new Error(`no trigger-file row in: ${body}`);
      return readable(m[1] ?? "").trim();
    };
    // No unit file: "none", though `schedule status --json` reports its computed default path — the same
    // screen's 3.4.9 line says no unit file is present, and this row must not contradict it.
    expect(triggerFile({ registered: true })).toBe("none");
    expect(triggerFile({ recordFilePresent: true })).toBe("none");
    expect(triggerFile({ recordPresent: true, recordFilePresent: true, owner: "app", invoker: "app" }, { phase: "scheduler-broken" })).toBe(
      "none",
    );
    expect(triggerFile({ unitPath: null })).toBe("none");
    // A unit file that is there: its path, as before.
    expect(triggerFile({ unitPresent: true })).toBe(PLIST);
    expect(triggerFile({ unitPresent: true }, { phase: "waiting-for-wake" })).toBe(PLIST);
    // Present but no path reported: still "none", never a blank.
    expect(triggerFile({ unitPresent: true, unitPath: null })).toBe("none");
  });

  test("M9 LOW pass (L3): the facts row says a record that is there but can't be read is \"unreadable\" — never \"absent\" under the 3.4.9 line that says it is there (spec 3.4.9)", () => {
    const registeredRow = (extra: Partial<ScheduleState>, phase: Phase = { phase: "not-scheduled" }): string => {
      const body = raw(Schedule, { state: state(phase, "line", { ...nothing, ...extra }) });
      const m = /<dt[^>]*>Registered<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/.exec(body);
      if (m === null) throw new Error(`no registered row in: ${body}`);
      return readable(m[1] ?? "").trim().replace(/\s+/g, " ");
    };
    // A malformed or dangling record (the engine's lstat sees the FILE, no readable record): "unreadable", right
    // under the line that says there is a record that can't be read.
    const malformed = raw(Schedule, { state: notScheduled({ recordFilePresent: true }) });
    expect(readable(malformed)).toContain("There is a schedule record on this machine, but it can't be read");
    expect(registeredRow({ recordFilePresent: true })).toBe("no · record unreadable · unit absent");
    expect(registeredRow({ recordFilePresent: true, unitPresent: true, registered: true })).toBe("yes · record unreadable · unit present");
    // A readable record: "present"; no record file at all: "absent" — as before.
    expect(registeredRow({ recordPresent: true, recordFilePresent: true, owner: "app", invoker: "app" }, { phase: "scheduler-broken" })).toBe(
      "no · record present · unit absent",
    );
    expect(registeredRow({})).toBe("no · record absent · unit absent");
    expect(registeredRow({ registered: null, registeredReason: "timeout" })).toBe("unknown · record absent · unit absent");
  });
});

describe("the removal's outcome line, and how long a removal takes (spec 3.4.4, 3.1.4)", () => {
  const REMOVE = "Remove background scheduler…";
  const nothing: Partial<ScheduleState> = {
    recordPresent: false,
    recordFilePresent: false,
    unitPresent: false,
    registered: false,
    owner: null,
    invoker: null,
    unitPath: null,
  };
  const src = (path: string): Promise<string> => Bun.file(new URL(`../src/${path}`, import.meta.url)).text();
  const screen = (extra: Partial<ScheduleState>, removalLine: UninstallLine | null): string =>
    raw(Schedule, { state: state({ phase: "not-scheduled" }, "Scheduler not installed", { ...nothing, ...extra }), removalLine });
  /** The remove control's rule (spec 3.4.1, checkpoint M6b), as `Schedule.svelte` spells it: outside the
   *  `state === null` guard since M9 round 1, so it reads a state that may be null; and since M9 round 2 it
   *  also holds while a removal attempt is in progress. */
  const REMOVE_RULE =
    "{#if state?.recordFilePresent || state?.unitPresent || state?.registered === true || removalFailed || removalInProgress}";
  /** App's three handlers on the Schedule mount (M9 round 2): an install starting, a removal starting, a
   *  removal ending. */
  const INSTALL_STARTED =
    /oninstallstarted=\{\(\) => \{\s*removalLine = null;\s*removalFailed = false;\s*removalInProgress = false;\s*removalReset \+= 1;\s*\}\}/;
  /** M9 round 3: an install attempt ending, whatever came of it — the failed flag cleared and the control reset,
   *  the line and the in-progress flag left as they are. */
  const INSTALL_ENDED = /oninstallended=\{\(\) => \{\s*removalFailed = false;\s*removalReset \+= 1;\s*\}\}/;
  const REMOVAL_STARTED = /onremovalstarted=\{\(\) => \{\s*removalLine = null;\s*removalInProgress = true;\s*\}\}/;
  const REMOVAL_ENDED =
    /onremovalended=\{\(line\) => \{\s*removalLine = line;\s*removalInProgress = false;\s*removalFailed = line\.kind === "failed";\s*void refresh\(\);\s*\}\}/;

  test("the Schedule screen draws App's line itself, outside the remove control — so it survives the control unmounting once what it keyed on is gone", () => {
    const removed = uninstallLine({ stage: "done", message: "Removed the background scheduler." });
    // After a removal nothing is on disk, so the remove control is gone — and the line is still drawn.
    const after = screen({}, removed);
    expect(buttons(after).map((b) => b.text)).not.toContain(REMOVE);
    expect(readable(after)).toContain("Removed the background scheduler.");
    // With the control still there (a failed removal keeps the record), the line follows it.
    const failedSteps = [
      "The background scheduler is still registered after 30 seconds.",
      "Run these in a terminal (bash or zsh) inside your desktop session.",
      "1. Unregister the job:",
      "   launchctl bootout gui/$(id -u)/local.daily-briefing",
    ].join("\n");
    const failed = uninstallLine({ stage: "failed", message: failedSteps });
    const kept = screen({ recordFilePresent: true, unitPresent: true }, failed);
    expect(buttons(kept).map((b) => b.text)).toContain(REMOVE);
    expect(readable(kept).indexOf("still registered after 30 seconds")).toBeGreaterThan(readable(kept).indexOf(REMOVE));
    // A failure verbatim, its steps' line breaks intact, then the app's closing line, once, after it.
    expect(pres(kept)).toContain(failedSteps);
    const text = readable(kept);
    expect(text.split("Then press Remove again, or run Uninstall again.").length - 1).toBe(1);
    expect(text.indexOf("Then press Remove again")).toBeGreaterThan(text.indexOf("launchctl bootout"));
    // "Keep the existing one" ends with the helper's line, server-rendered (spec 3.4.5).
    expect(readable(screen({ registered: true }, uninstallLine(afterKeep())))).toContain("Kept — nothing was removed.");
    // No line: nothing drawn.
    expect(readable(screen({}, null))).not.toContain("Removed the background scheduler.");
    // Engine text stays text.
    expect(screen({}, uninstallLine({ stage: "failed", message: HOSTILE }))).not.toContain("<img");
  });

  test("while a removal runs, it says how long that takes — the Uninstall screen's sentence", () => {
    const running = raw(ScheduleUninstall, { scheduleState: state({ phase: "waiting-for-wake" }, "Waiting"), os: "macos", stage: "running" });
    expect(UNINSTALL_TIME_SENTENCE).toBe("This usually takes under a minute, and at most about two.");
    expect(readable(running)).toContain(UNINSTALL_TIME_SENTENCE);
    const b = /<button([^>]*)>\s*Working…\s*<\/button>/.exec(running);
    expect(b).not.toBeNull();
    expect(b?.[1] ?? "").toMatch(/(?:^|\s)disabled(?=[\s=/]|$)/);
    // The button keeps its label — the one both refusal texts point at — whenever nothing runs.
    for (const stage of ["idle", "done", "failed", "foreign-owner"]) {
      const body = raw(ScheduleUninstall, { scheduleState: state({ phase: "waiting-for-wake" }, "Waiting"), os: "macos", stage });
      expect([stage, readable(body).includes(UNINSTALL_TIME_SENTENCE)]).toEqual([stage, false]);
      expect([stage, buttons(body)[0]?.text]).toEqual([stage, REMOVE]);
    }
  });

  test("where the line lives and when it is cleared: App holds it, Schedule passes it down, and an uninstall starting, an install starting or a route change clears it", async () => {
    const app = await src("App.svelte");
    const script = app.slice(0, app.indexOf("</script>"));
    // App holds it, as it holds `verifyTrigger` (a rune in Schedule.svelte would collide with its
    // `state` prop), and nothing else in App writes it but the three events and the ended attempt.
    expect(script).toContain("let removalLine = $state<UninstallLine | null>(null);");
    const writes = [...app.matchAll(/(?<!let )(?<![\w.])removalLine = ([^;)]*)/g)].map((m) => m[1]);
    // The route effect, an install starting, a removal starting — and an ended removal, which sets it.
    expect(writes).toEqual(["null", "null", "null", "line"]);
    // A route change: an effect that reads `route` and clears the line.
    expect(script).toMatch(
      /\$effect\(\(\) => \{\s*(?:\/\/[^\n]*\n\s*)*void route;\s*removalLine = null;\s*removalFailed = false;\s*removalInProgress = false;\s*\}\);/,
    );
    // Either component starting, each through its own callback since M9 round 2; an ended attempt sets the
    // line and refreshes, so the screen redraws from the engine's state.
    const mount = app.slice(app.indexOf("<Schedule"), app.indexOf("/>", app.indexOf("<Schedule")));
    expect(mount).toContain("{removalLine}");
    expect(mount).toMatch(INSTALL_STARTED);
    expect(mount).toMatch(REMOVAL_STARTED);
    expect(mount).toMatch(REMOVAL_ENDED);

    const schedule = await src("routes/Schedule.svelte");
    // No rune declared there (its comments name `$state(...)`; a declaration is what would collide).
    expect(schedule).not.toMatch(/=\s*\$state\b/);
    // Every install control gets the install-start callback, the removal its own; the removal reports its end.
    expect(schedule.match(/<ScheduleInstall\b[^>]*?onstarted=\{oninstallstarted\}/g)?.length).toBe(3);
    expect(schedule.match(/<ScheduleInstall\b/g)?.length).toBe(3);
    expect(schedule).toMatch(
      /<ScheduleUninstall scheduleState=\{state\} \{os\} onstarted=\{onremovalstarted\} onfinished=\{onremovalended\} \/>/,
    );
    // The line is drawn AFTER the remove control's block closes — never inside it.
    const ruleAt = schedule.indexOf(REMOVE_RULE);
    const blockEnd = schedule.indexOf("{/if}", ruleAt);
    const lineAt = schedule.indexOf("{#if removalLine !== null}");
    expect([ruleAt > -1, blockEnd > ruleAt, lineAt > blockEnd]).toEqual([true, true, true]);
    expect(schedule.slice(ruleAt, blockEnd)).not.toContain("removalLine");
    // Checkpoint M6b (F4): and OUTSIDE the `state === null` guard — after the `{/if}` that closes it, before
    // the access panel — so a refresh whose status read failed does not hide it either. Since M9 round 1 the
    // remove control's block is outside that guard too, between it and the line.
    const guardAt = schedule.indexOf("{#if state === null}");
    const guardEnd = closeOf(schedule, guardAt);
    expect([guardAt > -1, ruleAt > guardEnd, lineAt > guardEnd, lineAt < schedule.indexOf("<ScheduleAccess")]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(schedule.slice(lineAt, closeOf(schedule, lineAt))).not.toContain("state.");

    // The components: each says it started before it calls the engine; the removal reports every ended
    // attempt — the engine's answer, an IPC error or busy refusal, and "Keep the existing one".
    const uninstall = await src("lib/ScheduleUninstall.svelte");
    const remove = uninstall.slice(uninstall.indexOf("async function remove("), uninstall.indexOf("</script>"));
    expect(remove.indexOf("onstarted?.();")).toBeGreaterThan(-1);
    expect(remove.indexOf("onstarted?.();")).toBeLessThan(remove.indexOf("await scheduleUninstall("));
    expect(remove).toMatch(/const next = afterUninstall\(outcome, takeOver\);\s*settle\(next\);/);
    expect(remove).toMatch(/catch \(e\) \{[\s\S]*?settle\(\{ stage: "failed", message: describeFailure\(e\) \}\);/);
    expect(uninstall).toMatch(
      /function settle\(next: StageResult\): void \{\s*stage = next\.stage;\s*message = next\.message;\s*const ended = uninstallLine\(next\);\s*if \(ended !== null\) onfinished\?\.\(ended\);\s*\}/,
    );
    expect(uninstall).toContain("onkeep={() => settle(afterKeep())}");
    const install = await src("lib/ScheduleInstall.svelte");
    const run = install.slice(install.indexOf("async function install("), install.indexOf("</script>"));
    expect(run.indexOf("onstarted?.();")).toBeGreaterThan(-1);
    expect(run.indexOf("onstarted?.();")).toBeLessThan(run.indexOf("await scheduleInstall("));
  });

  test("checkpoint M6b (F2): a failed removal keeps its Try again when the refresh finds nothing on disk and registration unknown — the control stays mounted until an attempt ends otherwise or the route changes (spec 3.4.6)", async () => {
    // A registration-only removal (no files, registered), taken over, fails at exit 3 …
    const stderr = "The background scheduler is still registered after 30 seconds.\nThis attempt removed nothing.\n";
    const exit3 = {
      operation: "schedule-uninstall",
      outcome: { kind: "failed", reason: "exit-3" },
      exitCode: 3,
      payload: null,
      stdout: "",
      stderr,
    } as EngineOutcome;
    const ended = uninstallLine(afterUninstall(exit3, true));
    expect(ended).toEqual({ kind: "failed", line: stderr, closing: null });
    expect(buttons(screen({ registered: true }, null)).map((b) => b.text)).toContain(REMOVE);
    // … and the refresh App starts then finds nothing on disk and cannot say whether anything is
    // registered. On its own that state shows no remove control (spec 3.4.1) …
    const refreshed: Partial<ScheduleState> = { registered: null, registeredReason: "timeout" };
    expect(buttons(screen(refreshed, ended)).map((b) => b.text)).not.toContain(REMOVE);
    // … but with App's failed flag the control stays, beside the line.
    const after = raw(Schedule, {
      state: state({ phase: "not-scheduled" }, "Scheduler not installed", { ...nothing, ...refreshed }),
      removalLine: ended,
      removalFailed: true,
    });
    expect(buttons(after).map((b) => b.text)).toEqual(["Install / repair scheduler", REMOVE]);
    expect(pres(after)).toContain(stderr);
    // A flag with something on disk changes nothing; no flag and a done line: no control (the rule as before).
    expect(buttons(raw(Schedule, { state: state({ phase: "not-scheduled" }, "x", { ...nothing, unitPresent: true }), removalFailed: true })).filter((b) => b.text === REMOVE)).toHaveLength(1);
    const removed = uninstallLine({ stage: "done", message: "Removed the background scheduler." });
    expect(buttons(raw(Schedule, { state: state({ phase: "not-scheduled" }, "x", nothing), removalLine: removed, removalFailed: false })).map((b) => b.text)).not.toContain(REMOVE);

    // The control is the SAME instance across that refresh — an `{#if}` keeps a branch whose condition stays
    // true — so it is still at its failed stage, which draws Try again; and Try again repeats the attempt,
    // take-over included. (SSR runs no click handler: the stage is passed to draw it.)
    const failedControl = buttons(raw(ScheduleUninstall, { scheduleState: state({ phase: "not-scheduled" }, "x", { ...nothing, ...refreshed }), os: "macos", stage: "failed" }));
    expect(failedControl.map((b) => b.text)).toEqual([REMOVE, "Try again"]);
    const uninstall = await src("lib/ScheduleUninstall.svelte");
    expect(uninstall).toMatch(/onclick=\{\(\) => remove\(lastTakeOver\)\}>Try again<\/button>/);
    expect(uninstall).toMatch(/async function remove\(takeOver: boolean\): Promise<void> \{[\s\S]*?lastTakeOver = takeOver;/);
    const schedule = await src("routes/Schedule.svelte");
    expect(schedule).toContain(REMOVE_RULE);
    expect(schedule).toMatch(/\n    removalFailed = false,\n/);

    // App: the flag is set from the attempt's END, and cleared only by an attempt that did not fail, a route
    // change or — M9 round 2 — an INSTALL starting, and — M9 round 3 — an install ENDING; NOT by a removal's
    // start, which clears the line (spec 3.4.4): Try again starts from this very control, and clearing the
    // flag there would unmount it mid-run and lose Try again again on a second failure.
    const app = await src("App.svelte");
    const script = app.slice(0, app.indexOf("</script>"));
    expect(script).toContain("let removalFailed = $state(false);");
    const writes = [...app.matchAll(/(?<!let )(?<![\w.])removalFailed = ([^;)]*)/g)].map((m) => m[1]);
    // The route effect, an install starting, an install ending, and a removal's end.
    expect(writes).toEqual(["false", "false", "false", 'line.kind === "failed"']);
    const mount = app.slice(app.indexOf("<Schedule"), app.indexOf("/>", app.indexOf("<Schedule")));
    expect(mount).toContain("{removalFailed}");
    expect(mount).toMatch(REMOVAL_STARTED);
    expect(mount.slice(mount.search(REMOVAL_STARTED), mount.indexOf("onremovalended="))).not.toContain("removalFailed");
  });

  test("M9 round 2: the remove control stays mounted from an attempt's START until it ENDS — while it runs, and while its foreign-owner dialog is open — whatever a refresh reads meanwhile", async () => {
    // A refresh during an attempt that reads no state, or nothing on disk with registration unknown: on its
    // own, no remove control (spec 3.4.1) …
    const refreshed: Partial<ScheduleState> = { registered: null, registeredReason: "timeout" };
    expect(buttons(raw(Schedule, { state: null })).map((b) => b.text)).not.toContain(REMOVE);
    expect(buttons(screen(refreshed, null)).map((b) => b.text)).not.toContain(REMOVE);
    // … but with App's in-progress flag the control stays — the same instance, at its running stage or with
    // its dialog open — under "Checking…" or beside the install control.
    const noState = raw(Schedule, { state: null, removalInProgress: true });
    expect(readable(noState)).toContain("Checking…");
    expect(buttons(noState).map((b) => b.text)).toEqual([REMOVE]);
    const nothingOnDisk = raw(Schedule, {
      state: state({ phase: "not-scheduled" }, "Scheduler not installed", { ...nothing, ...refreshed }),
      removalInProgress: true,
    });
    expect(buttons(nothingOnDisk).map((b) => b.text)).toEqual(["Install / repair scheduler", REMOVE]);
    const schedule = await src("routes/Schedule.svelte");
    expect(schedule).toContain(REMOVE_RULE);
    expect(schedule).toMatch(/\n    removalInProgress = false,\n/);

    // "Ends" is exactly when the control reports a line: done or failed. The foreign-owner dialog reports
    // none (it asks), so an attempt whose dialog is open is still in progress.
    expect(uninstallLine({ stage: "foreign-owner", message: "not this app's" })).toBeNull();
    expect(uninstallLine({ stage: "running", message: "" })).toBeNull();
    expect(uninstallLine({ stage: "failed", message: "x" })?.kind).toBe("failed");
    expect(uninstallLine(afterKeep())?.kind).toBe("done");

    // App: set by the removal's start, cleared by its end (success and failure alike — a failure keeps the
    // control through `removalFailed` instead), by an install starting and by a route change. Every attempt
    // — the first, a take-over, Try again — starts through `remove()`, which calls `onstarted` first.
    const app = await src("App.svelte");
    const script = app.slice(0, app.indexOf("</script>"));
    expect(script).toContain("let removalInProgress = $state(false);");
    const writes = [...app.matchAll(/(?<!let )(?<![\w.])removalInProgress = ([^;)]*)/g)].map((m) => m[1]);
    expect(writes).toEqual(["false", "false", "true", "false"]);
    const mount = app.slice(app.indexOf("<Schedule"), app.indexOf("/>", app.indexOf("<Schedule")));
    expect(mount).toContain("{removalInProgress}");
    expect(mount).toMatch(REMOVAL_STARTED);
    expect(mount).toMatch(REMOVAL_ENDED);
    const uninstall = await src("lib/ScheduleUninstall.svelte");
    expect(uninstall.match(/onclick=\{\(\) => remove\(/g)?.length).toBe(2);
    expect(uninstall).toContain("ontakeover={() => remove(true)}");
  });

  test("M9 round 2: an INSTALL starting resets the remove control — its failed stage and App's failed flag — so no bare Try again sits beside a new scheduler; a removal's own start resets neither (spec 16 M6b(1))", async () => {
    const schedule = await src("routes/Schedule.svelte");
    // The control is keyed on App's counter, inside its rule: a bump remounts it at `idle` — no Try again, no
    // remembered take-over — while the rest of the screen stays.
    const ruleAt = schedule.indexOf(REMOVE_RULE);
    const block = schedule.slice(ruleAt, closeOf(schedule, ruleAt));
    expect(block).toMatch(
      /\{#key removalReset\}\s*<ScheduleUninstall scheduleState=\{state\} \{os\} onstarted=\{onremovalstarted\} onfinished=\{onremovalended\} \/>\s*\{\/key\}/,
    );
    expect(schedule.match(/\{#key\s+\w/g)?.length).toBe(1);
    expect(schedule).toMatch(/\n    removalReset = 0,\n/);
    // Only the install controls carry the install-start callback; the removal's own start is a different one.
    expect(schedule.match(/onstarted=\{oninstallstarted\}/g)?.length).toBe(3);
    expect(schedule.match(/onstarted=\{onremovalstarted\}/g)?.length).toBe(1);

    // App bumps the counter from an install's START (clearing the failed and in-progress flags too) and — M9
    // round 3 — from its END (clearing the failed flag); never from a removal.
    const app = await src("App.svelte");
    const script = app.slice(0, app.indexOf("</script>"));
    expect(script).toContain("let removalReset = $state(0);");
    expect([...app.matchAll(/(?<![\w.])removalReset \+= 1/g)].length).toBe(2);
    const mount = app.slice(app.indexOf("<Schedule"), app.indexOf("/>", app.indexOf("<Schedule")));
    expect(mount).toContain("{removalReset}");
    expect(mount).toMatch(INSTALL_STARTED);
    expect(mount).toMatch(INSTALL_ENDED);

    // M9 round 3: what a FRESH mount of the screen draws, for orientation only — a server render has no earlier
    // instance to keep, so it is always at `idle` whatever the counter, and these lines cannot show a remount.
    // The remount itself is pinned by the `{#key removalReset}` source match above.
    expect(buttons(raw(Schedule, { state: state({ phase: "not-scheduled" }, "x", nothing), removalFailed: false, removalReset: 1 })).map((b) => b.text)).not.toContain(REMOVE);
    const fresh = buttons(raw(Schedule, { state: state({ phase: "not-scheduled" }, "x", { ...nothing, unitPresent: true }), removalReset: 1 })).map((b) => b.text);
    expect(fresh).toContain(REMOVE);
    expect(fresh).not.toContain("Try again");
  });

  test("M9 round 3: an install attempt ENDING — whatever came of it — clears App's failed flag and remounts the remove control at idle, so a Try again left by a removal refused Busy during the install never repeats against the new scheduler; the outcome line stays (spec 3.4.4)", async () => {
    // The component reports the end of every attempt once its call returns — done, failed, the foreign-owner
    // stage, or a thrown error (a Busy refusal) — while `onfinished` stays success-only (it arms the verify kick).
    const install = await src("lib/ScheduleInstall.svelte");
    const run = install.slice(install.indexOf("async function install("), install.indexOf("</script>"));
    expect(run).toMatch(/\} finally \{\s*onended\?\.\(\);\s*\}\s*\}\s*$/);
    expect(run.indexOf("onended?.();")).toBeGreaterThan(run.indexOf("await scheduleInstall("));
    expect(run.match(/onended\?\.\(\);/g)?.length).toBe(1);
    expect(run).toContain("if (armsVerify(next.stage)) onfinished?.(outcome);");
    expect(armsVerify("done")).toBe(true);
    for (const stage of ["failed", "foreign-owner", "idle", "running"] as const) expect(armsVerify(stage)).toBe(false);
    // Every install control on the screen reports its end; the screen's default does nothing.
    const schedule = await src("routes/Schedule.svelte");
    expect(schedule.match(/<ScheduleInstall\b[^>]*?onended=\{oninstallended\}/g)?.length).toBe(3);
    expect(schedule).toMatch(/\n    oninstallended = \(\) => \{\},\n/);
    // App: the failed flag cleared and the control reset — and nothing else: the outcome line (spec 3.4.4) and
    // the in-progress flag are left as they are.
    const app = await src("App.svelte");
    const mount = app.slice(app.indexOf("<Schedule"), app.indexOf("/>", app.indexOf("<Schedule")));
    expect(mount).toMatch(INSTALL_ENDED);
    expect(mount.match(/oninstallended=/g)?.length).toBe(1);
  });

  test("M9 round 3: while the foreign-owner dialog asks, the row's button is disabled — Keep and Take over are the only ways out, and both report an end", async () => {
    const scheduleState = state({ phase: "not-scheduled" }, "x", { ...nothing, unitPresent: true });
    const drawn = (stage: string) =>
      [...raw(ScheduleUninstall, { scheduleState, os: "macos", stage }).matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => ({
        disabled: /(?:^|\s)disabled(?=[\s=/]|$)/.test(m[1] ?? ""),
        text: readable(m[2] ?? "").trim(),
      }));
    const asking = drawn("foreign-owner");
    expect(asking.find((b) => b.text === REMOVE)?.disabled).toBe(true);
    // The dialog's two buttons, Keep first, are the ones that can be pressed.
    const exits = asking.filter((b) => b.text !== REMOVE);
    expect(exits.length).toBe(2);
    expect(exits.map((b) => b.disabled)).toEqual([false, false]);
    // Every other stage but running leaves the row's button enabled, as before.
    for (const stage of ["idle", "done", "failed"]) {
      expect([stage, drawn(stage).find((b) => b.text === REMOVE)?.disabled]).toEqual([stage, false]);
    }
    expect(drawn("running").find((b) => b.text === "Working…")?.disabled).toBe(true);
    // Both exits end the attempt: Keep settles "Kept — nothing was removed." (a line, so App hears the end), and
    // Take over starts a new attempt, which ends through `settle` like every other.
    const uninstall = await src("lib/ScheduleUninstall.svelte");
    expect(uninstall).toContain('disabled={stage === "running" || stage === "foreign-owner"}');
    expect(uninstall).toContain("onkeep={() => settle(afterKeep())}");
    expect(uninstall).toContain("ontakeover={() => remove(true)}");
    expect(uninstallLine(afterKeep())?.kind).toBe("done");
  });

  test("M9 round 1: a failed removal keeps its Try again when the refresh then has NO state at all — the control's block sits outside the `state === null` guard (spec 16 M6b(1))", async () => {
    const stderr = "The background scheduler is still registered after 30 seconds.\nThis attempt removed nothing.\n";
    const ended = uninstallLine({ stage: "failed", message: stderr });
    expect(ended).toEqual({ kind: "failed", line: stderr, closing: null });
    // The refresh after the failed attempt could not read the engine's state: the screen has none. With App's
    // failed flag the remove control is still drawn, beside the line, under "Checking…".
    const after = raw(Schedule, { state: null, error: "`status` failed: boom", removalLine: ended, removalFailed: true });
    expect(readable(after)).toContain("Checking…");
    expect(buttons(after).map((b) => b.text)).toEqual([REMOVE]);
    expect(pres(after)).toContain(stderr);
    // Without the flag, no state draws no control: there is nothing to key it on (spec 3.4.1).
    expect(buttons(raw(Schedule, { state: null, removalLine: ended, removalFailed: false })).map((b) => b.text)).not.toContain(REMOVE);
    // The control with no state, at its failed stage, draws Try again (SSR runs no click handler: the stage is
    // passed to draw it) …
    const failedControl = buttons(raw(ScheduleUninstall, { scheduleState: null, os: "macos", stage: "failed" }));
    expect(failedControl.map((b) => b.text)).toEqual([REMOVE, "Try again"]);
    // … and it is the SAME instance across the refresh: its `{#if}` opens after the `{/if}` closing the
    // `state === null` guard, so a state going null never unmounts it while the flag holds — and it is the
    // only remove control on the screen.
    const schedule = await src("routes/Schedule.svelte");
    const guardAt = schedule.indexOf("{#if state === null}");
    const guardEnd = closeOf(schedule, guardAt);
    const ruleAt = schedule.indexOf(REMOVE_RULE);
    expect([guardAt > -1, ruleAt > -1, ruleAt > guardEnd]).toEqual([true, true, true]);
    expect(schedule.slice(ruleAt, closeOf(schedule, ruleAt))).toContain("<ScheduleUninstall scheduleState={state} ");
    expect(schedule.match(/<ScheduleUninstall\b/g)?.length).toBe(1);
  });

  test("checkpoint M6b (F4): the line is drawn while the screen has no state — a refresh whose status read failed does not hide it (spec 3.4.4)", () => {
    const failedText = "  The background scheduler is still registered after 30 seconds.\n";
    const failed = uninstallLine({ stage: "failed", message: failedText });
    const body = raw(Schedule, { state: null, error: "`status` failed: boom", removalLine: failed });
    expect(readable(body)).toContain("Checking…");
    expect(pres(body)).toContain(failedText);
    const removed = uninstallLine({ stage: "done", message: "Removed the background scheduler." });
    expect(readable(raw(Schedule, { state: null, removalLine: removed }))).toContain("Removed the background scheduler.");
    // No line: nothing drawn.
    expect(readable(raw(Schedule, { state: null, removalLine: null }))).not.toContain("Removed the background scheduler.");
  });
});

describe("QuitDialog.svelte", () => {
  const dialog = {
    title: "Quit Daily Briefing?",
    body: "Quitting does not stop your briefings — the body from Rust.",
    offerLabel: "Switch engine notifications to auto",
    offerAvailable: false,
    offerUnavailableReason: "The engine has no usable config to change right now.",
    scheduleLabel: null as string | null,
    confirmLabel: "Quit",
    cancelLabel: "Keep running",
  };

  test("renders the Rust-owned copy, and no control for an offer that cannot be taken", () => {
    const body = html(QuitDialog, { dialog, oncancel: () => {} });
    for (const text of [dialog.title, dialog.body, dialog.offerLabel, dialog.offerUnavailableReason]) {
      expect(body).toContain(text);
    }
    const b = buttons(body);
    expect(b.map((x) => x.text)).toEqual(["Keep running", "Quit"]);
    expect(b[0]?.cls).toContain("primary");
  });

  test("B5: where Rust says the offer can work, it is a button; its label is Rust's", () => {
    const body = html(QuitDialog, {
      dialog: { ...dialog, offerAvailable: true, offerUnavailableReason: null },
      oncancel: () => {},
    });
    const b = buttons(body);
    expect(b.map((x) => x.text)).toEqual([dialog.offerLabel, "Keep running", "Quit"]);
    expect(b[0]?.cls).toContain("offer-button");
    // Primary stays on "Keep running": the offer is not the default action.
    expect(b[1]?.cls).toContain("primary");
    expect(body).not.toContain(dialog.offerUnavailableReason);
    // …and the button reaches the save path, not a stub.
    return Bun.file(new URL("../src/lib/QuitDialog.svelte", import.meta.url))
      .text()
      .then((source) => {
        expect(source).toContain("configOfferNotifyAuto()");
        expect(source).toContain("onclick={takeOffer}");
      });
  });

  test("review round 1: the offer is a button only where it would change something", () => {
    const available = { ...dialog, offerAvailable: true, offerUnavailableReason: null };
    const labels = (offer: unknown) =>
      buttons(html(QuitDialog, { dialog: available, offer, oncancel: () => {} })).map((x) => x.text);
    expect(labels({ kind: "offer", current: "off" })).toEqual([dialog.offerLabel, "Keep running", "Quit"]);
    expect(labels({ kind: "unknown" })).toEqual([dialog.offerLabel, "Keep running", "Quit"]);
    for (const kind of ["checking", "already", "custom"]) {
      expect(labels({ kind })).toEqual(["Keep running", "Quit"]);
    }
    const already = html(QuitDialog, { dialog: available, offer: { kind: "already" }, oncancel: () => {} });
    expect(already).toContain('already set to "auto"');
    const invalid = html(QuitDialog, {
      dialog: available,
      offer: { kind: "offer", current: "invalid" },
      oncancel: () => {},
    });
    expect(invalid).toContain("currently posts nothing");
    // Where Rust withholds the offer, the config's state changes nothing.
    expect(buttons(html(QuitDialog, { dialog, offer: { kind: "offer", current: "off" }, oncancel: () => {} })).map((x) => x.text)).toEqual([
      "Keep running",
      "Quit",
    ]);
  });

  test("R2-11: the Schedule screen is offered only when the Rust copy offers it", () => {
    const offered = buttons(
      html(QuitDialog, {
        dialog: { ...dialog, scheduleLabel: "Open Schedule" },
        oncancel: () => {},
        onschedule: () => {},
      }),
    ).map((x) => x.text);
    expect(offered).toEqual(["Open Schedule", "Keep running", "Quit"]);
    // No label, or nowhere to go: no button.
    expect(
      buttons(html(QuitDialog, { dialog, oncancel: () => {}, onschedule: () => {} })).map((x) => x.text),
    ).toEqual(["Keep running", "Quit"]);
    expect(
      buttons(
        html(QuitDialog, { dialog: { ...dialog, scheduleLabel: "Open Schedule" }, oncancel: () => {} }),
      ).map((x) => x.text),
    ).toEqual(["Keep running", "Quit"]);
  });

  test("before setup is finished (no offer label from Rust) the notice is plain — no offer section, no Schedule button", () => {
    // Phase E final harden: Rust's `QuitCopy::NotSetUp` sends `offerLabel: null` and no
    // `scheduleLabel`; a reason may still ride along (the field's never-null rule) but must not show.
    const notSetUp = {
      ...dialog,
      body: "Setup isn't finished yet. You can quit now — setup will be offered again the next time you open Daily Briefing.",
      offerLabel: null,
      offerAvailable: false,
      offerUnavailableReason: "Setup is not finished, so there is no engine setting to change yet.",
      scheduleLabel: null,
    };
    // Even with a config state that would make the offer a button, and a Schedule handler wired.
    const body = html(QuitDialog, {
      dialog: notSetUp,
      offer: { kind: "offer", current: "off" },
      oncancel: () => {},
      onschedule: () => {},
    });
    expect(body).toContain(notSetUp.body);
    expect(body).not.toContain('class="offer');
    expect(body).not.toContain(notSetUp.offerUnavailableReason);
    expect(body).not.toContain("Switch engine notifications");
    expect(body).not.toContain("currently posts nothing");
    expect(buttons(body).map((x) => x.text)).toEqual(["Keep running", "Quit"]);
    // prove-it 3b: the same fixture WITH a label does render the section, so the absence above is
    // the null label's doing.
    const withOffer = html(QuitDialog, { dialog: { ...notSetUp, offerLabel: "Switch engine notifications to auto" }, oncancel: () => {} });
    expect(withOffer).toContain('class="offer');
  });

  test("the dialog adds no wording of its own about what quitting does", async () => {
    const source = await Bun.file(new URL("../src/lib/QuitDialog.svelte", import.meta.url)).text();
    const markup = source.replace(/<script[\s\S]*?<\/script>/, "").replace(/<!--[\s\S]*?-->/g, "");
    for (const claim of ["notifier", "notification", "will stop", "briefings"]) {
      expect(markup.toLowerCase()).not.toContain(claim);
    }
  });

  test("its payload stays text", () => {
    const body = html(QuitDialog, { dialog: { ...dialog, body: HOSTILE }, oncancel: () => {} });
    expect(body).not.toContain("<img");
  });
});

describe("the install flow", () => {
  const outcome = (kind: string, stderr = "", stdout = ""): EngineOutcome =>
    ({
      operation: "schedule-install",
      outcome: kind === "failed" ? { kind, reason: "exit-1" } : { kind },
      exitCode: kind === "delivered" ? 0 : kind === "configError" ? 2 : 1,
      payload: null,
      stdout,
      stderr,
    }) as EngineOutcome;

  test("exit 2 is a foreign owner ONLY when schedule status names another owner", () => {
    const refusal = "Refusing to replace a configuration somebody else set up.\n";
    expect(afterInstall(outcome("configError", refusal), false, "cli")).toEqual({
      stage: "foreign-owner",
      message: refusal.trim(),
    });
    // Any other exit-2 refusal shows the engine's words, with no take-over offered.
    for (const owner of ["app", null]) {
      expect(afterInstall(outcome("configError", "confirmation withheld"), false, owner)).toEqual({
        stage: "failed",
        message: "confirmation withheld",
      });
    }
    // A take-over that is refused again is a failure, not a loop back into the dialog.
    expect(afterInstall(outcome("configError", refusal), true, "cli").stage).toBe("failed");
  });

  test("success and failure", () => {
    expect(afterInstall(outcome("delivered", "", "installed\n"), false, null)).toEqual({
      stage: "done",
      message: "installed",
    });
    expect(afterInstall(outcome("failed", "boom\n"), false, "app")).toEqual({
      stage: "failed",
      message: "boom",
    });
    expect(afterInstall(outcome("failed", "", "only stdout"), false, "app").message).toBe(
      "only stdout",
    );
  });

  test("only a done install arms the verification loop", () => {
    // Round 1: the loop's kick runs the LIVE scheduler, so a REFUSED install must not carry that
    // side effect — the shipped wiring bumped the trigger for every completed attempt, so a
    // foreign-owner refusal opened the keep-or-take-over dialog AND kicked the CLI's live job.
    // `armsVerify` is the one place the gate lives; `ScheduleInstall` applies it to `onfinished`.
    const refusal = "Refusing to replace a configuration somebody else set up.\n";
    expect(armsVerify(afterInstall(outcome("delivered"), false, null).stage)).toBe(true);
    expect(armsVerify(afterInstall(outcome("configError", refusal), false, "cli").stage)).toBe(
      false,
    );
    expect(armsVerify(afterInstall(outcome("configError", refusal), true, "cli").stage)).toBe(
      false,
    );
    expect(armsVerify(afterInstall(outcome("failed", "boom\n"), false, "app").stage)).toBe(false);
    expect(armsVerify("idle")).toBe(false);
    expect(armsVerify("running")).toBe(false);
  });

  test("the component APPLIES the armsVerify gate to onfinished", async () => {
    // Round 2: the predicate tests above pin `armsVerify` itself, but nothing pinned that
    // `ScheduleInstall` actually applies it — mutate the guard to `|| true` and every predicate
    // test stays green while round 1's defect returns: a refused foreign-owner install firing
    // `onfinished`, whose one consumer arms the verification loop and KICKS THE LIVE SCHEDULER.
    // Source-text pin, per this file's established pattern for wiring that render() cannot reach.
    const source = await Bun.file(
      new URL("../src/lib/ScheduleInstall.svelte", import.meta.url),
    ).text();
    expect(source).toContain("if (armsVerify(next.stage)) onfinished?.(outcome);");
  });

  test("the component starts idle, with one button and no dialog", () => {
    const body = html(ScheduleInstall, { owner: "cli" });
    expect(buttons(body).map((b) => b.text)).toEqual(["Install / repair scheduler"]);
    expect(body).not.toContain("already owns");
  });

  test("its first attempt never takes over; only the dialog's second button does", async () => {
    const source = await Bun.file(new URL("../src/lib/ScheduleInstall.svelte", import.meta.url)).text();
    expect(source).toContain("<button onclick={() => install(false)}");
    expect(source.match(/install\(true\)/g)?.length).toBe(1);
    expect(source).toContain("ontakeover={() => install(true)}");
  });

  test("the foreign-owner dialog: KEEP-EXISTING first and primary, take-over second", () => {
    const body = html(ForeignOwnerDialog, {
      message: HOSTILE,
      purpose: "install the background scheduler",
      onkeep: () => {},
      ontakeover: () => {},
    });
    const b = buttons(body);
    expect(b.map((x) => x.text)).toEqual([
      "Keep the existing one",
      "Take over and install the background scheduler",
    ]);
    expect(b[0]?.cls).toContain("primary");
    expect(b[1]?.cls).toContain("danger");
    expect(body).not.toContain("<img");
    // Batch 2 (spec 3.4.3): with no `lead` — as the install flow draws it — the lead is today's.
    expect(body).toContain('<p class="lead');
    expect(body).toContain("Something else already owns the background schedule.");
  });

  test("Batch 2 (spec 3.4.3): the install flow's dialog is drawn exactly as before — no lead of its own, Keep first", async () => {
    // `lead` is optional and only the removal passes one (for a null owner); every install, repair and
    // update keeps today's dialog.
    const source = await Bun.file(new URL("../src/lib/ScheduleInstall.svelte", import.meta.url)).text();
    const dialog = /<ForeignOwnerDialog[\s\S]*?\/>/.exec(source)?.[0] ?? "";
    expect(dialog).toContain("{message}");
    expect(dialog).not.toContain("lead");
    // Passing no lead and passing `undefined` (the removal's choice for every owner but null) draw the same.
    const props = { message: "m", purpose: "install the background scheduler", onkeep: () => {}, ontakeover: () => {} };
    expect(html(ForeignOwnerDialog, { ...props, lead: undefined })).toBe(html(ForeignOwnerDialog, props));
    // A lead that IS passed replaces today's, and only the lead.
    const withLead = html(ForeignOwnerDialog, { ...props, lead: "Another lead." });
    expect(withLead).toContain("Another lead.");
    expect(withLead).not.toContain("Something else already owns the background schedule.");
    expect(withLead.replace("Another lead.", "Something else already owns the background schedule.")).toBe(
      html(ForeignOwnerDialog, props),
    );
  });
});
