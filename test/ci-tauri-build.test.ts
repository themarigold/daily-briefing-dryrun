// test/ci-tauri-build.test.ts — gui/scripts/ci-tauri-build.sh (Phase E, E5): the one way every bundle
// leg of the release workflow runs `tauri build`, and the owner of its signing and notarization rules.
//
// Nothing real is ever built or signed. The Tauri CLI is a stub reached through TAURI_CMD (the script's
// only seam) that records its environment and argv; `uname` is a stub first on PATH, so the macOS and the
// non-macOS branch both run on every runner; HOME is a scratch directory. Each case builds the child's
// environment from nothing (PATH, HOME, the stubs, the case's own variables), so an APPLE_* variable that
// happens to be set on the machine running the suite can never leak into a case, or into a real build.
import "./fixtures/isolate-state";
import { test, expect, describe } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const ROOT = resolve(import.meta.dir, "..");
const SCRIPT = join(ROOT, "gui", "scripts", "ci-tauri-build.sh");

/** The APPLE_* names E5 refuses on arrival (tauri-bundler macos/sign.rs `keychain` and `notarize_auth`
 *  read them; the CLI's own certificate import is never used). */
const REFUSED = [
  "APPLE_CERTIFICATE", "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_ID", "APPLE_PASSWORD", "APPLE_TEAM_ID",
  "APPLE_API_KEY", "APPLE_API_ISSUER", "APPLE_API_KEY_PATH",
];

const APPLE_ID_SET = {
  DBA_NOTARIZE_APPLE_ID: "dev@example.invalid",
  DBA_NOTARIZE_APPLE_PASSWORD: "app-specific-password",
  DBA_NOTARIZE_APPLE_TEAM_ID: "TEAM123456",
};
const API_SET = {
  DBA_NOTARIZE_API_KEY: "KEYID12345",
  DBA_NOTARIZE_API_ISSUER: "00000000-0000-0000-0000-000000000000",
  DBA_NOTARIZE_API_KEY_P8: "-----BEGIN PRIVATE KEY-----\nnot-a-real-key\n-----END PRIVATE KEY-----",
};
const EMPTY_SIX = Object.fromEntries([...Object.keys(APPLE_ID_SET), ...Object.keys(API_SET)].map((k) => [k, ""]));
const IDENTITY = "Daily Briefing Release Signing";

interface Run {
  code: number;
  out: string;
  /** null when the stub never ran (the script refused before the build). */
  env: Record<string, string> | null;
  argv: string[] | null;
  /** What the stub read from APPLE_API_KEY_PATH while the build ran, if it was set. */
  key: string | null;
  runnerTemp: string;
}

