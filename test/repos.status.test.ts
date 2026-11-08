import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// test/repos.status.test.ts — B1-M3-T9 and B1-M3-T10 (wave-2 plan): `repos status --json`, the desktop app's
// live git check. The STDIN contract and its bound, the two reply types (decoded from real output), the
// budget and the pool, every per-repo `unknown` reason, the minute "Not committed" count, and the reply-level
// scans: no subject but the hidden commits' and the PR titles', and a hostile repo whose names, remotes,
// upstreams and subjects carry a credential-shaped marker that must never reach the reply.
//
// Scratch repos only, built per test under a per-test global config; the git environment reaches git through
// the pass-through spawn spy (fixtures/repos-fixtures.ts says why). The run record is injected (`readRecord`)
// or, for the real-process test, written into a per-test state dir.
import { test, expect, describe } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, writeFileSync, utimesSync, existsSync, renameSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { createHash } from "node:crypto";
import { resetWindowArgsCacheForTests } from "../src/git";
import { repoLabelFor } from "../src/subprojects";
import { writeRunRecord, type RunRecord } from "../src/runRecord";
import { parseReposRequest, reposStatus, repoKeyFor, REPOS_STATUS_BUDGET_MS, REPOS_STDIN_MAX_BYTES, REPO_STATUS_BOUND_MS, type StatusDeps } from "../src/repos/status";
import { reposMain } from "../src/repos/cli";
import type { ReposEngineReply, ReposRequest, ReposUncommittedReply } from "../src/repos/types";
import { g, gRaw, gitEnv, isolatedGit, newRepo, withGit, commitAt, scratch, gitAtLeast, markerScript } from "./fixtures/repos-fixtures";

const PAGE_DATE = "2026-01-12";
const WINDOW = "2026-01-01T00:00:00.000Z";
const at = (d: number, h = 10) => `2026-01-${String(d).padStart(2, "0")}T${String(h).padStart(2, "0")}:00:00Z`;
const MARK = "SECRETMARK";
const TOKEN = `ghp_${MARK}abcdefghijklmnopqrstuv`;            // github-token shape: gh[pousr]_ + 20+ alnum
const URLCRED = `https://user:${MARK}@host.example/x.git`;

const req = (o: Partial<ReposRequest> = {}): ReposRequest => ({ scope: "all", pageDate: PAGE_DATE, labels: [], branches: [], ...o });
function record(o: Partial<RunRecord>): RunRecord {
  return { schemaVersion: 1, date: PAGE_DATE, repos: [], windowStartUtc: WINDOW, labels: {}, commits: [], missing: [], ...o };
}
const accepted = (r: RunRecord): StatusDeps["readRecord"] => async () => ({ accepted: true, record: r });
const t7 = (sha: string) => sha.slice(0, 7);

/** `reposStatus` with the test's git environment on every git spawn; no record and no configured repos
 *  unless the test gives them. */
async function status(env: Record<string, string>, request: ReposRequest, deps: StatusDeps = {}, substitute?: (argv: string[]) => string[] | undefined) {
  return withGit(env, () => reposStatus(request, {
    tmpRoot: scratch("squash"), readRecord: async () => ({ accepted: false }), loadConfig: async () => ({}), ...deps,
  }), substitute);
}
const all = (r: unknown) => r as ReposEngineReply;
/** Repos no card names are in path order (byte order); temp paths are random, so tests look views up by
 *  path rather than assume an order. */
const byPath = (...ps: string[]) => [...ps].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
function viewFor<V extends { key: string }>(views: readonly V[], path: string): V {
  const v = views.find((x) => x.key === repoKeyFor(path));
  if (v === undefined) throw new Error(`no view for ${path}`);
  return v;
}
const reasonsOf = (r: ReposEngineReply, ...paths: string[]) => paths.map((p) => {
  const v = viewFor(r.repoViews, p);
  return [v.state, "reason" in v ? v.reason : null];
});

for (const path of ["squash", "merge"] as const) test(`unsafe PR numbers on the live ${path} path leave both repos' replies decodable`, async () => {
  const { env } = isolatedGit();
  const repo = await newRepo();
  const healthy = await newRepo();
  const good = await commitAt(healthy, env, { "good.txt": "good" }, "Good work (#17)", at(12));
  const invalid = ["0", "9007199254740992", "9".repeat(309)];
  const shas: string[] = [];
  for (const [i, number] of invalid.entries()) {
    const files = { [`bad-${i}.txt`]: "work" };
    if (path === "merge") {
      await g(repo, ["checkout", "-q", "-b", `topic-${i}`], env);
      shas.push(await commitAt(repo, env, files, "topic", at(12)));
      await g(repo, ["checkout", "-q", "main"], env);
      await g(repo, ["merge", "-q", "--no-ff", "-m", `Merge pull request #${number} from owner/topic-${i}`, `topic-${i}`], env,
        { GIT_AUTHOR_DATE: at(12), GIT_COMMITTER_DATE: at(12) });
    } else shas.push(await commitAt(repo, env, files, `Work (#${number})`, at(12)));
  }
  const result = all((await status(env, req({ labels: [
    { key: "bad", tokens: shas.map(t7) }, { key: "healthy", tokens: [t7(good)] },
  ] }), { readRecord: accepted(record({ repos: [repo, healthy], labels: { bad: { repo, root: null }, healthy: { repo: healthy, root: null } } })), now: () => new Date(at(13)) })).result);
  const wire = JSON.parse(JSON.stringify(result));
  expect(engineReplyProblems(wire)).toEqual([]);
  expect(result.repoViews.every((v) => v.state === "ok")).toBe(true);
  expect(result.labels.find((l) => l.key === "healthy")!.prNumbers).toEqual([17]);
  const bad = result.labels.find((l) => l.key === "bad")!;
  expect(bad.prNumbers).toEqual([]);
  expect(bad.rows.some((r) => r.kind === "pr")).toBe(false);
  expect(new Set(bad.rows.flatMap((r) => r.commits.map((c) => c.sha)))).toEqual(new Set(shas));
});

for (const disambiguated of [false, true]) test(`reply repo names redact credential-shaped ${disambiguated ? "parents" : "basenames"}, including unknown replies`, async () => {
  const { env } = isolatedGit();
  const a = await alpha(env);
  const parent = join(scratch("repo-name"), disambiguated ? TOKEN : "safe");
  mkdirSync(parent);
  const repo = join(parent, disambiguated ? "same" : TOKEN);
  renameSync(a.repo, repo);
  const paths = [repo];
  if (disambiguated) {
    const otherParent = join(scratch("repo-name-other"), "plain");
    mkdirSync(otherParent);
    const other = join(otherParent, "same");
    renameSync(await newRepo(), other);
    paths.push(other);
  }
  // A record supplies the window even with no page cards: push cards use repoName.
  const deps: StatusDeps = { readRecord: accepted(record({ repos: paths })), now: () => new Date(at(13)) };
  const expected = disambiguated ? "[redacted]/same" : "[redacted]";
  const ok = all((await status(env, req(), deps)).result);
  expect(viewFor(ok.repoViews, repo).state).toBe("ok");
  expect(viewFor(ok.repoViews, repo).name).toBe(expected);
  expect(ok.pushCards.find((c) => c.repoKey === repoKeyFor(repo))?.repoName).toBe(expected);
  const unknown = all((await status(env, req(), { ...deps, budgets: { overallMs: 0 } })).result);
  expect(viewFor(unknown.repoViews, repo).state).toBe("unknown");
  expect(viewFor(unknown.repoViews, repo).name).toBe(expected);
  // Engine-only stat targets and B2's private actionFacts intentionally carry paths (Rust strips both before
  // IPC, B2 spec :23); the IPC fields must not.
  for (const { repos: _stat, actionFacts: _facts, ...shown } of [ok, unknown]) expect(JSON.stringify(shown)).not.toContain(MARK);
});

