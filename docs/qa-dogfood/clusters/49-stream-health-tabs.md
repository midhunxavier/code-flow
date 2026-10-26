# Cluster 49 · stream-health-tabs

**Live stream reconnect, /api/health metrics and cross-tab run deletion**

Status: **fixed and verified** · 7 issues · branch `codex/qa-stream-health-tabs`

Planner notes: reconnect()/probe() in ui/stream.ts (161-181) reconnects only when /api/health resolves, so any rejection leaves 'Reconnecting…' forever (t25-10). Retry with backoff and show the reason. t25-12: a server restart force-reloads only the leader tab, discarding open dialogs and input (the streamSharing rotation at src/server.ts:1443; ui/main.tsx). t25-15/t26-4: forgetRun (ui/state.ts:877) silently sends a viewing tab to New run and drops the typed follow-up; show a notice and keep the draft. t24-7/S13-7/S15-3: PerformanceMetrics.snapshot() (src/performance.ts:22-29) resets the event-loop delay histogram and the ELU baseline on every GET /api/health, so the stream probe hides stalls from other observers. Compute the windows without changing shared state. Duplicate groups: [["t25-15","t26-4"],["t24-7","S13-7","S15-3"]]

Likely files: `ui/stream.ts`, `src/performance.ts`, `src/server.ts`, `ui/main.tsx`, `ui/state.ts`, `ui/run.tsx`, `ui/run-actions.tsx`, `ui/app.tsx`

## Continuation outcome · 2026-10-26

- **t25-10:** reconnect no longer depends on diagnostic health. Identity checks have a ten-second timeout, retry after failure and expose the reason through the connection tooltip. Promoted followers and online recovery validate their broker identity before opening a stream.
- **t25-12:** a private persisted nonce and token-derived opaque sharing keys preserve the broker across same-token restarts; identity changes still rotate it. Corrupt storage is retained with an explicit warning and in-memory fallback. Independent review found that a later write failure could prevent logout; rotation now falls back in memory and still closes owner streams. Changed-token, corrupt-file, runtime-write-failure and logout cases are covered.
- **t25-15 / t26-4:** passive deletion shows a persistent notice with the unsent text and image downloads, replaces the stale history route and rejects cached run updates. The acting tab retains its own deletion feedback. A fresh deleted deep link renders recovery without cached conversation actions.
- **t24-7 / S13-7 / S15-3:** event-loop metrics are cumulative since metrics startup. Reads do not reset histogram or utilization baseline; the response names the window and sample count and returns null delay values before sampling. Documentation states these semantics.

Validation: typecheck and22 focused/related tests pass, including three new regressions; six new real-Chrome scenarios pass against an isolated server and scratch repository with fake providers. Five original-behavior replays all fail on detached pre-fix `d905023` and pass after the repair. Replays cover two restarts with two unsaved dialogs, follower promotion, failing/hanging diagnostics, remote deletion with durable text/PNG and unchanged history length, deleted deep links, a350ms server stall observed twice, and sign-out with an unwritable nonce path. Two original connection cases and all eight existing authentication browser cases also pass. Authentication test ports are now parameterizable so isolated parallel QA does not collide; its initial mixed-suite port collision is not counted as a product failure.

The final browser run asserts no page exceptions or unexpected console errors; only explicit server-stop/sign-out stream network failures are allowed. Server logs have no uncaught errors; the deliberate nonce fault emits the expected storage warning. Recovery layout screenshots were inspected after adding readable spacing. Evidence: `/private/tmp/codeflow-qa-continue/stream49-{related-final,e2e-verified,baseline,auth}.log` and `stream49-shots/`. No real model calls or live user data were used.

## Issues

### t25-10 · minor · Live updates never reconnect if /api/health fails; the pill shows 'Reconnecting…' forever with no reason

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-13.

**Repro**

> 1. On a fresh fake server, open the app.
> 2. Make /api/health return 500 (simulated with a Playwright route; in production this would come from an exception in its storage, activity or shell inspection).
> 3. Drop the owner stream without restarting the server, e.g. save a project's filesystem policy (PUT /api/projects/<id>/filesystem-policy with the same rules), which calls closeOwnerStreams().
> 4. Watch the pill for 30s, and start a run from elsewhere.

**Expected:** The stream reconnects whenever the server answers (a cheap liveness check, or the stream itself), or the UI explains what is failing.

