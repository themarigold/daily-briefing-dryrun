// src/providers/base.ts — A3. What an API transport has that is NOT its wire format.
//
// Three things, all of them plumbing rather than protocol: the `runtimeWarnings` member every existing
// reader already knows how to read, the LAZY key resolution, and the `durationMs` stamp. Keeping them
// here is what lets `anthropic.ts` and `openaiCompatible.ts` each be a request-shape and a
// response-shape and nothing else — which is the whole argument for two implementations over one.
import type { Provider, ProviderApi } from "../types";
import { ProviderError } from "../types";
import { resolveApiKey, type ResolvedApiKey, type ResolveApiKeyOpts } from "../apiKey";
import { endpointUrl, isLoopbackHost } from "./endpoint";
import { TIMEOUT_MS } from "../provider";

export type ApiProviderOpts = {
  timeoutMs?: number;
  env?: Record<string, string | undefined>;
  /** Passed through to the key ladder so the inapplicable-setting warnings are raised once, here. */
  keyOpts?: ResolveApiKeyOpts;
  fetchImpl?: typeof fetch;
  now?: () => Date;
};

/**
 * ⚠ THIS DOES NOT PASS THROUGH `hardenedProvider`, AND THAT IS THE DESIGN.
 *
 * Every mechanism inside that wrapper is a property of a spawned CHILD: `--help` capability probing,
 * argv flag prepending, a private 0700 working directory, and deleting `ANTHROPIC_API_KEY` from the
 * child's environment. None has an HTTP analogue, and wrapping anyway would spawn a `--help` probe of a
 * label that is not a binary — producing a daily "capability probe failed" anomaly and a `degraded`
 * posture on every API run forever.
 *
 * What IS preserved is the INTERFACE: this class exposes the same `runtimeWarnings: string[]` member, so
 * `runtimeWarningsOf` in core.ts and `mergeWarnings` in the two scripts keep working with no edit. The
 * posture line then reads `unhardened (api provider)` — a fifth phrase beside the existing four, added
 * the same way the fourth (`unhardened (non-claude CLI)`) was added for codex users, and for the same
 * reason: claiming `full` would assert a property that was never applied, and claiming `degraded` would
 * report a considered configuration as a broken machine.
 */
export abstract class ApiTransport implements Provider {
  readonly runtimeWarnings: string[] = [];
  private keyMemo?: Promise<ResolvedApiKey>;
  /** Warnings from the key ladder are folded in exactly ONCE, however many times generate() is called
   *  (the eval fires three concurrent calls on one instance). */
  private keyWarningsFolded = false;
  /** Same fold-once discipline for the truncation warning — see `warnTruncated`. The eval fires three
   *  concurrent calls on ONE instance and `withRetry` can add three more, and an unguarded push put the
   *  identical sentence in the briefing warnings four times over. */
  private truncationWarned = false;

  constructor(protected readonly api: ProviderApi, protected readonly opts: ApiProviderOpts = {}) {
    // The carve-out sentinel. Emitted as an INLINE literal, deliberately: test/posture.test.ts scans
    // src/**/*.ts for warning literals at their emission site and fails on any it cannot classify, so a
    // helper call would make this channel invisible to the guard that exists to see it.
    this.runtimeWarnings.push(`provider hardening does not apply to this run: the ${api.kind} API provider spawns nothing, so there is no CLI process to harden — no flags were injected, no working directory was narrowed, and no child environment was withheld`);
    const u = endpointUrl(api);
    if (u && u.protocol === "http:" && !isLoopbackHost(u.hostname)) {
      // ONCE, at construction, not per call. Loopback http is silent — that is the normal local-model
      // setup and a daily warning for a correct configuration teaches people to ignore warnings.
      //
      // ⚠ THE CREDENTIAL IS NAMED, NOT JUST THE CONTEXT. The request the warning describes carries the
      // API KEY in a header, and a non-loopback endpoint is exactly the case where one is required — so
      // the strictly larger fact is that the key itself crosses the network unencrypted. The key is
      // still SENT: a user who deliberately configured a plain-http gateway gets the run they asked
      // for. But an earlier wording named only repository metadata, and someone reading it would
      // reasonably accept a trade they had not actually been shown.
      this.runtimeWarnings.push(`your API key AND the whole briefing context (commit subjects, file paths, branch names) will be sent in cleartext over plain http to ${u.host} — the key travels unencrypted in a request header on every run and anyone on the path can read it; use https, or point baseUrl at a loopback address`);
    }
  }

