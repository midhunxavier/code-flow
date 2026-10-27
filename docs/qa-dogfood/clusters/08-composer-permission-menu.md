# Cluster 08 · composer-permission-menu

**Composer permission menu vs what the run gets (trust, tool approvals, Docker, Antigravity defaults)**

Status: **independently verified with fake providers** · 8 issues · branch `qa-fix/composer-permission-menu`

Planner notes: One theme: the composer shows one permission policy and sends another. t02-4: loadRepoCheck (ui/state.ts:829) quietly sets trust from .codeflow/config.json while the menu shows 'Ask for approval'. t02-5: Safe and Trusted have no menu item (ui/chat-controls.tsx:61-69). t02-6/t03-6/S02-3: the Run details 'Tool permissions' row (ui/onboarding.tsx:301) reads interactiveApprovals from localStorage instead of the live toolApprovals state. t21-1: with Docker isolation the chip shows 'Approve for me' while the request still asks for approvals (the default at ui/composer.tsx:133-140). t10-8 and t20-13: the defaults pick Antigravity, which cannot do approvals, as reviewer, synthesizer or judge, or keep 'Ask for approval' when agy is chosen; Start then fails with a misleading error (the message in src/run-permissions.ts). Derive the effective policy once and use that value in the menu, the summary, Run details and runBody. agy-unrestricted owns the sticky nativeAntigravity flag; team-dialogs-templates owns the task-team lead quick picker (t10-10). Duplicate groups: [["t02-6","t03-6","S02-3"]]

Likely files: `ui/composer.tsx`, `ui/onboarding.tsx`, `ui/chat-controls.tsx`, `ui/state.ts`, `ui/roles.ts`, `src/run-permissions.ts`, `src/adapters/claude.ts`, `src/engine.ts`

## Independent verification · 2026-10-26

Verified from integrated `c70d95f` in `codex/qa-verify-lifecycle-review-permissions`, using an owned scratch server/home, Chrome and fake agent/Docker executables. Audited effective permission derivation and its consumers in the menu, request, Run details, templates and role defaults. The original cases passed; verification also repaired the fork explanation described below.

| Issue | Independent outcome |
|---|---|
| t02-4 | Pass. Fresh project with committed `trust: trusted` displayed Trusted, Run details identified `.codeflow/config.json`, POST sent tools=false, and the actual saved run had trusted/toolApprovals=false. |
| t02-5 | Pass. Safe and Trusted remain selectable and checked. Independent sequence Trusted → Safe → Ask → reload preserved Ask; Run details reflected the selected policy. |
| t02-6, t03-6, S02-3 | Pass. Fresh default Claude request/template/Run details agree on approvals=true in browser replay. Independent explicit Ask after Safe persisted across reload; saved template stored true and details showed “Explicit choice”. |
| t21-1 | Pass. Docker displayed Approve for me, details named the isolation constraint, request sent tools=false and the configured image, and switching isolation off restored Ask. The endpoint accepted the fake Docker launch with 201. |
| t10-8 | Pass. Explicit Ask avoided Antigravity in default pipeline reviewer, race judge and debate synthesizer. Explicit mixed Codex/Antigravity roles disabled Start with the actionable approval explanation. |
| t20-13 | Pass. Selecting Antigravity for every role showed Approve for me and sent tools=false. Restoring Codex restored the Ask preference. The all-Antigravity POST was captured and deliberately intercepted, and targeted server permission tests verified the actionable error for unsupported approvals. |

Adjacent finding from independent cluster07 verification: a fork from a source with `approvals.tools=false` correctly disabled Ask for approval, but the menu said it required a supported local provider even when Claude or Codex was selected. `ChatControls`/`PermissionMenu` now accept an explicit unavailable reason, and the fork dialog explains that its source does not ask for approval. Permission enforcement is unchanged. New `test/e2e/qa-composer-permission-menu-fork.e2e.ts` reproduced the wrong explanation before the fix. It verifies both supported provider choices, tools=false on the actual fork POST and saved child, plus a positive source-tools=true case that allows and persists approvals.

Validation: `npx tsc --noEmit`; 46/46 targeted cluster04/05/06/08 tests; 14/14 Chrome cluster04/06/08 e2e tests, including all five original permission-menu browser scenarios. After the fork explanation repair, the five permission-menu scenarios were rerun together with the two new fork scenarios (7/7). The separate live matrix above used new scratch fixtures and browser interactions in addition to those tests.

Evidence: `/private/tmp/codeflow-qa-continue/verify08-permissions-1793007483075/evidence.json`; screenshots under `/private/tmp/codeflow-qa-continue/shots/verify08-permissions/`. The same browser also opened a missing lazy team-task route and rendered its error view without page errors. Fork explanation evidence: `/private/tmp/codeflow-qa-continue/verify046-provenance-1793007640029/fork-evidence.json` and `shots/verify046-provenance/001-fork-source-permission-reason.png` under the QA scratch root.

No unresolved permission-menu issue found. These checks prove UI/request consistency and fixture/server validation; no real Antigravity session, interactive provider approval or real Docker container was exercised. The fake Docker request may finish as failed because the fixture does not emulate container execution; its 201 is not a claim of container success.

## Fix result

Commits:
- `9b11c33` Show and send one permission policy from the composer
- `6f98cee` Keep Antigravity out of approval defaults and say approvals refused it
- `52dd327` Cover the composer permission QA regressions
- `eb64780` Keep the template-grant check meaningful now templates save live approvals

Fixer notes for the integrator: Base: the branch had no commits from the earlier attempt, so I fast-forwarded it to claude/dogfood-qa-2026-10-25 at 8e170b3 before working. The integration branch has since moved to 07d6ff7 (approvals-inbox); git merge-tree shows no conflicts with it.

An existing test changed on purpose: in test/e2e/simplification.e2e.ts, 'one template library restores complete saved configurations' now picks 'Approve for me' before applying the template. It asserted stored.config.toolApprovals === false only because currentConfig read the empty localStorage key. Templates now record the live value, which for a fresh Codex conversation is true by default, so the explicit pick keeps the 'template grants are not restored' check meaningful.

Behaviour changes worth knowing:
1. The Permissions menu (composer, run follow-ups, side chats) has five items: Safe, Ask for approval, Approve for me, Trusted, Full access.
2. Approvals at a level other than Standard are labelled e.g. 'Trusted · ask for approval'.
3. The automatic 'Ask for approval' default applies only to a solo Claude or Codex conversation at Standard trust. It is no longer saved into composerRunOptions or drafts; only explicit choices are.
4. The start request sends approvals.tools=false when Docker, a remote worker, an external source, Safe, or all-Antigravity roles make approvals unavailable. The explicit preference is kept, so the chip comes back when that condition clears.
5. rolesFor reads composerRunOptions.toolApprovals.

Possibl …

## Issues

### t02-4 · major · Permissions shows 'Ask for approval' while the run actually gets repo-config trust 'trusted' (shell commands allowed without asking)

