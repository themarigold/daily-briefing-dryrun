// PR D round 12 (R12-M2): what row 1's tool controls SHOW after a refused value, measured in a real browser, because
// `tests-web` renders on the server only (no DOM, no events) and cannot run `SettingsForm`'s `showDraft` or the
// shell's `typingInToolRows`. The suite pins their source text (`settings-r12.check.ts`, R12-M2); this probe checks
// what they DO. Run by hand, never by a suite.
//
// Needs: the sample-data preview of the GUI serving the tree under test on 127.0.0.1:<port>, with its `providers-ux`
// state (row 1 is Claude Code with a second login, "home", that has a login folder, so another tool is refused) — the
// preview harness used in this PR's reviews (`preview/serve.sh <trial-root> <port>`; it answers every native call from
// memory and saves only inside the page), Google Chrome (CHROME, else the macOS default path), and `playwright-core`
// (any recent version) where Node finds it: the GUI does not depend on it, so copy this file into a folder whose
// `node_modules` has it, and run the copy there:
//
//     cp tests-web/probes/tool-rows-display.ts <dir-with-node_modules/playwright-core>/ && node <dir>/tool-rows-display.ts 5491
//
// It prints one JSON object (every case, what it saw) and exits 1 if any case failed. The cases:
//   select    — Codex chosen on the Tool and refused: the select shows Claude Code again, with the note.
//   command   — "codex" typed in Other's command and committed (Tab): the input shows "claude" again, with the note.
//   gesture   — R12-M1: "codex" typed in Other's command, then Save clicked (the one gesture): the save lands, and
//               Other is still open on "claude" with the note; the file kept claude. Also records that the press
//               came before the field's `change` (the order the gesture stamp relies on).
//   earlier   — a note born in an earlier gesture (committed with Tab, then another edit), then Save clicked: the note
//               goes with the save, and "Other…" closes over the file's named tool (round 11's rule, kept).
//   typing    — a save that lands while the focus is in Other's command (Save pressed by script, focus left where it
//               was): "Other…" stays chosen (`typingInToolRows`); and with the focus elsewhere it closes.
//   drawnOnly — R12-L1: a note on Other's command, then Advanced's arguments make the Tool a named one: the note goes,
//               and does not come back when Other's rows are drawn again.
//   empty     — R12-L2: Other's command cleared and committed: refused, the input shows the command again.
// A `.ts` file with one plain static import, because every source under tests-web must be `.ts` and load no computed
// module (coexistence.check.ts, M9 round 2 and 3). Node runs it as is (type stripping, Node 22.18 or later).
import * as pw from "playwright-core";

const PORT = process.argv[2];
if (!PORT) {
  console.error("usage: node tool-rows-display.ts <port>");
  process.exit(2);
}
const ORIGIN = `http://127.0.0.1:${PORT}`;
const CHROME = process.env.CHROME || "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const prov = '[data-page="providers"]';
const adv = '[data-page="advanced"]';
const TOOL = `${prov} #f-provider\\.cli`;
const COMMAND = `${prov} #f-provider\\.cli\\.other`;
const NOT_CHANGED = /^Not changed: "home" has a login folder/;