  /** The label that reaches `BriefingStruct.provider` and every error message. */
  abstract get label(): string;

  protected timeoutMs(): number { return this.opts.timeoutMs ?? TIMEOUT_MS; }

  /** Resolved ONCE and shared — a value memo would re-read a file and re-spawn a keychain helper on
   *  every concurrent call. A promise memo, for the same reason `hardenedProvider`'s capability probe
   *  is one. It can never reject: `resolveApiKey` returns warnings instead of throwing. */
  protected async key(): Promise<ResolvedApiKey> {
    this.keyMemo ??= resolveApiKey(this.api, this.opts.env ?? process.env, this.opts.keyOpts ?? {});
    const r = await this.keyMemo;
    if (!this.keyWarningsFolded) {
      this.keyWarningsFolded = true;
      // Pushed through a VARIABLE, not a literal: these strings name a path, a variable name or a
      // command — they are built in apiKey.ts and carry no posture meaning, so the source scan should
      // not see them here. (It sees the literals above, which is the channel it exists to police.)
      for (const w of r.warnings) this.runtimeWarnings.push(w);
    }
    return r;
  }

  /** `missing-binary` = PERMANENT for this run (withRetry rethrows it with zero attempts). An absent
   *  key is permanent in exactly that sense. The message names the SOURCE and never the value, and
   *  never says "install a CLI" — see the misnomer note in http.ts's mapStatus. */
  protected missingKey(): ProviderError {
    const named = this.api.apiKeyEnv ?? this.api.apiKeyFile ?? this.api.apiKeyCommand?.[0];
    return new ProviderError(
      "missing-binary",
      `${this.label}: no API key. ${named !== undefined
        ? `The configured source (${named}) produced nothing`
        : "Set provider.api.apiKeyEnv, apiKeyFile, apiKeyCommand or apiKey"} — see the warnings above for which source was tried.`,
    );
  }

  async generate(prompt: string): Promise<string> {
    // Stamp every ProviderError with how long the attempt took, exactly as BYOCliProvider.generate
    // does: the B6 ladder's fail-fast gate reads `durationMs`, and an unstamped error is invisible to it.
    const startedAt = performance.now();
    try {
      return await this.send(prompt);
    } catch (e) {
      if (e instanceof ProviderError && e.durationMs === undefined) e.durationMs = Math.round(performance.now() - startedAt);
      throw e;
    }
  }

  /** Raise the shared truncation-class warning. The model hit its OUTPUT CEILING — a different fact,
   *  with a different fix, from the CLI transport's held-pipe truncation.
   *
   *  ⚠ FOLDED TO ONCE PER INSTANCE, exactly as the key-ladder warnings above are. The eval fires three
   *  concurrent generate() calls on ONE instance and `withRetry` can call it three times more, so an
   *  unguarded push produced the identical sentence four times — in the briefing warnings and again in
   *  the EVAL.md posture detail cell, which has a 190-char budget. */
  protected warnTruncated(limit: number | undefined): void {
    // ⚠ A LATCH, NOT AN `includes()` DEDUPE ON THE PUSH — and the shape is load-bearing twice over. It
    // is the same fold-once pattern `keyWarningsFolded` uses (so the two warnings behave alike), AND it
    // keeps the warning LITERAL inline at the push below: test/posture.test.ts scans src/ for a warning
    // string sitting directly at its push site, so hoisting this one into a local first would silently
    // drop this emitter out of the coverage guard — the blind-spot class that guard exists to name.
    if (this.truncationWarned) return;
    this.truncationWarned = true;
    this.runtimeWarnings.push(`${this.label}: the model stopped at its output-token limit${limit !== undefined ? ` (max_tokens ${limit})` : ""}, so this result was cut off at the end — raise provider.api.maxTokens`);
  }

  protected abstract send(prompt: string): Promise<string>;
}
