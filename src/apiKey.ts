// src/apiKey.ts — A3/T3. The four-rung API key sourcing ladder.
//
// ⚠ THE ONE NEW PLACE THIS PROJECT HANDLES A SECRET. The invariant, stated once and enforced by a
// sentinel test rather than by care: THE KEY VALUE NEVER APPEARS IN A WARNING, AN ERROR MESSAGE, A LOG
// LINE OR A RETURN FIELD OTHER THAN `key`. Not truncated, not length-reported, not "starts with". Every
// diagnostic below names the SOURCE — a variable name, a path, a command's argv[0] — and nothing else.
//
// SHAPED LIKE `resolveAccounts`/`resolveTranscripts`: it never throws, it returns warnings alongside the
// result. A throw from key resolution would land at main.ts's `Config error:` + exit 2 on every 600s
// tick, which is total non-delivery for a condition (a key that is not there yet) the user can fix.
//
// THE APP-OWNED KEY STORE, and why it is the only built-in one (provider fallback PR 2, spec r9 §6, §9 —
// this replaces the old "no built-in OS keychain" ruling, which src/calendar/link-url.ts and
// docs/PROVIDERS.md also cite). An app-owned key is stored by the engine (`provider key set` / `key migrate`,
// src/keyStore.ts — the desktop app's key settings, which will paste keys into these commands, ship later, P3)
// and the config gets a REFERENCE to it, read through the ordinary rungs below:
//   • macOS: the login Keychain, service `daily-briefing.app-key`, one item per key id. The item is
//     created by `/usr/bin/security` and read back by the same binary (an `apiKeyCommand`, rung 3), so the
//     cross-binary authorization DIALOG that stood behind the old ruling does not arise: the day-0 spike
//     (2026-10-16) read such an item from a launchd-spawned process with no dialog. What remains is a
//     LOCKED keychain, whose read blocks on an unlock dialog (measured: 40 s+); the 5 s command bound kills
//     it and the entry is `key-unavailable` ("key couldn't be read"), the walk moving on — but the dialog
//     stays on screen for the user to find. An item created by ANY OTHER binary still carries the old
//     hazard, which is why `doctor --json` never runs a key command.
//   • Linux (any platform but darwin and win32): a 0600 file `<state>/keys/k-<12 hex>.key` in a 0700 folder
//     (an `apiKeyFile`, rung 2), read by the strict reader below. libsecret is still not used: it needs a
//     live D-Bus session and an unlocked keyring, which a systemd user timer or a headless box does not
//     reliably have.
//   • Windows: nothing built in. No first-party CLI prints a stored secret, and the file store refuses it
//     (`unsupported-platform`: the strict reader needs POSIX owners and modes).
// A key the user keeps elsewhere still goes through `apiKeyCommand` (rung 3), which delegates to whichever
// helper the USER already trusts, costs zero platform code and zero new dependencies, and is the same
// escape-hatch shape `claude`'s own key helper uses. An app-owned key is never sent over plain `http:` to
// another machine (`insecureEndpoint`, src/core.ts; `config validate`).
//
// THREAT MODEL, for the reviewer who will raise it: rung 3 executes a command named in the config. But
// `provider.cli` is ALREADY an arbitrary config-named binary that this tool spawns every morning — the
// config is user-owned and no new authority is introduced here.
import { stat } from "node:fs/promises";
import type { ProviderApi } from "./types";
import { run } from "./proc";
import { keyOptional } from "./providers/endpoint";
import { readStrictFile, type AsyncFsOps, type StrictReadOpts } from "./strictFile";
import { isAppKeyFileName, keyFileReadOpts, readsAsAppKeyFile, strictReadFolder } from "./keyFile";
import { keysDir } from "./marker";

/** Which rung answered. A short stable token, safe to print — it names a SOURCE, never a value. */
export type ApiKeySource = "env" | "file" | "command" | "config" | "none";

