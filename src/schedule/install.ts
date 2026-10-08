// src/schedule/install.ts — Slice 4 T3/T8/T9: the EFFECTFUL half of scheduling.
//
// ⚠ EVERY EFFECT IN THIS FILE LEAVES THROUGH ONE OF TWO SEAMS, and that is enforced by
// `test/isolation.meta.test.ts`'s scanner 4, not by convention:
//   1. the INJECTED `exec` (default `src/proc.ts` run()) — every `launchctl`, `systemctl`,
//      `schtasks`, `loginctl`, `xattr`, `codesign`, `security` and `openssl` invocation;
//   2. `DBA_TEST_UNIT_DIR` — every unit-file write, which is made through the injected `writeFile`.
// There is deliberately no `Bun.spawn` anywhere in `src/schedule/`. The failure being prevented is
// specific and has a precedent: the suite runs on the author's live machine, where a stray
// `launchctl unload` takes down the LIVE briefing agent — which is exactly why
// `scripts/uninstall.sh` grew `DBA_TEST_PLIST` in the first place. Nothing in a test may reach a real
// scheduler, and a source scanner is the only thing that can say so about code nobody is reading.
//
// ⚠ THE SOURCE BINARY IS `process.execPath`, NEVER `process.argv[0]`. Measured with a probe built by
// `bun build --compile`: `execPath` is the binary's own absolute path while `argv[0]` is the literal
// string "bun". A unit built from argv[0] points at nothing. `execPath` is injected (`deps.execPath`)
// so the pin is testable; `test/schedule.install.test.ts` asserts it directly.
//
// ⚠ THE MANAGED COPY IS THE WHOLE DESIGN, not a convenience. Three separate problems, one rule:
//   • AppImage — an interior path is an ephemeral `/tmp/.mount_XXXX/…` recreated every launch, so a
//     unit pointing inside the mount works exactly once. `assertNoMountPath` refuses it outright.
//   • macOS signing — you can sign a copy; you cannot cleanly re-sign the binary that is executing.
//   • Durability — the user deleting the download from ~/Downloads must not break the schedule.
//
// ⚠ AND THE SIGNING IS WHY A DOWNLOADED BINARY CAN HOLD A TCC GRANT AT ALL. A bun-compiled binary is
// `adhoc, linker-signed` with `Identifier=a.out`, so a release binary's cdhash changes every build and
// its designated requirement is worth nothing — the macOS Files-and-Folders grant cannot survive an
// update. Re-signing the COPY with a stable local identity and `--identifier local.daily-briefing`
// gives a fixed designated requirement, which is the one thing that identity exists to guarantee.
// Parameterized (`--identity` / `DBA_SIGN_IDENTITY`) so a Developer ID drops in later with no
// redesign. Every failure DEGRADES TO A WARNING, exactly as `scripts/install.sh:69-77` does: a
// signing hiccup must never abort an install, because the unloaded agent costs a morning and the
// missing grant costs a re-prompt.
import { copyFile, mkdir, mkdtemp, rm, rmdir, chmod, unlink, rename, lstat } from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import pkg from "../../package.json";
import { run, type RunResult } from "../proc";
import { stateDirFor, schedulePath } from "../marker";
import { stripControl } from "../render";
import {
  launchdPlist, systemdUnits, windowsTaskXml, windowsTaskXmlBytes, assertNoMountPath,
  SCHEDULE_LABEL, SYSTEMD_SERVICE_NAME, SYSTEMD_TIMER_NAME, WINDOWS_TASK_NAME, DEFAULT_INTERVAL_SEC,
  type ScheduleOpts,
} from "./units";

// ── the seams ───────────────────────────────────────────────────────────────────────────────────

/** The injected OS-command runner. Narrower than `RunResult` on purpose: this module needs the exit
 *  code and the text, and nothing here should start depending on the flush/timeout facts. */
export type ExecResult = { code: number; out: string; err: string };
export type Exec = (cmd: string[], opts?: { timeoutMs?: number }) => Promise<ExecResult>;

export const SCHEDULE_EXEC_TIMEOUT_MS = 30_000;

/** The fixed `err` of a scheduler change the default exec refused under `DBA_TEST_UNIT_DIR` (spec
 *  3.1.3). Fixed text, so a test can tell the refusal apart from a spawn failure, whose text differs. */
export const SCHEDULER_CHANGE_REFUSED = "refused: scheduler change under DBA_TEST_UNIT_DIR";

/**
 * Would this argv change what the OS scheduler has registered? Pure, and DENY-BY-DEFAULT for the
 * scheduler tools (spec 3.1.3), because a wrong `false` here is a live agent unloaded by a test.
 *   • `argv[0]` is matched by its BASE NAME, case-insensitively: a path prefix cannot bypass it, and
 *     APFS is case-insensitive, so `/bin/LaunchCtl` spawns `/bin/launchctl`.
 *   • Only `launchctl`, `systemctl` and `loginctl` are looked at further; any other tool — `xattr`,
 *     `codesign`, `security`, `openssl`, and `schtasks`, which keeps today's Windows path (3.1.10) — is
 *     false at once.
 *   • The command word is the first later argument that does not begin with `-`. Any dash argument
 *     before it other than exactly `--user` makes the answer true, so an option's VALUE can never pass
 *     for a read-only command word (`systemctl -H is-active stop …`).
 *   • Read-only, and so false: `launchctl print|list`, `systemctl is-active|is-enabled`, and for
 *     `loginctl` everything but `enable-linger`. No command word at all is true, and so is an empty argv.
 * It never throws, whatever it is given: an argv it cannot read is answered true.
 */
export function isRegistrationChange(argv: string[]): boolean {
  try {
    if (argv.length === 0) return true;
    const tool = String(argv[0]).split(/[\\/]/).pop()!.toLowerCase();
    if (tool !== "launchctl" && tool !== "systemctl" && tool !== "loginctl") return false;
    let word: string | undefined;
    for (const a of argv.slice(1)) {
      const s = String(a);
      if (!s.startsWith("-")) { word = s; break; }
      if (s !== "--user") return true;
    }
    if (word === undefined) return true;
    if (tool === "launchctl") return word !== "print" && word !== "list";
    if (tool === "systemctl") return word !== "is-active" && word !== "is-enabled";
    return word === "enable-linger";
  } catch {
    return true;
  }
}

/**
 * `proc.run`'s result as this module's exit codes (spec 3.1.4 "Exec failure codes"), checked in this
 * order: a rejected promise → -2 (a thrown exec counts as one that could not spawn); `!spawned` → -2
 * (tested first, because a spawn failure is also an incomplete read); `timedOut` or `!complete` → -1;
 * otherwise the real code. Every caller turns -1 and -2 into "no answer", never a non-zero exit or a
 * not-found.
 *
 * Exported, and outside `defaultExec`, on purpose: spec 3.1.3 lets exactly one test call the default
 * exec (the host-absent probe), so the mapping is tested here instead
 * (`test/schedule.exec-codes.test.ts`). The one `run(` call stays inside R3's window below.
 */
export async function execResultOf(pending: Promise<RunResult>): Promise<ExecResult> {
  let r: RunResult;
  try {
    r = await pending;
  } catch (e) {
    return { code: -2, out: "", err: String(e) };
  }
  if (!r.spawned) return { code: -2, out: r.out, err: r.err };
  if (r.timedOut || !r.complete) return { code: -1, out: r.out, err: r.err };
  return { code: r.code, out: r.out, err: r.err };
}

/**
 * The default, and the ONLY place this module reaches `proc.run`. Scanner 4's R3 asserts that the
 * identifier is called exactly once, within 400 characters after this definition's name — anything
 * else would be a path around the seam.
 *
 * ⚠ ITS FIRST STATEMENT IS THE TEST-ISOLATION REFUSAL (spec 3.1.3). When `DBA_TEST_UNIT_DIR` is set —
 * in the env this exec was built from OR in `process.env` — a scheduler change (`isRegistrationChange`)
 * spawns nothing and comes back as -2 with SCHEDULER_CHANGE_REFUSED. Both: the injected env is what an
 * in-process caller hands the installer (`deps.env`, as the schedule tests do), and `process.env` is what
 * the preload (test/fixtures/isolate-state.ts) arms in every engine test process, so a test that hands
 * in an env object of its own without the variable is still refused ("Hand-built environments"). A
 * spawned engine sees its own environment both ways. In production neither carries it. A BACKSTOP,
 * never a way to write a test: it blocks only scheduler changes, so the read-only probes and the
 * keychain and signing tools would still run for real.
 */
export const defaultExec = (env: NodeJS.ProcessEnv): Exec => async (cmd, opts) => {
  if ((env.DBA_TEST_UNIT_DIR || process.env.DBA_TEST_UNIT_DIR) && isRegistrationChange(cmd)) {
    return { code: -2, out: "", err: SCHEDULER_CHANGE_REFUSED };
  }
  return execResultOf(run(cmd, { timeoutMs: opts?.timeoutMs ?? SCHEDULE_EXEC_TIMEOUT_MS }));
};

/**
 * One call of an injected exec that cannot throw: a thrown exec counts as -2, "could not run" (spec 3.1.4).
 * ⚠ THE CALL ITSELF SITS INSIDE THE `try`, not just its promise. An exec that throws SYNCHRONOUSLY — before
 * it has returned a promise at all — never reaches a `.catch` chained onto its result, and that escaped as a
 * crash of `schedule status` (spec 3.1.5: "a thrown exec gives null, never a crash") and as uninstall's
 * catch-all exit where a failed unregister must be ignored (3.1.3). `opts` is passed on only when given, so a
 * caller with no timeout passes none. Used by every exec the check, status and the uninstall and rollback
 * budget run (`probeExec`, `lingerState`, `execWithin`).
 */
async function execNoThrow(exec: Exec, cmd: string[], opts?: { timeoutMs?: number }): Promise<ExecResult> {
  try {
    return await (opts === undefined ? exec(cmd) : exec(cmd, opts));
  } catch (e) {
    return { code: -2, out: "", err: String(e) };
  }
}

export type ScheduleKind = "launchd" | "systemd" | "schtasks";
export type ScheduleOwner = "cli" | "app";

export type ScheduleDeps = {
  exec?: Exec;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** `process.execPath` — the SOURCE binary. Injected so the argv[0] pin is testable. */
  execPath?: string;
  now?: () => Date;
  /** Human output. Injected so a test asserts what was SAID without capturing the console, and so
   *  nothing in this module writes to a stream by hard-coded reference. */
  say?: (line: string) => void;
  warn?: (line: string) => void;
  /** The uid the launchd domains are built from (`gui/<uid>/…`, `user/<uid>/…`). Defaults to
   *  `process.getuid?.()` (`harden.ts`'s spelling), and to -1 where there is none (Windows), which no
   *  launchd argv is ever built for. Injected so a test's argv is the same on every machine. */
  uid?: number;
  /** Waits between polls (spec 3.1.4). Injected so no test waits in real time (spec 3.1.11). */
  sleep?: (ms: number) => Promise<void>;
  /** A MONOTONIC clock in milliseconds, for deadlines (spec 3.1.4): `performance.now` by default, never
   *  the wall clock, which can jump. `now` above stamps records; this one measures time. */
  clock?: () => number;
  /** Writes one unit file. `writeFileAtomic` by default; injected so a test can fail one write (spec
   *  3.2.2). */
  writeFile?: (path: string, data: string | Uint8Array) => Promise<void>;
};

type Resolved = Required<Pick<ScheduleDeps,
  "exec" | "platform" | "env" | "home" | "execPath" | "now" | "say" | "warn" | "uid" | "sleep" | "clock" | "writeFile">>;

function resolveDeps(d: ScheduleDeps): Resolved {
  // `env` first: the default exec is built FROM it, so its refusal sees the same environment every
  // path and unit decision here does (spec 3.1.3, "Whose environment").
  const env = d.env ?? process.env;
  return {
    exec: d.exec ?? defaultExec(env),
    platform: d.platform ?? process.platform,
    env,
    home: d.home ?? homedir(),
    execPath: d.execPath ?? process.execPath,
    now: d.now ?? (() => new Date()),
    say: d.say ?? ((l) => console.log(l)),
    warn: d.warn ?? ((l) => console.error(l)),
    uid: d.uid ?? process.getuid?.() ?? -1,
    sleep: d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))),
    clock: d.clock ?? (() => performance.now()),
    writeFile: d.writeFile ?? writeFileAtomic,
  };
}

