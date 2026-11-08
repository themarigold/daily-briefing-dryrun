/**
 * Checkpoint P3-M6 (carried item A) — THE ONE RULE FOR A KEY THE APP STORED AND IS NOT GOING TO USE, shared by
 * Settings (`lib/provider-flows.ts`: Discard of an add, an unused migrated key) and the first-time wizard
 * (`lib/wizard-key.ts`: `releaseKey`). It decides deleting a key, so it exists once IN THE APP'S TYPESCRIPT: two copies
 * drifting would mean one screen deleting a key the other keeps. Rust holds the cross-language twin of the same rule
 * for the deletes it makes itself (`gui/src-tauri/src/key_refs.rs`, used by `pending_resets.rs` and `uninstall.rs`);
 * both fail toward keeping the key — a row of a malformed shape (an `appOwnedKey` that is not a boolean, an `appKeyId`
 * that is not a string) vouches for nothing in either (`vouchingRows` here, `row_key` there).
 *
 *  • `key delete` only once the CURRENT saved settings (re-read with `configRead`, then the engine's `config validate`)
 *    show that no entry reads it. KEPT when a saved row carries its id (`inUse`), when a row may read ANY app key
 *    (`appOwnedKey` with no `appKeyId`), when the rows do not cover every entry, when the check fails, or when the
 *    settings cannot be read. A key in doubt is kept: a stray key costs nothing, a deleted one in use skips a briefing.
 *  • THE ONE POLICY THAT DIFFERS IS A PARAMETER: with no saved config at all, `"keep"` (Settings — it always has a
 *    config, so none means the read went wrong) or `"delete"` (the wizard's first run — nothing can reference it).
 *  • A DELETE REFUSED `busy` (another state-changing operation — a row's Test, a briefing run — holds the engine's
 *    in-flight guard) is retried every `KEY_DELETE_RETRY_MS`, at most `KEY_DELETE_TRIES` attempts in all (PR 3 final
 *    r1, A1), and the check above runs AGAIN on the current saved settings before each retry, so a retry does not
 *    rest on the answer from before its wait.
 *  • ⚠ RESIDUAL, ACCEPTED (PR 3 final r3, A1/H2): the check and the delete are two separate calls, and neither is held
 *    under the settings save lock (the Rust pending-reset store's deletes are: `pending_resets.rs` takes it). A save
 *    that writes a reference to EXACTLY this key id and lands between the check and the delete loses that key. Key
 *    ids are engine-minted (`k-` + 12 random hex digits, `src/keyStore.ts`), so in practice only a hand-typed
 *    reference to this id can do that. No mechanism closes it.
 *
 * Also here, because both callers use them: the engine check of a candidate the save would write (`validated`), the
 * worded `key delete` (`deleteKey`), the sentence for a key left in the store (`KEY_LEFT_FOR_UNINSTALL`), the reference
 * a `key set` answer names (`referenceIn`) and a `key set` refusal in words (`keySetRefusalLine`).
 * Nothing here throws for an engine answer or an IPC rejection.
 */
import { providerCandidateCheck, providerKeyDelete, type AppKeyReference, type CheckOutcome, type ProviderRefusal, type ProviderValidateRow } from "./engine";
import { configRead, describeFailure } from "./files";
import type { Os } from "./platform";
import { isObject, readProviderList } from "./provider-list";
import { keyTimeoutLine, parseDraft, saveGate } from "./settings-model";

/** What a key left in the store is told, after `; ` (checkpoint P3-M6, carried item B): Uninstall removes it only
 *  with the settings-and-keys box ticked, and only when that leg is not refused — so "can". */
export const KEY_LEFT_FOR_UNINSTALL = "Uninstall can remove it with your settings and API keys";

/** A provider verb's refusal that is a key store `timeout`, or the app's own bound on the call. */
export const timedOut = (e: unknown): boolean => isObject(e) && (e["kind"] === "timeout" || e["reason"] === "timeout");

/** Why the engine refuses `check` as a config the save would write, or `null`. */
function checkRefusal(check: CheckOutcome): string | null {
  if (check.kind === "invalid") return `fix these first — ${check.errors.map((e) => e.message).join("; ")}`;
  if (check.kind !== "validated") return "the settings could not be checked";
  if (!check.report.valid) return `fix these first — ${check.report.errors.map((e) => e.message).join("; ")}`;
  const gate = saveGate(check);
  return gate.kind === "refuse" ? gate.message : null;
}

