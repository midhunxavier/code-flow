# Cluster 38 · collab-task-permissions

**Team board tasks: concurrent edit overwrite, role checks, self-review, viewer UI**

Status: **fixed and verified** · 7 issues · branch `codex/qa-collab-task-permissions`

Planner notes: t13-1 (major): ui/collab-task.tsx:74 builds each save from the live task, which every stream frame replaces. The save therefore sends the latest revision and silently overwrites a teammate's change. Capture the revision the edit started from so that src/collab/store.ts returns 409. t13-8/S06-5: decideInstruction (src/collab/store.ts:471) lets a downgraded owner approve; require at least contributor, as offerHandoff does. t13-19: an owner can request a review from themselves and approve their own checkpoint. t13-16: the decision limit message says 'remove some', but decisions can't be removed (pushBounded in model.ts). t13-18: viewers see disabled controls that look editable. t14-13: host execution messages ('Task changed while queued' for a non-owner) and a 409 on a repeat click after start (src/collab/host-execution.ts:129). Duplicate groups: [["t13-8","S06-5"]]

Likely files: `ui/collab-task.tsx`, `src/collab/store.ts`, `src/collab/model.ts`, `src/collab/host-execution.ts`, `ui/collab-board.tsx`, `ui/collab-settings.tsx`, `ui/styles.css`

## Final integrated follow-up · 2026-10-26

Final host-server replay found background queue refresh clearing a stale-revision action error. Commit4920eb2 separates action and refresh error state; actual409 remains visible until intentional retry/success/context change. The final six-case collaboration replay passes. See [Team/collaboration evidence](../final-partials-team-ml.md).

## Issues

### t13-1 · major · Concurrent edits to a board task silently overwrite a teammate's change (no conflict once the live stream has refreshed the task)

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-16.

**Repro**

> 1. Start a hub (fake mode) with a project, a repository key and a maintainer account 'mia'; create a task.
> 2. Owner browser: open #/team/task/<id> and type new text into Acceptance criteria (do not save).
> 3. Mia in a second browser (shared session on the same hub): open the same task, change Acceptance criteria, click 'Save acceptance criteria'.
> 4. About 1 s later the owner clicks 'Save acceptance criteria'.
> 5. GET /api/team/tasks/<id>.

**Expected:** The owner's save is refused with 409 'Task changed; reload before saving' (draft kept), or the owner is at least shown that a teammate changed the field before overwriting it.

**Actual:** The owner's save succeeds with no alert or toast and Mia's text is lost. The owner's page never showed Mia's text. Reproduced 3/3 for Acceptance criteria, once for Goal and once for Title. The 409 path happens only if the page misses the event (stream blocked); even then the second click overwrites without showing the teammate's version.

**Root cause (verifier):** ui/collab-task.tsx:74 builds every save from the current state: `put(..., { revision: task.revision, ...patch })`. `task` is replaced by load() (line 49) on every team stream frame and on the 15 s owner poll (line 51, deps [id, teamTick.value, shared]; teamTick is bumped by bumpTeam in ui/collab-state.ts:68).

The draft editors keep the user's text but not the revision or server text it started from:
- TaskText (lines 155-159) overwrites saved.current.goal/acceptance with the teammate's value on each refresh and only checks `value !== savedText`.
- The TaskHeader title editor (lines 127-128 and 134) skips setTitle while editing but then saves with the latest revision.
- The blocker form (lines 129 and 143) has the same pattern.

