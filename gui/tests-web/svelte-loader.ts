/**
 * A Bun runtime plugin that lets `bun test` import `.svelte` files — OFFLINE, with nothing but what
 * `gui/package.json` already installs.
 *
 * Each component is compiled by the project's own `svelte/compiler` for the SERVER target, and the
 * tests render it with `svelte/server`'s `render()` (Svelte 5). That is the same compiler the Vite
 * build uses, so what is asserted is the markup the shipped components produce — minus the
 * browser, which is exactly the part the assertions do not need: which text is shown, which class
 * a badge gets, whether an engine string stays text.
 *
 * ⚠ WHY THE TEST FILES ARE NAMED `*.check.ts`. `bun test` run from `daily_briefing_application/`
 * (the ENGINE suite, 1930 tests) discovers every `*.test.ts` below it — `gui/` included — and has
 * no reason to load this plugin. A `.check.ts` name is invisible to that discovery; `bun run test`
 * here passes `./tests-web/*.check.ts`, which the script's shell expands into `./`-prefixed paths
 * (and a `./`-prefixed path runs whatever its name) — so a new check file is picked up without
 * being listed anywhere (review round 2: the list used to be spelled out, and a new file was
 * silently skipped).
 *
 * `runes: true` matches `svelte.config.js`. A compiler warning fails loudly: a component that
 * compiles with a warning here compiles with the same warning in the build.
 *
 * ⚠ AND IT ARMS THE ENGINE'S SCHEDULER REFUSAL (M9 round 3; spec 3.1.3, "The GUI test runner").
 * The engine's default exec (`src/schedule/install.ts` `defaultExec`) refuses every scheduler change
 * whenever `process.env.DBA_TEST_UNIT_DIR` is set, and the engine's preload arms it for every engine
 * test process (`test/fixtures/isolate-state.ts`). This runner reads no `bunfig.toml`, so until now
 * nothing armed it here, and the import pin in `coexistence.check.ts` was the only guard — a static one,
 * with gaps each review found another of. So this preload arms it too, the same way: a fresh scratch
 * directory, set UNCONDITIONALLY (an inherited value is never trusted — the engine fixture's own
 * lesson), as an accessor that can be neither removed nor pointed elsewhere for the life of the
 * process. Engine code that reaches this process by ANY route then cannot change a registration.
 * `coexistence.check.ts` asserts all of it. The backstop covers THIS process, and a child handed an env
 * that carries the value (`{ ...process.env, … }`); a child spawned with NO env gets bun's startup
 * environment, without it (measured, bun 1.3.14; `test/fixtures/isolate-state.ts` says the same of the
 * engine's). That suite's sandbox builds its own env, with its own value. Like the engine fixture's
 * baselines, the directory is not removed afterwards (`process` "exit" handlers never fire under
 * `bun test`, `test/preload.ts`): one empty temp directory per run.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plugin } from "bun";
import { compile } from "svelte/compiler";

const UNITS = mkdtempSync(join(tmpdir(), "dba-gui-isolated-units-"));
Object.defineProperty(process.env, "DBA_TEST_UNIT_DIR", {
  enumerable: true,
  configurable: false,
  get: (): string => UNITS,
  set(v: unknown) {
    throw new Error(
      `DBA_TEST_UNIT_DIR is armed by tests-web/svelte-loader.ts for the whole GUI test process (${UNITS}) ` +
        `and is never reassigned; got ${JSON.stringify(v)}`,
    );
  },
});

plugin({
  name: "svelte-ssr",
  setup(build) {
    build.onLoad({ filter: /\.svelte$/ }, async ({ path }) => {
      const source = await Bun.file(path).text();
      const { js, warnings } = compile(source, {
        filename: path,
        generate: "server",
        runes: true,
      });
      if (warnings.length > 0) {
        throw new Error(
          `${path} compiled with warnings:\n${warnings.map((w) => `${w.code}: ${w.message}`).join("\n")}`,
        );
      }
      return { contents: js.code, loader: "js" };
    });
  },
});