/** A repo on main (pushed to a bare `origin`), then `a1` on main (pushed), then `feat` with `f1`, `f2` never
 *  pushed. */
async function alpha(env: Record<string, string>) {
  const repo = await newRepo();
  const bare = join(scratch("remote"), "o.git");
  await g(scratch("cwd"), ["init", "-q", "--bare", bare], env);
  await g(repo, ["remote", "add", "origin", bare], env);
  const a1 = await commitAt(repo, env, { "a1.txt": "1\n" }, "subject-a1-zebra", at(12, 9));
  await g(repo, ["push", "-q", "-u", "origin", "main"], env);
  await g(repo, ["checkout", "-q", "-b", "feat"], env);
  const f1 = await commitAt(repo, env, { "f1.txt": "1\n" }, "subject-f1-yak", at(12, 11));
  const f2 = await commitAt(repo, env, { "f2.txt": "1\n" }, "subject-f2-hidden-walrus", at(12, 12));
  await g(repo, ["checkout", "-q", "main"], env);
  return { repo, a1, f1, f2 };
}

// ── the reply's shape, checked field by field against the declared types ─────────────────────────────────

const isStr = (v: unknown): v is string => typeof v === "string";
const isNat = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
function keys(o: Record<string, unknown>, want: string[], opt: string[] = []): boolean {
  const k = Object.keys(o);
  return want.every((w) => k.includes(w)) && k.every((x) => want.includes(x) || opt.includes(x));
}
const uncommittedOk = (u: unknown) => isObj(u) && ((keys(u, ["count"]) && isNat(u.count)) || (keys(u, ["unknown"]) && u.unknown === true));
const commitOk = (c: unknown) => isObj(c) && isStr(c.sha) && /^[0-9a-f]{40}$/.test(c.sha)
  && ((keys(c, ["sha", "token"]) && isStr(c.token)) || (keys(c, ["sha", "token", "subject"]) && c.token === null && isStr(c.subject)));
const pushOk = (p: unknown) => p === null || (isObj(p) && keys(p, ["state", "notPushed"]) && ["pushed", "partly", "never"].includes(p.state as string) && isNat(p.notPushed));
function rowOk(r: unknown): boolean {
  if (!isObj(r) || !Array.isArray(r.commits) || !r.commits.every(commitOk)) return false;
  switch (r.kind) {
    case "pr": return keys(r, ["kind", "number", "title", "commits"]) && isNat(r.number) && isStr(r.title);
    case "branch": case "default": return keys(r, ["kind", "name", "push", "commits"]) && isStr(r.name) && pushOk(r.push);
    case "remoteBranch": case "tag": return keys(r, ["kind", "name", "commits"]) && isStr(r.name);
    case "detached": case "orphan": return keys(r, ["kind", "commits"]);
    default: return false;
  }
}
const REASONS = ["git-too-old", "dubious-ownership", "required-filter", "partial-clone", "elsewhere", "timeout", "budget", "error"];
function viewOk(v: unknown): boolean {
  if (!isObj(v) || !isStr(v.key) || !isStr(v.name) || typeof v.noRemote !== "boolean" || !uncommittedOk(v.uncommitted)) return false;
  const hashKey = (k: unknown, prefix: string) => isStr(k) && new RegExp(`^${prefix}[0-9a-f]{12}$`).test(k);
  const nullableHash = (k: unknown, prefix: string) => k === null || hashKey(k, prefix);
  if (v.state === "ok") return keys(v, ["key", "name", "state", "noRemote", "uncommitted", "storeKey", "treeKey"]) && hashKey(v.storeKey, "s") && hashKey(v.treeKey, "t");
  if (v.state === "unknown") return keys(v, ["key", "name", "state", "reason", "noRemote", "uncommitted", "storeKey", "treeKey"]) && REASONS.includes(v.reason as string)
    && nullableHash(v.storeKey, "s") && nullableHash(v.treeKey, "t");
  return v.state === "noRepos" && keys(v, ["key", "name", "state", "noRemote", "uncommitted"]);
}
const labelOk = (l: unknown) => isObj(l) && keys(l, ["key", "repoKey", "state", "rows", "notMatched", "prNumbers", "onlyHere"])
  && isStr(l.key) && (l.repoKey === null || isStr(l.repoKey)) && ["ok", "unknown"].includes(l.state as string)
  && Array.isArray(l.rows) && l.rows.every(rowOk) && isNat(l.notMatched) && Array.isArray(l.prNumbers) && l.prNumbers.every(isNat) && isNat(l.onlyHere);
function lineOk(b: unknown): boolean {
  if (!isObj(b) || !isStr(b.key) || !isStr(b.name)) return false;
  if (b.state === "live") return keys(b, ["key", "name", "state", "notPushed", "neverPushed", "behind"]) && isNat(b.notPushed) && typeof b.neverPushed === "boolean" && isNat(b.behind);
  return (b.state === "missing" || b.state === "noRemote") && keys(b, ["key", "name", "state"]);
}
const named = (x: unknown) => isObj(x) && keys(x, ["name", "commits"]) && isStr(x.name) && isNat(x.commits);
const cardOk = (c: unknown) => isObj(c) && keys(c, ["repoKey", "storeKey", "firstLabel", "repoName", "branches", "onDefault"]) && isStr(c.repoKey)
  && isStr(c.storeKey) && /^s[0-9a-f]{12}$/.test(c.storeKey)
  && (c.firstLabel === null || isStr(c.firstLabel)) && isStr(c.repoName) && Array.isArray(c.branches) && c.branches.every(named) && (c.onDefault === null || named(c.onDefault));
