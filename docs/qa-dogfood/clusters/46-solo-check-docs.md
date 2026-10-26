# Cluster 46 · solo-check-docs

**Solo 'Done when' promises and stale docs pages (patterns, getting-started, help companion)**

Status: **fixed and verified** · 8 issues · branch `codex/qa-solo-check-docs`

## Resolution and verification · 2026-10-26

- **t02-3 / t03-5 / t04-8:** Kept the intended Agent conversation engine behavior. Composer text, the check label and effective settings now distinguish ordinary replies from AI-team verification and managed/checkpointed workflows. Ordinary Agent replies show **Check command for merge validation** and explicitly inactive gates; an unavailable saved profile cannot block sending a message. Profiles remain editable and preserved for templates, reruns and a later team/workflow selection. Turning on a team makes profile readiness and errors active. This follows the report's alternative of neutral inactive-profile wording, rather than disabling configuration editing.
- **S03-5:** Patterns now list Fix & review and every built-in name, describe Agent conversations accurately, and use the real 240-minute / 200-step defaults and current invalid-limit behavior. Automatic check/proof descriptions are scoped to managed workflows.
- **S03-6:** Getting started points to **Start from branch** above the task, explains the actual Run options contents and directs provider defaults to **Settings → Agents & models**. The live composer replay checks the branch picker's placement.
- **t10-13:** Documented the two existing defaults rather than changing saved or fresh execution behavior: chat AI-team plan approval starts off; the Advanced **Team — dynamic plan** workflow defaults on. The UI replay verifies the fresh chat checkbox, saving it on and keeping that choice across reload. Fix & review appears in the built documentation.
- **t01-15:** Public/shared/phone docs readers first receive a successful `/api/auth/self` probe and a neutral owner-on-this-computer hint with **Check again**. They do not call `/api/docs-help` or invoke a provider. Owner access still uses the protected endpoint. Desktop, mobile, explicit network failure, sign-in recovery, cookie removal and a server restart were replayed without widening authorization.
- **t01-9:** Retrieval ranks complete paragraphs and bullets with their headings, normalizes common suffixes, reduces filler/common-term influence, and weights the current question above prior questions. The 10,000-character budget and Engineering-record exclusion remain. The exact plain question, the reported “Answer in two sentences” suffix and the follow-up after a side-panel question all retain **Moving a run** and **project chip** in the prompt actually sent through the real Help UI/server to the recording fake CLI.
- **Adjacent regression found during original template/Files coverage:** A passive `FileTree` mount effect could erase text typed immediately after opening Files. Captured failure evidence shows the submitted `README` query reset to empty. The folder reset now runs in a layout effect before the input becomes interactive. The new immediate-input browser repro failed before this change and passes afterward; the original editing/draft flow passes as well.

Evidence is from an isolated checkout and scratch homes/repositories with fake providers, never the live app, real repositories or real credentials. Every app/build/test command supplied an explicit scratch `CODEFLOW_HOME`; browser servers used checked-free ports 4361/4362 and were stopped afterward. Browser artifacts are in `output/playwright/qa-solo-check-docs/` (Agent options, public owner hint, retrieval screenshot, browser JSON, process and application logs). The new replay reports zero unexpected browser errors and zero application errors; only exact injected profile-503 URLs and the explicit offline auth-probe failure are classified as expected.

Validation: new `test/qa-solo-check-docs.test.ts` plus related docs/composer tests **30/30**; conversation/team/start-validation tests **34/34**; new Chrome replay **8/8**; existing docs/draft/preset Chrome cases **14/14**; two affected original Agent UI cases **2/2**; original simplification/template/Files/scheduling cases **8/8**. The final combined new/original browser replay passes **16/16**. Its dialog accessibility check now waits for the finite opening animation before testing the same contrast rules. TypeScript and `git diff --check` pass. Logs are `/private/tmp/codeflow-qa-continue/solo46-{unit,engine,e2e,ui-original,final-browser,tsc}.log`; the intentional fail-before evidence is `solo46-race-before.log` and `solo46-files-race.json` in that directory.

Limitations: the Help provider is deliberately fake, so this verifies supplied retrieval context and end-to-end transport rather than a live model's answer quality. A single paragraph larger than the excerpt budget is skipped in favor of complete smaller blocks. Existing engine semantics and approval defaults are unchanged.

Planner notes: t02-3/t03-5/t04-8: solo (Agent conversation) runs skip the Done-when check and verification gates on purpose unless checkpointOnFinish is set (src/patterns/solo.ts:45-56). teamSentence in ui/composer.tsx (:1048) and the docs still say code-flow runs the check after every turn. Fix the copy, and hide or disable gates for solo, rather than changing the engine. Docs: docs/patterns.md lists 60/40 default limits instead of 240/200 and has no Fix & review row (S03-5); docs/getting-started.md describes the wrong Run options contents (S03-6); t10-13 covers the chat AI team plan-approval default and the patterns table. Help: selectGuides/guideExcerpt in src/docs-help.ts drops the relevant guide section (t01-9). t01-15: an unauthenticated /docs auto-opens the Ask panel with a sign-in error. Most of that is by design; don't auto-open it, or show sign-in guidance, when the user is signed out. Other docs fixes live with their code clusters (team docs in collab-connection-wording, ML docs in memory-ml-stats). Duplicate groups: [["t02-3","t03-5","t04-8"]]

