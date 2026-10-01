// test/release-collect.test.ts — scripts/release-collect.sh (Phase E, E3): the release job's last gate.
//
// Every branch of the bundle-status contract (docs/RELEASE.md §Assets) is exercised over a fake
// `dist/` + `markers/` pair in a temp dir. The script fails closed, so most tests assert a FAIL; each
// one also asserts that a failed collect wrote neither SHA256SUMS nor the notes, so a later step can
// never mistake a refused release for a finished one.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = resolve(import.meta.dir, "..");
const COLLECT = join(ROOT, "scripts", "release-collect.sh");
const V = "0.2.0";

const CLI = [
  "daily-briefing-darwin-arm64", "daily-briefing-darwin-x64", "daily-briefing-linux-x64",
  "daily-briefing-linux-arm64", "daily-briefing-windows-x64.exe",
];
const LEG_FILES: Record<string, string[]> = {
  "macos-arm64": [`daily-briefing-${V}-darwin-arm64.dmg`],
  "macos-x64": [`daily-briefing-${V}-darwin-x64.dmg`],
  "linux-x86_64": [`daily-briefing-${V}-linux-x86_64.AppImage`, `daily-briefing_${V}_amd64.deb`],
};
const ALL_BUILT = { "macos-arm64": "built\n", "macos-x64": "built\n", "linux-x86_64": "built\n", "windows-x64": "built\n" };

interface Fixture { base: string; dist: string; markers: string; notes: string }

/** A dist holding the CLI floor plus the files of every leg in `withFiles`, and a markers dir holding
 *  `markers` (leg -> exact body). `markers: null` leaves the markers directory absent. */
function fixture(opts: { markers?: Record<string, string> | null; withFiles?: string[]; extra?: string[] } = {}): Fixture {
  const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-collect-")));
  const dist = join(base, "dist");
  const markers = join(base, "markers");
  mkdirSync(dist);
  const withFiles = opts.withFiles ?? Object.keys(LEG_FILES);
  for (const n of [...CLI, ...withFiles.flatMap((l) => LEG_FILES[l] ?? []), ...(opts.extra ?? [])]) {
    writeFileSync(join(dist, n), `bytes of ${n}\n`);
  }
  const m = opts.markers === undefined ? ALL_BUILT : opts.markers;
  if (m !== null) {
    mkdirSync(markers);
    for (const [leg, body] of Object.entries(m)) writeFileSync(join(markers, `${leg}.status`), body);
  }
  return { base, dist, markers, notes: join(base, "notes.md") };
}

