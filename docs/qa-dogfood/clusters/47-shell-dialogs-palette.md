# Cluster 47 · shell-dialogs-palette

**App shell dialogs, toasts and command palette**

Status: **fixed and verified** · 12 issues · branch `codex/qa-shell-dialogs-palette`

Planner notes: useDialog in ui/app.tsx (752-771): the 'close' listener keeps the first render's onClose, so the busy guard is stale, and 'cancel' (Esc) isn't handled. Esc while 'Deleting…' or 'Opening…' therefore closes the dialog and drops the error (t00-4/S00-2, t02-8). Handle cancel with preventDefault while busy, and read onClose through a ref. t25-4: closing a dialog with Done drops focus to <body>; restore focus to the opener. t25-3: the phone sidebar drawer is not modal; add a focus trap, Esc and focus return. t25-9: error toasts vanish after 2 s (showToast in ui/lib.ts); add a severity and make errors stay longer or until dismissed. Palette (ui/command-palette.tsx): slice(0,40) with no grouping hides projects and runs (t00-6/S00-4). Cmd/Ctrl+K lacks the dialog[open] guard that Cmd+, has (t00-7/S00-5, onShortcut in ui/app.tsx ~401). Run search covers only loaded runs, and compare variants can't be told apart (t00-17, search in src/run-history.ts). Results are not ranked, so 'health' opens Settings rather than the Health dialog (t04-18). Duplicate groups: [["t00-4","S00-2"],["t00-6","S00-4"],["t00-7","S00-5"]]

Likely files: `ui/app.tsx`, `ui/command-palette.tsx`, `ui/command-palette-model.ts`, `ui/lib.ts`, `ui/rail.tsx`, `ui/run-actions.tsx`, `ui/projects.tsx`, `src/run-history.ts`, `ui/styles.css`

## Continuation outcome · 2026-10-26

All 12 listed issues are repaired. Verification used a fresh worktree from `d905023`, separate scratch homes/repositories and real Chrome with fake providers. No live user server, real provider account, real repository, or user CodeFlow home was used.

- **t00-4 / S00-2 / t02-8:** `useDialog` reads current callbacks and an explicit busy guard. Native cancel is prevented while busy; forced repeated-Escape closes reopen the dialog. All six busy call sites pass their current guard. Single and bulk delete preserve delayed errors and partial success. The repository destination dialog retains a real duplicate-project error and can successfully retry. A resumed fake-agent run produces the real server 409 while its delayed DELETE response remains visible.
- **t25-4:** Done/Cancel unmount closes the native modal and restores its opener. If deleting the run removes that opener later in the render, a guarded microtask focuses main content. Focus is never taken from another open modal. Shortcuts, Projects, Health, Escape and successful deletion are covered.
- **t25-3:** the phone drawer is a native modal dialog, with modal keyboard focus/inert background, close/backdrop/Escape behavior and focus return. Slash-search clears its query first, then closes on a second Escape. Desktop retains navigation semantics; resizing out of phone mode releases modal state. Light/dark phone axe checks pass.
- **t25-9:** `showError` gives action failures alert semantics and a Dismiss control, persisting by default. Explicit durations have a six-second minimum. Error call sites use it; ordinary successful toasts retain their two-second duration. Offline Archive, persistence, dismissal, success expiry and stale-toast identity are tested.
- **t00-6 / S00-4:** the empty palette includes six main actions, five projects and five recent runs; project subsections cannot crowd them out. Search keeps plain project destinations before their subsections and explains truncated results.
- **t00-7 / S00-5:** Cmd/Ctrl+K respects an already handled event and another open modal, while continuing to toggle the palette itself.
- **t00-17:** debounced server searches cover saved history beyond the first 100 runs, ignore older responses and retain loaded matches with readable failure feedback. Run rows show their comparison variant and search pattern, source, branch, status and id fields. Server matches survive a bounded response projection.
- **t04-18:** stable ranking puts exact labels/explicit aliases, prefixes and label words ahead of incidental keywords. Health, Board and Manage projects open the intended destinations with Enter.

Evidence root: `/private/tmp/codeflow-qa-continue/work/shell-dialogs-palette/`.

- `baseline.log`: five original-behavior replays fail on detached unchanged `d905023` (busy Escape, Done focus, modal stacking, empty palette omission and old-history search).
- `ui-verified.log`: all **14 new Chrome tests pass**; `ui-verified/` contains screenshots, page text, server log, network failures and console diagnostics. Page exceptions are empty; console errors are only the explicitly injected 409/400/503/offline responses. Server output has no uncaught exceptions. Light/dark drawer, curated palette and persistent error screenshots were visually inspected.
- `related-final.log`: **19 unit/related tests pass**, including five new palette/toast cases and existing history/UI review checks. `model-toast-final.log` repeats the five new units after the final curated-order refinement. `tsc-final-palette.log` is clean.
- `original-ui.log` / `original-baseline.log` retain the broader initial failures. Context-budget error wording and stored selection-marker expectations were stale relative to clusters34/35; the original test still asserts no provider launch and strict membership enforcement. The project theme audit now waits on the actual hidden rail (a native dialog on phones), flushes layout before checking finite transitions, and polls on browser frames with bounded waits. A trial promise loop stalled and was removed; no product colors or menu behavior were changed.
- `integration-final.log`: 59 of 60 browser scenarios pass, with one project theme/menu case timing out in that trial synchronization. `project-verified.log` reruns all 13 project navigation cases successfully with the bounded frame-based wait, covering the remaining scenario. This establishes passing coverage for all **60 distinct combined scenarios**, including all 16 new cluster/integration cases and all eight provider-health scenarios. `original-actions.log` adds the two existing sidebar/bulk archive-delete cases; `automation-original.log` adds all eight existing automation-record browser cases.
- `integration-unit.log`: all **43** shell/automation/project unit and related tests pass; `integration-tsc.log` is clean. Previous history/UI review coverage remains in `related-final.log`.

### Separate integration repair: revoked automation membership

The broader project test exposed a real interaction between clusters27 and35. Dropping the saved interactive `projectSelection` marker is needed for deleted-project fallback, but clearing it unconditionally at every fire also let `Projects.place` add a deliberately removed repository back to an existing project. `automation-before.log` demonstrates the pre-fix 201 where 409 was required, alongside a passing deleted-project fallback control. Triggered starts now require current explicit membership whenever the saved project still exists; only a missing project receives fallback semantics. New real-server regressions assert 409, no new run and no re-added repository, then verify a deleted project's automation still finishes in an available repository project. All eight original automation-record UI cases pass after this change. The repair is a separate follow-up commit from the shell changes for review.

Limits and fixture distinctions: real server API/state and actual Chrome were used; provider execution was fake. Busy single/bulk errors, offline failure and search outage were deliberately intercepted. The running-run 409 and duplicate project error came from the real server. Only the bounded search-response projection was simulated; old-history retrieval and comparison rows were real persisted records. Existing native-browser scenarios use the QA-only mock-keychain Chrome wrapper documented in cluster43; production browser flags remain unchanged. Early replay logs are retained and include corrected fixture selectors/role names, a missing cancel endpoint in test cleanup and the deleted-opener focus regression caught during verification.

## Issues

### t00-4 · minor · Pressing Esc while a run is 'Deleting…' closes the dialog and silently loses a failure; the run remains

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-22, SHL-23.

**Repro**

> 1. Fake QA server, open a finished non-solo run (e.g. loop pattern).
> 2. More run actions → Delete… → 'Delete run'. Make the DELETE slow and failing (in the test it was routed: 3 s delay then 409 'Simulated conflict: disk busy').
> 3. While the button reads 'Deleting…', press Esc.
> (The same happens in sidebar bulk delete: Select runs → Delete… → Delete → Esc.)

