// test/diag.credential-redaction.test.ts — sink 3 (briefing.log) for DIAGNOSTIC lines, not the briefing.
//
// T8.1 redacts `rendered` — `redactCredentials(renderBriefing(r.struct))` at main.ts's one call site —
// which covers sinks 1-3 for the BRIEFING TEXT. It does not cover the stderr lines built from the same
// `struct` fields further down the pipeline, and main.ts's own comment names briefing.log as a redacted
// sink: under launchd, StandardErrorPath IS briefing.log, so every diagnostic line lands in the file
// the redaction claim is about. The desktop app widens the blast radius — gui/src-tauri/src/engine.rs
// streams the engine's stderr to the webview VERBATIM as `engine:progress` — so an unredacted
// diagnostic is rendered on screen as well as written to disk.
//
// REPRODUCED 2026-09-16 (reviewer report, B5 build): `postcheck-info [suggestion-restates-near]: …`
// carried a raw `ghp_…` token while the briefing file and the envelope's markdown were correctly
// `[redacted]`.
import "./fixtures/isolate-state";
import { test, expect } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { buildRepo, commitFiles } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { run } from "../src/main";
import { ProviderError } from "../src/types";
import { REDACTION, matchesCredential } from "../src/transcripts/credentials";

const GH_TOKEN = "ghp_AbCdEfGhIjKlMnOpQrStUv123456";
const ANT_KEY = "sk-ant-api03-ZZTOPSECRETsentinelVALUE0000";

const yesterdayISO = () => new Date(Date.now() - 864e5).toISOString();
const AFTER_FLOOR = () => new Date(2026, 6, 16, 9, 0);

function withEnv(cfgObj: unknown): () => void {
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-diag-cfg-")));
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-diag-state-")));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });
  writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify(cfgObj));
  const prevXdg = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
  process.env.XDG_CONFIG_HOME = cfgHome;
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  return () => {
    if (prevXdg === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = prevXdg;
    if (prevState === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR; else process.env.DAILY_BRIEFING_STATE_DIR = prevState;
  };
}

/** stderr IS the assertion surface here — postcheck and the failure diagnostics have no other. */
function captureConsole() {
  const out: string[] = [], err: string[] = [];
  const oLog = console.log, oErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(" ")); };
  return { out, err, restore: () => { console.log = oLog; console.error = oErr; } };
}

const PROV = { cli: "claude", argv: ["-p"], promptVia: "stdin" as const };

// ── 1. THE REPORTED CASE: a postcheck diagnostic built from MODEL OUTPUT ─────────────────────────
test("postcheck diagnostics reach stderr REDACTED — a suggestion restating a credential-bearing bullet", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [repo], provider: PROV, networkProbeHosts: [], excludeCommitPatterns: [] });
  const raw =
    `## RESUME\n- [r] rotate ${GH_TOKEN} out of CI before the next deploy\n` +
    `## RECAP\n- [r] did y | evidence: abc123\n` +
    `## SUGGESTIONS\n- Rotate ${GH_TOKEN} out of CI before the next deploy`;
  const cap = captureConsole();
  try {
    await run(true, { now: AFTER_FLOOR, netProbe: async () => true, provider: { generate: async () => raw } });
  } finally { cap.restore(); cleanup(); }

  const err = cap.err.join("\n");
  // PREMISE — without this the test passes whenever postcheck simply did not fire, which is exactly
  // how a redaction test goes vacuous.
  const hits = cap.err.filter((l) => l.startsWith("postcheck"));
  expect(hits.length).toBeGreaterThan(0);
  expect(hits.join("\n")).toContain("suggestion restates");
  // THE ASSERTION.
  expect(err).not.toContain(GH_TOKEN);
  expect(hits.join("\n")).toContain(REDACTION);
  // …and the whole stderr stream, not just the line we predicted.
  expect(matchesCredential(err)).toBe(false);
});

