import "./fixtures/isolate-state";   // A0: keeps supportDir() fallbacks off the real state dir (see test/isolation.meta.test.ts)
// test/summary.harden.test.ts — A2-M3-T7: `HardenOpts.beforeSummaryGenerate`, the refusing check inside the common
// send of `hardenedProvider` (A2 :40). Every "what was sent" below is read from what a fake CLI on disk actually
// received, token by token and on stdin, never from what the code meant to send.
import { describe, test, expect } from "bun:test";
import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calendarVariantFor, hardenedProvider, SummaryUnavailableError, type HardenOpts } from "../src/harden";
import { buildProvider } from "../src/providerFactory";
import { ProviderError, type Config, type PromptVariant } from "../src/types";
import { removeAtRunEnd } from "./fixtures/temp-dirs";

const fast = { probeMs: 3_000, flushMs: 150 };
const FULL_HELP = "--tools --setting-sources --strict-mcp-config --no-session-persistence";
const FULL_FLAGS = ["--tools=", "--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence"];
const MODEL_OUTPUT = "MODEL-OUTPUT";
/** A2-M3-T9's exact sentinel (plan O16): the unlocked `prompt` when no safe unlocked text exists. */
const SENTINEL = "__SUMMARY_NO_UNLOCKED_INPUT__";
const FULL_PAGE = "FULL SAVED PAGE with a meeting title";

type Mode = "ok" | "reject" | "cwd-gone";
type Spawn = { argv: string[]; stdin: string };

/** A fake CLI. `--help` answers `help` and is not counted (a probe, which carries no page); every other run logs its
 *  argv tokens and stdin, then behaves per `mode`:
 *   • reject — refuses `--strict-mcp-config` with a real rejection phrase (the flag-rejection respawn's evidence);
 *   • cwd-gone — removes its own private working directory and fails (the unusable-cwd respawn's evidence). */
async function fakeCli(o: { help?: string; name?: string; mode?: Mode } = {}) {
  const dir = removeAtRunEnd(await mkdtemp(join(tmpdir(), "dba-sumh-")));
  const behaviour: Record<Mode, string> = {
    ok: "",
    reject: `case " $* " in *" --strict-mcp-config "*) echo "error: unknown option '--strict-mcp-config'" >&2; exit 2;; esac`,
    "cwd-gone": `case "$(pwd)" in *provider-cwd*) d="$(pwd)"; cd /; rmdir "$d"; exit 1;; esac`,
  };
  const cli = join(dir, o.name ?? "claude");
  await writeFile(cli, `#!/bin/sh
if [ "$1" = "--help" ]; then echo '${o.help ?? FULL_HELP}'; exit 0; fi
n=$(cat '${dir}/count' 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > '${dir}/count'
for a in "$@"; do printf '%s\\n' "$a"; done > '${dir}/argv.'$n
cat > '${dir}/stdin.'$n
${behaviour[o.mode ?? "ok"]}
printf '${MODEL_OUTPUT}'
`, { mode: 0o755 });
  const spawns = async (): Promise<Spawn[]> => {
    let n = 0;
    try { n = Number((await readFile(join(dir, "count"), "utf8")).trim()); } catch { /* none yet */ }
    const out: Spawn[] = [];
    for (let i = 1; i <= n; i++) {
      out.push({
        argv: (await readFile(join(dir, `argv.${i}`), "utf8")).split("\n").slice(0, -1),
        stdin: await readFile(join(dir, `stdin.${i}`), "utf8"),
      });
    }
    return out;
  };
  return { dir, cli, spawns, state: join(dir, "state") };
}

type Cfg = Pick<Config["provider"], "argv" | "promptVia" | "harden">;
const cfgFor = (cli: string, c: Partial<Cfg> = {}): Config["provider"] => ({ cli, argv: [], promptVia: "stdin", ...c });

/** Records each check's input and answers per `answer`. */
function recordingCheck(answer: (i: { injected: readonly string[]; userArgv: readonly string[] }, call: number) => "go" | "unavailable") {
  const calls: { injected: string[]; userArgv: string[] }[] = [];
  const check: NonNullable<HardenOpts["beforeSummaryGenerate"]> = async (i) => {
    calls.push({ injected: [...i.injected], userArgv: [...i.userArgv] });
    return answer(i, calls.length);
  };
  return { calls, check };
}
/** The main run's lock rule in the no-safe-unlocked-input case: only a locked attempt may proceed. */
const lockedOnly = (i: { injected: readonly string[]; userArgv: readonly string[] }): "go" | "unavailable" =>
  calendarVariantFor(i.injected, i.userArgv) === "locked" ? "go" : "unavailable";

