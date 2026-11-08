// test/fixtures/repos-fixtures.ts — scratch repos and a git environment for the live git check's tests
// (B1, wave-2 plan). Every repo is built per test in a temp tree (removed at run end, ./temp-dirs), never
// one of the user's repos.
//
// THE GIT ENVIRONMENT. `hgit` passes a sanitized explicit environment; other helpers may inherit Bun's
// start-up environment instead of later `process.env` edits (measured on bun 1.3.14). A test that needs
// git to see a per-test global config, no
// system config, `GIT_TEST_ASSUME_DIFFERENT_OWNER` or `GIT_TRACE2_EVENT` installs `gitEnv(...)`: a
// pass-through `spyOn(Bun, "spawn")` (the seam test/git.swallow-audit.test.ts already uses) that adds
// those variables to every `git` spawn, records each argv, and can substitute an argv for one call.
import { spyOn } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { removeAtRunEnd } from "./temp-dirs";
import { buildRepo } from "./build-repo";

const realSpawn = Bun.spawn;
type SpawnArgs = Parameters<typeof Bun.spawn>;

export const scratch = (label: string): string => removeAtRunEnd(mkdtempSync(join(tmpdir(), `dba-repos-${label}-`)));

/** A per-test git config environment: a global file of the test's own, holding only an identity, and no system
 *  config. The identity is `buildRepo`'s, so a clone of a built repo (which does not copy the repo's local
 *  `user.*`) can still commit where git cannot derive one: CI's runner has no valid host name (PR #674's first
 *  run: "Author identity unknown"; macOS git derives one, so it passed locally). A repo's own `user.*` still wins. */
export function isolatedGit(): { global: string; env: Record<string, string> } {
  const global = join(scratch("global"), "gitconfig");
  writeFileSync(global, "[user]\n\tname = Test\n\temail = test@example.com\n");
  return { global, env: { GIT_CONFIG_GLOBAL: global, GIT_CONFIG_NOSYSTEM: "1" } };
}