So after any refresh the stale draft goes out with the newest revision, the server CAS in src/collab/store.ts:258 (`revision !== task.revision` -> 409) passes, and the teammate's change is overwritten. The page also never shows the teammate's text for a dirty field, either before or after a 409; only Discard reveals it.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-task.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/team.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-ui.test.ts`

**Suggested fix:** Make each draft remember what it was based on, and detect a conflict per field in the client.

1. In TaskText, keep per field a `base` ref: the server text, plus optionally the task revision, at the moment the draft first diverged from the task.
2. When a refresh brings a new value for a field whose draft is dirty and that value differs from `base`, set a `conflict` state for that field.
3. Show the conflict with role=alert, e.g. "Mia Maintainer changed the acceptance criteria while you were editing", with the teammate's text visible (read-only block or diff). Offer three actions: "Use their text" (sets draft = theirs), "Keep editing", and "Replace their text" (explicit confirmation).
4. Plain Save must not silently overwrite while a conflict is open. Either disable it or route it through confirmAction.
5. Apply the same pattern to the title editor (capture task.title when Edit opens; conflict if it changes during editing) and to the blocker form.
6. Optionally harden the server so oth …

**Suggested regression test:** Add a case to test/e2e/team.e2e.ts next to "a save that lost to a teammate keeps every draft…", but without holding the task reloads, so the stream delivers the teammate's save as it does in real use:
- Fill #tt-goal with a draft.
- Call teammateSaves({ goal: "Goal changed by a teammate" }).
- Wait for the page's GET /api/team/tasks/<id> response.
- Assert an alert or status containing "Goal changed by a teammate" is visible.
- Assert that clicking "Save goal" leaves (await task()).goal === "Goa …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: qa-server.sh start v4605t13 4605 fake (new home homes/v4605t13). Setup went through the owner bearer API: a shared account 'mia' with a random password and maintainer on MQTT-MCP p-ef01794b, a repository key 'mqtt', and task t-16c0d44a90d6b4d2. I used two separate fresh headless Chrome contexts on http://127.0.0.1:4605. The owner signed in with ?token. Mia signed in through the UI sign-in form on the loopback listener (/api/auth/self returns kind=shared). Scripts are in work/v4605/t13/v1-lostupdate.mjs and v2-title-and-409.mjs; logs are v1.log and v2.log.

v1, 3 rounds (acceptance, acceptance, goal), each 3/3:
- The owner opens #/team/task/<id> (rev N) and types 'OWNER draft round r' into #tt-acceptance or #tt-goal without saving.
- Mia opens the same task in her browser, types 'MIA edit round r' and clicks 'Save acceptance criteria' / 'Save goal'. The server now has her text at rev N+1.
- About 1 s later the owner's page has already done a GET of the task (stream refresh). The textarea still shows the owner's draft. Mia's text appears nowhere on the page. There is no alert or toast; the only hint is 'Updated just now' (screenshot shots/v4605t13/001-r1-before-owner-save-acceptance.png).
- The owner clicks Save. The traced request is PUT {"revision":3,"acceptance":"OWNER draft round 1"} -> 200, although the draft was based on rev 2. The server ends with the owner's text. The audit shows 'Mia Maintainer: updated - acceptance' followed by 'mx: updated - acceptance' and does not keep the old value, so Mia's text is unrecoverable. The same happened in rounds 2 and 3 (goal).

v2a, title editor: the owner's draft 'OWNER title draft' overwrote Mia's saved 'MIA title' with PUT revision 12 -> 200, with no toast or alert.

v2b, the documented 409 path: I held the page's GET /api/team/tasks/<id> as test/e2e/team.e2e.ts does. The first click then gets 409 'Task changed; reload before saving' with the toast 'Task changed; reloading', and the server keeps Mia's text. After the reload the textarea still shows the owner's draft, Mia's text is not shown, and Save is still offered. A second click sends PUT with the new revision -> 200 and overwrites. That second-click part is what the docs and e2e describe, so only the first half of the report is a bug. Without blocking, the owner app also reloads on a 15 s poll, so the 409 is reachable only when the owner saves within about 150 ms plus one round trip of the teammate's save.

Not environme …

</details>

### t13-8 · minor · A task owner downgraded to viewer can still approve or decline Send-to-agent instructions

Source: tester unit human-collaboration-1; observed with api; features COL-21.

**Repro**

> 1. Bob (contributor) owns a task; Mia (maintainer) proposes an instruction (POST /api/team/tasks/<id>/instructions).
> 2. Owner changes Bob's project role to viewer (Shared project accounts).
> 3. Bob signs in again (viewer) and POSTs /api/team/tasks/<id>/instructions/<iid> {action:'approve'} from his shared session.

**Expected:** 403: viewers cannot mutate the board (Bob's comment in the same session is 403).

**Actual:** 200, the instruction is approved by Bob. The UI hides the button, but the API accepts it. Bob's runner credential also stays online after the downgrade.

**Root cause (verifier):** src/collab/store.ts:471 (decideInstruction):

`if (!isTaskOwner(current, actor) && !roleAtLeast(actorRole(actor, current.projectId), "maintainer")) throw ... 403`

Task ownership alone is enough here, and the actor's current project role is never checked. The task keeps its owner when the account is downgraded to viewer (shared-accounts.ts update() changes only the roles), so Bob still passes isTaskOwner.

The sibling checks pair ownership with the role: store.ts:565 (recoverAttempt) and store.ts:657 (offerHandoff) use `isTaskOwner(...) && roleAtLeast(role, "contributor")`.

The UI repeats the gap at ui/collab-task.tsx:271: `entry.instruction.state === "proposed" && (isOwner || maintainer)` shows Approve and Decline to a viewer who owns the task. Line 99 correctly uses `(isOwner && canEdit) || maintainer`.

The route table in src/collab/api.ts:50 allows instruction-decide for owner, browser and runner principals. So the runner credential reaches the same code path.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-task.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-store.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`

**Suggested fix:** 1. In decideInstruction (store.ts:471), resolve the role once and require the owner to still hold contributor, matching recoverAttempt and offerHandoff: `const role = actorRole(actor, current.projectId); if (!(isTaskOwner(current, actor) && roleAtLeast(role, "contributor")) && !roleAtLeast(role, "maintainer")) throw new CollabError("Only the task owner or a project maintainer may approve or decline instructions", 403);` I verified this exact change in my snapshot copy: the new test passes and the existing instructions test still passes. Optionally, give a clearer message when the caller owns the task but lacks the role, e.g. "A project contributor role is required to approve instructions".
2. In ui/collab-task.tsx:271, gate the Approve and Decline buttons on `(isOwner && canEdit) || maintainer`, like line 99.
3. Optionally, in docs/team-collaboration.md:156, say "the task owner (while a contributor)".
4. Optionally, as a follow-up, notify maintainers or prompt a reassignment when the o …