**Fix outcome: fixed.** New ui/composer-permissions.ts: toolApprovalState() works out the run's tool approvals once. Without an explicit choice, only a Claude or Codex conversation at Standard trust asks (it used to ask at any trust, including repo-config 'trusted'). permissionLabel() no longer says 'Ask for approval' unless the policy is Standard plus approvals (Full plus approvals for ACP); approvals at another level read e.g. 'Trusted · ask for approval'. ui/composer.tsx: the removed defaulting effect (old lines 139-142) is replaced by this derived value, which the menu, Run details and runBody all use. ui/chat-controls.tsx PermissionMenu uses permissionLabel/asksForApproval.

Fixer's check: QA server f08 (fake) from this worktree, with a scratch repo whose .codeflow/config.json is {trust:trusted,check:true}, opened in a fresh browser. Before the fix the chip said 'Ask for approval' and the run got trusted with tools=true. Now the chip reads 'Trusted' with the Trusted item ticked. Run details shows 'Permissions trusted | .codeflow/config.json' and 'Tool permissions Decline requests requiring interaction | Application default'. Send gives POST trust=trusted, approvals.tools=false; the created run has permissions {trust:trusted, toolApprovals:false}. Control: explicitly picking Ask for approval sends standard with tools=true. Variant with Settings trust=trusted: chip 'Trusted'. In …

Tests: `test/qa-composer-permission-menu.test.ts`, `test/e2e/qa-composer-permission-menu.e2e.ts`

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-16.

**Repro**

> 1. In a scratch clone write .codeflow/config.json {"trust":"trusted","check":"true"}.
> 2. Open its project in a fresh browser (no stored 'trust' or 'interactiveApprovals'), Agent mode with Claude Code.
> 3. The Permissions control reads 'Ask for approval' with that item checked. Run details shows 'Permissions trusted' but 'Tool permissions: Decline requests requiring interaction'.
> 4. Send a task and GET /api/runs/<id>.

**Expected:** The control reflects the effective policy: it shows Trusted, or applying the repo trust makes the label say so. Explicitly choosing 'Ask for approval' gives trust=standard, so the default should match.

**Actual:** The run has trust=trusted with approvals.tools=true. For Claude, trusted adds 'Bash' to the allowed tools, so shell commands run without the approval the label promises.

**Root cause (verifier):** Three UI parts together show one permission policy while the run gets another.

1. ui/state.ts:829 (loadRepoCheck): `if (config.trust && !store.get("trust")) trust.value = config.trust;` sets the trust signal to the repo default ("trusted"). That part is intended.
2. ui/composer.tsx:136-140: when no interactiveApprovals preference is stored, `setToolApprovals(single && ["claude","codex"].includes(agent))` turns tool approvals on for a solo Claude or Codex run, whatever the trust. The run is then posted with `trust: trust.value` and `approvals.tools: true` (composer.tsx:216-217).
3. ui/chat-controls.tsx:61:
   `const permissionName = permissions.tools ? "Ask for approval" : {...}[permissions.trust]`
   The label and the ✓ on the "Ask for approval" item (line 67, `on={permissions.tools}`) depend only on `tools` and ignore trust. That item's own onClick (line 67) sets trust "standard" (or "full" for ACP), so the menu has no state meaning "trusted + approvals", but the default produces exactly that.

