# Cluster 23 · side-notes-terminal

**Side panel notes, terminals and chat: offline draft overwrite, autosave, restart notice, pop-out**

Status: **fixed and independently verified** · 9 issues · branch `codex/qa-side-notes-terminal`

Planner notes: Notes (NotesTab in ui/side.tsx): in t09-2 (major) the offline draft is stored without the revision it was based on and is rebased onto whatever the server has, silently overwriting newer notes. Store the base revision and detect conflicts. t09-16: switching scope within 600 ms cancels the save because the effect cleanup clears the timer; flush the save instead. t09-17: doubled punctuation in the error. Terminal (ui/terminal.tsx): t08-6 after a restart the terminal is silently replaced and the 'gone' notice never shows; t08-10 line-based history is shared across scopes (one 'termHistory' key); t00-2 terminal colours lag one theme switch because apply() in ui/theme.ts sets theme.value before dataset.theme. t08-7: there is no pop-out button, though the docs describe one (ui/side.tsx, navigation). t08-8: the side-panel ChatView has no Stop for a running chat (ui/side-chat.tsx:412). t18-19: the side-chat Ask warning doesn't name the changed files, because compareSnapshot in src/git.ts returns no paths. fs-policy-gate owns the terminal's 'first time here' auto-open effect (t23-2/t08-3); coordinate if you touch it.

Likely files: `ui/side.tsx`, `ui/terminal.tsx`, `ui/theme.ts`, `ui/side-chat.tsx`, `ui/state.ts`, `ui/stream.ts`, `ui/navigation.ts`, `ui/app.tsx`, `src/git.ts`, `src/engine.ts`

## Completed verification · 2026-10-26

Implemented from integrated baseline `42b452b` in `/private/tmp/codeflow-qa-side-notes-terminal`. All original root causes were checked against the current source, and the original actions were replayed against fresh scratch repositories with fake providers on port 4359. The policy compatibility suite used port 4361. No live 4317/4318 server, real project repository, real CodeFlow home, remote mutation, push or PR was used.

| Issue | Repair and verified outcome |
| --- | --- |
| t09-2 | Notes drafts persist text plus their original revision and base text. Changed or unknown bases recover into the existing comparison/choice UI, while identical content is cleared and an unchanged base can save automatically. Browser reproduction blocked saves, closed/reopened the tab after a phone edit, and confirmed the phone text remained intact until an explicit choice. Both “Use saved version” and “Save my draft” passed, including legacy plain-text drafts. |
| t09-16 | Saves are queued per scope and serialized across acknowledgements. Scope changes, unmount, hiding and pagehide flush pending timers. Browser tests switched repository→General and to another project inside the debounce and checked the original note saved without changing General. Delayed-response tests cover typing a newer draft and reverting to the earlier saved text while a write is in flight. |
| t09-17 | The notes error joins sentences without adding punctuation after an existing question mark. Both a blocked POST and an actual stopped server display `running? Your draft`, with the draft retained. |
| t08-6 | Remembered missing shells remain visible as gone, preserve bounded tab-local metadata/scrollback (200,000 output characters and 1,000 events per shell), and require explicit Restart. Real restarts passed both with the stream’s document reload and with reload deliberately suppressed. Output markers remain, the server lists zero shells before Restart, and a line shell restarts in its last reported subfolder. Interactive terminals remember their server-reported starting folder; no unsupported promise of restoring a shell process’s live working directory was added. Missing cached metadata falls back to the scope’s folder and still never auto-opens a shell. |
| t08-10 | Line history is keyed by the longest matching repository/worktree path and reread for writes and arrow recall. Two projects stay isolated; two split panes retain and recall each other’s newest command, including after reload. Existing global history is not copied across scopes. |
| t00-2 | Theme application updates the stylesheet before notifying signal subscribers. Manual toggles and system-scheme changes now show matching app/terminal colours immediately. |
| t08-7 | The deliberately removed popup control stays replaced by Expand. Three user docs now describe current behaviour. Legacy side URLs explicitly distinguish missing runs/projects from loading or no repository, and provide a same-tab “Open code-flow” link. Unknown run/project, valid project/run, Expand and Escape flows pass. Existing hand-off behaviour remains covered by the scope suite. |
| t08-8 | Running panel chats expose Stop directly beside their status. Browser testing clicked it without a confirmation, observed Resume, resumed successfully and confirmed Stop disappears once complete. |
| t18-19 | Snapshot descriptions include quoted changed paths for tracked edits/commits, new files, and changed/deleted untracked files, capped at eight paths plus a remainder count. Control characters are escaped. The Ask warning persists on its follow-up and appears in the conversation as well as Activity. A real fake-agent SNEAKY turn names `sneaky.txt`, leaves it in place, preserves the verdict, and retains the visible warning after reload. Existing restore/Ask assertions were updated to require file names. |

The terminal changes preserve `a08951b`’s policy invariant. The policy-close test now expects a gone pane and explicit Restart, and additionally records requests to assert **zero automatic POST /api/shell** after lifting restrictions and reloading. All four policy browser cases passed.

Validation:

- `node --import tsx --test test/e2e/qa-side-notes-terminal.e2e.ts`: **7 passed**; each case covers multiple UI/server states described above.
- `QA_FS_PORT=4361 CODEFLOW_REMOTE_PORT=4362 SHELL=/bin/sh node --import tsx --test test/e2e/qa-fs-policy-gate.e2e.ts`: **4 passed**.
- `node --import tsx --test test/qa-side-notes-terminal.test.ts test/git-reliability.test.ts`: **19 passed**.
- `node --import tsx --test test/ship.test.ts test/scope.test.ts`: **32 passed**.
- `node --import tsx --test test/qa-side-notes-terminal.test.ts test/notes.test.ts test/team-terminals.test.ts`: **25 passed**.
- `npx tsc --noEmit` and `git diff --check`: passed.

Evidence: `/private/tmp/codeflow-qa-continue/side-browser.log`, `side-policy.log`, `side-unit.log`, `side-adjacent.log`, `side-regressions.log`, `side-tsc.log`. Screenshots and raw server/browser logs are in `/private/tmp/codeflow-qa-side-notes-terminal/output/playwright/qa-side-notes-terminal/`: `offline-conflict.png`, `terminal-gone.png`, `split-history.png`, `ask-warning.png`, `server.log`, `browser.json`. The browser log records **zero application console/page errors and zero 5xx responses**; intentionally aborted notes saves and connection/stream failures during actual server stops are listed separately with their URLs. Server output contains the known Node SQLite experimental warning and normal start/stop messages. All test servers and browsers are stopped at teardown; scratch repositories/homes are removed.

No issue in this cluster remains open. The original reports below are retained as historical repro evidence.

## Issues

### t09-2 · major · Notes: a recovered offline draft silently overwrites a newer note saved from another window or device

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-27.

**Repro**

