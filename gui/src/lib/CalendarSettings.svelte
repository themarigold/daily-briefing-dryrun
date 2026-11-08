<script lang="ts">
  /**
   * v0.3.0 (calendar connection, plan M9; spec r4 §8) — Settings → Calendar, and the controls the
   * wizard's optional calendar step reuses (`mode="wizard"`). The decisions are `./calendar-settings`'s;
   * this component draws them and makes the calls.
   *
   * ⚠ THE PASTE FIELD IS NEVER BOUND TO STATE. The link's URL is a secret (spec §2): the field is a
   * `type="password"` input held only by an element reference, and "Add link" READS AND CLEARS it in
   * one step (`takeUrl`) before the write call even starts. So the URL is never in component state,
   * never re-displayed (a failed write clears the field too — paste again), never logged and never in
   * a message; `tests-web/calendar.check.ts` pins this source for it.
   *
   * ⚠ EVERY WRITE GOES THROUGH RUST, IN THE M8 ORDER: `calendar_link_write` (the private file), then
   * `calendar_config_save` with the link's entry, then `calendar list` for the address the URL names —
   * which is SHOWN, and stored as `confirmedOwner` only when the user says it is theirs
   * (`confirmOwner` re-reads the list first). A link with no address in its URL asks for "Your email
   * address on this calendar"; so does "No, it belongs to someone else", and the `owner` that field
   * saves — an address other than the URL's — is the answer that stops the question (`ownerPrompt`).
   * Every block edit reads the config as it is now.
   *
   * ⚠ THE MAC CALENDAR APP SECTION follows `MAC_CALENDAR_AVAILABLE` (hub decision, plan p4 §3): off in PR 1,
   * ON since W3 (PR 2) shipped the Calendar Reader, and drawn on macOS only. `macAvailable` exists so a test
   * can render the other state; the app never passes it.
   *
   * Redesign D, option A (user-directed 2026-10-22) — IN SETTINGS the panel is the S-A mockup's "Sources" group: flat
   * rows edge to edge across the page's Tile (the switch, the config's warnings and the read errors, the Mac Calendar
   * app, one row per link, the test's error and the leftover), then
   * a footer row with "Test now" and the primary "Add a calendar link…". Each source's row is a header button (its name
   * and a status tag, `macSourceTag` / `linkSourceTag`) that opens its details in place: everything the source's box
   * held before, drawn flat. A row that needs the user opens by itself; the user's own choice is kept while the page is
   * open (`nextOpenRows`); a row that opens by itself never moves the focus (only a click does: a row's own action,
   * `act`, and round 9's "Add a connection…" and its picker, `focusFirst`). ⚠ THE WIZARD'S MODE IS UNCHANGED: its branch below draws the
   * markup it drew at 5b6fa8cc2, sharing only the snippets whose output is identical in both modes, and every new style
   * rule is scoped to `.panel` (Settings mode) or to a class only Settings draws (`tests-web/calendar.check.ts` holds
   * the wizard's render, state by state, to the one at 5b6fa8cc2).
   *
   * Every dynamic string is `{}`-interpolated text.
   */
  import { onMount, tick, untrack } from "svelte";
  import { calendarConfigSave, calendarLinkRemove, calendarLinkWrite } from "./calendar";
  import Switch from "./Switch.svelte";
  import Tile from "./ui/Tile.svelte";
  import type {
    CalendarLastRead,
    CalendarLinkInfo,
    CalendarListJson,
    CalendarMacosCalendar,
    CalendarSourceKind,
    CalendarSourceNotice,
    CalendarStatusJson,
    CalendarTestJson,
    CalendarTestSource,
  } from "./calendar-contract";
  import {
    addLink,
    calendarBlockOf,
    calendarOn,
    calendarReadOn,
    calendarStatusOk,
    configWarningLines,
    confirmOwner,
    confirmQuestion,
    editBlock,
    fileProblem,
    lastReadLine,
    LINK_SECRET_NOTE,
    linkIds,
    linkSourceTag,
    MAC_CALENDAR_AVAILABLE,
    connectMacMessage,
    MAC_DIALOG_NOTE,
    MAC_OUTDATED_NOTE,
    macSectionShown,
    macSourceTag,
    macStatusLine,
    needsAddress,
    nextOpenRows,
    isSet,
    keyed,
    withRowOpen,
    notesText,
    offSourceNote,
    overlapHints,
    overlapLine,
    OWNER_FIELD_HELP,
    OWNER_FIELD_LABEL,
    ownerPrompt,
    PROVIDERS,
    readList,
    readStatus,
    readTest,
    shownSourceTag,
    sourceKey,
    startAddingFocusTarget,
    startAddingStep,
    linkPanelState,
    type LinkPanelState,
    suggestId,
    testLine,
    urlFromLine,
    withEnabled,
    withMacCalendars,
    withMacos,
    withOwner,
    connectionChoices,
    connectionsHelp,
    connectionsLabel,
    linkRowAction,
    linkRowLine,
    macRow,
    macRowAction,
    LIVE_READ_LINE,
    MASTER_LINE,
    MASTER_TITLE,
    testsAfterAnswer,
    testsAfterWrite,
    type RowAction,
    type AddLinkResult,
    type CalendarBlock,
    type CalendarDeps,
    type EditResult,
    type OpenRows,
    type ProviderSteps,
    type SourceTag,
  } from "./calendar-settings";
  import { localDateOf } from "./briefing-struct";
  import { calendarConnectMac, calendarList, calendarStatus, calendarTest } from "./engine";
  import { EDIT_AS_JSON, configRead, describeFailure, type FieldNote } from "./files";
  import type { Os } from "./platform";
  import { connectWrote, readStatusThroughStore, storeLinkRemove, storeSaveBlock, storeWrite } from "./today-store";
  // PB-M6-T1: the Settings lock's busy line follows the store's running flow.
  import { onTodayStore, todayStore } from "./today-store";
  import { calendarBusyLine } from "./calendar-question";

  interface Props {
    /** The OS this window runs on — the Mac section needs macOS (and the switch). REQUIRED. */
    os: Os;
    /** `settings`: the panel with its heading and the on/off switch. `wizard`: the link controls only,
     *  inside the wizard's optional step. */
    mode?: "settings" | "wizard";
    /** TEST ONLY — the app always leaves it at `MAC_CALENDAR_AVAILABLE`, the one switch W3 flips. */
    macAvailable?: boolean;
    /** After any write that changed `config.json`, so Settings can reload a form that holds no edit. */
    onconfigchanged?: () => void;
    /** Redesign D: after every status read, whether the sources are ok (`calendarStatusOk`), for Settings'
     *  attention dot on the Calendar page. The wizard passes none. */
    onstatus?: ((ok: boolean) => void) | undefined;
    /** TEST ONLY — start from this snapshot instead of "Reading…" (a server render runs no `onMount`).
     *  `configText` is the config file's text, `null` for no file; `test` (round 9), a "Test now" answer as if it had
     *  run on this mount. The app never passes it. */
    initial?: { configText: string | null; list: CalendarListJson | null; status: CalendarStatusJson | null; test?: CalendarTestJson | null };
    /** PB-M6 (wave-2 polish spec §4 "Link"): the calendar question's link session embeds this panel — no Mac section
     *  (`showMac` false), so a Mac that cannot read the Calendar app never sees its checkbox. */
    linkOnly?: boolean;
    /** PB-M6: open the add flow once the panel has loaded (once only), then focus its chosen provider control. */
    startAdding?: boolean;
    /** PB-M6: the add flow closed ("Done" or "Cancel"), with whether a link file is left over (`leftover`). */
    onaddclosed?: ((closed: { leftover: boolean }) => void) | undefined;
    /** PB-M6: `remove()` cleared the leftover link file. */
    onleftovercleared?: (() => void) | undefined;
    /** PB-M6 (spec §4 "Flows"): a calendar-question flow is running — every control that writes waits (`busy`), and the
     *  busy line shows (Settings mode only). Settings → Calendar passes it from the store; an embedded panel never. */
    locked?: boolean;
    /** PB final LOW L1/L2: the link session's card follows this panel's own write and its "Remove that saved link"
     *  offer (`linkPanelState`), so its way out waits for the one and never strands the other. Only the card passes it. */
    onpanelstate?: ((state: LinkPanelState) => void) | undefined;
  }
  let {
    os,
    mode = "settings",
    macAvailable = MAC_CALENDAR_AVAILABLE,
    onconfigchanged = () => {},
    onstatus,
    initial,
    linkOnly = false,
    startAdding = false,
    onaddclosed,
    onleftovercleared,
    locked = false,
    onpanelstate,
  }: Props = $props();
  const seed = untrack(() => initial);

  const showMac = $derived(!linkOnly && macSectionShown(os, macAvailable));
  // PB-M3 (spec §5): every calendar write is bracketed by the Today store (a status read across it is dropped), and an
  // accepted block save patches the store's enabled/enabledSet from the block it wrote.
  const deps: CalendarDeps = {
    writeLink: (id, url) => storeWrite(() => calendarLinkWrite(id, url), () => true),
    readConfig: configRead,
    saveBlock: storeSaveBlock(calendarConfigSave),
    list: () => calendarList(),
  };
  /** A link removal through the store: once it resolves it wrote (Rust deletes the file before its config step). */
  const removeLink = storeLinkRemove(calendarLinkRemove);

  let loaded = $state(seed !== undefined);
  let configExists = $state<boolean | null>(seed === undefined ? null : seed.configText !== null);
  let configError = $state<string | null>(null);
  let block = $state<CalendarBlock | null>(seed === undefined ? null : calendarBlockOf(seed.configText));
  let list = $state<CalendarListJson | null>(seed?.list ?? null);
  let listError = $state<string | null>(null);
  let status = $state<CalendarStatusJson | null>(seed?.status ?? null);
  let statusError = $state<string | null>(null);

  let tests = $state<Record<string, CalendarTestSource>>(
    seed?.test == null ? {} : Object.fromEntries(seed.test.sources.map((s) => [sourceKey(s.kind, s.id), s])),
  );
  /** Round 11 (M2): per source, how many landed writes changed it (`testsAfterWrite`), so a Test still running when one
   *  lands cannot bring back the answer it dropped (`testsAfterAnswer`). */
  let testGens = $state.raw<Record<string, number>>({});
  let testedAt = $state<string | null>(seed?.test?.ranAt ?? null);
  let testing = $state(false);
  let testError = $state<string | null>(null);

  /** This panel's own write in flight (PB-M6: was `busy`). */
  let working = $state(false);
  /** Every button that writes waits: this panel's own write, or a calendar-question flow (`locked`; spec §4 "Flows"). The
   *  shared snippets read this, so they are unchanged. */
  const busy = $derived(working || locked);
  /** PB-M6: the running flow's phase, for Settings' busy line — read now (a server render runs no `onMount`), then
   *  followed by the subscription below the first mount. */
  let flowPhase = $state(todayStore().flow.running?.phase);
  const busyLine = $derived(calendarBusyLine(flowPhase));
  let message = $state<{ bad: boolean; text: string } | null>(null);
  let warnings = $state<FieldNote[]>([]);
  let confirmRemove = $state<string | null>(null);
  /** Typed addresses for links that need one, by link id. Addresses, never URLs. */
  let ownerDrafts = $state<Record<string, string>>({});
  /** Rows whose confirmation was answered "No, it belongs to someone else": they show the address
   *  field, whose save (`owner`) is what stops the question being asked again (`ownerPrompt`). */
  let declined = $state<Record<string, boolean>>({});

  /* The add panel. ⚠ No URL in any of these — the paste field is read through `urlField` only. */
  let adding = $state(false);
  let provider = $state<ProviderSteps["id"]>("google");
  let linkName = $state("");
  let linkId = $state("");
  let idTouched = $state(false);
  let urlField = $state<HTMLInputElement | undefined>(undefined);
  let added = $state<AddLinkResult | null>(null);
  let addStage = $state<"confirm" | "ask" | "done">("done");
  let addOwner = $state("");
  /** A link file written whose config entry was not: offered for removal. */
  let leftover = $state<string | null>(null);

  /** Mac checklist edits not yet saved, by calendar id. */
  let macChoice = $state<Record<string, boolean>>({});

  const ids = $derived(list !== null ? list.links.map((l) => l.id) : block !== null ? linkIds(block) : []);
  const newId = $derived(idTouched ? linkId : suggestId(linkName, ids));
  const existing = $derived(list?.links.find((l) => l.id === newId) ?? null);
  const steps = $derived(PROVIDERS.find((p) => p.id === provider) ?? PROVIDERS[0]!);
  const macOn = $derived(block !== null && typeof block["macos"] === "object" && block["macos"] !== null);
  /** The local date "Last scheduled read" is worded against. STATE, not `$derived` — `Date.now()` is
   *  no reactive dependency, so a derived value never changed (M9 checkpoint): it is set again on every
   *  refresh and on a minute tick, so a window left open across midnight words yesterday's read as
   *  yesterday's. */
  let today = $state(localDateOf(Date.now()));

  /** Read the paste field AND CLEAR IT, in one step (the header). */
  function takeUrl(): string {
    const field = urlField;
    if (field == null) return "";
    const value = field.value;
    field.value = "";
    return value;
  }

  /** PB final R1: refresh's call number. Settings → Calendar can mount while a flow runs, so its mount refresh reads the
   *  pre-flow config; CalendarPage's post-flow refresh must not be overtaken by that older reply. Only the newest
   *  call writes its results. */
  let refreshCalls = 0;

  export async function refresh(): Promise<void> {
    const call = ++refreshCalls;
    const [doc, listed, read] = await Promise.all([
      configRead().then(
        (d) => ({ doc: d, error: null }),
        (e: unknown) => ({ doc: null, error: describeFailure(e) }),
      ),
      readList(deps.list, describeFailure),
      // Through the store (applied there when it may be); this panel still shows its own reply and error.
      readStatus(() => readStatusThroughStore(() => calendarStatus()).then((r) => { if (r.outcome === null) throw r.error; return r.outcome; }), describeFailure),
    ]);
    if (call !== refreshCalls) return;
    configExists = doc.doc === null ? null : doc.doc.exists;
    configError = doc.error;
    block = doc.doc === null ? null : calendarBlockOf(doc.doc.exists ? doc.doc.text : null);
    list = listed.list;
    listError = listed.error;
    status = read.status;
    statusError = read.error;
    onstatus?.(calendarStatusOk(read));
    today = localDateOf(Date.now());
    loaded = true;
  }

  onMount(() => {
    void refresh();
    const tick = setInterval(() => (today = localDateOf(Date.now())), 60_000);
    return () => clearInterval(tick);
  });

  // PB-M6-T1 (plan §0.7): every new lifecycle step sits after the mount above. The busy line's phase, followed.
  onMount(() => onTodayStore((s) => (flowPhase = s.flow.running?.phase)));

  /** PB-M6 (spec §4 "Link"): `startAdding` opens the add flow once, on the first loaded state (`startAddingStep`), then
   *  focuses its chosen provider control INSIDE THIS PANEL (`calendarEl`, the outer section) — never another
   *  instance's, and not Settings' `focusFirst`, which is Settings-only and reads the page. */
  let calendarEl = $state<HTMLElement | undefined>(undefined);
  let startedAdding = false;
  $effect(() => {
    const step = startAddingStep(startAdding, loaded, startedAdding);
    startedAdding = step.done;
    if (step.open) untrack(() => void beginAdding());
  });
  async function beginAdding(): Promise<void> {
    openAdd();
    await tick();
    startAddingFocusTarget<HTMLElement>(calendarEl)?.focus();
  }

  /** PB final LOW L1/L2 (plan §0.7: after the first mount): this panel's own write and its leftover offer, to the link
   *  session's card. Nothing without the callback (every other mount). */
  $effect(() => {
    onpanelstate?.(linkPanelState({ working, leftover, loaded, configError, configExists }));
  });

  function lastReadFor(kind: CalendarSourceKind, id: string): string {
    const source = status?.sources.find((s) => sourceKey(s.kind, s.id) === sourceKey(kind, id));
    if (source === undefined) return status === null ? "unknown" : "not yet";
    return lastReadLine(source.lastScheduledRead, today, source.reason);
  }

  function noticesFor(kind: CalendarSourceKind, id: string): CalendarSourceNotice[] {
    const source = status?.sources.find((s) => sourceKey(s.kind, s.id) === sourceKey(kind, id));
    return [...(source?.lastScheduledRead?.notices ?? []), ...(tests[sourceKey(kind, id)]?.notices ?? [])];
  }

  /** Round 10 (M3): a "Test now" answer describes the source as it was tested. A write that changes a source (`keys`:
   *  its switch, its access, its calendars, its link's address) drops that source's answer, so a stale failure never
   *  outranks the source's fresh state; the next "Test now" tests it again. Round 11 (M2): a Test still running then
   *  cannot bring it back either — the write moves the source's generation, and that Test's answer for it is dropped
   *  (`runTest`). The decision is `testsAfterWrite`'s. Settings only: the wizard's step behaves as it did. */
  function forgetTests(keys: readonly string[]): void {
    const next = testsAfterWrite(mode, { tests, gens: testGens }, keys);
    if (next.tests !== tests) tests = next.tests;
    testGens = next.gens;
  }

  /** Report a write, refresh, and tell Settings the config changed. `touches`: the sources a write that landed changed
   *  (`forgetTests`). */
  async function settle(result: EditResult, done: string, touches: readonly string[] = []): Promise<boolean> {
    if (result.ok) {
      message = { bad: false, text: done };
      warnings = result.warnings;
      forgetTests(touches);
      onconfigchanged();
    } else {
      message = { bad: true, text: result.message };
    }
    await refresh();
    return result.ok;
  }

  async function write(run: () => Promise<EditResult>, done: string, touches: readonly string[] = []): Promise<boolean> {
    if (busy) return false;
    working = true;
    message = null;
    warnings = [];
    try {
      return await settle(await run(), done, touches);
    } finally {
      working = false;
    }
  }

  async function runTest(): Promise<void> {
    if (testing) return;
    testing = true;
    testError = null;
    const started = testGens;
    const answer = await readTest(() => calendarTest(), describeFailure);
    if (answer.test === null) {
      testError = answer.error;
    } else {
      // Round 11 (M2): a source a write changed while this Test ran keeps what it shows now (`testsAfterAnswer`).
      tests = testsAfterAnswer({ tests, gens: testGens }, answer.test.sources, started);
      testedAt = answer.test.ranAt;
    }
    testing = false;
  }

  function openAdd(): void {
    adding = true;
    added = null;
    addStage = "done";
    addOwner = "";
    linkName = "";
    linkId = "";
    idTouched = false;
    message = null;
  }

  function closeAdd(): void {
    takeUrl();
    adding = false;
    added = null;
    onaddclosed?.({ leftover: leftover !== null });
  }

  async function submitAdd(): Promise<void> {
    if (busy) return;
    working = true;
    message = null;
    warnings = [];
    leftover = null;
    const id = newId;
    try {
      // C2: Settings leaves the calendar's switch as it is; the wizard's step still turns it on.
      const result = await addLink({ id, name: linkName, takeUrl }, deps, describeFailure, { turnOn: mode === "wizard" });
      // Round 10 (M3): a link whose address was written (added, or replacing one) is not the link last tested.
      if (result.kind === "added" || result.linkWritten) forgetTests([sourceKey("link", id)]);
      if (result.kind === "failed") {
        message = { bad: true, text: result.message };
        if (result.linkWritten) leftover = id;
        // Rust removed the replaced link's confirmedOwner from config.json before the block save
        // failed: the config changed, so Settings must not keep its form's old base (M9 checkpoint).
        if (result.confirmationCleared) {
          onconfigchanged();
          await refresh();
        }
        return;
      }
      added = result;
      warnings = result.warnings;
      addStage = result.prompt?.kind === "confirm" ? "confirm" : result.prompt?.kind === "ask" ? "ask" : "done";
      onconfigchanged();
      await refresh();
      // C2: why the new link's row says "off" (C1), in Settings only.
      if (mode === "settings") {
        const off = offSourceNote(block);
        if (off !== null) message = { bad: false, text: off };
      }
    } finally {
      working = false;
    }
    void runTest();
  }

  async function confirmMine(id: string, address: string): Promise<void> {
    if (await write(() => confirmOwner(id, address, deps, describeFailure), `${address} is confirmed as yours.`)) {
      if (added?.kind === "added" && added.id === id) addStage = "done";
    }
  }

  async function saveAddress(id: string, address: string): Promise<void> {
    const ok = await write(
      () => editBlock((b) => withOwner(b, id, address), deps, describeFailure),
      address.trim() === "" ? "Address removed." : `Saved: ${address.trim()} is your address on "${id}".`,
    );
    if (ok) {
      ownerDrafts[id] = "";
      declined[id] = false;
      if (added?.kind === "added" && added.id === id) addStage = "done";
    }
  }

  async function remove(id: string): Promise<void> {
    if (busy) return;
    working = true;
    message = null;
    warnings = [];
    try {
      const removed = await removeLink(id);
      // Round 10 (M3): its saved address is gone, whatever the config says.
      forgetTests([sourceKey("link", id)]);
      message =
        removed.config !== null && removed.config.kind === "invalid"
          ? { bad: true, text: `The link's saved address was removed, but the config was not changed: ${notesText(removed.config.errors)}` }
          : { bad: false, text: `Removed the link "${id}".` };
      if (leftover === id) {
        leftover = null;
        onleftovercleared?.();
      }
      onconfigchanged();
    } catch (e) {
      message = { bad: true, text: describeFailure(e) };
    } finally {
      working = false;
      confirmRemove = null;
      await refresh();
    }
  }

  async function allowAccess(): Promise<void> {
    if (busy) return;
    const from = document.activeElement;
    working = true;
    message = null;
    try {
      // The answer is shown (final review r1): a refusal, a timeout or a signing failure would otherwise pass
      // in silence, with the refreshed list looking just as it did before the click.
      const said = connectMacMessage(await storeWrite(() => calendarConnectMac(), connectWrote));
      if (said !== null) message = { bad: true, text: said };
      // Round 10 (M3): the access the Mac source was last tested with has changed.
      else forgetTests([MAC_KEY]);
    } catch (e) {
      message = { bad: true, text: describeFailure(e) };
    } finally {
      working = false;
      await refresh();
    }
    await refocus(from, MAC_HEAD);
  }

  /** Round 10 (M4), Settings only: after the user's own "Allow access" or "Update the calendar reader", the button
   *  pressed is gone once access is granted (or it lost the focus while it was disabled): the focus, fallen to the page,
   *  goes back to that button when it is still drawn, else to the row's head. Never when the focus is elsewhere. */
  const MAC_HEAD = '.calendar.panel button.head[aria-controls="cal-src-macos"]';
  async function refocus(from: Element | null, head: string): Promise<void> {
    if (mode !== "settings") return;
    await tick();
    const now = document.activeElement;
    if (now !== null && now !== document.body) return;
    const back = from instanceof HTMLButtonElement && from.isConnected && !from.disabled ? from : null;
    (back ?? document.querySelector<HTMLElement>(head))?.focus();
  }

  /** The on/off switch. The value is read NOW — an event's `currentTarget` is gone once it awaits. Answers the write's
   *  promise, so the switch shows the file's value once it settles (round 10, H1: `Switch`). */
  function setEnabled(on: boolean): Promise<boolean> {
    return write(() => editBlock((b) => withEnabled(b, on), deps, describeFailure), "Calendar setting saved.");
  }

  /** The Mac Calendar app toggle (drawn only while `showMac`). User-directed 2026-10-22 (C2): in Settings it leaves the
   *  calendar's own switch as it is, and says so when that switch is off; the wizard's step still turns it on.
   *  Round 10: the Mac source's last test answer goes with the change (M3), and the write's promise is answered (H1). */
  function setMac(on: boolean): Promise<boolean> {
    return write(() => editBlock((b) => withMacos(b, on, mode === "wizard"), deps, describeFailure), macSaved(on), [MAC_KEY]);
  }
  const macSaved = (on: boolean): string => {
    const off = mode === "settings" && on ? offSourceNote(block) : null;
    return off === null ? "Calendar setting saved." : `Calendar setting saved. ${off}`;
  };

  function macTicked(c: CalendarMacosCalendar): boolean {
    return macChoice[c.id] ?? c.selected;
  }

  async function saveMacChoice(calendars: CalendarMacosCalendar[]): Promise<void> {
    const chosen = calendars.filter(macTicked);
    if (await write(() => editBlock((b) => withMacCalendars(b, chosen), deps, describeFailure), "Calendar choice saved.", [MAC_KEY])) {
      macChoice = {};
    }
  }

  const testedLine = (t: CalendarTestSource | undefined): string | null => (t === undefined ? null : testLine(t));
  const linkLabel = (l: CalendarLinkInfo): string => l.name ?? l.id;

  /* ── Redesign D, option A: the Settings rows (the header) ── */

  const MAC_KEY = sourceKey("macos", "macos");
  /** Whether "Test now" is offered: a link, or the Mac source switched on (both modes' rule). */
  const testable = $derived(list !== null && (list.links.length > 0 || (showMac && macOn)));

  /** A source's last scheduled read: `undefined` while the status is unknown, `null` for "not yet". */
  function readOf(kind: CalendarSourceKind, id: string): CalendarLastRead | null | undefined {
    if (status === null) return undefined;
    return status.sources.find((s) => sourceKey(s.kind, s.id) === sourceKey(kind, id))?.lastScheduledRead ?? null;
  }

  /** Round 9 (M3): whether the engine reads the calendar (`calendarReadOn`): the file's switch, and the engine's own
   *  answer once known — off for settings it cannot read. The label, the help and the tags say this; the master switch
   *  shows the file's value. Round 10 (H1): ⚠ IT CANNOT SAVE WHILE THE BLOCK IS BROKEN — Rust refuses to write a block
   *  the engine's resolver would find malformed (`check_calendar_block`), before any write, so flipping it only reports
   *  that refusal (the switch then shows the file's value again, `Switch`); the help line says to fix the settings with
   *  Edit settings as JSON (`CALENDAR_UNREADABLE_HELP`). */
  const calOn = $derived(calendarReadOn(block, status));
  const calUnreadable = $derived(calendarOn(block) && !calOn);
  // User-directed 2026-10-22 (C1): while the calendar is off, every source's tag says "off" (`shownSourceTag`) — but a
  // source this mount's "Test now" failed on shows its own tag (round 9, M2). Round 10 (M3): never a Mac source that is
  // itself switched off — its test answer is not read then.
  const macTest = $derived(macOn ? tests[MAC_KEY] : undefined);
  const macTag = $derived(shownSourceTag(calOn, macSourceTag(macOn, list?.macos ?? null, readOf("macos", "macos"), macTest), macTest));
  const linkTag = (link: CalendarLinkInfo): SourceTag | null =>
    shownSourceTag(
      calOn,
      linkSourceTag(link, {
        read: readOf("link", link.id),
        test: tests[sourceKey("link", link.id)],
        notices: noticesFor("link", link.id),
        declined: declined[link.id] === true,
        today,
      }),
      tests[sourceKey("link", link.id)],
    );

  /** Which Settings rows need the user now: exactly the rows whose tag is a warning. */
  const needs = $derived.by((): Record<string, boolean> => {
    const out = keyed<boolean>();
    if (mode !== "settings") return out;
    if (showMac) out[MAC_KEY] = macTag?.tone === "warn";
    for (const link of list?.links ?? []) out[sourceKey("link", link.id)] = linkTag(link)?.tone === "warn";
    return out;
  });
  /** The open rows: seeded from the first snapshot (a server render runs no effect), then moved on by every change of
   *  the needs — a refresh, a test, a "No" — without closing a row the user opened or reopening one they closed. */
  let rows = $state.raw<OpenRows>(nextOpenRows({ open: {}, needed: {} }, untrack(() => needs)));
  $effect(() => {
    const now = needs;
    untrack(() => (rows = nextOpenRows(rows, now)));
  });
  const isOpen = (key: string): boolean => isSet(rows.open, key);
  /** A header button's click: its own row only. Focus stays on the button (it is not redrawn). Round 12 (L4): the open
   *  rows are a prototype-free record (`keyed`), held raw and replaced whole. */
  function toggle(key: string): void {
    rows = withRowOpen(rows, key, !isOpen(key));
  }

  /* ── user-directed 2026-10-22: C-A (Settings only) ── */

  const macLine = $derived(macRow(macOn, list?.macos ?? null, calOn, macTag));
  const macAct = $derived(mode === "settings" ? macRowAction(macOn, list?.macos ?? null, calOn) : null);
  const linkAct = (link: CalendarLinkInfo): RowAction | null =>
    linkRowAction(
      link,
      { read: readOf("link", link.id), test: tests[sourceKey("link", link.id)], notices: noticesFor("link", link.id), declined: declined[link.id] === true },
      calOn,
    );

  /** A row's own action (C-A): it OPENS THE ROW and moves the focus to that control in its details — the address field,
   *  "It's mine", or the same "Allow access" / "Update the calendar reader" button — so the details' own words (the
   *  question, the dialog note) are on screen before anything happens. Only on this click: a row that opens by itself
   *  never takes the focus. */
  async function act(key: string, id: string, a: RowAction): Promise<void> {
    rows = withRowOpen(rows, key, true);
    await tick();
    const box = document.getElementById(id);
    if (box === null) return;
    const want = a.target === "confirm" ? "It's mine" : a.label;
    const target: HTMLElement | null =
      a.target === "owner" ? box.querySelector<HTMLInputElement>('input[type="email"]') : ([...box.querySelectorAll("button")].find((b) => b.textContent?.trim() === want) ?? null);
    target?.focus();
  }

  /** "Add a connection…" asks Mac Calendar app or Calendar link where the Mac source can still be turned on
   *  (`connectionChoices`); otherwise it opens the link flow, unchanged. */
  let choosing = $state(false);
  /** Round 9 (L8), Settings only: the button pressed is gone once what it opened is drawn, so the focus would fall to
   *  the page; it moves to the first control of what opened (the picker's first choice, the add flow's first field) or,
   *  after "Mac Calendar app", to that row's head (its switch is disabled while the write runs). The wizard's add flow
   *  never moves the focus (except once, when the calendar question's link session opens it: `startAdding`,
   *  `beginAdding`). Round 10 (L4): the add flow's first control is its CHOSEN provider (the radio still
   *  checked from an earlier add, as ProvidersList's Add focuses its checked choice), else its first field. */
  const PICKER_FIRST = [".calendar.panel .add.picker button"];
  const ADD_FIRST = ['.calendar.panel .add:not(.picker) input[name="cal-provider"]:checked', ".calendar.panel .add:not(.picker) input"];
  /** The first of `selectors` (in order) that matches takes the focus. */
  async function focusFirst(selectors: readonly string[]): Promise<void> {
    if (mode !== "settings") return;
    await tick();
    for (const s of selectors) {
      const el = document.querySelector<HTMLElement>(s);
      if (el !== null) return el.focus();
    }
  }
  function addConnection(): void {
    if (connectionChoices(showMac, macOn).length === 1) {
      openAdd();
      void focusFirst(ADD_FIRST);
    } else {
      choosing = true;
      void focusFirst(PICKER_FIRST);
    }
  }
  function chooseMac(): void {
    choosing = false;
    void setMac(true);
    void focusFirst([MAC_HEAD]);
  }
  function chooseLink(): void {
    choosing = false;
    openAdd();
    void focusFirst(ADD_FIRST);
  }
