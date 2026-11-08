// test/state-no-key-bytes.test.ts — no key bytes in any state file or status surface (provider-fallback plan P1-M10-T5;
// spec r9 §5 Reporting "No key bytes"). One walk over three API entries whose keys come from the three sources a key
// can come from — a literal `apiKey`, an app-owned key FILE under `<state>/keys/`, and an app-owned key COMMAND (two
// openai-compatible entries and one anthropic entry)
// answered by an injected `keyExec` — each against a loopback server that rejects it and ECHOES the credential back
// in its error body. Then no key byte may appear in `account-state.json`, `provider-status.json`, `last-skip.json`,
// `last-failure.json`, `briefing.log` (stdout and stderr, as launchd writes it) or `status --json`.
//
// ⚠ The key command's argv is built from the exported constants (`SECURITY_BIN`, `APP_KEY_SERVICE`) and only ever
// reaches the injected `keyExec`, so this file holds no binary-name literal and needs no REACH_CONDITIONAL entry.
import "./fixtures/isolate-state";
import { test, expect, afterAll, afterEach, beforeAll } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { run } from "../src/main";
import { statusReport } from "../src/json";
import { accountStatePath } from "../src/account";
import { keysDir, lastFailurePath, lastSkipPath, providerStatusPath } from "../src/marker";
import { APP_KEY_SERVICE, SECURITY_BIN } from "../src/providerList";
import type { RunOpts, RunResult } from "../src/proc";
import { buildRepo } from "./fixtures/build-repo";
import { startFakeApi, type FakeApi } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { freshStateDir, tempDir, walkDeps } from "./helpers/walk";

guardNetworkForThisFile();

let repo = "";
const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
const prevCfg = process.env.XDG_CONFIG_HOME;
beforeAll(async () => {
  repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
});
afterAll(() => {
  process.env.DAILY_BRIEFING_STATE_DIR = prevState;
  if (prevCfg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevCfg;
});
const servers: FakeApi[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });

// Three sentinels, and only ONE of them in a shape the generic redactor knows (P1-M10 checkpoint MED 2): an Anthropic
// key on the anthropic entry, and two keys with NO recognisable pattern on openai-compatible entries — so only the
// transport's exact-secret scrub (`src/providers/http.ts`, `diagnostic`) can keep those two out of an echoed body.
const LITERAL = "plainLITERALkey7Qz3Vw9Xn2Lm5Pk8Rt4Hs6Jd1Gf0Bc";
const FILEKEY = "sk-ant-api03-FILEkeyZq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-BBBBBB";
const CMDKEY = "plainCOMMANDkey4Ws8Yb2Nc6Mt1Qv9Zr3Kx7Hp5Jf0Dg";
/** Fragments from each key's START, MIDDLE and END, none of which a redaction marker or other text could contain. */
const FRAGMENTS = [LITERAL, FILEKEY, CMDKEY].flatMap((k) => [k.slice(0, 14), k.slice(Math.floor(k.length / 2) - 6, Math.floor(k.length / 2) + 6), k.slice(-12)]);

/** A server that rejects every request and echoes the credential it was sent in its error body. */
const echoing = () => async (req: { headers: Record<string, string> }) => new Response(
  JSON.stringify({ error: { message: `invalid key: ${req.headers["x-api-key"] ?? req.headers.authorization ?? ""}` } }),
  { status: 401, headers: { "content-type": "application/json" } },
);

test("after a walk over a literal key, an app-owned key file and an app-owned key command, no key byte is in any state file, briefing.log or status --json", async () => {
  const state = freshStateDir();
  const a = await startFakeApi(echoing()), b = await startFakeApi(echoing()), c = await startFakeApi(echoing());
  servers.push(a, b, c);
  mkdirSync(keysDir(), { recursive: true, mode: 0o700 });
  // Named as the app writes it (`k-<12 hex>.key`): since P2-M5-T1 the morning rung reads a keys/ file only through the
  // strict reader, which refuses any other name.
  const keyFile = join(keysDir(), "k-0123456789ab.key");
  writeFileSync(keyFile, `${FILEKEY}\n`, { mode: 0o600 });
  const calls: string[][] = [];
  const keyExec = async (argv: string[], _o?: RunOpts): Promise<RunResult> => {
    calls.push(argv);
    return { out: `${CMDKEY}\n`, err: "", code: 0, complete: true, spawned: true, signal: null, timedOut: false };
  };
  const home = tempDir("dba-nokey-cfg-");
  mkdirSync(join(home, "daily-briefing"), { recursive: true });
  writeFileSync(join(home, "daily-briefing", "config.json"), JSON.stringify({ repos: [repo],
    provider: { api: { kind: "openai-compatible", model: "m", baseUrl: `${a.origin}/v1`, apiKey: LITERAL } },
    fallbacks: [
      { label: "File key", api: { kind: "anthropic", model: "m", baseUrl: b.origin, apiKeyFile: keyFile } },
      { label: "Command key", api: { kind: "openai-compatible", model: "m", baseUrl: `${c.origin}/v1`, apiKeyCommand: [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-w"] } },
    ] }), { mode: 0o600 });
  process.env.XDG_CONFIG_HOME = home;

  const log: string[] = [];
  const e = console.error, l = console.log;
  console.error = (...x: unknown[]) => { log.push(x.map(String).join(" ")); };
  console.log = (...x: unknown[]) => { log.push(x.map(String).join(" ")); };
  let code: number;
  try { code = await run(true, walkDeps({ keyExec })); } finally { console.error = e; console.log = l; }

  // The premises: every entry was tried with its own key, and the walk wrote what it writes.
  expect(code).toBe(1);
  expect([a.requests.length, b.requests.length, c.requests.length]).toEqual([1, 1, 1]);
  expect(a.requests[0]!.headers.authorization).toBe(`Bearer ${LITERAL}`);
  expect(b.requests[0]!.headers["x-api-key"]).toBe(FILEKEY);
  expect(c.requests[0]!.headers.authorization).toBe(`Bearer ${CMDKEY}`);
  expect(calls).toEqual([[SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-w"]]);
  for (const p of [accountStatePath(state), providerStatusPath(), lastSkipPath(), lastFailurePath()]) expect(`${p}: ${existsSync(p)}`).toBe(`${p}: true`);

  const surfaces: [string, string][] = [
    ["account-state.json", readFileSync(accountStatePath(state), "utf8")],
    ["provider-status.json", readFileSync(providerStatusPath(), "utf8")],
    ["last-skip.json", readFileSync(lastSkipPath(), "utf8")],
    ["last-failure.json", readFileSync(lastFailurePath(), "utf8")],
    ["briefing.log", log.join("\n")],
    ["status --json", JSON.stringify(await statusReport())],
  ];
  for (const [name, text] of surfaces) {
    for (const f of FRAGMENTS) expect(`${name} holds ${f}: ${text.includes(f)}`).toBe(`${name} holds ${f}: false`);
  }
});
