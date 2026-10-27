# Cluster 33 · composer-start-feedback

**Composer start blockers, provider/model feedback, files tree, folder picker and Improve**

Status: **repaired and independently replayed** · 15 issues · branch `codex/qa-composer-start-feedback` (base `6a0f0c7`)

Planner notes: Start feedback (startProblem in ui/composer.tsx ~544-575, and the error slot at ~410 below Advanced): some blockers appear only after Send, far below the button (t02-17/t17-7). Show start errors next to Send and fold the known blockers into startProblem. t04-12: a custom model ID is checked only after Send, and the field disappears (local custom state at ui/chat-controls.tsx:19). t04-13: the model picker drops the {error} catalog entry. t02-16: a signed-out provider is not marked. t02-20: with no provider installed the copy reads 'Pick an agent for Agent'. t02-11: nothing warns that uncommitted checkout changes are left out. t02-10: the summary shows the remembered branch while a PR source locks the start branch. Files and folder picker: t02-1 double-clicking adds the wrong file because the first click reflows the list; t02-12 truncated folders are not marked; t02-18 the '+' label stays 'Add' when the click removes; t02-7/S00-3 pressing Enter in the folder picker keeps a non-canonical path and doesn't expand '~' (ui/app.tsx:611, src/fs.ts). Improve (src/improve.ts): t02-21 the prompt wording leaks 'the repository is empty' into answers; t02-22 acceptance criteria are never sent to Improve. Duplicate groups: [["t02-17","t17-7"],["t02-7","S00-3"]]

Likely files: `ui/composer.tsx`, `ui/chat-controls.tsx`, `ui/model-select.tsx`, `ui/onboarding.tsx`, `ui/app.tsx`, `src/fs.ts`, `src/improve.ts`, `src/server.ts`, `ui/code-browser.tsx`, `ui/styles.css`

## Repair outcome · 2026-10-26

The 15 reported issues are addressed in `/private/tmp/codeflow-qa-continue/composer-start-feedback`. The original observations below are retained. Browser replays use real application servers and Chrome with fake provider executables, private homes and scratch Git repositories; the only origin is a local bare repository. No real agents or hosted repository effects are involved.

| Issue | Outcome and independent evidence |
|---|---|
| t02-17 | Empty Docker image is part of the shared composer problem, disabling Send and Schedule before dispatch. Real server context errors now appear in a focused `role=alert` immediately after the task controls and clear when context changes. The browser checks both Docker enable/fill/disable and an actual untracked-folder rejection followed by chip removal. Folder chips also disclose untracked changes. Directory presence stays server-authoritative: a U status can describe new files inside an already committed directory, and a PR source may not have been fetched yet. |
| t17-7 | The real `main` prefix collision returns a near-Send alert; its bounding box is inside the viewport and focus moves to it even with Advanced expanded. Editing the prefix clears the stale error. Server branch validation remains intact. |
| t04-12 | `src/model-id.ts` shares the CLI/ACP identity rule with server dispatch. ChatControls retains unknown custom fields after reload, preserves raw typing, exposes an accessible inline error, and composer readiness checks effective model choices and variants. Browser reload with `bad model!!` keeps the field and disabled Send; correcting it permits a real fake-agent start. Desktop and 390px captures were inspected and the phone has no horizontal overflow. |
| t04-13 | The model popup retains the catalog error, explains the default fallback and offers Other model for supported CLI providers. Effort no longer claims the model has no choices when discovery failed. Browser replay uses an actual `FAKE_AGY_MODELS_FAIL=network` server and inspects the popup and effort message. |
| t02-16 | Shared provider readiness drives the provider menu, fallback menu and role pills; signed-out/unsupported choices are labelled and unavailable choices cannot be added. A selected provider's start reason links to settings. The test supplies signed-out doctor evidence to the UI, checks the disabled labelled menu item and the Race pill; helper controls cover signed-in, signed-out and incompatible states. The setup banner still stays hidden when another provider is usable, as intended. |
| t02-20 | All-unavailable providers give “Connect a provider first” with a settings link. All-signed-out control names the provider and sign-in action; generic single-role wording says “Choose a provider.” Browser and unit tests cover the unavailable state and prove “Pick an agent for Agent” is absent. |
| t02-11 | The branch choice and a visible desktop/mobile worktree note state that the selected commit excludes uncommitted checkout changes. An actual started run contains the committed README and no untracked `local.txt`, while both local edits remain in the original scratch checkout. This is a disclosure repair, not a change to snapshot semantics. |
| t02-10 | A shared start-branch label drives the summary and Run details. Browser replay selects `remembered`, chooses PR #7 on `feature`, verifies both labels describe the PR, removes the source, and sees the remembered branch restored. |
| t02-1 | Composer file clicks defer opening briefly so double-click retains the original row; the second click adds that exact entry before opening. Compact progress is in the fixed heading rather than above the tree. Both a 150ms human-paced double-click with a 250ms delayed file response and the normal Playwright double-click add the intended file, never its neighbor. Keyboard/open behavior outside composer remains immediate. |
| t02-12 | Nested folder nodes retain and render the server's truncation flag. Unit control checks 1,001 versus exactly 1,000 entries; real browser expands the 1,001-file folder, sees the note, and finds the omitted last file through search. |
| t02-18 | Added entries display a minus and “Remove … from the task”; treeitem names include “in the task.” Browser verifies add/remove state and that removal restores the Add label and clears the context chip. |
| t02-7 | Explicit Enter/Go navigation canonicalizes the field while preserving guards against initial-listing/paste races. `directoryPath` expands only `~` and `~/…`; its unit test injects a scratch home rather than listing the real home. Browser accepts trailing slash, `/.`, `/sub/..` and double-slash forms. |
| S00-3 | Same root repair as t02-7. Existing picker race/invalid-selection browser coverage passes, as does the prior-opening delayed-close regression in the Improve suite. |
| t02-21 | Quick instructions say the author's project cannot be seen and must not be described; the completion note says the project was not read. No “empty repository” instruction or output filter remains. Unit assertions and recorded prompts from the real Improve HTTP path confirm the wording. No probabilistic live-model result is claimed. |
| t02-22 | Composer sends acceptance criteria; the server normalizes/bounds them; Improve receives them separately with instructions not to repeat, contradict, or ask questions they answer. Browser captures the request, checks the recorded fake-provider prompt and verifies Undo preserves both criteria and original task. The fake provider's fixed rewrite text is not treated as proof of real-model compliance. |

### Original test expectation repaired

`test/e2e/ui.e2e.ts:953` previously waited for **Open repository in a project** after selecting a repository already in the sole current project. `pickRepo` intentionally selects that existing membership directly. The test now waits for the selected repository, without requiring a chooser. Its full onboarding → composer scenario passes, including parameterized templates and keyboard behavior. The new folder replay separately confirms direct opening after each canonicalized alias. No product behavior was changed for this expectation.

Existing Improve tests were updated only for intentional contracts: the new text-only completion note, the criteria request field, and cluster29's number-only source reference (the old assertion had still expected an external title inside Improve instructions).

### Validation and evidence

New artifacts are `test/qa-composer-start-feedback.test.ts` (six helper/server cases) and `test/e2e/qa-composer-start-feedback.e2e.ts` (eight Chrome/API scenarios). All commands use an outer `CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/composer33-command-home`; tests additionally isolate their own application homes.

- `npx tsc --noEmit`: pass.
- New helpers plus existing Improve, filesystem, context and composer-tools units: **42/42 pass**. New helpers rerun after final provider readiness changes: **6/6 pass**.
- New Chrome file: **8/8 pass**, including phone layout, actual start rejections, real server Improve and local snapshot verification.
- Original Improve Chrome suite: **6/6 pass**, including cancellation, stale results, project/context changes, folder picker races, modes and settings.
- Original `ui.e2e.ts` onboarding/review/merge and composer sequence: **2/2 pass** after the intentional chooser expectation update.
- Original project-navigation picker regression: **1/1 pass**.
- Original server-reliability Improve HTTP scenario: **1/1 pass**.

Independent baseline checkout `6a0f0c7` was exercised with the same four selected browser scenarios. All four fail for the original reasons: absent custom-ID validation, the wrong/no double-click context entry, non-canonical Enter field, and omitted Improve criteria. Baseline replay uses its own private server/home and the checkout is removed afterward.

Evidence retained:

- `/private/tmp/codeflow-qa-continue/composer33-browser/`: server log, page-error list, recorded provider prompts and screenshots of invalid model desktop/mobile, model discovery error, no-provider setup, near-Send start error, nested tree truncation, canonical navigation, PR branch summary and Improve criteria.
- `/private/tmp/codeflow-qa-continue/composer33-unit-broad.log`, `composer33-final-unit.log`, `composer33-browser.log`, `composer33-original-improve-browser.log`, `composer33-original-composer-browser.log`, `composer33-original-picker-browser.log`, `composer33-original-http.log`.
- `/private/tmp/codeflow-qa-continue/composer33-baseline.log` and `composer33-baseline-browser/` preserve the failing baseline controls.

Screenshots were visually inspected. The final new browser run records no page errors; its server log contains normal startup/shutdown and the expected Node SQLite warning. Numeric editing and comparison request construction remain cluster32's responsibility; this branch composes model/provider/Docker feedback without replacing those validators. No live4317/4318 listener, live checkout or default CodeFlow home was operated on for cluster33.

## Issues

### t02-17 · minor · Some start blockers appear only after Send, in an error placed at the very bottom of the composer

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-11, CMP-12, CMP-17.

**Repro**

> 1. In Files, '+' an untracked folder (U marker, e.g. qa-many), type a task and click Send.
> 2. Separately: enable Run options > Agent isolation > 'Run agents in a prebuilt Docker image' with no image and click Send.

**Expected:** These are flagged before Send (start problem next to the button), or the error shows near Send.

**Actual:** Send is enabled. The errors 'Folder "qa-many" isn't in the base branch; commit it, or drop the individual files you need' and 'Choose a prebuilt agent image' appear in a .msg.err below Run options, far from the button and easy to miss.

**Root cause (verifier):** The `problem` value the Send button and the summary use for blocking never sees these two conditions. All other start errors go to a generic `error` slot rendered at the bottom of the composer.

