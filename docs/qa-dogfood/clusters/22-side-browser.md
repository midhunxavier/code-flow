# Cluster 22 · side-browser

**Side-panel live Browser: preview navigation loop, Pick/Box state, stale refs, console, Snapshot remnants**

Status: **fixed and verified** · 10 issues · branch `codex/qa-side-browser`

Planner notes: t09-1: the browserRequest effect in ui/interactive-browser.tsx (117-130) treats a request as pending until memo.browserHandled matches it, and a failed navigate never marks it handled. The result is bursts of hundreds of navigate requests; mark the request handled on failure. t09-3: Pick/Box mode lives only in LiveBrowserTools state (ui/browser.tsx:104), while the injected overlay resets on reload or navigation; resync them. t08-9/t09-9: a viewer resize clears the agent's refs (changed() at src/agent-browser.ts:109), and failures before any effect are recorded as 'uncertain' (src/agent-tools.ts:154), which blocks a retry with the same operationId. t08-11: overlay messages carry a stale tab id. t09-13: console history is kept only in UI memory. t09-14: the label counts 300 errors but sends only the last 20. t09-15/S05-6: docs and errors describe the removed Snapshot mode; remove the dead snap code and make the Chrome path env vars consistent. t09-21: the console and Adjust drawers squeeze the page (ui/styles.css:535). fs-policy-gate owns the 403 'paused' display for the Browser tab. Duplicate groups: [["t08-9","t09-9"],["t09-15","S05-6"]]

Likely files: `ui/interactive-browser.tsx`, `ui/browser.tsx`, `src/agent-browser.ts`, `src/agent-tools.ts`, `src/agent-computer.ts`, `ui/browser-context.ts`, `src/snapshot.ts`, `src/server.ts`, `src/dependency-health.ts`, `ui/styles.css`

## Repair and verification · 2026-10-26

Isolated source: `/private/tmp/codeflow-qa-side-browser`, based on `fbc9562`. All browser replays use a fresh scratch repository/home and QA ports 4355/4357. Provider setup is fake; browser navigation, rendering, annotation input, uploads/downloads and captures use real Chrome. Desktop input tests inject a mock executor and never control the host desktop. The live 60c0 checkout, ports 4317/4318 and `~/.codeflow` are untouched.

| Reported issue | Repair and evidence |
| --- | --- |
| t09-1 | A preview request is consumed before dispatch, failure has its own persistent error, and restoration is separate. URLs are normalized before selecting an existing tab. Original net-listener-then-exit preview is attempted once; two manual navigations and an app reload retain the chosen working URL. |
| t09-3 | Pick/Box are shared per-page state, accept Escape mode events, and resynchronize on a new document. Send resets the mode; hiding the panel turns interception off. Reload, address navigation, Escape, Send and Box dragging are replayed through the canvas with independent fixture hit counts proving no click-through. Recording also resynchronizes on the document change. |
| t08-9, t09-9 | Resize advances only the viewer generation, preserving element refs. Typed pre-dispatch validation errors produce `rejected` receipts, permitting corrected input with the same operation ID; post-dispatch/unknown errors remain `uncertain`. Target identity uses tab, document and backend node, so fresh refs to the same element deduplicate and different elements are rejected. Browser calls use real Chrome; stale desktop screenshot/bounds checks use a mock executor. Existing completed receipts without target metadata remain compatible. |
| t08-11 | Server tab selection clears the previous overlay before detaching. A late idempotent reset to a previous tab succeeds without touching the current tab; other wrong-tab commands still fail. Component cleanup no longer races a new document/tab. UI tab A → B → A and provider input without a viewer are covered. |
| t09-13 | The server retains 300 console entries per tab, replays a replacement history on reconnect, retains observations while the panel is hidden, deduplicates Chrome replay, and removes history on target destruction. Navigation and Clear reset history. Reload, hidden Browser, a separate legacy panel window, tab switch and Clear/reconnect are covered. History lasts for the browser session, not a server restart. |
| t09-14 | A shared 20-error attachment limit drives the checkbox label and payload. The console shows a `+` and dropped-entry count at the 300-entry cap; context includes the omitted count. Tests cover 1, 12, 20, 25 and 300 retained errors, and the actual UI attachment contains the last 20. |
| t09-15, S05-6 | Live Browser and captures share Chrome discovery: `CODEFLOW_CHROME` wins over the legacy `CODEFLOW_CHROME_PATH` alias. Obsolete Snapshot controls/producers are removed, while old snapshot context parsing and visual-comparison captures remain. Updated runs/configuration/architecture documentation and dependency guidance describe live Chrome. Own-port capture refusal names Code Flow and asks for the original app URL. |
| t09-21 | The live surface has a 200px floor, console/pins drawers shrink and scroll, and short windows can scroll the panel. At 1440×900 and the default 420px side panel, the page is 200px high and Send ends at y=890. At 1100×650 the page remains 200px and Send is reachable by scrolling. Screenshots were visually reviewed. |

Adjacent tab-return defect found during replay: Chrome could send a native-size compositor frame while the server advertised the requested panel viewport. Selection reapplies the viewport after activation; screencasting reasserts the visible surface, and old-size frames are acknowledged but not presented as ready for input. The UI replay waits for matching current-tab/current-view frames and verifies the real click after returning to the old tab.

New regressions: `test/qa-side-browser.test.ts` (five cases), `test/qa-side-browser-context.test.ts` (two cases), and `test/qa-side-browser-ui.test.ts` (five live UI cases). The only existing test expectation changed is `test/snapshot.test.ts`: its loopback refusal assertion now expects direct local-app capture guidance instead of instructions to use the removed Browser Snapshot mode.

Evidence directory: `/private/tmp/codeflow-qa-continue/work/side-browser/`.

- `related-final.log`: 32 tests pass across shared browser/desktop tools, browser UI helpers, snapshot policy/capture, Chrome discovery, dependency probes and the new focused cases.
- `transfers-final.log`: 12 upload/folder/context/ownership tests pass.
- `context-final.log`: the two context tests pass after the final attachment helper cleanup.
- `typecheck-final.log`: `tsc --noEmit` passes.
- `ui-clean-final.log`: all five fresh real-Chrome UI replays pass in 46.6s, including the original Visual Comparison settings/capture path. No UI console errors; the only API failures are the intentional dead preview (400) and Code Flow own-port refusal (403). `ui-third.log` retains the earlier five-case pass (47s).
- `ui-server.log`, `ui-observations.json`, `chrome-launches.log`, `attachment-storage.json`: server/console/API observations, actual Chrome override launches, and the sent context payload.
- Screenshots `01-preview-failure.png` through `08-short-drawers-scroll.png` cover failure recovery, annotations, tab return, reconnect/pop-out and both drawer layouts. `09-visual-comparison-guidance.png` covers the own-port refusal in the result UI.

Diagnostic history is retained: `unit-first.log` (harness needed a fresh ownership inspection after a rejected action), `related-tests.log` (one concurrent Chrome launch timeout plus the obsolete refusal assertion), `ui-first.log` (premature tab input and missing removed pop-out button in the harness), `ui-second.log` (transient annotation cleanup and viewport mismatch, plus draft-storage harness correction), `tab-diagnostic.log`/`tab-second.log`/`tab-third.log` and `viewport-debug.log`/`viewport-rapid.log` (compositor investigation), and `ui-final.log` (a Chrome navigation/frame stall during the parallel whole-branch browser suite, plus corrected fixture queue/details-open harness races). A stalled run is not counted as verification. The subsequent clean final run completed at normal durations (individual cases 2.8–11.1s), after the harness corrections, without product changes made solely to address contention.

