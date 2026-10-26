# Cluster 07 · agy-unrestricted

**Antigravity unrestricted opt-in persistence, fork-chat permission inheritance, agy isolation**

Status: **merged · verified · repair round 1 merged into continuation · fresh re-verification passed** · 8 issues · branch `qa-fix/agy-unrestricted` (+ `qa-fix/agy-unrestricted-r1`)

Planner notes: t04-1/t05-2/t06-5: the 'Use unrestricted Antigravity' choice is meant for one run. It is seeded from the sticky composerRunOptions (ui/composer.tsx:131, ui/state.ts) and never cleared after a start, and the composer and run page keep showing 'Approve for me'. Clear it after each start and show an unrestricted indicator on the run page; t05-2 has the best repro. t04-10: the Fork chat dialog (ConversationBar in ui/run.tsx ~1944, the server fork route, the engine) passes no permission, so the fork inherits the source run's highest level (Full access). Give the fork explicit permissions. t04-9: src/adapters/agy.ts:290 always says to check the login. t05-10: the doctor's managedCompatible:false never reaches the composer's start check. t05-5: the CODEFLOW_AGY_SKIP_PERMISSIONS docs and diagnostics are stale. t05-13: agy-isolation.ts grants read access to the worktree's .git pointer file. Coordinate with composer-permission-menu, which owns the PermissionMenu and toolApprovals defaults. Duplicate groups: [["t04-1","t05-2","t06-5"]]

Likely files: `ui/composer.tsx`, `ui/state.ts`, `ui/run.tsx`, `ui/chat-controls.tsx`, `src/adapters/agy.ts`, `src/adapters/agy-isolation.ts`, `src/doctor.ts`, `src/server.ts`, `src/engine.ts`, `ui/dependency-health.tsx`

## Fix result

Commits:
- `2b909d6` Keep unrestricted Antigravity to the run it was chosen for
- `acca16d` Let Fork chat show and choose the new chat's permissions
- `63407ae` Say before Send when Antigravity can't run isolated
- `65aa860` Give unrestricted Antigravity failures advice for their kind
- `f800d90` Scope CODEFLOW_AGY_SKIP_PERMISSIONS to legacy Antigravity calls in the docs
- `331fddf` Deny reading Git metadata in the isolated Antigravity profile
- `7091ae2` Cover the unrestricted Antigravity QA regressions

Fixer notes for the integrator: Based on f14f404. A trial `git merge-tree` against the current claude/dogfood-qa-2026-10-25 merges cleanly. Against the unmerged sibling branches there is one expected conflict: qa-fix/approvals-inbox in docs/security.md Caveats. I edit the 'agy permissions' bullet and they edit the next line, the 'Native permission requests' bullet. Keep both edits. I moved my one CSS rule so it no longer conflicts with qa-fix/run-worktree-lifecycle. composer-permission-menu merges cleanly; I only added an optional `unrestricted` prop to ChatControls/PermissionMenu and did not touch toolApprovals defaults. Existing test changed on purpose: test/health-routing.test.ts. The doctor now adds one warning to agy when isolated Antigravity is unavailable (fake agy 1.3.6, and every non-macOS host), so that assertion now expects exactly that warning for agy. Behaviour changes to know about: (1) The composer disables Send for an Antigravity run that would be isolated when the doctor reports managedCompatible:false, so e2e tests that pick fake agy without the unrestricted opt-in now see Send disabled instead of a 400. The existing suites I ran are unaffected. (2) POST /runs/:id/provider-chat accepts optional trust/tools and refuses a raise above the source (400). (3) The isolated agy kernel profile now denies reading .git contents; verified with one real agy 1.4.7 run. ui/run.tsx imports narrowerTrust from src/run-permissions.ts, which has only type imports, so it is safe in the browser. public/ is giti …

## Independent verification

- **t04-1: verified** — Fake QA server v07 on port 4381, built from de53b25. Scratch repo project AgyScratch. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/agy-unrestricted/ (s1-s4, s9) and screenshots in .../qa/shots/v07/.
(1) Original repro in the UI. Provider Antigravity CLI, Permissions Approve for me, Advanced, ticked the opt-in. The help now reads 'Opt-in for this run; the next run starts isolated again'. Collapsed the panels:
- The composer bar reads '... Unrestricted' and the summary row reads 'Unrestricted Antigravity · no Code Flow sandbox'.
- The permission menu shows the unrestricted note.
- Sent: POST antigravity …
- **t04-10: verified** — UI (s5-fork.mjs, s9-narrow.mjs), fake server.
Codex chat 2610260325-2ca87a4a at Approve for me, then one reply with Full access. Receipts: codex:standard/provider-sandbox, then codex:full/none. After a reload the source pill reads Full access.
(A) Original flow: reply-box Provider → Claude Code opened Fork chat.
- The dialog now has a Permissions control reading 'Full access', the text 'The new chat runs with the permissions chosen below', and the 'Full access: no sandbox' warning.
- Lowered it to Approve for me; the warning disappeared and Send POSTed {trust:standard, tools:false}.
- Child 2610260325-518ce38a: trust standard, permissions.trust standard, receipt claude:standard/tool-rules. I …
- **t04-9: verified** — Restarted the fake server with FAKE_AGY_STATUS=RESOURCE_EXHAUSTED, FAKE_AGY_ERROR='Resource has been exhausted (e.g. check quota).' and CODEFLOW_RETRY_DELAYS_MS=1000,2000.
Ran the original repro in the UI (s8-ratelimit.mjs): Fix & review, Builder = Antigravity CLI only, Reviewer = Codex, unrestricted ticked, check 'true'. POST native.
Run 2610260329-e2905ae5 failed:
- Run error and banner: 'Fix the issue (agy) failed: Unrestricted Antigravity hit a rate limit (too many requests in a short time).'
- Step error: the same text.
- Retry status lines in the jsonl: 'Antigravity CLI failed (Unrestricted Antigravity hit a rate limit (too many requests in a short time).); trying again in 1s/2s'.
No l …
- **t05-10: verified** — Fake agy 1.3.6. /api/doctor returns agy managedCompatible:false with the new warning 'Runs use isolated Antigravity by default, which isn't available here. Isolated Antigravity requires macOS, CLI 1.4.4…1.4.7… To run it anyway, turn on Run options → Advanced → Use unrestricted Antigravity…'.
In the UI (s6-health.mjs):
- Settings → Agents & models → Check this computer → Check all dependencies. The agy row has the warn badge 'Unrestricted only' plus the warning; Claude and Codex are Ready; the summary still reads 'Core tools are ready.'
- The Health & usage dialog shows the warning under Antigravity CLI.
- Composer, Antigravity CLI plus a task: Send is disabled. Its title and the summary-row  …
- **t05-5: verified** — This was a docs and diagnostics fix; runtime behaviour is unchanged by design. I restarted the fake server with CODEFLOW_AGY_SKIP_PERMISSIONS=0 and FAKE_RECORD_DIR, and confirmed both in the process environment.
- Native agy run 2610260327-a30bb5b8, started from the UI: recorded args include --dangerously-skip-permissions and no --sandbox.
- Improve, with Settings → Prompt improvement agent = Antigravity (s7-improve.mjs): 200, and the recorded args have --sandbox and no --dangerously-skip-permissions, so the legacy path honours =0.
This matches the new text:
- docs/configuration.md:122 limits the variable to legacy calls; runs ignore it.
- The docs/security.md table and caveats describe isol …
- **t05-13: verified** — (1) Ran test/qa-agy-unrestricted.test.ts on macOS: the kernel test passes in read and write modes. It covers the .git pointer and nested .git being unreadable, `[ -f .git ]` still working, .gitignore and README readable, and append to .git denied.
(2) Checked that the test catches a regression: I temporarily restored the old rule `(deny file-write* …[.]git…)` in my verify worktree. The test then fails with 'exit 54' (.git pointer readable). I reverted with git checkout.
(3) One real run, the original repro: v07 restarted in real mode (agy 1.4.7, managedCompatible true). Solo Antigravity CLI, Gemini 3.8 Flash (Low), Approve for me, opt-in unchecked (POST isolated). The task asked it to view R …