const iso = (v: unknown) => isStr(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString() === v;
/** Every problem with `x` as a `ReposEngineReply` (empty: it decodes). */
function engineReplyProblems(x: unknown): string[] {
  const p: string[] = [];
  if (!isObj(x)) return ["not an object"];
  if (!keys(x, ["schemaVersion", "scope", "checkedAt", "record", "windowStartUtc", "repoViews", "labels", "branchLines", "pushCards", "tile", "hidden", "repos", "actionFacts"])) p.push(`keys ${Object.keys(x)}`);
  if (x.schemaVersion !== 1 || x.scope !== "all" || !iso(x.checkedAt)) p.push("head");
  if (!isObj(x.record) || !keys(x.record, ["accepted", "windowStartUtc"]) || typeof x.record.accepted !== "boolean" || !(x.record.windowStartUtc === null || iso(x.record.windowStartUtc))) p.push("record");
  if (!(x.windowStartUtc === null || iso(x.windowStartUtc))) p.push("windowStartUtc");
  if (!Array.isArray(x.repoViews) || !x.repoViews.every(viewOk)) p.push("repoViews");
  if (!Array.isArray(x.labels) || !x.labels.every(labelOk)) p.push("labels");
  if (!Array.isArray(x.branchLines) || !x.branchLines.every(lineOk)) p.push("branchLines");
  if (!Array.isArray(x.pushCards) || !x.pushCards.every(cardOk)) p.push("pushCards");
  if (!isObj(x.tile) || !keys(x.tile, ["commits", "branches"]) || !isNat(x.tile.commits) || !isNat(x.tile.branches)) p.push("tile");
  if (!isObj(x.hidden) || !keys(x.hidden, ["complete", "perLabel"]) || typeof x.hidden.complete !== "boolean" || !isObj(x.hidden.perLabel) || !Object.values(x.hidden.perLabel).every(isNat)) p.push("hidden");
  if (!Array.isArray(x.repos) || !x.repos.every((r) => isObj(r) && keys(r, ["key", "path", "gitDir", "commonDir", "reftable"]) && isStr(r.key) && isStr(r.path)
    && isStr(r.gitDir) && isAbsolute(r.gitDir) && isStr(r.commonDir) && isAbsolute(r.commonDir) && typeof r.reftable === "boolean")) p.push("repos");
  if (!Array.isArray(x.actionFacts)) p.push("actionFacts");
  p.push(...undeclaredInRust(x));
  return p;
}
function uncommittedReplyProblems(x: unknown): string[] {
  if (!isObj(x)) return ["not an object"];
  const p: string[] = [];
  if (!keys(x, ["schemaVersion", "scope", "checkedAt", "repoViews"]) || x.schemaVersion !== 1 || x.scope !== "uncommitted" || !iso(x.checkedAt)) p.push("head");
  if (!Array.isArray(x.repoViews) || !x.repoViews.every((v) => isObj(v) && keys(v, ["key", "uncommitted"]) && isStr(v.key) && uncommittedOk(v.uncommitted))) p.push("repoViews");
  p.push(...undeclaredInRust(x));
  return p;
}

// B1-M4-T13: Rust DROPS every reply member its `REPLY_KEYS` (gui/src-tauri/src/repos.rs) does not name, at every
// depth, so nothing undeclared can reach the webview through it. A member the engine adds without listing it there
// would be lost silently, so the list is read from the Rust source (never copied) and every real reply decoded in
// this file is checked against it; the test below checks the list names only members `types.ts` declares.
const RUST_REPLY_KEYS: ReadonlySet<string> = (() => {
  const src = readFileSync(new URL("../gui/src-tauri/src/repos.rs", import.meta.url), "utf8");
  const m = /pub const REPLY_KEYS: &\[&str\] = &\[([^\]]*)\];/.exec(src);
  if (!m) throw new Error("gui/src-tauri/src/repos.rs has no `pub const REPLY_KEYS: &[&str] = &[…];` list");
  return new Set([...m[1]!.matchAll(/"([A-Za-z]+)"/g)].map((x) => x[1]!));
})();
/** Every member of `x` (the top-level engine-only `repos` and `actionFacts` aside, and `perLabel`'s data-keyed entries) that Rust's
 *  `REPLY_KEYS` does not name. */
function undeclaredInRust(x: unknown, at = ""): string[] {
  if (Array.isArray(x)) return x.flatMap((v, i) => undeclaredInRust(v, `${at}[${i}]`));
  if (!isObj(x)) return [];
  return Object.entries(x).flatMap(([k, v]) => {
    if (at === "" && (k === "repos" || k === "actionFacts")) return [];
    if (!RUST_REPLY_KEYS.has(k)) return [`${at}.${k} is not in Rust's REPLY_KEYS`];
    return k === "perLabel" ? [] : undeclaredInRust(v, `${at}.${k}`);
  });
}

describe("Rust's REPLY_KEYS (the members that cross into the webview)", () => {
  test("it names only members the reply types declare, and none of the engine-only stat list or the request", () => {
    const types = readFileSync(new URL("../src/repos/types.ts", import.meta.url), "utf8");
    expect(RUST_REPLY_KEYS.size).toBeGreaterThan(30);
    for (const k of RUST_REPLY_KEYS) expect(`${k}: ${new RegExp(`\\b${k}\\??:`).test(types)}`).toBe(`${k}: true`);
    for (const k of ["repos", "path", "gitDir", "commonDir", "reftable", "pageDate", "tokens", "ref", "message",
      "actionFacts", "remotes", "transport", "github", "owner", "repo", "vcs", "configSection", "url", "legacy",
      "defaultBranch", "upstreamRemote", "upstreamBranch", "pushRemote", "remoteFactsUnknown", "checkoutPath", "refFormatOk", "pushDefault", "pushesToUpstream",
      "legacyNames", "omittedRemotes", "reachableRemotes", "prEvidence", "remote", "method", "roots", "root", "labelKeys", "displayLabel", "cardKeys", "remoteBranches", "tip", "statInputs", "stamp", "mtimeNs", "size"]) {
      expect(`${k}: ${RUST_REPLY_KEYS.has(k)}`).toBe(`${k}: false`);
    }
  });
  test("negative control: a member Rust does not list is reported, at any depth; perLabel's own keys are data", () => {
    expect(undeclaredInRust({ scope: "all", labels: [{ rows: [{ ref: "refs/heads/x" }] }], hidden: { perLabel: { anything: 1 } }, repos: [{ path: "/p" }] }))
      .toEqual([".labels[0].rows[0].ref is not in Rust's REPLY_KEYS"]);
  });
});

describe("B2's private action facts", () => {
  test("only the all reply reserves actionFacts, and the engine never prints public actions", async () => {
    const { env } = isolatedGit();
    const full = (await status(env, req())).result;
    expect(full).toHaveProperty("actionFacts", []);
    expect(full).not.toHaveProperty("actions");
    expect(engineReplyProblems(full)).toEqual([]);
    const minute = (await status(env, req({ scope: "uncommitted" }))).result;
    expect(minute).not.toHaveProperty("actionFacts");
    expect(minute).not.toHaveProperty("actions");
    expect(uncommittedReplyProblems(minute)).toEqual([]);
  });
  test("the private facts are exempt from the REPLY_KEYS check at the top level only; the hostile test below scans them", async () => {
    const { env } = isolatedGit();
    const full = (await status(env, req())).result;
    expect(undeclaredInRust({ ...full, actionFacts: [{ path: TOKEN }] })).toEqual([]);
  });
});

// ── T9: the STDIN contract ───────────────────────────────────────────────────────────────────────────

