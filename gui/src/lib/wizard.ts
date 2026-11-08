/**
 * B8 (T16) — the first-run wizard's rules, all pure so `tests-web/wizard.check.ts` can pin them.
 *
 * ⚠ THE CONFIG IS WRITTEN ONCE, AT THE END, THROUGH THE VALIDATED PATH — and this module is where
 * that is enforceable: nothing here performs IPC. `Wizard.svelte` calls exactly one of
 * `configCreate` / `configSave` (chosen by [`savePlan`]), exactly once, at the step-5 → step-6
 * gate; a cancel on any earlier step unmounts the component with the draft still in webview
 * memory and NOTHING written.
 *
 * ⚠ v0.3.0 (plan M9): THE OPTIONAL CALENDAR STEP COMES AFTER THAT WRITE, ON PURPOSE. A calendar
 * link's URL is a secret that must not sit in the draft (or in any component state) waiting for the
 * save, and the owner confirmation needs the engine to read the link — so the step can only work on
 * a config that exists. It sits between the save gate and the delivery step ("before the schedule
 * step", spec §8), its controls OFF by default; Continue with nothing ticked writes nothing more,
 * and anything it does write goes through the calendar commands (`calendar_link_write`,
 * `calendar_config_save`), never through a second `config_save`.
 *
 * ⚠ NO SECOND VALIDATOR. The engine's `config validate` is the semantic authority; what this file
 * checks per step is only "is there enough to build a candidate at all" (a non-empty model, a
 * well-shaped HH:MM), never the engine's rules re-implemented.
 *
 * ⚠ A PASTED KEY GOES TO THE ENGINE'S KEY STORE, AND THE CONFIG HOLDS ONLY ITS REFERENCE (provider
 * fallback P3-M6-T3, spec r9 §6 "First-time setup"). The API path defaults to PASTE: the key is handed
 * to `provider key set` (`lib/wizard-key.ts`, through `lib/engine.ts`'s `providerKeySet`; the key on the
 * engine's stdin), which stores it in the Keychain on macOS or an owner-only key file elsewhere and
 * answers a REFERENCE — an `apiKeyCommand` or an `apiKeyFile` — and the draft keeps that reference
 * ([`PastedKey`]), never the key. A key file or a command the user points at stays under "Advanced".
 * Either way the config is written with references only: `config_save` refuses to set a literal
 * `apiKey`, `init` has no `--api-key` flag, `apiKeyEnv` cannot resolve from the app or from launchd,
 * and `config_create` refuses a literal key outright, at ANY spelling or position (a recursive
 * case-insensitive scan for a key named `apiKey`; `apiKeyFile`/`apiKeyCommand` stay legal). This
 * module never sees the key: it performs no IPC, and the key travels only from the component's
 * password field to `lib/wizard-key.ts`'s `pasteKey`. (The one literal on the KEEP side is a key an
 * EXISTING config already stores: on a re-run its placeholder is carried through on the Advanced
 * path, which is how the edit path keeps — never shows — it; a pasted key replaces it.)
 */
import { REDACTED_API_KEY } from "./files";
import type { AppKeyReference } from "./engine";
import { DEFAULT_MORNING_TIME, parseMorningTime, unparseableNote } from "./morning-time";
import type { Os } from "./platform";
import type { Phase, Route } from "./state";
import { KEY_SOURCES, readProviderList, setEntrySettings, writeProviderList, type Blocked, type ReadRefusal } from "./provider-list";

/* ── the steps ────────────────────────────────────────────────────────────────────────────────── */

export type StepId = "welcome" | "provider" | "repos" | "access" | "updates" | "floor" | "calendar" | "delivery";

/** Plan R1's six steps, in order — plus Phase E's update-check consent (E12), placed BEFORE the floor
 *  step on purpose: the floor step is the save gate, so the consent answer is part of the one write
 *  and answering it sends nothing (the draft holds it until then).
 *
 *  ⚠ STEP NUMBERS IN COMMENTS ARE PLAN R1'S (step 4 = access, step 5 = floor and the save gate,
 *  step 6 = delivery), kept because they cite R1. The screen numbers come from [`stepHeading`]: they
 *  count the steps that show, the consent step and the calendar step (v0.3.0, between the save gate
 *  and delivery; the header says why it is after the save) included, so the screen reads "of 8" on
 *  macOS and an unknown OS until the step-3 access check says otherwise, and "of 7" on Linux and Windows
 *  and whenever the access step is out of scope ([`accessCounts`]). */
export const STEP_ORDER: StepId[] = ["welcome", "provider", "repos", "access", "updates", "floor", "calendar", "delivery"];

/** What the screen numbering depends on (design 2026-10-31 r6 §1–2). `accessKnown` turns true when "Continue"
 *  from step 3 has run the access check (either way it ends); `accessInScope` is that check's answer. */
export interface StepCtx {
  readonly os: Os;
  readonly accessKnown: boolean;
  readonly accessInScope: boolean;
}

/** Each step's title. The ONLY source of them: the header renders [`stepHeading`]. */
const STEP_TITLES: Record<StepId, string> = {
  welcome: "what this is",
  provider: "who writes the briefing",
  repos: "what it reads",
  access: "macOS folder access",
  updates: "new versions",
  floor: "your morning time",
  calendar: "your calendar (optional)",
  delivery: "background delivery",
};

/** Whether the access step counts. Never on Linux or Windows, whatever `accessInScope` says (r6). On macOS and an
 *  unknown OS (which may be a Mac, `platform.ts`) it counts until the check has run, and then only when in scope —
 *  so the total can change only at "Continue" from step 3. */
function accessCounts(ctx: StepCtx): boolean {
  if (ctx.os === "linux" || ctx.os === "windows") return false;
  return ctx.accessKnown ? ctx.accessInScope : true;
}

/** The screen number of `step` among the steps that show, in `STEP_ORDER`; `null` for a step that will not show
 *  (the access step, when it does not count). */
export function stepNumber(step: StepId, ctx: StepCtx): number | null {
  const counts = accessCounts(ctx);
  let n = 0;
  for (const s of STEP_ORDER) {
    if (s === "access" && !counts) {
      if (s === step) return null;
      continue;
    }
    n += 1;
    if (s === step) return n;
  }
  return null;
}

