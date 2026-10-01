import { join, basename, normalize } from "node:path";
import { hasGitEntry, isDir, repoLabel, isExcludedRepo } from "./config";
import type { Config, Activity } from "./types";
import { redactCredentials } from "./transcripts/credentials";

// Infra paths (Claude Code's own agent-scratch dirs) are NOT the user's work. Filtered at the unit
// SOURCE here so a unit's dirtyFiles / hasResumptionState / resumptionNote are all infra-free — which
// keeps them out of the prompt AND the deterministic RESUME backfill (generator.orderResumeByRank).
// generator.ts imports this + still applies a post-parse SUGGESTIONS filter (defense in depth).
export const INFRA_DENYLIST = [".claude/worktrees/"];

export type Unit = {
  repo: string;
  root: string | null;              // repo-relative project root, or null = catch-all
  label: string;
  hasResumptionState: boolean;      // dirty files, OR (catch-all) actionable branch/stash → Tier-1 + RESUME-eligible
  hasWindowContent: boolean;        // had ≥1 in-window commit or uncommitted file → RECAP-eligible (false = same-day-only OR a branch/stash-only catch-all; RECAP skips it, RESUME/backfill key off hasResumptionState instead)
  resumptionNote: string;
  dirtyFiles: string[];
  latestCommitTime: string | null;
  /** Additive+optional (per this file's callers, which construct `Unit` literals in tests): the count
   *  of NON-EXCLUDED IN-WINDOW commits attributed to this unit. `commits`/`latestCommitTime` cannot
   *  answer this — `resolveUnits` accumulates over `[...activities, ...today]`, so they also carry
   *  SAME-DAY commits, and `hasWindowContent` is a boolean that an uncommitted file alone can set.
   *  Consumed by `postcheck.checkSuggestionVolume` (INFO diagnostic), which needs the magnitude, not
   *  the presence. Absent ⇒ read as 0 by consumers. */
  windowCommits?: number;
  /** IN-4 — `windowCommits`' SAME-DAY twin: the count of NON-EXCLUDED commits made TODAY (the `today`
   *  list `gitActivity` returns — the one "Today so far" is rendered from), attributed by the same
   *  `unitForCommit` vote as every other commit here, so it counts exactly the commit lines that unit
   *  shows under "Today so far" (the `🔀 Merged` lines there are a separate channel and are not
   *  commits). Excluded commits (`excludeCommitPatterns`, default `^vault backup:`) are skipped by the
   *  same `meta.excluded` gate `windowCommits` uses. Git-derived, never model prose. Consumed ONLY by
   *  `postcheck.checkSuggestionVolume`'s same-day leg (INFO diagnostic); never reaches the prompt.
   *  Additive+optional for the same reason as `windowCommits`; absent ⇒ read as 0.
   *  ⚠ "TODAY" IS BY COMMITTER DATE, inherited from "Today so far" (`gitActivity` splits its one list at
   *  local midnight on `%cI`): a morning rebase or amend re-stamps older work and moves it into this
   *  count, so an old commit rewritten today counts as same-day work here exactly as it shows there. */
  todayCommits?: number;
};

/** Deepest root that contains `path` on a segment boundary (repo-relative, forward-slash). */
export function rootOf(path: string, roots: string[]): string | null {
  let best: string | null = null;
  for (const r of roots) {
    if (path === r || path.startsWith(r + "/")) {
      if (best === null || r.length > best.length) best = r;
    }
  }
  return best;
}


// ─── The shared bucketer (design §3.2 steps 3–5) ────────────────────────────────────────────────
// The transcript side must compute the SAME `unitKey` the git side does for a given file, or ATTRIB
// fails silently. The git side already has (repo, repo-relative path) and uses `rootOf` + `unitKey`
// directly; the transcript side starts from an ABSOLUTE path and needs step 3 (repo selection)
// first. Both therefore end in the same two calls — that is the whole point of extracting this.

/** Normalise to forward slashes and drop any trailing separator. */
const normAbs = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "");

/** True when `abs` is `dir` itself or lies beneath it ON A SEPARATOR BOUNDARY (never a bare
 *  `startsWith`, which would match `/a/foobar` against `/a/foo`). */
const underDir = (abs: string, dir: string) => abs === dir || abs.startsWith(dir + "/");

/**
 * §3.2 step 3 — absolute path → the repo that owns it, or `null`.
 *
 * DEEPEST match wins: nested clones are supported (config.ts walks children even when the parent is
 * itself a repo), and a shallow match would attribute a nested repo's edits to its parent.
 *
 * ⚠ `excludedRepoPaths` must be RESOLVED ABSOLUTE PATHS, not raw `cfg.excludeRepos` entries.
 * `cfg.excludeRepos` also accepts a bare basename (`"nested"`), which cannot be matched as a path
 * prefix — so a basename-excluded NESTED repo would never become the deepest match and the path would
 * fall back to its surviving parent, which is exactly the mis-attribution Q2 forbids. `resolveRepos`
 * knows both forms at discovery time; resolving them is the CALLER's job.
 * (Verified by test: passing `["nested"]` here returns the parent — the bug this contract prevents.)
 */