**Actual:** The pill stays 'Reconnecting…' for 35s and longer, with /api/health retried every 5s. A run started meanwhile doesn't appear (not shown after 35s), while other API calls from the page return 200. As soon as /api/health succeeds, it reconnects in 256ms.

**Root cause (verifier):** ui/stream.ts:161-181 reconnect(): after a stream error it schedules probe(). probe() only calls connect() after `await api("/api/health")` resolves (line 176). Any rejection, such as a 5xx/4xx from the health route or a network error, is swallowed by `catch { retry = setTimeout(() => void probe(), 5_000); }` (line 178). So:
(a) Reconnection depends on a diagnostics/status endpoint rather than on the stream itself (/api/stream), so a failure that affects only /api/health keeps live updates down indefinitely while every other API works.
(b) The failure reason (ApiError message/status) is thrown away. connection() only ever gets state "reconnecting", so ui/app.tsx:208-210 can show only "Reconnecting…" with a generic title.
(c) The probe fetch has no timeout (ui/lib.ts:65-68 fetchJson does a plain fetch), so a hung health request stops the retry loop completely.

The trigger used in the report is synthetic. On the server, /api/health (src/server.ts:1952-1955) and /api/stream (src/server.ts:1900) pass through the same gates (owner auth, then fileAccess.ownerGate at src/server.ts:1636), and the health body is built only from in-memory stats and a cached, never-rejecting python probe (src …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/stream.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/stream-client.test.ts`

**Suggested fix:** In ui/stream.ts reconnect()/probe():

1. Treat any HTTP answer from the server as "the server is up". Call connect() whenever /api/health returns at all (catch ApiError with status > 0 and still connect), or drop the health probe and let the EventSource attempt be the liveness check, with the existing backoff. Keep the /api/auth/self identity check for the shared-lock case. With that, the only reason not to reconnect is "can't reach the server" (status 0). A 401 already goes through signInAgain().

2. Put a timeout on the probe, e.g. `api("/api/health", { signal: AbortSignal.timeout(10_000) })`, so a hung request falls into the retry path instead of stopping the loop.

3. Surface the reason. Extend StreamState with an optional `detail` (e.g. "Can't reach code-flow" or "Server answered 500: <message>") and a `since` time. Set them from the caught error in probe() and show them in the pill's title/tooltip in ui/app.tsx, optionally after N failed probes. Also consider capping the 5 s retr …

**Suggested regression test:** Add a case to test/stream-client.test.ts, which bundles ui/stream.ts with a FakeSource EventSource and a stubbed fetch. Make the fetch stub return { ok:false, status:500, json: {error:"boom"} } for /api/health. Subscribe a topic, trigger FakeSource.all.at(-1).onerror(), then wait (fake timers or until()) and assert that a new FakeSource is created (FakeSource.all.length grows) within the first probe interval, even though /api/health answered 500. In a second case, make /api/health never resolve  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4685 on port 4685 (new home). I used a scratch clone of MQTT-MCP for probe runs. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4685/ (health.mjs/health.log and control.mjs/control.log).

CONTROL (no fault injected; control.log): I saved MQTT-MCP's filesystem policy with the same rules (PUT /api/projects/p-ef01794b/filesystem-policy, 200, revision 3). The pill went to "Reconnecting…" and back to "Connected" in about 0.5 s, with 1 /api/health probe and 1 new /api/stream open. A run started afterwards showed up in the page within 4 s. The normal path works as docs/filesystem-policy.md describes ("Existing feeds close and reconnect").

FAULT INJECTED (/api/health answers 500 through a Playwright context.route; health.log):
- After the same policy save (200, rev 0->1), the pill read "Reconnecting…" at +5/10/15/20/25/30 s.
- /api/health was requested 6 times (every 5 s) and /api/stream was opened 0 times.
- Other fetches from the page returned 200 (/api/projects, /api/auth/self, /api/runs?limit=5).
- A run started meanwhile (201) was not in the page after 6 s.
- The pill tooltip is only the generic "Live updates are unavailable; displayed run information may be out of date". No reason is shown.
- Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4685/001-health-500-stuck.png
- After removing the route it reconnected in 4.3 s (the next 5 s probe) and the run appeared.

HANG VARIANT (route held without answering): only 1 /api/health request in 20 s, against 4 in the 500 case. While the probe's fetch is pending nothing retries, because api() has no timeout. Removing the route let Playwright release the held request, so I could not show a permanent hang end to end.

ATTEMPT TO REFUTE: the precondition is synthetic. I found no production path where /api/health fails while /api/stream works:
- Both routes sit behind the same auth check and fileAccess.ownerGate (src/server.ts:1636). The 409 that ownerGate returns while a policy is being applied hits the stream just as much.
- The health handler (src/server.ts:1952-1955) only reads in-memory counters (inspectRepositoryActivity, inspectStorage, performance/write stats, hub.stats). It also awaits shells.interactive(), a cached python probe with a 10 s timeout that resolves to undefined on error and never rejects …

</details>

### t25-12 · minor · A server restart force-reloads only the leader tab, discarding open dialogs and unsaved non-draft input

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-13, UX-14.

**Repro**

> 1. On a fresh fake server, open the app in tabs A and B.
> 2. In A, press 'p', then New project, and type a name without saving.
> 3. Run qa-server.sh stop t25, then start it again.
> 4. Wait about 8s.

**Expected:** Tabs reconnect without losing UI state, or every tab behaves the same and the user is told why a reload happened.

**Actual:** Tab A (the stream leader) reloads automatically: the dialog and the typed project name are gone, and the side panel closes. Tab B does not reload; it takes over the old broadcast group with its own stream, so there are now 2 streams. Composer, chat and review-feedback drafts do survive the reload (verified).

**Root cause (verifier):** src/server.ts:1443 sets `let streamSharing = { channelKey: randomBytes(32)..., lockId: randomBytes(16)... }` once per process. The intended rotation in closeOwnerStreams(true) at src/server.ts:1444-1446 only happens on login, logout and invite-accept, but a plain restart also gives the keys new values.
ui/stream.ts:168-178 (reconnect → probe): line 174 calls location.reload() whenever the owner's keys differ from the ones the tab bootstrapped with. The comment at lines 172-173 says this is meant for "a role switch or owner recovery", but a restart without any identity change also triggers it.
Only the leader runs this probe. Followers have no EventSource, so they never probe. When the leader reloads and releases the Web Lock, a follower gets it in the callback at ui/stream.ts:258-261. lead() at ui/stream.ts:273-277 then calls connect() straight away without checking its keys, so it keeps the old channel and lock. The reloaded tab bootstraps with the new keys (ui/main.tsx:67-73) and leads a second group. The result is 2 streams, uneven behaviour between tabs, and a second reload of every tab on the next restart. No message is shown, because the reload happens directly in reconnect() …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/stream.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/main.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/connections.e2e.ts`

**Suggested fix:** 1) Keep the keys the same across restarts when the owner session stays the same. At src/server.ts:1443, derive the keys from the owner token, e.g. channelKey = HMAC-SHA256(auth.token, "stream-channel:" + rotationNonce) and lockId = HMAC(auth.token, "stream-lock:" + rotationNonce) truncated to 16 bytes. rotationNonce starts as "" and closeOwnerStreams(true) sets it to a new random value. A restart with the same CODEFLOW_TOKEN (dev mode, or a pinned token) then gives the same keys, so no tab reloads. Logins, logouts and invite-accepts still rotate the keys, and a random per-start token still changes them as before. Anyone who can compute the keys already has the token. The lock name stays a separate HMAC, so it never reveals the channel key.
2) Stop followers from keeping a stale group. In ui/stream.ts lead(), before connect(), fetch /api/auth/self and reload if the keys differ, the same check probe() does, so any tab that takes over the lock validates its keys. Alternatively, have the l …

