// test/repos.harden.test.ts — B1-M1-T2 (wave-2 plan): `hgit` and the hardening.
//
// Security is this file's subject: the live git check runs git inside the user's repos every minute, so a
// hostile repo's own config must not make the app run anything, write anything to the repo, or fetch.
// Every case is BY BEHAVIOUR (a driver that would run leaves a marker file; an index that would be
// rewritten changes bytes), each with its CONTROL: the same fixture without the hardening shows the
// marker, so a test that cannot fail is caught by its own control. Scratch repos only, built per test,
// with a per-test global config and no system config (fixtures/repos-fixtures.ts, which says why the
// environment reaches git through a spawn spy).
import { test, expect, describe, spyOn } from "bun:test";
import { existsSync, readFileSync, realpathSync, rmSync, utimesSync, writeFileSync, mkdirSync, appendFileSync, renameSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { startGitBudget, mergeMembers, listDefaultRefMerges, defaultRefs, IncompleteReadError, runGit } from "../src/git";
import * as stream from "../src/stream";
import { hgit, resolveCommit, mergeBase, HGIT_MAX_BYTES } from "../src/repos/hgit";
import {
  hardenArgs, lazyFetchProbe, parseDriverListing, driverOverrides, partialCloneStrict, gitVersionAtLeast,
} from "../src/repos/harden";
import { commitAt, g, gRaw, gitAtLeast, gitEnv, isolatedGit, markerScript, newRepo, scratch } from "./fixtures/repos-fixtures";

const budget = () => startGitBudget(60_000);
const LAZY = { lazyFetch: true };
type Hardened = { lead: string[]; gitDir: string; commonDir: string };
function lead(h: Awaited<ReturnType<typeof hardenArgs>>): string[] {
  if ("unknown" in h) throw new Error(`hardenArgs answered unknown: ${h.unknown}`);
  return (h as Hardened).lead;
}

/** Make `file` stat-dirty with the SAME content: a later mtime, so `status` must read it (through any
 *  clean filter) to learn it is unchanged. A size change alone would let git skip the filter. */
function touchLater(repo: string, file: string): void {
  const t = new Date(Date.now() + 60_000);
  utimesSync(join(repo, file), t, t);
}

/** Run `fn` with the isolated git environment reaching every git spawn. */
async function under<T>(env: Record<string, string>, fn: () => Promise<T>, substitute?: (argv: string[]) => string[] | undefined) {
  const spy = gitEnv(env, substitute);
  try { return { result: await fn(), calls: spy.calls }; } finally { spy.restore(); }
}

// ── the parse (pure) ──────────────────────────────────────────────────────────────────────────────────

describe("parseDriverListing: scope before the TAB; section before the FIRST dot, variable after the LAST", () => {
  test("repo scopes only; dotted names kept; one-dot keys skipped; the empty name is a driver", () => {
    const out = [
      "local\tfilter.x.clean", "local\tfilter.x.process", "global\tfilter.lfs.clean", "worktree\tmerge.m.driver",
      "local\tdiff.d.textconv", "local\tfilter.a.b.clean", "local\tmerge.ff", "local\tdiff.renames",
      "local\tfilter..clean", "system\tdiff.s.command", "local\tfilter.a b.smudge",
    ].join("\n") + "\n";
    expect(parseDriverListing(out)).toEqual({
      drivers: [
        { section: "filter", name: "x" }, { section: "merge", name: "m" }, { section: "diff", name: "d" },
        { section: "filter", name: "a.b" }, { section: "filter", name: "" }, { section: "filter", name: "a b" },
      ],
    });
    expect(parseDriverListing("")).toEqual({ drivers: [] });
  });

  test("a driver name -c cannot carry (`=`) makes the listing bad", () => {
    expect(parseDriverListing("local\tfilter.a=b.clean\n")).toEqual({ bad: true });
  });

  test("the overrides: three per filter, one per merge driver, two per diff driver, built from the whole name", () => {
    expect(driverOverrides([{ section: "filter", name: "a.b" }, { section: "merge", name: "" }, { section: "diff", name: "d" }])).toEqual([
      "-c", "filter.a.b.clean=", "-c", "filter.a.b.process=", "-c", "filter.a.b.smudge=",
      "-c", "merge..driver=",
      "-c", "diff.d.textconv=", "-c", "diff.d.command=",
    ]);
  });

  test("gitVersionAtLeast reads git's own version line", () => {
    expect(gitVersionAtLeast("git version 2.31.0\n", 2, 31)).toBe(true);
    expect(gitVersionAtLeast("git version 2.30.9", 2, 31)).toBe(false);
    expect(gitVersionAtLeast("git version 2.50.1 (Apple Git-155)", 2, 31)).toBe(true);
    expect(gitVersionAtLeast("git version 3.0.0", 2, 31)).toBe(true);
    expect(gitVersionAtLeast("", 2, 31)).toBe(false);
  });
});

// ── no lock, no write ─────────────────────────────────────────────────────────────────────────────────

describe("no index.lock and no index write", () => {
  test("a hardened status leaves a stale index byte-identical; a plain status (the control) rewrites it", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const index = join(repo, ".git", "index");
    touchLater(repo, "f.txt");
    const before = readFileSync(index);
    const { result } = await under(env, async () => {
      const h = lead(await hardenArgs(repo, budget(), LAZY));
      return hgit(repo, ["status", "--porcelain", "--ignore-submodules=all"], { lead: h, timeoutMs: 10_000 });
    });
    expect([result.code, result.complete, result.out]).toEqual([0, true, ""]);
    expect(existsSync(index + ".lock")).toBe(false);
    expect(readFileSync(index).equals(before)).toBe(true);
    // CONTROL: the same status without --no-optional-locks refreshes (rewrites) the stale index
    await g(repo, ["status", "--porcelain"], env);
    expect(readFileSync(index).equals(before)).toBe(false);
  });
});

// ── repo-scoped drivers never run ─────────────────────────────────────────────────────────────────────

