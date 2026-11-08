/**
 * Run now passes `--now` (design 2026-10-24, "Run now before the morning time"): the engine lifts its
 * morning-time floor for it and keeps the once-a-day guard. A scheduled tick never passes it.
 *
 *   1. `run` / `runToFile` invoke their command with exactly the keys Rust reads, `now` among them;
 *   2. App's Run now — the one `run(...)` call, reached from Today, Good morning and the tray's
 *      `app:run-now` — asks for `now` and never for `force`.
 *
 * ⚠ THE IPC IS A RECORDER, NOT TAURI (as in `provider-ops.check.ts`): `@tauri-apps/api/core`'s
 * `invoke` calls `window.__TAURI_INTERNALS__.invoke(cmd, args)`, which each test installs. What Rust
 * builds from those keys — `run --json --now` — is pinned by `src-tauri/tests/capability.rs`.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { run, runToFile } from "../src/lib/engine";

const GUI = join(import.meta.dir, "..");
const ENGINE_RS = readFileSync(join(GUI, "src-tauri", "src", "engine.rs"), "utf8");
const APP = readFileSync(join(GUI, "src", "App.svelte"), "utf8");

let calls: [string, unknown][] = [];
const g = globalThis as { window?: unknown };
let hadWindow = false;
let windowBefore: unknown;

beforeEach(() => {
  calls = [];
  hadWindow = "window" in g;
  windowBefore = g.window;
  g.window = {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown) => {
        calls.push([command, args]);
        return { outcome: { kind: "delivered" }, exitCode: 0, payload: null };
      },
    },
  };
});

afterEach(() => {
  if (hadWindow) g.window = windowBefore;
  else delete g.window;
});

/** A `#[tauri::command]`'s webview-supplied parameters (the injected `AppHandle` / `State` are not sent). */
function rustParams(command: string): string[] {
  const signature = ENGINE_RS.match(new RegExp(`pub async fn ${command}<R: Runtime>\\(([\\s\\S]*?)\\)\\s*->`))?.[1] ?? "";
  if (signature === "") throw new Error(`no command ${command} in the Rust source`);
  return [...signature.matchAll(/(?:^|,)\s*(\w+)\s*:(?!:)\s*(AppHandle|State)?/g)]
    .filter((m) => m[2] === undefined)
    .map((m) => m[1] ?? "");
}

describe("Run now's IPC", () => {
  test("run and runToFile send `now`, false unless asked, beside `force` — the keys Rust reads", async () => {
    await run();
    await run({ now: true });
    await runToFile("out.json", { now: true });
    expect(calls).toEqual([
      ["engine_run", { force: false, now: false }],
      ["engine_run", { force: false, now: true }],
      ["engine_run_to_file", { name: "out.json", force: false, now: true }],
    ]);
    expect(rustParams("engine_run").sort()).toEqual(Object.keys(calls[0]![1] as object).sort());
    expect(rustParams("engine_run_to_file").sort()).toEqual(Object.keys(calls[2]![1] as object).sort());
  });

  test("App's Run now — Today, Good morning and the tray — asks for `now`, never `force`", () => {
    const script = APP.slice(0, APP.indexOf("</script>"));
    const runCalls = [...script.matchAll(/\bawait run\(([^)]*)\)/g)].map((m) => m[1]);
    expect(runCalls).toEqual(["{ now: true }"]);
    // The tray's `app:run-now` and the screens' `onrun` both reach that same function.
    expect(script).toMatch(/onRunNow\(\(\) => \{\s*void runNow\(\);\s*\}\)/);
    expect(APP).toContain("onrun={runNow}");
  });

  test("App keeps the run line in RunLine: each snapshot, a run's start, its sentence, and its own refresh", () => {
    expect(APP).toContain("runResult={runLine.text}");
    expect(APP).toContain("runLine = runLineSeen(runLine, knownMtime(next));");
    const script = APP.slice(0, APP.indexOf("</script>"));
    const body = script.slice(script.indexOf("async function runNow()"), script.indexOf("onMount(", script.indexOf("async function runNow()")));
    expect(body).toMatch(/runLine = runLineStarted\(runLine\);\s*const thisRun = runLine\.run;/);
    expect(body).toContain("runLine = { ...runLine, text: describe(outcome) };");
    expect(body).toContain("runLine = { ...runLine, text: describeFailure(e) };");
    expect(body).toMatch(/const read = await refresh\(\);\s*runLine = runLineSettled\(runLine, thisRun, read, knownMtime\(snapshot\)\);/);
  });
});