> 1. Project → side panel → Notes (repository scope); type text and wait for 'Saved just now'.
> 2. Go offline for saves (block POST /api/notes, or stop the server). Type 'offline draft …'; the status reads 'Couldn't save … Your draft is kept in this browser'. Close the tab.
> 3. In another window or device (or POST /api/notes with the current expectedRevision), save 'PHONE EDIT'.
> 4. Reopen code-flow Notes in the first browser.

**Expected:** The recovered draft was based on an older revision, so the conflict banner ('This note changed in another window…') appears and the user chooses.

**Actual:** The draft is loaded with the current server revision as its base and autosaved straight away; the footer shows 'Saved just now'. 'PHONE EDIT' is silently replaced and survives only in Revision history; no conflict UI is shown. Reproduced 2/2 (server revs 6→7 and 8→9). A stale draft left by an unclean browser exit overwrote rev 5 with older v2 text the same way (rev 6).

**Root cause (verifier):** The draft is saved without the revision it was based on, and on load it is rebased onto whatever the server has now.

- ui/side.tsx:362: the text area's onInput saves only the plain text (`store.set(\`notes-draft:${key}\`, value)`), on every keystroke. The draft has no base revision or base text. It is removed only after a successful save of identical text (side.tsx:292), so any tab close or crash within the 600 ms debounce, or any failed save, leaves a draft behind.
- ui/side.tsx:262-270: the load effect reads that draft, calls setText(draft), and then sets `bases.current.set(key, { text: n.text, revision: n.revision })` using the CURRENT server note, plus setLatest(null). The stale draft now looks like a fresh edit on top of the newest revision.
- ui/side.tsx:283-291: the autosave effect sees saved.text !== text and posts `expectedRevision: base.revision`, which equals the server's current revision. The server's optimistic-concurrency check (src/notes.ts update(): `current.revision !== expectedRevision` → NotesConflictError/409) therefore always passes. The conflict path at side.tsx:296-298, which sets `latest` and shows the banner at side.tsx:360, only runs when a POST fails, so …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/side.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Store each draft together with the version it was based on, and route recovery through the existing conflict banner.

1. Save the draft as JSON: `{ v: 1, text, baseRevision, baseText }`. Add small readDraft/writeDraft helpers in side.tsx. readDraft accepts a legacy plain-string draft and treats its base as unknown.
2. In onInput (side.tsx:362), write the draft with `bases.current.get(key)` (revision and text) as its base.
3. When a save succeeds (side.tsx:290-292):
   - if the stored draft's text equals the saved text, remove it as now;
   - otherwise rewrite it with baseRevision/baseText set to the newly saved revision, so a later reload doesn't report a false conflict.
4. In the load effect (side.tsx:262-270), when a draft exists and draft.text !== n.text:
   - if draft.baseRevision === n.revision, keep today's behaviour: set bases to n and autosave the recovered draft.
   - otherwise (base unknown, or the server moved on), still set saved/bases to n and setText(draft.text), but also …

**Suggested regression test:** Add a browser test to test/e2e/ui.e2e.ts next to the existing "Notes: saved as you type" block, or in a new test/e2e/notes-drafts.e2e.ts.

Setup:
1. Fill the note and wait for "Saved just now". Read rev R from GET /api/notes.
2. Call context.route('**/api/notes', aborting POST requests), fill "offline draft", and wait for the footer to match /Couldn't save/.
3. Close the page and unroute.
4. POST /api/notes {key, text: 'PHONE EDIT', expectedRevision: R}. Assert the response has revision R+1.
5.  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4643 on 127.0.0.1:4643, project MQTT-MCP (p-ef01794b), side panel, Notes, repository scope. The "laptop" was a persistent Chrome profile and the "phone" was a separate fresh browser, both driven through the UI. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4643/ (notes-a, notes-b/b2/b3, notes-c; .mjs and .log).

Trial A, saves blocked:
1. The laptop typed "laptop A v1" and the footer showed "Saved just now" (rev 1).
2. With POST /api/notes aborted, the laptop typed "offline draft A". The footer read "Couldn't save: Can't reach code-flow… Your draft is kept in this browser."; localStorage held notes-draft:<repo>.
3. I closed the tab. The phone UI showed "laptop A v1" and saved "PHONE EDIT A - newer" (rev 2).
4. On a new laptop tab, the Notes text area showed the offline draft, the footer read "Saved just now", there was no .notes-conflict, and the server went to rev 3 = "offline draft A…".

Trial B, real outage and full browser close:
1. I stopped my QA server and typed "offline draft B…" (same "Couldn't save" message), then closed the whole laptop browser.
2. After restarting the server, the phone saved "PHONE EDIT B - newer" (rev 4).
3. The relaunched laptop profile autosaved the draft as rev 5 with no conflict UI and no console errors.

Trial C, no outage at all:
1. The laptop typed "quick edit C…" and closed the tab 150 ms later, inside the 600 ms autosave debounce. The server stayed at rev 5.
2. The phone saved "PHONE EDIT C - newer" (rev 6).
3. On reopen, polling the footer every 40 ms showed "Loading…" (+64 ms), then "Saving…" (+110 ms), then "Saved just now" (+723 ms). "Recovered your unsaved draft" never appeared, there was no conflict UI, and the server went to rev 7 with the stale text.

Final history: 7 quick-edit-C, 6 PHONE C, 5 draft B, 4 PHONE B, 3 draft A, 2 PHONE A, 1 v1. Every phone edit was silently replaced and survives only in Revision history.

Refutation checks:
- Nothing in docs supports this behaviour. docs/application-improvements.md:35 marks "Notes initialization, failed-write recovery, revision history, and conflicts" as done. src/notes.ts says the notes exist so "the same notes show on your phone". The server enforces expectedRevision with 409 (src/notes.ts update()).
- It does not depend on the tester's selectors, credentials or environment: my scripts are independent of theirs, and trial B used a real …

</details>

### t09-16 · minor · Notes: switching repository/General within 600ms of typing cancels the save

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-27, SIDE-GAP-02.

**Repro**

> 1. In the repo note type 'v4…' and click General immediately.
> 2. Check GET /api/notes?key=<repo>.

**Expected:** The edit is saved, or flushed before the scope changes.

**Actual:** The server keeps the old text (rev 3). The edit stays only in this browser's localStorage and is saved when you come back to that scope, so other devices never see it if you don't.

**Root cause (verifier):** The cause is in ui/side.tsx, NotesTab.

ui/side.tsx:282-303: the autosave effect depends on `[text, key, ready, saved?.revision, latest]`. Its cleanup `return () => clearTimeout(timer)` (line 302) runs when `key` changes, either from the repo/General buttons (lines 312/315), from the side panel following another project or run (`here = sideScope.value.repo`, line 240, feeding `key` at line 246), or from picking a search hit (`pickedNote`). That cleanup drops the pending 600 ms save and nothing sends it.

