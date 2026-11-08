/**
 * P3-M4-T2 — Add and remove with keys (spec r9 §6 "Add, replace, remove"; plan P3-M4-T2). The steps between the
 * Providers screen's buttons and the engine's `provider` verbs; `routes/Settings.svelte` holds the state and the one
 * save path (`submit`: the save gate, then `configSave`).
 *
 *  • ADD = `key set` → a candidate with the answered reference → `config validate` → `provider test` of the new entry
 *    (its row's `testTimeoutMs`, unchanged: `testPlan` → `testModeFor`) → Save on a pass; after a failed Test, Save
 *    anyway (the Test ran — requirement 6) or Discard (`key delete` of the unused id). A Test that did not run (a second
 *    Test is `busy`, the engine refused) offers Test again instead of Save anyway. The keyless candidate is validated
 *    BEFORE `key set`, so an add the engine refuses anyway stores no key.
 *  • ADD WITH NO KEY PASTED (follow-up 4, user decision 2026-10-19): only an entry the ENGINE says needs no key goes
 *    on — the keyless candidate's `config validate` row for the new entry must say `keyOptional: true` (the engine's one
 *    no-key rule, src/providers/endpoint.ts `keyOptional`: an OpenAI-compatible model on this computer). The app reads
 *    neither the kind nor the address for it. Then no `key set`: the add is Tested keyless and waits with no key, as a
 *    login does, so Discard has nothing to delete. Anything else (a row saying `false` or not a boolean, no row, a
 *    failed check) is refused, saying why (the row's `loopback` chooses only the wording). An OpenAI-compatible entry
 *    with NO address and no key is asked for its address first (an Anthropic one, for its key: no address is
 *    Anthropic's own endpoint) — a presence check of the form's input, its kind choosing only the wording. A key
 *    pasted is always stored, whatever the row says.
 *  • ⚠ THE PASTED KEY GOES TO `providerKeySet` AND NOWHERE ELSE: never into a candidate text (the candidate carries the
 *    reference `key set` answered), never into a line, a log, a thrown error or anything returned. It is a parameter of
 *    `startAdd`, handed straight to `providerKeySet` and dropped.
 *  • A `key set` REFUSAL THAT NAMES A `keyId` (its cleanup unconfirmed, gui-seam §1d) → `key delete --id` it, once.
 *  • SWITCHING AN ENTRY TO A PASTED KEY REMOVES ITS OTHER KEY SOURCES (`withPastedKey`): `apiKeyEnv`, `apiKeyFile`,
 *    `apiKeyCommand`, `apiKey` — they outrank in that order (`src/apiKey.ts`), so one left beside the new reference
 *    could be the key actually read. (Not `key migrate`'s save — P3-M4-T4 keeps the user's own outranking sources.)
 *  • APP-OWNED KEYS NEED `https:` OFF THIS MACHINE. The engine's `config validate` errors on an app-owned key over a
 *    non-loopback `http:` endpoint; ON PASTE that refusal is shown and the pasted key removed, and ON EVERY LATER SAVE
 *    the save path's own engine validation refuses it (errors block). Nothing here decides from a URL: loopback is the
 *    engine's. The one URL read is WORDING ONLY — `httpBlock` reads a saved block's scheme to choose how a reason-less
 *    `key migrate` refusal is worded, and that line still covers a loopback `http:` address (`MIGRATE_HTTP_LINE`).
 *    (`startAdd`'s no-key check reads only WHETHER an address was given, never what it is.)
 *  • REMOVE = save without the entry, THEN `key delete` only when no remaining entry references its id (a delete
 *    refused `busy` is retried by `lib/unused-key.ts`'s `deleteCleared`, after checking the saved settings again). The
 *    removed entry's id and every remaining reference are the engine's `config validate` rows (`appKeyId`), never a match on
 *    reference strings; a remaining row with `appOwnedKey` and no `appKeyId` may read ANY app key, so the key is kept
 *    and that is said; so it is when the rows cannot vouch for every entry. A key in doubt is kept: a stray Keychain
 *    item costs nothing, a deleted one in use skips a briefing. The order (saved rows → save → new rows → delete) is
 *    `saveRemovingKeys`'s, the one place it is decided.
 *  • DISCARD RE-CHECKS THE SAVED SETTINGS (checkpoint P3-M4-T2): before `key delete` of a pending add's id, the CURRENT
 *    config is re-read (`configRead`) and validated; the key is kept when any saved row carries that id, or when the
 *    rows cannot vouch for every entry — the same rule as Remove's. That rule is `lib/unused-key.ts`'s
 *    `removeIfUnused`, shared with the first-time wizard (checkpoint P3-M6); Settings passes `"keep"` for no config.
 *  • LEAVING THE SCREEN (`leaveAdd`, `orphanAfter`): a waiting add's key is removed; an add whose `key set` or Save is
 *    still running is left to that step, which removes the key when it ends unless its save landed.
 *
 * Every function answers in lines for the screen and never throws for an engine answer or an IPC rejection — except
 * `saveRemovingKeys`, which rethrows its caller's `save` (the caller's own error path words it; nothing is deleted).
 */
import { stripControl } from "./briefing-struct";
import {
  providerCandidateCheck,
  providerKeyMigrate,
  providerKeyScrubBackup,
  providerKeySet,
  providerPendingResetAdd,
  providerPendingResetDrop,
  providerPendingResetFlush,
  type AppKeyReference,
  type PendingAddOutcome,
  type PendingDropOutcome,
  type PendingFlushOutcome,
  type ProviderRefusal,
  type ProviderValidateRow,
} from "./engine";
import { EDIT_AS_JSON, describeFailure } from "./files";
import type { Os } from "./platform";
import {
  insertEntry,
  isClaudeCli,
  isObject,
  KEY_SOURCES,
  plain,
  readProviderList,
  setEntrySettings,
  writeProviderList,
  type ProviderEntry,
} from "./provider-list";
import {
  applyNetworkAnswer,
  formSubmission,
  keyStoreName,
  keyTimeoutLine,
  migrateBlockedBy,
  migrateSlot,
  networkAskNeeded,
  parseDraft,
  rawFromDraft,
  REMOVE_LITERAL_BUTTON,
  testFailureLine,
  testPlan,
  testResultLines,
  TOOL_PRESETS,
  API_SERVICES,
  type ApiService,
  type ApiServiceId,
  type Draft,
  type ToolChoice,
} from "./settings-model";
import {
  DELETE_RETRY,
  deleteCleared,
  deleteKey,
  KEY_LEFT_FOR_UNINSTALL,
  keySetRefusalLine,
  labelsOf,
  malformedRow,
  referenceIn,
  removeIfUnused,
  timedOut,
  validated,
  vouchingRows,
  type DeleteRetry,
  type UnusedOutcome,
} from "./unused-key";

type Json = Record<string, unknown>;

const quoted = (label: string): string => `"${stripControl(label)}"`;

/** Every way an `api` block names its key, in the order they outrank — defined once, in `provider-list.ts`. */
export { KEY_SOURCES };

/** `block` (an API provider block) with every key source removed. */
function withoutKeySources(block: Json): Json {
  const out = plain(block);
  const api = out["api"];
  if (isObject(api)) for (const k of KEY_SOURCES) delete api[k];
  return out;
}

/** `block` switched to the pasted key's reference (`key set`'s answer, saved exactly as answered): every other key
 *  source removed. Neither input is changed. Throws for a block with no `api` (a command-line tool takes no key). */
export function withPastedKey(block: Json, ref: AppKeyReference): Json {
  const out = withoutKeySources(block);
  const api = out["api"];
  if (!isObject(api)) throw new Error("a command-line provider takes no API key");
  if ("apiKeyCommand" in ref) api["apiKeyCommand"] = [...ref.apiKeyCommand];
  else api["apiKeyFile"] = ref.apiKeyFile;
  return out;
}

/* ── the add form ── */

export type AddKind = "anthropic" | "openai-compatible" | "cli" | "login";

/** The add form's fields, as typed. `tool`, `command` and `args` are the command-line kind's (user-directed
 *  2026-10-22, P1): a named tool (`TOOL_PRESETS`; absent reads as the first, Claude Code), or "other" with its command
 *  and its arguments, one per line. */
export interface AddForm {
  kind: AddKind;
  label: string;
  model: string;
  baseUrl: string;
  configDir: string;
  tool?: ToolChoice;
  command?: string;
  args?: string;
}

/** P-Add (user-directed 2026-10-22): the guided Add's three choices, in place of the Kind dropdown. */
export type AddChoice = "subscription" | "api" | "login";

/** What the guided Add's inputs hold, as typed. Each choice reads only its own (so switching keeps the others). */
export interface GuidedInputs {
  label: string;
  tool: ToolChoice;
  command: string;
  args: string;
  service: ApiServiceId;
  model: string;
  /** "Other OpenAI-compatible service"'s Address, the only one typed. */
  address: string;
  configDir: string;
}

/** The service the API choice names (an unknown id reads as the first, Anthropic). */
export const serviceOf = (id: ApiServiceId): ApiService => API_SERVICES.find((s) => s.id === id) ?? API_SERVICES[0]!;

/** P-Add: the add form the guided choice describes — the same `AddForm` the Kind dropdown made, so the flow behind it
 *  (`addRequestFrom`, `startAdd`) is unchanged. An API service fills in its address (`API_SERVICES`); "Other" uses the
 *  typed one; Anthropic none (its own endpoint). */