- ui/composer.tsx:187: `problem` combines the team-disabled check, `startProblem(...)`, the remote-worker state and the verification profile state. It drives Send's `disabled`/title (line 330) and the `.composer-problem` role="status" line right under the task box (line 342). It does not include the Docker image condition.
- ui/composer.tsx:243: `start()` checks `containerEnabled && !remoteWorker && !containerImage.trim()` only after Send is clicked, then calls `setError("Choose a prebuilt agent image")`. Schedule… (line 334) is gated only on `!problem`, so it also misses this check.
- src/context.ts:89: `prepareContext` throws `Folder "…" isn't in the base branch` on the server during POST /api/runs. The client catches it at ui/composer.tsx:252-253 and puts it in `error`.
- ui/composer.tsx:410: `{error ? <div class="msg err">{error}</div> : null}` renders after `</details>` of `.composer-options`, so it sits below Workflow advice and the whole Run options accordion. When the accordion is o …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/types.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** 1. Move the Docker image check into `problem` (ui/composer.tsx:187), e.g. `|| (containerEnabled && !remoteWorker && !containerImage.trim() ? "Choose a prebuilt agent image in Run options › Agent isolation." : "")`. Send and Schedule… are then disabled with that title, and `.composer-problem` shows it under the task box. Keep the guard in start() as a fallback.
2. Pre-flag untracked folders. In toggleContext/addContext, carry `entry.status` into the contextPaths value; ContextItem in ui/types.ts gets an optional status. A dir with status "U" then:
   - shows a warning on its chip, and
   - adds a `problem` entry: `Folder "qa-many" isn't committed; commit it or add individual files`.
   Untracked status is relative to the working copy, while the server checks baseRef. For full accuracy, also run a debounced server validation of contextPaths against baseRef (reuse /api/workspace/context, or add a validate-only endpoint around prepareContext's path checks) whenever paths or baseRef change. …

**Suggested regression test:** Extend test/e2e/ui.e2e.ts, near the agent-isolation steps in "project defaults stay repository-scoped…" (around line 1229), or add a focused composer test.

Docker image:
- Check "Run agents in a prebuilt Docker image" with the Image field empty.
- Assert `button.task-start` isDisabled() and its title contains "prebuilt agent image".
- Assert `.composer-problem` has that text and the Run actions › Schedule… item is disabled.
- Fill an image and assert Send is enabled again.

Untracked folder:
-  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4625 on 127.0.0.1:4625. I moved the old v4625 home aside so the server started with a fresh home, and used a fresh browser profile. Scratch clone of MQTT-MCP with a new untracked folder qa-many/ (3 files); git status shows `?? qa-many/`. Added the clone through the UI: Choose repository > path > Use this folder > Create project "v4625-mqtt".

Scenario 1 (1440x900):
- Files side panel > qa-many (aria-label "new, not committed", status U) > clicked "+". The chip "qa-many/" appeared. Typed a task.
- Before Send: Send was enabled (title "Start run (⌘↵)") and there was no .composer-problem.
- Clicked Send: POST /api/runs returned 400 and no run was created (/api/runs = []). The only feedback was `.msg.err` "Folder \"qa-many\" isn't in the base branch; commit it, or drop the individual files you need". Its previous sibling is details.composer-options, it sits 252px below Send, and "Workflow advice" and "Run options" are in between.
- Extra finding: removing the qa-many chip afterwards leaves the stale error on screen.

Scenario 2 (1280x760):
- Opened Run options > Agent isolation and checked "Run agents in a prebuilt Docker image", leaving Image empty.
- Send was still enabled, the title was unchanged and .composer-problem was empty.
- Clicked Send: no request was made, and nothing near the button changed while Send stayed in view. "Choose a prebuilt agent image" rendered 1124px below Send, outside the viewport. Scrolling to it pushes Send out of view.

Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4625/001-ctx-before-send.png, 002-ctx-after-send.png, 001-docker-after-send.png and 001-docker-error-scrolled.png (all in that folder). Scripts are s5.mjs, s6.mjs and s7.mjs in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4625/.

Refutation attempts that failed:
- docs/getting-started.md:128 says folders not in the base branch are rejected. So the rejection itself is by design, but nothing documents placing the error away from Send.
- The tester's environment and selectors are not involved: both scenarios reproduce on a fresh home and profile with the plain UI. Scenario 2 is a pure client check.

Cleanup: server stopped, ports 4625-4627 free, no runs created, scratch clone removed. Left over: the earlier v4625 home renamed to homes/v4625-prev-* in the scratchpad, and browser  …

</details>

### t17-7 · minor · Composer start errors (such as an invalid Result branch name) appear far below Start run, so clicking it seems to do nothing

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-02.

**Repro**

> 1. New run > Run options > Advanced > Branches and limits. Set Result branch name to 'main' (or 'bad..name', or a prefix already used). 2. Click Start run.

**Expected:** The error is visible next to the field or the button, or the page scrolls to it.

**Actual:** POST /api/runs returns 400 ('A branch named "main" already exists...'), but .msg.err is rendered about 3300 px down, after the expanded Run options. The viewport does not move, so nothing visibly happens. The invalid value also stays in the project draft, so later starts keep failing the same way.

**Root cause (verifier):** The location problem:
- ui/composer.tsx:410 renders the start error (`{error ? <div class="msg err">{error}</div> : null}`) after the closing tag of `<details class="composer-options">` (lines 352-409).
- When "Run options" is open, that details element holds the acceptance editor, checks and setup, the Advanced accordion (workflow templates, team, permission fieldsets, the "Branches and limits" settings in Settings at ui/composer.tsx:1146-1163), effective settings, context inspector and agent isolation. That puts the error about 2,500-3,000px below the Start/Send button (TaskBox, ui/composer.tsx:311-329).

The feedback problem:
- start() at ui/composer.tsx:241-257 only calls setError(err.message) in its catch block. It does not scroll the error into view or move focus to it.
- The error div has no role="alert". Compare `composer-problem` at line 342, which has role="status" and sits in the summary right under the button.
- The disabled-while-starting button (line 324) drops focus to <body>, so there's no focus cue either.

The persisting value:
- branchPrefix is a global signal (ui/state.ts:648) that the project draft saves (ui/state.ts:1202) and restores (ui/state.ts:1235). reset …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ux-flows.e2e.ts`

**Suggested fix:** 1. In ui/composer.tsx, move the start error out of the bottom of the composer, away from line 410. Render it next to the Start/Send button: either in the `.composer-summary` row beside `composer-problem` (line 342), or directly after `<TaskBox>`. Give it `role="alert"` so assistive technology announces it.

2. Make start() bring the error to the user. Keep a ref on the error element. After setError in the catch block, call `ref.current?.scrollIntoView({ block: "nearest" })` and `focus({ preventScroll: true })` on an element with tabIndex=-1. This follows the existing pattern in ui/sweeps.tsx:137. Alternatively, return focus to the Start button.

3. Optionally, link field-specific errors to their field. If the message comes from prefix validation (better: have the server return a field id such as `{ field: "branchPrefix" }` with the 400), also show it under the Result branch name input, using aria-invalid and aria-describedby. Open the "Branches and limits" details and focus the input w …

**Suggested regression test:** Add a Playwright case to test/e2e/ux-flows.e2e.ts, or to daily-workflow.e2e.ts, which already drives the composer with a fixture repo that has a main branch:
1. Fill the task.
2. Open Run options, then Advanced, then Branches and limits, and fill #branchPrefix with "main".
3. Scroll the Start/Send button (.task-start) into view and click it.
4. Wait for the 400 POST /api/runs.

Assert:
- `page.getByRole("alert").filter({ hasText: 'A branch named "main" already exists' })` is visible and `toBeInV …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4673 on 127.0.0.1:4673. I made a scratch clone of MQTT-MCP at qa/clones/v4673-mqtt and added it through the UI ("Open another repository", new project "v4673-mqtt"). Then I ran /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4673/t17-7b.mjs in headless Chrome at 1440x900. Output is in t17-7b.log in the same folder.

(1) Default single-agent composer. I typed a task, opened Run options > Advanced > Branches and limits and set Result branch name to "main". I scrolled back to the Send button and clicked it. POST /api/runs returned 400 {"error":"A branch named \"main\" already exists, so \"main/…\" branches can't be created"}. The only feedback was `.composer .msg.err` at top=2918px, inside the <main> scroll container (clientHeight 852, scrollHeight 2973). That is 2460px below the button. scrollTop stayed at 19 before and after the click. Focus fell to BODY because the button is disabled while the start is in progress. Nothing visible changed (shot 001-t17-7-single-main.png).

(2) Fix & review workflow ("Start run") with prefix "bad..name". The request returned 400 '"bad..name" is not a valid branch name prefix'. The error was rendered at top=3496px, 3039px below the button. The viewport did not move (shot 002-t17-7-fixreview-badname.png).

(3) With Run options collapsed, the next Start run showed the error directly under the collapsed "Run options" row, at y=775, inside the viewport (shot 003). So the problem only happens while Run options is expanded. That is the normal state for anyone who just edited a field in it.

(4) After a page reload the composer draft still held branchPrefix "bad..name" and the fix-review workflow, so later starts kept failing the same way.

The error element has no role="alert" or aria-live, so screen readers don't announce it either. No console errors appeared apart from the expected 400 responses.

Refutation checks:
- docs/getting-started.md:153 says a prefix can be used only once, so rejecting it on the server is by design. Docs don't specify where the error should appear, and nothing documents hiding it.
- The reporter's selector and workflow choice don't matter: both Send and Start run behave the same, because both call the same start().
- Nothing comes from the environment: it reproduces on a fresh server, project and profile.

</details>

### t04-12 · minor · Custom model ID is only validated after Send; error appears at the bottom and the custom field is gone

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-07.

**Repro**

> 1. Composer, Provider Claude Code → Model → 'Other model…'.
> 2. Type 'bad model!!' in 'Custom model'.
> 3. Navigate away and back (or just type a task) and click Send.

**Expected:** Inline validation in the custom field (same rule as MODEL_RE) with Send disabled until fixed.

**Actual:** Send enabled; after clicking, 'agent: Invalid model name for Claude Code: "bad model!!"' appears below Run options; model button shows 'bad model!!' but the custom input is no longer visible, so the user must reopen the picker to fix it (shots/t04b/001-custom-send.png).

**Root cause (verifier):** 1. ui/chat-controls.tsx:19: `const [custom, setCustom] = useState(false);`. Whether the custom field is shown lives only in local component state and is never worked out from `settings.model`. Any remount (route change, reload, project switch) hides the field while the stored model stays an ID that is not in the catalog. ModelSelect (ui/model-select.tsx, `selected = options.find(o => o.id === value)`) then finds no matching option and shows the raw value. Compare ModelRow at ui/composer.tsx:1220, which does `custom = customChoice ?? (!!s.model && !known)`.
2. ui/chat-controls.tsx:54: the `<input aria-label="Custom model">` has no validation, no aria-invalid and no hint. Its onInput calls `chooseModel(value.trim())` on every keystroke, which is why a space typed mid-ID is lost.
3. ui/composer.tsx:187: `problem` (what disables Send at ui/composer.tsx:325) never checks whether `soloSettings.model` is a valid ID.
4. The only check is on the server: src/adapters/index.ts:53 `MODEL_RE = /^[A-Za-z0-9][\w.:/[\]@-]{0,99}$/`, applied in validateAgentSettings at src/adapters/index.ts:63. src/server.ts:817 wraps the error with the role prefix (`agent: …`), and the composer shows it as the gene …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/index.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/side-chat.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** 1. Move the model-ID rule into a small module with no dependencies that both server and UI can import, e.g. `isValidModelId(agent, model)`. It should keep MODEL_RE for CLI providers and the 256-character, no-control-characters rule for acp:. Have validateAgentSettings in src/adapters/index.ts use it, so the client and server checks cannot drift apart.
2. In ChatControls, work out whether the custom field shows the way ModelRow does: `const known = !catalog || catalog.models.some(m => m.id === settings.model); const showCustom = custom || (!!settings.model && !known);`. Pass `value={showCustom ? "__custom" : settings.model ?? ""}` to ModelSelect so "Other model…" is marked selected.
3. On the custom input, set `aria-invalid` and show a short hint under the field when the value is not a valid ID (e.g. "Use letters, digits and . _ : / [ ] @ -; start with a letter or digit"). Store the raw value while typing and trim only on blur or at submit, so spaces typed mid-ID are not dropped.
4. In  …

**Suggested regression test:** - **Unit test:** add `test/model-id.test.ts`. Run a table of IDs through both the shared `isValidModelId` and `validateAgentSettings` and assert they agree.
  - Accepted: "opus", "claude-sonnet-4-5", "openrouter/x@y:free".
  - Rejected: "bad model!!", "--inject", '"q"'.
  - acp: IDs may contain spaces.
- **e2e test:** extend `test/e2e/ui.e2e.ts` with this fake-agent flow, using the existing `getByRole("button", { name: "Model", exact: true })` pattern:
  1. In the composer, open Model, choose "O …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4689 on 127.0.0.1:4689, driven with Playwright scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4689/ (repro.mjs, reload.mjs).

Steps:
1. Picked project MQTT-MCP, then Provider = Claude Code.
2. Model, then "Other model…". The "Custom model" textbox appears.
3. Filled "bad model!!". The model button showed "bad model!!". The input had no aria-invalid and no hint.
4. Typed a task. Send was enabled (title "Start run (⌘↵)").
5. Clicked Send. POST /api/runs returned 400 and no run was created (0 runs before and after). The red text 'agent: Invalid model name for Claude Code: "bad model!!"' appeared below the collapsed "Run options" row, about 250px under the controls (shot 005-a4-after-send.png). In this first pass, without leaving the page, the Custom model field was STILL visible with the bad value.
6. Clicked Inbox, then New run. The model button still read "bad model!!", the Custom model field was gone, and Send was still enabled. Send failed again with the same 400 and the same message at the bottom (shot 008-b2-send-after-nav.png).
7. Reloaded the page. The bad value persisted (stored in roleModels / the project draft), the custom field stayed hidden, and reopening the picker marked no option as selected, "Other model…" included. Choosing "Other model…" again brings the field back with the value.

Reporter's details I could not confirm: "just type a task" does NOT hide the field. Only a remount does (navigating away and back, or a reload). Every other claim reproduced.

Extra finding: the field trims on every keystroke, so a space typed in the middle disappears. Typing "claude sonnet" key by key produced "claudesonnet".

Cleanup: server v4689 stopped, no runs or worktrees created by me. The browser profile at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/profiles/v4689 still holds the bad model in its localStorage (QA-only).

Not by design: in Settings → Agents & models, ModelRow (ui/composer.tsx:1211-1221) works out "custom" from the saved value and keeps the field visible. That shows the intended pattern, and ChatControls does not follow it.

</details>

### t04-13 · minor · Composer model picker is silent when a provider's model listing fails (no reason, no 'Other model…')

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-09, SOL-07.

**Repro**

> 1. agy installed but `agy models` fails (fake FAKE_AGY_MODELS_FAIL=network or signed-out); Refresh providers.
> 2. Composer → Provider Antigravity CLI → Model.

**Expected:** Picker explains models couldn't be listed (as Settings does) and still allows a custom model ID; signed-out provider flagged in the Provider menu.

**Actual:** Picker lists only "Default model · Use the provider's default"; no error text, no 'Other model…'; signed-out Antigravity is selectable without a hint.

**Root cause (verifier):** ui/chat-controls.tsx:22-23 `const raw = catalogs.value[agent]; const catalog = raw && !("error" in raw) ? raw : undefined;` drops the `{ error }` entry that src/server.ts:2400-2408 sends for a failed listing. Nothing in ChatControls ever renders raw.error.

The ModelSelect options at ui/chat-controls.tsx:40-44 are then only the default entry, because both `freeModelsFirst(catalog.models)` and the `catalog?.allowCustom` "Other model…" entry need a catalog. Its description "Use the provider's default" gives no sign of failure.

ui/chat-controls.tsx:25 computes `efforts = ... ?? []`, so line 50 renders "This model offers no effort choices". That is wrong for agy, whose efforts are static (src/adapters/agy.ts:79) and do not come from the listing.

ui/chat-controls.tsx:37 marks a Provider MenuItem only with `!entry.available` ("Not installed"). AgentInfo (ui/types.ts:21-26) carries no sign-in state, and ChatControls never consults the `health` signal. Other views do: settings.tsx:121 and task-team.tsx:15 ("Sign in to this provider first").

Not by design: no doc describes this. Sibling views handle the same error explicitly. ModelRow (ui/composer.tsx:1212-1217) says "Uses the CLI's defa …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/model-select.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** In ChatControls, keep the failure: `const listError = raw && "error" in raw ? raw.error : undefined`.

1) Model picker: when listError is set, change the default option's description to something like "Couldn't list models — uses the CLI's default" and show the reason as a short note. A small optional `note` prop on ModelSelect could render a non-selectable help line under the search box. Also append `{ id: "__custom", label: "Other model…" }` on error for CLI providers whose run path takes free-form --model values (claude/codex/agy; the server validates by regex). Keep it hidden for acp:* providers, which declare allowCustom:false. This matches prompt-improvement.tsx:30.

