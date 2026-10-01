// test/release-stage-bundles.test.ts — gui/scripts/stage-bundles.sh (Phase E, E2): Tauri's bundle
// outputs renamed into the frozen release asset names (docs/RELEASE.md §Assets).
//
// The fixtures are fake bundle trees laid out the way the bundler writes them
// (bundle/{dmg,appimage,deb}/<productName>_<version>_<arch>.<ext>); the files hold marker text, so a
// copy is checked byte for byte rather than by name alone.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = resolve(import.meta.dir, "..");
const STAGE = join(ROOT, "gui", "scripts", "stage-bundles.sh");

function tree(files: Record<string, string>): { bundle: string; out: string } {
  const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-stage-")));
  const bundle = join(base, "bundle");
  for (const [rel, body] of Object.entries(files)) {
    const p = join(bundle, rel);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  mkdirSync(bundle, { recursive: true });
  return { bundle, out: join(base, "out") };
}

function stage(...args: string[]): { code: number; out: string } {
  const r = Bun.spawnSync(["bash", STAGE, ...args], { env: { ...process.env }, stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}

const listed = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).sort() : []);

describe("stage-bundles.sh", () => {
  test("arm64 DMG: aarch64 -> darwin-arm64, bytes copied, source left in place", () => {
    const t = tree({ "dmg/Daily Briefing_0.2.0_aarch64.dmg": "arm-dmg", "macos/Daily Briefing.app/Contents/x": "app" });
    const r = stage(t.bundle, "0.2.0", t.out, "dmg");
    expect(`${r.code} ${r.out}`).toStartWith("0 ");
    expect(listed(t.out)).toEqual(["daily-briefing-0.2.0-darwin-arm64.dmg"]);
    expect(readFileSync(join(t.out, "daily-briefing-0.2.0-darwin-arm64.dmg"), "utf8")).toBe("arm-dmg");
    expect(existsSync(join(t.bundle, "dmg/Daily Briefing_0.2.0_aarch64.dmg"))).toBe(true);
  });

  test("x64 DMG: x64 -> darwin-x64", () => {
    const t = tree({ "dmg/Daily Briefing_0.2.0_x64.dmg": "x64-dmg" });
    const r = stage(t.bundle, "0.2.0", t.out, "dmg");
    expect(`${r.code} ${r.out}`).toStartWith("0 ");
    expect(listed(t.out)).toEqual(["daily-briefing-0.2.0-darwin-x64.dmg"]);
    expect(readFileSync(join(t.out, "daily-briefing-0.2.0-darwin-x64.dmg"), "utf8")).toBe("x64-dmg");
  });

  test("Linux: AppImage amd64 -> linux-x86_64, deb amd64 stays amd64 (Debian convention)", () => {
    const t = tree({
      "appimage/Daily Briefing_0.2.0_amd64.AppImage": "appimage",
      "appimage/Daily Briefing.AppDir/usr/bin/x": "appdir noise",
      "deb/Daily Briefing_0.2.0_amd64.deb": "deb",
      "deb/Daily Briefing_0.2.0_amd64/DEBIAN/control": "deb build dir noise",
    });
    const r = stage(t.bundle, "0.2.0", t.out, "appimage,deb");
    expect(`${r.code} ${r.out}`).toStartWith("0 ");
    expect(listed(t.out)).toEqual(["daily-briefing-0.2.0-linux-x86_64.AppImage", "daily-briefing_0.2.0_amd64.deb"]);
    expect(readFileSync(join(t.out, "daily-briefing-0.2.0-linux-x86_64.AppImage"), "utf8")).toBe("appimage");
    expect(readFileSync(join(t.out, "daily-briefing_0.2.0_amd64.deb"), "utf8")).toBe("deb");
  });

  test("zero matches for a kind -> exit 1 naming the kind, nothing staged", () => {
    const t = tree({ "dmg/Daily Briefing_0.1.1_aarch64.dmg": "old" });
    const r = stage(t.bundle, "0.2.0", t.out, "dmg");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/dmg: no dmg\/\*_0\.2\.0_\*\.dmg/);
    expect(listed(t.out)).toEqual([]);
  });

  test("two matches of the version -> exit 1 naming the kind", () => {
    const t = tree({ "dmg/Daily Briefing_0.2.0_aarch64.dmg": "a", "dmg/Daily Briefing_0.2.0_x64.dmg": "b" });
    const r = stage(t.bundle, "0.2.0", t.out, "dmg");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/dmg: 2 files match/);
    expect(listed(t.out)).toEqual([]);
  });

  test("an older (and a lookalike) version alongside is ignored", () => {
    const t = tree({
      "dmg/Daily Briefing_0.1.1_aarch64.dmg": "stale",
      "dmg/Daily Briefing_10.2.0_aarch64.dmg": "lookalike",
      "dmg/Daily Briefing_0.2.0_aarch64.dmg": "current",
    });
    const r = stage(t.bundle, "0.2.0", t.out, "dmg");
    expect(`${r.code} ${r.out}`).toStartWith("0 ");
    expect(readFileSync(join(t.out, "daily-briefing-0.2.0-darwin-arm64.dmg"), "utf8")).toBe("current");
  });

  test("an arch this release does not ship (universal DMG, arm64 deb) -> exit 1", () => {
    const u = tree({ "dmg/Daily Briefing_0.2.0_universal.dmg": "u" });
    expect(stage(u.bundle, "0.2.0", u.out, "dmg").code).toBe(1);
    const d = tree({ "deb/Daily Briefing_0.2.0_arm64.deb": "d" });
    const r = stage(d.bundle, "0.2.0", d.out, "deb");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/arch 'arm64'/);
  });

  test("a failing second kind leaves the first kind unstaged", () => {
    const t = tree({ "appimage/Daily Briefing_0.2.0_amd64.AppImage": "appimage" });
    const r = stage(t.bundle, "0.2.0", t.out, "appimage,deb");
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/deb: no deb\//);
    expect(listed(t.out)).toEqual([]);
  });

  test("bad arguments: unknown kind, duplicate kind, non-semver version, wrong arity, existing destination", () => {
    const t = tree({ "dmg/Daily Briefing_0.2.0_aarch64.dmg": "a" });
    expect(stage(t.bundle, "0.2.0", t.out, "pkg").code).toBe(1);
    expect(stage(t.bundle, "0.2.0", t.out, "dmg,dmg").code).toBe(1);
    expect(stage(t.bundle, "v0.2.0", t.out, "dmg").code).toBe(1);
    expect(stage(t.bundle, "0.2.0-rc.1", t.out, "dmg").code).toBe(1);
    expect(stage(t.bundle, "0.2.0", t.out).code).toBe(1);
    expect(stage(join(t.bundle, "nope"), "0.2.0", t.out, "dmg").code).toBe(1);
    expect(listed(t.out)).toEqual([]);
    expect(stage(t.bundle, "0.2.0", t.out, "dmg").code).toBe(0);
    const again = stage(t.bundle, "0.2.0", t.out, "dmg");
    expect(again.code).toBe(1);
    expect(again.out).toMatch(/already exists/);
  });
});