**Suggested regression test:** In test/collab-store.test.ts, extend the "instructions: …" test, or add one next to it:
1. alice owns the task and maya proposes an instruction.
2. Downgrade alice in place with `f.members.find(m => m.userId === "alice")!.roles["p-1"] = "viewer"` (the fixture's members array is live).
3. Assert `await refuses(f.store.decideInstruction(f.actor("alice"), task.id, iid, "approve"), 403, /Only the task owner or a project maintainer/)` and the same for "decline".
4. Assert the same for the runner acto …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, name v4619, on 127.0.0.1:4621. Port 4619 was already held by another verifier's server (home v4617rl), so I used my extra port. The previous v4619 home was moved aside to homes/v4619.prev-*. Scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4619/repro.mjs and ui-shot.mjs. Logs: repro.log and ui-shot.log in the same folder.

Steps:
1. Owner API: created bob (contributor on MQTT-MCP p-ef01794b) and mia (maintainer), added repository key "mqtt", and created a task owned by Bob (201).
2. Bob enrolled a runner over loopback (201).
3. Mia signed in through the login form in a fresh browser and proposed 3 Send-to-agent instructions (200, all "proposed").
4. The owner downgraded Bob to viewer through the UI (Settings > Connections > manage > Shared project accounts > Save account changes). The UI said "Account saved. Updated accounts must sign in again." Bob's role is now viewer, and he is still the task owner.
5. Bob signed in fresh. /api/auth/self shows roles {p-ef01794b: viewer}.
   - comment: 403 "A project reviewer role is required to comment"
   - decision: 403
   - propose instruction: 403
   - POST /api/team/tasks/<id>/instructions/<iid> {action:"approve"}: **200**, the instruction is "approved by Bob Builder"
6. UI check (this contradicts the reporter): the task page does NOT hide the buttons for viewer Bob. It shows Approve and Decline on each proposed instruction, right above "A project reviewer role is needed to comment." Clicking Decline and then Approve in the UI both succeeded. Screenshots: shots/v4619/04-bob-viewer-approve-visible.png and 05-bob-viewer-after-approve.png.
7. Bob's runner credential (Bearer tr-…) still works after the downgrade (GET /api/team/me 200). It can also approve an instruction (200). The owner's runner list shows the runner online.
8. Final history: Bob Builder instruction-approved, instruction-declined, instruction-approved, all while he was a viewer.
9. Focused unit test in my snapshot copy (builds/v4619/test/collab-downgraded-owner.test.ts): CollabStore.decideInstruction by a viewer who owns the task does not reject ("Missing expected rejection"). With the fix below it passes, and the existing "instructions" test in test/collab-store.test.ts still passes.

Not by design:
- The role table in docs/team-collaboration.md:71 limits a viewer to reading.
- docs/shared-projects.md:7 lists "approves instructions …

</details>

### S06-5 · minor · decideInstruction lets a task owner whose project role was lowered to viewer or reviewer approve 'Send to agent' instructions, and assertAttemptRunner has no role check, so that user's runner keeps heartbeating, receiving the instructions and publishing checkpoints.

Source: code-level suspect at `src/collab/store.ts:469` (confirmed hands-on).

**Repro**

> Snapshot test builds/s06/test/qa-s06-demoted-owner.test.ts, using the collab-store fixture. alice (contributor) owns a task and claims an attempt with her runner, and bob proposes an instruction. Then alice's role becomes { 'p-1': 'viewer' }. Results: alice proposing her own instruction was refused with 403 'A project contributor role is required…'. alice approving bob's instruction was allowed. Her runner heartbeat was allowed and returned [['Also update the changelog','approved']]. markInstructionDelivered and addCheckpoint were allowed. offerHandoff was refused with 403 and a new claim was refused with 403 'contributor role is required to run tasks'. The HTTP route (src/collab/api.ts:106) adds no extra check.

**Expected:** Demotion below contributor removes write authority on the task. A viewer/reviewer owner cannot approve or decline instructions (consistent with offerHandoff/recoverAttempt and the role table). Their runner's live attempt is either refused further checkpoints and instruction delivery or marked for stop/recovery, as host execution does when a role is revoked.

**Actual:** A viewer-owner can approve contributors' instructions, which are then delivered to the agent that is still running. Their runner keeps publishing progress and checkpoints for the project.

**Root cause (verifier):** decideInstruction checks only `isTaskOwner(current, actor) || roleAtLeast(role, 'maintainer')`, with no contributor floor. offerHandoff and recoverAttempt require `isTaskOwner && roleAtLeast(role,'contributor')`, and proposeInstruction and claimAttempt use need(…,'contributor'). Ownership is not cleared when a member is demoted. assertAttemptRunner (used by heartbeat, progress, finish, markInstructionDelivered, addCheckpoint, storeBundle) checks only runner identity. runnerActor in server.ts builds the actor from current roles but never requires a role. The docs' role table says viewers only read the board, and host execution and terminals stop or recheck on role revocation, but board attempts do not.

**Suggested fix:** In decideInstruction, require `(isTaskOwner(current, actor) && roleAtLeast(role, 'contributor')) || roleAtLeast(role, 'maintainer')`. In assertAttemptRunner (or heartbeat/addCheckpoint/storeBundle/markInstructionDelivered), also require roleAtLeast(actorRole(actor, task.projectId), 'contributor') for runner actors. Have the heartbeat return a stop signal (or 403) so the runner pauses the attempt, which then becomes recoverable by a maintainer. Update the docs line about 'the task owner … approves' to say 'a contributor task owner'.

**Suggested regression test:** Store test: demote the owner to viewer, then expect decideInstruction to return 403. Runner heartbeat and addCheckpoint for that attempt return 403 or a stop instruction, and a maintainer can still decide and recover the attempt.

### t13-19 · minor · Task owner can request a review from themselves and approve their own checkpoint (board shows Approved)

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-22.

**Repro**

> 1. As the contributor who owns a task with a checkpoint, open the task's Reviews section.
> 2. 'Request a review from' lists '<you> (you)'; 'Record a review of checkpoint' with Approve is available to the owner.

**Expected:** Self-review is excluded, or clearly marked as a self-review on the card.

**Actual:** The owner can select themselves and record Approve; the card shows a plain 'Approved' badge.

**Root cause (verifier):** There is no self-exclusion at any layer.

UI:
- ui/collab-task.tsx:240 builds the "Request a review from" options as every member with at least the reviewer role, and :244 renders them, labelling the current user "(you)" without filtering them out.
- ui/collab-task.tsx:245 shows the "Record a review" form whenever canComment && latest, with no check that the viewer is the task owner or the checkpoint author.
- The same unfiltered list feeds the Details Reviewer select (ui/collab-task.tsx:209) and the New task Reviewer select (ui/collab-board.tsx:160).
- The badges at ui/collab-task.tsx:243/250 and ui/collab-board.tsx:113 show a plain "Approved" with no self-review marker.

Store:
- src/collab/store.ts:433-440 requestReview() resolves any member with reviewer role or higher, including the actor or the task owner.
- The reviewer on create and update (store.ts:352, :373) is likewise unchecked against the owner.
- store.ts:443-456 review() only checks role, checkpoint, verdict and revision. It never compares the actor with task.owner or checkpoint.by.

Model:
- src/collab/model.ts:247-252 reviewState() counts the latest non-stale review whoever wrote it, so a self-approval becomes "app …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/model.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-task.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-board.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-store.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-model.test.ts`

**Suggested fix:** Make this an explicit rule in both the store and the UI.

1. Requesting a review: in store.requestReview, and for the reviewer field in createTask/updateTask, refuse a reviewer who is the task owner with a 400 such as "Ask a teammate other than the task owner to review". In the UI, filter the owner (and meId when the viewer owns the task) out of `reviewers` at ui/collab-task.tsx:240/198 and ui/collab-board.tsx:160, following the HandoverDialog `teammates` pattern at collab-task.tsx:370.

2. Recording a review: choose one of two policies.
   - Strict: store.review refuses a review whose actor is task.owner or checkpoint.by with a 403, and collab-task.tsx:245 hides the form for them, showing help text such as "Your own checkpoint needs a teammate's review".
   - Lenient, if solo server owners must still be able to sign off: store.review records `self: true` on the Review when the actor is the owner or checkpoint author (add it to the model.ts:23 interface and the store.ts:93 validator),  …

**Suggested regression test:** Store test, in test/collab-store.test.ts next to the existing role test at about line 170:
- `await refuses(f.store.requestReview(f.actor("alice"), mine.id, "alice", mine.revision), 400, /other than the task owner/)`
- In the checkpoint test at about line 322, with alice as both owner and checkpoint author, either `await refuses(f.store.review(f.actor("alice"), task.id, { checkpointId: checkpoint.id, verdict: "approve", text: "" }, current.revision), 403, /own checkpoint/)` for the strict policy …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4641sr on 127.0.0.1:4641 with a new home, plus a scratch clone of MQTT-MCP (bare origin under qa/clones). Preconditions were set through the API: project "V4641 Review", repository key "mqtt" mapped to the clone, shared accounts bob (contributor) and rita (reviewer). Everything else was done in the UI with headless Chrome.

Path A, owner reviews their own checkpoint:
1. As the server owner "mx" I used New task (Owner = "mx (you)"), opened the task and ran Build with agents (check command "true").
2. The fake run finished and published checkpoint 866b29deb8 with by = {userId:"owner"}.
3. In Reviews, "Request a review from" listed ['Choose a reviewer','mx (you)','Bob Builder','Rita Reviewer']. I picked "mx (you)" and chose Request review. There was no error, and the discussion shows "mx asked mx to review this task".
4. I chose Approve and Record review, and got the toast "Review recorded". The Reviews header shows "Approved", and the entry reads "Approved by mx (you)".
5. The API then showed reviewer = owner = checkpoint author = mx, and the board card had reviewState "approved". The board card renders "Reviewer you · Approved" (screenshot shots/v4641sr/002-owner-board-approved.png).

Path B, contributor owner (the reported case):
1. I created a second task, built it the same way, and the owner used Details > Owner to assign it to Bob Builder.
2. Bob signed in from a fresh browser with his password and opened #/team/task/<id>.
3. His Request options were ['Choose a reviewer','mx','Bob Builder (you)','Rita Reviewer']. He requested a review from himself, then chose Approve and Record review. Neither step showed an error.
4. The task ended with owner = reviewer = Bob Builder and reviews [["Bob Builder","approve",false]]. His board view showed reviewState "approved" (screenshot shots/v4641sr/bob-self-approved.png).

Nothing marks either result as a self-review. Because notify() drops the actor, the self-request and the review-recorded notice reach nobody.

Attempts to refute it:
- Docs: docs/team-collaboration.md:73 and :204 say a contributor "requests a review from a named teammate" / "Ask a teammate to review", which implies someone other than the owner. No doc or code comment says self-review is allowed.
- Contrast: the HandoverDialog (ui/collab-task.tsx:370) deliberately excludes the current user (member.userId !== meId), so leaving self out of a teammate picker is an existing pattern that the review pickers do not follow.
- Not t …

</details>

### t13-16 · cosmetic · Decision limit message says to 'remove some' decisions, but decisions can't be removed

Source: tester unit human-collaboration-1; observed with api; features COL-20.

**Repro**

> 1. Add 100 decisions to a task (contributor), then add one more.

**Expected:** A message that matches what's possible (decisions are permanent; create a new task).

**Actual:** 400 'At most 100 decisions can be kept here; finish or remove some before adding more'. There is no API route or UI to remove decisions.

**Root cause (verifier):** The cause is src/collab/model.ts:304-305 (pushBounded). With overflow "refuse" it always throws `At most ${max} ${label} can be kept here; finish or remove some before adding more`, whatever the list is. src/collab/store.ts:428 (decide) calls pushBounded(task.decisions, …, MAX.decisions, "decisions"), but decisions cannot be removed: the closed route table in src/collab/api.ts:45-57 has only POST tasks/:id/decisions, and ui/collab-task.tsx:286-291 (DecisionsCard) renders the list plus an Add form, with no remove control. "Finish" does not free any space either.

The same wrong hint reaches the other lists that refuse on overflow and cannot be pruned:
- comments (store.ts:418, limit 500)
- reviews (store.ts:449, 100)
- instructions (store.ts:462, 50)
- attempts (store.ts:508, 50)
- checkpoints (store.ts:588, 50; DELETE checkpoints/:id keeps the manifest, so the list does not shrink)

The hint is only accurate for board tasks (store.ts:355), which do have a DELETE route.

A smaller UX gap: DecisionsCard keeps the Add form enabled at 100/100, so the user only finds out after submitting.

**Files:** `src/collab/model.ts`, `src/collab/store.ts`, `ui/collab-task.tsx`, `test/collab-model.test.ts`, `test/collab-store.test.ts`, `docs/team-collaboration.md`

**Suggested fix:** Give each caller its own overflow advice. Make pushBounded's refusal text a parameter: add an optional `hint` argument, or have callers pass the full message. Keep "delete finished tasks first" for board tasks (store.ts:355). Give append-only per-task lists a message that matches what is possible. For decisions, something like: "This task already holds 100 decisions, the most a task can keep; decisions are permanent, so record further ones in a new or follow-up task". Comments, reviews, instructions, attempts and checkpoints need equivalent wording, for example "…start a follow-up task to continue". Optionally, in ui/collab-task.tsx DecisionsCard (and the discussion form), disable the Add form when task.decisions.length >= 100 and show the same explanation, so the limit is visible before submitting. Optionally, state in docs/team-collaboration.md (:154/:183) that decisions and comments are permanent and what to do at the limit.

**Suggested regression test:** Two tests would cover this:
- In test/collab-store.test.ts, add 100 decisions to a task through store.decide, then assert that the 101st rejects with a CollabError of status 400. The message should match /permanent|new task|follow-up/ and must not match /remove some/. Repeat for comments (500) and instructions (50).
- In test/collab-model.test.ts, the existing assertion at line 237, `/At most 4 comments can be kept here; finish or remove some before adding more/`, pins the generic wording. Updat …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4635 on 127.0.0.1:4635; its team board had no tasks. As owner/maintainer I used the API to map repository key "mqtt" on project MQTT-MCP (p-ef01794b) and to create task t-8315a90f14ca39b8. POST /api/team/tasks/:id/decisions accepted 100 decisions, all with 200. I then opened #/team/task/<id> in headless Chrome. The Decisions section showed 100, and its only button was "Add": no remove or delete control. Submitting a 101st decision from the "Add a decision" form showed a red alert under the task title: "At most 100 decisions can be kept here; finish or remove some before adding more". Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4635/001-decision-limit-alert.png. The 101st through the API returned 400 with the same text. DELETE /api/team/tasks/<id>/decisions/<decisionId> and DELETE /api/team/tasks/<id>/decisions both returned 404 "Unknown team operation". Marking the task "finish"ed has no effect on the decisions list either, so neither suggestion in the message is possible. Role does not matter: owner and contributor both reach the same pushBounded call in store.decide.

Why it is not by design: docs/team-collaboration.md:154 and :183 document the limit itself ("Decisions (2000 characters each, 100 per task)"), but no doc describes removing decisions, and the API table (docs :203) lists only POST. The wording comes from a helper shared by several lists, not from decision-specific copy. It is not an environment issue either: I reproduced it from a fresh server with the bearer-token owner, without the reporter's scripts or accounts. Scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4635/t13-16.mjs and t13-16-cleanup.mjs, with their .log files.

Cleanup: I deleted the task through the UI "Delete task" dialog (GET then returned 404 and the board had 0 tasks). I reset MQTT-MCP's repository keys to [] and stopped server v4635. No runs, worktrees or clones were created. Nothing is left over apart from the QA home's files.

</details>

### t13-18 · cosmetic · Viewer's task page: disabled detail controls look exactly like editable ones

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-14, COL-10.

**Repro**

> 1. Sign in as a viewer; open a task (#/team/task/<id>).

**Expected:** A visible read-only treatment of Status/Owner/Reviewer/Repository/Base branch/Labels/Collaborators.

**Actual:** The controls are disabled (DOM) but look identical to enabled ones; only Goal/Acceptance render as read-only boxes.

**Root cause (verifier):** 1. ui/collab-task.tsx:205-214 (TaskFields). For anyone below contributor (viewers, and reviewers too, since `canEdit = roleAtLeast(role, "contributor")` at line 64), the code renders the same editable controls and only sets `disabled = !canEdit || !!busy`: `<select class="field">` for Owner/Reviewer/Repository/Depends on, `<input class="field">` for Base branch/Labels, and `<fieldset class="team-checks" disabled>` for Collaborators. The header Status select at line 140 works the same way (`disabled={!canEdit || !!busy}`). TaskText at lines 160-163 behaves differently: when `!canEdit` it switches to `<p class="team-prose">`. That is why only Goal and Acceptance look read-only.
2. ui/styles.css has no disabled style for `.field`. There is no `.field:disabled` anywhere. In addition, the base rules wipe out Chrome's built-in disabled look:
   - Line 85 `input, select, textarea { color: var(--text) }` replaces the browser's greyed disabled text.
   - Line 124 `.field { border: 1px solid var(--border-strong); background: var(--field) }` replaces the browser's disabled background.
   - Line 3063 `.team-checks .check { color: var(--text-2) }` keeps collaborator labels at full color.
   The …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-task.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/team.e2e.ts`

**Suggested fix:** Preferred fix: copy the TaskText pattern into TaskFields so that read-only users get plain values instead of disabled form controls.
- In TaskFields, when `!canEdit`, render the existing `<dl class="team-kv">` with Owner (display name, or "Unassigned"), Reviewer (or "None"), Repository (label and key), Base branch (or "Repository default"), Labels (as the same pills the header uses, or "None"), Collaborators (comma-separated names, or "None") and Depends on (already shown there).
- In TaskHeader (collab-task.tsx:140), render the Status `<select>` only when canEdit. The status pill in the meta row already shows the state to read-only users.
- Optionally add one line of help text, like Discussion has, for example "A project contributor role is needed to edit these details."

Secondary fix, a safety net for the remaining disabled fields:
- Add `.field:disabled { background: var(--sunken); color: var(--muted); border-color: var(--border); cursor: not-allowed; opacity: 1 }`.
- Add `.team-ch …

**Suggested regression test:** In test/e2e/team.e2e.ts, add a test next to "a shared contributor signs in…":
1. Create a viewer account with POST /api/accounts and role "viewer" for projectId.
2. Sign in as the viewer in a new browser context and open `#/team/task/${taskId}`.
3. Assert that the Details region contains no form controls: `details.locator("select, input, textarea").count() === 0`.
4. Assert that `getByRole("combobox", { name: "Status" })` has a count of 0.
5. Assert that the `dl.team-kv` shows the owner's displa …

<details><summary>Verifier's independent reproduction</summary>

I started from a fresh QA home: the old homes/v4639 was moved aside and I ran `qa-server.sh start v4639 4639 fake`. Setup was done through the owner API (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4639/t13-18/setup.mjs):
- POST /api/projects registered a scratch git repo in my work dir.
- PUT /api/team/projects/<id>/repositories added the key "scratch".
- POST /api/accounts created "vic" (viewer) and "cora" (contributor), each with a random password.
- POST /api/team/tasks created a task owned by cora, with baseRef "main" and labels "ui, probe".

Then probe.mjs used a fresh headless Chrome context per user, with no profile and no owner token. It signed in on http://127.0.0.1:4639 with the Username/Password form, opened #/team/task/<id> and recorded computed styles for every control in the Details card and the header Status select. It ran in light and dark mode.

Results:
- Viewer (vic): every control matches `:disabled`. Owner, Reviewer, Repository and Status have the same background (rgb 252,251,248), text color (41,42,38) and border (212,210,199) as for the contributor. The only difference is Chrome's default `opacity: 0.7` on disabled selects.
- Base branch and Labels inputs look exactly the same as the contributor's editable ones (opacity 1, same colors). Only the hover cursor differs: default instead of text.
- Collaborator checkboxes get Chrome's light-grey disabled box. Their labels keep the same --text-2 color.
- Goal and Acceptance render as grey `.team-prose` read-only boxes.
- The Details card has no note saying it is view-only. The Discussion card does say "A project reviewer role is needed to comment."
- Clicking the Owner select as vic times out (it is disabled); the same click as cora succeeds.
- Dark mode gives the same result. There were no console or 5xx errors.

The screenshots show this side by side:
- /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4639/t13-18-vic-light-details.png
- /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4639/t13-18-cora-light-details.png
- /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4639/t13-18-vic-light-page.png

Logs: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b …

</details>

### t14-13 · minor · Host execution wording/behaviour mismatches: non-owner queue gets 'Task changed while queued'; repeat click after start gets 409; cards hidden under a remote pin

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-38, COL-37.

**Repro**

> 1. Grant Alice and Bob host execution (codex). Shared Bob calls POST /api/host-execution/tasks/<Alice's task> with the current revision.
> 2. Shared Alice clicks 'Run on team server', then repeats the request after the job started.
> 3. On an instance that is both a hub and linked to another team, open Settings → Manage with ?team=<remote connection>.

**Expected:** 1) 403 'only the task owner can queue it'. 2) The existing request is returned (docs: 'repeated clicks return the existing request'). 3) The host cards stay reachable, or the page explains that they belong to 'This computer's own board'.

