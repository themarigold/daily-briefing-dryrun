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
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { render } from "svelte/server";

// READ-ONLY imports of the engine's own code — the `notify.check.ts` / `briefing.check.ts`
// discipline. `lastBriefing` IS the parser the audit grades through; calling it here is what the
// brief means by "do not re-implement it".
import { lastBriefing } from "../../src/audit";

import ScheduleUninstall from "../src/lib/ScheduleUninstall.svelte";
import {
  autostartLine,
  consentLabel,
  doneNotes,
  executeLabel,
  finishLine,
  outcomeLine,
  REMOVE_SCHEDULE_BUTTON,
  SCHEDULE_RECORD_RULE,
  SCHEDULE_UNIT_RULE,
  SCHEDULE_WAY_OUT,
  SCHEDULER_NOTE,
  STALE_RECORD_CLAUSE,
  UNINSTALL_EXPLANATION,
  UNIT_DIR_CLAUSE,
  UNIT_WAY_OUT,
  unitUninstallCommand,
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
    os: "macos",
  };
  const UNIT = "/Users/x/Library/LaunchAgents/local.daily-briefing.plist";

  test("the consent label names the archive, the irrecoverability, the engine copy and the bound", () => {
    const label = consentLabel(preview);
    expect(label).toContain("/x/state");
    expect(label).toContain("briefing archive");
    expect(label).toContain("cannot be recovered");
    expect(label).toContain("plus the background engine copy");
    expect(label).toContain("scripts/uninstall.sh");
    expect(label).toContain("nothing else in that folder is touched");
    // The parity claim is about the LIST and is qualified (`docs/INSTALL.md`): none of the engine's
    // data goes while a background schedule is installed — one may appear after this preview.
    expect(label).toContain("none of them while a background schedule is installed");
    expect(label).not.toContain("Exactly what");
    // Without a resolved dir the label still stands, minus the path.
    expect(consentLabel({ ...preview, engineStateDir: null })).not.toContain("/x/state");
  });

  test("round 3 (B3-L6): off macOS the label does NOT claim the engine copy — on Linux it names where the copy is and that it stays", () => {
    // `src/schedule/install.ts` `managedBinPath`: the copy is IN the state folder on macOS, and in the
    // XDG data dir on Linux — outside the folder the box empties.
    const linux = consentLabel({ ...preview, os: "linux" });
    expect(linux).not.toContain("plus the background engine copy");
    expect(linux).toContain("~/.local/share/daily-briefing/");
    expect(linux).toContain("this does not remove it");
    expect(linux).toContain("briefing archive");
    expect(linux).toContain("cannot be recovered");
    const blocked = consentLabel({ ...preview, os: "linux", scheduleRecordPresent: true });
    expect(blocked).not.toContain("plus the background engine copy");
    expect(blocked).toContain("this does not remove it");
    const other = consentLabel({ ...preview, os: "windows" });
    expect(other).not.toContain("plus the background engine copy");
    expect(other).toContain("The background engine copy is not removed by this.");
    expect(consentLabel(preview)).not.toContain("does not remove it");
  });

  test("round 4 (B4-L5): the script-parity claim is macOS-only — `scripts/uninstall.sh` is a macOS source-checkout script", () => {
    // macOS keeps the claim (the list is pinned against the script by `tests/uninstall.rs`).
    expect(consentLabel(preview)).toContain("The same files `bash scripts/uninstall.sh` removes from that folder");
    // Elsewhere there is no script to be at parity with: the qualification stays, the claim goes.
    for (const os of ["linux", "windows"]) {
      const label = consentLabel({ ...preview, os });
      expect(label).not.toContain("scripts/uninstall.sh");
      expect(label).not.toContain("The same files");
      expect(label).toContain(
        "None of the engine's data is removed while a background schedule is installed; nothing else in that folder is touched.",
      );
    }
  });

  test("under a schedule record the label says the box removes NOTHING, and names the way out — never 'exactly what uninstall.sh would remove'", () => {
    // Phase E final harden round 2 (A-M1): with `schedule.json` there the consented leg removes
    // nothing of the engine's (`uninstall.rs`, `REFUSED_FOR_SCHEDULE`) — the schedule would keep
    // running the engine copy and re-create the archive — so the label says so BEFORE consent,
    // with the way out, and makes no parity claim.
    const label = consentLabel({ ...preview, scheduleRecordPresent: true });
    expect(label).toContain("/x/state");
    expect(label).toContain("briefing archive");
    expect(label).toContain("cannot be recovered");
    expect(label).toContain("ticking this removes nothing");
    expect(label).toContain(SCHEDULE_RECORD_RULE);
    expect(label).toContain(`Schedule screen → ${REMOVE_SCHEDULE_BUTTON}`);
    expect(label).toContain("`daily-briefing schedule uninstall` if you installed it from the terminal");
    expect(label).toContain("then run Uninstall again");
    expect(label).not.toContain("scripts/uninstall.sh");
    expect(label).not.toContain("kept");
    // Round 3 (B3-L1): it says what IS there — a record — not that a schedule is installed (a record
    // can be stale), and the rule it carries ends with the stale record's way out.
    expect(label).toContain("A background schedule record (schedule.json) is there right now");
    expect(label).not.toContain("is installed right now");
    expect(label).toContain(STALE_RECORD_CLAUSE);
    // And the record-free label is the one that removes, and makes the parity claim.
    expect(consentLabel(preview)).not.toContain("removes nothing");
    expect(consentLabel(preview)).not.toContain(SCHEDULE_RECORD_RULE);
  });

  test("round 3 (D3-L4) + round 4 (B4-L6): a record-less scheduler unit file blocks the box too, and the label names it and its OWN way out — first, with no stale-record clause", () => {
    const label = consentLabel({ ...preview, scheduleUnitFile: UNIT });
    expect(label).toContain(`A background scheduler unit file (${UNIT}) is there right now, with no schedule record`);
    expect(label).toContain("ticking this removes nothing");
    // Its own rule, and that rule ends the label: the way out that applies is the instruction given.
    expect(label.endsWith(` ${SCHEDULE_UNIT_RULE}`)).toBe(true);
    expect(SCHEDULE_UNIT_RULE).toContain(UNIT_WAY_OUT);
    expect(SCHEDULE_UNIT_RULE).toContain("`daily-briefing schedule uninstall` in a terminal, which removes that unit file");
    // No record, so no record's rule: no stale-RECORD clause, no `schedule.json` to delete, and no
    // Schedule-screen button — that screen draws its removal only where there is a record.
    expect(label).not.toContain(SCHEDULE_RECORD_RULE);
    expect(label).not.toContain(STALE_RECORD_CLAUSE);
    expect(label).not.toContain("schedule.json");
    expect(label).not.toContain(REMOVE_SCHEDULE_BUTTON);
    expect(label).not.toContain("scripts/uninstall.sh");
    // A record and a unit together: the record's wording (the unit is the record's own).
    const both = consentLabel({ ...preview, scheduleRecordPresent: true, scheduleUnitFile: UNIT });
    expect(both).toContain("A background schedule record (schedule.json) is there right now");
    expect(both).toContain(SCHEDULE_RECORD_RULE);
    expect(both).not.toContain("removes that unit file");
  });

  test("round 3 (A3-L2): the execute button says what clicking WILL do — ticked under a schedule, engine data stays", () => {
    expect(executeLabel(false, preview)).toBe("Remove app pieces");
    expect(executeLabel(true, preview)).toBe("Remove app pieces and engine data");
    for (const blocked of [
      { ...preview, scheduleRecordPresent: true },
      { ...preview, scheduleUnitFile: UNIT },
    ]) {
      expect(executeLabel(false, blocked)).toBe("Remove app pieces");
      const ticked = executeLabel(true, blocked);
      expect(ticked).not.toContain("and engine data");
      expect(ticked).toContain("engine data stays");
    }
  });

  test("round 4 (B4-L7): with the state dir unresolved (engineError) the ticked button does not promise engine data either", () => {
    // The view says under the box that it "will not remove anything until" the engine can say
    // where its data lives; the button must not say the opposite.
    const unresolved = { ...preview, engineStateDir: null, engineError: "status --json exited 2" };
    expect(executeLabel(false, unresolved)).toBe("Remove app pieces");
    const ticked = executeLabel(true, unresolved);
    expect(ticked).not.toContain("and engine data");
    expect(ticked).toBe("Remove app pieces (engine data stays while the engine cannot say where it is)");
    // A schedule there as well: the schedule's words, the more certain block (it outlasts the engine
    // answering by the click).
    expect(executeLabel(true, { ...unresolved, scheduleUnitFile: UNIT })).toBe(
      "Remove app pieces (engine data stays while a schedule is there)",
    );
  });

  test("the way out names the Schedule screen's REAL button, and Rust's refusal says the same sentence", () => {
    // The label the consent text and Rust's refusal both point at, read from the RENDERED
    // component (SSR: the closed state draws exactly the one removal button) — a renamed button
    // fails here instead of leaving the advice pointing at nothing.
    const body = render(ScheduleUninstall as never, { props: { scheduleState: null } }).body.replace(/<!--[\s\S]*?-->/g, "");
    const drawn = [...body.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((m) => (m[1] ?? "").trim());
    expect(drawn).toEqual([REMOVE_SCHEDULE_BUTTON]);
    // Rust's `REFUSED_FOR_SCHEDULE` is what the done view shows after a refused run; it must carry
    // the same sentence — the stale-record clause included. Parsed from the source (the T9
    // pattern): the string literal with Rust's `\<newline><indent>` continuations folded the way the
    // compiler folds them.
    const rust = readFileSync(join(ROOT, "gui", "src-tauri", "src", "uninstall.rs"), "utf8");
    const literal = rust.match(/pub const REFUSED_FOR_SCHEDULE: &str = "((?:[^"\\]|\\[\s\S])*)";/);
    expect(literal).not.toBeNull();
    const refused = (literal?.[1] ?? "").replace(/\\\n\s*/g, "");
    expect(refused).toContain(SCHEDULE_RECORD_RULE);
    expect(SCHEDULE_RECORD_RULE).toContain(STALE_RECORD_CLAUSE);
    // The SHARED sentence, word for word (`docs/INSTALL.md` carries it too).
    expect(STALE_RECORD_CLAUSE).toBe(
      "If the Schedule screen shows no schedule and `daily-briefing schedule uninstall` reports nothing " +
        "installed, the record is stale: delete `schedule.json` from the engine's folder, then run Uninstall again.",
    );
    // Round 4 (B4-L6): the record-LESS unit's rule is its own, in step on both sides — Rust's
    // `REFUSED_FOR_UNIT_RULE` (which `refused_for_unit` carries) is the webview's `SCHEDULE_UNIT_RULE`.
    const unitLiteral = rust.match(/pub const REFUSED_FOR_UNIT_RULE: &str = "((?:[^"\\]|\\[\s\S])*)";/);
    expect(unitLiteral).not.toBeNull();
    expect((unitLiteral?.[1] ?? "").replace(/\\\n\s*/g, "")).toBe(SCHEDULE_UNIT_RULE);
    // Cap round (G5-2): the reason a systemd unit gets its own command, in step on both sides too.
    const dirLiteral = rust.match(/pub const UNIT_DIR_CLAUSE: &str = "((?:[^"\\]|\\[\s\S])*)";/);
    expect(dirLiteral).not.toBeNull();
    expect((dirLiteral?.[1] ?? "").replace(/\\\n\s*/g, "")).toBe(UNIT_DIR_CLAUSE);
    // And the record's refusal no longer names a unit file: the unit has its own.
    expect(refused).not.toContain("unit file");
  });

  test("the default action's copy promises the engine is untouched, and the scheduler is out of scope", () => {
    expect(UNINSTALL_EXPLANATION).toContain("not touched unless");
    // Shown before the preview tells the webview its platform, so it names both (round 3, B3-L6).
    expect(UNINSTALL_EXPLANATION).toContain("on macOS by dragging it out of Applications");
    expect(UNINSTALL_EXPLANATION).toContain("on Linux by removing the .deb or deleting the AppImage");
    expect(SCHEDULER_NOTE).toContain(`Schedule screen (${REMOVE_SCHEDULE_BUTTON})`);
    expect(SCHEDULER_NOTE).toContain("Uninstall removes none of the engine's data");
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

  // The report's shape for each case, as `uninstall_execute` answers it (`tests/uninstall.rs` pins
  // the Rust half): unticked → no engine leg; ticked, no record → the list removed; ticked under a
  // record → the one refusal. The schedule facts are the EXECUTE-time ones, read ticked or not.
  const unticked: UninstallReport = {
    autostart: { result: "removed" },
    app: [],
    engineStateRemoved: false,
    engine: [],
    engineRefused: null,
    engineStateDir: null,
    engineError: null,
    scheduleRecordPresent: false,
    scheduleUnitFile: null,
    os: "macos",
  };
  const tickedRemoved: UninstallReport = {
    ...unticked,
    engineStateRemoved: true,
    engine: [{ name: "briefing.log", outcome: { result: "removed" } }],
    engineStateDir: "/x/state",
  };
  const tickedRefused: UninstallReport = {
    ...unticked,
    engineRefused: "a background schedule's record …",
    engineStateDir: "/x/state",
    scheduleRecordPresent: true,
  };

  test("R4 + round 3: the done view warns that a schedule outlives the app whenever the EXECUTE-time check found one — ticked or not — before the finish line", () => {
    // No record: no warning, ticked or not — the plain finish.
    expect(doneNotes(unticked)).toEqual({ warning: null, finish: finishLine("macos") });
    expect(doneNotes(tickedRemoved)).toEqual({ warning: null, finish: finishLine("macos") });

    // A record, box UNTICKED: the gap R4 closes — the app's own pieces went, the schedule did not.
    const untickedNotes = doneNotes({ ...unticked, scheduleRecordPresent: true });
    expect(untickedNotes.warning).not.toBeNull();
    const warning = untickedNotes.warning ?? "";
    // What IS there — not "is still installed": a record can be stale (B3-L1) — with its way out.
    expect(warning).toContain("A background schedule record is still there");
    expect(warning).not.toContain("is still installed");
    expect(warning).toContain("keeps running the engine after the app is deleted");
    expect(warning).toContain(SCHEDULE_WAY_OUT);
    expect(warning).toContain(`Schedule screen → ${REMOVE_SCHEDULE_BUTTON}`);
    expect(warning).toContain("`daily-briefing schedule uninstall` if you installed it from the terminal");
    expect(warning).toContain(STALE_RECORD_CLAUSE);
    // The same way out as the rule sentence, not a second wording of it.
    expect(SCHEDULE_RECORD_RULE).toContain(SCHEDULE_WAY_OUT);
    expect(untickedNotes.finish).toBe(finishLine("macos"));

    // A record, box TICKED: the leg was refused — the same warning, and the finish says to run
    // Uninstall again before removing the app.
    const tickedNotes = doneNotes(tickedRefused);
    expect(tickedNotes.warning).toBe(warning);
    expect(tickedNotes.finish).toContain("run Uninstall again");
    expect(tickedNotes.finish).toContain(finishLine("macos"));
    // A refusal the facts did not foresee (a schedule installed and removed again around the
    // execute) still warns.
    expect(doneNotes({ ...tickedRefused, scheduleRecordPresent: false }).warning).toBe(warning);
  });

  test("round 3 (A3-L2): the warning follows the EXECUTE-time facts, not the preview — a schedule removed in between, a record-less unit, and an unknown state dir", () => {
    // The preview saw a record; by execute it was gone: no warning (the old preview-flag version
    // warned here).
    expect(doneNotes({ ...unticked, scheduleRecordPresent: false }).warning).toBeNull();
    // A record-less unit file at execute: warned, with the unit named and ITS way out (round 4,
    // B4-L6) — the engine's subcommand, not the Schedule screen's button (drawn only with a record) —
    // and no stale-RECORD clause.
    const unit = doneNotes({ ...unticked, scheduleUnitFile: UNIT }).warning ?? "";
    expect(unit).toContain(`A background scheduler unit file is still there (${UNIT})`);
    expect(unit).toContain(`${UNIT_WAY_OUT}.`);
    expect(unit).not.toContain(SCHEDULE_WAY_OUT);
    expect(unit).not.toContain(REMOVE_SCHEDULE_BUTTON);
    expect(unit).not.toContain(STALE_RECORD_CLAUSE);
    // …and a refused run on that unit (the report states the look the gate refused on — Rust's
    // `ScheduleSeen`, round 4 G4-L1) says the same, then to run Uninstall again.
    const unitRefused = doneNotes({
      ...unticked,
      engineRefused: "a background scheduler unit file (…) is there with no schedule record …",
      engineStateDir: "/x/state",
      scheduleUnitFile: UNIT,
    });
    expect(unitRefused.warning).toBe(unit);
    expect(unitRefused.finish).toContain("run Uninstall again");
    // The state dir could not be named at execute and no unit was found: UNKNOWN, said as unknown.
    const unknown = doneNotes({ ...unticked, scheduleRecordPresent: null });
    expect(unknown.warning).toContain("could not say whether a background schedule is installed");
    expect(unknown.warning).toContain(SCHEDULE_WAY_OUT);
    expect(unknown.finish).toBe(finishLine("macos"));
    // …and the finish is the report's platform's.
    expect(doneNotes({ ...unticked, os: "linux" }).finish).toBe(finishLine("linux"));
    expect(doneNotes({ ...tickedRefused, os: "linux" }).finish).toContain(finishLine("linux"));
  });

  test("cap round (A5-L1): an UNKNOWN record is not 'no record' — a unit with the record unanswered gets the record's way out, hedged", () => {
    // The preview: the engine could not name its state dir (`engineError`), so `scheduleRecordPresent`
    // is `false` without meaning absent — an app-owned record is the Schedule screen's to remove
    // (`schedule uninstall` refuses it as foreign). The label names the unit, claims no "no schedule
    // record", and gives the record's rule, never the record-less unit's.
    const unanswered = { ...preview, engineStateDir: null, engineError: "status --json exited 2", scheduleUnitFile: UNIT };
    const label = consentLabel(unanswered);
    expect(label).toContain(`A background scheduler unit file (${UNIT}) is there right now`);
    expect(label).toContain("ticking this removes nothing");
    expect(label).toContain("the engine could not say whether a schedule record is there too");
    expect(label).not.toContain("with no schedule record");
    expect(label.endsWith(` ${SCHEDULE_RECORD_RULE}`)).toBe(true);
    expect(label).not.toContain(SCHEDULE_UNIT_RULE);
    // The done view: the execute-time record unknown (`null`) and a unit there.
    const notes = doneNotes({ ...unticked, scheduleRecordPresent: null, scheduleUnitFile: UNIT });
    const warning = notes.warning ?? "";
    expect(warning).toContain(`A background scheduler unit file is still there (${UNIT}`);
    expect(warning).toContain("the engine could not say whether a schedule record is there too");
    expect(warning).not.toContain("A background schedule record is still there");
    expect(warning.endsWith(`${SCHEDULE_WAY_OUT}. ${STALE_RECORD_CLAUSE}`)).toBe(true);
    expect(warning).not.toContain(UNIT_WAY_OUT);
    expect(notes.finish).toBe(finishLine("macos"));
    // Known absent stays the record-less unit's own way out.
    expect(doneNotes({ ...unticked, scheduleRecordPresent: false, scheduleUnitFile: UNIT }).warning).toContain(
      `${UNIT_WAY_OUT}.`,
    );
  });

  test("cap round (G5-2): a Linux unit's way out is the command for the unit's OWN directory — both directories, a path with a space and a quote", () => {
    // `daily-briefing schedule uninstall` looks only under its own environment's
    // `$XDG_CONFIG_HOME/systemd/user` (else `~/.config/systemd/user`); this app looks under both.
    const DEFAULT = "/h/.config/systemd/user/daily-briefing.timer";
    const CUSTOM = "/x/my cfg/it's $HOME/systemd/user/daily-briefing.service";
    expect(unitUninstallCommand(DEFAULT)).toBe("XDG_CONFIG_HOME='/h/.config' daily-briefing schedule uninstall");
    expect(unitUninstallCommand(CUSTOM)).toBe(
      "XDG_CONFIG_HOME='/x/my cfg/it'\\''s $HOME' daily-briefing schedule uninstall",
    );
    // The macOS plist keeps the rule's own command.
    expect(unitUninstallCommand(UNIT)).toBeNull();
    // The quoting, measured: the prefix alone (the engine's subcommand stripped off first, so it never
    // runs), in front of `printenv`, through a real `/bin/sh`.
    for (const [unit, config] of [
      [DEFAULT, "/h/.config"],
      [CUSTOM, "/x/my cfg/it's $HOME"],
    ] as const) {
      const command = unitUninstallCommand(unit) ?? "";
      const suffix = " daily-briefing schedule uninstall";
      expect(command.endsWith(suffix)).toBe(true);
      const shell = Bun.spawnSync(["/bin/sh", "-c", `${command.slice(0, -suffix.length)} /usr/bin/printenv XDG_CONFIG_HOME`], {
        env: { PATH: "/usr/bin:/bin" },
      });
      expect(shell.exitCode).toBe(0);
      expect(shell.stdout.toString()).toBe(`${config}\n`);
    }
    // Byte for byte the sentence Rust's `unit_command_note` builds for the same unit
    // (`tests/uninstall.rs`, `a_linux_units_refusal_names_the_command_for_its_own_directory`).
    const note =
      "To remove this unit file from a terminal, run `XDG_CONFIG_HOME='/h/.config' daily-briefing schedule " +
      "uninstall`: `daily-briefing schedule uninstall` looks for it only under `$XDG_CONFIG_HOME/systemd/user`, " +
      "or `~/.config/systemd/user` when XDG_CONFIG_HOME is unset.";
    // The label and the done view: the unit's rule, then the command beside it — record known absent.
    const linux = { ...preview, os: "linux", scheduleUnitFile: DEFAULT };
    expect(consentLabel(linux).endsWith(` ${SCHEDULE_UNIT_RULE} ${note}`)).toBe(true);
    expect(doneNotes({ ...unticked, os: "linux", scheduleUnitFile: DEFAULT }).warning?.endsWith(`${UNIT_WAY_OUT}. ${note}`)).toBe(
      true,
    );
    const custom = `To remove this unit file from a terminal, run \`${unitUninstallCommand(CUSTOM)}\`: ${UNIT_DIR_CLAUSE}`;
    expect(consentLabel({ ...linux, scheduleUnitFile: CUSTOM }).endsWith(` ${SCHEDULE_UNIT_RULE} ${custom}`)).toBe(true);
    // …and the record unanswered (A5-L1): the record's way out, then the command.
    const unanswered = { ...linux, engineStateDir: null, engineError: "status --json exited 2" };
    expect(consentLabel(unanswered).endsWith(` ${SCHEDULE_RECORD_RULE} ${note}`)).toBe(true);
    expect(
      doneNotes({ ...unticked, os: "linux", scheduleRecordPresent: null, scheduleUnitFile: DEFAULT }).warning?.endsWith(
        `${STALE_RECORD_CLAUSE} ${note}`,
      ),
    ).toBe(true);
    // Where the unit is not named — a record there — no command is added.
    expect(consentLabel({ ...linux, scheduleRecordPresent: true })).not.toContain("XDG_CONFIG_HOME=");
    expect(doneNotes({ ...unticked, os: "linux", scheduleRecordPresent: true, scheduleUnitFile: DEFAULT }).warning).not.toContain(
      "XDG_CONFIG_HOME=",
    );
  });

  test("R4 + round 3: AppSettings draws doneNotes' words from the REPORT, the warning BEFORE the finish, and the refusal line verbatim", () => {
    // The done view is reached only by clicking (SSR cannot get there), so its wiring is pinned by
    // source — the way `wizard.check.ts` pins the last step.
    const source = readFileSync(join(ROOT, "gui", "src", "lib", "AppSettings.svelte"), "utf8");
    const markup = source.slice(source.indexOf("</script>"));
    // The facts are the report's own (execute time) — no flag carried over from the preview.
    expect(markup).toContain("doneNotes(uninstallReport)");
    expect(source).not.toContain("uninstallScheduled");
    expect(source).not.toContain(".scheduleRecordPresent");
    // Warning first, then the finish — and no finish wording of the component's own.
    const warningAt = markup.indexOf("{notes.warning}");
    const finishAt = markup.indexOf("{notes.finish}");
    expect(warningAt).toBeGreaterThan(-1);
    expect(finishAt).toBeGreaterThan(warningAt);
    expect(markup).not.toContain("drag it from Applications");
    // Round 3 (B3-L5): the refused leg's ONE line — "nothing removed" and the refusal verbatim
    // (`{}`-interpolated, never `{@html}`), drawn only when there is a refusal, inside the report.
    const refusalLine = '<li class="bad">engine data: nothing removed — {uninstallReport.engineRefused}</li>';
    const guard = "{#if uninstallReport.engineRefused !== null}";
    const reportAt = markup.indexOf('<ul class="muted report">');
    expect(reportAt).toBeGreaterThan(-1);
    const report = markup.slice(reportAt, markup.indexOf("</ul>", reportAt));
    expect(report).toContain(refusalLine);
    expect(report.indexOf(guard)).toBeGreaterThan(-1);
    expect(report.indexOf(refusalLine)).toBeGreaterThan(report.indexOf(guard));
    expect(markup).not.toMatch(/\{@html[^}]*engineRefused/);
    // The execute button's words are `executeLabel`'s (round 3, A3-L2) — none of its own.
    expect(markup).toContain("{executeLabel(consent, uninstall)}");
    expect(markup).not.toContain("Remove app pieces");
  });

  test("the report lines cover the three outcomes", () => {
    expect(outcomeLine({ name: "briefing.log", outcome: { result: "removed" } })).toBe("briefing.log: removed");
    expect(outcomeLine({ name: "x", outcome: { result: "absent" } })).toBe("x: was not there");
    expect(outcomeLine({ name: "x", outcome: { result: "failed", detail: "EPERM" } })).toContain("EPERM");
    expect(autostartLine({ result: "removed" })).toContain("Start-at-login");
    expect(autostartLine({ result: "failed", detail: "no plugin" })).toContain("no plugin");
  });
});
