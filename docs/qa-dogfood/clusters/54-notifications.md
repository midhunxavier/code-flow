# Cluster 54 · notifications

**Notification delivery: restart false failures, damaged state, redirects, history, watch keys**

Status: **fixed and verified** · 5 issues · branch `codex/qa-notifications`

Planner notes: src/notifications.ts and ui/notifications.tsx. t16-8: after a restart, notificationEvents emits 'ended/failed' for interrupted runs, including runs that were only waiting for approval. t16-12: when notifications.load() fails (503), the page shows empty states instead of the reason. t16-13: with redirect:'error', a 3xx looks like a connection failure and is retried; classify it as a permanent configuration error. t16-14: cancelled jobs keep nextAttemptAt, so they still show 'Next:', and the label says '1 manual retries'. S08-1: the needs-you key for a PR watch digests watch.detail, which contains an incrementing failure count, so every failed poll notifies again. Coordinate with github-pr-watch, which may change the watch.detail text in src/watch.ts.

Likely files: `src/notifications.ts`, `ui/notifications.tsx`, `src/server.ts`

## Resolution and verification · 2026-10-26

All five issues were confirmed and fixed from integration base `d6fbc70` in `/private/tmp/codeflow-qa-notifications`. The five new backend regressions first failed against the unmodified source, including **14** duplicate attention deliveries during six simulated hours of failed PR polls. After the fixes the same tests pass and that watch sends **one** delivery.

| Issue | Outcome |
| --- | --- |
| t16-8 | Interrupted runs no longer produce ended/failure candidates. Failed/stopped runs and failed verification still produce failure events. Real server/browser replay enables all events, starts a pipeline at plan approval, gracefully restarts, confirms interrupted status without a failure delivery, resumes to a fresh approval wait and receives exactly one new attention delivery. A second shutdown stays quiet. |
| t16-12 | The panel distinguishes initial loading, load failure and unavailable saved state from a successfully loaded empty list. HTTP 503 replaces settings/history with preserved-file, server-log and restart guidance in both Settings → Notifications and Integrations. No connect/empty-history prompt or send/save/retry-delivery controls appear. Repairing the scratch file and restarting restores the history. Slow initial responses and aborted loads show loading/error feedback, and explicit Retry loading notifications recovers. |
| t16-13 | Requests use `redirect: "manual"`, so Node returns the actual HTTP status while following no Location. All 3xx responses fail once with a clear final-address instruction. Neither response bodies nor Location values enter stored/public metadata. Native fetch and a real local HTTPS receiver verify 302, 307 and 308, one request per destination and zero redirected requests; simulated later time produces no automatic retry. |
| t16-14 | Settings cancellation, claim-time expiry and retry-exhaustion paths clear `nextAttemptAt`. Loading old terminal rows removes stale retry times; interrupted sends still become unknown-outcome failures requiring explicit retry. UI renders Next only for pending rows and uses “1 manual retry”. Real UI scope narrowing and one manual retry confirm both labels. |
| S08-1 | Watch attention identity removes the volatile generated poll-count prefix while retaining its reason, branch and fix count; the watch start time distinguishes explicit rearming. Real `PrWatcher` with fake signed-out `gh` stays at one delivery across six simulated hours, watcher restart and notification reload. A material reason change and a new watch each notify. The real server/browser case reaches five failed polls with one attention delivery. |

Validation:

- New `test/qa-notifications.test.ts`: **5/5 failed before, 5/5 passed after**. Combined with the original notifications suite and cluster50's connection/storage regressions: **21/21 passed**.
- New real-Chrome `test/e2e/qa-notifications.e2e.ts`: **7/7 passed**. Combined with original notifications (**1**) and integration-connections (**5**): **13/13 passed**. The original cases include notification opt-in and explicit retry, source connections, reconnect, encrypted storage, restart, and accessible phone/theme behavior.
- TypeScript `tsc --noEmit` and `git diff --check`: **passed**.
- Final console/page exceptions: **none unexpected**. Expected browser resource failures are the two deliberately aborted notification GETs and four 503 responses from the two damaged-state screens. The application log contains the one injected damaged-state startup diagnostic, exactly four matching notification-route 503 diagnostics inside the recorded damaged interval, one expected signed-out watch warning, and normal shutdown messages. Only an exact health-stopping diagnostic inside an owned shutdown window is classified separately; the final run recorded none.