On the server, src/server.ts:914-915 accepts trust trusted with tools true unchanged. In src/adapters/claude.ts:64, `writeTools("trusted")` returns `[...READ_TOOLS, "Bash"]`. Line 117 puts …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/claude.ts`

**Suggested fix:** Make the Permissions control show the effective policy, and make the default match what an explicit "Ask for approval" pick produces.

1. In ui/chat-controls.tsx PermissionMenu, mark "Ask for approval" as selected only when `tools && (trust === "standard" || (acp && trust === "full"))`.
   - For other combinations, either show a combined label such as "Trusted · ask for approval", or add a "Trusted" menu item (TRUST.trusted.help) checked when `trust === "trusted"`.
   - The trigger must never read "Ask for approval" while trust is "trusted".
2. Pick one default rule in ui/composer.tsx:136-140:
   - (a) Auto-enable toolApprovals only when `trust.value` is "standard" (keep it off when the repo or Settings trust is trusted, so the label honestly reads "Trusted"), or
   - (b) When auto-enabling approvals, narrow trust to standard, as the explicit menu item does.
   Option (a) keeps the repo owner's documented `trust: trusted` default and shows it. Either is fine as long as label, Run detai …

**Suggested regression test:** Browser test in test/e2e/ui.e2e.ts, next to the existing "Ask for approval" assertions around line 1068:
- Create a repo fixture whose .codeflow/config.json has {"trust":"trusted","check":"true"}.
- Open its composer in a fresh context (no trust or interactiveApprovals keys), solo with Claude.
- Assert the Permissions button text does not match /Ask for approval/ while the Run details "Permissions" row reads trusted, and that the "Tool permissions" row matches the toolApprovals value that is sen …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4695 on port 4695. I moved the old home aside to homes/v4695.prev-200412. The server ran from my snapshot builds/v4695, where the only change is that test/fake-bin/claude logs its argv; product code is untouched.

1. Scratch clone of MQTT-MCP at clones/v4695-mqtt, with a committed .codeflow/config.json {"trust":"trusted","check":"true"}. I added it through the UI (Repositories, Add repository, Open this repository, Create project "v4695-trusted"). localStorage afterwards: composerProject, repo, projectRepo, recentRepos. There was no trust and no interactiveApprovals key.
2. New browser context with no profile, opened at #/project/p-429d9c7b/new. Provider was Claude Code. The Permissions button read "Ask for approval", and the open menu showed "Ask for approval ✓". Run details showed:
   - "Permissions | trusted | .codeflow/config.json"
   - "Tool permissions | Decline requests requiring interaction | Application default"
3. I typed a task and clicked Send. GET /api/runs/2610251905-50e4337f returned trust "trusted", approvals.tools true, permissions {trust: trusted, toolApprovals: true}.
4. The logged Claude argv had `--permission-prompt-tool stdio`, `--permission-mode acceptEdits` and an `--allowedTools` list containing a bare `Bash`. Any shell command is pre-allowed and never reaches the approval prompt.

Control (s3), in another fresh browser: I clicked the already-checked "Ask for approval" item. The label stayed "Ask for approval", but Run details changed to "Permissions standard / Explicit browser preference" and "Tool permissions: Ask for supported native requests". Run 2610251906-88dcec5f got trust "standard" with tools true. Its argv had no bare Bash, only the Bash(npm *)… allowlist. So one label with one checked item maps to two different shell policies.

Variant (s4): a project with no repo trust, after choosing Settings > Run defaults > Agent permissions = Trusted, also shows "Ask for approval" with trust=trusted.

Run view (s5): the follow-up Permissions control reads "Ask for approval" for both runs, the trusted one and the standard one.

There were no console or 5xx errors. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4695/t02-4/ (s1–s6 .mjs/.log, claude-argv-s2.jsonl, claude-argv-s3.jsonl). Screenshots are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scra …

</details>

### t21-1 · major · Docker agent isolation cannot start with the default 'Ask for approval'; the chip shows 'Approve for me' but the request still asks for approvals

**Fix outcome: fixed.** ui/composer.tsx runBody now sends approvals.tools from toolApprovalState(). It is false when Docker isolation (checkbox or project default), a remote worker or an external source makes approvals unavailable, which matches what the chip already showed. The explicit preference is kept, so unticking isolation brings 'Ask for approval' back. The server's fail-closed check is unchanged.

Fixer's check: f08, fresh browser, plain scratch repo, solo Claude. The chip reads 'Ask for approval'. After ticking 'Run agents in a prebuilt Docker image' it reads 'Approve for me', the menu shows Ask for approval disabled, and Run details says 'Decline requests requiring interaction | Unavailable with Docker isolation'. Unticking brings back 'Ask for approval'. Re-ticking with image qa-agents:local and clicking Send: POST approvals.tools=false with agentContainer.image set, HTTP 201 (it used to be 400 'claude cannot provide the run's required interactive approvals'). Project-default isolation (runDefaults:<repo> saved, nothing touched): chip 'Approve for me', 201, tools=false. Browser errors [].

Tests: `test/qa-composer-permission-menu.test.ts`, `test/e2e/qa-composer-permission-menu.e2e.ts`

Source: tester unit infra-remote-devices-clients-1; observed with fake-agents; features REM-10.

**Repro**

> 1. Start a fresh QA server (fake or real) and open http://127.0.0.1:<port>/ in a fresh browser.
> 2. Open #/project/<MQTT-MCP id>/new. The permission chip shows 'Ask for approval' (the default for single Claude).
> 3. Type any task. Open Run options, then Agent isolation, tick 'Run agents in a prebuilt Docker image' and enter an image (e.g. qa-agents:local). The chip now shows 'Approve for me'.
> 4. Click Send.

**Expected:** The run starts with the permission the chip shows (Approve for me), or the UI asks the user to pick a supported permission mode.

**Actual:** POST /api/runs is sent with approvals:{tools:true} and refused: 'claude cannot provide the run's required interactive approvals in this environment'. Isolation cannot be used until the user opens Permissions and re-selects 'Approve for me', which already looks selected. Seen in work/t21/s20b1.log (fresh browser, fake) and s20f.log (real-mode server, real Docker).

**Root cause (verifier):** The composer shows one approval value and sends another.

- ui/composer.tsx:139: with no stored "interactiveApprovals", a single Claude/Codex conversation defaults toolApprovals to true.
- ui/composer.tsx:158-161: the project-defaults effect turns on containerEnabled without touching toolApprovals. Ticking the isolation checkbox (line 406) does not touch it either.
- ui/composer.tsx:322 (ChatControls) and ui/composer.tsx:329 (team PermissionMenu) display `tools: !remoteWorker && !containerEnabled && !externalSource.value && toolApprovals`, with approvalsAvailable false. The chip therefore says "Approve for me" and the menu disables "Ask for approval".
- ui/composer.tsx:216 runBody sends `approvals: { ..., tools: remoteWorker ? false : toolApprovals }`. It masks only remoteWorker, not containerEnabled (nor externalSource), so it sends tools:true.
- On the server, src/server.ts:915 sets runTools = body.approvals.tools === true. validateRoles (server.ts:916) and engine.ts:5221 then call resolveRunPermissions with container:true. src/run-permissions.ts:98-99 computes wantsApprovals = true and throws "${provider} cannot provide the run's required interactive approvals in this environmen …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/daily-workflow.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Fix it in ui/composer.tsx:
- Compute the approval value once: `const effectiveTools = !remoteWorker && !containerEnabled && !externalSource.value && toolApprovals;`.
- Use it for the chip at lines 322 and 329 and for the request at line 216 (`approvals: { plan: ..., tools: effectiveTools }`). The run then starts with exactly what the chip shows.
- Keep the stored toolApprovals preference as it is. Turning isolation off then restores "Ask for approval", and the user's global interactiveApprovals setting is not overwritten.
- Sending false is also correct for continuations: server.ts:915 treats `approvals.tools !== false` as inherit, so false only narrows.

Do not normalize on the server. Dropping a requested approval there would contradict the documented fail-closed rule (docs/auto-team.md:25), so the UI should send what it displays.

Optional extras:
- Scroll the composer error into view or show it next to Send. After Send the 400 message was off-screen.
- Check whether the externalSou …

**Suggested regression test:** 1. In test/e2e/ui.e2e.ts, add a test using a fresh page with interactiveApprovals unset and pattern solo with claude:
   - Open the composer, enable "Run agents in a prebuilt Docker image" and fill the Image field.
   - Assert the Permissions chip text is "Approve for me".
   - Intercept POST /api/runs with page.route, as daily-workflow.e2e.ts:262 already does, and assert `request.approvals.tools === false` and `request.loop.agentContainer.image` is set.
   - Repeat with the project default "Use …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: qa-server.sh start v4607dk 4607 fake. It used a new home with no runs and no stored browser state. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4607dk/repro.mjs, run in a fresh headless Chrome with no profile and empty localStorage.

(A) Default path, log at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4607dk/default.log:
- Opened #/project/p-ef01794b/new (MQTT-MCP, single Claude Code). The Permissions chip showed "Ask for approval".
- Typed a task, opened Run options > Agent isolation, ticked "Run agents in a prebuilt Docker image" and set the image to qa-agents:local.
- The chip changed to "Approve for me". Opening the menu showed "Ask for approval" disabled ("Requires a local Claude, Codex or ACP provider…") and "Approve for me ✓" selected.
- Clicked Send. POST /api/runs body: {"approvals":{"plan":false,"tools":true},"trust":"standard","agentContainer":{"image":"qa-agents:local","network":true},"roles":{"agent":["claude"]}}. The server answered 400: "claude cannot provide the run's required interactive approvals in this environment".
- The composer kept the error. In the screenshot after Send the error is not even in the viewport: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4607dk/003-default-03-after-send.png. The menu screenshot is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4607dk/002-default-02-menu-after-isolation.png.
- Unticking isolation brought the chip back to "Ask for approval", so the hidden state was true the whole time.

(B) Control, log at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4607dk/explicit.log:
- Same steps, but I clicked the already-checked "Approve for me" before Send.
- The body then had tools:false, POST returned 201 and run 2610252238-a3a4e117 was created with permissions.toolApprovals=false.
- The run later failed with "Container CLI capability probe failed". That is a limitation of the fake docker, not part of this issue.

(C) Project default, using /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4607dk/projdefault.mjs …

</details>

### t10-8 · major · Real composer defaults pick Antigravity as independent reviewer/synthesizer/judge, but the default 'Ask for approval' makes Start fail with a misleading error

**Fix outcome: fixed.** (1) An auto-derived default is no longer stored. Only an explicit choice (menu, browser preference, rerun or draft) goes into composerRunOptions and drafts, so 'Ask for approval' no longer carries into team templates after a reload or navigation. (2) ui/state.ts rolesFor() leaves agy out of the eligible defaults after an explicit Ask for approval (unless approvals are masked by Safe, Docker or remote), so default reviewer, judge and synthesizer go to Claude or Codex. (3) If an explicit agy role sits beside providers that can ask, the composer problem disables Start with: "Antigravity can't ask for approval. Choose another option in Permissions, or pick Claude or Codex for <Role>." (4) src/run-permissions.ts adds AGY_APPROVALS_PROBLEM for the approvals case. Remote/container still get AGY_MANAGED_PERMISSION_PROBLEM.

Fixer's check: A real-mode QA server f08b (real agy 1.4.7, managedCompatible) ran with POST /api/runs intercepted in the browser, so no runs started. Agent draft, reload, then Plan → Build → Review: chip 'Approve for me', sentence '... Antigravity CLI reviews', body tools=false (the 400 came from tools=true). With an explicit Ask for approval, pipeline, race and debate defaults picked Codex reviewer, Claude Code judge and Claude Code synthesizer, Start enabled. Picking agy for Reviewer explicitly showed the problem and disabled Start; choosing Approve for me cleared it and sent tools=false. Direct API POST on the real server (pipeline, agy reviewer, tools=true) returned 400 "Antigravity can't take interact …

Tests: `test/qa-composer-permission-menu.test.ts`, `test/e2e/qa-composer-permission-menu.e2e.ts`

Source: tester unit ai-teams-patterns-1; observed with real-agents; features TEAM-03, TEAM-10, TEAM-11, TEAM-08.

**Repro**

> 1. Real-mode QA server with claude, codex and agy installed (agy managedCompatible). Fresh browser profile.
> 2. New run in Agent mode: the permission menu defaults to 'Ask for approval' (interactive approvals).
> 3. Run options -> Advanced -> Built-in workflow 'Plan → Build → Review'. Don't touch the roles. Sentence: 'Claude Code plans → Codex builds → Antigravity CLI reviews'. Debate likewise shows 'Antigravity CLI writes the final plan'.
> 4. Type a task. No composer problem is shown and Start run is enabled. Click Start run.

**Expected:** Either the defaults avoid a provider that the current permissions can't run, or the composer flags the conflict before Start (as the AI team setup dialog does: 'This task requires interactive tool approvals, which Antigravity does not support').

**Actual:** POST /api/runs -> 400 'Antigravity managed execution requires the verified local macOS executor and existing Keychain login. Remote/container execution and interactive approvals are unsupported. Choose Claude or Codex for other environments.' The message leads with executor/Keychain login rather than the approvals setting, and the run never starts. Same for a race with an Antigravity judge. With 'Approve for me' the race ran fine (2610251544-9044d929).

**Root cause (verifier):** Four pieces combine.

1. The approvals default survives remounts.
   - ui/composer.tsx:133-140 turns toolApprovals on for a solo claude/codex agent. It resets it on a pattern change only while `initialOptions.current.toolApprovals === undefined`.
   - ui/composer.tsx:172-174 publishes the auto-derived toolApprovals:true into the composerRunOptions signal, and the project draft saves it (ui/state.ts:1205, restored at :1240).
   - So after any Composer remount (in-app navigation, reload or draft restore), initialOptions.current.toolApprovals is true. The line-139 reset is then skipped and the multi-agent template keeps "Ask for approval". The reporter blamed line 139 alone; the real cause is this persistence path.

2. Defaults pick agy without checking approvals.
   - ui/state.ts:773 (rolesFor) treats agy as eligible whenever health reports managedCompatible, regardless of composerRunOptions.toolApprovals.
   - The pipeline template's own reviewer default is agy (asserted in test/roles.test.ts:19).
   - ui/roles.ts:22-50 (independentRoles) moves the race judge and debate synthesizer to agy.

3. The composer never flags the conflict.
   - ui/composer.tsx:544-571 (startProblem) has no  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/roles.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-permissions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/repo-selection-ui.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-permissions.test.ts`