## Issues

### t09-1 · major · A failed preview navigation keeps sending the run's Browser back to the dead URL, with bursts of hundreds of navigate requests

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-28, SIDE-30.

**Repro**

> 1. Fresh fake QA server. Register a repo whose .codeflow/config.json has run.command, and finish a fake Agent run.
> 2. Run page → More options → Preview settings → App command: node -e "require('net').createServer(s=>s.end()).listen(process.env.PORT,'127.0.0.1'); setTimeout(()=>process.exit(1),1200)" → Start preview. (Same with Next.js when it binds the port and then fails, e.g. the industriHealth clone.)
> 3. The Browser shows 'This site can't be reached'. DevTools shows 97-841 POST /api/browser in the first seconds, 14-22 of them 400 ERR_CONNECTION_REFUSED.
> 4. Start a working app (Preview settings 'node app.cjs'), type its URL in the Browser address bar and press Go, twice.
> 5. Both times the address snaps back to the dead URL (232 navigate POSTs in about 10s). Reloading code-flow does not clear it. Only a later successful Preview/Open preview does.

**Expected:** A failed navigation is reported once and marked handled. The user can then navigate anywhere.

**Actual:** The browserRequest is never marked handled. Each change of the tab URL re-runs the restore effect and navigates to the dead URL again, which hijacks the user's navigation. The state persists in localStorage sideMemory (browserRequest.id ≠ browserHandled).