const received = (s: Spawn[]): string => s.map((x) => `${x.stdin}\n${x.argv.join("\n")}`).join("\n");

// ── the two paths the optional field must leave alone ────────────────────────────────────────────────

type Expected = { argv: string[]; stdin: string };
const USER = ["--model", "opus"];
const LOCKED_VARIANT = "LOCKED-VARIANT";
/** What base f6843a943's wrapper sends for each existing hardening fixture shape, written out as literals: the
 *  table pins the bytes, so a wrapper change cannot move them along with a helper it shares. */
const BASE_CASES: {
  name: string; help?: string; cliName?: string; mode?: Mode; cfg?: Partial<Cfg>; variants?: boolean;
  told: PromptVariant[]; sent: Expected[];
}[] = [
  { name: "full hardening on stdin", cfg: { argv: USER }, told: ["unlocked"],
    sent: [{ argv: [...FULL_FLAGS, ...USER], stdin: "PROMPT" }] },
  { name: "full hardening, prompt as an argument", cfg: { argv: USER, promptVia: "arg" }, told: ["unlocked"],
    sent: [{ argv: [...FULL_FLAGS, ...USER, "PROMPT"], stdin: "" }] },
  { name: "partial flags from the probe", help: "--tools", cfg: { argv: USER }, told: ["unlocked"],
    sent: [{ argv: ["--tools=", ...USER], stdin: "PROMPT" }] },
  { name: "the user's own flag wins and is not injected", cfg: { argv: ["--tools", "Bash"] }, told: ["unlocked"],
    sent: [{ argv: ["--setting-sources", "user", "--strict-mcp-config", "--no-session-persistence", "--tools", "Bash"], stdin: "PROMPT" }] },
  { name: "a CLI that is not claude", cliName: "codex", cfg: { argv: USER }, told: ["unlocked"],
    sent: [{ argv: USER, stdin: "PROMPT" }] },
  { name: "harden: false", cfg: { argv: USER, harden: false }, told: ["unlocked"],
    sent: [{ argv: USER, stdin: "PROMPT" }] },
  { name: "the locked variant under full hardening", cfg: { argv: USER }, variants: true, told: ["locked"],
    sent: [{ argv: [...FULL_FLAGS, ...USER], stdin: LOCKED_VARIANT }] },
  { name: "the unlocked variant under partial flags", help: "--tools", cfg: { argv: USER }, variants: true, told: ["unlocked"],
    sent: [{ argv: ["--tools=", ...USER], stdin: "PROMPT" }] },
  { name: "the unlocked variant under harden: false", cfg: { argv: USER, harden: false }, variants: true, told: ["unlocked"],
    sent: [{ argv: USER, stdin: "PROMPT" }] },
  { name: "a rejected flag, then the bare respawn", mode: "reject", cfg: { argv: USER }, variants: true, told: ["locked", "unlocked"],
    sent: [{ argv: [...FULL_FLAGS, ...USER], stdin: LOCKED_VARIANT }, { argv: USER, stdin: "PROMPT" }] },
  { name: "an unusable private cwd, then the same flags again", mode: "cwd-gone", cfg: { argv: USER }, variants: true, told: ["locked", "locked"],
    sent: [{ argv: [...FULL_FLAGS, ...USER], stdin: LOCKED_VARIANT }, { argv: [...FULL_FLAGS, ...USER], stdin: LOCKED_VARIANT }] },
];

describe.each([
  ["absent (every morning caller)", (): Partial<HardenOpts> => ({})],
  ["answering go", (): Partial<HardenOpts> => ({ beforeSummaryGenerate: async () => "go" })],
] as const)("beforeSummaryGenerate %s: the spawn argv and prompt are the base's, byte for byte", (_label, field) => {
  for (const c of BASE_CASES) {
    test(c.name, async () => {
      const f = await fakeCli({ help: c.help, name: c.cliName, mode: c.mode });
      const hp = hardenedProvider(cfgFor(f.cli, c.cfg), { ...fast, stateDir: f.state, ...field() });
      const told: PromptVariant[] = [];
      const out = await hp.generate("PROMPT", {
        onPromptSent: (s) => told.push(s.variant),
        ...(c.variants ? { calendarVariants: { locked: LOCKED_VARIANT, unlocked: "PROMPT" } } : {}),
      });
      expect(out).toContain(MODEL_OUTPUT);
      expect(await f.spawns()).toEqual(c.sent);
      expect(told).toEqual(c.told);
    });
  }
});

