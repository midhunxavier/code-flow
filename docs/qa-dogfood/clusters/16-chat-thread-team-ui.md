# Cluster 16 · chat-thread-team-ui

**Chat thread & team activity rendering: lost bubbles/question cards, raw enums, reply box errors**

Status: **completed on continuation branch · browser and focused regressions checked · integrated into `codex/dogfood-qa-continue`** · 8 issues · branch `codex/qa-chat-collab-continue`

Planner notes: ChatThread in ui/run.tsx (~783-873) renders corrections and Team activity only when there are no turns or follow-ups. As a result the first turn's correction bubble and Team activity vanish after another message (t11-2), and the team question card disappears after the user asks the lead a question (t11-3). t11-14: summaries show raw TeamState enums. t11-8: 'Revise goal' shows a red 'Event scheduler stopped' box and concatenated links (src/team-scheduler.ts, reviseGoal in the engine ~4258). t11-9: a direct reply's 1-call budget is persisted into run.loop (engine.ts:3849), so the reply box shows an error on load; also dedupe the error lines. t11-10: provider changes are not shown on Team details (ui/team.tsx). t10-15: a typed team answer is lost on reload (a module-level Map at ui/team.tsx:268); persist it per run like other drafts. t10-12: a stopped team shows unrounded minutes and inconsistent status text.

Likely files: `ui/run.tsx`, `ui/team.tsx`, `ui/team-state.ts`, `ui/task-team.tsx`, `src/engine.ts`, `src/team-scheduler.ts`, `ui/run-experience.ts`, `src/remote.ts`

## Continuation verification — 2026-10-26

Reviewed the interrupted implementation and retained the chat-turn ordering, status labels, provider-change history, draft persistence and reply-budget fixes. Corrected an integration concern: **internal remaining minutes stay precise**; flooring the allowance on every correction would spend time that never ran. Only the editable resume/reply budget is normalized to whole minutes. The regression also supports the active-clock accounting introduced by cluster 15.

Validation uses **fake agent CLIs**, scratch git repositories, isolated `CODEFLOW_HOME`, and local servers on 4355/4357. No live server, real project or real provider call was used. Focused typechecking and regression tests passed; the expanded browser suite covers the original question/draft/reply/stop/revise workflows. Browser errors and API 5xx responses are collected and asserted empty, and server logs are checked for uncaught errors. Provider failover was additionally driven on a fresh server through chat → Team details and a fresh direct Auto run; both exposed the recorded Claude-to-Codex change.

- `npx tsc --noEmit`
- `npx tsx --test test/qa-chat-thread-team-ui*.test.ts` — 10 passing tests.
- `QA_CHAT_PORT=4355 npx tsx --test test/e2e/qa-chat-thread-team-ui.e2e.ts` — 4 scenarios.
- Provider-change reproduction scripts and screenshots: `/private/tmp/codeflow-qa-continue/work/chat-collab/provider*.mjs` and `/private/tmp/codeflow-qa-continue/shots/chat-provider*/`.

The first new stop-history browser run exposed a test setup race (the execution had not yet created `teamTurns`); the wait now handles that initial state. It passed on rerun. No issue was deferred or dismissed. Whole-branch validation and independent integrated-build review remain the integrator's next steps.

## Issues

### t11-2 · major · Chat thread loses the first turn's correction bubble and Team activity after the user sends another message

**Fix outcome:** Fixed. The initial task keeps its correction/activity block until its own answer step exists; follow-ups sort by message time. Browser verification stopped parts A and B, reloaded, and confirmed both stop bubbles and both activity regions remained in order. Unit coverage also checks delayed answers and subsequent messages.

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features TEAM-20, TEAM-19.

**Repro**

> 1. Fresh fake server. 2. New chat with AI team on: 'AUTO-EVENT Implement part A'. 3. While the team works send 'Stop. Also keep the README unchanged' (run stops; bubble + 'Stopped · work preserved' activity visible). 4. Send 'AUTO-EVENT Implement part B', then 'stop' while it works. 5. Reload the chat.

**Expected:** Thread shows part A, the 'Stop. Also keep…' bubble and part A's Team activity, then part B with its 'stop' and activity, in order.

**Actual:** The 'Stop. Also keep the README unchanged' bubble and part A's Team activity are gone (only part B's are shown). In a longer sequence (C3) the later turn was also rendered before the earlier one and 'Wait. Also add tests' vanished.

**Root cause (verifier):** The bug is in ui/run.tsx, in ChatThread (starts at line 783). There are two defects.

(1) Line 824: `{!turns.length && !followUps.length ? <>{corrections().map(correctionBubble)}{teamActivity()}</> : null}`. This is the only place that renders the task's own delegated turn when it has no step: its corrections, the notes from run.createdAt up to the first follow-up (line 803), and its Team activity, the teamTurns whose key starts with "agent|" (line 810). When the team is stopped before the lead answers, the engine never records a lead step for the task (steps stayed empty). As soon as any follow-up exists, `!followUps.length` is false. The thread loop (lines 825+) then renders only follow-ups and steps, and passes each follow-up to corrections(f) and teamActivity(f). Nothing renders corrections() or teamActivity() for the initial turn, so the user's correction bubble and part A's activity drop out of the thread. The data itself is intact (run.notes and run.teamTurns).

