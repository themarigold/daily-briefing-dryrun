// test/helpers/walk.ts — shared scaffolding for the provider-walk tests (provider-fallback plan P1-M6+).
//
// A fake CLI on disk (so the REAL provider stack runs: hardenedProvider, withRetry, the ladder), a per-test state
// folder (runCore's live-state writes go to `supportDir()`), and the deps that keep runCore off the network,
// out of the darkwake gate and out of real retry sleeps. Holds no binary-name literal (see isolation.meta).
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { removeAtRunEnd } from "../fixtures/temp-dirs";

/** A parseable model answer: all three sections. */
export const BRIEFING = "## RESUME\n- [r] resume here\n## RECAP\n- [r] did x\n## SUGGESTIONS\n- [r] do y\n";

/** A fresh registered temp folder. */
export function tempDir(prefix: string): string {
  return removeAtRunEnd(mkdtempSync(join(tmpdir(), prefix)));
}

/** Point the state folder at a fresh temp folder and return it. The caller's file restores the previous value
 *  in its own afterAll (the isolation baseline stays armed either way). */
export function freshStateDir(): string {
  const d = tempDir("dba-walk-state-");
  process.env.DAILY_BRIEFING_STATE_DIR = d;
  return d;
}

/**
 * A fake provider CLI. Every real invocation appends `$CLAUDE_CONFIG_DIR` (empty when unset) to `spawns.log`
 * beside it; `--help` is answered (for a `claude`-named fake) and not logged. `body` is the shell that runs after
 * the log line: by default it prints `BRIEFING`.
 */
export function fakeCli(dir: string, name = "fake-provider", body = `printf '${BRIEFING.replace(/\n/g, "\\n")}'`): string {
  const p = join(dir, name);
  writeFileSync(p, `#!/bin/sh
case " $* " in *" --help "*) echo "--tools --setting-sources --strict-mcp-config"; exit 0;; esac
echo "$CLAUDE_CONFIG_DIR" >> "${join(dir, "spawns.log")}"
${body}
`, { mode: 0o755 });
  return p;
}

/** The config dirs each real invocation of the fakes in `dir` ran under, in order. */
export function spawnsIn(dir: string): string[] {
  try { return readFileSync(join(dir, "spawns.log"), "utf8").split("\n").slice(0, -1); } catch { return []; }
}

/** runCore deps for a deterministic walk: online, awake, no real sleeps, no retries unless a test asks. */
export function walkDeps(extra: Record<string, unknown> = {}) {
  return {
    netProbe: async () => true,
    powerPlatform: "linux" as NodeJS.Platform,
    sleep: async () => {},
    retryDelaysMs: [] as number[],
    ...extra,
  };
}
