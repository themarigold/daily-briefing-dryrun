// B2's pure classifier. Effective push destinations are read separately from raw web-link URLs.
export type Transport = "network" | "refused";

export function classifyTransport(raw: string): Transport {
  if (!raw || /[\s\x00-\x1f\x7f-\x9f\\]/u.test(raw)) return "refused";
  const scheme = /^([^:]+):\/\//.exec(raw);
  if (scheme) {
    if (scheme[1] !== "https" && scheme[1] !== "ssh") return "refused";
    // Validate the raw authority before URL normalisation (which accepts https:///host).
    const authority = raw.slice(scheme[0].length).split(/[/?#]/, 1)[0]!;
    if (!authority) return "refused";
    try {
      const u = new URL(raw);
      if (!u.hostname || u.pathname === "" || u.pathname === "/") return "refused";
      if (scheme[1] === "ssh") {
        // Git decodes the whole authority before it splits one, so `%40` is an `@` and `%3A` a `:` here too,
        // and a `%2F` ends the host: `ssh://u%40-h%2Fx@real/p` hands ssh `u@-h`.
        const decoded = decodeURIComponent(authority).split("/", 1)[0]!;
        const at = decoded.lastIndexOf("@");
        const user = at < 0 ? "" : decoded.slice(0, at);
        const hp = /^(\[[^\]]+\]|[^:]+)(?::([0-9]+))?$/.exec(decoded.slice(at + 1));
        if (!hp || user.startsWith("-") || hp[1]!.replace(/^\[/, "").startsWith("-")) return "refused";
        if (hp[2] !== undefined && (Number(hp[2]) < 1 || Number(hp[2]) > 65535)) return "refused";
      }
      return "network";
    } catch { return "refused"; }
  }
  if (/^[^/:\[\]]+::/.test(raw)) return "refused";
  if (/^[A-Za-z]:/.test(raw)) return "refused";
  // Git's own test for a local path, ahead of any bracket: `[./x]:y` runs a local shell. `[::1]:x` has no slash before its colon.
  const colon = raw.indexOf(":"), slash = raw.indexOf("/");
  if (colon < 0 || (slash >= 0 && slash < colon)) return "refused";
  // A bracketed IPv6 host has colons of its own; only the colon after ] separates its path.
  const m = /^(?:([^@/:]+)@)?(\[[^\]]+\]|[^:/@]+):(.+)$/.exec(raw);
  if (!m) return "refused";
  const [, user = "", host = ""] = m;
  if (user.startsWith("-") || host.replace(/^\[/, "").startsWith("-")) return "refused";
  return "network";
}

/** Null is a failed read, distinct from a known refused/missing destination. */
export function pushTransport(destinations: readonly string[] | null, vcs: boolean): Transport | null {
  if (vcs) return "refused";
  if (destinations === null) return null;
  return destinations.length > 0 && destinations.every((d) => classifyTransport(d) === "network") ? "network" : "refused";
}
