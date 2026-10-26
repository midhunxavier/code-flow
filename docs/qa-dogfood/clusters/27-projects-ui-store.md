# Cluster 27 · projects-ui-store

**Projects: moving chat runs, Repositories tab, stale edits, unreadable drafts/projects.json**

Status: **fixed and verified** · 9 issues · branch `codex/qa-projects-ui-store`

Planner notes: t01-3 (major): ProjectChip/MoveDialog is rendered only inside RunMeta, which is hidden for chat runs (ui/run.tsx:498), so Single-agent runs can't be moved. Render the chip for chats. t01-12: the Repositories tab's 'Add repository' reuses the onboarding flow, which creates a new project and ends in the composer. t01-5: the project overview checks only the draft currently loaded in the composer. t26-3: renaming a project or editing its repositories is last-write-wins; add revision checks (src/projects.ts, server, ui/projects.tsx:144). t00-11: #/project/<missing>/new hides the 'project unavailable' notice when no repo is set. t00-18: one unreadable saved draft locks the composer for every project (a single try in initializeProjectDrafts, ui/state.ts). Store faults: t26-7 a corrupt projects.json is set aside silently, so tell the UI; t26-8 'projects off' blocks every new run and the message wrongly blames reading; t01-13 DELETE returns 500 where rename returns 400 for the same storage error.

Likely files: `ui/projects.tsx`, `ui/run.tsx`, `ui/project.tsx`, `ui/state.ts`, `ui/project-context.ts`, `src/projects.ts`, `src/server.ts`, `src/engine.ts`, `ui/composer.tsx`


## Fix and verification — 2026-10-26

Implemented from integration `29de9df` in `/private/tmp/codeflow-qa-projects-ui-store`; only isolated scratch repositories, fake providers and fake GitHub state were used. No live 60c0 builds/server operations, real project mutations, pushes, or `~/.codeflow` reads/writes.

| Issue | Resolution and replay |
| --- | --- |
| t01-3 | ProjectChip is in the always-visible run header. Moving a provider tab moves its entire `chatTaskId` family, including side chats and delegated executions; a side chat cannot move independently. Real browser replay moved a solo owner, provider tab and side chat from Alpha to Beta and checked API membership plus breadcrumb; a pipeline header also exposes the chip. |
| t01-12 | Project Overview/Repositories Add repository uses a dedicated membership flow, selects the repository tools and stays on Repositories. Both a new member and an existing member were exercised; project count and the existing composer draft stayed unchanged. |
| t01-5 | Overview reads a saved draft without switching the active composer. A→B→A Overview, reload, Continue draft and returning to B preserve both texts. |
| t26-3 | Metadata revisions default to 0 for legacy records and advance for name/repository edits, includes and placement. The editor sends its captured revision; 409 keeps its form, shows the current saved project and offers an explicit reload. Two browser contexts proved stale rename cannot restore a removed repository; API include while the editor is open cannot be overwritten. Defaults/no-op changes do not create metadata conflicts. |
| t00-11 | Missing-project warnings appear after project inventory loads, even with no repository. Send explains the unavailable destination and stays disabled. Choose destination opens the project picker; an empty destination draft can carry the missing project's text while the original draft stays retained. Existing destination drafts retain precedence. |
| t00-18 | Read errors/unsupported formats are tracked per draft key and protected from autosave. Startup still initializes healthy draft navigation; a failed switch returns to the usable draft and retains a stable recovery notice. Browser replay covers corrupt localStorage fallback, unsupported IndexedDB format on switch and on startup, persistence/reload of a healthy draft, and unchanged corrupt bytes. |
| t26-7 | `/api/health.projects` exposes storage availability, recovery reason and backup basename. The composer names the retained backup and manual recovery steps rather than first-project onboarding. Both invalid JSON and a partially usable project list have storage regressions; real browser verifies the corruption notice and retained original file. |
| t26-8 | Read failure and failed set-aside carry distinct causes/error codes. With projects off, the composer can open a repository and launch an explicitly unassigned run; it does not weaken normal explicit project/membership validation. Fresh profile with invalid immutable JSON and returning profile with unreadable storage both launched through the UI. |
| t01-13 | Typed storage errors map create/update/include/delete failures to 500 and server logs; validation remains 400 and revision conflict 409. Permission-denied HTTP replay checked all four operations, all four log entries and byte-identical committed storage after rejection. |

An adjacent timing defect was reproduced during the recovery flow: the folder picker closed while its asynchronous destination lookup/restoration was still pending. Immediate typing could be replaced by that restore. The picker now awaits selection before exposing the composer; the new flow and all 13 original project-navigation tests pass.

Evidence directory: `/private/tmp/codeflow-qa-continue/work/projects-ui-store/`.

- `store-before.log`: four original contract failures on unchanged product code (missing revision/recovery/typed error handling).
- `related-final.log`: **38 passed**, covering new store/draft regressions plus original Projects, project context/drafts and composer 09/10 tests. Includes read-failure EISDIR, invalid-immovable EACCES, partial recovery, failed writes and precise revision semantics.
- `original-navigation.log`: **13 passed** in 20.8s, including onboarding, existing membership conflicts, drafts/attachments, denied IndexedDB, schedules, deep links, narrow layouts/themes and accessibility.
- `ui-final.log`: **8 passed** in 27.1s, real Chrome and fresh UI build; fake providers only. `ui-observations.json` and `ui-server.log` capture browser faults and intentional storage faults. Four expected HTTP 500 writes are logged; no unexpected browser exceptions or server failures.
- `tsc-final.log`: `tsc --noEmit` passes. `git diff --check` passes.
- Screenshots: `01-solo-family-moved.png`, `02-team-header-chip.png`, `03-repository-added.png`, `04-overview-draft-after-reload.png`, `05-conflict-retains-form.png`, `06-missing-project-destination.png`, `07-corrupt-draft-healthy-project.png`, `08-unsupported-draft.png`, `09-corrupt-store-notice.png`, `10-projects-off-unassigned-run.png`, `11-unreadable-store-warm-profile.png`. The conflict/recovery screenshots were visually inspected.

Investigated failures are retained: `ui-first.log` found the picker timing defect and an ambiguous test selector (project row vs Edit button); `ui-second.log` had only a harness expectation for the unassigned URL (`#/new/unassigned` is the actual route). `ui-third.log` passes all 8 scenarios in 29.8s. No product behavior was weakened to satisfy those harness errors. The separate stop-history repair requested during this cluster is committed as `b876bf3` and documented in cluster 16, not bundled here.

Limits: fake providers verify orchestration/UI behavior, not real provider quality. Corrupt draft bytes are deliberately preserved for manual repair; no reset/delete action is introduced. Project recovery notices describe the current server session (documented in configuration); backup files remain on disk. Revision is optional for backward-compatible API clients, while UI metadata edits always supply it. No claim of testing real remote systems or real project repositories.

