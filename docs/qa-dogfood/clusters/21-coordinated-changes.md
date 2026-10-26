# Cluster 21 · coordinated-changes

**Coordinated changes: startup crash, revision churn, cancel/retry semantics, raw errors**

Status: **fixed and verified** · 9 issues · branch `codex/qa-coordinated-changes`

Planner notes: t18-4: 'await coordinatedApi.service.load()' at src/server.ts:2753 is unguarded, so an invalid coordinated-changes.json stops the server. Record a fault the way projectTeams.load does; deferred-runs fixes the adjacent deferredRuns.load line. t18-5: CoordinatedChanges.wait() (src/repo-coordination.ts:221) bumps the revision about every 5 s while a task waits, so Cancel and Retry get 409. Don't persist or bump the revision when nothing changed. t18-12/S11-6: Cancel has no confirmation and discards a Ready job, and shipping targets default to 'main' whatever the repo's default branch is. t18-13/S11-5: retryNode resets only the downstream closure and clears the job's cancelRequested, so cancelled upstream nodes block forever. t18-14: raw git errors come through from merge-validation/resolveCommit. t18-15: switching project wipes the typed task drafts. t18-21: expired matrices and exhausted retries (attempts >= 3) are not explained. Duplicate groups: [["t18-13","S11-5"],["t18-12","S11-6"]]

Likely files: `src/repo-coordination.ts`, `ui/repo-coordination.tsx`, `src/server.ts`, `src/merge-validation.ts`, `src/coordinated-api.ts`, `src/git.ts`

## Repair outcome · 2026-10-26

Implemented from integration commit `fbc956216a3d55cc8903890f6b3f10c460d69b9a` in the dedicated worktree `/private/tmp/codeflow-qa-continue/coordinated-changes`. Every test used scratch Git repositories, a private temporary `CODEFLOW_HOME`, and fake provider binaries. No live server, user store, remote operation, push or PR was used.

| Issue | Outcome and regression evidence |
| --- | --- |
| t18-4 | **Fixed.** A failed initial storage load latches a feature fault; background start does nothing, list/mutations report the file path, and the server continues. Both truncated JSON and inconsistent job status are tested against the real server: health and runs remain available, the coordinator returns HTTP 400, the browser shows the storage error, and bytes remain unchanged. Repairing the file and restarting restores access. |
| t18-5 | **Fixed.** Repeat waits keep scheduler deadlines in memory. Status/reason transitions still persist, but idle ticks preserve the revision, history, and file mtime. The original 40-second fake Codex scenario remains running/waiting across 11 seconds; its first confirmed browser Cancel returns HTTP 200. A deterministic test covers four further idle ticks and cancellation using the earlier revision. |
| t18-12 | **Fixed.** Ready cancellation names the two verified results being withdrawn, explains agent reruns and the attempt budget, and keeps branches/commits. Dismissing the dialog leaves the revision unchanged. Accepting it cancels the job and records withdrawal history without sending cancellation to finished runs. The shipping preview is removed unless an unresolved shipping claim still needs its evidence. |
| S11-6 | **Fixed.** Targets come from each repository's current local branch, with existing main/master/first-local fallbacks; a repository on master now defaults to master. Running cancellation names the active task and requires confirmation. Empty or unavailable branch selections have explicit guidance. |
| t18-13 | **Fixed.** A retry checks its transitive upstream dependencies before clearing cancellation or invalidating evidence. A cancelled/failed/blocked/unknown upstream produces “Retry … first”; the UI disables that retry with the same explanation. Direct HTTP rejection leaves the job byte-for-byte unchanged; retrying the upstream resets its downstream closure and makes progress. |
| S11-5 | **Fixed with documented per-task semantics retained.** Independent cancelled siblings still require explicit separate retries, now stated on the card. A dependency cannot be silently left waiting on a cancelled upstream. The regression covers both sibling retries and dependency-first recovery. There is no implicit rerun of unrelated tasks. |
| t18-14 | **Fixed.** Local merge validation checks empty, malformed and missing source/target branches before resolving them and names the repository. A moved/deleted result branch identifies its task; previously verified downstream receipts become Blocked and are labelled “Last verified branch.” The real browser reproduces the moved-result case. Creation with a missing project returns 404; a repository outside the project returns 400. Concurrent membership changes retain 409. Operation errors appear in the affected job and do not claim a draft was preserved; only failed creation uses that message. |
| t18-15 | **Fixed.** Workbench passes its route project. Switching projects preserves every task, provider, verification command and dependency, including extra tasks when the destination has fewer repositories. Missing repository assignments become explicit empty selections. The browser also types while the panel's projects request is delayed and verifies that loading does not replace the text. |
| t18-21 | **Fixed.** Shared retry policy explains both the task's own three-attempt limit and an exhausted dependent before mutation. Expired shipping previews show renewal instructions and associate them with the disabled merge controls. The browser advances only its own clock past expiry and exhausts three actual fake runs; unit coverage proves that an exhausted dependent prevents invalidating retained evidence. |

### Verification and evidence

- Independent baseline: the first five new service regressions were copied to a detached `fbc9562` worktree and **all five failed**, confirming revision churn, ineffective downstream retry, cancellation of finished runs, unnamed storage failure and stale dependent verification.
- `npx tsc --noEmit` and `git diff --check` passed.
- `npx tsx --test test/qa-coordinated-changes*.test.ts test/repo-coordination.test.ts test/coordinated-api.test.ts test/merge-validation.test.ts`: **32/32 passed** (9 new regressions, 23 existing checks).
- `npx tsx --test --test-concurrency=1 test/e2e/qa-coordinated-changes.e2e.ts`: **6/6 passed**, with zero browser page errors. The original `test/e2e/repo-coordination.e2e.ts` passed **2/2**, covering actual verified dependency dispatch, private-file exclusion, local shipping, target movement rejection, explicit revalidation and cancelled-job restart safety.
- Evidence directory: `/private/tmp/codeflow-qa-continue/coord21-browser-evidence/`; final unit output: `/private/tmp/codeflow-qa-continue/coord21-unit-final.log`; browser output: `/private/tmp/codeflow-qa-continue/coord21-e2e-acceptance.log`. Screenshots cover draft preservation, missing target, expiry, ready cancellation, blocked dependency retry, attempt exhaustion, changed result and corrupt storage. Reviewed screenshots show the relevant controls and explanations. Log inspection found only the expected file-specific storage diagnostics and standard experimental SQLite warning; healthy startup continued in both corruption cases.