(2) Lines 792-796: thread items are sorted by `step.startedAt` for turns. A follow-up whose turn was interrupted gets its lead answer step only when the run resumes, which happens when the next message is sent. That  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/chat-views.test.ts`

**Suggested fix:** This was verified in a snapshot copy; the dogfood source was not edited. Two changes in ui/run.tsx ChatThread:

(a) Show the task's own turn whenever no step represents it, not only when the thread is empty. Replace line 824's condition with `!turns.some((s) => !byStep.has(s.id))`, i.e. no turn step is unbound to a follow-up. The corrections() and teamActivity() block then renders first, which is chronologically correct because it covers run.createdAt up to the first follow-up. An alternative is to push a synthetic `{ at: run.createdAt, initial: true }` item into `thread`.

(b) Sort a turn by when its message was sent, not by when its lead step started. At line 793 use `...turns.map((step) => ({ at: byStep.get(step.id)?.at ?? step.startedAt, step }))`. A stopped turn finished on resume then stays before newer messages; corrections(f) windows already use f.at, so they stay consistent.

Optionally, still-pending follow-ups could also be ordered among themselves by `at`; they already are. …

**Suggested regression test:** Add to test/chat-views.test.ts, reusing its esbuild-bundled ChatThread/teamSteps and the thread() walker. A working version is in builds/v4605t11/test/chat-thread-team-history.test.ts.

Test 1, "a stopped first team turn keeps its correction and Team activity after a later message". Build a run with createdAt 1000, no steps, and followUps=[{id:"f1", message:"part B", status:"pending", at:3000}]. Its notes are a control stop note {text:"Stop. Also keep the README unchanged", at:2000, teamDelivery …

<details><summary>Verifier's independent reproduction</summary>

Used a fresh fake-mode QA server "v4605t11" on port 4605 with a fresh home, started with FAKE_AUTO_SLOW_RELEASE exported so the team's slow task keeps running. I made a new private fixture git repo (clones/v4605-fx, a copy of the t11 fixture files) and registered it as a project. Every step below ran in a fresh headless Chrome profile through the real UI (work/v4605/t11/r1.mjs, log r1.log).
1. New chat with AI team on: "AUTO-EVENT Implement part A". Waited until the team's slow task was running.
2. Sent "Stop. Also keep the README unchanged". The run was cancelled. The thread showed the part A bubble, the stop bubble with "Stopped · work saved. Resume when you're ready." and Team activity "Stopped · work preserved 1/3 complete · View activity" (shot shots/v4605t11/002-r1-after-stop1.png).
3. Sent "AUTO-EVENT Implement part B". The stop bubble and part A's Team activity disappeared straight away, with no reload. The thread was only: part A, part B, then part B's Working activity (shot 003-r1-after-B-sent.png).
4. Sent "stop" while part B worked, then reloaded. Same result: "has stop1 bubble: false", 1 "View activity" (part B's, 0/3) (shot 005-r1-final.png).
The API showed the data is still on the server: notes=[Stop. Also keep... (control stop, not_applied), stop], followUps=[f1 part B pending, no stepId], steps=[], teamTurns=[agent|claude|solo|Your task#1 -> its execution (report), follow-up f1#1 -> its execution].

Ordering sub-claim (r2.mjs, log r2.log): on the same chat I sent "AUTO-EVENT Implement part C" (f2, at=...257250). Resuming the run first finished f1's interrupted turn: the lead answer step s1 (teamResponseFor "follow-up f1#1") started at ...257299, after f2 was sent. I then sent "stop" and reloaded. The thread read: part A, part C, stop, activity, "Didn't finish", then part B, stop, activity, "claude handled the request." So part C rendered before part B (shot 001-r2-final.png).

Refutation checks:
- docs/auto-team.md:9 says corrections get "a visible acknowledgement and preserved partial work", and "Team progress stays collapsed under its chat message".
- The ChatThread doc comment (ui/run.tsx:778-782) promises "each turn in order" and that a message which never got a turn "keeps its place".
- So this is not by design. It is not caused by the tester's script or profile: I used a fresh profile and server, and it appears without a reload.

Fix check: I put a focused test in my snapshot copy (builds/v4605t11/test/chat-thread-team-history.test.t …

</details>

### t11-3 · major · Team question card and Team activity disappear after asking the lead a question while the team waits for an answer

**Fix outcome:** Fixed. Lead-question steps do not replace the initial team turn. The original AUTO-USER-QUESTION → ask lead → reload flow retained exactly one question card and one activity region, and answering still completed the run.

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features TEAM-20, TEAM-26.

**Repro**

> 1. Fresh fake server. 2. New chat with AI team on: 'AUTO-USER-QUESTION Implement the sample'. 3. Wait for the inline card 'The team needs your answer'. 4. Send in the chat composer 'what is the team doing right now?' (or 'how is it going?'). 5. Wait for the lead's reply; reload.

**Expected:** Lead answers, and the open question card plus Team activity stay visible so the user can answer it.

**Actual:** Lead answers (read-only step) and the question stays open, but the question card and the Team activity region are removed from the thread (count 0, also after reload); only the bottom status line 'Team needs your answer · Team details' remains. Typing a plain answer in the composer still works.

**Root cause (verifier):** The cause is in ui/run.tsx, in ChatThread (lines 795-873), and the reporter's guess was right.

1. A direct question to the lead while a team is working goes through RunManager. At src/engine.ts:4939 the leadQuestions callback runs, and src/engine.ts:2459 calls this.ask({ title: "Your question", role: "follow-up", leadQuestion: true, side: true, ... }). This records a normal kind:"agent" step with leadQuestion:true and no FollowUp record.

2. At ui/run.tsx:800, `turns` contains every main-thread agent step, including this lead-question step.

3. The first request's team UI is drawn only at ui/run.tsx:824: `{!turns.length && !followUps.length ? <>{corrections().map(correctionBubble)}{teamActivity()}</> : null}`. teamActivity() (lines 812-820) contains the AwaitingCard, the TeamQuestionCard and the "Team activity" section. As soon as the lead-question step exists, turns.length is 1 and this block stops rendering.

4. The step branch suppresses the same UI for the lead-question step on purpose: line 873 has `{!s.leadQuestion ? teamActivity(f) : null}` and line 864 has `{!s.leadQuestion ? corrections(f)... : null}`.

5. No branch draws the first request's team activity until the lead's …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/chat-views.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/task-team.e2e.ts`

**Suggested fix:** Change the gate for the first request's team block in ui/run.tsx:824 so that lead-question steps don't count as answer turns:

`{!turns.some(turn => !turn.leadQuestion) && !followUps.length ? <>{corrections().map(correctionBubble)}{teamActivity()}</> : null}`

Keep the existing `!s.leadQuestion` guards at lines 864 and 873, so the block is never drawn twice.

Behaviour with the change:
- While the first team turn runs, the corrections, approval card, question card and Team activity stay directly under the first message, above any lead question and answer. This matches the docs ("stays under its chat message").
- When the lead's real answer step arrives, the block moves into that step as it does today.

I checked this one-line change in a patched snapshot:
- The card and activity survive the lead's answer and a reload.
- There is exactly one activity region after the team finishes.
- chat-views.test.ts still passes.