/** How many steps show: 8 with the access step, 7 without. */
export function stepTotal(ctx: StepCtx): number {
  return accessCounts(ctx) ? STEP_ORDER.length : STEP_ORDER.length - 1;
}

/** "Step N of M — title", or `null` for a step that will not show. */
export function stepHeading(step: StepId, ctx: StepCtx): string | null {
  const n = stepNumber(step, ctx);
  return n === null ? null : `Step ${n} of ${stepTotal(ctx)} — ${STEP_TITLES[step]}`;
}

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

/** Cancelling writes nothing exactly while the save has not happened — which is every step up to
 *  and including `floor` (the save is the gate OUT of `floor`, into the calendar step and then
 *  `delivery`). Pinned; the component renders "Set up later" only while this is true. */
export function cancelWritesNothing(current: StepId): boolean {
  return STEP_ORDER.indexOf(current) <= STEP_ORDER.indexOf("floor");
}

/** What the nav buttons wait on (design 2026-10-31 r6 §3). `installBusy` / `verifyInFlight` come from
 *  `ScheduleInstall`'s and `ScheduleVerify`'s `onbusy`; `verifyTriggered` is "an install armed the check";
 *  `calendarBusy` is a calendar flow running or a calendar write in flight. */
export interface NavState {
  readonly saving: boolean;
  readonly keyBusy: boolean;
  readonly accessLoading: boolean;
  readonly installBusy: boolean;
  readonly verifyInFlight: boolean;
  readonly verifyTriggered: boolean;
  readonly finishing: boolean;
  readonly calendarBusy: boolean;
}

export interface NavButton {
  readonly shown: boolean;
  readonly disabled: boolean;
}

/** Every nav button but Continue and the save button (those stay inline in `Wizard.svelte`). Finish renders on the
 *  delivery step only (the template's branch), so it carries no `shown`. */
export interface WizardNav {
  readonly back: NavButton;
  readonly setUpLater: NavButton;
  readonly finishLater: NavButton;
  readonly finish: { readonly disabled: boolean };
}

const HIDDEN: NavButton = { shown: false, disabled: false };

/**
 * The nav row, decided in one place (design 2026-10-31 r6 §3; table in `tests-web/wizard-nav.check.ts`).
 *
 * - Up to the save gate ([`cancelWritesNothing`]): "Set up later" (waits while saving) and Back from step 2 on
 *   (waits for a key step and a save, and on step 3 for the access check — a late snapshot must not move a
 *   wizard that went Back).
 * - ⚠ NARROW BACK (D2): after the save, Back moves only from delivery to the calendar step, never past the save.
 *   It waits while the install is busy, once an install has armed the check (so the loop never remounts and
 *   re-kicks), while a check is in flight, and while Finish runs.
 * - "Finish setup later" (D3) on the calendar and delivery steps: it waits for the install, a check in flight and
 *   Finish — and on the calendar step for a calendar flow or write too, which leaving would unmount mid-flow.
 * - Finish shares the install/verify gate, since leaving through it unmounts the same components mid-call. It is
 *   NOT held after an install, nor for a pending retry: a retry has no timer and may wait for a tick forever.
 */
export function wizardNav(step: StepId, s: NavState): WizardNav {
  const leaving = s.installBusy || s.verifyInFlight || s.finishing;
  const finish = { disabled: leaving };
  if (cancelWritesNothing(step)) {
    return {
      back: step === "welcome" ? HIDDEN : { shown: true, disabled: s.keyBusy || s.saving || (step === "repos" && s.accessLoading) },
      setUpLater: { shown: true, disabled: s.saving },
      finishLater: HIDDEN,
      finish,
    };
  }
  if (step === "calendar") {
    return { back: HIDDEN, setUpLater: HIDDEN, finishLater: { shown: true, disabled: leaving || s.calendarBusy }, finish };
  }
  return {
    back: { shown: true, disabled: leaving || s.verifyTriggered },
    setUpLater: HIDDEN,
    finishLater: { shown: true, disabled: leaving },
    finish,
  };
}

/* ── keeping your place (design 2026-10-31 r6 §4, D3; tables in `tests-web/wizard-resume.check.ts`) ──────────── */

/**
 * The Setup tab shows while setup is the route, while it is open — mounted and hidden behind another tab (`wizardOpen`,
 * App's) — or while the engine reports no configuration (the pre-D3 rule, kept). `phase` is `undefined` before the first
 * snapshot.
 */
export function wizardTabShown(route: Route, phase: Phase["phase"] | null | undefined, wizardOpen: boolean): boolean {
  return route === "wizard" || wizardOpen || phase === "not-configured";
}

/**
 * The step line's `focusHeading` argument (`lib/ui/a11y.ts`): true only when setup is shown and past its first mount.
 * The line is keyed on the step, so each step change mounts it again with `true`; showing setup again turns the
 * argument from false to true on the same node. `firstMount` (the wizard's) holds until the first step change or the
 * first hide, so opening the app on setup, or the auto-offer, does not pull focus into it.
 */
export function focusStepLine(firstMount: boolean, shown: boolean): boolean {
  return shown && !firstMount;
}

/* ── the draft ────────────────────────────────────────────────────────────────────────────────── */

/** Which of R1's three provider paths is chosen. */
export type ProviderPath = "cli" | "api" | "local";

/** What the Test of a pasted key said: it passed, it failed (it RAN — Use it anyway may follow, requirement 6), or it
 *  did not run (busy, refused): Test again. */
export type KeyTest = "passed" | "failed" | "not-run";

/** A key the user pasted, as stored by `provider key set`: its id and the reference to save (not secrets), and its
 *  Test. Never the key itself. */
export interface PastedKey {
  readonly keyId: string;
  readonly ref: AppKeyReference;
  readonly test: KeyTest;
  /** After a FAILED Test, the user chose to use it anyway. */
  readonly useAnyway: boolean;
}

