/**
 * T15's form model: the fields of the engine's `Config` (`src/types.ts`) that the Settings form
 * edits, and how a form input is read from and written into the PARSED config.
 *
 * ⚠ THE FORM EDITS THE LOADED OBJECT IN PLACE; IT NEVER BUILDS A FRESH ONE. Unknown keys — a
 * newer engine's additive fields, a hand-written note — and the order of every key survive a save
 * because nothing here constructs a config from form state (appendix T13/T15's stated risk: "a form
 * that silently drops an unknown field would destroy a hand-edited config"). A list of objects is
 * rebuilt by MATCHING existing entries (an account by label, a sub-project by repo, a host by name),
 * so an unknown key inside an entry survives an edit of that list too.
 *
 * ⚠ `transcripts` IS NOT A FIELD. Plan R1 drops it from the form entirely: re-enabling transcripts
 * is a human gate, not an app setting, and the save path refuses any change to it
 * (`src-tauri/src/config_save.rs`) whether it comes from here or from the raw-JSON tab.
 *
 * ⚠ HELP TEXT IS QUOTED, NOT PARAPHRASED. Every `quote` below is a verbatim fragment of the engine
 * source it names; `gui/tests-web/settings.check.ts` reads those files and requires each fragment
 * to be there. `note` is this app's own wording, and says only what the quote does not.
 *
 * ⚠ AN UNTOUCHED FORM SAVES NOTHING. The form round-trips the config through JavaScript, which
 * rewrites some spellings — `1.0` → `1`, `-0` → `0`, integer-like keys ("1", "42") listed first — so
 * `formSubmission` compares the draft with the loaded document as VALUES first and never calls the
 * save when they are equal. An EDITED form save still carries those rewrites for the whole file
 * (docs/gui-seam.md §10g, deviation 48); the raw-JSON tab does not (Rust parses that text itself).
 * No key the engine defines is integer-like.
 */

import type { SaveOutcome } from "./files";

export type Draft = Record<string, unknown>;

export interface Quote {
  /** A verbatim fragment of `source`. */
  text: string;
  /** Relative to `daily_briefing_application/`. */
  source: string;
}

export type FieldKind =
  | "text"
  | "number"
  | "lines"
  | "bool"
  | "choice"
  | "accounts"
  | "subprojects"
  | "hosts"
  | "notify";

export interface Field {
  /** Stable id, also the input's DOM id suffix. */
  id: string;
  path: string[];
  label: string;
  kind: FieldKind;
  /** For `choice`: the allowed values. `""` (absent) is always offered as "engine default". */
  options?: string[];
  /** Required by the engine: an empty input writes an empty value rather than removing the key. */
  required?: boolean;
  /** An empty list is meaningful and different from an absent key (offered as a separate toggle). */
  defaultable?: boolean;
  quote?: Quote;
  note?: string;
  placeholder?: string;
}

export interface Section {
  title: string;
  /** Which provider shape the section applies to; absent = always. */
  when?: "cli" | "api";
  fields: Field[];
}

const TYPES = "src/types.ts";
const CONFIG = "src/config.ts";
const HARDEN = "src/harden.ts";

/**
 * ⚠ REVIEW ROUND 1, M1. `daily-briefing init` refuses a `provider.argv` containing `--tools` or
 * `--settings` (`src/harden.ts`, `INIT_REFUSED` / `assertInitSafeArgv`) for every command-line
 * provider — `provider.harden: false` does NOT lift it (round 2: `src/main.ts` runs the check
 * whenever `provider.api` is absent, and `assertInitSafeArgv` never reads `harden`, although its
 * own message suggests that setting as the way out). `config validate` — which every Settings save
 * goes through — does not run that check, so this screen saves such a list without a word. The
 * engine is frozen in Phase B; the Phase C follow-up is for `config validate` to report it (and for
 * the refusal to stop pointing at `harden: false`). Until then the field says so itself.
 */