2) Effort menu: on listError, replace "This model offers no effort choices" with "Effort choices unavailable — models couldn't be listed". Optionally, have GET /api/models return the adapter's static efforts alongside the error (e.g. `{ error, efforts }` for agy) so effort stays choosable.

3) Provider menu: read `he …

**Suggested regression test:** test/e2e/ui.e2e.ts (or agent-mode.e2e.ts): a new browser test. Either use `page.route("**/api/models", ...)` to fulfil the real response with agy replaced by `{ error: "agy models failed: getaddrinfo ENOTFOUND" }`, or spawn the e2e server with FAKE_AGY_MODELS_FAIL=network.

Steps: in `.task-controls .chat-controls`, open Provider and click "Antigravity CLI", then click the Model button.

Assert that:
- `.model-select-popup` text matches /couldn't list models/i;
- an option named "Other model…" e …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4691 on 127.0.0.1:4691 with a fresh home, driven by Playwright with a fresh profile each time. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4691/ (s2.mjs, s3.mjs, s4.mjs; logs s2-net.log, s3-net.log, s4-so.log, s3-ok.log).

1) Network failure: started with `export FAKE_AGY_MODELS_FAIL=network` (confirmed in the process environment).
- GET /api/models returned `agy: {"error":"agy models failed: Error: request to https://cloudcode-pa.googleapis.com failed: getaddrinfo ENOTFOUND ..."}`. /api/doctor reported agy signedIn:null with a fix text.
- UI path: Settings → Agents & models → Refresh providers. The Antigravity card says "Installed · login unknown", "Uses the CLI's defaults (couldn't list models)" plus the network fix text.
- Composer, with project MQTT-MCP picked: Provider → Antigravity CLI, then Model.
- The picker lists exactly ["Default model / Use the provider's default"]. It has no error text and no "Other model…" (screenshot shots/v4691/002-net-model-picker.png).
- The Effort menu says "This model offers no effort choices", which is also misleading.

2) Signed out: restarted with `FAKE_AGY_MODELS_FAIL=signed-out`.
- Settings shows "Signed out", "couldn't list models" and "Run `agy` in a terminal once and sign in…".
- In the composer, the Provider menu lists Claude Code / Codex / Antigravity CLI. Antigravity has no sub-text and is selectable.
- Model picker and Effort menu are the same as in case 1.
- Partial refutation: after Antigravity is selected and a task is typed, the composer DOES show a visible status line, "Antigravity CLI isn't signed in — open Settings → Agents & models", and Send is disabled with the same title (shots/v4691/004-so-composer-project.png). So "selectable without a hint" holds only for the menu itself.

3) Control: restarted without the env var. The same picker lists Default model, "Model One (High)", "Model Two", "Other model…", and Effort offers low/medium/high/xhigh/max. So the empty picker is caused only by the catalog error.

The UI raised no console errors and no 5xx responses. No runs were created. The server is stopped and ports 4691/4693 are free.

</details>

### t02-16 · minor · Signed-out provider is not marked in the Provider menu, and the setup banner hides when any other provider works

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-02, CMP-17.

**Repro**

> 1. Start a fake server with FAKE_SIGNED_OUT=claude.
> 2. Open the composer. No 'Connect a provider' banner shows, and Codex is pre-selected.
> 3. Open Provider: 'Claude Code' looks normal. Pick it.

**Expected:** The menu marks Claude as 'Not signed in' (as it marks 'Not installed'), and the banner or start reason links to Settings.

**Actual:** Only after picking does the start problem say "Claude Code isn't signed in — open Settings → Agents & models", with Send disabled. Race/Debate pills also don't mark it.

**Root cause (verifier):** The composer has the health data (`health.value[].signedIn`) and already uses it to skip Claude when choosing defaults (ui/state.ts:773, `rolesFor` eligibleDefaults filter `diagnostic?.signedIn !== false`) and to block start (ui/composer.tsx:570-571). The provider pickers that render the choices only look at installation:

- ui/chat-controls.tsx:39: the Provider MenuItem uses `disabled={!entry.available} sub={!entry.available ? "Not installed" : undefined}`. Signed-in state is never consulted.
- ui/composer.tsx:328: the fallback "Choose provider" menu also only checks `!entry.available || !supportsRunPermissions`.
- ui/composer.tsx:969-970: role pills (Race contestants, Debate debaters, judge and so on) set `disabled`/`title` only for not-installed or no-permission providers.
- ui/composer.tsx:571: the signed-out start reason is plain text, not a link to #/settings/agents.

The banner part is mostly by design. ui/onboarding.tsx:18 (`ProviderSetupPrompt`) hides when any provider is installed, signed in and compatible. Its copy, "Connect a provider to start a conversation or run a team", is a no-provider onboarding prompt, and test/e2e/history-launch.e2e.ts:240 asserts it stays hidde …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`

