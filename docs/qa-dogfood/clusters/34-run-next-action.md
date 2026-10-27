# Cluster 34 · run-next-action

**Run next-action card & status wording: provider/usage stops, failed-no-change results, pause/priority**

Status: **fixed and verified** · 14 issue entries · branch `codex/qa-run-next-action`

Planner notes: Mostly nextRunAction in ui/run-experience.ts (~56-62), hasResult in ui/run.tsx (:199) and ui/experience.tsx. t05-3/t07-1: the provider action matches run.error against a regex that the engine's own sign-in text doesn't hit. Use a structured error kind (src/adapters/errors.ts) instead. t06-8/t07-7: usage-limit stops are shown as 'The execution limit was reached / Extend budget'. t06-12/t11-19: stopped, rejected and cancelled runs are framed as 'Work is paused… resume'; a cancelled check says 'Failed (exit code null)'; a plan rejection is stored like a user Stop (execute().catch in the engine ~5527). t19-11: the review council's main next step is 'Fix check command'; make the action pattern-aware. t05-4/t25-14/t26-6: hasResult ignores the status and whether anything changed, so failed or no-change runs show 'Ready to review' (src/patterns/solo.ts:54 also writes an empty Workspace result). t07-13: 'Proof: tests without the change' (unproven) is listed as a failure. t06-9/S05-5: pause dispatch never reports 'paused', and two controls label priority differently (ui/workbench.tsx vs ui/experience.tsx). t07-17: cosmetic plurals and wording on check steps. Duplicate groups: [["t05-3","t07-1"],["t06-8","t07-7"],["t05-4","t25-14","t26-6"],["t06-9","S05-5"]]

Likely files: `ui/run-experience.ts`, `ui/run.tsx`, `ui/experience.tsx`, `ui/workbench.tsx`, `src/engine.ts`, `src/adapters/errors.ts`, `src/patterns/solo.ts`, `src/patterns/tdd.ts`, `src/experience.ts`, `ui/types.ts`

## Final integrated follow-up · 2026-10-26

Full-suite integration exposed the empty-result guard hiding linked PR delivery and labelled-test archive actions. Commit0498531 renders delivery-only controls for unchanged work without empty review/preview/assessment promises. Original GHE and delivery replays plus a new zero-change regression pass. See [final validation](../final-validation.md).

## Resolution and verification · 2026-10-26

| Issue entries | Outcome and root fix |
|---|---|
| t05-3, t07-1 | Typed provider-step failures retain the error kind and provider on steps/runs and in journal reloads. The recovery selector uses that field with the shared classifier for older records. Both workflow and Agent chat failures expose provider health. |
| t06-8, t07-7 | Provider quotas retain their reported reset time and have a separate recovery action without run-budget controls. Known future resets disable Resume; unknown resets permit an informed retry. Navigation to a reset that has already elapsed enables Resume immediately. API-equivalent run-budget limits retain budget recovery. |
| t06-12, t11-19 | Rejected plans get a durable marker, explicit header/team state and Edit & run again; direct Resume refuses both new and legacy rejected records. User cancellation remains resumable and is called Stopped by you. Aborted check transcripts describe cancellation, interruption or a limit instead of a null exit code. |
| t19-11 | Read-only council results show the review outside collapsed details and offer Read and publish review instead of a check-configuration prompt. No posting is automatic. |
| t05-4, t25-14, t26-6 | No-op Agent turns produce no review artifact. The result card checks actual review coverage for older artifacts; failed work with changes says Partial work saved. Uncommitted edits remain inspectable; failed Git inspection does not erase an artifact. |
| t07-13 | TDD red checks record expected failure separately from actual result verification; premature green and inconclusive proof checks are warnings. Only real failures count under What went wrong, which remains visible for done runs with failing checks. The existing check journal key is retained for resume compatibility. |
| t06-9, S05-5 | Live progress, header, rail and History distinguish active pause requests from idle Dispatch paused. Idle pause has static indicators, and both control surfaces share Pause/Resume dispatch and High/Normal/Low priority options. |
| t07-17 | Singular queued-check grammar, sentence punctuation, overall-comment count, cancellation text, no-evidence check labels, Review: Outdated and inline code inside bold text are repaired. |

### Evidence and independent review

Typecheck and `git diff --check` passed. Final related suite: **131/131 tests passed**. Fresh browser suite: **8/8 passed**, followed by the additional actual TDD case (**1/1 passed**). The six original attention browser cases also passed. No unexpected page errors, API 5xx responses, or server exceptions were observed.

- New `test/qa-run-next-action.test.ts`: eight engine/selector cases, including persisted auth/quota metadata, rejected-plan Resume refusal, TDD outcome semantics, actual process cancellation and preservation of failed uncommitted work.
- New `test/e2e/qa-run-next-action.e2e.ts`: real Chrome against a separate fake-agent server and scratch Git repo. Original auth/quota, rejection, council, no-op/partial-result, pause/History, comment-count and queued-check flows are exercised through live API/UI. A fresh TDD workflow verifies expected-red and premature-green labels. Historical warning/failure records and unknown/elapsed quota resets are seeded explicitly; the clock-navigation variation advances browser time only.
- Original attention Chrome tests passed after the intentional no-op artifact expectation update. Existing proof/pattern, review-label and no-evidence expectations were updated to match the corrected semantics; no cases were removed.
- Independent read-only review found the stale quota clock on run navigation; fixed and covered. Screenshot inspection found the idle pause still used animated running indicators; fixed and covered. Provider-limit, paused, cancelled-check, council and partial-result screenshots were checked for layout and wording.
- Logs and screenshots: `/private/tmp/codeflow-qa-continue/next34-*.log` and `/private/tmp/codeflow-qa-continue/next34-shots/`. Every root command and child app/build invocation used an explicit scratch `CODEFLOW_HOME`. No live server, real repository, provider, push or PR was used.

## Issues

### t05-3 · minor · 'The provider needs attention / Reconnect provider' next action never appears for the engine's own sign-in failures

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOL-20.

**Repro**

> 1. Export FAKE_CLAUDE_FAIL=auth and start a fake QA server.
> 2. Start a Fix & review run with Claude as builder and reviewer (I used the API for setup).
> 3. The run fails with run.error "Fix the issue (claude) failed: Claude Code isn't signed in. Sign in to it in a terminal, then resume the run. (Invalid API key · Please run /login)".
> 4. Open the run: the Next action panel says 'The run could not finish' with 'Retry unfinished work', not 'The provider needs attention' with 'Reconnect provider' (which opens Health) and 'Resume after reconnecting'.
> 5. A solo/chat run with the same failure shows only a 'Resume' recovery bar, because the next-action panel is hidden for chat.

**Expected:** Sign-in failures route to the provider path: open the Health dialog, then resume.

**Actual:** The regex never matches the wording the engine produces, so the provider-specific path is unreachable for Claude and Codex auth failures.

**Root cause (verifier):** The UI recognises a provider failure by matching a regex against the error text. The engine replaces that text with wording the regex does not know.

- ui/run-experience.ts:57: `nextRunAction` returns kind "provider" only if run.error matches `/not (?:logged|signed) in|authentication|unauthori[sz]ed|login required|credentials? (?:expired|missing)|token expired/i`.
- src/engine.ts:2636-2638: when `failureKind(result) === "auth"`, the engine rewrites the step error to "<displayName> isn't signed in. Sign in to it in a terminal, then resume the run. (<first line of CLI error>)", or for a remote worker "...isn't signed in on the selected worker...". "isn't signed in" does not match "not signed in", and none of the other alternatives match.
- src/engine.ts:2674 then throws `Error("<title> (<agent>) failed: <that text>")`.
- src/engine.ts:5533-5535 copies only err.message into run.error.

The run never stores the structured errorKind "auth" that the adapters and failureKind() already work out: the Run interface (src/engine.ts:359ff) has `error?: string` only. The UI therefore falls back to matching prose, and that list has drifted from both the engine's wording and the adapter classifier …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`

**Suggested fix:** 1. Carry a structured failure kind on the run instead of matching prose.
   - At src/engine.ts:2674, throw a typed error (e.g. `StepFailedError` with `kind = failureKind(result)` and `agent`) in place of a plain Error.
   - In the .catch around src/engine.ts:5533, set a new `Run.errorKind` (or `failure: { kind, agent }`) from it when the run ends failed.
   - Clear it on resume next to `run.error = undefined` (src/engine.ts:5442), and persist and restore it wherever run.error is journaled.
2. In ui/run-experience.ts:57, check `run.errorKind === "auth"` first and return the provider action. Keep the regex only as a fallback for older runs, and add the engine's own phrasing ("isn't signed in", "please run /login", "invalid api key", "token has expired", "log in again"). Better, share one pattern list with src/adapters/errors.ts so the two cannot drift again.
3. Optional: in the chat recovery bar (ui/run.tsx:339), when errorKind is auth, add a "Check provider health" button that sets heal …

