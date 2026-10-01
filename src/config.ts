// src/config.ts
import { readdir, stat, chmod } from "node:fs/promises";
import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import type { Config, ProviderApi, TokenBudget } from "./types";
import type { RecapMode } from "./recapCampaigns";
import { API_LABEL_ANTHROPIC, API_LABEL_OPENAI } from "./types";
import { classify, type PathIssue, type GuardOpts } from "./protectedPath";
import { deriveProbeHosts } from "./providers/endpoint";
import { redactCredentials } from "./transcripts/credentials";

// Short per-repo label for display: the basename, unless another configured repo shares it
// (e.g. /a/api and /b/api) — then qualify with the parent dir so the briefing never merges two
// distinct projects under one `[api]` tag (review: basename collision).
//
// NOT injective, and an earlier revision of this comment claiming "UNIQUE per-repo" overstated it: it
// qualifies with exactly ONE parent segment, so `/u/a/x/api` and `/u/b/x/api` both render `x/api`.
// Callers must therefore never FILTER or DEDUPE on this value — the audit did, and a collision deleted
// one repo's diagnosis entirely. Compare on full paths; use this only to render.
export function repoLabel(path: string, allPaths: string[]): string {
  const b = basename(path);
  return allPaths.some((p) => p !== path && basename(p) === b) ? join(basename(dirname(path)), b) : b;
}

export const DEFAULT_LOOKBACK_CAP_DAYS = 4;
// Commit subjects matching these (regex) are dropped as bot/auto-commit noise — the vault
// auto-commits every ~10 min as the same author, so an author filter alone can't catch them (#3).
export const DEFAULT_EXCLUDE_COMMIT_PATTERNS = ["^vault backup:"];

// Compile the (user-configurable) exclude patterns ONCE, tolerating a bad regex: a typo'd pattern
// is collected in `invalid` (so the caller can warn) instead of throwing and silently degrading the
// whole briefing to a misleading "partial failure reading repo" (#4).
export function compileExcludePatterns(patterns: string[]): { regexes: RegExp[]; invalid: string[] } {
  const regexes: RegExp[] = [];
  const invalid: string[] = [];
  for (const p of patterns) {
    try { regexes.push(new RegExp(p)); } catch { invalid.push(p); }
  }
  return { regexes, invalid };
}
// Slice 1 input is git-only (commit messages + diffstat) and naturally bounded — unlike
// Slice 1.5, which will add transcripts and needs tighter budgeting. Keep this high so stage 2
// of reduce() (which drops activities/evidence, see src/reduce.ts) stays a rare safety net for
// pathological monorepos rather than tripping on a normal busy day.
export const DEFAULT_BUDGET: TokenBudget = { maxChars: 200000 };

export const DEFAULT_NETWORK_PROBE_HOSTS = [{ host: "1.1.1.1", port: 443 }, { host: "8.8.8.8", port: 443 }];

export function configPath(): string {
  const base = process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config");
  return join(base, "daily-briefing", "config.json");
}

// Expand a leading ~ (the natural way people write config paths) against home; other paths untouched.
export function expandTilde(p: string, home: string): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

// Light validation of the hand-edited config (spec §6: a typo must fail fast with a clear message,
// not blind-cast into a TypeError deep in the pipeline or silent wrong math — e.g. lookbackCapDays:"4"
// made `cap + 1` the STRING "41", a 41-day scan). Also normalizes path arrays (~-expansion). Throws
// `Error("config error: …")` which run()'s catch surfaces as "Config error: …" (exit 2), NOT "no-config".
/** The synthesized legacy triple for an API provider. `argv` is a FRESH array per call — a shared
 *  frozen constant would be handed to `BYOCliProvider`-shaped consumers that spread it, and a single
 *  mutable module-level array reachable from 85 importers of types.ts is a trap nobody needs. */
export const apiTransportLabel = (kind: ProviderApi["kind"]): string =>
  kind === "anthropic" ? API_LABEL_ANTHROPIC : API_LABEL_OPENAI;

/** Slice 2/A3. Validate `provider.api` and return it, or THROW `config error: …`.
 *
 *  ⚠ THROWS, where `accounts`/`transcripts`/`networkProbeHosts` only warn — and the asymmetry is the
 *  decision, not an oversight. Those are OPTIONAL FEATURES: disabling one with a warning still delivers
 *  a briefing. `api` decides WHICH TRANSPORT RUNS and therefore which credential is spent, so there is
 *  no safe degradation — "we couldn't read your api block so we spawned a CLI instead" is the silent
 *  wrong-credential failure class this project has already paid for once. It sits on the throwing side
 *  with the rest of the REQUIRED provider block (see the shape check in validateConfig).
 *
 *  ORDER IS DELIBERATE: mutual exclusion is checked FIRST, immediately after "is it an object". Every
 *  existing user reaching an API provider does so by EDITING a config that already has the triple, so
 *  "delete these three lines" is the message that will actually be read, and burying it behind a
 *  `kind` typo would hide it exactly when it is needed. */
/** An UNPARSEABLE baseUrl, made safe to print. `new URL` already failed on it, so `printableEndpoint`
 *  cannot be used — cut at the first `?` or `#` textually, say so, then run the shared shape-redactor. */
