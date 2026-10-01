// src/schedule/install.ts — Slice 4 T3/T8/T9: the EFFECTFUL half of scheduling.
//
// ⚠ EVERY EFFECT IN THIS FILE LEAVES THROUGH ONE OF TWO SEAMS, and that is enforced by
// `test/isolation.meta.test.ts`'s scanner 4, not by convention:
//   1. the INJECTED `exec` (default `src/proc.ts` run()) — every `launchctl`, `systemctl`,
//      `schtasks`, `loginctl`, `xattr`, `codesign`, `security` and `openssl` invocation;
//   2. `DBA_TEST_UNIT_DIR` — every unit-file write.
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
import { copyFile, mkdir, mkdtemp, rm, chmod, unlink, rename } from "node:fs/promises";
import { join, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import pkg from "../../package.json";
import { run } from "../proc";
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

/** The default, and the ONLY place this module reaches `proc.run`. Scanner 4 asserts that the
 *  identifier appears exactly once and only here — anything else would be a path around the seam. */
const defaultExec: Exec = async (cmd, opts) => {
  const r = await run(cmd, { timeoutMs: opts?.timeoutMs ?? SCHEDULE_EXEC_TIMEOUT_MS });
  return { code: r.code, out: r.out, err: r.err };
};

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
};

type Resolved = Required<Pick<ScheduleDeps, "exec" | "platform" | "env" | "home" | "execPath" | "now" | "say" | "warn">>;