// ── "unavailable": a fixed error and no spawn ────────────────────────────────────────────────────────

describe('"unavailable": a fixed summary-unavailable error, zero generation spawns', () => {
  const SHAPES: { name: string; help?: string; cliName?: string; cfg?: Partial<Cfg> }[] = [
    { name: "hardened on stdin" },
    { name: "hardened with the prompt as an argument", cfg: { promptVia: "arg" } },
    { name: "partial flags", help: "--tools" },
    { name: "a CLI that is not claude", cliName: "codex" },
    { name: "harden: false on stdin", cfg: { harden: false } },
    { name: "harden: false with the prompt as an argument", cfg: { harden: false, promptVia: "arg" } },
  ];
  for (const s of SHAPES) {
    test(s.name, async () => {
      const f = await fakeCli({ help: s.help, name: s.cliName });
      const c = recordingCheck(() => "unavailable");
      const hp = hardenedProvider(cfgFor(f.cli, s.cfg), { ...fast, stateDir: f.state, beforeSummaryGenerate: c.check });
      let told = 0;
      const err = await hp.generate("SECRET-PROMPT", { onPromptSent: () => { told++; } }).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(SummaryUnavailableError);
      expect((err as Error).message).toBe("summary unavailable");
      expect((err as Error).message).not.toContain("SECRET-PROMPT");
      expect(c.calls.length).toBe(1);
      expect(told).toBe(0);                                          // refused before `onPromptSent`, whose errors are swallowed
      expect(await f.spawns()).toEqual([]);
    });
  }

  test("the error is not a ProviderError", () => {
    // Checked: src/provider.ts withRetry rethrows anything that is not a ProviderError at once.
    expect(new SummaryUnavailableError()).not.toBeInstanceOf(ProviderError);
  });

  test("any answer other than go refuses", async () => {
    const f = await fakeCli();
    const hp = hardenedProvider(cfgFor(f.cli), { ...fast, stateDir: f.state, beforeSummaryGenerate: (async () => "maybe") as never });
    await expect(hp.generate("x")).rejects.toBeInstanceOf(SummaryUnavailableError);
    expect(await f.spawns()).toEqual([]);
  });

  test("a check that rejects refuses with the fixed error and spawns nothing", async () => {
    const f = await fakeCli();
    const hp = hardenedProvider(cfgFor(f.cli), { ...fast, stateDir: f.state, beforeSummaryGenerate: async () => { throw new Error("check failed: SECRET"); } });
    const err = await hp.generate("x").then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(SummaryUnavailableError);
    expect((err as Error).message).toBe("summary unavailable");
    expect(await f.spawns()).toEqual([]);
  });

  test("a check that rejects stays out of the respawn ladder, even when the private cwd has just become unusable", async () => {
    const f = await fakeCli();
    const cwd = join(f.state, "provider-cwd");
    let asks = 0;
    const hp = hardenedProvider(cfgFor(f.cli), { ...fast, stateDir: f.state,
      beforeSummaryGenerate: async () => {
        if (++asks > 1) return "go";                                 // a second ask would spawn
        await chmod(cwd, 0o000);
        throw new Error("check failed");
      } });
    try {
      await expect(hp.generate("x")).rejects.toBeInstanceOf(SummaryUnavailableError);
    } finally {
      await chmod(cwd, 0o700);
    }
    expect(asks).toBe(1);
    expect(await f.spawns()).toEqual([]);
    expect(hp.runtimeWarnings.join(" ")).not.toContain("became unusable");
  });

  test("a refusal is final: it never enters the respawn ladder, even when the private cwd has just become unusable", async () => {
    const f = await fakeCli();
    let spawnChecks = 0;
    const cwd = join(f.state, "provider-cwd");
    const c = recordingCheck((_i, call) => (call === 1 ? "unavailable" : "go"));   // a second ask would be answered go
    const hp = hardenedProvider(cfgFor(f.cli), { ...fast, stateDir: f.state,
      beforeSpawn: async () => { spawnChecks++; },
      beforeSummaryGenerate: async (i) => { await chmod(cwd, 0o000); return c.check(i); } });
    try {
      await expect(hp.generate("x")).rejects.toBeInstanceOf(SummaryUnavailableError);
    } finally {
      await chmod(cwd, 0o700);
    }
    expect(c.calls.length).toBe(1);
    expect(spawnChecks).toBe(0);
    expect(await f.spawns()).toEqual([]);
    expect(hp.runtimeWarnings.join(" ")).not.toContain("became unusable");
    expect(hp.hardeningActive()).toBe(true);
  });

  test("buildProvider's CLI branch hands the field through (the job's route)", async () => {
    const f = await fakeCli();
    const c = recordingCheck(() => "unavailable");
    const { provider } = buildProvider(cfgFor(f.cli), { ...fast, stateDir: f.state, beforeSummaryGenerate: c.check });
    await expect(provider.generate("x")).rejects.toBeInstanceOf(SummaryUnavailableError);
    expect(c.calls.length).toBe(1);
    expect(await f.spawns()).toEqual([]);
  });
});

