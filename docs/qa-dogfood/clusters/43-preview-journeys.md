# Cluster 43 · preview-journeys

**Result preview server & recorded scenarios/pins**

Status: **fixed and verified** · 12 issues · branch `codex/qa-preview-journeys`

Planner notes: Preview (ui/result-preview.ts, src/serve.ts, ui/experience.tsx): readiness is decided on the first /serve/ready (t09-4), so check that the app is still alive. A command that ignores $PORT spins for 30 s and then leaves the app running (t09-20); add a hint and clean up. A setup failure tells the user to ask the agent, which Preview has just done (t09-19). Agent (chat) runs have no Stop or Logs control for the preview app (t09-5). At maximum panel width the card breaks words mid-word (t08-12). Scenarios (src/journey-store.ts, src/journey-api.ts, ui/journeys.tsx): the 100-scenario cap counts every repo, yet the UI says 'library is full' while the project shows 1 scenario (t09-6); list() doesn't isolate files, so one corrupt file breaks every project (t09-7/S15-2); get() leaks the ENOENT absolute path as a late 404 during replay (t09-8); recordings pin the temporary preview port (t09-12). Pins: 'Prepare verified fix' keeps an unrelated pin snapshot (t09-10); pin cards in a run's message box are lost on reload (t09-11, ui/browser-context.ts). Duplicate groups: [["t09-7","S15-2"]]

Likely files: `ui/result-preview.ts`, `src/serve.ts`, `ui/experience.tsx`, `src/journey-store.ts`, `src/journey-api.ts`, `ui/journeys.tsx`, `ui/browser-context.ts`, `ui/run.tsx`, `src/server.ts`, `ui/styles.css`

## Issues

### t09-4 · minor · Preview reports success when the app exits right after binding its port

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-28, SIDE-30.

**Repro**

> 1. Agent run → Preview with an app that binds $PORT and then exits (the crash command in t09-1, or Next.js failing on start).
> 2. Look at the result studio.

**Expected:** A 'preview stopped' error that points to the app's startup output.

**Actual:** The studio shows 'Open preview' with no error. The Browser shows 'This site can't be reached'. The server state is 'exited' with useful logs ('Symlink node_modules is invalid…'), but Agent runs have no place to see them.

**Root cause (verifier):** - **ui/result-preview.ts:22-25.** The wait loop returns `server` on the first `/serve/ready` that says `ready:true`. It never checks again, so a process that binds and then dies is reported as started.
- **src/serve.ts:41-49.** `DevServers.ready()` is a single TCP connect to the port with a 500 ms timeout. It is true as soon as the port is bound, even if the process exits a few hundred ms later. The polls run every 250 ms, so a bind-then-crash inside about 0.3–1.5 s passes.
- **ui/experience.tsx:73-74.** `tryResult` stores the DevServer snapshot from the POST (`status: "running"`) with `setServer(app)` and opens the Browser on its URL. Nothing polls `/serve` afterwards: the effect at :57 only re-runs on run.id, tree.branch or run.endedAt. So the label at :95 keeps saying "Open preview" and `error` is never set.
- **Clicking again repeats it.** The next click goes to result-preview.ts:14. The `existing` server has `status === "exited"`, so it POSTs a new server (:16) and goes through the same one-shot readiness check, which "succeeds" again.
- **Stale label after a failed start (secondary).** The catch at experience.tsx:75 does not refresh `server`, which is why the label still said …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/result-preview.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/serve.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/terminal.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/experience.e2e.ts`

**Suggested fix:** 1. **ui/result-preview.ts: wait for the app to stay up.** After the first `ready:true`, keep polling `/ready` for a short window, for example about 1.5–2 s or 3 to 4 ready results in a row. If the status turns to "exited", GET `/serve` and throw an error with the exit code and the last few log lines. Suggested text: "The preview stopped right after starting (exit 1). Last output: … Open its log (Terminal → Apps this run started) or ask the agent to fix it in chat."
2. **ui/experience.tsx: keep watching after success.** While `server?.status === "running"`, poll GET `/serve` every 2–3 s with `usePoll`, only while the studio is visible. When it changes to exited:
   - store the latest state with `setServer(latest)`, so the button goes back to "Preview";
   - set an error with the exit code and the log tail;
   - offer a "Show app log" action. It can open the side panel Terminal tab on the `app:<runId>/<tree>` pane (the same thing as `show(APP + key)` in terminal.tsx), or be an inline `<d …

**Suggested regression test:** 1. **Unit test, new file test/result-preview.test.ts.** Mock `globalThis.fetch` the way test/run-history-ui.test.ts and test/collab-ui.test.ts do.
   - Responses:
     - GET `.../serve` → null
     - POST `.../serve` → `{status:"running", url, port}`
     - `.../serve/ready` → `{ready:false,status:"running"}`, then `{ready:true,status:"running"}`, then `{ready:false,status:"exited"}`
     - GET `.../serve` → `{status:"exited", exitCode:1, logs:["FATAL"]}`
   - Assert that `startResultPreview(run …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server named v4647. Its home was new: I moved the old one to homes/v4647-prev-1792957922. It ran on port 4649 because v4645's fixture.mjs was holding 4647. I used a fresh browser profile (v4647x) and a new scratch fixture repo, clones/v4647-fx (app.cjs plus package.json with dev = "node app.cjs").

Setup: I created the project with the API, then started an Agent run through the composer ("Improve the heading text on the fixture page"). Run 2610251952-5772c316 finished with 1 artifact, on worktree solo.

Then, in the result studio, I opened More options → Preview settings, typed an App command and clicked Start preview (scripts: work/v4647/p2-repro.mjs and p3-followups.mjs; logs in the .log files next to them).

- **A. App binds its port, exits 1200 ms later.** The `/ready` polls returned 40ms `{ready:false,status:running}`, then 297ms `{ready:true,status:running}`. The studio settled at 536 ms with `err=[]` and the button "Open preview". At +2 s, +5 s and +11 s it was unchanged: `err=[]`, "Open preview". Meanwhile GET /serve showed `exited exit=1 logs=["listening","FATAL: startup failed after bind"]`. The Browser opened http://localhost:59953/ and showed "This site can't be reached / ERR_CONNECTION_REFUSED" (shots/v4647/001-A_bind_then_exit_1200ms.png).
- **C. App binds, exits after 300 ms.** It had already exited when the studio settled at 545 ms. Same result: no error, "Open preview", a dead page in the Browser.
- **HTTP server that binds, then throws an uncaught error after 500 ms.** Same: `err=[]`, "Open preview", server exited with 1.
- **Clicking "Open preview" again.** This silently restarts the app (a new startedAt and a new port). The studio reports success again with no error, and the app exits again.
- **After a page reload.** The button reads "Preview" but there is still no error.
- **Control B: app exits without ever binding.** The studio does show "The preview stopped before it was ready. Ask the agent to fix the startup error in chat.", so the error path exists. It only covers exits before the first successful connect. Even here the label stayed "Open preview", because the server state from the earlier attempt was never refreshed.

I could not refute it:
- **Not by design.** docs/runs.md:17 says Preview "starts a managed server and opens it when ready". The sibling launch-profile feature does detect a service that exits after it was ready (src/launch-profiles.ts:121-126: "Service X exited; the stack was stopped.") …

</details>

### t09-5 · minor · Agent (chat) runs have no Stop or Logs control for a preview app started from the result studio

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-30, SIDE-31.

**Repro**

> 1. Finish an Agent run and click Preview (app starts).
> 2. Look for Stop or Logs anywhere on the run page (More options, Run actions) or in the side panel.

**Expected:** A Stop app / Logs control like the one in 'Open in your tools'.

**Actual:** Neither exists. 'Open in your tools' renders only inside ArtifactCard under 'Details and publishing', which non-chat runs get. The dev server keeps running until the run is archived or deleted or code-flow restarts (GET /api/serve showed it still running).

**Root cause (verifier):** Agent runs are chat runs (`chat = !!p?.chat && !run.checkpointOnFinish`, ui/run.tsx:196). The only "Stop app" control is in WorkspaceTools (ui/run.tsx:1550-1620; DELETE /serve at :1603). WorkspaceTools mounts only inside ArtifactCard under "Open in your tools" (ui/run.tsx:1085). ArtifactCard is reached only through ResultCard, and for chat runs ResultCard never renders: ui/run.tsx:389 is gated by `!chat`, and ui/run.tsx:394 sits inside the `!chat ? <details class="result-details">` block that opens at :390. The Review page uses ArtifactCard with `reviewing` (ui/review.tsx:149), which turns the tools off at run.tsx:1085.

ResultStudio (ui/experience.tsx:52-107) is what starts the preview for chat runs (startResultPreview at :73) and keeps the `server` state. Its only buttons are "Preview"/"Open preview" (:83) and "Start preview" (:89), and it never calls DELETE .../serve.

The side panel's AppLog (ui/terminal.tsx:568-597) is a read-only log, and its header (:584-592) has no stop. Closing an app pill deliberately skips the DELETE (ui/terminal.tsx:88: `if (!k.startsWith(APP)) …`).

The server only stops when it is restarted (src/serve.ts:52 start→stop), on run archive/delete (stopMatc …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/terminal.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/experience.e2e.ts`

