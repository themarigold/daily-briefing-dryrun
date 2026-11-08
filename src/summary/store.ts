import { randomBytes } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import type { BigIntStats } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { SummaryCard } from "./cards";
import { readPageIdentity } from "./page-version";
import type { PageIdentity } from "./page-version";
import { validateSummary } from "./validate";
import type { SummaryProject } from "./validate";

export interface SummaryBinding extends PageIdentity { pageDate: string }
export type SummaryWarningCode = "summary-unavailable" | "summary-text-omitted" | "summary-usage-limit";
export interface SummaryRecord extends SummaryBinding {
  schemaVersion: 1;
  state: "pending" | "ready" | "unavailable";
  revision: 0 | 1;
  projects: SummaryProject[];
  goodMorningSentence: string | null;
  warnings: SummaryWarningCode[];
}

const MAX_RECORD_BYTES = 64 * 1024;
const HEX = /^[0-9a-f]{64}$/u;
const FIELDS = ["schemaVersion", "pageDate", "pageHash", "pageVersion", "state", "revision", "projects", "goodMorningSentence", "warnings"];
const WARNINGS = new Set<SummaryWarningCode>(["summary-unavailable", "summary-text-omitted", "summary-usage-limit"]);
const RECORD_NAME = /^(\d{4}-\d{2}-\d{2})\.([0-9a-f]{64})\.([0-9a-f]{64})\.summary\.json$/u;
const TEMP_NAME = /^(\d{4}-\d{2}-\d{2})\.([0-9a-f]{64})\.([0-9a-f]{64})\.summary\.([1-9][0-9]*)\.([0-9a-f]{32})\.tmp$/u;

function validDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(date)) return false;
  const value = new Date(`${date}T00:00:00.000Z`);
  return Number.isFinite(value.getTime()) && value.toISOString().slice(0, 10) === date;
}
function validBinding(binding: SummaryBinding): boolean {
  return typeof binding?.pageDate === "string" && validDate(binding.pageDate)
    && typeof binding.pageHash === "string" && HEX.test(binding.pageHash)
    && typeof binding.pageVersion === "string" && HEX.test(binding.pageVersion);
}
function sameIdentity(a: PageIdentity | null, b: PageIdentity): boolean {
  return a?.pageHash === b.pageHash && a.pageVersion === b.pageVersion;
}

/** All entry points require the caller's explicit archive root; there is no state fallback. */
export function summaryRecordPath(briefingsDir: string, binding: SummaryBinding): string {
  if (!isAbsolute(briefingsDir) || !validBinding(binding)) throw new Error("Invalid summary binding");
  return join(briefingsDir, `${binding.pageDate}.${binding.pageHash}.${binding.pageVersion}.summary.json`);
}

/** Schema 1's only numbers are its two integers. JSON.parse reads `1.0`, `1e0` and `-0` as integers;
 *  a record must SPELL each number as an unsigned decimal integer, as Rust's integer decode requires.
 *  It also keeps only the last of a repeated object key, so a repeat, however escaped, is refused here.
 *  Called only on text JSON.parse accepted, so strings and numbers are well formed. */
function spelledExactly(raw: string): boolean {
  const scopes: (Set<string> | null)[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i]!;
    if (c === "{") scopes.push(new Set());
    else if (c === "[") scopes.push(null);
    else if (c === "}" || c === "]") scopes.pop();
    if (c === "\"") {
      const start = i;
      for (i++; i < raw.length && raw[i] !== "\""; i++) if (raw[i] === "\\") i++;
      const scope = scopes.at(-1);
      if (scope && /^\s*:/u.test(raw.slice(i + 1))) {
        const key = JSON.parse(raw.slice(start, i + 1)) as string;
        if (scope.has(key)) return false;
        scope.add(key);
      }
      continue;
    }
    if (c !== "-" && (c < "0" || c > "9")) continue;
    let end = i;
    while (end < raw.length && /[-+.eE0-9]/u.test(raw[end]!)) end++;
    if (!/^(0|[1-9][0-9]*)$/u.test(raw.slice(i, end))) return false;
    i = end - 1;
  }
  return true;
}

