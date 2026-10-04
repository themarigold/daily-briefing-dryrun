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
  loginItemChecked,
  loginItemNote,
  loginItemPlan,
  mergeConfig,
  settleLoginItemDefault,
  type LoginItemDefault,
  nextStep,
  previousStep,
  PREFILL_API_MODEL,
  providerValue,
  saveGateBlocker,
  savePlan,
  stepBlocker,
  STEP_ORDER,
  type WizardDraft,
  wizardOsWording,
} from "../src/lib/wizard";

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
    expect(STEP_ORDER).toEqual(["welcome", "provider", "repos", "access", "updates", "floor", "delivery"]);
    expect(nextStep("repos", true)).toBe("access");
    expect(nextStep("repos", false)).toBe("updates");
    expect(nextStep("access", true)).toBe("updates");
    expect(nextStep("updates", false)).toBe("floor");
    expect(nextStep("floor", false)).toBe("delivery");
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
    expect(body).toContain("Step 1 of 7");
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
    expect(app).toMatch(/<Wizard\n      scheduleState=\{snapshot\?\.scheduleState \?\? null\}\n      \{os\}\n/);
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
    expect(wizard).toContain("void settleLoginItemDefault(() => autostartWizardDefault(), describeFailure).then((settled) => {\n      loginDefault = settled;\n    });");
    expect(wizard).toContain("checked={loginItemChecked(loginDefault, loginChoice)}");
    expect(wizard).toContain("onchange={(e) => (loginChoice = e.currentTarget.checked)}");
    expect(wizard).toContain('<button disabled={finishing || loginPlan.kind === "wait"} onclick={() => void finish()}>');
    // No provisional value anywhere: nothing ticks the box but the answered default or the user.
    expect(wizard).not.toContain("$state(true)");
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
    expect(files).toContain("lib/AppSettings.svelte");
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
    expect(calls).toEqual(["lib/AppSettings.svelte:2", "routes/Wizard.svelte:1"]);
    expect(mentions).toEqual(["lib/AppSettings.svelte", "routes/Wizard.svelte"]);
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
    // AppSettings, where the refusal is shown, passes its own required `os` prop to both calls.
    const settings = readFileSync(new URL("../src/lib/AppSettings.svelte", import.meta.url), "utf8");
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
