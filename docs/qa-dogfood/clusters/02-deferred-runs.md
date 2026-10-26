# Cluster 02 · deferred-runs

**Deferred runs ('Run once later'): null verification profile, retention, startup load, stale UI**

Status: **merged · verified · repair round 1 merged** · 8 issues · branch `qa-fix/deferred-runs` (+ `qa-fix/deferred-runs-r1`)

Planner notes: Main bug: for the default 'Single configured check', runBody in ui/composer.tsx sends loop.verification:null. The deferred-run sanitizer in src/deferred-runs.ts treats any value other than undefined as a profile and rejects it. Accept null as 'none' on the server, and/or omit it on the client. t16-1: a corrupt deferred-runs.json crashes server startup through the unguarded top-level await in src/server.ts (~2752). Record a fault and keep serving, the way projectTeams.load() does. The coordinated-changes cluster fixes the neighbouring coordinatedApi load the same way, so touch only your line. t16-10: the retention trim must keep failed jobs that can still retry, and finished records must be removable. t16-11: clear the stale-revision error when the card refreshes. S10-1: recompute the 'earliest start' default. t15-2: automationRun() (server.ts ~982) and the deferred sanitizer drop taskTeam; keep it for both automations and deferred runs. Duplicate groups: [["t15-1","t16-18","S01-1"]]

Likely files: `src/deferred-runs.ts`, `ui/deferred-runs.tsx`, `ui/composer.tsx`, `src/server.ts`, `ui/automations.tsx`

## Fix result

Commits:
- `0dbd3d7` Accept null run options when deferring a composer request
- `edb633e` Keep serving when the deferred queue file cannot be read
- `1cb8931` Refuse AI team for scheduled runs instead of dropping it
- `f62f118` Keep retryable deferred failures and let finished records be removed
- `2f4d1f0` Clear a stale deferred conflict once the card shows the newer job
- `82c7e3d` Keep the suggested deferred start time in the future
- `d909267` Cover the deferred-run QA regressions

Fixer notes for the integrator: The branch is based on f14f404. `git merge-tree` against the current claude/dogfood-qa-2026-10-25 tip (4 commits ahead) merges cleanly. No existing test files were edited. Behaviour changes other clusters or tests might notice:

1. **t15-2 decision.** The cluster note said to keep taskTeam for automations and deferred runs. I did not, because engine.ts:5095 throws for any taskTeam on a triggered run, so every scheduled fire would fail. Instead, POST /api/automations, automation update and POST /api/deferred-runs return 400 when taskTeam.enabled is true, and both schedule dialogs explain why and disable Save. A disabled taskTeam is still dropped silently. Converting AI team to the auto-team pattern on save would be a product decision.
2. **t16-1.** Every /api/deferred-runs request now answers 503 while the queue file is unreadable. Only the deferredRuns.load line in the startup block was changed; the coordinatedApi.service.load line is left for the coordinated-changes cluster.
3. **New route** POST /api/deferred-runs/remove `{jobs:[{id,expectedRevision}]}` returns `{removed:n}`. It is covered by the existing filesystem-access prefix rules for deferred-runs.
4. **Repeat cancel.** DeferredRuns.cancel() is now idempotent for an already-cancelled job, even with a stale revision. Stale retry and attach still return 409. Existing test/deferred-runs.test.ts conflict assertions are on non-cancelled jobs and still pass.
5. **Save errors in DeferredRunsPanel** now render in their own al …

## Independent verification