function run(args: string[], os: "Darwin" | "Linux", extra: Record<string, string> = {}, stubExit = 0): Run {
  const base = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-ci-tauri-")));
  const bin = join(base, "bin");
  const home = join(base, "home");
  const runnerTemp = join(base, "runner-temp");
  for (const d of [bin, home, runnerTemp]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "uname"), `#!/bin/sh\necho ${os}\n`, { mode: 0o755 });
  const rec = join(base, "rec");
  const stub = join(base, "tauri-stub");
  writeFileSync(
    stub,
    "#!/bin/sh\n" +
      `env > "${rec}.env"\n` +
      `printf '%s\\n' "$@" > "${rec}.argv"\n` +
      `if [ -n "\${APPLE_API_KEY_PATH:-}" ]; then cat "$APPLE_API_KEY_PATH" > "${rec}.key"; fi\n` +
      `exit ${stubExit}\n`,
    { mode: 0o755 },
  );
  const env: Record<string, string> = {
    PATH: `${bin}:/usr/bin:/bin`,
    HOME: home,
    TAURI_CMD: stub,
    RUNNER_TEMP: runnerTemp,
    ...extra,
  };
  const r = Bun.spawnSync(["bash", SCRIPT, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const read = (p: string): string | null => (existsSync(p) ? readFileSync(p, "utf8") : null);
  const envText = read(`${rec}.env`);
  let recorded: Record<string, string> | null = null;
  if (envText !== null) {
    recorded = {};
    for (const line of envText.split("\n")) {
      const i = line.indexOf("=");
      if (i > 0 && /^[A-Za-z_][A-Za-z0-9_]*$/.test(line.slice(0, i))) recorded[line.slice(0, i)] = line.slice(i + 1);
    }
  }
  const argvText = read(`${rec}.argv`);
  return {
    code: r.exitCode,
    out: r.stdout.toString() + r.stderr.toString(),
    env: recorded,
    argv: argvText === null ? null : argvText.trimEnd().split("\n"),
    key: read(`${rec}.key`),
    runnerTemp,
  };
}

const appleKeys = (env: Record<string, string>): string[] => Object.keys(env).filter((k) => k.startsWith("APPLE_")).sort();

describe("ci-tauri-build.sh: the signing identity", () => {
  test("unsigned on macOS -> APPLE_SIGNING_IDENTITY=- (Tauri ad-hoc signs), and the build is invoked", () => {
    const r = run(["aarch64-apple-darwin", "unsigned"], "Darwin");
    expect(`${r.code} ${r.out}`).toStartWith("0 ");
    expect(r.out).toContain("signing: unsigned");
    expect(r.env?.APPLE_SIGNING_IDENTITY).toBe("-");
    expect(r.argv).toEqual(["build", "--target", "aarch64-apple-darwin"]);
  });

  test("unsigned on macOS overrides an identity that arrived in the environment", () => {
    const r = run(["x86_64-apple-darwin", "unsigned"], "Darwin", { APPLE_SIGNING_IDENTITY: IDENTITY });
    expect(r.code).toBe(0);
    expect(r.env?.APPLE_SIGNING_IDENTITY).toBe("-");
  });

  test("unsigned elsewhere -> APPLE_SIGNING_IDENTITY unset, even when it arrived set", () => {
    const extras: Record<string, string>[] = [{}, { APPLE_SIGNING_IDENTITY: IDENTITY }, { APPLE_SIGNING_IDENTITY: "-" }];
    for (const extra of extras) {
      const r = run(["x86_64-unknown-linux-gnu", "unsigned"], "Linux", extra);
      expect(`${r.code} ${r.out}`).toStartWith("0 ");
      expect(r.env).not.toBeNull();
      expect("APPLE_SIGNING_IDENTITY" in r.env!).toBe(false);
      expect(r.argv).toEqual(["build", "--target", "x86_64-unknown-linux-gnu"]);
    }
  });

  test("signed on macOS with an identity -> that identity", () => {
    const r = run(["aarch64-apple-darwin", "signed"], "Darwin", { APPLE_SIGNING_IDENTITY: IDENTITY });
    expect(`${r.code} ${r.out}`).toStartWith("0 ");
    expect(r.out).toContain("signing: signed");
    expect(r.env?.APPLE_SIGNING_IDENTITY).toBe(IDENTITY);
  });

  test("signed without an identity, with an empty one, or with '-' -> refused before the build", () => {
    for (const [name, extra] of [
      ["unset", {}],
      ["empty", { APPLE_SIGNING_IDENTITY: "" }],
      ["ad-hoc", { APPLE_SIGNING_IDENTITY: "-" }],
    ] as const) {
      const r = run(["aarch64-apple-darwin", "signed"], "Darwin", extra);
      expect(`${name}: ${r.code}`).toBe(`${name}: 1`);
      expect(r.out).toContain("APPLE_SIGNING_IDENTITY");
      expect(r.env).toBeNull();
    }
  });

  test("signed on a non-macOS runner -> refused, even with an identity", () => {
    const r = run(["x86_64-unknown-linux-gnu", "signed"], "Linux", { APPLE_SIGNING_IDENTITY: IDENTITY });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/non-macOS runner \(Linux\)/);
    expect(r.env).toBeNull();
  });

  test("the mode is never defaulted: missing, empty or misspelt -> refused", () => {
    for (const args of [["aarch64-apple-darwin"], ["aarch64-apple-darwin", ""], ["aarch64-apple-darwin", "Signed"], ["aarch64-apple-darwin", "adhoc"], ["", "unsigned"]]) {
      const r = run(args, "Darwin", { APPLE_SIGNING_IDENTITY: IDENTITY });
      expect(`${JSON.stringify(args)} -> ${r.code}`).toBe(`${JSON.stringify(args)} -> 1`);
      expect(r.env).toBeNull();
    }
  });

  test("the build's own exit status is the script's", () => {
    const r = run(["aarch64-apple-darwin", "unsigned"], "Darwin", {}, 7);
    expect(r.code).toBe(7);
    expect(r.argv).toEqual(["build", "--target", "aarch64-apple-darwin"]);
  });
});

