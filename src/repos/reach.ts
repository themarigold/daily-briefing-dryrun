// B2-M1-T3: one reachability batch per remote. PR facts reuse B1's grouping and squash evidence,
// then require the evidence commit on that remote's actual default ref (never local main alone).
import { windowArgs } from "../git";
import { gitOut, LISTING_MAX_BYTES, type RepoGit } from "./hgit";
import { openScan, byteCmp, type SquashMatch } from "./groups";
import { listedRefOk, safeFactName, refFormatOk } from "./remotes";
import type { RepoFacts } from "./types";

const SHA40 = /^[0-9a-f]{40}$/;
/** The most remote-tracking refs `remoteBranches` reports; over it the fact is null, because uniqueness needs
 *  the whole list. A fixed bound on this private member, roughly 300 KB per repo. The number is the same as Rust's
 *  `STAT_CAP` (`repos.rs`), but they count different things: that one walks ref files, so packed refs do not reach it. */
export const REMOTE_BRANCHES_CAP = 2_000;
/** How long before the window a walk still looks. A row's commit can predate the window when its PR merged inside it. */
export const REACH_MARGIN_MS = 30 * 864e5;
const lines = (s: string) => s.split("\n").filter(Boolean);

/** Git's plain `--since` stops walking at the first older commit, so a commit whose child has an earlier date is missed
 *  on that path alone. With one remote that loses a link and nothing else, and it is what makes the walk cheap. With
 *  several, a miss on one could leave another looking like the only holder of a commit or of `#N`: there the date is
 *  tested per commit (`windowArgs`), which walks the whole history but lists no more than the window, or nothing is
 *  filtered on a git too old for it. */
async function walkBound(rg: RepoGit, remotes: number, windowStart: Date): Promise<string[]> {
  const cutoff = windowStart.getTime() - REACH_MARGIN_MS;
  return remotes === 1 ? [`--since=${new Date(cutoff).toISOString()}`] : windowArgs(cutoff, { timeoutMs: rg.budget.callTimeoutMs() });
}

/** See `RepoFacts.remoteBranches`. */
function listRemoteBranches(refs: readonly { ref: string; symref: string; sha: string }[], owner: (ref: string) => string | undefined): RepoFacts["remoteBranches"] {
  const tips = refs.filter((r) => r.symref === "");
  if (tips.length > REMOTE_BRANCHES_CAP || tips.some((r) => !SHA40.test(r.sha))) return null;
  const listed: NonNullable<RepoFacts["remoteBranches"]> = [];
  const leftOut = new Set<string>();
  for (const r of tips) {
    const remote = owner(r.ref);
    const name = remote === undefined ? "" : r.ref.slice(`refs/remotes/${remote}/`.length);
    if (remote !== undefined && listedRefOk(name)) listed.push({ remote, name, sha: r.sha });
    else leftOut.add(r.sha);
  }
  return listed.filter((b) => !leftOut.has(b.sha));
}