**Suggested fix:** 1. Default roles (ui/state.ts:773, rolesFor): when composerRunOptions.value.toolApprovals is true and antigravityExecution is not "native", leave agy out of `eligibleDefaults`. The pattern default and independentRoles then fall back to Claude/Codex for reviewer/judge/synthesizer, as they already do for unverified agy. Explicit user picks stay untouched.

2. Pre-start check (ui/composer.tsx startProblem, or the composer `problem` at :187, passing toolApprovals and nativeAntigravity in): if approvals are on, Antigravity is not native, and any role uses agy, return a specific problem. Suggested wording: "Interactive tool approvals aren't available for Antigravity (<Role>). Choose Approve for me, or pick Claude or Codex for <Role>." This mirrors ui/task-team.tsx:70.

3. Optionally, in ui/composer.tsx:329, show the "Ask for approval" item with that explanation or disable it while agy fills a role.

4. Approvals carry-over (ui/composer.tsx:136-140): only an explicit user choice should surviv …

**Suggested regression test:** 1. test/repo-selection-ui.test.ts, extending the existing "default and independent role selection excludes known unhealthy providers" test. With agents claude/codex/agy all healthy and agy managedCompatible:true, set `state.composerRunOptions.value = { toolApprovals: true }`.
   - Assert `rolesFor(pipeline).reviewer` is not ["agy"], and likewise for race judge and debate synthesizer.
   - Assert that with `{ toolApprovals: true, antigravityExecution: "native" }` or `{ toolApprovals: false }`, ag …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh real-mode QA server, v4621x on 127.0.0.1:4621, with a new home. GET /api/doctor reported agy 1.4.7 installed, signedIn and managedCompatible:true. I drove it with Playwright using fresh, non-persistent browser contexts (localStorage empty at load) on project MQTT-MCP. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4621x/.

Partial refutation of the reporter's mechanism. In a fresh profile, going straight from Agent mode (permission label "Ask for approval") to Run options > Advanced > Plan → Build → Review flips the label to "Approve for me" (dry-pipeline.log). That is because the ui/composer.tsx:139 effect resets approvals when the pattern stops being solo. So the approvals state does not carry over on the very first composer mount.

It does reproduce in these realistic flows:
1. Agent mode, type a draft, reload the page (start-pipeline.log). After the reload the composer still shows "Ask for approval". Switching to Plan → Build → Review gives "Claude Code plans → Codex builds → Antigravity CLI reviews (up to 2 rounds of fixes)" with roles planner=claude, builder=codex, reviewer=agy. The permission label stays "Ask for approval", no composer problem is shown, and Start run is enabled. Clicking Start sends POST /api/runs with body approvals.tools=true, trust=standard, antigravityExecution=isolated and reviewer=["agy"]. The server answers 400: "Antigravity managed execution requires the verified local macOS executor and existing Keychain login. Remote/container execution and interactive approvals are unsupported. Choose Claude or Codex for other environments." That text is shown in the composer and the run never starts.
2. Agent mode, Inbox, New run, Plan → Build → Review (nav.log). Plain in-app navigation is enough: the label stays "Ask for approval", there is no problem and Start is enabled.
3. Race after a reload (start-race.log). Sentence: "Claude Code and Codex each solve it separately → Antigravity CLI picks the best, blind". The judge is agy, no problem is shown, and Start returns the same 400.
4. Debate after a reload (dry-debate.log, not started). Sentence: "...→ Antigravity CLI writes the final plan → Codex builds it → Claude Code reviews it". The synthesizer is agy, approvals are on, and no problem is shown.
5. Fresh profile with no reload, pipeline, then explicitly picking "Ask for approval" in the pipeline's permission menu, whi …

</details>

### t02-5 · minor · Safe/Trusted run permissions show with no checked option and cannot be re-selected