export interface WizardDraft {
  providerPath: ProviderPath;
  /** Path (a): which installed CLI. The engine's own `init` order: claude, then codex. */
  cli: "claude" | "codex";
  /** Path (b): the native Anthropic transport. */
  apiModel: string;
  /** The prefilled model must be EXPLICITLY confirmed (plan R1) — or edited, which is stronger. */
  apiModelConfirmed: boolean;
  /** P3-M6-T3: "Advanced" — point at a key file or a command instead of pasting. `false` (paste) is the DEFAULT. */
  apiKeyAdvanced: boolean;
  /** P3-M6-T3: the pasted key's id and reference once `key set` stored it, else `null`. Used only on the paste path
   *  ([`pastedInUse`]). */
  pasted: PastedKey | null;
  /** Advanced: a path to a file holding the key — the key BY REFERENCE, never by value. */
  apiKeyFile: string;
  /** Advanced: an argv that prints the key, one argument per line. */
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
  /** Step 5: the morning FLOOR, HH:MM. Earliest, not exact ([`firstWakeSentence`]). Always the
   *  dropdowns' `HH:MM`: a re-run seed is NORMALISED the engine's way ([`draftFromConfig`]), so the
   *  step is never blocked by a value the user cannot see (v0.2.1 §3.2). */
  floor: string;
  /** v0.2.1 §3.2: the morning-time step's note when the seeded config holds a value the engine
   *  cannot read (`floor` is then 07:20, what the engine uses), else `null`. Display only — never
   *  written to the config. */
  floorNote: string | null;
  /** Phase E (E12): the update-check consent answer — `config.updateCheck.enabled`. `false` ("No")
   *  is the DEFAULT; only an explicit "Yes" turns the engine's automatic check on. */
  updateCheck: boolean;
}

/** The engine's own defaults, mirrored — each pinned against `src/config.ts` /
 *  `src/schedule.ts` exports by `wizard.check.ts`, because this module cannot import engine
 *  source into a webview bundle (15 of 26 engine modules use Bun APIs). */
export const DEFAULT_FLOOR = DEFAULT_MORNING_TIME;
export const DEFAULT_TOKEN_BUDGET = { maxChars: 200000 };
export const DEFAULT_LOOKBACK_CAP_DAYS = 4;
export const DEFAULT_NETWORK_PROBE_HOSTS = [
  { host: "1.1.1.1", port: 443 },
  { host: "8.8.8.8", port: 443 },
];
/** The model path (b) prefills — confirmed explicitly, never silently adopted (plan R1). */
export const PREFILL_API_MODEL = "claude-sonnet-5";
/** Path (c)'s raised provider timeout: a local model on modest hardware can take minutes where
 *  the default 300 s for API entries (`API_TIMEOUT_MS`, `src/provider.ts`) may be too short. Ten minutes, written explicitly
 *  so it is discoverable and editable in Settings. */
export const LOCAL_TIMEOUT_MS = 600000;