/** With no page to compare against, every key of machine syntax counts as a card (A2 :47: `other:`, or
 *  `project:` plus a nonempty key), so validateSummary applies all its other rules unchanged. `norm` cannot
 *  decide this: it is not idempotent (`foo :` gives the real key `foo `, and that normalises to `foo`). */
function cardsOfStoredKeys(projects: unknown): SummaryCard[] {
  if (!Array.isArray(projects)) return [];
  const keys = projects.map((entry: { key?: unknown } | null) => entry?.key);
  return keys.flatMap((key) => key === "other:" || (typeof key === "string" && key.startsWith("project:") && key.length > "project:".length) ? [{ key, label: "" }] : []);
}

/** Stored records are refused as a whole; unlike raw model output they are never repaired.
 *  `cards: null` applies every stored-record rule except card membership (plan §0, M6). */
export function parseSummaryRecord(raw: string, binding: SummaryBinding, cards: readonly SummaryCard[] | null): SummaryRecord | null {
  if (!validBinding(binding) || Buffer.byteLength(raw, "utf8") > MAX_RECORD_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!spelledExactly(raw)) return null;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== FIELDS.length || FIELDS.some((key) => !Object.hasOwn(r, key))) return null;
  if (r.schemaVersion !== 1 || r.pageDate !== binding.pageDate || r.pageHash !== binding.pageHash || r.pageVersion !== binding.pageVersion) return null;
  if (r.state !== "pending" && r.state !== "ready" && r.state !== "unavailable") return null;
  if (r.revision !== (r.state === "pending" ? 0 : 1)) return null;
  if (!Array.isArray(r.warnings) || r.warnings.some((w) => !WARNINGS.has(w)) || new Set(r.warnings).size !== r.warnings.length) return null;
  if (r.state !== "ready") {
    if (!Array.isArray(r.projects) || r.projects.length !== 0 || r.goodMorningSentence !== null) return null;
  } else {
    const validated = validateSummary(JSON.stringify({ projects: r.projects, goodMorningSentence: r.goodMorningSentence }), cards ?? cardsOfStoredKeys(r.projects));
    if (validated === null || validated.warnings.length !== 0 || validated.goodMorningSentence !== r.goodMorningSentence) return null;
    // validateSummary has checked the raw entry shapes. Compare values without imposing JSON field order.
    const projects = r.projects as SummaryProject[];
    if (validated.projects.length !== projects.length || validated.projects.some((project, i) => {
      const stored = projects[i]!;
      return project.key !== stored.key || project.points.length !== stored.points.length || project.points.some((point, j) => point !== stored.points[j]);
    })) return null;
  }
  return {
    schemaVersion: 1, pageDate: binding.pageDate, pageHash: binding.pageHash, pageVersion: binding.pageVersion,
    state: r.state, revision: r.state === "pending" ? 0 : 1,
    projects: r.projects as SummaryProject[], goodMorningSentence: r.goodMorningSentence as string | null,
    warnings: r.warnings as SummaryWarningCode[],
  };
}

export function serializeSummaryRecord(record: SummaryRecord, cards: readonly SummaryCard[]): string | null {
  try {
    const raw = JSON.stringify(record);
    const parsed = parseSummaryRecord(raw, record, cards);
    return parsed === null ? null : JSON.stringify(parsed);
  } catch { return null; }
}

function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return b.isFile() && a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
async function regularDirectory(dir: string): Promise<boolean> {
  return isAbsolute(dir) && (await fs.lstat(dir)).isDirectory();
}

/** Capped opened-file read, with no-follow metadata and stability checks. Never throws. */
export async function readSummaryRecord(briefingsDir: string, binding: SummaryBinding, cards: readonly SummaryCard[] | null): Promise<SummaryRecord | null> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const path = summaryRecordPath(briefingsDir, binding);
    if (!await regularDirectory(briefingsDir) || typeof constants.O_NOFOLLOW !== "number" || typeof constants.O_NONBLOCK !== "number") return null;
    const named = await fs.lstat(path, { bigint: true });
    if (!named.isFile()) return null;
    handle = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!sameFile(named, before) || before.size < 0n || before.size > BigInt(MAX_RECORD_BYTES)) return null;
    const bytes = Buffer.alloc(MAX_RECORD_BYTES + 1);
    let used = 0;
    while (used < bytes.length) {
      const { bytesRead } = await handle.read(bytes, used, bytes.length - used, null);
      if (bytesRead === 0) break;
      used += bytesRead;
    }
    if (used > MAX_RECORD_BYTES || BigInt(used) !== before.size || !sameFile(before, await handle.stat({ bigint: true }))
      || !sameFile(before, await fs.lstat(path, { bigint: true }))) return null;
    // ignoreBOM keeps a leading BOM in the text, so JSON.parse refuses it as Rust's decode does.
    return parseSummaryRecord(new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes.subarray(0, used)), binding, cards);
  } catch { return null; }
  finally { try { await handle?.close(); } catch { /* Summary I/O is silent. */ } }
}

