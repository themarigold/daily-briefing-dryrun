// test/config.api-key-file.test.ts — P1 (pre-release recut). `~` in `provider.api.apiKeyFile`.
//
// The app's setup suggests `~/.config/daily-briefing/anthropic-key` for the key file and writes the
// field verbatim; `resolveApiKey` reads the path literally. Before the fix `validateConfig` expanded
// `~` only in the repo path arrays, so the key ladder looked for a file literally named `~/…` and the
// scheduled run failed with "no API key". The expansion lives in `validateConfig`, the one function
// both `loadConfig` (every run) and `validateCandidate` (doctor, `config validate`) call.
//
// HOME is a temp directory passed as `validateConfig`'s `home`, which is what `loadConfig` passes
// `homedir()` as; nothing here reads or writes the real home.
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config";
import { validateCandidate } from "../src/json";
import { resolveApiKey } from "../src/apiKey";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const FAKE_KEY = "sk-ant-p1-tilde-test-value-not-a-real-key";
const REL = ".config/daily-briefing/anthropic-key";

async function withTempHome(fn: (home: string, keyPath: string) => Promise<void>): Promise<void> {
  const home = removeAtRunEnd(await mkdtemp(join(tmpdir(), "dba-p1-home-")));
  await mkdir(join(home, ".config", "daily-briefing"), { recursive: true });
  const keyPath = join(home, REL);
  await writeFile(keyPath, `${FAKE_KEY}\n`);
  await chmod(keyPath, 0o600);
  await fn(home, keyPath);
}

const rawWith = (apiKeyFile: string) => ({
  provider: { api: { kind: "anthropic", model: "m", apiKeyFile } },
});

test("P1: `~/…` in provider.api.apiKeyFile resolves to $HOME/…, and the key ladder reads that file", async () => {
  await withTempHome(async (home, keyPath) => {
    const raw = rawWith(`~/${REL}`);
    const before = JSON.stringify(raw);

    // The run path: loadConfig → validateConfig(json, homedir()).
    const cfg = validateConfig(raw, home);
    expect(cfg.provider.api?.apiKeyFile).toBe(keyPath);
    const run = await resolveApiKey(cfg.provider.api!, {});
    expect([run.source, run.detail, run.key]).toEqual(["file", keyPath, FAKE_KEY]);
    expect(run.warnings).toEqual([]);

    // The doctor / `config validate` path: validateCandidate → the same validateConfig. doctor resolves
    // the key from `normalized` with `skipCommand`, exactly as here.
    const report = validateCandidate(raw, home, {});
    expect(report.valid).toBe(true);
    expect(report.normalized?.provider.api?.apiKeyFile).toBe(keyPath);
    const doctor = await resolveApiKey(report.normalized!.provider.api!, {}, { skipCommand: true });
    expect([doctor.source, doctor.detail]).toEqual(["file", keyPath]);

    // The caller's object (what a Settings screen would write back) is not rewritten.
    expect(JSON.stringify(raw)).toBe(before);
  });
});

test("P1: the literal `~/…` path is what the ladder cannot read — the expansion is what makes the difference", async () => {
  // Non-vacuity for the test above: hand `resolveApiKey` the UNEXPANDED value, as the pre-fix
  // `validateConfig` did, and it finds nothing.
  const literal = await resolveApiKey({ kind: "anthropic", model: "m", apiKeyFile: `~/${REL}` }, {});
  expect(literal.source).toBe("none");
  expect(literal.warnings.join(" ")).toMatch(/could not be read/);
});

test("P1: absolute and relative apiKeyFile values are unchanged, and no apiKeyFile is invented", async () => {
  await withTempHome(async (home) => {
    expect(validateConfig(rawWith("/etc/dba/key"), home).provider.api?.apiKeyFile).toBe("/etc/dba/key");
    expect(validateConfig(rawWith("keys/anthropic"), home).provider.api?.apiKeyFile).toBe("keys/anthropic");
    // `~user/…` is not this user's home and is left alone, as it is for `repos`.
    expect(validateConfig(rawWith("~other/key"), home).provider.api?.apiKeyFile).toBe("~other/key");
    const none = validateConfig({ provider: { api: { kind: "anthropic", model: "m" } } }, home);
    expect("apiKeyFile" in (none.provider.api ?? {})).toBe(false);
  });
});
