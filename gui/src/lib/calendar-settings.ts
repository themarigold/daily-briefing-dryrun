/**
 * v0.3.0 (calendar connection, plan M9) — Settings → Calendar and the wizard's optional calendar step:
 * the PURE half. `lib/CalendarSettings.svelte` draws it and owns the IPC; everything it decides is
 * here, so `tests-web/calendar.check.ts` can pin it without a DOM.
 *
 * ⚠ A LINK'S URL IS A SECRET (spec r4 §2), and this module is where that is enforceable on the app's
 * side. The URL enters exactly one function — [`addLink`], through its `takeUrl` callback, which the
 * component implements by READING AND CLEARING the paste field — and leaves it exactly once, as the
 * second argument of `deps.writeLink` (`calendar_link_write`). It is never returned, never stored in
 * a result, a block or component state, never put in a message and never logged: Rust answers with
 * the class of a problem only (`CalendarError`), and the engine's JSON never carries a URL. The
 * sentinel test drives a URL through every path here and finds it nowhere but that one call.
 *
 * ⚠ THE OWNER CONFIRMATION (spec r4 §4.2). When a link is added, the address the engine read from its
 * URL path (`urlPathOwner`, Google's personal links only) is SHOWN, and the user must confirm it is
 * theirs before it is stored as `confirmedOwner` — and [`confirmOwner`] re-reads `calendar list`
 * first, so a confirmation is only ever of the address the CURRENT link names (a link replaced in the
 * meantime never inherits one). Adding or replacing a link always drops that link's `confirmedOwner`
 * ([`withLinkEntry`]), as Rust does for a replaced URL. A link whose URL names no owner asks for
 * "Your email address on this calendar" (the config's `owner`), which only recognises accepts and
 * declines.
 *
 * ⚠ THE `calendar` BLOCK IS EDITED, NEVER REBUILT: every edit reads the config as it is NOW, copies
 * its `calendar` block, changes the one thing asked, and hands the whole block to
 * `calendar_config_save`, so `emails`, `macos`, `urlEnv` / `urlCommand` links and every other key
 * survive. Rust holds the block to the engine resolver's rules (`check_calendar_block`) and the engine
 * validates the file; nothing here re-implements either.
 */
import type { LinkWritten } from "./calendar";
import { hm, localDateOf, monthDay } from "./briefing-struct";
import {
  CALENDAR_STATUS_TEXT,
  type CalendarLastRead,
  type CalendarLinkInfo,
  type CalendarListJson,
  type CalendarMacosCalendar,
  type CalendarReadStatus,
  type CalendarSourceKind,
  type CalendarSourceNotice,
  type CalendarStatusJson,
  type CalendarStatusSource,
  type CalendarTestJson,
  type CalendarTestSource,
} from "./calendar-contract";
import type { EngineOutcome } from "./engine";
import { EDIT_AS_JSON, type ConfigDocument, type FieldNote, type SaveOutcome } from "./files";
import type { Os } from "./platform";

/* ── the Mac Calendar app source ───────────────────────────────────────────────────────────────── */

/**
 * ⚠ THE ONE SWITCH FOR THE MAC CALENDAR APP SOURCE (hub decision, plan p4 §3). PR 1 shipped the links
 * only, with this `false`; W3 (PR 2) ships the signed Calendar Reader inside the app and turns it ON. The
 * Mac section — the toggle, "Allow access", the calendar checklist, the `helper-outdated` notice and the
 * overlap hint — is drawn on macOS only (`macSectionShown`); Linux and Windows never draw it.
 */
export const MAC_CALENDAR_AVAILABLE = true;

/** Whether the Mac Calendar app section is drawn: the switch is on AND this is macOS (spec §2: the
 *  Linux app hides the Mac toggle). `available` is the switch; only a test passes anything else. */
export function macSectionShown(os: Os, available: boolean = MAC_CALENDAR_AVAILABLE): boolean {
  return available && os === "macos";
}

/** Spec §4.1, Settings copy: the permission dialog is the helper's, not this app's. */
export const MAC_DIALOG_NOTE =
  'macOS asks for permission in a dialog that names "Daily Briefing Calendar Reader", not this app.';

/** What "Allow access" / "Update the calendar reader" says after `calendar connect mac --json` (W3, final review
 *  r1): `null` when access is granted, else one line — the engine's fixed status text plus what to do. Nothing from
 *  the payload is echoed except a known status and a known reason code. */
export function connectMacMessage(outcome: EngineOutcome): string | null {
  const p = outcome.payload as { status?: unknown; reason?: unknown } | null;
  if (p !== null && typeof p === "object" && p.status === "ok") return null;
  if (p === null || typeof p !== "object" || typeof p.status !== "string" || !Object.hasOwn(CALENDAR_STATUS_TEXT, p.status)) {
    return noAnswer("the calendar access request", outcome);
  }
  const text = CALENDAR_STATUS_TEXT[p.status as Exclude<CalendarReadStatus, "ok">];
  const advice: Record<string, string> = {
    "sign-failed": " — the calendar reader could not be signed (a keychain prompt may have gone unanswered); the reader you have keeps working. Try again",
    "connect-deadline": " — installing the calendar reader took too long. Try again",
    "copy-failed": " — the calendar reader could not be copied into the engine's folder",
  };
  const why = typeof p.reason === "string" && Object.hasOwn(advice, p.reason) ? advice[p.reason] : "";
  return `Mac Calendar: ${text}${why}.`;
}

/** `helper-outdated` is a notice beside `ok`, never a failure (spec §4.1). */
export const MAC_OUTDATED_NOTE =
  "A newer calendar reader is available. The one you have keeps reading until you update it.";

/* ── the `calendar … --json` payloads, read defensively ───────────────────────────────────────── */

type Json = Record<string, unknown>;
const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

const READ_STATUSES: readonly CalendarReadStatus[] = [
  "ok", "not-granted", "write-only", "denied", "restricted", "unsupported-os", "helper-missing",
  "timeout", "offline", "link-refused", "link-redirected", "malformed", "too-large", "incomplete",
];
const NOTICES: readonly CalendarSourceNotice[] = ["helper-outdated", "identity-unknown"];

function readStatusOf(v: unknown): CalendarReadStatus | null {
  return READ_STATUSES.find((s) => s === v) ?? null;
}
function noticesOf(v: unknown): CalendarSourceNotice[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = NOTICES.filter((n) => v.includes(n));
  return out.length > 0 ? out : undefined;
}
function kindOf(v: unknown): CalendarSourceKind | null {
  return v === "macos" || v === "link" ? v : null;
}
/** `{ key: value }` when `value` is defined, `{}` otherwise — for `exactOptionalPropertyTypes`. */
function opt<K extends string, V>(key: K, value: V | undefined): { [P in K]?: V } {
  return value === undefined ? {} : ({ [key]: value } as { [P in K]?: V });
}

const FILE_STATUSES = ["ok", "missing", "refused", "failed"] as const;

function linkOf(v: unknown): CalendarLinkInfo | null {
  if (!isObj(v) || typeof v["id"] !== "string") return null;
  const urlFrom = v["urlFrom"];
  if (urlFrom !== "file" && urlFrom !== "env" && urlFrom !== "command") return null;
  const fileStatus = FILE_STATUSES.find((s) => s === v["fileStatus"]);
  return {
    id: v["id"],
    ...opt("name", text(v["name"])),
    ...opt("configuredOwner", text(v["configuredOwner"])),
    ...opt("urlPathOwner", text(v["urlPathOwner"])),
    confirmedOwner: text(v["confirmedOwner"]) ?? null,
    urlFrom,
    ...opt("fileStatus", fileStatus),
    ...opt("fileReason", text(v["fileReason"])),
  };
}