The edit survives only in localStorage `notes-draft:<key>`, written in the textarea onInput at line 362. It is sent only if that same browser later reopens that key: the load effect at lines 259-279 reads the draft and the save effect posts it.

Two things in the docs and comments say the current behaviour is not intended:
- docs/runs.md:106 says notes are "saved as you type in ~/.codeflow/notes.json, so it's the same on your phone".
- src/notes.ts:6-9 says the same.
The comment at line 281 ("Browser drafts survive navigation and an unavailable server") describes the draft as a fallback, not as the intended way to save.

There is an aggravating defect at line 267. When the stale dr …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/side.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** In ui/side.tsx NotesTab:

1. Move the queued write into a `flush(key, text)` helper, reusing the existing body of lines 287-299 on the `saving` promise chain with the per-key `bases` map.
2. Keep the pending edit in a ref (`pending.current = { key, text }`), set when the timer is armed and cleared when the write runs.
3. In the effect cleanup, if the cleanup is due to a key change or an unmount and `pending.current` holds a different text than the base, call `flush(pending.key, pending.text)` instead of only `clearTimeout`. A simple way is to have the cleanup always flush when `pending.current?.key !== activeKey.current`, or to add a separate `useEffect(() => () => flushPending(), [key])`.
4. Because `activeKey.current` already guards the UI updates (lines 293/295), a background flush for the old key will not disturb the new scope. On a conflict it should keep the draft and show the conflict banner the next time that key is opened.
5. Optionally also flush on `pagehide`/`visibilitychan …

**Suggested regression test:** Add to test/e2e/ui.e2e.ts, in the side panel Notes section next to the existing "Notes: saved as you type" block around lines 624-629.

First case, scope switch:
- In the repo scope, fill the Notes textbox with "fast-switch edit".
- Immediately click the "General" button in the "Which notes" group, without waiting for "Saved just now".
- Poll GET /api/notes?key=<realpath(repo)> for up to 3 s and assert `text === "fast-switch edit"`.
- Assert the General note is unchanged.

Second case, a run or  …

<details><summary>Verifier's independent reproduction</summary>

Port 4671 was already held by another agent's QA server (home v4669t0915), which I left alone. I started my own fresh fake-mode server as v4673 on my extra port 4673 (`qa-server.sh start v4673 4673 fake`) and checked that the built bundle public/assets/chunk-TK6JP642.js contains the same 600 ms debounce and cleanup as ui/side.tsx. Using headless Chrome on http://127.0.0.1:4673, I opened project MQTT-MCP (#/project/p-ef01794b), then Side panel > Notes. Notes are stored in the QA home, so no repo was touched.

Script work/v4673/notes1.mjs:
- Typed "repo v1" and waited 1.5 s. The server had rev1 "repo v1".
- Typed " then v2", waited 300 ms, then clicked General (313 ms after the last key).
- 2.5 s later the server still had rev1 "repo v1". localStorage held notes-draft:<repo> = "repo v1 then v2". The General note stayed rev0, so nothing was written to the wrong key. The footer showed nothing ("Saved…" is gone and there is no "unsaved" hint; screenshot shots/v4673/001-after-fast-switch.png).
- 7.5 s later it was still rev1. Only one POST had been sent.
- Clicking MQTT-MCP again loaded the draft and saved it as rev2.
- Control: typing and switching to the Files tab within 200 ms does save (rev3), because the panes stay mounted. Only a change of `key` triggers the bug.

Script notes2.mjs:
- Typed " | nav-edit", then 250 ms later opened another project (#/project/p-3b74eba4, OPCUA-MCP). The side panel followed it (scope buttons became "OPCUA-MCP / General") and MQTT stayed at rev3 on the server.
- A second fresh browser opening the MQTT note showed the old text "repo v1 then v2 v3".
- Reloading the first browser while on OPCUA did not flush the edit either.

Script notes3.mjs (persistent profile):
- Typed " | device1 edit", then 250 ms later clicked General. The server stayed at rev3.
- Another client then saved rev4 "... | device2 edit" through POST /api/notes with expectedRevision 3.
- When device 1 went back to MQTT-MCP, the footer went "" > "Saving…" > "Saved just now". The server became rev5 "repo v1 then v2 v3 | device1 edit". No conflict banner appeared, and the "Recovered your unsaved draft" status was overwritten at once. Device 2's edit was silently replaced; it survives only as rev4 in Revision history.

No console errors and no 5xx responses. Server stopped; no runs were created.

</details>

### t09-17 · cosmetic · Notes save error has doubled punctuation

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-27.

**Repro**

> Block POST /api/notes and type in Notes.

**Expected:** Clean sentence.

**Actual:** 'Couldn't save: Can't reach code-flow. Is the server still running?. Your draft is kept in this browser.'

**Root cause (verifier):** ui/side.tsx:296 builds the message as a template: `Couldn't save: ${(error as Error).message}. Your draft is kept in this browser.`. It always adds ". " after the error message. When fetch rejects (server down or network gone), ui/lib.ts:71 (fetchJson) throws ApiError("Can't reach code-flow. Is the server still running?", 0). That message already ends in "?", so the result is "running?. Your draft". Server-side note errors from src/notes.ts:56-58 and src/server.ts:2294-2296 have no closing punctuation, so for them the appended "." reads fine. The network-failure path is the one that shows the bug, and it is also the most common way a save fails. The same "${message}. ..." pattern appears in ui/experience.tsx:118, ui/state.ts:1335, ui/review.tsx:95, ui/memory.tsx:153 and ui/onboarding.tsx:97. Each of these would show the same "?." whenever its request fails at the network level.

**Files:** `ui/side.tsx`, `ui/lib.ts`, `ui/experience.tsx`, `ui/state.ts`, `ui/review.tsx`, `ui/memory.tsx`

**Suggested fix:** Add a small helper in ui/lib.ts, for example `export const asSentence = (m: string) => /[.!?…]$/.test(m.trim()) ? m.trim() : `${m.trim()}.`;`. Use it where an error message is followed by more text: in ui/side.tsx:296, `setStatus(`Couldn't save: ${asSentence((error as Error).message)} Your draft is kept in this browser.`)`. Apply the same change at the other sites that have this pattern (experience.tsx:118, state.ts:1335, review.tsx:95, memory.tsx:153, and onboarding.tsx:97 if it can receive network errors). A lighter fix would reword ui/lib.ts:71 so it doesn't end in "?". I don't recommend it: other callers show that message on its own, and the question reads naturally there.

**Suggested regression test:** Unit test: add test/ui-messages.test.ts (or put it next to the existing UI helper tests) and assert:
- asSentence("Can't reach code-flow. Is the server still running?") === "Can't reach code-flow. Is the server still running?"
- asSentence("A note can hold 1,000,000 characters at most") ends with a single "."
- asSentence("Done.") is unchanged

