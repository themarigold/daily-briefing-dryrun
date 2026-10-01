/**
 * B8 (T16) — the first-run wizard's rules, all pure so `tests-web/wizard.check.ts` can pin them.
 *
 * ⚠ THE CONFIG IS WRITTEN ONCE, AT THE END, THROUGH THE VALIDATED PATH — and this module is where
 * that is enforceable: nothing here performs IPC. `Wizard.svelte` calls exactly one of
 * `configCreate` / `configSave` (chosen by [`savePlan`]), exactly once, at the step-5 → step-6
 * gate; a cancel on any earlier step unmounts the component with the draft still in webview
 * memory and NOTHING written.
 *
 * ⚠ NO SECOND VALIDATOR. The engine's `config validate` is the semantic authority; what this file
 * checks per step is only "is there enough to build a candidate at all" (a non-empty model, a
 * well-shaped HH:MM), never the engine's rules re-implemented.
 *
 * ⚠ THE APP NEVER ASKS FOR, SETS OR ECHOES A KEY VALUE. `docs/gui-seam.md` :1186-1192:
 * `config_save` refuses to set a literal `provider.api.apiKey`, `init` has no `--api-key` flag,
 * and `apiKeyEnv` cannot resolve from the app or from launchd. The wizard therefore collects a
 * REFERENCE — an `apiKeyFile` path or an `apiKeyCommand` argv — and `config_create` refuses a
 * literal key outright, at ANY spelling or position (a recursive case-insensitive scan for a key
 * named `apiKey`; `apiKeyFile`/`apiKeyCommand` stay legal). Worded as "never sets", not "no key
 * value can exist here": a user CAN paste a key into the key-command textarea — nothing stops
 * pasted text — but the app never requests one, never stores one, and the engine never echoes
 * one. (The one exception on the KEEP side is a key an EXISTING config already stores: on a
 * re-run its placeholder is carried through, which is how the edit path keeps — never shows —
 * it.)
 */
import { REDACTED_API_KEY } from "./files";

/* ── the steps ────────────────────────────────────────────────────────────────────────────────── */

export type StepId = "welcome" | "provider" | "repos" | "access" | "floor" | "delivery";

/** Plan R1's six steps, in order. */
export const STEP_ORDER: StepId[] = ["welcome", "provider", "repos", "access", "floor", "delivery"];

/**
 * The next step after `current`. `accessInScope` is whether the folder-access step applies —
 * darwin AND a protected root reached by the draft (`access_snapshot`'s `supported` and `roots`);
 * when it does not, step 4 is skipped entirely (plan R1: the flow is CONDITIONAL). Step 6 is
 * UNCONDITIONAL (plan R1) and is the end.
 */
export function nextStep(current: StepId, accessInScope: boolean): StepId | null {
  const at = STEP_ORDER.indexOf(current);
  for (let i = at + 1; i < STEP_ORDER.length; i++) {
    const step = STEP_ORDER[i]!;
    if (step === "access" && !accessInScope) continue;
    return step;
  }
  return null;
}

/** The previous step, with the same skip rule. `null` from the first. */
export function previousStep(current: StepId, accessInScope: boolean): StepId | null {
  const at = STEP_ORDER.indexOf(current);
  for (let i = at - 1; i >= 0; i--) {
    const step = STEP_ORDER[i]!;
    if (step === "access" && !accessInScope) continue;
    return step;
  }
  return null;
}

/** Cancelling writes nothing exactly while the save has not happened — which is every step
 *  before `delivery` (the save is the gate INTO `delivery`). Pinned; the component renders
 *  "Set up later" only while this is true and "Finish" afterwards. */
export function cancelWritesNothing(current: StepId): boolean {
  return current !== "delivery";
}

/* ── the draft ────────────────────────────────────────────────────────────────────────────────── */

/** Which of R1's three provider paths is chosen. */
export type ProviderPath = "cli" | "api" | "local";