export function guidedForm(choice: AddChoice, v: GuidedInputs): AddForm {
  if (choice === "subscription") return { kind: "cli", label: v.label, model: "", baseUrl: "", configDir: "", tool: v.tool, command: v.command, args: v.args };
  if (choice === "login") return { kind: "login", label: v.label, model: "", baseUrl: "", configDir: v.configDir };
  const s = serviceOf(v.service);
  return { kind: s.kind, label: v.label, model: v.model, baseUrl: s.id === "other" ? v.address : (s.baseUrl ?? ""), configDir: "" };
}

/** Whether the guided Add draws the API key field: an API service that is not a keyless local one. */
export const guidedTakesKey = (choice: AddChoice, service: ApiServiceId): boolean => choice === "api" && !serviceOf(service).keyless;

/** What to add: a new entry's label (fixed from here on), its provider block and, for a login, its login folder. */
export interface AddRequest {
  label: string;
  block: Json;
  configDir?: string;
}

/** The entry another login copies: the list's first command-line entry, when its tool is Claude (`isClaudeCli`) —
 *  else `null`, and no login is offered. The engine refuses a login folder on any other tool ("`configDir` applies to a
 *  Claude CLI entry only"), so offering it could only fail. */
export function loginSource(draft: Draft): ProviderEntry | null {
  const read = readProviderList(plain(draft));
  const cli = read.ok ? read.entries.find((e) => !isObject(e.block["api"])) : undefined;
  return cli !== undefined && isClaudeCli(cli.block) ? cli : null;
}

/** The command-line kind's block (P1): a named tool's `TOOL_PRESETS` values, or the command and its arguments as typed
 *  — one argument per line, so one with a space in it stays one. The prompt goes on standard input, the engine's own
 *  default (`init`). Never a login folder: the engine drops one on a non-Claude entry, and another Claude login is the
 *  login kind's. */
function toolBlock(form: AddForm): { block: Json } | { error: string } {
  const tool = form.tool ?? TOOL_PRESETS[0].id;
  const preset = TOOL_PRESETS.find((t) => t.id === tool);
  if (preset !== undefined) return { block: { cli: preset.cli, argv: [...preset.argv], promptVia: preset.promptVia } };
  const cli = (form.command ?? "").trim();
  if (cli === "") return { error: "Name the command to run: its name if it is on your PATH, or its full path." };
  const argv = (form.args ?? "").split("\n").map((a) => a.trim()).filter((a) => a !== "");
  return { block: { cli, argv, promptVia: "stdin" } };
}

/** Why a new Claude command-line entry would be the same login as one already in the list, or `null`. The engine drops
 *  such a fallback ("the same Claude login (directory and credential) as an earlier entry", `src/providerList.ts`
 *  `loginKey`): two Claude entries with no login folder of their own share one, whatever directory the process
 *  inherits, when their credential is the same (absent is "subscription"). An entry whose login folder may resolve to
 *  that same directory is left to the engine's own check (`config validate`, on Add and test): the app cannot see the
 *  environment it reads. */
function sameLoginAs(draft: Draft, block: Json): string | null {
  if (!isClaudeCli(block)) return null;
  const read = readProviderList(plain(draft));
  if (!read.ok) return null;
  const credential = (b: Readonly<Json>): unknown => b["credential"] ?? "subscription";
  const twin = read.entries.find((e) => isClaudeCli(e.block) && e.configDir === undefined && credential(e.block) === credential(block));
  if (twin === undefined) return null;
  const source = loginSource(draft);
  return (
    `This would be the same Claude login as ${quoted(twin.label)} (the same login folder and credential), so the briefing could not fall back from one to the other.` +
    // Round 9 (L1): the guided Add's own name for that choice.
    (source === null ? "" : ` To add another Claude login, choose "Another Claude account" and give it a login folder of its own.`)
  );
}

/**
 * The entry the form describes: an API provider (its kind, model and optional endpoint — the key is pasted separately),
 * a command-line tool (`toolBlock`; refused when it would be the same Claude login as an entry already listed,
 * `sameLoginAs`), or another login of the list's first command-line tool when it is Claude (`loginSource`: that entry's
 * block, with a login folder of its own). Only what an input needs before anything runs is checked here; whether the
 * entry WORKS is the engine's (`config validate`, then the Test).
 */
export function addRequestFrom(draft: Draft, form: AddForm): AddRequest | { error: string } {
  const label = form.label.trim();
  if (label === "") return { error: "Give the provider a name: it identifies it in the list and in reports." };
  if (form.kind === "login") {
    const cli = loginSource(draft);
    if (cli === null) return { error: "There is no Claude command-line provider in the list to add another login of." };
    const configDir = form.configDir.trim();
    if (configDir === "") return { error: "Another login needs a login folder of its own." };
    return { label, block: plain(cli.block as Json), configDir };
  }
  if (form.kind === "cli") {
    const tool = toolBlock(form);
    if ("error" in tool) return tool;
    const same = sameLoginAs(draft, tool.block);
    return same === null ? { label, block: tool.block } : { error: same };
  }
  const model = form.model.trim();
  if (model === "") return { error: "Name the model this provider should use." };
  const baseUrl = form.baseUrl.trim();
  return { label, block: { api: { kind: form.kind, model, ...(baseUrl !== "" ? { baseUrl } : {}) } } };
}

/* ── the candidate, checked and tested ── */

/** `draft` with the new entry appended, as the list writer writes it, and the entry's `--index`. */
function candidateWith(draft: Draft, req: AddRequest, block: Json): { ok: true; text: string; index: number } | { ok: false; message: string } {
  const config = plain(draft);
  const read = readProviderList(config);
  if (!read.ok) return { ok: false, message: `Not added: the list of providers in the settings could not be read. Fix it with ${EDIT_AS_JSON}.` };
  let next: ProviderEntry[];
  try {
    next = insertEntry(read.entries, read.entries.length, { label: req.label, block, ...(req.configDir !== undefined ? { configDir: req.configDir } : {}) });
  } catch (e) {
    return { ok: false, message: `Not added: ${describeFailure(e)}` };
  }
  const written = writeProviderList(config, next);
  if (!written.ok) return { ok: false, message: "Not added: the list of providers could not take this entry." };
  return { ok: true, text: rawFromDraft(written.config), index: read.entries.length };
}

type Tested =
  | { kind: "refused"; message: string }
  | { kind: "tested"; ran: boolean; passed: boolean; lines: string[]; rows: ProviderValidateRow[] };

/** Validate `text` (unless `given` is that text's validation already), then Test its entry `index` with that entry's
 *  own row. `ran`: the engine ran the Test and answered it (a pass or a failure), which is what Save anyway rests on. */
async function validateThenTest(text: string, index: number, given?: Awaited<ReturnType<typeof validated>>): Promise<Tested> {
  const v = given ?? (await validated(text));
  if (!v.ok) return { kind: "refused", message: v.message };
  const plan = testPlan(v.check, index);
  if (plan.kind === "refuse") return { kind: "refused", message: plan.message.replace(/^Not tested: /, "") };
  try {
    const t = await providerCandidateCheck(text, plan.mode);
    const ran = t.kind === "tested" && t.answer.ok === true;
    const passed = ran && t.kind === "tested" && t.answer.ok === true && t.answer.passed;
    return { kind: "tested", ran, passed, lines: testResultLines(t), rows: v.rows };
  } catch (e) {
    return { kind: "tested", ran: false, passed: false, lines: [testFailureLine(e)], rows: v.rows };
  }
}

/* ── the key ── */

/** Where a key can come from instead, in Settings, on a platform that cannot keep a pasted one — Windows, the one
 *  `unsupported-platform` (`src/keyStore.ts`). Not a key file: those need POSIX owners and modes, which Windows lacks
 *  (docs/PROVIDERS.md, "Windows"); not an environment variable: the app passes none to the engine. */
const PASTE_UNSUPPORTED_INSTEAD = `Give this provider a command that prints the key (apiKeyCommand) with ${EDIT_AS_JSON} instead.`;

/** Remove a key this add stored and will not use. */
async function removeUnused(id: string, os: Os): Promise<string[]> {
  const why = await deleteKey(id, os);
  return [why === null ? "The key you pasted was removed again." : `The key you pasted could not be removed (${why}); ${KEY_LEFT_FOR_UNINSTALL}.`];
}

/** `key set`, worded. The key is this call's argument and is handed to `providerKeySet` only. `unused` removes a key
 *  this call stored and will not use (Add: `key delete`; Replace: the pending-reset store's `drop`). */
async function storeKey(
  key: string,
  os: Os,
  unused: (id: string) => Promise<string[]> = (id) => removeUnused(id, os),
): Promise<{ ok: true; keyId: string; ref: AppKeyReference } | { ok: false; lines: string[] }> {
  let payload;
  try {
    payload = (await providerKeySet(key)).payload;
  } catch (e) {
    if (timedOut(e)) return { ok: false, lines: [`Not added: storing the key did not finish in time — ${keyTimeoutLine(os)}.`] };
    const field = isObject(e) && e["kind"] === "invalidInput" ? "the key is empty or too long" : null;
    return { ok: false, lines: [`Not added: ${field ?? describeFailure(e)}.`] };
  }
  if (payload === null) return { ok: false, lines: ["Not added: the engine stopped before replying, so the key may or may not have been stored."] };
  if (payload.ok !== true) {
    const lines = [keySetRefusalLine(payload, os, "added", PASTE_UNSUPPORTED_INSTEAD)];
    // Cleanup unconfirmed (gui-seam §1d): retry the delete of exactly that id.
    if (typeof payload.keyId === "string") lines.push(...(await unused(payload.keyId)));
    return { ok: false, lines };
  }
  const ref = referenceIn(payload);
  if (ref === null) return { ok: false, lines: ["Not added: the engine's answer named no key reference.", ...(await unused(payload.keyId))] };
  return { ok: true, keyId: payload.keyId, ref };
}

