// test/keyexec.guard.test.ts — `RunDeps.keyExec`, the walk's key-exec seam, and the spawn guard behind it
// (provider-fallback plan P1-M3-T5).
//
// `runCore` → `buildProvider` resolves an API key itself, so a config whose key is an app-owned Keychain command
// would spawn the Keychain tool for real unless the test injects `keyExec`. These cases pin both halves:
//   • with `keyExec` injected, it is the ONLY exec the walk calls for the key;
//   • without it, the run-wide spawn guard (test/preload.ts) refuses the spawn and RECORDS it, even though
//     `proc.run` swallows the refusal into a quiet key warning — so a missing injection fails loudly.
//
// ⚠ THIS FILE HOLDS NO LITERAL NAMING THE BINARY. The key command's program is the LOOK-ALIKE
// `/nonexistent/bin/<basename of SECURITY_BIN>`: app-owned by its service (hub Q19), matched by the guard's
// basename rule, and — if the guard were ever broken — an ENOENT that runs nothing. That the guard also matches
// the real absolute path is asserted through the matcher, never by spawning it. Single-entry here; the variant
// where a later fallback entry then succeeds needs the walk's move-on: test/walk.failover.test.ts (P1-M7-T1).
import "./fixtures/isolate-state";
import { test, expect, afterEach, beforeAll } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { isGuarded, takeGuardViolations } from "./fixtures/spawn-guard";
import { buildRepo } from "./fixtures/build-repo";
import { startFakeApi, okJson, type FakeApi, type FakeApiHandler } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { runCore } from "../src/core";
import { APP_KEY_SERVICE, SECURITY_BIN, isAppOwnedKey, resolveProviderList } from "../src/providerList";
import { ProviderError, API_LABEL_ANTHROPIC, type Config } from "../src/types";
import type { RunOpts, RunResult } from "../src/proc";

guardNetworkForThisFile();

const LOOK = "/nonexistent/bin/" + basename(SECURITY_BIN);
const KEY = "sk-ant-api03-ZZkeyexecSENTINEL-0000";
const KEY_ARGV = [LOOK, "find-generic-password", "-s", APP_KEY_SERVICE, "-a", "k-3f9a1c2e8b7d", "-w", "/nonexistent/scratch.keychain-db"];
const MODEL_OUTPUT = "## RESUME\n- resumed\n## RECAP\n- recapped\n## SUGGESTIONS\n- suggested\n";

let repo = "";
beforeAll(async () => {
  repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
});

const servers: FakeApi[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });
const serve = async (h: FakeApiHandler): Promise<FakeApi> => { const s = await startFakeApi(h); servers.push(s); return s; };

const cfgFor = (origin: string): Config => ({
  repos: [repo],
  provider: {
    cli: API_LABEL_ANTHROPIC, argv: [], promptVia: "stdin", timeoutMs: 10_000,
    api: { kind: "anthropic", model: "claude-sonnet-5", baseUrl: origin, apiKeyCommand: KEY_ARGV },
  },
} as Config);

const deps = {
  netProbe: async () => true,
  powerPlatform: "linux" as NodeJS.Platform,
  sleep: async () => {},
  retryDelaysMs: [] as number[],
  persistHealth: async () => {},
};

test("the premise: the config's key is app-owned, and the guard matches both the real tool and the look-alike", () => {
  // `cfgFor` is already in the normalized shape runCore receives (the API triple synthesized).
  const entries = resolveProviderList(cfgFor("http://127.0.0.1:9"), "/home/u", {}, () => true).entries;
  expect(entries.length).toBe(1);
  expect(isAppOwnedKey(entries[0]!, removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-keyexec-"))))).toBe(true);
  expect([isGuarded(SECURITY_BIN), isGuarded(LOOK)]).toEqual([true, true]);
});

test("L4: the guard folds look-alike spellings — the long s (U+017F) and letter case — onto the tool's name", () => {
  const base = basename(SECURITY_BIN);
  const longS = "/nonexistent/bin/" + String.fromCharCode(0x17f) + base.slice(1);   // built, never a literal
  expect([isGuarded(longS), isGuarded("/nonexistent/bin/" + base.toUpperCase())]).toEqual([true, true]);
});

test("with keyExec injected, it is the only exec the walk calls for the key, and the run delivers", async () => {
  const s = await serve(okJson({ content: [{ type: "text", text: MODEL_OUTPUT }], stop_reason: "end_turn" }));
  const calls: { argv: string[]; opts?: RunOpts }[] = [];
  const keyExec = async (argv: string[], opts?: RunOpts): Promise<RunResult> => {
    calls.push({ argv, opts });
    return { out: `${KEY}\n`, err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false };
  };
  const r = await runCore(cfgFor(s.origin), { ...deps, keyExec });
  expect(r.rawText).toContain("RESUME");
  expect(calls.map((c) => c.argv)).toEqual([KEY_ARGV]);
  expect(s.requests).toHaveLength(1);
  expect(s.requests[0]!.headers["x-api-key"]).toBe(KEY);
  expect(takeGuardViolations()).toEqual([]);
});

test("without keyExec, the guard refuses the spawn and records it although proc.run swallows it; nothing is sent", async () => {
  const s = await serve(okJson({ content: [{ type: "text", text: MODEL_OUTPUT }], stop_reason: "end_turn" }));
  const e = await runCore(cfgFor(s.origin), deps).then(() => undefined, (x) => x as ProviderError);
  // proc.run swallowed the refusal into "no key": the run ends as a missing key, not as a crash…
  expect(e).toBeInstanceOf(ProviderError);
  expect([e!.code, e!.failCause]).toEqual(["missing-binary", "key-missing"]);
  expect(s.requests).toHaveLength(0);
  // …and the guard's record is what makes it loud. This test reads and clears it itself.
  const seen = takeGuardViolations();
  expect(seen.length).toBe(1);
  expect(seen[0]).toContain(JSON.stringify(LOOK));
  expect(seen[0]).not.toContain(APP_KEY_SERVICE);     // the record carries the program, never the argv
});