**Root cause (verifier):** ui/interactive-browser.tsx:117-130, the browserRequest effect:
- Line 121: a request counts as pending whenever `request.id !== memo.browserHandled`.
- Line 129: when the navigate POST fails (server src/server.ts:1686 passes to src/agent-browser.ts:320, which throws Page.navigate's errorText, giving HTTP 400), the failure handler only does `opened.current = ""`. It never records `browserHandled`. The only place that does is the success branch at line 128.
- Line 130: the deps `[state?.selected, memo.browserRequest?.id, selected?.url]` re-run the effect whenever the selected tab's URL changes.

So after a failed preview open, every URL change re-sends `{action:"navigate", url: request.url}`. This includes the URL changes caused by the failed navigations themselves, which produces the burst, and the user's own Go/link navigation, which produces the hijack. Each new failure resets `opened.current` again, so the loop never ends.

Contributing causes:
- ui/state.ts:474 (openBrowserPage) stores browserRequest in the persisted sideMemory, so the unhandled request survives reloads. Only a new openBrowserPage call (a later successful Preview/Open preview) replaces it.
- ui/interactive-brows …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/interactive-browser.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/browser-links.e2e.ts`

**Suggested fix:** In ui/interactive-browser.tsx, treat a browserRequest as consumed once it has been attempted, whether or not it worked:
- Call `rememberSide({browserHandled:id},scope)` in both the fulfilled and rejected branches, or in a finally. Leave `opened.current = id` in place on failure instead of resetting it.
- Show one persistent, specific error, for example "Couldn't open <url>: net::ERR_CONNECTION_REFUSED. Is the preview running?". Keep it in its own state so the next successful overlay POST does not clear it.

Narrow the effect so a request runs only when it is new:
- Split request handling from restore. The request effect depends on `[state?.selected != null, memo.browserRequest?.id]`. The restore path keeps its one-time about:blank check.
- Changes to `selected?.url` must never re-issue a request navigation.

Also compare URLs normalized with `new URL(x).href` at line 126, so an existing tab is selected rather than navigated again.

Optional:
- If a retry for a briefly unready app is wa …

**Suggested regression test:** Add a test to test/e2e/browser-links.e2e.ts: "a preview link to a dead port is attempted once and does not hijack later navigation".
1. Get a free port by listening on a net server and closing it. Open that URL through the same path the tests use for openBrowserPage, for example the Preview flow of a fake run whose run.command binds the port and exits, or an explicit link in an agent answer.
2. Count POST /api/browser requests with action "navigate" to the dead URL. Assert there is exactly 1 aft …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode home, v4641a on port 4641, with the dogfood-qa source. I did not reuse the existing v4641 home or the reporter's profile.
1. Created a scratch git repo at clones/v4641-fx with app.cjs (a plain HTTP server on $PORT) and .codeflow/config.json {"run":{"command":"node app.cjs"}}. Registered it as a project with POST /api/projects (setup only). Started a run through the UI composer with "Improve the heading text on the fixture page". The fake Claude run 2610251950-3ffe89f7 finished as done with 1 artifact.
2. Script work/v4641/r1.mjs uses Playwright with a persistent profile. On the run page it opens More options, then Preview settings, sets App command to `node -e "require('net').createServer(s=>s.end()).listen(process.env.PORT,'127.0.0.1'); setTimeout(()=>process.exit(1),1200)"` and clicks Start preview.
   - Studio result: no error. The button changed to "Open preview", because /ready saw the port open.
   - Browser panel: opened at http://localhost:56129/ and showed Chrome's "This site can't be reached".
   - Requests in the first ~1.5 s: 801 POST /api/browser. 114 were navigate calls to http://localhost:56129, all 400 (net::ERR_EMPTY_RESPONSE at first, then ERR_CONNECTION_REFUSED). The other 687 were overlay hello/mode/recording/pins re-sent on each load, plus 9 resizes. No more requests from 5 s to 15 s.
   - localStorage sideMemory["run:2610251950-3ffe89f7"] = {browserRequest:{id:"1792957894196-0.258…",url:"http://localhost:56129"}, pages:[…]} with no browserHandled.
3. Started a working app myself on 127.0.0.1:4643. Typed http://127.0.0.1:4643/attempt1 in the Browser Address box and pressed Go, then did the same for attempt2.
   - Each time the navigate to 4643 returned 200. Within 0.2 s the panel sent 9 to 13 more navigate calls to the dead URL, all 400.
   - The address showed http://localhost:56129/ for the whole 5 s and the page was the refused-connection error (shot shots/v4641a/002-attempt1.png). Snap-back happened 2 of 2 times.
4. r2.mjs reloaded the app in the same profile and reopened the run's Browser.
   - It navigated to the dead URL immediately.
   - Two more Go attempts to 4643 both snapped back, with about 150 navigate POSTs in each 5 s window.
   - sideMemory was unchanged, so the problem persists across reloads.

How I tried to refute it:
- No docs or code comments describe retrying or sticky preview navigation. The only related code is the `opened.current = ""` failure branch.
- It does not depend on the tester …

</details>

### t09-3 · major · Pick/Box stays pressed after a page reload, navigation or send, but clicks go through to the app

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-20.

**Repro**

> 1. Preview an app in the side panel Browser and click Pick (pressed).
> 2. Click Reload in the browser toolbar, or navigate with the address bar.
> 3. Click a button in the page (the fixture's 'Count').
> Also: Pick an element, then press 'Add to chat'; Pick stays pressed.

**Expected:** Pick mode is re-armed on the new document, or the button shows off; a click while Pick is shown creates a pin.

**Actual:** In 4 of 4 trials the click performed the real action (Count went 0→1) and no pin was created. Pick still showed pressed in 3 of 4 (shots/t09f/001-pick-after-reload.png). After a send the button stays pressed while the overlay is off.

**Root cause (verifier):** How the panel and the overlay talk:
- The Pick/Box mode lives only in LiveBrowserTools' local state (ui/browser.tsx:104 `const [mode,setMode]=useState(...)`).
- The page overlay is injected into every new document by src/agent-browser.ts:246 (addScriptToEvaluateOnNewDocument). Each new document starts with `let mode = "off"` (src/preview-overlay.js:241) and `recording = false` (:148), then posts "ready" with a new `document` id (:375).

There are four failure points:
1. **Reload/navigation, ui/browser.tsx:96.** receiveBrowserOverlay handles "ready" by setting `ready:true` and the new `document`. `ready` is already true, so nothing changes for the effect below.
2. **The effect that pushes mode, ui/browser.tsx:115.** `useEffect(()=>{if(state.ready){send({type:"mode",mode}); send({type:"recording",...})}},[mode,state.ready,recording.value?.active])` does not depend on `state.document`. It never re-sends the mode (or the recording flag) to the new document's overlay. The button still shows "pick" while the page overlay is "off", so clicks reach the app. In my runs the tools sometimes remount on reload instead, which resets the button to off; that explains the reporter's "pressed in 3 o …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/browser.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/browser.test.ts`

**Suggested fix:** Keep one source of truth for the annotation mode per page:

1. Move `mode` into the shared per-page state: add `mode?: "off"|"pick"|"box"` to PageState in the `pages` signal. LiveBrowserTools then reads `state.mode ?? "off"`. changeMode does setPage(...mode) plus the send, so the existing "enqueue before a fast click" behaviour is kept.
2. Changes in receiveBrowserOverlay:
   - Handle `m.type === "mode"` (the Escape message from the overlay) by setting `p.mode = m.mode`.
   - On "ready" with a new `document`, either keep `p.mode` so the effect re-arms it (preferred: the user's Pick survives a reload), or reset it to "off". Either way the button and the overlay agree.
3. Add `state.document` to the deps of the effect at browser.tsx:115, so mode and recording are re-sent to every new document's overlay. This also re-sends `recording`, which has the same gap.
4. PinsTray onSent (browser.tsx:126): set `mode` to "off" in the page state (setPage) instead of only messaging the overlay.
5. Opt …

**Suggested regression test:** **Browser test, test/e2e/ui.e2e.ts (Pick/Box section around lines 787-830):**
1. After the first "Add to chat", assert `side.getByRole("button",{name:"Pick",exact:true})` has aria-pressed "false".
2. Click Pick, click the panel's Reload button (aria-label "Reload"), and wait for ready().
3. Then assert one of: Pick shows aria-pressed="false", or clicking the theme toggle on the surface creates a `.pins-tray .pin-row` and no extra app request is made. A served-app endpoint can count real clicks t …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4645 on 127.0.0.1:4645. I used my own fixture app on 127.0.0.1:4647: a "Count" button whose click also calls fetch('/hit'), so the fixture server counts real clicks independently of the UI. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4645/ (a3, a4, a5, a6, a7 .mjs, logs next to them). Each script opens the side panel Browser, enters the fixture address, and clicks through the canvas at real page coordinates.

- Control (a3.log), Pick on, same document: clicking Count made a pin (0->1) and no real click (hits 0->0). So the harness works.
- After Reload or address-bar navigation (a3.log, project scope), 4 of 4 trials: the click went through to the app (hits +1 each time) and no pin was made. Pick showed aria-pressed=true in 3 of 4. Screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4645/001-after-reload-click.png shows Pick pressed, Count: 1, no pin.
- Box mode after Reload (a7.log, run scope): Box stayed pressed in trial 1 and the drag clicked Count with no pin. In trials 2-4 the tools remounted and Box showed off.
- After send (a5r.log, run scope, fake solo run): Pick, then click the title, gave 1 pin. Then "Add to chat": the pin card went into the run's chat draft, the tools did NOT remount, and Pick stayed aria-pressed=true. Clicking Count then gave a real click (hits 4->5) and no pin (002-after-send-click.png). One click on Pick only turns it "off", so the user needs two clicks to re-arm.
- Extra (a6.log): pressing Escape in the page while Pick is on turns the overlay off, but Pick stays pressed. The next click on Count went through (hits 6->7, pins unchanged).

Not by design: docs/runs.md:100 describes Pick/Box and pins surviving reloads, but nothing about the mode silently dropping. No test covers this. test/e2e/ui.e2e.ts:787-830 does a full UI page.reload() between Pick and Box, which hides the bug. Not environmental: deterministic, reproduced from a fresh home and fixture, with clicks counted by the fixture server.

Cleanup: the run was deleted through the sidebar "Run actions" > Delete. Its worktree and branch in my scratch fixture repo were still there after that, so I removed the whole scratch repo. QA server v4645 and the fixture on 4647 are stopped, and ports 4645-4647 are free.

</details>

### t08-9 · minor · Agent browser click right after navigate fails with a stale ref while the panel is watched; same-operationId retry is refused as 'uncertain'

Source: tester unit side-panel-previews-1; observed with real-agents; features SIDE-17.

**Repro**

> 1. Real Claude (Haiku) run, task: browser_navigate to http://127.0.0.1:18308/index.html, then browser_click 'Go to page 2' (and more steps).
> 2. Keep the run's side panel Browser tab open.
> 3. Read the run log.

**Expected:** Refs from browser_navigate's snapshot stay valid for the next click. A retry with the same operationId after a pre-action validation error is allowed, since the tool description says to keep IDs stable across retries.

**Actual:** The click with ref e1-4 got 'Unknown or stale element ref; take a fresh browser_snapshot'. After a fresh snapshot, the click with the same operationId got 'This action's outcome is uncertain. Do not retry it blindly…' and nothing happened. The agent needed a new operationId: 3 attempts and about 8s to click one link.

**Root cause (verifier):** Two separate defects.

1. **A viewer resize clears the agent's refs.**
   - src/agent-browser.ts:109: `changed()` does three things at once: `this.refs.clear(); this.frame = undefined; this.view++`.
   - The UI "resize" handler (src/agent-browser.ts:446-452) calls it at line 449 whenever the panel's surface size changes.
   - ui/interactive-browser.tsx:100-112 sends that resize from a ResizeObserver with a 100ms debounce. The surface shrinks when LiveBrowserTools and JourneyRecorder (ui/interactive-browser.tsx:177, ui/browser.tsx:103-122) first mount for an http(s) URL. It also shrinks or grows on any window or side-panel resize, or a Fit panel/Tablet/Phone change.
   - The resize is only a viewer and coordinate change. CDP backendNodeIds survive Emulation.setDeviceMetricsOverride, and browser_click re-measures at click time (lines 331, 337-338: DOM.scrollIntoViewIfNeeded and DOM.getBoxModel). Clearing refs is therefore unnecessary.
   - It also contradicts the browser_snapshot tool description (src/agent-tools.ts:21): "Refs are valid until the next snapshot or navigation."
   - So an agent's ref from a navigate or snapshot goes stale whenever someone is watching the panel and its  …

**Files:** `src/agent-browser.ts`, `src/agent-tools.ts`, `test/agent-tools.test.ts`, `ui/interactive-browser.tsx`

**Suggested fix:** 1. **Keep refs on resize** (src/agent-browser.ts).
   - Split `changed()` into `viewChanged() { this.frame = undefined; this.view++; }` and `changed() { this.refs.clear(); this.viewChanged(); }`.
   - Use `viewChanged()` in the UI resize branch (line 449).
   - Navigation, reload, back/forward, tab select and main-frame frameNavigated keep calling `changed()`. User mouse/key input keeps clearing refs (line 456).
   - The view++ still rejects stale viewer input, as the existing test expects.

2. **Do not burn an operationId when nothing happened** (src/agent-browser.ts and src/agent-tools.ts).
   - Export `class ActionNotPerformed extends Error {}` from agent-browser.ts and throw it for failures before any dispatch: the stale or unknown ref at line 330, and the similar pre-dispatch checks (unknown tab :233/:271, URL validation :317-318, unsupported key :345, upload input checks :303/:306/:381/:386-387, download not running :295).
   - In agent-tools.ts:154, record `error instanceof Acti …

**Suggested regression test:** Add two Chrome-gated tests to test/agent-tools.test.ts. Working versions are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4685/test/agent-ref-stability.test.ts; both fail on current main and pass with the fix.

1. **"a viewer resize keeps the agent's element refs valid but still rejects stale viewer input"**
   - Setup: `new AgentBrowser`, `watch(() => {})`, then browser_navigate to a local fixture with a "Go to p …

<details><summary>Verifier's independent reproduction</summary>

Fresh QA server v4685, fake mode, port 4685. The home only had deletion tombstones from an earlier session. I exported FAKE_SLEEP_MS=600000, FAKE_SLEEP_VENDOR=claude and FAKE_RECORD_DIR=<work>/rec, so the fake Claude turn stays active and its CLI args are recorded. Port 4687 was already taken by another verifier's server (homes/v4687), so I served a minimal fixture (index.html with a "Go to page 2" link, page2.html, no console errors) on 127.0.0.1:18685.

Script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4685/r1.mjs (log in r1.log next to it):
1. Through the UI, started a solo Claude Code run on MQTT-MCP, then opened the run's side panel Browser tab ("Live browser · shared with agents", about:blank).
2. Followed the recorded `--mcp-config` to the real grant (connection.json). Called the real bridge `/v1/agent-tools` as the agent, pausing 1.5s between calls to mimic model latency.

Results:
- **A (first http page, panel watched):**
  - browser_navigate (op v-nav-1) returned refs [e1-3: Go to page 2].
  - In the same instant the UI posted `{"action":"resize","width":419,"height":544}`. Height went 638 to 544 (94px) because the Pick/Box/Console row and the "Record a bug / Scenario details" row mounted above the surface (confirmed in screenshot shots/v4685/003-r1-A-after-stale.png).
  - browser_click e1-3 (op v-click-1) returned 400 "Unknown or stale element ref; take a fresh browser_snapshot".
  - browser_snapshot returned e2-3. browser_click e2-3 with the same op v-click-1 returned 400 "This action's outcome is uncertain. Do not retry it blindly…".
  - A new snapshot showed the page still on index.html, so nothing happened. A click with a new op id worked and reached page2.
  - action_history shows v-click-1 as "uncertain". The run's durable journal also records v-click-1 started then uncertain, although no input was ever dispatched.
- **B (control: panel watched, layout already settled):** navigate, wait 1.5s, click succeeded. No resize posts.
- **C (user resizes the window between navigate and click, via Playwright setViewportSize):** the UI posted resize height 524 and the click was stale again.
- **D (control: Browser tab not visible, no viewer):** navigate, wait 1.5s, click succeeded.

Ruled out:
- **Reporter's script:** t08/s30-real2.mjs does no canvas input before the stale click, and its takeover came 9s later.
- **Real model behaviour:** reproduced deterministically with …

</details>

### t09-9 · minor · Agent browser receipts: a stale-ref failure that did nothing is recorded as 'uncertain' and blocks retrying the same operationId

Source: tester unit side-panel-previews-2; observed with real-agents; features SIDE-GAP-01.

**Repro**

> 1. A real Claude run uses browser_type with a stale ref and operationId X; it fails with 'Unknown or stale element ref'.
> 2. As the tool description says ('keep it stable across retries'), retry with a fresh ref and the same operationId X.

**Expected:** A failure before any effect does not lock the operationId, so the retry goes ahead.

**Actual:** The retry got 'This action's outcome is uncertain. Do not retry it blindly…'. The agent had to use a new id (type-name-2), and action_history permanently lists an 'uncertain' type that never happened. Related: fingerprints leave out `ref`, so every browser_click shares one fingerprint (click-greet-1 == click-small-1) and the 'different action' guard cannot tell clicks apart.

**Root cause (verifier):** Pre-effect failures are recorded as "uncertain":
- src/agent-tools.ts:149 durably records "started" before the runtime call.
- src/agent-tools.ts:154 `catch (error) { if (effect) await record("uncertain"); throw error; }` marks ANY thrown error as uncertain. That includes validation errors raised before any DOM, Input or Page command reaches Chrome.
- src/agent-browser.ts:330 is one of these: `const backendNodeId = this.refs.get(args.ref); if (!backendNodeId) throw new Error("Unknown or stale element ref…")` throws before scrollIntoView, focus or insertText, so nothing happened. Other pre-effect throws take the same path: 233 and 271 (tab), 300-303 (ref/chooser), 317-318 (URL), 345 (key), and the AgentComputer fresh-screenshot and bounds checks.
- src/agent-tools.ts:141-143 then refuses any prior receipt whose state is not "completed". A retry with the same operationId is blocked forever, and action_history (engine.ts:3896, also replayed into recovery prompts at engine.ts:3947) permanently lists an action that never happened.

Fingerprint:
- src/agent-tools.ts:139 builds the fingerprint from the input with `ref`, `screenshot` and `chooser` removed. Dropping ref is deliberate, becau …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/agent-tools.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/agent-browser.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/agent-computer.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/agent-tools.test.ts`

**Suggested fix:** 1. Separate "not started" from "uncertain". Have AgentBrowser and AgentComputer throw a typed ActionNotStartedError (or set error.notStarted = true) for validation that runs before any CDP DOM, Input or Page command: stale or unknown ref, ref/chooser mismatch, bad URL, unknown tab, unsupported key, stale or out-of-bounds screenshot.
2. In agent-tools.ts:154, record a terminal "rejected" state for that error type (add it to the SharedToolAction.state union), or delete the started receipt. At :143, treat a "rejected" prior like no prior, so the same operationId can run and overwrite it. Keep "uncertain" for errors thrown after the first effectful command.
3. A lighter alternative for the main case: before record("started") at :149, inside the lease, check that the ref resolves (for example AgentBrowser.hasRef(ref)). If it does not, throw without recording a receipt.
4. Fingerprint: replace the dropped `ref` with a stable descriptor of the target node, resolved from the latest snapshot (f …

**Suggested regression test:** Add a test to test/agent-tools.test.ts, "a stale-ref failure does not lock its operationId and clicks are fingerprinted by target". Gate it on chromeExecutable() like the existing browser tests, or inject an AgentBrowser subclass into bridge.browsers. Steps:
- Issue a grant with an in-memory receipts store (as the existing receipts test does), then navigate to a fixture with a Name input and Greet and Other buttons. Snapshot twice.
- Call browser_type with the first (stale) ref and operationId " …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4657r9 on port 4657 (4659 was held by another verifier). Before starting it I exported FAKE_RECORD_DIR and FAKE_SLEEP_MS=300000 with FAKE_SLEEP_VENDOR=claude, so the fake Claude turn records its CLI args and then stays alive. Setup: a scratch git repo (clones/v4657r9-fixture), added through the UI with "Open another repository" → Create project; a local fixture page (Name textbox, Greet and Other buttons, and an oninput beacon that counts real input events); and a Claude chat run started from the New run composer. I read the recorded --mcp-config. Then I launched the same stdio MCP server Claude Code would launch (src/agent-tool-client.mjs --connection <file>) and acted as the agent. Script: work/v4657r9/drive2.mjs; output in drive3.log.

Run 2610252000-c4dd5c05:
- browser_navigate with id t2-nav-1 completed.
- browser_snapshot twice. Name ref e2-6 is now stale; the current ref is e3-6.
- browser_type with ref e2-6 and id t2-type-1 failed with "Unknown or stale element ref; take a fresh browser_snapshot". The page saw 0 input events.
- action_history showed t2-type-1 browser_type state "uncertain". This receipt is persisted in runs/<id>.jsonl and in the journal (first "started", then "uncertain").
- A fresh browser_snapshot gave e4-6. browser_type with e4-6 and the SAME id t2-type-1 returned "This action's outcome is uncertain. Do not retry it blindly…". Still 0 input events, and the field had no value.
- The same type with a NEW id t2-type-2 succeeded. Input events went up, and Greet then showed "Hello Claude QA".
- Control: the same id t2-type-2 with different text gave "different action", so text is part of the fingerprint.
- Fingerprint sub-claim: browser_click Greet with id t2-click-1 completed. After a fresh snapshot, browser_click on the OTHER button with the same id t2-click-1 returned "Action t2-click-1 already completed; it was not repeated". Other was never clicked: the output stayed "Hello Claude QA". Every browser_click receipt has the same fingerprint (d45946265305…, identical across both of my runs), and t2-type-1 and t2-type-2 share one too (6e3c88d8…).

Things I ruled out:
- Not caused by the tester's script: it reproduces deterministically, independent of the real agent.
- Not explained by the docs: docs/plans/agent-mode-validation.md:217 only says an uncertain outcome needs inspection. Here the agent did inspect (a fresh snapshot) and the same id was still refused. That contradicts the tool descrip …

</details>

### t08-11 · minor · Every Browser tab switch logs two 400 'The browser tab changed' errors

Source: tester unit side-panel-previews-1; observed with fake-agents; features SIDE-16.

**Repro**

> 1. Side panel Browser with 2+ tabs open.
> 2. Click another tab in the strip and watch the network/console.

**Expected:** No failing requests when switching tabs.

**Actual:** Two POST /api/browser 400 {error:'The browser tab changed'} for the overlay commands {mode:off} and {recording:false} sent to the old tab, which show up as console errors.

**Root cause (verifier):** - ui/interactive-browser.tsx:177 renders `<LiveBrowserTools key={selected.id} ... send={message=>send({action:"overlay",tab:selected.id,message})}/>`. The `tab` id is fixed at render time, and the component is keyed by tab, so a tab switch unmounts the old instance.
- ui/browser.tsx:113 is that instance's useEffect cleanup: `return()=>{command({type:"mode",mode:"off"});command({type:"recording",active:false});...}`. It runs only after the SSE state event for the new selection has re-rendered the panel. By then the server has already switched tabs, because src/agent-browser.ts:228-252 `select()` sets `this.target = targetId` (line 240).
- src/agent-browser.ts:434 `if (args.tab !== this.target) throw new Error("The browser tab changed");` therefore rejects both cleanup commands with 400 every time, so the cleanup never takes effect.
- ui/interactive-browser.tsx:50 `send` calls setError() on any failure, which flashes the red role="alert" banner (line 176) until the next successful request clears it.
- The cleanup was meant to switch off Pick/Box mode and journey recording in the old page's overlay (src/preview-overlay.js setMode/recording, about lines 315 and 377). `select()` detache …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/browser.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/interactive-browser.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/agent-browser.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/shared-browser.e2e.ts`

**Suggested fix:** 1) Server (fixes the stuck Pick/recording mode no matter who switches tabs, user or agent): in src/agent-browser.ts `select()`, before detaching the old `this.session`, run `window.__codeflowCommand?.({type:"mode",mode:"off"})` and `{type:"recording",active:false}` in the old target's annotation world. Use the same createIsolatedWorld + Runtime.evaluate as the overlay action, best-effort with `.catch(()=>{})`.

2) Client (removes the noise):
- ui/browser.tsx:113 should not send the reset commands when its tab is no longer the selected one, since the server now resets on select. For example, give LiveBrowserTools an `isCurrent()` / `selectedRef` from InteractiveBrowser and send the cleanup only when `isCurrent()` is still true, which is the unmount-because-the-URL-became-non-http case.
- Alternatively, make the server treat an idempotent reset (`mode:"off"` or `recording:false`) addressed to a non-current tab as a no-op `{ok:true}`, and keep the 400 for every other overlay command.

3)  …