(async () => {
  const browser = await pw.chromium.launch({ executablePath: CHROME, args: ["--disable-gpu"] });
  const page = await (await browser.newContext({ viewport: { width: 900, height: 1000 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const out = {};
  const failed = [];
  const check = (name, ok, seen) => {
    out[name] = { ok, ...seen };
    if (!ok) failed.push(name);
  };

  const entry = async (title) => {
    await page.locator(`nav.sidebar button.entry[title="${title}"]`).click();
    await page.waitForTimeout(300);
  };
  const open = async (title) => {
    await page.goto(`${ORIGIN}/?state=providers-ux`, { waitUntil: "networkidle" });
    await page.waitForSelector("main header h1");
    await page.locator("main > header nav button", { hasText: "Settings" }).click();
    await page.waitForSelector("nav.sidebar button.entry");
    await entry(title);
  };
  const openRow1 = async () => {
    const head = page.locator(`${prov} button.head[aria-controls="prov-row-0"]`);
    if ((await head.getAttribute("aria-expanded")) !== "true") await head.click();
  };
  const value = (sel) => page.evaluate((s) => document.querySelector(s)?.value ?? null, sel);
  const notes = () =>
    page.evaluate(() => [...document.querySelectorAll("p.note.refused")].filter((e) => e.offsetParent !== null).map((e) => e.textContent.trim()));
  const savedCli = () => page.evaluate(() => JSON.parse(window.__preview.configText).provider.cli);
  const base = () => page.evaluate(() => window.__preview.base);
  const pickTool = async (v) => {
    await page.locator(TOOL).focus();
    await page.locator(TOOL).selectOption(v);
    await page.waitForTimeout(200);
  };
  const typeCommand = async (t) => {
    await page.locator(COMMAND).click();
    await page.keyboard.press("Meta+A");
    await page.keyboard.press("Backspace");
    if (t !== "") await page.keyboard.type(t);
  };
  const morning = async () => {
    await entry("General");
    await page.locator('[data-page="general"] select').first().selectOption("08");
    await page.waitForTimeout(200);
    await entry("AI providers");
  };
  const saveButton = () => page.locator(".bar .actions button", { hasText: "Save" });

  /* select */
  await open("AI providers");
  await openRow1();
  await pickTool("codex");
  {
    const seen = { tool: await value(TOOL), notes: await notes() };
    check("select", seen.tool === "claude" && seen.notes.length === 1 && NOT_CHANGED.test(seen.notes[0]), seen);
  }

  /* command */
  await open("AI providers");
  await openRow1();
  await pickTool("other");
  await typeCommand("codex");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(200);
  {
    const seen = { tool: await value(TOOL), command: await value(COMMAND), notes: await notes() };
    check("command", seen.tool === "other" && seen.command === "claude" && seen.notes.length === 1 && NOT_CHANGED.test(seen.notes[0]), seen);
  }

  /* gesture */
  await open("AI providers");
  await morning();
  await openRow1();
  await pickTool("other");
  await typeCommand("codex");
  await page.evaluate((sel) => {
    window.__order = [];
    window.addEventListener("pointerdown", () => window.__order.push("pointerdown"), true);
    document.querySelector(sel).addEventListener("change", () => window.__order.push("change"));
    window.addEventListener("click", () => window.__order.push("click"), true);
  }, COMMAND);
  {
    const b0 = await base();
    await saveButton().click();
    await page.waitForTimeout(1500);
    const seen = {
      order: await page.evaluate(() => window.__order),
      landed: (await base()) > b0,
      savedCli: await savedCli(),
      tool: await value(TOOL),
      command: await value(COMMAND),
      notes: await notes(),
    };
    check(
      "gesture",
      seen.order.join(",") === "pointerdown,change,click" && seen.landed && seen.savedCli === "claude" && seen.tool === "other" && seen.command === "claude" && seen.notes.length === 1 && NOT_CHANGED.test(seen.notes[0]),
      seen,
    );
  }

  /* earlier — a note born in an earlier gesture goes with the save, and Other closes over the named tool */
  await open("AI providers");
  await openRow1();
  await pickTool("other");
  await typeCommand("codex");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(200);
  {
    const before = await notes();
    await morning();
    const b0 = await base();
    await saveButton().click();
    await page.waitForTimeout(1500);
    const seen = { before, landed: (await base()) > b0, tool: await value(TOOL), command: await value(COMMAND), notes: await notes() };
    check("earlier", before.length === 1 && seen.landed && seen.tool === "claude" && seen.command === null && seen.notes.length === 0, seen);
  }

  /* typing */
  for (const focusIn of [true, false]) {
    await open("AI providers");
    await morning();
    await openRow1();
    await pickTool("other");
    if (focusIn) await page.locator(COMMAND).focus();
    else await page.locator("main header h1").click();
    const b0 = await base();
    // Pressed by script: the focus stays where it is (a mouse press would move it to the button).
    await page.evaluate(() => [...document.querySelectorAll(".bar .actions button")].find((b) => b.textContent.trim() === "Save").click());
    await page.waitForTimeout(1500);
    const seen = { focusIn, landed: (await base()) > b0, active: await page.evaluate(() => document.activeElement?.id ?? null), tool: await value(TOOL) };
    check(focusIn ? "typing" : "notTyping", seen.landed && seen.tool === (focusIn ? "other" : "claude"), seen);
  }

  /* drawnOnly */
  await open("Advanced");
  await page.locator(`${adv} #f-provider\\.argv`).fill("-p\n--x");
  await page.locator(`${adv} #f-provider\\.argv`).dispatchEvent("change");
  await entry("AI providers");
  await openRow1();
  await typeCommand("codex");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(200);
  {
    const refused = { tool: await value(TOOL), command: await value(COMMAND), notes: await notes() };
    await entry("Advanced");
    await page.locator(`${adv} #f-provider\\.argv`).fill("-p");
    await page.locator(`${adv} #f-provider\\.argv`).dispatchEvent("change");
    await entry("AI providers");
    const named = { tool: await value(TOOL), notes: await notes() };
    await entry("Advanced");
    await page.locator(`${adv} #f-provider\\.argv`).fill("-p\n--y");
    await page.locator(`${adv} #f-provider\\.argv`).dispatchEvent("change");
    await entry("AI providers");
    const again = { tool: await value(TOOL), command: await value(COMMAND), notes: await notes() };
    check(
      "drawnOnly",
      refused.tool === "other" && refused.command === "claude" && refused.notes.length === 1 && named.tool === "claude" && named.notes.length === 0 && again.tool === "other" && again.notes.length === 0,
      { refused, named, again },
    );
  }

  /* empty */
  await open("AI providers");
  await openRow1();
  await pickTool("other");
  await typeCommand("");
  await page.keyboard.press("Tab");
  await page.waitForTimeout(200);
  {
    const seen = { command: await value(COMMAND), notes: await notes() };
    check("empty", seen.command === "claude" && seen.notes.length === 1 && /^Not changed: the command to run cannot be empty/.test(seen.notes[0]), seen);
  }

  out.pageErrors = errors;
  if (errors.length > 0) failed.push("pageErrors");
  out.failed = failed;
  console.log(JSON.stringify(out, null, 1));
  await browser.close();
  process.exit(failed.length === 0 ? 0 : 1);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