</script>

<section class="calendar" class:panel={mode === "settings"} bind:this={calendarEl}>
  {#if mode === "settings"}
    <!-- User-directed 2026-10-22: IN SETTINGS, two boxes. The master switch in its own box (a switch, `Switch`), then
         "Connections" with its ENABLED / DISABLED label and the C-A rows. Everything Settings draws is in this block;
         the wizard's branch below is 5b6fa8cc2's, untouched. -->
    {#if locked && busyLine !== null}
      <!-- PB-M6 (spec §4 "Flows"): while a calendar-question flow runs, the panel says why its controls wait. -->
      <p class="mline" tabindex="-1">{busyLine}</p>
    {/if}
    <Tile>
      <div class="box master">
        {#if !loaded}
          <p class="muted">Reading the calendar settings…</p>
        {:else if configError !== null}
          <p class="bad">{configError}</p>
        {:else if configExists === false}
          <p class="muted">
            Calendar links are saved in your configuration, which does not exist yet. The Setup wizard
            creates it.
          </p>
        {:else}
          <div class="mrow">
            <div class="mwords">
              <label class="mtitle" for="cal-master">{MASTER_TITLE}</label>
              <p class="mline" id="cal-master-line">{MASTER_LINE}</p>
              <!-- Briefing redesign C (C-M5-T15): the live read, explained; not in the switch's describedby. -->
              <p class="mline">{LIVE_READ_LINE}</p>
            </div>
            <Switch id="cal-master" describedby="cal-master-line" checked={calendarOn(block)} disabled={busy || block === null} onchange={(on) => setEnabled(on)} />
          </div>
          {#if block === null}
            {@render unreadable()}
          {/if}
        {/if}
      </div>
    </Tile>
    {#if loaded && configError === null && configExists !== false}
      {@const conn = connectionsLabel(calOn)}
      {@const help = connectionsHelp(calOn, showMac, calUnreadable)}
      <Tile>
        <div class="box">
          <div class="chead">
            <h4>Connections</h4>
            <span class="badge badge-{conn.tone}">{conn.text}</span>
          </div>
          <p class="help" class:offhelp={help.off} id="cal-conn-help">{help.text}</p>
          <!-- Option A's flat rows, C-A's look. -->
          <ul class="sources">
            <!-- Tiny fix (the LOWs): the config's warnings and the read errors before the source rows, as at 5b6fa8cc2. -->
            {#each configWarningLines(status) as warning, i (i)}
              <li class="item"><p class={warning.off ? "bad" : "warn"}>{warning.text}</p></li>
            {/each}
            {#if listError !== null}
              <li class="item"><p class="bad">{listError}</p></li>
            {/if}
            {#if statusError !== null && listError === null}
              <li class="item"><p class="bad">{statusError}</p></li>
            {/if}
            {#if showMac}
              <li class="item src" class:needs={needs[MAC_KEY] === true}>
                <div class="line">
                  {@render srcHead(MAC_KEY, "cal-src-macos", "mac", "Mac Calendar app", macLine.line, macLine.tag)}
                  {#if macAct !== null}
                    {@const a = macAct}
                    <button type="button" class="act" onclick={() => void act(MAC_KEY, "cal-src-macos", a)}>{a.label}</button>
                  {/if}
                  <!-- Round 9 (L13): while the calendar is off, the switch is described by the line saying so. Round 12 (L3):
                       disabled while the file's calendar block cannot be read, as the master switch and "Add a connection…" are. -->
                  <Switch label="Read the Mac Calendar app" describedby={calOn ? undefined : "cal-conn-help"} checked={macOn} disabled={busy || block === null} onchange={(on) => setMac(on)} />
                </div>
                <div class="details" id="cal-src-macos" hidden={!isOpen(MAC_KEY)}>
                  <p class="help">Every account you added on this Mac (iCloud, Google, Exchange and others).</p>
                  {@render macState()}
                  <!-- Round 9 (M2): the Mac source's own "Test now" answer, as a link's details give theirs. -->
                  {#if macOn && testedLine(tests[MAC_KEY]) !== null}
                    <p class="small">Test: {testedLine(tests[MAC_KEY])}</p>
                  {/if}
                </div>
              </li>
            {/if}
            {#if list !== null}
              {#each list.links as link (link.id)}
                {@const key = sourceKey("link", link.id)}
                {@const a = linkAct(link)}
                <li class="item src" class:needs={needs[key] === true}>
                  <div class="line">
                    {@render srcHead(key, `cal-src-link-${link.id}`, "link", linkLabel(link), linkRowLine(link), linkTag(link))}
                    {#if a !== null}
                      <button type="button" class="act" onclick={() => void act(key, `cal-src-link-${link.id}`, a)}>{a.label}</button>
                    {/if}
                  </div>
                  <div class="details" id="cal-src-link-{link.id}" hidden={!isOpen(key)}>
                    {@render linkBody(link)}
                  </div>
                </li>
              {:else}
                <li class="item"><p class="muted">No calendar links yet.</p></li>
              {/each}
            {/if}
            {#if testable && testError !== null}
              <li class="item"><p class="bad">{testError}</p></li>
            {/if}
            {#if leftover !== null}
              <li class="item">
                <p class="bad small">
                  The link "{leftover}" was saved to its private file, but not to the calendar settings.
                </p>
                <div class="row">
                  <button type="button" disabled={busy} onclick={() => leftover !== null && void remove(leftover)}>Remove that saved link</button>
                </div>
              </li>
            {/if}
          </ul>

          {#if testable || (!adding && !choosing)}
            <div class="foot">
              {#if testable}
                <button type="button" disabled={testing} onclick={() => void runTest()}>
                  {testing ? "Testing… (up to a minute)" : "Test now"}
                </button>
              {/if}
              {#if !adding && !choosing}
                <button type="button" class="primary" disabled={busy || block === null} onclick={addConnection}>Add a connection…</button>
              {/if}
            </div>
          {/if}
          {#if testable && testedAt !== null && testError === null}
            <p class="muted small">Tested just now: each source read once, the way the morning run reads it.</p>
          {/if}

          {#if choosing && !adding}
            <!-- C-A: "Add a connection…" asks which kind, where the Mac source can still be turned on. -->
            <div class="add picker">
              <p>What do you want to connect?</p>
              <div class="row">
                <button type="button" disabled={busy} onclick={chooseMac}>Mac Calendar app</button>
                <button type="button" disabled={busy} onclick={chooseLink}>Calendar link</button>
                <button type="button" onclick={() => (choosing = false)}>Cancel</button>
              </div>
            </div>
          {/if}

          {#if adding}
            <div class="add">
              {@render addPanel()}
            </div>
          {/if}

          {#if message !== null}
            <p class={message.bad ? "bad" : "ok"} role="status">{message.text}</p>
          {/if}
          {#each warnings as w, i (i)}
            <p class="warn small">{w.field !== "" ? `${w.field}: ` : ""}{w.message}</p>
          {/each}
        </div>
      </Tile>
    {/if}
  {/if}

  {#if mode === "settings"}
    <!-- Settings draws all of its page in the block above. -->
  {:else if !loaded}
    <p class="muted">Reading the calendar settings…</p>
  {:else if configError !== null}
    <p class="bad">{configError}</p>
  {:else if configExists === false}
    <p class="muted">
      Calendar links are saved in your configuration, which does not exist yet. The Setup wizard
      creates it.
    </p>
  {:else}
    {#if block === null}
      {@render unreadable()}
    {/if}
    {#each configWarningLines(status) as warning, i (i)}
      <p class={warning.off ? "bad" : "warn"}>{warning.text}</p>
    {/each}
    {#if listError !== null}
      <p class="bad">{listError}</p>
    {/if}
    {#if statusError !== null && listError === null}
      <p class="bad">{statusError}</p>
    {/if}

    {#if showMac}
      <div class="mac">
        <label class="choice">
          <input type="checkbox" checked={macOn} disabled={busy}
            onchange={(e) => setMac(e.currentTarget.checked)} />
          <span><strong>Mac Calendar app</strong> — every account you added on this Mac (iCloud, Google,
            Exchange and others).</span>
        </label>
        {@render macState()}
      </div>
    {/if}

    {#if list !== null && list.links.length > 0}
      <ul class="links">
        {#each list.links as link (link.id)}
          <li>
            {@render linkBody(link)}
          </li>
        {/each}
      </ul>
    {:else if list !== null}
      <p class="muted">No calendar links yet.</p>
    {/if}

    {#if list !== null && (list.links.length > 0 || (showMac && macOn))}
      <div class="row">
        <button type="button" disabled={testing} onclick={() => void runTest()}>
          {testing ? "Testing… (up to a minute)" : "Test now"}
        </button>
      </div>
      {#if testError !== null}
        <p class="bad">{testError}</p>
      {/if}
      {#if testedAt !== null && testError === null}
        <p class="muted small">Tested just now: each source read once, the way the morning run reads it.</p>
      {/if}
    {/if}

    {#if leftover !== null}
      <p class="bad small">
        The link "{leftover}" was saved to its private file, but not to the calendar settings.
      </p>
      <div class="row">
        <button type="button" disabled={busy} onclick={() => leftover !== null && void remove(leftover)}>Remove that saved link</button>
      </div>
    {/if}

    {#if !adding}
      <div class="row">
        <button type="button" class="primary" disabled={busy || block === null} onclick={openAdd}>Add a calendar link…</button>
      </div>
    {:else}
      <div class="add">
        {@render addPanel()}
      </div>
    {/if}

    {#if message !== null}
      <p class={message.bad ? "bad" : "ok"} role="status">{message.text}</p>
    {/if}
    {#each warnings as w, i (i)}
      <p class="warn small">{w.field !== "" ? `${w.field}: ` : ""}{w.message}</p>
    {/each}
  {/if}
</section>

<!-- The config's calendar block cannot be read: in both modes (Settings' first row; the wizard's first line). -->
{#snippet unreadable()}
  <p class="bad">The config's calendar settings could not be read. Fix them with {EDIT_AS_JSON}.</p>
{/snippet}

<!-- A source row's header (Settings): C-A's icon (the mockup's computer or link, in a small rounded square), the
     name in bold and a plain line with the status tag inline, opening its details in place. The chevron leads, as on
     the AI providers rows: the row's own action and the Mac switch sit to its right, outside the button. -->
{#snippet srcHead(key: string, id: string, icon: "mac" | "link", name: string, line: string, tag: SourceTag | null)}
  <button type="button" class="head ctl" aria-expanded={isOpen(key)} aria-controls={id} onclick={() => toggle(key)}>
    <svg class="chev" viewBox="0 0 16 16" aria-hidden="true" focusable="false"><path d="M6 3l5 5-5 5" fill="none" stroke="currentColor" stroke-width="1.8" /></svg>
    <span class="ico" aria-hidden="true">
      {#if icon === "mac"}
        <svg viewBox="0 0 24 24" focusable="false"><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M2 20h20" /></svg>
      {:else}
        <svg viewBox="0 0 24 24" focusable="false"><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" /><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" /></svg>
      {/if}
    </span>
    <span class="words">
      <span class="srcname">{name}</span>
      <span class="sub">{line}{#if tag !== null}{" · "}<span class="tag tone-{tag.tone}"><span aria-hidden="true">●</span> {tag.text}</span>{/if}</span>
    </span>
  </button>
{/snippet}

<!-- The Mac source's state, in both modes (the wizard's box; Settings' row details). -->
{#snippet macState()}
        {#if macOn}
          {#if list === null || list.macos === null}
            <p class="muted small">The engine has not reported the Mac Calendar app yet.</p>
          {:else}
            {@const mac = list.macos}
            <p class="small">{macStatusLine(mac.status)}</p>
            <p class="small">Last scheduled read: {lastReadFor("macos", "macos")}</p>
            {#if mac.status === "not-granted" || mac.status === "helper-missing"}
              <div class="row">
                <button type="button" disabled={busy} onclick={() => void allowAccess()}>Allow access</button>
              </div>
              <p class="muted small">{MAC_DIALOG_NOTE}</p>
            {/if}
            {#if mac.notices?.includes("helper-outdated")}
              <p class="notice small">{MAC_OUTDATED_NOTE}</p>
              <div class="row">
                <button type="button" disabled={busy} onclick={() => void allowAccess()}>Update the calendar reader</button>
              </div>
            {/if}
            {#if mac.calendars.length > 0}
              <fieldset class="checklist" disabled={busy}>
                <legend>Calendars to read</legend>
                {#each mac.calendars as cal (cal.id)}
                  <label class="choice">
                    <input type="checkbox" checked={macTicked(cal)}
                      onchange={(e) => (macChoice[cal.id] = e.currentTarget.checked)} />
                    <span>{cal.title} <span class="muted">— {cal.account}{cal.type === "subscribed"
                      ? " · subscribed"
                      : cal.type === "birthdays"
                        ? " · birthdays"
                        : cal.editable
                          ? ""
                          : " · read-only"}</span></span>
                  </label>
                {/each}
                {#if Object.keys(macChoice).length > 0}
                  <div class="row">
                    <button type="button" onclick={() => void saveMacChoice(mac.calendars)}>Save calendar choice</button>
                  </div>
                {/if}
              </fieldset>
              <p class="muted small">
                Calendars you can edit start ticked. A calendar someone else shared with you can be
                editable too — its account is shown so you can untick it.
              </p>
            {/if}
            {#each overlapHints(list) as hint (hint.linkId)}
              <p class="muted small">{overlapLine(hint)}</p>
            {/each}
          {/if}
        {/if}
{/snippet}

<!-- A link's lines and controls, in both modes (the wizard's card; Settings' row details). -->
{#snippet linkBody(link: CalendarLinkInfo)}
          {@const prompt = ownerPrompt(link)}
          {@const problem = fileProblem(link)}
          {@const from = urlFromLine(link)}
          {@const tested = testedLine(tests[sourceKey("link", link.id)])}
            <p class="name"><strong>{linkLabel(link)}</strong>{#if link.name !== undefined}<span class="muted">{` (${link.id})`}</span>{/if}</p>
            {#if from !== null}
              <p class="muted small">{from}</p>
            {/if}
            {#if problem !== null}
              <p class="bad small">This link cannot be read: {problem}.</p>
            {/if}
            <p class="small">Last scheduled read: {lastReadFor("link", link.id)}</p>
            {#if tested !== null}
              <p class="small">Test: {tested}</p>
            {/if}
            {#if prompt.kind === "confirm"}
              <p class="small">{confirmQuestion(prompt.address)}</p>
              {#if prompt.yours !== null}
                <p class="muted small">Your address on this calendar: {prompt.yours}</p>
              {/if}
              <div class="row">
                <button type="button" disabled={busy} onclick={() => void confirmMine(link.id, prompt.address)}>It's mine</button>
                {#if declined[link.id] !== true}
                  <button type="button" disabled={busy} onclick={() => (declined[link.id] = true)}>No, it belongs to someone else</button>
                {/if}
              </div>
            {:else if prompt.kind === "known"}
              <p class="muted small">Your address on this calendar: {prompt.address}{prompt.confirmed ? " (confirmed)" : ""}</p>
            {/if}
            {#if needsAddress(prompt, noticesFor("link", link.id), declined[link.id] === true)}
              <div class="field">
                <label for="cal-owner-{link.id}">{OWNER_FIELD_LABEL}</label>
                <input id="cal-owner-{link.id}" type="email" autocomplete="off" value={ownerDrafts[link.id] ?? ""}
                  oninput={(e) => (ownerDrafts[link.id] = e.currentTarget.value)} />
                <p class="muted small">{OWNER_FIELD_HELP}</p>
              </div>
              <div class="row">
                <button type="button" disabled={busy || (ownerDrafts[link.id] ?? "").trim() === ""}
                  onclick={() => void saveAddress(link.id, ownerDrafts[link.id] ?? "")}>Save address</button>
              </div>
            {/if}
            <div class="row">
              {#if confirmRemove === link.id}
                <span class="small">Remove "{link.id}"?{link.urlFrom === "file" ? " Its saved address is deleted from this computer." : ""}</span>
                <button type="button" class="danger" disabled={busy} onclick={() => void remove(link.id)}>Remove</button>
                <button type="button" disabled={busy} onclick={() => (confirmRemove = null)}>Cancel</button>
              {:else}
                <button type="button" disabled={busy} onclick={() => (confirmRemove = link.id)}>Remove…</button>
              {/if}
            </div>
{/snippet}

<!-- The add flow, in both modes (inside its `.add` box). Its order and wording are the wizard's. -->
{#snippet addPanel()}
        {#if added !== null && added.kind === "added" && addStage === "confirm" && added.prompt?.kind === "confirm"}
          {@const address = added.prompt.address}
          <p>{confirmQuestion(address)}</p>
          <div class="row">
            <button type="button" class="primary" disabled={busy} onclick={() => void confirmMine(added?.kind === "added" ? added.id : "", address)}>Yes, it's mine</button>
            <button type="button" disabled={busy} onclick={() => (addStage = "ask")}>No, it belongs to someone else</button>
          </div>
        {:else if added !== null && added.kind === "added" && addStage === "ask"}
          {@const id = added.id}
          <div class="field">
            <label for="cal-add-owner">{OWNER_FIELD_LABEL}</label>
            <input id="cal-add-owner" type="email" autocomplete="off" value={addOwner}
              oninput={(e) => (addOwner = e.currentTarget.value)} />
            <p class="muted small">{OWNER_FIELD_HELP}</p>
          </div>
          <div class="row">
            <button type="button" class="primary" disabled={busy || addOwner.trim() === ""} onclick={() => void saveAddress(id, addOwner)}>Save address</button>
            <button type="button" disabled={busy} onclick={() => (addStage = "done")}>Skip for now</button>
          </div>
        {:else if added !== null && added.kind === "added"}
          <p class="ok">The link "{added.id}" was {added.replaced ? "replaced" : "added"}.</p>
          {#if added.note !== null}
            <p class="muted small">It could not be checked yet: {added.note}</p>
          {/if}
          <div class="row">
            <button type="button" onclick={closeAdd}>Done</button>
            <button type="button" onclick={openAdd}>Add another</button>
          </div>
        {:else}
          <fieldset class="providers" disabled={busy}>
            <legend>Where is the calendar?</legend>
            {#each PROVIDERS as p (p.id)}
              <label class="choice">
                <input type="radio" name="cal-provider" checked={provider === p.id} onchange={() => (provider = p.id)} />
                <span>{p.label}</span>
              </label>
            {/each}
          </fieldset>
          <ol class="steps">
            {#each steps.steps as step, i (i)}
              <li>{step}</li>
            {/each}
          </ol>
          <div class="field">
            <label for="cal-link-name">Name (shown here)</label>
            <input id="cal-link-name" type="text" autocomplete="off" value={linkName} disabled={busy}
              oninput={(e) => (linkName = e.currentTarget.value)} />
          </div>
          <div class="field">
            <label for="cal-link-id">Short name</label>
            <input id="cal-link-id" type="text" autocomplete="off" spellcheck="false" value={newId} disabled={busy}
              oninput={(e) => { linkId = e.currentTarget.value; idTouched = true; }} />
            <p class="muted small">
              Lower-case letters, digits and dashes. It names the link in the briefing when it cannot be read.
            </p>
          </div>
          {#if existing !== null && existing.urlFrom !== "file"}
            <p class="bad small">"{newId}" is a link whose address is set in the config file. Choose another short name.</p>
          {:else if existing !== null}
            <p class="warn small">A link called "{newId}" exists: adding replaces its address, and you confirm its owner again.</p>
          {/if}
          <div class="field">
            <label for="cal-link-url">Calendar link</label>
            <input id="cal-link-url" type="password" autocomplete="off" spellcheck="false" disabled={busy}
              bind:this={urlField} />
            <p class="muted small">{LINK_SECRET_NOTE}</p>
          </div>
          <div class="row">
            <button type="button" class="primary" disabled={busy || (existing !== null && existing.urlFrom !== "file")}
              onclick={() => void submitAdd()}>{busy ? "Adding…" : "Add link"}</button>
            <button type="button" disabled={busy} onclick={closeAdd}>Cancel</button>
          </div>
        {/if}
{/snippet}

<style>
  .calendar {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  /* Redesign D final round 2 (V3): Settings mode only (the wizard's mode draws no panel class). User-directed
   * 2026-10-22: the panel holds two boxes — the master switch's and Connections — each a Step 0 `Tile`, 14px apart; in
   * each, `.box` puts the content the mockup's 12px / 14px from the tile's edge (the Tile pads 0.65rem 0.8rem). The
   * component's own colours, light and dark: the mockup's green tone, the label tints and the amber row (each text
   * measured ≥ 4.5:1 on its tint in tests-web/settings-layout.check.ts). */
  .panel {
    gap: 14px;
    --tone-ok: #15803d;
    --tint-on: #edf7f0;
    --tint-off: #f8e4df;
    --tint-needs: #f8eedd;
  }
  .box {
    display: flex;
    flex-direction: column;
    padding: 0 calc(14px - 0.8rem) calc(11px - 0.65rem);
  }
  .chead {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-top: calc(10px - 0.65rem);
  }
  .chead h4 {
    margin: 0;
    font-size: 11px;
    font-weight: 400;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--muted);
  }
  /* The label at the title's right: green ENABLED / red DISABLED, the word always there (colour never the only signal). */
  .badge {
    font-size: 10.5px;
    font-weight: 700;
    letter-spacing: 0.07em;
    text-transform: uppercase;
    padding: 2px 8px;
    border-radius: 5px;
  }
  .badge-on {
    color: var(--state-done);
    background: var(--tint-on);
  }
  .badge-off {
    color: var(--danger);
    background: var(--tint-off);
  }
  .box > .help.offhelp {
    color: var(--danger);
  }
  /* The master switch's box: the bold title and its muted line on the left, the switch on the right. */
  .master {
    padding-bottom: calc(12px - 0.65rem);
  }
  .mrow {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: calc(12px - 0.65rem);
  }
  .mwords {
    flex: 1;
    min-width: 0;
  }
  .mtitle {
    display: block;
    font-size: 14.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .mline {
    margin-top: 2px;
    font-size: 12px;
    color: var(--muted);
  }
  .master > p {
    margin-top: calc(12px - 0.65rem);
  }
  p {
    margin: 0;
  }
  .links {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.6rem;
  }
  .links li,
  .add,
  .mac {
    border: 1px solid var(--line);
    border-radius: 0.45rem;
    padding: 0.6rem 0.8rem;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .name {
    overflow-wrap: anywhere;
  }
  .row {
    display: flex;
    gap: 0.6rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .choice {
    display: flex;
    gap: 0.5rem;
    align-items: flex-start;
  }
  .choice input {
    margin-top: 0.25rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .field label {
    font-size: 0.85rem;
    color: var(--muted);
  }
  .field input {
    font: inherit;
    padding: 0.4rem 0.6rem;
    border-radius: 0.4rem;
    border: 1px solid var(--line);
    background: transparent;
    color: inherit;
  }
  fieldset {
    border: 1px solid var(--line);
    border-radius: 0.45rem;
    padding: 0.4rem 0.8rem 0.6rem;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  legend {
    padding: 0 0.3rem;
    font-size: 0.85rem;
  }
  .steps {
    margin: 0;
    padding-left: 1.3rem;
    font-size: 0.9rem;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .muted {
    color: var(--muted);
  }
  .small {
    font-size: 0.85rem;
  }
  .bad,
  .warn {
    color: var(--danger);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .ok,
  .notice {
    color: var(--muted);
  }
  button {
    font: inherit;
    padding: 0.4rem 0.9rem;
    border-radius: 0.45rem;
    border: 1px solid var(--line);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  button.primary {
    background: var(--accent);
    color: var(--on-accent);
    border-color: transparent;
  }
  button.danger {
    border-color: var(--danger);
    color: var(--danger);
  }

  /* ── Redesign D, option A (user-directed 2026-10-22): Settings only. Every rule below is scoped to `.panel` (the
   * Settings mode's section) or to a class only the Settings branch draws, so the wizard's look is the one above. The
   * S-A mockup's `.item` rows: flat, edge to edge across the page's Tile, 9px 14px, a hairline (`--tile-border`)
   * above each, the status tag at the right in 11.5px; its footer `.row` (11px 14px) with the buttons on the right;
   * D's local button look (12.5px, 5px 11px, radius 6, `--tile` fill, `--tile-border`), as ProvidersList's (V10). The
   * Tile pads 0.65rem 0.8rem and the panel the rest of 14px / 11px, so a row reaches the tile's edges with -14px and
   * the last block its bottom with -11px. ── */
  .panel .help {
    font-size: 12px;
    color: var(--muted);
  }
  .box > .help {
    margin: 2px 0 0;
  }
  .box > p:not(.help) {
    margin-top: 8px;
  }
  .sources {
    list-style: none;
    margin: 8px -14px 0;
    padding: 0;
  }
  .item {
    padding: 9px 14px;
    border-top: 1px solid var(--tile-border);
    overflow-wrap: anywhere;
  }
  .item.src {
    padding: 0;
  }
  /* C-A: a row that needs the user is tinted amber (the mockup's), its words and tag kept ≥ 4.5:1 on the tint. */
  .item.src.needs {
    background: var(--tint-needs);
  }
  .item > .row {
    margin-top: 6px;
  }
  /* C-A's row line: the header button takes the room; the row's own action and the Mac switch sit at its right. */
  .line {
    display: flex;
    align-items: center;
    gap: 10px;
    padding-right: 14px;
  }
  .panel button.head {
    display: flex;
    align-items: center;
    gap: 10px;
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 9px 4px 9px 14px;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: inherit;
    font: inherit;
    text-align: left;
    /* Tiny fix (the LOWs): the focus ring inside the row, clear of the hairlines above and below it. */
    outline-offset: -2px;
  }
  /* The mockup's icon square: 28px, radius 7, the panel colour and the tile's hairline; the icon is decorative. */
  .ico {
    flex: none;
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 7px;
    background: var(--panel);
    border: 1px solid var(--tile-border);
    color: var(--fg);
  }
  .ico svg {
    width: 16px;
    height: 16px;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
  }
  .words {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .srcname {
    font-weight: 600;
  }
  .sub {
    font-size: 12px;
    color: var(--muted);
  }
  .act {
    flex: none;
  }
  .tag {
    font-size: 12px;
  }
  /* The disclosure chevron leads the row, as on the AI providers rows. */
  .chev {
    flex: none;
    align-self: center;
    width: 10px;
    height: 10px;
    color: var(--muted);
    transition: transform 0.15s ease;
  }
  .head[aria-expanded="true"] .chev {
    transform: rotate(90deg);
  }
  @media (prefers-reduced-motion: reduce) {
    .chev {
      transition: none;
    }
  }
  /* Final round 4 (V18)'s tones, as ProvidersList's: the mockup's green (component-scoped, light and dark), the
   * mockup's amber (Step 0's --tag-local), and the muted grey; each ≥ 4.5:1 on the tile (calendar.check.ts). */
  .tone-ok {
    color: var(--tone-ok);
  }
  .tone-warn {
    color: var(--tag-local);
  }
  .tone-muted {
    color: var(--muted);
  }
  @media (prefers-color-scheme: dark) {
    .panel {
      --tone-ok: #4ade80;
      --tint-on: #173524;
      --tint-off: #3d211c;
      --tint-needs: #2f2716;
    }
  }
  .details {
    display: flex;
    flex-direction: column;
    gap: 6px;
    padding: 0 14px 11px calc(14px + 10px + 10px + 28px + 10px);
  }
  .details[hidden] {
    display: none;
  }
  .foot {
    display: flex;
    justify-content: flex-end;
    flex-wrap: wrap;
    gap: 12px;
    margin: 0 -14px;
    padding: 11px 14px;
    border-top: 1px solid var(--tile-border);
  }
  .box > .sources:last-child,
  .box > .foot:last-child,
  .box > .add:last-child {
    margin-bottom: -11px;
  }
  /* What a source's details and the add flow draw, flat: no box, no inner border; help at 12px. */
  .panel .add {
    margin: 0 -14px;
    padding: 11px 14px;
    border: 0;
    border-top: 1px solid var(--tile-border);
    border-radius: 0;
    gap: 8px;
  }
  /* Under "Tested just now", the add flow's hairline keeps the row's 11px from the line. */
  .box > p + .add {
    margin-top: 11px;
  }
  .panel .small,
  .panel .steps {
    font-size: 12px;
  }
  .panel .row {
    gap: 6px;
  }
  .panel fieldset {
    border: 0;
    border-radius: 0;
    padding: 0;
    min-width: 0;
    gap: 4px;
  }
  .panel legend {
    padding: 0;
    margin-bottom: 2px;
    font-size: 12px;
    font-weight: 600;
  }
  .panel .choice input {
    margin-top: 0.15rem;
  }
  .panel .field label {
    font-size: 12px;
  }
  .panel .field input {
    font-size: 13px;
    padding: 5px 9px;
    border: 1px solid var(--tile-border);
    border-radius: 6px;
    background: var(--surface, var(--bg));
  }
  .panel button {
    font-size: 12.5px;
    padding: 5px 11px;
    border-radius: 6px;
    border: 1px solid var(--tile-border);
    background: var(--tile);
    color: var(--fg);
  }
  .panel button:disabled {
    opacity: 0.6;
  }
  .panel button.primary {
    background: var(--accent);
    color: var(--on-accent);
    border-color: var(--accent);
  }
  .panel button.danger {
    color: var(--danger);
    border-color: color-mix(in srgb, var(--danger) 35%, var(--tile));
  }
</style>
