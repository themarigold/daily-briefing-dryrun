/**
 * T13 — the History screen: the engine's date list, newest first; keyboard movement; the
 * retention line; no prune/delete affordance anywhere; and a 500-entry list against a stated
 * budget.
 *
 * ⚠ THE BUDGET IS FOR THE COMPILED COMPONENT'S SERVER RENDER, measured here — the markup the
 * webview receives for 500 dates. WebKit's own layout of that markup is not measured by this suite
 * (no browser runs in it); docs/gui-seam.md §10 records that.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { render } from "svelte/server";

import { copyPushCommand, editorChoiceSet, editorList, editorOpen, openGithub } from "../src/lib/engine";
import { readLatestSummary } from "../src/lib/engine";
import { archiveList, archivedDates, formatBytes, keepArchive, moveFrom, nextIndex } from "../src/lib/history";
import type { Snapshot } from "../src/lib/state";
import History from "../src/routes/History.svelte";

/** The appendix's budget for listing a 500-file archive. */
const BUDGET_MS = 200;

function html(dates: string[] | null, extra: Record<string, unknown> = {}): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(History as any, { props: { dates, ...extra } })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");
}

function dates(n: number): string[] {
  const out: string[] = [];
  const day = new Date(Date.UTC(2026, 8, 16));
  for (let i = 0; i < n; i++) {
    out.push(new Date(day.getTime() - i * 86_400_000).toISOString().slice(0, 10));
  }
  return out;
}

const snap = (status: unknown): Snapshot => ({
  status,
  lastSkip: null,
  schedule: null,
  scheduleStale: false,
  scheduleState: null,
  error: null,
  updatesStopped: false,
});