export type ResolvedApiKey = {
  key?: string;
  source: ApiKeySource;
  /** For `env`, the variable NAME; for `file`, the path; for `command`, argv[0]. Never the key. */
  detail?: string;
  /** Present, and `false`, ONLY when `opts.skipCommand` stopped rung 3 from spawning — so a reader can
   *  tell "the command ran and produced nothing" from "the command was never run". Never `true`: the
   *  absence of this field is the normal case. */
  executed?: false;
  /** TRUE when this endpoint needs no key AT ALL — a loopback openai-compatible server (Ollama, LM
   *  Studio, a local vLLM). Distinguishes "no key, and that is correct" from "no key, and the run will
   *  fail", which `init` and `doctor` must not conflate: telling someone running Ollama to go set a key
   *  is advice that cannot be acted on and teaches them to ignore the line. */
  optional?: boolean;
  warnings: string[];
};

/** The conventional variable each kind falls back to when the user configured no source at all. */
export const DEFAULT_KEY_ENV: Record<ProviderApi["kind"], string> = {
  anthropic: "ANTHROPIC_API_KEY",
  "openai-compatible": "OPENAI_API_KEY",
};

/** Rung 3's ceiling. Short on purpose: a keychain helper that needs longer than this at 07:20 is one
 *  that is waiting for a human, and the morning must not wait with it. `proc.run` enforces it with
 *  SIGKILL and races the pipe reads, so a helper whose child holds stdout cannot hang the run either. */
export const KEY_COMMAND_TIMEOUT_MS = 5_000;

/** The plaintext-in-config warning. A CONSTANT because three places must agree on it: this module
 *  emits it, `init` prints the same advice after chmod'ing the file, and the posture guard's
 *  NON_POSTURE list names it — it describes a CREDENTIAL HYGIENE choice, not hardening. */
export const PLAINTEXT_KEY_SENTINEL = "api key is stored in PLAINTEXT in the config file";

export type ResolveApiKeyOpts = {
  /** Injected so the file rung is testable without a real stat. The LAX check only: a file in the app's key folder
   *  never reaches it (P2-M5-T1). */
  statFile?: (p: string) => Promise<{ mode: number } | undefined>;
  /** The app's key folder an `apiKeyFile` is judged against (P2-M5-T1). Defaults to `keysDir()`; injected by tests. */
  keysDir?: string;
  /** The strict reader's owner test for a key-folder file (`StrictReadOpts.ownerCheck`). Injected ONLY by tests,
   *  which cannot chown a file to another user. */
  keyFileOwnerCheck?: StrictReadOpts["ownerCheck"];
  /** The filesystem the key-folder test runs on (`readsAsAppKeyFile` and its two siblings, src/keyFile.ts — async since
   *  PR 2 final harden round 3, M1). Injected ONLY by tests (a stalled mount); production uses `fs/promises`. */
  keyFileFs?: AsyncFsOps;
  /** Injected so the command rung is testable without spawning. */
  exec?: typeof run;
  /** Overrides KEY_COMMAND_TIMEOUT_MS for bounded callers (the summary uses the smaller of its remaining
   *  work allowance and KEY_COMMAND_TIMEOUT_MS), and tests exercising the real timeout with a shorter wait.
   *  Absent keeps the morning command rung at its existing 5 s ceiling. */
  commandTimeoutMs?: number;
  /** ⚠ READ-ONLY MODE FOR RUNG 3. Set by callers that DIAGNOSE a config rather than run it — today
   *  exactly one, `doctor --json`. Reporting a configured `apiKeyCommand` must not SPAWN it: `doctor`
   *  is documented as a read-only surface, it is the thing people run in scripts and CI, and a keychain
   *  helper is the one config-named binary in this project that can block for its whole 5 s ceiling or
   *  pop an authorization or unlock DIALOG (the hazards the module header above records: an item another
   *  binary created, or a locked keychain). With this set, rung 3 reports `{ source: "command", detail: argv[0],
   *  executed: false }` and no key — argv[0] ONLY, because later argv elements routinely name the
   *  keychain item being fetched. */
  skipCommand?: boolean;
  /** The whole `provider` block, so the "credential has no effect" warning can be raised here — the
   *  same place every other api-related config diagnostic is raised. Optional: the provider tests call
   *  this with an api block alone. */
  providerCredential?: string;
  providerHarden?: boolean;
  providerAccounts?: unknown;
};