**Actual:** 1) 409 'Task changed while queued; review it and queue again'. 2) 409 'This task cannot start while done, executing or being handed over' (idempotent only while still queued). 3) 'Run teammates' tasks on this computer' and 'Teammate terminals' disappear. The docs also call the button 'Run on host computer' while the UI says 'Run on team server'.

**Root cause (verifier):** 1) src/collab/host-execution.ts:129: authorize() throws one message, "Task changed while queued; review it and queue again" (409), for both `task.owner?.userId !== job.userId` and a content-hash mismatch. enqueue() calls authorize() at :145 for a job that is not queued yet, so a granted non-owner gets the "changed while queued" text. The 409 status itself is intended: test/host-execution.test.ts:63 asserts bob→alice's task is 409. Only the message is wrong.

2) src/collab/host-execution.ts:141 (revision check) and :146 (done/busyAttempt/handoff check) run before the duplicate lookup at :147. Once the job starts, the attempt claim bumps the task revision and busyAttempt(task) is true, so repeats fail with 409. Idempotency therefore holds only while the job is still queued and the revision unchanged. That contradicts docs/team-collaboration.md:84, "repeated clicks return the existing request".

3) ui/collab-settings.tsx:40 (the report says :46) renders HostExecutionSettings, HostQueue and TeamTerminalSettings only when `b?.me.userId === "owner" && link && !link.linked`. `link` and `board` follow the tab's pinned team connection. When there is no ?team= and exactly one remote is linke …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/host-execution.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/host-execution.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/team.e2e.ts`

