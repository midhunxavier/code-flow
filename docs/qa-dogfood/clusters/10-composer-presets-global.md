# Cluster 10 · composer-presets-global

**Templates/workflows/project defaults clobber global Agents & models settings**

Status: **independently verified · no additional product repair needed · integrated into `codex/dogfood-qa-continue`** · 6 issues · verification branch `codex/qa-composer-verify`

Planner notes: applyPreset in ui/onboarding.tsx (72-91) wipes agentSettings globally (t03-2). applyDefaults in ui/state.ts (305-316, called from switchComposer) overwrites the global Settings > Agents & models with a project's remembered team (t03-3). Apply both to the draft only, not to the persisted global store. t03-15: projects with a remembered team ignore 'Default workflow', and nothing says so; show it. t03-11/S02-2: the Template library help says it restores trust, limits and approvals; change the copy to what applyPreset actually restores. t02-14: 'Save task preset' in Advanced is enabled for a restored verification profile, although the Run actions entry disables it. Duplicate groups: [["t03-11","S02-2"]]

Likely files: `ui/onboarding.tsx`, `ui/state.ts`, `ui/settings.tsx`, `ui/composer.tsx`

## Fix result

Commits:
- `a2d354a` Keep Settings defaults when templates or project defaults fill a draft
- `20abdcb` Describe what applying a template restores
- `8bdb946` Guard both template save entries against a restored verification profile
- `b45a213` Cover template, project-default and save-guard behaviour in the browser

Fixer notes for the integrator: Behaviour changes to know about when merging:

1. Settings no longer reads the draft:
   - Settings > Agents & models now reads `providerDefaults` (store key "agentSettings").
   - Settings > Run defaults > Default workflow now reads `defaultPattern` (store key "pattern").
   - Neither reads the current draft's `agentSettings` or `patternId` any more.

2. `setAgentSetting()` is now draft-only and does not persist.
   - New `setProviderDefault()` persists a single provider's patch and mirrors it into the draft.
   - Callers I did not edit (team-template-library-view.tsx, sweeps.tsx) therefore stop writing template models into the Settings defaults. This is intended (same bug class).
   - I switched the side-chat model picker (ui/side-chat.tsx) to `setProviderDefault`, so it keeps its old behaviour of saving the provider default. If you would rather side-chat picks be per-draft too, change that one call back to `setAgentSetting`.

3. `setRoles()` and `setRoleModel()` now merge only the changed role/agent into the stored "roleSel"/"roleModels" maps instead of writing the whole draft map. This stops a project's remembered team leaking into the saved choices. ui-review.test.ts's roleSel assertion still holds.

4. Applying a template or saved workflow still persists pattern and roles through setPattern/setRoles. These are the composer's remembered choices, same as Edit & run again; only the models are now draft-only.

5. Pre-existing and not changed: a project's saved draft snapsho …

## Independent continuation verification — 2026-10-26

Reviewed the preset/global-default separation, template help and both save-entry guards from the integrated `cd2c7bd` source. Replayed the existing browser suite on a fresh isolated build and added a full reload after applying a template to check persistence. No product defect was found in this cluster. The neighboring context-only retry replacement repair is recorded in cluster 09.

| Issue | Independent outcome |
| --- | --- |
| t03-2 | Pass. Empty/default and explicit-medium templates affect the draft while global Claude high/Codex low remain saved. Settings still shows those defaults after navigation and reload. Applying a saved workflow also preserves them. |
| t03-3 | Pass. A fresh browser opens the project's remembered pipeline/team/models without writing its global workflow, role selection or provider defaults. A plain project still starts from global choices. |
| t03-15 | Pass. Settings displays its saved default workflow and identifies the project that uses its remembered team instead. Project-default provenance does not leak to a plain project. |
| t03-11, S02-2 | Pass. Template help accurately describes retained permissions, approval policy, limits and isolation. Applying an explicitly saved single-check verification clears a previously selected profile. Permissions and Docker state stay unchanged. |
| t02-14 | Pass. Menu and Advanced save entries both disable saving a restored verification profile with the same explanation. Choosing a concrete preset enables saving and persists that profile. |

Evidence under `/private/tmp/codeflow-qa-continue/work/composer-verify/`: `presets-browser.log` records the original **3/3** replay; `presets-browser-final.log` records **3/3 passing** expanded scenarios, including reload persistence and retained draft budget. `composer-tests-final.log` records **21/21** related tests, including both focused preset cases; `npx tsc --noEmit` passed. `presets-global-server.log` captures server output. Browser page/console/5xx monitoring and server exception checks are enforced by the suite.

All checks used fake agents, scratch Git repositories, fresh browser contexts, separate temporary server homes/tokens and isolated 4357/4358 listeners. No live server, real provider, real project or `~/.codeflow` was used. The browser fixtures seed saved templates for deterministic application tests; template saving itself is exercised through the restored-profile guard scenario. This is evidence for the listed composer behaviors, not a claim that every template/import workflow was retested.

## Issues

### t03-2 · major · Applying a template or saved workflow erases the global model/effort choices in Settings > Agents & models

