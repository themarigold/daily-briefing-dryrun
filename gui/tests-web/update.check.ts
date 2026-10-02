/**
 * Phase E (E12) — the update check, webview side: the consent step, the Settings toggle and the
 * "Check now" panel.
 *
 * The plan's three tests (§4 M4, E12 "Tests"), and where each is pinned:
 *   • A FRESH PROFILE MAKES NO NETWORK CALL UNTIL ANSWERED — the consent defaults to No and the
 *     created config says so; the webview's one route to a request (`engine_update_check`) has
 *     exactly one call site, a button; the wizard never calls it; and the CSP admits no remote
 *     connection from the webview at all. (The engine's own default-off is pinned in
 *     `../test/update-check.test.ts`, "disabled by default ⇒ ZERO network calls".)
 *   • "NO" LEAVES `enabled` FALSE — on a create AND on a merge, and an untouched re-run writes
 *     nothing.
 *   • CHECK NOW WORKS REGARDLESS, INCLUDING WHILE A RUN IS IN FLIGHT — the button is disabled only by
 *     its own check, and has no run-state input. The IPC half (the engine's `update --check` admitted
 *     while a run holds the in-flight guard) is `src-tauri/tests/engine_client.rs`,
 *     `a_second_mutating_invocation_is_refused_as_busy`, plus the partition test beside it.
 *
 * ⚠ THE CONSENT COPY IS PINNED AGAINST THE REQUEST THE ENGINE ACTUALLY BUILDS: the engine's
 * `checkForUpdate` is driven here with a recording fetch (never the network) and every header it
 * sends must be one the copy accounts for.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { render } from "svelte/server";

// READ-ONLY engine imports (no Bun-only API at import time): the request builder and its vocabulary.
import { checkForUpdate, UPDATE_CHECK_URL, UPDATE_STATUSES, type FetchLike } from "../../src/updateCheck";
import UpdateCheck from "../src/lib/UpdateCheck.svelte";
import UpdateConsent from "../src/lib/UpdateConsent.svelte";
import SettingsForm from "../src/routes/SettingsForm.svelte";
import {
  checkedAtLine,
  CONSENT_NO,
  CONSENT_PARAGRAPHS,
  CONSENT_YES,
  parseUpdateResult,
  releasePage,
  updateFromStatus,
  updateLine,
} from "../src/lib/update-check";
import { getPath, SECTIONS, writeField, type Draft, type Field } from "../src/lib/settings-model";
import { buildConfig, draftFromConfig, emptyDraft, mergeConfig, savePlan, STEP_ORDER } from "../src/lib/wizard";
import type { EngineOutcome, StatusReport } from "../src/lib/engine";

const GUI_SRC = new URL("../src/", import.meta.url).pathname;
const read = (rel: string): string => readFileSync(new URL(rel, import.meta.url), "utf8");

function html(component: unknown, props: Record<string, unknown>): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(component as any, { props })
    .body.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\s+/g, " ");
}

/** Source text with comments removed — block, line and HTML — so a name mentioned in prose is not
 *  counted as a call. `//` counts as a comment only at a line start or after whitespace, so a URL
 *  inside a string (`https://…`) survives. */
function code(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|\s)\/\/[^\n]*/g, "$1");
}

/** Every `.ts` and `.svelte` file under gui/src, relative path → text WITHOUT comments. */
function webviewSources(): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string, rel: string): void => {
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      const r = rel === "" ? name : `${rel}/${name}`;
      if (statSync(p).isDirectory()) walk(p, r);
      else if (/\.(ts|svelte)$/.test(name)) out.set(r, code(readFileSync(p, "utf8")));
    }
  };
  walk(GUI_SRC, "");
  return out;
}

const RESULT_NEWER = {
  status: "newer" as const, current: "0.1.1", latest: "0.2.0",
  url: "https://github.com/themarigold/daily-briefing/releases/tag/v0.2.0", checkedAt: "2026-10-01T08:00:00.000Z",
};

/* ── the wire shapes mirror the engine's ─────────────────────────────────────────────────────── */