export interface WizardDraft {
  providerPath: ProviderPath;
  /** Path (a): which installed CLI. The engine's own `init` order: claude, then codex. */
  cli: "claude" | "codex";
  /** Path (b): the native Anthropic transport. */
  apiModel: string;
  /** The prefilled model must be EXPLICITLY confirmed (plan R1) — or edited, which is stronger. */
  apiModelConfirmed: boolean;
  /** A path to a file holding the key — the key BY REFERENCE, never by value. */
  apiKeyFile: string;
  /** An argv that prints the key, one argument per line. */
  apiKeyCommand: string;
  /** Path (c): a local endpoint. */
  localBaseUrl: string;
  localModel: string;
  /** Step 3: the four standard discovery roots, as checkboxes. Desktop/Documents/Downloads are
   *  DESELECTED BY DEFAULT (plan R1's grant-acquisition graft: protected folders enter scope only
   *  by an explicit choice, so no macOS prompt is ever unexplained). */
  rootHome: boolean;
  rootDesktop: boolean;
  rootDocuments: boolean;
  rootDownloads: boolean;
  /** Extra discovery roots, one per line (`~/dev`, `/Volumes/code`, …). */
  customRoots: string;
  /** Explicit repositories, one per line. Discovery is skipped by the ENGINE when these exist. */
  explicitRepos: string;
  /** `excludeRepos` entries, one per line — by absolute path or basename. */
  excludeRepos: string;
  /** Step 5: the morning FLOOR, HH:MM. Earliest, not exact ([`firstWakeSentence`]). */
  floor: string;
}

/** The engine's own defaults, mirrored — each pinned against `src/config.ts` /
 *  `src/schedule.ts` exports by `wizard.check.ts`, because this module cannot import engine
 *  source into a webview bundle (15 of 26 engine modules use Bun APIs). */
export const DEFAULT_FLOOR = "07:20";
export const DEFAULT_TOKEN_BUDGET = { maxChars: 200000 };
export const DEFAULT_LOOKBACK_CAP_DAYS = 4;
export const DEFAULT_NETWORK_PROBE_HOSTS = [
  { host: "1.1.1.1", port: 443 },
  { host: "8.8.8.8", port: 443 },
];
/** The model path (b) prefills — confirmed explicitly, never silently adopted (plan R1). */
export const PREFILL_API_MODEL = "claude-sonnet-5";
/** Path (c)'s raised provider timeout: a local model on modest hardware can take minutes where
 *  the default 120 s (`src/provider.ts`) assumes a hosted CLI. Ten minutes, written explicitly
 *  so it is discoverable and editable in Settings. */
export const LOCAL_TIMEOUT_MS = 600000;

export function emptyDraft(): WizardDraft {
  return {
    providerPath: "cli",
    cli: "claude",
    apiModel: PREFILL_API_MODEL,
    apiModelConfirmed: false,
    apiKeyFile: "",
    apiKeyCommand: "",
    localBaseUrl: "",
    localModel: "",
    rootHome: true,
    rootDesktop: false,
    rootDocuments: false,
    rootDownloads: false,
    customRoots: "",
    explicitRepos: "",
    excludeRepos: "",
    floor: DEFAULT_FLOOR,
  };
}

/** Non-empty trimmed lines of a textarea. */
export function lines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");
}

/** The tilde spellings the checkboxes stand for. The webview does not know the user's home
 *  directory; the engine expands a leading `~` at config load (`src/config.ts`, `expandTilde`)
 *  and Rust's scope rule expands the same way (`access::expand_tilde`). */
export const ROOT_HOME = "~";
export const ROOT_DESKTOP = "~/Desktop";
export const ROOT_DOCUMENTS = "~/Documents";
export const ROOT_DOWNLOADS = "~/Downloads";

/** The draft's discovery roots, checkboxes first, in a stable order. */
export function discoverRootsOf(draft: WizardDraft): string[] {
  const roots: string[] = [];
  if (draft.rootHome) roots.push(ROOT_HOME);
  if (draft.rootDesktop) roots.push(ROOT_DESKTOP);
  if (draft.rootDocuments) roots.push(ROOT_DOCUMENTS);
  if (draft.rootDownloads) roots.push(ROOT_DOWNLOADS);
  for (const root of lines(draft.customRoots)) {
    if (!roots.includes(root)) roots.push(root);
  }
  return roots;
}