**Suggested fix:** (a) In enqueue(), after loading the task, check ownership explicitly before building or authorizing the job. Throw a dedicated error, e.g. CollabError("Only the task owner can queue it on the team server; take ownership first", 409). Keep 409 to match the existing test, or move to 403 and update that test. Keep the "changed while queued" wording only for the dispatch and tick paths in authorize().

(b) Move the duplicate lookup ahead of the revision and busy/done/handoff checks. Once the member is resolved, the task is readable, and the actor is the task owner, look for an active job on this taskId requested by this actor; if there is one, return publicJob(duplicate). Return it only to its own requester, so the response leaks nothing to others. Alternatively, narrow the docs to "repeated clicks while queued return the existing request".

(c) In TeamSettings (ui/collab-settings.tsx:40), when the owner's tab is pinned to a remote but this computer is itself hosting (the local link exists …

**Suggested regression test:** test/host-execution.test.ts:
- Extend the first test (line 63). Assert that bob enqueuing alice's task rejects with status 409 (or the new 403) and a message matching /task owner/ that does not match /while queued/.
- Add a test: configure, create a task, have Alice enqueue it, call `await f.q.tick()` until the job is running, then re-enqueue as Alice with both the original and the refreshed task revision. Assert both resolve to the same job id (`assert.equal(again.id, first.id)`) and that f.sta …