Likely files: `ui/composer.tsx`, `ui/onboarding.tsx`, `src/patterns/solo.ts`, `docs/patterns.md`, `docs/getting-started.md`, `docs/runs.md`, `ui/task-team.tsx`, `src/docs-help.ts`

## Issues

### t02-3 · minor · Agent (solo) runs never run the 'Done when' check, though Run options says 'code-flow runs "<check>" after every turn'

Source: tester unit composer-run-options-1; observed with real-agents; features CMP-23.

**Repro**

> 1. In the composer (Agent mode) set 'Done when this passes' to `true`, or use a repo whose .codeflow/config.json has a check.
> 2. Open Run options. The sentence reads 'Claude Code works on it in its own branch; … · code-flow runs “true” after every turn'.
> 3. Send a task and let it finish.
> 4. Inspect the run steps (GET /api/runs/<id>) and the result card.

**Expected:** The check runs after the turn and the result reports pass or fail, as the sentence promises. Otherwise the sentence should not claim it.

**Actual:** Steps contain only setup/agent; no check step runs. The result card says 'Checks: Not verified for this branch'. Same with a real Antigravity run whose check was 'cd mqtt-python && uv run pytest -q'.

**Root cause (verifier):** ui/composer.tsx:1048 (teamSentence, case "solo") appends ` · code-flow runs “${check}” after every turn` whenever the Done-when field is non-empty. Per git blame, that text dates from d4b007c (2026-10-16). Commit 29628ea (2026-10-22, Agent-mode parity) made automatic checks opt-in. src/patterns/solo.ts:45-53 now calls ctx.commit/ctx.check only when ctx.run.checkpointOnFinish is set; otherwise it calls ctx.conversationResult (src/engine.ts:2383-2387), which only records a "Workspace" artifact. Follow-up replies return early at src/engine.ts:5866-5870 for solo without checkpointOnFinish, before the commit and check at 5884-5885. The composer passes checkpointOnFinish only from a rerun draft (ui/composer.tsx:203), so Agent chats started from the composer never run the check. The sentence was not updated. The same stale promise is in docs/patterns.md:17 (Single agent row: "code-flow commits and runs the check if you set one") and docs/patterns.md:40 ("code-flow runs it itself after each change"). The solo prompt (src/patterns/solo.ts:36-43) also never tells the agent the Done-when command. In an Agent chat the field is used only later, for merge validation (src/engine.ts:4341) and task …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/patterns.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/solo.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/composer-tools.test.ts`

**Suggested fix:** Keep the documented engine behaviour (Agent chats do not auto-check) and make the copy honest:
(1) In teamSentence's "solo" case (ui/composer.tsx:1048), drop "code-flow runs “X” after every turn". Replace it with wording that matches the design, for example " · code-flow doesn't run “X” automatically: ask the agent to run it, or turn on AI team for checked rounds". It could also mention that X is used when validating a merge.
(2) Optionally give the field meaning in Agent mode. In src/patterns/solo.ts, when !checkpointOnFinish and ctx.run.loop.check is set, add a prompt line such as "The project's done-when check is `X`; run it before you report if you changed code". Then the sentence can truthfully say "the agent is asked to run “X”".
(3) Fix docs/patterns.md:17 (Single agent row) and :40 to say that automatic commit and check apply to managed/checkpointOnFinish runs and Team workflows, not to Agent chats, in line with docs/runs.md:64.
(4) Optionally add a hint under "Done when this p …

**Suggested regression test:** Move teamSentence (or just the per-pattern text builder, taking check as a parameter instead of reading the checkCmd signal) into ui/composer-tools.ts. In test/composer-tools.test.ts, assert that for the solo pattern with check "npm test" the sentence does not match /runs “npm test” after every turn/, and that the pipeline sentence still contains 'done when “npm test” passes'. Also add an engine test, alongside test/collab-runner.test.ts:332 or test/proof.test.ts, that pins the contract: manager …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4693 on 127.0.0.1:4693. A previous verifier's home was moved aside to homes/v4693.prev-200327 so this one started empty. I used a fresh browser profile, v4693-t02-3. I bare-cloned MQTT-MCP to scratchpad/qa/clones/v4693-mqtt(.git), opened it through "Open another repository", and created the project "v4693-mqtt".
1) Composer in Agent mode ("AI team Off", Claude Code). Run options → "Done when this passes" = `true`. The .pattern-why sentence read: "Claude Code works on it in its own branch; reply to keep going, like a chat · code-flow runs “true” after every turn" (screenshot shots/v4693/001-run-options-sentence.png).
2) Sent "Add a short NOTES.md file saying hello" → run 2610251904-209181b7. GET /api/runs/<id> returned status done, pattern solo, loop.check "true", checkpointOnFinish undefined, verdict undefined, steps ["agent/agent:done [Your task]"], artifacts ["Workspace"]. No check step. The result card read "Ready to review · Checks: Not verified for this branch · Review: Not recorded" (shots/v4693/002-run-after.png).
3) Replied "Also add a second line to NOTES.md" in the run's composer. Steps became [agent:done, follow-up:done "Your reply"], and follow-up f1 had no checkPassed and no commit. Still no check, so the claim "after every turn" fails for follow-ups too.
4) Control: the same solo task through POST /api/runs with loop.check "true" and checkpointOnFinish:true → 2610251905-5cf443ed. Steps were [agent:done, check/check:done "Check", check:failed "Proof: tests without the change"] and verdict passed. The check machinery works; composer-started Agent chats never turn it on.
No console or 5xx errors. Reproduced 3 of 3 observations. Not caused by environment or selectors.
Refutation attempt: not running the check is BY DESIGN for Agent chats. docs/plans/agent-mode-validation.md:9 says "Agent chats ... leave commits, checks, and PR operations to the agent ... Explicit task runners, remote workers, code-host reviews, and their retries retain automatic checkpoint/check behavior through `checkpointOnFinish`". docs/runs.md:64 says "Agent conversations keep working files without automatically committing ... Managed workflows checkpoint and run configured checks after changes." The sentence that promises the check is what is wrong: it is stale copy that contradicts the documented design. I confirm it as a copy and doc defect, not as an engine bug.
Cleanup: deleted both runs through the UI (sidebar ⋯ → Delete…, and run page "More run  …

</details>

### t03-5 · minor · Agent (solo) runs never run the 'Done when' check or the selected verification gates, though the composer says they will

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-31.

**Repro**

> 1. Fake QA server, project with a repo (e.g. gates sample with build/lint/test scripts).
> 2. New run > workflow 'Agent — one agent'. Set 'Done when this passes' to a command (team sentence reads '… · code-flow runs “<check>” after every turn') or choose Verification gates = Thorough ('Each gate appears in the run's evidence').
> 3. Start and wait for the turn to finish.

**Expected:** The check or gates run after the turn and appear in evidence, or the composer says plainly that Agent conversations don't run checks automatically.

**Actual:** No check step runs. Run 2610251409-2852ebb2 (Thorough) has no verification evidence and shows 'Checks: Not verified for this branch'. Run 2610251415-1e499b17 ran setup but no check. The same profile in Fix & review ran all 6 gates (2610251409-fd3374d2).

**Root cause (verifier):** The engine behaviour is intentional, but the composer still advertises the old behaviour.

- src/patterns/solo.ts:45-54: the turn runs ctx.commit/ctx.check only `if (ctx.run.checkpointOnFinish)`. Otherwise it calls `ctx.conversationResult(wt)` (src/engine.ts:2383-2387), which only records a "Workspace" diff-stat artifact. Follow-up replies take the same route (src/engine.ts:5866-5870 returns before commit/check).
- checkpointOnFinish is set only for triggers, remote workers, code-host runs and the collab runner (src/engine.ts:5298; src/code-hosts-api.ts:53; src/collab/runner.ts:337). The composer passes only `restored?.checkpointOnFinish` (ui/composer.tsx:203). So an Agent run started from the composer can never run its "Done when" check or its verification profile, even though both are stored in run.loop.
- The copy contradicts this:
  - ui/composer.tsx:1048, `teamSentence` case "solo": "· code-flow runs “${check}” after every turn".
  - ui/composer.tsx:399: the verification-gates help says "Each gate appears in the run's evidence" for every workflow, solo included.
  - ui/composer.tsx:365: the Done-when help says "A run without a passing automated check is unchecked". This is acc …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/patterns.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/solo.ts`

