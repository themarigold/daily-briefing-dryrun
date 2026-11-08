import { bareToken, evidenceTokens, isShaShaped } from "../sha";
import { redactCredentials } from "../transcripts/credentials";
import type { SummaryCard } from "./cards";
import { isRefusedCharacter } from "./refused-chars";

export interface SummaryProject { key: string; points: string[] }
export type SummaryTextWarning = "summary-text-omitted";
export interface ValidatedSummary {
  projects: SummaryProject[];
  goodMorningSentence: string | null;
  warnings: SummaryTextWarning[];
}

// Kept verbatim from A2's portable formatting predicates. No stateful flags.
const FORMATTING = [
  /\*\*[^\s*]([^*]*[^\s*])?\*\*/u,
  /__[^\s_]([^_]*[^\s_])?__/u,
  /\*[^\s*]([^*]*[^\s*])?\*/u,
  /^#+ /u,
  /^([-*] |[0-9]+\. )/u,
  /\[[^\]]*\]\([^)]*\)/u,
  /`/u,
];
const CITATION = /^[^\s:]*[A-Za-z0-9_-]\.[A-Za-z0-9]+:[1-9][0-9]*[,.;:)]*$/u;
const SCHEME = /(^|[^A-Za-z0-9])[A-Za-z][A-Za-z0-9+.-]*:\S/u;
const WWW = /(^|[^A-Za-z0-9])www\.\S/iu;
const WEB_EXTENSIONS = new Set(["com", "org", "net", "io", "dev", "co", "ai", "edu", "gov"]);
const BRANCH = /^(?:(?:[-*•◦▪]|\[[^\]]*\])\s*)*(On branch |Detached HEAD at )/u;

/** Iterated by code point, a pair reads as one scalar, so only an unpaired surrogate lands in this range. */
function isUnpairedSurrogate(c: string): boolean {
  const cp = c.codePointAt(0)!;
  return cp >= 0xd800 && cp <= 0xdfff;
}

/** Structural plain-text safety and a credential-shape check; this does not assert semantic fidelity. */
export function validateSummaryText(value: string, maxScalars: number): string | null {
  // Check before trim too: it must not hide a trailing newline, control or BOM.
  for (const c of value) {
    const cp = c.codePointAt(0)!;
    if (isRefusedCharacter(c) || cp === 0x2028 || cp === 0x2029 || isUnpairedSurrogate(c)) return null;
  }
  const s = value.trim();
  const count = [...s].length;
  if (count < 1 || count > maxScalars || /[<>]/u.test(s) || FORMATTING.some((re) => re.test(s)) || BRANCH.test(s)) return null;
  for (const token of s.split(/\s+/u)) {
    // A file citation exempts only the scheme rule; www is always checked.
    if (WWW.test(token)) return null;
    const extension = /\.([A-Za-z0-9]+):/u.exec(token)?.[1]?.toLowerCase();
    const citation = CITATION.test(token) && extension !== undefined && !WEB_EXTENSIONS.has(extension);
    if (!citation && SCHEME.test(token)) return null;
  }
  if (evidenceTokens(s).some((token) => isShaShaped(bareToken(token)))) return null;
  // Engine only: Rust's stored-text check stays structural (plan R2-O4), so the shared vectors do not hold this rule.
  if (redactCredentials(s) !== s) return null;
  return s;
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Parse the bounded response, retaining only exact allowed keys and safe text. */
export function validateSummary(raw: string, allowedCards: readonly SummaryCard[]): ValidatedSummary | null {
  if (Buffer.byteLength(raw, "utf8") > 64 * 1024) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!object(value) || Object.keys(value).length !== 2 || !Object.hasOwn(value, "projects") || !Object.hasOwn(value, "goodMorningSentence")) return null;
  if (!Array.isArray(value.projects) || value.projects.length > 64 || (value.goodMorningSentence !== null && typeof value.goodMorningSentence !== "string")) return null;

  const allowed = new Map(allowedCards.map((card) => [card.key, card]));
  const entries = new Map<string, string[]>();
  const seen = new Set<string>();
  let omitted = false;
  for (const entry of value.projects) {
    if (!object(entry) || Object.keys(entry).length !== 2 || !Object.hasOwn(entry, "key") || !Object.hasOwn(entry, "points") || typeof entry.key !== "string" || !Array.isArray(entry.points) || !entry.points.every((point) => typeof point === "string")) return null;
    if (seen.has(entry.key)) {
      entries.delete(entry.key);
      omitted = true;
      continue;
    }
    seen.add(entry.key);
    // An unpaired surrogate has no UTF-8 form and Rust's decode refuses it, so no card key may hold one.
    if (!allowed.has(entry.key) || [...entry.key].some(isUnpairedSurrogate) || entry.points.length < 1 || entry.points.length > 3) {
      omitted = true;
      continue;
    }
    const points = entry.points.flatMap((point: string) => {
      const accepted = validateSummaryText(point, 90);
      if (accepted === null) { omitted = true; return []; }
      return [accepted];
    });
    if (points.length > 0) entries.set(entry.key, points);
  }
  const goodMorningSentence = value.goodMorningSentence === null ? null : validateSummaryText(value.goodMorningSentence, 240);
  if (value.goodMorningSentence !== null && goodMorningSentence === null) omitted = true;
  return {
    projects: [...entries].map(([key, points]) => ({ key, points })),
    goodMorningSentence,
    warnings: omitted ? ["summary-text-omitted"] : [],
  };
}