/** Atomic, identity-bound publication. A final result must still own a pending record.
 *  `beforePublish` runs before the final pending and identity checks, so an async gate cannot stale them.
 *  `canPublish` is synchronous and runs immediately before rename (the job checks its clock there).
 *  Either gate refusing or throwing publishes nothing. */
export async function writeSummaryRecord(briefingsDir: string, latestPagePath: string, record: SummaryRecord, cards: readonly SummaryCard[], beforePublish?: () => boolean | Promise<boolean>, canPublish?: () => boolean): Promise<boolean> {
  let temp: string | undefined;
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    const path = summaryRecordPath(briefingsDir, record);
    const raw = serializeSummaryRecord(record, cards);
    if (raw === null || !isAbsolute(latestPagePath) || !sameIdentity(await readPageIdentity(latestPagePath), record)) return false;
    await fs.mkdir(briefingsDir, { recursive: true, mode: 0o700 });
    if (!await regularDirectory(briefingsDir)) return false;
    const existing = await fs.lstat(path).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
    if (existing !== null && !existing.isFile()) return false;
    temp = path.slice(0, -"json".length) + `${process.pid}.${randomBytes(16).toString("hex")}.tmp`;
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(raw, "utf8");
    await handle.close(); handle = undefined;
    if (beforePublish !== undefined && await beforePublish() !== true) return false;
    if (record.state !== "pending") {
      const pending = await readSummaryRecord(briefingsDir, record, cards);
      if (pending?.state !== "pending" || pending.revision !== 0) return false;
    }
    // The temp write may have yielded to a newer delivery or to pruning.
    if (!sameIdentity(await readPageIdentity(latestPagePath), record)) return false;
    if (canPublish !== undefined && canPublish() !== true) return false;
    await fs.rename(temp, path);
    temp = undefined;
    return true;
  } catch { return false; }
  finally {
    try { await handle?.close(); } catch { /* No summary diagnostics on stderr. */ }
    if (temp !== undefined) { try { await fs.unlink(temp); } catch { /* Best-effort own-temp cleanup. */ } }
  }
}

/** kill(pid, 0) is a bounded OS existence probe; only ESRCH proves death. */
function confirmedDead(pidText: string): boolean {
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2147483647) return false;
  try { process.kill(pid, 0); return false; }
  catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}

/** Same-date cleanup only. No run-lock or age heuristic is a summary-owner signal.
 *  `shouldStop` is asked after the listing and before each removal; a true answer removes no more. */
export async function pruneSummaryRecords(briefingsDir: string, current: SummaryBinding, shouldStop?: () => boolean): Promise<void> {
  try {
    if (!validBinding(current) || !await regularDirectory(briefingsDir)) return;
    const names = await fs.readdir(briefingsDir);
    if (shouldStop?.()) return;
    for (const name of names) {
      try {
        const record = RECORD_NAME.exec(name), temp = TEMP_NAME.exec(name), match = record ?? temp;
        if (match === null || match[1] !== current.pageDate || !validDate(match[1])
          || (match[2] === current.pageHash && match[3] === current.pageVersion)) continue;
        const path = join(briefingsDir, name);
        const before = await fs.lstat(path, { bigint: true });
        if (!before.isFile() || (temp !== null && !confirmedDead(temp[4]!))) continue;
        const unchanged = sameFile(before, await fs.lstat(path, { bigint: true }));
        if (shouldStop?.()) return;
        if (unchanged) await fs.unlink(path);
      } catch { /* One unsafe or unremovable entry does not widen the cleanup. */ }
    }
  } catch { /* Cleanup failure is silent; it cannot change delivery. */ }
}