### Boundaries and integration notes

Corrupt startup storage intentionally requires repair and application restart; automatic dispatch never resumes merely because bytes later change. Compare-and-swap still rejects genuine concurrent job changes. Shipping remains explicit per repository, and already merged targets are preserved. Real provider execution and remote code hosts were outside this scratch-only verification.

No confirmed issue from this cluster remains unresolved within the tested scope.

The `src/merge-validation.ts` local target guard must coexist with cluster20's separate pinned target commit: apply the local target-branch check only when no pinned target is supplied. The only Workbench change passes `projectId` to the coordinator panel. No engine changes or shared QA status files were made.

## Issues

### t18-4 · major · An invalid or truncated coordinated-changes.json stops the whole code-flow server from starting

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-32.

**Repro**

> 1. Stop a QA server whose home has coordinated-changes.json.
> 2. Truncate it: printf '{"version":1,"jobs":[' > $HOME/coordinated-changes.json (or leave a job whose saved status is inconsistent).
> 3. Start the server.

**Expected:** Coordinated changes fail closed: dispatch is disabled and the panel shows the storage error with the file path, while the rest of the app starts, as projectTeams.load() does.

**Actual:** The server exits at startup with 'code-flow: Uncaught exception: Unexpected end of JSON input' (and 'Inconsistent coordinated job status' for the second variant). Nothing is served, and the message does not name the file. The file itself is left untouched.

