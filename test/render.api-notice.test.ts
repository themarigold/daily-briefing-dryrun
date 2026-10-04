// test/render.api-notice.test.ts — v0.2.1 §2.3 (plan T1.1): the briefing leaves out the API transport's
// hardening carve-out sentence, and ONLY that sentence, by exact element match.
//
// The struct keeps it (posture readers read `struct.warnings`, never the rendered line), so every test
// here checks both halves: what renders, and that the data it rendered from is untouched.
import { test, expect, describe } from "bun:test";
import { renderBriefing, API_NOTICE_TEXTS } from "../src/render";
import { driftWarnings } from "../src/core";
import { AnthropicApiProvider } from "../src/providers/anthropic";
import { OpenAiCompatibleProvider } from "../src/providers/openaiCompatible";
import type { BriefingStruct } from "../src/types";
import { guardNetworkForThisFile } from "./helpers/netGuard";
// Tests may import eval code (spec §1); runtime code may not, which is why render.ts holds its own copy.
import { API_TRANSPORT_SENTINEL, API_CLEARTEXT_SENTINEL, posturePhrase } from "../src/eval/posture";

// Constructing a transport sends nothing (the carve-out is pushed in the constructor), but these are REAL
// API providers, so the file carries the same guard every API test file does.
guardNetworkForThisFile();

/** The two API transports exactly as `buildProvider` constructs them, one per `api.kind`. The openai one
 *  points at a plain-http NON-loopback host so it also raises the cleartext warning — a real, unrelated
 *  warning that must keep rendering beside the dropped one. */
const PROVIDERS = [
  { kind: "anthropic", make: () => new AnthropicApiProvider({ kind: "anthropic", model: "m" }, { env: {} }) },
  { kind: "openai-compatible", make: () => new OpenAiCompatibleProvider({ kind: "openai-compatible", model: "m", baseUrl: "http://gateway.example.invalid/v1" }, { env: {} }) },
] as const;

const struct = (warnings: string[] | undefined): BriefingStruct => ({
  date: "2026-10-03", machineScope: "mymac", provider: "anthropic-api (m)",
  resume: [], recap: [], suggestions: [{ text: "do y" }],
  ...(warnings ? { warnings } : {}),
});
const warnLines = (md: string) => md.split("\n").filter((l) => l.startsWith("⚠"));

describe("API_NOTICE_TEXTS", () => {
  test("two distinct sentences, one per api.kind, each naming its kind", () => {
    expect(API_NOTICE_TEXTS).toHaveLength(2);
    expect(new Set(API_NOTICE_TEXTS).size).toBe(2);
    for (const { kind } of PROVIDERS) expect(API_NOTICE_TEXTS.filter((t) => t.includes(`the ${kind} API provider`))).toHaveLength(1);
    expect(Object.isFrozen(API_NOTICE_TEXTS)).toBe(true);
  });

  test("PARITY: each provider's REAL carve-out warning equals one of them — the copy is pinned to the emission", () => {
    for (const { kind, make } of PROVIDERS) {
      const p = make();
      const carve = p.runtimeWarnings.filter((w) => w.includes(API_TRANSPORT_SENTINEL));
      expect(`${kind}: ${carve.length}`).toBe(`${kind}: 1`);
      expect(API_NOTICE_TEXTS).toContain(carve[0]!);
      // …the renderer drops exactly that element and keeps every other one…
      const md = renderBriefing(struct([...p.runtimeWarnings]));
      expect(md).not.toContain(API_TRANSPORT_SENTINEL);
      const others = p.runtimeWarnings.filter((w) => w !== carve[0]);
      expect(warnLines(md)).toEqual(others.length ? [`⚠ ${others.join("; ")}`] : []);
      // …and the posture the eval reads off the same warnings is unchanged.
      expect(posturePhrase(p.runtimeWarnings)).toBe("unhardened (api provider)");
    }
  });
});

describe("renderBriefing and the carve-out sentence", () => {
  test("an API run's struct renders no ⚠ line and no extra blank line — byte-identical to a run with no warnings", () => {
    for (const text of API_NOTICE_TEXTS) {
      const warnings = [text];
      const md = renderBriefing(struct(warnings));
      expect(warnLines(md)).toEqual([]);
      expect(md).toBe(renderBriefing(struct(undefined)));
      expect(md).toBe(renderBriefing(struct([])));
      expect(warnings).toEqual([text]);   // the struct still carries it: rendering filters, never mutates
    }
  });

  test("NEGATIVE: a drift warning whose embedded filename contains the sentence still renders", () => {
    // driftWarnings is the real emitter of the user-controlled-filename warning (git status output).
    const [drift] = driftWarnings([{ label: "r", was: ` M ${API_NOTICE_TEXTS[0]}.md`, now: "", resolved: [] }]);
    expect(drift).toContain(API_TRANSPORT_SENTINEL);   // PREMISE: the hostile text really is inside it
    const md = renderBriefing(struct([drift!]));
    expect(warnLines(md)).toEqual([`⚠ ${drift}`]);
    // A bare sentinel-phrase warning is not the sentence either.
    expect(warnLines(renderBriefing(struct(["no CLI process to harden"])))).toEqual(["⚠ no CLI process to harden"]);
  });

  test("near-misses are not dropped: a different kind, trailing whitespace, a prefix", () => {
    const t = API_NOTICE_TEXTS[0]!;
    for (const w of [t.replace("anthropic", "ollama"), `${t} `, ` ${t}`, `${t}.`, t.toUpperCase()]) {
      expect(warnLines(renderBriefing(struct([w])))).toHaveLength(1);
    }
  });

  test("MIXED: a real warning beside the sentence renders the real warning only", () => {
    const real = "invalid morningTime \"7am\" — using 07:20";
    for (const order of [[API_NOTICE_TEXTS[1]!, real], [real, API_NOTICE_TEXTS[1]!]]) {
      expect(warnLines(renderBriefing(struct(order)))).toEqual([`⚠ ${real}`]);
    }
    // Two real warnings around it keep their order and their "; " join.
    expect(warnLines(renderBriefing(struct(["a", API_NOTICE_TEXTS[0]!, "b"])))).toEqual(["⚠ a; b"]);
  });

  test("the plain-http cleartext warning still renders beside the dropped sentence", () => {
    const p = PROVIDERS[1].make();
    const md = renderBriefing(struct([...p.runtimeWarnings]));
    expect(md).toContain(API_CLEARTEXT_SENTINEL);   // PREMISE and assertion: the unrelated warning survives
    expect(warnLines(md)).toHaveLength(1);
  });
});