- **t15-1: verified** — Fresh headless browser (no profile) on QA server v02 (fake mode, port 4351, built from fe7e449), project VDR on a scratch repo. Opened New run and typed a task; #verification-profile stayed at '' (Single configured check). Went to Run actions > Schedule… > Run once later > Queue this run configuration > Save deferred run. (1) Chosen-time start: the review JSON and the POST body loop were {check:'',setup:'',maxMinutes:240,maxSteps:200}, with no verification key. Response was 201, the card showed 'Waiting for start time', there were no alerts and errors[] was empty. (2) Default 'As soon as conditions are ready': 201, then the job became 'started' with fake run 2610260126-b2c86387. API with an  …
- **t16-1: verified** — Stopped v02 and wrote '{"version":1,"jobs":[{"id":"oops"' into homes/v02/deferred-runs.json, then restarted. The server stayed up. The log has one line, 'code-flow: Deferred runs disabled: repair …/deferred-runs.json and restart: Deferred queue cannot be read: Expected ',' or '}' …', and no Uncaught. Status codes: /api/health, /api/projects, /api/automations and /api/runs returned 200. GET /api/deferred-runs and POST /api/deferred-runs/remove returned 503 with the exact read error plus 'Repair <file> and restart code-flow.' In headless Chrome, Scheduling > Run once later showed that message as a role=alert (screenshot shots/v02/001-t16-1-truncated-scheduling-once.png). Saving from composer > …
- **t16-10: verified** — Built a retryable failure through the real launcher: a job on project VDR-gone with projectSelection explicit, notBefore +3s, with the repo directory renamed before launch. It ended failed 1/3 'git rev-parse … spawn git ENOENT'. I then enqueued and cancelled 205 filler jobs via the API. Result: 200 retained, {cancelled:196, failed:1, waiting-time:3}. 'QA-tiny repo removed' was still failed 1/3 (before the fix it was evicted at exactly this point); the oldest finished records went first. In the UI (#/automations/once) the header count was 4 (3 waiting plus the retryable failure). Section buttons were 'Refresh queue' and 'Clear finished (196)'. The failed card offered 'Cancel deferred run' and …
- **t16-11: verified** — One browser context with two tabs on #/automations/once and a waiting job (notBefore +2h). Tab A: Cancel deferred run, then Cancelled. Tab B, still stale: Cancel deferred run returned POST /cancel 200 (no 409). B's badge showed 'Cancelled' at once, alerts were [], and the only button was 'Remove record'. After a 6s poll alerts were still []. Variation with a stale retry: on a retryable failed job, A cancelled it, then B clicked 'Retry after reviewing the failure'. That returned 409, B's card switched to 'Cancelled' within 53 ms with no alert, and the toast read 'This deferred job changed elsewhere and is now: Cancelled.' After clicking Refresh queue there were still no alerts. The only conso …
- **S10-1: verified** — Real composer dialog (not the e2e fixture) with page.clock.install. Opened Schedule… > Run once later > Queue this run configuration, then fastForwarded 30 min and chose 'At or after a chosen time'. The field suggested 59 min ahead of page time, with min set to the current local time, so it is recomputed rather than fixed at mount. I then fastForwarded 1h01m with the suggestion untouched (field 2 min in the past) and clicked Save. The alert read 'The suggested start time passed while this was open. It now suggests an hour from now; review it, then save again.', the field moved to +59 min and no job was saved. The alert survived the 5s poll (it used to be cleared by setError('')). The second  …
- **t15-2: verified** — The fixer kept the refusal approach, which matches the issue's alternative 'or the dialog says the team will not be used'. engine.ts:5153 rejects any taskTeam on a triggered run, so keeping it would make every fire fail. Composer with the AI team switch on (aria-checked=true): in Schedule… > Repeat, role=status said 'AI team works only in a live Agent conversation, so scheduled runs cannot use it…', Save automation was disabled with that title and the help said 'this agent'. In Run once later the same status appeared and Save deferred run was disabled. At 390px the notice was visible with no overflow. With AI team off, Repeat showed no notice and saved (201); the POST carried taskTeam enable …

Code-review findings:
- [minor] `src/server.ts:1996` While the queue is faulted, every poll of /api/deferred-runs returns 503. That is the Run once later panel every 5s and ui/project-features.ts every 15s on any project page. The server logs 'GET /api/deferred-runs failed: …' each time and the browser logs a console error each time. A broken queue file therefore keeps spamming server.out and the console until restart. A 4xx status, or the panel/poller backing off after a fault, would avoid this.
- [nit] `ui/deferred-runs.tsx:63` When the queue is faulted the panel still renders the header count 'Deferred runs 0' and 'No deferred runs in this scope.' under the error alert. Both read as 'empty queue' when the real state is 'unreadable queue'.
- [nit] `src/deferred-runs.ts:62` finished() treats every cancelled job as removable, including one cancelled from 'unknown' queue recovery. That job's history may hold a late run receipt for a run that 'may still need to be stopped separately'. Remove record or Clear finished discards that receipt without any extra warning. The run itself still appears in the runs list, so impact is low.
- [nit] `test/e2e/qa-deferred-runs.e2e.ts:160` The S10-1 regression test drives a standalone esbuild bundle of DeferredRunsPanel, not the real composer's Schedule… > Run once later dialog. It would not catch a regression in how the composer mounts or keeps the panel open. I verified the real composer path manually and it behaves correctly.

Repair round 1: 3 commit(s), items review-1:fixed; merged: yes

## Issues

### t15-1 · major · 'Run once later' from the composer always fails with 'A verification profile is required' unless a verification preset is chosen

**Fix outcome: fixed.** src/deferred-runs.ts:79,106-110: new given() helper; sanitizeDeferredRequest treats null as 'none' for verification, remoteWorker, contextBudget and agentContainer, matching POST /api/runs (malformed non-null values such as {} or "x" are still refused). ui/composer.tsx:230 sends `verification: verificationProfile ?? undefined` so the composer never serialises null. Root cause confirmed: runBody sent loop.verification:null and the sanitizer validated anything !== undefined, so validateVerificationProfile(null) threw.

Fixer's check: QA server f02 (fake, 127.0.0.1:4347, fresh home + scratch repo) started from the worktree after rebuilding the UI. Same steps as the tester: New run, default 'Single configured check' (#verification-profile value ""), Run actions > Schedule… > Run once later > Queue this run configuration > Save deferred run. With defaults the POST returned 201 and the job launched (card 'Run started', fake run 2610260108-d5028d47). With 'At or after a chosen time' it returned 201 and showed 'Waiting for start time'. The review JSON no longer contains a verification key, there were no dialog alerts and the browser errors array was empty. API isolation like the verifier's: run.loop.verification:null returned  …

Tests: `test/qa-deferred-runs.test.ts`, `test/qa-deferred-runs-server.test.ts`, `test/e2e/qa-deferred-runs.e2e.ts`

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-25.

**Repro**

> 1. Fresh QA server (fake mode), project with a repo. 2. Open New run (fresh browser profile), type any task. 3. ⋯ (Run actions) > Schedule… > Run once later. 4. Expand 'Queue this run configuration' and click 'Save deferred run' with defaults. 5. The error 'A verification profile is required' appears and no job is created. 6. Workaround: Run options > Advanced > Verification gates = Lightweight, then save works.

**Expected:** With the default 'Single configured check' the deferred run saves, as Start run does.

**Actual:** POST /api/deferred-runs returns 400 'A verification profile is required'. The default composer config can never be deferred. Reproduced twice (existing draft profile and fresh profile).

**Root cause (verifier):** ui/composer.tsx:127 initialises verificationProfile to null. selectVerification("") at line 146 also sets it to null for the default "Single configured check" preset. runBody then always sends `loop.verification: verificationProfile` (ui/composer.tsx:230). JSON keeps null (unlike undefined), so the deferred body carries `"verification": null`. ScheduleRunDialog (ui/composer.tsx:425-427) passes that body to DeferredRunsPanel, which POSTs it unchanged (ui/deferred-runs.tsx:43-47). On the server, automationRun (src/server.ts:982-984) keeps `loop` as-is, and sanitizeDeferredRequest at src/deferred-runs.ts:102 tests `if (loopRaw.verification !== undefined) loop.verification = validateVerificationProfile(loopRaw.verification);`. validateVerificationProfile(null) throws "A verification profile is required" (src/verification.ts:56). The normal Start run path does not hit this because it uses a truthy test (src/server.ts:925 `if (body.loop?.verification)`). The same pattern appears at src/deferred-runs.ts:101 (`remoteWorker`) and :104 (`agentContainer`), but the composer sends undefined for those, so only verification breaks today. sanitizeDeferredRequest is also used by the coordinated-cha …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/deferred-runs.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/deferred-runs.test.ts`

**Suggested fix:** Main fix, server side, in src/deferred-runs.ts:102: treat null the same as absent, matching src/server.ts:925 and the other call sites. Use `if (loopRaw.verification !== undefined && loopRaw.verification !== null) loop.verification = validateVerificationProfile(loopRaw.verification);` (or `loopRaw.verification != null`). Apply the same null tolerance to remoteWorker (line 101) and agentContainer (line 104) so the deferred sanitizer accepts the same composer body as POST /api/runs.

Optional client-side hardening in ui/composer.tsx:230: send `verification: verificationProfile ?? undefined` so a null is never serialised. The server fix is still needed for older drafts and for API clients.

**Suggested regression test:** Unit test in test/deferred-runs.test.ts:
- Assert `sanitizeDeferredRequest({ ...request(), loop: { ...request().loop, verification: null } })` does not throw and returns `loop.verification === undefined`.
- Add the same check for `remoteWorker: null` and `agentContainer: null` if those guards change.
- Keep an assertion that a malformed non-null profile (e.g. `{}`) still throws.

Optional server-level test (or browser e2e for the composer schedule dialog):
- Build a request the way the composer  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4645d on 127.0.0.1:4645, with a new home and no runs.

1. Fresh browser, no profile (script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4645d/r1.mjs). I opened #/project/p-ef01794b/new (MQTT-MCP) and typed a task. The Verification gates select was at its default "" ("Single configured check"). I then chose Run actions > Schedule… > Run once later, expanded "Queue this run configuration" and "Review saved run request". The review JSON already showed loop.verification = null and loop.check = "". Clicking "Save deferred run" sent POST /api/deferred-runs, which returned 400 {"error":"A verification profile is required"}. The dialog showed that alert, no job was created (GET /api/deferred-runs returned 0 jobs), and the only console error was the 400. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4645d/003-after-save-default.png.

2. API isolation (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4645d/r2.mjs). I sent the same composer-shaped body with a notBefore one week ahead. With loop.verification: null it returned 400 "A verification profile is required". With the key left out it returned 201 (waiting-time). With null and loop.check "true" it still returned 400, so setting a check command does not help.

3. Direct unit probe (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4645d/unit.mts, run with tsx against the source). sanitizeDeferredRequest with no verification key returned ok. With verification: null it threw "A verification profile is required".

4. Workaround through the UI (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4645d/r3.mjs). I set Edit run options > Advanced > Verification gates = Lightweight, chose a future start time, and saved. It returned 201 and created a job carrying the "lightweight" profile.

Not by design: docs/deferred-runs.md does not say a verification profile is required. The one-off run path at src/server.ts:925 accepts null, and every other caller of validateVerificationProfile also skips falsy values (code-hosts-api.ts:50, coordinated-api.ts:73, project-team-model.ts:100, engine.ts:5128). Not cau …

</details>

### t16-18 · major · Run once later from the composer fails with 'A verification profile is required' under default settings (also reported by t15 SCH-25)

**Fix outcome: duplicate.** Duplicate of t15-1, which carries the fix (null verification from the composer's default 'Single configured check').

Fixer's check: Covered by the t15-1 re-run: the same Run once later save under default settings now returns 201. The provider/effort choice does not matter because the value comes from the composer's verification state.

Tests: `test/qa-deferred-runs.test.ts`, `test/e2e/qa-deferred-runs.e2e.ts`

Source: tester unit scheduling-inbox-notifications-2; observed with real-agents; features SCH-26, SCH-44.

**Repro**

> 1. On a fresh real-mode QA server, open a project's New run, type a task and pick Codex with low effort. Leave 'Verification gates' at the default 'Single configured check'.
> 2. Open Run actions → Schedule… → Run once later → Queue this run configuration → Save deferred run.

**Expected:** The deferred run is saved.

**Actual:** The request carries loop.verification:null and returns 400 'A verification profile is required'. It worked only after picking 'Lightweight profile' under Run options → Advanced.

**Root cause (verifier):** The composer sends null for "no profile", and the deferred-run sanitizer treats any non-undefined value as a profile to validate.

1. **ui/composer.tsx:127.** `verificationProfile` is `useState<VerificationProfile | null>(… ?? null)`. `selectVerification("")` at lines 141-145 sets it to null for the default "Single configured check" option.
2. **ui/composer.tsx:230.** `runBody()` always includes `loop.verification: verificationProfile`. `JSON.stringify` drops undefined but keeps null, so the request carries `"verification": null`. The other optional loop fields (remoteWorker, agentContainer) are undefined, so they are dropped and do not fail.
3. **ui/composer.tsx:414 and ui/deferred-runs.tsx:43-47.** ScheduleRunDialog passes that body unchanged to DeferredRunsPanel, which POSTs it as `run` to /api/deferred-runs.
4. **src/server.ts:991.** The route keeps `loop` as-is through `automationRun()` and calls `sanitizeDeferredRequest`.
5. **src/deferred-runs.ts:102.** `if (loopRaw.verification !== undefined) loop.verification = validateVerificationProfile(loopRaw.verification);` lets null through.
6. **src/verification.ts:56.** `if (!value || typeof value !== "object") throw new Error("A v …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/deferred-runs.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/deferred-runs.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/deferred-runs.e2e.ts`

**Suggested fix:** Main fix, on the server: in `sanitizeDeferredRequest` (src/deferred-runs.ts:102), treat null as absent:

```ts
if (loopRaw.verification !== undefined && loopRaw.verification !== null) loop.verification = validateVerificationProfile(loopRaw.verification);
```

Or use `loopRaw.verification != null`. This matches the null-tolerant handling in /api/runs (src/server.ts:925) and `validateContextBudget`. It also protects other `sanitizeDeferredRequest` callers (src/repo-coordination.ts:63, src/coordinated-api.ts) and any older clients.

Do not make `validateVerificationProfile` itself accept null: coordinated-api relies on it rejecting a missing profile.

Optional hardening in the UI: at ui/composer.tsx:230 send `verification: verificationProfile ?? undefined`, so the composer never sends null.

With that fix, the job saved with "Single configured check" still runs the project's configured or detected check at launch, the same as Send.

**Suggested regression test:** Two tests, one at the unit level and one in the browser.

**test/deferred-runs.test.ts**, in the "saved requests preserve full bounded configuration…" test or a new one:
- Assert `sanitizeDeferredRequest({ ...request(), loop: { ...request().loop, verification: null } })` does not throw.
- Assert the result has `loop.verification === undefined`.
- Keep the existing check that a malformed non-null profile such as `{}` or `"x"` still throws.

**test/e2e/deferred-runs.e2e.ts:**
- Add `verification:  …

<details><summary>Verifier's independent reproduction</summary>

Started a fresh fake-mode QA server: `qa-server.sh start v4629 4629 fake`. Fake mode is enough because the failure happens in request validation, before any agent runs. Drove it with a fresh headless browser (no saved profile) using /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4629/r1.mjs, logging to r1.log in the same folder.

Steps:
1. Opened http://127.0.0.1:4629/#/project/p-ef01794b/new (MQTT-MCP) and typed a task.
2. Picked Provider → Codex and Effort → low. The `#verification-profile` select stayed at its default value "" (Single configured check).
3. Opened Run actions → Schedule… → Run once later → Queue this run configuration. Set the start condition to "At or after a chosen time" so nothing could launch.
4. Clicked Save deferred run.

Result:
- POST /api/deferred-runs returned 400 `{"error":"A verification profile is required"}`.
- The request body had `run.loop.verification = null`, with the key present.
- The dialog showed a red "A verification profile is required" message (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4629/002-dialog-default-single-check.png).

Control: in Edit run options I set Verification gates to "Lightweight profile". For MQTT-MCP the help text then read "No runnable gates detected". The request now sent `{"name":"lightweight","checks":[]}` and the same save returned 201 (job status waiting-time). The only difference between the 400 and the 201 was null versus an object.

I then cancelled that job through the UI with "Cancel deferred run" (r2.mjs): it ended cancelled, with 0 attempts and 0 runs. I stopped the server.

Ruled out:
- Not caused by the tester's environment, selectors or browser profile: it reproduces on a fresh home, fresh browser and fake CLIs.
- Not provider-specific: the value comes from the composer's verification state, not from Codex.
- Not by design: docs/deferred-runs.md says to "Save a new deferred request from the composer after configuring its task" and requires no verification profile. Starting the same draft immediately (/api/runs) and the Repeat path accept null.

</details>

### S01-1 · major · Composer Schedule… → Run once later always fails with the default 'Single configured check' because runBody() sends loop.verification:null and sanitizeDeferredRequest validates anything !== undefined.

**Fix outcome: duplicate.** Duplicate of t15-1, which carries the fix. That fix includes the suggested null tolerance for remoteWorker, contextBudget and agentContainer.

Fixer's check: Covered by the t15-1 re-run and by the unit test, which sends verification/remoteWorker/agentContainer/contextBudget all as null.

Tests: `test/qa-deferred-runs.test.ts`

Source: code-level suspect at `src/deferred-runs.ts:102` (confirmed hands-on).

**Repro**

> Fake-mode server s01 on port 4505 with a scratch git repo in project 'S01 Demo'. In the UI: #/project/<id>/new, type a task, keep Verification gates = 'Single configured check', then Run actions (…) → Schedule… → Run once later → 'Queue this run configuration' → Save deferred run. Captured POST /api/deferred-runs body: loop = {check:'npm test', setup:'', maxMinutes:240, maxSteps:200, verification:null}. Response: 400 {"error":"A verification profile is required"}. The dialog shows that error and no job is created (GET /api/deferred-runs = []). Control test: choosing 'Lightweight profile' and saving the same request returned 201 and created a job; with 'As soon as conditions are ready' it launched a run. Unit-level check: test/qa-s01/deferred-null-verification.test.ts in the snapshot (sanitizeDeferredRequest with verification:null throws; with the field omitted it passes; 2/2 pass).

**Expected:** With the default verification setting, a deferred run saves (verification absent means use the single configured check), as it does for Start run and Repeat.

**Actual:** 400 'A verification profile is required'. The feature cannot be used unless the user happens to pick a verification profile, and the error message is misleading.

**Root cause (verifier):** ui/composer.tsx:230 always sets loop.verification = verificationProfile, which is null when 'Single configured check' is selected (the default). JSON keeps the null. server.ts /api/deferred-runs passes body.run through automationRun() unchanged, and src/deferred-runs.ts:102 runs `if (loopRaw.verification !== undefined) loop.verification = validateVerificationProfile(loopRaw.verification)`. validateVerificationProfile(null) throws 'A verification profile is required' (src/verification.ts:56). The run path uses a truthiness check instead (engine.ts:5128 `if (loop.verification)`), so starting a run and Repeat both accept null. Only deferred runs reject it.

**Suggested fix:** Server: in sanitizeDeferredRequest treat null like absent: `if (loopRaw.verification != null) loop.verification = validateVerificationProfile(loopRaw.verification)`. Do the same for other optional loop objects the composer may send as null (remoteWorker, contextBudget, agentContainer). Client: optionally omit null fields in runBody (`verification: verificationProfile ?? undefined`).

**Suggested regression test:** test/deferred-runs.test.ts: sanitizeDeferredRequest({...request(), loop: {...request().loop, verification: null}}) succeeds and leaves loop.verification undefined. test/e2e/deferred-runs.e2e.ts: drive the real composer (default verification) → Schedule… → Run once later → Save deferred run and assert a job appears with status 'waiting-time', not a synthetic API request.

### t16-1 · major · Corrupt or unsupported deferred-runs.json prevents the whole server from starting

**Fix outcome: fixed.** src/server.ts:238-239 adds a `deferredFault` flag. At :2762 the startup load records the read error (logError 'Deferred runs disabled: repair <file> and restart') instead of an unguarded top-level await. :271 startPolicyBackground only starts the queue when it loaded (DeferredRuns.start() would otherwise throw again). :2765 skips recoverDeferredRuns. :1989 makes every /api/deferred-runs request answer 503 with the exact read error and the file to repair. The file is never rewritten. docs/deferred-runs.md now says the rest of the app keeps running and Run once later shows the error until you repair the file and restart. Only the deferred line was touched; the coordinatedApi load is left for its own cluster.

Fixer's check: Wrote the tester's two payloads into homes/f02/deferred-runs.json and started f02 from the worktree. Truncated JSON '{"version":1,"jobs":[{"id":"oops"': the server came up, /api/projects returned 200, GET /api/deferred-runs returned 503 'Deferred runs are unavailable: Deferred queue cannot be read: Expected ',' or '}'… Repair …/deferred-runs.json and restart code-flow.', POST returned 503, server.out had 'Deferred runs disabled…' and no 'Uncaught', and the file was byte-identical afterwards. Version 2 gave the same with '…invalid document'. In the browser, Scheduling > Run once later and the composer's Start later dialog both showed that message once as role=alert. The only browser errors we …

Tests: `test/qa-deferred-runs-server.test.ts`

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-28.

**Repro**

> 1. Start a QA server and queue any deferred run, so CODEFLOW_HOME/deferred-runs.json exists.
> 2. Stop the server.
> 3. Write '{"version":1,"jobs":[{"id":"oops"' (truncated JSON) or '{"version":2,"jobs":[]}' (an unsupported version, as after a downgrade) into deferred-runs.json.
> 4. Start the server again.

**Expected:** Per the docs ('Corrupt or unsupported queue files fail closed and are preserved for repair'), only the deferred queue should be unavailable. The app should still start and the Run once later panel should show the error, the way corrupt notifications.json gives a 503 and corrupt triggers.json is moved aside.

**Actual:** server.out shows 'code-flow: Uncaught exception: Deferred queue cannot be read: Expected ',' or '}' after property value...' (or '...: invalid document'). The process exits, nothing listens on the port, and the whole app is unusable until the file is fixed by hand.