export const ARGV_NOTE =
  "One argument per line. Leave out --tools and --settings: `daily-briefing init` refuses a list with either because they defeat the engine's hardening, but a save from this screen goes through `config validate`, which does not check for them — it will save such a list without a warning, and the scheduled run does not refuse it either.";

export const SECTIONS: Section[] = [
  {
    title: "Repositories",
    fields: [
      {
        id: "repos",
        path: ["repos"],
        label: "Repositories",
        kind: "lines",
        note: "One path per line. A leading ~ is expanded by the engine.",
        placeholder: "~/code/my-project",
      },
      {
        id: "discoverRoots",
        path: ["discoverRoots"],
        label: "Folders to search for repositories",
        kind: "lines",
        note: "One path per line. A leading ~ is expanded by the engine.",
      },
      {
        id: "excludeRepos",
        path: ["excludeRepos"],
        label: "Repositories to leave out",
        kind: "lines",
        quote: {
          text: "repos to drop from BOTH explicit `repos` and discovery — by absolute path or basename (e.g. a stale/work checkout you don't want in the briefing)",
          source: TYPES,
        },
      },
      {
        id: "subprojects",
        path: ["subprojects"],
        label: "Sub-project roots",
        kind: "subprojects",
        defaultable: true,
        quote: {
          text: "per-repo project-root globs; [] = force single-unit despite a manifest",
          source: TYPES,
        },
        note: "One repository per line: `repo: glob, glob`. `repo:` with nothing after it is an empty list.",
      },
    ],
  },
  {
    title: "Author",
    fields: [
      {
        id: "author.names",
        path: ["author", "names"],
        label: "Your git author names",
        kind: "lines",
        quote: { text: "author: MUST be an object of string-ARRAYS.", source: CONFIG },
      },
      {
        id: "author.emails",
        path: ["author", "emails"],
        label: "Your git author emails",
        kind: "lines",
      },
    ],
  },
  {
    title: "Provider (command-line tool)",
    when: "cli",
    fields: [
      {
        id: "provider.cli",
        path: ["provider", "cli"],
        label: "Command",
        kind: "text",
        required: true,
        quote: {
          text: '"provider" must be { cli: string, argv: string[], promptVia: "stdin"|"arg" }',
          source: CONFIG,
        },
      },
      {
        id: "provider.argv",
        path: ["provider", "argv"],
        label: "Arguments",
        kind: "lines",
        required: true,
        quote: {
          text: "a --settings file can register a SessionStart hook, which was measured executing arbitrary shell even under full hardening",
          source: HARDEN,
        },
        note: ARGV_NOTE,
      },
      {
        id: "provider.promptVia",
        path: ["provider", "promptVia"],
        label: "How the prompt is passed",
        kind: "choice",
        options: ["stdin", "arg"],
        required: true,
      },
      {
        id: "provider.harden",
        path: ["provider", "harden"],
        label: "Harden the provider call",
        kind: "bool",
        quote: {
          text: "All-or-nothing — a partial opt-out (re-enabling tools via `--tools default`) would silently drop ALL MCP servers, measured 2 → 0, with no way for the user to decline. `false` also skips the capability probe entirely.",
          source: TYPES,
        },
      },
      {
        id: "provider.credential",
        path: ["provider", "credential"],
        label: "Credential",
        kind: "choice",
        options: ["subscription", "env-api-key"],
        quote: {
          text: '"subscription" (the default, and what an omitted field resolves to) withholds the key so the CLI uses its logged-in session; "env-api-key" passes whatever is in the environment through.',
          source: TYPES,
        },
      },
      {
        id: "provider.accounts",
        path: ["provider", "accounts"],
        label: "Failover accounts, in order",
        kind: "accounts",
        quote: {
          text: 'ordered failover list. Absent/empty ⇒ the CLI\'s own default login, i.e. today\'s behaviour exactly (no CLAUDE_CONFIG_DIR is set). `label` is what limit marks are keyed by and must be unique; `configDir` absent means "use the default login", which is how the primary is expressed without rewriting a working setup.',
          source: TYPES,
        },
        note: "One account per line: `label` or `label = config directory`.",
      },
    ],
  },
  {
    title: "Provider (API)",
    when: "api",
    fields: [
      {
        id: "provider.api.kind",
        path: ["provider", "api", "kind"],
        label: "API",
        kind: "choice",
        options: ["anthropic", "openai-compatible"],
        required: true,
      },
      {
        id: "provider.api.model",
        path: ["provider", "api", "model"],
        label: "Model",
        kind: "text",
        required: true,
        quote: {
          text: "REQUIRED and deliberately never defaulted: a silently-chosen model changes briefing content without a config change",
          source: TYPES,
        },
      },
      {
        id: "provider.api.baseUrl",
        path: ["provider", "api", "baseUrl"],
        label: "Endpoint",
        kind: "text",
        quote: {
          text: "Anthropic: defaults to `https://api.anthropic.com`; set it to front a gateway or proxy. openai-compatible: REQUIRED in practice (there is no universal default endpoint).",
          source: TYPES,
        },
      },
      {
        id: "provider.api.maxTokens",
        path: ["provider", "api", "maxTokens"],
        label: "Maximum output tokens",
        kind: "number",
        quote: {
          text: "Anthropic REQUIRES `max_tokens`, so an absent value means the built-in default.",
          source: TYPES,
        },
      },
      {
        id: "provider.api.apiKeyFile",
        path: ["provider", "api", "apiKeyFile"],
        label: "Key file",
        kind: "text",
        quote: {
          text: "KEY SOURCING is a four-rung, first-hit-wins ladder, and only CONFIGURED rungs are tried",
          source: TYPES,
        },
      },
      {
        id: "provider.api.apiKeyCommand",
        path: ["provider", "api", "apiKeyCommand"],
        label: "Key command",
        kind: "lines",
        note: "One argument per line — the command is run directly, never through a shell.",
      },
      {
        id: "provider.api.apiKeyEnv",
        path: ["provider", "api", "apiKeyEnv"],
        label: "Key environment variable",
        kind: "text",
        note: "Neither this app nor the background scheduler passes your shell's environment to the engine, so a key named here is not found when the briefing runs from either — only a run from your own terminal sees it. Prefer a key file or a key command.",
      },
    ],
  },
  {
    // `timeoutMs` bounds BOTH provider kinds (`src/config.ts`: "EVERY check below applies to BOTH
    // shapes"), so it is not in either kind's section.
    title: "Provider timeout",
    fields: [
      {
        id: "provider.timeoutMs",
        path: ["provider", "timeoutMs"],
        label: "Timeout (milliseconds)",
        kind: "number",
        quote: {
          text: "timeoutMs: per-provider-call timeout (default 120s) — raise for a slow local model / big multi-repo window",
          source: TYPES,
        },
        note: "Applies to a command-line provider and to an API provider alike.",
      },
    ],
  },
  {
    title: "Briefing",
    fields: [
      {
        id: "lookbackCapDays",
        path: ["lookbackCapDays"],
        label: "Look back at most (days)",
        kind: "number",
        note: "The engine's default is 4.",
      },
      {
        id: "tokenBudget.maxChars",
        path: ["tokenBudget", "maxChars"],
        label: "Prompt budget (characters)",
        kind: "number",
        quote: {
          text: "Keep this high so stage 2 of reduce() (which drops activities/evidence, see src/reduce.ts) stays a rare safety net for pathological monorepos rather than tripping on a normal busy day.",
          source: CONFIG,
        },
      },
      {
        id: "excludeCommitPatterns",
        path: ["excludeCommitPatterns"],
        label: "Commit subjects to ignore (regular expressions)",
        kind: "lines",
        defaultable: true,
        quote: {
          text: "subjects matching any (regex) are tagged `meta.excluded` as bot/auto noise",
          source: TYPES,
        },
      },
      {
        id: "auditJudgeArgv",
        path: ["auditJudgeArgv"],
        label: "Extra arguments for the audit judge",
        kind: "lines",
        quote: {
          text: "Extra argv for the AUDIT JUDGE only — the briefing generator never sees it.",
          source: TYPES,
        },
      },
      {
        id: "morningTime",
        path: ["morningTime"],
        label: "Morning floor (HH:MM)",
        kind: "text",
        placeholder: "07:20",
        quote: {
          text: '24h "HH:MM" local floor; below it, scheduled runs no-op. Default "07:20".',
          source: TYPES,
        },
      },
    ],
  },
  {
    title: "Network and notifications",
    fields: [
      {
        id: "networkProbeHosts",
        path: ["networkProbeHosts"],
        label: "Connectivity check targets",
        kind: "hosts",
        defaultable: true,
        quote: {
          text: "TCP connectivity-probe targets; [] disables the gate (local/offline providers). Default anycast 1.1.1.1:443 / 8.8.8.8:443.",
          source: TYPES,
        },
        note: "One target per line: `host:port`.",
      },
      {
        id: "notify",
        path: ["notify"],
        label: "The engine's own notification",
        kind: "notify",
        quote: {
          text: '`"auto"` — best effort per OS: `osascript` on darwin, `notify-send` on linux, NOTHING on win32.',
          source: TYPES,
        },
        note: "For a command, give one argument per line; {title}, {body} and {path} are filled in.",
      },
    ],
  },
];

