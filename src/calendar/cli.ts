// src/calendar/cli.ts — `daily-briefing calendar …` (v0.3.0 plan M5; spec r4 §4.2, §8 "CLI").
//
//   calendar connect mac                                   ATTENDED: install/update the Calendar Reader copy, ask for access
//   calendar add-link --id X [--name N] [--owner EMAIL] [--confirm-owner]
//                                                          the URL on stdin → the managed link file + the config entry
//   calendar remove-link --id X                            the config entry and the managed file
//   calendar list | test | status                          reports
//   calendar details --json [--skip-mac] [--skip-commands] INTERNAL: the desktop app's live details read (./details.ts);
//                                                          not in USAGE or the help, `--json` only
// each with `--json`. Loaded by `dispatch` with a dynamic import, so no other command pays for it.
//
// ⚠ THE URL NEVER APPEARS IN ANY OUTPUT. It is read from stdin (never argv: argv lands in shell history and the
// process table), held in one local, written to the managed file, and otherwise only handed to `googleUrlPathOwner`,
// which returns an address or nothing. Every message below is fixed text plus ids, codes and addresses; no message
// interpolates the URL, a part of it, or an error object (Bun's fetch error carries the request URL).
//
// ⚠ THE MANAGED FILE IS WRITTEN WITH THE RULES THE APP'S RUST WRITER ENFORCES (spec §2, §8): the id grammar and the
// reserved `macos`; at most 10 links; folder `<state>/calendar/links` 0700 and the user's own (a symlinked or foreign
// folder is refused, a too-open one is tightened); the file 0600, created O_EXCL|O_NOFOLLOW under a temp name and
// renamed into place (atomic). Refused on Windows, where the reader refuses the file anyway (no O_NOFOLLOW, no POSIX
// modes): there the link takes `urlEnv` or `urlCommand`. The reader's checks are `./link-url.ts`'s.
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, rename, rm, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { configPath } from "../config";
import { supportDir } from "../marker";
import { stripControl } from "../render";
import {
  CALENDAR_CONFIG_WARNINGS, CALENDAR_LINK_ID_RE, CALENDAR_MAX_LINKS, CALENDAR_RESERVED_LINK_IDS, calendarEmail,
  resolveCalendar, type ResolvedCalendar, type ResolvedCalendarLink,
} from "./config";
import { calendarLinkFilePath, calendarLinksDir, resolveLinkUrl, LINK_URL_MAX_BYTES, type LinkUrlOpts } from "./link-url";
import { calendarUrlProblem, type CalendarFetch } from "./link-fetch";
import { googleUrlPathOwner } from "./link-parse";
import { scrubCalendarLinks } from "./link-scrub";
import { readCalendar } from "./pipeline";
import { detailsVerb } from "./details";
import { calendarStatus, shownLinkName } from "./status";
import { calendarStateDir } from "./health";
import { CALENDAR_STATUS_TEXT } from "./render-contract";
import { homedir } from "node:os";
import { defaultExec, resolveIdentity, type Exec } from "../schedule/install";
import { installReaderCopy } from "./reader-install";
import { listMacCalendars, requestMacAccess, READER_REQUEST_ABANDON_MS, type MacSourceDeps, type ReaderExec } from "./mac-source";

/** `connect mac`'s whole budget: under the app's 150 s kill (`CALENDAR_CONNECT_MAC_TIMEOUT`, gui/src-tauri/src/engine.rs)
 *  with 5 s for the engine's start and its answer. */
export const CONNECT_MAC_BUDGET_MS = 145_000;
import { macOsSupported } from "./reader";
import { localDateStr } from "../marker";
import type { CalendarLinkInfo, CalendarListJson, CalendarReadStatus, CalendarTestJson } from "./types";

export type CalendarCliDeps = {
  /** Defaults to `supportDir()`. */
  stateDir?: string;
  /** Defaults to `configPath()`. */
  configFile?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exec?: LinkUrlOpts["exec"];
  fetch?: CalendarFetch;
  /** TEST seam: the parse child's argv for `calendar test`. */
  parseCommand?: string[];
  /** One line of stdin per call, `null` at end of input. Defaults to a reader over `Bun.stdin`. */
  readLine?: () => Promise<string | null>;
  /** Is a person at the keyboard? Defaults to `process.stdin.isTTY`. Only then does `add-link` ask a question. */
  isTTY?: boolean;
  out?: (s: string) => void;
  err?: (s: string) => void;
  now?: () => number;
  /** The Mac reader's `mkfifo` / `open` runner (`./mac-source.ts`). Defaults to `proc.run`. */
  macExec?: ReaderExec;
  /** The exec `connect mac` signs the reader copy through (`xattr`, `security`, `codesign`). Defaults to the
   *  schedule installer's `defaultExec`. */
  signExec?: Exec;
  /** TEST seams: `os.release()`, the home folder (the login keychain's), the shipped reader's location. */
  osRelease?: string;
  home?: string;
  findShippedReader?: () => Promise<string | null>;
  /** TEST seam: the monotonic clock `connect mac`'s deadline is measured on. */
  clock?: () => number;
  /** TEST seam: `details`' STDIN, read under its byte bound (./details.ts). */
  readStdin?: (maxBytes: number) => Promise<string>;
  /** TEST seam over `details`' LIVE_READ_REFRESH_WAIT (present, even as `undefined`, means "use this"). */
  liveRefreshWait?: number | undefined;
};

