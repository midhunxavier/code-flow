# Cluster 09 · composer-draft-config

**Composer drafts vs repo config: stale check/setup/limits, deleted base, rerun leaks**

Status: **independently verified · context-only retry repair completed · integrated into `codex/dogfood-qa-continue`** · 9 issues · verification branch `codex/qa-composer-verify`

Planner notes: Drafts save the effective check, setup and limits as plain values and do not record where each value came from (draft save/restore in ui/state.ts ~1202). Restoring a draft therefore overrides values freshly derived from .codeflow/config.json and Settings > Projects (t03-1/t17-12), and Run details guesses the sources wrongly (t03-14). t02-2/t03-4: the limits signal always holds 240/200 and is always sent, so the server treats it as explicit and config limits are ignored. Track user-set vs derived for each field and send only explicit values; this touches the callers in ui/composer.tsx, ui/sweeps.tsx and ui/side-chat.tsx. t03-12: readRepoConfig reads the working tree, not the selected base. t02-9: a restored base branch is not checked again before Send. t06-3/t06-4: editAndRerun (ui/run.tsx ~2267) overwrites the project's unsent draft and leaks the parent link, loop and pinned base SHA into later runs. composer-presets-global owns applyPreset/applyDefaults; start-input-validation owns the onInput of the limit number inputs. Duplicate groups: [["t03-1","t17-12"],["t02-2","t03-4"]]

Likely files: `ui/state.ts`, `ui/composer.tsx`, `ui/onboarding.tsx`, `ui/run.tsx`, `ui/project-run-settings.tsx`, `ui/sweeps.tsx`, `ui/side-chat.tsx`, `ui/rerun-draft.ts`, `src/repo-config.ts`, `src/server.ts`

## Fix result

Commits:
- `a1b51068` Read a chosen start branch's committed config for new runs
- `4249a940` Keep the repository's models under a run's partial provider settings
- `a26547ac` Keep only chosen values in composer drafts and follow the repo config
- `bbb9d5b2` Ask before Edit & run again replaces an unsent project draft
- `89b7745d` Cover composer drafts against repo config changes in the browser

Fixer notes for the integrator: Behaviour changes in existing tests (intentional):
- test/project-drafts.test.ts: the /api/branches fixture now lists "feature/a". The test restores base "feature/a", and a restored base that isn't a branch is now dropped (t02-9).
- test/ui-review.test.ts ("Edit & run again from another repo"): it now asserts that localStorage "limits" is NOT written. A retry's limits no longer become the browser default (t06-4).

Overlaps with other clusters:
- composer-presets-global owns applyPreset/applyDefaults, and I didn't edit them. applyPreset's setRunCheck/setRunSetup calls now mark those commands as draft overrides, labelled "This run override".
- start-input-validation owns the onInput of the limit number inputs. I changed only the local `setLimits` wrapper in composer.tsx Settings() (one line, now `setRunLimits(patch)`), not the onInput handlers.
- The composer-permission-menu branch probably touches the composer's onPermissions lines. I didn't edit those; setTrust itself now records the draft choice.

New design points:
- composerOrigins keys check/setup/trust/limits mark values chosen for the draft. These are the only ones a restored draft replays. RERUN_ORIGIN = "Original run" marks values brought back by Edit & run again.
- limitPreference holds the limits saved in Settings → Run defaults. Settings → Run limits now shows the saved limits rather than the draft's current ones.
- The config read at a ref keeps the checkout's trust and copy (a security choice: a branch, possibly  …

## Independent continuation verification — 2026-10-26

Verified the integrated implementation from `cd2c7bd` in `/private/tmp/codeflow-qa-composer-verify` on branch `codex/qa-composer-verify`. Reviewed the original fix commits, replayed the four browser scenarios and added setup-removal, inactive/current project-default changes, reload persistence and context-only retry-edit variations. The original fixes hold. One nearby t06-3 defect was independently reproduced and repaired: `unsentDraft` called a retry untouched when its text matched the original even after a user added or removed context files. A second **Edit & run again** silently replaced that context selection. Retry drafts now record their original context, and the replacement check compares the selection as well as text/files; canceling preserves the edit. An unchanged original selection still needs no warning. Legacy retries with selected context but no baseline conservatively ask before replacement.

| Issue | Independent outcome |
| --- | --- |
| t03-1, t17-12 | Pass. Config changes update check/setup after navigation and reload; a typed setup stays with its draft; removing setup clears the next draft. Settings defaults update both an inactive project's saved draft and the current project, including verification and reload, without losing task text. |
| t02-2, t03-4 | Pass. Config limits/models appear with the correct source and reach the start request; configured provider models survive partial request settings. Explicit draft/browser limits retain precedence. |
| t03-14 | Pass. Typed setup is labeled This run override and remains so after reload; config and permission source regressions pass. |
| t03-12 | Pass. The selected branch supplies committed defaults. Engine regressions confirm checkout trust/copy remain authoritative and continuations retain the checkout policy. |
| t02-9 | Pass. Deleting a selected branch resets the restored draft to current branch with an explanation, preserving the task. Retry commit pins remain valid. |
| t06-3 | Repaired and pass. Existing typed-text confirmation passes. Added/removed retry context is now protected; browser Cancel preserves the added file. |
| t06-4 | Pass. The retry keeps its original parent/base/settings by design; the subsequent run uses the current branch and defaults, without leaking the parent, permission or budget. |

Evidence is under `/private/tmp/codeflow-qa-continue/work/composer-verify/`:

- `draft-browser-final.log`: **6/6 browser scenarios passed** on a fresh build and isolated server 4355.
- `composer-tests-final.log`: **21/21 tests passed**, comprising this cluster's engine/state tests, preset state tests, and existing project-draft, UI-review and rerun regressions. `npx tsc --noEmit` passed before that run.
- `context-unit-before.log` and `context-before.log`: independent failures before the repair (missing unsent-work result and missing replacement dialog); `context-unit-after.log` and `context-after.log`: passing targeted replay after the repair.
- `draft-config-server.log`: isolated server stdout/stderr. Browser page errors, unexpected console errors and API 5xx responses are asserted empty; server output has no uncaught/type/reference error.

All execution used fake agents, scratch Git repositories, separate temporary homes/tokens, fake GitHub state and ports 4355/4356. The live worktree/server, real repositories and `~/.codeflow` were untouched. No real-provider behavior is claimed. New tests are limited to this cluster's QA files; no shared test expectations changed in this verification pass.

## Issues

### t03-1 · major · A saved composer draft hides changes to .codeflow/config.json and to Settings > Projects run defaults, so runs use a stale check and setup

**Fix outcome: fixed.** Root cause: drafts saved the effective check/setup/trust/limits as plain values, and restoreComposer replayed them after loadRepoCheck had derived fresh ones. ui/state.ts: the values chosen for a draft are now recorded in composerOrigins (DRAFT_CHOICES check/setup/trust/limits; chooseForDraft/forgetChoices). setRunCheck/setRunSetup/setRunLimits/setTrust record them. restoreComposer only restores chosen fields; legacy drafts without choices are treated as derived, except Edit & run again drafts. loadRepoCheck never overwrites a chosen field. On a same-repository re-read it keeps values in place without blocking Send. ui/composer.tsx re-reads the config when the composer mounts or the tab becomes visible, which fixes the same-tab lag. ui/project-run-settings.tsx save() clears the open draft's check/setup choices, so other drafts pick up Settings → Projects when they open. The composer's ru …

Fixer's check: QA server f09 started from the worktree, fake agents, scratch repos, fresh Chrome profiles. Script work/f09/s1.mjs, on the base build: after the config changed, a reload still showed check 'echo A' and setup 'echo SA', labelled .codeflow/config.json, and the run was sent with 'echo A'. On the fix: after the reload the fields read 'echo B'/'echo SB' and the run's loop.check/setup were echo B/SB. Same tab with no reload (config changed after a run started, then back to New run): the fields followed config C and the next run used it. Settings → Projects variants (s6.mjs), both for a project that wasn't the current composer and for one that was: the draft showed check 'echo PDEF', setup 'echo SP …

Tests: `test/qa-composer-draft-config.test.ts`, `test/e2e/qa-composer-draft-config.e2e.ts`

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-26, CMP-43.

**Repro**

> 1. Start a fake QA server. Add a scratch clone whose committed .codeflow/config.json has {"check":"echo A","setup":"echo SA"} as project P (Open another repository > Create project).
> 2. Open http://127.0.0.1:<port>/#/project/<P>/new in a browser profile and wait about 3 s (draft saved; Run options shows check 'echo A').
> 3. Edit .codeflow/config.json in the clone to {"check":"echo B","setup":"echo SB"}.
> 4. Reload #/project/<P>/new and open Run options.
> 5. Type a task and Start.
> Variant: Settings > Projects > choose a project that already has a draft but is not the current composer > change Default check, setup and verification profile > Save project defaults > open that project's New run.