/* ── paths ────────────────────────────────────────────────────────────────────────────────────── */

function isObject(v: unknown): v is Draft {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function getPath(draft: Draft, path: string[]): unknown {
  let cur: unknown = draft;
  for (const key of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

export function hasPath(draft: Draft, path: string[]): boolean {
  let cur: unknown = draft;
  for (const key of path) {
    if (!isObject(cur) || !Object.prototype.hasOwnProperty.call(cur, key)) return false;
    cur = cur[key];
  }
  return true;
}

/** Set in place. An existing key keeps its position; a missing parent object is created at the end. */
export function setPath(draft: Draft, path: string[], value: unknown): void {
  let cur: Draft = draft;
  for (const key of path.slice(0, -1)) {
    const next = cur[key];
    if (!isObject(next)) cur[key] = {};
    cur = cur[key] as Draft;
  }
  const last = path[path.length - 1];
  if (last !== undefined) cur[last] = value;
}

/** Remove in place. A parent left empty is kept (it was the user's). */
export function deletePath(draft: Draft, path: string[]): void {
  const parent = getPath(draft, path.slice(0, -1));
  const last = path[path.length - 1];
  if (isObject(parent) && last !== undefined) delete parent[last];
}

/* ── the provider shape ───────────────────────────────────────────────────────────────────────── */

export function providerShape(draft: Draft): "cli" | "api" {
  return isObject(getPath(draft, ["provider", "api"])) ? "api" : "cli";
}

export function sectionsFor(draft: Draft): Section[] {
  const shape = providerShape(draft);
  return SECTIONS.filter((s) => s.when === undefined || s.when === shape);
}

/* ── reading a field into its input ───────────────────────────────────────────────────────────── */

const lines = (s: string): string[] =>
  s
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l !== "");

function stringsOf(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => (typeof x === "string" ? x : JSON.stringify(x))) : [];
}

/** The text an input shows for this field. */
export function readField(draft: Draft, field: Field): string {
  const v = getPath(draft, field.path);
  switch (field.kind) {
    case "text":
    case "choice":
      return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
    case "number":
      return typeof v === "number" ? String(v) : v === undefined ? "" : JSON.stringify(v);
    case "bool":
      return v === true ? "true" : v === false ? "false" : "";
    case "lines":
      return stringsOf(v).join("\n");
    case "accounts":
      return (Array.isArray(v) ? v : [])
        .map((a) => {
          if (!isObject(a)) return JSON.stringify(a);
          const label = typeof a.label === "string" ? a.label : "";
          return typeof a.configDir === "string" ? `${label} = ${a.configDir}` : label;
        })
        .join("\n");
    case "subprojects":
      return (Array.isArray(v) ? v : [])
        .map((p) => (isObject(p) ? `${String(p.repo ?? "")}: ${stringsOf(p.roots).join(", ")}` : JSON.stringify(p)))
        .join("\n");
    case "hosts":
      return (Array.isArray(v) ? v : [])
        .map((h) => (isObject(h) ? `${String(h.host ?? "")}:${String(h.port ?? "")}` : JSON.stringify(h)))
        .join("\n");
    case "notify":
      return typeof v === "string" ? v : isObject(v) ? "command" : "";
  }
}

/** The command lines of a `{ command: [...] }` notify value. */
export function readNotifyCommand(draft: Draft): string {
  const v = getPath(draft, ["notify"]);
  return isObject(v) ? stringsOf(v.command).join("\n") : "";
}

/* ── writing an input into the draft ──────────────────────────────────────────────────────────── */

/** Rebuild a list of objects from new entries, starting each from the matching existing entry. */
function merged(existing: unknown, key: string, fresh: Draft[]): Draft[] {
  const old = Array.isArray(existing) ? existing.filter(isObject) : [];
  return fresh.map((entry) => {
    const match = old.find((o) => o[key] === entry[key]);
    const out: Draft = match ? { ...match } : {};
    for (const [k, v] of Object.entries(entry)) {
      if (v === undefined) delete out[k];
      else out[k] = v;
    }
    return out;
  });
}

/**
 * Apply an input to the draft. Returns an error message (and changes nothing) when the input
 * cannot be expressed; `null` when it was applied.
 *
 * Emptiness: a required field keeps an empty value; a `defaultable` list that is PRESENT becomes
 * `[]` and one that is absent stays absent (switching between the two is `useDefault` /
 * `useEmptyList`, never a side effect of an empty box); any other empty input removes the key —
 * which, for the fields concerned, the engine treats exactly like an empty one.
 */
export function writeField(draft: Draft, field: Field, input: string): string | null {
  const text = input.trim();
  const empty = (emptyValue: unknown) => {
    if (field.required || (field.defaultable && hasPath(draft, field.path))) {
      setPath(draft, field.path, emptyValue);
    } else {
      deletePath(draft, field.path);
    }
    return null;
  };
  switch (field.kind) {
    case "text":
    case "choice":
      if (text === "") return field.required ? (setPath(draft, field.path, ""), null) : empty("");
      if (field.kind === "choice" && field.options && !field.options.includes(text)) {
        return `must be one of: ${field.options.join(", ")}`;
      }
      setPath(draft, field.path, text);
      return null;
    case "number": {
      if (text === "") {
        deletePath(draft, field.path);
        return null;
      }
      const n = Number(text);
      if (!Number.isFinite(n)) return "must be a number";
      setPath(draft, field.path, n);
      return null;
    }
    case "bool":
      if (text === "") deletePath(draft, field.path);
      else if (text === "true" || text === "false") setPath(draft, field.path, text === "true");
      else return "must be on, off or the engine default";
      return null;
    case "lines": {
      const list = lines(input);
      return list.length === 0 ? empty([]) : (setPath(draft, field.path, list), null);
    }
    case "accounts": {
      const fresh: Draft[] = [];
      for (const line of lines(input)) {
        const at = line.indexOf("=");
        const label = (at < 0 ? line : line.slice(0, at)).trim();
        const dir = at < 0 ? undefined : line.slice(at + 1).trim();
        if (label === "") return `"${line}" has no label`;
        fresh.push({ label, configDir: dir === "" ? undefined : dir });
      }
      if (fresh.length === 0) return empty([]);
      setPath(draft, field.path, merged(getPath(draft, field.path), "label", fresh));
      return null;
    }
    case "subprojects": {
      const fresh: Draft[] = [];
      for (const line of lines(input)) {
        const at = line.indexOf(":");
        if (at <= 0) return `"${line}" is not \`repo: glob, glob\``;
        const roots = line
          .slice(at + 1)
          .split(",")
          .map((r) => r.trim())
          .filter((r) => r !== "");
        fresh.push({ repo: line.slice(0, at).trim(), roots });
      }
      if (fresh.length === 0) return empty([]);
      setPath(draft, field.path, merged(getPath(draft, field.path), "repo", fresh));
      return null;
    }
    case "hosts": {
      const fresh: Draft[] = [];
      for (const line of lines(input)) {
        const at = line.lastIndexOf(":");
        const host = at <= 0 ? "" : line.slice(0, at).trim();
        const port = Number(line.slice(at + 1));
        if (host === "" || !Number.isInteger(port) || port < 1 || port > 65535) {
          return `"${line}" is not \`host:port\``;
        }
        fresh.push({ host, port });
      }
      if (fresh.length === 0) return empty([]);
      setPath(draft, field.path, merged(getPath(draft, field.path), "host", fresh));
      return null;
    }
    case "notify": {
      if (text === "") {
        deletePath(draft, field.path);
      } else if (text === "off" || text === "auto") {
        setPath(draft, field.path, text);
      } else if (text === "command") {
        if (!isObject(getPath(draft, field.path))) setPath(draft, field.path, { command: [] });
      } else {
        return "must be off, auto, a command, or the engine default";
      }
      return null;
    }
  }
}

/** The command lines of `notify`, when it is a command. */
export function writeNotifyCommand(draft: Draft, input: string): void {
  const v = getPath(draft, ["notify"]);
  if (isObject(v)) v.command = lines(input);
}

/** A `defaultable` field: remove the key so the engine's default applies. */
export function useDefault(draft: Draft, field: Field): void {
  deletePath(draft, field.path);
}

/** A `defaultable` field: write an explicit empty list (e.g. `networkProbeHosts: []` disables the
 *  network gate), unless the field already holds a value. */
export function useEmptyList(draft: Draft, field: Field): void {
  if (!hasPath(draft, field.path)) setPath(draft, field.path, []);
}

/** The stored literal key, removed. Allowed from the app; setting one is not. */
export function removeStoredApiKey(draft: Draft): void {
  deletePath(draft, ["provider", "api", "apiKey"]);
}

export function hasStoredApiKey(draft: Draft): boolean {
  return hasPath(draft, ["provider", "api", "apiKey"]);
}

/* ── the save decision (pure, so it is tested — review round 1, W5/W6) ─────────────────────────── */

/** Is this field currently shown AND editable? A field of the other provider kind is hidden; a
 *  `defaultable` field left at the engine's default has its input disabled. */
export function fieldIsLive(draft: Draft, field: Field): boolean {
  if (!sectionsFor(draft).some((s) => s.fields.includes(field))) return false;
  return !(field.defaultable === true && !hasPath(draft, field.path));
}

/** The field errors that still matter: non-empty, on a field that is shown and editable. An error
 *  on a field that has since been hidden or disabled no longer describes anything the user sees. */
export function liveErrors(draft: Draft, errors: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of SECTIONS.flatMap((s) => s.fields)) {
    const e = errors[f.id];
    if (e !== undefined && e !== "" && fieldIsLive(draft, f)) out[f.id] = e;
  }
  return out;
}