// ── what the check is told, and when ─────────────────────────────────────────────────────────────────

describe("the check receives the exact flags and config argv of that send", () => {
  const CASES: { name: string; help?: string; cliName?: string; cfg: Partial<Cfg>; injected: string[] }[] = [
    { name: "full hardening", cfg: { argv: USER }, injected: FULL_FLAGS },
    { name: "partial flags", help: "--tools --strict-mcp-config", cfg: { argv: USER }, injected: ["--tools=", "--strict-mcp-config"] },
    { name: "a user's own flag is not injected", cfg: { argv: ["--tools", "Bash"] }, injected: FULL_FLAGS.slice(1) },
    { name: "a CLI that is not claude", cliName: "codex", cfg: { argv: USER }, injected: [] },
    { name: "harden: false", cfg: { argv: USER, harden: false }, injected: [] },
  ];
  for (const k of CASES) {
    test(`${k.name}: refused, the check saw what the first spawn would carry; allowed, that spawn carries it`, async () => {
      const argv = k.cfg.argv!;
      const refused = await fakeCli({ help: k.help, name: k.cliName });
      const r = recordingCheck(() => "unavailable");
      const hr = hardenedProvider(cfgFor(refused.cli, k.cfg), { ...fast, stateDir: refused.state, beforeSummaryGenerate: r.check });
      await expect(hr.generate("x")).rejects.toBeInstanceOf(SummaryUnavailableError);
      expect(r.calls).toEqual([{ injected: k.injected, userArgv: argv }]);

      const allowed = await fakeCli({ help: k.help, name: k.cliName });
      const a = recordingCheck(() => "go");
      const ha = hardenedProvider(cfgFor(allowed.cli, k.cfg), { ...fast, stateDir: allowed.state, beforeSummaryGenerate: a.check });
      await ha.generate("x");
      expect(a.calls).toEqual([{ injected: k.injected, userArgv: argv }]);
      expect((await allowed.spawns()).map((s) => s.argv)).toEqual([[...k.injected, ...argv]]);
    });
  }

  test("each respawn asks again with its own flags: [] on the flag-rejection respawn, the same flags on the cwd respawn", async () => {
    const rejected = await fakeCli({ mode: "reject" });
    const a = recordingCheck(() => "go");
    await hardenedProvider(cfgFor(rejected.cli, { argv: USER }), { ...fast, stateDir: rejected.state, beforeSummaryGenerate: a.check }).generate("x");
    expect(a.calls).toEqual([{ injected: FULL_FLAGS, userArgv: USER }, { injected: [], userArgv: USER }]);

    const gone = await fakeCli({ mode: "cwd-gone" });
    const b = recordingCheck(() => "go");
    await hardenedProvider(cfgFor(gone.cli, { argv: USER }), { ...fast, stateDir: gone.state, beforeSummaryGenerate: b.check }).generate("x");
    expect(b.calls).toEqual([{ injected: FULL_FLAGS, userArgv: USER }, { injected: FULL_FLAGS, userArgv: USER }]);
  });

  for (const [name, cfg] of [["hardened", {}], ["harden: false", { harden: false }]] as const) {
    test(`${name}: awaited before onPromptSent and before the spawn`, async () => {
      const f = await fakeCli();
      const order: string[] = [];
      let entered!: () => void;
      const asked = new Promise<void>((r) => { entered = r; });
      let release!: (v: "go") => void;
      const held = new Promise<"go">((r) => { release = r; });
      const hp = hardenedProvider(cfgFor(f.cli, cfg), { ...fast, stateDir: f.state,
        beforeSummaryGenerate: () => { order.push("check"); entered(); return held; } });
      const running = hp.generate("x", { onPromptSent: () => order.push("told") });
      await asked;
      await Bun.sleep(100);                                          // long enough for a spawn that did not wait to log itself
      expect(order).toEqual(["check"]);
      expect(await f.spawns()).toEqual([]);
      release("go");
      await running;
      expect(order).toEqual(["check", "told"]);
      expect((await f.spawns()).length).toBe(1);
    });
  }
});