The UI suite uses isolated homes/tokens, scratch Git repositories and a local bare origin, fake agent/GitHub CLIs, and an actual loopback HTTPS receiver with a scratch certificate trusted only by the child process. A dedicated preload forbids non-loopback fetches. Ports 4361/4362 are checked before use; `QA_NOTIFICATIONS_PORT` can select another owned pair. Every test/build/application execution has explicit scratch `CODEFLOW_HOME`, and child processes also use a scratch OS home and non-login shell. Owned servers and receiver stop after the suite. No real credentials, external notification, user project, live server, remote mutation or provider call was used.

Evidence: `/private/tmp/codeflow-qa-continue/notifications54-before.log`, `notifications54-unit.log`, `notifications54-final-browser.log`, `notifications54-final-new.log`, and `notifications54-tsc.log`. Screenshots and browser/server/application/receiver logs are in `output/playwright/qa-notifications/` under this worktree, including `paused-approval.png`, `redirect-failures.png`, `cancel-and-manual-retry.png`, `watch-attention-once.png`, and both `damaged-state-*.png` screens.

Cluster 50's opt-in administrator-configuration recovery remains unchanged and its strict damaged-delivery-file tests pass. Real Slack/provider compatibility remains outside this fixture-only QA evidence. An initial browser fixture used a lowercase environment-reference name and was correctly rejected; correcting that fixture and waiting for the asynchronously loaded watch row resolved test setup failures without weakening product assertions.

## Issues

### t16-8 · minor · Restarting code-flow sends 'Run or verification failed' notifications for runs that were only waiting for approval

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-49.

**Repro**

> 1. Enable an outbound destination for project X with all events.
> 2. Start a pipeline run with plan approval on; it waits ('Open pending approval') and a needs-attention event is delivered.
> 3. Restart the server gracefully (qa-server.sh restart).

**Expected:** An approval wait interrupted by a restart either resumes waiting or is not reported to the team channel as a failure.

**Actual:** The run becomes 'interrupted' ('code-flow was shut down while this run was in progress. Resume to continue.') and the receiver gets event 'failure', status 'interrupted' (16:24:51). On an earlier restart, 2 more failure deliveries were queued for the 2 waiting runs.