**Root cause (verifier):** src/server.ts:2752 runs `await deferredRuns.load();` as an unguarded top-level await in the ESM entry module.

The failure path:
- DeferredRuns.load() (src/deferred-runs.ts:186-192) calls this.change() (line 341), which calls readDocument().
- readDocument() (src/deferred-runs.ts:362-368) wraps JSON.parse and validateDeferredDocument errors as "Deferred queue cannot be read: ...". The version check that rejects version 2 with "invalid document" is at src/deferred-runs.ts:373.
- The rejected top-level await reaches the process 'uncaughtException' handler (src/server.ts:152-158), which logs "Uncaught exception".
- server.listen at src/server.ts:2808 has not run yet and nothing keeps the event loop alive, so the process exits.

A second crash point is hidden behind the first. startPolicyBackground() (src/server.ts:268-270) calls deferredRuns.start() unconditionally, and DeferredRuns.start() (src/deferred-runs.ts:253) throws "Load deferred runs before starting the queue" when load() did not complete. startPolicyBackground() is called at top level at src/server.ts:2775 and in a request handler's finally block at src/server.ts:1618. So wrapping line 2752 in .catch() alone would still cra …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/deferred-runs.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/deferred-runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`

**Suggested fix:** Follow the pattern used for the other stores in src/server.ts, with one readiness flag. I verified this in a private snapshot.

