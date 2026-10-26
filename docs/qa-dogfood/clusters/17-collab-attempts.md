# Cluster 17 · collab-attempts

**Team board attempts: connection-lost recovery, current attempt choice, hand-over recipient**

Status: **completed on continuation branch · browser and regression checks passed · integrated into `codex/dogfood-qa-continue`** · 9 issues · branch `codex/qa-chat-collab-continue`

Planner notes: t13-9/t14-3: the 'Connection lost' banner (attemptStale, ui/collab-state.ts:157) offers Recover after 90 s, but the server (src/collab/store.ts) only recovers an attempt in state 'unknown', after 24 h. Make the UI's promise match the server's rule, or allow recovery earlier. t14-12: the same staleness check produces a misleading 'heard just now' and offers Resume for a missing run. t14-2: currentAttempt in src/collab/model.ts prefers an older paused attempt over a newer finished one, because CURRENT_STATES includes 'paused'. t13-10: assignOwner (model.ts:285) leaves superseded attempts saying 'resume it from here'. t14-1: canExecute at ui/collab-task.tsx:70 hides 'Accept and download' from the hand-over recipient. t14-5: handOver creates the checkpoint before the hub validates the offer (src/collab/runner.ts:524). t13-11: finishAttempt notifies only the owner, and the actor is then removed from the targets. t14-4: every 409 becomes 'Task changed; reloading' and the server's message is dropped. Duplicate groups: [["t13-9","t14-3"]]

Likely files: `ui/collab-task.tsx`, `ui/collab-state.ts`, `src/collab/store.ts`, `src/collab/model.ts`, `src/collab/runner.ts`, `ui/collab-board.tsx`, `src/collab/link-api.ts`, `ui/lib.ts`

## Continuation verification — 2026-10-26

Reviewed and completed the interrupted implementation from `qa-fix/collab-attempts` (merged as `e53b1e1`). The review found two remaining gaps: a newer claim did not actually supersede older paused/stopped attempts, and a linked runner dropped the hub's machine-readable refusal code. Both are now fixed. A claim retires old work only after validation, inside the same atomic store change; legacy boards containing `[paused, finished]` cannot revive their older attempt. The common store claim path also covers host execution. The documented `[paused, superseded] → paused` and busy-wins selection behavior remains covered.

Validation uses **fake agent CLIs**, scratch Git repositories, separate server homes and loopback servers on 4355/4357 (remote listeners 4356/4358). No live server, real project, real provider or real teammate was used. The linked-recipient scenario runs a second actual CodeFlow instance, maps its own clone, accepts the handover through the UI, imports the bundle before ownership moves, and completes a continuation from that checkpoint. Browser monitoring rejects page errors, unexpected console errors and API 5xx responses; expected 400/404/409 refusal network messages are excluded. Server output is checked for uncaught exceptions and type/reference errors.

- `npx tsc --noEmit` — passed.
- `npx tsx --test test/qa-collab-attempts*.test.ts test/collab-model.test.ts test/collab-store.test.ts test/collab-runner.test.ts test/collab-api.test.ts test/collab-ui.test.ts` — 98 passed, including 14 focused QA regressions. Log: `/private/tmp/codeflow-qa-continue/work/chat-collab/collab-tests.log`.
- `QA_COLLAB_PORT=4355 QA_ARTIFACT_DIR=/private/tmp/codeflow-qa-continue/shots/collab-attempts-final npx tsx --test test/e2e/qa-collab-attempts.e2e.ts` — 7 passed in 105.9 seconds, including the real 90-second silence/recovery. Log: `/private/tmp/codeflow-qa-continue/work/chat-collab/collab-browser-final.log`; screenshots: `/private/tmp/codeflow-qa-continue/shots/collab-attempts-final/`.

Two existing regression expectations deliberately changed to match t14-2: `test/collab-store.test.ts`'s progress-revival case now refuses reports from an attempt superseded by a newer claim, and tests offered-handover/resume behavior on the current paused attempt. `test/collab-runner.test.ts`'s hub-first-resume case now refuses the older attempt even after the newer one fails, and uses a separate current paused task to retain coverage of refused hub reservations and same-ID resume. No existing safety assertion was weakened. New cases live in the QA files, including refused-claim preservation and legacy-board fencing.

The expanded browser tests initially exposed two harness issues: the Send to agent control has role `switch`, and its linked browser context must close before its isolated server to avoid teardown-only connection errors. Both were corrected. Failed/declined handover note isolation and legacy manifest handling are verified with real scratch Git bundles and stub run managers; the browser verifies the accepted note and continuation on a separate linked instance. The host queue variant is covered by the common store guard and selection tests, rather than a separate host-queue UI run. No cluster issue is deferred; integrated-build validation remains the integrator's next step.

## Issues

### t13-9 · minor · 'Connection lost' tells users to recover the attempt, but recovery is impossible for 24 h and the task stays locked

**Fix outcome:** Fixed. Both UI and hub accept recovery after 90 seconds without a heartbeat, with the existing owner/maintainer permission, stop confirmation and audit requirements. Store tests check the boundary, role refusal and old-runner fencing; the browser checks a real elapsed-time recovery.

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-12, COL-18.

**Repro**

> 1. A teammate starts an attempt on their runner.
> 2. Stop the runner's Code Flow (machine gone) and wait more than 90 s.
> 3. Open the task as the hub owner (maintainer).

**Expected:** Either a Recover action for an owner or maintainer who confirms the agent stopped, or text explaining that recovery becomes available after 24 h.

**Actual:** The task shows 'Connection lost; execution status unknown… Recover it only after confirming the original agent has stopped.' but there is no Recover button. POST /api/team/attempts/<aid>/recover returns 409 'Only an unknown attempt can be recovered…', and owner change, delete and Done are refused (409) until the 24 h unknown sweep.

**Root cause (verifier):** The server's rule is deliberate, but the UI message and the docs both promise a recovery the server refuses. The pieces:

- ui/collab-state.ts:157: `attemptStale` is true for state "unknown" and also for "claimed"/"running" with no heartbeat for 90 s (`heartbeatLiveMs`, src/collab/model.ts:45).
- ui/collab-task.tsx:175: `AttemptDetails` shows the same "…Recover it only after confirming the original agent has stopped." text for every stale attempt.
- ui/collab-task.tsx:99 (and the dialog guard at :120): the "Recover attempt…" button is rendered only when `attempt.state === "unknown"`.
- src/collab/store.ts:567: this matches the server, where `recoverAttempt` refuses with 409 "Only an unknown attempt can be recovered…" unless the state is unknown.
- An attempt only becomes "unknown" in three ways:
  - the hourly prune after `STALE_ATTEMPT_MS` = 24 h (store.ts:46 and :723);
  - `revokeRunner` (store.ts:715), which only the runner's own user or the hub owner may call (store.ts:711; a maintainer gets 404);
  - the runner itself reporting a missing run when it reconnects.
