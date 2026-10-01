// src/providers/endpoint.ts — A3. Endpoint arithmetic shared by the two transports, the key ladder,
// the network-probe derivation and `init`.
//
// EXTRACTED AT FOUR CONSUMERS, not speculatively: `apiKey.ts` (a loopback endpoint needs no key at all
// and must not warn about one), `core.ts` (the derived networkProbeHosts fallback), `config.ts`'s
// `initConfig` (which must WRITE the derived hosts, or the derivation is dead on every fresh install),
// and `json.ts`'s doctor branch. Four spellings of "is this localhost" is precisely how one of them
// ends up disagreeing with the others.
//
// Provider-agnostic on purpose: `net.ts`'s own header says it stays provider-agnostic, so the mapping
// from a provider config to a host list lives here and net.ts merely accepts a fallback.
import type { ProviderApi } from "../types";

export const ANTHROPIC_DEFAULT_BASE_URL = "https://api.anthropic.com";

/** The endpoint a given api config actually talks to, as a parsed URL — or `undefined` when the config
 *  names no usable one (an openai-compatible kind with no `baseUrl`, which `validateProviderApi` permits
 *  because there is no universal default, and which the provider itself reports as a config error). */
export function endpointUrl(api: ProviderApi): URL | undefined {
  const raw = api.baseUrl ?? (api.kind === "anthropic" ? ANTHROPIC_DEFAULT_BASE_URL : undefined);
  if (raw === undefined) return undefined;
  try { return new URL(raw); } catch { return undefined; }
}

/**
 * THE REQUEST URL, and the one place the two transports compose one.
 *
 * ⚠ THE QUERY STRING IS PRESERVED AND THE FRAGMENT IS DROPPED, and those are two different decisions.
 * A gateway's `?api-version=…` parameter is LOAD-BEARING — rebuilding the URL from `origin + pathname`
 * threw it away, and the user got an opaque 4xx at 07:20 naming nothing while `doctor` cheerfully
 * reported a baseUrl that was not the one being called. A fragment, by contrast, is meaningless in
 * HTTP: it never leaves the client, so dropping it changes nothing on the wire.
 *
 * ⚠ AND THIS IS *NOT* THE STRING TO PRINT. A query is also the one place a credential can still hide
 * in a baseUrl (userinfo is refused outright by `validateProviderApi`), so every printed or serialized
 * surface uses `printableEndpoint` below instead. Sending it and showing it are deliberately different
 * functions rather than one function with a flag, because a flag defaults wrong exactly once.
 *
 * Trailing slashes are normalized here so `…/v1` and `…/v1/` produce a byte-identical request URL.
 */
export function requestUrl(base: URL, suffix: string): string {
  return `${base.origin}${base.pathname.replace(/\/+$/, "")}${suffix}${base.search}`;
}

/** The endpoint as it may be PRINTED: origin + pathname, never the query or the fragment. See above. */
export const printableEndpoint = (u: URL): string => `${u.origin}${u.pathname}`;

/** True when `printableEndpoint` is withholding something, so a surface can say so rather than quietly
 *  showing a different URL from the one the run will use. */
export const endpointHasWithheldParts = (u: URL): boolean => u.search !== "" || u.hash !== "";

/** Is this hostname the local machine? `localhost`, the whole 127.0.0.0/8 block, `::1`, and the
 *  `.localhost` TLD that RFC 6761 reserves for exactly this.
 *
 *  ⚠ The `127.0.0.0/8` test is on the FIRST OCTET, not on the literal string `127.0.0.1`: Ollama and
 *  LM Studio are routinely reached on `127.0.0.1`, but a user who wrote `127.0.1.1` (Debian's own
 *  loopback spelling) is equally local and would otherwise get a 25-second network wait every morning
 *  for a server running on the same machine. `0.0.0.0` is deliberately NOT loopback — it is a bind
 *  address, and a config naming it as a destination is a mistake worth probing rather than skipping. */
export function isLoopbackHost(hostname: string): boolean {
  // A URL's `hostname` strips the brackets from an IPv6 literal, so `::1` arrives bare.
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  return v4 !== null && Number(v4[1]) === 127;
}

/** The default port for a URL that names none — `URL.port` is `""` for the scheme default. */
export const portOf = (u: URL): number => (u.port !== "" ? Number(u.port) : u.protocol === "http:" ? 80 : 443);

/**
 * The `networkProbeHosts` FALLBACK derived from an api config: probe the endpoint the run will actually
 * use, or disable the gate entirely for a local model.
 *
 * WHY THIS IS BETTER THAN THE ANYCAST DEFAULT, and why it costs nothing: `tcpProbe` opens a raw TCP
 * connection and immediately `.end()`s it (net.ts), so the README's "no data is sent or received"
 * claim about the connectivity check survives verbatim — while the probe now catches DNS failure, a
 * corporate proxy blocking the API host, and a down gateway, none of which 1.1.1.1 can see.
 *
 * For a LOCAL model the anycast default is an active anti-feature: a user on a plane with Ollama waits
 * the full 25s grace for two unreachable hosts before every briefing. `[]` is the documented switch for
 * exactly that, so this returns it.
 *
 * `undefined` means "no opinion — keep the anycast default": the caller distinguishes that from `[]`,
 * because `[]` DISABLES the gate and defaulting to it for an unparseable endpoint would silently drop
 * the whole network gate on a typo.
 */
export function deriveProbeHosts(api: ProviderApi): { host: string; port: number }[] | undefined {
  const u = endpointUrl(api);
  if (!u) return undefined;
  if (isLoopbackHost(u.hostname)) return [];
  return [{ host: u.hostname, port: portOf(u) }];
}