**Root cause (verifier):** src/server.ts:2753 `await coordinatedApi.service.load();` is a top-level await with no catch. The neighbouring call at server.ts:2751 has one: `projectTeams.load().catch(...)` records a fault and keeps going. CoordinatedChanges.load() (src/repo-coordination.ts:96) runs change() (line 234), which calls readDocument (line 265). readDocument rethrows any error other than ENOENT, either the raw JSON.parse SyntaxError or a validateCoordinationDocument error such as "Inconsistent coordinated job status" (line 259). The rejection aborts evaluation of the ESM entry module before the HTTP listener is created. The uncaughtException handler at server.ts:152-158 only logs it, and the event loop then drains, so the process exits with nothing served. readDocument also does not add the file path to the error, unlike deferred-runs.ts:367 ("Deferred queue cannot be read: ..."), which is why the message does not say which file is bad. A second trap: startPolicyBackground (server.ts:269, called at 2775 and in the policy path at 1618) calls coordinatedApi.service.start(), which throws "Load coordinated changes before dispatch" when load failed (repo-coordination.ts:170). A catch on load alone therefor …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/repo-coordination.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/coordinated-changes.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/repo-coordination.test.ts`

**Suggested fix:** 1. src/server.ts: track readiness, following the projectTeams/ml pattern.
   - Declare `let coordinatedReady = false` before startPolicyBackground.
   - Replace line 2753 with `coordinatedReady = await coordinatedApi.service.load().then(() => true, (error) => { logError(\`Coordinated changes disabled: ${coordinatedApi.service.file} cannot be read\`, error); return false; })`.
   - Run coordinatedApi.recover() only when coordinatedReady.
   - In startPolicyBackground (server.ts:269), call coordinatedApi.service.start() only when coordinatedReady.
   - A cleaner alternative is to keep the fault inside CoordinatedChanges: start() becomes a no-op while a load fault is set, and list() and mutations surface the fault. The policy re-enable path at server.ts:1618 would then be covered automatically.
   - Pausing (stop()) already works when nothing was loaded.
2. src/repo-coordination.ts readDocument (line 265): wrap errors other than ENOENT as `Coordinated changes storage ${file} cannot be rea …

**Suggested regression test:** test/server-reliability.test.ts: add a test that seeds a temp CODEFLOW_HOME, starts the server with the existing startServer({ CODEFLOW_HOME: home }) helper, and runs two cases.
- Case (a): coordinated-changes.json is '{"version":1,"jobs":['.
- Case (b): a valid job whose status is edited to disagree with its nodes.
For each case, assert:
- GET /api/health returns 200, so the server is up.
- GET /api/coordinated-changes returns 400 and body.error contains "coordinated-changes.json".
- The file's …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA home, v4609t184 on port 4609, with the dogfood-qa source at f14f404, which is clean and unmodified.
1. Baseline: a fresh start was healthy and GET /api/coordinated-changes returned []. I stopped it, wrote '{"version":1,"jobs":[]}' to $HOME/coordinated-changes.json and started again; it was still healthy and returned [].
2. Truncated file: I stopped the server, ran printf '{"version":1,"jobs":[' > $HOME/coordinated-changes.json and started it. qa-server.sh start never became healthy (exit 1). server.out has exactly one line, "code-flow: Uncaught exception: Unexpected end of JSON input", which does not name the file. The process exited and nothing listened on 4609 (curl got connection refused). The server.log stack is JSON.parse, then readDocument (src/repo-coordination.ts:265), then the change() closure (src/repo-coordination.ts:234). The file's SHA1 was the same before and after, so it was left untouched.
3. Inconsistent status: I copied the reporter's valid 7-job backup (work/t18/coord-backup-before-edit.json), changed job[0].status from shipped to cancelled while its nodes stayed shipped, and installed it as coordinated-changes.json. On start, the log shows "code-flow: Uncaught exception: Inconsistent coordinated job status", the process exited, nothing was served, the file was unchanged and no runs were created. Load fails before start(), so nothing was dispatched.
Attempts to refute it:
- docs/coordinated-changes.md:27 promises "Incomplete or invalid storage fails closed and is left untouched". That reads as fail-closed for the feature, not the whole server.
- The crash-handler comment at server.ts:147-149 says "A stray rejection or throw must not take every live run down with it".
- Neighbouring stores degrade instead of crashing: projectTeams, ml, filteredTasks, notifications, integrations and acpConnections.
- So this is not by design. It is also not caused by the tester's environment: I reproduced it with a clean home and no browser involved.
Fix check on a private snapshot (builds/v4609t184; the source under test was not touched):
- Adding only .catch to load() is not enough. The server then dies with "Uncaught exception: Load coordinated changes before dispatch", thrown by CoordinatedChanges.start() (repo-coordination.ts:170) from startPolicyBackground (server.ts:269, called at server.ts:2775).
- Adding a coordinatedReady guard as well makes the server start. /api/runs returns 200 and GET /api/coordinated-changes retur …

</details>

### t18-5 · major · Coordinated job revision changes every ~5 s while a task waits, so Cancel/Retry in the UI fail with 409 'changed. Refresh before acting'

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-32, GIT-33, GIT-34.

**Repro**

> 1. Fake server with FAKE_SLEEP_MS=40000 FAKE_SLEEP_VENDOR=codex. Project with two scratch repos.
> 2. Repository tools → Coordinated changes: create repo1 (provider Codex, check true) and repo2 (depends on repo1).
> 3. While repo1 runs and repo2 shows 'Waiting…', watch GET /api/coordinated-changes: the revision goes up by 1 roughly every 5 s with no visible change.
> 4. Click 'Cancel coordinated change' (or 'Retry task …' on a blocked job with a waiting task).

**Expected:** An action on the job the user is looking at succeeds. Idle waiting does not bump the revision or rewrite/fsync the file each tick.

**Actual:** First click: alert 'This coordinated change changed. Refresh before acting. Your draft is preserved.' Cancel needed a second click while the slow task kept running. The same happened for Retry (attempt 1 → 409, attempt 2 ok). Revision went 12→13→14→15→16 over 20 s with no state change.

**Root cause (verifier):** src/repo-coordination.ts:221 CoordinatedChanges.wait(). When a node is already "waiting" with the same reason, it still runs `node.nextCheckAt = next` (now + 1000, or the clamped retryAt) inside updateNode(). tickOnce (src/repo-coordination.ts:188-196) calls wait() for every waiting node whose nextCheckAt has passed. With the 5 s default tick (start(intervalMs = 5000), line 170) and a 1 s nextCheckAt, that means every tick. change() (src/repo-coordination.ts:234) then compares canonical(prior) with canonical(job). The changed nextCheckAt makes them differ, so it sets job.revision = prior.revision + 1 and calls writeDocument() (line 266: temp file write, fsync, rename, directory fsync).

nextCheckAt is purely scheduler bookkeeping but is treated as user-visible state. Every mutating endpoint does a compare-and-swap through current() (line 87), which throws CoordinationConflictError (409, line 44) when job.revision !== expectedRevision. These include cancel (116), retryNode (125), attach (139/143), previewShipping (145-151) and shipNode/recoverShipping.

The UI (ui/repo-coordination.tsx:36, act()) sends job.revision from its 5 s completion-based poll (pollVisible, line 23; ui/polling …

**Files:** `src/repo-coordination.ts`, `test/repo-coordination.test.ts`, `ui/repo-coordination.tsx`

**Suggested fix:** Stop treating the re-check schedule as revisioned job state.

In CoordinatedChanges, add an in-memory `private readonly schedule = new Map<string, number>()` keyed by `${jobId}:${nodeId}`:
- In wait(), compute `next` and call `this.schedule.set(key, next)`. When the node is already waiting with the same reason, return without mutating the document.
- Only on a status/reason transition set status, reason and nextCheckAt and append history.
- In tickOnce, gate on `Math.max(node.nextCheckAt ?? 0, this.schedule.get(key) ?? 0) > this.now()`.

change() then sees no canonical difference for an idle tick, so it neither bumps the revision nor rewrites/fsyncs the file. I applied exactly this patch in my snapshot copy: the new idle test passes (revision 4 -> 4, file not rewritten), and the existing focused suites still pass (test/repo-coordination.test.ts 12/12, test/coordinated-api.test.ts 7/7).

Alternative: in change(), exclude nodes' nextCheckAt from the revision comparison and from the "need …

**Suggested regression test:** Add to test/repo-coordination.test.ts, using the existing fixture(): `await f.create(); let job = await f.tick(); job = await f.tick();`, then assert job.nodes[1].status === "waiting". Record job.revision, job.history.length and (await stat(f.options.file)).mtimeMs. Then loop 4 times: `f.advance(4000); job = await f.tick();`. Assert that revision, history length and file mtime are unchanged, and that `await f.service.cancel(job.id, recordedRevision)` succeeds with status "cancelled" (no Coordina …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4611-t185" on 127.0.0.1:4611, started with exported FAKE_SLEEP_MS=40000 FAKE_SLEEP_VENDOR=codex (confirmed in the server process env), in a new home. Two brand-new scratch git repos (clones/v4611t185-a, clones/v4611t185-b) were put into one project "v4611 Coord" through the UI ("Open another repository" -> Create project, then -> "Add to v4611 Coord").

Script work/v4611-t185/s02-churn.mjs (log s02.log) used Repository tools -> Coordinated changes to create the job "v4611 churn": repo1 on Codex with check "true", repo2 depending on repo1.

Phase 1, 20 s of idle waiting (repo1 running, repo2 "Waiting for every dependency's current verified result"), sampled every 250 ms:
- Server revision went 4->5->6->7->8, about one bump every 5 s.
- history stayed at 4 entries, updatedAt never changed, and statuses and reason never changed. Only repo2.nextCheckAt moved.
- coordinated-changes.json mtime changed 4 times (rewritten with fsync each tick).
- The UI badge's revision was behind the server in 39% of 79 samples.

Phase 2: clicking "Cancel coordinated change" while the UI showed revision 7 and the server was at 8 gave a 409 and the alert "This coordinated change changed. Refresh before acting. Your draft is preserved." The job stayed running. The second click worked. Screenshot shots/v4611-t185/002-cancel-attempt1.png also shows that the alert renders at the top of the panel, out of view at 1440x900 next to the Cancel button, while the badge silently refreshes and still says "Running". A user can easily believe Cancel worked while the slow task keeps running.

Phase 3: "Retry task repo2" succeeded, because a cancelled job is skipped by the tick and does not churn. repo2 then waited and the revision went 12->15 in 16 s. "Retry task repo1" then failed with 409 four times in a row (UI r14/15/16/17 vs server r15/16/17/18). The UI poll (completion-based, 5 s plus request time) drifts against the server's fixed 5 s setInterval, so the stale window can cover most of the cycle.

During cleanup (z-cleanup.mjs) the revision had reached 48-49 after about 2.5 more minutes idle, and the first Cancel click 409'd again. That makes 3 independent UI reproductions.

Deterministic unit check in my snapshot copy (builds/v4611-t185/test/zz-v4611-idle-revision.test.ts, using the repo-coordination.test.ts fixture): after reaching running/waiting, 4 idle ticks give "revision 4 -> 8; history 4 -> 4; file rewritten: true", and assert.equal(revision) fails.

Refu …

</details>

### t18-12 · minor · 'Cancel coordinated change' has no confirmation and discards a Ready job's verified results

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-33.

**Repro**

> 1. Create a coordinated change and wait until it is Ready (both tasks Verified).
> 2. Click 'Cancel coordinated change' once.

**Expected:** A confirm dialog. For a Ready job, a warning that verified results will be discarded and need a re-run.

**Actual:** It acts immediately: the job is 'Cancelled' and both verified nodes become 'Cancelled' ('Sent cancellation to this exact owned run'). The shipping review is gone and a retry re-runs the agents.

**Root cause (verifier):** ui/repo-coordination.tsx:62: the header button calls `onClick={() => act(job, "cancel")}` directly. `act` (lines 34-39) posts to /cancel straight away. There is no confirmAction (ui/confirm-state.ts) and no state-specific warning, although a Ready job has verified results that cancel withdraws.

src/repo-coordination.ts:116-121: cancel() sets job.cancelRequested=true. Line 119 includes "verified" in the nodes whose run gets cancelRun, and line 120 then sets item.status="cancelled" with the history entry "Sent cancellation to this exact owned run", even when the run has already finished (engine.cancel at src/engine.ts:3514 is a no-op for a done run, and coordinated-api.ts:128 ignores its boolean result). That message is misleading for a finished run.

After this, the only way forward is retryNode (lines 125-137), which deletes result, runId and claimId on the node and its whole downstream closure, sets them to pending, re-launches agents and uses one of the 3 attempts (COORDINATION_LIMITS.attempts). The job's status is computed as "cancelled" whenever cancelRequested is set (refresh(), line 83), and previewShipping/shipNode refuse when job.cancelRequested is set (lines 146, 155). So …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/repo-coordination.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/repo-coordination.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/coordinated-changes.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/repo-coordination.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/repo-coordination.test.ts`

**Suggested fix:** 1. Required (UI), ui/repo-coordination.tsx:62: import confirmAction from ./confirm-state.js and gate the cancel. Build the message from the job state:
   - If any node is verified (or job.status === "ready"), say how many verified results will be withdrawn from this coordinated change. Say they can no longer be shipped from it, that retrying re-runs their agents and uses one of three attempts, and that run branches and commits are kept.
   - If nodes are running or claimed, say their runs will be stopped.
   - Use title "Cancel coordinated change?", confirmLabel "Cancel coordinated change", danger:true.
   Only call act(job, "cancel") when the dialog is accepted. Optionally give the button the `danger` class.

2. Recommended (service), src/repo-coordination.ts:119-120: for a verified node whose run is already finished, do not call cancelRun or log "Sent cancellation to this exact owned run". Record something like "Withdrew this verified result from shipping; its run and branch are kept …

**Suggested regression test:** Add a step to test/e2e/repo-coordination.e2e.ts (the existing UI test reaches the Ready state and currently never clicks Cancel in the UI):
- Once the card shows "Validate and preview shipping matrix", click card.getByRole("button", { name: "Cancel coordinated change" }).
- Assert page.getByRole("dialog", { name: "Cancel coordinated change?" }) is visible and its text mentions the verified results and re-running.
- Click the dialog's dismiss button and assert the job (via /api/coordinated-change …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server named "v4625k" on port 4625 with a new home (the existing v4625* homes were not reused). I created two brand-new throwaway git repos (clones/v4625k-a and v4625k-b, one commit each) and added both to a new project "v4625k Coord" through the Projects dialog. In Project -> Repositories -> Coordinated changes I created "v4625k ready-cancel" through the UI: verification "true" for both tasks, repo2 depending on repo1. After about 1 minute the job was "Ready · revision 7" with both tasks Verified and the "Review local merge targets" section showing (shots/v4625k/001-before-cancel.png).

Script work/v4625k/03-cancel.mjs listened for native page dialogs (and dismissed any it saw), then clicked "Cancel coordinated change" exactly once:
- 400 ms after the click there was no app confirmation dialog (dialog.confirmation-dialog[open] = 0) and no native dialog.
- 3 s later the server state was "cancelled r10", cancelRequested=true, and both nodes were "cancelled".
- The history tail read "Cancellation requested for all unshipped tasks", "Sent cancellation to this exact owned run" (repo1) and the same for repo2.
- The UI showed "Cancelled · revision 10" with both node badges "Cancelled". The shipping review section was gone and only "Retry task repo1/repo2" buttons were offered (shots/v4625k/003-after-cancel.png). The cancelled nodes still displayed "Verified branch ... at <commit>".
- The underlying runs stayed status=done and both codeflow/<run>/solo branches still pointed at the pinned commits. Nothing was deleted from git, but the coordination job can no longer ship them.

work/v4625k/04-retry.mjs then clicked "Retry task repo1". It cleared the results and started new agent runs for both repo1 and repo2 (repo2 is invalidated as a dependent): run IDs changed, attempts went 1 -> 2 of 3, and total runs went 2 -> 4. There is no API or UI path to un-cancel and keep the verified results: the routes are only cancel, retry, attach (unknown nodes only), shipping-preview, ship and recover-shipping.

Not by design: docs/coordinated-changes.md only says "Cancelling stops pending dispatch and sends cancellation to known runs" and says nothing about confirmation or a Ready job. The rest of the app wraps comparable destructive actions in confirmAction(..., {danger:true}) (14 files, e.g. "Reject this result?", "Cancel hand-over?", "Stop this attempt?"). Not environmental: it reproduced with the exact button, not a wrong selector.

Cleanup: through  …

</details>

### S11-6 · minor · Every shipping target input defaults to 'main' (repos whose default branch is master fail validation unless edited), and 'Cancel coordinated change' has no confirmation even though it cancels every running task.

Source: code-level suspect at `ui/repo-coordination.tsx:60` (confirmed hands-on).

**Repro**

> Fake server s11, project with s11-alpha (default branch main) and s11-beta (default branch master). Coordinated change with both tasks verified. 'Review local merge targets' showed main for repo1 and main for repo2 (shots/s11/001-coord-ship-defaults.png). 'Validate and preview shipping matrix' failed with 'git rev-parse --verify refs/heads/main^{commit} failed: fatal: Needed a single revision'. The error was rendered at the top of the panel, out of view (shots/s11/002-coord-ship-default-error.png). After editing repo2 to master, the same action produced the pinned matrix (shots/s11/003-coord-ship-master-ok.png). Cancel: one click on 'Cancel coordinated change' gave 0 native dialogs and 0 modal elements; the job was immediately Cancelled and both verified tasks became Cancelled (shots/s11/001-coord-after-cancel.png). Re-running a task afterwards used attempt 2 of 3.

**Expected:** Each target defaults to that repository's default or current branch (master for the beta repo). Cancelling asks for confirmation that names the running tasks and the verified results that will be discarded.

**Actual:** The target is always 'main', so master-default repos fail with a raw git error until the user edits the field. One click cancels the whole job with no confirmation.

**Root cause (verifier):** The shipping review renders `value={targets[key] ?? "main"}` and submits `targets[key] ?? "main"` for every node, without looking up the repository's default or current branch. The cancel button calls `act(job, "cancel")` directly, with no confirmAction, while other destructive or outward actions in the app (merge PR, post review, delete runs) ask for confirmation. Cancel also invalidates verified results (cancel() marks running/verified/unknown nodes cancelled).

**Suggested fix:** Prefill each target from the repository's default branch (e.g. /api/branches?repo=<node.run.repo> `initial`, or origin/HEAD, or the branch that held node.baseCommit) and map a missing-branch git error to "Branch 'main' doesn't exist in <repo>". Wrap cancel in confirmAction({title:'Cancel coordinated change?', danger:true}) and list the running or verified tasks that will be stopped or discarded.

**Suggested regression test:** UI/e2e: a coordinated job over a master-default repo shows 'master' as the prefilled target and validates without edits. Clicking 'Cancel coordinated change' opens a confirmation; choosing Keep leaves the job running and its revision unchanged.

### t18-13 · minor · After cancel, retrying only the downstream task leaves the job Blocked with the task waiting forever

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-34.

**Repro**

> 1. Coordinated change with repo2 depending on repo1. Cancel it while repo1 runs.
> 2. Click 'Retry task repo2' (not repo1).

**Expected:** Either the retry includes the cancelled upstream, or it is refused with 'Retry repo1 first'.

**Actual:** cancelRequested is cleared and the job is 'Blocked'. repo2 stays 'Waiting for every dependency's current verified result' indefinitely while repo1 stays Cancelled (and the revision keeps changing, see t18-5).

**Root cause (verifier):** src/repo-coordination.ts:125-136, CoordinatedChanges.retryNode().
- Line 128 builds `closure` from the selected node plus its downstream dependents only. It never looks at the selected node's own dependencies.
- Lines 129-132 check only shipping and the closure, so there is no check that every upstream of the selected node is "verified"/"shipped" or will become so (pending/waiting/claimed/running).
- Line 133 then does `job.cancelRequested = false` for the whole job, and line 134 resets only the closure to "pending".
- After a cancel, src/repo-coordination.ts:117 has set every pending/waiting/blocked/failed task to "cancelled", and :120 does the same for running/verified tasks once cancelRun succeeds. So the upstream repo1 stays "cancelled".
- refresh() at :83 then reports the job as "blocked", because a task is cancelled and cancelRequested is false.
- In tickOnce(), :192 finds the dependency not verified and calls wait(). At :221 that only refreshes nextCheckAt when the reason is unchanged, and every such write bumps the revision in change() at :234. That is the t18-5 churn, and it causes the 409s on the recovery click.
- Nothing ever retries the cancelled upstream, so the downst …

**Files:** `src/repo-coordination.ts`, `ui/repo-coordination.tsx`, `test/repo-coordination.test.ts`, `docs/coordinated-changes.md`

**Suggested fix:** Preferred, a server-side refusal in retryNode() (src/repo-coordination.ts:127-133), before cancelRequested is cleared:
- Collect the selected node's transitive upstream dependencies.
- If any upstream is not in "verified", "shipped", "pending", "waiting", "claimed" or "running" (i.e. it is cancelled, failed, blocked or unknown), throw a clear error such as `Retry ${upstream.id} first; ${node.id} depends on it and it is ${status}`.
- This keeps the documented rule ("invalidates the selected task and all downstream") and guarantees a retry never un-cancels a job that cannot make progress.
- Retrying the root still works as it does now, because its closure includes all downstream tasks.

Alternative: widen the closure to include cancelled/failed upstream tasks. This is riskier: it spends their attempts and may need acknowledgeUnknown, so an explicit refusal fits the module's "explicit action" design better.

UI (ui/repo-coordination.tsx:72): disable "Retry task X" when a dependency is in  …

**Suggested regression test:** Add a case to test/repo-coordination.test.ts using the existing fixture():
1. `await f.create(); let job = await f.tick();` (api running), then `job = await f.tick();` (web waiting), then `job = await f.service.cancel(job.id, job.revision)`.
2. `await assert.rejects(f.service.retryNode(job.id, "web", job.revision), /Retry api first/)`.
3. Assert the saved job is unchanged: status "cancelled", cancelRequested true, both tasks "cancelled", and the revision did not move.
4. Then `job = await f.serv …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4627t1813 on port 4627, started with FAKE_SLEEP_MS=90000 and FAKE_SLEEP_VENDOR=codex so the codex task keeps running. I made two of my own tiny git repos (scratch/qa/clones/v4627-a and -b) and added them to a new project "v4627 Coord" through the Projects dialog. Through the Coordinated changes panel I created "v4627 cancel-retry": repo1 uses codex in repo a, repo2 uses claude in repo b and depends on repo1, and both checks are "true". Results:
- Before cancel: running r3, repo1 running, repo2 pending.
- I clicked "Cancel coordinated change": cancelled r6, cancelRequested=true, both tasks cancelled, repo1's run cancelled. Both "Retry task repo1" and "Retry task repo2" buttons were shown.
- I clicked only "Retry task repo2". The server accepted it with no error. The job went to "blocked" r7 with cancelRequested=false, repo1 still "cancelled" and repo2 "pending".
- From about 7s on, repo2 stayed "waiting" with reason "Waiting for every dependency's current verified result". Over 27s the revision rose r8 to r12 (about one per 5s tick) and no new run was launched; /api/runs still listed only the cancelled run.
- The screenshot (scratch/qa/shots/v4627t1813/002-after-retry-repo2.png) shows "Blocked · revision 12", repo1 "Cancelled" with a "Retry task repo1" button, and repo2 "Waiting". Nothing tells the user that repo1 must be retried first.
- Recovery check: "Retry task repo1" does unstick it (repo1 attempt 2 running, repo2 pending), but it took 4 clicks. The first 3 got 409 "This coordinated change changed. Refresh before acting." because of the revision churn from t18-5.

Unit check: in a snapshot copy (scratch/qa/builds/v4627t1813, test/t1813-retry-downstream.test.ts, which reuses the fixture from test/repo-coordination.test.ts) I ran create → tick → cancel → retryNode("web") → 5 ticks. Result: job "blocked", cancelRequested false, api "cancelled", web "waiting", revisions [8,9,10,11,12], claims still 1. Then retryNode("api") reset both tasks to pending and the next tick launched api; the test passes.

Not by design: docs/coordinated-changes.md only says "Retrying invalidates the selected task and all downstream results and receipts". It says nothing about a selected task whose upstream can never verify, and nothing about retry silently un-cancelling the whole job. Not environmental: it reproduces in fake mode, on a fresh home and fresh repos, both through the UI and at unit level.

Severity: kept at minor. No data is lost, no work …

</details>

### S11-5 · minor · retryNode sets job.cancelRequested=false for the whole job but resets only the retried node's dependency closure; a cancelled job's other tasks stay cancelled, so the job comes back as 'blocked' and needs a separate retry per task.

Source: code-level suspect at `src/repo-coordination.ts:133` (confirmed hands-on).

**Repro**

> UI on fake server s11: Repository tools > Coordinated changes. I created 'S11 two-repo change' with two independent tasks (s11-alpha and s11-beta, verification 'true'); both became Verified and the job Ready. Clicking 'Cancel coordinated change' cancelled the job: repo1 and repo2 = Cancelled, including the verified results. Clicking 'Retry task repo1' turned the job 'Blocked' (cancelRequested=false). repo1 re-ran (attempt 2) and verified, but repo2 stayed Cancelled and the job stayed 'Blocked · revision 15' until a separate 'Retry task repo2' (shots/s11/002-coord-after-retry.png). Scratch unit test in builds/s11 using the repo-coordination fixture (api → web dependency): completed() → cancel → retryNode('web') gives job 'blocked', cancelRequested=false, api=cancelled, web=pending. After 5 ticks: web=waiting ('Waiting for every dependency's current verified result') indefinitely, api still cancelled.

**Expected:** After a job-level cancel, retrying either resumes the job coherently (all cancelled unshipped tasks, or at least the retried task's cancelled dependencies, are reset) or refuses with 'Retry <dependency> first'. A retried task never waits forever on a cancelled input.

**Actual:** The job flips from Cancelled to Blocked. Cancelled siblings and upstream tasks stay cancelled, and a retried downstream task waits indefinitely with no hint. Each task must be retried individually, and each retry uses one of its 3 attempts even though the task had verified before the cancel.

**Root cause (verifier):** retryNode builds only the downstream closure (nodes that depend on the retried one), resets those to pending, and unconditionally clears the job-level `cancelRequested`. Cancelled siblings and cancelled upstream dependencies stay 'cancelled', so refresh() computes 'blocked'. A retried downstream node waits forever on a cancelled dependency. Per-task explicit retries are documented (docs/coordinated-changes.md), so the 'one retry per task' part is partly intended. However, nothing documents that retrying one task silently resumes the job, and the downstream-waits-forever state has no guard or message pointing at the cancelled dependency. cancel() also turns already-verified nodes into 'cancelled', so each retry re-runs the agent and uses up one of the 3 attempts.

**Suggested fix:** Make cancellation reversal explicit: add a job-level 'Resume coordinated change' that resets every cancelled, non-shipped node (plus its downstream closure) and clears cancelRequested. In retryNode, while job.cancelRequested is set, either include cancelled upstream dependencies in the reset set or reject with 'Retry <dependency> first'. Optionally do not discard verified results on cancel of a Ready job.

**Suggested regression test:** repo-coordination.test.ts: completed() → cancel → retryNode('web') must either reject with a dependency message or reset api too, and must not leave web waiting with api cancelled. A second case with two independent nodes: cancel, resume/retry, and assert the job status and node states follow the chosen semantics.

### t18-14 · minor · Coordinated change and merge-validation errors are raw or misleading

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-31, GIT-32, GIT-35, GIT-36.

**Repro**

> 1. Coordinated shipping review: type a target branch that does not exist (e.g. 'develop') → Validate and preview shipping matrix.
> 2. Change a verified task's result branch (commit in its worktree).
> 3. API create with a repo outside the project.
> 4. Any panel error.

**Expected:** 'Branch develop does not exist in <repo>'; 'repo1's result changed after it was verified'; 'Repository X is not in project Y'.

**Actual:** 1: 'git rev-parse --verify refs/heads/develop^{commit} failed: fatal: Needed a single revision Your draft is preserved.' (the same raw text from POST /api/runs/:id/validate-merge with a missing into). 2: node becomes 'Failed' with 'The result HEAD, verification or review changed during inspection' while its dependent stays Verified. 3: 409 'This project or its explicit repository membership changed…'. 4: every error, including cancel/ship/recover, ends with 'Your draft is preserved.'

**Root cause (verifier):** 1) src/merge-validation.ts:11 calls `resolveCommit(repo, "refs/heads/" + into)`. That goes to src/git.ts:283 `gitOk`, which throws src/git.ts:176-178 `gitError` ("git <args> failed: <stderr>"). Nothing checks that the branch exists first, although `branchExists` is at git.ts:868. The raw message passes unchanged through src/server.ts:2682 (validate-merge → HttpError 400), src/coordinated-api.ts:112 → src/repo-coordination.ts:149 → src/coordinated-api.ts:145 (HttpError 400). The UI makes it easy to hit: ui/repo-coordination.tsx:76-77 is a free-text target field defaulting to "main".
2) src/coordinated-api.ts:89 folds four different conditions into one generic reply: review coverage stale, a review-coverage head mismatch, the branch ref no longer equal to report.head, and the run object changing. All return `{status:"failed", reason:"The result HEAD, verification or review changed during inspection"}`, whether the change happened after verification or during the check. src/repo-coordination.ts:183 maps that to node status "failed". Because validateResult rejects first, the clearer branch at repo-coordination.ts:182 ("blocked" / "changed after it was pinned") is never reached in this  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/merge-validation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/git.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/coordinated-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/repo-coordination.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/repo-coordination.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/merge-validation.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/coordinated-api.test.ts`

**Suggested fix:** 1) In validateMergeTarget, before resolveCommit, reject an empty `into` ("Choose a target branch"). Run `git check-ref-format --branch` and `branchExists(repo, into)` (and the same for `branch`), and throw a plain error such as `Branch "develop" does not exist in <repo basename>. Choose an existing local branch.` Engine.validateMerge and merge() could share this guard. Optionally, the coordinated UI could offer a list of local branches, or default to each repo's checked-out/default branch instead of the hard-coded "main".
2) Split coordinated-api.ts:89 into specific reasons, for example "<node>'s result branch moved from <old8> to <new8> after it was verified; retry the task to verify the new result" when the branch ref ≠ report.head; "Review coverage for <branch> is stale" when coverage.stale; keep the "during inspection" wording only for the run/verification object changing mid-check. Consider returning "blocked" rather than "failed" for a moved result (the existing test at coordinat …

**Suggested regression test:** test/merge-validation.test.ts: `await assert.rejects(validateMergeTarget(repo, { branch: "result", into: "develop", profile: profile(["true"]) }), (e) => /develop.*does not exist/.test(e.message) && !/rev-parse|Needed a single revision/.test(e.message))`, plus into:"" rejecting with /Choose a target branch/. test/coordinated-api.test.ts: (a) create with a node repo that is not in the project rejects with /not in project/ (HttpError 400) and an unknown project rejects with 404, while the existing …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4629t1814 on 127.0.0.1:4629 with a new home. I made two throwaway git repos (main branch, one commit each) and registered them as project "v4629 Coord" through the API (setup only). In the UI (Repositories → Coordinated changes) I created the job "v4629 errors": repo1 and repo2, both with check `true`, and repo2 depending on repo1. Both tasks reached Verified and the job became Ready (revision 7). Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4629t1814/ (s1..s5, z-cleanup).
1) UI: set "Shipping target for repo1" to `develop` and clicked "Validate and preview shipping matrix". The alert at the top of the panel read: "git rev-parse --verify refs/heads/develop^{commit} failed: fatal: Needed a single revision Your draft is preserved." (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4629t1814/001-wrong-target-alert.png). The create form was collapsed and empty, so no draft existed. The same raw text comes back from POST /coordinated-changes/:id/shipping-preview (400) and POST /api/runs/:id/validate-merge {into:"develop"} (400). With into:"" the error is "git rev-parse --verify refs/heads/^{commit} failed…". The target field is free text and defaults to "main", so any repo whose branch is "master" hits this on the first click.
2) Committed moved.txt in repo1's run worktree (codeflow/…/solo moved from 95fb7ef9 to 159a410f). Within one tick the job went to Blocked; repo1 went to "Failed" with reason "The result HEAD, verification or review changed during inspection"; repo2 stayed "Verified". The repo1 card is self-contradictory: a red Failed badge, the "during inspection" reason, and still "Verified branch … at 95fb7ef9…" (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4629t1814/001-repo1-failed.png).
3) API POST /api/coordinated-changes with a third repo that was never in the project returned 409 "This project or its explicit repository membership changed. Review the coordinated request before continuing." An unknown project id returned the same 409 and wording. The UI cannot send this request because of its client-side check, so this is API-only.
4) ui/repo-coordination.tsx:44 renders every error as `{error} Your draft is preserved.`. This was confirmed live on the s …

