# Cluster 15 · team-engine-control

**AI team engine: control-word cancellation, budget during plan approval, follow-ups, per-teammate settings**

Status: **merged into continuation after review · targeted checks pass · original browser replays completed** · 9 issues · branch `qa-fix/team-engine-control`

Planner notes: t11-1/S04-5: taskTeamControl (src/task-team.ts:47-50) accepts a control word followed by '.', so 'Wait. Also add tests' cancels the run and drops the instruction. Treat only a bare control message as a control. t10-11: time spent waiting for approval during a correction is charged to the team's time budget (src/engine.ts), though the docs say the clock pauses. t11-5: a direct follow-up in a finished Auto team run can only target worker worktrees (the writers list in ui/run.tsx ~1814, plus the engine), never the integration branch. t11-6: runTaskTeam (engine.ts:3950) passes agentSettings but no roleSettings, so per-teammate model and effort are ignored. t10-9: resolveAuto (src/routing.ts) picks the same vendor for planner and reviewer. t10-2: normalizeOwnedPath is not applied to the user's plan edits (src/workflow-control.ts). t10-4: race result text never names the model. t10-14: RunManager.answer (engine.ts ~4790) accepts 'revise' on a pinned rerun and silently cancels it. chat-thread-team-ui owns the ChatThread rendering. Duplicate groups: [["t11-1","S04-5"]]

Likely files: `src/task-team.ts`, `src/engine.ts`, `ui/run.tsx`, `src/routing.ts`, `src/workflow-control.ts`, `src/patterns/auto-team-model.ts`, `src/patterns/race.ts`, `ui/task-team.tsx`

## Final integrated follow-up · 2026-10-26

Final real-provider replay exposed a reported model alias mismatch. Commit7b5dffb accepts only the catalog-reported canonical identity for pinned worker/reviewer models, preserving each model/effort pair and the coordinator pin. The exact saved plan, negative controls and tiny real Team verification passed. See [daily workflow evidence](../final-partials-daily.md).

## Issues

### t11-1 · major · Control word followed by text ('Wait. Also add tests', 'Hold on. Use …') cancels the whole run and silently drops the instruction, even after Resume

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features TEAM-20.

**Repro**

> 1. Fresh fake QA server, project with any git repo. 2. New run, Agent workflow, toggle 'AI team' on, send 'AUTO-EVENT Implement the sample'. 3. While the team works (slow task running), send in the chat composer 'Wait. Also add tests' (or 'Hold on. Use the revised wording for the slow task.'). 4. Observe toast 'Stopped — work is saved', chat run cancelled. 5. Click Resume and let it finish.

**Expected:** Either the text after the control word is treated as a correction (applied to the team), or the run pauses and the remaining instruction is kept and applied on Resume; at minimum the user is told the rest of the message was not applied.

**Actual:** note.control='pause', teamDelivery.state='not_applied', the whole chat run is cancelled; after Resume the execution completes 'done' with no userCorrections on any task and the execution task does not contain the instruction (C11 2610251536-da66aa3d, C3 2610251506-32e786ed). 'pause'/'wait' also cancel rather than pause.

**Root cause (verifier):** There are three causes.

1. src/task-team.ts:47-50 — taskTeamControl matches a control word, then uses a lookahead `(?=\s*(?:[.!?]|$|(?:and|for now|please)\b))`. Any '.', '!', '?', 'and', 'for now' or 'please' after the word is enough to match, and the rest of the message is never checked. So "Wait. Also add tests", "Hold on. Use …", "Stop and add tests" and "Pause for now and then switch …" all count as pure controls.

2. src/engine.ts:4895-4902 (addTeamNote) — when taskTeamControl returns a value, the whole message becomes one note with control set and teamDelivery {state: "not_applied"}, and this.cancel(id) cancels the chat run and its team execution. The steering branch below (lines 4908-4934, taskTeamRoute / steeringTargets / replanning) never runs for that text.