**Suggested fix:** 1. ResultStudio (ui/experience.tsx), while `server?.status === "running"`: add a "Stop preview" button next to "Open preview" or under More options → Preview settings. It calls `api(`/api/runs/${run.id}/worktrees/${enc(tree.name)}/serve`, { method: "DELETE" })`, then `setServer(null)`, and shows errors in the existing `error` slot. Also add a "Logs" link that opens the side panel Terminal on the app log. The cleanest way is a small helper in state.ts or terminal.tsx, e.g. `openAppLog(runId, worktree)`. It sets sideOpen/sideTab="terminal" and calls rememberSide with `{shells:[...,"app:"+key], shell:"app:"+key}`, reusing the existing `APP` key scheme.
2. Add a "Stop app" button to the AppLog header in ui/terminal.tsx (around :584-592, shown while status is "running"; same DELETE). The side panel then offers Stop for every kind of run, not only chat runs.
3. Optionally move the DELETE/stop logic out of WorkspaceTools (ui/run.tsx:1603) into a shared helper so the three places behave the sa …

**Suggested regression test:** Extend test/e2e/experience.e2e.ts, in the `Preview in ${mode} mode …` loop (line 55; mode "agent" is the chat case), right after the "Open preview" assertion at ~line 79:
- assert `page.locator(".result-compact").getByRole("button", { name: "Stop preview" })` is visible;
- click it, then `await until(() => api(endpoint), v => v === null)`;
- assert `fetch(server.url)` rejects (port closed);
- assert the studio button reads "Preview" again.

Add a side-panel case too: open the Terminal tab, use + …

<details><summary>Verifier's independent reproduction</summary>

Port 4649 was already taken by another verifier's server (PORT=4649 with home homes/v4647), so I left it alone. I used my extra port and started a fresh server: `qa-server.sh start v4649x 4651 fake`. I made a scratch git repo at clones/v4649-fixture with package.json `{"scripts":{"dev":"node app.cjs"}}` and a tiny HTTP app that listens on $PORT, then registered it with POST /api/projects (setup only).

Steps, all through the UI with Playwright (scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4649x/a1.mjs through a5.mjs):
1. Opened Project, clicked New run and sent "Improve the greeting text on the fixture page". Run 2610251953-171d3ea8 finished as pattern solo, showing "Finished · Agent" (a chat run).
2. Clicked Preview in the "Try and assess the result" card. GET /api/serve returned key 2610251953-171d3ea8/solo, command "npm run dev", port 60949, status running. The side panel Browser showed "Hello fixture" and the button changed to "Open preview".
3. Listed every visible button, link and menu item matching /stop|logs|kill|shut/ on the run page, before and after expanding More options and all of its sub-sections (Preview settings, Record your assessment, Show me what changed, Try two alternatives). Result: []. Counts: details.result-details 0, details.artifact-tools 0, .ws-tools 0. The header "Run actions" menu holds only "Archive | Delete…". The side panel Browser tab had no stop control.
4. On the Review page (#/review/<id>), with every details expanded, there was still no stop control and .ws-tools was 0.
5. Logs: this part of the report does NOT hold. Side panel, Terminal tab, "+ New terminal" lists "Apps this run started", including "▶ app :60949 · npm run dev · read-only log". It opens the app's output ("> node app.cjs / fixture app listening on 60949"), as docs/runs.md:98 describes. The reporter's script only searched the run page for buttons labelled Stop or Logs, so it missed this.
6. Closing the "▶ app :60949" pill (×) did not stop the app: /api/serve still said running and curl to http://127.0.0.1:60949 returned the page.
7. The only way to stop it from the UI was Run actions, then Delete…, then Delete run. After that /api/serve returned [] and the port was closed (archiving or restarting code-flow would also stop it).

Cleanup: deleted the run through the UI, stopped v4649x, and removed the scratch fixture clone along with its worktree and branch. No leftover …

</details>

### t09-19 · minor · Preview setup failure tells the user to ask the agent, which Preview has just done

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-29.

**Repro**

> 1. A run whose repo has no run command, where the agent's setup turn does not save one.
> 2. Click Preview and wait for the follow-up to finish.

**Expected:** 'The agent replied but did not save a launch command' plus next steps.

**Actual:** 'No web preview is configured yet. Ask the agent to set up a preview in chat.' Clicking Preview again sends the same request again.

**Root cause (verifier):** There are three parts.

1. ui/result-preview.ts:52-56, in continuePreviewSetup: once the follow-up turn is "done", the code clears the pending marker at :52 and calls startResultPreview(current, tree) at :56. It never checks whether the agent actually saved a launch command. startResultPreview then calls POST /serve with command undefined (ui/result-preview.ts:16).
2. src/server.ts:2636-2639: appCommand() (src/app-command.ts:6) finds no config.run and no package.json dev/start script. The server throws its generic HttpError(400, "No web preview is configured yet. Ask the agent to set up a preview in chat."). That text was written for the case where the agent was never asked, not for "the agent was just asked and did not save one".
3. The error reaches ui/experience.tsx:63 (continuePreviewSetup(...).then(..., error => setError(error.message))) and is shown unchanged.

Because the marker was already cleared at :52, the next click goes through ui/experience.tsx:72: `if (!configured && server?.status !== "running") { await requestPreviewSetup(run, tree); return; }`. That sends the identical PREVIEW_REQUEST again, with no memory of the failed attempt and no option to enter a command ins …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/result-preview.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/experience.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** 1. In continuePreviewSetup (ui/result-preview.ts, before line 56), read GET /serve/config after the turn finishes. If it returns null, throw a specific error instead of calling startResultPreview. Suggested text: "The agent replied but did not save a launch command. Read its reply above. If the app can run, ask it to save run.command in .codeflow/config.json, or enter a command under More options → Preview settings."
2. Record that this worktree's setup was attempted and produced no command. For example, keep a `preview-setup:<run>:<tree>` store entry with an outcome of "no-command" and the turn id instead of clearing it.
3. In ResultStudio (ui/experience.tsx:72), when that record exists and there is still no configured command, do not silently call requestPreviewSetup again. Either open the Preview settings details with a focused command field, or ask for an explicit "Ask the agent again" confirmation. Optionally relabel the button, e.g. "Set up preview…".
4. Optionally make the serve …

**Suggested regression test:** Add a test to test/e2e/experience.e2e.ts, e.g. "Preview explains when the agent's setup turn saves no launch command".

Setup:
- Commit .codeflow/config.json as {check:"true", prove:false} with no run key.
- Do not create preview-setup-fixture.txt, so the fake agent replies without saving a command.
- Start a solo run and wait until it is not running.

Steps and assertions:
- Click "Preview" in .result-compact.
- Wait until followUps.length === 1 and the run is not running.
- Assert that `.resul …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: "qa-server.sh start v4677 4677 fake". I moved the earlier v4677 home aside first; it had no runs.

1. Created a scratch git repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4677-nopreview. It holds only README.md and greet.mjs: no package.json, no .codeflow/config.json and no preview-setup-fixture.txt. Without that fixture file, the fake agent answers the preview request without saving a run command (test/fake-work.mjs:13).
2. Started a solo claude run on it through the API. It finished as done, and GET .../worktrees/solo/serve/config returned null.
3. Script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4677/repro.mjs (log: repro.log in the same folder) opened http://127.0.0.1:4677/#/run/<id> and clicked "Preview" in the .result-compact card.
   - The follow-up turn ran: kind reply, the message was PREVIEW_REQUEST, and it ended done.
   - The card then showed in red: "No web preview is configured yet. Ask the agent to set up a preview in chat."
   - serve/config was still null and no server was running.
   - Calling POST serve directly returned 400 with the same text.
   - The console showed two 400 "Failed to load resource" errors.
4. Clicked "Preview" again. The button still read "Preview". A second follow-up was sent with exactly the same PREVIEW_REQUEST message (followUps.length went to 2, same message: true), and the same error came back.

Screenshots: shots/v4677/002-setup-failed.png and shots/v4677/003-setup-failed-again.png under the QA folder. They match the reporter's shots/t09f/002-setup-failed.png.

Why it is not by design: docs/runs.md:17 says "If the repository has no web UI, the agent explains the available way to test it instead". PREVIEW_REQUEST (ui/result-preview.ts:9) also tells the agent to explain rather than build a demo. So the designed "no web UI" outcome always ends with this message, which tells the user to ask the agent for something it has just done. There is no environment dependency: the fake agent does exactly what a real agent would do when it finds no web app.

Cleanup:
- Deleted the run through the rail's "Run actions → Delete…"; GET then returned 404.
- Stopped my v4677 server; port 4677 is free.
- Removed the scratch repo, which also removed its .worktrees/<run> worktree and codeflow/* branch.
- Leftovers: the moved-aside empt …

</details>

### t09-20 · minor · A preview whose command ignores $PORT spins for 30s, then says 'still starting' and leaves the app running

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-30.

**Repro**

> Preview settings → App command 'python3 -m http.server 4393 --bind 127.0.0.1' → Start preview.

**Expected:** A hint that the app is not listening on $PORT.

**Actual:** 'Preparing preview…' for 30.5s, then 'The preview is still starting. Try Open preview again…'. The app keeps serving on 4393 while the server is tracked on another port.

**Root cause (verifier):** Code Flow only checks the allocated port, and the timeout path gives no specific hint and does no cleanup. The causes, by file:
- **src/serve.ts:41-50** `DevServers.ready()` only TCP-connects to the allocated `server.port` (the one exported as PORT, src/serve.ts:52-61). It cannot see that the process is listening somewhere else.
- **ui/result-preview.ts:22-28** `startResultPreview` polls `/serve/ready` 120 times at 250 ms (about 30 s). As long as status is "running" it keeps waiting, then throws a generic error at line 28: "The preview is still starting. Try Open preview again…". That message does not say:
  - which port was expected;
  - that the command must use $PORT;
  - what the logs say.
- On that timeout path nothing stops the server (no DELETE), so the process keeps running and stays tracked as running.
- **ui/experience.tsx:68-76** (`tryResult`) does not refresh `server` state when an error occurs, so the button label and state go stale.
- **ui/experience.tsx:91-103** The result card offers no Stop app or Logs control.
- **ui/experience.tsx:103** The Preview settings help text never mentions $PORT. The other app-command input does, in its title at ui/run.tsx:1611 ("it gets …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/result-preview.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/serve.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/experience.e2e.ts`

**Suggested fix:** 1) **Timeout message (ui/result-preview.ts:28).** On timeout, GET `base` to read the tracked server's port and last log lines. Throw a specific message, for example: "The app is running but nothing is listening on port <port>. Code Flow passes that port in $PORT; make sure the command uses it (for example `--port $PORT`) rather than a fixed port." Then either stop the server (`DELETE base`) so no orphan is left, or return the running state so the UI can offer Stop and Logs. Stopping is the simpler and safer default. Apply the same wording in `waitForPreview` (ui/experience.tsx:50).

