import "./fixtures/isolate-state";   // A0 — keeps supportDir() fallbacks off the REAL state dir (see test/isolation.meta.test.ts)
// test/git.show-signature.test.ts — a user's `log.showSignature=true` must not reach the parsers.
//
// With that config git runs gpg on every SIGNED commit and prints gpg's verdict INTO STDOUT, ahead of the
// formatted record. The engine formats and splits `git log` / `git show` output itself, so before
// `--no-show-signature` (src/git.ts `NO_SHOW_SIGNATURE`) `shaAndDate` took the gpg line for the HEAD SHA
// and every other parser saw lines it never asked for.
//
// No real gpg and no key: the repo's `gpg.program` is a shell stand-in that "signs" (prints a dummy
// armored block and the SIG_CREATED status git requires) and "verifies" (prints a noise line on stderr,
// which git relays into `git log`'s stdout). The premise test proves that noise really reaches a plain
// `git log` in the fixture, so the equalities below are not vacuous.
import { test, expect, beforeAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildRepo, commitFiles, branchCommit, mergeBranchWith } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import {
  committerDaysWithCommits, listCommits, listPrMerges, patchIds, resumptionSignals, listDefaultRefMerges,
  startGitBudget, NO_SHOW_SIGNATURE,
} from "../src/git";

const NOISE = "FAKEGPG-NOISE";

/** The fixture's own git runs under a NEUTRAL config, like `buildRepo`'s (round-4 harden D4-L1): a
 *  developer's global `gpg.format=ssh|x509` or `gpg.program` must not decide which signer the fixture
 *  calls. The code under test (`runGit`) still runs under the real environment, as in production — the
 *  repo's own `gpg.format`/`gpg.program` below outrank any global value there. */
const NEUTRAL_GIT = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" };

async function git(repo: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", repo, ...args], { env: { ...process.env, ...NEUTRAL_GIT }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${err}`);
  return out;
}

let repo = "";
/** The stand-in gpg appends a line here every time git asks it to VERIFY — proof gpg ran, independent of
 *  whether its output reached stdout (a `%G?` read consumes gpg's status, it prints none of gpg's noise). */
let verifyRan = "";
const day = (n: number) => new Date(Date.now() - n * 864e5).toISOString();

beforeAll(async () => {
  const bin = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-fakegpg-")));
  const gpg = join(bin, "fake-gpg.sh");
  verifyRan = join(bin, "verify-ran");
  writeFileSync(gpg, `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "--verify" ]; then
    echo verify >> '${verifyRan}'
    echo "gpg: ${NOISE} Signature made by nobody" >&2
    echo "[GNUPG:] NEWSIG"
    echo "[GNUPG:] GOODSIG 0123456789ABCDEF Nobody"
    exit 0
  fi
done
cat > /dev/null
echo "[GNUPG:] BEGIN_SIGNING H8" >&2
echo "[GNUPG:] SIG_CREATED D 1 8 00 1759000000 0123456789ABCDEF" >&2
printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nZmFrZQ==\\n=AAAA\\n-----END PGP SIGNATURE-----\\n'
`, { mode: 0o755 });
  repo = await buildRepo([]);
  // The stand-in is an OpenPGP signer. One of TWO guards, each enough alone (round-4 harden D4-L1,
  // measured in a disposable copy): with a global `gpg.format=ssh` this suite stayed green when either
  // this line or buildRepo's neutral config was removed, and went red (ssh-keygen handed this key id)
  // only with both gone; with `gpg.format=x509` the global signer was then called.
  await git(repo, "config", "gpg.format", "openpgp");
  await git(repo, "config", "gpg.program", gpg);
  await git(repo, "config", "user.signingkey", "0123456789ABCDEF");
  await git(repo, "config", "commit.gpgsign", "true");
  await commitFiles(repo, ["a.txt"], { message: "first signed commit", isoDate: day(2) });
  await branchCommit(repo, "feature", "f.txt", day(1));
  await mergeBranchWith(repo, "feature", "Merge pull request #7 from someone/feature", day(1));
  await commitFiles(repo, ["b.txt", "c.txt"], { message: "second signed commit", isoDate: day(1) });
});

