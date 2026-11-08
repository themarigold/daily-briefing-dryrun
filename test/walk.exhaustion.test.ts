// test/walk.exhaustion.test.ts — the list exhausted (spec r9 §5 step 7), `CoreResult.attempts`, the notice strings and
// the aggregate failure (provider-fallback plan P1-M7-T2).
//
// Real provider stack against fake CLIs and fake loopback servers, plus the pure wording functions in src/failover.ts.
import "./fixtures/isolate-state";
import { test, expect, describe, afterAll, afterEach, beforeAll, spyOn } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { costLine, insecureEndpoint, runCore, type CoreResult } from "../src/core";
import { APP_KEY_SERVICE, SECURITY_BIN } from "../src/providerList";
import { limitedSkipMessage } from "../src/main";
import { redactCredentials } from "../src/transcripts/credentials";
import { accountStatePath, PROBE_MS } from "../src/account";
import { aggregateFailureMessage, formatResetTime, noticeLines, NOTICE_PREFIX, unusableAnswerMessage } from "../src/failover";
import { ProviderError, type Attempt, type Config, type Provider } from "../src/types";
import { buildRepo } from "./fixtures/build-repo";
import { startFakeApi, okJson, status, type FakeApi } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";
import { BRIEFING, fakeCli, freshStateDir, spawnsIn, tempDir, walkDeps } from "./helpers/walk";

guardNetworkForThisFile();

let repo = "";
const prevState = process.env.DAILY_BRIEFING_STATE_DIR;
beforeAll(async () => {
  repo = await buildRepo([{ file: "a.ts", content: "one", isoDate: new Date(Date.now() - 86400e3).toISOString() }]);
});
afterAll(() => { process.env.DAILY_BRIEFING_STATE_DIR = prevState; });
const servers: FakeApi[] = [];
afterEach(async () => { while (servers.length) await servers.pop()!.stop(); });
const serve = async (h: Parameters<typeof startFakeApi>[0]) => { const s = await startFakeApi(h); servers.push(s); return s; };

const chatOk = () => okJson({ choices: [{ index: 0, message: { role: "assistant", content: BRIEFING }, finish_reason: "stop" }] });
const local = (label: string, origin: string) => ({ label, api: { kind: "openai-compatible", model: "llama3", baseUrl: `${origin}/v1` } });
const NOW = new Date("2026-08-24T12:00:00-07:00");
/** A claude-named fake: `okDir` delivers; a dir ending `-u` prints an UNPARSED wall; any other dir a parsed wall
 *  (Aug 25 9pm for `-b`, Aug 26 10pm otherwise). */
function walledClaude(dir: string, okDir = "/nowhere"): string {
  return fakeCli(dir, "claude", `if [ "$CLAUDE_CONFIG_DIR" = "${okDir}" ]; then printf '${BRIEFING.replace(/\n/g, "\\n")}'; exit 0; fi
case "$CLAUDE_CONFIG_DIR" in
  *-u) echo "You've hit your weekly limit · resets whenever"; exit 1;;
  *-b) echo "You've hit your weekly limit · resets Aug 25 at 9pm (America/Los_Angeles)"; exit 1;;
  *)   echo "You've hit your weekly limit · resets Aug 26 at 10pm (America/Los_Angeles)"; exit 1;;
esac`);
}
type MarkSpec = { reason: string; isProbe?: boolean; until?: string };
function seedMarks(d: string, accounts: Record<string, MarkSpec>): void {
  mkdirSync(d, { recursive: true });
  const out: Record<string, unknown> = {};
  for (const [label, m] of Object.entries(accounts)) {
    out[label] = { limitedUntil: m.until ?? new Date(NOW.getTime() + PROBE_MS).toISOString(), isProbe: m.isProbe ?? m.reason !== "usage", reason: m.reason };
  }
  writeFileSync(accountStatePath(d), JSON.stringify({ accounts: out }));
}
const deps = (extra: Record<string, unknown> = {}) => walkDeps({ now: () => NOW, ...extra });
const caught = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a rejection"); }, (e) => e as ProviderError);

