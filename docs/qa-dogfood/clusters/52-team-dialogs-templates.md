# Cluster 52 · team-dialogs-templates

**AI team setup dialogs and team templates**

Status: **fixed and verified** · 8 issues · branch `codex/qa-team-dialogs-templates`

Planner notes: ui/task-team.tsx and ui/team-template-library-view.tsx. t11-11: 'Refresh comparison' in TaskConflictDialog resets choices (setChoices({})) and discards typed resolutions. t10-6: the template prefill merges the coordinator's settings over the pool's when both use one provider (ui/task-team.tsx:83). t10-5: the chat 'AI team' toggle turns On when the server has Auto team disabled (the gate at engine.ts:5097); read the server capability. t11-13: 'Resume team' stays visible when AI team is off. t10-10: the lead model quick picker offers Antigravity while tool approvals are on; filter on approvals as well as teamProviderProblem. t11-16: the import library throws away the server's notes about dropped settings. t11-17: 'Save as team template…' embeds the whole library (SaveStrategyDialog at ui/run.tsx:2390). t12-21: reusable team history over 100 versions is reported as a generic 'Invalid reusable team history' (src/agent-team-definitions.ts:17). team-engine-control owns the role settings in runTaskTeam (t11-6).

Likely files: `ui/task-team.tsx`, `ui/team-template-library-view.tsx`, `ui/run.tsx`, `src/team-template-store.ts`, `src/agent-team-definitions.ts`, `ui/agent-team-library.tsx`, `src/run-permissions.ts`, `src/engine.ts`

## Repair and independent verification · 2026-10-26

Worktree: `/private/tmp/codeflow-qa-continue/team-dialogs-templates`, based on integration `46b909c`. All app, test, build and import commands used explicit scratch `CODEFLOW_HOME`. Tests used temporary repositories/homes, fake providers, ephemeral loopback listeners excluding 4317/4318, and fresh Chrome contexts. The rollout scenario restarts only its own fixture server. No live home/server, real provider account, remote effect, push or PR was used.

| Entry | Outcome and root fix | Independent evidence |
| --- | --- | --- |
| t11-11 | Fixed. Refresh compares each path's base/current/team versions, carries unchanged choices, and retains the selected path. Changed or removed files lose their approval choice, with a visible explanation and recoverable previous edits. Choice toggles also retain edited text. Version metadata now includes Git object identity, so changed binary content and file modes cannot silently reuse an old choice. | Actual chat-team conflict: unchanged refresh, choice toggles, unrelated workspace edit and stale apply, changed conflict version, explicit re-choice, final merge/check. Separate unchanged-baseline replay confirms Refresh removes the editor; the main baseline also confirms toggle-based text loss. Unit coverage includes file removal/reorder, mode changes and different binary objects. |
| t10-6 | Fixed. Template prefill merges model and effort independently per provider, in general → pool → coordinator order. Conflicting values produce an explanatory notice. Chat configuration retains its existing one-pair-per-provider schema. | Codex pool `gpt-b` plus coordinator `low` appears as GPT-B/low and persists after Apply. A coordinator `gpt-a` override is visible with a conflict notice. The unchanged baseline loses GPT-B. |
| t10-5 | Fixed. The shared control disables turning new teams on when the server disables them. Existing enabled teams can still be turned off; model/configuration updates cannot submit enabled settings against the disabled capability. A restored enabled composer draft explains the problem and blocks Send before an API call. | Restart the isolated server with the capability off; reload a real saved team draft, observe disabled Send, turn it off, and verify the now-off switch stays disabled. An existing chat can also be turned off, and an ordinary single-agent run still completes. The unchanged baseline lacks the preflight explanation. |
| t11-13 | Fixed. Resume is disabled while the owning chat's AI team is off, with a linked instruction. Its stale error clears when team state/execution changes; check/review actions retain their independent availability. The engine's race/API error uses the same AI-team label. | Real stopped fake-team execution: turn off, observe disabled Resume and help, turn back on, then resume successfully. The unchanged baseline keeps an enabled action and no explanation. |
| t10-10 | Fixed. The lead quick picker filters Antigravity when tool approvals are active. The same permission helper explains incompatible saved team providers in the control/dialog and blocks new chat starts. Choosing another model no longer drops that provider's existing effort. | A fixture doctor advertises compatible Antigravity; it is absent under Ask for approval, then available after explicitly choosing Approve for me. No real Antigravity process or login is used. Existing ordinary-provider approval normalization remains intact. |
| t11-16 | Fixed. Migration returns per-entry notes for omitted checks, setup, branch, context, permissions/limits, verification and isolation settings; the explanation is saved in the template description. The library displays server notes from personal and project imports persistently. | Both scopes show their specific omissions and original browser JSON remains byte-identical. Unit coverage verifies descriptions, a plain-entry control and idempotent repeat import. The unchanged UI discards the notes. |
| t11-17 | Fixed. Save-from-run uses the editor's focused mode: no library selector, design/import/current-composer actions, or Close editor control can replace the run draft. Successful publication closes the dialog. Extra library section spacing is removed. | Finish a real fake-provider Auto run, open its save dialog, inspect the run-derived tasks, edit/publish, and verify the saved tasks match. All unrelated controls are absent. The baseline displays its blank library selector. |
| t12-21 | Fixed. A normal save at the 100-version bound throws an actionable 409 before changing storage. Corrupt-file validation retains its integrity error, and idempotent operation replay is checked before the bound. | Create 100 versions, perform the 101st save in the actual UI and observe the recovery instruction. Unit coverage verifies unchanged file bytes, revision 100 after reload, no faults and successful replay of operation 100. Baseline returns generic 400. |

New regression artifacts: `test/qa-team-dialogs-templates.test.ts` and `test/e2e/qa-team-dialogs-templates.e2e.ts`. Original scenarios run against actual application APIs and fake CLI execution; provider availability is stubbed only for the no-execution Antigravity picker case. The fake Codex app-server stays enabled because model capability discovery requires it. The standalone save-from-run fixture explicitly sets plan approval off; the conflict fixture explicitly pauses for approval. These fixture choices avoid unrelated planner/catalog or waiting-state failures.