End-to-end: in test/e2e/ui.e2e.ts, next to the existing Notes step (around line 624), call page.route('**/api/notes', r => r.request().method()==='POST'  …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server, v4673 on 127.0.0.1:4673, with an empty home: no runs and no notes.json. The browser was a fresh headless Chrome with no saved profile. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4673/.

(1) notes-err.mjs: open "/", open the side panel, click #side-tab-notes, route POST **/api/notes to abort('internetdisconnected'), then type "draft typed while abort" into the Notes textbox and wait 2.5s. The .notes-foot text read: "Couldn't save: Can't reach code-flow. Is the server still running?. Your draft is kept in this browser." The screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4673/001-notes-abort.png shows "running?. Your draft" in the footer under the textarea.

(2) notes-down.mjs: to rule out the route interception as the cause, I loaded the Notes tab, actually stopped the QA server with qa-server.sh stop v4673, and typed into Notes with no request interception. I got the same text: "...Is the server still running?. Your draft is kept in this browser." So the reporter's script and environment are not the cause; this is what a user sees whenever the server goes down while they edit notes.

The docs (docs/runs.md, the Notes paragraph) describe no special wording here, so this is not by design. Cleanup: I stopped the server, created no runs, and the ports are free.

</details>

### t08-6 · minor · After a code-flow restart the panel's terminal is silently replaced by a new shell; the 'terminal is gone' notice never shows

Source: tester unit side-panel-previews-1; observed with fake-agents; features SIDE-13.

**Repro**

> 1. Side panel → Terminal; run 'cd packages; echo BEFORE_RESTART' so the output and cwd are visible.
> 2. Restart the server (qa-server.sh restart).
> 3. Watch the terminal; I sampled the xterm rows every 250ms.

**Expected:** The old terminal says 'This terminal is gone (code-flow restarted?). Restart opens a new one in the same folder.' (ui/terminal.tsx GONE), keeping its last output, until I press Restart.

**Actual:** Within about 1s of reconnecting, the pane is blank and then a fresh login shell in the repository root appears. The previous output, the cwd and the notice are lost with no explanation.

**Root cause (verifier):** The "gone" note can only be written by a mounted TermView that receives the stream's 404 error event. After a restart, two separate mechanisms make sure that never happens.

(1) The shell poll unmounts the pane first.
- `ui/terminal.tsx:39-41`: `alive()` keeps only shell ids that the 3s `/api/shell` poll still lists. `open = memo.shells.filter(alive)` and `top = ... open[0]`.
- When the restarted server answers [], `top` becomes undefined and `pane()` (`ui/terminal.tsx:141-142`) unmounts the TermView, along with its xterm scrollback and its `shell:<id>` subscription (`ui/terminal.tsx:375`). It renders "Opening a shell…" in its place.
- So the error handler at `ui/terminal.tsx:331-335` (`t.write(note(ev.message || GONE))`) is never reached.
- The first-shell effect at `ui/terminal.tsx:76` exits early because `started.current === s.key`. Without a reload, the pane therefore stays on "Opening a shell…" indefinitely (run B).

(2) The stream reconnect reloads the page.
- `src/server.ts:1443` creates a new random streamSharing `{channelKey, lockId}` every time the server starts.
- On reconnect, `ui/stream.ts:174` compares it with the stored value, sees a mismatch, and calls `location.rel …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/terminal.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/stream.ts`

**Suggested fix:** In TerminalTab (`ui/terminal.tsx`), stop dropping remembered shells the server no longer lists without telling the user. Treat them as "gone" instead.

1. Keep remembered ids that the poll no longer lists. Put them in a `gone` set, or remember `{id, cwd}` in sideMemo so the folder survives a reload; ShellInfo.cwd is already known before the restart.
2. Render each gone id as a small placeholder pane, either a stopped TermView or a static notice, showing GONE ("This terminal is gone (code-flow restarted?). Restart opens a new one in the same folder."). Give it the Restart button, which calls `replace(old, cwd)` using the remembered cwd. In the strip, mark the entry with note "gone".
3. Count gone panes in `open.length` so the first-shell effect at `ui/terminal.tsx:76` does not quietly open a new shell after the reload. A new shell then opens only when the user presses Restart or +.
4. Optionally keep the last ~N lines of xterm output in sessionStorage per shell id, so the notice can sit …

**Suggested regression test:** Add a UI test, either a Playwright e2e or a preact unit test of TerminalTab with stubbed `api`/`post`/`subscribe`.

Arrange:
- Seed `sideMemory` with `{shells:["sh1"], shell:"sh1"}` and the sh1 cwd.
- Have `GET /api/shell` return [] (as after a restart), first mounting fresh to simulate the reload.

Assert:
- (a) The pane text contains "This terminal is gone (code-flow restarted?)".
- (b) No `POST /api/shell` is sent until the Restart button is clicked.
- (c) Clicking Restart sends `POST /api/sh …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server named v4679t on port 4679. I used a new home because the v4679 home already had leftovers from an earlier verifier. I added a scratch clone of MQTT-MCP through "Open another repository", opened the side panel and then the Terminal tab, and typed `cd mqtt-python; echo BEFORE_RESTART; pwd`. Then I restarted the server in the background (stop, wait for the port to free, start) while sampling the pane every 250ms and logging page navigations and /api/shell and /api/auth/self traffic. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4679t/repro.mjs. Logs: repro-a.log and repro-b.log in that folder. Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4679t/006-a-final.png and 004-b-final.png.

Run A (normal):
- 7.05s: restart begins.
- 9.43s: server is back.
- 11.53s: the 3s poll `GET /api/shell` returns [].
- 11.63s: the TermView unmounts and the pane shows only "Opening a shell…". The old output is gone.
- 12.59s: the stream reconnect probe calls `/api/auth/self`, which now has a new streamSharing.
- 12.60s: the page does a full `location.reload()`.
- 12.65s: the reloaded page sends `POST /api/shell`, which creates a new shell in the repository root.
- 12.99s: a fresh prompt appears in the repository root, not mqtt-python.
- The "gone" note never appeared.

Run B (same steps, but a Playwright route made `/api/auth/self` return the pre-restart streamSharing, so the page does not reload):
- 9.22s: the poll returns [].
- 9.25s: the pane switches to "Opening a shell…".
- 11.74s: the stream reconnects. No shell subscription is left, so no "gone" note arrives.
- The pane then stayed on "Opening a shell…" for the remaining 35s, with no strip entry and no shell created.

Why this is not the tester's setup:
- It happens with a fresh browser profile and with my own selectors.
- No document says the notice is meant to be skipped. The GONE constant and the TerminalGone comment both name "code-flow restarted" as the case it is for.
- The extra `compdef` line in the new shell comes from the user's zsh profile and is unrelated.
- One `qa-server.sh restart` attempt failed with "port busy" (the old process had not released the port yet). That is a quirk of the QA script, so I stopped, waited for the port and started again instead.

</details>

### t08-10 · minor · Line-based terminal ↑ history is shared across all repositories and scopes

Source: tester unit side-panel-previews-1; observed with fake-agents; features SIDE-15.

**Repro**

> 1. Start the server with CODEFLOW_PYTHON=/nonexistent.
> 2. In project t08 Studio's terminal, run 'less ../README.md | head -2'.
> 3. Switch the composer to t08 Health; in its terminal press ↑.

**Expected:** History per terminal or repository, so a command meant for one repo isn't one keystroke away in another; or at least clearly global.

**Actual:** The t08 Health terminal recalls 'less ../README.md | head -2' typed in t08 Studio. This is arguably similar to zsh's global HISTFILE, so it's low risk.

**Root cause (verifier):** The bug is in ui/terminal.tsx, ShellView (the line-based shell used when python3 is unavailable).

- Line 448: `useState<string[]>(() => store.json("termHistory", []))` reads one localStorage key, "termHistory". store/workspaceKey in ui/lib.ts:96-123 only adds an `ssh:<id>:` prefix for SSH workspaces. So every line-based terminal in every project, run, worktree and repository on the same computer shares one list.
- Line 483-485, send(): computes `next = [text, ...history.filter(...)]` from this view's in-memory copy, then writes the whole list with `store.set("termHistory", JSON.stringify(next))`.
- Lines 538-547: ↑/↓ read only that in-memory copy.

Each mounted ShellView keeps a private snapshot taken when it mounts. Two views shown at once (Split, or a terminal kept mounted behind another) never see each other's new commands, and whichever writes last silently erases the other's entries in storage. So the history is global for terminals opened later, which is the reported cross-repository recall, but stale and lossy for terminals already open.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/terminal.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** 1. Move the line-terminal history into a small helper, e.g. ui/term-history.ts, with:
   - `historyKey(cwd, places)`: return `termHistory:<place.path>`, where the place is the longest entry in `places` containing the shell's starting cwd (same matching as placeName in ui/panel-bits.tsx:48). Fall back to the cwd. This gives each repository and each run worktree its own history, which survives Restart and reloads.
   - `loadHistory(key)`.
   - `pushHistory(key, text)`: re-read storage right before writing, then dedupe and cap at 100, so concurrent views never overwrite each other.
2. In ShellView:
   - Fix the key once, from the cwd in the first hello. Do not use `shell.cwd`, which changes after `cd`.
   - On ↑, re-read from storage, or keep a shared signal per key, so two panes on the same repository see each other's commands.
3. Optional: migrate the old global "termHistory" once (seed every key from it or just drop it), and keep the workspaceKey SSH prefix.
4. If the team prefers a gl …

**Suggested regression test:** Unit test: new test/term-history.test.ts using the localStorage stub pattern from test/repo-selection-ui.test.ts.
- Pushing "a" under repository A and "b" under repository B: loadHistory(A) is ["a"] and loadHistory(B) is ["b"].
- With two simultaneous writers on the same key (call pushHistory twice, no reload in between), both entries are kept: ["y","x"].
- A cwd inside a place (repo/sub after `cd`) maps to the same key as the place.

E2E test: add to test/e2e/ui.e2e.ts, starting the server with …

<details><summary>Verifier's independent reproduction</summary>

Setup:
- Exported CODEFLOW_PYTHON=/nonexistent, then ran `qa-server.sh start v4687 4687 fake`.
- /api/health reported interactiveTerminal:false. The home had no live runs, only two old .deleted markers.
- The browser was a fresh Playwright context with no profile, so localStorage started empty (logged `termHistory at start: {}`). This rules out the reporter's persistent "t08p" profile as the cause.
- Made two new one-commit scratch repos, clones/v4687-alpha and clones/v4687-beta, and added them through the UI with "Open another repository" as projects "v4687 Alpha" and "v4687 Beta".

Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4687/repro.mjs (log: repro.log in the same folder).

Steps and results:
1. Composer set to v4687 Alpha, side panel on Terminal, line-based help shown, prompt "v4687-alpha $". Ran `echo ALPHA_ONLY_$((1+1)) && basename $(pwd)`; output was ALPHA_ONLY_2 and v4687-alpha. localStorage then held one global key, termHistory = ["echo ALPHA_ONLY_..."].
2. Switched the composer to v4687 Beta. The panel showed "Following v4687 Beta", prompt "v4687-beta $", input empty. Pressing ↑ filled in "echo ALPHA_ONLY_$((1+1)) && basename $(pwd)". This is the reported bug. Screenshot shots/v4687/002-beta-arrowup.png shows the beta prompt holding Alpha's command, with no sign that the history is shared.
3. Extra finding: the history is not even consistently global. With Split in Beta (two line-based ShellViews mounted):
   - Typed `echo TOP_CMD` in the top pane; storage became [TOP_CMD, ALPHA...].
   - ↑ in the bottom pane gave ALPHA..., not TOP_CMD.
   - Typed `echo BOTTOM_CMD` in the bottom pane; storage became [BOTTOM_CMD, ALPHA...], so TOP_CMD was gone.
   - ↑ in the top pane gave TOP_CMD, not BOTTOM_CMD.
   - After a reload, storage was still missing TOP_CMD.

No console or 5xx errors. One run reproduced it fully.

Not by design:
- docs/runs.md:98 only says that without python3 "↑/↓ recall commands", and says nothing about scope.
- docs/runs.md:89 says "Each run and project remembers its own tab, chats, terminals...".
- No code comment explains the single key.
- The interactive mode uses the shell's own HISTFILE, which is also per-user. That makes cross-repository recall defensible as a design, but the lost entries in step 3 are a defect either way.

Cleanup: stopped the v4687 server (ports 4687/4689 free). Created no runs. Shells closed with the server. Removed both  …

</details>

### t00-2 · minor · Integrated terminal colours lag one theme switch behind (dark app → light terminal, light app → dark terminal)

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-09.

**Repro**

> 1. Fake QA server, open a project page (e.g. #/project/<id>), command palette → 'Open terminal'.
> 2. Click the top-bar moon (Use the dark theme).
> 3. Click the sun (Use the light theme).

**Expected:** The terminal palette matches the app theme after each switch.

**Actual:** After switching to dark, the terminal keeps the light palette: white background, rows colour rgb(41,42,38). After switching back to light, it shows the dark palette: black background, rows colour rgb(236,235,228). Each toggle shows the previous theme. Reproduced in two separate scripts.

**Root cause (verifier):** ui/theme.ts:45-49, apply(): it writes `theme.value = effective()` first and only afterwards sets `root.dataset.theme = theme.value` (line 48).
ui/terminal.tsx:324-326 registers `effect(() => { if (theme.value) t.options.theme = termTheme(); })`. A Preact signal write outside a batch runs dependent effects synchronously, so this effect runs inside apply() before line 48.
termTheme() (ui/terminal.tsx:415-419) reads `--sunken`, `--text` and `--ink` with getComputedStyle(document.documentElement). The `[data-theme]` selectors in ui/styles.css:38-61 still match the old theme at that moment, so background, foreground and cursor come from the previous theme. The ANSI palette branch (`dark = theme.value === "dark"`) uses the new theme. Result: wrong base colours, plus ANSI colours meant for the opposite background, so coloured output has poor contrast.
Neither the effect nor apply() reruns once data-theme is updated (the theme signal does not change again), so the terminal stays one switch behind until the next switch or a reload. A reload looks right because index.html:9 sets data-theme before xterm is constructed.
Every path that calls apply() is affected: the top-bar toggle, Settings →  …

**Files:** `ui/theme.ts`, `ui/terminal.tsx`, `test/e2e/ui.e2e.ts`, `test/theme.test.ts`

**Suggested fix:** In ui/theme.ts apply(), switch the stylesheet before notifying subscribers:
  const next = effective();
  if (root) root.dataset.theme = next;   // CSS variables first: the terminal reads them when `theme` changes
  theme.value = next;
  themeChoice.value = picked() ?? "system";
I verified this exact change in a snapshot build: 0 mismatches for both the toggle and the system-scheme path.
Optional hardening, so the terminal does not depend on the write order: termTheme() could choose its base colours from `theme.value` with the hard-coded light/dark fallbacks it already has, instead of reading the computed CSS. Or the terminal effect could defer the getComputedStyle read with queueMicrotask/requestAnimationFrame.

**Suggested regression test:** Two options:
(1) Cheap unit test, test/theme.test.ts (node:test, no browser). Before a dynamic import of ../ui/theme.ts, stub globalThis.document = { documentElement: { dataset: {} } } and a Map-backed globalThis.localStorage. Register `effect(() => seen.push([theme.value, document.documentElement.dataset.theme]))` from @preact/signals. Call setTheme("dark") and then setTheme("light"). Assert that every recorded pair has equal values, e.g. the last entry deepEquals ["light","light"]. This fails  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server "v4645t" on 127.0.0.1:4645 with a fresh QA home. Fresh headless Chrome with no profile and a light system scheme. The built bundle (public/assets/chunk-NVQ45BMV.js) has the same apply() order as the source. Steps: opened #/project/p-ef01794b (MQTT-MCP), then command palette, "Open terminal", Enter, which opens the side-panel Terminal tab with the zsh prompt. Clicked the top-bar toggle (header.topbar button[aria-label^='Use the']) several times. After each click I read data-theme and the computed colour of .xterm-rows, and sampled a screenshot pixel inside .xterm-screen.
Results (work/v4645t/term-theme.log and baseline.log):
- Start, light: term bg rgb(240,239,233) = light --sunken; text rgb(41,42,38). Correct.
- Toggle to dark: app dark, but term bg rgb(240,239,233) and text rgb(41,42,38). Wrong, light palette.
- Toggle to light: app light, but term bg rgb(18,19,16) = dark --sunken; text rgb(236,235,228). Wrong, dark palette.
- Toggle to dark again: light palette again. Wrong.
- Reload while dark: terminal correct (dark). Toggling to light then gives a dark terminal. Wrong.
- Following the system (no pick; page.emulateMedia colorScheme dark, then light): same lag, 2 of 2 wrong.
Total: 5 mismatches across two separate scripts, no console or page errors.
Screenshots: shots/v4645t/002-B-to-dark.png shows a dark app with a light terminal; shots/v4645t/003-C-to-light.png shows a light app with a black terminal.
Fix check: I copied the source with "qa-server.sh snapshot v4645t" and patched only builds/v4645t/ui/theme.ts apply() to set root.dataset.theme before theme.value. I rebuilt the UI and ran it as "v4645p" on 4645; port 4647 is held by another agent's server, pid 91903, which I did not touch. The same script then gave mismatches=0 in all 7 states, for both the toggle and the system path (work/v4645t/patched.log).
Cleanup: both servers stopped; no runs created (runs/ is empty in both homes); no leftover processes. The dogfood source and target repos were not modified.

</details>

### t08-7 · minor · Side panel has no pop-out (↗) button; the popped-out panel is URL-only and has rough edges

Source: tester unit side-panel-previews-1; observed with fake-agents; features SIDE-04.

**Repro**

> 1. Open any run with the side panel; look at the scope header buttons.
> 2. Type #/side/files/run:<deleted-id> in a window.
> 3. Type #/side/chat/run:<id> in the main tab, press '?', then click the crumb link.

**Expected:** docs/runs.md:89: '↗ opens the tab in a window of its own … and the panel here closes.' A bad scope should say the run isn't found; there should be a way back to the full app.

**Actual:** The scope header has only Pin, Expand and Close. The popped window works only if you type the URL. A bad or deleted run scope shows 'Own window · No repository chosen · Choose a repository first.' #/side in the main tab removes the rail, kills shortcuts ('?' does nothing), and links open a new window.

**Root cause (verifier):** 1. Stale docs. docs/runs.md:89 says "**↗** opens the tab in a window of its own, for that run or project, and the panel here closes." docs/configuration.md:83 and docs/ssh-projects.md:45 also describe popped-out panels. Commit 29628ea ("Add desktop Agent and Team workspace…") removed popOut() and the "Open in its own window" button from ScopeHeader on purpose, now ui/side.tsx:131-186, and docs/plans/agent-mode-validation.md:68 records it: "The former popup control is replaced by Expand." The user docs were never updated. A likely reason for the removal: the desktop shell denies window.open (integrations/desktop/main.cjs:48 setWindowOpenHandler returns deny).
2. Orphaned route. The popped-panel machinery is still in place: route parsing at ui/navigation.ts:54, the PoppedSide branch at ui/app.tsx:74-105, and poppedScope plus the handOff logic at ui/state.ts:418 and 570-626. Since nothing navigates to #/side anymore, you can only get there by typing the URL or opening an old bookmark.
3. Misleading message for a bad scope. In ui/state.ts:432-434, sideScope does `scopeFromKey(popped) ?? waitingScope(popped, true)`. scopeFromKey (ui/state.ts:419-429) returns undefined when the run is un …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/configuration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/ssh-projects.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/side.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/navigation.ts`

**Suggested fix:** First fix the docs, since the button was removed on purpose. In docs/runs.md:89, replace the ↗ sentence with what Expand does: "Expand fills the app window; Restore or Esc returns to the split view". Then either drop the popped-out wording from docs/configuration.md:83 and docs/ssh-projects.md:45, or describe the route as a hidden, URL-only feature.
For the leftover #/side route, choose one of two options:
(a) Remove it. Delete the PoppedSide/poppedScope/handOff code, and make routeFromHash turn #/side/<tab>/run:<id> into { view: "run", id } with the side panel opened on <tab>, so old bookmarks still land somewhere sensible.
(b) Keep it, but make it robust:
- Give SideScope a `missing: true` state. In ui/state.ts, when a popped key's run or project has loaded and is absent, return that state instead of an empty waitingScope.
- In ui/side.tsx ScopeHeader and the side body, show "This run no longer exists" or "Project not found", plus an "Open code-flow" link (href "#/") that handOffLink …

**Suggested regression test:** 1. In test/scope.test.ts, after loadProjects/refreshRuns resolve: set route to popped("run:gone"), assert sideScope.value.waiting is falsy, and assert sideScope.value.missing === true (or that the key maps to a not-found state, not { repo: "" }). Do the same for popped("project:gone").
2. In test/e2e/ui.e2e.ts, next to the existing "The panel in a window of its own" block (around lines 857-863): open #/side/files/run:does-not-exist and assert .side-scope contains /no longer exists|not found/i, d …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server named v4681s on port 4681, with a new home at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4681s, against a scratch git repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4681s/repo. I created 2 solo runs (fake claude) and deleted one through DELETE /api/runs/:id. Then I ran /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4681s/repro.mjs in a fresh headless Chrome. The log is repro.log in the same folder. Results:
(1) On #/run/<id> with the side panel open, the scope header has only these buttons: ["Pin the panel to this run","Expand side panel","Close side panel"]. There are 0 window or pop-out controls anywhere, and the command palette has no pop-out command. Screenshot: shots/v4681s/001-run-side-header.png.
(2) A new page at #/side/files/run:<deleted id>, and the same with a never-existing id, shows the scope "Own window / No repository chosen" and the body "Choose a repository first. / Choose a repository or run worktree." It does not say the run is gone, and it has no link back to the app. Screenshot: shots/v4681s/popped-deleted.png. A valid run id renders correctly: "Own window / repo › QA side panel keep run".
(3) Opening #/side/chat/run:<id> in the main tab gives .rail count 0. Pressing '?' opens no dialog. Clicking the crumb link opens a second page (pages 1 to 2, new url #/run/<id>) and the tab stays on #/side/....
The console showed no errors. Part of the report is by design:
- The button was removed on purpose. docs/plans/agent-mode-validation.md:68 says "The former popup control is replaced by Expand." git show 29628ea -- ui/side.tsx shows popOut() and the "Open in its own window" button being deleted.
- Point (3) is how a popped-out window is meant to work. PoppedSide renders no rail or dialogs, and test/scope.test.ts:215 checks that a panel with no opener opens a new main window.
What is still wrong: the user-facing docs promise a control that no longer exists, the #/side route survives only as a URL you type by hand, and that route mislabels unknown or deleted runs.

</details>

### t08-8 · minor · No Stop control for a running chat in the side panel's ChatView

Source: tester unit side-panel-previews-1; observed with fake-agents; features SIDE-09.

**Repro**

> 1. Composer project → side panel Chat → send a message (creates a chat run).
> 2. While its reply runs, look for Stop in the panel.
> 3. Type 'stop' and press Enter.

**Expected:** A visible Stop, as the run page header has (ui/run.tsx:270), since the feature is 'reply, stop, resume in panel'.

**Actual:** Visible buttons while running: strip, New chat, All chats, Show work, AI team, Send; no Stop. Only typing the word 'stop' stops it (toast 'Stopped — work is saved'), which nothing in the panel mentions. The ▶ Resume shown afterwards works.

**Root cause (verifier):** ui/side-chat.tsx:412-468 (ChatView) renders only the chat-meta row (lines 437-447: AgentTag, status pill, branch, check note, an "Open" link), the thread, a Resume box for ended runs (455-462), and ConversationBar (465). It has no control that calls POST /api/runs/:id/cancel while run.status === "running".

The only Stop for a chat lives in RunView's header at ui/run.tsx:261-272, which skips the confirmation when `chat` is true and labels the button "Stop". The panel has no equivalent.

ConversationBar (ui/run.tsx:1771-2013) has no stop control either. It only routes the text to /api/runs/:id/notes. The server then treats a bare "stop/cancel/pause…" message as a control: taskTeamControl at src/task-team.ts:47-51, used by Engine.addTeamNote at src/engine.ts:4895-4902, which calls this.cancel(id). So typing "stop" is the only way to stop from the panel. It is undocumented for single-agent chats and contradicts the composer hint. The run can also be stopped by clicking "Open" and using the run page's Stop.

Severity stays minor. Workarounds exist (Open, then Stop; or typing "stop"), Resume works, and no work is lost. It is still a real gap: the panel feature is meant to reply, stop an …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/side-chat.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** In ChatView (ui/side-chat.tsx, chat-meta row around lines 437-447), render a small Stop button when run.status === "running", placed next to the status pill and "Open". It should call post(`/api/runs/${run.id}/cancel`).catch(e => showToast(e.message)), with no confirmation, the same way run.tsx:264 does for chats. Use the stop icon, the label "Stop", and a title such as "Stop this chat; its work stays on its branch".

To keep the two views from drifting, it would be better to extract the header button at ui/run.tsx:261-272 into a shared `StopRunButton({ run, chat, checking })` and use it in both places. The existing ▶ Resume box at side-chat.tsx:455-462 already covers what happens after a stop.

Optionally:
- Add one sentence to the Chat bullet in docs/runs.md:95 saying that Stop in the panel stops a chat's running turn and Resume continues it.
- Either document the typed "stop" control or mention it in the ConversationBar hint.

**Suggested regression test:** Extend test/e2e/ui.e2e.ts, test "side panel: chat with one agent, read a file, run a command, keep a note" (line 582). Run the fake agent slowly for that send (FAKE_SLEEP_MS, or a prompt keyword that holds the turn). After sending from the panel's New chat:
1. Assert that `#side-pane-chat` getByRole("button", { name: "Stop" }) is visible while the run's status is "running".
2. Click it.
3. Assert that /api/runs/:id reaches status "cancelled" and that no confirmation dialog opened.
4. Assert that …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4683 on port 4683, with FAKE_SLEEP_MS=60000 exported so each fake agent turn stays running for 60s. Its home had no live runs. To keep chat worktrees out of the real MQTT-MCP repo, I made scratch clones (bare + working) at qa/clones/v4683-mqtt and used the v4683-mqtt project. The steps are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4683/r1.mjs and r2.mjs. r1 used a persistent profile; r2 used a fresh browser profile with no saved state, so profile state is not the cause.

Steps:
1. Open http://127.0.0.1:4683 and choose project v4683-mqtt in the composer.
2. Open the side panel with the header "Side panel" button and go to the Chat tab.
3. Type "V4683 greeting probe: say hello" in the New chat box and press Enter. This created solo run 2610251934-9534925b, status running, and the panel switched to ChatView showing "Claude Code | Running | Open".

What I saw while it was running:
- Every visible control in #side-pane-chat: strip item, "Close …", "New chat", "All chats", link "Open", "Earlier events", "Latest events", "AI team", "Send". There is no Stop, and the panel text never mentions stop.
- I searched the whole page for controls whose label, text or title contains "stop". The only hit was the earlier run's rail entry, whose task text contained the word.
- The expanded (full-screen) panel also has 0 stop controls.
- Escape in the box does not stop the run.
- The "All chats" menu lists the chat but offers no stop.
- The hint reads "Goes into Claude Code's running turn if it takes messages, otherwise it's sent as soon as the turn ends", which suggests typed text is only a message.
- For comparison I opened #/run/<id> in a second tab. Its header shows a "Stop" button (screenshot 003-t088-runpage.png).

Typing "stop" and pressing Enter POSTs /api/runs/<id>/notes {"text":"stop"}. The toast says "Stopped — work is saved", the run becomes cancelled, and the panel then shows "This chat cancelled. | ▶ Resume". This matches the report.

Screenshots are in qa/shots/v4683/ (001-t088b-running.png shows the running panel with no Stop). There were no console errors and no 5xx responses.

Why this isn't by design: docs/runs.md:95 and :57-63 describe the panel chat as a run you keep talking to, and say a message sent while it works goes into the running turn or the next turn. Nothing documents typed "stop" as a control. git history of ui/side-chat.tsx …

</details>

### t18-19 · minor · Side-chat Ask warning does not name the files it left changed

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT--GAP-01.

**Repro**

> On a finished non-solo run, open a side chat in Ask mode (POST /api/runs/:id/followups kind side, mode ask) with a message containing SNEAKY (fake agent writes sneaky.txt).

**Expected:** The warning names the changed paths ('sneaky.txt'), as docs/security.md:15 says ('what changed is named in a warning').

**Actual:** Warning: 'Side chat: Ask test (claude) is read-only, but build changed while it ran (1 new file). Left as it is…'. The file is left in place (correct) but not named.

**Root cause (verifier):** The warning has no file names because `compareSnapshot` returns only change kinds and counts, never paths:
- src/git.ts:816-858 `changedSince` → `compareSnapshot(..., undo=false)`:
  - line ~831 pushes the literal "commits" (`head !== snap.head`).
  - line ~833 pushes the literal "edits" (uncommitted tree differs).
  - line 841 pushes "`${added.length} new file(s)`" even though the `added` path array is in hand.
  - line ~855 pushes "`${changed.length} untracked file(s) changed`" even though the `changed` paths are in hand.
- src/engine.ts:2742-2746 (the Ask branch in the read-only wrapper, reached because `params.side || this.run.chatLink?.kind === "side"` at 2723) logs only `changed.join(", ")`, e.g. "(1 new file)".

Two more things make it worse:
- The warning goes only to the run's Activity log (`this.log(..., "warn")`). Nothing is attached to the side-chat FollowUp, so SideChatView (ui/side-chat.tsx ~230-275) shows the turn as a plain success under the "Reads the run's worktree; changes nothing." hint.
- test/ship.test.ts:325 locks in the count-only format.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/git.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/side-chat.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ship.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/git-reliability.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/security.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** 1. In `compareSnapshot` (src/git.ts), collect paths alongside the kinds:
   - commits: `git diff --name-only <snap.head> <head>`
   - edits: `git diff --name-only <changesBefore tree or snap.head> <changesNow tree>`, using the stash trees already computed
   - new files: `added`
   - changed or deleted untracked files: `changed.map(([p]) => p)`
2. Return a structured `{ kind, count, paths }[]` or add the names to the existing strings, for example "1 new file: sneaky.txt" or "edits: README.md, src/a.ts". Cap the list at about 5-10 paths plus "and N more" so a huge change doesn't flood the log.
3. Clean the names before use (strip control characters and newlines, quote them). They are file names the agent chose, and they end up in log text and the UI.
4. Use the names in both the Ask warning (src/engine.ts:2744) and the restore warning (2735) so the two stay worded the same.
5. Optional but recommended: also attach the warning to the side-chat FollowUp (for example a `notes`/`warning` fi …

**Suggested regression test:** 1. test/ship.test.ts, the test "a side chat's question keeps the run's verdict and leaves edits you make in the worktree meanwhile" (~line 305): change the assertion at line 325 to require the names, e.g. `assert.match(await logs(run), /changed while it ran \(edits: README\.md; 1 new file: notes\.md\)\. Left as it is/)`, adjusted to the chosen format.
2. Add a fake-agent case that sends a side Ask containing SNEAKY and asserts the warning contains "sneaky.txt" and that sneaky.txt still exists.
3 …

<details><summary>Verifier's independent reproduction</summary>

I moved the old v4639 home aside and started a fresh fake QA server: `qa-server.sh start v4639 4639 fake`. I made a scratch bare clone of MQTT-MCP plus a working clone (v4639-mqtt) and added the working clone in the UI with "Open another repository" as the new project "v4639 MQTT". In the composer I started a Pipeline run (Plan → Build → Review, check `true`), run 2610252215-9c374826. It finished as done/passed with one worktree, "build", which was clean.

On the run page I opened the Side panel. The Chat tab had a new side chat with Chat mode = Ask and Claude Code as the agent. I typed "SNEAKY please just look at the README" and clicked Send. The follow-up finished as kind=side, mode=ask, agent=claude, status=done.

What happened:
- `git status --short` in the build worktree went from clean to `?? sneaky.txt`. The file was left in place, which is correct.
- The run's .jsonl got this warn log: "Side chat: SNEAKY please just look at the README (claude) is read-only, but build changed while it ran (1 new file). Left as it is, since the changes may be yours: look at them before the next change commits them."
- In the UI, the warning only appears under Details and publishing → Activity log (9) · 4 warnings, with the same text. It names no file (screenshot shots/v4639/001-activity-warn.png).
- The side chat thread itself shows only "claude handled the request." with no warning, and the composer under it still says "Reads the run's worktree; changes nothing." (shots/v4639/002-ask-done.png).
- The Result diff stat doesn't list sneaky.txt because it is untracked. The only visible effects are that the result card flips to "Changes need attention · Review outdated" and the review becomes stale. That is an expected consequence of uncommitted changes (runFollowUp, src/engine.ts ~5786), not a separate bug.

So the user cannot tell from code-flow which file to inspect before the next Change commits it.

Attempt to refute:
- The count-only wording is deliberate in code. The `changedSince` doc comment (src/git.ts:812) says "in the same words as restoreSnapshot", and test/ship.test.ts:325 asserts `\(edits, 1 new file\)`.
- But the user docs promise more: docs/security.md:15 says "what changed is named in a warning and left in place", and docs/runs.md:95 says "a warning names the changes instead". docs/security.md:107 also says agy can write during an Ask and "the next Change commits it", which is exactly when file names matter.
- It is not caused by the environment or the  …

</details>