**Fix outcome: fixed.** ui/chat-controls.tsx PermissionMenu lists Safe and Trusted as checkable items (Safe, Ask for approval, Approve for me, Trusted, Full access), so whatever level the label shows is ticked and can be chosen again. Safe and Trusted are disabled for ACP agents, Trusted also when restricted, and Safe stays available when restricted. The same menu is used for run follow-ups and side chats.

Fixer's check: f08, fresh browser. Safe-config repo: chip 'Safe' with the Safe item ticked. After Approve for me the menu still lists Safe, and choosing it restores the 'Safe' chip with localStorage trust=safe; Send gives trust safe, 201. Trusted-config repo with interactiveApprovals=0: chip 'Trusted' with Trusted ticked; Approve for me, then Trusted again, sends trust=trusted with tools=false, 201. Desktop and 390px phone screenshots show the 5-item menu fitting (shots/f08/002-composer-menu-open.png, 003-composer-menu-phone.png). Accessibility e2e (axe) still passes. Browser errors [].

Tests: `test/e2e/qa-composer-permission-menu.e2e.ts`, `test/qa-composer-permission-menu.test.ts`

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-16.

**Repro**

> 1. Set .codeflow/config.json trust to 'trusted' (or 'safe') in a scratch clone.
> 2. Fresh browser with localStorage interactiveApprovals='0' (or Safe with defaults). Open the composer.
> 3. The Permissions label shows 'Trusted' (or 'Safe'). Open the menu: no item is checked.
> 4. Choose 'Approve for me', then reopen the menu.

**Expected:** The menu offers the current Safe/Trusted level, or the label maps to a selectable item, so the user can return to it.

**Actual:** Only Ask, Approve for me and Full access exist. After switching away there is no way back to the repo's Safe/Trusted level from the composer.