**Expected:** The check/setup fields follow the current config (or the saved project defaults) unless the user typed an override for this draft. Run details names the real source.

**Actual:** The fields keep the draft's old 'echo A'/'echo SA' while the note above says 'Using .codeflow/config.json: check “echo B” · setup “echo SB”'. Run details labels the stale value '.codeflow/config.json', and the run is sent with the stale command (run 2610251415-1e499b17 loop.check 'echo CHANGED-CHECK' while config said 'echo CHANGED-AGAIN'). Variant: after 'Project defaults saved.' Studio's composer still showed check 'npm test', setup '' and verification '' (Run details labelled the old value 'Project Settings (this browser)'). Even with Studio as the current composer, the saved default verification profile (lightweight) was not applied.

**Root cause (verifier):** A draft saves check and setup as plain values, with no record of whether the user typed them or the app derived them. Restoring a draft then overrides freshly derived values.

1. ui/state.ts:1202, composerSnapshot(): saves `check: checkCmd.value, setup: setupCmd.value`. These are whatever loadRepoCheck() derived (config, remembered check:<repo>, or detection). checkHint, the "Override for this run." marker, is not saved. The effect at ui/state.ts:1335-1341 writes this snapshot on every change, so opening a project's composer once freezes the derived values into its draft.

2. ui/state.ts:1236, restoreComposer(): `checkCmd.value = snapshot.check; setupCmd.value = snapshot.setup;` runs unconditionally. It is called after setRepo() → loadRepoCheck() has already put the current config or project defaults into those signals:
   - initializeProjectDrafts, ui/state.ts:1330-1331 (page load)
   - switchComposer, ui/state.ts:1278-1279 (project switch)
   The stale draft value wins. switchComposer keeps detectedCheck/detectedSetup only when the repository changed (1287-1289).

3. ui/onboarding.tsx:297-298, EffectiveSettings: the Source column is worked out from the current localStorage key ch …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-run-settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-drafts.test.ts`

**Suggested fix:** Record which fields the user actually chose, and restore only those.

1. Add per-field override flags to the draft snapshot, for example `checkOverride: boolean`, `setupOverride: boolean` and `verificationOverride: boolean`.
   - Set them in setRunCheck/setRunSetup (state.ts:746-753) and in the composer's onChange for verification (selectVerification called from the select).
   - Clear them in resetComposer and when the repository changes.
   - Save checkHint, or at least the override flag, so the "This run override" label survives a reload.

2. In restoreComposer, only assign `checkCmd`/`setupCmd` when the matching override flag is true. Otherwise keep the value loadRepoCheck() just derived.
   - For drafts written before this change (no flags), treat a value equal to neither the current config nor the current store value as an override, or simply treat it as derived. Either way the default path becomes fresh.
   - Also bump checkEdit/setupEdit when restoring an override, so a late lo …

**Suggested regression test:** Add a test to test/project-drafts.test.ts, which already stubs fetch for /api/repo-config and drives state.initializeProjectDrafts/openComposer. Make the repo-config stub read a mutable `configCheck` variable.

1. openComposer("a") and let the draft save with the derived check `test /a`.
2. Change the stub to return check "test /a v2" and setup "setup v2", then openComposer("b") and back to openComposer("a").
3. assert.equal(state.checkCmd.value, "test /a v2") and assert.equal(state.setupCmd.val …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server, v4635 on 127.0.0.1:4635 (new home), with persistent browser profile "v4635". Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4635/ (obs.mjs, variant.mjs, step2/4/5/6/7.log, varA.log, varB.log).

1. Made a scratch clone of MQTT-MCP (clones/v4635-mqtt) and committed .codeflow/config.json {"check":"echo A","setup":"echo SA"}. Added it in the UI with Open another repository > Create project, which created project p-92f18a0b.
2. Opened #/project/p-92f18a0b/new and waited 3.5 s. Check field "echo A", setup field "echo SA". The note and Run details agreed.
3. Committed config {"check":"echo B","setup":"echo SB"} in the clone. /api/repo-config returned B.
4. Did a fresh page load of #/project/p-92f18a0b/new and opened Run options:
   - Check field still "echo A", setup field still "echo SA".
   - The note above said 'Using .codeflow/config.json: check "echo B" · setup "echo SB"'.
   - Run details showed "Verification command | echo A | .codeflow/config.json" and "Worktree setup | echo SA | .codeflow/config.json".
   - Screenshot: shots/v4635/001-step4-reload.png.
   - I never typed in either field, and no check:<repo> browser preference existed (Run details would otherwise say "Project Settings").
5. Typed a task and pressed Send. Run 2610251810-51ab3412 had loop.check "echo A" and loop.setup "echo SA". Its event log shows the setup tool_call "echo SA" actually ran.

Variant A (project is not the current composer):
- Added a second scratch project (v4635-mqtt2), which became the current composer.
- In Settings > Projects I chose v4635-mqtt and set Default check "echo PDEF", setup "echo SPDEF", verification Lightweight. I clicked Save project defaults and "Project defaults saved." appeared.
- Opening v4635-mqtt's New run (in-app and after a reload) showed check "echo B", setup "echo SB" and verification "" (from that project's draft).
- Run details labelled "echo B" as "Project Settings (this browser)", but the saved project setting was "echo PDEF".

Variant B (project is the current composer):
- Saved check "echo PDEF2", setup "echo SPDEF2", verification Standard.
- Check and setup did update, because save() writes the signals directly.
- Verification stayed "" (Single configured check), in-app and after a reload.
- I then started run 2610251813-1e20ca07 (loop.verification null) and reopened New run. Verification was still "", so t …

</details>

### t17-12 · minor · Composer project draft reuses an old setup command after .codeflow/config.json changed

**Fix outcome: duplicate.** Same root cause as t03-1: the draft replayed a setup and check derived from config. Fixed by t03-1's changes, including re-reading the config when the composer is entered in the same tab.

Fixer's check: s1.mjs case D: config.json committed with no setup, then a reload. The setup field was '' with 'Worktree setup | None | Not configured' (on base it kept the old setup). Same-tab case C: the run was sent with the new config's setup. The e2e covers a config change followed by a reload, and a typed override that survives a reload.

Tests: `test/qa-composer-draft-config.test.ts`, `test/e2e/qa-composer-draft-config.e2e.ts`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-05.

**Repro**

> 1. Put setup 'echo leftover > setup-leftover.txt' in the checkout's .codeflow/config.json and start a run. 2. Change config.json's setup (to a failing command, then remove it). 3. Start the next runs from the composer in the same project.

**Expected:** New runs use the current config.json setup unless the user edited the field.

**Actual:** Run 2610251617-b5c485f3 used the old 'echo leftover' setup. Later, run 2610251618-2b20451c used the old failing setup although config.json had none. A fresh reload sometimes shows the current value. The behaviour depends on draft restore timing.

**Root cause (verifier):** The composer persists the effective setup and check values in the per-project draft without recording where they came from. On load it replays them as if the user had set them.
- ui/state.ts:1202 (composerSnapshot): stores `check: checkCmd.value, setup: setupCmd.value` whether the value was typed or auto-filled by loadRepoCheck. The effect at ui/state.ts:1338-1344 writes every change to the draft, including the config fill that resetComposer -> loadCheck does right after each run starts (ui/composer.tsx:263).
- On reload: ui/main.tsx:120 calls setRepo -> loadRepoCheck, which correctly fills from the current config (ui/state.ts:828 for setup, :835 for check). Then initializeProjectDrafts calls restoreComposer(saved) (ui/state.ts:1331), and ui/state.ts:1236 (`checkCmd.value = snapshot.check; setupCmd.value = snapshot.setup;`) overwrites them with the stale draft values. loadRepoCheck's late-result guards (`!setupCmd.value` / `checkCmd.value` at :850-851) then keep the stale value.
- Project switch: switchComposer does the same at ui/state.ts:1276-1279. It only reverts to the detected values when the repository changed (:1290-1292).
- In the same tab, the config is re-read only on set …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-run-settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-navigation.e2e.ts`

**Suggested fix:** 1. Track the origin of the two commands as composer state, e.g. `commandOrigins = { check: "detected" | "explicit", setup: "detected" | "explicit" }`.
   - These writers mark the field explicit: setRunCheck/setRunSetup and setCheck/setSetup (ui/state.ts:745-760), Edit & run again (ui/run.tsx:2306-2307), onboarding's apply (ui/onboarding.tsx:86-87) and project run settings (ui/project-run-settings.tsx:44).
   - loadRepoCheck and setRepo's clearSelection mark the field detected.
2. Store the origins in composerSnapshot.
3. In restoreComposer, restore snapshot.check/setup only when their origin is "explicit". Otherwise keep the values loadRepoCheck just derived from the current config or detection. Treat legacy snapshots without origins as detected, so they self-heal.
4. Make switchComposer and initializeProjectDrafts apply that rule. The repository-changed branch at :1290 can then be dropped.
5. Re-run loadCheck (it already respects the checkEdit/setupEdit counters) when the composer rou …

