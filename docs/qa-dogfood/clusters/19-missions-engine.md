# Cluster 19 · missions-engine

**Project missions engine: archive invalidates drafts, orphaned missions, reconcile errors, triggers**

Status: **fixed and verified on continuation branch · integrated into `codex/dogfood-qa-continue`** · 14 issues · branch `codex/qa-missions-continue`

Planner notes: Mostly src/project-teams.ts. t12-2: verified() re-runs assertProjectTeamChanges on the run worktree, so archiving a ready result (as the delete guard advises) invalidates the verified draft. t12-3: removeProject and DELETE /api/projects never touch mission aggregates, leaving an invisible mission that blocks the repo. t12-6: reconcile() writes transient errors into the persistent error field and never clears them. t12-7: about 15 conditions share one generic block reason. t12-8: a restart leaves an interrupted run that can't be deleted and stays fully charged. t12-10/S08-4: the managed trigger's enabled flag ignores the host missions switch, and tick() retries every 30 s without advancing nextAt (syncProjectTeam/tick in src/automation.ts). Coordinate with automation-records and schedule-editor-tz and touch only the project-team branches. t12-13: a missing base branch gives a raw git error. t12-14: the preview lists Next runs for draft and paused missions. t12-16: errors still say 'Standing team'. t12-17: managed run pages show raw mission JSON in the task and a composer that is always refused. t12-24/S07-3: stopCycle succeeds with no active cycle and cancels older cycles' runs. t12-20: the project-teams e2e has an unhandledRejection from its /api/models route mock. Duplicate groups: [["t12-24","S07-3"],["t12-10","S08-4"]]

Likely files: `src/project-teams.ts`, `src/project-team-policy.ts`, `src/project-team-store.ts`, `src/project-team-model.ts`, `src/automation.ts`, `src/engine.ts`, `src/server.ts`, `ui/project-teams.tsx`, `ui/run.tsx`, `ui/projects.tsx`

## Continuation verification (2026-10-26)

Merged the interrupted `qa-fix/missions-engine` implementation after finishing cluster 18. Preserved the already integrated schedule editor and schedule catch-up logic. Review and concurrent validation found three WIP gaps: a transient recovery failure could overwrite the restore advisory, deletion could admit an unsettled unprovable launch, and archive cleanup could remove a worktree after its existence check but before Git verification completed. Recovery failures now have their own field (including migration of legacy transient messages), and the interruption exception requires a settled launch charged in full. The archive race now falls back to the retained commit only if the worktree disappeared; intact worktrees still fail closed on verification errors. Historical task JSON is normalized before rendering so malformed list values cannot crash a managed run page.

Validation: `npx tsc --noEmit` and `git diff --check` passed. `test/project-teams.test.ts`, `test/qa-missions-ui.test.ts` and `test/qa-missions-engine.test.ts` passed 63/63 together (including nested cases); the two new Chrome suites passed 12/12 after the archive race fix. Validation uses fake providers, scratch Git repositories and temporary data homes only. `test/qa-missions-engine.test.ts` covers archive cleanup followed by approval and merge; project deletion/repository release; old orphan release; transient recovery versus restore advisories; no-change, proof, reviewer-rejection and permission failures; interrupted-run deletion without a budget refund; disabled host schedules over two simulated hours; four admission retries over twenty minutes sharing one event; missing branches; idle/idempotent stop; and safe task summaries. The six Chrome/server scenarios in `test/e2e/qa-missions-engine.e2e.ts` exercise the original UI paths on 127.0.0.1:4361/4362, including result archive with default worktree cleanup, approval, actual project-delete confirmation, repository re-add, and an interrupted discovery across a real fixture restart.

The original `test/e2e/project-teams.e2e.ts` passed all four scenarios twice with `QA_MISSIONS_PORT=4361 QA_MISSIONS_MODEL_DELAY_MS=1500`, forcing slow catalog discovery across its server restart. Its route mock now catches aborted fetch/fulfill operations instead of leaking an unhandled rejection. `test/fake-agent.mjs` has an opt-in bounded discovery delay for this regression. The expected disconnected request belongs to this deliberate restart; it is separate from application page exceptions. New suites navigate away before storage-only restarts and check all console/page errors, with exactly one expected HTTP 400 for the invalid-base form in the engine suite.

Evidence: `output/playwright/qa-missions-engine/` and `output/playwright/qa-missions-ui/` in the continuation worktree contain screenshots, browser error logs and server logs (generated, not committed). Test transcripts are in `/private/tmp/codeflow-qa-continue/missions-*.log`. All fixture servers and temporary repositories are removed by teardown. No real-agent, external publishing or live-worktree claims.

## Issues

### t12-2 · major · Archiving a ready/accepted mission result (as the delete guard advises) invalidates the verified draft

**Continuation outcome:** Fixed. After worktree cleanup, verification checks the exact retained commit against the pinned base in the repository, retaining branch/head, scope and review checks. Chrome archive→approve and the service archive→approve→merge regression pass.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-20, MIS-13.

**Repro**

> 1. Mission active with a check (node check.mjs); 'Give team a task' and wait until the opportunity is ready.
> 2. Open the result run, then More run actions > Delete… > Delete run. You get 'This mission result is awaiting approval or shipping. Archive this run instead...'.
> 3. More run actions > Archive… and keep the default 'Remove its 2 worktrees' checked, then Archive.
> 4. Open the mission card.

**Expected:** Archiving keeps the result approvable (branch and commit unchanged), or the dialog warns that removing worktrees invalidates the mission result.

**Actual:** Within a tick the opportunity becomes 'blocked', reason 'Cannot establish the managed result's changed files'. It can no longer be approved or shipped and needs a paid revision. With the worktree checkbox unchecked it stays ready. Reproduced twice (Task five, then again after revision).

**Root cause (verifier):** src/project-teams.ts:236-237: verified() finds the run worktree for the verified branch and calls assertProjectTeamChanges(worktree.path, run).

src/project-team-policy.ts:19-21: assertProjectTeamChanges runs git diff, ls-files and numstat with that worktree as cwd. If the directory no longer exists, git exits non-zero and it throws "Cannot establish the managed result's changed files".

src/engine.ts:3682-3692: archive({cleanup:true}) calls removeWorktrees(run.repo, run.worktrees, ...) and keeps the branches. The cleanup default is true in both places that set it: src/server.ts:2591 (`cleanup: body.cleanup !== false`) and ui/run.tsx:1641 (ArchiveDialog `useState(true)`).

Once the worktree is gone, every caller of verified() fails, even though the branch and the head commit are unchanged:
- refreshResults (src/project-teams.ts:339-344) runs on every reconcile tick when the team has no active cycle. It marks the ready or accepted opportunity "blocked". The status is sticky because blocked results are never re-checked.
- decide approve (line 356) fails.
- shippingGuard (lines 242-247) fails, so merge and PR are refused.