3. Nothing picks the text up later:
   - src/engine.ts:3925 and :3955 (runTaskTeam launch / beforeDispatch) skip notes with note.control when building corrections.
   - :3992 only re-launches for notes in the "received"/"replanning" state, and this note is "not_applied".
   - :1080 only hands queued notes to the lead, and this note is "delivered".
   - :4112 (resolution review) also skips control notes.

   On Resume …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/task-team.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/task-team.test.ts`

**Suggested fix:** 1. Make taskTeamControl in src/task-team.ts:47-50 match only when the whole message is a control phrase. Anchor it at the end and allow only polite or no-op tails:
   `^(stop|cancel|pause|wait|hold on)(?:\s+(?:(?:the|this|all|current)\s+)?(?:team|task|run|work|execution|everything|working))?(?:\s*,?\s*(?:(?:and\s+)?(?:wait|pause|hold on|stop)|for now|please))*\s*[.!?]*$`
   I checked this against the existing test cases and they all keep their current results ("Stop", "Please cancel the team.", "Stop the team and wait.", "Pause", "Could you wait for now?" stay controls; "Do not stop the team" and "Stop changing api.txt" stay non-controls). With it, "Wait. Also add tests" and "Hold on. Use …" are no longer controls, so addTeamNote sends them down the normal steering path (taskTeamRoute active → team → replanning or per-task steering). That is what already happens when the control word is left out.

2. Optional, if "Wait. X" should really pause first and apply X afterwards: in addTeamNot …

**Suggested regression test:** 1. test/task-team.test.ts, in the "Team availability answers conversation directly…" test:
   - Assert taskTeamControl returns undefined for "Wait. Also add tests", "Hold on. Use the revised wording for the slow task.", "Stop. Use Codex instead" and "Stop and add tests".
   - Assert taskTeamRoute(…, true) returns "team" for each of them.
   - Keep the existing positive cases.

2. Engine-level test, modelled on "a main-chat correction stops the delegated execution…" (test/task-team.test.ts):
   - …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server named v4603-t11 on port 4603 with a new, empty home. Before starting it I exported FAKE_AUTO_SLOW_RELEASE=<work>/v4603/t11/release-slow so the fake "slow" team task would block until I released it. As a precondition I made a scratch git repo at qa/clones/v4603-t11fx (one README commit) and registered it as a project through the API.

Everything else went through the UI with Playwright, using my script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4603/t11/r1.mjs:
1. New run with the Agent workflow, AI team switched on, and "Let me approve the plan" turned off under Advanced. Sent "AUTO-EVENT Implement the sample".
2. Waited until the "slow" step of the team execution was running.
3. Typed into the run's "Message agent" textbox and clicked Send.
4. Created the release file, clicked Resume in the chat recovery box, and waited for the run to end.

Run A, message "Wait. Also add tests" (log r1.log, chat run 2610251938-efae28db, execution 2610251938-97e06e81):
- Toast: "Stopped — work is saved". The composer was cleared.
- The note was saved with control=pause and teamDelivery {state: not_applied}. Both the chat run and the execution became cancelled.
- After Resume, the chat run finished "done". teamTurns still pointed at the same execution, which also finished "done". userCorrections was null on alpha, beta and slow, and the execution task did not contain "add tests".
- The text "Also add tests" appears only in the note record. It is not in any prompt or follow-up.
- The thread bubble still says "Stopped · work saved. Resume when you're ready." next to "Finished 3/3 complete". Nothing tells the user the instruction was not applied (screenshots shots/v4603-t11/003-wait-also-after-send.png and 004-wait-also-after-resume.png).

Run B, message "Hold on. Use the revised wording for the slow task." (log r2.log, run 2610251939-aa140e27): same result as Run A — pause, not_applied, cancelled, then done after Resume with no userCorrections.

Control run, message "Also add tests" with no control word (log r3.log, run 2610251939-5e8ce069):
- Toast: "Received — updating the team with your message". teamDelivery was applied to taskIds [alpha, beta, slow], and every task got userCorrections ["Also add tests"].
- So the leading control word is the only reason the instruction is lost.

I also checked the regex alone (regex.mjs). The current function treats "Stop. …

</details>

### S04-5 · major · taskTeamControl runs on every team or chat note and accepts a control word followed by punctuation, so 'Wait. Also add tests' or 'Stop. Use the blue variant' cancels the whole run and the rest of the message is dropped. 'pause'/'wait' also perform a full cancel.

Source: code-level suspect at `src/engine.ts:4895` (confirmed hands-on).

**Repro**

> Fake server s04 restarted with FAKE_SLEEP_MS=45000 FAKE_SLEEP_VENDOR=codex and FAKE_RECORD_DIR. Through the UI I started a Codex chat ('Approve for me') with the task 'Update the README with a short usage section'. While its step was running I typed 'Wait. Also add tests for the usage example' into the chat composer and pressed Enter. The API then showed status cancelled and notes [{control:'pause'}]; screenshot shots/s04/003-after-wait-note.png. Resume through the UI completed, and the recorded codex prompts did not mention the instruction (work/s04/control.mjs, resume.mjs). Regex probe: scratch test in builds/s04 run with npx tsx --test.

**Expected:** A message that starts with 'Wait.' or 'Stop.' and goes on to give a new instruction is treated as steering, or at least the instruction is kept and delivered on resume. The comma form 'Wait, also add tests' is already treated as steering. Only bare controls ('Stop', 'Pause please', 'Stop the team and wait.') cancel.

**Actual:** In a running Codex Agent chat, sending 'Wait. Also add tests for the usage example' from the chat composer immediately cancelled the run ('codex was cancelled', 'Run cancelled', status cancelled). The note was saved as {control: 'pause'} but did not appear in the thread. After Resume, the resumed Codex turn's recorded prompt did not contain 'Also add tests'. Direct probe of taskTeamControl: 'Wait. Also add tests' gives pause; 'Stop. Use the blue variant' gives stop; 'Stop and use Codex for the API file instead' gives stop; 'Wait! The port is 8123' gives pause, which would also pre-empt answering a pending team question; 'Wait, also add tests' gives undefined (inconsistent with the period form).

**Root cause (verifier):** The regex in src/task-team.ts:49 matches `^(stop|cancel|pause|wait|hold on)…` followed by a lookahead that accepts `[.!?]`, end of text, or `and|for now|please`; whatever follows the punctuation or 'and' is ignored. addTeamNote (src/engine.ts:4888-4896) runs this check before anything else, even with no team turn, saves the note with `control` set and calls `this.cancel(id)`. Control notes are excluded from later delivery (corrections filter `!note.control`), and without a team turn they have no teamDelivery, so ChatThread does not render them. 'pause' and 'stop' both call cancel(), which matches the UI wording 'Stopped · work saved' and the existing test treating 'Pause' as a control, so that part is intended. Losing the trailing instruction is not.

**Suggested fix:** Only classify a message as a control when the text after the control phrase is empty or filler (for example `^(stop|cancel|pause|wait|hold on)(\s+(the|this|all|current)?\s*(team|task|run|work|…))?(\s+(for now|please|and wait))?[.!?]*$`). For 'Wait. <instruction>', either route it as steering, or stop and enqueue the remainder as a normal note that is delivered on resume. Render control notes in ChatThread even when there is no team turn, so the user sees what happened.

**Suggested regression test:** Extend test/task-team.test.ts: taskTeamControl returns undefined for 'Wait. Also add tests', 'Stop. Use the blue variant' and 'Stop and use Codex instead', while 'Stop', 'Stop.', 'Pause', 'Please cancel the team.', 'Stop the team and wait.' and 'Could you wait for now?' remain controls. Add an engine test: an addTeamNote of 'Wait. Also add tests' on a running solo chat does not cancel it, and the text is delivered.

### t10-11 · major · Correcting a team while its plan awaits approval charges the approval wait to the team's time budget; team dropped as 'reached its time limit'

Source: tester unit ai-teams-patterns-1; observed with fake-agents; features TEAM-16, TEAM-01.

**Repro**

> 1. Fake server. New Agent conversation, AI team On -> Advanced: Maximum minutes 2, check 'Let me approve the plan before teammates start', Apply.
> 2. Send 'Implement the epsilon feature.' Wait for the 'Your team has a plan' card.
> 3. Wait ~70 s without approving. No work runs.
> 4. Send a correction in the chat: 'Keep README.md unchanged.'

**Expected:** The clock is paused while waiting for the user (docs: 'The run clock pauses while waiting for you'), so the revised team still has ~2 minutes and replans with the correction.

**Actual:** The pending execution is cancelled and no new one starts. The turn report says 'The team has reached its time limit. Its work is preserved; your agent will handle the correction.' The note is marked not_applied and the chat shows 'Saved for your agent' / 'Work preserved · needs attention'. With the default 30 min, a ~14 s approval wait left the new execution 29.766883333333332 minutes, confirming wall-clock accounting.

**Root cause (verifier):** The docs say this is wrong, so it is not by design:
- docs/runs.md:41: "The run pauses at that checkpoint, and its time budget with it."
- docs/auto-team.md:49: "The run clock pauses while waiting for you."
- docs/auto-team.md:153: corrections during planning restart the execution "with its preserved context and remaining budget".

Inside an execution, RunContext enforces the budget with a pausable clock:
- src/engine.ts:972-995 (startClock/pauseClock/resumeClock).
- approve() pauses that clock during plan approval at src/engine.ts:1063/1072.
- It is also paused for user questions (around src/engine.ts:1478), tool approvals (around 2848-2885) and slot queueing (1003-1032).

The active time this clock consumes is never saved on the Run. When a correction cancels an execution, runTaskTeam's launch() (src/engine.ts:3930) recomputes the used time from wall-clock lifetime instead:
`usedMinutes = earlier.reduce((sum,id) => sum + ((prior.endedAt ?? Date.now()) - prior.createdAt)/60000, 0)`

That window includes every paused interval: approval waits, user-question waits, tool-approval waits and slot queueing. Then:
- src/engine.ts:3931-3932 throws "The team has reached its time limit…" whe …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/task-team.test.ts`