// ── paths ───────────────────────────────────────────────────────────────────────────────────────

export function kindFor(platform: NodeJS.Platform): ScheduleKind | null {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  if (platform === "win32") return "schtasks";
  return null;
}

/**
 * Where the MANAGED COPY lives.
 *
 * darwin: `<state>/daily-briefing` — exactly where `scripts/install.sh:5` already puts it, so an
 * existing install is refreshed in place rather than duplicated.
 * linux: `~/.local/share/daily-briefing/bin/daily-briefing` — the XDG data dir, deliberately NOT the
 * state dir: the state dir is data the user might clear, and a binary is not data.
 */
export function managedBinPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === "linux") {
    const data = env.XDG_DATA_HOME ?? join(home, ".local", "share");
    return join(data, "daily-briefing", "bin", "daily-briefing");
  }
  if (platform === "win32") return join(stateDirFor(platform, env, home), "daily-briefing.exe");
  return join(stateDirFor(platform, env, home), "daily-briefing");
}

/**
 * Where the unit file is written.
 *
 * ⚠ `DBA_TEST_UNIT_DIR` OVERRIDES EVERYTHING, and it is checked FIRST rather than merged in, for the
 * same reason `DAILY_BRIEFING_STATE_DIR` is: the real location is `~/Library/LaunchAgents`, and a
 * test that wrote there would install a second copy of the author's live agent. It is the unit-file
 * half of the isolation contract scanner 4 enforces.
 */
export function unitDir(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string {
  if (env.DBA_TEST_UNIT_DIR) return env.DBA_TEST_UNIT_DIR;
  if (platform === "darwin") return join(home, "Library", "LaunchAgents");
  if (platform === "linux") return join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "systemd", "user");
  return stateDirFor(platform, env, home);
}

/** Every file this slice writes under `unitDir`. EXACT names — see `ownsLabel`. */
export function unitPaths(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string[] {
  const dir = unitDir(platform, env, home);
  if (platform === "darwin") return [join(dir, `${SCHEDULE_LABEL}.plist`)];
  if (platform === "linux") return [join(dir, SYSTEMD_SERVICE_NAME), join(dir, SYSTEMD_TIMER_NAME)];
  if (platform === "win32") return [join(dir, `${WINDOWS_TASK_NAME}.xml`)];
  return [];
}

/** The unit path REPORTED and recorded — the one the user would act on (the timer on Linux). */
export function primaryUnitPath(platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): string | null {
  const paths = unitPaths(platform, env, home);
  if (platform === "linux") return paths[1] ?? null;   // the timer is what gets enabled
  return paths[0] ?? null;
}

/**
 * ⚠ SIBLING SAFETY. EXACT equality, never `startsWith`, never a substring, never a regex.
 *
 * The author's machine runs UNRELATED personal-pipeline agents whose labels differ from ours by one
 * character class: `local.daily_briefing` and `local.daily_briefing_timer` (underscores, not hyphens).
 * A prefix or substring match would select them, and `schedule uninstall` / `--take-over` would then
 * unload somebody else's agent. `test/schedule.install.test.ts` writes those exact negatives.
 */
export function ownsLabel(label: string): boolean {
  return label === SCHEDULE_LABEL;
}

/** ⚠ RE-EXPORTED, NOT DEFINED HERE — and the move is the point. `src/json.ts` needs the PATH of the
 *  schedule record for its state-paths surface, and while this module owned the function that import
 *  was a STATIC edge from the run path into the installer: `daily-briefing run` evaluated this file,
 *  its `proc.run` default exec and all of `./units`, every tick, for a subcommand it never invokes.
 *  `main.ts`'s dynamic-import rationale claimed the opposite and was measurably false. The definition
 *  now lives with the other state-path helpers in `src/marker.ts` (a leaf), json.ts imports it from
 *  THERE, and this re-export keeps `status.ts` and the tests importing it from the module they always
 *  did — one definition, no second spelling. */
export { schedulePath };

// ── atomic writes ───────────────────────────────────────────────────────────────────────────────

/** A unique-PER-CALL sibling name. Per call, not per process: two concurrent writers sharing one temp
 *  name meant the first rename moved it away and the second failed ENOENT — measured in
 *  `src/account.ts`'s concurrency test, and the same trap lives here. */
function tempSibling(path: string): string {
  return `${path}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
}

/**
 * ⚠ TEMP FILE + RENAME IN THE SAME DIRECTORY, never a truncating write — the shape
 * `src/account.ts:118-130` already uses, for a sharper reason here.
 *
 * `schedule.json` is POLLED BY THE GUI, and a torn read of it does not fail loudly: it throws inside
 * `readScheduleRecord`, which is TOTAL and returns `null` — and `null` means "nobody owns this", which
 * OPENS the single-owner gate in `installSchedule`. So a half-written record is not a cosmetic glitch,
 * it is the one state in which two principals can both install a trigger. A unit file caught
 * half-written by `launchctl load` is the same failure one layer down.
 */
async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = tempSibling(path);
  try {
    await Bun.write(tmp, data);
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

/** The same rule for the managed binary: copy to a sibling, chmod it, then rename over the
 *  destination. An in-place `copyFile` TRUNCATES the file the OS trigger points at — and on a refresh
 *  that file may be executing in a concurrent scheduled tick — so a reader sees the old binary or the
 *  new one, never a half of each. */
async function copyFileAtomic(source: string, dest: string, mode: number): Promise<void> {
  const tmp = tempSibling(dest);
  try {
    await copyFile(source, tmp);
    await chmod(tmp, mode);
    await rename(tmp, dest);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

// ── the coordination record ─────────────────────────────────────────────────────────────────────

/**
 * `<state>/schedule.json` — the SINGLE-OWNER record.
 *
 * Two schedulers means two concurrent ticks, and the day-marker check is check-then-act; a single
 * owner record is what keeps that race unreachable rather than merely narrow. Written by whoever
 * installed the trigger, and it is what `schedule status --json` reports to the GUI.
 *
 * `owner` and `invoker` are the same value today by construction — `owner` is the coexistence key
 * ("who may remove this") and `invoker` records the flag as it was given. They are kept separate
 * because the first is a policy field the GUI switches on and the second is provenance; collapsing
 * them would make a future third principal a breaking change rather than an additive one.
 */
export type ScheduleRecord = {
  owner: ScheduleOwner;
  invoker: ScheduleOwner;
  kind: ScheduleKind;
  unitPath: string;
  binPath: string;
  installedAt: string;
  engineVersion: string;
};

/**
 * Is anything at `path`, by `lstat` (spec 3.1.2)? "Something is there", never "it is readable": a
 * dangling symlink, a FIFO and a directory all count, the way Rust's look counts them
 * (`SystemFs::exists`, gui/src-tauri/src/uninstall.rs). Only ENOENT and ENOTDIR read as absent; any
 * other failure (EACCES on a parent, a symlink loop on the way) says only that `lstat` could not
 * answer, and counts as PRESENT, because a gate must not wave through a file it cannot rule out.
 * The one presence rule for the record and the unit files alike.
 */
export async function pathPresent(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** The largest `schedule.json` that is ever read (spec 3.1.2). A real record is a few hundred bytes. */
const SCHEDULE_RECORD_MAX_BYTES = 64 * 1024;

/** Total: an absent, unreadable or malformed record reads as "nobody owns this". A corrupt record
 *  must not be able to block an install forever — the user would have no way out but manual file
 *  surgery, and the file is a coordination hint, not an authority.
 *
 *  ⚠ READ ONLY WHEN `lstat` SHOWS A REGULAR FILE OF AT MOST 64 KiB (spec 3.1.2), the one rule status,
 *  install and uninstall share. Anything else at the path — a symlink, even to a valid record; a FIFO;
 *  a directory; an oversized file — is PRESENT BUT UNREADABLE: `null` here, `true` from `pathPresent`,
 *  its owner unknown. Opening a FIFO blocks until a writer appears, so a read that did not look first
 *  could hang past any time budget; the look is what keeps it bounded. */
export async function readScheduleRecord(path: string = schedulePath()): Promise<ScheduleRecord | null> {
  try {
    const st = await lstat(path);
    if (!st.isFile() || st.size > SCHEDULE_RECORD_MAX_BYTES) return null;
    const o = JSON.parse(await Bun.file(path).text()) as Partial<ScheduleRecord>;
    if ((o.owner !== "cli" && o.owner !== "app") || typeof o.unitPath !== "string") return null;
    return {
      owner: o.owner,
      invoker: o.invoker === "app" || o.invoker === "cli" ? o.invoker : o.owner,
      kind: (o.kind === "launchd" || o.kind === "systemd" || o.kind === "schtasks") ? o.kind : "launchd",
      unitPath: o.unitPath,
      binPath: typeof o.binPath === "string" ? o.binPath : "",
      installedAt: typeof o.installedAt === "string" ? o.installedAt : "",
      engineVersion: typeof o.engineVersion === "string" ? o.engineVersion : "",
    };
  } catch { return null; }
}

export async function writeScheduleRecord(r: ScheduleRecord, path: string = schedulePath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  // ⚠ ATOMIC. See writeFileAtomic: a torn read of THIS file parses as null, and null opens the
  // single-owner gate.
  await writeFileAtomic(path, `${JSON.stringify(r, null, 2)}\n`);
}

// ── signing (darwin) ────────────────────────────────────────────────────────────────────────────

/** The stable local identity `scripts/install.sh:21` already creates and signs with. Parameterized so
 *  a Developer ID drops in with no redesign — see `resolveIdentity`. */
export const DEFAULT_SIGN_IDENTITY = "Daily Briefing (local) Signing";

export function resolveIdentity(opts: { identity?: string }, env: NodeJS.ProcessEnv): string {
  return opts.identity || env.DBA_SIGN_IDENTITY || DEFAULT_SIGN_IDENTITY;
}

/** Mirrors `scripts/install.sh:22-24`: a Homebrew openssl is preferred when present, because macOS's
 *  LibreSSL `pkcs12` has no `-legacy` (its `req` does have `-addext`; measured with LibreSSL 3.3.6). Resolved through the exec seam rather than by
 *  stat-ing paths, so a test never depends on what is installed on the runner. */
async function openssl(exec: Exec): Promise<string> {
  for (const p of ["/opt/homebrew/bin/openssl", "/usr/local/bin/openssl"]) {
    const r = await exec([p, "version"]).catch(() => ({ code: 1, out: "", err: "" }));
    if (r.code === 0) return p;
  }
  return "openssl";
}

/**
 * Ensure the stable local signing identity exists, creating it on demand exactly as
 * `scripts/install.sh:26-61` does — and carrying that script's hard-won details, because every one of
 * them was a failure someone debugged:
 *   • the cert needs `keyUsage=digitalSignature` + `codeSigning` EKU + `CA:FALSE`, or `codesign`
 *     rejects the identity with "no identity found" even though it lists;
 *   • the p12 needs `-legacy` / `-macalg sha1` and a NON-empty password, or `security import` reports
 *     a bogus "MAC verification failed";
 *   • `-A` on import is what sets a permissive keychain partition list; the tighter `-T
 *     /usr/bin/codesign` is RECORDED AS DO-NOT-RE-ATTEMPT — it leaves the default partition list, so
 *     codesign prompts or fails and degrades to ad-hoc, losing the grant this exists for.
 *
 * ⚠ IT TOUCHES THE LOGIN KEYCHAIN, which is why it is reachable ONLY through the injected exec. No
 * test may drive the real one; scanner 4 and `FORBIDDEN_BINARIES` both cover `security`.
 *
 * ⚠ THE KEY MATERIAL'S BOUNDARY IS THE DIRECTORY, NOT THE PASSWORD — recorded because a review read
 * `pw = "dba-local"` as the protection and called the whole block a hijackable signing key. It is
 * not: `mkdtemp` creates a directory with an UNPREDICTABLE suffix and mode 0700 (measured, this
 * platform: two consecutive calls → distinct names, both `700`), so key.pem/cert.pem/id.p12 cannot be
 * pre-created, symlinked over, or read by another user, and the tree is removed in `finally`. The
 * password is a fixed non-empty string because `security import` REJECTS an empty-password p12 with a
 * bogus "MAC verification failed" — it is a format requirement, not a secret, and it protects a file
 * that exists for a few hundred milliseconds inside a directory only this user can enter. Identical
 * to `scripts/install.sh:28`, deliberately.
 *
 * Returns false on ANY failure — the caller degrades to ad-hoc with a warning, never aborts.
 */
async function ensureIdentity(exec: Exec, identity: string, home: string): Promise<boolean> {
  const found = await exec(["security", "find-identity", "-p", "codesigning"]).catch(() => ({ code: 1, out: "", err: "" }));
  if (found.code === 0 && found.out.includes(identity)) return true;

  let dir: string | undefined;
  try {
    dir = await mkdtemp(join(tmpdir(), "dba-signid-"));
    const ssl = await openssl(exec);
    const pw = "dba-local";
    const key = join(dir, "key.pem"), cert = join(dir, "cert.pem"), p12 = join(dir, "id.p12");
    const req = await exec([
      ssl, "req", "-x509", "-newkey", "rsa:2048", "-keyout", key, "-out", cert,
      "-days", "3650", "-nodes", "-subj", `/CN=${identity}`,
      "-addext", "basicConstraints=critical,CA:FALSE",
      "-addext", "keyUsage=critical,digitalSignature",
      "-addext", "extendedKeyUsage=critical,codeSigning",
    ]);
    if (req.code !== 0) return false;
    const base = [ssl, "pkcs12", "-export", "-macalg", "sha1", "-inkey", key, "-in", cert, "-out", p12, "-passout", `pass:${pw}`];
    const legacy = await exec([base[0]!, base[1]!, base[2]!, "-legacy", ...base.slice(3)]);
    if (legacy.code !== 0 && (await exec(base)).code !== 0) return false;
    const kc = join(home, "Library", "Keychains", "login.keychain-db");
    const imp = await exec(["security", "import", p12, "-k", kc, "-P", pw, "-A"]);
    if (imp.code !== 0 && (await exec(["security", "import", p12, "-P", pw, "-A"])).code !== 0) return false;
    const again = await exec(["security", "find-identity", "-p", "codesigning"]);
    return again.code === 0 && again.out.includes(identity);
  } catch {
    return false;
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Strip quarantine from the COPY, then sign it. Degrades with a warning at every step.
 *  Legitimate here precisely because the user explicitly executed this binary and asked it to
 *  schedule itself — and it is STATED in the output rather than done quietly. */
async function signManagedCopy(d: Resolved, copyPath: string, identity: string): Promise<"stable" | "adhoc" | "unsigned"> {
  // An absent attribute makes `xattr -d` exit non-zero; that is the common case, not a problem — but
  // it is NOT "removed", and saying so regardless made the line evidence-free. Branch on the code.
  const q = await d.exec(["xattr", "-d", "com.apple.quarantine", copyPath]).catch(() => ({ code: 1, out: "", err: "" }));
  if (q.code === 0) d.say(`Removed the macOS quarantine attribute from the managed copy at ${copyPath}.`);
  else d.say(`No macOS quarantine attribute to remove from ${copyPath} (xattr exited ${q.code}) — the ordinary case for a locally built binary.`);
  if (await ensureIdentity(d.exec, identity, d.home)) {
    // `--timestamp=none` on BOTH signatures (Phase E M5b checkpoint): codesign's default for whether
    // it asks Apple's timestamp server is per-identity and unspecified, and the README's privacy
    // section promises nothing else is contacted — so no signature this tool makes may depend on it.
    const signed = await d.exec(["codesign", "--force", "--sign", identity, "--timestamp=none", "--identifier", SCHEDULE_LABEL, copyPath]);
    if (signed.code === 0) {
      d.say(`Signed the managed copy with '${identity}' — the macOS folder-access grant will persist across re-installs.`);
      return "stable";
    }
    d.warn(`WARN: codesign with '${identity}' failed — falling back to an ad-hoc signature; the grant may not persist.`);
  } else {
    d.warn(`WARN: could not create/find a stable signing identity '${identity}' — falling back to an ad-hoc signature.`);
    d.warn(`      macOS may re-prompt for folder access after each re-install. Install a real 'openssl' (e.g. \`brew install openssl\`) and re-run.`);
  }
  const adhoc = await d.exec(["codesign", "-s", "-", "-f", "--timestamp=none", copyPath]);
  return adhoc.code === 0 ? "adhoc" : "unsigned";
}