**Expected:** The dialog stays open while busy (DeleteRunsDialog guards onClose with !busy) and shows the error when the request fails.

**Actual:** Esc closes the dialog immediately. When the DELETE fails there is no alert and no toast, and the run still exists (GET 200). Without Esc the same failure correctly shows 'Simulated conflict: disk busy' in the dialog. Reproduced for single and bulk delete.

**Root cause (verifier):** The bug has two parts, and both have to be fixed.

1) Stale closure, ui/app.tsx:752-771 (useDialog). The "close" listener is created inside useEffect(..., [el, open]) and calls the onClose it captured on that render. DeleteRunsDialog always passes open=true, so the effect runs only once, when the ref attaches. The listener therefore keeps the first-render closure from ui/run-actions.tsx:31, `() => { if (!busy) onClose(); }`, where busy is false. setBusy(true) at run-actions.tsx:47 never reaches it, so the `!busy` guard never takes effect, and Esc while deleting calls the parent's onClose. The parent unmounts the dialog. The async loop keeps running, but its setError/setPending/setBusy at run-actions.tsx:56 land on an unmounted component and are dropped. showToast at line 54 fires only for successes. So a failure becomes invisible, and in bulk mode the only message is a "Run deleted" toast for the runs that did succeed.

2) No cancel handling. Nothing listens for the native "cancel" event or calls preventDefault on it. Even with a fresh closure, Esc would still close the native <dialog> element (el.open becomes false) while the component stays mounted. The effect does not re-run bec …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-actions.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/task-team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Change useDialog so it always calls the latest callback and so it can refuse to close while busy.

(a) Store onClose in a ref that is updated on every render (`const latest = useRef(onClose); latest.current = onClose;`). The close handler then calls latest.current(), so no closure goes stale.

(b) Add an optional `canClose?: () => boolean` argument, or a `busy` flag that is also kept in a ref. Register a "cancel" listener that calls e.preventDefault() when closing is not allowed.

(c) Chrome's CloseWatcher rules ignore preventDefault on a repeated Esc that has no user activation in between. So the "close" handler also needs a fallback: if closing is not allowed and the close was not one the code requested itself, call el.showModal() again, or keep it open by some other means, instead of calling onClose.

Then change DeleteRunsDialog (run-actions.tsx:31) and the other four busy-guarded dialogs (task-team.tsx:65 and :144, run.tsx:2332 and :2365) to pass the busy state through the new arg …

**Suggested regression test:** Add an e2e test to test/e2e/ui.e2e.ts, next to the existing "Delete this run?" test at about line 1424, which already uses fresh.route on DELETE.

Route DELETE /api/runs/<id> to wait about 1.5 s and then fulfill 409 {error:"Simulated conflict"}. Open Run actions → Delete… and click "Delete run". Wait for the button text "Deleting…", then press Escape. Assert that the dialog "Delete this run?" is still visible (count 1). Then wait for the dialog's role=alert to contain "Simulated conflict", and a …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4649 on 127.0.0.1:4649, started with FAKE_SLEEP_MS=6000 and an empty runs dir. I made my own scratch git repo (scratchpad/qa/clones/v4649-escdel, since removed) and seeded 5 loop-pattern runs through POST /api/runs. All 5 finished as "stopped" at the step limit. Headless Chrome scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4649/esc1.mjs and esc2.mjs, logs esc1.log and esc2.log in the same folder.

T1, single delete, same method as the reporter: page.route made DELETE /api/runs/A wait 3 s and then return 409 "Simulated conflict: disk busy". I opened run A, clicked More run actions → Delete… → Delete run. The button read "Deleting…" and Cancel was disabled (screenshot shots/v4649/001-T1-busy-before-esc.png). I pressed Escape. 0.3 s later there were 0 open dialogs. After the 409 there was still no dialog, no [role=alert] and no toast, and GET /api/runs/A returned 200, so the run still existed (screenshot 002-T1-after-failure.png).

T1b, control, same failure without Esc: the dialog stayed open with role=alert "Simulated conflict: disk busy".

T1c: Esc while the dialog is idle closes it, which is expected.

T2, bulk delete: sidebar Select runs, checked runs C and D, Delete… → "Delete 2 runs". DELETE for C was routed to wait and return 409; D went to the real server. I pressed Esc while the button read "Deleting…". The dialog closed at once. Afterwards the only feedback was a toast saying "Run deleted" (that was D). C's 409 was never shown. GET C returned 200, GET D returned 404. The only remaining hint was "1 selected" in the rail.

T3, no request interception at all, to rule out the tester's script: I opened the Delete dialog on run E. Then I resumed E through the API, standing in for another tab or a phone, so E was really running. I set CDP Network.emulateNetworkConditions latency to 2500 ms to stand in for a slow remote/tailnet link, clicked "Delete run" (button read "Deleting…") and pressed Esc. The dialog closed. The real server answered 409 {"error":"Finish or stop the run before deleting it"}. Nothing was shown (0 dialogs, no alert, no toast) and GET E returned 200.

Cleanup: I deleted every run through the UI bulk delete (0 runs left), stopped server v4649 and removed my scratch repo with its worktrees and branches. Ports 4649-4651 are free. One leftover: the auto-created project p-88ee2c65 is still in my QA home's projects.json.

</details>

### S00-2 · minor · useDialog registers its native 'close' handler only on [el, open] changes, so it keeps the first render's onClose. Busy-guarded dialogs (RepositoryChoiceDialog, DeleteRunsDialog) still close on Esc during async work and lose their error messages.

Source: code-level suspect at `ui/app.tsx:757` (confirmed hands-on).

**Repro**

> Fake server s00. DeleteRunsDialog (work/s00/esc-delete.mjs): sidebar run row '...' > Delete… with Playwright routing DELETE /api/runs/:id to wait 3 s and then return 409 {error:'QA: this run is busy; try again'}. Control: click 'Delete run' and wait. The dialog stays open with Cancel disabled, shows 'Deleting…', then the alert with the error. Bug: click 'Delete run', press Escape while it shows 'Deleting…'. The dialog unmounts at once. When the 409 arrives there is no alert and no toast, and the run still exists. RepositoryChoiceDialog (work/s00/esc-repo.mjs): Open another repository > choose a repo that is in no project > 'Create project' with POST /api/projects delayed 3 s then 409. Control shows the error alert. Pressing Esc during 'Opening…' removes the dialog and the error is never shown.

**Expected:** While busy (Cancel is disabled), Esc does not dismiss the dialog. A failure stays visible in the dialog so the user can retry or cancel.

**Actual:** Esc dismisses the dialog during the request. The request keeps running in the background and its error is dropped. For RepositoryChoiceDialog, a request that succeeds would still create the project and switch the composer after the user 'cancelled'.

**Root cause (verifier):** Two causes. (1) The useDialog effect depends on [el, open] only, so the 'close' listener captures the first render's onClose, where busy === false, and the '!busy' guard never sees later state. (2) The guard sits on the native 'close' event, which fires after the browser has already closed the <dialog>. Even a fresh closure could not keep it open, because nothing calls preventDefault on the 'cancel' event (confirm-dialog.tsx does). The same pattern appears in run.tsx:2332, run.tsx:2365 and task-team.tsx:65/144.

**Suggested fix:** In useDialog, keep the latest onClose in a ref (ref.current = onClose on each render; the handler calls ref.current()). Add an optional guard argument, for example useDialog(open, onClose, { canClose: () => !busy }) or a busy flag, and register a 'cancel' listener that calls event.preventDefault() while the guard says no. Pass busy from DeleteRunsDialog, RepositoryChoiceDialog, run.tsx and task-team.tsx.