describe("repo-scoped drivers are neutralised (OD2)", () => {
  async function filterRepo(env: Record<string, string>, name: string, attr: string) {
    const repo = await newRepo({ "f.txt": "f\n", ".gitattributes": `f.txt filter=${attr}\n` });
    const marker = join(scratch("marker"), "ran");
    const script = markerScript(scratch("bin"), "clean.sh", marker);
    await g(repo, ["config", `filter.${name}.clean`, script], env);
    touchLater(repo, "f.txt");
    return { repo, marker };
  }
  const hardenedStatus = (repo: string) => async () => {
    const h = await hardenArgs(repo, budget(), LAZY);
    const r = await hgit(repo, ["status", "--porcelain", "--ignore-submodules=all"], { lead: lead(h), timeoutMs: 10_000 });
    return { h, r };
  };

  test("a filter.x.clean on a stat-dirty, same-content file never runs, and status still answers; the control runs it", async () => {
    const { env } = isolatedGit();
    const { repo, marker } = await filterRepo(env, "x", "x");
    const { result } = await under(env, hardenedStatus(repo));
    expect([result.r.code, result.r.complete]).toEqual([0, true]);
    expect(lead(result.h)).toEqual(expect.arrayContaining(["filter.x.clean=", "filter.x.process=", "filter.x.smudge="]));
    expect(existsSync(marker)).toBe(false);
    await g(repo, ["status", "--porcelain"], env);                      // CONTROL: no override
    expect(existsSync(marker)).toBe(true);
  });

  test("a dotted driver name: filter.a.b.clean, selected by filter=a.b, never runs under the hardening; the control runs it", async () => {
    const { env } = isolatedGit();
    const { repo, marker } = await filterRepo(env, "a.b", "a.b");
    // the listing really is `local<TAB>filter.a.b.clean` (parsed from git's own output)
    expect(await g(repo, ["config", "--show-scope", "--name-only", "--get-regexp", "^(filter|merge|diff)\\."], env)).toBe("local\tfilter.a.b.clean\n");
    const { result } = await under(env, hardenedStatus(repo));
    expect(result.r.code).toBe(0);
    expect(lead(result.h)).toEqual(expect.arrayContaining(["filter.a.b.clean=", "filter.a.b.process=", "filter.a.b.smudge="]));
    expect(existsSync(marker)).toBe(false);
    await g(repo, ["status", "--porcelain"], env);
    expect(existsSync(marker)).toBe(true);
  });

  test("the empty name: [filter \"\"] (filter..clean), selected by `f filter=`, never runs; its argv carries the three filter.. overrides", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo({ "f.txt": "f\n", ".gitattributes": "f.txt filter=\n" });
    const marker = join(scratch("marker"), "ran");
    const script = markerScript(scratch("bin"), "clean.sh", marker);
    appendFileSync(join(repo, ".git", "config"), `[filter ""]\n\tclean = ${script}\n`);
    expect(await g(repo, ["config", "--show-scope", "--name-only", "--get-regexp", "^(filter|merge|diff)\\."], env)).toBe("local\tfilter..clean\n");
    touchLater(repo, "f.txt");
    await g(repo, ["status", "--porcelain"], env);                      // CONTROL first: it runs
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
    touchLater(repo, "f.txt");
    const { result } = await under(env, hardenedStatus(repo));
    expect(result.r.code).toBe(0);
    const l = lead(result.h);
    const at = l.indexOf("filter..clean=");
    expect(l.slice(at - 1, at + 5)).toEqual(["-c", "filter..clean=", "-c", "filter..process=", "-c", "filter..smudge="]);
    expect(existsSync(marker)).toBe(false);
  });

  test("two-part keys (merge.ff, diff.renames) are not drivers: the repo answers, no override is built from them, merge.ff still reads false", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await g(repo, ["config", "merge.ff", "false"], env);
    await g(repo, ["config", "diff.renames", "true"], env);
    const { result } = await under(env, async () => {
      const h = await hardenArgs(repo, budget(), LAZY);
      const ff = await hgit(repo, ["config", "merge.ff"], { lead: lead(h), timeoutMs: 10_000 });
      return { h, ff };
    });
    const l = lead(result.h);
    expect(l.some((a) => a.startsWith("merge.ff.") || a.startsWith("diff.renames."))).toBe(false);
    expect(l.filter((a) => a.startsWith("filter."))).toEqual([]);
    expect([result.ff.code, result.ff.out]).toEqual([0, "false\n"]);
  });

  test("a diff.x.textconv never runs under --numstat or diff --no-textconv, both answer; the control (a plain diff) runs it", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo({ "a.t": "one\n", ".gitattributes": "*.t diff=x\n" });
    writeFileSync(join(repo, "a.t"), "two\n");
    await g(repo, ["commit", "-q", "-am", "second"], env);
    const marker = join(scratch("marker"), "ran");
    const script = markerScript(scratch("bin"), "textconv.sh", marker, 'cat "$1"');
    await g(repo, ["config", "diff.x.textconv", script], env);
    const { result } = await under(env, async () => {
      const l = lead(await hardenArgs(repo, budget(), LAZY));
      const numstat = await hgit(repo, ["log", "--no-show-signature", "-1", "--numstat", "--format=%H"], { lead: l, timeoutMs: 10_000 });
      const diff = await hgit(repo, ["diff", "--no-textconv", "--no-ext-diff", "--no-color", "HEAD~1", "HEAD"], { lead: l, timeoutMs: 10_000 });
      const logp = await hgit(repo, ["log", "--no-show-signature", "-1", "-p", "--format=%H"], { lead: l, timeoutMs: 10_000 });
      return { l, numstat, diff, logp };
    });
    expect(result.l).toEqual(expect.arrayContaining(["diff.x.textconv=", "diff.x.command="]));
    expect([result.numstat.code, result.diff.code]).toEqual([0, 0]);
    expect(result.diff.out).toContain("+two");
    expect(result.logp.code).not.toBe(0);                             // the emptied textconv makes `log -p` fatal: no hardened path uses it
    expect(existsSync(marker)).toBe(false);
    await g(repo, ["diff", "HEAD~1", "HEAD"], env);                     // CONTROL
    expect(existsSync(marker)).toBe(true);
  });

  test.skipIf(!gitAtLeast(2, 38))("a merge.x.driver never runs (merge-tree reports a conflict instead); the control runs it", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo({ "m.txt": "base\n", ".gitattributes": "m.txt merge=x\n" });
    await g(repo, ["checkout", "-q", "-b", "a"], env);
    writeFileSync(join(repo, "m.txt"), "a\n");
    await g(repo, ["commit", "-q", "-am", "a"], env);
    await g(repo, ["checkout", "-q", "-b", "b", "main"], env);
    writeFileSync(join(repo, "m.txt"), "b\n");
    await g(repo, ["commit", "-q", "-am", "b"], env);
    const marker = join(scratch("marker"), "ran");
    const script = markerScript(scratch("bin"), "merge.sh", marker, "exit 0");
    await g(repo, ["config", "merge.x.driver", `${script} %O %A %B`], env);
    const objects = join(scratch("objects"), "o");
    mkdirSync(objects);
    const { result } = await under(env, async () => {
      const l = lead(await hardenArgs(repo, budget(), LAZY));
      return hgit(repo, ["merge-tree", "--write-tree", "--end-of-options", "refs/heads/a", "refs/heads/b"], {
        lead: l, timeoutMs: 10_000, env: { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo, ".git", "objects") },
      });
    });
    expect(result.code).toBe(1);                                      // a conflict: the squash check's designed fallback
    expect(existsSync(marker)).toBe(false);
    await gRaw(repo, ["merge-tree", "--write-tree", "a", "b"], env);    // CONTROL
    expect(existsSync(marker)).toBe(true);
  });
});