The deletion guard at src/project-teams.ts:73 recommends archi …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-team-policy.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/project-teams.md`

**Suggested fix:** Primary fix: make post-settlement verification independent of whether the run's worktree still exists.

1. Give assertProjectTeamChanges a committed-tree mode, e.g. `assertProjectTeamChanges(at, run, { commit })`. In that mode it runs `git diff --name-only -z <baseRef> <commit>` and `--numstat <baseRef> <commit>` in run.repo. It skips the untracked-file pass, because uncommitted content cannot ship from the branch. The scope, file and line limits stay the same, and binary changes are still refused, applied to the committed result.
2. In verified(), use the live-worktree check only when `existsSync(join(worktree.path, ".git"))`. This matters during settle(), where uncommitted leftovers must still be caught. Otherwise call the committed mode with commit = v.head. verified() already requires `resolveCommit(refs/heads/<branch>) === v.head` (line 239) and unchanged review coverage, so the committed-tree check is sufficient after settlement. Missing branches still throw "The verified result  …

**Suggested regression test:** Add a test to test/project-teams.test.ts, or extend "complete cycle uses existing Auto teams…" (around lines 84-94), using cleanup: true:
1. Run the fixture cycle until the opportunity is "ready".
2. Assert that `f.manager.deleteRun(child.id)` rejects with /Archive this run instead/.
3. Call `await f.manager.archive(child.id, { cleanup: true })`. Assert the worktree path no longer exists and that `f.git("rev-parse", o.result.branch) === o.result.head`.
4. Call `await f.service.reconcile()`. Asse …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4655ar on 127.0.0.1:4655, with CODEFLOW_SCHEDULER_TICK_MS=1000. Its new home was seeded with projects.json only, so the user's project-teams were not copied in. The repository was a new scratch clone of MQTT-MCP (bare clone, then a working clone). On its scratch main I committed check.mjs (process.exit(0)) and .codeflow/config.json {"prove": false}. The reporter's clone had the same config. Without it, fake agents cannot satisfy the fail-to-pass proof, and the task ends blocked with "lacks required checks", which is unrelated to this issue.

All steps went through the UI in headless Chrome (scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4655ar/):
1. s01-setup.mjs: Open another repository, create a new project, Enable project missions, Create a mission (check "node check.mjs"), Save draft mission, Activate.
2. Give team a task (category docs). The cycle completed and the opportunity became "ready" with head 6c6352f on codeflow/2610252036-2eb6f15b/integration. Both worktrees existed and the branch head matched result.head.
3. In the run, More run actions > Delete… > Delete run. The alert said "This mission result is awaiting approval or shipping. Archive this run instead, or reject the result in the mission before deleting it."
4. More run actions > Archive…. The dialog reads "Remove its 2 worktrees (uncommitted changes in them are lost)", and that checkbox is checked by default. I left the defaults and clicked Archive; the toast said "Archived".
5. Within 0.5 s the API showed the opportunity "blocked" with reason "Cannot establish the managed result's changed files". Both worktree directories were gone. The branch head was still 6c6352f, equal to result.head. The mission card showed "blocked" with only Request revision, Defer one week and Reject; there was no Approve this commit button. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4655ar/002-card-after-archive-remove.png. Log: s02a.log.

Control (s02b.log): I ran a new task to "ready", then archived it the same way but unchecked "Remove its 2 worktrees". The result stayed "ready", Approve this commit was offered, and approving made it "accepted".

Accepted case (s03.log): I archived that accepted run again with cleanup:true, which is the server default. It became blocked with the same reason. POS …

</details>

### t12-3 · major · Deleting a project orphans its mission, which stays invisible and blocks the repository from any new mission

**Continuation outcome:** Fixed. Project deletion archives its missions and stops active work while retaining history and charged reservations; the confirmation explains this. Older orphan missions appear in a new project containing their repository and can be archived. UI deletion/re-add and service orphan/repository-release regressions pass.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-20, MIS-15, MIS-02.

**Repro**

> 1. Open another repository (scratch clone) as project 'X'. On its missions page, Create a mission and Save draft.
> 2. Project actions > Edit project > Delete project > Delete project. The confirmation only mentions runs, not the mission.
> 3. Open the same repository again as a new project 'Y'. On missions, Create a mission, fill it in, and Save draft mission.

**Expected:** Project deletion archives or releases the mission (or warns and offers it), and the repo can get a new mission. Alternatively the orphaned mission stays reachable somewhere in the UI so it can be archived.

**Actual:** 409 'This repository already has a standing team (including its linked worktrees)'. Project Y shows 0 mission cards. The orphan (status paused, projectId of the deleted project) is only visible via the API. The global Inbox card 'Review opportunities' for it opens 'This project is unavailable'. Reproduced twice (deleted project with an active mission and runs; deleted project with a draft mission).

**Root cause (verifier):** 1. src/engine.ts:3657-3662 (`removeProject`) and src/server.ts:2130-2132 (DELETE /api/projects/:id) remove the project and only re-home its runs. They never touch project-team aggregates, so a non-archived team keeps its projectId pointing at a project that no longer exists.

2. src/project-team-store.ts:106 (`create`) treats every non-archived team with the same repo or repositoryId as the owner, including teams whose project is gone. It therefore throws ProjectTeamConflict (409).

3. The orphan cannot be released:
   - `ProjectTeams.update` (src/project-teams.ts:131-133) calls `this.permitted(before, false)` before any change, archive included.
   - `permitted` (src/project-teams.ts:107) throws "The project no longer explicitly contains this repository" when `projects.get(t.projectId)` is undefined.
   - `stopCycle` (src/project-teams.ts:400) has the same gate.
   - Project ids are random (src/projects.ts:152), so the owning project can never be recreated.
   - Reconcile (src/project-teams.ts:280-281) only marks the team paused with an error. It never archives it.

4. UI: ProjectTeamsPanel loads `/api/project-teams?project=<id>` (ui/project-teams.tsx:24), filtered server-side by  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-team-store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/project-teams.md`

**Suggested fix:** 1. Server: let owners release an orphan. In ProjectTeams.update, a request that only sets status "archived" (and maybe "paused") should skip the project-membership part of `permitted()` and keep only the `stopped` and authority checks. The same applies to stopCycle, so an orphan with an active or unknown cycle can be stopped first. The existing "Stop the cycle before archiving" and immutability rules stay.

2. Project deletion: have engine.removeProject, called from DELETE /api/projects/:id, consult ProjectTeams before or after `projects.remove`. There are two options:
   - Option a: refuse deletion while the project owns non-archived missions with an active or unknown cycle, with a message to stop those first. Then archive its remaining teams in the same operation, using `store.change` with status "archived" and an error/reason "Project deleted". Also call `automations.syncProjectTeam` so the schedule is disabled. History, receipts and budget are kept, as the docs promise for archived …

**Suggested regression test:** In test/project-teams.test.ts, add "deleting a project releases its missions so the repository can get a new one":
- Use fixture(), with a draft team plus an active team that has a settled cycle, then call `await f.manager.removeProject(f.project.id)` and reconcile.
- Assert that `f.store.get(f.team.id).status === "archived"` and that history, opportunities and allowance() are deepEqual to before.
- Assert that `f.automations.get(`t-${id}`).enabled === false`.
- Create a new project with `f.proj …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this on the first try with a fresh fake-mode server: name v4657n, port 4657, home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4657n. That home was seeded only with projects.json. I left out the user's project-teams directory so that no other team could cause a fault or fire a schedule, and so the result could not come from those records.

I did every step through the UI with Playwright, using scripts /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4657n/r1.mjs and r2.mjs. Logs are r1.log and r2.log in the same folder.

1. Open another repository: a scratch clone of MQTT-MCP, opened as the new project "v4657n X" (p-8161e2fc).
2. On its Missions page: Enable project missions, Create a mission, fill it in, Save draft mission. The project had 1 card, and the team pt-cf91f60af43b1c64a8bbedf2 was in status draft.
3. Project actions > Edit project > Delete project. The confirmation said only: "Delete the project “v4657n X”? It has no runs." I confirmed. The project was gone, but the API still listed the team with projectId p-8161e2fc and status draft. No storage faults were reported.
4. Open another repository: the same clone, as the new project "v4657n Y" (p-b68b1a12). Missions showed 0 cards. Create a mission > Save draft mission showed the alert "This repository already has a standing team (including its linked worktrees)" (409) and still 0 cards. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4657n/003-y-create-blocked.png
5. Trying to release the orphan through the API also fails. POST /api/project-teams/pt-cf91…, with the current revision and status:"archived", returned 409 "The project no longer explicitly contains this repository". So there is no recovery path in the UI or the API.
6. After restarting the server, the orphan was status paused with error "The project no longer explicitly contains this repository". Creating a mission for Y through the API still returned 409.

The orphan's automation exists (t-pt-…, enabled:false, run.project = the deleted id). Every UI entry point routes to the deleted project id:
- the automation row button
- the Inbox card ProjectTeamsInbox
- Scheduling > Pursue a mission, which needs a project and filters by it

The reporter's draft and active variants both match this.
 …

</details>

### t12-6 · minor · Transient reconcile errors stay on mission cards after the condition clears (false 'Auto team execution is disabled')

**Continuation outcome:** Fixed. Recovery failures use recoveryError, clear after a successful pass, and never overwrite the restore advisory. Legacy transient error messages also clear. Unit checks retain the advisory during a failure/recovery; a saved legacy error clears in the API and browser after restart.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-01, MIS-03.

**Repro**

> 1. Several active missions. Restart the QA server with CODEFLOW_AUTO_TEAM_ENABLED=false and wait about 5s.
> 2. Restart again without the variable (autoTeamEnabled is true in /api/project-teams).
> 3. Open the missions pages and run a cycle.

**Expected:** The error clears once dispatch is permitted again.

**Actual:** Every mission card keeps the role=alert 'Auto team execution is disabled by this host's configuration', even while a new cycle is discovering. Only a status change (Pause/Activate) clears it. Reproduced twice.

**Root cause (verifier):** In src/project-teams.ts, ProjectTeams.reconcile() (lines 249-288) catches any per-team failure. At line 281 it writes the message into the team's persistent `error` field: `if (t.error !== (error as Error).message) await this.store.change(..., (v) => { v.error = (error as Error).message; ... })`.
The success path never clears it. Lines 258-276 (`await this.permitted(snapshot); await this.options.automations.syncProjectTeam(snapshot); ...`) don't reset `error`. Neither does cycle() (lines 165-185), even though permitted() and pin() pass there and a discovery run starts.
The only place that clears it is update() at line 152: `if (r.status) { t.status = r.status; t.error = undefined; }`. So only a status change (Pause/Activate/Archive) removes it.
The UI shows the field without condition as an alert: ui/project-teams.tsx:120 `{t.error && <p role="alert">{t.error}</p>}`.
Any transient reconcile failure therefore sticks after its cause goes away. Besides the auto-team gate (permitted() line 105), this includes the options.allowed() filesystem-policy check (line 108), repositoryIdentity, syncProjectTeam, launch and settle errors.
Fix constraint: the same `error` field also carries a deli …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-team-model.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`

**Suggested fix:** Keep reconcile-originated errors separate from owner advisories so that reconcile can clear its own errors once the condition passes.
1. In project-team-model.ts, add an optional `errorSource?: "reconcile"` to ProjectTeam, next to `error` (line 155), and accept it in validateTeamDocument. A separate field such as `dispatchError` would also work.
2. In the catch block at project-teams.ts:281, set `v.errorSource = "reconcile"` together with `v.error`. The membership-removed branch also pauses the team; keeping it reconcile-sourced is fine, because the team stays paused until the owner reactivates.
3. On the reconcile success path, once `await this.permitted(snapshot)` and syncProjectTeam succeed (line 258), clear the error if it came from reconcile: `if (t.errorSource === "reconcile") await this.store.change(t.id, undefined, undefined, v => { if (v.errorSource === "reconcile") { v.error = undefined; v.errorSource = undefined; } })`. Do the same in cycle() after permitted() and pin() succ …

**Suggested regression test:** Add a case to test/project-teams.test.ts using the existing fixture(). autoTeamEnabled() reads process.env on every call, so the test can toggle it:
1. Run `const f = await fixture(); process.env.CODEFLOW_AUTO_TEAM_ENABLED = "false"; await f.service.reconcile();` and assert `f.store.get(f.team.id).error` matches /Auto team execution is disabled/.
2. Run `delete process.env.CODEFLOW_AUTO_TEAM_ENABLED; await f.service.reconcile();` and assert `f.store.get(f.team.id).error === undefined` while stat …