Code-review findings:
- [minor] `ui/settings.tsx:127` The fixer says the new doctor warning reaches 'Check this computer, the settings card and Health & usage'. The per-agent settings card renders only `status.fix`, never `status.warnings`. For agy 1.3.6 it still shows a green 'Signed in' badge with no word that isolated runs can't start (seen in the UI: card text 'Antigravity CLI Signed in 1.3.6 …'). Only Check this computer and the Health dialog show it.
- [nit] `ui/composer.tsx:584` startProblem() now checks `composerRunOptions.value.antigravityExecution`, but it is also called from ui/sweeps.tsx:122 (and ui/insights.tsx). Sweeps never send antigravityExecution and run unattended, so they are always isolated. If the composer's opt-in box happens to be ticked, a sweep with an agy role passes this check and is rejected only by the server after submit. This is not a regression, since there was no check before; it is a caller the fix missed.
- [nit] `ui/composer.tsx:337` For non-solo templates, the PermissionMenu is not passed `unrestricted`. In Fix & review with an agy builder and the opt-in ticked, it still reads 'Approve for me' (observed); only the summary-row warning signals unrestricted mode. This is arguably acceptable for mixed providers, but it is the label the original report complained about.
- [nit] `src/adapters/agy.ts:343` rate_limit and transient (line 345) messages state the kind but give no next step. After the engine's retries run out, the run banner reads 'Fix the issue (agy) failed: Unrestricted Antigravity hit a rate limit (too many requests in a short time).' with no 'wait and resume' advice, which the issue's expected result asked for. It is still correct and no longer misleading.
- [nit] `src/doctor.ts:128` The warning embeds managedAvailability()'s text 'No permissive fallback is available.' and then says 'To run it anyway, turn on … Use unrestricted Antigravity'. That pair reads as self-contradictory; it appears verbatim in Check this computer and Health.
- [nit] `ui/chat-controls.tsx:72` In the Fork chat dialog, when the source chat has no tool approvals, 'Ask for approval' is disabled with the sub-text 'Requires a local Claude, Codex or ACP provider with approval support.' even when Claude or Codex is selected. The real reason, that the source chat doesn't ask for approval (approvalsAvailable at ui/run.tsx:2390), is not stated.
- [nit] `src/adapters/agy-isolation.ts:147` The isolated profile now denies reading .git contents, but the executor version (AGY_ISOLATION_VERSION at :15) and the receipt implementation id are unchanged. Step receipts therefore can't tell runs made under the old profile (.git pointer readable) from runs made under the new one. The fixer chose this on purpose; it is noted only for audit traceability.

Repair round 1: 1 commit(s), items review-1:fixed; merged: no

## Issues

### t04-1 · major · 'Use unrestricted Antigravity' opt-in silently persists into later runs (incl. Auto picks); UI shows 'Approve for me' while runs execute with trust full / no sandbox

**Fix outcome: fixed.** Root cause: the opt-in lived in the sticky composerRunOptions and the project draft, and resetComposer never cleared it, so saveComposerDraft() saved "native" after Send. Fixes: (1) resetComposer at ui/composer.tsx:275 calls setNativeAntigravity(false) and writes antigravityExecution:"isolated" straight into composerRunOptions. The write is synchronous because the draft is saved before the composer renders again. Unsent drafts and Edit & run again still restore the mode. (2) While the opt-in is on, the composer summary row shows the warning "Unrestricted Antigravity · no Code Flow sandbox" (composer.tsx:349). (3) PermissionMenu takes an `unrestricted` prop (ui/chat-controls.tsx:64): the label reads "Unrestricted" in the full-access style, with a note inside the menu. The composer passes it for solo agy (composer.tsx:329) and so does the run reply bar (ui/run.tsx:2001). (4) The run header …

Fixer's check: Fresh fake QA server f07 (4377) started from the worktree, with a scratch git repo registered as a project. Script work/agy-unrestricted/r1-native-once.mjs follows the tester's steps with a fresh browser profile. After choosing Provider Antigravity CLI and ticking the checkbox, the summary read "Unrestricted Antigravity · no Code Flow sandbox" and the permission control read "Unrestricted". Run A POSTed native and recorded permissions.antigravityExecution native. Its run header showed the "Unrestricted Antigravity" badge and its reply box read "Unrestricted". After New run: no warning in the summary, permission "Approve for me", checkbox unchecked. Run B POSTed "isolated" and recorded antigr …

Tests: `test/e2e/qa-agy-unrestricted.e2e.ts: unrestricted Antigravity applies only to the run it was ticked for and is visible while it's on`

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-12, SOL-11.

**Repro**

> 1. qa-server.sh start X <port> fake; open http://127.0.0.1:<port>/?token=qa-X-token; add a scratch repo via 'Open another repository' (Create project).
> 2. Composer (Agent mode): Provider → Antigravity CLI; Permissions → Approve for me.
> 3. Expand Run options → Advanced → tick 'Use unrestricted Antigravity with my existing login' (help text: 'Opt-in for this run'). Collapse the panels, type a task, Send. Run finishes.
> 4. Click 'New run' (or reload the page). The composer bar shows 'Antigravity CLI · Default model · Default effort · Approve for me'; the summary row (Computer/Project/Repository/Limit) says nothing about unrestricted execution.
> 5. Type a second task and Send.
> 6. GET /api/runs/<second id> → permissions.antigravityExecution = 'native'.
> Variant: with the flag left on, Advanced → 'Fix & review' with Builder/Reviewer = Auto → Auto picks Antigravity and runs it native.

**Expected:** The opt-in applies to the run it was ticked for (as the help text says) or, if sticky, is clearly visible next to the provider/permission controls; subsequent runs and Auto picks default to isolated execution.

**Actual:** Second run (no toggle touched) ran native: t04f 2610251426-ccdd616b and 2610251426-3b1e197e both antigravityExecution native. On t04b four Auto-routed fix-review runs (2610251416-6a2dce91, -f0f9ff6a, 2610251418-8ea8366c, 2610251419-fd63e035) ran Antigravity native although Antigravity was chosen by Auto. Real run 2610251427-c65bce0a: step receipt trust 'full', isolation 'none', implementation agy-native-v1, while composer and reply box display 'Approve for me'. Screenshots: shots/t04f/002-native-second-no-toggle.png, shots/t04b/001-auto-setup-allout.png, shots/t04/002-r5-agy-done.png.

**Root cause (verifier):** A run-scoped permission widening is stored in the sticky composer run options and is never cleared after a run starts.

**What persists it**
- ui/composer.tsx:131 seeds `nativeAntigravity` from `composerRunOptions.value.antigravityExecution` every time Composer mounts.
- ui/composer.tsx:172-174 writes it back as `antigravityExecution: nativeAntigravity ? "native" : "isolated"`.
- ui/state.ts:1205 (`composerSnapshot().runOptions`) includes it in the project draft. `saveComposerDraft()`, called right after start at composer.tsx:251, writes that draft to IndexedDB (ui/project-context.ts:25). ui/state.ts:1240 restores it on reload.
- `resetComposer` (ui/composer.tsx:259-272), called after a successful start at :250, clears task, context, limits and source but not `nativeAntigravity` or `composerRunOptions.antigravityExecution`. The next "New run" mount re-reads "native".