**Root cause (verifier):** ui/chat-controls.tsx:61 maps the trigger label for all four trust values, including safe -> "Safe" and trusted -> "Trusted". But ui/chat-controls.tsx:67-69 renders only three MenuItems:
- "Ask for approval": on=permissions.tools; onClick hard-codes trust "standard", or "full" for ACP.
- "Approve for me": on=!tools && trust==="standard".
- "Full access": on=!tools && trust==="full".
So when trust is "safe" or "trusted" and tools are off, no item is checked and neither level can be picked again. This happens in four ways:
1. A repo .codeflow/config.json trust is applied by ui/state.ts:829, only while localStorage has no "trust".
2. Settings -> Run defaults sets it (ui/settings.tsx:141).
3. A rerun sets it (ui/run.tsx:2294).
4. ui/composer.tsx:138 forces tools off whenever trust is safe.
Picking any item calls the composer's onPermissions (ui/composer.tsx:323 and :329). That calls setTrust (ui/state.ts:655-657), which writes the browser-wide localStorage "trust". From then on ui/state.ts:829 (`if (config.trust && !store.get("trust"))`) never applies a repository's configured trust again in that browser. The menu was cut to three items in commit 636d2a3 ("Simplify workspace controls…", …

**Files:** `ui/chat-controls.tsx`, `ui/composer.tsx`, `ui/state.ts`, `test/e2e/settings.e2e.ts`, `test/e2e/ui.e2e.ts`

**Suggested fix:** In PermissionMenu (ui/chat-controls.tsx), make every trust level that the label can show a selectable, checkable item:
- Either always list "Safe" and "Trusted" as checkable items with the same help text as TRUST (move TRUST from ui/composer.tsx into ui/state.ts or a small shared module, so chat-controls can import it without an import cycle), or at least add the current Safe/Trusted level as a checked item when it is active.
- Disable Safe and Trusted for acp:* agents, which require Full access.
- When the composer is restricted (an external source forces Safe), keep Safe checked and enabled.
- Optionally, when a repo config trust exists, add a "Repository default (<level>)" item. Choosing it clears the stored browser trust or sets trust.value = repoConfig.config.trust, so the repo's level can be restored without opening Settings.
Two related fixes:
- "Ask for approval" should keep the current safe/standard/trusted level instead of always forcing "standard". Today the checked item sil …

**Suggested regression test:** Extend test/e2e/settings.e2e.ts after line 212, which already asserts that the composer's Permissions button shows /Safe/ after Settings -> Agent permissions = safe:
1. Click the Permissions button and assert that a menuitem named "Safe" is shown with the chat-choice-check mark / class "on".
2. Choose "Approve for me", reopen the menu, choose "Safe", and assert the label matches /Safe/ again and localStorage trust === "safe".
Repeat with "trusted" and interactiveApprovals="0".
Add a repo-config  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4601 on port 4601 (I moved the old home aside, so this home had no runs). Scratch clone of MQTT-MCP at qa/clones/v4601-mqtt (bare origin next to it), with a committed .codeflow/config.json. Everything was done through the UI with headless Chrome and new browser profiles. Scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4601/b2-trusted.mjs and b3-safe.mjs. Logs: b2.log and b3.log in the same folder.
(A) config {"trust":"trusted"}, new browser profile v4601-a, empty localStorage, Claude Code. Open another repository -> Create project. The label reads "Ask for approval" and that item is checked, because tools default to on for solo Claude. Underneath, trust is "trusted", but the label does not show it.
(B) config {"trust":"safe"}, new profile v4601-b with no localStorage changes, project's new-run page. STEP1: label "Safe". The menu shows Ask for approval / Approve for me / Full access and none is checked (on=false, no checkmark). Screenshot shots/v4601/001-b3-safe-fresh-menu.png.
STEP2: chose "Approve for me". The label became "Approve for me" and localStorage now has trust=standard and interactiveApprovals=0. The reopened menu still has only the 3 items, so there is no Safe entry to go back to.
STEP3: after a reload the label is still "Approve for me". The repo's safe level is no longer applied.
STEP4: Settings -> Run defaults -> Agent permissions now reads "Standard". This select offers Safe/Standard/Trusted/Full access.
STEP5: chose Trusted there and went back to the composer. The label reads "Trusted" and again none of the 3 items is checked (shots/v4601/004-b3-trusted-menu.png).
No console errors or 5xx responses. This is not caused by the tester's script: the default Safe case needs no localStorage setup, and Trusted is reachable through Settings alone. Not by design either: test/e2e/settings.e2e.ts:212 asserts that the composer shows "Safe", and chat-controls.tsx:61 maps safe and trusted to labels, so these states are meant to appear in the composer. They just have no menu entry. The one recovery path is Settings -> Run defaults, and it sets a browser-wide default, not the repo's level.

</details>

### t02-6 · minor · Run details 'Tool permissions' row contradicts the composer's default approval setting

**Fix outcome: fixed.** ui/onboarding.tsx EffectiveSettings takes a required toolApprovals {tools, source} prop from the composer's toolApprovalState and no longer reads localStorage 'interactiveApprovals'. The source names why: 'Default for Claude and Codex conversations', 'Explicit choice', 'Safe permissions', 'Unavailable with Docker isolation', 'Unavailable on a remote worker', 'External source · Safe permissions', "Antigravity can't ask for approval". currentConfig() and SaveTaskTemplateDialog take the composer's live value, so saved templates record what the run would get. ComposerLibraryEditor in project settings keeps the browser preference.

Fixer's check: f08, fresh browser, plain repo, solo Claude: chip 'Ask for approval', and the Tool permissions row is 'Ask for supported native requests | Default for Claude and Codex conversations' (it used to say Decline | Application default). Save as template stores config.toolApprovals=true (it used to be false). Send gives approvals.tools=true and the run has toolApprovals=true. After choosing Approve for me the row reads 'Decline requests requiring interaction | Explicit choice'. Browser errors [].

Tests: `test/e2e/qa-composer-permission-menu.e2e.ts`, `test/qa-composer-permission-menu.test.ts`

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-16.

**Repro**

> 1. Fresh browser (localStorage interactiveApprovals unset). Open the composer in Agent mode with Claude Code. The Permissions control shows 'Ask for approval'.
> 2. Open Run options > Run details.
> 3. Send and check approvals.tools on the run.

**Expected:** The Tool permissions row says approvals will be asked (the run gets tools=true).

**Actual:** The row says 'Decline requests requiring interaction · Application default', while the run is created with approvals.tools=true.

**Root cause (verifier):** ui/onboarding.tsx:301 (the issue cited line 299) builds the "Tool permissions" row in EffectiveSettings only from the browser preference: `store.get("interactiveApprovals") === "1" ? "Ask for supported native requests" : "Decline requests requiring interaction"`. Its Source column also says "Application default" whenever the key is null.

The composer keeps its own effective value instead:
- ui/composer.tsx:133 initialises toolApprovals.
- ui/composer.tsx:137-140: when no explicit preference or restored option exists, it sets `toolApprovals = single && ["claude","codex"].includes(agent)`, so Agent mode with Claude or Codex defaults to true. If trust is safe, it forces false.
- The composer gates the shown value with `!remoteWorker && !containerEnabled && !externalSource && toolApprovals` (lines 322 and 329).
- It sends `approvals.tools: remoteWorker ? false : toolApprovals` (line 216).

EffectiveSettings (rendered at ui/composer.tsx:403) never receives that state, so it falls back to the raw localStorage key, which is null in a fresh browser. This newer default came in commit 29628ea (Agent workspace), but the row from daf3108 was never updated.

The same stale derivation exists in …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Pass the composer's effective tool-approval state into EffectiveSettings instead of re-reading localStorage.

1. In ui/composer.tsx:403, add a prop such as `toolApprovals={{ enabled: !remoteWorker && !containerEnabled && !externalSource.value && toolApprovals, origin }}`. This is the same expression the Permissions control uses, so the two cannot drift.
2. Set `origin` as follows:
   - "Explicit browser preference / selected preset" when store.get("interactiveApprovals") !== null or composerRunOptions.toolApprovals was restored.
   - "Agent default for Claude/Codex" when the single-agent default effect chose it.
   - "Unavailable with remote worker / Docker isolation / external source" when gated off.
   - "Safe permissions" when trust is safe.
3. In ui/onboarding.tsx:301, render the row from that prop.
4. Apply the same idea to currentConfig() at ui/onboarding.tsx:70: take toolApprovals from composerRunOptions.value.toolApprovals (or a passed-in value) rather than the raw key, so save …

**Suggested regression test:** Add a case to test/e2e/ui.e2e.ts next to the existing Run details assertions around lines 975-983.

1. Use a fresh browser context with localStorage cleared.
2. Open the composer in Agent mode with Claude.
3. Assert the "Permissions" button text matches /Ask for approval/.
4. Expand ".effective-settings > summary" and assert the "Tool permissions" row matches /Ask for supported native requests/ and does not match /Decline/.
5. Send and assert the GET /api/runs/:id result has approvals.tools ===  …

<details><summary>Verifier's independent reproduction</summary>

Reproduced on a fresh fake-mode server: qa-server.sh start v4603-t026 4603 fake, with a new home and port 4603. I used a fresh headless browser with no profile; the localStorage keys interactiveApprovals and trust were both null. The target was a new two-file scratch git repo at .../scratchpad/qa/work/v4603/t02-6/repo, so no user project was involved.

Steps, all done in the UI:
1. Landing composer: Agent mode with Claude Code; the Permissions control showed "Ask for approval" (screenshot shots/v4603-t026/001-home.png).
2. Clicked "Open another repository", typed the path, Go, then Open. In the "Open repository in a project" dialog, clicked Create project.
3. The composer permission label still read "Ask for approval".
4. Opened Run options > Run details. Rows (shots/v4603-t026/002-run-details.png):
   - "Permissions | standard | Application default"
   - "Tool permissions | Decline requests requiring interaction | Application default"
5. Typed a task and clicked Send. Run 2610251907-2b6b020f was created with pattern solo, roles {agent:[claude]}, trust standard, approvals {"plan":false,"tools":true}. localStorage interactiveApprovals was still null afterwards.

So the Run details row says requests will be declined while the run asks for approval. src/engine.ts:2881 turns approvals.tools===true into interactiveApprovals for a local run with no container or trigger, so the run really asks; only the summary is wrong.

Refutation checks:
- docs/security.md:104 and docs/acp-agents.md describe declining as the default only when approvals are not enabled. No doc says Run details should differ from the composer, so this is not by design.
- It does not depend on the reporter's setup: I reproduced it without their pre-seeded localStorage or their trusted-config clone.

Cleanup: the run was deleted through the UI (bulk Delete). Its retained worktree and branch were in my own scratch repo, which I removed. Server v4603-t026 is stopped. Nothing is left behind.

</details>

### t03-6 · minor · Run details 'Tool permissions' row contradicts the permission menu and what the run gets

**Fix outcome: duplicate.** Same root cause and fix as t02-6 (EffectiveSettings now shows the composer's derived value). Case B also depends on the derived value treating Safe as unavailable, so the explicit choice is kept but not sent.

Fixer's check: Case A is covered by t02-6. Case B on f08: chose Ask for approval (interactiveApprovals=1), then Settings → Run defults → Agent permissions = Safe, then opened a project composer with no saved draft. Chip 'Safe' with Safe ticked; Run details 'Decline requests requiring interaction | Safe permissions'; Send gives trust=safe, tools=false, and the run has toolApprovals=false. The row used to say 'Ask for supported native requests'. (In the project where Ask for approval was picked, its saved draft restores trust=standard. That draft behaviour is pre-existing and not part of this cluster.)

Tests: `test/qa-composer-permission-menu.test.ts`, `test/e2e/qa-composer-permission-menu.e2e.ts`

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-33.

**Repro**

> A) Fresh browser profile > a project's New run (Agent, Claude Code or Codex). The permission menu shows 'Ask for approval'. Open Run options > Run details: 'Tool permissions: Decline requests requiring interaction | Application default'. Start: the run has permissions.toolApprovals = true (run 2610251411-6b488acc).
> B) Choose 'Ask for approval' in the menu, then set Settings > Run defaults > Agent permissions = Safe. Back in the composer the menu shows 'Safe' but Run details says 'Ask for supported native requests | Explicit browser preference'. The run has toolApprovals = false (2610251411-dc75213a).

**Expected:** The row matches the live composer state that is sent with the run.

**Actual:** The row reflects localStorage 'interactiveApprovals', not the live toolApprovals state, so it is wrong in both directions. Templates save toolApprovals from the same localStorage key.