**Root cause (verifier):** - src/notifications.ts:52-53: notificationEvents() emits an "ended" candidate for every status in ["done","failed","stopped","interrupted"] and computes `failed = run.status !== "done" || …`. An "interrupted" run therefore always becomes event "failure".
- During a graceful stop, src/server.ts:2960 (`await manager.shutdown()`) runs before `notifications.stop()` at 2963.
- Inside shutdown, src/engine.ts:5662 aborts every controller, including runs parked in ctx.approve() (engine.ts:1057-1075, waitForAnswer on this.signal). The catch block at engine.ts:5530-5532 then sets status "interrupted", and the finally block at 5582-5590 sets endedAt and calls emitRun().
- emitRun() reaches the subscribeAll listener at server.ts:2767, which calls notifications.observe() → enqueue(). The "failure" delivery is persisted to notifications.json and sent by the drain timer of the next process (or straight away).
- This affects every in-flight run on a graceful restart (active ones too), not only approval waits. It does not happen on a crash, because Engine.load() (engine.ts:3283-3292) marks runs interrupted before the subscription exists.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/notifications.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/notifications.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/notifications.md`

**Suggested fix:** - In notificationEvents (src/notifications.ts:52), treat "interrupted" as a resumable pause, not an ending. Drop it from the ended-status list, e.g. `["done","failed","stopped"]`, so a shutdown-interrupted run produces no done or failure candidate. This matches the crash-recovery path, which already sends nothing.
- When the user resumes, the run re-enters ctx.approve() with a new awaiting.at, so a fresh needs-attention event goes out. That gives the expected "resumes waiting" behaviour.
- Optional extra safeguard: stop observing new run events once shutdown begins. One way is a flag set at the start of stop() in src/server.ts and checked in the subscribeAll listener. Do not simply move notifications.stop() before manager.shutdown(): that would also drop genuine completions during the shutdown window.
- Document in docs/notifications.md that runs interrupted by a code-flow shutdown or restart are not reported as failures.
- Keep "stopped" (budget limit) mapped to failure, unless produc …

**Suggested regression test:** test/notifications.test.ts:
- New test: `assert.deepEqual(notificationEvents(run({ status: "interrupted", endedAt: 100, error: "code-flow was shut down…" })), [])`.
- With a counting fetch stub, after enable(value), `await value.observe(run({ status: "interrupted", endedAt: 100 })); await value.drain();` must leave calls at 0 and deliveries() empty.
- Keep the existing assertions that failed, stopped and verdict:"failing" still map to "failure".
Optional e2e in test/e2e/notifications.e2e.ts:
- E …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server named v4609t168 on port 4609, with a new home and no runs. Outbound HTTP went through the repo's own fixture transport, test/fake-notification-transport.mjs, loaded via NODE_OPTIONS. CODEFLOW_NOTIFICATIONS_JSON defined one webhook destination "fixture", pointing at https://notifications-fixture.invalid/hook with a random bearer value. Every request was logged to /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4609t168/requests.jsonl.
1. Settings, Notifications, in the UI (Playwright script 01-enable.mjs): I enabled the destination, ticked all three events and limited it to project MQTT-MCP. The API confirmed {enabled:true, events:[done,failure,needs-attention], projects:[p-ef01794b]}.
2. I started a pipeline run 2610252123-1d668ab1 on MQTT-MCP through POST /api/runs with approvals:{plan:true} and fake claude for every role. It reached awaiting {kind:"plan", title:"Approve the plan"} with status running. The receiver got event "needs-attention", status "running" (22:23:11).
3. I ran `qa-server.sh restart v4609t168` with the same env, so it was a graceful SIGTERM. Straight after the restart, GET /api/notifications/deliveries showed a new pending delivery: event "failure", createdAt 22:23:19.6, which is inside the shutdown window. The run was now status "interrupted", error "code-flow was shut down while this run was in progress. Resume to continue.", with awaiting cleared.
4. About 10 s later the restarted server's worker sent it. requests.jsonl recorded {event:"failure", runId:"2610252123-1d668ab1", status:"interrupted", result:"unchecked"} with HTTP 200. The Settings, Notifications history table showed "Run or verification failed · Delivered · HTTP 200" for this run.
The run page itself labels the state "Work is paused … Resume work" (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4609t168/002-run-interrupted.png). So the UI calls it a pause, while the team channel is told it failed.

Why this is not by design or a test artifact:
- docs/notifications.md describes the failure event only as "run or verification failure" and never says shutdown interruptions count.
- docs/runs.md:123-125 treats interrupted runs as resumable and puts them under "Needs you", not as failed.
- The crash path emits nothing: manager.load() runs at src/server.ts:2738, before the notifi …

</details>

### t16-12 · minor · Notifications page shows misleading empty states when notification state is damaged (503)

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-49.

**Repro**

> 1. Stop the server, write 'not json at all' into CODEFLOW_HOME/notifications.json, start the server.
> 2. Open Settings → Notifications.

**Expected:** A clear unavailable state: 'Notification settings and history are unavailable because their saved state is damaged; see the server log', with no 'connect a destination' prompt.

**Actual:** The page shows 'Connect Slack or a webhook in Integrations. New destinations start off…' and 'No notifications have been queued.', with the red line 'Notifications are disabled until their configuration and storage are repaired' at the bottom. The destinations and history do exist. The server correctly returns 503 and keeps the file. Screenshot: shots/t16/001-notif-503.png.

**Root cause (verifier):** The load-failure path never reaches the per-destination "unavailable" UI, and the list's empty states do not check the error.

- src/server.ts:245 runs `notifications.load()` once at startup and stores the result in the constant `notificationsReady`. When loading fails, src/server.ts:1857 returns 503 for every /api/notifications* route, before `notifications.list()` is called.
- src/notifications.ts sets `loaded` to false only at the top of load() (line 105) and to true at the end of it (line 148). So `available: this.loaded` at line 153 is always true in any response a browser can receive.
- ui/notifications.tsx:21: the poll's rejection handler only calls setError(err.message) and leaves `destinations` and `deliveries` at their initial [] state.
- ui/notifications.tsx:34 shows "Connect Slack or a webhook in Integrations…" whenever `!destinations.length`, and line 44 shows "No notifications have been queued." whenever `!deliveries.length`. Neither checks whether the load failed. The error appears only at line 45, below both.
- ui/notifications.tsx:71 has the `!target.available` branch with the correct message, but it cannot run in production because no destination is rendered when  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/notifications.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/notifications.e2e.ts`