<details><summary>Verifier's independent reproduction</summary>

I started two fresh fake-mode servers, v4655k on 4655 and v4655kb on 4657 (FAKE_SLEEP_MS=120000, FAKE_SLEEP_VENDOR=codex). The project used a scratch clone of MQTT-MCP. Preconditions were set up through the API: project "V4655 Host MQTT", contributor accounts alice and bob, repository key "mqtt" mapped on the hub, a host policy (codex) granting both Alice and Bob, and a task owned by Alice. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4655k (s00-setup.mjs, s01-queue.mjs, s02-pin.mjs, s03-people.mjs, logs s00/s01/s02/s03.log).

(1) Bob signed in through the shared sign-in in a fresh browser and opened Alice's task. The UI shows no Run button, only "Take ownership of this task to queue it on the server." Bob then sent POST /api/host-execution/tasks/<id> {revision:1}. Result: 409 {"error":"Task changed while queued; review it and queue again"}. Nothing was queued.

(2) Alice signed in and clicked "Run on team server" in the UI. The job went queued, then running, and the attempt "Host computer" started, which bumped the task revision from 1 to 2. Repeating the request with the fresh revision 2 returned 409 "This task cannot start while done, executing or being handed over". Repeating it with the original revision 1 returned 409 "Task changed; reload before queuing". A second Alice tab, opened before the click and never reloaded, refreshed itself through team events and hid the button. Neither 409 is reachable from the normal UI; both show up at the API, against the documented contract.

