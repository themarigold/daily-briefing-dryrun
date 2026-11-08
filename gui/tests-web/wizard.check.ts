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
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { render } from "svelte/server";

// READ-ONLY imports of the engine's own template constants (no top-level side effects).
import {
  DEFAULT_BUDGET,
  DEFAULT_LOOKBACK_CAP_DAYS,
  DEFAULT_NETWORK_PROBE_HOSTS,
  normalizeProviderBlock,
  resolveAccounts,
  validateConfig,
} from "../../src/config";
import {
  APP_KEY_SERVICE,
  SECURITY_BIN,
  appKeyOwnership,
  listOrder,
  resolveProviderList,
} from "../../src/providerList";
import { keyOptional } from "../../src/providers/endpoint";
import Wizard from "../src/routes/Wizard.svelte";
import { describeFailure, REDACTED_API_KEY } from "../src/lib/files";
import { osFromUserAgent, type Os } from "../src/lib/platform";
import { describeShimFailure, placementLine, type CliShimStatus } from "../src/lib/shim";
import {
  buildConfig,
  cancelWritesNothing,
  DEFAULT_FLOOR,
  doctorRepoNotes,
  DEFAULT_NETWORK_PROBE_HOSTS as WIZARD_PROBE_HOSTS,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_LOOKBACK_CAP_DAYS as WIZARD_LOOKBACK,
  draftFromConfig,
  draftPaths,
  emptyDraft,
  finishLoginItem,
  firstWakeSentence,
  floorValid,
  JUDGE_LINE,
  LOCAL_TIMEOUT_MS,
  loginItemChecked,
  loginItemNote,
  loginItemPlan,
  mergeConfig,
  settleLoginItemDefault,
  type LoginItemDefault,
  nextStep,
  previousStep,
  PREFILL_API_MODEL,
  ProviderListRefusal,
  pastedForModel,
  pastedInUse,
  pastedToRelease,
  pastedUsable,
  releaseOnLeave,
  seedDrops,
  setApiModel,
  useAnywayOffered,
  type PastedKey,
  providerValue,
  saveGateBlocker,
  savePlan,
  stepBlocker,
  STEP_ORDER,
  type NavState,
  type WizardDraft,
  wizardNav,
  wizardOsWording,
} from "../src/lib/wizard";
import { pasteKey, pasteKeyNote, releaseKey, retestKey } from "../src/lib/wizard-key";

/** `text.slice(start, end)` between two anchors, asserting both exist and are ordered (plan rule 0.2, M3). */
function between(text: string, from: string, to: string): string {
  const start = text.indexOf(from);
  expect([from, start]).not.toEqual([from, -1]);
  const end = text.indexOf(to, start + from.length);
  expect([to, end]).not.toEqual([to, -1]);
  expect(start).toBeLessThan(end);
  return text.slice(start, end);
}

/** `wizardNav` with nothing busy (design 2026-10-31 §3; the full table is `wizard-nav.check.ts`'s). */
const NAV_IDLE: NavState = {
  saving: false, keyBusy: false, accessLoading: false, installBusy: false,
  verifyInFlight: false, verifyTriggered: false, finishing: false, calendarBusy: false,
};

const FULL = readFileSync(
  new URL("../src-tauri/tests/fixtures/config-full.json", import.meta.url),
  "utf8",
);