describe("the STDIN contract", () => {
  const good = { scope: "all", pageDate: "2026-10-24", labels: [{ key: "", tokens: ["abc1234", "ABCDEF0", "a".repeat(40), "beef"] }], branches: [{ key: "x", name: "feat/x" }] };
  test("a well-formed request parses, as sent", () => {
    expect(parseReposRequest(JSON.stringify(good))).toEqual(good as ReposRequest);
    expect(parseReposRequest(JSON.stringify({ ...good, scope: "uncommitted", labels: [], branches: [] }))?.scope).toBe("uncommitted");
  });
  test("refused: a non-hex token, a 41-character token, an empty token, a malformed or impossible pageDate, an unknown scope, a missing or extra field, a non-object", () => {
    const bad: unknown[] = [
      { ...good, labels: [{ key: "", tokens: ["xyz1234"] }] },
      { ...good, labels: [{ key: "", tokens: ["a".repeat(41)] }] },
      { ...good, labels: [{ key: "", tokens: [""] }] },
      { ...good, labels: [{ key: "", tokens: [7] }] },
      { ...good, pageDate: "2026-1-24" }, { ...good, pageDate: "2026-02-30" }, { ...good, pageDate: "today" },
      { ...good, scope: "some" },
      { scope: "all", pageDate: "2026-10-24", labels: [] },
      { ...good, extra: 1 },
      { ...good, labels: [{ key: "", tokens: [], more: 1 }] },
      { ...good, branches: [{ key: "x" }] },
      { ...good, labels: [{ key: 3, tokens: [] }] },
      [], null, "x",
    ];
    for (const b of bad) expect(`${JSON.stringify(b)} → ${parseReposRequest(JSON.stringify(b))}`).toBe(`${JSON.stringify(b)} → null`);
    expect(parseReposRequest("{not json")).toBeNull();
  });
  // B1-M4-T11: the bytes Rust writes (`engine::ReposRequest`, serde), pinned on both sides by one fixture.
  // `tests/engine_client.rs` (`the_repos_request_is_the_engines_stdin_contract`) asserts Rust serialises each
  // sample to exactly these strings; this asserts the engine reads each back whole, and that both sides hold
  // the same stdin bound.
  test("Rust's request bytes (gui/src-tauri/tests/fixtures/repos-request-wire.json) are the engine's contract", () => {
    const fx = JSON.parse(readFileSync(new URL("../gui/src-tauri/tests/fixtures/repos-request-wire.json", import.meta.url), "utf8")) as
      { stdinMaxBytes: number; wires: string[] };
    expect(fx.stdinMaxBytes).toBe(REPOS_STDIN_MAX_BYTES);
    expect(fx.wires.length).toBe(2);
    for (const wire of fx.wires) {
      const parsed = parseReposRequest(wire);
      expect(parsed).not.toBeNull();
      expect(parsed).toEqual(JSON.parse(wire) as ReposRequest);
      expect(Object.keys(parsed!)).toEqual(["scope", "pageDate", "labels", "branches"]);
      for (const l of parsed!.labels) expect(Object.keys(l)).toEqual(["key", "tokens"]);
      for (const b of parsed!.branches) expect(Object.keys(b)).toEqual(["key", "name"]);
    }
    // The samples cover both scopes, the Other card's "" key, upper-case hex and a quoted branch name.
    const [all, uncommitted] = fx.wires.map((w) => parseReposRequest(w)!);
    expect([all!.scope, uncommitted!.scope]).toEqual(["all", "uncommitted"]);
    expect(all!.labels.map((l) => l.key)).toContain("");
    expect(all!.labels.flatMap((l) => l.tokens)).toContain("DEADBEEF");
    expect(all!.branches[0]!.name).toBe('feat/dba-"x"');
  });

  async function cli(args: string[], stdin: string | Uint8Array, isTTY = false) {
    const out: string[] = [], err: string[] = [];
    let ran = 0;
    const code = await reposMain(args, {
      isTTY, readStdin: async (max) => { const s = typeof stdin === "string" ? stdin : new TextDecoder().decode(stdin); return s.length > max + 1 ? s.slice(0, max + 1) : s; },
      write: (s) => out.push(s), error: (s) => err.push(s), status: (async () => { ran++; return { fake: true } as never; }) as never,
    });
    return { code, out, err, ran };
  }
  test("the CLI: over the 256 KiB bound, malformed, a non-hex token, a terminal, or other arguments → exit 2, a fixed message, no stdout, nothing run", async () => {
    expect(REPOS_STDIN_MAX_BYTES).toBe(256 * 1024);
    const big = JSON.stringify({ ...good, labels: [{ key: "k".repeat(REPOS_STDIN_MAX_BYTES), tokens: [] }] });
    const cases: [string[], string, boolean][] = [
      [["status", "--json"], big, false],
      [["status", "--json"], "{", false],
      [["status", "--json"], JSON.stringify({ ...good, labels: [{ key: "", tokens: [`${MARK}zz`] }] }), false],
      [["status", "--json"], JSON.stringify(good), true],
      [["status"], JSON.stringify(good), false],
      [["status", "--json", "--extra"], JSON.stringify(good), false],
      [["list", "--json"], JSON.stringify(good), false],
      [[], JSON.stringify(good), false],
    ];
    for (const [args, stdin, tty] of cases) {
      const r = await cli(args, stdin, tty);
      expect(`${args.join(" ")} → ${r.code} ${r.out.length} ${r.ran}`).toBe(`${args.join(" ")} → 2 0 0`);
      expect(r.err).toHaveLength(1);
      expect(r.err.join("")).not.toContain(MARK);                        // nothing from the request is echoed
    }
  });
  test("the CLI: a good request runs the check once and prints its reply as one JSON line, exit 0", async () => {
    const r = await cli(["status", "--json"], JSON.stringify(good));
    expect([r.code, r.ran, r.err]).toEqual([0, 1, []]);
    expect(r.out).toEqual(['{"fake":true}']);                         // one line (console.log adds the newline)
  });
});

// ── T9: the reply ────────────────────────────────────────────────────────────────────────────────────

describe("the reply, with a run record", () => {
  test("labels, rows, not matched, the hidden commits, push words, the push card, the tile, the branch lines, repo views and stat targets", async () => {
    const { env } = isolatedGit();
    const A = await alpha(env);
    const B = await newRepo();
    const b1 = await commitAt(B, env, { "b1.txt": "1\n" }, "subject-b1-quokka", at(12));
    writeFileSync(join(B, "dirty.txt"), "x\n");
    const rec = record({
      repos: [A.repo, B],
      labels: { Alpha: { repo: A.repo, root: null }, beta: { repo: B, root: null } },
      commits: [{ sha: A.a1, label: "Alpha", repo: A.repo }, { sha: A.f1, label: "Alpha", repo: A.repo }, { sha: A.f2, label: "Alpha", repo: A.repo }, { sha: b1, label: "beta", repo: B }],
      missing: [A.f2],
    });
    const request = req({
      labels: [{ key: "alpha", tokens: [t7(A.a1), t7(A.f1).toUpperCase(), "abc12", "deadbee"] }, { key: "beta", tokens: [t7(b1)] }],
      branches: [{ key: "alpha", name: "feat" }, { key: "beta", name: "main" }, { key: "alpha", name: "gone" }],
    });
    const before = Date.now();
    const { result } = await status(env, request, { readRecord: accepted(rec) });
    const r = all(result);
    expect(engineReplyProblems(r)).toEqual([]);
    const kA = repoKeyFor(A.repo), kB = repoKeyFor(B);
    expect(kA).toBe(`r${createHash("sha256").update(realpathSync(A.repo)).digest("hex").slice(0, 12)}`);
    expect(kA).not.toBe(kB);
    expect(Date.parse(r.checkedAt)).toBeGreaterThanOrEqual(before - 1000);
    expect(r.record).toEqual({ accepted: true, windowStartUtc: WINDOW });
    expect(r.windowStartUtc).toBe(WINDOW);
    const names = [A.repo, B];
    expect(r.repoViews).toEqual([
      { key: kA, name: repoLabelFor(A.repo, names), state: "ok", noRemote: false, uncommitted: { count: 0 }, storeKey: expect.stringMatching(/^s/), treeKey: expect.stringMatching(/^t/) },
      { key: kB, name: repoLabelFor(B, names), state: "ok", noRemote: true, uncommitted: { count: 1 }, storeKey: expect.stringMatching(/^s/), treeKey: expect.stringMatching(/^t/) },
    ]);
    expect(r.labels).toEqual([
      { key: "alpha", repoKey: kA, state: "ok", notMatched: 1, prNumbers: [], onlyHere: 2, rows: [
        { kind: "branch", name: "feat", push: { state: "never", notPushed: 2 }, commits: [
          { sha: A.f2, token: null, subject: "subject-f2-hidden-walrus" }, { sha: A.f1, token: t7(A.f1) }] },
        { kind: "default", name: "main", push: { state: "pushed", notPushed: 0 }, commits: [{ sha: A.a1, token: t7(A.a1) }] },
      ] },
      { key: "beta", repoKey: kB, state: "ok", notMatched: 0, prNumbers: [], onlyHere: 0, rows: [
        { kind: "default", name: "main", push: null, commits: [{ sha: b1, token: t7(b1) }] },
      ] },
    ]);
    expect(r.hidden).toEqual({ complete: true, perLabel: { alpha: 1, beta: 0 } });
    expect(r.tile).toEqual({ commits: 2, branches: 1 });
    expect(r.pushCards).toEqual([{ repoKey: kA, storeKey: (r.repoViews[0] as { storeKey: string }).storeKey, firstLabel: "alpha", repoName: repoLabelFor(A.repo, names), branches: [{ name: "feat", commits: 2 }], onDefault: null }]);
    expect(r.branchLines).toEqual([
      { key: "alpha", name: "feat", state: "live", notPushed: 2, neverPushed: true, behind: 0 },
      { key: "beta", name: "main", state: "noRemote" },
      { key: "alpha", name: "gone", state: "missing" },
    ]);
    const real = (p: string) => realpathSync(p);
    expect(r.repos.map((x) => ({ ...x, gitDir: real(x.gitDir), commonDir: real(x.commonDir) }))).toEqual([
      { key: kA, path: A.repo, gitDir: real(join(A.repo, ".git")), commonDir: real(join(A.repo, ".git")), reftable: false },
      { key: kB, path: B, gitDir: real(join(B, ".git")), commonDir: real(join(B, ".git")), reftable: false },
    ]);
    // no path anywhere but the engine-only stat list and B2's private actionFacts, both of which Rust strips
    const { repos: _stat, actionFacts: _facts, ...ipc } = r;
    const text = JSON.stringify(ipc);
    for (const p of names) { expect(text).not.toContain(p); expect(text).not.toContain(realpathSync(p)); }
    // the engine groups only what it is sent plus the hidden commits: no subject but the hidden one appears
    for (const s of ["subject-a1-zebra", "subject-f1-yak", "subject-b1-quokka", "add f.txt"]) expect(JSON.stringify(r)).not.toContain(s);
    expect(JSON.stringify(r)).toContain("subject-f2-hidden-walrus");
  });

  test("repo views follow What-you-did card order, then path; a label the request lacks is a stray; an unread label's repo makes hidden incomplete", async () => {
    const { env } = isolatedGit();
    const [x, y, z] = [await newRepo(), await newRepo(), await newRepo()];
    const sx = await commitAt(x, env, { "x.txt": "1\n" }, "sx", at(12));
    const rec = record({
      repos: [x, y, z],
      labels: { second: { repo: x, root: null }, first: { repo: z, root: null } },
      commits: [{ sha: sx, label: "orphanlabel", repo: x }], missing: [sx],
    });
    const { result } = await status(env, req({ labels: [{ key: "first", tokens: [] }, { key: "second", tokens: [] }] }), { readRecord: accepted(rec) });
    const r = all(result);
    expect(r.repoViews.map((v) => v.key)).toEqual([repoKeyFor(z), repoKeyFor(x), repoKeyFor(y)]);   // first card's, second card's, then no card
    expect(r.hidden).toEqual({ complete: false, perLabel: { first: 0, second: 0 } });  // sx lands on no card sent
  });
});