**Suggested regression test:** Add to test/e2e/project-navigation.e2e.ts, which already writes .codeflow/config.json with check/setup.
- Test 1: write config {setup:"echo a", check:"true"} and open the project composer. Wait for the draft save, then rewrite the config to {setup:"echo b", check:"test -d ."} and page.reload(). Assert that getByLabel("Worktree setup command") is "echo b" and getByLabel("Done when this passes") is "test -d .". Start a run and assert that /api/runs/:id loop.setup is "echo b".
- Test 2 (the convers …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4683t1712 on 127.0.0.1:4683 with a fresh home and a fresh persistent browser profile. I used a scratch clone of MQTT-MCP (clones/v4683-mqtt) and committed .codeflow/config.json v1 = {setup:"echo v1 > setup-v1.txt", check:"true", prove:false}. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4683/ (s1-s4, logs s1.log-s4.log).
1) s1: added the clone through the UI ("Open another repository" -> new project "v4683 MQTT"). Composer showed setup "echo v1 > setup-v1.txt", check "true". Correct.
2) s2, same tab with no reload: started run1 (2610252155-2cc7645b) from the composer. loop.setup was the v1 command. Changed config.json to v2 (setup "echo v2 > setup-v2.txt"); /api/repo-config confirmed v2. Went back to the composer: the field still showed v1. Started run2 (2610252156-7b31c758): loop.setup = "echo v1 > setup-v1.txt", and its worktree contains setup-v1.txt.
3) s3, reload: changed config.json to v3 with no setup. Loaded the page and reloaded 3 times, waiting 2.5 s, 4 s and 5.5 s. Every load showed setup "echo v2 > setup-v2.txt". The result never depended on timing. The Run options summary at the same moment read "Using .codeflow/config.json: check 'true'", with no setup mentioned. Started run3 (2610252156-b99c1713): loop.setup = "echo v2 > setup-v2.txt", and its worktree contains setup-v2.txt.
4) Control: a fresh browser profile on the same project showed setup "" (correct). So the stale value lives only in the saved project draft (IndexedDB codeflow-project-drafts). localStorage had no setup:/check: keys, which shows the field was never edited or remembered by the user.
5) s4, check field: changed config check to "test -d mqtt-python" and reloaded. The field still showed "true" while the config note said "Using .codeflow/config.json: check 'test -d mqtt-python'". The "Done when" check is replayed the same way.
Observed pattern: each run uses the config as of the previous run's start, or of the last time the composer loaded the repo. Errors array was empty throughout.
Cleanup: archived the 3 runs with cleanup + delete branches (worktrees and branches removed) and deleted them, stopped the server, removed the scratch clones. No leftovers apart from the stopped home and browser profile in the QA scratch dir.

</details>

### t02-2 · major · .codeflow/config.json 'limits' are ignored for every run started from the composer

**Fix outcome: fixed.** The limits signal always held the browser default 240/200 and was always sent. ui/state.ts now keeps limitPreference, the limits saved in Settings → Run defaults, which is null until you save some. deriveDefaults() sets the draft's limits from Settings, else config.limits maxMinutes/maxSteps (clamped to the 720/200 the fields accept), else the app defaults, unless the draft chose its own. setLimits (Settings) saves only the browser's own limits, so a repository's config is never saved as the browser default. setRunLimits (composer Advanced, Edit & run again) is draft-only. Composer runs and sweeps now send the effective limits. Side chats (ui/side-chat.tsx) send only saved browser limits, otherwise they let the server apply that repository's config. The config note, the summary and the Run details Limits row show the config's limits with source .codeflow/config.json. Settings → Run limit …

Fixer's check: s1.mjs/s8.mjs on f09, fresh profile, with config limits 15/12 and then 33/44 plus checkTimeoutMin 7. The summary read 'Limit 12 calls · 15 minutes' and Run details 'Limits | 15 minutes · 12 steps | .codeflow/config.json'. The POST body sent maxMinutes 15 / maxSteps 12, and the solo and Fix & review runs stored 33/44 with checkTimeoutMin 7. On the base build the same flow sent 240/200. localStorage 'limits' stayed unset.

Tests: `test/qa-composer-draft-config.test.ts`, `test/e2e/qa-composer-draft-config.e2e.ts`

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-20, CMP-23.

**Repro**

> 1. In a scratch clone write .codeflow/config.json {"check":"true","limits":{"maxMinutes":15,"maxSteps":12}}.
> 2. Open the repo's project in the composer. The summary says 'Limit 200 calls · 240 minutes'. Run options > Run details shows 'Limits 240 minutes · 200 steps'. The config note does not mention limits.
> 3. Type a task and click Send.
> 4. GET /api/runs/<id>: loop.maxMinutes=240, maxSteps=200.
> 5. For comparison, POST /api/runs with loop:{} gets maxMinutes 15, maxSteps 12.

**Expected:** The repository's configured limits are the defaults for composer runs (the repo-config doc comment calls them defaults) and are shown in the summary and Run details.

**Actual:** Composer runs always use the browser limits (240/200). The OPCUA config (30 min/20 steps) was ignored the same way. The UI never shows the config limits.

