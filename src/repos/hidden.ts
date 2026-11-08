// src/repos/hidden.ts — the commits behind "(+N more)" (B1-M3-T8, wave-2 plan; B1 spec "What the user sees",
// user decision of 2026-10-24).
//
// THE MORNING'S OWN LIST, NOT A RE-QUERY (disagreement 9). With an accepted run record only, a label's hidden
// commits are the record's `missing` SHAs (recapCoverage's own uncovered list, B1-M1-T3) whose recorded label
// is that label (matched on `norm` keys, as the cards are), MINUS every commit the card tokens resolved to
// (B1-M2-T4), by full SHA, in the repo it resolved in. So a commit the page covered with a 4- to 6-character
// citation is never listed (it is not in `missing`), an ambiguous 7-character token subtracts nothing (it
// resolved to no commit, as it covered none on the page), and the "NOT shown above" commits, cited by
// 7-character SHAs, are subtracted. The Other card's tokens subtract in the repo each resolved in.
//
// Their subjects come from ONE hardened `log --no-walk=unsorted --ignore-missing` per repo (at most 2 000 SHAs
// per call): without `--ignore-missing`, one SHA the repo no longer has (gc'd) makes the whole call exit 128
// "bad object"; with it the present commits print and the absent one is skipped (measured, plan round 2). Each
// subject goes through `redactCredentials` and THEN the 72-character clip (the page's own figure for these
// lines, `NOT_SHOWN_SUBJECT_CLIP`). `listCommits`, `resolveAuthor` and the exclude patterns are not used: the
// record already carries the morning's filtering.
// Simple: hidden-commit population → the record's copy of the page's own lists (commitLabeler and
// coverageMissing, one copy each); no second window, dedupe, attribution or coverage rule.
import { LISTING_MAX_BYTES, NO_SHOW_SIGNATURE } from "../git";
import { norm } from "../subprojects";
import { redactCredentials } from "../transcripts/credentials";
import type { RunRecord } from "../runRecord";
import { gitOut, type RepoGit } from "./hgit";
import { SHAS_PER_CALL } from "./resolve";

/** A hidden commit's subject is clipped to this (the page's `NOT_SHOWN_SUBJECT_CLIP`, src/generator.ts). */
export const HIDDEN_SUBJECT_MAX = 72;

/** A hidden commit's subject for the reply: redacted FIRST, then cut to `HIDDEN_SUBJECT_MAX − 1` and marked
 *  with "…" (`clipSubject`'s idiom: a credential the cut halved would no longer match). Never ends on a lone
 *  high surrogate. Pure. */
export function hiddenSubject(raw: string): string {
  const t = redactCredentials(raw);
  if (t.length <= HIDDEN_SUBJECT_MAX) return t;
  let end = HIDDEN_SUBJECT_MAX - 1;
  const last = t.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${t.slice(0, end)}…`;
}

export type HiddenPlan = {
  /** Per repo, the hidden commits to look up, in the record's commit order: `{ sha, key }`, `key` the
   *  request's card key (`norm(label)`). */
  byRepo: Map<string, { sha: string; key: string }[]>;
  /** Hidden commits that land on no card the request sent, plus `missing` SHAs the record's commits do not
   *  carry: any of them makes `complete` false. */
  strays: number;
};

/** Which commits are hidden, from the record alone. `keys`: the request's card keys; `resolved`: every commit
 *  the cards' tokens resolved to, with the repo it resolved in. Pure. */
export function planHidden(record: RunRecord, keys: readonly string[], resolved: Iterable<{ sha: string; repo: string }>): HiddenPlan {
  const sent = new Set(keys);
  const cited = new Set<string>();
  for (const r of resolved) cited.add(`${r.repo}\0${r.sha}`);
  const missing = new Set(record.missing);
  const byRepo = new Map<string, { sha: string; key: string }[]>();
  const seen = new Set<string>();
  const carried = new Set<string>();
  let strays = 0;
  for (const c of record.commits) {
    if (!missing.has(c.sha)) continue;
    carried.add(c.sha);
    const id = `${c.repo}\0${c.sha}`;
    if (seen.has(id)) continue;
    seen.add(id);
    if (cited.has(id)) continue;
    const key = norm(c.label);
    if (!sent.has(key)) { strays++; continue; }
    const list = byRepo.get(c.repo) ?? [];
    list.push({ sha: c.sha, key });
    byRepo.set(c.repo, list);
  }
  for (const sha of missing) if (!carried.has(sha)) strays++;
  return { byRepo, strays };
}

const SHA40 = /^[0-9a-f]{40}$/;

/** The subjects of `shas` in one repo, redacted and clipped (`hiddenSubject`): `log --no-walk=unsorted
 *  --ignore-missing --no-show-signature --format=%H%x1f%s --end-of-options <sha…>`, at most `SHAS_PER_CALL`
 *  per call, each a validated 40-hex SHA (anything else is not asked, and asks nothing). A SHA the repo does
 *  not have is absent from the map. Any exit but 0, a timeout or a cut listing throws `RepoUnknown`. */
export async function hiddenSubjects(rg: RepoGit, shas: readonly string[]): Promise<Map<string, string>> {
  const asked = [...new Set(shas.filter((s) => SHA40.test(s)))];
  const out = new Map<string, string>();
  for (let i = 0; i < asked.length; i += SHAS_PER_CALL) {
    const chunk = asked.slice(i, i + SHAS_PER_CALL);
    const want = new Set(chunk);
    const text = await gitOut(rg, ["log", "--no-walk=unsorted", "--ignore-missing", NO_SHOW_SIGNATURE, "--format=%H%x1f%s", "--end-of-options", ...chunk],
      { maxBytes: LISTING_MAX_BYTES });
    for (const line of text.split("\n")) {
      const sep = line.indexOf("\x1f");
      if (sep === -1) continue;
      const sha = line.slice(0, sep);
      if (!want.has(sha) || out.has(sha)) continue;
      out.set(sha, hiddenSubject(line.slice(sep + 1)));
    }
  }
  return out;
}
