/**
 * B25 (T25) — the CLI-stays-first-class regression suite, and the locally-assertable half of the
 * coexistence matrix (`docs/gui-seam.md` §16).
 *
 * ⚠ THE PROPERTY UNDER TEST IS THE ONE THAT ROTS SILENTLY: with the GUI's on-disk presence
 * simulated — its app-data records beside the engine's state dir, a `--json-out` envelope and an
 * app-visible ownership record inside it — the ENGINE CLI still behaves byte for byte as it does
 * on a machine that never installed the app. "The GUI quietly broke the audit tool" is a failure
 * that surfaces WEEKS later as missing days in the eval record; this suite is the guard, so it
 * runs the REAL engine (`bun src/main.ts`, the same modules the compiled CLI is built from) in a
 * fully sandboxed environment: tempdir HOME + XDG_CONFIG_HOME + DAILY_BRIEFING_STATE_DIR +
 * DBA_TEST_UNIT_DIR, `networkProbeHosts: []` (the engine's own "no gate" spelling — nothing is
 * probed), and a fake provider SHELL SCRIPT, exactly the established e2e posture
 * (`src-tauri/tests/engine_client.rs`, `common::sandbox_env`, plus HOME because the audit's
 * transcript resolution consults it).
 *
 * ⚠ BASELINE PROVENANCE (deviation 157): plan line 74's Phase-0 "coexistence fixture baseline"
 * does not exist in this repo (searched before building; plan R8 itself lists it as
 * "remaining"), so the pre-GUI baseline is GENERATED INSIDE THE SUITE — same sandbox shape, same
 * fixture repo, same fake provider, no GUI files — and the byte-identical assert compares live
 * bytes to live bytes. A committed baseline blob would rot with every legitimate render change
 * and rot SILENTLY with every illegitimate one; a generated baseline can only fail loudly.
 *
 * ⚠ THE ONE REAL-CLOCK STAMP, handled rather than normalised: the briefing embeds
 * `state as of HH:MM` (`stateAsOf` in `src/core.ts`, a real-clock read no injected clock reaches — the
 * engine's own tests document it, `test/json-envelope.test.ts`). Rather than weakening
 * byte-identical to modulo-a-stamp, the comparison group notes the minute before its first spawn
 * and after its last: if the minute rolled over mid-group the whole group is re-run (bounded).
 * Within one minute the assert is BYTES, no normalisation.
 *
 * ⚠ `registered` is never asserted: `schedule status` probes the LIVE scheduler (read-only —
 * `launchctl list` on darwin, `systemctl --user is-enabled` on linux), and on the author's
 * machine the real `local.daily-briefing` agent is loaded — the one engine surface a sandbox
 * cannot redirect (`docs/gui-seam.md` §1b). Ownership facts come from `recordPresent` /
 * `unitPresent` / `owner`, which are all sandbox-rooted.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { render } from "svelte/server";
import ts from "typescript";

// READ-ONLY imports of the engine's own code — the `notify.check.ts` / `briefing.check.ts`
// discipline. `lastBriefing` IS the parser the audit grades through; calling it here is what the
// brief means by "do not re-implement it".
import { lastBriefing } from "../../src/audit";
import { stateDirFor } from "../../src/marker";
// ⚠ Batch 2 (spec 3.1.3, "The GUI test runner"): from the scheduler installer this runner imports
// ONLY the pure manual-steps function; the import pin in section 9 holds every file in this folder to
// that. Since M9 round 3 this runner's preload (`svelte-loader.ts`) also arms DBA_TEST_UNIT_DIR, so the
// default exec's refusal holds here too, for whatever engine code reaches this process by a route the
// static pin cannot see.
import { manualRemoveSteps } from "../../src/schedule/install";

import AppSettings from "../src/lib/AppSettings.svelte";
import ScheduleUninstall from "../src/lib/ScheduleUninstall.svelte";
import UninstallConsent from "../src/lib/UninstallConsent.svelte";
import * as appUninstall from "../src/lib/app-uninstall";
import {
  anywayNote,
  autostartLine,
  chooseSchedulerOption,
  consentBoxes,
  consentLabel,
  DEFAULT_SCHEDULER_OPTION,
  engineDataLine,
  executeArgs,
  executeFailure,
  executeLabel,
  finishLine,
  LINK_TARGET_GONE,
  MANUAL_STEPS_APP_CLOSING,
  outcomeLine,
  reasonPhrase,
  REFUSED_FOR_KEPT_SCHEDULER,
  REMOVE_SCHEDULE_BUTTON,
  removedList,
  SCHEDULE_RECORD_RULE,
  SCHEDULE_UNIT_RULE,
  SCHEDULE_WAY_OUT,
  schedulerBranch,
  SCHEDULER_OPTIONS,
  schedulerOutcomeLine,
  settingsLabel,
  STAGED_COPIES_NOTE,
  stateAfterFailure,
  staticRemoveSteps,
  stillOnThisMachine,
  UNINSTALL_EXPLANATION,
  UNINSTALL_TIME_SENTENCE,
  uninstallAnyway,
  uninstallExecute,
  UNIT_DIR_CLAUSE,
  UNIT_WAY_OUT,
  type ExecuteFailure,
  type SchedulerOutcome,
  type SchedulerReport,
  type SettingsReport,
  type StillLine,
  type UninstallPreview,
  type UninstallReport,
} from "../src/lib/app-uninstall";

const ROOT = new URL("../../", import.meta.url).pathname;
const ENGINE = join(ROOT, "src", "main.ts");

/* ── the sandbox ──────────────────────────────────────────────────────────────────────────────── */

type Sandbox = {
  root: string;
  home: string;
  config: string;
  state: string;
  units: string;
  env: Record<string, string>;
};

/** The app's bundle identifier and product name, read from the shipped conf — the app-data dir's
 *  name, and the login item's (tauri-plugin-autostart names it after `package_info().name`). */
const TAURI_CONF = JSON.parse(readFileSync(join(ROOT, "gui", "src-tauri", "tauri.conf.json"), "utf8")) as {
  identifier: string;
  productName: string;
};
const BUNDLE_ID = TAURI_CONF.identifier;
const PRODUCT_NAME = TAURI_CONF.productName;

const SCRATCH = mkdtempSync(join(tmpdir(), "dba-b25-coexistence-"));
// ⚠ `afterAll`, NOT `process.on("exit")` (round-1 fix F11): bun test does not fire the exit
// event, so the exit-hook shape leaked one scratch tree per run — measured, +1 dir/run, 62 MB
// accumulated before anyone looked.
afterAll(() => {
  try {
    rmSync(SCRATCH, { recursive: true, force: true });
  } catch {
    /* scratch cleanup is best-effort */
  }
});

function sandbox(name: string): Sandbox {
  const root = join(SCRATCH, name);
  const home = join(root, "home");
  const config = join(root, "config");
  const state = join(root, "state");
  const units = join(root, "units");
  for (const d of [home, join(config, "daily-briefing"), state, units]) {
    mkdirSync(d, { recursive: true });
  }
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    XDG_CONFIG_HOME: config,
    DAILY_BRIEFING_STATE_DIR: state,
    DBA_TEST_UNIT_DIR: units,
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
    // ⚠ ONE zone for the whole suite universe, EXPLICIT. `bun test` forces its own clock to UTC
    // while a spawned child without $TZ uses the machine's zone — measured: the suite's "today"
    // was 2026-09-18 while the child's briefing said 2026-09-17. Every child runs UTC, every
    // suite-side date is derived via `toISOString()`, and the fixture commits carry `+0000`.
    TZ: "UTC",
  };
  return { root, home, config, state, units, env };
}

function writeConfig(sb: Sandbox, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(sb.config, "daily-briefing", "config.json"),
    JSON.stringify(
      {
        repos: [FIXTURE_REPO],
        provider: { cli: PROVIDER, argv: [], promptVia: "stdin" },
        networkProbeHosts: [],
        ...extra,
      },
      null,
      2,
    ),
  );
}

/* ── the fixture repo and the fake provider (shared by every sandbox, so paths are identical) ── */

/**
 * ⚠ FULL-REPLACEMENT env for every fixture git spawn (round-1 fix M5, measured): spreading
 * `process.env` let an inherited GIT_DIR/GIT_WORK_TREE redirect the fixture build — the module-load
 * IIFE below COMMITTED into an unrelated decoy repository before failing (contexts that export
 * those: git hooks, `git bisect run`, `git rebase --exec`, some CI runners) — and a global
 * `commit.gpgsign`/`core.hooksPath` would alter the build the same way. The two `/dev/null`
 * configs are `test/fixtures/eval-repo.ts`'s isolation idiom; TZ pins the commit stamps the
 * suite's dates derive from (the sandbox-env rationale at `sandbox()` above).
 */
const GIT_ENV: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: SCRATCH,
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  TZ: "UTC",
};

function git(args: string[], cwd: string, env: Record<string, string> = {}): void {
  const p = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...GIT_ENV, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  if (p.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${p.stderr.toString()}`);
  }
}

const FIXTURE_REPO = join(SCRATCH, "repo");
const PROVIDER = join(SCRATCH, "fake-provider.sh");
const FIXTURE_SHA = (() => {
  mkdirSync(FIXTURE_REPO, { recursive: true });
  git(["init", "-q", "-b", "main"], FIXTURE_REPO);
  git(["config", "user.name", "Test"], FIXTURE_REPO);
  git(["config", "user.email", "test@example.com"], FIXTURE_REPO);
  const yesterday = new Date(Date.now() - 864e5).toISOString().slice(0, 10);
  const stamp = (h: number) => ({
    GIT_AUTHOR_DATE: `${yesterday}T${String(h).padStart(2, "0")}:00:00 +0000`,
    GIT_COMMITTER_DATE: `${yesterday}T${String(h).padStart(2, "0")}:00:00 +0000`,
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_EMAIL: "test@example.com",
  });
  writeFileSync(join(FIXTURE_REPO, "notes.md"), "one\n");
  git(["add", "."], FIXTURE_REPO);
  git(["commit", "-q", "-m", "add parser skeleton"], FIXTURE_REPO, stamp(10));
  writeFileSync(join(FIXTURE_REPO, "parser.md"), "two\n");
  git(["add", "."], FIXTURE_REPO);
  git(["commit", "-q", "-m", "tighten parser edge cases"], FIXTURE_REPO, stamp(15));
  const head = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], {
    cwd: FIXTURE_REPO,
    env: GIT_ENV, // the same full replacement — an inherited GIT_DIR would answer for another repo
  });
  const sha = head.stdout.toString().trim();
  // The fake provider cites a REAL fixture SHA, so the audit's deterministic SHA-grounding leg
  // comes out clean and any flag the suite sees is a coexistence regression, not fixture noise.
  writeFileSync(
    PROVIDER,
    `#!/bin/sh\ncat > /dev/null\nprintf '%s\\n' '## RESUME' '- [r] resume the parser work' '## RECAP' "- [r] tightened parser edge cases | evidence: ${sha}" '## SUGGESTIONS' '- add a fuzz case'\n`,
  );
  Bun.spawnSync(["chmod", "755", PROVIDER]);
  return sha;
})();

/* ── the GUI's on-disk presence, simulated (B4–B8's real list, read from the sources) ────────── */

const APP_DATA_FILES = ["autostart-state.json", "notify-state.json", "access-state.json"];
const WINDOW_STATE_FILE = ".window-state.json";

/** An XDG base dir as dirs 6.0.0 resolves it on Linux (`src/lin.rs`): the variable counts only
 *  when it is an ABSOLUTE path, otherwise `$HOME/<fallback>`. */
function xdgDir(sb: Sandbox, name: string, ...fallback: string[]): string {
  const v = sb.env[name];
  return v !== undefined && isAbsolute(v) ? v : join(sb.home, ...fallback);
}

/**
 * Where Tauri puts the app's files on THIS platform, resolved the way tauri 2.11.5 does
 * (`src/path/desktop.rs:238-251`: `dirs::config_dir()` / `dirs::data_dir()` joined with the bundle
 * identifier). On macOS both are `~/Library/Application Support/<id>`. On Linux they DIVERGE:
 * `$XDG_CONFIG_HOME/<id>` (else `~/.config/<id>`) and `$XDG_DATA_HOME/<id>` (else
 * `~/.local/share/<id>`). The sandbox sets XDG_CONFIG_HOME to its config dir, so on Linux the
 * window-state file's directory sits BESIDE the engine's own `daily-briefing/` config dir — the
 * neighbour a coexistence suite most needs to show the engine ignores. A macOS-only simulation left
 * the Linux CI run checking directories the Linux app never writes. Any other platform gets the
 * macOS layout, as `plantGuiPresence`'s unit files do.
 */
function appDirs(sb: Sandbox): { data: string; config: string } {
  if (process.platform === "linux") {
    return {
      data: join(xdgDir(sb, "XDG_DATA_HOME", ".local", "share"), BUNDLE_ID),
      config: join(xdgDir(sb, "XDG_CONFIG_HOME", ".config"), BUNDLE_ID),
    };
  }
  const mac = join(sb.home, "Library", "Application Support", BUNDLE_ID);
  return { data: mac, config: mac };
}

/**
 * What a GUI install actually leaves on disk (each name from the owning source, not lore):
 *   app_data_dir (see `appDirs` for where that is per platform):
 *     autostart-state.json (src-tauri/src/autostart.rs STORE_FILE), notify-state.json
 *     (notifications.rs), access-state.json (access.rs), config-candidates/ (config_save.rs
 *     CANDIDATE_SUBDIR).
 *   app_config_dir: .window-state.json (tauri-plugin-window-state 2.4.1 DEFAULT_FILENAME, saved
 *     through `app_config_dir()`, `src/lib.rs:122`) — the same directory as app_data_dir on
 *     macOS, a different one on Linux (gui-seam §16b dev 158).
 *   engine state dir:
 *     a bare-name `--json-out` envelope (`engine_run_to_file`; the engine resolves bare names
 *     under its state dir and refuses the names it owns), and `<state>/schedule.json` — the
 *     ownership record whichever side installed the trigger wrote (§3).
 *   engine CONFIG dir (the third directory — round-1 fix F7): the app's one config-write path
 *     saves through the ENGINE's config dir (`config_save.rs`: `status --json` →
 *     `paths.configPath`, never Tauri's `app_config_dir()`), leaving `config.json.bak`
 *     permanently and, after a crash mid-save, a staged `.config.json.save-*` name
 *     (`staged_prefix` + `STAGED_SUFFIXES`, `.prev` among them). Measured inert — the engine
 *     never enumerates its config dir — but the simulation must be the FULL write-set, not the
 *     subset that happened to matter.
 *   the login item, which the setup wizard's last step turns on by default (autostart.rs — since
 *     Phase E M5b; B7 enabled it at first launch), named after the productName (auto-launch 0.5.0
 *     via tauri-plugin-autostart; on macOS the app then adds `AssociatedBundleIdentifiers`):
 *     - Linux: `$HOME/.config/autostart/<productName>.desktop` — auto-launch hard-codes
 *       `~/.config` there, ignoring XDG_CONFIG_HOME (`src/linux.rs:81-83`).
 *     - macOS: `$HOME/Library/LaunchAgents/<productName>.plist` (`src/macos.rs:179-190`) — the
 *       SAME directory as the engine's own `local.daily-briefing.plist`. This sandbox redirects the
 *       engine's unit dir to DBA_TEST_UNIT_DIR, so the login item is planted THERE, keeping the two
 *       plists side by side as on a real Mac.
 *   NOT runs.jsonl: the appendix names it, but R1 deleted that arm (gui-seam §1c dev 1) and
 *   nothing writes it — the simulated presence follows the sources, recorded as part of dev 158.
 *
 * Returns every file it planted with its bytes, for `expectGuiFilesIntact`.
 */
function plantGuiPresence(sb: Sandbox, owner: "app" | "cli" | null): Planted[] {
  const planted: Planted[] = [];
  const plant = (path: string, body: string): void => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
    planted.push({ path, body });
  };
  const linux = process.platform === "linux";
  const app = appDirs(sb);
  for (const name of APP_DATA_FILES) plant(join(app.data, name), "{}\n");
  plant(join(app.config, WINDOW_STATE_FILE), "{}\n");
  plant(join(app.data, "config-candidates", "candidate-9-9.json"), "{}\n");
  if (linux) plant(join(sb.home, ".config", "autostart", `${PRODUCT_NAME}.desktop`), "[Desktop Entry]\n");
  else plant(join(sb.units, `${PRODUCT_NAME}.plist`), "<plist/>\n");
  // The config-dir footprint (F7): a completed save's permanent .bak, and the staged .prev a
  // crash mid-save can leave behind.
  plant(join(sb.config, "daily-briefing", "config.json.bak"), "{}\n");
  plant(join(sb.config, "daily-briefing", ".config.json.save-b25.prev"), "{}\n");
  plant(join(sb.state, "run-envelope.json"), '{"schemaVersion":1}\n');
  if (owner !== null) {
    // The unit file(s) `schedule status` looks for on THIS platform (`unitPaths` in
    // src/schedule/install.ts, rooted at DBA_TEST_UNIT_DIR): the launchd plist on darwin, the
    // systemd service AND timer on linux. A plist-only fixture left `unitPresent` false on the Linux
    // CI runner (measured 2026-09-24). Spelled out LITERALLY rather than read from `unitPaths`: a
    // fixture built from the function under test could not catch a rename.
    const units = linux ? ["daily-briefing.service", "daily-briefing.timer"] : ["local.daily-briefing.plist"];
    for (const name of units) plant(join(sb.units, name), "<unit/>\n");
    plant(
      join(sb.state, "schedule.json"),
      JSON.stringify({
        owner,
        invoker: owner,
        kind: linux ? "systemd" : "launchd",
        unitPath: join(sb.units, linux ? "daily-briefing.timer" : "local.daily-briefing.plist"),
        // The managed engine copy, as `managedBinPath` (src/schedule/install.ts) spells it: the
        // state dir on darwin; on linux `XDG_DATA_HOME` taken as is (no absolute-path rule, unlike
        // `xdgDir`), else `~/.local/share`. `schedule status` reports it; no assertion here does.
        binPath: linux
          ? join(sb.env.XDG_DATA_HOME ?? join(sb.home, ".local", "share"), "daily-briefing", "bin", "daily-briefing")
          : join(sb.state, "daily-briefing"),
        installedAt: "2026-09-01T00:00:00.000Z",
        engineVersion: "0.1.1",
      }),
    );
  }
  return planted;
}

type Planted = { path: string; body: string };

/** Every file `plantGuiPresence` planted is still there, BYTE FOR BYTE: the app's files, and the
 *  ownership record and unit files planted beside them. Only `schedule install` / `uninstall`
 *  (`installSchedule` / `uninstallSchedule`, src/schedule/install.ts) write or remove the latter,
 *  and this suite runs neither. Called after every engine command the suite runs against a
 *  GUI-present sandbox — `after` names the command in the failure message. When an earlier leg
 *  already broke a file in `shared`, later legs report it again under their own command name. */
function expectGuiFilesIntact(planted: Planted[], after: string): void {
  expect(planted.length).toBeGreaterThan(0);
  for (const { path, body } of planted) {
    expect(existsSync(path), `${path} vanished after ${after}`).toBe(true);
    expect(readFileSync(path, "utf8"), `${path} changed after ${after}`).toBe(body);
  }
}

/* ── running the engine ───────────────────────────────────────────────────────────────────────── */

type Ran = { code: number; stdout: string; stderr: string };