**Suggested fix:** Make the composer match the documented design. Agent conversations don't commit or check automatically; managed workflows and an AI-team turn do.

(a) ui/composer.tsx:1048: change the solo sentence. With a check set, it should say something like "· checks (“${check}”) run when you hand the work to the AI team or a managed workflow, not after each turn". Otherwise drop the check clause entirely.

(b) ui/composer.tsx:399: when p.id === "solo" and checkpointOnFinish is false, either hide the Verification gates select, or replace the "Each gate appears in the run's evidence" help with "Agent conversations don't run gates automatically; they apply when an AI team or managed workflow verifies the work." Also don't let an unavailable profile block Start for solo.

(c) ui/composer.tsx:365 and the Run details rows in ui/onboarding.tsx:296/302: for solo, label the command and gates as "used when a team verifies" rather than as the run's done condition.

(d) docs/patterns.md:17: replace "code-flo …

**Suggested regression test:** Add a unit test in test/composer-tools.test.ts, or a new test/composer-copy.test.ts, that imports `teamSentence` from ui/composer.tsx. Set checkCmd.value = "npm test" and call teamSentence(findPattern("solo"), { agent: ["claude"] }). Assert the result does not match /runs “npm test” after every turn/, and that it states checks are not run automatically, e.g. /don't run|not after each turn/i.

Add an e2e/browser assertion in the composer suite: choose "Agent — one agent" plus the Thorough profile …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (v4643, port 4643). I made a scratch git repo at scratchpad/qa/clones/v4643-gates. Its package.json scripts (build, typecheck, lint, test, test:integration, test:e2e) each append their name to scratchpad/qa/work/v4643/marker.log, so any check that runs leaves a line. I added the repo through the UI with "Open another repository" and "Create project". All runs were started from the composer with Playwright (scripts work/v4643/r1.mjs and r2.mjs).

(1) Workflow "Agent — one agent", Done when = `npm run lint`, Verification gates = "Single configured check". The composer sentence read: "Claude Code works on it in its own branch; reply to keep going, like a chat · code-flow runs “npm run lint” after every turn" (screenshot shots/v4643/002-solo-sentence.png). Run details listed Verification command = npm run lint. Result: run 2610251812-e4ad365e finished `done`. Its only step was `agent:Your task`, with loop.check="npm run lint", verdict undefined and run.verification undefined. marker.log got no new lines. The run page showed "Checks: Not verified for this branch · Review: Not recorded" (002-check-run.png).