**Suggested regression test:** test/e2e/connections.e2e.ts: add a test that starts the server with a fixed CODEFLOW_TOKEN, opens two pages in one context, sets window.__marker in each, and opens the New project dialog in the first page with a typed name. It then restarts the server process with the same token and home, using the startServer pattern from test/e2e/project-teams.e2e.ts:20. Assert that (a) both markers survive and #project-name still holds the typed value, (b) streamsAre({streams:1, subscriptions:N}) once the tab …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake server "v4689-t2512" on 127.0.0.1:4689 (fresh home, fixed CODEFLOW_TOKEN from qa-server.sh), fresh headless Chrome context, scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4689-t2512/ (r1.mjs/r1.log, r2.mjs/r2.log, r3.mjs/r3.log).
r1: I opened tab A at /, then tab B at /. /api/health showed {streams:1, subscriptions:6}. I set window.__marker in both tabs and opened the side panel in A with its toggle. In both A and B I pressed p, clicked New project and typed a name ("Half-typed in A" / "Half-typed in B"). I ran qa-server.sh stop, waited 2s, ran start, then waited 10s.
Result: A had loads=1 and its marker was gone, so it reloaded. Its dialog and typed name were gone, and the only status text was "Connected", with no message about why the page reloaded. B had loads=0, its marker survived, and its dialog still held "Half-typed in B". /api/health then showed {streams:2, subscriptions:6}: A had started a new broadcast group and B was leading the old one. Screenshots: shots/v4689-t2512/001-A-before.png and 002-A-after.png.
r2: a second restart while the groups were split reloaded both tabs, because each now led a group with stale keys, and the stream count went back to 1.
r3: with a single tab, every restart reloads it. GET /api/auth/self returned lockId c8a919e7… before the restart and cdb242a2… after, which shows the keys are regenerated per process.
One part of the report did not reproduce: the side panel stayed open after A reloaded. When the user opens it with its toggle, sideOpen is saved in localStorage (ui/state.ts:70, 86-87).
Not explained by the tester's setup: the same thing happens in any setup where the browser stays signed in across a restart. That includes `npm run dev`, where scripts/dev.mjs:9-11 keeps one token "so the browser stays signed in while tsx restarts the server", and CODEFLOW_TOKEN, which docs/configuration.md:107 documents for keeping browsers signed in across restarts. docs/architecture.md:69 also says stream cursors hold across a restart. With the default random token per start, every tab has to sign in again anyway, so the reload is expected there.