async function defaultStat(p: string): Promise<{ mode: number } | undefined> {
  try { return { mode: (await stat(p)).mode }; } catch { return undefined; }
}

/**
 * Resolve the API key. FIRST HIT WINS over the configured rungs, in this order:
 *
 *   1. `apiKeyEnv`      — a NAMED environment variable.
 *   2. `apiKeyFile`     — a path. Group/world-readable ⇒ REFUSED with a warning, never silently read. A file in the
 *                         app's key folder (`<state>/keys/`) is read ONLY by the strict reader (P2-M5-T1).
 *   3. `apiKeyCommand`  — an argv whose stdout is the key (the keychain story).
 *   4. `apiKey`         — literal plaintext in config.json. Supported, warned about on every run.
 *
 * ⚠ ONLY CONFIGURED SOURCES ARE TRIED. If the user named a file or a command, there is NO silent
 * fallback to an ambient environment variable — that fallback is how a key you thought you had retired
 * keeps being spent. The conventional variable is consulted ONLY when no rung at all was configured.
 *
 * A key is "absent" rather than empty: every rung trims, and a whitespace-only result counts as
 * nothing found, so a stray newline in a secrets file does not become a key that 401s every morning.
 */
export async function resolveApiKey(
  api: ProviderApi,
  env: Record<string, string | undefined> = process.env,
  opts: ResolveApiKeyOpts = {},
): Promise<ResolvedApiKey> {
  const warnings: string[] = [];

  // ── inapplicable CLI-shaped settings, reported rather than silently ignored ──────────────────────
  // Not a throw: none of these can change WHICH TRANSPORT RUNS, so the mutual-exclusion argument that
  // makes `cli`/`argv`/`promptVia` a hard error does not reach them. They follow the
  // resolveAccounts/resolveTranscripts convention instead — warn, and carry on.
  if (opts.providerCredential !== undefined) {
    warnings.push('config: "provider.credential" selects whether a spawned CLI may see ANTHROPIC_API_KEY and has no effect for an API provider — the key comes from provider.api\'s sourcing ladder; ignored');
  }
  if (opts.providerHarden !== undefined) {
    warnings.push('config: "provider.harden" injects flags into a spawned CLI and has no effect for an API provider (there is no child process to harden); ignored');
  }
  if (Array.isArray(opts.providerAccounts) && opts.providerAccounts.length > 0) {
    warnings.push('config: "provider.accounts" selects a CLI login directory via CLAUDE_CONFIG_DIR and does not apply to an API provider; ignored');
  }

  const configured = api.apiKeyEnv !== undefined || api.apiKeyFile !== undefined ||
                     api.apiKeyCommand !== undefined || api.apiKey !== undefined;

  // ── rung 1: a named environment variable ────────────────────────────────────────────────────────
  const envName = api.apiKeyEnv ?? (configured ? undefined : DEFAULT_KEY_ENV[api.kind]);
  if (envName !== undefined) {
    const v = (env[envName] ?? "").trim();
    if (v !== "") return { key: v, source: "env", detail: envName, warnings };
    if (api.apiKeyEnv !== undefined && api.apiKeyFile === undefined && api.apiKeyCommand === undefined && api.apiKey === undefined) {
      warnings.push(`api key: $${envName} is configured (provider.api.apiKeyEnv) but is empty or unset in this process's environment`);
    }
  }

  // ── rung 2: a file ──────────────────────────────────────────────────────────────────────────────
  // ⚠ A FILE IN THE APP'S KEY FOLDER (provider-fallback P2-M5-T1, spec r9 §6 "Strict reader") is one the app wrote, so
  // it is read only as the app writes it — `k-<12 hex>.key`, 0600, one link, directly in the 0700 `<state>/keys/` —
  // through the strict reader, opening the path AS CONFIGURED (the canonical form is case-folded on darwin and is for
  // comparison only). Which paths count is src/keyFile.ts's `readsAsAppKeyFile`, built on the same relation as
  // `isAppOwnedKey`. Anything else there is REFUSED and never handed to the lax check below. A refusal is warned and
  // the ladder moves on exactly as after today's failed file rung; with no later rung the provider raises the named
  // `key-unavailable` skip (`missingKey`). The warnings name the path as configured, as today's do, and nothing it
  // resolves to. The folder the strict reader checks is the configured path's own parent when that is canonically
  // `keys/` (`strictReadFolder`: a different symlinked ancestor is not a different folder), else `keys/`. Every other
  // `apiKeyFile` keeps today's mode-only check, unchanged.
  // ⚠ ASYNC (final harden round 3, M1): the key-folder test stats and walks, on EVERY `apiKeyFile` — a user's own file on
  // a dead mount included — so it runs on `fs/promises`: a stall there must not block the event loop, or the attempt
  // deadline that exists for exactly that case (src/core.ts `attemptDeadlineMs`) could not fire.
  const keys = opts.keysDir ?? keysDir();
  if (api.apiKeyFile !== undefined && await readsAsAppKeyFile(api.apiKeyFile, keys, opts.keyFileFs)) {
    const path = api.apiKeyFile;
    if (!(await isAppKeyFileName(path, opts.keyFileFs))) {
      warnings.push(`api key: refusing to read provider.api.apiKeyFile ${path} — it is, or may name, a file in the app's key folder but is not an app key file (k-<12 hex>.key)`);
    } else {
      const read = await readStrictFile(path, {
        ...keyFileReadOpts(await strictReadFolder(path, keys, opts.keyFileFs)),
        ...(opts.keyFileOwnerCheck !== undefined ? { ownerCheck: opts.keyFileOwnerCheck } : {}),
      });
      if (read.status === "ok") {
        const v = read.text.trim();
        if (v !== "") return { key: v, source: "file", detail: path, warnings };
        warnings.push(`api key: provider.api.apiKeyFile ${path} is empty`);
      } else if (read.status === "refused") {
        // The reason is a fixed token (`StrictRefusedReason`): it carries no path and no byte of the file.
        warnings.push(`api key: refusing to read provider.api.apiKeyFile ${path} — it is, or may name, a file in the app's key folder, and such a file is read only as the app wrote it: a private, single-link regular file directly in that private folder (${read.reason})`);
      } else {
        warnings.push(`api key: provider.api.apiKeyFile ${path} could not be read`);
      }
    }
  } else if (api.apiKeyFile !== undefined) {
    const path = api.apiKeyFile;
    const st = await (opts.statFile ?? defaultStat)(path);
    if (st === undefined) {
      warnings.push(`api key: provider.api.apiKeyFile ${path} could not be read`);
    } else if ((st.mode & 0o077) !== 0) {
      // REFUSE, do not chmod. Silently widening or narrowing permissions on somebody else's file is a
      // side effect a config reader has no business having — and reading it anyway would make the
      // check theatre. Same spirit as `safeOwnDir` in harden.ts, which refuses rather than repairs.
      warnings.push(`api key: refusing to read provider.api.apiKeyFile ${path} — it is group- or world-readable (mode ${(st.mode & 0o777).toString(8).padStart(3, "0")}); run \`chmod 600\` on it`);
    } else {
      let text: string | undefined;
      try { text = await Bun.file(path).text(); } catch { text = undefined; }
      if (text === undefined) warnings.push(`api key: provider.api.apiKeyFile ${path} could not be read`);
      else {
        const v = text.trim();
        if (v !== "") return { key: v, source: "file", detail: path, warnings };
        warnings.push(`api key: provider.api.apiKeyFile ${path} is empty`);
      }
    }
  }

  // ── rung 3: a command (the keychain story) ──────────────────────────────────────────────────────
  if (api.apiKeyCommand !== undefined && api.apiKeyCommand.length > 0) {
    const argv = api.apiKeyCommand;
    const name = argv[0]!;
    // ⚠ THE READ-ONLY EXIT, and it returns rather than falling through: a diagnostic caller must see
    // "rung 3 is what answers for this config, and we did not run it", not "nothing was configured".
    // Returning here also means rung 4 is not consulted, which is right — rung 3 wins in a real run too.
    if (opts.skipCommand === true) return { source: "command", detail: name, executed: false, warnings };
    // Bounded by `proc.run`: a hard SIGKILL ceiling plus a raced post-exit flush, so neither a helper
    // that hangs nor one whose child inherits stdout can hold the morning.
    const timeoutMs = opts.commandTimeoutMs ?? KEY_COMMAND_TIMEOUT_MS;
    const r = await (opts.exec ?? run)(argv, { timeoutMs, flushMs: 500 });
    // ⚠ NOTHING FROM `r.out` OR `r.err` IS EVER PUT IN A WARNING. stdout IS the secret, and stderr from
    // a keychain helper routinely echoes the item it was asked for. Only the exit code and argv[0].
    if (!r.spawned) {
      warnings.push(`api key: provider.api.apiKeyCommand could not be run (\`${name}\` — is it installed and on PATH?)`);
    } else if (r.timedOut) {
      warnings.push(`api key: provider.api.apiKeyCommand (\`${name}\`) did not finish within ${timeoutMs}ms — a helper waiting for a human cannot work on an unattended run`);
    } else if (r.code !== 0) {
      warnings.push(`api key: provider.api.apiKeyCommand (\`${name}\`) exited ${r.code} — its output is not shown, because it would be the key`);
    } else {
      const v = r.out.trim();
      if (v !== "") return { key: v, source: "command", detail: name, warnings };
      warnings.push(`api key: provider.api.apiKeyCommand (\`${name}\`) succeeded but printed nothing`);
    }
  }

  // ── rung 4: literal plaintext in the config ─────────────────────────────────────────────────────
  if (api.apiKey !== undefined && api.apiKey.trim() !== "") {
    warnings.push(`config: ${PLAINTEXT_KEY_SENTINEL} (provider.api.apiKey) — \`daily-briefing init\` sets the file to mode 600, but apiKeyEnv, apiKeyFile or apiKeyCommand keep it out of the file entirely`);
    return { key: api.apiKey.trim(), source: "config", warnings };
  }

  // ── nothing found ───────────────────────────────────────────────────────────────────────────────
  // A LOOPBACK openai-compatible endpoint needs no key at all (Ollama, LM Studio, a local vLLM), so its
  // absence is not a defect and must not warn — a daily warning for a correct configuration is how
  // users learn to ignore warnings.
  const localNoKey = keyOptional(api);
  if (!localNoKey && !configured) {
    warnings.push(`api key: no key found — $${DEFAULT_KEY_ENV[api.kind]} is unset and no apiKeyEnv/apiKeyFile/apiKeyCommand/apiKey is configured in provider.api`);
  }
  return { source: "none", ...(localNoKey ? { optional: true } : {}), warnings };
}

/** One line for `init` and `doctor`: WHICH source answered, never anything about the value.
 *  Exported so the two surfaces cannot word it differently and drift. */
export function keyStatusLine(r: ResolvedApiKey): string {
  // ⚠ The two no-key cases are DIFFERENT and must not share a line. Measured on a real
  // `init --provider openai-compatible --base-url http://127.0.0.1:11434/v1`: the generic wording told
  // a correctly-configured Ollama user to go set a key they do not need.
  if (r.key === undefined && r.optional === true) return "API key: not required — this is a loopback endpoint";
  // The read-only case is a THIRD no-key state and must not be worded as a failure: nothing was tried.
  if (r.key === undefined && r.executed === false) return `API key: provider.api.apiKeyCommand (\`${r.detail}\`) is configured — NOT RUN by this read-only check`;
  if (r.key === undefined) return "API key: not found — set it, or add apiKeyFile/apiKeyCommand to provider.api";
  switch (r.source) {
    case "env": return `API key: found in $${r.detail}`;
    case "file": return `API key: found in ${r.detail}`;
    case "command": return `API key: found via provider.api.apiKeyCommand (\`${r.detail}\`)`;
    default: return "API key: found in the config file (plaintext — see the warning above)";
  }
}