describe("the date list", () => {
  test("is status --json's archivedDates, newest first", () => {
    // The engine sorts ascending; the screen shows newest first.
    expect(archivedDates(snap({ archivedDates: ["2026-09-01", "2026-09-15", "2026-08-31"] }))).toEqual([
      "2026-09-15",
      "2026-09-01",
      "2026-08-31",
    ]);
    expect(archivedDates(snap({ archivedDates: ["2026-09-01", 7, null, "2026-09-01"] }))).toEqual(["2026-09-01"]);
    expect(archivedDates(snap({}))).toEqual([]);
    expect(archivedDates(snap(null))).toEqual([]);
    expect(archivedDates(null)).toEqual([]);
  });

  test("M6: an unknown list is not an empty archive, and the last known list is kept", () => {
    expect(archiveList(null)).toBeNull();
    expect(archiveList(snap(null))).toBeNull();
    expect(archiveList(snap({}))).toBeNull();
    expect(archiveList(snap({ archivedDates: [] }))).toEqual([]);
    const known = ["2026-09-15"];
    expect(keepArchive(null, null)).toBeNull();
    expect(keepArchive(known, snap(null))).toBe(known);
    expect(keepArchive(known, { ...snap(null), error: "status failed" })).toBe(known);
    expect(keepArchive(known, snap({ archivedDates: [] }))).toEqual([]);
    expect(keepArchive(null, snap({ archivedDates: ["2026-09-01"] }))).toEqual(["2026-09-01"]);
  });

  test("keys move from the FOCUSED date, not the selected one", () => {
    const list = ["2026-09-16", "2026-09-15", "2026-09-14", "2026-09-13"];
    expect(moveFrom("ArrowDown", "2026-09-15", list)).toBe("2026-09-14");
    expect(moveFrom("ArrowUp", "2026-09-13", list)).toBe("2026-09-14");
    expect(moveFrom("ArrowDown", null, list)).toBe("2026-09-16");
    expect(moveFrom("End", "2026-09-16", list)).toBe("2026-09-13");
    expect(moveFrom("Tab", "2026-09-16", list)).toBeNull();
    const source = readFileSync(new URL("../src/routes/History.svelte", import.meta.url), "utf8");
    expect(source).toContain("onkeydown={(e) => onkey(e, date)}");
  });

  test("keyboard movement", () => {
    expect(nextIndex("ArrowDown", -1, 5)).toBe(0);
    expect(nextIndex("ArrowDown", 2, 5)).toBe(3);
    expect(nextIndex("ArrowDown", 4, 5)).toBe(4);
    expect(nextIndex("ArrowUp", 0, 5)).toBe(0);
    expect(nextIndex("ArrowUp", 3, 5)).toBe(2);
    expect(nextIndex("Home", 3, 5)).toBe(0);
    expect(nextIndex("End", 0, 5)).toBe(4);
    expect(nextIndex("PageDown", 0, 500)).toBe(10);
    expect(nextIndex("PageUp", 5, 500)).toBe(0);
    expect(nextIndex("Enter", 1, 5)).toBeNull();
    expect(nextIndex("ArrowDown", -1, 0)).toBeNull();
  });

  test("file sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(8_300)).toBe("8.1 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});

describe("History.svelte", () => {
  test("says the archive is unbounded on purpose, and offers no way to remove anything", () => {
    const body = html(dates(3));
    expect(body).toContain("Every briefing is kept, on purpose");
    expect(body).toContain("about 8 KB a day");
    // v0.2.1 §4.2: Uninstall CAN remove the archive (its "Also remove the engine's data" box), so the
    // paragraph says what is true — this screen never does — and names the one place that can.
    expect(body).toContain(
      "because it is the engine's calibration record. This screen never removes any of it. Only Uninstall (Settings › This app), with \"Also remove the engine's data\" ticked, does.",
    );
    const buttons = [...body.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => (m[1] ?? "").trim());
    expect(buttons).toEqual(dates(3));
    for (const word of ["delete", "prune", "clean up", "clear", "trash"]) {
      expect(body.toLowerCase()).not.toContain(word);
    }
  });

  test("the no-prune rule is written in the code, too", () => {
    const source = readFileSync(new URL("../src/routes/History.svelte", import.meta.url), "utf8");
    expect(source).toContain("NO PRUNE, NO DELETE");
    expect(source).toContain("calibration");
  });

  test("an empty archive says so", () => {
    expect(html([])).toContain("No archived briefings yet.");
  });

  test("M6: a failed or pending read never says the archive is empty", () => {
    const failed = html(null, { error: `status failed: <img src=x onerror="alert(1)">` });
    expect(failed).not.toContain("No archived briefings yet.");
    expect(failed).toContain("status failed: &lt;img");
    expect(failed).not.toContain("<img");
    const pending = html(null);
    expect(pending).not.toContain("No archived briefings yet.");
    expect(pending).toContain("Reading the archive list");
    // The last good list stays, with the error above it and a line saying it is from before.
    const kept = html(dates(2), { error: "status failed", stale: true });
    expect(kept).toContain("status failed");
    expect(kept).toContain("from the last successful read");
    expect([...kept.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => (m[1] ?? "").trim())).toEqual(dates(2));
    // A fresh list with an unrelated error (a failed schedule read) is not called stale.
    expect(html(dates(2), { error: "schedule status failed" })).not.toContain("last successful read");
  });

  test(`500 entries render within ${BUDGET_MS} ms (measured)`, () => {
    const many = dates(500);
    html(many); // warm the compiled module
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const body = html(many);
      runs.push(performance.now() - t0);
      expect((body.match(/<button/g) ?? []).length).toBe(500);
    }
    const worst = Math.max(...runs);
    console.log(`History: 500-entry server render, worst of 5 = ${worst.toFixed(2)} ms (budget ${BUDGET_MS} ms)`);
    expect(worst).toBeLessThan(BUDGET_MS);
  });
});

/* ── no delete surface anywhere in the webview ────────────────────────────────────────────────── */

