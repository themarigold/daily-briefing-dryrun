/**
 * P3-M6-T3 — first-time setup: paste your key (spec r9 §6 "First-time setup"; plan P3-M6-T3). The steps between the
 * wizard's API path and the engine's `provider` verbs; `routes/Wizard.svelte` holds the state, `lib/wizard.ts` the
 * draft and its rules (it performs no IPC — this module does, through `lib/engine.ts`'s wrappers only).
 *
 *  • PASTE = `config validate` of the keyless candidate → `key set` → `config validate` of the candidate with the
 *    answered reference → `provider test` of item 1 (`--index` 0) with that row's own `testTimeoutMs`, unchanged
 *    (`testPlan` → `testModeFor`). The candidate is exactly what the wizard's one save would write (`savePlan`): a
 *    create on a first run, the merge over the saved document on a re-run. The keyless candidate is validated first,
 *    so a setup the engine refuses anyway stores no key.
 *  • ⚠ THE PASTED KEY GOES TO `providerKeySet` AND NOWHERE ELSE: never into a candidate text (it carries the
 *    reference `key set` answered), never into a line, a log, a thrown error or anything returned. It is a parameter of
 *    `pasteKey`, handed straight to `providerKeySet` and dropped. This module holds no state.
 *  • A `key set` REFUSAL THAT NAMES A `keyId` (its cleanup unconfirmed, gui-seam §1d) → `key delete --id` it, once; a
 *    candidate refused WITH the key → the key is deleted again.
 *  • RELEASE (`releaseKey`) = `key delete` of a stored key the wizard is not going to use — only once the CURRENT
 *    saved settings show that no entry reads it. That is THE unused-key rule, `lib/unused-key.ts`'s `removeIfUnused`,
 *    shared with Settings (checkpoint P3-M6): the key is KEPT when any saved row carries its id, when a row may read ANY
 *    app key, when the rows do not cover every entry, or when the settings cannot be read. The one case the two screens
 *    decide differently is a parameter: with no saved config at all, the wizard passes `"delete"` (a first run —
 *    nothing references the key), Settings `"keep"`.
 *
 * ⚠ NOT `lib/provider-flows.ts`'s Add: this module does not import it. Its wording helpers are reused from
 * `lib/settings-model.ts`, and the `key set` answer's reference and refusal wording (`referenceIn`,
 * `keySetRefusalLine`, "Not stored: …") from `lib/unused-key.ts`, shared with Add (PR 3 final r1, B5).
 *
 * Every function answers in lines for the screen and never throws for an engine answer or an IPC rejection.
 */
import { providerCandidateCheck, providerKeySet } from "./engine";
import { describeFailure, type ConfigDocument } from "./files";
import type { Os } from "./platform";
import { isObject } from "./provider-list";
import { keyTimeoutLine, testFailureLine, testPlan, testResultLines } from "./settings-model";
import { deleteKey, KEY_LEFT_FOR_UNINSTALL, keySetRefusalLine, referenceIn, removeIfUnused, timedOut, validated } from "./unused-key";
import { savePlan, type KeyTest, type PastedKey, type WizardDraft } from "./wizard";

/** What the paste step tells the user before they paste — where the key goes, per OS. */
export function pasteKeyNote(os: Os): string {
  const store =
    os === "macos"
      ? "stores it in your Mac's Keychain"
      : "stores it in a file only you can read, in its own key folder";
  return (
    `Paste your Anthropic API key. The engine ${store}; the settings file keeps only a reference to it, and the ` +
    "key is never shown again. Store and test then checks it with one tiny request, billed to your key."
  );
}

/** What a paste, a Test again or a release answered: the pasted key (`null` when none is stored) and lines to show. */
export interface KeyStep {
  pasted: PastedKey | null;
  lines: string[];
}

type Doc = Pick<ConfigDocument, "exists" | "text" | "base"> | null;

/** The text the wizard's one save would write for `draft` over `doc`, or why it cannot be built. */
function candidate(doc: Doc, draft: WizardDraft): { ok: true; text: string } | { ok: false; message: string } {
  try {
    return { ok: true, text: savePlan(doc ?? { exists: false, text: null, base: null }, draft).text };
  } catch (e) {
    return { ok: false, message: describeFailure(e) };
  }
}

/** Validate `text`, then Test item 1 with its own row: `refused` (the candidate is not one the save would write), or
 *  the Test's outcome — `not-run` when the engine did not run it. */
async function validateThenTest(text: string): Promise<{ kind: "refused"; message: string } | { kind: "tested"; test: KeyTest; lines: string[] }> {
  const v = await validated(text);
  if (!v.ok) return { kind: "refused", message: v.message };
  const plan = testPlan(v.check, 0);
  if (plan.kind === "refuse") return { kind: "tested", test: "not-run", lines: [plan.message] };
  try {
    const t = await providerCandidateCheck(text, plan.mode);
    const ran = t.kind === "tested" && t.answer.ok === true;
    const passed = ran && t.kind === "tested" && t.answer.ok === true && t.answer.passed;
    return { kind: "tested", test: passed ? "passed" : ran ? "failed" : "not-run", lines: testResultLines(t) };
  } catch (e) {
    return { kind: "tested", test: "not-run", lines: [testFailureLine(e)] };
  }
}

/** Where a key can come from instead, in the wizard, on a platform that cannot keep a pasted one — Windows, the one
 *  `unsupported-platform` (`src/keyStore.ts`): a command, not a key file (POSIX modes, docs/PROVIDERS.md "Windows"). */
