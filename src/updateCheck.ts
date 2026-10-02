// src/updateCheck.ts — Phase E E11 (appendix T11, plan R6-U): the opt-in, NOTIFY-ONLY update check.
//
// One anonymous `GET` of this project's latest GitHub release, compared with the running version, and
// the answer written to `<state>/update-check.json`. It downloads nothing, installs nothing, and has
// exactly two entry points:
//   • `checkForUpdate` — `daily-briefing update --check [--json]`, a human or the desktop app's "Check
//     now". Always fetches (`intervalHours` does not apply) and rewrites the state file.
//   • `autoUpdateCheck` — the AUTOMATIC path, called by `main.ts`'s `run()` only on a non-TTY,
//     non-`--json` run (the launchd/systemd tick) that DELIVERED a briefing (Phase E M5b,
//     user-directed: never after a skip or a failure), AFTER the run has finished — briefing, marker,
//     envelope and run lock all done — and only when the config enables it and a check is due.
//
// ⚠ THE THREE CHANNELS IT MUST NEVER REACH, and why this module is shaped around them (plan R6-U):
// stdout/stderr (the launchd plist points both at briefing.log, whose last-header-to-EOF slice is the
// text the audit judge grades), `struct.warnings` / `runtimeWarnings`, and the run envelope's
// `warnings` (the eval's posture line is `posturePhrase(mergeWarnings(…))` over those). So: NOTHING in
// this file writes to a console stream, nothing returns a warning string to a run, and the automatic
// path's only output is the state file. `config validate --json` is the one place a malformed
// `updateCheck` block is ever reported, and it is not a run.
//
// ⚠ IT NEVER THROWS. Every failure — DNS, refused connection, timeout, a non-200, an HTML error page,
// malformed JSON, an unparseable tag, an unwritable state dir — is the answer `unknown` (or, for the
// write, silence). A notify-only feature that could fail a run would be a briefing lost to a curiosity.
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import pkg from "../package.json";
import type { Config } from "./types";
import { loadConfig } from "./config";
import { updateCheckPath } from "./marker";

/** The one URL. No query string, so nothing about this install can ride in it. */
export const UPDATE_CHECK_URL = "https://api.github.com/repos/themarigold/daily-briefing/releases/latest";
/** Where a newer release is shown when the API's own `html_url` is missing or not this project's. */
export const RELEASES_PAGE = "https://github.com/themarigold/daily-briefing/releases/latest";
/** An `html_url` is reported only when it points at THIS project's releases — the URL is printed and
 *  shown as a link, so a value that could send the user anywhere else is replaced, never relayed. */
const RELEASE_URL_PREFIX = "https://github.com/themarigold/daily-briefing/releases/";

/** The whole check — request, body read and all — is capped here (plan E11: 5 s). */
export const UPDATE_CHECK_TIMEOUT_MS = 5_000;
/** The release JSON is read through this many bytes at most; a larger answer (declared or streamed) is
 *  `unknown`, never buffered. GitHub's `releases/latest` for this project is far below it — the release
 *  notes template is ~2.6 KB and each of the ~11 attached assets adds ~2 KB of JSON (an estimate from the
 *  API's documented asset shape, not a measured response) — so the cap bounds memory against a hostile or
 *  broken answer without ever refusing a real one. */
export const MAX_RELEASE_BODY_BYTES = 64 * 1024;
export const DEFAULT_INTERVAL_HOURS = 24;
export const MIN_INTERVAL_HOURS = 1;
export const MAX_INTERVAL_HOURS = 720;
/** How much EARLIER than `intervalHours` an automatic check is already due. A scheduled run fires at
 *  about the same time each day, and "about" includes being a few seconds or minutes earlier than
 *  yesterday; with no slack such a tick found yesterday's record 23h59m old, not due, and the daily
 *  check fired every OTHER day. One hour, but never more than half the interval, so the shortest
 *  allowed interval (1 h) still spaces checks at least 30 minutes apart. */
export const DUE_SLACK_MS = 3_600_000;