**Suggested regression test:** Playwright e2e: open the Delete run dialog, route DELETE to a delayed 409, click Delete, press Escape. Assert the dialog is still open and, after the response, shows the error alert. Do the same for 'Create project' in the repository choice dialog.

### t02-8 · minor · Destination dialog: Esc while 'Opening…' closes it and silently drops the server error

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-06.

**Repro**

> 1. In the composer of project 'X' click 'Open another repository' and pick a repo not in X.
> 2. In 'New project name' enter an existing project name, e.g. 't02 studio'.
> 3. With a slow network (DevTools latency 3 s) click 'Create project'. While the button reads 'Opening…' (Cancel is disabled), press Esc.

**Expected:** The dialog stays open while busy, as the disabled Cancel implies, and shows "There's already a project called…".

**Actual:** The dialog closes immediately. When the request fails, nothing is shown and nothing happens.

**Root cause (verifier):** There are two defects, and either one alone causes the bug.

1. ui/app.tsx:752-771 `useDialog` handles the dialog's 'close' event but never 'cancel'. Pressing Esc on a showModal() dialog fires 'cancel' and then closes the dialog natively, before any component code can step in. Even if `onClose` correctly refused, the <dialog> would already be closed. The component would stay mounted with el.open=false, and because the effect deps [el, open] do not change, it would never call showModal() again. The error would then render into a hidden dialog. Also, the next pick of the same repository keeps the same `key` and would not reopen it.

2. ui/app.tsx:764-771: the 'close' handler is registered in an effect with deps `[el, open]`, so it captures the `onClose` from the first render. In ui/projects.tsx:349, `const close = () => { if (!busy) repositoryChoice.value = null; }` therefore always sees busy=false. After the native close, the handler sets repositoryChoice.value=null, and ui/app.tsx:178 unmounts RepositoryChoiceDialog. When the request fails, the catch block's `setError` in `choose` (ui/projects.tsx:364) runs on an unmounted component, so nothing is shown. On success, `choose` keeps  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-navigation.e2e.ts`

**Suggested fix:** Fix this centrally in useDialog (ui/app.tsx).

(a) Keep the latest callbacks in refs (`const onCloseRef = useRef(onClose); onCloseRef.current = onClose;`) so the handlers never read a stale `busy`.

(b) Give useDialog an optional `canClose?: () => boolean` (or `busy: boolean` kept in a ref). Add a 'cancel' listener that calls `event.preventDefault()` when the dialog may not close, so Esc does nothing while the request is in flight.

(c) Chrome's CloseWatcher can still force-close a dialog on a repeated Esc with no user activation in between. To cover that, the 'close' handler should check the same guard and call `el.showModal()` again if the dialog closed while it must stay open, rather than calling onClose.

Then change RepositoryChoiceDialog (ui/projects.tsx:349-350) to pass the busy guard, e.g. `useDialog(true, close, { canClose: () => !busy })`. Apply the same to the other `if (!busy)` call sites: run.tsx:2332/2365, task-team.tsx:65/144 and run-actions.tsx:31.

Optionally, `choose` …

**Suggested regression test:** Add a test to test/e2e/project-navigation.e2e.ts, next to "explicit membership blocks stale launches and adding a repository is a deliberate action".

1. Open a project composer and pick a repository that is not in the project, so the "Open repository in a project" dialog appears.
2. Fill "New project name" with an existing project's name.
3. Use page.route to delay POST /api/projects by about 1.5 s, click "Create project", and wait for the button text "Opening…".
4. Press Escape.
5. Assert the  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4607 on 127.0.0.1:4607, with a fresh browser profile. To avoid touching any user repo I made a scratch git repo with one commit at <QA>/clones/v4607-scratch. The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4607/esc-busy.mjs. It uses Playwright page.route to hold POST /api/projects for 3 s, which stands in for DevTools latency.

Steps: open #/project/p-ef01794b/new (the MQTT-MCP composer), click "Open another repository", type the scratch repo path, click Go, then "Open this repository". The "Open repository in a project" dialog appears. Type "MQTT-MCP" (an existing project) into "New project name" and click "Create project".

Results:
- noesc (control): while busy the button reads "Opening…" and Cancel is disabled. The POST returns 400 "There's already a project called “MQTT-MCP”", the dialog stays open and shows that error.
- esc: same busy state. Pressing Escape removes the dialog from the DOM within 200 ms (count 0). The 400 still arrives 3 s later, but no error, alert or toast is shown. The screenshot (shots/v4607/003-esc-after-esc.png) shows the plain MQTT-MCP composer with no feedback.
- esc with a unique name ("v4607 esc probe"): the dialog also closes on Esc, but the request is not cancelled. 201 arrives, the project is created, and the app navigates to #/project/p-4d482880/new. So Esc looks like "cancel" but the action still goes through.
- Fix check: I injected a `cancel` listener that calls preventDefault while the primary button is disabled. Esc then left the dialog open (open=true), and the duplicate-name error appeared once the request finished.

