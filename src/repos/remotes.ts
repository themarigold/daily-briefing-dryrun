// B2-M1-T2: private, credential-free facts. All git reads retain B1's lead, clean env and caps.
import { lstat, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { branchWords } from "../recapCampaigns";
import { gitIn, HGIT_MAX_BYTES, LISTING_MAX_BYTES, type RepoGit } from "./hgit";
import { byteCmp } from "./groups";
import { repoKeyFor } from "./status";
import { pushTransport } from "./transport";
import type { RepoFacts } from "./types";

// Same control/format refusal table as engine::is_refused_format_character (not all Unicode Cf).
const REFUSED = /[\x00-\x1f\x7f-\x9f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\ufff9-\ufffb\u{e0001}\u{e0020}-\u{e007f}]/u;
export const safeFactName = (s: string): boolean => s !== "" && s !== "[redacted]" && !REFUSED.test(s) && branchWords(s) !== "[redacted]";
const safeRemoteName = (s: string): boolean => safeFactName(s) && !s.startsWith("-") && /^[A-Za-z0-9._/-]+$/.test(s);

/** Match source bytes, never a normalised URL path: dot segments, escapes and userinfo cannot vanish. */
export function parseGithub(raw: string): { owner: string; repo: string } | null {
  const m = /^(?:https:\/\/github\.com(?::443)?\/|git@github\.com:|ssh:\/\/git@github\.com(?::22)?\/|ssh:\/\/git@ssh\.github\.com:443\/)([^/]+)\/([^/]+)$/.exec(raw);
  if (!m) return null;
  const owner = m[1]!, repo = m[2]!.replace(/\.git$/, "");
  if (!/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9._-]{1,100}$/.test(repo) || repo === "." || repo === "..") return null;
  return safeFactName(owner) && safeFactName(repo) ? { owner, repo } : null;
}

/** A ref git already lists has passed its ref format, so of what `check-ref-format --branch` adds only a leading `-` and
 *  `HEAD` are left, and those need no spawn per ref: a repo's branch count must not cost the reply time. */
export const listedRefOk = (name: string): boolean => safeFactName(name) && !name.startsWith("-") && name !== "HEAD";

/** The --branch form takes no -- separator. Failures and exhausted budgets are always false. */
export async function refFormatOk(rg: RepoGit, branch: string): Promise<boolean> {
  if (!safeFactName(branch) || branch.startsWith("-")) return false;
  try { return (await gitIn(rg, ["check-ref-format", "--branch", branch])).code === 0; }
  catch { return false; }
}

/** git config -z separates each key/value with a newline, records with NUL; values may contain newlines. */
async function config(rg: RepoGit): Promise<Map<string, string[]> | null> {
  try {
    const r = await gitIn(rg, ["config", "--null", "--list"]);
    if (r.code !== 0 || (r.out !== "" && !r.out.endsWith("\0"))) return null;
    const answer = new Map<string, string[]>();
    for (const record of r.out.split("\0").slice(0, -1)) {
      const nl = record.indexOf("\n");
      const key = nl < 0 ? record : record.slice(0, nl);
      if (!key || !key.includes(".")) return null;
      const values = answer.get(key) ?? [];
      values.push(nl < 0 ? "" : record.slice(nl + 1));
      answer.set(key, values);
    }
    return answer;
  } catch { return null; }
}

/** Names only, no legacy URL/refspec content, and whether an entry's name was left out. A failed listing makes
 *  sole-remote counting unknown. */
async function legacyNames(rg: RepoGit, commonDir: string): Promise<{ names: string[]; omitted: boolean } | null> {
  const names = new Set<string>();
  let omitted = false;
  let bytes = 0;
  async function walk(dir: string, prefix: string): Promise<void> {
    if (rg.budget.callTimeoutMs() === undefined) throw new Error("budget");
    const st = await lstat(dir).catch((e: NodeJS.ErrnoException) => { if (e.code === "ENOENT") return null; throw e; });
    if (st === null) return;
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error("legacy directory");
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      bytes += Buffer.byteLength(entry.name);
      if (bytes > HGIT_MAX_BYTES || rg.budget.callTimeoutMs() === undefined) throw new Error("legacy cap");
      const name = prefix + entry.name;
      if (entry.isDirectory()) await walk(join(dir, entry.name), name + "/");
      else if (safeRemoteName(name)) names.add(name);
      else omitted = true;
    }
  }
  try {
    await walk(join(commonDir, "remotes"), "");
    await walk(join(commonDir, "branches"), "");
    return { names: [...names].sort(byteCmp), omitted };
  } catch { return null; }
}