/** What `access_snapshot`'s `draft` parameter gets: every path the draft would configure. */
export function draftPaths(draft: WizardDraft): string[] {
  const paths = [...lines(draft.explicitRepos), ...discoverRootsOf(draft)];
  return [...new Set(paths)];
}

/* ── per-step readiness (shape only — the engine validates semantics at the save) ─────────────── */

/** `HH:MM`, 00-23 / 00-59 — the shape `parseFloor` reads without a warning. */
export function floorValid(floor: string): boolean {
  return /^([01]\d|2[0-3]):[0-5]\d$/.test(floor);
}

/** Why the current step cannot advance yet, or `null` when it can. One line, for the button. */
export function stepBlocker(step: StepId, draft: WizardDraft): string | null {
  switch (step) {
    case "provider":
      if (draft.providerPath === "api") {
        if (draft.apiModel.trim() === "") return "Name the model to use.";
        if (!draft.apiModelConfirmed) return "Confirm the model choice — it is prefilled, not chosen for you.";
        if (draft.apiKeyFile.trim() === "" && lines(draft.apiKeyCommand).length === 0) {
          return "Point at your API key: a file that holds it, or a command that prints it.";
        }
      }
      if (draft.providerPath === "local") {
        if (draft.localBaseUrl.trim() === "") return "Name the endpoint URL (for Ollama: http://127.0.0.1:11434/v1).";
        if (draft.localModel.trim() === "") return "Name the model to use.";
      }
      return null;
    case "repos":
      if (draftPaths(draft).length === 0) {
        return "Choose at least one folder to look in, or list a repository.";
      }
      return null;
    case "floor":
      return floorValid(draft.floor) ? null : "The earliest time must be HH:MM, e.g. 07:20.";
    default:
      return null;
  }
}

/* ── the first-wake sentence ──────────────────────────────────────────────────────────────────── */

/**
 * The canonical floor wording — `schedule_state::first_wake_sentence`, mirrored word for word
 * (`wizard.check.ts` reads the Rust source and refuses drift). Before the save there is no
 * `ScheduleState` to carry it, so the wizard formats it for the floor being chosen.
 */
export function firstWakeSentence(floor: string): string {
  return `Your briefing is generated on the first check after ${floor} once your machine is awake — not at ${floor}.`;
}

/* ── the candidate config ─────────────────────────────────────────────────────────────────────── */

type Json = Record<string, unknown>;

/** The wizard's provider block for `existing`'s provider (or none).
 *
 *  DO-NOT-CLOBBER is the organising rule (R1 delta-verify H), in three layers:
 *  - a CLI provider the user KEPT (`existing.cli === draft.cli`, no `api` block) is returned
 *    byte-for-byte — a customised `argv` (`["-p","--model","sonnet"]`), `harden: false`, a
 *    `credential` choice, `accounts`, all survive a wizard re-run untouched;
 *  - a provider that CHANGED rebuilds only the keys the wizard owns; every provider key it does
 *    not own (`timeoutMs`, `accounts`, unknown fields) rides through, and inside an `api` block
 *    the unowned keys (`baseUrl` on the anthropic path, `maxTokens`, `apiKeyEnv`, …) ride
 *    through the same way;
 *  - a stored literal key's PLACEHOLDER is carried on the api path, so a re-run never silently
 *    drops a key the config already holds (the edit path restores it; a create has no
 *    `existing` and `config_create` refuses any literal key).
 */