**Suggested fix:** 1. Add one shared helper, for example `providerStatus(id)` in ui/state.ts, that returns "Not installed" | "Signed out" | "Update CLI" | undefined from agents.value plus health.value. It could reuse the logic in task-team.tsx `teamProviderProblem`.
2. In ui/chat-controls.tsx:39, set `sub` from that helper so signed-out shows "Signed out — sign in from Settings".
3. Keep a signed-out item selectable or render it disabled, but be consistent with pills that set `disabled` while not `on`. Recommendation: disable it like "Not installed", unless it is the current choice.
4. Apply the same helper to the fallback menu at composer.tsx:328 and to the role pills at composer.tsx:969-970: a title of "Claude Code isn't signed in" plus a small "Signed out" marker or class.
5. When a default role silently drops a signed-out provider and the count rule then fails (race/debate < 2), append the reason, e.g. "A race needs at least two contestants (Claude Code is signed out)".
6. Render the signed-out start …

**Suggested regression test:** Add a Playwright e2e test, e.g. in test/e2e/task-team.e2e.ts or history-launch.e2e.ts. It can reuse the existing `page.route('/api/doctor', route.fulfill(...))` pattern (task-team.e2e.ts:106), or start the server with FAKE_SIGNED_OUT=claude. Then:

1. Open the composer and click the Provider menu. Assert that the "Claude Code" `.pop-item` contains the `.pi-sub` text /Signed out/ (and is disabled, if that is the chosen behaviour).
2. Switch #workflow-select to race. Assert the Claude pill's title …

<details><summary>Verifier's independent reproduction</summary>

I moved the old v4623 home aside so the server started with a fresh home. Then I ran `export FAKE_SIGNED_OUT=claude; qa-server.sh start v4623 4623 fake`. `GET /api/doctor` returned claude installed=true signedIn=false (fix: "Run `claude` in a terminal and sign in…"), and codex and agy as signed in.

I drove the UI with a fresh headless browser profile, using the script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4623/t02-16/r1.mjs (log r1.log next to it). Steps and results:

1. Opened /#/project/<MQTT-MCP>/new. Codex was pre-selected, `.provider-setup` count was 0 and Send was enabled.
2. Opened the Provider menu. The items were ["Claude Code", "Codex / ✓", "Antigravity CLI"]. Claude had no sub text, was not disabled and had no title, so it looked like the others (screenshot shots/v4623/002-provider-menu-open.png).
3. Picked Claude Code. The start problem read "Claude Code isn't signed in — open Settings → Agents & models" and Send was disabled. The text is plain, not a link (`.composer-problem a` count 0), and the banner was still hidden (003-claude-picked.png).
4. Switched to Race and Debate. Every Claude pill had the title "Toggle/Choose Claude Code", was not disabled and had no signed-out hint. The default contestants and debaters quietly dropped to Codex only, so the first reason shown was "A race needs at least two contestants" / "A debate needs at least two debaters", with no hint about Claude. Only after toggling Claude on did the reason change to "Claude Code isn't signed in…".

No console, page or 5xx errors. No runs were created.

</details>

### t02-20 · cosmetic · With no provider installed the start reason reads 'Pick an agent for Agent'

Source: tester unit composer-run-options-1; observed with real-agents; features CMP-17, CMP-01.

**Repro**

> 1. Start a server with no claude/codex/agy on PATH.
> 2. Open a project's composer and type a task.

**Expected:** A reason that matches the banner, e.g. 'Connect a provider (Settings → Agents & models)'.

**Actual:** Send is disabled with 'Pick an agent for Agent'.