</details>

### t18-15 · minor · Switching project in the coordinated-change form wipes all typed task drafts

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-31.

**Repro**

> Repository tools → Coordinated changes → Create: type tasks, verification commands and dependencies → change Project to another and back.

**Expected:** Drafts are kept, or a confirmation before discarding them.

**Actual:** Task text, verification and dependencies are reset to empty. Only the change name survives.

**Root cause (verifier):** ui/repo-coordination.tsx:46 — the Project <select>'s onChange handler replaces the whole draft list with fresh empty nodes:

  setNodes([empty("repo1", chosen?.repos[0]), empty("repo2", chosen?.repos[1])])

`empty()` (line 13) returns task "", provider "claude", check "" and dependsOn []. So every typed task, provider choice, verification command, dependency and extra node (repo3..repo10) is thrown away. Only the repository field actually needs to change for the new project. `name` lives in separate state and is not touched, which is why it survives.

The project-load effect at line 23 makes a smaller version of the same reset: it calls setNodes([empty(...), empty(...)]) when /api/projects resolves, so anything typed before that request finishes is also lost.

Related but separate: workbench.tsx:112 mounts <CoordinatedChangesPanel /> without the route's project. The picker therefore defaults to the first project with 2 or more repos rather than the project the user has open, which pushes users toward switching project in the first place.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/repo-coordination.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/repo-coordination.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ui-review.test.ts`