/** JSON equality as `JSON.parse` output: key order ignored, numbers by value. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((x, i) => jsonEqual(x, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return (
      keys.length === Object.keys(b).length &&
      keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && jsonEqual(a[k], b[k]))
    );
  }
  return false;
}

/** The text the raw-JSON tab shows for a draft — exactly what a form save would send. */
export function rawFromDraft(draft: Draft): string {
  return JSON.stringify(draft, null, 2);
}

/** Parse raw text as a config object, or `null`. */
export function parseDraft(text: string): Draft | null {
  try {
    const v: unknown = JSON.parse(text);
    return isObject(v) ? v : null;
  } catch {
    return null;
  }
}

export type FormSubmission =
  | { kind: "blocked"; message: string }
  | { kind: "unchanged" }
  | { kind: "save"; text: string };

/**
 * What the Save button does on the form tab.
 *
 * ⚠ BLOCKED while any LIVE field has an error: a rejected input was never written into the draft,
 * so saving would silently save the OLD value under a field that shows the new one.
 * ⚠ UNCHANGED — no IPC at all — when the draft equals the loaded document as JSON values, so the
 * JavaScript re-spelling of numbers never turns an untouched form into a write.
 */
export function formSubmission(
  draft: Draft,
  loadedText: string | null,
  errors: Record<string, string>,
): FormSubmission {
  if (Object.keys(liveErrors(draft, errors)).length > 0) {
    return { kind: "blocked", message: "Not saved: fix the fields marked above first." };
  }
  const loaded = loadedText === null ? null : parseDraft(loadedText);
  if (loaded !== null && jsonEqual(draft, loaded)) return { kind: "unchanged" };
  return { kind: "save", text: rawFromDraft(draft) };
}