**Root cause (verifier):** ui/state.ts:652 starts the `limits` signal from store.json("limits", DEFAULT_EXECUTION_BUDGET), which is 240 minutes / 200 steps (src/execution-budget.ts:2). ui/composer.tsx:264 and ui/state.ts:1286 reset it the same way.
ui/composer.tsx:225-226 (runBody) always sends loop.maxMinutes and loop.maxSteps from that signal, even when the user never chose them.
src/engine.ts:5118-5124 merges DEFAULT_LOOP, then config.limits, then every defined request value. Its comment reads "anything the request sets explicitly wins", so the browser fallback 240/200 always replaces config.limits.maxMinutes/maxSteps. checkTimeoutMin still comes from config only because the composer never sends it.
The UI loads repo config in loadRepoCheck (ui/state.ts:826-830). It applies config.check, config.setup and config.trust when there is no browser preference, but it never reads config.limits.
The display has the same gap. configSummary (ui/composer.tsx:1059-1068) omits limits. EffectiveSettings (ui/onboarding.tsx:305) labels the limits row "Application defaults" when store.get("limits") is null, which is misleading because the config would win if the composer stopped overriding it.
The same pattern appears in u …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/sweeps.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/side-chat.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ui-review.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/configuration.md`

**Suggested fix:** Handle limits the way loadRepoCheck already handles trust and setup.
1. In loadRepoCheck (ui/state.ts, after `repoConfig.value = result`): if store.get("limits") is null, no preset or Edit & run again has set limits for this draft, and the stale-request guards still pass, set `limits.value = { ...limits.value, maxMinutes: config.limits.maxMinutes ?? limits.value.maxMinutes, maxSteps: config.limits.maxSteps ?? limits.value.maxSteps }`. Clamp to the input bounds (maxMinutes 720, maxSteps 200). Assign the signal directly, not through setLimits, so a repo's config is never saved as the browser default. Track an origin flag (for example in composerOrigins) so a later repo switch, which already re-reads store.json("limits", DEFAULT_EXECUTION_BUDGET), drops the previous repo's config limits.
2. Show where the limits come from. In configSummary (ui/composer.tsx:1059) add `config.limits && "limits N min · M steps"`. In EffectiveSettings (ui/onboarding.tsx:305), make the source ".codeflow/config …

**Suggested regression test:** Add two cases to test/ui-review.test.ts, using its existing `answers` mock pattern.
(a) storage.clear(), mock answers["/api/repo-config"] = () => ({ config: { limits: { maxMinutes: 15, maxSteps: 12 } }, found: true }), await m.loadCheck(). Assert m.limits.value.maxMinutes === 15 and maxSteps === 12, and that storage.get("limits") is still unset (the config must not become the browser default).
(b) Same, but first set storage "limits" to {maxMinutes:60, maxSteps:40} (an explicit browser default). …

<details><summary>Verifier's independent reproduction</summary>

Fresh QA home v4691, fake mode, port 4691. I used a fresh headless browser with no profile, so localStorage had no 'limits' key and the user had never set limits. That rules out "the user set limits in the UI, so the UI wins".
1. Made a scratch clone of MQTT-MCP (bare repo plus working clone under qa/clones/v4691-cfg). Committed .codeflow/config.json containing {"check":"true","limits":{"maxMinutes":15,"maxSteps":12}}.
2. Opened the clone in the UI with "Open another repository" and "Create project" (project v4691-cfg).
3. Composer summary read "Limit 200 calls · 240 minutes". The config note read "Using .codeflow/config.json: check “true”" and did not mention limits. Run options > Run details showed "Verification command | true | .codeflow/config.json", which is correct, but "Limits | 240 minutes · 200 steps | Application defaults". Advanced > Branches and limits said "stops after 240 min or 200 steps", and the #maxMinutes/#maxSteps inputs held 240/200.
4. Typed a task and clicked Send. GET /api/runs/2610251904-9b2cceb0 returned loop {check:"true", maxMinutes:240, maxSteps:200, checkTimeoutMin:10}. The config check was applied but its limits were not.
5. Control: POST /api/runs to the same repo and project with loop:{} created 2610251904-ae8d400c with loop {maxMinutes:15, maxSteps:12}.
So the server honours config.limits, and the composer overrides them every time. No console errors or 5xx responses. Script and log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4691/cfg1.mjs and cfg1.log. Screenshot of Run details: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4691/004-run-details.png.
Why this is not by design: docs/configuration.md ("Per-repo config") says "Commit .codeflow/config.json and every run in that repo ... gets the same defaults. Anything you set in the UI wins", and its example includes "limits". The src/repo-config.ts doc comment lists limits among the defaults. Here nothing was set in the UI; the 240/200 values are DEFAULT_EXECUTION_BUDGET. git history shows the composer has always sent limits since commit 2f32187 introduced repo config, so config limits have never worked from the composer.
Cleanup: both runs were archived with cleanup and deleteBranches (worktrees and codeflow branches removed) and then deleted. The run view showed no Delete control on archived runs, so the delete went t …

</details>

### t03-4 · major · .codeflow/config.json 'limits' (maxMinutes/maxSteps) are ignored for runs started from the composer, and Run details shows defaults instead of the config's limits/models

**Fix outcome: duplicate.** t02-2's fix covers the limits. The config-models part is also fixed: Run details model rows (ui/onboarding.tsx) and the config note now show config.models with source .codeflow/config.json. src/engine.ts withConfiguredModels merges config.models under the request's agentSettings field by field, so a solo composer run (which always names its provider with an empty setting) no longer drops the repository's model.

Fixer's check: s8.mjs: config {limits 33/44/7, models claude haiku/low}. Run details showed 'Limits | 33 minutes · 44 steps | .codeflow/config.json' and 'agent · claude | haiku · low | .codeflow/config.json' ('reviewer · claude' for Fix & review). Both composer runs stored loop 33/44, checkTimeoutMin 7 and agentSettings.claude {model: haiku, effort: low}; on base the solo run would have replaced the model with {}. The engine unit test covers the field-wise merge.

Tests: `test/qa-composer-draft-config-engine.test.ts`, `test/qa-composer-draft-config.test.ts`, `test/e2e/qa-composer-draft-config.e2e.ts`

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-26, CMP-33.

**Repro**

> 1. In a scratch clone commit .codeflow/config.json with "limits": {"maxMinutes":33,"maxSteps":44,"checkTimeoutMin":7} and "models": {"claude":{"model":"haiku","effort":"low"}}.
> 2. Fresh browser profile > that project's New run > Run options > Run details.
> 3. Start any workflow (e.g. Fix & review) and check GET /api/runs/<id> loop.

**Expected:** New runs default to 33 min / 44 steps (as config.json documents), and the composer summary and Run details show them, plus the config model for claude, with source .codeflow/config.json.

**Actual:** Composer: 'Limit 200 calls · 240 minutes', Run details 'Limits 240 minutes · 200 steps | Application defaults' and 'agent · claude | CLI default · default effort | CLI defaults'. Runs 2610251413-4774c6e3 and 2610251416-cf1c2ece have loop.maxMinutes 240 / maxSteps 200. checkTimeoutMin 7 and models haiku/low were applied server-side but not shown.

**Root cause (verifier):** The client can't tell "the user never chose limits" apart from "the user chose 240/200", so it always sends limits. The server then treats them as explicit.

- ui/state.ts:652: `limits = signal(store.json("limits", DEFAULT_EXECUTION_BUDGET))`. With nothing saved in the browser, the signal holds the app defaults {maxSteps:200, maxMinutes:240} (src/execution-budget.ts:2).
- ui/composer.tsx:225-226: runBody always puts `maxMinutes: limits.value.maxMinutes, maxSteps: limits.value.maxSteps` into `loop`.
- src/engine.ts:5117-5125: in startResolved the merge is `{...DEFAULT_LOOP, ...config.limits(defined), ...given(defined, non-empty)}`. Any defined request value beats config.limits. checkTimeoutMin survives only because the composer never sends it.
- The same always-send pattern is in ui/sweeps.tsx:175 and ui/side-chat.tsx:506.

Display side:
- ui/composer.tsx:341: the summary shows only `limits.value`.
- ui/onboarding.tsx:305: the "Limits" row shows `limits.value`, and its source is either "Browser preferences" or "Application defaults". It never reads `repoConfig.value.config.limits`, even though `config` is in scope at line 289.
- ui/onboarding.tsx:306-313: the per-role model rows use …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/sweeps.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/side-chat.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/configuration.md`

**Suggested fix:** Make the client's effective limits follow the precedence the docs promise: an explicit user value, then the repo's config.limits, then the app defaults. Send only values that are explicit.

1. In ui/state.ts, track whether the limits were set explicitly: a "limits" key saved by setLimits, a preset or snapshot restore, or a per-run edit in the composer. Add a computed `effectiveLimits` that returns {...DEFAULT_EXECUTION_BUDGET, ...repoConfig.value?.config.limits (defined maxMinutes/maxSteps), ...explicit}, together with a source for each field.
2. ui/composer.tsx runBody (225-226): send maxMinutes and maxSteps only when they are explicit. Otherwise leave them undefined so the engine merge at src/engine.ts:5119-5125 applies config.limits. Alternatively, send the computed effective values, which then equal config.limits. Omitting them keeps server and client consistent if the config changes between render and start. Apply the same change to ui/sweeps.tsx:175 and ui/side-chat.tsx:506. Reru …

**Suggested regression test:** 1. In test/repo-selection-ui.test.ts, which already stubs /api/repo-config and resets state: with empty storage and a repo-config response of {found:true, config:{limits:{maxMinutes:33,maxSteps:44}, models:{claude:{model:"haiku",effort:"low"}}}}, assert that the composer's run body has either no loop.maxMinutes/maxSteps or 33/44, never 240/200. Also assert that the Run details rows (render EffectiveSettings) contain "33 minutes · 44 steps" with source ".codeflow/config.json", and "haiku · low" f …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4641 on 127.0.0.1:4641, with a fresh home and a fresh headless-Chrome profile (no `profile`, so localStorage starts empty; I confirmed there was no "limits" key). Scratch clone of MQTT-MCP with a committed .codeflow/config.json containing {"check":"true","limits":{"maxMinutes":33,"maxSteps":44,"checkTimeoutMin":7},"models":{"claude":{"model":"haiku","effort":"low"}}}. I added it through the UI ("Open another repository", then Create project "v4641 cfg") and went to New run, opened Run options, Advanced and Run details, and chose Fix & review.

What the composer showed:
- GET /api/repo-config returned the limits and models correctly.
- The config note listed only `check "true"`.
- The summary said "Limit 200 calls · 240 minutes".
- Run details said "Limits | 240 minutes · 200 steps | Application defaults" and "reviewer · claude | CLI default · default effort | CLI defaults".

I started the run through the UI and captured the POST /api/runs body: loop = {"check":"true","setup":"","maxMinutes":240,"maxSteps":200,"verification":null}, agentSettings = {}. The stored run 2610251812-f298202a had loop.maxMinutes 240, maxSteps 200, checkTimeoutMin 7 and agentSettings.claude haiku/low. So checkTimeoutMin and models from the config applied, and the limits did not.

Control (r2.mjs): same UI flow, but page.route deleted loop.maxMinutes and maxSteps from the POST in flight. Run 2610251812-60800fd4 got maxMinutes 33, maxSteps 44, checkTimeoutMin 7. The server honors config limits whenever the client omits them.

Why this isn't the tester's setup or intended behaviour:
- The profile was fresh, and the UI labels the source "Application defaults", not a user choice.
- docs/configuration.md says "Commit .codeflow/config.json and every run in that repo (and every teammate) gets the same defaults. Anything you set in the UI wins."
- The engine comment says ".codeflow/config.json supplies defaults; anything the request sets explicitly wins."
- Here nothing was set explicitly. The browser's built-in default is sent as if the user had chosen it.

Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4641/ (r1.mjs/r1.log, r2.mjs/r2.log). Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4641/001-run-details.png.

Cleanup: both runs deleted through the UI (bulk Delete), server v …

</details>

### t03-14 · minor · Run details labels a typed setup override as '.codeflow/config.json' and shows draft values as 'Application default'