**Root cause (verifier):** EffectiveSettings builds the "Tool permissions" row from a stored browser preference, not from the composer state that is sent with the run.

- **The row:** ui/onboarding.tsx:301 builds the row from `store.get("interactiveApprovals")` (localStorage) for both the value and the source.
- **The live value:** it is React state in ui/composer.tsx:133 (`const [toolApprovals, setToolApprovals] = useState(...)`).
  - The effect at ui/composer.tsx:137-140 turns it on for solo claude/codex when there is no stored preference, and forces it off when `trust.value === "safe"`. Neither path writes the store.
  - ui/composer.tsx:161 re-seeds it on repo change.
- **What is sent:** the start request carries `approvals.tools: remoteWorker ? false : toolApprovals` (ui/composer.tsx:216).
- **The menu label:** it uses `!remoteWorker && !containerEnabled && !externalSource.value && toolApprovals` (ui/composer.tsx:322).
- **The missing link:** the call site at ui/composer.tsx:403 passes EffectiveSettings no toolApprovals at all.

So the row is wrong whenever the default or the Safe override differs from the stored key:
- In case A the store is null, so the row says Decline while the run asks for approval. …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** 1. **Compute one effective value in composer.tsx** and use it everywhere: `const effectiveToolApprovals = !remoteWorker && !containerEnabled && !externalSource.value && toolApprovals`. Use it for the PermissionMenu (lines 322 and 329), the start body (line 216), and a new `toolApprovals` prop on `<EffectiveSettings>` (line 403).

2. **In EffectiveSettings (onboarding.tsx:301)**, render the value from that prop. Derive the Source column from why the value is what it is:
   - "Safe permissions (interactive approvals off)" when `trust.value === "safe"`.
   - "Not available for remote workers / Docker isolation / external sources" when one of those forces it off.
   - "Explicit browser preference" when `store.get("interactiveApprovals") !== null`.
   - Otherwise "Agent default (Claude/Codex conversations ask)".

3. **Fix currentConfig() (onboarding.tsx:70)** so templates and presets save the live value: read `composerRunOptions.value.toolApprovals`, falling back to the store, or take it as …

**Suggested regression test:** Extend the fresh-composer block in test/e2e/ui.e2e.ts (around lines 975-983, which already opens `.effective-settings` and asserts the "Verification gates" and "Agent container" rows) with these steps:
1. In a fresh context, open a solo Claude composer and assert the Permissions button text is "Ask for approval". Assert the "Tool permissions" row (`.effective-settings tr` with rowheader "Tool permissions") matches /Ask for supported native requests/.
2. Choose Ask for approval, then set Settings …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4645 on port 4645, with a fresh home. I made a scratch clone of MQTT-MCP (bare repo plus a working clone under scratchpad/qa/clones/v4645-mqtt) and added it as project "v4645 MQTT" through the UI ("Open another repository" > Create project). Then I drove a fresh headless Chrome with no profile and empty localStorage. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4645/r1.mjs. Output: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4645/r1.log.

A) Fresh profile, opening #/project/<id>/new with the default Agent workflow (agent: claude):
- localStorage was {}.
- The Permissions menu button read "Ask for approval".
- Run options > Run details showed "Tool permissions | Decline requests requiring interaction | Application default".
- I started the run (2610251813-a88b40ad). The API returned permissions.toolApprovals = true and approvals.tools = true, so the row was wrong.

B) In the composer I chose Permissions > "Ask for approval", which set localStorage interactiveApprovals = "1". In Settings > Run defaults I set #settings-trust to safe, then went back to the composer:
- The menu read "Safe" and the Permissions row read "safe | Explicit browser preference".
- The Tool permissions row read "Ask for supported native requests | Explicit browser preference / selected preset".
- I started the run (2610251813-7bde5abb). The API returned toolApprovals = false and approvals.tools = false, so the row was wrong again.

Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4645/001-A-fresh-run-details.png and 002-B-safe-run-details.png. There were no console or 5xx errors.

Attempts to refute it:
- The tester's environment is not the cause. My setup was independent: my own project and clone, and a fresh browser.
- It is not by design. docs/application-improvements.md item 7 ("Effective settings and provenance inspection") and the panel subtitle "Values and where they came from" both say the table should show the values the run will use. No doc or code comment says this row should show the stored browser preference instead of the live value.

Cleanup:
- Deleted both runs through the UI (bulk select > Delete, total went 2 -> 0).
- Stopped server v4645.
- Removed both scratch clones, which also …

</details>

### S02-3 · minor · The Run details 'Tool permissions' row and currentConfig read localStorage interactiveApprovals instead of the composer's live toolApprovals state. A fresh Agent draft with Claude or Codex defaults to 'Ask for approval', but Run details shows 'Decline requests requiring interaction' and saved templates record toolApprovals=false.

**Fix outcome: duplicate.** Fixed by t02-6: the Run details row and currentConfig/SaveTaskTemplateDialog use the composer's live value.

Fixer's check: See t02-6: in a fresh browser the Run details row says Ask for supported native requests, and 'Save as template…' stored config.toolApprovals=true (QA script r1b and e2e test 'a fresh Claude conversation asks, and Run details and a saved template say so').

Tests: `test/e2e/qa-composer-permission-menu.e2e.ts`

Source: code-level suspect at `ui/onboarding.tsx:301` (confirmed hands-on).

**Repro**

> Fake QA server s02 with a fresh browser profile (no interactiveApprovals key). New run, Agent + Claude Code: the composer trigger reads 'Ask for approval'. Under Edit run options > Run details, the 'Tool permissions' row reads 'Decline requests requiring interaction | Application default' (shots/s02/001-s3-run-details.png). Sending the task POSTs approvals {plan:false, tools:true}, and the server run has permissions.toolApprovals=true (run 2610251725-76cb2fae). Save as template… in that state stores config.toolApprovals=false (template T0-fresh). Scripts: work/s02/s3-rundetails.mjs and s2-template.mjs.

**Expected:** Run details shows what the run will actually use ('Ask for supported native requests', with a source such as 'Agent default for Claude/Codex'), and saved templates record the live value.

**Actual:** Run details reports the opposite of what the run is started with, and the template snapshot records toolApprovals=false.

**Root cause (verifier):** Composer keeps toolApprovals in local state and defaults it to true for solo Claude/Codex when the store key is null (composer.tsx:133-140). EffectiveSettings (onboarding.tsx:301) and currentConfig (line 70) instead read store.get('interactiveApprovals') === '1', which is null until the user explicitly picks an option.

**Suggested fix:** Pass toolApprovals (plus whether it is the default) into EffectiveSettings as a prop, as verificationProfile and container already are, and into SaveTaskTemplateDialog/currentConfig (for example currentConfig(p, toolApprovals)). Label the source 'Agent default (Claude/Codex)' when the store key is null.

**Suggested regression test:** Browser test with an empty localStorage: Agent + Claude, open Run details and assert the Tool permissions row says 'Ask for supported native requests'. Save a template and assert composerLibrary config.toolApprovals === true. Also assert the row flips after choosing 'Approve for me'.

### t20-13 · minor · Composer keeps 'Ask for approval' when Antigravity is selected, then Start fails with a misleading error