export function emptyDraft(): WizardDraft {
  return {
    providerPath: "cli",
    cli: "claude",
    apiModel: PREFILL_API_MODEL,
    apiModelConfirmed: false,
    apiKeyAdvanced: false,
    pasted: null,
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
    floorNote: null,
    updateCheck: false,
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
        if (!draft.apiKeyAdvanced) {
          if (draft.pasted === null) return "Paste your API key, then press Store and test.";
          if (draft.pasted.test === "not-run") return "Test the key before you continue.";
          if (!pastedUsable(draft.pasted)) return "The key did not pass its test: test it again, use it anyway, or discard it.";
        } else if (draft.apiKeyFile.trim() === "" && lines(draft.apiKeyCommand).length === 0) {
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
      return floorValid(draft.floor) ? null : "Choose a morning time.";
    default:
      return null;
  }
}

/* ── the pasted key (P3-M6-T3) ──────────────────────────────────────────────────────────────────── */

/** A pasted key the draft may save: its Test passed, or it failed and the user chose to use it anyway. A Test that did
 *  not run never qualifies — "use it anyway" rests on a Test that ran (requirement 6). */
export function pastedUsable(p: PastedKey): boolean {
  return p.test === "passed" || (p.test === "failed" && p.useAnyway);
}

/** The draft saves the pasted key's reference: the API path, on paste (not Advanced), with a key stored. */
export function pastedInUse(draft: WizardDraft): boolean {
  return draft.providerPath === "api" && !draft.apiKeyAdvanced && draft.pasted !== null;
}

/**
 * The pasted key to release (delete unless a saved config references it) when the user leaves the provider step or
 * the wizard this way, or `null` to keep it:
 *  - `leave` — the wizard goes away before its save: nothing was saved with it;
 *  - `back` — the draft would not use it ([`pastedInUse`]), or its Test failed or never ran (and it was not chosen
 *    anyway);
 *  - `continue` — the draft would not use it (another path, or Advanced).
 * The component clears `draft.pasted` before releasing, so one key is released once.
 */
export function pastedToRelease(draft: WizardDraft, how: "continue" | "back" | "leave"): PastedKey | null {
  const p = draft.pasted;
  if (p === null) return null;
  if (how === "leave" || !pastedInUse(draft)) return p;
  if (how === "back" && !pastedUsable(p)) return p;
  return null;
}

/** "Use it anyway" is offered only after a Test that RAN and failed (requirement 6), not yet chosen. A Test that did not
 *  run (`not-run`: busy, a briefing holding the lock, an engine refusal) offers Test again instead. */
export function useAnywayOffered(p: PastedKey): boolean {
  return p.test === "failed" && !p.useAnyway;
}

/** A Test's answer `p`, run on `testedModel`, for the draft whose model is now `model`: a Test of another model (the
 *  save trims it) says nothing of this one, so it is `not-run` — and a "use it anyway" made about it goes with it. The
 *  way Settings' Add re-tests a candidate edited since its Test (`testedOn`). */
export function pastedForModel(p: PastedKey | null, testedModel: string, model: string): PastedKey | null {
  if (p === null || p.test === "not-run" || testedModel.trim() === model.trim()) return p;
  return { ...p, test: "not-run", useAnyway: false };
}

/** The model field's edit: the draft's model, and the pasted key's Test reset when it was of another model. */
export function setApiModel(draft: WizardDraft, model: string): void {
  const before = draft.apiModel;
  draft.apiModel = model;
  draft.pasted = pastedForModel(draft.pasted, before, model);
}

/**
 * Release the pasted key on leaving `how` — but ONLY ONCE ANY SAVE IN FLIGHT HAS SETTLED (checkpoint P3-M6; hub Q21:
 * "the editor awaits any outstanding `config_save`"). A save already sent cannot be recalled, and the release's re-read
 * of the saved settings must not run before that save commits (`config_read` takes no save lock), or a first run reads
 * "no config" and deletes the key the save is about to reference.
 *
 *  • `inFlight` resolves to whether that save LANDED (a rejection did not); `landed` says whether one landed before.
 *    Either way a landed save makes this a `continue` — only a key the saved draft does not use is released — and
 *    otherwise `how` decides (`pastedToRelease`).
 *  • Once: `draft().pasted` is dropped in the same step that decides, before `release` is awaited, so a second leave
 *    finds nothing. With nothing in flight, nothing is awaited: the decision is made at once.
 *  • `draft` reads the draft to release from — the CURRENT one, or the one a re-seed just replaced (`seedDrops`).
 *
 * Answers `release`'s lines, or `null` when nothing was released.
 */
export async function releaseOnLeave(w: {
  inFlight: Promise<boolean> | null;
  landed: () => boolean;
  how: "continue" | "back" | "leave";
  draft: () => WizardDraft;
  release: (p: PastedKey) => Promise<string[]>;
}): Promise<string[] | null> {
  const landedNow = w.inFlight === null ? false : await w.inFlight.catch(() => false);
  const d = w.draft();
  const p = pastedToRelease(d, landedNow || w.landed() ? "continue" : w.how);
  if (p === null) return null;
  d.pasted = null;
  return w.release(p);
}

/** A re-seed (the `alreadyExists` / `conflict` recovery) that replaced `before` with `after` dropped a stored key. */
export function seedDrops(before: WizardDraft, after: WizardDraft): boolean {
  return before.pasted !== null && after.pasted?.keyId !== before.pasted.keyId;
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

/* ── v0.2.1 §3.5: the wording that depends on the OS ──────────────────────────────────────────── */

/**
 * Every piece of `Wizard.svelte`'s text that names the Mac, by OS — one function, so the template
 * and `wizard.check.ts` read the same strings (the wizard only server-renders its first step, so a
 * render alone cannot reach the others).
 *
 * ⚠ THE macOS VALUES ARE THE PRE-v0.2.1 TEXT, UNCHANGED. Elsewhere (Linux, Windows, unknown) the
 * Mac is "this computer"; the "each time it opens" aside goes (the launch-time `access_snapshot`,
 * which runs the engine's check, answers `unsupported` without spawning anything off macOS); the
 * folder-access clause and the protected-folders note go (that step is skipped off macOS).
 *
 * The step titles are not here: the screen numbers and titles come from [`stepHeading`], whose access step
 * ("macOS folder access") never shows on Linux or Windows.
 */
export interface WizardOsWording {
  /** Step 1: "Everything runs on {machine}." */
  machine: string;
  /** Step 1: "whenever this app checks your setup{checkOnOpen} (a connection…". Starts with a space. */
  checkOnOpen: string;
  /** Step 1: "until you confirm at the last step{folderAccessClause}. Cancelling…". */
  folderAccessClause: string;
  /** Step 2, the local-model option: "never leaves {localModelStaysOn}." */
  localModelStaysOn: string;
  /** Step 3, the Home folder option: "…Documents and Downloads{homeScanAsks}. Untick this…". */
  homeScanAsks: string;
  /** Step 3: whether the "These three are macOS-protected…" note shows. */
  protectedFoldersNote: boolean;
  /** The morning-time step: "runs every ten minutes while {awake} is awake." */
  awake: string;
}

export function wizardOsWording(os: Os): WizardOsWording {
  if (os === "macos") {
    return {
      machine: "this Mac",
      checkOnOpen: " (on macOS, also each time it opens)",
      folderAccessClause:
        "; the folder-access step asks macOS for permission only when you press its button",
      localModelStaysOn: "your Mac",
      homeScanAsks: " — macOS may ask about those the first time",
      protectedFoldersNote: true,
      awake: "your Mac",
    };
  }
  return {
    machine: "this computer",
    checkOnOpen: "",
    folderAccessClause: "",
    localModelStaysOn: "this computer",
    homeScanAsks: "",
    protectedFoldersNote: false,
    awake: "your computer",
  };
}

/* ── the candidate config ─────────────────────────────────────────────────────────────────────── */

type Json = Record<string, unknown>;

/** What a broken list is, in words — no value from the config is quoted (a label is user text). */
const UNREADABLE_LIST: Record<ReadRefusal, string> = {
  "provider-not-object": "\"provider\" is not an object",
  "accounts-unreadable": "\"provider.accounts\" is not a list of labelled logins",
  "provider-label-invalid": "\"provider.label\" is empty or not text",
  "fallbacks-unreadable": "an entry of \"fallbacks\" is not a labelled provider block",
  "duplicate-label": "two providers share a label",
};

function refusalWords(blocked: readonly Blocked[]): string {
  if (blocked.some((b) => b.kind === "literal-moved")) {
    return (
      "Not saved: this change would move a provider whose API key is stored in the config file to a " +
      "different place in your list of providers, and a stored key has to stay where it is. Move that key " +
      "out of the config file first (point the provider at a key file or a key command instead), then run " +
      "setup again. Nothing was changed."
    );
  }
  const nested = blocked.find((b) => b.kind === "nested-list");
  if (nested !== undefined && nested.kind === "nested-list") {
    return (
      `Not saved: your first provider's settings in the config file hold a "${nested.field}" list inside ` +
      "\"provider\", where it does not belong. Move that list out of \"provider\" in the config file (or delete it), " +
      "then run setup again. Nothing was changed."
    );
  }
  const unreadable = blocked.find((b) => b.kind === "unreadable");
  if (unreadable !== undefined && unreadable.kind === "unreadable") {
    return (
      `Not saved: the list of providers in your config could not be read (${UNREADABLE_LIST[unreadable.reason]}), ` +
      "so setup cannot change the first provider without guessing at the others. Fix the list in the config " +
      "file, then run setup again. Nothing was changed."
    );
  }
  return "Not saved: setup could not write your list of providers. Nothing was changed.";
}

/** Requirement 10 / spec §4 "Judge changes": shown once after a save that changed `provider` (or its `accounts`). */
export const JUDGE_LINE = "The audit judge follows your first provider and its logins.";

/**
 * P3-M3-T2: the list writer refused the wizard's provider change ([`mergeConfig`], so [`savePlan`], throws it).
 * The save never happens around a block: `Wizard.svelte`'s save gate calls `savePlan` inside its `try` and
 * shows `describeFailure(e)`, which for an `Error` is its message — so the user reads why, and nothing is
 * written. `blocked` is the writer's own answer, for tests and any caller that wants the detail. `kind` is
 * never `alreadyExists`/`conflict`, so the gate does not re-seed over it.
 */
export class ProviderListRefusal extends Error {
  readonly kind = "providerList";
  constructor(readonly blocked: readonly Blocked[]) {
    super(refusalWords(blocked));
    this.name = "ProviderListRefusal";
  }
}

/** Every way an `api` block names its key (`KEY_SOURCES`, defined once in `provider-list.ts`). A stored key is bound to
 *  its ENDPOINT (P3-M2-T1 checkpoint): a re-run that changes the block's `kind` or its endpoint's origin carries none
 *  of these over, so no key is sent where it was not set up for. */
const isKeySource = (k: string): boolean => (KEY_SOURCES as readonly string[]).includes(k);

/** The engine's endpoint for an `anthropic` block with no `baseUrl` (`ANTHROPIC_DEFAULT_BASE_URL`,
 *  `src/providers/endpoint.ts`); an `openai-compatible` block has none. */
const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/** Where an api block of `kind` with this `baseUrl` sends its key: the URL's origin (scheme, host, port — the
 *  default port elided, as `URL.origin` writes it), `baseUrl` absent meaning the kind's default as the engine's
 *  `endpointUrl` reads it. A value that is not a URL with a host is compared as its own text. The same rule as the
 *  settings guard's (`config_save.rs` `endpoint`), which refuses the restore on its own. */
function endpointOrigin(kind: unknown, baseUrl: unknown): string | undefined {
  const raw = baseUrl ?? (kind === "anthropic" ? ANTHROPIC_DEFAULT_BASE_URL : undefined);
  if (raw === undefined) return undefined;
  const text = typeof raw === "string" ? raw : JSON.stringify(raw);
  try {
    const origin = new URL(text).origin;
    if (origin !== "null") return origin;
  } catch {
    // compared as text below
  }
  return `unparsed:${text}`;
}

/** The fields of `provider` that belong to the LIST, not to item 1's block (`lib/provider-list.ts` reads item 1's
 *  block as `provider` without these, as the engine's `blockOf` does). The list writer owns them. */
const ITEM1_LIST_FIELDS = new Set(["label", "accounts", "configDir"]);

/** The wizard's provider BLOCK — item 1's settings — for `existing`, item 1's block as written (or none).
 *
 *  P3-M3-T2: a BLOCK, never the list. `label`, `accounts` and `configDir` are the list's
 *  (`lib/provider-list.ts`) and are never returned, even when `existing` carries them; [`applyProvider`]
 *  puts the block back through the list writer, which keeps item 1's label and re-compacts.
 *
 *  DO-NOT-CLOBBER is the organising rule (R1 delta-verify H), in three layers:
 *  - a CLI provider the user KEPT (`existing.cli === draft.cli`, no `api` block) is returned
 *    byte-for-byte — a customised `argv` (`["-p","--model","sonnet"]`), `harden: false`, a
 *    `credential` choice, all survive a wizard re-run untouched (and so do its logins: an
 *    unchanged block leaves the list alone);
 *  - a provider that CHANGED rebuilds only the keys the wizard owns; every block key it does
 *    not own (`timeoutMs`, unknown fields) rides through, and inside an `api` block the unowned
 *    keys (`maxTokens`, `apiKeyEnv`, …; `baseUrl` only on an Anthropic re-run of an `anthropic`
 *    block — from any other kind the api path drops it, P3-M2-T2) ride through the same way — except that the api path
 *    from an `openai-compatible` block drops `maxTokens` and a `timeoutMs` equal to `LOCAL_TIMEOUT_MS` (the local
 *    path's own values, checkpoint P3-M2). `accounts` NO LONGER rides through (P3-M3-T2): the other logins keep the old settings
 *    as `fallbacks` entries, so none is left attached to an API item 1 or to a different CLI;
 *  - a stored literal key's PLACEHOLDER is carried on the api path, so a re-run never silently
 *    drops a key the config already holds (the edit path restores it; a create has no
 *    `existing` and `config_create` refuses any literal key);
 *  - EXCEPT onto another endpoint (P3-M2-T1 checkpoint): a re-run that changes the block's `kind`, or the origin of
 *    its endpoint ([`endpointOrigin`]), carries no key source at all — not the placeholder, `apiKeyFile`,
 *    `apiKeyCommand` or `apiKeyEnv` — so a key set up for one endpoint is never sent to another (the old local path
 *    carried an Anthropic literal's placeholder into the new `openai-compatible` block). The sources the user types
 *    on the api path (`apiKeyFile`, `apiKeyCommand`) are the draft's, not carried, and are kept;
 *  - A PASTED KEY (P3-M6-T3, [`pastedInUse`]) is the api block's ONLY key source: its reference, exactly as `key set`
 *    answered it, and no carried or typed source beside it (spec §6: switching an entry to a pasted key removes its
 *    other key sources).
 */
export function providerValue(draft: WizardDraft, existing: Json | undefined): Json {
  const owned = new Set(["cli", "argv", "promptVia", "api", "harden", "credential"]);
  const block = existing !== undefined ? blockOf(existing) : {};
  const kept: Json = {};
  for (const [k, v] of Object.entries(block)) {
    if (!owned.has(k)) kept[k] = v;
  }
  const existingApi = existing?.["api"] as Json | undefined;
  /** Does an api block of `kind` at `baseUrl` send its key where the existing one does? */
  const sameEndpoint = (kind: string, baseUrl: unknown): boolean =>
    existingApi !== undefined &&
    existingApi["kind"] === kind &&
    endpointOrigin(existingApi["kind"], existingApi["baseUrl"]) === endpointOrigin(kind, baseUrl);
  /** The existing api block minus the keys the chosen path owns — what rides through. On another kind or endpoint
   *  origin ([`sameEndpoint`]), minus every key source too ([`KEY_SOURCES`]). */
  const keptApi = (ownedApi: string[], keepKeys: boolean): Json => {
    const out: Json = {};
    if (existingApi !== undefined) {
      for (const [k, v] of Object.entries(existingApi)) {
        if (!ownedApi.includes(k) && (keepKeys || !isKeySource(k))) out[k] = v;
      }
    }
    return out;
  };
  switch (draft.providerPath) {
    case "cli":
      if (existing !== undefined && existing["cli"] === draft.cli && existingApi === undefined) {
        // The user kept the provider they had: nothing about it is rewritten.
        return block;
      }
      // The engine's own template for this CLI (`src/config.ts`, `initConfig`): claude prompts
      // via `-p`, codex via `exec`; `harden`/`credential` written at their defaults so the
      // opt-outs are discoverable. From a local block (the P3-M4-T1 carried LOW), the block-level
      // `timeoutMs` the local path raised to `LOCAL_TIMEOUT_MS` does not carry over — the CLI then
      // waits the engine's default, as the api path already does (checkpoint P3-M2); a `timeoutMs`
      // the user set to any other value is theirs and is kept.
      const { timeoutMs: cliTimeout, ...cliRest } = kept;
      const fromLocalBlock = existingApi?.["kind"] === "openai-compatible" && cliTimeout === LOCAL_TIMEOUT_MS;
      return {
        ...(fromLocalBlock ? cliRest : kept),
        cli: draft.cli,
        argv: draft.cli === "codex" ? ["exec"] : ["-p"],
        promptVia: "stdin",
        harden: true,
        credential: "subscription",
      };
    case "api": {
      const command = lines(draft.apiKeyCommand);
      // `baseUrl` rides through only from an `anthropic` block (a user's own Anthropic proxy), so on this path the
      // endpoint never changes without the kind changing too (P3-M2-T2): from any other kind — a local
      // `openai-compatible` LAN URL — this path owns `baseUrl` and drops it, so the key file/command the user types
      // here goes to the Anthropic default, never to the old endpoint.
      const fromAnthropic = existingApi?.["kind"] === "anthropic";
      // From a local block (checkpoint P3-M2 LOW), the local path's own values do not carry over either: the local
      // model's `maxTokens`, and the block-level `timeoutMs` that path raised to `LOCAL_TIMEOUT_MS` — the Anthropic
      // block then waits the engine's API default (300 s, `API_TIMEOUT_MS`, `src/provider.ts`). A `timeoutMs` the user set to any
      // other value is theirs and is kept.
      const fromLocal = existingApi?.["kind"] === "openai-compatible";
      // P3-M6-T3: a pasted key's reference is the entry's ONLY key source (spec §6: switching an entry to a pasted key
      // removes its other key sources — `apiKeyEnv` and the stored literal outrank or shadow nothing then). Nothing
      // the user typed under Advanced is written beside it.
      const pasted = pastedInUse(draft) ? draft.pasted!.ref : null;
      const keepKeys = pasted === null && sameEndpoint("anthropic", existingApi?.["baseUrl"]);
      const storedKey = keepKeys && (existingApi?.["apiKey"] as unknown) === REDACTED_API_KEY;
      const ownedApi = [
        "kind", "model", "apiKeyFile", "apiKeyCommand", "apiKey",
        ...(fromAnthropic ? [] : ["baseUrl"]),
        ...(fromLocal ? ["maxTokens"] : []),
      ];
      const { timeoutMs, ...rest } = kept;
      const keptBlock = fromLocal && timeoutMs === LOCAL_TIMEOUT_MS ? rest : kept;
      return {
        ...keptBlock,
        api: {
          ...keptApi(ownedApi, keepKeys),
          kind: "anthropic",
          model: draft.apiModel.trim(),
          ...(pasted !== null
            ? "apiKeyCommand" in pasted
              ? { apiKeyCommand: [...pasted.apiKeyCommand] }
              : { apiKeyFile: pasted.apiKeyFile }
            : {
                ...(draft.apiKeyFile.trim() !== "" ? { apiKeyFile: draft.apiKeyFile.trim() } : {}),
                ...(command.length > 0 ? { apiKeyCommand: command } : {}),
              }),
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
          ...keptApi(["kind", "model", "baseUrl"], sameEndpoint("openai-compatible", draft.localBaseUrl.trim())),
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

/**
 * The draft's provider, applied to `target` in place — THROUGH THE LIST WRITER (P3-M3-T2).
 *
 * The wizard edits item 1 only. Its new block replaces item 1's settings under item 1's own label
 * (`setEntrySettings`; labels never change), and `writeProviderList` writes the list back with its
 * compaction: a login stays in `provider.accounts` only while it has exactly item 1's settings, so
 * a re-run that changes item 1 moves the other logins — still on the old settings — into
 * `fallbacks`, and never leaves logins attached to an API item 1. Compaction never pulls a
 * `fallbacks` entry into `accounts` (checkpoint P3-M3): on an API → CLI change every fallback stays
 * a block, and `accounts` the engine ignored beside the old API item 1 is dropped, not revived.
 *
 *  • NO-OP FIRST (round 1's discipline): a rebuild that changed no value of item 1's block leaves
 *    `provider` and `fallbacks` exactly as written, key order included, so an untouched re-run is
 *    the save path's `unchanged` no-op — whatever else the list holds, readable or not.
 *  • A CHANGED item 1 carries no login directory: `configDir` is a Claude login's
 *    (`CLAUDE_CONFIG_DIR`), and a changed block is a different CLI or an API entry (a kept CLI is
 *    the no-op above), where the old directory means nothing.
 *  • REFUSED, NEVER SAVED AROUND: a list the writer cannot read, or a write it blocks — a stored
 *    literal key whose pointer would move (`literal-moved`: the settings guard restores a literal
 *    by pointer and label, `config_save.rs`) — throws [`ProviderListRefusal`]; the save gate shows
 *    its words and writes nothing.
 *  • A stray `provider.fallbacks` (unowned, so it rides into the rebuilt block) is refused the same way
 *    (`nested-list`), never the list module's internal Error — the list writer owns `fallbacks`.
 *  • No `provider` yet (a create, or a config without one): the block alone, as before.
 *
 *  Returns whether `provider` changed — the audit judge's configuration (requirement 10): the list writer's own
 *  `judgeChanged` on a write, false on the no-op, true when `provider` is written for the first time.
 */
function applyProvider(target: Json, draft: WizardDraft): boolean {
  const existing = target["provider"];
  if (existing === undefined || existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    target["provider"] = providerValue(draft, undefined);
    return true;
  }
  const current = existing as Json;
  const rebuilt = providerValue(draft, current);
  if (jsonEqual(rebuilt, blockOf(current))) return false;
  const read = readProviderList(target);
  if (!read.ok) throw new ProviderListRefusal([{ kind: "unreadable", reason: read.reason }]);
  const label = read.entries[0]!.label;
  if ("fallbacks" in rebuilt) throw new ProviderListRefusal([{ kind: "nested-list", label, field: "fallbacks" }]);
  const entries = setEntrySettings(read.entries, label, { block: rebuilt });
  const written = writeProviderList(target, entries);
  if (!written.ok) throw new ProviderListRefusal(written.blocked);
  target["provider"] = written.config["provider"];
  if ("fallbacks" in written.config) target["fallbacks"] = written.config["fallbacks"];
  else delete target["fallbacks"];
  return written.judgeChanged;
}

/** Item 1's block as written: `provider` without the list's fields. */
function blockOf(provider: Json): Json {
  const out: Json = {};
  for (const [k, v] of Object.entries(provider)) if (!ITEM1_LIST_FIELDS.has(k)) out[k] = v;
  return out;
}

/** The wizard-owned top-level keys, applied to `target` in place. Everything else — every
 *  unknown field, `notify`, `author`, `subprojects`, `auditJudgeArgv`, whatever the engine grows
 *  next — is untouched, which is the round-trip preservation pin. `judgeChanged`: [`applyProvider`]'s. */
function applyDraft(target: Json, draft: WizardDraft): { config: Json; judgeChanged: boolean } {
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
  const judgeChanged = applyProvider(target, draft);
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
  //
  // Phase E (E12): the update-check consent. Written ONLY when the answer differs from what the
  // config already means (`enabled === true` is on; anything else — absent, false, malformed — is
  // off, the engine's own rule), so an untouched re-run stays the save path's `unchanged` no-op;
  // and when it is written, every other key in the block (`intervalHours`, …) rides through.
  const existingCheck = target["updateCheck"];
  const checkBlock =
    typeof existingCheck === "object" && existingCheck !== null && !Array.isArray(existingCheck)
      ? (existingCheck as Json)
      : undefined;
  if (draft.updateCheck !== (checkBlock?.["enabled"] === true)) {
    target["updateCheck"] = { ...(checkBlock ?? {}), enabled: draft.updateCheck };
  }
  return { config: target, judgeChanged };
}

/** The CREATE candidate — `initConfig`'s template shape, from the draft alone. */
export function buildConfig(draft: WizardDraft): Json {
  const out: Json = applyDraft({}, draft).config;
  // The template's discoverability defaults, exactly as the engine's `initConfig` writes them —
  // including the explicit probe-host pair on the CLI path (its comment in the engine: written
  // so the switch is discoverable and editable).
  if (draft.providerPath === "cli") {
    out["networkProbeHosts"] = DEFAULT_NETWORK_PROBE_HOSTS;
  }
  out["tokenBudget"] = DEFAULT_TOKEN_BUDGET;
  out["lookbackCapDays"] = DEFAULT_LOOKBACK_CAP_DAYS;
  // Phase E (E12): the consent answer is written EXPLICITLY on a create — `{ enabled: false }` for
  // the default "No" — so the new config records that the question was asked and answered, and the
  // switch is discoverable in Settings and in the file.
  out["updateCheck"] = { enabled: draft.updateCheck };
  return out;
}

/** The MERGE candidate — the draft applied onto the loaded document's parsed text, in place, so
 *  key order and every field the wizard does not own survive byte-for-byte through the save's
 *  canonical re-serialisation. */
export function mergeConfig(existingText: string, draft: WizardDraft): Json {
  return merged(existingText, draft).config;
}

/** [`mergeConfig`] plus whether the merge changed `provider` (the audit judge's configuration). */
function merged(existingText: string, draft: WizardDraft): { config: Json; judgeChanged: boolean } {
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
  /** `judgeChanged`: the edit changed `provider` — show [`JUDGE_LINE`] once it is saved (requirement 10). */
  | { kind: "save"; text: string; base: string; judgeChanged: boolean };

export function savePlan(
  doc: { exists: boolean; text: string | null; base: string | null },
  draft: WizardDraft,
): SavePlan {
  if (doc.exists && doc.text !== null && doc.base !== null) {
    const m = merged(doc.text, draft);
    return {
      kind: "save",
      text: JSON.stringify(m.config, null, 2),
      base: doc.base,
      judgeChanged: m.judgeChanged,
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
        // P3-M6-T3: a config that already points at a key file or a command opens on Advanced, showing what it says
        // (an untouched re-run stays the save path's no-op); any other opens on paste, the default.
        draft.apiKeyAdvanced = draft.apiKeyFile !== "" || draft.apiKeyCommand !== "";
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
    // v0.2.1 §3.2: NORMALISED through the engine's own reading (`lib/morning-time.ts`): a lenient
    // `7:05` becomes `07:05`, and a value the engine cannot read becomes the 07:20 it uses, with a
    // note naming the stored value — so the dropdowns show the time in force and Next is never
    // blocked by a value the user cannot see. A re-run's save then writes the normalised value.
    draft.floor = parseMorningTime(c["morningTime"]).hhmm;
    draft.floorNote = unparseableNote(c["morningTime"]);
    // Phase E (E12): on only when the config says exactly `enabled: true` — the engine's rule.
    const check = c["updateCheck"];
    draft.updateCheck = isObj(check) && check["enabled"] === true;
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

/* ── the last step's login item (Phase E M5b; checkpoint fix) ─────────────────────────────────── */

/** What `autostart_wizard_default` has said so far: nothing yet, its answer, or why it failed. */
export type LoginItemDefault =
  | { kind: "pending" }
  | { kind: "answered"; on: boolean }
  | { kind: "failed"; detail: string };

/** What Finish does with the login item. `wait`: Finish stays disabled. `leave`: Finish changes
 *  nothing about the login item. `apply`: Finish turns it on or off. */
export type LoginItemPlan = { kind: "wait" } | { kind: "leave" } | { kind: "apply"; enabled: boolean };

/** Run the default read (`read` is the one IPC call, injected) and settle it into a
 *  [`LoginItemDefault`]. Never rejects — a failure is a state, with `describe`'s words for it. */
export async function settleLoginItemDefault(
  read: () => Promise<boolean>,
  describe: (e: unknown) => string,
): Promise<LoginItemDefault> {
  try {
    return { kind: "answered", on: await read() };
  } catch (e) {
    return { kind: "failed", detail: describe(e) };
  }
}

/** Whether showing setup again reads the login-item default once more (final harden r1, MED 3): only while the box is
 *  untouched. Setup stays mounted while hidden (design 2026-10-31 D3), and Settings › This app can turn the login item
 *  on or off meanwhile; an untouched box would otherwise let Finish re-apply the stale answer (re-creating a login item
 *  the user just removed). A touched box is the user's choice, which always wins, so it is never re-read. */
export function loginDefaultRereads(choice: boolean | null): boolean {
  return choice === null;
}

/** THE RULE (Phase E M5b checkpoint fix). `choice` is the user's own tick or untick — `null` until
 *  they touch the box — and it always wins. Untouched:
 *    • the read has not answered ⇒ `wait`. No provisional value is ever applied: the first shape
 *      started the box ticked and let Finish apply that before the read answered, which could
 *      re-create a login item the user had removed.
 *    • the read FAILED ⇒ `leave`: the current state is unknown, so Finish touches nothing. The
 *      first shape turned the box off and Finish then applied that as an active REMOVAL.
 *    • the read answered ⇒ `apply` its answer (no record yet ⇒ ON; a record ⇒ the real state). */
export function loginItemPlan(state: LoginItemDefault, choice: boolean | null): LoginItemPlan {
  if (choice !== null) return { kind: "apply", enabled: choice };
  if (state.kind === "pending") return { kind: "wait" };
  if (state.kind === "failed") return { kind: "leave" };
  return { kind: "apply", enabled: state.on };
}

/** Whether the box is shown ticked: the user's choice, else the answered default — never ticked
 *  while the read is pending or after it failed. */
export function loginItemChecked(state: LoginItemDefault, choice: boolean | null): boolean {
  if (choice !== null) return choice;
  return state.kind === "answered" && state.on;
}

/** The line under the box while the default is not usable, or `null`. Both notes name the way out:
 *  ticking or unticking the box is a choice, and a choice is applied whatever the read says (fix
 *  round 2: the pending note said only "Checking…", while Finish sat disabled with no timeout).
 *  `state.detail` is the read's bare cause — the Rust command does not word it (its
 *  `wizard_default`), so this sentence is the only wrapper. */
export function loginItemNote(state: LoginItemDefault, choice: boolean | null): string | null {
  if (choice !== null) return null;
  if (state.kind === "pending") {
    return "Checking whether Daily Briefing already starts at login… Finish waits for the answer, or " +
      "tick or untick the box to choose now.";
  }
  if (state.kind === "failed") {
    return (
      `Whether Daily Briefing already starts at login could not be read (${state.detail}), so ` +
      "Finish leaves that setting as it is. Tick or untick the box to choose."
    );
  }
  return null;
}

/** Finish's login-item half: carry out `plan` through `apply` (the one IPC call, injected).
 *  Resolves `true` when the wizard may leave — after an applied change, or when there is nothing
 *  to apply — and `false` while the plan is `wait`. A failed `apply` rejects, so the wizard stays
 *  on its last step with the reason. */
export async function finishLoginItem(
  plan: LoginItemPlan,
  apply: (enabled: boolean) => Promise<void>,
): Promise<boolean> {
  if (plan.kind === "wait") return false;
  if (plan.kind === "apply") await apply(plan.enabled);
  return true;
}

/* ── the last step's per-repo notes (Phase E final harden: the partial-clone note) ────────────── */

/** One line the last step shows under the provider check: a repo's path and one of its notes. */
export interface RepoNote {
  path: string;
  note: string;
}

/** `doctor --json`'s per-repo NOTES, as `{ path, note }` rows to show VERBATIM — every string in a
 *  `repos[].notes` array, in the engine's order. The engine adds `partialClone: true` and
 *  `notes: [<one sentence>]` to a repo that is a partial clone (`git clone --filter`: git itself may
 *  download missing file contents from that repo's remote while the engine reads its history); a
 *  normal repo keeps the old shape, and an OLDER engine never sends either key — so both are
 *  optional here and their absence yields no row. The wording is the engine's: nothing here
 *  composes a sentence, and a row whose `path` or note is not a string is skipped, not guessed at. */
export function doctorRepoNotes(repos: unknown): RepoNote[] {
  if (!Array.isArray(repos)) return [];
  const out: RepoNote[] = [];
  for (const r of repos) {
    if (r === null || typeof r !== "object") continue;
    const { path, notes } = r as { path?: unknown; notes?: unknown };
    if (typeof path !== "string" || !Array.isArray(notes)) continue;
    for (const note of notes) if (typeof note === "string" && note !== "") out.push({ path, note });
  }
  return out;
}