/** `details` is internal (the desktop app's live read, ./details.ts): a verb, but not in USAGE. */
const VERBS = new Set(["connect", "add-link", "remove-link", "list", "test", "status", "details"]);
const USAGE = "usage: daily-briefing calendar connect mac | add-link --id X [--name N] [--owner EMAIL] [--confirm-owner] | remove-link --id X | list | test | status  (each with --json)";

/** A line reader over stdin. The first call starts the stream; a line longer than 64 KiB is returned cut (the
 *  caller refuses anything over LINK_URL_MAX_BYTES anyway). */
function stdinLines(): () => Promise<string | null> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const dec = new TextDecoder();
  let buf = "", done = false;
  return async () => {
    reader ??= Bun.stdin.stream().getReader();
    for (;;) {
      const i = buf.indexOf("\n");
      if (i >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); return l.replace(/\r$/, ""); }
      if (buf.length > 65_536) { const l = buf; buf = ""; return l; }
      if (done) { if (buf !== "") { const l = buf; buf = ""; return l; } return null; }
      const r = await reader.read();
      if (r.done) done = true; else buf += dec.decode(r.value, { stream: true });
    }
  };
}

type Flags = { values: Map<string, string>; bools: Set<string>; error?: string };
function parseFlags(args: string[], valued: readonly string[], bools: readonly string[]): Flags {
  const out: Flags = { values: new Map(), bools: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (valued.includes(a)) {
      const v = args[i + 1];
      if (v === undefined || v.startsWith("--")) return { ...out, error: `${a} needs a value` };
      if (out.values.has(a)) return { ...out, error: `${a} given twice` };
      out.values.set(a, v); i++;
    } else if (bools.includes(a)) {
      out.bools.add(a);
    } else {
      // Only the flag's NAME is echoed — never the part after `=` (`--url=https://…/private-…/basic.ics` would put the
      // secret in stderr and the --json error) — and that name still passes the link scrub (`--https://…`).
      return { ...out, error: `unexpected argument ${stripControl(a.startsWith("-") ? scrubCalendarLinks(a.split("=", 1)[0]!) : "(a value)")}` };
    }
  }
  return out;
}

// ── the config file ────────────────────────────────────────────────────────────────────────────────

type RawConfig = Record<string, unknown>;
type ConfigRead = { ok: true; raw: RawConfig | undefined } | { ok: false; why: string };

/** The raw config object, `undefined` when there is no file. Read raw — not through `loadConfig` — so a calendar
 *  command answers about the calendar even when an unrelated key is invalid, and so `add-link` can write the file
 *  back with every other key exactly as it was. */
async function readRawConfig(path: string): Promise<ConfigRead> {
  const f = Bun.file(path);
  if (!(await f.exists().catch(() => false))) return { ok: true, raw: undefined };
  try {
    const raw = JSON.parse(await f.text()) as unknown;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return { ok: false, why: "the config file is not a JSON object" };
    return { ok: true, raw: raw as RawConfig };
  } catch {
    return { ok: false, why: "the config file could not be read as JSON" };
  }
}

