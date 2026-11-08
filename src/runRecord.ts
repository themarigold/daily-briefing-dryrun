// src/runRecord.ts — the morning run's record for the desktop app's live git check (B1-M1-T3, wave-2
// plan; B1 spec "The run record").
//
// One additive, optional state file, `<state>/run-record.json` (`runRecordPath()`), bound to the page by
// its date. It records what the live check cannot recompute: the run's repo list, its window start, the
// page labels (`labelUnits` labels only the morning's surviving units, disambiguated against the whole
// repo list) and the page's OWN commit population (disagreement 9: never a re-query, which would be a
// different population — the extractor dedupes shared commits and patch twins at its return, and
// attribution needs `resolveUnits`' full root set):
//   commits  every window commit, `{ sha, label, repo }`, from `windowCommits` and `commitLabeler`;
//   missing  `recapCoverage`'s own `missing`, from `coverageMissing` — the commits the page's recap does
//            not cover, under the page's rules (a 4- to 6-character citation covers; an ambiguous one
//            covers nothing).
// The three functions are `recapCoverage`'s own pieces (src/generator.ts), so the record and the page's
// "NOT shown above" lines are one computation, not two.
//
// Written by `main.ts` right after the page is saved (fail-open: a record that cannot be written never
// costs the briefing, and nothing is printed). Read by the live check only for its own page's date.
import { mkdir, open, rename as fsRename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runRecordPath } from "./marker";
import { coverageMissing, commitLabeler, windowCommits } from "./generator";
import type { BriefingStruct, ReducedContext } from "./types";
import type { Unit } from "./subprojects";

export type RunRecordCommit = { sha: string; label: string; repo: string };
/** What `core.ts` computes from the run's own context (`CoreResult.recordCommits`). */
export type RecordCommits = { commits: RunRecordCommit[]; missing: string[] };
export type RunRecord = {
  schemaVersion: 1;
  /** The run's local date, which is the page's date. */
  date: string;
  repos: string[];
  windowStartUtc: string;
  labels: Record<string, { repo: string; root: string | null }>;
  commits: RunRecordCommit[];
  missing: string[];
};

/** Room for a large window's SHAs; a bigger file is not read. */
export const RUN_RECORD_MAX_BYTES = 1024 * 1024;

/** The two commit lists, from `recapCoverage`'s own pieces over the context, units and roots the run handed
 *  `generateBriefing`, and the recap `recapCoverage` read. Pure. */
export function recordCommitsFor(
  ctx: ReducedContext, units: Unit[], rootsByRepo: Map<string, string[]> | undefined, recap: BriefingStruct["recap"],
): RecordCommits {
  const labeler = commitLabeler(ctx, units, rootsByRepo);
  const commits = windowCommits(ctx).map((a) => ({ sha: a.event_id!, label: labeler(a), repo: a.repo ?? "" }));
  const missing = coverageMissing(recap, windowCommits(ctx)).map((a) => a.event_id!);
  return { commits, missing };
}

/** The record for a run that generated a page, or undefined when the run carries no commit lists (every
 *  `CoreResult` return but the generated one). The labels map comes from the commits — `labelOf`'s
 *  fallback can give a label no `Unit` carries (the repo label, or "unlabeled") — each with its commits'
 *  repo (the first commit's, in window order) and the root of the unit with that label and repo, or null;
 *  then every `Unit` label not already there, with its own repo and root. */
export function buildRunRecord(r: {
  runDate: string; repos: string[]; units: Unit[]; windowStartUtc: string; recordCommits?: RecordCommits;
}): RunRecord | undefined {
  if (r.recordCommits === undefined) return undefined;
  const labels: RunRecord["labels"] = Object.create(null);
  for (const c of r.recordCommits.commits) {
    if (Object.hasOwn(labels, c.label)) continue;
    const u = r.units.find((x) => x.label === c.label && x.repo === c.repo);
    labels[c.label] = { repo: c.repo, root: u?.root ?? null };
  }
  for (const u of r.units) if (!Object.hasOwn(labels, u.label)) labels[u.label] = { repo: u.repo, root: u.root };
  return {
    schemaVersion: 1, date: r.runDate, repos: [...r.repos], windowStartUtc: r.windowStartUtc,
    labels, commits: r.recordCommits.commits, missing: r.recordCommits.missing,
  };
}

/** Atomic: a temp file in the state dir written 0600, then `rename` (`writeUpdateCheckState`'s pattern,
 *  src/updateCheck.ts, with the mode set explicitly). On any failure the temp file is removed and the error
 *  is rethrown, for the caller's own fail-open `.catch`. `ops.rename` is a test seam. */
export async function writeRunRecord(
  record: RunRecord, path: string = runRecordPath(), ops: { rename: (from: string, to: string) => Promise<void> } = { rename: fsRename },
): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 10)}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await ops.rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrArray = (v: unknown): v is string[] => Array.isArray(v) && v.every(isStr);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function asRecord(v: unknown): RunRecord | undefined {
  if (!isObj(v)) return undefined;
  if (v.schemaVersion !== 1 || !isStr(v.date) || !/^\d{4}-\d{2}-\d{2}$/.test(v.date)) return undefined;
  if (!isStrArray(v.repos) || !isStr(v.windowStartUtc) || !isStrArray(v.missing)) return undefined;
  if (!isObj(v.labels)) return undefined;
  for (const l of Object.values(v.labels)) {
    if (!isObj(l) || !isStr(l.repo) || !(l.root === null || isStr(l.root))) return undefined;
  }
  if (!Array.isArray(v.commits) || !v.commits.every((c) => isObj(c) && isStr(c.sha) && isStr(c.label) && isStr(c.repo))) return undefined;
  v.labels = Object.assign(Object.create(null), v.labels);
  return v as unknown as RunRecord;
}

/** The record, accepted only when it is the page's own: missing, unreadable, over `RUN_RECORD_MAX_BYTES`,
 *  malformed, or dated other than `pageDate` → `{ accepted: false }`. Never writes. */
export async function readRunRecord(pageDate: string, path: string = runRecordPath()): Promise<{ accepted: false } | { accepted: true; record: RunRecord }> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > RUN_RECORD_MAX_BYTES) return { accepted: false };
    // Read through ONE handle, at most the cap plus a byte, so a file that grows after the `stat` is still
    // refused rather than read whole.
    const fh = await open(path, "r");
    let text: string;
    try {
      const buf = Buffer.alloc(RUN_RECORD_MAX_BYTES + 1);
      let n = 0;
      for (;;) {   // a read may return short; loop to EOF or one byte past the cap
        const { bytesRead } = await fh.read(buf, n, buf.length - n, n);
        if (bytesRead === 0) break;
        n += bytesRead;
        if (n === buf.length) break;
      }
      if (n > RUN_RECORD_MAX_BYTES) return { accepted: false };
      text = buf.subarray(0, n).toString("utf8");
    } finally { await fh.close(); }
    const record = asRecord(JSON.parse(text));
    if (record === undefined || record.date !== pageDate) return { accepted: false };
    return { accepted: true, record };
  } catch {
    return { accepted: false };
  }
}