/* ── Add ── */

/** An add waiting for Save, Save anyway, Test again or Discard. Holds no key: `keyId` and `ref` are what `key set`
 *  answered (not secrets); `text` is the candidate that was tested; `rows` its `config validate` rows. */
export interface PendingAdd {
  readonly label: string;
  /** The block without its key, and the login folder: what Test again rebuilds the candidate from. */
  readonly block: Json;
  readonly configDir?: string;
  /** `null` for an entry that takes no key: a command-line login, or a local model added keyless (`startAdd`). */
  readonly keyId: string | null;
  readonly ref: AppKeyReference | null;
  readonly text: string;
  readonly index: number;
  /** The Test ran and answered: a failure then offers Save anyway. */
  readonly ran: boolean;
  readonly passed: boolean;
  readonly rows: readonly ProviderValidateRow[];
}

export type AddStep = { kind: "refused"; lines: string[] } | { kind: "tested"; pending: PendingAdd; lines: string[] };

/** What the screen draws for an add in progress (`ProvidersList.svelte`). */
export interface AddView {
  busy: boolean;
  /** The form's own Save is running (`Settings.svelte`'s `saving`): the add's Save waits for it (`pendingSaveLive`). */
  saving: boolean;
  lines: readonly string[];
  /** `null`: nothing waiting (the add was refused, or it is running). */
  pending: { passed: boolean; ran: boolean } | null;
}

/** `ProvidersList.svelte`'s add props, passed through `SettingsForm.svelte` as one value. */
export interface AddHandlers {
  /** Run the add flow; answers AT ONCE whether it was taken (PR 3 final r5, A3): `false` when the request is refused
   *  (`addRequestFrom`) or another step runs — the form then keeps what was typed, the pasted key included. */
  onadd: (form: AddForm, key: string) => boolean;
  adding: AddView | null;
  /** The label (as drawn) of the entry another login would copy — `loginSource` — or `null`: no login offered. */
  loginOf: string | null;
  onaddsave: () => void;
  onaddretest: () => void;
  onadddiscard: () => void;
  onaddclose: () => void;
}

const refused = (...lines: string[]): AddStep => ({ kind: "refused", lines });

/** No key pasted, and the entry is not one the engine runs without a key (`startAdd`). */
const NO_KEY = "Not added: paste the provider's API key";
const ONLY_LOCAL = "only an OpenAI-compatible model on this computer can be added without one";
/** No address and no key, for an OpenAI-compatible entry: the address is asked for first (a form-input presence check,
 *  `startAdd`). An Anthropic entry with no address is Anthropic's own endpoint, so it is asked for its key instead. */
const NO_ADDRESS_LINE = `${NO_KEY}, or, for an OpenAI-compatible model on this computer, give the address it runs at (for example http://127.0.0.1:11434/v1).`;
/** The row says `keyOptional: false` and `loopback: true` (on this computer, but of a kind that needs a key), or an
 *  Anthropic entry has no address and no key. */
const NO_KEY_LINE = `${NO_KEY} (${ONLY_LOCAL}).`;
const NO_KEY_REMOTE_LINE = `${NO_KEY}: its address is not on this computer, and ${ONLY_LOCAL}.`;
const NO_KEY_UNCHECKED_LINE = `${NO_KEY}: the engine did not say whether this provider needs one.`;

/**
 * Add `req` to the end of `draft`'s list: for an API provider with the pasted `key` (stored by `key set`, the entry
 * saved with its reference); for a command-line login with none (`key` `null` — its one caller, `Settings.svelte`,
 * passes `null` for a login, and a login never reads `key`). An API provider with NO key pasted is added keyless only
 * when its keyless candidate row says `keyOptional: true` — the engine's answer, never a reading of its kind or its
 * address (follow-up 4) — and is refused otherwise, saying why. Tests the new entry and answers a
 * pending add, or why not — in which case nothing is left stored. `draft` is not changed.
 */
export async function startAdd(draft: Draft, req: AddRequest, key: string | null, os: Os): Promise<AddStep> {
  const api = req.block["api"];
  const isApi = isObject(api);
  const pasted = key !== null && key.trim() !== "";
  // No key and no address, before anything runs: ask for what is missing. The form's kind chooses ONLY the wording (an
  // Anthropic entry with no address is Anthropic's own endpoint); whether an entry may go keyless is the row's, below.
  if (isApi && !pasted && api["baseUrl"] === undefined) return refused(api["kind"] === "anthropic" ? NO_KEY_LINE : NO_ADDRESS_LINE);
  const keyless = isApi ? withoutKeySources(req.block) : plain(req.block);
  const base = { label: req.label, block: keyless, ...(req.configDir !== undefined ? { configDir: req.configDir } : {}) };

  const bare = candidateWith(draft, req, keyless);
  if (!bare.ok) return refused(bare.message);
  /** The keyless candidate Tested, and waiting with no key (a login; a local model). `given`: its validation. */
  const keylessAdd = async (given?: Awaited<ReturnType<typeof validated>>): Promise<AddStep> => {
    const t = await validateThenTest(bare.text, bare.index, given);
    if (t.kind === "refused") return refused(`Not added: ${t.message}`);
    return { kind: "tested", pending: { ...base, keyId: null, ref: null, text: bare.text, index: bare.index, ran: t.ran, passed: t.passed, rows: t.rows }, lines: t.lines };
  };
  if (!isApi) return keylessAdd();
  // The keyless candidate first: an add the engine refuses anyway stores no key.
  const pre = await validated(bare.text);
  if (!pre.ok) return refused(`Not added: ${pre.message}`);
  if (!pasted) {
    // Whether the NEW entry needs a key: its own row, by `--index` — the engine's `keyOptional`, never the kind or URL.
    const row = pre.rows.find((r) => r.index === bare.index);
    const optional: unknown = row?.keyOptional;
    if (optional === true) return keylessAdd(pre);
    if (optional !== false) return refused(NO_KEY_UNCHECKED_LINE);
    return refused(row?.loopback === true ? NO_KEY_LINE : NO_KEY_REMOTE_LINE);
  }

  const stored = await storeKey(key!, os);
  if (!stored.ok) return refused(...stored.lines);
  const cand = candidateWith(draft, req, withPastedKey(keyless, stored.ref));
  if (!cand.ok) return refused(cand.message, ...(await removeUnused(stored.keyId, os)));
  // Here the engine's https rule applies: the entry's key is now app-owned.
  const t = await validateThenTest(cand.text, cand.index);
  if (t.kind === "refused") return refused(`Not added: ${t.message}`, ...(await removeUnused(stored.keyId, os)));
  return {
    kind: "tested",
    pending: { ...base, keyId: stored.keyId, ref: stored.ref, text: cand.text, index: cand.index, ran: t.ran, passed: t.passed, rows: t.rows },
    lines: t.lines,
  };
}

/** Test a pending add again, rebuilt on the CURRENT draft with the same stored key (no second `key set`). A refusal
 *  keeps the add pending — its key is still the user's to Discard. */
export async function retestAdd(draft: Draft, p: PendingAdd): Promise<{ pending: PendingAdd; lines: string[] }> {
  const block = p.ref === null ? plain(p.block) : withPastedKey(p.block, p.ref);
  const cand = candidateWith(draft, { label: p.label, block, ...(p.configDir !== undefined ? { configDir: p.configDir } : {}) }, block);
  if (!cand.ok) return { pending: { ...p, ran: false, passed: false }, lines: [cand.message] };
  const t = await validateThenTest(cand.text, cand.index);
  // The old rows were for the old text: a refused candidate has none.
  if (t.kind === "refused") return { pending: { ...p, text: cand.text, index: cand.index, ran: false, passed: false, rows: [] }, lines: [`Not tested: ${t.message}`] };
  return { pending: { ...p, text: cand.text, index: cand.index, ran: t.ran, passed: t.passed, rows: t.rows }, lines: t.lines };
}

/**
 * Discard a pending add: `key delete` of its unused new id — only once the CURRENT saved settings (re-read from the file,
 * then `config validate`) show that no entry is reading it. Kept, and said, when a saved row carries the id (the add's
 * save landed after all), or when the rows cannot vouch for every entry (`vouchingRows`), or the file cannot be read.
 * A delete refused `busy` (a row's Test holds the engine) is retried, the check run again first (`retry`).
 */
export async function discardAdd(p: PendingAdd, os: Os, retry: DeleteRetry = DELETE_RETRY): Promise<string[]> {
  if (p.keyId === null) return ["Discarded."];
  const out = await removeIfUnused(p.keyId, os, "keep", retry);
  switch (out.kind) {
    case "kept":
      return [`Discarded, but the key you pasted was kept: ${out.why}; ${KEY_LEFT_FOR_UNINSTALL}.`];
    case "inUse":
      return ["Not discarded: the saved settings already use the key you pasted."];
    case "deleted":
      return ["Discarded: the key you pasted was removed."];
    case "notDeleted":
      return [`Discarded, but the key you pasted could not be removed (${out.why}); ${KEY_LEFT_FOR_UNINSTALL}.`];
  }
}

/* ── an add's Save, and leaving the screen ── */

/** What the add's Save does. */
export type AddSaveStep = { kind: "retest" } | { kind: "refuse"; message: string } | { kind: "save"; text: string; asked: boolean };

