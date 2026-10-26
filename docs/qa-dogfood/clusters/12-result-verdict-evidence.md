# Cluster 12 · result-verdict-evidence

**Run result verdicts: tampered tests shown as passed, race per-branch evidence, team verdict propagation, lifecycle API codes**

Status: **merged into continuation · targeted checks pass · original browser replays completed** · 11 issues · branch `qa-fix/result-verdict-evidence`

Planner notes: t07-2: a deleted or changed test shows 'Checks: Passed · Ready to review', and the integrity warning appears only inside the collapsed Details (ui/run.tsx:389, ui/experience.tsx, ui/run-evidence.tsx, src/run-status.ts). Put the warning in the verdict. t07-5: race branch evidence comes from one run.lastCheck field that each check overwrites (src/engine.ts:1698); store check results per branch. t06-6/t10-7/t11-4: on a clean apply, runTaskTeam (src/engine.ts ~4013-4027) never copies the child execution's verdict to the chat run. The card then says 'Not verified', or 'Ready' after a failed check. t07-18: 'Try two alternatives' state lives only on the client. API status codes: the resume route maps every error to 400, and resuming a finished run returns 200 (t07-11/S15-8, src/server.ts ~2565; use attempt()). The team API returns inconsistent codes (t11-12, the attempt() class list). A missing workspace file returns 400 with the absolute path from ENOENT (t08-14). /api/accounts parses JSON before dispatching, so GET gets 415 (S15-5). run-next-action owns the nextRunAction wording in ui/run-experience.ts. Duplicate groups: [["t06-6","t10-7","t11-4"],["t07-11","S15-8"]]

Likely files: `src/engine.ts`, `src/run-status.ts`, `ui/experience.tsx`, `ui/run.tsx`, `ui/run-evidence.tsx`, `src/task-team.ts`, `src/patterns/race.ts`, `src/server.ts`, `src/workspace.ts`, `ui/review.tsx`

## Fix result

Commits:
- `6a0e24a` Flag a pass that relies on changed tests where the result is summarised
- `3c1c568` Keep each race candidate's own check and show the winner first
- `5fd4167` Carry an AI team's check and review onto the chat that applied it
- `542042e` Keep a requested comparison and its preview across reloads
- `d672ff0` Answer busy and finished runs with 409, and refuse races without two contestants
- `22c9cc9` Answer stale team state with 409 and say what is actually wrong
- `be6364e` Answer a missing workspace file and unknown account operations with 404
- `12675cf` Cover the result verdict and evidence QA regressions

Fixer notes for the integrator: Shared test files: none edited. All new tests are in test/qa-result-verdict-evidence*.test.ts and test/e2e/qa-result-verdict-evidence.e2e.ts.

Behaviour changes other clusters may notice:
1. Busy-run refusals now throw RunConflictError (HTTP 409) instead of plain Error (400), with the same messages: archive/setArchived, recordOutcome, merge, mergePr, setTestRun, pullRequest, pushToPr, resume, and followUp when the run is running or starting. Tests that match only the message still pass.
2. RunManager.resume() itself still replays finished runs; run-storage and team-rollout tests depend on that. The refusal for a finished run with nothing queued is a new assertResumable(), called only by POST /api/runs/:id/resume.
3. Run gains branchChecks (per-branch done-when checks). checksLabel(run, _, branch) uses it for non-primary branches.
4. TeamContext.artifact() now replaces an existing artifact in place instead of moving it to the end, so artifacts[0] stays the primary result. The race lists its winner first.
5. TaskTeamTurn gains teamEvidence.
6. RoleSpec gains min (race contestants and debate debaters are 2). The participant counting moved into an exported roleParticipants().
7. setTaskPriority, resumeTaskTeam and taskResolution messages and codes changed as listed under t11-12. TeamTemplateStore.save throws TemplateConflictError for a stale expectedVersion and a separate 400 for a wrong version number.
8. IntegrityNote moved from ui/run.tsx to ui/run-evidence.tsx (exported).
9.  …

## Issues

### t07-2 · major · A deleted or changed test is shown as 'Checks: Passed · Ready to review'; the integrity warning is only in collapsed Details

**Fix outcome: fixed.** New integrityFor(run, branch) in src/run-status.ts combines run.integrity[branch] with follow-up integrity on that branch. ui/run-experience.ts adds checksSummary() and TESTS_CHANGED, so a flagged pass reads "Passed · tests changed". checksLabel is unchanged, so stats and the passed filter are unaffected. IntegrityNote moved from ui/run.tsx to ui/run-evidence.tsx. ResultStudio (ui/experience.tsx) sets attention, uses the heading "Check the test changes before merging" and renders the note outside ResultNextStep, so the linked-PR card shows it too. RunEvidence shows the evidence-warn class. ui/review.tsx renders the note in review-overview, outside "Publish changes". ArtifactCard skips it while reviewing. The ResultCard title reads "⚠ Finished — the check passes only with changes to the tests" (.result.flagged warning style in ui/styles.css). The engine verdict is unchanged; the reviewer  …

Fixer's check: Same steps as the tester on QA server f12 (fake agents, FAKE_TAMPER=1): added a scratch repo with a qa-tamper branch through "Open repository", then used the composer with "Start from branch" qa-tamper and check `node --test *.test.mjs`, once with Fix & review and once with Plan → Build → Review. Both runs ended done/passed with integrity deleted-test failing.test.mjs. With Details still collapsed, the result card read "Check the test changes before merging · Checks: Passed · tests changed · Review: Approved" and showed the visible "⚠ Changes to tests to check before merging — High failing.test.mjs test file deleted" note. The Review page showed Checks "Passed · tests changed" with class evi …

Tests: `test/qa-result-verdict-evidence.test.ts`, `test/e2e/qa-result-verdict-evidence.e2e.ts`

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-27, RUN-25.

**Repro**

> 1. In the scratch clone, create branch qa-tamper with failing.test.mjs (assert.ok(false)) and ok.test.mjs.
> 2. export FAKE_TAMPER=1; start a fake server; add the clone as a project.
> 3. Start 'Fix & review' (or 'Plan → Build → Review') from branch qa-tamper with check `node --test *.test.mjs`.
> 4. The builder runs `git rm failing.test.mjs`; the check passes; the fake reviewer approves.
> 5. Open the run page and Review changes.

**Expected:** Per docs/patterns.md, 'Every flagged result shows ⚠ Changes to tests to check before merging' where the user decides: the run's result card and the Review page should show the high-severity 'test file deleted' warning, and the checks should not read as a clean pass.

**Actual:** Thread: '**Approved, and node --test *.test.mjs passes**'. Result studio: 'Ready to review · Checks: Passed · Review: Approved'. The Review page header shows Checks 'Passed' (green), Agent review 'Approved' and no warning; the deleted file appears only as 'D failing.test.mjs' in the file list. The warning '⚠ Changes to tests to check before merging — High failing.test.mjs test file deleted' exists only in the artifact card inside the collapsed 'Details and publishing'. The only visible hint is a small ⚠ next to the run in the sidebar. (The approving reviewer is fake-harness behaviour; the hiding is the bug.)

**Root cause (verifier):** Five places combine so that the warning only appears inside a collapsed section while the visible labels say the checks passed:

1. **ui/run.tsx:389-394 (introduced in 57d34c8).** For finished runs with status "done", ResultCard renders only inside `<details class="result-details">`, which is collapsed by default. Line 391 is `{finished && run.status === "done" ? <ResultCard …/> : null}` inside that details element. The only renderer of the integrity warning is ArtifactCard at ui/run.tsx:1080 (`run.integrity?.[artifact.branch]?.length ? <IntegrityNote …/>`), and ArtifactCard is only reachable through ResultCard. So the warning is hidden until the user expands "Details and publishing".

2. **ui/experience.tsx:89-93 (ResultStudio, the visible primary card).** `attention` is computed only from `checks === "Failed"` or the review labels. The card never reads `run.integrity[tree.branch]`, so it shows "Ready to review" and "Checks: Passed · Review: Approved".