(2) A follow-up reply in the same chat ("Please also add a second line to README") gave follow-up reply:done with checkPassed=undefined and no commit. Steps were `Your task` and `Your reply` only, marker.log stayed empty, and the run still showed "Not verified for this branch". So the "after every turn" promise also fails on replies.

(3) Workflow Agent, Done when cleared, Verification gates = Thorough. The help text read "Required gates: npm run build · npm run typecheck · npm run lint · npm run test · npm run test:integration · npm run test:e2e. Each gate appears in the run's evidence." Run details showed all 6 gates as required. Result: run 2610251813-5847d356 finished `done` with loop.verification=thorough (6 gates) but run.verification undefined and only one agent step. marker.log was empty and the page showed "Checks: Not verified for this branch".

(4) Control: Fix & review with the same `npm run lint` (run 2610251813-eb8ab451) ran Check steps and wrote "lint" to marker.log 4 times. Verdict was passed and the page showed "Checks: Passed".

No console or 5xx errors. Reproduced 3 of 3 Agent runs.

I also tried to refute it. The engine behaviour is deliberate:
- src/engine.ts:2382 has the comment "Agent turns preserve working files without committing or starting a team verification cycle".
- docs/runs.md:64 says "Age …

</details>

### t04-8 · minor · Agent conversation never runs the 'Done when this passes' check; docs table says code-flow commits and runs it

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-01.

**Repro**

> 1. New run in Agent mode (Codex), Run options → 'Done when this passes' = `test -f README.md`.
> 2. Send; after it finishes, reply once more.
> 3. GET /api/runs/<id>.

**Expected:** Either the configured check runs (as docs/patterns.md:17 says: 'code-flow commits and runs the check if you set one') or the composer hides/flags the check field for Agent conversations.

**Actual:** loop.check saved but lastCheck/verdict undefined after both turns; card 'Checks: Not verified for this branch'; no action to run it (runs 2610251424-5a1ca844, -eb233cd9). Checks only run when checkpointOnFinish is set (API-only).

**Root cause (verifier):** Agent conversations skip the check on purpose, but the UI and one doc page still promise it.

Intended behaviour (not a bug on its own):
- src/patterns/solo.ts:45-56 commits, checks and calls setVerdict only when ctx.run.checkpointOnFinish is set. Otherwise it calls ctx.conversationResult(wt), and the prompt (solo.ts:40) tells the agent "Codeflow does not commit automatically".
- src/engine.ts:5866-5871 returns early for solo replies without checkpointOnFinish, so there is no commit and no ctx.check.
- ui/composer.tsx:203 only sends checkpointOnFinish from a restored rerun, so a new run started from the UI never gets it.
- The design is recorded in docs/plans/agent-mode-validation.md:9 ("Agent chats ... leave commits, checks, and PR operations to the agent"), docs/runs.md:64, and test/conversation.test.ts:207 ("Agent does not run an automatic check after answering").