- Between 90 s and 24 h the message tells the user to recover, but there is no button and the API returns 409.
- Owne …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-task.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-ui.test.ts`

**Suggested fix:** Recommended fix, which keeps the server's safety rule:

1. Add a pure helper in ui/collab-state.ts, for example `staleHint(attempt, viewer, now)`, and have ui/collab-task.tsx:175 render two different messages:
   - State "unknown": keep the current text. The Recover button already shows.
   - Silent "claimed"/"running" (heartbeat older than 90 s but not yet unknown): say the task stays reserved until <runner> reconnects. If it does not, the attempt can be recovered once it is marked unknown, which happens 24 h after it was last heard (show the time), or as soon as the runner is revoked.
     - For the hub owner, add a "Revoke runner…" button or a link to Settings → Connections → Share access → Connected computers.
     - For the runner's own user, point to their own runner list.
     - For other maintainers, tell them to ask the hub owner or <user>.
2. Change the `transitionProblem` / `ownerProblem` hints and the matching server error text for this case (store busy checks) so they no l …

**Suggested regression test:** In test/collab-ui.test.ts, test the new helper on its own:
- A "running" attempt with `lastHeartbeatAt` = now − 120 s: the hint does not offer recovery, mentions the 24 h point and the runner-revoke route, and `attemptStale` is still true.
- The same attempt with state "unknown": the hint offers recovery.

In test/e2e/team.e2e.ts, next to "an unknown execution blocks Start…" (line 410): claim an attempt with a runner credential and report "running", then make it silent. Either inject the store c …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode hub as "v4621r" on port 4623 with home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4621r. My assigned port 4621 was busy with another agent's server (home v4619), so I left it alone and used my extra port. The hub ran no agents and touched no repo.

Setup, in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4621r/setup.mjs:
- Created two accounts on project MQTT-MCP (p-ef01794b): bob as contributor and mia as maintainer.
- Defined repository key "mqtt".
- Enrolled bob's runner "Bob laptop" with POST /api/team/runners/connect over loopback.
- The hub owner created a task with bob as owner.
- The runner claimed an attempt, sent one progress report (state running) and one heartbeat, then went silent, the same as the machine disappearing. A runner's close() only detaches and reports nothing (src/collab/runner.ts:602), so this matches the reporter's stopped Code Flow.

After 101 s of silence (observe.mjs, hub-owner profile):
- The hub attempt is still "running".
- The task page Execution section shows the "Connection lost" pill and the text "Connection lost; execution status unknown. This task stays reserved until the runner reconnects and reports its state. Recover it only after confirming the original agent has stopped."
- The Execution section has zero buttons and no "Recover attempt…" (count 0).
- The header still shows "Done is unavailable: Stop the attempt running on Bob laptop…" and the Owner field says "Stop the attempt running on Bob laptop before changing the owner". Nobody on the hub can stop it.
- API calls as the hub owner:
  - recover returns 409 "Only an unknown attempt can be recovered; reconcile or stop its runner first".
  - owner set to null returns 409 "Stop the attempt running on Bob laptop before changing the owner".
  - status done returns 409.
  - DELETE task returns 409 "…before deleting the task".
- Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4621r/001-owner-task-connection-lost.png

Mia, a project maintainer who is not the hub owner, signed in through the UI in a fresh browser (mia.mjs):
- Same message, no Recover button.
- recover returns 409.
- DELETE /api/team/runners/<bob's runner> returns 404 "Runner not found", and GET /api/team/runners returns [].
- So a main …

</details>

### t14-3 · major · 'Connection lost' attempt cannot be recovered for 24 hours, although the banner tells users to recover it

**Fix outcome:** Fixed with t13-9. Recovery checks liveness inside the atomic mutation, so a runner that reconnects before commit keeps its reservation. Browser clock-skew reproduces a stale recovery request and verifies the server refusal remains visible.

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-25.

**Repro**

> 1. Teammate t14b starts a long attempt (codex with FAKE_SLEEP_MS=60000).
> 2. Stop the teammate's server (qa-server.sh stop t14b) to simulate a dead laptop.
> 3. Wait 95 s. Open the task on the hub as owner/maintainer.
> 4. Try Recover / reassign / hand over.

**Expected:** Per docs ('If it cannot, the task owner or a project maintainer uses Recover attempt…') and the banner ('Recover it only after confirming the original agent has stopped'), the owner or a maintainer can recover once they confirm execution stopped.

**Actual:** There is no 'Recover attempt…' button. POST /api/team/attempts/:id/recover returns 409 'Only an unknown attempt can be recovered'. Owner change returns 409 and hand-over returns 409. The attempt becomes 'unknown' only after 24 h without a heartbeat, and only on the hourly prune pass, which never runs at startup. The only escape is the hub owner revoking the whole runner, and nothing points to that.

**Root cause (verifier):** The Recover path only works on an attempt in state "unknown", but the "Connection lost" banner and the docs offer it as soon as the 90 s heartbeat window expires.
- ui/collab-state.ts:157: `attemptStale` is true for a claimed or running attempt that is not live, so the banner at ui/collab-task.tsx:175 shows after 90 s.
- ui/collab-task.tsx:99: the Recover button is gated on `attempt?.state === "unknown"`, not on `stale`.
- src/collab/store.ts:567: `recoverAttempt` throws 409 "Only an unknown attempt can be recovered" for any attempt that is not unknown.

An attempt only becomes unknown in four ways:
- src/collab/store.ts:713: `revokeRunner`. Only the runner's own user or the hub owner may call it (`seesAllRunners`). Project maintainers cannot.
- src/collab/store.ts:723: `prune` after STALE_ATTEMPT_MS = 24 h (store.ts:46).
- The runner itself reports unknown on reconnect, which needs the dead machine back.
- src/server.ts:2781: the hourly `setInterval(collab.prune)`. There is no startup pass, so the real wait is 24 to 25 h.

Meanwhile `assertNotBusy` (src/collab/model.ts:245) blocks owner change, hand-over, Done and new claims while the attempt is claimed, running or unknown. So for …

**Files:** `src/collab/store.ts`, `ui/collab-task.tsx`, `src/server.ts`, `docs/team-collaboration.md`, `docs/api.md`, `test/collab-store.test.ts`, `test/collab-api.test.ts`, `test/e2e/team.e2e.ts`

**Suggested fix:** Recommended: make the code match the docs and the banner.
1. In `recoverAttempt` (store.ts:567), also accept a claimed or running attempt that is not live, using `!attemptIsLive(found.attempt, now)` from model.ts with MAX.heartbeatLiveMs. Check it inside the `change()` mutation at commit time. A runner that heartbeats again just before the recovery then still gets 409 "The runner reconnected; stop it there first". That keeps the documented "stale recovery is refused if the runner has already reconnected".
2. Keep the existing safeguards: the confirmedStopped flag, the required reason, the revision check, and the owner-or-maintainer authority check. Superseding already fences the old runner: heartbeat, progress and checkpoint get 409, and runner.ts:356 stops the local agent.
3. In ui/collab-task.tsx:99, gate the button on `stale` (attemptStale) instead of `state === "unknown"`, and keep the role check `(isOwner && canEdit) || maintainer`.
4. Optionally run `collab.prune()` once at start …

**Suggested regression test:** test/collab-store.test.ts, new test "a silent (connection-lost) attempt can be recovered by owner/maintainer before 24 h":
- Claim an attempt and report progress so it is running.
- Advance the clock by 60 s: `recoverAttempt` must refuse with 409 because the runner is still live.
- Advance past MAX.heartbeatLiveMs (90 s):
  - recovery by maya (maintainer) with confirmedStopped succeeds;
  - the attempt is "superseded" and the last audit action is "attempt-recovered";
  - later heartbeat, progres …

<details><summary>Verifier's independent reproduction</summary>

I started two fresh fake-mode servers. My assigned ports 4635 and 4637 were already held by other verifiers' servers (homes v4633p and v4637t14), so I used the unused ports 4571 and 4573. The hub was v4635k on 4571. Alice's laptop was v4635m on 4573, started with FAKE_SLEEP_MS=60000 and FAKE_SLEEP_VENDOR=codex. Both used scratch clones of MQTT-MCP.
1. Hub setup through the API: created the project p-bc4c5aa9 with repository key mqtt-mcp, the accounts alice (contributor) and mia (maintainer), and the task t-dfb24df08859b8b0 owned by alice.
2. On the laptop UI: Settings → Connections → Join, connected as alice with machine name alice-laptop, and mapped the clone. Then Task → Build with agents → Codex, check 'true'. The hub showed attempt ecfb8530… as running and heard from it.
3. Stopped the laptop server with `qa-server.sh stop v4635m` and waited until the hub had heard nothing for 102 s. The attempt was still in state "running".
4. As hub owner in a fresh browser, the task page shows the 'Connection lost' pill and the banner "…Recover it only after confirming the original agent has stopped." The Execution section has no buttons at all: 0 'Recover attempt…' and 0 'Build with agents'. The Owner select is disabled with the title "Stop the attempt running on alice-laptop before changing the owner". The board card says "Connection lost · alice-laptop".
5. API calls as hub owner, all returning 409:
   - POST /api/team/attempts/:id/recover with confirmedStopped=true: "Only an unknown attempt can be recovered; reconcile or stop its runner first"
   - owner → mia, and unassign: "Stop the attempt running on alice-laptop before changing the owner"
   - handoff: "…before handing the task over"
   - status done: "…before marking the task done"
6. As maintainer mia, in a fresh browser with shared sign-in on the hub: the same banner and 0 Recover buttons. Her own recover call also returns 409. GET /api/team/runners returns [] for her, so she has no way to revoke alice's runner.
7. The workaround, tried as hub owner: Settings → Connections → Connected computers → Revoke alice-laptop. The attempt became unknown ("Runner alice-laptop was revoked while this attempt was active"), 'Recover attempt…' appeared, and recovery through the dialog moved the attempt to superseded and wrote the attempt-recovered audit entry. The task page never mentions revoking or Connected computers.
Logs: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be …

</details>

### t13-10 · minor · A superseded attempt still shows 'Stopped on this computer; resume it from here to continue'

**Fix outcome:** Fixed. Reassignment and new claims replace old resume hints with an explicit supersession reason. Browser verification stops a bounded attempt, reassigns it to Bob and checks the visible reason contains no resume promise.

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-18.

**Repro**

> 1. Bob starts an attempt on his runner and clicks Stop (paused).
> 2. Maintainer Mia sets herself as owner.
> 3. Open the task on Bob's runner.

**Expected:** The reason explains the attempt was superseded by a change of owner and continues from the latest checkpoint.

**Actual:** The state is 'Superseded' (no Resume button; the API refuses 409), but Reason still reads 'Stopped on this computer; resume it from here to continue'.

**Root cause (verifier):** The bug is in src/collab/model.ts:285 (`assignOwner`), not in src/collab/store.ts as the report suspected. When the owner changes, it loops over the attempts and turns every paused, stopped or unknown one into "superseded" (`attempt.state = "superseded"; attempt.endedAt = now;`). It never touches `attempt.reason`, so the reason saved at pause time survives.
- That reason was written at pause time by `mapRunStatus` in src/collab/runner.ts:113, for a cancelled run: "Stopped on this computer; resume it from here to continue".
- ui/collab-task.tsx:184 (`AttemptDetails`) prints `attempt.reason` as it is, whatever the state, so the page tells the user to resume an attempt it no longer lets them resume.
- `assignOwner` is called from store.ts:353 (create), store.ts:374 (`updateTask` owner change, the reported path) and store.ts:676 (`respondHandoff` accept), so an accepted hand-over leaves the same stale reason.
- By contrast, the other supersede path, `recoverAttempt` at store.ts:571, does set `attempt.reason`.

**Files:** `src/collab/model.ts`, `src/collab/store.ts`, `ui/collab-task.tsx`, `test/collab-model.test.ts`, `test/collab-store.test.ts`

**Suggested fix:** 1. Server fix in `assignOwner` (src/collab/model.ts:285): when an attempt is superseded, also replace its reason with one that explains the supersede. For example: `Superseded when the task passed to ${nextOwner?.displayName ?? "no owner"}; continue from the latest checkpoint` (no owner when unassigned), truncated to MAX.reason. An optional parameter could let `respondHandoff` say "by an accepted hand-over to X".
   - The earlier pause reason is already kept in the audit ("attempt-paused"), so nothing is lost.
2. UI fallback for boards saved before the fix (ui/collab-task.tsx:184): when `attempt.state === "superseded"`, show a state-specific line instead of the stale reason, for example "Superseded by a change of owner; start a new attempt from the latest checkpoint", reusing the wording of the 409 in runner.ts:489. Alternatively, show the stored reason under a "Last reported" label.
3. Optionally, skip the "unknown" case in that loop: `assertNotBusy` already refuses an owner change wh …

**Suggested regression test:** - **test/collab-model.test.ts**, next to the existing `assignOwner` assertions at about line 178: give the paused attempt the reason "Stopped on this computer; resume it from here to continue", call `assignOwner(task, who("bob"), 50)`, then assert:
  - `attempts[1].state === "superseded"`
  - `attempts[1].reason` does not match `/resume it from here/`
  - `attempts[1].reason` matches `/superseded|change of owner|checkpoint/i`
- **test/collab-store.test.ts**: add the same reason assertion after t …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server named v4623f on port 4625 with FAKE_SLEEP_MS=45000. Port 4623 was already taken by another verifier's server (home v4621r), so I used my extra port and did not touch that server. I also made a scratch clone of MQTT-MCP at clones/v4623f-mqtt. Everything below went through the UI unless it says API:
1. Used "Open another repository", picked the clone and created the project "V4623 Team MQTT" (p-f36e8ab0).
2. In #/settings/team I added the repository key "mqtt" and mapped it with "Use current repository".
3. API, as a precondition: created a test maintainer account "mia" with a random password.
4. On the Board I created the task t-d62c1533994c68c1, owned by the server owner (the local runner plays Bob).
5. Clicked "Build with agents" (Agent workflow, Codex), waited 5 seconds, then clicked Stop and "Stop attempt". The attempt became paused with the reason "Stopped on this computer; resume it from here to continue", and the page showed Resume.
6. Signed Mia in from a fresh browser on 127.0.0.1:4625. On the task page she chose "Mia Maintainer (you)" in the Owner select.
7. Reloaded the task page as the owner. The Execution section shows "Superseded … Reason | Stopped on this computer; resume it from here to continue", with no Resume button. POST /api/team-link/tasks/:id/resume returns 409 "This attempt was superseded by a change of owner; start a new attempt from the latest checkpoint instead".
The hub's stored attempt confirms it: {state:"superseded", reason:"Stopped on this computer; resume it from here to continue"}. Mia's own view shows the same stale text, which is even more misleading for her because she is not on "this computer".
Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4623f/001-owner-superseded.png. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4623f/.
This is not by design. docs/team-collaboration.md (lines 128 and 150) says superseded attempts cannot be resumed and the work continues from a checkpoint. The recovery path that also supersedes an attempt overwrites the reason, so the two supersede paths are inconsistent.
Cleanup: I deleted the run through the UI (the run page's More menu, then Delete), stopped server v4623f and removed both scratch clones. No other leftovers.

</details>

### t14-2 · major · Task page and board card show an older paused attempt instead of the newer finished attempt (with Resume offered)

**Fix outcome:** Fixed in presentation and enforcement. The task and board select the latest meaningful outcome. An accepted new claim supersedes earlier paused/stopped work; legacy revive requests are refused. Browser reproduction stops A, runs B to completion, reloads the task and board, and confirms Finished with no stale Resume.

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-38, COL-24, COL-23.

**Repro**

> 1. Linked teammate (t14b, fake, FAKE_SLEEP_MS=60000 FAKE_SLEEP_VENDOR=codex) owns a task. Build with agents (Codex), then Stop → attempt A paused.
> 2. Build with agents again (Claude Code, fast) → attempt B finishes with checkpoint a8fa01ed.
> 3. Reload the task page and the board.
> (Same with the host queue: a host job cancelled by a grant change leaves a paused attempt; the next host job finishes, and the shared task page still shows 'Paused on Host computer … Stopped on this computer; resume it from here'.)

**Expected:** Execution and the board card show the latest attempt (B finished, with its checkpoint).

**Actual:** The page shows A: 'Paused … Reason: Stopped on this computer; resume it from here' with a Resume button. The board card reports attempt 44f1d9c2 paused while the latest checkpoint is from B. Shared users see a host attempt 'paused' that they cannot resume. The status is misleading, and Resume would revive the stale line of work.

**Root cause (verifier):** src/collab/model.ts:235-240: CURRENT_STATES includes "paused", and currentAttempt() = busyAttempt(task) ?? latestAttempt(task, CURRENT_STATES). latestAttempt scans backwards for the newest attempt whose state is in the list, so it skips a newer finished/failed/stopped attempt and returns an older paused one. summarize() (model.ts:294) uses it for the board card's attempt. The UI copies the same logic: ui/collab-state.ts:145/148 (CURRENT includes paused, so currentAttempt does the same scan). Then ui/collab-state.ts:150 shownAttempt = currentAttempt(task) ?? last attempt, so the stale paused attempt wins. ui/collab-task.tsx:66/73 then renders it, and attemptResumable() (collab-state.ts:152) offers Resume because a local record exists. Nothing on the server prevents this. store.claimAttempt (src/collab/store.ts:491-512) lets a new attempt start next to a paused one and does not supersede it; only assignOwner (model.ts:280) supersedes paused/stopped attempts, and only on a change of hands. The revive path also accepts the old attempt: store.attemptProgress (store.ts:520-533) and runner.resumeAttempt (src/collab/runner.ts:483-505) check owner, Done, busy and hand-over, but not "a newer …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/model.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/runner.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/link-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-model.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-ui.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-store.test.ts`