function printableRawUrl(raw: string): string {
  const cut = raw.search(/[?#]/);
  const head = cut === -1 ? raw : `${raw.slice(0, cut)} (query withheld)`;
  return redactCredentials(head);
}

export function validateProviderApi(p: Record<string, unknown>): ProviderApi {
  const a = p.api;
  if (!a || typeof a !== "object" || Array.isArray(a)) {
    throw new Error('config error: "provider.api" must be an object { kind, model, … } (delete it to use a CLI provider)');
  }
  const api = a as Record<string, unknown>;

  const clashes = (["cli", "argv", "promptVia"] as const).filter((k) => p[k] !== undefined);
  if (clashes.length) {
    throw new Error(`config error: "provider.api" cannot be combined with ${clashes.map((k) => `"provider.${k}"`).join(", ")} — an API provider spawns no CLI. Delete ${clashes.length === 1 ? "that line" : "those lines"} (${clashes.join(", ")}) from "provider", or delete "provider.api" to keep using the CLI.`);
  }

  if (api.kind !== "anthropic" && api.kind !== "openai-compatible") {
    throw new Error('config error: "provider.api.kind" must be "anthropic" or "openai-compatible"');
  }
  if (typeof api.model !== "string" || api.model.trim() === "") {
    throw new Error('config error: "provider.api.model" must be a non-empty string — this project deliberately refuses to pick a model for you, because a silently-chosen model changes briefing content without a config change');
  }
  if (api.baseUrl !== undefined) {
    if (typeof api.baseUrl !== "string") throw new Error('config error: "provider.api.baseUrl" must be a string URL');
    let u: URL;
    try { u = new URL(api.baseUrl); }
    // ⚠ THE ECHOED VALUE IS SCRUBBED FIRST. main.ts prints a `config error:` on EVERY 600 s tick, so
    // this string lands in briefing.log forever — and a scheme-less baseUrl carrying `?api_key=…` is
    // exactly the shape that reaches here (a valid URL with a query is accepted and never echoed at
    // all). Same rule as `doctor`'s baseUrl field: query and fragment withheld, then the shared
    // shape-redactor as a second layer.
    catch { throw new Error(`config error: "provider.api.baseUrl" is not a valid URL: ${JSON.stringify(printableRawUrl(api.baseUrl))}`); }
    // http/https ONLY. `file:` would make the "endpoint" a path this code then treats as a network
    // origin, and a `data:`/`javascript:` URL is nonsense the probe-host derivation would inherit.
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      throw new Error(`config error: "provider.api.baseUrl" must use http: or https: (got ${u.protocol})`);
    }
    // Userinfo is refused rather than stripped: a credential in a URL is a credential that lands in
    // every log line, error message and probe-host derivation that ever renders the endpoint. The key
    // has exactly four supported sources and none of them is the address bar.
    if (u.username !== "" || u.password !== "") {
      throw new Error('config error: "provider.api.baseUrl" must not embed a username or password — put the key in apiKeyEnv, apiKeyFile, apiKeyCommand or apiKey instead');
    }
  }
  if (api.maxTokens !== undefined &&
      (typeof api.maxTokens !== "number" || !Number.isInteger(api.maxTokens) || api.maxTokens <= 0)) {
    throw new Error('config error: "provider.api.maxTokens" must be a positive whole number');
  }
  for (const k of ["apiKeyEnv", "apiKeyFile", "apiKey"] as const) {
    if (api[k] !== undefined && (typeof api[k] !== "string" || (api[k] as string).trim() === "")) {
      throw new Error(`config error: "provider.api.${k}" must be a non-empty string`);
    }
  }
  if (api.apiKeyCommand !== undefined &&
      (!Array.isArray(api.apiKeyCommand) || api.apiKeyCommand.length === 0 ||
       api.apiKeyCommand.some((x) => typeof x !== "string" || x === ""))) {
    throw new Error('config error: "provider.api.apiKeyCommand" must be a non-empty array of non-empty strings (argv, e.g. ["my-keychain-helper", "--field", "password"])');
  }
  return api as unknown as ProviderApi;
}

export function validateConfig(raw: unknown, home: string): Config {
  if (!raw || typeof raw !== "object") throw new Error("config error: the config is not a JSON object");
  const c = raw as Record<string, unknown>;
  // provider is required + wholly consumed unguarded downstream (argv is spread, promptVia is switched
  // on), so validate the whole shape — not just cli — or a missing argv/promptVia still TypeErrors deep
  // in BYOCliProvider.generate (the exact failure mode this validation exists to prevent).
  const p = c.provider as Record<string, unknown> | undefined;
  // ── Slice 2/A3: the api branch, inserted AHEAD of the legacy shape check. ────────────────────────
  // ⚠ ENTERED ONLY when `provider.api` is present, which no config that exists today has — so every
  // existing user takes the `else if` below completely unchanged, byte for byte. That is a property a
  // test asserts mechanically (test/config.api.test.ts's legacy-identity table), not a claim.
  const pObj = p && typeof p === "object" && !Array.isArray(p) ? p : undefined;
  const api = pObj?.api !== undefined ? validateProviderApi(pObj) : undefined;
  if (api === undefined &&
      (!p || typeof p !== "object" || typeof p.cli !== "string" ||
       !Array.isArray(p.argv) || (p.argv as unknown[]).some((x) => typeof x !== "string") ||
       (p.promptVia !== "stdin" && p.promptVia !== "arg"))) {
    throw new Error('config error: "provider" must be { cli: string, argv: string[], promptVia: "stdin"|"arg" } (run `daily-briefing init`)');
  }
  // Both branches above guarantee an object here (the api branch requires one; the legacy branch threw
  // otherwise). `pObj!` rather than `p` only because TS cannot see through the two-branch narrowing —
  // and `pObj` is the checked-object form, so the assertion is on the narrowing, not on the data.
  // EVERY check below applies to BOTH shapes: `timeoutMs` bounds the API call's AbortController exactly
  // as it bounds a spawn, and `harden`/`credential` are validated for shape here and warned about as
  // INAPPLICABLE later (src/providerFactory.ts) — validating them only on the CLI branch would make a
  // typo in them silently unnoticed on the api branch.
  const prov = pObj!;
  if (prov.timeoutMs !== undefined && (typeof prov.timeoutMs !== "number" || !Number.isFinite(prov.timeoutMs) || prov.timeoutMs <= 0)) throw new Error('config error: "provider.timeoutMs" must be a positive number (milliseconds)');
  if (prov.harden !== undefined && typeof prov.harden !== "boolean") throw new Error('config error: "provider.harden" must be a boolean (default true — set false only to opt out of provider hardening entirely)');
  if (prov.credential !== undefined && prov.credential !== "subscription" && prov.credential !== "env-api-key") throw new Error('config error: "provider.credential" must be "subscription" (default — withhold ANTHROPIC_API_KEY so the CLI uses its logged-in subscription) or "env-api-key" (pass the key through and bill API credits)');
  // `provider.accounts` is validated at its USE SITE (resolveAccounts, below), not here — the same
  // shape `transcripts` uses. Validating here could only throw or strip: a throw lands at main.ts's
  // `Config error:` + `return 2` on EVERY 600s tick, and stripping destroys the very information a
  // warning would carry. Neither belongs in a function whose only outputs are "a Config" or "an
  // exception". resolveAccounts returns warnings alongside the parsed list, and core.ts pushes them
  // into the briefing's warnings the way it already does for transcripts.
  for (const k of ["repos", "discoverRoots", "excludeRepos", "excludeCommitPatterns"]) {
    const v = c[k];
    if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) throw new Error(`config error: "${k}" must be an array of strings`);
  }
  if (c.lookbackCapDays !== undefined && (typeof c.lookbackCapDays !== "number" || !Number.isFinite(c.lookbackCapDays))) throw new Error(`config error: "lookbackCapDays" must be a number, not ${JSON.stringify(c.lookbackCapDays)}`);
  const aj = (c as Record<string, unknown>).auditJudgeArgv;
  if (aj !== undefined && (!Array.isArray(aj) || aj.some((x) => typeof x !== "string"))) {
    throw new Error('config error: "auditJudgeArgv" must be an array of strings (e.g. ["--model", "opus"])');
  }
  const tb = c.tokenBudget; // an OBJECT { maxChars: number }, not a bare number
  if (tb !== undefined && (typeof tb !== "object" || tb === null || typeof (tb as Record<string, unknown>).maxChars !== "number")) throw new Error('config error: "tokenBudget" must be { maxChars: number }');
  // author: MUST be an object of string-ARRAYS. The dangerous shape is a STRING-VALUED names/emails
  // (e.g. {emails:"me@x.com"}): it spreads per-character into --author filters (git.ts authorArgs) → git
  // ORs "--author=m --author=e …" → matches ~every commit, silently crediting other people's work.
  // (A bare-string / singular-key-typo author is instead silently IGNORED → safe git-config-identity
  // fallback; rejected here anyway so a value-shape typo surfaces loudly rather than being ignored.
  // `null` is treated as unset — preserving the pre-diff no-op.)
  const au = c.author;
  if (au != null) {
    if (typeof au !== "object" || Array.isArray(au)) throw new Error('config error: "author" must be { names?: string[], emails?: string[] }');
    for (const k of ["names", "emails"] as const) {
      const v = (au as Record<string, unknown>)[k];
      if (v !== undefined && (!Array.isArray(v) || v.some((x) => typeof x !== "string"))) throw new Error(`config error: "author.${k}" must be an array of strings`);
    }
  }
  // subprojects: MUST be an array of { repo: string, roots: string[] }. A non-array or a roots-less entry
  // otherwise TypeErrors deep in resolveProjectRoots on EVERY launchd tick (fail-fast per the §6 contract).
  // `null` is treated as unset (preserving the pre-diff no-op).
  const sp = c.subprojects;
  if (sp != null) {
    if (!Array.isArray(sp)) throw new Error('config error: "subprojects" must be an array of { repo: string, roots: string[] }');
    for (const entry of sp) {
      const e = entry as Record<string, unknown> | null;
      if (!e || typeof e !== "object" || typeof e.repo !== "string" || !Array.isArray(e.roots) || (e.roots as unknown[]).some((x) => typeof x !== "string")) {
        throw new Error('config error: each "subprojects" entry must be { repo: string, roots: string[] }');
      }
    }
  }
  // morningTime is intentionally NOT hard-validated: parseFloor (schedule.ts) already degrades a bad
  // value gracefully (default 07:20 + a warning) so the briefing still runs — don't regress that.
  const expand = (v: unknown) => Array.isArray(v) ? (v as string[]).map((x) => expandTilde(x, home)) : v;
  const out: Config = { ...(c as Config), repos: expand(c.repos) as Config["repos"], discoverRoots: expand(c.discoverRoots) as Config["discoverRoots"], excludeRepos: expand(c.excludeRepos) as Config["excludeRepos"] };
  // ── Slice 2/A3: SYNTHESIZE the frozen triple for an API provider. ────────────────────────────────
  // The whole point of the mutual exclusion is that the user does not write cli/argv/promptVia — but
  // types.ts keeps them REQUIRED (the frozen-contract rule forbids retyping a required field to
  // optional), and 85 importers spread `argv` and switch on `promptVia` unguarded. So the returned
  // Config is made fully type-valid here, once, instead of every consumer learning about `api`.
  //
  // The synthesized `cli` is a stable LABEL, never a path: `claudeShaped("anthropic-api")` is false, so
  // the transcript gates and `auditMayCarryRawTurn` all fall the safe way with zero edits at those
  // sites. `promptVia: "stdin"` is the inert choice — the API transports never read either field; it is
  // spelled out rather than left arbitrary so nothing downstream can read a meaning into "arg".
  if (api !== undefined) {
    out.provider = { ...out.provider, cli: apiTransportLabel(api.kind), argv: [], promptVia: "stdin", api };
  }
  return out;
}