**Fix outcome: fixed.** Run details guessed sources from the current localStorage/config. It now reads the recorded origin first (ui/onboarding.tsx EffectiveSettings: origins.check/setup/trust/limits). A typed setup or check shows 'This run override', and that survives a reload because composerOrigins is saved with the draft. The checkHint string comparison is gone. A permission that the draft never chose is derived again on restore, so its inferred source (browser preference, .codeflow/config.json, Application default) is now true. Permissions are labelled with the checkout's config even when the config was read at a start branch.

Fixer's check: s2.mjs on f09. After typing: 'Worktree setup | echo TYPED-SETUP | This run override' (base said .codeflow/config.json). After removing trust from config and reloading, the typed setup and check both still showed 'This run override', and Permissions read 'standard | Application default', which is the real value and source. On base it showed 'safe | Application default'. The config note marks overridden config fields '(overridden)'.

Tests: `test/qa-composer-draft-config.test.ts`, `test/e2e/qa-composer-draft-config.e2e.ts`

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-33, CMP-25.

**Repro**

> 1. Project whose config.json defines setup. New run > Run options > type a different command in 'Worktree setup command'.
> 2. Open Run details.
> Also: with a draft restored from earlier, change config.json so it has no valid trust. Run details shows 'Permissions safe | Application default'.

**Expected:** Source 'This run override' (as the Verification command row does) and the real origin of the permissions value.

**Actual:** 'Worktree setup <typed command> | .codeflow/config.json'. Permissions sourced 'Application default' while the value came from the restored draft.

**Root cause (verifier):** The Run details source column guesses where a value came from by checking which sources exist, instead of recording where it was actually set.

- ui/onboarding.tsx:298: the Worktree setup source is `rememberedSetup !== null ? "Repository preference (this browser)" : config.setup ? ".codeflow/config.json" : setupCmd.value ? "Repository detection" : "Not configured"`. Typing in the Run options setup input (ui/composer.tsx:369, onInput -> setRunSetup in ui/state.ts:750-753) only bumps setupEdit and sets setupCmd. No hint or origin is recorded, so any value in a repo whose config has `setup` is labelled .codeflow/config.json. With no config.setup, a typed value would be mislabelled "Repository detection".
- ui/onboarding.tsx:299: the Permissions source is `store.get("trust") !== null ? "Explicit browser preference" : config.trust ? ".codeflow/config.json" : "Application default"`. trust.value can also come from the restored project draft (ui/state.ts:1237 restoreComposer: `trust.value = snapshot.trust`), from the earlier config fallback (ui/state.ts:829) or from a previous config. Only the current localStorage and current config are consulted, so a restored "safe" is shown as "Applicat …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Record provenance for setup, check and trust where each value is assigned, using composerOrigins, which is already saved in and restored with the draft. Stop inferring it at render time.

1. In ui/state.ts, have setRunSetup and setRunCheck set composerOrigins.setup/check = "This run override", and have setSetup/setCheck set them to "Repository preference (this browser)" or "Project Settings (this browser)". In loadRepoCheck, set the origin wherever it fills a value: config -> ".codeflow/config.json", /api/check -> `Detected from ${source}`, remembered -> browser preference, empty -> "Not configured". Only do this when the setupEdit/checkEdit version guards pass, so an override typed during lookup keeps its label.
2. In setTrust, set composerOrigins.trust = "Explicit browser preference". At ui/state.ts:829 set it to ".codeflow/config.json". In setRepo's clearSelection, set it to "Explicit browser preference" or "Application default" to match the value chosen. ui/run.tsx:2294 (rerun) can …

**Suggested regression test:** Extend test/e2e/ui.e2e.ts next to the existing Run details assertions (around lines 975-983, which already locate `.effective-settings tr` by rowheader). Use a fixture repo whose .codeflow/config.json has setup, check and trust "safe".

(a) Fill #setupCmd with "echo typed" and assert the "Worktree setup" row contains "This run override" and does not contain ".codeflow/config.json".
(b) Reload the page in the same context so the project draft is restored, without changing localStorage "trust". As …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4661 on port 4661, with a fresh home. I created a scratch git repo at scratchpad/qa/clones/v4661-cfg containing .codeflow/config.json = {setup:"echo CONFIG-SETUP", check:"echo CONFIG-CHECK", trust:"safe"} and registered it as project "V4661 cfg" through POST /api/projects. Browser profile "v4661" started fresh, with no trust, setup: or check: keys in localStorage.

Script work/v4661/a1.mjs: I opened #/project/<id>/new and expanded Run options, Advanced and Run details. The fields were prefilled from config. Before typing, the rows read: Verification command | echo CONFIG-CHECK | .codeflow/config.json; Worktree setup | echo CONFIG-SETUP | .codeflow/config.json; Permissions | safe | .codeflow/config.json. I then typed "echo TYPED-SETUP" into #setupCmd and "echo TYPED-CHECK" into #checkCmd. Afterwards: Verification command | echo TYPED-CHECK | This run override (correct), but Worktree setup | echo TYPED-SETUP | .codeflow/config.json (wrong). Screenshot: shots/v4661/001-after-typing.png.

Script work/v4661/a2.mjs: I removed "trust" from the scratch repo's config.json (GET /api/repo-config confirmed {check, setup} only) and reloaded with the same profile, so the IndexedDB project draft was restored. The fields showed TYPED-SETUP and TYPED-CHECK, and localStorage still had no trust key. The rows read: Permissions | safe | Application default. That label is wrong, because the application default is "standard" (ui/state.ts:185, :654) and "safe" came from the restored draft. The restored setup override was again labelled .codeflow/config.json.

Extra finding: the restored check override also reverts to ".codeflow/config.json". checkHint is not part of the draft snapshot, so the "This run override" label for the check row only lasts for the current page session. Screenshot: shots/v4661/001-restored-no-trust.png.

No console errors or 5xx responses. No runs were created; I stopped the server and deleted the scratch repo.

Why this is not by design: docs/application-improvements.md item 7 says "Effective settings and provenance inspection", and the panel subtitle is "Values and where they came from". The check row already distinguishes "This run override", so the setup row's different behaviour is an inconsistency. It is not caused by the tester's environment: it reproduces from a fresh profile and home with a plain typed edit.

</details>

### t03-12 · minor · .codeflow/config.json is read from the working copy, not the run's selected base branch

**Fix outcome: fixed.** src/repo-config.ts adds readRepoConfigAt(repo, ref), which uses git show of the resolved commit and a shared parseRepoConfig. Option-like refs are refused, and an unresolved ref reads the checkout. trust and copy always come from the checkout's file so a branch, for example an agent's, can't widen permissions or choose local files to copy. src/engine.ts startResolved reads the config at input.baseRef for independent runs; issue/PR/imported-source runs and continuations (parentRunId) keep the checkout's. src/server.ts GET /api/repo-config accepts ?ref=. ui/state.ts: a configRef computed (start branch, or '' for source, external-source and retry drafts) plus an effect reload the config when the start branch changes, keeping typed values. The note says 'Using .codeflow/config.json from <branch>' and Run details says '.codeflow/config.json at <branch>'. Documented in docs/configuration.md an …

Fixer's check: s3.mjs on f09. After choosing Start from branch > qa-alt, the composer showed check 'echo ALT-BRANCH-CHECK', setup 'echo ALT-SETUP' and limits 33 steps, with the note 'from qa-alt' and permissions '(from your checkout)'. The run got baseLabel qa-alt and loop check/setup/maxSteps ALT/ALT-SETUP/33, with trust safe from the checkout. The API control (POST with baseRef qa-alt, loop {}) also got the ALT values; on base both used main's config. Engine unit tests cover the branch read, a continuation keeping the checkout's config, explicit values winning, and trust/copy staying with the checkout.

Tests: `test/qa-composer-draft-config-engine.test.ts`, `test/qa-composer-draft-config.test.ts`, `test/e2e/qa-composer-draft-config.e2e.ts`

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-26.

**Repro**

> 1. Scratch clone: main has a committed config (check pytest, trust safe). Create branch qa-alt whose config has check 'echo ALT-BRANCH-CHECK' and trust standard (main stays checked out).
> 2. New run > Start from branch > qa-alt.
> 3. Start Fix & review.

**Expected:** Repo defaults come from the commit the run starts from, or the composer warns that the checkout's config is used.

**Actual:** The composer keeps showing main's check, note and Safe. Run 2610251431-92efa39c has baseRef = qa-alt but loop.check = main's pytest command and trust safe.