**Suggested fix:** Charge earlier executions only for the clock time they actually used.

1. In RunContext (src/engine.ts:965-1040), record consumed active time whenever the armed timer is disarmed. In pauseClock and stopClock, add `Date.now() - clock.startedAt` to a persisted field, for example `run.clockUsedMs` (or `budgetUsedMs`). Add to the existing value, so a resumed or restarted execution accumulates across contexts. Make sure the value is included in the final emitRun/journal write before the run settles.

2. In runTaskTeam launch() (src/engine.ts:3930), use `prior.clockUsedMs ?? ((prior.endedAt ?? Date.now()) - prior.createdAt)` so older persisted runs still have a fallback. Because launch() runs only after `await this.active.get(child.id)` (src/engine.ts:4001-4002), the cancelled execution's usage is final by then.

3. Optionally round the allocation passed at src/engine.ts:3952. Seconds precision is enough; whole-minute display is the separate cosmetic issue t10-12.

4. Possibly use the same p …

**Suggested regression test:** Add a case to test/task-team.test.ts, modelled on "a main-chat correction stops the delegated execution, replans…" (line 135).

Setup:
- Use config with approvePlan: true and maxMinutes: 2.
- Make the fake auto-team pattern call `await ctx.approve("plan", "Approve Auto team", "...")` on the first launch.
- Wait until first.awaiting?.kind === "plan".
- Simulate a long user wait deterministically by backdating `first.createdAt -= 90_000`. Alternatively, use node:test mock timers on Date.now.
- Cal …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server (v4623, port 4623) with a fresh home; the previous v4623 home was moved aside, not reused. I created a throwaway 2-file git repo and registered it as project "v4623-fx". I drove everything through the UI in headless Chrome with a new profile: New run, project v4623-fx, AI team On, Advanced, Limits and approval, Maximum minutes = 2, ticked "Let me approve the plan before teammates start", Apply team settings, then sent "Implement the epsilon feature."

Run A (70 s wait):
- The "Your team has a plan" card appeared. Execution 2610252021-871588fc was awaiting "Approve Auto team" with loop.maxMinutes 2 and had made 1 invocation (the planning call).
- I waited 70 s without approving, then sent "Keep README.md unchanged." in the chat composer.
- The execution was cancelled at 72.0 s wall time and no new execution started.
- teamTurns[0].state is "preserved". Its report says "The team stopped for the user's correction. The team has reached its time limit. Its work is preserved; your agent will handle the correction." The note's teamDelivery.state is "not_applied".
- The UI shows "Saved for your agent" under the message and "Work preserved · needs attention" with "Resume team" (screenshot shots/v4623/003-a-after-correction.png). Conv 2610252021-45da389b.

Control B (20 s wait, same settings):
- The correction did start a new execution (2610252023-48e56e5c), but with loop.maxMinutes 1.6585333333333334.
- That equals 2 − 20.5 s/60, where 20.5 s is the previous execution's wall time (createdAt to endedAt), almost all of it spent waiting at approval. So the remaining budget is pure wall-clock time.