// ── Slice 1.5 §3.6: transcripts config + root resolution (T1.1/T1.2) ──────────────────────────────
// B1 style, like resolveProbeHosts (net.ts): a malformed block WARNS and disables the feature, it
// never throws out of loadConfig. A transcript-config typo must not take the morning briefing down —
// the feature is optional and off by default, while the briefing is the product.
export const DEFAULT_TRANSCRIPTS_DIRNAME = "projects";

export type ResolvedTranscripts = { enabled: boolean; root: string; warning?: string };

/** Resolution order (§3.6): `transcripts.root` → `CLAUDE_CONFIG_DIR` → default `~/.claude/projects`.
 *  `env`/`home` are injected so the three branches are testable without mutating process state. */
export function resolveTranscripts(
  raw: unknown, home: string, env: Record<string, string | undefined> = process.env,
): ResolvedTranscripts {
  // The default root is computed even when the feature is off, so `enabled: true` added later to an
  // existing config needs no other edit — the case config.ts's early-returning initConfig creates.
  const claudeDir = env.CLAUDE_CONFIG_DIR;
  const fallback = claudeDir
    ? join(expandTilde(claudeDir, home), DEFAULT_TRANSCRIPTS_DIRNAME)
    : join(home, ".claude", DEFAULT_TRANSCRIPTS_DIRNAME);

  if (raw === undefined || raw === null) return { enabled: false, root: fallback }; // unset is not a typo — no warning
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { enabled: false, root: fallback, warning: 'config: "transcripts" must be { enabled?: boolean, root?: string } — transcript evidence disabled' };
  }
  const t = raw as Record<string, unknown>;
  if (t.enabled !== undefined && typeof t.enabled !== "boolean") {
    return { enabled: false, root: fallback, warning: 'config: "transcripts.enabled" must be a boolean — transcript evidence disabled' };
  }
  // A non-string root is a typo; an EMPTY string is too, and is the more dangerous one — `join("", x)`
  // silently yields a relative path, so the scan would read from the process CWD instead of failing.
  if (t.root !== undefined && (typeof t.root !== "string" || t.root.trim() === "")) {
    return { enabled: false, root: fallback, warning: 'config: "transcripts.root" must be a non-empty string — transcript evidence disabled' };
  }
  const root = t.root !== undefined ? expandTilde(t.root as string, home) : fallback;
  return { enabled: t.enabled === true, root };
}