test("no command the webview invokes can remove or prune a briefing — except the five enumerated, argued exceptions", () => {
  const root = new URL("../src/", import.meta.url).pathname;
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory() ? walk(p) : /\.(ts|svelte)$/.test(n) ? [p] : [];
    });
  // ⚠ B7 widened the pattern: the autostart toggle invokes PLUGIN commands
  // (`"plugin:autostart|is_enabled"` and friends), whose names the old `[a-z_]+` class could not
  // match at all — a scan that silently cannot see a class of invocation is vacuous for it. The
  // round-1 fix widened it AGAIN, to digits and uppercase: a future command named `run2` or a
  // plugin spelled `Notification` would otherwise be invisible to this scan (and to the
  // delete-pattern assertion below), silently — the same vacuity, one renaming away.
  const invoked = walk(root).flatMap((p) =>
    [...readFileSync(p, "utf8").matchAll(/invoke(?:<[^(]*>)?\(\s*"([A-Za-z0-9_|:-]+)"/g)].map(
      (m) => m[1] ?? "",
    ),
  );
  // EVERY granted name is invoked somewhere and NOTHING else is — set equality against the
  // capability FILE ITSELF, read at test time, not a bare count (round 1: a count of 26 stays
  // green while one name is dropped and another typo'd in) and not a hand-maintained array
  // (round 2: that array was a THIRD spelling of the grant list, and removing a grant while the
  // webview still invoked it stayed green here). Derivation: an app command's permission is
  // `allow-<name in kebab>` (`build.rs`'s ACL manifest generates exactly that spelling per
  // command), and the autostart plugin's `autostart:allow-<cmd>` grants are invoked as
  // `plugin:autostart|<cmd>`. `core:event:*` is excluded: those two grants serve
  // `@tauri-apps/api/event`'s `listen()` and its unlisten fn, which invoke
  // `plugin:event|listen`/`unlisten` from inside the library — never from this repo's sources,
  // so this scan cannot see them (they are pinned Rust-side by tests/capability.rs instead).
  const capability = JSON.parse(
    readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"),
  ) as { permissions: string[] };
  const GRANTED = capability.permissions
    .filter((p) => !p.startsWith("core:event:"))
    .map((p) => {
      if (p.startsWith("autostart:allow-")) {
        return `plugin:autostart|${p.slice("autostart:allow-".length).replaceAll("-", "_")}`;
      }
      if (p.startsWith("allow-")) {
        return p.slice("allow-".length).replaceAll("-", "_");
      }
      throw new Error(`unrecognised capability entry shape: ${p} — teach this derivation its spelling`);
    });
  expect(GRANTED.length).toBeGreaterThan(0);
  expect(new Set(invoked)).toEqual(new Set(GRANTED));
  // ⚠ ONE ENUMERATED EXCEPTION, not a loosened pattern (B8): `cli_shim_remove` removes the app's
  // OWN /usr/local/bin symlink — the Settings action's reversibility — and can touch no briefing,
  // archive or engine file: it takes no operand, and `cli_shim::classify` refuses anything whose
  // target is not the managed engine copy's name (pinned by `tests/cli_shim.rs`). Any OTHER
  // deletion-shaped name still fails here and must argue its own way in.
  //
  // (B25): `uninstall_execute` is the SECOND exception, and the honest one — its name does not
  // match the pattern below, but behind its one explicit consent boolean it CAN remove the
  // briefing archive and log, because that is what an uninstall is (appendix T25: the consented
  // leg reuses scripts/uninstall.sh's exact bounded list, pinned by set-equality against a
  // test-time parse of the script in `tests/uninstall.rs`; the consent wording must NAME the
  // archive — `coexistence.check.ts` pins it). Without the flag it touches nothing of the
  // engine's. It is listed so this test's claim stays true as stated, not because the pattern
  // catches it.
  //
  // (v0.3.0, plan M8): `calendar_link_remove` is the THIRD, and it removes no briefing either: its one
  // operand is a link id the Rust grammar admits (`^[a-z0-9][a-z0-9-]{0,31}$`, `macos` reserved — no
  // separator, no dot), and it removes exactly `<state>/calendar/links/<id>.url` — the secret link
  // file the app itself wrote (a symlink there is unlinked, never followed; a folder is refused) —
  // and that id's entry in `calendar.links`, through the config-save path. It cannot name the
  // archive, a briefing or any other file (pinned by `src-tauri/tests/calendar.rs`). Removing a link
  // the user asked to disconnect is the point: leaving the secret behind would be the defect.
  //
  // (provider fallback PR 3, P3-M1): `engine_provider_key_delete` is the FOURTH, and it removes no
  // briefing: it deletes one of the app's own stored API KEYS. Its one operand is a key id Rust admits
  // only as `k-` and 12 lowercase hex digits (`engine.rs` `key_id`, the engine's `KEY_ID_RE`) — no
  // separator, no dot, no path. The engine removes only a Keychain item under the app's own service,
  // or off macOS the app-shaped `k-<12 hex>.key` file and its temps in `<state>/keys/` — a file there
  // that is not the app's is kept (`docs/gui-seam.md` §1d). (`engine_provider_key_delete_all` was a
  // fifth until PR 3 final r1 dropped it: uninstall's key leg runs `delete-all` Rust-side.) Removing a key the user replaced, discarded or
  // uninstalled is the point: leaving a secret behind would be the defect, as for the calendar link.
  const DELETION_SHAPED_ALLOWED = [
    "cli_shim_remove",
    "uninstall_execute",
    "calendar_link_remove",
    "engine_provider_key_delete",
  ];
  for (const name of invoked) {
    if (DELETION_SHAPED_ALLOWED.includes(name)) continue;
    expect(name).not.toMatch(/delete|prune|remove|clean|trash|unlink/);
  }
  expect(invoked).toContain("read_archived_briefing");
  expect(invoked).toContain("engine_schedule_verify");
  // ⚠ AND NONE OF T17's FOUR TAKES A PATH OR A URL. The names are what this scan sees; the closed
  // enums that make it true are in `src-tauri/src/access.rs` and pinned by `tests/access.rs`.
  for (const name of ["access_snapshot", "access_probe", "access_reveal_engine", "access_open_settings"]) {
    expect(invoked).toContain(name);
  }
  // B7 (T18/T19): the two notify commands, and — since Phase E M5b — EXACTLY ONE autostart
  // plugin command, the real-state read; ON/OFF and the wizard's pre-tick are the app's own
  // `autostart_set_enabled` / `autostart_wizard_default` (the plugin's enable/disable are no
  // longer granted: its enable writes an unbranded plist). No other plugin is invoked at all.
  for (const name of ["notify_status", "notify_set_enabled"]) {
    expect(invoked).toContain(name);
  }
  // B25 (T25): the uninstall pair — preview reads, execute takes exactly one boolean (the
  // engine-data consent); neither takes a path, and the removal lists live Rust-side.
  for (const name of ["uninstall_preview", "uninstall_execute"]) {
    expect(invoked).toContain(name);
  }
  for (const name of ["autostart_set_enabled", "autostart_wizard_default"]) {
    expect(invoked).toContain(name);
  }
  expect(new Set(invoked.filter((n) => n.includes("|")))).toEqual(new Set(["plugin:autostart|is_enabled"]));
});