1. Declare `let deferredReady = false;` before startPolicyBackground.
2. At line 2752, use: `deferredReady = await deferredRuns.load().then(() => true, (error) => { logError("Deferred runs disabled: repair CODEFLOW_HOME/deferred-runs.json and restart", error); return false; });`
3. In startPolicyBackground, use `if (deferredReady) deferredRuns.start();`.
4. At line 2755, use `if (deferredReady) await recoverDeferredRuns(...)`. Otherwise it fails with the misleading "requires manual recovery" message.

The rest needs no change. list(), enqueue() and cancel() already re-read the file and fail closed, so the Run once later panel shows the exact parse or validation error, the queue never launches anything, and the file is never rewritten.

Optional follow-ups:
- Map the not-loaded or storage fault to 503, as notifications does, instead of 400.
- Or let DeferredRun …

**Suggested regression test:** In test/server-reliability.test.ts, which already has startServer(env) that spawns src/server.ts with a custom CODEFLOW_HOME:
1. Pre-create a temporary home containing deferred-runs.json set to '{"version":2,"jobs":[]}' and start the server with startServer({ CODEFLOW_HOME: home }).
2. Assert that /api/health returns 200.
3. Assert that GET /api/deferred-runs returns a 4xx or 503 whose error matches /Deferred queue cannot be read/.
4. Assert that POST /api/deferred-runs is refused and that readF …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server named v4691 on port 4691 from the read-only dogfood-qa source. Its home was /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4691; I moved the previous verifier's home aside to homes/v4691.prev-1792963117.