/* ── an unsaved draft survives leaving the screen ─────────────────────────────────────────────── */

/** What `Settings.svelte` keeps when it is unmounted (a route change), so an unsaved edit is not
 *  lost. In memory only: a webview reload or an app restart starts from the file again. */
export interface KeptSettings {
  /** The `base` token the draft was loaded with — a save still conflicts if the file changed. */
  base: string;
  loadedText: string;
  tab: "form" | "raw";
  draft: Draft | null;
  raw: string;
  errors: Record<string, string>;
}

/** Has the user changed anything? (The raw tab's text, or the form's draft, differs as JSON values
 *  from what was loaded — a reformatted but equal raw text is not a change.) */
export function isDirty(k: KeptSettings): boolean {
  const loaded = parseDraft(k.loadedText);
  if (k.tab === "raw") {
    const raw = parseDraft(k.raw);
    return raw === null ? k.raw !== k.loadedText : loaded === null || !jsonEqual(raw, loaded);
  }
  return k.draft !== null && (loaded === null || !jsonEqual(k.draft, loaded));
}

let kept: KeptSettings | null = null;

/** Keep an unsaved Settings state for the next mount; a clean one is dropped (the next mount then
 *  loads the file fresh). */
export function keepSettings(k: KeptSettings): void {
  kept = isDirty(k) ? k : null;
}