test("A2-M4-T13: the summary read's closed lists match the engine's and Rust's own", () => {
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
  const body = (source: string, pattern: RegExp) => {
    const found = pattern.exec(source)?.[1];
    if (found === undefined) throw new Error(`nothing matches ${pattern}`);
    return found;
  };
  const codes = (text: string) => [...text.matchAll(/"([a-z-]+)"/g)].map((m) => m[1] ?? "").sort();
  const variants = (text: string) => [...text.matchAll(/^    ([A-Z]\w*)\b/gm)].map((m) => m[1] ?? "");
  const unionOf = (name: string) => new RegExp(`export type ${name} =([^;]*);`);

  const wrapper = read("../src/lib/engine.ts");
  const store = read("../../src/summary/store.ts");
  const replyCodes = codes(body(wrapper, unionOf("SummaryWarningCode")));
  expect(replyCodes.length).toBeGreaterThan(0);
  expect(codes(body(store, unionOf("SummaryWarningCode")))).toEqual(replyCodes);
  expect(codes(body(store, /const WARNINGS = new Set<SummaryWarningCode>\(\[([^\]]*)\]\)/))).toEqual(replyCodes);

  // Rust's one enum also holds the config resolver's code, which appears in status only: a record
  // carrying it is refused whole (`summary-record-vectors.json`), so a reply never holds it.
  const statusOnly = codes(body(read("../../src/summary/config.ts"), unionOf("AiSummaryConfigWarning")));
  expect(statusOnly.length).toBeGreaterThan(0);
  const rust = variants(body(read("../src-tauri/src/schedule_state.rs"), /pub enum SummaryWarningCode \{([^}]*)\}/));
  expect(rust.map((v) => v.replace(/(?!^)[A-Z]/g, (c) => `-${c}`).toLowerCase()).sort()).toEqual([...replyCodes, ...statusOnly].sort());

  const kinds = [...body(wrapper, unionOf("SummaryReadError")).matchAll(/kind: "(\w+)"/g)].map((m) => m[1] ?? "");
  const errors = variants(body(read("../src-tauri/src/summary.rs"), /pub enum SummaryReadError \{([^}]*)\}/));
  expect(kinds.length).toBeGreaterThan(0);
  expect(errors.map((v) => v.charAt(0).toLowerCase() + v.slice(1))).toEqual(kinds);
});

