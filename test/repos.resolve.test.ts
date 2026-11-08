import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// test/repos.resolve.test.ts — B1-M2-T4 (wave-2 plan): which repos, the tokens, "not matched", and the
// window start. Scratch repos built per test under a per-test global config (fixtures/repos-fixtures.ts);
// never one of the user's repos.
import { test, expect, describe } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startGitBudget } from "../src/git";
import { hardenArgs } from "../src/repos/harden";
import type { RepoGit } from "../src/repos/hgit";
import { readRunRecord, type RunRecord } from "../src/runRecord";
import {
  keptTokens, reposFor, planTokens, resolveInRepo, settleTokens, resolveLabels, commitDates, windowStartFor,
  type RepoHandle,
} from "../src/repos/resolve";
import {
  g, isolatedGit, newRepo, withGit, commitAt, ambiguousPair, armHostile, signCommits, runControls, scratch,
} from "./fixtures/repos-fixtures";

const LAZY = { lazyFetch: true };
async function rgFor(repo: string): Promise<RepoGit> {
  const budget = startGitBudget(60_000);
  const h = await hardenArgs(repo, budget, LAZY);
  if ("unknown" in h) throw new Error(`unknown: ${h.unknown}`);
  return { repo, lead: h.lead, budget };
}
async function handles(...repos: string[]): Promise<Map<string, RepoHandle>> {
  const m = new Map<string, RepoHandle>();
  for (const r of repos) m.set(r, { rg: await rgFor(r) });
  return m;
}
const head = async (repo: string, env: Record<string, string>) => (await g(repo, ["rev-parse", "HEAD"], env)).trim();
function record(over: Partial<RunRecord>): RunRecord {
  return { schemaVersion: 1, date: "2026-10-24", repos: [], windowStartUtc: "2026-10-23T04:00:00.000Z", labels: {}, commits: [], missing: [], ...over };
}

describe("tokens: only 7-40-character hex is resolved", () => {
  test("shorter, longer and non-hex tokens are dropped; kept ones are lowercased and deduped in order", () => {
    expect(keptTokens(["ABC1234", "abc12", "abc1234", "zzzzzzz", "a".repeat(41), "0123456789abcdef0123456789abcdef01234567", "beef"]))
      .toEqual(["abc1234", "0123456789abcdef0123456789abcdef01234567"]);
  });
});

describe("which repos", () => {
  test("the accepted record's repos; else the configured repos after excludeRepos; never discovery", () => {
    expect(reposFor(record({ repos: ["/r/a", "/r/b"] }), { repos: ["/r/c"] })).toEqual(["/r/a", "/r/b"]);
    expect(reposFor(null, { repos: ["/r/a", "/r/chef"], excludeRepos: ["chef"] })).toEqual(["/r/a"]);
    expect(reposFor(null, { discoverRoots: ["/r"] } as never)).toBe("none");
    expect(reposFor(null, {})).toBe("none");
    expect(reposFor(null, { repos: [] })).toBe("none");
  });

  test("a record dated for another day is rejected, and the configured repos are used", async () => {
    const path = join(scratch("record"), "run-record.json");
    writeFileSync(path, JSON.stringify(record({ date: "2026-10-23", repos: ["/r/from-record"] })));
    const rec = await readRunRecord("2026-10-24", path);
    expect(rec.accepted).toBe(false);
    expect(reposFor(rec.accepted ? rec.record : null, { repos: ["/r/configured"] })).toEqual(["/r/configured"]);
  });
});