A cleaner variant: hoist `const answered = turns.some(t => !t.leadQues …

**Suggested regression test:** Unit test in test/chat-views.test.ts, using the existing thread()/chatRun()/step() helpers that build ChatThread without rendering components:

- Build a running chat run with teamTurns:[{ key: "agent|claude|solo|Your task#1", executionId: "x1" }] (no report) and no followUps.
- Add one step step("s1", { leadQuestion: true, role: "follow-up", title: "Your question" }).
- Assert that the tree contains a TaskTeamActivity element (typeof v.type === "function" && v.type.name === "TaskTeamActivity")  …

<details><summary>Verifier's independent reproduction</summary>

I reproduced the bug on the first try from a new fake-mode QA server (name v4607t11, port 4607, new home), using a new scratch git repo registered as project "v4607 fixture" and a new headless browser with no profile. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4607/t11-3.mjs; log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4607/t11-3-run1.log.

Steps, all through the UI:
1. New chat with the "AI team" switch on: 'AUTO-USER-QUESTION Implement the sample'.
2. Waited for region "The team needs your answer". At this point questionCard=1 and Team activity region=1 ("Working 0/1 complete"). Screenshot: shots/v4607t11/001-before-question.png.
3. Sent 'how is it going?' in the "Message agent" composer.
4. The API showed: parent steps = [s1 "Your question", leadQuestion:true, done], followUps=0, run running, execution running, team.status=blocked, awaitingRequestId still set, user question still "open".
5. In the UI, questionCard=0 and Team activity=0. Only the bottom status line "Team needs your answer · Team details" was left (shots/v4607t11/002-after-lead-answer.png).
6. After a reload the counts were still 0/0 (003-after-reload.png). No console errors and no 5xx responses.

Ways to recover, checked in t11-3-finish.log:
- The status line's "Team details" link opens the execution run, and the card is there (count 1).
- Typing a plain answer in the composer is still delivered.
- The inline Team activity only comes back after the team finishes and the lead's final step s2 "Your task" exists. So it is missing for the whole time the user needs it.

Why it is not the environment or the tester:
- I used a new home, a new browser without a profile, my own fixture, and the reporter's selectors, which match the component's aria-labels.
- docs/auto-team.md says "Team progress stays collapsed under its chat message".
- The existing e2e test ("inline Team answers retain the question...") expects the inline card, so the hiding is not intended.

Fix check, done only in my own snapshot copy (qa-server.sh snapshot v4607fix), not in the source under test:
- I patched ui/run.tsx:824, rebuilt the UI and ran the same script on port 4607 with the question 'what is the team doing right now?' (log: work/v4607/t11-3-fix.log).
- questionCard=1 and Team activity=1 after the lead's answer and after a reload. The card renders …

</details>

### t11-14 · minor · Team activity summary shows raw status enums ('awaiting_approval', 'running' on a stopped run)

**Fix outcome:** Fixed. Shared run-aware teamStatusLabel drives the collapsed summary, expanded badge and phone view. Browser checks covered plan approval, completion, a plain stop and a goal revision; none showed raw enums.

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features AI-T-GAP-01, TEAM-21.

**Repro**

> 1. Start an Auto team run with plan approval. 2. Look at the collapsible under the plan card; then stop/revise the run.

**Expected:** Human labels (e.g. 'Plan ready for approval', 'Stopped').

**Actual:** 'Team activity · awaiting_approval'; after Revise goal the stopped original shows 'Team activity · running'.

**Root cause (verifier):** 1) ui/run.tsx:324 renders `<summary>Team activity · {run.team.status}</summary>`. That is the raw TeamState enum ("planning" | "awaiting_approval" | "running" | "blocked" | "verifying" | "completed", from src/teams.ts:192), and it ignores run.status.
2) The same staleness shows inside the panel. ui/team.tsx:35 sets the badge to `STATUS[team.status]`, using the private STATUS map at ui/team.tsx:16-18, so a stopped run's badge says "Working". The only run-aware branch is teamAwaitingAnswer.
3) The backend never gives the team a terminal "stopped" state, so the UI has to combine it with run.status:
   - TeamState.status has no stopped or cancelled value.
   - Stopping during plan approval leaves team.status = "awaiting_approval".
   - src/engine.ts:1482-1484, inside awaitTeamAnswer, runs `finally { team.awaitingRequestId = undefined; team.status = "running"; ... }` even when the wait ends because the run was aborted (Revise goal or Stop). A stopped run therefore ends up with team.status = "running", which is why the revised original shows "running".
4) The same raw enum also appears in the remote/phone HTML view at src/remote.ts:262 (`esc(team.status)`).

**Files:** `ui/run.tsx`, `ui/team.tsx`, `ui/team-state.ts`, `src/remote.ts`, `src/engine.ts`, `test/team-ui.test.ts`, `test/e2e/auto-team.e2e.ts`

**Suggested fix:** 1) Move the STATUS label map from ui/team.tsx into ui/team-state.ts and add one run-aware helper, e.g. `teamStatusLabel(run)`, which returns:
   - "Waiting for your answer" when teamAwaitingAnswer(run)
   - "Stopped" when run.status is stopped, cancelled or interrupted
   - "Needs attention" or "Failed" when run.status is failed
   - otherwise STATUS[run.team.status], for example "Plan ready for approval", "Working", "Unresolved work", "Finished"
2) Use the helper in the ui/run.tsx:324 summary and the ui/team.tsx:35 badge, so the two always agree. The warn/ok badge class should also look at run.status.
3) Optionally use the same labels in src/remote.ts:262.
4) Optional backend hardening: in src/engine.ts awaitTeamAnswer's finally block, set team.status = "running" only when the run was not aborted (`!this.signal.aborted`), so stored state doesn't claim the team is running after a stop. The UI fix alone is enough for the reported symptom.

**Suggested regression test:** 1) Unit test in test/team-ui.test.ts, using the existing fixture() for TeamState. Assert that teamStatusLabel returns:
   - "Plan ready for approval" for {status:"running", team:{status:"awaiting_approval"}}
   - "Stopped" for {status:"cancelled", team:{status:"running"}}
   - "Stopped" for {status:"cancelled", team:{status:"awaiting_approval"}}
   - "Waiting for your answer" for {status:"running", team:{status:"blocked", awaitingRequestId:"q"}}
   - "Finished" for {status:"done", team:{status:" …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4629 on 127.0.0.1:4629, with a new home. The previous home was moved aside to homes/v4629.prev-*. I registered a scratch git fixture (clones/v4629-fx14) as the project "v4629 fixture". Everything below was done in the UI with Playwright: Advanced > Workflow = auto-team, with "Let me approve the team and plan" checked. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4629/t11-14/ (a1.mjs, a2.mjs, a1.log, a2.log).

R1 ("implement the sample feature") stopped at plan approval. The collapsed summary read exactly "Team activity · awaiting_approval" (run.status=running, team.status=awaiting_approval). When expanded, the badge inside said "Plan ready for approval". After I clicked "✓ Approve" and the run finished, the summary read "Team activity · completed" (again the raw enum, which happens to read as English).

R2 ("AUTO-USER-QUESTION AUTO-SAME-PROVIDER implement the sample") was approved and then waited for my answer. The summary read "Team activity · blocked", with team.status=blocked. I typed a message and clicked "Revise goal". The original run went to run.status=cancelled and the header pill showed "Stopped", but the summary read "Team activity · running" and the expanded badge said "Working" (team.status=running).

R3 was stopped with "Stop run" > "Stop work" while waiting for plan approval. It ended as run.status=cancelled, header pill "Stopped", "Run cancelled", but the summary still read "Team activity · awaiting_approval".

Screenshots are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4629/: 004-r2-after-revise-open.png and 005-r3-after-stop.png. No console errors or 5xx responses. Nothing in the docs makes this intentional. ui/team.tsx already has a human label map (STATUS), and run.tsx just doesn't use it.

Cleanup: I deleted all 4 runs with the sidebar's Select runs > Delete (the revised child run was cancelled first), stopped the v4629 server (4629 and 4630 are free), and removed the scratch fixture repo along with its worktrees. Nothing else is left over.

</details>

### t11-8 · minor · Run stopped by 'Revise goal' shows a red error and concatenated links

**Fix outcome:** Fixed. User cancellation clears internal scheduler abort errors; a superseded result identifies the revised goal and the two conversation links have a separator. Browser verification revised an already revised run and then stopped the successor while awaiting an answer.

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features TEAM-21.

**Repro**

> 1. Auto team run with a question open (running). 2. Type a new goal in 'Message the team', click 'Revise goal'. 3. Go back to the original run.

**Expected:** A neutral 'Goal revised — continued in <link>' state.

**Actual:** 'Stopped by you' card with a red error box 'Event scheduler stopped'; message bubble shows '↩ previous conversationContinue with the revised goal →' with no separator; summary 'Team activity · running' although the run is stopped.

**Root cause (verifier):** There are three separate defects. Two of them also affect any user Stop of an event-driven Auto team, not only Revise goal.

1. The red "Event scheduler stopped" box:
   - src/engine.ts:4258 — reviseGoal calls this.cancel(id), which aborts the run controller.
   - src/team-scheduler.ts:19 and :76-81 — in withEventPool, idle runner slots wait in pool.take(ctx.signal). On abort they reject with new Error("Event scheduler stopped"), which is not a CancelledError.
   - That rejection reaches ctx.parallel before the driver's CancelledError("Run cancelled") from waitForTeamAnswer (src/engine.ts:4836-4840).
   - src/engine.ts:5533-5535 — the run-level catch sees aborted=true, so it sets status "cancelled" and stores the raw message: run.error = err.message.
   - ui/run.tsx:624-627 — ResultCard shows any run.error as <div class="ev error"> under "■ Stopped by you". It never checks whether the run was cancelled by the user or superseded by a revision.
   - ui/run-experience.ts:57 (nextRunAction, the Resume detail text) repeats the same internal string after a plain Stop.

2. "Team activity · running" on a stopped run:
   - src/engine.ts:1482-1486 — the finally block in TeamContext.awaitTeam …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/team-scheduler.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/team-rollout-engine.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/auto-team.e2e.ts`