export function repoForAbsolutePath(
  absPath: string, repos: string[], excludedRepoPaths?: string[],
): string | null {
  const abs = normAbs(absPath);
  const excludeRepos = excludedRepoPaths;
  const candidates = [...repos, ...(excludedRepoPaths ?? [])].map(normAbs);
  let best: string | null = null;
  for (const c of candidates) {
    if (!c || !underDir(abs, c)) continue;
    if (best === null || c.length > best.length) best = c;
  }
  if (best === null) return null;
  if (isExcludedRepo(best, excludeRepos)) return null;   // excluded winner ⇒ drop, never fall back
  return repos.map(normAbs).includes(best) ? best : null;
}

/**
 * §3.2 steps 3–5 — absolute path → `unitKey`, or `null` when the path lies under no configured repo
 * (or under an excluded one).
 *
 * ⚠ A path under a known repo but under no sub-root is NOT dropped: it buckets to that repo's
 * CATCH-ALL unit, `unitKey(repo, null)` — the only unit a repo without a workspace manifest ever has.
 * Dropping it would give every single-project repo zero coverage.
 */
export function unitKeyForAbsolutePath(
  absPath: string, repos: string[], rootsByRepo: Map<string, string[]>, excludedRepoPaths?: string[],
): string | null {
  const repo = repoForAbsolutePath(absPath, repos, excludedRepoPaths);
  if (repo === null) return null;
  const rel = normAbs(absPath).slice(repo.length + 1);   // "" when the path IS the repo root
  const root = rootOf(rel, rootsByRepo.get(repo) ?? []); // null ⇒ the repo catch-all unit
  return unitKey(repo, root);
}

const strip = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");

/** Expand root globs (repo-relative) to concrete directories with hygiene + `!`-negation. */
export async function expandRoots(repo: string, globs: string[]): Promise<string[]> {
  const positives = globs.filter((g) => !g.startsWith("!")).map(strip);
  const negatives = globs.filter((g) => g.startsWith("!")).map((g) => strip(g.slice(1)));
  const negGlobs = negatives.map((n) => new Bun.Glob(n));
  const out = new Set<string>();
  for (const g of positives) {
    for await (const m of new Bun.Glob(g).scan({ cwd: repo, onlyFiles: false })) {
      const rel = strip(m);
      // segment-wise skip: a recursive glob (packages/**) can surface node_modules/dotdirs at ANY depth
      if (rel.split("/").some((s) => s === "node_modules" || s.startsWith("."))) continue;
      if (!(await isDir(join(repo, rel)))) continue;
      if (await hasGitEntry(join(repo, rel))) continue;        // submodule/nested repo → its own repo
      if (negGlobs.some((ng) => ng.match(rel))) continue;      // `!`-negation postfilter
      out.add(rel);
    }
  }
  return [...out];
}

export type WorkspaceDetector = (repo: string) => Promise<string[] | null>;

async function readText(repo: string, name: string): Promise<string | null> {
  const f = Bun.file(join(repo, name));
  return (await f.exists()) ? f.text() : null;
}

export const detectJs: WorkspaceDetector = async (repo) => {
  const pkg = await readText(repo, "package.json");
  if (pkg) {
    const w = (JSON.parse(pkg) as any).workspaces;
    const globs = Array.isArray(w) ? w : w?.packages ?? null;
    if (Array.isArray(globs)) return globs.map(strip);
  }
  const pnpm = await readText(repo, "pnpm-workspace.yaml");
  if (pnpm) {
    const y = Bun.YAML.parse(pnpm) as any;
    if (Array.isArray(y?.packages)) return y.packages.map(strip);
  }
  const lerna = await readText(repo, "lerna.json");
  if (lerna) {
    const l = JSON.parse(lerna) as any;
    return (Array.isArray(l?.packages) ? l.packages : ["packages/*"]).map(strip);
  }
  return null;
};

export const detectRust: WorkspaceDetector = async (repo) => {
  const cargo = await readText(repo, "Cargo.toml");
  if (!cargo) return null;
  const ws = (Bun.TOML.parse(cargo) as any)?.workspace;
  if (!ws) return null;
  const members: string[] = Array.isArray(ws.members) ? ws.members.map(strip) : [];
  const exclude: string[] = Array.isArray(ws.exclude) ? ws.exclude.map((e: string) => "!" + strip(e)) : [];
  return [...members, ...exclude];
};