**Suggested fix:** 1. Display fix, in both src/collab/model.ts currentAttempt and ui/collab-state.ts currentAttempt. Keep busyAttempt first. Otherwise take the latest attempt that is not superseded, and return it only if its state is paused or unknown (else undefined). An older paused attempt behind a newer finished/failed/stopped one then stops being current. shownAttempt falls back to the newest attempt (B finished), and the board card no longer reports A.
2. Server-side so Resume cannot revive a stale line. In store.claimAttempt, after the busy/hand-over/Done checks, mark the task's earlier paused/stopped attempts as superseded, the same way assignOwner does (set endedAt and a reason such as "A newer attempt started"). Do this also for the host-execution claim path. assertNotEnded then refuses their revive reports, and runner.resumeAttempt already refuses superseded attempts. Fallback if superseding is unwanted: refuse a revive in attemptProgress/resumeAttempt when a newer non-superseded attempt exist …

**Suggested regression test:** test/collab-model.test.ts: currentAttempt(task({ attempts: [attempt("paused", {id:"1"x32}), attempt("finished", {id:"2"x32})] })) is undefined, and summarize(sameTask).attempt is undefined, so the card does not report the older paused attempt. Keep the existing [paused, superseded] → paused and busy-wins cases.
test/collab-ui.test.ts: shownAttempt({ attempts: [attempt("a1","paused"), attempt("a2","finished")] })?.id === "a2" and attemptResumable(that attempt) === false.
test/collab-store.test.ts …