export const UPDATE_STATUSES = ["up-to-date", "newer", "unknown"] as const;
export type UpdateStatus = (typeof UPDATE_STATUSES)[number];

/** What `update --check --json` prints and what `status --json` reports: the state file minus `etag`. */
export type UpdateCheckResult = {
  status: UpdateStatus;
  /** The running engine's version. */
  current: string;
  /** The latest release's version, `v` stripped. Absent when the check could not read one. */
  latest?: string;
  /** This project's release page for `latest`. Absent when `latest` is. */
  url?: string;
  /** When the check finished (UTC ISO-8601). */
  checkedAt: string;
};

/** The state file: the result plus the response's ETag, replayed as `If-None-Match` next time so an
 *  unchanged release answers `304` from the cached `latest`/`url`. Written only alongside a release
 *  that was actually read, so a 304 can never be answered from nothing. */
export type UpdateCheckState = UpdateCheckResult & { etag?: string };

/** The fetch surface this module needs — the global `fetch`, or a test's stand-in. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export type UpdateCheckDeps = {
  fetch?: FetchLike;
  now?: () => Date;
  /** The running version; defaults to package.json's (the one `--version` prints). */
  version?: string;
  timeoutMs?: number;
  /** The state file; defaults to `updateCheckPath()`. */
  path?: string;
};

// ── config: B1 style, never a throw ───────────────────────────────────────────────────────────────

export type ResolvedUpdateCheck = { enabled: boolean; intervalHours: number; warning?: string };

/** FIXED TEXT, like `verdictPaths`' and `recapCampaigns`' warnings: it never echoes the configured value. */
export const UPDATE_CHECK_CONFIG_WARNING =
  'config: "updateCheck" must be { enabled?: boolean, intervalHours?: a whole number from 1 to 720 } — the automatic update check is off';

/** `Config.updateCheck` → whether the automatic path may run, and how often. Pure; never throws.
 *
 *  Absent / `null` ⇒ OFF with no warning (unset is the default, not a typo). Anything that is not
 *  exactly `{ enabled?: boolean, intervalHours?: integer 1–720 }` ⇒ OFF plus a warning — including an
 *  object carrying any OTHER key (`"enable": true` is the likely typo, and a check the user believes
 *  is on but is not is invisible state), and an accessor or a throwing Proxy (read by descriptor,
 *  never invoked; the `resolveRecapCampaigns` rule). The failure direction is always OFF: a check
 *  that might be unwanted must not run on a guess. */
export function resolveUpdateCheck(raw: unknown): ResolvedUpdateCheck {
  const off = (warning?: string): ResolvedUpdateCheck =>
    ({ enabled: false, intervalHours: DEFAULT_INTERVAL_HOURS, ...(warning ? { warning } : {}) });
  if (raw === undefined || raw === null) return off();
  try {
    if (typeof raw !== "object" || Array.isArray(raw)) return off(UPDATE_CHECK_CONFIG_WARNING);
    const keys = Reflect.ownKeys(raw);
    if (keys.some((k) => k !== "enabled" && k !== "intervalHours")) return off(UPDATE_CHECK_CONFIG_WARNING);
    const read = (k: string): unknown => {
      const d = Object.getOwnPropertyDescriptor(raw, k);
      if (d === undefined) return undefined;
      if (!("value" in d)) throw new Error("accessor");
      return d.value;
    };
    const enabled = read("enabled");
    const interval = read("intervalHours");
    if (enabled !== undefined && typeof enabled !== "boolean") return off(UPDATE_CHECK_CONFIG_WARNING);
    if (interval !== undefined &&
        !(typeof interval === "number" && Number.isInteger(interval) &&
          interval >= MIN_INTERVAL_HOURS && interval <= MAX_INTERVAL_HOURS)) {
      return off(UPDATE_CHECK_CONFIG_WARNING);
    }
    return { enabled: enabled === true, intervalHours: (interval as number | undefined) ?? DEFAULT_INTERVAL_HOURS };
  } catch {
    return off(UPDATE_CHECK_CONFIG_WARNING);
  }
}