function macCalendarOf(v: unknown): CalendarMacosCalendar | null {
  if (!isObj(v) || typeof v["id"] !== "string" || typeof v["title"] !== "string") return null;
  const type = v["type"];
  return {
    id: v["id"],
    title: v["title"],
    account: text(v["account"]) ?? "",
    editable: v["editable"] === true,
    type: type === "subscribed" || type === "birthdays" ? type : "standard",
    selected: v["selected"] === true,
  };
}

/** `calendar list --json`, or `null` when the payload is not one (an older engine, a failure). */
export function parseList(payload: unknown): CalendarListJson | null {
  if (!isObj(payload) || payload["schemaVersion"] !== 1 || !Array.isArray(payload["links"])) return null;
  const links = payload["links"].map(linkOf).filter((l): l is CalendarLinkInfo => l !== null);
  const m = payload["macos"];
  const status = isObj(m) ? readStatusOf(m["status"]) : null;
  const macos =
    isObj(m) && status !== null
      ? {
          status,
          ...opt("notices", noticesOf(m["notices"])),
          calendars: (Array.isArray(m["calendars"]) ? m["calendars"] : [])
            .map(macCalendarOf)
            .filter((c): c is CalendarMacosCalendar => c !== null),
        }
      : null;
  return { schemaVersion: 1, macos, links };
}

function lastReadOf(v: unknown): CalendarLastRead | null {
  if (!isObj(v) || typeof v["at"] !== "string") return null;
  const status = readStatusOf(v["status"]);
  if (status === null) return null;
  return { at: v["at"], status, ...opt("notices", noticesOf(v["notices"])), ...opt("reason", text(v["reason"])) };
}

/** `calendar status --json`, or `null`. */
export function parseStatus(payload: unknown): CalendarStatusJson | null {
  if (!isObj(payload) || payload["schemaVersion"] !== 1 || !Array.isArray(payload["sources"])) return null;
  const sources: CalendarStatusSource[] = [];
  for (const s of payload["sources"]) {
    if (!isObj(s) || typeof s["id"] !== "string") continue;
    const kind = kindOf(s["kind"]);
    if (kind === null) continue;
    sources.push({
      id: s["id"],
      kind,
      ...opt("name", text(s["name"])),
      lastScheduledRead: lastReadOf(s["lastScheduledRead"]),
      ...opt("reason", text(s["reason"])),
    });
  }
  const warnings = Array.isArray(payload["configWarnings"])
    ? payload["configWarnings"].filter((w): w is string => typeof w === "string")
    : [];
  return {
    schemaVersion: 1, enabled: payload["enabled"] === true,
    // Only a literal `false` is "never asked": an older engine (no field) is never asked, the safe reading.
    enabledSet: payload["enabledSet"] !== false,
    macSupported: payload["macSupported"] === true,
    configWarnings: warnings, sources,
  };
}

/** The engine's resolver ends every MALFORMATION warning with this (`src/calendar/config.ts`, `OFF`): the
 *  whole calendar block was switched off. Its two other warnings (a skipped `url` link, `macos` off macOS)
 *  do not carry it. `tests-web/calendar.check.ts` holds it to the engine's `CALENDAR_CONFIG_WARNINGS`. */
export const CONFIG_OFF_SUFFIX = " — calendar off";

/** Settings → Calendar's lines for `calendar status --json`'s `configWarnings` (integration LOW: a GUI-only
 *  user otherwise never sees them — they ride status/doctor and `config validate`, never `struct.warnings`).
 *  A malformation while the engine reports calendar disabled says the settings could not be read; any other
 *  warning is shown as it is. Fixed engine text only — it never quotes a value from the block. */
export function configWarningLines(status: CalendarStatusJson | null): { text: string; off: boolean }[] {
  if (status === null) return [];
  return status.configWarnings.map((w) => {
    const off = !status.enabled && w.endsWith(CONFIG_OFF_SUFFIX);
    return { text: off ? `Your calendar settings could not be read: ${w}` : w, off };
  });
}

/** `calendar test --json`, or `null`. */
export function parseTest(payload: unknown): CalendarTestJson | null {
  if (!isObj(payload) || payload["schemaVersion"] !== 1 || !Array.isArray(payload["sources"])) return null;
  const sources: CalendarTestSource[] = [];
  for (const s of payload["sources"]) {
    if (!isObj(s) || typeof s["id"] !== "string") continue;
    const kind = kindOf(s["kind"]);
    const status = readStatusOf(s["status"]);
    if (kind === null || status === null) continue;
    sources.push({
      id: s["id"],
      kind,
      status,
      ...opt("notices", noticesOf(s["notices"])),
      eventsToday: typeof s["eventsToday"] === "number" ? s["eventsToday"] : null,
      durationMs: typeof s["durationMs"] === "number" ? s["durationMs"] : 0,
      ...opt("reason", text(s["reason"])),
    });
  }
  return {
    schemaVersion: 1,
    ranAt: text(payload["ranAt"]) ?? "",
    sources,
    incomplete: payload["incomplete"] === true,
  };
}

/** What marks a whitespace-free run as URL-shaped, compared without case: a scheme (`https://`,
 *  `webcal://`, …) in any spelling — final harden r3: the backslash forms a browser opens as `//`
 *  (`https:\\host`, `https:/\host`), the JSON-escaped `:\/` and the percent-encoded separators (`%3a` then any
 *  two of `%2f` / `%5c`, the mixed `%3a%2f%5c` / `%3a%5c%2f` included — the engine's `SCHEME_SEP_RE`, the
 *  desktop's `scheme_separators`) — or the schemeless path of a Google (`…calendar/ical/…`), Outlook
 *  (`…/owa/calendar/…`) or iCloud (`…icloud.com/published/…`) calendar link. */
const LINK_MARKS: readonly string[] = [
  "://", ":\\\\", ":/\\", ":\\/", "%3a%2f%2f", "%3a%5c%5c", "%3a%2f%5c", "%3a%5c%2f",
  "calendar/ical/", "/owa/calendar/", "icloud.com/published/",
];

/** `text` with every URL-shaped run — the WHOLE whitespace-free run, so nothing of the link and nothing
 *  glued to it survives — replaced by `[link]` (M9 checkpoint): engine stderr is shown on screen, and
 *  an uncaught engine error could carry a link's URL even though no engine message names one.
 *  ⚠ LINEAR TIME, by construction: one pass over maximal runs, then substring tests. A regex with a
 *  leading `\S*` or `[a-z][a-z0-9+.-]*` backtracks quadratically over a long run (measured: 7.3 s for
 *  one 50,000-character run), and stderr is engine output of any length. */
export function redactLinks(text: string): string {
  return text.replace(/\S+/g, (run) => {
    const lower = run.toLowerCase();
    return LINK_MARKS.some((mark) => lower.includes(mark)) ? "[link]" : run;
  });
}

/** The sentence for an engine answer that carried no payload this screen can read. The engine's own
 *  stderr follows it, its last 600 characters, with anything URL-shaped redacted FIRST — before the cut,
 *  which could otherwise leave a link's secret tail without the host or scheme that marks it. */