Steps:
1. Queued one deferred run with POST /api/deferred-runs. It was a solo pattern on MQTT-MCP with notBefore set to tomorrow, so it would not launch. Status was waiting-time and deferred-runs.json was written with 0600 permissions.
2. Stopped the server with qa-server.sh stop, then backed up the good file.
3. Wrote the truncated JSON '{"version":1,"jobs":[{"id":"oops"' into deferred-runs.json and started the server again. server.out showed: "code-flow: Uncaught exception: Deferred queue cannot be read: Expected ',' or '}' after property value in JSON at position 33 (line 1 column 34)". /api/health never answered, lsof showed nothing listening on 4691, and the server pid was gone. The file was left unchanged.
4. Repeated with '{"version":2,"jobs":[]}'. Same result, with the log line "code-flow: Uncaught exception: Deferred queue cannot be read: invalid document". The process exited, nothing listened, and the file was preserved.
5. To check the cause, I patched only my private snapshot copy (builds/v4691) to guard the load (described under fixApproach) and started it against the same corrupt home. /api/health returned 200. GET /api/deferred-runs returned 400 {"error":"Deferred queue cannot be read: ..."}. In headless Chrome, Scheduling → Run once later showed that message as a role=alert error, and the corrupt file stayed byte-for-byte unchanged.
6. Restored the good file and started the unpatched source again. It came up normally and listed the job, so the crash comes only from the file contents.

Cleanup: I cancelled the test job, created no runs or worktrees, and stopped the server; ports 4691 and 4692 are free. Leftovers:
- the QA home homes/v4691, which holds the cancelled job record;
- the old home moved to homes/v4691.prev-1792963117;
- the patched snapshot at builds/v4691;
- the backup at work/v4691-deferred-good.json;
- the screenshot at shots/v4691/001-t16-patched-run-once-later.png.

Why not by design: docs/deferred-runs.md says "Corrupt or unsupported queue files fail closed and are preserved for repair." The file is preserved, but the whole server is taken down. Everywhere else, the startup sequence in src/server.ts degrades on …

</details>

### t16-10 · minor · Deferred retention silently deletes failed jobs that still have retry attempts; finished records cannot be removed

**Fix outcome: fixed.** src/deferred-runs.ts:59-62 adds retryable() and finished(). trim() (:369-371) now evicts only started, cancelled and exhausted-failed records, oldest first. enqueue (:216) counts retryable failures toward the 100 open-job limit, so retention always finds a finished record to drop. New DeferredRuns.remove(targets) (:246-258) is all-or-nothing with revision checks and refuses pending, claimed, unknown and retryable jobs. src/server.ts:1990-1993 adds POST /api/deferred-runs/remove. ui/deferred-runs.tsx: 'Remove record' on finished cards, 'Clear finished (N)' for the listed scope behind a confirm dialog, 'Cancel deferred run' on retryable failures, and the header count includes retryable failures. docs/deferred-runs.md describes the eviction order and both removal actions.

Fixer's check: On f02 I made project QA-tiny with an explicit-project job, then removed the repo from the project. The job became failed 1/3 ('This repository is no longer an explicit member of the selected project'). I enqueued and cancelled 200 fillers through the API. The list stayed at 200 {cancelled:196, failed:1, waiting-time:3}, and the failed 1/3 job was still listed with 'Cancel deferred run' and 'Retry after reviewing the failure'. The header count was 4. 'Remove record' detached one filler card. 'Clear finished (196)' opened 'Remove 195 finished deferred records…? Started runs stay in your runs.' After confirming, only the failed job and 3 waiting jobs remained and the Clear button disappeared.  …

Tests: `test/qa-deferred-runs.test.ts`, `test/qa-deferred-runs-server.test.ts`, `test/e2e/qa-deferred-runs.e2e.ts`

Source: tester unit scheduling-inbox-notifications-2; observed with api; features SCH-26.

**Repro**

> 1. Get a deferred job to 'Start rejected' at 1/3 attempts (e.g. its repository was moved).
> 2. Enqueue and cancel about 200 other deferred jobs (or accumulate them over time).
> 3. List /api/deferred-runs.

**Expected:** Retryable failed jobs (attempts < max), which the user is asked to 'Retry after reviewing the failure', are kept ahead of plain cancelled records, or the user is warned. There is also a way to clear finished or cancelled records.

**Actual:** Once 200 records were retained, 'QA-tiny repo removed' (failed 1/3) disappeared without notice, along with started-run receipts. Meanwhile the panel lists up to 200 cancelled cards and offers no way to dismiss them.

