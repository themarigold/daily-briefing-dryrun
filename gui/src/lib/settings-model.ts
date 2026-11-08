/**
 * T15's form model: the fields of the engine's `Config` (`src/types.ts`) that the Settings form
 * edits, and how a form input is read from and written into the PARSED config.
 *
 * ⚠ THE FORM EDITS THE LOADED OBJECT IN PLACE; IT NEVER BUILDS A FRESH ONE. Unknown keys — a
 * newer engine's additive fields, a hand-written note — and the order of every key survive a save
 * because nothing here constructs a config from form state (appendix T13/T15's stated risk: "a form
 * that silently drops an unknown field would destroy a hand-edited config"). A list of objects is
 * rebuilt by MATCHING existing entries (a sub-project by repo, a host by name), so an unknown key inside an
 * entry survives an edit of that list too. The providers list (P3-M4-T1, the section at the end) goes through the
 * list writer, which keeps an entry's unknown keys the same way.
 *
 * ⚠ `transcripts` IS NOT A FIELD. Plan R1 drops it from the form entirely: re-enabling transcripts
 * is a human gate, not an app setting, and the save path refuses any change to it
 * (`src-tauri/src/config_save.rs`) whether it comes from here or from the JSON editor (Settings → Advanced, "Edit
 * settings as JSON").
 *
 * ⚠ THE FORM SHOWS `help`, AND KEEPS `quote` UNSHOWN (v0.2.1 §4.1). `help` is this app's own plain
 * wording for a person setting the field: one or two sentences, no file names, no code terms
 * (`gui/tests-web/settings.check.ts` refuses the obvious leaks). Every `quote` is still a verbatim
 * fragment of the engine source it names, and that test still reads those files and requires each
 * fragment to be there — so the model keeps tracking the engine's documented semantics even though
 * the quote is no longer rendered. `note` is extra wording a field needs beyond its help.
 *
 * ⚠ AN UNTOUCHED FORM SAVES NOTHING. The form round-trips the config through JavaScript, which
 * rewrites some spellings — `1.0` → `1`, `-0` → `0`, integer-like keys ("1", "42") listed first — so
 * `formSubmission` compares the draft with the loaded document as VALUES first and never calls the
 * save when they are equal. An EDITED form save still carries those rewrites for the whole file
 * (docs/gui-seam.md §10g, deviation 48); a save from the JSON editor does not (Rust parses that text itself).
 * No key the engine defines is integer-like.
 */

import { stripControl } from "./briefing-struct";
import { NOTICE_PREFIX, renderMarkdown } from "./briefing-md";
import { briefingDate, localDate, type SummaryStatus } from "./today";
import {
  testModeFor,
  type CheckMode,
  type CheckOutcome,
  type EngineOutcome,
  type ProviderRefusal,
  type ProviderResetAnswer,
  type ProviderTestAnswer,
  type ProviderValidateRow,
} from "./engine";
import { EDIT_AS_JSON, describeFailure, type ConfigDocument, type SaveOutcome } from "./files";
import { parseMorningTime, storedTimeNote } from "./morning-time";
import { hereWords, type Os } from "./platform";
import {
  cliName,
  isClaudeCli,
  isObject,
  KEY_SOURCES,
  moveEntry,
  plain,
  readProviderList,
  removeEntry,
  setEntrySettings,
  writeProviderList,
  type Blocked,
  type KeySource,
  type ProviderEntry,
  type ReadRefusal,
} from "./provider-list";
import { JUDGE_LINE } from "./wizard";

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
  | "subprojects"
  | "hosts"
  | "notify"
  /** v0.2.1 §3.2: an hour and a minute dropdown writing `HH:MM` (`lib/MorningTimeSelect.svelte`). */
  | "time"
  /** User-directed 2026-10-22 (P2): the first provider's command-line tool, by name (`TOOL_PRESETS`) or "other"
   *  (`toolChoiceOf`); a named tool writes its command, arguments and prompt passing together. */
  | "tool";

export interface Field {
  /** Stable id, also the input's DOM id suffix. */
  id: string;
  path: string[];
  label: string;
  kind: FieldKind;
  /** For `choice`: the allowed values. `""` (absent) is offered as "engine default", unless `absentAs` names the value
   *  the engine reads absent as. */
  options?: string[];
  /** For `choice`: how each value is worded on screen (absent: the value itself). */
  optionLabels?: Record<string, string>;
  /** For `choice` (user-directed 2026-10-22, P3): the option an absent value is drawn as — the engine reads absent as
   *  that value, so no separate "engine default" is offered. Drawn only: absent is written only when the user changes
   *  the choice. */
  absentAs?: string;
  /** Required by the engine: an empty input writes an empty value rather than removing the key. */
  required?: boolean;
  /** An empty list is meaningful and different from an absent key (offered as a separate toggle). */
  defaultable?: boolean;
  /** v0.2.1 §4.1: what the form shows under the field — plain sentences, this app's own words. */
  help: string;
  /** Which provider shape this field applies to; absent = always. Needed where a section mixes
   *  shapes (Advanced); `sectionsFor` applies it as well as the section's own `when`. */
  when?: "cli" | "api";
  /** The engine source's own comment, verbatim. NOT shown (v0.2.1 §4.1); pinned by a test. */
  quote?: Quote;
  note?: string;
  placeholder?: string;
}

/** Redesign D: the Settings page that draws a section. Only these four pages hold config fields; Calendar,
 *  Editor & links and About hold none (`settings/pages.ts` lists all seven). */
export type ConfigPage = "general" | "projects" | "providers" | "advanced";