describe("the wording (pure)", () => {
  test("formatResetTime: local HH:MM today, Ddd HH:MM on a later day", () => {
    const now = new Date(2026, 9, 16, 8, 0);                         // Fri 16 Oct, local
    expect(formatResetTime(new Date(2026, 9, 16, 9, 5).toISOString(), now)).toBe("09:05");
    expect(formatResetTime(new Date(2026, 9, 17, 7, 30).toISOString(), now)).toBe("Sat 07:30");
    expect(formatResetTime(new Date(2026, 9, 20, 23, 59).toISOString(), now)).toBe("Tue 23:59");
  });

  test("the four notice shapes, the dropped line and the cost line", () => {
    const now = new Date(2026, 9, 16, 8, 0);
    const at = (h: number, m: number) => new Date(2026, 9, 16, h, m).toISOString();
    const attempts: Attempt[] = [
      { label: "Anthropic key", kind: "anthropic", outcome: "failed", reason: "auth", httpStatus: 401 },
      { label: "Claude login 1", kind: "cli", outcome: "skipped-by-mark", reason: "usage", until: at(9, 0) },
      { label: "Other key", kind: "openai-compatible", outcome: "skipped-by-mark", reason: "not-found", until: at(9, 30) },
      { label: "Old login", kind: "cli", outcome: "skipped-by-mark", reason: "earlier-failure", until: at(8, 45) },
      { label: "Local model", kind: "invalid", outcome: "dropped", reason: "bad-shape" },
      { label: "Claude login 2", kind: "cli", outcome: "won" },
      { label: "Later", kind: "cli", outcome: "not-reached" },
    ];
    expect(noticeLines(attempts, "Claude login 2", now, 'Generated using "Claude login 2" — API charges may apply.')).toEqual([
      'ℹ︎ Skipped "Anthropic key": key or login rejected — used "Claude login 2"',
      'ℹ︎ Not tried "Claude login 1": out of usage until 09:00',
      'ℹ︎ Not tried "Other key": paused until 09:30 after model or endpoint not found',
      'ℹ︎ Not tried "Old login": paused until 08:45 after earlier failures',
      'ℹ︎ Not tried "Local model": invalid entry — not a valid provider entry, fix it in Settings',
      'ℹ︎ Generated using "Claude login 2" — API charges may apply.',
    ]);
    expect(NOTICE_PREFIX).toBe("ℹ︎ ");
  });

  test("the aggregate message: the count line first (tried entries only), then one line per tried, skipped and dropped entry", () => {
    const now = new Date(2026, 9, 16, 8, 0);
    const m = aggregateFailureMessage([
      { label: "A", kind: "cli", outcome: "failed", reason: "cli-failure" },
      { label: "B", kind: "anthropic", outcome: "failed", reason: "rejected-request", httpStatus: 400 },
      { label: "C", kind: "cli", outcome: "skipped-by-mark", reason: "usage", until: new Date(2026, 9, 17, 6, 0).toISOString() },
    ], now).split("\n");
    expect(m).toEqual([
      "2 providers failed — open Settings → Providers",
      'Failed "A": unrecognised CLI failure',
      'Failed "B": request rejected (HTTP 400)',
      'Not tried "C": out of usage until Sat 06:00',
    ]);
  });
});

