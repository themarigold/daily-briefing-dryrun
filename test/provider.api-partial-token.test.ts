import "./fixtures/isolate-state";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnthropicApiProvider } from "../src/providers/anthropic";
import { OpenAiCompatibleProvider } from "../src/providers/openaiCompatible";
import { run } from "../src/main";
import type { RunEnvelope } from "../src/json";
import { buildRepo } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { guardNetworkForThisFile } from "./helpers/netGuard";

guardNetworkForThisFile();

const PARTIAL = "https://user:SECRETMARK";
const OUTPUT = "## RESUME\n- [demo] Keep working\n## RECAP\n- [demo] Finished setup | evidence: abc1234\n## SUGGESTIONS\n- Inspect " + PARTIAL;

for (const kind of ["anthropic", "openai-compatible"] as const) describe(`${kind} output-token limit`, () => {
  function provider(text: string, limited = true) {
    let requests = 0;
    const fetchImpl = (async () => {
      requests++;
      // Split the final URL across text blocks: completion safety must apply after concatenation.
      const body = kind === "anthropic"
        ? { content: [{ type: "text", text: text.slice(0, -4) }, { type: "text", text: text.slice(-4) }], stop_reason: limited ? "max_tokens" : "end_turn" }
        : { choices: [{ message: { content: text }, finish_reason: limited ? "length" : "stop" }] };
      return Response.json(body);
    }) as unknown as typeof fetch;
    const api = { kind, model: "test-model", baseUrl: "https://provider.example/v1", apiKeyEnv: "TEST_KEY", maxTokens: 32 };
    const opts = { env: { TEST_KEY: "opaque-test-key" }, fetchImpl };
    const p = kind === "anthropic" ? new AnthropicApiProvider(api, opts) : new OpenAiCompatibleProvider(api, opts);
    return { p, requests: () => requests };
  }

  for (const surface of ["rendered briefing", "run --json"] as const) test(`${surface} withholds the unfinished URL password`, async () => {
    const repo = await buildRepo([{ file: "a.txt", content: "a", isoDate: new Date(Date.now() - 864e5).toISOString() }]);
    const cfgHome = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-api-tail-cfg-")));
    const stateDir = removeAtRunEnd(mkdtempSync(join(tmpdir(), "dba-api-tail-state-")));
    mkdirSync(join(cfgHome, "daily-briefing"));
    writeFileSync(join(cfgHome, "daily-briefing", "config.json"), JSON.stringify({
      repos: [repo], excludeCommitPatterns: [], networkProbeHosts: [],
      provider: { api: { kind, model: "test-model", baseUrl: "https://provider.example/v1" } },
    }));
    const prevConfig = process.env.XDG_CONFIG_HOME, prevState = process.env.DAILY_BRIEFING_STATE_DIR;
    const log = console.log, error = console.error;
    const stdout: string[] = [], stderr: string[] = [];
    const { p, requests } = provider(OUTPUT);
    try {
      process.env.XDG_CONFIG_HOME = cfgHome;
      process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
      console.log = (...args: unknown[]) => { stdout.push(args.map(String).join(" ")); };
      console.error = (...args: unknown[]) => { stderr.push(args.map(String).join(" ")); };
      expect(await run(true, { provider: p, netProbe: async () => true, retryDelaysMs: [] }, { json: surface === "run --json" })).toBe(0);
    } finally {
      console.log = log; console.error = error;
      process.env.XDG_CONFIG_HOME = prevConfig;
      process.env.DAILY_BRIEFING_STATE_DIR = prevState;
    }
    expect(requests()).toBe(1); // the real provider ran; a quiet-window fallback cannot pass
    const printed = stdout.join("\n");
    const markdown = surface === "run --json" ? (JSON.parse(printed) as RunEnvelope).markdown : printed;
    expect(markdown).toContain("Inspect");
    expect(markdown).toContain("output-token limit");
    expect(markdown).not.toContain("SECRETMARK");
    expect(printed).not.toContain("SECRETMARK");
    expect(stderr.join("\n")).not.toContain("SECRETMARK");
    expect(readFileSync(join(stateDir, "briefing-latest.md"), "utf8")).toBe(markdown);
    if (surface === "run --json") {
      const envelope = JSON.parse(printed) as RunEnvelope;
      expect(envelope.struct!.suggestions.some((s) => s.text.includes("Inspect"))).toBe(true);
    }
  }, 30_000);

  test("withholding the only token is empty-output, and still warns once", async () => {
    const { p } = provider(PARTIAL);
    for (let i = 0; i < 2; i++) await expect(p.generate("x")).rejects.toMatchObject({ code: "empty-output" });
    expect(p.runtimeWarnings.filter((w) => w.includes("output-token limit"))).toHaveLength(1);
  });

  test("trailing whitespace proves the last token complete", async () => {
    const text = "keep the final-token \n";
    expect(await provider(text).p.generate("x")).toBe(text);
  });

  test("a complete completion keeps its final token without whitespace", async () => {
    const { p } = provider("keep the final-token", false);
    expect(await p.generate("x")).toBe("keep the final-token");
    expect(p.runtimeWarnings.some((w) => w.includes("output-token limit"))).toBe(false);
  });
});