**Root cause (verifier):** The full chain:
1. ui/state.ts:771-782 (rolesFor): eligibleDefaults keeps only providers that are available, signed in and compatible. With none left, line 779 filters solo's default ["claude"] down to [], and firstAvailable (line 776) is undefined, so line 782 cannot fill the role. Result: roles.agent = [].
2. ui/composer.tsx:555 (startProblem) then returns the generic role message `Pick an agent for ${role.label}`. The solo pattern's only role is labelled "Agent" (src/patterns/solo.ts:19), which produces the tautological "Pick an agent for Agent".
3. The provider-specific checks further down, ui/composer.tsx:569-571, build `used` from the selected roles. Since `used` is empty, they never run, so even the existing "<name> isn't signed in" message is hidden. There is also no branch for "no provider installed at all".
4. The banner uses a different predicate (ui/onboarding.tsx:16-18, ProviderSetupPrompt: no provider with installed && signedIn !== false && compatible !== false) and different wording ("Connect a provider"). So the banner and the Send reason disagree.
5. The server-side equivalents repeat the same label-based wording: src/server.ts:662 and :1997, and src/collab/link-ap …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer-tools.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`

**Suggested fix:** 1. Move the banner's predicate (ui/onboarding.tsx:18) into one shared helper, e.g. `usableProviders(agents, health)` in ui/state.ts or ui/composer-tools.ts, so the banner and startProblem agree.
2. In startProblem (ui/composer.tsx), for local runs only (no `inventory`), add checks after the task and pattern checks and before the role loop at line 555:
   - If health has loaded and no provider is usable: if some provider is installed but signed out, return "<name> isn't signed in — open Settings → Agents & models". Otherwise return wording that matches the banner, e.g. "Connect a provider first — open Settings → Agents & models".
3. Reword the generic role message so it never repeats itself. For example, use "Choose a provider" when the pattern has a single role, or when role.label is "Agent", and "Choose a provider for <label>" otherwise.
4. Optionally align the server-side messages at src/server.ts:662/1997 and src/collab/link-api.ts:51 the same way. That needs a matching update to th …

**Suggested regression test:** Unit test: put the provider-readiness reason in a pure function in ui/composer-tools.ts, e.g. `providerProblem(agents, health)`. Then extend test/composer-tools.test.ts, which already unit-tests that module, with three assertions:
- All agents unavailable: the result matches /Connect a provider/ and never /Pick an agent for Agent/.
- Claude installed but signedIn:false and the others unavailable: the result matches /Claude Code isn't signed in/.
- One usable provider: the result is "".

e2e: add …

<details><summary>Verifier's independent reproduction</summary>

Fresh QA home each time, read-only dogfood source, no runs created.
(A) No providers installed. I made a bin dir holding only a symlink to /usr/local/bin/node and started a server with PATH="<that dir>:/usr/bin:/bin:/usr/sbin:/sbin" on 127.0.0.1:4631 (home homes/v4631np). `which claude codex agy` failed on that PATH, and /api/agents returned claude, codex and agy all with available:false. In a fresh headless browser (script work/v4631np/repro.mjs) I opened #/project/p-ef01794b/new (MQTT-MCP) and typed "Add a short note to README about running tests" into Task.
- The banner read "Connect a provider to start a conversation or run a team. [Connect a provider]".
- .task-start (Send) was disabled with title "Pick an agent for Agent", and the composer summary showed the same line: "... | Limit 200 calls · 240 minutes | Pick an agent for Agent | Edit run options". Screenshot: shots/v4631np/001-no-provider-composer.png.
- In the "Choose provider" menu, Claude Code, Codex and Antigravity CLI were all disabled, so the advice to "pick an agent" cannot be followed.
- With "AI team" toggled On the reason was unchanged, because the solo agent stays the primary. No console errors or 5xx responses.
(B) Variant: claude installed but signed out. PATH held only node plus a wrapper running test/fake-agent.mjs as claude, with FAKE_SIGNED_OUT=claude (home v4631so, same port after stopping A). The banner and Send title were the same: "Pick an agent for Agent". The more specific "Claude Code isn't signed in — open Settings → Agents & models" never appears.
How I tried to refute it:
- No docs/*.md mention this wording or call it intended. docs/patterns.md and docs/configuration.md say nothing about it.
- The no-provider state is a supported first-run state: ProviderSetupPrompt exists for it, so this is not just the test environment.
- I reproduced it twice from fresh homes, independent of the reporter's script. The reporter's "real-agents" label is inaccurate: the condition is that no CLI is on PATH, and no real agent was involved.
Cleanup: both of my servers are stopped and nothing listens on 4631/4632. No runs, worktrees or branches were created. Port 4633 belongs to another verifier's server (home v4633e), so I did not use it.

</details>

### t02-11 · minor · No warning that uncommitted checkout changes are left out; the branch picker says 'Use the current checkout'

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-10.

**Repro**

> 1. In a scratch clone modify README.md and add an untracked file.
> 2. In the composer keep 'Current branch · main — Use the current checkout' and start a run.
> 3. Open the run worktree (side panel Files or git status in .worktrees/<id>/solo).

**Expected:** The composer says the worktree starts from the last commit and that local edits are not included (Improve's Repo mode already says this).

**Actual:** The worktree has neither the README edit nor the untracked file, and the composer gave no hint. The Files tab even marks those files M/U as if they were available.

**Root cause (verifier):** ui/composer.tsx:711 (WorktreeBranchPicker): the default option is `{ id: "", label: info.current ? \`Current branch · ${info.current}\` : "Current HEAD", description: "Use the current checkout" }`. "Checkout" reads as the working tree, but the server creates the worktree with `git worktree add -b <prefix>/<name> <path> <base>` at the committed HEAD, so tracked edits and untracked files are never included. That matches docs/getting-started.md:152. The composer also has no signal for repository dirtiness. GET /api/branches (src/server.ts:1929-1931, src/git.ts:557-577 listBranches) returns only { repo, worktreeRoot, current, branches }, and RepoInfo (ui/types.ts:28-33) has no dirty field. The only dirtiness check is the opt-in readiness inspection (src/readiness.ts:21 and :29, "Working copy" item), which is worded for validation. So the behaviour is intended, but the composer gives no hint and its copy is misleading.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/git.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/types.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/readiness.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/getting-started.md`

**Suggested fix:** 1. Copy-only fix (minimum). In ui/composer.tsx:711, change the default option's description from "Use the current checkout" to wording that matches the docs and the Improve menu, e.g. "Latest commit on main. Uncommitted changes are not included." For a detached HEAD, use "Current commit".
2. Optional: a dirtiness hint.
   - Add `dirty: { tracked: number; untracked: number } | null` to the /api/branches response. Compute it with one bounded `git status --porcelain=v1 -z --untracked-files=normal` (ignored files excluded) in listBranches or the server handler, and add the field to RepoInfo.
   - When the default "Current branch" is selected and dirty is non-zero, show a short help line next to "New worktree", e.g. "2 uncommitted changes in your checkout aren't included. Commit them, or add files with + to give the agent your working copy." This points to the documented .codeflow-context mechanism.
   - Optionally reword the readiness "Working copy" detail so it also covers the run worktre …

**Suggested regression test:** Add a UI unit test next to test/repo-selection-ui.test.ts (same mocked-/api/branches harness, or test/project-drafts.test.ts). Render WorktreeBranchPicker with repoInfo { current: "main", branches: [...] }, open the picker and assert the default option's description matches /not included|uncommitted/i and is not "Use the current checkout". If the dirty field is added: mock /api/branches with dirty: { tracked: 1, untracked: 1 } and assert the composer help text mentions uncommitted changes; with  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server "v4613w" on 127.0.0.1:4613 (new home, fresh browser profile). Made a scratch clone of MQTT-MCP (bare clone, then a working clone v4613-t0211 on main at 2b97323). Appended "LOCAL EDIT MARKER v4613" to README.md and created an untracked UNCOMMITTED_NOTE.md, so git status showed " M README.md" and "?? UNCOMMITTED_NOTE.md". Opened the clone in the UI ("Open another repository", Go, "Open this repository", new project "v4613 dirty mqtt").
- Composer: shows "Start from branch | Current branch · main | New worktree". Opening the picker shows the first option "Current branch · main / Use the current checkout" (screenshot shots/v4613w/002-branch-picker.png). Nothing in the composer, its summary line or Run options says uncommitted or untracked changes are left out. A regex scan of the page text for uncommitted/local edit/last commit found nothing.
- The composer side-panel Files view ("v4613-t0211 · repository") marks README.md "M" and UNCOMMITTED_NOTE.md "U".
- Started a solo fake run (2610251910-39262def) with the default "Current branch". The API reports baseRef 2b97323. In the worktree .worktrees/2610251910-39262def/solo, `grep -c "LOCAL EDIT MARKER" README.md` = 0, UNCOMMITTED_NOTE.md is missing, and git status shows only the fake agent's file. The run-page Files tab (solo · codeflow/.../solo) correctly shows neither file as M or U.
- Refutation checks:
  (a) Excluding the edits is documented and intended. docs/getting-started.md:152 says "Base branch ... By default this is the repo's current HEAD ... Uncommitted changes in your checkout aren't included."
  (b) The M/U markers are by design too. That view is the main checkout, and docs/getting-started.md:120-125 say you can + those files to copy your working-copy version into .codeflow-context/. The run-page Files tab shows the worktree accurately, so that sub-claim is not a defect.
  (c) The report says RepositoryReadiness never mentions dirtiness. That is not quite right: Run options › Repository readiness › Inspect readiness gives "Warning · Working copy · Uncommitted changes are not part of validation at the selected commit." But that check is opt-in, collapsed and about validation, not about the run's worktree.
- What still holds: the composer's own copy ("Use the current checkout") suggests the reverse of the documented behaviour. Every other committed-snapshot surface states the exclusion: Improve Repo mode ("Skips local edits."), Settings › prompt improvement, the workbench and f …

</details>

### t02-10 · minor · Composer summary shows the remembered branch while a PR source locks the start branch

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-10.

**Repro**

> 1. Pick any branch in 'Start from branch'.
> 2. Click GitHub > Pull requests and choose a PR (fake gh).
> 3. Compare the branch picker with the summary line.

**Expected:** The summary shows the PR head (as 'Branches and limits' does: "PR #7's branch").

**Actual:** The picker shows 'PR #7 · feature/qa-remote-base' (locked), but the summary says 'Repository t02-studio · qa-local2'.

**Root cause (verifier):** The composer works out the start-branch label in three places, and only one of them checks for a PR source.

- ui/composer.tsx:1141-1142 (Settings, "Branches and limits") is correct. It sets `fromPr = source.value?.kind === "pr"` and shows `PR #N's branch`.
- ui/composer.tsx:340 (the composer-summary "Repository" line) renders `{baseRef.value || repoInfo.value?.current || "HEAD"}` and ignores `source.value`.
- ui/onboarding.tsx:302 (EffectiveSettings "Run details", row "Start branch") renders `baseRef.value || "Current HEAD"` with source "Selected branch (remembered)", and also ignores `source.value`.

WorktreeBranchPicker (ui/composer.tsx:705-714) locks the picker to `PR #N · headRefName` but leaves `baseRef.value` unchanged on purpose, so it can come back when the PR source is removed. The server then overrides it: src/engine.ts:5165 uses `fromGitHub?.branch` (codeflow-pr/N) in place of input.baseRef, except for a rerun of the same PR source.

Result: two of the three labels show a remembered branch the run will not use. Because the visible summary names the wrong start commit, I rate this above cosmetic (minor). No wrong action results, though: the run still starts from the corr …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Add one shared helper and use it for all three labels. For example, `startBranchLabel()` in ui/composer.tsx, or a computed signal next to `source`/`baseRef`:
- If `source.value?.kind === "pr"`, return `PR #${n} · ${headRefName}`, or "PR #N's branch" to match Branches and limits.
- Otherwise return `baseRef.value || repoInfo.value?.current || "HEAD"`.

Use it at:
- ui/composer.tsx:340 (summary)
- ui/composer.tsx:1142 (Branches and limits)
- ui/onboarding.tsx:302 (Run details row). For a PR source, set this row's source column to "GitHub pull request #N".

Keep `baseRef.value` as it is, so removing the PR source brings back the remembered branch.

Optional edge case: for a rerun with the same PR source, src/engine.ts:5165 uses input.baseRef (the pinned commit), so the label could say "PR #N (pinned)" when `restored?.source` matches.

**Suggested regression test:** Extend the PR-source flow in test/e2e/ui.e2e.ts, which already has a bare origin with PR #1 and fake gh state at about line 56:
1. Pick a non-default local branch in "Start from branch".
2. Choose PR #1 from GitHub > Pull requests.
3. Assert that `page.getByLabel("Run configuration summary").innerText()` matches /PR #1/ and does not contain the picked branch name.
4. Expand Run options > Run details and assert the "Start branch" row matches /PR #1/.
5. Remove the PR source and assert the summary …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4611 on 127.0.0.1:4611. The home had no runs, only the default projects.json. Setup: a scratch bare clone of MQTT-MCP plus a working clone. In the clone I created feature/qa-pr7 (one extra commit, 1d46db0), pushed it to origin as refs/heads/feature/qa-pr7 and as refs/pull/7/head, and created a local branch qa-local-v (= main, 2b97323). fake-gh.json had PR #7 (headRefName feature/qa-pr7, base main). I added the clone through the UI with "Open another repository" and "Create project" ("v4611 MQTT scratch").

Playwright scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4611/a2.mjs and a3.mjs:
1. Picked qa-local-v in "Start from branch". Summary: "Repository v4611-mqtt · qa-local-v". This is correct.
2. Chose GitHub > Pull requests > "QA v4611 PR". The picker became "PR #7 · feature/qa-pr7" and was disabled. The summary still said "Repository v4611-mqtt · qa-local-v". The state survived a reload.
3. Run options > Advanced > "Branches and limits" said "from PR #7's branch", which is correct. "Run details" > "Start branch" row said "qa-local-v · Selected branch (remembered)". That is a second wrong place the report did not mention.
4. Started a fake solo run (run 2610251909-8647130e, check "true"). GET /api/runs/<id> returned baseRef 1d46db0 (the PR head), baseLabel codeflow-pr/7 and source.kind pr #7. So the run really started from the PR head and not from qa-local-v. The summary line and the Run details row both named the wrong start point.

No console errors or 5xx responses. Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4611/001-pr-selected-summary.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4611/001-run-details-start-branch.png.

Ways I tried to refute it:
- Docs and code comments: nothing says the summary should show the remembered branch while a PR source is set. The engine comment at src/engine.ts:5160 says "A PR's own branch is the base", and the composer itself shows "PR #N's branch" in Branches and limits.
- Environment: the result does not depend on the tester's environment. A different repo, a different PR and a fresh home gave the same result.

Cleanup:
- Deleted the run through the rail "Delete…" dialog (runs left: []).
- Stopped server v4611 (port 4611 is free). …

</details>

### t02-1 · minor · Double-clicking a file in the Files panel adds the wrong file (the entry above it) to the task context

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-12.

**Repro**

> 1. Start a fake QA server and add a scratch clone of IndustriAgents-Studio as a project through 'Open another repository'.
> 2. In the composer click 'Files' in the task box. The side panel opens on the repository tree.
> 3. Double-click 'docker-compose.yml' in the tree.
> 4. Look at the context chips under the task box.

**Expected:** docker-compose.yml is added as a context chip. The code wires onDblClick to addContext(entry).

**Actual:** The viewer opens docker-compose.yml, but '.gitignore' (the row above) is added as a context chip. Repeats reliably: tsconfig.base.json added README.md, and vitest.config.ts added UNCOMMITTED_NOTE.md. The wrong file then goes to the agents as context.

**Root cause (verifier):** The first click of the double-click changes the layout before the second click arrives.

1) ui/composer.tsx:1385: the TreeNode row has onClick={toggle}. For a file, toggle (composer.tsx:1355-1356) calls onOpen(entry.path) straight away on the first click. Only onDblClick at composer.tsx:1387 adds the file (`context && entry.type === "file" && addContext(entry)`).