**Suggested regression test:** 1. In test/run-experience.test.ts, extend "recovery actions preserve the distinction between configuration, code failures and providers" with:
   - `assert.equal(nextRunAction(run({ status: "failed", error: "Fix the issue (claude) failed: Claude Code isn't signed in. Sign in to it in a terminal, then resume the run. (Invalid API key · Please run /login)" }))?.kind, "provider")`. This fails today.
   - Once the structured field exists: `assert.equal(nextRunAction(run({ status: "failed", errorKind …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake QA server v4605 on 127.0.0.1:4605 with `export FAKE_CLAUDE_FAIL=auth`. The fake claude prints "Invalid API key · Please run /login", which is how real Claude Code words this failure.

1. Created a Fix & review run on MQTT-MCP through the API, with roles builder=[claude] and reviewer=[claude] (run 2610251758-4004a050). It failed with run.error "Fix the issue (claude) failed: Claude Code isn't signed in. Sign in to it in a terminal, then resume the run. (Invalid API key · Please run /login)".
   - The run page's "Next action" region showed "The run could not finish" with a budget form and a "Retry unfinished work" button.
   - It did not show "The provider needs attention", "Reconnect provider" or "Resume after reconnecting".
   - Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4605/001-fix-review-next-action.png
2. Started a solo Agent chat from the composer UI (project MQTT-MCP, provider Claude Code; run 2610251800-bbee5ca8). It failed with the same "isn't signed in" error.
   - The Next action region was not rendered at all (count 0).
   - The page showed only the .chat-recovery bar: the error text and a "Resume" button, with no link to provider health.
   - Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4605/002-chat-recovery.png
3. Ran nextRunAction (imported read-only from ui/run-experience.ts with tsx) on engine-style messages:
   - Returned "resume / Retry unfinished work" for "...isn't signed in... (Invalid API key · Please run /login)", "Codex isn't signed in... (Your access token could not be refreshed. Please log in again.)" and "...(OAuth token has expired...)".
   - Returned "provider" only when the CLI's own text in the brackets happened to contain a matching phrase, e.g. "(Not logged in · Please run /login)" or "Authentication failed".

So the engine's own wording never matches. The provider path appears only by accident, depending on what the CLI printed. The reporter's "never" is slightly too strong, but the claim holds for invalid-key and expired or refresh-token sign-in failures.

Not by design: docs/runs.md:29 says "**Reconnect provider** opens provider health and login instructions; resume after reconnecting." Not caused by the environment: the engine produces this text itself, and the fake's wording matches what real Claude prints. History …

</details>

### t07-1 · minor · Provider sign-in failures never show the 'Reconnect provider' card

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-21.

**Repro**

> 1. export FAKE_CLAUDE_FAIL=auth; qa-server.sh start t07f 4379 fake
> 2. Add a scratch clone as project 't07 Studio' (Open another repository).
> 3. Start a 'Fix & review' run (builder Codex, reviewer Claude Code), check `true`.
> 4. Wait for the run to fail at 'Review (round 1)' and open it.
> 5. Optional: restart with FAKE_SIGNED_OUT=claude as well and start a new run with a Claude reviewer.

**Expected:** Next-action card 'The provider needs attention' with 'Reconnect provider' (opens provider health/login instructions) and 'Resume after reconnecting', as designed in ui/run-experience.ts.

**Actual:** Error 'Review (round 1) (claude) failed: Claude Code isn't signed in. Sign in to it in a terminal, then resume the run. (Invalid API key · Please run /login)'. The card says 'The run could not finish' with 'Retry unfinished work'. Retrying immediately fails the same way (resumes=1). With FAKE_SIGNED_OUT=claude a new run with a Claude reviewer still started and failed at the review.

**Root cause (verifier):** ui/run-experience.ts:57 (the reporter cited :62; it is :57 in this tree) chooses the "provider" next action by matching run.error against its own regex: /not (?:logged|signed) in|authentication|unauthori[sz]ed|login required|credentials? (?:expired|missing)|token expired/i. When a turn fails with failureKind "auth", src/engine.ts:2636-2638 records quota "signed_out" and replaces the error with "<CLI> isn't signed in. Sign in to it in a terminal, then resume the run. (<first line of CLI error>)". src/engine.ts:2674 then wraps it as "<step> (<agent>) failed: …". The regex does not match "isn't signed in", and it does not match Claude Code's real sign-out text "Invalid API key · Please run /login". The adapter classifier in src/adapters/errors.ts:16-17 does recognise that text ("please run /login|invalid api key|…"), but the UI keeps its own copy of the rule that has drifted from it. The engine also never stores the structured kind on the step or the run, so the UI can only guess from wording. As a result the card falls through to kind "resume" ("The run could not finish" / "Retry unfinished work"). The documented "Reconnect provider" card (docs/runs.md:29, wired up in ui/run.tsx:222  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/errors.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/types.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/engine-reliability.test.ts`

**Suggested fix:** Base the provider card on structured data instead of error wording.
(1) At src/engine.ts:2636, when kind === "auth", store the kind on the step (step.errorKind = "auth"). When the run fails because of that step, also set a run-level field such as run.failureKind = "auth" (with the agent id), and expose it in RunSummary and ui/types.ts.
(2) In nextRunAction (ui/run-experience.ts:57), check `run.failureKind === "auth"` first.
(3) Keep a text fallback for older runs, but import it instead of keeping a copy. src/adapters/errors.ts is pure (only a type import), and the UI already imports from ../src/run-status.js, so `classifyError(run.error) === "auth"` can be reused there. At minimum, add `isn'?t signed in|invalid api key|please run /login|(?:log|sign) in again` to the UI regex.
(4) For remote-worker sign-outs, whose message says to "start a fresh invocation", consider whether the "Resume after reconnecting" wording still fits.

**Suggested regression test:** In test/run-experience.test.ts, extend "recovery actions preserve the distinction…" (line 50) with the exact strings the engine produces. Assert that `nextRunAction(run({ status: "failed", error: "Review (round 1) (claude) failed: Claude Code isn't signed in. Sign in to it in a terminal, then resume the run. (Invalid API key · Please run /login)" }))?.kind === "provider"` and that its label is "Reconnect provider". Add the same assertion for the remote-worker variant "…isn't signed in on the sel …

<details><summary>Verifier's independent reproduction</summary>

Port 4683 was already taken by another agent's fixture (v4681t21/fixture.cjs, pid 38136). I left it alone and used my extra port 4685 with a fresh home named v4683t07.
1. `export FAKE_CLAUDE_FAIL=auth; qa-server.sh start v4683t07 4685 fake`
2. Made a tiny scratch repo at scratchpad/qa/clones/v4683-tiny, with a bare scratch origin. Added it through the UI ("Open another repository") as project "v4683 Tiny".
3. In the composer: Advanced > workflow "fix-review", using the default roles (builder codex, reviewer claude). Set "Done when" to `true` and pressed Start run. Script: scratchpad/qa/work/v4683/t07-1-run.mjs.
4. Run 2610252008-706170cd failed at step s7 (claude). run.error was: "Review (round 1) (claude) failed: Claude Code isn't signed in. Sign in to it in a terminal, then resume the run. (Invalid API key · Please run /login)". The next-action card read "The run could not finish" with the button "Retry unfinished work", and no provider card appeared (screenshot shots/v4683t07/002-failed-2610252008-706170cd.png). The error text was rewritten, which only happens when the engine has classified the failure as `auth`.
5. Clicked "Retry unfinished work" in the card. The run went to resumes=1, failed with the same error and showed the same "could not finish" card. No console errors and no 5xx responses.
6. Unit check: imported ui/run-experience.ts and src/adapters/errors.ts with tsx from the read-only source (scratchpad/qa/work/v4683/t07-1-unit.mts). For the Claude message above, `nextRunAction()` returns kind "resume", while the adapter's own `classifyError()` returns "auth". For the Codex message "Codex isn't signed in… (Not logged in)", it returns "provider", but only because the raw CLI text in brackets happens to contain "Not logged in". The remote-worker version of the message and the managed Antigravity message also never match.

Secondary claim (step 5 of the report) not reproduced through the UI. I restarted with FAKE_SIGNED_OUT=claude as well. /api/doctor then reported claude signedIn=false, and `rolesFor()` (ui/state.ts:768-786) moved the default reviewer to codex. The new run 2610252011-a0e89ba0 started with roles {builder:[codex], reviewer:[codex]} and finished. An explicitly saved Claude reviewer would be blocked by `startProblem()` (ui/composer.tsx:570-571). The reporter's run was probably started before /api/doctor answered (while `health.value` is still null there is no guard), or through the API. Neither is the card bug.

Cleanup: both runs d …

</details>

### t06-8 · minor · Provider usage limit presented as 'The execution limit was reached' / 'Extend budget & resume' with pill 'Paused'

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-02.

**Repro**

> 1. Restart fake server with FAKE_CLAUDE_FAIL=rejected. 2. Fix & review run (Claude reviewer) or Agent run with Claude. 3. Read header and next-action card.

**Expected:** A provider-limit state ('Claude Code usage limit — resets 5pm') with resume after reset; not a budget problem.

**Actual:** Header 'Paused'; card title 'The execution limit was reached' and button 'Extend budget & resume' (detail line says 'Stopped at the usage limit of Claude Code'). 'What went wrong' also lists the proof steps as failures.

**Root cause (verifier):** ui/run-experience.ts:57-58 (nextRunAction). Every run with status "stopped" that has no team work left gets the title "The execution limit was reached", the label "Extend budget & resume" and the detail "...resume with a fresh budget". Only auth errors are split out, into the "provider" kind, via the regex at line 57. A provider plan-usage stop is never told apart from a run-budget stop.

The engine records a provider stop as stopReason "usage limit of <Provider>" (src/engine.ts:2668-2669 via stop() at :1096). Run-budget stops use reasons like "time limit (N min)", "step limit (...)", "CLI invocation limit", "reported token limit" and "reported API-equivalent usage limit" (:982, :1557-1558, :2557, :2805-2809). All of them become status "stopped" with error "Stopped at the <reason>." (:5534-5535).

executionLabel (ui/run-experience.ts:19) maps stopped to "Paused" for every reason. That is acceptable, but it gives no hint about the provider limit.