**Fix outcome: fixed.** Root cause: the one `agentSettings` signal and store key held both the draft's models and the Settings > Agents & models defaults. applyPreset wiped both and wrote them back through setAgentSetting, which persisted the whole draft map. ui/state.ts: added a `providerDefaults` signal, which is now the only owner of store key "agentSettings", and `setProviderDefault()`, which saves one provider's patch and mirrors it into the current draft. `agentSettings` is now the draft only and starts as a clone of providerDefaults. `setAgentSetting()` is now draft-only and no longer persists, so team templates (team-template-library-view) and sweeps also stop clobbering the defaults. Fresh drafts in switchComposer start from providerDefaults. ui/onboarding.tsx applyPreset: draft = {...providerDefaults, ...config.agentSettings}; roleSettings are applied in memory, as Edit & run again does; the store.set …

Fixer's check: Fresh fake QA server f10 (port 4395, built from the worktree) with scratch-repo projects, driven through the UI exactly as the tester did (work/f10/t032.mjs, log t032.log). Saved 'F10 plain template' (agentSettings {}) and 'F10 medium template' ({claude:{effort:medium}}). Set Settings Claude=high and Codex=low, then used each template via Run actions > Use template…. After each apply, localStorage agentSettings stayed {claude:high, codex:low} and Settings > Agents & models still showed high/low, including after a reload. Run details for the medium template showed 'agent · claude · medium · Template F10 medium template', so the template still applies to the draft. A fresh draft in another pro …

Tests: `test/qa-composer-presets-global.test.ts`, `test/e2e/qa-composer-presets-global.e2e.ts`

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-35, CMP-37.

**Repro**

> 1. Fake QA server, any project. Save a template from the composer (… > Save as template…).
> 2. Settings > Agents & models: set Claude Code effort = high and Codex effort = low (localStorage agentSettings = {"claude":{"effort":"high"},"codex":{"effort":"low"}}).
> 3. New run > … > Use template… > pick the saved template > Use template.
> 4. Go back to Settings > Agents & models.

**Expected:** The template's models apply to this draft or per-role settings. The user's saved provider defaults are left alone.

**Actual:** Both efforts show 'Default'; localStorage agentSettings is '{}'. The global choices for all projects are silently lost. Reproduced twice (s23: claude medium -> {}, s24: claude high + codex low -> {}). Settings > Projects > Template library 'Apply workflow' calls the same function (code reading).

**Root cause (verifier):** ui/onboarding.tsx:72-91, applyPreset():
- Lines 78-79 run `agentSettings.value = {}; store.set("agentSettings", "{}");`, which wipes the persisted global provider defaults.
- Line 82 calls setAgentSetting() for each entry in config.agentSettings. setAgentSetting (ui/state.ts:738-741) writes to the same global key: `store.set("agentSettings", JSON.stringify(agentSettings.value))`.
- Lines 80-81 also wipe and persist `roleModels` for the pattern.

The `agentSettings` signal (ui/state.ts:646, read from store key "agentSettings") is a single value that does two jobs: it holds the draft's model choices, and it is the Settings > Agents & models defaults. ModelRow in ui/settings.tsx:121 has no onChange, so it reads `agentSettings.value` and writes through setAgentSetting (ui/composer.tsx:1208-1209). Applying a template therefore changes the global defaults.

The template's "models" are themselves just a snapshot of that global value taken at save time: currentConfig() at ui/onboarding.tsx:68-70 stores `agentSettings: agentSettings.value`. A template saved before the user picked any defaults stores {}, and applying it erases the defaults.

Callers that reach this path:
- New run > Use temp …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Keep the global provider defaults separate from the draft's model choices.

1. In ui/state.ts, add a `providerDefaults` signal that is the only owner of store key "agentSettings", with `setProviderDefault()`. Settings > Agents & models (ui/settings.tsx:121) should read and write it by passing settings and onChange to ModelRow.
2. Make the draft's `agentSettings` an in-memory, per-draft overlay. The per-project draft snapshot already carries it (composerSnapshot().settings). A fresh draft starts from providerDefaults.
3. In applyPreset (ui/onboarding.tsx:78-82), replace the store.set / setAgentSetting calls with an in-memory assignment, for example `agentSettings.value = { ...providerDefaults.value, ...structuredClone(config.agentSettings) }`. Apply roleSettings to the draft without persisting them globally, as Edit & run again already does at ui/run.tsx:2296.
4. Make the same in-memory change in applyDefaults (ui/state.ts:311-314).
5. Optionally, have currentConfig() record only model  …