describe("the exhaustion table, through runCore", () => {
  test("one tried, one mark-skipped and one dropped: \"1 provider failed\" with three lines after it, attempts in list order", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-ex-");
    seedMarks(d, { Benched: { reason: "usage", isProbe: false } });
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "fail-cli", "echo down 1>&2; exit 1"), argv: [], promptVia: "stdin", harden: false },
      fallbacks: [local("Benched", "http://127.0.0.1:9"), { label: "Broken" }] } as unknown as Config;
    const e = await caught(runCore(cfg, deps()));
    expect(e).toBeInstanceOf(ProviderError);
    expect(e.code).toBe("nonzero-exit");                     // the last attempt's code
    const lines = e.message.split("\n");
    expect(lines[0]).toBe("1 provider failed — open Settings → Providers");
    expect(lines[0]!.length).toBeLessThanOrEqual(180);
    expect(lines.slice(1)).toEqual([
      'Failed "default": unrecognised CLI failure',
      `Not tried "Benched": out of usage until ${formatResetTime(new Date(NOW.getTime() + PROBE_MS).toISOString(), NOW)}`,
      'Not tried "Broken": invalid entry — not a valid provider entry, fix it in Settings',
    ]);
    expect(e.attempts?.map((a) => [a.label, a.outcome, a.reason])).toEqual([
      ["default", "failed", "cli-failure"], ["Benched", "skipped-by-mark", "usage"], ["Broken", "dropped", "bad-shape"],
    ]);
    expect(e.net).toBeDefined();
    expect(e.warnings?.some((w) => w.includes("Broken"))).toBe(true);   // the drop warning rides along
  });

  test("row 1: both logins walled in ONE walk — limited, exhausted, allOutOfUsage, the earliest parsed reset", async () => {
    freshStateDir();
    const dir = tempDir("dba-ex-");
    const cfg = { repos: [repo], provider: { cli: walledClaude(dir), argv: [], promptVia: "stdin", harden: false,
      accounts: [{ label: "A", configDir: `${dir}/a` }, { label: "B", configDir: `${dir}/x-b` }] } } as unknown as Config;
    const r = await runCore(cfg, deps());
    expect([r.skipReason, r.offlineSkipped]).toEqual(["limited", true]);
    expect(r.limited?.exhausted).toBe(true);
    expect(r.limited?.allOutOfUsage).toBe(true);
    expect(r.limited?.label).toBe("B");                       // Aug 25 9pm is earlier than A's Aug 26 10pm
    expect(r.limited?.isProbe).toBe(false);
    expect(r.attempts?.map((a) => [a.label, a.outcome, a.reason])).toEqual([["A", "failed", "usage"], ["B", "failed", "usage"]]);
    const [a, b] = r.attempts!;
    expect(r.limited?.until).toBe(b!.until!);                 // B's own reset, with B's label
    expect(Date.parse(b!.until!)).toBeLessThan(Date.parse(a!.until!));
  });

  test("row 1: one parsed and one unparsed wall give until = the parsed reset and isProbe: true", async () => {
    freshStateDir();
    const dir = tempDir("dba-ex-");
    const cfg = { repos: [repo], provider: { cli: walledClaude(dir), argv: [], promptVia: "stdin", harden: false,
      accounts: [{ label: "A", configDir: `${dir}/a` }, { label: "U", configDir: `${dir}/x-u` }] } } as unknown as Config;
    const r = await runCore(cfg, deps());
    expect(r.limited?.allOutOfUsage).toBe(true);
    expect(r.limited?.label).toBe("A");
    expect(r.limited?.isProbe).toBe(true);
    expect(r.limited?.until).toBe(r.attempts![0]!.until!);   // A's parsed reset, though U's probe deadline is sooner
  });

  test("row 1: a single-entry config walled is allOutOfUsage too; so is a walk where every entry was already benched by usage", async () => {
    freshStateDir();
    const dir = tempDir("dba-ex-");
    const r = await runCore({ repos: [repo], provider: { cli: walledClaude(dir), argv: [], promptVia: "stdin", harden: false } } as unknown as Config, deps());
    expect([r.skipReason, r.limited?.exhausted, r.limited?.allOutOfUsage]).toEqual(["limited", true, true]);
    const d2 = freshStateDir();
    const later = new Date(NOW.getTime() + 5 * 3600e3).toISOString(), sooner = new Date(NOW.getTime() + 2 * 3600e3).toISOString();
    seedMarks(d2, { default: { reason: "usage", isProbe: false, until: later }, Local: { reason: "usage", isProbe: false, until: sooner } });
    const dir2 = tempDir("dba-ex-");
    const r2 = await runCore({ repos: [repo], provider: { cli: fakeCli(dir2), argv: [], promptVia: "stdin" }, fallbacks: [local("Local", "http://127.0.0.1:9")] } as unknown as Config, deps());
    expect([r2.skipReason, r2.limited?.allOutOfUsage, r2.limited?.label, r2.limited?.until]).toEqual(["limited", true, "Local", sooner]);
    expect(r2.attempts?.map((a) => a.outcome)).toEqual(["skipped-by-mark", "skipped-by-mark"]);
    expect(spawnsIn(dir2)).toEqual([]);
  });

  test("row 3, nothing tried: usage plus an hour mark is \"paused\" until the earliest hour-mark end, with no spawn", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-ex-");
    const hourEnd = new Date(NOW.getTime() + 40 * 60e3).toISOString();
    seedMarks(d, { A: { reason: "usage", isProbe: false, until: new Date(NOW.getTime() + 9 * 3600e3).toISOString() }, B: { reason: "auth", until: hourEnd } });
    const cfg = { repos: [repo], provider: { cli: walledClaude(dir), argv: [], promptVia: "stdin",
      accounts: [{ label: "A", configDir: `${dir}/a` }, { label: "B", configDir: `${dir}/b` }] } } as unknown as Config;
    const r = await runCore(cfg, deps());
    expect(r.paused).toEqual({ until: hourEnd });
    expect(r.limited).toBeUndefined();
    expect(r.skipReason).toBeUndefined();
    expect(r.attempts?.map((a) => [a.label, a.outcome, a.reason])).toEqual([["A", "skipped-by-mark", "usage"], ["B", "skipped-by-mark", "auth"]]);
    expect(spawnsIn(dir)).toEqual([]);
  });

  test("row 3 with an attempt: a fresh wall plus a failure is the aggregate error, not limited", async () => {
    freshStateDir();
    const dir = tempDir("dba-ex-");
    const s401 = await serve(status(401, { error: { message: "no" } }));
    const cfg = { repos: [repo], provider: { cli: walledClaude(dir), argv: [], promptVia: "stdin", harden: false }, fallbacks: [local("Local", s401.origin)] } as unknown as Config;
    const e = await caught(runCore(cfg, deps()));
    expect(e.message.split("\n")[0]).toBe("2 providers failed — open Settings → Providers");
    expect(e.attempts?.map((a) => a.reason)).toEqual(["usage", "auth"]);
  });

  test("row 2: the last entry's unusable answer returns its rawText, and builds NO notices (round 3 L10: nothing was delivered)", async () => {
    freshStateDir();
    const dir = tempDir("dba-ex-");
    const s500 = await serve(status(500, {}));
    const cfg = { repos: [repo], provider: { api: { kind: "openai-compatible", model: "m", baseUrl: `${s500.origin}/v1` }, cli: "openai-compatible", argv: [], promptVia: "stdin" },
      fallbacks: [{ label: "Prose", cli: fakeCli(dir, "prose-cli", "echo 'No briefing today.'"), argv: [], promptVia: "stdin" }] } as unknown as Config;
    const r = await runCore(cfg, deps());
    expect(r.rawText).toContain("No briefing today.");
    expect(r.attempts?.map((a) => [a.label, a.outcome, a.reason])).toEqual([["default", "failed", "unreachable"], ["Prose", "failed", "unusable-answer"]]);
    // INVERTED by PR 1 final review round 3, L10: this used to pin `— used "Prose"` for the run that delivered nothing.
    expect("notices" in r.struct).toBe(false);
  });
});