function resolveDeps(d: ScheduleDeps): Resolved {
  return {
    exec: d.exec ?? defaultExec,
    platform: d.platform ?? process.platform,
    env: d.env ?? process.env,
    home: d.home ?? homedir(),
    execPath: d.execPath ?? process.execPath,
    now: d.now ?? (() => new Date()),
    say: d.say ?? ((l) => console.log(l)),
    warn: d.warn ?? ((l) => console.error(l)),
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

/** Total: an absent, unreadable or malformed record reads as "nobody owns this". A corrupt record
 *  must not be able to block an install forever — the user would have no way out but manual file
 *  surgery, and the file is a coordination hint, not an authority. */
export async function readScheduleRecord(path: string = schedulePath()): Promise<ScheduleRecord | null> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return null;
    const o = JSON.parse(await f.text()) as Partial<ScheduleRecord>;
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

/** Mirrors `scripts/install.sh:22-24`: LibreSSL's `req` lacks `-addext`, which the identity needs, so
 *  a Homebrew openssl is preferred when present. Resolved through the exec seam rather than by
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
    const signed = await d.exec(["codesign", "--force", "--sign", identity, "--identifier", SCHEDULE_LABEL, copyPath]);
    if (signed.code === 0) {
      d.say(`Signed the managed copy with '${identity}' — the macOS folder-access grant will persist across re-installs.`);
      return "stable";
    }
    d.warn(`WARN: codesign with '${identity}' failed — falling back to an ad-hoc signature; the grant may not persist.`);
  } else {
    d.warn(`WARN: could not create/find a stable signing identity '${identity}' — falling back to an ad-hoc signature.`);
    d.warn(`      macOS may re-prompt for folder access after each re-install. Install a real 'openssl' (e.g. \`brew install openssl\`) and re-run.`);
  }
  const adhoc = await d.exec(["codesign", "-s", "-", "-f", copyPath]);
  return adhoc.code === 0 ? "adhoc" : "unsigned";
}

// ── linger (linux) ──────────────────────────────────────────────────────────────────────────────

export type LingerState = "enabled" | "disabled" | "unknown" | "not-applicable";

/** `loginctl show-user <user> --property=Linger` → `Linger=yes|no`. Anything else is "unknown"
 *  rather than a guess: a headless box where this cannot be read is exactly where a wrong answer
 *  costs every future briefing. */
export async function lingerState(d: Resolved): Promise<LingerState> {
  if (d.platform !== "linux") return "not-applicable";
  const user = d.env.USER ?? d.env.LOGNAME;
  if (!user) return "unknown";
  const r = await d.exec(["loginctl", "show-user", user, "--property=Linger"]).catch(() => ({ code: 1, out: "", err: "" }));
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

export async function installSchedule(opts: InstallOpts = {}, deps: ScheduleDeps = {}): Promise<number> {
  const d = resolveDeps(deps);
  const kind = kindFor(d.platform);
  if (!kind) { d.warn(`schedule install: no scheduler is supported on ${d.platform}.`); return EXIT_ERROR; }
  const invoker: ScheduleOwner = opts.invoker ?? "cli";

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

  try {
    const binPath = managedBinPath(d.platform, d.env, d.home);
    const source = d.execPath;   // ⚠ execPath, NOT argv[0] — see the header.
    // Copying a file onto itself truncates it on some platforms; a re-run pointed at the managed copy
    // is the ordinary refresh case (`<state>/daily-briefing schedule install`), not an error.
    if (source !== binPath) {
      await mkdir(dirname(binPath), { recursive: true });
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
    const written = await writeUnits(d, kind, dir, unitOpts);
    for (const p of written) d.say(`Wrote ${p}`);

    const unitPath = primaryUnitPath(d.platform, d.env, d.home)!;
    const registered = await register(d, kind, unitPath, opts);
    if (registered === "failed") return EXIT_ERROR;
    if (registered === "unconfirmed") {
      // ⚠ EXIT 2 AND NO RECORD — the contract's "the caller refused a required confirmation". The XML
      // is the deliverable without the flag and it landed; what did NOT happen is registration, and a
      // `schedule.json` written here would claim ownership of a trigger that does not exist: `status`
      // would report an installed schedule, and `uninstall` would think it had something to remove.
      d.say("Nothing was registered, so no schedule record was written — exiting 2 (a required confirmation was not given). The task XML above is written and ready; pass --confirm-experimental to have the command run for you.");
      return EXIT_FOREIGN;
    }

    await writeScheduleRecord({
      owner: invoker, invoker, kind, unitPath, binPath,
      installedAt: d.now().toISOString(), engineVersion: pkg.version,
    });

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
 *  path — so any future field that could smuggle a mount path in is covered by construction. */
async function writeUnits(d: Resolved, kind: ScheduleKind, dir: string, o: ScheduleOpts): Promise<string[]> {
  if (kind === "launchd") {
    const xml = launchdPlist(o);
    assertNoMountPath(xml, "the launchd plist");
    const p = join(dir, `${SCHEDULE_LABEL}.plist`);
    await writeFileAtomic(p, xml);
    return [p];
  }
  if (kind === "systemd") {
    const { service, timer } = systemdUnits(o);
    assertNoMountPath(service, "the systemd service unit");
    assertNoMountPath(timer, "the systemd timer unit");
    const sp = join(dir, SYSTEMD_SERVICE_NAME), tp = join(dir, SYSTEMD_TIMER_NAME);
    await writeFileAtomic(sp, service);
    await writeFileAtomic(tp, timer);
    return [sp, tp];
  }
  const xml = windowsTaskXml(o);
  assertNoMountPath(xml, "the Windows task XML");
  const p = join(dir, `${WINDOWS_TASK_NAME}.xml`);
  // ⚠ BYTES, not the string: `schtasks /XML` rejects UTF-8. See units.ts's encoding contract.
  await writeFileAtomic(p, windowsTaskXmlBytes(xml));
  return [p];
}

/** ⚠ THREE OUTCOMES, NOT A BOOLEAN. "unconfirmed" is the Windows-without-`--confirm-experimental`
 *  path: the XML landed and the command was printed, but NOTHING was registered — which is neither a
 *  success (a record claiming ownership would make `status` lie) nor an error (the caller simply did
 *  not give a confirmation the gate requires). It maps to the contract's exit 2. */
type RegisterOutcome = "registered" | "unconfirmed" | "failed";

async function register(d: Resolved, kind: ScheduleKind, unitPath: string, opts: InstallOpts): Promise<RegisterOutcome> {
  if (kind === "launchd") {
    // unload-then-load is install.sh's own verb pair, kept for cross-version parity. The unload is
    // expected to fail on a first install; that is not an error.
    await d.exec(["launchctl", "unload", unitPath]).catch(() => ({ code: 1, out: "", err: "" }));
    const r = await d.exec(["launchctl", "load", unitPath]);
    if (r.code !== 0) { d.warn(`launchctl load failed (${r.code}): ${stripControl(r.err || r.out)}`); return "failed"; }
    return "registered";
  }
  if (kind === "systemd") {
    const reload = await d.exec(["systemctl", "--user", "daemon-reload"]);
    if (reload.code !== 0) { d.warn(`systemctl --user daemon-reload failed (${reload.code}): ${stripControl(reload.err || reload.out)}`); return "failed"; }
    const en = await d.exec(["systemctl", "--user", "enable", "--now", SYSTEMD_TIMER_NAME]);
    if (en.code !== 0) { d.warn(`systemctl --user enable --now ${SYSTEMD_TIMER_NAME} failed (${en.code}): ${stripControl(en.err || en.out)}`); return "failed"; }
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

// ── uninstall ───────────────────────────────────────────────────────────────────────────────────

export async function uninstallSchedule(
  opts: { invoker?: ScheduleOwner; takeOver?: boolean } = {}, deps: ScheduleDeps = {},
): Promise<number> {
  const d = resolveDeps(deps);
  const kind = kindFor(d.platform);
  if (!kind) { d.warn(`schedule uninstall: no scheduler is supported on ${d.platform}.`); return EXIT_ERROR; }
  const invoker: ScheduleOwner = opts.invoker ?? "cli";
  const record = await readScheduleRecord();
  if (record && record.owner !== invoker && !opts.takeOver) {
    d.warn(`schedule uninstall: the trigger is owned by "${record.owner}", not "${invoker}" — removing only what we own. Re-run with --take-over to remove it anyway.`);
    return EXIT_FOREIGN;
  }
  try {
    const paths = unitPaths(d.platform, d.env, d.home);
    const present: string[] = [];
    for (const p of paths) if (await Bun.file(p).exists()) present.push(p);
    if (present.length === 0 && !record) { d.say("Nothing installed by daily-briefing was found."); return EXIT_NONE; }

    // ⚠ EVERY path here is built from the EXACT label — see `ownsLabel`. Nothing globs, nothing
    // prefix-matches, so a sibling agent is unreachable from this code by construction.
    if (kind === "launchd") {
      for (const p of present) await d.exec(["launchctl", "unload", p]).catch(() => ({ code: 1, out: "", err: "" }));
    } else if (kind === "systemd") {
      await d.exec(["systemctl", "--user", "disable", "--now", SYSTEMD_TIMER_NAME]).catch(() => ({ code: 1, out: "", err: "" }));
    } else {
      await d.exec(["schtasks", "/Delete", "/TN", WINDOWS_TASK_NAME, "/F"]).catch(() => ({ code: 1, out: "", err: "" }));
    }
    for (const p of present) await unlink(p).catch(() => {});
    if (kind === "systemd") await d.exec(["systemctl", "--user", "daemon-reload"]).catch(() => ({ code: 1, out: "", err: "" }));
    await unlink(schedulePath()).catch(() => {});
    // ⚠ THE MANAGED COPY IS DELIBERATELY LEFT IN PLACE: it may be the binary currently executing, and
    // a user who removes the SCHEDULE has not asked to remove the TOOL. `scripts/uninstall.sh` is what
    // removes it, and says so.
    d.say(`Removed the trigger${present.length ? ` (${present.join(", ")})` : ""}. The engine binary itself was left in place — \`scripts/uninstall.sh\` removes that.`);
    return EXIT_OK;
  } catch (e) {
    d.warn(`schedule uninstall failed: ${stripControl(e instanceof Error ? e.message : String(e))}`);
    return EXIT_ERROR;
  }
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
    const r = await d.exec(["systemctl", "--user", "start", SYSTEMD_SERVICE_NAME]).catch(() => ({ code: 1, out: "", err: "" }));
    return r.code === 0;
  }
  return false;   // windows: gated, and there is no evidence to gather anyway.
}

// ── registration-state probe (shared with status) ───────────────────────────────────────────────

/** Is the trigger actually registered with the OS right now? EXACT label on every platform. */
export async function isRegistered(d: ScheduleDeps = {}): Promise<boolean | null> {
  const r = resolveDeps(d);
  const kind = kindFor(r.platform);
  if (kind === "launchd") {
    const out = await r.exec(["launchctl", "list", SCHEDULE_LABEL]).catch(() => ({ code: 1, out: "", err: "" }));
    return out.code === 0;
  }
  if (kind === "systemd") {
    const out = await r.exec(["systemctl", "--user", "is-enabled", SYSTEMD_TIMER_NAME]).catch(() => ({ code: 1, out: "", err: "" }));
    return out.code === 0;
  }
  if (kind === "schtasks") {
    const out = await r.exec(["schtasks", "/Query", "/TN", WINDOWS_TASK_NAME]).catch(() => ({ code: 1, out: "", err: "" }));
    return out.code === 0;
  }
  return null;
}

/** Exported so `status.ts` resolves the same defaults this module does, rather than keeping a second
 *  copy of "exec defaults to proc.run, platform defaults to process.platform, …" that could drift. */
export { resolveDeps as resolveScheduleDeps };