<details><summary>Verifier's independent reproduction</summary>

Reproduced on a fresh fake-mode QA server, v4663 on port 4663. The old v4663 home was moved aside to homes/v4663-prev-213831. The new home was pre-seeded with only projects.json, so none of the user's missions were copied in. CODEFLOW_SCHEDULER_TICK_MS=3000 was set so reconcile runs every 3s; it changes only the tick interval, not the logic.
Setup, all in the UI (work/v4663/setup.mjs):
- Added two scratch clones of MQTT-MCP as projects "v4663 A" (p-828163ea) and "v4663 B" (p-ff049ad0) with "Open another repository".
- Clicked "Enable project missions".
- Created one propose-mode mission per project and activated both.
- API showed both active with error=null and autoTeamEnabled=true.
Step 1: stopped and restarted with CODEFLOW_AUTO_TEAM_ENABLED=false, confirmed in the process env, and waited 8s. Both missions had error="Auto team execution is disabled by this host's configuration".
Step 2: restarted without the variable and waited 15s, about 5 reconcile ticks. /api/project-teams showed autoTeamEnabled=true, but both missions still had the same error.
Step 3, in the UI (work/v4663/verify.mjs), on mission A:
- The page-level "disabled by host" help is gone, which is correct.
- The card still shows role=alert "Auto team execution is disabled by this host's configuration".
- "Preview next cycle" says "Ready to discover", and "Run cycle now" is enabled.
- Clicked "Run cycle now". While the cycle was discovering, the API error and the card alert were unchanged; screenshot shots/v4663/002-A-discovering.png shows the alert next to an enabled "Stop cycle" and the running discovery run in the sidebar.
- The cycle completed ("Proposals are ready for owner review"). After a reload the alert was still there.
Mission B: clicking Pause cleared the error (API error=undefined, no alerts). After Activate and 7s it stayed cleared.
So only a status change clears it; a successful reconcile, a new cycle and a completed cycle do not. No console or 5xx errors were seen during the verify run.
Not by design: docs/project-teams.md and docs/configuration.md describe CODEFLOW_AUTO_TEAM_ENABLED as a host gate that "must also permit" execution. The page's own help says "Project missions can run once the host permits Auto team execution", which implies the condition is transient. The only error the docs call deliberately persistent is a storage error. No test in test/project-teams.test.ts asserts that the error persists after the condition clears.
Cleanup: deleted the one discovery run ( …

</details>

### t12-7 · minor · Mission block reasons are generic and hide the real cause (no changes, unproven proof, restart, EACCES, reviewer rejection)

**Continuation outcome:** Fixed. Ordered verification checks and bounded run-derived reasons expose no-change, unproven proof, reviewer rejection, interruption and filesystem permission causes. Fake-agent/service tests cover all five; browser tests cover no-change and interruption with links to the evidence.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-05, MIS-11.

**Repro**

> Any of these: (a) give a task whose fake implementation produces no diff; (b) a repo with prove:true (IndustriConnect clone) and a trivial check; (c) restart Code Flow during discovery; (d) make <repo>/.worktrees read-only and run a cycle; (e) a real discovery where the reviewer requests changes. Then read the cycle/opportunity reason on the mission card.

**Expected:** The reason names the actual failure, e.g. 'Implementation produced no changes', 'Fail-to-pass evidence is unproven', 'Code Flow restarted during discovery', 'EACCES creating worktree', or 'Independent reviewer rejected the report'.

**Actual:** (a), (b): 'The implementation lacks required checks and independent review at its final commit', although checks passed and review ran. (c), (d), (e): 'Discovery did not produce an independently approved report at the pinned base'. The real cause is only in the linked run's error.

**Root cause (verifier):** The reason strings come from two places in src/project-teams.ts:
1. src/project-teams.ts:235, `verified()`. About 15 different conditions are ORed together and all throw one message: "The implementation lacks required checks and independent review at its final commit". The conditions include run.status !== "done", verdict failing, verification state not verified, review not approved/reviewed/stale head, no required check, verification hash mismatch, a required check not passing, a required check skipped, and requirements not covered. In cases (a) and (b) the run ends with status "stopped" and verdict "failing" because the Auto team recorded a specific gap: src/patterns/auto-team.ts:615 ("<task>: Implementation produced no changes…") and :682 ("Fail-to-pass evidence is unproven"). That gap is copied into run.error and run.team.gaps. The first condition (status !== "done") fires and the specific cause is thrown away.
2. src/project-teams.ts:311, `settle()` for discovery. `run.status !== "done" || !r?.approved || r.head !== c.baseCommit || r.sourceDigest !== c.sourceDigest || r.digest !== digest(r.report)` always yields "Discovery did not produce an independently approved report at th …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-team-model.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/project-teams.md`

**Suggested fix:** 1. Add a small helper in src/project-teams.ts, `runFailure(run)`, that derives a short, bounded explanation (about 300 characters) from the run. For interrupted runs: "Code Flow restarted while this run was in progress". For cancelled or stopped-by-user runs: "The run was stopped". For failed runs: `Run failed: ${run.error}`. When run.team?.gaps is non-empty, join the gaps (e.g. "Implementation produced no changes", "Fail-to-pass evidence is unproven", "Discovery report requires changes; Independent review has blocking findings"). Otherwise fall back to run.error.
2. Split the condition at :235 into ordered checks, each with its own message:
   - run not done or verdict failing: runFailure(run)
   - no verification profile or no required check: "No required check is configured"
   - profile hash mismatch: "Verification profile changed"
   - a required check missing or not passing, or skipped: "Required check '<command>' did not pass at the final commit"
   - review not reviewed, not ap …

**Suggested regression test:** Add cases to test/project-teams.test.ts using the existing fixture()/settled() helpers and the fake agents.
(1) Owner task whose instructions contain AUTO-NO-CHANGE: assert cycles.at(-1).reason and opportunities.at(-1).reason match /produced no changes/ and do NOT match /lacks required checks/.
(2) Fixture with .codeflow/config.json {prove:true} and a check that ignores the proof test (e.g. `node -e 0`): assert the reason matches /Fail-to-pass evidence is unproven/.
(3) Extend "failed checks can …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4665 on port 4665. The home was seeded with projects.json only, and the user's project-teams were not copied. An older v4665 home was moved aside to homes/v4665.prev-1792960757. I made two scratch clones of MQTT-MCP: v4665-t127a (unchanged) and v4665-t127b (with a commit adding .codeflow/config.json {"prove": true}). Through the UI I added both clones as projects, enabled project missions, and created and activated a "propose" mission on each (check `test -f README.md`, default team: claude coordinator, pool claude/codex/agy). All five scenarios reproduced from the UI. In every case the mission card shows the generic reason, while the run's own error names the real cause:
(e) Server started with FAKE_REVIEW_FAIL_ONCE=1, then Run cycle now on A. Cycle blocked: "Discovery did not produce an independently approved report at the pinned base". Run 2610252040-e28f616f: status stopped, error "Discovery report requires changes; Independent review has blocking findings".
(a) Give team a task on A with instructions containing AUTO-NO-CHANGE. Cycle and opportunity blocked: "The implementation lacks required checks and independent review at its final commit". Run 2610252041-ddba4f25: error "alpha: Implementation produced no changes; the required artifact is missing". team.verification is {check:"passed", reviewed:true} and run.verification.state is "verified" with the primary check passed, so the message is not just vague, it is false.
(b) Normal owner task on B (prove:true). Same "lacks required checks and independent review" reason. Run 2610252042-216e872b: error "Fail-to-pass evidence is unproven", check passed, reviewed:true, proof:"unproven".
(d) chmod a-w on clone A's .worktrees, then Run cycle now (permissions restored afterwards). Cycle blocked with the generic discovery reason. Run 2610252042-652f918e: status failed, error "EACCES: permission denied, mkdir '.../v4665-t127a/.worktrees/2610252042-652f918e'".
(c) Restarted with FAKE_SLEEP_MS=5000, clicked Run cycle now on B, and stopped and restarted the server while discovery was running. After reconcile (about 25 s) the cycle was blocked with the generic discovery reason. Run 2610252043-733b15d4: status interrupted, error "code-flow was shut down while this run was in progress. Resume to continue."
Screenshots are in shots/v4665/: 001-e-discovery-reviewer-rejected.png, 001-a-opportunity.png, 002-a-history.png, 001-c-history.png. On the blocked opportunity card the generi …

</details>

### t12-8 · minor · A restart during a mission cycle leaves an interrupted run that can never be deleted and stays fully charged

**Continuation outcome:** Fixed. A settled, interrupted launch with unprovable usage can be deleted only after its entire reservation is charged. The cycle/ledger remains unchanged; managed run pages direct continuation through the mission. Service and real server-restart/browser regressions pass.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-05, MIS-16, MIS-20.

**Repro**

> 1. Run cycle now on a mission (FAKE_SLEEP_MS=4000 so discovery takes about 20s).
> 2. While discovering, restart the server (qa-server.sh restart).
> 3. The cycle becomes blocked; the run is 'interrupted — Resume to continue', and resume is refused for managed runs.
> 4. Try to delete the run (single or bulk).

**Expected:** The run can be settled with a usage receipt (or explicitly abandoned), and becomes deletable once its cycle has ended.

**Actual:** Delete refused: 'This mission cycle still needs its run history... Finish or stop the mission cycle, then try again' although the cycle has ended; Stop cycle is disabled. The launch is 'settled' without usage, so the full 8 calls/15 min stay charged. Observed for runs 2610251551-4a3b05b5 and 2610251603-fef8af3f; the deletion refusal was seen for the second.

**Root cause (verifier):** The steps that together make the run undeletable forever while its project exists:

1. src/engine.ts:3283-3300 (load): on restart the running managed run and its running step become "interrupted".
2. src/project-team-usage.ts:7 and :10 (terminalEvidence): status "interrupted" and interrupted agent steps are rejected on purpose (the invocation count of a killed turn is unknown), so persistProjectTeamUsage never returns a receipt.
3. src/project-teams.ts:316-327 (settle): the discovery is not "done", so the cycle is finished as "blocked" (it now has endedAt), and the launch is marked settled with usedCalls = l.calls (full charge) and no usage.
4. The run can never become terminal:
   - src/engine.ts:3169 managedContinuation blocks resume for projectTeam runs.
   - src/engine.ts:3514-3527 cancel() returns false when there is no controller.
   - stopCycle (src/project-teams.ts:399-403) does nothing because no cycle is active.
   - So reconcileUsage (src/project-teams.ts:289-302) can never attach a receipt.
5. src/project-teams.ts:69-71, the deletion guard: it requires launch.usage, so it refuses permanently. Its message ("Finish or stop the mission cycle, then try again") is wrong for  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-team-usage.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/project-teams.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`

**Suggested fix:** Keep the conservative full charge, which is documented. Make the dead end resolvable and the messages accurate:

1. Deletion guard (src/project-teams.ts:69): allow deletion when all of these hold:
   - the cycle has ended (endedAt set and not active),
   - the launch is settled,
   - and either launch.usage exists, or the run can no longer produce a receipt (e.g. run.status === "interrupted") and the team ledger already charges the full allocation (launch.usedCalls >= launch.calls).

   The team record already holds the charge, so deleting the run does not change accounting. Keep refusing a settled launch with partial usedCalls and no receipt; this is the existing "missing-usage" test case.

   Alternative: when settle() handles an interrupted run, write an explicit forfeit receipt ({calls: launch.calls, durationMs: launch.minutes*60000, forfeited: true}) so that budget and deletion both use one explicit record.
2. Split the guard message by state:
   - active cycle: "Finish or stop th …

**Suggested regression test:** Add a test to test/project-teams.test.ts: "discovery interrupted by a host restart can be deleted after its cycle ends while staying fully charged". A working version of the setup is in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4667m/test/v4667-interrupted-mission.test.ts.

Setup:
- fixture({mode:"propose"}) with process.env.FAKE_SLEEP_MS="3000".
- service.cycle().
- Wait until the agent step is running.
- service …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: v4667m on 127.0.0.1:4667, with FAKE_SLEEP_MS=4000 exported and confirmed in the process env. Its home was pre-seeded with projects.json only, so the user's live missions were not copied in. The repo was a scratch bare+work clone of MQTT-MCP.

Steps, all through the UI except where noted:
1. Added the clone as project "v4667 MQTT" (p-70ef9803).
2. Enabled project missions and created a propose-mode mission (pt-297679c65c7d35bd56030da8). Activated it and clicked "Run cycle now".
3. About 0.4s later the cycle was discovering, with run 2610252040-5d20698f running (agent step running). I then ran "qa-server.sh restart v4667m".

After the restart:
- The run is "interrupted": "code-flow was shut down while this run was in progress. Resume to continue." Its agent step is also interrupted.
- About 15s later reconcile changed cycle pc-72a8e86c0555fb07b792418d to "blocked" with the generic reason "Discovery did not produce an independently approved report at the pinned base". endedAt is set. The launch state is "settled" with usedCalls=8 and no usage receipt.
- The mission card shows "Rolling week: 8/48 calls used or reserved · 15/120 minutes (15 reserved)". "Stop cycle" is disabled.
- The run page offers an enabled "Resume work" button. Clicking it shows the alert "Continue this result through its project team so its scope, budget and independent review are preserved". The resume API returns 400 with the same text, and the cancel API returns {cancelled:false}.
- Single delete (More run actions > Delete… > Delete run) and bulk delete (rail Select runs > Select loaded > Delete…) both fail with 409: "This mission cycle still needs its run history for recovery or budget accounting. Finish or stop the mission cycle, then try again. You can archive the run meanwhile." I cannot follow that advice: the cycle has already ended and Stop is disabled. Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4667m/001-mission-card.png through 005-bulk-delete.png.

Two workarounds exist:
- Archive works.
- Deleting the whole project makes the run deletable (DELETE returned 200, which is documented). That is how I cleaned up.

I also reproduced it at unit level in my snapshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4667m/test/v4667-interrupted-mission.test.ts (passes, log in /privat …

</details>

### t12-10 · minor · Managed trigger stays enabled while missions are disabled; scheduler warns every tick and fires late on re-enable

**Continuation outcome:** Fixed. The feature and Auto team host gates disarm managed triggers and clear nextAt. Re-enabling schedules starts at the next future time without catch-up. A two-hour simulated disabled period has no cycles/events, and draft/paused/disabled Chrome previews have no next times.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-09, MIS-01.

**Repro**

> 1. Active mission, schedule 'Every N minutes' 5.
> 2. Disable project missions (no active cycle). triggers.json still has enabled:true and nextAt.
> 3. Wait past nextAt with CODEFLOW_SCHEDULER_TICK_MS=1000.
> 4. Re-enable within the hour.

**Expected:** Disabling the feature pauses managed triggers (or skips the occurrence once). No log flood.

**Actual:** server.log gets a 'Managed cycle admission failed; retaining the scheduled occurrence ... Enable Standing teams on a project page...' line every tick (53 in about 50s; 120/hour at the default 30s tick). After re-enable, the retained occurrence ran immediately (schedule:1792943307502 admitted about 1 minute late).

**Root cause (verifier):** 1. src/automation.ts:271 (Automations.syncProjectTeam): `const enabled = team.status === "active" && team.scheduleEnabled !== false`. The managed trigger's enabled flag ignores the host switch (ProjectTeams.enabled(), backed by project-teams/settings.json) and autoTeamEnabled(), so nextAt stays armed while the feature is off.
2. src/project-teams.ts:83-89 (ProjectTeams.setEnabled): it persists the switch through store.setEnabled but never calls automations.syncProjectTeam for existing teams. triggers.json keeps enabled:true and the old nextAt, unlike Pause or scheduleEnabled:false, which go through update() -> syncProjectTeam.
3. src/automation.ts:458-462 (tick, managed branch): when fire() throws (here from project-teams.ts:104 permitted(): "Enable Standing teams on a project page before running a cycle"), the catch logs a warning and does `continue` without advancing nextAt or saving. Every tick therefore re-attempts the same occurrence. Each attempt also goes through fireTracked (src/automation.ts:525-541), which records a new "failed" event and saves triggers.json. This repeats until stillDue (src/automation.ts:233, MISSED_GRACE_MS = 1h at :129) returns false. With interval sch …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/automation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/automation.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/project-teams.md`

**Suggested fix:** (a) Make host gating part of the managed projection. syncProjectTeam takes, or asks the managed hook for, hostEnabled = projectTeams.enabled() && autoTeamEnabled(), and sets enabled = hostEnabled && status === "active" && scheduleEnabled !== false. With the existing nextAt expression, a disabled trigger clears nextAt and re-enabling computes a fresh nextFire(now), the same as team Pause, so there is no catch-up of occurrences missed while the switch was off. In ProjectTeams.setEnabled, after store.setEnabled succeeds, re-sync every non-archived team inside the same serialize() block. Also re-sync once after load/start, so env defaults and CODEFLOW_AUTO_TEAM_ENABLED are reflected after a restart.
(b) Harden the tick retry path. For permanent or configuration refusals (host disabled, Auto team disabled, ProjectTeamConflict for membership or identity), skip the occurrence: set nextAt = nextFire(schedule, now), save, and log once at info level. If transient admission failures should still  …

**Suggested regression test:** test/project-teams.test.ts, new test "disabling Standing teams disarms managed schedules without flooding or catch-up". Use the fixture({mode:"propose"}), then update(schedule:{every:5}) and capture due = automations.get(triggerId).nextAt. Call service.setEnabled({enabled:false, revision:0}) and assert automations.get(triggerId).enabled === false (or nextAt === undefined). Loop automations.tick(now) from due to due + 2h in 30s steps; assert that server.log under CODEFLOW_HOME has zero "Managed c …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server "v4671m" on port 4671 with CODEFLOW_SCHEDULER_TICK_MS=1000. I seeded the home with projects.json only. I did not use the old "v4671" home: it held a copy of the user's live project-teams, including the active vibesboard mission, whose Sunday 21:04 occurrence was still inside the 1h grace. The project was a scratch clone of MQTT-MCP (bare clone plus working clone). All steps went through the UI with Playwright; scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4671m/.
1. s01-setup.mjs: Open another repository -> new project -> Pursue a mission -> Enable project missions -> Create a mission -> Save draft -> Activate -> card "Schedule and next times" -> Every 5 minutes -> Save schedule. triggers.json: {enabled:true, schedule:{every:5}, nextAt:20:47:16.828Z}.
2. s02-disable.mjs at 20:42:48Z, no cycles: clicked "Disable project missions". Settings became enabled:false (rev 2). triggers.json and GET /api/automations still showed enabled:true with nextAt 20:47:16.828Z. The preview warned "Enable Standing teams on a project page before running a cycle", but nextTimes still listed upcoming times. The card still showed "Recurring discovery enabled".
3. mon.mjs: 0 lines in server.log until nextAt. From 20:47:16.960Z there was one line per 1s tick, {"level":"warn","message":"Managed cycle admission failed; retaining the scheduled occurrence","error":"Enable Standing teams on a project page before running a cycle"}: 155 lines by 20:49:51Z. nextAt stayed frozen at 20:47:16.828Z. The trigger's eventHistory (capped at 100) held 99 identical "failed" events plus 1 start, so earlier history was pushed out. triggers.json was rewritten on every tick.
4. At 20:50:01Z I clicked "Enable project missions". On the first tick the retained occurrence was admitted as cycle "schedule:1792961236828" (= 20:47:16.828Z, about 2m44s late, created 20:50:01.196Z), and its discovery run 2610252050-00b7e110 ran and completed. nextAt then moved to 20:55:01Z.
5. Simulated-clock check in my snapshot copy (builds/v4671m/test/v4671m-disabled-schedule.test.ts, using the project-teams.test.ts fixture). Every-5-min mission, host switch off, Automations.tick(now) every 30s (the default tick) for 3 simulated hours. Cumulative warnings were 120, 230 and 340 at hours 1, 2 and 3, so the flood does not end after the 1h grace. Only 3 distinct nextAt values occurred, and the event history ended 100/1 …

</details>

### S08-4 · minor · When managed project-team cycle admission throws, tick logs a warning and continues without advancing nextAt, retrying every 30 s tick for the whole 1 h grace (about 120 warnings). While Standing teams is disabled, the managed trigger stays enabled.

**Continuation outcome:** Fixed with t12-10. Other refused admissions retain the same occurrence and event and retry no more than once per five minutes, with one warning. Twenty simulated minutes produced four attempts and one event; the existing catch-up grace logic remains intact.

Source: code-level suspect at `src/automation.ts:459` (confirmed hands-on).

**Repro**

> Focused test in snapshot builds/s08 (test/qa-s08-teams.test.ts, project-teams fixture). Create and activate a team with schedule Mon 09:00 Europe/Stockholm. service.setEnabled({enabled:false}), then reconcile(). The managed trigger t-<team> still reports enabled:true. Then automations.tick(now) every 30 s from nextAt+1s to nextAt+62min. Output: 124 ticks, 120 warnings 'Managed cycle admission failed; retaining the scheduled occurrence' (error 'Enable Standing teams on a project page before running a cycle') in server.log, and the automation's 100-entry event history entirely replaced by 'failed' events. nextAt only advanced after the grace expired.

**Expected:** A permanent admission failure (feature or auto-team disabled, team not admissible) records one failure per occurrence and skips or advances the occurrence. A disabled feature disables the managed trigger. Transient conflicts retry with a bounded backoff, not every tick.

**Actual:** About 120 warnings, 120 triggers.json writes and 120 'failed' events per occurrence. These evict all earlier event history (cap 100), and this repeats every scheduled occurrence while the feature stays off.

**Root cause (verifier):** In tick(), for t.target the catch block does `logWarn(...); continue;` before `t.nextAt = nextFire(...)`, so the same occurrence is due again on the next 30 s tick until stillDue() fails after MISSED_GRACE_MS. Each attempt goes through fireTracked, which records a new 'failed' AutomationEvent and saves triggers.json. syncProjectTeam derives `enabled` only from team.status/scheduleEnabled and ignores the global feature flag. ProjectTeams.reconcile skips syncProjectTeam when !this.enabled(). So disabling Standing teams (allowed when no cycle is active) leaves the trigger enabled, and every occurrence fails with 'Enable Standing teams on a project page before running a cycle'.

**Suggested fix:** (a) Include the feature flags in the managed trigger's enabled state: either syncProjectTeam receives enabled && projectTeamsEnabled && autoTeamEnabled, or reconcile calls syncProjectTeam even when the feature is disabled. (b) In tick(), classify admission errors: for non-retryable ones (disabled, not active, missing base branch) advance nextAt and log once. For conflicts ('cycle already active') keep the occurrence but store a per-trigger retryAt with backoff, and reuse a single event record keyed by occurrence instead of recording a new one per attempt.

**Suggested regression test:** Extend test/project-teams.test.ts: disable Standing teams with a scheduled team and tick every 30 s through the grace window. Assert at most one failed event and one warning for the occurrence, that the managed trigger is disabled (or nextAt advanced), and that earlier event history is preserved.

### t12-13 · minor · Missing base branch shows a raw git command error

**Continuation outcome:** Fixed. Missing base branches produce a named, actionable message on create/edit, preview and cycle; failed edits leave the saved branch unchanged. Browser edit returns the expected 400 with that inline message; service tests cover preview/cycle too.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-02, MIS-04.

**Repro**

> (a) Create a mission with Base branch 'does-not-exist'; or (b) rename the clone's main and click Preview next cycle or Run cycle now.

**Expected:** A message like 'Base branch "main" does not exist in <repo>'.

**Actual:** 'git rev-parse --verify refs/heads/does-not-exist^{commit} failed: fatal: Needed a single revision' in the form alert, preview and toast.

**Root cause (verifier):** src/project-teams.ts:113 (`ProjectTeams.pin`) calls `resolveCommit(t.repo, \`refs/heads/${t.mission.baseBranch}\`)` without catching the error. resolveCommit (src/git.ts:282-284) uses gitOk, which throws `gitError(args, res)` (src/git.ts:176-179): the raw "git rev-parse --verify refs/heads/X^{commit} failed: fatal: Needed a single revision" text.

pin() is called from create (src/project-teams.ts:125, the form alert), preview (:159, which pushes e.message into warnings), cycle (:172, the Run cycle now toast and the 400 API error), launch (:191, which becomes a blocked cycle's `reason` in cycle history when a scheduled or queued launch hits it), decide build/revise (:361) and give-task (:387). Every one of these surfaces the raw git text.

The UI displays the message as-is (ui/project-teams.tsx:76 setError, :125 showToast, :126 preview.warnings). Separately, update() (src/project-teams.ts:131-155) runs validateMission but never resolves the base branch, so Edit mission silently accepts a branch that doesn't exist. The engine's equivalent path (src/engine.ts:5166-5168) already maps this failure to `Base branch "X" not found in <repo>`.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`

**Suggested fix:** In ProjectTeams.pin (src/project-teams.ts:113), wrap the lookup the same way the engine does:
`const base = await resolveCommit(t.repo, \`refs/heads/${t.mission.baseBranch}\`).catch(() => { throw new Error(\`Base branch "${t.mission.baseBranch}" does not exist in ${t.repo}. Create it locally or edit the mission's base branch.\`); });`

Optionally, use `git show-ref --verify --quiet refs/heads/<b>` first, so that only a missing branch gets the friendly text and real git failures (corrupt repo, lock) keep their detail. Because all six callers (create, preview, cycle, launch reason, build/revise, give task) go through pin(), this one change fixes every surface.

Also consider resolving the base branch in update() when the mission's baseBranch changes. That would make Edit mission refuse a missing branch the way create does, instead of saving it and failing only at preview or cycle time. Keep the message free of git syntax. The repo path is already shown on the mission card, so the repo na …

**Suggested regression test:** In test/project-teams.test.ts, using the existing `fixture()` helper:
1. `await assert.rejects(teams.create({ ...valid, mission: mission({ baseBranch: "does-not-exist" }) }), (e) => /Base branch "does-not-exist" does not exist/.test(e.message) && !/rev-parse|fatal:/.test(e.message))`.
2. Create and activate a team on "main", then run `f.git("branch", "-m", "main", "trunk")`. Assert that `(await teams.preview(id)).warnings` contains a message matching /Base branch "main" does not exist/ and that  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4677t1213" on 127.0.0.1:4677, with new home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4677t1213 and a fresh browser profile. I made a scratch bare and working clone of MQTT-MCP (only local branch: main) and added it through the UI ("Open another repository" -> new project "v4677 base-branch", id p-656a8831). Project missions were already enabled in the copied settings.

(a) In the UI I opened Project -> Automation -> missions -> Create a mission, filled in Mission, Intended users and Required check ("node -e 0"), set Base branch to "does-not-exist" and clicked Save draft mission. The form alert read exactly: "git rev-parse --verify refs/heads/does-not-exist^{commit} failed: fatal: Needed a single revision". No team was created. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4677t1213/002-a-form-alert-visible.png.

(b) I saved the mission with base "main", activated it and clicked Preview next cycle, which showed "Ready to discover". Then I ran `git branch -m main main-renamed` in the scratch clone.
- Preview next cycle now showed "Not ready" plus "git rev-parse --verify refs/heads/main^{commit} failed: fatal: Needed a single revision".
- Run cycle now showed the same text as a toast. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4677t1213/003-b-run-cycle-toast.png.
- POST /api/project-teams/:id/cycle returned 400 with the same error, and GET /preview returned it as a warning. No cycle or run was created.

Extra finding: editing an existing mission over the API (POST /api/project-teams/:id) to baseBranch "does-not-exist" is accepted (200, stored). Only the next preview shows the raw error, because update() never resolves the branch, while create() refuses it.

Ruling out alternatives:
- Not the tester's environment. The first attempt showed two unrelated "Mission storage needs repair" alerts, which came from the user's mission files that the harness copies into a fresh home. I moved those out of my own QA home, restarted, and the exact raw git message still appeared with no other alerts.
- Not by design. docs/project-teams.md only says "named local base branch" and says nothing about the error text. The engine already turns the same failure into a friendly message at src/en …

</details>

### t12-14 · minor · Preview lists 'Next runs' dates for draft and paused missions that will not run

**Continuation outcome:** Fixed. Draft, paused and host-disabled missions return no nextTimes and explain what enables scheduling. The browser exercises draft, paused and disabled previews; service tests also exercise the Auto team gate.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-04.

**Repro**

> Create a draft mission (recurring discovery on), then click Preview next cycle; or Pause an active mission and preview.

**Expected:** No upcoming run times while draft or paused (the trigger is disabled), or a note that they apply after activation.

**Actual:** 'Not ready · Activate this team...' followed by 'Next runs in Europe/Stockholm: Mon, Oct 26 09:00...' (5 dates).

**Root cause (verifier):** The server and the UI each decide whether to show times using only scheduleEnabled. Neither checks the team status, whereas the real trigger state does:
- src/automation.ts:271 (syncProjectTeam): `const enabled = team.status === "active" && team.scheduleEnabled !== false`. Draft and paused teams get enabled:false and nextAt undefined.
- src/project-teams.ts:163 (ProjectTeamService.preview): `nextTimes: t.scheduleEnabled === false ? [] : previewSchedule(t.schedule ?? t.mission.schedule)`. It ignores t.status, so a draft or paused team returns 5 future times.
- ui/project-teams.tsx:126 (TeamCard preview box): `{t.scheduleEnabled !== false && <SchedulePreview schedule={t.schedule ?? t.mission.schedule} />}`. It renders SchedulePreview, titled "Next runs in <tz>:", for any status. It also does not use preview.nextTimes: SchedulePreview fetches its own times from /api/automations/schedule-preview (ui/automations.tsx:67-79). A server-only fix would therefore leave the UI bug in place.
- Related wording: ui/project-teams.tsx:121 shows "Recurring discovery enabled" for draft and paused teams, which reinforces the impression that the mission will run.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/automation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-teams.e2e.ts`

**Suggested fix:** 1. Add one shared predicate, e.g. `export const projectTeamScheduleLive = (t) => t.status === "active" && t.scheduleEnabled !== false`. Use it in Automations.syncProjectTeam (src/automation.ts:271) and in ProjectTeamService.preview (src/project-teams.ts:163): `nextTimes: projectTeamScheduleLive(t) ? previewSchedule(...) : []`.
2. In ui/project-teams.tsx:126, render the "Next runs" list only when `t.status === "active" && t.scheduleEnabled !== false`. Better still, render it from `preview.nextTimes` so the server and UI cannot drift. For draft or paused teams with recurring discovery on, show a short note instead, e.g. "Recurring discovery is off while this mission is paused (draft: not yet activated). Schedule: Mon at 09:00 (Europe/Stockholm); runs start after activation." The schedule text can reuse the existing schedule description helper.
3. Optionally change line 121's "Recurring discovery enabled" to "Recurring discovery on after activation" or "... (paused)" when status is not ac …

**Suggested regression test:** Unit test in test/project-teams.test.ts using the existing fixture (f.service / f.team, created as draft with recurring discovery on). Assert `(await f.service.preview(f.team.id)).nextTimes` deepEquals [] while draft. Update to status "active" and assert nextTimes has length 5 and nextTimes[0] equals the managed trigger's nextAt. Update to status "paused" and assert nextTimes is [] again, with the warning "Activate this team before starting a cycle" still present. E2E in test/e2e/project-teams.e …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4679 on 127.0.0.1:4679. The home name had been used before, so I moved that old home aside and started again. Two user mission records (pt-*.json) were copied into the home from ~/.codeflow. They faulted with "Repository metadata was replaced" and blocked team creation, which is an environment problem unrelated to this issue. I moved them to /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4679/pt-aside and restarted. I made a scratch clone of MQTT-MCP (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4679-mqtt) and added it through the UI ("Open another repository" -> new project "v4679 MQTT", p-c67bc9a4). In Automation -> missions, Create a mission: proposals only, "Run recurring discovery" left on (the default for a custom team), Save draft mission. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4679/r1.mjs; log: r1.log in the same folder.
Results:
(1) DRAFT, Preview next cycle. triggers.json has the managed trigger at {enabled:false} with no nextAt. The API preview returns ready=false, warnings=["Activate this team before starting a cycle"] and 5 nextTimes. The status box shows "Not ready / Activate this team before starting a cycle / Next runs in Europe/Stockholm: Mon, Oct 26, 2026, 09:00 ... Mon, Nov 23" (5 dates).
(2) Activate, Preview. Trigger is {enabled:true, nextAt:2026-10-26T08:00Z}, "Ready to discover", same 5 dates. This is correct.
(3) Pause, Preview. Trigger goes back to {enabled:false} with no nextAt, yet the UI again shows "Not ready" plus the 5 "Next runs" dates (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4679/003-preview-paused.png). The same card also says "Recurring discovery enabled".
(4) Control: still paused, unticked "Run recurring discovery". nextTimes=[] and no dates are rendered. So the existing gate only checks scheduleEnabled, never status.
No console errors or 5xx. The issue reproduces exactly as reported.
Why I don't treat it as by design: docs/project-teams-implementation-plan.md:70 says "Setup previews the next runs". That is already covered by the ScheduleEditor inside the create/edit form. docs/project-teams.md says "Pause prevents new cycles". The generic Automations list  …

</details>

### t12-16 · cosmetic · User-facing errors and labels still say 'Standing team(s)' while the UI calls them 'Project missions'

**Continuation outcome:** Fixed. User-facing managed errors, trigger labels, run banners and continuation guidance use Project mission. Existing unit and browser assertions were updated for the intended copy change.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-01.

**Repro**

> Trigger any of: a stale settings toggle; Run cycle with the feature off; a duplicate mission; merge before approval; the managed run page banner.

**Expected:** Consistent 'project mission' terminology.

**Actual:** 'Standing teams settings changed', 'Enable Standing teams on a project page...', 'This repository already has a standing team', 'Approve this exact result in its standing team...', 'Standing team storage is unavailable', 'Edit this automation through its standing project team', 'Standing team implementation' banner, and the inbox title 'Project team opportunities'.

**Root cause (verifier):** The feature was renamed for users in e211862 (#38): docs/project-teams.md and the ui/project-teams.tsx headings and buttons now say "Project missions". The server-side error strings and two UI labels still use the old "Standing team(s)" name, so the message text is passed straight to alerts and toasts:
- src/project-team-store.ts:70 "Standing teams settings changed. Reload before trying again." (also :69 "Repair Standing teams settings…", :31/:33/:36 settings-file errors)
- src/project-team-store.ts:86 "Standing team storage is unavailable: …"
- src/project-team-store.ts:106 "This repository already has a standing team (including its linked worktrees)"
- src/project-team-store.ts:125 "Standing team history exceeds its storage limit"
- src/project-teams.ts:86 "Stop active or unresolved standing-team cycles before disabling Standing teams"
- src/project-teams.ts:104 "Enable Standing teams on a project page before running a cycle". This is also hit by create() via permitted(), so a stale "Create a mission" gets a message about "running a cycle".
- src/project-teams.ts:84/:118 closed() labels "Standing teams settings" / "standing team"
- src/project-teams.ts:246 "Approve this exact res …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-team-store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/automation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-team-model.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/auto-team.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/notifications.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-teams.e2e.ts`

**Suggested fix:** Rewrite every user-visible string to the "project mission(s)" wording the docs and UI already use. Keep the internal identifiers as they are: ProjectTeam types, the /api/project-teams paths, the .standing-teams CSS class, and the pt-/t- IDs. Suggested replacements:
- "Project mission settings changed. Reload before trying again."
- "Repair project mission settings before changing them"
- "Enable project missions on a project page before creating or running a mission". This one also covers the create() path that shares permitted().
- "Stop active or unresolved mission cycles before disabling project missions"
- "This repository already has a project mission (including its linked worktrees)"
- "Approve this exact result in its project mission before publishing or merging"
- "Project mission storage is unavailable: …"
- "Edit (Archive) this automation from its project mission"
- "Use the project mission's revision controls for managed runs"
- Policy surface "Project missions"; "Project mi …

**Suggested regression test:** Three layers:
- test/project-teams.test.ts: add a "user-facing errors use project mission terminology" test on the existing fixture. Trigger a stale setEnabled revision, cycle() with the feature disabled, a duplicate create() for the same repo, the shipping guard on an unapproved result, and automations.update()/remove() on the t-<teamId> trigger. Assert every rejection matches /project mission/i and none matches /standing/i.
- test/e2e/project-teams.e2e.ts: change the run-page assertion to getB …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4683t1216 on port 4683, with a new home. The harness had copied the user's two pt-*.json mission records into that home. They showed up as damaged ("Repository metadata was replaced") and blocked creating any mission, so I moved them to $HOME/pt-copied-backup inside my QA home only and restarted. I made a scratch git-init fixture repo (README "Empty input is valid.", check.mjs, .codeflow prove:false) and added it through the UI ("Open another repository", then new project "v4683 PT", p-bfdfe4b7). Then I drove each path with Playwright scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4683t1216/s1.mjs, s2.mjs and s3.mjs (logs s1.log, s2.log, s3.log).
1) The missions page heading is "Project missions" and the toggle reads "Enable/Disable project missions".
2) Stale toggle: I opened a second browser with /api/stream blocked. Tab A disabled the feature, then tab B clicked "Disable project missions". The alert read "Standing teams settings changed. Reload before trying again." It appeared in the same card headed "Project missions", next to the UI's own "Mission storage needs repair (...)" alerts.
3) Duplicate mission: I created a mission with "Save draft mission", then a second one for the same repo. The inline error read "This repository already has a standing team (including its linked worktrees)" (screenshot 001-duplicate-mission.png).
4) Run cycle with the feature off: I activated the mission and opened stale tab B, where "Run cycle now" was still enabled. Tab A disabled the feature and tab B clicked "Run cycle now". The toast read "Enable Standing teams on a project page before running a cycle". No button with that name exists; the real one is "Enable project missions".
5) I re-enabled the feature and clicked "Run cycle now". The fake agents produced a ready result (run 2610252049-151007b4). The project overview and #/inbox both showed the heading "Project team opportunities".
6) The managed run page banner read "Standing team implementation · Review the opportunity, approve this result, ..." (screenshot 004-run-banner.png).
7) Merge before approval: on the run page I used Actions > Merge…, unticked "Require verification", and clicked "Merge into main". The toast read "Approve this exact result in its standing team before publishing or merging" and scratch main was unchanged (screenshot 001-merge-toast.png).
8) API-only paths (the Sch …

</details>

### t12-17 · minor · Managed run page: raw mission JSON in the task, a composer that is always refused, and a banner link to the project overview

**Continuation outcome:** Fixed. Managed tasks render the owner summary, criteria and expandable mission limits; raw agent context remains stored for execution. Mission links open the missions section, and a managed-run note replaces the unavailable continuation composer. Browser checks readable task text, deep-link destination and absent composer; malformed historical context is covered by a unit regression.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-13.

**Repro**

> Open a mission implementation run (#/run/<id>).

**Expected:** A readable task summary. No writer composer, or one labelled as disabled. The banner link goes to the mission (#/project/<id>/automation/missions).

**Actual:** The task bubble shows the entire owner mission and constraints as one JSON blob. The 'Tell the team what to change…' composer accepts text, and sending gives the toast 'Managed continuations must use the project-team service'. The banner link goes to #/project/<id> (overview).

**Root cause (verifier):** 1) Raw JSON in the task. src/project-teams.ts:199-200 (launch) builds `context` as "\nOwner mission and constraints:\n" + JSON.stringify(m) + a <project_evidence> JSON block. It then passes `task: task + context`, so the prompt only the agent needs is stored as run.task. ui/run.tsx:294 (`<BrowserMessage text={run.task} />` in the .msg-you bubble) shows run.task as it is, and nothing special-cases run.projectTeam. The owner's instructions are only inside the escaped `history` JSON string (c.context).

2) Banner link. ui/run.tsx:237 has `href={`#/project/${run.project}`}`, which opens the project overview, not the missions page. The same mistake is at ui/review.tsx:206 ("Use mission revision controls"), and ui/experience.tsx:83 navigates to { view: "project", id }.

3) Composer. ui/run.tsx:400 always mounts `<ConversationBar ...>`. ConversationBar (ui/run.tsx:1771ff) has no run.projectTeam guard. When a run has finished it defaults to chosen === "team" (placeholder at ui/run.tsx:1919), and send() at ui/run.tsx:1852-1872 POSTs /api/runs with parentRunId. The engine then rejects it at src/engine.ts:5100 ("Managed continuations must use the project-team service"). The writer-session opt …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/review.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-teams.e2e.ts`

**Suggested fix:** Banner link: point ui/run.tsx:237 at hashFor({ view: "project", id: run.project, section: "automation", kind: "missions" }), the same route editAndRerun and project.tsx:69 use. Apply the same change to ui/review.tsx:206 and ui/experience.tsx:83.

Composer: in ConversationBar, when run.projectTeam is set and the run has finished, render a short read-only note in place of the textarea, To-picker and budget, for example "This result belongs to the project mission. Approve, request a revision or reject it in Project missions →" linking to the missions route. While the run is in progress, either keep note delivery (addNote is allowed) or hide it too to match the mission policy, but in neither state offer "Whole team · new run", writer replies or revise-goal.

Task text: keep run.task as the human summary (task + owner title/instructions/acceptance) and pass the mission and evidence block to agents separately. One way is a new field such as input.projectTeam.brief (or a hidden prompt-context …

**Suggested regression test:** Extend test/e2e/project-teams.e2e.ts, in the first test right after it opens `${base}/#/run/${resultId}` and waits for /Standing team implementation/ (around lines 126-127). Assert all of the following:
(1) the banner link's href ends with `#/project/${projectId}/automation/missions`;
(2) the main conversation has no enabled textbox named "Reply" and no "Who gets this" select, or the textbox is disabled and a link to the missions route is visible;
(3) the `.msg-you .run-task` text contains no "O …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: qa-server.sh start v4685m 4685 fake. Its home was seeded with projects.json only, without copying the user's project-teams. I made a scratch clone of MQTT-MCP at clones/v4685m-mqtt (plus a .git bare repo), with a committed check.mjs that runs process.exit(0) and .codeflow/config.json set to {"prove":false}.