3. **src/run-status.ts:6-16 (checksLabel).** It returns "Passed" from `run.verdict === "passed"` and ignores `run.integrity`. src/patterns/pipeline.ts:170 (`if (ctx.hasCheck) ctx.setVerdict(green ? "passed" : "failing")`) sets that …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-evidence.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/review.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-status.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/result-next-step.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/result-delivery.e2e.ts`

**Suggested fix:** Surface the flag wherever the result is summarised. Leave the engine's verdict alone: the reviewer deciding is the documented design.

1. **Shared helper.** Add `integrityFor(run, branch)` in src/run-status.ts, returning `run.integrity?.[branch]` plus any follow-up `turn.integrity` for that branch. Re-export it through ui/state.ts.
2. **Move IntegrityNote.** Take it out of ui/run.tsx into a shared module such as ui/run-evidence.tsx so ResultStudio, the Review page and ArtifactCard can all render it.
3. **ResultStudio (ui/experience.tsx:89-96).** When `integrityFor(run, tree.branch)` is non-empty, set `attention`. Change the heading to something like "Check the test changes before merging", and render `<IntegrityNote>` inside the primary card above or below the "Checks: … · Review: …" line. This also covers the ResultNextStep merge path for linked PRs, which merges without opening Details.
4. **RunEvidence (ui/run-evidence.tsx).** Accept the branch's issues. When there are any, show Che …

**Suggested regression test:** 1. **Unit test in test/run-experience.test.ts (or test/run-status.test.ts).** Build a run with `verdict: "passed"`, `artifacts: [{ branch: "b" }]` and `integrity: { b: [{ kind: "deleted-test", file: "failing.test.mjs", detail: "test file deleted", severity: "high" }] }`. Assert:
   - the new display helper does not return the clean "Passed" for branch "b" (e.g. returns "Passed · tests changed");
   - `integrityFor(run, "b").length === 1`;
   - ResultStudio's attention predicate is true.

2. **Br …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this twice on a fresh fake-mode QA server, home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4685t07, started with FAKE_TAMPER=1 exported. I could not use my assigned ports: 4685 was held by another verifier's server (home v4683t07) and 4687 by v4687's server. I did not touch either and ran on the unused odd port 4497 instead.

Setup:
1. Created a scratch repo with a bare origin at .../qa/clones/v4685t07. Branch main has math.mjs (a broken add). Branch qa-tamper adds failing.test.mjs (assert.ok(false)) and ok.test.mjs.
2. Added it through the UI ("Open another repository", project "v4685 tamper").

Runs, both started from the composer with Start from branch = qa-tamper and check "node --test *.test.mjs" (scripts in .../qa/work/v4685t07, s04-run.mjs and s05-view.mjs):
- Fix & review, run 2610252010-ab5abde8. Steps: the fake builder ran `git rm failing.test.mjs`, the check passed, the proof step asked for a test and a fix round followed, the check passed again, and the fake reviewer approved.
- Plan → Build → Review, run 2610252012-f84ca60f. Same outcome.

API state for both runs: status=done, verdict=passed, integrity={"codeflow/<id>/build":[{kind:"deleted-test",file:"failing.test.mjs",severity:"high"}]}. The server log line "Result: changes to tests to look at before merging: high failing.test.mjs test file deleted" was written.

What the UI showed (no console errors or 5xx):
- **Run page:** the answer reads "**Approved, and node --test *.test.mjs passes**". The asterisks render literally, which is a separate cosmetic Markdown issue. The primary card shows "Ready to review · Checks: Passed · Review: Approved". `details.result-details` has open=false. The `.integrity` element is in the DOM but not visible, and the text "Changes to tests to check before merging" is not visible. The only cue is a small ⚠ next to the run in the sidebar.
- **Review changes page:** the header shows Checks "Passed" with class evidence-ok (green) and Agent review "Approved". The file list shows "D failing.test.mjs +0 −4". The integrity note is not visible.
- **Where the warning does appear:** only after expanding "Publish changes" on the Review page, or "Details and publishing" on the run page. Even there, the card's own header reads "✓ Finished — the check passes", with the warning "⚠ Changes to tests to check before merging — High failing.test.mjs test file deleted" below it.

Screenshots …

</details>

### t07-5 · major · Race results: only the candidate whose check ran last shows 'Checks: Passed'; the others show 'Not verified for this branch'

**Fix outcome: fixed.** src/engine.ts check() now also saves run.branchChecks[branch] = {ok, command, head, at} for every done-when check, next to lastCheck. checksLabel (src/run-status.ts) judges a branch other than the primary result (artifacts[0]) by that branch's own record. It never applies run.verdict to another branch and ignores a verification report from another branch. The primary result keeps the verdict rules, so Loop withholding still works, and runs saved before this change keep the old fallback. src/patterns/race.ts lists the winner first. TeamContext.artifact() now replaces an artifact in place instead of moving it to the end, so a follow-up doesn't reorder results. ResultStudio's result branches follow artifact order and default to the primary result.

Fixer's check: Same requests as the tester and verifier on f12: POST /api/runs pattern race, contestants codex+claude, judge codex. With check `true`, A's check finished last and the judge picked B. B is now the default "Result branch" with "Checks: Passed", and both A and B show Checks Passed on the result card and the Review page; before, the winner read "Not verified for this branch". With the branch-dependent check (A passes, B fails last), A is the default with Passed, and B shows "Changes need attention · Checks: Failed" on the result card and Failed on Review; before, A read "Not verified" and the failing B read "Passed". branchChecks matched {a:true,b:false}. No browser errors. New engine and e2e t …

Tests: `test/qa-result-verdict-evidence.test.ts`, `test/qa-result-verdict-evidence-engine.test.ts`, `test/e2e/qa-result-verdict-evidence.e2e.ts`

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-28.

**Repro**

> 1. Fake server; scratch clone project.
> 2. Start 'Best-of-N race' with contestants Codex and Claude Code, judge Codex, check `true` (API: pattern 'race').
> 3. After it finishes, both 'Check candidate A' and 'Check candidate B' steps say 'Passed'.
> 4. Open the run's result studio and Review changes for each candidate branch.

**Expected:** Both candidate branches show 'Checks: Passed' (each was checked and passed), and the result studio defaults to the judge's winner.

**Actual:** Run 2610251521-33e63e1c: the winner candidate-b shows 'Checks: Not verified for this branch · Review: Not recorded for this branch' in the result studio and on Review, while the losing candidate-a shows 'Checks: Passed'. Run 2610251522-b21bcdde: the result studio defaults to the loser candidate-a and shows 'Not verified for this branch'; candidate-b shows Passed. Which branch gets 'Passed' depends only on which check finished last.

**Root cause (verifier):** Branch evidence comes from one overwritten field. On top of that, the run-level verdict (the winner's) is applied to whichever branch was checked last.

1. src/engine.ts:1698 `this.run.lastCheck = { ok: result.ok, command, worktree: wt.name, at: Date.now() };`. Every check overwrites this single record. The race pattern runs the candidates' checks in parallel inside ctx.parallel (src/patterns/race.ts:65), so the last check to finish wins. The per-worktree map that does exist, `lastChecks` (src/engine.ts:887/1707), is private engine memory and is never saved to the run.

2. src/run-status.ts:9-10. `checkedBranch = run.verification?.branch ?? run.worktrees.find(t => t.name === run.lastCheck?.worktree)?.branch; if (branch && checkedBranch !== branch) return "Not verified for this branch";`. Any branch other than the last-checked one is reported as unverified.

3. src/run-status.ts:12-14. For the branch that does match, the label comes from run.verdict, not from lastCheck.ok. src/patterns/race.ts:152 sets the verdict from the winner (`ctx.setVerdict(winner.check?.ok ? "passed" : "failing")`). So when a losing candidate's failing check finishes last, that failing branch is labelled "Pas …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-status.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/race.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/result-delivery.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`

**Suggested fix:** 1. Save per-branch check evidence. In the check path in src/engine.ts, next to the lastCheck assignment around line 1698, also record `run.branchChecks = { ...run.branchChecks, [wt.branch]: { ok, command, head, at } }`. Skip proof and other non-result worktrees. Add the field to the Run/RunSummary types and the Evidence pick in src/run-status.ts. Clear or refresh an entry when its branch moves, the same way testCounts and reuse are keyed by head.

2. Fix checksLabel(run, checking, branch) in src/run-status.ts. When a branch is given and `run.branchChecks?.[branch]` exists, return Passed or Failed from that record's `ok`, still respecting checkCantRun and a verification report whose `branch` matches. Never apply run.verdict to a branch other than the one it belongs to. Only fall back to "Not verified for this branch" when that branch has no record. Keep the existing lastCheck/verification fallback for runs saved before the change.

3. Make the winner explicit:
   - In src/patterns/race. …

**Suggested regression test:** - **test/run-experience.test.ts** (pure function): a race-shaped run with worktrees candidate-a/candidate-b and verdict "passed".
  - With branchChecks {a: ok, b: ok} and lastCheck naming candidate-a, assert checksLabel(run, false, "…/candidate-b") === "Passed".
  - With branchChecks {a: ok, b: failed}, verdict "passed" and lastCheck = {ok:false, worktree:"candidate-b"}, assert checksLabel(run, false, "…/candidate-b") === "Failed" and checksLabel(run, false, "…/candidate-a") === "Passed". Today  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4691rc, on port 4691 with a new home. I made a scratch clone of MQTT-MCP at clones/v4691-mqtt(.git) and registered it as project p-d289d339 using POST /api/projects. I started two runs with POST /api/runs, pattern "race", contestants [codex, claude], judge [codex].

Run 1, 2610252009-c726deec, check `true`:
- Both "Check candidate A" and "Check candidate B" finished "done". B's check finished first (end time ...970) and A's last (...979).
- The judge picked candidate B (claude). Stored state: run.lastCheck.worktree = "candidate-a", verdict = "passed".
- In the UI (headless Chrome, script work/v4691rc/view.mjs) the result studio defaulted to candidate-a, the loser, and showed "Checks: Passed · Review: Not recorded".
- After I chose candidate-b (the winner) in the "Result branch" select, it showed "Checks: Not verified for this branch · Review: Not recorded for this branch".
- The Review page showed the same: candidate-a "Checks Passed", candidate-b "Checks Not verified for this branch / Agent review Not recorded for this branch".