**Suggested fix:** When the project changes, re-point the drafts at the new project's repositories instead of recreating them. Add a pure exported helper, for example:

  retargetDrafts(nodes: DraftNode[], repos: string[]): DraftNode[]

It keeps each node's id, task, provider, check and dependsOn. A node's repo is kept if it is still in `repos`. Otherwise it gets the next repository from the new project that no other node uses, or "" if none is left.

Call it from the onChange at line 46: setNodes((previous) => retargetDrafts(previous, chosen?.repos ?? [])). Keep the setOperationId(crypto.randomUUID()) call.

If the new project has fewer repositories than there are nodes, keep the extra nodes with repo "" so the existing validation ("Choose project repositories…") reports it, rather than deleting the user's text.

In the load effect at line 23, apply the default repos with the same helper through a functional update (setNodes((previous) => retargetDrafts(previous, first.repos))) so early typing is not ov …

**Suggested regression test:** 1. Unit test in test/ui-review.test.ts: add `export { retargetDrafts } from "./repo-coordination.tsx";` to the esbuild stdin. Then assert that for nodes [{id:"repo1",repo:"/a",task:"T1",provider:"codex",check:"npm test",dependsOn:[]},{id:"repo2",repo:"/b",task:"T2",provider:"claude",check:"",dependsOn:["repo1"]}], retargetDrafts(nodes, ["/c","/d"]) keeps task/provider/check/dependsOn deep-equal and remaps the repos to ["/c","/d"]. Also assert that a project with only one repository keeps both no …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4631 on port 4631. Before starting it, I moved the old home aside to homes/v4631.prev-<time>. I made 4 scratch git repos (alpha, beta, gamma, delta) under qa/clones/v4631-coord. As setup only, I registered two 2-repo projects through the API: "v4631 Coord A" (alpha, beta) and "v4631 Coord B" (gamma, delta).