**Suggested regression test:** Extend test/e2e/shared-browser.e2e.ts, around the existing "New browser tab" / "Close New tab" steps:
- Record every `POST /api/browser` response with page.on("response").
- Press Pick on the fixture tab.
- Click "New browser tab", switch back and forth through the "Open pages" strip, and close the new tab.
- Assert that no response had status 400 with error "The browser tab changed".
- Assert that `#side-pane-browser [role=alert]` never contained that text (MutationObserver collector).

Then ch …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4689 on 127.0.0.1:4689, with a fresh Playwright profile (no reused cookies or localStorage). Static site from python http.server on 127.0.0.1:4691 serving a.html, b.html and btn.html (a button that sets document.title to "Btn N"). Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4689/ (r1.mjs, r2.mjs, r3.mjs), with logs next to them.

1) r1.mjs (the reported symptom): opened the side panel, then the Browser tab, navigated to a.html, clicked "New browser tab", navigated to b.html, then clicked tabs in the "Open pages" strip.
- Every real switch (2 of 2), every "New browser tab" click and every switch to a blank tab produced exactly two `POST /api/browser 400 {"error":"The browser tab changed"}`. The bodies were `{action:"overlay",tab:<PREVIOUS tab id>,message:{type:"mode",mode:"off"}}` and `{...message:{type:"recording",active:false}}`.
- Each 400 also showed up as a Chrome console error: "Failed to load resource: the server responded with a status of 400".
- The next requests (hello, mode, recording, pins for the new tab) all returned 200.
- The server log (server.out) does not record these 400s. The "s05c log" the reporter cites was their own script's log.