describe("core.fsmonitor", () => {
  test("a repo's core.fsmonitor hook never runs under the hardening; the control runs it", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const marker = join(scratch("marker"), "ran");
    // a hook git calls as `<hook> <version> <token>`; it prints nothing useful, which git tolerates
    const hook = markerScript(scratch("bin"), "fsmonitor.sh", marker, "exit 1");
    await g(repo, ["config", "core.fsmonitor", hook], env);
    const { result } = await under(env, async () => {
      const l = lead(await hardenArgs(repo, budget(), LAZY));
      return { l, r: await hgit(repo, ["status", "--porcelain", "--ignore-submodules=all"], { lead: l, timeoutMs: 10_000 }) };
    });
    expect(result.l).toEqual(expect.arrayContaining(["-c", "core.fsmonitor=false"]));
    expect(result.r.code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    await gRaw(repo, ["status", "--porcelain"], env);                  // CONTROL
    expect(existsSync(marker)).toBe(true);
  });
});

describe("both scopes (OD2): the user's own drivers run as git runs them; the repo's are neutralised wherever they come from", () => {
  test("a filter in the per-test GLOBAL config runs (marker), and the repo answers", async () => {
    const { env, global } = isolatedGit();
    const marker = join(scratch("marker"), "ran");
    const script = markerScript(scratch("bin"), "clean.sh", marker);
    writeFileSync(global, `[filter "g"]\n\tclean = ${script}\n`);
    const repo = await newRepo({ "f.txt": "f\n", ".gitattributes": "f.txt filter=g\n" });
    touchLater(repo, "f.txt");
    const { result } = await under(env, async () => {
      const h = await hardenArgs(repo, budget(), LAZY);
      return { h, r: await hgit(repo, ["status", "--porcelain", "--ignore-submodules=all"], { lead: lead(h), timeoutMs: 10_000 }) };
    });
    expect(result.r.code).toBe(0);
    expect(lead(result.h).filter((a) => a.startsWith("filter."))).toEqual([]);
    expect(existsSync(marker)).toBe(true);
  });

  test("a driver reached through include.path from the repo's config is neutralised (scope local); the control runs it", async () => {
    const { env } = isolatedGit();
    const marker = join(scratch("marker"), "ran");
    const script = markerScript(scratch("bin"), "clean.sh", marker);
    const inc = join(scratch("inc"), "inc.cfg");
    writeFileSync(inc, `[filter "i"]\n\tclean = ${script}\n`);
    const repo = await newRepo({ "f.txt": "f\n", ".gitattributes": "f.txt filter=i\n" });
    await g(repo, ["config", "include.path", inc], env);
    touchLater(repo, "f.txt");
    const { result } = await under(env, async () => {
      const h = await hardenArgs(repo, budget(), LAZY);
      return { h, r: await hgit(repo, ["status", "--porcelain", "--ignore-submodules=all"], { lead: lead(h), timeoutMs: 10_000 }) };
    });
    expect(result.r.code).toBe(0);
    expect(lead(result.h)).toEqual(expect.arrayContaining(["filter.i.clean="]));
    expect(existsSync(marker)).toBe(false);
    await g(repo, ["status", "--porcelain"], env);
    expect(existsSync(marker)).toBe(true);
  });

  test("a repo-scoped filter with required = true → unknown (required-filter), never weakened; required = false answers", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo({ "f.txt": "f\n", ".gitattributes": "f.txt filter=r\n" });
    await g(repo, ["config", "filter.r.clean", "cat"], env);
    await g(repo, ["config", "filter.r.required", "true"], env);
    const req = await under(env, () => hardenArgs(repo, budget(), LAZY));
    expect(req.result).toEqual({ unknown: "required-filter" });
    expect(req.calls.flat()).not.toContain("filter.r.required=false");
    await g(repo, ["config", "filter.r.required", "false"], env);
    const ok = await under(env, () => hardenArgs(repo, budget(), LAZY));
    expect(lead(ok.result)).toEqual(expect.arrayContaining(["filter.r.clean="]));
    // the empty name's `required`, likewise
    const empty = await newRepo();
    appendFileSync(join(empty, ".git", "config"), `[filter ""]\n\tclean = cat\n\trequired = true\n`);
    expect((await under(env, () => hardenArgs(empty, budget(), LAZY))).result).toEqual({ unknown: "required-filter" });
  });
});

// ── output bounds ─────────────────────────────────────────────────────────────────────────────────────

describe("output bounds", () => {
  test("a call printing past 1 MiB fails and its repo answers unknown, while a second repo answers; the child is killed at the cap", async () => {
    const { env } = isolatedGit();
    const [noisy, quiet] = [await newRepo(), await newRepo()];
    const sub = (argv: string[]) => (argv[2] === noisy && argv.includes("rev-parse")
      ? ["sh", "-c", "exec dd if=/dev/zero bs=65536 count=64 2>/dev/null"] : undefined);   // 4 MiB, one process
    const t0 = performance.now();
    const n = await under(env, () => hardenArgs(noisy, budget(), LAZY), sub);
    const elapsed = performance.now() - t0;
    expect(n.result).toEqual({ unknown: "error" });
    // Killed at the cap, not left blocked on its full pipe until the 30 s timeout (the budget allows it)
    expect(elapsed).toBeLessThan(1000);
    expect(HGIT_MAX_BYTES).toBe(1024 * 1024);
    const q = await under(env, () => hardenArgs(quiet, budget(), LAZY), sub);
    expect("lead" in q.result).toBe(true);
  });
});