2) **Server-side hint (optional, src/serve.ts / src/server.ts:2629).** Have `/serve/ready` also report the ports the process group is listening on (on macOS/Linux, `lsof -a -g <pgid> -iTCP -sTCP:LISTEN -Fn`). The UI can then fail early with "listening on 38679, not $PORT (52029)" instead of waiting 30 s. A cheaper alternative is to scan the logs for a `:<n>`/`port <n>` mention that differs from the allocate …

**Suggested regression test:** Add a case to test/e2e/experience.e2e.ts. Start a finished fake solo run on the fixture repo. Through the result card's Preview settings, start `node -e "require('http').createServer((q,s)=>s.end('x')).listen(<free fixed port>,'127.0.0.1')"`. To keep the test fast, make the attempt count injectable or poll a smaller budget in tests. Assert:
- the `.msg.err` text matches /\$PORT/ and contains the allocated port from GET /serve;
- afterwards GET /serve is null (or a Stop app button is visible), an …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: `qa-server.sh start v4679pp 4679 fake` (new home at homes/v4679pp). I made a scratch git repo with app.cjs, a node server that listens on process.env.PORT. As a precondition I created a solo fake-claude run on it through the API; the run finished with artifact branch codeflow/2610252006-d72be485/solo. The rest went through the UI in a Playwright script (work/v4679pp/repro.mjs, logs repro2.log and retry.log): open the run, then "More options", then "Preview settings", then "App command".

1) Control. With the command `node app.cjs` (uses $PORT), Start preview was ready in 541 ms. The app answered HTTP 200 and there was no error.

2) The issue. With `python3 -m http.server 38679 --bind 127.0.0.1`, Start preview behaved as reported:
- At 5 s the button still read "Preparing preview…". GET /serve showed status running on allocated port 52029. That port refused connections, while 38679 answered HTTP 200. The logs were empty because Python buffers stdout.
- After 31,026 ms the UI showed: "The preview is still starting. Try Open preview again, or ask the agent to check its startup logs." Nothing mentioned $PORT or the allocated port.
- After the error, /serve/ready returned {ready:false,status:"running"}, and 38679 was still serving 15 s later. The result card has no Stop app or Logs control (0 found).
- Screenshots: shots/v4679pp/001-preview-waiting.png and 002-preview-still-starting.png.

3) Following the advice. I reloaded the page and clicked "Open preview" as the message suggests. The App command field had reset to empty, so the UI posted no command. After 2.5 s it showed a different misleading error, "No web preview is configured yet. Ask the agent to set up a preview in chat.", and the python app kept serving. Without a reload the field still holds the command, so the click restarts the same command and the code would loop through the same 30 s wait again; I did not run that case.

Caveat about the first attempt: I first used my extra port 4681, but another QA server was already listening there. Python then failed with EADDRINUSE, and the UI correctly said "The preview stopped before it was ready" within about 5 s. So the reported behaviour happens only when the fixed port is free. Under the reporter's conditions (free port 4393), it reproduces 1/1.

Partly by design: docs/launch-profiles.md:39 says "A command must honor PORT … code-flow does not rewrite a command", and docs/application-improvements.md:225 says "The prev …

</details>

### t08-12 · cosmetic · At maximum side panel width the run's 'Ready to review' card breaks words mid-word

Source: tester unit side-panel-previews-1; observed with fake-agents; features SIDE-01.

**Repro**

> 1. At 1440×900 with the sidebar open, drag the side panel to its maximum (832px).
> 2. Open a finished Agent run.

**Expected:** The result card reflows; at worst buttons wrap below the text.

**Actual:** The text column is about 60px wide: 'Ready / to / review', 'Not / recorde / d'.