// ── O16: the sentinel never reaches a generation spawn ───────────────────────────────────────────────

describe("no safe unlocked input: the sentinel is never sent, on either branch of the common send", () => {
  const generate = (hp: ReturnType<typeof hardenedProvider>) =>
    hp.generate(SENTINEL, { calendarVariants: { locked: FULL_PAGE, unlocked: SENTINEL } });

  const UNLOCKED: { name: string; help?: string; cliName?: string; cfg: Partial<Cfg> }[] = [
    { name: "harden: false on stdin", cfg: { harden: false } },
    { name: "harden: false with the prompt as an argument", cfg: { harden: false, promptVia: "arg" } },
    { name: "partial flags", help: "--tools", cfg: {} },
    { name: "partial flags with the prompt as an argument", help: "--tools", cfg: { promptVia: "arg" } },
    { name: "a flag off the allow-list", cfg: { argv: ["--add-dir", "/x"] } },
    { name: "a CLI that is not claude", cliName: "codex", cfg: {} },
  ];
  for (const k of UNLOCKED) {
    test(`unlocked, ${k.name}: refused with zero spawns`, async () => {
      const f = await fakeCli({ help: k.help, name: k.cliName });
      const hp = hardenedProvider(cfgFor(f.cli, k.cfg), { ...fast, stateDir: f.state, beforeSummaryGenerate: async (i) => lockedOnly(i) });
      await expect(generate(hp)).rejects.toBeInstanceOf(SummaryUnavailableError);
      expect(await f.spawns()).toEqual([]);
    });
  }

  for (const promptVia of ["stdin", "arg"] as const) {
    test(`locked, prompt via ${promptVia}: only the full locked variant is sent`, async () => {
      const f = await fakeCli();
      const hp = hardenedProvider(cfgFor(f.cli, { promptVia }), { ...fast, stateDir: f.state, beforeSummaryGenerate: async (i) => lockedOnly(i) });
      await generate(hp);
      const spawns = await f.spawns();
      expect(spawns.length).toBe(1);
      expect(received(spawns)).toContain(FULL_PAGE);
      expect(received(spawns)).not.toContain(SENTINEL);
    });
  }

  test("the flag-rejection respawn drops to unlocked, so the check refuses it: one locked spawn, no sentinel", async () => {
    const f = await fakeCli({ mode: "reject" });
    const hp = hardenedProvider(cfgFor(f.cli), { ...fast, stateDir: f.state, beforeSummaryGenerate: async (i) => lockedOnly(i) });
    await expect(generate(hp)).rejects.toBeInstanceOf(SummaryUnavailableError);
    const spawns = await f.spawns();
    expect(spawns.length).toBe(1);
    expect(spawns[0]!.stdin).toBe(FULL_PAGE);
    expect(received(spawns)).not.toContain(SENTINEL);
  });
});

// ── the no-respawn rule stays with the existing `beforeSpawn` ────────────────────────────────────────

describe("a throwing beforeSpawn blocks both respawns, each with one generation spawn", () => {
  for (const mode of ["reject", "cwd-gone"] as const) {
    test(mode === "reject" ? "the rejected flag" : "the unusable cwd", async () => {
      const f = await fakeCli({ mode });
      const c = recordingCheck(() => "go");
      let spawnChecks = 0;
      const hp = hardenedProvider(cfgFor(f.cli), { ...fast, stateDir: f.state,
        beforeSummaryGenerate: c.check,
        beforeSpawn: async () => { spawnChecks++; throw new SummaryUnavailableError(); } });
      await expect(hp.generate("x")).rejects.toBeInstanceOf(SummaryUnavailableError);
      expect(spawnChecks).toBe(1);
      expect(c.calls.length).toBe(1);                                // the respawn's send was never reached
      expect((await f.spawns()).length).toBe(1);
    });
  }
});
