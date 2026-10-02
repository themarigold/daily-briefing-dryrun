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
    expect(body).toContain("never offers to remove any of it");
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

test("no command the webview invokes can remove or prune a briefing — except the two enumerated, argued exceptions", () => {
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
  const DELETION_SHAPED_ALLOWED = ["cli_shim_remove", "uninstall_execute"];
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
