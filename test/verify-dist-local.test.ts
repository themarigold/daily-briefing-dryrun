// test/verify-dist-local.test.ts — scripts/verify-dist-local.sh (Phase E, E14): what this Mac can prove.
//
// Nothing real is built, mounted, signed or run here. Each case runs the REAL script, committed into a
// throwaway git repo shaped like this project, with:
//   - stubs first on PATH for `bun` (its `-e` goes to the real bun: the script reads the version with it),
//     `hdiutil`, `lipo`, `uname` and `open` — the last one exists only to prove it is never called;
//   - the Tauri CLI and the signing tool as stubs reached through TAURI_CMD and CODESIGN_CMD, the script's
//     two seams (the same seam gui/scripts/ci-tauri-build.sh gives the Tauri CLI);
//   - the REAL release-collect.sh and stage-bundles.sh (pure bash), with a wrapper in front of collect
//     that snapshots its arguments, its markers directory and its dist listing before handing over;
//   - a stub check-versions.sh;
//   - engine stubs for every CLI binary and the bundled sidecar that answer ONLY a lone `--version` and
//     record every invocation's argv, and a GUI main-executable stub that records itself and fails —
//     so a case proves the engine only ever ran with `--version` and the GUI never ran at all;
//   - the REAL plutil when the host has one (macOS), else a whitespace-normalising stand-in, so the
//     entitlements comparison is exercised for real wherever it can be.
// Every stub appends one line to the run's log, so a case asserts what ran and in what order. Each case
// builds the child's environment from nothing, so an APPLE_* variable or an ANTHROPIC_API_KEY set on the
// machine running the suite never reaches a case.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "scripts", "verify-dist-local.sh");
const BASH = Bun.which("bash")!;
const GIT = Bun.which("git")!;
const V = "9.8.7";
const GIT_ENV = { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" };

// maintenance.auto=false: a commit otherwise forks a DETACHED `git maintenance run --auto` that outlives
// the call and takes .git/objects/maintenance.lock. A case that then removes .git races that child, and
// rmSync can return with .git still whole (measured with Homebrew git 2.55, which GitHub's macOS runner
// puts first on PATH: .git survived in 25 of 40 fixtures; 0 of 40 with this flag).
function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync([GIT, "-c", "user.name=fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "maintenance.auto=false", ...args], {
    cwd, env: { PATH: `${dirname(GIT)}:/usr/bin:/bin`, ...GIT_ENV }, stdout: "pipe", stderr: "pipe",
  });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** git from `cwd` as the script's parent-side probe asks it (no GIT_DIR-style override, discovery across
 *  filesystems), for a premise that may FAIL: its exit code and output, never a throw. */