export function noAnswer(what: string, outcome: EngineOutcome): string {
  const exit = outcome.exitCode === null ? "killed by a signal" : `exit ${outcome.exitCode}`;
  const err = redactLinks(outcome.stderr).trim().slice(-600);
  return `The engine did not answer ${what} (${exit}).${err !== "" ? `\n${err}` : ""}`;
}

/* ── wording ──────────────────────────────────────────────────────────────────────────────────── */

/** The credential ladder's reason codes (W1's `src/calendar/link-url.ts`, the `LinkUrl*Reason`
 *  unions), in words. A code is a fixed engine token; one this table does not know is shown as the
 *  code — and only when it looks like one, so no free text from anywhere is ever echoed here. */
export const REASON_TEXT: Readonly<Record<string, string>> = Object.freeze({
  "file-missing": "its saved address is missing; add the link again",
  "file-empty": "its saved address is empty; add the link again",
  "env-unset": "its environment variable is not set",
  "command-empty": "its command printed nothing",
  "unsupported-platform": "saved links are not supported on this system",
  "dir-symlink": "the saved-links folder is a symbolic link",
  "dir-not-directory": "the saved-links folder is not a folder",
  "dir-owner": "the saved-links folder belongs to another user",
  "dir-permissions": "the saved-links folder can be opened by other users",
  "file-symlink": "its saved address is a symbolic link",
  "file-not-regular": "its saved address is not a regular file",
  "file-owner": "its saved address belongs to another user",
  "file-permissions": "its saved address can be read by other users",
  "file-hardlinked": "its saved address has a second name elsewhere on disk",
  "too-long": "the link is too long",
  "read-error": "the link could not be read",
  "command-not-run": "its command could not be started",
  "command-timeout": "its command took longer than 5 seconds",
  "command-exit": "its command failed",
});

/** A reason code in words, or `null` for none (or for anything that is not a code). */
export function reasonText(reason: string | undefined): string | null {
  if (reason === undefined || !/^[a-z0-9-]{1,40}$/.test(reason)) return null;
  return REASON_TEXT[reason] ?? `reason: ${reason}`;
}

/** A read status in words: `ok`, or the section's own fixed sentence, plus a credential reason. */
export function statusSentence(status: CalendarReadStatus, reason?: string): string {
  if (status === "ok") return "ok";
  const why = reasonText(reason);
  return `${CALENDAR_STATUS_TEXT[status]}${why === null ? "" : ` — ${why}`}`;
}

/** "Last scheduled read" (spec §8): `not yet`, `ok at 07:21` (`ok on Oct 12 at 07:21` when it was not
 *  today), or the failure's fixed sentence with its time. LOCAL time, as the briefing shows times. */
export function lastReadLine(read: CalendarLastRead | null, today: string, reason?: string): string {
  if (read === null) return "not yet";
  const ms = Date.parse(read.at);
  const why = read.reason ?? reason;
  if (Number.isNaN(ms)) return statusSentence(read.status, why);
  const day = localDateOf(ms);
  const time = hm(ms);
  if (read.status === "ok") return day === today ? `ok at ${time}` : `ok on ${monthDay(day)} at ${time}`;
  return `${statusSentence(read.status, why)} (${day === today ? time : `${monthDay(day)}, ${time}`})`;
}

/** One source's "Test now" answer. */
export function testLine(t: CalendarTestSource): string {
  const n = t.eventsToday;
  const events = n === null ? "" : `${n} event${n === 1 ? "" : "s"} today`;
  if (t.status === "ok") return events === "" ? "ok" : `ok — ${events}`;
  return `${statusSentence(t.status, t.reason)}${events === "" ? "" : ` (${events})`}`;
}

/** The problem with a managed link file `calendar list` reported, or `null`. */
export function fileProblem(link: CalendarLinkInfo): string | null {
  if (link.urlFrom !== "file" || link.fileStatus === undefined || link.fileStatus === "ok") return null;
  const why = reasonText(link.fileReason);
  if (link.fileStatus === "missing") return why ?? "its saved address is missing; add the link again";
  if (link.fileStatus === "failed") return why ?? "its saved address could not be read";
  return `its saved address was refused${why === null ? "" : ` — ${why}`}`;
}

/** Where a link's URL comes from, for a link the app did not write. */
export function urlFromLine(link: CalendarLinkInfo): string | null {
  if (link.urlFrom === "env") return "Its address comes from an environment variable (set in the config file).";
  if (link.urlFrom === "command") return "Its address comes from a command (set in the config file).";
  return null;
}

/* ── the owner (spec r4 §4.2) ─────────────────────────────────────────────────────────────────── */

/** What a link needs about its owner:
 *  - `confirm` — the URL path names an address the user has not confirmed as theirs: show it, and
 *    store it as `confirmedOwner` only on an explicit yes (`yours` is a configured `owner` that is the
 *    same address, if any);
 *  - `ask` — nothing names the owner (the source reports `identity-unknown`): ask for the address;
 *  - `known` — nothing to ask.
 *
 *  ⚠ "NO, IT BELONGS TO SOMEONE ELSE" IS STORED AS AN `owner` (hub decision, M9 checkpoint): the No
 *  button leads to "Your email address on this calendar", whose save sets the config's `owner`. A
 *  configured owner that is NOT the URL path's address is that answer, so the question is not asked
 *  again — the link is `known` by the address the user gave. (The same address, compared without case
 *  or surrounding spaces, answers nothing: the confirmation is still asked.) */
export type OwnerPrompt =
  | { kind: "confirm"; address: string; yours: string | null }
  | { kind: "ask" }
  | { kind: "known"; address: string; confirmed: boolean };

export function ownerPrompt(link: CalendarLinkInfo): OwnerPrompt {
  const configured = link.configuredOwner;
  if (link.urlPathOwner !== undefined) {
    if (link.confirmedOwner === link.urlPathOwner) {
      return { kind: "known", address: link.urlPathOwner, confirmed: true };
    }
    const declined =
      configured !== undefined && configured.trim().toLowerCase() !== link.urlPathOwner.trim().toLowerCase();
    if (!declined) return { kind: "confirm", address: link.urlPathOwner, yours: configured ?? null };
  }
  if (configured !== undefined) return { kind: "known", address: configured, confirmed: false };
  return { kind: "ask" };
}

/** Whether to ask for "Your email address on this calendar": the prompt says so, the user answered a
 *  pending confirmation "No, it belongs to someone else" (`declined`, the component's per-row state —
 *  saving the address is what makes that answer stick, [`ownerPrompt`]), or the engine reported
 *  `identity-unknown` for this link in its last scheduled read or the last test. */
export function needsAddress(
  prompt: OwnerPrompt,
  notices: readonly CalendarSourceNotice[],
  declined: boolean = false,
): boolean {
  // A confirmation is pending only while NO differing owner is configured (`ownerPrompt`), and then the URL's
  // address already recognises accepts and declines — so the confirmation is the one question asked, until the
  // user says the address is not theirs. (With a differing owner configured, an unconfirmed URL address
  // recognises nothing — engine fix-round 1 — and the prompt is `known` by the configured address instead.)
  if (prompt.kind === "ask") return true;
  return prompt.kind === "confirm" ? declined : notices.includes("identity-unknown");
}

export const OWNER_FIELD_LABEL = "Your email address on this calendar";
export const OWNER_FIELD_HELP =
  "Used only to recognise which invitations you accepted or declined. Without it, every event from " +
  "this calendar is treated as not accepted.";