**Suggested regression test:** In test/e2e/ui.e2e.ts, next to the existing Use template tests (around lines 1267-1320), add a test that:
- Uses addInitScript to seed localStorage "agentSettings" = {"claude":{"effort":"high"},"codex":{"effort":"low"}} and a personal "composerLibrary" holding one template whose config.agentSettings is {} and a second whose config.agentSettings is {"claude":{"effort":"medium"}}.
- Applies each template through Run actions > Use template… > Use template.
- After each apply, asserts that `JSON.par …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server with `qa-server.sh start v4637 4637 fake` (new home, no runs). I drove it with fresh Playwright profiles through the UI only, on project MQTT-MCP (p-ef01794b). Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4637/ (r1.mjs/r1.log, r2.mjs/r2.log).

Run 1 (r1, the reporter's steps):
- A fresh profile had localStorage agentSettings = null.
- New run: typed the task "Review {{component}} for typos", then Run actions > Save as template… into the Personal library. The template's config.agentSettings was {}.
- In Settings > Agents & models I set Claude Code effort = high and Codex effort = low. The store held {"claude":{"effort":"high"},"codex":{"effort":"low"}} and kept it after a reload.
- New run > Run actions > Use template… > Personal > the template, filled component=README, then Use template. The dialog says "Restores task, workflow, agents, models, checks and permissions (standard)".
- Right after applying, localStorage agentSettings was "{}". Settings > Agents & models showed both efforts as Default ("" values), and they were still Default after a page reload.

Run 2 (r2, a template that does carry models):
- With global Claude effort = medium, I saved a template; its config.agentSettings was {"claude":{"effort":"medium"}}.
- I then changed the global settings to Claude high and Codex low, and applied the template in the MQTT-MCP draft.
- Settings > Agents & models then showed Claude = medium and Codex = Default. The store was {"claude":{"effort":"medium"}}, so the user's Codex choice was gone.
- A fresh draft in a different project (IndustriStudio) also read {"claude":{"effort":"medium"}}. The change reaches every project.

No console errors or 5xx responses. Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4637/001-settings-providers-after-template.png and 002-settings-after-template.png.

Attempts to refute:
- Not caused by the tester's script: I reproduced it from a fresh server and fresh browser profile, using only UI controls.
- Not by design. The Settings page says "Saved model choices apply to new runs in this workspace. Project defaults and individual role overrides can take precedence." docs/getting-started.md#models-and-effort describes them as provider defaults. test/e2e/ui.e2e.ts:1163 asserts "run model choices do not chan …

</details>

### t03-3 · major · Opening a project's new-run draft for the first time resets the global Settings > Agents & models choices to that project's remembered team

**Fix outcome: fixed.** ui/state.ts applyDefaults() now changes only the draft signals. It sets patternId directly instead of calling setPattern, which persisted 'pattern'. It drops the three store.set calls for roleSel, roleModels and agentSettings. Remembered models are layered over providerDefaults instead of replacing them, and each 'Project defaults' origin is set only for what was actually applied. setRoles and setRoleModel now remember only the role or agent that changed, not the whole draft map. Before, touching one role in a project's draft leaked the project's whole remembered team into the saved choices. Settings > Run defaults now reads a new `defaultPattern` signal (the saved workflow, also updated by setPattern), not the current draft's patternId. That way a loaded project draft doesn't show its remembered workflow as the default.

Fixer's check: On f10 (work/f10/t033a.mjs): profile A set Claude effort=low, picked Plan → Build → Review in project F10 alpha and started a run from the composer. Project defaults then were {pattern: pipeline, team, agentSettings: {claude: low}}. Fresh profile B (t033b.mjs, log t033b.log): set Settings Claude=high, then opened #/project/alpha/new for the first time. The draft showed pipeline with Workflow, Team and planner·claude 'low' all sourced from 'Project defaults'. Back in Settings, Claude effort was still 'high', Default workflow was still 'solo', and localStorage was agentSettings {claude:high} with pattern, roleSel and roleModels all null. Project F10 beta then opened with solo and claude high ( …

Tests: `test/qa-composer-presets-global.test.ts`, `test/e2e/qa-composer-presets-global.e2e.ts`

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-38.

**Repro**

> 1. Fake QA server. Start any run from the composer in project P (the server remembers P's team in projects.json defaults).
> 2. In a different, fresh browser profile: Settings > Agents & models > Claude Code effort = high.
> 3. Open #/project/<P>/new (first visit to P in this browser).
> 4. Go back to Settings > Agents & models.

**Expected:** The project's remembered team prefills this draft only. The workspace-wide model choices stay as saved.

**Actual:** Claude Code effort shows 'Default' and localStorage agentSettings becomes {} (or whatever agentSettings P remembered). Reproduced for 't03 Connect2' and 't03 Gates'. The global setting changes depending on which project was opened last, while Settings says 'Saved model choices apply to new runs in this workspace.'

**Root cause (verifier):** The cause is in ui/state.ts, in applyDefaults() (lines 305-316). switchComposer() calls it at line 1288 whenever the project being opened has no saved draft in this browser. It is meant to prefill only that project's draft, but it also writes the project's remembered team into the workspace-wide browser preferences:
- line 310: setPattern(d.pattern). setPattern (lines 727-731) persists store.set("pattern", id), so Settings > Run defaults > Default workflow changes.
- line 311: agentSettings.value = d.agentSettings ?? {}.
- lines 312-314: store.set("roleSel" / "roleModels" / "agentSettings", …). These overwrite the keys that Settings > Agents & models and Run defaults read. They are also the keys every later fresh draft starts from (line 1285: agentSettings.value = store.json("agentSettings", {}); line 1284 does the same for roleSel/roleModels; pattern likewise).
Settings > Agents & models shows these values through ModelRow, which defaults to agentSettings.value[agent.id] (ui/composer.tsx:1208; rendered from ui/settings.tsx:121).
The reporter's second suspect, src/server.ts:2436 projects.remember(), is not a defect. Storing the started run's agentSettings as the project's remembere …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-drafts.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** 1. Minimal fix, verified in my snapshot copy. In ui/state.ts applyDefaults(), only set the draft signals:
   - Delete the three store.set("roleSel" / "roleModels" / "agentSettings") calls.
   - Replace setPattern(d.pattern) with a draft-only assignment: `selectedTeamTemplate.value = null; patternId.value = d.pattern;`. setPattern persists the global "pattern" key, so it must not be called here.
   - Keep the composerOrigins "Project defaults" labels.
   The draft snapshot (ProjectDraftStore) already keeps these values per project, so nothing else is needed to remember them for P.
2. Recommended follow-up so Settings truly shows workspace choices:
   - Give Settings > Agents & models and Run defaults > Default workflow their own saved-preference source, e.g. `savedAgentSettings = signal(store.json("agentSettings", {}))` and the stored "pattern" value, instead of the current draft's signals.
   - Settings ModelRow should pass settings={savedAgentSettings.value[agent.id]} and an onChange  …

**Suggested regression test:** Unit test: add a case to test/project-drafts.test.ts, or a new file modelled on it. I wrote and ran this as builds/v4639/test/v4639-project-defaults.test.ts.
- Setup: fake localStorage with pattern="solo" and agentSettings={claude:{effort:"high"}}; state.patterns.value = [solo, pipeline]; project p with defaults {pattern:"pipeline", teams:{pipeline:{roles:{…}}}, agentSettings:{claude:{effort:"low"}}}; project q with no defaults. Then await state.initializeProjectDrafts() and await state.openComp …

<details><summary>Verifier's independent reproduction</summary>

I started my own fresh fake QA server v4639 on port 4639 and used tiny scratch git repos under qa/clones, so no user repo was touched.
1. Fresh browser profile v4639-a (script work/v4639/a.mjs):
   - Created project "v4639 Scratch" for the scratch repo.
   - In Settings > Agents & models, set Claude Code effort = low.
   - In #/project/<P>/new, picked the Plan → Build → Review workflow and started a run from the composer (remember:true).
   - The server then stored P.defaults = {pattern:"pipeline", teams:{pipeline:{roles:{planner:[claude],builder:[codex],reviewer:[codex]}}}, agentSettings:{claude:{effort:"low"}}}.
2. Two separate fresh profiles, v4639-b and v4639-c (script work/v4639/b.mjs; logs b.log and c.log). Each did the following:
   - Set Settings > Agents & models > Claude Code effort = high. Result: Settings showed "high", Run defaults > Default workflow showed "solo", and localStorage agentSettings was {"claude":{"effort":"high"}} with no pattern or roleSel key.
   - Opened #/project/<P>/new once, the first visit to P in that browser.
   - Went back to Settings. Claude Code effort now showed "low". Default workflow showed "pipeline". localStorage agentSettings was {"claude":{"effort":"low"}}, pattern was "pipeline", and roleSel held P's team.
   - Extra step: opened a second project, "v4639 Other", which has no remembered team. Its fresh draft started with workflow "pipeline", i.e. P's choices, not the saved workspace "solo". Settings still showed "low".
   - Screenshot: shots/v4639/001-c-settings-claude-effort-after.png shows the Claude Code effort select at "low". No console errors and no 5xx responses.
This matches the reporter's outcome. The reporter saw {} because their project's remembered agentSettings were empty; my project remembered {claude: low}, so Settings showed low.
3. Unit check in my snapshot copy (builds/v4639/test/v4639-project-defaults.test.ts):
   - On current code the draft prefill assertions pass, then the test fails at "Settings > Agents & models keeps the saved effort" (actual low, expected high).
   - With the candidate fix described below, it passes, and the existing test/project-drafts.test.ts still passes (2/2).
Why this is not by design:
- Settings says "Saved model choices apply to new runs in this workspace. Project defaults … can take precedence", and docs/configuration.md:11 says project defaults "can override" model preferences. Both describe a project draft overriding the preference, not rewriting it.
- docs/ru …

</details>

### t03-15 · major · Settings > Run defaults 'Default workflow' doesn't apply to projects with a remembered team, and nothing says so

**Fix outcome: fixed.** Projects that remember a team keep starting from it (documented in docs/runs.md:78), and Settings now says so. The leak that made the Settings default itself change is fixed by the t03-3 change. ui/settings.tsx RunSettings:
- 'Default workflow' reads defaultPattern.
- Its description now reads 'The team pattern a new task starts with, in projects that don't remember a team of their own.'
- A help line (aria-describedby on the select) names each project that starts from its own remembered workflow, with that workflow's name (first 5, then 'and N more').
- 'Approve before building' follows the saved default workflow.
ui/state.ts switchComposer: a fresh draft resets composerOrigins to the browser origins before applyDefaults, so another project's 'Project defaults' label no longer carries over. docs/configuration.md (Run defaults bullet) is updated to match.

Fixer's check: On f10 (work/f10/t0315.mjs, log t0315.log), fresh profile C: Settings Default workflow = Fix & review and Claude effort = max, then opened alpha (which remembers pipeline). Alpha's draft showed pipeline from 'Project defaults' (documented behaviour). Settings > Run defaults still showed fix-review, localStorage pattern stayed fix-review, and the new note read 'A project remembers the workflow and team of the last run started from its composer, and its new drafts start from that instead: F10 alpha (Plan → Build → Review).' F10 beta then opened with Fix & review, labelled 'Browser preference', not 'Project defaults'. Screenshots shots/f10/001-settings-runs.png (desktop) and 002-settings-runs-p …

Tests: `test/qa-composer-presets-global.test.ts`, `test/e2e/qa-composer-presets-global.e2e.ts`

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-40.

**Repro**

> 1. Start any run in project P (P remembers its workflow, e.g. Fix & review).
> 2. Settings > Run defaults > Default workflow = Plan → Build → Review.
> 3. In a browser that has no draft for P, open P's New run.

**Expected:** Either the Settings default applies, or Settings explains that projects remember their last team.

**Actual:** P opens with Fix & review ('Project defaults'). The Settings description 'The team pattern used for a new task' isn't true for any project that has had a run.

**Root cause (verifier):** The part the reporter flagged is by design. docs/runs.md:78 says switching projects moves the composer "to the pattern and team you last started a run with there ... Each project remembers its own". The bug is that applying those project defaults writes into the browser-wide keys that Settings edits:
- ui/state.ts:310 `applyDefaults` calls `setPattern(d.pattern)`, and setPattern (ui/state.ts:727-731) does `store.set("pattern", id)` at line 730. That is the same key Settings > Run defaults "Default workflow" reads and writes (ui/settings.tsx:137) and the fallback switchComposer uses for projects with no draft (ui/state.ts:1284 `patternId.value = store.get("pattern") ?? "solo"`).
- ui/state.ts:311 `agentSettings.value = d.agentSettings ?? {}` replaces the Settings > Agents & models choices instead of layering on top of them. ui/state.ts:312-314 then persist roleSel, roleModels and agentSettings from the project into the browser-wide store keys.
- ui/state.ts:315 sets composerOrigins to "Project defaults". The no-draft branch of switchComposer (ui/state.ts:1279-1288) never resets composerOrigins, so a project without defaults keeps the stale label (and a leaked value from step 3 is la …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/configuration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** 1. Make `applyDefaults` (ui/state.ts:305-316) change only the in-memory draft signals and stop writing browser-wide store keys. The per-project draft (composerSnapshot at ui/state.ts:1200-1203 holds pattern, roles, models, settings and origins) already keeps them per project.
   - Set `selectedTeamTemplate.value = null; patternId.value = d.pattern` directly instead of calling setPattern.
   - Drop the three `store.set` calls for roleSel, roleModels and agentSettings.
   - Merge models instead of replacing them: `agentSettings.value = { ...store.json("agentSettings", {}), ...(d.agentSettings ?? {}) }`, so a project with no remembered models keeps the Settings choices.
2. In the no-saved-draft branch of switchComposer (ui/state.ts:1279-1288), reset `composerOrigins.value = {}` (or a "Run defaults (this browser)" label) before the optional applyDefaults, so the "Project defaults" label appears only when the project's defaults were actually applied.
3. Fix the copy:
   - ui/settings.tsx:13 …

**Suggested regression test:** Add a case to test/e2e/ui.e2e.ts (fake agents):
1. Create two projects A and B. Give A remembered defaults by starting a fix-review run in it through the composer.
2. In a fresh page, set Settings > Run defaults > Default workflow = pipeline and set a Claude effort in Settings > Agents & models.
3. Open A's New run. Assert `#workflow-select` is fix-review with Run details source "Project defaults" (the documented behaviour).
4. Then assert:
   - `localStorage.getItem("pattern") === "pipeline"` a …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4663 (port 4663, fresh home). Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4663/ (s1, s2, s3 .mjs and .log).