describe("the result type is the engine's", () => {
  test("the status vocabulary is the engine's UPDATE_STATUSES, and parsing keeps exactly the public fields", () => {
    for (const status of UPDATE_STATUSES) {
      expect(parseUpdateResult({ status, current: "1.0.0", checkedAt: "x" })?.status).toBe(status);
    }
    // An `etag` (the engine's internal cache tag) or any other extra field never reaches the webview.
    expect(parseUpdateResult({ ...RESULT_NEWER, etag: '"tag"', extra: 1 })).toEqual(RESULT_NEWER);
    for (const bad of [null, undefined, "newer", [], {}, { status: "maybe", current: "1", checkedAt: "x" },
                       { status: "newer", checkedAt: "x" }, { status: "newer", current: 1, checkedAt: "x" }]) {
      expect(parseUpdateResult(bad)).toBeNull();
    }
  });

  test("status --json's updateCheck: null before any check, absent on an older engine, parsed when present", () => {
    const outcome = (payload: StatusReport | null): EngineOutcome<StatusReport> =>
      ({ operation: "status", outcome: { kind: "delivered" }, exitCode: 0, payload, stdout: "", stderr: "" });
    expect(updateFromStatus(null)).toBeNull();
    expect(updateFromStatus(outcome(null))).toBeNull();
    expect(updateFromStatus(outcome({ schemaVersion: 1 }))).toBeNull();
    expect(updateFromStatus(outcome({ schemaVersion: 1, updateCheck: null }))).toBeNull();
    expect(updateFromStatus(outcome({ schemaVersion: 1, updateCheck: RESULT_NEWER }))).toEqual(RESULT_NEWER);
  });
});

/* ── wording ─────────────────────────────────────────────────────────────────────────────────── */

describe("the panel's wording", () => {
  test("each status has its own line; only a `newer` result shows a release page", () => {
    expect(updateLine(null)).toBe("No update check has run yet.");
    expect(updateLine(RESULT_NEWER)).toContain("A newer version is available: 0.2.0 — you have 0.1.1");
    expect(updateLine({ ...RESULT_NEWER, status: "up-to-date", latest: "0.1.1" })).toContain("Up to date — you have 0.1.1");
    expect(updateLine({ status: "unknown", current: "0.1.1", checkedAt: "2026-10-01T08:00:00Z" })).toContain("could not be completed");
    expect(releasePage(RESULT_NEWER)).toBe(RESULT_NEWER.url);
    expect(releasePage({ ...RESULT_NEWER, status: "up-to-date" })).toBeNull();
    expect(releasePage(null)).toBeNull();
    expect(checkedAtLine("garbage")).toBe("garbage");
    // ⚠ A MIDDAY INSTANT (Phase E final harden, GM2-4). `checkedAtLine` renders LOCAL time, and
    // 08:00Z is the previous day anywhere west of UTC-8, so the old instant failed there. 12:00Z
    // is 2026-10-01 00:00 at UTC-12 and 2026-10-02 02:00 at UTC+14 — the two ends of every real
    // offset — so the date below holds on any machine, and the format is still pinned exactly.
    expect(checkedAtLine("2026-10-01T12:00:00Z")).toMatch(/^2026-10-0[12] \d\d:\d\d$/);
  });

  test("engine-derived text renders as TEXT, and the release page is never a link", () => {
    const hostile = { ...RESULT_NEWER, latest: '<img src=x onerror="alert(1)">', url: "javascript:alert(1)" };
    const body = html(UpdateCheck, { result: hostile, loading: false, checking: false, oncheck: () => {} });
    expect(body).not.toContain("<img");
    expect(body).toContain("&lt;img");
    expect(body).not.toContain("<a ");
    expect(body).not.toContain("href=");
  });
});

/* ── test 1: a fresh profile makes no network call until answered ───────────────────────────── */