/** The confirmation question for an address taken from the link (spec §4.2). */
export function confirmQuestion(address: string): string {
  return `This link belongs to ${address}. Is this calendar yours? A link to a calendar you manage for someone else carries their address.`;
}

/* ── the `calendar` block ─────────────────────────────────────────────────────────────────────── */

export type CalendarBlock = Json;

/** The config's `calendar` block, COPIED — `{}` when the config has none; `null` when the text is not
 *  a JSON object or its `calendar` is not one (nothing is edited then). */
export function calendarBlockOf(configText: string | null): CalendarBlock | null {
  if (configText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(configText);
  } catch {
    return null;
  }
  if (!isObj(parsed)) return null;
  const block = parsed["calendar"];
  if (block === undefined || block === null) return {};
  return isObj(block) ? (JSON.parse(JSON.stringify(block)) as CalendarBlock) : null;
}

const idOf = (entry: unknown): string | null => (isObj(entry) && typeof entry["id"] === "string" ? entry["id"] : null);

/** The link ids the block already holds. */
export function linkIds(block: CalendarBlock): string[] {
  return (Array.isArray(block["links"]) ? block["links"] : []).map(idOf).filter((id): id is string => id !== null);
}

/** `block` with its `links` replaced by `edit`'s answer; every other key, in place. */
function editLinks(block: CalendarBlock, edit: (links: unknown[]) => unknown[]): CalendarBlock {
  const links = Array.isArray(block["links"]) ? [...block["links"]] : [];
  return { ...block, links: edit(links) };
}

/** Turned on: `enabled: true`, written first in a new block. */
function turnedOn(block: CalendarBlock): CalendarBlock {
  return "enabled" in block ? { ...block, enabled: true } : { enabled: true, ...block };
}

/**
 * The block after ADDING or REPLACING the managed-file link `id`: the calendar turned on, and the
 * link's entry appended (`{ id, name? }`) or — for an existing id — kept with every other key, its
 * `name` replaced when one was typed, and its `confirmedOwner` DROPPED. A confirmation is of the
 * address in one URL; a link written again is confirmed again (spec §4.2, the Rust write's own rule).
 * `turnOn` false (Settings, user-directed 2026-10-22, C2): `enabled` is left as written, absent included — the
 * calendar's switch is the user's. (Not the engine's `calendar add-link`, which leaves an existing block's `enabled`
 * as written but writes `enabled: true` into a block it creates: `src/calendar/cli.ts`.)
 */
export function withLinkEntry(block: CalendarBlock, id: string, name: string, turnOn = true): CalendarBlock {
  const label = name.trim();
  return (turnOn ? turnedOn : (b: CalendarBlock) => b)(
    editLinks(block, (links) => {
      const at = links.findIndex((l) => idOf(l) === id);
      if (at === -1) return [...links, label === "" ? { id } : { id, name: label }];
      const { confirmedOwner: _dropped, ...kept } = links[at] as Json;
      void _dropped;
      links[at] = label === "" ? kept : { ...kept, name: label };
      return links;
    }),
  );
}

/** The block with `confirmedOwner` set on link `id`, or `null` when the block has no such link. */
export function withConfirmedOwner(block: CalendarBlock, id: string, address: string): CalendarBlock | null {
  if (!linkIds(block).includes(id)) return null;
  return editLinks(block, (links) => links.map((l) => (idOf(l) === id ? { ...(l as Json), confirmedOwner: address } : l)));
}

/** The block with link `id`'s `owner` set (or removed, for a blank address), or `null` without it. */
export function withOwner(block: CalendarBlock, id: string, address: string): CalendarBlock | null {
  if (!linkIds(block).includes(id)) return null;
  const value = address.trim();
  return editLinks(block, (links) =>
    links.map((l) => {
      if (idOf(l) !== id) return l;
      const { owner: _old, ...rest } = l as Json;
      void _old;
      return value === "" ? rest : { ...rest, owner: value };
    }),
  );
}

/** The block with `enabled` set. */
export function withEnabled(block: CalendarBlock, on: boolean): CalendarBlock {
  return { ...block, enabled: on };
}

/** The Mac source turned on (`macos: { calendars: "editable" }` unless a choice is already there) or
 *  off (no `macos` key). Turning it on turns the calendar on too, unless `turnOn` is false (Settings, user-directed
 *  2026-10-22, C2: the calendar's own switch is the user's; the wizard keeps turning it on). */
export function withMacos(block: CalendarBlock, on: boolean, turnOn = true): CalendarBlock {
  if (!on) {
    const { macos: _gone, ...rest } = block;
    void _gone;
    return rest;
  }
  const next = { ...block, macos: isObj(block["macos"]) ? block["macos"] : { calendars: "editable" } };
  return turnOn ? turnedOn(next) : next;
}

/** C2: Settings' one line after a source is turned on or a link added while the calendar is off — why its row says
 *  "off" (C1). `null` while the calendar is on, or when its block cannot be read (that row says so itself). */
export const CALENDAR_OFF_SOURCE_LINE = "The calendar is off, so this source is not read until you turn it on above.";
export function offSourceNote(block: CalendarBlock | null): string | null {
  return block !== null && !calendarOn(block) ? CALENDAR_OFF_SOURCE_LINE : null;
}

/** The Mac checklist's answer: exactly the ticked calendars, as `{ id, title, account }`. */
export function withMacCalendars(block: CalendarBlock, chosen: readonly CalendarMacosCalendar[]): CalendarBlock {
  const macos = isObj(block["macos"]) ? block["macos"] : {};
  return { ...block, macos: { ...macos, calendars: chosen.map((c) => ({ id: c.id, title: c.title, account: c.account })) } };
}

/* ── the link's short name (id) ───────────────────────────────────────────────────────────────── */

/** Ids the engine keeps for itself (Rust's `RESERVED_LINK_IDS`). */
export const RESERVED_LINK_IDS: readonly string[] = ["macos"];

/** An id suggested from the display name (spec §8): lower-case letters, digits and dashes, at most 32,
 *  starting with a letter or digit — the grammar Rust enforces — and not one already `taken`. */