**Root cause (verifier):** The card that breaks is not the PR card in ui/result-next-step.tsx. For a run without a PR, ResultNextStep returns `<>{children}</>` (ui/result-next-step.tsx:25), so the `.result-next-step` wrap rules at ui/styles.css:3431-3432 (flex-wrap plus `flex: 1 1 270px`) never apply. The markup is built at ui/experience.tsx:92-95: `<div class="result-primary"><div><h3>Ready to review</h3><p class="help">Checks: … · Review: …</p></div><div class="experience-actions">…`. Only the generic rules style it. ui/styles.css:3427 makes `.result-primary` a single flex row with no wrap. ui/styles.css:3430 sets `.result-primary .experience-actions { flex-shrink: 0 }`, so the two buttons always keep their 215px. The text div has the default `flex: 0 1 auto` and `min-width: auto` and takes all of the shrinking. ui/styles.css:3425 sets `.result-studio p { overflow-wrap: anywhere }`, which lets the paragraph's min-content width collapse to a single character. The h3's longest word ("review", 47px) then sets the column width, and "recorded" is broken mid-word. The only fallback to a stacked layout is `@media (max-width: 760px) { .result-primary { flex-direction: column } }` at ui/styles.css:3459. It depends  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/experience.e2e.ts`

**Suggested fix:** This is a CSS-only fix in ui/styles.css. Make the result card respond to the width of the conversation column instead of the viewport. Add a container query next to the existing topbar one: `@container main (max-width: 620px) { .result-primary { flex-direction: column; align-items: flex-start; gap: 10px; } }`. 620px matches the existing breakpoint and the measured point where the text starts to squeeze (main column about 650px). It can also replace the viewport-based `.result-primary` rule in the @media (max-width: 760px) block, because .main-col is the container on phones too. As a safety net for other narrow cases, also let the row wrap: `.result-primary { flex-wrap: wrap; } .result-primary > div:first-child { flex: 1 1 240px; min-width: 0; }`. This is the same pattern `.result-next-step` already uses at styles.css:3431-3432, and the PR variant could then share it. Both variants were checked live: at a 360px main column the text column becomes 266px, there are no mid-word breaks, and …

**Suggested regression test:** In test/e2e/experience.e2e.ts, next to the existing `.result-compact` checks (around line 68), add a test. Set the viewport to 1440x900. Finish a fake run. Open the side panel, focus `.side-handle` and press End so the panel is at sideMaxWidth (832px, main column 360px). Then assert three things: (a) `.result-compact h3` is a single line, meaning its getClientRects tops form one unique value, or its height is under 1.5x its line-height; (b) the first child of `.result-compact .result-primary` is …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4691f" with a fresh home and browser profile. Both of my assigned ports were already taken by other QA agents: 4691 by v4689's python http.server fixture and 4693 by v4693s. I ran on the free port 4699 (remote 4700) instead. I made a throwaway git repo at scratchpad/qa/clones/v4691-tiny with one commit and added it through "Open another repository" as project "v4691 Tiny". I started a run through the composer ("Add a small NOTES.md file with one line about this repo.") and the fake Claude Code finished it with status done. At 1440x900 with the sidebar open, the result card at the default 420px panel was fine: the text column was 334px and "Ready to review" fit on one line. I then opened the side panel and dragged .side-handle with real mouse moves all the way left. The panel stopped at 832px (aria-valuemax 832), leaving .main-col 360px wide and the card 304px wide. The text column of .result-primary dropped to 47px while .experience-actions kept 215px. The h3 broke into 3 lines ("Ready / to / review") and the status line split "Not recorde / d". This matches the reporter's shots/t08f/001-s33-max-width-run.png exactly. It looked the same after a reload. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4691f/001-max-width-run.png. I then stepped the panel width with ArrowLeft in 24px steps from 300 to 832 and measured word breaks with getClientRects. The text column starts shrinking at about 540px panel width (main column 652px). It is under 111px (1-2 words per line) from about 756px. Mid-word breaks appear only at 828-832px (main column 364-360px). No console or 5xx errors. Arguments against the report that I checked and rejected: (1) Not by design. sideMaxWidth (ui/state.ts:77) deliberately keeps a 360px conversation column, and the code comment at ui/styles.css:178 says "A docked tool narrows the chat even on a wide monitor", with an @container main rule for the topbar. So 360px is a supported layout, and the card just has no rule for it. No doc in docs/*.md says otherwise. (2) Not the tester's environment. It reproduces from a fresh home, a fresh repo, a fake agent and a real pointer drag, not only the keyboard End key. Live check of a fix: injecting `@container main (max-width: 620px) { .result-primary { flex-direction: column; align-items: flex-start; gap: 10px; } }` (or a flex-wrap/basis variant) brought the text column back to 266px wit …

</details>

### t09-6 · minor · The 100-scenario cap counts every repository, so 'library is full' appears while the project shows 1 scenario

Source: tester unit side-panel-previews-2; observed with api; features SIDE-25.

**Repro**

> 1. Save 99 scenarios in repo B (API POST /api/journeys).
> 2. In repo A (1 scenario), record and click Save scenario.

**Expected:** A per-repository cap, or a message saying which projects hold the scenarios.

**Actual:** 'The 100-scenario library is full. Delete an unused scenario first.' Repo A's Project settings show 'Recorded scenarios · 1', so the user cannot find what to delete.

**Root cause (verifier):** - src/journey-store.ts:30-31: `create()` counts every `<uuid>.json` in the shared `CODEFLOW_HOME/journeys` root (src/server.ts:321), whatever its repo. This host-wide cap is intended (docs/application-improvements.md:270). But the thrown message, 'The 100-scenario library is full. Delete an unused scenario first.', never says which repos hold the scenarios.
- src/journey-api.ts:18: `GET /journeys` only lists one repo, and it first runs `repoRoot()` on that path. There is no host-wide listing, and scenarios whose folder was moved or deleted can't be listed at all ('spawn git ENOENT').
- ui/journeys.tsx:101-104 (`ScenarioLibrary`), rendered only for `p.repos` at ui/project.tsx:68, shows 'Recorded scenarios · N' per repo. It shows neither the host total nor the 100 limit.
- src/server.ts:2130-2131: project DELETE calls `manager.removeProject` and does not touch scenarios. The removed repo's scenarios become orphans that still count toward the cap and appear on no UI screen.

**Files:** `src/journey-store.ts`, `src/journey-api.ts`, `ui/journeys.tsx`, `ui/project.tsx`, `docs/api.md`, `docs/application-improvements.md`, `test/experience.test.ts`

**Suggested fix:** Keep the documented host-wide cap and remove the dead end:
1. In `JourneyStore.create`, when the cap is reached, group the existing records by `repo` and throw an actionable message, for example: 'This computer's 100-scenario library is full: 99 in /…/repoB, 1 in this repository. Delete an unused scenario first.' Map repo paths to project names in journey-api where available.
2. Add `JourneyStore.listAll()` and an owner-only `GET /journeys?all=1` (or `GET /journeys/summary`) that returns `{id, title, repo, createdAt}` for every scenario. It should not call `repoRoot`, so scenarios of moved or deleted repos still appear. Also let `list(repo)` fall back to comparing the stored repo string when `repoRoot` fails.
3. UI: change the ScenarioLibrary summary to 'Recorded scenarios · 1 (100 of 100 used on this computer)'. When saving hits the cap, show a link or expander listing scenarios on this computer grouped by repo/project, each with a Delete button. Orphaned repos should be marked 'no lo …

**Suggested regression test:** Unit, in test/experience.test.ts: in a temp dir, create a `JourneyStore`, save 99 scenarios with repo '/b' and 1 with repo '/a'. Then `assert.rejects(store.create({...draft, repo: '/a'}), /\/b.*99|99.*\/b/)` so the error names the repo holding the scenarios. Also assert `(await store.listAll()).length === 100` and that it includes the '/b' entries.

Server, in test/journey-replay.test.ts or a server test: save a scenario for a temp repo, delete the repo folder, then assert `GET /api/journeys?all …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server, name v4651. My assigned ports were taken: 4651 by v4649x's server and 4653 by v4653's server. I left both alone and ran mine on the free pair 4697/4698. The v4651 home had no runs and no journeys directory. Steps:
1. Created two scratch git repos with `git init`: clones/v4651-repoA and clones/v4651-repoB. Each has one commit containing an index.html with a #go button that writes 'Hello' into #result. A small node static server served that page on 127.0.0.1:60694 (ephemeral port).
2. Setup via API (work/v4651/setup.mjs): POST /api/projects created CapRepoA (p-81be03bc) for repoA and CapRepoB (p-e27b9885) for repoB. POST /api/journeys saved 1 scenario in repoA and 99 in repoB. GET /api/journeys?repo= returned A:1 and B:99, and homes/v4651/journeys held 100 <uuid>.json files.
3. UI (work/v4651/ui1.mjs, fresh headless Chrome): opened #/project/p-81be03bc, opened the side panel, Browser tab, entered the page address, then Go. Clicked 'Record a bug', clicked #go on the canvas (recorded 'click #go'), 'Stop recording', filled the title and expected text 'Hello', and clicked 'Save scenario'. The POST /api/journeys request carried repo=repoA and returned 400 {"error":"The 100-scenario library is full. Delete an unused scenario first."}. The recorder showed that text in red (screenshot shots/v4651/002-save-full.png).
4. Project settings: CapRepoA shows 'Recorded scenarios · 1', listing only 'A scenario 1' (shots/v4651/003-projA-settings.png). CapRepoB shows 'Recorded scenarios · 99'. Nothing on A's page mentions the host total, the 100 limit or the other project.
5. Worse case (work/v4651/orphan.mjs), still on the fresh server:
   - DELETE /api/projects/p-e27b9885 returned 200. The 99 B scenarios stayed on disk, and saving in A still failed with the same error. No UI route remains to list or delete them, because ScenarioLibrary renders only for repos of existing projects.
   - I then moved the repoB folder. GET /api/journeys?repo=<old path> returned 400 'git rev-parse --show-toplevel failed: spawn git ENOENT', so even the API cannot list them. Saving in A still failed. The only way out is DELETE /api/journeys/<id> with IDs you already know, or editing CODEFLOW_HOME/journeys by hand.

Cleanup: deleted all 100 scenarios and project A via API (no runs were created), stopped my v4651 server and the static server, and removed both scratch repos. Ports 4697, 4698 and 60694 are free.

Not by design, in part: docs/application-improvements.md:270 do …

</details>

### t09-7 · minor · One corrupt scenario file breaks the scenario list for every project

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-25.

**Repro**

> 1. Put an invalid JSON file named 00000000-0000-0000-0000-000000000000.json in <home>/journeys.
> 2. Open any project → Project settings → Recorded scenarios.

**Expected:** The bad file is skipped and the other scenarios are listed.

**Actual:** 'Recorded scenarios · 0', a raw 'Expected property name or '}' in JSON…' error, and the empty-state hint, while the project has 1 scenario.