**Root cause (verifier):** src/repo-config.ts:46-47 readRepoConfig(repo) reads join(repo, ".codeflow/config.json") from the filesystem, so it always gets the checkout's working-tree file (uncommitted edits included). No commit or ref can be passed.
1. src/engine.ts:5117 (startResolved) calls readRepoConfig(await repoRoot(input.repo)) before the base is resolved (baseLabel/baseRef only at engine.ts:5153-5157). config.check, setup, trust (5180), limits and copy (5122), image (5202), learn (5226), models (5273), prove (5283) and app/run (5285) therefore come from the checkout, not from baseRef.
2. src/server.ts:2261-2263 GET /api/repo-config accepts only ?repo= and has no ref. src/server.ts:637 (validateRoles trust) has the same problem.
3. ui/state.ts:804-845 loadRepoCheck fetches /api/repo-config?repo=… only. It runs on repo selection (ui/state.ts:217) and composer reset (ui/composer.tsx:263), never when baseRef changes. It then pre-fills checkCmd/setupCmd/trust (ui/state.ts:828-836) and the config note (ui/composer.tsx:350), and the composer sends these as explicit values, so the engine treats them as user choices.
Meanwhile src/app-command.ts:7 (Run app) reads the worktree, so a single run mixes two configs …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/repo-config.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/configuration.md`

**Suggested fix:** 1. Add readRepoConfigAt(repo, ref) in src/repo-config.ts. It runs `git show <commit>:.codeflow/config.json` (the pattern already in src/learnings.ts:24 and src/integrity.ts:113) and shares the parse/validation code with readRepoConfig through a parseRepoConfig(raw) helper. A missing path at that ref returns {found:false}.
2. In engine.startResolved, resolve baseLabel/baseRef first (move the repoRoot/loadSource/resolveCommit block above the config read). Then read the config at baseRef whenever a base was explicitly requested (input.baseRef or a PR branch). With no base, keep the working-copy read so the current HEAD behaviour stays.
3. Untrusted sources (source.trusted === false, externalSource, lockdown) must not take setup/check/copy/image from a fork's branch. Keep using the checkout's config there, or ignore those keys; setup runs outside the agent sandboxes.
4. Add an optional &ref= to GET /api/repo-config (server.ts:2261) and to validateRoles' trust lookup.
5. In ui/state.ts, pas …

**Suggested regression test:** Engine test, in test/workspace.test.ts or a new test/repo-config-base-ref.test.ts:
- Init a repo with .codeflow/config.json {check:"echo MAIN", setup:"true", trust:"safe", prove:false, limits:{maxSteps:7}} committed on main.
- Create branch alt with {check:"echo ALT", trust:"standard", prove:true, limits:{maxSteps:33}} and check main back out.
- manager.start({pattern: fix-review or solo, repo, baseRef:"alt", roles, options:{}, loop:{}}).
- Assert run.loop.check === "echo ALT", run.trust === "st …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4657 on port 4657, fresh browser profile (no stored trust or check). I used a scratch clone of MQTT-MCP at qa/clones/v4657-mqtt. On main I committed .codeflow/config.json = {check "echo MAIN-CHECK", setup "echo MAIN-SETUP", trust safe, prove false, limits.maxSteps 7}. Branch qa-alt (commit 1cde052) changes it to {check "echo ALT-BRANCH-CHECK", setup "echo ALT-SETUP", trust standard, prove true, maxSteps 33}, and main stays checked out. I added the clone through the UI (Open another repository > Create project "v4657 MQTT").
(1) UI flow, script work/v4657/r1.mjs: opened Run options, Start from branch > qa-alt, picked the Fix & review workflow and sent. Before and after choosing qa-alt the composer still showed check "echo MAIN-CHECK", setup "echo MAIN-SETUP", the note "Using .codeflow/config.json: check "echo MAIN-CHECK" · setup "echo MAIN-SETUP" · safe permissions" and Safe permissions (screenshot shots/v4657/002-composer-qa-alt.png). Run 2610251818-6d3eba92 got baseLabel qa-alt and baseRef 1cde052, but loop.check "echo MAIN-CHECK", loop.setup "echo MAIN-SETUP", prove false and trust safe. Its build worktree .worktrees/<id>/build/.codeflow/config.json held qa-alt's ALT-BRANCH-CHECK config, yet the run ran MAIN-SETUP and MAIN-CHECK. prove is never sent by the composer, so this part is engine-side.
(2) Engine path with nothing explicit: POST /api/runs with baseRef "qa-alt", loop {} and no trust. Run 2610251819-6a881680 got baseRef 1cde052 with check MAIN-CHECK, setup MAIN-SETUP, maxSteps 7, prove false and trust safe. Every default came from the checkout's file, none from the base commit.
No console or 5xx errors. Cleanup: I deleted both runs through the UI bulk Delete (it keeps branches and worktrees by design), stopped server v4657 and removed the scratch clone and its bare repo. Nothing is left over.
Why it is not by design: docs/configuration.md says "Commit .codeflow/config.json and every run in that repo ... gets the same defaults". docs/getting-started.md says the base branch is "the starting point for every worktree" and "Uncommitted changes in your checkout aren't included". No doc or comment says repo defaults come from the checkout rather than the base. The code is also inconsistent with itself: the Run app command (src/app-command.ts:7 via server.ts:2630/2637, appCommand(wt.path)) already reads the config from the run's worktree, i.e. the base commit. The reporter's tester environment does not explain it: I reproduced i …

</details>

### t02-9 · minor · A saved draft restores a base branch that no longer exists; Send stays enabled and fails with 400

**Fix outcome: fixed.** ui/state.ts dropMissingBase() runs after restoreComposer in switchComposer and initializeProjectDrafts. It resets a saved start branch that is no longer among the repository's branches to '' and sets baseNotice ('Branch “X” no longer exists, so this draft starts from the current branch.'). A retry's pinned commit is kept (rerunDraft.baseRef). The composer shows the notice as a status message with Dismiss; picking a branch or opening another draft clears it. rememberBase()/knownBase() never store a commit as the remembered base. The test/project-drafts.test.ts fixture now lists feature/a among the branches (see notes).

Fixer's check: s4.mjs on f09. After choosing qa-gone, deleting the branch and reloading, the picker showed 'Current branch · main' with the notice, and Send went through with baseRef '' (201). Base showed qa-gone with Send enabled and got a 400. The same happened when switching projects and back in the same tab. localStorage baseRef was ''.

Tests: `test/qa-composer-draft-config.test.ts`, `test/e2e/qa-composer-draft-config.e2e.ts`

Source: tester unit composer-run-options-1; observed with fake-agents; features CMP-10.

**Repro**

> 1. In the composer pick 'Start from branch' = a local branch (e.g. qa-local2) and type a task.
> 2. Delete that branch in the repo (git branch -D qa-local2).
> 3. Reload the app.
> 4. The picker still shows 'qa-local2', the summary shows '· qa-local2', and Send is enabled. Click Send.

**Expected:** The missing ref resets to the current branch (setRepo already does this), or Send is blocked with a clear reason.

**Actual:** Send fails with 'Base branch "qa-local2" not found in <repo>'. The stale ref also survives a successful run (localStorage baseRef) and returns on the next draft. 'Edit & run again' likewise leaves a raw SHA as the sticky base afterwards.

**Root cause (verifier):** The draft restore writes the saved base after the repository check has run, and nothing checks it again before Send.

- ui/state.ts:202: setRepo clears baseRef when it is not in info.branches, unless a rerun draft is active (sameRetry). It only sees the value baseRef has at that moment.
- ui/state.ts:1330-1331 (initializeProjectDrafts) and ui/state.ts:1276/1279 (switchComposer) call `await setRepo(repository)` first and `restoreComposer(saved)` second.
- ui/state.ts:1235: restoreComposer does `baseRef.value = snapshot.base` with no check, so the draft's stale branch replaces the cleared value. This happens on every reload and every project switch.
- ui/composer.tsx:712: WorktreeBranchPicker adds any unknown baseRef as an extra selectable option (meant for pinned commits), so the stale branch looks valid and has no warning.
- ui/composer.tsx:544-571: startProblem never checks baseRef, so Send stays enabled until the server rejects it at src/engine.ts:5167 ("Base branch \"…\" not found in …"), which becomes the 400.

Secondary:
- ui/run.tsx:2293: editAndRerun sets `baseRef.value = run.baseRef`, which is the resolved 40-character SHA even when the run started from HEAD.
- ui/composer. …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-drafts.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/repo-selection-ui.test.ts`

**Suggested fix:** 1. Pull the setRepo:202 check into one helper in ui/state.ts, e.g. `validBase(ref, info, retry)`. It should keep "", any name in info.branches, and a full 40-hex SHA only while a rerun draft is active. Call it right after restoreComposer in both initializeProjectDrafts (state.ts:1331) and switchComposer (state.ts:1279). This also fixes saved project defaults (applyDefaults), which bypass the same check.
2. When the helper drops a stale branch, say so: reset baseRef to "" and show a short notice in the composer, e.g. 'Branch "qa-gone" no longer exists; starting from the current branch.'
   - Alternative that never changes the user's choice silently: add a startProblem rule (composer.tsx:544) that blocks Send with 'Start branch "X" no longer exists. Choose another branch.' when baseRef is set, missing from repoInfo.branches, and is not a rerun-pinned commit.
   - Either way, drop the `...(baseRef && !info.branches.some(...))` extra option at composer.tsx:712 unless the ref is a rerun pin …