function gitProbe(cwd: string, ...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync([GIT, ...args], {
    cwd, env: { PATH: `${dirname(GIT)}:/usr/bin:/bin`, ...GIT_ENV, GIT_DISCOVERY_ACROSS_FILESYSTEM: "1" }, stdout: "pipe", stderr: "pipe",
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

const LOG = (who: string) => `printf '%s\\n' "${who} $*" >> "$STUB_LOG"`;

/** The stubs, written once per file (a freshly written executable's first exec is slow on macOS). */
let shared: { bin: string; tauri: string; signer: string } | undefined;
function stubs() {
  if (shared) return shared;
  const dir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-verify-dist-stubs-")));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const sh = (path: string, lines: string[]) => writeFileSync(path, ["#!/bin/sh", ...lines, ""].join("\n"), { mode: 0o755 });
  // Every engine binary the script could run — the 5 CLI builds and the bundled sidecar — is this stub,
  // with @VERSION@ baked in. It answers only argv === ["--version"], records every invocation, and fails
  // loudly on anything else, so a run that drove the engine any other way cannot pass.
  sh(join(dir, "engine-stub"), [
    `printf 'engine argc=%s argv=%s path=%s\\n' "$#" "$*" "$0" >> "$STUB_LOG"`,
    'if [ "$#" -eq 1 ] && [ "$1" = "--version" ]; then echo "@VERSION@"; exit 0; fi',
    'echo "engine stub: refusing argv: $*" >&2',
    "exit 97",
  ]);
  // The GUI's main executable must never run: it records itself and fails.
  sh(join(dir, "gui-stub"), [
    `printf 'gui-executed argv=%s\\n' "$*" >> "$STUB_LOG"`,
    'echo "gui stub: the GUI executable must never run" >&2',
    "exit 98",
  ]);
  if (!Bun.which("plutil", { PATH: "/usr/bin:/bin" })) {
    // No plutil on this host (the Linux CI runner): `plutil -convert xml1 -o - <file|->`, approximated by
    // dropping the prolog and the whitespace between tags. Every case here differs semantically, not only
    // in key order, so this and the real plutil agree on all of them.
    sh(join(bin, "plutil"), [
      '[ "$1 $2 $3 $4" = "-convert xml1 -o -" ] || { echo "plutil stub: unexpected argv: $*" >&2; exit 99; }',
      'if [ "$5" = - ]; then in="$(cat)"; else in="$(cat "$5")" || exit 1; fi',
      'case "$in" in *"<plist"*"</plist>"*) ;; *) echo "plutil stub: not a plist" >&2; exit 1 ;; esac',
      `printf '%s' "$in" | tr -d '\\n\\t' | sed -e 's/<?xml[^>]*>//' -e 's/<!DOCTYPE[^>]*>//' -e 's/> *</></g'`,
    ]);
  }
  sh(join(bin, "bun"), [
    'if [ "$1" = "-e" ]; then exec "$REAL_BUN" "$@"; fi',
    LOG("bun"),
    'case "$1" in',
    "  build)",
    '    out=""; prev=""',
    '    for a in "$@"; do [ "$prev" = "--outfile" ] && out="$a"; prev="$a"; done',
    '    [ "${STUB_CLI_RC:-0}" = 0 ] || exit "$STUB_CLI_RC"',
    '    sed "s/@VERSION@/$STUB_VERSION/" "$(dirname "$0")/../engine-stub" > "$out" || exit 1',
    // STUB_CLI_NOEXEC: the darwin-arm64 build lands without its exec bit.
    '    case "$out" in *-darwin-arm64) [ -z "${STUB_CLI_NOEXEC:-}" ] || exit 0 ;; esac',
    '    chmod +x "$out"; exit 0 ;;',
    // Like the real gate, a missing artifact fails.
    '  scripts/check-size-budget.ts) [ -e "$2" ] || { echo "size: $2 is missing"; exit 1; }',
    '    echo "size: $3 ok"; exit "${STUB_SIZE_RC:-0}" ;;',
    "  test)",
    // What the drift guard and the site test saw of the key the suite must never carry.
    '    printf \'%s\\n\' "bun-test-env ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY-<unset>}" >> "$STUB_LOG"',
    '    case "$2" in',
    '      test/docs-config.test.ts) exit "${STUB_DRIFT_RC:-0}" ;;',
    // STUB_LOCK_RUNDIR: leave something in the run directory its final `rm -rf` cannot remove.
    '      test/site.test.ts) if [ -n "${STUB_LOCK_RUNDIR:-}" ]; then for d in "$VERIFY_DIST_TMPDIR"/dba-verify-dist.*; do mkdir -p "$d/locked/x" && chmod 555 "$d/locked"; done; fi',
    '        exit "${STUB_SITE_RC:-0}" ;;',
    "    esac ;;",
    "esac",
    'echo "bun stub: unexpected argv: $*" >&2',
    "exit 99",
  ]);
  sh(join(bin, "hdiutil"), [
    LOG("hdiutil"),
    'case "$1" in',
    '  attach) mnt=""; prev=""; for a in "$@"; do [ "$prev" = "-mountpoint" ] && mnt="$a"; prev="$a"; done',
    '    printf \'%s\\n\' "$mnt" > "$STUB_REC/mnt"',
    '    [ "${STUB_ATTACH_RC:-0}" = 0 ] || exit "$STUB_ATTACH_RC"',
    '    cp -R "$STUB_APP_SRC" "$mnt/"; exit 0 ;;',
    '  detach) [ "${STUB_DETACH_RC:-0}" = 0 ] || exit "$STUB_DETACH_RC"; rm -rf "$2"/*; exit 0 ;;',
    // STUB_INFO_LISTS_MNT: `hdiutil info` still names the scratch mount point; otherwise it names nothing.
    '  info) [ -z "${STUB_INFO_LISTS_MNT:-}" ] || printf \'/dev/disk9s1\\tApple_HFS\\t%s\\n\' "$(cat "$STUB_REC/mnt")"; exit 0 ;;',
    "esac",
    "exit 99",
  ]);
  sh(join(bin, "lipo"), [LOG("lipo"), 'echo "${STUB_ARCH:-arm64}"']);
  sh(join(bin, "uname"), ['case "$1" in -s) echo "${STUB_OS:-Darwin}" ;; -m) echo "${STUB_MACHINE:-arm64}" ;; *) exit 99 ;; esac']);
  sh(join(bin, "open"), [LOG("open"), "exit 0"]);
  const tauri = join(dir, "tauri-stub");
  sh(tauri, [
    LOG("tauri"),
    'env > "$STUB_REC/tauri.env"',
    'pwd > "$STUB_REC/tauri.cwd"',
    '[ "${STUB_TAURI_RC:-0}" = 0 ] || exit "$STUB_TAURI_RC"',
    'b="src-tauri/target/release/bundle"; app="$b/macos/Daily Briefing.app"',
    'mkdir -p "$b/dmg" "$app/Contents/MacOS" "$app/Contents/_CodeSignature"',
    'echo dmg > "$b/dmg/Daily Briefing_${STUB_VERSION}_aarch64.dmg"',
    'cp "$(dirname "$0")/gui-stub" "$app/Contents/MacOS/daily-briefing-gui"',
    'sed "s/@VERSION@/${STUB_SIDECAR_VERSION:-$STUB_VERSION}/" "$(dirname "$0")/engine-stub" > "$app/Contents/MacOS/daily-briefing"',
    'chmod +x "$app/Contents/MacOS/daily-briefing-gui" "$app/Contents/MacOS/daily-briefing"',
    // STUB_TAURI_NO_SEAL: a bundle with no resource seal.
    '[ -n "${STUB_TAURI_NO_SEAL:-}" ] || : > "$app/Contents/_CodeSignature/CodeResources"',
    // As a cargo build without --locked would, when Cargo.toml and Cargo.lock disagree.
    '[ -z "${STUB_TAURI_REWRITES_LOCK:-}" ] || echo "# re-resolved" >> src-tauri/Cargo.lock',
    // STUB_TAURI_BREAKS_GIT: corrupt the index, so every later `git diff HEAD` fails.
    '[ -z "${STUB_TAURI_BREAKS_GIT:-}" ] || echo garbage > ../.git/index',
    "exit 0",
  ]);
  const signer = join(dir, "signer-stub");
  sh(signer, [
    LOG("sign"),
    'case "$1" in',
    '  -dvv) echo "Executable=$2" >&2',
    '    echo "CodeDirectory v=20500 size=1 ${STUB_FLAGS:-flags=0x10002(adhoc,runtime)} hashes=1+0 location=embedded" >&2',
    '    echo "${STUB_SIGNATURE_LINE:-Signature=adhoc}" >&2; exit 0 ;;',
    // The default is gui/src-tauri/entitlements.plist's content, laid out differently: equal as a plist.
    `  -d) if [ -n "\${STUB_ENTITLEMENTS:-}" ]; then printf '%s\\n' "$STUB_ENTITLEMENTS"; exit 0; fi`,
    `    echo '<plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><false/></dict></plist>'; exit 0 ;;`,
    '  --verify) exit "${STUB_VERIFY_RC:-0}" ;;',
    "  --force) exit 0 ;;",
    "esac",
    "exit 99",
  ]);
  return (shared = { bin, tauri, signer });
}

interface Fx { base: string; repo: string; tmp: string; rec: string; log: string }

function fixture(): Fx {
  const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-verify-dist-")));
  const repo = join(base, "repo");
  const tmp = join(base, "tmp");
  const rec = join(base, "rec");
  for (const d of [join(repo, "scripts"), join(repo, "docs"), join(repo, "src"), join(repo, "gui", "scripts"), join(repo, "gui", "src-tauri"), join(repo, "dist"), tmp, rec]) {
    mkdirSync(d, { recursive: true });
  }
  copyFileSync(SCRIPT, join(repo, "scripts", "verify-dist-local.sh"));
  copyFileSync(join(ROOT, "scripts", "release-collect.sh"), join(repo, "scripts", "release-collect.real.sh"));
  copyFileSync(join(ROOT, "docs", "release-notes.template.md"), join(repo, "docs", "release-notes.template.md"));
  copyFileSync(join(ROOT, "gui", "scripts", "stage-bundles.sh"), join(repo, "gui", "scripts", "stage-bundles.sh"));
  copyFileSync(join(ROOT, "gui", "src-tauri", "entitlements.plist"), join(repo, "gui", "src-tauri", "entitlements.plist"));
  writeFileSync(join(repo, "scripts", "release-collect.sh"), [
    "#!/bin/sh",
    LOG("collect"),
    'rm -rf "$STUB_REC/markers" && cp -R "$2" "$STUB_REC/markers"',
    'ls -1 "$1" > "$STUB_REC/collect.dist"',
    'bash "$(dirname "$0")/release-collect.real.sh" "$@"; rc=$?',
    '[ -f "$6" ] && cp "$6" "$STUB_REC/notes.md"',
    'exit "$rc"',
    "",
  ].join("\n"));
  writeFileSync(join(repo, "scripts", "check-versions.sh"), `#!/bin/sh\n${LOG("check-versions")}\nexit "\${STUB_VERSIONS_RC:-0}"\n`);
  writeFileSync(join(repo, "scripts", "check-size-budget.ts"), "// reached through the bun stub only\n");
  writeFileSync(join(repo, "src", "main.ts"), "// reached through the bun stub only\n");
  writeFileSync(join(repo, "gui", "package.json"), JSON.stringify({ name: "fixture-gui", version: V }));
  writeFileSync(join(repo, "gui", "src-tauri", "Cargo.lock"), "# a tracked lockfile\n");
  // The repo's own dist/ holds a stray build, as the real one can: the script must never touch it.
  writeFileSync(join(repo, "dist", "stray-build"), "a stray local build\n");
  writeFileSync(join(repo, ".gitignore"), "dist\ngui/src-tauri/target\n");
  git(repo, "init", "-q");
  git(repo, "add", "-A");
  git(repo, "commit", "-qm", "fixture");
  return { base, repo, tmp, rec, log: join(base, "calls.log") };
}

interface Run { code: number; out: string; err: string; status: Record<string, string>; order: string[]; calls: string[]; fx: Fx }

const ALL_PASS: Record<string, string> = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [String(i + 1), "PASS"]));

/** `setup` runs on the fresh fixture before the script and may return more environment; `script` names
 *  the copy of the script to run (default: the fixture repo's own). */
function run(env: Record<string, string> = {}, args: string[] = [], setup?: (fx: Fx) => Record<string, string> | void, script?: (fx: Fx) => string): Run {
  const fx = fixture();
  const s = stubs();
  writeFileSync(fx.log, "");
  const extra = setup?.(fx) ?? {};
  const r = Bun.spawnSync([BASH, script?.(fx) ?? join(fx.repo, "scripts", "verify-dist-local.sh"), ...args], {
    cwd: fx.base,
    env: {
      PATH: `${s.bin}:${dirname(GIT)}:/usr/bin:/bin`,
      HOME: join(fx.base, "home"),
      REAL_BUN: process.execPath,
      TAURI_CMD: s.tauri,
      CODESIGN_CMD: s.signer,
      VERIFY_DIST_TMPDIR: fx.tmp,
      STUB_LOG: fx.log,
      STUB_REC: fx.rec,
      STUB_VERSION: V,
      STUB_APP_SRC: join(fx.repo, "gui", "src-tauri", "target", "release", "bundle", "macos", "Daily Briefing.app"),
      ...GIT_ENV,
      ...env,
      ...extra,
    },
    stdout: "pipe", stderr: "pipe",
  });
  const out = r.stdout.toString();
  const status: Record<string, string> = {};
  const order: string[] = [];   // step ids as printed: an object's integer-like keys enumerate numerically
  for (const m of out.matchAll(/^\[(\d+)\] .*? (PASS|FAIL|SKIP)$/gm)) { status[m[1]!] = m[2]!; order.push(m[1]!); }
  const calls = readFileSync(fx.log, "utf8").trimEnd().split("\n").filter(Boolean);
  return { code: r.exitCode, out, err: r.stderr.toString(), status, order, calls, fx };
}

const read = (p: string) => readFileSync(p, "utf8");
const markers = (fx: Fx) => Object.fromEntries(readdirSync(join(fx.rec, "markers")).sort().map((f) => [f, read(join(fx.rec, "markers", f))]));
const called = (r: Run, prefix: string) => r.calls.filter((c) => c.startsWith(prefix));
/** The run directory's parent as the script spells it: physical (tmpdir() can be a symlink on macOS). */
const tmpP = (r: Run) => realpathSync(r.fx.tmp);
/** Every letter's case flipped: on a case-insensitive volume the same directory, spelled otherwise. */
const swapCase = (p: string) => p.replace(/[A-Za-z]/g, (c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase()));
/** Probes of THIS machine (never of the platform's name): does a case variant of the temp directory name
 *  the same directory, and does macOS's /System/Volumes/Data firmlink spelling of it? */
const sameDir = (a: string, b: string) => { try { const x = statSync(a), y = statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; } };
const TMP_REAL = realpathSync(tmpdir());
const CASE_FOLDS = swapCase(TMP_REAL) !== TMP_REAL && sameDir(swapCase(TMP_REAL), TMP_REAL);
const FIRMLINK = "/System/Volumes/Data";
const FIRMLINKED = sameDir(`${FIRMLINK}${TMP_REAL}`, TMP_REAL);
/** The R10 discipline, on every run: the engine only ever ran with a lone `--version`; the GUI never ran. */
function expectEngineDiscipline(r: Run) {
  for (const c of called(r, "engine ")) expect(c).toMatch(/^engine argc=1 argv=--version path=/);
  expect(called(r, "gui-executed")).toEqual([]);
}

/** Step 9 when the arm64 leg did not build: here the other two legs are always `build-failed`, so no
 *  leg is `built`, and collect refuses a CLI-only release (user-directed 2026-10-02). */
function expectCliOnlyRefused(r: Run) {
  expect(r.status["9"]).toBe("FAIL");
  expect(markers(r.fx)["macos-arm64.status"]).toBe("build-failed\n");
  expect(r.out).toContain("a CLI-only release is refused");
}

/** release.yml's frozen `cli-binaries` block, expanded into the argv the bun stub records. */
function frozenCliBuilds(): string[] {
  const lines = read(join(ROOT, "test", "fixtures", "release-build-binaries.frozen.txt")).split("\n").map((l) => l.trim());
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const loop = /^for t in ([\w -]+); do$/.exec(lines[i]!);
    if (loop) {
      const body = lines[++i]!;
      expect(lines[++i]).toBe("done");
      for (const t of loop[1]!.trim().split(/\s+/)) out.push(body.replaceAll("$t", t));
    } else if (lines[i]!.startsWith("bun build ")) {
      out.push(lines[i]!);
    }
  }
  return out.map((c) => c.replaceAll('"', "").replace("--outfile dist/", "--outfile <dist>/"));
}