2) ui/code-browser.tsx:44 and :21-24: onOpen calls loadFile, which goes through perform() and sets busy=true. Preact re-renders in a microtask.

3) ui/code-browser.tsx:93: `{busy ? <p class="help files-progress" role="status">Working…</p> : null}` is placed in normal flow between the header and `.files-explorer` (code-browser.tsx:94). styles.css (around line 3485) has no rule that takes it out of flow, so it pushes the whole tree down about 30 px, which is one row. A second click during the load therefore lands on the row above. That row's onDblClick adds its own entry. Its onClick→onOpen is ignored by `if(!busy)`, so the viewer still shows the file actually clicked.

4) When the load finishes, selectedPath is set and `.files-explorer` gets hidden={!!selectedPath} (code-browser.tsx:94). A later second click lands on the e …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/code-browser.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/getting-started.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Two changes are needed together.

(a) Stop the progress line from shifting the tree. In ui/code-browser.tsx:93, move the "Working…" status into the `.files-heading` header when compact is set. Or give `.compact-files .files-progress` a non-flow position in styles.css (an absolutely positioned overlay, or a space reserved for it), so no row moves while busy.

(b) Make the double-click target the row that got the first click, even though that click also opens the file. In TreeNode (ui/composer.tsx:1355 and 1385-1387), when `context` is true and the row is a file, delay onOpen on a click with e.detail===1 by about the double-click interval (~250-300 ms), keeping the timer in a ref. On dblclick, or a click with e.detail>=2, clear the timer, call addContext(entry), and optionally then open it. Outside the composer, where context is false, keep opening immediately.

Another option is to drop double-click-to-add from the side panel and update docs/getting-started.md:120. The + button, drag, a …

**Suggested regression test:** Add a test in test/e2e/ui.e2e.ts, in the composer flow on a fixture repo with at least two files next to each other (for example .gitignore and then package.json).

1. Open the Files side panel from the task box.
2. Delay /api/workspace/file by about 250 ms with page.route.
3. Double-click the second file at human speed: page.mouse.down/up({clickCount:1}), wait 150 ms, then page.mouse.down/up({clickCount:2}) at the same point. Also run a page.mouse.dblclick variant with no delay.

Assert that th …

<details><summary>Verifier's independent reproduction</summary>

I started from a new fake QA server, v4689 on port 4689. I moved the old v4689 home aside to homes/v4689-prev-1932 so the home started empty. I used a new browser profile (v4689-t021) and a scratch clone of IndustriAgents-Studio, which I added through "Open another repository" and then "Create project" (project v4689-studio). I clicked "Files" in the task box, and the side panel opened on the tree. The rows are 30 px tall: .gitignore@359, docker-compose.yml@389, README.md@479, tsconfig.base.json@509, vitest.config.ts@539.

A capture-phase listener logged every mousedown, click and dblclick, with the treeitem under each one and whether .files-progress was in the DOM. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4689/t02-1/ (a3.mjs, a3-pw.log, a3-human.log, a4.mjs, a4.log).

1) Playwright page.mouse.dblclick, as in the report: docker-compose.yml added .gitignore, tsconfig.base.json added README.md, and vitest.config.ts added tsconfig.base.json. Each time the viewer opened the file I clicked. The log shows why. The first click hit docker-compose.yml, and 1 ms later the progress line appeared (h=18.6 px plus margin, about one 30 px row). The second mousedown, click and dblclick, at the same y=404, then hit .gitignore. The progress line went away about 30 ms later.

2) A human-paced double-click with a 10 ms gap gave the same wrong file. With gaps of 40, 120 and 250 ms, the file had already loaded (about 30 ms on the local fake server) and the explorer was hidden. The second click and the dblclick landed on the textarea (target=field wb-editor). No chip was added, although docs/getting-started.md:120 says double-clicking adds the file.

3) A human-paced double-click (150 ms gap) with /api/workspace/file slowed by 250 ms through page.route. This stands in for a remote computer, a large file or a slow disk. The wrong file was added every time, 3 out of 3: .gitignore, then README.md, then tsconfig.base.json. Screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4689/002-t021-human-docker-compose.yml.png shows the viewer on docker-compose.yml and the only chip as ".gitignore".

No console errors or 5xx responses. The behaviour is not by design: the docs say double-click adds the file you double-clicked.

Severity re-assessed as minor rather than major. On a fast local server at normal  …

</details>

### t02-12 · minor · Files tree silently truncates subfolders with more than 1000 entries

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-12.

**Repro**

> 1. Create an untracked folder qa-many with 1005 files in a scratch clone.
> 2. In the composer open Files and expand qa-many.

**Expected:** A 'Showing the first 1000 — use search' note, as for the root listing.

**Actual:** 1000 children are shown with no note. GET /api/tree?path=qa-many returns truncated:true.

**Root cause (verifier):** src/repo-tree.ts:46-71 (`listTree`) correctly cuts every folder listing to MAX_ENTRIES = 1_000 (line 15) and returns `truncated: entries.length > MAX_ENTRIES`. The UI reads that flag in only one place: `FileTree` (ui/composer.tsx:1263 `useState(false)`, :1281-1285 `setTruncated(d.truncated)` for `path=`, and the note at :1322 `{!results && truncated ? <div class="tree-empty">Showing the first 1000 — use search</div> : null}`).

`TreeNode.expand` (ui/composer.tsx:1340-1353) types the response as `api<{ entries: TreeEntry[] }>` with no `truncated` field. It calls only `setChildren(d.entries)` and `setMessage(d.entries.length ? "" : "Empty folder")`, so the flag is discarded for every subfolder. `FileTree` is shared by the composer and side panel Files tab and by Repository tools → Code (ui/code-browser.tsx:94), so all of those surfaces show a truncated subfolder as if it were complete.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/simplification.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/context.test.ts`

**Suggested fix:** In TreeNode (ui/composer.tsx around 1333-1353):
1. Add `const [truncated, setTruncated] = useState(false)`.
2. Type the call as `api<{ entries: TreeEntry[]; truncated?: boolean }>` and call `setTruncated(!!d.truncated)` next to `setChildren(d.entries)`.
3. Where the open node renders its children, put the same note as the root after the last child, e.g. `<div class="tree-empty" style={`padding-left:${2 + (depth + 1) * 14}px`}>Showing the first 1000 — use search</div>`, so it lines up with the children.

It would be cleaner to export a constant or a small `TruncatedNote` component, so the root and subfolder notes share one message. The message could also be built from the server's limit (for example, return `limit: MAX_ENTRIES` from listTree) instead of hard-coding 1000 in two places. Keep the note outside role="treeitem" elements so arrow-key navigation is unchanged.

**Suggested regression test:** 1. Server: in test/context.test.ts, next to the existing `listTree(repo, "src")` assertions, create a subfolder with 1001 files. Assert that `listTree(repo, "big")` returns 1000 entries and `truncated === true`, and that a 1000-file folder returns `truncated === false`.
2. UI: in a browser e2e (test/e2e/simplification.e2e.ts already drives the side panel Files tab around line 154), set up a fixture repo with an untracked folder of 1001 files. Open Files and expand that folder. Assert that the pa …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4615 on 127.0.0.1:4615. I made a scratch clone of MQTT-MCP (bare clone plus working clone at scratchpad/qa/clones/v4615-mqtt) and added an untracked folder qa-many with 1005 files, f0001.txt to f1005.txt. In the composer UI I clicked "Open another repository", entered the clone path, clicked "Open this repository", then "Create project" (project p-fc17c7c5). I clicked Files in the composer, which opened the side panel Files tab, and expanded qa-many.

Results (scripts in scratchpad/qa/work/v4615/a-open.mjs, b-expand.mjs and c-search.mjs):
- GET /api/tree?path=qa-many returned 200 with 1000 entries, truncated:true, last entry f1000.txt.
- The UI showed exactly 1000 level-2 children (f0001.txt to f1000.txt). f1001 to f1005 were missing.
- No .tree-empty, status or help note appeared inside the tree, and no "first 1000 / use search / truncat" text appeared anywhere on the page.
- Screenshot shots/v4615/002-qa-many-end.png shows f1000.txt followed directly by the next sibling folder `scripts`, with no hint that anything was cut off.
- Searching "f1005" did find "f1005.txt, in qa-many", so the files can be reached, but nothing tells the user to search.
- No console errors or 5xx responses.

On refutation: I found nothing in the docs or code comments that makes silent truncation intended. docs/runs.md describes the Files panel without mentioning a limit. The same component shows the truncation note for the root listing, and other listings (the folder picker, memory graph, GitHub lists) consistently say when they are truncated. The tester's script and environment are not the cause: the API itself reports truncated:true and the UI drops it.

</details>

### t02-18 · minor · Files '+' removes an already-added item but keeps the label 'Add X to the task'

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-12.

**Repro**

> 1. In Files click '+' on README.md (a chip appears).
> 2. Click the same '+' again.

**Expected:** The button reads 'Remove X from the task' (or shows a check) when added.

**Actual:** Its aria-label and title stay 'Add README.md to the task', and clicking removes the chip.

**Root cause (verifier):** ui/composer.tsx:1403-1413 (TreeNode). The "+" button's `title` and `aria-label` are fixed strings, `Add ${entry.path} to the task` (lines 1406-1407), and its glyph is always "+" (line 1413). But its onClick (line 1410) calls `toggleContext(entry)` (ui/composer.tsx:899-904), which deletes the path from `contextPaths` when it is already there.

The component already computes `added` (ui/composer.tsx:1335: `context && contextPaths.value.has(entry.path)`), but only uses it for the `added` CSS class (line 1376; styles.css:632-633 recolour the label and keep the "+" visible). The button gets no label change, no aria-pressed, and no different glyph.

The treeitem's aria-label (line 1381) does not include an "added" state either. A screen-reader user therefore hears "Add README.md to the task", activates it, and the item is removed from the task without any notice. The footer hint (line 1326) also only says "+ … adds it".

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/history-launch.e2e.ts`