Validation logs and screenshots are under `/private/tmp/codeflow-qa-continue/`:

- `team52-tsc.log`: `tsc --noEmit` passed.
- `team52-unit.log`: **11/11** new helper/store and original template tests passed.
- `team52-related.log`: **27/27** original task-team, recovery and permission tests passed. One original assertion was updated from internal `maxCalls` wording to cluster32's intentional user-facing “Agent calls … between 4 and 200” message.
- `team52-browser.log`: **8/8** new Chrome/API scenarios passed. Team setup, conflict recovery and focused save dialog each pass axe with WCAG 2 A/AA, 2.1 A/AA and 2.2 AA tags. `team52-browser/` contains JSON audits, screenshots, conflict state, server log and an empty page-error list; only Node's expected experimental SQLite warning appears.
- `team52-original-browser.log`: **12/12** original `task-team.e2e.ts` and `auto-team.e2e.ts` scenarios passed.
- `team52-baseline-browser.log`: **0/8** pass on unchanged `46b909c`, with the expected original defects; `team52-baseline-refresh.log` independently reaches the original Refresh-comparison text-loss path.
- `team52-focused-editor.log`: final focused-editor spacing/publish/accessibility replay passed after visual inspection.

All eight entries are resolved. Real subscription providers and device screen readers were not exercised. The separate runtime per-role setting issue remains owned by the team-engine-control cluster; this change deliberately keeps the existing chat configuration schema. Shared status/coverage documents were not edited.

## Issues

### t11-11 · minor · 'Refresh comparison' in Resolve changes discards the user's typed resolution

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features TEAM-24.

**Repro**

> 1. Chat team with approval; edit claude-alpha.txt in the chat worktree before approving; approve -> conflict. 2. Resolve conflicts -> Edit result -> type text. 3. Change another workspace file, click Apply and check -> 'Your workspace changed…'. 4. Click Refresh comparison.

**Expected:** Typed resolution kept (or a warning before discarding).

**Actual:** All choices and the edited text are reset (aria-pressed count 0); the user has to retype.

**Root cause (verifier):** The cause is ui/task-team.tsx:146 in TaskConflictDialog:
`const load = async () => { setBusy(true); try { setData(await api(endpoint)); setChoices({}); setIndex(0); setError(""); } ... }`

The same `load` runs on mount (line 147) and from the "Refresh comparison" button (line 155). It always clears every per-file choice, including `text` for "edited", and resets the file selector to index 0. It never checks whether a file's base, current or team version actually changed.

The server side explains why this matters (src/task-team.ts:174, resolveTaskReconciliation). It rejects an apply when the whole workspace tree differs from the comparison, which happens for any change to any file. The only way past that rejection is Refresh comparison, so an unrelated edit always costs the user their typed resolution.

A related loss in the same component (line 153, found by reading the code, not reproduced): choosing "Keep yours" or "Use team version" stores no `text`. Switching back to "Edit result" refills the box from file.current.text, so typed text is also lost by toggling between choices.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/task-team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/task-team.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/auto-team.md`

**Suggested fix:** Change the refresh in TaskConflictDialog (ui/task-team.tsx:146) so it carries choices over instead of clearing them.

1. On refresh, compare the new data with the previous data. For each path in next.files, keep the previous choice when:
   - the same path existed before, and
   - its base, current and team versions match: same `exists`, `binary` and `text`.
2. Drop choices only for files that disappeared or whose versions changed. Show a role="status" notice for them, for example: "Your choices for N files were cleared because those files changed. Choose again." For an "edited" choice on a file that changed, keep the typed text available rather than discarding it silently: pre-fill it, or offer "Restore previous edit".
3. Keep the selected file by path, not by index; fall back to 0 only if that file is gone.
4. Clear `error` as today.
5. Put the merge in a small pure helper, e.g. `carryConflictChoices(prevFiles, prevChoices, nextFiles)`, so it can be unit-tested. Use a functional setC …

**Suggested regression test:** Extend the test "conflicting user edits open a three-way resolution dialog and verify the combined workspace" in test/e2e/task-team.e2e.ts:
- After the stale alert and the Refresh comparison click, do not click Edit result or fill the textbox again.
- Assert that the "Edit result" button has aria-pressed="true" and that the "Resolved file contents" textbox value equals "My edit and team implementation\n".
- Assert that the file option still shows "✓ claude-alpha.txt", then click Apply and check  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4623 on 127.0.0.1:4623 (the old v4623 home was moved aside and a new home created). I made my own scratch git fixture at clones/v4623-fx (package.json "test": "node check.mjs") and registered it as project p-28f0edc8 through the API. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4623/repro.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4623/repro.log.

Steps, all in the UI:
1. Turned AI team on in the composer, then Advanced > "Let me approve the plan". Sent "AUTO-MINIMAL implement the fixture" (run 2610251945-87681ea1).
2. While the plan was awaiting approval, wrote "My concurrent edit" into claude-alpha.txt in the solo worktree, then clicked Approve. The turn became state=preserved with conflicts=[claude-alpha.txt].
3. Opened Team activity > Resolve conflicts > Edit result and typed a resolution.
   - State A: aria-pressed=1 ("Edit result"), textarea holds the typed text, option shows "✓ claude-alpha.txt", Apply is enabled.
4. Variant 1: clicked Refresh comparison with nothing changed on disk.
   - State B: pressed=0, no textarea, the ✓ is gone, Apply is disabled. The three versions are byte-identical to before.
5. Variant 2 (the reporter's path): typed again, wrote later.txt (an unrelated file), clicked Apply and check.
   - State C: alert "Your workspace changed since this comparison. Refresh the comparison before applying." The typed text is still shown.
6. Clicked Refresh comparison.
   - State D: pressed=0, textarea gone, Apply disabled. The base, current and team texts of claude-alpha.txt are unchanged ("File deleted / absent" / "My concurrent edit" / "alpha implementation").
   - Clicking Edit result again fills the box with "Your version" ("My concurrent edit"), not the typed text, so the typed resolution can't be recovered.
   - Screenshots 003-C-stale.png and 004-D-after-refresh.png in shots/v4623 show this. No warning is shown at any point.
7. After typing it a third time, Apply worked (state=applied, check ok). The only error was the expected 400 from the stale apply.

Ruling out other explanations:
- docs/auto-team.md:159 says only "Code Flow rejects stale comparisons and preserves your branch and staging area". Nothing says choices or typed text are dropped.
- The existing e2e test (test/e2e/task-team.e2e.ts:176-178) clicks Edit result and fills the …

</details>

### t11-16 · minor · Import browser library does not say which saved settings were dropped

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features TEAM-29.

**Repro**

> 1. Save a browser task preset (dialog says it saves checks and run settings). 2. Advanced -> Import browser library.

**Expected:** Note listing what was not imported (checks/verification/container run settings, approvals, limits), as returned by the server.

**Actual:** Toast only 'Imported N templates. Browser originals retained; permissions were not imported.'; the server's notes array is ignored and run settings silently dropped.

**Root cause (verifier):** Two parts.

1. The UI throws away the server's notes. In /Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team-template-library-view.tsx:94 the response is typed `post<{ imported: number }>` and only `result.imported` is read. Line 96 then shows a hard-coded toast: "Imported N templates. Browser originals retained; permissions were not imported." The `notes` array is never shown.

2. The server's notes are incomplete. /Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/team-template-store.ts:61 returns one fixed note listing permissions, approval settings, credentials, host bindings and spending limits.
   - Lines 67-69 copy only `entry.config.{roles,options,agentSettings,roleSettings}` into `preferences`.
   - These are dropped without any note: `config.check`, `config.setup`, `config.baseRef`, `config.contextBudget` (which `applyPreset` at ui/onboarding.tsx:81-85 treats as behaviour, not authority) and `entry.runOptions.verification` / `runOptions.container`.
   - The note is also the same whatever the entries actually contained.
   - Contributing: the save dialog text at ui/onboarding.tsx:271 promises "checks and run sett …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team-template-library-view.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/team-template-store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/auto-team.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/team-templates.test.ts`

