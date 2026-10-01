<script lang="ts">
  /**
   * B8 (T16) — the first-run wizard: six steps for a stranger with nothing configured.
   *
   * ⚠ THE CONFIG IS WRITTEN ONCE, AT THE END, THROUGH THE VALIDATED PATH. Steps 1–5 build a draft
   * in webview memory and perform NO write of any kind; the one write is the gate into step 6
   * (`config_create`, or `config_save` with the base token when a config already exists —
   * `lib/wizard.ts`'s `savePlan`). Cancelling on any step before that writes NOTHING.
   *
   * ⚠ RE-RUNNING OVER AN EXISTING CONFIG PRE-POPULATES AND DOES NOT CLOBBER. The draft is seeded
   * from `config_read` (`draftFromConfig`), the save is the base-token-guarded EDIT path, unknown
   * fields ride through untouched (`mergeConfig` edits the parsed document in place), and a
   * config that APPEARS mid-wizard (a terminal `daily-briefing init`) is never replaced —
   * `config_create` is exclusive, and its `alreadyExists` refusal (like an edit-path `conflict`)
   * re-reads, RE-SEEDS the draft from what is really there, and requires an explicit
   * acknowledgement before any second write (round 1). A document whose fields cannot be seeded
   * keeps the save gate SHUT (`saveGateBlocker`) — an unseeded draft never reaches a merge.
   *
   * ⚠ STEPS 4 AND 6 ARE THE EXISTING FLOW COMPONENTS, NOT COPIES. `ScheduleAccess.svelte` IS
   * step 4 and `ScheduleInstall.svelte` IS step 6's install (plan R1: "the SAME flow component");
   * the verification is the existing `ScheduleVerify` loop — the install's own engine-side
   * kickstart IS the live test run (T20), no second run path is invented here.
   *
   * ⚠ THIS SCREEN NEVER ASKS FOR OR SETS A KEY VALUE. The native-key path collects a FILE PATH
   * or a COMMAND — the key by reference (`docs/gui-seam.md` :1186-1192); `config_create` refuses
   * a literal key at any spelling. (A user CAN paste a key into the command textarea — nothing
   * stops pasted text — but the app never requests one and the engine never echoes one.)
   *
   * ⚠ EVERY DYNAMIC STRING IS `{}`-INTERPOLATED, NEVER `{@html}` (`docs/gui-seam.md` §5).
   */
  import { onMount } from "svelte";
  import { accessSnapshot, describeAccessFailure, type AccessSnapshot } from "../lib/access";
  import { doctor, type EngineOutcome } from "../lib/engine";
  import {
    configCreate,
    configRead,
    configSave,
    describeFailure,
    type ConfigDocument,
    type FieldNote,
    type SaveOutcome,
  } from "../lib/files";
  import { engineNotifyLine, notifyStatus, NOTIFY_ASK_EXPLANATION, type NotifyStatus } from "../lib/notify";
  import type { ScheduleState } from "../lib/state";
  import type { VerifyEvidence } from "../lib/verify-flow";
  import ScheduleAccess from "../lib/ScheduleAccess.svelte";
  import ScheduleInstall from "../lib/ScheduleInstall.svelte";
  import ScheduleVerify from "../lib/ScheduleVerify.svelte";
  import {
    cancelWritesNothing,
    draftFromConfig,
    draftPaths,
    emptyDraft,
    firstWakeSentence,
    nextStep,
    previousStep,
    saveGateBlocker,
    savePlan,
    stepBlocker,
    PREFILL_API_MODEL,
    ROOT_DESKTOP,
    ROOT_DOCUMENTS,
    ROOT_DOWNLOADS,
    type StepId,
  } from "../lib/wizard";

  interface Props {
    /** ⚠ Named `scheduleState`, not `state` — a `state` prop makes `$state(...)` parse as a
     *  store subscription (`svelte.dev/e/store_rune_conflict`, deviation 91). */
    scheduleState: ScheduleState | null;
    /** The live facts the step-6 verification loop watches — from the pushed `Snapshot`. */
    evidence?: VerifyEvidence;
    /** True while the notification opt-in has never been asked (the explained ask shows). */
    notifyAsk?: boolean;
    notifyAskError?: string | null;
    onnotifychoice?: (enabled: boolean) => void;
    /** Leave without writing (steps 1–5) — the parent routes away; the draft is dropped. */
    oncancel?: () => void;
    /** Done (step 6) — the parent routes to Today. */
    onfinished?: () => void;
  }
  let {
    scheduleState,
    evidence = { skipIso: null, delivered: false },
    notifyAsk = false,
    notifyAskError = null,
    onnotifychoice = () => {},
    oncancel = () => {},
    onfinished = () => {},
  }: Props = $props();

  let step = $state<StepId>("welcome");
  let draft = $state(emptyDraft());
  /** The loaded document — `null` until `config_read` answers. Its `exists` picks create vs edit. */
  let doc = $state<ConfigDocument | null>(null);
  let docError = $state<string | null>(null);
  /** True when the draft was pre-populated from an existing config (the re-run path). */
  let prePopulated = $state(false);
  /** An existing config could not be read into the draft's fields: the save gate stays SHUT —
   *  an empty draft must never fall through to a merge (round 1). */
  let seedFailed = $state(false);
  /** The recovery path ran (`alreadyExists`/`conflict`: the draft was RE-SEEDED from disk) and
   *  the second write needs the explicit acknowledgement below. */
  let recovered = $state(false);
  let recoverAck = $state(false);

  /** Step 4's data: the access snapshot computed over the DRAFT's paths. */
  let access = $state<AccessSnapshot | null>(null);
  let accessError = $state<string | null>(null);
  let accessLoading = $state(false);
  /** Whether step 4 applies at all — darwin AND a protected root reached by the draft. */
  let accessInScope = $state(false);

  /** The save gate's state. */
  let saving = $state(false);
  let saveFailure = $state<string | null>(null);
  let saveErrors = $state<FieldNote[]>([]);
  let saveWarnings = $state<FieldNote[]>([]);
  let saved = $state<SaveOutcome | null>(null);

  /** Step 6: the post-save provider check (`doctor --json`) and the engine-notify line. */
  let providerCheck = $state<EngineOutcome | null>(null);
  let providerCheckError = $state<string | null>(null);
  let notify = $state<NotifyStatus | null>(null);
  /** Arms the verification loop after a SUCCESSFUL install (`armsVerify` gates `onfinished`). */
  let verifyTrigger = $state(0);

  /** Seed the draft from a loaded document — the pre-populate path (onMount) AND the recovery
   *  path (the save catch). A document whose fields cannot be read sets `seedFailed`, which
   *  keeps the save gate shut: the wizard must never merge a draft the user was not shown. */
  function seedFromDocument(next: ConfigDocument): void {
    doc = next;
    docError = null;
    if (!next.exists) {
      seedFailed = false;
      return;
    }
    const seeded = next.text !== null ? draftFromConfig(next.text) : null;
    if (seeded === null) {
      seedFailed = true;
      return;
    }
    draft = seeded;
    prePopulated = true;
    seedFailed = false;
  }

  onMount(() => {
    void configRead()
      .then((next) => seedFromDocument(next))
      .catch((e) => {
        docError = describeFailure(e);
      });
  });

  /** Continue from step 3: compute the draft's protected-root scope, then route past or into
   *  step 4. A failed snapshot is reported and the flow continues to step 5 — the Schedule &
   *  Access panel remains available for existing-config users after the save. */
  async function continueFromRepos(): Promise<void> {
    accessLoading = true;
    accessError = null;
    try {
      const snapshot = await accessSnapshot(draftPaths(draft));
      access = snapshot;
      accessInScope = snapshot.supported && snapshot.roots.length > 0;
    } catch (e) {
      access = null;
      accessInScope = false;
      accessError = describeAccessFailure(e);
    } finally {
      accessLoading = false;
    }
    step = accessInScope ? "access" : "floor";
  }

  async function refreshAccess(): Promise<void> {
    accessLoading = true;
    try {
      access = await accessSnapshot(draftPaths(draft));
      accessError = null;
    } catch (e) {
      accessError = describeAccessFailure(e);
    } finally {
      accessLoading = false;
    }
  }

  /** THE one write — the gate from step 5 into step 6. */
  async function saveAndContinue(): Promise<void> {
    if (saving) return;
    saving = true;
    saveFailure = null;
    saveErrors = [];
    saveWarnings = [];
    try {
      const current = doc ?? { exists: false, text: null, base: null };
      const plan = savePlan(current, draft);
      const outcome =
        plan.kind === "create"
          ? await configCreate(plan.text)
          : await configSave(plan.text, plan.base);
      if (outcome.kind === "invalid") {
        saveErrors = outcome.errors;
        saveWarnings = outcome.warnings;
        return;
      }
      // `saved`, `created` and `unchanged` all proceed to step 6 — explicitly: `unchanged` is a
      // real success (the untouched re-run), and the step-6 copy names which of the three
      // happened. Only `unchanged` and `created` carry no warnings.
      saved = outcome;
      saveWarnings = outcome.kind === "saved" || outcome.kind === "created" ? outcome.warnings : [];
      recovered = false;
      step = "delivery";
      void doctor()
        .then((check) => (providerCheck = check))
        .catch((e) => (providerCheckError = describeFailure(e)));
      void notifyStatus()
        .then((s) => (notify = s))
        .catch(() => {});
    } catch (e) {
      // `alreadyExists` / `conflict`: the file changed under the wizard (a terminal init, an
      // edit). Nothing was replaced — and the refusal's "reload and edit it instead" is now
      // something this component actually DOES (round 1): re-read, RE-SEED the draft from what
      // is really there (so the banner and every step show the real file), and require the
      // explicit acknowledgement below before any second write. The draft as it stood described
      // a FRESH setup; merging it un-reseeded over the just-protected config was the clobber.
      saveFailure = describeFailure(e);
      const kind =
        typeof e === "object" && e !== null && "kind" in e ? String((e as { kind: unknown }).kind) : "";
      if (kind === "alreadyExists" || kind === "conflict") {
        try {
          const next = await configRead();
          seedFromDocument(next);
          recovered = true;
          recoverAck = false;
        } catch {
          /* the failure line above already says what happened */
        }
      }
    } finally {
      saving = false;
    }
  }

  const blocker = $derived(stepBlocker(step, draft));
  const gateBlocker = $derived(
    saveGateBlocker({ seedFailed, recovered, acknowledged: recoverAck }),
  );
  const engineOwner = $derived(scheduleState?.owner ?? null);