(3) I linked v4655k as a runner to v4655kb (POST /api/team-link/connect, account carl), so v4655k was both a hub with a running host job and linked to one remote. Opening /#/settings/connections/manage with no ?team= auto-pinned the tab to the only remote (the URL became ?team=c-fc93…). The cards were [People, Host a team, This computer, Repositories, Team server, Connected computers]: "Run teammates' tasks on this computer", the Host queue and "Teammate terminals" were missing. The Team server card said "This computer is linked to mx: the board, the accounts and the runners live there", while this computer's own Shared project accounts panel was still shown below it. The same happened with an explicit ?team=<remote>. With ?team=local all cards appeared.

Not quite "unreachable", though. The picker offers "This computer's own board", and Project → People → Advanced administration (#/pro …

</details>


## Resolution and verification — 2026-10-26

Implemented on `codex/qa-collab-task-permissions`, based on integration `b12815e`, in `/private/tmp/codeflow-qa-collab-task-permissions`. All app, build and test commands used outer scratch `CODEFLOW_HOME`, `HOME`, `ZDOTDIR` and `TMPDIR` under `/private/tmp/codeflow-qa-continue/work/collab-task-permissions/`; server children used their own scratch homes. No live checkout build, ports 4317/4318, real CodeFlow home, real project, provider or remote mutation was used.

### Outcomes

- **t13-1:** Goal, acceptance, title and blocker drafts retain their original saved field value and revision. An unrelated field update can rebase the revision safely; a conflicting field update shows the current saved text, preserves the draft and disables ordinary Save. “Use saved…” discards the draft; “Replace saved…” requires confirmation and still uses compare-and-swap. A newer teammate save while that confirmation is open is refused with 409. This also closes the old missed-stream/second-click overwrite path. The blocker comparison includes status as well as text.
- **t13-8 / S06-5:** Instruction decisions require a contributor task owner or a maintainer. Runner heartbeat, progress, finish, instruction delivery, checkpoint creation and bundle upload require contributor access as well as the existing runner identity. Viewer and reviewer demotions are covered. A maintainer can still approve and recover work. The internal host runner retains its existing narrow reporting authority to settle/cancel already-started work after revocation; host tests confirm that cleanup still completes and no second run starts.
- **t13-19:** New reviewer assignments, review requests and review records require a teammate other than the task owner or checkpoint author. All three reviewer pickers exclude self-review; changing a new task’s owner clears a now-invalid reviewer. Existing self-review history is retained and explicitly labelled, and does not establish the card/header’s independent approval. Independent reviewer approval remains available. This deliberately chooses the strict policy proposed in the issue; there is no new self-approval bypass.
- **t13-16:** Permanent-history limits explain that records cannot be removed individually and point to a follow-up task. The Decisions form is replaced by that explanation at 100 entries; the API rejects entry 101 without dropping any accepted record. The separate whole-board task limit instead points to deleting finished tasks. Shared bounds and review presentation rules live in a browser-safe module, re-exported from the model for existing server callers.
- **t13-18:** Viewer/reviewer Details show readable values and a read-only explanation, with no editable-looking controls; the header status selector is absent. Checked in light and dark themes, retaining the status pill and discussion/review permissions.
- **t14-13:** A non-owner host queue request gets the existing 409 status with explicit task-ownership guidance. Repeated requests for an already-active job return that same job even with the original revision, after current ownership and execution grants are rechecked. A remote-pinned local app explains where its own host controls belong and offers a direct switch to its own board. Actual fake-agent execution verified one attempt and one job for repeat requests.

### Evidence

Evidence directory: `/private/tmp/codeflow-qa-continue/work/collab-task-permissions/`.

- New store/draft/host regression files: `test/qa-collab-task-permissions.test.ts` and `test/qa-collab-task-permissions-host.test.ts`. The initial three backend probes failed on the original implementation (`unit-before.log`); final expanded related run passes **109/109**, including the existing collab model/store/UI/API/checkpoint/runner and host suites (`related-second.log`, 29.76 s).
- New real Chrome suite: `test/qa-collab-task-permissions-ui.test.ts`: **8/8** pass (`ui-complete.log`, 31.71 s). It uses real sign-in contexts, API requests, event streams, scratch Git repositories, actual fake-agent execution/checkpoint publication and two isolated servers on 4355/4357. It covers the original streamed edit and missed-stream cases, role demotion, independent approval and all reviewer pickers, decision cap, running-job repeat requests, remote host guidance, and the confirmation race. Only the missed-stream test delays real GET requests; it supplies no fabricated API response.
- Original `test/e2e/team.e2e.ts`: **19/19** pass (`original-ui.log`, 43.96 s), including task creation/editing, 409 recovery, resume, shared idle streams, host execution, real local PTY lifecycle, and axe/layout checks in light, dark and phone widths. Its existing lost-edit test gained an assertion that a conflicting ordinary Save is disabled and the teammate’s text is visible.
- Final typecheck passes (`tsc-verified.log`) and `git diff --check` is clean. Combined related and real Chrome verification: **136 passing tests**.
- Existing expectation change: `test/collab-model.test.ts` now expects the actionable permanent-history/follow-up message instead of “finish or remove some”; an inline comment explains why that action was impossible. No unrelated test expectations were relaxed.
- Screenshots include `01-goal-conflict.png`, `01-acceptance-conflict.png`, `02-title-blocker-conflict.png`, `02b-phone-conflicts.png`, `03-cas-conflict.png`, `04-viewer-details-light.png`, `05-viewer-details-dark.png`, `06-self-review-excluded.png`, `07-independent-approval.png`, `08-decision-limit.png`, `09-host-running.png`, `10-linked-host-explanation.png`, and `11-replacement-race.png`. Acceptance conflict, phone blocker conflict and dark read-only Details were visually inspected: text and choices are readable, and no horizontal overflow was observed.
- `server.log` captures both test servers; `browser-errors.json` captures runtime errors, console errors and failed requests. Intentional 409 conflict responses and the old Bob session’s `/api/events` termination during role revocation are distinguished from unexpected failures. The role change forcibly closes the old session: Chrome logs `ERR_INCOMPLETE_CHUNKED_ENCODING` for that stream, followed by navigation cancellation as the test closes the invalidated context. The allowance is limited to that exact console error on Bob’s page during the explicit revocation window; all other console errors, page errors and 5xx responses fail the suite.

Earlier failed browser runs are retained (`ui-first.log`, `ui-second.log`, `ui-third.log`, `ui-fourth.log`, `ui-final.log`, `ui-diagnostic.log`, `ui-verified.log`). They identified the server-only crypto import in the initial helper placement (fixed by the browser-safe shared module), test synchronization/accessible-name/HTTP-status expectations, the API’s `teamConnection=local` pin after linking a remote, and the expected session-stream closure described above. No throughput timeout was converted into a product change.

### Scope and limitations

These checks use fake agents, not paid providers. The browser checkpoint and host job were produced by the real runner/engine/Git path using those fake executables; the focused host unit tests use a deterministic manager stub. Bundle permission tests use synthetic manifests/bytes, while the browser review test publishes a real scratch Git bundle. No external team, account, provider or hosted Git service was contacted. All test servers and Chrome contexts are closed at suite completion.