// ── 2. A SECOND PATH, GIT-DERIVED: the provider-failure line carries the CLI's own output ────────
test("the provider-failure diagnostic reaches stderr REDACTED — a CLI that echoes a key in its error", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const cleanup = withEnv({ repos: [repo], provider: PROV, networkProbeHosts: [], excludeCommitPatterns: [] });
  const cap = captureConsole();
  try {
    await run(true, {
      // `retryDelaysMs: []` — no retry schedule, so the throw surfaces on the first attempt. Without
      // it the default schedule sleeps the test past bun's 5s timeout.
      now: AFTER_FLOOR, netProbe: async () => true, retryDelaysMs: [],
      provider: {
        generate: async () => {
          // The real shape: provider.ts puts up to 600 chars of the CLI's stdout+stderr into `message`.
          throw new ProviderError("nonzero-exit", `claude exited 1: Invalid API key: ${ANT_KEY} (request failed)`);
        },
      },
    });
  } finally { cap.restore(); cleanup(); }

  const err = cap.err.join("\n");
  const line = cap.err.find((l) => l.startsWith("Briefing provider failed"));
  expect(line).toBeDefined();               // PREMISE: the diagnostic really fired
  expect(line!).toContain(REDACTION);
  expect(err).not.toContain(ANT_KEY);
  expect(matchesCredential(err)).toBe(false);
});

// ── 3. A THIRD PATH, GIT-DERIVED TEXT: a commit SUBJECT quoted by the freshness diagnostic ───────
test("a credential-shaped COMMIT SUBJECT quoted by a postcheck diagnostic is redacted", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const subjectOld = `chore: drop ${ANT_KEY} from the deploy script`;
  const noonToday = () => { const d = new Date(); d.setHours(9, 0, 0, 0); return d.toISOString(); };
  const laterToday = () => { const d = new Date(); d.setHours(11, 0, 0, 0); return d.toISOString(); };
  await commitFiles(repo, ["b.txt"], { message: subjectOld, isoDate: noonToday() });
  await commitFiles(repo, ["c.txt"], { message: "chore: follow-up work after the rotation", isoDate: laterToday() });

  // ⚠ THE BULLET'S LABEL MUST BE THE UNIT'S OWN LABEL (the repo's basename): `checkResumeFreshness`
  // keys same-day work by unit label, so a bullet labelled anything else is structurally incapable of
  // firing and the test would be vacuous.
  const label = basename(repo);
  const cleanup = withEnv({ repos: [repo], provider: PROV, networkProbeHosts: [], excludeCommitPatterns: [] });
  const raw =
    `## RESUME\n- [${label}] picking up from \`${subjectOld}\`\n` +
    `## RECAP\n- [r] did y | evidence: abc123\n` +
    `## SUGGESTIONS\n- something unrelated entirely`;
  const cap = captureConsole();
  try {
    await run(true, { now: AFTER_FLOOR, netProbe: async () => true, provider: { generate: async () => raw } });
  } finally { cap.restore(); cleanup(); }

  const err = cap.err.join("\n");
  const stale = cap.err.filter((l) => l.startsWith("postcheck [resume-stale]"));
  expect(stale.length).toBeGreaterThan(0);          // PREMISE: the git-derived diagnostic really fired
  expect(err).not.toContain(ANT_KEY);
  expect(matchesCredential(err)).toBe(false);
});

// ── 4. THE TRUNCATION BYPASS: a sink-side scan cannot recover what `clip` already cut ────────────
//
// `clip(s, 90)` is applied to every untrusted span in a postcheck `detail`. `redactCredentials`
// matches whole SHAPES (`ghp_` + >=20 alnum), so a token the clip cut in half stops matching and the
// surviving prefix ships. Measured before the fix: `revoke ghp_Ab…` — `matchesCredential` false.
// This is why the redaction sits inside `clip` rather than only at the stderr sink.
test("a token straddling the 90-char clip boundary cannot leak a PREFIX", async () => {
  const { checkSuggestionRestatement } = await import("../src/postcheck");
  // 73 characters of prose, then the token — SIZED, not arbitrary. Unredacted, `clip` keeps
  // `…on call to ghp_AbCdEfGhIjKl…`: 16 characters of the secret, past the point where
  // `matchesCredential` still recognises it. Redacted first, the span is 83 characters and survives
  // the clip whole.
  const pad = "rotate the deploy credentials before the release and tell the on call to";
  const text = `${pad} ${GH_TOKEN}`;
  expect(text.length).toBeGreaterThan(90);                 // PREMISE: the clip really is in play
  const findings = checkSuggestionRestatement([{ repo: "app", text }], [{ repo: "app", text }]);
  expect(findings.length).toBe(1);                         // PREMISE: the detail really was built
  const detail = findings[0]!.detail;
  expect(detail).not.toContain("ghp_");                    // not even the first four characters
  expect(detail).not.toContain(GH_TOKEN.slice(0, 12));     // nor the prefix the clip used to leave
  expect(matchesCredential(detail)).toBe(false);
  expect(detail).toContain(REDACTION);
});

