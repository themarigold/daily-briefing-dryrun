import "./fixtures/isolate-state";   // armed before this file's first save, from any cwd (see test/fixtures/isolate-state.ts)
// test/calendar-variants.test.ts — THE PROVIDER BOUNDARY for the calendar prompt variants (v0.3.0 plan M3b;
// spec r4 §6 "Locked vs unlocked", "How the variants reach the provider").
//
// The security property: text written by other people (titles, locations, attendee names, descriptions) reaches
// ONLY an attempt that cannot act on it — an HTTP transport, or a claude CLI spawned with `--tools=`,
// `--strict-mcp-config`, `--setting-sources user` AND `--no-session-persistence` (final harden r2: no transcript of
// it kept) injected and nothing but allow-listed flags in the user's argv (decision 18). Every other spawn gets the unlocked
// variant: `harden: false`, a non-claude CLI, partial hardening, any flag off the allow-list, a flag the user passes
// themselves, and BOTH unhardened retries (the B6 fast path's bare spawn, src/harden.ts, and the ladder's
// bare rung, src/provider.ts `withHardeningLadder`).
//
// These run REAL `hardenedProvider`s against fake CLIs on disk that log every spawn's argv, stdin and
// CLAUDE_CONFIG_DIR — so "what was sent" is read from what the child actually received, on stdin AND argv,
// never from what the code meant to send. The runCore cases drive the real pipeline (factory, recording
// wrapper, withRetry, the ladder, account selection) the way test/account.failover.integration.test.ts does.
import { describe, test, expect, beforeAll, afterAll, afterEach } from "bun:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ADJACENT_FLAGS, CALENDAR_LOCK_ALLOWED_ARGV, calendarVariantFor, hardenedProvider } from "../src/harden";
import { BYOCliProvider } from "../src/provider";
import { runCore, type RunDeps } from "../src/core";
import { buildCalendarPromptBlocks, type CalendarPromptBlocks } from "../src/calendar/prompt";
import { OpenAiCompatibleProvider } from "../src/providers/openaiCompatible";
import { API_LABEL_ANTHROPIC, type Config, type GenerateOpts, type PromptVariant, type Provider } from "../src/types";
import type { CalEvent } from "../src/calendar/types";
import { buildRepo } from "./fixtures/build-repo";
import { removeAtRunEnd } from "./fixtures/temp-dirs";
import { startFakeApi, okJson, type FakeApi } from "./helpers/fakeApi";
import { guardNetworkForThisFile } from "./helpers/netGuard";

// The HTTP cases talk to a fake server on 127.0.0.1 only; the guard makes that mechanical.
guardNetworkForThisFile();

const fast = { probeMs: 3_000, flushMs: 150 };
const FULL_HELP = "--tools --setting-sources --strict-mcp-config --no-session-persistence";
const MODEL_OUTPUT = "## RESUME\n- [x] resumed\n## RECAP\n- [x] recapped\n## SUGGESTIONS\n- suggested\n";

/** Every piece of other-people text on the sentinel events. None may reach an unlocked spawn. */
const SENTINELS = ["SNTL-TITLE", "SNTL-LOC", "SNTL-DESC", "SNTL-ORG", "SNTL-ATT", "sntl-guest@example.org"];
const noSentinel = (where: string, s: string): void => { for (const x of SENTINELS) expect(s, `${where} carried ${x}`).not.toContain(x); };

// ── the fake CLI ─────────────────────────────────────────────────────────────────────────────────────

type FakeMode = "ok" | "reject" | "ambiguous" | "cwd-gone" | "limit-unless-ok-dir";
type Spawn = { argv: string; stdin: string; configDir: string; hardened: boolean };

/** A fake CLI that answers `--help` with `help`, then logs each spawn (argv, stdin, CLAUDE_CONFIG_DIR) and
 *  behaves per `mode`:
 *   • reject — refuses `--strict-mcp-config` with a real rejection phrase (the B6 FAST PATH's evidence);
 *   • ambiguous — fails with NO output whenever `--tools=` is present (the fast path cannot fire, so the
 *     LADDER's bare rung does the backing off);
 *   • cwd-gone — removes its own private working directory and fails (harden.ts's cwd-retry rung);
 *   • limit-unless-ok-dir — prints a real usage-limit line unless CLAUDE_CONFIG_DIR is `okDir`. */