test("A2-M4-T13: readLatestSummary sends the one `request` argument Rust's command reads", async () => {
  // `invoke` calls `window.__TAURI_INTERNALS__.invoke(cmd, args)`; a recorder stands in, as in `provider-ops.check.ts`.
  const g = globalThis as unknown as { window?: unknown };
  const hadWindow = "window" in g;
  const windowBefore = g.window;
  const calls: [string, unknown][] = [];
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown) => {
        calls.push([command, args]);
        return { state: "pending", warnings: [] };
      },
    },
  };
  try {
    await readLatestSummary("page-hash", "page-version");
  } finally {
    if (hadWindow) g.window = windowBefore;
    else delete g.window;
  }
  expect(calls).toEqual([["read_latest_summary", { request: { pageHash: "page-hash", pageVersion: "page-version" } }]]);
  const rust = readFileSync(new URL("../src-tauri/src/summary.rs", import.meta.url), "utf8");
  expect(rust).toMatch(/pub async fn read_latest_summary\(\s*engine: State<'_, Engine>,\s*request: SummaryRequest,\s*\)/);
});

test("P1-M9-T4: History renders the notice lines above an archived briefing's title, as notice blocks", async () => {
  // History draws a briefing through `renderMarkdown(file.text)` (History.svelte), so the file renderer's notice kind
  // is what it shows; pinned on the source so a second renderer cannot slip in.
  const src = readFileSync(join(import.meta.dir, "../src/routes/History.svelte"), "utf8");
  expect(src).toContain("renderMarkdown(file.text)");
  const { renderMarkdown } = await import("../src/lib/briefing-md");
  const file = "ℹ︎ Skipped \"Local\": unreachable — used \"Claude login 2\"\n\n☀️  Daily briefing — 2026-10-16  (this machine: mac)\n\n▶ Where you left off\n   • [app] resume\n";
  const kinds = renderMarkdown(file).map((b) => b.kind);
  expect(kinds.slice(0, 2)).toEqual(["notice", "title"]);
});

/**
 * B2-M4-T12: the literal wrappers beside their grants. Every caller after this one injects them, so this is the one place
 * their wire shape is read: each sends one `request` argument, the one Rust's command takes (`tests/capability.rs` sends
 * the same shapes through the shipped handler). The IPC is a recorder, as in `provider-ops.check.ts`; nothing opens.
 */
describe("the opening commands' wrappers", () => {
  test("each invokes its own command with one `request` holding handles, a project key or a token", async () => {
    const calls: [string, unknown][] = [];
    const g = globalThis as { window?: unknown };
    const hadWindow = "window" in g;
    const before = g.window;
    g.window = {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: unknown) => {
          calls.push([command, args]);
          return {};
        },
      },
    };
    try {
      await openGithub("h1");
      await copyPushCommand(["h1", "h2"]);
      await editorList();
      await editorList("h1");
      await editorOpen("h1", "zed");
      await editorChoiceSet("k1", "zed");
      await editorChoiceSet("k1", "ask");
    } finally {
      if (hadWindow) g.window = before;
      else delete g.window;
    }
    expect(calls).toEqual([
      ["open_github", { request: { handle: "h1" } }],
      ["copy_push_command", { request: { handles: ["h1", "h2"] } }],
      ["editor_list", { request: {} }],
      ["editor_list", { request: { handle: "h1" } }],
      ["editor_open", { request: { handle: "h1", editor: "zed" } }],
      ["editor_choice_set", { request: { project: "k1", editor: "zed" } }],
      ["editor_choice_set", { request: { project: "k1", editor: "ask" } }],
    ]);
  });
});
