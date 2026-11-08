import "./fixtures/isolate-state";
import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fs from "node:fs/promises";
import { startGitBudget } from "../src/git";
import { hardenArgs } from "../src/repos/harden";
import { reposStatus, repoKeyFor, REPOS_STATUS_BUDGET_MS } from "../src/repos/status";
import { parseGithub, readRemoteFacts, refFormatOk, safeFactName } from "../src/repos/remotes";
import { readReachFacts } from "../src/repos/reach";
import { readCheckoutFacts, projectKey } from "../src/repos/checkouts";
import { encodeStamp, globalConfigCandidates, parseConfigOrigins, readActionFacts, readStatInputs, selectStatInputs, STAT_INPUTS_CAP } from "../src/repos/facts";
import type { RepoGit } from "../src/repos/hgit";
import type { RepoFacts } from "../src/repos/types";
import { scratch, g, commitAt, gitEnv } from "./fixtures/repos-fixtures";

const vectors: { github: { url: string; expected: { owner: string; repo: string } | null }[] } =
  JSON.parse(readFileSync(new URL("../gui/src-tauri/tests/fixtures/github-target-vectors.json", import.meta.url), "utf8"));
const contract: {
  actionFacts: { statInputs: StatInputs }[]; reply: unknown; spanningRepos: { actionFacts: { statInputs: StatInputs }[] }; expectedTargets: string[];
  expectedSinks: Record<"open" | "copy" | "editor", unknown[]>;
  stampVectors: { name: string; bytes?: number; mtimeSeconds?: number; linkTo?: string; expected: { mtimeNs?: string; size?: string; kind: string; target: string | null } }[];
} = JSON.parse(readFileSync(new URL("../gui/src-tauri/tests/fixtures/action-facts-vectors.json", import.meta.url), "utf8"));

type StatInputs = NonNullable<RepoFacts["statInputs"]>;

const key = (prefix: string, p: string) => prefix + createHash("sha256").update(p).digest("hex").slice(0, 12);
const dates = [2, 3, 4, 5, 6].map((d) => `2026-01-0${d}T10:00:00Z`);