**Why this is not by design**
- Docs only intend unsent drafts and "Edit & run again" to keep the mode: docs/dynamic-teams-implementation-plan.md ("project drafts preserve … the explicit Antigravity mode"), tested in test/project-drafts.test.ts:31-50 and test/e2e/daily-workflow.e2e.ts:433.
- Carrying it into later run …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/daily-workflow.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-drafts.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/auto-team.md`

**Suggested fix:** 1. Scope the opt-in to the run that was started. After a successful start, before `saveComposerDraft()`, set `composerRunOptions.value = { ...composerRunOptions.value, antigravityExecution: "isolated" }` and call `setNativeAntigravity(false)`, inside `resetComposer` or a small exported state.ts helper. The persisted draft is then isolated. Unsent drafts and "Edit & run again" keep the recorded mode as documented, because neither path goes through a successful start. If a sticky design is ever wanted instead, make it an explicit per-project setting.
2. Make it visible whenever it is on:
   - Add a warning chip in `.composer-summary` next to the existing "Full access · no provider sandbox", e.g. "Unrestricted Antigravity · no sandbox", linking to Advanced.
   - In ChatControls/PermissionMenu, when the provider is agy (or agy is in the roles/pool) and native is on, show something like "Unrestricted (Antigravity)" instead of plain "Approve for me".
   - In chat runs, show the run-permissio …

**Suggested regression test:** Add an e2e test in test/e2e/daily-workflow.e2e.ts (fake agents): "unrestricted Antigravity applies only to the run it was ticked for".
1. Choose Antigravity CLI and Approve for me, tick the checkbox, and assert `.composer-summary` contains "Unrestricted Antigravity".
2. Send, and assert the intercepted POST /api/runs body has antigravityExecution "native".
3. Click New run, open Run options → Advanced, and assert the checkbox is unchecked.
4. Send a second task. Assert the POST body has antigrav …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server (`qa-server.sh start v4667 4667 fake`, home homes/v4667) and a persistent browser profile "v4667". The scratch repo was a new `git init` at clones/v4667-scratch, added through the UI ("Open another repository", Use, "Create project"). Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4667/ (01-06 *.mjs, logs *.log).

1. 02-first-run.mjs: Provider → Antigravity CLI, Permissions → Approve for me. Edit run options → Advanced → ticked "Use unrestricted Antigravity with my existing login". Collapsed both panels and sent. The POST /api/runs body had antigravityExecution "native", trust "standard". Run 2610251823-10ea0116 finished with permissions.antigravityExecution "native" and step receipts trust full, isolation none, agy-native-v1. This run is the intended opt-in.
2. 03-second-run.mjs: clicked "New run" in the sidebar and changed nothing.
   - The composer bar read "Antigravity CLI · Default model · Default effort · Approve for me".
   - The summary row read "Computer · Project · Repository · Limit" with no warning.
   - The Advanced summary that carries " · Unrestricted Antigravity" is inside the collapsed Run options, so it is not visible (shots/v4667/001-newrun-composer.png).
   - Sending a second task POSTed antigravityExecution "native". Run 2610251824-4dff650f has permissions.antigravityExecution "native".
3. 03-second-run.mjs reload: after page.reload() and New run, the result was the same. Run 2610251824-bb6aa3f0 ran native; the setting persists through the per-project IndexedDB draft.
4. Auto variant (04-auto.mjs):
   - With no history, Auto picked Claude for both roles (run 2610251825-6765160b), but that run's policy was still native.
   - I then seeded my own QA home's quota.json with Claude and Codex "limited" and restarted my server. I opened New run, chose Advanced → Fix & review, set Builder and Reviewer to Auto, and left the checkbox untouched; it was still checked.
   - Run 2610251826-5a479cad: "Auto picked Antigravity CLI for builder/reviewer (Claude Code hit its usage limit)". Roles were agy/agy, policy native, and all four agy step receipts were trust full, isolation none, agy-native-v1. The composer bar and the run's reply box both showed "Approve for me".
   - Control run 2610251827-53d81cd4: same setup with the box unticked. It POSTed "isolated" and Auto stayed on Claude, because fake agy 1.3.6 is not isolated-elig …

</details>

### t05-2 · major · 'Use unrestricted Antigravity' silently persists to later runs, and the composer and run page keep showing 'Approve for me' with no unrestricted indicator

**Fix outcome: duplicate.** Same root cause and fix as t04-1, which carries it: reset after start (ui/composer.tsx:275), summary warning, "Unrestricted" permission label in the composer and the reply bar, and the run header badge.

Fixer's check: Covered by the t04-1 repro (r1-native-once.mjs on f07): the second run POSTed "isolated". The run page and reply bar showed "Unrestricted Antigravity" / "Unrestricted" rather than "Approve for me" for the native run. No browser errors.

Tests: `test/e2e/qa-agy-unrestricted.e2e.ts: unrestricted Antigravity applies only to the run it was ticked for and is visible while it's on`

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOLO-GAP-03.

**Repro**

> 1. On a QA server, open the composer and choose Provider 'Antigravity CLI' (Permissions shows 'Approve for me').
> 2. Expand 'Run options' → 'Advanced' and tick 'Use unrestricted Antigravity with my existing login'. The help text says 'Opt-in for this run.'
> 3. Send a task. The run page header and reply bar show 'Approve for me', with no 'Unrestricted' badge. GET /api/runs/<id> shows trust:'standard', permissions.antigravityExecution:'native', and the CLI gets --dangerously-skip-permissions with no --sandbox.
> 4. Open a new composer (or reload). Run options is collapsed and the bar shows 'Antigravity CLI · Approve for me'. Type a task and Send without touching Advanced.
> 5. The new run is native (unrestricted) again: permissions.antigravityExecution:'native'.

**Expected:** The unrestricted opt-in applies only to the run it was chosen for, as the help text says, or the persistent choice is shown prominently. Composer and run page should show that Antigravity runs unrestricted, e.g. 'Full access · Unrestricted Antigravity', never 'Approve for me — Restricted actions are blocked'.

**Actual:** The choice persists in composerRunOptions and the project draft. Later Antigravity runs execute natively with --dangerously-skip-permissions and no Code Flow sandbox. The visible permission label says 'Approve for me'. The only hint is 'Advanced · Unrestricted Antigravity' inside the collapsed Run options.

**Root cause (verifier):** Two client-side defects. The server records and enforces the policy correctly: src/engine.ts:5215 records it, and src/adapters/agy.ts:83 plus :108-118 skip --sandbox and add --dangerously-skip-permissions for the agy-native-v1 receipt.

(1) The choice silently carries over after Send.
- ui/composer.tsx:131 seeds `nativeAntigravity` from `composerRunOptions.value.antigravityExecution`.
- ui/composer.tsx:172-174 writes it back into `composerRunOptions`. That object is part of the per-project draft snapshot: `runOptions: composerRunOptions.value` at ui/state.ts:1205, restored at ui/state.ts:1240, so it survives reloads.
- After a successful start, `resetComposer()` (ui/composer.tsx:259-273) clears task, limits, criteria and source but never resets `nativeAntigravity`.
- The next run therefore sends `antigravityExecution: "native"` (ui/composer.tsx:219).
- This contradicts the checkbox help at ui/composer.tsx:389 ("Opt-in for this run") and docs/auto-team.md:143, which describes it as an explicit opt-in for a new local attended run.

(2) No unrestricted indicator anywhere the user looks.
- ui/chat-controls.tsx:61 builds the permission label only from `{trust, tools}` and ignores antigr …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/daily-workflow.e2e.ts`

**Suggested fix:** 1. Make the opt-in per run, as the UI promises. In `resetComposer()` (ui/composer.tsx:259), call `setNativeAntigravity(false)`. The useLayoutEffect at :172 then writes antigravityExecution:"isolated" into composerRunOptions, and the following `saveComposerDraft()` persists that. Keep unsent-draft persistence and the Edit & run again restore unchanged.
   - Alternative, if the product wants it sticky: change the help text to say so, and make the indicator below always visible.
2. Composer indicator.
   - Pass an `unrestricted` flag into ChatControls/PermissionMenu (ui/chat-controls.tsx), true when `nativeAntigravity` is set and agent === "agy". Have the trigger read e.g. "Full access · Unrestricted Antigravity" with the full-access style, and replace the "Restricted actions are blocked" sub-text.
   - Add a summary-row warning next to the existing trust==="full" span: `{nativeAntigravity ? <span class="warn">Unrestricted Antigravity · no Code Flow sandbox</span> : null}`. Show it whenev …

**Suggested regression test:** Extend test/e2e/daily-workflow.e2e.ts (fake agy) with a test named "unrestricted Antigravity applies to one run and is always visible":
- Choose Antigravity CLI, tick "Use unrestricted Antigravity with my existing login", and assert the composer permission trigger and the summary row show "Unrestricted Antigravity", not "Approve for me".
- Send, capture the POST /api/runs body and assert antigravityExecution === "native".
- On the run page, assert a visible "Unrestricted Antigravity" badge and t …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server: `qa-server.sh start v4603 4603 fake`, with a new home and a persistent browser profile "v4603". All runs were in project MQTT-MCP (p-ef01794b).
1. s1.mjs: opened #/project/p-ef01794b/new and chose Provider -> Antigravity CLI. The composer bar read "Antigravity CLI | Default model | Default effort | Approve for me".
2. s2.mjs: clicked "Edit run options", opened Advanced and ticked "Use unrestricted Antigravity with my existing login". The help text reads "Opt-in for this run. ...". I sent "v4603 native run A". The POST /api/runs body had antigravityExecution:"native" and trust:"standard". GET /api/runs/2610251757-3e2e9ab3 returned permissions {trust:"standard", antigravityExecution:"native"}. The run jsonl step receipt shows implementation "agy-native-v1", isolation "none", trust "full", commandNetwork "allowed", externalTools "provider-configured".
3. The run page header and reply bar show "Antigravity CLI · Default model · Default effort · Approve for me". Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4603/002-run-page-native.png
4. s4.mjs: reopened run A and force-opened every <details>. The body text has no "Unrestricted" and no "Run permissions". The permission menu shows "Approve for me ✓ – Allow routine edits and commands. Restricted actions are blocked."
5. s3.mjs: a fresh page load, then clicked New run. Run options was collapsed. The bar read "Antigravity CLI ... Approve for me". The summary row had no warning: Computer/Project/Repository/Limit only. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4603/001-next-composer.png. I typed a task and clicked Send without touching Advanced. The POST body again had antigravityExecution:"native", and run 2610251758-1831ab36 recorded permissions.antigravityExecution:"native".

Reproduced once per step, consistent with the reporter's 3 times. This is not an environment or selector artifact: the request body itself carries "native".

Cleanup: I archived both runs with cleanup and deleteBranches. That removed .worktrees/<id>/solo and the codeflow/<id>/solo branches in MQTT-MCP. I then deleted both runs through the sidebar's Select runs -> Delete, and both now return 404. I stopped server v4603. Nothing of mine is left. The codeflow/2610251758-4004a050 and -5636fe5c branches in MQTT-MCP belong to ot …

</details>

### t06-5 · major · 'Use unrestricted Antigravity' opt-in ('for this run') persists to later runs without any visible indication

**Fix outcome: duplicate.** Same root cause and fix as t04-1, which carries it. The summary-line warning sits next to the Full access one at ui/composer.tsx:349, and the opt-in resets after each launch.

Fixer's check: Covered by the t04-1 repro: after the native run, New run with Run options collapsed showed no unrestricted text, the checkbox was unchecked, and the next run was isolated. The checkbox stayed unchecked after a reload.

Tests: `test/e2e/qa-agy-unrestricted.e2e.ts: unrestricted Antigravity applies only to the run it was ticked for and is visible while it's on`

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-15.