The run record keeps no structured provider-limit data. The reset time only reaches manager.quota through recordLimit (src/engine.ts:2635, :4719-4728). So the card cannot say when the limit resets, and resume (ui/run.tsx:208-216 → /api/run …

**Files:** `ui/run-experience.ts`, `ui/run.tsx`, `src/engine.ts`, `test/run-experience.test.ts`, `docs/runs.md`

**Suggested fix:** 1. In nextRunAction (ui/run-experience.ts), add a branch before the generic resume case for a provider plan limit. Match the engine's exact reason, `/^usage limit of /` on run.stopReason. Do not use a loose /usage limit/ test, because the budget reason "reported API-equivalent usage limit" must keep the extend-budget path. The new branch should return a provider-limit action, either kind "provider" or a new kind "provider-limit", with:
   - title: "<Provider> reached its plan usage limit"
   - detail: "Recorded work is kept. Resume after the limit resets, or switch this role to another installed provider."
   - label: "Resume after reset", or "Check provider usage" to open healthOpen, plus a secondary Resume button the way the provider/auth card already has one
   - no budget fields: in ui/run.tsx only show .resume-budget for budget-type stops

2. Give the engine structured data so the card can show the reset time. In the usage-limit branch (src/engine.ts:2668), set run.providerLimit = …

**Suggested regression test:** Unit test in test/run-experience.test.ts:

- Assert that `nextRunAction(run({ status: "stopped", stopReason: "usage limit of Claude Code", error: "Stopped at the usage limit of Claude Code." }))` does not have title "The execution limit was reached" and does not have label "Extend budget & resume". Its kind should be "provider" or "provider-limit", and its title should match /usage limit/i (and mention the reset time when run.providerLimit.resetsAt is set).
- Keep the existing assertion that `st …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4651u on port 4651 (new home), with FAKE_CLAUDE_FAIL=rejected exported. I checked the server process environment to make sure the variable was set. I made a scratch clone of MQTT-MCP (bare repo plus working clone under qa/clones/v4651u-mqtt) and added it through the UI ("Open another repository", project "v4651u MQTT"). Then I started a Fix & review run from the composer: workflow-select=fix-review, check "true", default roles builder=codex and reviewer=claude.

Run 2610251920-3ec2aa3d ended with status=stopped, stopReason "usage limit of Claude Code" and error "Stopped at the usage limit of Claude Code." Only 7 steps ran in about 2 seconds, against an allowance of 200 calls and 240 minutes, so no run budget was close to being used up. The UI showed:
- Header pill: "Paused".
- Next-action card: title "The execution limit was reached", detail "Stopped at the usage limit of Claude Code. Recorded results are reused when you resume with a fresh budget.", budget fields, and the button "Extend budget & resume". Screenshot: qa/shots/v4651u/002-run-stopped.png.

Pressing "Extend budget & resume" in the UI immediately re-ran "Review (round 1)" on Claude, which failed again with "You've hit your limit · resets 5pm". The run was stopped again with the same card. A bigger budget cannot fix this state, and the button sends the user straight back into the provider limit.

Things I tried to refute the issue with:
(a) Fake artifact? No. The fake output copies how Claude Code ends a plan-usage turn (a rejected rate_limit_event plus "You've hit your limit · resets ..."). The engine's own usage_limit classification turns that into stop("usage limit of Claude Code"), and a real limit takes the same path.
(b) By design? Only partly. Stopping as a resumable "stopped" run is intentional (engine.ts:2665-2669 comment; tests cover "usage limits stopping a race"). The card text is not designed for this case. docs/runs.md:29 describes "Extend budget & resume" as giving a fresh allowance of calls/minutes. docs/help.md:38 gives the intended advice for "Usage limit reached": "Choose another installed provider or wait for your plan's limit to reset". The run card says neither.

One sub-claim does not hold. The "What went wrong" proof rows ("Proof: tests without the change — Passes without the change too") are real proof failures. The tester's check command `true` passes with or without the change, so the proof can never fail. This is caused by the env …

</details>

### t07-7 · minor · A provider plan-usage stop is shown as 'The execution limit was reached' / 'Extend budget & resume'

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-21.

**Repro**

> 1. export FAKE_CLAUDE_FAIL=rejected; start a fake server.
> 2. Start 'Fix & review' with reviewer Claude Code, check `true`.
> 3. The run stops at Review with 'You've hit your limit · resets 5pm'.
> 4. Open the run and click the primary action.

**Expected:** A card that says Claude Code's usage limit was reached, with the reset time, and suggests resuming after the reset or switching agent. No 'extend budget' framing.

**Actual:** Pill 'Paused'. Card title 'The execution limit was reached', button 'Extend budget & resume' (budget fields shown). The detail line does say 'Stopped at the usage limit of Claude Code.', but the reset time is only in the step text. Clicking resume spends another call and stops again immediately (resumes=1, same stop).

**Root cause (verifier):** The cause is in the UI's next-action logic, not the engine. The engine records the stop correctly: src/engine.ts:2668-2669 calls `this.stop(`usage limit of ${displayName}`)`, src/engine.ts:5534-5535 sets status="stopped" and error="Stopped at the usage limit of Claude Code.", and src/engine.ts:2635 calls manager.recordLimit(agent, resetsAt). The reset time is therefore stored in quota and sent to the UI as Health.quota.windows[*].resetsAt (ui/state.ts:679).

The problem is ui/run-experience.ts:57-58 (the report says line 64; in this checkout it is 58). nextRunAction treats every non-team `status === "stopped"` run as an exhausted execution budget. It returns title "The execution limit was reached" and label "Extend budget & resume" and never reads run.stopReason. The only special case is the provider-auth regex on line 57, which tests run.error for login/auth text and so never matches a usage limit.

ui/run.tsx:295-301 then renders the resume-budget editor ("Maximum calls / Maximum minutes / Use extended budget / New allowance…") for every kind === "resume" action. ui/run.tsx:221 sends the click straight to POST /api/runs/:id/resume. Neither the resume route (src/server.ts:2565-257 …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** 1. Engine (src/engine.ts, stop at about line 2669). Store structured stop data on the run, for example `run.stopKind = "provider_usage_limit"`, `run.stopAgent = params.agent` and `run.stopResetsAt = result.resetsAt ?? <the soonest known window from recordLimit>`. The UI then does not have to parse the English stopReason. As a minimal fallback, match `/^usage limit of /` on stopReason. Do not match "reported API-equivalent usage limit": that one is a real budget stop from maxCostUsd.

2. ui/run-experience.ts nextRunAction. Before the generic "stopped" branch, return a provider-limit action, for example:
   - kind "provider" or a new kind "provider-limit"
   - title "<Agent> reached its usage limit"
   - detail "Resets <time>" when known (from run.stopResetsAt or the agent's Health.quota), plus "Resume after the reset or switch the agent for this role. Recorded results are kept."
   - label "Resume after reset" when the reset time is past or unknown, otherwise "Switch agent" / "Open prov …

**Suggested regression test:** In test/run-experience.test.ts, add:

```ts
const limited = nextRunAction(run({ status: "stopped", stopReason: "usage limit of Claude Code", error: "Stopped at the usage limit of Claude Code." }));
assert.notEqual(limited?.title, "The execution limit was reached");
assert.notEqual(limited?.label, "Extend budget & resume");
assert.match(limited!.title, /Claude Code.*usage limit/i);
```

If a stopResetsAt field is added, also assert that the detail contains the formatted reset time. Keep the exist …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake QA server v4695 on 127.0.0.1:4695, started with FAKE_CLAUDE_FAIL=rejected and FAKE_SLEEP_MS=500. I added a scratch clone of MQTT-MCP through "Open another repository". In the composer I opened Run options > Advanced, chose the workflow "Fix & review" (builder Codex, reviewer Claude Code by default), set the "Done when this passes" check to `true`, and sent the task through the UI.

Run 2610252011-05e64e38 ended with status=stopped, stopReason="usage limit of Claude Code" and error="Stopped at the usage limit of Claude Code." The Review (round 1) Claude step failed with "You've hit your limit · resets 5pm (Europe/Stockholm)". The run had used 7 calls and about 3s of a 200-call / 240-minute budget.

What the run page showed:
- Status pill: "Paused".
- Next-action card titled "The execution limit was reached", with the detail "Stopped at the usage limit of Claude Code. Recorded results are reused when you resume with a fresh budget."
- Budget fields "Maximum calls" and "Maximum minutes", a "Use extended budget" button and the line "New allowance: 200 calls · 240 minutes".
- Primary button "Extend budget & resume".
- The card showed no reset time.
Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4695/002-usage-limit-card.png

Clicking the primary button set resumes=1, re-ran only "Review (round 1)" with Claude, and the run stopped again the same way with the same card.

Second check against the "environment" explanation: I restarted the server with FAKE_CLAUDE_RESETS_AT set to now + 5h, so the server knew a real future reset (quota.json had claude {status:"limited", windows.limit.resetsAt=1792977165000}, i.e. 02:12 tomorrow). Run 2610252012-74b64314 showed exactly the same card. There was still no reset time, and "Extend budget & resume" was enabled. Clicking it before the known reset spent one more Claude call and stopped again.

Part of the report is environmental: the fake always rejects, and its default reset time (1792092600 = 2026-10-15) is already past. So the immediate re-stop after resume is expected in fake mode. A real Claude would also refuse a resume before the reset, though, and nothing in the UI warns against it.

Not by design: docs/runs.md "Recovering work" only says that the resume buttons reuse recorded results with a fresh allowance. Nothing in the docs presents a provider plan limit as an execution-budget limit. The engine comment at src/engin …

</details>

### t06-12 · minor · Stopped or rejected runs are framed as 'Work is paused' + 'Ready to review'; cancelled check says 'Failed (exit code null)'

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-03, RUN-18.

**Repro**

> 1. Fix & review with check 'sleep 25; true' → click Stop checks → Stop work. 2. Separately: Test-first with 'Let me approve the tests' → Reject plan.

**Expected:** Wording that matches the user's action (stopped by you / plan rejected) and no 'Ready to review' invitation for a rejected plan; check transcript says it was stopped.

**Actual:** Pill 'Stopped' and '■ Stopped by you', but the next-action card is titled 'Work is paused … Resume work' and a 'Ready to review' card is shown; after rejecting the tests: 'Work is paused — You rejected the tests… Resume work' plus 'Ready to review' with '1 uncommitted change'. Cancelled check step transcript: 'Failed (exit code null)'.

**Root cause (verifier):** 1. ui/run-experience.ts:56-58 (nextRunAction): every status in ["failed","interrupted","stopped","cancelled"] gets kind "resume". Any status other than stopped or failed gets the title "Work is paused" and the label "Resume work", so a user Stop (cancelled) and a plan rejection look the same as a pause.
   - executionLabel at ui/run-experience.ts:19 calls the same status "Stopped", and ResultCard at ui/run.tsx:599 calls it "■ Stopped by you".
   - The detail is built as `${run.error} Recorded results…`. CancelledError's message "Run cancelled" (src/engine.ts:842-845) has no full stop, which produces "Run cancelled Recorded…".
   - A RejectedError run is stored as status "cancelled" with error "You rejected the …" (src/engine.ts:5527-5529), and nothing marks why it ended. Its resume replays the journaled reject (TeamContext.approve → remember("approval", …), src/engine.ts:1057-1062, journal key approval:<title>#1), so the offered Resume only ends the run again.
2. ui/run.tsx:199: `hasResult = finished && !run.archived && run.worktrees.some(...)` ignores how the run ended. ResultStudio (ui/experience.tsx:91-92) then titles any non-attention result "Ready to review", even for a reject …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/types.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/conversation.test.ts`

**Suggested fix:** (a) Record why a run ended. In the RejectedError branch (src/engine.ts:5527), set a field such as `run.endReason = "rejected"` (or `run.rejected = { at, what }`), clear it on a successful resume, and expose it in RunSummary (ui/types.ts). Optionally give CancelledError's message a full stop ("Run cancelled.") or say "You stopped this run.".

(b) In nextRunAction (ui/run-experience.ts:56-58), split the resume branch:
- Rejected plan: return a non-resume action such as kind "revise"/"restart", titled "You rejected the plan", with the detail "Nothing was built. Edit the task and run again, or delete the run.", the label "Edit & run again", and no fresh-budget copy. Do not offer Resume, because the journal replays the reject.
- Cancelled by the user: title it "Stopped by you" (matching executionLabel and ResultCard), label "Resume work".
- Keep "Work is paused" for "interrupted" only.
- Join error and detail with proper punctuation.

(c) In ui/run.tsx:199, do not render ResultStudio's "Rea …

**Suggested regression test:** 1. test/run-experience.test.ts: add a case asserting `nextRunAction(run({ status: "cancelled", error: "Run cancelled" }))?.title !== "Work is paused"` and that it matches /Stopped by you/. Assert that `nextRunAction(run({ status: "cancelled", endReason: "rejected", error: "You rejected the tests." }))` has a kind other than "resume" and a label without "Resume". Assert that "Work is paused" is returned only for status "interrupted".

2. test/conversation.test.ts, in the existing "reject: the run …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server (v4659b on 127.0.0.1:4659, new home). I added a scratch clone of MQTT-MCP as project "v4659 MQTT" through "Open another repository", then drove everything else from the UI with Playwright. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4659b/ (a02.log, a03.log, a04.log).

Scenario A (run 2610251923-2cc0d07f): Fix & review with check 'sleep 25; true'. While the check ran I clicked "Stop checks" and then "Stop work".
- The API returned status=cancelled and error "Run cancelled".
- The header pill said "Stopped" and the result card said "■ Stopped by you".
- The next-action card was titled "Work is paused", with the text "Run cancelled Recorded results are reused when you resume with a fresh budget." (no full stop after "cancelled") and a "Resume work" button.
- A "Ready to review" card showed "Checks: Not verified for this branch".
- The check step has status "cancelled" but finalText "Failed (exit code null)". The open transcript shows a "Cancelled" badge next to "$ sleep 25; true (failed)" and "Failed (exit code null)" (screenshots shots/v4659b/001-A-after-stop.png and 002-A-check-step.png).

Scenario B (run 2610251924-a70a32d3): Test-first with "Let me approve the plan" on and check 'node --test'. On the "Approve the tests" card I clicked Reject. The dialog said "Reject and end the run? Nothing will be built." and I confirmed with "Reject plan".
- The run ended with status cancelled and error "You rejected the tests.".
- The UI showed pill "Stopped", "Work is paused — You rejected the tests. Recorded results are reused when you resume…" with "Resume work", a "Ready to review" card, and "■ Stopped by you" with "1 uncommitted change left in the worktree".

I also clicked the offered "Resume work". The log says "Resuming: replaying 3 recorded results…". The journal entry approval:Approve the tests#1 = {decision:"reject"} replays, and the run is immediately cancelled again with the same "You rejected the tests." and the same card (shots/v4659b/003-B-after-resume.png). So for a rejected plan the main button leads nowhere.

Ruled out as by-design or environmental:
- docs/runs.md:44 says "Reject: the run ends without building anything", so a resume or review invitation goes against the docs.
- docs/runs.md:114 does allow resuming a run you stopped, so the "Resume" button on a Stop is fine. The "Work is paused" title is still wron …

</details>

### t11-19 · minor · Reject plan confirmation says the run ends, but the run shows 'Work is paused… resume with a fresh budget'

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features TEAM-21.

**Repro**

> 1. Auto team run awaiting plan approval. 2. Click Reject -> confirm 'Reject and end the run? Nothing will be built.' -> Reject plan.

**Expected:** Run ends as rejected, consistent with the confirmation.

**Actual:** Run cancelled with error 'You rejected the Auto team plan.' and a 'Work is paused' card offering resume budget/Use extended budget.

**Root cause (verifier):** A plan rejection is stored exactly like a user Stop, and the UI offers to resume every cancelled run.

1. src/engine.ts:5527-5529 (execute().catch): `else if (err instanceof RejectedError) { run.status = "cancelled"; run.error = err.message; }`. Nothing on the run records that it ended because of a rejection. src/patterns/auto-team.ts:286 throws RejectedError without setting state.status, so run.team.status stays "awaiting_approval" (hence the stale "Team activity · awaiting_approval").
2. ui/run-experience.ts:56-58 (nextRunAction): `if (["failed","interrupted","stopped","cancelled"].includes(run.status)) return { kind: "resume", title: ... : "Work is paused", detail: `${run.error} Recorded results are reused when you resume with a fresh budget.`, label: "Resume work" }`. This treats a rejected run like a paused one. ui/run.tsx:286-306 renders that as the resume-budget card, including "Use extended budget".
3. src/engine.ts:1057-1075 (TeamContext.approve) saves the answer through `this.remember("approval", title, ...)`. src/engine.ts:5349 (resume) has no guard for rejected runs, so resuming replays the saved "reject" and the pattern throws RejectedError again at once (auto-team.ts: …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/types.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/auto-team.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/types.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/conversation.test.ts`

**Suggested fix:** 1. Record the rejection on the run. In the RejectedError branch of src/engine.ts:5527, also set a persisted marker, for example `run.rejected = { at: Date.now(), checkpoint: run.awaiting?.title }`. Alternatively use `run.endReason = "rejected"`: avoid stopReason, which means a budget limit. Add the field to the Run/RunSummary types and the summary projection. In auto-team.ts set state.status to a terminal value, or publish one before throwing, so the team panel stops showing "awaiting_approval".
2. ui/run-experience.ts nextRunAction: before the failed/interrupted/stopped/cancelled branch, return null for rejected runs. Alternatively return a non-resume action such as { kind: "rerun", title: "You rejected the plan", detail: "Nothing was built. Edit the task and run again to get a new plan.", label: "Edit & run again" } that calls the existing editAndRerun. Optionally have executionLabel show "Rejected" instead of "Stopped".
3. src/engine.ts resume(): refuse rejected runs with a clear er …

**Suggested regression test:** 1. test/run-experience.test.ts: add `assert.notEqual(nextRunAction(run({ status: "cancelled", rejected: { at: 1 }, error: "You rejected the Auto team plan.", artifacts: [], worktrees: [] }))?.kind, "resume")`. Also assert that a plain user-cancelled run (status "cancelled", no rejected marker) still returns kind "resume", so Stop stays resumable.
2. test/conversation.test.ts, in "reject: the run ends without building": after `finished(m, run)` assert `run.rejected` is set, and assert `await asse …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4639 on port 4639. Its home had no active runs. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4639/t11-19.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4639/t11-19.log.

1. Through the UI (MQTT-MCP project, New run), I set Workflow=auto-team, left "Let me approve the team and plan" checked, and started a plain run with the task "QA v4639 t11-19: implement the sample". This was a plain run, not the reporter's goal-revision child run, so the bug does not depend on that setup.
2. The awaiting card "Approve Auto team" appeared. I clicked Reject. The dialog read: "Reject this plan? Reject and end the run? Nothing will be built. Cancel / Reject plan". I clicked Reject plan.
3. Server state afterwards: status=cancelled, error="You rejected the Auto team plan.", team.status still "awaiting_approval", 1 worktree, steps=[Plan Auto team]. The header pill read "Stopped". The next-action card read: "Work is paused — You rejected the Auto team plan. Recorded results are reused when you resume with a fresh budget." It showed Maximum calls 200 / Maximum minutes 240, a "Use extended budget" button and a primary "Resume work" button. The collapsed team section said "Team activity · awaiting_approval". Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4639/003-after-reject.png
4. I clicked "Resume work". The event log (homes/v4639/runs/2610251950-2a9e2232.jsonl) shows "Resuming: replaying 9 recorded results, then continuing with a fresh budget". The journal replayed the recorded "reject" approval answer, and the run went straight back to cancelled with the same error. The same "Work is paused / Resume work" card came back. So the offered action does nothing useful: it only flips the run to running for a moment and re-cancels it. There were no console errors.

Another unit (t06, s14-reject.log) saw the same card after rejecting the tests in the Test-first pattern, so every RejectedError checkpoint is affected, not only Auto team.

This is not by design. docs/runs.md:44 says "Reject: the run ends without building anything". docs/runs.md:114 lists runs that can be resumed (limits hit, failed, stopped by you) and does not include rejected ones. The reporter's environment is ruled out be …

</details>

### t19-11 · minor · Review council result's main next step is 'No automated check is configured / Fix check command'; Post to PR is buried

Source: tester unit github-codehosts-imports-1; observed with fake-agents; features GH-11.

**Repro**

> 1. Template 'Review a PR as a council' on an open PR; run to done. 2. Open the run.

**Expected:** For a read-only review the primary action is the review itself (Post to PR / Copy).

**Actual:** Top card 'No automated check is configured · Choose a runnable check before relying on this result… · Fix check command'; the ReviewCard with Post to PR #104/Copy appears only after expanding 'Details and publishing' (run 2610251656-7bbc696b, shots/t19/001-look-2610251656-7bbc696b.png).

**Root cause (verifier):** 1) ui/run-experience.ts:62, `nextRunAction`. The branch `if (checks === "Blocked" || checks === "Not configured") return { kind: "check", … label: "Fix check command" }` runs for every pattern and before any check that a result exists. A council has `artifacts: []` and usually no `loop.check`. In that case `checksLabel` returns "Not configured" (src/run-status.ts:15), so a read-only review gets a "needs-attention" check action. The same function returns null when a check is configured but there is no artifact (test/run-experience.test.ts:56), so a missing check is treated more strictly than an unverified one. The detail text "continuation from the saved result branch" is also wrong here: `RecoveryCheckDialog` (ui/run.tsx:2333-2338) falls back to the original base because there are no artifacts.

2) ui/run.tsx:390-394. For `status === "done"`, `ResultCard` is rendered only inside `<details class="result-details">` ("Details and publishing"), which is collapsed by default. `ResultCard` is the only place `ReviewCard` (ui/run.tsx:629/938) is rendered, and that is where the Post to PR #N and Copy buttons live. `hasResult` (ui/run.tsx:199) is false for a council (no artifacts), so neithe …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** 1) In `nextRunAction` (ui/run-experience.ts), handle review-only results before the check branch. When `run.review` exists (council) and there is no artifact, return a new action kind, for example `{ kind: "publish-review", title: run.review.verdict === "approve" ? "The council approves" : "The council requested changes", detail: "Read the findings, then post the review to the PR or copy it.", label: run.source?.kind === "pr" && !run.review.postedTo ? `Post to PR #${run.source.number}` : "Copy review" }`. More generally, return the "Not configured" check action only when there is an artifact to verify (`artifact && checks === "Not configured"`). That matches how "Not verified" without an artifact already returns null. "Blocked" (checkCantRun) can stay as it is, but the detail should not mention "the saved result branch" when `artifact` is undefined.