**Suggested fix:** In TreeNode (ui/composer.tsx around lines 1403-1413), build the button from the existing `added` flag.

- Use `const verb = added ? \`Remove ${entry.path} from the task\` : \`Add ${entry.path} to the task\``, and use it for both `title` and `aria-label`.
- Optionally add `aria-pressed={added}`. If you do, keep one stable name ("Include README.md in the task"), because a toggle button should not also change its name.
- Show a different glyph when added, for example a check icon or "−" instead of "+".
- Add ", in the task" to the treeitem's aria-label (line 1381) when `added`, so the state is announced while navigating the tree.
- Update the footer hint (line 1326) to say "+ adds it to the task (click again to remove)".
- In styles.css next to `.node.added .add` (line 633), style the removal state, for example a hover colour in the --err tone.
- Keep the toggle behaviour itself; the chip's × does the same thing.

**Suggested regression test:** Extend test/e2e/history-launch.e2e.ts, where line 271 already clicks `getByRole("button", { name: "Add api to the task", exact: true })`. After that click, assert the following:

1. `page.getByRole("button", { name: "Remove api from the task", exact: true })` is visible (and has aria-pressed="true" if that is used), and the treeitem's accessible name includes "in the task".
2. Clicking that button removes the "api" chip from `.taskbox .chips`.
3. The button's name is back to "Add api to the task …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server ("qa-server.sh start v4627 4627 fake") and opened it in a fresh headless Chrome with no saved profile. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4627/t0218.mjs (log in t0218.log next to it).

Steps: switch to the MQTT-MCP project in the project picker, click the composer's "Files" button, then find the treeitem "README.md" and its button.add.

Before adding, the button's aria-label and title were both "Add README.md to the task", the text was "+", there was no aria-pressed, the node class was "node", and there were no chips.

After the first click, the README.md chip appeared and the node class became "node added". The button did not change: aria-label and title still "Add README.md to the task", text still "+", no aria-pressed. The accessibility snapshot showed `treeitem "README.md"` containing `button "Add README.md to the task": +`, so the treeitem's own name has no "added" state either.

After the second click on the same button, the chip went away. So a control named "Add" removed the item.

Screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4627/002-after-add-hover.png shows the added state: README.md is accent-coloured and its "+" is at full opacity, but the glyph is still "+". The files footer still says "+ or drag adds it to the task". No console errors or 5xx responses.