export function suggestId(name: string, taken: readonly string[]): string {
  let base = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  if (base === "") base = "calendar";
  if (RESERVED_LINK_IDS.includes(base)) base = `${base}-calendar`;
  if (!taken.includes(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 32 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

/* ── the per-provider steps (spec §8) ─────────────────────────────────────────────────────────── */

export interface ProviderSteps {
  id: "google" | "outlook" | "icloud" | "other";
  label: string;
  steps: readonly string[];
}

export const PROVIDERS: readonly ProviderSteps[] = [
  {
    id: "google",
    label: "Google Calendar",
    steps: [
      "Open Google Calendar in a web browser and go to Settings (the gear icon).",
      "Under \"Settings for my calendars\", choose the calendar.",
      "In \"Integrate calendar\", copy \"Secret address in iCal format\".",
      "Paste it below.",
    ],
  },
  {
    id: "outlook",
    label: "Outlook or Microsoft 365",
    steps: [
      "Open Outlook on the web and go to Settings → Calendar → Shared calendars.",
      "Under \"Publish a calendar\", choose the calendar and \"Can view all details\", then Publish.",
      "Copy the ICS link it shows.",
      "Paste it below.",
    ],
  },
  {
    id: "icloud",
    label: "iCloud",
    steps: [
      "In the Calendar app (or on iCloud.com), open the calendar's sharing settings.",
      "Turn on \"Public Calendar\" and copy the link it shows.",
      "Paste it below.",
    ],
  },
  {
    id: "other",
    label: "Another calendar (Fastmail, Nextcloud, …)",
    steps: [
      "Find your calendar's private iCalendar (ICS) link — it starts with https:// or webcal://.",
      "Paste it below.",
    ],
  },
];

/** Said beside the paste field, whatever the provider. */
export const LINK_SECRET_NOTE =
  "Anyone who has this link can read the calendar. Daily Briefing keeps it in a private file on this " +
  "computer and never shows it again. If it may have leaked, reset it where you copied it from.";

/* ── the calendar question's link session (wave-2 polish spec §4 "Link"; plan PB-M6-T1) ─────────────── */

/**
 * `startAdding`: the panel opens its add flow ONCE, on its first loaded state — never before it has loaded, and never
 * again on a later refresh (which sets `loaded` again) or re-render. `done` is the latch the caller keeps.
 */
export function startAddingStep(requested: boolean, loaded: boolean, done: boolean): { open: boolean; done: boolean } {
  if (!requested || done || !loaded) return { open: false, done };
  return { open: true, done: true };
}

/** Where the focus goes once the add flow opened by `startAdding` is drawn: its CHOSEN provider (the radio still checked
 *  from an earlier add), else its first provider control. `.add:not(.picker)`: never Settings' "Add a connection…"
 *  picker. */
export const START_ADDING_FOCUS = ['.add:not(.picker) input[name="cal-provider"]:checked', '.add:not(.picker) input[name="cal-provider"]'] as const;

/** The first of `START_ADDING_FOCUS` (in order) inside THIS panel's section — never another instance's, so the query
 *  is the section's, not the document's. A choice only: the component calls `.focus()`. */
export function startAddingFocusTarget<T>(section: { querySelector(selector: string): T | null } | null | undefined): T | null {
  if (section == null) return null;
  for (const selector of START_ADDING_FOCUS) {
    const found = section.querySelector(selector);
    if (found !== null) return found;
  }
  return null;
}

/** PB final LOW L1/L2 — what the link session's card needs from its embedded panel (`onpanelstate`): `working`, a write
 *  of the panel's own in flight (the add's link write → config read → block save, a removal), and `leftoverOffered`,
 *  whether the panel is drawing its "Remove that saved link" offer — which it draws only over a loaded, readable,
 *  existing config (the wizard branch's `!loaded` / `configError` / `configExists === false` lines come first). */
export interface LinkPanelState {
  working: boolean;
  leftoverOffered: boolean;
}
export const LINK_PANEL_IDLE: LinkPanelState = { working: false, leftoverOffered: false };

export function linkPanelState(p: {
  working: boolean;
  leftover: string | null;
  loaded: boolean;
  configError: string | null;
  configExists: boolean | null;
}): LinkPanelState {
  return { working: p.working, leftoverOffered: p.leftover !== null && p.loaded && p.configError === null && p.configExists !== false };
}

/* ── the flows (the IPC injected, so they run in a test) ──────────────────────────────────────── */

/** The four calls the flows make — in the app, `lib/calendar.ts`, `lib/files.ts` and `lib/engine.ts`. */
export interface CalendarDeps {
  writeLink: (id: string, url: string) => Promise<LinkWritten>;
  readConfig: () => Promise<ConfigDocument>;
  saveBlock: (block: CalendarBlock) => Promise<SaveOutcome>;
  list: () => Promise<EngineOutcome>;
}

export type Describe = (e: unknown) => string;

/** `calendar list --json`, read: the payload, or why there is none. Never throws. */
export async function readList(
  list: CalendarDeps["list"],
  describe: Describe,
): Promise<{ list: CalendarListJson | null; error: string | null }> {
  try {
    const outcome = await list();
    const parsed = parseList(outcome.payload);
    return parsed === null ? { list: null, error: noAnswer("calendar list", outcome) } : { list: parsed, error: null };
  } catch (e) {
    return { list: null, error: describe(e) };
  }
}

/** `calendar status --json`, read. Never throws. */
export async function readStatus(
  status: () => Promise<EngineOutcome>,
  describe: Describe,
): Promise<{ status: CalendarStatusJson | null; error: string | null }> {
  try {
    const outcome = await status();
    const parsed = parseStatus(outcome.payload);
    return parsed === null ? { status: null, error: noAnswer("calendar status", outcome) } : { status: parsed, error: null };
  } catch (e) {
    return { status: null, error: describe(e) };
  }
}

/** Redesign D: the summary `CalendarSettings` hands Settings (`onstatus`) for the Calendar page's attention dot.
 *  Not ok when the status could not be read (the panel shows that as a bad line); when the engine switched the
 *  calendar off because its block is malformed (`configWarningLines`' "could not be read" line, `off: true`); or when
 *  the calendar is on and a source's last scheduled read was anything but `ok` (the panel's "Last read" line is then
 *  not "ok at …"). A source not read yet, or a calendar the user switched off (nothing is read), needs no look. */
export function calendarStatusOk(read: { status: CalendarStatusJson | null; error: string | null }): boolean {
  if (read.status === null) return false;
  if (!read.status.enabled) return configWarningLines(read.status).every((l) => !l.off);
  return read.status.sources.every((s) => s.lastScheduledRead === null || s.lastScheduledRead.status === "ok");
}

/** `calendar test --json`, read. Never throws. */
export async function readTest(
  test: () => Promise<EngineOutcome>,
  describe: Describe,
): Promise<{ test: CalendarTestJson | null; error: string | null }> {
  try {
    const outcome = await test();
    const parsed = parseTest(outcome.payload);
    return parsed === null ? { test: null, error: noAnswer("calendar test", outcome) } : { test: parsed, error: null };
  } catch (e) {
    return { test: null, error: describe(e) };
  }
}

/** One key per source: sources are keyed by `(kind, id)` (M0's contract), so a link can never be
 *  mistaken for the Mac source. */
export function sourceKey(kind: CalendarSourceKind, id: string): string {
  return `${kind}\u0001${id}`;
}

/**
 * Round 10 (M3), round 11 (M2, L4): the "Test now" answers this screen shows, per source key, and per source key how
 * many writes that landed have changed that source since the screen was opened (`gens`; absent: none).
 */
export interface SourceTests {
  tests: Record<string, CalendarTestSource>;
  gens: Record<string, number>;
}

/**
 * A write that LANDED and changed the sources `keys` (their switch, their access, their calendars, a link's address): in
 * Settings each one's answer is dropped — it describes the source as it was tested — and its generation goes up, so a
 * Test still running (the engine runs its reads concurrently with this write, `src-tauri/src/engine.rs`) cannot bring
 * that answer back when it ends (`testsAfterAnswer`). The wizard's step behaves as it always did: nothing changes.
 */
export function testsAfterWrite(mode: "settings" | "wizard", state: SourceTests, keys: readonly string[]): SourceTests {
  if (mode !== "settings" || keys.length === 0) return state;
  const gens = { ...state.gens };
  for (const k of keys) gens[k] = (gens[k] ?? 0) + 1;
  const tests = keys.some((k) => state.tests[k] !== undefined) ? Object.fromEntries(Object.entries(state.tests).filter(([k]) => !keys.includes(k))) : state.tests;
  return { tests, gens };
}

/**
 * A "Test now" answer (`sources`), for a Test that started when the generations were `started`: it replaces the shown
 * answers — EXCEPT for a source a write changed while it ran (its generation moved since `started`), whose answer is
 * stale and is not shown; that source keeps what it shows now (nothing, since the write dropped it). With no write in
 * between — always, in the wizard — every answer is shown, as before.
 */
export function testsAfterAnswer(state: SourceTests, sources: readonly CalendarTestSource[], started: Readonly<Record<string, number>>): Record<string, CalendarTestSource> {
  const moved = (k: string): boolean => (state.gens[k] ?? 0) !== (started[k] ?? 0);
  const fresh = sources.map((s) => [sourceKey(s.kind, s.id), s] as const).filter(([k]) => !moved(k));
  const kept = Object.entries(state.tests).filter(([k]) => moved(k));
  return Object.fromEntries([...fresh, ...kept]);
}

export const notesText = (notes: readonly FieldNote[]): string =>
  notes.map((n) => (n.field !== "" ? `${n.field}: ${n.message}` : n.message)).join("; ");

/** What a block edit did: saved (with the engine's warnings) or why not. */
export type EditResult = { ok: true; warnings: FieldNote[] } | { ok: false; message: string };

/** Read the config as it is NOW, apply `edit` to a copy of its `calendar` block, save the block.
 *  `edit` answering `null` means "nothing to edit" (the link is gone): reported, nothing saved. */
export async function editBlock(
  edit: (block: CalendarBlock) => CalendarBlock | null,
  deps: Pick<CalendarDeps, "readConfig" | "saveBlock">,
  describe: Describe,
): Promise<EditResult> {
  try {
    const doc = await deps.readConfig();
    if (!doc.exists) return { ok: false, message: "There is no configuration yet — the Setup wizard creates one." };
    const block = calendarBlockOf(doc.text);
    if (block === null) {
      return { ok: false, message: `The config's calendar settings could not be read, so nothing was changed. Fix them with ${EDIT_AS_JSON}.` };
    }
    const next = edit(block);
    if (next === null) return { ok: false, message: "That calendar link is no longer in the config. Reload and try again." };
    const saved = await deps.saveBlock(next);
    if (saved.kind === "invalid") return { ok: false, message: `Not saved: ${notesText(saved.errors)}` };
    return { ok: true, warnings: saved.kind === "saved" || saved.kind === "created" ? saved.warnings : [] };
  } catch (e) {
    return { ok: false, message: describe(e) };
  }
}

/** What adding a link did. ⚠ No variant carries the URL. `linkWritten` on a failure says the link file
 *  is on disk although its config entry is not — the component then offers to remove it.
 *  `confirmationCleared` on a failure is Rust's answer from that write — its result, or its
 *  `writeAfterConfirmationCleared` error (`false` when the config was not touched): the replaced
 *  link's `confirmedOwner` was removed from `config.json` before the failure, so the config DID
 *  change and Settings must reload its form (M9 checkpoint). */
export type AddLinkResult =
  | {
      kind: "added";
      id: string;
      replaced: boolean;
      /** `calendar list`'s entry for the new link, or `null` when the engine could not say. */
      link: CalendarLinkInfo | null;
      prompt: OwnerPrompt | null;
      warnings: FieldNote[];
      /** Why the link could not be checked yet (`calendar list` failed), else `null`. */
      note: string | null;
    }
  | { kind: "failed"; message: string; linkWritten: boolean; confirmationCleared: boolean };

/**
 * "Add a calendar link" (spec §8): the URL to its managed file, THEN the link's entry into the
 * `calendar` block (read AFTER the write, so a confirmation Rust cleared for a replaced URL is not
 * written back), THEN `calendar list` for the address the URL names — which the component shows for
 * confirmation ([`ownerPrompt`]). `takeUrl` reads AND CLEARS the paste field; its answer goes to
 * `writeLink` and nowhere else (the header).
 */
export async function addLink(
  input: { id: string; name: string; takeUrl: () => string },
  deps: CalendarDeps,
  describe: Describe,
  /** C2: `turnOn` false leaves `enabled` as written (Settings); absent, the calendar is turned on (the wizard). */
  options: { turnOn: boolean } = { turnOn: true },
): Promise<AddLinkResult> {
  let written: LinkWritten;
  try {
    written = await deps.writeLink(input.id, input.takeUrl());
  } catch (e) {
    // A replacing write can fail AFTER Rust removed the old URL's confirmation from config.json
    // (`writeAfterConfirmationCleared`): the config changed, so the failure says so.
    const cleared = typeof e === "object" && e !== null && (e as { confirmationCleared?: unknown }).confirmationCleared === true;
    return { kind: "failed", message: describe(e), linkWritten: false, confirmationCleared: cleared };
  }
  // From here on this function holds no URL.
  const saved = await editBlock((block) => withLinkEntry(block, written.id, input.name, options.turnOn), deps, describe);
  if (!saved.ok) {
    return {
      kind: "failed",
      message: `The link was saved to its private file, but the calendar settings were not: ${saved.message}`,
      linkWritten: true,
      confirmationCleared: written.confirmationCleared,
    };
  }
  const listed = await readList(deps.list, describe);
  const link = listed.list?.links.find((l) => l.id === written.id) ?? null;
  return {
    kind: "added",
    id: written.id,
    replaced: written.replaced,
    link,
    prompt: link === null ? null : ownerPrompt(link),
    warnings: saved.warnings,
    note: link === null ? (listed.error ?? "The engine did not list the new link yet.") : null,
  };
}

/**
 * The user said "yes, this calendar is mine" about `address`. Stored as the link's `confirmedOwner`
 * ONLY when `calendar list`, read again now, still says the link's URL names exactly that address —
 * a link replaced since the question was drawn never inherits the answer (spec §4.2).
 */
export async function confirmOwner(
  id: string,
  address: string,
  deps: Pick<CalendarDeps, "readConfig" | "saveBlock" | "list">,
  describe: Describe,
): Promise<EditResult> {
  const listed = await readList(deps.list, describe);
  const link = listed.list?.links.find((l) => l.id === id);
  if (link === undefined) {
    return { ok: false, message: listed.error ?? "That calendar link is no longer configured." };
  }
  if (link.urlPathOwner === undefined || link.urlPathOwner !== address) {
    return { ok: false, message: "This link's address changed since it was shown, so nothing was saved. Check it again." };
  }
  return editBlock((block) => withConfirmedOwner(block, id, address), deps, describe);
}

/* ── the overlap hint (spec §8) ───────────────────────────────────────────────────────────────── */

export interface OverlapHint {
  account: string;
  linkId: string;
}

/** A selected Mac calendar whose account is the address a link's URL names: the same Google calendar,
 *  connected twice. De-duplication handles it either way; Settings suggests keeping one. */
export function overlapHints(list: CalendarListJson): OverlapHint[] {
  if (list.macos === null) return [];
  const accounts = new Set(list.macos.calendars.filter((c) => c.selected).map((c) => c.account.trim().toLowerCase()));
  const out: OverlapHint[] = [];
  for (const l of list.links) {
    if (l.urlPathOwner !== undefined && accounts.has(l.urlPathOwner.trim().toLowerCase())) {
      out.push({ account: l.urlPathOwner, linkId: l.id });
    }
  }
  return out;
}

export function overlapLine(h: OverlapHint): string {
  return `${h.account} is connected twice — through the Mac Calendar app and through the link "${h.linkId}". Keeping one is enough; the briefing merges the duplicates either way.`;
}

/** The Mac source's read status in words, for the section's status line. */
export function macStatusLine(status: CalendarReadStatus): string {
  return status === "ok" ? "Reading your Mac calendars." : `Mac Calendar: ${CALENDAR_STATUS_TEXT[status]}.`;
}

/* ── Redesign D, option A (user-directed 2026-10-22): the Sources rows ────────────────────────────── */

/**
 * The short status a source's row shows at its right (the S-A mockup's "● allowed · 3 calendars"). `warn` is the
 * one tone that asks for the user — the row opens by itself ([`nextOpenRows`]); `ok` is the mockup's green; `muted`
 * says nothing is wrong. Every word comes from the states the panel already reads; the row's details carry the
 * engine's own sentence.
 */
export interface SourceTag {
  text: string;
  tone: "ok" | "warn" | "muted";
}

/** The access answers the user gives (or a reader to install): "Allow access", or System Settings. */
const ACCESS_STATUSES: readonly CalendarReadStatus[] = ["not-granted", "helper-missing", "write-only", "denied", "restricted"];

/**
 * The Mac Calendar app's tag. `on` is the config's switch; `mac` is `calendar list`'s `macos` (`null`: not reported
 * yet — no tag, the details say so); `read` its last scheduled read (`undefined` when the status is unknown); `test`
 * its last "Test now" answer (tiny fix, the LOWs: a failed test counts as a failed read, as a link's does).
 * Access first, then any other failure, then the outdated reader (a notice beside ok, spec §4.1), then a failed
 * scheduled read or test; else the calendars being read (the engine's `selected`), counted. A failure that is only a
 * partial read is "partly read", the engine's sentence for `incomplete` (`CALENDAR_STATUS_TEXT`).
 */
export function macSourceTag(
  on: boolean,
  mac: CalendarListJson["macos"],
  read: CalendarLastRead | null | undefined,
  test: CalendarTestSource | undefined,
): SourceTag | null {
  const failure = (statuses: CalendarReadStatus[]): SourceTag => ({
    text: statuses.every((s) => s === "incomplete") ? "partly read" : "couldn't read",
    tone: "warn",
  });
  if (!on) return { text: "off", tone: "muted" };
  if (mac === null) return null;
  if (ACCESS_STATUSES.includes(mac.status)) return { text: "needs access", tone: "warn" };
  if (mac.status !== "ok") return failure([mac.status]);
  if (mac.notices?.includes("helper-outdated") === true) return { text: "reader needs an update", tone: "warn" };
  const failed = [read?.status, test?.status].filter((s): s is CalendarReadStatus => s !== undefined && s !== "ok");
  if (failed.length > 0) return failure(failed);
  const n = mac.calendars.filter((c) => c.selected).length;
  return { text: `allowed · ${n} calendar${n === 1 ? "" : "s"}`, tone: "ok" };
}

/**
 * A calendar link's tag. `read` is its last scheduled read (`null`: not yet; `undefined`: the status is unknown —
 * no tag), `test` its last "Test now" answer, `notices` both reads' notices, `declined` the row's "No, it belongs to
 * someone else", `today` the local date the times are worded against. A problem (the managed file, the scheduled
 * read or the test) outranks the owner questions; then the confirmation waiting, then the address to add
 * ([`needsAddress`]); then an ok read with its time (`lastReadLine`'s helpers: local time, `Oct 12, 07:21` when it
 * was not today).
 */
export function linkSourceTag(
  link: CalendarLinkInfo,
  seen: {
    read: CalendarLastRead | null | undefined;
    test: CalendarTestSource | undefined;
    notices: readonly CalendarSourceNotice[];
    declined: boolean;
    today: string;
  },
): SourceTag | null {
  const { read, test } = seen;
  const failed = (read !== null && read !== undefined && read.status !== "ok") || (test !== undefined && test.status !== "ok");
  if (fileProblem(link) !== null || failed) return { text: "couldn't read", tone: "warn" };
  const prompt = ownerPrompt(link);
  if (prompt.kind === "confirm" && !seen.declined) return { text: "is this yours?", tone: "warn" };
  if (needsAddress(prompt, seen.notices, seen.declined)) return { text: "add your email", tone: "warn" };
  if (read === undefined) return null;
  if (read === null) return { text: "not read yet", tone: "muted" };
  const ms = Date.parse(read.at);
  if (Number.isNaN(ms)) return { text: "read", tone: "ok" };
  const day = localDateOf(ms);
  return { text: day === seen.today ? `read today ${hm(ms)}` : `read ${monthDay(day)}, ${hm(ms)}`, tone: "ok" };
}

/** The calendar's own switch AS WRITTEN in the file: `calendar.enabled === true`; absent, false or a block this app
 *  cannot read is off. It is what the master switch shows and flips. ⚠ IT IS NOT WHETHER THE ENGINE READS THE CALENDAR:
 *  the engine also turns the whole calendar off for a block it finds malformed (`src/calendar/config.ts`
 *  `resolveCalendar`: `{ enabled: true, emails: "not-a-list" }` is off) — that is `calendarReadOn`. */
export function calendarOn(block: CalendarBlock | null): boolean {
  return block !== null && block["enabled"] === true;
}

/** Round 9 (M3): whether the engine reads the calendar — the file's switch (`calendarOn`) and, once the engine's status
 *  is known, its own answer (`calendar status --json` `enabled`), which is off for a block it finds malformed. While the
 *  status is unknown, the file's switch. Settings' ENABLED / DISABLED label, its help and every row's tag follow this. */
export function calendarReadOn(block: CalendarBlock | null, status: CalendarStatusJson | null): boolean {
  return calendarOn(block) && (status === null || status.enabled);
}

/**
 * User-directed 2026-10-22 (C1): the tag a source's row shows. While the calendar is off, no source is read, so every
 * row says "off" (muted, the Mac source's own "off"), whatever its access or last read says — and, as a muted tag asks
 * nothing of the user, no row opens by itself then. The rows still open on a click, with their details, so sources can
 * be prepared before the calendar is turned on. While it is on, the source's own tag.
 *
 * Round 9 (M2): EXCEPT A SOURCE THIS SCREEN'S "Test now" FAILED ON (`test`, the last answer since the page was opened).
 * The engine's test reads every source whether or not the calendar is on, so its failure is real news: that row shows
 * its own tag — a warning, so it opens by itself — or "couldn't read" when its own tag has no warning to give. A source
 * whose test passed, or that was never tested, still says "off". Round 10 (M3): a source that is itself switched off
 * (the Mac Calendar app's own switch) is passed no `test` — no answer about it is news — and a write that changes a
 * source drops its answer (`CalendarSettings`' `forgetTests`).
 */
export function shownSourceTag(on: boolean, tag: SourceTag | null, test?: CalendarTestSource): SourceTag | null {
  if (on) return tag;
  if (test !== undefined && test.status !== "ok") return tag?.tone === "warn" ? tag : { text: "couldn't read", tone: "warn" };
  return { text: "off", tone: "muted" };
}

/** The rows' open state, by row key: `open` as drawn, `needed` whether each row needed the user last time. */
export interface OpenRows {
  open: Record<string, boolean>;
  needed: Record<string, boolean>;
}

/**
 * The open rows after the sources' needs changed (`needs`: row key → its tag asks for the user). A row seen for the
 * first time opens exactly when it needs the user; after that the user's own open or closed choice is kept, except
 * that a row which NEWLY needs the user (it did not last time) opens. Nothing ever closes by itself — the user may be
 * typing in the row. A row no longer present is forgotten.
 */
export function nextOpenRows(prev: OpenRows, needs: Readonly<Record<string, boolean>>): OpenRows {
  const open = keyed<boolean>();
  for (const [key, need] of Object.entries(needs)) {
    const seenBefore = Object.hasOwn(prev.open, key);
    open[key] = !seenBefore ? need : need && !isSet(prev.needed, key) ? true : isSet(prev.open, key);
  }
  return { open, needed: Object.assign(keyed<boolean>(), needs) };
}

/**
 * Round 12 (L4): a record keyed by a name the user chose — a provider's label — with NO PROTOTYPE, so every key is its
 * own: `__proto__` is written as a key (on a plain object the assignment sets the prototype and the key is lost) and
 * `constructor` or `toString` read as absent until written. Svelte's `$state` does not proxy such an object, so a
 * component holds it in `$state.raw` and replaces it whole (`withRowOpen`).
 */
export function keyed<V>(): Record<string, V> {
  return Object.create(null) as Record<string, V>;
}

/** `rec[key] === true`, as its own key only. */
export function isSet(rec: Readonly<Record<string, boolean>>, key: string): boolean {
  return Object.hasOwn(rec, key) && rec[key] === true;
}

/** Row `key` opened or closed by the user (a header's click, a row's own action), the rest as they are: a new value. */
export function withRowOpen(rows: OpenRows, key: string, open: boolean): OpenRows {
  const next = Object.assign(keyed<boolean>(), rows.open);
  next[key] = open;
  return { open: next, needed: rows.needed };
}

/* ── user-directed 2026-10-22: the master switch box, the Connections label, and the C-A rows (Settings only) ── */

/** The master switch's box: its title and its one line (the switch writes `calendar.enabled`, `withEnabled`). */
export const MASTER_TITLE = "Show today's calendar in your briefing";
export const MASTER_LINE = "The AI then fits its suggestions around your meetings.";
/** Briefing redesign C (wave-2 plan C-M5-T15): the box's second line, Settings only, explaining the calendar slide's
 *  live read (proposed wording, checked in the screenshot pass). Not part of the switch's description. */
export const LIVE_READ_LINE = "Meeting links, people and notes are read live and never saved.";

/** The Connections box's help under its title: what can be connected (the Mac source only where it is shown,
 *  `macSectionShown`), or — while the calendar is off — why nothing is read. `on` is `calendarReadOn`; `unreadable`
 *  (round 9, M3): the file's switch is on but the engine turned the calendar off, as it does for settings it cannot
 *  read — whose own line (`configWarningLines`) is the first row below. Round 10 (H1): and this page cannot save them
 *  meanwhile — the switch included: Rust refuses to write a block the engine would find malformed
 *  (`check_calendar_block`) — so the line says where they are fixed. */
export const CALENDAR_UNREADABLE_HELP =
  `The calendar is off until the problem below is fixed: the engine could not read its settings, and until then this page cannot save them, its switch included. Fix them with ${EDIT_AS_JSON}.`;
export function connectionsHelp(on: boolean, showMac: boolean, unreadable = false): { text: string; off: boolean } {
  if (!on && unreadable) return { text: CALENDAR_UNREADABLE_HELP, off: true };
  if (!on) return { text: "The calendar is off, so these aren't read. Turn it on above.", off: true };
  return {
    text: showMac
      ? "Your Mac's Calendar app, and private calendar links from Google, Outlook, iCloud or another calendar."
      : "Private calendar links from Google, Outlook, iCloud or another calendar.",
    off: false,
  };
}

/** The label at the Connections title's right, in words: `on` is whether the engine reads the calendar
 *  (`calendarReadOn` — the file's switch and the engine's own answer), as the component passes it. */
export function connectionsLabel(on: boolean): { text: "Enabled" | "Disabled"; tone: "on" | "off" } {
  return on ? { text: "Enabled", tone: "on" } : { text: "Disabled", tone: "off" };
}

export const MAC_CALENDAR_OFF_TAG = "off (calendar off)";
/** C-A: the Mac row's plain line and its inline tag. The calendars counted are the engine's `selected`; "reads" only
 *  while the calendar is on (off, the C1 tag says "off" and the line says what is chosen). `tag` is the row's shown tag
 *  (`shownSourceTag(…, macSourceTag(…))`): its "allowed · N calendars" is "allowed" here, the count being in the line. */
export function macRow(macOn: boolean, mac: CalendarListJson["macos"], calOn: boolean, tag: SourceTag | null): { line: string; tag: SourceTag | null } {
  // Round 9 (L13): the Mac switch is on but the calendar is not — its "off" says whose switch it is.
  const shown =
    tag !== null && tag.text.startsWith("allowed · ")
      ? { ...tag, text: "allowed" }
      : macOn && !calOn && tag !== null && tag.text === "off"
        ? { ...tag, text: MAC_CALENDAR_OFF_TAG }
        : tag;
  if (!macOn || mac === null || mac.status !== "ok") return { line: "Every account you added on this Mac", tag: shown };
  const n = mac.calendars.filter((c) => c.selected).length;
  const cals = `${n} calendar${n === 1 ? "" : "s"}`;
  return { line: calOn ? `Reads ${cals} on this Mac` : `${cals} chosen on this Mac`, tag: shown };
}

/** C-A: a link row's plain line — "Google calendar link" only when stored data says so: the engine's `urlPathOwner` is
 *  the address in a GOOGLE link's path (`googleUrlPathOwner`), absent for every other host. Never read from the name. */
export function linkRowLine(link: CalendarLinkInfo): string {
  return link.urlPathOwner !== undefined ? "Google calendar link" : "Calendar link";
}

/** C-A: the one action a row that needs the user shows in the row, with today's label — or `null`. It opens the row
 *  and moves the focus to that control in it (`target`), never doing the step itself. Only while the calendar is on
 *  (off, no row needs the user, C1), and only where today's details draw that control. */
export type RowAction = { label: string; target: "allow" | "update" | "confirm" | "owner" };
export function macRowAction(macOn: boolean, mac: CalendarListJson["macos"], calOn: boolean): RowAction | null {
  if (!calOn || !macOn || mac === null) return null;
  if (mac.status === "not-granted" || mac.status === "helper-missing") return { label: "Allow access", target: "allow" };
  if (mac.status === "ok" && mac.notices?.includes("helper-outdated") === true) return { label: "Update the calendar reader", target: "update" };
  return null;
}
export function linkRowAction(
  link: CalendarLinkInfo,
  seen: { read: CalendarLastRead | null | undefined; test: CalendarTestSource | undefined; notices: readonly CalendarSourceNotice[]; declined: boolean },
  calOn: boolean,
): RowAction | null {
  if (!calOn) return null;
  const { read, test } = seen;
  const failed = (read !== null && read !== undefined && read.status !== "ok") || (test !== undefined && test.status !== "ok");
  // A problem outranks the owner questions (`linkSourceTag`): its row says "couldn't read", which no row button fixes.
  if (fileProblem(link) !== null || failed) return null;
  const prompt = ownerPrompt(link);
  if (prompt.kind === "confirm" && !seen.declined) return { label: "Check the address", target: "confirm" };
  if (needsAddress(prompt, seen.notices, seen.declined)) return { label: "Add your email", target: "owner" };
  return null;
}

/** C-A footer: what "Add a connection…" offers — the Mac Calendar app only where its section is shown and it is not on
 *  yet; with one choice, the link flow opens at once. */
export function connectionChoices(showMac: boolean, macOn: boolean): ("mac" | "link")[] {
  return showMac && !macOn ? ["mac", "link"] : ["link"];
}
