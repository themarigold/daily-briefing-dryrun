/**
 * B7 — T18's ownership predicate against the ENGINE's own `notifyArgv`, and the Settings/Schedule
 * notification-ask surfaces, rendered by the real Svelte compiler.
 *
 * ⚠ THE GOLDEN FOR THE PREDICATE IS THE ENGINE ITSELF. `notifyArgv` and `notifyPayload` are
 * imported READ-ONLY from `src/notify.ts` (the `warnFor` / `renderBriefing` discipline), and the
 * SAME fixture file the Rust port replays (`src-tauri/tests/fixtures/notify_predicate.json`,
 * `tests/notifications.rs`) is replayed here through the real function: row by row,
 * `notifyArgv(platform, { notify }, payload) !== null` must equal `expected`. One fixture file,
 * two implementations — the drift `docs/gui-seam.md` §4 warns about cannot happen silently.
 *
 * ⚠ NOTHING HERE POSTS, INVOKES, OR REACHES A PLUGIN: SSR renders markup and runs no click
 * handler (`docs/gui-seam.md` §10f); the pure wording helpers are called directly.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

// READ-ONLY import of the engine's own resolver. `notify.ts` imports `proc`/`render`/`types`,
// none of which needs a Bun-only API at import time.
import { notifyArgv, notifyPayload } from "../../src/notify";
import AppSettings from "../src/lib/AppSettings.svelte";
import {
  engineNotifyLine,
  suppressedLine,
  NOTIFY_ASK_EXPLANATION,
  type NotifyStatus,
  type Suppressed,
} from "../src/lib/notify";
import Schedule from "../src/routes/Schedule.svelte";

const HOSTILE = '<img src=x onerror="alert(1)">';

function html(component: unknown, props: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(component as any, { props })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");
}

function buttons(body: string): string[] {
  return [...body.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => (m[1] ?? "").trim());
}

/* ── the shared predicate fixtures, through the REAL notifyArgv ───────────────────────────────── */

describe("the ownership predicate fixtures match the engine's notifyArgv", () => {
  const rows = JSON.parse(
    readFileSync(new URL("../src-tauri/tests/fixtures/notify_predicate.json", import.meta.url), "utf8"),
  ) as { platform: string; os: string; notify: unknown; expected: boolean }[];

  test("the table did not shrink", () => {
    expect(rows.length).toBeGreaterThanOrEqual(12);
  });

  for (const row of rows) {
    test(`platform=${row.platform} notify=${JSON.stringify(row.notify)} → ${row.expected}`, () => {
      // The engine's payload is never empty at a real call site (`NOTIFY_TITLE` is a constant,
      // the body a template, the path a state path) — which is exactly why the Rust port needs no
      // payload: a substituted first element is empty only when the CONFIGURED element is "".
      const payload = notifyPayload("2026-09-17", "/tmp/state/briefing-latest.md");
      const resolved = notifyArgv(
        row.platform as NodeJS.Platform,
        { notify: row.notify as never },
        payload,
      );
      expect(resolved !== null).toBe(row.expected);
    });
  }
});

/* ── the wording helpers ──────────────────────────────────────────────────────────────────────── */

describe("the wording helpers", () => {
  test("who-notifies has a sentence for every probe shape", () => {
    for (const value of ["off", "auto", "custom", "invalid", "no-config", "unreadable"] as const) {
      for (const willNotify of [true, false]) {
        const line = engineNotifyLine({ value, willNotify });
        expect(line.length).toBeGreaterThan(20);
        if (willNotify) {
          // Hedged wording (deviation 119): the engine is EXPECTED to post — the copy must not
          // promise the banner appears (osascript from a launchd agent may not post at all).
          expect(line).toContain("expected to post");
          expect(line).toContain("if your setup shows its banner");
          expect(line).not.toContain("the engine posts the arrival notification and");
        }
      }
    }
    // The double-silence case §4 exists for: "auto" configured, resolving to nothing here.
    expect(engineNotifyLine({ value: "auto", willNotify: false })).toContain("posts nothing");
  });

  test("every suppression reason has its line", () => {
    for (const reason of ["never-asked", "disabled", "engine-notifies", "post-failed"] as const) {
      for (const cls of ["delivered", "failed", "blocked"] as const) {
        const s: Suppressed = { class: cls, date: "2026-09-17", reason };
        expect(suppressedLine(s)).toContain("2026-09-17");
      }
    }
    expect(
      suppressedLine({ class: "delivered", date: "2026-09-17", reason: "engine-notifies" }),
    ).toContain("engine's own notifier");
  });

  test("the ask explains before anything can post, and never promises silence about macOS", () => {
    expect(NOTIFY_ASK_EXPLANATION).toContain("Nothing is shown until");
    expect(NOTIFY_ASK_EXPLANATION).toContain("macOS may ask");
  });
});

/* ── the Settings panel ───────────────────────────────────────────────────────────────────────── */