## Issues

### t01-3 · major · Single-agent (chat) runs cannot be moved to another project: no project chip is rendered

Source: tester unit shell-navigation-settings-2; observed with fake-agents; features SHL-30.

**Repro**

> 1. Start a run with the default 'Agent' (solo) pattern and let it finish.
> 2. Open #/run/<id> and look for the project chip ('Moving a run: click the project chip at the top of the run', docs/runs.md:81). Check 'More options' and every menu.
> 3. Compare with a Fix & review run, where the chip sits inside 'Details and publishing' at the bottom.

**Expected:** Every run, including the default solo/chat runs, can be moved through the project chip as documented.

**Actual:** Solo runs render no .project-chip and have no 'Details and publishing' section, so there is no UI path to move them. For team runs the chip is not at the top but inside the collapsed 'Details and publishing'. Move itself works for fix-review runs (toast 'Moved to t01 Doomed', 't01-MQTT-MCP joins t01 Doomed.').

**Root cause (verifier):** The only path to MoveDialog is ProjectChip (ui/projects.tsx:259-269), and ProjectChip is rendered in exactly one place: RunMeta (ui/run.tsx:498-502).
- RunMeta is mounted only inside `{!chat ? <details class="result-details"><summary>…Details and publishing</summary> … <RunMeta run={run} /><RunChips run={run} /> … </details> : null}` (ui/run.tsx:390-397).
- `chat = !!p?.chat && !run.checkpointOnFinish` (ui/run.tsx:196), and the solo pattern sets `chat: true` (src/patterns/solo.ts:18). Every default Agent conversation therefore gets no RunMeta and so no chip.
- History: commit 29628ea (desktop Agent workspace) changed `<RunMeta run={run} />` to `{!chat ? <RunMeta …/> : null}`, which hid the run metadata for chat runs and took the project chip with it. Commit 57d34c8 then moved RunMeta for team runs into the collapsed "Details and publishing" block at the bottom, so docs/runs.md:81 ("at the top of the run") is now wrong for team runs too.
- There is no other move entry point: the rail "Run actions" menu (Archive, Delete…), the command palette and the side panel offer none.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Put the project chip somewhere every run shows it, independent of the chat flag and of the collapsed details block.
- Preferred: render `<ProjectChip run={run} />` in the run header's `.run-kicker` (ui/run.tsx, next to the status pill and pattern name). It then appears at the top of every run, which matches docs/runs.md:81. Drop it from RunMeta, or keep it there only as a read-only label.
- Hide or disable it for side chats (`run.chatLink?.kind === "side"`), which stay in their parent's project.
- Optionally, also add a "Move to project…" item to the rail "Run actions" menu (ui/rail.tsx, beside Archive/Delete…) that opens the same MoveDialog. To make that possible, export MoveDialog from ui/projects.tsx.
- Chat-family detail: Agent tabs share a workspace (`chatLink.workspaceId`, ui/run.tsx:413), and RunManager.setProject (src/engine.ts:3633) moves only one run. Decide whether moving a chat tab should move its sibling tabs too. Otherwise one task's tabs end up split across projects, and …

**Suggested regression test:** Extend the project-move block in test/e2e/ui.e2e.ts (around lines 543-565), or add a case to test/e2e/project-navigation.e2e.ts:
1. Start a default composer run (AI team Off, so pattern solo and therefore a chat run) in project A.
2. On #/run/<id>, with no details expanded, assert `await page.locator(".project-chip").isVisible()`.
3. Click it and pick project B in the "Move to another project" dialog, then click Move.
4. Assert the chip text and `.crumbs-bar .crumb` read B, and that GET /api/run …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server "v4613m" on 127.0.0.1:4613 with a new home and a fresh browser profile, so no state came from the reporter. The reporter's selectors and environment play no part.
1. Opened #/project/p-ef01794b/new (MQTT-MCP). The composer defaults are AI team Off, workflow=solo. I typed a task and clicked Send, which created run 2610251840-b2a87ada (pattern solo, project p-ef01794b, checkpointOnFinish unset). It finished as "Ready to review".
2. On #/run/<id> the counts were .project-chip=0, details.result-details=0, .run-meta=0. The breadcrumb "MQTT-MCP / <task>" is a plain link to the project page, not a move control.
3. I opened every UI path I could find, and none offers a move:
   - "More options" in the result card has Mark as test run, Preview settings, Record your assessment, Show me what changed and Try two alternatives.
   - The "All chats" menu only lists the chats.
   - The rail item's "Run actions" menu has Archive and Delete….
   - The rail project's "Edit MQTT-MCP" dialog only has name, repositories and Delete project.
   - The ⌘K palette returns "No commands, projects or runs match" for "move".
   - The side panel (\) has no chip.
   - On the project's Runs page the only buttons are Share, New run, Project actions and More project tools.
   - Searching the whole page for /Move (this run|to another project)/ found 0 matches.
4. The server is not the blocker. I created "v4613 Target" via the API and sent POST /api/runs/<chat id>/project, which returned 200. The breadcrumb then showed "v4613 Target", so the missing piece is UI only. I moved the run back.
5. For comparison I ran a Fix & review run, 2610251842-b47f9a4c, which finished done. Its .project-chip exists but is hidden until the collapsed "Details and publishing" is opened. Once opened, the chip sits at y=1295 in a 900px viewport, at the bottom below the result card, not "at the top of the run" as docs/runs.md:81 says.
No console, page or 5xx errors appeared. Cleanup: I deleted both runs and the target project through the UI. Because the delete dialog keeps branches and worktrees by design, I also removed my two worktrees and codeflow/<id> branches from MQTT-MCP by exact name. I then stopped the server, and port 4613 is free.
Why this is not by design:
- docs/runs.md:81 ("Moving a run: click the project chip at the top of the run") makes no exception for Single agent runs.
- The Single agent section (docs/runs.md:57-64) says nothing about projects.
- The server's Run …

</details>

### t01-12 · minor · Adding a repository from a project's Repositories tab defaults to creating a new project and ends in the composer

Source: tester unit shell-navigation-settings-2; observed with fake-agents; features SHL-36.

**Repro**

> 1. Open #/project/<id>/repositories and click 'Add repository'.
> 2. Choose a git folder and 'Open this repository'.

**Expected:** The repository is added to this project and the user stays on the Repositories tab.

**Actual:** The 'Open repository in a project' dialog's primary button is 'Create project' (prefilled with the folder name); 'Add to <project>' is a secondary button. After adding, the app navigates to #/project/<id>/new (composer).

**Root cause (verifier):** The Repositories tab reuses the onboarding/composer 'Open repository' flow, which is built to end in the composer.