// ── linger (linux) ──────────────────────────────────────────────────────────────────────────────

export type LingerState = "enabled" | "disabled" | "unknown" | "not-applicable";

/** `loginctl show-user <user> --property=Linger` → `Linger=yes|no`. Anything else is "unknown"
 *  rather than a guess: a headless box where this cannot be read is exactly where a wrong answer
 *  costs every future briefing. `timeoutMs`, when given, caps its one exec — `schedule status` passes
 *  5 s so it always answers inside the app's read timeout (spec 3.1.5). A thrown exec, however it throws, is
 *  -2 and so "unknown" (`execNoThrow`): status never crashes here. */
export async function lingerState(d: Resolved, opts: { timeoutMs?: number } = {}): Promise<LingerState> {
  if (d.platform !== "linux") return "not-applicable";
  const user = d.env.USER ?? d.env.LOGNAME;
  if (!user) return "unknown";
  const argv = ["loginctl", "show-user", user, "--property=Linger"];
  const r = await execNoThrow(d.exec, argv, opts.timeoutMs === undefined ? undefined : { timeoutMs: opts.timeoutMs });
  if (r.code !== 0) return "unknown";
  const m = /Linger=(\w+)/.exec(r.out);
  if (!m) return "unknown";
  return m[1] === "yes" ? "enabled" : "disabled";
}

export function lingerCommand(env: NodeJS.ProcessEnv): string {
  return `loginctl enable-linger ${env.USER ?? env.LOGNAME ?? "$USER"}`;
}

// ── install ─────────────────────────────────────────────────────────────────────────────────────

export type InstallOpts = {
  invoker?: ScheduleOwner;        // default "cli"
  takeOver?: boolean;
  identity?: string;
  noVerify?: boolean;
  enableLinger?: boolean;
  confirmExperimental?: boolean;  // windows only
  floorMinutes?: number;
  // ⚠ THERE IS DELIBERATELY NO `intervalSec` KNOB. One stood here, defaulted to DEFAULT_INTERVAL_SEC
  // and was passed by nobody — while `schedule status` reported the CONSTANT unconditionally. Had
  // anything ever set it, the installed unit and the reported interval would have disagreed silently.
  // DEFAULT_INTERVAL_SEC is the single source for both; re-introducing a knob means persisting it in
  // `ScheduleRecord` (additively) and reading it back in `status.ts`, not just widening this type.
  /** Tuning for the final verification kickstart. Injected for tests exactly as `RunDeps`'
   *  `netGraceMs`/`netPollMs` are, and for the same reason: the production values are a 20-second
   *  poll, which no unit test can wait out. Never set on a real install. */
  verify?: { pollMs?: number; deadlineMs?: number; maxIterations?: number };
};

/**
 * ⚠ THE DO-NO-HARM EXIT-CODE CONTRACT, inherited verbatim from the deleted wake work:
 *   0 — exclusively ours: installed/refreshed (or, for uninstall, removed)
 *   1 — nothing to do (uninstall found nothing of ours)
 *   2 — a FOREIGN owner holds the trigger, or the caller refused a required confirmation
 *   3 — an error
 * A GUI switches on these, so they must not be re-purposed.
 */
export const EXIT_OK = 0, EXIT_NONE = 1, EXIT_FOREIGN = 2, EXIT_ERROR = 3;

/**
 * What an install attempt notes as it goes (spec 3.2.2), so that a failure before its record is written can
 * undo exactly what THIS attempt made — and never what was there before it.
 */
type InstallAttempt = {
  /** `schedule.json` was there before, by `lstat` (the 3.1.2 rule), readable or not: a refresh, repair or
   *  take-over, which never rolls back (spec 3.2.4). */
  recordBefore: boolean;
  binPath: string;
  /** Something was at `binPath` before this attempt. */
  binBefore: boolean;
  /** This attempt started copying the engine to `binPath` — never when it runs from `binPath` itself. */
  binCopyStarted: boolean;
  /** The unit paths that were there before this attempt, by `lstat`. */
  unitsBefore: string[];
  /** Each unit path this attempt started writing, noted BEFORE its write — so a service written before a
   *  failing timer write is covered, and a timer whose write failed is looked for and found gone. */
  unitsStarted: string[];
  /** Each unit path whose write COMPLETED, noted after it. A started path missing here was not written: the
   *  default write is temp-then-rename, so a pre-existing file there keeps its earlier content (spec 3.2.6). */
  unitsWritten: string[];
  registration: RegistrationNote;
};

/** Whether the register step ran and, if it failed with a returned code, where and why — its own stderr read
 *  by spec 3.1.5's rules (spec 3.2.2). A THROWN register exec notes no failure: it is no answer at all. */
type RegistrationNote = {
  attempted: boolean;
  failure: { at: "load" | "daemon-reload" | "enable"; reason: RegistrationReason } | null;
};

/**
 * Install (or refresh) the scheduler, owned by `opts.invoker`.
 *
 * ⚠ A FAILED FIRST INSTALL ROLLS BACK (spec 3.2), launchd and systemd only: every failure before
 * `writeScheduleRecord` completes — a returned register failure or a throw — on an install that found no
 * record file (by `lstat`) goes to `rollbackInstall`, which undoes only what this attempt noted it made.
 * With a record before (refresh, repair, take-over) nothing is undone, as before (3.2.4); after the record
 * the install is complete and owned, and a later failure is reported as before and undoes nothing (3.2.1).
 * The successful path keeps its order and writes no extra record (3.2.5): every new tester's setup wizard
 * runs it. Windows keeps today's path, with no rollback (3.1.10).
 */