Control C (shows the execution's own clock is paused):
- I left the revised execution (budget 1.66 min ≈ 99.5 s) at its approval card for 177 s of wall time. It stayed running and awaiting "Approve Auto team" with no time-limit stop, so the run's own clock correctly paused during approval.
- I then sent a second correction, "Also keep index.js unchanged.". It was immediately rejected with "The team has reached its time limit…" and the note was marked not_applied.

So the same approval wait is free for the running execution but is charged in full when the user corrects it. No console, page or 5xx errors occurred.

Cleanup: all 5 runs deleted through the UI bulk "Delete…" action, server stopped, ports 4623/4624 free, and the scratch fixture repo (with its .worktrees and codeflow/* branches) removed.

Leftovers:
- The previous verifier's home …

</details>

### t11-5 · major · Direct follow-up in a finished Auto team run can only target worker worktrees; its changes never reach the delivered integration branch and team approval stays

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features TEAM-22.

**Repro**

> 1. Fresh fake server; Workflow 'Team — dynamic plan', task 'AUTO-USER-QUESTION AUTO-SAME-PROVIDER implement the sample'; approve and answer; wait for 'Finished' (verified). 2. In the reply box open 'To': only 'Claude Code · auto-alpha', 'Claude Code · auto-beta', 'Whole team · new run'. 3. Pick auto-beta, budget 1, send 'Add a short documentation file for the beta component.'

**Expected:** Per docs: a direct agent follow-up that changes the integrated result clears team approval and the run says it needs whole-team verification; the follow-up should be able to change the delivered result.

**Actual:** Follow-up committed on codeflow/<run>/auto-beta (e5b4aa7); integration head unchanged (96f1daad), team.verification still approved, gaps [], artifact still the integration branch, summary still 'Auto team verified'. The user's follow-up change is not part of the result offered for review, and the approval-clearing path is unreachable from the UI.

**Root cause (verifier):** ui/run.tsx:1814-1818 builds `writers`, the reply box's 'Continue a session' targets, only from agent steps with mode 'write' and a set `s.agent`. In an Auto team run those are the member steps in the worker worktrees (auto-alpha, auto-beta). The integration worktree gets an agent write step only when a merge conflict ('Integrate <task>', src/patterns/auto-team.ts:552-555) or a post-review repair ('Auto team repair', auto-team.ts:660-665) happens. Its normal steps are the engine's checks, which have no agent, and the merges, which are not steps. ui/run.tsx:1824 (`targets`) and 1980-1993 (the select) therefore never offer `<agent>@integration`. ui/run.tsx:1876-1878 posts the follow-up to the chosen worker worktree. In src/engine.ts:5779-5803, runFollowUp only re-checks team verification when `wt.name === "integration"` (5786, 5794). A worker-branch follow-up therefore leaves the verified result untouched, which is correct and covered by test/team-engine.test.ts ("another branch does not change the integrated result"). Nothing ever brings that commit into the artifact branch. updateFollowUpSummary (src/engine.ts:5740-5768) still lists it under the verified team result without saying i …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/auto-team.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/auto-team.e2e.ts`

**Suggested fix:** 1. Move the target computation from ui/run.tsx:1814-1824 into a pure helper, e.g. replyTargets(run) in ui/run-experience.ts. For team runs (run.team), put each result worktree first, meaning each worktree whose branch is in run.artifacts. Address it to resultAgent(run, tree.name), which already falls back to the coordinator provider for 'integration', and label it e.g. 'Claude Code · result (integration)'.
2. Either hide the worker worktrees for completed Auto team runs, or put them in a separate group labelled 'Worker branches (not in the delivered result)'.
3. Rewrite the hint at ui/run.tsx:1918. For the result worktree: 'Changes the delivered result on <branch>; the team's approval is cleared until the whole team verifies again'. For a worker branch: 'Changes only <worktree>'s branch, which isn't part of the result'. Drop the claim that it continues the member's session, since engine.ts:5818-5820 starts a fresh session.
4. In updateFollowUpSummary (src/engine.ts:5740-5768), mark fol …

**Suggested regression test:** 1. test/run-experience.test.ts: for a completed Auto team run fixture with roles.coordinator=['claude'], worktrees integration/auto-alpha/auto-beta, artifacts=[integration branch] and write steps only in auto-alpha/auto-beta, assert replyTargets(run) contains 'claude@integration' as the first direct target. If worker targets are kept, assert they are flagged as not delivered.
2. test/e2e/auto-team.e2e.ts after line 256: assert the 'Who gets this' options include an '@integration' value. Select i …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4611 on port 4611. I moved the old v4611 home aside to homes/v4611.prev-*. The home holds the user's projects.json plus my own throwaway fixture repo, a copy of the reporter's t11-fx with check 'node check.mjs' and prove:false. Everything below went through the UI with Playwright, using scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4611t115/ (logs a1.log, a2.log, a3.log).
(1) a1-run.mjs: chose Workflow 'Team — dynamic plan', ticked 'Let me approve the team and plan' and started task 'AUTO-USER-QUESTION AUTO-SAME-PROVIDER implement the sample' (run 2610251943-dc727535). I clicked '✓ Approve' and answered the question in the 'The team needs your answer' card. Result: Finished, team completed, verification {head:01a65cb, check:passed, reviewed:true, approved:true}, artifact codeflow/<run>/integration. The only agent write steps were the member steps in auto-alpha and auto-beta. The 'Check after alpha/beta' steps in integration have no agent. The 'To' select offered only claude@auto-alpha and claude@auto-beta (group 'Continue a session') plus 'team' (Whole team · new run). There was no integration/result option. Default was 'team'.
(2) a2-direct.mjs: picked 'Claude Code · auto-beta'. The hint said "Continues Claude Code's session on its branch, in auto-beta". I set the budget to 1 call, sent 'Add a short documentation file for the beta component.' and got the toast 'Sent — the agent is on it'. After it finished, f1 was committed on auto-beta as 256babb (check passes). The integration head was still 01a65cb, and only the auto-beta branch contains 256babb. team.verification stayed approved, gaps were [] and facts.approved stayed true. The artifact is still the integration branch. The summary still reads 'Auto team verified', with '- claude followed up on your reply in auto-beta — check passes' listed under that verified result. The result card shows 'Ready to review · Review: Approved'. The reporter's observation is reproduced exactly (shot shots/v4611/002-r1-after-direct.png).
(3) Refutation attempt, a3-review.mjs: on the result card I clicked 'Review changes', which opens the integration branch. 'Send to' defaults to the coordinator's provider (claude). I typed an overall comment and sent it. f2 (kind comments, worktree integration) committed ee034f1. Verification became {check:unknown, reviewed:false, approved:false}, gaps got 'The integrated res …

</details>

### t11-6 · major · AI team setup per-teammate model/effort is not enforced for workers (Codex medium chosen, worker ran at low)

Source: tester unit ai-teams-patterns-2; observed with real-agents; features TEAM-19, TEAM-26.

**Repro**

> 1. Real QA server, project on a scratch clone. 2. Composer: AI team on -> Advanced: Team lead Antigravity (Gemini 3.8 Flash Medium), Use Claude Code (Haiku, low), Use Codex (GPT-6-Luna, medium); approval on; Apply. 3. Send a small docs task. 4. Read the proposed plan / execution steps.

**Expected:** Codex teammate runs with the selected GPT-6-Luna / medium (or the dialog explains these are only coordinator settings/hints).

**Actual:** Plan and step settings: worker codex gpt-6-luna effort 'low'; inventory settingsByRole.worker = {} for every provider (only coordinator role carries the dialog settings).

**Root cause (verifier):** 1. src/engine.ts:3950 (in `runTaskTeam`): the chat AI team starts its child execution with `agentSettings: config.settings` and no `roleSettings`. So the per-teammate model/effort from ui/task-team.tsx (ChatControls per provider, stored in `TaskTeamConfig.settings[provider]`) arrives only as run-wide agentSettings.

2. src/engine.ts:5277: the default "auto-team" workflow always sets `modelRouting: {version:1}`.

3. src/engine.ts:1213-1216 (`teamInventory`): with modelRouting set, agentSettings are dropped from the worker and reviewer roles:
   `worker: { ...(!this.run.modelRouting ? settings[id] : {}), ...this.run.roleSettings.pool?.[id] }` (same for reviewer).
   Only `coordinator` merges `settings[id]`.

4. What happens next:
   - src/patterns/auto-team-planning.ts:28-53 (`planningInventory`) and src/patterns/auto-team-model.ts:120-130 (`planProblem`) treat an empty worker/reviewer setting as "any reported model / any supported effort". The coordinator therefore chooses freely, and is prompted to prefer the lowest sufficient effort (auto-team.ts:242).
   - src/engine.ts:2483-2487 resolves the member's chosen model/effort first. `params.settings` comes from `memberSettings(member) …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/task-team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/auto-team.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/task-team.test.ts`

**Suggested fix:** 1. In `runTaskTeam` (src/engine.ts ~3946-3950), turn the dialog settings into role pins as well as agentSettings. For each provider in `config.providers` whose `config.settings[id]` has a non-empty model or effort, add it to `roleSettings.pool[id]`. Also set `roleSettings.coordinator = { [config.coordinator]: config.settings[config.coordinator] }` when that is non-empty.
   - With this, `teamInventory` puts the pins into `settingsByRole.worker/reviewer`.
   - `planningInventory` shows them to the coordinator, `planProblem` rejects a plan that changes them, and `workerConstraintProblem` (engine.ts:2782) rechecks them at dispatch.
   - "Default model / Default effort" leaves the role unpinned, which keeps automatic selection. Pinning only the model leaves effort automatic within that model.
   - Do the same for the template path: when a saved template supplies preferences, merge its `roleSettings.pool` with the dialog pins.
2. Keep the Resume path consistent. auto-team.ts:179-181 already …

**Suggested regression test:** Primary: add a case to test/task-team.test.ts (fake CLIs, RunManager).
- Set the owner's taskTeam to `validateTaskTeam({ enabled:true, preset:"adaptive", coordinator:"claude", providers:["claude","codex"], settings:{ claude:{model:"haiku"}, codex:{model:"gpt-b", effort:"medium"} }, maxMembers:3, maxCalls:12, maxMinutes:5, approvePlan:false })`.
- Send "AUTO-MINIMAL implement the requested result" and wait for the child execution.
- Assert that the codex reviewer member and its "Auto team indepen …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this on a fresh fake-mode QA server, v4613 on port 4613, with no runs and no model-catalogs at start. The project was a scratch clone of MQTT-MCP, added through the UI with "Open another repository" and then "Create project". Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4613/ (setup.mjs, configure.mjs, approve.mjs and their .log files).

Steps, all done in the UI:
1. In the composer I turned AI team on and opened Advanced ("AI team setup").
2. Team lead: Claude Code. Teammates: Claude Code (Haiku, Default effort) and Codex (GPT-B, medium). Antigravity was unavailable in fake mode. I ticked "Let me approve the plan", applied, and sent "AUTO-MINIMAL implement the requested result". The dialog screenshot shows each teammate row labelled "Selected teammate" with its own model and effort pickers. Nothing says these only apply to the lead: shots/v4613/001-team-dialog-configured.png.
3. The run state matched the reported setup:
   - owner.taskTeam.settings = {claude:{model:haiku}, codex:{model:gpt-b, effort:medium}}
   - the child execution has agentSettings set to those same values, roleSettings = {}, modelRouting = {version:1}, roles = {coordinator:[claude], pool:[claude,codex]}.
4. The journaled planning inventory (runs/<child>.journal.jsonl, key team-inventory:plan:0#1) shows:
   - codex: settingsByRole = {coordinator:{gpt-b, medium}, worker:{}, reviewer:{}}
   - claude: settingsByRole = {coordinator:{haiku}, worker:{}, reviewer:{}}
   So the worker and reviewer roles carry no pins; only the coordinator role gets the dialog settings.
5. The plan shown in the UI (Team details) reads:
   - "verifier (reviewer) → codex / configured default"
   - "builder (worker) → claude / configured default"
   - only "coordinator → claude / haiku" keeps the selection.
6. I approved through the UI ("✓ Approve"). The execution finished with:
   - Plan step: claude {haiku}
   - Worker step "Auto task: Alpha implementation": claude {model: sonnet, effort: ""}, where the user picked Haiku
   - Review step "Auto team independent review": codex {model: gpt-a, effort: ""}, where the user picked GPT-B/medium

The reporter's real-agent evidence shows the same mechanism. In work/t11/real-team-exec.json, agentSettings.codex = {gpt-6-luna, medium} and roleSettings = {}, but the codex worker step ran {gpt-6-luna, low} and the claude reviewer ran {claude-haiku-5-5, low}. A real …

</details>

### t10-9 · minor · Auto in two roles picks the same vendor (planner and reviewer both Claude); independence only warned

Source: tester unit ai-teams-patterns-1; observed with fake-agents; features TEAM-03.

**Repro**

> 1. Plan → Build → Review with Planner = Auto, Builder = Codex, Reviewer = Auto (Claude and Codex installed).
> 2. Start and open the activity log.

**Expected:** Auto prefers a reviewer vendor different from the planner (as the docs say for reviewers), and logs why it picked.

**Actual:** Log: 'Auto picked Claude Code for planner', 'Auto picked Claude Code for reviewer' (no reason), then 'warn claude both plans and reviews; a reviewer from another vendor is likelier to catch a wrong plan'.

**Root cause (verifier):** src/routing.ts:43-71 `resolveAuto` resolves each role on its own:
- `chosen` (line 56) holds only that role's own picks.
- The pick on line 59, `roomy.find((a) => !chosen.includes(a))`, avoids duplicates only within that role. The comment on lines 40-41 says the same: "Within a role, auto picks differ".
- It has no idea that a reviewer should differ from the planner or builder, a judge from the contestants, or a synthesizer from the debaters. So every Auto role gets PREFERENCE[0] (claude), or rank.order[0] when there is a track record.

src/server.ts:656 calls `resolveAuto(requested, quota, eligible, rank)` without any information about the pattern's roles.

The composer cannot cover this case:
- ui/roles.ts:10 and :41 `independentRoles` skips any comparison that involves Auto, on purpose: the comment says "so is one whose comparison involves Auto".
- test/roles.test.ts:28 locks that in.
- So the check is deferred to run start, where nothing performs it.

src/patterns/pipeline.ts:42 only logs a warning.

The missing reason comes from src/routing.ts:62-68, which adds one only when an agent was skipped for quota or ranking applied. docs/patterns.md:21 says "The pick and the reason ar …

**Files:** `src/routing.ts`, `src/server.ts`, `src/engine.ts`, `src/patterns/pipeline.ts`, `src/patterns/index.ts`, `ui/roles.ts`, `docs/patterns.md`, `test/health-routing.test.ts`

**Suggested fix:** 1. Declare independence on the role specs. Add `independentOf?: string[]` to the Pattern role type in src/engine.ts and set it per pattern:
   - Pipeline reviewer: ["planner", "builder"], strongest first.
   - Fix-review reviewer: ["builder"].
   - Supervisor reviewer: ["supervisor"].
   - Race judge: ["contestants"].
   - Debate synthesizer: ["debaters"].
   - Auto-team defines none, so its coordinator and pool are unaffected.
2. Extend resolveAuto with an optional `independence: Record<role, role[]>` argument:
   - Collect the explicit picks for every role first.
   - Resolve the Auto slots for counterpart roles (planner, builder, contestants…) before the checking roles.
   - For an Auto slot in a checking role, prefer the first roomy candidate that is outside both its own role and the agents of all its counterpart roles. If none qualifies, relax to avoiding only the primary counterpart (the planner). Only then fall back to today's behaviour, which keeps the existing warning for sing …

**Suggested regression test:** Add to test/health-routing.test.ts, next to the existing resolveAuto tests:
- `resolveAuto({planner:["auto"], builder:["codex"], reviewer:["auto"]}, {}, new Set(["claude","codex"]), undefined, {reviewer:["planner","builder"]})` deep-equals planner ["claude"] and reviewer ["codex"]. The reviewer note matches /Auto picked Codex for reviewer \(.*Claude Code.*plans/.
- The same call with agy installed gives reviewer ["agy"].
- With rank {order:["codex"]}, planner and reviewer differ, so the run no l …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4635" on 127.0.0.1:4635. I moved the old v4635 home aside so the server started with an empty home and empty quota.json. Fresh browser profile. Scratch clone of MQTT-MCP added through the UI (Open another repository > Use > Create project). Steps in the UI:
1. Run options > Advanced > Workflow "Plan → Build → Review".
2. Planner = Auto, Builder = Codex, Reviewer = Auto. I checked the pressed pills: Planner [Auto], Builder [Codex], Reviewer [Auto].
3. Task "Add a one-line comment at the top of README.md…", then Start run.

Run 2610252030-f863a7e5 resolved roles to {"planner":["claude"],"builder":["codex"],"reviewer":["claude"]}. The run header shows "Planner: Claude Code · Builder: Codex · Reviewer: Claude Code". The Activity log reads "Activity log (6) · 1 warning". The run's .jsonl has the same lines at seq 2-4:
- "Auto picked Claude Code for planner"
- "Auto picked Claude Code for reviewer" (no reason given)
- warn: "claude both plans and reviews; a reviewer from another vendor is likelier to catch a wrong plan"

This matches the report word for word. Codex had room and was available as the reviewer.

In a snapshot copy (builds/v4635) I called resolveAuto directly with {planner:[auto], builder:[codex], reviewer:[auto]}:
- With claude+codex installed (the reporter's setup): reviewer = claude.
- With claude+codex+agy installed: reviewer = claude.
- With track-record ranking favouring Codex: all three roles are codex, so one vendor plans, builds and reviews.

test/roles.test.ts passes 4/4. It deliberately asserts that the composer leaves Auto alone.

Cleanup: run deleted through the UI, server stopped, scratch clone and probe files removed. The earlier v4635 home is kept as homes/v4635-prev-*. No leftovers in the user's repos.

</details>

### t10-2 · minor · Pending-plan editor rejects a trailing-slash directory such as 'docs/' although docs say it's accepted

Source: tester unit ai-teams-patterns-1; observed with fake-agents; features TEAM-17.

**Repro**

> 1. Chat AI team with 'Let me approve the plan' on; wait for the plan.
> 2. Team details -> expand 'Team activity' -> Edit pending plan -> Add task, fill title/instructions/acceptance, Owned paths 'docs/'.

**Expected:** 'docs/' is accepted as 'docs' (docs/auto-team.md: 'Directory ownership accepts a trailing slash, such as src/adapters/').

**Actual:** 'task-xxxx needs safe owned repository paths (directories, files, or *); invalid path: "docs/"' and Save is disabled; 'docs' works. The editor also shows only the first problem at a time ('Task 2 needs a valid ID, owner, title, kind and instructions'), which hides path and cycle errors until earlier fields are fixed.

**Root cause (verifier):** The trailing-slash normalization exists but is only applied to coordinator-generated plans and revisions:
- normalizeOwnedPath is defined at src/patterns/auto-team-model.ts:81.
- It is applied only in cleanTask at src/patterns/auto-team.ts:37 (`paths: t.paths.map(normalizeOwnedPath)`), which cleanPlan and cleanRevision use.

The human plan-edit path never normalizes:
- validateTeamPlanEdit at src/workflow-control.ts:44 builds each task with raw `paths: strings(item.paths, 64, 500, ...)`.
- Those paths go to planProblem at src/workflow-control.ts:59.
- planProblem's pathAllowed check (src/patterns/auto-team-model.ts:84) splits "docs/" into ["docs", ""]. The empty segment fails, so line 144 returns "needs safe owned repository paths ...; invalid path: \"docs/\"".

Every edit path shares this validator:
- the UI preview, TeamPlanEditor (ui/team.tsx:211, after cleanDraft at ui/team.tsx:201, which only trims lines);
- the server save, Engine.editTeamPlan (src/engine.ts:4807, via POST team-plan at src/server.ts:2667);
- journal replay, restoreTeamPlanEdit (src/engine.ts:1138).

The first-problem-only behaviour comes from validateTeamPlanEdit and planProblem returning or throwing on the f …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/workflow-control.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/auto-team-model.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/workflow-control.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team.tsx`

**Suggested fix:** 1. In src/workflow-control.ts, import normalizeOwnedPath from ./patterns/auto-team-model.js. At line 44, normalize each path and then remove duplicates, so that "docs" plus "docs/" becomes ["docs"] instead of a duplicate:

   `paths: [...new Set(strings(item.paths, 64, 500, `${item.id} paths`).map(normalizeOwnedPath))]`

   (Alternatively, normalize before the duplicate check in strings() and reject the duplicate.)

   This one change covers the UI preview, the POST team-plan save and journal replay, because all three call validateTeamPlanEdit. The template-ownership check at line 53 then compares normalized paths, so "src/adapters/" under a template base "src/adapters" is accepted, as the docs promise. The saved journal entry stores the normalized "docs".

   Do not change pathAllowed. Unsafe forms still fail after normalization: "/", "../x/", "src/.git/", "src//", "*/", "src/**/".

2. Optional UX fix for the masking: make the TeamPlanEditor show all problems. Collect per-task problem …

**Suggested regression test:** Add a test to test/workflow-control.test.ts: "plan editing normalizes trailing-slash directory ownership like coordinator plans". It should:
- take `draft = editableTeamPlan(teamFixture())` and set `draft.tasks[1].paths = ["src/adapters/"]`;
- assert `validateTeamPlanEdit(draft, team, policy()).tasks[1].paths` deepEquals ["src/adapters"];
- set paths to ["src/adapters", "src/adapters/"] and assert the result is ["src/adapters"], or that it throws a duplicate error if rejection is chosen;
- for e …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server v4637 on port 4637. Its home had no runs. Then I did the following:

1. Through the composer UI I started a standalone "Team — dynamic plan" run on MQTT-MCP with "Let me approve the plan" on and check "true". Run id: 2610252028-a1424ec3.
2. I waited for team.status=awaiting_approval (revision 0). The fake plan had task alpha (implementation, builder, paths ["*"]).
3. I opened Team activity, then Edit pending plan, and read the status line and the Save button after each change:
   - Initial plan: "Plan is valid", Save enabled.
   - alpha paths set to "docs/": "alpha needs safe owned repository paths (directories, files, or *); invalid path: \"docs/\"", Save disabled.
   - alpha paths set to "docs": valid, Save enabled.
   - Add task (instructions and acceptance blank): "Task 2 needs a valid ID, owner, title, kind and instructions.", Save disabled.
   - Same new task, now also with paths "../outside": still only the Task 2 message. The path error is hidden.
   - New task given title, instructions, acceptance and paths "docs/": "task-edcd8400 needs safe owned repository paths ...; invalid path: \"docs/\"", Save disabled. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4637/001-editor-docs-slash.png
   - New task paths "docs/\n": same rejection.
   - New task paths "docs": "Plan is valid", Save enabled.
4. I cancelled the editor. POST /api/runs/2610252028-a1424ec3/team-plan with alpha.paths=["docs/"] returned 400 with the same message, and the revision stayed 0. So the server rejects it too, not only the client preview. No console errors and no 5xx responses.

The reporter's selectors and flow were not the cause: I used a fresh profile and the standalone Team path rather than the chat AI team, and got the same result.

Not by design:
- docs/auto-team.md:89 says, without limiting it to coordinator plans: "Directory ownership accepts a trailing slash, such as `src/adapters/`, and keeps the same scope as `src/adapters`".
- The editor field is labelled "Owned paths", and the error itself says "directories, files, or *".
- Nothing in src/workflow-control.ts says user edits are meant to be stricter.

The secondary claim also reproduced: the editor shows only the first problem. A blank-instructions message masks the path error, and the generic text does not say which field is wrong.

Cleanup:
- Stopped the run with the UI's Stop run button and …

</details>

### t10-4 · minor · Race result doesn't say which model each candidate used when one provider runs several models

Source: tester unit ai-teams-patterns-1; observed with fake-agents; features TEAM-10, TEAM-04.

**Repro**

> 1. Best-of-N race with Claude Code + Add model Sonnet + Haiku and Codex + GPT-B.
> 2. Read the result summary.

**Expected:** Winner and 'All candidates' name the model (e.g. 'B — claude · sonnet').

**Actual:** 'Winner: Candidate B — claude'; candidates A/B/C are all listed as 'claude', so you can't tell which model won. The steps' settings do record the models.

**Root cause (verifier):** src/patterns/race.ts builds every piece of user-facing text and stats from `e.agent` (the provider id) only. It never uses `settings.model` or `effort`, even though `ctx.participants()` (src/engine.ts:1528-1536) returns a separate participant for each model variant, with `settings` and an `identity`.
- race.ts:51: the `ctx.parallel` callback gets `{ agent, settings, identity }` but returns `{ label, agent, wt, result, check, tests, diff }`, so the settings are dropped (line 70).
- race.ts:75: `ctx.artifact(\`Candidate ${e.label} (${e.agent})\`, e.wt)` labels the artifacts "Candidate B (claude)".
- race.ts:151: `ctx.log(\`Winner: candidate ${winner.label} (${winner.agent})\`)`.
- race.ts:153: `ctx.setFacts({ winner: winner.agent, entrants: entries.map(e => e.agent), ... })`. Per-vendor stats (src/stats.ts:162-163) are by design, but no model is recorded anywhere.
- race.ts:155: `**Winner: Candidate ${winner.label} — ${winner.agent}**`.
- race.ts:165: `- ${e.label}: ${e.agent} — ${status}...` in "All candidates".
The same pattern may apply to the judge vote text and to other multi-agent patterns that accept variants (council, debate, loop). I only verified race.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/race.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/patterns.test.ts`

**Suggested fix:** In race.ts, keep `settings` on each entry: return `{ label, agent, settings, ... }` from the `ctx.parallel` callback. Then add a small helper that names who ran a candidate, for example `const who = (e) => e.settings.model ? \`${e.agent} · ${e.settings.model}${e.settings.effort ? \` (${e.settings.effort})\` : ""}\` : e.agent;`. To keep the change smaller, add the model only when the run has variants or more than one entry per provider. Use the helper in four places:
- the artifact label (line 75), for example "Candidate B (claude · sonnet)";
- the winner log (line 151);
- the winner headline (line 155);
- each "All candidates" line (line 165).
Do not change the judge prompt, branch names or commit messages, so judging stays blind. Optionally, add `winnerModel` and `entrantModels` to facts without changing `winner`/`entrants`, which src/stats.ts uses as provider ids. A shared helper, for example in prompts.ts, would let council, debate and loop label variant participants the same way.

**Suggested regression test:** Extend test/patterns.test.ts. The existing test "one provider can run distinct models in a council, race and continued debate" (around line 289) already runs a race with contestants ["claude"] and roleSettings { claude: { model: "first", variants: [{ model: "second" }] } } and judge ["codex"]. Since the fake judge always picks "B", assert that the race run's summary:
- matches /Winner: Candidate B — claude · second/;
- matches /- A: claude · first — completed/ and /- B: claude · second — complet …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (home v4645r on port 4645, /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4645r). Everything below was done through the UI with Playwright, using the scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4645r/e4.mjs and e5.mjs.
1. Chose project MQTT-MCP, opened Run options > advanced, and set the workflow to "race".
2. Under Contestants, used "+ Add model" on Claude Code twice (Sonnet, then Haiku), so Claude Code ran 3 models: default, Sonnet and Haiku. Set the Codex model to GPT-B. The composer showed "4 agents · each model runs separately" and "Claude Code × 3 and Codex each solve it separately".
3. Left the check empty and clicked Start run. Run 2610252032-b458f15d finished as done.

The result in the UI (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4645r/001-result.png):
"Winner: Candidate B — claude on branch codeflow/2610252032-b458f15d/candidate-b"
All candidates: "A: claude …", "B: claude …", "C: claude …", "D: codex …". The words sonnet, haiku and gpt-b appear 0 times on the run page.

The run record holds the models: the steps carry settings {model:'sonnet'} for B, {model:'haiku'} for C and {model:'gpt-b'} for D, and roleSettings.contestants.claude.variants=[sonnet, haiku]. But facts={winner:'claude', entrants:['claude','claude','claude','codex']} and the artifacts are labelled "Candidate A (claude)" … "Candidate D (codex)".

Why it is not by design: docs/api.md:473 documents several models from one provider in Race as a supported feature ("Each entry runs separately with its own settings and session"). The supervisor pattern already names the model in its roster (src/patterns/supervisor.ts:69). The judge only sees the anonymized diffs, so naming the model in the summary that is written after judging does not break blind judging. Nothing in the tester's setup affects this, since the text is built in the pattern itself.

Severity: I raised it from cosmetic to minor. The race exists to find out which attempt was best, and here the winner's model cannot be found anywhere in the result. The artifact labels have the same gap.

Cleanup: through the UI I archived the run with "Remove its 5 worktrees" and "Also delete its branches" checked, then deleted it. In the MQTT-MCP  …

</details>

### t10-14 · minor · Pinned task rerun: an API 'revise' answer returns 200 and silently cancels the rerun

Source: tester unit ai-teams-patterns-1; observed with api; features TEAM-16.

**Repro**

> 1. Finished Team run -> Team details -> Rerun selected tasks -> select a task -> Start selected task rerun (child awaits 'Approve selected task rerun').
> 2. POST /api/runs/<child>/answer {decision:'revise', note:'change something'}.

**Expected:** 409 refusal like the plan-edit endpoint ('A selective rerun keeps its pinned task graph...'), keeping the rerun pending.

**Actual:** 200 {ok:true}; the child becomes cancelled with 'The selected task rerun was not approved. Create another rerun...'. In the UI the full card correctly disables 'Ask for changes', and the compact chat card is never shown for reruns, so the riskNote's predicted server error doesn't occur.

**Root cause (verifier):** src/engine.ts:4790-4797 RunManager.answer() validates only that the run is awaiting, that no plan write is in flight, and that a revise has a note. Unlike editTeamPlan() at src/engine.ts:4801, which throws TeamPlanEditError(..., 409) when run.teamRerun is set, answer() never checks run.teamRerun, so it resolves the waiter with {decision:"revise"}. The server route src/server.ts:2660-2665 then returns 200 {ok:true}. Ctx.approve (src/engine.ts:~1057-1074) journals that answer under remember("approval", title). In src/patterns/auto-team.ts:265-266, the pinned-rerun branch treats any decision other than approve as rejection: `if (approval.decision !== "approve") throw new RejectedError("The selected task rerun was not approved...")`. The run is cancelled, and because the revise answer is journaled, every later resume replays it and cancels again.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/team-rerun-engine.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/task-reruns.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/task-reruns.md`

**Suggested fix:** Make the engine boundary refuse the revision request, the same way the plan editor does, before the waiter is resolved. In RunManager.answer() (src/engine.ts ~4794), add:
`if (answer.decision === "revise" && run.teamRerun && run.awaiting?.kind === "plan") throw new TeamPlanEditError("A selective rerun keeps its pinned task graph. Reject it and create another rerun to change the selected tasks or instructions.", 409);`
attempt() in src/server.ts:583 already maps TeamPlanEditError to its status, so the route returns 409 and the run stays awaiting. The message could be a shared constant reused by editTeamPlan.
Keep the `!== "approve"` guard in src/patterns/auto-team.ts:266 as defense-in-depth for journals that already hold a revise answer. Optionally give it a clearer message when approval.decision === "revise".
Optionally add one sentence to docs/task-reruns.md:17 saying an API revise answer returns 409.
Separate small follow-up, not this bug: a cancelled rerun whose rejection is journal …

**Suggested regression test:** test/team-rerun-engine.test.ts, in "a pinned rerun resumes its actual accepted plan after restart and forbids plan editor replacement": right after the existing `assert.rejects(manager.editTeamPlan(child.id, {}), /keeps its pinned task graph/)`, add
`assert.throws(() => manager.answer(child.id, { decision: "revise", note: "change something" }), (e) => e.status === 409 && /keeps its pinned task graph/.test(e.message));`
then assert `child.status === "running"` and `child.awaiting?.title === "Appr …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4641 on 127.0.0.1:4641. The old v4641 home was moved aside to homes/v4641-prev-*, so the server started with an empty home. I created a scratch git repo with the same fixture as test/e2e/task-reruns.e2e.ts (prove:false, a node --test baseline).
1) API setup: POST /api/runs {pattern:"auto-team", task:"AUTO-SAME-PROVIDER Implement the sample", roles {coordinator:[claude], pool:[claude,codex]}, loop {check:"node --test"}, approvals {plan:true}}. The source plan was approved via /answer and the run finished done/completed (2610252028-7f089971).
2) UI (Playwright): opened the source run, Team details, Rerun selected tasks, checked "Rerun Beta dependent implementation", set budget 12, clicked "Start selected task rerun". Child 2610252029-fc42967b reached awaiting "Approve selected task rerun" with team.status awaiting_approval.
3) UI check: in the full awaiting card, with "change something" typed, "Ask for changes" is disabled, with title "Reject this pinned rerun and create another selection...". There was no compact .conversation-approval card. Screenshot: scratchpad/qa/shots/v4641/002-child-awaiting-card.png.
4) Control: POST /api/runs/<child>/team-plan returned 409 "A selective rerun keeps its pinned task graph. Reject it and create another rerun..." and the child stayed running/awaiting.
5) Bug: POST /api/runs/<child>/answer {decision:"revise", note:"change something"} returned 200 {"ok":true}. The event log shows "You chose to ask for changes: change something" and then the run turns status=cancelled with error "The selected task rerun was not approved. Create another rerun to change its selection or instructions." team.status stays "awaiting_approval".
6) Comparison: a second rerun (2610252029-507ca449) answered with an explicit reject ended in exactly the same state, so revise is silently treated as reject.
7) Irreversible: the UI then shows "Work is paused / Resume work". POST /resume on the revised child returned 200 {resumed:true}, but it replayed the journaled revise approval ("Resuming: replaying 5 recorded results") and cancelled again within about 60 ms. The rerun the caller wanted to keep cannot be recovered.
Not by design: docs/task-reruns.md:17 says a rerun's held plan "cannot be replaced through the plan editor or a coordinator revision request; reject it and create another selection". The plan editor enforces that with a 409 and the UI disables the button, but the /answer endpoint turns the forbidden request into a  …