</details>

### t25-15 · minor · A run deleted in another tab silently sends the viewing tab to New run with no explanation

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-14.

**Repro**

> 1. On a fresh fake server, open the same run in tabs A and B.
> 2. In A, choose Run actions > Delete… > Delete run.
> 3. Look at tab B.

**Expected:** Tab B tells the user the run was deleted (toast or message) before or instead of moving away.

**Actual:** Tab B jumps to #/ (New run) without any toast or notice. Anything the user was reading or typing there vanishes without explanation.

**Root cause (verifier):** ui/state.ts:877 `forgetRun()` sets `route.value = { view: "composer" }` when the open run (view "run" or "review") is the deleted one, and announces nothing. Deletions from elsewhere reach it through the SSE run stream: ui/state.ts:1133 `upsertRun(run)` leads to ui/state.ts:880 `if (run.deleted) { forgetRun(run.id); return; }`. The only "Run deleted" feedback comes from the delete dialog in the acting tab (ui/run-actions.tsx:54 `showToast(count === 1 ? "Run deleted" : ...)`), so a passive tab never gets any message. ui/app.tsx:143 then renders the composer because the route is no longer "run".

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-actions.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-history-ui.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** 1. Have forgetRun report the redirect. Give it an origin flag, for example `forgetRun(id, { remote: true })`, and pass that flag from the SSE path in upsertRun (state.ts:880). When the open run or review is closed because of a remote deletion, call showToast("This run was deleted in another window or by another user", ~6000ms) as the route changes. The toast container has role="status", so screen readers announce it too.

2. Avoid a wrong message in the acting tab. The SSE `deleted` event can arrive before the DELETE response. In deleteRun (run-actions.tsx:7), record the id in a local set such as `deletingLocally` before sending the request. forgetRun/upsertRun then treat events for those ids as local: they stay silent there, and the dialog's own "Run deleted" toast remains the acting tab's only feedback.

3. Optional, a richer version: instead of moving straight to the composer, render a short "This run was deleted" placeholder at #/run/<id> with a "Start a new run" button. A missing  …

**Suggested regression test:** Unit level: test/run-history-ui.test.ts already imports ui/state.js with a FakeEventSource. Add a test that sets `state.route.value = { view: "run", id: "r1" }` and seeds run r1. It then emits a stream event `{ run: { ...run("r1"), deleted: true }, seq: N }` and asserts that `route.value.view === "composer"` and that `toast.value?.text` (imported from ui/lib.js) matches /deleted/i. A second case calls the local delete path, marking r1 as deleting locally before the same event arrives, and assert …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake server v4695 on 127.0.0.1:4695 (qa-server.sh start v4695 4695 fake) with a fresh headless Chrome profile. To keep git state out of the real projects, I used a tiny scratch git repo (scratchpad/qa/clones/v4695-tiny). I created one solo fake-claude run through the API, waited until it was done and marked it seen. In one browser context I opened tab A and tab B, both on #/run/<id>, and typed "half-written follow-up in tab B" into B's reply composer. In tab A I went through the UI: rail row hover > "Run actions" > "Delete…" > "Delete run". Before the delete, a MutationObserver plus a hashchange listener in tab B started recording every [role=status], [role=alert], .toast and [aria-live] element.