**Suggested regression test:** 1. test/project-drafts.test.ts, new case:
   - Mock /api/branches with branches [main, feature/a]. openComposer("a"), set baseRef "feature/a", save, then openComposer("b").
   - Change the mock so /api/branches returns only [main], then openComposer("a").
   - Assert `state.baseRef.value === ""`, or, if the blocking variant is chosen, that `startProblem(...)` matches /no longer exists/.
   - Repeat through initializeProjectDrafts() in a fresh import to cover the reload path.
2. test/repo-selecti …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server (name v4609-t029, port 4609, new home), a fresh Playwright profile and a scratch clone of MQTT-MCP (bare and working copy under qa/clones/v4609-mqtt*). Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4609-t029/ (a3, a4, a5, a6b, a9) and screenshots are in .../qa/shots/v4609-t029/.

1. Main bug, after a reload (a3 then a4):
   - In the composer I chose "Open another repository" and picked the clone, which created project v4609-mqtt.
   - I set "Start from branch" to qa-gone (a local branch I had created), typed a task and waited for the draft to autosave.
   - I ran `git branch -D qa-gone` in the clone and opened the app again in the same profile.
   - The picker still shows "qa-gone" with a checkmark, listed as an extra option above the real branches. The summary reads "Repository v4609-mqtt · qa-gone", Send is enabled and no composer problem is shown.
   - Clicking Send sent POST /api/runs with baseRef "qa-gone". The server returned 400 `{"error":"Base branch \"qa-gone\" not found in <clone path>"}`, shown as red text under Run options (002-missing-ref-send.png). The message is clear, and choosing "Current branch" recovers.

2. Same bug without a reload (a9):
   - I picked qa-gone2 and typed a task, switched the composer to the MQTT-MCP project, deleted qa-gone2, then switched back.
   - The picker still shows qa-gone2 and Send is enabled. setRepo re-fetched the branch list, but the draft restore ran afterwards and put the stale value back.

3. "Edit & run again" leaves a pinned SHA (a6b):
   - The original fix-review run started from Current branch: baseRef "" with baseLabel HEAD.
   - "Edit & run again" filled the composer with base 2b97323ce7d2e39b1ce680817117c82e7a8a6acf. I sent it (201).
   - Afterwards localStorage had baseRef set to that SHA. The next New-run draft in the same project still showed the raw SHA in the picker and summary, and it was still there after a reload. Later runs in that project would quietly start from the old commit.

I did not run the reporter's PR-source variant (s14). By the code, resetComposer persists whatever baseRef is set, so it would behave the same way.

Refutation checks:
- docs/getting-started.md:152 says the base defaults to HEAD and the picker lists existing branches. Nothing documents keeping a deleted branch.
- setRepo (ui/state.ts:202) clears a base that is not in the branch list, so t …

</details>

### t06-3 · major · Edit & run again silently overwrites the project's unsent composer draft