describe("attempts and notices on a delivered walk", () => {
  test("won, failed, skipped-by-mark, dropped and not-reached, in list order; the notices built from them", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-ex-");
    const s404 = await serve(status(404, {})), ok = await serve(chatOk());
    seedMarks(d, { Benched: { reason: "auth" } });
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false },
      fallbacks: [local("Missing", s404.origin), local("Benched", "http://127.0.0.1:9"), { label: "Broken" }, local("Ok", ok.origin), local("Spare", "http://127.0.0.1:9")] } as unknown as Config;
    const r = await runCore(cfg, deps());
    expect(r.account).toBe("Ok");
    expect(r.attempts?.map((a) => [a.label, a.outcome, a.reason ?? null])).toEqual([
      ["default", "failed", "cli-failure"], ["Missing", "failed", "not-found"], ["Benched", "skipped-by-mark", "auth"],
      ["Broken", "dropped", "bad-shape"], ["Ok", "won", null], ["Spare", "not-reached", null],
    ]);
    expect(r.attempts?.find((a) => a.label === "Missing")?.httpStatus).toBe(404);
    expect(r.attempts?.map((a) => a.kind)).toEqual(["cli", "openai-compatible", "openai-compatible", "invalid", "openai-compatible", "openai-compatible"]);
    expect(r.struct.notices).toEqual([
      'ℹ︎ Skipped "default": unrecognised CLI failure — used "Ok"',
      'ℹ︎ Skipped "Missing": model or endpoint not found — used "Ok"',
      `ℹ︎ Not tried "Benched": paused until ${formatResetTime(new Date(NOW.getTime() + PROBE_MS).toISOString(), NOW)} after key or login rejected`,
      'ℹ︎ Not tried "Broken": invalid entry — not a valid provider entry, fix it in Settings',
    ]);
    expect(r.limited).toBeUndefined();
  });

  test("a single-entry struct has NO notices key (absent, never []); a clean two-entry walk has none either", async () => {
    freshStateDir();
    const dir = tempDir("dba-ex-");
    const r = await runCore({ repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" } } as unknown as Config, deps());
    expect("notices" in r.struct).toBe(false);
    expect(r.attempts?.map((a) => a.outcome)).toEqual(["won"]);
    // …even when the winner has a cost line: a single entry's CLI given the env key (costLine is defined for it).
    const rc = await runCore({ repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin", credential: "env-api-key" } } as unknown as Config, deps());
    expect(rc.rawText).toBe(BRIEFING);
    expect("notices" in rc.struct).toBe(false);
    const r2 = await runCore({ repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" }, fallbacks: [local("Spare", "http://127.0.0.1:9")] } as unknown as Config, deps());
    expect("notices" in r2.struct).toBe(false);
  });

  test("an API winner's cost line is the last notice", async () => {
    freshStateDir();
    const ok = await serve(chatOk());
    const cfg = { repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin", harden: false },
      fallbacks: [{ label: "Remote", api: { kind: "openai-compatible", model: "m", baseUrl: `${ok.origin}/v1` } }] } as unknown as Config;
    // A loopback server is "local", so no cost line; the remote case is the pure test above. This pins that a local
    // winner gets none and that the not-installed item 1 is reported.
    const r = await runCore(cfg, deps());
    expect(r.struct.notices).toEqual(['ℹ︎ Skipped "default": CLI not installed — used "Remote"']);
  });

  test("an injected provider: no attempts, no notices", async () => {
    freshStateDir();
    const injected: Provider = { generate: async () => BRIEFING };
    const r = await runCore({ repos: [repo], provider: { cli: "/nonexistent/x", argv: [], promptVia: "stdin" }, fallbacks: [local("L", "http://127.0.0.1:9")] } as unknown as Config, deps({ provider: injected }));
    expect(r.attempts).toBeUndefined();
    expect("notices" in r.struct).toBe(false);
  });

  test("no other result sets allOutOfUsage: an offline skip, a delivery, a paused result", async () => {
    freshStateDir();
    const dir = tempDir("dba-ex-");
    const results: CoreResult[] = [
      await runCore({ repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" } } as unknown as Config, deps({ netProbe: async () => false, netGraceMs: 20, netPollMs: 10 })),
      await runCore({ repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" } } as unknown as Config, deps()),
    ];
    for (const r of results) expect(r.limited?.allOutOfUsage).toBeUndefined();
    expect(results[0]!.skipReason).toBe("offline");
  });
});

describe("P1-M7 checkpoint: marks found at walk start", () => {
  test("a usage mark with an UNPARSED reset gives isProbe: true, and the limited line states no time", async () => {
    const d = freshStateDir();
    seedMarks(d, { default: { reason: "usage", isProbe: true, until: new Date(NOW.getTime() + 3600e3).toISOString() } });
    const r = await runCore({ repos: [repo], provider: { cli: fakeCli(tempDir("dba-ex-")), argv: [], promptVia: "stdin" } } as unknown as Config, deps());
    expect([r.skipReason, r.limited?.allOutOfUsage, r.limited?.isProbe]).toEqual(["limited", true, true]);
    expect(limitedSkipMessage(r.limited)).not.toContain("until");
  });

  test("paused: the EARLIEST of several hour-mark ends", async () => {
    const d = freshStateDir();
    const dir = tempDir("dba-ex-");
    const later = new Date(NOW.getTime() + 50 * 60e3).toISOString(), sooner = new Date(NOW.getTime() + 20 * 60e3).toISOString();
    seedMarks(d, { A: { reason: "usage", isProbe: false, until: new Date(NOW.getTime() + 9 * 3600e3).toISOString() },
      B: { reason: "auth", until: later }, C: { reason: "not-found", until: sooner } });
    const cfg = { repos: [repo], provider: { cli: walledClaude(dir), argv: [], promptVia: "stdin",
      accounts: [{ label: "A", configDir: `${dir}/a` }, { label: "B", configDir: `${dir}/b` }, { label: "C", configDir: `${dir}/c` }] } } as unknown as Config;
    expect((await runCore(cfg, deps())).paused).toEqual({ until: sooner });
  });
});

test("the row-2 first line strips control bytes from the label and stays within 180 characters (P1-M8 checkpoint LOW 8)", () => {
  const now = new Date(2026, 9, 16, 8, 0);
  const evil = "Lo\u001b[31mcal\nmodel" + "x".repeat(300);
  const first = unusableAnswerMessage([{ label: evil, kind: "cli", outcome: "failed", reason: "unusable-answer" }], evil, now).split("\n")[0]!;
  expect(first).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
  expect(first.length).toBeLessThanOrEqual(180);
  // Round 2 (Q25 extended): a control character masks the whole label; a long ordinary label is still cut.
  expect(first).toBe('"[redacted label]" returned no usable briefing — open Settings → Providers');
  const long = unusableAnswerMessage([], "x".repeat(300), now).split("\n")[0]!;
  expect(long.length).toBeLessThanOrEqual(180);
  expect(long).toEndWith('…" returned no usable briefing — open Settings → Providers');
  expect(unusableAnswerMessage([], "Prose", now)).toBe('"Prose" returned no usable briefing — open Settings → Providers');
});

describe("P1-M9 checkpoint: labels in every notice, failure detail and entry line", () => {
  const KEY = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
  const LINK = "https://calendar.google.com/calendar/ical/me%40example.org/private-0123456789abcdef/basic.ics";
  const now = new Date(2026, 9, 16, 8, 0);
  const attempts = (label: string): Attempt[] => [
    { label, kind: "cli", outcome: "failed", reason: "cli-failure" },
    { label: `${label} 2`, kind: "cli", outcome: "skipped-by-mark", reason: "usage", until: new Date(2026, 9, 16, 9, 0).toISOString() },
    { label: "Last", kind: "cli", outcome: "failed", reason: "unusable-answer" },
  ];
  const surfaces = (label: string): string[] => [
    ...noticeLines(attempts(label), "Last", now),
    aggregateFailureMessage(attempts(label), now),
    unusableAnswerMessage(attempts(label), "Last", now),
    unusableAnswerMessage([], `${"x".repeat(90)} ${label}`, now),          // a long label, truncated AFTER redaction
  ];

  test("a key-shaped label is redacted in full — no prefix survives truncation (codex MED 1)", () => {
    for (const text of surfaces(KEY)) {
      expect(text).not.toContain("sk-ant-api03-Zq9x");
      expect(text).not.toContain("Zq9xR2bT7mVwK4pL");
    }
    const first = unusableAnswerMessage([], `${"x".repeat(90)} ${KEY}`, now);
    expect(redactCredentials(first)).toBe(first);                         // nothing left for the file redactor to find
  });

  test("the cost line carries the safe label", () => {
    const entry = { label: `Key ${KEY} ${LINK}`, source: "fallback", provider: { api: { kind: "anthropic", model: "m", baseUrl: "https://api.example/v1" } }, timeoutMs: 1, isLoopback: false };
    const line = costLine(entry as never)!;
    expect(line).not.toContain("Zq9xR2bT7mVwK4pL");
    expect(line).not.toContain("calendar.google.com");
  });

  test("an exhausted walk's aggregate diagnostics carry the safe label (P1-M10 checkpoint LOW 1)", async () => {
    freshStateDir();
    const dir = tempDir("dba-ex-");
    const s401 = await serve(status(401, { error: { message: "no" } }));
    const cfg = { repos: [repo], provider: { cli: fakeCli(dir, "fail-cli", "exit 1"), argv: [], promptVia: "stdin", harden: false },
      fallbacks: [{ label: `Key ${KEY} ${LINK}`, api: { kind: "openai-compatible", model: "m", baseUrl: `${s401.origin}/v1` } }] } as unknown as Config;
    const e = await caught(runCore(cfg, deps()));
    expect(e.diagnostics?.length).toBe(2);                         // the premise: the line for that entry exists
    const text = JSON.stringify(e.diagnostics);
    expect(text).not.toContain("Zq9xR2bT7mVwK4pL");
    expect(text).not.toContain("calendar.google.com");
  });

  test("the insecure-endpoint refusal and the limited line carry the safe label (hub Q25 (2))", () => {
    const entry = { label: `Key ${KEY} ${LINK}`, source: "fallback", isLoopback: false, timeoutMs: 1,
      provider: { api: { kind: "anthropic", model: "m", baseUrl: "http://llm.example/v1", apiKeyCommand: [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-w"] } } };
    const refused = insecureEndpoint(entry as never)!;
    expect(refused.failCause).toBe("insecure-endpoint");                // the premise: the rule fired
    const line = limitedSkipMessage({ label: entry.label, until: "", isProbe: true, exhausted: true });
    for (const t of [refused.message, line]) {
      expect(t).not.toContain("Zq9xR2bT7mVwK4pL");
      expect(t).not.toContain("calendar.google.com");
    }
  });

  test("a control byte INSIDE a key or a calendar link cannot hide it from the redactor (P1-M10 checkpoint MED 1)", () => {
    for (const ctl of ["\t", "\n", "\u0007"]) {
      const splitKey = `${KEY.slice(0, 16)}${ctl}${KEY.slice(16)}`;
      const splitLink = `${LINK.slice(0, 20)}${ctl}${LINK.slice(20)}`;
      const texts = [
        unusableAnswerMessage([], `${"x".repeat(95)} ${splitKey}`, now),
        unusableAnswerMessage([], `${"x".repeat(95)} ${splitLink}`, now),
        aggregateFailureMessage([{ label: `A ${splitKey}`, kind: "cli", outcome: "failed", reason: "cli-failure" }, { label: `B ${splitLink}`, kind: "cli", outcome: "failed", reason: "cli-failure" }], now),
      ];
      for (const t of texts.map(redactCredentials)) {
        expect(`${JSON.stringify(ctl)}: ${t.includes("Zq9xR2bT7mVw")}`).toBe(`${JSON.stringify(ctl)}: false`);
        expect(`${JSON.stringify(ctl)}: ${t.includes("calendar.google")}`).toBe(`${JSON.stringify(ctl)}: false`);
      }
    }
  });

  test("a calendar link used as a label is scrubbed everywhere (codex MED 2)", () => {
    for (const text of surfaces(LINK)) {
      expect(text).not.toContain("calendar.google.com");
      expect(text).not.toContain("private-0123456789abcdef");
    }
  });

  test("labels on the entry lines (2 and up) are control-stripped too, and an emoji survives truncation whole (Opus 4, 5)", () => {
    const body = aggregateFailureMessage(attempts("Lo\u001b[31mcal\u0007"), now).split("\n").slice(1).join("\n");
    expect(body).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    const emoji = "🙂".repeat(200);
    const first = unusableAnswerMessage([], emoji, now).split("\n")[0]!;
    expect(first).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);   // no lone surrogate
    expect(JSON.stringify(first)).not.toMatch(/\\ud[89ab][0-9a-f]{2}(?!\\ud[c-f])/i);
    expect(Array.from(first).length).toBeLessThanOrEqual(180);
  });
});

describe("PR 1 final review round 1: labels", () => {
  const KEY = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
  const now = new Date(2026, 9, 16, 8, 0);
  test("M1: a control byte BETWEEN a word and a key, or AFTER a key, cannot join it into something the redactor misses", async () => {
    const { safeLabel, MASKED_LABEL } = await import("../src/failover");
    const cases = [`Work\t${KEY}`, "AKIAIOSFODNN7EXAMPLE\u0001Q", "Cal\nhttps://calendar.google.com/calendar/ical/x/private-abc/basic.ics", `Work\u0007${KEY}`];
    for (const label of cases) {
      const out = safeLabel(label);
      expect(`${JSON.stringify(label)} → ${out}`).toBe(`${JSON.stringify(label)} → ${MASKED_LABEL}`);
      for (const t of [unusableAnswerMessage([], label, now), aggregateFailureMessage([{ label, kind: "cli", outcome: "failed", reason: "cli-failure" }], now)]) {
        expect(t).not.toContain("Zq9xR2bT7mVw");
        expect(t).not.toContain("AKIAIOSFODNN7EXAMPLE");
        expect(t).not.toContain("calendar.google");
      }
    }
    expect(safeLabel("Plain\tlabel")).toBe(MASKED_LABEL);             // round 2 (Q25 extended): any control character masks
    expect(safeLabel("Claude login 2")).toBe("Claude login 2");
  });

  test("L2: a dropped duplicate-label twin of the winner keeps its 'invalid entry' line", () => {
    const attempts: Attempt[] = [
      { label: "A", kind: "cli", outcome: "failed", reason: "cli-failure" },
      { label: "B", kind: "cli", outcome: "won" },
      { label: "B", kind: "invalid", outcome: "dropped", reason: "duplicate-label" },
    ];
    expect(noticeLines(attempts, "B", now)).toEqual([
      'ℹ︎ Skipped "A": unrecognised CLI failure — used "B"',
      'ℹ︎ Not tried "B": invalid entry — its label is already used by an earlier entry, fix it in Settings',
    ]);
    const row2: Attempt[] = [{ label: "A", kind: "cli", outcome: "failed", reason: "cli-failure" }, { label: "Last", kind: "cli", outcome: "failed", reason: "unusable-answer" },
      { label: "Last", kind: "invalid", outcome: "dropped", reason: "duplicate-label" }];
    expect(unusableAnswerMessage(row2, "Last", now).split("\n").slice(1)).toEqual([
      'Failed "A": unrecognised CLI failure',
      'Not tried "Last": invalid entry — its label is already used by an earlier entry, fix it in Settings',
    ]);
  });
});

describe("PR 1 final review round 2: labels", () => {
  test("M1: ANY control or format character masks the label whole (Q25 extended) — the mixed cases, zero-width, soft hyphen, bidi", async () => {
    const { safeLabel, MASKED_LABEL } = await import("../src/failover");
    const KEY95 = "sk-ant-api03-" + "Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAAZq9xR2bT7mVwK4pLs8NcYf3";
    for (const label of ["Work\tAKIAIOSFOD\u0001NN7EXAMPLE", "AKIA\u200BIOSFODNN7EXAMPLEX", "AKIA\u00ADIOSFODNN7EXAMPLEX",
      `sk-ant-api03\u200B${KEY95.slice(12)}`, "Local \u202Emodel", "Plain\tlabel", "\u{1F468}\u200D\u{1F4BB} laptop"]) {
      expect(`${JSON.stringify(label)} → ${safeLabel(label)}`).toBe(`${JSON.stringify(label)} → ${MASKED_LABEL}`);
    }
    // An emoji WITHOUT a joiner is ordinary text; so are ordinary names.
    for (const label of ["\u{1F4BB} laptop", "Claude login 2", "Local model"]) expect(safeLabel(label)).toBe(label);
  });

  test("M3: the label link rule — private calendar links are masked; a model host/path like openrouter.ai/sonnet is not", async () => {
    const { safeLabel, MASKED_LABEL } = await import("../src/failover");
    for (const link of [
      "https://calendar.google.com/calendar/ical/me%40example.org/private-0123456789abcdef0123456789abcdef/basic.ics",
      "webcal://p52-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9w",
      "p52-caldav.icloud.com/published/2/MTIzNDU2Nzg5MDEyMzQ1Njc4OTBhYmNkZWZnaGlqa2xtbm9w",
      "outlook.office365.com/owa/calendar/abc123@example.org/0a1b2c3d4e5f/reachcalendar.ics",
    ]) expect(`${link} → ${safeLabel(`Cal ${link}`)}`).toBe(`${link} → ${MASKED_LABEL}`);
    for (const label of ["openrouter.ai/sonnet", "ollama.local/llama3", "api.example.com/v1"]) expect(safeLabel(label)).toBe(label);
  });
});

describe("PR 1 final review round 2: the remaining label sinks and insecureEndpoint's order", () => {
  const KEY = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
  test("L1: the never-logged-in account warning carries the safe label; an ordinary outage label is unchanged", async () => {
    const { renderBriefing } = await import("../src/render");
    const { resolveAccounts } = await import("../src/config");
    const base = { date: "2026-10-16", machineScope: "mac", provider: "claude", resume: [], recap: [], suggestions: [] } as never as import("../src/types").BriefingStruct;
    // Round 3 R0: render.ts does NOT mask the outage label — it must commute with redaction
    // (test/envelope-redaction.test.ts), and core.ts masks the struct's label at its source
    // (test/account.failover.integration.test.ts, "round 3 R0"). An ordinary label renders as written.
    expect(renderBriefing({ ...base, outage: { missedDays: 2, label: "backup" } })).toContain('account "backup" was at its usage limit');
    const dir = tempDir("dba-ex-noclaude-");
    const r = resolveAccounts([{ label: "A" }, { label: `B ${KEY}`, configDir: dir }], "/home/u", {}, () => false);
    const w = r.warnings.find((x) => x.includes("no .claude.json"));
    expect(w).toBeDefined();
    expect(w).not.toContain("Zq9xR2bT7mVw");
  });

  test("L3: insecureEndpoint checks the endpoint first — an https or loopback entry never evaluates key ownership", async () => {
    const pl = await import("../src/providerList");
    const spy = spyOn(pl, "isAppOwnedKey");
    try {
      const mk = (baseUrl: string) => ({ label: "K", source: "fallback", isLoopback: false, timeoutMs: 1,
        provider: { api: { kind: "anthropic", model: "m", baseUrl, apiKeyCommand: [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-w"] } } });
      expect(insecureEndpoint(mk("https://api.example/v1") as never)).toBeUndefined();
      expect(insecureEndpoint(mk("http://127.0.0.1:9/v1") as never)).toBeUndefined();
      expect(spy.mock.calls.length).toBe(0);
      expect(insecureEndpoint(mk("http://llm.example/v1") as never)?.failCause).toBe("insecure-endpoint");
      expect(spy.mock.calls.length).toBe(1);
    } finally { spy.mockRestore(); }
  });
});

describe("PR 1 final review round 3: labels and reset times", () => {
  const KEY = "sk-ant-api03-Zq9xR2bT7mVwK4pLs8NcYf3HjA6uDe1GiO5rQ0tXzBnMvCwEkPaLyJhUgSdFo2Ii-AbCdEfGhAA";
  const lbl = async () => (await import("../src/failover")).safeLabel;
  const MASK = "[redacted label]";

  test("M6: the label link rule's host/path threshold is exactly 16 — 16 masked, 15 shown", async () => {
    const safeLabel = await lbl();
    const run = "abcdefghij0123456789";
    expect(safeLabel(`example.com/${run.slice(0, 16)}`)).toBe(MASK);
    expect(safeLabel(`example.com/${run.slice(0, 15)}`)).toBe(`example.com/${run.slice(0, 15)}`);
  });

  test("L3: a real key split by ONE separator that is not a control/format character is masked; ordinary labels are not", async () => {
    const safeLabel = await lbl();
    const at = (sep: string) => `${KEY.slice(0, 30)}${sep}${KEY.slice(30)}`;
    // U+0301 combining acute, NBSP, U+3000 ideographic space, U+3164 Hangul filler, VS16, a lone surrogate. (A plain ASCII
    // space is a word boundary, never rejoined — round 4 M2; a key split by one is a stated residual.)
    for (const sep of ["́", " ", "　", "ㅤ", "️", "\uD800"]) {
      for (const label of [at(sep), `Work ${at(sep)}`]) {
        expect(`${JSON.stringify(sep)}: ${safeLabel(label)}`).toBe(`${JSON.stringify(sep)}: ${MASK}`);
      }
    }
    expect(safeLabel("x y")).toBe(MASK);                                          // line / paragraph separators
    expect(safeLabel("x y")).toBe(MASK);
    for (const plain of ["Work laptop", "Café box".normalize("NFD"), "openrouter.ai/sonnet", "My Claude Max", "Backup — weekend"]) {
      expect(safeLabel(plain)).toBe(plain);
    }
  });

  test("L9: a reset six or more days out names its date; fewer days, the weekday alone; today, the time", () => {
    const now = new Date(2026, 9, 16, 8, 0);                                           // Fri 16 Oct, local
    expect(formatResetTime(new Date(2026, 9, 16, 9, 0), now)).toBe("09:00");
    expect(formatResetTime(new Date(2026, 9, 21, 9, 0), now)).toBe("Wed 09:00");        // 5 days out
    expect(formatResetTime(new Date(2026, 9, 22, 9, 0), now)).toBe("Thu 22 Oct 09:00"); // 6 days out
    expect(formatResetTime(new Date(2026, 9, 23, 9, 0), now)).toBe("Fri 23 Oct 09:00"); // 7: the same weekday as today
    expect(formatResetTime(new Date(2026, 9, 24, 9, 0), now)).toBe("Sat 24 Oct 09:00"); // 8: the longest mark
  });
});

describe("PR 1 final review round 4 M2: ASCII spaces are word boundaries; only invisible splitters are rejoined", () => {
  const MASK = "[redacted label]";
  test("ordinary two-login labels are shown as written", async () => {
    const { safeLabel } = await import("../src/failover");
    for (const plain of ["ASIA PACIFIC ACCOUNT 01", "ASIA TEAM PRIMARY LOGIN", "pk-laptop personal account", "rk-2 secondary claude login"]) {
      expect(safeLabel(plain)).toBe(plain);
    }
  });

  test("an AWS key split by an NBSP and followed by a word is masked (every window, not only the suffix)", async () => {
    const { safeLabel } = await import("../src/failover");
    expect(safeLabel("AKIA1234\u00A0567890ABCDEF prod")).toBe(MASK);
    expect(safeLabel("Work AKIA1234\u00A0567890ABCDEF prod")).toBe(MASK);
    // A trailing piece glued on by a SECOND invisible splitter: only a window that stops before it shows the key whole.
    expect(safeLabel("AKIA1234\u00A0567890ABCDEF\u00A0prod")).toBe(MASK);
  });

  test("the word cap: 64 invisible-split words are judged, 65 are masked", async () => {
    const { safeLabel } = await import("../src/failover");
    const words = (n: number) => Array.from({ length: n }, (_, i) => `w${i}`).join("\u00A0");
    expect(safeLabel(words(64))).toBe(words(64));
    expect(safeLabel(words(65))).toBe(MASK);
  });
});

test("round 4 L1: a dropped fallback whose baseUrl is a scheme-less calendar link never puts its token in the briefing", async () => {
  freshStateDir();
  const dir = tempDir("dba-ex-");
  const { renderBriefing } = await import("../src/render");
  const TOKEN = "private-0123456789abcdef0123456789abcdef";
  const cfg = { repos: [repo], provider: { cli: fakeCli(dir), argv: [], promptVia: "stdin" },
    fallbacks: [{ label: "Cal", api: { kind: "openai-compatible", model: "m", baseUrl: `calendar.google.com/calendar/ical/abc%40group.calendar.google.com/${TOKEN}/basic.ics` } }] } as unknown as Config;
  const r = await runCore(cfg, deps());
  expect((r.struct.warnings ?? []).some((w) => w.includes("fallbacks[0]"))).toBe(true);        // the premise: the drop warning is there
  expect(renderBriefing(r.struct)).not.toContain(TOKEN);
  expect(JSON.stringify(r.warnings)).not.toContain(TOKEN);
});

describe("PR 1 final review round 5 (post-cap): safeLabel's cost and its regex state", () => {
  test("L1: a 64 KB invisibly-split label is masked in under 100 ms (no quadratic rejoin)", async () => {
    const { safeLabel } = await import("../src/failover");
    const label = Array.from({ length: 64 }, (_, i) => `${i}${"x".repeat(1022)}`).join(" ");
    expect(label.length).toBeGreaterThan(64_000);
    const t0 = performance.now();
    expect(safeLabel(label)).toBe("[redacted label]");
    expect(performance.now() - t0).toBeLessThan(100);
  });

  test("L2: the outright link shapes keep no state between calls — a long `.ics` label, then a short one, both masked", async () => {
    const { safeLabel } = await import("../src/failover");
    expect(safeLabel(`${"x".repeat(60)}.ics`)).toBe("[redacted label]");
    expect(safeLabel("cal basic.ics")).toBe("[redacted label]");
  });
});

test("post-cap L: the split-label length cap's boundary — exactly 1 024 code points shown as written, 1 025 masked", async () => {
  const { safeLabel } = await import("../src/failover");
  const split = (n: number) => { const s = `alpha ${"b".repeat(n - 6)}`; return s; };
  expect(Array.from(split(1024)).length).toBe(1024);                                 // the premise: a split, no key
  expect(safeLabel(split(1024))).toBe(split(1024));
  expect(safeLabel(split(1025))).toBe("[redacted label]");
});
