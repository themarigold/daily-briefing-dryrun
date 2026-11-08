import "./fixtures/isolate-state";
import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, readFileSync, writeFileSync, symlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { startGitBudget } from "../src/git";
import { hardenArgs } from "../src/repos/harden";
import { readRemoteFacts } from "../src/repos/remotes";
import { readReachFacts, REMOTE_BRANCHES_CAP } from "../src/repos/reach";
import { readCheckoutFacts, projectKey } from "../src/repos/checkouts";
import { reposStatus } from "../src/repos/status";
import type { SquashMatch } from "../src/repos/groups";
import { scratch, g, gRaw, commitAt, gitEnv } from "./fixtures/repos-fixtures";

const projectVectors: { repo: string; root: string; project: string }[] =
  JSON.parse(readFileSync(new URL("../gui/src-tauri/tests/fixtures/project-key-vectors.json", import.meta.url), "utf8"));

const date = (d: number) => `2026-01-${String(d).padStart(2, "0")}T10:00:00Z`;
async function setup(fn: (fx: { root: string; repo: string; env: Record<string, string>; base: string }, spy: ReturnType<typeof gitEnv>) => Promise<void>, substitute?: (a: string[]) => string[] | undefined) {
  const root = realpathSync(scratch("reach")), repo = join(root, "repo");
  const env = { HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg"), GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com" };
  for (const d of [repo, env.HOME, env.XDG_CONFIG_HOME]) mkdirSync(d);
  writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\nname = Test\nemail = test@example.com\n");
  await g(repo, ["init", "-q", "-b", "main"], env);
  const base = await commitAt(repo, env, { "apps/gui/base": "base\n" }, "base", date(2));
  await g(repo, ["remote", "add", "origin", "https://github.com/org/repo"], env);
  const prev = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = env.HOME;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  const spy = gitEnv({ HOME: env.HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: "1" }, substitute);
  try { await fn({ root, repo, env, base }, spy); } finally {
    spy.restore();
    process.env.HOME = prev.HOME;
    process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME!;
  }
}
async function ctx(repo: string) {
  const budget = startGitBudget(60_000);
  const h = await hardenArgs(repo, budget, { lazyFetch: true });
  if ("unknown" in h) throw new Error(h.unknown);
  return { rg: { repo, lead: h.lead, budget }, commonDir: h.commonDir };
}
async function reach(repo: string, shas: string[], squashed: ReadonlyMap<string, SquashMatch> = new Map()) {
  const { rg, commonDir } = await ctx(repo);
  return readReachFacts(rg, await readRemoteFacts(rg, commonDir), shas, new Date("2026-01-01T00:00:00Z"), new Date("2026-02-01T00:00:00Z"), squashed);
}