export async function installSchedule(opts: InstallOpts = {}, deps: ScheduleDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  const kind = kindFor(d.platform);
  if (!kind) { d.warn(`schedule install: no scheduler is supported on ${d.platform}.`); return EXIT_ERROR; }
  const invoker: ScheduleOwner = opts.invoker ?? "cli";

  // Noted BEFORE the gate (spec 3.2.2): was there a record file at all, readable or not?
  const recordBefore = await pathPresent(schedulePath());
  // ── single-owner gate, BEFORE anything is written.
  const existing = await readScheduleRecord();
  if (existing && existing.owner !== invoker && !opts.takeOver) {
    d.warn(`schedule install: the trigger is already owned by "${existing.owner}" (installed ${stripControl(existing.installedAt)}, unit ${stripControl(existing.unitPath)}).`);
    d.warn(`Refusing to replace a configuration somebody else set up. Re-run with --take-over to claim it, or leave it alone and act as a viewer.`);
    return EXIT_FOREIGN;
  }

  if (d.platform === "win32" && !opts.confirmExperimental) {
    // Not an error: the XML is still written and the exact command printed. See registerWindows.
    d.say("⚠ EXPERIMENTAL: the Windows leg has NO runtime evidence. The task XML will be written and the exact command printed, but nothing will be registered without --confirm-experimental — and an install that registers nothing exits 2, not 0.");
  }

  // ── what this attempt finds before it writes anything (spec 3.2.2). `pathPresent` never throws.
  const binPath = managedBinPath(d.platform, d.env, d.home);
  const attempt: InstallAttempt = {
    recordBefore, binPath, binBefore: await pathPresent(binPath), binCopyStarted: false,
    unitsBefore: [], unitsStarted: [], unitsWritten: [], registration: { attempted: false, failure: null },
  };
  for (const p of unitPaths(d.platform, d.env, d.home)) if (await pathPresent(p)) attempt.unitsBefore.push(p);

  // ── everything up to and including the record. ONE try, so a returned failure and a throw alike end in
  // `failed`, and the rollback runs OUTSIDE it: a throw from the rollback could never re-enter it.
  let unitPath = "";
  let failed = false;
  try {
    const source = d.execPath;   // ⚠ execPath, NOT argv[0] — see the header.
    // Copying a file onto itself truncates it on some platforms; a re-run pointed at the managed copy
    // is the ordinary refresh case (`<state>/daily-briefing schedule install`), not an error.
    if (source !== binPath) {
      await mkdir(dirname(binPath), { recursive: true });
      attempt.binCopyStarted = true;
      await copyFileAtomic(source, binPath, 0o755);
      d.say(`Copied the engine to its managed location: ${binPath}`);
    } else {
      d.say(`Already running from the managed location: ${binPath}`);
    }

    // ⚠ NEVER SIGN THE BINARY THAT IS EXECUTING — this file's own header rule (":22": "you can sign a
    // copy; you cannot cleanly re-sign the binary that is executing"). When `source === binPath` the
    // "managed copy" IS this process's image, and that is not a hypothetical branch: it is the REAL
    // `scripts/install.sh` path, which builds straight to the managed location and then runs
    // `"$BIN" schedule install --invoker cli`. `install.sh:66` has already signed that exact file
    // moments earlier, so `codesign --force` here would re-sign a running image to no benefit.
    if (d.platform === "darwin") {
      if (source !== binPath) await signManagedCopy(d, binPath, resolveIdentity(opts, d.env));
      else d.say("Skipped the quarantine strip and the code-signing step: the managed copy IS the binary currently executing, and re-signing a running image is what the managed-copy rule forbids (`scripts/install.sh` signs it before invoking this).");
    }

    // ── the unit(s), from the ONE generator (T1).
    const unitOpts: ScheduleOpts = {
      binPath,
      label: SCHEDULE_LABEL,
      logPath: join(stateDirFor(d.platform, d.env, d.home), "briefing.log"),
      floorMinutes: opts.floorMinutes ?? 7 * 60 + 20,
      // The ONE source, shared with `schedule status` — see InstallOpts.
      intervalSec: DEFAULT_INTERVAL_SEC,
      pathEnv: `${join(d.home, ".local", "bin")}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin`,
    };
    const dir = unitDir(d.platform, d.env, d.home);
    await mkdir(dir, { recursive: true });
    const written = await writeUnits(d, kind, dir, unitOpts, attempt);
    for (const p of written) d.say(`Wrote ${p}`);

    unitPath = primaryUnitPath(d.platform, d.env, d.home)!;
    const registered = await register(d, kind, unitPath, opts, attempt.registration);
    if (registered === "unconfirmed") {
      // ⚠ EXIT 2 AND NO RECORD — the contract's "the caller refused a required confirmation". The XML
      // is the deliverable without the flag and it landed; what did NOT happen is registration, and a
      // `schedule.json` written here would claim ownership of a trigger that does not exist: `status`
      // would report an installed schedule, and `uninstall` would think it had something to remove.
      d.say("Nothing was registered, so no schedule record was written — exiting 2 (a required confirmation was not given). The task XML above is written and ready; pass --confirm-experimental to have the command run for you.");
      return EXIT_FOREIGN;
    }
    if (registered === "failed") {
      failed = true;
    } else {
      await writeScheduleRecord({
        owner: invoker, invoker, kind, unitPath, binPath,
        installedAt: d.now().toISOString(), engineVersion: pkg.version,
      });
    }
  } catch (e) {
    d.warn(`schedule install failed: ${stripControl(e instanceof Error ? e.message : String(e))}`);
    failed = true;
  }
  if (failed) {
    // Exit 3 either way. Only a first install on launchd or systemd rolls back (spec 3.2.1, 3.2.4, 3.1.10).
    return kind === "schtasks" || attempt.recordBefore ? EXIT_ERROR : rollbackInstall(d, kind, attempt);
  }

  // ── after the record: the install is complete and owned. A failure from here on — `reportLinger`'s exec,
  // the verification — is reported as before and undoes nothing (spec 3.2.1).
  try {
    if (d.platform === "linux") await reportLinger(d, opts);

    if (opts.noVerify) {
      d.say("Skipped the verification kickstart (--no-verify).");
      return EXIT_OK;
    }
    // ⚠ THE KICKSTART IS ENGINE-SIDE (plan R1). The desktop app's exec surface stays engine-only —
    // it never needs a launchctl entry in its capability allowlist — because the engine performs its
    // own verification as the final install step, and `schedule verify` exposes the same thing for
    // re-runs.
    const v = await verifySchedule({ kind, unitPath, ...(opts.verify ?? {}) }, deps);
    d.say(verdictLine(v));
    return EXIT_OK;
  } catch (e) {
    d.warn(`schedule install failed: ${stripControl(e instanceof Error ? e.message : String(e))}`);
    return EXIT_ERROR;
  }
}

/** Write the unit file(s) and enforce the AppImage rule on the GENERATED TEXT, not merely on the
 *  path — so any future field that could smuggle a mount path in is covered by construction.
 *
 *  Every write goes through the injected `d.writeFile` (atomic by default; spec 3.1.11), and each path is noted
 *  in `noted.unitsStarted` BEFORE its write (spec 3.2.2) — the service, then the timer — and in
 *  `noted.unitsWritten` once that write completed. */
async function writeUnits(
  d: Resolved, kind: ScheduleKind, dir: string, o: ScheduleOpts, noted: Pick<InstallAttempt, "unitsStarted" | "unitsWritten">,
): Promise<string[]> {
  const write = async (p: string, data: string | Uint8Array) => {
    noted.unitsStarted.push(p);
    await d.writeFile(p, data);
    noted.unitsWritten.push(p);
  };
  if (kind === "launchd") {
    const xml = launchdPlist(o);
    assertNoMountPath(xml, "the launchd plist");
    const p = join(dir, `${SCHEDULE_LABEL}.plist`);
    await write(p, xml);
    return [p];
  }
  if (kind === "systemd") {
    const { service, timer } = systemdUnits(o);
    assertNoMountPath(service, "the systemd service unit");
    assertNoMountPath(timer, "the systemd timer unit");
    const sp = join(dir, SYSTEMD_SERVICE_NAME), tp = join(dir, SYSTEMD_TIMER_NAME);
    await write(sp, service);
    await write(tp, timer);
    return [sp, tp];
  }
  const xml = windowsTaskXml(o);
  assertNoMountPath(xml, "the Windows task XML");
  const p = join(dir, `${WINDOWS_TASK_NAME}.xml`);
  // ⚠ BYTES, not the string: `schtasks /XML` rejects UTF-8. See units.ts's encoding contract.
  await write(p, windowsTaskXmlBytes(xml));
  return [p];
}

/** ⚠ THREE OUTCOMES, NOT A BOOLEAN. "unconfirmed" is the Windows-without-`--confirm-experimental`
 *  path: the XML landed and the command was printed, but NOTHING was registered — which is neither a
 *  success (a record claiming ownership would make `status` lie) nor an error (the caller simply did
 *  not give a confirmation the gate requires). It maps to the contract's exit 2. */
type RegisterOutcome = "registered" | "unconfirmed" | "failed";

/** Why a register command failed, read by spec 3.1.5's rules (spec 3.2.2): -1 and -2 first, as no answer;
 *  then launchd's missing desktop domain or systemd's manager error; anything else is `unexpected`. */
function registerFailureReason(kind: "launchd" | "systemd", r: ExecResult): RegistrationReason {
  if (r.code === -1) return "timeout";
  if (r.code === -2) return "spawn";
  if (kind === "launchd" && launchdDomainMissing(r)) return "no-gui-session";
  if (kind === "systemd" && systemdManagerDown(r)) return "no-user-manager";
  return "unexpected";
}

async function register(d: Resolved, kind: ScheduleKind, unitPath: string, opts: InstallOpts, note: RegistrationNote): Promise<RegisterOutcome> {
  if (kind === "launchd") {
    note.attempted = true;
    // unload-then-load is install.sh's own verb pair, kept for cross-version parity. The unload is
    // expected to fail on a first install; that is not an error.
    await d.exec(["launchctl", "unload", unitPath]).catch(() => ({ code: 1, out: "", err: "" }));
    const r = await d.exec(["launchctl", "load", unitPath]);
    if (r.code !== 0) {
      d.warn(`launchctl load failed (${r.code}): ${stripControl(r.err || r.out)}`);
      note.failure = { at: "load", reason: registerFailureReason(kind, r) };
      return "failed";
    }
    return "registered";
  }
  if (kind === "systemd") {
    note.attempted = true;
    // ⚠ daemon-reload is the FIRST register command, so a missing user bus shows up HERE (spec 3.2.2) —
    // before `enable` could have registered anything, which is what lets the rollback unlink (3.2.3.2).
    const reload = await d.exec(["systemctl", "--user", "daemon-reload"]);
    if (reload.code !== 0) {
      d.warn(`systemctl --user daemon-reload failed (${reload.code}): ${stripControl(reload.err || reload.out)}`);
      note.failure = { at: "daemon-reload", reason: registerFailureReason(kind, reload) };
      return "failed";
    }
    const en = await d.exec(["systemctl", "--user", "enable", "--now", SYSTEMD_TIMER_NAME]);
    if (en.code !== 0) {
      d.warn(`systemctl --user enable --now ${SYSTEMD_TIMER_NAME} failed (${en.code}): ${stripControl(en.err || en.out)}`);
      note.failure = { at: "enable", reason: registerFailureReason(kind, en) };
      return "failed";
    }
    return "registered";
  }
  return registerWindows(d, unitPath, opts);
}

/**
 * ⚠ THE WINDOWS REGISTRATION IS GATED, and the gate is the point. The deterministic half (the XML) is
 * fully built and tested; auto-invoking an unverified `schtasks` call is the part that would
 * manufacture a false claim of a working schedule. The exact command is printed EITHER WAY, so a
 * Windows user who wants it has it, and `--confirm-experimental` is an explicit, informed act.
 *
 * ⚠ AND THE UNCONFIRMED PATH IS "unconfirmed", NOT SUCCESS. It used to return true, which made the
 * install exit 0 and write a `schedule.json` for a task that was never registered — a GUI switching
 * on the documented exit codes was told "installed and ours" about nothing at all. 2 is the contract's
 * code for exactly this ("the caller refused a required confirmation").
 */
async function registerWindows(d: Resolved, unitPath: string, opts: InstallOpts): Promise<RegisterOutcome> {
  const cmd = ["schtasks", "/Create", "/XML", unitPath, "/TN", WINDOWS_TASK_NAME, "/F"];
  d.say(`To register the task (EXPERIMENTAL — untested on any Windows machine):\n  ${cmd.join(" ")}`);
  if (!opts.confirmExperimental) {
    d.say("Not run. Pass --confirm-experimental to have this command executed for you.");
    return "unconfirmed";   // the XML landed — that IS the deliverable without the flag — but nothing is registered.
  }
  const r = await d.exec(cmd);
  if (r.code !== 0) { d.warn(`schtasks failed (${r.code}): ${stripControl(r.err || r.out)}`); return "failed"; }
  d.say("Registered (EXPERIMENTAL — no runtime evidence exists for this path).");
  return "registered";
}

/** ⚠ LINGER IS THE DIFFERENCE BETWEEN WORKING AND SILENTLY NEVER FIRING on a headless box: systemd
 *  user units do not run without a live user manager. Reported loudly with the EXACT command; enabled
 *  only behind `--enable-linger`, because it changes a machine-wide setting the user did not ask for.
 *  It does NOT fail the install — on an ordinary desktop with a live session the timer works without
 *  it, and failing there would block the common case for the uncommon one. */
async function reportLinger(d: Resolved, opts: InstallOpts): Promise<void> {
  const state = await lingerState(d);
  if (state === "enabled") { d.say("Lingering is enabled — the timer will fire on a headless/logged-out machine."); return; }
  if (opts.enableLinger) {
    const r = await d.exec(["loginctl", "enable-linger", d.env.USER ?? d.env.LOGNAME ?? ""]);
    if (r.code === 0) { d.say("Enabled lingering (loginctl enable-linger)."); return; }
    d.warn(`WARN: loginctl enable-linger failed (${r.code}): ${stripControl(r.err || r.out)}`);
  }
  d.warn(`⚠ LINGERING IS ${state.toUpperCase()}. Without it, systemd user timers do NOT run while you are logged out — on an always-on/headless box the briefing would silently never fire. Enable it with:`);
  d.warn(`    ${lingerCommand(d.env)}`);
  d.warn(`  …or re-run \`daily-briefing schedule install --enable-linger\`. \`schedule status\` reports this.`);
}

// ── the manual steps (spec 3.1.8) ───────────────────────────────────────────────────────────────