describe("tokens and \"not matched\" (no record)", () => {
  test("unknown and short tokens: the unknown counts in notMatched, the short one nowhere, and the repo answers", async () => {
    const { env } = isolatedGit();
    const a = await newRepo();
    const c = await head(a, env);
    const { result } = await withGit(env, async () => resolveLabels([{ key: "proj", tokens: [c.slice(0, 7), "deadbee", c.slice(0, 5)] }], null, await handles(a)));
    expect(result).toEqual([{ key: "proj", recordRepo: null, repo: a, resolved: [{ token: c.slice(0, 7), sha: c, repo: a }], notMatched: 1, unsettled: 0 }]);
  });

  test("an ambiguous 7-character token (two commits share it) is not matched, never guessed", async () => {
    const { env } = isolatedGit();
    const a = await newRepo();
    const [x, y] = await ambiguousPair(a, env, await head(a, env));
    expect(x.slice(0, 7)).toBe(y.slice(0, 7));
    expect(x).not.toBe(y);
    const { result } = await withGit(env, async () => resolveLabels([{ key: "proj", tokens: [x.slice(0, 7), x] }], null, await handles(a)));
    expect(result[0]!.notMatched).toBe(1);
    expect(result[0]!.resolved).toEqual([{ token: x, sha: x, repo: a }]);
  });

  test("a branch named like the token, on another commit, is rejected: the resolved SHA must start with the token", async () => {
    const { env } = isolatedGit();
    const a = await newRepo();
    const c = await head(a, env);
    const other = await commitAt(a, env, { "o.txt": "o\n" }, "other", "2026-01-12T10:00:00Z");
    await g(a, ["branch", c.slice(0, 7), other], env);
    // the premise: a plain rev-parse of the token gives the BRANCH's commit
    expect((await g(a, ["rev-parse", "--verify", "--quiet", `${c.slice(0, 7)}^{commit}`], env)).trim()).toBe(other);
    const { result } = await withGit(env, async () => resolveLabels([{ key: "proj", tokens: [c.slice(0, 7)] }], null, await handles(a)));
    expect(result[0]!.resolved).toEqual([]);
    expect(result[0]!.notMatched).toBe(1);
  });

  test("without a record a token that resolves in two repos is not matched; one in one repo resolves there", async () => {
    const { env } = isolatedGit();
    const a = await newRepo();
    const shared = await head(a, env);
    const b = join(scratch("clone"), "b");
    await g(scratch("cwd"), ["clone", "-q", a, b], env);
    const onlyB = await commitAt(b, env, { "b.txt": "b\n" }, "only in b", "2026-01-12T10:00:00Z");
    const { result } = await withGit(env, async () => resolveLabels([{ key: "proj", tokens: [shared.slice(0, 7), onlyB.slice(0, 7)] }], null, await handles(a, b)));
    expect(result[0]!.notMatched).toBe(1);
    expect(result[0]!.resolved).toEqual([{ token: onlyB.slice(0, 7), sha: onlyB, repo: b }]);
    expect(result[0]!.repo).toBe(b);
  });

  test("the Other card (key \"\") resolves across every repo, with or without a record", async () => {
    const { env } = isolatedGit();
    const [a, b] = [await newRepo({ "a.txt": "a\n" }), await newRepo({ "b.txt": "b\n" })];
    const cb = await head(b, env);
    const rec = record({ repos: [a, b], labels: { proj: { repo: a, root: null } } });
    for (const r of [null, rec]) {
      const { result } = await withGit(env, async () => resolveLabels([{ key: "", tokens: [cb.slice(0, 7)] }], r, await handles(a, b)));
      expect(result[0]).toEqual({ key: "", recordRepo: null, repo: b, resolved: [{ token: cb.slice(0, 7), sha: cb, repo: b }], notMatched: 0, unsettled: 0 });
    }
  });

  test("a repo that cannot be read leaves its tokens unsettled, not \"not matched\"; a token two readable repos hold is still not matched", async () => {
    const { env } = isolatedGit();
    const a = await newRepo();
    const c = await head(a, env);
    const m = await handles(a);
    m.set("/nowhere", { unknown: "error" });
    const { result } = await withGit(env, async () => resolveLabels([{ key: "proj", tokens: [c.slice(0, 7), "deadbee"] }], null, m));
    expect(result[0]).toEqual({ key: "proj", recordRepo: null, repo: null, resolved: [], notMatched: 0, unsettled: 2 });
  });
});