**Suggested fix:** 1. Server, src/team-template-store.ts `migrate`: build the notes from what each entry actually contained.
   - For each entry, record any non-empty value in `config.check`, `config.setup`, `config.baseRef`, `config.contextBudget`, `config.trust`, `config.toolApprovals`, `config.approvePlan`, `config.limits` and `runOptions.verification` / `runOptions.container.enabled`.
   - Add one note per entry, for example: "MQTT fix preset: verification command, Thorough verification profile and Docker isolation were not imported; they remain in the browser library." Keep the general permissions note.
   - Optionally list them in the migrated template's description as well, so the information survives after the toast is gone.
2. UI, ui/team-template-library-view.tsx:89-97: type the response as `{ imported: number; notes: string[] }` and collect the notes from both the personal and project scopes.
   - Show them in a persistent `<div role="status">` or `<ul>` inside the Reusable team templates sect …

**Suggested regression test:** 1. test/team-templates.test.ts (store level): migrate a v1 composer library whose template has `config.check="npm test"`, `config.setup="npm ci"` and `runOptions:{verification:"thorough", container:{enabled:true,image:"x",authVolume:""}}`. Assert that `result.notes.join(" ")` matches /verification command|check/i, /thorough|verification profile/i and /isolation|container|docker/i, and names the entry. Then migrate a preset with no such settings and assert no per-entry dropped-settings note is ad …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4633m on http://127.0.0.1:4633 with a fresh browser profile; no runs were created. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4633m/repro.mjs, log in repro.log in the same folder.