Run 2, 2610252010-5f33d615, a branch-dependent check that I added to test a stronger variant: `case "$(git rev-parse --abbrev-ref HEAD)" in *candidate-a) exit 0;; *) sleep 3; exit 1;; esac`:
- "Check candidate A" passed. "Check candidate B" FAILED and finished last.
- Candidate A won without a judge, so verdict = "passed". But lastCheck = {ok:false, worktree:"candidate-b"}.
- The UI showed the winner, candidate-a (passed), as "Checks: Not verified for this branch". It showed the losing candidate-b, whose check FAILED, as "Checks: Passed", both in the result studio and on the Review page (screenshot shots/v4691rc/006-2610252010-5f33d615-studio-candidate-b.png).
- The run summary on the same page says "B: claude — completed, check fails".

No console errors or 5xx responses. Nothing in docs/patterns.md or docs/verification.md describes this as intended. The existing unit test "reviewing another branch cannot borrow the winning branch's verification" (test/run-experience.test.ts:42) shows the intent is that the winning branch keeps its verification. That is broken here.

Cleanup: both runs were archived (worktrees removed, branches deleted) and then deleted through the UI (GET returns 404). Server stopped, scratch clones removed. No leftovers apart from the QA home homes/v4691rc and the browser profile profiles/v4691rc.

</details>

### t06-6 · major · AI-team chat whose team execution failed its check shows 'Ready to review · Checks: Not verified'

**Fix outcome: fixed.** In src/engine.ts runTaskTeam, a clean (non-reconciled) apply now calls recordTeamEvidence. It first resets the chat's lastCheck, verdict and verification. If the workspace checkpoint tree equals the tree of turn.result, it records turn.teamEvidence = {tree, check from child.branchChecks at turn.result, review from the child's non-stale findings at that head or else team.verification at that head}. It then sets run.lastCheck (worktree solo) and run.verdict from the team's check. New field in src/task-team.ts TaskTeamTurn. agentReviewLabel reads teamEvidence after reviewStale and resolutionReview. executionLabel, needsYou and localDeliveryProblem treat a failing team check or a rejected team review as needing attention. ResultStudio never shows "Ready to review" under "Needs attention". ui/task-team.tsx shows "Failed · work preserved" for a failed child and a one-line evidence note.

Fixer's check: Repeated the tester's steps on f12: composer on a registered scratch project, AI team switch On, plan approval off, Run options check `echo nope; false`, sent "AUTO-MINIMAL implement the requested result". The child stopped with lastCheck failing, and its files were applied cleanly. The chat now carries lastCheck {ok:false, worktree:solo} and verdict failing. The card reads "Changes need attention · Checks: Failed · Review: Approved" (the reviewer approved; the team was blocked by the failing check) under the "Needs attention" pill, with "Stopped · work preserved" and Resume team. Before, it read "Ready to review · Checks: Not verified for this branch · Review: Not recorded". No browser erro …

Tests: `test/qa-result-verdict-evidence-engine.test.ts`, `test/qa-result-verdict-evidence.test.ts`

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-02.

**Repro**

> 1. Composer → Agent (Codex), toggle AI team On, Run options check 'echo nope; false'. 2. Send a task and wait for the child team execution to finish. 3. Read the chat result card and Review changes.

**Expected:** The chat shows that the team execution failed and that the check failed (failing evidence), not an inviting 'Ready to review'.

**Actual:** Pill 'Needs attention', team line 'Stopped · work preserved 0/1 complete' (child 2610251449-4f8eb5e4 is 'failed'), result card 'Ready to review — Checks: Not verified for this branch · Review: Not recorded', Review page 'Checks: Not verified'. The failing check ('Checks: echo nope; false: failed') only exists in teamTurns[].report; the failed team's files were integrated into the chat worktree.

**Root cause (verifier):** The child's verdict never reaches the chat run when the team result is applied cleanly.

- src/engine.ts:4013-4027 (runTaskTeam): when the child finishes in any status (done, stopped or failed), the integration result is applied into the chat worktree (line 4021, applyTaskTeamResult) and turn.state is set to "applied". Evidence for the chat is only produced at line 4023: `if (applied.reconciled) await this.checkTaskResolution(...)`. A clean apply (the user made no edits) leaves the chat workspace tree identical to turn.result, and in that case nothing is copied over:
  - the child's lastCheck/verdict ("failing") goes nowhere;
  - its team.verification (reviewed, approved:false) goes nowhere;
  - the parent's run.lastCheck, run.verdict, turn.resolutionCheck and turn.resolutionReview all stay undefined;
  - the failure only appears as text in turn.report (line 4028).