/**
 * The add's Save (or Save anyway), decided: refused while a LIVE field has an error (the form's own refusal, its wording
 * — a rejected input was never written into the draft); tested again when the draft changed since the add was tested
 * (`testedOn`, as `rawFromDraft` spells it), so the save keeps those edits; else the tested candidate, with the network
 * question's answer applied when it is on screen for this add (`asked`). Nothing is changed.
 */
export function addSaveDecision(input: {
  draft: Draft;
  testedOn: string;
  errors: Record<string, string>;
  /** The pending add — or replacement (P3-M4-T3): only its tested candidate `text` is read. */
  pending: Pick<PendingAdd, "text">;
  askNetwork: boolean;
  networkYes: boolean;
}): AddSaveStep {
  const form = formSubmission(input.draft, null, input.errors);
  if (form.kind === "blocked") return { kind: "refuse", message: form.message };
  if (rawFromDraft(input.draft) !== input.testedOn) return { kind: "retest" };
  const candidate = input.askNetwork ? parseDraft(input.pending.text) : null;
  if (candidate === null) return { kind: "save", text: input.pending.text, asked: false };
  applyNetworkAnswer(candidate, input.networkYes);
  return { kind: "save", text: rawFromDraft(candidate), asked: true };
}

/** Which step of an add is running (`Settings.svelte` sets it around each await, through `FlowSteps`). */
export type AddRunning = "none" | "start" | "test" | "save" | "discard";

/** One started step of a flow (`FlowSteps.start`). */
export interface StepTicket {
  readonly flow: number;
  readonly id: number;
}

/**
 * The steps of ONE add or ONE replacement on screen, and which of them is running (P3-M4-T3 checkpoint). Each step
 * (`key set` and Test, Test again, Save, Discard) `start`s and is `ended` around its await; a Discard, "Discard changes"
 * or a new flow `discard`s the flow. A step that ends after its flow was discarded answers `false`: its result belongs
 * to a flow that no longer exists, and the screen must not write it back — a Test again ending after Discard would
 * otherwise bring the row back, and a Save anyway on it commit a config naming the key the Discard deleted. `running`
 * is cleared only by the step that set it, so a stale step never clears the Discard that overtook it.
 */
export class FlowSteps<S extends string> {
  #flow = 0;
  #next = 0;
  #runningId = -1;
  running: S | "none" = "none";