Browser script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4631/t18-15.mjs. It used a fresh headless Chrome profile and real UI clicks:
1. Opened #/project/<A>/repositories, then Coordinated changes, then expanded "Create a coordinated change", with Project A selected.
2. Filled in the change name, both Task fields, Provider repo2=codex, Verification repo1="npm test" and repo2="make check", and checked "repo2 depends on repo1".
3. Changed Project to B, then back to A.

What I saw (log t18-15.log in the same folder):
- After switching to B: task1, task2, verif1 and verif2 were all "", prov2 was back to "claude", dep21=false. The repos were remapped to gamma/delta and the name was kept.
- After switching back to A: everything was still empty or default (task1 "", task2 "", verif1 "", prov2 "claude", dep21 false). Only "Cross repo rollout" survived.

No confirm dialog appeared, and the component has no confirm call. The page logged no console errors and created no jobs. Screenshot 003-after-switch-back-A.png in qa/shots/v4631 shows the empty Task and Verification fields.

Is it by design? Nothing in docs/coordinated-changes.md says switching project clears drafts. The component itself promises "Your draft is preserved." in its error banner (ui/repo-coordination.tsx:44), so silently dropping typed text goes against its own intent. The tester's script and environment did not cause this: I reproduced it with different projects and a fresh profile.