/** The kept state, once. */
export function takeKeptSettings(): KeptSettings | null {
  const k = kept;
  kept = null;
  return k;
}

/** A save the Settings screen sent: the `base` token and the text. */
export interface SentSave {
  base: string;
  text: string;
}

/** The kept edit's content as a config value: the raw text on the raw tab, the draft on the form. */
function keptValue(k: KeptSettings): Draft | null {
  return k.tab === "raw" ? parseDraft(k.raw) : k.draft;
}

/**
 * What remains of a kept edit once a save from the SAME screen visit has answered (review round 2,
 * V2). The screen can be left while its save is still in flight: `onDestroy` keeps the draft with
 * the base it was loaded with, and the save's own reload then runs on a component that is gone. So
 * the draft came back as "unsaved" and — the file having changed under it — its next save was a
 * conflict. The rule:
 *
 * - a kept edit from another load (a different `base`), or after a save that did not land
 *   (`invalid`, or a refusal), is kept as it is;
 * - after `saved` or `unchanged`, a kept edit that is the text that was sent (as JSON values) is
 *   DROPPED — it is on disk now;
 * - ⚠ one that differs (typed after pressing Save) is kept. After `saved` its base is stale, so its
 *   save is refused as a conflict and says so; it is never rebased onto the new file here, because
 *   nothing on this side can tell that file from one another program wrote meanwhile.
 */