2) In ui/run.tsx, render `<ReviewCard>` outside the collapsed "Details and publishing" for review-only runs. For example, show it in plac …

**Suggested regression test:** Unit test in test/run-experience.test.ts. Build a finished council run: `run({ pattern: "council", artifacts: [], worktrees: [{ name: "review", branch: "codeflow/x/review", path: "/r" }], loop: { ...noCheck }, review: { verdict: "changes_requested", findings: [], reviewers: [], markdown: "", summary: "" }, source: { kind: "pr", number: 7, url: "https://github.com/o/r/pull/7" } })`. Assert `nextRunAction(...)?.kind !== "check"` and that it is the review/publish action, with label "Post to PR #7". …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4653t1911 on 127.0.0.1:4653, with a new home. I made a scratch bare and working clone of MQTT-MCP (clones/v4653t1911-mqtt[.git]) and pushed a branch feature/qos-docs with one README commit, plus refs/pull/7/head. fake-gh.json held a single non-draft OPEN PR #7 (head feature/qos-docs, base main). I added the clone through the UI (Open another repository > Go > Open this repository > Create project). In New run I chose Run actions > Use template > "Review a PR as a council", picked #7 and pressed Start run. Under Run options, "Done when this passes" was empty, which is the default for this repo, so loop.check was unset. Run 2610252258-429117bf finished done in about 1s: pattern council, review present, artifacts 0, worktrees 1, source = PR #7.