1. Opened the MQTT-MCP new-run composer (#/project/p-ef01794b/new) and Advanced. Chose the "race" workflow, typed the task "Fix {{issue_id}} in the MQTT client", set "Done when this passes" to `cd mqtt-python && uv run pytest -q`, set Verification gates to Thorough, and turned on "Run agents in a prebuilt Docker image" with image qa/agents:test.
2. Clicked "Save task preset" and saved to the personal library. The dialog says: "Saves the task, acceptance criteria, workflow, agents, models, permissions, checks and run settings in this browser."
   - localStorage composerLibrary then held config.check="cd mqtt-python && uv run pytest -q", trust=standard, limits {240 min, 200 steps}, and runOptions {verification:"thorough", container:{enabled:true, image:"qa/agents:test"}}.
3. Advanced -> Reusable team templates -> "Import browser library".
   - POST /api/team-templates/migrate returned 200 {"imported":1,"notes":["Original browser library retained. Role/model preferences and workflow options preserved. Run permissions, approval settings, credentials, host bindings, and spending limits were not imported."]}.
   - The only feedback was the toast "Imported 1 templates. Browser originals retained; permissions were not imported." Nothing in the library section showed the notes (screenshots 003-after-import.png and 004-migrated-selected.png in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4633m/).
   - The saved server template legacy-e64ae55c698f06316bd8ad90 kept only workflow=race, task "Fix {{issue-id}} in the MQTT client" and preferences {roles, options:{}, agentSettings:{}, roleSettings:{}}. The check command, setup, base branch, Thorough verification profile and Docker isolation were all gone, and nothing told the user. Selecting the template shows only "Migrated task/workflow template; original settings remain in the browser backup."
   - No console errors or 5xx responses.

Attempts to refute:
- The closed schema rejects these fields on purpose (src/team-templates.ts:75: "Template preferences may contain only roles, options and model settings"), so dropping them is by design.
- But docs/dyna …

</details>

### t11-17 · minor · 'Save as team template…' dialog embeds the whole library with unrelated actions and a blank selector

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features TEAM-30.

**Repro**

> 1. Finished Auto team run -> More run actions -> Save as team template….

**Expected:** A focused editor for the run's template.

**Actual:** Dialog shows 'Saved templates' select with a blank value plus 'Design a template', 'Save current workflow as template' (uses the composer's current workflow, not this run), 'Import template', 'Import browser library'.

**Root cause (verifier):** ui/run.tsx:2390-2392: SaveStrategyDialog renders `<TeamTemplateLibrary initial={template} />`, which is the whole library component the composer uses in Advanced (ui/composer.tsx:385). The menu item at ui/run.tsx:252-256 builds the run-derived template and passes it in as `initial`.

ui/team-template-library-view.tsx:16-110 has no mode for this. `initial` only seeds the state (selected, editing and draft at lines 20-22). The component always renders:
- the "Saved templates" select (lines 72-75), with `value={selected?.id ?? ""}`. The new run id (strategy-<ts>) matches no option, so the browser shows a blank select with selectedIndex -1. Its onChange calls setSelected(t ?? null) and setEditing(false), which throws away the run draft.
- the library action row (lines 85-99): "Design a template" (edit(fresh(project))), "Save current workflow as template" (lines 86-89), "Import template" and "Import browser library". "Save current workflow as template" reads the composer's global `pattern`/`task`/`rolesFor`/`optionsFor` signals from ui/state.ts, not the run's. It appears whenever the composer pattern is not auto-team, and the fresh-browser default is "solo" (ui/state.ts:640).
- "Close e …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team-template-library-view.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/auto-team.e2e.ts`

**Suggested fix:** Give the save-from-run case its own focused editor:
- Pull the editing block out of TeamTemplateLibrary (team-template-library-view.tsx lines 101-107: name field, "Allow Auto to reuse" checkbox, the definition textarea with validation, the execution preview and the Publish button) into an exported `TeamTemplateEditor({ template, expectedVersion = 0, onPublished })` component. TeamTemplateLibrary then uses that component inside its own editing branch, so the composer keeps its current behaviour.
- In ui/run.tsx SaveStrategyDialog, render `<TeamTemplateEditor template={template} onPublished={saved => { showToast(...); onClose(); }} />` instead of `<TeamTemplateLibrary initial={template} />`. The dialog then has no saved-templates select, no Design/Import/"Save current workflow" buttons and no "Close editor". Its only actions are Publish and Close/Cancel, and the draft is visible right away under the intro text.
- If keeping one component is preferred, add a `mode: "save-run"` prop that s …

**Suggested regression test:** Add a case to test/e2e/auto-team.e2e.ts next to the existing library test (around line 86). Finish a fake auto-team run (for example with task "AUTO-SAME-PROVIDER ..."), open More run actions, click "Save as team template…", and scope to `page.getByRole('dialog', { name: 'Save reusable team strategy' })`. Assert:
- the dialog has no `#team-template-select` / "Saved templates" combobox,
- it has no buttons named "Design a template", "Save current workflow as template", "Import template", "Import  …

<details><summary>Verifier's independent reproduction</summary>

Fresh home v4635s, fake mode, port 4635 (qa-server.sh start v4635s 4635 fake). Created a scratch git fixture (qa/clones/v4635s-fx) and registered it as a project through the API. Started an auto-team run through the API with task "AUTO-SAME-PROVIDER implement the sample", coordinator claude, pool claude+codex and plan approval off. It finished with status done and a team with tasks alpha and beta.

Then, in a FRESH headless browser with no profile and empty localStorage (so this is not leftover state from the tester's profile), I opened #/run/<id> and clicked More run actions, then "Save as team template…". Script: qa/work/v4635s/repro.mjs. Screenshot: qa/shots/v4635s/001-save-as-template-fresh.png. What I saw:
- The dialog "Save reusable team strategy" embeds the full "Reusable team templates" section. The "Saved templates" select reads value="" with selectedIndex=-1, so it shows blank. Its only option is "Choose a saved template".
- The dialog buttons are: Design a template, Save current workflow as template, Import template, Import browser library, Publish template version, Close editor, Close.
- The run-derived draft is present but sits below the fold. The dialog body has scrollHeight 1203 and clientHeight 541.

Clicking "Save current workflow as template" replaced the run's draft with {name:"Agent template", workflow:"solo", roles:[], tasks:[]}. That comes from the composer's default pattern "solo", not from this run. Screenshot: 002-after-save-current-workflow.png.

I also found worse behaviour than the report describes:
- Choosing the placeholder in the blank select calls setSelected(null) and setEditing(false). The run-derived draft is discarded and the editor disappears. Only the library buttons and Close remain, and nothing in the dialog brings the draft back (screenshot 003-after-select-placeholder.png).
- "Design a template" and "Close editor" also silently replace or hide the run draft.

There were no console or API errors.

Not by design: docs/auto-team.md:17 says "The run menu's **Save as team template…** opens an editable preview", and docs/dynamic-teams-implementation-plan.md:125 says "Preview parameterized inputs, roles, steps, and guarantees before saving". Neither describes a full library.

Not an environmental or tester-script problem: it reproduces in a fresh browser with default composer state. With no saved templates the select is always blank, because no option matches the new draft's id.

Cleanup: I deleted the run through the UI  …

</details>

### t12-21 · minor · Reusable team version limit error is generic ('Invalid reusable team history')

Source: tester unit project-missions-1; observed with api; features MIS-17.

**Repro**

> POST /api/project-teams/definitions to create a team, then POST 100 new versions; the 101st save fails.

**Expected:** 'This reusable team reached its 100-version limit; create a new team.'

**Actual:** 400 'Invalid reusable team history'.

**Root cause (verifier):** src/agent-team-definitions.ts:17. validate() puts `r.versions.length > 100` into one big integrity check together with real corruption tests (bad version, bad timestamps, versions/operations length not matching revision). All of them throw the same generic `new Error("Invalid reusable team history")`. That check is meant for corrupt files at load (line 44).

save() (lines 64-90) has no limit check of its own before it builds `next` with revision = before.revision + 1 (line 76). It then calls `validate(next)` (line 79) as a self-check, so a normal 101st save hits the corruption message. The friendly "Reusable team history is full" at line 80 only covers the 2 MiB size limit and is never reached here. src/project-teams-api.ts:35 turns the thrown message into a 400 unchanged, and ui/agent-team-library.tsx:34 shows it unchanged in the form's role=alert.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/agent-team-definitions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/agent-team-library.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`

**Suggested fix:** 1. In AgentTeamDefinitions.save(), add an explicit check after the operation-replay and revision-conflict checks and before building `next`. Return 409 so a client can tell a limit from a validation error, for example:
```ts
if (before && before.versions.length >= MAX_VERSIONS) throw new ProjectTeamConflict("This reusable team reached its 100-version limit. Create a new reusable team to keep editing.")
```
2. Move the 100 into a named constant (MAX_VERSIONS = 100) shared by validate() and save().
3. Keep the generic message in validate() for files that really are corrupt at load.

Optional UI improvement in ui/agent-team-library.tsx: when team.revision >= 100, disable "Edit reusable team" or show a "version limit reached — create a new team" hint. Ideally add a way to start a new team from this team's configuration, since the API has no delete or prune for definitions.

**Suggested regression test:** Add a test in test/project-teams.test.ts next to "reusable teams have durable versions...":
1. Load an AgentTeamDefinitions on a temp directory, save a definition, then save 99 more versions, passing the current revision each time. Assert the revision is 100.
2. Assert that a 101st save rejects with a message matching /100-version limit/ and does not match /Invalid reusable team history/. If ProjectTeamConflict is used, also assert status 409.
3. Assert that get(id).revision is still 100, that a …

<details><summary>Verifier's independent reproduction</summary>

I started a fake-mode QA server (v4693, port 4693) on a fresh home. The old v4693 home was moved aside first and put back afterwards. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4693/t12-21.mjs. Output: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4693/t12-21.log.

Steps:
1. Created the team in the UI: opened #/project/p-ef01794b/automation/missions (MQTT-MCP), expanded "Reusable agent teams", clicked "Create agent team", entered the name "v4693 limit team" and clicked "Save reusable team". This made at-1d9af9bfaaf81e331cda81b5 at revision 1.
2. Sent 99 POST /api/project-teams/definitions/<id> requests with the correct revision each time. All returned 200, ending at revision 100. The card shows "version 100".
3. Did the 101st save in the UI: "Edit reusable team", changed the name, clicked "Save new team version". The POST returned 400 {"error":"Invalid reusable team history"}. The form shows "Invalid reusable team history" as its alert (screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4693/002-v101-error.png). The message doesn't mention the limit or say what to do. The save button stays enabled, and nothing on the card warns that the limit is close.
4. A direct API 101st save with a new operationId gave the same 400. A GET afterwards still showed revision 100 with 100 versions, the faults list was empty, and an idempotent replay of operation 100 returned 200. Nothing was damaged; only the message is wrong.

Why this is not by design or an environment problem: docs/project-teams.md:75 documents the limit itself ("at most 100 definitions, 100 versions per definition and a 2 MiB per-definition ceiling"), but not this message. The code next to it uses clear, specific messages for the other limits: "The reusable team library is full" (100 definitions) and "Reusable team history is full" (2 MiB). Standing-team history uses "Standing team history is full; archive this team...". The wording "Invalid" suggests corrupt data, the same family of messages that load() reports as storage faults. The tester's script was correct, and I reproduced the result from a fresh home through the real UI.

</details>

### t10-6 · minor · Template prefill in AI team setup drops the pool model when the coordinator uses the same provider

Source: tester unit ai-teams-patterns-1; observed with fake-agents; features TEAM-02.

**Repro**

> 1. Create a team template whose preferences include roleSettings {pool:{codex:{model:'gpt-b'}}, coordinator:{codex:{effort:'low'}}} and roles {coordinator:['codex'], pool:['codex','claude']} (I created it through POST /api/team-templates).
> 2. AI team -> Advanced -> Template 'QA feature team · v1'.

**Expected:** Codex keeps model GPT-B with effort low (or the conflict is surfaced).

**Actual:** Codex shows 'Default model | low'; the saved preferences have codex {effort:'low'} only, so the model is lost. Lead, providers and the maxMembers clamp (9->6) are prefilled correctly.

**Root cause (verifier):** ui/task-team.tsx:83, in the TaskTeamDialog template onChange handler. It builds `settings: { ...draft.settings, ...prefs.agentSettings, ...prefs.roleSettings.pool, ...prefs.roleSettings.coordinator }`. This spread works one provider at a time, so a later role's whole entry replaces the earlier one: coordinator {codex:{effort:'low'}} replaces pool {codex:{model:'gpt-b'}}, and agentSettings.codex would be replaced the same way.

The engine combines settings one field at a time instead, for example src/engine.ts:1214 `coordinator: { ...settings[id], ...this.run.roleSettings.coordinator?.[id] }`.

TaskTeamConfig only has per-provider `settings`. When the team starts, runTaskTeam passes `agentSettings: config.settings` (src/engine.ts:3950) and no roleSettings. So the UI prefill is the only way template model preferences reach the run. With the model dropped, every Codex member (lead and pool workers) runs on the provider's default model instead of gpt-b. That last point comes from reading the code; the UI result and the saved value were reproduced.

**Files:** `ui/task-team.tsx`, `src/task-team.ts`, `src/engine.ts`, `test/e2e/task-team.e2e.ts`

**Suggested fix:** Minimal fix in ui/task-team.tsx:83: merge one field at a time for each provider, in the same order as before (draft, then agentSettings, then pool, then coordinator).
- For example: `const merged = { ...draft.settings }; for (const layer of [prefs.agentSettings, prefs.roleSettings.pool, prefs.roleSettings.coordinator]) for (const [id, s] of Object.entries(layer ?? {})) merged[id] = { ...merged[id], ...pick(s, ['model','effort']) };`.
- Only model and effort should be copied. TaskTeamConfig settings carry no variants.
- When the coordinator and pool set different values for the same field of the same provider, show a short help note saying which value the AI team will use. The team stores one setting per provider.
- Fuller fix: add optional per-role settings ({coordinator?, pool?}) to TaskTeamConfig, validated in src/task-team.ts, and pass them as roleSettings in runTaskTeam's start call (src/engine.ts:3950). The engine already applies coordinator and pool role settings separately, so t …

**Suggested regression test:** Extend test/e2e/task-team.e2e.ts, which currently seeds only a template with empty roleSettings.
- Seed a template with preferences.roles {coordinator:['codex'], pool:['codex','claude']} and roleSettings {pool:{codex:{model:'gpt-b'}}, coordinator:{codex:{effort:'low'}}}.
- Select it under Advanced -> Team template.
- Assert that the Codex row in the dialog shows 'GPT-B' and 'low'.
- After 'Apply team settings', assert that the saved config (localStorage taskTeamPreferences or the POST /api/runs/ …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4633 on 127.0.0.1:4633 (home has no runs or templates), fresh browser with no profile and empty localStorage. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4633t106/a1.mjs, log in a1.log in the same folder.
1) Created two personal task-graph templates through POST /api/team-templates (both returned 201). Both had preferences.roles {coordinator:[codex], pool:[codex,claude]}.
   - 'v-both' had roleSettings {pool:{codex:{model:'gpt-b'}}, coordinator:{codex:{effort:'low'}}}.
   - 'v-pool' (control) had roleSettings {pool:{codex:{model:'gpt-b'}}}.
2) In the UI: New run -> AI team switch on -> Advanced -> Template 'V both roles · v1'. The dialog showed Lead=Codex and the Codex row as 'Default model | low'. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4633/001-prefill-v-both.png.
3) Apply team settings saved localStorage taskTeamPreferences.settings = {"codex":{"effort":"low"}}. The pool model gpt-b was dropped.
4) Control: selecting 'V pool only · v1' showed Codex 'GPT-B | Default effort' and saved settings {"codex":{"model":"gpt-b"}}. So gpt-b is lost only because the coordinator entry for the same provider replaces the pool entry. The fake catalog does list gpt-b/GPT-B.
No console errors or 5xx responses. No runs were created.