export function keptAfterSave(
  k: KeptSettings | null,
  sent: SentSave,
  outcome: SaveOutcome["kind"] | "failed",
): KeptSettings | null {
  if (k === null || k.base !== sent.base) return k;
  if (outcome !== "saved" && outcome !== "unchanged") return k;
  const value = keptValue(k);
  const saved = parseDraft(sent.text);
  return value !== null && saved !== null && jsonEqual(value, saved) ? null : k;
}

/** Apply `keptAfterSave` to the kept state. `Settings.svelte` calls it when a save has answered. */
export function settleKeptSettings(sent: SentSave, outcome: SaveOutcome["kind"] | "failed"): void {
  kept = keptAfterSave(kept, sent, outcome);
}

/* ── the Quit dialog's offer, decided from the config as it is ───────────────────────────────── */

/** What the Quit dialog offers for the engine's `notify` (plan R1 T11, review round 1). */
export type NotifyOffer =
  /** The config is being read. */
  | { kind: "checking" }
  /** Offer it. `invalid`: the configured value is one the engine does not accept (it posts nothing). */
  | { kind: "offer"; current: "off" | "invalid" }
  /** Already `"auto"`: nothing to offer. */
  | { kind: "already" }
  /** The engine runs the user's own command: not replaced from the Quit dialog. */
  | { kind: "custom" }
  /** The config could not be read here; the button stays and the save path answers for itself. */
  | { kind: "unknown" };