- ui/project.tsx:62: the Repositories tab's 'Add repository' button calls openRepository(id). The Overview's empty-state button at ui/project.tsx:56 does the same.
- ui/projects.tsx:340-343: openRepository() opens the folder picker titled 'Open repository' and passes the folder to pickRepo(path, project).
- ui/state.ts:320-336 pickRepo(): if the repo is already a member (326-330), it calls openComposer, then chooseComposerRepository, then sets route.value = { view: "composer" } (ui/state.ts:329) with no feedback. Otherwise it opens RepositoryChoiceDialog.
- ui/projects.tsx:345-377 RepositoryChoiceDialog: choose() always calls openComposer(project, { repository }) at line 361 after adding or creating. That changes the route to #/project/<id>/new.
- ui/projects.tsx:371: 'Add to {current.name}' is a secondary 'btn'.
- ui/projects.tsx:375: the footer's only primary button is 'Create project', with the name prefilled from the folder.

The dialog does not know it was opened to add a repository to a known project, so it treats every caller like onboarding.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-navigation.e2e.ts`

**Suggested fix:** Give the Repositories tab its own membership flow instead of the onboarding flow.

1. Add a separate entry point, for example addRepositoryToProject(projectId) in ui/projects.tsx, or an options flag openRepository(id, { intent: "add" }). It opens the picker with the title 'Add repository' and button text 'Add this repository'.
2. On choose: validate with /api/branches, then POST /api/projects/<id>/repositories, then loadProjects(). Show a toast such as 'addme added to MQTT-MCP' and stay on the tab, or route to { view: "project", id, section: "repositories", repository: info.repo } so the new repo is selected. Do not call openComposer.
3. If the repo is already a member, say so ('addme is already in MQTT-MCP') and select it on the Repositories tab instead of jumping to the composer.
4. If the repository choice dialog is kept for this case, record the intent in repositoryChoice ({ repository, project, intent: "add" }). With intent "add", render 'Add to <project>' as the primary footer bu …

**Suggested regression test:** Add an e2e case to test/e2e/project-navigation.e2e.ts, next to 'explicit membership blocks stale launches...' (line ~134):

1. page.goto(base + `/#/project/${projectA}/repositories`), click 'Add repository', then chooseFolder(repoB).
2. If a choice dialog appears, assert its primary button (locator('.picker-foot .btn.primary')) has the text 'Add to alpha', not 'Create project'. Click it.
3. Assert the hash is still `#/project/${projectA}/repositories` or the repositories/<repoB> deep link, and n …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server named v4631r on port 4631, with a new home. I used a new name because an earlier verifier had already used the v4631 home. I made a scratch git repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4631r/addme (git init plus one commit). I then drove a fresh headless Chrome with /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4631r/add-repo.mjs (log: add-repo.log in the same folder).

Scenario 1: I opened #/project/p-ef01794b/repositories (MQTT-MCP), clicked 'Add repository', typed the folder path, waited for '✓ This folder is a git repository' and clicked 'Open this repository'. The 'Open repository in a project' dialog had these buttons: [Add to MQTT-MCP (plain btn), Cancel, Create project (btn primary)], with 'New project name' prefilled as 'addme' (shot 001-s1-choice-dialog.png). Keyboard focus started on 'Add to MQTT-MCP', so pressing Enter does the right thing, but the only visually primary action creates a new project. I clicked 'Add to MQTT-MCP'. The hash went from #/project/p-ef01794b/repositories to #/project/p-ef01794b/new and the composer showed with Repository=addme (shot 002-s1-after-add.png). There was no success toast. The API showed the repo added to MQTT-MCP's repos.

Scenario 2: I repeated 'Add repository' with the same folder, which is now already a member. No dialog appeared and no message was shown. The app went straight to #/project/p-ef01794b/new.

Scenario 3 (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4631r/create.mjs): from the MQTT-MCP Repositories tab I clicked the primary 'Create project'. That created a separate project 'addme' (p-efd44d00) and moved me to #/project/p-efd44d00/new. MQTT-MCP stayed unchanged, so a user who follows the primary button from 'Add repository' ends up in a different project.

No console errors and no 5xx responses. No runs were created.

Why this is not by design: docs/project-first-navigation-plan.md:191 asks for an explicit 'Add to this project' action that 'reports success before launch'. docs/getting-started.md:80 describes the create-project default only for the onboarding 'Open repository' button. No doc says the Repositories tab's 'Add repository' should default to a new project or leave the Repositories tab. The e2e tests (test/e2 …

</details>

### t01-5 · minor · Project overview shows 'Describe a task' for a project that has a saved draft unless that project is currently loaded in the composer

Source: tester unit shell-navigation-settings-2; observed with fake-agents; features SHL-33.

**Repro**

> 1. Open #/project/<A>, click 'Describe a task' and type a task (draft saved).
> 2. Return to #/project/<A>: it shows 'Continue your draft' with a preview.
> 3. Open #/project/<B>/new (composer switches project), then go back to #/project/<A> or reload it.

**Expected:** A's overview keeps showing 'Continue your draft' with the preview, since each project keeps its own draft.

**Actual:** A shows 'What would you like to work on? / Describe a task'. Clicking it reopens the composer with the old draft text, and only then does the overview show 'Continue your draft' again.

**Root cause (verifier):** ui/project.tsx:54-56. The h2 ("Continue your draft"), the .draft-preview paragraph and the button label ("Continue draft") all check `composerProject.value === id && task.value.trim()`. That is the composer's in-memory state, which holds only one project's draft at a time. Every other project's draft lives in the module-private `draftStore` (ui/state.ts:1208, a ProjectDraftStore over IndexedDB, ui/project-context.ts:25), and nothing on the overview reads it. Opening another project's composer through `switchComposer` (ui/state.ts:1257-1305) saves A's snapshot, loads B and sets `composerProject` to B. After a reload, `initializeProjectDrafts` (ui/state.ts:1313-1332) restores only the stored `composerProject`. So A's overview loses track of A's saved draft until `openComposer(A)` loads it into memory again. The comment on openComposer (ui/state.ts:1245, "Viewing a project … never calls this") is correct: the overview should not switch the composer. It needs a read-only way to see a project's saved draft.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-navigation.e2e.ts`

**Suggested fix:** Add a read-only accessor to ui/state.ts next to `saveComposerDraft`, for example `export async function savedDraftTask(id: string): Promise<string> { if (id === composerProject.value) return task.value; return (await draftStore.read(id))?.task ?? ""; }`. `draftStore.read` already waits for pending writes and serves its in-memory cache first, so it sees a snapshot saved just before the switch. In ProjectView (ui/project.tsx), keep a `savedTask` state and load it in a `useEffect` keyed on `[id, draftsReady.value, composerProject.value]`, with a liveness guard against stale responses. Then compute `const draftText = composerProject.value === id ? task.value : savedTask;` and use `draftText.trim()` for the heading, the preview (`draftText.slice(0, 240)`) and the button label in place of the three current checks. Do not call openComposer or switch the composer from the overview. Optionally run the preview through `parseBrowserMessage(...).text` so browser-context markers are not shown raw,  …

**Suggested regression test:** In test/e2e/project-navigation.e2e.ts, extend or follow the existing "composer links and browser history…" test, which ends with the composer on projectB while projectA still holds "Alpha draft".
1. Go to `base + /#/project/${projectA}`.
2. Assert that `getByRole("region", { name: "Start work" })` contains the heading "Continue your draft", a `.draft-preview` with text "Alpha draft", and a button named "Continue draft".
3. `page.reload()` and assert the same three things again; this covers compo …

