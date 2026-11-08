// src/calendar/notes.ts — the meeting card's NOTES, lightly cleaned (redesign C, "The shown notes are lightly
// cleaned"; wave-2 plan C-M1-T3). The live details read only: the morning's description cleaning (./clean.ts) is
// unchanged and still runs on everything that reaches the page, the archive or the prompt.
//
// From a RAW description (./ics.ts and the Mac reader's notes, capped at 4 000 scalars by the producer), in
// clean.ts's own order, reusing its rule functions and patterns by export, unchanged:
//   0. NFKC-fold the text (before the HTML strip and again after its entity decoding), as clean.ts's rule 0;
//   1. `<br>` becomes a newline FIRST (Google's feeds carry HTML), then clean.ts's `stripHtml` (tags become spaces,
//      entities decode);
//   2. line breaks become `\n`, clean.ts's `INVISIBLE_RE` (control and invisible format characters) is removed with
//      newlines KEPT, horizontal whitespace collapses within each line, each line is trimmed and a run of blank lines
//      becomes one;
//   3. clean.ts's `cutBoilerplate` (the Zoom, Teams, Meet and Webex dial-in blocks, everything from the first marker);
//   4. links are REMOVED (Join is its own button), with clean.ts's three URL patterns, never written as "<host> link";
//   5. passcodes: a label at a line's end (clean.ts's `LABELS`) is joined to the value on the next line by one space
//      when, and only when, the label rule takes that value — "Passcode:\n99887766" is caught while every other
//      newline stays — then clean.ts's `redactLabelled` and `redactDialStrings` (rule 5, both halves);
//   6. capped at CAL_NOTES_MAX characters at a word boundary (`capAtWord`);
//   7. `redactCredentials`, last (capping first keeps it linear, as in clean.ts).
// Linear: every pattern is clean.ts's (each linear) or bounded per position.
import { redactCredentials, REDACTION } from "../transcripts/credentials";
import {
  BARE_URL_RE, capAtWord, cutBoilerplate, INVISIBLE_RE, LABELS, redactDialStrings, redactLabelled, SCHEME_URL_RE, SPECIAL_URL_RE, stripHtml,
} from "./clean";

/** About 600 characters (C "The shown notes are lightly cleaned", step 6). */
export const CAL_NOTES_MAX = 600;

const BR_RE = /<br\s*\/?>/gi;
/** Every line break read as a newline: CRLF, CR, LF, VT, FF, NEL, and the line and paragraph separators (U+2028,
 *  U+2029, built from their code points: written literally they would end the source line). */
const LINE_BREAKS_RE = new RegExp(`\\r\\n|[\\n\\v\\f\\r\\x85${String.fromCharCode(0x2028, 0x2029)}]`, "g");
/** Horizontal whitespace: every `\s` but the newline. */
const HSPACE_RE = /[^\S\n]+/g;
/** Sentence punctuation after a link, kept when the link goes. */
const TRAIL_RE = /[.,;:!?)\]}'"]+$/;
/** A label (clean.ts's `LABELS`), its optional separator, then a line break (and any blank lines) before its value. */
const LABEL_AT_LINE_END_RE = new RegExp(String.raw`\b(${LABELS})\b(\)?(?: ?[:=#：]| ?[\-–]| is[:：]?| is)?) ?\n+`, "gi");

const removeLink = (m: string): string => TRAIL_RE.exec(m)?.[0] ?? "";

function tidyLines(s: string): string {
  return s.split("\n").map((l) => l.replace(HSPACE_RE, " ").trim()).join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/** Join a label at a line's end to its value on the next line, only when the label rule redacts that value. */
function joinLabelledValues(s: string): string {
  return s.replace(LABEL_AT_LINE_END_RE, (m: string, label: string, sep: string, at: number) => {
    const rest = s.slice(at + m.length);
    const nl = rest.indexOf("\n");
    const probe = `${label}${sep} ${nl === -1 ? rest : rest.slice(0, nl)}`;
    const k = redactLabelled(probe).indexOf(REDACTION);
    return k !== -1 && k <= label.length + sep.length + 2 ? `${label}${sep} ` : m;
  });
}

/** The card's notes from raw text (see the header). Never throws; `""` when nothing is left. */
export function cleanNotes(raw: string): string {
  if (typeof raw !== "string") return "";
  let s = stripHtml(raw.normalize("NFKC").replace(BR_RE, "\n")).normalize("NFKC");
  s = tidyLines(s.replace(LINE_BREAKS_RE, "\n").replace(INVISIBLE_RE, ""));
  s = cutBoilerplate(s);
  s = tidyLines(s.replace(SCHEME_URL_RE, removeLink).replace(SPECIAL_URL_RE, removeLink).replace(BARE_URL_RE, removeLink));
  s = redactDialStrings(redactLabelled(joinLabelledValues(s)));
  s = capAtWord(tidyLines(s), CAL_NOTES_MAX);
  return redactCredentials(s);
}