</details>

### t18-21 · minor · Expired shipping matrices and exhausted retries are not explained in the UI

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-35, GIT-34.

**Repro**

> (a) Let a shipping preview pass its 30-minute expiry. (b) Retry a failing coordinated task 3 times.

**Expected:** 'Preview expired, validate again' next to the disabled Merge buttons. 'Attempt limit (3) reached' next to the disabled Retry.

**Actual:** Only disabled buttons, plus 'expires <time in the past>' or 'attempt 3'.

**Root cause (verifier):** ui/repo-coordination.tsx:72 renders `<button disabled={!!busy || node.attempts >= 3 || …}>Retry task {node.id}</button>` and says nothing when `node.attempts >= 3`. Line 65 shows only `· attempt ${node.attempts}`. The server reason "This task reached its three-attempt limit" (src/repo-coordination.ts:127, limit COORDINATION_LIMITS.attempts=3 at :47) is only ever returned on a click, and the disabled button cannot be clicked. The same applies to "A dependent task reached its three-attempt limit" (:131): there the UI leaves Retry enabled and the server rejects it.

ui/repo-coordination.tsx:79 renders the pinned matrix as `Preview {id} · expires {new Date(expiresAt).toLocaleString()}` and each Merge button as `disabled={… || job.shipping!.expiresAt <= Date.now() || node.status !== "verified"}`. Nothing changes the wording to "expired" or tells the user to validate again. Expiry is COORDINATION_LIMITS.previewMs = 30 min (src/repo-coordination.ts:47, :151); the server refusal is at :155.