describe("ci-tauri-build.sh: refused APPLE_* inputs", () => {
  // Table-driven over every refused name, set and set-but-empty, in both modes and on both OS branches
  // that can accept them: refused before the stub runs, and the refusal names the variable.
  for (const name of REFUSED) {
    for (const value of ["x", ""]) {
      test(`${name}=${JSON.stringify(value)} -> refused before the build`, () => {
        for (const [os, mode, triple, extra] of [
          ["Darwin", "unsigned", "aarch64-apple-darwin", {}],
          ["Darwin", "signed", "aarch64-apple-darwin", { APPLE_SIGNING_IDENTITY: IDENTITY }],
          ["Linux", "unsigned", "x86_64-unknown-linux-gnu", {}],
        ] as const) {
          const r = run([triple, mode], os, { ...extra, [name]: value });
          expect(`${os}/${mode}: ${r.code}`).toBe(`${os}/${mode}: 1`);
          expect(r.out).toContain(name);
          expect(r.env).toBeNull();
        }
      });
    }
  }

  test("the refusal is by prefix: any APPLE_CERTIFICATE* or APPLE_API_* name, not only the enumerated ones", () => {
    for (const name of ["APPLE_CERTIFICATE_FUTURE", "APPLE_API_SOMETHING_NEW"]) {
      const r = run(["aarch64-apple-darwin", "unsigned"], "Darwin", { [name]: "" });
      expect(`${name}: ${r.code}`).toBe(`${name}: 1`);
      expect(r.env).toBeNull();
    }
  });

  test("APPLE_SIGNING_IDENTITY is the one APPLE_* input that is expected, not refused", () => {
    const r = run(["aarch64-apple-darwin", "signed"], "Darwin", { APPLE_SIGNING_IDENTITY: IDENTITY });
    expect(r.code).toBe(0);
    expect(appleKeys(r.env!)).toEqual(["APPLE_SIGNING_IDENTITY"]);
  });
});