Results (script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4695/t25-15b.mjs, log run2.log next to it):
- Tab A showed the toast "Run deleted" about 34 ms after the click.
- Tab B moved to http://127.0.0.1:4695/?team=local#/ about 36 ms after the click. The only new status text in B was the composer's own hint "Choose a repository first". B showed no toast, alert or other notice.
- B's main area became the plain New run composer ("What would you like to work on?", project and repository unset). All textarea values were empty, so the typed reply was gone.
- Afterwards the server returned 404 for the run, and there were no console or page errors and no 5xx responses.

Screenshots: before is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4695/B-before.png (run view with the draft in the composer). After is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4695/B-after-delete.png (empty New run, no notice). I also ran the script once before this (run1.log); that run hit a bug in my own script after the observation step, but tab B behaved the same way.

Why it is not by design, environment or the tester's script:
- Moving tab B away is intended: test/e2e/ui.e2e.ts:1441 asserts `other.waitForURL(url => !url.hash.includes(created.id))`.
- Nothing in docs (runs.md, accessibility.md, run-storage.md) or in code comments says the move should be silent. The test never checks for a notice.
- The app already explains the same kind of situation elsewhere: memory.tsx:165 shows "This entry was removed in another session", and workbench.tsx:70 shows …

</details>

### t26-4 · minor · Run deleted in another tab: the open tab silently jumps to New run and discards the typed follow-up

Source: tester unit usability-failure-cases-2; observed with fake-agents; features UX-22.

**Repro**

> 1. Open the same finished run in tabs A and B.
> 2. In tab A, type a follow-up in 'Message <agent>…' and don't send it.
> 3. In tab B: sidebar run, Run actions, Delete…, Delete run.

**Expected:** Tab A says the run was deleted in another window and keeps or offers to copy the unsent text.

**Actual:** Tab A switches to the New run composer immediately. No toast or notice appears, and the typed follow-up is gone (it is not kept in localStorage).

**Root cause (verifier):** The deletion reaches tab A as a stream event, and tab A navigates away without saying why or carrying the draft over:
- src/engine.ts:3629 emits {...run, deleted:true} on the bus.
- ui/state.ts:1133 calls upsertRun(run).
- ui/state.ts:880 sees run.deleted and calls forgetRun(id).
- ui/state.ts:876, inside forgetRun: `if ((route.value.view === "run" || route.value.view === "review") && route.value.id === id) route.value = { view: "composer" };` There is no showToast and no draft hand-off.
- ui/main.tsx:96 pushes this change onto history with pushState, which is why Back goes back to the stale run.

The draft itself is in ConversationBar state, persisted per run:
- ui/run.tsx:1765-1768 is agentDrafts plus sessionStorage `agent-draft:<id>`.
- ui/run.tsx:1783 writes it.

When the route changes, ConversationBar unmounts, and nothing reads agent-draft:<id> for a deleted run. The key is never cleared either, so it stays orphaned in sessionStorage.

Separately, a missing run that is still in the run view's cache renders as a stale finished run with inline "Run not found" (ui/run.tsx:122 shows the chats-load toast). It does not show a clear "this run was deleted" state.

**Files:** `ui/state.ts`, `ui/run.tsx`, `ui/run-actions.tsx`, `test/e2e/ui.e2e.ts`

**Suggested fix:** 1. In forgetRun (ui/state.ts:871-877), tell the user only when the open view's run was deleted somewhere else:
   - Have deleteRun in ui/run-actions.tsx pass a flag such as forgetRun(id, { local: true }), or check whether this tab's own DeleteRunsDialog started the delete. The deleting tab already shows "Run deleted".
   - In any other tab, before navigating, read the draft from sessionStorage `agent-draft:<id>` (export a small helper from run.tsx, or move agentDrafts into state.ts).
   - Then show a notice such as "This run was deleted in another window." When a draft exists, add "Your unsent message was kept" with a Copy action, or put the text into the New run composer as a task draft.
   - Use a persistent role=alert banner rather than a 2 s toast, so screen-reader users and anyone who looked away still see it.
2. When navigating for a deletion, use history.replaceState instead of pushState, so Back doesn't reopen a stale view of the deleted run. Or make the run view treat a 404 fo …