**Root cause (verifier):** src/deferred-runs.ts:349 `trim()`: once document.jobs.length > DEFERRED_RUN_LIMITS.retained (200, line 58), every job whose status is in ["started","failed","cancelled"] is a candidate. Candidates are sorted only by updatedAt, and the oldest are removed. It never checks `job.status === "failed" && job.attempts < job.maxAttempts`. Those jobs are still actionable: retry() at lines 225-233 accepts them, and ui/deferred-runs.tsx:87-90 shows "Retry after reviewing the failure" for them. So one old retryable failure is evicted before hundreds of newer cancelled records. trim() also runs inside every change(), at line 335, so any later enqueue, cancel or tick can evict it without notice.
Is this by design? Partly. docs/deferred-runs.md says "200 retained jobs ... Old terminal job records are removed first", so evicting started receipts and cancelled records is intended. The same doc also says "A known rejection before launch side effects ... can be explicitly retried after correction", which means a retryable failed job is not really terminal. The code treats it as terminal anyway, and nothing tells the user.
Second half of the report: the API has only GET/POST enqueue plus cancel, retry  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/deferred-runs.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/deferred-runs.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/deferred-runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/deferred-runs.test.ts`

**Suggested fix:** 1. Change the eviction order in trim() (src/deferred-runs.ts:349). Remove cancelled records first, then started receipts, then failed jobs that have used up their attempts. Remove failed jobs with attempts < maxAttempts last, or never, so their count stays under the active limit. Within each tier, keep sorting by updatedAt. For example, rank each job with `job.status === "cancelled" ? 0 : job.status === "started" ? 1 : job.status === "failed" && job.attempts >= job.maxAttempts ? 2 : 3` and sort by (rank, updatedAt). If retryable failures are never evicted, also count them toward DEFERRED_RUN_LIMITS.active in enqueue() so the file stays bounded and the user sees "Deferred queue is full; cancel or resolve older jobs first".
2. Add an explicit removal: DeferredRuns.remove(id, expectedRevision), allowed only for cancelled jobs, started jobs, and failed jobs where attempts >= maxAttempts. Expose it as POST /api/deferred-runs/:id/remove in src/server.ts next to cancel, retry and attach. Add  …

**Suggested regression test:** Add a test to test/deferred-runs.test.ts using the existing fixture() and request() helpers. Use a launch callback that throws `new DeferredRunRejectedError("repo moved")` on the first call, then enqueue + tick so job A becomes failed with attempts 1/3. Next, enqueue and cancel DEFERRED_RUN_LIMITS.retained cancelled jobs, advancing the injected `now` so they are all newer than A. Assert that `(await queue.list()).some(j => j.id === A.id && j.status === "failed")` is still true, that list().lengt …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: qa-server.sh start v4613t1610 4613 fake, with a new home, no prior deferred-runs.json, and two tiny scratch git repos I created under qa/clones. I set it up through the API and checked the result in the UI (Scheduling -> Run once later, #/automations/once).
1. I made a project "QA-tiny" (p-f4ca7fff) containing the scratch repo v4613-gone. I enqueued the deferred job "QA-tiny repo removed" with project, projectSelection "explicit" (the field the composer sends), pattern solo, claude, and notBefore = now+15s. I then renamed the repo directory before the job launched. The job became status "failed" at 1/3 attempts with reason "git rev-parse --show-toplevel failed: spawn git ENOENT". The UI card showed "Start rejected", "launch attempts 1/3" and a "Retry after reviewing the failure" button (screenshot qa/shots/v4613t1610/001-before-trim.png).
   Side note: without projectSelection explicit, renaming the repo gives "unknown", not "failed", because the error happens after host.start. That is why the reporter's composer-created job ended as "Start rejected". I cancelled that earlier unknown job, which left one extra cancelled record.
2. Script qa/work/v4613/t1610-fill.mjs enqueued filler jobs on v4613-tiny, each with notBefore +1h, and cancelled each one right away. After the jobs were listed:
   - 198 fillers: total 200, {cancelled:199, failed:1}. The failed job was still present at 1/3.
   - Filler 199: total 200, still failed:1. The oldest cancelled record (the unknown-recovery one) was evicted.
   - Filler 200: total 200, {cancelled:200}. The failed 1/3 job was gone, and 199 newer cancelled filler records were kept.
3. The UI after trimming (shots/v4613t1610/001-after-trim.png) showed 200 "Cancelled" cards and a header count of 0. No card had any button. The only button in the section was "Refresh queue". The server log said nothing about the eviction. The failure never reached the Inbox, because there is no deferred-run integration in review-inbox or notifications. DELETE /api/deferred-runs/<id> returns 404 "Unknown deferred run operation", so no removal route exists.
Cleanup: the server is stopped, ports 4613 and 4614 are free, no runs or worktrees were created (/api/runs was []), and I deleted both scratch repos. Leftovers: the QA home homes/v4613t1610, which holds the QA-tiny project and deferred-runs.json.

</details>

### t16-11 · minor · Stale-revision error on a deferred card stays visible after the card refreshes

**Fix outcome: fixed.** src/deferred-runs.ts:225-227: cancel() returns an already-cancelled job before the revision check, so a repeat cancel from a second tab is a no-op instead of a 409. Retry and attach with a stale revision still conflict. ui/deferred-runs.tsx DeferredRunCard: the error is stored with the revision it was about and rendered only while job.revision matches. On a 409 the card refreshes the queue at once and toasts 'This deferred job changed elsewhere and is now: <status>.' load() now returns the jobs. docs/deferred-runs.md documents the behaviour.

Fixer's check: On f02 I opened #/automations/once in two tabs on one waiting job and clicked Cancel in tab A, then in tab B. Tab B's cancel returned 200 and showed Cancelled within 68 ms. Alerts on the card: 0 right after, 0 after the 5 s poll, 0 after Refresh queue. Only 'Remove record' remained. Server state: cancelled, rev 2, history [queued, 'Cancelled before launch']. Real-conflict variant: tab A cancelled a retryable failed job, then tab B clicked Retry. The retry returned 409, tab B refreshed to Cancelled in 79 ms, card alerts were 0 and the toast read 'This deferred job changed elsewhere and is now: Cancelled.' The only console error was the expected 409. The e2e two-tab test fails on base and pass …

Tests: `test/qa-deferred-runs.test.ts`, `test/qa-deferred-runs-server.test.ts`, `test/e2e/qa-deferred-runs.e2e.ts`

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-26.

**Repro**

> 1. Open Scheduling → Run once later in two tabs with the same waiting job.
> 2. Click 'Cancel deferred run' in tab A, then in tab B.
> 3. Wait for the 5s poll in tab B.

**Expected:** After the refresh tab B shows Cancelled and the conflict message clears, or says the job was already cancelled.

**Actual:** Tab B first shows 'This deferred job changed. Refresh before acting on it.' After the poll the badge becomes 'Cancelled', but the red error stays under the card.

**Root cause (verifier):** ui/deferred-runs.tsx:73 keeps `error` as local state of DeferredRunCard. Line 77 is the only place it is reset: `setError("")` at the start of the next `command()`. Line 79 sets the 409 message from the server but does not call `refresh()`; only the success path on line 78 does. That is why the card still shows the old status and an enabled Cancel button until the 5s poll (lines 27-38, pollVisible 5000).
When the poll or the 'Refresh queue' button (line 65, which only bumps the panel's `refresh` effect) delivers the new job, the card keeps the same `key={job.id}` (line 67). So it re-renders with the new `job` prop while the old `error` stays. Nothing ties the error to `job.revision`, and line 99 keeps rendering it.
Once the job is cancelled, line 87 hides every action button, so the user has no command left that would reset the error.
Server side, src/deferred-runs.ts:348 `current()` throws DeferredRunConflictError on any revision mismatch. It does this before `cancel()`'s idempotent `if (job.status === "cancelled") return clone(job)` at line 221 runs, so a second cancel of an already-cancelled job is always a 409 and never a no-op. src/server.ts:583 maps that error to 409.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/deferred-runs.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/deferred-runs.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/deferred-runs.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/deferred-runs.test.ts`