describe("ci-tauri-build.sh: notarization", () => {
  const signed = (extra: Record<string, string>): Run =>
    run(["aarch64-apple-darwin", "signed"], "Darwin", { APPLE_SIGNING_IDENTITY: IDENTITY, ...EMPTY_SIX, ...extra });

  test("a complete AppleId set in signed mode -> APPLE_ID, APPLE_PASSWORD, APPLE_TEAM_ID exported", () => {
    const r = signed(APPLE_ID_SET);
    expect(`${r.code} ${r.out}`).toStartWith("0 ");
    expect(r.out).toContain("notarization: apple-id");
    expect(appleKeys(r.env!)).toEqual(["APPLE_ID", "APPLE_PASSWORD", "APPLE_SIGNING_IDENTITY", "APPLE_TEAM_ID"]);
    expect(r.env!.APPLE_ID).toBe(APPLE_ID_SET.DBA_NOTARIZE_APPLE_ID);
    expect(r.env!.APPLE_PASSWORD).toBe(APPLE_ID_SET.DBA_NOTARIZE_APPLE_PASSWORD);
    expect(r.env!.APPLE_TEAM_ID).toBe(APPLE_ID_SET.DBA_NOTARIZE_APPLE_TEAM_ID);
  });

  test("a complete API set in signed mode -> APPLE_API_KEY, APPLE_API_ISSUER, and the .p8 in a temp file removed afterwards", () => {
    const r = signed(API_SET);
    expect(`${r.code} ${r.out}`).toStartWith("0 ");
    expect(r.out).toContain("notarization: api-key");
    expect(appleKeys(r.env!)).toEqual(["APPLE_API_ISSUER", "APPLE_API_KEY", "APPLE_API_KEY_PATH", "APPLE_SIGNING_IDENTITY"]);
    expect(r.env!.APPLE_API_KEY).toBe(API_SET.DBA_NOTARIZE_API_KEY);
    expect(r.env!.APPLE_API_ISSUER).toBe(API_SET.DBA_NOTARIZE_API_ISSUER);
    expect(r.env!.APPLE_API_KEY_PATH).toStartWith(r.runnerTemp + "/");
    expect(r.key).toBe(API_SET.DBA_NOTARIZE_API_KEY_P8 + "\n");
    expect(existsSync(r.env!.APPLE_API_KEY_PATH!)).toBe(false);
    expect(readdirSync(r.runnerTemp)).toEqual([]);
  });

  test("the key file is removed even when the build fails", () => {
    const r = run(["aarch64-apple-darwin", "signed"], "Darwin", { APPLE_SIGNING_IDENTITY: IDENTITY, ...API_SET }, 3);
    expect(r.code).toBe(3);
    expect(r.key).not.toBeNull();
    expect(readdirSync(r.runnerTemp)).toEqual([]);
  });

  test("all six defined but empty in signed mode -> nothing exported", () => {
    const r = signed({});
    expect(`${r.code} ${r.out}`).toStartWith("0 ");
    expect(r.out).toContain("notarization: none");
    expect(appleKeys(r.env!)).toEqual(["APPLE_SIGNING_IDENTITY"]);
  });

  test("the DBA_NOTARIZE_* copies never reach the Tauri CLI", () => {
    for (const r of [signed(APPLE_ID_SET), signed(API_SET), signed({})]) {
      expect(Object.keys(r.env!).filter((k) => k.startsWith("DBA_NOTARIZE_"))).toEqual([]);
    }
  });

  test("a partial set (any one of the six missing from a complete set) -> refused", () => {
    for (const set of [APPLE_ID_SET, API_SET]) {
      for (const drop of Object.keys(set)) {
        const r = signed({ ...set, [drop]: "" });
        expect(`without ${drop}: ${r.code}`).toBe(`without ${drop}: 1`);
        expect(r.out).toMatch(/partial .* notarization set/);
        expect(r.env).toBeNull();
      }
    }
  });

  test("a single value of a set -> refused as partial", () => {
    const r = signed({ DBA_NOTARIZE_APPLE_TEAM_ID: "TEAM123456" });
    expect(r.code).toBe(1);
    expect(r.env).toBeNull();
  });

  test("both sets complete -> refused (one notarization path, no silent preference)", () => {
    const r = signed({ ...APPLE_ID_SET, ...API_SET });
    expect(r.code).toBe(1);
    expect(r.out).toContain("both notarization sets are complete");
    expect(r.env).toBeNull();
  });

  test("a complete set in unsigned mode -> not exported, with a notice (an ad-hoc signature cannot be notarized)", () => {
    for (const set of [APPLE_ID_SET, API_SET]) {
      const r = run(["aarch64-apple-darwin", "unsigned"], "Darwin", { ...EMPTY_SIX, ...set });
      expect(`${r.code} ${r.out}`).toStartWith("0 ");
      expect(r.out).toContain("notarization: none");
      expect(r.out).toContain("notarization input present but not exported (unsigned mode");
      expect(appleKeys(r.env!)).toEqual(["APPLE_SIGNING_IDENTITY"]);
      expect(r.env!.APPLE_SIGNING_IDENTITY).toBe("-");
      expect(Object.keys(r.env!).filter((k) => k.startsWith("DBA_NOTARIZE_"))).toEqual([]);
      expect(readdirSync(r.runnerTemp)).toEqual([]);
    }
  });

  // The input's SHAPE is checked in both modes: an unsigned run must not hide a misconfigured set until
  // the first signed release. Darwin and Linux both, since the check sits before any OS branch uses it.
  test("a partial set in UNSIGNED mode -> refused (on both OS branches), before the build", () => {
    for (const [os, triple] of [["Darwin", "aarch64-apple-darwin"], ["Linux", "x86_64-unknown-linux-gnu"]] as const) {
      for (const set of [APPLE_ID_SET, API_SET]) {
        for (const drop of Object.keys(set)) {
          const r = run([triple, "unsigned"], os, { ...EMPTY_SIX, ...set, [drop]: "" });
          expect(`${os} without ${drop}: ${r.code}`).toBe(`${os} without ${drop}: 1`);
          expect(r.out).toMatch(/partial .* notarization set/);
          expect(r.env).toBeNull();
        }
      }
      const single = run([triple, "unsigned"], os, { DBA_NOTARIZE_APPLE_ID: "x" });
      expect(`${os} single: ${single.code}`).toBe(`${os} single: 1`);
      expect(single.env).toBeNull();
    }
  });

  test("both sets complete in UNSIGNED mode -> refused, before the build", () => {
    const r = run(["aarch64-apple-darwin", "unsigned"], "Darwin", { ...APPLE_ID_SET, ...API_SET });
    expect(r.code).toBe(1);
    expect(r.out).toContain("both notarization sets are complete");
    expect(r.env).toBeNull();
  });
});

describe("ci-tauri-build.sh: the default Tauri CLI path", () => {
  test("without TAURI_CMD it resolves the CLI from its own location (gui/node_modules/.bin/tauri)", () => {
    // Static: the default must be relative to the script, never a bare `tauri` looked up on PATH
    // (nothing named tauri is on the runners' PATH).
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).toMatch(/^TAURI_CMD="\$\{TAURI_CMD:-"\$\(dirname "\$0"\)\/\.\.\/node_modules\/\.bin\/tauri"\}"$/m);
  });
});