/** Full private shape, with T3/T7 fields unavailable until their readers run. No raw URL is retained. */
export async function readRemoteFacts(rg: RepoGit, commonDir: string): Promise<RepoFacts> {
  const path = await realpath(rg.repo);
  if (!safeFactName(path)) throw new Error("unsafe repo path");
  const facts: RepoFacts = {
    repoKey: repoKeyFor(path), path, remotes: null, branches: null, pushDefault: null, pushesToUpstream: false,
    legacyNames: null, omittedRemotes: false, reachableRemotes: null, remoteBranches: null, prEvidence: null, roots: null, cardKeys: null, statInputs: null,
  };
  const cfg = await config(rg);
  if (cfg === null) return facts;
  const last = (key: string) => cfg.get(key)?.at(-1) ?? null;
  const pushMode = last("push.default");
  facts.pushesToUpstream = pushMode === "upstream" || pushMode === "tracking";
  const legacy = await legacyNames(rg, commonDir);
  facts.legacyNames = legacy?.names ?? null;
  facts.omittedRemotes = legacy?.omitted ?? false;
  const names = new Set<string>(facts.legacyNames ?? []);
  for (const k of cfg.keys()) {
    if (k.startsWith("remote.") && k.lastIndexOf(".") > "remote".length) {
      const n = k.slice("remote.".length, k.lastIndexOf("."));
      if (safeRemoteName(n)) names.add(n);
      else facts.omittedRemotes = true;
    }
  }
  const pushDefault = last("remote.pushdefault");
  const badDefault = pushDefault !== null && !safeRemoteName(pushDefault);
  if (pushDefault !== null && !badDefault) { facts.pushDefault = pushDefault; names.add(pushDefault); }
  try {
    const r = await gitIn(rg, ["for-each-ref", "--format=%(refname)%1f%(objectname)", "--end-of-options", "refs/heads/"], { maxBytes: LISTING_MAX_BYTES });
    if (r.code === 0) {
      facts.branches = [];
      for (const line of r.out.split("\n").filter(Boolean)) {
        const parts = line.split("\x1f");
        const ref = parts[0]!, objectName = parts[1];
        if (parts.length !== 2 || !ref.startsWith("refs/heads/")) { facts.branches = null; break; }
        const name = ref.slice("refs/heads/".length);
        const upstreamRemote = last(`branch.${name}.remote`);
        const merge = last(`branch.${name}.merge`);
        const upstreamBranch = merge?.startsWith("refs/heads/") ? merge.slice("refs/heads/".length) : merge;
        const pushRemote = last(`branch.${name}.pushremote`);
        const pointers = [upstreamRemote, pushRemote].filter((n) => n !== null);
        if (badDefault || !safeFactName(name) || (upstreamBranch !== null && !safeFactName(upstreamBranch)) || pointers.some((n) => !safeFactName(n))) continue;
        // A value that is only not a remote name, such as a URL, costs the branch its remote facts and nothing else. No part
        // of it crosses, and the nulls below mean unknown here, never "no upstream".
        const remoteFactsUnknown = pointers.some((n) => !safeRemoteName(n));
        if (!remoteFactsUnknown) for (const n of pointers) names.add(n);
        facts.branches.push({
          name, upstreamRemote: remoteFactsUnknown ? null : upstreamRemote, upstreamBranch: remoteFactsUnknown ? null : upstreamBranch,
          pushRemote: remoteFactsUnknown ? null : pushRemote, remoteFactsUnknown, checkoutPath: null, refFormatOk: listedRefOk(name), tip: /^[0-9a-f]{40}$/.test(objectName!) ? objectName! : null,
        });
      }
    }
  } catch { /* unavailable branch facts remove only their actions */ }
  facts.remotes = [];
  for (const name of [...names].sort(byteCmp)) {
    const prefix = `remote.${name}.`;
    const urls = cfg.get(prefix + "url");
    const vcs = cfg.has(prefix + "vcs");
    let destinations: string[] | null = null;
    try {
      const r = await gitIn(rg, ["remote", "get-url", "--push", "--all", "--", name]);
      if (r.code === 0) destinations = r.out.split("\n").filter(Boolean);
    } catch { /* unknown transport */ }
    facts.remotes.push({
      name, transport: pushTransport(destinations, vcs), github: urls?.length === 1 ? parseGithub(urls[0]!) : null,
      vcs, push: cfg.has(prefix + "push"), configSection: [...cfg.keys()].some((k) => k.startsWith(prefix)),
      url: urls !== undefined, legacy: facts.legacyNames === null ? null : facts.legacyNames.includes(name), defaultBranch: null,
    });
  }
  return facts;
}
