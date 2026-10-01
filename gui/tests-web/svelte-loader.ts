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
 */
import { plugin } from "bun";
import { compile } from "svelte/compiler";

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