**Suggested fix:** 1. Engine. In the catch at src/engine.ts:5533-5535, when the run was aborted by the user (aborted && !stopReason && !shuttingDown), do not keep the internal err.message. Leave run.error unset, or set a neutral stopReason such as "Stopped by you". In reviseGoal (src/engine.ts:4257-4273), record the reason before calling this.cancel(id), for example run.stopReason = "goal revised" or a flag, so the catch shows "Goal revised — continued in a new run" rather than an error. A cleaner variant: make EventPool.take/next reject with CancelledError (or a shared AbortError type) instead of new Error("Event scheduler stopped"), so internal abort text is never mistaken for a failure.
2. Team status. In awaitTeamAnswer's finally (src/engine.ts:1482-1486), set team.status = "running" only when !this.signal.aborted. Better, on any end-of-run path that is not "done", set the team state to a terminal or stopped value. Either way, in the UI (ui/run.tsx:324) derive the label from run.status when the run i …

**Suggested regression test:** 1. Engine test, in test/team-rollout-engine.test.ts next to the "goal revisions stop the prior team…" test (line ~73). Use the real auto-team pattern with fake agents and an AUTO-USER-QUESTION, or a pattern that waits in withEventPool with idle runners. After manager.reviseGoal(...), assert:
   - original.status === "cancelled";
   - original.error is undefined or does not match /scheduler/i;
   - original.stopReason or another marker identifies the goal revision;
   - original.team.status !== " …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: qa-server.sh start v4617g 4617 fake, with a new home and no earlier runs. I drove it with Playwright scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617g/ (r1.mjs, rev.mjs, stop.mjs). The project was MQTT-MCP (p-ef01794b).

1. In the composer I opened Advanced, set Workflow to auto-team, ticked "Let me approve the team and plan" and started the task "AUTO-USER-QUESTION AUTO-SAME-PROVIDER implement the sample". This was run R1 2610251943-78e256ae.
2. I clicked Approve and waited for the question card ("Your answer…"). The API showed status=running, team.status=blocked.
3. In "Message the team" I typed "Change the goal: reject empty input and document the new behavior." and clicked "Revise goal". The page moved to the new run R2 2610251943-342e1980, which was waiting for plan approval.
4. I went back to R1. The API showed status=cancelled, error="Event scheduler stopped", team.status=running, supersededBy=R2. The page showed:
   - the result header "■ Stopped by you" with a red .ev.error box reading "Event scheduler stopped" (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617g/r1-after-revise-result.png);
   - the summary "Team activity · running";
   - no next-action section;
   - a "Ready to review / Review changes / Preview" card for the partial auto-alpha work (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4617g/001-r1-after-revise.png).
   R1 has no parent, so its bubble shows only "Continue with the revised goal →".