2) r2.mjs: a MutationObserver on `#side-pane-browser .msg.err` caught the red role="alert" banner showing "The browser tab changed" on every switch. It disappears within a few to about 100 ms, when the next successful request clears it, so a screen reader can announce it each time.

3) Side effect, r3.mjs:
- Pressed Pick on tab A (btn.html), so Pick showed aria-pressed=true.
- Opened a new tab B. The cleanup `mode:off` for A was rejected with 400.
- Switched the side panel to Files, so the Browser pane was hidden.
- As an agent would, selected A through the API (`tabs select`) and sent a mouse press and release on its button.
- Result: the title stayed "Btn 0", so the click was swallowed by A's overlay, which was still in Pick mode. This happened 2 of 2 times.
- Control without Pick, same steps: the title became "Btn 1".
- If you go back to A through the strip while the pane is visible, it recovers, because the remounted LiveBrowserTools sends `mode:off` again (r2.mjs: the click works afterwards).

Why I could not refute it:
- Nothing in docs/*.md or the code comments says these overlay commands are expected to fail.
- The tester's environment is not the cause: it reproduces with a fresh  …

</details>

### t09-13 · minor · Browser console drawer loses its history when the UI reloads, but says 'since the page opened'

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-21.

**Repro**

> 1. Open a page that logs errors in the Browser.
> 2. Reload code-flow (or open the run in a popped-out window).
> 3. Open Console.

**Expected:** The page's errors so far, or wording such as 'since you opened this panel'.

**Actual:** 'Nothing yet.' and no count until the page logs again.

**Root cause (verifier):** Console lines are pushed to whoever is watching at that moment, and the only copy is kept in the UI's memory.

- src/agent-browser.ts:151-155: Runtime.consoleAPICalled events and Network.responseReceived events with status >= 400 become {type:"overlay",message:{type:"console"}} events and go through emit().
- src/agent-browser.ts:103: emit() only calls the current viewers (`for (const viewer of this.viewers) viewer(event)`). Nothing is stored per tab.
- src/agent-browser.ts:89-95: watch() replays only the last screencast frame (`if (this.frame) listener(this.frame)`) to a new viewer, never earlier console lines.
- src/server.ts:1675-1681: the /api/browser/events route adds no replay of its own.
- ui/browser.tsx:69: the lines are stored only in the module-level `pages` signal. receiveBrowserOverlay adds to it at ui/browser.tsx:99.
- ui/interactive-browser.tsx:58-60: the EventSource is open only while the side panel is open on the Browser tab (`visible`), and is closed otherwise.

So a code-flow reload, a popped-out window (a new document with an empty signal) or a second device starts with an empty list. Anything logged while the Browser tab is hidden or the panel is closed is dropp …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/agent-browser.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/browser.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/interactive-browser.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** Make the server the source of truth.

1. In AgentBrowser, keep a capped ring buffer of console lines per Chrome target, for example `Map<targetId, ConsoleLine[]>` capped at 300 lines to match the UI. Fill it at agent-browser.ts:151-155 whether or not anyone is watching.
2. Decide on a reset point and say it in the UI. Either reset when Page.frameNavigated fires on the top frame, which makes "since the page opened" true, or never reset and change the wording.
3. Remove a target's buffer when the target is destroyed.
4. In watch(), after sending the frame, send one {type:"overlay",tab,message:{type:"console-history",lines}} per open tab. Alternatively, let `browser_ui {action:"watch"}` return the history with the state.
5. In ui/browser.tsx, receiveBrowserOverlay should handle "console-history" by replacing p.console for that page key instead of appending, so re-subscribing doesn't duplicate lines.
6. Make Clear also tell the server to clear, for example a browser_ui action "console-clea …

**Suggested regression test:** Two tests.

1. test/agent-tools.test.ts, or a new test/browser-console.test.ts, using the existing AgentBrowser and chromeExecutable pattern (skipped without Chrome). Navigate an AgentBrowser to a data:/http fixture that runs console.error("boom") and fetches a 404, with no viewer attached. Then call browser.watch(listener). Assert that the listener receives console lines containing "boom" and a "404" network line for the selected tab within a few seconds. Then detach, log again through Runtime. …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4665, on 127.0.0.1:4665. I also ran my own fixture app on 127.0.0.1:4667. On load it logs console.error "boot error A", console.warn "boot warning B" and a fetch to a missing path (404). 8 s after load it logs console.error "late error C", and a button logs "clicked error D". It also counts its document loads at /loads.

Script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4665/t0913a.mjs (log in t0913a.log next to it):
1. Opened the side panel and the Browser tab, entered http://127.0.0.1:4667/ and pressed Go.
2. The button read "Console · 2" at 2 s and "Console · 3" at 10 s. The drawer listed A, B, the 404 and C under "errors, warnings and failed requests since the page opened".
3. I ran page.reload() on code-flow itself and opened Browser again. The Chrome tab id was the same (D39B…C07C), the fixture's load count stayed at 2 and the page still showed "document load #2", so the page had not reloaded.
4. The button now read "Console" with no count. Opening it showed the same "since the page opened" help text and "Nothing yet." (screenshots /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4665/001-t0913-before-reload.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4665/002-t0913-after-reload.png).
5. Clicking "Log an error" in the live page gave "Console · 1" with only "clicked error D".

Script t0913b.mjs reproduced it a second time: a new script means a fresh UI on a page that had already logged errors, and the button read "Console". It also found a wider variant with no reload at all. I reloaded the page with Browser's Reload button, and at 2.5 s the button read "Console · 2". I then switched the side panel to the Chat tab until 12 s and came back. Late error C, logged while the Browser tab was hidden, never appeared: the count stayed at 2 and the drawer listed only A, B and the 404. The visible-tab control run in t0913a did show C.

No console or page errors and no 5xx responses were collected. The environment is not the cause: I used my own fixture and a persistent profile, and the page and Chrome tab were provably the same before and after.

It is not by design. docs/runs.md:101 says only "Console lists the page's errors, failed requests and files that didn't load", with no cavea …

</details>

### t09-14 · minor · 'with 300 console errors' attaches only the last 20

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-20, SIDE-21.

**Repro**

> 1. Open a page with more than 20 console errors and pick an element.
> 2. The tray shows 'with 300 console errors'; tick it and send.

**Expected:** The label matches what is attached.

**Actual:** The message holds 20 'noise line' entries (330-349).

**Root cause (verifier):** The label and the message count different lists:
- ui/browser.tsx:235 (pinsMessage) builds the errors to send with `console.filter(c => c.level !== "warn").slice(-20)`, so only the last 20 are sent.
- ui/browser.tsx:258 (PinsTray) defines `const errors = state.console.filter((c) => c.level !== "warn")` with no cap, and ui/browser.tsx:358 renders `with {errors.length} console error(s)`.
The label therefore shows the full count (up to 300) while at most 20 are attached. The dropped lines are the earliest ones, which are often the root cause of a cascade, and nothing in the UI or the message says lines were left out.
A second, related undercount: ui/browser.tsx:99 caps the stored console at 300 (`p.console.slice(-299)`), so a page with 350 errors shows "Console · 300" and "with 300 console errors". The drawer header (browser.tsx:181) says "since the page opened", but lines 0 to 49 are gone.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/browser.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/browser-context.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/browser.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** 1. Use one source of truth. In ui/browser.tsx, export `const PIN_CONSOLE_LIMIT = 20` and a helper `pinConsole(lines)` that returns `{ sent: string[]; total: number }`. Call it from both pinsMessage (line 235) and PinsTray (lines 258 and 358), so the label and the message can't drift apart.
2. Make the label honest: `with ${n} console error(s)` when n <= 20, and `with the last 20 of ${n} console errors` (or "with 20 of N …") when n > 20. When the 300 store cap at line 99 has dropped lines (keep a `dropped` counter in PageState), show "300+".
3. Optional, better for the agent: keep the first few errors as well as the last ones (for example first 5 + last 15). Add `consoleOmitted: n` to BrowserContext (ui/browser-context.ts) so the agent and the Page details card both show that lines were left out.
4. Update docs/runs.md:101 to say how many console lines go with the pins.

**Suggested regression test:** Unit test in test/browser.test.ts (the existing esbuild-bundled `browser` module):
- Build 25 ConsoleLine entries ({level:"error", text:`noise line ${i}`}) and call `browser.pinsMessage([pin], lines, 1)`.
- Parse the result with parseBrowserMessage and assert that `contexts[0].console.length` equals the count the exported label helper reports, and that the label text is "with the last 20 of 25 console errors".
- If first+last is adopted, also assert that "noise line 0" is kept and that consoleOm …

<details><summary>Verifier's independent reproduction</summary>

Started a fresh fake-mode server (home name v4667t0914) on port 4669. Port 4667 was held by another verifier's fixture (v4665's node fixture.mjs), so I left it alone. My fixture app ran on an OS-assigned port, 127.0.0.1:63373. Its /noisy page logs console.error("noise line 0".."noise line 349"), 350 errors, 1.5s after load; its /few page logs 25. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4667/t0914/r1.mjs (r2.mjs runs the /few case), using a fresh browser with no profile. Steps: open project MQTT-MCP, open the side panel, go to Browser, type the address and press Go, wait, click Pick and pick the h1, type a comment, tick the tray checkbox, click "Add to a new run", then open the pin card's "Page details" in the composer and parse its JSON.
Results (logs r1.log and r2.log in the same folder):
- /noisy: the button reads "Console · 300" and the drawer has 300 lines (noise line 50 to 349). The tray checkbox reads "with 300 console errors". The attached context.console has 20 entries, "noise line 330" to "noise line 349".
- /few: "Console · 25", tray "with 25 console errors", attached 20 entries, "noise line 5" to "noise line 24". The first 5 errors are dropped without notice even below the 300 cap.
Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4667t0914/001-tray-noisy.png (checkbox ticked, "with 300 console errors") and 002-details-noisy.png (Page details JSON). No console errors or 5xx responses during the run. Reproduced 2 times out of 2 trials.
Not a tester artifact: it happens with a fresh browser profile and a fresh home, from the project page into the composer, as well as the tester's run into a side chat. Not by design either: docs/runs.md:101 says only that console errors "can go with the pins", with no cap mentioned, and no code comment explains the 20 cap or the label.

</details>

### t09-15 · minor · Docs and error messages describe a Browser 'Snapshot' mode that no longer exists; Chrome path env vars differ

Source: tester unit side-panel-previews-2; observed with code-reading; features SIDE-20, SIDE-32.

**Repro**

> 1. Read docs/runs.md:105 (Snapshot, Whole page, Retake, Live page, Draw).
> 2. Open the side panel Browser: there is no Snapshot control.
> 3. In 'Show me what changed', set Original app URL to http://127.0.0.1:<code-flow port>.

**Expected:** Docs and messages match the UI. One documented Chrome override.

**Actual:** No Snapshot UI. The snapshot refusal says 'open its http://localhost address in the Browser tab: it shows local apps through the preview, and Snapshot works there.' docs/configuration.md:121 says CODEFLOW_CHROME controls the Browser, but the live Browser reads the undocumented CODEFLOW_CHROME_PATH.

**Root cause (verifier):** Commit 29628ea replaced the side panel Browser (iframe preview plus headless Snapshot mode) with a live, agent-shared Chrome driven over CDP (ui/interactive-browser.tsx, src/agent-browser.ts). Docs, messages and the Chrome lookup were not brought along:
- docs/runs.md:105 still documents Snapshot, Whole page, Retake, Live page and Draw. docs/runs.md:104 also still describes the old Browser: Phone/Tablet/Full buttons, Compare, the "↗" new-tab button, and local apps "shown through a preview on a port of its own" in a frame. The live UI has a Fit panel/Tablet/Phone select, no Compare, and loads localhost directly in Chrome.
- docs/architecture.md:61 still calls src/snapshot.ts "the Browser's Snapshot".
- src/snapshot.ts:140: the LOCAL_APPS text ("open its http://localhost address in the Browser tab: it shows local apps through the preview, and Snapshot works there") is stale, and it is appended to every loopback refusal at src/snapshot.ts:224. That includes the code-flow-own-port refusal from src/server.ts:2321-2325 (localApp excludes PORT/REMOTE_PORT), which ui/experience.tsx:131 (VisualComparison) shows to users. The comment at src/server.ts:2318 ("Snapshot mode") is stale too.
- Tw …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/configuration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/architecture.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/dependency-discovery.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/snapshot.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/agent-browser.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/dependency-health.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/browser.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/security-review.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/snapshot.test.ts`

**Suggested fix:** 1. Use one Chrome lookup. Make src/agent-browser.ts chromeExecutable() delegate to findChrome() from src/snapshot.ts. findChrome reads CODEFLOW_CHROME first; accept CODEFLOW_CHROME_PATH as a deprecated alias (CODEFLOW_CHROME wins, log a one-time warning when only the alias is set). That gives both paths the same list, including Chromium/Brave and the PATH search. Change the error at agent-browser.ts:197 to name CODEFLOW_CHROME. Rename the dependency-health entry so it covers "Browser and snapshots".
2. Rewrite the stale messages. Replace LOCAL_APPS (src/snapshot.ts:140) and make the refusal depend on the case. For code-flow's own port: "<host> is Code Flow itself, which can't be captured. Enter the address of the original app (for example http://localhost:3000)." For other loopback/link-local addresses: say that only a running local app at http://localhost:<port> can be captured. Drop the mention of the Browser tab and Snapshot. Update the comment at src/server.ts:2318.
3. Update the d …

**Suggested regression test:** 1. In test/snapshot.test.ts (or a new test/chrome-path.test.ts), with CODEFLOW_CHROME pointing at a temp executable file and CODEFLOW_CHROME_PATH unset, assert that agent-browser's chromeExecutable() returns that path, and that both variables set resolves to CODEFLOW_CHROME. Also assert chromeExecutable() === findChrome() for the same env.
2. In test/security-review.test.ts:262-265, replace the assertion on the old text. A snapshot of code-flow's own port must return 403 with a message that does …

<details><summary>Verifier's independent reproduction</summary>

Port 4669 was already in use by another verifier's server (home v4667t0914), so I left it alone and used my extra port, 4671. I made two logging Chrome wrappers at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4669/wrap-CHROME.sh and wrap-CHROME_PATH.sh. Each one logs which env var launched it, then runs the real Chrome. I exported CODEFLOW_CHROME=wrap-CHROME.sh and CODEFLOW_CHROME_PATH=wrap-CHROME_PATH.sh and started a fresh fake-mode server: qa-server.sh start v4669t0915 4671 fake. The setup step was one fake solo run on a scratch static-site git repo, created through the API. The script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4669/t0915.mjs (log in t0915.log) then did the rest through the UI.

(1) I opened the run, then Side panel > Browser, typed a local fixture address and clicked Go. The page rendered in the live Chrome canvas. The panel's controls were: ←, →, Reload, Go, Take control, a viewport select (Fit panel/Tablet/Phone), Downloads, Pick, Box, Console, Record a bug, Scenario details. There were 0 buttons named Snapshot, Whole page, Retake, Live page, Draw, Compare or Full, and the text "Snapshot" appeared 0 times (screenshot shots/v4669t0915/001-browser-panel.png). The wrapper log shows the Browser panel's Chrome came from the CODEFLOW_CHROME_PATH wrapper. It ignored CODEFLOW_CHROME, which docs/configuration.md:121 says controls the Browser.

(2) In the run's result card I opened More options > Preview settings, set the App command to `python3 -m http.server $PORT --bind 127.0.0.1`, clicked Start preview (it started on http://localhost:65138), then opened "Show me what changed". I set Original app URL to http://127.0.0.1:4671 and clicked Capture comparison. The Result image was captured, and the alert read: "127.0.0.1:4671 is this computer, and snapshots don't open those. For an app running here, open its http://localhost address in the Browser tab: it shows local apps through the preview, and Snapshot works there." (shots/v4669t0915/002-visual-comparison-refusal.png). That capture's Chrome came from the CODEFLOW_CHROME wrapper. So one server used two different env vars for two Chrome launches.

The message is wrong twice. The Browser tab has no Snapshot and no longer shows local apps through the preview proxy: it loaded http://localhost:65138 directly. And snapshots do open local apps: …

</details>

### S05-6 · cosmetic · Snapshot-mode remnants (PageState.snap, annotatedSnap, snapshot-sourced pins) are unreachable since the side-panel Snapshot mode was removed in 29628ea; state.snap is never set.

Source: code-level suspect at `ui/browser.tsx:272` (confirmed hands-on).

**Repro**

> Code: grep shows no writer of PageState.snap and no producer of pin.source='snapshot'. `git show 29628ea -- ui/browser.tsx` shows the removed Snapshot setters and buttons. UI on fake-mode s05: side panel → Browser → http://127.0.0.1:4523/ (a local static page). The toolbar offers only Pick, Box, Console, Record a bug, Take control. getByRole('button', /snapshot/i) and /Whole page|Retake|Live page/ both match 0 elements, contrary to docs/runs.md:105. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s05/001-side-browser.png

**Expected:** The removed feature leaves no dead state or code paths, and the docs no longer advertise it.

**Actual:** Dead code remains in ui/browser.tsx, and the user docs still describe a Snapshot mode with Whole page, Retake and Live page controls that does not exist.

**Root cause (verifier):** Commit 29628ea removed the Snapshot UI and every write of `snap` (setPage(... snap: …)), but left behind: the Snap interface, PageState.snap, loadImage/annotatedSnap, the `boxes`/`whole`/`onSnap` branch in the pins tray send (lines 270-273), and pinsMessage's onSnap/snapshotPage parameter. The only pin producer (src/preview-overlay.js, also injected by agent-browser) never sets source:'snapshot', and no setPage writes snap. Those branches cannot run. The user-visible part is stale docs: docs/runs.md:105 still describes a side-panel **Snapshot** (Whole page, Retake, Live page, draw boxes), and docs/configuration.md:121 says CODEFLOW_CHROME is 'the Chrome … the side panel Browser's Snapshot runs headless'. Note that /api/snapshot and src/snapshot.ts are still used by experience.tsx visual capture, and browser-context.ts keeps source:'snapshot' parsing for older saved messages; both are legitimate and should stay.

**Suggested fix:** Delete Snap, PageState.snap, loadImage, annotatedSnap, the boxes/whole/onSnap branch and the onSnap parameter of pinsMessage, plus the matching dead filters such as livePins' source check, if no other producer exists. Keep the back-compat parsing in browser-context.ts. Rewrite docs/runs.md:105, configuration.md:121 (CODEFLOW_CHROME now serves the visual-comparison capture) and architecture.md:61 accordingly.

**Suggested regression test:** Add a docs/UI consistency check, or extend test/e2e/browser-links, asserting that the side-panel Browser toolbar controls match those named in docs/runs.md (no 'Retake'/'Whole page'). Run an unused-code check (tsc noUnusedLocals or knip) in CI to catch orphaned helpers like annotatedSnap.

### t09-21 · minor · Opening the console drawer and the Adjust panel squeezes the live page to a tiny strip at 1440×900

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-20, SIDE-21.

**Repro**

> Default side panel width; open Console; Pick an element and click Adjust.

**Expected:** The live page stays usable, or the drawers scroll.

**Actual:** The canvas shrinks to about 100px high and the page is scaled down (shots/t09f/002-pick-adjust.png).

**Root cause (verifier):** The two drawers' max-heights plus the fixed rows add up to more than the column, and the only element allowed to shrink is the live page.

- ui/styles.css:535 `.browse-console { flex: none; max-height: 34%; ... }` and ui/styles.css:548 `.pins-tray { flex: none; max-height: 45%; ... }` are percentages of .interactive-browser (ui/styles.css:445, `flex-direction: column`).
- The fixed rows above them (ui/interactive-browser.tsx:164-177: Strip, address form, toolbar, BrowserTransfers, LiveBrowserTools' annotation tools and JourneyRecorder) already use about 269px of 813px, or 33%.
- 33% + 34% + 45% = 112%. Neither drawer can shrink (`flex: none`). The only flexible child is `.live-browser-surface { flex: 1; min-height: 0 }` (ui/styles.css:452), so it absorbs the whole shortfall and goes down to 108px, or 0px when the console has lines. The column then overflows past the viewport, and body has overflow:hidden.
- The page is also drawn scaled down: ui/interactive-browser.tsx:107 clamps the remote viewport to `Math.max(200, box.height)`, so a surface under 200px shows a 200px-high frame letterboxed at 0.54x.
- The Adjust panel is tall because of ui/styles.css:563 `.adjust { grid-template- …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/interactive-browser.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** 1. Give the live page a floor that matches the 200px viewport clamp, and let the drawers give up height instead of the page:
   - `.live-browser-surface { min-height: 200px }` (or about 30% of the column).
   - Make both drawers shrinkable rather than `flex: none`: `.browse-console { flex: 0 1 auto; min-height: 38px }` (the head row stays) and `.pins-tray { flex: 0 1 auto; min-height: <one pin row + .pins-actions> }`.
   - Their inner lists (.bc-lines, .pins-list) already scroll with overflow:auto.
   - Also lower the caps so they fit together with the roughly 270px of fixed rows, e.g. console 25% and tray 35%, or cap them in px/clamp().
2. Add a fallback: `.interactive-browser { overflow-y: auto }`, or keep .pins-actions outside the shrinking area, so the send row ("Add to chat" / "Add to a new run") can never be pushed below the viewport.
3. Make Adjust compact at the default width. Either let `.adjust` span the full pin row (`grid-column: 2 / -1`, or move it out of .pin-main), or us …

**Suggested regression test:** Extend the Pick test in test/e2e/ui.e2e.ts (around lines 781-795). It already waits for "Console · 2" and picks the theme toggle.

At a 1440x900 viewport, after the pin row appears:
1. Click the Console toggle, then the pin's "Adjust" button.
2. Assert `(await surface.boundingBox()).height >= 200`, i.e. the live page keeps at least the 200px frame floor and the canvas is not drawn at a scale below 1.
3. Assert the "Add to chat" button's bounding box is fully inside the viewport (`bottom <= 900`) …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (v4681t21, port 4681, new home, no runs). On my extra port 127.0.0.1:4683 I served a small fixture page with an h1, an input, a #go "Greet" button and a list. Its "/" path logs nothing and its "/errors" path logs 12 console.error lines.

Steps, all in headless Chrome at 1440x900 with a fresh profile and the side panel at its default width (420px):
1. Open project MQTT-MCP, open the Side panel, Browser tab, type the fixture URL in Address, wait for canvas data-ready.
2. Click Console.
3. Click Pick and click the Greet button on the canvas.
4. Click Adjust on pin 1.
After each step I measured the children of .interactive-browser, whose height is 813px.

The fixed rows take 269px of that, or 33%: sess-strip 47, address 51, toolbar 39, transfers 38, annotation tools 41, journey-recorder 53.

Page "/", no console lines (same case as the report):
- Page only: canvas 544px tall.
- Console open: drawer 71px, canvas 473px.
- Pin tray open: tray 127px, canvas 346px.
- Adjust open: tray grows to 366px, which is 45% of 813, and the canvas drops to 108px. The remote frame stays 419x200 and is drawn at 0.538 scale.
- Console closed again, Adjust still open: canvas 179px, scale 0.893.
Screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4681t21/004-base-adjust.png matches the reporter's 002-pick-adjust.png.

Page "/errors" (worse, reproduced 3 times):
- Console open: drawer 276px (34%), canvas 268px.
- With Adjust open: the canvas is 0px, so the live page is gone. The Record-a-bug row is squeezed to 1px.
- .interactive-browser overflows by 46px. The tray's send row (the "with 12 console errors" checkbox and "Add to a new run") sits at y=908-936, below the 900px viewport.
- body has overflow:hidden, so a mouse or wheel cannot reach it. Only a programmatic scrollIntoView brings it back, and that shifts the whole app shell up 46px (005-errs3-scrolled.png).
Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4681t21/004-errs-adjust.png

There were no console or 5xx errors. Nothing in docs/runs.md:100-102 says this is intended: Adjust "tries style changes ... right in the page", which needs the page to stay visible. The reporter's script and environment are not the cause. I used project scope instead of a run preview; both render the same BrowserTab and produce the same 813px …

</details>
