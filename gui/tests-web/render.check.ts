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
import Schedule from "../src/routes/Schedule.svelte";
import { afterInstall, armsVerify } from "../src/lib/install-flow";
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

  // B6 (T20): the verification and removal controls key on `recordPresent`, which gui-seam §3 calls
  // authoritative — not on the phase, and not on `unitPresent`.
  test("verify and remove appear only where there is a record to act on", () => {
    const withRecord = buttons(
      html(Schedule, { state: state({ phase: "waiting-for-wake" }, "Waiting") }),
    ).map((b) => b.text);
    expect(withRecord).toContain("Check the background scheduler now");
    expect(withRecord).toContain("Remove background scheduler…");

    const noRecord = buttons(
      html(Schedule, {
        state: state({ phase: "not-scheduled" }, "Nothing scheduled", {
          recordPresent: false,
          unitPresent: false,
          registered: null,
          owner: null,
          invoker: null,
          unitPath: null,
        }),
      }),
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
  });
});