5. To check the link problem I approved R2, waited for its question, and clicked Revise goal again, which created R3 2610251944-d5e7aa46. R2 has parentRunId set, so its bubble ends with "↩ previous conversationContinue with the revised goal →": two links with no space or separator between them (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617g/r2-after-revise-bubble.png). The red error and "Team activity · running" also appear on R2. So the joined links only show up when the revised run already had a parent, which is the case for the reporter's R1b and for any revision of a revision.
6. Control test: I approved R3, waited for its question, then used the plain "Stop run" button an …

</details>

### t11-9 · minor · Reply box shows 'Send is off…' error on page load when a previous direct reply used a 1-call budget; duplicate error lines

**Fix outcome:** Fixed. Default reply calls are derived from the selected target minimum, and only one validation message renders. Browser verification sent a one-call worker reply, reloaded to the whole-team target, confirmed a valid four-call default, then entered one and saw a single error.

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features TEAM-22.

**Repro**

> 1. Finished Auto team run. 2. Choose a worker in 'To', set Follow-up maximum calls to 1, send a reply. 3. Reload the run page.

**Expected:** Budget resets to a valid default for the selected target, or no error until the user tries to send.

**Actual:** 'To' resets to 'Whole team · new run' while the budget stays 1, so a red 'Send is off until the budget below allows 4–200 calls and 1–720 minutes.' appears immediately (also inside the Save-as-template dialog page); with the budget open a second line 'Choose 4–200 calls…' repeats the same message.

**Root cause (verifier):** There are three causes.
(a) src/engine.ts:3849, `if (budget && !queue) Object.assign(run.loop, budget);`: a direct reply's budget is written into run.loop and persisted, so run.loop.maxInvocations becomes 1. The budget is validated by followUpBudget (src/engine.ts:695-701), which allows a minimum of 1.
(b) ui/run.tsx:1779, `useState(run.loop.maxInvocations ?? run.loop.maxSteps)`: the composer takes its starting call budget from run.loop when it mounts, whatever the target. The target state starts as "" (ui/run.tsx:1773). For a finished Auto team run, defaultTarget is "team" (ui/run.tsx:1825), so chosen becomes "team" (1832). followupMinimumCalls(true, false, "team") then returns 4 (ui/team-state.ts:9 via ui/run.tsx:1833). budgetValid is false on load (1834), and nothing clamps the starting value to the new target's minimum.
(c) Duplicate lines: ui/run.tsx:1945 always renders the outer `<p class="msg err" role="alert">Send is off…`, and the copy inside the disclosure at the end of ui/run.tsx:1946, `{!budgetValid ? <p class="msg err">Choose {minimumCalls}–200 calls…`, was kept when the outer one was added. Both appear whenever the disclosure is open.
A minor point: the summary at 194 …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team-state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/team-ui.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/auto-team.e2e.ts`

**Suggested fix:** 1. In ConversationBar (ui/run.tsx:1779-1834), stop seeding a fixed value. Keep only the user's edit, e.g. `const [editedSteps, setEditedSteps] = useState<number | null>(null)`, and work out the value to show: `followupSteps = editedSteps ?? defaultFollowupCalls(run.loop, minimumCalls)`. The new helper `defaultFollowupCalls` goes in ui/team-state.ts and returns `Math.max(minimumCalls, run.loop.maxInvocations ?? run.loop.maxSteps)`. A target that needs more calls than the last allocation then starts at a valid number. The user's own invalid entry still gets reported. Optionally, clamp again when the target changes and the user has not edited the budget. Another option: base the whole-team default on the team's original allocation instead of the last direct reply's run.loop.
2. Show one message, not two. Drop the copy inside the disclosure (end of line 1946), or hide the outer alert while the disclosure is open. Consider showing the outer role=alert only once there is text to send or the  …

**Suggested regression test:** Unit test in test/team-ui.test.ts, next to the followupMinimumCalls assertions at lines 33-37: `assert.equal(defaultFollowupCalls({ maxSteps: 1, maxInvocations: 1 }, 4), 4)` and `assert.equal(defaultFollowupCalls({ maxSteps: 12, maxInvocations: 12 }, 4), 12)`.
e2e test in test/e2e/auto-team.e2e.ts, after the "a direct reply permits one call" assertion at line 260:
1. Send the 1-call direct reply to directTarget and wait until the run is done again.
2. Call page.reload() and assert:
   - `await p …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4619 on port 4619. The project was registered through the API on a new scratch clone, clones/v4619-t119, made from the t11-fx fixture. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4619/t119/.
1. a-start.mjs started an Auto team run from the composer UI ("AUTO-SAME-PROVIDER implement the sample", plan approval off). It finished as status done, team completed, with run.loop = {maxSteps:200, maxMinutes:240} and no maxInvocations.
2. b-reply.mjs opened the run page. Before the reply there were no errors, and the summary read "New execution budget · 200 calls · 240 min". It then set To to claude@auto-alpha, opened the budget, set Follow-up maximum calls to 1 and sent a reply. The reply ran and the run returned to done. The API showed run.loop = {maxSteps:1, maxInvocations:1, maxMinutes:240} and followUps[0].budget = 1 call. Without a reload, To stayed claude@auto-alpha and there was no error.
3. After page.reload(), To reset to "team" (Whole team · new run) and the summary read "New execution budget · 1 calls · 240 min". One role=alert line appeared straight away: "Send is off until the budget below allows 4–200 calls and 1–720 minutes." Send was disabled. Screenshot: shots/v4619/003-t119-after-reload.png.
4. With the budget disclosure open, a second line, "Choose 4–200 calls and 1–720 minutes.", repeated the same condition (shots/v4619/004-t119-after-reload-budget-open.png). Choosing the worker again cleared both lines.
5. c-fresh.mjs used a fresh browser profile with no cookies or storage and showed the same alert on load. The state is stored on the server, so every viewer and every browser sees it. This is not caused by the reporter's browser profile.
Refuted part: the claim that the error also shows "inside the Save-as-template dialog" is an artifact of the reporter's script. s23.mjs read page-wide [role=alert]. Their screenshot shots/t11f/001-save-as-template.png shows the modal with no error: the alert belongs to the composer behind the modal.
Docs: docs/dynamic-teams-implementation-review-1.md:49 says the outer message beside the composer was added on purpose, so that an invalid budget is not explained "only inside the collapsed budget disclosure". Nothing in the docs says a direct reply's 1-call budget should become the default for the whole-team target. The existing e2e, test/e2e/auto-team.e2e.ts:252-260, checks that a direct re …