I opened /#/run/<id> at 1440x900 with a persistent profile (shots/v4653t1911/001-run-initial.png):
- The first thing under the task is a beige "needs-attention" Next action card: "No automated check is configured · Choose a runnable check before relying on this result. You can configure a continuation from the saved result branch. · Saved work: 1 worktree… · [Fix check command]" (primary button).
- The review text is shown inline as the "Team" markdown answer. But `.rb.council` (ReviewCard) and its "Post to PR #7" / "Copy" buttons are not visible: `details.result-details` has no open attribute. They appear only after clicking "Details and publishing" (002-run-expanded-council.png).
- Clicking the primary "Fix check command" opens a dialog whose "Continue from" can only be "Original base · a6a0c8598351" (003-fix-check-dialog.png). There is no saved result branch, which contradicts the card's text.

I followed it once with check "true". It started a whole new council run (2610252259-9403b140, task appended "…Fix any remaining failures…", same source). That child had no Next action card at all, and Post to PR was again only inside the collapsed "Details and publishing" (001-continuation.png). So even with a check configured, a council's publish controls are never in the main flow. The tester's script was not the cause: same result in a fresh home, with a non-draft PR and my own selectors. No console or 5xx errors.

Docs don't support this as intended. docs/github.md:91-96 and docs/patterns.md:16 describe the council as read-only, where the check is optional and Post to PR is the deliverable. docs/runs.md:31 says Fix check command continues "from the saved result branch", which a co …

</details>

### t05-4 · minor · A failed run that produced no changes shows a 'Ready to review' card with Review changes and Preview

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOL-19.

**Repro**

> 1. Export FAKE_CLAUDE_FAIL=auth and start a fake QA server.
> 2. In the composer, choose Claude Code with 'Approve for me', type a task and Send.
> 3. The run fails in 0 s. Below the red failure and the Resume bar, a card reads 'Ready to review · Checks: Not verified for this branch · Review: Not recorded' with a primary 'Review changes' button and 'Preview'.

**Expected:** No 'Ready to review' result card for a failed run with no changes, or a card that says the run failed and nothing is ready.

**Actual:** The result card renders because the run has a worktree artifact (stat ''), even though the run failed and nothing was produced.

**Root cause (verifier):** ui/run.tsx:199: `hasResult = finished && !run.archived && run.worktrees.some(tree => run.artifacts.some(a => a.branch === tree.branch))`. It ignores run.status and whether anything changed. ui/run.tsx:388 then renders <ResultStudio> for every finished solo run, chat mode included.

ui/experience.tsx:92 hard-codes the heading "Ready to review" unless checks failed or review requested changes. It ignores run.status === "failed". It also ignores "no changes", even though ResultStudio already fetches review-coverage at :57 (files, workingChanges) and uses it only for the assessment buttons.

The reporter's suggested fix (gate on artifact.stat, as nextRunAction does at ui/run-experience.ts:49) would be wrong for solo runs. The stat comes from src/engine.ts:2383-2386 conversationResult → diffStat (src/git.ts:645-646, `git diff --stat base..HEAD`), which counts only committed changes. Solo turns never commit (src/patterns/solo.ts:40), so stat is "" for every solo result, including ones with real uncommitted changes. Run 1 above had stat "" with an untracked file. Gating on stat would hide the card for all normal Agent results and break test/e2e/agent-mode.e2e.ts:46-49.

Secondary: test/fa …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/fake-agent.mjs`

**Suggested fix:** 1. Server: make the solo Workspace artifact reflect uncommitted work. In src/engine.ts conversationResult (:2383), combine the committed diffStat with the working-tree diff from workspaceDiff(at, run.baseRef) (src/ship.ts:50, already used by reviewCoverage at engine.ts:4289). Write a stat summary, or add an explicit `changed`/file-count field, so an empty value really means "no changes".
2. UI: add one shared helper in ui/run-experience.ts, e.g. resultArtifact(run) returning the worktree artifact with changes. Use it both for nextRunAction's `artifact` (:49) and for hasResult (ui/run.tsx:199), so the card appears only when there is something to review.
3. ResultStudio (ui/experience.tsx:92): when run.status !== "done", use a heading such as "Changes from the unfinished turn" instead of "Ready to review", and do not present Review changes as the primary action above the Resume/recovery control. Optionally, when review-coverage reports files.length===0 && !workingChanges, drop Review cha …

**Suggested regression test:** Unit, test/run-experience.test.ts: test the new resultArtifact/hasResult helper.
- run({status:"failed", artifacts:[{branch:"result", stat:""}]}) → no result
- run({status:"done", artifacts:[{branch:"result", stat:""}]}) → no result
- run({status:"failed", artifacts:[{branch:"result", stat:"1 file changed"}]}) → result, whose card heading is not "Ready to review"

Engine, e.g. test/patterns or engine solo test: a solo turn that only leaves an untracked file yields a Workspace artifact whose stat …

<details><summary>Verifier's independent reproduction</summary>

Started a fresh fake-mode QA server, v4607 on port 4607. I drove the composer with Playwright: project MQTT-MCP, provider, Permissions "Approve for me", task "Add a one-line comment to README.md describing the project.", Send. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4607/ (a2-fail.mjs, a3-review.mjs).

(1) Reporter's setup, FAKE_CLAUDE_FAIL=auth with Claude Code. Run 2610251758-5636fe5c failed in 0s with "Claude Code isn't signed in…" and the chat Resume bar. Below it the region "Try and assess the result" read "Ready to review · Checks: Not verified for this branch · Review: Not recorded", with Review changes and Preview. The API showed artifacts [{label:"Workspace", stat:""}]. However, the worktree's git status showed "?? claude-c5692f97.txt" and /review listed "1 file · +1 −0". The reason: test/fake-agent.mjs:153 calls work(), which writes <vendor>-<id>.txt in write mode, before the FAKE_CLAUDE_FAIL branch at :182. So the reporter's run did produce a change. A real auth failure would not, which makes this repro a fixture artifact.

(2) A failure that truly writes nothing: restarted with FAKE_FAIL_VENDOR=codex, which calls fail("boom") before any write, and ran Codex. Run 2610251800-331232f9 ended failed with "boom". The worktree was clean with HEAD at base, and review-coverage returned files:[] and workingChanges:false. The same "Ready to review" card still rendered with a primary "Review changes" button (screenshot shots/v4607/002-after-Codex.png). That button opens /review with "0 files · +0 −0 · No changes on this branch." No console or 5xx errors.

(3) Comparison: FAKE_NOOP_VENDOR=claude. Run 2610251800-3683caad finished done with no changes and also shows "Ready to review" with Review changes. So the card does not depend on the run's status or on whether anything changed.

Cleanup: all three runs deleted through the UI (Select runs → Delete). The delete keeps git branches and worktrees by design, so I removed exactly my three codeflow/<id>/solo worktrees and branches from MQTT-MCP with git. Server stopped. No leftovers.

</details>

### t25-14 · minor · A failed run with no changes still shows 'Ready to review' with Review changes / Preview

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-10, UX-13.

**Repro**

> 1. export FAKE_FAIL_VENDOR=claude and start a fake QA server.
> 2. Create a project from a scratch clone and send a task with Claude Code.
> 3. Wait until the run fails.

**Expected:** A failed run with an untouched branch shows only the failure and Resume, without a 'Ready to review' result card.

**Actual:** The header says Failed and 'Didn't finish'. 'claude exited with code 1: boom' appears 3 times, and below it is a 'Ready to review' card with Review changes and Preview buttons. Review shows '0 files · No changes on this branch'. The worktree branch is still at base 2b97323.

**Root cause (verifier):** The server writes an empty "Workspace" result whenever a Single agent turn ends, and the UI then shows that empty result as ready to review.

1. src/patterns/solo.ts:54 calls `ctx.conversationResult(wt)` before the `if (!turn.ok) throw` check on line 55. A failed turn therefore still records a result. The follow-up reply path does the same at src/engine.ts:5866-5869.
2. src/engine.ts:2383-2386 `conversationResult` always sets `run.artifacts = [{ label: "Workspace", branch, path, stat }]`. It does this even when `stat` is "" and the worktree has no uncommitted changes. collectUnfinishedWork (src/engine.ts:6079-6081) does not: it skips such worktrees.
3. ui/run.tsx:199 sets `hasResult = finished && !run.archived && run.worktrees.some(tree => run.artifacts.some(a => a.branch === tree.branch))`. It does not look at run.status, and it does not check whether the branch has commits beyond base or uncommitted changes. So ui/run.tsx:388 renders <ResultStudio> for this failed run.
4. ui/experience.tsx:92 always titles the card "Ready to review", unless checks or review need attention. It ignores the run status and the `files` and `workingChanges` that the card already fetches from /review-co …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/solo.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/conversation.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/agent-mode.e2e.ts`