Refutation attempts failed:
- Not by design: docs/project-teams.md:11 says role settings let 'the coordinator and workers use different models or effort for the same provider'. docs/auto-team.md:13 says that when browser presets are migrated, 'role/model preferences and workflow options survive'.
- Not the tester's environment: a fresh profile and my own template ids give the same result.

</details>

### t10-5 · minor · With Auto team disabled on the server, the chat 'AI team' toggle still turns On and Send then fails

Source: tester unit ai-teams-patterns-1; observed with fake-agents; features TEAM-01, TEAM-06.

**Repro**

> 1. Start the server with CODEFLOW_AUTO_TEAM_ENABLED=false.
> 2. New run in Agent mode: the 'AI team' switch is enabled and turns On.
> 3. Type 'Implement the alpha feature.' and Send.

**Expected:** The toggle is disabled with the reason (as the Team workflow in Advanced shows 'Team is disabled on this server'), or the conversation falls back to the single agent.

**Actual:** POST /api/runs 400; composer shows 'Team is disabled on this server' after Send and the message is not sent. The Advanced Team workflow correctly shows the problem before Start.

**Root cause (verifier):** The server gate is src/engine.ts:5097 (startResolved: `if (input.taskTeam.enabled && !autoTeamEnabled()) throw new Error("Team is disabled on this server")`) and src/engine.ts:3870 (configureTaskTeam). The UI never mirrors it for the in-chat team toggle.