// One canonical root, one explicit env on BOTH spawn routes. Never use buildRepo here (plan P-H1/Q-M1).
async function fixture() {
  const root = realpathSync(scratch("facts-contract"));
  const repo = join(root, "repo");
  const env = {
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1",
    HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg"),
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
  };
  for (const dir of [repo, env.HOME, env.XDG_CONFIG_HOME]) mkdirSync(dir);
  writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Test\n\temail = test@example.com\n");
  // `--template=`: a host's template decides whether `.git/branches` exists, and that is a stat input (T7).
  await g(repo, ["init", "-q", "--template=", "-b", "main"], env);
  // One input of every stamp kind for the shared fixture: `branches` a directory, `inc.config` a symlink.
  mkdirSync(join(repo, ".git/branches"));
  writeFileSync(join(root, "inc-target.config"), "[fixture]\n\tmarker = 1\n");
  symlinkSync("inc-target.config", join(root, "inc.config"));
  await g(repo, ["config", "include.path", join(root, "inc.config")], env);
  await commitAt(repo, env, { "apps/gui/base.txt": "base\n" }, "base", dates[0]!);
  await g(repo, ["remote", "add", "origin", "https://github.com/org/repo.git"], env);
  await g(repo, ["checkout", "-q", "-b", "pr-work"], env);
  const merged = await commitAt(repo, env, { "apps/gui/merged.txt": "merged\n" }, "PR work", dates[1]!);
  await g(repo, ["checkout", "-q", "main"], env);
  await g(repo, ["merge", "--no-ff", "-q", "-m", "Merge pull request #12 from org/pr-work", "pr-work"], env,
    { GIT_AUTHOR_DATE: dates[2]!, GIT_COMMITTER_DATE: dates[2]! });
  await g(repo, ["branch", "-D", "pr-work"], env);
  await g(repo, ["update-ref", "refs/remotes/origin/main", "HEAD"], env);
  await g(repo, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
  await g(repo, ["checkout", "-q", "-b", "feature/contract"], env);
  const pushed = await commitAt(repo, env, { "apps/gui/feature.txt": "pushed\n" }, "pushed", dates[3]!);
  await g(repo, ["update-ref", "refs/remotes/origin/feature/contract", pushed], env);
  await g(repo, ["config", "branch.feature/contract.remote", "origin"], env);
  await g(repo, ["config", "branch.feature/contract.merge", "refs/heads/feature/contract"], env);
  const unpushed = await commitAt(repo, env, { "apps/gui/feature.txt": "local\n" }, "local", dates[4]!);
  const history = await g(repo, ["log", "--all", "--format=%an %ae %ad %cn %ce %cd", "--date=raw"], env);
  const stamps = new Set(dates.map((d) => `${Date.parse(d) / 1000} +0000`));
  for (const line of history.trim().split("\n")) {
    const m = /^Test test@example.com (\d+ \+0000) Test test@example.com (\d+ \+0000)$/.exec(line);
    expect(m).not.toBeNull();
    expect(stamps.has(m![1]!)).toBe(true);
    expect(stamps.has(m![2]!)).toBe(true);
  }
  return { root, repo, env, merged, pushed, unpushed };
}

async function context(repo: string): Promise<{ rg: RepoGit; commonDir: string; gitDir: string }> {
  const budget = startGitBudget(60_000);
  const h = await hardenArgs(repo, budget, { lazyFetch: true });
  if ("unknown" in h) throw new Error(h.unknown);
  return { rg: { repo, lead: h.lead, budget }, commonDir: h.commonDir, gitDir: h.gitDir };
}

async function usingFixture(fn: (fx: Awaited<ReturnType<typeof fixture>>, spy: ReturnType<typeof gitEnv>) => Promise<void>, substitute?: (argv: string[]) => string[] | undefined) {
  const fx = await fixture();
  const prev = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = fx.env.HOME;
  process.env.XDG_CONFIG_HOME = fx.env.XDG_CONFIG_HOME;
  const spy = gitEnv({ GIT_CONFIG_GLOBAL: fx.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: "1", HOME: fx.env.HOME, XDG_CONFIG_HOME: fx.env.XDG_CONFIG_HOME }, substitute);
  try { await fn(fx, spy); } finally {
    spy.restore();
    process.env.HOME = prev.HOME;
    process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME!;
  }
}

async function status(fx: Awaited<ReturnType<typeof fixture>>, overallMs = REPOS_STATUS_BUDGET_MS, extraRepos: string[] = []) {
  const { repo, root, merged, pushed, unpushed } = fx;
  const result = await reposStatus({
    scope: "all", pageDate: "2026-01-11",
    labels: [{ key: "repo", tokens: [] }, { key: "gui", tokens: [merged, pushed, unpushed] }],
    branches: [{ key: "gui", name: "feature/contract" }],
  }, {
    now: () => new Date("2026-01-11T00:00:00Z"), tmpRoot: root, budgets: { overallMs },
    readRecord: async () => ({ accepted: true, record: {
      schemaVersion: 1, date: "2026-01-11", repos: [repo, ...extraRepos], windowStartUtc: "2026-01-01T00:00:00.000Z",
      labels: { Repo: { repo, root: null }, GUI: { repo, root: "apps/gui" } },
      commits: [merged, pushed, unpushed].map((sha) => ({ sha, repo, label: "GUI" })), missing: [],
    } }),
  });
  if (result.scope !== "all") throw new Error("expected all reply");
  return result;
}

test("a remote-ref listing that runs out the facts deadline gives remoteBranches null and keeps the remote facts", async () => {
  await usingFixture(async (fx) => {
    const { rg, commonDir, gitDir } = await context(fx.repo);
    const started = performance.now();
    const facts = await readActionFacts([{ rg, commonDir, gitDir, commits: [fx.pushed], squashed: new Map() }], {
      branches: [], overall: startGitBudget(1_500), concurrency: 1,
      windowStart: new Date("2026-01-01"), now: new Date("2026-01-11"), labels: null,
    });
    expect(performance.now() - started).toBeLessThan(5_000);
    expect(facts).toHaveLength(1);
    expect(facts[0]!.remoteBranches).toBeNull();
    expect(facts[0]!.remotes![0]!.name).toBe("origin");
  }, (a) => a.includes("for-each-ref") && a.some((x) => x.includes("%(symref)")) ? ["sh", "-c", "sleep 30"] : undefined);
}, 15_000);

/** Plan P-H1 rule 3, and rule 1 for each stat input's path and symlink target: assert the R5-M1 grammar, then take
 *  `mtimeNs` and `size` from the fixture's entry for that path. Kinds and targets are compared unreplaced. */
function normalStats(inputs: StatInputs | null, root: string, expected: StatInputs): StatInputs {
  expect(inputs).not.toBeNull();
  return inputs!.map((i) => {
    const stamp = i.stamp!;
    expect(stamp).not.toBeNull();
    expect(stamp.mtimeNs).toMatch(/^-?(0|[1-9][0-9]*)$/);
    expect(stamp.size).toMatch(/^(0|[1-9][0-9]*)$/);
    expect(["file", "dir", "symlink", "missing"]).toContain(stamp.kind);
    expect(typeof stamp.target === "string").toBe(stamp.kind === "symlink");
    const path = i.path.replace(root, "/fixture");
    const want = expected.find((e) => e.path === path)?.stamp;
    return { path, stamp: { ...stamp, mtimeNs: want?.mtimeNs ?? stamp.mtimeNs, size: want?.size ?? stamp.size, target: stamp.target?.replace(root, "/fixture") ?? null } };
  });
}

/** The fixture holds the facts and the reply apart; the engine prints them as one document. */
const spanning = (v: unknown) => {
  const { actionFacts, reply } = v as { actionFacts: unknown; reply: object };
  return { ...reply, actionFacts };
};

const isFactsRead = (argv: string[]) => argv.slice(-3).join(" ") === "config --null --list";

for (const v of vectors.github) test(`GitHub raw form: ${JSON.stringify(v.url)}`, () => {
  expect(parseGithub(v.url)).toEqual(v.expected);
});

test("action facts contract: assembled reply, root containment, canonical keys, fixed identity/dates", async () => {
  await usingFixture(async (fx) => {
    const { root, repo } = fx;
    const { actionFacts, repos, ...reply } = await status(fx);
    expect(actionFacts).toHaveLength(1);
    const facts = actionFacts[0]!;
    expect(facts.path).toBe(repo);
    expect(facts.repoKey).toBe(repoKeyFor(repo));
    expect(key("r", repo)).toBe(repoKeyFor(repo));
    function contained(v: unknown): void {
      if (typeof v === "string" && v.startsWith("/")) expect(v === root || v.startsWith(root + "/")).toBe(true);
      else if (Array.isArray(v)) v.forEach(contained);
      else if (v && typeof v === "object") Object.values(v).forEach(contained);
    }
    contained(facts);
    for (const r of facts.roots!) expect(r.project).toBe(createHash("sha256").update(repo + "\0" + r.root).digest("hex").slice(0, 32));
    const normal = {
      ...facts, path: "/fixture/repo", repoKey: key("r", "/fixture/repo"),
      branches: facts.branches!.map((b) => ({ ...b, checkoutPath: b.checkoutPath?.replace(root, "/fixture") ?? null })),
      roots: facts.roots!.map((r) => ({ ...r, project: projectKey("/fixture/repo", r.root) })),
      statInputs: normalStats(facts.statInputs, root, contract.actionFacts[0]!.statInputs),
    };
    expect<unknown>([normal]).toEqual(contract.actionFacts);
    const normalReply = {
      ...reply,
      repoViews: reply.repoViews.map((r) => ({ ...r, key: key("r", "/fixture/repo"), storeKey: key("s", "/fixture/repo/.git"), treeKey: key("t", "/fixture/repo") })),
      labels: reply.labels.map((l) => ({ ...l, repoKey: l.repoKey === null ? null : key("r", "/fixture/repo") })),
      pushCards: reply.pushCards.map((c) => ({ ...c, repoKey: key("r", "/fixture/repo"), storeKey: key("s", "/fixture/repo/.git") })),
    };
    expect(repos).toHaveLength(1);
    expect(repos[0]!.path).toBe(repo);
    for (const r of reply.repoViews) {
      expect(r.key).toBe(key("r", repo));
      expect("storeKey" in r && r.storeKey).toBe(key("s", join(repo, ".git")));
      expect("treeKey" in r && r.treeKey).toBe(key("t", repo));
    }
    expect<unknown>(normalReply).toEqual(contract.reply);
    expect(contract.expectedTargets).toEqual(["pr", "branch", "commit", "compare", "editor", "copy"]);
    for (const kind of ["copy", "open", "editor"] as const) {
      expect(contract.expectedSinks[kind]).toHaveLength(1);
      expect(JSON.stringify(contract.expectedSinks[kind][0]).length).toBeGreaterThan(2);
    }
  });
}, 15_000);

// The record's label names repo A, and a hidden commit of that label lives in repo B: the card's rows then hold B's
// `main` under A's repoKey (status.ts). Rust's mint reads this same literal (tests/actions.rs).
test("spanning repos contract: a card's rows can hold another repo's row under its one repoKey", async () => {
  const root = realpathSync(scratch("span"));
  const a = join(root, "a"), b = join(root, "b");
  const env = {
    GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", HOME: join(root, "home"), XDG_CONFIG_HOME: join(root, "xdg"),
    GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@example.com",
  };
  for (const dir of [a, b, env.HOME, env.XDG_CONFIG_HOME]) mkdirSync(dir);
  writeFileSync(env.GIT_CONFIG_GLOBAL, "[user]\n\tname = Test\n\temail = test@example.com\n");
  await g(a, ["init", "-q", "--template=", "-b", "main"], env);
  const aBase = await commitAt(a, env, { "a.txt": "a\n" }, "a base", dates[0]!);
  await g(a, ["remote", "add", "origin", "https://github.com/org/a.git"], env);
  await g(a, ["update-ref", "refs/remotes/origin/main", aBase], env);
  await g(a, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
  await g(a, ["checkout", "-q", "-b", "a-work"], env);
  const aWork = await commitAt(a, env, { "work.txt": "work\n" }, "a work", dates[1]!);
  await g(a, ["update-ref", "refs/remotes/origin/a-work", aWork], env);
  await g(a, ["config", "branch.a-work.remote", "origin"], env);
  await g(a, ["config", "branch.a-work.merge", "refs/heads/a-work"], env);
  await g(b, ["init", "-q", "--template=", "-b", "main"], env);
  const bMain = await commitAt(b, env, { "b.txt": "b\n" }, "b main", dates[2]!);
  await g(b, ["remote", "add", "origin", "https://github.com/org/b.git"], env);
  await g(b, ["update-ref", "refs/remotes/origin/main", bMain], env);
  await g(b, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"], env);
  const prev = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = env.HOME;
  process.env.XDG_CONFIG_HOME = env.XDG_CONFIG_HOME;
  const spy = gitEnv({ GIT_CONFIG_GLOBAL: env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: "1", HOME: env.HOME, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME });
  try {
    const result = await reposStatus({ scope: "all", pageDate: "2026-01-11", labels: [{ key: "gui", tokens: [aWork] }], branches: [] }, {
      now: () => new Date("2026-01-11T00:00:00Z"), tmpRoot: root,
      readRecord: async () => ({ accepted: true, record: {
        schemaVersion: 1, date: "2026-01-11", repos: [a, b], windowStartUtc: "2026-01-01T00:00:00.000Z",
        labels: { GUI: { repo: a, root: null } },
        commits: [{ sha: aWork, repo: a, label: "GUI" }, { sha: bMain, repo: b, label: "GUI" }], missing: [bMain],
      } }),
    });
    if (result.scope !== "all") throw new Error("expected all reply");
    const { repos: _repos, ...printed } = result;
    const reply = { ...printed, actionFacts: printed.actionFacts.map((f, i) => ({ ...f, statInputs: normalStats(f.statInputs, root, contract.spanningRepos.actionFacts[i]!.statInputs).map((x) => ({ ...x, path: x.path.replace("/fixture", root) })) })) };
    expect(reply.labels[0]!.repoKey).toBe(repoKeyFor(a));
    expect(reply.labels[0]!.rows.map((r) => [r.kind, "name" in r ? r.name : null, r.commits.map((c) => c.sha)])).toEqual([
      ["branch", "a-work", [aWork]], ["default", "main", [bMain]],
    ]);
    const factsOf = (p: string) => reply.actionFacts.find((f) => f.path === p)!;
    expect(factsOf(a).reachableRemotes!.map((r) => r.sha)).toEqual([aWork]);
    expect(factsOf(b).reachableRemotes!.map((r) => r.sha)).toEqual([bMain]);
    // The normalisation: the root to `/fixture`, then each path-derived key recomputed from its normalised path.
    let text = JSON.stringify(reply);
    for (const [path, normal] of [[a, "/fixture/a"], [b, "/fixture/b"]] as const) {
      for (const [prefix, suffix] of [["r", ""], ["s", "/.git"], ["t", ""]] as const) text = text.split(key(prefix, path + suffix)).join(key(prefix, normal + suffix));
      text = text.split(projectKey(path, "")).join(projectKey(normal, ""));
    }
    expect<unknown>(JSON.parse(text.split(root).join("/fixture"))).toEqual(spanning(contract.spanningRepos));
  } finally {
    spy.restore();
    process.env.HOME = prev.HOME;
    process.env.XDG_CONFIG_HOME = prev.XDG_CONFIG_HOME!;
  }
}, 20_000);

for (const overallMs of [REPOS_STATUS_BUDGET_MS, 4_500]) test(`facts budget exhaustion preserves B1 byte for byte (overall ${overallMs} ms)`, async () => {
  let mode: "on" | "off" | "slow" = "on";
  let intercepted = 0;
  await usingFixture(async (fx) => {
    const healthy = await status(fx, overallMs);
    expect(healthy.actionFacts).toHaveLength(1);
    mode = "off";
    const off = await status(fx, overallMs);
    expect(off.actionFacts).toEqual([]);
    mode = "slow";
    const started = performance.now();
    const slow = await status(fx, overallMs);
    expect(performance.now() - started).toBeLessThan(Math.min(overallMs, 9_000));
    expect(intercepted).toBe(2);
    expect(slow.actionFacts).toEqual([]);
    const { actionFacts: _healthy, ...healthyB1 } = healthy;
    const { actionFacts: _off, ...offB1 } = off;
    const { actionFacts: _slow, ...slowB1 } = slow;
    expect(JSON.stringify(slowB1)).toBe(JSON.stringify(offB1));
    expect(JSON.stringify(slowB1)).toBe(JSON.stringify(healthyB1));
    expect(slow.repoViews.every((r) => r.state === "ok")).toBe(true);
  }, (argv) => {
    if (!isFactsRead(argv) || mode === "on") return;
    intercepted++;
    return mode === "off" ? ["sh", "-c", "exit 1"] : ["sh", "-c", "exec sleep 30"];
  });
}, 30_000);

test("one repo's facts timeout leaves another repo's facts and both B1 states intact", async () => {
  let slowRepo = "";
  let intercepted = 0;
  await usingFixture(async (fx) => {
    slowRepo = fx.repo;
    const fast = join(fx.root, "fast");
    mkdirSync(fast);
    await g(fast, ["init", "-q", "-b", "main"], fx.env);
    await commitAt(fast, fx.env, { "f.txt": "fast\n" }, "fast", dates[0]!);
    const started = performance.now();
    const result = await status(fx, 7_000, [fast]);
    expect(performance.now() - started).toBeLessThan(7_000);
    expect(intercepted).toBe(1);
    expect(result.actionFacts.map((f) => f.path)).toEqual([fast]);
    expect(result.actionFacts[0]!.branches![0]!.checkoutPath).toBeNull(); // main is not in this request
    expect(result.repoViews.map((r) => r.state)).toEqual(["ok", "ok"]);
  }, (argv) => {
    if (argv[2] !== slowRepo || !isFactsRead(argv)) return;
    intercepted++;
    return ["sh", "-c", "exec sleep 30"];
  });
}, 15_000);

test("no remaining overall budget starts no facts reads", async () => {
  await usingFixture(async (fx, spy) => {
    const result = await status(fx, 0);
    expect(result.actionFacts).toEqual([]);
    expect(spy.calls.some(isFactsRead)).toBe(false);
  });
});

// The deadline's timer wins the race in this test, so it stops the wait. The re-check after the race has its own test below.
for (const phase of ["remote realpath", "checkout stat"] as const) {
  test(`the facts deadline stops waiting on a stalled ${phase}`, async () => {
    await usingFixture(async (fx) => {
      const { rg, commonDir, gitDir } = await context(fx.repo);
      const realpath = fs.realpath, stat = fs.stat;
      let release!: () => void;
      const held = new Promise<void>((resolve) => { release = resolve; });
      const pending: Promise<unknown>[] = [];
      let repoRealpaths = 0;
      const realpathSpy = spyOn(fs, "realpath").mockImplementation(((...args: Parameters<typeof fs.realpath>) => {
        if (phase !== "remote realpath" || args[0] !== fx.repo) return realpath(...args);
        // The first canonical read stamps the main-checkout identity; stall the remote facts read after it.
        if (++repoRealpaths === 1) return realpath(...args);
        const read = held.then(() => realpath(...args));
        pending.push(read);
        return read;
      }) as typeof fs.realpath);
      const statSpy = spyOn(fs, "stat").mockImplementation(((...args: Parameters<typeof fs.stat>) => {
        if (phase !== "checkout stat" || args[0] !== join(fx.repo, "apps/gui")) return stat(...args);
        const read = held.then(() => stat(...args));
        pending.push(read);
        return read;
      }) as typeof fs.stat);
      // No read starts with 1 000 ms or less remaining (`perCallTimeoutMs`), so a budget's usable window is 1 000 ms
      // shorter than its length. 4 000 leaves 3 000 for the work before the held read; 1 500 left 500, which that work
      // took under load (measured 477-591 ms), so the checkout read was skipped and `pending` stayed empty.
      const emergency = setTimeout(release, 6_000);
      const started = performance.now();
      try {
        const facts = await readActionFacts([{ rg, commonDir, gitDir, commits: [fx.pushed], squashed: new Map() }], {
          branches: [], overall: startGitBudget(4_000), concurrency: 1,
          windowStart: new Date("2026-01-01"), now: new Date("2026-01-11"),
          labels: { GUI: { repo: fx.repo, root: "apps/gui" } },
        });
        expect(pending).toHaveLength(1); // Prove this was a filesystem stall, not a git failure.
        if (phase === "remote realpath") expect(facts).toEqual([]);
        else {
          expect(facts).toHaveLength(1);
          expect(facts[0]!.roots).toBeNull();
          expect(facts[0]!.remoteBranches!.map((b) => b.name)).toEqual(["feature/contract", "main"]);
          expect(facts[0]!.branches!.every((b) => b.checkoutPath === null)).toBe(true);
          expect(facts[0]!.remotes![0]).toMatchObject({ name: "origin", defaultBranch: "main" });
          expect(facts[0]!.reachableRemotes).toEqual([{ sha: fx.pushed, remotes: ["origin"] }]);
        }
        expect(performance.now() - started).toBeLessThan(5_500);
      } finally {
        release();
        clearTimeout(emergency);
        await Promise.allSettled(pending);
        realpathSpy.mockRestore();
        statSpy.mockRestore();
      }
    });
  }, 15_000);
}

test("a checkout read that wins the race after the clock's deadline is discarded", async () => {
  await usingFixture(async (fx) => {
    const { rg, commonDir, gitDir } = await context(fx.repo);
    const realNow = performance.now.bind(performance);
    const stat = fs.stat;
    let offset = 0;
    let statsHeld = 0;
    const nowSpy = spyOn(performance, "now").mockImplementation(() => realNow() + offset);
    const statSpy = spyOn(fs, "stat").mockImplementation(((...args: Parameters<typeof fs.stat>) => {
      if (args[0] !== join(fx.repo, "apps/gui")) return stat(...args);
      // The clock passes the deadline while the read is out, but the read still settles first: the real timer has
      // most of a minute left, so only the re-check after the race can discard this result.
      statsHeld++;
      offset += 3_600_000;
      return stat(...args);
    }) as typeof fs.stat);
    try {
      const facts = await readActionFacts([{ rg, commonDir, gitDir, commits: [fx.pushed], squashed: new Map() }], {
        branches: [], overall: startGitBudget(60_000), concurrency: 1,
        windowStart: new Date("2026-01-01"), now: new Date("2026-01-11"),
        labels: { GUI: { repo: fx.repo, root: "apps/gui" } },
      });
      expect(statsHeld).toBe(1); // The checkout read ran, so the null below is the discard, not a skipped read.
      expect(facts).toHaveLength(1);
      expect(facts[0]!.roots).toBeNull();
    } finally {
      statSpy.mockRestore();
      nowSpy.mockRestore();
    }
  });
}, 15_000);

test("two raw URLs refuse web links; effective push rewriting is read separately", async () => {
  await usingFixture(async ({ repo, env }, spy) => {
    await g(repo, ["config", "--add", "remote.origin.url", "https://github.com/other/repo"], env);
    await g(repo, ["config", "remote.origin.pushurl", "ssh://push.example/repo"], env);
    const { rg, commonDir } = await context(repo);
    const r = (await readRemoteFacts(rg, commonDir)).remotes!.find((r) => r.name === "origin")!;
    expect(r.github).toBeNull();
    expect(r.transport).toBe("network");
    expect(spy.calls.some((a) => a.slice(-6).join(" ") === "remote get-url --push --all -- origin")).toBe(true);
    const text = JSON.stringify(r);
    expect(text).not.toContain("push.example");
    expect(text).not.toContain("https:");
  });
});

test("web links ignore insteadOf, pushInsteadOf and pushurl; push uses every effective destination", async () => {
  await usingFixture(async ({ repo, env }) => {
    await g(repo, ["config", "url.file:///local/.pushInsteadOf", "https://github.com/"], env);
    await g(repo, ["config", "url.https://github.com/other/.insteadOf", "https://github.com/org/"], env);
    const { rg, commonDir } = await context(repo);
    let r = (await readRemoteFacts(rg, commonDir)).remotes![0]!;
    expect(r.github).toEqual({ owner: "org", repo: "repo" }); // Raw `remote.<name>.url`: never `other/repo`.
    expect(r.transport).toBe("refused");
    await g(repo, ["config", "remote.origin.pushurl", "ssh://host/repo"], env);
    await g(repo, ["config", "--add", "remote.origin.pushurl", "file:///local/repo"], env);
    r = (await readRemoteFacts(rg, commonDir)).remotes![0]!;
    expect(r.transport).toBe("refused");
    await g(repo, ["config", "remote.origin.vcs", ""], env);
    expect((await readRemoteFacts(rg, commonDir)).remotes![0]!.vcs).toBe(true);
  });
});

for (const kind of ["remotes", "branches"]) for (const configured of [false, true]) {
  test(`legacy ${kind}/origin: config (${configured ? "b: section and url" : "a: no section, upstream and sole remote"})`, async () => {
    await usingFixture(async ({ repo, env }) => {
      const { rg, commonDir } = await context(repo);
      if (!configured) await g(repo, ["config", "--remove-section", "remote.origin"], env);
      mkdirSync(join(commonDir, kind), { recursive: true });
      writeFileSync(join(commonDir, kind, "origin"), "URL: https://host/repo\nPush: refs/heads/feature:refs/heads/other\n");
      const facts = await readRemoteFacts(rg, commonDir);
      const r = facts.remotes!.find((r) => r.name === "origin")!;
      expect(r.configSection).toBe(configured);
      expect(r.url).toBe(configured);
      expect(r.legacy).toBe(true);
      expect(r.push).toBe(false);
      expect(facts.legacyNames).toEqual(["origin"]);
      expect(facts.branches![0]!.upstreamRemote).toBe("origin");
    });
  });
}

test("section, url, push refspec and selected missing remote are distinct facts", async () => {
  await usingFixture(async ({ repo, env }) => {
    await g(repo, ["config", "remote.empty.fetch", "+refs/heads/*:refs/remotes/empty/*"], env);
    await g(repo, ["config", "remote.origin.push", "refs/heads/feature:refs/heads/other"], env);
    await g(repo, ["config", "branch.main.remote", "missing"], env);
    await g(repo, ["config", "branch.main.merge", "refs/heads/upstream/name"], env);
    await g(repo, ["config", "branch.main.pushRemote", "override"], env);
    await g(repo, ["config", "remote.pushDefault", "default-push"], env);
    const { rg, commonDir } = await context(repo);
    const f = await readRemoteFacts(rg, commonDir);
    expect(f.remotes!.find((r) => r.name === "empty")).toMatchObject({ configSection: true, url: false, legacy: false });
    expect(f.remotes!.find((r) => r.name === "missing")).toMatchObject({ configSection: false, url: false, legacy: false });
    expect(f.remotes!.find((r) => r.name === "origin")!.push).toBe(true);
    expect(f.pushDefault).toBe("default-push");
    expect(f.branches!.find((b) => b.name === "main")).toMatchObject({ upstreamRemote: "missing", upstreamBranch: "upstream/name", pushRemote: "override" });
  });
});

test("credential-shaped names and dependent branches are omitted; raw URL secrets never enter facts", async () => {
  await usingFixture(async ({ repo, env }) => {
    const token = "ghp_" + "A".repeat(36);
    await g(repo, ["remote", "add", token, `https://user:${token}@host/${token}?secret=${token}`], env);
    await g(repo, ["branch", token], env);
    // Each part of the guard on its own: a healthy remote with a credential-shaped merge, a credential-shaped remote, and a
    // URL with a credential in it. These are dropped whole, unlike a URL that is only not a remote name.
    await g(repo, ["config", "branch.main.remote", "origin"], env);
    await g(repo, ["config", "branch.main.merge", `refs/heads/${token}`], env);
    await g(repo, ["branch", "by-remote"], env);
    await g(repo, ["config", "branch.by-remote.remote", token], env);
    await g(repo, ["config", "branch.by-remote.merge", "refs/heads/target"], env);
    await g(repo, ["branch", "by-url"], env);
    await g(repo, ["config", "branch.by-url.pushRemote", `https://user:${token}@host/x`], env);
    await g(repo, ["config", "remote.origin.url", `https://github.com/org/${token}`], env);
    const { rg, commonDir } = await context(repo);
    const f = await readRemoteFacts(rg, commonDir);
    expect(JSON.stringify(f).toLowerCase()).not.toContain(token.toLowerCase());
    expect(JSON.stringify(f)).not.toContain("[redacted]");
    for (const name of ["main", "by-remote", "by-url"]) expect(`${name}: ${f.branches!.some((b) => b.name === name)}`).toBe(`${name}: false`);
    expect(f.remotes!.find((r) => r.name === "origin")!.github).toBeNull();
  });
});

for (const source of ["upstream", "pushRemote", "pushDefault", "config", "legacy"] as const) {
  test(`URL-shaped remote names and dependent facts are omitted: ${source}`, async () => {
    await usingFixture(async ({ repo, env }) => {
      const name = source === "legacy" ? "host:opaque=secret" : "https://example.test/path?opaque=secret";
      const { rg, commonDir } = await context(repo);
      if (source === "upstream") {
        await g(repo, ["config", "branch.main.remote", name], env);
        await g(repo, ["config", "branch.main.merge", "refs/heads/main"], env);
      } else if (source === "pushRemote") await g(repo, ["config", "branch.main.pushRemote", name], env);
      else if (source === "pushDefault") await g(repo, ["config", "remote.pushDefault", name], env);
      else if (source === "config") await g(repo, ["config", `remote.${name}.url`, "https://github.com/org/repo"], env);
      else {
        mkdirSync(join(commonDir, "remotes"));
        writeFileSync(join(commonDir, "remotes", name), "URL: https://host/repo\n");
      }
      const facts = await readRemoteFacts(rg, commonDir);
      expect(JSON.stringify(facts)).not.toContain(name);
      expect(facts.remotes!.some((r) => r.name === "origin")).toBe(true);
      if (source === "upstream" || source === "pushRemote") {
        // Only not a remote name: the branch stays, and says so. The nulls alone would read as "no upstream".
        expect(facts.branches!.find((b) => b.name === "main")).toMatchObject({ upstreamRemote: null, upstreamBranch: null, pushRemote: null, remoteFactsUnknown: true });
      } else if (source === "pushDefault") expect(facts.branches!.some((b) => b.name === "main")).toBe(false);
      else expect(facts.branches!.find((b) => b.name === "main")).toMatchObject({ remoteFactsUnknown: false });
      // B2 `:90` counts names with a section or a legacy entry. A bad pointer alone drops what depends on it, and is no remote.
      expect(facts.omittedRemotes).toBe(source === "config" || source === "legacy");
    });
  });
}

for (const url of ["https://github.com/org/fork.git", "git@github.com:org/fork.git"]) test(`a healthy checkout whose upstream is the URL ${url} keeps its name, tip and checkout, and nothing of the URL`, async () => {
  await usingFixture(async ({ repo, env }) => {
    await g(repo, ["checkout", "-q", "-b", "from-url"], env);
    await g(repo, ["config", "branch.from-url.remote", url], env);
    await g(repo, ["config", "branch.from-url.merge", "refs/heads/their-branch"], env);
    const tip = (await g(repo, ["rev-parse", "refs/heads/from-url"], env)).trim();
    const { rg, commonDir } = await context(repo);
    const f = await readCheckoutFacts(rg, commonDir, await readRemoteFacts(rg, commonDir), null, ["from-url"]);
    expect(f.branches!.find((b) => b.name === "from-url")).toEqual({
      name: "from-url", upstreamRemote: null, upstreamBranch: null, pushRemote: null, remoteFactsUnknown: true,
      checkoutPath: realpathSync(repo), refFormatOk: true, tip,
    });
    expect(JSON.stringify(f)).not.toContain("org/fork");
    expect(JSON.stringify(f)).not.toContain("their-branch");
    // It names no remote: not one of them, no reason to doubt the count, and the other branches keep their facts.
    expect(f.remotes!.map((r) => r.name)).toEqual(["origin"]);
    expect(f.omittedRemotes).toBe(false);
    expect(f.branches!.find((b) => b.name === "feature/contract")).toMatchObject({ upstreamRemote: "origin", remoteFactsUnknown: false });
  });
});

test("a remote name the count cannot use leaves a private yes, never the name", async () => {
  await usingFixture(async ({ repo, env }) => {
    const { rg, commonDir } = await context(repo);
    expect((await readRemoteFacts(rg, commonDir)).omittedRemotes).toBe(false);
    await g(repo, ["config", "remote.my fork.url", "https://github.com/org/fork"], env);
    const facts = await readRemoteFacts(rg, commonDir);
    expect(facts.omittedRemotes).toBe(true);
    expect(facts.remotes!.map((r) => r.name)).toEqual(["origin"]);
    expect(JSON.stringify(facts)).not.toContain("my fork");
  });
});

// Plan §0, B2 final round 4. Git compares these words exactly and the last value wins, so anything else is not a destination.
for (const [why, values, expected] of [
  ["unset, git's own default", [], false],
  ["simple", ["simple"], false],
  ["current", ["current"], false],
  ["matching", ["matching"], false],
  ["nothing", ["nothing"], false],
  ["upstream", ["upstream"], true],
  ["tracking", ["tracking"], true],
  ["a word git refuses", ["Upstream"], false],
  ["the last of several", ["upstream", "simple"], false],
  ["the last of several, the other way", ["simple", "tracking"], true],
] as const) test(`push.default ${why}: pushesToUpstream is ${expected}, from the one config read`, async () => {
  await usingFixture(async ({ repo, env }, spy) => {
    const { rg, commonDir } = await context(repo); // first: a word git refuses stops every later git that reads it
    for (const value of values) await g(repo, ["config", "--add", "push.default", value], env);
    const before = spy.calls.length;
    expect((await readRemoteFacts(rg, commonDir)).pushesToUpstream).toBe(expected);
    expect(spy.calls.slice(before).filter((a) => a.includes("config")).length).toBe(1);
  });
});

test("push.default from the global file counts, a config entry with no value does not, and a failed config read is not a destination", async () => {
  let fails = false;
  await usingFixture(async ({ repo, env }) => {
    const { rg, commonDir } = await context(repo);
    writeFileSync(env.GIT_CONFIG_GLOBAL, "[push]\n\tdefault = upstream\n");
    expect((await readRemoteFacts(rg, commonDir)).pushesToUpstream).toBe(true);
    fails = true;
    const unread = await readRemoteFacts(rg, commonDir);
    expect(unread.remotes).toBeNull();
    expect(unread.pushesToUpstream).toBe(false);
    fails = false;
    writeFileSync(env.GIT_CONFIG_GLOBAL, "[push]\n\tdefault\n");
    expect((await readRemoteFacts(rg, commonDir)).pushesToUpstream).toBe(false);
  }, (argv) => fails && argv.includes("config") ? ["sh", "-c", "exit 2"] : undefined);
});

test("a credential-bearing canonical repo path omits its facts and preserves B1's state", async () => {
  await usingFixture(async (fx) => {
    const repo = join(fx.root, "gHp_" + "A".repeat(36));
    renameSync(fx.repo, repo);
    const result = await status({ ...fx, repo });
    expect(result.repoViews.map((r) => r.state)).toEqual(["ok"]);
    expect(result.actionFacts).toEqual([]);
  });
});

test("hostile actionFacts contain no credential sentinel in any field", async () => {
  await usingFixture(async (fx) => {
    const sentinels = [
      "ghp_" + "A".repeat(36), "gHp_" + "B".repeat(36), "akia" + "c".repeat(16),
      "SK-ant-api03-" + "D".repeat(42), "XOXB-" + "E".repeat(24),
      "eyj" + "f".repeat(8) + "." + "g".repeat(12) + "." + "h".repeat(12),
    ];
    for (const root of sentinels) mkdirSync(join(fx.repo, root));
    const linked = join(fx.root, sentinels[1]!);
    await g(fx.repo, ["worktree", "add", "-q", "-b", "safe-linked", linked], fx.env);
    await g(fx.repo, ["branch", sentinels[0]!], fx.env);
    await g(fx.repo, ["remote", "add", sentinels[0]!, `https://user:${sentinels[2]}@host/${sentinels[3]}?token=${sentinels[4]}`], fx.env);
    await g(fx.repo, ["config", "branch.main.remote", sentinels[0]!], fx.env);
    const { rg, commonDir, gitDir } = await context(fx.repo);
    const actionFacts = await readActionFacts([{ rg, commonDir, gitDir, commits: [fx.pushed], squashed: new Map() }], {
      branches: ["feature/contract", "safe-linked"], overall: startGitBudget(60_000), concurrency: 1,
      windowStart: new Date("2026-01-01"), now: new Date("2026-01-11"),
      labels: Object.fromEntries(["apps/gui", ...sentinels].map((root) => [root, { repo: fx.repo, root }])),
    });
    expect(actionFacts).toHaveLength(1);
    expect(actionFacts[0]!.branches!.find((b) => b.name === "feature/contract")!.checkoutPath).toBe(fx.repo);
    const text = JSON.stringify(actionFacts).toLowerCase();
    for (const sentinel of sentinels) expect(text).not.toContain(sentinel.toLowerCase());
    expect(actionFacts[0]!.branches!.find((b) => b.name === "safe-linked")!.checkoutPath).toBeNull();
    expect(actionFacts[0]!.roots).toEqual([{ root: "apps/gui", project: projectKey(fx.repo, "apps/gui"), labelKeys: ["apps/gui"], displayLabel: "apps/gui" }]);
  });
});

// The refusal table Rust's `engine::is_refused_format_character` is held to: safeFactName's own copy must agree.
const requestChars: { chars: { cp: string; refused: boolean }[] } =
  JSON.parse(readFileSync(new URL("../gui/src-tauri/tests/fixtures/repos-request-limits.json", import.meta.url), "utf8"));
for (const { cp, refused } of requestChars.chars) test(`safeFactName: ${cp} ${refused ? "refused" : "allowed"}`, () => {
  expect(safeFactName(`a${String.fromCodePoint(Number.parseInt(cp.slice(2), 16))}b`)).toBe(!refused);
});

test("ref format: valid slash branch, invalid/control/format/leading option, and no budget", async () => {
  await usingFixture(async ({ repo }, spy) => {
    const { rg } = await context(repo);
    expect(await refFormatOk(rg, "feature/ok")).toBe(true);
    expect(await refFormatOk(rg, "bad..name")).toBe(false);
    for (const name of ["-n", "bad\nname", "bad\u202ename"]) {
      const before = spy.calls.length;
      expect(await refFormatOk(rg, name)).toBe(false);
      expect(spy.calls.length).toBe(before);
    }
    expect(await refFormatOk({ ...rg, budget: startGitBudget(0) }, "main")).toBe(false);
  });
});

for (const code of ["exit 1", "exit 2", "kill -KILL $$"]) test(`check-ref-format failure is false: ${code}`, async () => {
  await usingFixture(async ({ repo }) => {
    const { rg } = await context(repo);
    expect(await refFormatOk(rg, "main")).toBe(false);
  }, (a) => a.includes("check-ref-format") ? ["sh", "-c", code] : undefined);
});

/* ── B2-M2-T7: the stat inputs and their pre-read stamps ───────────────────────────────────────────── */

for (const v of contract.stampVectors) test(`stamp vector (R5-M1): ${v.name}`, async () => {
  const dir = realpathSync(scratch("stamp-vector"));
  const path = join(dir, "subject");
  if (v.expected.kind === "file") {
    writeFileSync(path, "x".repeat(v.bytes!));
    utimesSync(path, v.mtimeSeconds!, v.mtimeSeconds!);
  } else if (v.expected.kind === "dir") mkdirSync(path);
  else if (v.expected.kind === "symlink") symlinkSync(v.linkTo!, path);
  const stamp = (await encodeStamp(path))!;
  // A file and a missing path are byte for byte; a directory's and a symlink's size and time are the filesystem's.
  expect(stamp.kind).toBe(v.expected.kind as never);
  expect(stamp.target).toBe(v.expected.target);
  if (v.expected.mtimeNs !== undefined) expect(stamp).toEqual(v.expected as never);
  else {
    expect(stamp.mtimeNs).toMatch(/^-?(0|[1-9][0-9]*)$/);
    expect(stamp.size).toMatch(/^(0|[1-9][0-9]*)$/);
  }
});

test("a stamp's time is the bigint's full text, never through a JS number (R5-M1)", async () => {
  const path = join(realpathSync(scratch("stamp-precise")), "subject");
  writeFileSync(path, "x");
  // A write's own clock has nanoseconds no double can hold past 2^53: a whole-second literal could not tell these apart.
  const real = lstatSync(path, { bigint: true });
  expect(await encodeStamp(path)).toEqual({ mtimeNs: real.mtimeNs.toString(), size: real.size.toString(), kind: "file", target: null });
  expect(real.mtimeNs % 1_000_000n).not.toBe(0n);
});

test("a stamp the engine cannot establish is no stamp, never a guess (R5-M1)", async () => {
  const dir = realpathSync(scratch("stamp-eacces"));
  mkdirSync(join(dir, "locked"));
  writeFileSync(join(dir, "plain"), "x");
  chmodSync(join(dir, "locked"), 0o000);
  try {
    // git treats a path under a file as absent, and so does this: ENOTDIR is missing, not unknown.
    expect(await encodeStamp(join(dir, "plain", "under-a-file"))).toEqual({ mtimeNs: "0", size: "0", kind: "missing", target: null });
    // Root ignores chmod 000, so this half says nothing there.
    if (process.getuid?.() !== 0) expect(await encodeStamp(join(dir, "locked", "inside"))).toBeNull();
  } finally { chmodSync(join(dir, "locked"), 0o755); }
});

test("config origins: only file origins are kept, relative ones as printed, values are never returned", () => {
  const rec = (scope: string, origin: string, entry: string) => `${scope}\0${origin}\0${entry}\0`;
  expect(parseConfigOrigins("")).toEqual([]);
  expect(parseConfigOrigins(rec("command", "command line:", "a.b\n1") + rec("local", "file:.git/config", "c.d\nsecret\nvalue") + rec("global", "file:/g", "e.f") + rec("local", "file:.git/config", "c.g\n2")))
    .toEqual([".git/config", "/g"]);
  // Apple Git prints git's own `unknown` scope for the Xcode system config (plan, "Build stop B2-M2-T7").
  const xcode = "/Applications/Xcode.app/Contents/Developer/usr/share/git-core/gitconfig";
  expect(parseConfigOrigins(rec("unknown", `file:${xcode}`, "credential.helper\nosxkeychain") + rec("local", "file:.git/config", "c.d\n1")))
    .toEqual([xcode, ".git/config"]);
  for (const bad of [
    "local\0file:/x\0a.b\n1",                 // no final terminator
    "local\0file:/x\0",                        // not three fields
    rec("nonsense", "file:/x", "a.b\n1"),       // a scope name git does not print
    rec("Unknown", "file:/x", "a.b\n1"),        // git's word is lower case
    rec("unknown", "command line:", "a.b\n1"),  // `unknown` only with a file origin
    rec("unknown", "blob:abc", "a.b\n1"),
    rec("unknown", "standard input:", "a.b\n1"),
    rec("unknown", "file:", "a.b\n1"),
    rec("local", "file:/ok", "a.b\n1") + rec("unknown", "blob:abc", "a.b\n1"), // one bad record is the whole answer
    rec("local", "blob:abc", "a.b\n1"),         // another origin form
    rec("local", "standard input:", "a.b\n1"),
    rec("local", "command line:", "a.b\n1"),    // the command origin belongs to the command scope
    rec("local", "file:", "a.b\n1"),            // no path
    rec("local", "file:/x", "nodot\n1"),        // not a key
  ]) expect(parseConfigOrigins(bad)).toBeNull();
});

// No real git run here can print `unknown` on every host (git decides that, per build), so the seam stands in for the
// listing alone. The path it names is a real file, stamped and watched like any other origin.
test("a file git lists under its own unknown scope is an input, and editing it changes its stamp", async () => {
  const dir = realpathSync(scratch("unknown-scope"));
  const system = join(dir, "system.config");
  writeFileSync(system, "[fixture]\n\ta = 1\n");
  const listing = `printf 'unknown\\0file:${system}\\0fixture.a\\n1\\0'`;
  await usingFixture(async ({ repo }) => {
    const before = stampAt(await inputsOf(repo), system);
    expect(before).toMatchObject({ kind: "file", size: "17", target: null });
    writeFileSync(system, "[fixture]\n\ta = 22\n");
    expect(stampAt(await inputsOf(repo), system)).toMatchObject({ kind: "file", size: "18", target: null });
  }, (a) => a.includes("--show-origin") ? ["sh", "-c", listing] : undefined);
});

async function inputsOf(repo: string, branches: string[] = []): Promise<StatInputs | null> {
  const { rg, commonDir, gitDir } = await context(repo);
  const opts = {
    branches,
    overall: startGitBudget(60_000), concurrency: 1,
    windowStart: new Date("2026-01-01"), now: new Date("2026-01-11"), labels: null,
  };
  const facts = await readActionFacts([{ rg, commonDir, gitDir, commits: [], squashed: new Map() }], opts);
  expect(facts).toHaveLength(1);
  return facts[0]!.statInputs;
}
const stampAt = (inputs: StatInputs | null, path: string) => inputs!.find((i) => i.path === path)?.stamp;

test("the set: the origins git read, the two global candidates, and the common dir's own files, sorted and without values", async () => {
  await usingFixture(async ({ root, repo }) => {
    await g(repo, ["config", "fixture.secretvalue", "gHp_" + "S".repeat(36)], { GIT_CONFIG_GLOBAL: join(root, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1" });
    const inputs = await inputsOf(repo);
    expect(inputs!.map((i) => i.path)).toEqual([
      join(root, "gitconfig"), join(root, "home/.gitconfig"), join(root, "inc-target.config"), join(root, "inc.config"),
      join(repo, ".git/branches"), join(repo, ".git/config"), join(repo, ".git/config.worktree"), join(repo, ".git/remotes"),
      join(root, "xdg/git/config"),
    ].sort());
    expect(stampAt(inputs, join(root, "home/.gitconfig"))!.kind).toBe("missing");
    expect(stampAt(inputs, join(root, "xdg/git/config"))!.kind).toBe("missing");
    expect(stampAt(inputs, join(repo, ".git/config"))!.kind).toBe("file");
    expect(stampAt(inputs, join(repo, ".git/branches"))!.kind).toBe("dir");
    expect(stampAt(inputs, join(root, "inc.config"))).toMatchObject({ kind: "symlink", target: "inc-target.config" });
    expect(JSON.stringify(inputs)).not.toContain("SSSS");
  });
});

test("an include and a global candidate: editing or creating one changes its stamp (Q-L2)", async () => {
  await usingFixture(async ({ root, repo, env }) => {
    writeFileSync(env.GIT_CONFIG_GLOBAL, `[user]\n\tname = Test\n\temail = test@example.com\n[include]\n\tpath = ${join(root, "global-inc.config")}\n`);
    writeFileSync(join(root, "global-inc.config"), "[fixture]\n\ta = 1\n");
    utimesSync(join(root, "global-inc.config"), 1_700_000_000, 1_700_000_000);
    const before = await inputsOf(repo);
    expect(stampAt(before, join(root, "global-inc.config"))).toEqual({ mtimeNs: "1700000000000000000", size: "17", kind: "file", target: null });
    writeFileSync(join(root, "global-inc.config"), "[fixture]\n\ta = 22\n");
    expect(stampAt(await inputsOf(repo), join(root, "global-inc.config"))!.size).toBe("18");
    mkdirSync(join(root, "xdg/git"));
    writeFileSync(join(root, "xdg/git/config"), "[fixture]\n\tb = 1\n");
    writeFileSync(join(root, "home/.gitconfig"), "[fixture]\n\tc = 1\n");
    const after = await inputsOf(repo);
    expect(stampAt(after, join(root, "xdg/git/config"))!.kind).toBe("file");
    expect(stampAt(after, join(root, "home/.gitconfig"))!.kind).toBe("file");
  });
});

test("the global candidates: XDG_CONFIG_HOME unset or empty falls back to HOME/.config, as git reads them", () => {
  expect(globalConfigCandidates({ HOME: "/h", XDG_CONFIG_HOME: "/x" })).toEqual(["/h/.gitconfig", "/x/git/config"]);
  expect(globalConfigCandidates({ HOME: "/h", XDG_CONFIG_HOME: "" })).toEqual(["/h/.gitconfig", "/h/.config/git/config"]);
  expect(globalConfigCandidates({ HOME: "/h" })).toEqual(["/h/.gitconfig", "/h/.config/git/config"]);
  expect(globalConfigCandidates({ XDG_CONFIG_HOME: "/x" })).toEqual(["/x/git/config"]);
  expect(globalConfigCandidates({})).toEqual([]);
});

test("a symlinked config: the link, each hop and the file git read are inputs, and retargeting changes the link's stamp", async () => {
  await usingFixture(async ({ root, repo }) => {
    mkdirSync(join(root, "dots"));
    symlinkSync("dots", join(root, "dots-link"));
    writeFileSync(join(root, "dots/real.config"), "[fixture]\n\ta = 1\n");
    writeFileSync(join(root, "dots/other.config"), "[fixture]\n\ta = 2\n");
    symlinkSync("dots-link/real.config", join(root, "hop.config"));
    symlinkSync(join(root, "hop.config"), join(root, "home/.gitconfig"));
    const inputs = await inputsOf(repo);
    expect(stampAt(inputs, join(root, "home/.gitconfig"))).toMatchObject({ kind: "symlink", target: join(root, "hop.config") });
    expect(stampAt(inputs, join(root, "hop.config"))).toMatchObject({ kind: "symlink", target: "dots-link/real.config" });
    expect(stampAt(inputs, join(root, "dots-link"))).toMatchObject({ kind: "symlink", target: "dots" });
    expect(stampAt(inputs, join(root, "dots/real.config"))!.kind).toBe("file");
    expect(stampAt(inputs, join(root, "dots-link/real.config"))).toBeUndefined();
    rmSync(join(root, "hop.config"));
    symlinkSync("dots/other.config", join(root, "hop.config"));
    const moved = await inputsOf(repo);
    expect(stampAt(moved, join(root, "hop.config"))!.target).toBe("dots/other.config");
    expect(stampAt(moved, join(root, "dots/other.config"))!.kind).toBe("file");
  });
});

test("a dangling config symlink lists the link and the missing path it names", async () => {
  await usingFixture(async ({ root, repo }) => {
    symlinkSync("nowhere/at/all", join(root, "home/.gitconfig"));
    const inputs = await inputsOf(repo);
    expect(stampAt(inputs, join(root, "home/.gitconfig"))!.kind).toBe("symlink");
    expect(stampAt(inputs, join(root, "home/nowhere/at/all"))!.kind).toBe("missing");
  });
});

test("a link cycle reports no trustworthy stamp instead of walking for ever", async () => {
  await usingFixture(async ({ root, repo }) => {
    symlinkSync("loop-b", join(root, "home/loop-a"));
    symlinkSync("loop-a", join(root, "home/loop-b"));
    symlinkSync("loop-a", join(root, "home/.gitconfig"));
    expect(await inputsOf(repo)).toBeNull();
  });
});

test("a repo's config.worktree and the metadata of a worktree a fact relies on are inputs; a main checkout's .git directory is not", async () => {
  await usingFixture(async ({ root, repo, env }) => {
    const linked = join(root, "linked");
    await g(repo, ["worktree", "add", "-q", "-b", "wt-branch", linked], env);
    const id = join(repo, ".git/worktrees/linked");
    const inputs = await inputsOf(repo, ["wt-branch"]);
    expect(stampAt(inputs, join(repo, ".git/worktrees"))).toBeUndefined(); // the folder changes with every other worktree
    expect(stampAt(inputs, join(id, "gitdir"))!.kind).toBe("file");
    expect(stampAt(inputs, join(id, "commondir"))!.kind).toBe("file");
    expect(stampAt(inputs, join(linked, ".git"))!.kind).toBe("file");
    expect(stampAt(inputs, join(repo, ".git"))).toBeUndefined();
    // Read from the linked worktree: its own config.worktree, beside the common dir's.
    const fromLinked = await inputsOf(linked, ["wt-branch"]);
    expect(stampAt(fromLinked, join(id, "config.worktree"))!.kind).toBe("missing");
    expect(stampAt(fromLinked, join(repo, ".git/config.worktree"))!.kind).toBe("missing");
    expect(stampAt(fromLinked, join(linked, ".git"))!.kind).toBe("file");
    // Moving it rewrites the reciprocal metadata, and the old gitfile is gone.
    const before = stampAt(inputs, join(id, "gitdir"))!;
    await g(repo, ["worktree", "move", linked, join(root, "moved")], env);
    const after = await inputsOf(repo, ["wt-branch"]);
    expect(stampAt(after, join(root, "moved/.git"))!.kind).toBe("file");
    expect(stampAt(after, join(id, "gitdir"))!.size).not.toBe(before.size);
  });
});

test("a legacy remote entry: the directory's stamp changes when one appears, and the entry is an input", async () => {
  await usingFixture(async ({ repo }) => {
    utimesSync(join(repo, ".git/branches"), 1_700_000_000, 1_700_000_000);
    const before = await inputsOf(repo);
    expect(stampAt(before, join(repo, ".git/remotes"))!.kind).toBe("missing");
    mkdirSync(join(repo, ".git/remotes"));
    writeFileSync(join(repo, ".git/remotes/legacy"), "URL: https://github.com/org/legacy.git\n");
    writeFileSync(join(repo, ".git/branches/older"), "https://github.com/org/older.git\n");
    mkdirSync(join(repo, ".git/remotes/nested"));
    writeFileSync(join(repo, ".git/remotes/nested/deep"), "URL: https://github.com/org/deep.git\n");
    const after = await inputsOf(repo);
    expect(stampAt(after, join(repo, ".git/remotes/nested"))!.kind).toBe("dir");
    expect(stampAt(after, join(repo, ".git/remotes/nested/deep"))!.kind).toBe("file");
    expect(stampAt(after, join(repo, ".git/remotes"))!.kind).toBe("dir");
    expect(stampAt(after, join(repo, ".git/remotes/legacy"))!.kind).toBe("file");
    expect(stampAt(after, join(repo, ".git/branches/older"))!.kind).toBe("file");
    expect(stampAt(after, join(repo, ".git/branches"))!.mtimeNs).not.toBe(stampAt(before, join(repo, ".git/branches"))!.mtimeNs);
  });
});

test("more inputs than the cap is no answer at all: a partial set must not look complete", async () => {
  await usingFixture(async ({ repo }) => {
    for (let i = 0; i <= STAT_INPUTS_CAP; i++) writeFileSync(join(repo, ".git/branches", `b${i}`), "x\n");
    expect(await inputsOf(repo)).toBeNull();
  });
}, 30_000);

test("a malformed include: git config --list fails, so that repo has no inputs and mints nothing (Q-M2)", async () => {
  await usingFixture(async ({ root, repo, env }) => {
    const { rg, commonDir, gitDir } = await context(repo); // before the bad file: hardening reads config too
    expect(await readStatInputs(rg, commonDir, gitDir)).not.toBeNull();
    writeFileSync(join(root, "bad.config"), "[fixture\nnot config at all");
    writeFileSync(env.GIT_CONFIG_GLOBAL, `[user]\n\tname = Test\n\temail = test@example.com\n[include]\n\tpath = ${join(root, "bad.config")}\n`);
    expect(await readStatInputs(rg, commonDir, gitDir)).toBeNull();
  });
});

test("Q-M2's measured residual: an include pointing at a missing file lists no origin, so it is not an input", async () => {
  await usingFixture(async ({ root, repo, env }) => {
    writeFileSync(env.GIT_CONFIG_GLOBAL, `[user]\n\tname = Test\n\temail = test@example.com\n[include]\n\tpath = ${join(root, "not-yet.config")}\n`);
    const inputs = await inputsOf(repo);
    expect(inputs).not.toBeNull();
    expect(stampAt(inputs, join(root, "not-yet.config"))).toBeUndefined();
  });
});

test("the stamps are taken before the facts are read: the origin listing runs before the facts' own config read", async () => {
  await usingFixture(async (fx, spy) => {
    const { rg, commonDir, gitDir } = await context(fx.repo);
    const from = spy.calls.length;
    const facts = await readActionFacts([{ rg, commonDir, gitDir, commits: [fx.pushed], squashed: new Map() }], {
      branches: [], overall: startGitBudget(60_000), concurrency: 1,
      windowStart: new Date("2026-01-01"), now: new Date("2026-01-11"), labels: null,
    });
    const calls = spy.calls.slice(from).map((a) => a.join(" "));
    const origins = calls.findIndex((c) => c.endsWith("config --list --show-origin --show-scope -z"));
    const factsRead = calls.findIndex((c) => c.endsWith("config --null --list"));
    expect(origins).toBeGreaterThanOrEqual(0);
    expect(factsRead).toBeGreaterThan(origins);
    expect(calls.filter((c) => c.includes("--show-origin"))).toHaveLength(1);
    expect(facts[0]!.statInputs!.length).toBeGreaterThan(0);
  });
});

test("a failed or timed-out origin listing costs only the stat inputs, and the rest of the facts stay", async () => {
  for (const code of ["exit 1", "kill -KILL $$"]) await usingFixture(async (fx) => {
    const { rg, commonDir, gitDir } = await context(fx.repo);
    const facts = await readActionFacts([{ rg, commonDir, gitDir, commits: [fx.pushed], squashed: new Map() }], {
      branches: [], overall: startGitBudget(60_000), concurrency: 1,
      windowStart: new Date("2026-01-01"), now: new Date("2026-01-11"), labels: null,
    });
    expect(facts[0]!.statInputs).toBeNull();
    expect(facts[0]!.remotes![0]!.name).toBe("origin");
  }, (a) => a.includes("--show-origin") ? ["sh", "-c", code] : undefined);
}, 30_000);

test("a credential-shaped config path omits the inputs; a credential-shaped linked worktree is simply not watched", async () => {
  await usingFixture(async ({ root, repo, env }) => {
    const shaped = "gHp_" + "C".repeat(36);
    await g(repo, ["worktree", "add", "-q", "-b", "wt-shaped", join(root, shaped)], env);
    const inputs = await inputsOf(repo);
    expect(inputs).not.toBeNull();
    expect(JSON.stringify(inputs).toLowerCase()).not.toContain(shaped.toLowerCase());
    writeFileSync(join(root, shaped + ".config"), "[fixture]\n\ta = 1\n");
    writeFileSync(env.GIT_CONFIG_GLOBAL, `[user]\n\tname = Test\n\temail = test@example.com\n[include]\n\tpath = ${join(root, shaped + ".config")}\n`);
    expect(await inputsOf(repo)).toBeNull();
  });
});

test("an unrelated worktree, one no reported checkoutPath came from, adds no input: adding and removing it changes nothing", async () => {
  await usingFixture(async ({ root, repo, env }) => {
    await g(repo, ["worktree", "add", "-q", "-b", "wt-relied-on", join(root, "relied")], env);
    await g(repo, ["branch", "wt-unshown"], env);
    const before = await inputsOf(repo, ["wt-relied-on"]);
    expect(stampAt(before, join(root, "relied/.git"))!.kind).toBe("file");
    await g(repo, ["worktree", "add", "-q", join(root, "unrelated"), "wt-unshown"], env);
    expect(await inputsOf(repo, ["wt-relied-on"])).toEqual(before);
    await g(repo, ["worktree", "remove", "--force", join(root, "unrelated")], env);
    expect(await inputsOf(repo, ["wt-relied-on"])).toEqual(before);
  });
});

for (const shape of ["top", "subdirectory"] as const) test(`a --separate-git-dir checkout (${shape}) keeps its checkoutPath and statInputs, with the gitfile an input`, async () => {
  await usingFixture(async ({ root, repo, env }) => {
    await g(repo, ["init", "-q", "--separate-git-dir", join(root, "git-dir")], env);
    const configured = shape === "top" ? repo : join(repo, "apps/gui");
    const inputs = await inputsOf(configured, ["feature/contract"]);
    const facts = (await readActionFacts([await context(configured).then(({ rg, commonDir, gitDir }) => ({ rg, commonDir, gitDir, commits: [], squashed: new Map() }))], {
      branches: ["feature/contract"], overall: startGitBudget(60_000), concurrency: 1,
      windowStart: new Date("2026-01-01"), now: new Date("2026-01-11"), labels: null,
    }))[0]!;
    expect(facts.branches!.find((b) => b.name === "feature/contract")!.checkoutPath).toBe(repo);
    expect(facts.statInputs).not.toBeNull();
    expect(stampAt(inputs, join(repo, ".git"))!.kind).toBe("file");
  });
});

test("a configured submodule is the same shape: its own toplevel is its main checkout, with its gitfile an input", async () => {
  await usingFixture(async ({ root, repo, env }) => {
    const sup = join(root, "super");
    mkdirSync(sup);
    await g(sup, ["init", "-q", "-b", "main"], env);
    await g(sup, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", repo, "sub"], env);
    const configured = join(sup, "sub");
    const { rg, commonDir, gitDir } = await context(configured);
    expect(gitDir).toBe(commonDir);
    const branch = (await g(configured, ["rev-parse", "--abbrev-ref", "HEAD"], env)).trim();
    const facts = (await readActionFacts([{ rg, commonDir, gitDir, commits: [], squashed: new Map() }], {
      branches: [branch], overall: startGitBudget(60_000), concurrency: 1,
      windowStart: new Date("2026-01-01"), now: new Date("2026-01-11"), labels: null,
    }))[0]!;
    expect(facts.branches!.find((b) => b.name === branch)!.checkoutPath).toBe(configured);
    expect(stampAt(facts.statInputs!, join(configured, ".git"))!.kind).toBe("file");
  });
});

test("the entries of a checkout that became a checkoutPath are reported, and one with no stamp from before the read is no answer", () => {
  const file = { mtimeNs: "1", size: "1", kind: "file" as const, target: null };
  const read = {
    inputs: new Map([["/base", file]]), mains: ["/main"],
    worktrees: [{ checkout: "/used", inputs: new Map([["/w/used/gitdir", file]]) }, { checkout: "/other", inputs: new Map([["/w/other/gitdir", file]]) }],
  };
  const on = (...paths: (string | null)[]) => paths.map((checkoutPath) => ({ name: "b", upstreamRemote: null, upstreamBranch: null, pushRemote: null, remoteFactsUnknown: false, checkoutPath, refFormatOk: true, tip: null }));
  expect(selectStatInputs(read, on(null, "/used", "/main"))!.map((i) => i.path)).toEqual(["/base", "/w/used/gitdir"]);
  expect(selectStatInputs(read, on(null))!.map((i) => i.path)).toEqual(["/base"]);
  expect(selectStatInputs(read, null)!.map((i) => i.path)).toEqual(["/base"]);
  // Became a checkout after the stamps were taken: a stamp now would be one taken after the facts read.
  expect(selectStatInputs(read, on("/new"))).toBeNull();
  expect(selectStatInputs(null, on("/used"))).toBeNull();
});

test("a symlinked .git: the link alone is the input, retargeting it changes its stamp, and ordinary git commands change nothing", async () => {
  await usingFixture(async ({ root, repo, env }) => {
    renameSync(join(repo, ".git"), join(root, "store"));
    symlinkSync(join(root, "store"), join(repo, ".git"));
    const inputs = await inputsOf(repo);
    expect(stampAt(inputs, join(repo, ".git"))).toMatchObject({ kind: "symlink", target: join(root, "store") });
    expect(stampAt(inputs, join(root, "store"))).toBeUndefined(); // a git directory's time moves with every command
    expect(stampAt(inputs, join(root, "store/config"))!.kind).toBe("file");
    await g(repo, ["status"], env);
    await g(repo, ["add", "-A"], env);
    await commitAt(repo, env, { "more.txt": "more\n" }, "more", dates[4]!);
    await g(repo, ["gc", "--quiet"], env);
    expect(await inputsOf(repo)).toEqual(inputs);
    rmSync(join(repo, ".git"));
    symlinkSync("../store", join(repo, ".git"));
    expect(stampAt(await inputsOf(repo), join(repo, ".git"))!.target).toBe("../store");
  });
});

test("an include path git prints unnormalised is walked as the kernel walks it, through a symlink before the dot-dot", async () => {
  await usingFixture(async ({ root, repo, env }) => {
    mkdirSync(join(root, "far/sub"), { recursive: true });
    mkdirSync(join(root, "near"));
    symlinkSync(join(root, "far/sub"), join(root, "near/link"));
    writeFileSync(join(root, "far/kernel.config"), "[fixture]\n\ta = 1\n");
    writeFileSync(env.GIT_CONFIG_GLOBAL, `[user]\n\tname = Test\n\temail = test@example.com\n[include]\n\tpath = ${join(root, "near")}/link/../kernel.config\n`);
    const inputs = await inputsOf(repo);
    expect(stampAt(inputs, join(root, "near/link"))!.kind).toBe("symlink");
    expect(stampAt(inputs, join(root, "far/kernel.config"))!.kind).toBe("file");
    expect(stampAt(inputs, join(root, "near/kernel.config"))).toBeUndefined();
  });
});

test("a relative origin is joined to the repo without normalising, so its dot-dot still walks through the .git it names", async () => {
  await usingFixture(async ({ root, repo }) => {
    renameSync(join(repo, ".git"), join(root, "store"));
    symlinkSync(join(root, "store"), join(repo, ".git"));
    writeFileSync(join(root, "beside-store.config"), "[fixture]\n\ta = 1\n");
    // Relative to the file holding the include, so git prints `.git/../beside-store.config`, whose `..` leaves the link's target.
    writeFileSync(join(root, "store/config"), readFileSync(join(root, "store/config"), "utf8") + "[include]\n\tpath = ../beside-store.config\n");
    const inputs = await inputsOf(repo);
    expect(stampAt(inputs, join(root, "beside-store.config"))!.kind).toBe("file");
    expect(stampAt(inputs, join(repo, "beside-store.config"))).toBeUndefined();
  });
});


test("only requested branch names receive checkout paths, including a named unshown worktree", async () => {
  await usingFixture(async (fx) => {
    const linked = join(fx.root, "unshown");
    await g(fx.repo, ["worktree", "add", "-q", "-b", "unshown", linked], fx.env);
    const result = await status(fx);
    expect(result.actionFacts).toHaveLength(1);
    const branches = result.actionFacts[0]!.branches!;
    expect(branches.find((b) => b.name === "feature/contract")!.checkoutPath).toBe(fx.repo);
    expect(branches.find((b) => b.name === "unshown")!.checkoutPath).toBeNull();
    expect(result.actionFacts[0]!.statInputs!.some((i) => i.path === join(linked, ".git"))).toBe(false);
  });
});

test.skipIf(process.platform !== "darwin")("a worktree backlink with a different-case checkout spelling matches the canonical checkout", async () => {
  await usingFixture(async ({ root, repo, env }) => {
    const linked = join(root, "linked");
    await g(repo, ["worktree", "add", "-q", "-b", "wt-case", linked], env);
    const alias = join(root, "LiNkEd");
    expect(realpathSync(alias)).toBe(linked); // this host's case-insensitive filesystem
    writeFileSync(join(repo, ".git/worktrees/linked/gitdir"), alias + "/.git\n");
    const inputs = await inputsOf(repo, ["wt-case"]);
    expect(inputs).not.toBeNull();
    expect(stampAt(inputs, join(repo, ".git/worktrees/linked/gitdir"))!.kind).toBe("file");
  });
});

test("a configured linked worktree needs an entry stamped before its backlink is restored", async () => {
  await usingFixture(async ({ root, repo, env }) => {
    const linked = join(root, "linked");
    await g(repo, ["worktree", "add", "-q", "-b", "wt-restored", linked], env);
    const { rg, commonDir, gitDir } = await context(linked);
    const backlink = join(gitDir, "gitdir"), saved = readFileSync(backlink);
    rmSync(backlink);
    const before = await readStatInputs(rg, commonDir, gitDir);
    expect(before).not.toBeNull();
    writeFileSync(backlink, saved);
    const facts = await readCheckoutFacts(rg, commonDir, await readRemoteFacts(rg, commonDir), null, ["wt-restored"]);
    expect(facts.branches!.find((b) => b.name === "wt-restored")!.checkoutPath).toBe(linked);
    expect(selectStatInputs(before, facts.branches)).toBeNull();
  });
});

for (const folder of ["branches", "remotes", "worktrees"]) test(`readdir ENOTDIR in ${folder} is an empty listing`, async () => {
  await usingFixture(async ({ repo }) => {
    rmSync(join(repo, ".git", folder), { recursive: true, force: true });
    writeFileSync(join(repo, ".git", folder), "plain\n");
    expect(await inputsOf(repo)).not.toBeNull();
  });
});

test("a cyclic unrelated worktree entry is skipped without voiding the repo's inputs", async () => {
  await usingFixture(async ({ root, repo }) => {
    mkdirSync(join(repo, ".git/worktrees/broken"), { recursive: true });
    symlinkSync("loop", join(root, "loop"));
    writeFileSync(join(repo, ".git/worktrees/broken/gitdir"), join(root, "loop/.git") + "\n");
    const before = await inputsOf(repo);
    expect(before).not.toBeNull();
    expect(before!.some((i) => i.path.includes("/broken/"))).toBe(false);
  });
});

test("global candidates retain kernel-order link and dot-dot components", async () => {
  await usingFixture(async ({ root, repo }) => {
    mkdirSync(join(root, "far/sub"), { recursive: true });
    mkdirSync(join(root, "near"));
    symlinkSync(join(root, "far/sub"), join(root, "near/link"));
    const previous = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = join(root, "near") + "/link/..";
    try {
      const inputs = await inputsOf(repo);
      expect(stampAt(inputs, join(root, "near/link"))!.kind).toBe("symlink");
      expect(stampAt(inputs, join(root, "far/git/config"))!.kind).toBe("missing");
      expect(stampAt(inputs, join(root, "near/git/config"))).toBeUndefined();
    } finally { process.env.XDG_CONFIG_HOME = previous; }
  });
});

test("status, a commit and gc in a relied-on linked worktree leave its stat inputs unchanged", async () => {
  await usingFixture(async ({ root, repo, env }) => {
    const linked = join(root, "relied");
    await g(repo, ["worktree", "add", "-q", "-b", "wt-relied-on", linked], env);
    const before = await inputsOf(repo, ["wt-relied-on"]);
    expect(stampAt(before, join(repo, ".git/worktrees/relied/gitdir"))!.kind).toBe("file");
    await g(linked, ["status", "--porcelain"], env);
    expect(await inputsOf(repo, ["wt-relied-on"])).toEqual(before);
    await commitAt(linked, env, { "new.txt": "new\n" }, "linked commit", dates[4]!);
    expect(await inputsOf(repo, ["wt-relied-on"])).toEqual(before);
    await g(linked, ["gc", "--quiet"], env);
    expect(await inputsOf(repo, ["wt-relied-on"])).toEqual(before);
  });
});

test("a configured subdirectory: git's relative origins are from its top, so an include there is the file git read", async () => {
  await usingFixture(async ({ repo, env }) => {
    writeFileSync(join(repo, "inc-rel.config"), "[fixture]\n\tb = 1\n");
    await g(repo, ["config", "--add", "include.path", "../inc-rel.config"], env);
    const inputs = await inputsOf(join(repo, "apps/gui"));
    expect(stampAt(inputs, join(repo, ".git/../inc-rel.config"))!.kind).toBe("file");
    expect(inputs!.map((i) => i.path).filter((p) => p.startsWith(join(repo, "apps/gui") + "/"))).toEqual([join(repo, "apps/gui/.git")]);
  });
});