<details><summary>Verifier's independent reproduction</summary>

Port 4633 was already taken by another verifier's server (home v4631bx), so I used my extra port 4635. I started a fresh fake-mode server: FAKE_SLEEP_MS=60000 FAKE_SLEEP_VENDOR=codex qa-server.sh start v4633p 4635 fake. I made a scratch clone of MQTT-MCP (clones/v4633p-mqtt). Through the API I created a hub project, set the repository key "mqtt-mcp" and created a task owned by the hub owner. I ran everything below in the UI (headless Chrome, ?team=local#/team/task/<id>):
1. Build with agents, Codex (slow), check "true". Attempt dbc6f1d2 ran. I pressed Stop and confirmed. The hub then had [dbc6f1d2 paused, reason "Stopped on this computer; resume it from here to continue"].
2. Build with agents, Claude Code (fast). Attempt 4c1bd8f3 finished and published checkpoint 425b95e0 (commit 35d69bec). The hub then had [dbc6f1d2 paused, 4c1bd8f3 finished]; task status Working.
3. I reloaded the task page. Execution shows "Paused … Run cancelled … Branch codeflow/…645ce202/solo at 2b97323ce7 … Reason: Stopped on this computer; resume it from here to continue", and a Resume button is visible (screenshot shots/v4633p/003-task-after-B-finished.png).
4. Board: GET /api/team/board returns card.attempt = {id: dbc6f1d2, state: paused} while card.checkpoint = 425b95e0/35d69bec, which came from attempt B. The board card reads "Paused on Midhuns-MacBook-Air.local" (004-board-after-B.png).
5. Consequence: I clicked the Resume that was offered. The server accepted it and revived stale attempt A on its old branch, still at base 2b97323 and not on B's checkpoint. The hub showed [dbc6f1d2 running, 4c1bd8f3 finished]. I then stopped it.
No console or 5xx errors appeared. Logs are in work/v4633p/repro.log and resume.log. This is not an environment or script artifact: the state comes from the hub's own attempt list, and the reporter's two-machine setup is not needed. I did not reproduce the host-queue variant separately. It goes through the same currentAttempt() code, so the same cause applies.

</details>

### t14-12 · minor · Unknown/lost attempts: misleading 'Connection lost … heard just now', Resume offered for a missing run, recovery refusal not shown

**Fix outcome:** Fixed. Unknown attempts say Status unknown with their reason, while silent runners say Connection lost. Missing local runs have no Resume/Open action. The recovery dialog retains a server refusal across reloads. All three paths are exercised in Chrome.

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-25.

**Repro**

> 1. Teammate attempt running; stop the teammate server, lose the run record, restart. Reconcile marks the attempt unknown ('Run … is missing from this computer').
> 2. The teammate opens the task: the pill says 'Connection lost' while 'Last heard just now'. Click Resume.
> 3. Hub owner opens 'Recover attempt…', fills the reason and checkbox. Meanwhile the runner reports the attempt alive again. Click 'Release task'.

**Expected:** The status reads 'Unknown' with the reason. Resume is not offered when the local run is gone, or its error shows in place. A refused recovery explains that the runner reconnected.

**Actual:** Step 2: 'Connection lost' banner with 'heard just now'. Stop and Resume are both offered. Resume answers 404 and the whole task view is replaced by 'Run … is missing from this computer  Retry  Back to the board'. Step 3: the 409 'Only an unknown attempt can be recovered' is not shown; the dialog simply disappears.