export async function readReachFacts(
  rg: RepoGit, facts: RepoFacts, commits: readonly string[],
  windowStart: Date, now: Date, squashed: ReadonlyMap<string, SquashMatch>,
): Promise<RepoFacts> {
  const result: RepoFacts = { ...facts, remotes: facts.remotes?.map((r) => ({ ...r, defaultBranch: null })) ?? null, reachableRemotes: null, remoteBranches: null, prEvidence: null };
  if (result.remotes === null) return result;
  const shas = [...new Set(commits.filter((s) => SHA40.test(s)))];
  let refs: { ref: string; symref: string; sha: string }[];
  try {
    const out = await gitOut(rg, ["for-each-ref", "--format=%(refname)%1f%(symref)%1f%(objectname)", "--end-of-options", "refs/remotes/"], { maxBytes: LISTING_MAX_BYTES });
    refs = lines(out).map((line) => {
      const parts = line.split("\x1f");
      if (parts.length !== 3 || !parts[0]!.startsWith("refs/remotes/")) throw new Error("remote refs");
      return { ref: parts[0]!, symref: parts[1]!, sha: parts[2]! };
    });
  } catch { return result; }
  // Remote names themselves may contain slashes. Longest exact configured prefix owns a ref. With a name left out, a slash
  // past the prefix proves nothing: `refs/remotes/origin/fork-é/main` may be that remote's, so it has no known owner (B2 `:55`).
  const byPrefix = [...result.remotes].sort((a, b) => b.name.length - a.name.length || byteCmp(a.name, b.name));
  const owner = (ref: string) => {
    const name = byPrefix.find((r) => ref.startsWith(`refs/remotes/${r.name}/`))?.name;
    return name !== undefined && facts.omittedRemotes && ref.slice(`refs/remotes/${name}/`.length).includes("/") ? undefined : name;
  };
  result.remoteBranches = listRemoteBranches(refs, owner);
  const reached = new Map(shas.map((s) => [s, [] as string[]]));
  const defaults = new Map<string, Set<string>>();
  // A remote with no known default cannot supply evidence, but one that reads as GitHub can be the real owner: a fetch writes
  // `<remote>/HEAD` on Git 2.50.1 (measured), but a remote may simply not have one, and a synced fork's `origin` then looks
  // like the only holder of upstream's `#N` (B2 `:56`). A deploy, GitLab or other non-GitHub remote owns no GitHub `#N`, with
  // a known default or without, so it supplies no evidence and does not take Open PR away (plan §0).
  const noDefault = new Map<string, Set<string>>();
  // An omitted/unknown remote cannot prove a remaining remote unique. Its name stays private even here.
  let unknownReach = refs.some((r) => owner(r.ref) === undefined);
  let unknownDefaults = unknownReach;
  // A page with no commits asks nothing of any remote's history.
  const bound = shas.length === 0 ? [] : await walkBound(rg, result.remotes.length, windowStart);
  for (const remote of result.remotes) {
    const prefix = `refs/remotes/${remote.name}/`;
    const held = refs.filter((r) => owner(r.ref) === remote.name);
    const head = held.find((r) => r.ref === prefix + "HEAD");
    const def = head?.symref;
    if (def?.startsWith(prefix) && owner(def) === remote.name && held.some((r) => r.ref === def && r.symref === "")) {
      const name = def.slice(prefix.length);
      if (safeFactName(name) && await refFormatOk(rg, name)) remote.defaultBranch = name;
    }
    const tips = held.filter((r) => r.symref === "" && safeFactName(r.ref.slice(prefix.length))).map((r) => r.ref);
    try {
      // One walk for ALL requested commits on this remote, regardless of the size of commits[].
      const all = tips.length === 0 || shas.length === 0 ? new Set<string>() : new Set(lines(await gitOut(rg, ["rev-list", ...bound, "--end-of-options", ...tips], { maxBytes: LISTING_MAX_BYTES })));
      if ([...all].some((s) => !SHA40.test(s))) throw new Error("reach listing");
      for (const sha of shas) if (all.has(sha)) reached.get(sha)!.push(remote.name);
      if (remote.defaultBranch === null && remote.github !== null) noDefault.set(remote.name, all);
    } catch {
      unknownReach = true;
      if (remote.defaultBranch === null && remote.github !== null) unknownDefaults = true; // it may hold any evidence commit
    }
    if (remote.defaultBranch !== null && remote.github !== null && shas.length > 0) {
      try {
        // A separate batch proves PR evidence belongs to the default, rather than just any branch.
        const listing = new Set(lines(await gitOut(rg, ["rev-list", ...bound, "--end-of-options", prefix + remote.defaultBranch], { maxBytes: LISTING_MAX_BYTES })));
        if ([...listing].some((s) => !SHA40.test(s))) throw new Error("default listing");
        defaults.set(remote.name, listing);
      } catch { unknownDefaults = true; }
    }
  }
  result.reachableRemotes = shas.map((sha) => ({ sha, remotes: unknownReach ? null : reached.get(sha)! }));
  if (unknownDefaults) return result;
  result.prEvidence = [];
  if (defaults.size === 0 || shas.length === 0) return result;
  try {
    const scan = openScan(rg, windowStart, now);
    const merges = await scan.prMerges();
    const squashes = await scan.squashes();
    const record = (number: number, sha: string, remote: string, method: "merge" | "squash") => {
      if (!result.prEvidence!.some((e) => e.number === number && e.sha === sha && e.remote === remote && e.method === method)) {
        result.prEvidence!.push({ number, sha, remote, method });
      }
    };
    /** The evidence commit is on a default, so also list each no-default GitHub remote that holds it: Rust counts repositories. */
    const recordHolders = (number: number, sha: string, evidenceSha: string, method: "merge" | "squash") => {
      for (const [remote, holds] of noDefault) if (holds.has(evidenceSha)) record(number, sha, remote, method);
    };
    const add = (number: number, sha: string, evidenceSha: string, method: "merge" | "squash") => {
      if (!Number.isSafeInteger(number) || number < 1 || number > 4_294_967_295) return;
      let onAny = false;
      for (const [remote, onDefault] of defaults) {
        if (onDefault.has(evidenceSha)) { record(number, sha, remote, method); onAny = true; }
      }
      if (onAny) recordHolders(number, sha, evidenceSha, method);
    };
    for (const sha of shas) {
      // Match B1's nearest/oldest merge rule for each remote independently. A fork can retain both.
      for (const [remote, onDefault] of defaults) {
        const holding = merges.filter((m) => m.members.has(sha) && onDefault.has(m.sha));
        if (holding.length === 0) continue;
        const m = holding.reduce((a, b) => b.at < a.at || (b.at === a.at && b.order > a.order) ? b : a);
        if (m.number <= 4_294_967_295) {
          record(m.number, sha, remote, "merge");
          recordHolders(m.number, sha, m.sha, "merge");
        }
      }
      for (const s of squashes) if (s.sha === sha) add(s.number, sha, s.sha, "squash");
    }
    // B1's own matches: a second pass over every local branch would spend a fresh cap on branches no row names.
    for (const [ref, match] of squashed) {
      const members = new Set(await scan.own(ref));
      for (const sha of shas) if (sha === match.sha || members.has(sha)) add(match.number, sha, match.sha, "squash");
    }
  } catch { result.prEvidence = null; }
  return result;
}