function html(props: Record<string, unknown> = {}): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return render(Wizard as any, { props: { scheduleState: null, os: "macos", ...props } }).body;
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
  test("R1's six steps in order plus E12's consent; access is conditional, delivery unconditional", () => {
    // Phase E (E12): `updates` (the update-check consent) sits BEFORE `floor`, which stays the save
    // gate — so the consent answer is part of the one write.
    // v0.3.0 (plan M9): the optional calendar step sits AFTER the save gate and before delivery
    // (`tests-web/calendar.check.ts` pins why and how it stays off by default).
    expect(STEP_ORDER).toEqual(["welcome", "provider", "repos", "access", "updates", "floor", "calendar", "delivery"]);
    expect(nextStep("repos", true)).toBe("access");
    expect(nextStep("repos", false)).toBe("updates");
    expect(nextStep("access", true)).toBe("updates");
    expect(nextStep("updates", false)).toBe("floor");
    expect(nextStep("floor", false)).toBe("calendar");
    expect(nextStep("calendar", false)).toBe("delivery");
    expect(nextStep("delivery", true)).toBeNull();
    expect(previousStep("floor", false)).toBe("updates");
    // …and with access IN scope too: `access` sits before `updates`, so the skip rule must not
    // reach past `updates` from either side (Phase E final harden, GM2-2).
    expect(previousStep("floor", true)).toBe("updates");
    expect(nextStep("updates", true)).toBe("floor");
    expect(previousStep("updates", false)).toBe("repos");
    expect(previousStep("updates", true)).toBe("access");
    expect(previousStep("welcome", true)).toBeNull();
  });

  test("cancel writes nothing on every step before the save gate", () => {
    for (const step of STEP_ORDER) {
      expect(cancelWritesNothing(step)).toBe(step !== "calendar" && step !== "delivery");
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
    // P3-M6-T3: a key file is the ADVANCED choice; on the default (paste) it does not unblock the step.
    draft.apiKeyFile = "~/.config/daily-briefing/key";
    expect(stepBlocker("provider", draft)).toContain("Paste your API key");
    draft.apiKeyAdvanced = true;
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
    // v0.2.1 §3.1: one name for the setting. (The dropdowns write HH:MM only, so this guard is a
    // backstop — `morning-time.check.ts` pins that a seeded draft never trips it.)
    expect(stepBlocker("floor", { ...emptyDraft(), floor: "25:00" })).toBe("Choose a morning time.");
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

  /* P3-M2-T1 checkpoint (HIGH): a stored key is bound to its endpoint. A re-run that changes item 1's `api.kind`
   * or its endpoint ORIGIN drops every key source the block carried — `apiKey` (the stored literal's placeholder),
   * `apiKeyFile`, `apiKeyCommand`, `apiKeyEnv` — so none is sent to the new endpoint. The key is simply GONE from
   * the save (not refused): the user chose a new endpoint and sets its key afresh, and the stored literal is never
   * restored there. (Rust refuses the old shape on its own too — `tests/config_save.rs`
   * `a_stored_key_is_bound_to_its_endpoint_kind_and_origin` — so this is not the only guard.) */
  const KEY_SOURCES = ["apiKey", "apiKeyFile", "apiKeyCommand", "apiKeyEnv"];
  const apiOf = (merged: unknown): Record<string, unknown> =>
    ((merged as Record<string, unknown>)["provider"] as Record<string, unknown>)["api"] as Record<string, unknown>;

  test("the reviewer's repro: an Anthropic → local re-run never carries the stored key to the new endpoint", () => {
    const existing = JSON.stringify({
      provider: {
        api: {
          kind: "anthropic", model: "claude-sonnet-5", maxTokens: 2048, apiKey: REDACTED_API_KEY,
          apiKeyEnv: "ANTHROPIC_KEY", apiKeyFile: "/keys/anthropic.key", apiKeyCommand: ["pass", "anthropic"],
        },
      },
    });
    const draft = { ...draftFromConfig(existing)!, providerPath: "local" as const,
      localBaseUrl: "http://192.168.1.5:8080/v1", localModel: "llama3" };
    const merged = mergeConfig(existing, draft);
    const api = apiOf(merged);
    for (const k of KEY_SOURCES) expect(api).not.toHaveProperty(k);
    expect(api).toEqual({ maxTokens: 2048, kind: "openai-compatible", model: "llama3", baseUrl: "http://192.168.1.5:8080/v1" });
    expect(JSON.stringify(merged)).not.toContain(REDACTED_API_KEY);
  });

  test("a local re-run onto another origin drops the key sources; a model or path change on the same origin keeps them", () => {
    const local = (baseUrl: string): string => JSON.stringify({
      provider: {
        timeoutMs: 600000,
        api: {
          kind: "openai-compatible", model: "llama", baseUrl, apiKey: REDACTED_API_KEY,
          apiKeyEnv: "LOCAL_KEY", apiKeyFile: "/keys/local.key", apiKeyCommand: ["pass", "local"],
        },
      },
    });
    const existing = local("http://127.0.0.1:11434/v1");
    const rerun = (localBaseUrl: string, localModel = "llama") =>
      apiOf(mergeConfig(existing, { ...draftFromConfig(existing)!, localBaseUrl, localModel }));
    for (const moved of ["http://127.0.0.1:11435/v1", "https://127.0.0.1:11434/v1", "http://192.168.1.5:11434/v1", "not a url"]) {
      const api = rerun(moved);
      for (const k of KEY_SOURCES) expect(api).not.toHaveProperty(k);
      expect(api["baseUrl"]).toBe(moved);
    }
    // The same endpoint: a hand-added local literal (and every other source) rides through exactly as today.
    for (const [same, model] of [["http://127.0.0.1:11434/v1", "qwen"], ["http://127.0.0.1:11434/api", "llama"], ["HTTP://127.0.0.1:11434/v1/", "llama"]] as const) {
      const api = rerun(same, model);
      expect(api["apiKey"]).toBe(REDACTED_API_KEY);
      expect(api["apiKeyEnv"]).toBe("LOCAL_KEY");
      expect(api["apiKeyFile"]).toBe("/keys/local.key");
      expect(api["apiKeyCommand"]).toEqual(["pass", "local"]);
      expect(api["model"]).toBe(model);
    }
  });

  test("a local → Anthropic re-run (a kind change) drops the carried key sources and keeps the ones the user typed", () => {
    const existing = JSON.stringify({
      provider: {
        api: { kind: "openai-compatible", model: "llama", baseUrl: "https://gateway.example.com/v1",
          apiKey: REDACTED_API_KEY, apiKeyEnv: "LOCAL_KEY", apiKeyFile: "/keys/local.key", apiKeyCommand: ["pass", "local"] },
      },
    });
    const draft = { ...draftFromConfig(existing)!, providerPath: "api" as const, apiModel: "claude-sonnet-5",
      apiModelConfirmed: true, apiKeyFile: "/keys/anthropic.key" };
    const api = apiOf(mergeConfig(existing, draft));
    expect(api["apiKey"]).toBeUndefined();
    expect(api["apiKeyEnv"]).toBeUndefined();
    expect(api["apiKeyCommand"]).toBeUndefined();
    expect(api["apiKeyFile"]).toBe("/keys/anthropic.key");
    expect(api["kind"]).toBe("anthropic");
  });

  /* P3-M2-T2 (pre-existing gap): `baseUrl` rode through `keptApi` on the api path, so a local → Anthropic re-run
   * wrote the LAN `http:` endpoint onto the new `anthropic` block, and the key file/command the user just typed would
   * be sent there. The api path owns `baseUrl` unless the existing block is already `anthropic` (a user's own
   * Anthropic proxy is kept). */
  test("a local → Anthropic re-run writes no baseUrl; an Anthropic re-run keeps its own proxy's baseUrl", () => {
    const toAnthropic = (api: Record<string, unknown>) => {
      const existing = JSON.stringify({ provider: { api } });
      const draft = { ...draftFromConfig(existing)!, providerPath: "api" as const, apiModel: "claude-sonnet-5",
        apiModelConfirmed: true, apiKeyFile: "/keys/anthropic.key" };
      return apiOf(mergeConfig(existing, draft));
    };
    for (const baseUrl of ["http://192.168.1.5:8080/v1", "http://127.0.0.1:11434/v1", "https://gateway.example.com/v1"]) {
      const api = toAnthropic({ kind: "openai-compatible", model: "llama", baseUrl, maxTokens: 1024 });
      expect(api).not.toHaveProperty("baseUrl");
      // The local model's `maxTokens` is that model's, not Anthropic's: dropped too (checkpoint P3-M2 LOW).
      expect(api).toEqual({ kind: "anthropic", model: "claude-sonnet-5", apiKeyFile: "/keys/anthropic.key" });
    }
    const proxy = toAnthropic({ kind: "anthropic", model: "old", baseUrl: "https://proxy.corp.example/anthropic",
      apiKey: REDACTED_API_KEY });
    expect(proxy["baseUrl"]).toBe("https://proxy.corp.example/anthropic");
    expect(proxy["apiKey"]).toBe(REDACTED_API_KEY);
    expect(proxy["model"]).toBe("claude-sonnet-5");
  });

  /* Checkpoint P3-M2 LOW: a local → Anthropic re-run carried the local path's own values onto the Anthropic block —
   * the block-level `timeoutMs: LOCAL_TIMEOUT_MS` the local path raised (so Anthropic calls waited ten minutes
   * instead of the engine's two, `TIMEOUT_MS`, `src/provider.ts`) and the local model's `maxTokens`. Both are dropped
   * when the api path changes the kind from `openai-compatible`; a `timeoutMs` the user set to anything else is kept,
   * and an Anthropic re-run keeps both. */
  test("a local → Anthropic re-run drops the local timeout and maxTokens; a user's own timeout is kept", () => {
    const toAnthropic = (provider: Record<string, unknown>) => {
      const existing = JSON.stringify({ provider });
      const draft = { ...draftFromConfig(existing)!, providerPath: "api" as const, apiModel: "claude-sonnet-5",
        apiModelConfirmed: true, apiKeyFile: "/keys/anthropic.key" };
      return (mergeConfig(existing, draft) as Json)["provider"] as Json;
    };
    const local = { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1", maxTokens: 2048 };
    const raised = toAnthropic({ timeoutMs: LOCAL_TIMEOUT_MS, api: local });
    expect(raised).not.toHaveProperty("timeoutMs");
    expect(raised["api"]).not.toHaveProperty("maxTokens");
    const own = toAnthropic({ timeoutMs: 300000, api: local });
    expect(own["timeoutMs"]).toBe(300000);
    expect(own["api"]).not.toHaveProperty("maxTokens");
    // An Anthropic re-run is not a kind change: its timeout (even at the local value) and maxTokens ride through.
    const anthropic = toAnthropic({ timeoutMs: LOCAL_TIMEOUT_MS,
      api: { kind: "anthropic", model: "old", maxTokens: 4096, apiKeyFile: "/keys/anthropic.key" } });
    expect(anthropic["timeoutMs"]).toBe(LOCAL_TIMEOUT_MS);
    expect((anthropic["api"] as Json)["maxTokens"]).toBe(4096);
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

  test("P3-M3-T2 INVERTS the accounts carry: a CLI switch no longer drags the other logins onto the new CLI", () => {
    // Before P3-M3-T2, `accounts` was an unowned provider key and rode through a provider change, so
    // claude → codex left every Claude login attached to codex (each a CLAUDE_CONFIG_DIR handed to codex).
    // Now item 1 alone takes the new settings, under its own label, without the old CLI's login directory;
    // the other logins keep their Claude settings as `fallbacks` blocks. Expected split written by hand.
    const existing = JSON.stringify({
      provider: {
        cli: "claude",
        argv: ["-p", "--model", "sonnet"],
        promptVia: "stdin",
        harden: true,
        credential: "subscription",
        timeoutMs: 240000,
        accounts: [{ label: "Work", configDir: "~/.claude-work" }, { label: "Home" }],
      },
    });
    const draft = { ...draftFromConfig(existing)!, cli: "codex" as const };
    const merged = mergeConfig(existing, draft) as Json;
    expect(merged["provider"]).toEqual({
      cli: "codex",
      argv: ["exec"],
      promptVia: "stdin",
      harden: true,
      credential: "subscription",
      timeoutMs: 240000,
      accounts: [{ label: "Work" }],
    });
    expect(merged["fallbacks"]).toEqual([
      {
        label: "Home",
        cli: "claude",
        argv: ["-p", "--model", "sonnet"],
        promptVia: "stdin",
        harden: true,
        credential: "subscription",
        timeoutMs: 240000,
      },
    ]);
    expect(engineList(merged).rows).toEqual([
      { label: "Work", source: "provider", provider: canonBlock({ cli: "codex", argv: ["exec"], promptVia: "stdin", harden: true, credential: "subscription", timeoutMs: 240000 }), configDir: null },
      { label: "Home", source: "fallback", provider: canonBlock({ cli: "claude", argv: ["-p", "--model", "sonnet"], promptVia: "stdin", harden: true, credential: "subscription", timeoutMs: 240000 }), configDir: null },
    ]);
  });
});

/* ── P3-M3-T2: the wizard saves `provider` through the list writer ───────────────────────────── */

type Json = Record<string, unknown>;

/** Every engine call below gets a fake home, an empty env and an `exists` that answers true: nothing reads
 *  the real home, `CLAUDE_CONFIG_DIR` or the disk (the provider-list.check.ts pattern). */
const ENGINE_HOME = "/nonexistent-home-for-wizard-check";

/** Sorted-key JSON, so a block's written key order is not compared. */
function canonJson(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonJson).join(",")}]`;
  if (v !== null && typeof v === "object") {
    return `{${Object.keys(v).sort().filter((k) => (v as Json)[k] !== undefined).map((k) => `${JSON.stringify(k)}:${canonJson((v as Json)[k])}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** A hand-written block as the ENGINE normalises it (`normalizeProviderBlock`), for comparison with a row. */
const canonBlock = (block: Json): string => canonJson(normalizeProviderBlock(structuredClone(block), ENGINE_HOME));

/** The combined list the CURRENT engine walks for `cfg` — its own `validateConfig` + `resolveProviderList`, run
 *  read-only. Nothing here re-derives the answer from the wizard. Asserts the engine dropped nothing and read
 *  no broken `accounts`. */
function engineList(cfg: Json): { rows: { label: string; source: string; provider: string; configDir: string | null }[]; warnings: string[] } {
  const resolved = resolveProviderList(validateConfig(structuredClone(cfg), ENGINE_HOME), ENGINE_HOME, {}, () => true);
  expect(resolved.dropped).toEqual([]);
  expect(resolved.accountsBroken).toBe(false);
  return {
    rows: resolved.entries.map((e) => ({ label: e.label, source: e.source, provider: canonJson(e.provider), configDir: e.configDir ?? null })),
    warnings: resolved.warnings,
  };
}

/** What an OLDER engine (and the audit judge) reads: `provider` and its `accounts`, nothing else. */
function olderEngineLogins(cfg: Json): string[] {
  const c = validateConfig(structuredClone(cfg), ENGINE_HOME);
  if (c.provider.api !== undefined) return ["(api item 1 — accounts not read)"];
  const acc = resolveAccounts(c.provider.accounts, ENGINE_HOME, {}, () => true);
  return acc.accounts?.map((a) => a.label) ?? [];
}

/** The refusal `mergeConfig` (and so `savePlan`) throws, caught for inspection. */
function refusalOf(run: () => unknown): ProviderListRefusal {
  try {
    run();
  } catch (e) {
    if (e instanceof ProviderListRefusal) return e;
    throw e;
  }
  throw new Error("the wizard saved — it was expected to refuse");
}

const CLAUDE_TEMPLATE = { cli: "claude", argv: ["-p"], promptVia: "stdin", harden: true, credential: "subscription" };

describe("P3-M3-T2: the wizard saves `provider` through the list writer", () => {
  test("a re-run that changes item 1 from CLI to API moves the other logins into `fallbacks` — no login stays on an API item 1", () => {
    // FULL: a claude item 1 with two logins, "primary" and "backup" (its own login directory).
    const original = JSON.parse(FULL) as Json;
    const before = original["provider"] as Json;
    expect((before["accounts"] as Json[]).map((a) => a["label"])).toEqual(["primary", "backup"]);
    const draft: WizardDraft = {
      ...draftFromConfig(FULL)!,
      providerPath: "api",
      apiModel: "claude-sonnet-5",
      apiModelConfirmed: true,
      apiKeyFile: "~/keys/anthropic.key",
    };
    const merged = mergeConfig(FULL, draft) as Json;
    // Item 1 keeps its label and its unowned keys; nothing of the list is left on it.
    expect(merged["provider"]).toEqual({
      timeoutMs: 600000,
      "x-provider-extra": { kept: true },
      api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyFile: "~/keys/anthropic.key" },
      label: "primary",
    });
    expect("accounts" in (merged["provider"] as Json)).toBe(false);
    // The second login is a full fallback block: the old CLI settings and its own directory.
    expect(merged["fallbacks"]).toEqual([
      {
        label: "backup",
        configDir: "~/.claude-backup",
        cli: "claude",
        argv: ["-p", "--model", "sonnet"],
        promptVia: "stdin",
        timeoutMs: 600000,
        harden: true,
        credential: "subscription",
        "x-provider-extra": { kept: true },
      },
    ]);
    // Everything outside `provider` / `fallbacks` is untouched, in place.
    const { provider: _p, fallbacks: _f, ...rest } = merged;
    const { provider: _q, ...restBefore } = original;
    expect(JSON.stringify(rest)).toBe(JSON.stringify(restBefore));
    // The engine walks exactly that list; an older engine sees an API item 1 and no logins.
    const engine = engineList(merged);
    expect(engine.rows).toEqual([
      { label: "primary", source: "provider", provider: canonBlock({ timeoutMs: 600000, "x-provider-extra": { kept: true }, api: { kind: "anthropic", model: "claude-sonnet-5", apiKeyFile: "~/keys/anthropic.key" } }), configDir: null },
      { label: "backup", source: "fallback", provider: canonBlock({ ...CLAUDE_TEMPLATE, argv: ["-p", "--model", "sonnet"], timeoutMs: 600000, "x-provider-extra": { kept: true } }), configDir: `${ENGINE_HOME}/.claude-backup` },
    ]);
    expect(engine.warnings.filter((w) => w.includes("accounts"))).toEqual([]);
    expect(olderEngineLogins(merged)).toEqual(["(api item 1 — accounts not read)"]);
  });

  test("item 1's own login directory does not survive onto the API entry (configDir is a Claude login's)", () => {
    const existing = JSON.stringify({
      provider: { ...CLAUDE_TEMPLATE, accounts: [{ label: "A", configDir: "~/.claude-a" }, { label: "B" }] },
    });
    const merged = mergeConfig(existing, {
      ...draftFromConfig(existing)!,
      providerPath: "local",
      localBaseUrl: "http://127.0.0.1:11434/v1",
      localModel: "qwen3",
    }) as Json;
    expect(merged["provider"]).toEqual({
      timeoutMs: 600000,
      api: { kind: "openai-compatible", model: "qwen3", baseUrl: "http://127.0.0.1:11434/v1" },
      label: "A",
    });
    expect(merged["fallbacks"]).toEqual([{ label: "B", ...CLAUDE_TEMPLATE }]);
    expect(engineList(merged).rows.map((r) => [r.label, r.source, r.configDir])).toEqual([
      ["A", "provider", null],
      ["B", "fallback", null],
    ]);
  });

  test("an untouched re-run of a multi-entry list is still the save path's `unchanged` no-op, byte for byte", () => {
    const spec = JSON.stringify(
      {
        provider: { ...CLAUDE_TEMPLATE, timeoutMs: 180000, accounts: [{ label: "Claude login 1" }, { label: "Claude login 2", configDir: "~/.claude-briefing" }] },
        fallbacks: [
          { label: "Local model", timeoutMs: 600000, api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1" } },
          { api: { kind: "anthropic", model: "claude-haiku-5", apiKey: REDACTED_API_KEY }, label: "Stored key" },
        ],
        networkProbeHosts: [],
      },
      null,
      2,
    );
    const plan = savePlan({ exists: true, text: spec, base: "tok" }, draftFromConfig(spec)!);
    expect((plan as { text: string }).text).toBe(spec);
  });

  test("a re-run with a stored literal keeps the placeholder exactly, at its pointer, and leaves the other entries byte for byte", () => {
    const existing = JSON.stringify(
      {
        provider: { label: "Key A", api: { kind: "anthropic", model: "old-model", maxTokens: 2048, apiKey: REDACTED_API_KEY } },
        fallbacks: [
          { label: "Local", api: { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1" } },
          { label: "Key C", api: { kind: "anthropic", model: "claude-haiku-5", apiKey: REDACTED_API_KEY } },
        ],
      },
      null,
      2,
    );
    const original = JSON.parse(existing) as Json;
    const merged = mergeConfig(existing, { ...draftFromConfig(existing)!, apiModel: "claude-sonnet-5" }) as Json;
    const provider = merged["provider"] as Json;
    const api = provider["api"] as Json;
    // The placeholder exactly — the string `config_save` restores the on-disk literal from, by pointer and label.
    expect(api["apiKey"]).toBe(REDACTED_API_KEY);
    expect(api).toEqual({ kind: "anthropic", model: "claude-sonnet-5", maxTokens: 2048, apiKey: REDACTED_API_KEY });
    expect(provider["label"]).toBe("Key A");
    expect(JSON.stringify(merged["fallbacks"])).toBe(JSON.stringify(original["fallbacks"]));
    expect((merged["fallbacks"] as Json[])[1]!["api"]).toEqual({ kind: "anthropic", model: "claude-haiku-5", apiKey: REDACTED_API_KEY });
    // The engine reads the same list, labels and positions unchanged.
    expect(engineList(merged).rows.map((r) => [r.label, r.source])).toEqual([
      ["Key A", "provider"],
      ["Local", "fallback"],
      ["Key C", "fallback"],
    ]);
    // And the untouched re-run of the same config writes nothing.
    expect(JSON.stringify(mergeConfig(existing, draftFromConfig(existing)!), null, 2)).toBe(existing);
  });

  test("REFUSED, not saved: a CLI → API change that would push a stored literal key to another pointer", () => {
    // The second login becomes fallbacks[0], so "Stored key"'s literal would move /fallbacks/0 → /fallbacks/1.
    // The settings guard restores a literal by pointer, so the writer blocks it — and the wizard must not
    // save around that block: it throws a refusal the save gate's catch shows (`describeFailure`).
    const existing = JSON.stringify({
      provider: { ...CLAUDE_TEMPLATE, accounts: [{ label: "L1" }, { label: "L2", configDir: "~/.c2" }] },
      fallbacks: [{ label: "Stored key", api: { kind: "anthropic", model: "claude-haiku-5", apiKey: REDACTED_API_KEY } }],
    });
    const draft: WizardDraft = { ...draftFromConfig(existing)!, providerPath: "api", apiModelConfirmed: true, apiKeyFile: "~/k" };
    const refusal = refusalOf(() => mergeConfig(existing, draft));
    expect(refusal.blocked).toEqual([
      { kind: "literal-moved", label: "Stored key", from: "/fallbacks/0/api/apiKey", to: "/fallbacks/1/api/apiKey" },
    ]);
    expect(refusal).toBeInstanceOf(Error);
    expect(refusal.message.startsWith("Not saved:")).toBe(true);
    expect(refusal.message).toContain("Nothing was changed");
    // The words name no label (user text) and never the placeholder.
    expect(refusal.message).not.toContain("Stored key");
    expect(refusal.message).not.toContain(REDACTED_API_KEY);
    // The save gate's path: `savePlan` throws the same refusal, and its words are what the wizard shows.
    const viaPlan = refusalOf(() => savePlan({ exists: true, text: existing, base: "tok" }, draft));
    expect(viaPlan.blocked).toEqual(refusal.blocked);
    expect(describeFailure(viaPlan)).toBe(viaPlan.message);
    // Contrast: with one login there is nothing to push down, so the same change saves, the literal unmoved.
    const single = JSON.stringify({
      provider: { ...CLAUDE_TEMPLATE },
      fallbacks: [{ label: "Stored key", api: { kind: "anthropic", model: "claude-haiku-5", apiKey: REDACTED_API_KEY } }],
    });
    const saved = mergeConfig(single, { ...draftFromConfig(single)!, providerPath: "api", apiModelConfirmed: true, apiKeyFile: "~/k" }) as Json;
    expect(((saved["fallbacks"] as Json[])[0]!["api"] as Json)["apiKey"]).toBe(REDACTED_API_KEY);
    expect((saved["fallbacks"] as Json[]).map((f) => f["label"])).toEqual(["Stored key"]);
  });

  // Checkpoint P3-M3 (HIGH): compaction KEEPS, it never PULLS IN (hub entry 2026-10-18). The two cases below used to
  // pull a same-settings fallback into `accounts` on an API → CLI change; now every `fallbacks` entry stays a block.
  test("an API → CLI change never pulls a fallback up, so a stored literal below it stays at its pointer (was: refused)", () => {
    const existing = JSON.stringify({
      provider: { label: "Key A", api: { kind: "anthropic", model: "m", apiKey: REDACTED_API_KEY } },
      fallbacks: [
        { label: "Claude 2", ...CLAUDE_TEMPLATE },
        { label: "Key C", api: { kind: "anthropic", model: "claude-haiku-5", apiKey: REDACTED_API_KEY } },
      ],
    });
    const original = JSON.parse(existing) as Json;
    const merged = mergeConfig(existing, { ...draftFromConfig(existing)!, providerPath: "cli", cli: "claude" }) as Json;
    // Item 1's own literal is dropped with its API block, which is allowed; the rest is byte for byte.
    expect(merged["provider"]).toEqual({ ...CLAUDE_TEMPLATE, label: "Key A" });
    expect(JSON.stringify(merged["fallbacks"])).toBe(JSON.stringify(original["fallbacks"]));
    // "Claude 2" has no configDir, so it is item 1's own login now: the walk drops that one duplicate, nothing else.
    const r = resolveProviderList(validateConfig(structuredClone(merged), ENGINE_HOME), ENGINE_HOME, {}, () => true);
    expect(r.entries.map((e) => e.label)).toEqual(["Key A", "Key C"]);
    expect(r.dropped.map((d) => [d.label, d.reason])).toEqual([["Claude 2", "duplicate-login"]]);
    expect(r.accountsBroken).toBe(false);
  });

  test("an API → CLI change leaves a same-settings fallback a `fallbacks` block (was: pulled into `accounts`)", () => {
    const existing = JSON.stringify({
      provider: { label: "Key A", api: { kind: "anthropic", model: "m", apiKeyEnv: "MY_KEY" } },
      fallbacks: [{ label: "Claude 2", configDir: "~/.claude-2", ...CLAUDE_TEMPLATE }],
    });
    const original = JSON.parse(existing) as Json;
    const merged = mergeConfig(existing, { ...draftFromConfig(existing)!, providerPath: "cli", cli: "claude" }) as Json;
    expect(merged["provider"]).toEqual({ ...CLAUDE_TEMPLATE, label: "Key A" });
    expect(JSON.stringify(merged["fallbacks"])).toBe(JSON.stringify(original["fallbacks"]));
    expect(engineList(merged).rows.map((r) => [r.label, r.source])).toEqual([
      ["Key A", "provider"],
      ["Claude 2", "fallback"],
    ]);
    expect(olderEngineLogins(merged)).toEqual([]);
  });

  test("the reviewer's reproduction: API → CLI over a template fallback with no configDir loses no login and relabels nothing", () => {
    // Before the fix: written `accounts: [Key A, X, Y]` — X and item 1 both on ~/.claude, so `resolveAccounts` refused
    // the list and the engine ran `default, Z` (Y lost, item 1 relabelled). Now nothing is pulled into `accounts`.
    const existing = JSON.stringify({
      provider: { label: "Key A", api: { kind: "anthropic", model: "m", apiKeyEnv: "MY_KEY" } },
      fallbacks: [
        { label: "X", ...CLAUDE_TEMPLATE },
        { label: "Y", ...CLAUDE_TEMPLATE, configDir: "~/.y" },
        { label: "Z", api: { kind: "anthropic", model: "z", apiKeyEnv: "Z_KEY" } },
      ],
    });
    const original = JSON.parse(existing) as Json;
    const merged = mergeConfig(existing, { ...draftFromConfig(existing)!, providerPath: "cli", cli: "claude" }) as Json;
    expect(merged["provider"]).toEqual({ ...CLAUDE_TEMPLATE, label: "Key A" });
    expect(JSON.stringify(merged["fallbacks"])).toBe(JSON.stringify(original["fallbacks"]));
    for (const env of [{}, { CLAUDE_CONFIG_DIR: "/exported-claude-config-dir" }]) {
      const r = resolveProviderList(validateConfig(structuredClone(merged), ENGINE_HOME), ENGINE_HOME, env, () => true);
      expect(r.accountsBroken).toBe(false);
      expect(r.entries[0]!.label).toBe("Key A");
      expect(r.entries.map((e) => [e.label, e.configDir ?? null]).filter(([l]) => l === "Y" || l === "Z")).toEqual([
        ["Y", `${ENGINE_HOME}/.y`],
        ["Z", null],
      ]);
    }
    // With no CLAUDE_CONFIG_DIR, X is item 1's own login: the walk drops that one duplicate and nothing else.
    const r = resolveProviderList(validateConfig(structuredClone(merged), ENGINE_HOME), ENGINE_HOME, {}, () => true);
    expect(r.dropped.map((d) => [d.label, d.reason])).toEqual([["X", "duplicate-login"]]);
  });

  test("LOW 7: an API → CLI change does NOT keep the `accounts` the engine ignored beside the API item 1 (they would go live)", () => {
    const existing = JSON.stringify({
      provider: { api: { kind: "anthropic", model: "m", apiKeyEnv: "MY_KEY" }, accounts: [{ label: "stale" }, { label: "stale 2", configDir: "~/.s2" }] },
    });
    // Before: an API item 1, `accounts` ignored (the engine's own reading).
    expect(resolveProviderList(validateConfig(JSON.parse(existing), ENGINE_HOME), ENGINE_HOME, {}, () => true).entries.map((e) => e.label)).toEqual(["default"]);
    const merged = mergeConfig(existing, { ...draftFromConfig(existing)!, providerPath: "cli", cli: "claude" }) as Json;
    expect(merged["provider"]).toEqual({ ...CLAUDE_TEMPLATE });
    expect("fallbacks" in merged).toBe(false);
    expect(engineList(merged).rows.map((r) => r.label)).toEqual(["default"]);
  });

  test("LOW 5: a stray `provider.fallbacks` on a provider change is the wizard's \"Not saved\" refusal, not an internal error", () => {
    const existing = JSON.stringify({ provider: { ...CLAUDE_TEMPLATE, fallbacks: [{ label: "inner" }] } }, null, 2);
    const draft: WizardDraft = { ...draftFromConfig(existing)!, providerPath: "api", apiModelConfirmed: true, apiKeyFile: "~/k" };
    const refusal = refusalOf(() => savePlan({ exists: true, text: existing, base: "tok" }, draft));
    expect(refusal.blocked).toEqual([{ kind: "nested-list", label: "default", field: "fallbacks" }]);
    expect(refusal.message.startsWith("Not saved:")).toBe(true);
    expect(refusal.message).toContain("Nothing was changed");
    expect(refusal.message).toContain('"fallbacks"');
    expect(describeFailure(refusal)).toBe(refusal.message);
    // Untouched, it is still the save path's no-op.
    expect(JSON.stringify(mergeConfig(existing, draftFromConfig(existing)!), null, 2)).toBe(existing);
  });

  test("a list the writer cannot read is refused on a provider change, and an untouched re-run still saves nothing new", () => {
    // `accounts` that is not a list: the engine reads it as broken (account failover disabled).
    const existing = JSON.stringify({ provider: { ...CLAUDE_TEMPLATE, accounts: "Claude login 1" } }, null, 2);
    const refusal = refusalOf(() =>
      mergeConfig(existing, { ...draftFromConfig(existing)!, providerPath: "api", apiModelConfirmed: true, apiKeyFile: "~/k" }),
    );
    expect(refusal.blocked).toEqual([{ kind: "unreadable", reason: "accounts-unreadable" }]);
    expect(refusal.message.startsWith("Not saved:")).toBe(true);
    // The provider unchanged: the list is never touched, so the old no-op holds.
    expect(JSON.stringify(mergeConfig(existing, draftFromConfig(existing)!), null, 2)).toBe(existing);
  });

  test("a create still writes a single provider with no list fields", () => {
    const created = buildConfig({ ...emptyDraft(), providerPath: "api", apiModelConfirmed: true, apiKeyFile: "~/k" });
    expect(created["provider"]).toEqual({ api: { kind: "anthropic", model: PREFILL_API_MODEL, apiKeyFile: "~/k" } });
    expect("fallbacks" in created).toBe(false);
  });

  test("the judge flag: savePlan says whether `provider` (and so the audit judge) changed", () => {
    const multi = JSON.stringify({ provider: { ...CLAUDE_TEMPLATE, accounts: [{ label: "L1" }, { label: "L2", configDir: "~/.l2" }] }, morningTime: "07:20" }, null, 2);
    const plan = (text: string, d: WizardDraft): { kind: string; judgeChanged?: boolean } => savePlan({ exists: true, text, base: "tok" }, d);
    // A provider change, including the compaction that moves L2 out of `accounts`.
    expect(plan(multi, { ...draftFromConfig(multi)!, providerPath: "api", apiModelConfirmed: true, apiKeyFile: "~/k" }).judgeChanged).toBe(true);
    expect(plan(multi, { ...draftFromConfig(multi)!, cli: "codex" }).judgeChanged).toBe(true);
    // Nothing of `provider` changed: an untouched re-run, and an edit elsewhere.
    expect(plan(multi, draftFromConfig(multi)!).judgeChanged).toBe(false);
    expect(plan(multi, { ...draftFromConfig(multi)!, floor: "08:00" }).judgeChanged).toBe(false);
    // A create has no judge to change.
    expect(savePlan({ exists: false, text: null, base: null }, emptyDraft())).not.toHaveProperty("judgeChanged");
  });

  test("the judge line is the spec's words, and the component shows it after a judge-changing save", () => {
    expect(JUDGE_LINE).toBe("The audit judge follows your first provider and its logins.");
    const component = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    const save = component.slice(component.indexOf("async function saveAndContinue"));
    // Reset before the write, set only from the plan's flag on a write that actually saved.
    expect(save.indexOf("judgeChanged = false;")).toBeGreaterThan(-1);
    expect(save.indexOf("judgeChanged = false;")).toBeLessThan(save.indexOf("const plan = savePlan(current, draft);"));
    expect(component).toContain('judgeChanged = plan.kind === "save" && plan.judgeChanged && outcome.kind === "saved";');
    // Shown beside the "saved" line on both steps that follow the save.
    expect(component.match(/\{#if judgeChanged\}\s*<p class="muted small">\{JUDGE_LINE\}<\/p>\s*\{\/if\}/g)).toHaveLength(2);
  });

  test("the component's save gate catches what savePlan throws and shows describeFailure's words", () => {
    const component = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    const save = component.slice(component.indexOf("async function saveAndContinue"));
    const tryAt = save.indexOf("try {");
    const planAt = save.indexOf("const plan = savePlan(current, draft);");
    const catchAt = save.indexOf("} catch (e) {");
    expect(tryAt).toBeGreaterThan(-1);
    expect(planAt).toBeGreaterThan(tryAt);
    expect(catchAt).toBeGreaterThan(planAt);
    const kindAt = save.indexOf("const kind", catchAt);
    expect(kindAt).toBeGreaterThan(catchAt);
    expect(save.slice(catchAt, kindAt)).toContain("saveFailure = describeFailure(e);");
  });
});

/* ── the rendered component ───────────────────────────────────────────────────────────────────── */

describe("the wizard renders", () => {
  test("step 1 says local-first, no telemetry, BYO AI — and that cancelling writes nothing", () => {
    const body = html();
    expect(body).toContain("Set up Daily Briefing");
    // Design 2026-10-31 D1: the numbers count the steps that show. At step 1 the access check has not run, so
    // macOS counts the access step (8) and Linux never does (7) — `wizard-steps.check.ts` has the full table.
    expect(body).toContain("Step 1 of 8 — what this is");
    expect(html({ os: "linux" })).toContain("Step 1 of 7 — what this is");
    expect(body).toContain("Local-first");
    expect(body).toContain("No telemetry");
    expect(body).toContain("Bring your own AI");
    expect(body).toContain("Cancelling now changes nothing");
    expect(body).toContain("Set up later");
  });
});

/* ── v0.2.1 §3.5: the wording follows the OS the webview reports ─────────────────────────────── */

describe("v0.2.1 §3.5: osFromUserAgent", () => {
  // Measured 2026-10-03 on this Mac: a plain WKWebView's `navigator.userAgent` (no Safari suffix).
  const WKWEBVIEW = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  // WebKitGTK's default shape, "(X11; <sysname> <machine>)" (not measured here; the VM re-check sees it).
  const WEBKITGTK = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";
  const WEBKITGTK_ARM = "Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/605.1.15 (KHTML, like Gecko)";
  const WEBVIEW2 =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36 Edg/129.0.0.0";

  test("WKWebView is macOS, WebKitGTK is Linux, WebView2 is Windows", () => {
    expect(osFromUserAgent(WKWEBVIEW)).toBe("macos");
    expect(osFromUserAgent(WEBKITGTK)).toBe("linux");
    expect(osFromUserAgent(WEBKITGTK_ARM)).toBe("linux");
    expect(osFromUserAgent(WEBVIEW2)).toBe("windows");
  });

  test("Android and ChromeOS say Linux too, and are not Linux; iOS and anything unknown are other", () => {
    const cases: [string, Os][] = [
      ["Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36", "other"],
      ["Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36", "other"],
      ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1", "other"],
      ["Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)", "other"],
      ["Bun/1.3.14", "other"],
      ["", "other"],
    ];
    for (const [ua, os] of cases) expect({ ua, os: osFromUserAgent(ua) }).toEqual({ ua, os });
  });
});

describe("v0.2.1 §3.5: the wizard's OS wording", () => {
  const MAC = /\bMac\b|macOS/;

  test("macOS keeps the pre-v0.2.1 text exactly", () => {
    expect(wizardOsWording("macos")).toEqual({
      machine: "this Mac",
      checkOnOpen: " (on macOS, also each time it opens)",
      folderAccessClause: "; the folder-access step asks macOS for permission only when you press its button",
      localModelStaysOn: "your Mac",
      homeScanAsks: " — macOS may ask about those the first time",
      protectedFoldersNote: true,
      awake: "your Mac",
    });
  });

  test("everywhere else, every row says \"this computer\" or nothing — never the Mac", () => {
    const linux = wizardOsWording("linux");
    expect(linux).toEqual({
      machine: "this computer",
      checkOnOpen: "",
      folderAccessClause: "",
      localModelStaysOn: "this computer",
      homeScanAsks: "",
      protectedFoldersNote: false,
      awake: "your computer",
    });
    for (const os of ["linux", "windows", "other"] as const) {
      const w = wizardOsWording(os);
      expect(w).toEqual(linux);
      for (const value of Object.values(w)) {
        if (typeof value === "string") expect({ os, value, mac: MAC.test(value) }).toEqual({ os, value, mac: false });
      }
    }
  });

  test("step 1 rendered: Linux names no Mac anywhere; macOS reads as before", () => {
    const flat = (body: string) => body.replace(/<!--[\s\S]*?-->/g, "").replace(/\s+/g, " ");
    const linux = flat(html({ os: "linux" }));
    expect(linux).not.toMatch(MAC);
    expect(linux).toContain("Everything runs on this computer. Your repositories are read here");
    expect(linux).toContain("whenever this app checks your setup (a connection that sends no data)");
    expect(linux).toContain("until you confirm at the last step. Cancelling now changes nothing.");
    const mac = flat(html({ os: "macos" }));
    expect(mac).toContain("Everything runs on this Mac. Your repositories are read here");
    expect(mac).toContain(
      "whenever this app checks your setup (on macOS, also each time it opens) (a connection that sends no data)",
    );
    expect(mac).toContain(
      "until you confirm at the last step; the folder-access step asks macOS for permission only when you press its button. Cancelling now changes nothing.",
    );
  });

  test("the template reads each row from wizardOsWording, inside the step it belongs to", () => {
    // Source-pinned: steps 2–6 are internal state a server render cannot reach (only step 1
    // renders), so this is what holds the template to the function the tests above execute.
    const wizard = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    expect(wizard).toContain("const wording = $derived(wizardOsWording(os));");
    expect(wizard).toMatch(/\n    os: Os;\n/); // required: no `?`
    expect(wizard).toMatch(/\n    os,\n/); // and no default in the destructuring
    const branch = (from: string, to: string) => wizard.slice(wizard.indexOf(from), wizard.indexOf(to));
    const welcome = branch('{#if step === "welcome"}', '{:else if step === "provider"}');
    const provider = branch('{:else if step === "provider"}', '{:else if step === "repos"}');
    const repos = branch('{:else if step === "repos"}', '{:else if step === "access"}');
    const floor = branch('{:else if step === "floor"}', "{:else}\n    <div class=\"body\">\n      {#if saved !== null}");
    for (const [where, slice, uses] of [
      ["welcome", welcome, ["Everything runs on {wording.machine}.", "checks your setup{wording.checkOnOpen} (a connection", "at the last step{wording.folderAccessClause}.\n          Cancelling now changes nothing."]],
      ["provider", provider, ["never leaves\n          {wording.localModelStaysOn}."]],
      ["repos", repos, ["Documents and Downloads{wording.homeScanAsks}. Untick this", "{#if wording.protectedFoldersNote}"]],
      ["floor", floor, ["while {wording.awake} is awake."]],
    ] as const) {
      expect(slice.length).toBeGreaterThan(0);
      for (const use of uses) expect({ where, use, found: slice.includes(use) }).toEqual({ where, use, found: true });
    }
    // The protected-folders note is INSIDE the gate, not after it.
    const gate = repos.slice(repos.indexOf("{#if wording.protectedFoldersNote}"));
    expect(gate.indexOf("These three are macOS-protected")).toBeLessThan(gate.indexOf("{/if}"));
    // App passes the webview's own answer.
    const app = readFileSync(new URL("../src/App.svelte", import.meta.url), "utf8");
    expect(app).toContain("const os = osFromUserAgent(navigator.userAgent);");
    // Design 2026-10-31 D3 (M3): the tag moved out of the route chain into the hidden wrapper, two spaces deeper.
    expect(app).toMatch(/\n      <Wizard\n        scheduleState=\{snapshot\?\.scheduleState \?\? null\}\n        \{os\}\n/);
  });
});

/* ── the login item: the last step's choice, applied on Finish (Phase E M5b) ──────────────────── */

describe("the login item is the wizard's LAST step — default ON, applied only on Finish", () => {
  const src = (rel: string) => readFileSync(new URL(`../src/${rel}`, import.meta.url), "utf8");
  const wizard = src("routes/Wizard.svelte");

  // Phase E M5b checkpoint fix: the first shape started the box ticked (`$state(true)`), let Finish
  // apply that before the default read answered, and turned a FAILED read into an OFF that Finish
  // then applied as an active removal. The rule now lives in lib/wizard.ts and is driven below
  // with a deferred and a failing read; these pins hold the component to it.
  test("the component wires the rule: the read sets only the default, the box only the choice, Finish waits on `wait`", () => {
    expect(wizard).toContain('let loginDefault = $state<LoginItemDefault>({ kind: "pending" });');
    expect(wizard).toContain("let loginChoice = $state<boolean | null>(null);");
    expect(wizard).toContain("const loginPlan = $derived(loginItemPlan(loginDefault, loginChoice));");
    expect(wizard.match(/autostartWizardDefault\(/g)).toHaveLength(1);
    // Final harden r1 (MED 3): the read moved into `readLoginItemDefault` (run on mount and on a show while the box is
    // untouched — wizard-resume.check.ts), and a reply lands only if no newer read started.
    expect(wizard).toContain("void settleLoginItemDefault(() => autostartWizardDefault(), describeFailure).then((settled) => {\n      if (mine === loginReads) loginDefault = settled;\n    });");
    expect(wizard).toContain("checked={loginItemChecked(loginDefault, loginChoice)}");
    expect(wizard).toContain("onchange={(e) => (loginChoice = e.currentTarget.checked)}");
    // Design 2026-10-31 §3 (M2): Finish's own wait moved into `wizardNav`'s `finish.disabled`, which still holds it while
    // `finishing`; the login-plan wait stays here.
    expect(wizard).toContain('<button disabled={nav.finish.disabled || loginPlan.kind === "wait"} onclick={() => void finish()}>');
    expect(wizardNav("delivery", { ...NAV_IDLE, finishing: true }).finish.disabled).toBe(true);
    expect(wizardNav("delivery", NAV_IDLE).finish.disabled).toBe(false);
    // No provisional value anywhere: nothing ticks the box but the answered default or the user. Design 2026-10-31
    // r6 §4 (M3): the one `$state(true)` is the step line's focus flag, `firstMount`, which the box never reads.
    expect(wizard.match(/\$state\(true\)/g)).toEqual(["$state(true)"]);
    expect(wizard).toContain("let firstMount = $state(true);");
    expect(between(wizard, "<h3>Start at login</h3>", "</section>")).not.toContain("firstMount");
  });

  test("Finish is the ONE place it is applied: the plan through autostartSetEnabled, then onfinished()", () => {
    expect(wizard.match(/autostartSetEnabled\(/g)).toHaveLength(1);
    const finish = wizard.slice(wizard.indexOf("async function finish()"));
    const body = finish.slice(0, finish.indexOf("\n  }\n"));
    expect(body).toContain("const plan = loginItemPlan(loginDefault, loginChoice);");
    expect(body).toContain("if (await finishLoginItem(plan, (enabled) => autostartSetEnabled(enabled))) onfinished();");
    expect(body.match(/onfinished\(\)/g)).toHaveLength(1);
    expect(wizard).toContain("onclick={() => void finish()}");
    // The old Finish that left without applying anything is gone.
    expect(wizard).not.toContain("onclick={() => onfinished()}");
    // Design 2026-10-31 D3 (M2): leaving WITHOUT applying is now deliberate, and only one way: `onfinished(` has
    // exactly two call sites — `finish()` and `finishLater()` — and `finishLater` touches no login item.
    const script = wizard.slice(0, wizard.indexOf("</script>"));
    expect(wizard.indexOf("</script>")).toBeGreaterThan(-1);
    expect(wizard.match(/\bonfinished\(/g)).toHaveLength(2);
    expect(script.match(/\bonfinished\(/g)).toHaveLength(2);
    const laterStart = wizard.indexOf("function finishLater(): void {");
    const laterEnd = wizard.indexOf("\n  }\n", laterStart);
    expect(laterStart).toBeGreaterThan(-1);
    expect(laterStart).toBeLessThan(laterEnd);
    const later = wizard.slice(laterStart, laterEnd);
    expect(later.match(/\bonfinished\(\);/g)).toHaveLength(1);
    expect(later).not.toContain("finishLoginItem");
    expect(later).not.toContain("autostartSetEnabled");
    expect(later).not.toContain("finish()");
    // …the other call site is Finish's, read above (`body`); and `finishLater` renders only on calendar and delivery.
    expect(wizard.match(/onclick=\{finishLater\}/g)).toHaveLength(1);
    expect(wizard).toContain('{#if nav.finishLater.shown}\n      <button class="quiet" disabled={nav.finishLater.disabled} onclick={finishLater}>Finish setup later</button>');
    expect(STEP_ORDER.filter((s) => wizardNav(s, NAV_IDLE).finishLater.shown)).toEqual(["calendar", "delivery"]);
    // The choice is rendered on the LAST step only: after the delivery branch opens.
    const delivery = wizard.indexOf("Install background delivery");
    expect(delivery).toBeGreaterThan(0);
    expect(wizard.indexOf("Start Daily Briefing at login.")).toBeGreaterThan(delivery);
  });

  test("nothing else in the webview turns the login item on — only the wizard's Finish and the Settings toggle", () => {
    // EVERY .svelte/.ts file under gui/src (checkpoint fix: the census was a hand-written list of
    // six files, so a call from a seventh stayed green), minus the definition in lib/notify.ts.
    const root = new URL("../src/", import.meta.url).pathname;
    const files = [...new Bun.Glob("**/*.{svelte,ts}").scanSync({ cwd: root })].sort();
    // prove-it 3b: the glob found the tree (both callers and the definition), not an empty dir.
    expect(files.length).toBeGreaterThan(20);
    expect(files).toContain("routes/Wizard.svelte");
    expect(files).toContain("lib/settings/AppGeneralControls.svelte");
    expect(files).toContain("lib/notify.ts");
    const calls: string[] = [];
    const mentions: string[] = [];
    for (const rel of files) {
      if (rel === "lib/notify.ts") continue;
      const text = src(rel);
      const n = (text.match(/autostartSetEnabled\(/g) ?? []).length;
      if (n > 0) calls.push(`${rel}:${n}`);
      // A by-value use (`apply(autostartSetEnabled)`) has no `(` — so any MENTION counts too.
      if (/\bautostartSetEnabled\b/.test(text)) mentions.push(rel);
    }
    expect(calls).toEqual(["lib/settings/AppGeneralControls.svelte:2", "routes/Wizard.svelte:1"]);
    expect(mentions).toEqual(["lib/settings/AppGeneralControls.svelte", "routes/Wizard.svelte"]);
    // …and the plugin's own enable is not invoked from anywhere (it is no longer granted).
    expect(src("lib/notify.ts")).not.toContain("plugin:autostart|enable");
  });
});

/* ── the login item's default: pending, answered, failed — driven (Phase E M5b checkpoint) ─────── */

describe("Finish never applies a provisional or unknown login-item state", () => {
  /** A promise the test settles by hand — the IPC read, before and after it answers. */
  function deferred<T>() {
    let resolve!: (v: T) => void;
    let reject!: (e: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  }
  /** The injected `autostartSetEnabled`: records every call, applies nothing. */
  function recorder() {
    const calls: boolean[] = [];
    return { calls, apply: async (enabled: boolean) => void calls.push(enabled) };
  }
  const describeError = (e: unknown) => (e instanceof Error ? e.message : String(e));

  test("PENDING and untouched: the box is not ticked, Finish waits and applies nothing; the answer then applies", async () => {
    const read = deferred<boolean>();
    let state: LoginItemDefault = { kind: "pending" };
    const settling = settleLoginItemDefault(() => read.promise, describeError).then((s) => {
      state = s;
    });
    await Promise.resolve();
    expect(state).toEqual({ kind: "pending" });
    expect(loginItemPlan(state, null)).toEqual({ kind: "wait" });
    expect(loginItemChecked(state, null)).toBe(false);
    expect(loginItemNote(state, null)).toContain("Checking whether");
    // The way out is named while Finish waits: a tick or an untick is applied whatever the read says.
    expect(loginItemNote(state, null)).toContain("Finish waits for the answer, or tick or untick the box to choose now.");
    const r = recorder();
    expect(await finishLoginItem(loginItemPlan(state, null), r.apply)).toBe(false);
    expect(r.calls).toEqual([]);

    read.resolve(true);
    await settling;
    expect(state).toEqual({ kind: "answered", on: true });
    expect(loginItemChecked(state, null)).toBe(true);
    expect(loginItemNote(state, null)).toBeNull();
    expect(await finishLoginItem(loginItemPlan(state, null), r.apply)).toBe(true);
    expect(r.calls).toEqual([true]);
  });

  test("an answered OFF (a removed login item, recorded) is applied as OFF — never re-ticked", async () => {
    const state = await settleLoginItemDefault(async () => false, describeError);
    expect(state).toEqual({ kind: "answered", on: false });
    expect(loginItemChecked(state, null)).toBe(false);
    const r = recorder();
    expect(await finishLoginItem(loginItemPlan(state, null), r.apply)).toBe(true);
    expect(r.calls).toEqual([false]);
  });

  test("FAILED and untouched: Finish leaves the login item exactly as it is, and the copy says why", async () => {
    const read = deferred<boolean>();
    const settling = settleLoginItemDefault(() => read.promise, describeError);
    read.reject(new Error("the autostart state is not managed by this app"));
    const state = await settling;
    expect(state).toEqual({ kind: "failed", detail: "the autostart state is not managed by this app" });
    expect(loginItemPlan(state, null)).toEqual({ kind: "leave" });
    expect(loginItemChecked(state, null)).toBe(false);
    const note = loginItemNote(state, null);
    expect(note).toContain("could not be read (the autostart state is not managed by this app)");
    expect(note).toContain("Finish leaves that setting as it is");
    // Worded ONCE (fix round 2): the command sends the bare cause (src-tauri `wizard_default`, pinned
    // there by `assert_eq!(err, "stat failed")`), and this note is its only wrapper.
    expect(note!.split("could not be read").length).toBe(2);
    expect(loginItemNote({ kind: "failed", detail: "stat failed" }, null)).toBe(
      "Whether Daily Briefing already starts at login could not be read (stat failed), so Finish " +
        "leaves that setting as it is. Tick or untick the box to choose.",
    );
    const r = recorder();
    // The wizard may leave — and NO call was made: an unknown state is never an active removal.
    expect(await finishLoginItem(loginItemPlan(state, null), r.apply)).toBe(true);
    expect(r.calls).toEqual([]);
  });

  test("a read that throws synchronously is a failure too, never an exception out of onMount", async () => {
    const state = await settleLoginItemDefault(() => {
      throw new Error("no IPC");
    }, describeError);
    expect(state).toEqual({ kind: "failed", detail: "no IPC" });
  });

  test("a TOUCHED box is applied as the user set it — before the read answers, after it fails, over its answer", async () => {
    const pending: LoginItemDefault = { kind: "pending" };
    const failed: LoginItemDefault = { kind: "failed", detail: "x" };
    const on: LoginItemDefault = { kind: "answered", on: true };
    for (const [state, choice] of [[pending, false], [pending, true], [failed, true], [failed, false], [on, false]] as const) {
      const r = recorder();
      expect(loginItemPlan(state, choice)).toEqual({ kind: "apply", enabled: choice });
      expect(loginItemChecked(state, choice)).toBe(choice);
      expect(loginItemNote(state, choice)).toBeNull();
      expect(await finishLoginItem(loginItemPlan(state, choice), r.apply)).toBe(true);
      expect(r.calls).toEqual([choice]);
    }
    // A late answer never overrides the choice: the choice is a separate fact the read never sets.
    const read = deferred<boolean>();
    const settling = settleLoginItemDefault(() => read.promise, describeError);
    read.resolve(true);
    expect(loginItemPlan(await settling, false)).toEqual({ kind: "apply", enabled: false });
  });

  test("a failed apply rejects, so the wizard stays on its last step with the reason", async () => {
    const plan = loginItemPlan({ kind: "answered", on: true }, null);
    await expect(
      finishLoginItem(plan, async () => {
        throw new Error("no launch agent dir");
      }),
    ).rejects.toThrow("no launch agent dir");
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
    const text = describeShimFailure(
      {
        kind: "needsManualStep",
        command: "sudo ln -sfn /target /usr/local/bin/daily-briefing",
        detail: "Permission denied (os error 13)",
      },
      "macos",
    );
    expect(text).toContain("sudo ln -sfn /target /usr/local/bin/daily-briefing");
    expect(text).toContain("in a terminal");
    expect(
      describeShimFailure({ kind: "foreign", path: "/usr/local/bin/daily-briefing", detail: "a regular file" }, "macos"),
    ).toContain("will not replace or remove");
  });

  test("the refusal names macOS only on macOS: v0.2.0's text there, \"The system\" anywhere else", () => {
    // `cli_shim.rs` supports every unix, so a Linux user reaches `needsManualStep` too.
    const refusal = { kind: "needsManualStep", command: "sudo ln -sfn /t /usr/local/bin/daily-briefing", detail: "Permission denied" };
    const tail = " did not let this app write there (Permission denied). Run this in a terminal instead:\nsudo ln -sfn /t /usr/local/bin/daily-briefing";
    expect(describeShimFailure(refusal, "macos")).toBe(`macOS${tail}`);
    const noMac = (t: string): boolean => !t.includes("Mac") && !t.includes("macOS");
    for (const os of ["linux", "windows", "other"] as const) {
      const text = describeShimFailure(refusal, os);
      expect({ os, text, noMac: noMac(text) }).toEqual({ os, text: `The system${tail}`, noMac: true });
    }
    expect(noMac(describeShimFailure(refusal, "macos"))).toBe(false);   // prove-it 3b: the check can fail
    // CliShimControl (split from AppSettings, redesign D), where the refusal is shown, passes its own required `os`
    // prop to both calls.
    const settings = readFileSync(new URL("../src/lib/settings/CliShimControl.svelte", import.meta.url), "utf8");
    expect(settings.match(/describeShimFailure\(e, os\)/g)).toHaveLength(2);
    expect(settings.match(/describeShimFailure\(/g)).toHaveLength(2);
  });
});

/* ── the last step's per-repo notes: doctor's partial-clone note (Phase E final harden) ────────── */

describe("the save gate's notes are keyed by position, not by text", () => {
  test("round 3 (D3-L3): saveWarnings and saveErrors key on the index — two notes can render alike", () => {
    // The engine redacts every note (`src/json.ts`, `redactNote`), so two DIFFERENT notes on one field
    // can arrive as the same text, and a duplicate each-key is a Svelte runtime error. Source-pinned:
    // both lists render only after a real save, which a server render cannot reach.
    const component = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    expect(component).toContain("{#each saveWarnings as warning, i (i)}");
    expect(component).toContain("{#each saveErrors as error, i (i)}");
    expect(component.match(/\{#each save(?:Warnings|Errors) as/g)).toHaveLength(2);
    expect(component).not.toMatch(/\(\s*(?:warning|error)\.field\s*\+\s*(?:warning|error)\.message\s*\)/);
  });
});

describe("the last step shows doctor's per-repo notes verbatim", () => {
  // A COPY of the engine's sentence, `PARTIAL_CLONE_NOTE` in `src/json.ts` — checked equal, byte for
  // byte, against the engine branch (`fix/dba-e-harden-engine`) on 2026-10-02. It is copied rather
  // than imported because this test was written on the GUI branch, whose `src/json.ts` did not
  // declare the constant yet. Nothing here depends on the copy staying equal: the helper never looks
  // at the wording — any string passes through untouched — so this is a fixture, not a pin.
  const NOTE =
    "partial clone: while the tool reads this repository's history, git itself may download missing " +
    "file contents from the repository's own remote, with your usual git credentials (the tool never fetches)";
  /** A `doctor --json` envelope from the NEW engine: one partial clone, one normal repo, one denied. */
  const WITH_PARTIAL = {
    schemaVersion: 1,
    repos: [
      { path: "/Users/x/code/big-monorepo", ok: true, issueKind: null, advice: null, partialClone: true, notes: [NOTE] },
      { path: "/Users/x/code/app", ok: true, issueKind: null, advice: null },
      { path: "/Users/x/Documents/proj", ok: false, issueKind: "tcc-denied", advice: "TCC-blocked: …" },
    ],
    discoveredCount: 2,
    verdict: "blocked",
  };
  /** The same envelope from an OLDER engine: no repo carries `partialClone` or `notes`. */
  const WITHOUT = {
    ...WITH_PARTIAL,
    repos: WITH_PARTIAL.repos.map(({ path, ok, issueKind, advice }) => ({ path, ok, issueKind, advice })),
  };

  test("a partial clone gets one row: its path and the engine's sentence, unmodified", () => {
    expect(doctorRepoNotes(WITH_PARTIAL.repos)).toEqual([{ path: "/Users/x/code/big-monorepo", note: NOTE }]);
  });

  test("an older engine's envelope (no partialClone, no notes) yields no row", () => {
    expect(WITHOUT.repos.some((r) => "notes" in r || "partialClone" in r)).toBe(false);
    expect(doctorRepoNotes(WITHOUT.repos)).toEqual([]);
    // …and an envelope with no `repos` at all, or a payload that is not an envelope.
    expect(doctorRepoNotes(undefined)).toEqual([]);
    expect(doctorRepoNotes(null)).toEqual([]);
    expect(doctorRepoNotes("repos")).toEqual([]);
  });

  test("rows not shaped as documented are skipped, never guessed at; several notes keep their order", () => {
    expect(
      doctorRepoNotes([
        null,
        "a string",
        { path: 7, notes: ["x"] },
        { path: "/p", notes: "not an array" },
        { path: "/q", notes: [3, "", "first", "second"] },
      ]),
    ).toEqual([
      { path: "/q", note: "first" },
      { path: "/q", note: "second" },
    ]);
  });

  test("the component renders each row as `{path}: {note}` text, from the doctor payload's repos", () => {
    // Source-pinned, like this file's other wiring checks: the row only exists after a real save and
    // doctor call, which a server render cannot reach.
    const component = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    expect(component.match(/doctorRepoNotes\(/g)).toHaveLength(1);
    expect(component).toContain("{#each doctorRepoNotes(payload?.repos) as row}");
    expect(component).toContain("{row.path}: {row.note}");
    expect(component).not.toMatch(/\{@html[^}]*row\./);
    // …inside the provider-check block that renders `doctor()`'s payload, not on another step.
    const block = component.slice(component.indexOf("<h3>Provider check</h3>"), component.indexOf("<h3>Background delivery</h3>"));
    expect(block).toContain("{#each doctorRepoNotes(payload?.repos) as row}");
  });
});

/* ── P3-M6-T3: first-time setup — paste your key (spec r9 §6 "First-time setup") ──────────────── */

/**
 * The API path defaults to PASTE: `key set` (the key on stdin, `providerKeySet`), then a Test of the wizard's own
 * candidate through the staging command (`providerCandidateCheck`, the row's `testTimeoutMs` via `testModeFor`). A key
 * file or command stays under "Advanced". A stored key the wizard ends up not using is deleted once — never one a
 * saved config references.
 *
 * ⚠ THE IPC IS A RECORDER, NOT TAURI (the `provider-flows.check.ts` pattern), and the validate rows are the engine's
 * own (`appKeyOwnership`, `listOrder`), applied to the exact text the flow sent.
 */
const PASTE_HOME = "/nonexistent-home-for-wizard-paste-check";
const PASTE_KEYS = `${PASTE_HOME}/state/keys`;
/** The pasted key. Key-rule characters only, and distinctive, so any copy of it anywhere is found. */
const PASTED = "pasted-KEY-5e1d7c3b9a20f468-wz";
const KID = "k-0a1b2c3d4e5f";
const KID2 = "k-f5e4d3c2b1a0";
const keyCmd = (id: string): string[] => [SECURITY_BIN, "find-generic-password", "-s", APP_KEY_SERVICE, "-a", id, "-w", `${PASTE_HOME}/Library/Keychains/login.keychain-db`];
type PJson = Record<string, unknown>;
type PCall = [string, PJson];
let pcalls: PCall[] = [];
let phandler: (command: string, args: PJson) => unknown = () => undefined;
const PCONSOLE = ["log", "info", "warn", "error", "debug", "trace"] as const;
let plogged: unknown[][] = [];

interface PScript {
  keySet?: unknown;
  /** The SAVED config on disk (`config_read`), `null` for none (a first run). Default: none. */
  saved?: string | null;
  test?: PJson | (() => unknown);
  report?: (r: PJson, text: string) => PJson;
  del?: unknown;
}
const pOutcome = (payload: unknown, operation: string) => ({
  operation, outcome: { kind: "delivered" }, exitCode: 0, payload, stdout: payload === null ? "" : JSON.stringify(payload), stderr: "",
});
const pBound = (index: number): number => 80_000 + 1_000 * index + 3;
function pEngineCheck(text: string): PJson {
  let cfg;
  try {
    cfg = validateConfig(JSON.parse(text), PASTE_HOME);
  } catch (e) {
    return { kind: "validated", report: { schemaVersion: 1, valid: false, errors: [{ field: "", message: (e as Error).message }], warnings: [], normalized: null, providers: [] } };
  }
  const list = resolveProviderList(cfg, PASTE_HOME, {}, () => true);
  const providers: PJson[] = [];
  if (!list.accountsBroken) {
    for (const [index, item] of listOrder(list).entries()) {
      if (!("entry" in item)) continue;
      const own = appKeyOwnership(item.entry, PASTE_KEYS);
      providers.push({
        index, testTimeoutMs: pBound(index), loopback: item.entry.isLoopback,
        keyOptional: item.entry.provider.api !== undefined && keyOptional(item.entry.provider.api), keyMoved: false,
        ...(own.owned ? { appOwnedKey: true, ...(own.id !== undefined ? { appKeyId: own.id } : {}) } : {}),
      });
    }
  }
  return { kind: "validated", report: { schemaVersion: 1, valid: true, errors: [], warnings: [], normalized: null, providers } };
}
const pTestAnswer = (over: PJson = {}): PJson => ({ schemaVersion: 1, ok: true, passed: true, at: "2026-10-18T07:00:00.000Z", recorded: true, ...over });
function pEngine(s: PScript = {}): (command: string, args: PJson) => unknown {
  return (command, args) => {
    switch (command) {
      case "engine_provider_key_set":
        return pOutcome(s.keySet ?? { schemaVersion: 1, ok: true, keyId: KID, apiKeyCommand: keyCmd(KID) }, "provider-key-set");
      case "engine_provider_key_delete":
        return pOutcome(s.del ?? { schemaVersion: 1, ok: true, deleted: true }, "provider-key-delete");
      case "config_read": {
        const text = s.saved ?? null;
        return { path: `${PASTE_HOME}/config.json`, exists: text !== null, text, base: text === null ? null : "b-1", parseError: null, apiKeyRedacted: false };
      }
      case "provider_candidate_check": {
        const text = args["text"] as string;
        if (args["mode"] === "validate") {
          const r = pEngineCheck(text);
          return s.report ? { ...r, report: s.report(r["report"] as PJson, text) } : r;
        }
        const answer = typeof s.test === "function" ? s.test() : (s.test ?? pTestAnswer());
        return { kind: "tested", answer, boundMs: (args["mode"] as { test: { testTimeoutMs: number } }).test.testTimeoutMs };
      }
      default:
        throw new Error(`unexpected command ${command}`);
    }
  };
}
const pCommands = (): string[] => pcalls.map(([c, a]) => (c === "provider_candidate_check" ? (a["mode"] === "validate" ? "validate" : "test") : c));
const pDeletes = (): unknown[] => pcalls.filter(([c]) => c === "engine_provider_key_delete").map(([, a]) => a["id"]);
const pTexts = (): string[] => pcalls.filter(([c]) => c === "provider_candidate_check").map(([, a]) => a["text"] as string);
/** Everything the key could have leaked into: every IPC argument except `key set`'s own, every console line, results. */
const pEverywhereBut = (...results: unknown[]): string =>
  [...pcalls.filter(([c]) => c !== "engine_provider_key_set").map(([, a]) => JSON.stringify(a)), JSON.stringify(plogged), JSON.stringify(results)].join("\n");
const apiDraft = (over: Partial<WizardDraft> = {}): WizardDraft => ({ ...emptyDraft(), providerPath: "api", apiModelConfirmed: true, ...over });
const passedKey = (over: Partial<PastedKey> = {}): PastedKey => ({ keyId: KID, ref: { apiKeyCommand: keyCmd(KID) }, test: "passed", useAnyway: false, ...over });
const NO_DOC = null;

describe("P3-M6-T3: the API path defaults to paste; a key file or command stays under Advanced", () => {
  test("the default is paste: no file or command field unblocks the step, a tested pasted key does", () => {
    const d = emptyDraft();
    expect([d.apiKeyAdvanced, d.pasted]).toEqual([false, null]);
    const api = apiDraft();
    expect(stepBlocker("provider", api)).toBe("Paste your API key, then press Store and test.");
    expect(stepBlocker("provider", { ...api, apiKeyFile: "/k", apiKeyCommand: "pass\nshow" })).toBe("Paste your API key, then press Store and test.");
    expect(stepBlocker("provider", { ...api, pasted: passedKey() })).toBeNull();
    expect(stepBlocker("provider", { ...api, pasted: passedKey({ test: "not-run" }) })).toBe("Test the key before you continue.");
    const failed = passedKey({ test: "failed" });
    expect(stepBlocker("provider", { ...api, pasted: failed })).toBe("The key did not pass its test: test it again, use it anyway, or discard it.");
    expect(stepBlocker("provider", { ...api, pasted: { ...failed, useAnyway: true } })).toBeNull();
    // "Use it anyway" rests on a Test that RAN (requirement 6): it never unblocks a key whose Test did not run.
    expect(stepBlocker("provider", { ...api, pasted: passedKey({ test: "not-run", useAnyway: true }) })).toBe("Test the key before you continue.");
    expect([pastedUsable(passedKey()), pastedUsable(failed), pastedUsable({ ...failed, useAnyway: true }), pastedUsable(passedKey({ test: "not-run", useAnyway: true }))]).toEqual([true, false, true, false]);
  });

  test("Advanced still offers a key file and a command, with the old rule", () => {
    const adv = apiDraft({ apiKeyAdvanced: true });
    expect(stepBlocker("provider", adv)).toBe("Point at your API key: a file that holds it, or a command that prints it.");
    expect(stepBlocker("provider", { ...adv, apiKeyFile: "/k" })).toBeNull();
    expect(stepBlocker("provider", { ...adv, apiKeyCommand: "pass\nshow" })).toBeNull();
    const api = providerValue({ ...adv, apiKeyFile: "/k", apiKeyCommand: "pass\nshow" }, undefined)["api"] as PJson;
    expect([api["apiKeyFile"], api["apiKeyCommand"]]).toEqual(["/k", ["pass", "show"]]);
    // A pasted key held while Advanced is chosen is NOT used: the typed reference is.
    const both = providerValue({ ...adv, apiKeyFile: "/k", pasted: passedKey() }, undefined)["api"] as PJson;
    expect(both).toEqual({ kind: "anthropic", model: PREFILL_API_MODEL, apiKeyFile: "/k" });
    expect(pastedInUse({ ...adv, pasted: passedKey() })).toBe(false);
  });

  test("the component: paste first, Advanced holds the file and the command, the old copy is gone", () => {
    const wizard = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    const provider = wizard.slice(wizard.indexOf('{:else if step === "provider"}'), wizard.indexOf('{:else if step === "repos"}'));
    // The paste/Advanced branch is the one at the api block's own indentation (inner blocks sit deeper).
    const paste = provider.indexOf("\n          {#if !draft.apiKeyAdvanced}\n");
    const adv = provider.indexOf("\n          {:else}\n", paste);
    const end = provider.indexOf("\n          {/if}\n", adv);
    expect([paste > 0, adv > paste, end > adv]).toEqual([true, true, true]);
    expect(provider.slice(paste, adv)).toContain('<input type="password" autocomplete="off" spellcheck="false" bind:value={pasteInput} />');
    expect(provider.slice(paste, adv)).toContain("{pasteKeyNote(os)}");
    expect(provider.slice(paste, adv)).not.toContain("draft.apiKeyFile");
    const advanced = provider.slice(adv, end);
    expect(advanced).toContain("value={draft.apiKeyFile}");
    expect(advanced).toContain("value={draft.apiKeyCommand}");
    expect(provider).toContain("Advanced: point at a key file or a command instead of pasting");
    expect(provider).toContain("checked={draft.apiKeyAdvanced}");
    // Rewritten, not kept: the screen now DOES take a pasted key.
    expect(wizard).not.toContain("never typed into this app");
    expect(wizard).not.toContain("NEVER ASKS FOR OR SETS A KEY VALUE");
    expect(readFileSync(new URL("../src/lib/wizard.ts", import.meta.url), "utf8")).not.toContain("NEVER ASKS FOR, SETS OR ECHOES");
    expect(pasteKeyNote("macos")).toContain("Keychain");
    expect(pasteKeyNote("linux")).not.toMatch(/\bMac\b|macOS|Keychain/);
  });

  test("a re-run of a config that names a key file or command opens on Advanced, and is still the unchanged no-op", () => {
    for (const api of [{ apiKeyFile: "~/k" }, { apiKeyCommand: ["pass", "show", "anthropic"] }]) {
      const text = JSON.stringify({ provider: { api: { kind: "anthropic", model: "m", ...api } } }, null, 2);
      const draft = draftFromConfig(text)!;
      expect(draft.apiKeyAdvanced).toBe(true);
      expect(stepBlocker("provider", draft)).toBeNull();
      expect(mergeConfig(text, draft)).toEqual(JSON.parse(text));
    }
    // A config with no file or command (the default env var, or a stored literal) opens on paste.
    for (const api of [{}, { apiKeyEnv: "MY_KEY" }, { apiKey: REDACTED_API_KEY }]) {
      const draft = draftFromConfig(JSON.stringify({ provider: { api: { kind: "anthropic", model: "m", ...api } } }))!;
      expect(draft.apiKeyAdvanced).toBe(false);
      expect(draft.pasted).toBeNull();
    }
  });

  test("a pasted key's reference is the entry's ONLY key source: every carried source goes, and none is typed", () => {
    const existing = {
      timeoutMs: 1234,
      api: { kind: "anthropic", model: "old", maxTokens: 900, apiKey: REDACTED_API_KEY, apiKeyEnv: "MY_KEY", apiKeyFile: "/old", apiKeyCommand: ["old"] },
    };
    const draft = { ...apiDraft(), apiKeyFile: "/typed", apiKeyCommand: "typed", pasted: passedKey() };
    const p = providerValue(draft, existing);
    expect(p["timeoutMs"]).toBe(1234);
    expect(p["api"]).toEqual({ maxTokens: 900, kind: "anthropic", model: PREFILL_API_MODEL, apiKeyCommand: keyCmd(KID) });
    const file = providerValue({ ...draft, pasted: passedKey({ ref: { apiKeyFile: `${PASTE_KEYS}/${KID}.key` } }) }, existing);
    expect(file["api"]).toEqual({ maxTokens: 900, kind: "anthropic", model: PREFILL_API_MODEL, apiKeyFile: `${PASTE_KEYS}/${KID}.key` });
    // A create carries the reference and no literal key at any spelling.
    const created = JSON.stringify(buildConfig(draft));
    expect(created).not.toContain('"apiKey"');
    expect(created).toContain(KID);
  });

  test("which pasted key leaving the step or the wizard releases (the component deletes it once)", () => {
    const api = apiDraft({ pasted: passedKey() });
    expect(pastedInUse(api)).toBe(true);
    expect(pastedToRelease(api, "continue")).toBeNull();
    expect(pastedToRelease(api, "back")).toBeNull();
    // Nothing was saved with it: leaving the wizard (Set up later, or the screen going away) releases it.
    expect(pastedToRelease(api, "leave")).toEqual(passedKey());
    // A Test that failed (or never ran), and the user goes Back: released.
    for (const test of ["failed", "not-run"] as const) expect(pastedToRelease(apiDraft({ pasted: passedKey({ test }) }), "back")?.keyId).toBe(KID);
    expect(pastedToRelease(apiDraft({ pasted: passedKey({ test: "failed", useAnyway: true }) }), "back")).toBeNull();
    // Not used by the draft any more (another path, or Advanced): released on Continue.
    for (const over of [{ providerPath: "cli" as const }, { providerPath: "local" as const }, { apiKeyAdvanced: true }]) {
      expect(pastedToRelease(apiDraft({ ...over, pasted: passedKey() }), "continue")?.keyId).toBe(KID);
    }
    expect(pastedToRelease(apiDraft(), "leave")).toBeNull();
  });

  test("the carried LOW: a local → CLI re-run drops the local path's timeout; a user's own timeout is kept", () => {
    const toCli = (provider: PJson) => {
      const existing = JSON.stringify({ provider });
      return (mergeConfig(existing, { ...draftFromConfig(existing)!, providerPath: "cli", cli: "claude" }) as PJson)["provider"] as PJson;
    };
    const local = { kind: "openai-compatible", model: "llama3", baseUrl: "http://127.0.0.1:11434/v1" };
    const raised = toCli({ timeoutMs: LOCAL_TIMEOUT_MS, api: local });
    expect(raised).not.toHaveProperty("timeoutMs");
    expect(raised["cli"]).toBe("claude");
    expect(toCli({ timeoutMs: 300000, api: local })["timeoutMs"]).toBe(300000);
    // Not from a local block: a CLI or Anthropic block's own timeout rides through, even at the local value.
    expect(toCli({ timeoutMs: LOCAL_TIMEOUT_MS, cli: "codex", argv: ["exec"] })["timeoutMs"]).toBe(LOCAL_TIMEOUT_MS);
    expect(toCli({ timeoutMs: LOCAL_TIMEOUT_MS, api: { kind: "anthropic", model: "m", apiKeyFile: "/k" } })["timeoutMs"]).toBe(LOCAL_TIMEOUT_MS);
  });
});

describe("P3-M6-T3: the paste flow — key set, then Test through the staging command", () => {
  beforeEach(() => {
    pcalls = [];
    phandler = pEngine();
    (globalThis as { window?: unknown }).window = {
      __TAURI_INTERNALS__: {
        invoke: (command: string, args: PJson) => {
          pcalls.push([command, structuredClone(args ?? {})]);
          try {
            return Promise.resolve(phandler(command, args ?? {}));
          } catch (e) {
            return Promise.reject(e);
          }
        },
      },
    };
    plogged = [];
    const c = console as unknown as Record<string, unknown>;
    for (const m of PCONSOLE) {
      (c as Record<string, unknown>)[`__before_${m}`] = c[m];
      c[m] = (...args: unknown[]) => void plogged.push(args);
    }
  });
  afterEach(() => {
    delete (globalThis as { window?: unknown }).window;
    const c = console as unknown as Record<string, unknown>;
    for (const m of PCONSOLE) c[m] = c[`__before_${m}`];
  });

  test("a pass: validate the keyless candidate, key set, validate, then Test item 1 with its own row's bound", async () => {
    const step = await pasteKey(NO_DOC, apiDraft(), PASTED, "macos");
    expect(step.pasted).toEqual(passedKey());
    expect(step.lines).toEqual(["The key was stored.", "Test passed."]);
    expect(pCommands()).toEqual(["validate", "engine_provider_key_set", "validate", "test"]);
    expect(pcalls[1]![1]).toEqual({ key: PASTED });
    // The Test is item 1's (`--index` 0), with that row's own `testTimeoutMs`, unchanged (`testModeFor`).
    expect(pcalls[3]![1]["mode"]).toEqual({ test: { index: 0, testTimeoutMs: pBound(0) } });
    // The tested candidate is the one the save would write: the reference, never the key.
    const tested = JSON.parse(pTexts()[2]!) as PJson;
    expect(((tested["provider"] as PJson)["api"] as PJson)["apiKeyCommand"]).toEqual(keyCmd(KID));
    expect(pTexts()[2]).toBe(pTexts()[1]);
    expect(pTexts()[0]).not.toContain(KID);
    expect(pTexts()[1]).toBe(savePlan({ exists: false, text: null, base: null }, { ...apiDraft(), pasted: passedKey({ test: "not-run" }) }).text);
  });

  test("a re-run tests the MERGED candidate over the saved config, and its other settings ride through", async () => {
    const saved = JSON.stringify({ provider: { api: { kind: "anthropic", model: "m", apiKeyEnv: "MY_KEY" } }, author: { names: ["kept"] } }, null, 2);
    const doc = { exists: true, text: saved, base: "b-1" };
    const step = await pasteKey(doc, draftFromConfig(saved)!, PASTED, "linux");
    expect(step.pasted?.test).toBe("passed");
    const tested = JSON.parse(pTexts()[2]!) as PJson;
    expect(tested["author"]).toEqual({ names: ["kept"] });
    expect((tested["provider"] as PJson)["api"]).toEqual({ kind: "anthropic", model: "m", apiKeyCommand: keyCmd(KID) });
  });

  test("a failed Test keeps the key for Test again, Use it anyway or Discard; Test again re-tests the same key", async () => {
    phandler = pEngine({ test: pTestAnswer({ passed: false, reason: "auth" }) });
    const step = await pasteKey(NO_DOC, apiDraft(), PASTED, "macos");
    expect(step.pasted).toEqual(passedKey({ test: "failed" }));
    expect(step.lines[0]).toBe("The key was stored.");
    expect(step.lines[1]).toMatch(/^Test failed: /);
    phandler = pEngine();
    pcalls = [];
    const again = await retestKey(NO_DOC, apiDraft({ pasted: step.pasted }));
    expect(again.pasted).toEqual(passedKey());
    expect(pCommands()).toEqual(["validate", "test"]);
    // A Test that did not run (a second Test is busy) is "not-run": it offers Test again, never Use it anyway.
    phandler = (c, a) => {
      if (c === "provider_candidate_check" && a["mode"] !== "validate") throw { kind: "busy", running: "provider-test" };
      return pEngine()(c, a);
    };
    const busy = await pasteKey(NO_DOC, apiDraft(), PASTED, "macos");
    expect(busy.pasted?.test).toBe("not-run");
  });

  test("a Test that did not RUN is \"not-run\" — busy, a briefing holding the lock, an engine refusal — never \"failed\", so Use it anyway is not offered", async () => {
    const lockHeld = { schemaVersion: 1, ok: false, code: "lock-held", error: "provider test: a briefing is running" };
    const refused = { schemaVersion: 1, ok: false, code: "config", error: "provider test: the entry's key is not one the engine accepts" };
    const cases: [string, PScript["test"]][] = [
      ["busy", () => { throw { kind: "busy", running: "provider-test" }; }],
      ["lock-held", lockHeld],
      ["refused", refused],
    ];
    for (const [name, test] of cases) {
      pcalls = [];
      phandler = pEngine({ test });
      const step = await pasteKey(NO_DOC, apiDraft(), PASTED, "macos");
      expect({ name, test: step.pasted?.test }).toEqual({ name, test: "not-run" });
      expect({ name, offered: useAnywayOffered(step.pasted!) }).toEqual({ name, offered: false });
      expect({ name, blocker: stepBlocker("provider", apiDraft({ pasted: step.pasted })) }).toEqual({ name, blocker: "Test the key before you continue." });
      // Test again, from a key whose earlier Test failed: the answer that did not run replaces it as "not-run".
      pcalls = [];
      const again = await retestKey(NO_DOC, apiDraft({ pasted: passedKey({ test: "failed" }) }));
      expect({ name, test: again.pasted?.test }).toEqual({ name, test: "not-run" });
      expect({ name, offered: useAnywayOffered(again.pasted!) }).toEqual({ name, offered: false });
      expect({ name, deletes: pDeletes() }).toEqual({ name, deletes: [] });
    }
    // Non-vacuous: a Test that RAN and failed is "failed", and does offer it.
    phandler = pEngine({ test: pTestAnswer({ passed: false, reason: "auth" }) });
    const failed = await retestKey(NO_DOC, apiDraft({ pasted: passedKey({ test: "not-run" }) }));
    expect(failed.pasted?.test).toBe("failed");
    expect(useAnywayOffered(failed.pasted!)).toBe(true);
  });

  test("refusals: an empty paste stores nothing; a key set refusal naming a keyId deletes that id; a refused candidate deletes the key", async () => {
    expect(await pasteKey(NO_DOC, apiDraft(), "   ", "macos")).toEqual({ pasted: null, lines: ["Paste your API key first."] });
    expect(pcalls).toEqual([]);
    phandler = pEngine({ keySet: { schemaVersion: 1, ok: false, code: "usage", error: "key set: invalid", reason: "invalid-key" } });
    const bad = await pasteKey(NO_DOC, apiDraft(), PASTED, "macos");
    expect(bad.pasted).toBeNull();
    expect(bad.lines[0]).toMatch(/does not look like an API key/);
    expect(pDeletes()).toEqual([]);
    // A platform that cannot keep a pasted key: the shared wording (`lib/unused-key.ts`), with the wizard's way out.
    pcalls = [];
    phandler = pEngine({ keySet: { schemaVersion: 1, ok: false, code: "write-failed", error: "key set: x", reason: "unsupported-platform" } });
    const win = await pasteKey(NO_DOC, apiDraft(), PASTED, "linux");
    expect(win).toEqual({ pasted: null, lines: ["Not stored: this computer cannot keep a pasted key. Choose Advanced and give a command that prints the key instead."] });
    pcalls = [];
    phandler = pEngine({ keySet: { schemaVersion: 1, ok: false, code: "write-failed", error: "key set: x", reason: "timeout", keyId: KID2 } });
    const slow = await pasteKey(NO_DOC, apiDraft(), PASTED, "linux");
    expect(slow.pasted).toBeNull();
    expect(pDeletes()).toEqual([KID2]);
    pcalls = [];
    // The engine refuses the candidate WITH the key (not without it): the stored key is removed again.
    phandler = pEngine({ report: (r, text) => (text.includes(SECURITY_BIN) ? { ...r, valid: false, errors: [{ field: "provider.api.baseUrl", message: "switch this baseUrl to https" }] } : r) });
    const refused = await pasteKey(NO_DOC, apiDraft(), PASTED, "macos");
    expect(refused.pasted).toBeNull();
    expect(refused.lines.join(" ")).toContain("switch this baseUrl to https");
    expect(pDeletes()).toEqual([KID]);
    pcalls = [];
    // Refused WITHOUT the key: nothing is stored at all.
    phandler = pEngine({ report: (r) => ({ ...r, valid: false, errors: [{ field: "repos", message: "bad" }] }) });
    expect((await pasteKey(NO_DOC, apiDraft(), PASTED, "macos")).pasted).toBeNull();
    expect(pCommands()).toEqual(["validate"]);
  });

  test("an unused key is deleted once it is clear no saved config references it — and kept when one does", async () => {
    // A first run: no config on disk, so nothing can reference it.
    expect(await releaseKey(passedKey(), "macos")).toEqual(["The key you pasted was removed."]);
    expect(pDeletes()).toEqual([KID]);
    // A saved config that references the id (the save landed after all): never deleted.
    pcalls = [];
    phandler = pEngine({ saved: JSON.stringify({ provider: { api: { kind: "anthropic", model: "m", apiKeyCommand: keyCmd(KID) } } }) });
    expect((await releaseKey(passedKey(), "macos"))[0]).toMatch(/^The key you pasted was kept/);
    expect(pDeletes()).toEqual([]);
    // A saved config whose rows cannot say which app key an entry reads: kept.
    pcalls = [];
    phandler = pEngine({
      saved: JSON.stringify({ provider: { api: { kind: "anthropic", model: "m", apiKeyEnv: "X" } } }),
      report: (r) => ({ ...r, providers: (r["providers"] as PJson[]).map((row) => ({ ...row, appOwnedKey: true })) }),
    });
    expect((await releaseKey(passedKey(), "macos"))[0]).toMatch(/^The key you pasted was kept/);
    expect(pDeletes()).toEqual([]);
    // A saved config whose rows do not cover every entry (T3c): kept — the entry with no row may read it.
    pcalls = [];
    phandler = pEngine({
      saved: JSON.stringify({ provider: { cli: "claude", argv: ["-p"], promptVia: "stdin" }, fallbacks: [{ label: "API", api: { kind: "anthropic", model: "m", apiKeyCommand: keyCmd(KID) } }] }),
      report: (r) => ({ ...r, providers: (r["providers"] as PJson[]).slice(0, 1) }),
    });
    expect((await releaseKey(passedKey(), "macos"))[0]).toMatch(/^The key you pasted was kept: not every provider/);
    expect(pDeletes()).toEqual([]);
    // A saved config that references ANOTHER key: this one is deleted.
    pcalls = [];
    phandler = pEngine({ saved: JSON.stringify({ provider: { api: { kind: "anthropic", model: "m", apiKeyCommand: keyCmd(KID2) } } }) });
    expect(await releaseKey(passedKey(), "macos")).toEqual(["The key you pasted was removed."]);
    expect(pDeletes()).toEqual([KID]);
    // The saved settings cannot be read: kept.
    pcalls = [];
    phandler = (c, a) => {
      if (c === "config_read") throw { kind: "engine", detail: "x" };
      return pEngine()(c, a);
    };
    expect((await releaseKey(passedKey(), "macos"))[0]).toMatch(/^The key you pasted was kept/);
    expect(pDeletes()).toEqual([]);
  });

  test("the pasted key never leaves providerKeySet: not in a config text, another IPC argument, a log, a result or module state", async () => {
    const results: unknown[] = [];
    const scripts: PScript[] = [
      {},
      { test: pTestAnswer({ passed: false, reason: "auth", recorded: false, notRecorded: "lock-held" }) },
      { keySet: { schemaVersion: 1, ok: false, code: "write-failed", error: "key set: x", reason: "timeout", keyId: KID2 } },
      { report: (r, text) => (text.includes(SECURITY_BIN) ? { ...r, valid: false, errors: [{ field: "x", message: "refused" }] } : r) },
    ];
    for (const s of scripts) {
      phandler = pEngine(s);
      const step = await pasteKey(NO_DOC, apiDraft(), PASTED, "macos");
      results.push(step);
      if (step.pasted !== null) {
        results.push(await retestKey(NO_DOC, apiDraft({ pasted: step.pasted })));
        results.push(await releaseKey(step.pasted, "macos"));
      }
    }
    phandler = (c, a) => {
      if (c === "engine_provider_key_set") throw new Error("ipc failed");
      return pEngine()(c, a);
    };
    results.push(await pasteKey(NO_DOC, apiDraft(), PASTED, "macos"));
    const sets = pcalls.filter(([c]) => c === "engine_provider_key_set");
    expect(sets.length).toBeGreaterThan(0);
    expect(sets.every(([, a]) => JSON.stringify(a) === JSON.stringify({ key: PASTED }))).toBe(true);
    const all = pEverywhereBut(...results);
    expect(all).not.toContain(PASTED);
    expect(all).not.toContain(PASTED.slice(4, -4));
    // Neither module keeps state of its own that could hold it.
    for (const mod of ["wizard-key.ts", "wizard.ts"]) {
      expect([mod, /^(let|var) /m.test(readFileSync(new URL(`../src/lib/${mod}`, import.meta.url), "utf8"))]).toEqual([mod, false]);
    }
    // lib/wizard.ts still performs no IPC: the key flow is lib/wizard-key.ts's, through lib/engine.ts's wrappers.
    const key = readFileSync(new URL("../src/lib/wizard-key.ts", import.meta.url), "utf8");
    // The unused-key rule it shares with Settings (checkpoint P3-M6) is lib/unused-key.ts's, through the same wrappers.
    const unused = readFileSync(new URL("../src/lib/unused-key.ts", import.meta.url), "utf8");
    for (const w of ["providerKeySet", "providerCandidateCheck", "testPlan"]) expect([w, key.includes(w)]).toEqual([w, true]);
    for (const w of ["providerKeyDelete", "providerCandidateCheck"]) expect([w, unused.includes(w)]).toEqual([w, true]);
    expect(/^(let|var) /m.test(unused)).toBe(false);
    for (const src of [key, unused]) expect(src).not.toContain("invoke(");
    expect(key).not.toMatch(/from "\.\/provider-flows"/);
    expect(unused).not.toMatch(/from "\.\/(provider-flows|wizard-key|wizard)"/);
  });

  test("the component hands the key over and clears the input in one step, and releases an unused key once", () => {
    const wizard = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    expect(wizard).toContain('let pasteInput = $state("");');
    expect(wizard).toContain('function submitPaste(): void { const pasted = pasteInput; pasteInput = ""; void runPaste(pasted); }');
    // The key is runPaste's argument, handed to pasteKey and dropped: never assigned to component state.
    const run = wizard.slice(wizard.indexOf("async function runPaste(key: string)"), wizard.indexOf("\n  }\n", wizard.indexOf("async function runPaste(key: string)")));
    expect(run).toContain("await pasteKey(doc, draft, key, os)");
    expect(run.match(/\bkey\b/g)).toHaveLength(2);
    // Release: through releaseOnLeave, which lets the draft go of the key BEFORE the release is awaited, so a second
    // trigger finds nothing (deleted once) — pinned with the save-in-flight wait in the checkpoint P3-M6 block below.
    expect(wizard).toContain('function releaseIfUnused(how: "continue" | "back" | "leave", from: () => WizardDraft = () => draft): void {');
    expect(wizard).toContain('onclick={() => { releaseIfUnused("leave"); oncancel(); }}>Set up later</button>');
    expect(wizard).toContain('if (step === "provider") releaseIfUnused("back");');
    expect(wizard).toContain('if (step === "provider") releaseIfUnused("continue");');
    // A paste still running when the wizard goes away releases its key when it ends.
    expect(run).toContain("if (destroyed) { if (r.pasted !== null) void releaseKey(r.pasted, os); return; }");
  });
});

describe("checkpoint P3-M6: leaving waits for the save in flight; a Test belongs to the model it ran on", () => {
  /** A save in flight: resolve it with whether it landed. */
  const deferred = () => {
    let settle!: (landed: boolean) => void;
    const promise = new Promise<boolean>((r) => (settle = r));
    return { promise, settle };
  };
  const recorder = () => {
    const released: string[] = [];
    return { released, release: async (p: PastedKey) => { released.push(p.keyId); return [`released ${p.keyId}`]; } };
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));

  test("leave (Set up later, or the wizard going away) during a save that LANDS keeps the key", async () => {
    const save = deferred();
    let saved = false;
    const draft = apiDraft({ pasted: passedKey() });
    const r = recorder();
    const out = releaseOnLeave({ inFlight: save.promise, landed: () => saved, how: "leave", draft: () => draft, release: r.release });
    await tick();
    // Nothing decided while the save runs: the key is neither released nor dropped from the draft.
    expect(r.released).toEqual([]);
    expect(draft.pasted).toEqual(passedKey());
    saved = true;
    save.settle(true);
    expect(await out).toBeNull();
    expect(r.released).toEqual([]);
    expect(draft.pasted).toEqual(passedKey());
  });

  test("the save lands but the component has not noted it yet: the promise's own answer decides", async () => {
    const save = deferred();
    const draft = apiDraft({ pasted: passedKey() });
    const r = recorder();
    const out = releaseOnLeave({ inFlight: save.promise, landed: () => false, how: "leave", draft: () => draft, release: r.release });
    save.settle(true);
    expect(await out).toBeNull();
    expect(r.released).toEqual([]);
  });

  test("leave during a save that FAILS releases the key once the save has ended — and only once", async () => {
    const save = deferred();
    const draft = apiDraft({ pasted: passedKey() });
    const r = recorder();
    const first = releaseOnLeave({ inFlight: save.promise, landed: () => false, how: "leave", draft: () => draft, release: r.release });
    const second = releaseOnLeave({ inFlight: save.promise, landed: () => false, how: "leave", draft: () => draft, release: r.release });
    await tick();
    expect(r.released).toEqual([]);
    save.settle(false);
    expect(await first).toEqual([`released ${KID}`]);
    expect(await second).toBeNull();
    expect(r.released).toEqual([KID]);
    expect(draft.pasted).toBeNull();
    // A save that rejected did not land either.
    const draft2 = apiDraft({ pasted: passedKey() });
    const r2 = recorder();
    expect(await releaseOnLeave({ inFlight: Promise.reject(new Error("ipc")), landed: () => false, how: "leave", draft: () => draft2, release: r2.release })).toEqual([`released ${KID}`]);
  });

  test("with no save in flight it decides at once, exactly as pastedToRelease says", () => {
    for (const [how, over, releases] of [
      ["leave", {}, true],
      ["continue", {}, false],
      ["back", {}, false],
      ["back", { pasted: passedKey({ test: "failed" }) }, true],
      ["continue", { providerPath: "cli" as const }, true],
    ] as const) {
      const draft = apiDraft({ pasted: passedKey(), ...over });
      const r = recorder();
      void releaseOnLeave({ inFlight: null, landed: () => false, how, draft: () => draft, release: r.release });
      // Synchronous: Continue / Back move the step on right after.
      expect({ how, over, released: r.released }).toEqual({ how, over, released: releases ? [KID] : [] });
      expect({ how, over, dropped: draft.pasted === null }).toEqual({ how, over, dropped: releases });
    }
    // An earlier save that landed: leaving releases only a key the saved draft does not use.
    const draft = apiDraft({ pasted: passedKey() });
    const r = recorder();
    void releaseOnLeave({ inFlight: null, landed: () => true, how: "leave", draft: () => draft, release: r.release });
    expect(r.released).toEqual([]);
  });

  test("the alreadyExists / conflict re-seed releases the key the dropped draft held, after the failed save ends", async () => {
    const before = apiDraft({ pasted: passedKey() });
    const reseeded = draftFromConfig(JSON.stringify({ provider: { cli: "claude" } }))!;
    expect(seedDrops(before, reseeded)).toBe(true);
    expect(seedDrops(apiDraft(), reseeded)).toBe(false);
    expect(seedDrops(before, { ...reseeded, pasted: passedKey() })).toBe(false);
    const save = deferred();
    const r = recorder();
    const out = releaseOnLeave({ inFlight: save.promise, landed: () => false, how: "leave", draft: () => before, release: r.release });
    save.settle(false);
    expect(await out).toEqual([`released ${KID}`]);
    expect(r.released).toEqual([KID]);
  });

  test("the component: Set up later and Back wait while saving; every release goes through releaseOnLeave", () => {
    const wizard = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    // Design 2026-10-31 §3 (M2): the `disabled={saving}` / `disabled={keyBusy || saving}` literals moved into `wizardNav`;
    // the buttons read it, and its rows keep both properties on every step before the save.
    expect(wizard).toContain('<button class="quiet" disabled={nav.setUpLater.disabled} onclick={() => { releaseIfUnused("leave"); oncancel(); }}>Set up later</button>');
    expect(wizard).toContain('<button class="quiet" disabled={nav.back.disabled} onclick={() => {');
    const preSave = STEP_ORDER.filter((s) => cancelWritesNothing(s));
    expect(preSave).toEqual(["welcome", "provider", "repos", "access", "updates", "floor"]);
    for (const step of preSave) {
      expect({ step, setUpLater: wizardNav(step, { ...NAV_IDLE, saving: true }).setUpLater }).toEqual({ step, setUpLater: { shown: true, disabled: true } });
      expect({ step, setUpLater: wizardNav(step, NAV_IDLE).setUpLater }).toEqual({ step, setUpLater: { shown: true, disabled: false } });
    }
    for (const step of preSave.filter((s) => s !== "welcome")) {
      expect({ step, back: wizardNav(step, { ...NAV_IDLE, saving: true }).back }).toEqual({ step, back: { shown: true, disabled: true } });
      expect({ step, back: wizardNav(step, { ...NAV_IDLE, keyBusy: true }).back }).toEqual({ step, back: { shown: true, disabled: true } });
      expect({ step, back: wizardNav(step, NAV_IDLE).back }).toEqual({ step, back: { shown: true, disabled: false } });
    }
    expect(wizard).toContain("onDestroy(() => { destroyed = true; releaseIfUnused(\"leave\"); });");
    expect(wizard).toContain(
      "void releaseOnLeave({ inFlight: saveInFlight, landed: () => saved !== null, how, draft: from, release: (p) => releaseKey(p, os) }).then((lines) => { if (lines !== null) keyLines = lines; });",
    );
    expect(wizard).toContain("const run = saveOnce(); saveInFlight = run;");
    // The re-seed: a draft replaced while it held a key releases that key, through the same decision.
    const seed = wizard.slice(wizard.indexOf("function seedFromDocument("), wizard.indexOf("onMount("));
    expect(seed).toContain('if (seedDrops(before, seeded)) releaseIfUnused("leave", () => before);');
  });

  test("a Test belongs to the model it ran on: editing the model resets it, and so does a Test that ends after an edit", () => {
    const draft = apiDraft({ pasted: passedKey() });
    setApiModel(draft, "claude-other");
    expect(draft.apiModel).toBe("claude-other");
    expect(draft.pasted).toEqual(passedKey({ test: "not-run" }));
    // A failed Test chosen anyway is reset too: the choice was about the other model.
    const chosen = apiDraft({ pasted: passedKey({ test: "failed", useAnyway: true }) });
    setApiModel(chosen, "claude-other");
    expect(chosen.pasted).toEqual(passedKey({ test: "not-run" }));
    // Spaces around the model are not a change (the save trims them), and no key is no change.
    const same = apiDraft({ apiModel: "m", pasted: passedKey() });
    setApiModel(same, "  m ");
    expect(same.pasted).toEqual(passedKey());
    const none = apiDraft();
    setApiModel(none, "x");
    expect(none.pasted).toBeNull();
    // A Test's answer for the model it ran on, the draft having moved on meanwhile.
    expect(pastedForModel(passedKey(), "m", "m")).toEqual(passedKey());
    expect(pastedForModel(passedKey(), "m", "n")).toEqual(passedKey({ test: "not-run" }));
    expect(pastedForModel(null, "m", "n")).toBeNull();
    // The component reads both.
    const wizard = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    expect(wizard).toContain("oninput={(e) => setApiModel(draft, e.currentTarget.value)} />");
    expect(wizard.match(/draft\.pasted = pastedForModel\(r\.pasted, model, draft\.apiModel\);/g)).toHaveLength(2);
    expect(wizard.match(/const model = draft\.apiModel;/g)).toHaveLength(2);
  });

  test("Use it anyway is offered only after a Test that RAN and failed", () => {
    expect(useAnywayOffered(passedKey({ test: "failed" }))).toBe(true);
    expect(useAnywayOffered(passedKey({ test: "failed", useAnyway: true }))).toBe(false);
    expect(useAnywayOffered(passedKey({ test: "not-run" }))).toBe(false);
    expect(useAnywayOffered(passedKey())).toBe(false);
    const wizard = readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
    expect(wizard).toContain("{#if useAnywayOffered(draft.pasted)}");
    expect(wizard).toContain("if (draft.pasted !== null && useAnywayOffered(draft.pasted)) draft.pasted = { ...draft.pasted, useAnyway: true };");
  });
});

/* ── PB-M7-T1: the calendar step asks (source pins: a server render starts at "welcome", so it cannot enter the step;
 *    its decisions are calendar-question.ts's pure helpers, tested in calendar-question.check.ts) ────────────── */

describe("PB-M7-T1: the wizard's calendar step — wiring (source pins only; Wizard.svelte:158 starts at welcome, never the step)", () => {
  const wizard = (): string => readFileSync(new URL("../src/routes/Wizard.svelte", import.meta.url), "utf8");
  // M3: both anchors asserted, and ordered (plan rule 0.2), so a missing anchor can never make the slice pass vacuously.
  const calendarStep = (w: string): string => between(w, '{:else if step === "calendar"}', "{:else}\n    <div class=\"body\">\n      {#if saved !== null}");
  const script = (w: string): string => w.slice(0, w.indexOf("</script>"));

  test("the calendar script sits after the existing destroy handler; the seed slice still ends at the first onMount; that handler is untouched", () => {
    const w = wizard();
    const s = script(w);
    const handler = s.indexOf('onDestroy(() => { destroyed = true; releaseIfUnused("leave"); });');
    expect(handler).toBeGreaterThan(-1);
    for (const added of ["let calendarStore = ", "let calendarEntry = ", "let calendarAnswer = ", "async function enterCalendarStep(", "function continueWithoutCalendar(", "$effect("]) {
      expect({ added, after: s.indexOf(added) > handler }).toEqual({ added, after: true });
    }
    // No earlier onMount: the first is still the seed/login-default mount (wizard.check.ts's seed slice ends there).
    expect(s.indexOf("onMount(")).toBeLessThan(handler);
    expect(s.slice(s.indexOf("onMount("), s.indexOf("onMount(") + 40)).toContain("void configRead()");
    expect(s.indexOf("onMount(", handler)).toBeGreaterThan(handler);
    // The store subscription's cleanup is its own onDestroy, never folded into the existing handler.
    expect(s).toContain("onDestroy(() => offCalendarStore?.());");
    expect(s.match(/onDestroy\(/g)).toHaveLength(2);
    // M3: three effects — the entry, the show on the step, the focus flag — the entry first (the slices above end there).
    // Final harden r1 (MED 1): the show detector is a `$effect.pre`, so two `$effect(` and one `$effect.pre(`, in order.
    expect(s.match(/\$effect\(/g)).toHaveLength(2);
    expect(s.match(/\$effect(\.\w+)?\(/g)).toEqual(["$effect(", "$effect.pre(", "$effect("]);
    expect(s.slice(s.indexOf("$effect("), s.indexOf("$effect(") + 60)).toContain("calendarEntryAction(");
  });

  test("the store: read at once, followed while mounted; the step's view is the pure helper over it", () => {
    const s = script(wizard());
    expect(s).toContain("let calendarStore = $state.raw(todayStore());");
    expect(s).toMatch(/onMount\(\(\) => \{\n\s*calendarStore = todayStore\(\);\n\s*offCalendarStore = onTodayStore\(\(s\) => \(calendarStore = s\)\);\n\s*\}\);/);
    // M3: and the pending entry (`entryWaiting`), so the first render after a show or a Back is the checking line.
    expect(s).toContain("const calendarView = $derived(wizardCalendarStep({ os, entry: calendarEntry, answer: calendarAnswer, running: calendarStore.flow.running, result: calendarStore.flow.result, entryWaiting: calendarEntryPending }));");
  });

  test("on entering the step: one status read through the store per entry (a dropped reply read once more), decided by wizardCalendarEntry", () => {
    const s = script(wizard());
    const enter = between(s, "async function enterCalendarStep(", "$effect(");
    expect(enter).toContain("const mine = ++calendarEntries;");
    expect(enter).toContain("calendarEntry = WIZARD_ENTRY_START;");
    expect(enter).toContain("calendarAnswer = null;");
    expect(enter).toContain("while (readAgain) {");
    expect(enter).toContain("const r = await readStatusThroughStore(() => calendarStatus());");
    expect(enter).toContain("if (mine !== calendarEntries || destroyed) return;");
    expect(enter).toContain("neverAsked: neverAsked(s), malformed: malformed(s), enabled: s.enabled === true");
    expect(enter).toContain("const decided = wizardCalendarEntry(calendarEntry, r.verdict, ");
    expect(enter).toContain("readAgain = decided.readAgain;");
    // Started by an entry falling due (M3: `calendarEntryPending`, set at three sites — wizard-resume.check.ts), once no
    // flow runs and no calendar write is in flight; on macOS or Linux only (Windows keeps the box, which reads nothing).
    expect(s).toMatch(/\$effect\(\(\) => \{\n\s*if \(calendarEntryAction\(\{ pending: calendarEntryPending, running: calendarStore\.flow\.running, writesInFlight: calendarStore\.writesInFlight \}\) !== "enter"\) return;\n\s*calendarEntryPending = false;\n\s*if \(os === "macos" \|\| os === "linux"\) untrack\(\(\) => void enterCalendarStep\(\)\);\n\s*\}\);/);
  });

  test("the markup: box (Windows), checking, a state line, the Not now line (focus target), or CalendarQuestion — then Continue without and the wizard-mode controls", () => {
    const step = calendarStep(wizard());
    expect(step).toContain("{#if calendarView.box}");
    // M3: two spaces deeper, inside `{#if shown}`.
    expect(step).toContain('{:else if calendarView.checking}\n          <p class="muted">{CHECKING_LINE}</p>');
    expect(step).toContain("{:else if calendarView.stateLine !== null}\n          <p>{calendarView.stateLine}</p>");
    // Not now has no result line: the step's own off line, focused on mount (tabindex -1 + focusHeading).
    expect(step).toContain('{:else if calendarView.notNowLine}\n          <p tabindex="-1" use:focusHeading>{WIZARD_NOT_NOW_LINE}</p>');
    // PB r1 X11: the answer carries the path Show my calendar took, so only a grant ("granted") shows the controls.
    // PB final LOW L3 (moved): the gate also waits for a running flow, so the link session's closing flow (no press of
    // the card's own) draws no question between the panel and the result.
    expect(step).toContain('<CalendarQuestion origin="wizard" {os} status={calendarStore.status} ask={calendarAnswer === null && calendarStore.flow.running === null} onanswered={(kind, path) => (calendarAnswer = wizardAnswer(kind, path))} />');
    expect(script(wizard())).toContain("let calendarAnswer = $state<WizardAnswer | null>(null);");
    expect(step).toMatch(/\{#if calendarView\.continueWithout\}\s*<div class="buttons">\s*<button type="button" disabled=\{calendarView\.continueWithoutDisabled\} onclick=\{continueWithoutCalendar\}>\{CONTINUE_WITHOUT_BUTTON\}<\/button>\s*<\/div>\s*\{\/if\}/);
    expect(step).toMatch(/\{#if calendarView\.controls\}\s*<CalendarSettings \{os\} mode="wizard" \/>\s*\{\/if\}/);
    // CalendarQuestion lives inside the step's branch: Continue, Continue without and a route change unmount it, and its
    // wizard-origin cleanup (leaveWizard) clears the result and any held write.
    expect(step.indexOf("<CalendarQuestion ")).toBeGreaterThan(step.indexOf("{:else if calendarView.notNowLine}"));
  });

  test("Continue waits while checking, while a flow runs, and until answered; Continue without drops the held write and advances", () => {
    const w = wizard();
    expect(w).toContain("const calendarHold = $derived(step === \"calendar\" && calendarView.continueBlocked);");
    expect(w).toContain("<button disabled={blocker !== null || keyBusy || calendarHold}");
    // The generic Continue's handler is unchanged.
    expect(w).toMatch(/onclick=\{\(\) => \{\n\s*if \(step === "provider"\) releaseIfUnused\("continue"\);\n\s*step = nextStep\(step, accessInScope\) \?\? step;\n\s*\}\}>\n\s*Continue/);
    const fn = between(w, "function continueWithoutCalendar(", "$effect(");
    expect(fn).toContain("leaveWizard();\n    step = nextStep(step, accessInScope) ?? step;");
  });

  test("unchanged: the configuration line and JUDGE_LINE head the step; Windows' words stay its own", () => {
    const step = calendarStep(wizard());
    expect(step.indexOf("{#if saved !== null}")).toBeLessThan(step.indexOf("{#if judgeChanged}"));
    expect(step.indexOf("{#if judgeChanged}")).toBeLessThan(step.indexOf("{#if calendarView.box}"));
    expect(step).toMatch(/\{#if judgeChanged\}\s*<p class="muted small">\{JUDGE_LINE\}<\/p>\s*\{\/if\}/);
  });
});