Everything below was done through the UI in headless Chrome (scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4685m/setup.mjs and verify.mjs).
1. Added the clone through "Open another repository" as the new project "v4685m MQTT" (p-078342e3).
2. Under Project > Automation > Missions: enabled project missions, created a mission with required check "node check.mjs", activated it, then used "Give team a task" > "Start assigned task". The implementation run 2610252046-8c481ed8 completed and the opportunity became "ready".
3. Opened Cycle history > "Open team run", which went to #/run/2610252046-8c481ed8 (status done, projectTeam.phase = implementation).

What I saw (log in verify.log; screenshots in shots/v4685m/001-task-bubble.png and 003-after-send.png):
(a) Task bubble, 2195 characters: the short instruction, then "Owner mission and constraints:" followed by the whole mission as one JSON line (coordinator, pool, trust, verification, schedule, budget, ...). After that comes the "Historical evidence..." text and a <project_evidence> block. The owner's own instructions ("Add a short example of valid empty input to the README.") appear only inside that block, as escaped JSON within JSON.
(b) Banner: "Standing team implementation · Review the opportunity, approve this result, or request a bounded team revision". The link href is #/project/p-078342e3. Clicking it opens the project overview ("What would you like to work on?"), not the missions page. The overview does show a "Project team opportunities" card, so the missions page is one more click away.
(c) Composer: the textarea is enabled, its placeholder is "Tell the team what to change…", "To" defaults to "Whole team · new run", and the budget summary shows "New execution budget · 16 calls · 45 min". Typing and pressing Enter gives the toast "Managed continuations must use the project-team service", and no run is created (1 run before, 1 after). Switching "To" to the writer session "Claude Code · auto-alpha" and sending gives the toast "Continue this result through its project team so its …