**Repro**

> 1. Composer, project t06 Studio, Agent with Antigravity; Run options → Advanced → tick 'Use unrestricted Antigravity with my existing login'; send. 2. Start another Antigravity run in the same project without opening Advanced. 3. GET /api/runs/<id> → permissions.antigravityExecution.

**Expected:** Opt-in applies to that run only (help text: 'Opt-in for this run'), or the composer summary visibly warns like it does for Full access.

**Actual:** Second run AG2 2610251522-dc458e43 ran with antigravityExecution 'native'; a later fix-review run (TP 2610251521-d11b04a4) also shows 'Run permissions · standard · Unrestricted Antigravity'. The composer summary line shows nothing; only the collapsed 'Advanced · Unrestricted Antigravity' label hints at it.

**Root cause (verifier):** The opt-in lives in sticky per-project draft state and is never cleared after a run starts.
- ui/composer.tsx:131 sets nativeAntigravity from composerRunOptions.value.antigravityExecution, which comes from the project draft.
- ui/composer.tsx:173 writes antigravityExecution: nativeAntigravity ? "native" : "isolated" back into composerRunOptions.
- ui/state.ts:1205 (composerSnapshot runOptions) saves composerRunOptions into the IndexedDB project draft, and ui/state.ts:1240 restores it.
- After a successful send, ui/composer.tsx:250 calls resetComposer(). resetComposer (ui/composer.tsx:259-273) clears the task, criteria, source, context, attachments and intent, but not nativeAntigravity or composerRunOptions.antigravityExecution. ui/composer.tsx:251 then calls saveComposerDraft(), which saves "native" into the draft.
- Every later run's body therefore carries it (ui/composer.tsx:219). This happens whatever the provider is, so Claude-only and template runs also record native.
- There is no warning: the summary row at ui/composer.tsx:343 warns only for trust === "full". The only indicator is the Advanced summary label at ui/composer.tsx:378, and that sits inside the collapsed "Run opti …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/daily-workflow.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/auto-team.md`

**Suggested fix:** Make the opt-in apply to one run only, and warn while it is on.
(a) In resetComposer (ui/composer.tsx:259), call setNativeAntigravity(false). Also set composerRunOptions.value = { ...composerRunOptions.value, antigravityExecution: undefined } synchronously. This is needed because saveComposerDraft() runs in the same tick at :251, before the useLayoutEffect at :173 can re-sync, so without it "native" would still be written to the draft. Unsent-draft persistence (project switches) and "Edit & run again" restoration keep working, which keeps project-drafts.test.ts and the retry e2e valid.
(b) Add a summary-line warning next to the Full access one at ui/composer.tsx:343, for example {nativeAntigravity ? <span class="warn">Unrestricted Antigravity · no sandbox</span> : null}. This covers restored drafts and retries, which still pre-check the box.
(c) Optional: only send antigravityExecution "native" when an agy role or pool member is part of the run, so Claude- or Codex-only runs do not rec …

**Suggested regression test:** Add a browser test to test/e2e/daily-workflow.e2e.ts (fake agents): "unrestricted Antigravity applies only to the launched run".
1. Open a project's composer, choose Antigravity, open Run options → Advanced and tick "Use unrestricted Antigravity with my existing login".
2. Assert .composer-summary contains "Unrestricted Antigravity".
3. Send, and assert GET /api/runs/<id1>.permissions.antigravityExecution === "native".
4. Navigate to New run for the same project and assert the checkbox is unchec …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server (qa-server.sh start v4645 4645 fake) with a new browser profile "v4645-t065". The project was "v4645 MQTT", pointing at a scratch clone of MQTT-MCP. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4645/t065-c.mjs, t065-d.mjs and t065-e.mjs; logs are in the matching .log files.
(1) Opened #/project/p-82d2965a/new with AI team Off and Provider Antigravity CLI. Opened Run options → Advanced; the checkbox started unchecked. Ticked "Use unrestricted Antigravity with my existing login" (help text: "Opt-in for this run.") and sent. Run 1 2610251918-aec4fb1d finished done with permissions.antigravityExecution "native", as expected.
(2) Went to New run for the same project with Run options collapsed and typed a task, touching nothing else. The summary line read "Computer This computer · Project v4645 MQTT · Repository v4645-mqtt · main · Limit 200 calls · 240 minutes · Edit run options". No visible text in the composer mentioned "unrestricted" (screenshot shots/v4645/002-t065-c-run2-before-send.png). Only after expanding Run options does the Advanced row read "Advanced · Unrestricted Antigravity", and the checkbox was still checked (003-t065-c-run2-runoptions-open.png). Sending gave run 2 2610251918-73cf3165, with no parentRunId and antigravityExecution "native". The captured POST /api/runs body contained antigravityExecution "native" for both runs.
(3) Closed and reopened the browser with the same profile: the checkbox was still checked, because it is saved in the project draft. For comparison, choosing Full access adds "Full access · no provider sandbox" to the same summary line; native Antigravity adds nothing.
(4) Switched the provider to Claude Code and sent run 3 2610251919-54927207 (roles agent:[claude], no parent). It was also recorded as antigravityExecution "native". This matches the reporter's template run TP, which had parent undefined, so its native setting was not inherited from a parent; it came from the same saved draft.
There were no console or 5xx errors.
I checked whether this is by design and found it is only partly so:
- docs/dynamic-teams-implementation-plan.md:684 and test/project-drafts.test.ts:31-50 intend an UNSENT project draft to keep the native choice when you switch projects.
- "Edit & run again" restores it on purpose from the run record (ui/run.tsx:2286, e2e daily-workflow:433).
- Child runs and continuations i …

</details>

### t04-10 · major · Fork chat dialog hides permissions; the new chat silently inherits Full access escalated by an earlier per-reply choice

**Fix outcome: fixed.** Root cause: no layer passed a permission to the fork, so the engine always used the source run's trust. Fixes: (1) In ui/run.tsx, ConversationBar passes the reply box's selectedPermissions to ProviderChatDialog (run.tsx:1946). The dialog (run.tsx:2360) keeps permission state, clamped to the source's trust. It shows the permission control for tab forks, with the restricted and approvals limits, and shows the Full access warning and the unrestricted Antigravity warning. A choice above the source is explained and Send is disabled. The POST carries trust and tools. (2) src/server.ts:2551-2552 forwards body.trust and body.tools. (3) In src/engine.ts startProviderChat (4180-4190), trust and tools are validated and then applied to start() and to the handoff signature. A higher level, or approvals the source doesn't ask for, is refused with a clear error rather than lowered silently. start()'s p …

Fixer's check: Script r2-fork.mjs on the fresh f07 server. A Codex chat (Approve for me) got one reply with Full access, which raised the source to trust full, rev 2. Reply-box Provider -> Claude Code opened the Fork chat dialog. It now shows the permission control reading "Full access" plus the "Full access: no sandbox" warning. After switching to Approve for me the warning disappeared. The POST had trust standard and tools false. Child 2610260142-331e854c had trust standard, and its step receipt had trust standard and tool-rules. Variant B: with the reply pill set to Approve for me first, the dialog opened at "Approve for me" and the child ran standard. Choosing Full access from a standard chat showed th …

Tests: `test/qa-agy-unrestricted-fork.test.ts: a forked chat runs with the chosen permissions, which may narrow but never raise the source's`, `test/e2e/qa-agy-unrestricted.e2e.ts: Fork chat shows the new chat's permissions, lowers them, and refuses more than the source has`

Source: tester unit solo-runs-providers-1; observed with real-agents; features SOL-04, SOL-05.

**Repro**

> 1. Agent chat with Codex (Approve for me); reply once with Permissions → Full access.
> 2. In the reply box choose Provider → Claude Code → Fork chat dialog (only message/provider/model/effort shown) → Send.
> 3. Inspect the new chat's reply controls and step receipt.

**Expected:** The dialog shows (and lets you change) the permission level the forked chat will run with, especially Full access.

**Actual:** Forked Claude chat 2610251423-e38e3eb4 ran both turns with trust 'full' (no sandbox); only visible after the fact in its reply controls. A single reply's permission choice permanently raises run.permissions/run.trust (engine.ts:3818-3825) and is copied to forks.