// ── versions ──────────────────────────────────────────────────────────────────────────────────────

/** `major.minor.patch`, an optional leading `v`, an optional `-pre`/`+build` tail of safe characters.
 *  Bounded (each part ≤ 9 digits, the whole ≤ 64 chars), so nothing that reaches a terminal or the
 *  GUI from a release tag can be anything but a short version string. */
const VERSION_RE = /^v?(\d{1,9})\.(\d{1,9})\.(\d{1,9})(?:[-+][0-9A-Za-z.+-]*)?$/;

/** The numeric triple, or `undefined` for anything that is not a version (appendix T11's
 *  "semver-ishly": the numeric parts decide; a pre-release tail never makes a version NEWER). */
export function parseVersion(v: string): [number, number, number] | undefined {
  if (typeof v !== "string" || v.length > 64) return undefined;
  const m = VERSION_RE.exec(v);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
}

/** `newer` when `latest`'s triple is greater than `current`'s; equal or older ⇒ `up-to-date`; either
 *  side unparseable ⇒ `unknown`. */
export function compareVersions(current: string, latest: string): UpdateStatus {
  const c = parseVersion(current);
  const l = parseVersion(latest);
  if (c === undefined || l === undefined) return "unknown";
  for (let i = 0; i < 3; i++) {
    if (l[i]! > c[i]!) return "newer";
    if (l[i]! < c[i]!) return "up-to-date";
  }
  return "up-to-date";
}

// ── the state file ────────────────────────────────────────────────────────────────────────────────

/** Read the state file back, or `undefined` when absent or not the expected shape. Total: polled by
 *  `status --json`, so a corrupt file must read as "no answer yet", never as an exception.
 *
 *  ⚠ `latest`, `url` and `etag` are held to the SAME rules a 200 answer is held to before it is written
 *  (`parseVersion`, `releaseUrl`'s prefix/length/charset rule, `usableEtag`). A 304 replays `latest` and
 *  `url` from this file, so without the check here an edited or corrupted record — a URL pointing
 *  anywhere, a "version" carrying terminal escapes — would be printed and linked as if GitHub had sent it.
 *  A record that fails any rule is NO record: the next check fetches afresh, with no `If-None-Match`. */
export async function readUpdateCheckState(path: string = updateCheckPath()): Promise<UpdateCheckState | undefined> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return undefined;
    const o = JSON.parse(await f.text()) as Record<string, unknown> | null;
    if (o === null || typeof o !== "object" || Array.isArray(o)) return undefined;
    if (!UPDATE_STATUSES.includes(o.status as UpdateStatus)) return undefined;
    if (typeof o.current !== "string" || typeof o.checkedAt !== "string") return undefined;
    if (o.latest !== undefined && (typeof o.latest !== "string" || parseVersion(o.latest) === undefined)) return undefined;
    if (o.url !== undefined && (typeof o.url !== "string" || !isReleaseUrl(o.url))) return undefined;
    if (o.etag !== undefined && (typeof o.etag !== "string" || usableEtag(o.etag) === undefined)) return undefined;
    return {
      status: o.status as UpdateStatus,
      current: o.current,
      ...(typeof o.latest === "string" ? { latest: o.latest } : {}),
      ...(typeof o.url === "string" ? { url: o.url } : {}),
      checkedAt: o.checkedAt,
      ...(typeof o.etag === "string" ? { etag: o.etag } : {}),
    };
  } catch {
    return undefined;
  }
}

/** The state minus the ETag — what leaves the process (`update --check --json`, `status --json`). */
export function publicResult(s: UpdateCheckState): UpdateCheckResult {
  const { etag: _etag, ...rest } = s;
  return rest;
}

/** Temp file + `rename`, so a concurrent manual check and automatic check each leave ONE complete,
 *  equally valid result, and a reader never sees a half-written file. Fail-open: an unwritable state
 *  dir loses the record, never the run. (Residual, stated: a process killed between the write and the
 *  rename leaves its `*.tmp` file behind; nothing reads it.) */