I found nothing in docs/*.md saying Esc should close a busy dialog. The code's own `if (!busy)` guard and the disabled Cancel button show the intent is to block closing while busy, so this is not by design. It does not depend on the tester's environment either: fresh profile, fake mode, and the selectors were checked against the source.

</details>

### t25-4 · minor · Closing dialogs with their Done button drops keyboard focus to <body> (Esc restores it correctly)

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-06, UX-09.

**Repro**

> 1. On a fresh fake server, go to #/settings/general, focus 'View shortcuts' and press Enter.
> 2. Press Enter on 'Done' and check document.activeElement.
> 3. Repeat, closing with Escape instead.
> 4. Repeat with the Projects dialog (composer 'Choose project' > Done) and the Health dialog (App menu > Agents & usage > Done).

**Expected:** Focus returns to the control that opened the dialog, whichever way it was closed.

**Actual:** With Done, focus goes to body in all three dialogs (shortcuts, projects, health). With Escape, it returns to 'View shortcuts' or 'Choose project'. After confirming a run deletion from Run actions, focus also falls to body because the trigger row is gone.

**Root cause (verifier):** ui/app.tsx:752-770 `useDialog(open, onClose)` closes the dialog natively, with `el.close()`, only when `open` changes from true to false while the component is still mounted. Almost every dialog calls it as `useDialog(true, …)`: about 28 call sites, including ui/app.tsx:463 and :497, ui/projects.tsx:63 and ui/run-actions.tsx:31. Each one is mounted and unmounted by a conditional in its parent:
- ui/app.tsx:177, 179 and 180 (`{projectsOpen.value ? <ProjectsDialog/> : null}`, then the same for health and shortcuts)
- ui/rail.tsx:541 (`bulkDeleting ? <DeleteRunsDialog…>`)
- ui/run.tsx:404

A Done or Cancel button only sets the state to false, e.g. ui/app.tsx:486 `shortcutsOpen.value = false`, ui/app.tsx:564 and ui/projects.tsx:59-62 `close()`. Preact then unmounts the component and removes a <dialog> that is still open as a modal. Chrome's dialog removing steps take it out of the top layer without running close(), so the "previously focused element" is never restored and focus falls to <body>.

Escape takes the native cancel -> close() path. That restores focus first, and only then does the `close` event call onClose and unmount the dialog. This is why only Escape works.

The confirme …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-actions.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/accessibility.e2e.ts`

**Suggested fix:** Fix it once in useDialog (ui/app.tsx:752) so all ~28 conditionally mounted dialogs benefit.

1. Save `document.activeElement` when the hook first calls showModal(). Add an effect that runs only on unmount (deps `[el]`). Its cleanup checks `el.open`; if so, it bumps controlledCloses for el and calls `el.close()`. If focus still ends up on body or inside the dialog, it focuses the saved element when `isConnected`. This mirrors ui/confirm-dialog.tsx:25-32.
   - Preact 10.29.8 runs hook cleanups through `options.unmount` before `removeNode` (node_modules/preact/src/diff/index.js:651 vs :684). The dialog is therefore still connected when close() runs, and the native focus restore works. mechanism.mjs showed this: close() and then remove returns focus to "View shortcuts".
   - The queued `close` event cannot call onClose twice: the existing effect's cleanup removes the listener, and the controlledCloses counter covers it too.
2. When the opener no longer exists (a deleted run row), useDialog …

**Suggested regression test:** Extend test/e2e/accessibility.e2e.ts, which already checks palette Escape focus at line 73.
- For each trigger (Settings > General "View shortcuts", Settings "Health & usage", the composer `button.project-btn`, and rail "Run actions" > "Delete…"): call `trigger.focus()`, press Enter, wait for `dialog[open]`, focus the dialog's Done or Cancel button, press Enter, wait for it to detach, then `assert.equal(await trigger.evaluate(el => el === document.activeElement), true)`. Repeat with Escape so bo …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake QA server v4673 on 127.0.0.1:4673 (new home) and a fresh headless Chrome with no profile. Each dialog was opened from its trigger with focus() + a real Enter key press. Then document.activeElement was read 250 ms after the <dialog> left the DOM. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4673/focus.mjs; output in focus.log in the same folder.
- Shortcuts (Settings > General > View shortcuts): Done with Enter -> BODY. Done with a click -> BODY. Escape -> "View shortcuts".
- Health (Settings > Health & usage): Done with Enter -> BODY. Escape -> "Health & usage".
- Health (Application menu > Agents & usage): Done with Enter -> BODY. Escape -> "Application menu".
- Projects (composer "Choose project"): Done with Enter -> BODY. Done with a click -> BODY. Escape -> "Choose project".

To rule out a Playwright focus() artefact, mechanism.mjs (same folder) moved to Done with real Tab presses and pressed Space. Focus went to BODY, and the next Tab landed on "Skip to main content", so a keyboard user starts again from the top of the page. The same script tested the mechanism inside the page:
- Removing the open dialog node -> BODY.
- Calling dialog.close() and then removing it -> focus back on "View shortcuts".

Side claim, delete.mjs (same folder): two fake runs were created in a throwaway git repo in my scratchpad. In the rail I opened Run actions > Delete…:
- Cancel with Enter -> BODY, even though the trigger row is still on the page. This is a further instance of the same bug.
- Escape -> the "Run actions" button.
- Confirming the delete -> BODY, because the trigger row is gone.

No console, page or 5xx errors. I found nothing that makes this the tester's environment or script: it reproduces with a fresh profile, keyboard-only input, and several triggers per dialog.

It is not by design. ui/confirm-dialog.tsx:25-32 explicitly saves the opener and refocuses it when it unmounts. test/e2e/confirmation.e2e.ts:47-51 checks that focus returns to "New link" after Cancel is activated with Enter. docs/application-improvements.md:54 says focus restoration is covered. docs/accessibility.md:9 only promises it for Escape on the command palette.

Cleanup done: both runs were deleted through the UI, server v4673 is stopped, and the scratch repo with its codeflow/* worktrees and branches was removed. No user repos or ~/.codeflow were touched. The only leftover is an auto-created pr …

</details>

### t25-3 · minor · Phone sidebar drawer is not modal: focus stays behind it, Tab goes behind the scrim, Esc doesn't close it

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-07.

**Repro**

> 1. On a fresh fake server, open the app at 390x844 (a touch context works too).
> 2. Tap or click 'Show runs'.
> 3. Check document.activeElement, then press Tab several times.
> 4. Press Escape.

**Expected:** Focus moves into the drawer (e.g. 'Close menu' or search), Tab stays inside it while it is open, the background is inert or aria-hidden, and Escape closes it and returns focus to 'Show runs'.

**Actual:** Focus stays on 'Show runs', which the drawer now covers (Playwright reports the rail intercepting pointer events on it). Tab moves to 'SSH connections', 'Open command palette', 'Use the dark theme', 'Side panel', 'Choose project'… behind the scrim. .main-col is neither inert nor aria-hidden, and the nav has no dialog role. Escape leaves the drawer open. Pressing Enter on the hidden focused button toggles it closed.

**Root cause (verifier):** - ui/app.tsx:203: the 'Show runs' button only toggles railOpen.value (onClick={() => (railOpen.value = !railOpen.value)}). It never moves focus into the drawer and never remembers the opener.
- ui/app.tsx:139: when the drawer is open, the app renders only a decorative, aria-hidden .rail-scrim with a click handler. The sibling <div class="main-col"> (app.tsx:140) gets neither inert nor aria-hidden, so Tab order and the screen-reader tree still include the whole page behind it.
- ui/app.tsx:128-131: the drawer closes on route change, but nothing restores focus to the trigger.
- ui/rail.tsx:399: <nav class="rail open" aria-label="Runs"> has no dialog semantics (role="dialog" / aria-modal) and no onKeyDown for Escape. The 'Close menu' button at rail.tsx:407 sets railOpen=false without restoring focus.
- ui/rail.tsx:430-432: the only Escape handler is on #run-search, and it clears the query and blurs, so focus falls to body.
- ui/app.tsx:401-412: the global onShortcut has no Escape case for the drawer.
- ui/styles.css:1322-1326 and 1754: CSS makes .rail a fixed overlay with z-index 6 and the scrim z-index 5 at max-width 760px, so the behaviour is visually modal but not modal to keyboard …

**Files:** `ui/app.tsx`, `ui/rail.tsx`, `test/e2e/accessibility.e2e.ts`

**Suggested fix:** Make the drawer modal only while it is an overlay, that is when the menu button is visible (matchMedia('(max-width: 760px)'), or check getComputedStyle on .menu-btn). Leave the desktop rail unchanged.

1. app.tsx: when railOpen becomes true, remember document.activeElement as the opener (a module-level ref or a signal next to railOpen). Set inert, plus aria-hidden as a fallback, on .main-col and on the SidePanel <aside> while the drawer overlays: inert={railOpen.value && phoneLayout}.
2. rail.tsx: when the nav is open as an overlay, give it role="dialog", aria-modal="true" and aria-label="Runs". In a useEffect on railOpen, focus the 'Close menu' button, or #run-search when the '/' shortcut opened it.
3. Add an onKeyDown on the nav: Escape closes the drawer (railOpen=false) and focuses the opener, falling back to .menu-btn. Then let the #run-search Escape handler stop at clearing the query when there is one, and otherwise let Escape close the drawer. Making the rest of the page inert ke …

**Suggested regression test:** In test/e2e/accessibility.e2e.ts, extend the mobile section (after line 54, setViewportSize 390x844), or add a new test in test/e2e/ui.e2e.ts, using a deterministic fake server:
1. Focus 'Show runs' and press Enter. Assert that document.activeElement is inside nav.rail (for example the 'Close menu' button) and that .main-col.inert is true or aria-hidden is "true".
2. Press Tab about 15 times and after each press assert document.activeElement.closest('.rail') !== null.
3. Run an axe audit labelle …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake server (qa-server.sh start v4671 4671 fake) and opened http://127.0.0.1:4671 in a fresh headless Chrome with no saved profile, at 390x844. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4671/drawer.mjs. Output: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4671/drawer.log.

(A) Mouse click on 'Show runs'. The drawer opens (.rail.open, the scrim is shown, aria-expanded=true), but document.activeElement stays on the 'Show runs' button. elementFromPoint at that button's centre returns span.brand-name, so the open rail covers it. .main-col has inert=false and no aria-hidden. nav.rail has no role and no aria-modal. Seven Tab presses went to 'SSH connections', 'Open command palette', 'Use the dark theme', 'Side panel', 'Choose project', 'Choose repository…' and 'Open another repository', all with inRail=false, so focus was behind the scrim. Escape left the drawer open.

(B) Keyboard user: focus 'Show runs' and press Enter. Focus stays on the now-covered button. Escape does not close the drawer. A second Enter on the covered, focused button closes it (the toggle).

(C) The '/' shortcut is the one path that does move focus into the drawer (#run-search). The first Escape there only clears and blurs the search, which drops focus to body with the drawer still open. A second Escape also leaves it open.

(D) Touch context (isMobile + hasTouch, fresh profile; script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4671/touch.mjs). After tapping 'Show runs', focus stays on it. Tab goes to 'SSH connections'. Escape does not close the drawer. The aria snapshot still exposes 'Open command palette' and 'Choose project' from the background. Tapping the scrim does close the drawer, but focus goes to body rather than back to 'Show runs'.

There were no console or page errors. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4671/001-drawer-open-click.png (the drawer covers the left 304px, including the menu button).

Attempts to refute:
- Not by design. docs/accessibility.md says the app supports 'keyboard navigation and focus restoration, inert closed panels', 'Escape returns focus to its trigger' for the palette, and the shortcuts list ( …

</details>

### t25-9 · minor · Error toasts disappear after 2 seconds, e.g. 'Can't reach code-flow…' when an action fails

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-10.

**Repro**

> 1. On a fresh fake server, open a run.
> 2. Turn on offline mode (Playwright context.setOffline(true)).
> 3. In the rail, click Run actions > Archive.
> 4. Time the toast.

**Expected:** Error toasts stay long enough to read (5s or more, or until dismissed), as most success and info toasts already do (4000-6000ms).

**Actual:** "Can't reach code-flow. Is the server still running?" appears after 104ms and is gone at 2055ms. Other error paths also use the 2s default: rail.tsx:153 (bulk action error), rail.tsx:243 (archive error), run.tsx:122. Only one toast shows at a time, and a new one replaces it.

**Root cause (verifier):** ui/lib.ts:225-229 `export function showToast(text: string, ms = 2000)` uses one 2000ms default for every message, with no severity and no dismiss. ui/app.tsx:98-100 and 185-187 render it as a plain `<div class="toast" role="status">` with no close control. The error call sites below pass no duration, so they disappear after 2s:
- ui/rail.tsx:243 (rail Archive/Unarchive failure, the reported path)
- ui/rail.tsx:153 (Delete pre-check failure)
- ui/run.tsx:122 (could not load chats), run.tsx:256 (save template), run.tsx:258 (unarchive), run.tsx:266 (cancel/stop failure)
- ui/side-chat.tsx:458 (resume failure)
- ui/automations.tsx:327 (delete automation)
- ui/project-teams.tsx:125 (run cycle / preview, two places)
- ui/journeys.tsx:104 (prepare fix)
- ui/preferences.ts:18 (notifications error)
- ui/settings.tsx:130 (validation)
The text "Can't reach code-flow…" comes from ui/lib.ts:71, the fetch-failure ApiError in fetchJson.

**Files:** `ui/lib.ts`, `ui/rail.tsx`, `ui/run.tsx`, `ui/side-chat.tsx`, `ui/automations.tsx`, `ui/project-teams.tsx`, `ui/journeys.tsx`, `ui/preferences.ts`, `ui/settings.tsx`, `ui/app.tsx`, `test/scope.test.ts`

**Suggested fix:** Add a severity-aware helper instead of patching each call site. In ui/lib.ts add `export const showError = (text: string, ms = 6000) => showToast(text, ms)`. Optionally have showToast compute a minimum duration from text length, e.g. `Math.max(ms, 1500 + text.length * 60)`, so long messages are never cut to 2s. Then switch the error call sites listed in rootCause to showError, which matches the existing 5000/6000 convention.
Optionally (UX): store `{ text, id, kind }` in the toast signal. For kind "error", ui/app.tsx renders role="alert" and a small close button, and the toast stays while hovered or focused. Pausing the timer on hover/focus covers WCAG 2.2.1. Also nudge the toast's bottom offset so it does not cover the composer's model/approval controls (styles.css:2260 already does this on narrow screens).

**Suggested regression test:** Add a case to test/scope.test.ts, which already bundles ui/lib.ts and reads m.toast.value (see line 251). Export showError (or the error path) from the stdin bundle, stub setTimeout/Date or use node:test mock.timers, then call showError("Can't reach code-flow. Is the server still running?"). Assert m.toast.value is still set after 2500ms of advanced time and null after the error duration (≥5000ms). Add a static guard, e.g. test/ui-toasts.test.ts, that scans ui/**/*.tsx for showToast(...) whose a …