/** The closing line the engine's own stderr adds after the steps for `--invoker cli` (spec 3.1.8
 *  "Framing"). The steps carry none: the app's screens and `scripts/uninstall.sh` each add their own. */
export const MANUAL_STEPS_CLI_CLOSING = "Then run `daily-briefing schedule uninstall` again.";

const MANUAL_STEPS_FRAMING = "Run these in a terminal (bash or zsh) inside your desktop session.";

/** One single-quoted shell word; an embedded `'` is written `'\''`, as Rust's `unit_uninstall_command`
 *  writes it (gui/src-tauri/src/uninstall.rs). */
function shellWord(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/** A path as a pasteable argument: `"$HOME"/'<rest>'` when it lies under `home` BY PATH BOUNDARY (home
 *  plus `/`, so `/Users/a` never claims `/Users/ab/…`), else one single-quoted word. Never `~`: a quoted
 *  `~` does not expand, and an unquoted one breaks on a space. */
function shellPath(path: string, home: string): string {
  const base = home.replace(/\/+$/, "");
  if (base !== "" && path.startsWith(`${base}/`) && path.length > base.length + 1) {
    return `"$HOME"/${shellWord(path.slice(base.length + 1))}`;
  }
  return shellWord(path);
}

/**
 * ⚠ THE STEPS A USER RUNS BY HAND when the engine could not finish removing the scheduler (spec 3.1.8):
 * unregister by label, confirm with the same rule as `probeRegistration`, then delete. Carried by the
 * uninstall routine's stderr and by `schedule status`'s `removeSteps`, so the app and the terminal show
 * the same text. Every command literal lives HERE because this is the one file scanner R2 lets name the
 * scheduler binaries.
 *
 * PURE: the paths come in as parameters — the unit files, the record and the home they are quoted
 * against — so a test produces the default-path text without clearing the armed
 * DAILY_BRIEFING_STATE_DIR, and nothing here reads the environment or the disk.
 *
 * It begins with the framing line and ends with the delete step: NO CLOSING LINE. The app's screens,
 * the engine's `--invoker cli` stderr (MANUAL_STEPS_CLI_CLOSING) and `scripts/uninstall.sh` each add
 * their own, so this text never tells one surface's user to do another surface's thing.
 */
export function manualRemoveSteps(
  kind: "launchd" | "systemd",
  paths: { units: string[]; record: string; home: string },
): string {
  const q = (p: string) => shellPath(p, paths.home);
  if (kind === "launchd") {
    const gui = `gui/$(id -u)/${SCHEDULE_LABEL}`, user = `user/$(id -u)/${SCHEDULE_LABEL}`;
    return [
      MANUAL_STEPS_FRAMING,
      "1. Unregister the job:",
      `   launchctl bootout ${gui}; launchctl bootout ${user}`,
      "2. Wait a few seconds.",
      `3. Confirm it is gone. Each of these must report not found: it prints "Could not find service", or its last line is "exit 113".`,
      `   launchctl print ${gui}; echo "exit $?"`,
      `   launchctl print ${user}; echo "exit $?"`,
      `   launchctl list ${SCHEDULE_LABEL}; echo "exit $?"`,
      `   If the first one says "Could not find domain", this terminal is not in your desktop session (over SSH, for example): run these steps from a desktop session instead. The second one may say "Could not find domain"; that is fine.`,
      "   If the last one still finds the job (one loaded in another session), run this in the same terminal, wait a few seconds, and confirm again:",
      `   launchctl remove ${SCHEDULE_LABEL}`,
      "4. Delete the files:",
      `   rm -f -- ${[...paths.units, paths.record].map(q).join(" ")}`,
    ].join("\n");
  }
  // The timer first, as spec 3.1.8 writes the delete, whatever order the caller lists the units in.
  const units = [
    ...paths.units.filter((p) => basename(p) === SYSTEMD_TIMER_NAME),
    ...paths.units.filter((p) => basename(p) !== SYSTEMD_TIMER_NAME),
  ];
  const both = `${SYSTEMD_TIMER_NAME} ${SYSTEMD_SERVICE_NAME}`;
  return [
    MANUAL_STEPS_FRAMING,
    `1. Unregister the timer and service (a "not found" from disable is fine):`,
    `   systemctl --user stop ${both}; systemctl --user disable ${SYSTEMD_TIMER_NAME}`,
    "2. Confirm they are gone:",
    `   systemctl --user is-active ${both}`,
    "   must print only inactive, failed or unknown, and",
    `   systemctl --user is-enabled ${SYSTEMD_TIMER_NAME}`,
    "   must print static, disabled, linked, linked-runtime, masked, masked-runtime, bad or not-found, or report that the unit file does not exist.",
    "3. Delete the files and reload:",
    `   rm -f -- ${[...units, paths.record].map(q).join(" ")}; systemctl --user daemon-reload; systemctl --user reset-failed ${both}`,
  ].join("\n");
}

// ── uninstall ───────────────────────────────────────────────────────────────────────────────────

/** Spec 3.1.4's time budget, measured on the injected MONOTONIC clock from the routine's entry: one
 *  deadline, and an earlier end to polling, so the deletion that follows a `gone` still fits before it.
 *  Uninstall and the install rollback (spec 3.2.3) each get their own, from their own start. */
const DEADLINE_MS = 45_000;
const POLL_END_MS = 30_000;
/** The cap on every exec up to the polling end: the first check, the unregister commands, the polls… */
const POLL_EXEC_CAP_MS = 5_000;
/** …and on every deletion exec (`daemon-reload`, `reset-failed`, the final check), wherever it starts. */
const DELETE_EXEC_CAP_MS = 3_000;
/** No exec starts with less than this left before its limit; one that would is skipped and reads -1. */
const MIN_EXEC_LEFT_MS = 250;
const POLL_INTERVAL_MS = 500;

/** A retry may change these answers (spec 3.1.4): `timeout` and `unexpected`. Every other reason is
 *  stable — `no-user-manager`, `no-gui-session`, `spawn` — so polling stops at once on it, and stderr
 *  leads with the manual steps (spec 3.1.7). Listed by what may be retried, so a new reason is stable. */
const isRetryable = (c: RegistrationCheck): boolean =>
  c.state === "unknown" && (c.reason === "timeout" || c.reason === "unexpected");

/**
 * The injected exec under spec 3.1.4's budget. Each call gets `min(capMs, limit − now)`, measured when it
 * STARTS; one that would start with under 250 ms left is not run at all and reads -1, no answer, as a
 * timeout would. A thrown exec reads -2 (spec 3.1.4) — a synchronous throw included (`execNoThrow`), so an
 * unregister that throws is ignored like any other failure and a late `daemon-reload` that throws still ends
 * in 3.1.7's text. So a hung command costs at most its own cap, and nothing run through this can outlast
 * `limit`.
 */
function execWithin(d: Resolved, capMs: number, limit: number): Exec {
  return async (cmd) => {
    const left = limit - d.clock();
    if (left < MIN_EXEC_LEFT_MS) return { code: -1, out: "", err: `skipped: under ${MIN_EXEC_LEFT_MS} ms of the time budget left` };
    return execNoThrow(d.exec, cmd, { timeoutMs: Math.min(capMs, left) });
  };
}

/** One registration check (spec 3.1.5) with every one of its execs under `execWithin`'s budget. */
function checkWithin(d: Resolved, capMs: number, limit: number): Promise<RegistrationCheck> {
  return probeRegistration({ ...d, exec: execWithin(d, capMs, limit) }, { timeoutMs: capMs });
}

/**
 * Spec 3.1.4's polling: check now, then again every 500 ms while `again` says so, until the polling end —
 * the point where a sleep plus the shortest exec no longer fits before it, since a check started later
 * could only read every command as skipped. The caller's `again` carries the rule: the first check
 * repeats only on a retryable `unknown`; the check after unregister on `present` too.
 */
async function pollRegistration(d: Resolved, pollEnd: number, again: (c: RegistrationCheck) => boolean): Promise<RegistrationCheck> {
  let c = await checkWithin(d, POLL_EXEC_CAP_MS, pollEnd);
  while (again(c) && pollEnd - d.clock() >= POLL_INTERVAL_MS + MIN_EXEC_LEFT_MS) {
    await d.sleep(POLL_INTERVAL_MS);
    c = await checkWithin(d, POLL_EXEC_CAP_MS, pollEnd);
  }
  return c;
}

type Removal = { ok: true; removed: boolean } | { ok: false; problem: string };

/**
 * Remove one path the scheduler owns — a unit file or `schedule.json` (spec 3.1.6 steps 1 and 3) — by
 * `lstat` first. Nothing there (ENOENT, ENOTDIR) is success. A symlink is unlinked, never followed. An
 * EMPTY directory is removed with a non-recursive `rmdir`; a non-empty one, and any other error, is a
 * failure naming the path, for the user to move it out of the way. Never recursive: nothing here can
 * take a folder's contents with it.
 */
async function removeOwnedPath(path: string): Promise<Removal> {
  const failed = (why: string): Removal =>
    ({ ok: false, problem: `couldn't remove ${stripControl(path)} (${why}) — move it out of the way` });
  let isDir: boolean;
  try {
    isDir = (await lstat(path)).isDirectory();
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? { ok: true, removed: false } : failed(code ?? String(e));
  }
  try {
    if (isDir) await rmdir(path); else await unlink(path);
    return { ok: true, removed: true };
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { ok: true, removed: false };   // gone between the look and the unlink
    return failed(code === "ENOTEMPTY" || code === "EEXIST" ? "it is a folder with files in it" : code ?? String(e));
  }
}

/** The manual steps around the details (spec 3.1.7, 3.1.8): details first and the steps last — or, for a
 *  STABLE reason, which a retry cannot change, the steps first and the details last. The terminal's
 *  closing line follows the steps, wherever they are; `--invoker app` gets none (the app adds its own). */
function withSteps(details: string[], steps: string, closing: string | null, stepsFirst: boolean): string {
  const tail = closing ? [steps, closing] : [steps];
  return (stepsFirst ? [...tail, ...details] : [...details, ...tail]).join("\n");
}

const describeCheck = (c: RegistrationCheck): string =>
  c.state === "present" ? "still registered" : c.state === "gone" ? "gone" : `couldn't tell (${c.reason})`;

/** What a `present` check found, as a "still there" entry. Linux's `present` means EITHER unit is running OR
 *  the timer is enabled (probeSystemd), so the text claims one of them, never both. */
const registeredText = (kind: "launchd" | "systemd"): string =>
  kind === "launchd" ? `the registered job ${SCHEDULE_LABEL}` : `a registered ${SYSTEMD_TIMER_NAME} or ${SYSTEMD_SERVICE_NAME}`;

/**
 * Spec 3.1.3's unregister, BY THE EXACT LABEL: `bootout` in both launchd domains — never `unload <plist>`,
 * which acts on whatever job the file at that path names — and `stop` then `disable` on systemd (`stop`
 * works on a unit whose file is already gone; `disable`'s not-found after a manual cleanup is expected).
 * Each command's own failure is ignored: the check that follows decides. Every exec is capped against the
 * polling end. The one copy, shared by uninstall and the install rollback (spec 3.2.3), so the two can
 * never unregister different things.
 */
async function unregisterByLabel(d: Resolved, kind: "launchd" | "systemd", pollEnd: number): Promise<void> {
  const unregister = execWithin(d, POLL_EXEC_CAP_MS, pollEnd);
  if (kind === "launchd") {
    await unregister(["launchctl", "bootout", `gui/${d.uid}/${SCHEDULE_LABEL}`]);
    await unregister(["launchctl", "bootout", `user/${d.uid}/${SCHEDULE_LABEL}`]);
  } else {
    await unregister(["systemctl", "--user", "stop", SYSTEMD_TIMER_NAME, SYSTEMD_SERVICE_NAME]);
    await unregister(["systemctl", "--user", "disable", SYSTEMD_TIMER_NAME]);
  }
}

/**
 * ⚠ REMOVE THE SCHEDULER, AND SAY SO ONLY WHEN A CHECK AFTER THE FACT FINDS IT GONE (spec 3.1) — never
 * because the commands returned 0. launchd and systemd only; Windows keeps today's path (3.1.10).
 *
 *   • What counts as installed (3.1.2): the record file (by `lstat`, readable or not), a unit file (by
 *     `lstat`), or — only when NOTHING is on disk — the registration check saying `present`. That first
 *     check is the only way a job with no files is seen; with a file on disk the gate decides at once.
 *   • The gate (3.1.1). The terminal's is unchanged: a readable record owned by someone else is exit 2
 *     without `--take-over`. The app's is stricter: exit 2 for ANYTHING installed whose record is not
 *     readable as owned by `app` — a terminal record, an unreadable one, a unit with no record, a
 *     registration with no files — with fixed text naming what was found (the app shows it verbatim).
 *   • Unregister BY LABEL (3.1.3) — `bootout` in both launchd domains, never `unload <plist>`, which acts
 *     on whatever job the file at that path names; `stop` then `disable` on systemd. Every command's own
 *     failure is ignored: the check decides.
 *   • Delete ONLY once the check says `gone` (3.1.6): the units, then on Linux `daemon-reload`,
 *     `reset-failed` and one more check, then `schedule.json` LAST. Anything else ends in 3.1.7 — exit 3,
 *     nothing more deleted, the record kept, and stderr naming what remains, what this attempt removed,
 *     the check's answer, and the manual steps.
 *   • Time (3.1.4): one deadline (entry + 45 s) and a polling end (entry + 30 s) on the injected monotonic
 *     clock, every exec capped by `execWithin`, every wait through the injected `sleep`.
 *
 * The exit codes keep their meaning (EXIT_*): 0 removed, 1 nothing to remove (nothing on disk and the
 * check says gone — with its line on stdout, which a crash never prints), 2 not yours to remove, 3 error.
 * Every step sits inside the one try block, so a throw exits 3 here. The managed engine copy stays
 * (3.1.9): it may be the binary that is running.
 */
export async function uninstallSchedule(
  opts: { invoker?: ScheduleOwner; takeOver?: boolean } = {}, deps: ScheduleDeps = {},
): Promise<number> {
  const d = resolveDeps(deps);
  const kind = kindFor(d.platform);
  if (!kind) { d.warn(`schedule uninstall: no scheduler is supported on ${d.platform}.`); return EXIT_ERROR; }
  const invoker: ScheduleOwner = opts.invoker ?? "cli";
  if (kind === "schtasks") return uninstallWindows(d, invoker, opts.takeOver === true);
  try {
    const entry = d.clock();
    const pollEnd = entry + POLL_END_MS, deadline = entry + DEADLINE_MS;
    // ⚠ EVERY path and command here is built from the EXACT label — see `ownsLabel`. Nothing globs,
    // nothing prefix-matches, so a sibling agent is unreachable from this code by construction.
    const units = unitPaths(d.platform, d.env, d.home);
    const recordPath = schedulePath();
    const steps = manualRemoveSteps(kind, { units, record: recordPath, home: d.home });
    const closing = invoker === "cli" ? MANUAL_STEPS_CLI_CLOSING : null;

    // ── what is on disk (spec 3.1.2): presence by lstat; the record READ only by the bounded rule.
    const record = await readScheduleRecord(recordPath);
    const recordFile = await pathPresent(recordPath);
    const unitsOnDisk: string[] = [];
    for (const p of units) if (await pathPresent(p)) unitsOnDisk.push(p);

    if (!recordFile && unitsOnDisk.length === 0) {
      // The first check: the only way a registration with no files is seen.
      const first = await pollRegistration(d, pollEnd, isRetryable);
      if (first.state === "gone") { d.say("Nothing installed by daily-briefing was found."); return EXIT_NONE; }
      if (first.state === "unknown") {
        const detail = `Couldn't check whether a background scheduler is registered (${first.reason}). Nothing was removed.`;
        d.warn(withSteps([detail], steps, closing, !isRetryable(first)));
        return EXIT_ERROR;
      }
    }

    // ── the gate (spec 3.1.1), before any change.
    if (invoker === "app") {
      if (!opts.takeOver && record?.owner !== "app") {
        d.warn(`This background scheduler wasn't set up by this app (${foundText(kind, record, recordFile ? recordPath : null, unitsOnDisk)}). Removing it needs your go-ahead.`);
        return EXIT_FOREIGN;
      }
    } else if (record && record.owner !== invoker && !opts.takeOver) {
      d.warn(`schedule uninstall: the trigger is owned by "${record.owner}", not "${invoker}" — removing only what we own. Re-run with --take-over to remove it anyway.`);
      return EXIT_FOREIGN;
    }

    // ── unregister by label (spec 3.1.3). Each command's own failure is ignored: the check decides.
    await unregisterByLabel(d, kind, pollEnd);
    const after = await pollRegistration(d, pollEnd, (c) => c.state === "present" || isRetryable(c));

    // ── 3.1.7: not gone in time, or a step of 3.1.6 failed. Delete nothing more; keep the record.
    const removed: string[] = [];
    const fail = async (problem: string, check: RegistrationCheck): Promise<number> => {
      const still: string[] = [];
      for (const p of [...units, recordPath]) if (await pathPresent(p)) still.push(stripControl(p));
      if (check.state === "present") still.push(registeredText(kind));
      const details = [
        `Couldn't finish removing the background scheduler: ${problem}.`,
        `Still present: ${still.length > 0 ? still.join("; ") : "no files"}.`,
        removed.length > 0 ? `This attempt removed: ${removed.map(stripControl).join(", ")}.` : "This attempt removed no files.",
        `Registration check: ${describeCheck(check)}.`,
      ];
      if (await pathPresent(recordPath)) details.push("The schedule record was kept, so running the removal again starts over by name.");
      d.warn(withSteps(details, steps, closing, check.state === "unknown" && !isRetryable(check)));
      return EXIT_ERROR;
    };
    if (after.state !== "gone") {
      return await fail(after.state === "present" ? "it is still registered after unregistering it" : "couldn't confirm that it is gone", after);
    }

    // ── delete, only now (spec 3.1.6): the units, the Linux reload and final check, the record LAST.
    for (const p of units) {
      const r = await removeOwnedPath(p);
      if (!r.ok) return await fail(r.problem, after);
      if (r.removed) removed.push(p);
    }
    let last: RegistrationCheck = after;
    if (kind === "systemd") {
      const late = execWithin(d, DELETE_EXEC_CAP_MS, deadline);
      const reload = await late(["systemctl", "--user", "daemon-reload"]);
      if (reload.code !== 0) {
        return await fail(`systemctl --user daemon-reload failed (${reload.code}): ${stripControl(reload.err || reload.out).trim()}`, after);
      }
      await late(["systemctl", "--user", "reset-failed", SYSTEMD_TIMER_NAME, SYSTEMD_SERVICE_NAME]);   // its failure is ignored
      last = await checkWithin(d, DELETE_EXEC_CAP_MS, deadline);
      if (last.state !== "gone") return await fail("the final check after the reload did not find it gone", last);
    }
    const rec = await removeOwnedPath(recordPath);
    if (!rec.ok) return await fail(rec.problem, last);

    // ⚠ THE MANAGED COPY IS DELIBERATELY LEFT IN PLACE (spec 3.1.9): it may be the binary currently
    // executing, and a user who removes the SCHEDULE has not asked to remove the TOOL.
    // Exit 0's stdout is spec 3.1.6 step 4's one line. The note about the script is the TERMINAL's only:
    // the app shows exit-0 stdout verbatim (gui/src/lib/uninstall-flow.ts), and its own Uninstall removes
    // the copy (spec 3.5), so an app user must never be told to run a shell script.
    d.say("Removed the background scheduler.");
    if (invoker === "cli") d.say("The engine binary itself was left in place — `scripts/uninstall.sh` removes that.");
    return EXIT_OK;
  } catch (e) {
    d.warn(`schedule uninstall failed: ${stripControl(e instanceof Error ? e.message : String(e))}`);
    return EXIT_ERROR;
  }
}

/**
 * `<what was found>` in the app's refusal (spec 3.1.1), which the app's foreign-owner dialog shows
 * verbatim (spec 3.4.3): the record and its state, and the unit paths taking over would remove — or, with
 * no file at all, the loaded job the check found.
 */
function foundText(kind: "launchd" | "systemd", record: ScheduleRecord | null, recordFile: string | null, unitsOnDisk: string[]): string {
  const unitPart = unitsOnDisk.length === 1
    ? `the unit file ${stripControl(unitsOnDisk[0]!)}`
    : `the unit files ${unitsOnDisk.map(stripControl).join(" and ")}`;
  if (recordFile === null) {
    if (unitsOnDisk.length > 0) return `${unitPart}, with no schedule record`;
    return kind === "launchd" ? "a loaded job with no files" : "a timer and service with no files";
  }
  const recordPart = record
    ? `a schedule record set up from ${record.owner === "cli" ? "the terminal" : `"${record.owner}"`} at ${stripControl(recordFile)}`
    : `a schedule record that can't be read at ${stripControl(recordFile)}`;
  return unitsOnDisk.length > 0 ? `${recordPart}, and ${unitPart}` : `${recordPart}, with no unit file`;
}

/**
 * ⚠ WINDOWS KEEPS TODAY'S PATH, unchanged (spec 3.1.10): it is experimental with no runtime evidence, so
 * the checked removal above is not extended to it — the owner gate, nothing installed as exit 1, an
 * unchecked `schtasks /Delete`, the unlinks, exit 0.
 */
async function uninstallWindows(d: Resolved, invoker: ScheduleOwner, takeOver: boolean): Promise<number> {
  const record = await readScheduleRecord();
  if (record && record.owner !== invoker && !takeOver) {
    d.warn(`schedule uninstall: the trigger is owned by "${record.owner}", not "${invoker}" — removing only what we own. Re-run with --take-over to remove it anyway.`);
    return EXIT_FOREIGN;
  }
  try {
    const present: string[] = [];
    for (const p of unitPaths(d.platform, d.env, d.home)) if (await Bun.file(p).exists()) present.push(p);
    if (present.length === 0 && !record) { d.say("Nothing installed by daily-briefing was found."); return EXIT_NONE; }
    await d.exec(["schtasks", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]).catch(() => ({ code: 1, out: "", err: "" }));
    for (const p of present) await unlink(p).catch(() => {});
    await unlink(schedulePath()).catch(() => {});
    // ⚠ THE MANAGED COPY IS DELIBERATELY LEFT IN PLACE: it may be the binary currently executing.
    d.say(`Removed the trigger${present.length ? ` (${present.join(", ")})` : ""}. The engine binary itself was left in place — \`scripts/uninstall.sh\` removes that.`);
    return EXIT_OK;
  } catch (e) {
    d.warn(`schedule uninstall failed: ${stripControl(e instanceof Error ? e.message : String(e))}`);
    return EXIT_ERROR;
  }
}

// ── a failed first install rolls back (spec 3.2) ────────────────────────────────────────────────

/**
 * ⚠ UNDO WHAT A FAILED FIRST INSTALL MADE — AND NOTHING ELSE (spec 3.2.3). `installSchedule` calls it for a
 * failure before `writeScheduleRecord` completed, on launchd or systemd, when no record file was there
 * before. Its own routine: it reuses uninstall's unregister by label (3.1.3) and the check (3.1.5), but not
 * uninstall's polling exits or its deletion, and it has its own deadline (its start + 45 s) and polling end
 * (+ 30 s) with the same per-exec caps (3.1.4). Every command goes through `d.exec`, so the default exec's
 * refusal (3.1.3) covers it.
 *   1. Unregister and check — only when NO unit path existed before this attempt and registration was
 *      attempted. A unit already at our path may belong to a record-less job this install was taking over
 *      (the gate checks only the record), so with one, nothing at all runs by name; and with registration
 *      never attempted there is nothing to unregister.
 *   2. The unit files this attempt started writing are unlinked — never with a pre-existing unit — when the
 *      check says `gone`, or registration was never attempted, or (Linux only) the register step failed AT
 *      its first command, `daemon-reload`, for `no-user-manager` and the check says the same: `enable` never
 *      ran, so nothing can have been registered (item 28). Otherwise they stay: on macOS every `unknown`
 *      keeps them, since a failed `load` may have reached some domain.
 *   3. Linux: one `daemon-reload` after any unlink, skipped under `no-user-manager`, where it can only fail.
 *      Its failure is reported and changes nothing that was removed.
 *   4. The managed binary goes only if this attempt created it, and only once no unit file this attempt
 *      wrote remains — a unit that stays names it.
 *   5. stderr ends "Rolled back: nothing was left behind." or with the list of what is left, found by
 *      LOOKING (`lstat`), never assumed, at every unit path this attempt found there or started writing — a
 *      pre-existing unit marked as overwritten, as kept by a write that failed, or as never touched — and the
 *      manual steps, whose `rm` names only this attempt's own units. Exit 3, as before.
 * It never throws: a throw inside is reported as where the rollback stopped, and what is left is still
 * looked up.
 */
async function rollbackInstall(d: Resolved, kind: "launchd" | "systemd", a: InstallAttempt): Promise<number> {
  const ownUnits = a.unitsBefore.length === 0;
  const binCreated = a.binCopyStarted && !a.binBefore;
  const removed: string[] = [], problems: string[] = [];
  let check: RegistrationCheck | null = null;
  /** Item 28: the check can't reach a user manager, and the register step failed AT daemon-reload for that
   *  same reason — so `enable` never ran and nothing can have been registered. */
  let neverEnabled = false;
  let stopped: string | null = null;
  try {
    const entry = d.clock();
    const pollEnd = entry + POLL_END_MS, deadline = entry + DEADLINE_MS;

    // 1. Unregister and check.
    if (ownUnits && a.registration.attempted) {
      await unregisterByLabel(d, kind, pollEnd);
      check = await pollRegistration(d, pollEnd, (c) => c.state === "present" || isRetryable(c));
    }

    // 2. The unit files this attempt started writing. A path noted before a write that failed may never have
    //    been created: finding it missing is success.
    const managerDown = check !== null && check.state === "unknown" && check.reason === "no-user-manager";
    neverEnabled = kind === "systemd" && managerDown
      && a.registration.failure?.at === "daemon-reload" && a.registration.failure.reason === "no-user-manager";
    if (ownUnits && (!a.registration.attempted || check?.state === "gone" || neverEnabled)) {
      let unlinked = 0;
      for (const p of a.unitsStarted) {
        const r = await removeOwnedPath(p);
        if (!r.ok) problems.push(`The rollback ${r.problem}.`);
        else if (r.removed) { removed.push(p); unlinked++; }
      }
      // 3. One daemon-reload after any unlink, so systemd forgets the removed units.
      if (kind === "systemd" && unlinked > 0 && !managerDown) {
        const r = await execWithin(d, DELETE_EXEC_CAP_MS, deadline)(["systemctl", "--user", "daemon-reload"]);
        if (r.code !== 0) {
          const why = stripControl(r.err || r.out).trim();
          problems.push(`systemctl --user daemon-reload after removing the unit files failed (${r.code})${why ? `: ${why}` : ""}.`);
        }
      }
    }

    // 4. The managed binary.
    let unitRemains = false;
    for (const p of a.unitsStarted) if (await pathPresent(p)) unitRemains = true;
    if (binCreated && !unitRemains) {
      const r = await removeOwnedPath(a.binPath);
      if (!r.ok) problems.push(`The rollback ${r.problem}.`);
      else if (r.removed) removed.push(a.binPath);
    }
  } catch (e) {
    stopped = stripControl(e instanceof Error ? e.message : String(e));
  }

  // 5. What is left, by looking — whatever happened above — at EVERY unit path this attempt found there or
  //    started writing: one that was there before and that this attempt never touched is left behind too, and
  //    "nothing was left behind" must never be said over it. Listed in `unitPaths` order (the service, then the
  //    timer); the union itself is what is looked at, so nothing in either list can be skipped.
  const left: string[] = [];
  let ownLeft = false;   // something THIS attempt made at our paths, which the manual steps remove
  const order = unitPaths(d.platform, d.env, d.home);
  const looked = [...new Set([...a.unitsBefore, ...a.unitsStarted])].sort((x, y) => order.indexOf(x) - order.indexOf(y));
  for (const p of looked) {
    if (!(await pathPresent(p))) continue;
    if (!a.unitsBefore.includes(p)) {
      left.push(stripControl(p));
      ownLeft = true;
      continue;
    }
    // A pre-existing unit says what this attempt did to it (spec 3.2.6). A started write that never completed
    // left the earlier file: the default write is temp-then-rename.
    const what = !a.unitsStarted.includes(p) ? "it was there before this install and was not changed"
      : a.unitsWritten.includes(p) ? "it was there before this install, which overwrote it: its earlier content can't be restored"
      : "it was there before this install; this install's write to it failed, so its earlier content should be intact";
    left.push(`${stripControl(p)} (${what})`);
  }
  if (a.registration.attempted && check?.state !== "gone" && !neverEnabled) {
    const why = !ownUnits ? "not checked: a unit file was there before this install, so nothing was run by name"
      : check === null ? "the rollback stopped before its check finished"
      : check.state === "unknown" ? `couldn't tell: ${check.reason}`
      : null;
    left.push(why === null ? registeredText(kind) : `possibly ${registeredText(kind)} (${why})`);
    if (ownUnits) ownLeft = true;
  }
  if (binCreated && await pathPresent(a.binPath)) left.push(`the engine copy at ${stripControl(a.binPath)}`);

  const out: string[] = [];
  if (stopped !== null) out.push(`The rollback stopped: ${stopped}.`);
  if (check !== null) {
    out.push(neverEnabled
      ? `Registration check: ${describeCheck(check)}, and the install failed at daemon-reload for the same reason, so nothing was registered.`
      : `Registration check: ${describeCheck(check)}.`);
  }
  out.push(...problems);
  out.push(removed.length > 0 ? `This rollback removed: ${removed.map(stripControl).join(", ")}.` : "This rollback removed no files.");
  if (left.length === 0) {
    out.push("Rolled back: nothing was left behind.");
  } else {
    // The manual steps for what THIS attempt left at our paths, and their `rm` names only this attempt's own
    // unit files (started, and not there before). A unit that was there before is only reported (spec 3.2.3.1):
    // the Schedule screen and Uninstall offer its removal through the take-over choice. The steps' unregister
    // lines act by label, whatever the files; they stay whenever an own unit or a possibly-registered job of
    // ours is left (`ownLeft`), because deleting a unit file that may still be loaded is exactly what the
    // steps' unregister-confirm-delete order exists to prevent.
    if (ownLeft) {
      const own = a.unitsStarted.filter((p) => !a.unitsBefore.includes(p));
      out.push(manualRemoveSteps(kind, { units: own, record: schedulePath(), home: d.home }));
    }
    out.push(`Left behind: ${left.join("; ")}.`);
  }
  d.warn(out.join("\n"));
  return EXIT_ERROR;
}

// ── verify (the engine-side kickstart, plan R1) ─────────────────────────────────────────────────

export type VerifyResult = {
  kickstarted: boolean;
  /** ⚠ `already-delivered-before-kick` IS NOT A PASS. It is the state where today's delivery was
   *  already on disk BEFORE the kick, so nothing the kick did (or failed to do) could be observed —
   *  see `verifySchedule`'s baseline. It exists because the alternative was reporting it as
   *  "delivered". Additive: a consumer switching on the old three values must treat an unknown
   *  outcome as "not verified", which is what this one means. */
  outcome: "delivered" | "skipped" | "no-evidence" | "already-delivered-before-kick";
  skipReason: string | null;
  detail: string | null;
  iterations: number;
};

export function verdictLine(v: VerifyResult): string {
  if (!v.kickstarted) return "Verification kickstart could not be started — run `daily-briefing schedule verify` once the scheduler is up.";
  if (v.outcome === "delivered") return "Verified: the kickstarted run DELIVERED a briefing. Steady-state delivery is now watched at the next tick.";
  if (v.outcome === "skipped") return `Verified: the kickstarted run reached the engine and declined (${v.skipReason}) — the trigger works. ${v.detail ?? ""}`.trim();
  if (v.outcome === "already-delivered-before-kick") {
    // ⚠ NOT a claim that the kicked run delivered. The kick was ACCEPTED by the scheduler and produced
    // no NEW evidence, which says nothing either way about whether the trigger still reaches the engine.
    return "NOT VERIFIED: the kick was accepted, but today's delivery was already recorded BEFORE it, so this run produced no NEW evidence and cannot show the trigger reached the engine. Re-run `daily-briefing schedule verify` tomorrow, or check `daily-briefing schedule status` for the tick count.";
  }
  return "The kickstart was issued but no evidence appeared in time. Check `daily-briefing schedule status` in a few minutes.";
}

/**
 * ⚠ THE EXIT CODE OF `schedule verify`, on the same do-no-harm contract as install/uninstall — and
 * separate from `verdictLine` so the text and the code cannot disagree.
 *   0 — evidence APPEARED that the kick reached the engine (delivered, or a skip it wrote).
 *   1 — the kick was accepted but produced NO NEW evidence (`no-evidence`,
 *       `already-delivered-before-kick`): inconclusive, not a failure of the machine.
 *   3 — the kick could not be issued at all; the scheduler refused it.
 * 2 is NOT used here: no verify path refuses a confirmation and none finds a foreign owner.
 */
export function verifyExitCode(v: VerifyResult): number {
  if (!v.kickstarted) return EXIT_ERROR;
  return v.outcome === "delivered" || v.outcome === "skipped" ? EXIT_OK : EXIT_NONE;
}

/** A skip's IDENTITY, for baseline comparison. `iso` is what makes two skips distinguishable — the
 *  engine writes a fresh timestamp on every decline — so a pre-existing skip carrying today's date
 *  cannot masquerade as evidence produced by this kick. */
function skipFingerprint(s: { iso?: string; localDate?: string; reason?: string; detail?: string } | null | undefined): string {
  return s ? `${s.iso ?? ""}|${s.localDate ?? ""}|${s.reason ?? ""}|${s.detail ?? ""}` : "";
}

/**
 * Kick the registered trigger once and read what the engine left behind.
 *
 * ⚠ REGISTRATION-OWNED, not app-owned (plan R1). The kick goes through the SCHEDULER, not through a
 * direct `run` call, because the fact under test is "does the trigger reach the engine" — a direct
 * run would answer a different question and pass while the schedule was dead.
 *
 * ⚠ IT DOES NOT LOOP PAST A DELIVERY. On a fresh install the first iteration exercises repo reads and
 * may deliver a THIN briefing; the plan's ruling is explicit that a delivery ends the loop and the
 * thin-ness is carried by `doctor`'s "repos need access" rather than by retrying here. Only a SKIP
 * loops, and only on skip reasons that a retry could change.
 *
 * ⚠⚠ ONLY A CHANGE FROM THE BASELINE COUNTS AS EVIDENCE, and the baseline is taken BEFORE the first
 * kick. MEASURED, not theorised: with the marker already carrying today's date — the ordinary case,
 * because the morning briefing has been delivered by the time anyone runs `schedule verify` — the
 * first poll was satisfied instantly by state that predated the kick, and a fake exec that ran
 * NOTHING AT ALL was reported as "the kickstarted run DELIVERED a briefing" in 13ms. A verifier that
 * passes against a dead trigger is worse than no verifier, because its verdict is what gets quoted.
 * So `readLastRunDate()` and `readLastSkip()` are snapshotted first, and a value equal to the
 * snapshot is treated as what it is: the state that was already there. When the baseline itself says
 * today was delivered and nothing changes, the outcome is `already-delivered-before-kick`, which
 * verdictLine reports as NOT VERIFIED rather than as a delivery.
 *
 * (The marker's VALUE is enough to discriminate: a second delivery on the same day cannot occur —
 * the day marker makes the engine decline with `already-ran`, which shows up as a CHANGED last-skip
 * and is detected on that side. mtime would add a second mechanism for no additional fact.)
 */
export async function verifySchedule(
  ctx: { kind?: ScheduleKind; unitPath?: string; maxIterations?: number; pollMs?: number; deadlineMs?: number } = {},
  deps: ScheduleDeps = {},
): Promise<VerifyResult> {
  const d = resolveDeps(deps);
  const kind = ctx.kind ?? kindFor(d.platform);
  const pollMs = ctx.pollMs ?? 500;
  const deadlineMs = ctx.deadlineMs ?? 20_000;
  const maxIterations = ctx.maxIterations ?? 2;
  const { readLastSkip, readLastRunDate, localDateStr } = await import("../marker");
  const today = localDateStr(d.now());

  // ⚠ THE BASELINE — read BEFORE the first kick. See the header: everything below asks "did this
  // CHANGE", never "is this satisfying".
  const baseRun = await readLastRunDate();
  const baseSkip = skipFingerprint(await readLastSkip());
  const deliveredBeforeKick = baseRun === today;

  let iterations = 0;
  let kickstarted = false;
  for (let i = 0; i < maxIterations; i++) {
    iterations++;
    const kicked = await kick(d, kind);
    kickstarted = kickstarted || kicked;
    if (!kicked) break;
    const started = Date.now();
    while (Date.now() - started < deadlineMs) {
      await new Promise((r) => setTimeout(r, pollMs));
      const runDate = await readLastRunDate();
      if (runDate === today && runDate !== baseRun) {
        return { kickstarted: true, outcome: "delivered", skipReason: null, detail: null, iterations };
      }
      const skip = await readLastSkip();
      if (skip && skip.localDate === today && skipFingerprint(skip) !== baseSkip) {
        // "already-ran" and "below-floor" both PROVE the trigger reached the engine, which is the
        // fact being verified; neither is improved by another iteration.
        const settled = skip.reason === "already-ran" || skip.reason === "below-floor";
        if (settled || i === maxIterations - 1) {
          return { kickstarted: true, outcome: "skipped", skipReason: skip.reason, detail: skip.detail ?? null, iterations };
        }
        break;   // a retryable skip — loop once more
      }
    }
  }
  if (kickstarted && deliveredBeforeKick) {
    // The scheduler ACCEPTED the kick and nothing new appeared — because today's delivery was already
    // recorded when we started. Distinct from "no-evidence" (where there was nothing to begin with):
    // here the state that would have been read as proof is provably older than the kick.
    return {
      kickstarted: true, outcome: "already-delivered-before-kick", skipReason: null,
      detail: `today's delivery (${today}) was already recorded before the kick`, iterations,
    };
  }
  return { kickstarted, outcome: "no-evidence", skipReason: null, detail: null, iterations };
}

async function kick(d: Resolved, kind: ScheduleKind | null): Promise<boolean> {
  if (kind === "launchd") {
    // `launchctl start <label>` — the EXACT label, the verb install.sh's own output already tells the
    // user to run. No uid arithmetic, no `gui/<uid>` domain string to get wrong.
    const r = await d.exec(["launchctl", "start", SCHEDULE_LABEL]).catch(() => ({ code: 1, out: "", err: "" }));
    return r.code === 0;
  }
  if (kind === "systemd") {
    // ⚠ `--no-block`: the service is `Type=oneshot`, so a plain `start` waits for the whole briefing
    // run, and a run longer than SCHEDULE_EXEC_TIMEOUT_MS read as a kick that "could not be started"
    // while it went on to deliver. Queued instead, like `launchctl start`; `verifySchedule`'s polling
    // sees a short run, and the app's watcher a longer one.
    const r = await d.exec(["systemctl", "--user", "start", "--no-block", SYSTEMD_SERVICE_NAME]).catch(() => ({ code: 1, out: "", err: "" }));
    return r.code === 0;
  }
  return false;   // windows: gated, and there is no evidence to gather anyway.
}

// ── registration-state probe (shared with status) ───────────────────────────────────────────────

/** Why the check could not say present or gone (spec 3.1.5). `timeout` and `unexpected` may change on
 *  a retry; `no-user-manager`, `no-gui-session` and `spawn` are STABLE — repeating cannot help. */
export type RegistrationReason = "no-user-manager" | "no-gui-session" | "timeout" | "spawn" | "unexpected";
export type RegistrationCheck =
  | { state: "present" }
  | { state: "gone" }
  | { state: "unknown"; reason: RegistrationReason };

/** launchd's "service not found" exit code (`launchctl print` / `list` on a missing label). */
const LAUNCHD_NOT_FOUND = 113;

/** One read-only probe exec. A THROWN exec counts as -2 (spec 3.1.4) — synchronously or by rejecting
 *  (`execNoThrow`) — so nothing here can throw, and `schedule status` never crashes on the check. */
function probeExec(d: Resolved, cmd: string[], timeoutMs: number): Promise<ExecResult> {
  return execNoThrow(d.exec, cmd, { timeoutMs });
}

/** -1 (timed out or read short) and -2 (could not run) are NO ANSWER for that command, before any other
 *  rule reads it (spec 3.1.4): neither is ever a non-zero exit or a not-found, and its text is not read. */
const noAnswer = (r: ExecResult): boolean => r.code === -1 || r.code === -2;

/** launchd's "domain not found" (spec 3.1.5 macOS step 2): the desktop domain is missing, as over SSH. Never
 *  read from a -1 or -2. Shared by the check and by the install's register step (spec 3.2.2). */
const launchdDomainMissing = (r: ExecResult): boolean => !noAnswer(r) && r.err.includes("Could not find domain");

/** systemd's manager error (spec 3.1.5 Linux step 1): "Failed to connect to" followed on the same line by
 *  "bus" (systemd ≤ 256's "…to bus:" and ≥ 257's "…to user scope bus via local transport:"), or any mention
 *  of XDG_RUNTIME_DIR. Never read from a -1 or -2. Shared by the check and by the install's register step
 *  (spec 3.2.2), whose first command is where a missing user bus shows up. */
const systemdManagerDown = (r: ExecResult): boolean =>
  !noAnswer(r) && (/Failed to connect to[^\n]*bus/.test(r.err) || r.err.includes("XDG_RUNTIME_DIR"));

/** The reason for an `unknown` that no stable rule explained (spec 3.1.5 macOS step 4). */
function unknownReason(rs: ExecResult[]): RegistrationCheck {
  const reason: RegistrationReason = rs.some((r) => r.code === -1) ? "timeout" : rs.some((r) => r.code === -2) ? "spawn" : "unexpected";
  return { state: "unknown", reason };
}

/**
 * ⚠ THE ONE REGISTRATION CHECK (spec 3.1.5): is a job registered under our EXACT label right now?
 * Three answers, never a boolean, because "the check could not run" is not "no" — reading it as "no" is
 * how a live job gets reported gone, and how `schedule status` used to report a scheduler as broken
 * when it merely could not reach the user manager. Status reports it; uninstall (Batch 2 M3) polls it.
 *
 * Every command here is READ-ONLY (`print`, `list`, `is-active`, `is-enabled`, `schtasks /Query`) and
 * goes through the injected exec, each with the caller's `timeoutMs`, one after another.
 *   • macOS — `print gui/<uid>/…`, `print user/<uid>/…`, `list …`, evaluated in this order:
 *       1. present if any exits 0;
 *       2. unknown(no-gui-session) if `print gui` says "Could not find domain" — a missing desktop
 *          domain (an SSH session) is never read as gone;
 *       3. gone if each `print` reports service-not-found (exit 113, or "Could not find service"; the
 *          domain text never counts, whatever the code) — `print user` may instead report its domain
 *          missing — and `list` reports service-not-found too. Any other code from `list` is no
 *          answer: a killed command can surface as an ordinary code;
 *       4. unknown otherwise: `timeout` if a command returned -1, `spawn` if -2, else `unexpected`.
 *   • Linux — `is-active <timer> <service>` and `is-enabled <timer>`, read by their WORDS, never by exit
 *     code alone. A manager error on either comes first (unknown(no-user-manager)): "Failed to connect
 *     to" followed on the same line by "bus" (systemd ≤ 256's "…to bus:" and ≥ 257's "…to user scope
 *     bus via local transport:"), or any mention of XDG_RUNTIME_DIR. Then present if either unit is
 *     running or the timer is enabled; gone if both units answered not running and the timer not
 *     enabled; unknown otherwise, with macOS step 4's reasons.
 *   • Windows (status only, spec 3.1.10) — `schtasks /Query`: exit 0 present, a real non-zero code gone,
 *     -1 or -2 unknown.
 *   • Anything else — unknown(unexpected), and nothing runs.
 */
export async function probeRegistration(deps: ScheduleDeps, opts: { timeoutMs: number }): Promise<RegistrationCheck> {
  const d = resolveDeps(deps);
  const kind = kindFor(d.platform);
  if (kind === "launchd") return probeLaunchd(d, opts.timeoutMs);
  if (kind === "systemd") return probeSystemd(d, opts.timeoutMs);
  if (kind === "schtasks") {
    const r = await probeExec(d, ["schtasks", "/Query", "/TN", WINDOWS_TASK_NAME], opts.timeoutMs);
    if (r.code === 0) return { state: "present" };
    return noAnswer(r) ? unknownReason([r]) : { state: "gone" };
  }
  return { state: "unknown", reason: "unexpected" };
}

async function probeLaunchd(d: Resolved, timeoutMs: number): Promise<RegistrationCheck> {
  const gui = await probeExec(d, ["launchctl", "print", `gui/${d.uid}/${SCHEDULE_LABEL}`], timeoutMs);
  const user = await probeExec(d, ["launchctl", "print", `user/${d.uid}/${SCHEDULE_LABEL}`], timeoutMs);
  const list = await probeExec(d, ["launchctl", "list", SCHEDULE_LABEL], timeoutMs);
  const all = [gui, user, list];
  if (all.some((r) => r.code === 0)) return { state: "present" };
  const serviceMissing = (r: ExecResult) =>
    !noAnswer(r) && !r.err.includes("Could not find domain")
    && (r.code === LAUNCHD_NOT_FOUND || r.err.includes("Could not find service"));
  if (launchdDomainMissing(gui)) return { state: "unknown", reason: "no-gui-session" };
  if (serviceMissing(gui) && (serviceMissing(user) || launchdDomainMissing(user)) && serviceMissing(list)) return { state: "gone" };
  return unknownReason(all);
}

const SYSTEMD_RUNNING = new Set(["active", "reloading", "refreshing", "activating", "deactivating"]);
const SYSTEMD_NOT_RUNNING = new Set(["inactive", "failed", "unknown"]);
const SYSTEMD_ENABLED = new Set(["enabled", "enabled-runtime", "alias", "indirect", "generated", "transient"]);
const SYSTEMD_NOT_ENABLED = new Set(["static", "disabled", "linked", "linked-runtime", "masked", "masked-runtime", "bad", "not-found"]);

async function probeSystemd(d: Resolved, timeoutMs: number): Promise<RegistrationCheck> {
  const active = await probeExec(d, ["systemctl", "--user", "is-active", SYSTEMD_TIMER_NAME, SYSTEMD_SERVICE_NAME], timeoutMs);
  const enabled = await probeExec(d, ["systemctl", "--user", "is-enabled", SYSTEMD_TIMER_NAME], timeoutMs);
  if (systemdManagerDown(active) || systemdManagerDown(enabled)) return { state: "unknown", reason: "no-user-manager" };

  // One word per unit, timer first. An unlisted word, or a missing line, is no answer for that unit.
  const lines = noAnswer(active) ? [] : active.out.split("\n").map((l) => l.trim());
  const running = (w: string | undefined) => (w === undefined ? undefined : SYSTEMD_RUNNING.has(w) ? true : SYSTEMD_NOT_RUNNING.has(w) ? false : undefined);
  const timerRunning = running(lines[0]), serviceRunning = running(lines[1]);

  let timerEnabled: boolean | undefined;
  if (!noAnswer(enabled)) {
    const w = enabled.out.split("\n")[0]!.trim();
    if (SYSTEMD_ENABLED.has(w)) timerEnabled = true;
    else if (SYSTEMD_NOT_ENABLED.has(w)) timerEnabled = false;
    // Older systemd reports a missing unit file this way rather than with the word `not-found`.
    else if (enabled.out.trim() === "" && enabled.err.includes(`Failed to get unit file state for ${SYSTEMD_TIMER_NAME}: No such file or directory`)) timerEnabled = false;
  }

  if (timerRunning === true || serviceRunning === true || timerEnabled === true) return { state: "present" };
  if (timerRunning === false && serviceRunning === false && timerEnabled === false) return { state: "gone" };
  return unknownReason([active, enabled]);
}

/** Exported so `status.ts` resolves the same defaults this module does, rather than keeping a second
 *  copy of "exec defaults to proc.run, platform defaults to process.platform, …" that could drift. */
export { resolveDeps as resolveScheduleDeps };