</details>

### t12-24 · cosmetic · Stop cycle API succeeds and records an operation when no cycle is active

**Continuation outcome:** Fixed. Idle stop returns 409 without changing revision or recording an operation. Replaying a successful stop remains idempotent. Both service and HTTP regressions pass.

Source: tester unit project-missions-1; observed with api; features MIS-06.

**Repro**

> POST /api/project-teams/<id>/stop {operationId, revision} with no active cycle.

**Expected:** 409 'No active cycle', or a no-op without a revision bump.

**Actual:** 200; team revision bumped (41→42) and an operation receipt is written.

**Root cause (verifier):** src/project-teams.ts:399-405 (`stopCycle`). After `closed()`, `permitted()` and the archived check, the method calls `this.store.change(id, this.revision(r.revision), operation(r.operationId, { action: "stop" }), mutator)` with no check that a cycle is active. Inside the mutator, `const c = active(t); if (c) { … }` turns the missing cycle into a silent no-op instead of refusing.

`ProjectTeamStore.change` (src/project-team-store.ts:110-121) then always runs `team.revision++; team.updatedAt = Date.now(); team.operations.push({...operation, at})`, saves and publishes, whether or not the mutator changed anything. The result is a 200 response, a new revision and a durable operation receipt for an action that did nothing.

