// src/providers/openaiCompatible.ts — A3/T5. One transport for OpenAI, Ollama, LM Studio and vLLM.
//
// Same no-comparability-boundary guarantee as the Anthropic transport: the body is exactly
// `{model, messages:[{role:"user", content: prompt}]}` — no system prompt, no temperature, no tools, no
// stop sequences — and a test asserts on the KEY SET so an addition fails loudly.
//
// TWO COMPATIBILITY CHOICES, both deliberate and both directly pinned by tests:
//
//  1. `Authorization` IS OMITTED ENTIRELY when no key resolved — not sent as `Bearer ` with an empty
//     value. Ollama and LM Studio need no key at all, and some servers reject a malformed header
//     outright, so a well-meaning empty header turns a working local setup into a 401.
//  2. `max_tokens` IS OMITTED unless the user set `provider.api.maxTokens`. OpenAI has been migrating
//     newer models to `max_completion_tokens` while Ollama and vLLM accept `max_tokens`; omission is
//     the compatible superset and lets the server's own default apply. (Anthropic is the opposite case
//     — it REQUIRES the field — which is one more reason these are two files.)
import { ProviderError, API_LABEL_OPENAI, type ProviderApi } from "../types";
import { ApiTransport, type ApiProviderOpts } from "./base";
import { postJson } from "./http";
import { endpointUrl, isLoopbackHost, requestUrl } from "./endpoint";

export class OpenAiCompatibleProvider extends ApiTransport {
  get label(): string { return API_LABEL_OPENAI; }

  constructor(api: ProviderApi, opts: ApiProviderOpts = {}) { super(api, opts); }

  protected async send(prompt: string): Promise<string> {
    const base = endpointUrl(this.api);
    if (base === undefined) {
      // PERMANENT for this run: no amount of retrying invents a baseUrl. `validateProviderApi` allows an
      // absent one because there is no universal default endpoint for this kind, so the transport is
      // where it becomes an error — named as a config problem, not as a network one.
      throw new ProviderError("missing-binary", `${this.label}: provider.api.baseUrl is required for the openai-compatible kind (e.g. "http://127.0.0.1:11434/v1" for Ollama)`);
    }
    const { key } = await this.key();
    // A non-loopback endpoint with no key is almost always a misconfiguration, and the request would
    // 401 anyway — fail permanently with a message that names the key sources rather than burning the
    // retry schedule. A LOOPBACK endpoint legitimately needs none.
    if (key === undefined && !isLoopbackHost(base.hostname)) throw this.missingKey();

    // Trailing slashes normalized ONCE, so `…/v1` and `…/v1/` produce a byte-identical request URL, and
    // the configured QUERY STRING preserved — a gateway's `?api-version=…` is load-bearing. See
    // `requestUrl`.
    const url = requestUrl(base, "/chat/completions");

    const parsed = await postJson({
      url,
      headers: key !== undefined ? { authorization: `Bearer ${key}` } : {},
      kind: "openai-compatible",
      // Handed over ONLY to be scrubbed back out of any diagnostic — see `diagnostic` in http.ts. The
      // header above is the only place it is ever sent.
      ...(key !== undefined ? { secret: key } : {}),
      body: {
        model: this.api.model,
        messages: [{ role: "user", content: prompt }],
        ...(this.api.maxTokens !== undefined ? { max_tokens: this.api.maxTokens } : {}),
      },
      timeoutMs: this.timeoutMs(),
      label: this.label,
      ...(this.opts.fetchImpl ? { fetchImpl: this.opts.fetchImpl } : {}),
      ...(this.opts.now ? { now: this.opts.now } : {}),
    }) as Record<string, unknown> | null;

    const choices = Array.isArray(parsed?.choices) ? parsed!.choices as Record<string, unknown>[] : [];
    const first = choices[0];
    const message = first && typeof first.message === "object" && first.message !== null
      ? first.message as Record<string, unknown>
      : undefined;
    const text = typeof message?.content === "string" ? message.content : "";

    if (first?.finish_reason === "length") this.warnTruncated(this.api.maxTokens);

    if (text.trim() === "") {
      throw new ProviderError("empty-output", `${this.label}: the response contained no message content (finish_reason ${typeof first?.finish_reason === "string" ? first.finish_reason : "unknown"})`);
    }
    return text;
  }
}