**Fix outcome: fixed.** ui/run.tsx editAndRerun now checks the run's project draft before switching the composer, using the new ui/state.ts unsentDraft(project): the live draft if it is the current one, otherwise the stored one. If it holds work (task text, attachments, criteria, or context/source on a non-retry draft), editAndRerun asks with the app's confirm dialog: 'Replace your unsent draft?', with Cancel focused and a 'Replace draft' button. Cancel or Escape stays on the run and leaves the draft untouched. An untouched Edit & run again draft (the task equals the retry's original task, which rerunDraft now carries) is replaced without asking. docs/getting-started.md updated.

Fixer's check: s5.mjs and s7.mjs on f09. After typing 'MY UNSENT DRAFT 123', Edit & run again showed the confirmation naming the draft. Cancel stayed on #/run/<id>, and the composer still held the text afterwards. Replace draft loaded the run's task. Cross-project case: Alpha's stored draft was protected while Beta's draft was on screen, and both survived an Escape (focus went back to 'More run actions'). A second Edit & run again over an untouched retry draft did not ask. On base the draft was silently lost. The errors array was empty.

Tests: `test/qa-composer-draft-config.test.ts`, `test/e2e/qa-composer-draft-config.e2e.ts`

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-04.

**Repro**

> 1. Open the composer for project 't06 Studio' and type 'MY UNSENT DRAFT 123' (don't send). 2. Open a finished run in the same project → More run actions → Edit & run again. 3. Look for the draft (composer, Projects dialog, Unassigned draft).

**Expected:** A warning/confirmation before replacing a non-empty draft, or the draft kept recoverable.

**Actual:** Composer now holds the run's task; the typed draft is gone everywhere (Unassigned draft is empty). Reproduced with 'SECOND DRAFT 456' from another run.

**Root cause (verifier):** The cause is in ui/run.tsx `editAndRerun`, lines 2267-2325.

- Line 2276 calls `await openComposer(destination?.id ?? "", { repository: run.repo, stay: true })`.
- Because `options.repository` is set, ui/state.ts:1260 never takes its same-project shortcut, and `switchComposer` runs every time.
- ui/state.ts:1266 (`saveComposerDraft()`) writes the on-screen draft into its project's slot.
- ui/state.ts:1270 (`draftStore.read(next)`) loads the run's project's saved draft into the composer: the user's unsent text, or another project's stored draft.
- Back in editAndRerun, without checking whether that draft has content, the code overwrites every composer field:
  - line 2278: `rerunDraft`
  - 2279-2287: run options
  - 2297: `setPattern`
  - 2302: `setTask(run.task)`
  - 2303-2306: `contextPaths`, and `attachments = []`
  - 2306-2309: check, setup and limits
  - plus source and baseRef
- The autosave effect at ui/state.ts:1340-1343 (`void draftStore.write(id, snapshot)`) then immediately persists this to the same `project-draft-v1:<projectId>` key in IndexedDB.
- `ProjectDraftStore` (ui/project-context.ts:25) keeps one slot per project and no history.
- No confirm, no backup key and no …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-context.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/getting-started.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ui-review.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/daily-workflow.e2e.ts`

**Suggested fix:** In `editAndRerun`, after `openComposer` resolves and before any field is assigned (between ui/run.tsx:2277 and :2278), check whether the loaded draft has user content. Count it as content if any of these is set:
- `task.value.trim()`
- `attachments.value.length`
- `contextPaths.value.size`
- `acceptanceCriteria.value.length`
- `source.value` or `externalSource.value`

A draft that is just another rerun of the same run (`rerunDraft.value?.id === run.id` with an unedited task) does not count.

If there is content, either:
- (a) ask first, using the app's in-UI confirm pattern (like the team plan's "Your draft is kept… Replace draft"). Offer "Replace draft", "Cancel", and possibly "Open draft". On Cancel, stay on the run. Or
- (b) don't block, but keep the draft recoverable: add an exported helper in state.ts, e.g. `stashComposerDraft(project, label)`. It writes the current `composerSnapshot()` to a separate `draftStore` key, such as `<projectId>:before-rerun` or a small ring of recent re …

**Suggested regression test:** 1. Unit test in test/ui-review.test.ts. The harness falls back to the localStorage stand-in when there's no IndexedDB.
   - Export `setTask`, `task`, `saveComposerDraft` and `composerProject` from state.ts in the bundle stub.
   - Call `initializeProjectDrafts()`, then `setTask("MY UNSENT DRAFT")` and `await saveComposerDraft()`.
   - Call `editAndRerun({ id: "r2", repo: m.repo.value, task: "Run task", ... })` with a run in the same (unassigned) project.
   - With the backup approach: assert tha …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this myself on a fresh fake-mode server with a new home: qa-server.sh start v4641t 4641 fake. I made two scratch git repos (clones/v4641-draft and clones/v4641-draft2) and added them as projects "v4641 Alpha" (p-5e1c7948) and "v4641 Beta" (p-11f8daa1). Then I created a solo Claude run in Alpha with checkpointOnFinish:true, task "ORIGINAL RUN TASK B: add a hello file", and waited for status done. I used the API only to set up these preconditions.

Edit & run again is only in the header menu when a run is not chat-mode. A solo run without checkpointOnFinish shows no "More run actions" button at all (ui/run.tsx:196 and :251), so my first attempt timed out and I had to create the checkpointed run.

Scenario 1, same project (script work/v4641t/repro1.mjs, persistent Chrome profile v4641t):
- Opened #/project/p-5e1c7948/new, clicked the Task textbox and typed "MY UNSENT DRAFT 123 - notes I was writing" with the keyboard.
- After a reload the text was still there. IndexedDB codeflow-project-drafts held key project-draft-v1:p-5e1c7948 with that task.
- Opened #/run/<id> → More run actions → Edit & run again.
- Result: the URL went to #/project/p-5e1c7948/new and the Task box read "ORIGINAL RUN TASK B: add a hello file".
- No native confirm dialog, no toast or alert, and no undo control. Screenshot: shots/v4641t/001-after-rerun.png.
- In IndexedDB, project-draft-v1:p-5e1c7948 now held the run's task with rerun id set. The legacy-backup and unassigned ("project-draft-v1:") entries were empty.
- The page body no longer contained the draft text. After a reload it was still the run's task, and #/new/unassigned had an empty task.

Scenario 2, cross-project (repro2.mjs, fresh profile v4641t2):
- Typed "ALPHA DRAFT 456" into Alpha's composer, then "BETA DRAFT 789" into Beta's, leaving the composer on Beta.
- Ran Edit & run again on Alpha's run.
- Result: Alpha's stored draft was overwritten by the run's task, again with no prompt. Beta's draft survived.
- So the lost draft does not even have to be on screen: whatever is saved in the run's project is silently replaced. Going Back in the browser does not restore it.

No console errors and no 5xx responses in either scenario.

Why it is not by design or a tester artifact:
- The reporter's selectors and profile were fine, and I got the same result with real keyboard input in a fresh home and profile.
- docs/getting-started.md:95 says Edit & run again restores the run "into an editable draft" but never says it rep …

</details>

### t06-4 · minor · Rerun state leaks into the next unrelated run: parent link, restored loop and a pinned old base SHA

**Fix outcome: fixed.** editAndRerun no longer saves the run's values as browser defaults. It used setTrust/setLimits, which stored the run's trust (for example 'full') and its limits in localStorage for every later draft. It now sets them as draft choices with origin RERUN_ORIGIN, including check and setup through setRunCheck/setRunSetup, and records the pinned baseRef in rerunDraft. resetComposer (ui/composer.tsx), run after a send: when the sent draft was a retry and its base is not a branch, it resets the base to the current branch. rememberBase() stores only a branch or ''. Draft check/setup/limits choices are dropped, along with the trust choice when it came from the retry, so the next run derives its defaults again. The parent link and restored loop still apply to the retry itself, by design (docs/getting-started.md, daily-workflow e2e).

Fixer's check: s5.mjs on f09: Edit & run again of a full-access 33/44 run sent parent, the pinned SHA, trust full and 33/44 (as designed). Then main moved on and the page was reloaded. The picker showed 'Current branch · main' and localStorage held only baseRef '', with no trust or limits keys. Run details read 'standard | Application default' and '240 minutes · 200 steps'. The next run's body had parentRunId undefined, baseRef '', trust standard and 240/200. On base it showed the SHA, trust full and 33/44 sticky in localStorage, and the later run started from the old commit. The existing daily-workflow Edit & run again e2e tests still pass.

Tests: `test/ui-review.test.ts`, `test/qa-composer-draft-config.test.ts`, `test/e2e/qa-composer-draft-config.e2e.ts`

Source: tester unit run-workspace-1; observed with fake-agents; features RUN-04, RUN-05.

**Repro**

> 1. Run A (fix-review) → More run actions → Edit & run again. 2. Replace the task with an unrelated one and switch workflow to Agent (or Plan → Build → Review). 3. Send. 4. Later start more runs in the same project from the composer.

**Expected:** Changing the task/workflow starts a fresh run (no parent), starting from the current branch as before.

**Actual:** The new run gets parentRunId = the old run and shows '↩ previous conversation' (chat 2610251429-7fe57960 → run A; run E 2610251427-138f2ac9 → run C, also inheriting Full access + README context), and its base is the old run's full SHA (baseLabel 'd7a7d0e1386b…'). The 'Start from branch' select keeps that raw 40-char SHA, so every later run in the project (P 2610251440-8eb91f03, AG2 2610251522-dc458e43) also starts from the pinned old commit — stale code once main moves.

**Root cause (verifier):** This is an interaction between the rerun base pin added in PR #42 and the older composer reset, which remembers the last base.
- ui/run.tsx:2293, in editAndRerun: `baseRef.value = run.baseRef ?? "";` puts the original run's resolved commit SHA into the shared composer signal. That pin is meant for this one rerun, but nothing records that the rerun set it.
- ui/composer.tsx:258-261, in resetComposer after a successful send: `rerunDraft.value = null; store.set("baseRef", baseRef.value);`. The rerun identity is cleared, but the pinned SHA is kept in the signal and saved as the global "baseRef" preference in localStorage, the same way a branch the user picked is remembered. saveComposerDraft (composer.tsx:249, via composerSnapshot at ui/state.ts:1202 `base: baseRef.value`) also writes it into the project's IndexedDB draft.
- ui/state.ts:202: the only check that drops a base not in `info.branches` is skipped for a same-repository retry. ui/state.ts:1235, in restoreComposer, then writes `snapshot.base` back after setRepo, so the SHA survives reloads and project switches.
- ui/composer.tsx:712 (WorktreeBranchPicker) shows a base that is not a branch as its own option, so the raw 40-charac …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rerun-draft.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/daily-workflow.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ui-review.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/getting-started.md`

**Suggested fix:** 1. Make the rerun's base pin belong to the rerun draft. Add `baseRef` (the pinned commit) to the rerunDraft shape in ui/rerun-draft.ts and set it in editAndRerun (ui/run.tsx:2278).
2. In resetComposer (ui/composer.tsx:258-261), check what was sent:
   - If the sent run was a rerun and baseRef.value still equals restored.baseRef, set baseRef.value back to the remembered user branch, or "" for the current branch, and do not call store.set("baseRef") with the SHA.
   - More generally, only save baseRef to the store when it names a branch in repoInfo.value.branches (or is ""), never a bare commit SHA.
3. In restoreComposer or switchComposer (ui/state.ts:1235 / 1279-1293), when the restored draft has no rerun, drop a `base` that is not a known branch. This cleans up drafts and localStorage already polluted by this bug.
4. Optional UX: show a "Rerun of ‹task› · base ‹sha7›" chip in the composer while rerunDraft is active, with a "Start fresh" action. It would clear rerunDraft, the pinned bas …

**Suggested regression test:** E2E: extend the test "edit and run again preserves pinned inputs…" in test/e2e/daily-workflow.e2e.ts, after its retried run finishes:
- Click "New run" and assert that `.task-branch` shows "Current branch" rather than saved.baseRef.
- Assert that `localStorage` "baseRef" is not saved.baseRef.
- Fill a new task, capture the next POST /api/runs and assert `body.baseRef === ""` and `body.parentRunId === undefined`.
- Reload the page and assert again that the branch picker shows "Current branch".

U …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this on a fresh fake-mode QA server, v4643 on port 4643, using browser profile v4643-t064 and a scratch clone of MQTT-MCP added through "Open another repository" as project "v4643 MQTT".
1. Started run A 2610251919-c4d6995b from the composer with the fix-review workflow and check "true". Its baseRef was 2b97323ce7d2…, baseLabel was "HEAD", and it finished done. Opening New run again showed "Start from branch: Current branch · main". This is the control: an ordinary send does not pin the base.
2. On run A, used More run actions → Edit & run again. The composer showed the old task, "Start from branch: 2b97323ce7d2e39b1ce680817117c82e7a8a6acf" and "Repository v4643-mqtt · 2b97323…". I replaced the task with "Unrelated new task X: explain the repo layout", switched the workflow to "Plan → Build → Review" and clicked Start run. The POST /api/runs body had parentRunId=2610251919-c4d6995b, baseRef=2b97323… and loop keys maxSteps, maxMinutes, checkTimeoutMin, check, setup, verification and copy. Run B 2610251919-32718d9a has that parentRunId and baseLabel set to the 40-character SHA, and its thread shows "↩ previous conversation".
3. Advanced main in the scratch clone to a4614ef.
4. Reloaded the app and clicked New run. The composer still showed "Start from branch: 2b97323ce7d2e39b1ce680817117c82e7a8a6acf" (screenshot qa/shots/v4643/001-C-later-composer.png), and localStorage held baseRef=2b97323…. I sent the unrelated task "later run C". Its POST had parentRunId undefined and baseRef 2b97323…. Run C 2610251920-a2d60edc has baseRef and baseLabel 2b97323…. `git merge-base --is-ancestor a4614ef codeflow/2610251920-a2d60edc/build` fails, and QA_MAIN_MOVED.txt is missing from its worktree, so C started from stale code. After C was sent the composer still showed the pinned SHA.
5. The pin stays inside its project: another project's composer did not show it. It lives in that browser's localStorage and IndexedDB, so a fresh browser profile would not show it.

Not reproduced, and by design:
- The parent link and restored loop on the rerun itself are intended. docs/getting-started.md:95 says Edit & run again restores "the task, original base commit … into an editable draft" and "retains the original run's source restrictions". test/e2e/daily-workflow.e2e.ts:234-239 asserts the same baseRef and parentRunId.
- rerunDraft is cleared at send, so later runs got no parent (run C has no parentRunId).
- The reporter's "chat → run A" case is an Edit & run again draft t …

</details>
