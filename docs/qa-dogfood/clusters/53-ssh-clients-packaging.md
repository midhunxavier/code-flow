# Cluster 53 · ssh-clients-packaging

**SSH connections, desktop/VS Code/CLI clients and packaging scripts**

Status: **fixed and verified** · 12 issues · branch `codex/qa-ssh-clients-packaging`

Planner notes: SSH (src/ssh-projects/*, ui/ssh-projects.tsx): the connection list still says 'connected' after the remote backend dies while the sidebar says unavailable (t21-7); reconcile the gateway error with the state in manager.list. Remove acts immediately (t21-11/S13-5; S13-5 also names integration Disconnect, which integration-connections fixes). A whitespace-only name is rejected as 'at most 80 characters' (t21-12). The Connections hub's 'Manage existing' card has no selected state (t21-13). Clients: the desktop app never exits after Quit in the crash dialog, and the dialog's diagnostics show the startup log (t22-1, t22-13, integrations/desktop/main.cjs). In VS Code, 'Forget Server Token' leaves a stale view, and Start Task asks for the task before checking the connection (t22-9). The CLI throws stack traces for a bad CODEFLOW_URL or credentials (t22-10, scripts/codeflow.mjs). The generated Homebrew formula fails brew style (t22-14, scripts/prepare-preview.mjs). docs:preview hard-codes port 4319 (t01-17). evaluate:project-teams loses its report outside a git checkout (t12-19). Duplicate groups: [["t21-11","S13-5"]]

Likely files: `ui/ssh-projects.tsx`, `src/ssh-projects/manager.ts`, `src/ssh-projects/gateway.ts`, `ui/connections.tsx`, `integrations/desktop/main.cjs`, `integrations/vscode/extension.cjs`, `scripts/codeflow.mjs`, `scripts/prepare-preview.mjs`, `scripts/preview-docs.mjs`, `scripts/evaluate-project-teams.ts`

## Continuation outcome · 2026-10-26

- **t21-7:** JSON and forwarded transport failures now update the gateway’s shared health, with request/transport generation guards. Saved-host refresh performs bounded cached health probes; unavailable sessions no longer claim connected in context, Settings or the switcher. Visible Settings refreshes automatically. Reopening restores the backend and invalidates cached project listings. HTTP permission errors still mean the transport is reachable. The sidebar uses its existing15-second refresh and eventually agrees; it is explicitly asserted in the new browser replay.
- **t21-11 / S13-5:** SSH removal confirms the lost definition and retained remote work, supports Cancel, and reports completion. ACP confirmation and valid ID patterns are already integrated from30 and passed again in original Settings tests; integration confirmation is covered by50. Connected-host removal demonstrably leaves the remote backend alive.
- **t21-12:** omitted/empty/whitespace names consistently use the host (bounded to80 characters); explicit overlong names remain rejected. UI and API follow the same rule and restored definitions validate.
- **t21-13:** Manage has an accessible current-page marker, selected styling and heading. Its documented remote-access controls remain intentional.
- **t22-1:** desktop Quit leaves the prevented before-quit dispatch before retrying, including crashes with no backend. Reopen/window/update actions avoid a dead backend. A model of Electron’s deferred window closure reproduces the old zombie, while normal idle shutdown still passes.
- **t22-13:** crash details identify exit code/signal and show only labeled post-readiness output with token redaction. Startup SQLite warnings remain normal runtime diagnostics; they no longer masquerade as the crash cause. No global warning suppression was added.
- **t22-9:** forgetting the token immediately updates the view; task creation checks compatibility before prompting and retains typed input in the output channel on later failure. Independent review found a disconnect race during realpath; the final generation/origin check now follows path resolution. A second independent real-client review caught another await inside check detection; a synchronous dispatch guard now checks immediately before POST. Response-loss feedback explicitly calls the outcome unconfirmed and asks the user to check runs before retrying. Regressions cover both preflight and path-resolution races.
- **t22-10:** malformed/credential-bearing URL configuration produces one safe usage line and exit2 without echoing secrets. Network errors show a safe origin and bounded error code, exit1.
- **t22-14:** generated Homebrew dependencies are sorted and use formula_opt_bin. Actual release preparation, brew style and Ruby syntax checks pass; release docs name the supported Homebrew floor and checks.
- **t01-17:** DOCS_PORT supports0 for a free port, validates before building, prints the actual address and explains occupied ports. It is independent of application PORT.
- **t12-19:** evaluation provenance is read before work. Source archives produce synthetic reports with unknown revision; real evaluation fails before any provider invocation without committed provenance. Completed evidence survives cycle/shutdown failures; unavailable final repository trees are null.

Validation: typecheck and26 focused/related tests pass (nine initial new regressions), with an additional real-client dispatch/response-loss regression and all three existing client tests passing. All six pre-fix unit/CLI/VS Code replays fail on detached173ce28; three original SSH/Manage Chrome replays also fail there. The pre-fix desktop reentrancy model fails while its idle control passes. New SSH Chrome3/3 and original Settings8/8 plus SSH journey1/1 pass, including real packaged backend crash/restart over the injected transport, confirmation/cancel, API state, switcher and eventual sidebar agreement. Browser page/console errors are empty; screenshots inspected. Wider onboarding replay found two existing avatar accessible-name violations and one consequent invitation-count failure; these are assigned to the48 follow-up and are not counted as53 passes.

Actual platform checks: packaged macOS Electron3/3 covers crash-dialog Quit, manual Quit during a crash dialog, idle Quit and a healthy relaunch after each. Real OpenSSH with temporary keys, loopback sshd and an isolated remote home passes. Packaged VS Code host acceptance passes with an isolated profile/extensions directory and real local CodeFlow server; its providers remain fake. release:prepare, brew style (zero offenses) and ruby -c pass. No model invocation or real external host was used. The desktop acceptance file is opt-in with CODEFLOW_QA_DESKTOP=1 after package:macos; ordinary suites use the always-on VM regression.

Evidence: `/private/tmp/codeflow-qa-continue/clients53-{related-final,e2e-verified,browser-final,baseline-unit,baseline-ui,desktop-baseline,desktop-vm-final,desktop-live-final,vscode-final,vscode-host,real-ssh,package,release,brew}.log`, plus `clients53-shots/`. The first new desktop harness attempted to access Playwright’s disposed process wrapper after a successful exit; capturing the owned process at launch fixed that harness error. The original Settings test adds only the newly required confirmation click.

## Issues

### t21-7 · minor · An SSH connection still shows 'connected' after its remote backend dies; only the sidebar says 'Connection unavailable'

Source: tester unit infra-remote-devices-clients-1; observed with fake-agents; features REM-03, REM-04, REM-07.

**Repro**

> 1. On t21f (fake ssh), connect QA Devbox.
> 2. Kill the remote backend (pid in remote-home/.codeflow/ssh-host/runtime.json) to simulate a crash or OOM.
> 3. Wait about 7 s. Look at Settings, Connections, Work on another computer, the top-bar switcher, and the sidebar.

**Expected:** All views agree that the computer is unavailable or reconnecting.

**Actual:** Settings shows 'qa-devbox · connected' with Disconnect and Stop backend, and the switcher shows 'connected'. The sidebar group shows 'QA Devbox 0 · Connection unavailable', and GET /api/ssh-hosts returns state 'connected' with no error. Opening the computer auto-restores it (new backend pid; runs kept), so it self-heals.

**Root cause (verifier):** The two views use two health signals that never reconcile.
- src/ssh-projects/manager.ts:36 (list): state is "connecting" if pending, else "connected" when sessions.has(id) && !gateway.error. There is no liveness probe and no timer, so a dead remote backend still reads as connected.
- src/ssh-projects/manager.ts:219 (context): returns connected: !!session and error: gateway.error, so it is stale in the same way.
- src/ssh-projects/manager.ts:199-205 (projectDirectory): this probe does detect the dead backend. gateway.json('/api/projects', 5000) rejects, but the catch only returns {error:'Connection unavailable'} for the sidebar row. It never records the failure on session.gateway.error.
- src/ssh-projects/gateway.ts:90-102 (json): transport failures (ECONNREFUSED or 'socket hang up' through `ssh -W`, and timeouts) reject without setting this.error. Only forward() records health: it sets the error at gateway.ts:84 (inside up.on('error') at :82; the report cites :79, which is the writeHead line) and clears it at :69. forward() runs only for /computer/<id>/api traffic, and connect() calls ensureConnected() first (manager.ts:66), which restores the session silently. So on a local page  …

**Files:** `src/ssh-projects/gateway.ts`, `src/ssh-projects/manager.ts`, `ui/ssh-projects.tsx`, `test/ssh-projects.test.ts`, `test/e2e/ssh-projects.e2e.ts`

**Suggested fix:** Make SshGateway the single source of truth for health, and have every caller update it.
1) gateway.ts json(): on a transport-level failure (req 'error' or the timeout destroy, as opposed to an HttpError for a remote 4xx/5xx status), set this.error = 'Connection interrupted. Reconnect this computer; your work remains there.'. Clear this.error whenever any response arrives, as forward() already does at :69.
2) manager.ts projectDirectory(): with (1) in place, the failed /api/projects probe automatically flips list() and context(). Also reset directoryCache wherever restore() clears the error.
3) manager.ts list(): optionally run a short parallel liveness probe (gateway.json(probe, 'GET', undefined, ~3000)) for sessions not checked in the last few seconds. Settings and the switcher are then accurate even before the sidebar polls.
4) Report a distinct state for a session with an error, e.g. 'unavailable' or 'reconnecting', instead of reusing 'disconnected'. The Settings card can then keep  …

**Suggested regression test:** Add a case to test/ssh-projects.test.ts, which already runs the packaged backend in an isolated remote home through the injected SSH transport:
- service.connect(host.id), then read the pid from f.remoteHome/.codeflow/ssh-host/runtime.json, process.kill(pid, 'SIGKILL'), and poll until the process is gone.
- Clear or bypass the 5 s directoryCache (call after a connect/disconnect reset or wait it out). Then assert:
  - (await service.projectDirectory()).find(c => c.id === host.id).error === 'Conne …

<details><summary>Verifier's independent reproduction</summary>

Fresh setup: a new snapshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4619t217 with src identical to dogfood-qa at f14f404 (diff -rq clean), plus `node scripts/build-host.mjs` run in that copy. A new fake ssh at .../qa/work/v4619t217/sshbin/ssh runs only qa-* hosts, locally, with HOME=.../work/v4619t217/remote-home. A fresh fake-mode server: `qa-server.sh start v4619t217 4619 fake <snapshot>` with that sshbin first on PATH. Scripts are in .../qa/work/v4619t217 (r1-connect.mjs, r2-crash.mjs, r3-actions.mjs) and logs in r1.log, r2a.log, r2c.log, r3.log.
1. In the UI, Settings > Connections > Work on another computer, I entered SSH host "qa-devbox" and name "QA Devbox" and clicked Connect and open. It opened /computer/9cd38d01296aad49/ and GET /api/ssh-hosts returned state "connected".
2. From a local page (/#/), I checked that the pid in remote-home/.codeflow/ssh-host/runtime.json was my own remote backend (ps showed my remote-home HOME and ssh-host/releases/.../server.mjs). Then I sent it SIGKILL (pid 20610).
3. At +7 s and again at +40 s, every observation was the same:
   - GET /api/ssh-hosts: [["QA Devbox","connected",null]]
   - GET /api/workspace-projects: [["QA Devbox",0,"Connection unavailable"]]
   - GET /computer/<id>/api/ssh-context: {connected:true}, with no error
   - The sidebar group read "QA Devbox 0 Connection unavailable", while the top-bar switcher listed "QA Devbox connected".
   - The Settings card read "QA Devbox qa-devbox · connected", with the Disconnect and Stop backend buttons shown. Screenshots 003/006-a-*-settings.png and 005-a-t40s-switcher.png show the contradiction on one screen.
4. Clicking "Refresh connections" still showed "connected". Clicking "Stop backend" failed in 544 ms with a raw "socket hang up" alert, and the card still said connected (001-b-stop-on-dead.png).
5. "Open QA Devbox" restored the connection in about 3.6 s with a new backend pid (20610 -> 35340). The state was then connected, the sidebar error was gone, and the self-heal claim holds.
6. A second kill cycle (pid 35340, r2c.log) reproduced the same results.
Refutation attempts:
- Not by design. docs/ssh-projects.md only promises auto-restore when you reopen a computer. It never says "connected" means only that an SSH session object exists, and the UI offers Stop backend, which then fails.
- Not the environment. The fake ssh only replaces OpenSSH. With real SSH the code path  …

</details>

### t21-11 · minor · 'Remove' on a saved SSH connection acts immediately with no confirmation or undo

Source: tester unit infra-remote-devices-clients-1; observed with api; features REM-02, REM-04.

**Repro**

> 1. Settings, Connections, Work on another computer: save or connect a host.
> 2. Click 'Remove' on its card.

**Expected:** A confirmation like the other destructive actions in the app (they use confirmAction), especially when the host is connected.

**Actual:** The host is disconnected and its saved settings (port, identity file, name) are deleted at once; no dialog appears (dialog count 0). Remote work keeps running, but the connection must be re-entered.

**Root cause (verifier):** ui/ssh-projects.tsx:109 sends DELETE /api/ssh-hosts/${host.id} straight from the button's onClick inside act(...), with no confirmAction() call:
`<button class="btn" disabled={!!busy} onClick={() => void act("Removing connection…", async () => { await localApi(`/api/ssh-hosts/${host.id}`, { method: "DELETE" }); await refresh(); })}>Remove</button>`
Unlike most other files that use confirmAction, ssh-projects.tsx never imports it from ./confirm-state.js. The server route at src/server.ts:1743 calls SshProjectManager.remove() at src/ssh-projects/manager.ts:235. remove() runs disconnect(id), which closes the SSH and team-server sessions, then removes the host from ssh-hosts.json. It keeps no tombstone, and a re-added host gets a new randomBytes id (manager.ts:51), so nothing can be undone. Remove is also styled as a neutral button, not danger, and sits next to the primary Open button, which makes a misclick easy.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/ssh-projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/settings.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/ssh-projects.md`

**Suggested fix:** In ui/ssh-projects.tsx:
1. Import confirmAction from "./confirm-state.js".
2. Ask for confirmation in the Remove handler before act(...). For example: `if (!await confirmAction(`Remove the saved connection “${host.name}” (${host.sshHost})?${host.state === "connected" ? " It will be disconnected now." : ""} Projects, runs and running work stay on that computer; to use it again you must add it again.`, { title: "Remove SSH connection?", confirmLabel: "Remove connection", danger: true })) return;`
3. After a successful DELETE, call showToast(`Removed ${host.name}`), so the user sees feedback and the stale "SSH connection saved" toast is replaced.
4. Optionally style Remove as `btn ghost` or `btn danger` and move it away from the primary Open button.
In docs/ssh-projects.md, add a line under "Reconnect and stop" saying that Remove asks for confirmation.
No server change is needed. The API (docs/api.md:462) stays a plain DELETE for scripted clients.

**Suggested regression test:** test/e2e/settings.e2e.ts, test "saved SSH connections survive reload, reject invalid ports, and retain a connection after open failure" (around line 268). This test currently expects Remove to act at once, so it must change.
1. After clicking Remove on "Retry VM", assert that `page.getByRole("dialog", { name: "Remove SSH connection?" })` is visible.
2. Click "Cancel". Assert the "Open Retry VM" button is still visible, the `.ssh-connections article` count is still 2, and GET /api/ssh-hosts still …

<details><summary>Verifier's independent reproduction</summary>

I started a fake-mode QA server, v4621, on 127.0.0.1:4621. Its home had no ssh-hosts.json, so the SSH state started fresh. The Playwright script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4621/remove-ssh.mjs and its log is remove-ssh.log in the same folder.
1. I went to #/settings/ssh and saved two hosts through the form. "QA Box One" was qa-v4621@vm-one.invalid with port 2222 and key ~/.ssh/qa_fake_key. "QA Box Two" was qa-v4621@vm-two.invalid. Neither was ever connected, and .invalid hosts cannot resolve.
2. I attached a page 'dialog' listener and clicked "Remove" on the QA Box One card.
Results:
- The DELETE /api/ssh-hosts/05585f30a695b20d request went out about 100 ms after the click.
- 400 ms later there was no open dialog.confirmation-dialog, no dialog[open] and no native dialog.
- The card count went from 2 to 1, and GET /api/ssh-hosts no longer listed the host, so the port and key path were gone too.
- There was no undo or restore button and no "removed" toast. The only toast was the stale "SSH connection saved" left from the second save.
- The page reported no errors.
Screenshots 001-before-remove.png and 002-after-remove.png in .../qa/shots/v4621/ show this. Remove has the plain neutral `btn` class and sits right next to the primary "Open <name>" button.
I did not reproduce the connected-host case, because that needs a real SSH host, which I am not allowed to use. The click handler does not check host.state, though, so a connected host goes through the same code. On the server, sshProjects.remove() first calls disconnect(), which closes the SSH session and any team-server session.
Why I don't think it is by design:
- docs/ssh-projects.md does not say Remove should confirm. It does call removal harmless for remote work, and says "Remove and re-add a connection to change its definition". The UI footer says the same. test/e2e/settings.e2e.ts:268 currently expects removal to happen at once.
- Some peer settings actions also skip confirmation: ACP "Remove", Integrations "Disconnect" and SSH "Disconnect".
- But the closest analogues do confirm. "Delete project" (projects.tsx:170) only removes a definition, keeps its runs, and still asks. "Disconnect this computer" for a team link (collab-settings.tsx:77) also asks.
- Removal also loses more than the reporter listed. A re-added host gets a new random id (manager.ts:51), so /computer/<old-id>/ links and browser state store …

</details>

### S13-5 · minor · SSH connection 'Remove' deletes the saved definition with no confirmation. The same is true of integration 'Disconnect' (ui/integration-connections-view.tsx:61, which also drops all project bindings) and ACP 'Remove <name>' (ui/acp-connections.tsx:34).

Source: code-level suspect at `ui/ssh-projects.tsx:109` (confirmed hands-on).

**Repro**

> QA server s13. (1) Settings > Connections > Work on another computer: saved SSH host 'qa-s13-nohost.invalid' as 'QA S13 VM' with Save connection only, so no SSH was attempted. Clicked 'Remove': no dialog, and GET /api/ssh-hosts then showed hosts:[]. (2) Settings > Agents > Add compatible CLI: id qa-s13, name QAS13, executable /usr/bin/true, saved; /api/acp-connections listed acp:qa-s13. Clicked 'Remove QAS13': no dialog, and the list became []. (3) Precondition through the API: webhook connection 'QA S13 hook' (https://qa-s13.invalid/hook plus a random test secret; the test step only validates the URL and sends nothing), bound to project s13-demo. Settings > Integrations > 'Manage QA S13 hook connection' > 'Disconnect': no dialog, after which connections were [] and the project's bindings were []. Side finding in the same run: Chrome logged 'Pattern attribute value [a-z][a-z0-9-]{0,40} is not a valid regular expression … /v: Invalid character class' for the ACP Connection ID input (acp-connections.tsx, pattern attribute). Under the v flag the trailing '-' must be escaped, so client-side ID validation silently does nothing.

**Expected:** Destructive removals are confirmed like the app's other disconnect/revoke actions. This matters most for integration Disconnect, which wipes stored credentials and all project associations, e.g. 'Disconnect QA S13 hook? It is removed from N project(s) and its saved credentials are deleted.'

**Actual:** A single click (or menu item) removes the item at once, with no undo.

**Root cause (verifier):** All three handlers call DELETE directly with no confirmAction: ssh-projects.tsx:109 calls localApi(`/api/ssh-hosts/${id}`, DELETE); integration-connections-view.tsx act('disconnect') calls DELETE /api/integration-connections/:id; acp-connections.tsx:34 calls DELETE /api/acp-connections/:id. The app confirms comparable actions elsewhere through confirmAction ('Disconnect this computer from <team server>?', 'Revoke the runner…?', 'Make a new secret?', 'Delete <automation>?'). Integration Disconnect (src/integration-connections.ts:226-228) removes the connection and every project binding in all projects, and garbage-collects its stored encrypted secrets. Undoing it means re-entering the token or webhook URL and re-attaching each project. 'Disconnect' sits in the same menu as 'Remove from project'. SSH and ACP Remove only lose a small definition (host alias, port, key path; or command and args), which is easy to re-add, and SSH Remove also disconnects an open session.

**Suggested fix:** Wrap the three handlers in confirmAction(…, {title, confirmLabel, danger:true}). For integration Disconnect, include the number of bound projects (data.bindings, or a count from the server) and note that saved credentials are deleted. SSH Remove can mention that an open connection is closed and that work on the server is kept. Separately, change the ACP id pattern to '[a-z][a-z0-9\-]{0,40}' or '[a-z][-a-z0-9]{0,40}'.

**Suggested regression test:** UI e2e: for each of SSH Remove, ACP Remove and integration Disconnect, click the action and assert that a confirmation dialog appears; Cancel leaves the GET listing unchanged and confirming removes the item. Unit or e2e check that the ACP ID input reports validity (input.validity.patternMismatch for 'Bad_ID') with no console error.

### t21-12 · cosmetic · API: an SSH host name that is only whitespace is rejected with 'at most 80 characters'

Source: tester unit infra-remote-devices-clients-1; observed with api; features REM-02.

**Repro**

> POST /api/ssh-hosts {"sshHost":"qa-ws","name":"   "} with the bearer token.

**Expected:** A message saying a name is required, or a fallback to sshHost as the UI does.

**Actual:** 400 'Name the server using at most 80 characters'. The UI is not affected because it sends name.trim() || sshHost.

**Root cause (verifier):** The bug is at src/ssh-projects/manager.ts:49-50. The report gave lines 45-46, but the code is at 49-50:
```ts
const name = typeof body.name === "string" ? body.name.trim() : body.sshHost;
if (!name || name.length > 80) throw new HttpError(400, "Name the server using at most 80 characters");
```
A string name that is empty or only whitespace trims to "". It then fails the `!name` half of the check and gets the "too long" message. The sshHost fallback only applies when `name` is not a string, so whitespace is rejected while `5` or `null` is accepted. The UI avoids this because it sends `name.trim() || sshHost.trim()` (ui/ssh-projects.tsx:88).

I found a related edge by reading the code but did not reproduce it. validSshHost (src/ssh-projects/transport.ts:7) allows hosts up to 200 characters. With no name, the fallback name is the sshHost, so an 81-200 character SSH host would fail with the same "at most 80 characters" message, even from the UI.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/ssh-projects/manager.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ssh-projects.test.ts`

**Suggested fix:** In SshProjects.add (src/ssh-projects/manager.ts), make the server treat the name the same way the UI and docs/api.md already do:
```ts
const given = typeof body.name === "string" ? body.name.trim() : "";
const name = given || body.sshHost.slice(0, 80);
if (name.length > 80) throw new HttpError(400, "Name the server using at most 80 characters");
```
- A blank or whitespace name then falls back to the SSH host, the same as an omitted name.
- The length message is only shown for names that really are too long.
- Cutting the fallback to 80 characters also fixes the long-sshHost edge, and the result still passes the `host.name.length > 80` check in load() at line 30.

If you would rather keep blank names invalid, split the check instead: reject `!name` with a separate message such as "Enter a display name or leave it out to use the SSH host". The fallback fits the documented "optional name" better.

**Suggested regression test:** In test/ssh-projects.test.ts, add to the "SSH connection options validate, persist, and keep aliases with different ports distinct" test, after the `restored.hosts.length === 3` assertion or with that count updated:
- `assert.equal((await service.add({ sshHost: "blank-name", name: "   " })).name, "blank-name")`
- `assert.equal((await service.add({ sshHost: "empty-name", name: "" })).name, "empty-name")`
- `await assert.rejects(service.add({ sshHost: "long-name", name: "a".repeat(81) }), /at most …

<details><summary>Verifier's independent reproduction</summary>

I started my own fake-mode QA server with `qa-server.sh start v4629 4629 fake`. Its home had no ssh-hosts.json and no runs. I sent POST http://127.0.0.1:4629/api/ssh-hosts with `Authorization: Bearer qa-v4629-token` and these bodies:
- {"sshHost":"qa-ws","name":"   "} returned 400 {"error":"Name the server using at most 80 characters"}. This is the reported bug.
- {"sshHost":"qa-ws","name":""} returned the same 400 with the same message.
- {"sshHost":"qa-ws","name":"\t\n"} returned the same 400 with the same message.
- An 81-character name returned the same 400. This is the only case where the message is correct.
- {"sshHost":"qa-ws","name":5} returned 201 with name "qa-ws". A non-string name silently falls back to sshHost, but a blank string is rejected.
- {"sshHost":"qa-ws2","name":"  QA box  "} returned 201 with name "QA box". Trimming works.

I also checked the UI with a Playwright script (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4629/t21-12-ui.mjs). I went to Settings > Connections, entered SSH host "qa-ws-ui" and Display name "   ", and clicked Save connection. The host was saved as "qa-ws-ui" and an "Open qa-ws-ui" button appeared, with no console errors. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4629/001-t21-12-ui-fail.png. The "fail" in the name comes from a bug in my script's api() call that ran after the UI step had already succeeded.

It is not by design. docs/api.md:458 documents `POST /ssh-hosts` as "`sshHost`, optional `name`", and docs/ssh-projects.md:24 also treats the name as optional. The reporter's setup played no part. The bug reproduced on a fresh server through a direct API call.

Cleanup: I deleted all 4 test hosts with DELETE /api/ssh-hosts/:id, and the list was empty afterwards. I stopped server v4629. I created no runs, worktrees or clones, so nothing is left over.

</details>

### t21-13 · cosmetic · Connections hub: the 'Manage existing connections and access' sub-page has no selected state

Source: tester unit infra-remote-devices-clients-1; observed with fake-agents; features REM-01.

**Repro**

> Open #/settings/connections/manage.

**Expected:** Something shows the user is on the 'Manage' sub-journey (button marked current or a heading).

**Actual:** All three journey cards show 'Get started →' and the Manage button looks the same as on other sub-pages; the Remote access card is shown again under it.

**Root cause (verifier):** ui/connections.tsx:31: the journey cards set aria-current, the "Selected" label and the [aria-current] style (ui/styles.css:3659) only when purpose equals one of devices, join or host. ui/connections.tsx:38: the Manage link is rendered as `<a class="btn small" href="#/settings/connections/manage">` with no condition on purpose, so it has no aria-current and no selected/primary class, even though line 17 counts "manage" as a sharing sub-purpose and lines 39-44 render its content. The link also sits outside the `<nav aria-label="Share access options">` landmark (lines 26-32), so screen readers do not treat it as one of the sub-journey choices. Nothing in the manage branch (lines 39-44) adds its own heading, such as "Manage existing connections and access", to identify the sub-page.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/connections.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/team-onboarding.e2e.ts`

**Suggested fix:** In ui/connections.tsx:38, give the Manage link aria-current={purpose === "manage" ? "page" : undefined} and a selected style. For example, use class `btn small ${purpose === "manage" ? "primary" : ""}` to match the purpose-nav convention on line 21, or add a rule `.connections-hub a[href$="/manage"][aria-current="page"]` next to ui/styles.css:3659 that reuses var(--selected) and var(--accent-ink). Better still, move the link inside nav.connection-journeys as a secondary row, so all four sub-journeys share the "Share access options" landmark and the same current-state treatment. Also, when purpose === "manage", start the manage section with a short heading such as `<h3>Manage existing connections and access</h3>`, so sighted users who arrive from a legacy Settings → Team or Remote access bookmark can see where they are. Leave the RemoteAccess card under Manage as it is: docs/team-collaboration.md:19 says Manage keeps the device settings.

**Suggested regression test:** Extend the "purpose-first sharing separates devices, joining and hosting" test in test/e2e/team-onboarding.e2e.ts:
1. owner.goto(`${base}/#/settings/connections/manage`).
2. Assert that getByRole("link", { name: "Manage existing connections and access" }) has aria-current "page".
3. Assert that the "Share access options" navigation has no .connection-journey[aria-current] (count 0).
4. Go to #/settings/connections/devices and assert the Manage link's aria-current is null while "Connect my device …

<details><summary>Verifier's independent reproduction</summary>

Started a fresh fake-mode server: qa-server.sh start v4631t2113 4631 fake. The home was new, with no runs. I opened the app in a fresh headless Chrome profile with no saved profile, and the script made no console errors or 5xx responses. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4631t2113/manage.mjs. Output: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4631t2113/manage.log. The script visited #/settings/connections/{sharing,devices,join,host,manage} and recorded aria-current, the card action text and the Manage link's computed style on each page.

Results:
- devices, join and host: the matching journey card has aria-current="page" and shows "Selected", with the highlighted border and background.
- manage: all three cards show "Get started →" and none has aria-current.
- The "Manage existing connections and access" link has class "btn small" and aria-current=null on every sub-page, with the same background (rgb(253,252,249)), border, colour and font-weight 500 each time.
- The only page-level marker on manage is the top "Share access" purpose button, and that is also marked current on the overview and on the other three sub-pages.
- The ARIA snapshot shows the Manage link outside the "Share access options" navigation landmark, with no current state.

Screenshots:
- /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4631t2113/005-hub-manage.png (manage: nothing selected; the button looks the same as on 001-hub-sharing.png)
- /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4631t2113/002-hub-devices.png (devices: card shows "Selected")

Checks against design intent:
- docs/team-collaboration.md:19 says Manage "retains the account, role, device, runner and execution-grant settings". No doc, code comment or test says the Manage view should be unmarked.
- The legacy routes #/settings/team and the old Remote access bookmarks resolve to group "manage" (test/collab-ui.test.ts:51), so bookmarked users land on this unmarked page.

Part of the report is by design: the Remote access card under Manage. Manage is documented to keep the device settings, so showing RemoteAccess there is intended and is not a duplicate on the same page.

The server was stopped and  …

</details>

### t22-1 · minor · Desktop app never exits after 'Quit' in the backend-crash dialog; reopening shows a blank window

Source: tester unit infra-remote-devices-clients-2; observed with real-agents; features REM-18.

**Repro**

> 1. Snapshot: npm run package:macos (or use any built Code Flow.app). 2. Launch the app (isolated CODEFLOW_HOME/CODEFLOW_DESKTOP_DATA). 3. Kill the backend process (pid in <home>/server.lock), e.g. kill -9. 4. The dialog 'Code Flow’s local service stopped' appears; choose Quit. 5. Observe the app process. 6. Open Code Flow again.

**Expected:** Quit exits the app, so reopening Code Flow starts a fresh backend, as the dialog says ('Reopen Code Flow to reconnect').

**Actual:** The window closes but the Electron process keeps running (tray and menu stay; still alive after 30s). Event trace: dialog → before-quit → before-quit → window-all-closed, and will-quit never fires. Reopening hands off to this zombie through second-instance: the second instance exits 0 and the zombie opens a blank dark window pointing at the dead backend URL. The only way out is Force Quit. Reproduced 3 times (work/t22/de1.mjs, de3.mjs, de4.mjs). Screenshot: shots/t22/desktop-zombie-reopen.png. Quitting normally (app.quit with no running work) exits fine.

**Root cause (verifier):** integrations/desktop/main.cjs:213. `quit()` calls `app.quit()` synchronously when it never reaches an await, which happens whenever `backend` is undefined. That is always true after a crash, because the exit handler at :124 clears it, and the :171 check is skipped because of `backend` or `exitApproved`.

quit() is started from the before-quit handler at :249 (`event.preventDefault(); void quit();`). So `app.quit()` is called again from inside the outer before-quit dispatch:
1. The nested Browser::Quit sees quitting=true, does not preventDefault, sets is_quitting_=true and starts CloseAllWindows.
2. When the outer dispatch returns, Electron sets is_quitting_ from the outer default-prevented result, which is false.
3. When the last window closes, Electron emits window-all-closed instead of will-quit. The handler at :248 is a deliberate no-op, so the process never exits.

The trace shows exactly this (before-quit, before-quit, window-all-closed). Both entry points hit it:
- the dialog handler at :126 (`exitApproved = true; app.quit();`)
- Cmd+Q / Dock Quit at any time after the backend died, even while the dialog is still open

The zombie now has quitting=true and backend=undefined, w …

**Files:** `integrations/desktop/main.cjs`, `test/desktop/restart.test.mjs`, `test/macos/launcher.test.mjs`

**Suggested fix:** 1. Never call app.quit() inside the before-quit dispatch. In quit(), change :213 to `else setImmediate(() => app.quit());`, or equivalently defer quit() in the :249 handler. This makes the second Browser::Quit run after the outer, default-prevented dispatch has finished. It then goes through close, window-all-closed and will-quit, and the window-size save in the close handler still runs. Verified on the packaged build: the crash-dialog Quit and Cmd+Q-during-dialog both exit 0, idle Cmd+Q still exits, and relaunch starts a fresh backend.

Avoid patching only :126 (setting quitting=true there): it leaves the Cmd+Q-after-crash path broken, as verified. app.exit(0) would also work but skips close handlers.

2. Defence in depth:
- In the second-instance and activate handlers at :246-247, when `!backend` after a crash, do not createWindow() on the dead URL. Either quit, or re-show the "local service stopped" dialog, or restart the backend.
- Make the tray Quit (:165) fall back to app.quit()  …

**Suggested regression test:** 1. Unit test in test/desktop/restart.test.mjs. Extend the vm fixture so the fake app behaves like Electron's Browser::Quit:
   - `quit()` returns early if isQuitting; otherwise it emits before-quit with a preventDefault flag and only after the emit sets `isQuitting = !prevented`; when not prevented it records 'will-quit'.
   - requestSingleInstanceLock returns true, app.on stores handlers, and whenReady() never resolves, so the before-quit handler at :249 is registered.
   - Case A: set ownerURL …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this on my own fresh build. A QA server was not needed: the desktop app starts its own backend in an isolated CODEFLOW_HOME and CODEFLOW_DESKTOP_DATA. I ran `qa-server.sh snapshot v4675`, then `npm run package:macos` in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4675 (exit 0, 20s, Node cache copied). The packaged main.cjs is identical to the source.

Test A (Playwright, packaged app; script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4675/pw-crash-quit.mjs, log pw-run1.log in the same folder):
- Launched with fake-bin on PATH, stubbed dialog.showMessageBox to return response 0 ("Quit") after 500 ms, then SIGKILLed the backend pid from server.lock.
- Events: dialog "Code Flow’s local service stopped" buttons=["Quit"], before-quit, before-quit, window-closed, window-all-closed. No will-quit. The Electron process was still alive after 30s (ps shows it running, 0 windows).
- Relaunching the app: the second instance exits 0 and hands off through second-instance. The zombie creates a window at http://localhost:49337/?token=… with an empty body; screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4675-desktop-zombie-reopen.png is a blank #181914 window.

Test B (no Playwright, to rule out the harness; driver /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4675/drive.mjs, logs drv-*.log in the same folder):
- I copied the packaged .app and set package.json main to a small wrapper. The wrapper logs app events to a file, auto-clicks "Quit" on the dialog after 1s, maps SIGUSR2 to app.quit() (the Cmd+Q / Dock Quit path), and then requires the unchanged main.cjs.
- orig-dialog: same trace, alive at 30s. On reopen the zombie gets second-instance and its new window fails with did-fail-load -102 ERR_CONNECTION_REFUSED, so it is blank.
- orig-cmdq (Cmd+Q while the crash dialog is still open, which is a new finding): also a zombie (before-quit x2, window-all-closed, no will-quit). So the bug is not limited to the dialog's button.
- orig-idle (Cmd+Q with the backend healthy): exits 0. The two before-quit events are 49 ms apart because quit() awaits the backend stop, so the second app.quit() is not nested.

Refuting "only Force Quit": Cmd+Q on the zo …

</details>

### t22-13 · minor · Desktop crash dialog 'diagnostics' shows the startup log (SQLite ExperimentalWarning, banner) instead of why the service stopped

Source: tester unit infra-remote-devices-clients-2; observed with fake-agents; features REM-18.

**Repro**

> 1. Launch the built Code Flow.app. 2. Kill the backend (kill -9 <pid from server.lock>). 3. Read the dialog detail.

**Expected:** The exit code/signal and the last error lines.

**Actual:** Detail is '(node:…) ExperimentalWarning: SQLite is an experimental feature… code-flow running at http://localhost:… Open …token=[redacted] ✓ Claude Code ✓ Codex ✓ Antigravity CLI', which suggests SQLite is the cause. The same SQLite warning is printed on every npm-launcher start.

**Root cause (verifier):** integrations/desktop/main.cjs:93-98: `diagnostics` holds the last 8000 characters of the backend's whole stdout+stderr since fork. A SIGKILL or OOM kill prints nothing, so the buffer holds only startup output: the node:sqlite warning on stderr plus the banner from src/server.ts.
main.cjs:123: `backend.on('exit', () => {` ignores the (code, signal) arguments.
main.cjs:126: appends `'\n\n' + diagnostics` verbatim with no label, so the first thing under the generic sentence is "ExperimentalWarning: SQLite…", which reads like the cause.
The startup-failure path at main.cjs:121 does include `(${code ?? signal})`, so the running-crash dialog is inconsistent with it.
The warning itself comes from src/memory-sqlite.ts:1 (`import { DatabaseSync } from "node:sqlite"`, loaded at startup through src/memory.ts:4 and src/server.ts:131). Node 22 emits ExperimentalWarning for this import, and none of the forks pass a flag to suppress it: main.cjs:89-91 (no execArgv), bin/launcher.mjs:77 (`spawn(process.execPath, [server], …)`), integrations/desktop/docker/runner.cjs:7 and integrations/desktop/wsl/runner.cjs:46.
Side bug (Quit doesn't exit): the dialog's `.then` sets exitApproved=true and calls app …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/integrations/desktop/main.cjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/bin/launcher.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/integrations/desktop/docker/runner.cjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/integrations/desktop/wsl/runner.cjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/desktop/restart.test.mjs`

**Suggested fix:** 1) In main.cjs, change the handler at line 123 to `backend.on('exit', (code, signal) => …)`. Put a clear reason in the detail, e.g. "The service was stopped by SIGKILL" or "The service exited with code 1", using the same `code ?? signal` source as line 121.
2) When the codeflow-ready message arrives (main.cjs:119), record `diagnostics.length` or reset a separate post-ready buffer. Show only the output that came after readiness, under a label such as "Last output from the service:", and leave that section out when it is empty. That way a SIGKILL shows the signal and no startup banner, while a real exception still shows its stack trace.
3) Suppress the node:sqlite warning in every backend launch by passing `--disable-warning=ExperimentalWarning`: `execArgv` on the fork at main.cjs:89, the args before `server` in bin/launcher.mjs:77, and the forks in docker/runner.cjs:7 and wsl/runner.cjs:46. Node ≥ 22.13 is already required, and that version supports the flag. A narrower alternative is a …

**Suggested regression test:** Add a new test, test/desktop/crash-dialog.test.mjs, using the vm-fixture pattern from test/desktop/restart.test.mjs.
- Stub `node:child_process.fork` to return a fake child: an EventEmitter with stdout/stderr emitters. Set env CODEFLOW_DESKTOP_TEST=1 and PORT=4318, and run startBackend().
- Have the fake child emit stderr "(node:1) ExperimentalWarning: SQLite is an experimental feature…" and the "code-flow running at…" banner on stdout, then the {type:'codeflow-ready', url:'http://localhost:4318 …

<details><summary>Verifier's independent reproduction</summary>

1) Checked that the build I used matches the source under test: `Contents/Resources/app/main.cjs` in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/t22/output/macos/arm64/Code Flow.app is byte-identical to dogfood-qa/integrations/desktop/main.cjs, and `diff -rq` of src/ and bin/ shows no differences. The bundled node is v22.23.4.
2) Wrote /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4603t22/crash.mjs. It launches the app with Playwright Electron using a fresh CODEFLOW_HOME and CODEFLOW_DESKTOP_DATA under my work dir, CODEFLOW_DESKTOP_TEST=1, fake-bin first on PATH and a random token. It waits for the main UI, reads the backend pid from state/server.lock, replaces dialog.showMessageBox with a stub that records each dialog, then sends a signal to the backend.
3) SIGKILL (sigkill.log, then again in sigkill2.log): one error dialog, message "Code Flow’s local service stopped". Its detail was "Saved work is preserved. Reopen Code Flow to reconnect and resume unfinished work.\n\n(node:80949) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n(Use `node --trace-warnings ...` …)\ncode-flow running at http://localhost:51477 (0 runs loaded from …)\n  Open http://localhost:51477/?token=[redacted] …\n  ✓ Claude Code (claude)\n  ✓ Codex (codex)\n  ✓ Antigravity CLI (agy)\n". It contained no exit code or signal.
4) SIGTERM (sigterm.log): same detail plus a final "Stopping code-flow (SIGTERM): interrupting running runs…" line, still with no exit code or signal.
5) Both `<bundled node> -e "require('node:sqlite')"` and the system node v22.14.0 print the same ExperimentalWarning. A grep of src, bin, scripts, integrations and docs finds no warning suppression (the only --no-warnings is in test/wsl-desktop/runtime.test.mjs) and no doc describing the dialog's content, so this is not by design. The npm launcher output the reporter saved (work/t22/launcher.out) shows the same warning on start.
Side observation, outside this issue: in all three runs, after the stub returned response 0 ("Quit"), the app did not exit within 10–30 s. Afterwards BrowserWindow.getAllWindows() returned [] while the Electron pid was still alive, so the app lingers with no windows. No processes were left over: the script SIGTERMs the app it launched and `ps` shows nothing.

</details>

### t22-9 · minor · VS Code: after 'Forget Server Token' the view keeps saying 'Recent 100 runs…', and 'Start Task' asks for the task before checking the connection

Source: tester unit infra-remote-devices-clients-2; observed with fake-agents; features REM-21.

**Repro**

> 1. Connect the extension and refresh runs. 2. Run 'Code Flow: Forget Server Token'. 3. Look at the Code Flow Runs view message. 4. Run 'Code Flow: Start Task from Editor', type a task and press Enter.

**Expected:** The view immediately says it is disconnected. Start checks for a connection before prompting, or keeps the typed task.

**Actual:** The view message stays 'Recent 100 runs, filtered to local workspace folders.' (with an empty list) until the next 10s refresh sets 'Run Code Flow: Connect to Local Server first.' Start shows the task input box first and then fails with 'Run Code Flow: Connect to Local Server first.', so the typed task is lost.

**Root cause (verifier):** integrations/vscode/extension.cjs:79 (codeFlow.disconnect) clears client and cache, sets lastError to 'Disconnected. Connect to a local server to inspect runs.' and calls changed.fire(). It never sets view.message. changed.fire() only makes VS Code call getChildren() again. The only code that writes view.message is the finally block in refresh() at extension.cjs:35. So the old 'Recent 100 runs…' text stays above a now-empty list until the next refresh: the 10 s timer at :104, a visibility change at :103, or a manual refresh. That refresh also replaces the 'Disconnected…' text with connected()'s 'Run Code Flow: Connect to Local Server first.', so the disconnect message is never shown in the view; only the Test-mode error() export at :108 can see it.

Second part: in codeFlow.start at extension.cjs:81-89, the task box opens at :86 (showInputBox) and the save-file warning at :87 can fire (it saves the file) before connected() first runs at :89. connected() at :20-27 fails when there is no token. safe() at :67 turns that into an error popup, the local `task` variable goes out of scope, and the typed text is lost.

**Files:** `integrations/vscode/extension.cjs`, `integrations/vscode/test/extension-host.cjs`, `integrations/vscode/package.json`, `integrations/vscode/README.md`

**Suggested fix:** 1. In codeFlow.disconnect, set the view message straight away. For example, add a small `showState()` helper that does `view.message = lastError || 'Recent 100 runs, filtered to local workspace folders.'; changed.fire();` and call it from both refresh's finally block and disconnect. Alternatively, have disconnect call `void refresh()` once the secret is deleted inside mutateConnection. Also pick one disconnected wording: either keep the 'Disconnected…' text or reuse the 'Connect to Local Server first' text.
2. In codeFlow.start, call `const api = await connected();` right after requireTrusted() and selectedFolder(), before showInputBox and the save prompt, then use `api.start(...)` at :89. Optionally run `api.compatibility()` there too, so a stopped server is caught before the user types.
3. Optionally, if the start call still fails after the task was typed (server down, token rejected), keep the typed task: write it to the output channel, or offer a 'Connect' action on the error and p …

**Suggested regression test:** Option 1: in integrations/vscode/test/extension-host.cjs, which runs in the real host via scripts/test-vscode.mjs, add `message: () => view.message` to the Test-mode exports at extension.cjs:108. Right after `await vscode.commands.executeCommand('codeFlow.disconnect')`, with no refresh in between, assert that `api.message()` does not match /Recent 100 runs/ and matches /Disconnect|Connect/.
Option 2: add a fast unit test, test/vscode-extension.test.ts, next to test/vscode-client.test.ts. It load …

<details><summary>Verifier's independent reproduction</summary>

1. Started a fresh fake-mode QA server on port 4691 with a new home: qa-server.sh start v4691t229 4691 fake. Made a throwaway git repo at scratchpad/qa/clones/v4691t229-repo.
2. Wrote my own VS Code API stub, separate from the tester's. It records view.message changes through a setter, the order of showInputBox and secrets.get calls, and error popups. The harness file is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4691t229/repro.cjs. It loads the unmodified integrations/vscode/extension.cjs straight from the read-only source tree by resolving 'vscode' to the stub.
3. Activated with no token. The message was "Run Code Flow: Connect to Local Server first.", so the extension does mean to show a disconnected state.
4. Ran codeFlow.connect with origin and token. The message became "Recent 100 runs, filtered to local workspace folders.". Ran codeFlow.start, which created fake run 2610252234-36bc97f7 (done), then refreshed: 1 child.
5. Ran codeFlow.disconnect (Forget Server Token). Right after it: message was still "Recent 100 runs, filtered to local workspace folders.", 0 children, secret deleted.
6. Polled the message. It changed only after 9452 ms, when the 10 s timer's refresh set "Run Code Flow: Connect to Local Server first.". The disconnect text "Disconnected. Connect to a local server to inspect runs." never appeared in the view.
7. Ran codeFlow.start after forgetting. The recorded order was: showInputBox("Task for Code Flow") returned "My carefully typed task after forget", then secrets.get, then the error "Run Code Flow: Connect to Local Server first.". The server had 0 runs with that task, so the typed text was thrown away.

Full log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4691t229/repro.log.

Why it is not by design or caused by the setup: README and docs only say the view refreshes every ten seconds and that Forget removes the connection. The disconnect handler builds a 'Disconnected…' string and fires a tree change, which shows it means to show disconnected state right away. TreeView.message is a plain property that VS Code only changes when the extension sets it, so a stub reproduces it faithfully. The start order is fixed in the code.

Cleanup: deleted the run through DELETE /api/runs/<id>; it is gone from the run list. That delete did not remove the run's worktree or branch, so I delete …

</details>

### t22-10 · minor · CLI client refuses credential or invalid CODEFLOW_URL with an uncaught stack trace (exit 1) instead of a clean usage error

Source: tester unit infra-remote-devices-clients-2; observed with api; features REM-23.

**Repro**

> 1. CODEFLOW_TOKEN=x CODEFLOW_URL='http://user:pw@127.0.0.1:4469' node scripts/codeflow.mjs status. 2. CODEFLOW_URL='not a url' node scripts/codeflow.mjs status.

**Expected:** A single-line message such as 'CODEFLOW_URL must be an HTTP(S) origin without embedded credentials', with exit 2 like the other configuration errors.

**Actual:** Node prints the source line, a caret and an 11-line stack trace, exit 1. Invalid URLs print 'TypeError: Invalid URL' with internals. The password is not echoed. Server down prints only 'fetch failed' without the URL.

**Root cause (verifier):** In /Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/scripts/codeflow.mjs, line 28 (`const origin = new URL(process.env.CODEFLOW_URL || "http://127.0.0.1:4317");`) and line 29 (`if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) throw new Error("CODEFLOW_URL must be an HTTP(S) origin without embedded credentials");`) run at module top level. The only try/catch starts at line 38 and prints `error.message` with exitCode 1. Lines 28-29 sit outside it, so the TypeError from `new URL` and the explicit `throw` become uncaught ESM errors. Node then prints the source excerpt, caret, stack, the error's own properties (including ERR_INVALID_URL `input`, which holds the raw URL and any password) and exits 1. The check itself has the right logic; it reports the error with `throw` instead of the `process.stderr.write(...); process.exit(2)` used at lines 25 and 27. Secondary: line 55's catch prints only `error.message`, which for undici network errors is just "fetch failed". The real reason (error.cause.code, e.g. ECONNREFUSED) and the target origin are dropped.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/scripts/codeflow.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/client-cli.test.ts`

**Suggested fix:** Validate CODEFLOW_URL the same way as the other config errors, without throwing:
```js
let origin;
try { origin = new URL(process.env.CODEFLOW_URL || "http://127.0.0.1:4317"); } catch {}
if (!origin || !["http:", "https:"].includes(origin.protocol) || origin.username || origin.password) {
  process.stderr.write("CODEFLOW_URL must be an HTTP(S) origin without embedded credentials, for example http://127.0.0.1:4317.\n");
  process.exit(2);
}
```
Never put the raw value in the message, because it may contain a password. Optionally also reject a path, query or hash, or quietly use only `origin.origin`. In the line-55 catch, add the cause and the safe origin for network failures, e.g. `const cause = error.cause?.code || error.cause?.message; process.stderr.write(`${error.message}${cause ? ` (${cause})` : ""}${error.name === "TypeError" ? ` contacting ${origin.origin}` : ""}\n`)`. `origin.origin` never includes credentials. Keep exit 1 for runtime and request failures.

**Suggested regression test:** Add a new test/client-cli.test.ts (same pattern as test/retention-policy.test.ts, which spawns a script). For each CODEFLOW_URL in ["http://user:pw@127.0.0.1:1", "not a url", "ftp://127.0.0.1:1", "127.0.0.1:1", "http://u:S3cretPw@bad host:1"], run spawnSync(process.execPath, ["scripts/codeflow.mjs", "status"], { env: { ...process.env, CODEFLOW_TOKEN: "x", CODEFLOW_URL }, encoding: "utf8" }). Assert: status === 2; stderr.trim().split("\n").length === 1; stderr matches /CODEFLOW_URL must be an HTT …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4693 on 127.0.0.1:4693, and ran the read-only client /Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/scripts/codeflow.mjs from /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4693.
(a) Baseline: CODEFLOW_TOKEN=qa-v4693-token CODEFLOW_URL=http://127.0.0.1:4693 node scripts/codeflow.mjs status exits 0 and prints the health JSON.
(b) No CODEFLOW_TOKEN: one clean line "Set CODEFLOW_TOKEN to the explicit token used by your server.", exit 2. This is the convention other config errors follow.
(c) CODEFLOW_URL='http://user:Pw0rdXyz@127.0.0.1:4693': exit 1 and 11 stderr lines. Node prints "file:///.../scripts/codeflow.mjs:29", the source line, a caret, "Error: CODEFLOW_URL must be an HTTP(S) origin without embedded credentials", 4 internal frames (ModuleJob.run etc.) and "Node.js v22.14.0". The password is not in the output.
(d) CODEFLOW_URL='not a url': exit 1 and 15 lines: "node:internal/url:818 ... TypeError: Invalid URL at new URL ... codeflow.mjs:28:16 ... { code: 'ERR_INVALID_URL', input: 'not a url' }".
(e) A new case the tester missed: CODEFLOW_URL='http://user:S3cretPw@bad host:4693' is an invalid URL with credentials in it. The dumped error object prints "input: 'http://user:S3cretPw@bad host:4693'", so the password does reach stderr on this path.
(f) CODEFLOW_URL='ftp://127.0.0.1:4693' and '127.0.0.1:4693' (no scheme) give the same stack trace, exit 1.
(g) Nothing listening on 127.0.0.1:4697: stderr is only "fetch failed", exit 1, with no URL and no ECONNREFUSED cause.
The same 11-line trace and exit 1 also come through `npm run client -- status` and `node bin/codeflow.mjs client status` (the launcher's supervise() passes the child's exit code through). The client fails before any network call, so the server's state does not matter. Not by design: docs/api.md only says the client "accepts CODEFLOW_URL for another configured origin", and the script's own message shows the check is meant to reject these URLs with a clear message. Not environmental: plain node v22.14.0 with no special profile. I created no runs. Server v4693 is stopped.

</details>

### t22-14 · minor · Generated Homebrew formula fails `brew style` (dependency order, Formula[] path method)

Source: tester unit infra-remote-devices-clients-2; observed with code-reading; features INFR-GAP-01.

**Repro**

> 1. In a snapshot: npm run release:prepare. 2. brew style output/releases/Formula/code-flow.rb

**Expected:** The formula passes brew style/audit before being copied into the tap.

**Actual:** 2 offenses: FormulaAudit/DependencyOrder ('git' should come before 'node@22') and Homebrew/FormulaPathMethods (use formula_opt_bin("node@22") instead of Formula["node@22"].opt_bin). ruby -c passes.

**Root cause (verifier):** scripts/prepare-preview.mjs:29-30: the formula template lists `depends_on "node@22"` before `depends_on "git"`. Homebrew's FormulaAudit/DependencyOrder cop wants dependencies sorted alphabetically, so git comes first. scripts/prepare-preview.mjs:36: the launcher heredoc uses `#{Formula["node@22"].opt_bin}/node`. Since Homebrew 6.0.3 (commit 47616eaa1d "Avoid formula objects for stable paths", 2026-06-22) the Homebrew/FormulaPathMethods cop (Library/Homebrew/rubocops/formula_path_methods.rb) flags this and asks for the `formula_opt_bin("node@22")` helper (Library/Homebrew/utils/path.rb:169). The template is written straight to output/releases/Formula/code-flow.rb with no lint step, and no test checks the formula text.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/scripts/prepare-preview.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/releasing.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/release/package.test.mjs`

**Suggested fix:** In the template in scripts/prepare-preview.mjs: (1) move `depends_on "git"` above `depends_on "node@22"`. (2) Change the exec line to `exec "#{formula_opt_bin("node@22")}/node" "#{libexec}/bin/codeflow.mjs" "$@"`. I checked this exact result: it passes brew style with 0 offenses. One caveat: `formula_opt_bin` only exists in Homebrew 6.0.3 and later (June 2026), so anyone installing on an older Homebrew would get NoMethodError. That risk is small because Homebrew auto-updates before installing, but the minimum version is worth writing down. Optionally, consider pulling the template into a small exported function so a test can check it without building and packing. Also add `brew style output/releases/Formula/code-flow.rb` (and `brew audit --strict` once the formula is in the tap) to the Homebrew steps in docs/releasing.md. Optionally, run `brew style` in the macOS job of .github/workflows/preview-release.yml before the formula is uploaded at line 189.

**Suggested regression test:** Add a test in test/release/package.test.mjs, or a new test/release/formula.test.mjs, that builds the formula text from the template, ideally through an exported `homebrewFormula({url, version, sha})` helper so it does not have to build or pack. Assert that the `depends_on` names are sorted (`assert.deepEqual(deps, [...deps].sort())`). Assert the text does not match /Formula\["[^"]+"\]\.opt_/ and does contain `formula_opt_bin("node@22")`. When `brew` is on PATH (as on the macOS CI runners), also  …

<details><summary>Verifier's independent reproduction</summary>

No QA server was needed or started. This is a release-script problem, not a server one. Steps: 1) Made a fresh snapshot with qa-server.sh snapshot v4605. 2) Ran `npm run release:prepare` in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4605. It exited 0 and wrote midhunxavier-code-flow-0.1.0-preview.7.tgz, the .sha256, preview-notes.md and Formula/code-flow.rb. 3) `ruby -c output/releases/Formula/code-flow.rb` gave Syntax OK. 4) Ran `HOMEBREW_NO_AUTO_UPDATE=1 brew style output/releases/Formula/code-flow.rb` with Homebrew 7.0.9-84 (rubocop gems were already installed, so the Homebrew install was not changed). Exit 1, "2 offenses detected": FormulaAudit/DependencyOrder at 11:3 ('dependency "git" (line 11) should be put before dependency "node@22" (line 10)') and Homebrew/FormulaPathMethods at 17:15 ('Use formula_opt_bin("node@22") instead of Formula["node@22"].opt_bin'). This matches the report exactly. Two things I ruled out: (a) A copy of the file outside a `Formula/` directory gets 3 more offenses (Sorbet sigils, frozen-string-literal), but those come from where the file sits, not from the formula. Homebrew's .rubocop.yml excludes `**/Formula/**/*.rb` from those cops, and the reporter's path is inside Formula/, so the reporter's count of 2 is correct. (b) Checked the fix: a scratch copy at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4605-brew/fixed/Formula/code-flow.rb with `git` listed before `node@22` and `#{formula_opt_bin("node@22")}` gives "1 file inspected, no offenses detected" (exit 0) and ruby -c OK. Is it by design? docs/releasing.md:104-114 only asks for `brew install --build-from-source` + `brew test` after copying the formula into the tap. It never says brew style/audit may be skipped, and no code comment accepts these offenses. No test covers the formula (test/release has launcher, npm-publish and package tests only), and .github/workflows/preview-release.yml:189 uploads the formula without linting it. The formula still installs and works. The problem is the lint failure, which would turn the tap's standard `brew test-bot --only-tap-syntax` / `brew audit` CI red when the formula is copied in. Severity stays minor.

</details>

### t01-17 · minor · npm run docs:preview hard-codes port 4319 with no override

Source: tester unit shell-navigation-settings-2; observed with code-reading; features SHEL-GAP-02.

**Repro**

> 1. Run npm run docs:preview while another process uses 127.0.0.1:4319.

**Expected:** A PORT override or an automatic free port.

**Actual:** listen(4319, "127.0.0.1") is fixed. Not executed, to avoid clashing with other QA units.

**Root cause (verifier):** scripts/preview-docs.mjs:33-35 calls `.listen(4319, "127.0.0.1", ...)` with a hard-coded port and also hard-codes the URL in the log line. It reads no env var or CLI argument, has no fallback, and attaches no 'error' handler to the http server. When the port is taken, the EADDRINUSE becomes an unhandled 'error' event and the process exits with a stack trace (the docs have already been rebuilt by then, at line 5).

**Files:** `scripts/preview-docs.mjs`, `docs/documentation.md`, `README.md`, `test/docs.test.ts`

**Suggested fix:** 1. In scripts/preview-docs.mjs, read the port from a docs-specific variable such as `DOCS_PORT` (or a `--port <n>` argument), defaulting to 4319. Do not reuse plain `PORT`: a shell that exports PORT=4317 for the main server would then point the docs preview at the main server's port. Check the value is an integer from 0 to 65535, and allow 0 to mean "any free port".
2. Store the server and log the real bound address from `server.address().port`, not a hard-coded string.
3. Add `server.on("error", ...)`. On EADDRINUSE, print one line such as "Port 4319 is in use; set DOCS_PORT=<n> (or 0 for any free port)" and exit with code 1. Optionally, fall back to listen(0) automatically when the default port is busy and no override was given.
4. Optionally, export a `startDocsPreview({ port })` function and run it only under an `import.meta.url === pathToFileURL(process.argv[1]).href` guard, so a test can call it without spawning a process.
5. Document `DOCS_PORT` in docs/documentation.md (around  …

**Suggested regression test:** In test/docs.test.ts (or a new test/preview-docs.test.ts):
(a) Spawn `node scripts/preview-docs.mjs` with DOCS_PORT=0, wait for the "Documentation preview: http://127.0.0.1:<n>" line, and assert that n is not 4319 and that fetching http://127.0.0.1:<n>/ returns 200 with text/html. Then kill the child.
(b) Hold a free port with net.createServer().listen(0), spawn the script with DOCS_PORT set to that port, and assert it exits non-zero within a timeout. Assert stderr contains the friendly "in use" …

<details><summary>Verifier's independent reproduction</summary>

No QA server was needed because this is a CLI script. I made a snapshot copy (qa-server.sh snapshot v4641 -> /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4641), because buildDocs() writes into dist/ and the source tree is read-only. I first checked that 127.0.0.1:4319 was free (lsof showed no listener). Then I ran /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4641/t01-17.mjs, which writes its output to t01-17.log in the same folder.
Case A: a net server held 127.0.0.1:4319, and `npm run docs:preview` ran with PORT=4641. The docs built, then the process crashed with exit code 1 and an unhandled 'error' event stack: "Error: listen EADDRINUSE: address already in use 127.0.0.1:4319". It never tried another port.
Case B: 4319 was free and PORT=4641 was set. The script printed "Documentation preview: http://127.0.0.1:4319". A request to 4641 got ECONNREFUSED and a request to 4319 got 200, so PORT is ignored.
After stopping the child, 4319 refused connections again (no leftover listener and no leftover preview-docs process). I started no QA servers and created no runs.

Arguments for "by design" that I checked: docs/documentation.md:21 ("Open 127.0.0.1:4319") and README.md:125 document 4319 as the address, but nothing says an override is deliberately unsupported. The main server reads PORT through envNumber (src/config.ts:43). scripts/screenshot-docs.mjs:49 and scripts/test-acp-live.mjs:32 already pick a free port with listen(0). So the fixed port is an oversight, not a decision.

Severity: raised from cosmetic to minor. This is a developer-only convenience script with a simple workaround (free port 4319), but the problem is functional, not visual: the preview cannot run while the port is taken, and the failure is a raw stack trace instead of a helpful message.

</details>

### t12-19 · minor · evaluate:project-teams loses its report when the code-flow root is not a git checkout

Source: tester unit project-missions-1; observed with fake-agents; features MIS-23.

**Repro**

> From a copy of the source without .git: npx tsx scripts/evaluate-project-teams.ts --fake --cycles 10 --out <dir>.

**Expected:** The report is written (applicationRevision 'unknown') or the check happens before running cycles.

**Actual:** All 10 cycles complete, then the run crashes with 'fatal: not a git repository' on `git rev-parse HEAD`, and no report.json is written.

**Root cause (verifier):** scripts/evaluate-project-teams.ts:47 builds the report object inline with `applicationRevision: git(root, "rev-parse", "HEAD")` and `applicationDirty: !!git(root, "status", "--porcelain")`. The `git` helper (line 22) is a bare execFileSync that throws on a non-zero exit. Both calls run only after the cycle loop and its try/finally (lines 40-46) have finished, and nothing catches the error. So when `root` (resolved at line 15 from import.meta.url) is not a git work tree, the first call throws "fatal: not a git repository". The process exits before line 48 writes report.json, and the cycle `results` gathered in memory (lines 39-45) are dropped. Unlike scripts/evaluate-teams.ts:62-63, which reads the revision before doing any work, this script reads it last. The same thing happens in a git repo with an unborn HEAD.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/scripts/evaluate-project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`

**Suggested fix:** Read the provenance before the fixtures are set up and before any cycle runs, next to the cliVersions capture (line 37) or straight after line 21. This matches scripts/evaluate-teams.ts. Read it through a guarded helper, e.g. `const provenance = (() => { try { return { applicationRevision: git(root, "rev-parse", "HEAD"), applicationDirty: !!git(root, "status", "--porcelain") }; } catch { return { applicationRevision: "unknown", applicationDirty: null }; } })();`.

When the revision is unknown in real mode, either refuse to start (real evidence must be attributable to a commit) or record "unknown" with a printed warning. Fake mode should degrade to "unknown".

Also make the report write survive late failures. Wrap the per-team `git(repo, "rev-parse", "main^{tree}")` calls in try/catch as well, or write report.json (with partial cycles and an error field) from the finally block, so a crash after paid cycles still leaves the evidence that was gathered. Optionally update docs/project-teams …

**Suggested regression test:** Add a test in test/project-teams.test.ts, or a new test/project-teams-evaluation.test.ts modelled on test/team-evaluation-runner.test.ts. It copies scripts/, src/ and test/fake-bin into a mkdtemp directory with no .git (node_modules symlinked), or sets GIT_DIR/GIT_CEILING_DIRECTORIES so `git rev-parse` fails for root. It then runs `node --import tsx scripts/evaluate-project-teams.ts --fake --cycles 1 --out <tmp>/out` via execFile and asserts that:
- the exit code is 0;
- <tmp>/out/report.json ex …

<details><summary>Verifier's independent reproduction</summary>

I made my own copy with `qa-server.sh snapshot v4689`. The snapshot rsync excludes .git, which is how the reporter's copy lost it too. That gave /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4689. `git -C <copy> rev-parse --show-toplevel` failed with "not a git repository", so no parent directory is a git repo. Its scripts/evaluate-project-teams.ts is identical to the dogfood source. No server was needed.

1) In that copy I ran `npx tsx scripts/evaluate-project-teams.ts --fake --cycles 10 --out .../work/v4689/nogit`. The log is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4689/nogit.log. It printed "Completed pilot cycle 1/10" through "10/10", then "fatal: not a git repository", then "Error: Command failed: git rev-parse HEAD". The exit code was 1 after about 10.6s. The out dir holds fixture-1, fixture-2 and home/ (12 run files) but no report.json, so the in-memory per-cycle results are lost.

2) Control in the same copy: `git init` plus one empty commit, then `--cycles 2 --out .../withgit`. It exited 0 and printed "Report: .../withgit/report.json". The report has applicationRevision 40944c13…, applicationDirty true and 2 completed cycles.

I tried to refute it:
- The docs (docs/project-teams.md:109) only document `npm run evaluate:project-teams` and say nothing about requiring a git checkout.
- package.json is private, so this is a maintainer/dev script. That means the trigger, a source copy without .git, comes from the environment, such as the QA snapshot or a source ZIP download.
- Still, collecting the revision only after all the work is not intentional. The sibling script scripts/evaluate-teams.ts:62-63 runs the same `git rev-parse HEAD` and `git status --porcelain` before any runs, so it fails fast.
- In real mode the late failure would throw away up to 10 cycles of paid CLI work (cycles × 24 invocations and cycles × 60 minutes) and then exit without a report.

I did the cleanup: I removed the .git I created in my snapshot copy. I started no QA server and no evaluate processes are left. The eval output dirs (fixtures and private home) remain under work/v4689 as evidence.

</details>