export function providerValue(draft: WizardDraft, existing: Json | undefined): Json {
  const owned = new Set(["cli", "argv", "promptVia", "api", "harden", "credential"]);
  const kept: Json = {};
  if (existing !== undefined) {
    for (const [k, v] of Object.entries(existing)) {
      if (!owned.has(k)) kept[k] = v;
    }
  }
  const existingApi = existing?.["api"] as Json | undefined;
  /** The existing api block minus the keys the chosen path owns — what rides through. */
  const keptApi = (ownedApi: string[]): Json => {
    const out: Json = {};
    if (existingApi !== undefined) {
      for (const [k, v] of Object.entries(existingApi)) {
        if (!ownedApi.includes(k)) out[k] = v;
      }
    }
    return out;
  };
  switch (draft.providerPath) {
    case "cli":
      if (existing !== undefined && existing["cli"] === draft.cli && existingApi === undefined) {
        // The user kept the provider they had: nothing about it is rewritten.
        return { ...existing };
      }
      // The engine's own template for this CLI (`src/config.ts`, `initConfig`): claude prompts
      // via `-p`, codex via `exec`; `harden`/`credential` written at their defaults so the
      // opt-outs are discoverable.
      return {
        ...kept,
        cli: draft.cli,
        argv: draft.cli === "codex" ? ["exec"] : ["-p"],
        promptVia: "stdin",
        harden: true,
        credential: "subscription",
      };
    case "api": {
      const command = lines(draft.apiKeyCommand);
      const storedKey = (existingApi?.["apiKey"] as unknown) === REDACTED_API_KEY;
      return {
        ...kept,
        api: {
          ...keptApi(["kind", "model", "apiKeyFile", "apiKeyCommand", "apiKey"]),
          kind: "anthropic",
          model: draft.apiModel.trim(),
          ...(draft.apiKeyFile.trim() !== "" ? { apiKeyFile: draft.apiKeyFile.trim() } : {}),
          ...(command.length > 0 ? { apiKeyCommand: command } : {}),
          ...(storedKey ? { apiKey: REDACTED_API_KEY } : {}),
        },
      };
    }
    case "local":
      return {
        ...kept,
        // Raised, but never over a value the user already set (do-not-clobber on a re-run).
        timeoutMs: typeof kept["timeoutMs"] === "number" ? kept["timeoutMs"] : LOCAL_TIMEOUT_MS,
        api: {
          ...keptApi(["kind", "model", "baseUrl"]),
          kind: "openai-compatible",
          model: draft.localModel.trim(),
          baseUrl: draft.localBaseUrl.trim(),
        },
      };
  }
}

/** Set `key` on `target`, or delete it when `value` is undefined — the merge's one primitive. */
function setOrDelete(target: Json, key: string, value: unknown): void {
  if (value === undefined) {
    delete target[key];
  } else {
    target[key] = value;
  }
}

/** JSON value equality, key order ignored (numbers are already canonical after `JSON.parse`). */
function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((v, i) => jsonEqual(v, b[i]));
  }
  if (
    typeof a === "object" && a !== null && !Array.isArray(a) &&
    typeof b === "object" && b !== null && !Array.isArray(b)
  ) {
    const ka = Object.keys(a as Json);
    return (
      ka.length === Object.keys(b as Json).length &&
      ka.every((k) => k in (b as Json) && jsonEqual((a as Json)[k], (b as Json)[k]))
    );
  }
  return false;
}

/** The wizard-owned top-level keys, applied to `target` in place. Everything else — every
 *  unknown field, `notify`, `author`, `subprojects`, `auditJudgeArgv`, whatever the engine grows
 *  next — is untouched, which is the round-trip preservation pin. */
