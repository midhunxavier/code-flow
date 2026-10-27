# Cluster 03 · approvals-inbox

**Approvals inbox: Codex approvals auto-declined, card swapping, question cards, expiry**

Status: **merged · verified · repair round 1 merged into continuation · fresh re-verification passed** · 8 issues · branch `qa-fix/approvals-inbox` (+ `qa-fix/approvals-inbox-r1`)

Planner notes: t06-1/t07-8: approvalAction() at src/adapters/codex-app-server.ts:546 returns undefined whenever params.environmentId is set. Every real Codex approval is therefore auto-declined, and the agent is told the user rejected it. t06-2/S04-1: ui/approval-inbox.tsx renders only pending[0] of a newest-first list and replaces it on every snapshot, so the card swaps under the cursor. Keep the shown request stable (oldest first, or pinned by id) and make the click act on the id that was rendered. t06-7/S05-1: the question options are buttons inside a <label>; restructure with a fieldset and a selected state. t06-13: the adapter timer and the registry timer race, so expiries are recorded as 'cancelled'. Let the registry own expiry. Duplicate groups: [["t06-1","t07-8"],["t06-7","S05-1"],["t06-2","S04-1"]]

Likely files: `src/adapters/codex-app-server.ts`, `ui/approval-inbox.tsx`, `src/approvals.ts`, `src/adapters/types.ts`, `src/adapters/claude.ts`, `src/adapters/codex.ts`, `src/adapters/acp.ts`, `src/engine.ts`, `ui/styles.css`

## Fix result

Commits:
- `cee2026` Route Codex 0.164 command approvals to the inbox
- `ca92855` Record unanswered approvals and questions as expired
- `7c3a0aa` Carry question headers and option notes to the inbox
- `22556d3` Say what refused a Claude tool call instead of calling the run headless
- `ed562d3` Keep the approval card on the request being read
- `5a65830` Show a run waiting on an approval, and declines made unasked
- `adce3d6` Cover the approval inbox fixes with unit and browser tests

Fixer notes for the integrator: Possible conflicts with other clusters:
- test/fake-codex-app-server.mjs now speaks codex-cli 0.164 by default: thread results carry environments [{environmentId:"local", cwd}], and ASK-APPROVAL sends kind, environmentId "local", availableDecisions and proposedExecpolicyAmendment. It also has a new OUTSIDE-WORKTREE keyword (cwd = os.tmpdir()), ASK-QUESTION (item/tool/requestUserInput with header and descriptions), and new env vars FAKE_CODEX_THREAD_ENVIRONMENTS and FAKE_CODEX_QUESTION_PARAMS. Existing overrides still win.
- ui/approval-inbox.tsx is essentially rewritten.
- ui/run.tsx: TurnBody and the run-head pill changed.