- Because of that, the chat-level UI cannot see the failure:
  - src/run-status.ts:9-10 (checksLabel): checkedBranch is undefined, so it returns "Not verified for this branch".
  - ui/run-experience.ts:22-35 (agentReviewLabel): there is no resolutionReview, so it returns "Not recorded".
  - ui/experience.tsx:89-92 (Resul …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/task-team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-status.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/task-team.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/task-team.e2e.ts`

**Suggested fix:** 1. Engine fix in src/engine.ts runTaskTeam, around lines 4021-4024. After a clean (non-reconciled) apply, the chat workspace tree equals turn.result, which is the commit the child checked. Carry the child's evidence onto the turn and the chat:
   - Set `turn.resolutionCheck = { ok: child.lastCheck.ok, command: child.lastCheck.command, output: <child gap / check summary> }` when child.lastCheck exists.
   - Set `run.lastCheck = { ok, command, worktree: "solo", at }` and `run.verdict = ok ? "passed" : "failing"`, the same way checkTaskResolution does.
   - Only reuse a result that was taken on the child's final head (child.team.verification.head === turn.result, or the lastCheck commit matches). Otherwise call `this.checkTaskResolution(run, turn, path)` so the check runs again on the chat workspace.
   - Optionally also copy the child's independent-review outcome into turn.resolutionReview (approved = child.team.verification.approved), so Agent review is not "Not recorded".
2. Once those …

**Suggested regression test:** 1. Unit test in test/task-team.test.ts, next to "resolved changes cannot inherit a stale passing check". Use a stub auto-team pattern that writes a file in the integration worktree, commits it, sets `ctx.run.lastCheck = {ok:false, command:"node -e \"process.exit(1)\"", worktree:"integration", at}`, sets verdict "failing" and team.status "blocked", and leaves the parent workspace untouched so the apply is clean. Start the solo parent with taskTeam enabled and loop.check failing, then `await done( …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: `qa-server.sh start v4647 4647 fake`, with a new home (I moved the old one aside to homes/v4647-prev-201738) and no FAKE_* env vars. I added a scratch clone of MQTT-MCP (clones/v4647-mqtt) through the UI using "Open another repository", which created project p-d02c8bce. Then I used the composer with a fresh browser profile: Provider → Codex, AI team switch On, Run options check `echo nope; false`, task "Add a small sample file for the MQTT project (v4647 t06-6 verification)", Send. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4647/t06-6/ (b2-run.mjs, b2.log, b3-review.mjs, b3.log).

What I saw:
- The chat (run 2610251920-9017a9d5) ended `done` with lastCheck, verdict and verification all undefined. Its teamTurns entry was `{executionStatus:"stopped", state:"applied"}`, with no resolutionCheck and no resolutionReview.
- The child (2610251920-068b36a1) ended `stopped` with stopReason "unresolved team work", lastCheck `{ok:false, command:"echo nope; false", worktree:"integration"}`, verdict "failing", team.status "blocked". Its gaps included "The configured check fails on the final result".
- The team's file `claude-alpha.txt` was applied, untracked, into the chat's solo worktree.
- The UI showed the pill "Needs attention", a team line "Stopped · work preserved 0/1 complete" with a Resume team button, and a result card headed "Ready to review" with "Checks: Not verified for this branch · Review: Not recorded" (screenshot shots/v4647/004-final.png).
- The Review page showed "Execution Needs attention · Checks Not verified for this branch · Agent review Not recorded" over the +1 file diff, with Publish changes available (shots/v4647/002-review.png).
- The only places the failing check appeared were the collapsed "View activity" text (the child's error string) and teamTurns[].report ("Checks: echo nope; false: failed").

Differences from the report: the child was `stopped`, not `failed`. The reporter's run was in their phase P3 with FAKE_CLAUDE_FAIL=rejected, which explains the `failed` status. So "Stopped · work preserved" is accurate in a clean setup and matches docs/auto-team.md ("A blocked Auto run is stopped, with its work available"). The main defect, failing check evidence hidden behind "Ready to review / Not verified", reproduces cleanly. No docs or code comments describe hiding it as intended; the "Execution and evide …

</details>

### t10-7 · minor · Conversation result card says 'Checks: Not verified · Review: Not recorded' after a verified AI-team result is applied

**Fix outcome: duplicate.** Fixed by t06-6 (clean-apply team evidence in src/engine.ts recordTeamEvidence/expireTeamEvidence, TaskTeamTurn.teamEvidence, label readers). When a later turn changes the workspace (conversationResult compares the checkpoint tree), the evidence and the solo lastCheck are dropped, so the card falls back to Not verified / Not recorded.

Fixer's check: On f12 a composer AI-team chat whose check passes once the team writes claude-alpha.txt finished verified (child team.verification check passed, reviewed, approved, at the applied head). After a reload the card read "Ready to review · Checks: Passed · Review: Approved" instead of "Not verified for this branch · Not recorded". Then I turned AI team off and sent a direct message, and the fake agent wrote a file. teamEvidence, lastCheck and verdict were cleared, and the card read "Checks: Not verified for this branch · Review: Not recorded". The engine test covers the same sequence.

Tests: `test/qa-result-verdict-evidence-engine.test.ts`, `test/e2e/qa-result-verdict-evidence.e2e.ts`

Source: tester unit ai-teams-patterns-1; observed with real-agents; features TEAM-01, TEAM-06.

**Repro**

> 1. Agent conversation with AI team On, check configured (e.g. grep -q "Quick check" README.md).
> 2. Send a work request. Approve the plan and let the team finish verified (check passes, independent review approved).
> 3. Look at the 'Ready to review' card under the lead's reply.

**Expected:** The card reflects the team's verification of exactly this tree (check passed, review approved), or explains that the conversation branch is unverified.

**Actual:** The lead's reply says 'Independent review approved it, and the configured check passed', but the card shows 'Checks: Not verified for this branch · Review: Not recorded'. When the result is reconciled with user edits and 'Refresh review' runs, the card shows 'Checks: Passed · Review: Approved'. So the cleanly applied case looks less verified than the merged one.

**Root cause (verifier):** src/engine.ts:4021-4024 (runTaskTeam, after the team finishes): `const applied = await applyTaskTeamResult(...); turn.state = "applied"; ... if (applied.reconciled) await this.checkTaskResolution(run, turn, params.cwd.path);`. Only the reconciled path writes evidence onto the conversation run. checkTaskResolution (src/engine.ts:4033-4058) sets run.lastCheck = {worktree:"solo"} and run.verdict. A later "Refresh review" (src/engine.ts:4095-4128) sets turn.resolutionReview. On a clean apply (applyTaskTeamResult returns {reconciled:false}, src/task-team.ts:119-132), none of the child's evidence (child.lastCheck, child.team.verification {check, reviewed, approved, proof, head}) is copied to the parent or the turn. The card at ui/experience.tsx:89-93 then shows:
- Checks: checksLabel(run, false, tree.branch). In src/run-status.ts:9-10, checkedBranch is undefined because there is no run.verification or run.lastCheck, so it returns "Not verified for this branch".
- Review: agentReviewLabel(run, tree.branch). In ui/run-experience.ts:22-35 there is no resolutionReview, no findings, no run.review, and run.team is undefined for a solo run, so it returns "Not recorded".
nextRunAction (ui/run-ex …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/task-team.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-status.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/result-delivery.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/task-team.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/task-team.e2e.ts`

**Suggested fix:** 1. In src/engine.ts, in the clean-apply branch (applied.reconciled === false), when child.status === "done" and child.team?.verification exists, record the team's evidence on the turn, but only if the head it verified has the same tree as turn.result and the conversation checkpoint after apply has that tree too. Store it in a new optional field, for example turn.teamEvidence = { head, tree, check, reviewed, approved, proof, command } (add it to TaskTeamTurn in src/task-team.ts).
2. If the check passed, mirror what checkTaskResolution does: set run.lastCheck = { ok, command: child.lastCheck.command, worktree: "solo", at } and run.verdict = "passed" or "failing". checksLabel then resolves the solo branch and shows "Passed" with no change to run-status.ts. If the repo has no runnable check, keep "Not verified" and don't invent a pass.
3. In ui/run-experience.ts agentReviewLabel, after the reviewStale and resolutionReview checks, return "Approved" or "Changes requested" from the latest tur …

**Suggested regression test:** test/task-team.test.ts: add a test, or extend "Agent → Team → Agent retains one task...", that uses a stub auto-team whose child ends done with lastCheck {ok:true} and team.verification {check:"passed", reviewed:true, approved:true, head:<integration commit>}. After followUp plus done(run), assert run.teamTurns[0].state === "applied" and run.lastCheck?.worktree === "solo". On the summary, assert checksLabel(summary, false, run.worktrees[0].branch) === "Passed" and agentReviewLabel(summary, branc …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server "v4627t107" on 127.0.0.1:4627 (new home, no prior runs). Scratch fixture git repo at scratchpad/qa/clones/v4627-fixture with a README.md containing "Quick check". I did not touch any user project.
1. Created an Agent conversation through the API: solo, claude, loop.check "test -f claude-alpha.txt". The fake team writes claude-alpha.txt, so the check fails before the change and passes after it, and the fail-to-pass proof can succeed. The first reply finished.
2. In the UI, turned on the composer's "AI team" switch, opened Advanced, ticked "Enable AI team", set lead claude and providers claude+codex, and clicked "Apply team settings". Then typed "AUTO-MINIMAL implement the requested result" in the composer and clicked Send.
3. Result: team child 2610252023-415eb436 finished with status done. child.lastCheck = {ok:true, worktree:"integration"}. child.team.verification = {check:"passed", reviewed:true, approved:true, proof:"proven", head:e955294}. On the parent conversation 2610252023-d9417e91, teamTurns[0].state = "applied" with no resolutionCheck and no reviewStale. The parent's lastCheck, verification, verdict and review were all undefined, and findings was {}.
4. After a reload, the card read: "Ready to review | Checks: Not verified for this branch · Review: Not recorded". The team disclosure above it said "Finished 1/1 complete". Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4627t107/002-team-done-card.png
5. I checked that the card describes exactly the verified tree. In the conversation's solo worktree I used a temporary index (read-tree HEAD + add -A, untracked files included) and ran write-tree: 9b5e3ef. That equals the tree of the team-verified head e955294 (9b5e3ef). The lead's turn after the team runs read-only (test/task-team.test.ts:62 asserts mode "read"), so nothing changes the tree after verification.
Side observation: my first attempt used check `grep -q "Quick check" README.md`. That check already passes at baseline, so the team stopped on "Fail-to-pass evidence is unproven" (executionStatus "stopped"), and its result was still applied (turn.state "applied"). That is a separate path and not this issue.
Arguments against confirming that I checked: docs/runs.md:64 says plain agent conversations don't run checks automatically, so "Not verified" is normal for an ordinary conversation turn. Here, though, exact-tree evidence exists and  …

</details>

### t11-4 · minor · Chat result card says 'Checks: Not verified for this branch · Review: Not recorded' after a verified AI team turn

**Fix outcome: duplicate.** Fixed by t06-6 (same root cause: the child execution's verification was never carried onto the chat on a clean apply).

Fixer's check: Same setup as the t11-4 verifier on f12 (fixture with package.json test = node check.mjs and .codeflow/config.json {prove:false}): composer with AI team on, plan approval off, Done when `npm test`, sent AUTO-MINIMAL. Chat 2610260247-4842c1dd now has lastCheck {ok:true, worktree:solo} and verdict passed. The card reads "Ready to review · Checks: Passed · Review: Approved", matching the lead's report. The browser e2e for the fake team path checks the same text.

Tests: `test/qa-result-verdict-evidence-engine.test.ts`, `test/e2e/qa-result-verdict-evidence.e2e.ts`

Source: tester unit ai-teams-patterns-2; observed with real-agents; features TEAM-23, TEAM-19.

**Repro**

> 1. QA server (real or fake). 2. New chat with AI team on and a configured check (e.g. 'test -f docs/qa-team-note.md'). 3. Send a work request; let the team finish (execution shows check passed and independent review approved). 4. Look at the 'Ready to review' card in the chat.

**Expected:** The card reflects the team's verification (check passed, review approved) or clearly points to it.

**Actual:** 'Checks: Not verified for this branch · Review: Not recorded' while the lead's own reply says the check passed and review approved. Real: chat 2610251529-2b0ab3e0 / exec 2610251529-a7deed0a (verification {check:passed, reviewed:true, approved:true}); fake C1, C6, C10.

**Root cause (verifier):** The team's verification stays on the child execution. In the common clean-apply case nothing copies it to the chat run that the card reads.

- src/task-team.ts:124: applyTaskTeamResult returns {reconciled:false} when the workspace had no concurrent user edits. The applied tree then equals the team's verified integration head.
- src/engine.ts:4021-4023 (runTaskTeam): on that path it sets turn.state="applied" and calls checkTaskResolution only `if (applied.reconciled)`.
- src/engine.ts:4028: the child's check result is written only into the free-text turn.report, which the lead paraphrases ("check passed, review approved").
- src/engine.ts:4034-4060 (checkTaskResolution): the only code that sets run.lastCheck (worktree "solo", line 4056), run.verdict and turn.resolutionCheck on the chat.
- Nothing ever copies child.team.verification (check/reviewed/approved/head) or child.lastCheck onto the turn or the parent.

The card then reads only parent fields:
- ui/experience.tsx:89 calls checksLabel(run, false, tree.branch).
- src/run-status.ts:10: with no run.verification or run.lastCheck, checkedBranch is undefined, so the label is "Not verified for this branch". This wording appears even w …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/task-team.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-status.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/task-team.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/task-team.e2e.ts`

**Suggested fix:** The server should record the team's evidence on the turn when the result is applied; the label functions should then read it, and it should expire when the workspace changes.

1. Store the evidence (src/task-team.ts TaskTeamTurn, src/engine.ts runTaskTeam around 4021-4024):
   - Add a field such as `teamVerification?: { check?: "passed"|"failed"|"unchecked"; command?: string; reviewed: boolean; approved?: boolean; head: string }`.
   - Fill it only when all of these hold: the clean path (`!applied.reconciled`), child.status === "done", and turn.result === child.team.verification.head (or an equal tree).
   - Source it from child.team.verification plus child.lastCheck.
   - For reconciled applies keep today's behaviour: checkTaskResolution runs, and reviewStale marks the review outdated.
   - Optionally also set run.lastCheck = {ok, command, worktree:"solo"} and run.verdict from it, so the server-side checksLabel users (stats, notifications, review inbox) agree. Label that check as the  …

**Suggested regression test:** Three levels:

1. Unit, test/run-experience.test.ts: build a solo chat RunSummary with artifacts [{branch:"codeflow/x/solo"}], worktrees [{name:"solo", branch:"codeflow/x/solo"}] and teamTurns [{state:"applied", executionStatus:"done", teamVerification:{check:"passed", reviewed:true, approved:true, head:"h"}}].
   - Assert checksLabel(run, false, "codeflow/x/solo") === "Passed" and agentReviewLabel(run, "codeflow/x/solo") === "Approved".
   - With reviewStale:true, assert "Review outdated".
   - …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4609t114" on 127.0.0.1:4609 with a new home. I made my own scratch fixture repo (copy of the t11 fixture: check.mjs, package.json with "test": "node check.mjs", .codeflow/config.json {prove:false}) and registered it through the UI ("Open another repository" -> new project p-42ae9613). Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4609t114/ (01-addrepo, 03-team-chat, 04-plain-chat, 05-labels, 09-cleanup).

1. In the New run composer (Agent workflow) I turned "AI team" on, turned off "Let me approve the plan" in Advanced, and confirmed Run options showed "Done when this passes: npm test". I sent "AUTO-MINIMAL implement the requested result".
2. The chat 2610251941-a93cd650 delegated to execution 2610251941-e8e28c74, and both finished "done".
   - Child: verdict "passed", lastCheck {ok:true, command:"npm test", worktree:"integration"}, team.verification {head:b5343ea, check:"passed", reviewed:true, approved:true}.
   - Parent turn: state "applied", reconciliation none, report "Independent review completed; approved. `npm test` passes."
   - Parent run: lastCheck, verdict, verification, review, findings and team are all undefined.
3. turn.result (b5343ea) equals the child's verified head. Its tree 219c211 is identical to the verified tree, and the chat worktree contains exactly the applied file (claude-alpha.txt). So the verified content is what sits in the chat workspace.
4. After reload, the chat's result card (.result-compact) reads "Ready to review / Checks: Not verified for this branch · Review: Not recorded". Team activity shows "Finished 1/1 complete". Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4609t114/003-chat-done.png
5. Control: a plain Agent chat with AI team off (2610251942-bb135914), same project and same npm test check, shows the identical card text. The team's verification therefore adds nothing to the card.
6. Running ui/run-experience.ts on the captured parent JSON with tsx gave checksLabel(run,false,soloBranch) = "Not verified for this branch", checksLabel(run) = "Not verified" and agentReviewLabel = "Not recorded".

Attempts to refute:
- Selector or environment: no. The card text is read from the DOM after reload, there were no console errors, and the data comes straight from the server.
- By design: not shown by docs or t …

</details>

### t07-18 · minor · 'Try two alternatives' re-enables 'Build both' after reload and forgets the preview command

**Fix outcome: fixed.** In ui/experience.tsx Alternatives, an existing grouped pair counts as a requested comparison. The form is replaced by "Comparison requested <time>. Each alternative keeps its own run and preview." and a "Try another pair…" button. That button reopens the form prefilled with the instructions the existing pair used (the task prefix is stripped) and offers Cancel, so a second comparison takes a deliberate step. AlternativePreview fetches GET /serve on mount. If a preview is running, it restores the command and gets the iframe origin from POST /api/preview, which reuses the same proxy. Otherwise it prefills the command from serve/config. This is best effort; starting a preview by hand still reports errors.

Fixer's check: Ran the verifier's repro script on f12 against a finished Agent run in a scratch repo. Built both alternatives, entered "python3 -m http.server $PORT --bind 127.0.0.1" for A, started the preview, then reloaded and reopened the section. No textareas and no "Build both alternatives" button appeared; the status read "Comparison requested …". A's Preview command field still held the command and the iframe came back without a click. "Try another pair…" showed the textareas prefilled with "F12 alt A: compact" / "F12 alt B: spacious" rather than the defaults. Cancel returned to the requested state, and /api/runs still listed exactly 2 grouped children. No browser errors. The new e2e fails on base a …

Tests: `test/e2e/qa-result-verdict-evidence.e2e.ts`

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-32.

**Repro**

> 1. On a finished run: More options > Try two alternatives > Build both alternatives (two grouped children are created).
> 2. Enter a Preview command for Alternative A and start the preview.
> 3. Reload the run page and reopen the section.

**Expected:** The launched comparison stays acknowledged ('Comparison requested'); the preview command and running preview are kept.

**Actual:** The A/B textareas reset to the defaults and 'Build both alternatives' is enabled again, so a second comparison can be launched by mistake. The preview command field is empty and the iframe is gone. (Phone width 390px renders without overflow.)

**Root cause (verifier):** The cause is in ui/experience.tsx (dogfood-qa at f14f404). Both the comparison lock and the preview command/iframe exist only in client component state, and nothing rebuilds them from the server on mount.
- experience.tsx:113-114: Alternatives keeps the A/B texts and `launched` in `useState`. `launched` starts as false on every mount and is set only inside `launch()` (line 118). A reload therefore re-enables the button even when the server already has grouped children.
- experience.tsx:115-117: `siblings`/`pair` are worked out from the `runs` store, which proves a comparison exists. But line 119 shows the form with `{!run.group ? <>textareas + button</> : null}` and never checks `pair.length`/`siblings.length`. The disabled check is `!head || busy || launched || ...` and also ignores the existing siblings.
- experience.tsx:116-117: `pair` only shows the newest group (`siblings[0]`). A second launch therefore hides the first pair.
- experience.tsx:122: AlternativePreview keeps `preview` (the iframe origin) and `command` in `useState`. `command` is filled only from `run.app?.command`, which is undefined for a command typed in this card. The card never calls GET `/serve` or GET `/serv …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/experience.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/application-improvements.md`

**Suggested fix:** 1. Alternatives (experience.tsx:112-119): treat an existing grouped pair as the launched state. Let `alreadyLaunched = launched || pair.length > 0`.
   - When `alreadyLaunched`, replace the form with a "Comparison requested" note giving the group's labels and creation time.
   - Add a separate secondary action, "Try another pair…", that opens the form only when clicked. This keeps the docs' "request another" path but makes it deliberate.
   - When reopening the form, prefill A/B from the existing children's tasks by stripping the `${run.task}\n\nExplore this alternative from the supplied result:\n` prefix, instead of reverting to the hard-coded defaults.
   - Optionally show every group, or add a group selector, so an earlier pair is not hidden by a newer one.
2. AlternativePreview (experience.tsx:121-125): add a `useEffect` keyed on `[run.id, tree?.name]` that mirrors ResultStudio (lines 57-62):
   - GET `/api/runs/${run.id}/worktrees/${tree.name}/serve`. If `status === "running"`, se …

**Suggested regression test:** Extend the test "alternative runs keep a pinned base and distinct instructions; comparison and briefing fit mobile" in test/e2e/experience.e2e.ts, right after `await page.locator(".alternative-preview iframe").waitFor();`:
- `await page.reload()`, then reopen `.result-more > summary` and `.alternatives > summary`.
- Assert that the "Build both alternatives" button is either absent or disabled, and that "Comparison requested" is visible.
- Assert that `.alternative-preview iframe` appears again w …

<details><summary>Verifier's independent reproduction</summary>

Setup: fresh fake-mode QA server v4617 on 127.0.0.1:4617 with a new home that had no runs. Made a scratch clone of MQTT-MCP (v4617-mqtt) and added it through the UI ("Open another repository", project "v4617 MQTT"). Started a solo fake-claude run 2610252018-6002d492 with checks off; it finished as done. All browser steps used the persistent profile "v4617". Scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617/repro.mjs and second.mjs. Logs: repro.log and second.log in the same folder.

Steps and results:
1. On the run page I opened More options > Try two alternatives. A/B showed the default texts and "Build both alternatives" was enabled.
2. I typed "V4617 alt A: compact" and "V4617 alt B: spacious" and clicked "Build both alternatives". The button changed to "Comparison requested" and was disabled. Two children were created in group gmvo9tk9r7d48: 2610252019-6a870f8a (Alternative A) and 2610252019-9020aa71 (Alternative B). Both finished as done.
3. In the Alternative A card I entered the preview command "python3 -m http.server $PORT --bind 127.0.0.1" and clicked "Preview alternative". The iframe rendered (shots/v4617/002-preview-started.png).
4. I reloaded the page and reopened both sections. The textareas were back to the defaults ("Keep the layout compact and focused." / "Make the layout spacious with clear visual hierarchy."). The button read "Build both alternatives" and was enabled. Both Preview command inputs were empty, "Preview alternative" was disabled, and there was no iframe (shots/v4617/003-after-reload.png).
5. The server still had A's dev server: GET /api/runs/2610252019-6a870f8a/worktrees/solo/serve returned status "running" on port 55762 with the same command. The process was alive but the card hid it. serve/config was null and run.app was undefined, so the card had nothing to prefill from.
6. Impact check: after the reload I clicked the re-enabled "Build both alternatives". It started a second pair right away in group gmvo9uaei322f (2610252019-d90367f7 / 2610252019-2e32dde7), using the default texts rather than my instructions. The section then showed only the new pair. The first pair, including its still-running preview, could only be reached from the sidebar.

No console errors and no 5xx responses. The tester's script was not the cause: I used no dblclick and a plain reload. One thing softens the impact: the child run's own page (ResultStudio) does find …

</details>

### t07-11 · minor · Run lifecycle API: conflict states return 400, and resuming a finished run returns 200 and puts it back in Needs you

**Fix outcome: fixed.** In src/engine.ts, busy-run refusals are now RunConflictError, which maps to 409, with the same messages: resume, archive (setArchived), recordOutcome, merge, mergePr, setTestRun, pullRequest, pushToPr, and followUp when the run is running or starting. New RunManager.assertResumable(), called only by the POST /api/runs/:id/resume route (src/server.ts), refuses a done run that has patternDone set and no pending follow-up with 409 "This run already finished. Send a reply to continue it". Internal recovery can still replay a finished run, which run-storage and team-rollout tests rely on. The resume route now uses attempt(). Race contestants and debate debaters have RoleSpec.min = 2. The participant counting moved into an exported roleParticipants() that TeamContext.participants also uses, and buildStartInput rejects too few participants with 400 before any run exists. docs/api.md documents t …

Fixer's check: Ran the tester's API sequence on f12. While a fix-review run with check `sleep 8; true` was running: resume, archive, outcome, followups, merge and DELETE all returned 409. Two concurrent resumes of a cancelled run returned 200 and 409. On a finished, seen run, POST /resume {} returned 409 "already finished" with seen, endedAt, resumes and archived unchanged; after archiving it with cleanup:false, resume returned 409 and the run stayed archived. A race with contestants [codex,codex] or [codex] returned 400 "Best-of-N race needs at least 2 contestants…" and created 0 runs. Server log clean.

Tests: `test/qa-result-verdict-evidence-server.test.ts`, `test/qa-result-verdict-evidence-engine.test.ts`, `test/qa-result-verdict-evidence.test.ts`

Source: tester unit run-workspace-2; observed with api; features RUN-34.

**Repro**

> 1. Start a run (POST /api/runs) with check `sleep 40; true`.
> 2. While it runs: POST /resume → 400 'This run is already running…'; POST /archive → 400 'Stop the run before archiving it'; DELETE → 409; POST /outcome → 400; POST /followups → 400; POST /merge → 400.
> 3. On a done run: POST /api/runs/<done>/resume {}.
> 4. POST /api/runs pattern 'race' with contestants ['codex','codex'].

**Expected:** State conflicts consistently return 409 (as DELETE, stale heads and team-plan do). Resuming a done run with nothing pending is rejected or a no-op that doesn't change seen/endedAt. Invalid races are rejected with 400 at creation.

**Actual:** Running-state conflicts return 400 (resume, archive, outcome, followups, merge) while DELETE returns 409. Resume of done run 2610251453-bdd8815a → 200 {"resumed":true}, resumes=1, seen=false, endedAt bumped, so the run reappears under 'Needs you'. Race with duplicate contestants → 201, then the run immediately fails 'A race needs at least two contestants'. Concurrent resumes: one 200, one 400.

**Root cause (verifier):** 1) Running-state conflicts return 400.
- src/server.ts:2565-2571: the resume route catches every error from manager.resume and throws new HttpError(400, err.message). It does not use attempt() (src/server.ts:579-584), which maps RunConflictError to 409. So even the engine's explicit RunConflictError for an ambiguous remote receipt (src/engine.ts:5353), and workspace-lease conflicts from assertNoWorkspaceLease (src/engine.ts:3565-3575), come back as 400.
- The engine also throws plain Error, which attempt() maps to 400, for every "busy" refusal:
  - resume: src/engine.ts:5355
  - archive: src/engine.ts:3603
  - recordOutcome: src/engine.ts:4313
  - merge: src/engine.ts:4363 and 4462
  - followUp while running or starting: src/engine.ts:3797 and 3816
- deleteRun uses RunConflictError at src/engine.ts:3613, which gives 409. That is the inconsistency.

2) Resuming a done run is accepted and changes its state.
- resume() (src/engine.ts:5348-5381) has no status guard. It only checks busyRun.
- resumeClaimed then runs these lines on the done run:
  - src/engine.ts:5439: followUpsOnly = !!run.patternDone
  - src/engine.ts:5441: status = "running"
  - src/engine.ts:5451: endedAt = undefined …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/race.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/debate.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/hardening.test.ts`

**Suggested fix:** 1) Return 409 for conflicts on the resume route.
- In src/server.ts:2565-2571, replace the .catch that throws HttpError(400) with `await attempt(() => manager.resume(run.id, body.budget))`. RunConflictError and lease conflicts then return 409, and validation errors (budget, unknown pattern, missing repo) stay 400.

2) Make running-state refusals consistent.
- In engine.ts, add a small helper such as `assertIdle(run, message)` that throws RunConflictError.
- Use it at these places:
  - resume "already running": src/engine.ts:5355
  - archive: src/engine.ts:3603
  - recordOutcome: src/engine.ts:4313
  - merge: src/engine.ts:4363 and 4462
  - purpose/delivery/push/PR busy checks: src/engine.ts:4383, 4513 and 4563
  - followUp when the run is running or starting: src/engine.ts:3797 and 3816
- Keep the existing messages, because the UI and tests match on them.
- Add one line to docs/api.md saying that operations refused because a run is busy return 409.

3) Refuse to resume a finished run t …

**Suggested regression test:** 1) test/server-reliability.test.ts (it spawns a real server with fake agents). Add a test that:
- starts a fix-review run with loop.check "sleep 5; true";
- while it runs, asserts POST /resume, /archive, /outcome, /followups and /merge all return 409, the same as DELETE;
- after it finishes, calls POST /seen, records {seen, endedAt, resumes, archived}, sends POST /resume {}, and asserts the response is 409 and a GET shows those four fields unchanged;
- archives the run with cleanup:false, sends  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4607 on 127.0.0.1:4607 with a new home and no prior runs. The target repo was a throwaway git repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4607-tiny. Scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4607/repro.mjs and repro2.mjs. Output: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4607/repro.log and repro2.log.

1) POST /api/runs with fix-review, builder codex, reviewer claude and loop.check "sleep 40; true" returned 201 (run 2610252015-e8c9b96b). While that run was running:
- resume: 400 "This run is already running or validating a merge"
- archive: 400 "Stop the run before archiving it"
- DELETE: 409 "Finish or stop the run before deleting it"
- outcome: 400 "Wait for the run to finish before assessing its result"
- followups reply: 400 "Follow-ups can be sent once the run has finished"
- merge: 400 "Wait for the run to finish before merging"
After cancelling, two resumes sent at the same time got one 200 and one 400 "already running". The 400 should be 409.

2) A solo run (2610252015-1a4f6372) finished as done, then I marked it seen. Before resume: status done, seen true, endedAt …327600, resumes 0, and it was not in the project summary's waiting (Needs you) list. POST /resume {} returned 200 {"resumed":true}. Afterwards: status done, seen false, endedAt …328194 (moved later), resumes 1, and it was in the waiting list. The event log shows done -> running -> done with no step and no log line. A fix-review done run (2610252015-a3fa1abe) behaved the same way.

3) New side effect not in the report: I archived that done run with cleanup:false, then resumed it. The response was 200 and the run came back with archived=false, seen=false and resumes=2. The UI left rail then listed it under "Needs you" (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4607/001-v4607-needs-you.png). So resume also silently unarchives a run.

4) A race with contestants ["codex","codex"] returned 201. The run failed right away with "A race needs at least two contestants", and its stored roles.contestants was ["codex"]. A race with contestants ["codex"] also returned 201 and failed the same way.

Why this is not by design or ca …

</details>

### S15-8 · minor · POST /api/runs/:id/resume maps every manager.resume error to 400 (no attempt()), so RunConflictError conflicts that other routes report as 409 come back as 400.

**Fix outcome: duplicate.** Fixed by t07-11 (the resume route now goes through attempt(), so RunConflictError from workspace leases maps to 409 like start does).

Fixer's check: Same setup as the S15 tester on f12: a scratch repo with a 20,000-file commit and a done solo run, with POST /api/workspace/preview-revert holding a checkpoint-revert lease (seen in /api/health activity.leases). During the lease, POST /resume on a cancelled run in the same repo and POST /api/runs both returned 409 "Wait for checkpoint-revert to finish before starting another operation in this workspace"; before, resume returned 400.

Tests: `test/qa-result-verdict-evidence-server.test.ts`

Source: code-level suspect at `src/server.ts:2565` (confirmed hands-on).

**Repro**

> QA server s15 (fake). Scratch repoA had a 20,000-file commit. Started a fake solo run (POST /api/runs → 201, done). Started POST /api/workspace/preview-revert on the run's worktree for the big commit, which holds a 'checkpoint-revert' lease for about 3.2 s, and confirmed the lease through /api/health activity.leases. During the lease, in parallel: POST /api/runs/<id>/resume → 400 {"error":"Wait for checkpoint-revert to finish before starting another operation in this workspace"}, and POST /api/runs (new start in the same repo) → 409 with the identical message. (Script: qa/work/s15/s7-resume.mjs) test/workspace-activity.test.ts already shows that manager.resume rejects with RunConflictError in this state. The UI (run.tsx:214, side-chat.tsx:458) only shows the message, so API clients are the ones affected.

**Expected:** 409 for the same RunConflictError on resume as on start, so clients can tell 'retry later' from 'bad request'.

**Actual:** 400 on resume, 409 on start, for the same conflict.

**Root cause (verifier):** The resume handler does `await manager.resume(...).catch((err) => { throw new HttpError(400, err.message) })` instead of attempt(). attempt() maps RunConflictError (and the other conflict classes) to 409 and FilePolicyError to its own status. manager.resume throws RunConflictError for workspace leases, the policy-activation lease and ambiguous remote receipts. docs/api.md:19-20 says explicit concurrency conflicts use 409.

**Suggested fix:** Replace the .catch with `await attempt(() => manager.resume(run.id, body.budget))`. Optionally also turn the 'already running or validating a merge' Error into a RunConflictError.

**Suggested regression test:** Route-level test: hold manager.withIdleRepository(tree.path, () => gate) and POST /api/runs/:id/resume; assert 409 and the lease message. Also assert that an unknown pattern or a missing repository still returns 400.

### t11-12 · minor · Team API returns inconsistent codes/messages for stale or invalid state

**Fix outcome: fixed.** setTaskPriority (src/engine.ts): a missing team or non-integer revision is 400, a stale revision is RunConflictError (409), and an unknown task is 400 "Task \"x\" is not on this team's plan". resumeTaskTeam: a pending reconciliation returns 409 "Resolve the saved result…"; a finished team returns 409 "This team already finished. Send a message to continue from its result"; a busy task returns 409. refreshTaskTeamReview busy returns 409. In taskResolution a stale `current` returns 409, and the new TaskReconciliationStale in src/task-team.ts ("Your workspace changed since this comparison") is rethrown as RunConflictError. The new TemplateConflictError in src/team-template-store.ts covers a stale expectedVersion and is on attempt()'s 409 list. A malformed expectedVersion or a wrong version number stays 400 and names the version to publish.

Fixer's check: Repeated the verifier's p3 script plus task-priority and template probes on f12. team-resume on a finished, applied chat team now returns 409 "This team already finished…" (before: 400 "Resolve the saved result"). With a conflicting local edit, POSTing team-resolution with a stale current returns 409; POSTing it after the workspace changed returns 409 "Your workspace changed since this comparison"; team-resume with the reconciliation pending returns 409 "Resolve the saved result…". On an awaiting auto-team run, task-priority with an unknown task returns 400 "Task \"no-such-task\" is not on this team's plan", a stale revision returns 409, and a valid one returns 200. Templates: 201, then 409  …

Tests: `test/qa-result-verdict-evidence-server.test.ts`, `test/qa-result-verdict-evidence.test.ts`

Source: tester unit ai-teams-patterns-2; observed with api; features TEAM-33, TEAM-25.

**Repro**

> 1. POST /api/runs/<awaiting run>/task-priority with an unknown taskId -> 400 'The team plan changed. Refresh before prioritizing a task'. 2. Stale revision -> 400, stale team-resolution current -> 400, stale template expectedVersion -> 400, while rerun-tasks stale -> 409 and team-plan not editable -> 409. 3. POST /api/runs/<chat>/team-resume for a completed execution -> 400 'Resolve the saved result before continuing this team'.

**Expected:** Stale/conflict states consistently 409; messages describe the actual problem (unknown task, team already finished).

**Actual:** As listed; messages mislead (no plan change happened; nothing to resolve).

**Root cause (verifier):** src/server.ts:579-584: attempt() returns 400 for every thrown plain Error. Only listed classes get 409: RunConflictError, MemoryConflictError, DeferredRunConflictError and RetentionPolicyConflictError, plus TeamPlanEditError and TeamRerunError when they carry status 409. The team endpoints below throw plain Error for conflict states, so they end up as 400:
- src/engine.ts:3489 (setTaskPriority): `if (!task || run.team!.revision !== input.revision) throw new Error("The team plan changed. Refresh before prioritizing a task")`. This puts a validation error (unknown taskId) and a concurrency conflict (stale revision) in one 400 with one message. Because the check runs before the status check, an unknown task on a finished run also reports "plan changed".
- src/engine.ts:4066 (resumeTaskTeam): `if (child.status === "done" || turn.reconciliation) throw new Error("Resolve the saved result before continuing this team")`. One message covers two states: an execution that already finished and was applied (nothing to resolve) and a pending reconciliation. Both return 400.
- src/engine.ts:4144 (taskResolution): a stale `current` throws plain Error("This comparison changed...") and returns 400.  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/task-team.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/team-template-store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`

**Suggested fix:** 1. setTaskPriority (src/engine.ts:3486-3490): check the inputs in this order:
   - A missing or non-integer revision is a validation error: 400.
   - `run.team.revision !== input.revision` throws RunConflictError("The team plan changed. Refresh before prioritizing a task"), which attempt() already maps to 409.
   - A task that is not on the plan throws a plain Error naming it, for example "Task <id> is not on this team's plan" (400). Keep this check before the status check.

2. resumeTaskTeam (src/engine.ts:4066): split the condition.
   - `turn.reconciliation` throws RunConflictError("Resolve the saved result before continuing this team").
   - `child.status === "done"` throws RunConflictError("This team already finished. Send a follow-up to continue from its result.").

3. taskResolution (src/engine.ts:4144): throw RunConflictError for a stale `current`. For src/task-team.ts:174, export a small conflict class from task-team.ts (for example ReconciliationConflictError) so it does not  …

**Suggested regression test:** 1. test/team-templates.test.ts: extend the concurrent-save case near line 36. Assert that the rejected save is a TemplateConflictError. Also assert that save(v1, "x") and save({...v1, version: 3}, 1) reject with a non-conflict validation error.

2. test/auto-team.test.ts (engine level, fake agents): bring an auto-team run to awaiting_approval and call manager.editTeamPlan so the revision moves to 1. Then:
   - setTaskPriority with revision 0 rejects with RunConflictError.
   - setTaskPriority wi …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (v4625, port 4625). The previous v4625 home was moved aside to homes/v4625.prev-*. I used a throwaway fixture git repo at qa/clones/v4625-fx and registered it as project p-7f5ff1e4 through POST /api/projects. All probes were plain API calls with the bearer token. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4625/t11-12/ (p1.mjs, p2.mjs, p3.mjs with matching .log files).

Part 1 (p1): Auto-team run 2610251946-814996c8 (AUTO-SAME-PROVIDER, approvals.plan=true) waiting at awaiting_approval, plan revision 0, tasks alpha and beta.
- task-priority, alpha, revision 0: 200.
- task-priority, taskId "no-such-task", current revision 0: 400 "The team plan changed. Refresh before prioritizing a task". team.revision was still 0 afterwards, so no plan change had happened.
- team-plan with a stale revision: 409 "The plan changed while you were editing...".
- rerun-tasks on the awaiting run: 409.
- POST /api/team-templates v1 with expectedVersion 0: 201. Resending with stale expectedVersion 0: 400 "Template changed; reload before publishing a new version". v2 with expectedVersion 1: 201. Stale expectedVersion 1 again: 400.

Part 2 (p2): a real stale revision. I edited the plan through /team-plan at revision 0 (200, revision becomes 1), then sent both endpoints the same stale revision 0:
- task-priority: 400 "The team plan changed...".
- team-plan: 409. So one conflict gets two different status codes.
- task-priority with unknown task "ghost" at the current revision: 400, same "plan changed" message.
- After approval the run stopped. Unknown task on the finished run: still 400 "plan changed" (not "Only undispatched work...").
- rerun-tasks with a stale expectedHead: 409 "The source integration branch moved...".

Part 3 (p3), chat with an AI team:
- Chat A 2610251946-12a0152d (AUTO-MINIMAL, approvePlan=false) finished done. Its execution 2610251946-18d8471f is done, turn.state is "applied", there is no reconciliation, and taskTeam.enabled is true.
- POST team-resume for that execution: 400 "Resolve the saved result before continuing this team".
- GET team-resolution for the same execution: 400 "No unresolved team changes for this conversation". The two answers contradict each other.
- Chat B 2610251947-ca0c0e21: plan approval on, plus a conflicting local claude-alpha.txt written into the solo worktree before approval. The resolution GET  …

</details>

### t08-14 · minor · GET /api/workspace/file on a missing path returns 400 with a raw ENOENT message and absolute path

**Fix outcome: fixed.** New WorkspaceFileMissingError in src/workspace.ts. editablePath maps ENOENT/ENOTDIR from lstat and realpath to "File not found" without the path, and saveEditableFile turns it into "This file no longer exists. Copy your draft before reloading.". src/workspace-api.ts maps it to 404 for GET and POST. The filesystem-policy symlink guard (src/filesystem-policy.ts assertNoSymbolicAncestor) treats ENOTDIR like ENOENT, since such a path cannot exist. /api/file (src/server.ts) maps ENOTDIR to 404 "File not found" too. docs/api.md updated.

Fixer's check: On f12, GET /api/workspace/file with path does/not/exist.ts and with README.md/x, and GET /api/file README.md/x, all return 404 {"error":"File not found"}, where before the workspace route returned 400 with ENOENT/ENOTDIR and the absolute path. In the browser, Side panel → Files → Search → Open a file by path → does/not/exist.ts shows the alert "File not found", and both requests are 404. Opening a.txt, deleting it on disk, then Save file shows "This file no longer exists. Copy your draft before reloading." (POST 404, no path). The only console entries are Chrome's built-in "Failed to load resource: 404" network messages; before the fix these same requests logged 400s.

Tests: `test/qa-result-verdict-evidence.test.ts`, `test/qa-result-verdict-evidence-server.test.ts`

Source: tester unit side-panel-previews-1; observed with api; features SIDE-12.

**Repro**

> 1. Files → Search → 'Open a file by path…' → does/not/exist.ts.
> 2. Or GET /api/workspace/file?repo=<repo>&path=does/not/exist.ts.

**Expected:** 404 'File not found', like /api/file.

**Actual:** 400 "ENOENT: no such file or directory, lstat '<absolute path>'". The UI then falls back to /api/file and shows 'File not found', so users mostly don't see it.

**Root cause (verifier):** src/workspace.ts:22 is in editablePath(), which readEditableFile (src/workspace.ts:34) and saveEditableFile (src/workspace.ts:46-47) both call. It runs `await lstat(current)` on each path component without catching errors, so a missing component throws the raw Node ErrnoException (code ENOENT, or ENOTDIR when a file is used as a folder). Its message contains the absolute lstat path.

src/workspace-api.ts:130-136 (the parts[2] === "file" branch) passes that error through unchanged. GET is line 132. On POST, only WorkspaceConflictError is translated (to 409).

src/server.ts:1834 wraps handleWorkspaceApi in attempt() (src/server.ts:578-585). attempt() turns any non-HttpError and non-allow-listed error into HttpError(400, err.message), so the response is 400 with the raw ENOENT text.

The /api/file route maps the same error itself (src/server.ts:2275-2278: ENOENT to 404 "File not found"), but the workspace route never got that mapping. In the UI, loadFile (ui/code-browser.tsx:47-53) hides the problem by falling back to /api/file. save (ui/code-browser.tsx:68-74) has no fallback, so the raw message reaches the alert at ui/code-browser.tsx:92.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/workspace.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/workspace-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/workspace.test.ts`

**Suggested fix:** 1. In src/workspace.ts, add a typed error such as `export class WorkspaceFileMissingError extends Error { readonly status = 404 }`. In editablePath, catch ENOENT and ENOTDIR from the per-component lstat and from realpath, and throw `new WorkspaceFileMissingError("File not found")` (or "File not found: <repo-relative path>"). Never put the absolute path in the message. Map EACCES and EPERM to a 403-style error the same way. searchCode already swallows errors with .catch(() => undefined), so it is unaffected.

2. In src/workspace-api.ts, in the parts[2] === "file" branch, wrap the GET (line 132) and POST (lines 135-136) so that WorkspaceFileMissingError becomes HttpError(404, message). This matches /api/file. Alternatively, add the error class to the status allow-list in attempt() at src/server.ts:583.

3. Save after the file was deleted: either keep 404 with a clear message such as "This file no longer exists; reload or save it as a new file", or treat it as a conflict (409 via Workspac …

**Suggested regression test:** In test/server-reliability.test.ts, next to the existing /api/workspace/file README.md checks around line 549, add these assertions:
- GET `/api/workspace/file?repo=<repo>&path=does/not/exist.ts` returns status 404, `body.error` is "File not found" (or matches /not found/i), and `body.error` matches neither /ENOENT|lstat/ nor the repo's absolute path.
- The same holds for `path=README.md/x` (ENOTDIR).
- Load README.md, delete it on disk, then POST /api/workspace/file with the loaded hash. Expect …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (qa-server.sh start v4695 4695 fake; it loaded 0 runs) and called it with curl using the bearer token qa-v4695-token:
- GET /api/workspace/file?repo=<MQTT-MCP>&path=does/not/exist.ts returned HTTP 400 {"error":"ENOENT: no such file or directory, lstat '/Users/mx/Documents/Work/industriAgents/Connect-MCPs/MQTT-MCP/does'"}. Only the first missing path component appears in the message, so it is also misleading.
- path=nope.txt returned the same kind of 400 ENOENT message with the absolute path.
- GET /api/file for the same missing path returned 404 {"error":"File not found"}.
- An existing README.md returned 200. A directory returned 400 "Edit a regular text file under 512 KB".

UI check with headless Chrome (script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4695/t08-14.mjs): I picked the MQTT-MCP project, then Side panel > Files > Search > "Open a file by path..." > does/not/exist.ts > Open file. The network log showed the 400 ENOENT from /api/workspace/file, then a 404 from /api/file. The panel's alert showed only "File not found", so the reporter's description is exact (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4695/003-after-open-missing.png).

Extra case that makes the issue more visible to users: I opened a throwaway git repo in my scratchpad through "Open another repository", which created a project only in the QA home. I opened a.txt in the side panel editor, deleted a.txt on disk, edited the text and clicked "Save file". POST /api/workspace/file returned 400 "ENOENT: no such file or directory, lstat '<absolute path>/a.txt'". Save has no fallback, so that raw message with the absolute path is shown to the user as the panel's role=alert (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4695/003-save-after-delete.png).

I also found that path=README.md/x gives 400 "ENOTDIR: not a directory, lstat '<abs>'" on both /api/workspace/file and /api/file.

Not by design:
- docs/api.md documents GET /workspace/file without any special error behaviour.
- Other routes deliberately map ENOENT to 404: /api/file at src/server.ts:2277 ("File not found") and /api/fs at src/server.ts:1924 (ENOENT to 404, EACCES/EPERM to 403).
- The 400 does not come from the environment or the t …

</details>

### S15-5 · cosmetic · /api/accounts calls readJson(req) for every request other than GET /api/accounts, so GET /api/accounts/:id (and DELETE, or deeper paths) without a JSON content-type gets 415 'Expected application/json' instead of 404.

**Fix outcome: fixed.** src/server.ts /api/accounts block: the method and path are dispatched before readJson (create, update, revoke-sessions); any other combination returns 404 "Unknown shared account operation" whatever its content type.

Fixer's check: On f12 without a content-type: GET /api/accounts/abc, /abc/sessions and /x/y/z, and DELETE /api/accounts/abc, /abc/sessions and /x/y/z, all return 404 "Unknown shared account operation" (before: 415). POST /api/accounts with a non-JSON body still returns 415.

Tests: `test/qa-result-verdict-evidence-server.test.ts`

Source: code-level suspect at `src/server.ts:1764` (confirmed hands-on).

**Repro**

> QA server s15, curl with the bearer token. GET /api/accounts/abc → 415 {"error":"Expected application/json"}. The same 415 for GET /api/accounts/abc/sessions, GET /api/accounts/x/y/z, DELETE /api/accounts/abc, DELETE /api/accounts/abc/sessions and DELETE /api/accounts/x/y/z. With content-type: application/json, GET /api/accounts/abc → 404 'Unknown shared account operation'. For comparison, GET /api/nonexistent-xyz → 404. The UI never calls these routes, so only API clients are affected.

**Expected:** 404 'Unknown shared account operation' (or 405) for unsupported method/path combinations.

**Actual:** 415 'Expected application/json', which suggests the route exists and only the content type is wrong.

**Root cause (verifier):** In the accounts block, the 'const body = await readJson(req)' line runs before the method/path dispatch. readJson rejects a missing application/json content-type with 415 before the code reaches the final 'Unknown shared account operation' 404. docs/api.md:19-20 says missing resources and unknown operations use 404.

**Suggested fix:** Dispatch on method and path first, and call readJson only inside the POST/PUT branches (as the invitations sub-block already does). Or add a guard such as `if (!['POST','PUT'].includes(req.method)) throw new HttpError(404, ...)` before readJson.

**Suggested regression test:** Route test: GET and DELETE /api/accounts/:id without a content-type return 404, and POST /api/accounts without JSON still returns 415.


## Continuation integration · 2026-10-26

Merged into `codex/dogfood-qa-continue` in `/Users/mx/.codex/worktrees/dogfood-qa-continue/code-flow`. Typecheck passes. All 16 targeted tests pass. Conflict resolution preserves deleted-worktree lifecycle checks and current repository check detection alongside the new evidence handling.

Fresh continuation Chrome replay: all 4 scenarios pass (test-change warning, per-candidate evidence, team evidence in chat, alternatives and preview after reload). The focus assertion now waits for the component effect, then still requires the first instruction field to own focus. Used fake CLIs and scratch repositories, with no unexpected browser errors. Logs: `/private/tmp/codeflow-qa-continue/step1-browser.log` and `step1-browser-repaired.log`.