The defect is the user-facing promise:
1. ui/composer.tsx:1048, teamSentence case "solo": `${one("agent")} works on it in its own branch; reply to keep going, like a chat${check ? ` · code-flow runs “${check}” after every turn` : ""}`. This tells the user the check runs after every turn. It never does.
2. docs/pattern …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/patterns.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/patterns/solo.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`

**Suggested fix:** Make the copy match the intended design; the engine behaviour stays.

1. ui/composer.tsx:1048: drop "· code-flow runs “X” after every turn" from the solo sentence. Replace it with something accurate, for example "· “X” is used when you validate a merge or hand the task to a team; ask the agent to run it each turn".
2. ui/composer.tsx:362-366: when `single` (and not checkpointOnFinish), change the "Done when this passes" help text to say Agent conversations don't run the check automatically. Alternatively, collapse the field under a "Used for merge validation / Team" note.
3. docs/patterns.md:17: change the Single agent row to match runs.md:64. Agent conversations keep working files without committing. code-flow doesn't commit or run the check after each turn; ask the agent, or use merge validation or a team.

Optional, to give the reporter's other expectation an outlet: add a "Run check" action to the solo Ready-to-review card (ui/run.tsx). It would call a small endpoint that runs ctx. …

**Suggested regression test:** Two tests:

1. Composer copy, in test/composer-tools.test.ts (it already imports ui/composer) or a new test/composer-copy.test.ts. Set checkCmd.value = "test -f README.md" and call teamSentence(findPattern("solo"), { agent: ["codex"] }). Assert the result does not match /after every turn/ and does not claim code-flow runs the check. For a contrast case, assert that the loop pattern still says the check runs after every turn.

2. Engine contract, in test/conversation.test.ts next to line 207. Sta …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (v4681 on port 4681) with a bare scratch clone of MQTT-MCP, which I added through "Open another repository". I drove the composer with Playwright. AI team was Off (Agent mode). In the Provider menu I picked Codex, opened Run options, set #checkCmd "Done when this passes" to `test -f README.md`, entered the task "Create a file checked.txt with a greeting", and clicked Send.

Before sending, the composer's run sentence read: "Codex works on it in its own branch; reply to keep going, like a chat · code-flow runs “test -f README.md” after every turn" (screenshot shots/v4681/001-composer-check-field.png).

Run 2610251828-e94432df finished with status done, pattern solo, checkpointOnFinish undefined, loop.check "test -f README.md", lastCheck undefined, verdict undefined and usage.checks 0. I then replied "one more change: add a second line" in the "Message agent" box. After the reply finished (followUps[0] reply done), lastCheck, verdict and commit were still undefined and usage.checks was still 0.

The run's .jsonl has no check events (only run, run-patch, step, agent and log). The card says "Ready to review · Checks: Not verified for this branch · Review: Not recorded". Its only actions are Review changes, Preview, Continue chatting and, under More options, "Mark as test run". Nothing runs the check (screenshot 003-after-turn2.png). That matches the reporter on both turns.

Cleanup: I deleted the run through the UI (Select runs → Delete), stopped v4681, and removed my scratch clones v4681-mqtt and v4681-mqtt.git. No user repos were touched. Deleting the run in the UI kept the run's worktree in the scratch clone because it had uncommitted agent files. That went away when I removed the clone.

</details>

### S03-5 · cosmetic · Docs say default limits are 60 minutes / 40 steps, but DEFAULT_EXECUTION_BUDGET is 240/200. The pattern table omits Fix & review and calls the Agent pattern 'Single agent', which 'commits and runs the check', but solo commits and checks only with checkpointOnFinish.

Source: code-level suspect at `docs/patterns.md:103` (confirmed hands-on).

**Repro**

> Fake server s03. A fresh composer shows 'Limit 200 calls · 240 minutes' and Branches and limits 'stops after 240 min or 200 steps' (shots/s03/001-home.png). The Advanced 'Built-in workflow templates' select lists 'Agent — one agent' and 'Fix & review' (wf.mjs); neither appears under those names in the docs table. Started an Agent run from the composer with check 'npm test' (limits-start.mjs). The run's steps were only 'agent:Your task'. No check step ran and verdict was undefined; the worktree has 'git log' = only the base commit and '?? claude-db0fd57e.txt' uncommitted. The result card said 'Checks: Not verified for this branch'.

**Expected:** Docs match the code: defaults 240 minutes / 200 steps (src/execution-budget.ts:2, run-projection DEFAULT_LOOP). The table includes Fix & review (src/patterns/fix-review.ts; already referenced in github.md and automations.md) and names the Agent pattern as the UI does. The Agent row says files stay uncommitted and no check runs unless the run checkpoints on finish (sweeps, triggers, remote workers).

**Actual:** patterns.md:103 says 60 and 40. The table row 'Single agent … code-flow commits and runs the check if you set one' is wrong for interactive Agent runs, and Fix & review is missing.

**Root cause (verifier):** Stale docs after the budget defaults were raised and solo moved to uncommitted conversations (solo.ts: 'Codeflow does not commit automatically' unless ctx.run.checkpointOnFinish). Related stale UI text: the composer's team sentence for Agent (ui/composer.tsx:1048) also says 'code-flow runs “npm test” after every turn', and no check ran in the repro.

**Suggested fix:** Update patterns.md:103 to 240 minutes / 200 steps (or reference DEFAULT_EXECUTION_BUDGET). Add a 'Fix & review' row (builder, reviewer; fix → check → independent review). Rename the 'Single agent' row to 'Agent' and say commits and checks happen only for checkpointed runs. Also fix the composer.tsx:1048 sentence to omit the per-turn check claim unless checkpointOnFinish.

**Suggested regression test:** A docs consistency test asserting patterns.md mentions DEFAULT_EXECUTION_BUDGET's values and every listed pattern name from src/patterns/index.ts (public ones).

### S03-6 · cosmetic · Docs say Run options holds the base branch and default model/effort per provider; in the UI the base branch is the 'Start from branch' picker in the task box and per-provider defaults live in Settings → Agents & models.

Source: code-level suspect at `docs/getting-started.md:88` (confirmed hands-on).

**Repro**

> Fake server s03 with a scratch repo. Opened Run options and Advanced > Branches and limits (runopts.mjs), then listed every visible control. For Agent: acceptance criteria, check, setup, readiness, workflow, saved templates, permission checkboxes, agent execution, verification gates, Result branch name, Minutes, Agent steps, token and cost ceilings, context. No base-branch control, and the text has no 'base branch'/'Start from'. Branches and limits only shows 'from HEAD (main)' as summary text. Plan → Build → Review adds only per-role model/effort controls ('Codex model for the builder', 'Codex effort for the builder'), with no per-provider defaults. The 'Start from branch' picker (.task-branch) sits in the task box outside Run options (count 1 outside, 0 inside; shots/s03/001-project-created.png). Per-provider ModelRow is rendered only in Settings > Agents & models (ui/settings.tsx:121).

**Expected:** Step 4 tells users to pick the base branch with 'Start from branch' above the task. Default model/effort per provider is set in Settings → Agents & models, while Run options/Advanced set per-role model and effort.

**Actual:** The docs send users to Run options for both, and neither control is there.

**Root cause (verifier):** The docs were not updated when the base-branch picker moved into the TaskBox (composer.tsx:710) and per-provider ModelRow moved to Settings.

**Suggested fix:** Reword getting-started.md:88: 'Pick the base branch with Start from branch above the task. Open Run options for the result branch name, rounds, limits, permissions and per-role model/effort. Per-provider defaults are in Settings → Agents & models.'

**Suggested regression test:** A docs/UI label check, or update the e2e that walks the getting-started flow to look for 'Start from branch' in the task box.

### t10-13 · minor · Docs mismatch: chat AI team plan approval defaults Off, and Fix & review is missing from the patterns table

Source: tester unit ai-teams-patterns-1; observed with code-reading; features TEAM-02, TEAM-07.

**Repro**

> 1. Open AI team -> Advanced -> Limits and approval in a fresh profile: 'Let me approve the plan before teammates start' is unchecked.
> 2. Compare docs/auto-team.md:125 ('Approval defaults on') and docs/patterns.md:7-17 (no 'Fix & review' row, although it's a selectable workflow and the GitHub issue templates use it).

**Expected:** Docs match the defaults and list every selectable workflow.

**Actual:** approvePlan defaults to false for chat teams; the patterns table omits Fix & review.

**Root cause (verifier):** There are two separate gaps.

**(1) Plan approval default.** On a fresh profile, `defaultTaskTeam` at ui/task-team.tsx:24 returns a hard-coded `approvePlan: false` when there is no saved `taskTeamPreferences`. The chat team then launches the auto-team pattern at src/engine.ts:3935 and passes `approvals: { plan: config.approvePlan }` at src/engine.ts:3951. This skips the per-pattern default that the composer workflow path uses: `planApprovalFor` (ui/state.ts:715) calls `defaultPlanApproval` (ui/team-state.ts:3-4), which returns true for "auto-team".

Commit 29628ea rewrote docs/auto-team.md:1-7 to describe the new chat Team toggle ("Open **Team**, enable it…"). It kept the old Auto-pattern sentence "Approval defaults on" while adding the false default in task-team.tsx. Docs and design plan (docs/dynamic-teams-implementation-plan.md:298) now disagree with the Team toggle that new users actually see. A fresh composer defaults to `patternId` "solo" (ui/state.ts:640), so the Team toggle is the main way to start a team.

**(2) Patterns table.** docs/patterns.md:7-17 lists Auto team, Plan → Build → Review, Loop, Race, Debate, Supervisor, Test-first, Council and Single agent. The intro at  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/task-team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team-state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/auto-team.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/patterns.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/team-ui.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/docs.test.ts`