const PASTE_UNSUPPORTED_INSTEAD = "Choose Advanced and give a command that prints the key instead.";

/** Remove a key this paste stored and will not use (nothing was saved with it yet). */
async function removeStored(id: string, os: Os): Promise<string> {
  const why = await deleteKey(id, os);
  return why === null ? "The key you pasted was removed again." : `The key you pasted could not be removed (${why}); ${KEY_LEFT_FOR_UNINSTALL}.`;
}

/**
 * Store and test: `key` goes to `providerKeySet` only; the draft's candidate (with the answered reference) is
 * validated and item 1 tested. Answers the pasted key — `passed`, `failed` or `not-run` — or `null` with why, in which
 * case nothing is left stored. `draft` is not changed (its own `pasted` is ignored: this key replaces it).
 */
export async function pasteKey(doc: Doc, draft: WizardDraft, key: string, os: Os): Promise<KeyStep> {
  if (key.trim() === "") return { pasted: null, lines: ["Paste your API key first."] };
  const keyless = { ...draft, providerPath: "api" as const, apiKeyAdvanced: false, pasted: null, apiKeyFile: "", apiKeyCommand: "" };
  const bare = candidate(doc, keyless);
  if (!bare.ok) return { pasted: null, lines: [`Not stored: ${bare.message}`] };
  // The keyless candidate first: a setup the engine refuses anyway stores no key.
  const pre = await validated(bare.text);
  if (!pre.ok) return { pasted: null, lines: [`Not stored: ${pre.message}`] };

  let payload;
  try {
    payload = (await providerKeySet(key)).payload;
  } catch (e) {
    if (timedOut(e)) return { pasted: null, lines: [`Not stored: storing the key did not finish in time — ${keyTimeoutLine(os)}.`] };
    const field = isObject(e) && e["kind"] === "invalidInput" ? "the key is empty or too long" : null;
    return { pasted: null, lines: [`Not stored: ${field ?? describeFailure(e)}.`] };
  }
  if (payload === null) return { pasted: null, lines: ["Not stored: the engine stopped before replying, so the key may or may not have been stored."] };
  if (payload.ok !== true) {
    const lines = [keySetRefusalLine(payload, os, "stored", PASTE_UNSUPPORTED_INSTEAD)];
    // Cleanup unconfirmed (gui-seam §1d): retry the delete of exactly that id.
    if (typeof payload.keyId === "string") lines.push(await removeStored(payload.keyId, os));
    return { pasted: null, lines };
  }
  const ref = referenceIn(payload);
  if (ref === null) return { pasted: null, lines: ["Not stored: the engine's answer named no key reference.", await removeStored(payload.keyId, os)] };

  const stored: PastedKey = { keyId: payload.keyId, ref, test: "not-run", useAnyway: false };
  const cand = candidate(doc, { ...keyless, pasted: stored });
  if (!cand.ok) return { pasted: null, lines: [`Not stored: ${cand.message}`, await removeStored(stored.keyId, os)] };
  // Here the engine's https rule applies: the entry's key is now app-owned.
  const t = await validateThenTest(cand.text);
  if (t.kind === "refused") return { pasted: null, lines: [`Not stored: ${t.message}`, await removeStored(stored.keyId, os)] };
  return { pasted: { ...stored, test: t.test }, lines: ["The key was stored.", ...t.lines] };
}

/** Test the stored key again, on the draft as it is now (no second `key set`). A refusal keeps the key — it is still
 *  the user's to Discard — as `not-run`. */
export async function retestKey(doc: Doc, draft: WizardDraft): Promise<KeyStep> {
  const p = draft.pasted;
  if (p === null) return { pasted: null, lines: ["Paste your API key first."] };
  const fresh: PastedKey = { ...p, test: "not-run", useAnyway: false };
  const cand = candidate(doc, { ...draft, providerPath: "api", apiKeyAdvanced: false, pasted: fresh });
  if (!cand.ok) return { pasted: fresh, lines: [`Not tested: ${cand.message}`] };
  const t = await validateThenTest(cand.text);
  if (t.kind === "refused") return { pasted: fresh, lines: [`Not tested: ${t.message}`] };
  return { pasted: { ...fresh, test: t.test }, lines: t.lines };
}

/**
 * Release a stored key the wizard will not use: `key delete` of its id — only once the CURRENT saved settings show
 * that no entry reads it. The rule is `lib/unused-key.ts`'s `removeIfUnused`, Settings' own, with the no-config case
 * decided `"delete"`: on a first run there are no settings, so nothing references it. Kept, and said, when a saved row
 * carries the id, when the rows cannot vouch for every entry, or when the settings cannot be read. The caller releases
 * a key once (it drops the draft's `pasted` first).
 */
export async function releaseKey(p: PastedKey, os: Os): Promise<string[]> {
  const out = await removeIfUnused(p.keyId, os, "delete");
  switch (out.kind) {
    case "kept":
      return [`The key you pasted was kept: ${out.why}; ${KEY_LEFT_FOR_UNINSTALL}.`];
    case "inUse":
      return ["The key you pasted was kept: your saved settings use it."];
    case "deleted":
      return ["The key you pasted was removed."];
    case "notDeleted":
      return [`The key you pasted could not be removed (${out.why}); ${KEY_LEFT_FOR_UNINSTALL}.`];
  }
}