**Root cause (verifier):** src/journey-store.ts:15. `list()` loops over every `<uuid>.json` in CODEFLOW_HOME/journeys and calls `await this.get(...)` and then `value.repo` with no try/catch. `get()` (src/journey-store.ts:11) is a bare `JSON.parse(readFile(...))` that never checks the shape. So one unparsable or non-object file throws out of `list()`, and this happens before the repo filter runs, which is why every repository is affected. src/journey-api.ts:18 sends that exception to the client as a 400 containing the raw message. The UI (ui/journeys.tsx:103-104) sets `error`, leaves `items` as [], and renders the count "· 0", the raw message and the empty-state hint all at once. The same unchecked `get()` makes `delete()` (journey-store.ts:38), and GET/DELETE /journeys/:id via journey-api.ts:26, fail for the bad id. The bad file still counts toward the 100-scenario limit in `create()` (journey-store.ts:30).

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/journey-store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/journeys.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/journey-api.ts`

**Suggested fix:** 1. In JourneyStore.list(), read each file inside its own try/catch. Skip any file that does not parse or is not an object with a string `repo`, and log the file name once. Follow the codebase's existing pattern and rename such files aside to `<id>.json.corrupt-<time>`, as projects.ts and automation.ts do. The renamed file no longer matches the listing regex, so it also stops counting toward the 100-scenario limit.
2. Add a small shape check to get(): an object with string repo/title/url and an actions array. Fail with a clear "This saved scenario is unreadable" error instead of a raw JSON or TypeError message.
3. Make delete() work on an unreadable scenario: if the file exists, remove it even when parsing fails, so the bad entry can be cleaned up from the app.
4. In ui/journeys.tsx:104, do not show the empty-state hint or the "· 0" count when `error` is set. Present the error as a load failure, for example "Couldn't load recorded scenarios: …", with the existing `msg err` styling.

**Suggested regression test:** Add test/journey-store.test.ts (focused and fast; it needs no Chrome). Make a mkdtemp root and a `new JourneyStore(root)`, then `create()` one valid journey for repo "/r1". Write `00000000-0000-0000-0000-000000000000.json` containing "{not json" and `11111111-1111-1111-1111-111111111111.json` containing "null". Assert that `await store.list("/r1")` deep-equals the one valid journey, and that `await store.list("/r2")` resolves to [] instead of rejecting. If the move-aside behaviour is adopted, al …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: `qa-server.sh start v4653 4653 fake`. Before that I moved the old v4653 home aside, so the new home had no journeys and no runs. I used a fresh browser profile. The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4653/t09-7.mjs and its output is in t09-7.log in the same folder.

1. I used POST /api/journeys to save one valid scenario for MQTT-MCP (201, id a86d16f3-…). In the UI, `#/project/p-ef01794b/settings` showed "Recorded scenarios · 1 | Verifier scenario" (shot 001-mqtt-clean.png).
2. I wrote `{not json` to homes/v4653/journeys/00000000-0000-0000-0000-000000000000.json and reloaded MQTT-MCP › Project settings › Recorded scenarios. It showed "Recorded scenarios · 0", the raw error "Expected property name or '}' in JSON at position 1 (line 1 column 2)" and the empty-state hint "Open a local app in Browser and choose Record a bug…" (shot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4653/002-mqtt-corrupt.png).
3. industriHealth (p-acdbb4ae), a different project, showed the same error (shot 003-health-corrupt.png). This confirms it affects every project on the host.
4. In the API, GET /api/journeys?repo=<MQTT> and ?repo=<industriHealth> both returned 400 with the parse error. DELETE /api/journeys/00000000-… also returned 400 with the same error, so the bad file cannot be removed from inside the app.
5. Other bad contents fail the same way. A file containing `null` gives 400 "Cannot read properties of null (reading 'repo')". An empty file gives 400 "Unexpected end of JSON input".
6. After I removed the bad file, the list showed "· 1" again (shot 004).

The browser console showed two 400 "Failed to load resource" errors. I deleted the test scenario through the API, stopped the server, and confirmed the journeys directory and runs directory were empty.

Why it is not by design or caused by the environment:
- docs/application-improvements.md:267-270 says the scenarios are "available from each project's Recorded scenarios library after restart" and says nothing about one bad file disabling the whole library.
- Other stores in the code move unreadable files aside and keep going (projects.ts:73/116, automation.ts:309/353, remote.ts:42-55).
- The tester's selector and script are fine. A clean API call reproduces it with no browser involved.

Severity stays minor. Cod …

</details>

### S15-2 · minor · (part B) list() parses every scenario file serially and without isolation, so one unreadable file breaks 'Recorded scenarios' for every repository.

Source: code-level suspect at `src/journey-store.ts:15` (confirmed hands-on).

**Repro**

> QA server s15. (1) Wrote one malformed file journeys/00000000-0000-0000-0000-000000000000.json ('{"repo":"/x",'). GET /api/journeys?repo=<repoA> and ?repo=<repoB> both returned 400 {"error":"Expected double-quoted property name in JSON at position 13 ..."}. This affects every repository, including ones that own no file. (2) Sent 100 DELETE /api/journeys/:id requests for repoA's scenarios in parallel with 20 GET /api/journeys?repo=<repoB>. All 20 listings failed with 404 {"error":"ENOENT: no such file or directory, open '/private/tmp/.../homes/s15/journeys/<id>.json'"}, although repoB owns no scenarios. (Script: qa/work/s15/s1-race.mjs)

**Expected:** Each repository's library lists its own scenarios. One bad or concurrently deleted file is skipped (and logged), and other repositories are unaffected.

**Actual:** The whole library fails for every repository with 400/404, and the error exposes the server's absolute home path.

**Root cause (verifier):** list() calls this.get(name) on every <uuid>.json in the shared directory before it filters by repo. It has no try/catch, and it does not run inside serialize(). A malformed file or a concurrent delete (rm between readdir and readFile) therefore rejects the whole listing. journeyApi then maps ENOENT to 404 and anything else to 400, and puts the raw fs message, including the absolute CODEFLOW_HOME path, in the error.

**Suggested fix:** In list(), read each file inside try/catch: skip ENOENT, and for SyntaxError log once and skip (or quarantine). Optionally run list() through serialize(), or read the files with Promise.all. Also stop forwarding raw fs messages from journeyApi; return a generic 'Scenario library could not be read' instead.

**Suggested regression test:** JourneyStore test: create 2 scenarios for repo A, write a malformed <uuid>.json, and assert that list(A) returns the 2 valid scenarios. Then delete a file between readdir and read (stub readdir) and assert that list() still resolves.

### t09-8 · minor · Deleting a scenario during its replay returns a late 404 that exposes an internal path

Source: tester unit side-panel-previews-2; observed with api; features SIDE-26.

**Repro**

> 1. POST /api/journeys/<id>/replay.
> 2. Within about 0.5s, DELETE /api/journeys/<id>.

**Expected:** A clear 'scenario was deleted' result.

**Actual:** The replay response is 404 {"error":"ENOENT: no such file or directory, open '<CODEFLOW_HOME>/journeys/<id>.replays…'"}.

**Root cause (verifier):** 1. src/journey-store.ts:11: `get()` calls `readFile(this.path(id))` without handling a missing file. A missing scenario surfaces as Node's raw ENOENT error, whose message contains the absolute path under CODEFLOW_HOME/journeys.

2. src/journey-store.ts:36-37: `record()` runs inside the serialize queue and calls `replays(id)`, which calls `get(id)` again. When DELETE (journey-store.ts:38) is queued first, which it always is because the snapshot takes about 1.7s, `get()` throws that raw ENOENT.

3. src/journey-api.ts:28 and :41-49: DELETE never checks the `replaying` flag and replay never re-checks that the scenario exists. The delete wins at once, `takeSnapshot` (line 45) runs to completion, and only `store.record()` at line 48 fails.

4. src/journey-api.ts:52: the catch-all turns any ENOENT into `HttpError(404, error.message)`. It passes Node's raw message, path included, to the client. The UI then shows it verbatim: ui/journeys.tsx:93 for ScenarioEvidence replay and line 104 for the ScenarioLibrary delete.

The same path makes GET, replay and DELETE of any unknown or already-deleted scenario ID leak the path (journey-api.ts:26 → store.get).

**Files:** `src/journey-store.ts`, `src/journey-api.ts`, `ui/journeys.tsx`, `test/experience.test.ts`

**Suggested fix:** 1. In JourneyStore.get() (journey-store.ts:11), catch ENOENT and throw a typed error such as `new HttpError(404, "This scenario was deleted.")` or a ScenarioNotFound error. This covers get, replays, record and delete in one place.

2. In journey-api.ts:52, never pass a raw errno message through. For ENOENT, send a fixed message such as "Scenario not found". For other fs errors, send a generic message and log the details on the server, matching the server.ts:1925/2277 pattern.

3. For the replay race, pick one:
   - (a) Track the id being replayed and have DELETE return 409 "This scenario is replaying. Wait for it to finish." while it runs.
   - (b) Let the delete win. Check `store.get(id)` after takeSnapshot, and if it is gone, return a clear 404/410 "The scenario was deleted during the replay; its result was discarded."

   Option (a) is simplest and matches the existing one-replay-at-a-time 409 messaging.