**Suggested fix:** **Approval default.** The design plan (docs/dynamic-teams-implementation-plan.md:298) and the existing test (test/team-ui.test.ts:24) say a fresh Auto team should ask for approval, so change the code rather than the docs:
- Move the fresh default into a pure helper in ui/team-state.ts, e.g. `freshTaskTeam(lead)`, with `approvePlan: defaultPlanApproval("auto-team", undefined)`, which is true.
- Have `defaultTaskTeam` in ui/task-team.tsx:24 use that helper.
- Keep honoring a saved `taskTeamPreferences.approvePlan`, so users who already turned it off keep their choice.

If the product owner prefers off-by-default for chat teams, rewrite docs/auto-team.md:7 instead. For example: "In AI team setup, plan approval is off by default; tick Limits and approval → Let me approve the plan before teammates start. The Team — dynamic plan workflow in Advanced defaults to approval on." Also note it in docs/getting-started.md.

**Patterns table.** Add a "Fix & review" row to docs/patterns.md, after Auto …

**Suggested regression test:** **test/team-ui.test.ts.** Add a case asserting `freshTaskTeam("claude").approvePlan === defaultPlanApproval("auto-team", undefined)`, which is true. The case should also check that a saved preference with `approvePlan: false` is preserved. This needs the pure helper extracted from ui/task-team.tsx so it can run under `node --test` without preact or localStorage.

**test/docs.test.ts.** Add a test that imports `patterns` from src/patterns/index.ts and asserts that every `p.name` except Agent/solo …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, `qa-server.sh start v4649-t1013 4649 fake`. It got a new home rather than the reused v4649 home, because that one already had runs. I drove it with headless Chrome from a fresh browser context with no persistent profile, using the scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4649/ (t10-13.mjs, t10-13b.mjs, t10-13c.mjs, t10-13e.mjs).

1. **Fresh New run composer.** It opens in Agent mode with "AI team Off", and `localStorage.taskTeamPreferences` is null. I clicked the AI team switch, then Advanced (the "AI team setup" dialog), then expanded "Limits and approval". "Let me approve the plan before teammates start" was unchecked (`isChecked() === false`). After the toggle, the stored preference was `{"enabled":true,"preset":"adaptive",...,"approvePlan":false}`. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4649-t1013/001-team-approval-checkbox-visible.png. I got the same result twice, from separate fresh contexts.

2. **Contrast in the same fresh browser.** I opened Run options, then Advanced, then "Built-in workflow templates" and chose "Team — dynamic plan" (auto-team). Its checkbox "Let me approve the team and plan before agents build" was checked. So "Approval defaults on" is true only for that Advanced workflow, not for the Team toggle that the docs paragraph describes.

3. **Consequence.** I made a throwaway local git repo. Using the exact config the fresh UI produced, I posted `/api/runs` (pattern solo, task "AUTO-MINIMAL implement the fixture", taskTeam = UI default). The adaptive team execution 2610252036-c7fe0c10 started with `approvals {"plan":false}`, never had an `awaiting` checkpoint, went straight to running tasks and finished. Its run log has no approval event.