// ── IN-2: verdict-path marker config (EVAL days 51/52) ─────────────────────────────────────────────
// B1 style, like resolveTranscripts above: a malformed value WARNS and disables the marker, it never
// throws out of loadConfig — the marker is an annotation, and a typo in it must not cost the morning
// its briefing (a throw here is `Config error:` + exit 2 on every 600s tick).
export type ResolvedVerdictPaths = { paths: string[]; warning?: string };

/** `Config.verdictPaths` → normalised repo-relative directory prefixes (no leading `./`, no trailing
 *  `/`), de-duplicated. Absent/`null`/`[]` ⇒ `[]` with NO warning: unset is the default, not a typo.
 *
 *  REJECTED — the whole list, with a warning — when it is not an array of strings, or an entry is
 *  empty, absolute (`/…`, `~…`), carries a `.`/`..`/empty segment, or carries a glob metacharacter
 *  (`* ? [ ] { }`, or a leading `!` — `subprojects[].roots`' negation) or a backslash. Each of those
 *  either matches no diffstat path ever (git's numstat paths are repo-relative, `/`-separated,
 *  normalised, and matched here as LITERAL prefixes) or, for `.`, would match EVERY commit and mark
 *  every suggestion — a marker on everything marks nothing.
 *  The glob case is the likely one, not a curiosity (IN-2 cold review, lenses 1 and 3): the day-52
 *  judge's own recommendation spells the path `quant_stocks/**` (audit-2026-09-06.md), and the sibling
 *  key `subprojects[].roots` DOES take globs — accepted silently, it would enable a marker that never
 *  fires while the operator believes the day-52 defect fixed. Residual: a directory literally named
 *  with one of those characters cannot be configured (name its parent).
 *  All-or-nothing rather than dropping the bad entry, for the reason `transcripts` gives: a partially
 *  applied operator ruling is invisible state.
 *
 *  NOT rejected, because it cannot be decided without the repo: a REPO-NAME PREFIX
 *  (`personal_code/quant_stocks` for a repo named `personal_code`). It never matches unless the repo
 *  really holds a `personal_code/` folder — and a same-named inner folder is an ordinary layout (a
 *  Python package's `pkg/pkg/`), so refusing that first segment would refuse legitimate configs. The
 *  type doc says paths are relative to the repo ROOT, and the audit's `featuresLine` prints the
 *  resolved paths, so the mistake is visible on the page the EVAL row is written from. CASE is not a
 *  failure mode at all: the marker matches case-insensitively (core.markVerdictPathSuggestions).
 *
 *  ⚠ The warning is FIXED TEXT: it names no example path and never echoes the configured value. It
 *  renders in the briefing's `⚠` line, which feeds `audit.coverageGaps`' haystack, and an example like
 *  `quant_stocks/` there would "name" that lane on exactly the misconfigured morning. */
