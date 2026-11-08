// src/shellWords.ts — the ONE shell-word tokenizer for "does this argv name X?" checks (PR 1 final review round 1,
// L5). `isAppOwnedKey` (src/providerList.ts, `namesAppService`) and the test spawn guard (test/fixtures/spawn-guard.ts)
// both judge an argv by its WORDS, and they had drifted (one split on `$`, the other did not), so the same command
// could be app-owned to one and not the other.
//
// Every element has its backslash-newlines (line continuations) removed and its other backslashes stripped (a shell's
// `daily\-briefing…` is the same word), and is split on
// whitespace, quotes, `=` and shell punctuation (`; | & ( ) < > { }`, backtick and `$`), so a shell wrapper
// (`sh -c "… <word>; true"`), `--flag=<word>`, a command substitution and a variable suffix (`<word>$1`) are all seen.
// ⚠ UNDECIDABLE, stated: a word BUILT inside the child — a variable's value, quote concatenation, a glob — is not.

/** The shell words of one argv element (empty words dropped). PURE. */
export function shellWords(element: string): string[] {
  // A backslash-newline is a shell LINE CONTINUATION (round 3 L2): removed whole first, so `svc-\<newline>name` is one
  // word, as the shell reads it; every other backslash is then stripped.
  return element.replace(/\\\n/g, "").replace(/\\/g, "").split(/[\s"'=;|&()<>{}`$]+/).filter((w) => w !== "");
}