A secondary looseness at src/project-teams.ts:403: the follow-up loop `for (const c of next.cycles.filter((c) => c.status === "cancelled"))` re-issues `manager.cancel` for every earlier cancelled cycle's unsettled launches on every stop call, not just the cycle this call cancelled. It is harmless in practice, but it hides that this call stopped nothing.

ACTIVE_CYCLES (src/project-team-model.ts:157) already includes "unknown", so refusing when `active(t)` is undefined …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/project-teams.md`

**Suggested fix:** In `stopCycle` (src/project-teams.ts:399), follow the same pattern as `assignTask`/`decide`:
1. Build `op = operation(r.operationId, { action: "stop" })`.
2. Look for an existing receipt with `t.operations.find(v => v.id === op.id)`. If one exists, return `t` when the hashes match (this keeps the replay of a successful stop idempotent after the cycle has ended) and throw ProjectTeamConflict on a hash mismatch.
3. Keep the archived check.
4. Add `if (!active(t)) throw new ProjectTeamConflict("No active cycle to stop")`, which returns 409.
5. Inside the store.change mutator, re-check `active(t)` and throw the same conflict if it is gone, which covers a reconcile write that lands in between. The mutator throws before `revision++`, so nothing is saved.
6. Narrow the follow-up cancel loop to the cycle this call cancelled. Capture `const stopped = active(t)!.id` and cancel only `next.cycles.find(c => c.id === stopped)` launches, instead of every cancelled cycle.

Optionally, add one line to  …

**Suggested regression test:** Add a test to test/project-teams.test.ts, next to "stopping implementation retains its claim…", called "stopping without an active cycle is refused and leaves no receipt":
1. Create `const f = await fixture()` and set `const t = f.store.get(f.team.id)`, so there are no cycles.
2. `await assert.rejects(f.service.stopCycle(t.id, { operationId: "stop-idle", revision: t.revision }), (e) => e.status === 409 && /No active cycle/.test(e.message))`.
3. Assert `f.store.get(t.id).revision === t.revision`  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server with `qa-server.sh start v4603s 4603 fake`. Its home was pre-seeded with projects.json only, so none of the user's project-team records were copied in. I made a one-commit scratch git repo (scratchpad/qa/clones/v4603-mini) and added it through the UI ("Open another repository" -> new project "v4603 mini"). Through the API I enabled project missions, created a propose-mode team pt-3e8f0d7d92f71e16976882af and activated it. Script: scratchpad/qa/work/v4603/stop-idle.mjs; log: scratchpad/qa/work/v4603/stop-idle.log.

Results:
(0) UI: on the idle team card, "Stop cycle" is rendered disabled (`Stop cycle(disabled)`), so the UI cannot send this request.
(A) Team that never had a cycle: POST /api/project-teams/<id>/stop {operationId, revision:2} -> 200. Revision went 2 -> 3, operations went 2 -> 3, and a new receipt {id:"v4603-stopA-…", hash, at} was written.
(B) Ran a cycle with the UI "Run cycle now" button until it reached `completed` ("Proposals are ready for owner review"). Then POST stop with the current revision -> 200. Revision went 8 -> 9, operations 4 -> 5, and the cycles array was byte-identical before and after.
(C) Replaying the same operationId -> 200, revision still 9 (the idempotent replay works).
(D) Idle stop with a stale revision -> 409 "This team changed. Reload before acting."
No console or 5xx errors. The reporter's observation (200, revision 41->42, receipt written) is reproduced.

Why this is not by design: docs/project-teams.md:61 says only "**Stop cycle** cancels owned work", and the API table at :102 says "Stop owned cycle with revision". Nothing documents a no-op stop that bumps the revision. Sibling commands refuse when the precondition doesn't hold: assignTask throws ProjectTeamConflict when a cycle is active, and decide checks state first.

Why only cosmetic: the UI disables the button when idle. The click-after-the-cycle-finished race also gets a 409, because finishing a cycle bumps the revision. So only direct API clients can hit this. The side effects:
- a spurious revision bump, so a concurrent editor gets "This team changed"
- a published team event
- one of the 2,000 operation receipts (PT_LIMITS.operations) consumed; when that limit is reached, saving the team fails with "history is full; archive this team"

No cycle, opportunity or budget data changes.

Cleanup: deleted run 2610252052-9c956f72 through the run page's More run actions -> Delete… (GET now returns 404), stopped server v4603s …

</details>

### S07-3 · minor · stopCycle cancels runs for every cancelled cycle with non-settled launches (including older cycles), and succeeds and bumps the team revision when no cycle is active.

**Continuation outcome:** Fixed with t12-24. Stop captures the active cycle and cancels only its unsettled launches, leaving older cancelled-cycle runs alone. The targeted regression retains an older unresolved cancelled launch, starts another cycle and asserts that only the current run is cancelled; existing stop/accounting tests also pass.

Source: code-level suspect at `src/project-teams.ts:403` (confirmed hands-on).

**Repro**

> Focused test in my snapshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/s07/test/s07-stopcycle.test.ts (fixture copied from test/project-teams.test.ts), run with npx tsx --test. Steps: run cycle A, stop it while discovering, let it settle, then mark A's launch unsettled ('unknown', no usage receipt, the state docs describe for ambiguous launches). Then call stopCycle with no active cycle. Output: 'no-active stop: revision 8 -> 9 active cycles: 0'; manager.cancel was called with cycle A's run id (already status 'cancelled'), and a workspace-stop event fired for that run, which in server.ts:240 calls launchProfiles.stopMatching(`${runId}/`). In normal flows A's launch becomes 'settled' after the run ends, so the sweep only hits the window before settlement or permanently unknown launches. The UI disables 'Stop cycle' when nothing is running (ui/project-teams.tsx:125), so the no-op path needs the API or a stale second tab.

**Expected:** Stop with no active cycle is rejected (ProjectTeamConflict, like assignTask/cycle) without bumping the revision. Stop cancels only the launches of the cycle it just stopped.

**Actual:** A no-op stop succeeds, records the operation and increments the revision, so other tabs get 'This team changed. Reload before acting.'. Every call re-issues manager.cancel for all unsettled launches of every historical cancelled cycle, which also emits workspace-stop for those old runs.

**Root cause (verifier):** stopCycle passes an update that does nothing when active(t) is undefined, but store.change always increments revision. Afterwards it loops over next.cycles.filter(c => c.status === 'cancelled') instead of the cycle it just finished.

**Suggested fix:** Read c = active(t) before store.change and throw ProjectTeamConflict('No active cycle to stop') if there is none. Keep c.id and cancel only `next.cycles.find(v => v.id === c.id).launches`. If a retry sweep for older cancelled cycles is wanted, do it in reconcile() for runs that are actually still running.

**Suggested regression test:** Extend test/project-teams.test.ts: (a) stopCycle with no active cycle rejects with /No active cycle/ and leaves the revision unchanged; (b) with an older cancelled cycle holding an unsettled launch, stopping a new active cycle calls manager.cancel only with the new cycle's run ids (spy on manager.cancel).

### t12-20 · minor · project-teams e2e flaky: unhandledRejection from the /api/models route handler during the in-test server restart

**Continuation outcome:** Fixed. The existing /api/models route handler handles connection reset and closed-page errors during its deliberate server restart. All four original browser scenarios pass twice with forced 1.5-second provider catalog latency and no unhandledRejection.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-23.

**Repro**

> In a snapshot: npx tsx --test test/e2e/project-teams.e2e.ts (repeat).

**Expected:** Stable pass.

**Actual:** Run 1: subtests 4/4 ok, but the file failed with 'route.fetch: socket hang up (ECONNRESET) ... GET /api/models ... triggered an unhandledRejection'. Run 2: pass.

**Root cause (verifier):** The `/api/models` route handler added at test/e2e/project-teams.e2e.ts:66-70 calls `await route.fetch()` and `response.json()` without catching errors. The page's initial GET /api/models (ui/main.tsx:112 and ui/project-teams.tsx:70 → ui/state.ts:863) is answered by src/server.ts:2400-2408. On a fresh process the model catalog cache is cold (src/adapters/index.ts:43-50), so that handler spawns the fake claude, codex and agy CLIs for discovery, which normally takes about 150-350 ms. Test 1 enables missions and then calls `stopServer(); startServer()` at line 78, roughly 300 ms after that request started. On SIGTERM, src/server.ts:2919-2963 stop() runs server.close() and then process.exit() without draining in-flight requests, so the open /api/models socket is reset and route.fetch rejects with ECONNRESET. In playwright-core 1.64.1 (lib/coreBundle.js:61681-61689 RouteHandler._handleInternal, 61650-61664 _handleImpl, 62955-62975 Page._onRoute, 62914 `this._channel.on("route", ...)`), the handler's rejection passes up through Page._onRoute into a channel event listener that has no catch. The result is a process-level unhandledRejection. node:test attributes it to the `before` hook, beca …

**Files:** `test/e2e/project-teams.e2e.ts`, `test/fake-agent.mjs`

**Suggested fix:** This is a test-only fix; no product code changes. In test/e2e/project-teams.e2e.ts:66-70, make the catalog-rewriting route handler tolerate the fixture restart:
```ts
await page.route("**/api/models", async route => {
  // The fixture server restarts below; a catalog request in flight then fails as it would without the route.
  const response = await route.fetch().catch(() => null);
  if (!response) { await route.abort("connectionreset").catch(() => {}); return; }
  const catalogs = await response.json();
  catalogs.claude.models = [...];
  await route.fulfill({ response, json: catalogs });
});
```
I verified this exact patch in my snapshot: it passes 2 of 2 under forced slow discovery, where the original fails 2 of 2. Alternatives: call `await page.unrouteAll({ behavior: "ignoreErrors" })` before `stopServer()` and re-register the route afterwards, or wait for the first /api/models response before restarting. The second only narrows the race, because the page reloads and fetches the c …

**Suggested regression test:** Make the race happen on every run in test/e2e/project-teams.e2e.ts. Add a `FAKE_DISCOVERY_DELAY_MS` knob to test/fake-agent.mjs that sleeps before answering model discovery (claude control_request, `codex debug models`, `agy models`). Pass it (for example 1500) in the first startServer() env, so a /api/models request is always open when stopServer() runs at line 78. The guarded handler then runs its error path on every run, and the existing file-level pass (no 'triggered an unhandledRejection' f …

<details><summary>Verifier's independent reproduction</summary>

I made my own snapshot (qa-server.sh snapshot v4691 → /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4691). The test starts its own fixture server, so no QA server was needed and none was started.

1) Unmodified file, 5 runs in a row: `npx tsx --test test/e2e/project-teams.e2e.ts` (loop.sh; logs at .../work/v4691/run1..5.log, summary.txt). Run 1: all 4 subtests ok, but the file failed with the same error as the report: `Test hook "before" at test/e2e/project-teams.e2e.ts:36:1 generated asynchronous activity after the test ended ... "Error: route.fetch: socket hang up (ECONNRESET) ... GET http://localhost:64244/api/models" ... triggered an unhandledRejection event`. Runs 2-5 passed. That is 1 failure in 5, matching the reporter's 1 in 2.

2) Timing, measured with an instrumented copy that logs route.fetch start/done and the moment stopServer() is called (project-teams-instr.e2e.ts, test 1 only, 3 runs, instr1-3.log). /api/models on the cold server finished about 156-164 ms after it started, and stopServer() ran about 310-330 ms after it started. So the margin is only about 150 ms. Any slowdown in discovery (cold start, CPU load) leaves the request open when SIGTERM arrives.

3) Forced reproduction. I added a wrapper fake-bin dir to my snapshot (test/fake-bin-slow) whose `codex debug models` sleeps 1.5 s, then ran test 1 with it. Original handler (project-teams-slow-orig.e2e.ts): failed 2 of 2 with `[instr] stopServer at ...` followed by `route.fetch FAILED after 225ms / 342ms: socket hang up (ECONNRESET)` and the unhandledRejection file failure. Patched handler (project-teams-slow-fixed.e2e.ts, catches the fetch error and aborts the route): passed 2 of 2 with no unhandledRejection.

Refutation checks: this is not by design, since nothing in the docs or comments expects it and the test's own comment at lines 79-80 shows it means to tolerate the restart. It is not caused by the environment or the tester's script: the failure is in the repo's own e2e file, and I reproduced it on a separate snapshot. The product itself behaves correctly: ui/state.ts:861-866 loadModels() catches the failed fetch and sets catalogs to {}, then reloads after the restart.

</details>