describe("a fresh profile makes no network call until answered", () => {
  test("the consent defaults to No, and the config a fresh wizard creates says enabled: false", () => {
    expect(emptyDraft().updateCheck).toBe(false);
    expect(buildConfig(emptyDraft())["updateCheck"]).toEqual({ enabled: false });
    const plan = savePlan({ exists: false, text: null, base: null }, emptyDraft());
    expect(plan.kind).toBe("create");
    expect(JSON.parse(plan.text).updateCheck).toEqual({ enabled: false });
  });

  test("the consent step is a wizard step BEFORE the save gate, and renders No checked by default", () => {
    expect(STEP_ORDER.indexOf("updates")).toBeGreaterThan(STEP_ORDER.indexOf("welcome"));
    expect(STEP_ORDER.indexOf("updates")).toBeLessThan(STEP_ORDER.indexOf("floor"));   // floor IS the save gate
    const body = html(UpdateConsent, { value: false, onchange: () => {} });
    const radio = (v: string) => new RegExp(`<input[^>]*value="${v}"[^>]*>`).exec(body)?.[0] ?? "";
    expect(radio("no")).toContain("checked");
    expect(radio("yes")).not.toContain("checked");
    expect(body.indexOf(CONSENT_NO)).toBeLessThan(body.indexOf(CONSENT_YES));         // No is listed first
    const yes = html(UpdateConsent, { value: true, onchange: () => {} });
    expect(new RegExp('<input[^>]*value="yes"[^>]*>').exec(yes)?.[0] ?? "").toContain("checked");
    // The component carries the copy, paragraph for paragraph.
    // (Svelte escapes `&` and `<` in text; `>` is legal there and stays as it is.)
    for (const p of CONSENT_PARAGRAPHS) expect(body).toContain(p.replace(/&/g, "&amp;").replace(/</g, "&lt;"));
  });

  test("the webview's ONE route to a request is `engine_update_check`, and its ONE call site is the Check-now button", () => {
    const sources = webviewSources();
    expect(sources.size).toBeGreaterThan(20);   // non-vacuous: the walk found the webview
    // The command is invoked in exactly one place: the typed wrapper.
    const invokers = [...sources].filter(([, t]) => t.includes('"engine_update_check"')).map(([f]) => f);
    expect(invokers).toEqual(["lib/engine.ts"]);
    // The wrapper is CALLED in exactly one place — Settings.svelte's checkNow — …
    const callers = [...sources].flatMap(([f, t]) =>
      [...t.matchAll(/\bupdateCheck\(\)/g)].map(() => f)).filter((f) => f !== "lib/engine.ts");
    expect(callers).toEqual(["routes/Settings.svelte"]);
    const settings = sources.get("routes/Settings.svelte")!;
    const fn = /async function checkNow\(\)[\s\S]*?\n {2}\}\n/.exec(settings)?.[0] ?? "";
    expect(fn).toContain("await updateCheck()");
    // …and checkNow is referenced only as the panel's `oncheck`, which the panel binds to ONE button.
    expect([...settings.matchAll(/\bcheckNow\b/g)].length).toBe(2);   // its definition + `oncheck={() => void checkNow()}`
    expect(settings).toContain("oncheck={() => void checkNow()}");
    const panel = sources.get("lib/UpdateCheck.svelte")!;
    expect([...panel.matchAll(/\boncheck\b/g)].map((m) => m.index).length).toBe(3);   // the prop type, the destructure, the button
    expect(panel).toMatch(/<button[^>]*onclick=\{oncheck\}/);
    // Nothing in the wizard, and nothing on mount anywhere, starts a check.
    expect(sources.get("routes/Wizard.svelte")).not.toMatch(/updateCheck\(|engine_update_check/);
    expect(sources.get("lib/UpdateConsent.svelte")).not.toMatch(/updateCheck\(|invoke/);
  });

  test("the webview itself can reach no remote host: the CSP is default-src 'self' with no connect-src", () => {
    const conf = JSON.parse(read("../src-tauri/tauri.conf.json")) as { app: { security: { csp: string } } };
    const csp = conf.app.security.csp;
    expect(csp).toContain("default-src 'self'");
    expect(csp).not.toContain("connect-src");
    expect(csp).not.toMatch(/https?:|api\.github\.com|\*/);
  });
});

/* ── the consent copy says exactly what is sent ─────────────────────────────────────────────── */

describe("the consent copy describes the engine's real request", () => {
  const scratch: string[] = [];
  // ⚠ `afterAll`, NOT `process.on("exit")` — bun test does not fire the exit event. The
  // coexistence.check.ts pattern, whose exit-hook predecessor was measured leaking one tree per run.
  afterAll(() => {
    for (const dir of scratch) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* scratch cleanup is best-effort */
      }
    }
  });

  test("every header the engine sends is one the copy accounts for; the copy names the host, the User-Agent, the cache tag and the IP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "dba-e12-consent-"));
    scratch.push(dir);
    const seen: { url: string; headers: Record<string, string> }[] = [];
    const answers = [
      new Response(JSON.stringify({ tag_name: "v9.9.9", html_url: RESULT_NEWER.url }), { status: 200, headers: { etag: '"t1"' } }),
      new Response(null, { status: 304 }),
    ];
    const fake: FetchLike = async (url, init) => {
      seen.push({ url, headers: { ...(init.headers as Record<string, string>) } });
      return answers.shift()!;
    };
    await checkForUpdate({ fetch: fake, path: join(dir, "update-check.json"), version: "0.1.1" });
    await checkForUpdate({ fetch: fake, path: join(dir, "update-check.json"), version: "0.1.1" });
    expect(seen.length).toBe(2);
    const names = new Set(seen.flatMap((s) => Object.keys(s.headers)));
    // If the engine ever sends another header, this fails and the copy must be revisited.
    expect([...names].sort()).toEqual(["Accept", "If-None-Match", "User-Agent"]);
    expect(seen[0]!.headers["User-Agent"]).toBe("daily-briefing/0.1.1");
    expect(new URL(UPDATE_CHECK_URL).host).toBe("api.github.com");
    expect(new URL(UPDATE_CHECK_URL).search).toBe("");
    const copy = CONSENT_PARAGRAPHS.join(" ");
    for (const needle of ["api.github.com", "User-Agent", "daily-briefing/<version>", "no account, no machine or install ID",
                          "nothing is ever downloaded or installed", "IP address", "cache tag", "the same for everyone",
                          // the request SENDS the tag back (`If-None-Match`); it does not return one
                          "sends back GitHub's own cache tag"]) {
      expect(`${needle}: ${copy.toLowerCase().includes(needle.toLowerCase())}`).toBe(`${needle}: true`);
    }
  });

  // ⚠ REWRITTEN in Phase E M5b with the behaviour it describes (user-directed, 2026-10-01): the engine now
  // runs a due check ONLY right after a scheduled run DELIVERED a briefing — pinned by
  // ../../test/update-check.test.ts "a gate-skip tick (already ran today) does NOT check" and "no run that
  // did not deliver ever checks". M4's copy ("at the end of one of its regular runs … hours before that
  // day's briefing") was true of M4's engine and is false of this one, so it is now asserted ABSENT.
  test("the copy says WHEN the automatic check runs truthfully: right after a delivered briefing, never after a skip or failure", () => {
    const copy = CONSENT_PARAGRAPHS.join(" ");
    for (const gone of ["at the end of one of its regular runs", "hours before that day's briefing", "often an early run"]) {
      expect(`${gone}: ${copy.includes(gone)}`).toBe(`${gone}: false`);
    }
    for (const needle of ["right after it has delivered that day's briefing", "never on a run that skipped or failed", "No briefing ever waits for it"]) {
      expect(`${needle}: ${copy.includes(needle)}`).toBe(`${needle}: true`);
    }
  });
});