- ui/task-team.tsx:43 and :51: TaskTeamControl decides enabled/disabled only from the `disabledReason` prop and `busy`. It never reads `teamRollout` (ui/state.ts:43, loaded at startup in ui/main.tsx:83).
- ui/composer.tsx:315 passes a disabledReason only for remoteWorker/container.
- ui/run.tsx:2000 passes no disabledReason at all.
- ui/composer.tsx:187 (`problem`) and :545 (startProblem) check rollout only when `p?.id === "auto-team"`, not when the solo pattern carries `taskTeam.enabled`.
- ui/composer.tsx:202 still sends `taskTeam` unchanged in the run body, so an enabled team config always reaches the server and gets the 400.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/task-team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/task-team.e2e.ts`

**Suggested fix:** 1. In TaskTeamControl (ui/task-team.tsx), compute `rolloutOff = teamRollout.value?.enabled === false`.
   - Block only turning the team On: when rolloutOff is true and the current value is not enabled, disable the switch with title/reason "Team is disabled on this server. New AI teams can't start; Standalone workflows remain in Advanced."
   - Turning an already-enabled team Off must stay allowed. configureTaskTeam accepts enabled:false, and docs say existing teams stay resumable.
   - Merge this with the existing `disabledReason` prop, so both the composer (composer.tsx:315) and the run chat (run.tsx:2000) get it with no per-caller duplication.
2. In the composer, make the run body fall back to the single agent when rollout is off:
   - composer.tsx:202: send `taskTeam: single && !remoteWorker && !containerEnabled && teamRollout.value?.enabled !== false ? taskTeam : undefined`. Alternatively, add `(single && taskTeam?.enabled && rolloutOff) ? "Team is disabled on this server. Turn AI  …

**Suggested regression test:** Add a case to test/e2e/task-team.e2e.ts, or a sibling rollout e2e, that spawns the server with `CODEFLOW_AUTO_TEAM_ENABLED: "false"` in its env.

- In a new Agent composer, assert that `getByRole("switch", { name: "AI team", exact: true })` is disabled and its title contains "Team is disabled on this server".
- Seed composer state or localStorage with an enabled taskTeam, fill the task and click Send. Assert either: no POST /api/runs is made and a composer problem is shown, or the POST body has  …

<details><summary>Verifier's independent reproduction</summary>

Fresh QA home (the old v4629 home was moved to homes/v4629-prev-t1114). I exported CODEFLOW_AUTO_TEAM_ENABLED=false and ran `qa-server.sh start v4629 4629 fake`. GET /api/team-rollout returned {"enabled":false,"stage":"experimental",...}. I registered a scratch git repo (clones/v4629-fx) as project v4629-fx.

Script r1.mjs used a FRESH browser profile, so stale localStorage and the reporter's setup are ruled out. Steps: choose project v4629-fx, then New run, Agent mode.
- The 'AI team' switch is enabled (disabled=false, title "Turn AI team on", aria-checked=false). Clicking it gives aria-checked=true, "AI team On".
- I typed "Implement the alpha feature.". Before Send there was no .composer-problem and Send was enabled (shots/v4629/004-toggle-on.png).
- Send made POST /api/runs with pattern "solo", taskTeam {enabled:true,...}. The server answered 400 {"error":"Team is disabled on this server"}.
- The page stays on #/project/.../new and the switch still shows "AI team On". A red "Team is disabled on this server" line appears under Run options with no hint to turn the team off (shots/v4629/005-after-send.png). The task text is kept and no run is created (0 runs on the server).