<details><summary>Verifier's independent reproduction</summary>

Port 4617 was taken by another verifier's server (v4615b, pid 52252), so I left it alone. I started a fresh fake-mode server named v4617d on my extra port 4619 with a fresh home and a fresh browser profile. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617d/repro.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617d/repro.log. Project A was MQTT-MCP (p-ef01794b) and project B was industriHealth (p-acdbb4ae).
1) On #/project/A the overview showed "What would you like to work on? / Describe a task". I clicked it and typed a task into the Task box. IndexedDB then held the key project-draft-v1:p-ef01794b with the text, and localStorage composerProject was p-ef01794b.
2) Back on #/project/A the overview showed "Continue your draft", the preview and a "Continue draft" button (screenshot 002).
3) I opened #/project/B/new. The composer loaded B with an empty task, and composerProject became p-acdbb4ae. IndexedDB still held A's draft text.
4) Back on #/project/A the overview showed "What would you like to work on?" and "Describe a task" with no preview, and the same after a full reload (screenshots 004 and 005).
5) Clicking "Describe a task" opened the composer with A's old draft text. Returning to the overview then showed "Continue your draft" again (screenshot 007).
No console or API errors were logged. Screenshots are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4617d/.
Not by design: docs/getting-started.md:108-110 says "Project Overview groups the saved draft…" and "Text … saved separately for each project". docs/project-first-navigation-plan.md:183/217 says an existing unsent draft is restored and that the viewed project should be kept separate from the composer's destination. No test asserts the current behaviour.
Severity stays minor: nothing is lost, because opening the composer restores the draft. But the overview tells the user there is no draft, so they may start over or think their work is gone.

</details>

### t26-3 · minor · Project edit (rename/repositories) is last-write-wins: a stale tab silently overwrites another tab's save

Source: tester unit usability-failure-cases-2; observed with fake-agents; features UX-22.

**Repro**

> 1. Open the app in two tabs (same browser).
> 2. In each tab press p, then Edit <project>.
> 3. Tab A: rename to '<x>-renamed-in-tab-A' and Save.
> 4. Tab B, whose editor still shows the old name: rename to '<x>-renamed-in-tab-B' and Save.

**Expected:** Tab B gets a 409 or a 'project changed elsewhere' message with its draft kept.

**Actual:** Tab B's save succeeds silently and overwrites A's rename. Tab A's sidebar keeps showing 'renamed-in-tab-A' until the 30 s poll. Because the editor posts {name, repos} from the dialog's stale state, a repository added or removed in one tab can also be silently reverted by the other (code reading).

**Root cause (verifier):** 1. ui/projects.tsx:144 seeds the editor's name and repos once, with useState(project?.repos), from the projects list as it was when the editor opened. That list can be up to 30 s old, because ui/main.tsx:125 polls every 30 s and nothing pushes project changes to the browser. In src/server.ts:1297, projects.onChange only reaches teamBroadcast. Then ui/projects.tsx:155 posts the whole {name, repos} snapshot to POST /api/projects/:id, without saying which version it was based on.

2. src/server.ts:2126-2128 forwards {name, repos} to manager.updateProject (src/engine.ts:3648-3653) without any precondition.

3. src/projects.ts:162-171 Projects.update() replaces p.name and p.repos outright. change() (src/projects.ts:240-258) only serializes writes; it never compares them. The Project type (src/projects.ts:30-37) has no revision or updatedAt field, so there is nothing to compare against. As a result the later save always wins, even when its repos list is a stale copy that reverts membership changes made by the editor in another tab, by POST /projects/:id/repositories, by place() when a run starts, or by include() when a run moves.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/projects.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/types.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/projects.test.ts`

**Suggested fix:** Add optimistic concurrency to project metadata, following the pattern already used by conventions, memory and filesystem policy.

1. Give each Project a `revision` (an integer, or a hash of {name, repos}). Increment it in every mutation that changes name or repos: update, include, place when it adds a repo, and the /repositories add. Have isProject/load default it to 0 for old files.

2. Projects.update(id, patch, expectedRevision?): when expectedRevision is supplied and does not match p.revision, throw a ProjectConflictError carrying the current project. Map that error to 409 in attempt() at src/server.ts:579, and have the POST /api/projects/:id route pass body.revision through engine.updateProject.

3. In ui/projects.tsx, send `revision: project.revision` with name and repos when saving. On a 409, keep the editor open with the draft intact, show a "This project changed in another tab or window" message that lists the current name and repos, and offer to reload them or to keep the dra …

**Suggested regression test:** Unit test in test/projects.test.ts:
- Create a project with repos [web, api] and read its revision r0. Call update(id, {name: "A"}, r0), which succeeds and moves the revision to r1. Then call update(id, {name: "B", repos: [web, api]}, r0) and assert.rejects with ProjectConflictError; the name stays "A".
- Starting from r1, call include(id, docs), which bumps the revision. Then call update(id, {name: "C", repos: [web, api]}, r1) and assert it rejects, and that repos still contain docs.
- Assert t …

<details><summary>Verifier's independent reproduction</summary>

I started my own fake-mode QA server (qa-server.sh start v4641 4641 fake) and drove it with one headless Chrome profile and two tabs (A and B) in the same context. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4641/t26-3/repro.mjs, output in repro.log next to it. As a precondition I created project "v263-base" through the API with two scratch git repos, r1 and r2, both inside my work dir. Every edit after that went through the UI: press p, click "Edit <name>", use the #project-name field, Remove/Save buttons.

Scenario 1 (rename): both tabs opened the editor, both showing "v263-base". A renamed to v263-renamed-in-tab-A and saved: POST /api/projects/p-4c54c354 returned 200. B's field still showed "v263-base". B renamed to v263-renamed-in-tab-B and saved: 200, the dialog closed with no message, and the server now held the tab-B name. A's rename was lost without any warning.

Scenario 2 (repos, UI only): both tabs reloaded and opened the editor. A clicked "Remove r2" and saved, leaving the server with [r1]. B changed only the name and saved. Its request body still carried repos [r1, r2], it got 200, and the server ended with [r1, r2]: B silently put back the repository A had removed.

Scenario 3: B opened the editor. Then r3 was added through the documented membership API, POST /api/projects/:id/repositories, which returned 200 with [r1, r2, r3]. B renamed and saved, getting 200, and the server ended with [r1, r2]: r3 was silently dropped.

The run produced no console errors and no 5xx responses. Tab A only learns about other tabs' changes through the 30 s pollVisible in ui/main.tsx:125. The open editor never resyncs, because it holds useState copies.

Attempted refutation: the reporter's selectors were correct and the result does not depend on the browser profile. The docs do not describe this as intended. docs/api.md says "explicit concurrency conflicts 409". Comparable editors such as project conventions, memory, filesystem policy and workspace file saves all require the displayed revision, return 409 on conflict and keep the draft. The only "last-writer" statement (docs/project-first-navigation-plan.md:53) is about composer drafts in IndexedDB, not project metadata.

Severity stays minor. Projects usually have one owner, and the lost edit is visible and can be redone; runs are not lost, because keepInProject records the project on runs. The repository case is the more ser …

</details>

### t00-11 · minor · #/project/<missing id>/new opens an ordinary-looking composer with no 'project unavailable' notice

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-01.

**Repro**

> 1. Open #/project/nope-123/new on a fresh browser profile (no repo chosen yet).

**Expected:** A notice that the project is unavailable and a way to choose a destination (the code has 'This project's draft is retained, but the project is unavailable. Choose a destination.').

**Actual:** The composer looks like an unassigned draft ('Choose project', 'Choose repository…'), and the URL stays #/project/nope-123/new. The draft is saved under the missing id, and nothing tells the user the project doesn't exist.

**Root cause (verifier):** The notice is computed correctly but hidden because no repository is set.

- ui/project-context.ts:10: projectDestination() correctly returns problem "This project's draft is retained, but the project is unavailable. Choose a destination." whenever id is non-empty and no project matches.
- ui/state.ts:339-343: `target` exposes that problem.
- ui/composer.tsx:292 renders the banner only under `repo.value && target.value.problem`.
- ui/composer.tsx:548-549: startProblem() returns "Choose a repository first" before it ever checks target.value.problem.

For an unknown id with no saved draft, the repository is always empty. ui/state.ts switchComposer (around line 1271) sets `repository = options.repository ?? saved?.repository ?? (project ? lastRepo(project) : "")`, which gives "" because `project` is undefined. It then calls setRepo(""). So the unavailable-project problem is never shown in the banner or the status line.

Separately, ui/main.tsx:103-107 opens the composer for any route project id without checking it exists. switchComposer then writes composerProject=<missing id> to localStorage (ui/state.ts:1294-1295), and the draft autosave (ui/state.ts:1339-1343) stores the draft unde …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-context.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-navigation.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-context.test.ts`