/* ── test 2: "No" leaves enabled false ───────────────────────────────────────────────────────── */

describe("\"No\" leaves `enabled` false — on a create and on a merge, and an untouched re-run writes nothing", () => {
  const base = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" }, discoverRoots: ["~"] };
  const text = (o: unknown) => JSON.stringify(o, null, 2);

  test("create: No → { enabled: false }; Yes → { enabled: true }", () => {
    expect(buildConfig({ ...emptyDraft(), updateCheck: false })["updateCheck"]).toEqual({ enabled: false });
    expect(buildConfig({ ...emptyDraft(), updateCheck: true })["updateCheck"]).toEqual({ enabled: true });
  });

  test("seeding reads ON only from exactly enabled: true — the engine's rule", () => {
    expect(draftFromConfig(text(base))!.updateCheck).toBe(false);
    expect(draftFromConfig(text({ ...base, updateCheck: { enabled: true } }))!.updateCheck).toBe(true);
    expect(draftFromConfig(text({ ...base, updateCheck: { enabled: "true" } }))!.updateCheck).toBe(false);
    expect(draftFromConfig(text({ ...base, updateCheck: true }))!.updateCheck).toBe(false);
  });

  test("merge: an untouched re-run changes nothing, whatever the block held", () => {
    for (const updateCheck of [undefined, { enabled: false }, { enabled: true, intervalHours: 6 }, "garbage", { enabled: "yes" }]) {
      const existing = text(updateCheck === undefined ? base : { ...base, updateCheck });
      expect(mergeConfig(existing, draftFromConfig(existing)!)).toEqual(JSON.parse(existing));
    }
  });

  test("merge: No turns an enabled check off and keeps the interval; Yes turns it on; No on an absent block adds nothing", () => {
    const on = text({ ...base, updateCheck: { enabled: true, intervalHours: 6 } });
    expect(mergeConfig(on, { ...draftFromConfig(on)!, updateCheck: false })["updateCheck"]).toEqual({ enabled: false, intervalHours: 6 });
    const absent = text(base);
    expect(mergeConfig(absent, { ...draftFromConfig(absent)!, updateCheck: true })["updateCheck"]).toEqual({ enabled: true });
    expect("updateCheck" in mergeConfig(absent, { ...draftFromConfig(absent)!, updateCheck: false })).toBe(false);
  });
});