4. **Fix & review.** The workflow select lists "Team — dynamic plan, Agent — one agent, Fix & review, Plan → Build → Review, Loop until green, …", and I could select fix-review. `/api/patterns` returns `fix-review: Fix & review` second. The in-app /docs/patterns.html page does not contain "Fix & review", and `grep` of docs/patterns.md finds no Fix & review row or mention.

The in-app /docs/auto-team.html does contain "Approval defaults on". No console or 5xx errors.

Corrections to the report:
- The docs sentence is at docs/auto-team.md:7, not :125.
- The "GitHub issue temp …

</details>

### t01-15 · cosmetic · Unauthenticated /docs auto-opens the Ask code-flow panel with a sign-in error and logs 401s

Source: tester unit shell-navigation-settings-2; observed with api; features SHL-41, SHL-43.

**Repro**

> 1. In a browser without the owner cookie, open http://127.0.0.1:<port>/docs/ on a desktop-width window.

**Expected:** The companion stays closed, or shows a neutral sign-in hint without failed requests, for a docs reader who is not the owner.

**Actual:** The panel opens by default with 'Not signed in: use the owner link or sign in to shared projects' and 'Retry connection'; the console shows repeated 401 Unauthorized for /api/docs-help.

**Root cause (verifier):** Most of the reported behaviour is documented, intended design:
- docs/help.md:13 says "The companion sits beside the guide on desktop", so it is open by default.
- The troubleshooting row at docs/help.md:36 lists "Not signed in | Open the owner app using its current terminal link, then reopen the docs", so this state was expected.
- The e2e test (test/e2e/docs.e2e.ts:115-117) deliberately keeps /docs/ public while /api/docs-help returns 401.

What remains is a cosmetic defect in how that state is detected and worded:
1. docs/site/app.js:173 sets `let opened = typeof saved.open === "boolean" ? saved.open : !mobile.matches;`. Then app.js:341 (`if (opened) openHelp(false)`) runs openHelp (app.js:187-193), which always calls connect(). connect() at app.js:240 does `fetch("/api/docs-help")` without first checking who is signed in, so every guide load by a reader who is not the owner makes a request that fails with 401. Chrome logs each one as a console error. A non-error probe already exists: src/server.ts:1536 returns 200 {kind:"anonymous"|"owner"|shared identity} from /api/auth/self.
2. At app.js:242 (`throw Error(data.error || "Open the owner app and sign in to use the companion.")`) …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/site/app.js`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/docs.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/help.md`

**Suggested fix:** Change connect() in docs/site/app.js:
- Before fetching /api/docs-help, call GET /api/auth/self. It is same-origin, always returns 200, and is already public.
- If kind !== "owner", skip the docs-help fetch. Show a neutral, owner-specific hint such as "Ask code-flow is available to the app owner. Open Code Flow from its terminal link, then reopen the docs." Link it to help.html#troubleshooting. Hide "Retry connection", or relabel it "Check again" and keep it, since it uses the same probe.
- Optionally, for a non-owner who has never opened or closed the panel (no saved.open), default `opened` to false so the guide gets the full width.
- Separately, have the client use its own companion message instead of the server's generic 401 text (the shared-projects wording). For example, if response.status === 401, use "Open the owner app and sign in to use the companion." without depending on data.error.
- Keep docs/help.md:36 in line with the new wording.

No server change is needed.

**Suggested regression test:** Add a test to test/e2e/docs.e2e.ts, e.g. "unauthenticated desktop docs reader gets a neutral owner hint without failed API calls":
- Use a new browser context without the token cookie, set the viewport to 1440x900, record every response and console error, and goto base + "/docs/".
- Assert that no response to /api/docs-help has status 401 (ideally there is no request to /api/docs-help at all).
- Assert that no console error matches /401/.
- Assert that the panel is either hidden, or #help-status …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server ("qa-server.sh start v4637 4637 fake"; it created no runs and I stopped it afterwards). Then I ran /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4637/t01-15.mjs. It uses a brand-new Playwright Chrome context with no token or cookie, so it does not use openApp, which always signs in. Output is in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4637/t01-15.log.

(a) Unauthenticated, 1440x900, open http://127.0.0.1:4637/docs/. #help-panel is visible and #open-help has aria-expanded=true. #help-status says "Not signed in: use the owner link or sign in to shared projects" and the "Retry connection" button is visible. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4637/unauth-desktop-index.png.
- Going on to /docs/help.html gave 2x "401 GET /api/docs-help" in total, one per page load. Each produced a console error "Failed to load resource: the server responded with a status of 401 (Unauthorized)".
- After clicking Close (the closed state is saved in sessionStorage) and opening another guide, there were no requests or errors.

(b) Unauthenticated at 390px: the panel is closed and nothing is requested.

(c) Owner signed in via ?token at desktop width: the panel opens, GET /api/docs-help returns 200, and there are no errors.

curl without credentials: /api/docs-help returns 401 {"error":"Not signed in: use the owner link or sign in to shared projects","signIn":true}. /api/auth/self returns 200 {"kind":"anonymous"}.

So the report reproduces exactly. "Repeated" 401s means one per guide page load until the reader closes the panel.

</details>