This is not by design. docs/coordinated-changes.md:13 and :19 document the 3-attempt limit and the 30-minute expiry but say nothing about leaving them unexplained. Elsewhere the UI follows a disabledRe …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/repo-coordination.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/repo-coordination.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/repo-coordination.e2e.ts`

**Suggested fix:** Move the limits into a dependency-free shared module so the UI can import the real values. For example, export `COORDINATION_LIMITS` (attempts, previewMs) from a new src/repo-coordination-limits.ts and re-export it from src/repo-coordination.ts. Do not import src/repo-coordination.ts into the UI, because it pulls in node:fs and node:crypto.

In ui/repo-coordination.tsx:

(a) Retry: when `node.attempts >= COORDINATION_LIMITS.attempts`, render `<p class="help" id={`${key}-retry-limit`}>Attempt limit ({limit}) reached. Cancel this coordinated change and create a new one to try again.</p>` and put `aria-describedby` on the disabled Retry button. Also compute the dependent closure on the client. If any dependent is at the limit, disable Retry with "A dependent task reached its attempt limit" instead of letting the server reject it.

(b) Matrix: track a ticking `now`, e.g. a 15–30 s interval or reuse the 5 s poll render, and compute `expired = job.shipping.expiresAt <= now`. When expired, ch …

**Suggested regression test:** Add cases to test/e2e/repo-coordination.e2e.ts, which already drives the fake-agent coordinator UI.

(1) Expiry: after "Validate and preview shipping matrix", call `await page.clock.setFixedTime(job.shipping.expiresAt + 60_000)` and reload the panel. Assert that `card.getByText(/Preview expired/i)` is visible, that `getByRole('button', { name: 'Merge repo1 into main' })` is disabled, and that its aria-describedby resolves to text containing "validate". page.clock is already used in test/e2e/hist …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server, v4643f on port 4643, with a new home. A home called v4643 already existed from earlier use, so I stopped it and did not use it. I made two throwaway git repos with local bare origins (clones/v4643-alpha and v4643-beta) and added them to a new project "v4643 Coord" through the Projects dialog. Then, in Repository tools → Coordinated changes, I created two coordinated changes through the UI.

(1) Retry limit: "v4643 limit" had repo1 verification set to `false` and repo2 depending on repo1. The first attempt failed. I clicked "Retry task repo1" twice in the UI, and each retry failed again (attempts 2 and 3). After attempt 3, the "Retry task repo1" button is disabled. It has no title or aria-describedby, and nothing explains why. The node shows only "independent · attempt 3", the Failed badge and the original reason ("The owned result has no current published branch with successful engine verification"). The job shows "Blocked". When I called the API directly, the server knows why: 400 {"error":"This task reached its three-attempt limit"}. That message never reaches the UI because the button cannot be clicked. Screenshot: shots/v4643f/001-retry-limit.png.

(2) Expired matrix: "v4643 ship" had both checks set to `true`. Both tasks reached verified and the job became ready. I clicked "Validate and preview shipping matrix" at 22:17:06Z, which set expiresAt to 22:47:06Z. Before expiry, both Merge buttons were enabled. I then waited the real 30 minutes. On a page left open from before expiry, and again after a reload, both "Merge repoN into main" buttons were disabled. The only text was "Preview … · expires 10/25/2026, 11:47:06 PM" (a time already past). The word "expired" appears nowhere, there is no alert, and nothing points to the still-enabled "Validate and preview shipping matrix" button above. The server confirms the expiry: POST …/nodes/repo1/ship returned 400 "Review a fresh shipping matrix and select an unshipped verified task". Screenshots: shots/v4643f/002-after-expiry-same-page.png and 003-after-expiry-reload.png. I also got the same result with a shifted browser clock (page.clock.setFixedTime to expiresAt+60s; 001-matrix-clock-expired.png).

There were no console or 5xx errors. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4643f (r01.log, s02.log, s03.log).

Cleanup: both coordinated changes were cancelled in the UI ( …

</details>