export function resolveVerdictPaths(raw: unknown): ResolvedVerdictPaths {
  if (raw === undefined || raw === null) return { paths: [] };
  const off: ResolvedVerdictPaths = {
    paths: [],
    warning: 'config: "verdictPaths" must be an array of literal repo-relative directory paths, no globs — verdict-path marker disabled',
  };
  if (!Array.isArray(raw)) return off;
  const paths: string[] = [];
  for (const e of raw) {
    if (typeof e !== "string") return off;
    const p = e.trim().replace(/^(?:\.\/)+/, "").replace(/\/+$/, "");
    if (p === "" || p.startsWith("/") || p.startsWith("~") || p.startsWith("!") || /[*?[\]{}\\]/.test(p)
      || p.split("/").some((seg) => seg === "" || seg === "." || seg === "..")) return off;
    paths.push(p);
  }
  return { paths: [...new Set(paths)] };
}

// ── Tier B (Stage-2 recap campaigns): the mode key, spec §4.8 + Appendix D7 ─────────────────────────
export type ResolvedRecapCampaigns = { mode: RecapMode; warning?: string };

/** `Config.recapCampaigns` → the tier-B mode. The ONE reader of the key (spec §4.8), called with the same
 *  input at two sites so they cannot disagree: `main.ts` (to widen the run lock) and `runCore` (to gate
 *  the phase and push `warning` into the page's warnings, as `verdictPaths` does). The
 *  `resolveVerdictPaths` pattern above: pure, never throws, B1-style degradation.
 *
 *  Appendix D7: `undefined`/`null` is ABSENT ⇒ `off` with NO warning (unset is the default, not a typo).
 *  Anything that is not EXACTLY `{ mode: "off" | "trial" | "on" }` ⇒ `off` plus a warning: a non-object,
 *  an array, a missing or mistyped `mode`, a mode spelled any other way (`"ON"`, `" on"`), and an object
 *  carrying ANY other own key beside `mode` (a typo'd sibling is invisible state otherwise). An accessor
 *  `mode` is a bad shape too — it is read by descriptor, never invoked — and anything that throws while
 *  being inspected (a hostile Proxy; `runCore` takes a `Config` from any caller, not only JSON) is caught
 *  and degrades to `off` the same way, so the briefing never pays for a malformed key.
 *
 *  ⚠ The warning is FIXED TEXT and never echoes the configured value (the `verdictPaths` rule above): it
 *  renders in the briefing's `⚠` line, which feeds `audit.coverageGaps`' haystack, so an echoed value
 *  that happens to be a repo label would "name" that lane on exactly the misconfigured morning. */
export function resolveRecapCampaigns(raw: unknown): ResolvedRecapCampaigns {
  if (raw === undefined || raw === null) return { mode: "off" };
  const off: ResolvedRecapCampaigns = {
    mode: "off",
    warning: 'config: "recapCampaigns" must be { mode: "off" | "trial" | "on" } — recap campaigns off',
  };
  try {
    if (typeof raw !== "object" || Array.isArray(raw)) return off;
    const keys = Reflect.ownKeys(raw);
    if (keys.length !== 1 || keys[0] !== "mode") return off;
    const d = Object.getOwnPropertyDescriptor(raw, "mode");
    const mode: unknown = d !== undefined && "value" in d ? d.value : undefined;
    return mode === "off" || mode === "trial" || mode === "on" ? { mode } : off;
  } catch {
    return off;
  }
}

export async function loadConfig(): Promise<Config> {
  const file = Bun.file(configPath());
  if (!(await file.exists())) throw new Error("no-config");
  return validateConfig(await file.json(), homedir());
}

export async function isDir(p: string): Promise<boolean> {
  try { return (await stat(p)).isDirectory(); } catch { return false; }
}

// True if `dir/.git` exists at all, whether a normal repo's DIRECTORY or a worktree's/submodule's
// FILE (a "gitdir: <path>" pointer). A plain isDir() check misses the file form, silently dropping
// worktrees/submodules from discovery. Deliberately NOT `gitDirExists` (git.ts) — that spawns
// `git rev-parse --git-dir`, which searches PARENT directories too; run here on every walked dir,
// that would misclassify a repo-less subdirectory as a repo whenever an ancestor outside the walk
// (e.g. a dotfiles-managed $HOME) happens to be a git repo itself.
export async function hasGitEntry(dir: string): Promise<boolean> {
  try { await stat(join(dir, ".git")); return true; } catch { return false; }
}