/** The real git, for building fixtures, under `env` (the test's isolated config). Throws on failure. */
export async function g(cwd: string, args: string[], env: Record<string, string>, extra: Record<string, string> = {}): Promise<string> {
  const p = realSpawn(["git", ...args], { cwd, env: { ...process.env, ...env, ...extra }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  if (p.exitCode !== 0) throw new Error(`git ${args.join(" ")} in ${cwd}: ${err}`);
  return out;
}

/** The real git, returning its exit code and output without throwing (the controls). */
export async function gRaw(cwd: string, args: string[], env: Record<string, string>): Promise<{ code: number | null; out: string; err: string }> {
  const p = realSpawn(["git", ...args], { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  await p.exited;
  return { code: p.exitCode, out, err };
}

/** A repo on `main` with one commit per file of `files` (name → content), built by the existing
 *  `buildRepo` helper (its own neutral config, its identity set locally). */
export async function newRepo(files: Record<string, string> = { "f.txt": "f\n" }): Promise<string> {
  return buildRepo(Object.entries(files).map(([file, content]) => ({ file, content, isoDate: "2026-01-11T10:00:00Z" })));
}

/** An executable shell script that touches `marker` and then behaves as `body` (default: `cat`). */
export function markerScript(dir: string, name: string, marker: string, body = "cat"): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\ntouch '${marker}'\n${body}\n`, { mode: 0o755 });
  return path;
}

export type GitEnvSpy = { calls: string[][]; options: { env?: Record<string, string | undefined>; stdin?: unknown }[]; restore(): void };
/** Install the pass-through spy described in the header. `substitute(argv)` returns a replacement argv
 *  for a call to hijack, or undefined to let it through (the substitute gets the same environment). */
export function gitEnv(env: Record<string, string>, substitute: (argv: string[]) => string[] | undefined = () => undefined): GitEnvSpy {
  const calls: string[][] = [];
  const options: GitEnvSpy["options"] = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((cmd: SpawnArgs[0], opts: SpawnArgs[1]) => {
    const argv = cmd as string[];
    if (argv[0] !== "git") return realSpawn(cmd as any, opts as any);
    calls.push(argv);
    const o = (opts ?? {}) as GitEnvSpy["options"][number];
    options.push(o);
    return realSpawn((substitute(argv) ?? argv) as any, { ...(opts as object), env: { ...(o.env ?? process.env), ...env } } as any);
  }) as typeof Bun.spawn);
  return { calls, options, restore: () => spy.mockRestore() };
}

/** Run `fn` with `env` reaching every git spawn (the spy above), restoring the real spawn after. */
export async function withGit<T>(env: Record<string, string>, fn: () => Promise<T>, substitute?: (argv: string[]) => string[] | undefined): Promise<{ result: T; calls: string[][] }> {
  const spy = gitEnv(env, substitute);
  try { return { result: await fn(), calls: spy.calls }; } finally { spy.restore(); }
}

/** A commit of `files` (path → content) at `date` (committer and author), with `message`; its SHA. Run
 *  under the test's isolated config. */
export async function commitAt(repo: string, env: Record<string, string>, files: Record<string, string>, message: string, date: string): Promise<string> {
  for (const [file, content] of Object.entries(files)) {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
  }
  await g(repo, ["add", "-A"], env);
  await g(repo, ["commit", "-q", "--allow-empty", "-m", message], env, { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return (await g(repo, ["rev-parse", "HEAD"], env)).trim();
}

/** Two commit objects (parent `parent`, its tree) whose SHAs share their first `len` hex characters, found
 *  by hashing candidate commit texts in JS (a birthday search, about 20 000 hashes for 7 characters) and
 *  then written with `git hash-object -w`. Reachable from no ref. Deterministic for a given parent. */
export async function ambiguousPair(repo: string, env: Record<string, string>, parent: string, len = 7): Promise<[string, string]> {
  const tree = (await g(repo, ["rev-parse", `${parent}^{tree}`], env)).trim();
  const body = (n: number) => `tree ${tree}\nparent ${parent}\nauthor T <t@x> 1767000000 +0000\ncommitter T <t@x> 1767000000 +0000\n\nambiguous ${n}\n`;
  const sha1 = (text: string) => new Bun.CryptoHasher("sha1").update(`commit ${Buffer.byteLength(text)}\0${text}`).digest("hex");
  const seen = new Map<string, number>();
  for (let n = 0; ; n++) {
    const p = sha1(body(n)).slice(0, len);
    const other = seen.get(p);
    if (other !== undefined) {
      const write = async (k: number) => {
        const file = join(scratch("obj"), "c");
        writeFileSync(file, body(k));
        return (await g(repo, ["hash-object", "-t", "commit", "-w", file], env)).trim();
      };
      return [await write(other), await write(n)];
    }
    seen.set(p, n);
  }
}

/** The stand-in gpg (test/git.show-signature.test.ts's): it "signs" without a key, and leaves `verify`
 *  in `marker` whenever git asks it to VERIFY. */
export function fakeGpg(dir: string, marker: string): string {
  const path = join(dir, "fake-gpg.sh");
  writeFileSync(path, `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "--verify" ]; then
    touch '${marker}'
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
  return path;
}

/** Sign every later commit in `repo` with the stand-in gpg (which, verifying, leaves `<dir>/gpg`). */
export async function signCommits(repo: string, env: Record<string, string>, dir: string): Promise<void> {
  await g(repo, ["config", "gpg.format", "openpgp"], env);
  await g(repo, ["config", "gpg.program", fakeGpg(dir, join(dir, "gpg"))], env);
  await g(repo, ["config", "user.signingkey", "0123456789ABCDEF"], env);
  await g(repo, ["config", "commit.gpgsign", "true"], env);
}

export type Hostile = { dir: string; ran(): string[] };
/** ARM a built fixture repo with every repo-scoped program git could run from its own config: a filter
 *  `h` (clean, smudge), a diff driver `h` (textconv, command), a merge driver `h`, `diff.external`,
 *  `core.fsmonitor`, a hooks directory holding every hook name, and `log.showSignature=true` with the
 *  stand-in gpg (`signCommits` first, so signed commits exist). `.git/info/attributes` selects `h` for
 *  every path. Each program touches its own marker in `dir` and then behaves; `ran()` lists the markers.
 *  Arm LAST: the fixture's own later git would run them too. */
export async function armHostile(repo: string, env: Record<string, string>, dir: string = scratch("hostile")): Promise<Hostile> {
  const m = (name: string, body: string) => markerScript(dir, `${name}.sh`, join(dir, name), body);
  await g(repo, ["config", "filter.h.clean", m("filter-clean", "cat")], env);
  await g(repo, ["config", "filter.h.smudge", m("filter-smudge", "cat")], env);
  await g(repo, ["config", "diff.h.textconv", m("textconv", 'cat "$1"')], env);
  await g(repo, ["config", "diff.h.command", m("diff-command", "exit 0")], env);
  await g(repo, ["config", "merge.h.driver", `${m("merge-driver", "exit 0")} %O %A %B`], env);
  await g(repo, ["config", "diff.external", m("diff-external", "exit 0")], env);
  await g(repo, ["config", "core.fsmonitor", m("fsmonitor", "exit 1")], env);
  const hooks = join(dir, "hooks");
  mkdirSync(hooks, { recursive: true });
  for (const h of ["pre-commit", "post-commit", "post-checkout", "post-merge", "pre-push", "reference-transaction", "post-index-change", "pre-auto-gc"]) {
    writeFileSync(join(hooks, h), `#!/bin/sh\ntouch '${join(dir, `hook-${h}`)}'\n`, { mode: 0o755 });
  }
  await g(repo, ["config", "core.hooksPath", hooks], env);
  await g(repo, ["config", "log.showSignature", "true"], env);
  if (!existsSync(join(dir, "fake-gpg.sh"))) await g(repo, ["config", "gpg.program", fakeGpg(dir, join(dir, "gpg"))], env);
  mkdirSync(join(repo, ".git", "info"), { recursive: true });
  writeFileSync(join(repo, ".git", "info", "attributes"), "* filter=h diff=h merge=h\n");
  return { dir, ran: () => readdirSync(dir).filter((f) => !f.endsWith(".sh") && f !== "hooks").sort() };
}

/** The plain-git CONTROLS for an armed repo: a diff over `[a, b]` (runs textconv / the external diff),
 *  a `log -1` of the signed commit `signed` (runs gpg to verify), and, when `merge` is given, a
 *  `merge-tree` over two commits that both change one file (runs the merge driver). Each a plain git,
 *  under the same isolated config, so a hardened test's empty `ran()` is not vacuous. */
export async function runControls(repo: string, env: Record<string, string>, c: { diff?: [string, string]; signed?: string; merge?: [string, string] }): Promise<void> {
  if (c.diff) await gRaw(repo, ["diff", c.diff[0], c.diff[1]], env);
  if (c.signed) await gRaw(repo, ["log", "-1", c.signed], env);
  if (c.merge) await gRaw(repo, ["merge-tree", "--write-tree", c.merge[0], c.merge[1]], env);
}

/** The git version this machine runs, as [major, minor] (for `test.skipIf` floors). */
export function gitVersion(): [number, number] {
  const p = Bun.spawnSync(["git", "--version"]);
  const m = /(\d+)\.(\d+)/.exec(new TextDecoder().decode(p.stdout));
  return m ? [Number(m[1]), Number(m[2])] : [0, 0];
}
export const gitAtLeast = (major: number, minor: number): boolean => {
  const [a, b] = gitVersion();
  return a > major || (a === major && b >= minor);
};