</details>


## Continuation integration · 2026-10-26

Merged into `codex/dogfood-qa-continue` in `/Users/mx/.codex/worktrees/dogfood-qa-continue/code-flow`. Typecheck passes. All 13 targeted tests pass. Reviewed all ten fixer commits against the nine issue records. Race labels retain model names while the verified winner remains the primary artifact. Internal remaining time stays precise, with elapsed approval waits excluded; the UI normalizes editable minute inputs separately. Browser replay is still pending, so this is not yet independently verified.

Fresh continuation Chrome replay: direct replies can target the delivered integration result, and doing so invalidates team approval; worker branches are explicitly separate. This browser scenario passes alongside all 13 targeted tests. Other original issue repros still need independent live review, particularly long approval waits and real-provider model settings. Logs: `/private/tmp/codeflow-qa-continue/step1-browser.log` and `step1-browser-repaired.log`.

Original live probe (continuation): after 71.880 seconds waiting at the plan-approval card, a correction sent in the chat UI created a replacement with 1.992683 minutes remaining of 2; the prior clock recorded 439 ms of work. Approved replacement completed. Separate live HTTP team run retained Claude `haiku` and Codex `gpt-b` / `medium` in step receipts. Both use fake providers, no unexpected browser errors. Repro, result JSON and screenshots: `/private/tmp/codeflow-qa-continue/team-original-probes.mjs`, `team-original-probes/outcome.json`, `shots/lead-team/`. Isolated server PID 85034 stopped after the probes.