**Suggested fix:** In NotificationsView (ui/notifications.tsx):

1. Track the load state, for example `loaded: boolean` together with `unavailable: string | undefined`.
2. In the rejection handler at line 21, check the error. ui/lib.ts:75 throws ApiError with `.status`, so `err instanceof ApiError && err.status === 503` identifies this case. Set `unavailable` and clear `destinations` and `deliveries`, or mark them as not loaded.
3. While `unavailable` is set, replace the destination list and the history table with one clear unavailable state and do not render either empty-state sentence. Suggested text: <p class="msg err" role="alert">Notification settings and delivery history are unavailable because their saved state is damaged. The file was kept for repair; see the server log, then restart the server.</p>
4. Show "Connect Slack or a webhook…" and "No notifications have been queued." only after a successful load (`loaded && !error && !list.length`). Before the first successful load, show a loading or no …

**Suggested regression test:** Add a case to test/e2e/notifications.e2e.ts, or a small new e2e file that uses the same fixture transport.

1. Start the server with the admin-managed "fixture" destination and send one test delivery so that history exists.
2. Stop the server, write '{damaged' to <home>/notifications.json, and start it again.
3. Open /#/settings/notifications and assert the following:
   - page.getByRole('alert') contains /unavailable|damaged/ and mentions the server log;
   - page.getByText('Connect Slack or a  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4617-t1612" on port 4617. Exported NODE_OPTIONS="--import <dogfood>/test/fake-notification-transport.mjs" and an administrator-managed webhook destination, set up the same way as test/e2e/notifications.e2e.ts: CODEFLOW_NOTIFICATIONS_JSON=[{id:"fixture",name:"Browser fixture",protocol:"webhook",urlEnv,secretEnv}], with a fixture URL on notifications-fixture.invalid and a random test credential.

1. Healthy state, in the UI at http://127.0.0.1:4617/#/settings/notifications: ticked "All projects", "Run finished" and "Run or verification failed", enabled the destination, saved, and clicked "Send test notification". GET /api/notifications returned the "fixture" destination (enabled, available:true). GET /api/notifications/deliveries returned 1 delivery (Manual test, delivered, HTTP 200), and the history table showed it.
2. Stopped the server with qa-server.sh stop, wrote 'not json at all' into homes/v4617-t1612/notifications.json, and started it again with the same environment. server.out logged "Notifications disabled: configuration or delivery state cannot be read: Notification state is damaged; notifications remain disabled and the file was preserved". GET /api/notifications returned 503 {"error":"Notifications are disabled until their configuration and storage are repaired"}, and /deliveries did the same. The file was left unchanged.
3. Opened Settings → Notifications in a fresh headless Chrome. The panel text was: "Connect Slack or a webhook in Integrations. New destinations start off; choose projects and events before enabling delivery." … "No notifications have been queued." … and a red role=alert line, "Notifications are disabled until their configuration and storage are repaired". Screenshots: scratchpad/qa/shots/v4617-t1612/panel-damaged.png and 001-damaged-settings-notifications.png.
4. Settings → Integrations shows the same panel with the same misleading empty states (002-damaged-integrations.png).

The destination and its delivery history exist, but the page reports none. The tester's setup did not cause this: I used a fresh browser, a fresh home and a different destination setup (admin-managed instead of app-managed) and got the same result. It is also not by design. docs/notifications.md:39 says only "Corrupt saved state leaves notifications unavailable and preserves the file for repair". The server does this correctly. The UI's own unavailable message, "Saved notification state is unavailable. Check the server log…" a …

</details>

### t16-13 · minor · Destination redirects are reported as connection failures and retried

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-48.

**Repro**

> 1. Point an outbound webhook at an HTTPS endpoint that answers 302 with a Location header.
> 2. Send a test notification and watch the delivery history.

**Expected:** A refused redirect fails once with a clear reason such as 'Destination redirected (HTTP 302); redirects are not followed'.

**Actual:** The reason is 'Connection, TLS or timeout failure' with no HTTP status, and it is retried at about +30s and +60s like a network outage.

**Root cause (verifier):** Cause:
- src/notifications.ts:289 calls this.fetcher(destination.url, { ..., redirect: "error", ... }). Node's undici fetch does not return a 3xx response in that mode. When the 3xx has a Location header, it rejects with TypeError("fetch failed", { cause: Error("unexpected redirect") }).
- The catch-all at src/notifications.ts:296 (`catch { /* Never retain fetch error text ... */ }`) discards the error. `status` stays undefined and `retryable` keeps its initial value `true`, which is set at src/notifications.ts:282.
- In the failure mutation at src/notifications.ts:301-304, `job.reason = status ? ... : "Connection, TLS or timeout failure"` picks the generic text. `retryable && job.attempts < MAX_ATTEMPTS` then reschedules the delivery with 30s and 60s backoff until three attempts are used.
- The no-error-text rule is fine. The catch just never looks at the error's cause, which carries no secret. src/collab/link.ts:265 already does this check (`cause?.message === "unexpected redirect"`).
- Tests did not catch it because test/notifications.test.ts:48 only asserts that options.redirect is "error". The stub fetchers return Response objects instead of behaving like undici, and test/fake …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/notifications.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/notifications.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/fake-notification-transport.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/notifications.md`

**Suggested fix:** Classify redirects separately in drainAll (src/notifications.ts:282-304). Two options:

(a) Smallest change, matching src/collab/link.ts:265: keep redirect:"error" and catch the error as `catch (error)`. When `(error as Error)?.cause instanceof Error && error.cause.message === "unexpected redirect"`, set `redirected = true` and `retryable = false`. In the failure mutation, set `job.reason = redirected ? "Destination redirected the request; redirects are not followed — configure the final HTTPS address" : status ? ... : "Connection, TLS or timeout failure"`. Never keep the error text or the Location value, since either can contain the secret URL.

(b) Use redirect:"manual" so Node returns the real 3xx. Treat `status >= 300 && status < 400` as non-retryable with reason `Destination redirected (HTTP ${status}); redirects are not followed`. httpStatus is kept, and nothing is followed. Change the assertion at test/notifications.test.ts:48 and the `options.redirect !== "error"` guard in test …

**Suggested regression test:** In test/notifications.test.ts, add "a redirecting destination fails once with a redirect reason and is not retried":
- Start a local node:http server that answers POST with 302 and `location: <its own /elsewhere>`, and count hits per path.
- Pass `new Notifications({ file, environment: { OUTBOUND_URL: "https://redirect.invalid/hook" }, fetch: (url, opts) => fetch(String(url).replace("https://redirect.invalid", base), opts), now })`, so the stub delegates to Node's real fetch and keeps the redire …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4619 on port 4619. The leftover v4619 home was moved aside first, so the server started with no runs and no notifications.json.
- Receiver: a local HTTPS receiver on 127.0.0.1:4621 (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4619-t1613/receiver.mjs) with a self-signed cert, trusted through an exported NODE_EXTRA_CA_CERTS. It answers by path: /redirect302 gives 302 with Location https://127.0.0.1:4621/ok, /redirect307 gives 307 with the same Location, /status400 gives 400.
- Destinations: three webhooks set in CODEFLOW_NOTIFICATIONS_JSON ("Redirecting hook" to /redirect302, "Redirect 307 hook" to /redirect307, "Control 400 hook" to /status400).
- Probe: a direct Node 22.14 fetch with the same options as src/notifications.ts (redirect:"error"). /redirect302 and /redirect307 both throw TypeError "fetch failed" with cause "unexpected redirect". /status400 returns status 400 and /ok returns 200.
- UI steps: Playwright script repro.mjs in the same work folder. Open Settings → Notifications, click "Send test notification" in each destination card (toast "Test notification queued"), then watch Delivery history for 2 minutes. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4619-t1613/repro.log.

What I saw:
- Control (400): "Failed · HTTP 400, Destination returned HTTP 400", 1 attempt. This proves TLS trust and HTTP-status reporting work, so the test environment is not causing the redirect result.
- Both redirect destinations: "Pending, Connection, TLS or timeout failure, Next: +30s", with no HTTP status. Second attempt at about +39s, next set to +60s, third attempt at about +109s. Final state: "Failed, Connection, TLS or timeout failure, Attempts 3".
- Receiver log: /redirect302 and /redirect307 each got the POST 3 times (21:26:29/30, 21:27:08, 21:28:18). /status400 got it once. /ok was never hit, so the redirect is correctly not followed.
- No console errors.
- Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4619/003-t1613-final.png

Not by design:
- docs/notifications.md:35 says delivery "refuses redirects. HTTP 429, server errors, and connection failures retry ... Other HTTP errors fail once." A 3xx is none of the retryable kinds.
- The UI help text says "Temporary failures retry up to three …

</details>

### t16-14 · cosmetic · Delivery history: cancelled rows still show 'Next:' and the label says '1 manual retries'

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-48, SCH-49.

**Repro**

> 1. With the destination returning 500, create a delivery so it is pending a retry.
> 2. Narrow the destination scope (untick 'Run finished') and save.
> 3. Separately, manually retry a failed delivery once.

**Expected:** A cancelled row shows no next attempt. The retry label reads '1 manual retry'.

**Actual:** The row shows 'Cancelled · HTTP 500 · Notification settings no longer allow this delivery · Next: 5:26:10 PM'. The retried row shows '4 / 1 manual retries'.

**Root cause (verifier):** 1) src/notifications.ts:183, Notifications.update(): for each pending job no longer allowed by the new settings it sets state="cancelled", updatedAt and reason, but does not set `job.nextAttemptAt = undefined`. In the same file, applyManaged at line 170 does clear it, as does the backup-restore path at src/maintenance.ts:166. The claim-time cancel in drainAll at src/notifications.ts:275 ("Destination or scope changed, or this pending delivery expired") has the same omission (found by reading the code, not reproduced). There the stale value is <= now, so it would show a past "Next:" time. 2) The UI in ui/notifications.tsx:41 renders "Next: …" whenever delivery.nextAttemptAt is truthy, whatever the state, so the stale field shows on Cancelled rows (and would on any non-pending row). 3) ui/notifications.tsx:42 hard-codes the plural: `{delivery.retryCount} manual retries`, so a count of 1 renders "1 manual retries".

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/notifications.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/notifications.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/notifications.test.ts`

**Suggested fix:** Server: in src/notifications.ts, add `job.nextAttemptAt = undefined;` to the cancel branch in update() (line 183), the claim-time cancel in drainAll (line 275) and the "Automatic retry limit reached" failure (line 272). A small helper such as `cancel(job, reason)` would keep every cancel path consistent with lines 170 and maintenance.ts:166. Rows already persisted with a stale value can be handled in load() (around line 132) by dropping nextAttemptAt unless state === "pending". UI (defensive, covers stored history): in ui/notifications.tsx:41, render "Next:" only when `delivery.state === "pending" && delivery.nextAttemptAt`. At line 42, pluralise: `{delivery.retryCount} manual ${delivery.retryCount === 1 ? "retry" : "retries"}`.

**Suggested regression test:** test/notifications.test.ts: extend "rate limits honor bounded retry-after, forbidden responses fail once, and disabling cancels pending delivery" (line 100). After `value.update("fixture", { enabled: false, ... })` add `assert.equal(value.deliveries()[0]!.nextAttemptAt, undefined)`. Add a case that narrows scope instead of disabling (`update("fixture", { enabled: true, events: ["failure"], projects: "all" })` on a pending "done" job) and assert state "cancelled" with nextAttemptAt undefined. Add …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4621n" on 127.0.0.1:4697. Ports 4621 and 4623 were held by other agents' processes (a v4619 receiver.mjs and the v4623 server), which I left alone. The real outbound transport was replaced with test/fake-notification-transport.mjs via NODE_OPTIONS, with CODEFLOW_NOTIFICATIONS_JSON=[{id:"fixture",protocol:"webhook",urlEnv:NOTIFICATION_FIXTURE_URL,secretEnv:NOTIFICATION_FIXTURE_CREDENTIAL}] and a mode file that sets the HTTP status the fixture returns. Steps used a Playwright script (scratchpad/qa/work/v4621/t16-14.mjs):
1) Mode 500. In Settings > Notifications (UI), enabled the destination with "Run finished", "Run or verification failed" and "All projects", then saved.
2) Created a fake solo run in a scratch git repo (API, as the precondition). Its "done" delivery became pending with attempts=1, httpStatus=500 and nextAttemptAt about 30s ahead.
3) In the UI, unticked "Run finished" and saved. The API showed the delivery as state=cancelled, reason "Notification settings no longer allow this delivery", with nextAttemptAt still set (same value as before). The rendered Status cell read "Cancelled · HTTP 500 / Notification settings no longer allow this delivery / Next: 10:28:27 PM". Screenshot shots/v4621n/001-cancelled-row.png. The persisted notifications.json also kept nextAttemptAt on the cancelled row.
4) Mode 403 (not retryable). Clicked "Send test notification", which failed at once. Clicked "Retry delivery" once, and it failed again. API: totalAttempts=2, retryCount=1. The Attempts cell read "2 / 1 manual retries". Screenshot shots/v4621n/002-retried-row.png.
No console errors and no 5xx responses. Nothing in docs/*.md or the code comments says a cancelled delivery should show a next attempt. The other cancel paths (src/notifications.ts:170 applyManaged and src/maintenance.ts:166 restore) explicitly clear nextAttemptAt, so the missing clear at line 183 is an oversight, not a design choice. The tester's environment was not a factor: I reproduced both symptoms on a fresh home in a fresh browser.

</details>

### S08-1 · minor · The PR-watch needs-attention notification key digests watch.detail, which embeds an incrementing failure count, so every failed retry after the 3rd sends a new outbound notification indefinitely while gh is signed out or offline.

Source: code-level suspect at `src/notifications.ts:58` (confirmed hands-on).

**Repro**

> End-to-end on fake-mode QA server s08 (port 4533). The server was started with NODE_OPTIONS=--import test/fake-notification-transport.mjs, CODEFLOW_NOTIFICATIONS_JSON for webhook 'qa-hook' pointing at https://notifications-fixture.invalid, and CODEFLOW_WATCH_INTERVAL_MS=1000. Steps: (1) Settings > Notifications: enable QA hook for 'A decision or answer is needed' on All projects. (2) Fix open issues sweep for #41 on a scratch repo. Run page > Approve & open PR (fake gh), then Details and publishing > Watch PR; the watch went green. (3) Set signedOut:true in the QA home's fake-gh.json. Over 5.5 minutes the watch stayed 'needs-you' with the same reason, but the fixture received a new identical needs-attention POST at failure counts 3, 4, 5, 6, 7, 8 and 9 (7 POSTs, all the same title/status/result). A unit check in the snapshot (test/qa-s08-watch.test.ts: PrWatcher + Notifications, fake gh signedOut, 60s interval, 6 simulated hours) gave 14 deliveries. After backoff caps at 30 min the rate is about 48 per day per watched PR, indefinitely.

**Expected:** One needs-attention notification when the watch first hands the PR back to the user, or when the reason materially changes. Unchanged retries should not notify.

**Actual:** A new notification for every failed retry from the 3rd on (attempts 3, 4, 5, ...; then every 30 minutes forever), each with identical payload text.

**Root cause (verifier):** notificationEvents() keys a needs-you watch as digest([watch.branch, watch.detail, watch.fixes]). PrWatcher.pollFailed (src/watch.ts:142-147) rewrites detail on every failed poll as `Couldn't check the PR N times in a row: ...`. RunManager.updateWatch emits a run snapshot whenever the watch JSON changes, and server.ts:2767 passes every snapshot to notifications.observe(). Each N therefore gives a new key that is not in the seen list, and a new delivery is queued.

**Suggested fix:** Give the needs-you watch candidate a stable identity. One option: store a reason code / needsYouSince on PrWatch when state changes to needs-you, and key on digest([branch, state, reasonCode, fixes]). Another: strip the volatile count from the key (for example key poll failures as 'poll-failing:<auth|other>'). Keep detail for display only.

**Suggested regression test:** Use the PrWatcher + Notifications harness from test/qa-s08-watch.test.ts. With fake gh signedOut, poll for 6 simulated hours and assert exactly 1 needs-attention delivery. Then change the reason (for example 'CI still fails after N fixes') and assert a second one is queued.