async function fakeCli(opts: { help?: string; name?: string; mode?: FakeMode; okDir?: string } = {}) {
  const dir = removeAtRunEnd(await mkdtemp(join(tmpdir(), "dba-calvar-")));
  const behaviour: Record<FakeMode, string> = {
    ok: "",
    reject: `case " $* " in *" --strict-mcp-config "*) echo "error: unknown option '--strict-mcp-config'" >&2; exit 2;; esac`,
    ambiguous: `case " $* " in *" --tools= "*) exit 1;; esac`,
    "cwd-gone": `case "$(pwd)" in *provider-cwd*) d="$(pwd)"; cd /; rmdir "$d"; exit 1;; esac`,
    "limit-unless-ok-dir": `if [ "$CLAUDE_CONFIG_DIR" != '${opts.okDir ?? ""}' ]; then printf "You've hit your weekly limit \\302\\267 resets Aug 26 at 10pm (America/Los_Angeles)\\n"; exit 1; fi`,
  };
  const cli = join(dir, opts.name ?? "claude");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '${opts.help ?? FULL_HELP}'; exit 0; fi
n=$(cat '${dir}/count' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${dir}/count'
printf '%s' "$*" > '${dir}/argv.'$n
cat > '${dir}/stdin.'$n
printf '%s' "$CLAUDE_CONFIG_DIR" > '${dir}/env.'$n
${behaviour[opts.mode ?? "ok"]}
printf '${MODEL_OUTPUT.replace(/\n/g, "\\n")}'
`, { mode: 0o755 });
  const spawns = async (): Promise<Spawn[]> => {
    let n = 0;
    try { n = Number((await readFile(join(dir, "count"), "utf8")).trim()); } catch { /* none yet */ }
    const out: Spawn[] = [];
    for (let i = 1; i <= n; i++) {
      const argv = await readFile(join(dir, `argv.${i}`), "utf8");
      const tokens = argv.split(/\s+/);
      out.push({
        argv, stdin: await readFile(join(dir, `stdin.${i}`), "utf8"), configDir: await readFile(join(dir, `env.${i}`), "utf8"),
        hardened: tokens.includes("--tools=") && tokens.includes("--strict-mcp-config"),
      });
    }
    return out;
  };
  return { dir, cli, spawns };
}

/** Everything a spawn received: its stdin and its argv (the prompt rides in argv in arg-mode). */
const received = (s: Spawn): string => `${s.stdin}\n${s.argv}`;

// ── the direct cases: one hardenedProvider, two hand-written variants ───────────────────────────────

const UNLOCKED = "PROMPT-U EVENT 09:00–09:30 busy (3 people)";
const LOCKED = "PROMPT-L EVENT 09:00–09:30 | busy | SNTL-TITLE | SNTL-LOC | SNTL-ORG | SNTL-ATT sntl-guest@example.org | SNTL-DESC";

/** Generate once with both variants, recording what `onPromptSent` was told. */
async function generate(p: Provider, prompt = UNLOCKED, withVariants = true) {
  const told: { variant: PromptVariant; text: string }[] = [];
  const opts: GenerateOpts = { onPromptSent: (s) => told.push(s), ...(withVariants ? { calendarVariants: { locked: LOCKED, unlocked: prompt } } : {}) };
  const out = await p.generate(prompt, opts);
  return { out, told };
}

/** Allow-listed user argv (decision 18), each flag in every accepted form. */
const ALLOWED_ARGVS: string[][] = [
  ["--model", "opus"], ["--model=opus"], ["--fallback-model", "sonnet"], ["--fallback-model=sonnet"],
  ["--output-format", "text"], ["--output-format=text"], ["--max-turns", "3"], ["--max-turns=3"],
  ["--verbose"], ["-p"], ["--print"],
  ["-p", "--model", "opus", "--fallback-model=sonnet", "--output-format", "text", "--max-turns=2", "--verbose", "--print"],
];
/** Not on the allow-list, so UNLOCKED even under full hardening: the named ones from decision 18, an invented
 *  future flag, every ADJACENT flag in both forms, positional tokens, and malformed uses of allowed flags. */
const REFUSED_ARGVS: string[][] = [
  ["--chrome"], ["--ide"], ["--agent", "x"], ["--agent=x"], ["--permission-prompts"], ["--future-flag"], ["--future-flag=1"],
  ...ADJACENT_FLAGS.flatMap((f) => [[f], [`${f}=x`], ["-p", f, "/x"]]),
  ["positional"], ["-p", "positional"], ["--verbose", "extra"],
  ["--verbose=true"], ["-p=1"], ["--model"], ["--model", "--chrome"], ["--model", "-p"], ["-pv"], ["--Model", "opus"], ["--"],
];

describe("calendarVariantFor: the rule itself (spec §6, decision 18 allow-list)", () => {
  const BOTH = ["--tools=", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence"];
  test("locked only with all four injections — --tools=, --strict-mcp-config, --setting-sources user, --no-session-persistence — as injected", () => {
    expect(calendarVariantFor(BOTH, [])).toBe("locked");
    expect(calendarVariantFor(["--tools=", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence"], ["-p", "--model", "opus"])).toBe("locked");
    // Final harden r2: without --no-session-persistence the CLI would keep a transcript of the locked prompt.
    expect(calendarVariantFor(["--tools=", "--setting-sources", "user", "--strict-mcp-config"], ["-p", "--model", "opus"])).toBe("unlocked");
    expect(calendarVariantFor(["--tools=", "--setting-sources", "user", "--strict-mcp-config"], [])).toBe("unlocked");
    expect(calendarVariantFor(["--tools=", "--strict-mcp-config"], ["-p", "--model", "opus"])).toBe("unlocked");   // no setting-sources
    expect(calendarVariantFor(["--tools=", "--strict-mcp-config", "--no-session-persistence"], [])).toBe("unlocked");
    expect(calendarVariantFor(["--tools=", "--setting-sources", "user"], [])).toBe("unlocked");      // partial
    expect(calendarVariantFor(["--strict-mcp-config", "--setting-sources", "user"], [])).toBe("unlocked");
    expect(calendarVariantFor([], [])).toBe("unlocked");                                             // bare
    // `--setting-sources` must carry `user` as its own next token, exactly as injected.
    expect(calendarVariantFor(["--tools=", "--setting-sources", "project", "--strict-mcp-config"], [])).toBe("unlocked");
    expect(calendarVariantFor(["--tools=", "--setting-sources=user", "--strict-mcp-config"], [])).toBe("unlocked");
    expect(calendarVariantFor(["--tools=", "--setting-sources", "--strict-mcp-config", "user"], [])).toBe("unlocked");
    expect(calendarVariantFor(["--tools=", "user", "--setting-sources", "--strict-mcp-config"], [])).toBe("unlocked");
    // The user's OWN copy is not "as injected": B7 skips ours when they pass theirs.
    expect(calendarVariantFor(["--strict-mcp-config", "--setting-sources", "user"], ["--tools="])).toBe("unlocked");
  });
  test("every allow-listed flag, in each accepted form, stays locked", () => {
    for (const argv of ALLOWED_ARGVS) expect(calendarVariantFor(BOTH, argv), argv.join(" ")).toBe("locked");
  });
  test("anything off the allow-list — named, invented, adjacent, positional, malformed — is unlocked", () => {
    expect(ADJACENT_FLAGS.length).toBeGreaterThanOrEqual(12);
    for (const argv of REFUSED_ARGVS) expect(calendarVariantFor(BOTH, argv), argv.join(" ")).toBe("unlocked");
  });
  test("the allow-list is exactly decision 18's seven flags", () => {
    expect(Object.keys(CALENDAR_LOCK_ALLOWED_ARGV).sort()).toEqual(
      ["--fallback-model", "--max-turns", "--model", "--output-format", "--print", "--verbose", "-p"]);
    expect(Object.entries(CALENDAR_LOCK_ALLOWED_ARGV).filter(([, r]) => !r.takesValue).map(([f]) => f).sort()).toEqual(["--print", "--verbose", "-p"]);
  });
});

describe.each(["stdin", "arg"] as const)("hardenedProvider at spawn time — promptVia %s", (promptVia) => {
  test("full hardening ⇒ the spawn receives the LOCKED text, and onPromptSent says so", async () => {
    const f = await fakeCli();
    const { told } = await generate(hardenedProvider({ cli: f.cli, argv: [], promptVia }, { ...fast, stateDir: join(f.dir, "state") }));
    const [s, ...rest] = await f.spawns();
    expect(rest).toEqual([]);
    expect(s!.hardened).toBe(true);
    expect(received(s!)).toContain(LOCKED);
    expect(told).toEqual([{ variant: "locked", text: LOCKED }]);
  });

  test.each([
    ["--tools only", "--tools --setting-sources"],
    ["--strict-mcp-config only", "--setting-sources --strict-mcp-config"],
  ])("partial hardening (probe finds %s) ⇒ UNLOCKED", async (_n, help) => {
    const f = await fakeCli({ help });
    const { told } = await generate(hardenedProvider({ cli: f.cli, argv: [], promptVia }, { ...fast, stateDir: join(f.dir, "state") }));
    const [s] = await f.spawns();
    expect(s!.hardened).toBe(false);
    noSentinel("partial spawn", received(s!));
    expect(received(s!)).toContain(UNLOCKED);
    expect(told.map((t) => t.variant)).toEqual(["unlocked"]);
  });

  test("every allow-listed user flag, in each form, ⇒ the spawn receives the LOCKED text", async () => {
    const f = await fakeCli();
    for (const argv of ALLOWED_ARGVS) {
      const { told } = await generate(hardenedProvider({ cli: f.cli, argv, promptVia }, { ...fast, stateDir: join(f.dir, "state") }));
      expect(told.map((t) => t.variant), argv.join(" ")).toEqual(["locked"]);
    }
    const all = await f.spawns();
    expect(all).toHaveLength(ALLOWED_ARGVS.length);
    for (const s of all) { expect(s.hardened).toBe(true); expect(received(s)).toContain(LOCKED); }
  });

  test("anything off the allow-list (--chrome, --ide, --agent, --permission-prompts, a future flag, every ADJACENT flag, a positional) ⇒ UNLOCKED, though all three flags were injected", async () => {
    const f = await fakeCli();
    for (const argv of REFUSED_ARGVS) {
      const { told } = await generate(hardenedProvider({ cli: f.cli, argv, promptVia }, { ...fast, stateDir: join(f.dir, "state") }));
      expect(told.map((t) => t.variant), argv.join(" ")).toEqual(["unlocked"]);
    }
    const all = await f.spawns();
    expect(all).toHaveLength(REFUSED_ARGVS.length);
    for (const s of all) {
      expect(s.hardened).toBe(true);                 // hardening still applied (an unknown flag only costs the lock) …
      noSentinel(`spawn with ${s.argv.slice(0, 80)}`, received(s));   // … yet nothing withheld was sent, on stdin or argv
    }
  });

  test("final harden r2: no --no-session-persistence in the injection (the probe does not list it) ⇒ UNLOCKED", async () => {
    const f = await fakeCli({ help: "--tools --setting-sources --strict-mcp-config" });
    const { told } = await generate(hardenedProvider({ cli: f.cli, argv: [], promptVia }, { ...fast, stateDir: join(f.dir, "state") }));
    const [s, ...rest] = await f.spawns();
    expect(rest).toEqual([]);
    expect(s!.argv).toContain("--strict-mcp-config");
    expect(s!.argv).not.toContain("--no-session-persistence");
    noSentinel("no-session-persistence spawn", received(s!));   // a transcript could keep it, so nothing withheld is sent
    expect(received(s!)).toContain(UNLOCKED);
    expect(told.map((t) => t.variant)).toEqual(["unlocked"]);
  });

  test("no --setting-sources user in the injection (the probe does not list it) ⇒ UNLOCKED", async () => {
    const f = await fakeCli({ help: "--tools --strict-mcp-config --no-session-persistence" });
    const { told } = await generate(hardenedProvider({ cli: f.cli, argv: [], promptVia }, { ...fast, stateDir: join(f.dir, "state") }));
    const [s, ...rest] = await f.spawns();
    expect(rest).toEqual([]);
    expect(s!.hardened).toBe(true);                  // --tools= and --strict-mcp-config were both injected …
    expect(s!.argv).not.toContain("--setting-sources");
    noSentinel("no-setting-sources spawn", received(s!));   // … but without setting-sources the spawn is not locked
    expect(received(s!)).toContain(UNLOCKED);
    expect(told.map((t) => t.variant)).toEqual(["unlocked"]);
  });

  test("a flag the user passes themselves (B7 skips ours) ⇒ UNLOCKED", async () => {
    const f = await fakeCli();
    for (const argv of [["--tools", "Bash"], ["--strict-mcp-config"]]) {
      await generate(hardenedProvider({ cli: f.cli, argv, promptVia }, { ...fast, stateDir: join(f.dir, "state") }));
    }
    for (const s of await f.spawns()) noSentinel("B7 spawn", received(s));
  });

  test("harden: false, and a non-claude CLI ⇒ UNLOCKED", async () => {
    const f = await fakeCli();
    await generate(hardenedProvider({ cli: f.cli, argv: [], promptVia, harden: false }, { ...fast, stateDir: join(f.dir, "state") }));
    const codex = await fakeCli({ name: "codex" });
    await generate(hardenedProvider({ cli: codex.cli, argv: [], promptVia }, { ...fast, stateDir: join(codex.dir, "state") }));
    for (const s of [...await f.spawns(), ...await codex.spawns()]) {
      expect(s.hardened).toBe(false);
      noSentinel("unhardened spawn", received(s));
      expect(received(s)).toContain(UNLOCKED);
    }
  });

  test("a CLI that REJECTS the flags: the bare retry (B6 fast path) receives no withheld text", async () => {
    const f = await fakeCli({ mode: "reject" });
    const hp = hardenedProvider({ cli: f.cli, argv: [], promptVia }, { ...fast, stateDir: join(f.dir, "state") });
    const { out, told } = await generate(hp);
    expect(out).toContain("## RESUME");
    const [first, bare, ...rest] = await f.spawns();
    expect(rest).toEqual([]);
    expect(first!.hardened).toBe(true);              // the refused spawn carried the flags (and the locked text)
    expect(received(first!)).toContain(LOCKED);
    expect(bare!.hardened).toBe(false);
    expect(bare!.argv).not.toContain("--tools");
    noSentinel("bare retry", received(bare!));
    expect(received(bare!)).toContain(UNLOCKED);
    expect(told.map((t) => t.variant)).toEqual(["locked", "unlocked"]);
    expect(hp.runtimeWarnings.join(" ")).toContain("rejected an injected hardening flag");
  });

  test("the cwd-retry rung keeps the flags, so it stays LOCKED under the same rule", async () => {
    const f = await fakeCli({ mode: "cwd-gone" });
    const hp = hardenedProvider({ cli: f.cli, argv: [], promptVia }, { ...fast, stateDir: join(f.dir, "state") });
    const { told } = await generate(hp);
    const spawns = await f.spawns();
    expect(spawns).toHaveLength(2);
    for (const s of spawns) { expect(s.hardened).toBe(true); expect(received(s)).toContain(LOCKED); }
    expect(told.map((t) => t.variant)).toEqual(["locked", "locked"]);
    expect(hp.runtimeWarnings.join(" ")).toContain("became unusable");
  });

  // M3b checkpoint LOW: a reviewer mutation that judged the cwd retry on a FAKE full-flag list survived the test
  // above, which runs under full hardening where that list is the truth. Under partial hardening or an adjacent
  // flag the retry must be judged on its OWN (unchanged) flags, and stay unlocked.
  test.each([
    ["partial hardening (the probe lists --tools and --setting-sources only)", "--tools --setting-sources", [] as string[]],
    ["an adjacent flag (--add-dir=/x)", FULL_HELP, ["--add-dir=/x"]],
  ])("the cwd-retry rung under %s stays UNLOCKED on both spawns", async (_n, help, argv) => {
    const f = await fakeCli({ mode: "cwd-gone", help });
    const hp = hardenedProvider({ cli: f.cli, argv, promptVia }, { ...fast, stateDir: join(f.dir, "state") });
    const { told } = await generate(hp);
    const spawns = await f.spawns();
    expect(spawns).toHaveLength(2);
    expect(spawns[0]!.argv).toContain("--setting-sources user");   // isolated, so the narrow cwd was used and removed
    expect(spawns[1]!.argv).toBe(spawns[0]!.argv);                 // the retry carries the same flags
    for (const s of spawns) { noSentinel("cwd-retry spawn", received(s)); expect(received(s)).toContain(UNLOCKED); }
    expect(told.map((t) => t.variant)).toEqual(["unlocked", "unlocked"]);
    expect(hp.runtimeWarnings.join(" ")).toContain("became unusable");
  });

  test("no calendarVariants ⇒ `prompt` is sent as is, reported as the unlocked text", async () => {
    const f = await fakeCli();
    const { told } = await generate(hardenedProvider({ cli: f.cli, argv: [], promptVia }, { ...fast, stateDir: join(f.dir, "state") }), "PLAIN-PROMPT", false);
    expect(received((await f.spawns())[0]!)).toContain("PLAIN-PROMPT");
    expect(told).toEqual([{ variant: "unlocked", text: "PLAIN-PROMPT" }]);
  });
});

test("a bare BYOCliProvider is unlocked by definition — it never sends the locked text", async () => {
  const f = await fakeCli();
  const { told } = await generate(new BYOCliProvider({ cli: f.cli, argv: [], promptVia: "stdin" }, fast));
  const [s] = await f.spawns();
  noSentinel("bare BYO spawn", received(s!));
  expect(told).toEqual([{ variant: "unlocked", text: UNLOCKED }]);
});

test("HTTP (openai-compatible) is always LOCKED: the request body carries the locked text", async () => {
  const s = await startFakeApi(okJson({ choices: [{ index: 0, message: { role: "assistant", content: "out" }, finish_reason: "stop" }] }));
  try {
    const p = new OpenAiCompatibleProvider({ kind: "openai-compatible", model: "m", baseUrl: `${s.origin}/v1` }, { timeoutMs: 5_000, env: {} });
    const { told } = await generate(p);
    const body = JSON.parse(s.requests[0]!.bodyText) as { messages: { content: string }[] };
    expect(body.messages[0]!.content).toBe(LOCKED);
    expect(told).toEqual([{ variant: "locked", text: LOCKED }]);
  } finally { await s.stop(); }
});

// ── through runCore: the real pipeline ───────────────────────────────────────────────────────────────

const RUN = "2026-10-09";
const at = (h: number, m = 0): number => new Date(2026, 9, 9, h, m).getTime();
const sentinelEvents: CalEvent[] = [
  {
    sources: [{ kind: "link", id: "work", calendarId: "work" }], time: { kind: "timed", startMs: at(9), endMs: at(9, 30) },
    title: "SNTL-TITLE standup", location: "SNTL-LOC room", description: "SNTL-DESC agenda",
    organizer: { name: "SNTL-ORG Sam", email: "sam@example.org" },
    attendees: [{ name: "SNTL-ATT Ana", email: "sntl-guest@example.org" }, { email: "bob@example.org" }],
    selfStatus: "accepted", organizerVerified: false, transparency: "busy", status: "confirmed", provenance: {},
  },
  {
    sources: [{ kind: "link", id: "work", calendarId: "work" }], time: { kind: "timed", startMs: at(14), endMs: at(15) },
    title: "SNTL-TITLE invite", attendees: [], selfStatus: "needs-action", organizerVerified: false,
    transparency: "busy", status: "confirmed", provenance: {},
  },
];
const BLOCKS: CalendarPromptBlocks = buildCalendarPromptBlocks({
  events: sentinelEvents, sources: [{ id: "work", status: "ok" }], runDate: RUN, nowMs: at(8), maxChars: 200_000, zone: "UTC",
});

let stateDir = "";
let repo = "";
let prevStateDir: string | undefined;

beforeAll(async () => {
  // Redirect state for the WHOLE file: runCore's account selection and limit recording write to supportDir().
  prevStateDir = process.env.DAILY_BRIEFING_STATE_DIR;
  stateDir = removeAtRunEnd(await mkdtemp(join(tmpdir(), "dba-calvar-state-")));
  process.env.DAILY_BRIEFING_STATE_DIR = stateDir;
  repo = await buildRepo([
    { file: "a.ts", content: "one", isoDate: new Date(Date.now() - 2 * 86400e3).toISOString() },
    { file: "b.ts", content: "two", isoDate: new Date(Date.now() - 1 * 86400e3).toISOString() },
  ]);
});
afterAll(() => {
  if (prevStateDir === undefined) delete process.env.DAILY_BRIEFING_STATE_DIR;
  else process.env.DAILY_BRIEFING_STATE_DIR = prevStateDir;
});
afterEach(async () => { await rm(join(stateDir, "account-state.json"), { force: true }); });

const cfgFor = (cli: string, extra: Partial<Config["provider"]> = {}): Config =>
  ({ repos: [repo], provider: { cli, argv: [], promptVia: "stdin", timeoutMs: 30_000, ...extra } } as Config);
/** The calendar step seam (M4 replaced M3b's `calendarPromptBlocks` test seam with `RunDeps.calendar`): a step that
 *  answers these two blocks, as the production step would after reading the sentinel events. */
const STEP: NonNullable<RunDeps["calendar"]> = async () => ({
  struct: { events: [], sources: [{ id: "work", kind: "link", status: "ok" }], incomplete: false }, promptBlocks: BLOCKS, skipOffline: false,
});
const deps = (over: Partial<RunDeps> = {}): RunDeps => ({
  netProbe: async () => true, powerPlatform: "linux", sleep: async () => {}, retryDelaysMs: [], calendar: STEP, ...over,
});

describe("runCore end to end", () => {
  test("the blocks themselves: the locked one carries the sentinels, the unlocked one none of them", () => {
    expect(BLOCKS.locked).toContain("SNTL-TITLE");
    expect(BLOCKS.locked).toContain("SNTL-ATT Ana");
    noSentinel("unlocked block", BLOCKS.unlocked);
    expect(BLOCKS.unlocked).toContain("EVENT 09:00–09:30 busy (2 people)");
  });

  test("a provider that IGNORES the option receives only the unlocked text — and that is what is recorded", async () => {
    const got: string[] = [];
    const ignoring: Provider = { generate: async (p: string) => { got.push(p); return MODEL_OUTPUT; } };
    const r = await runCore(cfgFor("echo"), deps({ provider: ignoring }));
    expect(got).toHaveLength(1);
    expect(got[0]).toContain(BLOCKS.unlocked);
    noSentinel("ignoring provider", got[0]!);
    expect(r.promptText).toBe(got[0]!);
  });

  test.each(["stdin", "arg"] as const)("a hardened claude fake receives the LOCKED variant (promptVia %s), recorded as promptText", async (promptVia) => {
    const f = await fakeCli();
    const r = await runCore(cfgFor(f.cli, { promptVia }), deps());
    const [s, ...rest] = await f.spawns();
    expect(rest).toEqual([]);
    expect(s!.hardened).toBe(true);
    expect(r.promptText).toContain(`${BLOCKS.locked}\n\nGIT ACTIVITY:\n`);
    expect(r.promptText).toContain("SNTL-DESC agenda");
    if (promptVia === "stdin") expect(s!.stdin).toBe(r.promptText);
    else expect(s!.argv.endsWith(r.promptText)).toBe(true);
  });

  test.each(["stdin", "arg"] as const)("a CLI that rejects the flags: the B6 bare retry gets no withheld text (promptVia %s)", async (promptVia) => {
    const f = await fakeCli({ mode: "reject" });
    const r = await runCore(cfgFor(f.cli, { promptVia }), deps());
    const spawns = await f.spawns();
    expect(spawns.map((s) => s.hardened)).toEqual([true, false]);
    noSentinel("B6 bare retry", received(spawns[1]!));
    expect(received(spawns[1]!)).toContain(BLOCKS.unlocked);
    noSentinel("recorded promptText", r.promptText);   // onPromptSent recorded the variant actually sent
    expect(r.promptText).toContain(BLOCKS.unlocked);
  });

  test.each(["stdin", "arg"] as const)("an ambiguous failure: the LADDER's bare rung (provider.ts) gets no withheld text (promptVia %s)", async (promptVia) => {
    const f = await fakeCli({ mode: "ambiguous" });
    const r = await runCore(cfgFor(f.cli, { promptVia }), deps());
    const spawns = await f.spawns();
    // withRetry's one attempt, rung 1 (same flags), rung 2 (bare) — and only the last is unhardened.
    expect(spawns.map((s) => s.hardened)).toEqual([true, true, false]);
    for (const s of spawns.slice(0, 2)) expect(received(s)).toContain("SNTL-TITLE");
    noSentinel("ladder bare rung", received(spawns[2]!));
    expect(received(spawns[2]!)).toContain(BLOCKS.unlocked);
    noSentinel("recorded promptText", r.promptText);
    expect(r.struct.warnings?.join(" ") ?? "").toContain("succeeded without them");
  });

  test("accounts failover keeps the choice PER SPAWN: each account's spawn is judged on its own argv", async () => {
    const parent = removeAtRunEnd(await mkdtemp(join(tmpdir(), "dba-calvar-acct-")));
    const limitedDir = join(parent, "limited"), okDir = join(parent, "ok");
    const f = await fakeCli({ mode: "limit-unless-ok-dir", okDir });
    const cfg = cfgFor(f.cli, { accounts: [{ label: "primary", configDir: limitedDir }, { label: "fallback", configDir: okDir }] });
    const now = () => new Date("2026-08-24T12:00:00-07:00");
    // Provider fallback P1-M7-T1: the walled primary hands off to the fallback IN THE SAME TICK (it took two ticks before).
    const b = await runCore(cfg, deps({ now }));
    expect(b.skipReason).toBeUndefined();
    expect(b.account).toBe("fallback");
    const spawns = await f.spawns();
    expect(spawns.map((s) => s.configDir)).toEqual([limitedDir, okDir]);
    for (const s of spawns) { expect(s.hardened).toBe(true); expect(received(s)).toContain("SNTL-TITLE"); }
    expect(b.promptText).toContain(BLOCKS.locked);
    // …and the same failover with a CLI that refuses the flags: the fallback's bare retry is unlocked.
    await rm(join(stateDir, "account-state.json"), { force: true });
    const g = await fakeCli({ mode: "reject" });
    const cfg2 = cfgFor(g.cli, { accounts: [{ label: "primary" }, { label: "fallback", configDir: okDir }] });
    const c = await runCore(cfg2, deps({ now }));
    expect((await g.spawns()).map((s) => s.hardened)).toEqual([true, false]);
    noSentinel("failover bare retry", c.promptText);
  });

  test("HTTP through runCore (anthropic) is LOCKED: the request carries the locked prompt, recorded as promptText", async () => {
    const s: FakeApi = await startFakeApi(okJson({ content: [{ type: "text", text: MODEL_OUTPUT }], stop_reason: "end_turn" }));
    try {
      const cfg = { repos: [repo], provider: {
        cli: API_LABEL_ANTHROPIC, argv: [], promptVia: "stdin", timeoutMs: 10_000,
        api: { kind: "anthropic", model: "claude-sonnet-5", baseUrl: s.origin, apiKey: "sk-test-not-real" },
      } } as Config;
      const r = await runCore(cfg, deps());
      const body = JSON.parse(s.requests[0]!.bodyText) as { messages: { content: string }[] };
      expect(body.messages[0]!.content).toContain(BLOCKS.locked);
      expect(body.messages[0]!.content).toBe(r.promptText);
    } finally { await s.stop(); }
  });

  test("calendar OFF: one-argument generate, and the spawn's prompt has no calendar block", async () => {
    const lens: number[] = [];
    const counting: Provider = { generate: async (...args: [string, GenerateOpts?]) => { lens.push(args.length); return MODEL_OUTPUT; } };
    await runCore(cfgFor("echo"), deps({ provider: counting, calendar: undefined }));
    expect(lens).toEqual([1]);
    const f = await fakeCli();
    const r = await runCore(cfgFor(f.cli), deps({ calendar: undefined }));
    const [sp] = await f.spawns();
    expect(sp!.stdin).toBe(r.promptText);
    expect(r.promptText).not.toContain("TODAY'S CALENDAR");
  });
});