**Suggested fix:** UI (ui/deferred-runs.tsx, DeferredRunCard):
(a) Tie the error to the revision it was produced against. Store `{ message, revision: job.revision }`, or add `useEffect(() => setError(""), [job.revision])`, and render it only while `error.revision === job.revision`. A poll or 'Refresh queue' that brings a newer revision then clears it automatically.
(b) In the catch block, when `problem instanceof ApiError && problem.status === 409`, call `await refresh()` right away so the card shows the current status without waiting up to 5s.
(c) After that refresh, show an outcome-specific message instead of the generic one. For example, for a cancel when the refreshed job is cancelled: 'Already cancelled (possibly in another tab)', shown as a toast or a neutral non-alert note. Otherwise: 'This job changed; review its new status before acting.'
Optional server hardening (src/deferred-runs.ts:217-222): in `cancel()`, check for an already-cancelled job before calling `current()`'s revision check. `find` …

**Suggested regression test:** test/e2e/deferred-runs.e2e.ts: add a test that queues a future job (notBefore = now+60s) through the API and opens /deferred-fixture in two pages of the same context. Click 'Cancel deferred run' on page A and wait for 'Cancelled'. Click 'Cancel deferred run' on page B, then click page B's 'Refresh queue' (or wait for the poll). Assert that page B's card shows the 'Cancelled' badge, that `card.getByRole("alert")` has count 0, or no longer contains 'This deferred job changed', and that the server  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4615 on 127.0.0.1:4615 (source f14f404). Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4615/t16-11.mjs (log t16-11.log next to it).
1. Precondition through the API: POST /api/deferred-runs with a solo MQTT-MCP request and notBefore = now+2h. Result: 201, status waiting-time, revision 1.
2. Opened two tabs in the same browser context at #/automations/once. Both cards showed 'Waiting for start time'.
3. Tab A: clicked 'Cancel deferred run'. The badge became 'Cancelled' and no alert appeared.
4. Tab B: clicked 'Cancel deferred run'. The server returned 409. The card showed the red role=alert 'This deferred job changed. Refresh before acting on it.' The badge still read 'Waiting for start time' and the Cancel button was still enabled, because a failed command does not refresh.
5. After 4977 ms the 5s visible poll turned tab B's badge into 'Cancelled' and the action buttons disappeared, but the alert stayed. After another 6s it was still there (alert count 1).
6. Clicked 'Refresh queue', the action the message itself asks for. The alert still stayed (alert count 1). It only goes away when the card unmounts (reload or navigation).
Server state at the end: job cancelled, revision 2, history [queued, 'Cancelled before launch']. The only console error was the expected 409.
Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4615/t16-11-tabB-immediate.png, /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4615/t16-11-tabB-after-poll.png, /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4615/t16-11-tabB-after-refresh-button.png (the last shows a 'Cancelled' badge with the red conflict banner underneath).
Attempts to refute it:
- Not by design: docs/deferred-runs.md and the code comments say nothing about keeping conflict errors after a refresh.
- Not an environment or script artifact: it happens on a fresh server with plain two-tab use, and the selectors are the app's own role/label names.
- Reproduced on the first attempt (the reporter saw it 2 times).
Severity stays minor. There is no data or launch risk and the server state is correct. But the card shows a stale, misleading red alert on a job that is already Cancelled with n …

</details>

### S10-1 · minor · The default 'Earliest start · local time' (now + 1 h) is computed once at mount. If the dialog stays open, the value goes stale and saving fails with 'Choose a future local start time.'

**Fix outcome: fixed.** ui/deferred-runs.tsx:15,26-28,52-57,88: the suggestion is suggestedStart() (now + 1 h), recomputed when you choose 'At or after a chosen time'. A chosenStart ref marks a time you typed, which is kept exactly. On save, an untouched suggestion that has passed moves forward and asks you to review it before saving again. The picker gets min = now. Save errors now have their own alert (saveError), so the 5 s poll's setError("") no longer clears them; it is de-duplicated against the panel error. docs/deferred-runs.md describes it.

Fixer's check: Tester's method on f02 with page.clock.install(): composer > Run once later > Queue > 'At or after a chosen time'. The field showed 03:11 with min 02:11. After fastForward 01:01:00, Save showed 'The suggested start time passed while this was open. It now suggests an hour from now; review it, then save again.' The field moved to 04:12 and nothing was saved. A second Save created a waiting-time job with notBefore in the future. Re-choosing 'at' 30 min later suggested now + 1 h (04:42). A typed past time (2020-01-01T09:00) was kept and refused with 'Choose a future local start time.' The browser errors array was empty. The e2e test fails on base and passes on the branch.

Tests: `test/e2e/qa-deferred-runs.e2e.ts`

Source: code-level suspect at `ui/deferred-runs.tsx:18` (confirmed hands-on).

**Repro**

> Fake server s10 (port 4541), Playwright with page.clock.install(). In New run, I typed a task, then chose Run actions > Schedule… > Run once later > Queue this run configuration > Start condition 'At or after a chosen time'. The field showed 2026-10-25T19:56 (opened at 18:56). I called page.clock.fastForward('01:01:00'); the field still showed 19:56. Clicking 'Save deferred run' gave the alert 'Choose a future local start time.' and GET /api/deferred-runs stayed []. Script: work/s10/10-deferred-stale.mjs. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s10/002-deferred-stale-error.png

**Expected:** The suggested earliest start stays a sensible future time when the user picks 'At or after a chosen time' (or a default that has passed is refreshed or accepted as 'start now').

**Actual:** The default is fixed at dialog mount. After more than an hour, an untouched default is in the past and the save is refused. The user must notice and edit the time. The error is accurate and visible, so impact is low.

**Root cause (verifier):** useState(localTime(Date.now() + 60*60_000)) runs only once when DeferredRunsPanel mounts (the ScheduleRunDialog opens). The enqueue() check at line 42 then rejects at <= Date.now(). Nothing refreshes the untouched default when timing switches to 'at' or before saving. The server would accept a past notBefore (it would be 'queued').

**Suggested fix:** Track whether the user edited notBefore. When timing changes to 'at', or in enqueue(), replace an untouched default that has passed with now+1h, or ask the user to confirm. Also set the input's min attribute to the current local time so the picker cannot pick a past time.

**Suggested regression test:** Playwright with page.clock: open Start later, fastForward 61 minutes, choose 'At or after a chosen time', and assert that the field holds a future time or that Save creates a job with notBefore > now.

### t15-2 · minor · AI team (taskTeam) setting is silently dropped when saving an automation or a deferred run; the automation runs as a single agent