Control (r2.mjs, same server):
- Advanced > workflow "auto-team": the composer correctly shows "Team is disabled on this server. Choose Agent or a template in Advanced." and Start is disabled before you click it.
- Agent mode with the toggle Off: Send started a solo run normally (201).
- In that run's chat view the 'AI team' switch is also enabled. Clicking it gives POST /api/runs/<id>/task-team 400 "Team is disabled on this server". This time the switch stays Off with an inline alert (shots/v4629/002-run-view-toggle.png). That is the same root cause, but the failure is less confusing there.

Not by design:
- docs/configuration.md:153 and docs/auto-team.md:117 say the flag disables creating new Auto team runs. Neither says the chat toggle should stay available.
- The UI already pre-checks the flag for the Advanced Team workflow (composer.tsx:187, :545), so the chat toggle is an inconsistent gap.

Severity stays minor:
- It only happens on hosts that set the non-default opt-out flag.
- The server rejects the request safely and the message text is preserved.
- The UX is misleading: the switch shows On, the error appears only after Send, and there is no guidance or fallback.

Cleanup:
- The test run was deleted through the UI (bulk Select > Delete).
- The server was stopped and ports 462 …

</details>

### t11-13 · minor · 'Resume team' button stays visible when AI team is off and only errors when clicked

Source: tester unit ai-teams-patterns-2; observed with fake-agents; features TEAM-23.

**Repro**

> 1. Chat team with 'AUTO-FAILURE Implement the sample' -> 'Stopped · work preserved' + 'Resume team'. 2. Turn the AI team switch off. 3. Click 'Resume team'.

**Expected:** Button hidden/disabled with an explanation, or Resume offers to re-enable the team.

**Actual:** Button still shown; click shows 'Enable Team before resuming its work'.

**Root cause (verifier):** - ui/task-team.tsx:122 (TaskTeamActivity) renders `<TaskTeamRecovery … stopped={!!child && child.status !== "done"} …/>` whenever `!active && run.status === "done"` and this is the last turn. It never reads the owning task's team config: `runs.value.get(chatTaskId(run))?.taskTeam?.enabled`, the same value TaskTeamControl at :28-29 uses for the switch.
- ui/task-team.tsx:126-130 (TaskTeamRecovery): when `stopped` is true it always renders an enabled "Resume team" button that POSTs `/team-resume`. Its `error` state is only cleared on the next click, so after the team is turned back on the old alert stays visible.
- src/engine.ts:4067 (resumeTaskTeam): `if (!this.require(chatTaskId(run)).taskTeam?.enabled) throw new Error("Enable Team before resuming its work")`. This is the intended guard and becomes the 400 through src/server.ts:2523. Its wording ("Team") also doesn't match the control's label ("AI team").
- Only the Resume path needs the team enabled. recheckTaskTeam (src/engine.ts:4131) and refreshTaskTeamReview (:4106) don't check `enabled`, so "Check again" and "Refresh review" are correct to stay available.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/task-team.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/task-team.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/team-recovery.test.ts`

**Suggested fix:** 1. In TaskTeamRecovery, add `const owner = runs.value.get(chatTaskId(run)) ?? run, teamOn = !!owner.taskTeam?.enabled;`, the same lookup TaskTeamControl uses. When `stopped && !teamOn`, do one of these:
   - (a) Render the button disabled, with help text such as "Turn on AI team to resume its preserved work", linked through aria-describedby.
   - (b) Preferred, matching the reporter's suggestion: render "Turn on AI team and resume". It POSTs `/api/runs/${run.id}/task-team` with `{ ...owner.taskTeam, enabled: true }`, updates `runs.value`, then POSTs `/team-resume`. If the resume fails, it shows the error and leaves the team on, so a retry is one click.
2. Leave the checkFailed and reviewStale branches unchanged; they don't need the team enabled.
3. Clear the stale alert: `useEffect(() => setError(""), [teamOn, execution])`.
4. Change the engine message at src/engine.ts:4067 to "Turn on AI team before resuming its work" so it matches the UI label. That covers API callers and any race.

**Suggested regression test:** - **test/e2e/task-team.e2e.ts**, new case:
  - Start an Agent chat with the AI team switch on and send "AUTO-FAILURE Implement the sample". Wait for the `.task-team-disclosure > summary` text "Stopped · work preserved".
  - Turn off `main.getByRole("switch", { name: "AI team", exact: true })`.
  - Assert the `.task-team-recovery` Resume button is disabled (or relabelled "Turn on AI team and resume") and the "Turn on AI team" help text is visible.
  - Assert no `POST …/team-resume` request was se …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4627 (`qa-server.sh start v4627 4627 fake`, 0 runs loaded). I made my own tiny fixture repo (a copy of the t11-fx files, `git init`) at scratchpad/qa/clones/v4627-fx and registered it as project "v4627 fixture" (p-4edd1c90) through the API, as setup only. Everything else was done in the UI with a fresh headless Chrome (no saved profile, so no stored team preferences), using scripts /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4627/r1.mjs and r2.mjs (logs r1.log and r2.log in the same folder).

1. New chat in the fixture project. The composer's AI team switch starts off; I turned it on and sent "AUTO-FAILURE Implement the sample". Chat 2610251946-1e92fa28 finished as done; team execution 2610251946-e8dba412 ended stopped; turn state "applied". After a reload the thread shows "Stopped · work preserved 0/1 complete" and an enabled "Resume team" button. The run-view switch reads "AI team On".
2. Clicked the run-view "AI team" switch: POST /task-team returned 200, the switch now reads "AI team Off", and the API shows `taskTeam.enabled=false`. "Resume team" is still shown and still enabled (isDisabled=false). The same holds after a page reload.
3. Clicked "Resume team": POST /api/runs/2610251946-1e92fa28/team-resume returned 400. An inline alert reads "Enable Team before resuming its work" and the console logs "Failed to load resource ... 400". Run state is unchanged (parent done, execution stopped, retries 0). Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4627/002-02-team-off-button-still-shown.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4627/003-03-after-click-error.png.
4. Extra finding (r2.mjs): clicked Resume while off (same alert), then switched AI team back on without reloading. The stale "Enable Team before resuming its work" alert stays next to the now-valid button (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4627/001-04-on-again-stale-alert.png). Clicking Resume then works: parent goes to running, the alert clears, execution steps go 9 -> 12, retries 1.