// Walk up to `depth` levels under `dir`, collecting repos (dirs containing a `.git`). Skips
// hidden dirs (name starts with ".") and `node_modules`, and stops descending once a `.git` is
// found (don't recurse into a repo's own working tree) — keeps the scan cheap even under $HOME.
// A dir we can't enumerate is CLASSIFIED and surfaced (§5.11) — never a silent skip — so a
// TCC-blocked ~/Desktop shows up as an issue instead of its repos just vanishing.
async function discoverUnder(
  dir: string, depth: number, found: string[], issues: PathIssue[], opts?: GuardOpts,
): Promise<void> {
  if (await hasGitEntry(dir)) { found.push(dir); return; }
  if (depth <= 0) return;
  let entries: Dirent[] = [];
  try { entries = await readdir(dir, { withFileTypes: true }); }
  catch (e) {
    issues.push(classify(dir, e, opts));
    return;
  }
  for (const dirent of entries) {
    const name = dirent.name;
    if (name.startsWith(".") || name === "node_modules") continue;
    const child = join(dir, name);
    // Use the dirent's type from readdir instead of a stat per child (skips a stat for the common
    // dir/regular-file cases). Fall back to stat for anything that ISN'T a plain file — symlinks
    // (stat follows them, preserving the prior descend-into-symlinked-dir behavior) AND dirents whose
    // type is unresolved (DT_UNKNOWN on some NFS/SMB/FUSE mounts, where isDirectory() is false for a
    // real directory). Only a known regular file is skipped stat-free. Matches the old stat-everything
    // semantics for every non-file entry, so no repo is lost on exotic filesystems.
    if (dirent.isDirectory() || (!dirent.isFile() && await isDir(child))) {
      await discoverUnder(child, depth - 1, found, issues, opts);
    }
  }
}

// True if `repoPath` is in the exclude list — matched by exact absolute path OR by basename
// (the ergonomic form: `"chef-repo"` drops /Users/x/dev/chef-repo without pinning the full path).
// A trailing slash on an entry is tolerated. Case-sensitive; paths compared verbatim (no realpath)
// to match how repos are stored in config. NB basename matching drops *every* repo with that
// basename — intended for a deliberate personal exclude, not surgical path targeting.
export function isExcludedRepo(repoPath: string, exclude?: string[]): boolean {
  if (!exclude || exclude.length === 0) return false;
  const b = basename(repoPath);
  return exclude.some((e) => {
    const norm = e.endsWith("/") ? e.slice(0, -1) : e;
    return norm === repoPath || norm === b;
  });
}

// Discover repos AND surface any protected-path/read issues hit while walking (§5.11).
// Explicit `repos` short-circuits discovery entirely (and yields no issues). `excludeRepos` is
// applied LAST to both paths, so a stale/work checkout is dropped whether it was listed or found.
export async function discoverRepos(cfg: Config, opts?: GuardOpts): Promise<{ repos: string[]; issues: PathIssue[] }> {
  const keep = (paths: string[]) => paths.filter((p) => !isExcludedRepo(p, cfg.excludeRepos));
  if (cfg.repos && cfg.repos.length) return { repos: keep(cfg.repos), issues: [] };
  const found: string[] = [];
  const issues: PathIssue[] = [];
  for (const root of cfg.discoverRoots ?? []) {
    // The root ITSELF may be a repo (running `init` from inside your own project, a common first move) —
    // record it. But STILL walk its children: a repo can contain independent nested clones — e.g. dotfiles
    // tracked directly in $HOME (which initConfig always adds as a discoverRoot) with project repos beneath
    // it — and short-circuiting here would collapse discovery to just [$HOME] and drop every one of them
    // (final-review Tier-D / MED-2). discoverUnder stops at each child's own .git, so a normal monorepo's
    // non-repo subdirs add nothing (only genuine nested repos are picked up); overlaps are deduped below.
    if (await hasGitEntry(root)) found.push(root);
    let entries: Dirent[] = [];
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch (e) {
      issues.push(classify(root, e, opts));
      continue;
    }
    for (const dirent of entries) {
      const name = dirent.name;
      if (name.startsWith(".") || name === "node_modules") continue;
      const dir = join(root, name);
      // Only descend into DIRECTORY children (same DT_UNKNOWN-safe dirent guard as discoverUnder): a
      // root's loose top-level FILES (README.md, package.json — common under a repo root) must not be
      // handed to discoverUnder, whose readdir would ENOTDIR and log a spurious `not-a-repo` issue per
      // file (final-review Tier-D). A known regular file is skipped stat-free; symlinks / DT_UNKNOWN
      // fall back to stat so no real directory is missed on exotic filesystems.
      if (!(dirent.isDirectory() || (!dirent.isFile() && await isDir(dir)))) continue;
      // 2 levels deep under each root: immediate children AND grandchildren.
      await discoverUnder(dir, 1, found, issues, opts);
    }
  }
  return { repos: keep([...new Set(found)]), issues }; // dedupe: overlapping roots (e.g. init's [cwd, home]) can find the same repo twice
}

export async function resolveRepos(cfg: Config): Promise<string[]> {
  return (await discoverRepos(cfg)).repos;
}