**Fix outcome: fixed.** I kept the refusal rather than keeping taskTeam as the planner suggested. engine.ts:5094-5095 throws 'Team switching requires a local Agent conversation' for any input.taskTeam on a triggered run, and automations and deferred launches always set a trigger, so keeping taskTeam would make every fire fail. Changes: src/server.ts:983-987 automationRun() returns 400 for taskTeam.enabled === true with a message naming the alternatives (turn AI team off, or choose Team — dynamic plan). It covers POST /api/automations, automation updates and POST /api/deferred-runs; a switched-off team is still dropped as before. ui/deferred-runs.tsx exports SCHEDULED_TEAM_NOTICE and usesTaskTeam. ui/automations.tsx SaveAutomationDialog and DeferredRunsPanel show the notice (role=status) and disable Save. The Repeat help says 'this agent' for a solo pattern instead of promising 'this team'. docs/automations.md a …

Fixer's check: On f02 I turned the composer's AI team switch on (aria-checked=true). Schedule… > Repeat showed the notice, 'Runs this task with this agent and these settings', and a disabled Save automation. Run once later > Queue showed the same notice with Save deferred run disabled. POST /api/automations and POST /api/deferred-runs with taskTeam.enabled returned 400 with the AI-team message, and nothing was saved. With taskTeam.enabled:false the automation saved (201, taskTeam not stored). With the switch off again, Repeat had no notice and Save was enabled. No browser errors. The server and e2e tests fail on base and pass on the branch.

Tests: `test/qa-deferred-runs-server.test.ts`, `test/e2e/qa-deferred-runs.e2e.ts`

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-05, SCH-25.

**Repro**

> 1. Fake server. Composer for a project, type a task. 2. Toggle 'AI team' to On. 3. ⋯ > Schedule… > Repeat. The dialog says 'Runs this task with this team and these settings'. 4. Choose 'Only from a webhook' and save. 5. GET /api/automations: run has no taskTeam (the POST body had taskTeam enabled:true). 6. Run now: the run is pattern 'solo' with no team. The same happens for POST /api/deferred-runs (also drops intent and antigravityExecution).

**Expected:** The team configuration is kept, or the dialog says the team will not be used.

**Actual:** taskTeam is silently stripped. The automation runs as one agent, while the dialog promises 'with this team'.

**Root cause (verifier):** These are the places involved:
- `src/server.ts:982-983`: `automationRun()` keeps only templateRef, permissionRequirements, repo, project, projectSelection, pattern, task, roles, options, baseRef, loop, trust, agentSettings, roleSettings and source. taskTeam, intent, journeyId, antigravityExecution and checkpointOnFinish are discarded without any error or notice.
- `automationRun()` is used by:
  - POST /api/automations (`src/server.ts:2213`)
  - automation update (`src/server.ts:2245`)
  - POST /api/deferred-runs (`src/server.ts:1991`)
- `src/deferred-runs.ts:81`: `sanitizeDeferredRequest()` has its own allow-list without taskTeam, and `keys()` throws on unknown fields. So the fix cannot just add taskTeam to the keep-list.
- The drop is consistent with the engine's design. `src/engine.ts:5095` throws "Team switching requires a local Agent conversation" when `input.trigger` is set. Automations and deferred launches always set trigger (`src/deferred-launch.ts:64`, automations.fire). If taskTeam were kept, every fire would fail.

The real defect is that this limitation is never surfaced:
- `ui/composer.tsx:202` puts taskTeam into `runBody()`.
- `ui/composer.tsx:334` keeps Schedule… e …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/deferred-runs.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/deferred-runs.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/automations.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/deferred-runs.md`

**Suggested fix:** Don't just add taskTeam to the keep-list. The engine (engine.ts:5095) rejects taskTeam on triggered runs, so that change would make every scheduled fire fail.

Pick one of these:

(a) Recommended: make the limitation explicit.
- In `automationRun()` and the deferred POST handler, return 400 when `body.taskTeam?.enabled` is true. Suggested message: "AI team works only in a live Agent conversation. To schedule a team, choose Auto team (or a team template) in Advanced." If enabled is false, keep dropping it silently.
- In the UI, when `runBody().taskTeam?.enabled`:
  - SaveAutomationDialog and ScheduleRunDialog show a notice that AI team won't be used, with a one-click "Use Auto team instead" that switches the pattern to auto-team using the taskTeam coordinator and providers.
  - Or disable Schedule… with that reason.
- Change the copy at `ui/automations.tsx:469` to say "with these agents and settings" when the pattern is solo.
- Add AI team to the list of things deferred runs drop at `ui …

**Suggested regression test:** 1. Add to `test/automation.test.ts` (or a server API test that uses the fake-agent harness):
   - POST /api/automations with run `{pattern: "solo", roles: {agent: ["claude"]}, taskTeam: {enabled: true, preset: "adaptive", coordinator: "claude", providers: ["claude", "codex"], settings: {}, maxMembers: 4, maxCalls: 20, maxMinutes: 30, approvePlan: false}}`. Under fix (a), assert status 400 and a message matching /AI team/. Under fix (b), assert the saved `run.pattern === "auto-team"` and that fir …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4647 on 127.0.0.1:4647 with a fresh browser profile. The fixture project p-a15c22dc pointed at a scratch clone of MQTT-MCP (bare clone, then clone).

A) Automation (script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4647/t15-2-auto.mjs, log t15-2-auto.log in the same folder):
1. In the composer, typed a task and turned on the "AI team" switch (aria-checked=true).
2. Opened Run actions (the composer's own menu) > Schedule… > Repeat. The dialog text said "Runs this task with this team and these settings, unattended." It never mentions AI team.
3. Chose "Only from a webhook" and clicked Save automation.
4. The captured POST /api/automations body had run.taskTeam = {"enabled":true,"preset":"adaptive","coordinator":"claude","providers":["claude","codex"],...}.
5. GET /api/automations returned saved run keys: permissionRequirements, repo, project, projectSelection, pattern, task, roles, options, baseRef, loop, trust, agentSettings, roleSettings, context. There was no taskTeam.
6. POST /api/automations/:id/run returned 201. Run 2610252106-0258a3b1 had pattern solo, taskTeam null, trigger via manual, status done.
7. The Scheduling card showed "Agent in v4647-fx … · Claude Code", with no notice that the team was dropped.

B) Deferred run (script t15-2-deferred.mjs in the same folder):
1. Same composer state, then Schedule… > Run once later.
2. The panel help text mentions Safe mode and approval waits but not the team. Its "Review saved run request" box shows "taskTeam": {"enabled": true, ...}.
3. Save deferred run first failed with a separate bug: "A verification profile is required". The composer sends loop.verification: null, and sanitizeDeferredRequest validates anything that is not undefined. To isolate this issue, I removed only that null field in flight with page.route.
4. With that change the job saved and started. Its saved run had no taskTeam. Run 2610252110-7753039e had pattern solo, taskTeam null, trigger via deferred.

Both results match the report.

Attempt to refute: the drop is partly intentional. engine.ts:5095 rejects taskTeam for any run that has a trigger. ui/task-team.tsx:33 hides the AI-team control on triggered runs. The deferred sanitizer allow-list also leaves taskTeam out. So unattended runs are not meant to support the per-conversation AI team. Even so, nothing in the UI, docs or API response tells the user. The Repeat dialog promises  …

</details>