/** Every parser that reads `git log` / `git show` / `git stash list`, as one comparable value. */
async function parsed() {
  const start = new Date(Date.now() - 5 * 864e5), end = new Date(Date.now() + 864e5);
  const commits = await listCommits(repo, start, end);
  const shas = commits.map((c) => String((c as { event_id?: string }).event_id ?? ""));
  return {
    days: [...(await committerDaysWithCommits(repo, undefined, 5))].sort(),
    commits,
    prMerges: await listPrMerges(repo, start, end),
    patchIds: [...(await patchIds(repo, shas.filter(Boolean))).entries()].sort(),
    // `resumptionSignals` stamps `now` on some activities; the HEAD branch activity is the one whose SHA
    // comes from `git show` (shaAndDate) — compared whole, minus nothing.
    resume: (await resumptionSignals(repo)).filter((a) => a.kind === "branch"),
    defaultRefMerges: await listDefaultRefMerges(repo, start, new Date(), startGitBudget(30_000)),
  };
}

test("premise: the fixture's commits are signed and a plain `git log` with log.showSignature=true prints gpg noise", async () => {
  await git(repo, "config", "log.showSignature", "true");
  try {
    expect(await git(repo, "log", "-1", "--format=%H")).toContain(NOISE);
    expect(await git(repo, "show", "-s", "--format=%H", "HEAD")).toContain(NOISE);
    // …and the flag the engine passes is what silences it.
    expect(await git(repo, "log", NO_SHOW_SIGNATURE, "-1", "--format=%H")).not.toContain(NOISE);
  } finally { await git(repo, "config", "--unset", "log.showSignature"); }
});

test("every parsed git read is identical with and without log.showSignature=true, and carries no gpg line", async () => {
  const plain = await parsed();
  // PREMISES: the reads found what the fixture built, so an equality of two empties cannot pass.
  expect(plain.commits.length).toBeGreaterThanOrEqual(3);
  expect(plain.prMerges.map((m) => m.prNum)).toEqual(["7"]);
  expect(plain.patchIds.length).toBeGreaterThanOrEqual(2);
  expect(plain.resume.length).toBe(1);
  expect(plain.defaultRefMerges.merges.length).toBe(1);
  const head = (await git(repo, "rev-parse", "HEAD")).trim();
  expect(JSON.stringify(plain.resume)).toContain(head);

  await git(repo, "config", "log.showSignature", "true");
  let signed: Awaited<ReturnType<typeof parsed>>;
  try { signed = await parsed(); } finally { await git(repo, "config", "--unset", "log.showSignature"); }
  expect(JSON.stringify(signed!)).not.toContain(NOISE);
  expect(JSON.stringify(signed!)).not.toContain("gpg:");
  expect(signed!).toEqual(plain);
});

// The behavioural test above KILLS a missing flag on `git show` (shaAndDate) and on `listCommits`, but
// measured in a disposable copy, the other parsers happen to SURVIVE gpg's lines today — a noise line
// fails their field split and is skipped by accident, not by design. So every parsed read is also pinned
// at the source: each `"log"` / `"show"` / `"stash", "list"` in src/git.ts carries the flag right after it.
test("every git log / show / stash list in src/git.ts passes NO_SHOW_SIGNATURE", async () => {
  const src = await Bun.file(new URL("../src/git.ts", import.meta.url).pathname).text();
  const sites = [...src.matchAll(/"(?:log|show)"|"stash",\s*"list"/g)];
  expect(sites.length).toBe(7);                     // show, days, listCommits, merges, patchIds, stash, default-ref merges
  const bare = sites.filter((m) => !/^\s*,\s*NO_SHOW_SIGNATURE\b/.test(src.slice(m.index! + m[0].length)));
  expect(bare.map((m) => src.slice(0, m.index).split("\n").length)).toEqual([]);   // line numbers of any bare site
});