/** `config validate` of `text`: its rows, or why it would not be saved. */
export async function validated(text: string): Promise<{ ok: true; rows: ProviderValidateRow[]; check: CheckOutcome } | { ok: false; message: string }> {
  let check: CheckOutcome;
  try {
    check = await providerCandidateCheck(text, "validate");
  } catch (e) {
    return { ok: false, message: `the settings could not be checked (${describeFailure(e)})` };
  }
  const why = checkRefusal(check);
  if (why !== null) return { ok: false, message: why };
  return { ok: true, rows: check.kind === "validated" ? check.report.providers : [], check };
}

/** The reference a `key set` / `key migrate` answer names, as answered (a copy), or `null`. */
export function referenceIn(payload: unknown): AppKeyReference | null {
  if (!isObject(payload)) return null;
  const cmd = payload["apiKeyCommand"];
  if (Array.isArray(cmd) && cmd.every((w) => typeof w === "string")) return { apiKeyCommand: [...(cmd as string[])] };
  return typeof payload["apiKeyFile"] === "string" ? { apiKeyFile: payload["apiKeyFile"] } : null;
}

/** A `key set` refusal in words, by `code` and `reason`: "Not `verb`: …" (Settings' Add says "added", the wizard
 *  "stored"). `instead`: where a key can come from on a platform that cannot keep a pasted one. */
export function keySetRefusalLine(r: ProviderRefusal, os: Os, verb: "added" | "stored", instead: string): string {
  if (r.code === "usage" && r.reason === "invalid-key") {
    return `Not ${verb}: that does not look like an API key. A key is 8 to 512 letters, digits and . _ ~ + / = - (spaces around it are fine).`;
  }
  if (r.reason === "unsupported-platform") return `Not ${verb}: this computer cannot keep a pasted key. ${instead}`;
  if (r.reason === "timeout") return `Not ${verb}: the key could not be stored in time — ${keyTimeoutLine(os)}.`;
  if (r.code === "write-failed") return `Not ${verb}: the key could not be stored (${r.reason ?? "the key store refused it"}).`;
  return `Not ${verb}: the engine would not store the key.`;
}

/** One `key delete --id`: `why` `null` when the key is gone (removed now, or already), else why not; `busy` when the
 *  engine refused it because another provider operation holds its in-flight guard. */
async function deleteOnce(id: string, os: Os): Promise<{ why: string | null; busy: boolean }> {
  try {
    const p = (await providerKeyDelete(id)).payload;
    if (p === null) return { why: "the engine stopped before replying", busy: false };
    if (p.ok === true) return { why: null, busy: false };
    return { why: timedOut(p) ? keyTimeoutLine(os) : `the key store refused (${p.reason ?? p.code})`, busy: false };
  } catch (e) {
    const busy = isObject(e) && e["kind"] === "busy";
    return { why: timedOut(e) ? keyTimeoutLine(os) : describeFailure(e), busy };
  }
}

/** `key delete --id`, once: `null` when the key is gone (removed now, or already), else why not. For a key no saved
 *  settings can name yet (an add's or a paste's own, never saved); a key the saved settings might use goes through
 *  `removeIfUnused` / `deleteCleared`, which retry a busy refusal after checking again. */
export async function deleteKey(id: string, os: Os): Promise<string | null> {
  return (await deleteOnce(id, os)).why;
}

/** A `busy` key delete is tried again this often (A1)… */
export const KEY_DELETE_RETRY_MS = 10_000;
/** …at most this many attempts in all: the 9 waits (90 s) outlast a REMOTE or CLI Test's bound (80 s,
 *  `PROVIDER_TEST_REMOTE_TIMEOUT` in `engine.rs`) only. A loopback Test (its `timeoutMs` + 17 s, up to the 30-minute
 *  cap) or a briefing run (unbounded) can hold the in-flight guard longer; the delete then ends `notDeleted` — safe:
 *  the key is kept, the caller's line says so, and Uninstall can remove it (`KEY_LEFT_FOR_UNINSTALL`). */
export const KEY_DELETE_TRIES = 10;

/** How a busy delete waits, and how many attempts it makes in all (injected by the checks). */
export interface DeleteRetry {
  sleep: (ms: number) => Promise<void>;
  tries: number;
}
export const DELETE_RETRY: DeleteRetry = { sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)), tries: KEY_DELETE_TRIES };

/** The labels of `text`'s list, by `--index`, or `null` when it cannot be read. */
export function labelsOf(text: string): string[] | null {
  const d = parseDraft(text);
  const read = d === null ? null : readProviderList(d);
  return read?.ok === true ? read.entries.map((e) => e.label) : null;
}