**Root cause (verifier):** There are four causes, all in the UI.

1. ui/collab-task.tsx:174-175: AttemptDetails uses `stale` for both the pill and the warning banner. `stale` comes from attemptStale (ui/collab-state.ts:157), which is true for every state==="unknown", and ATTEMPT_LABEL.unknown is "Connection lost" (ui/collab-state.ts:130). The banner always says "until the runner reconnects and reports its state". In this case the runner did report: finish(unknown) sets lastHeartbeatAt=now (src/collab/store.ts:553), hence "Last heard just now" next to "Connection lost". The board card repeats this (ui/collab-board.tsx:109).

2. ui/collab-task.tsx:73 sets `resumable = !!attempt && !!local && attemptResumable(...)` and never checks that the local run exists. GET /api/team-link/attempts already omits runStatus when the run is missing (src/collab/link-api.ts:113), but the UI LocalAttempt type has no runStatus field (ui/collab-state.ts:22). Stop is likewise offered at collab-task.tsx:95 because `running` is busyAttempt, which counts unknown attempts (collab-state.ts:147). The runner then throws 404 for the missing run (src/collab/runner.ts:485).

3. ui/collab-task.tsx:57: act() treats any 401/403/404 as "the task  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-task.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-board.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`

**Suggested fix:** 1. Separate "unknown" from "heartbeat expired".
   - Add a helper in collab-state.ts, e.g. attemptHealth(attempt, now) → "live" | "silent" | "unknown".
   - Show "Connection lost" plus the existing banner only for claimed/running attempts whose heartbeat expired.
   - For state unknown, show a "Status unknown" pill and a banner built from attempt.reason, e.g. "The runner reported: Run … is missing from this computer. Recover after confirming the agent stopped." Don't say "until the runner reconnects".
   - Use the same helper in collab-board.tsx.

2. Add `runStatus?: string` to LocalAttempt.
   - Resume only when local.runId && local.runStatus && local.runStatus !== "running".
   - Stop only when local.runStatus === "running" (or the attempt is claimed/running).
   - Open run only when the run exists.

3. In act(), don't treat a 404/403 from /api/team-link/* actions as "task gone". Show err.message inline and call load(); load() already shows the page-level error if the task itself is  …

**Suggested regression test:** 1. test/collab-ui.test.ts:
   - Assert the new helper returns "unknown" with label "Status unknown" for state unknown with a fresh lastHeartbeatAt, and "silent"/"Connection lost" for state running with lastHeartbeatAt older than 90 s.
   - Assert the resumable predicate is false when the local record has a runId but no runStatus, and true when runStatus is "interrupted" or "cancelled".

2. test/e2e/team.e2e.ts, next to "an unknown execution blocks Start…" (line ~409):
   - (a) Seed an unknown at …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server v4653r on port 4653 (home .../scratchpad/qa/homes/v4653r) with FAKE_SLEEP_MS=900000. I tested on one server, with the hub owner as the in-process runner "local". The two-server teammate setup wasn't possible: my extra port 4655, and for a while 4653 too, was held by other verifiers' servers, which I didn't touch. The teammate case uses the same code: TeamTaskView with shared=false, CollabRunner, and the link-api resume route. Scripts and logs are in .../scratchpad/qa/work/v4653r, screenshots in .../scratchpad/qa/shots/v4653r.

Setup (API, preconditions only): created a project on a scratch bare+working clone of MQTT-MCP, added repository key mqtt-mcp, and created a task owned by "owner".

Step 1 (UI): Build with agents with Claude Code and check "true" gave attempt 933ef6b0… running run 2610252143-b1fe4939. I stopped the server, moved runs/2610252143-b1fe4939.* aside and restarted. Reconcile set the hub attempt to state=unknown, reason "Run 2610252143-b1fe4939 is missing from this computer". GET /api/team-link/attempts returned the local record without runStatus, so the run is gone.

Step 2 (s02/s03): the Execution card reads pill "Connection lost", "Last heard just now", and the banner "Connection lost; execution status unknown. This task stays reserved until the runner reconnects and reports its state…", with the Reason row underneath. Buttons offered: Open run, Stop, Resume, Recover attempt….
- Stop → POST /stop returns 409 "No attempt of this task is running on this computer". The UI shows only the toast "Task changed; reloading".
- Resume → POST /resume returns 404 "Run 2610252143-b1fe4939 is missing from this computer". The whole task view (h1, cards) is replaced by "Run … is missing from this computer [Retry] [Back to the board]" (shot 002-resume-404-replaced.png). About 8 s later the 15 s poll reloads the task, the error is gone, and Resume is offered again.

Step 3 (s04): I restored the run files and restarted; the attempt was still unknown and the run interrupted. In tab A I opened Recover attempt…, filled the reason and ticked the box. In tab B I clicked Resume, which returned 200 and revived the attempt. Then I clicked Release task in tab A: POST /recover returned 409 "Only an unknown attempt can be recovered; reconcile or stop its runner first". Within 300 ms the dialog was gone, with no alert in the dialog or on the page. The card now shows "Running · Live" (shot 002-A-after-release.png).

Refutation checks: …

</details>

### t14-5 · minor · Retried hand-over reuses a checkpoint whose note came from a failed offer; the stale note reaches the next agent

**Fix outcome:** Fixed. Recipient validation precedes committing/checkpointing, manifests receive no handover note, and only the accepted offer supplies continuation context. Scratch-repository runner regressions cover invalid recipients, declined/retried offers and legacy frozen notes. The linked browser checks the accepted note and continuation.

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-27, COL-28.

**Repro**

> 1. Alice's attempt finished; her worktree has an uncommitted tracked change.
> 2. Offer the hand-over to someone who cannot accept it, with a note (e.g. API to viewer carol: {to: carol, note: 'to viewer', includeUncommitted: true}) → 400, but checkpoint 830be155 is created and uploaded.
> 3. Offer to Bob with note 'third offer: please continue' → reuses 830be155. Bob accepts and continues.
> 4. Read Bob's run prompt (homes/t14c/runs/<run>.jsonl).

**Expected:** The checkpoint context carries only the note of the hand-over that was accepted, or the note is not frozen into a reused checkpoint.

**Actual:** GET /api/team/checkpoints/830be155 shows note 'to viewer'. Bob's prompt section 'Hand-over note' contains 'to viewer' followed by 'Hand-over note from Alice T14: third offer: please continue'. Text meant for a different recipient, from a failed or declined offer, is passed to the next agent.

**Root cause (verifier):** - src/collab/runner.ts:524: handOver() calls ensureCheckpoint(..., input.note ?? "", ...) and so mints the checkpoint before the hub has validated or recorded the offer. The offer itself only goes out at runner.ts:535 (hub.offerHandoff), and the hub refuses a recipient below contributor in store.ts:658 via resolveWho at :262.
- src/collab/runner.ts:271: publishCheckpoint writes `note: share(note, MAX.note)` into the checkpoint manifest. The manifest cannot be changed afterwards, since there is no update path for checkpoints.
- src/collab/runner.ts:298-301: ensureCheckpoint returns the existing checkpoint whenever its commit equals head and its bundle is available. Every later offer (after a 400, a decline or a cancel) therefore reuses the manifest note from the first offer.
- src/collab/runner.ts:333-334: startAttempt builds the agent context as checkpoint.note plus "Hand-over note from <sender>: <accepted note>". It skips the checkpoint note only when the two strings are equal, so a stale note always comes first, without attribution.
- ui/collab-task.tsx:226 shows checkpoint.note on the board's checkpoint card, so every project member sees the stale note too.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/runner.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-runner.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-task.tsx`