### t01-9 · minor · Ask code-flow drops the relevant guide section: real Codex could not answer a question documented on the current page

Source: tester unit shell-navigation-settings-2; observed with real-agents; features SHL-43.

**Repro**

> 1. Real-mode server; open /docs/runs.html signed in and select Codex (effort low).
> 2. Ask 'How do I move a run to another project?'.

**Expected:** The answer cites docs/runs.md 'Moving a run: click the project chip…'.

**Actual:** Answer: '…the supplied excerpt does not explain where to move a run to another project.' Deterministic check: the runs guide body is 27,703 chars and selectGuides returns a 10,000-char excerpt without 'Moving a run' (the section scorer matches 'move' but not 'moving').

**Root cause (verifier):** src/docs-help.ts, guideExcerpt (lines 152-180), plus how selectGuides builds its query:
- Lines 116-132: question words are raw substrings with a 10-word stoplist. Filler such as "answer", "two", "sentences" and words from earlier turns count as signal. "move" does not match "Moving", because the scorer has no stemming.
- Lines 159-165: a section's score is +10 per word found in its heading and +1 per word found anywhere in it, each counted once. "run" appears in almost every section of the runs guide, so many sections tie (five at 13).
- Line 167: ties are broken by document position (a.index - b.index), not by how specific the match is.
- Lines 170-174: sections are added greedily, and the first one that does not fit is cut with section.text.slice(0, remaining). This keeps the start of that section and drops its end, even when the matching bullet is near the end (offset 2,276, against 2,229 chars of budget left).
- Lines 210-214: answerHelp joins all history questions with the current one before selection. Follow-up turns therefore dilute the ranking; the side-panel question pulls in "The side panel" (9.6k chars).
- Line 138: the page being viewed gets only +12 in guide ranking,  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/docs-help.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/docs-help.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/help.md`

**Suggested fix:** Rework guideExcerpt so the excerpt keeps the paragraph or bullet that matches, not the start of whichever section is cut.
(1) Turn text into word tokens and stem them lightly (drop -ing/-ed/-es/-s/-e), so move, moving and moved match. Add common filler words to the stoplist (answer, please, explain, tell, sentences, two, briefly, ...).
(2) Weight terms from the current question fully and terms from earlier turns lower (about 0.3). Do not mix the history questions in as equal terms.
(3) Score smaller blocks: paragraphs, and "- " bullets inside each "## " section. Weight each term by how rare it is in the guide, so near-universal words like "run" add little.
(4) Fill the budget with the highest-scoring blocks, keep each block's section heading, and output in document order. When a block does not fit, skip it and keep trying smaller ones; never slice the head of a section.
(5) Optionally give the page being viewed a larger budget (for example 15-20k) and update the "10,000 characters each …

**Suggested regression test:** In test/docs-help.test.ts, add "retrieval keeps the matching bullet of a long current-page guide".

Fixture: a synthetic guide with id "runs", over 10,000 chars, built like docs/runs.md:
- several "## ... run ..." sections of about 1.3-4k chars each, placed before ## Projects;
- a "## Projects" section of about 3k chars whose last bullet is "- **Moving a run:** click the project chip at the top of the run.";
- a long "## The side panel" section.

Assertions:
- selectGuides(guides, "How do I move …

<details><summary>Verifier's independent reproduction</summary>

Fresh QA homes, nothing reused. The source is commit f14f404 and its prebuilt public/docs/search.json, where the runs guide body is 27,703 chars.

1) Deterministic check. Scratch script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4625/excerpt.mts imports selectGuides from src/docs-help.ts and runs it with page="runs".
   - The exact question in the report's step 2, "How do I move a run to another project?", keeps the "Moving a run" bullet. The runs excerpt includes the whole ## Projects section, so the repro as written does NOT reproduce.
   - The reporter's script (work/t01/s23-ask-real.mjs) actually typed "...another project? Answer in two sentences.". With that question the excerpt drops the bullet.
   - Section scores with the suffix: five sections tie at 13 (# Runs and workspace, The run view, Talking to a run, Projects, Insights). Ties are broken by document order, so sections 0, 1 and 3 use 7,771 chars. ## Projects is then cut at the remaining 2,229 chars, but "Moving a run" sits at offset 2,276 of that section, so it is lost by 47 chars.

2) Through the UI on a fresh fake-mode server (v4625h, port 4625, FAKE_RECORD_DIR set). Opened /docs/runs.html, chose Codex in Ask code-flow, and checked the prompt the server sent to the CLI each time:
   - Plain question: the runs excerpt includes "Moving a run" and "project chip".
   - Same question plus "Answer in two sentences.": both strings missing. The Projects section ends mid-word at "...or moving one there, adds the repository if it's missi".
   - A natural follow-up: New chat, ask "What does the side panel show?", then "How do I move a run to another project?". Both strings missing, because the earlier question is mixed into the retrieval query and pulls in the side-panel section.
   - No console or 5xx errors.

3) One real run on a fresh real-mode server (v4625r): Codex, effort low, 11 s, the reporter's suffixed question asked on /docs/runs.html. The answer was: "'Runs and workspace' confirms that moving a run to another project also adds its repository to that project, but the supplied excerpt does not show the UI location or steps for moving it. Open the full 'Runs and workspace' guide's Projects section for the missing instructions." The answer lists "Runs and workspace" as a source, but the instruction is missing. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be …

</details>