**Suggested fix:** 1. Server: make `conversationResult` (src/engine.ts:2383) follow the same rule as collectUnfinishedWork. Compute `diffStat` and `uncommittedCount` for the worktree. If both are empty, remove the "Workspace" artifact for that branch instead of recording one. Otherwise record it, adding a note like "N uncommitted changes" to `stat` so that a Single agent's uncommitted work still counts. Removing it rather than leaving it keeps things right when a later turn reverts every change.
2. UI, as a guard for runs already saved with an empty Workspace artifact: in ResultStudio, use the /review-coverage response it already fetches (`files`, `workingChanges`). When `files.length === 0 && !workingChanges`, render nothing, or at most a quiet "No changes yet" note with no Review or Preview buttons. Also, when `run.status !== "done"`, title the card "Work so far" instead of "Ready to review" (ui/experience.tsx:92), so a failed run that did leave changes is not described as ready.
3. Optional, cosmetic: …

**Suggested regression test:** 1. test/conversation.test.ts, in the existing test "single agent: a turn that fails ends the turn, not the conversation" (which uses FAKE_FAIL_VENDOR=claude): after the failed turn, assert `run.artifacts.length === 0`, or that no artifact exists for `run.worktrees[0].branch`. After the "Try again" reply, which the fake agent completes by writing a file, assert there is a "Workspace" artifact. Add a case where a turn reverts its changes, and assert that the artifact is removed again.
2. test/e2e/ …

<details><summary>Verifier's independent reproduction</summary>

I started a new fake QA server, "v4693t2514" on port 4693, with FAKE_FAIL_VENDOR=claude exported first. Its home was new, so there was no leftover state. I made a scratch clone of MQTT-MCP (bare repo plus clone at qa/clones/v4693-mqtt, HEAD 2b97323). In a fresh browser profile I added it through the UI ("Open another repository" > Folder path > Create project, giving project p-107bf9d6). With the defaults (Claude Code, AI team Off, which is the Single agent "solo" pattern) I sent "Add a short note to the README about running tests" from the composer.

The run 2610252311-17df8222 ended with status "failed" and error "claude exited with code 1: boom". The API showed pattern solo, checkpointOnFinish undefined, and artifacts=[{label:"Workspace", branch:"codeflow/2610252311-17df8222/solo", stat:""}].

The page showed:
- The "Failed" status pill and "Didn't finish".
- "claude exited with code 1: boom" 3 times: once in the transcript, once in the turn error bubble, and once in the chat-recovery line above Resume.
- Below that, the "Try and assess the result" region with the heading "Ready to review", "Checks: Not verified for this branch · Review: Not recorded", and the buttons "Review changes" and "Preview".

Clicking "Review changes" opened the review page, which showed "0 files · +0 −0 ... No changes on this branch". In the worktree, `git log -1` was 2b97323 (the base) and `git status --porcelain` was empty. Screenshots are in qa/shots/v4693t2514/: 002-failed-run-studio.png and 003-review-empty.png. The scripts and logs are in qa/work/v4693t2514/ (r1-r3.mjs and .log). The browser reported no console errors or 5xx responses.

Checks for "by design" and tester error:
- I wrote my own selectors and used a new profile and home, and got the same result as the reporter.
- docs/runs.md ("A single agent") only says "A turn that fails ends that turn... Whatever it changed is kept on its branch". It does not ask for a review card when nothing changed.
- The engine's own rule for unfinished runs, collectUnfinishedWork at src/engine.ts:6072-6084, skips worktrees with no diff and no uncommitted changes (`if (!stat && !pending) continue;`). So the empty card goes against the intended design.

Cleanup: I deleted the run through the sidebar (Run actions > Delete… > Delete run), stopped server v4693t2514, and removed the scratch clones v4693-mqtt and v4693-mqtt.git, which also removed the run's worktree and branch. The only thing left is the scratch home qa/homes/v4693t2514.

</details>

### t26-6 · minor · Result card says 'Ready to review' with 'Review changes' for runs that changed nothing, including failed runs

Source: tester unit usability-failure-cases-2; observed with real-agents.

**Repro**

> 1. export FAKE_FAIL_VENDOR=codex; start a fake server; send a Codex task. The run fails with 'boom'.
> 2. The run page shows Failed, then 'boom' four times, then a 'Ready to review' card with Review changes and Preview. Review changes opens the review with '0 files · +0 −0'.
> 3. The same happens with a real agy read-only run (2610251805-e759095e): the worktree is clean, the artifact stat is '', and the 'Ready to review' card is still shown.

**Expected:** With an empty diff there is no 'Ready to review' or 'Review changes' prompt; the card should say there were no changes, and for a failed run point to Resume or retry.

**Actual:** A 'Ready to review' card with a primary Review changes button appears for 0-file results.

**Root cause (verifier):** ui/run.tsx:199: `hasResult = finished && !run.archived && run.worktrees.some(tree => run.artifacts.some(a => a.branch === tree.branch))`. This only checks that an artifact exists. It ignores whether anything changed and ignores the run status.

For Agent chats an artifact always exists. src/patterns/solo.ts:54 calls `ctx.conversationResult(wt)` before the `if (!turn.ok) throw`, so even a failed turn records one, and src/engine.ts:2383-2387 always writes `artifacts=[{label:"Workspace", stat}]`. Its `stat` comes from `diffStat` (src/git.ts:645-646, `git diff --stat base..HEAD`), which only counts committed changes. Agent chats leave their changes uncommitted (solo.ts prompt: "Codeflow does not commit automatically"), so `stat` is `""` whether or not files changed.

ui/experience.tsx:73 builds `choices` the same way. ui/experience.tsx:92 sets the title to `attention ? "Changes need attention" : "Ready to review"`, and ui/experience.tsx:93 always renders the primary Review changes button. Neither checks `run.status` or the emptiness of the change.