test("partly pushed branch: per-commit reachability in one batch per remote, never per commit", async () => {
  await setup(async ({ root, repo, env, base }, spy) => {
    await g(repo, ["checkout", "-q", "-b", "feature/slash"], env);
    const pushed = await commitAt(repo, env, { "p": "p\n" }, "pushed", date(3));
    const local = await commitAt(repo, env, { "l": "l\n" }, "local", date(4));
    await g(repo, ["update-ref", "refs/remotes/origin/main", base], env);
    await g(repo, ["update-ref", "refs/remotes/origin/feature/slash", pushed], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
    const f = await reach(repo, [base, pushed, local]);
    expect(f.reachableRemotes).toEqual([{ sha: base, remotes: ["origin"] }, { sha: pushed, remotes: ["origin"] }, { sha: local, remotes: [] }]);
    const batches = spy.calls.filter((a) => a.includes("rev-list") && a.includes("refs/remotes/origin/feature/slash"));
    expect(batches.length).toBe(1);
    const boundary = batches[0]!.indexOf("--end-of-options");
    expect(boundary).toBeGreaterThan(-1);
    expect(batches[0]!.slice(boundary + 1).every((r) => r.startsWith("refs/remotes/origin/"))).toBe(true);
  });
});

for (const method of ["merge", "squash"] as const) test(`${method} PR evidence is per remote: synced fork stays ambiguous; local-only evidence is excluded`, async () => {
  await setup(async ({ root, repo, env, base }) => {
    await g(repo, ["checkout", "-q", "-b", "work"], env);
    const work = await commitAt(repo, env, { "work": "done\n" }, "work", date(3));
    await g(repo, ["checkout", "-q", "main"], env);
    if (method === "merge") await g(repo, ["merge", "-q", "--no-ff", "-m", "Merge pull request #17 from org/work", "work"], env, { GIT_AUTHOR_DATE: date(4), GIT_COMMITTER_DATE: date(4) });
    else await commitAt(repo, env, { "work": "done\n" }, "Work (#17)", date(4));
    const merged = (await g(repo, ["rev-parse", "HEAD"], env)).trim();
    for (const [remote, def] of [["origin", "main"], ["team/fork", "release/1"]]) {
      if (remote !== "origin") await g(repo, ["remote", "add", remote!, "https://github.com/fork/repo"], env);
      await g(repo, ["update-ref", `refs/remotes/${remote}/${def}`, merged], env);
      await g(repo, ["symbolic-ref", `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/${def}`], env);
    }
    // What B1's squash check found for the kept branch; a merge's members need none.
    const squashed = new Map(method === "squash" ? [["refs/heads/work", { number: 17, sha: merged, title: "Work" }]] : []);
    let f = await reach(repo, [work, merged], squashed);
    expect(f.remotes!.map((r) => [r.name, r.defaultBranch])).toEqual([["origin", "main"], ["team/fork", "release/1"]]);
    expect(f.prEvidence!.filter((e) => e.sha === work)).toEqual([
      { number: 17, sha: work, remote: "origin", method }, { number: 17, sha: work, remote: "team/fork", method },
    ]);
    await g(repo, ["update-ref", "refs/remotes/origin/main", base], env);
    await g(repo, ["update-ref", "refs/remotes/team/fork/release/1", base], env);
    f = await reach(repo, [work, merged], squashed);
    expect(f.prEvidence).toEqual([]);
  });
});

for (const method of ["merge", "squash"] as const) test(`${method} PR evidence: a remote with no known default that holds the evidence commit is listed too, so no owner is unique`, async () => {
  await setup(async ({ root, repo, env, base }) => {
    await g(repo, ["checkout", "-q", "-b", "work"], env);
    const work = await commitAt(repo, env, { "work": "done\n" }, "work", date(3));
    await g(repo, ["checkout", "-q", "main"], env);
    if (method === "merge") await g(repo, ["merge", "-q", "--no-ff", "-m", "Merge pull request #12 from org/work", "work"], env, { GIT_AUTHOR_DATE: date(4), GIT_COMMITTER_DATE: date(4) });
    else await commitAt(repo, env, { "work": "done\n" }, "Work (#12)", date(4));
    const merged = (await g(repo, ["rev-parse", "HEAD"], env)).trim();
    // A synced fork: `git fetch upstream` writes no `upstream/HEAD`, so only the fork's own default is known.
    await g(repo, ["remote", "add", "upstream", "https://github.com/up/repo"], env);
    await g(repo, ["update-ref", "refs/remotes/origin/main", merged], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
    await g(repo, ["update-ref", "refs/remotes/upstream/main", merged], env);
    const squashed = new Map(method === "squash" ? [["refs/heads/work", { number: 12, sha: merged, title: "Work" }]] : []);
    const remotesFor = (f: Awaited<ReturnType<typeof reach>>, sha: string) => f.prEvidence!.filter((e) => e.sha === sha).map((e) => e.remote);
    let f = await reach(repo, [work, merged], squashed);
    expect(f.remotes!.map((r) => [r.name, r.defaultBranch])).toEqual([["origin", "main"], ["upstream", null]]);
    expect(remotesFor(f, work)).toEqual(["origin", "upstream"]);
    expect(f.prEvidence!.every((e) => e.number === 12 && e.method === method)).toBe(true);
    // Control: the other remote stops short of the evidence commit, so the fork's own default is the one owner.
    await g(repo, ["update-ref", "refs/remotes/upstream/main", base], env);
    f = await reach(repo, [work, merged], squashed);
    expect(remotesFor(f, work)).toEqual(["origin"]);
    // Control: a known default on both is the synced fork B2 `:56` names, still both.
    await g(repo, ["update-ref", "refs/remotes/upstream/main", merged], env);
    await g(repo, ["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main"], env);
    f = await reach(repo, [work, merged], squashed);
    expect(remotesFor(f, work)).toEqual(["origin", "upstream"]);
  });
});

for (const method of ["merge", "squash"] as const) test(`${method} PR evidence: of remotes with no known default, only one that reads as GitHub is listed`, async () => {
  await setup(async ({ repo, env }) => {
    await g(repo, ["checkout", "-q", "-b", "work"], env);
    const work = await commitAt(repo, env, { "work": "done\n" }, "work", date(3));
    await g(repo, ["checkout", "-q", "main"], env);
    if (method === "merge") await g(repo, ["merge", "-q", "--no-ff", "-m", "Merge pull request #12 from org/work", "work"], env, { GIT_AUTHOR_DATE: date(4), GIT_COMMITTER_DATE: date(4) });
    else await commitAt(repo, env, { "work": "done\n" }, "Work (#12)", date(4));
    const merged = (await g(repo, ["rev-parse", "HEAD"], env)).trim();
    await g(repo, ["update-ref", "refs/remotes/origin/main", merged], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
    // Deploy targets, another forge, and an SSH shortcut name (the residual §0 accepts): none reads as GitHub. Each holds the commit.
    const others = { heroku: "https://git.heroku.com/app.git", gitlab: "git@gitlab.com:org/repo.git", gh: "gh:up/repo" };
    for (const [name, url] of Object.entries(others)) {
      await g(repo, ["remote", "add", name, url], env);
      await g(repo, ["update-ref", `refs/remotes/${name}/main`, merged], env);
    }
    const squashed = new Map(method === "squash" ? [["refs/heads/work", { number: 12, sha: merged, title: "Work" }]] : []);
    const holders = async () => (await reach(repo, [work, merged], squashed)).prEvidence!.filter((e) => e.number === 12 && e.sha === work).map((e) => e.remote);
    expect(await holders()).toEqual(["origin"]);
    // The same repository over SSH reads as GitHub, so the engine lists it; Rust counts it as one repository with origin.
    await g(repo, ["remote", "add", "origin-ssh", "git@github.com:org/repo.git"], env);
    await g(repo, ["update-ref", "refs/remotes/origin-ssh/main", merged], env);
    expect(await holders()).toEqual(["origin", "origin-ssh"]);
    // The fork case stays: another GitHub repository with no known default is a possible owner.
    await g(repo, ["remote", "add", "upstream", "https://github.com/up/repo"], env);
    await g(repo, ["update-ref", "refs/remotes/upstream/main", merged], env);
    expect(await holders()).toEqual(["origin", "origin-ssh", "upstream"]);
  });
});

test("a failed walk of a remote that does not read as GitHub costs that remote's reachability, not the PR evidence", async () => {
  await setup(async ({ repo, env, base }) => {
    await g(repo, ["remote", "add", "heroku", "https://git.heroku.com/app.git"], env);
    await g(repo, ["update-ref", "refs/remotes/origin/main", base], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
    await g(repo, ["update-ref", "refs/remotes/heroku/main", base], env);
    const f = await reach(repo, [base]);
    expect(f.prEvidence).toEqual([]);
    expect(f.reachableRemotes).toEqual([{ sha: base, remotes: null }]);
  }, (a) => a.includes("rev-list") && a.includes("refs/remotes/heroku/main") ? ["sh", "-c", "exit 2"] : undefined);
});

test("PR evidence is unknown when the walk of a remote with no known default fails: it may hold the evidence commit", async () => {
  await setup(async ({ root, repo, env, base }) => {
    await g(repo, ["remote", "add", "upstream", "https://github.com/up/repo"], env);
    await g(repo, ["update-ref", "refs/remotes/origin/main", base], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
    await g(repo, ["update-ref", "refs/remotes/upstream/main", base], env);
    expect((await reach(repo, [base])).prEvidence).toBeNull();
  }, (a) => a.includes("rev-list") && a.includes("refs/remotes/upstream/main") ? ["sh", "-c", "exit 2"] : undefined);
});

test("unknown reachability on one remote cannot establish another as unique", async () => {
  await setup(async ({ root, repo, env, base }) => {
    for (const remote of ["origin", "fork"]) {
      if (remote === "fork") await g(repo, ["remote", "add", remote, "https://github.com/fork/repo"], env);
      await g(repo, ["update-ref", `refs/remotes/${remote}/main`, base], env);
      await g(repo, ["symbolic-ref", `refs/remotes/${remote}/HEAD`, `refs/remotes/${remote}/main`], env);
    }
    const f = await reach(repo, [base]);
    expect(f.reachableRemotes).toEqual([{ sha: base, remotes: null }]);
  }, (a) => a.includes("rev-list") && a.includes("refs/remotes/fork/main") ? ["sh", "-c", "exit 2"] : undefined);
});

test("remote with no real default never borrows local main", async () => {
  await setup(async ({ root, repo, env, base }) => {
    await g(repo, ["update-ref", "refs/remotes/origin/topic", base], env);
    const f = await reach(repo, [base]);
    expect(f.remotes![0]!.defaultBranch).toBeNull();
    expect(f.prEvidence).toEqual([]);
  });
});

test("a disappeared remote default clears previously read default evidence", async () => {
  await setup(async ({ root, repo, env, base }) => {
    await g(repo, ["update-ref", "refs/remotes/origin/main", base], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
    const first = await reach(repo, [base]);
    expect(first.remotes![0]!.defaultBranch).toBe("main");
    await g(repo, ["symbolic-ref", "--delete", "refs/remotes/origin/HEAD"], env);
    const { rg, commonDir } = await ctx(repo);
    const f = await readReachFacts(rg, first, [base], new Date("2026-01-01"), new Date("2026-02-01"), new Map());
    expect(f.remotes![0]!.defaultBranch).toBeNull();
  });
});

test("omitted credential-shaped remote refs cannot make the remaining remote uniquely reachable", async () => {
  await setup(async ({ root, repo, env, base }) => {
    const token = "ghp_" + "A".repeat(36);
    await g(repo, ["remote", "add", token, "https://github.com/fork/repo"], env);
    for (const remote of ["origin", token]) await g(repo, ["update-ref", `refs/remotes/${remote}/main`, base], env);
    const f = await reach(repo, [base]);
    expect(JSON.stringify(f)).not.toContain(token);
    expect(f.reachableRemotes).toEqual([{ sha: base, remotes: null }]);
  });
});

test("a left-out remote nested under a safe name cannot lend that name its refs", async () => {
  await setup(async ({ root, repo, env, base }) => {
    await g(repo, ["checkout", "-q", "-b", "keep"], env);
    const keep = await commitAt(repo, env, { "k": "k\n" }, "keep", date(3));
    const nested = "origin/fork-é";
    await g(repo, ["config", `remote.${nested}.url`, "https://github.com/fork/repo"], env);
    await g(repo, ["update-ref", `refs/remotes/${nested}/main`, base], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/${nested}/main`], env);
    await g(repo, ["update-ref", "refs/remotes/origin/keep", keep], env);
    const f = await reach(repo, [base]);
    expect(JSON.stringify(f)).not.toContain("fork-é/main");
    expect(f.reachableRemotes).toEqual([{ sha: base, remotes: null }]);
    expect(f.remotes!.map((r) => [r.name, r.defaultBranch])).toEqual([["origin", null]]);
    expect(f.prEvidence).toBeNull();
    // A name with no slash past the prefix cannot be the left-out remote's.
    expect(f.remoteBranches).toEqual([{ remote: "origin", name: "keep", sha: keep }]);
  });
});

test("a safe remote whose HEAD names a credential-shaped branch reports no default and no sentinel", async () => {
  await setup(async ({ root, repo, env, base }) => {
    const token = "ghp_" + "A".repeat(36);
    await g(repo, ["update-ref", `refs/remotes/origin/${token}`, base], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", `refs/remotes/origin/${token}`], env);
    expect((await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD"], env)).trim()).toBe(`refs/remotes/origin/${token}`);
    const f = await reach(repo, [base]);
    expect(f.remotes!.map((r) => [r.name, r.github, r.defaultBranch])).toEqual([["origin", { owner: "org", repo: "repo" }, null]]);
    expect(JSON.stringify(f)).not.toContain(token);
  });
});

test("remoteBranches lists each remote's real branches with their tips, owned by the longest exact remote name", async () => {
  await setup(async ({ root, repo, env, base }) => {
    await g(repo, ["checkout", "-q", "-b", "work"], env);
    const tip = await commitAt(repo, env, { "w": "w\n" }, "work", date(3));
    await g(repo, ["remote", "add", "team", "https://github.com/team/repo"], env);
    // Newer git refuses `remote add` for a name nested under an existing remote (CI's does, 2.50.1's does not), but a config
    // can still hold one, so it is written directly.
    await g(repo, ["config", "remote.team/fork.url", "https://github.com/fork/repo"], env);
    await g(repo, ["config", "remote.team/fork.fetch", "+refs/heads/*:refs/remotes/team/fork/*"], env);
    await g(repo, ["update-ref", "refs/remotes/origin/main", base], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
    await g(repo, ["update-ref", "refs/remotes/team/feature/x", tip], env);
    await g(repo, ["update-ref", "refs/remotes/team/fork/y", tip], env);
    const f = await reach(repo, [base, tip]);
    expect(f.remoteBranches).toEqual([
      { remote: "origin", name: "main", sha: base },
      { remote: "team", name: "feature/x", sha: tip },
      { remote: "team/fork", name: "y", sha: tip },
    ]);
  });
});

test("remoteBranches: a credential-shaped branch is left out, and so is any branch it could make falsely unique", async () => {
  await setup(async ({ root, repo, env, base }) => {
    const token = "ghp_" + "A".repeat(36);
    await g(repo, ["checkout", "-q", "-b", "work"], env);
    const other = await commitAt(repo, env, { "w": "w\n" }, "work", date(3));
    await g(repo, ["update-ref", `refs/remotes/origin/${token}`, base], env);
    await g(repo, ["update-ref", "refs/remotes/origin/shares-the-tip", base], env);
    await g(repo, ["update-ref", "refs/remotes/origin/safe", other], env);
    const f = await reach(repo, [base, other]);
    expect(JSON.stringify(f)).not.toContain(token);
    expect(f.remoteBranches).toEqual([{ remote: "origin", name: "safe", sha: other }]);
  });
});

test("remoteBranches: a credential-shaped remote's branches are left out, and it cannot make another branch unique", async () => {
  await setup(async ({ root, repo, env, base }) => {
    const token = "ghp_" + "A".repeat(36);
    await g(repo, ["remote", "add", token, "https://github.com/fork/repo"], env);
    await g(repo, ["update-ref", `refs/remotes/${token}/main`, base], env);
    await g(repo, ["update-ref", "refs/remotes/origin/main", base], env);
    const f = await reach(repo, [base]);
    expect(JSON.stringify(f)).not.toContain(token);
    expect(f.remoteBranches).toEqual([]);
  });
});

test("remoteBranches is all or nothing at its cap: exactly the cap is listed whole, one over is null", async () => {
  await setup(async ({ root, repo, env, base }) => {
    const packed = (n: number) => Array.from({ length: n }, (_, i) => `${base} refs/remotes/origin/b${String(i).padStart(5, "0")}`).join("\n") + "\n";
    writeFileSync(join(repo, ".git", "packed-refs"), packed(REMOTE_BRANCHES_CAP));
    const at = await reach(repo, [base]);
    expect(at.remoteBranches).toHaveLength(REMOTE_BRANCHES_CAP);
    writeFileSync(join(repo, ".git", "packed-refs"), packed(REMOTE_BRANCHES_CAP + 1));
    const over = await reach(repo, [base]);
    expect((await g(repo, ["for-each-ref", "--count=1", "--format=%(refname)", `refs/remotes/origin/b${String(REMOTE_BRANCHES_CAP).padStart(5, "0")}`], env)).trim()).not.toBe("");
    expect(over.remoteBranches).toBeNull();
    expect(over.remotes![0]!.name).toBe("origin");
  });
}, 30_000);

test("remoteBranches is null on a failed listing, never an empty list that reads as known", async () => {
  await setup(async ({ root, repo, base }) => {
    const f = await reach(repo, [base]);
    expect(f.remoteBranches).toBeNull();
  }, (a) => a.includes("for-each-ref") && a.includes("refs/remotes/") && a.some((x) => x.includes("%(symref)")) ? ["sh", "-c", "exit 2"] : undefined);
});

test("branches[].tip is the branch's own tip, not a card's commit: a remote branch at an older commit does not share it", async () => {
  await setup(async ({ root, repo, env, base }) => {
    await g(repo, ["checkout", "-q", "-b", "feature"], env);
    const card = await commitAt(repo, env, { "x": "x\n" }, "card commit", date(3));
    const later = await commitAt(repo, env, { "y": "y\n" }, "later commit on another card", date(4));
    await g(repo, ["update-ref", "refs/remotes/origin/old-backup", card], env);
    const f = await reach(repo, [card]);
    expect(f.branches!.map((b) => [b.name, b.tip])).toEqual([["feature", later], ["main", base]]);
    expect(f.remoteBranches).toEqual([{ remote: "origin", name: "old-backup", sha: card }]);
    expect(f.remoteBranches!.some((b) => b.sha === later)).toBe(false);
  });
});

test("branches[].tip is null when the listing's object name is not a full 40-hex id", async () => {
  await setup(async ({ root, repo, base }) => {
    const f = await reach(repo, [base]);
    expect(f.branches!.map((b) => [b.name, b.tip])).toEqual([["main", null]]);
  }, (a) => a.includes("for-each-ref") && a.includes("refs/heads/") && a.some((x) => x.includes("%(objectname)")) && !a.some((x) => x.includes("%(upstream)")) ? ["sh", "-c", "printf 'refs/heads/main\\037not-a-sha\\n'"] : undefined);
});

test("labelKeys: the run record's card keys by the public norm, per root; a credential-shaped key is left out", async () => {
  await setup(async ({ root, repo }) => {
    const { rg, commonDir } = await ctx(repo);
    const facts = await readRemoteFacts(rg, commonDir);
    const token = "GHP_" + "A".repeat(36);
    const f = await readCheckoutFacts(rg, commonDir, facts, {
      "*GUI*": { repo, root: "apps/gui" }, "gui.": { repo, root: "apps/gui" }, Web: { repo, root: "apps/gui" },
      [token]: { repo, root: "apps/gui" }, "`": { repo, root: "apps/gui" }, Repo: { repo, root: null },
      Elsewhere: { repo: join(root, "home"), root: null },
    }, ["main", "feature/slash"]);
    expect(f.roots).toEqual([
      { root: "", project: projectKey(repo, ""), labelKeys: ["repo"], displayLabel: "Repo" },
      { root: "apps/gui", project: projectKey(repo, "apps/gui"), labelKeys: ["gui", "web"], displayLabel: "*GUI*" },
    ]);
    expect(JSON.stringify(f).toLowerCase()).not.toContain(token.toLowerCase());
  });
});

test("labelKeys: a key two labels share across roots is listed on both, for the mint to refuse; no record gives none", async () => {
  await setup(async ({ repo }) => {
    const { rg, commonDir } = await ctx(repo);
    const facts = await readRemoteFacts(rg, commonDir);
    const both = await readCheckoutFacts(rg, commonDir, facts, { GUI: { repo, root: "apps/gui" }, gui: { repo, root: null } }, ["main", "feature/slash"]);
    expect(both.roots!.map((r) => [r.root, r.labelKeys])).toEqual([["", ["gui"]], ["apps/gui", ["gui"]]]);
    const none = await readCheckoutFacts(rg, commonDir, facts, null, []);
    expect(none.roots).toEqual([{ root: "", project: projectKey(repo, ""), labelKeys: [], displayLabel: null }]);
  });
});

test("displayLabel: a root's card label as it was written, and a repo checked with no label today still lists its own folder", async () => {
  await setup(async ({ root, repo }) => {
    const { rg, commonDir } = await ctx(repo);
    const facts = await readRemoteFacts(rg, commonDir);
    const named = await readCheckoutFacts(rg, commonDir, facts, { "Quant Stocks": { repo, root: null } }, []);
    expect(named.roots).toEqual([{ root: "", project: projectKey(repo, ""), labelKeys: ["quant stocks"], displayLabel: "Quant Stocks" }]);
    // Two labels on one root: the first by bytes; one the key rule leaves out is never shown.
    const token = "GHP_" + "A".repeat(36);
    const two = await readCheckoutFacts(rg, commonDir, facts, { Zed: { repo, root: null }, Alpha: { repo, root: null }, [token]: { repo, root: null } }, []);
    expect(two.roots!.map((r) => r.displayLabel)).toEqual(["Alpha"]);
    // The record names only another repo: this one is still checked, so it is a project with no card.
    const other = await readCheckoutFacts(rg, commonDir, facts, { Elsewhere: { repo: join(root, "home"), root: null } }, []);
    expect(other.roots).toEqual([{ root: "", project: projectKey(repo, ""), labelKeys: [], displayLabel: null }]);
  });
});

for (const v of projectVectors) test(`project key: ${v.repo} + ${v.root}`, () => {
  expect(projectKey(v.repo, v.root)).toBe(v.project);
});

test("branch checkout is reciprocal, on the named branch, and project keys survive labels/checkouts", async () => {
  await setup(async ({ root, repo, env }) => {
    await g(repo, ["branch", "feature/slash"], env);
    const wt = join(root, "linked");
    await g(repo, ["worktree", "add", "-q", wt, "feature/slash"], env);
    const { rg, commonDir } = await ctx(repo);
    const read = async (label: string) => readCheckoutFacts(rg, commonDir, await readRemoteFacts(rg, commonDir), { [label]: { repo, root: "apps/gui" } }, ["main", "feature/slash"]);
    const first = await read("Before");
    expect(first.branches!.find((b) => b.name === "main")!.checkoutPath).toBe(repo);
    expect(first.branches!.find((b) => b.name === "feature/slash")!.checkoutPath).toBe(wt);
    expect(first.roots).toEqual([{ root: "apps/gui", project: projectKey(repo, "apps/gui"), labelKeys: ["before"], displayLabel: "Before" }]);
    const renamed = (await read("Renamed")).roots!;
    expect(renamed).toEqual([{ ...first.roots![0]!, labelKeys: ["renamed"], displayLabel: "Renamed" }]);
    await g(wt, ["checkout", "-q", "--detach"], env);
    await g(repo, ["checkout", "-q", "feature/slash"], env);
    const changed = await read("Renamed");
    expect(changed.branches!.find((b) => b.name === "feature/slash")!.checkoutPath).toBe(repo);
    expect(changed.roots).toEqual(renamed);
  });
});

test("a configured subdirectory: roots join onto a checkout inside the configured folder, on the main checkout and a linked one", async () => {
  await setup(async ({ root, repo, env }) => {
    // The same relative path at the top must not be the one a target reaches.
    await commitAt(repo, env, { "apps/gui/pkg/a/f": "a\n", "pkg/a/f": "top\n" }, "both", date(3));
    await g(repo, ["branch", "feature/slash"], env);
    const wt = join(root, "linked");
    await g(repo, ["worktree", "add", "-q", wt, "feature/slash"], env);
    const configured = join(repo, "apps/gui");
    const { rg, commonDir } = await ctx(configured);
    const facts = await readRemoteFacts(rg, commonDir);
    expect(facts.path).toBe(configured);
    const f = await readCheckoutFacts(rg, commonDir, facts, { Gui: { repo: configured, root: null }, A: { repo: configured, root: "pkg/a" } }, ["main", "feature/slash"]);
    expect(f.roots!.map((r) => [r.root, r.labelKeys])).toEqual([["apps/gui", ["gui"]], ["apps/gui/pkg/a", ["a"]]]);
    // A project's identity is the record's own repo and root, whichever checkout opens it.
    expect(f.roots!.map((r) => r.project)).toEqual([projectKey(configured, ""), projectKey(configured, "pkg/a")]);
    for (const b of f.branches!.filter((x) => x.checkoutPath !== null)) {
      for (const r of f.roots!) {
        const folder = join(b.checkoutPath!, r.root);
        expect(folder.startsWith(join(b.checkoutPath!, "apps/gui"))).toBe(true);
        expect(realpathSync(folder)).toBe(folder);
      }
    }
    expect(f.branches!.find((b) => b.name === "main")!.checkoutPath).toBe(repo);
    expect(f.branches!.find((b) => b.name === "feature/slash")!.checkoutPath).toBe(wt);
    // No accepted record: the configured folder itself, never the top.
    const none = await readCheckoutFacts(rg, commonDir, facts, null, ["main"]);
    expect(none.roots).toEqual([{ root: "apps/gui", project: projectKey(configured, ""), labelKeys: [], displayLabel: null }]);
  });
});

test("a configured subdirectory: a root whose link leaves the configured folder for elsewhere in the checkout is no target", async () => {
  await setup(async ({ root, repo, env }) => {
    await commitAt(repo, env, { "other/f": "x\n" }, "other", date(3));
    const configured = join(repo, "apps/gui");
    symlinkSync(join(repo, "other"), join(configured, "out"));
    const { rg, commonDir } = await ctx(configured);
    const f = await readCheckoutFacts(rg, commonDir, await readRemoteFacts(rg, commonDir), { Out: { repo: configured, root: "out" }, Gui: { repo: configured, root: null } }, ["main"]);
    expect(f.roots!.map((r) => r.root)).toEqual(["apps/gui"]);
  });
});

test("a root that leaves the configured folder in any validated checkout is no target, though another checkout has it as a real folder", async () => {
  await setup(async ({ root, repo, env }) => {
    await commitAt(repo, env, { "apps/gui/pkg/f": "real\n", "other/f": "x\n" }, "both", date(3));
    await g(repo, ["worktree", "add", "-q", "-b", "wt-link", join(root, "wt")], env);
    const wt = join(root, "wt");
    // In the linked checkout the same path is a link out of the configured folder, and Rust joins onto the branch's own checkout.
    rmSync(join(wt, "apps/gui/pkg"), { recursive: true });
    symlinkSync(join(wt, "other"), join(wt, "apps/gui/pkg"));
    const configured = join(repo, "apps/gui");
    const { rg, commonDir } = await ctx(configured);
    const facts = await readRemoteFacts(rg, commonDir);
    const labels = { Pkg: { repo: configured, root: "pkg" }, Gui: { repo: configured, root: null } };
    const f = await readCheckoutFacts(rg, commonDir, facts, labels, ["main", "wt-link"]);
    expect(f.branches!.find((b) => b.name === "wt-link")!.checkoutPath).toBe(wt);
    expect(f.roots!.map((r) => r.root)).toEqual(["apps/gui"]);
    // Control: with that checkout not validated, nothing says the path leaves, and the main checkout's real folder lists.
    const main = await readCheckoutFacts(rg, commonDir, facts, labels, ["main"]);
    expect(main.roots!.map((r) => r.root)).toEqual(["apps/gui", "apps/gui/pkg"]);
    // Control: a checkout with no such folder at all takes nothing away.
    rmSync(join(wt, "apps/gui/pkg"));
    const gone = await readCheckoutFacts(rg, commonDir, facts, labels, ["main", "wt-link"]);
    expect(gone.roots!.map((r) => r.root)).toEqual(["apps/gui", "apps/gui/pkg"]);
  });
});

test("the project's own folder is the fallback when no label's root is concrete, and only then", async () => {
  await setup(async ({ root, repo, env }) => {
    const { rg, commonDir } = await ctx(repo);
    const facts = await readRemoteFacts(rg, commonDir);
    const old = { Old: { repo, root: "deleted" } };
    const own = { root: "", project: projectKey(repo, ""), labelKeys: [], displayLabel: null };
    // A record naming only a folder since deleted: the repo keeps a working row, with no card's name or key.
    expect((await readCheckoutFacts(rg, commonDir, facts, old, ["main"])).roots).toEqual([own]);
    // Control: one concrete root is enough, so there is no fallback beside it.
    const both = await readCheckoutFacts(rg, commonDir, facts, { ...old, Gui: { repo, root: "apps/gui" } }, ["main"]);
    expect(both.roots!.map((r) => r.root)).toEqual(["apps/gui"]);
    // A root only a worktree not asked about has: its row and the fallback swap as that worktree comes into the ask.
    await g(repo, ["worktree", "add", "-q", "-b", "wt-only", join(root, "wt")], env);
    await commitAt(join(root, "wt"), env, { "only-there/f": "x\n" }, "only there", date(3));
    const labels = { There: { repo, root: "only-there" } };
    const later = await readRemoteFacts(rg, commonDir);
    expect((await readCheckoutFacts(rg, commonDir, later, labels, ["main"])).roots).toEqual([own]);
    const asked = await readCheckoutFacts(rg, commonDir, later, labels, ["main", "wt-only"]);
    expect(asked.roots).toEqual([{ root: "only-there", project: projectKey(repo, "only-there"), labelKeys: ["there"], displayLabel: "There" }]);
  });
});

test("with no validated checkout the fallback lists nothing either: it needs a real folder too", async () => {
  await setup(async ({ repo }) => {
    const { rg, commonDir } = await ctx(repo);
    const none = await readCheckoutFacts(rg, commonDir, await readRemoteFacts(rg, commonDir), { Old: { repo, root: "deleted" } }, ["main"]);
    expect(none.branches!.find((b) => b.name === "main")!.checkoutPath).toBeNull();
    expect(none.roots).toEqual([]);
  }, (a) => a.includes("symbolic-ref") ? ["sh", "-c", "exit 2"] : undefined);
});

test("branch facts spawn nothing per branch; a listed ref's leading - and HEAD still answer false", async () => {
  await setup(async ({ repo, env, base }, spy) => {
    for (const name of ["-dash", "HEAD", "feature/ok"]) await g(repo, ["update-ref", `refs/heads/${name}`, base], env);
    const { rg, commonDir } = await ctx(repo);
    spy.calls.length = 0;
    const facts = await readRemoteFacts(rg, commonDir);
    expect(facts.branches!.map((b) => [b.name, b.refFormatOk])).toEqual([["-dash", false], ["HEAD", false], ["feature/ok", true], ["main", true]]);
    expect(spy.calls.filter((a) => a.includes("check-ref-format"))).toEqual([]);
  });
});

test("only a checkout that can hold an asked-about branch, and the configured one, is validated: a worktree on neither costs no spawn", async () => {
  await setup(async ({ root, repo, env }, spy) => {
    for (const name of ["w0", "w1", "w2"]) await g(repo, ["worktree", "add", "-q", "-b", name, join(root, name)], env);
    const validations = () => spy.calls.filter((a) => a.includes("symbolic-ref")).length;
    const { rg, commonDir } = await ctx(repo);
    const facts = await readRemoteFacts(rg, commonDir);
    spy.calls.length = 0;
    const none = await readCheckoutFacts(rg, commonDir, facts, null, []);
    expect(validations()).toBe(1);
    expect(none.roots!.map((r) => r.root)).toEqual([""]); // A Settings row still resolves with no card asking.
    spy.calls.length = 0;
    const one = await readCheckoutFacts(rg, commonDir, facts, null, ["w1"]);
    expect(validations()).toBe(2);
    expect(one.branches!.find((b) => b.name === "w1")!.checkoutPath).toBe(join(root, "w1"));
    expect(one.branches!.find((b) => b.name === "w0")!.checkoutPath).toBeNull();
    // A branch forced into two worktrees is still seen in both, so it stays ambiguous.
    await g(repo, ["worktree", "add", "-q", "-f", join(root, "w1-again"), "w1"], env);
    const twice = await readCheckoutFacts(rg, commonDir, facts, null, ["w1"]);
    expect(twice.branches!.find((b) => b.name === "w1")!.checkoutPath).toBeNull();
    // A configured linked worktree, with no card asking, validates itself.
    const linked = await ctx(join(root, "w0"));
    // Its own check is what shows a folder only it has: the main checkout, also validated, has none.
    await commitAt(join(root, "w0"), env, { "only-here/f": "x\n" }, "only here", date(3));
    const own = await readCheckoutFacts(linked.rg, linked.commonDir, await readRemoteFacts(linked.rg, linked.commonDir), { Here: { repo: join(root, "w0"), root: "only-here" } }, []);
    expect(own.roots!.map((r) => r.root)).toEqual(["only-here"]);
  });
});

test("a PR row B1 shows keeps its evidence however many unrelated pushed branches the repo has: B2 reuses B1's squash matches", async () => {
  await setup(async ({ root, repo, env, base }) => {
    for (let i = 0; i < 20; i++) {
      const name = `a${String(i).padStart(2, "0")}`;
      await g(repo, ["checkout", "-q", "-b", name, base], env);
      const c = await commitAt(repo, env, { [`other${i}`]: `other ${i}\n` }, `other ${i}`, date(3));
      await g(repo, ["update-ref", `refs/remotes/origin/${name}`, c], env);
      await g(repo, ["branch", "-q", `--set-upstream-to=origin/${name}`, name], env);
    }
    await g(repo, ["checkout", "-q", "-b", "zeta", base], env);
    const work = await commitAt(repo, env, { "z": "z\n" }, "z work", date(4));
    await g(repo, ["checkout", "-q", "main"], env);
    const squash = await commitAt(repo, env, { "z": "z\n" }, "Add z (#7)", date(5));
    await g(repo, ["update-ref", "refs/remotes/origin/main", squash], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
    await g(repo, ["branch", "-q", "--set-upstream-to=origin/main", "main"], env);
    const r = await reposStatus({ scope: "all", pageDate: "2026-01-06", labels: [{ key: "proj", tokens: [work.slice(0, 8)] }], branches: [] },
      { now: () => new Date("2026-01-06T23:00:00Z"), tmpRoot: root, readRecord: async () => ({ accepted: false as const }), loadConfig: async () => ({ repos: [repo] }) });
    if (r.scope !== "all") throw new Error("scope");
    expect(r.labels[0]!.rows.map((x) => [x.kind, "number" in x ? x.number : null])).toEqual([["pr", 7]]);
    expect(r.actionFacts[0]!.prEvidence).toContainEqual({ number: 7, sha: work, remote: "origin", method: "squash" });
  });
});

test("the main checkout with a separate git dir must still validate against the configured common dir", async () => {
  await setup(async ({ root, repo, env }) => {
    await g(repo, ["init", "-q", "--separate-git-dir", join(root, "git-dir")], env);
    const { rg, commonDir } = await ctx(repo);
    const f = await readCheckoutFacts(rg, commonDir, await readRemoteFacts(rg, commonDir), { GUI: { repo, root: "apps/gui" } }, ["main", "feature/slash"]);
    expect(f.branches!.find((b) => b.name === "main")!.checkoutPath).toBe(repo);
    expect(f.roots).toEqual([{ root: "apps/gui", project: projectKey(repo, "apps/gui"), labelKeys: ["gui"], displayLabel: "GUI" }]);
  });
});

for (const attack of ["backlink", "gitfile", "branch", "unrelated"] as const) test(`forged worktree ${attack} gives no checkout path`, async () => {
  await setup(async ({ root, repo, env }) => {
    await g(repo, ["branch", "feature/slash"], env);
    const wt = join(root, "linked");
    await g(repo, ["worktree", "add", "-q", wt, "feature/slash"], env);
    const { rg, commonDir } = await ctx(repo);
    const meta = join(commonDir, "worktrees", "linked");
    const gitfile = readFileSync(join(wt, ".git"), "utf8");
    if (attack === "backlink") writeFileSync(join(meta, "gitdir"), join(root, "other/.git") + "\n");
    if (attack === "gitfile") writeFileSync(join(wt, ".git"), `gitdir: ${join(root, "forged")}\n`);
    if (attack === "branch") await g(wt, ["checkout", "-q", "-b", "other-branch"], env);
    if (attack === "unrelated") {
      const unrelated = join(root, "unrelated");
      mkdirSync(unrelated);
      await g(unrelated, ["init", "-q", "-b", "feature/slash"], env);
      await commitAt(unrelated, env, { "f": "f\n" }, "other", date(5));
      writeFileSync(join(meta, "gitdir"), join(unrelated, ".git") + "\n");
      // Merely matching the common-dir entry is insufficient; the checkout's gitfile must agree.
      expect(gitfile).toContain(meta);
    }
    const f = await readCheckoutFacts(rg, commonDir, await readRemoteFacts(rg, commonDir), { GUI: { repo, root: "apps/gui" } }, ["main", "feature/slash"]);
    expect(f.branches!.find((b) => b.name === "feature/slash")!.checkoutPath).toBeNull();
  });
});

test("escaping/missing/ambiguous sub-project roots and failed canonical repo yield no keyed target", async () => {
  await setup(async ({ root, repo }) => {
    const { rg, commonDir } = await ctx(repo);
    mkdirSync(join(root, "outside"));
    symlinkSync(join(root, "outside"), join(repo, "escape"));
    const f = await readCheckoutFacts(rg, commonDir, await readRemoteFacts(rg, commonDir), {
      Escape: { repo, root: "escape" }, Missing: { repo, root: "missing" }, Parent: { repo, root: "../outside" },
      Absolute: { repo, root: "/outside" }, EmptyComponent: { repo, root: "apps//gui" },
    }, ["main", "feature/slash"]);
    // None of them lists, and no card reaches the row left: the project's own folder, under no label's key.
    expect(f.roots).toEqual([{ root: "", project: projectKey(repo, ""), labelKeys: [], displayLabel: null }]);
    rmSync(repo, { recursive: true, force: true });
    expect((await readCheckoutFacts(rg, commonDir, f, { Root: { repo, root: null } }, ["main"])).roots).toBeNull();
  });
});

// Plan §0, B2 final round 4. Real git builds each flow against local bare repositories, and the URLs are rewritten afterwards,
// so nothing touches the network. tests/actions.rs mints from the same literal.
type CounterpartCase = {
  facts: { pushDefault: string | null; pushesToUpstream: boolean; remotes: { name: string }[]; branch: { upstreamRemote: string; upstreamBranch: string; pushRemote: string | null } };
  expect: { copy: string | null; command: string | null };
};
const counterparts: { cases: Record<string, CounterpartCase> } =
  JSON.parse(readFileSync(new URL("../gui/src-tauri/tests/fixtures/upstream-counterpart-vectors.json", import.meta.url), "utf8"));
type Flow = { repo: string; env: Record<string, string>; root: string; commit: (name: string) => Promise<string>; dropHead: (remote: string) => Promise<void> };
const startFromDefault = async ({ repo, env, commit }: Flow) => { await g(repo, ["checkout", "-q", "-b", "feat", "origin/main"], env); await commit("work"); };
const startFromDevelop = async ({ repo, env, commit }: Flow) => {
  await g(repo, ["push", "-q", "origin", "main:develop"], env);
  await g(repo, ["fetch", "-q", "origin"], env);
  await g(repo, ["checkout", "-q", "-b", "feat", "origin/develop"], env);
  await commit("work");
};
const pushFeat = async ({ repo, env }: Flow) => { await g(repo, ["push", "-q", "origin", "feat"], env); };
const forked = (start: "main" | "develop" | "feat", selector: "pushRemote" | "pushDefault" | null = "pushRemote", pushed = true, committed = true) => async (fx: Flow) => {
  const { repo, env, root } = fx;
  await g(root, ["init", "-q", "--bare", "-b", "main", "acme.git"], env);
  await g(repo, ["push", "-q", join(root, "acme.git"), "main", ...(start === "main" ? [] : [`main:${start}`])], env);
  await g(repo, ["remote", "add", "upstream", join(root, "acme.git")], env);
  await g(repo, ["fetch", "-q", "upstream"], env);
  await g(repo, ["remote", "set-head", "upstream", "main"], env); // written by a fetch on Git 2.50.1, not by every supported git
  await g(repo, ["checkout", "-q", "-b", "feat", `upstream/${start}`], env);
  if (selector !== null) await g(repo, ["config", selector === "pushRemote" ? "branch.feat.pushRemote" : "remote.pushDefault", "origin"], env);
  if (committed) await fx.commit("work");
  if (pushed) await pushFeat(fx);
};
const sameNamedBehind = async (fx: Flow) => {
  await g(fx.repo, ["checkout", "-q", "-b", "feat"], fx.env);
  await fx.commit("work");
  await g(fx.repo, ["push", "-q", "-u", "origin", "feat"], fx.env);
  await fx.commit("more");
};
const renamed = async (fx: Flow) => {
  await startFromDefault(fx);
  await g(fx.repo, ["push", "-q", "origin", "feat:topic"], fx.env);
  await g(fx.repo, ["branch", "-q", "--set-upstream-to=origin/topic", "feat"], fx.env);
  await fx.commit("more"); // past `origin/topic`, so nothing but the upstream can name it
};
const pushMode = (mode: "upstream" | "tracking" | "current", flow: (fx: Flow) => Promise<void>) => async (fx: Flow) => {
  await flow(fx);
  await g(fx.repo, ["config", "push.default", mode], fx.env);
};
const flows: Record<string, (fx: Flow) => Promise<void>> = {
  "never pushed, started from the default": startFromDefault,
  "new branch still at the default's tip": async ({ repo, env }) => { await g(repo, ["checkout", "-q", "-b", "feat", "origin/main"], env); },
  "pushed without -u": async (fx) => { await startFromDefault(fx); await pushFeat(fx); },
  "pushed without -u, then a local commit": async (fx) => { await startFromDefault(fx); await pushFeat(fx); await fx.commit("more"); },
  "started from origin/develop, never pushed": startFromDevelop,
  "started from origin/develop, pushed": async (fx) => { await startFromDevelop(fx); await pushFeat(fx); },
  "fork, upstream/main with pushRemote origin": forked("main"),
  "fork, upstream/main with pushRemote origin, never pushed": forked("main", "pushRemote", false),
  "fork, upstream/main with no selection, never pushed": forked("main", null, false),
  "fork, push.default current, upstream/main with no selection, never pushed": pushMode("current", forked("main", null, false)),
  "two remotes, neither origin, upstream/main with no selection, never pushed": async (fx) => {
    await forked("main", null, false)(fx);
    await g(fx.repo, ["remote", "rename", "origin", "fork"], fx.env);
  },
  "fork, upstream/develop with pushRemote origin": forked("develop"),
  "fork, upstream's default unknown": async (fx) => { await forked("main")(fx); await fx.dropHead("upstream"); },
  "default unknown, never pushed": async (fx) => { await startFromDefault(fx); await fx.dropHead("origin"); },
  "default unknown, pushed without -u": async (fx) => { await startFromDefault(fx); await pushFeat(fx); await fx.dropHead("origin"); },
  "upstream set to topic, git's own push.default": renamed,
  "upstream set to topic, git's own push.default, default unknown": async (fx) => { await renamed(fx); await fx.dropHead("origin"); },
  "real rename, push.default upstream": pushMode("upstream", renamed),
  "real rename, push.default tracking": pushMode("tracking", renamed),
  "real rename, push.default upstream, default unknown": pushMode("upstream", async (fx) => { await renamed(fx); await fx.dropHead("origin"); }),
  "real rename, push.default upstream, pushRemote names the upstream's remote": pushMode("upstream", async (fx) => {
    await renamed(fx);
    await g(fx.repo, ["config", "branch.feat.pushRemote", "origin"], fx.env);
  }),
  "fork, push.default upstream, pushRemote selects another remote": pushMode("upstream", forked("develop")),
  "fork, push.default upstream, pushDefault selects another remote": pushMode("upstream", forked("develop", "pushDefault")),
  "same-named upstream behind the local tip": sameNamedBehind,
  "same-named upstream behind the local tip, pushRemote names its remote": async (fx) => {
    await sameNamedBehind(fx);
    await g(fx.repo, ["config", "branch.feat.pushRemote", "origin"], fx.env);
  },
  "same-named upstream behind the local tip, pushDefault names its remote": async (fx) => {
    await sameNamedBehind(fx);
    await g(fx.repo, ["config", "remote.pushDefault", "origin"], fx.env);
  },
  "fork, same-named upstream/feat with pushRemote origin, never pushed": forked("feat", "pushRemote", false),
  "fork, same-named upstream/feat with pushRemote origin, never pushed, still at its tip": forked("feat", "pushRemote", false, false),
  "fork, same-named upstream/feat with pushRemote origin, pushed": forked("feat"),
  "fork, same-named upstream/feat with pushRemote origin, both at its tip": forked("feat", "pushRemote", true, false),
  "fork, same-named upstream/feat with pushDefault origin, never pushed, still at its tip": forked("feat", "pushDefault", false, false),
  "fork, same-named upstream/feat with pushDefault origin, pushed": forked("feat", "pushDefault"),
  "fork, push.default upstream, same-named upstream/feat with pushRemote origin": pushMode("upstream", forked("feat")),
  "fork, upstream/develop with pushRemote origin, feat only on upstream": async (fx) => {
    await forked("develop", "pushRemote", false)(fx);
    await g(fx.repo, ["push", "-q", "upstream", "feat"], fx.env);
  },
};
const withFlow = (name: string, use: (fx: { root: string; repo: string; env: Record<string, string> }) => Promise<void>) => setup(async ({ root, repo, env }) => {
  let n = 10;
  const commit = (file: string) => commitAt(repo, env, { [file]: `${file}\n` }, file, date(n++));
  await g(root, ["init", "-q", "--bare", "-b", "main", "org.git"], env);
  await g(repo, ["remote", "set-url", "origin", join(root, "org.git")], env);
  await g(repo, ["push", "-q", "origin", "main"], env);
  await g(repo, ["remote", "set-head", "origin", "main"], env);
  await flows[name]!({ root, repo, env, commit, dropHead: async (remote) => { await g(repo, ["symbolic-ref", "--delete", `refs/remotes/${remote}/HEAD`], env); } });
  await use({ root, repo, env });
});
test("the fixture's flows and the cases it lists are the same set", () => {
  expect(Object.keys(flows).sort()).toEqual(Object.keys(counterparts.cases).sort());
});
for (const name of Object.keys(flows)) test(`real git leaves the facts the counterpart fixture holds: ${name}`, async () => {
  await withFlow(name, async ({ repo, env }) => {
    for (const [remote, url] of [["origin", "https://github.com/org/repo"], ["fork", "https://github.com/org/repo"], ["upstream", "https://github.com/acme/repo"]] as const) {
      if ((await g(repo, ["remote"], env)).split("\n").includes(remote)) await g(repo, ["remote", "set-url", remote, url], env);
    }
    const f = await reach(repo, []);
    const b = f.branches!.find((x) => x.name === "feat")!;
    expect({
      pushDefault: f.pushDefault,
      pushesToUpstream: f.pushesToUpstream,
      remotes: f.remotes!.map((r) => ({ name: r.name, owner: r.github?.owner ?? null, defaultBranch: r.defaultBranch })),
      branch: { upstreamRemote: b.upstreamRemote, upstreamBranch: b.upstreamBranch, pushRemote: b.pushRemote },
      remoteBranches: f.remoteBranches!.map((e) => ({ remote: e.remote, name: e.name, atTip: e.sha === b.tip })),
    }).toEqual(counterparts.cases[name]!.facts as never);
  });
});
// What the Rust side decides from those facts, checked against git itself: the command Copy gives lands on the branch's own
// name and leaves the upstream alone, and a plain `git push` moves an upstream that is not that same ref only where the case
// refuses Copy as `name-mismatch`. Where it refuses as `ambiguous`, that push fails and lands nowhere.
for (const [name, { facts: { branch, remotes }, expect: want }] of Object.entries(counterparts.cases)) test(`git agrees with the counterpart fixture: ${name}`, async () => {
  await withFlow(name, async ({ repo, env }) => {
    const tip = (await g(repo, ["rev-parse", "refs/heads/feat"], env)).trim();
    const onRemote = async (remote: string, ref: string) => (await gRaw(repo, ["ls-remote", "--", remote, `refs/heads/${ref}`], env)).out.split("\t")[0]!;
    const upstreamAtStart = await onRemote(branch.upstreamRemote, branch.upstreamBranch);
    expect(upstreamAtStart).toMatch(/^[0-9a-f]{40}$/); // a failed read would read as "not moved"
    const config = async () => [await g(repo, ["config", "branch.feat.remote"], env), await g(repo, ["config", "branch.feat.merge"], env)];
    const configAtStart = await config();
    expect(want.copy === null).toBe(want.command !== null);
    const remote = want.command === null ? null : /^-- '([^']+)' 'feat'$/.exec(want.command)![1]!;
    const upstreamIsThatRef = remote === branch.upstreamRemote && branch.upstreamBranch === "feat";
    if (remote !== null) {
      await g(repo, ["push", "-q", "--", remote, "feat"], env);
      expect(await onRemote(remote, "feat")).toBe(tip);
      expect(await config()).toEqual(configAtStart);
      if (!upstreamIsThatRef) expect(await onRemote(branch.upstreamRemote, branch.upstreamBranch)).toBe(upstreamAtStart);
    }
    if (!upstreamIsThatRef) {
      const plain = await gRaw(repo, ["push", "-q"], env); // refused under some settings: where it goes is the point
      const moved = await onRemote(branch.upstreamRemote, branch.upstreamBranch) !== upstreamAtStart;
      expect(moved).toBe(want.copy === "name-mismatch");
      if (want.copy === "ambiguous") {
        expect(plain.code).not.toBe(0);
        for (const r of remotes) expect(await onRemote(r.name, "feat")).toBe("");
      }
    }
  });
});
// The one known difference, kept on purpose (user decision 2026-11-05, "origin" among several): under `push.default=current`
// a plain `git push` goes to the upstream's remote, while the copied text names `origin` and says so.
test("push.default current: a plain git push goes to the upstream's remote, not the origin the copied text names", async () => {
  await withFlow("fork, push.default current, upstream/main with no selection, never pushed", async ({ repo, env }) => {
    const onRemote = async (remote: string) => (await gRaw(repo, ["ls-remote", "--", remote, "refs/heads/feat"], env)).out.split("\t")[0]!;
    await g(repo, ["push", "-q"], env);
    expect(await onRemote("upstream")).toBe((await g(repo, ["rev-parse", "refs/heads/feat"], env)).trim());
    expect(await onRemote("origin")).toBe("");
  });
});
// The selected remote is where a plain `git push` lands, on its own, whatever the upstream is called, so that is the remote
// the links may name. `push.default=upstream` refuses that push outright, so those cases have nothing to show here.
const selecting = Object.entries(counterparts.cases).filter(([, { facts: f }]) => {
  const selected = f.branch.pushRemote ?? f.pushDefault;
  return selected !== null && selected !== f.branch.upstreamRemote && !f.pushesToUpstream;
});
test("the counterpart fixture holds cases where another remote is selected", () => {
  expect(selecting.map(([, c]) => c.facts.branch.upstreamBranch)).toContain("feat");
  expect(selecting.some(([, c]) => c.facts.pushDefault !== null)).toBe(true);
});
for (const [name, { facts: f }] of selecting) test(`a plain git push lands on the selected remote: ${name}`, async () => {
  await withFlow(name, async ({ repo, env }) => {
    const selected = f.branch.pushRemote ?? f.pushDefault!;
    const onRemote = async (remote: string, ref: string) => (await gRaw(repo, ["ls-remote", "--", remote, `refs/heads/${ref}`], env)).out.split("\t")[0]!;
    const upstreamAtStart = await onRemote(f.branch.upstreamRemote, f.branch.upstreamBranch);
    expect(upstreamAtStart).toMatch(/^[0-9a-f]{40}$/); // a failed read would read as "not moved"
    await g(repo, ["push", "-q"], env);
    expect(await onRemote(selected, "feat")).toBe((await g(repo, ["rev-parse", "refs/heads/feat"], env)).trim());
    expect(await onRemote(f.branch.upstreamRemote, f.branch.upstreamBranch)).toBe(upstreamAtStart);
  });
});

for (const method of ["merge", "squash"] as const) test(`${method} PR evidence: a deploy or GitLab remote with a known default holds none, and its failed default walk costs nothing`, async () => {
  await setup(async ({ repo, env }) => {
    await g(repo, ["checkout", "-q", "-b", "work"], env);
    const work = await commitAt(repo, env, { "work": "done\n" }, "work", date(3));
    await g(repo, ["checkout", "-q", "main"], env);
    if (method === "merge") await g(repo, ["merge", "-q", "--no-ff", "-m", "Merge pull request #12 from org/work", "work"], env, { GIT_AUTHOR_DATE: date(4), GIT_COMMITTER_DATE: date(4) });
    else await commitAt(repo, env, { "work": "done\n" }, "Work (#12)", date(4));
    const merged = (await g(repo, ["rev-parse", "HEAD"], env)).trim();
    await g(repo, ["update-ref", "refs/remotes/origin/main", merged], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
    // A fetch writes `<remote>/HEAD` too (measured on Git 2.50.1), so a deploy target or another forge has a known default.
    for (const [name, url] of [["heroku", "https://git.heroku.com/app.git"], ["gitlab", "git@gitlab.com:org/repo.git"]] as const) {
      await g(repo, ["remote", "add", name, url], env);
      await g(repo, ["update-ref", `refs/remotes/${name}/main`, merged], env);
      await g(repo, ["symbolic-ref", `refs/remotes/${name}/HEAD`, `refs/remotes/${name}/main`], env);
    }
    const squashed = new Map(method === "squash" ? [["refs/heads/work", { number: 12, sha: merged, title: "Work" }]] : []);
    const f = await reach(repo, [work, merged], squashed);
    expect(f.remotes!.find((r) => r.name === "heroku")!.defaultBranch).toBe("main");
    expect([...new Set(f.prEvidence!.filter((e) => e.number === 12).map((e) => e.remote))]).toEqual(["origin"]);
  }, (a) => a.includes("rev-list") && a.at(-1) === "refs/remotes/heroku/main" ? ["sh", "-c", "exit 2"] : undefined);
});

test("no GitHub remote: a known default on a deploy remote supplies no PR evidence at all", async () => {
  await setup(async ({ repo, env }) => {
    await g(repo, ["remote", "set-url", "origin", "https://git.heroku.com/app.git"], env);
    await commitAt(repo, env, { "work": "done\n" }, "Work (#12)", date(4));
    const merged = (await g(repo, ["rev-parse", "HEAD"], env)).trim();
    await g(repo, ["update-ref", "refs/remotes/origin/main", merged], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
    expect((await reach(repo, [merged])).prEvidence).toEqual([]);
  });
});

const revLists = (spy: ReturnType<typeof gitEnv>) => spy.calls.filter((a) => a.includes("rev-list") && a.some((x) => x.startsWith("refs/remotes/")));

test("an empty page walks no remote's history, whatever the repo's remotes, and still reports their defaults", async () => {
  await setup(async ({ repo, env, base }, spy) => {
    await g(repo, ["update-ref", "refs/remotes/origin/main", base], env);
    await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
    const f = await reach(repo, []);
    expect(revLists(spy)).toEqual([]);
    expect(f.remotes!.map((r) => r.defaultBranch)).toEqual(["main"]);
    expect(f.reachableRemotes).toEqual([]);
    expect(f.prEvidence).toEqual([]);
  });
});

/** History with a long-merged commit, then a row's commit and its merge inside the window. */
async function historyWithMerge({ repo, env }: { repo: string; env: Record<string, string> }) {
  const old = await commitAt(repo, env, { "old": "old\n" }, "old", "2025-06-01T10:00:00Z");
  await g(repo, ["checkout", "-q", "-b", "work"], env);
  const member = await commitAt(repo, env, { "work": "done\n" }, "work", date(5));
  await g(repo, ["checkout", "-q", "main"], env);
  await g(repo, ["merge", "-q", "--no-ff", "-m", "Merge pull request #17 from org/work", "work"], env, { GIT_AUTHOR_DATE: date(6), GIT_COMMITTER_DATE: date(6) });
  const merged = (await g(repo, ["rev-parse", "HEAD"], env)).trim();
  await g(repo, ["update-ref", "refs/remotes/origin/main", merged], env);
  await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
  return { old, member, merged };
}

test("one remote: both walks stop at the window's margin, and a row's commit and its merge commit are still found", async () => {
  await setup(async (fx, spy) => {
    const { member, merged } = await historyWithMerge(fx);
    const f = await reach(fx.repo, [member, merged]);
    expect(f.reachableRemotes).toEqual([{ sha: member, remotes: ["origin"] }, { sha: merged, remotes: ["origin"] }]);
    expect(f.prEvidence).toEqual([{ number: 17, sha: member, remote: "origin", method: "merge" }]);
    const walks = revLists(spy);
    expect(walks.length).toBe(2);
    for (const walk of walks) {
      const at = walk.indexOf("--end-of-options");
      expect(walk.slice(0, at)).toContain(`--since=${new Date(Date.parse("2026-01-01T00:00:00Z") - 30 * 864e5).toISOString()}`);
    }
  });
});

test("one remote: a commit older than the margin loses its link and nothing else, so the PR on the same row keeps its evidence", async () => {
  await setup(async (fx) => {
    const { old, member, merged } = await historyWithMerge(fx);
    const f = await reach(fx.repo, [old, member, merged]);
    expect(f.reachableRemotes!.find((r) => r.sha === old)).toEqual({ sha: old, remotes: [] });
    expect(f.reachableRemotes!.find((r) => r.sha === merged)).toEqual({ sha: merged, remotes: ["origin"] });
    expect(f.prEvidence).toEqual([{ number: 17, sha: member, remote: "origin", method: "merge" }]);
  });
});

test("two remotes: a commit dated before the margin on top of the evidence cannot make the other remote look like its only holder", async () => {
  await setup(async (fx, spy) => {
    const { repo, env } = fx;
    const { member, merged } = await historyWithMerge(fx);
    // A wrong clock on upstream's default: a child dated long before its parent, where git's plain `--since` stops walking.
    await g(repo, ["remote", "add", "upstream", "https://github.com/up/repo"], env);
    await g(repo, ["checkout", "-q", "-b", "skewed"], env);
    const skewed = await commitAt(repo, env, { "skewed": "s\n" }, "skewed", "2025-01-01T10:00:00Z");
    await g(repo, ["checkout", "-q", "main"], env);
    await g(repo, ["update-ref", "refs/remotes/upstream/main", skewed], env);
    await g(repo, ["symbolic-ref", "refs/remotes/upstream/HEAD", "refs/remotes/upstream/main"], env);
    const f = await reach(repo, [member, merged]);
    expect(f.reachableRemotes).toEqual([{ sha: member, remotes: ["origin", "upstream"] }, { sha: merged, remotes: ["origin", "upstream"] }]);
    expect(f.prEvidence!.map((e) => e.remote).sort()).toEqual(["origin", "upstream"]);
    for (const walk of revLists(spy)) expect(walk.some((a) => a.startsWith("--since="))).toBe(false);
  });
});

test("cardKeys: a detached checkout, where roots still list the real folder and no branch has a checkout", async () => {
  await setup(async ({ repo, env }) => {
    await g(repo, ["checkout", "-q", "--detach"], env);
    const { rg, commonDir } = await ctx(repo);
    const f = await readCheckoutFacts(rg, commonDir, await readRemoteFacts(rg, commonDir), { GUI: { repo, root: "apps/gui" } }, ["main"]);
    expect(f.cardKeys).toEqual(["gui"]);
    expect(f.branches!.find((b) => b.name === "main")!.checkoutPath).toBeNull();
    // Settings lists it as the project it is, rather than "Not checked yet" for the length of a rebase.
    expect(f.roots).toEqual([{ root: "apps/gui", project: projectKey(repo, "apps/gui"), labelKeys: ["gui"], displayLabel: "GUI" }]);
  });
});

test("cardKeys: a label whose folder is not on the checked-out branch still joins its card, with no root to launch", async () => {
  await setup(async ({ repo }) => {
    const { rg, commonDir } = await ctx(repo);
    const f = await readCheckoutFacts(rg, commonDir, await readRemoteFacts(rg, commonDir), { Gone: { repo, root: "not/here" }, Quant: { repo, root: "apps/gui" }, Other: { repo: "/nowhere", root: null } }, ["main"]);
    expect(f.cardKeys).toEqual(["gone", "quant"]);
    expect(f.roots!.flatMap((r) => r.labelKeys)).toEqual(["quant"]);
  });
});

test("cardKeys: no record gives none; a credential-shaped key never crosses; a later failure leaves the join it already had", async () => {
  await setup(async ({ repo }) => {
    const { rg, commonDir } = await ctx(repo);
    const facts = await readRemoteFacts(rg, commonDir);
    expect((await readCheckoutFacts(rg, commonDir, facts, null, ["main"])).cardKeys).toEqual([]);
    const secret = "ghp_" + "S".repeat(36);
    expect((await readCheckoutFacts(rg, commonDir, facts, { [secret]: { repo, root: null } }, ["main"])).cardKeys).toEqual([]);
  });
  let topFails = false;
  await setup(async ({ repo }) => {
    const { rg, commonDir } = await ctx(repo);
    const facts = await readRemoteFacts(rg, commonDir);
    topFails = true;
    const f = await readCheckoutFacts(rg, commonDir, facts, { GUI: { repo, root: "apps/gui" } }, ["main"]);
    expect(f.roots).toBeNull();
    expect(f.cardKeys).toEqual(["gui"]);
  }, (a) => topFails && a.includes("--show-toplevel") ? ["sh", "-c", "exit 2"] : undefined);
  await setup(async ({ repo }) => {
    const { rg, commonDir } = await ctx(repo);
    const f = await readCheckoutFacts({ ...rg, repo: repo + "-gone" }, commonDir, await readRemoteFacts(rg, commonDir), { GUI: { repo, root: "apps/gui" } }, ["main"]);
    expect(f.cardKeys).toBeNull();
  });
});