describe("hgit", () => {
  test("stdout past the cap: incomplete, killed by the cap (not a timeout); just under the cap: complete", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const big = (argv: string[]) => argv.includes("rev-parse") ? ["sh", "-c", "exec dd if=/dev/zero bs=65536 count=64 2>/dev/null"] : undefined;
    const t0 = performance.now();
    const over = await under(env, () => hgit(repo, ["rev-parse", "HEAD"], { lead: [], timeoutMs: 30_000 }), big);
    expect(performance.now() - t0).toBeLessThan(1000);                 // not the 30 s timeout
    expect([over.result.complete, over.result.timedOut, over.result.code, over.result.out]).toEqual([false, false, null, ""]);
    const under1 = (argv: string[]) => argv.includes("rev-parse") ? ["sh", "-c", "exec dd if=/dev/zero bs=65536 count=15 2>/dev/null"] : undefined;
    const ok = await under(env, () => hgit(repo, ["rev-parse", "HEAD"], { lead: [], timeoutMs: 30_000 }), under1);
    expect([ok.result.complete, ok.result.code, ok.result.out.length]).toEqual([true, 0, 15 * 65536]);
    // the cap is per call: the listings' 16 MiB lets the 4 MiB through
    const listing = await under(env, () => hgit(repo, ["rev-parse", "HEAD"], { lead: [], timeoutMs: 30_000, maxBytes: 16 * 1024 * 1024 }), big);
    expect([listing.result.complete, listing.result.out.length]).toEqual([true, 64 * 65536]);
  });

  test("a timeout is timedOut; a non-zero exit is an answer, never a throw; a spooled stdout lands in its file", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const slow = await under(env, () => hgit(repo, ["status"], { lead: [], timeoutMs: 200 }), (a) => a.includes("status") ? ["sh", "-c", "exec sleep 5"] : undefined);
    expect([slow.result.timedOut, slow.result.code]).toEqual([true, null]);
    const miss = await under(env, () => hgit(repo, ["config", "--get-regexp", "^nosuch\\."], { lead: [], timeoutMs: 10_000 }));
    expect([miss.result.code, miss.result.out, miss.result.complete]).toEqual([1, "", true]);
    const spool = join(scratch("spool"), "out.txt");
    const sp = await under(env, () => hgit(repo, ["rev-parse", "HEAD"], { lead: [], timeoutMs: 10_000, stdoutPath: spool }));
    expect([sp.result.code, sp.result.complete, sp.result.out]).toEqual([0, true, ""]);
    expect(readFileSync(spool, "utf8")).toMatch(/^[0-9a-f]{40}\n$/);
  });
});

// ── argv safety ───────────────────────────────────────────────────────────────────────────────────────

describe("a hostile ref name (refs/heads/-n)", () => {
  test("resolutions name the FULL ref after --end-of-options and give one 40-hex line; a missing ref gives none", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await g(repo, ["update-ref", "refs/heads/-n", "HEAD"], env);
    const head = (await g(repo, ["rev-parse", "HEAD"], env)).trim();
    const { result, calls } = await under(env, async () => {
      const l = lead(await hardenArgs(repo, budget(), LAZY));
      return {
        r: await resolveCommit(repo, l, 10_000, "refs/heads/-n"),
        missing: await resolveCommit(repo, l, 10_000, "refs/heads/nope"),
        mb: await mergeBase(repo, l, 10_000, "refs/heads/-n", "refs/heads/main"),
      };
    });
    expect(result).toEqual({ r: { sha: head }, missing: { absent: true }, mb: { sha: head } });
    for (const argv of calls.filter((a) => a.includes("rev-parse") && a.includes("--verify") || a.includes("merge-base"))) {
      const eoo = argv.indexOf("--end-of-options");
      expect(eoo).toBeGreaterThan(0);
      expect(argv.slice(eoo + 1).every((a) => a.startsWith("refs/") || /^[0-9a-f]{40}/.test(a))).toBe(true);
    }
    expect(calls.flat()).not.toContain("-n");                         // no short ref name anywhere in any argv
    // why: the short name, among rev-list's arguments, is read as an option (the probe the plan cites)
    const short = await gRaw(repo, ["rev-list", "--topo-order", "-n", "--not", "refs/heads/main"], env);
    expect(short.code).not.toBe(0);
  });
});

// ── the first call: git too old, dubious ownership, absolute paths ──────────────────────────────────────

describe("the version probe", () => {
  test("a git reporting 2.30.0 is too old (below --path-format=absolute's 2.31), and nothing else is spawned", async () => {
    const { env } = isolatedGit();
    const sub = (argv: string[]) => argv.includes("--no-lazy-fetch") ? ["sh", "-c", "echo 'unknown option: --no-lazy-fetch' >&2; exit 129"]
      : argv[1] === "--version" ? ["sh", "-c", "echo 'git version 2.30.0'"] : undefined;
    const { result, calls } = await under(env, () => lazyFetchProbe(10_000), sub);
    expect(result).toEqual({ lazyFetch: false, version: "git version 2.30.0\n", tooOld: true });
    expect(calls).toEqual([["git", "--no-lazy-fetch", "--version"], ["git", "--version"]]);
  });

  test("this machine's git: the flag accepted, one spawn, not too old", async () => {
    const { env } = isolatedGit();
    const { result, calls } = await under(env, () => lazyFetchProbe(10_000));
    expect(result.tooOld).toBe(false);
    expect(result.version).toMatch(/^git version \d+\.\d+/);
    expect(calls.length).toBe(result.lazyFetch ? 1 : 2);
  });
});

describe("dubious ownership", () => {
  test("GIT_TEST_ASSUME_DIFFERENT_OWNER=1 → unknown (dubious-ownership), detected by the first rev-parse", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const { result, calls } = await under({ ...env, GIT_TEST_ASSUME_DIFFERENT_OWNER: "1" }, () => hardenArgs(repo, budget(), LAZY));
    expect(result).toEqual({ unknown: "dubious-ownership" });
    expect(calls.length).toBe(1);
    expect(calls[0]!.slice(-5)).toEqual(["rev-parse", "--path-format=absolute", "--absolute-git-dir", "--git-common-dir", "--show-toplevel"]);
    expect(calls[0]!.slice(0, 4)).toEqual(["git", "-C", repo, "--no-optional-locks"]);
    // nothing was added to safe.directory
    expect((await gRaw(repo, ["config", "--global", "--get-all", "safe.directory"], env)).out).toBe("");
  });
});