**Suggested regression test:** Extend the existing two-tab delete test in test/e2e/ui.e2e.ts (around lines 1401-1445, where `other` already opens #/run/<id> and line 1441 waits for it to leave the run).

Before deleting from `fresh`:
- Fill other.getByRole('textbox', { name: 'Message agent' }) (or the Reply box) with a unique string.

After the delete, assert:
- `other` shows getByRole('alert') containing "deleted in another window".
- The unsent text is offered through a Copy button or put into the New run task box.
- `fresh …

<details><summary>Verifier's independent reproduction</summary>

I started my own fake-mode QA server, v4643 on 127.0.0.1:4643, with a scratch clone of MQTT-MCP as the repo. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4643/del.mjs. I ran it twice: r1 with a persistent profile and r2 with a fresh browser (del-fresh.mjs). Logs are r1.log and r2.log in the same folder. Both runs gave the same result.

Steps:
1. Created a finished solo Claude run through the API (precondition only) and marked it seen.
2. Opened #/run/<id> in tab A and tab B of one browser context.
3. In tab A, typed into the follow-up box (placeholder "Message Claude Code…") and didn't send. The text was in sessionStorage under agent-draft:<id>.
4. In tab B: sidebar row, then Run actions, then Delete…, then Delete run.

Result in tab A:
- It switched to the New run composer ("What would you like to work on?") within about 150 ms.
- A MutationObserver on .toast, [role=alert], [role=status] and [aria-live] caught only "1 task loaded", "Connected", "0 tasks loaded", "Choose a repository first" and "Loading view…". There was no notice that the run was deleted.
- No textarea on the page held the draft. Screenshot: shots/v4643/002-r1-A-right-after.png.

Two corrections to the report:
- The draft is not lost and was never meant for localStorage. It stays in sessionStorage (agent-draft:<id>) and in the in-memory agentDrafts map, but it is orphaned.
- The route change was pushed onto browser history, so pressing Back in tab A returns to #/run/<id>. That shows a stale cached view of the deleted run: header, a "Ready to review" card with "Review changes" and "Preview", an inline "Run not found", a "Could not load this task's chats: Run not found" toast, and the draft back in the box with Send enabled (shots/v4643/004-r1-A-after-back.png). So the text can be recovered only through a non-obvious Back trick, and that lands on an inconsistent page.

Not by design:
- test/e2e/ui.e2e.ts:1441 deliberately checks that the other tab leaves the deleted run's URL, so the navigation itself is intended.
- No doc or comment says this should happen silently or drop a draft.
- The app's own pattern for edits in another window keeps the draft and tells the user: ui/side.tsx:360, "This note changed in another window. Your draft is preserved."

Not environmental: it happens in a fresh profile, with selectors taken from the shipped UI.

Cleanup: both runs were deleted through tab B's UI. I removed thei …

</details>

### t24-7 · minor · GET /api/health resets event-loop delay/utilization on every call, so concurrent observers hide each other's stalls

Source: tester unit infra-platform-memory-ml-insights-2; observed with api; features PLAT-21.

**Repro**

> 1. curl /api/health three times in a row with the owner token. 2. Compare performance.eventLoop.

**Expected:** Event-loop metrics describe a stable window (or cumulative values), independent of who else polls health (the UI reconnect probe, Settings diagnostics, a monitoring script).

**Actual:** First call p95 22ms / max 34.6ms. Every immediate later call p95 0.0005 / max 0. A stall between two callers is reported only to whichever caller comes first.

**Root cause (verifier):** src/performance.ts:22-29, in PerformanceMetrics.snapshot(), changes the shared state on every read:
- Line 24 computes eventLoopUtilization relative to `this.utilization`, then overwrites `this.utilization` with a fresh mark. Each caller's utilization therefore covers only the time since the last caller.
- Line 26 calls `this.delay.reset()`, which empties the one shared monitorEventLoopDelay histogram.

The server has one shared instance (src/server.ts:1493), and GET /api/health returns `performanceMetrics.snapshot()` (src/server.ts:1954). Every caller of /api/health uses up the window for everyone else:
- the UI reconnect probe (ui/stream.ts:176)
- Settings > Collect diagnostics (ui/settings.tsx:166, the `runtime` field)
- any external monitor

The reconnect probe makes this worse in practice. A stall long enough to drop the SSE stream sets off a reconnect, and that probe calls /api/health first. So the stall is wiped before the user can click "Collect diagnostics". The probe runs in every open tab.

Effects:
- Right after another read, the histogram is empty and reports p95 about 0.0005 ms and max 0. The response does not say how many samples it holds, so "no data" looks like "no …

**Files:** `src/performance.ts`, `docs/performance.md`, `test/performance-boundaries.test.ts`

**Suggested fix:** Make snapshot() read-only. It should never call delay.reset() or move the utilization mark.

Option A (simplest): report cumulative values since the server started.
- p95/max from the histogram, never reset.
- utilization from `performance.eventLoopUtilization()` with no arguments, or relative to a baseline taken in the constructor that is never moved.

Option B (keeps "recent" information): rotate a fixed time window on a timer, not on reads.
- An unref'd setInterval (for example every 60 s) copies p95/max/count/utilization into `lastWindow`, then resets the histogram and moves the mark.
- snapshot() returns `{ window: { seconds, p95Ms, maxMs, utilization, samples }, current: {...partial, sinceMs}, sinceStart: { maxMs } }`. Because no reads change anything, every observer sees the same numbers.
- A cumulative histogram could also be kept with createHistogram() plus add().

In both options:
- Include `samples` (delay.count) so an empty window is distinguishable from zero delay.
- Optio …

**Suggested regression test:** Add to test/performance-boundaries.test.ts, or a new test/performance-metrics.test.ts:

(1) Unit test:
- Create `new PerformanceMetrics()`, busy-wait about 150 ms synchronously, then await setTimeout(50) so the delay timer records the stall.
- Call snapshot() twice in a row.
- Assert both `a.eventLoop.maxMs >= 100` and `b.eventLoop.maxMs >= 100`, and that `b.eventLoop.samples > 0`. The second reader must still see the stall.
- If Option B is chosen, use t.mock.timers to advance past the window.  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server: `qa-server.sh start v4671 4671 fake` (pid 90968, 127.0.0.1:4671). The script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4671/health-reset.mjs called GET /api/health with `Bearer qa-v4671-token`.

(1) Three calls back to back, as the reporter did:
- call 1: p95Ms=22.10, maxMs=28.51, util=0.0040
- call 2: p95Ms=0.0005, maxMs=0.00, util=0.3182
- call 3: p95Ms=0.0005, maxMs=0.00, util=0.5665

(2) Two observers with a known stall. I froze my own server process for 600 ms (kill -STOP, then kill -CONT on pid 90968). Observer A then polled, and observer B polled 50 ms later. I ran this twice:
- Round 1: A maxMs=606.60, B maxMs=22.05
- Round 2: A maxMs=614.99, B maxMs=22.05
- Both rounds: A saw the stall, B did not.

(3) Control, after 1 s idle with no stall: maxMs=22.48.

(4) A standalone check on Node v22.14.0 with monitorEventLoopDelay({resolution:20}):
- Idle for 1 s: count 45, p95 22.09 ms, min 20.09 ms.
- Right after reset(): count 0, p95 0.000511 ms, max 0.
So the "0.0005 / 0" values the reporter saw are not a measurement. They come from an empty histogram that the previous caller had just reset.

Why this is not by design: docs/performance.md:108-112 only says /api/health "includes ... event-loop delay/utilization" and calls it a "snapshot". Nothing says that reading it consumes or resets the data. The code comment at src/performance.ts:4 talks only about boundedness. No test or benchmark relies on reset-on-read: scripts/benchmark-compare.ts uses /api/health only as a readiness check, and no test asserts eventLoop.

Why this is not the tester's environment: it reproduces on a fresh home with the bearer token, and the stall I injected is deterministic.

Cleanup: I stopped the server (port 4671 is free) and created no runs. The home already had an entry I did not create, `runs/2610252228-023cdfae.deleted`; I left it alone.

</details>

### S13-7 · minor · snapshot() resets the event-loop delay histogram and the ELU baseline on every /api/health call. Concurrent callers (the stream reconnect probe in ui/stream.ts:176, Diagnostics) truncate each other's measurement windows, which makes the p95 and maximum figures unreliable.

Source: code-level suspect at `src/performance.ts:26` (confirmed hands-on).

**Repro**

> (1) Scratch test in the snapshot (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/s13/test/qa-s13-perf.test.ts, run with npx tsx --test). After a 400 ms event-loop stall, a lone reader sees maxMs 412.4. With a 'probe' snapshot taken in between, the probe gets maxMs 409.5 and the following 'Diagnostics' snapshot gets maxMs 22.0, p95 22.0 and utilization 0.003, so the stall has vanished. Both tests pass. (2) Live on QA server s13, three back-to-back GET /api/health calls returned eventLoop {p95Ms 22.069, maxMs 45.679, util 0.005}, then {20.873, 20.873, 0.026}, then {p95Ms 0.001, maxMs 0, util 0.049}. The last window was effectively empty, so p95 and max are meaningless.

**Expected:** Settings > Collect diagnostics reports event-loop delay and utilization over a defined window (e.g. the last 60 s, or since start plus a recent window) that other /api/health callers do not reset.

**Actual:** Any /api/health request resets the histogram and ELU baseline. A connectivity probe right before Diagnostics hides stalls, and back-to-back calls report p95 ~0 and max 0.

**Root cause (verifier):** PerformanceMetrics.snapshot() reads the delay histogram and then calls this.delay.reset(), and it re-bases this.utilization on each call. The event-loop window is therefore 'since the previous GET /api/health by anyone'. Callers that never look at the numbers also consume the window: the reconnect probe in ui/stream.ts (every open tab after a stream drop), the desktop launcher's startup polling, benchmark and CLI health calls. The window length is undocumented (docs/performance.md says only that /api/health 'includes … event-loop delay/utilization'). An empty window reports nonsense values.

**Suggested fix:** Stop resetting on read. Keep the histogram cumulative since start and maintain a rolling window internally: e.g. a 10 s timer that snapshots, stores into a small ring buffer (last 6 intervals of p95/max/ELU) and resets. snapshot() then returns the aggregates of the ring buffer plus since-start values and a windowSeconds field, without mutating state. Alternatively, have the reconnect probe use a lightweight endpoint (e.g. /api/auth/self or a /api/ping) instead of /api/health, and document the window.

**Suggested regression test:** Unit test: stall the loop 300 ms, call snapshot() twice in a row, and assert that the second call still reports maxMs >= 300 (and a non-zero windowSeconds) within the rolling window. HTTP test: two consecutive GET /api/health calls return the same window-level maxMs.

### S15-3 · minor · snapshot() resets the event-loop delay histogram and the ELU baseline on every /api/health call, so any caller clears the window for every other caller, and p95/max mean 'since the last poll by anyone'.

Source: code-level suspect at `src/performance.ts:24` (confirmed hands-on).

**Repro**

> (a) Scratch test qa/builds/s15/test/qa-s15/perf-reset.test.ts (npx tsx --test, passes): blocked the event loop for 400 ms, then called snapshot() twice. The first caller got maxMs=421, the second got maxMs=0 and utilization=1 (a window of a few microseconds). (b) Live on QA server s15, three back-to-back GET /api/health: maxMs 33.9 → 19.99 → 0 (p95 0.0005), utilization 0.007 → 0.057 → 0.060.

**Expected:** Collect diagnostics reports the stall that happened before it, whichever tab or probe hit /api/health first. Or the export states the measurement window.

**Actual:** A tab reconnecting after a server stall (the reconnect probe calls /api/health) erases the stall. A later 'Collect diagnostics' then shows near-zero event-loop delay, and back-to-back callers get meaningless utilization values (1 or near 0).

**Root cause (verifier):** PerformanceMetrics.snapshot() calls this.delay.reset() and replaces this.utilization on every call. /api/health is called by the stream reconnect probe (ui/stream.ts:176, once per reconnect in every open tab), by Settings → Advanced → Collect diagnostics (ui/settings.tsx:166) and by scripts. The only consumer that shows these numbers is the diagnostics export, which has no indication of the window. docs/performance.md:108 only says '/api/health includes ... event-loop delay/utilization' and never mentions that reading resets the values. The HTTP samples in the same snapshot are cumulative (the last 1024), so the two halves of the snapshot use different semantics.

**Suggested fix:** Stop resetting on read. Keep cumulative values plus a rolling window rotated by a timer, e.g. swap two histograms every 60 s and report the last complete window together with windowSeconds. Compute ELU against a baseline taken at rotation. Alternatively, reset only for an explicit ?reset=1 from the diagnostics button.

**Suggested regression test:** Unit test on PerformanceMetrics: block 300 ms, call snapshot() twice, and assert that both report maxMs ≥ 250 (or that both report the same window with windowSeconds set).