/** A row whose key fields have a shape the engine never answers (`src/json.ts`): `appOwnedKey` present and not a
 *  boolean, or `appKeyId` present and not a string. The twin of Rust's `key_refs::row_key` refusal (PR 3 final r5, A2).
 *  `vouchingRows` refuses on one; `keysOfRemoved` (provider-flows.ts) takes no key id from one (PR 3 final, N5). */
export function malformedRow(r: ProviderValidateRow): boolean {
  const owned: unknown = r.appOwnedKey;
  const id: unknown = r.appKeyId;
  return (owned !== undefined && typeof owned !== "boolean") || (id !== undefined && typeof id !== "string");
}

/**
 * `savedText`'s `config validate` rows when they can say which app keys the saved list reads: one row per entry, none
 * of a malformed shape (`malformedRow`), and none that may read ANY app key (`appOwnedKey` with no `appKeyId`) — else
 * why not. Every delete of an app key the app did not just store and abandon (Remove's, Discard's, the wizard's
 * release) rests on it.
 */
export async function vouchingRows(savedText: string): Promise<{ ok: true; rows: ProviderValidateRow[] } | { ok: false; why: string }> {
  const labels = labelsOf(savedText);
  const v = await validated(savedText);
  if (!v.ok || labels === null) return { ok: false, why: "the saved settings could not be checked" };
  const covered = labels.every((_, i) => v.rows.some((r) => r.index === i));
  if (!covered || v.rows.length !== labels.length) return { ok: false, why: "not every provider in the saved list could be checked" };
  if (v.rows.some(malformedRow)) return { ok: false, why: "the saved settings' check answered a row the app cannot read" };
  if (v.rows.some((r) => r.appOwnedKey === true && r.appKeyId === undefined)) {
    return { ok: false, why: "another provider's key command may read any key the app stores" };
  }
  return { ok: true, rows: v.rows };
}

/** What `removeIfUnused` did with a key. */
export type UnusedOutcome = { kind: "kept"; why: string } | { kind: "inUse" } | { kind: "deleted" } | { kind: "notDeleted"; why: string };

/** With no saved config at all: keep the key (Settings) or delete it (the wizard's first run). */
export type NoConfigPolicy = "keep" | "delete";

/** THE RULE's check (module doc), on the CURRENT saved settings: `null` when no entry reads `keyId`, so it may be
 *  deleted — else why it is kept. */
async function heldNow(keyId: string, noConfig: NoConfigPolicy): Promise<Extract<UnusedOutcome, { kind: "kept" | "inUse" }> | null> {
  const unread = { kind: "kept", why: "the saved settings could not be read" } as const;
  let saved: { exists: boolean; text: string | null };
  try {
    saved = await configRead();
  } catch {
    return unread;
  }
  if (!saved.exists) return noConfig === "keep" ? unread : null;
  if (saved.text === null) return unread;
  const v = await vouchingRows(saved.text);
  if (!v.ok) return { kind: "kept", why: v.why };
  return v.rows.some((r) => r.appKeyId === keyId) ? { kind: "inUse" } : null;
}

/**
 * `key delete` of `keyId`, which a check of the saved settings has JUST cleared. Refused `busy`, it waits
 * `KEY_DELETE_RETRY_MS` and runs THE RULE's check again on the CURRENT saved settings (`noConfig` as given) before the
 * next attempt — kept, and not sent, when that check no longer clears it — up to `retry.tries` attempts in all.
 */
export async function deleteCleared(keyId: string, os: Os, noConfig: NoConfigPolicy, retry: DeleteRetry = DELETE_RETRY): Promise<UnusedOutcome> {
  for (let attempt = 1; ; attempt++) {
    const { why, busy } = await deleteOnce(keyId, os);
    if (why === null) return { kind: "deleted" };
    if (!busy || attempt >= retry.tries) return { kind: "notDeleted", why };
    await retry.sleep(KEY_DELETE_RETRY_MS);
    const held = await heldNow(keyId, noConfig);
    if (held !== null) return held;
  }
}

/** THE RULE (module doc): `key delete` of `keyId` only once the CURRENT saved settings show no entry reads it. */
export async function removeIfUnused(keyId: string, os: Os, noConfig: NoConfigPolicy, retry: DeleteRetry = DELETE_RETRY): Promise<UnusedOutcome> {
  return (await heldNow(keyId, noConfig)) ?? deleteCleared(keyId, os, noConfig, retry);
}