/** Parse go.work `use` directives. Returns repo-relative roots and any `../`-escaping paths. */
export function parseGoWork(text: string): { roots: string[]; escaped: string[] } {
  const roots: string[] = [], escaped: string[] = [];
  let inBlock = false;
  const add = (raw: string) => {
    let p = raw.trim().replace(/^["']|["']$/g, "");
    if (!p) return;
    p = strip(p);
    // repo-escape check on the RESOLVED path, not a naive startsWith("../")
    const np = normalize(p);
    if (np.startsWith("..")) { escaped.push(p); return; }
    roots.push(np); // push the NORMALIZED path (git-relative paths never contain ".." segments, so a raw "a/../b" would never match downstream)
  };
  for (let line of text.split("\n")) {
    line = line.replace(/\/\/.*$/, "").trim();               // strip line comments
    if (!line) continue;
    if (inBlock) { if (line === ")") { inBlock = false; continue; } add(line); continue; }
    if (line === "use (" || line === "use(") { inBlock = true; continue; }
    const m = line.match(/^use\s+(.+)$/);                     // only `use` (not replace/require)
    if (m) add(m[1]!);
  }
  return { roots, escaped };
}

// go.work is NOT a FAMILIES detector: resolveProjectRoots reads+parses it once inline (below) to
// derive both its roots and its escape warnings from a single parse. parseGoWork holds the logic.
const FAMILIES: WorkspaceDetector[][] = [[detectJs], [detectRust]];

export function repoLabelFor(repo: string, repos: string[]): string {
  return repoLabel(repo, repos);
}

export const unitKey = (repo: string, root: string | null) => `${repo}\x00${root ?? ""}`;

/** Two-pass global labeling with the 3-tier collision rule. */
export function labelUnits(pending: { repo: string; root: string | null }[], repos: string[]): Map<string, string> {
  // tier 1: base label (catch-all = bare repo label; sub-project = basename(root))
  const base = new Map<string, string>();
  for (const u of pending) {
    base.set(unitKey(u.repo, u.root), u.root === null ? repoLabelFor(u.repo, repos) : basename(u.root));
  }
  const count = new Map<string, number>();
  for (const l of base.values()) count.set(l, (count.get(l) ?? 0) + 1);
  // tier 2: qualify colliding SUB-PROJECT labels with the owning repo label (catch-all stays bare)
  const t2 = new Map<string, string>();
  for (const u of pending) {
    const k = unitKey(u.repo, u.root), l = base.get(k)!;
    t2.set(k, (u.root !== null && count.get(l)! > 1) ? `${repoLabelFor(u.repo, repos)}/${basename(u.root)}` : l);
  }
  const c2 = new Map<string, number>();
  for (const l of t2.values()) c2.set(l, (c2.get(l) ?? 0) + 1);
  // tier 3: still-colliding sub-projects → full repo-relative root path (unique within a repo)
  const final = new Map<string, string>();
  for (const u of pending) {
    const k = unitKey(u.repo, u.root), l = t2.get(k)!;
    final.set(k, (u.root !== null && c2.get(l)! > 1) ? `${repoLabelFor(u.repo, repos)}/${u.root}` : l);
  }
  return final;
}

export function unitForCommit(commit: Activity, roots: string[]): string | null {
  return unitForFiles(commit.meta?.diffstat?.map((d) => d.file) ?? [], roots);
}

/** The plurality-with-tie-guard vote, extracted verbatim from `unitForCommit` (T1.3): PR-merge
 *  labelling (core.ts mergeLabel) is a second consumer of the SAME decision-feeding attribution
 *  rule, and a silently divergent copy is exactly the day-8 class of misattribution. */
export function unitForFiles(files: string[], roots: string[]): string | null {
  const votes = new Map<string, number>();
  for (const f of files) { const r = rootOf(f, roots); if (r) votes.set(r, (votes.get(r) ?? 0) + 1); }
  if (votes.size === 0) return null;
  // Cross-cutting guard: attribute to the UNIQUE plurality root. If ≥2 roots tie for the top
  // vote, the files split evenly across sub-projects (e.g. a repo-wide/infra change like an
  // autolog STATE.md sync) — there is no clear owner, so it belongs to the repo catch-all (null), NOT an
  // arbitrary lexicographic pick (which caused the day-8 `accountant_ai` misattribution of `8b4e2b9`).
  const maxN = Math.max(...votes.values());
  const winners = [...votes].filter(([, n]) => n === maxN).map(([r]) => r);
  return winners.length === 1 ? winners[0]! : null;
}

/** One stash, as `resolveUnits` accumulates it from the git.ts stash Activity: `text` is the
 *  reconstructed `stash@{N}: <%gs>` line (so it carries the BRANCH and the MESSAGE — "WIP on
 *  <branch>: <sha> <subject>"), `timestamp` the stash's own commit date. */
export type StashNote = { text: string; timestamp?: string };

// Bounded like every other delivery-path list: detail for the first STASH_NOTES_SHOWN stashes
// (git stash list order — newest first), a count for the rest. 2 because a briefing stash line is
// resumption context, not an inventory; a 9-stash hoarder's tail is noise the count still records.
export const STASH_NOTES_SHOWN = 2;
const STASH_TEXT_CLIP = 80;

export function composeResumptionNote(i: { files: string[]; ahead: number; behind: number; stashes: StashNote[]; detached: boolean }): string {
  const ab = [i.ahead > 0 ? `ahead ${i.ahead}` : "", i.behind > 0 ? `behind ${i.behind}` : ""].filter(Boolean).join(", ");
  // Day-44 + day-47 judges (user-approved 2026-09-01): "1 stash(es)" dropped the branch and message
  // that were the day-47 clue to an orphaned lane. The stash Activity already carried both; only the
  // count survived to this line. Now each shown stash renders its own `%gs` text — branch, message —
  // plus its date (age). Bounds: each stash TEXT is clipped to STASH_TEXT_CLIP chars, so the whole
  // stash contribution is at most STASH_NOTES_SHOWN clipped segments plus a count — bounded by
  // arithmetic, not by a separate line cap. (The date renders in the RUNTIME's timezone, like
  // core.ts's merge dates — a reader-local age cue, so it can differ from the stash's own zone.)
  //
  // Stash text is user-authored and reaches the delivered briefing verbatim through the
  // deterministic RESUME backfill — the same trust class as commit subjects and dirty file names,
  // which already flow to the briefing unmodified, so no new sanitization boundary is crossed here.
  // ⚠ …EXCEPT the clip itself: it REDACTS FIRST (postcheck.ts's `clip` rule). A credential the clip
  // cut in half no longer matches `redactCredentials`, so the output-side redaction let its prefix
  // through. Pinned in test/clip-redacts-first.test.ts.
  const clip = (raw: string) => {
    const s = redactCredentials(raw);
    return s.length <= STASH_TEXT_CLIP ? s : `${s.slice(0, STASH_TEXT_CLIP - 1)}…`;
  };
  const shortDate = (iso?: string): string | undefined => {
    if (!iso) return undefined;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? undefined : d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  };
  const shown = i.stashes.slice(0, STASH_NOTES_SHOWN).map((s) => {
    const d = shortDate(s.timestamp);
    // A blank text must not yield a contentless " (Aug 27)" clause (unreachable from git.ts, whose
    // text is always ≥ "stash: ", but reduce.ts contemplates non-git producers): fall back to the
    // word the count-era line used.
    return `${clip(s.text.trim()) || "stash"}${d ? ` (${d})` : ""}`;
  });
  const rest = i.stashes.length - shown.length;
  return [
    i.files.length ? `uncommitted: ${i.files.join(", ")}` : "",
    ab,
    ...shown,
    rest > 0 ? `+${rest} more stash(es)` : "",
    i.detached ? "detached HEAD" : "",
  ].filter(Boolean).join("; ");
}

export async function resolveUnits(
  activities: Activity[], today: Activity[], repos: string[], cfg: Config,
): Promise<{ units: Unit[]; warnings: string[]; rootsByRepo: Map<string, string[]> }> {
  const all = [...activities, ...today];
  const warnings: string[] = [];
  const byRepo = new Map<string, Activity[]>();
  for (const a of all) if (a.repo) (byRepo.get(a.repo) ?? byRepo.set(a.repo, []).get(a.repo)!).push(a);
  // The FULL candidate root set resolveProjectRoots produced per repo (before survivor filtering) —
  // threaded out so buildPrompt/main.ts bucket against the SAME roots resolveUnits used, not the
  // survivor subset (rootsForRepo), which can diverge for nested project roots.
  const rootsByRepo = new Map<string, string[]>();

  type Acc = {
    root: string | null; commits: Activity[]; dirtyFiles: string[];
    ahead: number; behind: number; stashes: StashNote[]; detached: boolean;
    sawWindowContent: boolean; // commit/uncommitted in `activities` (not today-only)
    windowCommits: number;     // COUNT of non-excluded in-window commits (magnitude, not presence)
    todayCommits: number;      // COUNT of non-excluded SAME-DAY commits (IN-4 — the S3 same-day leg)
  };
  const windowSet = new Set(activities);
  const todaySet = new Set(today);
  const pending: { repo: string; root: string | null }[] = [];
  const accs = new Map<string, Acc>(); // key = unitKey

  const acc = (repo: string, root: string | null): Acc => {
    const k = unitKey(repo, root);
    let a = accs.get(k);
    if (!a) { a = { root, commits: [], dirtyFiles: [], ahead: 0, behind: 0, stashes: [], detached: false, sawWindowContent: false, windowCommits: 0, todayCommits: 0 }; accs.set(k, a); pending.push({ repo, root }); }
    return a;
  };

  for (const [repo, acts] of byRepo) {
    const { roots, warnings: w } = await resolveProjectRoots(repo, cfg);
    warnings.push(...w);
    rootsByRepo.set(repo, roots);
    for (const a of acts) {
      if (a.kind === "commit") {
        const root = unitForCommit(a, roots);
        const u = acc(repo, root);
        // An `excluded` commit VOTES for the root and counts as window content, but never joins
        // `commits` — that array feeds `latestCommitTime` (the sole recency key in `rankUnits`) and
        // `isActive`. Keeping it out means an excluded-only unit is not active, so it never reaches
        // `survivors`/`labelUnits` either, and existing users' labels and RESUME order are untouched.
        if (!a.meta?.excluded) u.commits.push(a);
        if (windowSet.has(a)) u.sawWindowContent = true;
        // ⚠ BOTH gates, and they are different questions. `sawWindowContent` says "this unit had
        // in-window content at all" and an EXCLUDED (bot/auto) commit legitimately sets it — that
        // flag guards RECAP eligibility. `windowCommits` is the volume of the user's OWN work, which
        // is what the suggestion-floor diagnostic measures, so a bot-commit-only unit must count 0.
        if (windowSet.has(a) && !a.meta?.excluded) u.windowCommits++;
        // The same gate, over the SAME-DAY list: an excluded (bot/auto) commit is not the user's work
        // on either side of midnight.
        if (todaySet.has(a) && !a.meta?.excluded) u.todayCommits++;
      } else if (a.kind === "uncommitted") {
        const files = a.meta?.uncommittedFiles ?? [];
        const byRoot = new Map<string | null, string[]>();
        for (const f of files) { const r = rootOf(f, roots); (byRoot.get(r) ?? byRoot.set(r, []).get(r)!).push(f); }
        for (const [r, fs] of byRoot) {
          const kept = fs.filter((f) => !INFRA_DENYLIST.some((d) => f.includes(d))); // drop agent-scratch paths (#14)
          if (!kept.length) continue; // an infra-only uncommitted set is not real work → no unit/window-content
          const u = acc(repo, r); u.dirtyFiles.push(...kept); u.sawWindowContent = true;
        }
      } else if (a.kind === "branch") {
        const u = acc(repo, null);
        u.ahead = a.meta?.aheadBehind?.ahead ?? 0; u.behind = a.meta?.aheadBehind?.behind ?? 0;
        if (a.target === "HEAD") u.detached = true;
      } else if (a.kind === "stash") {
        // The Activity's text is git.ts's reconstructed `stash@{N}: <%gs>` line — branch + message —
        // and its timestamp the stash's own date. Both survive into the resume note now (day 44+47).
        acc(repo, null).stashes.push({ text: a.text ?? "", timestamp: a.timestamp });
      }
    }
  }

  // Unknown-repo warning (spec §4.1): a subprojects entry naming a repo not in the resolved set.
  for (const s of cfg.subprojects ?? []) if (!repos.includes(s.repo)) warnings.push(`[${s.repo}] subprojects entry names a repo not in the resolved repo set — ignored`);

  // FILTER FIRST, then label — labelUnits must see ONLY the units that will actually be rendered,
  // else a dropped idle/would-be sibling inflates the collision count and over-qualifies a survivor.
  // We do NOT drop same-day-only-clean units here: they are rendered in "Today so far" and need a
  // label. They are excluded from RECAP/RESUME at render time via `hasWindowContent` (below).
  const isoMs = (t: string) => new Date(t).getTime();
  const survivors = pending.map(({ repo, root }) => {
    const a = accs.get(unitKey(repo, root))!;
    const hasResumptionState = a.dirtyFiles.length > 0 || (root === null && (a.ahead > 0 || a.behind > 0 || a.stashes.length > 0 || a.detached));
    return { repo, root, a, hasResumptionState, isActive: a.commits.length > 0 || hasResumptionState };
  }).filter((s) => s.isActive);                                // idle branch-only (ahead 0/behind 0, clean) → dropped

  const labels = labelUnits(survivors.map(({ repo, root }) => ({ repo, root })), repos);
  const units: Unit[] = survivors.map(({ repo, root, a, hasResumptionState }) => {
    const times = a.commits.map((c) => c.timestamp).filter((t): t is string => !!t);
    return {
      repo, root, label: labels.get(unitKey(repo, root))!,
      hasResumptionState,
      hasWindowContent: a.sawWindowContent,                    // recap/resume-eligible only if it had in-window content
      resumptionNote: composeResumptionNote({ files: a.dirtyFiles, ahead: a.ahead, behind: a.behind, stashes: a.stashes, detached: a.detached }),
      dirtyFiles: a.dirtyFiles,
      windowCommits: a.windowCommits,
      todayCommits: a.todayCommits,
      // compare by epoch ms, NOT lexicographically — %cI keeps the LOCAL offset, so string order ≠ chronological order
      latestCommitTime: times.length ? times.reduce((m, t) => isoMs(t) > isoMs(m) ? t : m) : null,
    };
  });
  return { units, warnings, rootsByRepo };
}

export function rankUnits(units: Unit[]): Unit[] {
  const ms = (t: string | null) => t ? new Date(t).getTime() : -Infinity;
  return [...units].sort((x, y) => {
    if (x.hasResumptionState !== y.hasResumptionState) return x.hasResumptionState ? -1 : 1;
    if (ms(x.latestCommitTime) !== ms(y.latestCommitTime)) return ms(y.latestCommitTime) - ms(x.latestCommitTime); // newer first
    return x.label < y.label ? -1 : x.label > y.label ? 1 : 0; // lexicographic label tie-break (valid 3-way comparator)
  });
}

/**
 * The SUB-PROJECT LABEL LEGEND — one group per parent repo, each listing the sub-project labels that
 * are AREAS OF that repo rather than peer repos.
 *
 * ⚠ WHY THIS EXISTS (measured 3 mornings — judge days 41, 43, 44). A sub-project unit's label is the
 * root's BASENAME (`labelUnits` tier 1), so `[accountant_ai]` and `[personal_code]` render as
 * indistinguishable peers even though the first is a FOLDER INSIDE the second. On day 44 the briefing
 * said "[personal_code] no window work pending" while 36 commits had landed in that same git repo
 * under sibling labels — literally true per-unit, and read as repo-idle. Nothing in the rendered
 * artifact carried the containment relation; only `Unit.root` did, two layers upstream.
 *
 * ⚠ EMPTY IS THE COMMON CASE AND MUST STAY FREE. A repo with no `subprojects` config (and no detected
 * workspace) has only its catch-all unit, `root === null`, so this returns `[]` and the renderer emits
 * NOTHING — the single-project install's briefing is byte-identical to before. Pinned by test.
 *
 * Deterministic: labels de-duplicated and sorted within a group, groups sorted by parent repo label.
 * `units` arrives in `resolveUnits` accumulation order (activity order), which is not stable input.
 */
export type LabelLegendGroup = { repo: string; labels: string[] };

/**
 * THE LEGEND LINE'S STRUCTURAL PREFIX — ONE definition, imported by BOTH sides.
 *
 * ⚠ IT HAS A SECOND READER, AND THAT READER IS AN EVAL FLAG. `render.ts` WRITES lines starting with
 * this marker; `audit.coverageGaps` EXCLUDES them from its haystack. Without that exclusion the
 * legend — which by construction names every sub-project label AND its parent repo label — makes
 * `coverageGaps` vacuous for any repo with ≥1 sub-project unit, so `UNCOMMITTED NOT SURFACED` (EVAL
 * days 16 and 25 turn on it) can never fire again. MEASURED on a probe: 1 gap before the legend, 0
 * after.
 *
 * ⚠ ONE CONSTANT, NOT TWO LITERALS, because the two sides must be changed together or the flag
 * silently dies — the writer would emit a line the excluder no longer recognises and nothing would
 * fail. Same reasoning as `norm` (re-exported rather than re-spelled) and `doneSubjectAsShown`
 * (postcheck.ts), both of which this codebase extracted after the two copies had ALREADY drifted.
 * Defined here rather than in render.ts because `audit.ts` already imports this module and does not
 * import render.ts — this is the placement with no cycle.
 *
 * ⚠ SCOPED TO THE LEGEND, DELIBERATELY. Do NOT generalise this into "exclude all code-built
 * scaffolding": dropping the merge or outage lines would CREATE gaps that do not fire today, which
 * is the same eval-metric change in the opposite direction and equally an operator decision.
 */
export const LEGEND_PREFIX = "   (labels: ";

/** Prefix of the RECAP-COVERAGE drop lines (`recapCoverage`, EVAL day 49): the in-window commits no
 *  recap bullet accounts for, rendered under the "What you did" header.
 *
 *  ⚠ SHARED WITH `audit.coverageGaps` FOR EXACTLY THE REASON THE LEGEND ABOVE IS, and it is the same
 *  eval-flag guard, not a formatting nicety. Those lines carry `[label]` — and, because a subject
 *  usually carries its own lane name, they name the lane even with the bracket removed. MEASURED at
 *  271 of 2323 subjects — `git log --all --format=%s | grep -cE '(accountant_ai|quant_stocks|quant_options|daily_briefing_application|ai_news|comms_briefing)'` —
 *  248 of those in conventional-scope form. The command is recorded rather than just its result
 *  because the count drifts as commits land, and an earlier draft of this note quoted a figure that
 *  reproduced under no basis the verify round could find. Left in the haystack they make the briefing
 *  "name" a repo purely by reporting that one of its commits was OMITTED, which is the opposite of
 *  surfacing its working state, and `UNCOMMITTED NOT SURFACED` gets suppressed by a line that says
 *  nothing about uncommitted work.
 *
 *  ⚠ ONE CONSTANT, NOT TWO LITERALS — same rule as `LEGEND_PREFIX`: the writer and the excluder must
 *  move together or the flag silently dies, with nothing failing to announce it.
 *
 *  User-directed 2026-09-03: the exclusion is an eval-metric change and was authorised explicitly
 *  after the alternatives were measured. Dropping the label does NOT avoid the haystack (the subject
 *  scope still matches), and moving the whole report into the audit would have ADDED a counted line
 *  on most mornings, breaking flag-count comparability across the EVAL series — this option changes
 *  no flag on a normal morning and only prevents a new suppression. */
export const NOT_SHOWN_PREFIX = "     \u00b7 ";

/** Prefix of the VERDICT-PATH MARKER line (IN-2, EVAL days 51/52): rendered directly under a
 *  suggestion that cites a commit touching an operator-configured verdict path (`Config.verdictPaths`).
 *
 *  ⚠ THE THIRD MEMBER OF THE SAME EVAL-FLAG GUARD, EXCLUDED FROM `audit.coverageGaps` BEFORE IT EVER
 *  RENDERED — the lesson of #399's legend review applied in advance, as `generator.ts` records doing
 *  once already for the truncation warning. The marker's body is a fixed sentence (render.ts) that
 *  names no configured repo today, so on this workspace's own labels the exclusion changes nothing.
 *  It is not decoration: sub-project labels are folder BASENAMES, and any label that is also a word of
 *  that sentence (`gate`, `path`, `verdict`, `commit`) would be "named" by the marker alone — clearing
 *  `UNCOMMITTED NOT SURFACED` for a repo the briefing never surfaced, on precisely the morning it
 *  marked a verdict-path suggestion. And the day someone makes the marker name the matched path (the
 *  obvious enhancement), that path IS a lane label.
 *
 *  ⚠ ONE CONSTANT, NOT TWO LITERALS — same rule as the two above. The Phase-C comparability boundary
 *  declared in EVAL.md (2026-09-17, user-directed) holds the auto-audit deterministic flag count
 *  comparable across IN-2 ONLY on the condition that this prefix is a shared constant excluded from
 *  that haystack; the exclusion was specified by the completion-build design appendix (IN-2,
 *  constraint c) before the build, so it is user-directed, not a refactor's choice.
 *
 *  Distinct from every other structural prefix at its first differing byte (`     ·` drop lines,
 *  `      ◦` cluster members, `   •` bullets), so neither excluder can swallow the other's lines. */
export const VERDICT_MARKER_PREFIX = "     \u2691 ";

export function subprojectLegend(units: Unit[], repos: string[]): LabelLegendGroup[] {
  // ⚠ KEYED BY THE REPO PATH, WHICH IS INJECTIVE — NOT by `repoLabelFor`, which is NOT. Two
  // configured repos can label identically (`/a/api` and `/b/api`); this module's own `labelUnits`
  // exists because of that collision class, and `audit.ts` and `eval/echo.ts` each document the same
  // hazard. Keying by label would MERGE two distinct repos into one group whose line then asserts a
  // containment that is false for half its labels — a fabricated claim in a document whose entire
  // purpose is to stop the reader mis-attributing labels. Two same-labelled repos yield two groups.
  const byRepo = new Map<string, Set<string>>();
  for (const u of units) {
    if (u.root === null) continue;                       // catch-all unit IS the repo — nothing to explain
    // A tier-2/3 qualified label already spells its parent (`personal_code/foo`); listing it is still
    // correct and keeps the rule one line rather than a special case — the group header repeats the
    // repo, which is the fact the reader is missing either way.
    let s = byRepo.get(u.repo);
    if (!s) byRepo.set(u.repo, (s = new Set()));
    s.add(u.label);
  }
  // Label resolved at OUTPUT, after grouping. Sort by rendered label, then by path so two
  // same-labelled repos still order deterministically rather than by activity order.
  return [...byRepo]
    .map(([path, labels]) => ({ path, repo: repoLabelFor(path, repos), labels: [...labels].sort() }))
    .sort((a, z) => (a.repo < z.repo ? -1 : a.repo > z.repo ? 1 : a.path < z.path ? -1 : a.path > z.path ? 1 : 0))
    .map(({ repo, labels }) => ({ repo, labels }));
}

/** Shared helper (imported by generator.ts and main.ts): the repo's project roots that survived into `units`. */
export const rootsForRepo = (units: Unit[], repo: string): string[] =>
  units.filter((u) => u.repo === repo && u.root !== null).map((u) => u.root!);

export async function resolveProjectRoots(repo: string, cfg: Config): Promise<{ roots: string[]; warnings: string[] }> {
  const warnings: string[] = [];
  const entry = cfg.subprojects?.find((s) => s.repo === repo);
  // Explicit-config branch gets its OWN try/catch — a failure here is the user's config, not "detection".
  if (entry) {
    if (entry.roots.length === 0) return { roots: [], warnings }; // intentional single-unit
    try {
      const roots = await expandRoots(repo, entry.roots);
      if (roots.length === 0) warnings.push(`[${repo}] subprojects roots ${JSON.stringify(entry.roots)} resolved to zero directories`);
      // ⚠ A PARTIALLY dead list used to be silent forever, because the all-or-nothing check above is
      // the only one there was. Found in review 2026-08-14: this repo's 8 configured roots expand to
      // 7 — `quant_options` is a planned sub-project with no folder yet — and nothing said so. A typo
      // ("acountant_ai") is INDISTINGUISHABLE from that, and its whole sub-project silently keeps
      // rendering under the catch-all label, which is the exact defect the config exists to fix.
      // Only LITERAL roots are checked: a glob legitimately matching nothing today is not a mistake,
      // and re-scanning per glob to find out would cost a filesystem walk each.
      const isLiteral = (g: string) => !/[*?[\]]/.test(g) && !g.startsWith("!");
      for (const g of entry.roots.filter(isLiteral)) {
        if (!roots.includes(g.replace(/\/+$/, ""))) {
          warnings.push(`[${repo}] subprojects root "${g}" matched no directory — typo, or a project not scaffolded yet? Its commits will fall to the catch-all label.`);
        }
      }
      return { roots, warnings };
    } catch (e) {
      warnings.push(`[${repo}] subprojects config failed to expand (${(e as Error).message})`);
      return { roots: [], warnings };
    }
  }
  try {
    // detection: union across families, first-non-null within a family
    const globs: string[] = [];
    for (const family of FAMILIES) {
      for (const detect of family) {
        const found = await detect(repo);
        if (found) { globs.push(...found); break; }
      }
    }
    // go.work: ONE read + ONE parse for both its roots and its escape warnings. Handled before the
    // zero-globs early return so a go.work whose ONLY `use` dirs escape the repo yields zero net
    // globs but still warns.
    const goworkText = await readText(repo, "go.work");
    if (goworkText) {
      const { roots: goRoots, escaped } = parseGoWork(goworkText);
      globs.push(...goRoots);
      for (const esc of escaped) warnings.push(`[${repo}] go.work 'use ${esc}' resolves outside the repo — skipped`);
    }
    if (globs.length === 0) return { roots: [], warnings };
    const roots = await expandRoots(repo, globs);
    if (roots.length === 0) warnings.push(`[${repo}] detected a workspace manifest but its roots resolved to zero directories`);
    return { roots, warnings };
  } catch (e) {
    warnings.push(`[${repo}] workspace detection failed (${(e as Error).message}) — treated as single project`);
    return { roots: [], warnings };
  }
}

// LABEL IDENTITY — the single definition. Strip markdown emphasis/code decoration (`**app**`,
// `*app*`, `` `app` ``) BEFORE trimming trailing punctuation, so a model bullet labeled `**app**`
// still matches the ranked unit `app` — otherwise it is both tail-preserved AND backfilled, yielding
// duplicate, contradictory resume lines. (Underscores are left alone — they're common in real
// repo/dir names, and both sides normalize identically.)
//
// ⚠ IT LIVES HERE, not in generator.ts, because a FOURTH consumer proved the old home unreachable.
// `orderResumeByRank`, the eval judge's `g1Attribution`, `render.ts` and `core.ts` all import it from
// `generator` — but `generator` imports `postcheck`, so `postcheck` could not import back without a
// cycle. It therefore grew its OWN weaker copy (`toLowerCase().trim()`, no decoration strip), and
// `checkResumeFreshness` silently returned ZERO findings for any decorated label — a false negative
// in the one check whose job is catching silent failures. MEASURED 2026-08-10: `[accountant_ai]` → 1
// finding, `[**accountant_ai**]` → 0. `subprojects` imports only `config`/`types`, so every consumer
// including `postcheck` can reach it. `generator` re-exports it so existing importers are unchanged.
export const norm = (s: string) => s.toLowerCase().replace(/[*`]/g, "").trim().replace(/[.,;:!?]+$/, "");

/** Builds the "is this label MENTIONED in this text" matcher — the one definition, for the two
 *  places that must ask it of free-form text: `checkSuggestionVolume` (postcheck) and `coverageGaps`
 *  (audit). It lives here because both already import this module and `subprojects` imports only
 *  `config`/`types`, so neither can cycle — the same reasoning `norm` above records.
 *
 *  ⚠ EXTRACTED AT TWO COPIES, NOT THREE, BECAUSE THEY HAD ALREADY DIVERGED AND ONE WAS WRONG.
 *  `coverageGaps` matched with `\b`; `checkSuggestionVolume` was fixed to explicit lookarounds on
 *  2026-08-29 after `\b` was measured broken. Both feed reader-visible judgements — `coverageGaps`
 *  produces the COUNTED `UNCOMMITTED NOT SURFACED` audit flag — so a silent divergence between them
 *  is a correctness bug, not a style difference.
 *
 *  ⚠ BOUNDARIES ARE EXPLICIT LOOKAROUNDS, NOT `\b`, AND THE REASON IS SHARPER THAN "\b IS TOO WEAK".
 *  `\b` is a TRANSITION between a word and a non-word character. At an edge where the LABEL's own
 *  first/last character is already non-word, `\b` therefore does not relax — it INVERTS, demanding a
 *  word character on the other side of that edge. Both directions are wrong, and both are measured:
 *      /\bc\+\+\b/.test("touch c++ bindings")  → false   (false NEGATIVE — the documented half)
 *      /\bc\+\+\b/.test("c++abc")              → TRUE    (false POSITIVE — the undocumented half)
 *  So the old form could both invent a coverage gap and suppress a real one. Labels are folder
 *  basenames, where `c++`, `f#`, `.config` and `-lib` are all legal.
 *      (NOT `v1.2` — its edges are `v` and `2`, both word characters, so `\b` handles it perfectly
 *      well. `v1.2` needs ESCAPING, not boundaries; the two problems are separate and were conflated
 *      twice during this change. Escaping is covered below.)
 *  Asserting "no word character adjacent" says what is actually meant and is correct at both edges.
 *
 *  ⚠ AND `\b` IS ASCII-WORD-BASED EVEN UNDER `/u`, so it breaks on non-Latin text in BOTH roles:
 *      /\bapi\b/u.test("обapiсь")   → TRUE   (matches INSIDE a word — a repo counted as named)
 *      /\bcafé\b/.test("the café")  → false  (a non-ASCII LETTER at the label's edge is treated as
 *                                             an edge, so the same inversion as the punctuation case)
 *  `\p{L}\p{N}_` classes are used instead, so a repo with non-Latin folder names behaves the same as
 *  an ASCII one.
 *
 *  ⚠⚠ `_` IS IN THE CLASS DELIBERATELY AND IS THE SINGLE MOST LOAD-BEARING CHARACTER HERE — DO NOT
 *  "TIDY" IT OUT TO MATCH `contentTokens`. `contentTokens` (postcheck) strips `_` as a SEPARATOR
 *  before splitting; this rule treats it as a WORD character. They differ on purpose. Dropping it
 *  would make `daily_briefing` match inside `daily_briefing_application` — both are live labels in
 *  the author's own deployment — so any mention of the longer one would silently mark the shorter
 *  one covered. MEASURED against 11 days of real production briefings: that edit flips the coverage
 *  answer on 85 lines across 7 of those 11 days, suppressing the counted flag. Pinned by test.
 *
 *  Metacharacters are escaped: unescaped `v1.2` would match `v1x2`.
 *
 *  An empty or whitespace-only label yields a NEVER-matching regex rather than a match-everything
 *  one: the lookarounds around an empty pattern are satisfiable almost anywhere, which would mark
 *  every repo covered and suppress the flag wholesale. `checkSuggestionVolume` guards this itself;
 *  `coverageGaps` does not, so the guard belongs in the one shared definition.
 *
 *  MEASURED when the two were unified (2026-08-30): across this deployment's ten real labels and
 *  eight sample texts, `\b` and the lookarounds differ on ZERO pairs — every difference is a
 *  punctuation-edged or non-Latin label that does not exist here yet. This is a latent-defect fix,
 *  not a live change to any flag count.
 *
 *  The CALLER still owns normalisation (`norm` in postcheck, `toLowerCase` in audit): the two
 *  channels normalise differently for their own reasons, and unifying that is a separate decision.
 *  This function is the boundary rule only. */
export function labelBoundary(label: string): RegExp {
  if (label.trim() === "") return /(?!)/u;   // never matches — see the empty-label note above
  const esc = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\p{L}\\p{N}_])${esc}(?![\\p{L}\\p{N}_])`, "u");
}