ResultStudio already calls /review-coverage at ui/experience.tsx:77, and that endpoint returns `files[]` and `workingChanges` (src/engine.t …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/agent-mode.e2e.ts`

**Suggested fix:** 1. In ResultStudio (ui/experience.tsx:77), keep `value.files.length` from the existing review-coverage response next to `workingChanges`. Define `empty = loaded && files.length === 0 && !workingChanges`.
2. Move the card's wording into a pure helper in ui/run-experience.ts, for example `resultCardState(run, { empty, checks, review })`. Suggested states:
   - Empty and `run.status === "done"`: title "No changes", detail "The agent answered without changing files". Drop Review changes as the primary button; at most keep it as a secondary link. Keep Preview and Continue chatting.
   - Empty and status failed, stopped, interrupted or cancelled: title "Nothing was changed". Point to the Resume/Retry control already shown in chat-recovery (run.tsx:340) or the next-action card (run.tsx:293), and show no primary review button.
   - Not empty but the run did not finish: title "Partial work saved". Review changes becomes secondary and Resume stays primary.
   - Otherwise: keep the current "Ready …

**Suggested regression test:** Unit test in test/run-experience.test.ts for the new `resultCardState` helper:
- `{status:"failed", empty:true}` gives a "Nothing was changed" title and no review primary.
- `{status:"done", empty:true}` gives "No changes".
- `{status:"done", empty:false}` (working changes only, `stat ""`) still gives "Ready to review" with Review changes as primary. This guards against gating on `stat`.

Browser test in test/e2e/agent-mode.e2e.ts or experience.e2e.ts:
- Server started with FAKE_NOOP_VENDOR=clau …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode server: home v4647t266 on port 4647, started with FAKE_FAIL_VENDOR=codex. I worked in a scratch bare and working clone of MQTT-MCP, which I added through "Open another repository". Each run went through the composer with the provider picker scoped to `.composer`. Everything was driven by headless Chrome with Playwright.

(1) Codex, task "Provider failure check for empty result card" (run 2610252330-a65c0539). The run ended `status=failed`, `error="boom"`, pattern `solo`. `run.artifacts` was `[{label:"Workspace", branch:"codeflow/.../solo", stat:""}]`. The page showed "Codex: boom", then "boom" three times with a Resume button, then a card in the region "Try and assess the result": heading "Ready to review", "Checks: Not verified for this branch · Review: Not recorded", a primary Review changes button and Preview. Clicking Review changes opened "0 files · +0 −0 … Changed files 0 · No changes on this branch." Screenshots: qa/shots/v4647t266/001-codex-failed-run.png and 002-codex-failed-review.png.

(2) I restarted my server with FAKE_NOOP_VENDOR=claude. A Claude turn that succeeded but changed nothing (run 2610252337-d7c1b26d) finished `done`. `git status` in the worktree was clean and `stat` was `""`. It showed the same "Ready to review" card, and the review page said "0 files · +0 −0".

(3) Control, before the restart: a normal fake Claude turn (run 2610252335-e178f7d0) wrote one untracked file. `stat` was also `""`, but the review showed "1 file · +1 −0, Working changes: claude-cda69834.txt".

GET /api/runs/:id/review-coverage returned:
- failed run: `files:[]`, `workingChanges:false`
- no-op run: `files:[]`, `workingChanges:false`
- real-change run: `files:[]`, `workingChanges:true`

So `stat` is empty in all three cases, and only `files` together with `workingChanges` separates real work from no work. No console errors and no 5xx responses. This is not caused by the tester's environment. No doc says an empty result should be presented as "Ready to review". docs/runs.md:3 and :16 describe Review changes as the step after the agent answers. test/e2e/agent-mode.e2e.ts:47 asserts the card exists, but nothing tests its title or primary action when the result is empty. I did not repeat the real agy run; the same code path covers it.

</details>

### t07-13 · minor · Result card lists 'Proof: tests without the change' (unproven) as ✕ failures, and done runs with failing checks have no 'What went wrong'

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-25.

**Repro**

> 1. Any fake run with a check that also passes on the base code (e.g. check `true`) that later fails or stops (e.g. claude stalled with FAKE_SILENT_VENDOR=claude, CODEFLOW_STEP_IDLE_MIN=0.25).
> 2. Open the run; look at the step summary and the 'What went wrong' list.

**Expected:** 'What went wrong' lists the actual failure (the stalled review). 'Not proven' is a warning, not a failed step. A done run whose check still fails lists the failing check steps.

**Actual:** 'What went wrong' shows two '✕ Proof: tests without the change — Passes without the change too' entries before the real 'Review (round 1) … stalled' failure. Successful runs show '7 steps · 2 failed'. tdd runs count 'New tests (should fail)' as failed. For done runs with failing checks (S4/S5) the list is never rendered.

**Root cause (verifier):** The engine gives these step outcomes the status "failed", and the UI reads every "failed" step as a real failure with no exceptions.
1) src/engine.ts:1873-1880 (proveLive): the describe callback returns { ok: false } for an "unproven" (or "couldn't tell") proof. src/engine.ts:2155 (command) then does `step.status = ... (described?.ok ?? result.ok) ? "done" : "failed"`, so a proof that passes on the base code becomes a failed step. The run-level proof status stays "unproven", and the summary, artifact card and docs all present that as a ⚠ warning.
2) src/patterns/tdd.ts:133 and :152: `ctx.check(wt, "New tests (should fail)", redCommand)` goes through Engine.check → command() with no describe callback, so the expected red failure becomes status "failed" with the text "Failed (exit code 1)".
3) ui/run.tsx:441 (WorkSummary) counts `steps.filter(s => s.status === "failed")` and shows "· N failed" even on runs that finished green.
4) ui/run.tsx:592 and :610: ResultCard builds failedSteps the same way and renders every one as a "✕" row under "What went wrong" (when run.status !== "done"), so the unproven proofs appear before the real failure.
The engine tests lock in this status mapping:  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/tdd.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/remote.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/proof.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/patterns.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/chat-views.test.ts`

**Suggested fix:** Add a structured way to mark an expected or warning outcome, instead of matching on step titles in the UI:
1) Engine: add an optional field to Step, e.g. `outcome?: "warning"` (or `expected?: true`). Let the command() describe callback return `{ ok, text, warning?: boolean }`, and record it on the step at src/engine.ts:2155.
2) In proveLive (src/engine.ts:1873-1880), return warning: true for "unproven" and "couldn't tell". Keep status "failed" for backward compatibility, or switch it to "done" and update the proof tests.
3) Let Engine.check / ctx.check take an optional describe. In tdd.ts:133/152, pass one so that a red check that fails reads "Fails before implementation, as it should" (ok: true → done), and one that passes is a warning.
4) UI: in ui/run.tsx:441 and :592, exclude warning steps from the "failed" count and from "What went wrong". Show them as ⚠ in the timeline, or as a separate "Warnings" line, so the card matches the "⚠ Not proven" note.
5) Optionally, for runState "fai …