describe("gitDir and commonDir", () => {
  test("absolute for a primary checkout, a configured subdirectory of the work tree and a linked worktree, with the cwd elsewhere", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    mkdirSync(join(repo, "sub"));
    const wt = join(scratch("wt"), "linked");
    await g(repo, ["worktree", "add", "-q", wt], env);
    const real = (p: string) => realpathSync(p);
    const cwd = process.cwd();
    process.chdir(scratch("elsewhere"));
    try {
      const got = await under(env, async () => ({
        primary: await hardenArgs(repo, budget(), LAZY),
        sub: await hardenArgs(join(repo, "sub"), budget(), LAZY),
        linked: await hardenArgs(wt, budget(), LAZY),
      }));
      const dirs = (h: Awaited<ReturnType<typeof hardenArgs>>) => {
        expect("unknown" in h).toBe(false);
        const x = h as Hardened;
        expect(isAbsolute(x.gitDir) && isAbsolute(x.commonDir)).toBe(true);
        return [real(x.gitDir), real(x.commonDir)];
      };
      const git = real(join(repo, ".git"));
      expect(dirs(got.result.primary)).toEqual([git, git]);
      expect(dirs(got.result.sub)).toEqual([git, git]);
      expect(dirs(got.result.linked)).toEqual([real(join(repo, ".git", "worktrees", "linked")), git]);
    } finally { process.chdir(cwd); }
  });

  for (const scope of ["local", "global"]) {
    test(`core.worktree set to an ancestor in ${scope} config is elsewhere`, async () => {
      const { env } = isolatedGit();
      const repo = await newRepo();
      // Git discovery ignores global core.worktree; a subdirectory still has to check effective config.
      const configured = scope === "global" ? join(repo, "sub") : repo;
      if (configured !== repo) mkdirSync(configured);
      await g(repo, ["config", `--${scope}`, "core.worktree", join(repo, "..")], env);
      const { result } = await under(env, () => hardenArgs(configured, budget(), LAZY));
      expect(result).toEqual({ unknown: "elsewhere" });
    });
  }

  test("a sibling-prefix directory is elsewhere even without core.worktree", async () => {
    const { env } = isolatedGit();
    const toplevel = join(scratch("prefix"), "repo"), repo = `${toplevel}2`;
    mkdirSync(toplevel);
    renameSync(await newRepo(), repo);
    // Isolate the containment check: real git cannot report a sibling as its toplevel without a
    // redirect, which would independently be refused by the effective-config check.
    const git = join(repo, ".git");
    const { result } = await under(env, () => hardenArgs(repo, budget(), LAZY),
      (a) => a.includes("rev-parse") ? ["printf", "%s\n", git, git, toplevel] : undefined);
    expect(result).toEqual({ unknown: "elsewhere" });
  });

  for (const [name, command, unknown] of [
    ["error", "exit 2", "error"],
    ["exit 1 with output", "printf 'unexpected\\n'; exit 1", "error"],
    ["timeout", "exec sleep 5", "timeout"],
  ] as const) {
    test(`a subdirectory's core.worktree config ${name} stays unknown`, async () => {
      const { env } = isolatedGit();
      const repo = join(await newRepo(), "sub");
      mkdirSync(repo);
      const { result } = await under(env, () => hardenArgs(repo, startGitBudget(2000), LAZY),
        (a) => a.includes("config") && a.includes("core.worktree") ? ["sh", "-c", command] : undefined);
      expect(result).toEqual({ unknown });
    });
  }
});

// ── lazy fetching ─────────────────────────────────────────────────────────────────────────────────────

describe("a git that refuses --no-lazy-fetch", () => {
  const refuse = (argv: string[]) => argv.includes("--no-lazy-fetch") ? ["sh", "-c", "exit 129"] : undefined;

  test("the probe says refused; a non-partial repo answers (without the flag); a partial clone and a repo whose config query fails answer unknown", async () => {
    const { env } = isolatedGit();
    const plain = await newRepo();
    const partial = await newRepo();
    await g(partial, ["config", "extensions.partialClone", "origin"], env);
    const broken = await newRepo();
    await g(broken, ["config", "remote.origin.promisor", "maybe"], env);   // --type=bool cannot read it: exit 128
    const { result } = await under(env, async () => {
      const laz = await lazyFetchProbe(10_000);
      return {
        laz,
        plain: await hardenArgs(plain, budget(), laz),
        partial: await hardenArgs(partial, budget(), laz),
        broken: await hardenArgs(broken, budget(), laz),
      };
    }, refuse);
    expect(result.laz.lazyFetch).toBe(false);
    expect(lead(result.plain)).not.toContain("--no-lazy-fetch");
    expect(result.partial).toEqual({ unknown: "partial-clone" });
    expect(result.broken).toEqual({ unknown: "error" });
  });

  test("partialCloneStrict: no match only on exit 1 with empty output; any other failure is unknown", async () => {
    const { env } = isolatedGit();
    const plain = await newRepo();
    const promisor = await newRepo();
    await g(promisor, ["config", "remote.origin.promisor", "true"], env);
    const { result } = await under(env, async () => ({
      plain: await partialCloneStrict(plain, ["--no-optional-locks"], 10_000),
      promisor: await partialCloneStrict(promisor, ["--no-optional-locks"], 10_000),
    }));
    expect(result.plain).toBe("not-partial");
    expect(result.promisor).toBe("partial");
    const killed = await under(env, () => partialCloneStrict(plain, ["--no-optional-locks"], 10_000),
      (argv) => argv.some((a) => a.includes("partialclonefilter")) ? ["sh", "-c", "kill -KILL $$"] : undefined);
    expect(killed.result).toBe("unknown");
  });
});

describe.skipIf(!gitAtLeast(2, 44))("a partial clone with a missing blob, the flag supported", () => {
  test("the call that needs the blob fails, nothing is fetched (no fetch / upload-pack child in trace2); the control fetches", async () => {
    const { env } = isolatedGit();
    const origin = await newRepo({ "big.txt": "x".repeat(10_000) + "\n" });
    await g(origin, ["config", "uploadpack.allowFilter", "true"], env);
    const work = join(scratch("partial"), "work");
    await g(process.cwd(), ["clone", "-q", "--filter=blob:none", "--no-checkout", `file://${origin}`, work], env);
    const trace = join(scratch("trace2"), "events.json");
    const { result } = await under({ ...env, GIT_TRACE2_EVENT: trace }, async () => {
      const laz = await lazyFetchProbe(10_000);
      const l = lead(await hardenArgs(work, budget(), laz));
      expect(l).toContain("--no-lazy-fetch");
      return hgit(work, ["cat-file", "-p", "HEAD:big.txt"], { lead: l, timeoutMs: 10_000 });
    });
    expect(result.code).not.toBe(0);
    const fetched = (text: string) => text.split("\n").filter(Boolean).map((l) => JSON.parse(l) as { event: string; argv?: string[] })
      .some((e) => e.event === "child_start" && (e.argv ?? []).some((a) => /fetch|upload-pack/.test(a)));
    expect(fetched(existsSync(trace) ? readFileSync(trace, "utf8") : "")).toBe(false);
    // CONTROL: the same read without the hardening lazily fetches from the promisor remote
    const trace2 = join(scratch("trace2"), "events.json");
    const p = await gRaw(work, ["cat-file", "-p", "HEAD:big.txt"], { ...env, GIT_TRACE2_EVENT: trace2 });
    expect(p.code).toBe(0);
    expect(fetched(readFileSync(trace2, "utf8"))).toBe(true);
  });
});