</details>

### t11-10 · minor · Provider changes are not shown on the Team details page (direct Auto team runs / execution view)

**Fix outcome:** Fixed. Both chat activity and direct/execution Team details render the same provider-change wording. Fresh fake usage-limit servers recorded Claude-to-Codex failover and showed the record in both paths without browser errors.

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features TEAM-32, TEAM-23.

**Repro**

> 1. Fake server started with FAKE_USAGE_LIMIT_VENDOR=claude. 2. Chat with Codex lead, AI team on (Claude+Codex), send 'AUTO-MINIMAL Implement the sample'. 3. Chat Team activity shows 'Assignment continued with Codex after Claude Code became unavailable.' 4. Click 'Team details' (execution page) and open Team activity.

**Expected:** Provider changes are recorded under Team activity on the team's own page too (docs: 'Provider changes are recorded under Team activity').

**Actual:** No provider-change text anywhere on the execution/direct run page although run.team.providerChanges has the entry.

**Root cause (verifier):** The server records the change correctly but only the chat UI renders it.

- src/patterns/auto-team.ts:159: replaceProvider() pushes into state.providerChanges (type in src/teams.ts:204) and publishes it. The API returns it on run.team.
- ui/task-team.tsx:114 is the only renderer. It lives in TaskTeamActivity, which iterates the chat's run.teamTurns, so it only appears in the chat's Team activity block.
- ui/team.tsx:23-117 (AutoTeam) never reads team.providerChanges. ui/run.tsx:324 wraps AutoTeam as "Team activity · <status>" on every run page, including execution and direct Auto runs.
- Result: an execution page shows no provider change. A direct Auto team run has no teamTurns, so its change appears nowhere in the UI.
- After replaceProvider overwrites member.provider, the roster just shows the new provider.

This is not by design. docs/auto-team.md:157 says failover applies to "team coordination, workers and review", names the direct "Auto workflow option providerFailover", and states "Provider changes are recorded under Team activity". On a direct run, the run page's Team activity is the only one there is. Git history (29628ea) added providerChanges together with only the chat r …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/task-team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team-state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/team-ui.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** 1. Move the wording into a pure helper in ui/team-state.ts, for example `providerChangeText(change)`. It returns "<Review|Coordination|Assignment> continued with <SHORT[to]> after <SHORT[from]> became unavailable." Use it in ui/task-team.tsx:114 so the two views cannot drift apart.
2. In AutoTeam (ui/team.tsx, next to the reviewFallback/gaps notices around line 53), render team.providerChanges when it is non-empty. Use a visible section such as <div class="at-section"><h4>Provider changes</h4><ul>…</ul></div>. Each entry shows the member name (via the existing name() helper), the helper text, a readable reason (usage_limit becomes "usage limit") and the time.
3. Import SHORT from ./lib.js in team.tsx.
4. Optionally, mark the roster card of a replaced member (for example "· replaced Claude Code"), so a roster showing only Codex does not hide the failover.

The run-page "Team activity" then satisfies docs/auto-team.md:157 for execution pages and direct Auto runs alike.

**Suggested regression test:** 1. Unit test in test/team-ui.test.ts: assert providerChangeText({role:"worker", from:"claude", to:"codex"}) === "Assignment continued with Codex after Claude Code became unavailable.". Also cover the reviewer ("Review …") and coordinator ("Coordination …") cases.
2. Browser e2e in test/e2e/ui.e2e.ts, fake mode, server env FAKE_USAGE_LIMIT_VENDOR=claude and a fresh CODEFLOW_HOME so Claude is not already in cooldown:
   - Start a direct auto-team run "AUTO-MINIMAL Implement the sample" with coordi …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this on fresh fake-mode QA servers using my own scratch fixture repo (git init with README.md and api.txt, registered as project p-v4621fx). I did not reuse any of the reporter's homes, profiles or fixtures.

Path A, chat AI team. Server home v4621t on port 4621, started with FAKE_USAGE_LIMIT_VENDOR=claude exported. Script: work/v4621t/a.mjs, using a fresh browser with no profile.
1. Composer: Provider set to Codex, AI team switched on (aria-checked=true). Sent "AUTO-MINIMAL Implement the sample".
2. Chat 2610251945-ecd2e406 finished. Its execution 2610251945-630f5449 has team.providerChanges = [{memberId:"builder", role:"worker", from:"claude", to:"codex", reason:"usage_limit"}].
3. Steps: Plan (codex, done); Auto task Alpha (claude, failed: "You've hit your usage limit"); Auto task Alpha (codex, done); review (codex, done).
4. The chat's Team activity shows "Assignment continued with Codex after Claude Code became unavailable."
5. I clicked the "Team details" link to open #/run/2610251945-630f5449 and opened "Team activity · completed". Script a2.mjs then expanded every <details> in main. No text matches /continued with|became unavailable|provider change|replac|switched|failover/. The only trace is the collapsed "Provider availability" list, which says "Claude Code: hit its usage limit". The member roster shows builder on Codex with no record that it moved off Claude.

Path B, direct Auto team run (no chat). This needs a second fresh server: home v4621u on port 4623, again with FAKE_USAGE_LIMIT_VENDOR=claude. On v4621t the earlier usage limit was remembered, so a direct run there showed "Auto picked Codex for coordinator (Claude Code hit its usage limit)" and no failover happened, which is expected cooldown behaviour. Script: work/v4621t/b2.mjs.
1. Advanced, Workflow set to "Team — dynamic plan". Unticked "Let me approve the team and plan". Started run "AUTO-MINIMAL Implement the sample".
2. Run 2610251947-f1b78764 ended done with teamTurns=0 and providerChanges [{builder, worker, claude→codex, usage_limit}]. Members: coordinator claude, builder codex, verifier codex.
3. The run page has no chat Team activity region (count 0). Its only "Team activity · completed" section, with every <details> expanded, has no provider-change text. The only hint is again "Provider availability: Claude Code: hit its usage limit". Screenshot: shots/v4621u/002-direct-team-activity-open.png.