function applyDraft(target: Json, draft: WizardDraft): Json {
  // A list whose MEMBERS did not change keeps the existing array — order included. The draft's
  // checkbox model rebuilds `discoverRoots` in its own order, and an untouched re-run must be
  // the save path's `unchanged` no-op, not a cosmetic reordering write. MULTISET members since
  // round 1: `["a","a","b"]` vs `["a","b","b"]` share a set but differ, and judging them "same"
  // silently kept the old duplicates (degenerate configs, but a real difference).
  const sorted = (xs: string[]): string[] => [...xs].sort();
  const keepOrSet = (key: string, next: string[]): void => {
    const existing = target[key];
    const same =
      Array.isArray(existing) &&
      existing.length === next.length &&
      existing.every((v) => typeof v === "string") &&
      sorted(existing as string[]).every((v, i) => v === sorted(next)[i]);
    if (same) return;
    setOrDelete(target, key, next.length > 0 ? next : undefined);
  };
  keepOrSet("repos", lines(draft.explicitRepos));
  keepOrSet("discoverRoots", discoverRootsOf(draft));
  keepOrSet("excludeRepos", lines(draft.excludeRepos));
  // The provider gets the same no-op discipline (round 1): `providerValue` REBUILDS the api and
  // local shapes, which preserves every value but can reorder keys — and a reordered candidate
  // is a WRITE to the byte-level `unchanged` check. A rebuild that changed no value keeps the
  // existing object, order included.
  const existingProvider = target["provider"] as Json | undefined;
  const rebuilt = providerValue(draft, existingProvider);
  target["provider"] =
    existingProvider !== undefined && jsonEqual(rebuilt, existingProvider)
      ? existingProvider
      : rebuilt;
  // The default floor stays IMPLICIT where it already was: a config with no `morningTime` whose
  // user keeps 07:20 is left without one, so an otherwise-untouched re-run is the save path's
  // `unchanged` no-op rather than a write that adds a redundant key.
  if (target["morningTime"] !== undefined || draft.floor !== DEFAULT_FLOOR) {
    target["morningTime"] = draft.floor;
  }
  if (draft.providerPath === "local" && target["networkProbeHosts"] === undefined) {
    // The network gate probes public anycast hosts before calling the provider; a LOCAL endpoint
    // needs no internet, so the gate is disabled explicitly — `[]` is the engine's documented
    // switch (`src/config.ts`, the template's own comment). PREFILLED, not forced (round 1):
    // only where the key is absent — an existing value, `[]` or a host list the user chose, is
    // theirs, and an untouched path-(c) re-run must stay the save path's `unchanged` no-op.
    target["networkProbeHosts"] = [];
  }
  // Path (b) writes NO networkProbeHosts: absent, the run derives probe hosts from the API
  // endpoint itself (`src/config.ts` initConfig's note: the derivation fires only when the key
  // is absent) — and an existing value is preserved. Path (a)'s default pair is a CREATE
  // template default only (`buildConfig`): on a merge, presence or absence is the user's.
  return target;
}

/** The CREATE candidate — `initConfig`'s template shape, from the draft alone. */
export function buildConfig(draft: WizardDraft): Json {
  const out: Json = applyDraft({}, draft);
  // The template's discoverability defaults, exactly as the engine's `initConfig` writes them —
  // including the explicit probe-host pair on the CLI path (its comment in the engine: written
  // so the switch is discoverable and editable).
  if (draft.providerPath === "cli") {
    out["networkProbeHosts"] = DEFAULT_NETWORK_PROBE_HOSTS;
  }
  out["tokenBudget"] = DEFAULT_TOKEN_BUDGET;
  out["lookbackCapDays"] = DEFAULT_LOOKBACK_CAP_DAYS;
  return out;
}

/** The MERGE candidate — the draft applied onto the loaded document's parsed text, in place, so
 *  key order and every field the wizard does not own survive byte-for-byte through the save's
 *  canonical re-serialisation. */
export function mergeConfig(existingText: string, draft: WizardDraft): Json {
  const parsed: unknown = JSON.parse(existingText);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("the existing config is not a JSON object");
  }
  return applyDraft(parsed as Json, draft);
}

/** Which write the save gate performs. ONE write, exactly once, at the gate into step 6:
 *  a document that exists is EDITED (base-token guarded, unknown fields preserved); no document
 *  means CREATE (exclusive — a file that appeared meanwhile is refused, never replaced). */
export type SavePlan =
  | { kind: "create"; text: string }
  | { kind: "save"; text: string; base: string };

export function savePlan(
  doc: { exists: boolean; text: string | null; base: string | null },
  draft: WizardDraft,
): SavePlan {
  if (doc.exists && doc.text !== null && doc.base !== null) {
    return {
      kind: "save",
      text: JSON.stringify(mergeConfig(doc.text, draft), null, 2),
      base: doc.base,
    };
  }
  return { kind: "create", text: JSON.stringify(buildConfig(draft), null, 2) };
}

/* ── pre-population (the re-run path) ─────────────────────────────────────────────────────────── */

const asStrings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

/** A draft pre-populated from an existing config's text (do-not-clobber: what the wizard shows
 *  is what the file says, and finishing without changes saves nothing — `config_save`'s no-op).
 *
 *  ⚠ `null` MEANS "BLOCK THE SAVE GATE", NEVER "USE THE EMPTY DRAFT" (round 1). This used to
 *  fall back to the empty draft on unreadable text — and a field-read throw
 *  (`{"provider":{"api":null}}`, measured) escaped even that, leaving an empty draft with the
 *  save enabled: the next save merged NOTHING over a real config. A text this function cannot
 *  read into fields now answers `null`, and the component keeps the gate shut
 *  ([`saveGateBlocker`]). */