// Resolve the absolute path of a CLI on PATH via `which` (POSIX) / `where` (Windows); returns
// undefined if not found. launchd agents get a minimal PATH, so a bare name won't resolve at
// wake-time — the config must store an absolute path (spec §5.1 / final-review FIX 3).
//
// EXPORTED (A1) so `doctor --json` answers "is the provider binary actually there?" with the SAME
// lookup `init` used to write the config. A second `which` wrapper in json.ts would be free to
// differ on the two cases this one already handles — Windows `where`, and `where`'s multi-line output.
// NB harden.ts exports an unrelated `resolveCliPath` (pure ~/relative path math, no spawn); importers
// of both should alias. This is the one that asks the operating system.
export async function resolveCliPath(cli: string): Promise<string | undefined> {
  try {
    const finder = process.platform === "win32" ? "where" : "which";
    const p = Bun.spawn([finder, cli], { stdout: "pipe", stderr: "pipe" });
    // Drain stdout+stderr concurrently: a sequential read of stdout-then-stderr can hang forever
    // if the child fills the stderr pipe buffer first. NOTE: runGit no longer shares this shape —
    // it races the reads against a flush window so a grandchild holding the pipe cannot hang it
    // (C1/A1). `which`/`where` spawns no grandchildren, so the simpler form is fine here; C1 rev
    // 3.4 explicitly scopes this site out rather than claiming every child is bounded.
    const [out] = await Promise.all([
      new Response(p.stdout).text(),
      new Response(p.stderr).text(),
    ]);
    await p.exited;
    if (p.exitCode === 0) {
      // `where` can print multiple matches (one per line); take the first.
      const resolved = out.split(/\r?\n/)[0]?.trim();
      if (resolved) return resolved;
    }
    return undefined;
  } catch { return undefined; }
}

/** The `--provider …` flag set, parsed by main.ts and handed here. Deliberately NOT a TTY wizard:
 *  `initConfig` returns early whenever a config exists, so init is a FIRST-RUN-ONLY path and every
 *  existing user reaches an API provider by editing the file regardless. Slice 5's GUI owns onboarding;
 *  building a terminal chooser now is building the thing the spine replaces. Flags are scriptable and
 *  testable without a pty. */
export type InitApiOptions = {
  kind: ProviderApi["kind"];
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKeyFile?: string;
  apiKeyCommand?: string[];
};

export async function initConfig(
  resolveCli: (cli: string) => Promise<string | undefined> = resolveCliPath, // injectable for tests
  api?: InitApiOptions,
): Promise<{ path: string; wrote: boolean; cliFound: boolean; api?: ProviderApi }> {
  const path = configPath();
  if (await Bun.file(path).exists()) return { path, wrote: false, cliFound: true };

  // ── A3/T10: the API branch. Written ONLY when --provider was given; with no flags the CLI detection
  // and the template below are UNCHANGED, byte for byte (pinned by a snapshot test).
  if (api !== undefined) {
    const apiBlock: ProviderApi = {
      kind: api.kind,
      model: api.model,
      ...(api.baseUrl !== undefined ? { baseUrl: api.baseUrl } : {}),
      ...(api.apiKeyEnv !== undefined ? { apiKeyEnv: api.apiKeyEnv } : {}),
      ...(api.apiKeyFile !== undefined ? { apiKeyFile: api.apiKeyFile } : {}),
      ...(api.apiKeyCommand !== undefined ? { apiKeyCommand: api.apiKeyCommand } : {}),
    };
    const discoverRoots = [process.cwd(), homedir()];
    const discovered = await resolveRepos({ discoverRoots, provider: { cli: apiTransportLabel(api.kind), argv: [], promptVia: "stdin", api: apiBlock } });
    // ⚠ THE DERIVED PROBE HOSTS ARE NOT OPTIONAL HERE. `initConfig` writes networkProbeHosts
    // EXPLICITLY (see the CLI template below), and the runtime derivation in core.ts fires only when
    // the key is ABSENT — so writing the anycast pair here would make T9 dead on every freshly
    // initialized install, which is the trap the design calls out by name.
    const derived = deriveProbeHosts(apiBlock);
    const template: Config = {
      ...(discovered.length ? { repos: discovered } : {}),
      discoverRoots,
      // NO cli/argv/promptVia (validateConfig would throw — that is the mutual exclusion), and NO
      // `credential`/`harden`: both are properties of a spawned child and writing them at their
      // defaults would make two inapplicable settings look like part of this configuration.
      provider: { api: apiBlock } as unknown as Config["provider"],
      tokenBudget: DEFAULT_BUDGET,
      lookbackCapDays: DEFAULT_LOOKBACK_CAP_DAYS,
      ...(derived !== undefined ? { networkProbeHosts: derived } : {}),
    };
    await Bun.write(path, JSON.stringify(template, null, 2));
    // An api config is a credential-adjacent file BY CONSTRUCTION: even when the key lives in an env
    // var today, `apiKey` is a supported field and this is the file people paste it into. Tightening
    // the mode on OUR OWN freshly created file costs nothing and removes the window in which a
    // hand-added key sits world-readable. The CLI branch below is deliberately untouched.
    try { await chmod(path, 0o600); } catch { /* a best-effort tightening must not fail init */ }
    return { path, wrote: true, cliFound: false, api: apiBlock };
  }
  // detect an installed provider CLI (spec §5.1); default to claude
  const claudePath = await resolveCli("claude");
  const codexPath = claudePath ? undefined : await resolveCli("codex");
  const cliFound = !!(claudePath || codexPath); // neither on PATH → we default to "claude" but must warn (#13)
  const cli = claudePath ?? codexPath ?? "claude";
  const argv = codexPath && cli === codexPath ? ["exec"] : ["-p"];
  // Actually discover repos so a first-time user gets a working config, not a placeholder path.
  const discoverRoots = [process.cwd(), homedir()];
  const discovered = await resolveRepos({
    discoverRoots,
    provider: { cli, argv, promptVia: "stdin" },
  });
  const template: Config = {
    ...(discovered.length ? { repos: discovered } : {}),
    // Keep discoverRoots as a fallback even when repos were found (e.g. for a future re-scan).
    discoverRoots,
    // `harden` is written explicitly at its DEFAULT so the opt-out is discoverable: a user who needs
    // their project MCP servers or hooks during a briefing should not have to read the source to find it.
    // `credential` is written at its default for the same reason `harden` is: so the alternative is
    // DISCOVERABLE. A user who wants to spend API credits will never guess at a field that only
    // exists in the type — and the whole point of this setting is that the billing choice should be
    // something you made on purpose rather than something your shell made for you.
    provider: { cli, argv, promptVia: "stdin", harden: true, credential: "subscription" },
    tokenBudget: DEFAULT_BUDGET,
    lookbackCapDays: DEFAULT_LOOKBACK_CAP_DAYS,
    // #9: write the connectivity-probe targets explicitly so they're discoverable/editable — a
    // local/offline provider (a local-model CLI) can set this to [] to skip the daily network wait.
    networkProbeHosts: DEFAULT_NETWORK_PROBE_HOSTS,
  };
  await Bun.write(path, JSON.stringify(template, null, 2));
  return { path, wrote: true, cliFound };
}