1. s1, browser profile A: MQTT-MCP had no project defaults. Opened its New run, chose Fix & review in the composer, set the check to `true`, started a fake run. /api/projects then showed MQTT-MCP defaults = {pattern: "fix-review", teams: {fix-review: {builder: codex, reviewer: claude}}}.
2. s2, new empty profile B: Settings > Run defaults > Default workflow = Plan → Build → Review (localStorage pattern = "pipeline"). Opened MQTT-MCP New run: workflow fix-review, Run details source "Project defaults". This part is what the reporter saw, and it matches the documented per-project memory.
3. In the same profile the effect went further:
   - localStorage `pattern` had been rewritten to "fix-review".
   - IndustriStudio (no project defaults) then opened with Fix & review and team "builder: codex · reviewer: claude", both labelled "Project defaults" (screenshot shots/v4663/003-b-studio-new-run.png).
   - Settings > Run defaults now showed Fix & review.
4. s3, new empty profile C (control):
   - Settings set to workflow = pipeline and Claude Code effort = max (localStorage agentSettings = {claude: {effort: max}}).
   - IndustriStudio opened before visiting P: pipeline, source "This run (remembered)". The Settings default works here.
   - MQTT-MCP: fix-review, "Project defaults".
   - After that, localStorage was pattern = fix-review, agentSettings = "{}", and roleSel = the fix-review team.
   - IndustriConnect (never visited, no project defaults): fix-review, source "Project defaults".
   - Settings > Run defaults showed fix-review. Settings > Agents & models showed Claude Code effort back at Default ("").

