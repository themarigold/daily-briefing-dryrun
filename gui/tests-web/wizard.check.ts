/**
 * B8 — T16's first-run wizard: the pure rules in `lib/wizard.ts`, the rendered component, and the
 * CLI-shim wording in `lib/shim.ts`.
 *
 * ⚠ THE GOLDENS ARE THE ENGINE AND THE RUST SOURCE. The template constants the wizard mirrors
 * (`DEFAULT_BUDGET`, `DEFAULT_LOOKBACK_CAP_DAYS`, `DEFAULT_NETWORK_PROBE_HOSTS`) are imported
 * READ-ONLY from `src/config.ts` — the wizard itself cannot import them into a webview bundle
 * (config.ts pulls `node:fs`), so its copies are pinned here instead. The first-wake sentence is
 * pinned against `schedule_state.rs`'s own format string, read from the Rust source, because the
 * canonical wording lives there (`first_wake_sentence`).
 *
 * ⚠ CANCEL WRITES NOTHING is enforceable because `lib/wizard.ts` performs no IPC at all: this
 * file additionally scans the module's source for `invoke(` — the wizard's one write happens in
 * `Wizard.svelte`, at the step-5 gate, through `configCreate`/`configSave` only.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

// READ-ONLY imports of the engine's own template constants (no top-level side effects).
import {
  DEFAULT_BUDGET,
  DEFAULT_LOOKBACK_CAP_DAYS,
  DEFAULT_NETWORK_PROBE_HOSTS,
} from "../../src/config";
import Wizard from "../src/routes/Wizard.svelte";
import { REDACTED_API_KEY } from "../src/lib/files";
import { describeShimFailure, placementLine, type CliShimStatus } from "../src/lib/shim";
import {
  buildConfig,
  cancelWritesNothing,
  DEFAULT_FLOOR,
  DEFAULT_NETWORK_PROBE_HOSTS as WIZARD_PROBE_HOSTS,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_LOOKBACK_CAP_DAYS as WIZARD_LOOKBACK,
  draftFromConfig,
  draftPaths,
  emptyDraft,
  firstWakeSentence,
  floorValid,
  mergeConfig,
  nextStep,
  previousStep,
  PREFILL_API_MODEL,
  providerValue,
  saveGateBlocker,
  savePlan,
  stepBlocker,
  STEP_ORDER,
  type WizardDraft,
} from "../src/lib/wizard";

const FULL = readFileSync(
  new URL("../src-tauri/tests/fixtures/config-full.json", import.meta.url),
  "utf8",
);

function html(props: Record<string, unknown> = {}): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(Wizard as any, { props: { scheduleState: null, ...props } }).body;
}

/* ── the engine's template, mirrored not re-invented ──────────────────────────────────────────── */

describe("the wizard's constants are the engine's", () => {
  test("budget, lookback and the probe-host pair match src/config.ts exactly", () => {
    expect(DEFAULT_TOKEN_BUDGET).toEqual(DEFAULT_BUDGET);
    expect(WIZARD_LOOKBACK).toBe(DEFAULT_LOOKBACK_CAP_DAYS);
    expect(WIZARD_PROBE_HOSTS).toEqual(DEFAULT_NETWORK_PROBE_HOSTS);
  });

  test("the CLI argv choices are the ones initConfig writes", () => {
    // The engine's own choice lives inside `initConfig` (not exported); pin it at source level,
    // the same way `engine_env.rs` pins the PATH line.
    const source = readFileSync(new URL("../../src/config.ts", import.meta.url), "utf8");
    expect(source).toContain('cli === codexPath ? ["exec"] : ["-p"]');
    const cli = providerValue({ ...emptyDraft(), providerPath: "cli", cli: "claude" }, undefined);
    expect(cli["argv"]).toEqual(["-p"]);
    expect(cli["promptVia"]).toBe("stdin");
    expect(cli["harden"]).toBe(true);
    expect(cli["credential"]).toBe("subscription");
    const codex = providerValue({ ...emptyDraft(), providerPath: "cli", cli: "codex" }, undefined);
    expect(codex["argv"]).toEqual(["exec"]);
  });

  test("the default floor is the engine's 07:20", () => {
    const source = readFileSync(new URL("../../src/schedule.ts", import.meta.url), "utf8");
    expect(source).toContain(`"${DEFAULT_FLOOR}"`);
    expect(DEFAULT_FLOOR).toBe("07:20");
  });
});