// B1-M1 hostile-repo checkpoint regressions. Controls run only in these disposable fixture repos.
describe("checkpoint: submodule descent", () => {
  test("submodule textconv and clean drivers stay idle without per-call submodule flags", async () => {
    const { env } = isolatedGit();
    const source = await newRepo({ "a.t": "one\n", ".gitattributes": "*.t diff=z\na.t filter=q\n" });
    const parent = await newRepo();
    await g(parent, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", source, "sub"], env);
    await g(parent, ["commit", "-q", "-m", "add sub"], env);
    const a = (await g(parent, ["rev-parse", "HEAD"], env)).trim();
    const sub = join(parent, "sub");
    await g(sub, ["config", "user.name", "Test"], env);
    await g(sub, ["config", "user.email", "test@example.com"], env);
    writeFileSync(join(sub, "a.t"), "two\n");
    await g(sub, ["commit", "-q", "-am", "two"], env);
    await g(parent, ["add", "sub"], env);
    await g(parent, ["commit", "-q", "-m", "bump sub"], env);
    const b = (await g(parent, ["rev-parse", "HEAD"], env)).trim();
    const bin = scratch("sub-drivers"), clean = join(bin, "clean-ran"), conv = join(bin, "conv-ran");
    await g(sub, ["config", "diff.z.textconv", markerScript(bin, "conv.sh", conv, 'cat "$1"')], env);
    await g(sub, ["config", "filter.q.clean", markerScript(bin, "clean.sh", clean)], env);
    await g(parent, ["config", "diff.submodule", "diff"], env);
    const diff = ["diff", "--no-textconv", "--no-ext-diff", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--end-of-options", a, b];
    await under(env, async () => {
      const l = lead(await hardenArgs(parent, budget(), LAZY));
      expect(l.some((v) => v.startsWith("diff.z.") || v.startsWith("filter.q."))).toBe(false);
      touchLater(sub, "a.t");
      const status = await hgit(parent, ["status", "--porcelain"], { lead: l, timeoutMs: 10_000 });
      const patch = await hgit(parent, diff, { lead: l, timeoutMs: 10_000 });
      expect([status.code, status.complete, patch.code, patch.complete]).toEqual([0, true, 0, true]);
      expect(existsSync(clean)).toBe(false);
      expect(existsSync(conv)).toBe(false);
      // Exercise the short format independently of the ignore setting: even a caller that explicitly
      // requests gitlink differences must not descend into the submodule's textconv.
      const gitlink = await hgit(parent, diff, { lead: [...l, "-c", "diff.ignoreSubmodules=none"], timeoutMs: 10_000 });
      expect([gitlink.code, gitlink.complete]).toEqual([0, true]);
      expect(gitlink.out).toContain("Subproject commit");
      expect(existsSync(conv)).toBe(false);
    });
    touchLater(sub, "a.t");
    await g(parent, ["status", "--porcelain"], env);
    expect(existsSync(clean)).toBe(true);
    await g(parent, diff, env);
    expect(existsSync(conv)).toBe(true);
  });
});

describe("checkpoint: full lead", () => {
  test("log.showSignature cannot start gpg even without --no-show-signature", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const tree = (await g(repo, ["rev-parse", "HEAD^{tree}"], env)).trim();
    const raw = join(scratch("signed"), "commit");
    writeFileSync(raw, `tree ${tree}\nauthor T <t@e.com> 1700000000 +0000\ncommitter T <t@e.com> 1700000000 +0000\ngpgsig -----BEGIN PGP SIGNATURE-----\n \n iQEzBAABCAAdFiEEforgedforgedforgedforgedforgedAAAA\n -----END PGP SIGNATURE-----\n\nsigned subject\n`);
    const sha = (await g(repo, ["hash-object", "-t", "commit", "-w", raw], env)).trim();
    await g(repo, ["update-ref", "refs/heads/signed", sha], env);
    const marker = join(scratch("gpg"), "ran");
    await g(repo, ["config", "gpg.program", markerScript(scratch("bin"), "gpg.sh", marker, "exit 0")], env);
    await g(repo, ["config", "gpg.format", "openpgp"], env);
    await g(repo, ["config", "log.showSignature", "true"], env);
    const args = ["log", "-1", "--format=%H%x1f%s", "refs/heads/signed"];
    const { result } = await under(env, async () => hgit(repo, args, { lead: lead(await hardenArgs(repo, budget(), LAZY)), timeoutMs: 10_000 }));
    expect([result.code, result.complete, result.out]).toEqual([0, true, `${sha}\x1fsigned subject\n`]);
    expect(existsSync(marker)).toBe(false);
    await gRaw(repo, args, env);
    expect(existsSync(marker)).toBe(true);
  });

  test("diff.external cannot run without --no-ext-diff", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo({ "a.t": "one\n" });
    writeFileSync(join(repo, "a.t"), "two\n");
    await g(repo, ["commit", "-q", "-am", "two"], env);
    const marker = join(scratch("external"), "ran");
    await g(repo, ["config", "diff.external", markerScript(scratch("bin"), "diff.sh", marker, "exit 0")], env);
    const args = ["diff", "HEAD~1", "HEAD"];
    const { result } = await under(env, async () => hgit(repo, args, { lead: lead(await hardenArgs(repo, budget(), LAZY)), timeoutMs: 10_000 }));
    // An empty external command may make git fail; it must never execute the configured program.
    expect(result.complete).toBe(true);
    expect(existsSync(marker)).toBe(false);
    await gRaw(repo, args, env);
    expect(existsSync(marker)).toBe(true);
  });

  test.skipIf(!gitAtLeast(2, 38))("merge.renormalize cannot start a GLOBAL clean filter", async () => {
    const { env, global } = isolatedGit();
    const repo = await newRepo({ "m.txt": "base\n", ".gitattributes": "m.txt filter=g\n" });
    await g(repo, ["checkout", "-q", "-b", "a"], env);
    writeFileSync(join(repo, "m.txt"), "a\n");
    await g(repo, ["commit", "-q", "-am", "a"], env);
    await g(repo, ["checkout", "-q", "-b", "b", "main"], env);
    writeFileSync(join(repo, "m.txt"), "b\n");
    await g(repo, ["commit", "-q", "-am", "b"], env);
    const marker = join(scratch("renormalize"), "ran");
    writeFileSync(global, `[filter "g"]\n\tclean = ${markerScript(scratch("bin"), "clean.sh", marker)}\n`);
    await g(repo, ["config", "merge.renormalize", "true"], env);
    const args = ["merge-tree", "--write-tree", "--end-of-options", "refs/heads/a", "refs/heads/b"];
    const objects = scratch("merge-objects");
    const { result } = await under(env, async () => hgit(repo, args, {
      lead: lead(await hardenArgs(repo, budget(), LAZY)), timeoutMs: 10_000,
      env: { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo, ".git", "objects") },
    }));
    expect([result.code, result.complete]).toEqual([1, true]); // conflict is an answer
    expect(existsSync(marker)).toBe(false);
    await gRaw(repo, args, env);
    expect(existsSync(marker)).toBe(true);
  });

  test("refs/replace cannot spoof the real subject", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const a = (await g(repo, ["rev-parse", "HEAD"], env)).trim();
    const tree = (await g(repo, ["rev-parse", "HEAD^{tree}"], env)).trim();
    const fake = (await g(repo, ["commit-tree", tree, "-m", "FAKE subject"], env)).trim();
    await g(repo, ["replace", a, fake], env);
    const args = ["log", "-1", "--format=%s", a];
    const { result } = await under(env, async () => hgit(repo, args, { lead: lead(await hardenArgs(repo, budget(), LAZY)), timeoutMs: 10_000 }));
    expect([result.code, result.out]).toEqual([0, "add f.txt\n"]);
    expect(await g(repo, args, env)).toBe("FAKE subject\n");
  });

  test.skipIf(!gitAtLeast(2, 38))("status, log, for-each-ref, rev-parse, merge-base and merge-tree still answer with the full lead", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await under(env, async () => {
      const l = lead(await hardenArgs(repo, budget(), LAZY));
      for (const args of [
        ["status", "--porcelain"], ["log", "-1", "--format=%s"], ["for-each-ref", "--format=%(refname)"],
        ["rev-parse", "HEAD"], ["merge-base", "HEAD", "HEAD"], ["merge-tree", "--write-tree", "HEAD", "HEAD"],
      ]) {
        const r = await hgit(repo, args, { lead: l, timeoutMs: 10_000 });
        expect({ command: args[0], code: r.code, complete: r.complete }).toEqual({ command: args[0], code: 0, complete: true });
        if (args[0] !== "status") expect(r.out.trim().length).toBeGreaterThan(0);
      }
      expect((await hgit(repo, ["config", "core.hooksPath"], { lead: l, timeoutMs: 10_000 })).out).toBe("/dev/null\n");
    });
  });
});