// ── Round-3 harden G3-1: `format.pretty` with `%G?`/`%GG` runs gpg DESPITE `--no-show-signature` ─────────
// The flag silences the signature HEADER; a `%G?` placeholder in the user's default format is a separate
// request for the verdict, so git verifies (runs gpg) to fill it. Only an explicit `--format`/`--pretty` on
// the command replaces `format.pretty`. `patchIds` had none — its `git log -p` used the user's default.
const SIG_FORMAT = "%H %G? %GG";

test("premise (G3-1): with format.pretty holding %G?, a git log WITHOUT an explicit format runs gpg — even with --no-show-signature", async () => {
  rmSync(verifyRan, { force: true });
  await git(repo, "config", "format.pretty", SIG_FORMAT);
  try {
    await git(repo, "log", NO_SHOW_SIGNATURE, "-1");
    expect(existsSync(verifyRan)).toBe(true);
    rmSync(verifyRan, { force: true });
    await git(repo, "log", NO_SHOW_SIGNATURE, "-1", "--format=%H");   // …and an explicit one does not
    expect(existsSync(verifyRan)).toBe(false);
  } finally { await git(repo, "config", "--unset", "format.pretty"); rmSync(verifyRan, { force: true }); }
});

test("G3-1: no parsed git read starts gpg under a %G?/%GG format.pretty, and every result is unchanged", async () => {
  const plain = await parsed();
  expect(plain.patchIds.length).toBeGreaterThanOrEqual(2);       // PREMISE: patchIds really ran git log -p
  rmSync(verifyRan, { force: true });
  await git(repo, "config", "format.pretty", SIG_FORMAT);
  let under: Awaited<ReturnType<typeof parsed>>;
  try { under = await parsed(); } finally { await git(repo, "config", "--unset", "format.pretty"); }
  expect(`gpg ran: ${existsSync(verifyRan)}`).toBe("gpg ran: false");
  expect(under!).toEqual(plain);
});

test("patchIds still fingerprints under log.abbrevCommit=true (its `commit` line carries the FULL SHA)", async () => {
  const start = new Date(Date.now() - 5 * 864e5), end = new Date(Date.now() + 864e5);
  const shas = (await listCommits(repo, start, end)).map((c) => String((c as { event_id?: string }).event_id ?? "")).filter(Boolean);
  const plain = [...(await patchIds(repo, shas)).entries()].sort();
  expect(plain.length).toBeGreaterThanOrEqual(2);
  await git(repo, "config", "log.abbrevCommit", "true");
  let abbrev: [string, string][];
  try { abbrev = [...(await patchIds(repo, shas)).entries()].sort(); } finally { await git(repo, "config", "--unset", "log.abbrevCommit"); }
  expect(abbrev!).toEqual(plain);
});

// The source half: every parsed `log` / `show` / `stash list` names its OWN format, so no user default
// (`format.pretty`, `log.abbrevCommit` on a medium header) reaches it. The site's argument array runs to
// its first `]`; each one's format must be inside it.
test("every git log / show / stash list in src/git.ts carries an explicit --format= or --pretty=", async () => {
  const src = await Bun.file(new URL("../src/git.ts", import.meta.url).pathname).text();
  const sites = [...src.matchAll(/"(?:log|show)"|"stash",\s*"list"/g)];
  expect(sites.length).toBe(7);
  const unformatted = sites.filter((m) => {
    const args = src.slice(m.index!, src.indexOf("]", m.index!));
    return !/"--(?:format|pretty)=|`--(?:format|pretty)=/.test(args);
  });
  expect(unformatted.map((m) => src.slice(0, m.index).split("\n").length)).toEqual([]);   // line numbers of any unformatted site
});
