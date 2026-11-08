// test/render.notices.test.ts — the notice lines above the title (provider-fallback plan P1-M9-T3; spec r9 §5
// Reporting "Lines above the title"): rendered above `☀️  Daily briefing —`, so `lastBriefing` slices them away;
// in briefing.log exactly once (the render carries them; stderr gets a copy only under `--json`); control-stripped
// and redacted; a single-entry render is unchanged.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, beforeAll } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderBriefing } from "../src/render";
import { lastBriefing } from "../src/audit";
import { run } from "../src/main";
import { NOTICE_PREFIX } from "../src/failover";
import type { BriefingStruct } from "../src/types";
import { buildRepo } from "./fixtures/build-repo";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { fakeCli, freshStateDir, tempDir, walkDeps } from "./helpers/walk";

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

const struct = (extra: Partial<BriefingStruct> = {}): BriefingStruct => ({
  date: "2026-10-16", machineScope: "mac", provider: "claude",
  resume: [{ repo: "app", text: "resume here" }], recap: [{ repo: "app", text: "did x" }], suggestions: [{ repo: "app", text: "do y" }],
  ...extra,
} as BriefingStruct);

describe("renderBriefing", () => {
  test("notices render above the title, and lastBriefing slices them away", () => {
    const notices = [`${NOTICE_PREFIX}Skipped "A": unreachable — used "B"`, `${NOTICE_PREFIX}Generated using "B" — API charges may apply.`];
    const text = renderBriefing(struct({ notices }));
    const lines = text.split("\n");
    expect(lines.slice(0, 2)).toEqual(notices);
    expect(lines[2]).toBe("");
    expect(lines[3]).toStartWith("☀️  Daily briefing — ");
    const sliced = lastBriefing(`older log line\n${text}`);
    expect(sliced).toStartWith("☀️  Daily briefing — ");
    for (const n of notices) expect(sliced).not.toContain(n);
  });

  test("control characters in a notice (a label) are stripped", () => {
    const text = renderBriefing(struct({ notices: [`${NOTICE_PREFIX}Skipped "Lo\u001b[31mcal\u0007": unreachable — used "B"`] }));
    expect(text.split("\n")[0]).toBe(`${NOTICE_PREFIX}Skipped "Lo[31mcal": unreachable — used "B"`);
  });

  test("no notices: byte-identical to the render without the field", () => {
    expect(renderBriefing(struct({ notices: undefined }))).toBe(renderBriefing(struct()));
    expect(renderBriefing(struct()).split("\n")[0]).toStartWith("☀️  Daily briefing — ");
  });
});

describe("through run(): briefing.log holds each notice once", () => {
  const KEYISH = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
  /** item 1 fails; the fallback — a CLI given the env key, so it carries the cost line — delivers. */
  function configure(): void {
    const dir = tempDir("dba-notice-");
    const home = tempDir("dba-notice-cfg-");
    mkdirSync(join(home, "daily-briefing"), { recursive: true });
    writeFileSync(join(home, "daily-briefing", "config.json"), JSON.stringify({ repos: [repo],
      provider: { cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false },
      fallbacks: [{ label: `Env ${KEYISH}`, cli: fakeCli(dir), argv: [], promptVia: "stdin", credential: "env-api-key" }] }));
    process.env.XDG_CONFIG_HOME = home;
  }
  /** stdout and stderr in ONE ordered stream, as launchd writes briefing.log. */
  async function log(out: { json?: boolean }): Promise<{ all: string[]; err: string[]; stdout: string[] }> {
    const all: string[] = [], err: string[] = [], stdout: string[] = [];
    const e = console.error, l = console.log;
    console.error = (...a: unknown[]) => { const s = a.map(String).join(" "); all.push(s); err.push(s); };
    console.log = (...a: unknown[]) => { const s = a.map(String).join(" "); all.push(s); stdout.push(s); };
    try { expect(await run(true, walkDeps(), out)).toBe(0); } finally { console.error = e; console.log = l; }
    return { all, err, stdout };
  }
  const occurrences = (lines: string[], needle: string) => lines.join("\n").split(needle).length - 1;

  test("without --json: the render carries the notices, stderr does not — once each", async () => {
    freshStateDir();
    configure();
    const { all, err } = await log({});
    for (const needle of ['Skipped "default": unrecognised CLI failure', "API charges may apply."]) {
      expect(`${needle}: ${occurrences(all, needle)}`).toBe(`${needle}: 1`);
      expect(occurrences(err, needle)).toBe(0);
    }
    expect(all.join("\n")).not.toContain(KEYISH);                  // the redactor ran over the notice lines
  });

  test("with --json: stdout is the envelope, so stderr carries the notices", async () => {
    freshStateDir();
    configure();
    const { err } = await log({ json: true });
    expect(occurrences(err, 'Skipped "default": unrecognised CLI failure')).toBe(1);
    expect(occurrences(err, "API charges may apply.")).toBe(1);
    expect(err.join("\n")).not.toContain(KEYISH);
  });
});