export async function writeUpdateCheckState(state: UpdateCheckState, path: string = updateCheckPath()): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(state)}\n`);
    await rename(tmp, path);
  } catch {
    await unlink(tmp).catch(() => {});
  }
}

/** Is an automatic check due? Absent, unreadable, or older than `intervalHours` less the slack
 *  (`DUE_SLACK_MS`, capped at half the interval) ⇒ yes. A `checkedAt` in the FUTURE (the clock was moved
 *  back) also counts as due, so a skewed record cannot silence the check until the clock catches up. */
export function isDue(state: UpdateCheckState | undefined, intervalHours: number, now: Date): boolean {
  if (state === undefined) return true;
  const at = Date.parse(state.checkedAt);
  if (!Number.isFinite(at)) return true;
  const age = now.getTime() - at;
  const intervalMs = intervalHours * 3_600_000;
  return age < 0 || age >= intervalMs - Math.min(DUE_SLACK_MS, intervalMs / 2);
}

// ── the check ─────────────────────────────────────────────────────────────────────────────────────

/** An ETag worth replaying: short printable ASCII, so a hostile header cannot become a header-injection
 *  vector on the next request or bloat the state file. Anything else is simply not cached. */
function usableEtag(v: string | null): string | undefined {
  return v !== null && v.length > 0 && v.length <= 256 && /^[\x21-\x7e]+$/.test(v) ? v : undefined;
}

/** This project's release pages and nothing else: the prefix, a bounded length, printable ASCII only. */
function isReleaseUrl(v: unknown): v is string {
  return typeof v === "string" && v.startsWith(RELEASE_URL_PREFIX) && v.length <= 256 && /^[\x21-\x7e]+$/.test(v);
}

/** The latest release's page — the API's `html_url` when it is this project's, else the fixed page. */
function releaseUrl(htmlUrl: unknown): string {
  return isReleaseUrl(htmlUrl) ? htmlUrl : RELEASES_PAGE;
}

/** The response body as text, or `undefined` once it is known to exceed `cap` bytes — refused up front
 *  on a declared `content-length` over the cap, and otherwise counted chunk by chunk as it streams, so
 *  an absent or lying length cannot make this buffer more than `cap` (+ one chunk). */
async function readCappedText(res: Response, cap: number): Promise<string | undefined> {
  const declared = Number(res.headers.get("content-length") ?? NaN);
  if (Number.isFinite(declared) && declared > cap) return undefined;
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel().catch(() => {}); return undefined; }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

/** One request, answered. Everything here may throw; the caller turns any throw into `unknown`. */
async function query(
  prior: UpdateCheckState | undefined, current: string, fetchFn: FetchLike, signal: AbortSignal,
): Promise<Omit<UpdateCheckState, "checkedAt">> {
  // Replay the ETag only when the cached answer it validates is actually there to answer from.
  const cached = prior?.etag !== undefined && prior.latest !== undefined && prior.url !== undefined
    ? { etag: prior.etag, latest: prior.latest, url: prior.url }
    : undefined;
  // ⚠ THE WHOLE REQUEST, header by header — this is what the consent copy describes. No query string,
  // no cookie, no token, no identifier: a version in the User-Agent, and (after the first answer)
  // GitHub's own cache tag for the release, which is the same for every client.
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": `daily-briefing/${current}`,
  };
  if (cached) headers["If-None-Match"] = cached.etag;
  // `redirect: "error"`, never fetch's default `"follow"`: a followed redirect would re-send these
  // headers to whatever host the Location names and relay that host's answer. A redirect REJECTS
  // instead (bun 1.3.14: an Error, code `UnexpectedRedirect`), which `runCheck`'s catch makes `unknown`.
  const res = await fetchFn(UPDATE_CHECK_URL, { method: "GET", headers, signal, redirect: "error" });
  if (res.status === 304 && cached) {
    return { status: compareVersions(current, cached.latest), current, latest: cached.latest, url: cached.url, etag: cached.etag };
  }
  if (res.status !== 200) return { status: "unknown", current };
  const text = await readCappedText(res, MAX_RELEASE_BODY_BYTES);
  if (text === undefined) return { status: "unknown", current };
  const body = JSON.parse(text) as Record<string, unknown> | null;
  const tag = body !== null && typeof body === "object" ? body.tag_name : undefined;
  if (typeof tag !== "string" || parseVersion(tag) === undefined) return { status: "unknown", current };
  const latest = tag.startsWith("v") ? tag.slice(1) : tag;
  const etag = usableEtag(res.headers.get("etag"));
  return {
    status: compareVersions(current, latest),
    current,
    latest,
    url: releaseUrl(body!.html_url),
    ...(etag !== undefined ? { etag } : {}),
  };
}

/** Run one check against `prior` (the state file as it was), under the cap, and record it. */
async function runCheck(prior: UpdateCheckState | undefined, deps: UpdateCheckDeps): Promise<UpdateCheckResult> {
  const current = deps.version ?? pkg.version;
  const fetchFn: FetchLike = deps.fetch ?? ((url, init) => fetch(url, init));
  const timeoutMs = deps.timeoutMs ?? UPDATE_CHECK_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  // ⚠ A RACE AS WELL AS AN ABORT. The signal cancels a well-behaved fetch; the race bounds anything
  // that ignores it (a body read that hangs, a stand-in that never settles), so the cap is a property
  // of this function rather than of whichever fetch it was handed.
  const capped = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => { controller.abort(); resolve("timeout"); }, timeoutMs);
    (timer as { unref?: () => void }).unref?.();
  });
  let answer: Omit<UpdateCheckState, "checkedAt">;
  try {
    const got = await Promise.race([query(prior, current, fetchFn, controller.signal), capped]);
    answer = got === "timeout" ? { status: "unknown", current } : got;
  } catch {
    answer = { status: "unknown", current };
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
  const state: UpdateCheckState = {
    status: answer.status,
    current: answer.current,
    ...(answer.latest !== undefined ? { latest: answer.latest } : {}),
    ...(answer.url !== undefined ? { url: answer.url } : {}),
    checkedAt: (deps.now?.() ?? new Date()).toISOString(),
    ...(answer.etag !== undefined ? { etag: answer.etag } : {}),
  };
  await writeUpdateCheckState(state, deps.path);
  return publicResult(state);
}

/** The MANUAL check (`update --check`): always fetches, always rewrites the state file, never throws. */
export async function checkForUpdate(deps: UpdateCheckDeps = {}): Promise<UpdateCheckResult> {
  try {
    return await runCheck(await readUpdateCheckState(deps.path), deps);
  } catch {
    // Unreachable by construction (runCheck catches its own failures); kept so the contract
    // "never throws" does not rest on that.
    return { status: "unknown", current: deps.version ?? pkg.version, checkedAt: (deps.now?.() ?? new Date()).toISOString() };
  }
}

/** The AUTOMATIC path. `main.ts`'s `run()` calls it AFTER the run has returned its exit code, and only
 *  on a non-TTY, non-`--json` run whose envelope said `delivered` — those three gates live at the call
 *  site, beside the run they gate.
 *
 *  In order, and most calls stop at the third step: the config (absent or unreadable ⇒ nothing), its
 *  `updateCheck` (not exactly enabled ⇒ nothing), the state file (checked within `intervalHours` ⇒
 *  nothing), and only then one request. Writes the state file and NOTHING else; prints nothing;
 *  returns nothing a run could report. */
export async function autoUpdateCheck(
  deps: UpdateCheckDeps & { loadConfig?: () => Promise<Config> } = {},
): Promise<void> {
  try {
    let cfg: Config;
    try { cfg = await (deps.loadConfig ?? loadConfig)(); } catch { return; }
    const resolved = resolveUpdateCheck(cfg.updateCheck);
    if (!resolved.enabled) return;
    const prior = await readUpdateCheckState(deps.path);
    if (!isDue(prior, resolved.intervalHours, deps.now?.() ?? new Date())) return;
    await runCheck(prior, deps);
  } catch {
    /* notify-only: never fatal, and never reported — see the module header */
  }
}