describe("the reply, without a run record", () => {
  test("the configured repos; the Other card across repos; a token in two repos is not matched; the fallback window start; no hidden commits", async () => {
    const { env } = isolatedGit();
    const one = await newRepo();
    const u1 = await commitAt(one, env, { "u.txt": "1\n" }, "u1", at(13, 15));
    const two = join(scratch("clone"), "two");
    await g(scratch("cwd"), ["clone", "-q", one, two], env);                     // the same SHAs in both
    const v1 = await commitAt(two, env, { "v.txt": "1\n" }, "v1", at(14, 9));
    const { result } = await status(env, req({ labels: [
      { key: "", tokens: [t7(u1), t7(v1)] },
      { key: "nolabel", tokens: [t7(v1), "0000000"] },
    ] }), { loadConfig: async () => ({ repos: [one, two, `${one}/`, join(scratch("x"), "excluded")], excludeRepos: ["excluded"] }) });   // `${one}/` is one repo twice
    const r = all(result);
    expect(engineReplyProblems(r)).toEqual([]);
    expect(r.record).toEqual({ accepted: false, windowStartUtc: null });
    expect(r.repoViews.map((v) => v.key)).toEqual([repoKeyFor(two), repoKeyFor(one)]);    // the Other card's repo first, then by path
    const other = r.labels[0]!, nolabel = r.labels[1]!;
    expect([other.notMatched, other.repoKey]).toEqual([1, repoKeyFor(two)]);   // u1 is in both repos: not matched
    expect(other.rows.flatMap((row) => row.commits.map((c) => c.sha))).toEqual([v1]);
    expect([nolabel.notMatched, nolabel.repoKey]).toEqual([1, repoKeyFor(two)]);
    const oldest = new Date(at(14, 9)); oldest.setHours(0, 0, 0, 0);            // the oldest RESOLVED page commit: v1
    expect(r.windowStartUtc).toBe(oldest.toISOString());
    expect(r.hidden).toEqual({ complete: false, perLabel: {} });
  });

  test("no record and no configured repos: one noRepos view, nothing else, and no git is spawned", async () => {
    const { env } = isolatedGit();
    const { result, calls } = await status(env, req({ labels: [{ key: "a", tokens: ["abc1234"] }], branches: [{ key: "a", name: "x" }] }));
    expect(engineReplyProblems(result)).toEqual([]);
    const r = all(result);
    expect(r.repoViews).toEqual([{ key: "", name: "", state: "noRepos", noRemote: false, uncommitted: { unknown: true } }]);
    expect([r.labels, r.branchLines, r.pushCards, r.repos, r.tile, r.hidden]).toEqual([[], [], [], [], { commits: 0, branches: 0 }, { complete: false, perLabel: {} }]);
    expect(calls).toEqual([]);
    // an accepted record that lists no repos: still noRepos, and the record is reported as accepted
    const empty = all((await status(env, req(), { readRecord: accepted(record({ repos: [] })) })).result);
    expect([empty.repoViews[0]!.state, empty.record]).toEqual(["noRepos", { accepted: true, windowStartUtc: WINDOW }]);
  });
});