**Root cause (verifier):** The forked chat gets no permission input at any layer, so the engine falls back to the source run's maximum:
- ui/run.tsx:1944: ConversationBar renders <ProviderChatDialog .../> without passing selectedPermissions (computed at ui/run.tsx:1830 as replyPermissions ?? lastReply/run trust). The reply box's visible or pending choice is therefore dropped when the provider changes.
- ui/run.tsx:2382: ProviderChatDialog renders ChatControls with permissions={{ trust: run.trust, tools: false }}, onPermissions={() => {}} and showPermissions={false}. The level is hidden and cannot be changed, and there is no Full-access warning (composer.tsx:355 has one for new runs).
- ui/run.tsx:2370: the POST /api/runs/:id/provider-chat body carries only agent, settings, message, kind and attachments, with no trust or tools.
- src/server.ts:2552: the route forwards only those fields to manager.startProviderChat.
- src/engine.ts:4166 (signature has no trust or tools) and engine.ts:4204-4206: start({... trust: run.trust ..., approvals: { tools: !!run.approvals.tools } }) always passes the source's current maximum.
- src/engine.ts:5185: start() would already honour a narrower request through narrowerTrust(par …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/chat-options.test.ts`

**Suggested fix:** 1. UI (ui/run.tsx): pass the reply box's selectedPermissions into ProviderChatDialog as initialPermissions and keep them in dialog state. Render ChatControls with showPermissions (not for side chats, which are read-only) and a real onPermissions. Keep resetPermissionsOnAgentChange={false}, and clamp approvals to providers that support them. When trust is "full", show the same Full-access warning the composer uses (composer.tsx:355). Respect restricted (lockdown/trigger). Send trust and tools in the provider-chat POST body.
2. Server (src/server.ts:2552): read body.trust and body.tools and forward them.
3. Engine (src/engine.ts startProviderChat): accept optional trust and tools, validated like followUp (engine.ts:3802-3806: allowed values, lockdown only Safe, trigger never Full, tools only on local interactive runs). Pass trust: input.trust ?? run.trust and approvals.tools: input.tools ?? run.approvals.tools to start(). narrowerTrust at engine.ts:5185 already prevents a raise above the …

**Suggested regression test:** Unit test in test/chat-options.test.ts, near the existing startProviderChat cases (lines 79-99): start a solo codex run at trust "standard", followUp with trust "full" (assert run.trust === "full"), then manager.startProviderChat(source.id, { agent: "claude", message: "x", trust: "standard" }). Assert child.trust === "standard", child.permissions.trust === "standard", and the captured adapter call has trust "standard". Also assert startProviderChat with trust "full" on a source at "standard" giv …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4685 (port 4685, home .../scratchpad/qa/homes/v4685, persistent profile v4685). All steps were done in the UI; scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4685/ (s2/s3/s4/s9 .mjs + .log).
1. Composer: project MQTT-MCP, provider Codex, Permissions set to "Approve for me", Send. Run 2610251830-41c44f3b finished with trust=standard, policy rev 1.
2. In the run's reply box: Permissions changed to "Full access", one reply sent. The run became trust=full with policy {revision:2, trust:"full"}. Step 1 receipt: trust standard, isolation provider-sandbox, network denied. Step 2 receipt: trust full, isolation none, network allowed. After a page reload the reply box still shows "Full access", so the choice sticks for the run.
3. Variant A (the reporter's flow): reply box Provider -> Claude Code opened the "Fork chat" dialog. Its full text was only "Fork chat / Send a message to start a new chat with this conversation's context. Chats share the workspace. / Message / Claude Code / Default model / Default effort / Cancel / Send". It had no .chat-permissions element and never mentions access or permissions. After Send, child 2610251831-d16a0d46 got trust=full, policy rev1 trust full, and its Claude step receipt says trust full, isolation none, network allowed. The child's reply box then shows "Full access".
4. Variant B (stronger, not in the original report): I went back to the source run, set the reply-box pill to "Approve for me" (screenshot shows the pill reading "Approve for me" behind the dialog), then Provider -> Claude Code -> Fork chat -> Send. Child 2610251831-b1f8e4b9 still ran with trust=full, isolation none, network allowed. So the forked chat ignores the permission that is on screen and runs with no sandbox.
Screenshots: .../qa/shots/v4685/001-A-dialog.png, 003-B-source-lowered.png, 004-B-dialog.png, 005-B-child.png. No console or 5xx errors.
Ways I tried to refute it:
- Selectors and environment: ruled out. The dialog DOM itself has no permission control, and the server state confirms the result.
- By design: only partly. Making a reply's choice the run's new permission level is intended (engine.ts:3818 comment "changing the run's permissions"; auto-team.md:21 "only an explicit user change creates a new policy revision"; test/chat-options.test.ts:126-128 asserts the revision bump). The pill also shows that level openly. A child  …

</details>

### t04-9 · minor · Unrestricted Antigravity failures always tell the user to check the login, even for rate limits/timeouts

**Fix outcome: fixed.** Root cause: src/adapters/agy.ts used one fixed login-check message for every errorKind. The fix adds nativeAgyFailure(kind) (agy.ts:341), parallel to managedAgyFailure. Auth keeps the login advice. Rate limit, usage limit, transient, timeout and cancelled get wording for their kind. Other kinds keep a generic message saying diagnostics were withheld. Native diagnostics stay withheld. Not changed: rate limits are not recorded in quota, because that is by design. The engine retries rate_limit and records only usage_limit, as the verifier confirmed.

Fixer's check: Fresh fake QA server f07b (4379) with FAKE_AGY_STATUS=RESOURCE_EXHAUSTED, FAKE_AGY_ERROR='Resource has been exhausted (e.g. check quota).' and CODEFLOW_RETRY_DELAYS_MS=1000,2000. Script r4-rate-limit.mjs: Fix & review with Builder Antigravity CLI, Reviewer Codex, unrestricted opt-in, check "true", started from the UI. Run 2610260143-092c7545 failed after 2 retries. The step error is "Unrestricted Antigravity hit a rate limit (too many requests in a short time)." and the run error is "Fix the issue (agy) failed: Unrestricted Antigravity hit a rate limit ...". No sentence on the page mentions login or sign-in. Browser errors were empty.

Tests: `test/qa-agy-unrestricted.test.ts: unrestricted Antigravity failures give advice for their kind, not a login check for every failure`

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-12.

**Repro**

> 1. Native Antigravity enabled; agy returns status RESOURCE_EXHAUSTED 'Resource has been exhausted (e.g. check quota).' (fake FAKE_AGY_STATUS/FAKE_AGY_ERROR).
> 2. Run a workflow whose role uses agy.

**Expected:** Error reflects the kind (rate limit / transient) with appropriate advice.

**Actual:** 'Fix the issue (agy) failed: Unrestricted Antigravity failed (rate_limit). Check the existing login in its normal session, then resume…' (t04b 2610251418-8ea8366c, 2610251419-fd63e035). The rate limit is also not recorded in quota, so Auto keeps choosing agy.

**Root cause (verifier):** src/adapters/agy.ts:290. `if (managed) error = native ? \`Unrestricted Antigravity failed (${errorKind}). Check the existing login in its normal session, then resume. ...\` : managedAgyFailure(errorKind);` The native (agy-native-v1) branch uses one fixed login-oriented message whatever errorKind was computed on line 289. The isolated branch calls managedAgyFailure(kind) (agy.ts:334-338), which has per-kind wording. The engine shows this string unchanged: for managed agy it skips its own auth rewrite at src/engine.ts:2637. It uses the same string in the retry status at src/engine.ts:2952 and in the final throw at src/engine.ts:2672.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/agy.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/agy-native.test.ts`

**Suggested fix:** Replace the fixed native string with a kind-aware helper, e.g. nativeAgyFailure(kind), parallel to managedAgyFailure. Keep withholding the raw diagnostics. Suggested wording:
- auth: keep the current "Check the existing login in its normal session, then resume. Code Flow never starts sign-in or changes credentials" text.
- rate_limit: "Unrestricted Antigravity hit a rate limit (too many requests). Wait a minute and resume."
- usage_limit: "Unrestricted Antigravity reached its plan's usage limit; resume after it resets."
- transient: "The Antigravity service was temporarily unavailable; resume to try again."
- timeout: "The Antigravity turn ran out of time."
- other / cli_incompatible: generic "Unrestricted Antigravity failed (<kind>). Native diagnostics are withheld. Check the CLI in its normal session before resuming."
Optionally also replace the isolated path's generic "Check the CLI in its normal interactive session" for timeout and transient. No engine or quota change is needed: ra …

**Suggested regression test:** In test/agy-native.test.ts, add a fixture variant whose result event has status RESOURCE_EXHAUSTED with error "Resource has been exhausted (e.g. check quota)." (and further cases for UNAVAILABLE and DEADLINE_EXCEEDED). Run adapter.run(opts) with the native receipt and assert:
- result.errorKind is "rate_limit", "transient" and "timeout" respectively;
- result.error does not match /login|sign-?in/i for those kinds and matches /rate limit/i for the rate_limit case;
- an UNAUTHENTICATED status, or  …

<details><summary>Verifier's independent reproduction</summary>

1. Started a fresh fake server: qa-server.sh start v4683 4683 fake, with FAKE_AGY_STATUS=RESOURCE_EXHAUSTED, FAKE_AGY_ERROR='Resource has been exhausted (e.g. check quota).' and CODEFLOW_RETRY_DELAYS_MS=1000,2000 (only shortens the retry waits) exported first. Added a scratch clone of MQTT-MCP through "Open another repository" as project v4683-mqtt.
2. In the UI (/#/new): workflow Fix & review, Builder = Antigravity CLI, Reviewer = Codex, Advanced > "Use unrestricted Antigravity with my existing login" checked, Permissions = Approve for me, check = true. Clicked Start run.
3. Run 2610251830-688bd7dc: permissions.antigravityExecution=native. It failed after 2 retries. Step error and the run banner "The run could not finish" both read: "Fix the issue (agy) failed: Unrestricted Antigravity failed (rate_limit). Check the existing login in its normal session, then resume. Code Flow never starts sign-in or changes credentials; native diagnostics are withheld." The retry status lines were also misleading: "Antigravity CLI failed (Unrestricted Antigravity failed (rate_limit). Check the existing login in its normal session, then resume. ...); trying again in 1s". They give login/resume advice while the engine is already retrying by itself. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4683/002-run-native.png. No console errors.
4. Adapter probe against a snapshot (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4683/probe-kinds.mts, using the fake agy, native receipt from createRunPermissions(..., "native")). errorKind is classified correctly every time (rate_limit, usage_limit, transient, timeout, auth), but every native message is the same "Unrestricted Antigravity failed (<kind>). Check the existing login..." text. In legacy mode (no permissions) the same failures show agy's own text, e.g. "Resource has been exhausted (e.g. check quota). (agy status RESOURCE_EXHAUSTED)". The isolated path uses kind-specific text via managedAgyFailure.
Refuted part: "the rate limit is not recorded in quota, so Auto keeps choosing agy" is by design. engine.ts:2633-2635 records a quota limit only for usage_limit ("a per-minute 429 was just retried"). rate_limit is in RETRYABLE (engine.ts:3037) and was retried twice. The agyStatusKind doc comment (agy.ts:340-345) says RESOURCE_EXHAUSTED without plan/daily/quota-exceeded  …

</details>

### t05-10 · minor · Antigravity shows 'Ready' and Send is enabled although its default (isolated) execution is unsupported for the installed version

**Fix outcome: fixed.** Root cause: the doctor's managedCompatible:false never reached the composer or the health views. Fixes: (1) src/doctor.ts:124-129 keeps the managedAvailability() reason and adds a warning naming it and the unrestricted opt-in. Check this computer, the settings card and Health & usage then show it. (2) ui/composer.tsx:579 startProblem() returns a problem when agy is used, the run isn't native, and the doctor reports managedCompatible === false. Send is then disabled and its title explains why. This applies on the local path only, not to remote inventory. (3) ui/dependency-health.tsx: such an agy row gets a warn badge, "Unrestricted only", instead of Ready, and is not counted in providersReady.

Fixer's check: On the f07 fake server (fake agy 1.3.6), /api/doctor returns managedCompatible false plus the new warning. In r1-native-once.mjs, choosing Antigravity CLI and typing a task left Send disabled. Its title and the summary read "Antigravity 1.3.6 can't run isolated on this computer ... or turn on Run options → Advanced → Use unrestricted Antigravity." No POST was sent. Ticking the opt-in enabled Send. In r3-health.mjs, Settings → Check this computer → Check all dependencies showed the agy row as "Unrestricted only" with the warning text, and the health dialog showed the same warning. On the real-mode f07b server (agy 1.4.7, verified), /api/doctor returned managedCompatible true with no warning.  …

Tests: `test/qa-agy-unrestricted-fork.test.ts: doctor warns when isolated Antigravity can't run here, and says how to opt out`, `test/e2e/qa-agy-unrestricted.e2e.ts: Check this computer marks Antigravity that can't run isolated`, `test/e2e/qa-agy-unrestricted.e2e.ts: unrestricted Antigravity applies only to the run it was ticked for (asserts Send disabled with the reason before the opt-in)`

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOL-15.

**Repro**

> 1. Start a fake QA server (fake agy reports version 1.3.6).
> 2. Settings → Agents & models → Check this computer: 'Antigravity CLI · 1.3.6' is Ready, with no warning.
> 3. In the composer choose Antigravity CLI and type a task. Send is enabled with the title 'Start run'.
> 4. Click Send: POST /api/runs returns 400 'Isolated Antigravity requires macOS, CLI 1.4.4 or 1.4.5 or 1.4.6 or 1.4.7, and an existing native Keychain login/security cache…'.

**Expected:** Check this computer and the composer use the doctor's managedCompatible:false to warn up front, e.g. 'Ready (unrestricted only); isolated execution needs CLI 1.4.4–1.4.7', and Send is disabled with that reason.

**Actual:** The health and dependency views say Ready. The failure appears only after Send.

**Root cause (verifier):** The doctor's managedCompatible:false never reaches the solo composer or the health views:
- `ui/composer.tsx:544-575` `startProblem()`: the only provider-health check is the local `signedOut` lookup at about line 572 (`health.value?.find(h => used.has(h.id) && h.installed && h.signedIn === false)`). It never checks `managedCompatible` for agy when `composerRunOptions.value.antigravityExecution !== "native"`, and it never checks `compatible === false` either. Because of that, `problem` at line 187 is "" and the Send button at line 330 stays enabled with title "Start run (⌘↵)".
- `ui/dependency-health.tsx:22`: the provider badge is built only from installed, compatible and signedIn, so agy with `managedCompatible:false` renders "Ready". `providersReady` at line 14 likewise counts it.
- `src/doctor.ts:124`: it sets `entry.managedCompatible = !await managedAvailability()` but throws the reason string away. It adds nothing to `entry.warnings` or `entry.fix`, so no health view (Check this computer, the per-agent card at `ui/settings.tsx:121`, Health & usage) has anything to show.
- `ui/chat-controls.tsx:37`: the provider menu disables an entry only when `!entry.available`, so Antigravity …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/dependency-health.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/doctor.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/task-team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`

**Suggested fix:** 1. Move `teamProviderProblem` from ui/task-team.tsx into ui/state.ts as a shared helper, `providerProblem(id, { nativeAgy })`. It returns:
   - "Sign in" when signedIn === false.
   - "Update CLI" when compatible === false.
   - For agy, when not native and `managedCompatible === false`, a message such as "Antigravity {version} can't run isolated (needs CLI 1.4.4–1.4.7 and a Keychain login). Update Antigravity or enable Run options → Advanced → Use unrestricted Antigravity."
   Return nothing while the diagnostic is still undefined; the server stays the authority.
   Use the helper in task-team.tsx, in rolesFor eligibility, and in `startProblem()` (local branch only, i.e. not when an `inventory` is passed). The nativeAgy value is `composerRunOptions.value.antigravityExecution === "native"`. Send then becomes disabled, and its title explains why, before any POST.
2. In src/doctor.ts:124, keep the managedAvailability() reason and add a warning when it is set, e.g. "Default isolated execu …

**Suggested regression test:** 1. Unit test in test/repo-selection-ui.test.ts, or a new test/composer-start-problem.test.ts that imports `startProblem` from ui/composer.tsx and the signals from ui/state.ts. Set repo and task, use the solo pattern with roles {agent:["agy"]}, and set health agy {installed:true, signedIn:true, compatible:true, managedCompatible:false}.
   - Assert `startProblem(solo, roles)` matches /Antigravity.*(isolated|unrestricted)/i.
   - Set `composerRunOptions.value = { antigravityExecution: "native" }`  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server with `qa-server.sh start v4619 4619 fake`. The fake agy reports 1.3.6.
1. `GET /api/doctor` returned agy as {version:"1.3.6", installed:true, compatible:true, signedIn:true, managedCompatible:false, warnings:none, fix:none}.
2. In a fresh browser I opened Settings → Agents & models → Check this computer → "Check all dependencies". Every agy row, including "Antigravity CLI · 1.3.6", showed a green "Ready" badge with no help text, and the summary read "Core tools are ready." Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4619/001-check-this-computer.png
3. In the composer I picked project MQTT-MCP through the Choose project dialog. In the Provider menu, "Antigravity CLI" was enabled with no sub-text, and I selected it. Then I typed a task. Send was enabled with title "Start run (⌘↵)". Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4619/001-composer-agy-ready.png
4. I clicked Send. `POST /api/runs` returned 400 {"error":"Isolated Antigravity requires macOS, CLI 1.4.4 or 1.4.5 or 1.4.6 or 1.4.7, and an existing native Keychain login/security cache. No permissive fallback is available."}. The message appeared in red below "Run options", away from the Send button. It does not mention the "Use unrestricted Antigravity" opt-in. No run was created (runs = 0). Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4619/002-composer-agy-after-send.png. At the same moment, `/api/model-catalog?antigravityExecution=isolated` returned the same text as agy's blockedReason.

Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4619/ (repro.mjs/repro.log for the Settings check, repro2.mjs/repro2.log for the composer and Send).

Ways I tried to refute it:
- Environment: the trigger is the fake shim's version 1.3.6. The real installed agy is 1.4.7, which is on the pin list. But the gate is real code, and the docs say the version is "deliberately pinned". So any real user whose agy auto-updates past 1.4.7, or whose Keychain/security cache is unavailable, sees the same Ready badge, then the 400.
- By design: no. The doctor computes `managedCompatible` precisely for the UI ("Verified default manage …

</details>

### t05-5 · minor · CODEFLOW_AGY_SKIP_PERMISSIONS=0 has no effect; documented behaviour is stale

**Fix outcome: fixed.** The code works as designed: unrestricted mode is defined by the skip flag (auto-team.md, agy-native.test.ts), so native mode was not changed to honour the variable. Docs and diagnostics are fixed: docs/configuration.md:122 limits the variable to legacy agy calls (prompt improvement, docs help, runs saved before run policies). The docs/security.md table and caveats now describe isolated runs (--sandbox --agent codeflow-isolated, no skip flag), unrestricted runs, and legacy calls separately. The src/doctor.ts:93-94 flag notes no longer say every step.

Fixer's check: f07b fake server started with CODEFLOW_AGY_SKIP_PERMISSIONS=0 and FAKE_RECORD_DIR. The unrestricted agy steps of r4 recorded args with --dangerously-skip-permissions and no --sandbox, which is the documented behaviour. A unit test also shows that with =0 a legacy call (no permissions) omits the flag, and that without the variable it passes --sandbox plus the flag.

Tests: `test/qa-agy-unrestricted.test.ts: CODEFLOW_AGY_SKIP_PERMISSIONS only affects legacy calls, never unrestricted runs`

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOLO-GAP-02.

**Repro**

> 1. Export CODEFLOW_AGY_SKIP_PERMISSIONS=0 and FAKE_RECORD_DIR=<dir>, then start a fake QA server.
> 2. Start an Antigravity run with 'Use unrestricted Antigravity' ticked.
> 3. Inspect the recorded agy args: '--dangerously-skip-permissions' is still passed. Isolated runs never pass it either way.

**Expected:** Per docs/configuration.md:122 ('Set to 0 to stop passing --dangerously-skip-permissions to agy'), the flag is omitted. Otherwise the variable and its doctor note should be removed from the docs.

**Actual:** The flag is always passed in native mode and never in isolated mode. The variable now only affects legacy runs without a permission policy, which the UI cannot create.

**Root cause (verifier):** The code works as designed. The defect is stale, unqualified docs and diagnostics written before managed (isolated) and native execution existed:

- docs/configuration.md:122 says "Set to `0` to stop passing `--dangerously-skip-permissions` to agy" with no qualifier. In fact src/adapters/agy.ts:116-118 consults skipPermissions() (agy.ts:50-52) only in the legacy branch, when opts.permissions is undefined. Native runs (`native || skipPermissions()`) always pass the flag. Isolated runs (the `if (isolation)` branch) never pass it.
- src/doctor.ts:93-94 says both `--sandbox` and `--dangerously-skip-permissions` are needed "every step (unless CODEFLOW_AGY_SKIP_PERMISSIONS=0)". That is wrong for every new run: native has no --sandbox, isolated has no skip flag, and the variable has no effect on either.
- docs/security.md:13, :103 and :107 still describe "--sandbox + --dangerously-skip-permissions by default" as how runs execute. Isolated runs actually use --sandbox --agent codeflow-isolated with no skip flag.
- The legacy-path error at src/adapters/agy.ts:233 tells users to "enable CODEFLOW_AGY_SKIP_PERMISSIONS". That remains accurate because it only fires on the legacy path.

The report …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/configuration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/doctor.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/security.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/agy.ts`

**Suggested fix:** Change docs and diagnostics only. Do not make native mode honour the variable: unrestricted mode is defined to use the permission-skip flag, and headless agy cannot answer prompts.

1. docs/configuration.md:122: scope the row to legacy (non-managed) Antigravity calls, which are Improve, docs help, filtered tasks and runs saved before run permission policies. For example: "Legacy Antigravity calls only. Set to `0` to stop passing `--dangerously-skip-permissions` there, then configure permissions.allow in ~/.gemini/antigravity-cli/settings.json. Runs ignore it: isolated runs never pass the flag, and unrestricted runs always do."
2. src/doctor.ts:93-94: change the `when` text, e.g. --sandbox "isolated runs, prompt improvement and legacy steps" and --dangerously-skip-permissions "unrestricted runs, and legacy calls unless CODEFLOW_AGY_SKIP_PERMISSIONS=0".
3. docs/security.md:13 and the caveats at :103/:107: describe the current default (isolated executor, `--sandbox --agent codeflow-isolat …

**Suggested regression test:** 1. In test/agy-native.test.ts, wrap the native fixture in withEnv({ CODEFLOW_AGY_SKIP_PERMISSIONS: "0" }) and keep the assertion that launch.args includes --dangerously-skip-permissions. This locks in that unrestricted mode ignores the legacy variable.
2. In test/adapters-review.test.ts, add a case that calls the agy adapter with no `permissions`, once with CODEFLOW_AGY_SKIP_PERMISSIONS="0" (the recorded args lack --dangerously-skip-permissions) and once unset (they include it). This pins the va …

<details><summary>Verifier's independent reproduction</summary>

Confirmed as a documentation and doctor-text defect only. The runtime behaviour the reporter saw is by design, and the claim that the variable is now dead is wrong.

Steps:
1. Exported CODEFLOW_AGY_SKIP_PERMISSIONS=0 and FAKE_RECORD_DIR=/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4609/rec. Ran `qa-server.sh start v4609 4609 fake`. `ps eww` showed the server env contains CODEFLOW_AGY_SKIP_PERMISSIONS=0.
2. In the UI (fresh profile v4609): Choose project → MQTT-MCP, Provider → Antigravity CLI, Run options → ticked "Use unrestricted Antigravity with my existing login", then Send. The POST body had "antigravityExecution":"native". Run 2610251801-4eed6085 finished as done with permissions {trust:standard, antigravityExecution:native}. The run jsonl records implementation agy-native-v1.
3. Recorded agy args: [--input-format stream-json, --output-format stream-json, --print-timeout 1440m, --log-file …/codeflow-agy-native-*/native-auth.log, --dangerously-skip-permissions]. This matches the reporter: the flag is passed even with =0.
4. Refutation check: in Settings → Agents & models I set "Prompt improvement agent" to Antigravity, then clicked Improve in the composer (with =0 still set). Improve returned 200 (agent agy). Recorded args: [... --print-timeout 2m, --sandbox, --effort low, --json-schema …] with no --dangerously-skip-permissions.
5. Control: restarted the server without the variable and repeated Improve. Recorded args were the same plus --dangerously-skip-permissions.

So the variable still works on the legacy (no run-policy) path, which the UI does reach through Improve. By reading code (not exercised here), the same path is also used by docs help (src/docs-help.ts:244), filtered tasks (src/filtered-tasks.ts:48) and persisted pre-policy runs.

Isolated (default) runs cannot be launched in fake mode (fake agy 1.3.6 is rejected). In code, the isolation branch never adds the flag, and that is by design.

Evidence that the native and isolated behaviour is intended:
- docs/auto-team.md:143: unrestricted mode "skips the isolated profile and vendor sandbox and uses the CLI's permission-skip flag".
- docs/worker-permission-verification.md:80: "CODEFLOW_AGY_SKIP_PERMISSIONS cannot bypass managed controls".
- The code comment at src/adapters/agy.ts:25-33 limits the variable to "Legacy execution behaviour (only when no managed run policy is supplied)".
- test/agy-native.test.ts:40 asser …

</details>

### t05-13 · minor · Isolated Antigravity can read the worktree's .git pointer file, though the profile says Git metadata is off-limits

**Fix outcome: fixed.** Root cause: src/adapters/agy-isolation.ts denied only file-write* for `/.git(/|$)` paths in the workspace. The fix at agy-isolation.ts:147 denies file-read-data, file-read-xattr and file-write*. File metadata stays visible (stat), so repository detection still works, and .gitignore and .gitattributes are not matched. docs/worker-permission-verification.md now states that Git contents, including the worktree's .git pointer, cannot be read or written. AGY_ISOLATION_VERSION was not bumped: the executor's capabilities are unchanged, and the version string is pinned in receipts, tests and docs.

Fixer's check: Kernel unit test on darwin: under the real sandbox-exec profile, in read and write mode, reading the .git pointer and nested/.git/HEAD is denied, as is listing nested/.git. [ -e .git ] and [ -f .git ] still succeed, .gitignore and README.md stay readable, and appending to .git is denied. One real run (the issue was found with a real agent) on a real-mode QA server f07b started from the worktree: agy 1.4.7, gemini-3.8-flash-low, default isolated executor (macos-task-tools-v2, os-sandbox), on a scratch repo. Asked to read `.git` and README.md, the CLI started and finished normally in the worktree. Run 2610260144-8d2c20ea finished done. view_file on .git failed with 'open .../.worktrees/<id>/so …

Tests: `test/qa-agy-unrestricted.test.ts: the isolated profile denies reading Git metadata contents as its prompt says`, `test/qa-agy-unrestricted.test.ts: managed macOS kernel boundary hides the worktree's .git pointer and nested Git contents`

Source: tester unit solo-runs-providers-2; observed with real-agents; features SOLO-GAP-03.

**Repro**

> 1. Real server with agy 1.4.7 on macOS. Start a solo Antigravity run (default isolated) on a scratch repo.
> 2. Ask it to read the file `.git` in the repository root and quote its first line.
> 3. It succeeds and quotes 'gitdir: <clone>/.git/worktrees/solo8'. Appending to .git is denied, and reading the parent repository is denied.

**Expected:** Per the isolation profile's own prompt (agy-isolation.ts:201: 'Git metadata (.git files and directories) and the parent repository are outside this profile') and the SOLO-GAP-03 expectation, .git reads are denied too.

**Actual:** The sandbox denies only writes to .git. The pointer is readable and reveals the parent repository path. The prompt asks the model not to look, but nothing enforces it.

**Root cause (verifier):** src/adapters/agy-isolation.ts:137 grants `file-read*` on `(subpath workspace)`. The only `.git` carve-out, at agy-isolation.ts:144, is `(deny file-write* (require-all (subpath ws) (regex #"/[.]git(/|$)")))`, which blocks writes only. Compare agy-isolation.ts:143, where `.agents`/`.gemini` get `deny file-read* file-write*`. The provider-level rules in agyIsolatedSettings (agy-isolation.ts:160-163) allow `read_file(<workspace>)` and deny nothing under `.git`. Meanwhile the custom agent prompt (agy-isolation.ts:201: "Git metadata (.git files and directories) and the parent repository are outside this profile") and the turn preamble (src/adapters/agy.ts:142: "Do not inspect .git files/directories ... Git metadata and shell are unavailable") tell the model that .git is unavailable. Partly by design: the kernel test (test/agy-managed-isolation.test.ts:57, "...git and authentication writes", lines 78/85) and docs/worker-permission-verification.md:66,77 only claim Git metadata is protected from writes. The stated profile and the enforcement still disagree. In practice the model's own restraint is the only thing keeping it from reading .git, and when it holds back it reports "Denied" for a  …

**Files:** `src/adapters/agy-isolation.ts`, `src/adapters/agy.ts`, `test/agy-managed-isolation.test.ts`, `docs/worker-permission-verification.md`

**Suggested fix:** Preferred fix: enforce what the prompt says. At agy-isolation.ts:144 change the rule to `(deny file-read-data file-read-xattr file-write* (require-all (subpath ws) (regex #"/[.]git(/|$)")))`. This keeps file-read-metadata, so stat-based repo-root detection by the CLI still works. Validated with a sandbox-exec probe: content read is denied, stat is OK, writes stay denied, other workspace reads and writes are unaffected. The regex does not match .gitignore or .gitattributes. Optionally also add `read_file(<workspace>/.git)` to the deny list in agyIsolatedSettings as a defence-in-depth provider rule.
Consider bumping AGY_ISOLATION_VERSION (macos-file-only-v1 -> v2), because steps record the executor version.
Re-run scripts/live-permission-probes/managed-antigravity.ts with real CLI 1.4.7 to confirm the CLI still starts and completes a turn. The CLI already cannot read the real git dir, so blocking the pointer should not reduce what it can do.
Alternative, if reads are intended: change the …

**Suggested regression test:** In test/agy-managed-isolation.test.ts, in the darwin test "managed macOS kernel boundary protects policy, outside files, git and authentication writes", add these lines to the probe script for both modes:
- `if IFS= read -r x < .git; then exit 54; fi`
- `if IFS= read -r x < nested/.git/sentinel; then exit 55; fi`
- `[ -e .git ] || exit 56` (metadata stays visible)
Also make the fixture's `.git` a real `gitdir: ...` pointer, or create it with `git worktree add`. Rename the test to cover git reads …

<details><summary>Verifier's independent reproduction</summary>

1. Started a fresh real-mode QA server: `qa-server.sh start v4625 4625 real` (fresh home, agy 1.4.7 on PATH). Added a tiny scratch repo through "Open another repository": a local bare repo plus a clone at scratchpad/qa/clones/v4625-scratch.
2. Started one solo run through the UI: Antigravity CLI, Gemini 3.8 Flash (Low), "Approve for me", AI team Off. This is the default isolated executor (macos-file-only-v1). The prompt asked it to read README.md and then `.git` and quote the first line of each. The run was 2610251807-7fb05e74 and finished in 8 s. Its jsonl shows one tool call, view_file on README.md. The model never tried `.git`. It still reported ".git: Denied", quoting the profile prompt ("Git metadata (.git files and directories) ... are outside this profile"). So the model held back on its own because of the prompt. Nothing enforced it, and in this run nothing was blocked. The reporter's run 2610251420-6bdbf318 (work/t05/s20.log) used the same model, which did call view_file on `.git` and quoted "gitdir: <clone>/.git/worktrees/solo8". Whether the file gets read depends only on what the model chooses.
3. Checked the enforcement directly on the worktree the fresh server created (<clone>/.worktrees/2610251807-7fb05e74/solo). I used a snapshot copy of the source (builds/v4625) and called the real `prepareAgyIsolation()` for read and write mode with /bin/bash as the binary, the same method test/agy-managed-isolation.test.ts uses (script: work/v4625/kernel-probe2.mts). Under the generated sandbox-exec profile, in both modes:
   - `read < .git` printed "gitdir: <clone>/.git/worktrees/solo".
   - `printf >> .git` was denied.
   - Reading <clone>/README.md and <clone>/.git/worktrees/solo/HEAD was denied.
   - `.git` was left unchanged.
   The generated provider settings.json has allow `read_file(<workspace>)` and no deny rule naming `.git`. A synthetic repo and worktree (kernel-probe.mts) gave the same results.
4. Tested the proposed fix rule in the same harness without editing the source (fix-probe.mts): replacing line 144's `(deny file-write* ...)` with `(deny file-read-data file-read-xattr file-write* ...)` blocks reading `.git` and keeps writes to it blocked. `[ -f .git ]` (stat/metadata) still works, README reads still work, and workspace writes still work.
Cleanup: deleted the run in the UI (the dialog says branches and worktrees are kept, by design), stopped v4625, removed the scratch clone and bare repo and the probe temp dirs. Ports 4625-4627 are free …

</details>


## Continuation integration · 2026-10-26

Repair round 1 merged into `codex/dogfood-qa-continue`. Typecheck and all 6 targeted tests pass. Independent browser re-verification is running on a detached integrated build; prior evidence above describes the earlier session.

Fresh continuation Chrome replay: all 5 scenarios pass (one new scenario delays `/api/doctor`). Fixed a confirmed startup window: an explicitly selected isolated Antigravity can no longer send before compatibility discovery completes. A failed health request explains how to retry; native opt-in and remote-worker behavior remain separate. Existing opt-in, permission inheritance, and settings/health checks passed with fake CLIs. Logs: `/private/tmp/codeflow-qa-continue/step1-browser.log` and `step1-browser-repaired.log`.

Continuation follow-up: `startProblem` now receives the actual launch's Antigravity mode explicitly. Sweeps always validate isolated execution; comparisons use their own saved draft mode. A pending native composer opt-in can no longer enable a sweep that the server would reject. Mixed-provider templates expose the unrestricted indicator too. Rate-limit/outage text now explains waiting/resuming after retries, and compatibility wording says there is no *automatic* switch to unrestricted execution. All 6 Chrome scenarios pass, including a real UI sweep dialog configured with Antigravity while the composer's native opt-in remains set (no sweep POST is sent); tsc passes. Evidence: `/private/tmp/codeflow-qa-continue/approval-agy-followup-browser.log`. The first added template assertion assumed the default builder was Auto; the fixture was corrected to select Antigravity explicitly. The file-only executor implementation identifier remains unchanged as previously documented; Git metadata denial is verified by the existing kernel tests.