export interface Section {
  title: string;
  /** Which Settings page draws the section, and so every field in it (redesign D). */
  page: ConfigPage;
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

/** User-directed 2026-10-22 (P1, P2): the command-line tools the app offers by name — the engine's own `init` values
 *  (`src/config.ts` `initConfig`: `claude -p`, else `codex exec`, the prompt on standard input). Any other command is
 *  "Other…", with its command and its arguments as typed. */
export type ToolChoice = "claude" | "codex" | "other";
export const TOOL_PRESETS = [
  { id: "claude", label: "Claude Code (claude)", cli: "claude", argv: ["-p"], promptVia: "stdin" },
  { id: "codex", label: "Codex (codex)", cli: "codex", argv: ["exec"], promptVia: "stdin" },
] as const;
export const TOOL_OTHER_LABEL = "Other…";

/** Which of `TOOL_PRESETS` a command-line block is — its command named that tool (`cliName`: for Claude, the engine's
 *  own `claudeShaped` reading, so a path such as `/opt/homebrew/bin/claude` counts; Codex read the same way, display
 *  only) AND its arguments and prompt passing exactly that tool's — else "other", shown with its own values. */
export function toolChoiceOf(block: unknown): ToolChoice {
  if (!isObject(block) || typeof block["cli"] !== "string" || block["api"] !== undefined) return "other";
  const name = cliName(block["cli"]);
  const preset = TOOL_PRESETS.find((t) => t.cli === name && jsonEqual(block["argv"], t.argv) && block["promptVia"] === t.promptVia);
  return preset?.id ?? "other";
}

/** P2: Other's two rows under the first provider's Command — that block's own command and arguments (one per line).
 *  Not in `SECTIONS`: they are drawn only while Other is chosen, and their ids are their own, since the Advanced page
 *  draws `provider.argv` too. */
export const TOOL_COMMAND_FIELD: Field = {
  id: "provider.cli.other",
  path: ["provider", "cli"],
  label: "Command to run",
  help: "The command's name, if it is on your PATH, or its full path.",
  kind: "text",
  required: true,
};
export const TOOL_ARGS_FIELD: Field = {
  id: "provider.argv.other",
  path: ["provider", "argv"],
  label: "Its arguments",
  help: "The options the command is given every time it writes your briefing, one per line.",
  kind: "lines",
  required: true,
  note: ARGV_NOTE,
};

export const SECTIONS: Section[] = [
  {
    title: "Repositories",
    page: "projects",
    // ⚠ EITHER/OR, NOT BOTH (M3b checkpoint fix): the engine's `discoverRepos` (`src/config.ts`)
    // returns a non-empty `repos` as-is and never walks `discoverRoots` for the briefing — the
    // folders are searched only while `repos` is empty. `init` and the wizard write both keys, so
    // help that promised "in addition to" described the opposite of most users' config.
    // `settings.check.ts` runs the engine's function against both help strings.
    fields: [
      {
        id: "repos",
        path: ["repos"],
        label: "Repositories",
        help:
          "Repositories the briefing reads. When this list has anything in it, the briefing reads only these and does not search the folders below for more.",
        kind: "lines",
        note: "One path per line. A leading ~ is expanded by the engine.",
        placeholder: "~/code/my-project",
      },
      {
        id: "discoverRoots",
        path: ["discoverRoots"],
        label: "Folders to search",
        help:
          "Folders the briefing searches for repositories, two levels deep, each time it runs — but only while the Repositories list above is empty.",
        kind: "lines",
        note: "One path per line. A leading ~ is expanded by the engine.",
      },
      {
        id: "excludeRepos",
        path: ["excludeRepos"],
        label: "Repositories to leave out",
        help:
          "Repositories to leave out of the briefing, even when they are listed above or found in a searched folder. Give the full path, or just the folder's name.",
        kind: "lines",
        quote: {
          text: "repos to drop from BOTH explicit `repos` and discovery — by absolute path or basename (e.g. a stale/work checkout you don't want in the briefing)",
          source: TYPES,
        },
      },
    ],
  },
  // Post-cap (R5-M6): titled "You", as the approved S-A mockup's group; the fields and the engine's keys are unchanged.
  {
    title: "You",
    page: "projects",
    fields: [
      {
        id: "author.names",
        path: ["author", "names"],
        label: "Your git author names",
        help:
          "The names your commits are made under, so the briefing reports your work and not your coworkers'. With both lists empty, each repository's own git identity is used.",
        kind: "lines",
        quote: { text: "author: MUST be an object of string-ARRAYS.", source: CONFIG },
      },
      {
        id: "author.emails",
        path: ["author", "emails"],
        label: "Your git author emails",
        help:
          "The email addresses your commits are made under. A commit that matches any name or email here counts as yours.",
        kind: "lines",
      },
    ],
  },
  {
    title: "Provider (command-line tool)",
    page: "providers",
    when: "cli",
    fields: [
      {
        id: "provider.cli",
        path: ["provider", "cli"],
        // User-directed 2026-10-22 (P-A): row 1's "Tool" and "Account", the Add form's and the mockup's words.
        label: "Tool",
        help:
          "The AI command-line tool that writes your briefing. Claude Code and Codex come with the options they need; Other runs any command you name, with the options you give it.",
        kind: "tool",
        required: true,
        quote: {
          text: '"provider" must be { cli: string, argv: string[], promptVia: "stdin"|"arg" }',
          source: CONFIG,
        },
      },
      {
        id: "provider.credential",
        path: ["provider", "credential"],
        label: "Account",
        // User-directed 2026-10-22 (P3): the engine withholds ANTHROPIC_API_KEY from EVERY command-line tool unless the
        // value is "env-api-key" (`src/harden.ts` `WITHHELD_ENV`, `envDelete`), absent included — so the choice stays
        // for every tool, and the help says which tools it changes nothing for.
        help:
          "Its own login keeps the ANTHROPIC_API_KEY environment variable away from the tool, so Claude Code uses your subscription and a key there is never billed by accident; the other choice passes that key through. A tool that does not read that variable, such as Codex, works the same either way.",
        kind: "choice",
        options: ["subscription", "env-api-key"],
        optionLabels: { subscription: "Its own login (subscription)", "env-api-key": "The API key in my environment" },
        absentAs: "subscription",
        quote: {
          text: '"subscription" (the default, and what an omitted field resolves to) withholds the key so the CLI uses its logged-in session; "env-api-key" passes whatever is in the environment through.',
          source: TYPES,
        },
      },
    ],
  },
  {
    title: "Provider (API)",
    page: "providers",
    when: "api",
    fields: [
      {
        id: "provider.api.kind",
        path: ["provider", "api", "kind"],
        label: "Kind of API",
        help:
          "Which kind of API the engine calls: Anthropic's own, or a service that speaks the OpenAI-compatible format, such as a local model server.",
        kind: "choice",
        options: ["anthropic", "openai-compatible"],
        required: true,
      },
      {
        id: "provider.api.model",
        path: ["provider", "api", "model"],
        label: "Model",
        help:
          "The model that writes your briefing. It has no default, because a different model changes what your briefing says.",
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
        label: "Address",
        help:
          "The address the engine sends its requests to. Anthropic needs none; an OpenAI-compatible service, such as a local model server, does.",
        kind: "text",
        quote: {
          text: "Anthropic: defaults to `https://api.anthropic.com`; set it to front a gateway or proxy. openai-compatible: REQUIRED in practice (there is no universal default endpoint).",
          source: TYPES,
        },
      },
      // ⚠ FIRST HIT WINS (M3b checkpoint fix): `resolveApiKey` (`src/apiKey.ts`) tries only the
      // CONFIGURED sources, in the order environment variable → key file → key command → a key
      // stored in the config, and stops at the first that gives a key. So the file is not read,
      // and the command is not run, on a run where a higher source already answered — the help
      // below must not promise "each time".
      {
        id: "provider.api.apiKeyFile",
        path: ["provider", "api", "apiKeyFile"],
        label: "Key file",
        help:
          "A file that contains only your API key, readable by you alone. The engine reads it when it writes your briefing, unless the key environment variable has already supplied a key.",
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
        help:
          "A command that prints your API key, such as a password manager's command-line tool. The engine runs it when it writes your briefing, unless the key environment variable or the key file has already supplied a key.",
        kind: "lines",
        note: "One argument per line — the command is run directly, never through a shell.",
      },
    ],
  },
  // Redesign D, user-directed 2026-10-21: Morning time first, then Look back (the approved S-A mockup's order).
  {
    title: "Briefing",
    page: "general",
    fields: [
      {
        id: "morningTime",
        path: ["morningTime"],
        label: "Morning time",
        help: "Your briefing is generated on the first check after this time once your machine is awake.",
        kind: "time",
        quote: {
          text: '24h "HH:MM" local floor; below it, scheduled runs no-op. Default "07:20".',
          source: TYPES,
        },
      },
      {
        id: "lookbackCapDays",
        path: ["lookbackCapDays"],
        label: "Look back at most (days)",
        help:
          "How many days back the briefing looks for your last day of work. After a longer break, work older than this is left out.",
        kind: "number",
        note: "The engine's default is 4.",
      },
      // A2-M5-T15. No default anywhere: absent stays absent, and an untouched save writes no `aiSummary`.
      {
        id: "aiSummary.enabled",
        path: ["aiSummary", "enabled"],
        label: "AI summaries",
        help: "Short project points and a Good morning sentence, generated after your briefing. Shown on the desktop app's slides.",
        kind: "bool",
        note: "The engine default is off.",
      },
    ],
  },
  // Redesign D: the engine's own setting, on Advanced. The app's own notification control is on General. When
  // this setting resolves to a real notifier, the app posts no delivery notice of its own (`notifications.rs`).
  {
    title: "Notifications from the engine",
    page: "advanced",
    fields: [
      {
        id: "notify",
        path: ["notify"],
        label: "Notifications from the engine",
        help:
          "Whether the engine itself announces a new briefing: off, the system's own notification where there is one, or a command you choose. While it is active on this platform, this app stays quiet about deliveries and still reports failures.",
        kind: "notify",
        quote: {
          text: '`"auto"` — best effort per OS: `osascript` on darwin, `notify-send` on linux, NOTHING on win32.',
          source: TYPES,
        },
        note: "For a command, give one argument per line; {title}, {body} and {path} are filled in.",
      },
    ],
  },
  // Phase E (E12): the AUTOMATIC update check. "Check now" (the row under these two fields in General's one Updates
  // group, redesign D) ignores both
  // fields; they gate only the engine's own scheduled-run check (`src/updateCheck.ts`).
  {
    title: "Update check",
    page: "general",
    fields: [
      {
        id: "updateCheck.enabled",
        path: ["updateCheck", "enabled"],
        label: "Check for updates automatically",
        help:
          "When on, a scheduled run that has just delivered your briefing asks GitHub whether a newer version exists; it downloads nothing and installs nothing.",
        kind: "bool",
        quote: {
          text: "It is notify-only: it downloads nothing and installs nothing, and the answer is only recorded for `status --json` and the desktop app. Absent, or anything other than `true`, means no automatic check at all.",
          source: TYPES,
        },
        note: "The engine default is off.",
      },
      {
        id: "updateCheck.intervalHours",
        path: ["updateCheck", "intervalHours"],
        label: "Hours between automatic checks",
        help:
          "The fewest hours between two automatic checks, a whole number from 1 to 720. The default is 24.",
        kind: "number",
        placeholder: "24",
        quote: {
          text: "the minimum number of hours between automatic checks — a whole number from 1 to 720, default 24.",
          source: TYPES,
        },
      },
    ],
  },
  // v0.2.1 §4.1: the fields most people never change, at the bottom (on their own page since redesign D). CLI-only
  // and API-only fields are mixed here, so each carries its own `when`. `provider.timeoutMs` has
  // none: it bounds BOTH provider kinds (`src/config.ts`: "EVERY check below applies to BOTH
  // shapes"). The key environment variable is here while the key file and key command are not, on
  // purpose: neither this app nor the background scheduler passes the shell's environment.
  {
    title: "Advanced",
    page: "advanced",
    fields: [
      {
        id: "subprojects",
        path: ["subprojects"],
        label: "Sub-project roots",
        help:
          "For a repository that holds several projects, which folders inside it count as separate projects. An empty list makes the briefing treat the whole repository as one project.",
        kind: "subprojects",
        defaultable: true,
        quote: {
          text: "per-repo project-root globs; [] = force single-unit despite a manifest",
          source: TYPES,
        },
        note: "One repository per line: `repo: glob, glob`. `repo:` with nothing after it is an empty list.",
      },
      {
        id: "provider.argv",
        path: ["provider", "argv"],
        label: "Arguments",
        help: "The options the engine gives the command-line tool every time it writes your briefing.",
        when: "cli",
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
        help:
          "How the engine hands the prompt to the tool: on its standard input, or as the last argument. Standard input suits most tools.",
        when: "cli",
        kind: "choice",
        options: ["stdin", "arg"],
        required: true,
      },
      {
        id: "provider.harden",
        path: ["provider", "harden"],
        label: "Harden the provider call",
        help:
          "On by default: the tool runs with its own tools, project settings and add-on servers switched off for the briefing call. Off turns all of them back on at once; there is no partial setting.",
        when: "cli",
        kind: "bool",
        quote: {
          text: "All-or-nothing — a partial opt-out (re-enabling tools via `--tools default`) would silently drop ALL MCP servers, measured 2 → 0, with no way for the user to decline. `false` also skips the capability probe entirely.",
          source: TYPES,
        },
      },
      // P3-M4-T1: "Failover accounts, in order" (`provider.accounts`, free text) was here. It is replaced by
      // "Providers, in order" (`lib/ProvidersList.svelte`, the providers section at the end of this file), which edits
      // the combined list — item 1's logins and `fallbacks` — through the list writer (`lib/provider-list.ts`).
      {
        id: "provider.api.maxTokens",
        path: ["provider", "api", "maxTokens"],
        label: "Maximum output tokens",
        help:
          "The longest reply the model may write. Left empty, Anthropic gets the engine's built-in limit of 16,000 tokens and an OpenAI-compatible service uses its own.",
        when: "api",
        kind: "number",
        quote: {
          text: "Anthropic REQUIRES `max_tokens`, so an absent value means the built-in default.",
          source: TYPES,
        },
      },
      {
        id: "provider.api.apiKeyEnv",
        path: ["provider", "api", "apiKeyEnv"],
        label: "Key environment variable",
        help:
          "The name of an environment variable that holds your API key. It is found only when you run the engine from your own terminal.",
        when: "api",
        kind: "text",
        note: "Neither this app nor the background scheduler passes your shell's environment to the engine, so a key named here is not found when the briefing runs from either — only a run from your own terminal sees it. Prefer a key file or a key command.",
      },
      {
        id: "provider.timeoutMs",
        path: ["provider", "timeoutMs"],
        label: "Timeout (milliseconds)",
        help:
          "How long one call to the AI may take, in milliseconds, before the engine gives up on it; the default is two minutes for a command-line provider and five minutes for an API provider. Raise it for a slow local model or a very large briefing.",
        kind: "number",
        quote: {
          text: "timeoutMs: per-provider-call timeout (default 120s for a CLI provider, 300s for an API provider) — raise for a slow local model / big multi-repo window",
          source: TYPES,
        },
        note: "Applies to a command-line provider and to an API provider alike.",
      },
      {
        id: "tokenBudget.maxChars",
        path: ["tokenBudget", "maxChars"],
        label: "Prompt budget (characters)",
        help:
          "The most repository detail, in characters, the engine gathers for one briefing's prompt; the instructions around it are not counted. Keep it high: past it, the engine trims that detail to fit.",
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
        help:
          "Commits whose subject matches any of these patterns, such as a bot's automatic commits, are left out of your briefing.",
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
        help:
          "Extra options for the developer self-audit, which this app never runs. The call that writes your briefing never uses them.",
        kind: "lines",
        quote: {
          text: "Extra argv for the AUDIT JUDGE only — the briefing generator never sees it.",
          source: TYPES,
        },
      },
      {
        id: "networkProbeHosts",
        path: ["networkProbeHosts"],
        label: "Connectivity check targets",
        help:
          "Before it writes, the engine checks that the network is up by connecting to these addresses, sending no data. An empty list turns the check off, which suits a local model.",
        kind: "hosts",
        defaultable: true,
        quote: {
          text: "TCP connectivity-probe targets; [] disables the gate (local/offline providers). Default when absent: anycast 1.1.1.1:443 / 8.8.8.8:443 with a CLI provider; with provider.api, the endpoint's own host and port ([] for a loopback endpoint).",
          source: TYPES,
        },
        note: "One target per line: `host:port`.",
      },
    ],
  },
];

/* ── paths ────────────────────────────────────────────────────────────────────────────────────── */


export function getPath(draft: Draft, path: string[]): unknown {
  let cur: unknown = draft;
  for (const key of path) {
    if (!isObject(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/** Is `key` an own key of `o`? Through `Object.keys`, never `hasOwnProperty`: in the app the draft is a Svelte `$state`
 *  proxy, whose `delete` keeps the key on its target, so its `getOwnPropertyDescriptor` trap — what `hasOwnProperty`
 *  asks — still answers for a removed key, while its `ownKeys` trap leaves it out (svelte 5.57.0,
 *  `src/internal/client/proxy.js`). Final round 3 (R3-H2, pre-existing): "Use the engine's default" was a no-op on
 *  screen because of it. Like `hasOwnProperty`, an inherited name (`toString`) is never an own key. */
function ownKey(o: Record<string, unknown>, key: string): boolean {
  return Object.keys(o).includes(key);
}

export function hasPath(draft: Draft, path: string[]): boolean {
  let cur: unknown = draft;
  for (const key of path) {
    if (!isObject(cur) || !ownKey(cur, key)) return false;
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

/** Remove in place. A parent left empty is kept, even one `setPath` made earlier in this edit: On then Engine default from
 *  an absent key leaves `aiSummary: {}`, which the engine reads as off with no warning. */
export function deletePath(draft: Draft, path: string[]): void {
  const parent = getPath(draft, path.slice(0, -1));
  const last = path[path.length - 1];
  if (isObject(parent) && last !== undefined) delete parent[last];
}

/* ── AI summaries: the line under the Briefing form ───────────────────────────────────────────── */

/** A2 :86/:88's fixed sentences, by status code. A code is mapped here and never drawn itself. */
const SUMMARY_WARNING_TEXT: Record<SummaryStatus["warnings"][number], string> = {
  "summary-unavailable": "AI summary unavailable; showing the existing card points.",
  "summary-text-omitted": "Some AI summary text was omitted.",
  "summary-usage-limit": "AI summary usage limit reached; showing the existing card points.",
  "summary-config-invalid": "AI summary setting is invalid; AI summaries are off.",
};

/** What General says under the AI summaries field: Windows' note (no summary is made there, Open question 3 (a)), then
 *  one sentence for each current code. The engine leaves old-version and other-identity diagnostics out of `warnings`. */
export function summaryStatusLines(status: SummaryStatus, os: Os): string[] {
  return [
    ...(os === "windows" ? ["AI summaries are not available on Windows yet."] : []),
    ...status.warnings.map((code) => SUMMARY_WARNING_TEXT[code]),
  ];
}

/* ── the provider shape ───────────────────────────────────────────────────────────────────────── */

export function providerShape(draft: Draft): "cli" | "api" {
  return isObject(getPath(draft, ["provider", "api"])) ? "api" : "cli";
}

/** The sections, and within each the fields, that apply to this draft's provider shape. A section
 *  left with no field is dropped. The `Field` objects are the model's own (not copies), so
 *  `fieldIsLive`'s identity check holds. */
/** Post-cap (R5-M4): the key a drawn section is kept by. The two provider sections share one — only one is ever drawn
 *  (`sectionsFor`, by the provider's kind) — so switching the kind in the JSON editor keeps that section's item, and
 *  "Providers, in order" drawn in it (a typed Add, a pasted key), mounted; every other section is keyed by its title. */
export function sectionKey(title: string): string {
  return title.startsWith("Provider (") ? "provider" : title;
}

export function sectionsFor(draft: Draft): Section[] {
  const shape = providerShape(draft);
  const applies = (when: "cli" | "api" | undefined) => when === undefined || when === shape;
  return SECTIONS.filter((s) => applies(s.when))
    .map((s) => ({ ...s, fields: s.fields.filter((f) => applies(f.when)) }))
    .filter((s) => s.fields.length > 0);
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
    // `time`: the STORED text, raw. What its dropdowns show is [`readTime`]'s normalised reading.
    case "time":
      return typeof v === "string" ? v : v === undefined ? "" : JSON.stringify(v);
    case "number":
      return typeof v === "number" ? String(v) : v === undefined ? "" : JSON.stringify(v);
    case "bool":
      return v === true ? "true" : v === false ? "false" : "";
    case "lines":
      return stringsOf(v).join("\n");
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
    case "tool":
      return toolChoiceOf(getPath(draft, field.path.slice(0, -1)));
  }
}

/**
 * A `time` field as its dropdowns show it (v0.2.1 §3.2): the stored value read the engine's way
 * (`lib/morning-time.ts`), and — when the stored value is not already `HH:MM` — the note that says
 * so, which the form pairs with a "Use HH:MM" button.
 *
 * ⚠ ONLY THE DISPLAY IS NORMALISED. The draft keeps the RAW stored string (`"7:05"`) until the user
 * changes a dropdown or presses the button, so an untouched field leaves `jsonEqual(draft, loaded)`
 * true: it never makes the form dirty, and a save of another field never rewrites it.
 */
export function readTime(draft: Draft, field: Field): { hhmm: string; note: string | null } {
  const stored = getPath(draft, field.path);
  return { hhmm: parseMorningTime(stored).hhmm, note: storedTimeNote(stored) };
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

/** Round 12 (L2): why Other's "Command to run" is not left empty. */
export const EMPTY_COMMAND_REFUSAL = "Not changed: the command to run cannot be empty. Give its name, or its full path.";

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
      if (field.path.join(".") === "provider.cli") {
        // Round 12 (L2): an empty command runs nothing, and the engine's check takes any string, so it is refused
        // here (as a note under Other's command, `settings/pages.ts` `fieldEdited`), never written.
        if (text === "") return EMPTY_COMMAND_REFUSAL;
        const refused = toolSwitchRefusal(draft, text);
        if (refused !== null) return refused;
      }
      if (text === "") return field.required ? (setPath(draft, field.path, ""), null) : empty("");
      if (field.kind === "choice" && field.options && !field.options.includes(text)) {
        return `must be one of: ${field.options.join(", ")}`;
      }
      setPath(draft, field.path, text);
      return null;
    case "time": {
      // The dropdowns and the "Use HH:MM" button write `HH:MM` only; anything else is refused, not
      // written. Empty (no control sends it) removes the key, the engine's default, like `text`.
      if (text === "") return empty("");
      const time = parseMorningTime(text);
      if (time.unparseable || time.hhmm !== text) return "must be HH:MM, e.g. 07:20";
      setPath(draft, field.path, text);
      return null;
    }
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
    case "tool": {
      // P2: Other writes nothing by itself (its command and arguments are TOOL_COMMAND_FIELD's and TOOL_ARGS_FIELD's).
      if (text === "other") return null;
      const preset = TOOL_PRESETS.find((t) => t.id === text);
      if (preset === undefined) return `must be Claude Code, Codex or ${TOOL_OTHER_LABEL}`;
      // A named tool sets its command, its arguments and how the prompt is passed, in place. A command already naming
      // that tool (a path to it) is kept as written.
      const block = field.path.slice(0, -1);
      const cli = getPath(draft, field.path);
      const refused = field.path.join(".") === "provider.cli" ? toolSwitchRefusal(draft, preset.cli) : null;
      if (refused !== null) return refused;
      if (!(typeof cli === "string" && cliName(cli) === preset.cli)) setPath(draft, field.path, preset.cli);
      setPath(draft, [...block, "argv"], [...preset.argv]);
      setPath(draft, [...block, "promptVia"], preset.promptVia);
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

/** Round 9 (M1): Other's two rows, drawn under the Tool choice (`kind: "tool"`) and not in `SECTIONS`. Round 11 (M1): a
 *  value they refuse is never an error — it is a note that blocks nothing (`settings/pages.ts` `fieldEdited`) — so no
 *  Save ever waits on them, and `liveErrors` does not read them. */
export const TOOL_ROW_FIELDS: readonly Field[] = [TOOL_COMMAND_FIELD, TOOL_ARGS_FIELD];

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
    // Own keys through `Object.keys` on both sides, so a `$state` draft's removed key is absent here too (`ownKey`).
    const keys = Object.keys(a);
    const inB = new Set(Object.keys(b));
    return keys.length === inB.size && keys.every((k) => inB.has(k) && jsonEqual(a[k], b[k]));
  }
  return false;
}

/** The text the JSON editor shows for a draft — exactly what a form save would send. */
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
    return { kind: "blocked", message: "Not saved: fix the marked fields first." };
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

/** The edit on screen: the tab, the form's draft and the JSON editor's text. */
export interface Edit {
  tab: "form" | "raw";
  draft: Draft | null;
  raw: string;
}

/** What a landed save's reload draws when the user went on editing while the save was in flight (`afterLanded`). */
export interface KeptEdit {
  doc: ConfigDocument;
  draft: Draft | null;
  raw: string;
}

/**
 * Post-cap (R5-M2, pre-existing on main): the reload after a save that landed (`sent`, sent from the edit `from`),
 * given the edit on screen `now` and the file as read after it (`read`). `null`: the user typed nothing while the save
 * was in flight (as JSON values; opening the editor on the same content is not typing), so the file is drawn as
 * before. Otherwise the document is refreshed and the user's edit kept, showing as unsaved against it:
 *
 * - the JSON editor's text is kept exactly as typed (valid or not) — no longer reachable from the screen, where the editor
 *   is read-only while a save is in flight (final small fix, F2), and kept for any caller that can;
 * - the editor opened while the save was in flight, from the form (`from` on the form): it could not be typed in, so its
 *   text is the form's draft — which is carried onto the text saved as the form's is, and the editor shows the result
 *   (F2: an Add's provider was otherwise dropped by the next Save);
 * - the form's draft is the text SAVED with the user's in-flight changes carried onto it (`rebase`) — for the bar's
 *   Save that is the draft itself; for an Add, Replace or key action, whose candidate is not the draft, the saved
 *   provider change is kept too, so the next Save does not undo it;
 * - ⚠ the document is the file read only when it IS the text this save wrote (as JSON values). Another write landed
 *   in between, it is the text SENT with the base it was sent from, which the file no longer has: the kept edit's
 *   save is then refused as a conflict, exactly as `keptAfterSave` keeps a draft — never rebased onto a file this side
 *   cannot tell from another program's.
 */
export function afterLanded(sent: SentSave, from: Edit, now: Edit, read: ConfigDocument): KeptEdit | null {
  const value = (e: Edit): unknown => (e.tab === "raw" ? (parseDraft(e.raw) ?? e.raw) : e.draft);
  const saved = parseDraft(sent.text);
  if (read.text === null || saved === null || (now.tab === "form" && now.draft === null)) return null;
  if (jsonEqual(value(from), value(now))) return null;
  const fresh = parseDraft(read.text);
  const doc = fresh !== null && jsonEqual(fresh, saved) ? read : { ...read, text: sent.text, base: sent.base };
  if (now.tab === "raw" && from.tab === "raw") return { doc, draft: saved, raw: now.raw };
  const base = value(from);
  const draft = rebase(isObject(base) ? base : {}, now.draft, saved) as Draft;
  return { doc, draft, raw: now.tab === "raw" ? rawFromDraft(draft) : now.raw };
}

/** `mine` (the edit now) carried onto `theirs` (the text saved) from `base` (the edit the save was sent from): where
 *  `mine` still equals `base`, `theirs`; where both are objects, key by key (a key `mine` removed stays removed);
 *  anywhere else, `mine`. Arrays are values. */
function rebase(base: unknown, mine: unknown, theirs: unknown): unknown {
  if (jsonEqual(base, mine)) return theirs;
  if (isObject(base) && isObject(mine) && isObject(theirs)) {
    const out: Draft = {};
    for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine)])) {
      const v = rebase(base[k], mine[k], theirs[k]);
      if (v !== undefined) out[k] = v;
    }
    return out;
  }
  return mine;
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

/* ── P3-M4-T1: "Providers, in order" ───────────────────────────────────────────────────────────── */
//
// The providers editor's model (spec r9 §6 "Settings → Providers, in order"; plan P3-M4-T1). PURE: the IPC is
// `Settings.svelte`'s, the drawing `lib/ProvidersList.svelte`'s. What it does NOT decide, on purpose (the app never
// re-implements an engine decision):
//
//  • the list's MEANING — `lib/provider-list.ts` reads and writes it (compaction, the literal-key pointer block, no
//    rename); every edit here is one of its edits applied to the draft;
//  • a row's STATUS — `status --json`'s `providers` rows (the engine's `rowStatus`, its precedence included). The app
//    joins them to the SAVED list by `index` (gui-seam §1: never by label, which may be masked), and only when the
//    rows match that list one for one; it adds three things of its own on top — an entry the engine dropped reads
//    "invalid" (the engine's row), an entry whose saved `config validate` row says `keyMoved` (PR 2's scrub) reads
//    "key moved — add a key", and an entry the saved config does not hold reads "not saved yet";
//  • whether a list WORKS — the save gate asks `config validate` (through `providerCandidateCheck`) and refuses only
//    the structural `provider.accounts` warning, the one ending "— account failover disabled" (Q4);
//  • a Test's bound — the validate row's `testTimeoutMs`, passed through `testModeFor` unchanged.

export const PROVIDERS_TITLE = "Providers, in order";
export const PROVIDERS_HELP =
  "The briefing is written by the first provider here that works: when one is out of usage, refuses its key or cannot be reached, the next one is tried. Drag a row, or open it and use Move up or Move down, to change the order.";

/** A saved entry whose key PR 2's scrub moved out of `config.json.bak` (its `config validate` row says `keyMoved: true`,
 *  gui-seam §1d). Shown instead of an environment-variable source. The app keeps no copy of the scrub's sentinel: the
 *  engine says which entries carry it (P3-M4-T2 checkpoint). */
export const KEY_MOVED_LINE = "key moved — add a key";
/** The Add form's note beside the key, for an OpenAI-compatible entry (follow-up 4): such an entry may be added with no
 *  key when the engine's row says it needs none (`keyOptional`, `provider-flows.ts` `startAdd`). Static text: nothing
 *  here reads the address. */
export const ADD_LOCAL_KEY_NOTE = "Leave the key empty for a model running on this computer (Ollama, LM Studio, a local vLLM): it needs none.";
/** Test on a command-line entry runs that tool once (spec §6). */
export const CLI_TEST_NOTE = "uses a little of your plan";
/** Added to the `key-unavailable` remedy: a locked Keychain's dialog may still be on screen (plan P3-M4-T1). */
export const KEYCHAIN_DIALOG_REMEDY = "if a Keychain dialog is on screen, unlock it or cancel it";
/** A replacement's pre-save reset waiting on the run lock (spec §6 step 2; P3-M4-T3 sets it on the row). */
export const REPLACE_WAITING_LINE = "a briefing is running — the key will be replaced when it finishes";

/* ── P3-M4-T4: a key written in the settings file ── */

/** Every way an `api` block names its key, in the order they outrank — defined once, in `provider-list.ts`. */
export { KEY_SOURCES, type KeySource };

/** Where `key migrate`'s reference goes — the key store's choice (`src/keyStore.ts`: the Keychain on macOS, a key file
 *  everywhere else), which `key migrate`'s answer confirms (`provider-flows.ts` `migrateLiteral` checks the answer). */
export function migrateSlot(os: Os): "apiKeyCommand" | "apiKeyFile" {
  return os === "macos" ? "apiKeyCommand" : "apiKeyFile";
}

/**
 * The key source of the user's own that a reference moved into `slot` would take the place of or OUTRANK, or `null`
 * (hub 2026-10-18 decision 1; P2-M3-T1 checkpoint (2): migrate keeps every source that outranks the literal and must
 * never change which key is read). That is the slot itself, or any source ranked below it but above the literal
 * (`KEY_SOURCES` order): a key file moved in above a user's `apiKeyCommand` would become the key read. `slot` `null`
 * (platform unknown) counts both slots. Then the literal is read only when those sources fail, and is not moved.
 */
export function migrateBlockedBy(block: Readonly<Record<string, unknown>>, slot: "apiKeyCommand" | "apiKeyFile" | null): KeySource | null {
  const api = block["api"];
  if (!isObject(api)) return null;
  const from = KEY_SOURCES.indexOf(slot ?? "apiKeyFile");
  return KEY_SOURCES.slice(from, -1).find((k) => api[k] !== undefined) ?? null;
}

/** Where the app keeps a key it stores, as the user knows it: the Keychain on macOS, the app's key folder elsewhere
 *  (`src/keyStore.ts`; `keyTimeoutLine` is the precedent). An unknown platform (a mount with no `os`, which offers no
 *  key action) keeps the macOS wording. */
export function keyStoreName(os: Os | undefined): string {
  return os === undefined || os === "macos" ? "Keychain" : "key folder";
}

/** The banner on an entry holding a literal key that can be moved (spec §6 "Move this key to the Keychain"). */
export function literalBanner(os: Os | undefined): string {
  return `This provider's API key is written in the settings file. Move it to the ${keyStoreName(os)}: the app keeps it there, and the settings file keeps only a reference to it. It cannot be tested until then.`;
}
/** The migrate button. */
export function migrateButtonText(os: Os | undefined): string {
  return `Move this key to the ${keyStoreName(os)}`;
}
/** The banner on an entry whose literal is in the DRAFT only (typed in the JSON editor): the save guard refuses a new
 *  or changed literal (P3-M2-T2), and migrate and remove act on the saved settings, so neither is offered. `saved`: the
 *  entry is in the saved list. Replace key is offered on a SAVED entry only (`replaceOffered`), so one not saved yet is
 *  told the two ways that work — save it without the key and then Replace key, or Add a provider (PR 3 final r5, B4). */
export function literalDraftBanner(os: Os | undefined, saved: boolean): string {
  const refused = "This provider has an API key typed into the settings, and Save refuses it: the app never writes a new key into the settings file.";
  if (saved) return `${refused} Remove it with ${EDIT_AS_JSON} (or discard your changes), then give the provider its key with Replace key, which keeps it in the ${keyStoreName(os)}.`;
  return `${refused} The provider is not saved yet, so Replace key is not offered: remove the key with ${EDIT_AS_JSON}, then either save it without the key and give it its key with Replace key, or remove the provider and add it with Add a provider, which takes a pasted key. Either way the key is kept in the ${keyStoreName(os)}.`;
}
/** The banner when a source of the user's own holds the slot a moved key would take (hub 2026-10-18 decision 1). */
export const LITERAL_FALLBACK_BANNER =
  "This provider also has an API key written in the settings file. That key is used only when your own key source fails, so it is not moved: moving it would change which key is used. You can remove the written key; your own key source stays as it is. It cannot be tested until then.";
export const REMOVE_LITERAL_BUTTON = "Remove the key written in settings";
/** The confirmation before the written key is removed (hub 2026-10-18 decision 1). The backup is cleaned by
 *  `key scrub-backup` after the save, which can fail or find another name for the backup (`scrubLines` says which):
 *  so it promises only that the app says so (PR 3 final r4, H5). */
export const REMOVE_LITERAL_CONFIRM =
  "Remove the API key written in the settings file? It is removed from the settings when they are saved, and then from their backup; if the backup cannot be cleaned, or another file still holds the key, the app says so. Your own key source stays as it is.";

/** A key store `timeout` (`reason: "timeout"`, or the app's own bound on `key set` / `key migrate`), per platform
 *  (hub P2-M2 (2)): the engine's answer is the same on both. */
export function keyTimeoutLine(os: Os): string {
  return os === "macos" ? "unlock your keychain, then retry" : "the key folder did not answer in time — retry";
}

/** A Test whose outcome the engine could not record (`recorded: false`), by its `notRecorded` (hub P2-M4 (2)). */
export function notRecordedLine(cause: ProviderTestAnswer["notRecorded"]): string {
  return cause === "write-failed" ? "not saved — the status file could not be written" : "not saved — a briefing was running";
}

/* ── the engine's reasons, in words ── */

/** The engine's reason wording (`FAILOVER_REASONS`, `src/failover.ts`) without its `{until}` / `{status}` slots and
 *  without what follows " — ", which here is the remedy's. `settings.check.ts` pins every entry to the engine's table. */
const REASON_WORDS: Record<string, string> = {
  usage: "out of usage",
  "rate-limited": "rate-limited",
  auth: "key or login rejected",
  "key-unavailable": "key couldn't be read",
  "not-installed": "CLI not installed",
  "not-found": "model or endpoint not found",
  "prompt-too-long": "prompt too long for this model",
  "rejected-request": "request rejected",
  unreachable: "unreachable",
  "empty-answer": "empty answer",
  "unusable-answer": "answer wasn't a usable briefing",
  "cli-failure": "unrecognised CLI failure",
  "insecure-endpoint": "refused to send the key over plain http",
  // A legacy mark with no reason (`src/account.ts`), read as the hour class.
  "earlier-failure": "earlier failures",
};

const REMEDIES: Record<string, string> = {
  usage: "Nothing to do: it is used again once its usage resets.",
  "rate-limited": "The provider asked for fewer requests; it is tried again on the next run.",
  auth: "Check this provider's key or login, then press Test.",
  "key-unavailable": `Check that its key is still stored, then press Test; ${KEYCHAIN_DIALOG_REMEDY}.`,
  "not-installed": "Install the command-line tool, or remove this provider.",
  "not-found": "Check the model name and the address, then press Test.",
  "prompt-too-long": "Choose a model that takes a longer prompt, or lower the prompt budget under Advanced.",
  "rejected-request": "Check this provider's settings, then press Test.",
  unreachable: "Check the network and the address, then press Test.",
  "empty-answer": "Press Test again; if it keeps happening, try another model.",
  "unusable-answer": "Press Test again; if it keeps happening, try another model.",
  "cli-failure": "Run the tool in a terminal to see what it says, then press Test.",
  "insecure-endpoint": "Change the address to an https one.",
  "earlier-failure": "Press Test to see whether it works now.",
};

/** A reason in words. One this app does not know (a newer engine's) is shown as the engine gave it. */
export function reasonWords(reason: string): string {
  return Object.hasOwn(REASON_WORDS, reason) ? REASON_WORDS[reason]! : stripControl(reason);
}

/** The one-line remedy for a reason. */
export function remedyFor(reason: string): string {
  return Object.hasOwn(REMEDIES, reason) ? REMEDIES[reason]! : "Check this provider's settings, then press Test.";
}

/* ── `status --json`'s provider rows ── */

/** The engine's `RowStatus` (`src/providerStatus.ts`), as `status --json` prints it. */
export type RowStatusView =
  | { kind: "invalid"; reason: string }
  | { kind: "out-of-usage"; until: string }
  | { kind: "paused"; until: string; reason: string }
  | { kind: "not-working"; since: string; reason: string }
  | { kind: "working"; at: string }
  | { kind: "key-accepted"; at: string }
  | { kind: "not-tested" };

/** One `status --json` `providers` row (gui-seam §1, PR 1 + PR 2): the fields the editor reads. */
export interface StatusProviderRow {
  index: number;
  /** DISPLAY text, possibly masked. Never used to join a row to an entry. */
  label: string;
  kind: string;
  status: RowStatusView;
  revision?: string;
}

const isStr = (v: unknown): v is string => typeof v === "string";

function parseRowStatus(v: unknown): RowStatusView | null {
  if (!isObject(v) || !isStr(v.kind)) return null;
  switch (v.kind) {
    case "invalid":
      return isStr(v.reason) ? { kind: "invalid", reason: v.reason } : null;
    case "out-of-usage":
      return isStr(v.until) ? { kind: "out-of-usage", until: v.until } : null;
    case "paused":
      return isStr(v.until) && isStr(v.reason) ? { kind: "paused", until: v.until, reason: v.reason } : null;
    case "not-working":
      return isStr(v.since) && isStr(v.reason) ? { kind: "not-working", since: v.since, reason: v.reason } : null;
    case "working":
    case "key-accepted":
      return isStr(v.at) ? { kind: v.kind, at: v.at } : null;
    case "not-tested":
      return { kind: "not-tested" };
    default:
      return null;
  }
}

/** `status --json`'s `providers`, or `null` when it has none (an older engine) or any row is not the shape above —
 *  a list that cannot be read whole is not joined at all. */
export function parseStatusProviders(payload: unknown): StatusProviderRow[] | null {
  if (!isObject(payload) || !Array.isArray(payload.providers)) return null;
  const out: StatusProviderRow[] = [];
  for (const r of payload.providers as unknown[]) {
    if (!isObject(r) || typeof r.index !== "number" || !isStr(r.label) || !isStr(r.kind)) return null;
    const status = parseRowStatus(r.status);
    if (status === null) return null;
    out.push({ index: r.index, label: r.label, kind: r.kind, status, ...(isStr(r.revision) ? { revision: r.revision } : {}) });
  }
  return out;
}

/* ── a row's status line ── */

export interface StatusLine {
  text: string;
  /** One line saying what to do, or `null` when there is nothing to do. */
  remedy: string | null;
  tone: "ok" | "warn" | "bad" | "quiet";
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const pad2 = (n: number): string => String(n).padStart(2, "0");

/** An instant in local time: "09:00" today, "Tue 09:00" within six days, else "12 Oct". */
function whenText(iso: string, now: Date): string {
  const t = new Date(iso);
  if (!Number.isFinite(t.getTime())) return stripControl(iso);
  const hhmm = `${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  if (t.getFullYear() === now.getFullYear() && t.getMonth() === now.getMonth() && t.getDate() === now.getDate()) return hhmm;
  if (Math.abs(t.getTime() - now.getTime()) < 6 * 24 * 60 * 60 * 1000) return `${DAYS[t.getDay()]} ${hhmm}`;
  return `${t.getDate()} ${MONTHS[t.getMonth()]}`;
}

/** The engine's words for an entry dropped for a login folder on a tool that reads none (`src/providerList.ts`, the
 *  `config-dir` drop), which its `invalid` row carries in its reason (the warning). */
export const STRAY_FOLDER_REASON = '"configDir" applies to a Claude CLI entry only';

/** The engine's row status in words (spec §6's list), with its remedy. */
export function statusLine(s: RowStatusView, now: Date): StatusLine {
  switch (s.kind) {
    case "invalid":
      return {
        text: `invalid: ${stripControl(s.reason)}`,
        // Round 9 (L11): a stray login folder has its one-click fix in the opened row (its Login folder field).
        remedy: s.reason.includes(STRAY_FOLDER_REASON) ? "The briefing skips it. Clear its login folder below, or remove it." : `The briefing skips it. Fix it with ${EDIT_AS_JSON}, or remove it.`,
        tone: "bad",
      };
    case "out-of-usage":
      return { text: `out of usage until ${whenText(s.until, now)}`, remedy: remedyFor("usage"), tone: "warn" };
    case "paused":
      return {
        text: `paused until ${whenText(s.until, now)} after ${reasonWords(s.reason)}`,
        // User-directed 2026-10-22 (P-A): Reset is "Try again now".
        remedy: `${remedyFor(s.reason)} ${TRY_AGAIN_LABEL} ends the pause.`,
        tone: "warn",
      };
    case "not-working":
      return { text: `not working since ${whenText(s.since, now)}: ${reasonWords(s.reason)}`, remedy: remedyFor(s.reason), tone: "bad" };
    case "working":
      return { text: "working", remedy: null, tone: "ok" };
    case "key-accepted":
      return { text: "key accepted", remedy: null, tone: "ok" };
    case "not-tested":
      return { text: "not tested", remedy: "Press Test to check it.", tone: "quiet" };
  }
}

/* ── the view ── */

export interface RowAction {
  enabled: boolean;
  /** Why it is disabled, or `null`. */
  why: string | null;
}

export interface ProviderRowView {
  /** The entry's label as written: its identity, passed back in callbacks. Never drawn (see `display`). */
  label: string;
  /** The label as drawn: control characters stripped (spec §4). */
  display: string;
  kindText: string;
  isCli: boolean;
  /** The login folder as written, for a command-line entry. */
  configDir: string | null;
  /** User-directed 2026-10-22 (P5): the login folder field is drawn — on a Claude command-line entry, the only kind the
   *  engine reads one on (`isClaudeCli`, the engine's `claudeShaped`), and on any entry that already holds one (the
   *  engine reports it, so it is never hidden: it can be cleared there). */
  folder: boolean;
  /** Position in the draft's list — the candidate's `--index`, for Test. */
  draftIndex: number;
  /** Position in the SAVED list — `--index` for Reset and Migrate — or `null` for an entry not saved yet. */
  savedIndex: number | null;
  status: StatusLine;
  notes: string[];
  test: RowAction & { text: string };
  /** `null`: not offered (the entry is not saved). */
  reset: RowAction | null;
  /** `null`: no literal key to move — or one that is not moved, because a source of the user's own holds or ranks
   *  below its slot (`migrateBlockedBy`; then `removeLiteral`). `text`: the button, per platform (`migrateButtonText`). */
  migrate: (RowAction & { text: string }) | null;
  /** P3-M4-T4: "Remove the key written in settings" (behind a confirmation), offered instead of `migrate` when the
   *  saved entry's literal sits behind a source of the user's own; `null` otherwise. */
  removeLiteral: RowAction | null;
  /** Remove (the entry, from the draft): disabled while the screen is busy; `null` — not offered — on the row whose
   *  replacement is in progress, whose Save, Test again and Discard are drawn on that row only (PR 3 final r4, H1). */
  remove: RowAction | null;
  /** `literalBanner` / `LITERAL_FALLBACK_BANNER` for an entry holding a literal key, `literalDraftBanner` for one only the
   *  draft holds, else `null`. */
  banner: string | null;
  /** The saved entry's `status --json` row `revision` (non-secret), compared with `key migrate`'s; `null` when the
   *  rows are not joined. */
  revision: string | null;
  /** P-A: what the row is, in plain words (`providerSubline`), after its name. */
  subline: string;
  /** P-A: the compact row's status tag — `status.text`, except an invalid entry's, which is "invalid" there (its
   *  reason, often long, is the opened row's sentence). */
  tag: string;
  /** P-A: the opened row's status sentence (`statusSentence`, or the view's own for a row with no engine status). */
  sentence: { lead: string; rest: string | null; remedy: string | null };
  /** P-A: the saved entry carries a mark (out of usage, or paused): only then is "Try again now" (Reset) drawn. */
  marked: boolean;
  /** P-A: read-only lines for what this row's own settings are, where they are not edited in the row: a backup
   *  command-line tool's tool and account, or — for another login of the first provider — that they are its. */
  facts: string[];
}

export type ProvidersView =
  | {
      readable: true;
      rows: ProviderRowView[];
      dirty: boolean;
      note: string | null;
      /** PR 3 final r4 (H1): a save, an add, a replacement, or a row's Test, Reset or key move is in progress. While it
       *  is, every control that would start another of those is not live — Add and test, Replace and test, Move this
       *  key, Remove the key written in settings, Remove — so none of them silently does nothing. The screen decides it
       *  here, once; `Settings.svelte`'s own refusals read it back (`literalRun`, `replaceOffered`). */
      busy: boolean;
      /** P-A: the footer's Test all (`null`: no rows). */
      testAll: TestAllAction | null;
      /** P-A: the line above the list (`todaysBriefing`), or `null`: none drawn. */
      today: TodayLine | null;
      /** P-A: "on this Mac" or "on this computer" (`hereWords`), for the Add form's local services. */
      here: string;
      /** P-Add: where the app keeps a pasted key, as the user knows it (`keyStoreName`). */
      keyStore: string;
    }
  | { readable: false; message: string };

export interface ProvidersInput {
  draft: Draft;
  /** The config text as loaded (`config_read`), the saved list Reset's index and the status rows refer to. */
  savedText: string | null;
  /** `status --json`'s rows, or `null` while unread or unavailable. */
  rows: StatusProviderRow[] | null;
  /** The SAVED config's (`savedText`'s) `config validate` `providers` rows, or `null` while unread or unavailable —
   *  `keyMoved` there is the only source of "key moved" (gui-seam §1d). Joined to the saved list by `index`. */
  validateRows?: readonly ProviderValidateRow[] | null;
  now: Date;
  /** The label whose Test is running, if any (one at a time: a second is refused `busy`). */
  testing?: string | null;
  /** The label whose Reset is running, if any. */
  resetting?: string | null;
  /** Per label, the lines the last Test or Reset of that row answered. */
  results?: Record<string, readonly string[]>;
  /** Per label, a replacement's state (P3-M4-T3). */
  pending?: Record<string, "replace-waiting">;
  /** P3-M4-T4: the platform, which decides where `key migrate` puts the reference (`migrateSlot`); absent, both slots
   *  count (`migrateBlockedBy`). */
  os?: Os;
  /** The label whose written key is being moved or removed, if any. */
  migrating?: string | null;
  /** A save is in progress (`Settings.svelte`'s `saving`). */
  saving?: boolean;
  /** An add is in progress — running, or waiting for Save, Save anyway, Test again or Discard. */
  adding?: boolean;
  /** The label whose replacement is in progress (running or waiting), if any. */
  replacing?: string | null;
  /** P-A: Test all is running (it holds the engine as one Test does, between its rows' Tests too). */
  testingAll?: boolean;
  /** P-A: the latest page's text (`read_latest_briefing`) and its write time (`status --json` `latestBriefingMtime`),
   *  for the "Today's briefing" line; absent or `null`: no line. */
  latestPage?: string | null;
  latestMtime?: string | null;
}

const UNREADABLE: Record<ReadRefusal, string> = {
  "provider-not-object": '"provider" is not an object',
  "accounts-unreadable": '"provider.accounts" is not a list of labelled logins',
  "provider-label-invalid": '"provider.label" is empty or not text',
  "fallbacks-unreadable": 'an entry of "fallbacks" is not a labelled provider block',
  "duplicate-label": "two providers share a label",
};

function kindText(e: ProviderEntry): string {
  const api = e.block["api"];
  if (isObject(api)) {
    const model = isStr(api.model) ? ` · ${stripControl(api.model)}` : "";
    if (api.kind === "anthropic") return `Anthropic API${model}`;
    if (api.kind === "openai-compatible") return `OpenAI-compatible API${model}`;
    return `API${model}`;
  }
  const cli = e.block["cli"];
  return `Command-line tool${isStr(cli) && cli !== "" ? `: ${stripControl(cli)}` : ""}`;
}

const entryKind = (e: ProviderEntry): string => {
  const api = e.block["api"];
  return isObject(api) ? String(api.kind) : "cli";
};
const holdsLiteral = (e: ProviderEntry): boolean => {
  const api = e.block["api"];
  return isObject(api) && api.apiKey !== undefined;
};

/** Has the list — `provider` (item 1 and its logins) or `fallbacks` — changed from the saved config? */
function listDirty(draft: Draft, saved: Draft | null): boolean {
  if (saved === null) return false;
  return !jsonEqual(draft.provider, saved.provider) || !jsonEqual(draft.fallbacks, saved.fallbacks);
}

const SAVE_FIRST = "Save or discard your changes first: this uses the saved list.";

/**
 * The editor's rows for `input.draft`, with the status of each SAVED entry joined from `status --json`.
 *
 * ⚠ THE JOIN IS BY INDEX, AND ONLY WHEN THE ROWS MATCH THE SAVED LIST ONE FOR ONE (same count, each row at its own
 * index, each of the entry's kind or `invalid`). Under a structurally broken `provider.accounts` the engine runs item 1
 * as one implicit entry and prints ONE row for its logins (gui-seam §1), so the counts differ and nothing is joined —
 * a login is never shown another's status. A draft entry finds its saved entry by LABEL (labels never change here).
 */
export function providersView(input: ProvidersInput): ProvidersView {
  const read = readProviderList(plain(input.draft));
  if (!read.ok) {
    return { readable: false, message: `The list of providers in the settings file could not be read (${UNREADABLE[read.reason]}). Fix it with ${EDIT_AS_JSON}.` };
  }
  const saved = input.savedText === null ? null : parseDraft(input.savedText);
  const savedRead = saved === null ? null : readProviderList(saved);
  const savedEntries = savedRead?.ok === true ? savedRead.entries : null;
  const dirty = listDirty(input.draft, saved);

  let note: string | null = null;
  const joined = new Map<string, { index: number; entry: ProviderEntry; row: StatusProviderRow | null }>();
  if (savedEntries !== null) {
    const rows = input.rows;
    const matches =
      rows !== null &&
      rows.length === savedEntries.length &&
      rows.every((r, i) => r.index === i && (r.kind === "invalid" || r.kind === entryKind(savedEntries[i]!)));
    if (rows !== null && !matches) {
      note = "The status of each provider cannot be shown: the saved list does not match what the engine runs, most likely because two logins share a login folder. Fix that, then save.";
    }
    savedEntries.forEach((entry, index) => joined.set(entry.label, { index, entry, row: matches ? rows![index]! : null }));
  }

  // A row op (Test, Reset, a key move) holds the engine, so the other rows' Test and Reset wait for it; the screen is
  // busy while one runs, or while a save, an add or a replacement is in progress (H1).
  const rowOp = input.testing != null || input.resetting != null || input.migrating != null || input.testingAll === true;
  const busy = rowOp || input.saving === true || input.adding === true || input.replacing != null;

  // P-A: the first provider's other logins share its block (`provider.accounts`, read for a command-line item 1 only).
  const item1 = read.entries[0];
  const provider = input.draft["provider"];
  const accounts = item1 !== undefined && !isObject(item1.block["api"]) && isObject(provider) && Array.isArray(provider["accounts"]) ? provider["accounts"] : [];
  const loginLabels = new Set(accounts.filter(isObject).map((a) => a["label"]).filter(isStr));
  const last = read.entries.length - 1;

  const rows = read.entries.map((e, draftIndex): ProviderRowView => {
    const s = joined.get(e.label);
    const statusKnown = s !== undefined && s.row !== null;
    const edited = s !== undefined && (!jsonEqual(s.entry.block, e.block) || s.entry.configDir !== e.configDir);
    // The engine's answer for the SAVED entry (its `config validate` row); no rows, or no row for it, is not "moved".
    const validateRow = s === undefined ? undefined : input.validateRows?.find((r) => r.index === s.index);
    const keyMoved = validateRow?.keyMoved === true;
    const isCli = !isObject(e.block["api"]);
    let status: StatusLine;
    let sentence: { lead: string; rest: string | null; remedy?: string | null };
    if (s?.row?.status.kind === "invalid") {
      status = statusLine(s.row.status, input.now);
      sentence = statusSentence(s.row.status, input.now, isCli, draftIndex === last, draftIndex === 0);
    } else if (keyMoved) {
      status = { text: KEY_MOVED_LINE, remedy: "Its key was removed from the settings file. Give it a key with Replace key.", tone: "bad" };
      sentence = { lead: "Its key was moved out of the settings file.", rest: null };
    } else if (s === undefined && savedEntries !== null) {
      status = { text: "not saved yet", remedy: "Save to start using it.", tone: "quiet" };
      sentence = { lead: "Not saved yet.", rest: null };
    } else if (s?.row) {
      status = statusLine(s.row.status, input.now);
      sentence = statusSentence(s.row.status, input.now, isCli, draftIndex === last, draftIndex === 0);
    } else {
      status = { text: "status unknown", remedy: null, tone: "quiet" };
      sentence = { lead: "Its status is not known yet.", rest: null };
    }
    // The sentence says what out of usage means for the briefing, which the remedy said (for any row) before.
    if (s?.row?.status.kind === "out-of-usage" && sentence.rest !== null) sentence = { ...sentence, remedy: null };
    else sentence = { ...sentence, remedy: status.remedy };
    const marked = s?.row?.status.kind === "out-of-usage" || s?.row?.status.kind === "paused";
    const shared = draftIndex > 0 && loginLabels.has(e.label);
    const facts = draftIndex === 0 || !isCli ? [] : shared ? [`Tool and Account are shared with ${stripControl(item1!.label)}.`] : cliFacts(e.block);

    const notes: string[] = [];
    if (edited) notes.push("Changed, not saved yet: the status above is for the saved settings.");
    // Round 12 (L4): read by label as OWN keys only — a provider labelled `constructor` or `__proto__` would otherwise
    // read what every object inherits (a function, Object.prototype) and stop the list from drawing.
    if (input.pending !== undefined && ownKey(input.pending, e.label) && input.pending[e.label] === "replace-waiting") notes.push(REPLACE_WAITING_LINE);
    for (const line of input.results !== undefined && ownKey(input.results, e.label) ? (input.results[e.label] ?? []) : []) notes.push(line);

    const literal = holdsLiteral(e);
    const slot = input.os === undefined ? null : migrateSlot(input.os);
    const literalStays = literal && migrateBlockedBy(e.block, slot) !== null;
    // The banner's offer is the SAVED entry's: migrate and remove both act on the saved settings. A literal only the
    // draft holds is one the save guard refuses: neither is offered, and the banner says so (P3-M4 checkpoint).
    const savedLiteral = s !== undefined && holdsLiteral(s.entry);
    const draftOnly = literal && !savedLiteral;
    // A Test runs the DRAFT's entry: an edit the engine has not answered for yet is offered its Test.
    const needsKey = keyMoved && !edited;
    const test: RowAction & { text: string } = {
      text: input.testing === e.label ? "Testing…" : isCli ? `Test — ${CLI_TEST_NOTE}` : "Test",
      enabled: !rowOp && !literal && !needsKey,
      why: draftOnly
        ? "Remove the key typed into the settings first."
        : literalStays
          ? "Remove the key written in settings first."
          : literal
            ? `${migrateButtonText(input.os)} first.`
            : needsKey
              ? "Give it a key with Replace key first."
              : null,
    };
    const savedStays = s !== undefined && savedLiteral && migrateBlockedBy(s.entry.block, slot) !== null;
    // Reset waits for a row op only; Move this key and Remove the key written in settings for anything busy, exactly
    // as `literalRun` refuses them.
    const savedAction = (waitFor: boolean): RowAction =>
      dirty ? { enabled: false, why: SAVE_FIRST } : !statusKnown ? { enabled: false, why: "The saved list cannot be matched to the engine's." } : { enabled: !waitFor, why: null };
    return {
      label: e.label,
      display: stripControl(e.label),
      kindText: kindText(e),
      isCli,
      configDir: e.configDir ?? null,
      folder: isClaudeCli(e.block) || e.configDir !== undefined,
      draftIndex,
      savedIndex: s?.index ?? null,
      status,
      notes,
      test,
      reset: s === undefined ? null : savedAction(rowOp),
      migrate: savedLiteral && !savedStays ? { ...savedAction(busy), text: migrateButtonText(input.os) } : null,
      removeLiteral: savedStays ? savedAction(busy) : null,
      remove: input.replacing === e.label ? null : { enabled: !busy, why: null },
      banner: draftOnly
        ? literalDraftBanner(input.os, s !== undefined)
        : literal || savedLiteral
          ? literalStays || savedStays
            ? LITERAL_FALLBACK_BANNER
            : literalBanner(input.os)
          : null,
      revision: s?.row?.revision ?? null,
      subline: providerSubline(e, input.os, validateRow?.appOwnedKey === true, keyMoved),
      tag: s?.row?.status.kind === "invalid" ? "invalid" : status.text,
      sentence: { lead: sentence.lead, rest: sentence.rest, remedy: sentence.remedy ?? null },
      marked,
      facts,
    };
  });
  const anyCli = rows.some((r) => r.isCli);
  const testAll: TestAllAction | null =
    rows.length === 0
      ? null
      : {
          text: input.testingAll === true ? "Testing all…" : anyCli ? `Test all — ${CLI_TEST_NOTE}` : "Test all",
          enabled: !rowOp && rows.some((r) => r.test.enabled),
          why: rowOp ? "Wait for the test or step in progress to finish." : rows.some((r) => r.test.enabled) ? null : "No provider can be tested now: each row says why.",
        };
  const today = todaysBriefing(input.latestPage ?? null, input.latestMtime ?? null, input.now);
  return { readable: true, rows, dirty, note, busy, testAll, today, here: hereWords(input.os), keyStore: keyStoreName(input.os) };
}

/* ── list edits: each one the list writer's, applied to the draft in place ── */

/** `os`: the store a literal key moves to (`keyStoreName`; `undefined` is macOS's wording, as everywhere). `folder`:
 *  the edit was a login folder typed in (`setLoginFolder`), whose input goes back at once (post-cap, delta LOW-2). */
function blockedText(blocked: readonly Blocked[], os: Os | undefined, folder = false): string {
  const b = blocked[0];
  if (b === undefined) return "Not changed.";
  const name = (label: string) => `"${stripControl(label)}"`;
  switch (b.kind) {
    case "literal-moved":
      return `Not changed: ${name(b.label)} has an API key stored in the settings file, and that key cannot change its place in the list. Move the key to the ${keyStoreName(os)} first.`;
    case "empty":
      return "Not changed: the list needs at least one provider.";
    case "duplicate-label":
      return `Not changed: two providers would both be called ${name(b.label)}.`;
    case "config-dir-on-api":
      return `Not changed: ${name(b.label)} is an API provider with a login folder, which only a command-line login can have.`;
    case "config-dir-on-non-claude":
      return folder
        ? `Not changed: ${name(b.label)} is the first provider, and only a Claude command-line login can use a login folder there. Its login folder is left as it was.`
        : `Not changed: ${name(b.label)} has a login folder, and only a Claude command-line login can use one as the first provider. Clear its login folder first.`;
    case "nested-list":
      return `Not changed: ${name(b.label)} cannot become the first provider while its settings hold a "${b.field}" list of their own.`;
    case "unreadable":
      return `Not changed: the list of providers in the settings file could not be read (${UNREADABLE[b.reason]}).`;
  }
}

function applyEntries(draft: Draft, entries: readonly ProviderEntry[], os: Os | undefined, folder = false): string | null {
  const res = writeProviderList(plain(draft), entries);
  if (!res.ok) return blockedText(res.blocked, os, folder);
  for (const key of ["provider", "fallbacks"]) {
    if (Object.prototype.hasOwnProperty.call(res.config, key)) draft[key] = res.config[key];
    else delete draft[key];
  }
  return null;
}

function withEntries(draft: Draft, edit: (entries: readonly ProviderEntry[]) => ProviderEntry[], os?: Os, folder = false): string | null {
  const read = readProviderList(plain(draft));
  if (!read.ok) return `Not changed: the list of providers in the settings file could not be read (${UNREADABLE[read.reason]}).`;
  let next: ProviderEntry[];
  try {
    next = edit(read.entries);
  } catch (e) {
    return `Not changed: ${describeFailure(e)}`;
  }
  return applyEntries(draft, next, os, folder);
}

/** Move the entry at `from` to `to` (positions in the draft's list). `null` when done; else why not (nothing changed).
 *  `os` names the key store in that "why not" (checkpoint P3-M6). */
export function moveProvider(draft: Draft, from: number, to: number, os?: Os): string | null {
  return withEntries(draft, (entries) => moveEntry(entries, from, to), os);
}

/** Remove the entry labelled `label`. (Deleting the app key it referenced is P3-M4-T2's, after the save.) */
export function removeProvider(draft: Draft, label: string, os?: Os): string | null {
  return withEntries(draft, (entries) => removeEntry(entries, label), os);
}

/** Set a command-line entry's login folder; blank removes it (the tool's own default login). */
export function setLoginFolder(draft: Draft, label: string, dir: string): string | null {
  return withEntries(draft, (entries) => {
    const e = entries.find((x) => x.label === label);
    if (e === undefined) throw new Error("no provider has that name");
    const configDir = dir.trim();
    return setEntrySettings(entries, label, configDir === "" ? { block: { ...e.block } } : { block: { ...e.block }, configDir });
  }, undefined, true);
}

/* ── the save gate ── */

export type SaveGate = { kind: "allow" } | { kind: "refuse"; message: string };

/** The suffix every warning that DISABLES `provider.accounts` ends with (`resolveAccounts`' `off()`, `src/config.ts`,
 *  pinned engine-side in P1-M2-T3). The two advisory warnings — an ambient `CLAUDE_CONFIG_DIR`, a login folder never
 *  logged into — do not end with it, and keep the list saveable (Q4). */
const STRUCTURAL_ACCOUNTS_SUFFIX = "— account failover disabled";

/**
 * The save gate's verdict on the candidate's `config validate` report (`providerCandidateCheck(text, "validate")`):
 * refused only for a STRUCTURAL `provider.accounts` warning. Everything else is the save path's own to answer —
 * errors are refused by `configSave` (and shown in its report), warnings are saved with.
 */
export function saveGate(check: CheckOutcome): SaveGate {
  if (check.kind !== "validated") return { kind: "allow" };
  const structural = check.report.warnings.filter(
    (w) => w.field === "provider.accounts" && w.message.trimEnd().endsWith(STRUCTURAL_ACCOUNTS_SUFFIX),
  );
  if (structural.length === 0) return { kind: "allow" };
  return {
    kind: "refuse",
    message: `Not saved: the list of logins cannot work as written — ${structural.map((w) => w.message).join("; ")}. Fix it, then save.`,
  };
}

/** The gate when the check itself could not answer. Refused — except a candidate that is not JSON or too large, which
 *  the save path refuses itself in its own words. */
export function saveGateFailure(e: unknown): SaveGate {
  const kind = isObject(e) ? e.kind : undefined;
  if (kind === "notJson" || kind === "tooLarge") return { kind: "allow" };
  return { kind: "refuse", message: `Not saved: the settings could not be checked before saving (${describeFailure(e)}). Try again.` };
}

/* ── the judge line ── */

/**
 * `JUDGE_LINE` when saving `sentText` over `savedText` changes `provider` as written — item 1, its settings or its
 * logins, including a compaction that moves a login out of `accounts` — else `null` (spec §6, requirement 10). The
 * audit judge is built from `provider` and its `accounts` alone, so this is the list writer's `judgeChanged` rule
 * applied to the whole save: form edits of item 1's fields count as well as list edits.
 */
export function judgeLineFor(savedText: string | null, sentText: string): string | null {
  const before = savedText === null ? null : parseDraft(savedText);
  const after = parseDraft(sentText);
  if (before === null || after === null) return null;
  return jsonEqual(before.provider, after.provider) ? null : JUDGE_LINE;
}

/* ── the network-check prompt ── */

/** Asked once when a REMOTE entry is added while `networkProbeHosts` is `[]` (spec §6), defaulting to yes. The app
 *  cannot tell a wizard-written `[]` from one the user chose, so any such add asks. Whether the added entry is remote
 *  is the ENGINE's answer — the candidate's `config validate` row `loopback: false` (gui-seam §1d) — never the app's
 *  reading of a URL (plan hub "(BUILD, P3-M4-T1, 2026-10-18) Decided" (1)): a yes on a local-only list would make a
 *  network outage skip a briefing the local model could have produced. */
export const NETWORK_ASK = {
  question:
    "You added a provider while the network check is off. Turn the network check back on, so a briefing waits for the network instead of failing while it comes up?",
  yes: "Turn the network check back on",
  defaultYes: true,
} as const;

/** Is the prompt due for this candidate? `asked`: it was already answered in this app session. `rows`: the
 *  CANDIDATE's `config validate` `providers` rows (`providerCandidateCheck(text, "validate")`), joined to the draft's
 *  list by position (the `--index` numbering, as `testPlan` joins them). Due only when an entry added since the saved
 *  config has a row saying `loopback: false`; with no rows (unknown, or `[]` under a broken `accounts`), or an added
 *  entry with no row (one the engine drops), no row says so and it is not asked. */
export function networkAskNeeded(
  savedText: string | null,
  candidate: Draft | null,
  asked: boolean,
  rows: readonly ProviderValidateRow[] | null = null,
): boolean {
  if (asked || candidate === null) return false;
  const hosts = candidate.networkProbeHosts;
  if (!Array.isArray(hosts) || hosts.length !== 0) return false;
  const before = savedText === null ? null : parseDraft(savedText);
  const savedList = before === null ? null : readProviderList(before);
  const now = readProviderList(plain(candidate));
  if (savedList === null || !savedList.ok || !now.ok) return false;
  const known = new Set(savedList.entries.map((e) => e.label));
  const remote = new Set((rows ?? []).filter((r) => r.loopback === false).map((r) => r.index));
  return now.entries.some((e, index) => !known.has(e.label) && remote.has(index));
}

/** Apply the answer: yes removes `networkProbeHosts`, so the engine's default check applies again. */
export function applyNetworkAnswer(candidate: Draft, yes: boolean): void {
  if (yes) delete candidate.networkProbeHosts;
}

let networkAnswered = false;
/** Has the prompt been answered in this app session? */
export function networkAsked(): boolean {
  return networkAnswered;
}
/** The prompt was answered by a save that landed: it is not asked again in this app session. */
export function markNetworkAsked(): void {
  networkAnswered = true;
}

/* ── Test and Reset, in words ── */

export type TestPlan = { kind: "test"; mode: CheckMode } | { kind: "refuse"; message: string };

/** What a Test of the candidate's entry `index` does after validating the candidate: run with that entry's row (its
 *  `testTimeoutMs` unchanged, `testModeFor`), or say why it cannot. */
export function testPlan(check: CheckOutcome, index: number): TestPlan {
  if (check.kind === "invalid") {
    return { kind: "refuse", message: `Not tested: ${check.errors.map((e) => e.message).join("; ")}` };
  }
  if (check.kind !== "validated") return { kind: "refuse", message: "Not tested: the settings could not be checked." };
  const row = check.report.providers.find((r) => r.index === index);
  if (row !== undefined) return { kind: "test", mode: testModeFor(row) };
  if (!check.report.valid) {
    return { kind: "refuse", message: `Not tested: fix these first — ${check.report.errors.map((e) => e.message).join("; ")}` };
  }
  if (saveGate(check).kind === "refuse") {
    return { kind: "refuse", message: "Not tested: the list of logins cannot work as written. Fix it first." };
  }
  return { kind: "refuse", message: "Not tested: the briefing does not run this provider as it is written. Fix it first." };
}

/** A refusal from a provider verb, in words, by `code` and `reason` (never by parsing `error`, gui-seam §1d). */
function refusalWords(r: ProviderRefusal, verb: string): string {
  switch (r.code) {
    case "lock-held":
      return `Not ${verb}: a briefing is running — try again in a minute.`;
    case "config":
      return r.reason === "timeout"
        ? `Not ${verb}: the settings could not be read in time — retry.`
        : `Not ${verb}: the saved settings could not be used for this — fix any provider marked invalid, then try again.`;
    case "write-failed":
      return `Not ${verb}: the status file could not be written.`;
    case "usage":
      return `Not ${verb}: the engine refused the request.`;
  }
}

/** The first words of a failed Test's line. Settings' AI providers dot reads them (`settings/pages.ts`). */
export const TEST_FAILED_PREFIX = "Test failed:";

/** A Test's answer as lines for its row. */
export function testResultLines(check: CheckOutcome): string[] {
  if (check.kind !== "tested") return ["Not tested: the engine did not answer the test."];
  const a = check.answer;
  if (a.ok !== true) return [refusalWords(a, "tested")];
  const lines = a.passed ? ["Test passed."] : [`${TEST_FAILED_PREFIX} ${reasonWords(a.reason ?? "failed")}.`, remedyFor(a.reason ?? "failed")];
  if (!a.recorded) lines.push(`Its result was ${notRecordedLine(a.notRecorded)}.`);
  return lines;
}

/** A Test that rejected (`CheckError`) — a second Test while one runs is `busy`. */
export function testFailureLine(e: unknown): string {
  return `Not tested: ${describeFailure(e)}`;
}

/** A Reset's answer ("Try again now", user-directed 2026-10-22 P-A), for its row. Reset clears the row's marks, so the
 *  next run tries it again; it runs nothing itself. */
export function resetResultLine(o: EngineOutcome<ProviderResetAnswer | ProviderRefusal>): string {
  const p = o.payload;
  if (p === null) return "Not cleared: the engine did not answer (it stopped before replying).";
  if (p.ok !== true) return refusalWords(p, "cleared");
  return p.cleared ? "Its pauses were cleared: the next run tries it again." : "There was nothing to clear: the next run tries it as usual.";
}

/* ── user-directed 2026-10-22 (P-A): the compact rows, their status sentence, Test all, today's briefing ── */

/** Reset, as the opened row's button says it (P-A). Same behaviour, same enable rules. */
export const TRY_AGAIN_LABEL = "Try again now";

/** Where a model served on this computer runs, in the platform's words (`platform.ts`'s `hereWords`, re-exported). */
export { hereWords };

/** P-Add: the API services the guided Add names. Every preset address is docs/PROVIDERS.md's own (its OpenAI, Ollama
 *  and LM Studio examples; tests-web/settings.check.ts reads them there). `keyless`: a local model the engine runs
 *  without a key (its `keyOptional`, which Add still asks the engine for); its API key field is not drawn. */
export type ApiServiceId = "anthropic" | "openai" | "ollama" | "lmstudio" | "other";
export interface ApiService {
  id: ApiServiceId;
  name: string;
  local: boolean;
  kind: "anthropic" | "openai-compatible";
  /** `null`: no address (Anthropic's own endpoint), or the one the user types ("other"). */
  baseUrl: string | null;
  keyless: boolean;
}
export const API_SERVICES: readonly ApiService[] = [
  { id: "anthropic", name: "Anthropic", local: false, kind: "anthropic", baseUrl: null, keyless: false },
  { id: "openai", name: "OpenAI", local: false, kind: "openai-compatible", baseUrl: "https://api.openai.com/v1", keyless: false },
  { id: "ollama", name: "Ollama", local: true, kind: "openai-compatible", baseUrl: "http://127.0.0.1:11434/v1", keyless: true },
  { id: "lmstudio", name: "LM Studio", local: true, kind: "openai-compatible", baseUrl: "http://127.0.0.1:1234/v1", keyless: true },
  { id: "other", name: "Other OpenAI-compatible service", local: false, kind: "openai-compatible", baseUrl: null, keyless: false },
];
/** A service as the Add form names it: "Ollama on this Mac". */
export function serviceLabel(s: ApiService, os: Os | undefined): string {
  return s.local ? `${s.name} ${hereWords(os)}` : s.name;
}

/** An address's host as a row shows it — never the address itself (it may carry a user name, a path or a query) —
 *  or "on this Mac" for a loopback one. `null` when it does not parse. Display only: whether an entry is local is
 *  the engine's (`loopback`). */
function hostWords(url: string, os: Os | undefined): string | null {
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return null;
  }
  if (host === "localhost" || host === "[::1]" || host === "::1" || /^127\.\d+\.\d+\.\d+$/.test(host)) return hereWords(os);
  return host === "" ? null : stripControl(host);
}

/** Where an API entry's key comes from, in words — the source the engine reads first (`KEY_SOURCES` order). Never the
 *  key or its reference. `appOwned`: the saved entry's `config validate` row says the app stored it. */
function keyWords(api: Record<string, unknown>, os: Os | undefined, appOwned: boolean, keyMoved: boolean): string | null {
  if (keyMoved) return "needs a key";
  const source = KEY_SOURCES.find((k) => api[k] !== undefined);
  if (source === "apiKeyEnv") return "key from an environment variable";
  if (source === "apiKeyFile") return appOwned && os !== "macos" ? `key in the app's ${keyStoreName(os)}` : "key from a file";
  if (source === "apiKeyCommand") return appOwned ? `key in your ${keyStoreName(os)}` : "key from a command";
  if (source === "apiKey") return "key written in the settings file";
  return api["kind"] === "anthropic" ? "no key" : null;
}

/** P-A: what a row is, in plain words, after its name — from the entry's own block. */
export function providerSubline(e: ProviderEntry, os: Os | undefined, appOwned = false, keyMoved = false): string {
  const api = e.block["api"];
  const parts = (xs: (string | null)[]): string => xs.filter((x): x is string => x !== null && x !== "").join(" · ");
  if (isObject(api)) {
    const model = isStr(api.model) && api.model.trim() !== "" ? stripControl(api.model) : null;
    const base = isStr(api.baseUrl) ? api.baseUrl : undefined;
    const key = keyWords(api, os, appOwned, keyMoved);
    if (api.kind === "anthropic") return parts(["Anthropic API", model, base === undefined ? null : hostWords(base, os), key]);
    if (api.kind === "openai-compatible") {
      const service = API_SERVICES.find((s) => s.baseUrl !== null && s.baseUrl === base);
      if (service !== undefined) return parts([serviceLabel(service, os), model, key]);
      return parts(["OpenAI-compatible", model, base === undefined ? null : hostWords(base, os), key]);
    }
    return parts(["API", model, key]);
  }
  const cli = e.block["cli"];
  if (!isStr(cli) || cli.trim() === "") return "Command-line tool";
  const name = cliName(cli);
  // The credential changes what Claude Code bills (P3's help); Codex does not read that variable either way.
  if (name === "claude") return `Claude Code · ${e.block["credential"] === "env-api-key" ? "its API key from your environment" : "your subscription login"}`;
  // Round 9 (L7): how Codex signs in is Codex's own; the app only withholds ANTHROPIC_API_KEY (`src/harden.ts`).
  if (name === "codex") return "Codex · command-line tool";
  return `${stripControl(cli)} · command-line tool`;
}

/** "at 07:24" today, "on Tue at 07:24" within six days, else "on 12 Oct" — a sentence's own spelling of `whenText`. */
function atWhen(iso: string, now: Date): string {
  const w = whenText(iso, now);
  if (/^\d{2}:\d{2}$/.test(w)) return `at ${w}`;
  const m = /^(\w{3}) (\d{2}:\d{2})$/.exec(w);
  return m !== null ? `on ${m[1]} at ${m[2]}` : `on ${w}`;
}

/** Round 9 (L12): a pause's reason as the sentence says it ("Paused until 15:00 after it could not be reached."), not
 *  the tag's bare words ("after unreachable", which mirror the engine's own notice). One this app does not know is
 *  given as the engine gave it. */
const AFTER_REASON: Record<string, string> = {
  usage: "after it ran out of usage",
  "rate-limited": "after it was rate-limited",
  auth: "after its key or login was rejected",
  "key-unavailable": "after its key couldn't be read",
  "not-installed": "after its CLI was not found",
  "not-found": "after its model or endpoint was not found",
  "prompt-too-long": "after the prompt was too long for this model",
  "rejected-request": "after its request was rejected",
  unreachable: "after it could not be reached",
  "empty-answer": "after it gave an empty answer",
  "unusable-answer": "after its answer wasn't a usable briefing",
  "cli-failure": "after an unrecognised CLI failure",
  "insecure-endpoint": "after it refused to send the key over plain http",
  "earlier-failure": "after earlier failures",
};
function afterReason(reason: string): string {
  return Object.hasOwn(AFTER_REASON, reason) ? AFTER_REASON[reason]! : `after ${reasonWords(reason)}`;
}

/** P-A: the opened row's status sentence, from the engine's row status — only what that status says. `isLast`: no
 *  provider follows, so none writes the briefing in its place. Round 11 (L1): `isFirst` — the engine walks the list in
 *  order and passes over a marked entry wherever it stands (`src/core.ts`, `markFilter`), so only for the FIRST provider
 *  does the next one take its place; a backup's mark changes nothing while an earlier provider works, and its sentence
 *  says only that it is skipped. */
export function statusSentence(s: RowStatusView, now: Date, isCli: boolean, isLast: boolean, isFirst: boolean): { lead: string; rest: string | null } {
  const skipped = "It is skipped until then.";
  switch (s.kind) {
    case "invalid":
      return { lead: `Invalid: ${stripControl(s.reason)}.`, rest: null };
    case "out-of-usage":
      return { lead: `Out of usage until ${whenText(s.until, now)}.`, rest: !isFirst ? skipped : isLast ? null : "Until then your briefing is written by the next provider." };
    case "paused":
      return { lead: `Paused until ${whenText(s.until, now)} ${afterReason(s.reason)}.`, rest: !isFirst ? skipped : isLast ? null : "Until then the next provider is tried first." };
    case "not-working":
      return { lead: `Not working since ${whenText(s.since, now)}: ${reasonWords(s.reason)}.`, rest: null };
    case "working":
      return { lead: `Working: wrote a briefing ${atWhen(s.at, now)}.`, rest: null };
    case "key-accepted":
      return { lead: `${isCli ? "Test passed" : "Key accepted"} ${atWhen(s.at, now)}.`, rest: null };
    case "not-tested":
      return { lead: "Not tested yet.", rest: null };
  }
}

/** The note under the list (P-A; P4's FIRST_PROVIDER_NOTE goes): only the first provider's tool, account, model and
 *  address are edited in its row. Moving a row to the top makes its block `provider` (`writeProviderList`). */
export const BACKUP_SETTINGS_NOTE = `Only the first provider's settings are changed here. To change another's tool, account, model or address, move it to the top of the list, or use ${EDIT_AS_JSON}.`;

/** The read-only lines a backup's opened row shows for its command-line settings (P-A: the list writer could take a
 *  fallback's tool, but Other's command and arguments would need their own fields in the row; read-only for now). */
function cliFacts(block: Readonly<Record<string, unknown>>): string[] {
  const cli = block["cli"];
  const choice = toolChoiceOf(block);
  const tool = TOOL_PRESETS.find((t) => t.id === choice)?.label ?? (isStr(cli) && cli !== "" ? stripControl(cli) : "none");
  const credential = isStr(block["credential"]) ? block["credential"] : "subscription";
  const field = SECTIONS.flatMap((s) => s.fields).find((f) => f.id === "provider.credential");
  // Round 9 (L7): "subscription" says what Claude Code bills; for any other tool the app knows only that the key is
  // withheld from it, so it says the tool signs in its own way.
  const account =
    credential === "subscription" && !isClaudeCli(block) ? "The tool's own sign-in" : (field?.optionLabels?.[credential] ?? stripControl(credential));
  return [`Tool: ${tool}`, `Account: ${account}`];
}

/** Round 9 (L15): the help line under row 1's Login folder (the P-A mockup's). */
export const FIRST_FOLDER_HELP = "Only for a second Claude account. Leave empty to use the tool's own login.";

/** P-A footer: "Test all" runs each row's own Test, one after another (`Settings.svelte`), as its Test would. */
export interface TestAllAction {
  text: string;
  enabled: boolean;
  why: string | null;
}

/**
 * Round 9 (H1): Test all's run — each row's own Test (`test`), one after another, holding the engine between them
 * (`hold`, the shell's `testingAll`, so no row's own Test or Reset starts in a gap).
 *
 * ⚠ THE ROWS TO TEST ARE TAKEN FROM `start` — the view as it was when Test all was pressed, its rows' Tests live —
 * BEFORE `hold(true)`. The hold disables every row's Test (`providersView`'s `rowOp`), so a run that read the rows'
 * `test.enabled` after it would pass over every row and test nothing. During the run each row is read again from
 * `current()` for its draft index (a row moved meanwhile is tested at its new place; one removed is passed over), and
 * one whose Test is no longer offered for a reason of its own (its `test.why`, which the hold never sets: a key typed
 * into the settings meanwhile) is passed over too. Answers the labels tested, in order.
 */
export async function testAllInTurn(
  start: ProvidersView,
  current: () => ProvidersView | undefined,
  hold: (on: boolean) => void,
  test: (label: string, draftIndex: number) => Promise<void>,
): Promise<string[]> {
  if (!start.readable || start.testAll === null || !start.testAll.enabled) return [];
  const queue = start.rows.filter((r) => r.test.enabled).map((r) => r.label);
  const tested: string[] = [];
  hold(true);
  try {
    for (const label of queue) {
      const now = current();
      const r = now?.readable === true ? now.rows.find((x) => x.label === label) : undefined;
      if (r === undefined || r.test.why !== null) continue;
      tested.push(label);
      await test(label, r.draftIndex);
    }
  } finally {
    hold(false);
  }
  return tested;
}

/** P-A: today's briefing in one line, from today's page's own notice lines (`src/failover.ts` `noticeLines`): who was
 *  skipped or not tried, and who was used instead. ⚠ Only a page with a skipped or not-tried entry names anyone: the
 *  winner of a walk that skipped nobody is in no line (the page's `provider` is the tool's command or the model, not
 *  the entry's name), so no line is drawn then. `at`: the page's write time (`status --json` `latestBriefingMtime`),
 *  when it is today's. Labels are display text (the engine masks unsafe ones). */
export interface TodayLine {
  skipped: { name: string; why: string }[];
  used: string | null;
  at: string | null;
}
export function todaysBriefing(text: string | null, mtime: string | null, now: Date): TodayLine | null {
  if (text === null) return null;
  if (briefingDate(renderMarkdown(text)) !== localDate(now)) return null;
  const skipped: TodayLine["skipped"] = [];
  let used: string | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.endsWith("\r") ? raw.slice(0, -1) : raw;
    if (!line.startsWith(NOTICE_PREFIX)) continue;
    const body = line.slice(NOTICE_PREFIX.length);
    const skip = /^Skipped "(.+?)": (.+) — used "(.+)"$/.exec(body);
    if (skip !== null) {
      skipped.push({ name: stripControl(skip[1]!), why: stripControl(skip[2]!) });
      used = stripControl(skip[3]!);
      continue;
    }
    const notTried = /^Not tried "(.+?)": (.+)$/.exec(body);
    if (notTried !== null) skipped.push({ name: stripControl(notTried[1]!), why: `not tried (${stripControl(notTried[2]!)})` });
  }
  if (skipped.length === 0) return null;
  const t = mtime === null ? NaN : Date.parse(mtime);
  const at = Number.isFinite(t) && localDate(new Date(t)) === localDate(now) ? whenText(mtime!, now) : null;
  return { skipped, used, at };
}

/** User-directed 2026-10-22 (handover's open bug, measured): `config validate` saves a non-Claude first provider whose
 *  logins carry login folders with only an advisory warning, and the engine then runs that tool once per login with a
 *  meaningless CLAUDE_CONFIG_DIR. So the first provider's command does not change to another tool while any of its
 *  logins has a folder: why not, or `null`. */
export function toolSwitchRefusal(draft: Draft, cli: string): string | null {
  if (cliName(cli) === "claude") return null;
  const provider = draft["provider"];
  const accounts = isObject(provider) ? provider["accounts"] : undefined;
  if (!Array.isArray(accounts)) return null;
  const withFolder = accounts.filter((a) => isObject(a) && isStr(a["configDir"]) && isStr(a["label"])).map((a) => `"${stripControl((a as Record<string, string>)["label"]!)}"`);
  if (withFolder.length === 0) return null;
  return `Not changed: ${withFolder.join(", ")} ${withFolder.length === 1 ? "has" : "have"} a login folder, which only Claude Code reads. Remove those logins, or clear their login folders, first.`;
}