function status(enabled: boolean | null, extra?: Partial<NotifyStatus>): NotifyStatus {
  return {
    enabled,
    engine: { value: "off", willNotify: false },
    suppressed: [],
    ...extra,
  };
}

describe("AppSettings", () => {
  test("never asked: the explained ask with Enable and Not now", () => {
    const body = html(AppSettings, { notify: status(null), autostart: true, onrefresh: () => {} });
    expect(body).toContain("Nothing is shown until");
    expect(buttons(body)).toContain("Enable notifications");
    expect(buttons(body)).toContain("Not now");
  });

  test("enabled: Turn off, and the who-notifies line", () => {
    const body = html(AppSettings, { notify: status(true), autostart: true, onrefresh: () => {} });
    expect(body).toContain("Notifications are on");
    expect(buttons(body)).toContain("Turn off");
    expect(body).toContain("this app is the notifier");
  });

  test("engine-owns: the panel says the engine is expected to post and this app stays quiet", () => {
    const body = html(AppSettings, {
      notify: status(true, { engine: { value: "auto", willNotify: true } }),
      autostart: true,
      onrefresh: () => {},
    });
    // Hedged (deviation 119) — expected to post, never a promise the banner appears.
    expect(body).toContain("expected to post");
    expect(body).toContain("if your setup shows its banner");
    expect(body).toContain("failures are still this app");
  });

  test("a suppressed firing is reported, and hostile text in its date stays literal", () => {
    const body = html(AppSettings, {
      notify: status(false, {
        suppressed: [{ class: "delivered", date: HOSTILE, reason: "disabled" }],
      }),
      autostart: true,
      onrefresh: () => {},
    });
    expect(body).toContain("&lt;img");
    expect(body).not.toContain(HOSTILE);
  });

  test("the uninstall block: no removal control before the preview; consent-off and the danger affordance pinned at the source", () => {
    // B25 round-1 fix F5. What SSR can render is the INITIAL state (no click handler runs —
    // §10f), which is exactly the fact worth pinning first: before the preview loads there is no
    // removal control at all — no consent checkbox, no execute button, only the preview trigger.
    const body = html(AppSettings, { notify: status(true), autostart: true, onrefresh: () => {} });
    expect(buttons(body)).toContain("Uninstall app…");
    expect(body).not.toContain('type="checkbox"');
    expect(body).not.toContain("Remove app pieces");
    // The consent branch exists only after a preview lands in component state, which SSR cannot
    // reach — so the consent facts are SOURCE pins (the coexistence §6 / T9 parse discipline):
    const source = readFileSync(new URL("../src/lib/AppSettings.svelte", import.meta.url), "utf8")
      .replace(/\s+/g, " ");
    // consent starts unchecked, and both open and cancel reset it
    expect(source).toContain("let consent = $state(false)");
    // the execute button's label switches with consent — through `executeLabel`, whose three
    // answers (unticked; ticked; ticked under a schedule, where engine data stays) are pinned in
    // `coexistence.check.ts` (round 3, A3-L2)…
    expect(source).toContain("{executeLabel(consent, uninstall)}");
    // …and carries the danger affordance (B6's ScheduleUninstall pattern — round-1 fix M2), with
    // the style rule that makes the class an affordance rather than a dead attribute.
    expect(source).toMatch(/<button class="danger" disabled=\{uninstallBusy\} onclick=\{\(\) => void runUninstall\(\)\}/);
    expect(source).toContain("button.danger {");
  });

  test("the autostart toggle reflects the REAL state it was handed", () => {
    const on = html(AppSettings, { notify: status(true), autostart: true, onrefresh: () => {} });
    expect(on).toContain("starts when you log in");
    expect(buttons(on)).toContain("Turn off");
    const off = html(AppSettings, { notify: status(true), autostart: false, onrefresh: () => {} });
    expect(off).toContain("does not start at login");
    expect(buttons(off)).toContain("Start at login");
    // The scheduler-keeps-working truth (R1's delegated model) is stated, not implied.
    expect(off).toContain("background scheduler still generates briefings");
  });

  test("errors are shown, and a loading state says so", () => {
    const body = html(AppSettings, {
      notify: null,
      notifyError: "the store could not be read",
      autostart: null,
      autostartError: "plugin autostart not found",
      onrefresh: () => {},
    });
    expect(body).toContain("the store could not be read");
    expect(body).toContain("plugin autostart not found");
  });
});

/* ── the Schedule ask ─────────────────────────────────────────────────────────────────────────── */

describe("the Schedule screen's ask", () => {
  const base = { state: null, error: null };

  test("shown only while never-asked, with both choices", () => {
    const asked = html(Schedule, { ...base, notifyAsk: true, onnotifychoice: () => {} });
    expect(asked).toContain("Nothing is shown until");
    expect(buttons(asked)).toContain("Enable notifications");
    expect(buttons(asked)).toContain("Not now");
    const not = html(Schedule, { ...base, notifyAsk: false });
    expect(not).not.toContain("Nothing is shown until");
  });
});