export function draftFromConfig(text: string): WizardDraft | null {
  const draft = emptyDraft();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  try {
    const isObj = (v: unknown): v is Json =>
      typeof v === "object" && v !== null && !Array.isArray(v);
    const c = parsed as Json;
    // `provider` / `provider.api` must be objects or absent: `null`, an array or a scalar there
    // (`{"provider":{"api":null}}` is the measured shape) is a config the wizard cannot honestly
    // mirror into its fields, so the gate must stay shut rather than a guessed draft opening it.
    if (c["provider"] !== undefined && !isObj(c["provider"])) return null;
    const provider = (c["provider"] ?? {}) as Json;
    if (provider["api"] !== undefined && !isObj(provider["api"])) return null;
    const api = provider["api"] as Json | undefined;
    if (api !== undefined) {
      if (api["kind"] === "openai-compatible") {
        draft.providerPath = "local";
        draft.localModel = typeof api["model"] === "string" ? api["model"] : "";
        draft.localBaseUrl = typeof api["baseUrl"] === "string" ? api["baseUrl"] : "";
      } else {
        draft.providerPath = "api";
        draft.apiModel = typeof api["model"] === "string" ? api["model"] : PREFILL_API_MODEL;
        draft.apiModelConfirmed = true; // the config already carries the user's own choice
        draft.apiKeyFile = typeof api["apiKeyFile"] === "string" ? api["apiKeyFile"] : "";
        draft.apiKeyCommand = asStrings(api["apiKeyCommand"]).join("\n");
      }
    } else {
      draft.providerPath = "cli";
      draft.cli = provider["cli"] === "codex" ? "codex" : "claude";
    }
    const roots = asStrings(c["discoverRoots"]);
    draft.rootHome = roots.includes(ROOT_HOME);
    draft.rootDesktop = roots.includes(ROOT_DESKTOP);
    draft.rootDocuments = roots.includes(ROOT_DOCUMENTS);
    draft.rootDownloads = roots.includes(ROOT_DOWNLOADS);
    draft.customRoots = roots
      .filter((r) => ![ROOT_HOME, ROOT_DESKTOP, ROOT_DOCUMENTS, ROOT_DOWNLOADS].includes(r))
      .join("\n");
    draft.explicitRepos = asStrings(c["repos"]).join("\n");
    draft.excludeRepos = asStrings(c["excludeRepos"]).join("\n");
    draft.floor = typeof c["morningTime"] === "string" ? c["morningTime"] : DEFAULT_FLOOR;
    return draft;
  } catch {
    // A shape the reads above cannot walk. The caller must block, not merge an empty draft.
    return null;
  }
}

/* ── the save gate's extra blockers (the recovery path) ───────────────────────────────────────── */

export interface SaveGateState {
  /** An existing config's text could not be read into the wizard's fields ([`draftFromConfig`]
   *  answered `null`, or the on-disk file is not JSON at all). */
  seedFailed: boolean;
  /** The draft was RE-SEEDED after an `alreadyExists`/`conflict` refusal — the recovery path. */
  recovered: boolean;
  /** The user explicitly confirmed continuing with the re-seeded draft. */
  acknowledged: boolean;
}

/** Why the one write may not happen yet, beyond [`stepBlocker`] — or `null`. THE RULE: a save
 *  may only merge a draft the user has actually seen. A failed seed would merge an EMPTY draft
 *  over a document the wizard could not show (the round-1 clobber), so the gate stays shut; a
 *  recovery re-seed is shown, but the second write needs an explicit acknowledgement first. */
export function saveGateBlocker(state: SaveGateState): string | null {
  if (state.seedFailed) {
    return (
      "The existing configuration could not be read into this wizard's fields, so saving from " +
      "here could overwrite settings you have never been shown. Nothing was changed — edit the " +
      "file directly, or use the Settings screen."
    );
  }
  if (state.recovered && !state.acknowledged) {
    return "Confirm the loaded configuration below before saving again.";
  }
  return null;
}