Why this is not refuted:
- Not by design: docs/auto-team.md:3 and docs/plans/agent-mode-validation.md:125/175 only say that turning Tea …

</details>

### t10-10 · minor · Lead model quick picker offers Antigravity with tool approvals on; Send then refused with a generic 400

Source: tester unit ai-teams-patterns-1; observed with real-agents; features TEAM-01.

**Repro**

> 1. Real server, Agent mode with the default 'Ask for approval'.
> 2. AI team On -> Lead model picker -> 'Antigravity CLI · Default model'. It is accepted and saved.
> 3. Send 'hi'.

**Expected:** Same guard as the AI team setup dialog: agy is not offered as lead (or a clear error before Send) while approvals are on.

**Actual:** POST /api/runs 400 'Antigravity managed execution requires the verified local macOS executor and existing Keychain login...'; the conversation isn't created. The Advanced dialog blocks the same choice with a clear message.

**Root cause (verifier):** - **Quick picker has no approvals check.** In ui/task-team.tsx:42-46, TaskTeamControl builds the "Lead model" options by filtering only on teamProviderProblem(agent.id, nativeAgy) (lines 12-20). That function checks installed, signed-in, compatible and managedCompatible, but not tool approvals. The approvals guard exists only inside TaskTeamDialog (ui/task-team.tsx:70, permissionProblem), which also disables Apply (line 101). The ModelSelect onChange at ui/task-team.tsx:51-54 saves coordinator "agy" with no check.
- **The composer applies the choice as-is.** Its onChange (ui/composer.tsx:315) calls setRoles(..., [next.coordinator]) and leaves toolApprovals at true. This differs from ChatControls' provider menu, which resets tools to false for agy (ui/chat-controls.tsx:37).
- **Send is never disabled for this case.** startProblem (ui/composer.tsx:544-573) has no rule for agy combined with tool approvals.
- **Where the 400 comes from.** The server rejects the request in engine.ts:5216-5218 (task-team provider loop) and engine.ts:5222 (initial roles). Both call resolveRunPermissions, which throws AGY_MANAGED_PERMISSION_PROBLEM at src/run-permissions.ts:82 (policy.toolApprovals && curr …

**Files:** `ui/task-team.tsx`, `ui/composer.tsx`, `src/run-permissions.ts`, `test/e2e/task-team.e2e.ts`

**Suggested fix:** 1. **Shared check.** In ui/task-team.tsx, pull the dialog's permissionProblem logic into a helper, e.g. teamPermissionProblem(config, toolApprovals). Use it in both TaskTeamDialog and TaskTeamControl.
2. **Quick picker.** Work out approvals = toolApprovals ?? !!run?.approvals.tools, the same way the dialog does. When approvals are on and Antigravity is not running natively, either drop the agy options or label them (ModelOption has a `description`; a disabled flag could be added) with "Requires turning off Ask for approval". If the saved lead is already agy while approvals are on, show the same role=alert text next to the toggle.
3. **Composer Send guard.** Add a check to the composer's `problem`, or to startProblem, so that a solo or lead agy with toolApprovals on (and not native) disables Send. Its title should say why, e.g. "Antigravity doesn't support Ask for approval. Choose Claude/Codex or change permissions." This also covers the leftover state after the team is turned off. If y …

**Suggested regression test:** Add a non-live test to test/e2e/task-team.e2e.ts next to "new tasks expose a clear Team toggle, lead-only controls and searchable branches".
- Setup: route /api/doctor (or the health endpoint the test at line 106 already patches) so agy has installed, compatible, signedIn and managedCompatible all true. Start with approvals on, either through localStorage interactiveApprovals="1" or a Claude solo default.
- Steps: turn AI team on, then open "Lead model".
- Assertions:
  - No "Antigravity CLI ·"  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh real-mode QA server ("qa-server.sh start v4631t 4631 real", new home homes/v4631t). Real mode was needed because the fake agy reports version 1.3.6, which fails the managed-compatibility check, so the fake never offers Antigravity in the picker. The failure happens at POST /api/runs before any agent starts, so no subscription quota was used. I drove the app in headless Chrome with a fresh profile. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4631t/ (repro.mjs, compare.mjs; logs repro.log, compare.log).

Steps:
1. Chose project MQTT-MCP. The composer showed "Claude Code · Default model · Default effort · Ask for approval". Approvals are on by default for a Claude solo agent on a fresh profile (ui/composer.tsx:139).
2. Turned AI team on and opened the Lead model picker. It listed 20 options, including all 7 "Antigravity CLI · …" entries (shot 002-lead-options.png).
3. Picked "Antigravity CLI · Default model". It was accepted and saved: taskTeamPreferences = {"enabled":true,"coordinator":"agy",...}. No warning appeared, and the permissions control is hidden while the team is on.
4. Typed "hi". Send stayed enabled with the title "Start run (⌘↵)". I clicked Send.
   - The request body had taskTeam.coordinator "agy", roles.agent ["agy"] and approvals {"tools":true}.
   - The response was 400: {"error":"Antigravity managed execution requires the verified local macOS executor and existing Keychain login. Remote/container execution and interactive approvals are unsupported. Choose Claude or Codex for other environments."}
   - No run was created (0 before and after). The red text appeared under Run options (shot 004-after-send.png).
5. For comparison I opened Advanced with the same state. TaskTeamDialog showed the alert "This task requires interactive tool approvals, which Antigravity does not support. Choose Claude or Codex, or change the task's permissions before enabling Antigravity." and "Apply team settings" was disabled.
6. Extra problem: I turned AI team off. The plain composer now showed "Antigravity CLI · Default model · Default effort · Ask for approval" (shot 002-team-off-agy-approval.png). The normal provider menu cannot produce that combination, because ChatControls clears tools when you pick agy (ui/chat-controls.tsx:37). Send again returned the same 400, and still no run was created.

Why it is not by design or a tester artifact:
- The docs  …

</details>