Checking whether it is by design: the comment at ui/composer.tsx:1258 and the footer at ui/composer.tsx:1326 only describe adding. No doc in docs/*.md says that "+" removes. The toggle in onClick is deliberate, but nothing in the UI tells the user about it. The reporter's selector (getByRole button name "Add README.md to the task") is correct. The result does not depend on the reporter's environment: I reproduced it with a fresh profile on a different project.

Cleanup: I created no runs (the one "*.deleted" entry in homes/v4627/runs is from an earlier session), and server v4627 is stopped. Leftovers: only the script, log and screenshots in the scratchpad.

</details>

### t02-7 · minor · Folder picker: a non-canonical typed path + Enter shows '✓ git repository' but leaves 'Open this repository' disabled; '~' is not expanded

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-05.

**Repro**

> 1. Click 'Open another repository'.
> 2. In the Folder path field type '<clone>/t02-mqtt/' (or '<clone>/t02-mqtt/.' or '<clone>/t02-mqtt/mqtt-python/..') and press Enter.
> 3. Look at the footer.
> 4. Type '~/Documents' and press Enter.

**Expected:** Enter normalises the path (as Go does) and enables the primary button. '~' resolves to the home folder.

**Actual:** The status reads '✓ This folder is a git repository' while the primary button stays disabled. Clicking Go fixes it. '~/Documents' shows 'Folder not found'.

**Root cause (verifier):** Bug 1 (Enter does not normalise the path): ui/app.tsx:611
`if (!typed.current && document.activeElement !== pathInput.current) setPath(d.path);`
The focus guard was added in #44 so that a slow default listing would not overwrite a paste in progress. But it also skips the rewrite for an explicit browse that the field itself started. The Enter handler at ui/app.tsx:694-698 calls browse(value) while the field still has focus, so after Enter the field keeps the non-canonical text ("<clone>/", "<clone>/.", "<clone>/x/..", "<clone>//"). Then ui/app.tsx:612 sets "✓ This folder is a git repository" from d.isRepo. Meanwhile ui/app.tsx:739 disables the button because `path.trim() !== dir.path` (the server returns the resolve()d canonical path from src/fs.ts:27). The click guard at ui/app.tsx:740-741 repeats the same strict comparison. Go works only because clicking it moves focus off the field.

Bug 2 (no '~' expansion): src/fs.ts:27 `const target = resolve(path?.trim() || homedir());` runs "~/Documents" through path.resolve, which treats it as relative to process.cwd() (<server cwd>/~/Documents). That gives ENOENT, which src/server.ts:1922-1926 maps to 404 "Folder not found". For the same r …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/fs.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-navigation.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/fs.test.ts`

**Suggested fix:** UI (ui/app.tsx FolderPicker): treat a listing that the field itself requested as a match for the field's text.

Option A (safest; it does not reopen the #44 paste race): record the string each browse was requested with, e.g. `const [listedFrom, setListedFrom] = useState("")`, and call setListedFrom(target ?? "") together with setDir(d). Then define `const matches = (v: string) => !!dir && (v === dir.path || (!typed.current && v === listedFrom))`. Use it in both the disabled expression at :739 and the onClick guard at :740-741, and always choose(dir.path), the canonical path.

Option B: pass an `explicit` flag from Enter/Go into browse() and call setPath(d.path) when `!typed.current && (explicit || document.activeElement !== pathInput.current)`. This restores pre-#44 normalisation on Enter, and the guard still protects only the background opening listing.

Either way, the "✓ git repository" status and the button state should never disagree. If they can, show a hint such as "Press Enter  …

**Suggested regression test:** 1. test/e2e/project-navigation.e2e.ts, in the "repository picker clears stale feedback…" test: for each of `repoA + "/"`, `repoA + "/."` and `join(repoA, "sub") + "/.."`, do field.fill(v), then field.press("Enter"), then wait for "✓ This folder is a git repository". Then assert that `await open.isEnabled() === true` (and optionally that the field value equals repoA), and that clicking open proceeds to the project choice dialog. Today it fails with isEnabled() === false.
2. test/fs.test.ts: asser …

<details><summary>Verifier's independent reproduction</summary>

I moved the existing v4605 home aside (homes/v4605.prev-<ts>), so I started from a fresh home. I started a fake-mode QA server ("qa-server.sh start v4605 4605 fake"). I made my own scratch clone of MQTT-MCP at clones/v4605-mqtt (bare repo plus checkout).

Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4605/picker.mjs. It used a fresh headless Chrome with no profile. It opened /#/new, clicked "Open another repository", then for each path: clicked the Folder path field, pressed Cmd+A and Backspace, typed the path with real keystrokes (keyboard.type, not fill), pressed Enter, and read the footer status, the field, the breadcrumb, the primary button's disabled state and document.activeElement.

Results (log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4605/picker.log):
- <clone> + Enter (control): status "✓ This folder is a git repository", button enabled.
- <clone>/ + Enter: same "✓" status, button disabled=true, field keeps "<clone>/", focus still in "Folder path".
- Waiting 1.5 s and blurring the field changes nothing: still disabled. Force-clicking the disabled button does nothing and the picker stays open.
- <clone>/. + Enter, <clone>/mqtt-python/.. + Enter and <clone>// + Enter: all "✓", all disabled=true. The breadcrumb shows the canonical v4605-mqtt.
- <clone>/ + Go click (control): field normalised to <clone>, button enabled. Focus is on Go.
- ~/Documents + Enter and ~ + Enter: "Folder not found" (the 2 console 404s are these requests). The ~ Home button works.

Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4605/002-trailing-slash-enter.png shows the green check next to a greyed-out "Open this repository".

Direct API check: /api/fs?path=~ and ?path=~/Documents both return 404 "Folder not found". ?path=docs returns <dogfood-qa>/docs, because relative paths resolve against the server's own working directory.

Ways to refute, all ruled out: real keystrokes (not fill) were used, focus naturally stays in the field after Enter for any user, and the browser was fresh. No docs describe this behaviour. The e2e test daily-workflow.e2e.ts:255 uses repo+"/." with a Go click, never Enter, so this path is untested. git history shows the focus guard was added in 217a659 (#44). Before that, an explicit browse always c …

</details>

### S00-3 · minor · Folder picker: typing a non-canonical path (trailing slash, '..') and pressing Enter leaves 'Use this folder' / 'Open this repository' disabled even though the status says '✓ This folder is a git repository'; clicking Go works around it.

Source: code-level suspect at `ui/app.tsx:739` (confirmed hands-on).

**Repro**

> Fake server s00, work/s00/picker.mjs: composer 'Choose repository' > type '<repo>/' in Folder path > Enter. The field keeps '<repo>/', the status reads '✓ This folder is a git repository', the breadcrumbs show the canonical '<repo>', and 'Use this folder' is disabled. Typing '<repo>/../s00-demo' gives the same result. The canonical path enables the button. Clicking Go instead of Enter replaces the field with the canonical path and enables the button. Screenshot shots/s00/001-picker-trailing-slash.png.

**Expected:** After Enter lists a git repository, the primary button is enabled (the field is normalised to the listed path, or the comparison accepts the path the user just browsed).

**Actual:** The button stays disabled until the user clicks Go or edits the text to exactly match dir.path.

**Root cause (verifier):** browse() only overwrites the field when document.activeElement !== pathInput. That guard protects paste/select-all during the initial listing, but pressing Enter keeps focus in the field, so the canonical d.path is never written back. The primary button requires path.trim() === dir.path. The Go button works because clicking it moves focus. The e2e test daily-workflow.e2e.ts uses Go for '/.'.

**Suggested fix:** Pass an explicit flag from the Enter handler, and from Go, so browse() always replaces the field with d.path when the request came from an explicit browse (keep the focus guard only for the automatic default listing). Alternatively, remember the target text that produced the current listing and enable the button when path.trim() equals that target or dir.path.

**Suggested regression test:** e2e: open the picker, fill '<repo>/', press Enter, assert the status shows the git repository line, the field equals the canonical path, and 'Use this folder' / 'Open this repository' is enabled and opens the repo.

### t02-21 · minor · Real Claude Quick Improve tells the user 'The repository is empty here' in Open questions

Source: tester unit composer-run-options-1; observed with real-agents; features CMP-13.

**Repro**

> 1. Real server. Settings > Prompt improvement: Agent Claude Code, mode Quick (defaults, haiku).
> 2. In a project's composer type 'the mqtt server should let me list retained topics, add a tool for that and a test. keep it small' and click Improve.

**Expected:** Quick mode works from the text alone and does not imply anything about the user's repository.

**Actual:** The rewrite adds 'Open questions: - Which MQTT server codebase and language should this go into? The repository is empty here.' This is misleading: the user's repo is not empty, only the private Quick sandbox is.

**Root cause (verifier):** The model repeats wording that CodeFlow puts in its own prompt.

- **src/improve.ts:112** (reported as :118; it is 112 in this checkout): in `improveInstructions()`, the Quick branch says: "- Work from the text alone: don't use tools or read files. This private Git repository is empty and contains no source repository context." The model reads "repository" as the user's project and, when it can't tell which codebase is meant, adds "The repository is empty here" to its Open questions. Nothing in the prompt says that the user's real repository exists, is not empty, and is where the agents will run.
- **Why it reaches the user:** the instruction at improve.ts:108 (list unclear points under "Open questions:") gives the model a place to put that remark. The rewritten text replaces the user's task in the composer and is sent to the coding agents as is.
- **Downstream effect:** an agent working in the real, non-empty worktree is told "The repository is empty here", which could push it toward building a project from scratch.
- **Related summary wording:** src/improve.ts:153 adds "Context: text only; empty private repository." to the summary. It is labelled as context, but it uses the same  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/improve.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/improve.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`

**Suggested fix:** 1. **Reword the Quick line at src/improve.ts:112** so it never calls the sandbox "the repository" or "empty". Keep the ban on tools. For example: "- Work from the text alone: don't use tools or read files. You can't see the author's project from here; the agents will work in it later. Don't describe the project or its contents, and don't ask which codebase or language to use — leave project details to the agents." The model then has no false statement to repeat, and it also stops asking the "which codebase" question that came up in all 3 of my runs.
2. **Optionally reword the summary at src/improve.ts:153** from "Context: text only; empty private repository." to something like "Context: your text only; the repository wasn't read." If you change it, update the exact-string assertions at test/improve.test.ts:84 and test/server-reliability.test.ts:519.
3. **Don't add output filtering.** Post-filtering the model's answer for phrases like "repository is empty" would be brittle. The prompt w …

**Suggested regression test:** Extend the test "the instructions keep the author's intent, say how to work, and end with the task itself" in test/improve.test.ts (around lines 57-64):
- On the quick output, add `assert.doesNotMatch(quick, /repository is empty|empty (private )?(Git )?repository/i)`.
- Add a positive assertion for the new wording, e.g. `assert.match(quick, /can't see the author's project/)`, so a future edit can't bring back the "empty repository" phrase.
- If the summary text changes, update the exact summary  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh real-mode QA server with a new home (`qa-server.sh start v4633e 4633 real`, Claude Code 2.1.310) and drove it with a new browser profile using the script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4633e/r1.mjs (log in r1.log next to it).

Steps:
1. In Settings > Agents > Prompt improvement, I set the agent to Claude Code and the mode to Quick. The saved settings were `{"agent":"claude","defaultMode":"quick","providers":{}}`, so the model was the default Haiku.
2. I opened the composer for the registered MQTT-MCP project (repo /Users/mx/Documents/Work/industriAgents/Connect-MCPs/MQTT-MCP).
3. I typed the reporter's exact text and clicked Improve. I did this 3 times, pressing Undo after each.

Results (each call took about 10-12 s):
- Attempt 2 of 3 returned an Open questions list containing: "Which MQTT server codebase and language does this apply to? The repository is empty here."
- The screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4633e/003-improve-2.png shows this text in the Task box. Directly below it the composer shows "Repository MQTT-MCP · main".
- Attempts 1 and 3 asked which codebase to use but did not say the repository is empty.
- Counting the reporter's run, it happened 2 times in 4 Haiku calls.
- Request bodies were mode=quick, execution=local, empty context. No console errors or 5xx responses. Undo restored the original text each time. The MQTT-MCP working tree stayed clean, no runs were created, and the server is stopped.

Ways I tried to refute it, none of which hold:
- **By design?** No. docs/getting-started.md:84 says Quick "works from your text alone", and nothing documents telling the user their repo is empty. docs/security.md:35 describes the empty private Git directory as a sandbox, not as something the model should report.
- **Tester's script or environment?** No. I reproduced it from a fresh home and profile on the registered project (not the reporter's scratch clone), using the UI.

</details>

### t02-22 · minor · Improve does not receive the acceptance criteria, so rewrites add their own 'Done when' lines next to the criteria appended at start

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-13, CMP-21.

**Repro**

> 1. Run options > Acceptance criteria: 'Criterion one'.
> 2. Type a task and click Improve. Inspect the /api/improve-prompt request body.
> 3. Start the run and read the run task.

**Expected:** Improve sees the criteria (as context), so it doesn't invent or duplicate completion criteria.

**Actual:** The request has no criteria. The rewrite adds 'Done when: …' (fake) or 'Done when the new test passes…' (real), and the run task then also gets 'Acceptance criteria: 1. …', which can overlap or conflict.

**Root cause (verifier):** Acceptance criteria never reach the Improve agent, at any layer:
- ui/composer.tsx:634-640: the useImprove() request body sends text, repo, mode, execution, settings, context and source, but not acceptanceCriteria.value. Criteria are used only in the staleness snapshot at ui/composer.tsx:590.
- src/server.ts:695-703: improveTask() builds the ImproveRequest without any criteria field, so the server would drop them even if the UI sent them.
- src/improve.ts:20-29: ImproveRequest has no criteria field.
- src/improve.ts:100-120: improveInstructions() tells the model to state "how to tell it's done (behavior to see, tests or checks that should pass)" (line 106) and to list "Open questions:". It adds the `source` and context lines (117-118) but has nothing about criteria.

As a result the model writes its own completion criteria and open questions without knowing what the user already specified. ui/composer.tsx:200 (taskWithCriteria, ui/composer-tools.ts:134) then appends "Acceptance criteria: 1. …" when the run starts, so the final task can repeat or contradict itself.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/improve.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/improve.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/improve.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/fake-work.mjs`

**Suggested fix:** Pass the criteria to Improve as read-only context, the same way `source` is passed:
1. ui/composer.tsx useImprove: add `criteria: acceptanceCriteria.value.map(c => c.trim()).filter(Boolean)` to the /api/improve-prompt body.
2. src/server.ts improveTask: sanitise `body.criteria`. Keep only strings, trim them, drop empty ones, and cap them at the composer's existing limits (100 lines, 2,000 characters each). Put the result on the ImproveRequest.
3. src/improve.ts: add `criteria?: string[]` to ImproveRequest. In improveInstructions, when criteria are present, add a data block such as: "The author already wrote these acceptance criteria. They are appended to the task separately; don't repeat, restate or contradict them, and don't ask open questions they already answer:" followed by the numbered list. Change the "how to tell it's done" bullet to apply only when no criteria are given.
4. Update docs/api.md:27 to list `criteria`.

The staleness snapshot already covers criteria edits, so no UI …

**Suggested regression test:** Unit test in test/improve.test.ts: assert that improveInstructions({ text, repo, mode: "quick", criteria: ["Exit code is 0"] }) contains "Exit code is 0" plus the don't-repeat or contradict wording, and that a request without criteria still contains the "how to tell it's done" instruction.

E2E test in test/e2e/improve.e2e.ts:139, "Improve and Undo preserve criteria…": update the deepEqual on postDataJSON() to expect `criteria: ["Keep keyboard navigation working"]`. Also add a server-side check  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh QA server, v4635 on port 4635. The previous v4635 home was moved aside to homes/v4635-prev-*. I made a scratch clone of MQTT-MCP (clones/v4635-mqtt) and opened it through "Open another repository" > Create project.

(1) Fake mode, script work/v4635/r2.mjs:
- Set Run options > Acceptance criteria to "Criterion one" and typed the task "Add a --version flag to the CLI", then clicked Improve.
- The POST /api/improve-prompt body had only the keys text, repo, mode, execution, settings and context. The criteria were not in it.
- The rewrite was "Goal: Add a --version flag to the CLI\n\nDone when: the tests pass."
- I clicked Send. The POST /api/runs task, and the stored run task for run 2610251916-2c9a5129, were both "Goal: Add a --version flag to the CLI\n\nDone when: the tests pass.\n\nAcceptance criteria:\n1. Criterion one". That is two separate completion statements.
- Caveat: in fake mode this duplication is partly an artifact. test/fake-work.mjs:73 always appends "Done when: the tests pass." whatever the input.

(2) To rule that out, I ran one real Quick Improve (Auto → Claude Haiku), script work/v4635/r3.mjs:
- Criteria: "Running the CLI with --version prints only the version string from pyproject.toml" and "Exit code is 0". Task: "add a --version flag to the mqtt cli".
- The request again had no criteria.
- The real rewrite was: "Add a `--version` flag to the mqtt CLI. Running the CLI with `--version` should print its version and exit.\n\nOpen questions:\n- Where should the version string come from, such as the package metadata?\n- What exact output format is expected, for example `1.2.3` or `mqtt 1.2.3`?"
- So the rewrite added its own completion behaviour, and it raised two open questions that the user's criteria already answer (pyproject.toml; version string only). At start, taskWithCriteria appends the criteria to this text, so the agents get questions that the criteria already settle.

No console errors or 5xx responses in either script.

Checked for a by-design explanation and found none:
- docs/api.md:27 lists the Improve fields (no criteria) but gives no reason for leaving them out.
- docs/getting-started.md:81 says Improve adds "how to tell it's done" and open questions.
- The e2e test (test/e2e/improve.e2e.ts:139) pins the current request body. It only checks that criteria are kept separately and survive Undo, not that Improve should be blind to them.
- Improve already passes `source` with "The agents get its text separately; d …

</details>