function collect(f: Fixture, over: { signing?: string; dl?: string; version?: string; notes?: string; env?: Record<string, string> } = {}) {
  const r = Bun.spawnSync(
    ["bash", COLLECT, f.dist, f.markers, over.version ?? V, over.signing ?? "unsigned", over.dl ?? "success", over.notes ?? f.notes],
    { env: { ...process.env, ...(over.env ?? {}) }, stdout: "pipe", stderr: "pipe" },
  );
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

/** A refused collect: non-zero, the stderr names `why`, and nothing was written. */
function expectRefused(f: Fixture, r: { code: number; err: string }, why: RegExp) {
  expect(`${r.code}\n${r.err}`).toMatch(new RegExp(`^1\\n[\\s\\S]*${why.source}`));
  expect(existsSync(join(f.dist, "SHA256SUMS"))).toBe(false);
  expect(existsSync(f.notes)).toBe(false);
}

const sha256 = (p: string) => new Bun.CryptoHasher("sha256").update(readFileSync(p)).digest("hex");

/** A PATH directory holding only the tools the script needs — sha256sum deliberately left out. */
function toolBin(base: string): string {
  const bin = join(base, "bin");
  mkdirSync(bin);
  for (const tool of ["bash", "dirname", "basename", "grep", "cat", "awk", "mktemp", "mv", "rm", "ls", "sort", "wc", "tr", "shasum"]) {
    const w = Bun.spawnSync(["/bin/sh", "-c", `command -v ${tool}`], { env: { ...process.env }, stdout: "pipe" }).stdout.toString().trim();
    expect(w, `${tool} is on PATH`).toStartWith("/");
    symlinkSync(w, join(bin, tool));
  }
  return bin;
}

/** Every entry in a directory, hidden ones included, sorted. */
const entries = (dir: string) => readdirSync(dir).sort();

describe("release-collect.sh — the passing release", () => {
  test("all legs built: SHA256SUMS lists every other asset once, bare basenames, C-sorted, self-excluded", () => {
    const f = fixture();
    const r = collect(f);
    expect(`${r.code}\n${r.err}`).toBe("0\n");
    const lines = readFileSync(join(f.dist, "SHA256SUMS"), "utf8").trimEnd().split("\n");
    const names = lines.map((l) => l.replace(/^[0-9a-f]{64} {2}/, ""));
    const expected = [...CLI, ...Object.values(LEG_FILES).flat()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    expect(names).toEqual(expected);                       // each once, sorted byte-wise, no SHA256SUMS
    for (const l of lines) {
      const [hash, name] = [l.slice(0, 64), l.slice(66)];
      expect(name).not.toContain("/");
      expect(hash).toBe(sha256(join(f.dist, name)));
    }
  });

  test("`shasum -a 256 -c SHA256SUMS` passes inside the dist", () => {
    const f = fixture();
    expect(collect(f).code).toBe(0);
    const c = Bun.spawnSync(["shasum", "-a", "256", "-c", "SHA256SUMS"], { cwd: f.dist, env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    expect(`${c.exitCode}\n${c.stderr}`).toBe("0\n");
    expect(c.stdout.toString().trimEnd().split("\n").every((l) => l.endsWith(": OK"))).toBe(true);
  });

  // Only meaningful where sha256sum exists: fixture `a` must have used it for the comparison to be
  // sha256sum-vs-shasum. Without it both runs use shasum and the equality would pass vacuously, so the
  // test is SKIPPED (visibly) rather than passed.
  test.skipIf(!Bun.which("sha256sum"))("without sha256sum on PATH it falls back to `shasum -a 256`, byte-identical output (skipped where sha256sum is absent: the comparison would be shasum vs shasum)", () => {
    const a = fixture();
    expect(collect(a).code).toBe(0);
    // A PATH holding only the tools the script needs, with sha256sum deliberately left out.
    const bin = toolBin(a.base);
    const b = fixture();
    const r = collect(b, { env: { PATH: bin } });
    expect(`${r.code}\n${r.err}`).toBe("0\n");
    expect(readFileSync(join(b.dist, "SHA256SUMS"), "utf8")).toBe(readFileSync(join(a.dist, "SHA256SUMS"), "utf8"));
  });

  test("a stale SHA256SUMS already in dist is replaced, never listed", () => {
    const f = fixture({ extra: ["SHA256SUMS"] });
    expect(collect(f).code).toBe(0);
    const sums = readFileSync(join(f.dist, "SHA256SUMS"), "utf8");
    expect(sums).not.toContain("SHA256SUMS");
    expect(sums.trimEnd().split("\n")).toHaveLength(CLI.length + 4);
  });

  test("unsigned notes: the banner, the re-grant disclosure, verify instruction, Gatekeeper copy, assets listed apart", () => {
    const f = fixture();
    expect(collect(f, { signing: "unsigned" }).code).toBe(0);
    const n = readFileSync(f.notes, "utf8");
    expect(n).toContain("UNSIGNED (ad-hoc) RELEASE");
    expect(n).toMatch(/each app update needs the macOS folder-access grant again/);
    expect(n).toMatch(/shasum -a 256 -c SHA256SUMS/);
    expect(n).toMatch(/Privacy & Security[\s\S]*Open Anyway/);
    expect(n).toMatch(/xattr -dr com\.apple\.quarantine/);
    expect(n).toContain(`# daily-briefing v${V}`);
    // CLI binaries and desktop bundles in separate sections, each asset under its own heading.
    const cli = n.indexOf("## Command-line binaries"), desk = n.indexOf("## Desktop app");
    expect(cli).toBeGreaterThan(-1);
    expect(desk).toBeGreaterThan(cli);
    for (const c of CLI) { const i = n.indexOf(`\`${c}\``); expect(i).toBeGreaterThan(cli); expect(i).toBeLessThan(desk); }
    for (const d of Object.values(LEG_FILES).flat()) expect(n.indexOf(`\`${d}\``)).toBeGreaterThan(desk);
    expect(n).not.toContain("{{");
    expect(n).not.toContain("<!--");
    expect(n).not.toMatch(/Not in this release/);
  });

  test("signed notes: no banner, no re-grant disclosure, the signed status", () => {
    const f = fixture();
    expect(collect(f, { signing: "signed" }).code).toBe(0);
    const n = readFileSync(f.notes, "utf8");
    expect(n).not.toContain("UNSIGNED");
    expect(n).not.toMatch(/folder-access grant again/);
    expect(n).toMatch(/\*\*Signing:\*\* signed with the project's stable self-signed release identity/);
    expect(n).toMatch(/Open Anyway/);                       // not notarized either way
    expect(n).not.toContain("{{");
  });

  test("a build-failed leg with its files absent passes, and the notes name it", () => {
    const f = fixture({ markers: { ...ALL_BUILT, "macos-x64": "build-failed\n" }, withFiles: ["macos-arm64", "linux-x86_64"] });
    const r = collect(f);
    expect(`${r.code}\n${r.err}`).toBe("0\n");
    const n = readFileSync(f.notes, "utf8");
    expect(n).toMatch(/Not in this release[\s\S]*macOS Intel DMG \(`macos-x64`\)/);
    expect(n).not.toContain(`daily-briefing-${V}-darwin-x64.dmg`);
  });

  test("every required leg build-failed: the CLI floor still ships, even after a failed bundle download", () => {
    const f = fixture({ markers: { "macos-arm64": "build-failed\n", "macos-x64": "build-failed\n", "linux-x86_64": "build-failed\n" }, withFiles: [] });
    const r = collect(f, { dl: "failure" });
    expect(`${r.code}\n${r.err}`).toBe("0\n");
    const n = readFileSync(f.notes, "utf8");
    expect(n).toContain("No desktop bundle built for this release.");
    for (const leg of ["macos-arm64", "macos-x64", "linux-x86_64"]) expect(n).toContain(`(\`${leg}\`)`);
    expect(readFileSync(join(f.dist, "SHA256SUMS"), "utf8").trimEnd().split("\n")).toHaveLength(CLI.length);
  });

  test("the windows marker is informational: absent, build-failed, or garbage never fails", () => {
    for (const w of [undefined, "build-failed\n", "garbage", "size-rejected\n"]) {
      const m: Record<string, string> = { "macos-arm64": "built\n", "macos-x64": "built\n", "linux-x86_64": "built\n" };
      if (w !== undefined) m["windows-x64"] = w;
      const f = fixture({ markers: m });
      const r = collect(f);
      expect(`${JSON.stringify(w)} -> ${r.code} ${r.err}`).toBe(`${JSON.stringify(w)} -> 0 `);
      expect(readFileSync(f.notes, "utf8")).toMatch(/no Windows desktop installer in this release \(the informational CI build/);
    }
  });
});

describe("release-collect.sh — the marker contract refuses", () => {
  test("a required marker absent", () => {
    const { "linux-x86_64": _, ...rest } = ALL_BUILT;
    const f = fixture({ markers: rest, withFiles: ["macos-arm64", "macos-x64"] });
    expectRefused(f, collect(f), /linux-x86_64: required marker linux-x86_64\.status is absent/);
  });

  test("the markers directory absent: every required marker is absent", () => {
    const f = fixture({ markers: null });
    const r = collect(f);
    expectRefused(f, r, /macos-arm64: required marker/);
    expect(r.err).toMatch(/macos-x64: required marker/);
    expect(r.err).toMatch(/linux-x86_64: required marker/);
  });

  test("a body that is not exactly one token and a newline", () => {
    for (const body of ["ok\n", "built", "built \n", "built\nbuilt\n", "BUILT\n", "\n", ""]) {
      const f = fixture({ markers: { ...ALL_BUILT, "macos-arm64": body } });
      expectRefused(f, collect(f), /macos-arm64: marker body is not exactly one of/);
    }
  });

  test("size-rejected", () => {
    const f = fixture({ markers: { ...ALL_BUILT, "linux-x86_64": "size-rejected\n" }, withFiles: ["macos-arm64", "macos-x64"] });
    expectRefused(f, collect(f), /linux-x86_64: the bundle exceeded its size budget/);
  });

  test("built with no bundle in dist", () => {
    const f = fixture({ withFiles: ["macos-arm64", "linux-x86_64"] });
    expectRefused(f, collect(f), /macos-x64: marker says built but dist\/daily-briefing-0\.2\.0-darwin-x64\.dmg is missing/);
  });

  test("built Linux with only half its bundle (the .deb missing)", () => {
    const f = fixture({ withFiles: ["macos-arm64", "macos-x64"], extra: [`daily-briefing-${V}-linux-x86_64.AppImage`] });
    expectRefused(f, collect(f), /linux-x86_64: marker says built but dist\/daily-briefing_0\.2\.0_amd64\.deb is missing/);
  });

  test("build-failed while that leg's files are present", () => {
    const f = fixture({ markers: { ...ALL_BUILT, "macos-arm64": "build-failed\n" } });
    expectRefused(f, collect(f), /macos-arm64: marker says build-failed but dist\/daily-briefing-0\.2\.0-darwin-arm64\.dmg is present/);
  });

  test("a bundle download that did not succeed while a marker says built", () => {
    for (const dl of ["failure", "cancelled", "skipped"]) {
      const f = fixture();
      expectRefused(f, collect(f, { dl }), new RegExp(`outcome is '${dl}' while a marker says built`));
    }
  });

  test("a download outcome that is not a step outcome (an empty expression)", () => {
    const f = fixture();
    expectRefused(f, collect(f, { dl: "" }), /bundle download outcome '' is not a step outcome/);
  });

  test("a file in markers/ that is not a known leg's marker", () => {
    const f = fixture({ markers: { ...ALL_BUILT, "macos-universal": "built\n" } });
    expectRefused(f, collect(f), /markers\/macos-universal\.status is not a marker of a known leg/);
  });
});

describe("release-collect.sh — the attach set and arguments refuse", () => {
  test("a stray file in dist, named", () => {
    const f = fixture({ extra: ["notes.md"] });
    expectRefused(f, collect(f), /dist\/notes\.md is not a frozen release asset name/);
  });

  test("a hidden stray file in dist", () => {
    const f = fixture({ extra: [".DS_Store"] });
    expectRefused(f, collect(f), /dist\/\.DS_Store is not a frozen release asset name/);
  });

  test("a frozen name for ANOTHER version", () => {
    const f = fixture({ extra: ["daily-briefing-0.1.9-darwin-arm64.dmg"] });
    expectRefused(f, collect(f), /dist\/daily-briefing-0\.1\.9-darwin-arm64\.dmg is not a frozen release asset name/);
  });

  test("a subdirectory in dist (dist must be flat)", () => {
    const f = fixture();
    mkdirSync(join(f.dist, "bundle-macos-arm64"));
    expectRefused(f, collect(f), /dist\/bundle-macos-arm64 is not a regular file/);
  });

  test("a symlink in dist", () => {
    const f = fixture();
    symlinkSync(join(f.dist, CLI[0]!), join(f.dist, "link"));
    expectRefused(f, collect(f), /dist\/link is not a regular file/);
  });

  test("a Windows installer (C3): *setup*.exe and *.msi", () => {
    for (const n of ["Daily Briefing_0.2.0_x64-setup.exe", "daily-briefing.msi"]) {
      const f = fixture({ extra: [n] });
      expectRefused(f, collect(f), /is a Windows installer — the NSIS build is never attached \(C3\)/);
    }
  });

  test("the CLI floor: one binary missing", () => {
    for (const missing of CLI) {
      const f = fixture();
      Bun.spawnSync(["rm", join(f.dist, missing)]);
      expectRefused(f, collect(f), new RegExp(`CLI floor: ${missing.replace(/\./g, "\\.")} is missing`));
    }
  });

  test("a signing argument other than exactly signed or unsigned", () => {
    for (const s of ["", "Signed", "adhoc", "signed "]) {
      const f = fixture();
      expectRefused(f, collect(f, { signing: s }), /signing mode '.*' is not exactly 'signed' or 'unsigned'/);
    }
  });

  test("a version that is not plain semver", () => {
    for (const v of ["v0.2.0", "0.2.0-rc.1", ""]) {
      const f = fixture();
      expectRefused(f, collect(f, { version: v }), /is not plain semver/);
    }
  });

  test("notes-out inside dist", () => {
    const f = fixture();
    const r = collect(f, { notes: join(f.dist, "notes.md") });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/notes-out .* lies inside dist/);
    expect(existsSync(join(f.dist, "SHA256SUMS"))).toBe(false);
    expect(existsSync(join(f.dist, "notes.md"))).toBe(false);
  });

  test("notes-out whose directory does not exist", () => {
    const f = fixture();
    const r = collect(f, { notes: join(f.base, "nope", "notes.md") });
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/notes-out's directory .* does not exist/);
    expect(existsSync(join(f.dist, "SHA256SUMS"))).toBe(false);
    expect(existsSync(dirname(join(f.base, "nope", "notes.md")))).toBe(false);
  });

  // A directory <notes-out> once bypassed the inside-dist check (it compared dirname(<notes-out>)), and
  // `mv <tmp> <dir>` then moved the notes INTO the directory under the temp name: with <notes-out> =
  // dist the notes were attached as an unlisted asset (`dist/dist.XXXXXX`), with `dist/` a hidden
  // `dist/.XXXXXX`. Every directory is refused, and nothing — temp files included — lands anywhere.
  test("notes-out that is a directory: dist, dist + '/', or any other existing directory", () => {
    for (const which of ["dist", "dist/", "other"] as const) {
      const f = fixture();
      const other = join(f.base, "other");
      mkdirSync(other);
      const before = entries(f.dist);
      const notes = which === "dist" ? f.dist : which === "dist/" ? `${f.dist}/` : other;
      const r = collect(f, { notes });
      expect(`${which} -> ${r.code} ${r.err}`).toMatch(new RegExp(`^${which} -> 1 [\\s\\S]*notes-out '.*' is a directory`));
      expect(entries(f.dist)).toEqual(before);             // no SHA256SUMS, no notes, no temp file
      expect(entries(other)).toEqual([]);
      expect(entries(f.base)).toEqual(["dist", "markers", "other"]);
    }
  });

  // A pipeline into a `while` loop reported only the LAST hash's status: an unreadable earlier asset
  // printed "Permission denied", vanished from SHA256SUMS, and collect still printed PASS.
  test.skipIf(process.getuid?.() === 0)("an asset that cannot be hashed refuses the release (skipped as root: chmod 000 does not stop root reading)", () => {
    const f = fixture();
    const victim = join(f.dist, "daily-briefing-darwin-x64");
    chmodSync(victim, 0o000);
    try {
      const r = collect(f);
      expectRefused(f, r, /checksumming dist\/daily-briefing-darwin-x64 failed/);
      expect(entries(f.base)).toEqual(["dist", "markers"]); // no temp file left behind either
    } finally {
      chmodSync(victim, 0o644);
    }
  });

  // The line-count cross-check, independent of any exit status: a hasher that silently prints nothing
  // for one file (and exits 0) must still refuse the release.
  test("SHA256SUMS short of the attach set refuses the release, even when every hash exits 0", () => {
    const f = fixture();
    const bin = toolBin(f.base);
    writeFileSync(join(bin, "sha256sum"), '#!/bin/sh\n[ "$1" = "daily-briefing-linux-arm64" ] && exit 0\nexec shasum -a 256 "$1"\n', { mode: 0o755 });
    const r = collect(f, { env: { PATH: bin } });
    expectRefused(f, r, /SHA256SUMS would list 8 asset\(s\), the attach set holds 9/);
  });

  test("wrong arity", () => {
    const f = fixture();
    const r = Bun.spawnSync(["bash", COLLECT, f.dist, f.markers, V, "unsigned", "success"], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
    expect(r.exitCode).toBe(1);
    expect(r.stderr.toString()).toMatch(/usage: release-collect\.sh/);
  });

  test("every failing check is reported, not just the first", () => {
    const f = fixture({ markers: { ...ALL_BUILT, "macos-x64": "size-rejected\n" }, withFiles: ["macos-arm64", "linux-x86_64"], extra: ["stray"] });
    const r = collect(f, { signing: "" });
    expectRefused(f, r, /signing mode/);
    expect(r.err).toMatch(/dist\/stray is not a frozen/);
    expect(r.err).toMatch(/macos-x64: the bundle exceeded/);
    expect(r.err).toMatch(/3 check\(s\) FAILED/);
  });
});