function engine(sb: Sandbox, args: string[]): Ran {
  const p = Bun.spawnSync(["bun", ENGINE, ...args], {
    cwd: ROOT,
    env: sb.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

/** launchd emulation: StandardOut AND StandardError appended to the SAME briefing.log. */
function engineIntoLog(sb: Sandbox, args: string[]): number {
  const fd = openSync(join(sb.state, "briefing.log"), "a");
  try {
    const p = Bun.spawnSync(["bun", ENGINE, ...args], {
      cwd: ROOT,
      env: sb.env,
      stdout: fd,
      stderr: fd,
    });
    return p.exitCode ?? -1;
  } finally {
    closeSync(fd);
  }
}

function audit(sb: Sandbox): Ran {
  const p = Bun.spawnSync(["bun", "run", "audit", "--no-judge"], {
    cwd: ROOT,
    env: sb.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: p.exitCode ?? -1, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
}

const minuteNow = (): string => new Date().toISOString().slice(0, 16);
/** The children's local date — UTC, because every child runs `TZ=UTC` (see `sandbox`). */
const today = (): string => new Date().toISOString().slice(0, 10);

/**
 * Run `fn` with a minute guard: when the wall-clock minute rolls over mid-group, the whole group
 * is re-run (the `state as of HH:MM` stamp — file header). Test 1 re-runs in fresh sandboxes. The
 * groups that reuse `shared` must survive a re-run: test 2 removes the log its count reads, and
 * test 3's audit passes when re-run as is (both measured by forcing one retry).
 * Three attempts; the near-impossible triple straddle fails loudly rather than flaking.
 */
function withinOneMinute<T>(fn: (attempt: number) => T): T {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = minuteNow();
    const result = fn(attempt);
    if (minuteNow() === before) return result;
  }
  throw new Error("three consecutive attempts straddled a minute boundary — not a flake");
}

/* ── 1. the byte-identical guard (the core deliverable) ───────────────────────────────────────── */

describe("the CLI is byte-identical with the GUI's presence on disk", () => {
  test("run --force: baseline, app-owned and delegating sandboxes emit the same bytes", () => {
    const runs = withinOneMinute((attempt) => {
      // Fresh sandboxes per attempt: a delivering run stamps its state dir.
      const baseline = sandbox(`byte-baseline-${attempt}`);
      const appOwned = sandbox(`byte-app-${attempt}`);
      const delegating = sandbox(`byte-cli-${attempt}`);
      writeConfig(baseline);
      writeConfig(appOwned);
      writeConfig(delegating);
      // GUI-only (app-owned record) and both-installed-GUI-delegating (CLI-owned record); the
      // baseline is the machine the app never touched.
      const appOwnedPlanted = plantGuiPresence(appOwned, "app");
      const delegatingPlanted = plantGuiPresence(delegating, "cli");
      return {
        // Captured INSIDE the guarded closure (round-1 fix F8): the minute guard's stamp is
        // date-carrying (`toISOString().slice(0, 16)`), so this date is the children's date;
        // re-evaluating `today()` at assert time left a midnight window.
        date: today(),
        baseline: { sb: baseline, ran: engine(baseline, ["run", "--force"]) },
        appOwned: { sb: appOwned, planted: appOwnedPlanted, ran: engine(appOwned, ["run", "--force"]) },
        delegating: { sb: delegating, planted: delegatingPlanted, ran: engine(delegating, ["run", "--force"]) },
      };
    });

    for (const [leg, { ran }] of [
      ["baseline", runs.baseline],
      ["appOwned", runs.appOwned],
      ["delegating", runs.delegating],
    ] as const) {
      expect(ran.code, `${leg}: ${ran.stderr}`).toBe(0);
      expect(ran.stdout.startsWith("☀️"), `${leg} did not render a briefing: ${ran.stdout.slice(0, 120)}`).toBe(true);
      expect(ran.stdout).toContain(runs.date);
      expect(ran.stdout).toContain(FIXTURE_SHA);
    }
    // STDOUT: BYTES, no normalisation — the whole guard (stable across a 40-iteration paired
    // probe). STDERR: bytes after stripping ONE measured timing line — with `networkProbeHosts:
    // []` the probe answers instantly but `waitedMs` (a `Date.now()` difference,
    // `src/net.ts::waitForNetwork`) jitters between 0 and 1 ms, and `src/main.ts:95` prints
    // `waited ~0s for the network to come up` only when it lands ≥ 1 (measured: ~1 run in 10).
    // The line is pre-header, so briefing.log's audit slice never contains it; every OTHER
    // stderr byte is compared exactly, because diagnostics land in briefing.log under launchd
    // and a GUI-presence-dependent diagnostic would pollute the audit corpus like a stdout
    // change would.
    const unjitter = (s: string) => s.replace(/^waited ~0s for the network to come up\n?/gm, "");
    expect(runs.appOwned.ran.stdout).toBe(runs.baseline.ran.stdout);
    expect(runs.delegating.ran.stdout).toBe(runs.baseline.ran.stdout);
    expect(unjitter(runs.appOwned.ran.stderr)).toBe(unjitter(runs.baseline.ran.stderr));
    expect(unjitter(runs.delegating.ran.stderr)).toBe(unjitter(runs.baseline.ran.stderr));

    // The written briefing too — it is what the audit prefers (`briefing-latest.md`).
    const latest = (sb: Sandbox) => readFileSync(join(sb.state, "briefing-latest.md"), "utf8");
    expect(latest(runs.appOwned.sb)).toBe(latest(runs.baseline.sb));
    expect(latest(runs.delegating.sb)).toBe(latest(runs.baseline.sb));

    // And the run did not eat the GUI's files: EVERY file `plantGuiPresence` planted, in both
    // GUI-present sandboxes, is intact. The paths are this platform's (`appDirs`), so the Linux CI
    // run guards the Linux layout — the window-state dir beside the engine's config dir included.
    for (const leg of [runs.appOwned, runs.delegating]) expectGuiFilesIntact(leg.planted, "run --force");
    expect(readFileSync(join(runs.delegating.sb.state, "schedule.json"), "utf8")).toContain('"owner":"cli"');

    // Keep the delegating sandbox for the suite's later legs.
    shared = runs.delegating.sb;
    sharedPlanted = runs.delegating.planted;
    sharedBaseline = runs.baseline.sb;
    stampedDate = runs.date;
  });
});

/** The delegating sandbox from test 1, reused by the accumulation and audit legs — set there.
 *  ⚠ Coupled ON PURPOSE, and the cost is known (round-1 F8): one root failure in test 1 cascades
 *  into the five dependent tests as `sb is undefined` noise — but the root byte-diff reports
 *  FIRST, so the cascade amplifies a real failure rather than masking one. */
let shared: Sandbox;
/** What `plantGuiPresence` planted in `shared` — every later leg that runs the engine there
 *  re-checks it with `expectGuiFilesIntact`. */
let sharedPlanted: Planted[];
let sharedBaseline: Sandbox;
/** The date test 1's (then test 2's) delivering runs stamped — captured beside the writes, not at
 *  assert time (F8: `today()` re-read in a later test flakes across midnight UTC). */
let stampedDate: string;

/* ── 2. briefing.log accumulates in the format the audit's own parser reads ───────────────────── */

describe("briefing.log stays a valid audit corpus", () => {
  test("two launchd-shaped appends: the engine's own lastBriefing() returns exactly the last block", () => {
    // Captured INSIDE the minute guard with the appends (F8 + round-1 verify LOW-3): these two
    // runs re-stamp `last-run`, so they also own the date §6's behaviour pin asserts against —
    // and a UTC-midnight straddle between capture and append retries instead of misfiring.
    // The premise the retry reset below relies on: nothing before this test wrote the log.
    expect(existsSync(join(shared.state, "briefing.log")), "briefing.log before the first append").toBe(false);
    const appended = withinOneMinute((attempt) => {
      // ⚠ A RETRY STARTS FROM NO LOG, exactly as the first attempt does. Unlike test 1, this group
      // cannot take a fresh sandbox (it must append to `shared`), so a minute-straddle retry used to
      // append on top of the failed attempt's two blocks and the count below saw 4 headers, not 2 —
      // measured by forcing one retry. Only `engineIntoLog` (launchd's redirect) appends to
      // briefing.log; the engine itself only rotates it once it passes 5 MB (`rotateLogIfLarge`,
      // src/marker.ts), which a two-run log never reaches.
      if (attempt > 0) rmSync(join(shared.state, "briefing.log"), { force: true });
      const date = today();
      expect(engineIntoLog(shared, ["run", "--force"])).toBe(0);
      expect(engineIntoLog(shared, ["run", "--force"])).toBe(0);
      return date;
    });
    stampedDate = appended;

    const log = readFileSync(join(shared.state, "briefing.log"), "utf8");
    const headers = [...log.matchAll(/^☀️.*[Bb]riefing —/gm)];
    expect(headers.length).toBe(2);

    // THE ENGINE'S OWN PARSER, not a re-implementation: what audit grades is what this returns.
    const last = lastBriefing(log);
    expect(last.startsWith("☀️")).toBe(true);
    expect(last).toContain(appended);
    // The last block IS the briefing the engine wrote beside it — nothing (stderr, notifier,
    // GUI presence) leaked bytes after the header. Trailing newlines differ by exactly the
    // stdout newline, so both sides are compared with theirs stripped.
    const latest = readFileSync(join(shared.state, "briefing-latest.md"), "utf8");
    expect(last.replace(/\n+$/, "")).toBe(latest.replace(/\n+$/, ""));
    expectGuiFilesIntact(sharedPlanted, "two launchd-shaped runs");
  });
});

/* ── 3. the audit tool still finds and grades the briefing — identically ──────────────────────── */

describe("bun run audit still works in a GUI-present state dir", () => {
  test("offline audit: finds today's briefing, grades clean, writes its report — same bytes as the pre-GUI sandbox", () => {
    const a = withinOneMinute(() => ({
      baseline: audit(sharedBaseline),
      guiPresent: audit(shared),
    }));

    for (const [leg, ran] of Object.entries(a)) {
      expect(ran.code, `${leg}: ${ran.stderr}`).toBe(0);
      expect(ran.stdout).toContain(`# Briefing self-audit — ${today()}`);
      expect(ran.stdout).toContain("source: briefing-latest.md (today's)");
      // The fixture cites a real SHA, so a flag here is a coexistence regression.
      expect(ran.stdout).toContain("clean: all cited SHAs resolve");
      expect(ran.stdout).toContain("auto-audit: 0 flag(s)");
    }
    expect(existsSync(join(shared.state, `audit-${today()}.md`)), "the report file").toBe(true);
    expect(existsSync(join(sharedBaseline.state, `audit-${today()}.md`))).toBe(true);
    // The audit's whole output is byte-identical across the two machines-in-miniature.
    expect(a.guiPresent.stdout).toBe(a.baseline.stdout);
    // Its retention cleanup deletes files in the state dir — where the app keeps its envelope.
    expectGuiFilesIntact(sharedPlanted, "bun run audit");
  });
});

/* ── 4. the config is byte-stable through the operations the GUI spawns ───────────────────────── */

describe("a CLI-written config survives the GUI's read paths byte for byte", () => {
  test("status/doctor/config-validate leave the file untouched and re-readable", () => {
    // ⚠ A FRESH sandbox that NO run has ever loaded, deliberately: this suite's first draft ran
    // this leg against the shared (already-delivered) sandbox, and a planted load-time
    // config-normalising rewrite SURVIVED it — test 1's runs had already normalised the file
    // before the before-hash was taken, so rewrite-on-load produced identical bytes. Measured
    // (mutation B25-10, first round), then fixed: the pretty-printed CLI-written file below has
    // never been through the engine, so any shape-normalising write between the two hashes
    // changes bytes.
    const sb = sandbox("config-stability");
    writeConfig(sb);
    const planted = plantGuiPresence(sb, "cli");
    const configPath = join(sb.config, "daily-briefing", "config.json");
    const before = readFileSync(configPath);

    // The three read operations the app's EngineClient issues (the Rust command bodies over
    // these argv are covered by tests/capability.rs; this is the CLI-visible half — the file).
    const status = engine(sb, ["status", "--json"]);
    expect(status.code).toBe(0);
    const doctor = engine(sb, ["doctor", "--json"]);
    expect(doctor.code).toBe(0);
    const validated = engine(sb, ["config", "validate", "--json", "--file", configPath]);
    expect(validated.code).toBe(0);
    expect((JSON.parse(validated.stdout) as { valid: boolean }).valid).toBe(true);

    const after = readFileSync(configPath);
    expect(after.equals(before), "the config file's bytes changed under read-only operations").toBe(true);
    // Shape too: the engine still reports the sandbox config as the one it reads.
    const paths = (JSON.parse(status.stdout) as { paths: { configPath: string; stateDir: string } }).paths;
    expect(paths.configPath).toBe(configPath);
    expect(paths.stateDir).toBe(sb.state);
    expectGuiFilesIntact(planted, "status/doctor/config validate");
  });
});

/* ── 5. the ownership record: the matrix's locally-assertable facts ───────────────────────────── */

describe("the coexistence matrix's ownership facts (sandbox-rooted fields only)", () => {
  const ownership = (sb: Sandbox) => {
    const ran = engine(sb, ["schedule", "status", "--json"]);
    expect(ran.code, ran.stderr).toBe(0);
    const parsed = JSON.parse(ran.stdout) as {
      owner: string | null;
      recordPresent: boolean;
      unitPresent: boolean;
    };
    return { owner: parsed.owner, recordPresent: parsed.recordPresent, unitPresent: parsed.unitPresent };
  };

  test("CLI-only: a cli-owned record, no GUI files — and the same with GUI files planted (delegating)", () => {
    // `shared` IS the delegating sandbox: cli-owned record + full GUI presence.
    expect(ownership(shared)).toEqual({ owner: "cli", recordPresent: true, unitPresent: true });
    expectGuiFilesIntact(sharedPlanted, "schedule status");
    // The pre-GUI baseline has no record at all — the not-scheduled leg.
    expect(ownership(sharedBaseline)).toEqual({ owner: null, recordPresent: false, unitPresent: false });
  });

  test("GUI-only: an app-owned record reports the app as owner", () => {
    const sb = sandbox("matrix-app");
    writeConfig(sb);
    const planted = plantGuiPresence(sb, "app");
    expect(ownership(sb)).toEqual({ owner: "app", recordPresent: true, unitPresent: true });
    expectGuiFilesIntact(planted, "schedule status");
  });
});

/* ── 6. who writes the once-per-day marker (backs §16's doc, so the cite cannot rot) ──────────── */

describe("the day marker's one writer is the engine's stampToday", () => {
  test("source pin: stampToday lives in src/marker.ts and main.ts calls it on the delivered path", () => {
    // The §16 doc cites these sites BY SYMBOL (round-1 fix F9 — this parse matches symbols, not
    // line numbers); the parse is what keeps the cite honest (the engine_env.rs pathEnv
    // discipline — parse the source of truth at test time).
    const marker = readFileSync(join(ROOT, "src", "marker.ts"), "utf8");
    expect(marker).toMatch(/export async function stampToday\(/);
    const main = readFileSync(join(ROOT, "src", "main.ts"), "utf8");
    const calls = [...main.matchAll(/await stampToday\(/g)];
    expect(calls.length, "exactly one delivered-path call site").toBe(1);
    // Fail-closed, success-only: the call sits in a try whose catch refuses to mark the day.
    expect(main).toContain("not marking today done");
    // Nothing GUI-side can write the marker, and that is STRUCTURAL rather than scanned for
    // here: the webview has no filesystem surface at all (tests-web/static.check.ts refuses the
    // sinks; the capability grants no fs permission), and the Rust shell's state-dir writes go
    // only through the engine's own argv surface — `engine.rs` refuses `--json-out` names the
    // engine owns, `last-run` among them. (A substring scan was tried and dropped: the SEAM
    // DOCS in `gui/src/lib/engine.ts` legitimately NAME `last-run` while granting nothing.)
  });

  test("behaviour pin: a delivering run stamps today; a refused run stamps nothing", () => {
    // Delivered → stamped with the run date. `stampedDate` was captured beside the delivering
    // runs themselves (F8) — `today()` re-read HERE was a midnight-UTC flake window.
    expect(readFileSync(join(shared.state, "last-run"), "utf8").trim()).toBe(stampedDate);
    // Refused (forced, no config) → exit 2 and NO marker: success-only is behaviour, not prose.
    const bare = sandbox("marker-refused");
    const ran = engine(bare, ["run", "--force"]);
    expect(ran.code).toBe(2);
    expect(existsSync(join(bare.state, "last-run"))).toBe(false);
  });
});

/* ── 7. the uninstall wording (the webview half's pure functions) ─────────────────────────────── */

/** How many sentences a label has: a sentence ends in `.`, `?` or `!` followed by a space or the end
 *  (so a path's dots, `uninstall.sh`'s, or `~/.config`'s, are not counted). */
const sentences = (text: string): number => (text.match(/[.?!](?=\s|$)/g) ?? []).length;

describe("the uninstall wording names what consent actually removes", () => {
  const preview: UninstallPreview = {
    appDataDir: "/x/app-data",
    appConfigDir: "/x/app-config",
    appEntries: [],
    engineStateDir: "/x/state",
    engineError: null,
    engineEntries: [],
    autostartEnabled: true,
    autostartError: null,
    scheduleRecordPresent: false,
    scheduleUnitFile: null,
    // Nothing installed, and the engine's check said so (spec 3.3.1's second read).
    scheduleOwner: null,
    scheduleRegistered: false,
    scheduleRegisteredReason: null,
    scheduleRemoveSteps: "Run these in a terminal (bash or zsh) inside your desktop session.",
    scheduleStatusUnreadable: false,
    scheduleRecordFilePresent: false,
    settingsFolder: "/x/config",
    os: "macos",
  };
  const UNIT = "/Users/x/Library/LaunchAgents/local.daily-briefing.plist";
  const ticked = { removeEngineState: true, removeSettings: true };
  const none = { removeEngineState: false, removeSettings: false };

  test("the engine-data label names the archive, the irrecoverability, the engine copy and the bound — in two sentences (spec 3.6.2)", () => {
    const label = consentLabel(preview);
    expect(label).toBe(
      "Also remove the engine's data in /x/state: your whole briefing archive and its log, which cannot be " +
        "recovered, and the background engine copy. These are the files `bash scripts/uninstall.sh` removes; " +
        "nothing else in that folder is touched.",
    );
    expect(label).toContain("briefing archive");
    expect(label).toContain("cannot be recovered");
    expect(label).toContain("and the background engine copy");
    expect(label).toContain("nothing else in that folder is touched");
    expect(sentences(label)).toBe(2);
    // The History screen quotes the box by this lead (`routes/History.svelte`, `history.check.ts`).
    expect(label.startsWith("Also remove the engine's data")).toBe(true);
    // Without a resolved dir the label still stands, minus the path.
    expect(consentLabel({ ...preview, engineStateDir: null })).not.toContain("/x/state");
  });

  test("Batch 2 (spec 3.6.2, 3.5.2): on Linux the label says the engine copy at ~/.local/share/daily-briefing/bin/daily-briefing IS removed; elsewhere off macOS, that it is not", () => {
    const linux = consentLabel({ ...preview, os: "linux" });
    expect(linux).toBe(
      "Also remove the engine's data in /x/state: your whole briefing archive and its log, which cannot be " +
        "recovered, and the background engine copy at ~/.local/share/daily-briefing/bin/daily-briefing. " +
        "Nothing else in that folder is touched.",
    );
    expect(linux).not.toContain("does not remove");
    expect(linux).not.toContain("not removed");
    expect(sentences(linux)).toBe(2);
    const other = consentLabel({ ...preview, os: "windows" });
    expect(other).not.toContain("and the background engine copy");
    expect(other).toContain("The background engine copy is not removed by this");
    expect(other).toContain("briefing archive");
    expect(other).toContain("cannot be recovered");
    expect(sentences(other)).toBe(2);
    expect(consentLabel(preview)).not.toContain("not removed");
  });

  test("round 4 (B4-L5): the script-parity claim is macOS-only — `scripts/uninstall.sh` is a macOS source-checkout script", () => {
    expect(consentLabel(preview)).toContain("These are the files `bash scripts/uninstall.sh` removes");
    for (const os of ["linux", "windows"]) {
      const label = consentLabel({ ...preview, os });
      expect(label).not.toContain("scripts/uninstall.sh");
      expect(label).not.toContain("These are the files");
      expect(label.toLowerCase()).toContain("nothing else in that folder is touched");
    }
  });

  test("Batch 2 (spec 3.6.2): \"blocked\" no longer means a scheduler on disk — the label is the same whatever the preview saw of one", () => {
    // The app's own scheduler is removed FIRST now, and another is the radio group's to answer; Rust's
    // refusals stay the backstop, reported on the done screen. So nothing scheduler-shaped is in the
    // label: no "removes nothing", no rule sentence, no unit path.
    const plain = consentLabel(preview);
    for (const seen of [
      { scheduleRecordPresent: true, scheduleRecordFilePresent: true, scheduleOwner: "app" as const },
      { scheduleRecordPresent: true, scheduleRecordFilePresent: true, scheduleOwner: "cli" as const },
      { scheduleRecordPresent: true },
      { scheduleUnitFile: UNIT },
      { scheduleRegistered: true },
      { scheduleRegistered: null, scheduleRegisteredReason: "timeout" },
      { scheduleStatusUnreadable: true, scheduleRegistered: null },
    ]) {
      expect(consentLabel({ ...preview, ...seen })).toBe(plain);
      expect(settingsLabel({ ...preview, ...seen })).toBe(settingsLabel(preview));
    }
    for (const gone of ["removes nothing", SCHEDULE_RECORD_RULE, SCHEDULE_UNIT_RULE, UNIT, "schedule.json"]) {
      expect(plain).not.toContain(gone);
    }
  });

  test("Batch 2 (spec 3.5.3): the settings box names the folder it empties; the folder unknown blocks it, in one more sentence", () => {
    expect(settingsLabel(preview)).toBe("Also remove my settings and API key file (in /x/config).");
    expect(sentences(settingsLabel(preview))).toBe(1);
    const unknown = settingsLabel({ ...preview, settingsFolder: null });
    expect(unknown).toBe(
      "Also remove my settings and API key file. The engine couldn't say where they are, so this removes nothing " +
        "until it can.",
    );
    expect(sentences(unknown)).toBe(2);
  });

  test("round 4 (B4-L7) + Batch 2: with the engine's folder unknown (engineError) the label says so in ONE more sentence, and the button does not promise it", () => {
    const unresolved = { ...preview, engineStateDir: null, engineError: "status --json exited 2" };
    const label = consentLabel(unresolved);
    expect(label.endsWith(
      " The engine couldn't say where its data lives (status --json exited 2), so this removes nothing until it can.",
    )).toBe(true);
    expect(sentences(label)).toBe(3);
    expect(executeLabel(none, unresolved)).toBe("Remove app pieces");
    expect(executeLabel({ removeEngineState: true, removeSettings: false }, unresolved)).toBe(
      "Remove app pieces (engine data stays while the engine cannot say where it is)",
    );
    // The same read names both folders, so both usually go unknown together.
    const both = { ...unresolved, settingsFolder: null };
    expect(executeLabel(ticked, both)).toBe(
      "Remove app pieces (engine data and settings stay while the engine cannot say where they are)",
    );
    expect(executeLabel(ticked, { ...preview, settingsFolder: null })).toBe(
      "Remove app pieces and engine data (settings stay while the engine cannot say where they are)",
    );
    expect(executeLabel({ removeEngineState: false, removeSettings: true }, { ...preview, settingsFolder: null })).toBe(
      "Remove app pieces (settings stay while the engine cannot say where they are)",
    );
  });

  test("round 3 (A3-L2) + Batch 2: the execute button says what clicking WILL do — read from what it sends, so \"Keep it running\" promises no files", () => {
    expect(executeLabel(none, preview)).toBe("Remove app pieces");
    expect(executeLabel({ removeEngineState: true, removeSettings: false }, preview)).toBe("Remove app pieces and engine data");
    expect(executeLabel({ removeEngineState: false, removeSettings: true }, preview)).toBe("Remove app pieces and settings");
    expect(executeLabel(ticked, preview)).toBe("Remove app pieces, engine data and settings");
    // Under "Keep it running" the boxes are sent as false whatever the view held, and the label follows.
    const other = schedulerBranch({ ...preview, scheduleUnitFile: UNIT });
    expect(executeLabel(executeArgs(other, ticked, "keep"), preview)).toBe("Remove app pieces");
    expect(executeLabel(executeArgs(other, ticked, "removeAny"), preview)).toBe("Remove app pieces, engine data and settings");
  });

  test("Batch 2 (spec 3.6.4): the four Rust ↔ TS text pairs, and the way out names the Schedule screen's REAL button", () => {
    // The label the record's rule and Rust's refusal both point at, read from the RENDERED component
    // (SSR: the closed state draws exactly the one removal button) — a renamed button fails here
    // instead of leaving the advice pointing at nothing.
    const body = render(ScheduleUninstall as never, { props: { scheduleState: null } }).body.replace(/<!--[\s\S]*?-->/g, "");
    const drawn = [...body.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => (m[1] ?? "").trim());
    expect(drawn).toEqual([REMOVE_SCHEDULE_BUTTON]);
    // Parsed from the source (the T9 pattern): each string literal with Rust's `\<newline><indent>`
    // continuations folded the way the compiler folds them.
    const rust = readFileSync(join(ROOT, "gui", "src-tauri", "src", "uninstall.rs"), "utf8");
    const rustConst = (name: string): string => {
      const literal = rust.match(new RegExp(`pub const ${name}: &str =\\s*"((?:[^"\\\\]|\\\\[\\s\\S])*)";`));
      expect([name, literal === null]).toEqual([name, false]);
      return (literal?.[1] ?? "").replace(/\\\n\s*/g, "");
    };
    // 1. Rust's record refusal CONTAINS the webview's rule sentence; it opens on the record alone.
    const refused = rustConst("REFUSED_FOR_SCHEDULE");
    expect(refused).toContain(SCHEDULE_RECORD_RULE);
    expect(refused.endsWith(SCHEDULE_RECORD_RULE)).toBe(true);
    expect(refused).not.toContain("unit file");
    // 2. The record-LESS unit's rule EQUALS the webview's (round 4, B4-L6).
    expect(rustConst("REFUSED_FOR_UNIT_RULE")).toBe(SCHEDULE_UNIT_RULE);
    // 3. Why a systemd unit gets its own command (cap round, G5-2).
    expect(rustConst("UNIT_DIR_CLAUSE")).toBe(UNIT_DIR_CLAUSE);
    // 4. The kept scheduler's refusal (spec 3.3.5.1).
    expect(rustConst("REFUSED_FOR_KEPT_SCHEDULER")).toBe(REFUSED_FOR_KEPT_SCHEDULER);
    expect(REFUSED_FOR_KEPT_SCHEDULER).toBe("A background scheduler is being kept, and it still needs these files.");
    // The rules' own words: of "these files" — they refuse the settings step too — each with its way out.
    expect(SCHEDULE_RECORD_RULE).toBe(
      "Uninstall removes none of these files while a background schedule is installed: remove the schedule " +
        `first (Schedule screen → ${REMOVE_SCHEDULE_BUTTON}), or run \`daily-briefing schedule uninstall\` if you ` +
        "installed it from the terminal, then run Uninstall again.",
    );
    expect(SCHEDULE_RECORD_RULE).toContain(SCHEDULE_WAY_OUT);
    expect(SCHEDULE_UNIT_RULE).toBe(
      "Uninstall removes none of these files while a background scheduler unit file is there: run " +
        "`daily-briefing schedule uninstall` in a terminal, which removes that scheduler and its unit file, then " +
        "run Uninstall again.",
    );
    expect(SCHEDULE_UNIT_RULE).toContain(UNIT_WAY_OUT);
    // Spec 3.6.1: no record is a dead end any more, so the stale-record clause is gone from every rule.
    for (const text of [refused, SCHEDULE_RECORD_RULE, SCHEDULE_UNIT_RULE]) {
      expect(text).not.toContain("stale");
      expect(text).not.toContain("delete `schedule.json`");
      expect(text).not.toContain("the engine's data");
    }
    // The unit's way out is the terminal (a unit the app-spawned engine could see is removed by the
    // scheduler step first), with the exact command beside it for a systemd unit (Rust's note).
    expect(UNIT_WAY_OUT).not.toContain(REMOVE_SCHEDULE_BUTTON);
  });

  test("checkpoint M6a (F5): the way out sits INSIDE the record rule — the rule's head, the way out, then \", then run Uninstall again.\" — and its doc comment says so, not the reverse", () => {
    expect(
      SCHEDULE_RECORD_RULE.endsWith(`installed: ${SCHEDULE_WAY_OUT}, then run Uninstall again.`),
    ).toBe(true);
    const source = readFileSync(join(ROOT, "gui", "src", "lib", "app-uninstall.ts"), "utf8");
    const at = source.indexOf("export const SCHEDULE_WAY_OUT =");
    expect(at).toBeGreaterThan(-1);
    // The comment's own text, its line breaks and `*` gutters folded into single spaces.
    const doc = source
      .slice(source.lastIndexOf("/**", at), at)
      .replace(/\n\s*\*(?!\/)/g, " ")
      .replace(/\s+/g, " ");
    expect(doc).not.toContain("It ends in");
    expect(doc).toContain('{@link SCHEDULE_RECORD_RULE} carries it, between the rule\'s head and ", then run Uninstall again."');
  });

  test("Batch 2 (spec 3.3.5.1): the kept-scheduler refusal is the same sentence on both sides", () => {
    // Rust's `REFUSED_FOR_KEPT_SCHEDULER` refuses the consented legs while a detected scheduler is
    // kept; the webview's twin is what its done screen will quote. Parsed from the source, as above.
    const rust = readFileSync(join(ROOT, "gui", "src-tauri", "src", "uninstall.rs"), "utf8");
    const literal = rust.match(/pub const REFUSED_FOR_KEPT_SCHEDULER: &str =\s*"((?:[^"\\]|\\[\s\S])*)";/);
    expect(literal).not.toBeNull();
    expect((literal?.[1] ?? "").replace(/\\\n\s*/g, "")).toBe(REFUSED_FOR_KEPT_SCHEDULER);
    expect(REFUSED_FOR_KEPT_SCHEDULER).toBe("A background scheduler is being kept, and it still needs these files.");
  });

  test("Batch 2 (spec 3.6.1, 3.6.2): the default action's copy is ONE sentence about the app's own pieces, and the scheduler notes are gone", () => {
    expect(UNINSTALL_EXPLANATION).toBe(
      "Removes this app's start-at-login entry and its own files; your briefing archive and settings stay " +
        "unless you choose to remove them.",
    );
    expect(sentences(UNINSTALL_EXPLANATION)).toBe(1);
    // The scheduler is said once, by the scheduler line — not here.
    expect(UNINSTALL_EXPLANATION.toLowerCase()).not.toContain("schedul");
    // Their premise is gone: the engine removes the scheduler on Uninstall, and removes a malformed or
    // dangling record (spec 3.6.1). The done view's own warning went with them (spec 3.6.3), and so did
    // the label's block on a scheduler and the webview's copy of the unit command. (The two old
    // constants' names are built here, not written, so a tree-wide search for them finds only code.)
    const oldNames = [["SCHEDULER", "NOTE"], ["STALE", "RECORD", "CLAUSE"]].map((p) => p.join("_"));
    for (const gone of [...oldNames, "doneNotes", "scheduleBlocks", "unitUninstallCommand"]) {
      expect([gone, gone in appUninstall]).toEqual([gone, false]);
    }
    // …and the module still exports what the screen uses, so the check is not reading an empty object.
    expect(["UNINSTALL_EXPLANATION" in appUninstall, "consentLabel" in appUninstall]).toEqual([true, true]);
  });

  test("round 3 (B3-L6): the last step is per platform — the Trash on macOS, the .deb or the AppImage on Linux", () => {
    expect(finishLine("macos")).toBe("To finish, quit the app and drag it from Applications to the Trash.");
    const linux = finishLine("linux");
    expect(linux).toContain("`sudo apt remove daily-briefing` for the .deb");
    expect(linux).toContain("delete the `.AppImage` file");
    expect(linux).not.toContain("Applications");
    expect(linux).not.toContain("Trash");
    expect(finishLine("windows")).not.toContain("Applications");
  });

  test("Batch 2 (spec 3.6.3): AppSettings draws the done screen from the REPORT — the outcome line first, the refusal verbatim, \"Still on this machine\" before the finish — and no warning of its own", () => {
    // The done view is reached only by clicking (SSR cannot get there), so its wiring is pinned by
    // source — the way `wizard.check.ts` pins the last step.
    const source = readFileSync(join(ROOT, "gui", "src", "lib", "AppSettings.svelte"), "utf8");
    const markup = source.slice(source.indexOf("</script>"));
    // The facts are the report's own (execute time) — no flag carried over from the preview, and no
    // scheduler fact read here at all (spec 3.3.8: the bare identifier, so a destructured one fails too).
    expect(markup).toContain("{@const report = uninstallReport}");
    expect(source).not.toContain("uninstallScheduled");
    expect(source).not.toContain("scheduleRecordPresent");
    // Each thing is said once: no warning of the panel's own, no old scheduler note (names built, as above).
    const oldNames = [["SCHEDULER", "NOTE"], ["STALE", "RECORD", "CLAUSE"]].map((p) => p.join("_"));
    for (const gone of ["doneNotes", "notes.warning", ...oldNames]) {
      expect([gone, source.includes(gone)]).toEqual([gone, false]);
    }
    // The order: the scheduler's outcome, the pieces, "Still on this machine" (with the steps), the finish.
    const outcomeAt = markup.indexOf("{schedulerOutcomeLine(report.schedule.outcome)}");
    const autostartAt = markup.indexOf("{autostartLine(report.autostart, report.os)}");
    const removedAt = markup.indexOf("{#each removedList(report) as line");
    const stillAt = markup.indexOf("Still on this machine:");
    const finishAt = markup.indexOf("{finishLine(report.os)}");
    expect(outcomeAt).toBeGreaterThan(-1);
    expect([outcomeAt < autostartAt, autostartAt < removedAt, removedAt < stillAt, stillAt < finishAt]).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(markup).toContain("{@const still = stillOnThisMachine(report)}");
    expect(markup).not.toContain("drag it from Applications");
    // Round 3 (B3-L5): the refused leg's ONE line — `engineDataLine`'s words, the refusal verbatim
    // (`{}`-interpolated, never `{@html}`), drawn only when there is one, inside the report.
    const reportAt = markup.indexOf('<ul class="muted report">');
    expect(reportAt).toBeGreaterThan(-1);
    const report = markup.slice(reportAt, markup.indexOf("</ul>", reportAt));
    const guard = "{#if dataLine !== null}";
    const refusalLine = '<li class="bad">{dataLine}</li>';
    expect(markup).toContain("{@const dataLine = engineDataLine(report)}");
    expect(report.indexOf(guard)).toBeGreaterThan(-1);
    expect(report.indexOf(refusalLine)).toBeGreaterThan(report.indexOf(guard));
    expect(markup).not.toMatch(/\{@html/);
    // The execute button and its words live in the consent view now — none here.
    expect(markup).toContain("<UninstallConsent");
    expect(markup).not.toContain("Remove app pieces");
    expect(markup).not.toContain("executeLabel");
  });

  test("Batch 2 (spec 3.3.8): AppSettings routes the execute call's errors through executeFailure — Try again, \"Uninstall anyway\" and a re-read on ScheduleForeign", () => {
    const source = readFileSync(join(ROOT, "gui", "src", "lib", "AppSettings.svelte"), "utf8");
    const run = source.slice(source.indexOf("async function runUninstall"), source.indexOf("function tryAgain"));
    expect(run).toContain("const known = executeFailure(e);");
    // `describeFailure` only for what is none of the three (its `busy` arm reads another error's shape).
    // The guard must EXIST before its order means anything (checkpoint M6a F3): a missing one is -1,
    // which any index would pass.
    const guardAt = run.indexOf("if (known === null)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(run.indexOf("describeFailure(e)")).toBeGreaterThan(guardAt);
    // What each error leaves the screen in is `stateAfterFailure`'s (checkpoint M6a F4: pure, and tested
    // directly in "each execute error's lines and buttons"), applied whole after the guard — and nothing
    // else in this function writes those five, so no `foreign = false;` can follow it unseen.
    const applyAt = run.indexOf(
      "const next = stateAfterFailure(known, { removeEngineState, removeSettings, option: schedulerOption, foreign, anyway });",
    );
    expect(applyAt).toBeGreaterThan(guardAt);
    for (const [name, field] of [
      ["removeEngineState", "removeEngineState"],
      ["removeSettings", "removeSettings"],
      ["schedulerOption", "option"],
      ["foreign", "foreign"],
      ["anyway", "anyway"],
    ] as const) {
      const writes = [...run.matchAll(new RegExp(`(?<![\\w.])${name} = ([^;]*);`, "g"))].map((m) => m[1]);
      expect([name, writes]).toEqual([name, [`next.${field}`]]);
    }
    // ScheduleForeign's re-read is the one the helper asks for, and the error is shown after it.
    const rereadAt = run.indexOf("if (next.reread) {");
    expect(rereadAt).toBeGreaterThan(applyAt);
    expect(run.slice(rereadAt)).toMatch(/^if \(next\.reread\) \{\s*try \{\s*uninstall = await uninstallPreview\(\);/);
    expect(run.indexOf("executeError = known;")).toBeGreaterThan(rereadAt);
    // All three arguments are sent, as the consent view computed them.
    expect(run).toContain("uninstallExecute(args.removeEngineState, args.removeSettings, args.schedule)");
    // The buttons are `executeFailure`'s: Try again repeats the last call; "Uninstall anyway" goes back to
    // the consent view in its keep form, which says what it keeps before anything is sent.
    const markup = source.slice(source.indexOf("</script>"));
    expect(markup).toContain("{#if executeError.buttons.includes(TRY_AGAIN)}");
    expect(markup).toContain("{#if executeError.buttons.includes(UNINSTALL_ANYWAY)}");
    expect(source).toContain("if (lastArgs !== null) void runUninstall(lastArgs);");
    expect(source).toMatch(/function chooseAnyway\(\): void \{\s*anyway = true;\s*executeError = null;\s*\}/);
    expect(markup).toMatch(/<UninstallConsent[\s\S]*?\{foreign\}[\s\S]*?\{anyway\}[\s\S]*?\/>/);
    // Checkpoint M6a (F6): the ScheduleFailed panel says what "Uninstall anyway" does UNDER its button, before
    // it is clicked — `anywayNote`'s sentence, from the branch the consent view will draw (`foreign` included).
    const panelAt = markup.indexOf('{:else if executeError !== null && executeError.kind !== "scheduleForeign"}');
    expect(panelAt).toBeGreaterThan(-1);
    const panel = markup.slice(panelAt, markup.indexOf("{:else}", panelAt));
    expect(panel).toContain(
      "{@const anywayLine = anywayNote(executeError, schedulerBranch(uninstall, foreign), { removeEngineState, removeSettings })}",
    );
    const buttonAt = panel.indexOf("{#if executeError.buttons.includes(UNINSTALL_ANYWAY)}");
    const rowEnd = panel.indexOf("</div>", buttonAt);
    expect([buttonAt > -1, rowEnd > buttonAt]).toEqual([true, true]);
    expect(panel.slice(rowEnd)).toMatch(/^<\/div>\s*\{#if anywayLine !== null\}\s*<p class="muted small">\{anywayLine\}<\/p>\s*\{\/if\}/);
    // M9 LOW pass (L18; spec §16 M6a): the Busy and ScheduleFailed panels share this one row, and it ENDS with
    // Cancel — once, outside both buttons' `{#if}`s, so both panels draw it — calling the same handler as the
    // consent view's Cancel. (The panel is reached only by an execute error, which a server render cannot
    // produce, so by source like the rest of this test.)
    const rowAt = panel.indexOf('<div class="row">');
    expect(rowAt).toBeGreaterThan(-1);
    const row = panel.slice(rowAt, panel.indexOf("</div>", rowAt));
    expect(row).toMatch(/\{\/if\}\s*<button disabled=\{uninstallBusy\} onclick=\{cancelUninstall\}>Cancel<\/button>\s*$/);
    expect(row.split(">Cancel</button>").length - 1).toBe(1);
    expect(row.indexOf(">Cancel</button>")).toBeGreaterThan(row.lastIndexOf("{/if}"));
    expect(markup).toContain("oncancel={cancelUninstall}");
  });

  test("M9 round 3: an Uninstall execute that STARTS ends the auto-route to the setup wizard for the session, and App holds the report and the in-flight state — so a settings removal's not-configured snapshot, or a screen change, cannot take the done screen away", () => {
    const src = (rel: string) => readFileSync(join(ROOT, "gui", "src", rel), "utf8");
    // AppSettings says the execute is starting BEFORE the IPC call (the watcher's event for a removed
    // config.json can arrive before the call returns), hands the report up the moment it arrives, and says
    // the attempt ended — with no report — on any rejection.
    const panel = src("lib/AppSettings.svelte");
    const run = panel.slice(panel.indexOf("async function runUninstall"), panel.indexOf("function tryAgain"));
    const startAt = run.indexOf("onuninstallstarted();");
    expect(startAt).toBeGreaterThan(-1);
    expect(startAt).toBeLessThan(run.indexOf("await uninstallExecute("));
    expect(run).toMatch(/const report = await uninstallExecute\([^)]*\);\s*onuninstallended\(report\);/);
    expect(run).toMatch(/\} catch \(e\) \{\s*onuninstallended\(null\);/);
    // The done screen reads the PROP: the panel holds no report of its own any more. (M9 LOW pass, L5: the
    // props are REQUIRED, with no default — "M9 LOW pass (L5)" below.)
    expect(panel).not.toMatch(/let uninstallReport = \$state/);
    expect(panel).toMatch(/\n    uninstallReport,\n/);
    expect(panel).toMatch(/\n    uninstallRunning,\n/);
    // Settings passes all four through.
    const settings = src("routes/Settings.svelte");
    const tag = settings.slice(settings.indexOf("<AppSettings"), settings.indexOf("/>", settings.indexOf("<AppSettings")));
    for (const prop of ["{uninstallReport}", "{uninstallRunning}", "{onuninstallstarted}", "{onuninstallended}"]) {
      expect([prop, tag.includes(prop)]).toEqual([prop, true]);
    }
    // App holds both, like `removalLine`, and sets the no-wizard flag on the START callback.
    const app = src("App.svelte");
    const script = app.slice(0, app.indexOf("</script>"));
    expect(script).toContain("let uninstallReport = $state<UninstallReport | null>(null);");
    expect(script).toContain("let uninstallRunning = $state(false);");
    const mount = app.slice(app.indexOf("<Settings"), app.indexOf("/>", app.indexOf("<Settings")));
    expect(mount).toContain("{uninstallReport}");
    expect(mount).toContain("{uninstallRunning}");
    // (M9 LOW pass, L2: the start also replaces the held report — "M9 round 4 (S2)" below.)
    expect(mount).toMatch(/onuninstallstarted=\{\(\) => \{\s*wizardOffered = true;\s*uninstallRunning = true;\s*uninstallReport = null;\s*\}\}/);
    // (M9 round 4: the arrival also bumps the Settings mount's key — "M9 round 4 (S3)" below pins that.)
    expect(mount).toMatch(/onuninstallended=\{\(report\) => \{\s*uninstallRunning = false;\s*if \(report !== null\) \{\s*uninstallReport = report;/);
    // So a not-configured snapshot after the start callback changes no route: `applySnapshot` routes to the
    // wizard only while `wizardOffered` is false, and nothing ever sets it back. A SOURCE pin, not a run:
    // `applySnapshot` is App's own function, reachable only by mounting App, which a server render cannot
    // drive (no listener, no click).
    expect(script).toMatch(
      /function applySnapshot\(next: Snapshot\): void \{[^}]*?if \(!wizardOffered && next\.scheduleState\?\.phase\.phase === "not-configured"\) \{\s*wizardOffered = true;\s*route = "wizard";\s*\}/,
    );
    expect([...app.matchAll(/(?<!let )(?<![\w.])wizardOffered = ([^;)]*)/g)].map((m) => m[1])).toEqual(["true", "true"]);
    // Nothing clears the report or the flag on a route change: the effect that clears the removal state does
    // not name them.
    const effect = script.slice(script.indexOf("$effect(() => {"), script.indexOf("});", script.indexOf("$effect(() => {")));
    expect(effect).toContain("void route;");
    expect(effect).not.toContain("uninstallReport");
    expect(effect).not.toContain("uninstallRunning");
    // The report is written twice, no more: cleared ONLY when the next execute starts — M9 LOW pass (L2):
    // "Uninstall again…" no longer clears it on the press ("M9 round 4 (S2)" below) — and set from the end
    // callback.
    expect([...app.matchAll(/(?<!let )(?<![\w.])uninstallReport = ([^;)]*)/g)].map((m) => m[1])).toEqual(["null", "report"]);
    expect(app).not.toContain("onuninstallagain");
  });

  test("the report lines cover the three outcomes; the login item's line is per platform (spec 3.6.5)", () => {
    expect(outcomeLine({ name: "briefing.log", outcome: { result: "removed" } })).toBe("briefing.log: removed");
    expect(outcomeLine({ name: "x", outcome: { result: "absent" } })).toBe("x: was not there");
    expect(outcomeLine({ name: "x", outcome: { result: "failed", detail: "EPERM" } })).toContain("EPERM");
    expect(autostartLine({ result: "removed" }, "macos")).toBe(
      "Start-at-login entry: removed. It won't open the app at your next login, though macOS may keep listing it " +
        "until you log out.",
    );
    expect(autostartLine({ result: "removed" }, "linux")).toBe("Start-at-login entry: removed.");
    for (const os of ["macos", "linux"]) {
      expect(autostartLine({ result: "absent" }, os)).toBe("Start-at-login entry: was not enabled");
      expect(autostartLine({ result: "failed", detail: "no plugin" }, os)).toBe(
        "Start-at-login entry: could not be removed (no plugin)",
      );
    }
  });
});

/* ── 8. Batch 2: the Uninstall screen's pure helpers (spec 3.3.8, 3.6.3; plan T6.1) ───────────── */

// Nothing installed, and the engine's check said so: every preview case below spreads from it.
const quiet: UninstallPreview = {
  appDataDir: "/x/app-data",
  appConfigDir: "/x/app-config",
  appEntries: [],
  engineStateDir: "/x/state",
  engineError: null,
  engineEntries: [],
  autostartEnabled: true,
  autostartError: null,
  scheduleRecordPresent: false,
  scheduleUnitFile: null,
  scheduleOwner: null,
  scheduleRegistered: false,
  scheduleRegisteredReason: null,
  scheduleRemoveSteps: null,
  scheduleStatusUnreadable: false,
  scheduleRecordFilePresent: false,
  settingsFolder: "/x/.config/daily-briefing",
  os: "macos",
};
const PLIST = "/Users/x/Library/LaunchAgents/local.daily-briefing.plist";
// Spec 3.3.8's cases, as the preview carries them (spec 3.3.1, 3.3.3).
const appOwned: UninstallPreview = {
  ...quiet,
  scheduleRecordPresent: true,
  scheduleRecordFilePresent: true,
  scheduleOwner: "app",
  scheduleRegistered: true,
};
const cliOwned: UninstallPreview = { ...appOwned, scheduleOwner: "cli" };
/** A malformed or dangling record: both looks see the file, and no readable record names an owner. */
const unownedRecord: UninstallPreview = { ...quiet, scheduleRecordPresent: true, scheduleRecordFilePresent: true };
const unitOnly: UninstallPreview = { ...quiet, scheduleUnitFile: PLIST };
const registrationOnly: UninstallPreview = { ...quiet, scheduleRegistered: true };
/** The status read failed (every engine fact unknown), while Rust's own look sees a record. */
const unreadable: UninstallPreview = {
  ...quiet,
  scheduleStatusUnreadable: true,
  scheduleRegistered: null,
  scheduleRecordPresent: true,
};
/** Nothing on disk, and the check could not run. */
const unchecked: UninstallPreview = { ...quiet, scheduleRegistered: null, scheduleRegisteredReason: "no-user-manager" };
/** Nothing on disk, and the status read failed. */
const unreadableNothing: UninstallPreview = { ...quiet, scheduleStatusUnreadable: true, scheduleRegistered: null };

const ticked = { removeEngineState: true, removeSettings: true };
const cleared = { removeEngineState: false, removeSettings: false };
const LEAD_NO_OWNER = "A background scheduler is set up, but nothing records who set it up.";
const LEAD_TERMINAL = "A background scheduler was set up from the terminal.";
const LEAD_UNREADABLE = "Something of a background scheduler is on this computer, but its status couldn't be read.";
const DETECTED_OTHER = [cliOwned, unownedRecord, unitOnly, registrationOnly, unreadable];

describe("Batch 2 (spec 3.3.8): the Uninstall preview's scheduler branch, its radio group and its boxes", () => {
  test("owner app is one line and no choice; every other detected scheduler gets its own lead sentence", () => {
    expect(schedulerBranch(appOwned)).toEqual({
      kind: "own",
      line: "The background scheduler this app set up is removed too.",
    });
    // The owner is `app` whatever the check said, as long as the status read succeeded (spec 3.3.3)…
    expect(schedulerBranch({ ...appOwned, scheduleRegistered: null, scheduleRegisteredReason: "timeout" }).kind).toBe("own");
    // …and never from an unreadable one.
    expect(schedulerBranch({ ...appOwned, scheduleStatusUnreadable: true })).toEqual({ kind: "other", lead: LEAD_UNREADABLE });
    expect(schedulerBranch(cliOwned)).toEqual({ kind: "other", lead: LEAD_TERMINAL });
    // A malformed or dangling record, a unit with no record, a registration with no files.
    for (const preview of [unownedRecord, unitOnly, registrationOnly]) {
      expect(schedulerBranch(preview)).toEqual({ kind: "other", lead: LEAD_NO_OWNER });
    }
    // The status unreadable while something is on disk: Rust's look at the record, or at a unit.
    expect(schedulerBranch(unreadable)).toEqual({ kind: "other", lead: LEAD_UNREADABLE });
    expect(schedulerBranch({ ...unreadableNothing, scheduleUnitFile: PLIST })).toEqual({ kind: "other", lead: LEAD_UNREADABLE });
    // The engine's own lstat counts as detection too (spec 3.3.3), even where Rust's look could not see.
    expect(schedulerBranch({ ...quiet, engineStateDir: null, scheduleRecordFilePresent: true })).toEqual({
      kind: "other",
      lead: LEAD_NO_OWNER,
    });
  });

  test("nothing detected: no scheduler text when the check ran, one line with the plain reason when it could not — both send removeOwn", () => {
    expect(schedulerBranch(quiet)).toEqual({ kind: "none" });
    expect(schedulerBranch(unchecked)).toEqual({
      kind: "unchecked",
      line: "Couldn't check for a background scheduler (the system's user services couldn't be reached).",
    });
    expect(schedulerBranch(unreadableNothing)).toEqual({
      kind: "unchecked",
      line: "Couldn't check for a background scheduler (its status couldn't be read).",
    });
    // No choice is offered on these branches, nor for the app's own: removeOwn, and the boxes as ticked.
    for (const preview of [quiet, unchecked, unreadableNothing, appOwned]) {
      const branch = schedulerBranch(preview);
      for (const consents of [ticked, cleared]) {
        expect(executeArgs(branch, consents, "keep")).toEqual({ ...consents, schedule: "removeOwn" });
      }
      expect(consentBoxes(branch, "keep")).toEqual({ locked: false, note: null });
    }
  });

  test("each reason is shown as its plain phrase, never as its token", () => {
    const phrases: Record<string, string> = {
      "no-user-manager": "the system's user services couldn't be reached",
      "no-gui-session": "this isn't a desktop session",
      timeout: "the check took too long",
      spawn: "the check couldn't start",
      unexpected: "the system gave an unexpected answer",
    };
    for (const [token, phrase] of Object.entries(phrases)) {
      expect(reasonPhrase(token)).toBe(phrase);
      expect(schedulerBranch({ ...quiet, scheduleRegistered: null, scheduleRegisteredReason: token })).toEqual({
        kind: "unchecked",
        line: `Couldn't check for a background scheduler (${phrase}).`,
      });
    }
    // A reason this app does not know yet, or none: still a phrase, never a token.
    expect(reasonPhrase("a-reason-from-a-newer-engine")).toBe(phrases.unexpected);
    expect(reasonPhrase(null)).toBe(phrases.unexpected);
  });

  test("the radio group: Keep it running first and preselected; Keep clears and disables both boxes and sends them false; Remove it sends removeAny", () => {
    expect(SCHEDULER_OPTIONS.map((o) => [o.choice, o.label])).toEqual([
      ["keep", "Keep it running"],
      ["removeAny", "Remove it"],
    ]);
    expect(DEFAULT_SCHEDULER_OPTION).toBe("keep");
    expect(DEFAULT_SCHEDULER_OPTION).toBe(SCHEDULER_OPTIONS[0]?.choice);
    for (const preview of DETECTED_OTHER) {
      const branch = schedulerBranch(preview);
      // Under "Keep it running": cleared, disabled, one sentence that a kept scheduler still needs them.
      expect(consentBoxes(branch, "keep")).toEqual({ locked: true, note: REFUSED_FOR_KEPT_SCHEDULER });
      expect(executeArgs(branch, ticked, "keep")).toEqual({ ...cleared, schedule: "keep" });
      // Under "Remove it": the boxes are the user's.
      expect(consentBoxes(branch, "removeAny")).toEqual({ locked: false, note: null });
      expect(executeArgs(branch, ticked, "removeAny")).toEqual({ ...ticked, schedule: "removeAny" });
      expect(executeArgs(branch, cleared, "removeAny")).toEqual({ ...cleared, schedule: "removeAny" });
    }
  });

  test("checkpoint M6a (F1): \"Keep it running\" CLEARS both boxes — Remove (ticked) → Keep → Remove leaves them unticked, and Remove sends false until they are ticked again", () => {
    for (const preview of DETECTED_OTHER) {
      const branch = schedulerBranch(preview);
      // "Remove it" with both ticked: the boxes are the user's, and sent so.
      let state = chooseSchedulerOption("removeAny", ticked);
      expect(state).toEqual({ ...ticked, option: "removeAny" });
      expect(executeArgs(branch, state, state.option)).toEqual({ ...ticked, schedule: "removeAny" });
      // "Keep it running": the VALUES are cleared, not only drawn clear (spec 3.3.8).
      state = chooseSchedulerOption("keep", state);
      expect(state).toEqual({ ...cleared, option: "keep" });
      // "Remove it" again: still unticked — the earlier ticks do not come back — and sent as false…
      state = chooseSchedulerOption("removeAny", state);
      expect(state).toEqual({ ...cleared, option: "removeAny" });
      expect(executeArgs(branch, state, state.option)).toEqual({ ...cleared, schedule: "removeAny" });
      // …drawn so, enabled, the user's to tick again…
      const drawn = consentView({ preview, ...state });
      expect(inputsOf(drawn, "checkbox").map((b) => [flag(b, "checked"), flag(b, "disabled")])).toEqual([
        [false, false],
        [false, false],
      ]);
      expect(buttonsOf(drawn)[0]).toEqual(["danger", "Remove app pieces"]);
      // …and what is ticked again is what is sent.
      state = { ...state, removeEngineState: true };
      expect(executeArgs(branch, state, state.option)).toEqual({ ...cleared, removeEngineState: true, schedule: "removeAny" });
    }
    // "Remove it" never touches the boxes, whatever they hold.
    expect(chooseSchedulerOption("removeAny", cleared)).toEqual({ ...cleared, option: "removeAny" });
    expect(chooseSchedulerOption("removeAny", { removeEngineState: false, removeSettings: true })).toEqual({
      removeEngineState: false,
      removeSettings: true,
      option: "removeAny",
    });
  });
});

describe("Batch 2 (spec 3.3.8): each execute error's lines and buttons", () => {
  test("ScheduleForeign: re-read, and the radio group is ALWAYS shown — with the null-owner lead when the re-read finds nothing", () => {
    const message =
      "This background scheduler wasn't set up by this app (a unit file with no record). Removing it needs your go-ahead.";
    // No buttons of its own: the radio group and the Uninstall button answer it.
    expect(executeFailure({ kind: "scheduleForeign", message })).toEqual({
      kind: "scheduleForeign",
      message,
      closing: null,
      buttons: [],
    });
    // The refusal is itself the detection: a re-read that finds nothing still gets the group.
    for (const reread of [quiet, unchecked, unreadableNothing, appOwned]) {
      expect(schedulerBranch(reread, true)).toEqual({ kind: "other", lead: LEAD_NO_OWNER });
    }
    // A re-read that does find one keeps that case's own lead.
    expect(schedulerBranch(cliOwned, true)).toEqual({ kind: "other", lead: LEAD_TERMINAL });
    expect(schedulerBranch(unitOnly, true)).toEqual({ kind: "other", lead: LEAD_NO_OWNER });
    expect(schedulerBranch(unreadable, true)).toEqual({ kind: "other", lead: LEAD_UNREADABLE });
    // …and its two answers send what the group says, even though the re-read saw nothing.
    const forced = schedulerBranch(quiet, true);
    expect(executeArgs(forced, ticked, "removeAny")).toEqual({ ...ticked, schedule: "removeAny" });
    expect(executeArgs(forced, ticked, "keep")).toEqual({ ...cleared, schedule: "keep" });
    expect(consentBoxes(forced, "keep")).toEqual({ locked: true, note: REFUSED_FOR_KEPT_SCHEDULER });
  });

  test("ScheduleFailed: the message, Try again and \"Uninstall anyway\", which sends keep in one of two forms", () => {
    const message = "Couldn't read the background scheduler's status.";
    expect(executeFailure({ kind: "scheduleFailed", message })).toEqual({
      kind: "scheduleFailed",
      message,
      closing: null,
      buttons: ["Try again", "Uninstall anyway"],
    });
    // Nothing detected (the check could not run, nothing on disk): the boxes are sent as they are. M9 LOW pass
    // (L4): "Your ticked boxes still apply" only when a box IS ticked — with neither, the sentence drops it.
    const withBoxes =
      "Any background scheduler that may still exist stays registered. Your ticked boxes still apply, and the " +
      "steps to remove it yourself are shown afterwards if it may still be there.";
    const noBoxes =
      "Any background scheduler that may still exist stays registered. The steps to remove it yourself are shown " +
      "afterwards if it may still be there.";
    for (const preview of [unchecked, unreadableNothing, quiet]) {
      for (const [consents, sentence] of [
        [ticked, withBoxes],
        [{ removeEngineState: true, removeSettings: false }, withBoxes],
        [{ removeEngineState: false, removeSettings: true }, withBoxes],
        [cleared, noBoxes],
      ] as const) {
        expect(uninstallAnyway(schedulerBranch(preview), consents)).toEqual({
          sentence,
          locked: false,
          args: { ...consents, schedule: "keep" },
        });
      }
    }
    // A scheduler detected (the app's own included): cleared and disabled, as under "Keep it running".
    for (const preview of [appOwned, ...DETECTED_OTHER]) {
      expect(uninstallAnyway(schedulerBranch(preview), ticked)).toEqual({
        sentence:
          "The background scheduler stays, and it still needs its files, so your data and settings are kept. The " +
          "steps to remove it yourself are shown afterwards.",
        locked: true,
        args: { ...cleared, schedule: "keep" },
      });
    }
  });

  test("an engine message that carries the manual steps is shown verbatim, and the app's closing line follows it once (spec 3.1.8; SQ6)", () => {
    const steps = manualRemoveSteps("launchd", {
      units: [PLIST],
      record: "/Users/x/Library/Application Support/daily-briefing/schedule.json",
      home: "/Users/x",
    });
    // A stable reason: the engine leads with the steps and ends with the details (spec 3.1.7).
    const stable = `${steps}\nCouldn't check whether a background scheduler is registered (no-gui-session)`;
    const failure = executeFailure({ kind: "scheduleFailed", message: stable });
    expect(failure?.message).toBe(stable);
    expect(failure?.closing).toBe("Then press Remove again, or run Uninstall again.");
    expect(MANUAL_STEPS_APP_CLOSING).toBe("Then press Remove again, or run Uninstall again.");
    // The closing line is the app's, never part of the text it follows.
    expect(failure?.message).not.toContain(MANUAL_STEPS_APP_CLOSING);
  });

  test("Busy: the message and Try again only; any other failure is none of these branches", () => {
    const message = "Another engine operation is running; try again in a moment.";
    expect(executeFailure({ kind: "busy", message })).toEqual({ kind: "busy", message, closing: null, buttons: ["Try again"] });
    for (const other of [
      { kind: "store", detail: "the app data dir could not be resolved" },
      { kind: "busy", running: "run" },
      { kind: "scheduleFailed" },
      "the IPC bridge is down",
      new Error("x"),
      null,
      undefined,
    ]) {
      expect(executeFailure(other)).toBeNull();
    }
  });

  /** One of the three errors, as `executeFailure` reads it. */
  const failed = (kind: ExecuteFailure["kind"]): ExecuteFailure => {
    const failure = executeFailure({ kind, message: `a ${kind} message` });
    if (failure === null) throw new Error(`executeFailure did not read ${kind}`);
    return failure;
  };

  test("checkpoint M6a (F4): what each error leaves the screen in — ScheduleForeign sets foreign, resets to Keep (clearing the boxes) and asks for a re-read; ScheduleFailed and Busy change nothing", () => {
    const starts = [
      { ...ticked, option: "removeAny", foreign: false, anyway: false },
      { ...ticked, option: "removeAny", foreign: true, anyway: false },
      { ...cleared, option: "keep", foreign: false, anyway: false },
      { removeEngineState: true, removeSettings: false, option: "removeAny", foreign: true, anyway: false },
      // "Uninstall anyway" was the form that sent the failed call.
      { ...ticked, option: "removeAny", foreign: false, anyway: true },
      { ...ticked, option: "keep", foreign: true, anyway: true },
    ] as const;
    for (const current of starts) {
      // ScheduleForeign: the refusal is itself the detection — the group always shows, Keep selected, which
      // clears the boxes (F1), the preview is re-read before the redraw, and "Uninstall anyway" is undone:
      // the group asks afresh.
      expect(stateAfterFailure(failed("scheduleForeign"), current)).toEqual({
        ...cleared,
        option: DEFAULT_SCHEDULER_OPTION,
        foreign: true,
        anyway: false,
        reread: true,
      });
      // ScheduleFailed and Busy: the panel answers them; the consent view's state is left as it was —
      // `foreign` included, so an earlier ScheduleForeign still shows the group, and `anyway` included, so
      // the view drawn while Try again is in flight is the form that sent the call — and no re-read.
      for (const kind of ["scheduleFailed", "busy"] as const) {
        expect(stateAfterFailure(failed(kind), current)).toEqual({ ...current, reread: false });
      }
    }
    expect(DEFAULT_SCHEDULER_OPTION).toBe("keep");
    // The redraw after ScheduleForeign, whatever the re-read finds: `foreign` still set, so the radio group
    // shows with Keep selected, and both boxes are unticked and disabled.
    const after = stateAfterFailure(failed("scheduleForeign"), { ...ticked, option: "removeAny", foreign: false, anyway: false });
    for (const reread of [quiet, appOwned, unchecked, cliOwned]) {
      const body = consentView({
        preview: reread,
        foreign: after.foreign,
        option: after.option,
        removeEngineState: after.removeEngineState,
        removeSettings: after.removeSettings,
      });
      expect(inputsOf(body, "radio").map((r) => flag(r, "checked"))).toEqual([true, false]);
      expect(inputsOf(body, "checkbox").map((b) => [flag(b, "checked"), flag(b, "disabled")])).toEqual([
        [false, true],
        [false, true],
      ]);
    }
  });

  test("checkpoint M6a follow-up: after the \"Uninstall anyway\" form's call answers ScheduleFailed or Busy, the view drawn while Try again is in flight is that form — no stale ticks, no scheduler line or radio group it is not sending", () => {
    // The user ticked both boxes (and, for a terminal scheduler, chose "Remove it"), then took "Uninstall
    // anyway", whose form sends keep. That call failed; Try again re-sends it (`lastArgs`) and, while it
    // is in flight, the consent view is drawn disabled from what `stateAfterFailure` left.
    for (const kind of ["scheduleFailed", "busy"] as const) {
      // A scheduler detected: the LOCKED form — the boxes unticked and disabled, and sent as false.
      for (const [preview, option] of [
        [appOwned, "keep"],
        [cliOwned, "removeAny"],
        [unitOnly, "keep"],
      ] as const) {
        const left = stateAfterFailure(failed(kind), { ...ticked, option, foreign: false, anyway: true });
        const retrying = consentView({ preview, busy: true, ...left });
        expect([kind, inputsOf(retrying, "checkbox").map((b) => [flag(b, "checked"), flag(b, "disabled")])]).toEqual([
          kind,
          [
            [false, true],
            [false, true],
          ],
        ]);
        // What it draws is what it sends: the keep form's sentence, never the app's "removed too" line
        // or a radio group still showing "Remove it", and a label that promises no files.
        const before = textBeforeButton(retrying);
        expect(before).toContain(uninstallAnyway(schedulerBranch(preview), ticked).sentence);
        expect(before).not.toContain("The background scheduler this app set up is removed too.");
        expect(inputsOf(retrying, "radio")).toEqual([]);
        expect(buttonsOf(retrying)[0]).toEqual(["danger", "Remove app pieces"]);
      }
      // Nothing detected: the UNLOCKED form, whose boxes are honoured — drawn as ticked, as sent.
      const left = stateAfterFailure(failed(kind), { ...ticked, option: "keep", foreign: false, anyway: true });
      const retrying = consentView({ preview: unchecked, busy: true, ...left });
      expect(inputsOf(retrying, "checkbox").map((b) => [flag(b, "checked"), flag(b, "disabled")])).toEqual([
        [true, true],
        [true, true],
      ]);
      expect(textBeforeButton(retrying)).toContain(uninstallAnyway(schedulerBranch(unchecked), ticked).sentence);
      expect(buttonsOf(retrying)[0]).toEqual(["danger", "Remove app pieces, engine data and settings"]);
    }
  });

  test("checkpoint M6a (F6): the ScheduleFailed panel says what \"Uninstall anyway\" does — the sentence its keep form then shows, in both forms; no other panel has one", () => {
    for (const [preview, foreign] of [
      [appOwned, false],
      [cliOwned, false],
      [unitOnly, false],
      [unreadable, false],
      [unchecked, false],
      [unreadableNothing, false],
      [quiet, false],
      [quiet, true],
    ] as const) {
      for (const consents of [ticked, cleared]) {
        const branch = schedulerBranch(preview, foreign);
        const note = anywayNote(failed("scheduleFailed"), branch, consents);
        expect(note).toBe(uninstallAnyway(branch, consents).sentence);
        // The same words the consent view draws once the button is clicked.
        expect(textBeforeButton(consentView({ preview, foreign, anyway: true, ...consents }))).toContain(note ?? "(none)");
      }
    }
    // Both forms are reachable: a scheduler detected, and nothing detected.
    expect(anywayNote(failed("scheduleFailed"), schedulerBranch(appOwned), ticked)).toContain("so your data and settings are kept");
    expect(anywayNote(failed("scheduleFailed"), schedulerBranch(unchecked), ticked)).toContain("Your ticked boxes still apply");
    // Busy has no "Uninstall anyway", and ScheduleForeign no panel of its own.
    for (const kind of ["busy", "scheduleForeign"] as const) {
      expect(anywayNote(failed(kind), schedulerBranch(appOwned), ticked)).toBeNull();
    }
  });
});

describe("Batch 2 (spec 3.6.3): the done screen's outcome line, \"Still on this machine\" and \"Removed\"", () => {
  const settingsAskedClean: SettingsReport = {
    asked: true,
    folder: "/h/.config/daily-briefing",
    keyFiles: [],
    keyRefsUnknown: false,
    removed: [],
    remaining: [],
    refused: null,
    error: null,
    notes: [],
  };
  const report: UninstallReport = {
    autostart: { result: "removed" },
    app: [],
    engineStateRemoved: false,
    engine: [],
    engineRefused: null,
    engineStateDir: null,
    engineError: null,
    scheduleRecordPresent: false,
    scheduleUnitFile: null,
    schedule: { outcome: "removed", leftover: [], leftoverCommands: [], removeSteps: null },
    engineCopies: [],
    settings: settingsAskedClean,
    os: "macos",
  };
  const withSchedule = (schedule: Partial<SchedulerReport>, os = "macos"): UninstallReport => ({
    ...report,
    os,
    schedule: { ...report.schedule, ...schedule },
  });
  const withSettings = (settings: Partial<SettingsReport>): UninstallReport => ({
    ...report,
    settings: { ...settingsAskedClean, ...settings },
  });
  const texts = (lines: StillLine[]) => lines.map((l) => l.text);
  // The engine's steps for NON-default paths, so they differ from the static copy and a substitution shows.
  const ENGINE_STEPS = manualRemoveSteps("launchd", { units: [PLIST], record: "/x/state/schedule.json", home: "/Users/x" });
  const CLOSING = { kind: "text", text: MANUAL_STEPS_APP_CLOSING } as const;
  /** The panel's required props (M9 LOW pass, L5: the uninstall ones have no default any more), each case
   *  overriding what it is about. */
  const PANEL_PROPS = {
    notify: null,
    autostart: null,
    onrefresh: () => {},
    os: "macos",
    uninstallReport: null,
    uninstallRunning: false,
    onuninstallstarted: () => {},
    onuninstallended: () => {},
  };

  test("M9 round 3: AppSettings draws the done screen from the report App passes down — so it survives Settings unmounting — and, while App says an execute runs, a mount that knows nothing of it says Working…", () => {
    const panel = (props: Record<string, unknown>): string =>
      render(AppSettings as never, { props: { ...PANEL_PROPS, ...props } }).body.replace(/<!--[\s\S]*?-->/g, "");
    const readableOf = (body: string): string =>
      body
        .replace(/<[^>]*>/g, " ")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&amp;/g, "&")
        .replace(/\s+/g, " ");
    /** The Uninstall block's own button: "Uninstall app…", or "Working…" while an execute runs. */
    const uninstallButton = (body: string) =>
      [...body.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)]
        .map((m) => ({ disabled: flag(m[1] ?? "", "disabled"), text: (m[2] ?? "").trim() }))
        .filter((b) => b.text === "Uninstall app…" || b.text === "Working…");
    // The report, from the prop alone: the done screen, its outcome line and its finish — and no first view.
    const done = readableOf(panel({ uninstallReport: report }));
    expect(done).toContain("Done. What happened to each piece:");
    expect(done).toContain(schedulerOutcomeLine("removed"));
    expect(done).toContain(finishLine("macos"));
    expect(done).not.toContain(UNINSTALL_EXPLANATION);
    expect(uninstallButton(panel({ uninstallReport: report }))).toEqual([]);
    // No report and nothing running: the first view, its button enabled.
    const first = panel({});
    expect(uninstallButton(first)).toEqual([{ disabled: false, text: "Uninstall app…" }]);
    expect(readableOf(first)).not.toContain("Done. What happened");
    expect(readableOf(first)).not.toContain(UNINSTALL_TIME_SENTENCE);
    // App's execute in flight, this mount knowing nothing of it (Settings remounted mid-run): Working…,
    // disabled, and how long it takes — never a fresh "Uninstall app…" beside a running execute.
    const running = panel({ uninstallRunning: true });
    expect(uninstallButton(running)).toEqual([{ disabled: true, text: "Working…" }]);
    expect(readableOf(running)).toContain(UNINSTALL_TIME_SENTENCE);
    // A report wins over the flag: the execute has ended.
    expect(readableOf(panel({ uninstallReport: report, uninstallRunning: true }))).toContain("Done. What happened to each piece:");
  });

  test("M9 round 4 (S2) + M9 LOW pass (L2): the done screen carries \"Uninstall again…\" — the way out its refusals and the closing line name — which opens the flow in its place WITHOUT clearing App's report: Cancel or a failed preview shows the done screen again, and the report is replaced only when the next execute starts", () => {
    const panel = (props: Record<string, unknown>): string =>
      render(AppSettings as never, { props: { ...PANEL_PROPS, ...props } }).body.replace(/<!--[\s\S]*?-->/g, "");
    const againButton = (body: string) =>
      [...body.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)]
        .map((m) => ({ disabled: flag(m[1] ?? "", "disabled"), text: (m[2] ?? "").trim() }))
        .filter((b) => b.text === "Uninstall again…");
    // On the done screen, enabled; on neither the first view nor the Working… one.
    expect(againButton(panel({ uninstallReport: report }))).toEqual([{ disabled: false, text: "Uninstall again…" }]);
    expect(againButton(panel({}))).toEqual([]);
    expect(againButton(panel({ uninstallRunning: true }))).toEqual([]);
    // What sends the user here: the two refusal rules and the app's closing line after manual steps.
    for (const text of [SCHEDULE_RECORD_RULE, SCHEDULE_UNIT_RULE, MANUAL_STEPS_APP_CLOSING]) expect(text).toContain("run Uninstall again");
    // Its handler (a click a server render cannot drive, so by source): the flow opens through the SAME function
    // "Uninstall app…" calls, and only a preview that LANDED draws it over the done screen — App is told nothing,
    // so a preview that fails leaves the done screen (and its manual steps) where they were, the error under it.
    const src = (rel: string) => readFileSync(join(ROOT, "gui", "src", rel), "utf8");
    const source = src("lib/AppSettings.svelte");
    expect(source).toContain("let againOpen = $state(false);");
    expect(source).toMatch(
      /async function uninstallAgain\(\): Promise<void> \{\s*if \(uninstallBusy \|\| uninstallRunning\) return;\s*await openUninstall\(\);\s*againOpen = uninstall !== null;\s*\}/,
    );
    // Cancel closes the flow and shows the done screen again; nothing else writes the flag.
    expect(source).toMatch(/function cancelUninstall\(\): void \{\s*uninstall = null;\s*resetConsent\(\);\s*uninstallError = "";\s*againOpen = false;\s*\}/);
    expect([...source.matchAll(/(?<!let )(?<![\w.])againOpen = ([^;]*);/g)].map((m) => m[1])).toEqual(["false", "uninstall !== null"]);
    const markup = source.slice(source.indexOf("</script>"));
    // The done screen keeps its precedence over everything but the flow "Uninstall again…" opened.
    const doneAt = markup.indexOf("{#if uninstallReport !== null && !againOpen}");
    expect(doneAt).toBeGreaterThan(-1);
    expect(markup.indexOf("{#if uninstallReport !== null}")).toBe(-1);
    const done = markup.slice(doneAt, markup.indexOf("{:else if uninstall === null}", doneAt)).replace(/<!--[\s\S]*?-->/g, "");
    // Disabled while a preview loads or an execute runs (the round-4 rule, kept).
    expect(done).toMatch(/<button disabled=\{uninstallBusy \|\| uninstallRunning\} onclick=\{\(\) => void uninstallAgain\(\)\}\s*>Uninstall again…<\/button\s*>/);
    // It comes after the finish line: what stays is still read before anything else is offered.
    expect(done.indexOf("Uninstall again…")).toBeGreaterThan(done.indexOf("{finishLine(report.os)}"));
    expect(markup).toContain("onclick={() => void openUninstall()}");
    // The preview's error is drawn after the whole if-chain, so it shows under the done screen too.
    expect(markup.slice(markup.lastIndexOf("{/if}", markup.indexOf('{#if uninstallError !== ""}')))).toMatch(
      /^\{\/if\}\s*\{#if uninstallError !== ""\}\s*<p class="bad">\{uninstallError\}<\/p>\s*\{\/if\}\s*<\/div>/,
    );
    // No callback of its own any more: App clears the report when the next execute STARTS, and nowhere else.
    const settings = src("routes/Settings.svelte");
    const app = src("App.svelte");
    for (const [name, text] of [["AppSettings", source], ["Settings", settings], ["App", app]] as const) {
      expect([name, text.includes("onuninstallagain")]).toEqual([name, false]);
    }
    const mount = app.slice(app.indexOf("<Settings"), app.indexOf("/>", app.indexOf("<Settings")));
    expect(mount).toMatch(/onuninstallstarted=\{\(\) => \{\s*wizardOffered = true;\s*uninstallRunning = true;\s*uninstallReport = null;\s*\}\}/);
    // The flow over a report sends the same execute: its start is said before the call, as for a first one.
    const run = source.slice(source.indexOf("async function runUninstall"), source.indexOf("function tryAgain"));
    expect(run.indexOf("onuninstallstarted();")).toBeLessThan(run.indexOf("await uninstallExecute("));
  });

  test("M9 round 4 (S3): when a report ARRIVES, App remounts Settings, so the config form, the app panel and the rest re-read what they show — and clearing the report (when the next execute starts) remounts nothing", () => {
    const src = (rel: string) => readFileSync(join(ROOT, "gui", "src", rel), "utf8");
    const app = src("App.svelte");
    const script = app.slice(0, app.indexOf("</script>"));
    // The key: a count of the reports that arrived, bumped only beside the report itself.
    expect(script).toContain("let uninstallReportSeq = $state(0);");
    expect([...app.matchAll(/(?<![\w.])uninstallReportSeq \+= 1;/g)].length).toBe(1);
    expect([...app.matchAll(/(?<!let )(?<![\w.])uninstallReportSeq = /g)].length).toBe(0);
    const mountAt = app.indexOf("<Settings");
    const mount = app.slice(mountAt, app.indexOf("/>", mountAt));
    // (M9 LOW pass, L1: the arrival also latches `settingsRemovedByUninstall` — "M9 LOW pass (L1)" below.)
    expect(mount).toMatch(
      /onuninstallended=\{\(report\) => \{\s*uninstallRunning = false;\s*if \(report !== null\) \{\s*uninstallReport = report;\s*if \(report\.settings\.removed\.includes\("config\.json"\)\) settingsRemovedByUninstall = true;\s*uninstallReportSeq \+= 1;\s*\}\s*\}\}/,
    );
    // Settings sits inside `{#key uninstallReportSeq}` and alone in it.
    const keyAt = app.lastIndexOf("{#key uninstallReportSeq}", mountAt);
    expect(keyAt).toBeGreaterThan(-1);
    expect(app.slice(keyAt + "{#key uninstallReportSeq}".length, mountAt).trim()).toBe("");
    const closeAt = app.indexOf("/>", mountAt) + 2;
    expect(app.slice(closeAt).trimStart().startsWith("{/key}")).toBe(true);
    // Clearing the report is not an arrival: the start callback, which clears it (M9 LOW pass, L2), bumps no key
    // — a remount there would take away the very flow whose execute is starting.
    const startAt = mount.indexOf("onuninstallstarted=");
    expect(startAt).toBeGreaterThan(-1);
    const started = mount.slice(startAt, mount.indexOf("}}", startAt));
    expect(started).toContain("uninstallReport = null;");
    expect(started).not.toContain("uninstallReportSeq");
    // What a remount re-reads: Settings' mount loads the app panel, the update panel and the config.
    const settings = src("routes/Settings.svelte");
    expect(settings).toMatch(/onMount\(\(\) => \{\s*void loadApp\(\);\s*void loadUpdate\(\);\s*const k = takeKeptSettings\(\);\s*if \(k === null\) \{\s*void load\(false\);/);
  });

  test("M9 LOW pass (L1): after a consented settings removal, Settings' no-config sentence sends the user to what still works — never to the Setup wizard, whose save the session's latch refuses", () => {
    const src = (rel: string) => readFileSync(join(ROOT, "gui", "src", rel), "utf8");
    const readableOf = (markup: string): string =>
      markup
        .replace(/<!--[\s\S]*?-->/g, "")
        .replace(/<[^>]*>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    // App latches the fact for the SESSION, as Rust's `settings_removed` latch is never cleared
    // (`config_save.rs`, `refuse_if_settings_removed` — `config_create`, which the wizard calls, included): set
    // when a report arrives whose settings step removed config.json, and never set back — not by the next
    // execute's start, which replaces the report, nor by a route change.
    const app = src("App.svelte");
    const script = app.slice(0, app.indexOf("</script>"));
    expect(script).toContain("let settingsRemovedByUninstall = $state(false);");
    expect([...app.matchAll(/(?<!let )(?<![\w.])settingsRemovedByUninstall = ([^;)]*)/g)].map((m) => m[1])).toEqual(["true"]);
    expect(app).toMatch(/if \(report\.settings\.removed\.includes\("config\.json"\)\) settingsRemovedByUninstall = true;/);
    const effect = script.slice(script.indexOf("$effect(() => {"), script.indexOf("});", script.indexOf("$effect(() => {")));
    expect(effect).not.toContain("settingsRemovedByUninstall");
    const mount = app.slice(app.indexOf("<Settings"), app.indexOf("/>", app.indexOf("<Settings")));
    expect(mount).toContain("{settingsRemovedByUninstall}");
    // Settings: both sentences, as the user reads them. The branch is drawn only once the config read in
    // `onMount` has landed (`doc`), which a server render never runs, so the two are read from the markup — each
    // branch's text, tags dropped — rather than rendered.
    const settings = src("routes/Settings.svelte");
    const markup = settings.slice(settings.indexOf("</script>"));
    const at = markup.indexOf("{#if !doc.exists}");
    expect(at).toBeGreaterThan(-1);
    const branch = markup.slice(at + "{#if !doc.exists}".length, markup.indexOf("{:else if doc.parseError !== null}", at));
    const m = /^\s*\{#if settingsRemovedByUninstall\}([\s\S]*?)\{:else\}([\s\S]*?)\{\/if\}\s*$/.exec(branch);
    expect(m).not.toBeNull();
    expect(readableOf(m![1]!)).toBe(
      "Your settings were removed by Uninstall. To set up again, quit and reopen the app, or run daily-briefing init in a terminal.",
    );
    expect(m![1]).toContain("<code>daily-briefing init</code>");
    expect(readableOf(m![1]!)).not.toContain("Setup");
    // Otherwise, today's sentence, unchanged.
    expect(readableOf(m![2]!)).toBe(
      "There is no config at this path yet. The Setup wizard creates one (press Setup in the header); alternatively " +
        "run daily-briefing init in a terminal. This screen edits an existing config and does not create one.",
    );
  });

  test("M9 LOW pass (L5): the uninstall props are REQUIRED, with no default, in AppSettings and Settings — a mount that forgets one fails svelte-check instead of silently showing no done screen", () => {
    const src = (rel: string) => readFileSync(join(ROOT, "gui", "src", rel), "utf8");
    const props: Record<string, [name: string, type: string][]> = {
      "lib/AppSettings.svelte": [
        ["uninstallReport", "UninstallReport | null"],
        ["uninstallRunning", "boolean"],
        ["onuninstallstarted", "() => void"],
        ["onuninstallended", "(report: UninstallReport | null) => void"],
      ],
      "routes/Settings.svelte": [
        ["uninstallReport", "UninstallReport | null"],
        ["uninstallRunning", "boolean"],
        ["onuninstallstarted", "() => void"],
        ["onuninstallended", "(report: UninstallReport | null) => void"],
        ["settingsRemovedByUninstall", "boolean"],
      ],
    };
    for (const [rel, list] of Object.entries(props)) {
      const text = src(rel);
      const end = text.indexOf("$props()");
      const destructure = text.slice(text.lastIndexOf("let {", end), end);
      for (const [name, type] of list) {
        expect({
          rel,
          name,
          required: text.includes(`\n    ${name}: ${type};\n`),
          optional: new RegExp(`\\n    ${name}\\?:`).test(text),
          destructured: new RegExp(`\\n    ${name},\\n`).test(destructure),
          defaulted: new RegExp(`\\b${name}\\s*=`).test(destructure),
        }).toEqual({ rel, name, required: true, optional: false, destructured: true, defaulted: false });
      }
    }
    // …and every one is passed: App to Settings, Settings to the panel.
    const tag = (text: string, open: string): string => text.slice(text.indexOf(open), text.indexOf("/>", text.indexOf(open)));
    const mount = tag(src("App.svelte"), "<Settings");
    for (const name of ["uninstallReport", "uninstallRunning", "settingsRemovedByUninstall"]) expect([name, mount.includes(`{${name}}`)]).toEqual([name, true]);
    for (const name of ["onuninstallstarted=", "onuninstallended="]) expect([name, mount.includes(name)]).toEqual([name, true]);
    const panelTag = tag(src("routes/Settings.svelte"), "<AppSettings");
    for (const name of ["uninstallReport", "uninstallRunning", "onuninstallstarted", "onuninstallended"]) {
      expect([name, panelTag.includes(`{${name}}`)]).toEqual([name, true]);
    }
  });

  test("the outcome line: one for each of the four outcomes, never repeated inside \"Still on this machine\"", () => {
    const lines: Record<SchedulerOutcome, string> = {
      removed: "Background scheduler: removed",
      absent: "Background scheduler: none was found",
      kept: "Background scheduler: kept",
      notChecked: "Background scheduler: not checked — the check couldn't run",
    };
    for (const [outcome, line] of Object.entries(lines) as [SchedulerOutcome, string][]) {
      expect(schedulerOutcomeLine(outcome)).toBe(line);
      const still = texts(stillOnThisMachine(withSchedule({ outcome, leftover: ["/x/state/schedule.json"], removeSteps: ENGINE_STEPS })));
      expect(still.some((t) => t.includes(line))).toBe(false);
    }
    expect(new Set(Object.values(lines)).size).toBe(4);
  });

  test("\"Still on this machine\" for each outcome: removed and absent with nothing left say nothing; kept and notChecked give the scheduler and its steps, then the app's closing line once", () => {
    expect(stillOnThisMachine(withSchedule({ outcome: "removed", removeSteps: ENGINE_STEPS }))).toEqual([]);
    expect(stillOnThisMachine(withSchedule({ outcome: "absent", removeSteps: ENGINE_STEPS }))).toEqual([]);
    expect(stillOnThisMachine(withSchedule({ outcome: "kept", removeSteps: ENGINE_STEPS }))).toEqual([
      { kind: "text", text: "Background scheduler: still set up" },
      { kind: "code", text: ENGINE_STEPS },
      CLOSING,
    ]);
    expect(stillOnThisMachine(withSchedule({ outcome: "notChecked", removeSteps: ENGINE_STEPS }))).toEqual([
      { kind: "text", text: "Background scheduler: any that may exist is still set up" },
      { kind: "code", text: ENGINE_STEPS },
      CLOSING,
    ]);
    // Any leftover, whatever the outcome: what the gate look still saw is named, with the steps.
    for (const outcome of ["removed", "absent", "kept"] as const) {
      expect(
        stillOnThisMachine(
          withSchedule({ outcome, leftover: ["/x/state/schedule.json", PLIST], removeSteps: ENGINE_STEPS }),
        ),
      ).toEqual([
        { kind: "text", text: `Background scheduler: /x/state/schedule.json, ${PLIST}` },
        { kind: "code", text: ENGINE_STEPS },
        CLOSING,
      ]);
    }
  });

  test("the static per-OS steps stand in when removeSteps is null (spec 3.3.6); where there is no copy, no steps and no closing line", () => {
    const mac = stillOnThisMachine(withSchedule({ outcome: "kept", removeSteps: null }));
    expect(mac).toEqual([
      { kind: "text", text: "Background scheduler: still set up" },
      { kind: "code", text: staticRemoveSteps("macos") },
      CLOSING,
    ]);
    const linux = stillOnThisMachine(withSchedule({ outcome: "notChecked", removeSteps: null }, "linux"));
    expect(linux[1]).toEqual({ kind: "code", text: staticRemoveSteps("linux") });
    expect(staticRemoveSteps("macos")).not.toBe(staticRemoveSteps("linux"));
    expect(staticRemoveSteps("windows")).toBeNull();
    expect(stillOnThisMachine(withSchedule({ outcome: "kept", removeSteps: null }, "windows"))).toEqual([
      { kind: "text", text: "Background scheduler: still set up" },
    ]);
  });

  test("a leftover with leftoverCommands: each command follows the steps, and the closing line follows them, once", () => {
    const UNIT = "/x/my cfg/systemd/user/daily-briefing.timer";
    const COMMAND = "XDG_CONFIG_HOME='/x/my cfg' daily-briefing schedule uninstall";
    const linuxSteps = manualRemoveSteps("systemd", {
      units: ["/h/.config/systemd/user/daily-briefing.timer"],
      record: "/h/.local/state/daily-briefing/schedule.json",
      home: "/h",
    });
    const still = stillOnThisMachine(
      withSchedule({ outcome: "absent", leftover: [UNIT], leftoverCommands: [COMMAND], removeSteps: linuxSteps }, "linux"),
    );
    expect(still).toEqual([
      { kind: "text", text: `Background scheduler: ${UNIT}` },
      { kind: "code", text: linuxSteps },
      { kind: "code", text: COMMAND },
      CLOSING,
    ]);
    // The same with the status read failed: the static steps, then the command.
    expect(
      stillOnThisMachine(
        withSchedule({ outcome: "absent", leftover: [UNIT], leftoverCommands: [COMMAND, `${COMMAND} # 2`], removeSteps: null }, "linux"),
      ),
    ).toEqual([
      { kind: "text", text: `Background scheduler: ${UNIT}` },
      { kind: "code", text: staticRemoveSteps("linux") },
      { kind: "code", text: COMMAND },
      { kind: "code", text: `${COMMAND} # 2` },
      CLOSING,
    ]);
    expect(texts(still).filter((t) => t === MANUAL_STEPS_APP_CLOSING)).toHaveLength(1);
  });

  test("settings not asked: the folder that stays is named under \"Still on this machine\", and nothing of the settings under \"Removed\"", () => {
    const notAsked = withSettings({ asked: false, folder: "/h/.config/daily-briefing" });
    expect(stillOnThisMachine(notAsked)).toEqual([{ kind: "text", text: "Your settings folder: /h/.config/daily-briefing" }]);
    expect(removedList(notAsked)).toEqual([]);
    expect(texts(stillOnThisMachine(withSettings({ asked: false, folder: null })))).toEqual([
      "Your settings folder (the engine couldn't say where it is)",
    ]);
  });

  test("where each key-file outcome lands: removed and absent under \"Removed\", kept and failed under \"Still on this machine\"", () => {
    const done = withSettings({
      keyFiles: [
        { path: "/h/.config/daily-briefing/key", outcome: "removed", reason: null },
        { path: "/h/.config/daily-briefing/old-key", outcome: "absent", reason: null },
        { path: "/elsewhere/key", outcome: "kept", reason: "it isn't in the settings folder" },
        { path: "/h/.config/daily-briefing/linked", outcome: "removed", reason: "another link to the same file still exists" },
        { path: "/h/.config/daily-briefing/CONFIG.JSON.BAK", outcome: "removed", reason: "handled with config.json.bak below" },
      ],
      removed: ["config.json", "config.json.bak"],
    });
    expect(removedList(done)).toEqual([
      "API key file removed (/h/.config/daily-briefing/key)",
      "API key file was already gone (/h/.config/daily-briefing/old-key)",
      "API key file removed (/h/.config/daily-briefing/linked); another link to the same file still exists",
      "API key file removed (/h/.config/daily-briefing/CONFIG.JSON.BAK); handled with config.json.bak below",
      "Settings file removed (config.json)",
      "Settings file removed (config.json.bak)",
    ]);
    expect(stillOnThisMachine(done)).toEqual([
      { kind: "text", text: "Key file kept: it isn't in the settings folder (/elsewhere/key)" },
    ]);
    // A key file that would not unlink stops the leg: it and the configs stay, and the rest is not tried.
    const error =
      "the API key file /h/.config/daily-briefing/stuck couldn't be removed, so config.json and config.json.bak were " +
      "kept: they name it, so another Uninstall can still find it";
    const stopped = withSettings({
      keyFiles: [
        { path: "/h/.config/daily-briefing/stuck", outcome: "failed", reason: "Operation not permitted (os error 1)" },
        {
          path: "/h/.config/daily-briefing/second",
          outcome: "kept",
          reason: "not removed: the settings removal stopped at an API key file that couldn't be removed",
        },
      ],
      remaining: ["config.json", "config.json.bak", "second", "stuck"],
      error,
    });
    expect(texts(stillOnThisMachine(stopped))).toEqual([
      `Settings: ${error}`,
      "Key file couldn't be removed: Operation not permitted (os error 1) (/h/.config/daily-briefing/stuck)",
      "Key file kept: not removed: the settings removal stopped at an API key file that couldn't be removed " +
        "(/h/.config/daily-briefing/second)",
      "In your settings folder (/h/.config/daily-briefing): config.json, config.json.bak, second, stuck",
    ]);
    expect(removedList(stopped)).toEqual([]);
    // Every path lands on one side only.
    for (const r of [done, stopped]) {
      for (const key of r.settings.keyFiles) {
        const inRemoved = removedList(r).some((l) => l.includes(`(${key.path})`));
        const inStill = texts(stillOnThisMachine(r)).some((l) => l.includes(`(${key.path})`));
        expect([key.outcome, inRemoved, inStill]).toEqual([
          key.outcome,
          key.outcome === "removed" || key.outcome === "absent",
          key.outcome === "kept" || key.outcome === "failed",
        ]);
      }
    }
  });

  test("no key file named: said once, under \"Removed\"; keyRefsUnknown: said under \"Still on this machine\", before the names it points to", () => {
    expect(removedList(withSettings({ removed: ["config.json"] }))).toEqual([
      "No key file is named in your settings.",
      "Settings file removed (config.json)",
    ]);
    const unknown = withSettings({ keyRefsUnknown: true, removed: ["config.json"], remaining: ["mystery-key"] });
    expect(texts(stillOnThisMachine(unknown))).toEqual([
      "A settings file couldn't be read, so its key file couldn't be identified; check the names below.",
      "In your settings folder (/h/.config/daily-briefing): mystery-key",
    ]);
    // Unknown is not "none named".
    expect(removedList(unknown)).toEqual(["Settings file removed (config.json)"]);
  });

  // Spec 3.5.3's notes, each kind as Rust writes it (`uninstall.rs`'s note builders; the §16 build
  // corrections' wordings), pinned to Rust's own words in "the settings notes' fixed words are Rust's".
  const KEPT_LINK = "config.json was a link to /dotfiles/config.json; that file was kept and may hold your API key.";
  const KEY_LINK = "config.json.bak was a link to /h/.config/daily-briefing/api-key, which was removed as your API key file.";
  const DANGLING_LINK = "config.json was a link to /dotfiles/gone.json, which isn't there.";
  const OTHER_CONFIG_LINK = "config.json.bak was a link to config.json, which isn't there.";
  const OTHER_LINK = "config.json removed; another link to the same file still exists";
  const STAGED_A = ".config.json.save-11-1";
  const STAGED_B = ".config.json.save-22-1.bak";
  const STAGED = `${STAGED_A}, ${STAGED_B}: staged copies of earlier settings, which may hold a key`;

  test("checkpoint M6a (F2): each settings note is said once, where it belongs — a target that is GONE with the removals, what remains under \"Still on this machine\"", () => {
    // A linked config whose target is gone (removed as the key file, dangling, or the other config): a
    // removal's note, under "Removed", after the settings names — never under "Still on this machine".
    for (const gone of [KEY_LINK, DANGLING_LINK, OTHER_CONFIG_LINK]) {
      const done = withSettings({ removed: ["config.json", "config.json.bak"], notes: [gone] });
      expect([gone, removedList(done)]).toEqual([
        gone,
        ["No key file is named in your settings.", "Settings file removed (config.json)", "Settings file removed (config.json.bak)", gone],
      ]);
      expect([gone, texts(stillOnThisMachine(done))]).toEqual([gone, []]);
    }
    // What remains — a kept link target, another link still holding a removed config — under "Still on this
    // machine", and nowhere under "Removed".
    for (const kept of [KEPT_LINK, OTHER_LINK]) {
      const done = withSettings({ removed: ["config.json"], notes: [kept] });
      expect([kept, texts(stillOnThisMachine(done))]).toEqual([kept, [kept]]);
      expect([kept, removedList(done).includes(kept)]).toEqual([kept, false]);
    }
    // A note this screen does not know (a newer Rust's) stays where every note used to: what may remain.
    const unknown = "config.json was something new.";
    expect(texts(stillOnThisMachine(withSettings({ notes: [unknown] })))).toEqual([unknown]);
  });

  test("checkpoint M6a (F2): the staged copies are said ONCE — one line in the folder's list, naming them with their description", () => {
    // Only staged copies left: the folder's line IS their one line.
    const only = withSettings({ removed: ["config.json"], remaining: [STAGED_A, STAGED_B], notes: [STAGED] });
    expect(texts(stillOnThisMachine(only))).toEqual([`In your settings folder (/h/.config/daily-briefing): ${STAGED}`]);
    // With other names: those first, then the staged copies with their description — still one line.
    const mixed = withSettings({
      keyRefsUnknown: true,
      removed: ["config.json"],
      remaining: [STAGED_A, STAGED_B, "mystery-key"],
      notes: [STAGED, KEPT_LINK],
    });
    expect(texts(stillOnThisMachine(mixed))).toEqual([
      "A settings file couldn't be read, so its key file couldn't be identified; check the names below.",
      `In your settings folder (/h/.config/daily-briefing): mystery-key; ${STAGED}`,
      KEPT_LINK,
    ]);
    // Each staged name, and the description, appears exactly once on the whole done screen.
    for (const report of [only, mixed]) {
      const screen = [...removedList(report), ...texts(stillOnThisMachine(report))].join("\n");
      for (const said of [STAGED_A, STAGED_B, STAGED_COPIES_NOTE]) {
        expect([said, screen.split(said).length - 1]).toEqual([said, 1]);
      }
    }
  });

  test("checkpoint M6a (F2): every note kind in one report — each lands on one side only, and once", () => {
    const all = withSettings({
      keyFiles: [{ path: "/h/.config/daily-briefing/api-key", outcome: "removed", reason: null }],
      removed: ["config.json", "config.json.bak"],
      remaining: [STAGED_A, STAGED_B],
      notes: [KEY_LINK, OTHER_LINK, STAGED],
    });
    expect(removedList(all)).toEqual([
      "API key file removed (/h/.config/daily-briefing/api-key)",
      "Settings file removed (config.json)",
      "Settings file removed (config.json.bak)",
      KEY_LINK,
    ]);
    expect(texts(stillOnThisMachine(all))).toEqual([`In your settings folder (/h/.config/daily-briefing): ${STAGED}`, OTHER_LINK]);
    const screen = [...removedList(all), ...texts(stillOnThisMachine(all))].join("\n");
    for (const note of all.settings.notes) expect([note, screen.split(note).length - 1]).toEqual([note, 1]);
  });

  test("M9 LOW pass (L7): a linked config Rust KEPT — a key file that would not unlink stopped the leg, or its own unlink failed — has its note too, under \"Still on this machine\" even when its target is gone, because the link itself is still there", () => {
    // Target still there: spec 3.5.3's own words, as for a removed link — what remains.
    const kept = withSettings({ remaining: ["config.json"], error: "config.json couldn't be removed (EPERM)", notes: [KEPT_LINK] });
    expect(texts(stillOnThisMachine(kept))).toContain(KEPT_LINK);
    expect(removedList(kept)).not.toContain(KEPT_LINK);
    // Target gone: a removal's note only when the config it names WAS removed (checkpoint M6a F2, as before);
    // a kept config's stays with what remains.
    for (const gone of [KEY_LINK, DANGLING_LINK, OTHER_CONFIG_LINK]) {
      const name = gone.slice(0, gone.indexOf(" was a link to "));
      expect(["config.json", "config.json.bak"]).toContain(name);
      const stays = withSettings({ remaining: [name], notes: [gone] });
      expect([gone, texts(stillOnThisMachine(stays)).includes(gone), removedList(stays).includes(gone)]).toEqual([gone, true, false]);
      const went = withSettings({ removed: [name], notes: [gone] });
      expect([gone, texts(stillOnThisMachine(went)).includes(gone), removedList(went).includes(gone)]).toEqual([gone, false, true]);
    }
    // The other config's removal does not count for this one: "config.json" is no prefix of "config.json.bak …".
    const other = withSettings({ removed: ["config.json"], remaining: ["config.json.bak"], notes: [KEY_LINK] });
    expect([texts(stillOnThisMachine(other)).includes(KEY_LINK), removedList(other).includes(KEY_LINK)]).toEqual([true, false]);
  });

  test("M9 LOW pass (L21): a staged-copies note counts only the names that ARE staged copies — a name holding \", \" can no longer hide a real file from the folder's line", () => {
    // Rust joins the staged names with ", " (`staged_copies_note`), so a staged copy whose own name holds ", "
    // splits into pieces; only a piece that starts with the staged prefix (`config_save::staged_prefix`) is one.
    const ODD = ".config.json.save-x, api.key";
    const note = `${ODD}: ${STAGED_COPIES_NOTE}`;
    const odd = withSettings({ removed: ["config.json"], remaining: [ODD, "api.key"], notes: [note] });
    expect(texts(stillOnThisMachine(odd))).toEqual([
      `In your settings folder (/h/.config/daily-briefing): ${ODD}, api.key; ${note}`,
    ]);
    // The real survivor is named on its own, outside the note.
    const line = texts(stillOnThisMachine(odd))[0]!;
    expect(line.slice(0, line.indexOf("; ")).split(", ")).toContain("api.key");
    // The ordinary case is unchanged: the staged copies are said once, by their note.
    const plain = withSettings({ removed: ["config.json"], remaining: [STAGED_A, STAGED_B, "api.key"], notes: [STAGED] });
    expect(texts(stillOnThisMachine(plain))).toEqual([`In your settings folder (/h/.config/daily-briefing): api.key; ${STAGED}`]);
    // The prefix is Rust's: `staged_prefix` over the settings config's name, which the leg's note is built from.
    const ts = readFileSync(join(ROOT, "gui", "src", "lib", "app-uninstall.ts"), "utf8");
    expect(ts).toContain('const STAGED_PREFIX = ".config.json.save-";');
    const saver = readFileSync(join(ROOT, "gui", "src-tauri", "src", "config_save.rs"), "utf8");
    expect(saver).toMatch(/pub fn staged_prefix\(config_name: &str\) -> String \{\s*format!\("\.\{config_name\}\.save-"\)\s*\}/);
    const rust = readFileSync(join(ROOT, "gui", "src-tauri", "src", "uninstall.rs"), "utf8");
    expect(rust).toContain("config_save::staged_prefix(SETTINGS_CONFIG)");
    expect(rust).toContain('pub const SETTINGS_CONFIG: &str = "config.json";');
  });

  test("checkpoint M6a (F2): the settings notes' fixed words are Rust's — the done screen places each note by them", () => {
    const rust = readFileSync(join(ROOT, "gui", "src-tauri", "src", "uninstall.rs"), "utf8");
    const fnBody = (name: string): string => {
      const at = rust.indexOf(`fn ${name}(`);
      expect([name, at > -1]).toEqual([name, true]);
      return rust.slice(at, rust.indexOf("\n}\n", at));
    };
    // The staged copies: the description, and the note's shape — the names, a colon, the description.
    const staged = rust.match(/pub const STAGED_COPIES_NOTE: &str =\s*"((?:[^"\\]|\\[\s\S])*)";/);
    expect((staged?.[1] ?? "").replace(/\\\n\s*/g, "")).toBe(STAGED_COPIES_NOTE);
    expect(fnBody("staged_copies_note")).toContain('format!("{}: {STAGED_COPIES_NOTE}", names.join(", "))');
    // A linked config whose target is GONE: "<name> was a link to <target>, which <what>.", with Rust's two
    // `what`s — the §16 build correction's wordings — and no other.
    const linked = fnBody("linked_config_note");
    expect(linked).toContain('format!("{name} was a link to {}, which {what}.", target.display())');
    expect([...linked.matchAll(/^\s*"([^"]*)"\s*$/gm)].map((m) => m[1])).toEqual([...LINK_TARGET_GONE]);
    // A target that is still there keeps spec 3.5.3's own words, which end otherwise, so it never reads as gone.
    expect(fnBody("config_link_note")).toContain('"{name} was a link to {}; that file was kept and may hold your API key."');
    expect(fnBody("config_other_link_note")).toContain('format!("{name} removed; {OTHER_LINK_NOTE}")');
    // Every note Rust writes comes from one of these four builders (the linked one falling back to the kept
    // one), so no note kind reaches the done screen without a place decided for it here.
    const pushes = rust.split(".notes.push(").length - 1;
    const pushed = [...rust.matchAll(/\.notes\.push\((\w+)\(/g)].map((m) => m[1]);
    expect(pushed.length).toBe(pushes);
    expect(pushed.sort()).toEqual(["config_other_link_note", "linked_config_note", "staged_copies_note"]);
    expect(linked).toContain("_ => config_link_note(name, target),");
  });

  test("a refused settings step leads with its refusal, the unknown folder after it; a step that could not run says why", () => {
    const refused = withSettings({ folder: null, refused: REFUSED_FOR_KEPT_SCHEDULER, error: "status --json exited 2" });
    expect(texts(stillOnThisMachine(refused))).toEqual([
      `Settings: nothing removed — ${REFUSED_FOR_KEPT_SCHEDULER} The engine also couldn't say where they are ` +
        "(status --json exited 2).",
    ]);
    expect(removedList(refused)).toEqual([]);
    expect(texts(stillOnThisMachine(withSettings({ refused: "The settings folder is a link to /dotfiles; nothing inside it was removed." })))).toEqual([
      "Settings: nothing removed — The settings folder is a link to /dotfiles; nothing inside it was removed.",
    ]);
    // The step could not run at all (the configPath unknown).
    expect(texts(stillOnThisMachine(withSettings({ folder: null, error: "status --json exited 2" })))).toEqual([
      "Settings: status --json exited 2",
    ]);
  });

  test("the Linux engine copies: kept and failed ones under \"Still on this machine\", a removed one under \"Removed\", one not there under neither", () => {
    const copies: UninstallReport = {
      ...report,
      os: "linux",
      engineCopies: [
        { path: "~/.local/share/daily-briefing/bin/daily-briefing", outcome: "kept", reason: "not asked" },
        { path: "/data/daily-briefing/bin/daily-briefing", outcome: "removed", reason: null },
        { path: "/xdg/daily-briefing/bin/daily-briefing", outcome: "absent", reason: null },
        { path: "/other/daily-briefing/bin/daily-briefing", outcome: "failed", reason: "Permission denied (os error 13)" },
        { path: "/kept/daily-briefing/bin/daily-briefing", outcome: "kept", reason: REFUSED_FOR_KEPT_SCHEDULER },
      ],
    };
    expect(texts(stillOnThisMachine(copies))).toEqual([
      "Engine copy kept: not asked (~/.local/share/daily-briefing/bin/daily-briefing)",
      "Engine copy couldn't be removed: Permission denied (os error 13) (/other/daily-briefing/bin/daily-briefing)",
      `Engine copy kept: ${REFUSED_FOR_KEPT_SCHEDULER} (/kept/daily-briefing/bin/daily-briefing)`,
    ]);
    expect(removedList(copies)).toEqual([
      "No key file is named in your settings.",
      "Engine copy removed (/data/daily-briefing/bin/daily-briefing)",
    ]);
  });

  test("the whole block, in spec 3.6.3's order: the scheduler and its steps, then the settings, then the kept copies", () => {
    const all: UninstallReport = {
      ...withSchedule({ outcome: "kept", removeSteps: ENGINE_STEPS }, "linux"),
      settings: { ...settingsAskedClean, asked: false },
      engineCopies: [{ path: "~/.local/share/daily-briefing/bin/daily-briefing", outcome: "kept", reason: REFUSED_FOR_KEPT_SCHEDULER }],
    };
    expect(texts(stillOnThisMachine(all))).toEqual([
      "Background scheduler: still set up",
      ENGINE_STEPS,
      MANUAL_STEPS_APP_CLOSING,
      "Your settings folder: /h/.config/daily-briefing",
      `Engine copy kept: ${REFUSED_FOR_KEPT_SCHEDULER} (~/.local/share/daily-briefing/bin/daily-briefing)`,
    ]);
  });

  test("each thing is said once (spec 3.6.3): a settings refusal, or a kept copy's reason, that IS the engine data's refusal points at it instead of repeating it", () => {
    const REFUSAL = "a background schedule's record (schedule.json) is still there, and …";
    const COPY = "~/.local/share/daily-briefing/bin/daily-briefing";
    const both: UninstallReport = {
      ...report,
      os: "linux",
      engineRefused: REFUSAL,
      settings: { ...settingsAskedClean, refused: REFUSAL },
      engineCopies: [{ path: COPY, outcome: "kept", reason: REFUSAL }],
    };
    expect(engineDataLine(both)).toBe(`engine data: nothing removed — ${REFUSAL}`);
    expect(texts(stillOnThisMachine(both))).toEqual([
      "Settings: nothing removed, for the same reason as the engine data.",
      `Engine copy kept, for the same reason as the engine data (${COPY})`,
    ]);
    // The refusal is on the done screen exactly once.
    const screen = [engineDataLine(both) ?? "", ...texts(stillOnThisMachine(both)), ...removedList(both)].join("\n");
    expect(screen.split(REFUSAL).length - 1).toBe(1);
    // With the settings folder unknown too, the sentence after it still reads.
    expect(
      texts(stillOnThisMachine({ ...both, settings: { ...both.settings, error: "status --json exited 2" } })).slice(0, 1),
    ).toEqual([
      "Settings: nothing removed, for the same reason as the engine data. The engine also couldn't say where they are " +
        "(status --json exited 2).",
    ]);
    // A different reason — the engine box unticked, so no engine refusal on screen — is said in full.
    expect(texts(stillOnThisMachine({ ...both, engineRefused: null }))).toEqual([
      `Settings: nothing removed — ${REFUSAL}`,
      `Engine copy kept: ${REFUSAL} (${COPY})`,
    ]);
  });

  test("checkpoint note (a): engine data refused AND its folder unknown is ONE line, led by the refusal — \"not removed\" is not said twice", () => {
    const both = { ...report, engineRefused: REFUSED_FOR_KEPT_SCHEDULER, engineError: "status --json exited 2" };
    expect(engineDataLine(both)).toBe(
      `engine data: nothing removed — ${REFUSED_FOR_KEPT_SCHEDULER} The engine also couldn't say where its data ` +
        "lives (status --json exited 2).",
    );
    expect(engineDataLine(both)).not.toContain("not removed —");
    expect(engineDataLine({ ...report, engineRefused: REFUSED_FOR_KEPT_SCHEDULER })).toBe(
      `engine data: nothing removed — ${REFUSED_FOR_KEPT_SCHEDULER}`,
    );
    expect(engineDataLine({ ...report, engineError: "status --json exited 2" })).toBe(
      "engine data: not removed — status --json exited 2",
    );
    expect(engineDataLine(report)).toBeNull();
  });
});

/* ── 9. Batch 2: the pins beside the helpers (spec 3.3.2, 3.3.6, 3.1.3) ─────────────────────────── */

describe("Batch 2: the static steps, the GUI runner's engine imports, and the execute call's arguments", () => {
  test("the static per-OS steps are the engine's own manualRemoveSteps output for the default paths — literally, whatever the home", () => {
    // The default paths, built the way the engine builds them: the plist under ~/Library/LaunchAgents,
    // the units under ~/.config/systemd/user (service first, as `unitPaths` lists them), and the record
    // in the engine's own default state folder.
    for (const home of ["/Users/a", "/home/some one"]) {
      const mac = manualRemoveSteps("launchd", {
        units: [join(home, "Library", "LaunchAgents", "local.daily-briefing.plist")],
        record: join(stateDirFor("darwin", {}, home), "schedule.json"),
        home,
      });
      expect(staticRemoveSteps("macos")).toBe(mac);
      const units = join(home, ".config", "systemd", "user");
      const linux = manualRemoveSteps("systemd", {
        units: [join(units, "daily-briefing.service"), join(units, "daily-briefing.timer")],
        record: join(stateDirFor("linux", {}, home), "schedule.json"),
        home,
      });
      expect(staticRemoveSteps("linux")).toBe(linux);
    }
    // Steps only: the closing line is each surface's own, added once by the done screen.
    for (const os of ["macos", "linux"]) expect(staticRemoveSteps(os)).not.toContain("Then ");
  });

  // ⚠ THE IMPORT PIN (spec r10 3.1.3, "The GUI test runner"; plan T6.1). `gui/package.json` preloads only
  // `./tests-web/svelte-loader.ts` and there is no `gui/bunfig.toml`, so until M9 round 3 neither an injected
  // env nor `process.env` carried DBA_TEST_UNIT_DIR here and the default exec's refusal did NOT hold. That
  // preload now arms it (a RUNTIME BACKSTOP, asserted below), and this pin stays as the first line. From
  // the engine's scheduler, a file here may import the pure manual-steps function and nothing else, and
  // nothing at all from any module that reaches the installer — the status module and the entry point
  // today, DERIVED by scanning src/ since M9 round 3 (`BARRED`). Read by the installed TypeScript's PARSER,
  // so every form is seen — a static import, a namespace or default import, a bare import, a re-export,
  // `import x = require`, a dynamic `import()`,
  // `require()` and `typeof import()` — while comments and strings are not imports. A specifier is
  // resolved against its file and compared EXACTLY (case-folded: APFS is case-insensitive), never as a
  // prefix, so `../../src/schedule` (src/schedule.ts, morning-time.check.ts) is another module. A
  // dynamic import whose module is not a plain string cannot be checked, so it fails. ⚠ AND THE FORMS ARE
  // NOT EVERY LOADER (M9 round 1, GPT): `createRequire(import.meta.url)` under any name, an aliased
  // `require`, a wrapper around `import()` or `import.meta.require` each take a plain string the forms
  // never see. So EVERY string literal (or no-substitution template) in a file that resolves to a guarded
  // module is an offence of its own, unless it is the specifier of the allowed import itself. ⚠ AND A LOADER
  // HANDED A COMPUTED MODULE NAMES NO SUCH STRING (M9 round 2, GPT: `import.meta.require("…/src/" +
  // "schedule/install")`), so the pin FAILS CLOSED on the loaders themselves: any use in code of
  // `createRequire` or `require` — a call, an alias, `import.meta.require`, `require.call` — or of
  // `import x = require(…)`, and any dynamic `import()` whose module is not a plain string, is an offence of
  // its own, whatever it names. No file here needs one. ⚠ AND IN M9 ROUND 3 (GPT, correctness) the static
  // gaps round 2 left are offences too: `import.meta` used as anything but `import.meta.<name>` (a computed
  // member like `import.meta["require"]`, or an alias); any `Worker` or `SharedWorker` identifier (a thread
  // runs a module of its own); a `?query` or `#hash` specifier into src/ (it defeats the exact compare); and
  // a source file here that is not `.ts` (the scan reads every JS/TS extension, and bun loads them all).
  // What a static pin still cannot see — `eval`, `new Function`, `globalThis` reached by a computed name —
  // the preload's backstop answers.
  const WEB = join(ROOT, "gui", "tests-web");
  const engineModule = (...parts: string[]) => join(ROOT, "src", ...parts).toLowerCase();
  const INSTALLER = engineModule("schedule", "install");
  const ALLOWED_NAME = "manual" + "RemoveSteps";
  /** A JS or TS source by its extension (M9 round 3); `.svelte` too, under tests-web, since the loader makes
   *  it importable. */
  const SCRIPT_SOURCE = /\.(?:[cm]?[jt]sx?)$/i;
  const WEB_SOURCE = /\.(?:[cm]?[jt]sx?|svelte)$/i;
  /** Every source file under gui/tests-web, whatever its extension. */
  const webSources = (): string[] => [...new Bun.Glob("**/*").scanSync({ cwd: WEB })].filter((f) => WEB_SOURCE.test(f)).sort();
  /** The sources among `files` that are not `.ts`: each one an offence (M9 round 3). */
  const nonTsSources = (files: string[]): string[] => files.filter((f) => WEB_SOURCE.test(f) && !f.endsWith(".ts"));

  /** A plain string in the syntax tree: a string literal, or a template with no substitution. */
  const isPlainString = (node: ts.Node | undefined): node is ts.StringLiteral | ts.NoSubstitutionTemplateLiteral =>
    node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node));

  /** `at` is where the specifier string starts in the source (-1 when `spec` is null), so the string pass in
   *  `verdict` can tell a specifier from any other string. */
  type ModuleUse = { form: string; spec: string | null; names: string[]; at: number };
  /** Every module reference in one source, by its syntax tree. `spec` is null when it is not a plain string. */
  function moduleUses(file: string, text: string): ModuleUse[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const uses: ModuleUse[] = [];
    const add = (form: string, node: ts.Node | undefined, names: string[]) => {
      const literal = isPlainString(node) ? node : null;
      uses.push({ form, spec: literal?.text ?? null, names, at: literal?.getStart(source) ?? -1 });
    };
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) {
        const clause = node.importClause;
        const names: string[] = [];
        if (clause === undefined) names.push("(the whole module, for its side effects)");
        if (clause?.name) names.push("default");
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
        if (bindings && ts.isNamedImports(bindings)) {
          for (const e of bindings.elements) names.push((e.propertyName ?? e.name).text);
        }
        add("import", node.moduleSpecifier, names);
      } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
        const clause = node.exportClause;
        const names = clause && ts.isNamedExports(clause) ? clause.elements.map((e) => (e.propertyName ?? e.name).text) : ["*"];
        add("re-export", node.moduleSpecifier, names);
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        add("import = require", node.moduleReference.expression, ["*"]);
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        // A `require(…)` call is not read here: it is an offence whatever it names (`loaderUses`).
        add("import()", node.arguments[0], ["*"]);
      } else if (ts.isImportTypeNode(node)) {
        const arg = node.argument;
        add("typeof import()", ts.isLiteralTypeNode(arg) ? arg.literal : undefined, ["*"]);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return uses;
  }

  /** A specifier as the module it loads, case-folded; `null` for a bare package name. */
  function target(file: string, spec: string): string | null {
    const path = spec.startsWith("file:")
      ? fileURLToPath(spec)
      : spec.startsWith(".") || spec.startsWith("/")
        ? resolve(dirname(file), spec)
        : null;
    return path === null ? null : path.replace(/\.(?:[cm]?[jt]sx?)$/i, "").toLowerCase();
  }

  /** Every use in one source's CODE (its syntax tree — never a string or a comment) of a loader that can be
   *  handed a computed module (M9 round 2): each identifier spelled `createRequire` or `require` — an import
   *  binding, a call, an alias, a property name as in `import.meta.require` — and each `import x =
   *  require(…)`. Named by form, for the offence. */
  function loaderUses(file: string, text: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found: string[] = [];
    const visit = (node: ts.Node): void => {
      if (ts.isIdentifier(node) && (node.text === "createRequire" || node.text === "require")) {
        const parent = node.parent;
        found.push(
          node.text === "createRequire"
            ? "createRequire"
            : ts.isPropertyAccessExpression(parent) && parent.name === node && ts.isMetaProperty(parent.expression)
              ? "import.meta.require"
              : ts.isCallExpression(parent) && parent.expression === node
                ? "a require() call"
                : "require",
        );
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        found.push("import = require");
      } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        // M9 round 3: `import.meta.<name>` only. A computed member or an alias can reach its loader by a name
        // no string here spells.
        const parent = node.parent;
        if (!(ts.isPropertyAccessExpression(parent) && parent.expression === node)) {
          found.push(ts.isElementAccessExpression(parent) && parent.expression === node ? "import.meta[…]" : "import.meta used as a value");
        }
      } else if (ts.isIdentifier(node) && (node.text === "Worker" || node.text === "SharedWorker")) {
        // M9 round 3: a Worker runs a module in a thread of its own, from a name or URL this pin cannot judge.
        found.push(node.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  /** Every plain string in one source, with where it starts — whatever it is handed to. */
  function plainStrings(file: string, text: string): { at: number; text: string }[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const found: { at: number; text: string }[] = [];
    const visit = (node: ts.Node): void => {
      if (isPlainString(node)) found.push({ at: node.getStart(source), text: node.text });
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  /** Every module among `files` that reaches the installer — imports it, or imports a module that does, by
   *  any form `moduleUses` reads — by its case-folded path without extension (M9 round 3: derived, so a new
   *  importer cannot escape a hand list). The installer itself is not among them. */
  function installerReachers(files: { path: string; text: string }[]): Set<string> {
    const imports = new Map<string, string[]>();
    for (const f of files) {
      const targets = moduleUses(f.path, f.text).flatMap((u) => (u.spec === null ? [] : [target(f.path, u.spec)]));
      imports.set(f.path.replace(SCRIPT_SOURCE, "").toLowerCase(), targets.filter((t): t is string => t !== null));
    }
    const reached = new Set<string>();
    for (let grew = true; grew; ) {
      grew = false;
      for (const [from, targets] of imports) {
        if (from === INSTALLER || reached.has(from)) continue;
        if (targets.some((t) => t === INSTALLER || reached.has(t))) {
          reached.add(from);
          grew = true;
        }
      }
    }
    return reached;
  }

  /** What no file here may name: every module under src/ that reaches the installer, scanned. */
  const BARRED = new Map(
    [
      ...installerReachers(
        [...new Bun.Glob("**/*").scanSync({ cwd: join(ROOT, "src") })]
          .filter((f) => SCRIPT_SOURCE.test(f))
          .map((f) => ({ path: join(ROOT, "src", f), text: readFileSync(join(ROOT, "src", f), "utf8") })),
      ),
    ].map((m) => [m, `${m.slice(ROOT.length)} (which reaches the scheduler installer)`] as const),
  );

  /** The pin's verdict on one file: what breaks the rule, and how many allowed imports it makes. */
  function verdict(file: string, text: string): { offences: string[]; allowed: number } {
    const offences: string[] = [];
    let allowed = 0;
    const specifiers = new Map<number, ModuleUse>();
    const allowedAt = new Set<number>();
    // A loader that can be handed a computed module, wherever it is used and whatever it names (M9 round 2).
    for (const form of loaderUses(file, text)) {
      offences.push(`${file}: ${form} — a way to load a module that this pin cannot check, never allowed here`);
    }
    for (const use of moduleUses(file, text)) {
      if (use.spec === null) {
        // A dynamic import of a computed module cannot be checked. (`import = require` is a loader offence
        // above already, and a static import or re-export always names a string.)
        if (use.form === "import()" || use.form === "typeof import()") {
          offences.push(`${file}: a ${use.form} whose module is not a plain string cannot be checked`);
        }
        continue;
      }
      specifiers.set(use.at, use);
      if (target(file, use.spec) === INSTALLER && use.names.length === 1 && use.names[0] === ALLOWED_NAME) {
        allowed += 1;
        allowedAt.add(use.at);
      }
    }
    // Every plain string that names a guarded module, a specifier or not, is one offence — except the allowed
    // import's own specifier.
    for (const s of plainStrings(file, text)) {
      if (allowedAt.has(s.at)) continue;
      // M9 round 3: a `?query` or `#hash` defeats the exact compare below, so one into src/ is an offence of its
      // own, whatever module it names.
      if (/[?#]/.test(s.text)) {
        const bare = target(file, s.text.replace(/[?#][\s\S]*$/, ""));
        if (bare !== null && bare.startsWith(`${engineModule()}/`)) {
          offences.push(`${file}: ${JSON.stringify(s.text)} — a ?query or #hash specifier into src/, which the exact compare cannot read`);
          continue;
        }
      }
      const module = target(file, s.text);
      const what = module === INSTALLER ? "the scheduler installer" : module !== null ? BARRED.get(module) : undefined;
      if (what === undefined) continue;
      const use = specifiers.get(s.at);
      offences.push(
        use === undefined
          ? `${file}: a string naming ${what}, which any loader can be handed`
          : `${file}: ${use.form} of ${what}${module === INSTALLER ? ` names ${use.names.join(", ")}` : ""}`,
      );
    }
    return { offences, allowed };
  }

  test("pin: every gui/tests-web import of the scheduler installer names only the manual-steps function, none touches the status module or the entry point — and there is one", () => {
    // M9 round 3: every JS/TS source, not only `*.ts`, and any that is not `.ts` is an offence of its own.
    const files = webSources();
    // A floor, so a broken glob fails loudly instead of passing over nothing (14 files at this commit).
    expect(files.length).toBeGreaterThanOrEqual(14);
    const offences: string[] = nonTsSources(files).map((f) => `${f}: a source file here that is not .ts`);
    let allowed = 0;
    const seen = new Map<string, string[]>();
    for (const f of files) {
      const path = join(WEB, f);
      const text = readFileSync(path, "utf8");
      const v = verdict(path, text);
      offences.push(...v.offences);
      allowed += v.allowed;
      seen.set(f, moduleUses(path, text).flatMap((u) => (u.spec === null ? [] : [target(path, u.spec)])).filter((t) => t !== null));
    }
    expect(offences).toEqual([]);
    // Not vacuous: the static-steps pin above is such an import, and the parser saw it in this file…
    expect(allowed).toBeGreaterThanOrEqual(1);
    expect(seen.get("coexistence.check.ts")).toContain(INSTALLER);
    // …and saw morning-time.check.ts's engine import of src/schedule.ts, which is not the installer.
    expect(seen.get("morning-time.check.ts")).toContain(engineModule("schedule"));
  });

  test("the pin's own reader: each import form it must catch, and the lookalikes it must not", () => {
    const file = join(WEB, "an-example.check.ts");
    const up = "../../src/";
    const cases: [string, number, number][] = [
      // [source, offences, allowed]
      [`import { ${ALLOWED_NAME} } from "${up}schedule/install";`, 0, 1],
      [`import { ${ALLOWED_NAME} as steps } from "${up}schedule/install.ts";`, 0, 1],
      [`export { ${ALLOWED_NAME} } from "${up}schedule/install";`, 0, 1],
      [`import { ${ALLOWED_NAME}, installSchedule } from "${up}schedule/install";`, 1, 0],
      [`import * as installer from "${up}schedule/install";`, 1, 0],
      [`import installer from "${up}schedule/install";`, 1, 0],
      [`import "${up}schedule/install";`, 1, 0],
      [`import type { ScheduleDeps } from "${up}schedule/install";`, 1, 0],
      [`export * from "${up}schedule/install";`, 1, 0],
      // M9 round 2: a require form is an offence of its own, beside the string it names — two.
      [`import installer = require("${up}schedule/install");`, 2, 0],
      [`const installer = await import("${up}schedule/install");`, 1, 0],
      [`const installer = require("${up}schedule/install");`, 2, 0],
      [`type Installer = typeof import("${up}schedule/install");`, 1, 0],
      [`import { b } from "${up}Schedule/Install";`, 1, 0],
      [`import { x } from "${up}schedule/status";`, 1, 0],
      [`import { preflightRepos } from "${up}main";`, 1, 0],
      [`const main = await import("${up}" + "main");`, 1, 0],
      [`const m = await import(\`${up}main\`);`, 1, 0],
      // M9 round 1 (GPT): a loader none of the forms above names still takes a plain string, so the STRING is
      // the offence — an aliased createRequire, an aliased require, a wrapper around import() (whose own
      // computed specifier is the second offence), Bun's import.meta.require. M9 round 2: and each of those
      // loaders is an offence of its own too, so these count it beside the string (createRequire twice: its
      // import and its call are two uses).
      [`import { createRequire } from "node:module";\nconst load = createRequire(import.meta.url);\nconst i = load("${up}schedule/install");`, 3, 0],
      [`const r = require;\nconst s = r("${up}schedule/status");`, 2, 0],
      [`const load = (m: string) => import(m);\nconst main = await load(\`${up}main\`);`, 2, 0],
      [`const i = import.meta.require("${up}schedule/install.ts");`, 2, 0],
      // …and only the allowed import's own specifier is exempt: the same module named again is not.
      [`import { ${ALLOWED_NAME} } from "${up}schedule/install";\nconst again = require.call(null, "${up}schedule/install");`, 2, 1],
      // M9 round 2 (GPT): FAIL CLOSED. A loader handed a COMPUTED module names no guarded string at all, so
      // the string rule above sees nothing; the loader itself is the offence, whatever it would load.
      [`const i = import.meta.require("${up}schedule/" + "install");`, 1, 0],
      [`const i = require("${up}" + "schedule/install");`, 1, 0],
      [`const r = require;\nconst i = r("${up}" + "schedule/install");`, 1, 0],
      [`import { createRequire as cr } from "node:module";\nconst load = cr(import.meta.url);\nconst i = load("${up}schedule/" + "install");`, 1, 0],
      // M9 round 3 (GPT, correctness): the static gaps round 2 left. `import.meta` used as anything but
      // `import.meta.<name>` — a computed member, an alias — can reach its loader by a computed name; a Worker
      // runs a module in a thread of its own; a `?query` or `#hash` defeats the exact path compare. Each is an
      // offence of its own (beside any guarded string it names).
      [`const i = import.meta["require"]("${up}schedule/install");`, 2, 0],
      [`const r = import.meta["req" + "uire"];\nconst i = r("${up}" + "schedule/install");`, 1, 0],
      [`const m = import.meta;\nconst i = m["req" + "uire"]("${up}" + "schedule/install");`, 1, 0],
      [`const w = new Worker("${up}main.ts");`, 2, 0],
      [`const w = new Worker(new URL("./" + "x.ts", import.meta.url));`, 1, 0],
      [`const w = new SharedWorker(u);`, 1, 0],
      [`import { Worker } from "node:worker_threads";\nconst w = new Worker(f);`, 2, 0],
      [`import { ${ALLOWED_NAME} } from "${up}schedule/install?x";`, 1, 0],
      [`import { x } from "${up}main#frag";`, 1, 0],
      [`const s = "${up}schedule/status?raw";`, 1, 0],
      [`const s = "${up}render?raw";`, 1, 0],
      // …and their lookalikes: `import.meta.<name>`, other identifiers, a query outside src/.
      [`const u = new URL("../../", import.meta.url);\nconst p = import.meta.path;`, 0, 0],
      [`const workers = 2;\ntype WorkerLike = { n: number };`, 0, 0],
      [`import { a } from "./helper?x";\nconst q = "?x#y";`, 0, 0],
      // Lookalikes of the loaders: another identifier, a string, a comment.
      [`const requirement = "require";\n// const i = require("${up}" + "schedule/install");\nconst s = "createRequire";`, 0, 0],
      // Lookalikes: other modules, by exact path.
      [`import { parseFloor } from "${up}schedule";`, 0, 0],
      [`import { a } from "${up}schedule/installer";`, 0, 0],
      [`import { a } from "${up}mainline";`, 0, 0],
      [`import { a } from "./schedule/install";`, 0, 0],
      // Not imports: a comment, and a string.
      [`// import * as installer from "${up}schedule/install";\nconst s = "import * as m from '${up}main'";`, 0, 0],
    ];
    for (const [source, offences, allowed] of cases) {
      const v = verdict(file, source);
      expect([source, v.offences.length, v.allowed]).toEqual([source, offences, allowed]);
    }
  });

  test("M9 round 3: every JS/TS source under gui/tests-web is read, and any that is not .ts is an offence of its own", () => {
    // The reader: a helper with another extension is one the `.ts` glob never read, and bun loads it all the same.
    expect(
      nonTsSources(["a.check.ts", "types.d.ts", "c.mjs", "d.js", "e.tsx", "f.cts", "g.jsx", "h.mts", "i.cjs", "j.svelte", "k.json", "l.snap"]),
    ).toEqual(["c.mjs", "d.js", "e.tsx", "f.cts", "g.jsx", "h.mts", "i.cjs", "j.svelte"]);
    // The folder itself: every source the scan reads is .ts (the fixture JSON and the snapshot are not sources).
    const everything = [...new Bun.Glob("**/*").scanSync({ cwd: WEB })];
    expect(everything.length).toBeGreaterThan(webSources().length);
    expect(nonTsSources(everything)).toEqual([]);
    expect(webSources().every((f) => f.endsWith(".ts"))).toBe(true);
  });

  test("M9 round 3: what the runner may not import is DERIVED from src/ — every module that reaches the scheduler installer, scanned, not a hand list", () => {
    // The reader, on a synthetic tree: a direct importer, an importer of that importer (a dynamic import), and a
    // new file that imports the entry point are all barred; a module that reaches none of them is not.
    const at = (rel: string) => join(ROOT, "src", rel);
    const reached = installerReachers([
      { path: at("schedule/install.ts"), text: "export const a = 1;" },
      { path: at("schedule/status.ts"), text: `import { a } from "./install";` },
      { path: at("main.ts"), text: `const s = await import("./schedule/status");` },
      { path: at("new-importer.ts"), text: `import { m } from "./main";` },
      { path: at("other.ts"), text: `import { c } from "./config";\n// import { a } from "./schedule/install";` },
    ]);
    expect([...reached].sort()).toEqual(
      [engineModule("main"), engineModule("new-importer"), engineModule("schedule", "status")].sort(),
    );
    // The real src/: today's two (the status module and the entry point) are among them, and the installer
    // itself is not (its one allowed import is judged by name).
    expect(BARRED.has(engineModule("schedule", "status"))).toBe(true);
    expect(BARRED.has(engineModule("main"))).toBe(true);
    expect(BARRED.has(INSTALLER)).toBe(false);
  });

  test("M9 round 3: the runner's preload ARMS DBA_TEST_UNIT_DIR — a scratch directory under the temp root, set whatever the ambient environment said, never removed or reassigned — so the engine's default exec refuses every scheduler change in this process, by any route", () => {
    // Armed by the preload as an accessor nothing can remove (checked first, so nothing below writes the
    // variable if it is not).
    const d = Object.getOwnPropertyDescriptor(process.env, "DBA_TEST_UNIT_DIR");
    expect(d?.configurable).toBe(false);
    expect(typeof d?.get).toBe("function");
    const value = process.env.DBA_TEST_UNIT_DIR ?? "";
    expect(value).not.toBe("");
    // A real directory under the temp root, never a real LaunchAgents or systemd user directory.
    const real = realpathSync(value);
    expect(real.startsWith(`${realpathSync(tmpdir())}/`)).toBe(true);
    expect(statSync(real).isDirectory()).toBe(true);
    for (const unitDir of [join("Library", "LaunchAgents"), join(".config", "systemd", "user")]) {
      expect([unitDir, `${real}/`.includes(`/${unitDir}/`)]).toEqual([unitDir, false]);
    }
    // Never removed, never pointed elsewhere.
    expect(() => {
      delete process.env.DBA_TEST_UNIT_DIR;
    }).toThrow();
    expect(() => {
      process.env.DBA_TEST_UNIT_DIR = join(real, "elsewhere");
    }).toThrow();
    expect(process.env.DBA_TEST_UNIT_DIR).toBe(value);
    // What it arms: the engine's default exec refuses a scheduler change whenever `process.env` carries it.
    const install = readFileSync(join(ROOT, "src", "schedule", "install.ts"), "utf8");
    expect(install).toContain("if ((env.DBA_TEST_UNIT_DIR || process.env.DBA_TEST_UNIT_DIR) && isRegistrationChange(cmd)) {");
  });

  test("uninstallExecute sends Rust's three arguments by their wire names, the two new ones defaulting to Rust's own defaults (spec 3.3.2)", async () => {
    const calls: [string, unknown][] = [];
    const g = globalThis as { window?: unknown };
    const had = "window" in g;
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
      await uninstallExecute(true);
      await uninstallExecute(false, true, "keep");
      await uninstallExecute(true, false, "removeAny");
    } finally {
      if (had) g.window = before;
      else delete g.window;
    }
    expect(calls).toEqual([
      ["uninstall_execute", { removeEngineState: true, removeSettings: false, schedule: "removeOwn" }],
      ["uninstall_execute", { removeEngineState: false, removeSettings: true, schedule: "keep" }],
      ["uninstall_execute", { removeEngineState: true, removeSettings: false, schedule: "removeAny" }],
    ]);
    // The names are Rust's own parameters, camelCased the way Tauri reads them; the app state it
    // injects is not sent.
    const rust = readFileSync(join(ROOT, "gui", "src-tauri", "src", "uninstall.rs"), "utf8");
    const signature = rust.match(/pub async fn uninstall_execute<R: Runtime>\(([\s\S]*?)\)\s*->/)?.[1] ?? "";
    const params = [...signature.matchAll(/(?:^|,)\s*(\w+)\s*:\s*(AppHandle|State)?/g)]
      .filter((m) => m[2] === undefined)
      .map((m) => (m[1] ?? "").replace(/_([a-z])/g, (_, c: string) => c.toUpperCase()));
    expect(params).toEqual(["removeEngineState", "removeSettings", "schedule"]);
    expect(Object.keys(calls[0]?.[1] as object)).toEqual(params);
    // Every scheduler choice the webview can send is one of Rust's `SchedulerChoice` values.
    const body = rust.match(/pub enum SchedulerChoice \{([\s\S]*?)\n\}/)?.[1] ?? "";
    const variants = [...body.matchAll(/^\s*([A-Z]\w*),\s*$/gm)].map((m) => (m[1] ?? "").replace(/^./, (c) => c.toLowerCase()));
    expect(new Set(variants)).toEqual(new Set(["removeOwn", ...SCHEDULER_OPTIONS.map((o) => o.choice)]));
  });
});

/* ── 10. Batch 2: the consent view, server-rendered (spec 3.6.2, 3.3.8; plan T6.2, T6.3) ─────────── */

/** The consent view as the server renders it, Svelte's hydration comments removed. */
function consentView(props: Record<string, unknown>): string {
  return render(UninstallConsent as never, {
    props: { onexecute: () => {}, oncancel: () => {}, ...props },
  }).body.replace(/<!--[\s\S]*?-->/g, "");
}
/** Every `<input>` of one type, as its attribute text, in document order. */
const inputsOf = (body: string, type: string): string[] =>
  [...body.matchAll(/<input([^>]*)>/g)].map((m) => m[1] ?? "").filter((attrs) => attrs.includes(`type="${type}"`));
/** Whether a boolean attribute is set, as the server renders one (`checked`, `disabled`). */
const flag = (attrs: string, name: string): boolean => new RegExp(`(?:^|\\s)${name}(?=[\\s=/]|$)`).test(attrs);
/** A class attribute without the scoping class Svelte adds to a styled element (`svelte-<hash>`). */
const ownClass = (attrs: string): string =>
  (/class="([^"]*)"/.exec(attrs)?.[1] ?? "")
    .split(/\s+/)
    .filter((c) => c !== "" && !c.startsWith("svelte-"))
    .join(" ");
/** The drawn buttons, as `[class, text]`. */
const buttonsOf = (body: string): [string, string][] =>
  [...body.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)].map((m) => [ownClass(m[1] ?? ""), (m[2] ?? "").trim()]);
/** The text a reader meets before the Uninstall button: the render up to it, tags dropped, entities read. */
function textBeforeButton(body: string): string {
  const at = body.search(/<button class="danger[\s"]/);
  expect(at).toBeGreaterThan(-1);
  return body
    .slice(0, at)
    .replace(/<[^>]*>/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}
/** Spec 3.6.2's count: split on whitespace. */
const wordsIn = (text: string): string[] => text.split(/\s+/).filter((w) => w !== "");

// Spec 3.6.2's fixture: the macOS app-owned scheduler, with fixed paths.
const MAC_APP_OWNED: UninstallPreview = {
  ...appOwned,
  engineStateDir: "~/Library/Application Support/daily-briefing",
  settingsFolder: "~/.config/daily-briefing",
  os: "macos",
};

describe("Batch 2 (spec 3.6.2, 3.3.8): the consent view, server-rendered", () => {
  test("the word budget: at most 100 words before the Uninstall button for the macOS app-owned scheduler (206 before Batch 2)", () => {
    const before = textBeforeButton(consentView({ preview: MAC_APP_OWNED }));
    const words = wordsIn(before);
    expect(words.length).toBeLessThanOrEqual(100);
    // What is counted is exactly what a reader meets, in this order — the explanation, the scheduler line,
    // the two boxes, the time sentence — so the count measures the render, not a list someone kept.
    const parts = [
      UNINSTALL_EXPLANATION,
      "The background scheduler this app set up is removed too.",
      consentLabel(MAC_APP_OWNED),
      settingsLabel(MAC_APP_OWNED),
      UNINSTALL_TIME_SENTENCE,
    ];
    expect(words).toEqual(wordsIn(parts.join(" ")));
    // The check can fail: the same view with a longer label is over the budget, and counted as such.
    const long = { ...MAC_APP_OWNED, engineStateDir: `~/${"very ".repeat(30)}long/daily-briefing` };
    expect(wordsIn(textBeforeButton(consentView({ preview: long }))).length).toBeGreaterThan(100);
  });

  test("the time sentence is drawn right before the Uninstall button, in every branch (spec 3.1.4)", () => {
    expect(UNINSTALL_TIME_SENTENCE).toBe("This usually takes under a minute, and at most about two.");
    const cases: Record<string, unknown>[] = [
      { preview: MAC_APP_OWNED },
      { preview: quiet },
      { preview: cliOwned },
      { preview: unchecked },
      { preview: quiet, foreign: true },
      { preview: appOwned, anyway: true },
      { preview: { ...quiet, engineError: "status --json exited 2", engineStateDir: null, settingsFolder: null } },
    ];
    for (const props of cases) {
      const before = wordsIn(textBeforeButton(consentView(props)));
      expect(before.slice(-wordsIn(UNINSTALL_TIME_SENTENCE).length).join(" ")).toBe(UNINSTALL_TIME_SENTENCE);
    }
  });

  test("the radio group: \"Keep it running\" FIRST and preselected, \"Remove it\" second — for every scheduler this app did not set up, and always after ScheduleForeign", () => {
    for (const [preview, foreign, lead] of [
      [cliOwned, false, LEAD_TERMINAL],
      [unownedRecord, false, LEAD_NO_OWNER],
      [unitOnly, false, LEAD_NO_OWNER],
      [registrationOnly, false, LEAD_NO_OWNER],
      [unreadable, false, LEAD_UNREADABLE],
      [quiet, true, LEAD_NO_OWNER],
      [appOwned, true, LEAD_NO_OWNER],
    ] as const) {
      const body = consentView({ preview, foreign });
      const radios = inputsOf(body, "radio");
      expect(radios.map((r) => [/value="([^"]*)"/.exec(r)?.[1], flag(r, "checked")])).toEqual([
        ["keep", true],
        ["removeAny", false],
      ]);
      // Labelled in the same order, after the case's lead sentence.
      const text = textBeforeButton(body);
      expect(text.indexOf(lead)).toBeGreaterThan(-1);
      expect(text.indexOf("Keep it running")).toBeGreaterThan(text.indexOf(lead));
      expect(text.indexOf("Remove it")).toBeGreaterThan(text.indexOf("Keep it running"));
    }
    // The check reads the binding, not a constant: the other answer, given, is the one checked.
    const remove = inputsOf(consentView({ preview: cliOwned, option: "removeAny" }), "radio");
    expect(remove.map((r) => flag(r, "checked"))).toEqual([false, true]);
  });

  test("under \"Keep it running\" both boxes are drawn unticked and disabled, with ONE sentence why; under \"Remove it\" they are the user's", () => {
    const keep = consentView({ preview: cliOwned, removeEngineState: true, removeSettings: true });
    const boxes = inputsOf(keep, "checkbox");
    expect(boxes.map((b) => [flag(b, "checked"), flag(b, "disabled")])).toEqual([
      [false, true],
      [false, true],
    ]);
    expect(keep.split(REFUSED_FOR_KEPT_SCHEDULER).length - 1).toBe(1);
    // What is drawn is what is sent: the button promises no files.
    expect(buttonsOf(keep)[0]).toEqual(["danger", "Remove app pieces"]);
    const remove = consentView({ preview: cliOwned, option: "removeAny", removeEngineState: true, removeSettings: true });
    expect(inputsOf(remove, "checkbox").map((b) => [flag(b, "checked"), flag(b, "disabled")])).toEqual([
      [true, false],
      [true, false],
    ]);
    expect(remove).not.toContain(REFUSED_FOR_KEPT_SCHEDULER);
    expect(buttonsOf(remove)[0]).toEqual(["danger", "Remove app pieces, engine data and settings"]);
  });

  test("no radio group where there is no choice: the app's own scheduler, nothing at all, a check that could not run", () => {
    const own = consentView({ preview: appOwned });
    expect(inputsOf(own, "radio")).toEqual([]);
    expect(own).toContain("The background scheduler this app set up is removed too.");
    const nothing = consentView({ preview: quiet });
    expect(inputsOf(nothing, "radio")).toEqual([]);
    // No scheduler text at all (spec 3.3.8): the explanation, the labels and the time sentence name none.
    expect(textBeforeButton(nothing).toLowerCase()).not.toContain("schedul");
    const notChecked = consentView({ preview: unchecked });
    expect(inputsOf(notChecked, "radio")).toEqual([]);
    expect(textBeforeButton(notChecked)).toContain(
      "Couldn't check for a background scheduler (the system's user services couldn't be reached).",
    );
  });

  test("both boxes are off by default and the user's to tick (spec 3.5.3: the settings box off by default)", () => {
    for (const preview of [MAC_APP_OWNED, quiet, unchecked, { ...quiet, os: "linux" }]) {
      const body = consentView({ preview });
      const boxes = inputsOf(body, "checkbox");
      expect(boxes.map((b) => [flag(b, "checked"), flag(b, "disabled")])).toEqual([
        [false, false],
        [false, false],
      ]);
      const text = textBeforeButton(body);
      expect(text.indexOf(consentLabel(preview))).toBeGreaterThan(-1);
      expect(text.indexOf(settingsLabel(preview))).toBeGreaterThan(text.indexOf(consentLabel(preview)));
      expect(buttonsOf(body)).toEqual([
        ["danger", "Remove app pieces"],
        ["", "Cancel"],
      ]);
    }
    const one = consentView({ preview: quiet, removeEngineState: true });
    expect(inputsOf(one, "checkbox").map((b) => flag(b, "checked"))).toEqual([true, false]);
    expect(buttonsOf(one)[0]).toEqual(["danger", "Remove app pieces and engine data"]);
  });

  test("\"Uninstall anyway\" after ScheduleFailed: its sentence replaces the scheduler line; a detected scheduler clears and disables the boxes, nothing detected leaves them the user's", () => {
    const detected = consentView({ preview: appOwned, anyway: true, removeEngineState: true, removeSettings: true });
    const sentence = uninstallAnyway(schedulerBranch(appOwned), ticked).sentence;
    expect(textBeforeButton(detected)).toContain(sentence);
    expect(detected).not.toContain("The background scheduler this app set up is removed too.");
    expect(inputsOf(detected, "radio")).toEqual([]);
    expect(inputsOf(detected, "checkbox").map((b) => [flag(b, "checked"), flag(b, "disabled")])).toEqual([
      [false, true],
      [false, true],
    ]);
    // The sentence already says why; the kept note is not said a second time.
    expect(detected).not.toContain(REFUSED_FOR_KEPT_SCHEDULER);
    expect(buttonsOf(detected)[0]).toEqual(["danger", "Remove app pieces"]);
    // An "other" scheduler: the group goes too — "anyway" sends keep, whatever it said.
    expect(inputsOf(consentView({ preview: cliOwned, anyway: true, option: "removeAny" }), "radio")).toEqual([]);
    const nothing = consentView({ preview: unchecked, anyway: true, removeEngineState: true, removeSettings: true });
    expect(textBeforeButton(nothing)).toContain(uninstallAnyway(schedulerBranch(unchecked), ticked).sentence);
    expect(inputsOf(nothing, "checkbox").map((b) => [flag(b, "checked"), flag(b, "disabled")])).toEqual([
      [true, false],
      [true, false],
    ]);
    expect(buttonsOf(nothing)[0]).toEqual(["danger", "Remove app pieces, engine data and settings"]);
  });

  test("busy: nothing can be changed or pressed", () => {
    const body = consentView({ preview: cliOwned, option: "removeAny", busy: true });
    for (const box of inputsOf(body, "checkbox")) expect(flag(box, "disabled")).toBe(true);
    expect(body).toMatch(/<fieldset[^>]*\sdisabled/);
    const buttons = [...body.matchAll(/<button([^>]*)>/g)].map((m) => flag(m[1] ?? "", "disabled"));
    expect(buttons).toEqual([true, true]);
  });

  test("source pins: the consent view reads no scheduler fact itself — not even the bare identifier — and sends what it draws", () => {
    const source = readFileSync(join(ROOT, "gui", "src", "lib", "UninstallConsent.svelte"), "utf8");
    // Spec 3.6.2: the "no `.scheduleRecordPresent`" pin, extended to this component as the BARE identifier,
    // so a destructured prop cannot slip past it — and the preview's other scheduler facts with it: all of
    // them reach this view only through `./app-uninstall`'s helpers.
    for (const fact of [
      "scheduleRecordPresent",
      "scheduleRecordFilePresent",
      "scheduleUnitFile",
      "scheduleOwner",
      "scheduleRegistered",
      "scheduleStatusUnreadable",
    ]) {
      expect([fact, source.includes(fact)]).toEqual([fact, false]);
    }
    expect(source).toContain("const branch = $derived(schedulerBranch(preview, foreign));");
    expect(source).toContain("const args = $derived(anyway ? rescue.args : executeArgs(branch, consents, option));");
    expect(source).toContain("onclick={() => onexecute(args)}");
    expect(source).toContain("{executeLabel(args, preview)}");
    expect(source).not.toMatch(/\{@html/);
    // Checkpoint M6a (F1): the radio group's answer goes through `chooseSchedulerOption` (tested above:
    // "Keep it running" clears both boxes' VALUES), never a bare `bind:group`, which changes the answer and
    // leaves the ticks to come back under "Remove it".
    expect(source).not.toContain("bind:group");
    expect(source).toContain("checked={option === choice.choice}");
    expect(source).toContain("onchange={() => choose(choice.choice)}");
    expect(source).toMatch(
      /function choose\(choice: SchedulerOption\): void \{\s*const next = chooseSchedulerOption\(choice, \{ removeEngineState, removeSettings \}\);\s*option = next\.option;\s*removeEngineState = next\.removeEngineState;\s*removeSettings = next\.removeSettings;\s*\}/,
    );
    // …and nothing else in the view sets the answer (the prop's own `$bindable` default aside).
    expect(source.match(/(?<![\w.])option = (?!\$bindable\()[^;\n]*/g)).toEqual(["option = next.option"]);
  });
});