Behaviour changes other tests may notice:
- An approval card that appears on its own (not by Previous/Next) ignores clicks for 900 ms (ARM_MS). Playwright's normal click waits for the button to be enabled; a forced or DOM-dispatched click would not.
- The inbox shows the soonest-expiring request (or the viewed run's) instead of the newest.
- Status texts changed:
  - 'Codex approval declined: the action is outside this turn's supported scope' becomes "code-flow declined Codex's request … without asking you: <reason>".
  - An expired request says '… request expired: nobody answered within …' instead of 'Codex command declined'.
  - Claude's 'Denied in headless mode' now appears only without an approval channel.
  - No existing test asserted these texts, so no existing test was edited.
- ui/run-experience.ts declinedUnasked() matches status lines by the pre …

## Independent verification

- **t06-1: verified** — Real run on QA server v03 (real mode, codex-cli 0.164.0, GPT-6-Luna, effort low, Ask for approval), started from the composer in headless Chrome. A transparent capture shim logged the app-server JSON-RPC to /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v-approvals-inbox/codex-rpc.log. Run 2610260238-28ef3f7d. thread/start returned environments [{environmentId:'local', cwd:<run worktree>}]. Codex sent item/commandExecution/requestApproval with {kind:'command', environmentId:'local', command:"/bin/zsh -lc 'rm -rf qa-tmp'", availableDecisions:['accept',{acceptWithExecpolicyAmendment…},'cancel']}, cwd = the worktree. Thi …
- **t07-8: verified** — (1) Real Codex, same run 2610260238-28ef3f7d: the reporter's outside-repo write `date > <scratch>/t07-real-proof.txt` (environmentId 'local', cwd = the worktree, reason 'May I run the exact date command…') now shows in the inbox. The card adds 'The agent may run an approved command outside its sandbox.' After Approve once the proof file was written (it contains a date). The header pill read 'Waiting for you' for both pending cards, where the bug showed 'Running'. (2) Fake escalation, the reporter's exact repro: server env FAKE_CODEX_APPROVAL_OVERRIDES='{"sandboxPermissions":"require_escalated"}' plus ASK-APPROVAL, run 2610260235-f4700813. No card and no records, as before. But with 'Show wor …
- **t06-2: verified** — Fake server, both runs started from the composer (Codex, Ask for approval, ASK-APPROVAL). Scenario 1 (reporter's two tabs): both tabs showed the soonest-expiring request (G2) with '1 of 2 pending'. Tab A clicked Decline, and tab B's card switched to G3 41 ms later. Tab B then clicked the old 'Approve once' position 396 ms after tab A's click. Tab B sent 0 POSTs; G2 was declined and G3 stayed pending. Tab B showed the role=status notice 'The request you were viewing is no longer waiting… This is a different request.', named the run ('From …G3 second chat…') and kept Approve disabled until 900 ms. Scenario 2 (one tab, reading C while D arrives via API): the card stayed on C, and '1 of 2 pendin …
- **t06-7: verified** — Reporter's path: the server ran with FAKE_CODEX_SERVER_REQUEST=item/tool/requestUserInput and two questions (color with header and option descriptions, name free text). Run started from the composer, run 'Q2 original repro'. Also checked with the fake's new ASK-QUESTION keyword. The card has 0 <label>s and 2 <fieldset>s. The ARIA tree shows group 'Badge color Which color should the badge use?', button 'Red', button 'Blue' (each named by its own label, with aria-describedby on its description), and textbox 'Which color should the badge use?'. I typed 'Teal, please', then clicked the centre of the question text (elementFromPoint returned SPAN). The textarea kept 'Teal, please' and focus did no …
- **t06-13: verified** — Reporter's repro in the UI: a fake server with FAKE_CODEX_SERVER_REQUEST=item/tool/requestUserInput, a Codex run with Ask for approval and 'ASK-APPROVAL E1 …' (run 2610260222-e86c70ec), both cards left untouched, /api/approvals polled every second. The command record went to 'expired' 1 ms after expiresAt (was 'cancelled'). The question record went to 'expired' at 02:34:22.481 against expiresAt .412. The transcript now says 'Codex command request expired: nobody answered within 2 minutes, so it was declined' and "Codex's question expired: nobody answered within 10 minutes, so Codex continues without an answer", where it used to say 'Codex command declined' with no line for the question. The  …
- **L-1: verified** — Real Claude Code 2.1.310 (Haiku, effort low, Ask for approval), started from the composer, run 2610260239-86197462. Task: one Bash call for `git diff --no-index README.md README.md`, then one for `touch qa-l1-proof.txt`. Claude refused the git call itself (the GIT_READ_DENY --disallowedTools rule) with no approval card. The status line is now "Blocked by this run's permission rules, without an approval prompt: Bash (git diff --no-index README.md README.md). Full access lifts its shell limits.", where it used to say 'Denied in headless mode: Bash'. It also stays visible under the finished answer with 'Show work' collapsed. The word 'headless' doesn't appear. `touch` ran without a prompt, so t …

Code-review findings:
- [minor] `ui/approval-inbox.tsx:140` The card is about 47 px taller now: the new 'From <task>' line (line 140) and the sandbox sentence at line 164. On the New run page at 1440x900, with a pending command whose folder wraps to 4 lines, the card's top is at y=445 and the composer's Send button is at y=461–495 (centre 478), so the card covers it and clicks land on the card. Removing those two lines in the DOM moves the top to y=492, below the button's centre. How much it overlaps depends on the length of the worktree path; ⌘↵ still sends.
- [minor] `ui/approval-inbox.tsx:13` After a swap, the only protection is a 900 ms disarm (ARM_MS) plus the notice. A click on the replacement card after 900 ms approves a request the user may not have read. The card names its run and shows the notice, but nothing requires an explicit look, which the issue's expected behaviour allowed for. The reporter's 334–386 ms repro is blocked.
- [nit] `ui/approval-inbox.tsx:118` decided.current is set before the POST. If the POST fails with 409 (another tab answered the same request at the same moment, or it just expired) and the server snapshot removes the request first, the keyed card unmounts and its setError is lost. The 'no longer waiting' notice is also suppressed because the id matches decided.current. The user sees the next request with no sign that their click didn't apply.
- [nit] `src/approvals.ts:167` The new checks reject the whole question request when header is over 240 chars or an option description is over 2000 chars (line 169), and the agent then gets no answer. Before, those fields were simply dropped. Truncating them would avoid a regression with providers that send longer headers.
- [nit] `src/adapters/claude.ts:153` Every can_use_tool request is added to `asked`, including ones code-flow refuses without showing the user: read mode at line 168, and input over 16 KB at line 170. Their denials read 'Not approved: …', which suggests the user decided, and declinedUnasked() doesn't keep them visible. Also, toolUseKey (line 348) uses tool_use_id when one side has it and name+input otherwise. If a control request lacks tool_use_id but its permission denial has one, a call the user declined would be labelled 'Blocked by this run's permission rules'. The real run didn't hit this branch.

Repair round 1: 3 commit(s), items review-1:fixed, review-2:fixed; merged: no

## Issues

### t06-1 · major · Real Codex 'Ask for approval': every command approval is auto-declined, approval inbox never appears

**Fix outcome: fixed.** src/adapters/codex-app-server.ts: runAppServerTurn now reads thread.environments from the thread/start, resume or fork result. It keeps the ids whose cwd is inside the turn's worktree (localEnvironments, around lines 165-171 and 505-510). approvalAction takes a localEnvironment predicate and declines only an environmentId that is not one of them. When the thread reports no environments, only "local" counts as local. It also declines when availableDecisions has no plain "accept", so a policy amendment is never offered. The header comment now mentions the 0.164 shape. test/fake-codex-app-server.mjs now behaves like 0.164 by default: the thread reports environments [{environmentId:"local", cwd}], and approvals carry kind, environmentId "local", proposedExecpolicyAmendment and availableDecisions. New: FAKE_CODEX_THREAD_ENVIRONMENTS, and the OUTSIDE-WORKTREE prompt keyword. docs/architecture. …

Fixer's check: Original repro with real codex-cli 0.164.0, one run (2610260111-f6bf954e) on a real-mode QA server (f03b, port 4355, run from my worktree), started from the composer: Codex, effort low, 'Ask for approval', scratch repo. Task: the tester's mkdir/rm -rf qa-tmp, then a date write outside the repo. Before the fix no card appeared. Now the card 'Permission required … /bin/zsh -lc 'rm -rf qa-tmp' … Folder <run worktree>' showed while the pill read 'Waiting for you'. Approve once ran it: the worktree has no qa-tmp, and the record is approved. The out-of-repo date request also reached the inbox, and I declined it; real-proof.txt was not created. Transcript: waiting → approved once → waiting → declin …

Tests: `test/qa-approvals-inbox.test.ts: codex-cli 0.164 command approvals in the thread's own environment reach the inbox and run once approved`, `test/qa-approvals-inbox.test.ts: a command bound for another environment, or one Codex can't approve once, is declined without a prompt`

Source: tester unit run-workspace-1; observed with real-agents; features RUN-19.

**Repro**

> 1. Start a real-mode QA server with codex-cli 0.164.0. 2. Composer → Agent, provider Codex (GPT-6-Luna, low), permissions 'Ask for approval', repo = scratch clone. 3. Task: 'In your current working directory run `mkdir -p qa-tmp/build && echo hi > qa-tmp/build/x.txt`, then `rm -rf qa-tmp` … do not request escalated permissions'. 4. Send and watch for the 'Permission required' card.

**Expected:** Codex's approval request for `rm -rf qa-tmp` (cwd = run worktree) shows in the approval inbox and runs once approved.

**Actual:** No card is ever shown. Transcript: 'shell /bin/zsh -lc 'rm -rf qa-tmp' (failed) — Codex approval declined: the action is outside this turn's supported scope'; agent replies the command was rejected; /api/approvals?run=<id> is empty. Same for an out-of-workspace touch. Captured raw request (QA proxy shim): {"method":"item/commandExecution/requestApproval","params":{"kind":"command","environmentId":"local","command":"/bin/zsh -lc 'rm -rf qa-tmp'","cwd":"<run worktree>","availableDecisions":["accept",{"acceptWithExecpolicyAmendment":…},"cancel"]}}.

**Root cause (verifier):** src/adapters/codex-app-server.ts:546. approvalAction() returns undefined whenever `params.environmentId !== undefined && params.environmentId !== null`. That guard was meant to keep out commands bound for a non-local or remote Codex environment.

codex-cli 0.164's v2 protocol makes environmentId a required field. For an ordinary local thread it is always "local", and thread/start reports that environment with cwd = the run worktree. So every command approval from real Codex is classified as out of scope.

answerApproval() (lines 347-357) then hits `!action`, emits "Codex approval declined: the action is outside this turn's supported scope" and replies {decision: "decline"} without ever calling turn.onApproval. The request never reaches the approval inbox.

The adapter never reads thread.environments from the thread/start, resume or fork response (line ~483), so it has no way to tell local from remote.

Tests missed it because test/fake-codex-app-server.mjs never sends environmentId (line 113) and never reports thread.environments (threadInfo, line 68). The header comment at codex-app-server.ts:15 still cites the codex-cli 0.162 protocol.

Impact: "Ask for approval" is the composer' …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/codex-app-server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/fake-codex-app-server.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/codex-app-server.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/architecture.md`

**Suggested fix:** Accept an environmentId only when it names the thread's own local workspace environment. Keep declining any other environment id.

Changes to the adapter, which I validated in my snapshot copy:
1. In runAppServerTurn, keep a `localEnvironments: Set<string>`.
2. After `threadId = thread?.thread?.id ?? turn.resumeThreadId` (around line 483), add each `thread.thread.environments[i].environmentId` whose `cwd` realpath equals `realpath(turn.cwd)`.
3. Pass that set into approvalAction.
4. Change line 546 to `... || (params.environmentId != null && !localEnvironments.has(params.environmentId))`.

Optionally, also accept the literal "local" if a resumed or forked thread response omits `environments`, but the membership check is stricter.

Other updates:
- Make the fake app-server mirror 0.164: thread results report `environments: [{environmentId: "local", cwd, runtimeWorkspaceRoots: [cwd]}]` and command approvals send `environmentId: "local"` by default. The existing FAKE_CODEX_APPROVAL_OVERRI …

**Suggested regression test:** In test/codex-app-server.test.ts, extend "interactive command approvals are opt-in, one-shot and keep the original sandbox" (or add a sibling test). The fake app-server should report thread.environments=[{environmentId:"local", cwd}] and send environmentId:"local" on item/commandExecution/requestApproval, as codex-cli 0.164 does.

Assertions:
- the onApproval callback receives exactly 1 request with kind "command" and command "rm -rf build"
- the tool_result for i3 is not an error
- a status eve …

<details><summary>Verifier's independent reproduction</summary>

Fresh real-mode QA server v4637e on port 4637 (new home, no runs). I put my own transparent capture shim for `codex` on PATH (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4637/capbin/codex-cap.mjs); it logs app-server approval requests and CodeFlow's replies. Through the UI, I added a scratch clone of MQTT-MCP as the project "v4637e MQTT" via "Open another repository". In the composer I chose Provider Codex, model GPT-6-Luna, effort low, Permissions "Ask for approval" (this is already the composer default). The task asked Codex to run `mkdir -p qa-tmp/build && echo hi > qa-tmp/build/x.txt`, then `rm -rf qa-tmp`, inside the sandbox.

Result of one real run, 2610251915-e5fa47af, about 8 s, with codex-cli 0.164.0:
- No approval card (aside.approval-inbox) ever appeared and /api/approvals?run=<id> returned [].
- The thread showed: "shell /bin/zsh -lc 'rm -rf qa-tmp' (failed) — Codex approval declined: the action is outside this turn's supported scope". The agent then replied "the sandbox rejected the rm -rf qa-tmp command".

What the capture showed:
- CodeFlow sent thread/start with {cwd: <run worktree>, sandbox: "workspace-write", approvalPolicy: "on-request"}.
- Codex answered with thread.environments = [{environmentId: "local", cwd: <run worktree>, runtimeWorkspaceRoots: [<run worktree>]}].
- Codex then sent item/commandExecution/requestApproval with {kind: "command", environmentId: "local", command: "/bin/zsh -lc 'rm -rf qa-tmp'", cwd: <run worktree>, no sandboxPermissions/grantRoot/networkApprovalContext/additionalPermissions}.
- CodeFlow replied {decision: "decline"} within 3 ms.

Isolation (fake app-server, in my snapshot builds/v4637e, probe file test/v4637-env-approval.test.ts):
- On unmodified source, an approval with no environmentId reached the inbox, and so did environmentId null.
- Overriding only environmentId to "local" put 0 requests in the inbox and produced "Codex approval declined: ... outside this turn's supported scope".

Protocol check: I generated the bindings myself with `codex app-server generate-ts`. v2/CommandExecutionRequestApprovalParams has `environmentId: string | null` as a required field. The commandExecution ThreadItem has no sandboxPermissions/additionalPermissions fields. FileChangeRequestApprovalParams has no environmentId, so only command approvals are hit.

Not by design: docs/security.md:104 says interactive Codex app-server runs route one-act …

</details>

### t07-8 · major · 'Ask for approval' with Codex: escalation requests are declined automatically, and the agent then tells the user their approval was 'rejected'

**Fix outcome: fixed.** Shares the auto-decline root cause with t06-1, fixed in cee2026: real 0.164 requests now reach the inbox. I also fixed this report's own parts. (1) A request code-flow declines on its own now has a reason: approvalAction returns why ('it would run outside this run's worktree', 'it asks for permissions beyond this run's sandbox', …). answerApproval writes 'code-flow declined Codex's request to run `<cmd>` without asking you: <reason>'. It also steers Codex that code-flow declined it, the user was not asked and did not reject it (codex-app-server.ts answerApproval, cee2026). (2) ui/run.tsx TurnBody keeps those lines visible under a finished turn's answer, outside 'Show work'. The match is declinedUnasked() in ui/run-experience.ts, and the style is .ev.declined in ui/styles.css. (3) The pill: approval-inbox.tsx exports a pendingApprovals signal. run.tsx passes approvalPending to executionLa …

Fixer's check: Tester's fake repro on f03b (fake, FAKE_CODEX_APPROVAL_OVERRIDES={"sandboxPermissions":"require_escalated"}), driven through the composer with Codex and 'Ask for approval', run 2610260107-5cbe6d63. No inbox and 0 records, as intended. With 'Show work' closed, the finished thread shows the note 'code-flow declined Codex's request to run `rm -rf build` without asking you: it asks for permissions beyond this run's sandbox' (screenshot shots/f03b/001-esc-final.png). In-scope fake requests on f03: the run page pill read 'Waiting for you' while the card waited and 'Finished' after declining. The real 0.164 run above showed 'Waiting for you' during both waits. Browser errors [] on all of these. Uni …

Tests: `test/qa-approvals-inbox.test.ts: a request code-flow declines on its own says so in the thread and tells Codex the user wasn't asked`, `test/qa-approvals-inbox.test.ts: the inbox offers the viewed run first, then the soonest deadline; options toggle; the run says it waits`, `test/e2e/qa-approvals-inbox.e2e.ts: a request code-flow declines on its own stays in view after the turn, outside Show work`, `test/e2e/qa-approvals-inbox.e2e.ts: a run's page offers its own request first, Next reaches the rest, and the run says it waits for you`

Source: tester unit run-workspace-2; observed with real-agents; features RUN-26.

**Repro**

> 1. qa-server.sh start t07b 4381 real (real codex-cli 0.164.0).
> 2. Composer: project t07 OPCUA (scratch clone), Agent - one agent, provider Codex, permissions 'Ask for approval', check and setup cleared.
> 3. Task: 'Run this exact shell command, which writes outside the repository so it needs my approval: date > <scratch>/t07-approval-proof.txt; then create docs/QA_T07_NOTE.md with one line'.
> 4. Watch the run page for an approval card.

**Expected:** Either the approval inbox shows the request so the user can decide, or the thread clearly says CodeFlow declined it because it is outside the worktree scope.

**Actual:** No approval inbox appeared. Codex's command request was auto-declined; the only trace is a status line inside 'Show work': 'Codex approval declined: the action is outside this turn's supported scope'. The agent's visible answer says 'The approval request was rejected, so the date command did not run', although the user never saw or rejected anything. The note file was created; the run finished in 18s. The fake codex with FAKE_CODEX_APPROVAL_OVERRIDES='{"sandboxPermissions":"require_escalated"}' and ASK-APPROVAL does the same. An in-scope request (AP2) correctly shows 'Permission required … Approve once', but the header pill stays 'Running' while it waits.

**Root cause (verifier):** The request is declined by approvalAction, the decline is hidden in "Show work", and Codex tells the model the user said no.

1. src/adapters/codex-app-server.ts:546 (approvalAction). The guard `(params.environmentId !== undefined && params.environmentId !== null)` returns undefined for any non-null environmentId. It was added in daf3108 and is tested with "remote-environment". Codex 0.164 sets `environmentId:"local"` on every command approval; this is the thread's own local environment, as the thread/start result shows. So the real request is declined here. It never reaches line 545's sandboxPermissions/escalation check, because that field no longer exists in the 0.164 protocol. Line 545 is only what fires in the fake-override repro. I infer that this declines every real Codex command approval, in or out of scope, so with the current CLI "Ask for approval" + Codex never shows a command in the inbox. The reporter's in-scope success (AP2) came from the fake agent only.

2. src/adapters/codex-app-server.ts:353-357 (answerApproval). When approvalAction returns undefined, the adapter only calls turn.onText(...). That becomes a `status` event (src/adapters/codex.ts:158) and is shown col …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/codex-app-server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/codex.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/types.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/approvals.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/fake-codex-app-server.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/codex-app-server.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/security.md`

**Suggested fix:** 1. Codex 0.164 compatibility (codex-app-server.ts):
- Capture the thread's local environment ids from the thread/start and thread/resume result (`thread.environments[].environmentId` whose cwd is turn.cwd).
- Pass them into approvalAction. Treat a matching environmentId (e.g. "local") as local; keep declining unknown or remote ids.
- Escalation is no longer signalled by sandboxPermissions in 0.164, so decide explicitly how to classify a command approval: either present it honestly in the inbox ("runs outside the Codex sandbox", with the reason and the requested command), or keep declining it. Never offer acceptWithExecpolicyAmendment.
- Update the docs/security.md wording to match.

2. Make policy declines visible and correctly attributed:
- When answerApproval or the headless branch declines without asking the user, emit a structured event (e.g. an `approval_declined` notice with command, cwd and reason), not just a status line.
- The engine should record it as an approval record with …

**Suggested regression test:** 1. test/codex-app-server.test.ts, after updating test/fake-codex-app-server.mjs to behave like codex 0.164 (thread/start returns `environments:[{environmentId:"local",cwd}]`, and requestApproval params include `environmentId:"local"`, `availableDecisions` and `proposedExecpolicyAmendment`):
- An in-worktree ASK-APPROVAL with interactiveApprovals:true calls onApproval exactly once (requests.length === 1).
- `{environmentId:"remote-environment"}` still declines with 0 callbacks.

2. Extend "intera …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this on a fresh QA home (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4601; the old one was moved aside). Port 4601. The project was a scratch clone of MQTT-MCP added through "Open another repository". Each run went through the composer UI: provider Codex, permissions "Ask for approval", check and setup cleared. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4601/t078/run.mjs. Logs are esc.log, inscope.log and real.log in the same folder.

(1) Fake, escalated request. FAKE_CODEX_APPROVAL_OVERRIDES='{"sandboxPermissions":"require_escalated"}', prompt with ASK-APPROVAL, run 2610252013-15997931. The approval inbox never appeared; /api/approvals had 0 pending the whole time. The run went to Finished in 4s. With "Show work" collapsed, the thread showed only "Implemented changes as codex." Expanding it showed "shell rm -rf build (failed)" and then "Codex approval declined: the action is outside this turn's supported scope". Screenshots: shots/v4601/003-esc-final.png and 004-esc-showwork.png.

(2) Fake, in-scope request (no override), run 2610252015-457a080d. The "Permission required … Run this command once rm -rf build … Approve once" card appeared, with 1 pending in /api/approvals. The header pill stayed "Running", next to "Codex · Working...", for the whole 2 minutes the card waited. The request then expired and was declined ("Codex command declined"). Screenshot: shots/v4601/003-inscope-running.png.

(3) One short real run: codex-cli 0.164.0, effort Low, a server in real mode, run 2610252018-2709eb82. I put a transparent logging wrapper for `codex` on the server's PATH (work/v4601/t078/wrapbin/codex) and logged the app-server JSON-RPC to work/v4601/t078/codex-rpc.log. The task was the reporter's: `date > <scratch>/real-approval-proof.txt`, then create docs/QA_V4601_NOTE.md. No inbox appeared and the proof file was not created. The run finished in 16s.
- Visible answer: "Created docs/QA_V4601_NOTE.md … The date command did not run because approval was rejected."
- Inside "Show work": "Codex approval declined: the action is outside this turn's supported scope".
- What Codex sent: `item/commandExecution/requestApproval` with params {kind:"command", environmentId:"local", cwd:<run worktree>, command:"/bin/zsh -lc 'date > …'", reason:"May I run this exact date command…", proposedExecpolicyAm …

</details>

### t06-2 · major · Approval card swaps to a different pending request under the cursor; a click approves an unseen command in another run

**Fix outcome: fixed.** ui/approval-inbox.tsx was rewritten (ed562d3). It keeps the shown request's id in a ref and renders that record while it is still pending, so a new arrival never replaces it. inboxOrder() puts the viewed run's requests first, then sorts by expiresAt. ApprovalCard is keyed by request id, and decide() posts the id of the request it rendered. A card that appears without your choice ignores clicks for ARM_MS (900 ms). When the shown request ended elsewhere, the new card shows the role=status notice 'The request you were viewing is no longer waiting: … This is a different request.' Your own decision is recorded before the POST, so the server's snapshot arriving first doesn't trigger that notice (e2e found this). The card names its run ('From <task title>'), and Previous/Next with '1 of N pending' reaches every request. ui/styles.css has the .ai-nav, .ai-run and .ai-notice styles.

Fixer's check: Tester's two scenarios on f03 (fake, from my worktree), work/approvals-inbox/swap.mjs, log swap3.log. One tab: while reading chat A's request, chat B's arrived. The card stayed on A, showing '1 of 2 pending'. A click at A's saved 'Approve once' coordinates approved A, and B stayed pending. The next card had 0 notices. Two tabs: tab 1 declined B. Tab 2's card changed to C 52 ms later with the 'no longer waiting' notice and Approve disabled. A click at the old coordinates sent 0 POSTs, so B was declined and C stayed pending. Approve became enabled after arming. Browser errors [] and server log clean. Before the fix, the same click approved the other run's request. E2e tests 1 and 2 assert this …

Tests: `test/e2e/qa-approvals-inbox.e2e.ts: a newer request never takes the card's place, and a click acts on the request that was on screen`, `test/e2e/qa-approvals-inbox.e2e.ts: a request answered in another window disarms the card that takes its place`, `test/qa-approvals-inbox.test.ts: the inbox offers the viewed run first, then the soonest deadline; options toggle; the run says it waits`

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-19.

**Repro**

> 1. Fake server; start two Agent runs with Codex + 'Ask for approval' and task containing ASK-APPROVAL (two pending 'rm -rf build' requests in different runs). 2. Open the app in two tabs (or phone + desktop); both show the newest request ('2 pending'). 3. In tab A click Decline. 4. In tab B click 'Approve once' on the card it was showing.

**Expected:** Tab B's click acts on the request it displayed (now resolved → 409 'no longer active'), or the swapped card requires a fresh look before acting.

**Actual:** Within ~250 ms tab B's card silently swaps to the other run's request (only the folder path differs; no run/task name shown) and the click approves it. Records: H4 2610251434-b3c3edb7 declined, H3 2610251434-c725f8ec approved (never looked at); earlier repro G2 2610251431-c3d0b60e declined / G3 2610251430-69192e48 approved 334 ms later. Same-tab double-click is safe (busy guard).

**Root cause (verifier):** ui/approval-inbox.tsx:20 replaces the whole `pending` list on every `approvals` stream snapshot. src/server.ts:1304-1314 publishes one on every registry change, i.e. any new, answered, expired or cancelled request in any run. ui/approval-inbox.tsx:31 always renders `pending[0]`, and the server sorts newest-first (src/approvals.ts:83, `b.createdAt - a.createdAt`). So whenever another run raises a request, or another tab or device answers the shown one, the card silently re-targets.

The decide closure (ui/approval-inbox.tsx:33-35) captures the `request` from the latest render and posts `/api/approvals/${request.id}`. A click therefore acts on whatever is current at click time, not on what the user read.

The card (lines 41-58) shows no run or task identity; the only "Open chat" link is the runId behind a button. Same-kind requests (same command, reason and layout) therefore differ only in a long worktree path. Button positions don't move, so a click already in flight lands on the new request.

There is no transition guard: the busy flag only covers the in-flight POST. There is also no displayed-id check. The server cannot catch this (src/server.ts:1866-1876) because the posted id is …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/approval-inbox.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/approvals.e2e.ts`

**Suggested fix:** In ui/approval-inbox.tsx:

1. Pin the displayed request. Keep a `shownId` state. Render the record with that id while it is still in `pending`, and only pick a new one when it disappears or the user moves on explicitly. Pick the soonest-expiring request (oldest createdAt / smallest expiresAt), not pending[0], so a new arrival never displaces the card being read.

2. Arm on transition. When the shown request changes for any reason other than the user's own decision (another device answered it, it expired or was cancelled), show a short notice such as "That request was answered elsewhere; this is a different run's request". Disable "Approve once" and "Decline" until a deliberate re-arm: about 1 second plus pointer movement, or a "Review next" click. Also key the actions block on request.id so a click already in flight cannot land on the new card.

3. Bind each decision to what was rendered. Have decide() take the id captured when the card rendered (e.g. `onClick={() => decide(shown.id, . …

**Suggested regression test:** Add to test/e2e/approvals.e2e.ts, test "a newer request does not re-target the card under the cursor":
- Start run A (ASK-APPROVAL, tools:true) and wait for the inbox. Record its folder text and the Approve once bounding box.
- Start run B and wait until /api/approvals has 2 pending.
- Assert the card still shows run A's folder (or task title) and that the count reads 2.
- Click at the saved coordinates and assert run A's record is "approved" and run B's is still "pending".

Second test, "an ans …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: "qa-server.sh start v4639 4639 fake". The previous v4639 home was moved aside to homes/v4639-prev-201515. The runs used a throwaway git repo at scratchpad/qa/work/v4639/t06-2/repo. Each run was started over the API as pattern solo, agent codex, approvals.tools=true, with the task "ASK-APPROVAL ...". The fake codex app-server then asks to approve "rm -rf build" in the run's worktree. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4639/t06-2/swap.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4639/t06-2/swap.log.

Scenario 1 (two tabs, the reporter's steps):
- Runs 2610251916-8a5e856f and 2610251916-f6a2092b each had one pending request. Both tabs showed the newer one (67625bfe, run f6a2092b) with "2 pending".
- Tab A clicked Decline. A MutationObserver in tab B saw its card change 77 ms later to request 9db809f8 of the other run. Only the folder path changed; "rm -rf build", the reason, the layout and the button positions stayed the same. No run name or task is shown.
- Tab B then clicked at the "Approve once" coordinates it had before the swap, i.e. the user's cursor was already there.
- Result: 67625bfe declined. 9db809f8, which tab B never displayed, approved 386 ms after tab A's click.

Scenario 2 (one tab, worse than reported):
- Run 2610251916-68eda77f's request was the only pending one, and the single tab showed it.
- Starting run 2610251916-555f4413 created a newer request. The card swapped to it 2 ms after its createdAt. Command and buttons were identical; only the folder changed and a "2 pending" pill appeared.
- Clicking the unchanged "Approve once" position approved run 555f4413's request. The request the user was reading (run 68eda77f) stayed pending.
- Screenshots 002-s2-reading-run3.png and 003-s2-after-arrival.png in scratchpad/qa/shots/v4639 show the cards before and after are nearly identical.

Not refuted:
- Not by design. The docs (api.md "Answer one still-active request once", security.md "one-action approval inbox ... scoped to the active run") and the component comment ("Permission requests are explicit, one-action decisions") all assume the user decides on what they saw. Nothing documents that the card can change target.
- Not environmental. The tester's selectors don't matter: the server faithfully applies the id the client posts, …

</details>

### S04-1 · major · The inbox shows only pending[0], and the registry lists newest first. With several pending requests, the oldest one (which expires first) stays hidden behind newer ones, with no way to move between them.

**Fix outcome: duplicate.** Duplicate of t06-2; ed562d3 carries the fix. inboxOrder() offers the viewed run's requests first, then the soonest deadline. Previous/Next with '1 of N pending' reaches every pending request, and the card names its run.

Fixer's check: On f03, on run D's page, D's request showed first ('1 of 2 pending') although C's expired sooner, and the pill read 'Waiting for you'. Next showed C ('2 of 2 pending') with Approve enabled at once. After declining, D's pill read 'Finished'. The unit test checks the order: older request first, the viewed run first. E2e test 3 covers the run page, Next/Previous and the pill.

Tests: `test/e2e/qa-approvals-inbox.e2e.ts: a run's page offers its own request first, Next reaches the rest, and the run says it waits for you`

Source: code-level suspect at `ui/approval-inbox.tsx:31` (confirmed hands-on).

**Repro**

> Fake server s04 (port 4517), scratch repo. Through the UI I started Codex Agent chat A with permission 'Ask for approval' and the task 'ASK-APPROVAL first chat: clean the build folder', then chat B with the same setup about 19 s later. GET /api/approvals returned the pending requests in the order [B created 17:34:55, A created 17:34:36]. On #/run/<A>, aside.approval-inbox contained only B's folder (checked with Playwright, screenshot shots/s04/002-inbox-two-on-runA.png). After waiting until A's expiresAt, /api/approvals showed A as cancelled and B still pending; no card for A was ever rendered. Script: work/s04/approvals.mjs, log: work/s04/approvals.log.

**Expected:** Every pending request can be reached before it expires. The request that expires first, or the one for the run being viewed, is shown first, and the card says which run each request belongs to.

**Actual:** On run A's page (step text 'Codex is waiting for approval of this command'), the card showed run B's request: folder .worktrees/2610251734-3714c66e/solo, '2 pending', and only Approve once / Decline / Open chat. Run A's request was never displayed and ended as status 'cancelled' at its expiresAt (17:36:36Z, resolvedAt +32 ms). Both requests were 'rm -rf build', so a user on run A's page who clicks 'Approve once' approves run B's command instead.

**Root cause (verifier):** ApprovalRegistry.list() sorts by createdAt descending (src/approvals.ts:83). The approvals topic snapshot (src/server.ts:1309) passes that order through. ApprovalInbox renders only `pending[0]` (ui/approval-inbox.tsx:31) plus an 'N pending' count. There is no previous/next control and no run name, and no other UI surface lists tool approvals. The card is global, so it ignores which run the user is looking at.

**Suggested fix:** In ApprovalInbox, sort pending records by expiresAt ascending. Prefer a record whose runId matches the current route (route.value.id) when the user is viewing a run. Add previous/next controls (or a compact list) over all pending records. Show the run title or project on the card so the user can tell which run a decision applies to. Optionally also return pending records from list() oldest first, or by expiresAt.

**Suggested regression test:** UI e2e with fake Codex: start two ASK-APPROVAL chats. Assert that the card shows the earliest-expiring request first, that a next control reveals the second request, and that on run A's page the card names run A and shows A's folder. Add a unit test of the inbox ordering helper with two records (newer createdAt and earlier expiresAt).

### t06-7 · minor · Question card: option buttons inside <label> — clicking the question text picks the first option; no selected state

**Fix outcome: fixed.** ui/approval-inbox.tsx: each question is a <fieldset class="ai-question"> whose <legend> holds the header and the question, not a <label>. Option buttons have their own names, key={option}, aria-pressed and aria-describedby for their descriptions. Multiple-choice questions toggle comma-separated picks (pickOption/optionPicked). The textarea keeps its aria-label and gets a placeholder (ed562d3, styles in ui/styles.css). Data: AgentQuestion gains header, optionDescriptions and multiSelect (src/adapters/types.ts). claudeQuestion() in src/adapters/claude.ts and codexQuestion() in src/adapters/codex-app-server.ts keep them. The src/approvals.ts validator bounds those fields, and questionFields() stores only what the inbox shows (7c3a0aa).

Fixer's check: On f03 (fake ASK-QUESTION, the same item/tool/requestUserInput path), run 2610260106-1a62831c. Red and Blue each have their own name, and the aria tree shows group 'Badge color Which color should the badge use?'. I typed 'Teal, please' and clicked the question text: the value stayed, and the click landed on a SPAN. Clicking blank space in the option row also left it. Clicking Blue set aria-pressed true on Blue and false on Red. The header and both descriptions show. Send answer recorded {"color":"Blue"}, and the agent got it. Browser errors []. E2e test 4 adds a scoped axe audit of the question card with 0 violations; the approval card is also audited, also 0.

Tests: `test/e2e/qa-approvals-inbox.e2e.ts: a question's text never picks an option, and each option has its own name and pressed state`, `test/qa-approvals-inbox.test.ts: the registry keeps only the question fields the inbox shows, and checks them`, `test/qa-approvals-inbox.test.ts: Claude questions keep their header, option notes and multiple choice; expiries are said, not silent`, `test/qa-approvals-inbox.test.ts: a Codex question nobody answers expires on the record and in the transcript`

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-20.

**Repro**

> 1. Agent run where the agent asks a question with options (fake: FAKE_CODEX_SERVER_REQUEST=item/tool/requestUserInput with options Red/Blue; real: Claude AskUserQuestion). 2. Click on the question sentence itself.

**Expected:** Clicking the question text does nothing (or focuses the free-text answer); the chosen option shows a pressed/selected state; screen readers announce each option by its own label.

**Actual:** Clicking the question text sets the answer to the first option ('Red'); the first button's accessible name is the whole label ('Which color should the badge use? RedBlue'); buttons have no aria-pressed/selected state; option descriptions and question header from Claude are dropped.

**Root cause (verifier):** 1. ui/approval-inbox.tsx:50 (the reporter said :52; it is line 50 in this checkout) renders each question as a single `<label>{q.question}<div class="row">{option <button>s}</div><textarea aria-label={q.question}/></label>`.

   In HTML, buttons are labelable elements. A label with no `for` attribute labels its first labelable descendant, which here is the first option button, not the textarea. So:
   - A click on the label's text or blank space runs the label's activation behaviour, which clicks that first button. Its onClick then calls setAnswers(...[q.id]: option[0]), overwriting anything typed.
   - The first button's accessible name comes from the label (HTML-AAM gives `<label>` priority over the button's own text). Chrome computes "Which color should the badge use? Blue".

   The textarea escapes only because it has its own aria-label. For a question with no options, the label's control is the textarea, which is why the second question behaves correctly.

2. The option buttons have no state at all: there is no aria-pressed or role=radio/aria-checked and no "on" class. The chosen option shows only as the text it copies into the textarea.

3. The header and option descriptions  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/approval-inbox.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/types.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/claude.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/codex-app-server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/approvals.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/fake-codex-app-server.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/approvals.e2e.ts`

**Suggested fix:** 1. Remove the wrapping `<label>` from the question block (ui/approval-inbox.tsx:50). Render each question as `<fieldset class="ai-question"><legend id={qid}>{q.header ? <b>{q.header}</b> : null} {q.question}</legend>...</fieldset>` or as a `<div role="group" aria-labelledby={qid}>`.
   - Put the options in a group that reuses the existing segmented pattern from ui/automations.tsx:482-490: `role="radiogroup" aria-labelledby={qid}` with buttons carrying `role="radio" aria-checked={answer === option} class={answer === option ? "on" : ""}`.
   - Alternatively, keep plain buttons and add `aria-pressed={answer === option}` with a visible pressed style.
   - Each button then gets its own name ("Red").
   - Give the textarea its own `<label for>` (e.g. "Or type your answer") or `aria-labelledby={qid}`. Clicking the question text then does nothing, or focuses the textarea; it never picks an option.
   - Add a pressed/checked style in ui/styles.css.

2. Optional, recommended so the real Claude c …

**Suggested regression test:** Extend test/e2e/approvals.e2e.ts with a native-question test. Add a prompt keyword to test/fake-codex-app-server.mjs, e.g. ASK-QUESTION, that sends item/tool/requestUserInput with a question whose options are Red and Blue, each with a description, plus a header. Using a keyword avoids setting server-wide env that would affect the other approval tests.

The test starts a solo Codex run with "ASK-QUESTION ...", waits for `getByRole('alert', {name: 'Agent question'})`, then asserts:
1. `card.getByR …

<details><summary>Verifier's independent reproduction</summary>

Reproduced on a fresh fake-mode server: v4649 on port 4649 with the dogfood-qa source. I exported FAKE_CODEX_SERVER_REQUEST=item/tool/requestUserInput and set FAKE_CODEX_SERVER_REQUEST_PARAMS to two Codex questions. The first was id "color", header "Badge color", "Which color should the badge use?", with options Red and Blue, each with a description. The second was id "name", header "File name", free text. The repository was a throwaway git repo in the scratchpad. I started a solo Codex run with POST /api/runs and drove the card in a fresh headless Chrome (no stored profile). Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4649/t067.mjs, log in t067.log next to it.

Observed (run 2610251918-3e7c0ad6):
- The DOM is `<label>Which color should the badge use?<div class="row"><button>Red</button><button>Blue</button></div><textarea aria-label=...></label>`, and `label.control` is the Red BUTTON.
- I clicked the centre of the question's own text node (elementFromPoint returned LABEL, not a button). The textarea went from "" to "Red" and focus moved to the Red button. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4649/002-t067-after-text-click.png
- Chrome's accessibility tree (ariaSnapshot) names the Red button "Which color should the badge use? Blue". A screen reader announces the Red button with the word Blue. `getByRole('button', {name: 'Red', exact: true})` finds 0 elements; Blue is named "Blue".
- After clicking Blue, neither button has aria-pressed, aria-selected or aria-checked. Their class, background, border and colour are identical, so the choice only shows as text in the textarea (screenshot 003-t067-after-blue.png).
- The headers ("Badge color", "File name") and the option descriptions appear nowhere. The stored ApprovalRecord already holds only `{id, question, options: ["Red","Blue"]}`, so the adapter drops them.

Second run (2610251919-e610460d, script t067b.mjs, log t067b.log): I typed "Teal, please" as the colour answer, clicked the question text, and the textarea silently became "Red". Clicking Send answer recorded `{"color":"Red","name":"badge.txt"}`. The user's typed answer was replaced and the agent got the first option.

The issue is not caused by the reporter's environment or selector. It reproduces with a fresh profile and a click placed exactly on the text node. Nothin …

</details>

### S05-1 · major · Question option buttons are rendered inside a <label> without keys or a selected state. Clicking an option only fills the textarea, and the label wrapper can redirect focus.

**Fix outcome: duplicate.** Duplicate of t06-7; ed562d3 carries the fix: a fieldset and legend instead of a label, keyed option buttons with aria-pressed.

Fixer's check: The tester's exact setup on f03b: fake with FAKE_CODEX_SERVER_REQUEST=item/tool/requestUserInput and the Postgres/SQLite question (work/approvals-inbox/s05.mjs, s05.log). (1) Clicking the question text left the answer '' with focus on BODY. (2) I typed 'Use DuckDB, it is already a dependency' and clicked the question text: unchanged. (3) Clicking blank space right of the options: unchanged. Clicking SQLite set aria-pressed false/true for Postgres/SQLite. Send recorded {"q1":"SQLite"}, and the run finished done. Browser errors [].

Tests: `test/e2e/qa-approvals-inbox.e2e.ts: a question's text never picks an option, and each option has its own name and pressed state`

Source: code-level suspect at `ui/approval-inbox.tsx:53` (confirmed hands-on).

**Repro**

> Fake-mode server s05 (port 4521), started with FAKE_CODEX_SERVER_REQUEST=item/tool/requestUserInput and FAKE_CODEX_SERVER_REQUEST_PARAMS={questions:[{id:q1,question:'Which database should I use?',options:[Postgres,SQLite]}]}. I started an Agent (solo) run with Codex and opened the run, where the 'Your agent has a question' card appears. (1) Clicked the question text: the textarea went from '' to 'Postgres', focus moved to the Postgres button, and 'Send answer' became enabled. (2) Typed 'Use DuckDB, it is already a dependency', then clicked the question text: the textarea became 'Postgres'. (3) Clicked the empty area right of the option row: the textarea became 'Postgres' again. No console errors. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s05/002-after-clicking-question-text.png

**Expected:** Clicking or selecting the question text does nothing, or focuses the answer textarea. A typed answer is never replaced unless the user clicks an option button. The chosen option is shown as selected.

**Actual:** Clicking the question text or the blank space inside the question block silently picks the first option and overwrites any typed answer. The agent then receives that option when the user presses Send answer.

**Root cause (verifier):** Each question is rendered as <label>{q.question}<div class=row><button>opt…</button></div><textarea/></label> with no `for`. A label's labeled control is its first labelable descendant, and buttons are labelable. So the control is the FIRST OPTION BUTTON, not the textarea (in the DOM, label.control is BUTTON:Postgres). Any click on the label's non-control area (the question text, the blank space beside the option row, padding) fires the label's activation behaviour, which clicks option 1. Its onClick then overwrites answers[request.id][q.id] with that option. The option buttons also have no key and no aria-pressed/selected state.

**Suggested fix:** Do not wrap the block in <label>. Render each question as <div role=group aria-labelledby={qid}> or <fieldset>, with the question in a <p id> or <legend>. Keep the textarea's aria-label, or use <label for>. Give the option buttons key={option} and aria-pressed={answers[request.id]?.[q.id] === option}. Optionally move focus to the textarea after an option is picked.

**Suggested regression test:** Add an e2e test next to the existing approval tests, using fake codex app-server with FAKE_CODEX_SERVER_REQUEST=item/tool/requestUserInput. Fill the textarea with custom text, click the question text and the blank row area, then assert the textarea still holds the custom text. Click 'SQLite' and assert aria-pressed=true on that button only. Also add a DOM unit assertion that no labelable element precedes the textarea inside a label.

### t06-13 · minor · Expired approvals/questions are recorded as 'cancelled' and the transcript just says 'declined'

**Fix outcome: fixed.** src/approvals.ts: approvalTimeout() and isApprovalTimeout() are exported. The registry's abort listener records 'expired' when the caller aborts with a TimeoutError reason or after expiresAt, and 'cancelled' otherwise. In the Codex (approval and question), Claude and ACP adapters, the adapter's own deadline aborts with approvalTimeout(). Codex now says 'Codex command request expired: nobody answered within 2 minutes, so it was declined' or 'Codex's question expired: nobody answered within 10 minutes, so Codex continues without an answer'. Claude says '<Claude's request to use X | Claude's question> expired: …' and tells Claude the user didn't answer in time. AppServerTurn gains questionTimeoutMs. ACP records 'expired' but has no status channel for a transcript line. Commit ca92855.

Fixer's check: Tester's repro on f03 (fake), work/approvals-inbox/expiry.mjs and expiry2.log, both requests left untouched. Approval run 2610260106-0ffd7bb6 recorded command:expired, resolvedAt 2 ms after expiresAt. Transcript: 'Codex is waiting for approval of this command', then 'Codex command request expired: nobody answered within 2 minutes, so it was declined'. Question run 2610260106-0849e0d3, after 10 minutes, recorded question:expired with the transcript line "Codex's question expired: nobody answered within 10 minutes, so Codex continues without an answer". Before the fix both were 'cancelled'. Browser errors []. Unit tests use a real ApprovalRegistry with 300-400 ms deadlines and check that a pla …

Tests: `test/qa-approvals-inbox.test.ts: an approval nobody answers is recorded as expired and the transcript says it expired; a cancel stays cancelled`, `test/qa-approvals-inbox.test.ts: a Codex question nobody answers expires on the record and in the transcript`, `test/qa-approvals-inbox.test.ts: Claude questions keep their header, option notes and multiple choice; expiries are said, not silent`

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-19, RUN-20.

**Repro**

> 1. Agent Codex run with ASK-APPROVAL (fake), leave the card untouched 2 minutes (or a question 10 minutes). 2. GET /api/approvals?run=<id>; open the transcript.

**Expected:** Status 'expired' and the turn says the request expired.

**Actual:** Record status 'cancelled'; transcript 'Codex command declined' at exactly the deadline; the user can't tell it timed out.

**Root cause (verifier):** Two timers with the same duration race, and the adapter's timer is always created first, so it always wins. The registry never gets to mark the record "expired".
- src/adapters/codex-app-server.ts:362-363 sets `setTimeout(() => approval.controller.abort(), timeout)` (2 min by default; approvalTimeoutMs is never set in production). Only after that does it call `turn.onApproval(action, approval.controller.signal)` in a microtask (:368).
- The engine's onApproval (src/engine.ts:2882-2886) calls approvals.request(), which arms its own expiry timer with the same 120 s (src/approvals.ts:70, defaultTimeoutMs 2*60_000).
- Node fires equal-duration timers in insertion order, so the adapter aborts first. The registry's abort listener (src/approvals.ts:69 `cancel = () => this.finish(id, "cancelled")`) runs synchronously, finish() clears the expiry timer, and the record is stored as "cancelled".
- The adapter's own abort branch resolves "decline", and :379-380 emits "Codex command declined". That is the same text a user's Decline produces, and no "expired" wording exists on any path.
- Questions follow the same pattern: answerQuestion's 600_000 timer (codex-app-server.ts:390) runs before appro …

**Files:** `src/approvals.ts`, `src/adapters/codex-app-server.ts`, `src/adapters/claude.ts`, `src/adapters/acp.ts`, `src/adapters/types.ts`, `test/approvals.test.ts`, `test/codex-app-server.test.ts`

**Suggested fix:** The registry should own the deadline, and adapters should be able to tell an expiry apart from a decline.
(1) Make the adapter timers a pure backstop. Arm them later than the registry's deadline (for example timeout + 5 s), or skip them when onApproval/onQuestion is backed by the registry. Alternatively, have the adapter abort with a reason (`controller.abort(new DOMException("expired", "TimeoutError"))`) and let ApprovalRegistry.request's abort listener map a TimeoutError reason, or `Date.now() >= record.expiresAt`, to finish(id, "expired") instead of "cancelled".
(2) Give ApprovalDecision (or the resolved value) an "expired" outcome, or let the adapter check the abort reason. Then codex-app-server.ts:380 can emit "Codex command request expired after 2 minutes; declined", and answerQuestion can emit "Question expired; Codex continues without an answer". Mirror this in claude.ts and acp.ts. Claude already sends "Request expired or was cancelled" to the agent, but nothing reaches the us …

**Suggested regression test:** Add a case to test/codex-app-server.test.ts (next to "approval expiry, turn cancellation, and server resolution invalidate late responses"). Wire `onApproval: (req, signal) => registry.request("run", "step", req, signal)` with `new ApprovalRegistry({ defaultTimeoutMs: 300 })` and `approvalTimeoutMs: 300` on ASK-APPROVAL. Assert `registry.list("run")[0].status === "expired"`, and assert that the onText output includes an "expired" message rather than only "Codex command declined". Check that an e …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4661 on port 4661. The old v4661 home was moved aside to homes/v4661.prev-202340. The server was started with FAKE_CODEX_SERVER_REQUEST=item/tool/requestUserInput and one question in FAKE_CODEX_SERVER_REQUEST_PARAMS, so the fake Codex also asks a question after the approval. In the UI I added a scratch clone of MQTT-MCP as project "v4661 MQTT", chose provider Codex and permissions "Ask for approval", and sent the task "ASK-APPROVAL v4661 verify expiry status of approval and question". This created run 2610251924-392fb0bf. I left both cards untouched and polled GET /api/approvals?run=<id> every second (work/v4661/a2-expiry.mjs, log work/v4661/a2.log).
- Approval card: created 19:24:38.873Z, and the card said "Expires at 8:26:38 PM". The record went to status "cancelled" with resolvedAt 19:26:38.874Z, 1 ms after expiresAt. runs/2610251924-392fb0bf.jsonl seq 10, ts 19:26:38.874Z: "Codex command declined". The thread shows "Codex is waiting for approval of this command" then "Codex command declined", which reads the same as a user clicking Decline (screenshot shots/v4661/004-command-after-cancelled.png).
- Question card: created 19:26:38.875Z, expiresAt 19:36:38.875Z. Status went to "cancelled" with resolvedAt 19:36:38.876Z (also +1 ms). CodeFlow wrote nothing to the transcript; the agent just got {"answers":{}}.
- Final records: [{question, cancelled}, {command, cancelled}]. The run finished "done" and there were no console or 5xx errors.
Deterministic unit check in my snapshot (builds/v4661/test/v4661-expiry.test.ts, run with npx tsx --test): runAppServerTurn on ASK-APPROVAL with approvalTimeoutMs=300, and onApproval wired to a real ApprovalRegistry({defaultTimeoutMs:300}). It failed with actual 'cancelled', expected 'expired', resolvedAt-expiresAt = 1 ms. Transcript texts were ["Codex is waiting for approval of this command","Codex command declined"].
Tried to refute it: the intent is that requests expire, not that they are cancelled. docs/security.md:104 says "Requests expire", ui/approval-inbox.tsx:9 says "an ignored request expires denied", and the card shows "Expires at …". ApprovalStatus also has an explicit "expired" value, and test/approvals.test.ts asserts it for the registry alone. So it is not by design, and the tester's environment is not the cause (fresh home, fresh browser profile, deterministic with the fake app-server).
Cleanup: the run was deleted through the API (0 runs left), the server was stopped, ports 4661/46 …

</details>

### L-1 · minor · With "Ask for approval", a Bash call blocked by a run deny rule shows status "Denied in headless mode: Bash"

**Fix outcome: fixed.** src/adapters/claude.ts: handleControl records every tool use Claude asked about, keyed by tool_use_id or by name and input. With interactive approvals, permission_denials are split. Denials nobody was asked about give 'Blocked by this run's permission rules, without an approval prompt: Bash (git diff --no-index …)', plus '. Full access lifts its shell limits.' when the shell is limited. Asked ones give 'Not approved: Bash (rm -rf build)'. 'Denied in headless mode: …' remains only without an approval channel, and now includes the command or file. ui/run-experience.ts declinedUnasked() also keeps the 'Blocked by this run's permission rules' line visible after the turn. Commit 22556d3.

Fixer's check: The original was seen only with a real Claude run that hit the GIT_READ_DENY rule. I verified with a stream-json fake Claude in the unit test, which emits a can_use_tool for one Bash call and then a result with both denials. In interactive mode, the rule-blocked call and the declined one each get their own line, and no line says 'headless'. In headless mode, both get 'Denied in headless mode: Bash (git diff --no-index a.txt b.txt), Bash (rm -rf build)'. I didn't spend a real Claude run, because the wording comes only from the adapter's result handling, which the fake drives exactly.

Tests: `test/qa-approvals-inbox.test.ts: Claude's permission denials say whether a rule blocked the call or the inbox declined it`

Source: lead tester; observed with real-agents.

**Repro**

> Real Claude Code solo run on MQTT-MCP started from the composer with permissions 'Ask for approval' (toolApprovals true). The agent ran a Bash compound containing `git diff --no-index ...`. claude.ts passes GIT_READ_DENY (["Bash(git *--out*)","Bash(git *--no-index*)"]) as --disallowedTools when the shell is limited, so Claude rejected the call itself and the result event listed it in permission_denials.

**Expected:** The status/log explains the call was blocked by the run's permission rules (e.g. "Blocked by this run's permission rules: Bash(git diff --no-index …)"), so the user knows no approval prompt was missed and how to allow it (Full access).

**Actual:** Run log status line: 'Denied in headless mode: Bash' (src/adapters/claude.ts:268-272 builds it from result.permission_denials). The run was interactive (approval prompts via --permission-prompt-tool stdio), so 'headless' is misleading, and only the tool name is shown, not the command or the rule.

**Root cause (verifier):** src/adapters/claude.ts:268-272 message text is fixed; permission_denials carry tool_name and tool_input (command), which are not shown.

**Files:** `src/adapters/claude.ts`

**Suggested fix:** Word the message by mode: when interactive approvals are on, say the call was blocked by the run's permission rules (deny list or allowed tools) and include a short excerpt of the command (tool_input.command, truncated); keep the headless wording only when there is no approval channel.

**Suggested regression test:** test/qa-<cluster>.test.ts feeding a fake claude stream-json result with permission_denials and asserting the status text in both modes


## Continuation integration · 2026-10-26

Repair round 1 merged into `codex/dogfood-qa-continue`. Typecheck and all 9 targeted tests pass. Independent browser re-verification is running on a detached integrated build; prior evidence above describes the earlier session.

Fresh continuation Chrome replay: all 6 scenarios pass. Independent axe audit initially measured partially transparent entrance-animation colors; waiting for the actual card animation to finish confirms zero settled contrast violations. This is a harness synchronization correction, not a weakened accessibility assertion. Cross-window replacement remains disarmed until explicitly reviewed; the other approval/question controls and layout checks pass with fake CLIs. Logs: `/private/tmp/codeflow-qa-continue/step1-browser.log` and `step1-browser-repaired.log`.

Continuation follow-up review repaired the remaining actionable nits: a failed approval POST arriving after the request's card has disappeared now produces a six-second toast and disarms the replacement until it is reviewed; long decorative question headers/descriptions are truncated instead of discarding the question; Claude read-only and oversized-tool refusals are no longer marked as user decisions, and mixed presence of tool-use IDs still matches an actual inbox decision. New unit cases cover these provider/registry boundaries. The live Chrome race routes the first click through a second-client decline, waits for the replacement card, then releases the 409: the failure toast appears and the second request stays pending and disabled. All 11 targeted tests and 7 browser scenarios pass; tsc passes. Evidence: `/private/tmp/codeflow-qa-continue/approval-followup-unit.log` and `approval-agy-followup-browser.log`. These use fake CLIs and scratch repos.