No console errors or 5xx responses in either path. All 4 runs were dele …

</details>

### t10-15 · minor · A typed answer to 'The team needs your answer' is lost on page reload

**Fix outcome:** Fixed. Question drafts use per-run/per-question sessionStorage and clear only after successful send. Browser verification typed an answer, asked the lead a question, reloaded, sent the preserved answer, and confirmed the draft key was removed.

Source: tester unit ai-teams-patterns-1; observed with fake-agents; features TEAM-18.

**Repro**

> 1. Chat team with AUTO-USER-QUESTION; the question card appears.
> 2. Type an answer and don't send it.
> 3. Reload the page.

**Expected:** The draft survives like composer drafts do.

**Actual:** The textarea is empty after reload. It does survive in-app hash navigation.

**Root cause (verifier):** ui/team.tsx:268: `const answerDrafts = new Map<string, string>();` is a module-level in-memory Map, and it is the only store for the answer draft. QuestionReply seeds its state from it at ui/team.tsx:271 (`useState(() => answerDrafts.get(key) ?? "")`, key = `${run.id}/${message.id}`). It writes to it only in the textarea onInput at ui/team.tsx:286 and deletes from it after a successful send at ui/team.tsx:279. That keeps the draft across component remounts and hash navigation in the same JS realm, but a page reload starts a new realm with an empty Map. The comment at ui/team.tsx:266-267 shows the Map was only meant to cover the discussion-to-attention-card remount (fixed in the project-first-navigation work). The run message box next to it, ConversationBar, pairs its in-memory Map with sessionStorage: savedAgentDraft at ui/run.tsx:1765-1769 and the useEffect at ui/run.tsx:1783 using key `agent-draft:<runId>`. That is why that box's draft survives reload and the answer's does not.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/auto-team.e2e.ts`

**Suggested fix:** Follow the ConversationBar pattern in QuestionReply (ui/team.tsx:268-287):
- Add a helper `savedAnswerDraft(key)` that returns `answerDrafts.get(key)`, falling back to `sessionStorage.getItem("team-answer-draft:" + key)` inside a try/catch.
- In onInput, or in a `useEffect([key, text])`, write the value to the Map and to sessionStorage (`setItem` when non-empty, `removeItem` when empty), each sessionStorage call wrapped in try/catch.
- After a successful send, call `removeItem` along with `answerDrafts.delete(key)`. Leave the draft in place on a 4xx/5xx so the "Your draft is preserved" message stays true.
- Optionally prune stale `team-answer-draft:` keys when the question is no longer open, matching the existing 100-entry cap.
The key already includes run.id and message.id, so drafts cannot leak between questions. It also stays the same when the card moves between the discussion and the attention card, or when replyChatId is set from the conversation view, so the existing remount beha …

**Suggested regression test:** In test/e2e/auto-team.e2e.ts, extend the AUTO-USER-QUESTION scenario around lines 184-189, after the assertion that "moving the question preserves the answer draft".
- Call `page.reload()`, wait for `#run-question textarea`, and assert `inputValue()` still equals "Empty input is valid; add a test." (message: "an unsent team answer survives a page reload").
- Then send the answer, reload again, and assert that `sessionStorage` has no `team-answer-draft:` key, so a sent answer is not restored.
- O …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (v4643, port 4643) with a fresh persistent browser profile (v4643-t1015). Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4643-t1015/ (a1-start.mjs, a2-draft.mjs; logs a1.log, a2.log).
1. In the UI: New run, chose project MQTT-MCP, switched "AI team" on, sent "Add a tiny note file. AUTO-USER-QUESTION". This created conversation 2610252029-97d04047 and team run 2610252029-498e35ea. No plan approval was needed with default settings. Via the API, the team run showed team.status=blocked with awaitingRequestId=mail:b18e4aff11b2bef76458eebf.
2. Opened #/run/<conv>. One section.team-question card appeared ("The team needs your answer · builder · Alpha implementation · Should empty input be accepted?").
3. Typed "Yes, empty input is valid (draft)" into the answer textarea with real keystrokes (pressSequentially). For comparison, typed "composer draft text" into the run's "Message agent" box underneath. sessionStorage then held only 'agent-draft:2610252029-97d04047'. Nothing was stored for the answer.
4. Hash navigation to the team run and back: the answer was "Yes, empty input is valid (draft)" and the composer was "composer draft text". Both survived.
5. page.reload(): the question card was still shown and the team was still awaiting the same request, but the answer textarea was "" while the composer still had "composer draft text". The screenshot (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4643/002-after-reload.png) shows the empty "Your answer…" box directly above the message box, which kept its draft. No console or API errors.
I tried to refute it and could not. The selector and environment were fine: I typed real keystrokes in a fresh profile and saw the same result as the reporter. It is not by design. The only code comment (ui/team.tsx:266-267) and docs/project-first-navigation-plan.md:74 limit the Map's purpose to the remount when a question moves from the discussion into the attention card. No doc promises the answer is dropped on reload. docs/project-first-navigation-plan.md:338 states "Navigation and reload preserve the draft" for unsent drafts. docs/help.md:21 and ConversationBar (ui/run.tsx:1764-1783) keep drafts in sessionStorage so they survive reload. The answer box is the odd one out.
Cleanup: cancelled and then deleted both runs through the  …

</details>

### t10-12 · cosmetic · Stopped team shows unrounded minutes and inconsistent status text

**Fix outcome:** Fixed. Editable minute budgets are whole numbers and valid number inputs; backend budgets retain precise remaining time. Stopped status labels agree, and resume details have sentence punctuation. Engine, helper and browser checks cover these paths.

Source: tester unit ai-teams-patterns-1; observed with fake-agents; features TEAM-18, TEAM-16.

**Repro**

> 1. Chat team with plan approval; send a correction while the plan is pending (a new execution gets the 'remaining' budget).
> 2. Approve, then Stop run in Team details.

**Expected:** Rounded minutes and consistent stopped labels.

**Actual:** Resume budget shows 'Maximum minutes 29,766883333' and 'New allowance: 28 calls · 29.766883333333332 minutes'. The banner reads 'Event scheduler stopped Recorded results are reused...' (missing punctuation), and the section header says 'Team activity · running' while the run is Stopped.