describe("checkpoint: hgit IO and environment", () => {
  test("defaultRefs bounds live stderr retention, drains to EOF, and preserves the morning default", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const bin = scratch("shared-stderr"), marker = join(bin, "drained");
    const script = markerScript(bin, "git", join(bin, "started"), `dd if=/dev/zero bs=65536 count=32 >&2 2>/dev/null
touch '${marker}'
case "$*" in *symbolic-ref*) printf 'origin/main\\n';; *) printf 'refs/heads/main\\n';; esac`);
    const sizes: number[] = [];
    const sinkText = stream.sinkText;
    const spy = spyOn(stream, "sinkText").mockImplementation((sink) => {
      sizes.push(sink.chunks.reduce((n, c) => n + c.byteLength, 0));
      return sinkText(sink);
    });
    try {
      const { result } = await under(env, () => defaultRefs(repo, budget(), { lead: [] }), (args) => [script, ...args.slice(1)]);
      expect(result).toEqual({ refs: ["refs/heads/main"], name: "main", unread: false });
      expect(existsSync(marker)).toBe(true);
      expect(sizes).toHaveLength(4);
      expect(Math.max(...sizes)).toBe(64 * 1024);
      sizes.length = 0;
      await under(env, () => runGit(["for-each-ref"], repo), () => [script]);
      expect(Math.max(...sizes)).toBe(2 * 1024 * 1024);
    } finally { spy.mockRestore(); }
  });
  test("several MiB of stderr are drained while retention stays at 64 KiB", async () => {
    const { env } = isolatedGit();
    const bin = scratch("stderr-bin"), marker = join(bin, "ran");
    markerScript(bin, "git", marker, 'dd if=/dev/zero bs=65536 count=128 >&2 2>/dev/null\nprintf "valid\\n"');
    const sizes: number[] = [];
    const sinkText = stream.sinkText;
    const spy = spyOn(stream, "sinkText").mockImplementation((sink) => {
      sizes.push(sink.chunks.reduce((n, c) => n + c.byteLength, 0));
      return sinkText(sink);
    });
    try {
      const { result } = await under({ ...env, PATH: `${bin}:${process.env.PATH}` }, () => hgit(null, ["--version"], { lead: [], timeoutMs: 10_000 }), () => [join(bin, "git")]);
      expect(existsSync(marker)).toBe(true);
      expect([result.code, result.complete, result.out]).toEqual([0, true, "valid\n"]);
      expect(sizes.length).toBe(2); // retained stderr and stdout actually decoded by hgit
      expect(sizes[0]).toBe(64 * 1024);
      expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
    } finally { spy.mockRestore(); }
  });

  test("parent GIT_* and SSH_ASKPASS are stripped, caller object dirs survive, stdin is ignored", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const inherited = { GIT_DIR: "/hostile/git", GIT_WORK_TREE: "/hostile/tree", GIT_EXTERNAL_DIFF: "hostile", GIT_CONFIG_PARAMETERS: "hostile", GIT_SSH: "hostile", GIT_SSH_COMMAND: "hostile", GIT_PROXY_COMMAND: "hostile", GIT_ASKPASS: "hostile", SSH_ASKPASS: "hostile", GIT_FUTURE_SETTING: "hostile" };
    const old = Object.fromEntries(Object.keys(inherited).map((key) => [key, process.env[key]]));
    const objects = scratch("env-objects");
    const caller = { GIT_OBJECT_DIRECTORY: objects, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(repo, ".git", "objects") };
    Object.assign(process.env, inherited);
    const spy = gitEnv(env);
    try {
      const plain = await hgit(repo, ["rev-parse", "HEAD"], { lead: [], timeoutMs: 10_000 });
      const r = await hgit(repo, ["rev-parse", "HEAD"], { lead: [], timeoutMs: 10_000, env: caller });
      expect([plain.code, plain.complete]).toEqual([0, true]);
      expect([r.code, r.complete]).toEqual([0, true]);
      expect(spy.options).toHaveLength(2);
      for (const opts of spy.options) {
        expect(opts.stdin).toBe("ignore");
        expect(opts.env).toBeDefined();
        for (const key of Object.keys(inherited)) expect(Object.hasOwn(opts.env!, key)).toBe(false);
      }
      const opts = spy.options[1]!;
      for (const [key, value] of Object.entries(caller)) expect(opts.env![key]).toBe(value);
      expect(opts.env!.PATH).toBe(process.env.PATH);
    } finally {
      spy.restore();
      for (const [key, value] of Object.entries(old)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
});

test("checkpoint: core.worktree redirects and gitfiles with redirected worktrees are elsewhere", async () => {
  const { env } = isolatedGit();
  const repo = await newRepo(), other = scratch("redirect"), gitfileRepo = scratch("gitfile");
  await g(repo, ["config", "core.worktree", other], env);
  writeFileSync(join(gitfileRepo, ".git"), `gitdir: ${join(repo, ".git")}\n`);
  const { result } = await under(env, async () => [
    await hardenArgs(repo, budget(), LAZY), await hardenArgs(gitfileRepo, budget(), LAZY),
  ]);
  expect(result).toEqual([{ unknown: "elsewhere" }, { unknown: "elsewhere" }]);
});

test("checkpoint: config exit 1 with output is an error, never no-match", async () => {
  const { env } = isolatedGit();
  const repo = await newRepo();
  const { result, calls } = await under(env, () => hardenArgs(repo, budget(), LAZY),
    (a) => a.includes("config") ? ["sh", "-c", "printf 'local\\tfilter.x.clean\\n'; exit 1"] : undefined);
  expect(calls.some((a) => a.includes("config"))).toBe(true);
  expect(result).toEqual({ unknown: "error" });
});

for (const command of ["rev-list", "log", "for-each-ref"]) {
  test(`checkpoint: opts listing ${command} past 16 MiB throws incomplete, never partial`, async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const bin = scratch("listing-bin"), marker = join(bin, "ran");
    markerScript(bin, "git", marker, "exec dd if=/dev/zero bs=65536 count=272 2>/dev/null"); // 17 MiB
    const merge = { sha: "a".repeat(40), parents: ["b".repeat(40), "c".repeat(40)], timestamp: "2026-01-11T10:00:00Z", subject: "merge" };
    const { result } = await under({ ...env, PATH: `${bin}:${process.env.PATH}` }, async () => {
      const opts = { lead: lead(await hardenArgs(repo, budget(), LAZY)) };
      return (command === "rev-list"
        ? mergeMembers(repo, [merge], budget(), opts)
        : listDefaultRefMerges(repo, new Date("2026-01-11"), new Date("2026-01-12"), budget(), opts))
        .then(() => null, (e: unknown) => e);
    }, (argv) => argv.includes(command) ? [join(bin, "git")] : [Bun.which("git")!, ...argv.slice(1)]);
    expect(existsSync(marker)).toBe(true);
    expect(result).toBeInstanceOf(IncompleteReadError);
    expect((result as Error).message).toContain("stdout exceeded 16777216 bytes");
  });
}


describe("B1-M2 checkpoint regressions", () => {
  test("a spooled pipe over its cap is killed and writes no spool; exact cap preserves raw bytes", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    const spool = join(scratch("spool-cap"), "change.diff");
    const over = (a: string[]) => a.includes("diff")
      ? [process.execPath, "-e", 'const fs = require("node:fs"); fs.writeSync(1, Buffer.alloc(65537)); await Bun.sleep(300);'] : undefined;
    const started = performance.now();
    const capped = await under(env, () => hgit(repo, ["diff"], { lead: [], timeoutMs: 30_000, stdoutPath: spool, maxBytes: 65536 }), over);
    expect([capped.result.complete, capped.result.timedOut, capped.result.out]).toEqual([false, false, ""]);
    expect(existsSync(spool)).toBe(false);
    expect(performance.now() - started).toBeLessThan(2000);
    const exact = (a: string[]) => a.includes("diff")
      ? [process.execPath, "-e", 'require("node:fs").writeSync(1, Buffer.from([255, 0, 254, 128]));'] : undefined;
    const ok = await under(env, () => hgit(repo, ["diff"], { lead: [], timeoutMs: 10_000, stdoutPath: spool, maxBytes: 4 }), exact);
    expect([ok.result.complete, ok.result.code]).toEqual([true, 0]);
    expect(readFileSync(spool)).toEqual(Buffer.from([255, 0, 254, 128]));
  });

  test("opts.lead shared calls remove every inherited GIT_* variable and SSH_ASKPASS at the spawn boundary", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    await g(repo, ["checkout", "-q", "-b", "feat"], env);
    const member = await commitAt(repo, env, { "b.txt": "b" }, "b", "2026-01-12T10:00:00Z");
    await g(repo, ["checkout", "-q", "main"], env);
    await g(repo, ["merge", "-q", "--no-ff", "-m", "Merge pull request #1 from me/feat", "feat"], env,
      { GIT_COMMITTER_DATE: "2026-01-13T10:00:00Z" });
    const poison = { GIT_DIR: "/absent/b1.git", GIT_WORK_TREE: "/absent/b1", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.bare", GIT_CONFIG_VALUE_0: "true", GIT_SSH_COMMAND: "false", GIT_B1_UNKNOWN_VARIABLE: "strip me", SSH_ASKPASS: "false", DBA_B1_KEEP: "kept" };
    const saved = new Map(Object.keys(poison).map((key) => [key, process.env[key]]));
    Object.assign(process.env, poison);
    const spy = gitEnv(env);
    try {
      const opts = { lead: ["--no-optional-locks"] };
      expect((await defaultRefs(repo, budget(), opts)).refs).toContain("refs/heads/main");
      const merges = await listDefaultRefMerges(repo, new Date("2026-01-01T00:00:00Z"), new Date("2026-01-20T00:00:00Z"), budget(), opts);
      expect(merges.merges).toHaveLength(1);
      const members = await mergeMembers(repo, merges.merges, budget(), opts);
      expect([...members.members.values()]).toEqual([[member]]);
      const scoped = spy.options.filter((_, i) => spy.calls[i]!.includes("--no-optional-locks"));
      expect(scoped.length).toBeGreaterThanOrEqual(6);
      for (const o of scoped) {
        expect(o.env).toBeDefined();
        expect(Object.keys(o.env!).filter((k) => k.startsWith("GIT_") || k === "SSH_ASKPASS")).toEqual([]);
        expect(o.env!.DBA_B1_KEEP).toBe("kept");
        expect(o.env!.PATH).toBe(process.env.PATH);
      }
    } finally {
      spy.restore();
      for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    }
  });
});

