/**
 * Provider fallback (spec §6, P3-M6-T2): the Schedule screen's older-background-engine warning.
 *
 * Rust decides WHETHER it shows (`schedule_state::older_engine_warning`, pinned in
 * `src-tauri/tests/schedule_state.rs`: valid entries only, semver, the lower-of rule, the sentinel).
 * What only a render can pin, and this file does: the warning names the MEASURED engine version
 * (`scheduledEngineVersion`), not the install-time record; it shows for both owners; and a
 * CLI-owned schedule is offered no install or take-over action — words only — so it can never
 * route into the foreign-owner flow, which belongs to install refusals.
 */
import { describe, expect, test } from "bun:test";
import { render } from "svelte/server";

import Schedule from "../src/routes/Schedule.svelte";
import { olderEngineRemedy } from "../src/lib/install-flow";
import type { ScheduleState } from "../src/lib/state";

function state(extra: Partial<ScheduleState> = {}): ScheduleState {
  return {
    phase: { phase: "waiting-for-wake" },
    statusLine: "Waiting — first wake past 07:20",
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
    engineVersion: "0.2.1",
    // The install-time RECORD says this app's version; the binary answers an older one.
    installedEngineVersion: "0.2.1",
    engineUpdateAvailable: false,
    intervalSec: 600,
    experimental: false,
    lingerState: "not-applicable",
    recordFilePresent: true,
    registeredReason: null,
    removeSteps: "Run these in a terminal (bash or zsh) inside your desktop session.",
    scheduledEngineVersion: "0.1.9",
    olderEngineWarning: true,
    ...extra,
  };
}

function html(st: ScheduleState): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(Schedule as any, { props: { state: st, os: "macos" } })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");
}

/** The warning block: from its opening tag to the next top-level block the screen draws after it
 *  (the update prompt, or the generic install control). `null` when the screen has none. */
function warning(body: string): string | null {
  // Svelte appends its scoping class (`svelte-<hash>`) to every styled element's class list.
  const start = /<div class="prompt older-engine(?: svelte-\w+)?">/.exec(body);
  if (start === null) return null;
  const rest = body.slice(start.index + start[0].length);
  const end = /<div class="(?:prompt|actions)(?: svelte-\w+)?">/.exec(rest);
  if (end === null) throw new Error(`the warning block has no end in: ${body}`);
  return rest.slice(0, end.index);
}

function buttons(body: string): string[] {
  return [...body.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => (m[1] ?? "").trim());
}

describe("the older-background-engine warning (spec §6)", () => {
  test("no warning when Rust says none", () => {
    expect(warning(html(state({ olderEngineWarning: false })))).toBeNull();
  });

  test("it names the MEASURED version, not the install-time record", () => {
    const block = warning(html(state()));
    expect(block).not.toBeNull();
    expect(block).toContain("the background engine is version 0.1.9,");
    // The record (0.2.1) is not what the warning reads.
    expect(block).not.toContain("0.2.1");
  });

  test("an app-owned schedule is offered this app's update — the screen's one update control", () => {
    const body = html(state({ owner: "app" }));
    const block = warning(body)!;
    expect(block).toContain("Updating the background engine fixes this.");
    expect(block).not.toContain("installed from the command line");
    // The control is the shared update prompt's, right after the warning; there is exactly one.
    expect(buttons(body).filter((b) => b === "Update background engine")).toEqual(["Update background engine"]);
    // With the warning off and no version skew, there is none.
    expect(buttons(html(state({ owner: "app", olderEngineWarning: false })))).not.toContain(
      "Update background engine",
    );
  });

  test("a CLI-owned schedule gets the warning as words only: no install, no take-over", () => {
    const body = html(state({ owner: "cli", invoker: "cli" }));
    const block = warning(body);
    expect(block).not.toBeNull();
    expect(block).toContain("the background engine is version 0.1.9,");
    expect(buttons(block!)).toEqual([]);
    expect(block).toContain("installed from the command line");
    expect(block).toContain("daily-briefing schedule install");
    expect(block).not.toContain("Updating the background engine fixes this.");
    // Nothing on the screen offers to take the CLI's schedule over on the warning's account: no
    // update control at all (the generic "Install / repair scheduler" predates the warning).
    expect(body).not.toContain("Update background engine");
  });

  test("an unknown owner gets words only too", () => {
    const body = html(state({ owner: null, invoker: null }));
    expect(buttons(warning(body)!)).toEqual([]);
    expect(body).not.toContain("Update background engine");
  });

  // PR 3 final r5 (H6): an unknown owner is not "installed from the command line" — the app cannot tell.
  test("an unknown owner is told the app cannot tell how it was installed, not that the command line did it", () => {
    const block = warning(html(state({ owner: null, invoker: null })))!;
    expect(block).toContain("cannot tell how this schedule was installed");
    expect(block).not.toContain("This schedule was installed from the command line");
    expect(block).toContain("daily-briefing schedule install");
    expect(block).not.toContain("Updating the background engine fixes this.");
    // The CLI-owned wording is unchanged.
    expect(warning(html(state({ owner: "cli", invoker: "cli" })))).toContain("This schedule was installed from the command line");
  });

  test("with the version-skew prompt also showing, the screen has ONE update button, not two", () => {
    const body = html(state({ owner: "app", engineUpdateAvailable: true, installedEngineVersion: "0.1.0" }));
    expect(warning(body)).toContain("the background engine is version 0.1.9,");
    expect(body).toContain("The background copy of the engine is version 0.1.0");
    expect(buttons(body).filter((b) => b === "Update background engine")).toEqual(["Update background engine"]);
  });

  test("the version renders as text", () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const block = warning(html(state({ scheduledEngineVersion: hostile })))!;
    expect(block).not.toContain(hostile);
    expect(block).toContain("&lt;img");
  });
});

describe("olderEngineRemedy", () => {
  test("only an APP-owned schedule routes into this app's install", () => {
    expect(olderEngineRemedy("app")).toBe("update");
    expect(olderEngineRemedy("cli")).toBe("cli");
    // PR 3 final r5 (H6): no record owner, or one this app does not know, is its own case.
    expect(olderEngineRemedy(null)).toBe("unknown");
    expect(olderEngineRemedy("someone-else")).toBe("unknown");
  });
});