<details><summary>Verifier's independent reproduction</summary>

I started my own fresh fake-mode server (qa-server.sh start v4683 4683 fake) and a fresh headless Chrome with no profile. I made a scratch bare clone plus a working clone of MQTT-MCP at clones/v4683-mqtt (that path was already registered as project p-b4c23d7e in my home). In the UI I opened the project, chose "Back to Agent conversation", typed a task and sent it. Run 2610252308-8b0ac442 finished "done" with the fake Claude. On the run page I attached a MutationObserver that records, with performance.now(), when `.toast` appears and disappears. Each time I triggered the toast from the rail with Run actions > Archive. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4683/toast1.mjs, log toast1.log in the same folder.
Results:
A) context.setOffline(true): "Can't reach code-flow. Is the server still running?" appeared 14ms after the click and was visible for 2001ms.
B) Browser online, only the /archive request aborted with connectionrefused (not offline mode): same text, visible 2001ms.
C) Browser online, server returns 409 {error:"Example server error: …"} for /archive: that message, visible 2001ms.
D) Successful archive: "Run archived", visible 2001ms.
Screenshots shots/v4683/002-A-offline-rail-archive.png and 004-C-archive-server-409.png show the toast with no dismiss button, sitting over the composer controls. In case A the topbar pill keeps showing "Offline", so a lasting signal exists there. In case C nothing stays on screen after 2s to show that the archive failed.
So this is not caused by the tester's environment: it does not depend on offline mode, selectors or the browser profile. docs/*.md and code comments say nothing about toast duration, so it is not documented as by design. The codebase's own convention is the other way: many error toasts pass 5000/6000 explicitly (review.tsx:119, automations.tsx:245/285/314, run.tsx:971/1058/1348/1359/1400/1439/1525/1557, terminal.tsx:55, main.tsx:116, state.ts:335).
One correction to the report: it says most success/info toasts already last 4000–6000ms. That is not true. Most success toasts (e.g. "Run archived", "Task created", "Runner revoked") also use the 2000ms default. The issue holds for error toasts only.
Cleanup: I deleted the run through the UI (rail Run actions > Delete… > Delete run), and /api/runs is now empty. I stopped server v4683 and removed the scratch clones clones/v4683-mqtt and clones/v4683-mqtt.git. The dele …

</details>

### t00-6 · minor · Command palette silently cuts results at 40: with 12 projects the unfiltered list shows no project rows and no runs

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-06.

**Repro**

> 1. QA home with the user's 8 projects plus 4 more (12 projects) and 100+ runs.
> 2. Press Cmd+K without typing.

**Expected:** Projects and recent runs are reachable from the empty palette, or a hint says more results exist and to type to narrow.

**Actual:** Exactly 40 rows: 23 fixed actions plus '<project> · Board/People/Automation' rows for about 5 projects. 0 plain project rows and 0 run rows, with no hint that results were truncated.