**Suggested fix:** Stop freezing hand-over notes into checkpoint manifests. The note already travels, attributed and per offer, on the Handoff record.

1. In runner.ts handOver (line 524), call ensureCheckpoint with note "" instead of input.note. After this, publishCheckpoint is only ever called with "", so the note parameter can be dropped or kept for other callers.
2. In startAttempt (runner.ts:333-334), build the context note only from the accepted hand-over for this checkpoint ("Hand-over note from X: ..."). For boards that already store frozen notes:
   - ignore checkpoint.note when it equals the note of a declined or cancelled handoff for that checkpoint, or
   - more simply, prefer the accepted hand-over's note over checkpoint.note whenever an accepted hand-over exists.
3. Optionally, before committing or minting anything, check up front in handOver that `to` is a contributor or higher of the project (from the board's members). This removes the 400 case without the side effects of creating a check …

**Suggested regression test:** Add a test to test/collab-runner.test.ts, modelled on "handOver offers a checkpoint ... acceptHandoff imports it" (line 285). Add a viewer member (member("u-carol", "carol", "viewer")) to the fixture.

Steps:
1. Run an attempt and stop it with the agent's file uncommitted.
2. `await assert.rejects(runner.handOver(task.id, { to: "u-carol", note: "for carol", includeUncommitted: true }), refuses(400, /contributor role/))`.
3. `const first = await runner.handOver(task.id, { to: "u-bob", note: "for  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4639x" on 127.0.0.1:4639 with a fresh home. The home name "v4639" already held an earlier verifier's data, so I used a new name. My extra port 4641 was taken by another verifier's server (v4641m). So Bob's computer was a second team connection on the same server: I connected it to its own hub at http://127.0.0.1:4639 as user bob ("bob-desktop"). That uses the same CollabRunner/LinkedHub code path as a separate machine.

Setup: scratch bare clone of MQTT-MCP with .codeflow/config.json {prove:false, check:"true"} on main, plus two working clones. v4639-alice was the hub owner's repo; v4639-bob was mapped for Bob's connection. Project "V4639 Team MQTT" with repository key "mqtt". Accounts: bob (contributor) and carol (viewer). The owner's display name was set to "Alice V".

Task A (the reported path):
1. The owner (Alice V) started a solo fake-claude attempt. It finished with a finish checkpoint 15f5e64c (note ""). I appended a line to the tracked README.md in the run worktree.
2. POST /api/team-link/tasks/:id/handover?teamConnection=local {to: carol, note:"to viewer", includeUncommitted:true} returned 400 "The teammate needs at least the contributor role in this project". Checkpoint 2ad0c72a (commit d81f04f9) was still created, bundle available, note "to viewer".
3. Through the UI Hand over… dialog (it lists only "Bob V · online") I offered to Bob with note "third offer: please continue". The offer reused 2ad0c72a. GET /api/team/checkpoints/2ad0c72a still returned note "to viewer".
4. Bob accepted through the API (200, owner = Bob V). He then used the UI Build with agents dialog with "Continue from the latest checkpoint" checked; run 2610252141-1baf2c1d finished done.
5. That run's prompt "### Hand-over note" block was: "to viewer\n\nHand-over note from Alice V: third offer: please continue".
6. The task page's Checkpoints card also shows "to viewer" as the note of checkpoint d81f04f9f1 (screenshot shots/v4639x/001-A-board-checkpoint-note.png).

Task B (a path reachable entirely from the UI, which widens the scope):
1. After Alice's finished attempt and a dirty README, I offered to Bob through the UI with "Note for the first offer (Bob declines this one)" and Include uncommitted. This created checkpoint ed5b78db with that note.
2. Bob clicked "Decline hand-over" in the UI.
3. A second UI offer to Bob, "Note for the second offer (accepted)", reused ed5b78db.
4. Bob accepted and continued (run 2610252142-7dc775bb). The prompt's Hand …

</details>

### t14-1 · major · Hand-over recipient never sees 'Accept and download' on their own computer (only 'Decline hand-over')

**Fix outcome:** Fixed. An offered recipient can Accept and download on their own linked computer without owning the task first. The second-instance Chrome test imports the checkpoint into Bob’s clone, changes ownership, and starts a successful continuation from it.

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-28.

**Repro**

> 1. Start hub t14 (fake, 4419) and teammate instances t14b (4421) and t14c (4423). Create accounts alice and bob (contributors) and a project with repository key mqtt-mcp. Link t14b as alice and t14c as bob (Settings → Connections → Join a team) and map their clones.
> 2. Hub owner creates a task owned by Alice. Alice: Build with agents (claude); it finishes with a checkpoint.
> 3. Alice: Hand over… → Bob T14 → Offer hand-over.
> 4. On Bob's computer (http://127.0.0.1:4423/?team=<bob's connection>#/team/task/<id>) look at Execution.

**Expected:** Bob sees 'Accept and download' plus 'Decline'. Accepting downloads and imports the checkpoint and makes him the owner (docs step 4).

**Actual:** Only 'Decline hand-over' is shown, on 3 separate offers. The only way to accept is POST /api/team-link/tasks/:id/accept, which works when called directly (import before ownership, cancelled offer gives 409). The documented hand-over flow cannot be completed in the UI.

**Root cause (verifier):** ui/collab-task.tsx:70 defines `const canExecute = !shared && isOwner && link !== null;`. Line 92 wraps every local-runner control in `{canExecute ? <> … </> : null}`, and line 93 puts the recipient's control inside it: `{offeredToMe ? <>Accept and download / Decline</> : null}`. The recipient of an offer is by definition not the owner until they accept (the offer leaves the task with the sender, per docs step 3). So for a non-owner `offeredToMe && canExecute` is always false, and the Accept button can never render. Line 100, `{offered && !canExecute && offeredToMe ? <Decline hand-over/> : null}`, then fires for the recipient even on their own linked computer. That fallback was meant for the shared dashboard and for computers without a link. The accept dialog at line 121 (RepoPathDialog → POST /api/team-link/tasks/:id/accept) is therefore unreachable. Tests miss it: test/collab-link.test.ts:142 accepts through the API only, and test/e2e/team.e2e.ts:254 only checks that a shared contributor does not see the button.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-task.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/team-onboarding.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-ui.test.ts`

**Suggested fix:** Split "this computer can act" from "this computer can execute the owner's task". In ui/collab-task.tsx near line 70: `const onThisComputer = !shared && link !== null; const canExecute = onThisComputer && isOwner;`. Move the line-93 fragment out of the `canExecute` block and gate it on `onThisComputer && offeredToMe`, so it renders Accept and download (opens the existing "accept" dialog) and Decline. Change the line-100 fallback to `offered && offeredToMe && !onThisComputer`, so "Decline hand-over" appears only on the shared dashboard or a computer without a link. There, add a short help line such as "Accept it from code-flow on your own computer", so the recipient knows where to go. Keep the Build, Stop, Resume and Hand over controls under `canExecute`. Accepting also works for a hub owner who is the recipient (in-process link, linked=false), because `link !== null` covers both cases. The server-side checks are unchanged: the accept route already enforces that the caller is the recipie …

**Suggested regression test:** 1) Browser test in test/e2e/team-onboarding.e2e.ts, which already spawns a hub and a linked runner instance and connects them through the UI. Have a hub-owned task with a checkpoint offered to the runner's user (or create the checkpoint through the hub's local link). On the runner page, open #/team/task/<id> and assert that `getByRole('button', { name: 'Accept and download', exact: true })` is visible and 'Decline hand-over' is absent. Click Accept, submit the dialog with the mapped path, then a …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode servers with new homes: hub v4631hx on 4631 and Bob's computer v4631bx on 4633. Scratch bare clone of MQTT-MCP, plus two working clones (one for the hub, one for Bob).
1. Hub preconditions through the API: a project on the hub clone, a contributor account "bob" ("Bob V") with a random password, repository key mqtt-mcp, and a task owned by the hub owner ("owner"). Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4631/ (s1-setup.mjs through s5-accept-api.mjs, logs s1.log to s5.log).
2. Bob's computer joined through the UI (Settings → Connections → Join a team → Connect this computer, http://127.0.0.1:4631). Connection c-f6de39d53cbadbb0 showed linked=true, user bob. His key was mapped to his own clone.
3. Hub owner, in the UI: Build with agents (fake claude, check "true"). The attempt finished with checkpoint 90c3ec83. Then Hand over… → "Bob V · online" → note → Offer hand-over. The hub shows "Hand-over offered to Bob V", state=offered.
4. Bob's computer, http://127.0.0.1:4633/?team=c-f6de39d53cbadbb0#/team/task/t-29157c04e0748c65, checked twice: once with a persistent profile and once with a brand-new browser. Both times: the board card says "Needs you / Hand-over to Bob V (you)". The connection picker shows "Connected". Execution buttons are exactly [ 'Decline hand-over' ], and getByRole('button', {name:'Accept and download'}).count() = 0. The status dropdown even says "Done is unavailable: Accept, decline or cancel the offered hand-over before marking the task done". No console or HTTP errors. Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4631bx/002-bob-task-offer-fresh.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4631bx/001-bob-exec-actions.png.
5. Calling the endpoint the hidden dialog would use, POST /api/team-link/tasks/:id/accept?teamConnection=… {handoffId}, returned 200. The owner became Bob V, the hand-over became accepted, refs/codeflow/team/90c3ec83… (0d2e04c) was imported into Bob's clone, and HEAD and the working tree were untouched. The backend works; only the UI entry point is missing.
Why this is not the tester's environment: fresh homes, a fresh browser, a clean link and mapping, and a different sender (the hub owner in-process rather than a linked Alice) all gi …