**Suggested fix:** Show the unavailable-project state regardless of whether a repository is set.

1. In ui/composer.tsx:292, show the banner when `target.value.problem && (repo.value || (composerProject.value && !target.value.project && projectsLoaded.value))`. More simply: always show it for the missing-project case, and keep the repo.value gate only for the repository-membership problems.
   - Gate on projectsLoaded so the banner does not flash before /api/projects returns.
   - With no repository, "Choose destination" should open the project picker (ProjectButton in composer mode) or offer "Unassigned draft" (navigate to #/new/unassigned with carryUnassigned). It should not open repositoryChoice with an empty repository.
2. In ui/composer.tsx:546-549 startProblem(), check the missing-project case before "Choose a repository first", so the status line and the Send/Start button title also say the project is unavailable. One option is a dedicated `unavailable` flag from projectDestination(); string match …

**Suggested regression test:** 1. Add to test/e2e/project-navigation.e2e.ts, next to the test "composer links and browser history restore the destination without changing global filters": open `/?team=local#/project/missing-xyz/new` in a fresh context with no saved draft and no repository. Assert:
   - a `.composer .banner` with text /project is unavailable/ is visible;
   - `.composer-problem` matches /unavailable/ and not /Choose a repository first/;
   - `button.task-start` is disabled.

   Then open `#/project/${projectA} …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (qa-server.sh start v4663 4663 fake). It registers 8 projects (p-3b74eba4, ..., p-ef01794b MQTT-MCP, ...) and has no runs. All checks used a fresh headless Chrome with no profile and no 5xx or console errors.

Script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4663/t00-11a.mjs: I opened /?team=local#/project/nope-123/new and got the following.
- The URL stayed #/project/nope-123/new.
- The main area read "Choose project | Choose repository… | Choose the repository the agents should work in." The status line read "Choose a repository first", and the Send button was disabled with that same title.
- The word "unavailable" does not appear anywhere on the page. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4663/001-t00-11-fresh-missing-project.png (looks exactly like an unassigned draft).
- After I typed a task, localStorage had composerProject="nope-123", and IndexedDB had the key "project-draft-v1:nope-123". So the draft is saved under the missing id.

Script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4663/t00-11b.mjs:
- (a) I first opened the real project MQTT-MCP, where a repository is selected, then went to #/project/nope-123/new. The repository is not carried over and the page looks the same: no notice, problem "Choose a repository first".
- (b) Boundary check: I copied the MQTT draft, which has a repository, to the IndexedDB key nope-456 and opened #/project/nope-456/new. This time the banner "This project's draft is retained, but the project is unavailable. Choose a destination." appears, with a "Choose destination" button, and it is also the start problem. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4663/002-t00-11-retained-draft-with-repo.png. This shows the notice exists but only renders when a repository is set.
- (c) #/project/nope-123, the Overview page for the same id, does say "This project is unavailable. Its existing runs and saved draft are retained." So the two pages behave differently.
- (d) After a visit to nope-123, opening bare #/ keeps composerProject=nope-123, so the phantom destination persists.

Possible refutations I checked:
- Not the tester's environment or s …

</details>

### t00-18 · minor · One unreadable saved draft locks the composer for every project ('Reload to retry' never helps)

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-01.

**Repro**

> 1. Browser where IndexedDB is unavailable (simulated by removing window.indexedDB), so drafts use the localStorage fallback.
> 2. localStorage project-draft-v1:<projectId> = '{corrupt' and composerProject = <projectId>.
> 3. Load the app; open #/project/<other id>/new and #/new/unassigned; reload.

**Expected:** Only the unreadable draft is skipped or reset, and other projects' composers work.

**Actual:** Every composer route shows 'Could not restore saved drafts: Expected property name… Reload to retry.' 'New run' stays disabled and 'n' does nothing. Reloading doesn't help; only clearing the key does.

**Root cause (verifier):** ui/state.ts:1312-1336 (initializeProjectDrafts): one try block covers the read of the last-used project's draft (:1326 draftStore.read(id)) and its version check (:1327 throw "Saved draft format is unavailable."). Any throw jumps to the catch at :1335, which sets draftError to "...Reload to retry." and never runs :1332 draftsReady.value = true, nor installs the autosave effect.

draftsReady=false then blocks everything:
- ui/app.tsx:168 renders draftError in place of <Composer> for every composer route.
- switchComposer (ui/state.ts:1258) returns false, so 'n' and openComposer do nothing.
- The rail and project-page New run buttons are disabled (ui/rail.tsx:254 and :411, ui/project.tsx:45 and :56).

Separately, ui/project-context.ts:52 calls JSON.parse(value) on the localStorage fallback with no recovery, so a malformed value throws on every load. The failure is persistent because nothing renames, quarantines or discards the bad key, so the advice to reload is misleading.

Secondary bug: when the failure happens in switchComposer instead (ui/state.ts:1271 throw, :1301 draftError = "Could not open the draft…"), the finally block clears composerLoading. That re-runs the autosave effe …

**Files:** `ui/state.ts`, `ui/project-context.ts`, `ui/app.tsx`, `test/project-drafts.test.ts`, `test/project-context.test.ts`

**Suggested fix:** 1. Make the store's read fail per key, not globally (ui/project-context.ts). Wrap JSON.parse, and IndexedDB read errors, so that read() returns a typed result such as { status: "unreadable", reason }, or throws a dedicated UnreadableDraftError. Never delete the raw value: keep it under its key, or copy it to `${prefix}unreadable:${key}` so it can be recovered later.

2. In initializeProjectDrafts (ui/state.ts:1325-1331), handle an unreadable draft or a version other than 1 without failing startup:
   - Mark that project id as blocked (for example a signal unreadableDrafts: Map<id, reason>).
   - Leave its stored value untouched.
   - Start on the unassigned draft, or on an empty composer that is not bound to that key, then set draftsReady=true and install the autosave effect.
   - Make sure the autosave effect and saveComposerDraft never write to a blocked id, so the retained bytes are not overwritten. That protection is the reason the current code blocks everything.
   Keep the global …

**Suggested regression test:** Unit: in test/project-drafts.test.ts, add a case using the existing localStorage stub with no IndexedDB in Node:
- Set values 'projectDraftVersion'='1', 'composerProject'='a', 'project-draft-v1:a'='{corrupt' and a valid v1 draft for 'b'.
- `await state.initializeProjectDrafts()`.
- `assert.equal(state.draftsReady.value, true)`.
- `assert.equal(await state.openComposer('b'), true)` and `assert.equal(state.task.value, <b's task>)`.
- After `saveComposerDraft()`, `assert.equal(values.get('project-d …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4675 on port 4675. The old v4675 home was moved aside to homes/v4675-prev-*, so the home started with no runs. Each variant used a fresh non-persistent headless Chrome context. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4675/t0018-repro.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4675/t0018-repro.log.

Baseline: before any change, the composer rendered normally (2 textareas, New run enabled).

V1, the reporter's case: window.indexedDB removed with addInitScript; composerProject=p-ef01794b (MQTT-MCP); project-draft-v1:p-ef01794b='{corrupt'; then reload. Every composer route showed "Could not restore saved drafts: Expected property name or '}' in JSON at position 1 (line 1 column 2). Reload to retry.": #/, #/project/p-3b74eba4/new (OPCUA-MCP, a different project), #/new/unassigned and the bad project itself. There was no textarea. The rail New run button and the OPCUA project page New run button were disabled. Pressing 'n' left the URL on #/project/p-3b74eba4. A second reload gave the same result. Screenshot: shots/v4675/002-V1-...-after-reload.png.

V2, control: same corrupt key, but composerProject='' (the bad draft is not the last-used one). Startup succeeded. Every other composer worked, 'n' opened #/project/p-3b74eba4/new, and New run was enabled. So the full lock only happens when the unreadable draft belongs to the last-used composer project.

V3, IndexedDB left in place (normal browser): I wrote {version:2,...} into IndexedDB 'codeflow-project-drafts'/'drafts' under project-draft-v1:p-ef01794b, with composerProject=p-ef01794b. The same full lock appeared: "Could not restore saved drafts: Saved draft format is unavailable.. Reload to retry." (note the doubled period), on every route and after reload. The issue therefore does not depend on removing IndexedDB or on the localStorage fallback.

V2b (t0018-v2b.mjs), secondary bug: same version-2 draft for MQTT, but last project OPCUA. OPCUA worked. Opening #/project/p-ef01794b/new showed "Restoring your project draft…" at 0.1, 0.3, 0.6, 1.5 and 5 seconds. The real error ("Could not open the draft: This draft uses an unsupported format…") is wiped right after it is set.

No console errors, page errors or 5xx responses in any variant. Server stopped and no runs were created.

Refutation attempts: I found no  …

</details>

### t26-7 · minor · Corrupt projects.json is set aside silently: the UI shows first-run onboarding with no hint that projects were moved to a backup

Source: tester unit usability-failure-cases-2; observed with fake-agents; features USAB-GAP-03.

**Repro**

> 1. Stop the server and write invalid JSON to <CODEFLOW_HOME>/projects.json (it held 9 projects).
> 2. Start and open the app.

**Expected:** Projects are set aside and logged (as happens), and the UI also shows a notice naming projects.json.corrupt-<time> and how to restore it.

**Actual:** The file is moved and only server.log records it. The UI shows 'Your first project / Open repository' as if code-flow were new, and the runs appear with no project. A user would think their projects were deleted.

**Root cause (verifier):** The corruption state is only logged and never reaches the API or the UI.

- **src/projects.ts:115-125, `Projects.setAside()`:** after the rename, its only output is `logError(\`${this.file} ${why}: moved it to ${aside}\`)` (line ~118). It records nothing on the instance.
- **src/projects.ts:108-111, `load()`:** after a successful set-aside it then sets `this.projects = usable` (empty for invalid JSON) and `writable = true`. That state is indistinguishable from a brand-new install.
- **The `available` getter (line ~63):** it only reflects the case where the file couldn't be moved, and nothing exposes even that to the UI.
- **src/server.ts:2017:** `GET /api/projects` returns the bare `projects.list()` array, so there is no channel for a warning. /api/health has no project-storage field either.
- **ui/state.ts:263, `loadProjects()`:** it stores just the array.
- **ui/composer.tsx:275:** `if (!projects.value.length && !repo.value && !task.value.trim())` renders the "Your first project" onboarding whenever the list is empty, with nothing to tell "new user" from "projects file was set aside".

The same blind spot covers the worse branch where `setAside` fails (`writable=false`, projects  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/projects.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/configuration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/projects.test.ts`

**Suggested fix:** 1. **Record the recovery state in `Projects`.** Add a `recovery?: { kind: "set-aside" | "unreadable"; reason: string; aside?: string; at: number; projectCount?: number }` field.
   - `setAside()` fills it on success, with the basename of the aside file and the reason. `projectCount` is the entry count when the file parsed as a list, and is unknown for invalid JSON.
   - The unreadable / can't-move branches fill it with kind "unreadable".
   - Clear it with a `dismissRecovery()` method.

2. **Expose it without breaking existing callers of `GET /api/projects`.** Either:
   - add `GET /api/projects/status` → `{ available, recovery }` and `POST /api/projects/status/dismiss`, or
   - add a `projects` field to /api/health.

   Only give the aside file's basename and `CODEFLOW_HOME`, never full home paths, to non-owner/shared sessions.

3. **Show it in the UI.**
   - ui/state.ts loads the status next to the list.
   - ui/composer.tsx:275 (and the sidebar Projects header) shows a warning banne …

**Suggested regression test:** 1. **Unit test in test/projects.test.ts.** Extend "a projects.json that can't be read is set aside, never written over":
   - after `load()` on "{ not json", assert `a.recovery?.kind === "set-aside"` and that `a.recovery.aside` matches /^projects\.json\.corrupt-/ and equals `asides(broken)[0]`;
   - for the mixed file, assert recovery is reported with a rejected count;
   - for the directory case, assert `recovery.kind === "unreadable"` and `available === false`;
   - after `dismissRecovery()`,  …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this twice on a fresh fake-mode QA server. It was named v4649t267 on port 4649, because homes/v4649 already held an earlier verifier's data. Its home is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4649t267.

Setup:
- The seeded projects.json had 8 projects.
- I made a throwaway git repo and started two fake solo runs in it through POST /api/runs. CodeFlow auto-created project 'v4649t267-scratch' (p-e1d70855), so projects.json held 9 projects, like the reporter's.
- Baseline UI: the normal "New run" composer, and the sidebar showed "8 more projects".

Repro 1 (fresh browser):
- I stopped the server, wrote `[{"id":"p-broken", "name": ` to projects.json and restarted.
- server.out and server.log each had exactly one error line: "projects.json isn't valid JSON (Unexpected end of JSON input): moved it to projects.json.corrupt-2026-10-25T23-29-39-921Z".
- The UI (shots/v4649t267/001-after-corrupt.png) showed "Your first project / What would you like to work on? / Open repository / Join shared project". There was no alert, banner or message. Page text had no match for /corrupt|backup|projects\.json|set aside|moved/, and neither did #/settings.
- GET /api/projects returned 200 []. /api/health had no mention of it. Both runs still recorded project=p-e1d70855. There were no console errors.

Repro 2 (returning-user profile, to rule out a fresh-profile artifact):
- I restored the 9-project file, opened the app with a persistent profile and opened the scratch project's run. Projects showed normally.
- I stopped the server, wrote '{not json' and restarted. A second .corrupt-2026-10-25T23-30-47-472Z file was created.
- Same profile (shots/v4649t267/001-after-corrupt-profile.png): the same first-run welcome, and the sidebar shows "Projects > No project > Second scratch task". The 8 user projects are simply gone from the UI, with no hint.

Not refutable as:
- **Environment / selector:** both a fresh and a warmed profile show it, and the API itself returns [].
- **By design:** docs/configuration.md:146 and the src/projects.ts:70-75 comment only promise "moved aside … and logged". They never promise or rule out a UI notice, so this is a usability gap, not a contract violation.

Side note (not tested, because qa-server.sh re-seeds projects.json from ~/.codeflow whenever it is missing): from the code, the next restart without a projects.json takes the first-run path (src/projects.ts:89 …

</details>

### t26-8 · minor · With projects off (unreadable or immovable projects.json) the UI cannot start any new run; the error says the file 'couldn't be read' when it was read but couldn't be moved

Source: tester unit usability-failure-cases-2; observed with fake-agents; features USAB-GAP-03.

**Repro**

> 1. Stop the server, write 'not json at all' into projects.json, and run chflags uchg projects.json.
> 2. Start. server.log says 'isn't valid JSON, and it couldn't be moved aside; projects are off'.
> 3. In the UI, click New run: the 'Your first project' screen appears with no composer.
> 4. Open repository and pick a repo: the 'Open repository in a project' dialog appears. Create project fails with 'Projects are off: …/projects.json couldn't be read (see server.log)'. Cancel returns to the onboarding screen.

**Expected:** Per docs/configuration.md:146 ('projects are off (runs start without one)'), the composer is reachable and a run can start without a project. The message states the real cause.

**Actual:** No path in the UI starts a new run until the file is fixed by hand; only follow-ups on existing runs work. The message is inaccurate for the 'invalid and immovable' case.

**Root cause (verifier):** Two separate defects.

1. The error message gives the wrong cause.
   - src/projects.ts:242 throws the same text, "Projects are off: ${file} couldn't be read (see server.log)", whenever `writable` is false.
   - `writable` is set to false in two different situations:
     - src/projects.ts:85: readFile failed (EACCES or EISDIR). "Couldn't be read" is accurate here.
     - src/projects.ts:108 plus setAside at :116-123: the file was read but is invalid JSON, not a list, or has entries it can't use, and rename() failed (EPERM). "Couldn't be read" is wrong here.
   - No reason is stored, so change() cannot say which case happened.

2. When projects are off, the UI has no way to start a run, and it does not show that projects are off.
   - The server never exposes `projects.available`. GET /api/projects at src/server.ts:2017 returns a bare [], and /api/health has no projects field. To the UI, projects being off looks the same as having no projects yet.
   - ui/composer.tsx:275 therefore shows the "Your first project" onboarding instead of a recovery state.
   - Every route into the composer requires creating or choosing a project:
     - ui/projects.tsx:340 openRepository leads to pickR …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/projects.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-context.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/configuration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/projects.test.ts`

**Suggested fix:** 1. Make the error accurate (src/projects.ts).
   - Add a private `offReason` field and a public getter.
   - Set it at :85 to "couldn't be read (<code>)".
   - Set it in setAside's catch at :121 to "<why>, and it couldn't be moved aside (<code>)".
   - Clear it whenever `writable` becomes true.
   - At :242, throw `Projects are off: ${file} ${offReason}. Fix or remove it and restart code-flow (see server.log)`.

2. Let the UI see that projects are off.
   - Add `projects: { available, reason }` to /api/health (src/server.ts), or send a header or wrapper with GET /api/projects.
   - The UI already calls loadHealth.

3. Add a recovery state in the UI (ui/composer.tsx:275 and ui/project-context.ts).
   - When projects are unavailable, show a banner such as "Projects are off: projects.json <reason>". Do not show the "Your first project" onboarding.
   - Then pick one of two options, and keep the docs and UI consistent:
     a. Match docs/configuration.md:146: when health says projects are  …

**Suggested regression test:** test/projects.test.ts: add a case next to the one at :323.
- Write 'not json' to projects.json in a temp dir, then chmod the dir to 0o500 so rename() fails with EACCES or EPERM (or stub rename).
- After load(), assert `available === false`.
- Assert that `create()` rejects with /isn't valid JSON.*couldn't be moved aside/ and does not match /couldn't be read/.
- Also assert the existing unreadable-file case (directory as projects.json) still rejects with /couldn't be read/.

Server test:
- With a …

<details><summary>Verifier's independent reproduction</summary>

I ran this on a fresh fake-mode QA server "v4651" on port 4651. I moved the old home aside, so the new one had no runs. I created a tiny scratch git repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4651-tiny.

Case A, invalid and immovable file:
1. Wrote 'not json at all' to homes/v4651/projects.json and ran `chflags uchg` on it. A manual `mv` then failed with "Operation not permitted".
2. Started the server. server.log said: "...projects.json isn't valid JSON (...), and it couldn't be moved aside; projects are off until it's fixed" with error EPERM on rename. GET /api/projects returned [].
3. In a fresh browser (work/v4651/off.mjs), I clicked New run in the sidebar. The "Your first project / What would you like to work on?" screen appeared, offering only Open repository and Join shared project, with no composer (shot 002-after-new-run.png).
4. I clicked Open repository, typed the scratch repo path and clicked "Open this repository". The "Open repository in a project" dialog appeared.
5. Create project failed with POST /api/projects 400: "Projects are off: .../homes/v4651/projects.json couldn't be read (see server.log)" (shot 005-create-project-error.png). The file had in fact been read; it was the move aside that failed.
6. Cancel returned to the onboarding screen. Pressing 'n' showed the same screen again.

Warm profile (work/v4651/warm.mjs): I set localStorage repo to the scratch repo, as a user from before the file broke would have it. This time the full composer appeared, with the banner "Choose a project for this repository before starting." Send stayed disabled after typing a task. "Choose destination" then "Create project" failed with the same message (shot 002-warm-after-start.png).

API check: POST /api/runs with projectSelection "explicit" returned 409 "Choose an available project before starting".

Case B, unreadable file: I restarted with projects.json at chmod 000. server.log said "Couldn't read ...; projects are off". Creating a project returned the same "couldn't be read" error, which is accurate in this case. The UI path is the same code, so it is blocked the same way.

In both cases no run could start from the UI.

Why it is not by design or caused by the environment:
- docs/configuration.md:146 promises "projects are off (runs start without one)". test/projects.test.ts:323 only proves this for the engine (RunManager.start with no project).
- docs/project- …

</details>

### t01-13 · cosmetic · DELETE /api/projects/:id returns 500 on a storage failure while rename returns 400 for the same error

Source: tester unit shell-navigation-settings-2; observed with api; features SHL-29.

**Repro**

> 1. On a QA server, chmod 555 the CODEFLOW_HOME directory.
> 2. DELETE /api/projects/<id>, then POST /api/projects/<id> {name}.
> 3. Restore permissions.

**Expected:** Consistent status codes for the same storage failure.

**Actual:** DELETE → 500, rename → 400, both with "code-flow couldn't save projects: EACCES…". Project state stayed consistent.

**Root cause (verifier):** Every projects write goes through Projects.change() in src/projects.ts (around line 248). When write() fails it throws a plain Error("code-flow couldn't save projects: ..."). The routes then wrap that error differently:
- src/server.ts:2131 calls manager.removeProject(id) (src/engine.ts:3657) without attempt(). The plain Error reaches listener() at src/server.ts:2800, which sends 500 and logs it.
- src/server.ts:2128 (rename/update), :2015 (create) and :2030 (add repository) wrap the same call in attempt() (src/server.ts:579-584). attempt() turns every unrecognized error into 400 and skips the >=500 logError.
So one storage failure comes back as 500 from DELETE and 400 from create/rename/include. Per docs/api.md:19-20 and the memory-route precedent, 500 is the documented status for a server-side storage fault. The 400 paths are the mislabeled ones, and they also hide the failure from server.log.

**Files:** `src/projects.ts`, `src/server.ts`, `test/projects.test.ts`

**Suggested fix:** Make every project route report a storage failure the same way, as a server error.
1. In src/projects.ts, add an exported ProjectsStorageError extends Error. Use it in change() for the "couldn't save projects" failure, and for the "Projects are off: ... couldn't be read" case.
2. In src/server.ts attempt() (line 579), add a branch before the 400 default: ProjectsStorageError becomes new HttpError(500, message). The request then gets 500 and listener() still logs it.
3. Wrap DELETE /api/projects/:id (line 2131) in attempt() too, so the four mutation routes share one mapping.
The smaller alternative is only wrapping DELETE in attempt(). That makes all of them a consistent 400, but it is consistently wrong against docs/api.md and drops the server-side log, so the typed error is the better fix.

**Suggested regression test:** Extend the read-only test in test/projects.test.ts ("a change that can't be saved fails and is undone..."). Inside the chmod 0o500 block, add assert.rejects(projects.remove(projects.forRepo(api)!.id), (e) => e instanceof ProjectsStorageError && /couldn't save projects/.test(e.message)). Do the same for create, update and include.
Also add an HTTP-level test in a server route test that starts a server with a temp CODEFLOW_HOME, creates a project, sets chmod 0o500 on the home, and asserts:
- DELET …

<details><summary>Verifier's independent reproduction</summary>

Started my own fake-mode server: qa-server.sh start v4633 4633 fake (home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4633, no runs). Created a scratch project with POST /api/projects {"name":"v4633-scratch","repos":[]}, which returned 201 p-ac4aa34d. Ran chmod 555 on the home, then sent three requests:
- DELETE /api/projects/p-ac4aa34d returned HTTP 500 {"error":"code-flow couldn't save projects: EACCES: permission denied, open '.../homes/v4633/projects.json.tmp'"}.
- POST /api/projects/p-ac4aa34d {"name":"v4633-renamed"} returned HTTP 400 with the same error text.
- POST /api/projects {"name":"v4633-other"} also returned HTTP 400 with the same text.
Restored chmod 755. GET /api/projects still showed p-ac4aa34d as "v4633-scratch", so every failed change was rolled back. server.out logged only the DELETE ("code-flow: DELETE /api/projects/p-ac4aa34d failed: ..."); the 400 responses were not logged at all.
Ways it could have been something else, all ruled out:
- Not an environment or script artifact: Projects.change() turns any failed write into the same Error, and only the route wrapping differs.
- Not by design: docs/api.md:19-20 says "validation errors use 400". A storage failure is not a validation error. The memory route (src/server.ts:2118-2120) also maps store read/write failures to 500 on purpose ("A store that cannot be read or written is the server's fault, not the request's").
- No visible UI difference: ui/projects.tsx:168-178 and the save handler both just show err.message. So the impact is the status code and server logging only.
Cleanup: deleted p-ac4aa34d (200), stopped v4633, home permissions restored. Nothing left over.

</details>