4. Optional UI change: in ScenarioLibrary, treat a 404 on delete as success an …

**Suggested regression test:** Add two tests to test/experience.test.ts, next to "scenario storage survives reopen…".

Store-level test:
- Create a scenario and delete it.
- Assert that `store.get(id)`, `store.replays(id)` and `store.record(id, receipt)` each reject with a 404-class error whose message matches /deleted|not found/i and does NOT contain the temp directory path or "ENOENT".
- Start `store.record(id, r)` and `store.delete(id)` concurrently in delete-first order and assert the same.

API-level test (new or in an e …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4655t098 on 127.0.0.1:4655 with a fresh home. The fixture app was a tiny node HTTP page on 127.0.0.1:4657 with a #go button that writes "Hello" into #result. The repo was a scratch git repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4655t098/repo.

API script (work/v4655t098/r1.mjs, output in r1.log):
- A baseline replay returned 201 "passed" in about 1.7s.
- For each delay of 100, 500 and 1000 ms I created a scenario, sent POST /api/journeys/<id>/replay, waited the delay, then sent DELETE /api/journeys/<id>.
- Every time the DELETE returned 200 {"deleted":true} at once. The replay kept running to the end (about 1.7-1.8s) and then returned 404 {"error":"ENOENT: no such file or directory, open '<CODEFLOW_HOME>/journeys/<id>.json'"}, including the full absolute home path. Reproduced 3/3.
- The same raw message comes back for GET /api/journeys/<unknown-uuid> and POST /api/journeys/<unknown-uuid>/replay. So this is not specific to the race: any missing or deleted scenario ID leaks the path.

UI script (work/v4655t098/u1.mjs):
- I created a project for the scratch repo and opened Project settings > Recorded scenarios in two tabs.
- I deleted the scenario in tab B, then pressed Delete scenario and confirmed in the stale tab A.
- Tab A's alert showed the raw "ENOENT: no such file or directory, open '/private/tmp/.../homes/v4655t098/journeys/c67d...json'". The stale row stayed in the list. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4655t098/002-stale-delete-error.png.

No orphan files were left: the journeys dir was empty afterwards, because record() throws before it writes. One correction to the report: the leaked file is <id>.json, not <id>.replays…. The reporter's output was cut at 200 chars before the filename.

Not by design:
- docs/api.md says errors carry an `error` string and documents no ENOENT text.
- server.ts already maps ENOENT to friendly text elsewhere ("Folder not found" at server.ts:1925/1937, "File not found" at :2277).
- Not caused by the environment: it reproduces on a fresh server with plain API calls and through the UI.

Severity stays minor. Only the authenticated owner sees the path (recordings are owner-only), there is no data loss, and the main cost is a confusing message plus about 2s of wasted Chrome work.

Cleanup: QA server v4655t098 s …

</details>

### t09-12 · minor · Recorded scenarios pin the preview's temporary port, so 'Replay original scenario' fails after the preview restarts

Source: tester unit side-panel-previews-2; observed with mixed; features SIDE-24, SIDE-26.

**Repro**

> 1. Record and save a scenario on a result preview (URL http://localhost:<random port>).
> 2. Stop the preview, or restart code-flow; the next preview gets a new port.
> 3. Click 'Replay original scenario' (recorder or scenario evidence).

**Expected:** Replay targets the current app, or the user can choose the URL.

**Actual:** 400 'Couldn't open http://localhost:53051/: net::ERR_CONNECTION_REFUSED'. The baseline cannot be re-run.

**Root cause (verifier):** src/journey-api.ts:32 sends the replay to `body.url ?? journey.url`, so with no `url` it always targets the origin saved at recording time. That origin is a temporary preview port: src/serve.ts:54 `freePort(preferredPort)` picks a random free port when the repo config has no run.port, and a preview restart or a code-flow restart gives a new one. On the UI side, ui/journeys.tsx:79 renders `<ScenarioEvidence journey={saved} />` with no `appUrl`, even though JourneyRecorder (ui/journeys.tsx:41) gets the live tab's current `url` as a prop. ui/journeys.tsx:93 then posts `{ url: appUrl || journey.url }`, which falls back to the old port. ScenarioLibrary (ui/journeys.tsx:101-105) has no replay action and no address field, so after a code-flow restart the original scenario cannot be re-run from the UI against a running app on a different port.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/journeys.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/journey-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/experience.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/application-improvements.md`

**Suggested fix:** 1. In JourneyRecorder (ui/journeys.tsx:79), pass `appUrl` = the live tab's current origin when it is a valid local http URL (`journeyUrl(url)` does not throw). The server already maps the recorded path, query and hash onto the selected origin.
2. In ScenarioEvidence, for the original (no runId) replay, show which address it will use (for example "Replay on localhost:65083") and offer a small editable "App address" field. Default it to the current tab or the repo's running preview, falling back to journey.url.
3. Add a "Replay" action with that address field to ScenarioLibrary items, so the baseline can be re-run after a restart. Default the address to a running dev server for the repo when one exists.
4. Optionally in src/journey-api.ts: when the target refuses connections and no `url` was given, return a clearer message ("The recorded app at localhost:64053 isn't running. Start it and choose its address."). Keep `body.url ?? journey.url` for API compatibility.
5. Update the Record a b …

**Suggested regression test:** test/e2e/experience.e2e.ts, in "browser recording excludes passwords, saves a regression scenario and survives reload". After the first "Replay original scenario" passes:
- Stop the result preview (DELETE /api/runs/:id/worktrees/:tree/serve) and start it again. Assert the new port differs from new URL(journey.url).port.
- Navigate the same live-browser tab to the new URL (Address box + Enter).
- Click "Replay original scenario" and wait for "Expected text appeared".
- Assert the newest GET /api/ …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (name v4663t0912, port 4663, new home). I made a scratch git repo with a small greeting app (app.cjs listening on $PORT) and .codeflow/config.json {check:"true", prove:false, run:{command:"node app.cjs"}}. No port was configured, so each preview gets a random free port. One fake solo run 2610251958-30fea8cf finished. The rest was done in the UI with headless Chrome (profile v4663t0912), in one page session so the recorder stayed mounted:
1. On the run page I clicked Preview. The side-panel Browser opened localhost:64053.
2. Record a bug: I clicked #name, typed "Ada", clicked Greet, then Stop recording. Title "Greeting scenario", expected "#result" / "Hello Ada". Save scenario stored journey 1e5487a0, url http://localhost:64053/.
3. Replay original scenario showed "Expected text appeared" (receipt passed).
4. I stopped the preview (DELETE .../worktrees/solo/serve, the same call as the "Stop app" button) and started it again. It came up on http://localhost:65083. I typed that address into the same live-browser tab (Address box + Enter); the tab showed the app on 65083.
5. "Replay original scenario" was still shown. Clicking it gave the inline error "Couldn't open http://localhost:64053/: net::ERR_CONNECTION_REFUSED" (HTTP 400). Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4663t0912/002-replay2-after-preview-restart.png
6. Variant with only UI actions: I stopped the preview again and clicked the result's "Open preview" button. The same tab moved to localhost:65218 and the recorder still offered the same failing button (003-after-preview-button.png in the same folder).
7. Restart variant: I ran qa-server.sh restart. The old preview process was gone. POST /api/journeys/1e5487a0/replay {} → 400 {"error":"Couldn't open http://localhost:64053/: net::ERR_CONNECTION_REFUSED"}. I started a new preview (http://localhost:49172). POST replay {"url":"http://localhost:49172"} → 201 status "passed". So the server can already retarget the replay; the UI never sends that URL.
8. After the restart, the project's "Recorded scenarios" library listed both scenarios with only Prepare verified fix / Export test / Delete scenario, and 0 replay buttons. The recorder's saved state was also gone. So once code-flow restarts, there is no UI way to re-run the original replay; the reporter's restart evidence could only come from curl.
I found nothing in the docs …

</details>

### t09-10 · minor · 'Prepare verified fix' replaces the composer task but keeps an unrelated earlier pin snapshot attachment

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-24, SIDE-20.

**Repro**

> 1. In the Browser, pick an element and choose Send to → New run (the card and its pin PNG land in the composer).
> 2. Without sending, save a recorded scenario and click 'Prepare verified fix'.

**Expected:** Either the earlier draft is preserved, or it is cleared entirely after asking.

**Actual:** The task text, and with it the earlier pin card, is replaced without asking, but 'pin-nyb2a5-1.png' stays attached next to browser-scenario.spec.ts and would go with the fix run.

**Root cause (verifier):** ui/journeys.tsx:29 calls openComposer(destination, { repository }). In ui/state.ts:1270-1279, switchComposer saves the current project draft and then restores that same draft (restoreComposer(saved)), so the earlier draft carries over instead of a new one starting. That draft holds the pin text, which composer.tsx:181 appended to the task, and the pin PNG, which composer.tsx:182 appended to attachments.value.
ui/journeys.tsx:32 then calls setTask(journeyPrompt(journey)). This overwrites the whole task, including the browser-context card that pointed at pin-<batch>-<n>.png, with no confirmation.
ui/journeys.tsx:34 removes only an earlier "browser-scenario.spec.ts" from attachments.value. Every other attachment survives, including images that only the removed card referenced.
Because composer.tsx:879 shows as plain chips any attachments not named by a browser card in the task (browserImageNames), the orphaned PNG now looks like an ordinary file. composer.tsx:213 then sends it in context.attachments of the fix run.
Other leftovers from the earlier draft also survive, such as acceptanceCriteria, which taskWithCriteria at composer.tsx:200 would append to the fix task, and contextPaths.  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/journeys.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/browser-context.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/application-improvements.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/experience.e2e.ts`

**Suggested fix:** Handle this in fixJourney (ui/journeys.tsx). After openComposer resolves, check whether the restored draft has real content: task.value.trim() or any attachment other than browser-scenario.spec.ts.
If it does, ask with the existing confirmAction, for example: "Replace the current draft? Its task, N browser cards and M attachments will be removed." Use confirmLabel "Replace draft" and let the user cancel. On confirm, clear the draft fully: attachments.value = [spec], plus acceptanceCriteria and contextPaths. That matches the documented "new pipeline draft".
At a minimum, even without the dialog, take the image names referenced by the old task before overwriting it: const orphaned = browserImageNames(task.value). Then drop those from attachments, so pin and snapshot PNGs go away together with the cards that owned them.
Another option is to preserve the draft by appending the old task, cards included, below the journey prompt. The pin images would then stay consistent with their cards.
Ei …

**Suggested regression test:** Add a case to test/e2e/experience.e2e.ts, in the "browser recording … survives reload" test, before clicking "Prepare verified fix". Seed the composer with a browser pin draft: either pick an element and choose Send to > New run, or post a composer draft that carries a pin-<batch>-1.png image. Then click Prepare verified fix, accept the confirmation if one is added, and assert two things. First, page.getByRole("button", { name: /^Remove pin-/ }) has count 0, while "Remove browser-scenario.spec.t …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4659p, on port 4659. The existing v4659 home was already used, so I made a new one: homes/v4659p. I also ran a 3-element local app (work/v4659p/app.cjs) on 127.0.0.1:4661 and used a fresh browser profile. All steps went through the UI (scripts work/v4659p/r1.mjs and r2.mjs, logs r1.log and r2.log).
1. Opened #/project/p-ef01794b/new (the MQTT-MCP composer), then Side panel > Browser and loaded http://127.0.0.1:4661/.
2. Clicked Pick, picked the #banner element and typed the comment "The promo banner layout is broken". Chose Send to > New run. The composer showed the browser pin card with its snapshot (shots/v4659p/003-composer-with-pin.png).
3. Without sending: Record a bug, click #name, type "Ada", click #go, Stop recording. Filled title, selector #result and text "Hello Ada", then Save scenario.
4. Clicked "Prepare verified fix". The task was replaced with journeyPrompt("Fix the recorded bug: Greeting says hello …"). No confirmation was shown and there is no way to restore the old draft. The pin card and its comment were gone, but the chips showed "pin-o92gz6-1.png · 609 B" next to "browser-scenario.spec.ts · 578 B" (shots/v4659p/005-composer-after-prepare.png). The task no longer mentions the banner or the pin.
5. After a reload the same draft persisted, with both chips.
6. I intercepted POST /api/runs with page.route and answered 418, so no run was created. The intercepted body had context.attachments = [pin-o92gz6-1.png (812 base64 chars), browser-scenario.spec.ts], with intent "bug", the journeyId set and pattern "pipeline". So the unrelated pin image would go with the fix run.
I reproduced this once, deterministically, and found no tester-environment cause.
On whether it is intended: docs/application-improvements.md:257 says Prepare verified fix "attaches a generated Playwright regression test to a new pipeline draft". The stale pin image contradicts "new draft". Replacing the task without asking does have a precedent: template apply in ui/onboarding.tsx:208 also calls setTask, but its dialog tells the user so. The orphaned attachment is not by design.
The QA server and the fixture app are stopped, and the server listed zero runs. The MQTT-MCP worktrees are older ones from 2026-10-22/23, not mine. The only leftovers are the QA home homes/v4659p, which holds one saved journey, and the browser profile profiles/v4659p.

</details>

### t09-11 · minor · Browser pin cards added to a run's message box are lost on page reload

Source: tester unit side-panel-previews-2; observed with fake-agents; features SIDE-20.

**Repro**

> 1. Pick an element and choose 'Add to chat' (a card appears above the run's message box).
> 2. Reload the page.

**Expected:** The draft cards survive, as typed text does ('plain typed draft 123' survived).

**Actual:** The cards and snapshots are gone: 0 cards after reload.

**Root cause (verifier):** The reporter's suspected cause (ui/state.ts:135-143, the in-memory chatDrafts queue) is not the cause. ConversationBar takes the queued drafts as soon as the box mounts (ui/run.tsx:1790 `takeDrafts(\`main:${run.id}\`)`) and merges the card markup into its `text` state. That text is persisted, so the cards survive a same-tab reload.

The real defect is that the images are never persisted:
- ui/run.tsx:1765-1769: `agentDrafts` is an in-memory Map. `savedAgentDraft()` restores `{ text: sessionStorage.getItem(\`agent-draft:${id}\`), images: [] }`, with the images hard-coded empty.
- ui/run.tsx:1782 initialises `images` from that empty array.
- ui/run.tsx:1783 writes only `text` to sessionStorage. `images` go only to the Map, which is gone after a reload.
- ui/browser-context-cards.tsx:31 looks up `images.find(image => image.name === context.snapshot)`. When it finds nothing it shows a globe icon with no warning.
- The context JSON keeps `"snapshot": "pin-….png"`, so send() posts `attachments: files` with nothing in it (`files = images.map(...)`, around ui/run.tsx:1819-1856). The agent is told about a screenshot that never reaches .codeflow-context/messages/.

The same text-only persist …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/browser-context-cards.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/browser-context.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/side-chat.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/browser.test.ts`

**Suggested fix:** 1. Persist the draft's images together with its text, per run. Use IndexedDB keyed `agent-draft:<runId>`, because base64 PNGs, especially whole-page annotated snapshots, can exceed sessionStorage's roughly 5 MB quota. Alternatively use sessionStorage with try/catch and a size cap. Restore them in savedAgentDraft/useState, and clear the entry on send and when the text and images are emptied, as the text already is.
2. Make the draft consistent whenever an image cannot be restored. Add a helper in ui/browser-context.ts, e.g. `reconcileSnapshots(text, images)`, that drops `snapshot` from any context whose image is missing, so a sent message never names a file it doesn't carry. BrowserDraftCards (ui/browser-context-cards.tsx) should then show a visible "Screenshot not kept after reload" note instead of silently switching to the globe icon.
3. Apply the same handling to the side chat's SideComposer and the composer's attachments, so all message boxes behave alike.
4. Optionally add a line t …

**Suggested regression test:** test/e2e/ui.e2e.ts, in the Browser "Add to chat" scenario (around lines 792-814). After `await page.locator(".runview .browser-context-draft img").waitFor()` and before filling the box:
- add `await page.reload()`;
- assert the card with "E2E: the toggle is hard to see" is still present and `.runview .browser-context-draft img` is visible again;
- send, then keep the existing assertion `reply.files.length === 1`.

Add the invariant `for (const c of parseBrowserMessage(reply.message).contexts) if …

<details><summary>Verifier's independent reproduction</summary>

I confirmed only part of the report. The cards are not lost on a real reload. The snapshot images are, and the reply is then sent without them.

Setup: a fresh fake-mode server "v4661t09" on 127.0.0.1:4661 with a new home. I made my own fixture git repo with app.cjs (a page with #title, #go and #more) and .codeflow/config.json containing run "node app.cjs", and registered it as project p-v4661fx. Through the composer I created run 2610251959-18036718 (solo, fake claude, finished). I then clicked "Try and assess the result" → Preview, and the side panel Browser showed the app.

1. a2-pin-reload.mjs: Pick → click #title → comment "Title should say Welcome" → "Add to chat". Result: cards=1, thumbs=1, textarea empty. sessionStorage['agent-draft:<run>'] holds 437 chars including the ```codeflow-browser-context block.
   - Typing "please also check spacing" gives cards=1 and the text.
   - After page.reload() in the same tab: cards=1, the comment still shows, the textarea still holds "please also check spacing", but thumbs=0. Screenshots 001-after-add.png and 002-after-reload.png show the thumbnail replaced by a globe icon.
2. a3-new-session.mjs: I opened the same persistent profile in a NEW browser launch, which is what the reporter's s7 did after s6. Result: cards=0, typed text "" and the sessionStorage draft null. So the reporter's "0 cards" came from a new browser session, where sessionStorage is empty. Typed text is lost the same way there. Their s8 tested plain text with page.reload() inside one session, so the two checks are not comparable.
3. a4-reload-send.mjs: Pick #go → Add to chat → reload → type "Please fix this after reload" → Enter.
   - The follow-up has no `files`.
   - The message has no "Attached, in this worktree" footer.
   - Its context JSON still says "snapshot": "pin-o96qcc-1.png".
   - No such PNG appeared in <worktree>/.codeflow-context/messages/.
4. a5-control-send.mjs: the same flow without a reload. The message ends with "Attached, in this worktree (not committed): `.codeflow-context/messages/mvo97ka8-pin-o97j3l-1.png`" and the file exists.

Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4661/ (a2..a5 .mjs/.log). Screenshots are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4661t09/.

Cleanup:
- I deleted the run through the sidebar "Run actions → Delete…" …

</details>


## Resolution · 2026-10-26

Implemented in `/private/tmp/codeflow-qa-preview-journeys` from integration `bd09dc5239455670a8f035570bd0746061d54c76`. All execution used explicit scratch `CODEFLOW_HOME`, `HOME`, `ZDOTDIR` and `TMPDIR`; the live checkout, ports 4317/4318, real home, real repositories and external remotes were not operated.

### Outcomes

- **t09-4:** Preview requires 1.5 seconds of sustained readiness, rechecks the process identity and reports startup exit code/log tail. The result card polls subsequent state, including results with only uncommitted changes. The real 1200 ms startup crash and a later 5 s crash both show actionable output; reload retains the stopped state.
- **t09-5:** Agent result cards expose Stop preview and expandable Preview logs. Stop closes the actual listening process. A stale stop/timeout cannot stop a newer instance; instance timestamps are monotonic even within a single clock tick.
- **t09-19:** An agent reply without a saved launch command is remembered. The next Preview action opens setup and explains the outcome; only the explicit Ask the agent again action sends another setup request. Manual command entry remains available.
- **t09-20:** After the existing 30 s readiness deadline, a command listening on the wrong fixed port is stopped. The error names the allocated port, explains `$PORT`, and includes output. Real Chrome/API verification confirms that both the managed record and fixed-port listener are gone.
- **t08-12:** Result text and actions wrap into separate rows as space narrows. At maximum side-panel width in a 1440 px window, the text retains at least 200 px and has no horizontal overflow; the screenshot was visually inspected.
- **t09-6:** The 100-record limit remains per computer. The library shows this repository's count and total capacity, and All scenarios on this computer exposes repository paths and current project names, including orphaned/moved repositories. Deleting an orphan through the UI immediately frees capacity. The bounded cap message gives the largest repository counts.
- **t09-7 / S15-2:** Malformed or structurally invalid scenario records are renamed aside and logged individually. Other repositories remain readable; a file removed between enumeration and read is skipped. Invalid records can also be deleted without parsing them. Raw filesystem failures are not exposed through the API.
- **t09-8:** Accepted replay work prevents deletion of that scenario until it finishes. Real Chrome was held at the fixture HTTP request while DELETE returned an immediate friendly 409; replay then completed normally. A stale UI replay after deletion displays a friendly 404 without an absolute path, filename or ENOENT.
- **t09-12:** Recorder evidence follows the current local browser address. Library evidence offers an editable local App address and defaults to a running preview for that repository when available. A recorded interaction replayed successfully after stopping/restarting its preview on a different port. The original path/query/hash are still preserved by the replay API.
- **t09-10:** Preparing a verified fix asks before replacing the selected project's existing draft. Cancel retains its task and PNG card. Replace clears task context, browser attachments, criteria and stale source/rerun fields before adding the scenario task and generated spec. The original real pin-to-composer flow was replayed; after replacement only the scenario spec remains. Other projects' separately stored drafts retain their ownership.
- **t09-11:** Main and side message drafts persist text and images together through IndexedDB, with a workspace-scoped localStorage fallback and hydration guards. Old session drafts migrate without another edit; save failures retain readable legacy text and show a persistence warning. Missing old PNG references become explicit unavailable-screenshot cards and are removed from sent attachment references. Real picked PNGs survive reload in main/side messages, and a main follow-up receives its file. A successful acknowledged send durably clears the draft. Cluster 44 additionally verifies new-tab/browser-restart persistence, cross-tab warning/reload, and provider handoff hydration using this shared helper.

### Adjacent browser finding and QA launch boundary

A native browser regression on unchanged `bd09dc5` proved that initial/second viewer watches could issue `Page.startScreencast` while a cast was already active. The baseline probe reports two `Screencast is already active` errors. Cast startup now explicitly stops the previous cast before starting it; the same native probe and real reload/Pick UI flow pass, with the selected page, frame dimensions and input controls preserved.

The first original UI replays also stalled in Chrome navigation on unchanged integration. This was independently narrowed to macOS keychain access in isolated QA profiles: both localhost and 127.0.0.1 navigations timed out before the fixture received an HTTP request. Shorter temporary paths, no viewer and `--disable-gpu` did not resolve it. Adding only `--use-mock-keychain` made the same native probe pass immediately. Final real Chrome checks use `/private/tmp/codeflow-qa-continue/work/preview-journeys/qa-chrome`, a QA-only launcher with that automation flag. Production launch flags and credential storage are unchanged. Diagnostic traces are retained; the incidental CVDisplayLink errors were not treated as the cause or turned into a production change.

### Evidence and validation

Evidence directory: `/private/tmp/codeflow-qa-continue/work/preview-journeys/`.

- New regressions: `test/qa-preview-journeys-store.test.ts`, `qa-preview-journeys-preview.test.ts`, `qa-preview-journeys-drafts.test.ts`, `qa-preview-journeys-browser.test.ts`, and `qa-preview-journeys-ui.test.ts`.
- Related suite: **42/42** pass in `related-complete.log` (10.74 s), covering existing experience, app-preview, launch profiles, browser context, side-browser and the new regressions. The subsequently added external filesystem deletion probe passes with all four store cases in `store-final.log`, for **43 distinct related cases**. Preview helpers use explicit fetch mocks; native browser cases use real Chrome; the inherited desktop grounding case remains an explicit mock.
- New real Chrome/UI/API suite: **11/11** pass in `ui-final.log` (71.41 s). The two final diagnostic/control cases were rerun without the temporary EventSource instrumentation in `ui-diagnostics-final.log`. They also enforce that only the intentional stale-scenario 404 console message is allowed during that exact operation; other console errors, page errors and 5xx responses fail the suite.
- Original `test/e2e/experience.e2e.ts`: **7/7** pass in `original-ui-final.log` (50.84 s), covering Agent, Team and adaptive preview setup, result assessment, password-excluding recording, result-bound replay, alternatives and mobile layout. No existing test expectations were changed in this cluster.
- **61 distinct passing cases**, plus focused reruns. Typecheck passes (`tsc-verified.log`) and `git diff --check` is clean.
- `store-before.log` preserves the three original failing storage probes. `native-cast-baseline.log` preserves the unchanged-branch duplicate-cast failure. Original pre-wrapper failures and native launch investigations remain in `original-ui-first.log`, `original-ui-baseline.log`, `browser-diagnostic*.log`, and `native-browser-*.log`; corrected test synchronization failures remain in the earlier UI logs.
- `server.log` and `browser-errors.json` capture the final isolated replay. The intentional corrupt-file recovery warning appears in storage evidence; the expected stale-scenario 404 is distinguished from runtime failures.
- Screenshots `01-startup-crash.png` through `15-missing-snapshot-warning.png` cover crash output, Stop/logs, fixed-port cleanup, setup retry, browser reload, global/orphan inventory, corrupt recovery, restored main/side pins, changed-port replay, confirmed draft replacement, maximum panel width, stale replay and missing-image warnings. Restored main pin, replaced composer, and maximum-width layouts were visually inspected.

### Scope and limitations

Agents are deterministic fake executables; no paid provider or external account was contacted. Browser navigation, annotation, PNG transfer, replay, process startup/exit/cleanup, filesystem corruption and Git worktrees are real isolated operations. The mock-keychain launcher is confined to scratch Chrome profiles. Cross-tab changes warn and preserve local edits; restoring another tab's saved version requires reload. New-tab and full browser-restart coverage lives in cluster 44, which cherry-picked the shared persistence commits `526318f` and `7316351` before integrating its own conversation fixes. All owned test servers and Chrome contexts close at suite completion.