describe("verify-dist-local.sh: the all-PASS run", () => {
  const r = run();

  test("every step passes, in order, and the script exits 0", () => {
    expect(`${r.code}\n${r.out}${r.err}`).toStartWith("0\n");
    expect(r.status).toEqual(ALL_PASS);
    expect(r.order).toEqual(Array.from({ length: 12 }, (_, i) => String(i + 1)));   // printed in step order
    expect(r.out).toContain(`verify-dist-local: PASS — every step passed for ${V}`);
  });

  test("the engine ran exactly three times, each with a lone --version; the GUI never ran", () => {
    expectEngineDiscipline(r);
    const paths = called(r, "engine ").map((c) => c.replace(/^engine argc=1 argv=--version path=/, ""));
    expect(paths).toHaveLength(3);
    expect(paths[0]!).toEndWith("/dist/daily-briefing-darwin-arm64");                        // step 3
    expect(paths[1]!).toEndWith("/copy/Daily Briefing.app/Contents/MacOS/daily-briefing");   // step 7
    expect(paths[2]!).toEndWith("/e4/daily-briefing");                                       // step 8
    for (const p of paths) expect(p).toStartWith(`${tmpP(r)}/dba-verify-dist.`);
  });

  test("the 5 cross-compiles are release.yml's, into the temporary dist", () => {
    const builds = called(r, "bun build");
    // Read from the frozen block release-workflow.test.ts pins release.yml to, so a change there moves this.
    const frozen = frozenCliBuilds();
    expect(frozen).toHaveLength(5);
    expect(builds.map((c) => c.replace(/--outfile \S+\//, "--outfile <dist>/"))).toEqual(frozen);
    for (const b of builds) expect(b).toContain(`--outfile ${tmpP(r)}/dba-verify-dist.`);
  });

  test("collect runs over the temporary dist with `unsigned` and `success` — never the repo's dist/", () => {
    const [collect] = called(r, "collect ");
    const argv = collect!.slice("collect ".length).split(" ");
    expect(argv).toHaveLength(6);
    expect(argv[0]!).toStartWith(`${tmpP(r)}/dba-verify-dist.`);
    expect(argv[0]!).toEndWith("/dist");
    expect(argv[0]!.startsWith(fx(r).repo)).toBe(false);
    expect(argv.slice(2, 5)).toEqual([V, "unsigned", "success"]);
    expect(argv[5]!.startsWith(argv[0]!)).toBe(false);   // the notes go outside the dist
    // What collect was handed: the CLI floor plus the DMG, under their frozen names.
    expect(read(join(fx(r).rec, "collect.dist")).trim().split("\n").sort()).toEqual([
      `daily-briefing-${V}-darwin-arm64.dmg`,
      "daily-briefing-darwin-arm64", "daily-briefing-darwin-x64", "daily-briefing-linux-arm64",
      "daily-briefing-linux-x64", "daily-briefing-windows-x64.exe",
    ]);
    // The repo's own dist/ is exactly as the fixture left it.
    expect(readdirSync(join(fx(r).repo, "dist"))).toEqual(["stray-build"]);
    expect(read(join(fx(r).repo, "dist", "stray-build"))).toBe("a stray local build\n");
  });

  test("each marker holds exactly one token and a newline; the notes name both unbuilt legs", () => {
    expect(markers(fx(r))).toEqual({
      "linux-x86_64.status": "build-failed\n",
      "macos-arm64.status": "built\n",
      "macos-x64.status": "build-failed\n",
    });
    const notes = read(join(fx(r).rec, "notes.md"));
    expect(notes).toContain("`macos-x64`");
    expect(notes).toContain("`linux-x86_64`");
  });

  test("the DMG leg mounts read-only and out of Finder's sight, detaches, and never calls open", () => {
    const attach = called(r, "hdiutil attach");
    expect(attach).toHaveLength(1);
    expect(attach[0]!).toMatch(new RegExp(`^hdiutil attach \\S+/stage/daily-briefing-${V.replace(/\./g, "\\.")}-darwin-arm64\\.dmg -nobrowse -noautoopen -readonly -mountpoint \\S+/mnt$`));
    expect(called(r, "hdiutil detach")).toHaveLength(1);
    expect(called(r, "open")).toEqual([]);
    // The main executable was only ever inspected — lipo on both — and never run (its stub records a run).
    expect(called(r, "gui-executed")).toEqual([]);
    expect(called(r, "lipo").map((c) => c.replace(/^lipo -archs \S+\/copy\/Daily Briefing\.app\/Contents\/MacOS\//, ""))).toEqual(["daily-briefing-gui", "daily-briefing"]);
  });

  test("the hardened-runtime leg signs only a scratch copy of the bare sidecar", () => {
    const signs = called(r, "sign --force");
    expect(signs).toHaveLength(1);
    expect(signs[0]!).toMatch(/^sign --force --sign - --options runtime --timestamp=none \S+\/e4\/daily-briefing$/);
    expect(signs[0]!).toContain(`${tmpP(r)}/dba-verify-dist.`);
  });

  test("the drift guard and the site test both run (the API-key case below proves the key never reaches them)", () => {
    expect(called(r, "bun test")).toEqual(["bun test test/docs-config.test.ts", "bun test test/site.test.ts"]);
  });

  test("an all-PASS run removes its run directory", () => {
    expect(readdirSync(fx(r).tmp)).toEqual([]);
  });
});
/** The fixture a run used. */
function fx(r: Run): Fx { return r.fx; }

describe("verify-dist-local.sh: the local `tauri build` rule", () => {
  test("every ambient APPLE_* and TAURI_BUNDLER_DMG_IGNORE_CI is unset; CI=true; ad-hoc identity; no --target", () => {
    const r = run({
      APPLE_CERTIFICATE: "base64-p12", APPLE_CERTIFICATE_PASSWORD: "pw", APPLE_SIGNING_IDENTITY: "Someone's Identity",
      APPLE_ID: "dev@example.invalid", APPLE_PASSWORD: "pw", APPLE_TEAM_ID: "TEAM", APPLE_API_KEY: "K",
      APPLE_API_ISSUER: "I", APPLE_API_KEY_PATH: "/x.p8", APPLE_SOMETHING_NEW: "y",
      TAURI_BUNDLER_DMG_IGNORE_CI: "true", CI: "false", ANTHROPIC_API_KEY: "sk-ant-not-a-key",
    });
    expect(`${r.code}\n${r.out}${r.err}`).toStartWith("0\n");
    expectEngineDiscipline(r);
    const env = Object.fromEntries(read(join(r.fx.rec, "tauri.env")).trimEnd().split("\n").map((l) => {
      const i = l.indexOf("=");
      return [l.slice(0, i), l.slice(i + 1)];
    }));
    expect(Object.keys(env).filter((k) => k.startsWith("APPLE_"))).toEqual(["APPLE_SIGNING_IDENTITY"]);
    expect(env.APPLE_SIGNING_IDENTITY).toBe("-");
    expect(env.CI).toBe("true");
    expect("TAURI_BUNDLER_DMG_IGNORE_CI" in env).toBe(false);
    expect(called(r, "tauri")).toEqual(["tauri build"]);
    expect(read(join(r.fx.rec, "tauri.cwd")).trim()).toEndWith("/repo/gui");
    // …and the key never reaches the two test steps.
    expect(called(r, "bun-test-env")).toEqual(["bun-test-env ANTHROPIC_API_KEY=<unset>", "bun-test-env ANTHROPIC_API_KEY=<unset>"]);
  });
});

describe("verify-dist-local.sh: a FAIL never stops the later steps", () => {
  test("a failed tauri build fails every step that needs its outputs; collect, the tests and the tracked check still run", () => {
    const r = run({ STUB_TAURI_RC: "1" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "4": "FAIL", "5": "FAIL", "6": "FAIL", "7": "FAIL", "8": "FAIL", "9": "FAIL" });
    expect(markers(r.fx)["macos-arm64.status"]).toBe("build-failed\n");   // not size-rejected: nothing was measured
    expect(called(r, "collect ")).toHaveLength(1);
    expectCliOnlyRefused(r);
    expect(called(r, "bun test")).toEqual(["bun test test/docs-config.test.ts", "bun test test/site.test.ts"]);
    expect(called(r, "hdiutil")).toEqual([]);   // no staged DMG: nothing was attached
    expect(r.out).toContain("verify-dist-local: FAIL — 6 step(s) failed");
    expect(r.out).toContain("run directory kept:");
  });

  test("a failing drift guard → exit 1, and the site test after it still runs", () => {
    const r = run({ STUB_DRIFT_RC: "1" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "10": "FAIL" });
    expect(called(r, "bun test")).toEqual(["bun test test/docs-config.test.ts", "bun test test/site.test.ts"]);
    expect(markers(r.fx)["macos-arm64.status"]).toBe("built\n");
  });

  test("a failing site test → exit 1", () => {
    const r = run({ STUB_SITE_RC: "1" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "11": "FAIL" });
  });

  test("a size-gate failure after a good build marks the leg size-rejected, and collect refuses it", () => {
    const r = run({ STUB_SIZE_RC: "1" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "6": "FAIL", "9": "FAIL" });
    expect(markers(r.fx)["macos-arm64.status"]).toBe("size-rejected\n");
  });

  test("a linker-only signature fails the hardened-runtime step, and the DMG stays out of the dist", () => {
    const r = run({ STUB_FLAGS: "flags=0x20002(adhoc,linker-signed)" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "8": "FAIL", "9": "FAIL" });
    expect(r.out).toContain("are linker-signed (bun's build-time signature");
    expect(r.out).not.toContain("lack runtime");
    expectCliOnlyRefused(r);
    expect(read(join(r.fx.rec, "collect.dist"))).not.toContain(".dmg");
  });

  test("a signature without the hardened runtime fails the hardened-runtime step, and the DMG stays out of the dist", () => {
    const r = run({ STUB_FLAGS: "flags=0x2(adhoc)" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "8": "FAIL", "9": "FAIL" });
    expect(r.out).toContain("flags (adhoc) lack runtime");
    expectCliOnlyRefused(r);
    expect(read(join(r.fx.rec, "collect.dist"))).not.toContain(".dmg");
  });

  test("a sidecar answering the wrong version fails the DMG leg", () => {
    const r = run({ STUB_SIDECAR_VERSION: "0.0.1" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "7": "FAIL", "9": "FAIL" });
    expect(r.out).toContain("printed '0.0.1', expected '9.8.7'");
    expectCliOnlyRefused(r);
    expect(called(r, "hdiutil detach")).toHaveLength(1);
  });

  test("an x86_64 sidecar fails the DMG leg", () => {
    const r = run({ STUB_ARCH: "x86_64" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status["7"]).toBe("FAIL");
  });

  test("a failed cross-compile fails the CLI step, and collect fails on the missing CLI floor", () => {
    const r = run({ STUB_CLI_RC: "1" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status["3"]).toBe("FAIL");
    expect(r.status["8"]).toBe("FAIL");   // no bare sidecar to sign
    expect(r.status["9"]).toBe("FAIL");
    expect(r.status["10"]).toBe("PASS");
  });

  test("a version mismatch across the carriers fails step 2 only", () => {
    const r = run({ STUB_VERSIONS_RC: "1" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "2": "FAIL" });
  });

  test("a non-macOS host fails step 1, and every later step still runs", () => {
    const r = run({ STUB_OS: "Linux" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "1": "FAIL" });
  });

  test("a build that rewrites a tracked file fails the last step", () => {
    const r = run({ STUB_TAURI_REWRITES_LOCK: "1" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "12": "FAIL" });
    expect(r.out).toContain("gui/src-tauri/Cargo.lock");
  });

  test("a git diff that fails after the run fails the last step — two failed snapshots are not equal digests", () => {
    const r = run({ STUB_TAURI_BREAKS_GIT: "1" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "12": "FAIL" });
    expect(r.out).toContain("the after-run snapshot (git diff HEAD) failed");
  });

  test("a darwin-arm64 CLI build without its exec bit fails the CLI step, naming it", () => {
    const r = run({ STUB_CLI_NOEXEC: "1" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status["3"]).toBe("FAIL");
    expect(r.out).toContain("daily-briefing-darwin-arm64 is missing or not executable, so its --version was not run");
    expect(r.status["8"]).toBe("FAIL");   // its scratch copy cannot run either
  });
});

describe("verify-dist-local.sh: the hardened-runtime step judges each signature property", () => {
  // Each toggle breaks ONE property; step 8 fails, the arm64 leg is not `built`, and so collect (step 9)
  // refuses a release with no desktop bundle.
  const cases: [string, Record<string, string>, string][] = [
    ["no Signature=adhoc line", { STUB_SIGNATURE_LINE: "Signature=size=9000" }, "no 'Signature=adhoc' line"],
    // A substring check for the sandbox key would pass both of these.
    ["entitlements that flip the sandbox value", {
      STUB_ENTITLEMENTS: '<plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><true/></dict></plist>',
    }, "its entitlements differ from gui/src-tauri/entitlements.plist"],
    ["entitlements with an extra key", {
      STUB_ENTITLEMENTS: '<plist version="1.0"><dict><key>com.apple.security.app-sandbox</key><false/><key>com.apple.security.cs.disable-library-validation</key><true/></dict></plist>',
    }, "its entitlements differ from gui/src-tauri/entitlements.plist"],
    ["entitlements that are not a plist", { STUB_ENTITLEMENTS: "not a plist" }, "its entitlements are not a readable plist"],
    ["a bundle that fails --verify --deep --strict", { STUB_VERIFY_RC: "1" }, "--verify --deep --strict failed on the copied bundle"],
    ["an unsealed bundle", { STUB_TAURI_NO_SEAL: "1" }, "the bundle is not sealed"],
  ];
  for (const [what, env, why] of cases) {
    test(`${what} → step 8 FAIL, marker build-failed`, () => {
      const r = run(env);
      expectEngineDiscipline(r);
      expect(r.code).toBe(1);
      expect(r.status).toEqual({ ...ALL_PASS, "8": "FAIL", "9": "FAIL" });
      expect(r.out).toContain(why);
      expectCliOnlyRefused(r);
    });
  }
});

describe("verify-dist-local.sh: the image is detached whenever an attach was attempted", () => {
  test("a failed attach still gets the exit trap's forced detach (armed before the attach)", () => {
    const r = run({ STUB_ATTACH_RC: "1" });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "7": "FAIL", "8": "FAIL", "9": "FAIL" });
    expectCliOnlyRefused(r);
    const hd = called(r, "hdiutil").map((c) => c.replace(/ \S+\/mnt( |$)/, " <mnt>$1"));
    expect(hd[0]!).toStartWith("hdiutil attach ");
    expect(hd.slice(1)).toEqual(["hdiutil detach <mnt> -force"]);
    expect(r.err).not.toContain("could not detach");
  });

  test("a failed trap detach is reported only when hdiutil info still names the mount point", () => {
    const quiet = run({ STUB_ATTACH_RC: "1", STUB_DETACH_RC: "1" });
    expectEngineDiscipline(quiet);
    expect(called(quiet, "hdiutil info")).toHaveLength(1);
    expect(quiet.err).not.toContain("could not detach");
    const loud = run({ STUB_ATTACH_RC: "1", STUB_DETACH_RC: "1", STUB_INFO_LISTS_MNT: "1" });
    expectEngineDiscipline(loud);
    expect(loud.err).toContain("could not detach");
    expect(loud.err).toContain("/mnt");
  });
});

describe("verify-dist-local.sh: where the run directory may live", () => {
  const refused = (r: Run) => {
    expect(r.code).toBe(2);
    expect(r.err).toContain("inside the working tree");
    expect(r.calls).toEqual([]);
    expect(readdirSync(join(r.fx.repo, "dist"))).toEqual(["stray-build"]);
  };
  /** Refused by the `.git` ancestor walk (user-directed 2026-10-02: a `.git` entry in the parent or in any
   *  directory above it refuses), naming the entry it found, before anything ran or the run directory
   *  existed. `parent` and `dotGit` are canonical. */
  const refusedUnderGit = (r: Run, parent: string, dotGit: string) => {
    expect(r.code).toBe(2);
    expect(r.err).toContain(`and ${dotGit} exists at or above it`);
    expect(r.err).toContain("point VERIFY_DIST_TMPDIR at a directory with no .git at or above it");
    expect(r.calls).toEqual([]);
    expect(readdirSync(parent).filter((n) => n.startsWith("dba-verify-dist."))).toEqual([]);
  };
  /** Whether `p` names anything, a dangling symlink included. */
  const present = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };
  /** The worktree paths a `git worktree list --porcelain` names, canonical where they exist. */
  const listed = (cwd: string) => git(cwd, "worktree", "list", "--porcelain").split("\n")
    .filter((l) => l.startsWith("worktree ")).map((l) => l.slice("worktree ".length))
    .map((p) => (existsSync(p) ? realpathSync(p) : p));
  // The walk's positive control: a parent with no `.git` at or above it — the fixture's mktemp scratch,
  // which every passing case in this file uses — passes the whole run.
  test("a parent with no .git entry at or above it passes the whole run", () => {
    const r = run();
    const chain: string[] = [];
    for (let d = tmpP(r); ; d = dirname(d)) { chain.push(d); if (d === dirname(d)) break; }
    expect(chain.at(-1)).toBe("/");
    for (const d of chain) expect([d, present(join(d, ".git"))]).toEqual([d, false]);   // the premise
    expectEngineDiscipline(r);
    expect(`${r.code}\n${r.out}${r.err}`).toStartWith("0\n");
    expect(r.status).toEqual(ALL_PASS);
  });
  test("VERIFY_DIST_TMPDIR = the repo's dist/ is refused before anything runs", () => {
    refused(run({}, [], (f) => ({ VERIFY_DIST_TMPDIR: join(f.repo, "dist") })));
  });
  test("…and so is any directory inside the working tree", () => {
    refused(run({}, [], (f) => ({ VERIFY_DIST_TMPDIR: join(f.repo, "gui") })));
  });
  test("…and so is a symlink outside the tree that resolves into dist/ (the physical path is judged)", () => {
    refused(run({}, [], (f) => {
      const link = join(f.base, "innocent-tmp");
      symlinkSync(join(f.repo, "dist"), link);
      return { VERIFY_DIST_TMPDIR: link };
    }));
  });
  // Round 4 (A4-L2): judged by the CANONICAL path. bash's builtin `pwd -P` keeps a typed case variant and
  // the /System/Volumes/Data firmlink spelling, while git prints the canonical path, so the prefix test
  // missed both and the run went ahead inside the tree; /bin/pwd -P canonicalises them. These spellings
  // name the same directory only on a case-insensitive volume / under macOS's firmlink, so elsewhere
  // (the Linux runner) each case is skipped by a probe of this machine, never by platform name.
  test.skipIf(!CASE_FOLDS)("…and so is a case variant of a path inside the tree (a case-insensitive volume)", () => {
    refused(run({}, [], (f) => ({ VERIFY_DIST_TMPDIR: swapCase(realpathSync(join(f.repo, "dist"))) })));
  });
  test.skipIf(!FIRMLINKED)("…and so is the /System/Volumes/Data firmlink spelling of a path inside the tree", () => {
    refused(run({}, [], (f) => ({ VERIFY_DIST_TMPDIR: `${FIRMLINK}${realpathSync(join(f.repo, "dist"))}` })));
  });
  // git records a worktree as it was typed at `git worktree add` (measured, git 2.50), case variant included.
  test.skipIf(!CASE_FOLDS)("…and so is another worktree's dist/ when git recorded that worktree under a case variant", () => {
    const r = run({}, [], (f) => {
      git(f.repo, "worktree", "add", "-q", "--detach", join(swapCase(realpathSync(f.base)), "linked"));
      mkdirSync(join(f.base, "linked", "dist"));
      return { VERIFY_DIST_TMPDIR: join(realpathSync(f.base), "linked", "dist") };
    });
    // Non-vacuity: git really holds the variant spelling, which is what the builtin would have kept.
    expect(git(r.fx.repo, "worktree", "list", "--porcelain")).toContain(`worktree ${join(swapCase(realpathSync(r.fx.base)), "linked")}\n`);
    refused(r);
    expect(r.err).toContain(`inside the working tree ${join(realpathSync(r.fx.base), "linked")} (another worktree of this repository`);
    expect(readdirSync(join(r.fx.base, "linked", "dist"))).toEqual([]);
  });
  // Run from a LINKED worktree of the repo: the primary checkout is another working tree of it, and its
  // dist/ is refused as firmly as the linked tree's own.
  test("…and so is the PRIMARY checkout's dist/ when the script runs from a linked worktree", () => {
    const r = run({}, [], (f) => {
      git(f.repo, "worktree", "add", "-q", "--detach", join(f.base, "linked"));
      return { VERIFY_DIST_TMPDIR: join(f.repo, "dist") };
    }, (f) => join(f.base, "linked", "scripts", "verify-dist-local.sh"));
    refused(r);
    expect(r.err).toContain("this worktree's primary checkout");
    // Non-vacuity: the linked tree's own check did not catch it (the primary is outside the linked tree).
    expect(r.err).toContain(`inside the working tree ${realpathSync(r.fx.repo)} (this worktree's primary checkout`);
  });
  test("…while a parent outside both trees is accepted from a linked worktree (the whole run passes)", () => {
    const r = run({}, [], (f) => {
      const linked = join(f.base, "linked");
      git(f.repo, "worktree", "add", "-q", "--detach", linked);
      return { STUB_APP_SRC: join(linked, "gui", "src-tauri", "target", "release", "bundle", "macos", "Daily Briefing.app") };
    }, (f) => join(f.base, "linked", "scripts", "verify-dist-local.sh"));
    expectEngineDiscipline(r);
    expect(`${r.code}\n${r.out}${r.err}`).toStartWith("0\n");
    expect(r.status).toEqual(ALL_PASS);
  });
  // The trees are git's own record (`git worktree list`), not inferred from the git directory's name
  // (round 3, G3-2): every one is refused, the primary's view of its linked worktrees included.
  test("…and so is a LINKED worktree's dist/ when the script runs from the primary checkout", () => {
    const r = run({}, [], (f) => {
      const linked = join(f.base, "linked");
      git(f.repo, "worktree", "add", "-q", "--detach", linked);
      mkdirSync(join(linked, "dist"));
      return { VERIFY_DIST_TMPDIR: join(linked, "dist") };
    });
    refused(r);
    expect(r.err).toContain(`inside the working tree ${realpathSync(join(r.fx.base, "linked"))} (another worktree of this repository`);
  });
  test("…judged by the PHYSICAL path of the tree git records (a recorded path that is now a symlink)", () => {
    const r = run({}, [], (f) => {
      git(f.repo, "worktree", "add", "-q", "--detach", join(f.base, "wt2"));
      renameSync(join(f.base, "wt2"), join(f.base, "moved"));
      symlinkSync(join(f.base, "moved"), join(f.base, "wt2"));   // git still records …/wt2
      return { VERIFY_DIST_TMPDIR: join(f.base, "moved", "gui") };
    });
    refused(r);
    expect(r.err).toContain(`inside the working tree ${realpathSync(join(r.fx.base, "moved"))} (another worktree of this repository`);
  });
  // A SEPARATE git directory: git records the git directory itself as the primary entry and nothing about
  // the checkout that uses it (measured). From that checkout every linked tree is still refused and an
  // outside parent passes; from a linked worktree the primary cannot be located, so the run is refused.
  test("a separate-git-dir checkout: its linked worktree's dist/ is refused, an outside parent passes", () => {
    const sep = (f: Fx) => { git(f.repo, "init", "-q", "--separate-git-dir", join(f.base, "repo.gitdir")); };
    const refusedRun = run({}, [], (f) => {
      sep(f);
      const linked = join(f.base, "linked");
      git(f.repo, "worktree", "add", "-q", "--detach", linked);
      mkdirSync(join(linked, "dist"));
      return { VERIFY_DIST_TMPDIR: join(linked, "dist") };
    });
    expect(read(join(refusedRun.fx.repo, ".git"))).toStartWith("gitdir: ");   // non-vacuity: really separate
    refused(refusedRun);
    expect(refusedRun.err).toContain(`inside the working tree ${realpathSync(join(refusedRun.fx.base, "linked"))} (another worktree of this repository`);
    const passed = run({}, [], (f) => { sep(f); git(f.repo, "worktree", "add", "-q", "--detach", join(f.base, "linked")); });
    expectEngineDiscipline(passed);
    expect(`${passed.code}\n${passed.out}${passed.err}`).toStartWith("0\n");
    expect(passed.status).toEqual(ALL_PASS);
  });
  test("…while from a linked worktree of it the run is refused: its primary checkout cannot be located", () => {
    const r = run({}, [], (f) => {
      git(f.repo, "init", "-q", "--separate-git-dir", join(f.base, "repo.gitdir"));
      git(f.repo, "worktree", "add", "-q", "--detach", join(f.base, "linked"));
    }, (f) => join(f.base, "linked", "scripts", "verify-dist-local.sh"));
    expect(r.code).toBe(2);
    expect(r.err).toContain("this worktree's primary checkout cannot be located");
    expect(r.calls).toEqual([]);
    expect(readdirSync(r.fx.tmp)).toEqual([]);   // refused before the run directory existed
  });
  // …also when that git directory was named under a case variant: git hands its spellings back as typed,
  // so the record, the repository's git directory and this checkout's are told equal only canonically —
  // refused from the linked worktree, and still accepted from the checkout itself.
  test.skipIf(!CASE_FOLDS)("…also when that separate git directory was named under a case variant (and its own checkout still passes)", () => {
    const sepVariant = (f: Fx) => {
      git(f.repo, "init", "-q", "--separate-git-dir", join(swapCase(realpathSync(f.base)), "repo.gitdir"));
      git(f.repo, "worktree", "add", "-q", "--detach", join(f.base, "linked"));
    };
    const r = run({}, [], sepVariant, (f) => join(f.base, "linked", "scripts", "verify-dist-local.sh"));
    expect(read(join(r.fx.repo, ".git"))).toStartWith(`gitdir: ${swapCase(realpathSync(r.fx.base))}`);   // non-vacuity
    expect(r.code).toBe(2);
    expect(r.err).toContain("this worktree's primary checkout cannot be located");
    expect(r.calls).toEqual([]);
    expect(readdirSync(r.fx.tmp)).toEqual([]);
    const passed = run({}, [], sepVariant);
    expectEngineDiscipline(passed);
    expect(`${passed.code}\n${passed.out}${passed.err}`).toStartWith("0\n");
    expect(passed.status).toEqual(ALL_PASS);
  });
  // A BARE repository named `.git` has no working tree: its parent directory is nobody's checkout, and the
  // record and the parent-side probe both pass it. Until 2026-10-02 this case expected the whole run to
  // pass there; by the user's decision that day (any `.git` entry in the parent or above it refuses, a bare
  // repository named `.git` included) it is now REFUSED, by the ancestor walk. Run from the bare
  // repository's linked worktree with a parent elsewhere, the whole run still passes, and its other
  // worktree is still judged by the record.
  test("a bare repository named .git: its parent is refused (a .git entry there, user-directed 2026-10-02); its other worktree is too", () => {
    const bare = (f: Fx) => {
      git(f.base, "clone", "-q", "--bare", f.repo, join(f.base, "hub", ".git"));
      git(join(f.base, "hub", ".git"), "worktree", "add", "-q", "--detach", join(f.base, "hub-wt"));
    };
    const fromWt = (f: Fx) => join(f.base, "hub-wt", "scripts", "verify-dist-local.sh");
    const app = (f: Fx) => join(f.base, "hub-wt", "gui", "src-tauri", "target", "release", "bundle", "macos", "Daily Briefing.app");
    const atHub = run({}, [], (f) => { bare(f); return { VERIFY_DIST_TMPDIR: join(f.base, "hub"), STUB_APP_SRC: app(f) }; }, fromWt);
    const hub = realpathSync(join(atHub.fx.base, "hub"));
    // Premises (what the checks before the walk saw): git records the parent as a `bare` entry, which the
    // record judge skips, and git, asked from the parent, finds no working tree there.
    const [entry, kind] = git(join(atHub.fx.base, "hub-wt"), "worktree", "list", "--porcelain").split("\n");
    expect(realpathSync(entry!.slice("worktree ".length))).toBe(hub);
    expect(kind).toBe("bare");
    expect(gitProbe(hub, "rev-parse", "--is-inside-work-tree")).toEqual({ code: 0, out: "false\n", err: "" });
    refusedUnderGit(atHub, hub, join(hub, ".git"));
    const passed = run({}, [], (f) => { bare(f); return { STUB_APP_SRC: app(f) }; }, fromWt);
    expectEngineDiscipline(passed);
    expect(`${passed.code}\n${passed.out}${passed.err}`).toStartWith("0\n");
    expect(passed.status).toEqual(ALL_PASS);
    const sibling = run({}, [], (f) => {
      bare(f);
      git(join(f.base, "hub", ".git"), "worktree", "add", "-q", "--detach", join(f.base, "hub-wt2"));
      return { VERIFY_DIST_TMPDIR: join(f.base, "hub-wt2", "gui") };
    }, fromWt);
    refused(sibling);
    expect(sibling.err).toContain(`inside the working tree ${realpathSync(join(sibling.fx.base, "hub-wt2"))} (another worktree of this repository`);
  });
  // Round 5 (D5-M1): the trees git's record cannot show are caught from the PARENT's side — git, asked
  // from the parent, names this repository's common git directory. (1) A separate git directory literally
  // named `.git` (<D>/.git): git lists <D> as the primary entry and nothing about the real checkout
  // (measured, git 2.50.1), so from a linked worktree the record judged <D> and a parent inside the real
  // primary passed. The primary itself still passes.
  test("a separate git directory named .git: the real primary's dist/ is refused from a linked worktree; the primary itself still passes", () => {
    const sepDotGit = (f: Fx) => {
      mkdirSync(join(f.base, "store"));
      git(f.repo, "init", "-q", "--separate-git-dir", join(f.base, "store", ".git"));
      git(f.repo, "worktree", "add", "-q", "--detach", join(f.base, "linked"));
    };
    const r = run({}, [], (f) => { sepDotGit(f); return { VERIFY_DIST_TMPDIR: join(f.repo, "dist") }; },
      (f) => join(f.base, "linked", "scripts", "verify-dist-local.sh"));
    // Non-vacuity: from the linked worktree git's record names the store's directory, never the checkout.
    expect(read(join(r.fx.repo, ".git"))).toStartWith("gitdir: ");
    expect(listed(join(r.fx.base, "linked"))).toEqual([realpathSync(join(r.fx.base, "store")), realpathSync(join(r.fx.base, "linked"))]);
    refused(r);
    expect(r.err).toContain(`inside the working tree of a checkout of this repository that \`git worktree list\` does not show there (git, asked from the parent, names this repository's git directory ${realpathSync(join(r.fx.base, "store", ".git"))}`);
    const passed = run({}, [], sepDotGit);
    expectEngineDiscipline(passed);
    expect(`${passed.code}\n${passed.out}${passed.err}`).toStartWith("0\n");
    expect(passed.status).toEqual(ALL_PASS);
  });
  // (2) A linked worktree moved without `git worktree repair`: git records it where it no longer is
  // (`prunable`), so the record judge skips it — but it still exists, and still points at this repository.
  test("a linked worktree moved without repair: a parent inside it is refused", () => {
    const r = run({}, [], (f) => {
      git(f.repo, "worktree", "add", "-q", "--detach", join(f.base, "wt"));
      renameSync(join(f.base, "wt"), join(f.base, "moved"));
      mkdirSync(join(f.base, "moved", "dist"));
      return { VERIFY_DIST_TMPDIR: join(f.base, "moved", "dist") };
    });
    // Non-vacuity: git records only the old, now missing path (prunable), nothing at the new one.
    expect(git(r.fx.repo, "worktree", "list", "--porcelain")).toContain("\nprunable ");
    const paths = listed(r.fx.repo);
    expect(paths).toHaveLength(2);
    expect(paths[1]!).toEndWith("/wt");
    expect(paths.some((p) => p.endsWith("/moved"))).toBe(false);
    refused(r);
    expect(r.err).toContain("that `git worktree list` does not show there");
    expect(readdirSync(join(r.fx.base, "moved", "dist"))).toEqual([]);
  });
  // Cap round (C-1, C-2; the cold verifier's CV-L2): a moved, unrepaired worktree that the record AND the
  // probe both pass — the probe because git's discovery from the parent fails (C-1) or stops at a nearer
  // repository (C-2). Each premise below is what those checks saw; the `.git` ancestor walk refuses all
  // three (user-directed 2026-10-02).
  const moveWorktree = (f: Fx) => {
    git(f.repo, "worktree", "add", "-q", "--detach", join(f.base, "wt"));
    renameSync(join(f.base, "wt"), join(f.base, "moved"));
  };
  test.skipIf(process.getuid?.() === 0)("C-1: a moved, unrepaired worktree whose .git file is unreadable is refused (git's discovery from the parent fails)", () => {
    const r = run({}, [], (f) => {
      moveWorktree(f);
      mkdirSync(join(f.base, "moved", "dist"));
      chmodSync(join(f.base, "moved", ".git"), 0o000);
      return { VERIFY_DIST_TMPDIR: join(f.base, "moved", "dist") };
    });
    const moved = realpathSync(join(r.fx.base, "moved"));
    try {
      // Premises: git records only the old, missing path (prunable), nothing at the new one …
      expect(git(r.fx.repo, "worktree", "list", "--porcelain")).toContain("\nprunable ");
      expect(listed(r.fx.repo).includes(moved)).toBe(false);
      // … and git, asked from the parent, cannot open the tree's .git file, so the probe saw no tree.
      const probe = gitProbe(join(moved, "dist"), "rev-parse", "--is-inside-work-tree");
      expect(probe.code).not.toBe(0);
      expect(probe.err).toContain(`'${join(moved, ".git")}': Permission denied`);
    } finally {
      chmodSync(join(moved, ".git"), 0o644);
    }
    refusedUnderGit(r, join(moved, "dist"), join(moved, ".git"));
  });
  test("C-1: a moved worktree whose admin directory was then pruned is refused (git no longer lists it; discovery fails)", () => {
    const r = run({}, [], (f) => {
      moveWorktree(f);
      git(f.repo, "worktree", "prune");
      mkdirSync(join(f.base, "moved", "dist"));
      return { VERIFY_DIST_TMPDIR: join(f.base, "moved", "dist") };
    });
    const moved = realpathSync(join(r.fx.base, "moved"));
    // Premises: git lists the primary checkout alone; the tree still carries its .git file, which now
    // points at an admin directory that is gone, so git, asked from the parent, finds no repository.
    expect(listed(r.fx.repo)).toEqual([realpathSync(r.fx.repo)]);
    expect(read(join(moved, ".git"))).toStartWith("gitdir: ");
    const probe = gitProbe(join(moved, "dist"), "rev-parse", "--is-inside-work-tree");
    expect(probe.code).not.toBe(0);
    expect(probe.err).toContain("not a git repository");
    refusedUnderGit(r, join(moved, "dist"), join(moved, ".git"));
  });
  test("C-2: an unrelated repository initialised inside a moved, unrepaired worktree is refused (discovery stops at it)", () => {
    const r = run({}, [], (f) => {
      moveWorktree(f);
      mkdirSync(join(f.base, "moved", "inner", "x"), { recursive: true });
      git(join(f.base, "moved", "inner"), "init", "-q");
      return { VERIFY_DIST_TMPDIR: join(f.base, "moved", "inner", "x") };
    });
    const moved = realpathSync(join(r.fx.base, "moved"));
    // Premises: git records only the old, missing path (prunable) …
    expect(git(r.fx.repo, "worktree", "list", "--porcelain")).toContain("\nprunable ");
    expect(listed(r.fx.repo).includes(moved)).toBe(false);
    // … and git, asked from the parent, names the nested repository, not this one, so the probe passed it.
    expect(gitProbe(join(moved, "inner", "x"), "rev-parse", "--path-format=absolute", "--git-common-dir"))
      .toEqual({ code: 0, out: `${join(moved, "inner", ".git")}\n`, err: "" });
    expect(present(join(moved, ".git"))).toBe(true);   // the containing worktree's own .git, further up
    refusedUnderGit(r, join(moved, "inner", "x"), join(moved, "inner", ".git"));   // the nearest is named
  });
  // A `.git` that is a symlink, dangling, several directories above the parent: git's discovery skips it
  // (it finds no repository there), and the walk still refuses — `[ -e ] || [ -L ]`, up to /.
  test("a dangling .git symlink three directories above the parent is refused", () => {
    const r = run({}, [], (f) => {
      mkdirSync(join(f.base, "odd", "a", "b", "c"), { recursive: true });
      symlinkSync(join(f.base, "no-such-target"), join(f.base, "odd", ".git"));
      return { VERIFY_DIST_TMPDIR: join(f.base, "odd", "a", "b", "c") };
    });
    const odd = realpathSync(join(r.fx.base, "odd"));
    expect(existsSync(join(odd, ".git"))).toBe(false);   // premise: dangling
    expect(present(join(odd, ".git"))).toBe(true);
    expect(gitProbe(join(odd, "a", "b", "c"), "rev-parse", "--is-inside-work-tree").code).not.toBe(0);
    refusedUnderGit(r, join(odd, "a", "b", "c"), join(odd, ".git"));
  });
  // A parent inside ANOTHER repository's working tree is not this repository's, and the record and the
  // probe both pass it. Until 2026-10-02 this case expected the whole run to pass there; by the user's
  // decision that day (any `.git` entry in the parent or above it refuses, whoever's repository it is) it
  // is now REFUSED, by the ancestor walk.
  test("a parent inside an unrelated repository's working tree is refused (a .git above it, user-directed 2026-10-02)", () => {
    const r = run({}, [], (f) => {
      mkdirSync(join(f.base, "other", "x"), { recursive: true });
      git(join(f.base, "other"), "init", "-q");
      return { VERIFY_DIST_TMPDIR: join(f.base, "other", "x") };
    });
    const other = realpathSync(join(r.fx.base, "other"));
    // Premises: git, asked from that parent, finds a working tree there — another repository's, so the
    // probe passed it.
    expect(git(join(other, "x"), "rev-parse", "--is-inside-work-tree").trim()).toBe("true");
    expect(gitProbe(join(other, "x"), "rev-parse", "--path-format=absolute", "--git-common-dir"))
      .toEqual({ code: 0, out: `${join(other, ".git")}\n`, err: "" });
    refusedUnderGit(r, join(other, "x"), join(other, ".git"));
  });
  // The probe is asked with none of this environment's GIT_* overrides: with GIT_DIR exported (as git
  // exports it to a hook), git would place ANY parent in a working tree of this repository.
  test("an exported GIT_DIR does not make the parent-side check refuse an outside parent (the whole run passes)", () => {
    const r = run({}, [], (f) => ({ GIT_DIR: join(f.repo, ".git") }));
    expectEngineDiscipline(r);
    expect(`${r.code}\n${r.out}${r.err}`).toStartWith("0\n");
    expect(r.status).toEqual(ALL_PASS);
  });
  // …while a parent in a working tree whose git directory git cannot name is refused, like the other lookups.
  test("a parent inside a working tree whose git directory git cannot name is refused", () => {
    const r = run({}, [], (f) => {
      mkdirSync(join(f.base, "other", "x"), { recursive: true });
      git(join(f.base, "other"), "init", "-q");
      const parent = realpathSync(join(f.base, "other", "x"));
      const wrap = join(f.base, "git-wrap");
      mkdirSync(wrap);
      // Only the probe from that parent fails: this repository's own lookups still answer.
      writeFileSync(join(wrap, "git"), `#!/bin/sh\nif [ "$1 $2" = "-C ${parent}" ]; then for a in "$@"; do [ "$a" = --git-common-dir ] && exit 128; done; fi\nexec "${GIT}" "$@"\n`, { mode: 0o755 });
      return { VERIFY_DIST_TMPDIR: join(f.base, "other", "x"), PATH: `${wrap}:${stubs().bin}:${dirname(GIT)}:/usr/bin:/bin` };
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("inside a working tree whose git directory git could not name");
    expect(r.calls).toEqual([]);
    expect(readdirSync(join(r.fx.base, "other", "x"))).toEqual([]);
  });
  test("a git that cannot list the worktrees refuses the run (it cannot prove the parent outside them)", () => {
    const r = run({}, [], (f) => {
      const wrap = join(f.base, "git-wrap");
      mkdirSync(wrap);
      writeFileSync(join(wrap, "git"), `#!/bin/sh\nfor a in "$@"; do [ "$a" = worktree ] && exit 128; done\nexec "${GIT}" "$@"\n`, { mode: 0o755 });
      return { PATH: `${wrap}:${stubs().bin}:${dirname(GIT)}:/usr/bin:/bin` };
    });
    expect(r.code).toBe(2);
    expect(r.err).toContain("git worktree list failed");
    expect(r.calls).toEqual([]);
  });
  // Round 4 (G4-1): so does a git that cannot NAME this repository's git directories. A failed or empty
  // lookup used to skip the whole worktree guard; each case puts the parent inside a LINKED worktree's
  // dist/, which only that guard can see, so a skipped guard would have let the run go ahead in there.
  test("a git-dir or common-dir lookup that fails, prints nothing, or comes from a git without --path-format refuses the run", () => {
    const cases: [string, string][] = [];
    for (const flag of ["--git-dir", "--git-common-dir"]) {
      for (const [name, answer] of [["fails", 'echo "fatal: stub lookup failure" >&2; exit 128'], ["prints nothing", "exit 0"]]) {
        cases.push([`${flag} ${name}`, `#!/bin/sh\nfor a in "$@"; do [ "$a" = ${flag} ] && { ${answer}; }; done\nexec "${GIT}" "$@"\n`]);
      }
    }
    // A git older than 2.31 does not know --path-format: rev-parse prints an option it does not recognise
    // back on a line of its own (measured with an unknown option, git 2.50), then the path, relative here.
    cases.push(["no --path-format", [
      "#!/bin/sh",
      'case " $* " in *" --path-format=absolute "*)',
      "  printf '%s\\n' --path-format=absolute",
      '  for a in "$@"; do shift; [ "$a" = --path-format=absolute ] || set -- "$@" "$a"; done ;;',
      "esac",
      `exec "${GIT}" "$@"`,
      "",
    ].join("\n")]);
    for (const [name, wrapper] of cases) {
      const r = run({}, [], (f) => {
        const linked = join(f.base, "linked");
        git(f.repo, "worktree", "add", "-q", "--detach", linked);
        mkdirSync(join(linked, "dist"));
        const wrap = join(f.base, "git-wrap");
        mkdirSync(wrap);
        writeFileSync(join(wrap, "git"), wrapper, { mode: 0o755 });
        return { VERIFY_DIST_TMPDIR: join(linked, "dist"), PATH: `${wrap}:${stubs().bin}:${dirname(GIT)}:/usr/bin:/bin` };
      });
      expect(`${name}: ${r.code}`).toBe(`${name}: 2`);
      expect(`${name}: ${r.err}`).toContain(`${name}: verify-dist-local: git could not name this repository's git directory as an absolute path`);
      expect(r.calls).toEqual([]);
      expect(readdirSync(join(r.fx.base, "linked", "dist"))).toEqual([]);   // no run directory was made
    }
  });
  // …and so does a copy that is not a git checkout at all: there is no repository to name, and step 12
  // could never pass there anyway (it needs `git diff HEAD`), so it is refused before anything runs.
  test("a project that is not a git checkout is refused before anything runs", () => {
    const r = run({}, [], (f) => { rmSync(join(f.repo, ".git"), { recursive: true, force: true }); });
    expect(existsSync(join(r.fx.repo, ".git"))).toBe(false);   // non-vacuity
    expect(r.code).toBe(2);
    expect(r.err).toContain("git could not name this repository's git directory as an absolute path");
    expect(r.calls).toEqual([]);
    expect(readdirSync(r.fx.tmp)).toEqual([]);
  });
  test("a parent that does not exist is refused before anything runs", () => {
    const r = run({}, [], (f) => ({ VERIFY_DIST_TMPDIR: join(f.base, "no-such-dir") }));
    expect(r.code).toBe(2);
    expect(r.err).toContain("the run-directory parent");
    expect(r.err).toContain("does not exist");
    expect(r.calls).toEqual([]);
    expect(existsSync(join(r.fx.base, "no-such-dir"))).toBe(false);
  });
});

describe("verify-dist-local.sh: the tracked-file snapshot", () => {
  // The BEFORE snapshot fails (a corrupt index: HEAD still resolves, `git diff HEAD` does not): step 12
  // fails, naming it, rather than comparing an empty digest with another.
  test("a git diff that fails BEFORE the run fails the last step, naming the before-run snapshot", () => {
    const r = run({}, [], (f) => { writeFileSync(join(f.repo, ".git", "index"), "garbage\n"); });
    expectEngineDiscipline(r);
    expect(r.code).toBe(1);
    expect(r.status).toEqual({ ...ALL_PASS, "12": "FAIL" });
    expect(r.out).toContain("the before-run snapshot (git diff HEAD) failed");
  });
});

describe("verify-dist-local.sh: an all-PASS run whose run directory cannot be removed", () => {
  test.skipIf(process.getuid?.() === 0)("exits 1 and says so", () => {
    const r = run({ STUB_LOCK_RUNDIR: "1" });
    try {
      expectEngineDiscipline(r);
      expect(r.status).toEqual(ALL_PASS);
      expect(r.code).toBe(1);
      expect(r.err).toContain("removing the run directory");
    } finally {
      for (const d of readdirSync(r.fx.tmp)) chmodSync(join(r.fx.tmp, d, "locked"), 0o755);
    }
  });
});

describe("verify-dist-local.sh: arguments and the never-open rule", () => {
  test("it takes no arguments", () => {
    const r = run({}, ["0.2.0"]);
    expectEngineDiscipline(r);
    expect(r.code).toBe(2);
    expect(r.err).toContain("usage:");
    expect(r.calls).toEqual([]);
  });

  // Command position: line start, after a separator, `!`, `$(` or an opening bracket/backtick (\x60),
  // after a `-c` flag (a shell's command string), clustered flags included (`-lc`, `-ec`, `-xc`, `-cx`) —
  // except grep's own `-c` (a count, so `grep -c open file` is a pattern, not a command) — after
  // `osascript … -e` and then any quote (an AppleScript string, typically `do shell script "…"`), or after
  // a keyword or wrapper that runs the next word as a command (its options — `-x value` pairs included —
  // VAR=value assignments and numeric arguments skipped); any path prefix. Quoting directly around the
  // name counts only in those positions — up to two quote characters, each possibly backslash-escaped,
  // after an optional `$` (a `-c` operand nests them: `"'open' x"`, `$'open x'`, `"\"open\" x"`; round 3,
  // G3-5) — so `"open" x` at a line start is caught while a quoted phrase in prose (`note "security
  // matters"`) is not.
  const COMMAND_USE =
    /(?:^\s*|[;&|({\x60!]\s*|\$\(\s*|(?<!\b[ef]?grep(?:\s+-\S+)*)\s-[A-Za-z]*c[A-Za-z]*\s+|\bosascript\b.*\s-e\s+.*['"]|\b(?:if|while|until|then|do|else|elif|eval|exec|xargs|env|command|nohup|sudo|time|timeout|builtin)\s+(?:(?:-\w\s+(?!-)\S+|-\S+|\w+=\S*|\d[\w.]*)\s+)*)(?:\$(?=['"]))?(?:\\?['"]){0,2}(?:[\w.-]*\/)*(?:open|lsregister|launchctl|security)(?=(?:\\?['"]){0,2}(?:\s|$|[;&|)]))/;
  const invokes = (line: string) => COMMAND_USE.test(line) || /lsregister/.test(line);

  test("the command-position scan catches every prefix it claims to, and not prose", () => {
    for (const bad of [
      "open x", "  open x", "a; open x", "a && open x", "a | xargs open", "$(open x)", "if a; then open x; fi",
      "for f in a; do open \"$f\"; done", "else open x", "exec open x", "env open x", "env -i open x",
      "command open x", "nohup open x &", "/usr/bin/open x", "x=$(/usr/bin/open -a y)",
      "do launchctl list", "then /bin/launchctl unload x", "elif security find-identity",
      "exec /usr/bin/security find-generic-password", "x /System/Library/lsregister -f y",
      "if open x; then :; fi", "while open x; do :; done", "until open x; do :; done", "! open x", "eval open x",
      "\"open\" x", "'open' x", "bash -c 'open x'", "env A=1 open x", "timeout 5 open x",
      // Wrappers with option ARGUMENTS: the argument is skipped with its option.
      "env -u A open x", "sudo -u root open x", "timeout -s KILL 5 open x", "timeout 5s open x",
      // (Two probes are split by concatenation: test/isolation.meta.test.ts reads a quote as command position.)
      "sudo -u root /usr/bin/security list-keychains", "sh -c \"launch" + "ctl list\"", "a; \"open\" x",
      // A shell's -c inside a flag cluster, and an AppleScript string (round 2: round 1's `\s-c\s+` missed
      // all four, which the pre-round-1 any-quote rule had caught).
      "bash -lc 'open x'", "sh -ec \"launch" + "ctl list\"", "zsh -xc 'sec" + "urity find-identity'",
      "osascript -e 'do shell script \"open x\"'", "bash -cx 'open x'", "/bin/bash -l -c 'open x'",
      // A -c operand that nests or ANSI-C/locale-quotes the command word (round 3, G3-5: the single
      // optional quote missed all eight).
      "bash -lc \"'open' x\"", "bash -lc $'open x'", "bash -c $\"open x\"", "bash -c \"\\\"open\\\" x\"",
      "bash -c \"'open'\"", "sh -c $'launch" + "ctl list'", "zsh -c \"'sec" + "urity find-identity'\"",
      "bash -lc \"'/usr/bin/open' x\"",
    ]) expect([bad, invokes(bad)]).toEqual([bad, true]);
    for (const ok of [
      "hdiutil attach x -nobrowse -noautoopen -readonly", "echo opened", "note \"the .app is never opened\"",
      "com.apple.security.app-sandbox", "x/opener", "reopen x",
      // Quoted prose that merely starts with a watched word is not a command.
      "note \"sec" + "urity matters\"", "echo \"open the app yourself\"", "note 'open questions remain'",
      // grep's -c is a count: the next word is its pattern.
      "grep -c open file", "grep -i -c open file", "grep -ic open file",
      // …and stays prose or a pattern under the nested and `$'…'` quoting a -c operand may carry.
      "note $'open questions remain'", "echo \"'open' is a verb\"", "grep -c $'open' file", "grep -c \"'open'\" file",
      "echo $open", "x=$opener",
    ]) expect([ok, invokes(ok)]).toEqual([ok, false]);
  });

  test("no line of the script invokes open, lsregister, launchctl or security (the .app is never launched or registered, R10)", () => {
    const code = read(SCRIPT).split("\n").filter((l) => !/^\s*#/.test(l));
    expect(code.length).toBeGreaterThan(200);
    expect(code.filter(invokes)).toEqual([]);
  });
});