</details>

### t13-11 · minor · Inbox misses key events: attempt finished/failed is never delivered, reviewers aren't told about a new checkpoint, proposers aren't told about approve or decline

**Fix outcome:** Fixed. Attempt outcomes reach collaborators and reviewers; a finished new checkpoint requests its reviewer’s review; instruction decisions notify the proposer. Store tests cover finish/failure/unknown, stale reviews and approve/decline. Separate reviewer and collaborator browser sessions verify inbox delivery and a declined instruction.

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-13.

**Repro**

> 1. Bob owns a task with reviewer Rita and runs 'Build with agents' on his runner until it finishes (checkpoint published).
> 2. Mia proposes an instruction; Bob declines it.
> 3. Check /api/team/inbox for Bob, Rita and Mia.

**Expected:** The docs say finished/failed attempts notify 'the people concerned'. Bob (who may be away from that computer) or at least the reviewer whose approval just went stale gets an entry; Mia learns her instruction was declined.

**Actual:** No attempt-finished entry for anyone, no entry for Rita when her review went stale, no entry for Mia about her declined instruction.

**Root cause (verifier):** src/collab/store.ts:556 (finishAttempt) notifies only [task.owner.userId], and notify() at src/collab/store.ts:275 removes actor.userId from the targets. The actor on a finish is always the task owner:
- claimAttempt refuses anyone but the owner (src/collab/store.ts:497, "Only the task owner may start an attempt").
- assertAttemptRunner (src/collab/store.ts:254-256) requires actor.userId === attempt.user.userId.
- The owner cannot change while an attempt is claimed, running or unknown (src/collab/model.ts:277, assertNotBusy).
- An owner change supersedes paused and stopped attempts (src/collab/model.ts:285), so a later finish is refused (src/collab/store.ts:544).
- Host-queued runs also act as the requesting member (src/collab/host-execution.ts:167).
So the target set is always empty. The "attempt-finished" and "attempt-failed" inbox kinds (src/collab/model.ts:33, src/collab/store.ts:48, labels in ui/collab-state.ts:132) can never be written. The reviewer and collaborators, the "people concerned", are never targeted.
Related gaps:
- addCheckpoint (src/collab/store.ts:589-590) marks earlier reviews stale but notifies nobody.
- decideInstruction (src/collab/store.ts:469-476) only com …

**Files:** `src/collab/store.ts`, `src/collab/model.ts`, `ui/collab-state.ts`, `ui/collab-board.tsx`, `docs/team-collaboration.md`, `test/collab-store.test.ts`

**Suggested fix:** 1. finishAttempt (store.ts:556): notify this.stakeholders(task) (owner, collaborators and reviewer) instead of [task.owner.userId]. The actor is still excluded, so the tested and documented "not for your own actions" rule holds. If the product also wants the owner told when they are away from that computer, add an explicit option to notify() that keeps the owner for runner-reported endings (actor.via === "runner"), then update test 303 and the docs together.
2. When the finished attempt produced a checkpoint (attempt.checkpointId) and task.reviewer is set, notify the reviewer: "New checkpoint <short sha> on “<title>” needs review; your earlier review is now stale" (kind review-requested, or a new kind "checkpoint-added"). Put this at finish time, after the bundle upload, rather than in addCheckpoint, where the bundle is still pending.
3. decideInstruction: add InboxKinds "instruction-approved" and "instruction-declined" in model.ts:33, the INBOX_KINDS validator at store.ts:48 and INBOX …

**Suggested regression test:** Add a test to test/collab-store.test.ts:
- Setup: alice owns a task with reviewer rita and collaborator maya. Rita approves checkpoint A. Alice's runner claims, adds checkpoint B and finishes "finished".
  - Assert rita's and maya's inbox kinds include "attempt-finished".
  - Assert rita also gets the new-checkpoint/review-requested item mentioning the stale review.
  - Keep the existing line-303 assertion that alice has no attempt-* item.