describe("tokens with an accepted record", () => {
  test("a token is looked up among the record's commits for its label's repo first, with no spawn; others take rev-parse there only", async () => {
    const { env } = isolatedGit();
    const [a, b] = [await newRepo({ "a.txt": "a\n" }), await newRepo({ "b.txt": "b\n" })];
    const ca = await head(a, env);
    const later = await commitAt(a, env, { "l.txt": "l\n" }, "after the page", "2026-01-13T10:00:00Z");
    const cb = await head(b, env);
    const rec = record({
      repos: [a, b], labels: { "Proj": { repo: a, root: null }, "Other proj": { repo: b, root: null } },
      commits: [{ sha: ca, label: "Proj", repo: a }, { sha: cb, label: "Other proj", repo: b }],
    });
    const { result, calls } = await withGit(env, async () => resolveLabels([{ key: "proj", tokens: [ca.slice(0, 7), later.slice(0, 7), cb.slice(0, 7)] }], rec, await handles(a, b)));
    expect(result[0]!.recordRepo).toBe(a);
    expect(result[0]!.repo).toBe(a);
    expect(result[0]!.resolved).toEqual([{ token: ca.slice(0, 7), sha: ca, repo: a }, { token: later.slice(0, 7), sha: later, repo: a }]);
    expect(result[0]!.notMatched).toBe(1);                       // cb is in b, not the label's repo
    const revParses = calls.filter((c) => c.includes("rev-parse") && c.includes("--verify"));
    expect(revParses.some((c) => c.some((x) => x.startsWith(ca.slice(0, 7))))).toBe(false);   // the record settled it
    expect(revParses.some((c) => c.some((x) => x.startsWith(later.slice(0, 7))) && c[2] === a)).toBe(true);
    expect(revParses.some((c) => c[2] === b)).toBe(false);       // never looked for in another repo
  });

  test("a label the record lacks resolves across the repos; labels match on norm keys", async () => {
    const { env } = isolatedGit();
    const [a, b] = [await newRepo({ "a.txt": "a\n" }), await newRepo({ "b.txt": "b\n" })];
    const cb = await head(b, env);
    const rec = record({ repos: [a, b], labels: { "**My Proj**.": { repo: b, root: null } } });
    const plan = planTokens([{ key: "my proj", tokens: [cb.slice(0, 7)] }, { key: "absent", tokens: [cb.slice(0, 7)] }], rec, [a, b]);
    expect(plan.labels.map((l) => [l.key, l.repo])).toEqual([["my proj", b], ["absent", null]]);
    const { result } = await withGit(env, async () => resolveLabels([{ key: "absent", tokens: [cb.slice(0, 7)] }], rec, await handles(a, b)));
    expect(result[0]!.resolved).toEqual([{ token: cb.slice(0, 7), sha: cb, repo: b }]);
  });

  test("an ambiguous prefix among the record's own commits falls through to rev-parse", async () => {
    const { env } = isolatedGit();
    const a = await newRepo();
    const [x, y] = await ambiguousPair(a, env, await head(a, env));
    const rec = record({ repos: [a], labels: { proj: { repo: a, root: null } }, commits: [{ sha: x, label: "proj", repo: a }, { sha: y, label: "proj", repo: a }] });
    const { result, calls } = await withGit(env, async () => resolveLabels([{ key: "proj", tokens: [x.slice(0, 7)] }], rec, await handles(a)));
    expect(result[0]!.notMatched).toBe(1);
    expect(calls.some((c) => c.includes("--verify") && c.includes(`${x.slice(0, 7)}^{commit}`))).toBe(true);
  });

  test("planTokens with settleTokens gives the same answer per repo as resolveLabels (the parts the command composes)", async () => {
    const { env } = isolatedGit();
    const a = await newRepo();
    const c = await head(a, env);
    const plan = planTokens([{ key: "proj", tokens: [c.slice(0, 7), "deadbee"] }], null, [a]);
    expect([...plan.asks.keys()]).toEqual([a]);
    const { result } = await withGit(env, async () => resolveInRepo(await rgFor(a), plan.asks.get(a)!, []));
    expect(result).toEqual([c, null]);
    expect(settleTokens(plan, new Map([[a, result]]))[0]).toEqual({ key: "proj", recordRepo: null, repo: a, resolved: [{ token: c.slice(0, 7), sha: c, repo: a }], notMatched: 1, unsettled: 0 });
    expect(settleTokens(plan, new Map([[a, "unknown"]]))[0]!.unsettled).toBe(2);
  });
});

describe("the window start", () => {
  test("the record's windowStartUtc; without a record, the local midnight of the oldest resolved page commit's committer date", async () => {
    const { env } = isolatedGit();
    const a = await newRepo();
    const old = await commitAt(a, env, { "o.txt": "o\n" }, "old", "2026-03-04T15:30:00+05:00");
    const young = await commitAt(a, env, { "y.txt": "y\n" }, "young", "2026-03-06T09:00:00Z");
    const { result } = await withGit(env, async () => commitDates(await rgFor(a), [young, old, "0".repeat(40)]));
    expect([...result.keys()].sort()).toEqual([old, young].sort());    // an absent SHA is skipped (--ignore-missing)
    expect(result.get(old)).toBe(Date.parse("2026-03-04T15:30:00+05:00"));
    const expected = new Date(Date.parse("2026-03-04T15:30:00+05:00"));
    expected.setHours(0, 0, 0, 0);
    expect(windowStartFor(null, [...result.values()])).toEqual(expected);
    expect(windowStartFor(record({ windowStartUtc: "2026-03-01T05:00:00.000Z" }), [...result.values()])).toEqual(new Date("2026-03-01T05:00:00.000Z"));
    expect(windowStartFor(null, [])).toBeNull();
  });
});

describe("hostile repo: no repo-scoped program runs through T4's calls", () => {
  test("rev-parse resolutions and the commit-date listing run none of the armed programs; the plain-git controls run them", async () => {
    const { env } = isolatedGit();
    const a = await newRepo({ "f.txt": "one\n" });
    const dir = scratch("hostile");
    await signCommits(a, env, dir);
    const c1 = await head(a, env);
    const signed = await commitAt(a, env, { "f.txt": "two\n" }, "signed", "2026-01-12T10:00:00Z");
    const hostile = await armHostile(a, env, dir);
    const { result } = await withGit(env, async () => {
      const rg = await rgFor(a);
      const res = await resolveLabels([{ key: "proj", tokens: [c1.slice(0, 7), signed.slice(0, 9), "deadbee"] }], null, new Map([[a, { rg }]]));
      const dates = await commitDates(rg, [c1, signed]);
      return { res, dates };
    });
    expect(result.res[0]!.resolved.map((r) => r.sha)).toEqual([c1, signed]);
    expect(result.dates.size).toBe(2);
    expect(hostile.ran()).toEqual([]);
    await runControls(a, env, { diff: [c1, signed], signed });
    expect(hostile.ran()).toEqual(expect.arrayContaining(["gpg", "diff-command"]));   // the attribute driver wins over diff.external
  });
});