describe("per-repo unknown reasons", () => {
  test("git too old: every repo unknown (git-too-old), in both scopes, and no git but the version probes runs", async () => {
    const { env } = isolatedGit();
    const [x, y] = [await newRepo(), await newRepo()];
    const old = (argv: string[]) => argv.includes("--no-lazy-fetch") ? ["sh", "-c", "exit 129"] : argv[1] === "--version" ? ["sh", "-c", "echo 'git version 2.30.0'"] : undefined;
    const rec = record({ repos: [x, y], labels: { lx: { repo: x, root: null } } });
    const { result, calls } = await status(env, req({ labels: [{ key: "lx", tokens: ["abc1234"] }] }), { readRecord: accepted(rec) }, old);
    const r = all(result);
    expect(r.repoViews.map((v) => [v.state, "reason" in v ? v.reason : null])).toEqual([["unknown", "git-too-old"], ["unknown", "git-too-old"]]);
    expect(r.labels).toEqual([{ key: "lx", repoKey: repoKeyFor(x), state: "unknown", rows: [], notMatched: 0, prNumbers: [], onlyHere: 0 }]);
    expect(r.repos).toEqual([]);
    expect(r.hidden.complete).toBe(false);
    expect(calls.map((c) => c.slice(1))).toEqual([["--no-lazy-fetch", "--version"], ["--version"]]);
    const u = await status(env, req({ scope: "uncommitted" }), { readRecord: accepted(rec) }, old);
    expect(u.result).toEqual({ schemaVersion: 1, scope: "uncommitted", checkedAt: expect.any(String),
      repoViews: byPath(x, y).map((p) => ({ key: repoKeyFor(p), uncommitted: { unknown: true } })) });   // no card in that request: by path
  });

  test("dubious ownership; elsewhere; a partial clone when git refuses --no-lazy-fetch: each that repo's own reason", async () => {
    const { env } = isolatedGit();
    const plain = await newRepo();
    const dubious = await newRepo();
    const sub = join(await newRepo(), "sub");
    mkdirSync(sub);
    await g(sub, ["config", "core.worktree", join(sub, "..", "..")], env);
    const partial = await newRepo();
    await g(partial, ["config", "extensions.partialClone", "origin"], env);
    const rec = record({ repos: [plain, dubious, sub, partial] });
    const sub2 = (argv: string[]) => argv.includes("--no-lazy-fetch") ? ["sh", "-c", "exit 129"] : undefined;
    const { result } = await withGit(env, () => reposStatus(req(), { readRecord: accepted(rec), loadConfig: async () => ({}), tmpRoot: scratch("sq") }),
      (argv) => sub2(argv) ?? (argv[2] === dubious ? ["env", "GIT_TEST_ASSUME_DIFFERENT_OWNER=1", ...argv] : undefined));
    const r = all(result);
    expect(reasonsOf(r, plain, dubious, sub, partial)).toEqual([["ok", null], ["unknown", "dubious-ownership"], ["unknown", "elsewhere"], ["unknown", "partial-clone"]]);
    expect(r.repos.map((x) => x.path)).toEqual([plain]);
  });

  test("one slow repo leaves the others' answers intact (each repo its own slice of the budget, in the pool)", async () => {
    const { env } = isolatedGit();
    const slow = await newRepo(), fast = await newRepo();
    const sf = await commitAt(fast, env, { "s.txt": "1\n" }, "s", at(12));
    const rec = record({ repos: [slow, fast], labels: { s: { repo: slow, root: null }, f: { repo: fast, root: null } }, commits: [{ sha: sf, label: "f", repo: fast }] });
    const started = performance.now();
    const { result } = await status(env, req({ labels: [{ key: "s", tokens: [] }, { key: "f", tokens: [t7(sf)] }] }),
      { readRecord: accepted(rec), budgets: { overallMs: 9000, sliceMs: 3000 } },
      (argv) => argv[2] === slow ? ["sh", "-c", "exec sleep 30"] : undefined);
    const elapsed = performance.now() - started;
    const r = all(result);
    expect(r.repoViews.map((v) => [v.state, "reason" in v ? v.reason : null])).toEqual([["unknown", "timeout"], ["ok", null]]);
    expect(r.labels[1]!.rows).toEqual([{ kind: "default", name: "main", push: null, commits: [{ sha: sf, token: t7(sf) }] }]);
    expect(r.labels[0]!.state).toBe("unknown");
    expect(elapsed).toBeLessThan(8000);
  }, 20_000);

  test("the overall budget: a repo not started before it runs out answers unknown (budget)", async () => {
    const { env } = isolatedGit();
    const slow = await newRepo(), late = await newRepo();
    const { result } = await status(env, req(), {
      loadConfig: async () => ({ repos: [slow, late] }), budgets: { overallMs: 3200 }, concurrency: 1,
    }, (argv) => argv[2] === slow ? ["sh", "-c", "exec sleep 30"] : undefined);
    const r = all(result);
    expect(reasonsOf(r, slow, late)).toEqual([["unknown", "timeout"], ["unknown", "budget"]]);   // the pool starts them in the configured order
  }, 20_000);

  test("the budget's figures: 25 000 ms overall (5 s under Rust's 30 s read bound), each repo's status bounded at 10 000 ms", () => {
    expect(REPOS_STATUS_BUDGET_MS).toBe(25_000);
    expect(REPO_STATUS_BOUND_MS).toBe(10_000);
  });
});

describe("stat targets", () => {
  test.skipIf(!gitAtLeast(2, 45))("a reftable repo is reported reftable: true (needs git 2.45+)", async () => {
    const { env } = isolatedGit();
    const repo = join(scratch("reftable"), "r");
    await g(scratch("cwd"), ["init", "-q", "-b", "main", "--ref-format=reftable", repo], env);
    await g(repo, ["config", "user.name", "T"], env);
    await g(repo, ["config", "user.email", "t@x"], env);
    await commitAt(repo, env, { "a.txt": "1\n" }, "a", at(12));
    const plain = await newRepo();
    const { result } = await status(env, req(), { readRecord: accepted(record({ repos: [repo, plain] })) });
    expect(Object.fromEntries(all(result).repos.map((x) => [x.path, x.reftable]))).toEqual({ [repo]: true, [plain]: false });
  });

  test("no git call inherits the engine's environment: every spawn carries an explicit env with no GIT_* variable but the squash check's two", async () => {
    const { env } = isolatedGit();
    const A = await alpha(env);
    resetWindowArgsCacheForTests();                                          // the uncached probe runs too
    const rec = record({ repos: [A.repo], labels: { a: { repo: A.repo, root: null } }, commits: [{ sha: A.f1, label: "a", repo: A.repo }] });
    const spyCalls: { argv: string[]; env: Record<string, string | undefined> | undefined }[] = [];
    const spy = gitEnv(env);
    try {
      await reposStatus(req({ labels: [{ key: "a", tokens: [t7(A.f1)] }], branches: [{ key: "a", name: "feat" }] }),
        { readRecord: accepted(rec), loadConfig: async () => ({}), tmpRoot: scratch("sq") });
      spy.calls.forEach((argv, i) => spyCalls.push({ argv, env: spy.options[i]!.env }));
    } finally { spy.restore(); }
    expect(spyCalls.length).toBeGreaterThan(10);
    expect(spyCalls.some((c) => c.argv[1] === "--version")).toBe(true);
    const leaks = spyCalls.filter((c) => c.env === undefined || Object.keys(c.env).some((k) => k.startsWith("GIT_") && k !== "GIT_OBJECT_DIRECTORY" && k !== "GIT_ALTERNATE_OBJECT_DIRECTORIES"));
    expect(leaks.map((c) => c.argv.join(" "))).toEqual([]);
  });
});

