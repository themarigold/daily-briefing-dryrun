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
  notifyAskExplanation,
  suppressedLine,
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

  test("the ask explains before anything can post, and on macOS never promises silence about macOS", () => {
    // v0.2.1 §3.5 (M3b checkpoint fix): the constant became `notifyAskExplanation(os)`; the
    // macOS answer is the old constant byte for byte (pinned exactly in the §3.5 block below).
    expect(notifyAskExplanation("macos")).toContain("Nothing is shown until");
    expect(notifyAskExplanation("macos")).toContain("macOS may ask");
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

/* ── v0.2.1 §3.5 (M3b checkpoint fix): the ask names macOS only on macOS ─────────────────────── */

describe("v0.2.1 §3.5: the notification ask follows the OS", () => {
  // v0.2.0's NOTIFY_ASK_EXPLANATION, byte for byte — macOS keeps it.
  const MACOS =
    "Daily Briefing can show a system notification when your morning briefing arrives — and when " +
    "a run fails or is blocked, so a silent morning is never a mystery. Nothing is shown until " +
    "you turn this on; macOS may ask for its own permission the first time one appears.";
  // Everywhere else the sentence ends at "until you turn this on."
  const ELSEWHERE =
    "Daily Briefing can show a system notification when your morning briefing arrives — and when " +
    "a run fails or is blocked, so a silent morning is never a mystery. Nothing is shown until " +
    "you turn this on.";
  const OFF_MAC = ["linux", "windows", "other"] as const;
  // Spec §3.5's criterion: neither "Mac" nor "macOS".
  const noMac = (text: string): boolean => !text.includes("Mac") && !text.includes("macOS");
  /** The one rendered paragraph that carries the ask. */
  const askParagraph = (body: string): string => {
    const found = [...body.matchAll(/<p[^>]*>([^<]*Nothing is shown until[^<]*)<\/p>/g)].map((m) => m[1] ?? "");
    expect(found).toHaveLength(1);
    return found[0] ?? "";
  };

  test("the function: macOS is v0.2.0's text exactly; Linux, Windows and other name no Mac", () => {
    expect(notifyAskExplanation("macos")).toBe(MACOS);
    for (const os of OFF_MAC) {
      const text = notifyAskExplanation(os);
      expect({ os, text, noMac: noMac(text) }).toEqual({ os, text: ELSEWHERE, noMac: true });
    }
    // prove-it 3b: the check can fail.
    expect(noMac(MACOS)).toBe(false);
  });

  test("AppSettings, rendered never-asked and turned-off: no Mac off macOS; macOS reads as before", () => {
    for (const enabled of [null, false] as const) {
      const lead = enabled === null ? "" : "Notifications are off. ";
      const ask = (os: string) =>
        askParagraph(html(AppSettings, { notify: status(enabled), autostart: true, onrefresh: () => {}, os }));
      for (const os of OFF_MAC) {
        const p = ask(os);
        expect({ enabled, os, p, noMac: noMac(p) }).toEqual({ enabled, os, p: lead + ELSEWHERE, noMac: true });
      }
      expect(ask("macos")).toBe(lead + MACOS);
    }
  });

  test("Schedule, rendered with the ask: no Mac off macOS; macOS reads as before", () => {
    const ask = (os: string) =>
      askParagraph(html(Schedule, { state: null, error: null, notifyAsk: true, onnotifychoice: () => {}, os }));
    for (const os of OFF_MAC) {
      const p = ask(os);
      expect({ os, p, noMac: noMac(p) }).toEqual({ os, p: ELSEWHERE, noMac: true });
    }
    expect(ask("macos")).toBe(MACOS);
  });

  test("every consumer calls notifyAskExplanation(os), and os is a required prop from App down (source pins)", () => {
    // The wizard's ask is on its last step, which a server render cannot reach (only step 1
    // renders), and Settings shows the panel's "Checking…" until a live status read — so those two
    // are held by source, like `wizard.check.ts`'s OS-wording template pins.
    const root = new URL("../src/", import.meta.url).pathname;
    const files = [...new Bun.Glob("**/*.{svelte,ts}").scanSync({ cwd: root })].sort();
    // prove-it 3b: the glob found the tree, callers and definition included.
    expect(files.length).toBeGreaterThan(20);
    for (const rel of ["lib/notify.ts", "lib/AppSettings.svelte", "routes/Schedule.svelte", "routes/Wizard.svelte"]) {
      expect(files).toContain(rel);
    }
    const src = (rel: string): string => readFileSync(`${root}${rel}`, "utf8");
    const calls: string[] = [];
    for (const rel of files) {
      const text = src(rel);
      // The old constant is gone everywhere, definition included.
      expect({ rel, old: text.includes("NOTIFY_ASK_EXPLANATION") }).toEqual({ rel, old: false });
      if (rel === "lib/notify.ts") continue;
      const n = (text.match(/notifyAskExplanation\(/g) ?? []).length;
      if (n > 0) calls.push(`${rel}:${n}`);
      // Every call passes `os` itself — never a literal platform.
      const withOs = (text.match(/notifyAskExplanation\(os\)/g) ?? []).length;
      expect({ rel, withOs }).toEqual({ rel, withOs: n });
    }
    expect(calls).toEqual(["lib/AppSettings.svelte:2", "routes/Schedule.svelte:1", "routes/Wizard.svelte:1"]);
    // REQUIRED (no `?`) with no default, in each consumer and in Settings, which passes it on.
    for (const rel of ["lib/AppSettings.svelte", "routes/Schedule.svelte", "routes/Wizard.svelte", "routes/Settings.svelte"]) {
      const text = src(rel);
      const end = text.indexOf("$props()");
      const destructure = text.slice(text.lastIndexOf("let {", end), end);
      expect({
        rel,
        required: /\n    os: Os;\n/.test(text),
        destructured: /[{,\s]os[,\s}]/.test(destructure),
        defaulted: /\bos\s*=/.test(destructure),
      }).toEqual({ rel, required: true, destructured: true, defaulted: false });
    }
    // Settings hands it to the panel; App hands it to Schedule, Settings and the Wizard.
    const tag = (text: string, open: string): string => {
      const at = text.indexOf(open);
      expect({ open, found: at >= 0 }).toEqual({ open, found: true });
      return text.slice(at, text.indexOf("/>", at));
    };
    expect(tag(src("routes/Settings.svelte"), "<AppSettings")).toContain("{os}");
    const app = src("App.svelte");
    expect(app).toContain("const os = osFromUserAgent(navigator.userAgent);");
    for (const open of ["<Schedule", "<Settings ", "<Wizard"]) {
      expect({ open, os: tag(app, open).includes("{os}") }).toEqual({ open, os: true });
    }
  });
});