**Root cause (verifier):** ui/command-palette.tsx:18-36 builds one flat list in a fixed order. Lines 19-32 add 23 fixed actions, including 10 settings sections from SETTINGS_SECTIONS at line 22 (13 sections minus workspace/automations/insights). Line 33 then adds 3 rows (Board/People/Automation) for every project. Only after those come line 34 (plain project rows) and line 35 (non-archived runs, newest first). Line 38, `const results = actions.filter(...).slice(0, 40);`, cuts the filtered list at 40 regardless of group. With an empty query nothing is filtered out, so only 40 - 23 = 17 slots remain after the fixed actions. Once 3 x projects >= 17 (6 or more projects) the per-project rows fill all of them, and plain projects and runs never render. The listbox (lines 57-66) only renders an empty-state message ("No commands, projects or runs match.") and has no "N more, type to narrow" message, so the cut is silent. A side effect of the same ordering: each plain project row is listed after its own sub-section rows.

**Files:** `ui/command-palette.tsx`, `ui/command-palette-model.ts (new, optional: pure ranking/grouping function)`, `ui/styles.css (style for a truncation hint row)`, `test/command-palette.test.ts (new)`, `test/e2e/project-navigation.e2e.ts`

**Suggested fix:** Rank the rows by group instead of cutting one flat list:
- **Empty query:** show the fixed actions, then the plain project rows, then the most recent runs (for example the 8-10 newest). Leave out the per-project Board/People/Automation rows until the query matches them, or show them only after a project-name term.
- **Ordering:** put each plain project row before its own Board/People/Automation rows (swap lines 33 and 34, or interleave so each project row is followed by its sub-sections).
- **Limits:** replace the global `.slice(0, 40)` with per-group caps, so one group cannot push out the others.
- **Hint:** when rows are dropped, render a non-selectable status line at the end of the listbox, for example "12 more results, type to narrow". Give it role="status" or put it in the picker foot, so screen readers hear it too.
- **Testability:** move the filtering, ordering and capping into a pure function, such as `paletteResults(commands, query) => { rows, hidden }`, so it can be unit-test …

**Suggested regression test:** Unit test in a new test/command-palette.test.ts, run with `npx tsx --test`, against the pure ranking function, using 12 projects and 100 runs with increasing createdAt:
- An empty query returns at least one `project:<id>` row and the newest `run:<id>` row.
- `hidden > 0` is reported, which drives the hint.
- The query "project" returns all 12 plain `project:<id>` rows.
- Every plain project row comes before that project's ":board" row.

Browser test in test/e2e/project-navigation.e2e.ts, with a  …

<details><summary>Verifier's independent reproduction</summary>

1. I started a fake-mode QA server, v4653, on port 4653. The home left by an earlier verifier with the same name (9 projects) was moved aside to homes/v4653.prev-<time>. The new home was fresh: only the user's 8 projects (OPCUA-MCP, OntoLab, Vibesboard, connect, MQTT-MCP, IndustriStudio, IndustriConnect, industriHealth) and 0 runs.
2. Script work/v4653/palette.mjs, run with a fresh headless Chrome profile, pressed Meta+K on #/ without typing. Result: 40 rows = 23 fixed actions + 17 "<project> · Board/People/Automation" rows. Plain project rows: 0 of 8. Run rows: 0. The list ends at "IndustriStudio · People". Pressing ArrowDown 60 times stops on that same row. There is no text hinting that more results exist; only the placeholder "Type a command, project, or task…" is shown.
3. I created 3 fake runs ("Palette probe run 1-3") in a scratch git repo via POST /api/runs (201; this also registered a 9th project, v4653-palette). The sidebar showed all 3 runs, but the empty palette was unchanged: rows=40, run rows 0, plain project rows 0 of 9. Screenshots: shots/v4653/003-with-runs-bottom.png and 004-with-runs-top.png (under the QA scratchpad).
4. typed.mjs: typing "palette probe" finds all 3 runs; typing "industriHealth" finds the plain project row, listed last after its Board/People/Automation rows. So the data is still reachable by typing, but the empty palette cuts it silently. Typing "project" returns 2 + 27 + 9 = 38 rows, so 10 or more projects would also silently drop plain project rows from that search.
5. No console errors, page errors or 5xx responses.

Correction to the report: 12 projects are not needed. The user's own 8 projects already reproduce it. With the 17 rows left after the fixed actions, 6 or more projects remove every plain project row and 5 or more remove every run.