- Repeat with state "failed" and expect "attempt-failed" …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode servers with new homes. My assigned ports were already taken by other verifiers' servers: 4625 by v4623f and 4627 by v4627. I left those alone and used the hub v4625n on 127.0.0.1:4695 and Bob's computer v4625m on 127.0.0.1:4697. The repository was a scratch bare clone plus a working clone of MQTT-MCP. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4625n/ (s1-s4 .mjs/.log).
1. Setup through the API (s1): on the hub I created project "V4625 Team MQTT" (p-a03b3a5b), accounts bob (contributor), rita (reviewer) and mia (contributor) with random test passwords, and repository key "mqtt". On 4697 I linked Bob's computer to http://127.0.0.1:4695 over loopback as "Bob laptop" and mapped mqtt to the scratch clone.
2. (s2) Bob created a task through his shared session with owner=Bob and reviewer=Rita. Rita's inbox then held review-requested, as expected. On 4697 I opened the task, clicked Build with agents, chose solo and check "test -f README.md", and submitted. The attempt ended "finished" with checkpoint 8f503e12 (bundle available). Audit: attempt-claimed / checkpoint-added / bundle-stored / attempt-finished, all by Bob.
3. (s3) Rita approved checkpoint 1. Mia proposed the instruction "Please also mention wildcard topics" (state proposed). On 4697 Bob clicked Decline in the task Discussion, and the UI shows "Send to agent · Declined … declined by Bob (you)". Bob then ran Build with agents a second time and got a second finished attempt and checkpoint 2. Rita's review is now stale:true.
4. Inboxes after two finished attempts and the decline:
- BOB: instruction-proposed by Mia, review-recorded by Rita.
- RITA: only the original review-requested.
- MIA: empty.
- Hub owner: empty.
- team/inbox.json holds exactly ["rita:review-requested","bob:review-recorded","bob:instruction-proposed"].
5. (s4) Signed in with fresh browsers on the hub's shared dashboard:
- Rita's Inbox panel shows only "Review requested". Her card shows "Review pending" but she gets no inbox item about the new checkpoint.
- Mia's panel says "Nothing yet. Assignments, mentions, review requests and hand-overs land here."
- No console errors and no 5xx responses.
The reporter's cited evidence file work/t13/s17.log does not exist; only s17-inbox.mjs does. My run reproduces the issue anyway.
Points that are by design or not promised by the docs:
(a) Bob getting no entry for his own runner's  …

</details>

### t14-4 · minor · Server refusals (409) are hidden behind generic 'Task changed; reloading' / 'Board changed; reloading' toasts

**Fix outcome:** Fixed. Only coded stale-revision conflicts trigger reload messaging. Domain refusals retain the server’s text in the action/dialog, including across linked transport. Chrome verifies checkpoint-deletion and repository-key refusals, draft retention and the reconnect recovery refusal.

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-26, COL-35, COL-24.

**Repro**

> A) Hub owner offers a hand-over of their task (Hand over… → Alice), then in Checkpoints clicks Delete → Delete bundle.
> B) Manage → Team server → Repositories · <project>: Remove the key that tasks use, add another, then Save repositories.

**Expected:** The server's reason is shown: A) 'Cancel the offered hand-over before deleting its checkpoint'; B) 'Task “Add a greeting file (T1)” still uses repository mqtt-mcp; move it to another repository before removing that key'.

**Actual:** A) Toast 'Task changed; reloading' and no alert (2/2). B) Toast 'Board changed; reloading'; the draft stays and nothing explains why the save failed. The same handler covers Resume, Stop and hand-over cancel/decline, so refusals such as 'Stop the attempt running on X before resuming this one' would also look like stale-data reloads.

**Root cause (verifier):** The UI treats every 409 as "someone else saved first" and drops the server's message.

- ui/collab-task.tsx:57, in `act`: `if (err instanceof ApiError && err.status === 409) { showToast("Task changed; reloading", 3000); await load(); }`. It never shows `err.message`. All task-page mutations go through this path:
  - save()
  - respond() (decline or cancel a hand-over)
  - link_() (Stop/Resume through /api/team-link)
  - checkpoint Delete (line 232)
  - reviews, decisions, discussion
- ui/collab-settings.tsx:174, in RepoKeysEditor `save`: the same pattern with "Board changed; reloading". The editor keeps the dirty draft, so the next Save is refused again for the same reason, which is still never shown.

The server uses 409 both for revision CAS failures and for domain refusals, and sends only `{error}`:
- Revision CAS failures: src/collab/store.ts:258 `cas()` "Task changed; reload before saving" and store.ts:399 "Team board changed; reload before saving".
- Domain refusals:
  - store.ts:645 (delete the checkpoint of an offered hand-over)
  - store.ts:401 (repository key still in use)
  - store.ts:528 and :659 and model.ts:244/261-262 ("Stop the attempt running on X before …")
  - ru …

**Files:** `ui/collab-task.tsx`, `ui/collab-settings.tsx`, `ui/lib.ts`, `src/collab/model.ts`, `src/collab/store.ts`, `src/collab/api.ts`, `src/collab/link-api.ts`, `test/collab-api.test.ts`, `test/e2e/team.e2e.ts`, `docs/team-collaboration.md`

**Suggested fix:** Mark stale-revision conflicts with a machine-readable code and handle only those as "reload".

1. Server:
   - Give CollabError an optional `code` (src/collab/model.ts:38), for example `new CollabError("Task changed; reload before saving", 409, "stale-revision")`.
   - Use it in store.ts `cas()` (258) and the board CAS in setRepositories (399). Use it too in the other revision checks that should reload: host-execution.ts:109/141 and terminals.ts:82.
   - Have the API error writers send `{ error, code }` when a code is set: api.ts:86/206 and link-api.ts:130.
   - The link proxy (link.ts:236ff) already passes JSON error bodies through unchanged, so linked computers get the code too.
2. UI: give ApiError the code from the body (`body.code`, at ui/lib.ts:75).
   - In collab-task.tsx `act`, toast and reload only when `err.code === "stale-revision"`. Any other 409 calls `setError(err.message)` (shown as role=alert) and should also `load()`, because the refusal may mean the view is out of dat …

**Suggested regression test:** 1. test/collab-api.test.ts, next to line 88/95:
   - A stale-revision PUT returns `json.code === "stale-revision"`.
   - Removing an in-use repository key at the current revision returns 409 with the "still uses repository" message and no stale-revision code.
   - DELETE /api/team/checkpoints/:cid while a hand-over offers that checkpoint returns 409 "Cancel the offered hand-over before deleting its checkpoint" without the code.
2. test/e2e/team.e2e.ts, extending the "a save that lost to a teamma …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4637t14 on port 4637, with a new home. The project was a scratch bare clone plus clone of MQTT-MCP. The preconditions were set up through the API:
- project "V4637 Team MQTT", with account alice as contributor
- repository key mqtt-mcp
- task "Add a greeting file (T1)", owned by the hub owner
- one attempt, claimed as runner "local", that ends finished, with one checkpoint whose bundle is uploaded and available

Every action under test was then done in headless Chrome. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4637t14/repro.mjs. Logs: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4637t14/repro.log and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4637t14/repro-b.log.

A) On #/team/task/<id> I clicked Hand over…, chose Alice V and clicked Offer hand-over; the API showed handoff=offered. Then in Checkpoints I clicked Delete and then Delete bundle. The network got `DELETE /api/team/checkpoints/923d40d5… -> 409 {"error":"Cancel the offered hand-over before deleting its checkpoint"}`. The UI showed only the toast 'Task changed; reloading' and no alert. The page text never contains the reason. The task revision did not change (6 before, 6 after, and 8/8 in round 2), so nothing was stale. Result: 2 of 2 rounds; I cancelled the hand-over through the UI after each. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4637t14/001-A-delete-offered-toast.png

B) In #/settings/connections/manage, in the group 'Repositories · V4637 Team MQTT', I removed mqtt-mcp, added 'Docs site', and clicked Save repositories. The network got `PUT /api/team/projects/p-6a2e4eee/repositories -> 409 {"error":"Task “Add a greeting file (T1)” still uses repository mqtt-mcp; move it to another repository before removing that key"}`. The UI showed only the toast 'Board changed; reloading', with no alert. The draft stays dirty (Discard is shown) and the hub keys stay ["mqtt-mcp"]. Result: 2 of 2 rounds. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4637t14/001-B-key-inuse.png

Control: a real stale revision on the same endpoint answers 409 "Team …

</details>