**Root cause (verifier):** 1. Unrounded minutes. src/engine.ts:3930 computes usedMinutes as wall-clock milliseconds divided by 60000. src/engine.ts:3931 sets `remainingMinutes = config.maxMinutes - usedMinutes`, and src/engine.ts:3952 stores it unrounded as the child's `loop.maxMinutes`. The UI then shows the raw float in three places:
   - ui/run.tsx:200 seeds the resume allocation with `maxMinutes: run.loop.maxMinutes`.
   - ui/run.tsx:298 uses it as the input value. The input is type=number with the default step=1, so the browser marks it invalid with stepMismatch.
   - ui/run.tsx:301 prints "{allocation.maxMinutes} minutes". ui/run.tsx:2341 has the same raw `run.loop.maxMinutes` pattern.

2. Missing punctuation. ui/run-experience.ts:58 builds the detail as `${run.error || run.stopReason || "..."} Recorded results are reused...`. That assumes run.error ends with a period. For a user stop of an event-scheduled team, the run finishes through the catch at src/engine.ts:5533-5535, which sets `run.error = err.message` and status "cancelled". Here err.message is the internal "Event scheduler stopped", thrown at src/team-scheduler.ts:48/51/76/78/81. A CancelledError's "Run cancelled" (src/engine.ts:844) would al …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/team-scheduler.ts`

**Suggested fix:** 1. Minutes
   - At src/engine.ts:3931, keep the budget a whole number: `const remainingMinutes = Math.floor(config.maxMinutes - usedMinutes)`. Keep the existing `< 1` guard after flooring.
   - In the UI, round when seeding the resume allocation (ui/run.tsx:200): `maxMinutes: Math.max(1, Math.round(run.loop.maxMinutes))`. This also fixes existing persisted runs that already have fractional values.
   - Format minutes through one helper in the help text at ui/run.tsx:301 and the similar line at 2341.
   - Optionally add step={1} (or allow decimals explicitly) on the input so its validity matches allocationValid.

2. Banner
   - In nextRunAction (ui/run-experience.ts:58), join the parts with sentence punctuation, e.g. `const reason = (run.error || run.stopReason || "Execution stopped before completion.").trim(); detail = /[.!?]$/.test(reason) ? `${reason} Recorded…` : `${reason}. Recorded…``.
   - Better still, for status "cancelled" with no stopReason, show "You stopped this run." inste …

**Suggested regression test:** 1. test/run-experience.test.ts: add a case for nextRunAction({ status: "cancelled", error: "Event scheduler stopped", ... }).
   - Assert that detail matches /stopped\. Recorded results/ (or the new user-facing wording).
   - Assert it does not match /stopped Recorded/.
   - Assert the title is consistent with executionLabel ("Stopped").

2. test/task-team.test.ts (or test/team-recovery.test.ts): drive a chat with taskTeam.approvePlan=true and send a correction note while the plan is pending, as …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode server (name v4647k, port 4647, new home) and a new scratch git repo (README.md and add.js). I registered it as project v4647-fx through POST /api/projects. Everything else went through the UI with headless Chrome. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4647k (p1.mjs, p2.mjs, p3.mjs).

1. New run, project v4647-fx. I switched AI team on, opened Advanced, set Team lead to Claude, checked "Let me approve the plan before teammates start" and applied. I sent "Implement the delta feature. AUTO-USER-QUESTION".
   - Execution 2610252033-c3bce5cf started with awaiting=plan and loop {maxSteps 20, maxMinutes 30}.
2. About 14 s later, while the plan was still pending, I sent the correction "Keep README.md unchanged." from the chat composer.
   - The first execution was cancelled and superseded.
   - The new execution 2610252033-a4a9dba9 got loop.maxMinutes = 29.771883333333335 (maxSteps 19).
3. I clicked "Approve plan" on the chat card. The team asked its question (team.status=blocked). I clicked "Team details", then "Stop run", then "Stop work" in the dialog.
4. Observed after the stop:
   - API: status=cancelled, error="Event scheduler stopped" (no trailing period), stopReason undefined, team.status="running".
   - The header pill says "Stopped", but the next-action title says "Work is paused".
   - Next-action detail text: "Event scheduler stopped Recorded results are reused when you resume with a fresh budget."
   - The "Resume maximum minutes" input value is "29.771883333333335". It shows as "29,7718833333" in the screenshot because of the locale's decimal comma. HTML validity is false with stepMismatch=true.
   - Help text: "New allowance: 19 calls · 29.771883333333335 minutes. Up to 4 coordinator calls. Earlier usage is retained."
   - The details summary reads "Team activity · running".
   - The AutoTeam badge inside reads "Working".
   - Before the stop, the same summary read "Team activity · blocked", which is the raw internal status name.
   - The page logged no console or 5xx errors.
   - Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4647k/002-stopped-team.png and 003-stopped-team-activity.png. They match the reporter's 001-stopped-question.png.

Why I don't think it is by design: no doc says these minutes are fractional or that the team status …

</details>


### Integration replay — 2026-10-26

The broad integration replay exposed a stale assertion in t11-2, not a stop failure. Cluster15's whole-message control rule deliberately preserves mixed instructions. Sending `Stop. Also keep the README unchanged` produced a running parent with a delivered/applied correction targeting `alpha`, `beta`, and `slow`; it was not a global cancellation. The original stop-history browser case now sends `Stop the team and wait.` and still verifies two stopped turns, retained messages, chronology, and both activity cards after reload. A dedicated `qa-chat-stop-integration.test.ts` checks the exact mixed phrase remains steering and the replacement is a stop. Production control semantics were unchanged.

Evidence: `/private/tmp/codeflow-qa-continue/work/projects-ui-store/chat-stop-diagnostic.log` records the original timeout and last run snapshot; `chat-stop-fixed.log` passes all 4 original browser cases in 20.9s on a fresh build from integration29e2c0c; `chat-stop-unit.log` passes 21 cases (new integration assertion, cluster16 UI helpers, cluster15 engine controls). Real Chrome, isolated scratch repositories/home, fake agents; no live provider evaluation. The browser suite reported no console exceptions or HTTP5xx. Its bounded waiter now includes the last snapshot when a replay fails, so a state mismatch cannot hide behind a timeout alone.
