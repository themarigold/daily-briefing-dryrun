// src/providerFactory.ts — A3/T6. The ONE place a provider config becomes a provider.
//
// ⚠ ALL FOUR CONSTRUCTION SITES GO THROUGH HERE, and that is B10 restated for a new transport:
// "hardenedProvider MUST wrap all four construction sites, otherwise the eval stops measuring
// production". The sites are src/core.ts (the briefing), scripts/audit.ts (the audit judge) and
// scripts/eval.ts (twice: the case run and the eval judge). If the judges kept spawning a CLI while the
// briefing was generated over HTTP, the instrument would be grading a different provider than the thing
// it measures — and a user with NO CLI installed, which is now a supported configuration, could not run
// the audit or the eval at all.
//
// ONE factory rather than four `if` statements because four copies of a transport-selection decision is
// how the four sites drift, and this repo has a documented history of exactly that (the divergent `norm`
// in postcheck, the four inline spellings of DoneItem). `test/posture.test.ts` statically asserts that
// every `buildProvider(` call in the two scripts is a NAMED binding that reaches `mergeWarnings` — the
// same two properties it enforced for `hardenedProvider(` before this slice, re-pointed rather than
// weakened, because a vacuously-passing guard here is worse than none.
//
// A NEW MODULE rather than an addition to harden.ts: harden.ts's own header forbids it importing
// core.ts, and this file must be importable from core.ts, the two scripts AND the API providers without
// closing a cycle. Keeping it separate is what makes that true by construction.
import type { Config, Provider } from "./types";
import { hardenedProvider, type HardenedProvider, type HardenOpts } from "./harden";
import { AnthropicApiProvider } from "./providers/anthropic";
import { OpenAiCompatibleProvider } from "./providers/openaiCompatible";
import type { ApiProviderOpts } from "./providers/base";

/**
 * What `BriefingStruct.provider` records — the line that renders in the briefing header.
 *
 * CLI runs get `cfg.cli` verbatim, so existing output is BYTE-IDENTICAL (asserted, not assumed).
 * API runs get `<transport label> (<model>)`, e.g. `anthropic-api (claude-sonnet-5)`.
 *
 * WHY THE MODEL IS INCLUDED: it is the single most useful provenance fact for comparing two mornings,
 * and unlike a CLI — whose model is pinned in `provider.argv`, which the header already cannot show —
 * an API run's model is a first-class config field that changes briefing content when it changes. A
 * briefing whose text shifted because someone edited one config line, with nothing in the artifact
 * saying so, is the provenance hole this project keeps closing.
 */
export function providerLabel(cfg: Config["provider"]): string {
  return cfg.api === undefined ? cfg.cli : `${cfg.cli} (${cfg.api.model})`;
}

export type BuiltProvider = {
  /** Always present, and always carries `runtimeWarnings` — that member is the contract every existing
   *  reader (`runtimeWarningsOf`, `mergeWarnings`) depends on, and it is why the API transports expose
   *  it despite not being hardened. */
  provider: Provider & { runtimeWarnings: string[] };
  /** The C1/B6 hardening ladder's members — `hardeningActive` / `disableHardening` /
   *  `probeWithoutHardening`. Present ONLY for the CLI shape.
   *
   *  ⚠ `undefined` here means "no ladder", NOT "we did not build the transport". core.ts used to conflate
   *  those two meanings in one local and T7 splits them; anything reading this field is asking the ladder
   *  question, never the ownership question. */
  laddered?: HardenedProvider;
};

export type BuildProviderOpts = HardenOpts & {
  /** Injected by tests for the API shape; production passes nothing. */
  api?: Pick<ApiProviderOpts, "env" | "fetchImpl" | "now">;
};

/**
 * Build the transport `cfg` describes.
 *
 * CLI shape → `hardenedProvider(...)` as BOTH fields, byte-identical to what every site built before
 * this slice (same opts object, same wrapper, same ladder).
 *
 * API shape → the matching transport as `provider`, with `laddered` undefined. `opts.env` is DROPPED:
 * its only production content is `CLAUDE_CONFIG_DIR`, which selects a CLI login directory and is
 * meaningless over HTTP. Dropping it silently would be the failure this whole slice is careful about, so
 * the inapplicable settings (`accounts`, `credential`, `harden`) are handed to the key ladder, which
 * raises one warning each into the provider's `runtimeWarnings`.
 */
export function buildProvider(cfg: Config["provider"], opts: BuildProviderOpts = {}): BuiltProvider {
  if (cfg.api === undefined) {
    const { api: _ignored, ...hardenOpts } = opts;
    const h = hardenedProvider(cfg, hardenOpts);
    return { provider: h, laddered: h };
  }
  // ⚠ `opts.timeoutMs` FIRST, mirroring the CLI branch — where `hardenedProvider` hands the whole opts
  // object to `BYOCliProvider`, whose ceiling is `opts.timeoutMs ?? TIMEOUT_MS` and never `cfg.timeoutMs`.
  // The api branch read `cfg.timeoutMs` alone, so the audit and eval judges — which call
  // `buildProvider(judgeCfg, { timeoutMs: 240_000 })` because the judge prompt is the longest call this
  // tool makes — silently ran at 120 000 ms instead. The only guard was a source-TEXT regex over
  // scripts/audit.ts asserting the literal `240_000` is present, which passed vacuously while the value
  // was discarded; a behavioural assertion now sits beside it.
  const timeoutMs = opts.timeoutMs ?? cfg.timeoutMs;
  const apiOpts: ApiProviderOpts = {
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    ...(opts.api?.env ? { env: opts.api.env } : {}),
    ...(opts.api?.fetchImpl ? { fetchImpl: opts.api.fetchImpl } : {}),
    ...(opts.api?.now ? { now: opts.api.now } : {}),
    keyOpts: {
      ...(cfg.credential !== undefined ? { providerCredential: cfg.credential } : {}),
      ...(cfg.harden !== undefined ? { providerHarden: cfg.harden } : {}),
      ...(cfg.accounts !== undefined ? { providerAccounts: cfg.accounts } : {}),
    },
  };
  const provider = cfg.api.kind === "anthropic"
    ? new AnthropicApiProvider(cfg.api, apiOpts)
    : new OpenAiCompatibleProvider(cfg.api, apiOpts);
  return { provider };
}