**Suggested regression test:** test/chat-views.test.ts already bundles ui/run.tsx. Export ResultCard (or a `runFailures(steps)` helper used by both ResultCard and WorkSummary) and add a test with run.status "failed" and these steps:
- check "Proof: tests without the change", status failed, outcome warning
- agent "Review (round 1)", status failed, error "stalled"
Assert that "What went wrong" has exactly one row, for "Review (round 1)", and that the work-summary failed count is 1.
Engine side:
- test/proof.test.ts:282 (solo,  …

<details><summary>Verifier's independent reproduction</summary>

I set up a fresh fake-mode server named v4611f on port 4611, with a new home. Before starting it I exported CODEFLOW_STEP_IDLE_MIN=0.25, FAKE_SILENT_VENDOR=claude, CODEFLOW_RETRY_DELAYS_MS=500,1000 and FAKE_SLEEP_MS=300. I made a tiny scratch git repo at qa/clones/v4611f-mini and added it through the UI with "Open another repository" (project "v4611f mini"). I created four runs through POST /api/runs as preconditions, then opened each one in headless Chrome:
- R1 2610252017-58b5cbf4: pipeline; planner and builder codex, reviewer claude (silent); check `true`. It ended as status failed. Steps: s4 and s7 "Proof: tests without the change" were failed with "Passes without the change too: no test needs it", and s8 "Review (round 1)" failed as stalled. The UI showed the card title "✕ Failed" and the work summary "8 steps 49s · 3 failed". "What went wrong" had three rows: two "✕ Proof: tests without the change · Check · Passes without the change too: no test needs it", then "✕ Review (round 1) Claude Code claude printed nothing for 15 s and was stopped (stalled)". In the same card, the artifact box shows this same proof result as a warning ("⚠ Not proven: no test fails without this change"). See shots/v4611f/002-R1-failed-stall-card.png.
- R2 2610252017-bcf0fe0b: same setup with a codex reviewer; status done; card "✓ Finished — the check passes". The work summary reads "8 steps 3s · 2 failed" (the two unproven proofs). See shots/v4611f/003-R2-done-unproven-work.png.
- R3 2610252017-7d6faaf3: tdd with codex/codex; status done; card "✓ Finished — the check passes". The work summary reads "6 steps 2s · 1 failed": the failed step is s2 "New tests (should fail)" (Failed, exit code 1), which is the expected red result.
- R4 2610252017-b681c933: pipeline with check `false`; status done; card "⚠ Finished — but the check still fails"; work summary "7 steps · 3 failed". No "What went wrong" block is shown. However, the card's summary does say "Check `false` still fails after 2 fix attempts" and has a "Last failure" section.

The browser error list was empty in every script. Afterwards I archived (with cleanup) and deleted all four runs through the UI, which returned 404 and left no worktrees or branches, then stopped the server.

How each part of the report holds up:
- Unproven proof shown as a ✕ failure: confirmed, and it contradicts docs/patterns.md:86, which says a result shows "⚠ Not proven", a warning.
- Successful runs counting failed steps: confirmed (2 failed on a  …

</details>

### t06-9 · minor · Pause dispatch never reports 'paused'; run view and History use different words for pause/priority

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-12, RUN-13.

**Repro**

> 1. Start a Fix & review run; while the builder runs click 'Pause dispatch'. 2. Wait until the builder finishes. 3. Compare with Project → Repositories → <worktree> → History.

**Expected:** Once active work has finished the run reads as paused (pill/progress), and both places use the same terms.

**Actual:** Progress keeps saying 'Pausing at a safe checkpoint' indefinitely, header pill stays 'Running', sidebar unchanged. Run view: 'Pause dispatch/Resume dispatch', priority 'Low'; History: 'Pause after active work/Continue dispatch', priority 'Background' for the same -10.

**Root cause (verifier):** There is no "paused" state anywhere in the UI, and two copies of the controls carry different labels:

1. src/experience.ts:41: progressSummary returns "Pausing at a safe checkpoint" whenever run.pauseRequested is true. It returns before the active-steps calculation on line 42, so it never tells "still finishing active work" apart from "nothing running, dispatch held".
2. The engine has no separate paused state. src/engine.ts:2069-2075 (readyForWork) and 3505-3512 (waitWhilePaused) only block while status stays "running". setPaused (src/engine.ts:3476-3483) works out `pending` (whether steps are still running) but only returns it in the HTTP response. It is never stored or shown.
3. ui/run-experience.ts:15-19: executionLabel maps only run.status, so a dispatch-paused run reads "Running". It already uses "Paused" for status "stopped", so that word is taken. ui/rail.tsx:72-80 (statusText) also ignores pauseRequested, so the sidebar keeps the running dot.
4. The labels are duplicated with different wording:
   - ui/experience.tsx:37-38: "Pause dispatch" / "Resume dispatch", and priority -10 = "Low".
   - ui/workbench.tsx:105: "Pause after active work" / "Continue dispatch", and priori …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/workbench.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/experience.test.ts`

**Suggested fix:** 1. Progress card (src/experience.ts progressSummary): compute `active` before the pause branch, then:
   - If pauseRequested and active steps exist: title "Pausing after active work", detail = the active step titles.
   - If pauseRequested and nothing is active: title "Dispatch paused", detail "No work is running. Resume dispatch when you're ready."
2. Shared labels: add one helper next to executionLabel in ui/run-experience.ts, for example DISPATCH_LABELS = { pause: "Pause dispatch", resume: "Resume dispatch" } and PRIORITY_OPTIONS = [[10,"High"],[0,"Normal"],[-10,"Low"]]. Use it in both ui/experience.tsx:37-38 and ui/workbench.tsx:105 so the terms cannot drift again. The History status line "pause requested" should use the same paused/pausing wording.
3. Header pill and sidebar: show "Dispatch paused" when status is running and pauseRequested. Don't reuse the bare word "Paused", which executionLabel already uses for status "stopped".
   - In ui/run.tsx:243 the pill can use the steps  …

**Suggested regression test:** Unit test, test/experience.test.ts, next to "progress puts human blockers ahead of ongoing agent output":
- With pauseRequested and a running step: progressSummary(run("p", { status: "running", pauseRequested: true }), [{ status: "running", title: "Fix the issue" } as Step]).title should match /Pausing/.
- With pauseRequested and only finished steps: progressSummary(run("p", { status: "running", pauseRequested: true }), [{ status: "done", title: "Fix the issue" } as Step]).title should match /pa …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4653 on 127.0.0.1:4653, with FAKE_SLEEP_MS=12000 exported so the builder runs about 12 s. I drove it through the UI with the script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4653/t069-pause.mjs (log in t069-pause.log in the same folder). I did not use the reporter's script, profile or project.

Steps and results:
1. Project MQTT-MCP → new run, workflow "Fix & review" (fix-review), check set to "true", task "QA v4653 t06-9: pause dispatch wording". Run 2610251920-f934015f started.
2. While "Fix the issue" was running I clicked "Pause dispatch" in section.live-progress. The API showed pauseRequested=true. Progress read "Pausing at a safe checkpoint". The header pill read "Running". That is correct at this point.
3. I waited until no step was running, then 8 s more, and stayed about 90 s in total. The API showed status=running, pauseRequested=true, steps ["Fix the issue:done"], and no next step was dispatched, so the engine really was parked in waitWhilePaused. The UI still said "Pausing at a safe checkpoint / Current work is retained...". The header pill stayed "Running". The sidebar still showed the green running dot. The step panel also kept its "Working... 1 step so far" spinner (screenshot shots/v4653/003-t069-paused-idle.png).
4. Project → Repositories → worktree "build" → History. The card read "... · running · pause requested". The button read "Continue dispatch" (the run view says "Resume dispatch"). Priority options were -10=Background, 0=Normal, 10=High (screenshot 004-t069-history.png).
5. I chose "Background" in History; the API showed priority -10. The run view's priority select then showed "Low" for the same value (screenshot 005-t069-runview-low.png).
6. I clicked "Resume dispatch" and the run finished (done). There were no console, page or 5xx errors.

Attempts to refute it:
- docs/api.md:41 says pause should "Hold new dispatch at operation boundaries; active work finishes". The code does that, but nothing documents the run staying "Pausing" after active work ends.
- No doc defines different pause or priority names for History.
- The selectors match the source exactly.
- It does not depend on the environment: it reproduced the same way on a fresh server, project and browser profile.

Cleanup: I archived the run through the UI with "Remove its 1 worktree" and "Also delete its branches" ticked, then deleted it (GET now return …

</details>

### S05-5 · cosmetic · LiveProgress labels priority -10 as 'Low' and orders Normal/High/Low, while Repository tools → History labels the same value 'Background' (ui/workbench.tsx); pause wording also differs ('Pause dispatch' vs 'Pause after active work').

Source: code-level suspect at `ui/experience.tsx:38` (confirmed hands-on).

**Repro**

> Fake-mode s05, one running Fix & review run (check 'sleep 40'). The run view's progress card shows Priority options [Normal, High, Low] and a 'Pause dispatch' button. I chose Low through the UI, and the API then reported priority -10. Project → Repositories → <run worktree> → History shows the same run with Priority [Background, Normal, High], 'Background' selected, and a 'Pause after active work' button. Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s05/001-liveprogress.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s05/001-workbench-history.png

**Expected:** The same run setting has the same name, option order and action wording everywhere.

**Actual:** The run view calls it Low (ordered Normal/High/Low) and 'Pause dispatch'. Repository tools call it Background (ordered Background/Normal/High) and 'Pause after active work'.

**Root cause (verifier):** Two separately hand-written controls for the same /priority and /pause APIs. experience.tsx:37-38 uses 'Pause dispatch'/'Resume dispatch' and <option 0 Normal><option 10 High><option -10 Low>. workbench.tsx:105 uses 'Pause after active work'/'Continue dispatch' and [-10,0,10] → Background/Normal/High (no aria-label on that select, no option keys). No docs define the canonical names.

**Suggested fix:** Extract a shared RunPriorityControl and PauseDispatchButton (or a shared PRIORITY_OPTIONS constant), with one label set ordered High/Normal/Low or Background, and one pause wording. Use them in both experience.tsx and workbench.tsx, and add an aria-label to the workbench select.

**Suggested regression test:** A unit test that both components render the options from the shared constant, or an e2e test asserting identical option text lists in the run view and in Repository tools → History for the same run.

### t07-17 · minor · Cosmetic wording on the run page and check steps

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-25, RUN-26, RUN-28, RUN--GAP-01.

**Repro**

> Seen across the runs above: (1) MAX_CHECKS=1 with two concurrent checks; (2) a single-check run with a missing binary; (3) Review page with a line comment plus an overall comment; (4) interrupted or cancelled check steps; (5) an Agent run without a check; (6) a run whose review is outdated.

**Expected:** Grammatical, accurate labels.

**Actual:** (1) 'Waiting: 1 checks are already running (CODEFLOW_MAX_CHECKS)'. (2) Next-action detail '/bin/sh: qa-missing-runner: command not found You can configure a continuation…' (no sentence break). (3) The button reads 'Send 1 comment' although the overall comment is sent too. (4) Check step finalText 'Failed (exit code null)' with status interrupted/cancelled. (5) Result studio 'Checks: Not verified for this branch' when no check is configured (should be 'Not configured'). (6) 'Review: Review outdated'. Also team answers render literal ** around bold text containing inline code (e.g. '**Approved, and node --test *.test.mjs passes**').

**Root cause (verifier):** (1) src/engine.ts:2128 builds the text as `Waiting: ${checkSlots.size} checks are already running (CODEFLOW_MAX_CHECKS)`, so "checks" is never singular.

(2) ui/run-experience.ts:62 builds `${run.checkCantRun?.reason ?? "…"} You can configure…`, and checkCantRun.reason is raw shell stderr with no closing punctuation. ui/run-experience.ts:58 does the same with `${run.error || run.stopReason || …} Recorded results…`, which produces "Run cancelled Recorded results…".

(3) ui/review.tsx:212 labels the button `Send ${comments.length} comment(s)`. That counts line comments only, but canSend (ui/review.tsx:105) and commentsMessage(comments, general) (ui/review.tsx:110) also include the overall comment.

(4) src/engine.ts:2156 sets step.status from abortedStatus() when this.signal.aborted, but finalText (src/engine.ts:2157-2163) never checks for an abort. A killed check has exitCode null, so it falls through to `Failed (exit code ${result.exitCode})`.

(5) src/run-status.ts:10, `if (branch && checkedBranch !== branch) return "Not verified for this branch"`, runs before the "Not configured" fallback at src/run-status.ts:15. When nothing was ever checked, checkedBranch is undefined and never …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/review.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-status.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/bits.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/pipeline.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ui-review.test.ts`

**Suggested fix:** (1) engine.ts:2128: pluralise, e.g. `const n = checkSlots.busy; text: \`Waiting for a free check slot: ${n} check${n === 1 ? " is" : "s are"} already running (CODEFLOW_MAX_CHECKS=${checkSlots.size})\``.

(2) run-experience.ts:58 and :62: add a small `asSentence(s)` helper that trims and appends "." unless the text already ends in .!?. Or quote the reason, e.g. "The check couldn't run: “/bin/sh: … not found”."

(3) review.tsx:212: `const total = comments.length + (general.trim() ? 1 : 0)` and label it `Send ${total} comment${total === 1 ? "" : "s"}`. This keeps "Send 1 comment" for the line-only flow that test/e2e/ui.e2e.ts:176 clicks.

(4) engine.ts:2157: when this.signal.aborted, set finalText from the status: cancelled gives "Stopped before it finished", interrupted gives "Interrupted when code-flow shut down", stopped gives "Stopped at the run's limit". Optionally, a null exitCode outside an abort should say "Failed (killed by a signal)" rather than "exit code null".

(5) run-status …

**Suggested regression test:** test/run-experience.test.ts:
- `checksLabel(run({ loop: {}, worktrees: [{ name: "solo", branch: "result" }] }), false, "result") === "Not configured"`.
- With loop.check set and no evidence, the same call returns "Not verified".
- The existing "other branch" case still returns "Not verified for this branch".
- `nextRunAction(run({ checkCantRun: { command: "x", reason: "/bin/sh: x: command not found" } }))!.detail` matches /not found\. You can configure/.
- `nextRunAction(run({ status: "cancelled …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server v4619w17 on 127.0.0.1:4619 with CODEFLOW_MAX_CHECKS=1 exported, and confirmed through `ps eww` that the server process had it. I made a throwaway git repo (qa/clones/v4619-tiny, 3 files) and added it through the UI with "Open another repository" and "Create project". I started every run from the composer, using "Approve for me" and the workflow named below. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4619 (s4 to s11) and screenshots in .../qa/shots/v4619w17. No browser errors or 5xx responses in any script. All 7 parts reproduced:

(1) Two Fix & review runs at the same time, checks `sleep 15 && echo ok-a/b`. While /api/health reported busy.checks {running:1,waiting:1,max:1}, the waiting run's Check step said "Waiting: 1 checks are already running (CODEFLOW_MAX_CHECKS)", both in the UI and in the transcript event (shot 002-queue-6135e4d2.png).

(2) Fix & review with check `qa-missing-runner`. The next-action card reads "Verification needs attention / /bin/sh: qa-missing-runner: command not found You can configure a continuation from the saved result branch." There is no sentence break (002-run-f6dd9286.png). The same pattern shows up in the resume card of a cancelled run: "Run cancelled Recorded results are reused when you resume…" (002-cancelled-run.png).

(3) On the Review page of a finished Fix & review run, I added one line comment and then typed an overall comment. The button said "Send comments" with nothing entered, "Send 1 comment" after the line comment, and still "Send 1 comment" after the overall comment (001-review-ready.png). After sending, the follow-up message contained both the line comment and "General: QA v4619 overall comment…".

(4) Fix & review with check `sleep 120`, stopped with "Stop checks" > "Stop work" while the check was running. The step came back as status `cancelled` with finalText "Failed (exit code null)" (003-cancelled-check-step.png). Restarting the QA server during another run's `sleep 120` check gave status `interrupted` with the same "Failed (exit code null)" (001-interrupted.png).

(5) A Fix & review run with the check field emptied. On one page, the next-action banner says "No automated check is configured" while the result studio says "Checks: Not verified for this branch · Review: Approved" (004-run-cc4d51ad.png). An Agent (solo) run with no check also shows "Checks: Not verified for this  …

</details>