/* ── the first-wake sentence: the Rust source is the canon ────────────────────────────────────── */

test("the first-wake sentence is schedule_state.rs's, word for word", () => {
  const rust = readFileSync(
    new URL("../src-tauri/src/schedule_state.rs", import.meta.url),
    "utf8",
  );
  // The Rust format string, with its line-continuation unsplit.
  const template = /format!\(\s*"([^"]+)"\s*\)/.exec(
    rust.slice(rust.indexOf("pub fn first_wake_sentence")),
  );
  expect(template).not.toBeNull();
  const rustSentence = template![1]!.replace(/\\\s+/g, "").replaceAll("{floor}", "07:20");
  expect(firstWakeSentence("07:20")).toBe(rustSentence);
  // And the floor substitutes — the wording is "earliest, not exact" for whatever is chosen.
  expect(firstWakeSentence("09:00")).toContain("after 09:00");
  expect(firstWakeSentence("09:00")).toContain("not at 09:00");
});

/* ── steps, skips, cancel ─────────────────────────────────────────────────────────────────────── */

describe("the step machine", () => {
  test("six steps in R1's order; access is conditional, delivery unconditional", () => {
    expect(STEP_ORDER).toEqual(["welcome", "provider", "repos", "access", "floor", "delivery"]);
    expect(nextStep("repos", true)).toBe("access");
    expect(nextStep("repos", false)).toBe("floor");
    expect(nextStep("access", true)).toBe("floor");
    expect(nextStep("floor", false)).toBe("delivery");
    expect(nextStep("delivery", true)).toBeNull();
    expect(previousStep("floor", false)).toBe("repos");
    expect(previousStep("floor", true)).toBe("access");
    expect(previousStep("welcome", true)).toBeNull();
  });

  test("cancel writes nothing on every step before the save gate", () => {
    for (const step of STEP_ORDER) {
      expect(cancelWritesNothing(step)).toBe(step !== "delivery");
    }
  });

  test("lib/wizard.ts performs no IPC at all — the one write lives in the component's save gate", () => {
    const source = readFileSync(new URL("../src/lib/wizard.ts", import.meta.url), "utf8");
    expect(source).not.toContain("invoke(");
    expect(source).not.toContain("@tauri-apps/api");
    const component = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    // Exactly one call site each; both inside saveAndContinue.
    expect(component.match(/configCreate\(/g)).toHaveLength(1);
    expect(component.match(/configSave\(/g)).toHaveLength(1);
  });
});

/* ── the three provider paths ─────────────────────────────────────────────────────────────────── */

describe("the provider step's three paths", () => {
  test("path (b): the model is prefilled and must be explicitly confirmed", () => {
    expect(PREFILL_API_MODEL).toBe("claude-sonnet-5");
    const draft: WizardDraft = { ...emptyDraft(), providerPath: "api" };
    expect(draft.apiModel).toBe(PREFILL_API_MODEL);
    expect(stepBlocker("provider", draft)).toContain("Confirm the model");
    draft.apiModelConfirmed = true;
    expect(stepBlocker("provider", draft)).toContain("API key");
    draft.apiKeyFile = "~/.config/daily-briefing/key";
    expect(stepBlocker("provider", draft)).toBeNull();
  });

  test("path (b) carries the key BY REFERENCE only — no apiKey key can appear in a create", () => {
    const draft: WizardDraft = {
      ...emptyDraft(),
      providerPath: "api",
      apiModelConfirmed: true,
      apiKeyFile: "~/.config/daily-briefing/key",
      apiKeyCommand: "security\nfind-generic-password\n-w",
    };
    const provider = providerValue(draft, undefined);
    const api = provider["api"] as Record<string, unknown>;
    expect(api["kind"]).toBe("anthropic");
    expect(api["model"]).toBe(PREFILL_API_MODEL);
    expect(api["apiKeyFile"]).toBe("~/.config/daily-briefing/key");
    expect(api["apiKeyCommand"]).toEqual(["security", "find-generic-password", "-w"]);
    expect("apiKey" in api).toBe(false);
    expect(JSON.stringify(buildConfig(draft))).not.toContain('"apiKey"');
  });

  test("path (c): raised timeout, network gate off, openai-compatible endpoint", () => {
    const draft: WizardDraft = {
      ...emptyDraft(),
      providerPath: "local",
      localBaseUrl: "http://127.0.0.1:11434/v1",
      localModel: "qwen3",
    };
    expect(stepBlocker("provider", draft)).toBeNull();
    const config = buildConfig(draft);
    const provider = config["provider"] as Record<string, unknown>;
    expect(provider["timeoutMs"]).toBe(600000);
    expect((provider["api"] as Record<string, unknown>)["kind"]).toBe("openai-compatible");
    expect((provider["api"] as Record<string, unknown>)["baseUrl"]).toBe(
      "http://127.0.0.1:11434/v1",
    );
    expect(config["networkProbeHosts"]).toEqual([]);
  });

  test("path (a)'s create is initConfig's template shape; path (b) omits networkProbeHosts", () => {
    const cli = buildConfig(emptyDraft());
    expect(cli["networkProbeHosts"]).toEqual(DEFAULT_NETWORK_PROBE_HOSTS);
    expect(cli["tokenBudget"]).toEqual(DEFAULT_BUDGET);
    expect(cli["lookbackCapDays"]).toBe(DEFAULT_LOOKBACK_CAP_DAYS);
    expect(cli["morningTime"]).toBeUndefined();
    expect(cli["discoverRoots"]).toEqual(["~"]);

    const api = buildConfig({
      ...emptyDraft(),
      providerPath: "api",
      apiModelConfirmed: true,
      apiKeyFile: "/k",
    });
    // Absent, the run derives probe hosts from the endpoint (initConfig's own note).
    expect("networkProbeHosts" in api).toBe(false);
  });
});

/* ── repos, scope, floor ──────────────────────────────────────────────────────────────────────── */

describe("the repos step", () => {
  test("Desktop/Documents/Downloads start DESELECTED (R1's grant-acquisition graft)", () => {
    const draft = emptyDraft();
    expect(draft.rootDesktop).toBe(false);
    expect(draft.rootDocuments).toBe(false);
    expect(draft.rootDownloads).toBe(false);
    expect(draft.rootHome).toBe(true);
    expect(draftPaths(draft)).toEqual(["~"]);
  });

  test("draftPaths is what the access snapshot sees: repos + roots, de-duplicated", () => {
    const draft: WizardDraft = {
      ...emptyDraft(),
      rootDocuments: true,
      customRoots: "~/dev\n~/dev",
      explicitRepos: "~/Documents/proj\n",
    };
    expect(draftPaths(draft)).toEqual(["~/Documents/proj", "~", "~/Documents", "~/dev"]);
  });

  test("at least one source is required to continue", () => {
    const none: WizardDraft = { ...emptyDraft(), rootHome: false };
    expect(stepBlocker("repos", none)).toContain("at least one");
    expect(stepBlocker("repos", emptyDraft())).toBeNull();
  });

  test("the floor must be a warning-free HH:MM", () => {
    for (const good of ["00:00", "07:20", "23:59"]) expect(floorValid(good)).toBe(true);
    for (const bad of ["24:00", "7:20", "07:60", "0720", "late", ""]) {
      expect(floorValid(bad)).toBe(false);
    }
    expect(stepBlocker("floor", { ...emptyDraft(), floor: "25:00" })).toContain("HH:MM");
  });
});

/* ── the save plan: create vs edit, no clobber, round-trip preservation ───────────────────────── */

describe("the save plan", () => {
  test("no document → create; an existing document → the base-token edit", () => {
    const create = savePlan({ exists: false, text: null, base: null }, emptyDraft());
    expect(create.kind).toBe("create");

    const draft = draftFromConfig(FULL)!;
    const edit = savePlan({ exists: true, text: FULL, base: "tok" }, draft);
    expect(edit).toMatchObject({ kind: "save", base: "tok" });
  });

  test("a changed floor edits ONLY the wizard-owned key; unknown fields survive in place", () => {
    const draft = { ...draftFromConfig(FULL)!, floor: "09:15" };
    const merged = mergeConfig(FULL, draft) as Record<string, unknown>;
    const original = JSON.parse(FULL) as Record<string, unknown>;
    expect(merged["morningTime"]).toBe("09:15");
    expect(merged["$comment"]).toBe(original["$comment"]);
    expect(merged["author"]).toEqual(original["author"]);
    expect(Object.keys(merged)).toEqual(
      Object.keys(original).includes("morningTime")
        ? Object.keys(original)
        : [...Object.keys(original), "morningTime"],
    );
  });

  test("switching to the api path keeps a stored key's placeholder and unowned api keys", () => {
    const existing = JSON.stringify({
      provider: {
        api: {
          kind: "anthropic",
          model: "old-model",
          maxTokens: 2048,
          apiKey: REDACTED_API_KEY,
        },
      },
    });
    const draft = draftFromConfig(existing)!;
    expect(draft.providerPath).toBe("api");
    expect(draft.apiModel).toBe("old-model");
    expect(draft.apiModelConfirmed).toBe(true);
    const merged = mergeConfig(existing, { ...draft, apiModel: "claude-sonnet-5" }) as Record<
      string,
      unknown
    >;
    const api = (merged["provider"] as Record<string, unknown>)["api"] as Record<string, unknown>;
    expect(api["model"]).toBe("claude-sonnet-5");
    expect(api["maxTokens"]).toBe(2048);
    expect(api["apiKey"]).toBe(REDACTED_API_KEY);
  });
});

/* ── round 1: the recovery path (F1) ──────────────────────────────────────────────────────────── */

describe("the alreadyExists recovery (round 1)", () => {
  test("the recovery sequence: re-seeded draft, then a second save that preserves everything byte-for-byte (unknown fields, order, a kept CLI provider's customised argv)", () => {
    // The clobber this pins against (measured): a config appears mid-wizard, the create is
    // refused, and the UN-reseeded draft — built for a fresh setup — was merged over it on the
    // next click (repos deleted, provider rebuilt as template, floor reset). The recovery now
    // re-seeds FROM the file; a second save with that draft merges to a VALUE-identical
    // document, which the save path answers as its `unchanged` no-op. M-L1-A's target.
    //
    // This is also the do-not-clobber round-trip pin: pre-populate from the config, change nothing,
    // merge — the result is VALUE-identical AND serialises identically. The premise below is what
    // makes that pin bite for the provider: the fixture's argv really is customised, so a kept CLI
    // provider being silently rebuilt as the template would change the bytes.
    const original = JSON.parse(FULL) as Record<string, unknown>;
    expect((original["provider"] as Record<string, unknown>)["argv"]).toEqual(["-p", "--model", "sonnet"]);
    const seeded = draftFromConfig(FULL);
    expect(seeded).not.toBeNull();
    const merged = mergeConfig(FULL, seeded!) as Record<string, unknown>;
    expect((merged["provider"] as Record<string, unknown>)["argv"]).toEqual(["-p", "--model", "sonnet"]);
    expect(JSON.stringify(merged, null, 2)).toBe(JSON.stringify(original, null, 2));
    const plan = savePlan({ exists: true, text: FULL, base: "tok" }, seeded!);
    expect(plan.kind).toBe("save");
    expect((plan as { text: string }).text).toBe(JSON.stringify(original, null, 2));
  });

  test("a config whose fields cannot be seeded blocks the gate — never an empty-draft merge", () => {
    // M-L1-B's target: `{"provider":{"api":null}}` (measured) used to throw past the JSON.parse
    // catch, leave the draft empty and the save enabled.
    expect(draftFromConfig('{"provider":{"api":null}}')).toBeNull();
    expect(draftFromConfig('{"provider":"a string"}')).toBeNull();
    expect(draftFromConfig("not json")).toBeNull();
    expect(draftFromConfig("[]")).toBeNull();
    // Round 2 (V-2): `null` above is ALSO caught by the final field-read catch (`api["kind"]`
    // throws on null), so it never pinned the shape guard itself — deleting the guard survived.
    // `[]` and a scalar do NOT throw (property access on both answers `undefined`), so without
    // the guard they would seed a guessed "api"-path draft. These two pin what the guard
    // uniquely refuses.
    expect(draftFromConfig('{"provider":{"api":[]}}')).toBeNull();
    expect(draftFromConfig('{"provider":{"api":3}}')).toBeNull();
    // …while ordinary shapes still seed.
    expect(draftFromConfig("{}")).not.toBeNull();
    expect(draftFromConfig(FULL)).not.toBeNull();
  });

  test("the gate blockers: seed failure always blocks; a recovery blocks until acknowledged", () => {
    expect(
      saveGateBlocker({ seedFailed: true, recovered: false, acknowledged: false }),
    ).toContain("could not be read");
    expect(
      saveGateBlocker({ seedFailed: false, recovered: true, acknowledged: false }),
    ).toContain("Confirm");
    expect(saveGateBlocker({ seedFailed: false, recovered: true, acknowledged: true })).toBeNull();
    expect(
      saveGateBlocker({ seedFailed: false, recovered: false, acknowledged: false }),
    ).toBeNull();
  });

  test("the component wires it: one seed helper for onMount AND the save catch, gate on the button", () => {
    const component = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    // Definition plus exactly two call sites (pre-populate, recovery).
    expect(component.match(/seedFromDocument\(/g)).toHaveLength(3);
    // The recovery is scoped to the two file-changed refusals, and requires the checkbox.
    expect(component).toContain('kind === "alreadyExists" || kind === "conflict"');
    expect(component).toContain("recoverAck");
    expect(component.match(/saveGateBlocker\(/g)).toHaveLength(1);
    // `unchanged` is an explicit success on the save path (GB2): the step-6 copy names it.
    expect(component).toContain("Your configuration is unchanged");
    // Round 2 (V-1): the gate's ENFORCEMENT, source-pinned. Two one-token mutations left the
    // whole suite green — dropping `gateBlocker !== null ||` from the save button's disabled,
    // and flipping `seedFromDocument`'s `seedFailed = true;`. The tests above exercise the pure
    // pieces; these two assert the component actually wires them into the one save gate.
    expect(component).toContain("disabled={blocker !== null || gateBlocker !== null || saving}");
    expect(component).toContain("seedFailed = true;");
  });

  test("GE2 refuted: a local api block missing model/baseUrl seeds empty fields AND the provider step blocks", () => {
    // An existing `kind:"openai-compatible"` config with missing or non-string `model`/`baseUrl`
    // seeds empty strings rather than failing the seed — deliberately: the user gets the
    // pre-populated wizard with `stepBlocker` naming exactly what is missing, and the provider
    // step's Continue stays disabled until the gap is filled. The flow is sequential
    // (STEP_ORDER), so the step-5 save is unreachable on the FORWARD walk; the recovery
    // re-seed re-enters at the floor step and relies on the engine validator as the backstop
    // (measured in round-2 verify: the invalid candidate is refused, the file untouched) —
    // strictly better than a seed failure, which would shut the whole gate over a fillable
    // field.
    const draft = draftFromConfig('{"provider":{"api":{"kind":"openai-compatible","model":7}}}');
    expect(draft).not.toBeNull();
    expect(draft!.providerPath).toBe("local");
    expect(draft!.localModel).toBe("");
    expect(draft!.localBaseUrl).toBe("");
    expect(stepBlocker("provider", draft!)).toContain("endpoint URL");
    const withUrl = { ...draft!, localBaseUrl: "http://127.0.0.1:11434/v1" };
    expect(stepBlocker("provider", withUrl)).toContain("model");
    expect(stepBlocker("provider", { ...withUrl, localModel: "qwen3" })).toBeNull();
  });
});

/* ── round 1: merge rules (F4, F11) ───────────────────────────────────────────────────────────── */

describe("round-1 merge rules", () => {
  test("a path-(c) config with an explicit networkProbeHosts round-trips untouched (F4)", () => {
    // The FULL fixture is CLI-only, which is why the unconditional `[]` survived the suite: an
    // untouched re-run of a LOCAL config was not the `unchanged` no-op (measured:
    // `[{host:"1.1.1.1",port:443}]` → `[]`).
    const local = JSON.stringify(
      {
        $comment: "unknown fields ride through",
        provider: {
          api: { kind: "openai-compatible", model: "qwen3", baseUrl: "http://127.0.0.1:11434/v1" },
          timeoutMs: 240000,
        },
        networkProbeHosts: [{ host: "1.1.1.1", port: 443 }],
        repos: ["~/dev/a"],
      },
      null,
      2,
    );
    const draft = draftFromConfig(local)!;
    expect(draft.providerPath).toBe("local");
    expect(JSON.stringify(mergeConfig(local, draft), null, 2)).toBe(local);
    // The prefill still lands where the key is ABSENT — the create.
    const created = buildConfig({
      ...emptyDraft(),
      providerPath: "local",
      localBaseUrl: "http://127.0.0.1:11434/v1",
      localModel: "qwen3",
    });
    expect(created["networkProbeHosts"]).toEqual([]);
  });

  test("switching the CLI deliberately rebuilds argv (GB1's other half, adjudicated: kept)", () => {
    // A codex argv on a claude CLI (or vice versa) would be wrong: changing the provider
    // legitimately rebuilds the wizard-owned keys. Unowned keys still ride through.
    const existing = JSON.stringify({
      provider: {
        cli: "claude",
        argv: ["-p", "--model", "sonnet"],
        promptVia: "stdin",
        harden: true,
        credential: "subscription",
        timeoutMs: 240000,
      },
    });
    const draft = { ...draftFromConfig(existing)!, cli: "codex" as const };
    const provider = (mergeConfig(existing, draft) as Record<string, unknown>)["provider"] as Record<
      string,
      unknown
    >;
    expect(provider["cli"]).toBe("codex");
    expect(provider["argv"]).toEqual(["exec"]);
    expect(provider["timeoutMs"]).toBe(240000);
  });

  test("setting the floor back to the default still writes it where the key exists (F11.1)", () => {
    const existing = JSON.stringify({ morningTime: "09:00" });
    const draft = { ...draftFromConfig(existing)!, floor: "07:20" };
    expect((mergeConfig(existing, draft) as Record<string, unknown>)["morningTime"]).toBe("07:20");
  });

  test("keepOrSet compares MULTISETS: a duplicate-count difference is a real change (F11.2)", () => {
    const existing = JSON.stringify({ repos: ["~/a", "~/a", "~/b"] });
    const dupes = { ...draftFromConfig(existing)!, explicitRepos: "~/a\n~/b\n~/b" };
    expect((mergeConfig(existing, dupes) as Record<string, unknown>)["repos"]).toEqual([
      "~/a",
      "~/b",
      "~/b",
    ]);
    // …while a mere reorder of the same members keeps the existing array, order included.
    const reordered = { ...draftFromConfig(existing)!, explicitRepos: "~/b\n~/a\n~/a" };
    expect((mergeConfig(existing, reordered) as Record<string, unknown>)["repos"]).toEqual([
      "~/a",
      "~/a",
      "~/b",
    ]);
  });

  test("blank textarea lines are dropped before the repos blocker counts sources (GB3, pinned)", () => {
    const draft = { ...emptyDraft(), rootHome: false, explicitRepos: "   \n\n \n", customRoots: " \n" };
    expect(draftPaths(draft)).toEqual([]);
    expect(stepBlocker("repos", draft)).toContain("at least one");
  });
});

/* ── the rendered component ───────────────────────────────────────────────────────────────────── */

describe("the wizard renders", () => {
  test("step 1 says local-first, no telemetry, BYO AI — and that cancelling writes nothing", () => {
    const body = html();
    expect(body).toContain("Set up Daily Briefing");
    expect(body).toContain("Step 1 of 6");
    expect(body).toContain("Local-first");
    expect(body).toContain("No telemetry");
    expect(body).toContain("Bring your own AI");
    expect(body).toContain("Cancelling now changes nothing");
    expect(body).toContain("Set up later");
  });
});

/* ── the CLI-shim wording (dev 63) ────────────────────────────────────────────────────────────── */

describe("the CLI-shim wording", () => {
  const base: CliShimStatus = {
    supported: true,
    shimPath: "/usr/local/bin/daily-briefing",
    target: "/Users/x/Library/Application Support/daily-briefing/daily-briefing",
    state: "absent",
  };

  test("each placement is one sentence naming the path", () => {
    expect(placementLine(base)).toContain("/usr/local/bin/daily-briefing");
    expect(placementLine({ ...base, state: "current" })).toContain("works in a terminal");
    expect(placementLine({ ...base, state: "stale", pointsTo: "/old" })).toContain("/old");
    const foreign = placementLine({
      ...base,
      state: "foreign",
      pointsTo: null,
      detail: "a regular file",
    });
    expect(foreign).toContain("a regular file");
    expect(foreign).toContain("will not replace or remove");
  });

  test("a permission refusal shows the exact manual command and never escalates in-app", () => {
    const text = describeShimFailure({
      kind: "needsManualStep",
      command: "sudo ln -sfn /target /usr/local/bin/daily-briefing",
      detail: "Permission denied (os error 13)",
    });
    expect(text).toContain("sudo ln -sfn /target /usr/local/bin/daily-briefing");
    expect(text).toContain("in a terminal");
    expect(
      describeShimFailure({ kind: "foreign", path: "/usr/local/bin/daily-briefing", detail: "a regular file" }),
    ).toContain("will not replace or remove");
  });
});