  start(step: S): StepTicket {
    this.#next += 1;
    this.#runningId = this.#next;
    this.running = step;
    return { flow: this.#flow, id: this.#next };
  }

  /** The step ended: whether its result may still be shown (its flow was not discarded since it started). */
  ended(ticket: StepTicket): boolean {
    if (this.#runningId === ticket.id) {
      this.#runningId = -1;
      this.running = "none";
    }
    return ticket.flow === this.#flow;
  }

  /** The flow ends: every step started before now ends stale. */
  discard(): void {
    this.#flow += 1;
  }
}

/**
 * Leaving the screen: the pending add whose key is to be removed NOW, or `null`. A waiting add is removed; one whose
 * `key set` (`start`) or Save is running is left to that step (`orphanAfter`), since the save may land; so is one whose
 * Test again is running (P3-M4-T3 fix pass LOW): the Test holds the engine's in-flight guard (`engine.rs`
 * `is_mutating`), so a `key delete` beside it would be refused busy and the key orphaned — the Test's step removes it
 * once it ends. One already being discarded is left alone.
 */
export function leaveAdd(running: AddRunning, pending: PendingAdd | null): PendingAdd | null {
  if (running !== "none") return null;
  return pending;
}

/**
 * A start, a Test again or a Save of an add has ended: the pending add whose key nobody can Discard any more — the
 * screen was left (`left`) and the step did not put the key in use — or `null`. A started add that was tested is that
 * add; a refused one left nothing stored (`startAdd`); a Save that landed is in use; a Test again never lands.
 */
export function orphanAfter(left: boolean, ended: { step: AddStep } | { pending: PendingAdd; landed: boolean }): PendingAdd | null {
  if (!left) return null;
  if ("step" in ended) return ended.step.kind === "tested" ? ended.step.pending : null;
  return ended.landed ? null : ended.pending;
}

/* ── the network-check question ── */

/**
 * Is the network-check question due for saving `text` over `savedText` (spec §6)? Decided by `networkAskNeeded` from
 * the rows of `config validate` OF THIS VERY TEXT — whether an added entry is remote is the engine's `loopback`, never
 * a reading of its URL. The check runs only when the question could be due (`networkProbeHosts` is `[]` and it was not
 * answered yet); a check that cannot answer asks nothing (no row says remote).
 */
export async function networkAskFor(savedText: string | null, text: string, asked: boolean): Promise<boolean> {
  const candidate = parseDraft(text);
  const hosts = candidate?.["networkProbeHosts"];
  if (asked || candidate === null || !Array.isArray(hosts) || hosts.length !== 0) return false;
  let rows: ProviderValidateRow[] | null = null;
  try {
    const check = await providerCandidateCheck(text, "validate");
    if (check.kind === "validated") rows = check.report.providers;
  } catch {
    rows = null;
  }
  return networkAskNeeded(savedText, candidate, asked, rows);
}

/* ── Remove ── */

/** A removed entry's app key: the label it was saved under and the id the engine named for it. */
export interface RemovedKey {
  label: string;
  keyId: string;
}

/** Does the SAVED entry `label` of `savedText` carry a key reference the app could own — an `api` block with an
 *  `apiKeyCommand` or an `apiKeyFile`? A structural PRESENCE read (PR 3 final r5, H1), for wording only: whether the
 *  key IS the app's is the engine's (`appOwnedKey`), and nothing here reads the command or the path. */
function namesKeyReference(savedText: string, label: string): boolean {
  const d = parseDraft(savedText);
  const read = d === null ? null : readProviderList(d);
  const api = read?.ok === true ? read.entries.find((e) => e.label === label)?.block["api"] : undefined;
  return isObject(api) && (api["apiKeyCommand"] !== undefined || api["apiKeyFile"] !== undefined);
}

/**
 * BEFORE the save: the app keys of the entries `removed` (labels the user removed) that the SAVED config holds and the
 * candidate no longer does — each entry's `appKeyId` from the saved config's `config validate` rows. A removed entry
 * whose key the engine owns but cannot name is reported in `lines` (its key is kept). When the saved settings cannot be
 * checked, a removed entry is reported as keeping its key only when its saved block names a key command or key file
 * (`namesKeyReference`); a command-line entry, or one reading a key of the user's own, has no stored key to keep.
 */
export async function keysOfRemoved(savedText: string | null, candidateText: string, removed: readonly string[]): Promise<{ keys: RemovedKey[]; lines: string[] }> {
  if (savedText === null || removed.length === 0) return { keys: [], lines: [] };
  const saved = labelsOf(savedText);
  const after = new Set(labelsOf(candidateText) ?? []);
  const gone = saved === null ? [] : removed.filter((l) => saved.includes(l) && !after.has(l));
  if (gone.length === 0) return { keys: [], lines: [] };
  const v = await validated(savedText);
  if (!v.ok) {
    const keyed = gone.filter((l) => namesKeyReference(savedText, l));
    return { keys: [], lines: keyed.map((l) => `The stored key of ${quoted(l)} was kept: the saved settings could not be checked.`) };
  }
  const keys: RemovedKey[] = [];
  const lines: string[] = [];
  for (const label of gone) {
    const row = v.rows.find((r) => r.index === saved!.indexOf(label));
    if (row !== undefined && !malformedRow(row) && row.appKeyId !== undefined) keys.push({ label, keyId: row.appKeyId });
    // App-owned with no id named, a malformed row (`malformedRow`: it vouches for nothing, PR 3 final N5), or no row at
    // all (the engine did not resolve that entry): which key it is cannot be told, so none is deleted. An entry whose
    // key is the user's own needs nothing.
    else if (row === undefined || malformedRow(row) || row.appOwnedKey === true) lines.push(`The stored key of ${quoted(label)} was kept: it could not be told which key it is.`);
  }
  return { keys, lines };
}

/**
 * AFTER the save landed: `key delete` each of `keys` that no entry of the saved config `savedText` references — by its
 * `config validate` rows. Kept, and said, while any row may read ANY app key (`appOwnedKey` with no `appKeyId`), or
 * while the rows cannot vouch for every entry (fewer rows than entries, or the check failed). A delete refused `busy`
 * is retried (`deleteCleared`: the CURRENT saved settings checked again first). Two removed entries on one key: one
 * delete, and each label is told what came of it.
 */
export async function deleteUnreferencedKeys(savedText: string, keys: readonly RemovedKey[], os: Os, retry: DeleteRetry = DELETE_RETRY): Promise<string[]> {
  if (keys.length === 0) return [];
  const kept = (why: string): string[] => keys.map((k) => `The stored key of ${quoted(k.label)} was kept: ${why}.`);
  const v = await vouchingRows(savedText);
  if (!v.ok) return kept(v.why);
  const lines: string[] = [];
  const outcomes = new Map<string, UnusedOutcome>();
  for (const k of keys) {
    const of = `The stored key of ${quoted(k.label)}`;
    if (v.rows.some((r) => r.appKeyId === k.keyId)) {
      lines.push(`${of} was kept: another provider uses it.`);
      continue;
    }
    let out = outcomes.get(k.keyId);
    if (out === undefined) {
      out = await deleteCleared(k.keyId, os, "keep", retry);
      outcomes.set(k.keyId, out);
    }
    switch (out.kind) {
      case "deleted":
        lines.push(`${of} was deleted.`);
        break;
      case "inUse":
        lines.push(`${of} was kept: another provider uses it.`);
        break;
      case "kept":
        lines.push(`${of} was kept: ${out.why}.`);
        break;
      case "notDeleted":
        lines.push(`${of} could not be deleted (${out.why}); ${KEY_LEFT_FOR_UNINSTALL}.`);
        break;
    }
  }
  return lines;
}

/**
 * A save of `text` over `savedText` that may drop entries the user removed (`removed`, labels), in the one safe order:
 * the removed entries' app key ids from the SAVED config's rows (`keysOfRemoved`), BEFORE it is replaced; then `save`
 * (the caller's `configSave`); then, ONLY when it answered `saved`, `deleteUnreferencedKeys` against the new rows. A
 * save that answers anything else, or throws (rethrown), deletes nothing.
 *
 * ANSWERS AS SOON AS THE SAVE LANDS (PR 3 final r2): `result`, and `lines` — what is known at once (a removed key that
 * could not be told). The deletes are STARTED then and NOT awaited: `deletes` resolves to their lines, which may take
 * up to ~90 s (a busy delete is retried, `deleteCleared`), and never rejects. A caller holding its Save until then would
 * leave the screen editable and then reload over the edits. Each retry checks the CURRENT saved settings again first, so
 * a newer save that names the key keeps it. Nothing cancels them: a caller that goes away (the screen is left) leaves
 * them running, which is safe for that reason.
 */
export async function saveRemovingKeys<R extends { kind: string }>(
  savedText: string | null,
  text: string,
  removed: readonly string[],
  os: Os,
  save: () => Promise<R>,
  retry: DeleteRetry = DELETE_RETRY,
): Promise<{ result: R; lines: string[]; deletes: Promise<string[]> }> {
  const removal = removed.length > 0 ? await keysOfRemoved(savedText, text, removed) : null;
  const result = await save();
  if (result.kind !== "saved" || removal === null) return { result, lines: [], deletes: Promise.resolve([]) };
  return { result, lines: removal.lines, deletes: deleteUnreferencedKeys(text, removal.keys, os, retry) };
}

/* ── Replace (P3-M4-T3) ── */
//
// REPLACE = `key set` (a NEW id) → a candidate with the entry switched to that reference (`withPastedKey`: its other
// key sources removed) → `config validate` → Test → on Save (or Save anyway): `provider_pending_reset_add` (the
// pre-save reset, by label, against the SAVED config) → the save → `provider_pending_reset_flush` (the post-save
// reset). A briefing holding the run lock answers `retry`: the row shows `REPLACE_WAITING_LINE` and `add` is tried
// again every `REPLACE_RETRY_MS`; the save resumes as soon as a pre-save reset succeeds (spec §6 step 2). Rust keeps
// the record between the two resets and retries the post-save one itself (`pending_resets.rs`).
//
// ⚠ THE OLD KEY ID IS NEVER DELETED HERE (spec §6: "The old id is not deleted"): nothing in this flow calls
// `key delete`; an unused NEW id is removed only through `provider_pending_reset_drop`, which deletes it only when the
// saved config's `config validate` rows reference it nowhere. Discard and cancel AWAIT any save of this flow's own
// before calling it (hub Q21: a Tauri command cannot be recalled, so a save already sent may still land).
//
// ⚠ THE PASTED KEY goes to `providerKeySet` and nowhere else, exactly as Add's (`storeKey`).

/** Spec §6 step 2: the pre-save reset is retried every 15 s while a briefing holds the run lock. */
export const REPLACE_RETRY_MS = 15_000;

/** Is "Replace key" offered on a row? Only for a SAVED API entry (the pre-save reset resolves its label in the saved
 *  config, and a command-line tool takes no key), and only while the screen is not busy — no save, add, replacement,
 *  Test, Reset or key move in progress (`busy`: the providers view's, PR 3 final r4 H1). An open Replace field's
 *  Replace and test asks it again. */
export function replaceOffered(row: { isCli: boolean; savedIndex: number | null }, busy: boolean): boolean {
  return !busy && !row.isCli && row.savedIndex !== null;
}

/** A replacement waiting for Save, Save anyway, Test again or Discard. Holds no key. */
export interface PendingReplace {
  readonly label: string;
  /** The NEW key id `key set` answered — the one `add` / `flush` / `drop` name. */
  readonly keyId: string;
  readonly ref: AppKeyReference;
  /** The tested candidate: the draft with this entry switched to `ref`. */
  readonly text: string;
  /** The entry's position in that candidate (`--index` of its Test). */
  readonly index: number;
  readonly ran: boolean;
  readonly passed: boolean;
  readonly rows: readonly ProviderValidateRow[];
  /** The app key id the SAVED entry referenced before (its `config validate` row), or `null` — kept, never deleted. */
  readonly previousKeyId: string | null;
}

export type ReplaceStep = { kind: "refused"; lines: string[] } | { kind: "tested"; pending: PendingReplace; lines: string[] };

/** What the screen draws for a replacement in progress, on its row (`ProvidersList.svelte`). */
export interface ReplaceView {
  label: string;
  busy: boolean;
  /** The form's own Save is running: the replacement's Save waits for it (`pendingSaveLive`). */
  saving: boolean;
  /** Waiting on a run before the save (the row also shows `REPLACE_WAITING_LINE`): Discard stays available. */
  waiting: boolean;
  lines: readonly string[];
  pending: { passed: boolean; ran: boolean } | null;
}

/** Are a pending add's or replacement's Save and Save anyway live? Only while no step of that flow runs and the form's
 *  own Save is not running — exactly when `onprovideraddsave` / `onproviderreplacesave` would not refuse (PR 3 final
 *  r4, H1 follow-up: a button whose handler refuses silently is drawn disabled). Test again and Discard refuse only on
 *  the flow's own step (`busy`; `replaceDiscardable`). */
export function pendingSaveLive(view: { busy: boolean; saving: boolean }): boolean {
  return !view.busy && !view.saving;
}

/** Is Discard available on a replacement? Whenever one is pending and no step but its WAIT is running: while it waits
 *  on a briefing the user may give up (the wait is cancelled, then `discardReplace` awaits it); while its `key set`,
 *  Test, save or discard runs, not. */
export function replaceDiscardable(view: ReplaceView): boolean {
  return view.pending !== null && (!view.busy || view.waiting);
}

/** `ProvidersList.svelte`'s replace props, passed through `SettingsForm.svelte` as one value. */
export interface ReplaceHandlers {
  onreplace: (label: string, key: string) => void;
  replacing: ReplaceView | null;
  /** `replaceOffered`, with the screen's busy state applied. */
  replaceable: (row: { isCli: boolean; savedIndex: number | null }) => boolean;
  onreplacesave: () => void;
  onreplaceretest: () => void;
  onreplacediscard: () => void;
  onreplaceclose: () => void;
}

/** Which step of a replacement is running (`Settings.svelte` sets it around each await). */
export type ReplaceRunning = "none" | "start" | "test" | "save" | "discard";

const notReplaced = (line: string): string => line.replace(/^Not added:/, "Not replaced:");

/** `draft` with the entry `label` switched to `block`, as the list writer writes it, and its `--index`. */
function candidateReplacing(draft: Draft, label: string, block: Json): { ok: true; text: string; index: number } | { ok: false; message: string } {
  const config = plain(draft);
  const read = readProviderList(config);
  if (!read.ok) return { ok: false, message: `Not replaced: the list of providers in the settings could not be read. Fix it with ${EDIT_AS_JSON}.` };
  const index = read.entries.findIndex((e) => e.label === label);
  if (index < 0) return { ok: false, message: `Not replaced: ${quoted(label)} is no longer in the list.` };
  const entry = read.entries[index]!;
  const written = writeProviderList(config, setEntrySettings(read.entries, label, { block, ...(entry.configDir !== undefined ? { configDir: entry.configDir } : {}) }));
  if (!written.ok) return { ok: false, message: "Not replaced: the list of providers could not take the new key." };
  return { ok: true, text: rawFromDraft(written.config), index };
}

/** The pending-reset store's `drop`, worded for the screen. Never throws. */
export async function dropReplacement(label: string, keyId: string): Promise<string[]> {
  let out: PendingDropOutcome;
  try {
    out = await providerPendingResetDrop(label, keyId);
  } catch (e) {
    return [`The key you pasted was kept (${describeFailure(e)}); ${KEY_LEFT_FOR_UNINSTALL}.`];
  }
  return [dropLine(out)];
}

/** One line for a `drop` answer. */
export function dropLine(out: PendingDropOutcome): string {
  switch (out.kind) {
    case "promoted":
      return "Not discarded: the saved settings already use the new key, so it was kept and the replacement finishes.";
    case "deleted":
      return "Discarded: the key you pasted was removed.";
    case "deletePending":
      return "Discarded: the key you pasted is removed as soon as the running provider operation ends.";
    case "kept":
      return out.why === "otherLabel"
        ? "Discarded, but the key you pasted was kept: another saved provider uses it."
        : `Discarded, but the key you pasted was kept: the saved settings could not show that nothing uses it; ${KEY_LEFT_FOR_UNINSTALL}.`;
    case "deleteFailed":
      return `Discarded, but the key you pasted could not be removed (${out.detail}); ${KEY_LEFT_FOR_UNINSTALL}.`;
  }
}

/** One line for a `flush` answer (the save has landed). */
function flushLine(out: PendingFlushOutcome | { kind: "failed"; detail: string }): string {
  switch (out.kind) {
    case "reset":
      return "Replaced: the new key is in use, and the old key's marks were cleared.";
    case "retry":
      return "Saved: the new key is in use. A briefing is running — the old key's marks are cleared when it finishes.";
    case "discarding":
      return "Saved, but the replacement was being discarded; its key is removed once nothing uses it.";
    case "refused":
      return `Saved: the new key is in use, but the old key's marks could not be cleared (${out.detail}). Use Reset on the row.`;
    case "failed":
      return `Saved: the new key is in use, but the old key's marks could not be cleared (${out.detail}). Use Reset on the row.`;
  }
}

/**
 * Replace the saved API entry `label`'s key with the pasted `key`: `key set` (a NEW id), a candidate of `draft` with
 * that entry switched to its reference, `config validate`, then the entry's Test. Answers a pending replacement, or
 * why not — in which case the new key, if one was stored, has been handed to `drop`. `draft` is not changed.
 */
export async function startReplace(draft: Draft, savedText: string | null, label: string, key: string, os: Os): Promise<ReplaceStep> {
  const refused = (...lines: string[]): ReplaceStep => ({ kind: "refused", lines });
  if (key.trim() === "") return refused("Not replaced: paste the new API key.");
  const savedLabels = savedText === null ? null : labelsOf(savedText);
  if (savedLabels === null || !savedLabels.includes(label)) return refused(`Not replaced: save ${quoted(label)} first — only a saved provider's key can be replaced.`);
  const read = readProviderList(plain(draft));
  const entry = read.ok ? read.entries.find((e) => e.label === label) : undefined;
  if (entry === undefined) return refused(`Not replaced: ${quoted(label)} is no longer in the list.`);
  if (!isObject(entry.block["api"])) return refused("Not replaced: a command-line provider takes no API key.");
  const keyless = withoutKeySources(entry.block as Json);

  // The keyless candidate first: a replacement the engine refuses anyway stores no key.
  const bare = candidateReplacing(draft, label, keyless);
  if (!bare.ok) return refused(bare.message);
  const pre = await validated(bare.text);
  if (!pre.ok) return refused(`Not replaced: ${pre.message}`);
  // The id the saved entry reads now (the engine's row): kept, never deleted.
  const saved = await validated(savedText!);
  const previousKeyId = saved.ok ? (saved.rows.find((r) => r.index === savedLabels.indexOf(label))?.appKeyId ?? null) : null;

  const stored = await storeKey(key, os, (id) => dropReplacement(label, id));
  if (!stored.ok) return refused(...stored.lines.map(notReplaced));
  const cand = candidateReplacing(draft, label, withPastedKey(keyless, stored.ref));
  if (!cand.ok) return refused(cand.message, ...(await dropReplacement(label, stored.keyId)));
  const t = await validateThenTest(cand.text, cand.index);
  if (t.kind === "refused") return refused(`Not replaced: ${t.message}`, ...(await dropReplacement(label, stored.keyId)));
  return {
    kind: "tested",
    pending: { label, keyId: stored.keyId, ref: stored.ref, text: cand.text, index: cand.index, ran: t.ran, passed: t.passed, rows: t.rows, previousKeyId },
    lines: t.lines,
  };
}

/** Test a pending replacement again, rebuilt on the CURRENT draft with the same stored key (no second `key set`). */
export async function retestReplace(draft: Draft, p: PendingReplace): Promise<{ pending: PendingReplace; lines: string[] }> {
  const read = readProviderList(plain(draft));
  const entry = read.ok ? read.entries.find((e) => e.label === p.label) : undefined;
  if (entry === undefined || !isObject(entry.block["api"])) {
    return { pending: { ...p, ran: false, passed: false, rows: [] }, lines: [`Not tested: ${quoted(p.label)} is no longer an API provider in the list.`] };
  }
  const cand = candidateReplacing(draft, p.label, withPastedKey(withoutKeySources(entry.block as Json), p.ref));
  if (!cand.ok) return { pending: { ...p, ran: false, passed: false, rows: [] }, lines: [cand.message] };
  const t = await validateThenTest(cand.text, cand.index);
  if (t.kind === "refused") return { pending: { ...p, text: cand.text, index: cand.index, ran: false, passed: false, rows: [] }, lines: [`Not tested: ${t.message}`] };
  return { pending: { ...p, text: cand.text, index: cand.index, ran: t.ran, passed: t.passed, rows: t.rows }, lines: t.lines };
}

/** What a replacement's Save came to. */
export type ReplaceSaveResult =
  /** Saved, and the post-save reset asked for (`lines` say how it went). The replacement is done. */
  | { kind: "landed"; lines: string[] }
  /** Not saved: the replacement still waits (Save again, or Discard). */
  | { kind: "notSaved"; lines: string[] }
  /** The pre-save reset was refused: the replacement ended and its key was handed to `drop`. */
  | { kind: "ended"; lines: string[] }
  /** Cancelled while it waited for a run to finish: nothing was saved; the caller discards it. */
  | { kind: "cancelled" };

/** The screen's side of a replacement's Save (`Settings.svelte`). */
export interface ReplaceSaveDeps {
  /** The one save path (`submit`) for `text`; `true` when it landed. */
  save: (text: string) => Promise<boolean>;
  /** Wait `ms` — `setTimeout` on screen, an injected clock in the checks. */
  sleep: (ms: number) => Promise<void>;
  /** The user cancelled (Discard while waiting) or left the screen. */
  cancelled: () => boolean;
  /** Whether the draft is still the one the candidate was tested on — a save resumed after a wait must not drop edits
   *  made meanwhile. */
  current: () => boolean;
  /** The form's own Save is running (`Settings.svelte`'s `saving`): `save` would refuse at once, with no reason of its
   *  own to show (PR 3 final r5, H2), so the replacement says why instead (`REPLACE_FORM_SAVING_LINE`). */
  saving: () => boolean;
  /** Show (`true`) or clear `REPLACE_WAITING_LINE` on the row. */
  waiting: (on: boolean) => void;
}

/** A replacement's Save that found the form's own Save running (a wait for a briefing ended meanwhile): not sent. */
export const REPLACE_FORM_SAVING_LINE = "Not saved: the settings were being saved at that moment. Save again once that save ends, or Discard.";

/**
 * A replacement's Save of `text` (its tested candidate, as `addSaveDecision` decided it): the pre-save reset (`add`),
 * retried every `REPLACE_RETRY_MS` while a run holds the lock, then the save, then the post-save reset (`flush`).
 * Never deletes a key itself: a refused pre-save reset ends the replacement through `drop`.
 */
export async function saveReplace(p: PendingReplace, text: string, deps: ReplaceSaveDeps): Promise<ReplaceSaveResult> {
  for (;;) {
    if (deps.cancelled()) {
      deps.waiting(false);
      return { kind: "cancelled" };
    }
    let added: PendingAddOutcome;
    try {
      added = await providerPendingResetAdd(p.label, p.keyId);
    } catch (e) {
      deps.waiting(false);
      return { kind: "notSaved", lines: [`Not saved: the replacement could not be recorded (${describeFailure(e)}). Save again, or Discard.`] };
    }
    if (added.kind === "reset") break;
    if (added.kind === "refused") {
      deps.waiting(false);
      return { kind: "ended", lines: [`Not replaced: the old key's marks could not be cleared first (${added.detail}).`, ...(await dropReplacement(p.label, p.keyId))] };
    }
    // Cancelled while `add` ran: not a 15 s wait first.
    if (deps.cancelled()) {
      deps.waiting(false);
      return { kind: "cancelled" };
    }
    deps.waiting(true);
    await deps.sleep(REPLACE_RETRY_MS);
  }
  deps.waiting(false);
  if (deps.cancelled()) return { kind: "cancelled" };
  if (!deps.current()) return { kind: "notSaved", lines: ["Not saved: the settings changed while the briefing ran. Test the new key again, then Save."] };
  if (deps.saving()) return { kind: "notSaved", lines: [REPLACE_FORM_SAVING_LINE] };
  const landed = await deps.save(text);
  if (!landed) return { kind: "notSaved", lines: ["Not saved yet (see why below): Save again, or Discard."] };
  let flushed: PendingFlushOutcome | { kind: "failed"; detail: string };
  try {
    flushed = await providerPendingResetFlush(p.label, p.keyId);
  } catch (e) {
    flushed = { kind: "failed", detail: describeFailure(e) };
  }
  const kept = p.previousKeyId !== null ? [`The previous key stays stored; ${KEY_LEFT_FOR_UNINSTALL}.`] : [];
  return { kind: "landed", lines: [flushLine(flushed), ...kept] };
}

/**
 * Discard or cancel a pending replacement: FIRST wait for any save of its own still running (`inFlight` — a sent save
 * cannot be recalled and may still land), THEN `drop`, which keeps the key when the saved settings use it.
 */
export async function discardReplace(p: PendingReplace, inFlight: Promise<unknown> | null): Promise<string[]> {
  if (inFlight !== null) {
    try {
      await inFlight;
    } catch {
      // Its own error path words it; what matters here is only that it has settled.
    }
  }
  return dropReplacement(p.label, p.keyId);
}

/** Leaving the screen: the pending replacement to discard NOW, or `null` — a running step (its `key set` and Test, its
 *  Save or its wait) discards it when it ends (`replaceOrphanAfter`); one already being discarded is left alone. */
export function leaveReplace(running: ReplaceRunning, pending: PendingReplace | null): PendingReplace | null {
  return running === "none" || running === "test" ? pending : null;
}

/** A start or a Save of a replacement has ended: the pending replacement nobody can Discard any more (the screen was
 *  left and the step did not finish it), or `null`. */
export function replaceOrphanAfter(left: boolean, ended: { step: ReplaceStep } | { pending: PendingReplace; result: ReplaceSaveResult }): PendingReplace | null {
  if (!left) return null;
  if ("step" in ended) return ended.step.kind === "tested" ? ended.step.pending : null;
  return ended.result.kind === "notSaved" || ended.result.kind === "cancelled" ? ended.pending : null;
}

/** The row note for a replacement waiting on a run (spec §6 step 2), keyed by label for `providersView`. */
export function replacePendingNotes(label: string | null, waiting: boolean): Record<string, "replace-waiting"> {
  return label !== null && waiting ? { [label]: "replace-waiting" } : {};
}

/* ── P3-M4-T4: a key written in the settings file ── */
//
// MIGRATE = `key migrate --index` (the ENGINE reads the literal from the saved config and stores it — ⚠ THE APP NEVER
// HOLDS THE LITERAL: `config_read` hands it the redaction placeholder, and migrate is sent the index alone) → the
// answer's `revision` compared with the row the screen showed (hub P2-M3-T1 checkpoint (1)) → a save of the SAVED
// settings with ONLY that entry's literal removed and the reference put into its EMPTY slot, every other key source
// kept (checkpoint (2)) → `key scrub-backup`, which removes the literal from `config.json.bak`. A mismatch, a draft
// changed meanwhile or a save that did not land removes the new key id again (`removeIfUnused`); the literal stays.
//
// When a source of the user's own holds, or ranks below, the slot the reference would take (`migrateBlockedBy`), the
// literal is read only when that source fails, and moving it would change which key is used: there is NO migrate.
// The screen offers REMOVE instead (hub 2026-10-18 decision 1), behind a confirmation (`ProvidersList.svelte`): a save
// with only the literal removed, then the scrub. The user's own source is never touched.
//
// THE SCRUB ON OPEN: App runs the idempotent `scrubBackup` on every open (hub P2-M3-T2 (2): Rust detects nothing), so
// a scrub cut short by an exit is finished then. The scrub COMMAND (engine.rs) first sweeps a crashed save's staged
// copies under the save lock, so `otherCopies: true` is a link the app did not make or could not remove: the line says
// what to look for (P3-M4 checkpoint). A `config` refusal with `reason: "timeout"` or `"changed"`, the app's own bound
// and `busy` are retried every `SCRUB_RETRY_MS`. On open a plain `config` refusal is quiet (Settings already says the
// settings are invalid or missing); a write failure, an engine failure and retries that ran out are shown.

/** Retry the scrub this often while it times out or the engine is busy, at most `SCRUB_TRIES` times in all. */
export const SCRUB_RETRY_MS = 15_000;
export const SCRUB_TRIES = 4;
/** The on-open wording (PR 2 final r1): the scrub cannot tell a migrated literal from a hand-deleted entry's. */
export const SCRUB_OPEN_LINE = "Keys no longer in your settings were removed from the backup.";
/** After a migrate's or a remove's save: the backup no longer holds the key either. */
export const SCRUB_SAVED_LINE = "It was removed from the settings backup too.";
/** `otherCopies: true`, after the scrub command's own sweep of the app's crashed-save copies (engine.rs): another name for
 *  the backup's file remains, which the app did not make (or could not remove), and it keeps the old contents. */
export const SCRUB_OTHER_COPIES_LINE =
  "Another file in the settings folder is a second name (a hard link) for the settings backup, config.json.bak, that this app did not make or could not remove, and it may still hold a key that is no longer in your settings. Find it (in a terminal, `ls -li` shows it with the same number as config.json.bak) and delete it.";
/** Hub P2-M3-T1 checkpoint (1): the entry `key migrate` read is not the one shown. */
export const MIGRATE_CHANGED_LINE = "Not moved: the saved settings changed — reopen and retry.";
/** A migrate that landed, naming the platform's key store (`keyStoreName`). */
export function migratedLine(os: Os): string {
  return `Moved: the key is in the ${keyStoreName(os)} now, and the settings file keeps only a reference to it.`;
}
/** `key migrate`'s reason-less `config` refusal for an `http:` block: an app-stored key never goes over plain http to
 *  another machine. Chosen by the scheme alone (`httpBlock`), so it also reaches a LOOPBACK `http:` address, which the
 *  engine allows: the line says what to do in both cases (PR 3 final r1, B3). */
export const MIGRATE_HTTP_LINE =
  "Not moved: the engine would not move this key from the saved settings. A key the app stores is never sent over plain http to another machine — if this provider is on another machine, switch its address to https first; if it is on this one, check that the settings are valid (Save says why when they are not), then retry.";
/** …and for any other block. */
export const MIGRATE_CONFIG_LINE =
  "Not moved: the engine would not move this key from the saved settings. Check that the settings are valid (Save says why when they are not), then retry.";
/** Remove is offered only when a source of the user's own takes the written key's place (`migrateBlockedBy`). */
export function removeRefusedLine(os: Os): string {
  return `Not removed: no key source of your own would take the written key's place — move it to the ${keyStoreName(os)} instead.`;
}
export const WRITTEN_KEY_REMOVED_LINE = "Removed: the key written in the settings file is gone; your own key source stays as it is.";

/** What the scrub came to. A failure's `cause`: a plain `config` refusal (the saved settings or the backup cannot be
 *  read as they are), `write-failed`, the engine (no answer, or another failure), or retries that ran out. */
export type ScrubResult =
  | { kind: "scrubbed"; removed: number; otherCopies: boolean }
  | { kind: "failed"; detail: string; cause: "config" | "write-failed" | "engine" | "exhausted" };

/** One `key scrub-backup` attempt: its result, and whether a failure is worth retrying — only a failure is (the type
 *  says so, so `scrubBackup` needs no arm for a retried success). */
async function scrubOnce(): Promise<{ result: ScrubResult; retry: false } | { result: Extract<ScrubResult, { kind: "failed" }>; retry: boolean }> {
  try {
    const p = (await providerKeyScrubBackup()).payload;
    if (p === null) return { result: { kind: "failed", detail: "the engine stopped before replying", cause: "engine" }, retry: false };
    if (p.ok === true) return { result: { kind: "scrubbed", removed: p.removed, otherCopies: p.otherCopies === true }, retry: false };
    // `reason: "changed"`: the backup changed while it was read or scrubbed — retry (by the field, never the message).
    const retry = p.code === "config" && (p.reason === "timeout" || p.reason === "changed");
    const detail =
      p.reason === "timeout"
        ? "the settings or their backup did not answer in time"
        : p.reason === "changed"
          ? "the backup changed while it was being cleaned"
          : p.code === "write-failed"
            ? "the backup could not be rewritten"
            : "the settings or their backup could not be read";
    const cause = p.code === "config" ? "config" : p.code === "write-failed" ? "write-failed" : "engine";
    return { result: { kind: "failed", detail, cause }, retry };
  } catch (e) {
    const retry = isObject(e) && (e["kind"] === "busy" || e["kind"] === "timeout");
    return { result: { kind: "failed", detail: describeFailure(e), cause: "engine" }, retry };
  }
}

/** `key scrub-backup`, retried every `SCRUB_RETRY_MS` (`sleep`) while it times out or the engine is busy. Never throws. */
export async function scrubBackup(sleep: (ms: number) => Promise<void>, tries: number = SCRUB_TRIES): Promise<ScrubResult> {
  for (let attempt = 1; ; attempt++) {
    const once = await scrubOnce();
    if (!once.retry) return once.result;
    if (attempt >= tries) return { ...once.result, cause: "exhausted" };
    await sleep(SCRUB_RETRY_MS);
  }
}

/** The scrub's lines: on open (App's notice) or after a migrate's or a remove's save. */
export function scrubLines(r: ScrubResult, when: "open" | "save"): string[] {
  if (r.kind === "failed") {
    // On open, a plain `config` refusal is quiet: Settings already reports settings that are invalid or missing, and
    // the next open tries again (P3-M4 checkpoint — the notice repeated on every open).
    if (when === "open" && r.cause === "config") return [];
    return when === "open"
      ? [`The settings backup could not be checked for keys no longer in your settings (${r.detail}). It is checked again the next time the app opens.`]
      : [`The settings backup may still hold the key (${r.detail}); it is removed the next time the app opens.`];
  }
  const lines = r.removed > 0 ? [when === "open" ? SCRUB_OPEN_LINE : SCRUB_SAVED_LINE] : [];
  if (r.otherCopies) lines.push(SCRUB_OTHER_COPIES_LINE);
  return lines;
}

/** Which saved entry a literal-key action is for: the screen's SAVED settings (as `config_read` gave them, the literal
 *  redacted), the entry's label and its `--index` there, the platform, and whether the draft holds unsaved edits. */
export interface LiteralTarget {
  savedText: string;
  label: string;
  index: number;
  os: Os;
  unsaved: boolean;
}

/** What a literal-key action reads of the screen (`Settings.svelte`): the SAVED text, the tab (`"raw"` while the JSON
 *  editor is open), and the form's draft. A JSON-editor edit lives in the screen's `raw` and reaches the draft only
 *  when the editor is left (`tab` back to `"form"`). */
export interface LiteralScreen {
  savedText: string | null;
  tab: "form" | "raw";
  draft: Draft | null;
}

/**
 * The guards of a literal-key action, from the screen as it was when the action started (`start`) and as it is
 * whenever asked (`now`). `unsaved`: anything the save would carry besides the change — an edited or invalid draft, the
 * JSON editor open, no draft. `current()`: the form is still in use (`tab === "form"`) and the saved text and the draft
 * are the ones the action started from; with the JSON editor open it is never current, since the post-save reload
 * would wipe an edit there
 * (P3-M4 checkpoint, findings 1 and 8).
 */
export function literalGuards(start: LiteralScreen, now: () => LiteralScreen): { unsaved: boolean; current: () => boolean } {
  const startDraft = start.draft === null ? null : rawFromDraft(start.draft);
  const unsaved = start.tab !== "form" || start.draft === null || formSubmission(start.draft, start.savedText, {}).kind !== "unchanged";
  return {
    unsaved,
    current: () => {
      const n = now();
      return n.tab === "form" && n.savedText === start.savedText && n.draft !== null && rawFromDraft(n.draft) === startDraft;
    },
  };
}

/** The screen's side of a literal-key action (`Settings.svelte`). */
export interface LiteralDeps {
  /** The one save path (`submit`) for `text`; `true` when it landed. */
  save: (text: string) => Promise<boolean>;
  /** The draft and the saved settings are still the ones the action started from. */
  current: () => boolean;
  /** Wait `ms` (the scrub's retry) — `setTimeout` on screen, a recorder in the checks. */
  sleep: (ms: number) => Promise<void>;
}

export interface LiteralResult {
  landed: boolean;
  lines: string[];
}

/** The SAVED entry `label` at `index`, when it still holds a literal there, or `null`. */
function literalEntryAt(savedText: string, label: string, index: number): ProviderEntry | null {
  const d = parseDraft(savedText);
  const read = d === null ? null : readProviderList(d);
  const entry = read?.ok === true ? read.entries[index] : undefined;
  if (entry === undefined || entry.label !== label) return null;
  const api = entry.block["api"];
  return isObject(api) && api["apiKey"] !== undefined ? entry : null;
}

/** `savedText` with ONLY entry `label`'s literal removed and, given a reference, that reference put into its slot —
 *  refused when the slot, or a source ranked below it, is taken (`migrateBlockedBy`). */
function withoutLiteral(savedText: string, label: string, ref: AppKeyReference | null): { ok: true; text: string } | { ok: false; why: "taken" | "unwritable" } {
  const config = plain(parseDraft(savedText)!);
  const read = readProviderList(config);
  if (!read.ok) return { ok: false, why: "unwritable" };
  const entry = read.entries.find((e) => e.label === label)!;
  const block = plain(entry.block as Json);
  const api = block["api"] as Json;
  delete api["apiKey"];
  if (ref !== null) {
    const slot = "apiKeyCommand" in ref ? "apiKeyCommand" : "apiKeyFile";
    if (migrateBlockedBy(entry.block, slot) !== null) return { ok: false, why: "taken" };
    api[slot] = "apiKeyCommand" in ref ? [...ref.apiKeyCommand] : ref.apiKeyFile;
  }
  const written = writeProviderList(config, setEntrySettings(read.entries, label, { block, ...(entry.configDir !== undefined ? { configDir: entry.configDir } : {}) }));
  return written.ok ? { ok: true, text: rawFromDraft(written.config) } : { ok: false, why: "unwritable" };
}

/** Does the saved block name an `http:` address (the engine's plain-http refusal of an app-stored key)? */
const httpBlock = (block: Readonly<Record<string, unknown>>): boolean => {
  const api = block["api"];
  return isObject(api) && typeof api["baseUrl"] === "string" && /^http:/i.test(api["baseUrl"].trim());
};

/** A `key migrate` refusal, worded by `code` and `reason` (never by parsing `error`), and for a reason-less `config`
 *  refusal by the saved block: the https advice only for an `http:` address (P3-M4 checkpoint, finding 3). */
function migrateRefusalLine(r: ProviderRefusal, os: Os, block: Readonly<Record<string, unknown>>): string {
  if (r.reason === "invalid-key") {
    return `Not moved: the key written in the settings file is not one the app can store (a key is 8 to 512 letters, digits and . _ ~ + / = -). Fix or remove it with ${EDIT_AS_JSON}.`;
  }
  if (r.code === "config" && r.reason === "timeout") return "Not moved: the saved settings could not be read in time — retry.";
  if (r.reason === "timeout") return `Not moved: the key could not be stored in time — ${keyTimeoutLine(os)}.`;
  if (r.code === "write-failed") return `Not moved: the key could not be stored (${r.reason ?? "the key store refused it"}).`;
  if (r.code === "config") return httpBlock(block) ? MIGRATE_HTTP_LINE : MIGRATE_CONFIG_LINE;
  return "Not moved: the engine refused the request.";
}

/** The lines for a new key id this app stored and will not use, removed again (`removeIfUnused`). */
async function dropUnusedMigrated(keyId: string, os: Os): Promise<string[]> {
  const out = await removeIfUnused(keyId, os, "keep");
  switch (out.kind) {
    case "deleted":
      return [];
    case "inUse":
      return [`The saved settings already use the copy stored in the ${keyStoreName(os)}, so it was kept.`];
    case "kept":
      return [`The copy stored in the ${keyStoreName(os)} was kept (${out.why}); ${KEY_LEFT_FOR_UNINSTALL}.`];
    case "notDeleted":
      return [`The copy stored in the ${keyStoreName(os)} could not be removed (${out.why}); ${KEY_LEFT_FOR_UNINSTALL}.`];
  }
}

const SAVE_FIRST_LITERAL = (verb: string): string => `Not ${verb}: Save or discard your changes first — this saves the settings.`;

/**
 * Move the saved entry `label`'s literal key into the app's key store (`key migrate`), save the reference in its place,
 * then scrub the backup. `shownRevision` is the screen's `status --json` row revision for that entry. Never throws.
 */
export async function migrateLiteral(t: LiteralTarget & { shownRevision: string | null }, deps: LiteralDeps): Promise<LiteralResult> {
  const no = (...lines: string[]): LiteralResult => ({ landed: false, lines });
  if (t.unsaved) return no(SAVE_FIRST_LITERAL("moved"));
  const entry = literalEntryAt(t.savedText, t.label, t.index);
  if (entry === null) return no(MIGRATE_CHANGED_LINE);
  if (migrateBlockedBy(entry.block, migrateSlot(t.os)) !== null) {
    return no(`Not moved: this provider has a key source of your own, which moving the key would change. ${REMOVE_LITERAL_BUTTON} instead.`);
  }
  let payload;
  try {
    payload = (await providerKeyMigrate(t.index)).payload;
  } catch (e) {
    if (isObject(e) && e["kind"] === "busy") return no("Not moved: another provider operation is running — try again in a moment.");
    if (timedOut(e)) return no(`Not moved: storing the key did not finish in time — ${keyTimeoutLine(t.os)}.`);
    return no(`Not moved: ${describeFailure(e)}.`);
  }
  if (payload === null) return no("Not moved: the engine stopped before replying, so the key may or may not have been stored; the settings were not changed.");
  if (payload.ok !== true) {
    const lines = [migrateRefusalLine(payload, t.os, entry.block)];
    if (typeof payload.keyId === "string") lines.push(...(await dropUnusedMigrated(payload.keyId, t.os)));
    return no(...lines);
  }
  const keyId = payload.keyId;
  const revision = (payload as Json)["revision"];
  if (typeof revision !== "string" || t.shownRevision === null || revision !== t.shownRevision) {
    return no(MIGRATE_CHANGED_LINE, ...(await dropUnusedMigrated(keyId, t.os)));
  }
  const ref = referenceIn(payload);
  if (ref === null) return no("Not moved: the engine's answer named no key reference.", ...(await dropUnusedMigrated(keyId, t.os)));
  if (!deps.current()) return no("Not moved: the settings changed while the key was being stored — try again.", ...(await dropUnusedMigrated(keyId, t.os)));
  const cand = withoutLiteral(t.savedText, t.label, ref);
  if (!cand.ok) {
    const why = cand.why === "taken" ? "the place for its reference holds a key source of your own" : "the list of providers could not take the change";
    return no(`Not moved: ${why}.`, ...(await dropUnusedMigrated(keyId, t.os)));
  }
  if (!(await deps.save(cand.text))) {
    return no("Not moved yet (see why below): the key is still written in the settings file.", ...(await dropUnusedMigrated(keyId, t.os)));
  }
  return { landed: true, lines: [migratedLine(t.os), ...scrubLines(await scrubBackup(deps.sleep), "save")] };
}

/**
 * Remove the saved entry `label`'s literal key, and only it (the screen asked for confirmation first): a save with
 * that one field removed, then the scrub. No key is stored or deleted; every other key source stays. Refused unless a
 * source of the user's own holds or ranks below the slot a moved key would take (`migrateBlockedBy` — the one case the
 * screen offers it): otherwise the entry could be left with no source, reading its kind's default variable (P3-M4
 * checkpoint, finding 2). Never throws.
 */
export async function removeWrittenKey(t: LiteralTarget, deps: LiteralDeps): Promise<LiteralResult> {
  const no = (...lines: string[]): LiteralResult => ({ landed: false, lines });
  if (t.unsaved) return no(SAVE_FIRST_LITERAL("removed"));
  const entry = literalEntryAt(t.savedText, t.label, t.index);
  if (entry === null) return no(MIGRATE_CHANGED_LINE);
  if (migrateBlockedBy(entry.block, migrateSlot(t.os)) === null) return no(removeRefusedLine(t.os));
  if (!deps.current()) return no("Not removed: the settings changed — try again.");
  const cand = withoutLiteral(t.savedText, t.label, null);
  if (!cand.ok) return no("Not removed: the list of providers could not take the change.");
  if (!(await deps.save(cand.text))) return no("Not removed yet (see why below): the key is still written in the settings file.");
  return { landed: true, lines: [WRITTEN_KEY_REMOVED_LINE, ...scrubLines(await scrubBackup(deps.sleep), "save")] };
}