describe("the hostile repo: a credential-shaped marker in names, remotes, upstreams and subjects never reaches the reply", () => {
  test("only redacted forms appear, where the spec shows them", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    // a remote whose NAME is credential-shaped and whose URL carries user:password; refs under it by hand
    await g(repo, ["remote", "add", TOKEN, URLCRED], env);
    const base = (await g(repo, ["rev-parse", "HEAD"], env)).trim();
    // main: a PR merge whose body (the PR title) carries the token
    await g(repo, ["checkout", "-q", "-b", "topic"], env);
    const p1 = await commitAt(repo, env, { "p.txt": "1\n" }, `page commit with ${URLCRED} and ${TOKEN}`, at(12, 8));
    await g(repo, ["checkout", "-q", "main"], env);
    await g(repo, ["merge", "-q", "--no-ff", "topic", "-m", "Merge pull request #7 from someone/topic", "-m", `Title with ${TOKEN}`], env, { GIT_COMMITTER_DATE: at(12, 9), GIT_AUTHOR_DATE: at(12, 9) });
    await g(repo, ["branch", "-D", "topic"], env);
    // a credential-shaped branch holding a page commit and a hidden one; its upstream is under the hostile remote
    const hostileBranch = `feat/${TOKEN}`;
    await g(repo, ["checkout", "-q", "-b", hostileBranch], env);
    const h1 = await commitAt(repo, env, { "h1.txt": "1\n" }, `page subject ${TOKEN}`, at(12, 10));
    const h2 = await commitAt(repo, env, { "h2.txt": "1\n" }, `hidden subject ${TOKEN}`, at(12, 11));
    await g(repo, ["update-ref", `refs/remotes/${TOKEN}/up`, base], env);
    await g(repo, ["config", `branch.${hostileBranch}.remote`, TOKEN], env);
    await g(repo, ["config", `branch.${hostileBranch}.merge`, "refs/heads/up"], env);
    // a commit only a remote-tracking branch of the hostile remote holds
    await g(repo, ["checkout", "-q", "--detach", base], env);
    const r1 = await commitAt(repo, env, { "r1.txt": "1\n" }, `remote-only ${TOKEN}`, at(12, 12));
    await g(repo, ["update-ref", `refs/remotes/${TOKEN}/side`, r1], env);
    // a commit only a credential-shaped tag holds
    await g(repo, ["checkout", "-q", "--detach", base], env);
    const t1 = await commitAt(repo, env, { "t1.txt": "1\n" }, `tag-only ${TOKEN}`, at(12, 13));
    await g(repo, ["tag", `v1-${TOKEN}`, t1], env);
    await g(repo, ["checkout", "-q", "main"], env);
    // a second repo whose push listing fails with the marker on stdout and stderr: unknown, by code only
    const broken = await newRepo();
    const bk = await commitAt(broken, env, { "b.txt": "1\n" }, `broken ${TOKEN}`, at(12));
    await g(broken, ["remote", "add", "origin", URLCRED], env);
    const rec = record({
      repos: [repo, broken],
      labels: { h: { repo, root: null }, b: { repo: broken, root: null } },
      commits: [p1, h1, h2, r1, t1].map((sha) => ({ sha, label: "h", repo })).concat([{ sha: bk, label: "b", repo: broken }]),
      missing: [h2],
    });
    const request = req({
      labels: [{ key: "h", tokens: [t7(p1), t7(h1), t7(r1), t7(t1)] }, { key: "b", tokens: [t7(bk)] }],
      branches: [{ key: "h", name: hostileBranch }, { key: "h", name: "[redacted]" }],
    });
    const { result } = await status(env, request, { readRecord: accepted(rec) },
      (argv) => argv[2] === broken && argv.includes("for-each-ref") ? ["sh", "-c", `echo '${TOKEN} ${URLCRED}' >&2; echo 'refs/heads/${TOKEN}junk'; exit 3`] : undefined);
    const r = all(result);
    expect(engineReplyProblems(r)).toEqual([]);
    const text = JSON.stringify(r);
    expect(text).not.toContain(MARK);
    // the redacted forms the spec shows: the branch row, the push card, the PR title, the hidden subject, the
    // remote-tracking and tag rows
    const rows = r.labels[0]!.rows;
    expect(rows.find((x) => x.kind === "pr")).toMatchObject({ number: 7, title: "Title with [redacted]" });
    expect(rows.find((x) => x.kind === "branch")).toMatchObject({ name: "[redacted]" });
    expect(rows.find((x) => x.kind === "remoteBranch")).toMatchObject({ name: "[redacted]" });
    expect(rows.find((x) => x.kind === "tag")).toMatchObject({ name: "[redacted]" });
    expect(rows.flatMap((x) => x.commits).find((c) => c.sha === h2)).toEqual({ sha: h2, token: null, subject: "hidden subject [redacted]" });
    expect(r.pushCards[0]!.branches).toEqual([{ name: "[redacted]", commits: 2 }]);
    // a raw credential-shaped name (the webview sends the page's `[redacted]`, but whatever is sent) finds its
    // branch and is echoed redacted; the page's `[redacted]` is "missing"
    expect(r.branchLines.map((b) => [b.name, b.state])).toEqual([["[redacted]", "live"], ["[redacted]", "missing"]]);
    expect(r.repoViews[1]).toEqual({ key: repoKeyFor(broken), name: repoLabelFor(broken, [repo, broken]), state: "unknown", reason: "error", noRemote: false, uncommitted: { count: 0 },
      storeKey: expect.stringMatching(/^s[0-9a-f]{12}$/), treeKey: expect.stringMatching(/^t[0-9a-f]{12}$/) });
    // the page commits' own subjects never appear
    for (const s of ["page commit with", "page subject", "remote-only", "tag-only", "broken"]) expect(text).not.toContain(s);
  }, 30_000);
});

// ── T9: the real engine process, cwd elsewhere ─────────────────────────────────────────────────────────

describe("the real `repos status --json` process", () => {
  test("both reply types decode; gitDir and commonDir are absolute for a primary checkout, a configured subdirectory and a linked worktree, with the engine's cwd elsewhere", async () => {
    const { env } = isolatedGit();
    const repo = await newRepo();
    mkdirSync(join(repo, "sub"));
    const wt = join(scratch("wt"), "linked");
    await g(repo, ["worktree", "add", "-q", wt], env);
    const home = scratch("home"), state = scratch("state"), cfg = scratch("cfg");
    await writeRunRecord(record({ repos: [repo, join(repo, "sub"), wt] }), join(state, "run-record.json"));
    const engine = join(import.meta.dir, "..", "src", "main.ts");
    const run = async (request: ReposRequest) => {
      const p = Bun.spawn([process.execPath, engine, "repos", "status", "--json"], {
        cwd: scratch("elsewhere"), stdin: new TextEncoder().encode(JSON.stringify(request)), stdout: "pipe", stderr: "pipe",
        env: { ...process.env, HOME: home, DAILY_BRIEFING_STATE_DIR: state, XDG_CONFIG_HOME: cfg },
      });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      await p.exited;
      return { code: p.exitCode, out, err };
    };
    const a = await run(req());
    expect([a.code, a.err]).toEqual([0, ""]);
    expect(a.out.endsWith("\n") && a.out.trim().split("\n").length === 1).toBe(true);
    const reply = JSON.parse(a.out);
    expect(engineReplyProblems(reply)).toEqual([]);
    const git = realpathSync(join(repo, ".git"));
    const dirsOf = (p: string) => {
      const x = (reply as ReposEngineReply).repos.find((t) => t.path === p)!;
      return [realpathSync(x.gitDir), realpathSync(x.commonDir)];
    };
    expect((reply as ReposEngineReply).repos.map((x) => x.path)).toEqual(byPath(repo, join(repo, "sub"), wt));
    expect([dirsOf(repo), dirsOf(join(repo, "sub")), dirsOf(wt)]).toEqual([[git, git], [git, git], [realpathSync(join(repo, ".git", "worktrees", "linked")), git]]);
    const u = await run(req({ scope: "uncommitted" }));
    expect(u.code).toBe(0);
    const ur = JSON.parse(u.out) as ReposUncommittedReply;
    expect(uncommittedReplyProblems(ur)).toEqual([]);
    expect(ur.repoViews.map((v) => v.uncommitted)).toEqual([{ count: 0 }, { count: 0 }, { count: 0 }]);
    expect(existsSync(join(state, "run-record.json"))).toBe(true);                // read, never rewritten or removed
  }, 30_000);
});

// ── T10: the minute status ───────────────────────────────────────────────────────────────────────────