/** A `notify` value the engine RUNS as a command — `src/notify.ts`, `resolveNotify`: an object whose
 *  `command` is a non-empty array of strings. The Rust save path applies the same rule
 *  (`config_save::is_custom_notify`) and is the one that refuses. */
export function isCustomNotify(v: unknown): boolean {
  if (!isObject(v)) return false;
  const c = v.command;
  return Array.isArray(c) && c.length > 0 && c.every((x) => typeof x === "string");
}

/** The offer for this config text (`config_read`'s `text`, or `null` when there is none to read). */
export function notifyOffer(configText: string | null): NotifyOffer {
  const draft = configText === null ? null : parseDraft(configText);
  if (draft === null) return { kind: "unknown" };
  const v = draft.notify;
  if (v === "auto") return { kind: "already" };
  if (isCustomNotify(v)) return { kind: "custom" };
  // `resolveNotify`: absent, null and "off" are off; every other shape is off WITH a warning.
  return { kind: "offer", current: v === undefined || v === null || v === "off" ? "off" : "invalid" };
}

/** Can the button be pressed for this offer? (`unknown`: yes — the save path answers for itself.) */
export function offerTakeable(offer: NotifyOffer): boolean {
  return offer.kind === "offer" || offer.kind === "unknown";
}

/** The one line the Quit dialog shows under the offer for this state, or `null`. Built here, not in
 *  the dialog's markup, which carries no wording of its own (B4). */
export function offerNote(offer: NotifyOffer): string | null {
  switch (offer.kind) {
    case "checking":
      return "Checking the engine's current notification setting…";
    case "already":
      return 'The engine\'s own notifications are already set to "auto"; there is nothing to switch.';
    case "custom":
      return 'The engine runs your own notification command, so it is not replaced from here. Change it on the Settings screen if you want "auto" instead.';
    case "offer":
      return offer.current === "invalid"
        ? 'The configured notification setting is not one the engine accepts, so the engine currently posts nothing. This replaces it with "auto".'
        : null;
    case "unknown":
      return null;
  }
}

/** Every quote in the table, for the verbatim check. */
export function allQuotes(): Quote[] {
  return SECTIONS.flatMap((s) => s.fields.flatMap((f) => (f.quote ? [f.quote] : [])));
}