// ── 5. THE REPORTED INVOCATION, END TO END: the real CLI, a fake provider, real fd 2 ─────────────
//
// The in-process tests above capture `console.error`, which is where the redaction now happens — so
// they cannot see a line written to stderr by some OTHER route. This one runs the engine the way the
// reviewer did (`run --json --force`, HOME/XDG_CONFIG_HOME/DAILY_BRIEFING_STATE_DIR all in tempdirs)
// and reads the bytes that actually reached the pipe. No network: `networkProbeHosts: []` is the
// explicit skip switch, and the "provider" is a shell script.
test("the real CLI writes NOTHING credential-shaped to fd 2", async () => {
  const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: yesterdayISO() }]);
  const home = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-diag-home-")));
  const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-diag-cfg2-")));
  const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-diag-state2-")));
  mkdirSync(join(cfgHome, "daily-briefing"), { recursive: true });

  // The fake provider: a shell script, so nothing resembling a real CLI or an API key is involved.
  const cli = join(home, "fake-provider.sh");
  writeFileSync(cli, `#!/bin/sh
cat > /dev/null
printf '## RESUME\\n- [r] rotate %s out of CI before the next deploy\\n## RECAP\\n- [r] did y | evidence: abc123\\n## SUGGESTIONS\\n- Rotate %s out of CI before the next deploy\\n' "${GH_TOKEN}" "${GH_TOKEN}"
`, { mode: 0o755 });

  writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify({
    repos: [repo], excludeCommitPatterns: [], lookbackCapDays: 30,
    networkProbeHosts: [],                       // the explicit skip switch — this test opens no socket
    provider: { cli, argv: [], promptVia: "stdin" },
  }));

  const proc = Bun.spawn(["bun", "run", "src/main.ts", "run", "--json", "--force"], {
    cwd: import.meta.dir.replace(/\/test$/, ""),
    env: { PATH: process.env.PATH ?? "", HOME: home, XDG_CONFIG_HOME: cfgHome, DAILY_BRIEFING_STATE_DIR: stateDir },
    stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;

  // PREMISES — without them a silent failure to run at all would pass every assertion below.
  expect(stderr).toContain("postcheck");
  const env = JSON.parse(stdout.trim().split("\n").at(-1)!);
  expect(env.markdown).toContain(REDACTION);

  expect(stderr).not.toContain(GH_TOKEN);
  expect(matchesCredential(stderr)).toBe(false);
}, 30000);

// ── 6. THE CRASH SEAM: an error that escaped every handler ───────────────────────────────────────
//
// `run()` catches a non-ProviderError, records the skip and RETHROWS ("rethrow to preserve the crash
// exit"). Nothing of ours then prints it — BUN's top-level handler does, so `diagError` never sees it.
// Measured 2026-09-16 on the pre-fix tree: `error: generator blew up on ghp_AbCdEfGhIjKlMnOpQrStUv123456`
// on fd 2, which under launchd is briefing.log.
test("a crash escaping to the process entry is redacted, with its stack and exit code intact", async () => {
  const { main } = await import("../src/main");
  const cap = captureConsole();
  let code: number;
  try {
    code = await main(["bun", "daily-briefing", "run"], {
      run: async () => { throw new Error(`generator blew up on ${GH_TOKEN}`); },
    });
  } finally { cap.restore(); }

  expect(code!).toBe(1);                               // the crash exit is preserved, not swallowed
  const err = cap.err.join("\n");
  expect(err).toContain("generator blew up on");       // PREMISE: the crash line really was printed
  expect(err).toContain(REDACTION);
  expect(err).not.toContain(GH_TOKEN);
  expect(matchesCredential(err)).toBe(false);
  // THE STACK SURVIVES — this is the half the redaction is not allowed to cost. `main` is the frame
  // the injected `run` was called from, so its presence proves a real trace, not just a message.
  expect(err).toContain("src/main.ts");
  expect(err.split("\n").length).toBeGreaterThan(1);
});