/** Validated failover accounts plus the diagnostics that would otherwise be invisible.
 *
 *  Shaped like `resolveTranscripts` on purpose: an OPTIONAL feature validates at its use site and
 *  degrades to "off, with a warning" rather than throwing, because a throw from config loading costs
 *  the briefing on every 600s tick. Anything malformed yields `accounts: undefined`, which the caller
 *  treats as "no failover configured" — identical to today's behaviour. */
export type ResolvedAccounts = { accounts?: { label: string; configDir?: string }[]; warnings: string[] };

export function resolveAccounts(
  raw: unknown, home: string, env: Record<string, string | undefined> = process.env,
  exists: (p: string) => boolean = (p) => existsSync(p),
): ResolvedAccounts {
  const warnings: string[] = [];
  const off = (why: string): ResolvedAccounts => ({ warnings: [`config: "provider.accounts" ${why} — account failover disabled`] });

  // An AMBIENT CLAUDE_CONFIG_DIR is a supported way to set the transcript root (see resolveTranscripts),
  // so it is only worth warning about when no explicit `transcripts.root` overrides it — otherwise a
  // legitimate setup gets a warning on every tick. Reported whether or not failover is configured,
  // because the hazard is the variable's dual meaning, not this feature.
  if (env.CLAUDE_CONFIG_DIR) {
    warnings.push('config: CLAUDE_CONFIG_DIR is set in the environment — it also resolves the transcript scan root, so transcript evidence may come from the wrong directory; set "transcripts.root" explicitly to pin it');
  }
  if (raw === undefined || raw === null) return { warnings };      // unset is not a typo — no warning
  if (!Array.isArray(raw)) return { warnings: [...warnings, ...off("must be an array").warnings] };

  const out: { label: string; configDir?: string }[] = [];
  for (const a of raw) {
    if (!a || typeof a !== "object") return { accounts: undefined, warnings: [...warnings, ...off("entries must be objects").warnings] };
    const e = a as Record<string, unknown>;
    if (typeof e.label !== "string" || e.label.trim() === "") {
      return { accounts: undefined, warnings: [...warnings, ...off('entries need a non-empty string "label"').warnings] };
    }
    if (e.configDir !== undefined && typeof e.configDir !== "string") {
      return { accounts: undefined, warnings: [...warnings, ...off('"configDir" must be a string when present').warnings] };
    }
    out.push(e.configDir !== undefined ? { label: e.label, configDir: expandTilde(e.configDir as string, home) } : { label: e.label });
  }

  // Marks are keyed by label, so two accounts sharing one would share a limit mark.
  const labels = out.map((a) => a.label);
  if (new Set(labels).size !== labels.length) {
    return { accounts: undefined, warnings: [...warnings, ...off("has duplicate labels, and limit marks are keyed by label").warnings] };
  }

  // Two labels pointing at the SAME login is failover that cannot fail over: the primary walls, the
  // "fallback" is selected, hits the same wall immediately, and both get marked — while the provenance
  // log shows two distinct labels and looks correct. Comparing RESOLVED dirs catches the spelling an
  // absent `configDir` hides, since absent means the CLI's default (~/.claude).
  const resolved = out.map((a) => a.configDir ?? join(home, ".claude"));
  if (new Set(resolved).size !== resolved.length) {
    return { accounts: undefined, warnings: [...warnings, ...off("has two accounts pointing at the same login directory, so it cannot fail over").warnings] };
  }

  // A configured directory with no `.claude.json` has never been logged into. Warn but KEEP the list:
  // an unlogged fallback is still better than none (it only costs a probe), and the check is a
  // heuristic — the user may be about to log in.
  for (const a of out) {
    if (a.configDir && !exists(join(a.configDir, ".claude.json"))) {
      warnings.push(`config: account "${a.label}" points at ${a.configDir}, which has no .claude.json — that account has never been logged in, so failing over to it will not work`);
    }
  }
  return { accounts: out, warnings };
}