**Fix outcome: fixed.** toolApprovalState() treats a run where no role can ask (every role Antigravity, or a solo agy agent) as approvals-unavailable. The chip shows the level actually sent ('Approve for me'), the request sends tools=false, and the explicit choice is kept and comes back when a provider that asks returns. A mix of agy and Claude/Codex is a conflict, and Start explains it (see t10-8). The team PermissionMenu's approvalsAvailable now counts claude and auto as able to ask (it used to count only codex/acp). The 'Ask for approval' item is never ticked while disabled. The server message comes from AGY_APPROVALS_PROBLEM (see t10-8).

Fixer's check: Real-mode f08b (real agy) with POST intercepted: Fix & review with explicit Ask for approval. Builder=Antigravity gives a conflict problem naming Builder, with Start disabled. Builder and Reviewer both Antigravity: chip 'Approve for me', Start enabled, intercepted body {approvals:{tools:false}, roles:{builder:[agy],reviewer:[agy]}}. Previously this sent tools=true and got the Keychain/executor 400. Switching Builder back to Codex on fake f08 brought back 'Ask for approval' plus the Reviewer conflict. A direct API POST with fix-review agy+agy and tools=true now returns the approvals-specific 400. Browser errors [].

Tests: `test/qa-composer-permission-menu.test.ts`, `test/e2e/qa-composer-permission-menu.e2e.ts`

Source: tester unit github-codehosts-imports-2; observed with real-agents; features GH-24, GH-25.

**Repro**

> 1. Fresh real-mode server. Connections → GitHub issue → 'Start task from issue' (Fix & review). 2. Set Builder and Reviewer providers to Antigravity CLI (permission shows 'Ask for approval'). 3. Start run.

**Expected:** The composer switches permission to a mode agy supports, or warns before Start.

**Actual:** POST /api/runs returns 400 'Antigravity managed execution requires the verified local macOS executor and existing Keychain login. Remote/container execution and interactive approvals are unsupported…' (request approvals.tools:true). The permission menu shows 'Ask for approval' ticked but disabled ('Requires a local Claude, Codex or ACP provider'). After switching to 'Approve for me' the run started (2610251659-78148af0).

**Root cause (verifier):** This is a UI problem, plus a server message that lumps several causes together.

UI:
- ui/composer.tsx:329, the non-solo PermissionMenu: it is given `tools: !remoteWorker && !containerEnabled && !externalSource && toolApprovals`, ignoring whether the selected roles can ask for approval. `approvalsAvailable` there is `Object.values(roles).flat().some(id => id === "codex" || id.startsWith("acp:"))`. It only disables the item; nothing clears or downgrades `toolApprovals` when roles change.
  - That check uses `some` rather than `every`. By code reading (I did not run it), a mixed Codex + Antigravity selection still offers "Ask for approval" and would also get a 400.
  - It also leaves out "claude", so Claude-only roles show the option disabled even though the server accepts Claude approvals.
- ui/composer.tsx:971: the Team role pills call `setRoles` with no permission reconciliation. Compare ui/chat-controls.tsx:37, where the solo provider switch resets `tools` to false for agy.
- ui/composer.tsx:216: runBody sends `approvals.tools: remoteWorker ? false : toolApprovals`, so the stale `true` reaches the server.
- ui/composer.tsx:544-572: `startProblem` has no check for agy combined wit …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-permissions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-permissions.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** 1) ui/composer.tsx: compute one `approvalsSupported` value:
   - `!remoteWorker && !containerEnabled && !externalSource.value`, and
   - every explicitly chosen role provider is claude, codex or acp:* (ignore "auto", which the server already resolves away from agy when tools are on), with at least one such provider.
   Derive `effectiveTools = toolApprovals && approvalsSupported`, and use it in three places:
   - the PermissionMenu `permissions.tools` (line 329), with `approvalsAvailable={approvalsSupported}`, so the chip shows the mode that will actually apply ("Approve for me"). Keep the user's stored preference so switching back to Codex restores it.
   - runBody `approvals.tools` (line 216), so a stale `true` is never sent.
   - `TaskTeamControl`, where it applies.
   Alternatively, or as well, add a `startProblem` entry so Start is disabled with an explicit reason: "Antigravity can't ask for approval. Choose Approve for me or Full access, or use Claude/Codex."
2) ui/chat-controls. …

**Suggested regression test:** 1) test/run-permissions.test.ts, next to line 39: assert that `resolveRunPermissions({ policy: createRunPermissions("standard", true, false), provider: "agy", mode: "write", currentTrust: "standard", currentTools: true })` throws a message matching /approval/i that does not match /Keychain|macOS executor/. Keep a separate assertion that `remote: true` still yields `AGY_MANAGED_PERMISSION_PROBLEM`.

2) test/e2e/ui.e2e.ts (fake mode):
   - Open the composer and choose Fix & review. With Builder=Co …

<details><summary>Verifier's independent reproduction</summary>

I ran an isolated server v4669 on 127.0.0.1:4669 against a scratch clone of MQTT-MCP (clones/v4669-mqtt, whose origin is a local bare repo) with a seeded fake-gh issue #12. Driven with Playwright in work/v4669/r1.mjs and r3-errpos.mjs.

1) Fake mode first (r1.log): project created through "Open another repository", then GitHub connected through the wizard, then issue #12 → "Start task from issue". The composer opened on the fix-review workflow with Builder=Codex and Reviewer=Claude. In this fresh profile the chip showed "Full access", not "Ask for approval", so the stale selection needs the user (or a saved preference) to have picked "Ask for approval" earlier. Setting both roles to Antigravity gave a 400 from agy's isolation preflight ("Isolated Antigravity requires macOS, CLI 1.4.4…"): the fake agy binary isn't a verified version, so fake mode can't reach the reported path.

2) Real mode with only gh faked (my ghbin first on PATH, FAKE_GH_STATE exported, real agy 1.4.7), new browser profile v4669-real (r2.log). Same flow. With the default roles the Permissions menu offered "Ask for approval" enabled, and I picked it, so the chip read "Ask for approval". Then I set Builder and Reviewer to Antigravity CLI only:
- The chip still read "Ask for approval".
- In the menu, "Ask for approval" was ticked but disabled ("Requires a local Claude, Codex or ACP provider with approval support.").
- "Start run" was enabled with title "Start run (⌘↵)".
- Clicking it sent POST /api/runs with {pattern:"fix-review", trust:"standard", approvals:{plan:false, tools:true}, roles:{builder:["agy"], reviewer:["agy"]}} and got 400: "Antigravity managed execution requires the verified local macOS executor and existing Keychain login. Remote/container execution and interactive approvals are unsupported. Choose Claude or Codex for other environments."
- With Run options expanded, the error rendered below the fold, so no feedback was visible in the viewport (shots/v4669/002-after-start-error.png).

3) Second reproduction (r3.log): I reloaded the persisted draft and clicked Start run again. Same 400 and same message, this time rendered under "Run options" (shots/v4669/001-errpos-viewport.png). The menu state with Antigravity selected is in shots/v4669/001-perm-menu-agy.png.

No run was created either time (/api/runs total 0). I did not repeat the reporter's "switch to Approve for me" step because it would launch a real agy run. The reporter's run 2610251659-78148af0 already shows it, and …

</details>
