# Self-audit and evaluation tooling

These tools check the quality of the briefing itself. They run from a source checkout with
[Bun](https://bun.sh) (see [INSTALL](INSTALL.md#from-a-source-checkout)), they are not part of the
installed app or binary, and you do not need them to use daily-briefing. `bun run audit` checks one
briefing against your git history and reports what it got wrong or left out; `bun run eval` replays
fixed test cases through the whole pipeline.

## Self-audit: `bun run audit`

- **Self-audit the briefing:** `bun run scripts/audit.ts [briefing-file] [--no-judge]` (or `bun run audit`) — adversarially evaluates
  the day's briefing so you don't have to eyeball it yourself. Two layers: **deterministic** code checks
  (every cited SHA resolves to a real commit — and, separately, whether it is still reachable from any branch, since a commit on a deleted branch still resolves but a reader following it finds nothing; how many of *today's* commits the briefing missed; repos
  with uncommitted work it never named) plus an **LLM judge** (your `claude` CLI) fed the briefing + an
  independent git ground-truth, asked to attack it from multiple angles (grounding, completeness, ranked
  improvements). Optionally add a second-tool comparison with **`--popup=<dir>`** (author-only; off by
  default). Reads today's `briefing-latest.md`
  (generates it if missing), prints a report + a ready-to-paste `EVAL.md` row, and saves a dated
  `audit-YYYY-MM-DD.md`. Costs one extra `claude` call (~25s) — pass **`--no-judge`** to run only the
  fast deterministic checks with no LLM call. Pass a **briefing-file path** to audit a saved/specific
  briefing (it anchors same-day checks to that briefing's own date). It fills the objective columns; the
  subjective (a)/(b) retention marks stay yours.

The judge's own command-line arguments can be set apart from the briefing's with
[`auditJudgeArgv`](CONFIG.md#auditjudgeargv).

## Gold-case evaluation: `bun run eval`

`bun run eval` replays the gold cases in `src/eval/` through the real pipeline with your configured
provider, several times each, and reports pass or fail per case. It calls the provider for real and can
take minutes per case, so it is never part of `bun test`. `--case <name>` runs one case.

## `EVAL.md`

`EVAL.md` is where you keep a running log of results for your own briefings, one row per day. The LLM
judge is deliberately non-gating: treat its verdict as an input to a row, never an authority over one.