describe("the minute \"Not committed\" status", () => {
  test("one repo's status over its own bound answers unknown while the other answers, and the repo's other answers stay", async () => {
    const { env } = isolatedGit();
    const slow = await newRepo(), quick = await newRepo();
    writeFileSync(join(quick, "new.txt"), "x\n");
    const rec = record({ repos: [slow, quick] });
    const sub = (argv: string[]) => argv[2] === slow && argv.includes("status") ? ["sh", "-c", "exec sleep 30"] : undefined;
    const started = performance.now();
    const { result } = await status(env, req({ scope: "uncommitted" }), { readRecord: accepted(rec), budgets: { statusMs: 1500 } }, sub);
    expect(performance.now() - started).toBeLessThan(6000);
    const u = result as ReposUncommittedReply;
    expect(u.repoViews.map((v) => v.key)).toEqual(byPath(slow, quick).map(repoKeyFor));
    expect([viewFor(u.repoViews, slow).uncommitted, viewFor(u.repoViews, quick).uncommitted]).toEqual([{ unknown: true }, { count: 1 }]);
    const full = all((await status(env, req(), { readRecord: accepted(rec), budgets: { statusMs: 1500 } }, sub)).result);
    expect([slow, quick].map((p) => { const v = viewFor(full.repoViews, p); return [v.state, v.uncommitted]; })).toEqual([["ok", { unknown: true }], ["ok", { count: 1 }]]);
  }, 20_000);

  test("a dirty submodule is not counted (--ignore-submodules=all), though a plain status counts it", async () => {
    const { env } = isolatedGit();
    const inner = await newRepo();
    const repo = await newRepo();
    await g(repo, ["-c", "protocol.file.allow=always", "submodule", "add", "-q", inner, "inner"], env);
    await g(repo, ["commit", "-q", "-m", "add submodule"], env);
    writeFileSync(join(repo, "inner", "f.txt"), "changed\n");
    const control = await gRaw(repo, ["status", "--porcelain"], env);
    expect(control.out).toContain("inner");
    const { result } = await status(env, req({ scope: "uncommitted" }), { readRecord: accepted(record({ repos: [repo] })) });
    expect((result as ReposUncommittedReply).repoViews[0]!.uncommitted).toEqual({ count: 0 });
  });

  test("a repo-scoped required filter → unknown (required-filter) before any status runs; a global required filter whose clean works → the count answers", async () => {
    const { env, global } = isolatedGit();
    const scoped = await newRepo();
    const marker = join(scratch("m"), "ran");
    await g(scoped, ["config", "filter.x.clean", markerScript(scratch("s"), "clean.sh", marker)], env);
    await g(scoped, ["config", "filter.x.required", "true"], env);
    writeFileSync(join(scoped, ".gitattributes"), "* filter=x\n");
    const globalOne = await newRepo();
    const gmarker = join(scratch("gm"), "ran");
    writeFileSync(global, `[filter "g"]\n\tclean = ${markerScript(scratch("gs"), "clean.sh", gmarker)}\n\trequired = true\n`);
    writeFileSync(join(globalOne, ".git", "info", "attributes"), "f.txt filter=g\n");
    const t = new Date(Date.now() + 60_000);
    utimesSync(join(globalOne, "f.txt"), t, t);                               // stat-dirty, same content
    writeFileSync(join(globalOne, "untracked.txt"), "x\n");
    const rec = record({ repos: [scoped, globalOne] });
    const { result, calls } = await status(env, req({ scope: "uncommitted" }), { readRecord: accepted(rec) });
    const u = result as ReposUncommittedReply;
    expect([viewFor(u.repoViews, scoped).uncommitted, viewFor(u.repoViews, globalOne).uncommitted]).toEqual([{ unknown: true }, { count: 1 }]);
    expect(calls.some((c) => c[2] === scoped && c.includes("status"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(gmarker)).toBe(true);                                    // the user's own global tool ran, as git runs it
    const full = all((await status(env, req(), { readRecord: accepted(rec) })).result);
    expect(reasonsOf(full, scoped, globalOne)).toEqual([["unknown", "required-filter"], ["ok", null]]);
  });
});

// Final review 3: repository identity is the common git directory, checkout state stays separate.
for (const recorded of [false, true]) test(`final3 M1 shared checkouts count push work once (record=${recorded})`, async () => {
  const { env } = isolatedGit();
  const a = await alpha(env);
  await g(a.repo, ["checkout", "-q", "feat"], env);
  const f3 = await commitAt(a.repo, env, { "f3.txt": "3" }, "f3", at(12, 13));
  await g(a.repo, ["checkout", "-q", "main"], env);
  const wt = join(scratch("shared"), "linked");
  await g(a.repo, ["worktree", "add", "-q", "--detach", wt, "main"], env);
  const sub = join(a.repo, "sub"); mkdirSync(sub);
  const paths = [wt, sub, a.repo];
  const request = req({ labels: [{ key: "app", tokens: [t7(a.f1), t7(a.f2), t7(f3)] }] });
  const r = all((await status(env, request, {
    now: () => new Date(at(13)), loadConfig: async () => ({ repos: paths }),
    ...(recorded ? { readRecord: accepted(record({ repos: paths, labels: { app: { repo: wt, root: null } } })) } : {}),
  })).result);
  expect(r.repoViews.map((v) => v.state)).toEqual(["ok", "ok", "ok"]);
  expect(r.tile).toEqual({ commits: 3, branches: 1 });
  expect(r.pushCards).toHaveLength(1);
  // The host is the store's first readable checkout in card order: the record's repo for the card, else (final4
  // L3) the checkout its tokens settled in, the main worktree's before a linked one.
  expect(r.pushCards[0]).toMatchObject({ repoKey: repoKeyFor(recorded ? wt : sub), firstLabel: "app", branches: [{ name: "feat", commits: 3 }] });
  expect(r.labels[0]!.notMatched).toBe(0);
  expect(r.labels[0]!.rows.flatMap((row) => row.commits.map((c) => c.sha)).sort()).toEqual([a.f1, a.f2, f3].sort());
  expect(r.repos).toHaveLength(3); // Every checkout still supplies stat/status inputs.
});

test("final3 M2 stacked branch summary counts the population union", async () => {
  const { env } = isolatedGit();
  const a = await alpha(env);
  await g(a.repo, ["checkout", "-q", "-b", "stack", "feat"], env);
  const b1 = await commitAt(a.repo, env, { "b1.txt": "b" }, "b1", at(12, 13));
  const r = all((await status(env, req({ labels: [{ key: "app", tokens: [t7(a.f2), t7(b1)] }] }), {
    readRecord: accepted(record({ repos: [a.repo], labels: { app: { repo: a.repo, root: null } } })), now: () => new Date(at(13)),
  })).result);
  expect(r.labels[0]!.rows.filter((x) => x.kind === "branch").map((x) => x.name).sort()).toEqual(["feat", "stack"]);
  expect(r.labels[0]!.rows.flatMap((x) => x.kind === "branch" ? [x.push!.notPushed] : []).sort()).toEqual([2, 3]);
  expect(r.tile).toEqual({ commits: 3, branches: 2 });
  expect(r.labels[0]!.onlyHere).toBe(3);
});

test.skipIf(!gitAtLeast(2, 38))("final3 L4 each repo gets its squash cap regardless of concurrency", async () => {
  const { env } = isolatedGit();
  const paths: string[] = [];
  for (let i = 0; i < 2; i++) {
    const repo = await newRepo(); paths.push(repo);
    await g(repo, ["remote", "add", "origin", join(scratch("remote"), "unused.git")], env);
    await g(repo, ["checkout", "-q", "-b", "kept"], env);
    await commitAt(repo, env, { "work.txt": "work" }, "work", at(12, 11));
    for (let n = 0; n < 9; n++) await g(repo, ["branch", `kept-${n}`], env);
    await g(repo, ["checkout", "-q", "main"], env);
    await g(repo, ["merge", "--squash", "kept"], env);
    await g(repo, ["commit", "-q", "-m", "Work (#7)"], env, { GIT_AUTHOR_DATE: at(12, 12), GIT_COMMITTER_DATE: at(12, 12) });
    await g(repo, ["update-ref", "refs/remotes/origin/main", "main"], env);
  }
  for (const concurrency of [1, 2]) {
    const r = all((await status(env, req(), { readRecord: accepted(record({ repos: paths })), now: () => new Date(at(13)), concurrency })).result);
    expect(r.repoViews.every((v) => v.state === "ok")).toBe(true);
    expect(r.tile).toEqual({ commits: 0, branches: 0 });
    expect(r.pushCards).toEqual([]);
  }
}, 30_000);