test("final3 L1 live symbolic-ref stdout is capped while the morning stays unchanged", async () => {
  const { env } = isolatedGit();
  const repo = await newRepo();
  const oversized = (args: string[]) => args.includes("symbolic-ref")
    ? ["sh", "-c", "printf origin/; head -c 70000 /dev/zero | tr '\\000' a"] : undefined;
  await expect(under(env, () => defaultRefs(repo, budget(), { lead: [] }), oversized)).rejects.toBeInstanceOf(IncompleteReadError);
  const morning = await under(env, () => defaultRefs(repo, budget()), oversized);
  expect(morning.result.name?.length).toBe(70000);
});

test("final3 L2 hgit fixes the diagnostic locale", async () => {
  const { env } = isolatedGit();
  const repo = await newRepo();
  const old = { LC_ALL: process.env.LC_ALL, LANGUAGE: process.env.LANGUAGE };
  Object.assign(process.env, { LC_ALL: "fr_FR.UTF-8", LANGUAGE: "fr" });
  const spy = gitEnv(env);
  try {
    expect((await hgit(repo, ["rev-parse", "HEAD"], { lead: [], timeoutMs: 10000 })).code).toBe(0);
    expect(spy.options).toHaveLength(1);
    expect(spy.options[0]!.env?.LC_ALL).toBe("C");
    expect(spy.options[0]!.env?.LANGUAGE).toBe("C");
  } finally {
    spy.restore();
    for (const [k, v] of Object.entries(old)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});