/** Write the config back atomically (temp file + rename), keeping the file's mode. */
async function writeRawConfig(path: string, raw: RawConfig): Promise<void> {
  const mode = (await stat(path).catch(() => undefined))?.mode ?? 0o600;
  const tmp = join(dirname(path), `.config.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await open(tmp, "wx", mode & 0o777);
    try { await fh.writeFile(`${JSON.stringify(raw, null, 2)}\n`); await fh.sync().catch(() => undefined); }
    finally { await fh.close().catch(() => undefined); }
    await rename(tmp, path);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}

/** Warnings that leave the block usable: everything else means `resolveCalendar` switched it off as malformed. */
const NON_FATAL: readonly string[] = [CALENDAR_CONFIG_WARNINGS.literalUrl, CALENDAR_CONFIG_WARNINGS.macosNotHere];
const isMalformed = (r: ResolvedCalendar): boolean => r.warnings.some((w) => !NON_FATAL.includes(w));

// ── the managed link file ──────────────────────────────────────────────────────────────────────────

export type ManagedWriteFailure = "unsupported-platform" | "dir-symlink" | "dir-not-directory" | "dir-owner" | "write-failed";

/** Ensure a folder is a real directory of ours with mode 0700 (creating it if absent). */
async function ownDir(path: string): Promise<ManagedWriteFailure | undefined> {
  try { await mkdir(path, { mode: 0o700 }); } catch (e) { if ((e as { code?: string }).code !== "EEXIST") return "write-failed"; }
  const st = await lstat(path).catch(() => undefined);
  if (st === undefined) return "write-failed";
  if (st.isSymbolicLink()) return "dir-symlink";
  if (!st.isDirectory()) return "dir-not-directory";
  const uid = process.getuid?.();
  if (uid !== undefined && st.uid !== uid) return "dir-owner";
  if ((st.mode & 0o077) !== 0) await chmod(path, 0o700).catch(() => undefined);
  return undefined;
}

/** Write `<state>/calendar/links/<id>.url` (see the header for the rules). Never throws; never echoes the URL. */
export async function writeManagedLinkFile(
  stateDir: string, id: string, url: string, platform: NodeJS.Platform = process.platform,
): Promise<"ok" | ManagedWriteFailure> {
  if (platform === "win32" || constants.O_NOFOLLOW === undefined) return "unsupported-platform";
  if (!CALENDAR_LINK_ID_RE.test(id) || CALENDAR_RESERVED_LINK_IDS.includes(id)) return "write-failed";
  try {
    await mkdir(stateDir, { recursive: true, mode: 0o700 });
    for (const dir of [calendarStateDir(stateDir), calendarLinksDir(stateDir)]) {
      const bad = await ownDir(dir);
      if (bad) return bad;
    }
  } catch { return "write-failed"; }
  const final = calendarLinkFilePath(stateDir, id);
  const tmp = join(calendarLinksDir(stateDir), `.${id}.${randomBytes(6).toString("hex")}.tmp`);
  try {
    const fh = await open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await fh.writeFile(`${url}\n`); await fh.chmod(0o600); await fh.sync().catch(() => undefined); }
    finally { await fh.close().catch(() => undefined); }
    await rename(tmp, final);
    return "ok";
  } catch {
    await rm(tmp, { force: true }).catch(() => undefined);
    return "write-failed";
  }
}

// ── the verbs ──────────────────────────────────────────────────────────────────────────────────────

type Ctx = Required<Pick<CalendarCliDeps, "stateDir" | "configFile" | "platform" | "out" | "err">> & CalendarCliDeps & { json: boolean };

const WRITE_FAILURE_TEXT: Record<ManagedWriteFailure, string> = {
  "unsupported-platform": "the managed link file is not supported on Windows — set the link's \"urlEnv\" or \"urlCommand\" in the config instead",
  "dir-symlink": "the calendar links folder in the state folder is a symbolic link — refusing to write through it",
  "dir-not-directory": "the calendar links folder in the state folder is not a folder",
  "dir-owner": "the calendar links folder in the state folder belongs to another user",
  "write-failed": "the link file could not be written",
};

function fail(c: Ctx, verb: string, msg: string, code = 2): number {
  if (c.json) c.out(JSON.stringify({ schemaVersion: 1, ok: false, error: `${verb}: ${msg}` }));
  c.err(stripControl(`calendar ${verb}: ${msg}`));
  return code;
}

/** The Mac source's deps for this invocation. */
const macDeps = (c: Ctx): MacSourceDeps => ({
  stateDir: c.stateDir, platform: c.platform, ...(c.macExec ? { exec: c.macExec } : {}),
  ...(c.osRelease !== undefined ? { osRelease: c.osRelease } : {}), ...(c.now ? { now: c.now } : {}),
});

/** `calendar connect mac` — ATTENDED ONLY (spec §4.1, plan M10b): install or update the reader copy (copy, strip
 *  quarantine, re-sign with the stable local identity — which may raise a keychain prompt), then run the reader's
 *  `request` mode, which shows the Calendars dialog and waits up to 120 s for the person. On `ok`, a config with no
 *  `calendar.macos` gains `"macos": {}` (editable calendars), as `add-link` adds its link. Exit 0 only on `ok`. */
async function connect(args: string[], c: Ctx): Promise<number> {
  if (args[0] !== "mac" || args.length !== 1) return fail(c, "connect", "expected `calendar connect mac [--json]`");
  const say = (s: string): void => (c.json ? c.err(s) : c.out(s));
  const report = (o: Record<string, unknown> & { status: CalendarReadStatus }, text: string): number => {
    if (c.json) c.out(JSON.stringify({ schemaVersion: 1, ...o }));
    else c.out(stripControl(text));
    return o.status === "ok" ? 0 : 1;
  };
  const statusText = (s: CalendarReadStatus): string => (s === "ok" ? "access granted" : CALENDAR_STATUS_TEXT[s as Exclude<CalendarReadStatus, "ok">]);
  if (c.platform !== "darwin" || !macOsSupported(c.osRelease)) {
    return report({ status: "unsupported-os" }, `Mac Calendar: ${statusText("unsupported-os")}`);
  }
  const env = (c.env ?? process.env) as NodeJS.ProcessEnv;
  // ONE DEADLINE for the whole attended flow (M10b checkpoint): the app kills this process at 150 s
  // (`CALENDAR_CONNECT_MAC_TIMEOUT`), so the install's commands and the request share 145 s from here — a slow
  // keychain prompt during signing shortens the time left for the Calendars dialog, never overruns the app.
  const clock = c.clock ?? (() => performance.now());
  const deadline = clock() + CONNECT_MAC_BUDGET_MS;
  // Whole milliseconds: every budget below becomes a spawn timeout (proc.run also rounds, as the chokepoint).
  const left = (): number => Math.max(0, Math.floor(deadline - clock()));
  const baseExec = c.signExec ?? defaultExec(env);
  const signExec: Exec = (cmd, o) => baseExec(cmd, { timeoutMs: Math.max(1, Math.min(o?.timeoutMs ?? 30_000, left() - 1_000)) });
  const installed = await installReaderCopy({
    stateDir: c.stateDir, exec: signExec, home: c.home ?? homedir(), identity: resolveIdentity({}, env),
    say, warn: c.err, ...(c.findShippedReader ? { findShipped: c.findShippedReader } : {}),
  });
  if (installed.status !== "ok") {
    const reason = installed.status === "malformed" ? { reason: installed.reason } : {};
    return report({ status: installed.status, ...reason }, `Mac Calendar: ${statusText(installed.status)}${"reason" in installed ? ` [${installed.reason}]` : ""}`);
  }
  const install = { install: installed.action, ...(installed.signature ? { signature: installed.signature } : {}) };
  if (installed.action === "copied") say(`Installed the calendar reader (${installed.signature ?? "unsigned"} signature). macOS will ask whether "Daily Briefing Calendar Reader" may access your calendars.`);
  // 12 s held back: 2 s for the answer, 10 s for the one status re-check a timed-out request makes.
  const requestMs = Math.min(READER_REQUEST_ABANDON_MS, left() - 12_000);
  // 16 s floor: the helper's `--wait` is at least 10 s and must end ~6 s before the engine gives up.
  if (requestMs < 16_000) return report({ status: "timeout", reason: "connect-deadline", ...install, configUpdated: false }, `Mac Calendar: ${statusText("timeout")} [connect-deadline]`);
  const asked = await requestMacAccess({ ...macDeps(c), abandonMs: requestMs });
  const updated: ConfigUpdate = asked.status === "ok" ? await enableMacSource(c) : { written: false, calendarOn: false };
  // The text names the reason code and why the config was not changed (W3 VM sitting: a failed first request and a
  // missing config both printed nothing actionable; `--json` already carried the reason).
  const config = updated.written
    ? ` — added to the config (editable calendars)${updated.calendarOn ? "" : "; the calendar itself is off in the config"}`
    : updated.why !== undefined ? ` — ${NOT_ADDED_TEXT[updated.why]}` : "";
  return report(
    { status: asked.status, ...(asked.reason !== undefined ? { reason: asked.reason } : {}), ...install, configUpdated: updated.written },
    `Mac Calendar: ${statusText(asked.status)}${asked.status !== "ok" && asked.reason !== undefined ? ` [${asked.reason}]` : ""}${config}.`,
  );
}

type NotAdded = "no-config" | "unreadable" | "invalid-block" | "already" | "write-failed";
type ConfigUpdate = { written: boolean; calendarOn: boolean; why?: NotAdded };
const NOT_ADDED_TEXT: Record<NotAdded, string> = {
  "no-config": "not added to the config: there is no config yet. Run `daily-briefing init`, then `daily-briefing calendar connect mac` again",
  "unreadable": "not added to the config: it could not be read as a JSON object — fix it first",
  "invalid-block": "not added to the config: its calendar block is invalid — fix it first",
  "already": "already in the config",
  "write-failed": "not added to the config: it could not be written",
};

/** Add `"macos": {}` to a config whose calendar block has none (creating `{ enabled: true, macos: {} }` when there
 *  is no block; a `"macos": null` counts as none). Never throws; `written: false` when nothing was written, with
 *  `why` when the reason is known (no config, an unreadable one, an invalid block — checked BEFORE "already", so a
 *  broken `macos` value is reported as broken — already present, or the write failed). `calendarOn` says whether
 *  the block it wrote is enabled — a block with `enabled: false` stays off. */
async function enableMacSource(c: Ctx): Promise<ConfigUpdate> {
  const no = (why?: NotAdded): ConfigUpdate => ({ written: false, calendarOn: false, ...(why ? { why } : {}) });
  try {
    const cfg = await readRawConfig(c.configFile);
    if (!cfg.ok) return no("unreadable");
    if (cfg.raw === undefined) return no("no-config");
    const block = cfg.raw.calendar;
    if (block !== undefined && block !== null) {
      if (typeof block !== "object" || Array.isArray(block)) return no("invalid-block");
      if (isMalformed(resolveCalendar(block, { platform: c.platform }))) return no("invalid-block");
      const macos = (block as Record<string, unknown>).macos;
      if (macos !== undefined && macos !== null) return no("already");
    }
    const next = block === undefined || block === null ? { enabled: true, macos: {} } : { ...(block as Record<string, unknown>), macos: {} };
    try {
      await writeRawConfig(c.configFile, { ...cfg.raw, calendar: next });
    } catch {
      return no("write-failed");
    }
    return { written: true, calendarOn: next.enabled === true };
  } catch {
    return no();
  }
}

/** The URL's path owner for display/confirmation, `webcal://` read as `https://`. */
const pathOwnerOf = (url: string): string | undefined => googleUrlPathOwner(url.replace(/^webcal:\/\//i, "https://"));

async function addLink(args: string[], c: Ctx): Promise<number> {
  const f = parseFlags(args, ["--id", "--name", "--owner"], ["--confirm-owner"]);
  if (f.error) return fail(c, "add-link", f.error);
  if (c.platform === "win32") return fail(c, "add-link", WRITE_FAILURE_TEXT["unsupported-platform"]);
  const id = f.values.get("--id");
  if (id === undefined) return fail(c, "add-link", "--id is required");
  if (!CALENDAR_LINK_ID_RE.test(id) || CALENDAR_RESERVED_LINK_IDS.includes(id)) return fail(c, "add-link", CALENDAR_CONFIG_WARNINGS.linkId.replace(/ — calendar off$/, "").replace(/^config: /, ""));
  const nameRaw = f.values.get("--name");
  if (nameRaw !== undefined && (nameRaw.trim() === "" || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(nameRaw) || nameRaw.includes("://"))) {
    return fail(c, "add-link", "--name must be non-empty text on one line, and not a web address");
  }
  const ownerRaw = f.values.get("--owner");
  const owner = ownerRaw === undefined ? undefined : calendarEmail(ownerRaw);
  if (ownerRaw !== undefined && owner === undefined) return fail(c, "add-link", "--owner must be an email address");

  const cfg = await readRawConfig(c.configFile);
  if (!cfg.ok) return fail(c, "add-link", `${cfg.why} — fix it first`);
  if (cfg.raw === undefined) return fail(c, "add-link", "there is no config yet — run `daily-briefing init` first");
  const block = cfg.raw.calendar;
  if (block !== undefined && block !== null && isMalformed(resolveCalendar(block, { platform: c.platform }))) {
    return fail(c, "add-link", "the \"calendar\" block in the config is malformed — fix it first (`daily-briefing calendar status` shows why)");
  }
  const blockObj = (block ?? {}) as Record<string, unknown>;
  const links = Array.isArray(blockObj.links) ? [...(blockObj.links as Record<string, unknown>[])] : [];
  const at = links.findIndex((l) => typeof l === "object" && l !== null && l.id === id);
  const existing = at >= 0 ? links[at]! : undefined;
  if (existing && (existing.urlEnv !== undefined || existing.urlCommand !== undefined)) {
    return fail(c, "add-link", `link "${id}" takes its address from urlEnv or urlCommand — remove it first (\`calendar remove-link --id ${id}\`)`);
  }
  if (!existing && links.length >= CALENDAR_MAX_LINKS) return fail(c, "add-link", `at most ${CALENDAR_MAX_LINKS} calendar links`);

  const readLine = c.readLine ?? stdinLines();
  const isTTY = c.isTTY ?? Boolean(process.stdin.isTTY);
  if (isTTY && !c.json) c.err("Paste the calendar's private address and press Enter (it is stored in the engine's state folder, never in the config):");
  const url = ((await readLine()) ?? "").trim();
  if (url === "") return fail(c, "add-link", "no address was given on stdin");
  if (Buffer.byteLength(url, "utf8") > LINK_URL_MAX_BYTES) return fail(c, "add-link", "the address is too long to be a calendar link");
  const problem = calendarUrlProblem(url);
  if (problem !== undefined) return fail(c, "add-link", `the address is not a private https calendar link (${problem}) — it was not stored`);

  const urlPathOwner = pathOwnerOf(url);
  const keepOwner = owner ?? (typeof existing?.owner === "string" ? existing.owner : undefined);
  // Final harden r2: with a configured owner that DIFFERS from the URL path's address, an unconfirmed path address
  // recognises nothing at all (fix-round 1, `./link-parse.ts` `linkIdentity`) — so the "accepts and declines" line
  // below is printed only when no differing owner is set.
  const differingOwner = keepOwner !== undefined && urlPathOwner !== undefined && keepOwner.toLowerCase() !== urlPathOwner.toLowerCase();
  let confirmed = false;
  if (urlPathOwner !== undefined) {
    if (!c.json) c.err(`This link's address names ${urlPathOwner} as the calendar's owner.`);
    if (f.bools.has("--confirm-owner")) confirmed = true;
    else if (isTTY && !c.json) {
      c.err(`Is ${urlPathOwner} your own address? Only then can it mark meetings you organise. [y/N]`);
      confirmed = /^\s*y(es)?\s*$/i.test((await readLine()) ?? "");
    }
    if (!confirmed && !c.json) {
      c.err(differingOwner
        ? "Not confirmed: that address is not treated as yours (your configured owner address is). Re-run with --confirm-owner to confirm it."
        : "Not confirmed: that address will only recognise your accepts and declines. Re-run with --confirm-owner to confirm it.");
    }
  } else if (f.bools.has("--confirm-owner") && !c.json) {
    c.err("--confirm-owner ignored: this link's address names no owner.");
  }

  const name = nameRaw?.trim() ?? (typeof existing?.name === "string" ? existing.name : undefined);
  // A replaced link never inherits a confirmation (spec §4.2): `confirmedOwner` is written only when confirmed NOW.
  const entry: Record<string, unknown> = {
    id, ...(name !== undefined ? { name } : {}), ...(keepOwner !== undefined ? { owner: keepOwner } : {}),
    ...(confirmed && urlPathOwner !== undefined ? { confirmedOwner: urlPathOwner } : {}),
  };
  if (existing) links[at] = entry; else links.push(entry);
  const nextBlock = block === undefined || block === null ? { enabled: true, links } : { ...blockObj, links };
  const check = resolveCalendar(nextBlock, { platform: c.platform });
  // Formed and checked BEFORE the link file is written (integration LOW): a refusal here leaves nothing behind.
  if (isMalformed(check)) return fail(c, "add-link", "the config entry could not be formed — nothing was stored and nothing was changed in the config", 1);
  const wrote = await writeManagedLinkFile(c.stateDir, id, url, c.platform);
  if (wrote !== "ok") return fail(c, "add-link", WRITE_FAILURE_TEXT[wrote], 1);
  try { await writeRawConfig(c.configFile, { ...cfg.raw, calendar: nextBlock }); }
  catch { return fail(c, "add-link", "the config file could not be written (the link file was stored)", 1); }

  const info: CalendarLinkInfo = {
    id, ...(name !== undefined ? { name: shownLinkName(name)! } : {}), ...(keepOwner !== undefined ? { configuredOwner: keepOwner } : {}),
    ...(urlPathOwner !== undefined ? { urlPathOwner } : {}),
    confirmedOwner: confirmed && urlPathOwner !== undefined ? urlPathOwner : null, urlFrom: "file", fileStatus: "ok",
  };
  if (c.json) c.out(JSON.stringify({ schemaVersion: 1, link: info }));
  else c.out(stripControl(`Added calendar link "${id}"${block !== undefined && block !== null && (blockObj.enabled !== true) ? " (calendar is not enabled in the config)" : ""}. Check it with \`daily-briefing calendar test\`.`));
  return 0;
}

async function removeLink(args: string[], c: Ctx): Promise<number> {
  const f = parseFlags(args, ["--id"], []);
  if (f.error) return fail(c, "remove-link", f.error);
  const id = f.values.get("--id");
  if (id === undefined) return fail(c, "remove-link", "--id is required");
  if (!CALENDAR_LINK_ID_RE.test(id) || CALENDAR_RESERVED_LINK_IDS.includes(id)) return fail(c, "remove-link", "not a calendar link id");
  const cfg = await readRawConfig(c.configFile);
  if (!cfg.ok) return fail(c, "remove-link", `${cfg.why} — fix it first`);
  let fromConfig = false;
  const block = cfg.raw?.calendar as Record<string, unknown> | undefined;
  if (cfg.raw && block && typeof block === "object" && Array.isArray(block.links)) {
    const links = (block.links as unknown[]).filter((l) => !(typeof l === "object" && l !== null && (l as { id?: unknown }).id === id));
    if (links.length !== block.links.length) {
      fromConfig = true;
      try { await writeRawConfig(c.configFile, { ...cfg.raw, calendar: { ...block, links } }); }
      catch { return fail(c, "remove-link", "the config file could not be written", 1); }
    }
  }
  let fromFile = false;
  try { await unlink(calendarLinkFilePath(c.stateDir, id)); fromFile = true; }   // unlink never follows a symlink
  catch (e) { if ((e as { code?: string }).code !== "ENOENT") return fail(c, "remove-link", "the link file could not be removed", 1); }
  if (c.json) c.out(JSON.stringify({ schemaVersion: 1, id, removed: { config: fromConfig, file: fromFile } }));
  else c.out(fromConfig || fromFile ? `Removed calendar link "${id}".` : `No calendar link "${id}".`);
  return fromConfig || fromFile ? 0 : 1;
}

/** The config's resolved calendar, or a failure message. */
async function resolved(c: Ctx): Promise<{ raw: unknown; r: ResolvedCalendar } | { why: string }> {
  const cfg = await readRawConfig(c.configFile);
  if (!cfg.ok) return { why: cfg.why };
  const raw = cfg.raw?.calendar;
  return { raw, r: resolveCalendar(raw, { platform: c.platform }) };
}

async function linkInfo(l: ResolvedCalendarLink, c: Ctx): Promise<CalendarLinkInfo> {
  let urlPathOwner: string | undefined;
  let file: Pick<CalendarLinkInfo, "fileStatus" | "fileReason"> = {};
  if (l.urlFrom !== "command") {   // never run a password manager to draw a list
    const u = await resolveLinkUrl(l, { stateDir: c.stateDir, env: c.env, platform: c.platform });
    if (u.status === "ok") urlPathOwner = pathOwnerOf(u.url);
    if (l.urlFrom === "file") file = u.status === "ok" ? { fileStatus: "ok" } : { fileStatus: u.status, fileReason: u.reason };
  }
  const confirmedOwner = l.confirmedOwner === undefined ? null
    : l.urlFrom === "command" ? l.confirmedOwner
    : l.confirmedOwner === urlPathOwner ? l.confirmedOwner : null;
  const name = shownLinkName(l.name);
  return {
    id: l.id, ...(name !== undefined ? { name } : {}), ...(l.owner !== undefined ? { configuredOwner: l.owner } : {}),
    ...(urlPathOwner !== undefined ? { urlPathOwner } : {}), confirmedOwner, urlFrom: l.urlFrom, ...file,
  };
}

async function list(args: string[], c: Ctx): Promise<number> {
  if (args.length) return fail(c, "list", "takes no arguments besides --json");
  const res = await resolved(c);
  if ("why" in res) return fail(c, "list", res.why);
  // The Mac Calendar app (plan M10c): the reader's `list` mode through the installed copy — never a prompt (the
  // mode is gated), `helper-missing` when no copy is installed; `null` off macOS.
  const mac = c.platform === "darwin" ? await listMacCalendars(res.r.macos?.calendars ?? "editable", macDeps(c)) : null;
  const out: CalendarListJson = {
    schemaVersion: 1,
    macos: mac === null ? null : { status: mac.status, ...(mac.notices?.length ? { notices: mac.notices } : {}), calendars: mac.calendars },
    links: await Promise.all(res.r.links.map((l) => linkInfo(l, c))),
  };
  if (c.json) { c.out(JSON.stringify(out)); return 0; }
  if (out.macos) {
    c.out(`Mac Calendar: ${out.macos.status === "ok" ? "ok" : CALENDAR_STATUS_TEXT[out.macos.status]}${out.macos.notices?.length ? ` (${out.macos.notices.join(", ")})` : ""}`);
    for (const cal of out.macos.calendars) c.out(stripControl(`  ${cal.selected ? "[x]" : "[ ]"} ${cal.title} — ${cal.account}${cal.editable ? "" : " (read-only)"}`));
  }
  if (out.links.length === 0) c.out("No calendar links.");
  for (const l of out.links) {
    const who = [l.configuredOwner && `owner ${l.configuredOwner}`, l.urlPathOwner && `address names ${l.urlPathOwner}${l.confirmedOwner ? " (confirmed)" : " (not confirmed)"}`].filter(Boolean).join(", ");
    c.out(stripControl(`${l.id}${l.name ? `  "${l.name}"` : ""}  from ${l.urlFrom}${l.fileStatus && l.fileStatus !== "ok" ? ` (${l.fileStatus}: ${l.fileReason})` : ""}${who ? `  — ${who}` : ""}`));
  }
  return 0;
}

async function testVerb(args: string[], c: Ctx): Promise<number> {
  if (args.length) return fail(c, "test", "takes no arguments besides --json");
  const res = await resolved(c);
  if ("why" in res) return fail(c, "test", res.why);
  const now = c.now ?? Date.now;
  const startedAt = now();
  // An attended read now: no health record (only owned runs write one), and no machine-level offline verdict — a
  // connection failure is reported as the link's own (`incomplete` / `unreachable`).
  const read = await readCalendar(res.r, { runDate: localDateStr(new Date(startedAt)), startedAt, offline: false }, {
    stateDir: c.stateDir, platform: c.platform, now,
    ...(c.env ? { env: c.env } : {}), ...(c.exec ? { exec: c.exec } : {}), ...(c.fetch ? { fetch: c.fetch } : {}),
    ...(c.parseCommand ? { parseCommand: c.parseCommand } : {}),
    ...(c.macExec ? { macExec: c.macExec } : {}), ...(c.osRelease !== undefined ? { osRelease: c.osRelease } : {}),
  });
  const out: CalendarTestJson = {
    schemaVersion: 1, ranAt: new Date(startedAt).toISOString(),
    sources: read.sources.map((s) => ({
      id: s.id, kind: s.kind, status: s.status, ...(s.notices?.length ? { notices: s.notices } : {}),
      eventsToday: s.eventsToday, durationMs: s.durationMs, ...(s.status !== "ok" && s.reason !== undefined ? { reason: s.reason } : {}),
    })),
    incomplete: read.sources.some((s) => s.status !== "ok"),
  };
  if (c.json) { c.out(JSON.stringify(out)); return 0; }
  if (out.sources.length === 0) c.out("No calendar source is configured.");
  for (const s of out.sources) {
    const label = s.kind === "macos" ? "Mac Calendar" : s.id;
    c.out(s.status === "ok"
      ? `${label}: ok — ${s.eventsToday} event(s) today${s.notices?.length ? ` (${s.notices.join(", ")})` : ""}`
      : `${label}: ${CALENDAR_STATUS_TEXT[s.status as Exclude<CalendarReadStatus, "ok">]}${s.reason ? ` [${s.reason}]` : ""}${s.eventsToday !== null ? ` — ${s.eventsToday} event(s) today` : ""}`);
  }
  return 0;
}

async function status(args: string[], c: Ctx): Promise<number> {
  if (args.length) return fail(c, "status", "takes no arguments besides --json");
  const res = await resolved(c);
  if ("why" in res) return fail(c, "status", res.why);
  const out = await calendarStatus(res.raw, c.stateDir, {
    platform: c.platform, ...(c.osRelease !== undefined ? { osRelease: c.osRelease } : {}), resolved: res.r,
  });
  if (c.json) { c.out(JSON.stringify(out)); return 0; }
  c.out(`Calendar is ${out.enabled ? "on" : "off"}.`);
  for (const w of out.configWarnings) c.out(`⚠ ${w}`);
  for (const s of out.sources) {
    const label = s.kind === "macos" ? "Mac Calendar" : `${s.id}${s.name ? ` "${s.name}"` : ""}`;
    const r = s.lastScheduledRead;
    c.out(stripControl(`${label}: last scheduled read ${r === null ? "not yet" : `${r.status} at ${r.at}${r.reason ? ` [${r.reason}]` : ""}`}`));
  }
  return 0;
}

/** `daily-briefing calendar <verb> …` — `args` is everything after `calendar`. Exit codes: 0 done / reported,
 *  1 the action did not happen (nothing to remove, a write failed, the Mac reader is missing or access was not granted), 2 a usage error. */
export async function calendarMain(args: string[], deps: CalendarCliDeps = {}): Promise<number> {
  const json = args.includes("--json");
  const rest = args.filter((a) => a !== "--json");
  const c: Ctx = {
    ...deps, json,
    stateDir: deps.stateDir ?? supportDir(), configFile: deps.configFile ?? configPath(), platform: deps.platform ?? process.platform,
    out: deps.out ?? ((s) => console.log(s)), err: deps.err ?? ((s) => console.error(s)),
  };
  const verb = rest[0];
  if (verb === undefined || !VERBS.has(verb) || args.filter((a) => a === "--json").length > 1 || rest.includes("--json-out")) {
    c.err(verb === undefined ? `calendar: a verb is required — ${USAGE}` : `calendar: unknown verb or argument — ${USAGE}`);
    return 2;
  }
  const a = rest.slice(1);
  switch (verb) {
    case "connect": return connect(a, c);
    case "add-link": return addLink(a, c);
    case "remove-link": return removeLink(a, c);
    case "list": return list(a, c);
    case "test": return testVerb(a, c);
    case "details": return detailsVerb(a, { ...c, resolveConfig: () => resolved(c) });
    default: return status(a, c);
  }
}