/* ── test 3: Check now works regardless, including while a run is in flight ──────────────────── */

describe("Check now works regardless — including while a run is in flight", () => {
  const button = (body: string) => /<button[^>]*class="check-now[^"]*"[^>]*>/.exec(body)?.[0] ?? "";

  test("the button is disabled ONLY by its own check in flight", () => {
    for (const [loading, result] of [[true, null], [false, null], [false, RESULT_NEWER]] as const) {
      const body = html(UpdateCheck, { result, loading, checking: false, oncheck: () => {} });
      expect(button(body)).not.toBe("");
      expect(button(body)).not.toContain("disabled");
    }
    expect(button(html(UpdateCheck, { result: null, loading: false, checking: true, oncheck: () => {} }))).toContain("disabled");
  });

  test("the panel takes no run-state input at all, so nothing can couple it to a run", () => {
    const panel = read("../src/lib/UpdateCheck.svelte");
    const props = /interface Props \{([\s\S]*?)\n {2}\}/.exec(panel)?.[1] ?? "";
    expect(props).toContain("checking: boolean");
    expect(props).not.toMatch(/running|busy|inFlight/i);
    // …and the Settings screen gates checkNow on nothing but its own flag.
    const settings = read("../src/routes/Settings.svelte");
    const fn = /async function checkNow\(\)[\s\S]*?\n {2}\}\n/.exec(settings)?.[0] ?? "";
    expect(fn).toContain("if (updateChecking) return;");
    expect(fn).not.toMatch(/running|busy|saving/);
  });

  test("the Rust side admits it during a run: not mutating, and driven while a run holds the guard", () => {
    const rust = read("../src-tauri/src/engine.rs");
    const isMutating = /pub fn is_mutating\(&self\) -> bool \{([\s\S]*?)\n {4}\}/.exec(rust)?.[1] ?? "";
    expect(isMutating).toContain("Operation::ScheduleVerify");   // non-vacuous: the set was found
    expect(isMutating).not.toContain("UpdateCheck");
    const client = read("../src-tauri/tests/engine_client.rs");
    expect(client).toContain("reader.invoke(Operation::UpdateCheck, &NoProgress)");
  });
});

/* ── the Settings toggle ─────────────────────────────────────────────────────────────────────── */

describe("the Settings toggle is the engine's updateCheck, with the engine's own help text", () => {
  const fields = SECTIONS.flatMap((s) => s.fields);
  const field = (id: string): Field => fields.find((f) => f.id === id)!;

  test("an Update check section with the switch and the interval, each quoting src/types.ts", () => {
    const section = SECTIONS.find((s) => s.title === "Update check");
    expect(section?.fields.map((f) => [f.id, f.kind])).toEqual([["updateCheck.enabled", "bool"], ["updateCheck.intervalHours", "number"]]);
    for (const f of section!.fields) expect(f.quote?.source).toBe("src/types.ts");
    // (settings.check.ts's "help text is the engine's own words, verbatim" test checks every quote.)
  });

  test("the switch writes updateCheck.enabled in place, keeping the rest of the block; empty removes the key", () => {
    const draft: Draft = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" }, updateCheck: { intervalHours: 6, note: "mine" } };
    expect(writeField(draft, field("updateCheck.enabled"), "true")).toBeNull();
    expect(getPath(draft, ["updateCheck"])).toEqual({ intervalHours: 6, note: "mine", enabled: true });
    expect(writeField(draft, field("updateCheck.enabled"), "")).toBeNull();
    expect(getPath(draft, ["updateCheck"])).toEqual({ intervalHours: 6, note: "mine" });
    // From nothing: the block is created.
    const fresh: Draft = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" } };
    expect(writeField(fresh, field("updateCheck.enabled"), "true")).toBeNull();
    expect(fresh["updateCheck"]).toEqual({ enabled: true });
    expect(writeField(fresh, field("updateCheck.intervalHours"), "12")).toBeNull();
    expect(fresh["updateCheck"]).toEqual({ enabled: true, intervalHours: 12 });
  });

  test("the form renders the section", () => {
    const draft: Draft = { provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" }, updateCheck: { enabled: true } };
    const body = html(SettingsForm, { draft, errors: {}, onfield: () => {}, onnotifycommand: () => {}, ondefault: () => {}, onremovekey: () => {} });
    expect(body).toMatch(/<legend[^>]*>Update check<\/legend>/);
    expect(body).toContain("Check for new versions automatically");
    expect(body).toContain("it downloads nothing and installs nothing");
  });
});