Not by design: docs/*.md only say projects, runs, settings and Help can be found in the palette, and nothing documents the 40-row cap. The e2e tests (accessibility, settings, project-navigation, ui) always type a query first, so nothing covers the empty palette. The reporter's selectors match the real DOM (.command-result, .cr-dot, the "Project" detail).

Cleanup: I deleted the 3 runs through the UI (Select runs > Select loaded > Delete… > Delete 3 runs; afterwards the API listed 0 runs) and stopped server v4653 (port 4653 is free). The run worktrees and branches that delete keeps were only in my scratch repo, and I removed that repo. Leftovers: the QA home homes/v4653 (holding  …

</details>

### S00-4 · minor · Results are cut to 40 with no indication; with an empty query ~23 fixed actions plus 3 sub-entries per project fill the list, so with 6+ projects plain project rows and all runs are hidden until the user types.

Source: code-level suspect at `ui/command-palette.tsx:38` (confirmed hands-on).

**Repro**

> Fake server s00 with the user's 8 (later 9) projects and 2 runs. work/s00/palette.mjs: Ctrl+K with an empty query shows exactly 40 rows: 23 fixed actions and settings sections, then 'X · Board/People/Automation' entries up to 'IndustriStudio · People'. There are 0 plain project rows and 0 run rows. The footer only says '↑↓ to choose · Enter to open · Esc to close', with no hint that results were truncated. Typing 'Delete-me' shows the run 'Delete-me demo run | Run · Done · s00-demo', so the runs exist but are hidden.

**Expected:** Opening the palette shows projects and recent runs (its label is 'Commands, projects and runs'), or at least says that more results exist and that typing narrows them.

**Actual:** With 6 or more projects (23 + 3×6 > 40), every plain project row and every run is silently dropped from the default list.

**Root cause (verifier):** The actions are concatenated in a fixed order (fixed actions, then per-project sub-entries, then project rows, then runs) and .slice(0, 40) is applied with no per-group budget and no truncation indicator. Runs come only from runs.value (loaded history); there is no server search, which looks deliberate.

**Suggested fix:** With an empty query, show a curated list: a few top actions, projects, then the most recent N runs. Show the Board/People/Automation sub-entries only when the query matches. Alternatively, cap each group separately. When results.length exceeds the cap, render 'Showing 40 of N, type to narrow'.

**Suggested regression test:** e2e/unit: seed 8 projects and 3 runs, open the palette with an empty query, and assert that at least one plain project row and the newest run are listed (or that a truncation note is visible).

### t00-7 · minor · Cmd/Ctrl+K opens the command palette on top of another open modal (stacked dialogs)

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-06.

**Repro**

> 1. Any page (e.g. #/inbox), press '?' to open Keyboard shortcuts.
> 2. Press Cmd+K.

**Expected:** Cmd+K is ignored while another modal is open, like Cmd+, is.

**Actual:** Two dialogs are open: 'Keyboard shortcuts' with 'Commands and navigation' stacked on top. Esc closes only the palette.

**Root cause (verifier):** ui/app.tsx:401-410, onShortcut(), which is registered on window keydown at ui/app.tsx:123. The Cmd/Ctrl+, branch at line 402 is guarded with `!e.defaultPrevented && !document.querySelector("dialog[open]")`. The Cmd/Ctrl+K branch right after it (lines 405-409) has no guard: it always runs `commandPaletteOpen.value = !commandPaletteOpen.value`. It also returns before line 412, the generic check `target?.closest(..., dialog)` that stops single-key shortcuts inside dialogs. While another showModal() dialog is open (ShortcutsDialog, the Projects picker and so on, all using useDialog at app.tsx:752, which calls el.showModal()), Cmd+K mounts <CommandPalette/> (app.tsx:181). Its own useDialog calls showModal() again, which adds a second modal to the top layer. Esc only closes the top one.
Nothing suggests this is intended. git log -L shows the Cmd+, guard was added later (fd93482) next to the older Cmd+K branch (daf3108), and the Cmd+K branch was simply never updated. docs/accessibility.md describes the palette's Esc and focus handling but says nothing about stacking. ui/side.tsx:83 uses the same "is a dialog open" check, which supports reading this as an oversight.

**Files:** `ui/app.tsx`, `test/e2e/ui.e2e.ts`

**Suggested fix:** In the Cmd/Ctrl+K branch of onShortcut (ui/app.tsx:405), ignore the key while any modal other than the palette is open. The palette must still be able to close itself, so the check cannot be a bare `!document.querySelector("dialog[open]")`: the palette's own dialog is open when Cmd+K is pressed to close it. Proposed change (tested in a snapshot copy):
  if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === "k") {
    e.preventDefault();
    const open = document.querySelector("dialog[open]");
    if (open && !open.classList.contains("command-palette")) return; // another modal owns the keyboard, like Cmd+,
    commandPaletteOpen.value = !commandPaletteOpen.value;
    return;
  }
Keeping preventDefault stops the browser's own Ctrl+K (search bar in Firefox/Chrome) from firing while a modal is open. You could also add `!e.defaultPrevented` to match the Cmd+, branch. A cleaner long-term option is a shared `anotherModalOpen(except?)` helper used by both branches and by side.t …

**Suggested regression test:** Add a test to test/e2e/ui.e2e.ts, or to ux-flows.e2e.ts / accessibility.e2e.ts, next to the existing Meta+k usage around ui.e2e.ts:937. Go to #/inbox and press "Shift+?". Wait for getByRole("dialog", { name: "Keyboard shortcuts" }). Press "Meta+k" and "Control+k". Assert that page.locator("dialog[open]") has count 1 and getByRole("combobox", { name: "Find a command, project or run" }) has count 0. Press Escape and assert dialog[open] count is 0. Repeat with the Projects picker ("p"). Finally ass …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (v4655 on 127.0.0.1:4655; runs dir empty). Its UI bundle was built from the current dogfood source (f14f404). I drove it with headless Chrome in a fresh profile (no saved state), using /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4655/t007.mjs (log t007.log next to it).
A) On #/inbox I pressed Shift+? and got dialog[open] = ["Keyboard shortcuts"]. Pressing Meta+k gave ["Keyboard shortcuts","Commands and navigation"], with focus moving into the palette combobox. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4655/001-A-stacked.png shows the palette drawn on top of the shortcuts dialog. One Esc left ["Keyboard shortcuts"]; a second Esc closed it.
B) Control+k behaves the same way (two dialogs).
C) As a control, Meta+, with the shortcuts dialog open did nothing: the hash stayed #/inbox and only one dialog was open. So the Cmd+, guard works and Cmd+K has no such guard.
D) It is not limited to the shortcuts dialog. With the Projects picker open ('p'), Meta+k gave ["Projects","Commands and navigation"].
E) The palette's own toggle works: Meta+k opens it and Meta+k closes it.
F) Clicking the header "Open command palette" button while a modal is open is correctly blocked (the page behind is inert). Only the keyboard path gets through.
Follow-on effects (t007b.mjs): with the shortcuts dialog open, opening the palette and choosing "Settings" moves to #/settings while "Keyboard shortcuts" stays open on top. This gets around the guard that Cmd+, has on purpose. Choosing "Choose repository" puts the folder picker on top of the shortcuts dialog, so two modals are stacked.
No console errors and no 5xx responses. Fake agents played no part in this; it does not depend on the environment.
Fix check: I patched my own snapshot copy (builds/v4655) and served it on 4657. A, B and D then left only the original dialog open. E still toggled, and nothing else in the script changed.
Cleanup: I stopped both servers (v4655 and v4655fix) and created no runs. Leftovers are the scratch homes homes/v4655 and homes/v4655fix, and the patched snapshot at builds/v4655.

</details>

### S00-5 · minor · ⌘K/Ctrl+K toggles the command palette without checking for an open <dialog> (unlike ⌘, at line 402), so it can stack on top of another modal.

Source: code-level suspect at `ui/app.tsx:405` (confirmed hands-on).

**Repro**

> Fake server s00, work/s00/stack.mjs and stack2.mjs: open the folder picker (Choose repository), then press Control+, and the hash stays '#/' because the shortcut is correctly blocked. Press Control+K and dialog[open] becomes ['picker', 'picker command-palette'], with the palette over the picker. Choosing 'Manage projects' gives ['picker', 'picker small-dialog projects-dialog'], two stacked modals. Choosing a 'health' match navigated to Settings > Agents & models underneath the still-open picker (screenshot shots/s00/002-health-over-picker.png).

**Expected:** Like ⌘,, the palette shortcut does nothing while another modal dialog is open (it may still close the palette when the palette itself is the open dialog).

**Actual:** The palette opens over any modal, and its commands can open further modals or navigate the page behind the original modal.

**Root cause (verifier):** onShortcut's Ctrl/Cmd+K branch toggles commandPaletteOpen unconditionally. It lacks the !document.querySelector('dialog[open]') guard used for Ctrl/Cmd+,.

**Suggested fix:** In the K branch: if (!commandPaletteOpen.value && document.querySelector('dialog[open]')) return; before toggling. Optionally also skip when e.defaultPrevented.

**Suggested regression test:** e2e: open the folder picker, press Control+K, and assert exactly one dialog[open] (the picker) and no command palette.

### t00-17 · minor · Command palette run search covers only loaded history, and compare variants are indistinguishable

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-08.

**Repro**

> 1. With more than 100 runs, Cmd+K and type a word from an old run outside the first page ('Ancient').
> 2. Type 'quokka' for a compare group (Agent vs Loop until green).

**Expected:** Old runs are findable as in the sidebar search, and compare variants show their variant/pattern.

**Actual:** 'Ancient' gives no rows, while sidebar search finds it via the server. The two compare runs both show 'Compare: quokka retry backoff :: Run · Done · t00-MQTT-MCP'.

**Root cause (verifier):** ui/command-palette.tsx:35 builds run rows only from `[...runs.value.values()]`. That is the client map, which holds just the first history page: limit=100 from the /api/events hello and from refreshRuns at ui/state.ts:999. Older pages arrive only via "Load older runs" (loadOlderRuns, ui/state.ts:1026) or a sidebar search. The palette never sends a server query, unlike the sidebar (historyRequestQuery, ui/state.ts:904, sends q=, and matchesFilter, ui/state.ts:1066-1069, keeps server matches) and ProjectRuns (ui/project.tsx:137). On the same line 35, each row's label is `r.task.split("\n")[0]`, its detail is `Run · ${r.status} · ${r.repo}`, and `shown` is `Run · ${STATUS_TEXT[r.status]} · ${baseName(r.repo)}`. Neither `r.group?.label` (set by startComparison at src/server.ts:2865 to the pattern name, e.g. "Agent" or "Loop until green") nor the pattern name is included. The matcher at ui/command-palette.tsx:38 searches only `${label} ${detail}`, so typing the variant or pattern name doesn't match either. The sidebar's haystack does include pattern, group.label, branchPrefix and source (runSearchText at src/run-history.ts:27 and matchesFilter at ui/state.ts:1069). Secondary: the palett …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/command-palette.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-history.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/history-launch.e2e.ts`

**Suggested fix:** 1) Make variants distinguishable. In ui/command-palette.tsx:35, put the variant in the visible row: add `r.group?.label` (or the pattern name from patterns.value when there is no group) to the label (e.g. "Compare: quokka retry backoff · Loop until green") or to `shown` ("Run · Loop until green · Done · repo"). Build the searchable `detail` from runSearchText(r) (src/run-history.ts:27) plus status, so the palette matches the same fields as the sidebar (pattern, group label, id, branch prefix, issue). Optionally show the same status the sidebar uses, via statusText(runState(r)), instead of raw STATUS_TEXT. 2) Search beyond loaded history. When the query is non-empty, debounce about 200 ms and fetch `/api/runs?q=<query>&limit=20` (excluding archived as the palette does now). Use a generation counter to drop stale responses, keep the result in local component state, and merge it with the local matches deduped by id. Server-returned cold runs should count as matches even when their bounded …

**Suggested regression test:** In test/e2e/history-launch.e2e.ts, whose fixture already puts "Ancient needle task" outside the first 100-run page (see the test "sidebar searches beyond loaded pages…"), add a test "command palette finds runs outside loaded history": press Meta+K, fill the combobox "Find a command, project or run" with "Ancient needle", wait for a GET /api/runs response with q=Ancient needle, then assert that a role=option containing "Ancient needle task" appears and that Enter navigates to #/run/<id>. For vari …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4673 on 127.0.0.1:4673 with a new CODEFLOW_HOME (I moved the earlier v4673 home aside). I used a tiny scratch git repo, clones/v4673-mqtt. Seed script work/v4673/seed.mjs created, through the API: 1 run "Ancient needle: tidy the MQTT topic docs" first, then 105 "Filler task number NNN" runs (solo, fake claude, all done), then POST /api/compare with the same payload CompareDialog sends: task "Compare: quokka retry backoff", variants {label:"Agent",pattern:"solo"} and {label:"Loop until green",pattern:"loop"}. Result: total 108, and the first page (limit=100) did not include Ancient. Browser script work/v4673/palette.mjs used a fresh browser with no profile, opened #/inbox and pressed Meta+K:
- Palette "Ancient" -> [] and "No commands, projects or runs match." (shot shots/v4673/001-palette-ancient.png). Control "Filler task number 105" (in the first page) -> 1 row. "Filler task number 001" (outside the first page) -> [].
- Palette "quokka" -> two identical rows, "Compare: quokka retry backoff :: Run · Done · v4673-mqtt" (same hover title too) (shot 002-palette-quokka.png). "quokka loop" and "quokka agent" -> [], so the variant can't be picked by typing its name either.
- Sidebar search "Ancient" -> finds "Ancient needle: tidy the MQTT topic docs" through server /api/runs?q=. Sidebar "quokka" -> two rows whose titles tell the variants apart: "Done · Loop until green · ..." and "Finished · not verified · Agent · ..." (shot 004-sidebar-quokka.png).
- After the sidebar search had pulled the old run into memory, palette "Ancient" did return it. So the palette only covers whatever happens to be loaded in runs.value.
No console or 5xx errors. No docs/*.md and no e2e test say the palette is limited to loaded history (docs/application-improvements.md only lists "Command palette" as done), so it is not by design. Severity stays minor: sidebar search is a working workaround, and the palette still opens runs that are loaded. Cleanup: deleted all 108 runs through DELETE /api/runs/:id (remaining total 0), stopped v4673, and removed the scratch repo along with its 108 worktrees and branches. Leftovers: the run files in homes/v4673/runs and the moved-aside homes/v4673-prev-* (both QA-only).

</details>

### t04-18 · minor · Cmd+K 'health' + Enter opens Settings → Agents & models, not the health dialog

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-13.

**Repro**

> Press ⌘K, type 'health', press Enter.

**Expected:** 'Check provider and Git health' is the top match for 'health'.

**Actual:** Top result is 'Agents & models' (keywords include 'health'); Enter navigates to settings; health dialog not opened. Typing 'Check provider' works.

**Root cause (verifier):** The palette does not rank results at all. It keeps them in the order they are declared.

At ui/command-palette.tsx:38 every row whose `${label} ${detail}` contains every typed word as a substring is kept. They stay in the order of the `actions` array, and Enter runs `results[selected]` with `selected` starting at 0.

The settings sections are spread into that array at ui/command-palette.tsx:22, before the "health" action at line 30. Each one has `detail: \`Settings · ${section.keywords}\``. The keywords for the "agents" section in ui/settings-sections.ts:5 include "health". So "Agents & models", which only matches on a keyword, comes before "Check provider and Git health", whose label matches.

Substring matching makes it worse: "keyboard" matches "board", so General ranks above the Board command. That comes from the General keywords in ui/settings-sections.ts:4.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/command-palette.tsx`

**Suggested fix:** Add ranking to the palette, so it no longer keeps only the filter order.

1. Move the matching into a pure helper, for example `rankCommands(commands, query)` in ui/command-palette.tsx or a small new module ui/command-search.ts. Keep the rule that every term must appear somewhere in label + detail.
2. Score each command, highest first:
   - the label equals the query;
   - the label starts with the query;
   - every term starts a word in the label;
   - every term appears in the label;
   - otherwise, it matched only through detail or keywords. These rows rank lowest, and a term that matches only in the middle of a word (like "board" inside "keyboard") ranks even lower.
3. Sort by score with a stable sort, so ties keep the current declaration order, and then apply `.slice(0, 40)`.

As a cheaper partial fix, you could put the "health" action before the SETTINGS_SECTIONS spread, or drop "health" from the agents keywords. That would leave "board", "projects" and similar queries wrong, so  …

**Suggested regression test:** Unit test: add test/command-palette-ranking.test.ts, run with `npx tsx --test`. It should build the command list from SETTINGS_SECTIONS plus the fixed actions (or call the extracted `rankCommands` helper) and assert that:
- `rankCommands(cmds, "health")[0].id === "health"`;
- `rankCommands(cmds, "board")[0].id === "team"`, not `settings:general`;
- `rankCommands(cmds, "projects")[0]` is the Projects entry whose label matches, and keyword-only matches still show up lower in the list.

E2E test: a …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server: `qa-server.sh start v4605t18 4605 fake`. It had a new home with no runs, and the user's project list was copied in. I drove it with headless Chrome using a fresh profile. The scripts are /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4605/t04-18b.mjs and t04-18c.mjs, with logs in .log files beside them.

Steps: open http://127.0.0.1:4605, move the pointer away from the dialog area, press Meta+K, type "health", press Enter.

What I saw, as the rows of the result list in order:
0* Agents & models (Settings · claude codex … health …)
1  Check provider and Git health (Actions)
2-5 industriHealth · Board/People/Automation, industriHealth

After Enter the URL was #/settings/agents and no dialog was open. Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4605t18/001-health-results.png and 002-health-after-enter.png. "Health" with a capital H gives the same result.

Typing "Check provider" or "git health" leaves a single row. Enter on that row opens the "Health" dialog.

Same cause, other queries:
- "board": the order is General (its keywords contain "keyboard"), Connections, then Board.
- "projects": the Projects settings section comes before "Manage projects".
- "inbox": the results are Inbox, then Board, so this one works.

There were no console or 5xx errors.

Things I ruled out:
- The tester's script: in my first attempt the pointer was resting over the dialog, which put the selection on row 5 through onMouseEnter. With the pointer moved away the selection was on row 0, which matches the report.
- Intended behaviour: no doc in docs/*.md says how the palette orders results. docs/configuration.md only says Health opens from the sidebar agent dots, and that settings categories can be searched in the palette.

Mitigating fact: the Agents & models page shows each provider's status and has a "Health & usage" button. So the user is one extra click from the dialog, and nothing harmful happens.

</details>