No console errors or 5xx responses. Simply opening a project that remembers a team overwrites the browser-wide Settings values for workflow, team and models, and every later project without its own defaults inherits them under a wrong "Project defaults" label.

</details>

### t03-11 · minor · Template library says it restores permissions, but trust, limits, tool approvals and Docker isolation are not applied

**Fix outcome: fixed.** Not restoring trust, limits, tool approvals and Docker isolation is deliberate (PR #45; docs/auto-team.md; simplification.e2e asserts it), so only the misleading text was corrected. ui/onboarding.tsx:
- UseTaskTemplateDialog help no longer prints '…and permissions (<trust>)'. It now reads 'Restores the task, workflow, agents, models and checks. Permissions, approvals, limits and agent isolation stay as set in this draft.' Saved workflows say 'Keeps your task and restores the workflow…'.
- SaveTaskTemplateDialog help drops 'permissions … and run settings' and says using the template keeps the draft's permissions, approvals, limits and agent isolation.
- ComposerLibraryEditor help: replaced 'Teams include permissions … and limits' with what is actually applied. The revision line 'Permissions: X' became 'Saved with X permissions; applying keeps the draft's own.'

Fixer's check: On f10, reran the verifier's script adapted (work/f10/t0311.mjs, log t0311.log). Draft: Full access, 50/20, Lightweight, Docker qa-image:1; saved it, reset to Approve for me, 240/200, Docker off, then used the template. The Save help and the Use help now describe exactly what happened: task and verification were restored, while permissions, limits and Docker stayed. The reverse case (sandboxed template over a Full access draft) is also described correctly. errors [].

Tests: `test/e2e/qa-composer-presets-global.e2e.ts`

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-35.

**Repro**

> 1. Composer: set Permissions = Full access, limits 50 min / 20 steps, Verification = Lightweight, Agent isolation = Docker image 'qa-image:1'. … > Save as template… (personal).
> 2. Reset the composer: Approve for me, 240/200, Docker off.
> 3. … > Use template… > Personal > pick it. The dialog says 'Restores task, workflow, agents, models, checks and permissions (full).' Click Use template.

**Expected:** What the dialog and Save dialog promise ('…permissions, checks and run settings') is restored, or the text says permissions, limits and isolation are kept from the current draft.

**Actual:** Permissions stay 'Approve for me', limits unchanged, Docker unchecked. Only the task, workflow, roles and verification profile are applied.

**Root cause (verifier):** The text in the dialogs was not updated when the restore behaviour was deliberately narrowed in PR #45 (70fde3e). The behaviour itself is intended.

What the code does:
- ui/onboarding.tsx:72-91 applyPreset() applies pattern, roles, options, models, context budget, check/setup/baseRef. Line 84 states it supplies "never run authority, approval bypasses, or extra budget", so trust, limits, approvePlan and toolApprovals are skipped.
- ui/composer.tsx:411 onConfigured applies only template.runOptions.verification. Docker isolation (container enabled/image/authVolume) was dropped in #45.

What the text says:
- ui/onboarding.tsx:233 (UseTaskTemplateDialog help): "Restores task, workflow, agents, models, checks and permissions (${template.config.trust})." It names the template's trust level as if it will be applied.
- ui/onboarding.tsx:271 (SaveTaskTemplateDialog help): "Saves … permissions, checks and run settings". The template does store them, but they are never used on apply.
- ui/onboarding.tsx:135 (ComposerLibraryEditor, rendered in ui/project-run-settings.tsx:18): "Teams include permissions, models, workflow options and limits".
- ui/onboarding.tsx:138: shows "Permissions: <trust>" …

**Files:** `ui/onboarding.tsx`, `ui/composer.tsx`, `test/e2e/simplification.e2e.ts`

**Suggested fix:** Keep the by-design behaviour and correct the text.

1. ui/onboarding.tsx:233: change the dialog help to describe what is actually applied, for example "Restores task, workflow, agents, models, checks and verification gates. Permissions, limits, tool approvals and agent isolation stay as set in this draft." It should not interpolate template.config.trust. Optionally, when the template's saved trust or container differs from the current draft, show a short note such as "Saved with Full access; this run keeps Approve for me."
2. ui/onboarding.tsx:271: change the Save dialog help to "Saves the task, acceptance criteria, workflow, agents, models, checks and verification gates…". Drop "permissions" and "run settings", or say they are not restored.
3. ui/onboarding.tsx:135 and :138: reword "Teams include permissions… and limits" the same way, and drop or relabel the "Permissions: <trust>" revision hint, for example "Saved with: <trust> (not applied)".
4. Optional cleanup to match docs/dynamic …

**Suggested regression test:** Extend the existing "templates keep the run budget" test in test/e2e/simplification.e2e.ts (around lines 82-95).

Before clicking Use template on "saved:complete" (config trust "safe", limits 23/17), assert the dialog's help paragraph does not match /permissions \((safe|standard|trusted|full)\)/ and does match /permissions.*(stay|kept|this draft)/i. After applying, keep the existing budget assertion and add:
- the Permissions button text is unchanged from before applying;
- the "Run agents in a  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4655 on 127.0.0.1:4655, with a fresh headless browser profile. The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4655/r1.mjs and its output is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4655/r1.log.

Case 1, as reported (project MQTT-MCP, Solo):
- Draft settings: task "Review {{component}} for regressions", Permissions = Full access, limits 50 min / 20 steps, Verification = Lightweight, Docker image "qa-image:1".
- Saved with "… > Save as template…" to the personal library. The Save dialog help says: "Saves the task, acceptance criteria, workflow, agents, models, permissions, checks and run settings…".
- localStorage shows the full template was stored: trust full, limits 50/20, runOptions {verification: lightweight, container: {enabled: true, image: qa-image:1}}.
- Reset the draft to Approve for me, 240/200, single check, Docker off.
- "… > Use template…", Personal, "V full docker", component = Broker. The dialog help says: "Restores task, workflow, agents, models, checks and permissions (full). Review the settings before choosing Start run."
- After Use template, the task became "Review Broker for regressions" and Verification became lightweight. Everything else stayed as the current draft: Permissions button "Approve for me", maxMinutes 240, maxSteps 200, Docker unchecked. The Run details table agrees: Permissions standard, Limits 240 minutes · 200 steps, Agent container "Host CLI execution".

Case 2, the reverse direction:
- Saved "V sandboxed" with Approve for me and Docker "qa-sandbox:2", then switched the draft to Full access with Docker off.
- The Use dialog said "…checks and permissions (standard)".
- After applying, the draft stayed Full access with Host CLI execution. The page shows "Full access · no provider sandbox" and the orange Full access banner (screenshot shots/v4655/004-after-use-sandboxed.png).

Screenshots are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4655/ (001–004). The script collected no console or API errors. I created no runs and stopped the server afterwards.

Trying to refute it: not applying trust, limits, tool approvals and Docker is deliberate:
- PR #45 (70fde3e) removed setTrust/setLimits/interactiveApprovals from applyPreset and removed …

</details>

### S02-2 · minor · The Template library help says 'Restores task, workflow, agents, models, checks and permissions (<trust>)', but applyPreset never applies trust, limits, approvePlan or toolApprovals. runOptions.container is never restored, and a template saved with '' verification doesn't reset a currently selected profile.

**Fix outcome: fixed.** The help-text part is fixed by the same change as t03-11. The extra claim is also fixed: a template saved with '' verification ('Single configured check') now restores it over a currently selected profile. In ui/composer.tsx onConfigured, `if (template.runOptions) selectVerification(template.runOptions.verification)` replaces the old truthy-only check. Starter templates and saved workflows carry no runOptions and still leave verification alone. Container isolation is intentionally never restored; the dialogs now say so, consistent with the Advanced help.

Fixer's check: In t0311.mjs case D on f10: saved 'V single check' with Single configured check, switched the draft to lightweight and applied the template. #verification-profile went from 'lightweight' to ''. The e2e checks the same thing, and the help text no longer contains 'permissions (full)'.

Tests: `test/e2e/qa-composer-presets-global.e2e.ts`

Source: code-level suspect at `ui/onboarding.tsx:233` (confirmed hands-on).

**Repro**

> Fake QA server s02, project draft. Choose Permissions > Approve for me. Enable Agent isolation with image qa/s02-image:1, leave Verification gates on 'Single configured check', type a task with {{component}}, then use … > Save as template… 'T1-standard-container'. localStorage shows trust 'standard' and runOptions {verification:'', container:{enabled:true,image:'qa/s02-image:1'}}. Now switch Permissions to Full access, untick isolation and set Verification gates to 'Lightweight profile'. Open … > Use template…, choose T1 and fill component. The help reads 'Restores task, workflow, agents, models, checks and permissions (standard).' Click Use template. Afterwards the composer is still on Full access (localStorage trust 'full'), isolation is still off, and verification is still 'lightweight' (work/s02/s2-template.mjs, shots/s02/001-s2-use-template.png and 002-s2-after-apply.png).

**Expected:** The dialog text describes what applying actually does. If permissions intentionally stay as they are (applyPreset comment: 'never run authority, approval bypasses, or extra budget'), the text should say so rather than promise '(standard)'. A template's saved verification should restore consistently, including '' meaning 'Single configured check'.

**Actual:** The help promises that permissions are restored, but Full access stays in force. The container settings stored with the template are never used. A template with '' verification leaves whatever profile is currently selected.

**Root cause (verifier):** applyPreset (onboarding.tsx:72-91) deliberately skips trust, limits, approvePlan and toolApprovals, but UseTaskTemplateDialog's help text (line 233) was never updated to match. Composer onConfigured (composer.tsx:411) applies only a truthy runOptions.verification and ignores runOptions.container. SaveTaskTemplateDialog still says it 'Saves … permissions … and run settings'.

**Suggested fix:** Change the help to something like 'Restores task, workflow, agents, models and checks. Permissions, approvals, limits and isolation keep their current values (template saved with <trust>).' Apply runOptions.verification whenever runOptions is present, including '' (selectVerification(template.runOptions.verification ?? '')). Then either drop container from saved runOptions or document that isolation is never restored, matching the Advanced help 'Applying a preset keeps this run's permissions and isolation'.

**Suggested regression test:** Browser test: save a template under Approve for me, switch to Full access, then open Use template and assert the help does not claim permissions are restored. After applying, assert the trigger still reads 'Full access' (documented) and the help text matches. Second case: a template with '' verification applied over 'lightweight' resets #verification-profile to ''.

### t02-14 · minor · Advanced 'Save task preset' is enabled for a restored verification profile and fails with 'Invalid template execution settings.'

**Fix outcome: fixed.** ui/composer.tsx has one shared guard: `templateBlocked` ('Choose a verification preset before saving a template' when verificationPreset === 'restored') and `canSaveTemplate` (project chosen, projectsLoaded, task non-empty, not blocked). The Run actions 'Save as template…' item and the Advanced 'Save task preset' button both use it. Before, the button skipped both the restored check and the projectsLoaded check. The button gets aria-describedby pointing to a visible help line with the reason. SaveTaskTemplateDialog is never rendered while the guard blocks, so 'restored' can no longer reach the validator's generic 'Invalid template execution settings.'

Fixer's check: On f10 (work/f10/t0214.mjs, log t0214.log), the tester's flow: Plan → Build → Review with Lightweight verification, run finished, then More run actions > Edit & run again. #verification-profile showed 'restored'. The menu item was disabled with the subtitle shown. 'Save task preset' was disabled and described by the help line 'Choose a verification preset before saving a template.' (screenshot shots/f10/001-restored-advanced-guard.png); a forced click opened no dialog. After choosing Lightweight, both entries were enabled and saving stored runOptions.verification 'lightweight'. errors [].

Tests: `test/e2e/qa-composer-presets-global.e2e.ts`

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-18.

**Repro**

> 1. Start a non-Agent run (e.g. Plan → Build → Review) with Verification gates = Lightweight and let it finish.
> 2. More run actions > Edit & run again. Verification shows 'From original run · lightweight'.
> 3. Run actions (…) > 'Save as template…' is disabled with 'Choose a verification preset before saving a template'.
> 4. Open Run options > Advanced and click 'Save task preset', name it, then Save template.

**Expected:** The same guard as the menu applies (disabled with the explanation).

**Actual:** The dialog opens and Save shows the cryptic 'Invalid template execution settings.'

**Root cause (verifier):** The two entry points to the same SaveTaskTemplateDialog guard differently.
- ui/composer.tsx:333 (Run actions menu "Save as template…") is disabled when `verificationPreset === "restored"` and shows the subtitle "Choose a verification preset before saving a template".
- ui/composer.tsx:395 (Advanced "Save task preset" button) is disabled only on `!p || !task.value.trim()`. It does not check `verificationPreset === "restored"` and also skips the `projectsLoaded.value` check.

ui/composer.tsx:412 then casts the state into the dialog with `verification: verificationPreset as "" | "lightweight" | "standard" | "thorough"`, so the string "restored" gets through the type cast. On save, ui/onboarding.tsx:258 calls parseComposerLibrary. At ui/composer-tools.ts:125, runOptions.verification is checked against ["", "lightweight", "standard", "thorough"]; "restored" fails, and the function returns the generic fail("Invalid template execution settings."). That message is shown verbatim in the dialog. The dialog does not check this before the user fills it in.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/simplification.e2e.ts`

**Suggested fix:** Put one "can save template" predicate in Composer and use it for both entry points. For example: `const templateBlock = !p || !projectsLoaded.value || !task.value.trim() ? "" : verificationPreset === "restored" ? "Choose a verification preset before saving a template" : "";` together with a `canSaveTemplate` boolean. Use it for the MenuItem at composer.tsx:333 and the "Save task preset" button at composer.tsx:395. The button should be disabled with the same explanation, either as visible help text next to it or through aria-describedby, not only a title tooltip.

Defense in depth: stop casting at composer.tsx:412. Map "restored" explicitly, either by refusing to open the dialog or by having SaveTaskTemplateDialog show "Choose a verification preset before saving a template" up front with Save disabled. A future third entry point should not fall back to the generic validator message. Optionally, the error at composer-tools.ts:125 could name the field, e.g. "Template verification must be  …

**Suggested regression test:** Add a case to test/e2e/simplification.e2e.ts, which already drives "Save as template…" at lines 88-95:
1. Finish a pipeline run with Verification gates = Lightweight, then use Edit & run again.
2. Assert #verification-profile has value "restored".
3. Assert both getByRole("menuitem", { name: /Save as template/ }) and getByRole("button", { name: "Save task preset" }) are disabled, and that the text "Choose a verification preset before saving a template" is visible or accessible for each.
4. Selec …

<details><summary>Verifier's independent reproduction</summary>

Setup: a fresh fake-mode server "v4619t14" on port 4619 with a new home, a new persistent browser profile, and a scratch clone of MQTT-MCP (clones/v4619t14-mqtt) added through "Open another repository" > Create project.

1. Run options > Advanced: set workflow to "Plan → Build → Review", untick plan approval, set Verification gates to "Lightweight profile", enter a task, Start run. Run 2610251912-b2cf78a1 finished with status done and loop.verification {"name":"lightweight","checks":[]}.
2. On the run page: More run actions > Edit & run again. The composer restored the pipeline workflow and the task. #verification-profile = "restored", with options ["Single configured check","From original run · lightweight","Lightweight profile",...].
3. Run actions (...) menu: "Save as template… / Choose a verification preset before saving a template [disabled]". Screenshot: shots/v4619t14/001-menu-guard.png.
4. Run options > Advanced: "Save task preset" is enabled (isDisabled() = false). Clicking it opens the "Save as template" dialog. After naming it "v4619 restored preset" and clicking Save template, the dialog stays open with role=alert "Invalid template execution settings." (shots/v4619t14/003-restored-preset-save.png). No composerLibrary key was written, so nothing is corrupted, but the user hits an unexplained dead end. No console or 5xx errors.

Attempts to refute:
- By design? docs/getting-started.md:95 says "A restored custom verification profile is retained; choose a preset before saving it as a task template." So the restriction is intended. The bug is that one of the two entry points does not apply the guard and fails with an unclear validation message.
- Tester's environment? No. I reproduced it on a fresh home, a fresh browser profile and a different repo, with Playwright role-based selectors.

Cleanup: deleted the run through the UI (API now returns 404), stopped v4619t14, and removed my scratch clone together with its run worktree and branch. The user's real MQTT-MCP repo was never touched. Leftovers: only the QA home and browser profile v4619t14 under scratchpad/qa.

</details>