</script>

<section class="wizard">
  <header class="head">
    <h2>Set up Daily Briefing</h2>
    <p class="muted">
      {step === "welcome"
        ? "Step 1 of 6 — what this is"
        : step === "provider"
          ? "Step 2 of 6 — who writes the briefing"
          : step === "repos"
            ? "Step 3 of 6 — what it reads"
            : step === "access"
              ? "Step 4 of 6 — macOS folder access"
              : step === "floor"
                ? "Step 5 of 6 — your morning time"
                : "Step 6 of 6 — background delivery"}
    </p>
  </header>

  {#if docError !== null}
    <pre class="bad">{docError}</pre>
  {/if}
  {#if seedFailed}
    <pre class="bad">A configuration already exists{doc !== null ? ` at ${doc.path}` : ""}, but it
could not be read into this wizard's fields. Nothing was changed, and saving from here is
disabled — it could overwrite settings you have never been shown. Edit the file directly, or use
the Settings screen.</pre>
  {/if}
  {#if prePopulated && step !== "delivery"}
    <p class="muted small">
      A config already exists{doc !== null ? ` at ${doc.path}` : ""}. The steps below show what it
      says; finishing saves only what you change, and everything this wizard does not ask about is
      kept as it is.
    </p>
  {/if}

  {#if step === "welcome"}
    <div class="body">
      <p>
        Daily Briefing writes you a short morning briefing about your own repositories — what you
        did, where you left off, and what to pick up next.
      </p>
      <ul>
        <li>
          <strong>Local-first.</strong> Everything runs on this Mac. Your repositories are read
          here, the briefing is written here, and the archive stays here
          {doc !== null ? ` (the configuration this wizard creates lives at ${doc.path})` : ""}.
        </li>
        <li><strong>No telemetry.</strong> Nothing about you or your code is reported anywhere.</li>
        <li>
          <strong>Bring your own AI.</strong> The engine talks to an AI you already have — an
          installed CLI, your own API key, or a local model server. This app never calls a
          provider itself; the next step chooses which one the engine uses.
        </li>
        <li>
          <strong>Nothing happens until the end.</strong> No configuration is written and nothing
          is installed until you confirm at the last step; the folder-access step asks macOS for
          permission only when you press its button. Cancelling now changes nothing.
        </li>
      </ul>
    </div>
  {:else if step === "provider"}
    <div class="body">
      <p>
        The engine needs a way to reach a language model. Every option below is a CLI or an
        endpoint the <strong>engine</strong> talks to when it generates your briefing — this app
        never calls a provider itself.
      </p>
      <label class="choice">
        <input type="radio" name="provider-path" checked={draft.providerPath === "cli"}
          onchange={() => (draft.providerPath = "cli")} />
        <span>
          <strong>An installed CLI (recommended).</strong> Uses a coding CLI you already have and
          its existing login — no key to manage.
        </span>
      </label>
      {#if draft.providerPath === "cli"}
        <div class="indent">
          <label class="choice">
            <input type="radio" name="cli" checked={draft.cli === "claude"}
              onchange={() => (draft.cli = "claude")} />
            <span><code>claude</code> — the default the engine's own setup picks first</span>
          </label>
          <label class="choice">
            <input type="radio" name="cli" checked={draft.cli === "codex"}
              onchange={() => (draft.cli = "codex")} />
            <span><code>codex</code></span>
          </label>
          <p class="muted small">
            Whether the CLI is actually installed is checked by the engine once the configuration
            is written — the last step runs its health check and shows what it found.
          </p>
        </div>
      {/if}
      <label class="choice">
        <input type="radio" name="provider-path" checked={draft.providerPath === "api"}
          onchange={() => (draft.providerPath = "api")} />
        <span>
          <strong>An Anthropic API key.</strong> The engine calls the API directly — billed to
          your key, no CLI needed.
        </span>
      </label>
      {#if draft.providerPath === "api"}
        <div class="indent">
          <label class="field">
            <span>Model</span>
            <input type="text" value={draft.apiModel}
              oninput={(e) => (draft.apiModel = e.currentTarget.value)} />
          </label>
          <label class="choice">
            <input type="checkbox" checked={draft.apiModelConfirmed}
              onchange={(e) => (draft.apiModelConfirmed = e.currentTarget.checked)} />
            <span>
              Use this model. <span class="muted">{PREFILL_API_MODEL} is prefilled, not chosen
              for you — the model decides what your briefing costs and reads like.</span>
            </span>
          </label>
          <p class="muted small">
            Your key is never typed into this app and never stored by it. Point the engine at
            where the key lives — a file only you can read, or a command that prints it (a
            keychain helper, say). An environment variable will not work here: neither this app
            nor the background scheduler passes your shell's environment to the engine.
          </p>
          <label class="field">
            <span>Key file (e.g. ~/.config/daily-briefing/anthropic-key — chmod 600)</span>
            <input type="text" value={draft.apiKeyFile}
              oninput={(e) => (draft.apiKeyFile = e.currentTarget.value)} />
          </label>
          <label class="field">
            <span>…or a command that prints the key (one argument per line)</span>
            <textarea rows="2" value={draft.apiKeyCommand}
              oninput={(e) => (draft.apiKeyCommand = e.currentTarget.value)}></textarea>
          </label>
        </div>
      {/if}
      <label class="choice">
        <input type="radio" name="provider-path" checked={draft.providerPath === "local"}
          onchange={() => (draft.providerPath = "local")} />
        <span>
          <strong>A local model server.</strong> Ollama, LM Studio, vLLM — an OpenAI-compatible
          endpoint on this machine. Nothing leaves your Mac.
        </span>
      </label>
      {#if draft.providerPath === "local"}
        <div class="indent">
          <label class="field">
            <span>Endpoint URL (for Ollama: http://127.0.0.1:11434/v1)</span>
            <input type="text" value={draft.localBaseUrl}
              oninput={(e) => (draft.localBaseUrl = e.currentTarget.value)} />
          </label>
          <label class="field">
            <span>Model</span>
            <input type="text" value={draft.localModel}
              oninput={(e) => (draft.localModel = e.currentTarget.value)} />
          </label>
          <p class="muted small">
            Two settings are prefilled for a local model: a longer per-call timeout (a local model
            can take minutes where a hosted one takes seconds), and the morning internet check is
            turned off (networkProbeHosts: []) — your briefing needs no internet when the model
            runs on this machine.
          </p>
        </div>
      {/if}
    </div>
  {:else if step === "repos"}
    <div class="body">
      <p>
        The briefing is built from your git repositories. Choose where the engine looks for them —
        it scans the folders below (two levels deep) on every run, so new repositories are picked
        up on their own.
      </p>
      <label class="choice">
        <input type="checkbox" checked={draft.rootHome}
          onchange={(e) => (draft.rootHome = e.currentTarget.checked)} />
        <span>
          <strong>Home folder (~)</strong> — what the engine's own setup uses.
          <span class="muted">The scan looks inside every non-hidden folder, including Desktop,
          Documents and Downloads — macOS may ask about those the first time. Untick this and
          list folders yourself to keep the scan narrow.</span>
        </span>
      </label>
      <p class="muted small">
        These three are macOS-protected and start UNTICKED on purpose: nothing should trigger a
        permission dialog you did not choose. Tick one only if your repositories live there —
        the next step then walks you through the grant.
      </p>
      <label class="choice">
        <input type="checkbox" checked={draft.rootDesktop}
          onchange={(e) => (draft.rootDesktop = e.currentTarget.checked)} />
        <span>{ROOT_DESKTOP}</span>
      </label>
      <label class="choice">
        <input type="checkbox" checked={draft.rootDocuments}
          onchange={(e) => (draft.rootDocuments = e.currentTarget.checked)} />
        <span>{ROOT_DOCUMENTS}</span>
      </label>
      <label class="choice">
        <input type="checkbox" checked={draft.rootDownloads}
          onchange={(e) => (draft.rootDownloads = e.currentTarget.checked)} />
        <span>{ROOT_DOWNLOADS}</span>
      </label>
      <label class="field">
        <span>Other folders to scan (one per line, e.g. ~/dev)</span>
        <textarea rows="2" value={draft.customRoots}
          oninput={(e) => (draft.customRoots = e.currentTarget.value)}></textarea>
      </label>
      <label class="field">
        <span>Or list repositories directly (one per line — scanning is then skipped)</span>
        <textarea rows="2" value={draft.explicitRepos}
          oninput={(e) => (draft.explicitRepos = e.currentTarget.value)}></textarea>
      </label>
      <label class="field">
        <span>Repositories to leave out (one per line — a full path, or just a folder name like
          an old work checkout)</span>
        <textarea rows="2" value={draft.excludeRepos}
          oninput={(e) => (draft.excludeRepos = e.currentTarget.value)}></textarea>
      </label>
      <p class="muted small">
        The last step shows what the engine actually finds; anything noisy can be excluded later
        on the Settings screen.
      </p>
    </div>
  {:else if step === "access"}
    <div class="body">
      <p>
        Some folders you chose are ones macOS protects. The engine cannot read them — and your
        briefing is quietly thinner — until access is granted. This is the same panel the
        Schedule screen carries, so you can redo any of it later.
      </p>
      <ScheduleAccess snapshot={access} error={accessError} onrefresh={refreshAccess}
        refreshing={accessLoading} />
      <p class="muted small">
        The second check names a background engine copy — that copy exists only after the last
        step installs background delivery. Come back to the Schedule screen afterwards if it is
        not listed yet.
      </p>
    </div>
  {:else if step === "floor"}
    <div class="body">
      <p>
        When should your briefing be ready? This is the <strong>earliest</strong> time, not an
        exact one.
      </p>
      <label class="field narrow">
        <span>Earliest time (24-hour HH:MM)</span>
        <input type="text" value={draft.floor}
          oninput={(e) => (draft.floor = e.currentTarget.value)} />
      </label>
      <p class="first-wake">{firstWakeSentence(draft.floor)}</p>
      <p class="muted small">
        The background check runs every ten minutes while your Mac is awake. A closed laptop
        generates nothing — the briefing arrives shortly after the first wake past this time.
      </p>
    </div>
  {:else}
    <div class="body">
      {#if saved !== null}
        <p class="ok">
          {saved.kind === "created"
            ? "Your configuration was created"
            : saved.kind === "saved"
              ? "Your configuration was saved"
              : "Your configuration is unchanged"}{doc !== null ? ` at ${doc.path}` : ""}.
        </p>
      {/if}
      {#each saveWarnings as warning (warning.field + warning.message)}
        <p class="warn-text">{warning.field !== "" ? `${warning.field}: ` : ""}{warning.message}</p>
      {/each}

      <div class="block">
        <h3>Provider check</h3>
        {#if providerCheckError !== null}
          <pre class="bad">{providerCheckError}</pre>
        {:else if providerCheck === null}
          <p class="muted">Asking the engine…</p>
        {:else}
          {@const payload = providerCheck.payload as {
            provider?: { cli?: string; found?: boolean; path?: string | null;
              anomalies?: string[]; notes?: string[] };
            discoveredCount?: number; reposTimedOut?: boolean; verdict?: string;
          } | null}
          {#if payload?.provider !== undefined}
            <p>
              {payload.provider.found
                ? `The engine can reach your provider (${payload.provider.cli ?? ""}${payload.provider.path ? ` at ${payload.provider.path}` : ""}).`
                : `The engine could NOT find your provider (${payload.provider.cli ?? ""}). The briefing will fail until it is installed or the Settings screen points at it.`}
            </p>
            {#each payload.provider.anomalies ?? [] as anomaly (anomaly)}
              <p class="warn-text">{anomaly}</p>
            {/each}
            {#each payload.provider.notes ?? [] as note (note)}
              <p class="muted small">{note}</p>
            {/each}
            <p class="muted small">
              {payload.reposTimedOut
                ? "The repository scan ran out of time; the count is incomplete."
                : `Repositories found by scanning: ${payload.discoveredCount ?? 0}.`}
              {payload.verdict !== undefined ? ` Engine verdict: ${payload.verdict}.` : ""}
            </p>
          {:else}
            <p class="muted">The engine's health check did not include a provider report.</p>
          {/if}
        {/if}
      </div>

      <div class="block">
        <h3>Background delivery</h3>
        <p>
          This installs the scheduler that generates your briefing every morning without the app
          being open. Installing runs a first check right away — that live run is the test that
          the delivery path works.
        </p>
        <ScheduleInstall
          label="Install background delivery"
          purpose="install the background scheduler"
          owner={engineOwner}
          onfinished={() => (verifyTrigger += 1)}
        />
        {#if engineOwner === "cli"}
          <p class="muted small">
            A command-line install already owns the schedule. Keeping it is fine — this app then
            shows its state without changing it, and whether a notification comes from the engine
            depends on the engine's own notification setting{notify !== null
              ? ` — ${engineNotifyLine(notify.engine)}`
              : "."}
          </p>
        {/if}
        <ScheduleVerify {evidence} trigger={verifyTrigger} />
      </div>

      {#if notifyAsk}
        <div class="block notify-ask">
          <p>{NOTIFY_ASK_EXPLANATION}</p>
          <div class="buttons">
            <button type="button" onclick={() => onnotifychoice(true)}>Enable notifications</button>
            <button type="button" onclick={() => onnotifychoice(false)}>Not now</button>
          </div>
          {#if notifyAskError !== null}
            <p class="bad">Your choice could not be recorded: {notifyAskError}</p>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if blocker !== null}
    <p class="muted small">{blocker}</p>
  {/if}
  {#if saveFailure !== null && step === "floor"}
    <pre class="bad">{saveFailure}</pre>
  {/if}
  {#if recovered && step === "floor"}
    <div class="block">
      <p>
        A configuration appeared on disk while you were setting up — nothing was replaced. The
        steps now show what that file says; what you had entered here was set aside so your next
        save edits the real file and keeps everything it does not change.
      </p>
      <label class="choice">
        <input type="checkbox" checked={recoverAck}
          onchange={(e) => (recoverAck = e.currentTarget.checked)} />
        <span>Continue with the loaded configuration — I have looked over the steps again.</span>
      </label>
    </div>
  {/if}
  {#if gateBlocker !== null && step === "floor"}
    <p class="muted small">{gateBlocker}</p>
  {/if}
  {#each saveErrors as error (error.field + error.message)}
    <pre class="bad">{error.field !== "" ? `${error.field}: ` : ""}{error.message}</pre>
  {/each}

  <div class="nav-row">
    {#if cancelWritesNothing(step)}
      <button class="quiet" onclick={() => oncancel()}>Set up later</button>
    {/if}
    {#if step !== "welcome" && step !== "delivery"}
      <button class="quiet" onclick={() => (step = previousStep(step, accessInScope) ?? "welcome")}>
        Back
      </button>
    {/if}
    {#if step === "repos"}
      <button disabled={blocker !== null || accessLoading} onclick={() => void continueFromRepos()}>
        {accessLoading ? "Checking folders…" : "Continue"}
      </button>
    {:else if step === "floor"}
      <button disabled={blocker !== null || gateBlocker !== null || saving}
        onclick={() => void saveAndContinue()}>
        {saving
          ? "Saving…"
          : doc !== null && doc.exists
            ? "Save configuration & continue"
            : "Create configuration & continue"}
      </button>
    {:else if step === "delivery"}
      <button onclick={() => onfinished()}>Finish</button>
    {:else}
      <button disabled={blocker !== null}
        onclick={() => (step = nextStep(step, accessInScope) ?? step)}>
        Continue
      </button>
    {/if}
  </div>
</section>

<style>
  .wizard {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    max-width: 44rem;
  }
  .head h2 {
    margin: 0;
    font-size: 1.2rem;
  }
  .head p {
    margin: 0.2rem 0 0;
  }
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
  }
  .body p,
  .body ul {
    margin: 0;
  }
  .body ul {
    padding-left: 1.2rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .block {
    border: 1px solid var(--line);
    border-radius: 0.5rem;
    padding: 0.9rem 1rem;
    background: var(--panel);
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .block h3 {
    margin: 0;
    font-size: 1rem;
  }
  .choice {
    display: flex;
    gap: 0.6rem;
    align-items: flex-start;
  }
  .choice input {
    margin-top: 0.25rem;
  }
  .indent {
    margin-left: 1.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .field span {
    font-size: 0.85rem;
    color: var(--muted);
  }
  .field input,
  .field textarea {
    font: inherit;
    padding: 0.4rem 0.6rem;
    border-radius: 0.4rem;
    border: 1px solid var(--line);
    background: transparent;
    color: inherit;
  }
  .field.narrow input {
    max-width: 8rem;
  }
  .first-wake {
    font-weight: 600;
  }
  .nav-row,
  .buttons {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  button {
    font: inherit;
    padding: 0.5rem 1rem;
    border-radius: 0.5rem;
    border: 1px solid var(--line);
    background: var(--accent);
    color: var(--on-accent);
    cursor: pointer;
  }
  button.quiet,
  .buttons button {
    background: var(--panel);
    color: inherit;
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 0.85rem;
  }
  .ok {
    color: var(--muted);
  }
  .warn-text {
    color: var(--danger);
  }
  pre {
    margin: 0;
    padding: 0.6rem 0.8rem;
    border-radius: 0.4rem;
    border: 1px solid var(--line);
    white-space: pre-wrap;
    font-size: 0.82rem;
  }
  pre.bad,
  p.bad {
    border-color: var(--danger);
    color: var(--danger);
  }
  p.bad {
    margin: 0;
  }
  .notify-ask {
    border-color: var(--accent);
  }
</style>
