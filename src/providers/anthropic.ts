// src/providers/anthropic.ts — A3/T4. The native Anthropic Messages API transport.
//
// ⚠ THE REQUEST BODY IS EXACTLY `{model, max_tokens, messages:[{role:"user", content: prompt}]}` AND
// NOTHING ELSE. No system prompt, no temperature, no tools, no stop sequences. That is not minimalism
// for its own sake — it is the NO-COMPARABILITY-BOUNDARY guarantee: `buildPrompt` builds the prompt
// upstream of the transport and hands it to `generate()` unchanged, so a briefing generated over HTTP
// is built from the same bytes as one generated through the CLI. A test asserts on the request body's
// KEY SET, so a future "just add a system prompt" fails loudly rather than silently opening a boundary
// between an EVAL.md row and every historical row above it.
import { ProviderError, API_LABEL_ANTHROPIC, type ProviderApi } from "../types";
import { ApiTransport, type ApiProviderOpts } from "./base";
import { postJson } from "./http";
import { ANTHROPIC_DEFAULT_BASE_URL, endpointUrl, requestUrl } from "./endpoint";

/** Anthropic REQUIRES `max_tokens`, so unlike the openai-compatible transport there is no "omit it"
 *  option — a default must exist. Sized for a briefing plus headroom. */
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

/** Pinned per the API's own versioning policy. A date, not "latest": the response shape this file
 *  parses is the shape this version promises. */
export const ANTHROPIC_VERSION = "2023-06-01";

export class AnthropicApiProvider extends ApiTransport {
  get label(): string { return API_LABEL_ANTHROPIC; }

  constructor(api: ProviderApi, opts: ApiProviderOpts = {}) { super(api, opts); }

  protected async send(prompt: string): Promise<string> {
    const { key } = await this.key();
    if (key === undefined) throw this.missingKey();

    const base = endpointUrl(this.api) ?? new URL(ANTHROPIC_DEFAULT_BASE_URL);
    // Trailing slashes normalized, and the configured QUERY STRING preserved — see `requestUrl`. Both
    // spellings are pinned by a test, because "it works on my config" is exactly how this class of bug
    // ships.
    const url = requestUrl(base, "/v1/messages");
    const maxTokens = this.api.maxTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS;

    const parsed = await postJson({
      url,
      headers: {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
      },
      body: { model: this.api.model, max_tokens: maxTokens, messages: [{ role: "user", content: prompt }] },
      timeoutMs: this.timeoutMs(),
      label: this.label,
      kind: "anthropic",
      // Handed over ONLY to be scrubbed back out of any diagnostic — see `diagnostic` in http.ts. The
      // header above is the only place it is ever sent.
      secret: key,
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
    }) as Record<string, unknown> | null;

    const blocks = Array.isArray(parsed?.content) ? parsed!.content as unknown[] : [];
    // CONCATENATE every `type === "text"` block IN ORDER and ignore the rest. A response can legally
    // carry thinking or tool blocks interleaved; dropping them is right (nothing downstream consumes
    // them) but dropping the text between them would silently truncate the briefing.
    const text = blocks
      .filter((b): b is Record<string, unknown> => !!b && typeof b === "object" && (b as Record<string, unknown>).type === "text")
      .map((b) => typeof b.text === "string" ? b.text : "")
      .join("");

    if (parsed?.stop_reason === "max_tokens") this.warnTruncated(maxTokens);

    // A 200 that parsed but carries no text. `empty-output` is RETRYABLE, which is right: the CLI path
    // classifies an empty stdout the same way, and a genuinely empty completion is more often a flake
    // than a permanent condition.
    if (text.trim() === "") {
      throw new ProviderError("empty-output", `${this.label}: the response contained no text content (stop_reason ${typeof parsed?.stop_reason === "string" ? parsed.stop_reason : "unknown"})`);
    }
    return text;
  }
}
