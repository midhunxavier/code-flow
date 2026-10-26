# Cluster 01 · insights-cleanup

**Insights 'Clean up' safety: NaN days, force-removal, shared chat guard, leftover folders**

Status: **merged · verified · repair round 1 merged** · 13 issues · branch `qa-fix/insights-cleanup` (+ `qa-fix/insights-cleanup-r1`)

Planner notes: Everything is in src/server.ts cleanUp() (~2898) and the POST /api/cleanup handler (~1971), plus the Days input in ui/insights.tsx. cleanUp calls ship.removeWorktrees (--force) directly, which skips RunManager.archive's guards (shared chat workspace, dirty or locked worktrees). Send cleanup through the same guarded path or reuse its checks, skip dirty/locked worktrees and report them. Validate olderThanDays as a finite non-negative number and return 400 otherwise. Canonicalize body.repo the way GET /api/disk does (S14-4). Remove .worktrees/<run>/.context folders the way archive's tidyRunFolder does (t17-17/t18-20). Tell the user that cleaned runs are archived (S13-1). RunManager.archive itself belongs to run-worktree-lifecycle; coordinate with it if you need tidyRunFolder exported. Duplicate groups: [["t18-1","t18-2","S10-4"],["t18-3","S10-3","S12-1","S14-3"],["t18-16","S12-5"],["t17-17","t18-20"]]

Likely files: `src/server.ts`, `ui/insights.tsx`, `src/engine.ts`, `src/ship.ts`

## Fix result

Commits:
- `d0991584` Keep unsaved work and shared chat workspaces when cleaning up worktrees
- `9e0b5a3e` Reject a malformed clean-up age or scope instead of widening it
- `1f643f17` Validate the Clean up days and say what it archives and keeps

Fixer notes for the integrator: Coordination with run-worktree-lifecycle:
- I did not modify RunManager.archive() or tidyRunFolder(). I only call tidyRunFolder(run, false) from the new RunManager.cleanUp, so their planned t08-15 change (tidy only worktrees inside the run's own folder) composes cleanly.
- The shared-workspace predicate is duplicated, not shared. Archive's inline guard stays; mine is the private sharesChatWorkspace(), which also includes taskExecution owners and any other run using the same worktree path. That avoids a conflict with their edits to the guard line. Once both land, archive() could call sharesChatWorkspace().
- Their t17-4 (scoped `git worktree prune`) still applies: removeWorktrees keeps its global prune, and Clean up skips removeWorktrees when a run has no live worktrees.

Shared-file edits, all additive:
- src/ship.ts: new export unsavedWork, and removeWorktrees takes an optional 4th arg { keepUnsaved }. Existing callers are unchanged.
- ui/styles.css: one rule, `.ins-section > .help.ins-kept`.

Intentional behaviour changes:
- POST /api/cleanup is stricter. The string olderThanDays "7" is now a 400, where it used to be accepted; the UI sends numbers and the endpoint is undocumented in docs/api.md.
- The response shape grew to { runs, worktrees, archived, folders, kept: [{ id, task, reason }] }.
- Clean up does not purge private run memory, unlike Archive with cleanup: a resume may need it, and it takes negligible disk.

Not changed, sibling path: engine toInbox() (~5657), the …

## Independent verification

- **t18-1: verified** — Note: the diff command in the task (86d7f94 against itself) is empty. I reviewed the cluster's two real merges instead: 4c29ded (qa-fix/insights-cleanup) and d524e0a (qa-fix/insights-cleanup-r1). Setup: fresh fake server v01 on port 4345 with a fresh home (an older v01 home was moved aside first). I made a scratch repo and added it through the UI with 'Open another repository' and a new project. Through the API I started 10 runs and opened 9 of them in the browser so they counted as seen; one stayed unseen as a control. The 9 seen runs were: a solo chat that left `?? claude-8e5fc455.txt`; a fix-review run where I appended to README.md and created user-notes.txt; a fix-review run locked with  …
- **t18-3: verified** — I sent POST /api/cleanup with raw bodies while 9 seen, finished runs were eligible. These returned 400 'olderThanDays must be a number of days, 0 or more': "abc", "x7", "seven", "7", "", {}, [], -1, -0.5, true, 1e999 (Infinity), and 1e305 (an overflowing cutoff, caught by the cleanUp() isFinite guard). project 123 and project ['x'] returned 400 'project must be a project id'. repo 123 and 'not-a-path' returned 400 'Repository must be an absolute path'. '/nonexistent/dir' returned 400 'Not a git repository'. Bodies of null, [], "str" and not-JSON returned 400 'Invalid JSON object'. The controls {olderThanDays:7}, {} and {olderThanDays:null} returned 200 with {runs:0,…,kept:[]}. The `git workt …
- **t18-16: verified** — In the Insights → Disk Days field I used Playwright fill. For -3, '' (empty), 400, 1.5 and 366, the field keeps what was typed, aria-invalid=true, an alert reads 'Enter a whole number of days from 0 to 365', and Clean up is disabled. '007' and '365' are accepted. With real keyboard input: Select-all then Backspace leaves the field empty (it no longer snaps to 0) and disabled. Typing -3 shows -3, disabled. Typing '0-3' (badInput) leaves it disabled. ArrowDown from 0 stays at 0. A forced click on the disabled button opened no dialog. No /api/cleanup request was sent for any invalid value: the only requests posted were {olderThanDays:7} and {olderThanDays:0}. Confirm texts: for 1 it says 'runs  …
- **t17-17: verified** — After the UI Clean up at 0 days, the folders of both clean fix-review runs are gone. In .worktrees/2610260403-57c99223 that includes the 1 MB .base-check scratch checkout, which is also no longer in `git worktree list`. Both run logs read 'Cleaned up: removed 1 worktree(s) and archived the run; branches kept; removed the run's folder'. The Disk table re-measured on its own and went from 10 runs to 8, so the cleaned runs dropped out. Solo chats keep .context while their branches are kept, which is by design per docs/runs.md:137. Variation (the leftover from the old code): I archived a fix-review run with cleanup:false, ran `git worktree remove --force` on its worktree by hand and added a .rep …
- **S13-1: verified** — Archiving is now stated everywhere. The confirm says 'Remove the worktrees of all finished runs that need nothing from you, and archive those runs? Branches are kept… Runs with uncommitted changes, a locked worktree or a workspace shared with other chats are left as they are.' The toast says 'Removed 2 worktree(s) from 2 run(s) and archived them; …'. The API response includes `archived` (1 for each scoped clean). The run log says 'Cleaned up: removed 1 worktree(s) and archived the run; branches kept; …'. docs/runs.md:136 says Clean up '…and archives those runs'. When a run was already archived, the log leaves out 'and archived the run' (the legacy case logged only 'removed the run's folder') …
- **S14-4: verified** — For each spelling I created a fresh seen, finished run in the scratch repo R, checked that GET /api/disk?repo=<spelling> listed it, then sent POST /api/cleanup {olderThanDays:0, repo:<spelling>}. The spellings were R/sub, the /tmp alias of /private/tmp R, R/ with a trailing slash, a symlink to R, and R itself. Each one returned runs:1, worktrees:1, archived:1, and the run was archived with its worktree gone. The trailing-slash run first showed runs:0, but that was because my POST /seen raced the run finishing (seen=false). After it was seen again, it cleaned with runs:1. A seen run in a second repo/project (repo2) stayed untouched through all R-scoped clean-ups. It was cleaned only by a proj …

Code-review findings:
- [nit] `src/engine.ts:3772` RunManager.cleanUp treats a partial removal as a success. If a run has several worktrees and removeWorktrees(…, {keepUnsaved:true}) removes some but refuses others (the under-lock re-check sees new unsaved work, or git fails on one), the code only reverts when result.removed.length is 0. The run is archived and counted in runs/worktrees, the toast says it was cleaned, and it is missing from `kept`. The leftover worktree shows up only as a warn line in the run log. This is a race or failure path only; I could not reach it with single-worktree runs. Related: workspace-stop and devServers.stopMat …
- [nit] `docs/runs.md:136` The docs say Clean up 'never loses work the branches don't hold'. But unsavedIn (src/ship.ts ~441) deliberately ignores gitignored files, and `git worktree remove --force` deletes them. A file the user created or edited in a run's worktree under an ignored path (a local .env change, a local DB, notes in an ignored folder) is removed without warning. The code comment explains the choice; the user-facing docs overclaim.

Repair round 1: 2 commit(s), items review-1:fixed, review-2:fixed; merged: yes; re-verify: t18-1:verified, t18-3:verified, t18-16:verified, t17-17:verified, S13-1:verified, S14-4:verified

## Issues

### t18-1 · major · Insights 'Clean up' force-removes worktrees with uncommitted work (solo chat output, user edits) and locked worktrees, while promising nothing is lost

**Fix outcome: fixed.** Root cause confirmed: server.ts cleanUp() called ship.removeWorktrees directly, which runs `git worktree remove --force` and then `--force --force` (overriding locks), with no dirty, lock, busy or shared-workspace check. Fix: new RunManager.cleanUp(id) (src/engine.ts:3720) is the per-run Clean up path. It skips a run that's working (busyRun, active or coldMutations). It skips one sharing a chat workspace (private sharesChatWorkspace at src/engine.ts:3764: the archive() predicate plus taskExecution owners and any other run that uses one of this run's worktree paths). It skips a run whose worktree has unsaved work, using the new ship.unsavedWork (src/ship.ts:432): `status --porcelain --untracked-files=all --ignore-submodules=none`, assume-unchanged/skip-worktree flags from `ls-files -v`, and the worktree's `locked` file. Skipped runs are reported in `kept` with the reason. Otherwise it arc …

Fixer's check: QA server f01 (fake, from the worktree, port 4341) with a scratch git repo added through 'Open repository'. I reproduced the tester's b01/b02 setup (work/insights-cleanup/r01-setup.mjs, r02-cleanup.mjs, r02.log): a solo chat with its uncommitted claude-*.txt, a fix-review run with a README edit, a fix-review run with `git worktree lock`, a clean solo run, and a clean fix-review run with a .base-check scratch checkout, all opened so they were seen. Then Insights → Disk, Days 0, Clean up, Remove worktrees. Toast: 'Removed 2 worktree(s) from 2 run(s) and archived them; kept 5 run(s) as they are (see below)'. The kept table listed 'solo has uncommitted changes', 'build has uncommitted changes' a …

Tests: `test/qa-insights-cleanup.test.ts`, `test/qa-insights-cleanup-api.test.ts`, `test/e2e/qa-insights-cleanup.e2e.ts`

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-24, GIT-21.

**Repro**

> 1. Fresh fake QA server; add a scratch clone of MQTT-MCP as a project.
> 2. Start an Agent (solo) run, e.g. 'Solo chat with uncommitted work'. Chat mode leaves its output uncommitted in the worktree (`?? claude-xxxx.txt`). Open the run once so it counts as seen.
> 3. Optional: in another finished run's worktree, edit a tracked file (`echo edit >> README.md`). In a third, run `git worktree lock --reason keep <path>`.
> 4. Insights → Disk: set days to 0 (or wait until the runs are older than the default 7), click Clean up and confirm 'Remove worktrees'.

**Expected:** Worktrees with uncommitted changes or a user lock are skipped or listed for explicit confirmation. The confirm says 'need nothing from you… Branches are kept, so you can still merge or resume them', and Archive at least warns that uncommitted changes are lost.

**Actual:** Toast 'Removed 10 worktree(s) from 10 run(s)'. The solo chat's uncommitted file and the README edit are gone and not on the branch. The locked worktree is removed. The runs are silently archived, and each run log says only 'Cleaned up: removed 1 worktree(s); branches kept'. Reproduced on t18b (b02.log) and again on t18f (f01.log: solo wt 'gone').

**Root cause (verifier):** - src/server.ts:2898-2914 `cleanUp()`: eligibility is checked only on status, endedAt, seen, triage and watches. It never checks the worktree's git state, a git lock, or chatLink/shared-workspace ownership. It then calls `removeWorktrees(r.repo, r.worktrees, false)` and archives the run silently (2911).
- src/ship.ts:448-452 `removeWorktrees()`: runs `git worktree remove --force <path>`. On failure it retries with `--force --force`, which per the code comment exists for "a locked one". This discards uncommitted tracked edits and untracked files, and overrides user locks. No dirty or lock check is done.
- The docstring at server.ts:2893-2897 ("Committed work stays on its branch") shows only committed work was considered. But ui/insights.tsx:357 tells the user the runs "need nothing from you… you can still merge or resume them", and docs/runs.md:136 says the same.

Related, found in passing:
- server.ts:1971: `Math.max(0, Number(body.olderThanDays ?? 7))` turns a non-numeric value into NaN. The cutoff becomes NaN and `r.endedAt > NaN` is always false, so an API call with e.g. "abc" cleans every eligible run regardless of age. The UI clamps to 0, so this is API-only.
- cleanUp also sk …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/ship.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/insights.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** 1. In `cleanUp()` (server.ts), check each worktree before removing it, reusing the same tests as retention-policy.ts:208-213:
   - `git status --porcelain --untracked-files=all --ignore-submodules=none` must be empty;
   - there must be no `locked` or `prunable` field in `git worktree list --porcelain` for that path;
   - there must be no hidden tracked changes (`ls-files -v`).
   Skip any worktree that fails, and skip runs with chatLink, teamTurns or taskExecution, or that own a chatLink workspace (the same guard as engine.ts:3688).
2. Give `removeWorktrees` an option such as `{ force: false }` so Clean up runs `git worktree remove` without --force and never uses the double-force fallback. Archive keeps its explicit, warned force path.
3. Return the skipped runs with reasons, e.g. `{ runs, worktrees, skipped: [{ id, task, reason: "uncommitted changes" | "locked" | "shared chat" }] }`. Show them in the toast/Disk table ("Kept 2 worktrees with uncommitted changes or locks"). Only archiv …

**Suggested regression test:** Add a focused server/engine test, e.g. test/cleanup.test.ts. Use the existing manager/server harness with fake agents. Create three finished, seen runs older than the cutoff:
- (a) a solo run whose worktree has an untracked file;
- (b) a run whose worktree has a modified tracked file;
- (c) a run whose worktree is clean but `git worktree lock`ed;
- plus (d) a clean, unlocked run.

POST /api/cleanup with olderThanDays 0, then assert:
- only (d)'s worktree is removed and archived;
- (a), (b) and ( …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake server "v4603t18" on port 4603 (new home). Fresh scratch clone of MQTT-MCP (bare clone plus working clone, both under qa/clones/v4603t18-mqtt*). Added the clone as project "v4603 MQTT" through the UI (Open another repository, then New project). Started a solo Agent chat from the composer UI ("Solo chat with uncommitted work"). Started two fix-review runs (check "true") through the API as setup. All three finished as done. Opened each run in the browser, so seen=true.

State before clean-up:
- Solo worktree: `git status` showed `?? claude-bc7659ae.txt`, and its branch HEAD was still the base commit 2b97323 (nothing committed).
- Second worktree: I appended a line to the tracked README.md and created user-notes.txt (` M README.md`, `?? user-notes.txt`).
- Third worktree: `git worktree lock --reason "keep: user debugging"` (porcelain showed `locked keep: user debugging`).

Then in the UI: Insights, Disk, Measure worktrees (3.5 MB in 3 runs), Days set to 0, Clean up. The confirm dialog read: "Remove the worktrees of runs that finished more than 0 days ago and need nothing from you? Branches are kept, so you can still merge or resume them." Clicked Remove worktrees. Toast: "Removed 3 worktree(s) from 3 run(s)".

Result:
- All three worktrees are gone, the locked one included, and `git worktree list` shows only main.
- All three runs are archived=true. Each run log has a single info line: "Cleaned up: removed 1 worktree(s); branches kept".
- The solo branch has no claude-bc7659ae.txt, so the chat's whole result is lost.
- The edit branch has neither the README line nor user-notes.txt.
- `git fsck` dangling objects came only from the original repo history ("codex snapshot" commits), so nothing can be recovered.
- No console or 5xx errors.

Scripts and logs: qa/work/v4603/t18-setup.mjs, t18-setup.log, t18-cleanup.mjs, t18-cleanup.log. Screenshots: qa/shots/v4603t18/.

Why it is not by design:
- docs/runs.md:64 says Agent conversations "keep working files without automatically committing". A solo chat's result is therefore normally uncommitted.
- Clean up is documented (docs/runs.md:136) and confirmed in the dialog as touching only runs that "need nothing from you", with merge/resume still possible.
- The project's other bulk-removal path, saved worktree retention (docs/maintenance.md:68; src/retention-policy.ts:208-213), explicitly protects any worktree that is "dirty, untracked, locked…". It removes without --force, and the docs say the old unguarded - …

</details>

### t18-2 · major · Clean up bypasses the shared chat workspace guard and deletes a live chat's workspace

**Fix outcome: duplicate.** Fixed by t18-1's change, with nothing extra needed. RunManager.cleanUp skips a run with chatLink, teamTurns or taskExecution, a run that owns a chatLink or taskExecution workspace, and any run whose worktree path another run also uses. The workspace is kept whichever tab Clean up reaches first, and neither run is archived. The check runs against the manager-wide run index, not the project- or repo-filtered list.

Fixer's check: Repro on f01: owner solo chat plus a provider-chat tab sharing its worktree, both seen, both with uncommitted chat files. Insights Clean up with 0 days kept both ('its workspace is shared with other chats'). The shared worktree and both files remained and both runs stayed unarchived. A follow-up sent to the tab afterwards (POST /followups) returned 200 and finished 'done' in the same workspace (work/insights-cleanup/r05.log). The tester's run instead got 'The shared workspace is no longer attached'. Covered by the 'chats sharing a workspace keep it' test in test/qa-insights-cleanup.test.ts, which runs both orders, with and without unsaved files.

Tests: `test/qa-insights-cleanup.test.ts`

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-24, GIT-21.

**Repro**

> 1. Fake server: start an Agent (solo) chat A and let it finish (uncommitted output).
> 2. Switch provider in the chat (POST /api/runs/A/provider-chat), creating a second tab that shares A's worktree. Open both (seen).
> 3. Archive A with cleanup → server answers 'Shared chat workspace retained' (guarded). Unarchive A.
> 4. Insights → Clean up with 0 days (API: POST /api/cleanup {olderThanDays:0}).

**Expected:** Cleanup applies the same guard as archive (chatLink / taskExecution / owner of a shared workspace) and keeps the shared workspace.

**Actual:** {runs:1, worktrees:1}: the tab run is archived and the shared worktree is removed, with both uncommitted chat files. Owner chat A stays unarchived and active, but its workspace is gone.

**Root cause (verifier):** src/server.ts:2898-2915 `cleanUp()` only skips runs that are running, unfinished, too recent, unseen, pending triage or watching a PR. It does not apply the shared-workspace guard that `RunManager.archive()` applies at src/engine.ts:3688-3691 (`run.chatLink || run.teamTurns?.length || run.taskExecution || allSummaries().some(o => o.chatLink?.workspaceId === run.id)` leads to "Shared chat workspace retained").
A chat tab copies the owner's worktree record into its own `run.worktrees` (src/engine.ts:2178-2183, inside `worktree()` when `run.chatLink` is set). So `removeWorktrees(r.repo, r.worktrees, false)` at server.ts:2907, called for the tab, runs `git worktree remove --force` on the owner's path (src/ship.ts:450-452) and discards every tab's uncommitted files.
`manager.list()` is sorted by compareRuns (engine.ts:3366-3367), so the tab came first here and was archived. When the owner came up, `existsSync` was false, `result.removed` was empty, and the `continue` at server.ts:2910 left the owner unarchived with no log line, still showing "Ready to review". Later follow-ups in the tab fail at engine.ts:2181.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/chat-options.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** Write the guard once and use it from both places.
1. In RunManager (engine.ts), add a public `sharedWorkspaceRetained(runOrId): boolean` method holding the existing predicate: `run.chatLink || run.teamTurns?.length || run.taskExecution || allSummaries().some(o => o.chatLink?.workspaceId === run.id || o.taskExecution?.taskId === run.id || o.taskExecution?.chatId === run.id)`. The extra taskExecution terms match the deleteRun guard at engine.ts:3619. Call it from `archive()`.
2. In server.ts `cleanUp()`, `continue` when `manager.sharedWorkspaceRetained(r)` is true, before calling removeWorktrees. The owner check must use the manager-wide run set, not the project/repo-filtered `all` argument.
3. Defence in depth: before removing, collect the worktree paths of every run that is not being cleaned (or every path claimed by more than one run) and never remove a path in that set. Alternatively, move cleanUp into the engine next to archive() so both share the predicate and the "retained" report …

**Suggested regression test:** Add a test to test/chat-options.test.ts next to the existing "same-provider forks also keep the workspace" case. Fixture: source chat, a provider-chat fork sharing tree.path, and unsaved.txt in the workspace. Mark both runs seen, set endedAt in the past, then run the clean-up path, either an engine-level `manager.cleanUp(0)` after the refactor or POST /api/cleanup {olderThanDays:0} against a test server. Assert:
- readFileSync(join(tree.path, "unsaved.txt")) still returns "Do not lose this"
- ex …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server "v4605t182" on 127.0.0.1:4605 with a new home, using a scratch clone of MQTT-MCP at qa/clones/v4605t182-mqtt. The scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4605t182/ (s1-setup.mjs to s5-teardown.mjs, logs s1.log to s4.log).
1. UI: I opened the clone with "Open another repository" in a new project and sent "Shared workspace owner chat: add a small note file" from the composer. This created owner run 2610252200-e399002a (solo, claude). It finished with an untracked file, claude-55287d90.txt, in .worktrees/2610252200-e399002a/solo.
2. UI: in the owner chat I switched the composer's Provider menu to Codex. The "Fork chat" dialog opened, saying "Chats share the workspace". I sent "Second tab work in shared workspace". This created tab run 2610252201-187d180a with chatLink.workspaceId set to the owner and worktrees[0].path equal to the owner's path. It finished and the shared worktree then held two untracked files: claude-55287d90.txt and codex-136bd395.txt. Opening both runs marked them seen=true.
3. API check of the guard: POST /archive {archived:true, cleanup:true} on the owner returned {"retained":"Shared chat workspace retained"}, and the same call on the tab returned the same. The workspace and both files stayed. I unarchived both.
4. UI: Insights, Disk, Days=0, "Clean up". The confirm dialog said "...Branches are kept, so you can still merge or resume them". I clicked "Remove worktrees" and the toast read "Removed 1 worktree(s) from 1 run(s)".
Result: the tab was archived=true with the log line "Cleaned up: removed 1 worktree(s); branches kept". The owner stayed archived=false with no log entry, and still showed "Ready to review". The shared worktree is gone (git worktree list shows only main). Neither chat file is on branch codeflow/2610252200-e399002a/solo, so both are lost.
5. UI: I unarchived the tab and sent a follow-up. It failed with "Didn't finish – The shared workspace is no longer attached. Restore the original chat workspace first."
Reasons to refute did not hold:
- Not by design: the archive guard's comment in engine.ts says "Chat archival cannot discard another tab's files, including unsaved edits". test/chat-options.test.ts:102-103 asserts unsaved.txt survives archive({cleanup:true}) of a tab. docs/runs.md:64 says agent conversations keep working files without committing.
- Not environmental: I started from a fre …

</details>

### S10-4 · major · cleanUp() calls removeWorktrees() (git worktree remove --force) directly and bypasses the guards in engine.archive(): shared chat workspace check, busyRun, tidyRunFolder, memory purge; setArchived() can throw after the worktrees are already gone; the confirm dialog does not warn that uncommitted changes are lost.

**Fix outcome: duplicate.** Fixed by t18-1's change: RunManager.cleanUp. It covers the shared chat guard, the uncommitted-work guard, and the busy guard (busyRun/active/coldMutations are checked before archiving and again after the async checks). It also runs tidyRunFolder, catches per-run failures so one run no longer aborts the batch with a 500, and changes the confirm text. One deliberate difference from archive(): Clean up does NOT call memoryStore.purgeRun. Private checkpoints are what a resume of an auto-team run may rely on, they take negligible disk, and Clean up promises the runs can still be resumed. The old Clean up kept them too.

Fixer's check: Repro on f01 (work/insights-cleanup/r03-api.mjs, r03.log): run E (fix-review, check 'sleep 6') was seen and clean. I started POST /validate-merge for it and, while /api/health showed it validating, called POST /api/cleanup {olderThanDays:0}. Result: HTTP 200 with E in kept ('it's working') and its worktree still present. The other eligible clean run C in the same batch was cleaned and archived, and the validation later finished 'verified'. The tester got a 500 'Stop the run before archiving it' after E's worktree was gone. The uncommitted-work and shared-workspace parts were verified under t18-1 and t18-2. The folder tidy was verified under t17-17.

Tests: `test/qa-insights-cleanup.test.ts`

Source: code-level suspect at `src/server.ts:2898` (confirmed hands-on).

**Repro**

> Fake server s10, scratch git repo (git init) added via 'Open another repository'. (1) Uncommitted work: solo run A (codex) left untracked codex-b010040d.txt in its worktree, as documented in runs.md ('Agent conversations keep working files without automatically committing'). (2) Shared workspace: solo run B, then a 'Fork chat' tab T (POST /runs/B/provider-chat) whose worktrees[] points at B's worktree; both wrote untracked files there. T was never opened (seen=false). I opened A and B, then in Insights > Disk set days 0 and clicked Clean up > 'Remove worktrees'. The confirm said only 'Branches are kept, so you can still merge or resume them.' The toast said 'Removed 2 worktree(s) from 2 run(s)'. All three untracked files were gone (the branches held only the initial commit). Sending a message in tab T then failed with 'The shared workspace is no longer attached. Restore the original chat workspace first.' (screenshot shots/s10/002-tab-T-after-send.png). (3) Comparison: for owner B2 with tab T2, POST /runs/B2/archive {cleanup:true} returned retained:'Shared chat workspace retained' and kept the worktree. A later POST /api/cleanup then removed that same worktree and both tabs' files. (4) busyRun: run E (checkpointOnFinish, check 'sleep 20') was seen. I clicked Merge… > 'Validate merge result', then ran Insights Clean up (0 days) in a second tab. /api/cleanup returned 500 {"error":"Stop the run before archiving it"} after E's worktree had already been removed. E stayed unarchive …

**Expected:** Bulk clean-up applies the same safety rules as Archive with cleanup. It retains shared chat workspaces and skips busy runs (merge validation, follow-up claims, delivery actions, cold mutations). It never discards uncommitted work silently: it skips such runs or warns as the Archive dialog does ('uncommitted changes in them are lost'). It tidies the run folder and retires private memory. One failure does not abort the whole batch.

**Actual:** Uncommitted agent-conversation work and other tabs' shared workspaces are deleted with git worktree remove --force. A workspace that archive() explicitly retained is deleted anyway. During merge validation the worktree is removed first, then setArchived throws, giving an HTTP 500 with a misleading 'Stop the run' message and a half-processed batch. The confirm dialog promises nothing is lost.

**Root cause (verifier):** cleanUp() in server.ts filters only on status==='running', endedAt, seen, triage and watches. It then calls ship.removeWorktrees(r.repo, r.worktrees, false) directly, which uses --force. It does not call the Manager's guarded archive path (engine.ts:3682-3719): no chatLink/teamTurns/taskExecution/workspace-owner check, no busyRun/active/coldMutations check, no tidyRunFolder or memoryStore.purgeRun. manager.setArchived (which throws for busy runs) runs only after removal, and there is no per-run try/catch. A chat tab's run.worktrees holds the owner's path, so either run can remove the shared folder.

**Suggested fix:** Move clean-up into the Manager: a cleanUpOld(days, scope) that, per run, skips busyRun/active/coldMutations and any run in a shared chat family (chatLink, owner of tabs, teamTurns, taskExecution). It skips runs whose worktree has uncommitted changes (git status --porcelain, including untracked files) unless the user explicitly opted in, archives first (setArchived inside try/catch), then removes worktrees, tidies the folder and purges run memory as archive() does. Collect per-run failures instead of throwing. Change the Insights confirm to name runs with uncommitted changes and say they will be skipped or lost.

**Suggested regression test:** Engine/server tests: (a) solo run with an untracked file, seen, cleanup(0) keeps the worktree and file and reports it as skipped; (b) owner plus chat tab, cleanup(0) keeps the shared worktree (same as archive cleanup:true); (c) cleanup during validateMerge skips the run, returns 200, and other eligible runs are still cleaned; (d) cleanup(0) on an eligible run also removes its .worktrees/<id> folder and retires private memory.

### t18-3 · minor · POST /api/cleanup with a non-numeric olderThanDays cleans every finished run (NaN cutoff) instead of returning 400

**Fix outcome: fixed.** POST /api/cleanup handler (src/server.ts:1969). olderThanDays now defaults to 7 only when it is absent or null. Otherwise it must be a finite JSON number of 0 or more, else the response is 400 'olderThanDays must be a number of days, 0 or more'. Negative values are rejected, not clamped. As a second guard, cleanUp() itself throws a 400 when the computed cutoff isn't finite (src/server.ts:2908). project must be a string, and repo is validated as in t14-4. Note: the string "7" is now rejected; the UI always sends a number.

Fixer's check: On f01 (r03.log): POST /api/cleanup with olderThanDays "abc", "x7", "", "seven", -1, {}, [], "7" and "NaN" each returned 400. Runs and worktrees were unchanged before and after (summary identical). {olderThanDays:7} returned {runs:0,worktrees:0,archived:0,folders:0,kept:[]}. The tester's 'abc' had returned {runs:3,worktrees:3}. test/qa-insights-cleanup-api.test.ts asserts the 400s, that nothing is archived or removed, and that 7 cleans nothing.

Tests: `test/qa-insights-cleanup-api.test.ts`

Source: tester unit git-review-merge-2; observed with api; features GIT-24.

**Repro**

> 1. Fake server with a few finished, seen runs.
> 2. curl -X POST /api/cleanup -d '{"olderThanDays":7}' → {runs:0}.
> 3. curl -X POST /api/cleanup -d '{"olderThanDays":"abc"}'.

**Expected:** 400 'olderThanDays must be a number', or treat it as the default 7.

**Actual:** {runs:3, worktrees:3} on t18f and {runs:2, worktrees:2} on t18b: every finished seen run's worktree is removed (including uncommitted work) and the runs are archived. 'x7' also gives NaN.

**Root cause (verifier):** src/server.ts:1971 has `Math.max(0, Number(body.olderThanDays ?? 7))`. For any non-numeric value ("abc", "x7", {}), Number() returns NaN, and Math.max(0, NaN) is also NaN, so the clamp lets it through.

src/server.ts:2899, in cleanUp, then computes `cutoff = Date.now() - days * 86_400_000`, which is NaN. At src/server.ts:2904 the skip test `r.endedAt > cutoff` is always false against NaN, so the age filter is off. Every finished, seen run with no pending triage and no PR watch then has its worktrees force-removed. That happens through removeWorktrees, src/ship.ts:450 (`git worktree remove --force`), which deletes uncommitted files, and the run is archived (server.ts:2911).

A related gap: an empty string gives Number("") = 0, which is accepted silently and also cleans everything.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`

**Suggested fix:** In the POST /api/cleanup handler (src/server.ts:1969-1971), validate before calling cleanUp:
- If olderThanDays is absent (undefined or null), use 7.
- Otherwise accept only a JSON number, or a non-empty numeric string if lenient parsing is wanted.
- Throw `new HttpError(400, "olderThanDays must be a number of days (0 or more)")` when the value is not Number.isFinite, is negative, or is an empty string. Rejecting negatives is clearer than clamping them to 0. Optionally cap the value at 365 to match the UI.

As a second guard, cleanUp (server.ts:2898) should refuse to run if `!Number.isFinite(days)`, so no future caller can turn the age filter off with NaN. Type-check `body.repo` and `body.project` the same way, so a malformed scope never widens what gets cleaned.

**Suggested regression test:** Add a test to test/server-reliability.test.ts using its existing startServer helper, with fake-bin on PATH and a temporary git repo:
1. Create 2 runs that are finished and seen.
2. POST /api/cleanup with {olderThanDays:"abc"}, then {olderThanDays:"x7"}, then {olderThanDays:""}, then {olderThanDays:-1}. Assert each call returns status 400 with a message mentioning olderThanDays.
3. Assert that after all of these, both runs' worktree paths still exist and `archived` is still false.
4. POST /api/cl …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server v4607 on 127.0.0.1:4607 with a new home. I made a throwaway git repo at scratchpad/qa/clones/v4607-mini (one commit, not a user project) and registered it as project p-42cb5fc4 through POST /api/projects. I started 3 solo fake-claude runs (2610252159-9d13fedb, -a18a4522, -7f34aaca). All three reached status done within seconds, and I marked each one seen with POST /api/runs/:id/seen. I also wrote an uncommitted file, UNCOMMITTED-NOTE.txt, into the first run's worktree. Then I called POST /api/cleanup with each body below, in this order (script: scratchpad/qa/work/v4607/repro.mjs, output in probe1.log):
- {olderThanDays:7}: HTTP 200 {runs:0,worktrees:0}
- {} (field omitted): {runs:0,worktrees:0}
- {olderThanDays:"7"}: {runs:0,worktrees:0}
- {olderThanDays:365}: {runs:0,worktrees:0}
- {olderThanDays:"abc"}: HTTP 200 {runs:3,worktrees:3}

The runs had finished about 0.1 minutes before the "abc" call. After it, all 3 runs were archived and all 3 worktrees were gone, including the uncommitted UNCOMMITTED-NOTE.txt. Each run log has "Cleaned up: removed 1 worktree(s); branches kept", and the codeflow/<id>/solo branches still exist. In node, Math.max(0, Number("abc")), Math.max(0, Number("x7")) and Math.max(0, Number({})) are all NaN, and `5 > NaN` is false, so the age filter never skips a run.

Reasons for 'minor' rather than 'major':
- The Insights UI cannot send NaN. ui/insights.tsx:352 clamps the field with `Number(value) || 0`.
- The endpoint is owner-only (it is in the globalPrivate list in src/filesystem-access.ts:61) and is not listed in docs/api.md.
- The result is the same as the valid request olderThanDays:0, which also cleans every finished, seen run.
- Committed work stays on the branches.

It is still a real bug, not by design. The doc comment above cleanUp says "finished more than `days` ago", and other inputs in server.ts already use Number.isFinite guards (server.ts:840, 867). A malformed request quietly destroys uncommitted files where it should get a 400.

Cleanup: I deleted my 3 runs through DELETE /api/runs/:id (the run list is now empty), stopped v4607 (port 4607 is free) and removed clones/v4607-mini. One leftover I did not create in this session is still there: scratchpad/qa/clones/v4607-tiny.

</details>

### S10-3 · minor · POST /api/cleanup computes days as Math.max(0, Number(body.olderThanDays ?? 7)); a non-numeric value gives NaN, the cutoff becomes NaN, and `r.endedAt > cutoff` is always false. Every finished, seen run is then cleaned up regardless of age. An empty string gives 0 days, which has the same effect.

**Fix outcome: duplicate.** Fixed by t18-3 (handler validation; empty string, NaN and negatives are 400). The UI half (disable Clean up for an empty or negative value) is fixed by t18-16.

Fixer's check: See t18-3 and t18-16: "" and -1 returned 400 on f01, and the Days field disables Clean up for blank or negative input.

Tests: `test/qa-insights-cleanup-api.test.ts`, `test/e2e/qa-insights-cleanup.e2e.ts`

Source: code-level suspect at `src/server.ts:1971` (confirmed hands-on).

**Repro**

> Fake server s10, scratch repo. Run B2 had finished about 1 minute earlier, was seen, and had a live worktree. POST /api/cleanup {"olderThanDays":7} returned {runs:0,worktrees:0}, as did {"olderThanDays":"7"}. Then {"olderThanDays":"abc"} returned {runs:1,worktrees:1}: B2's worktree, about a minute old, was removed (git worktree list showed only main afterwards).

**Expected:** Invalid or empty olderThanDays is rejected with 400, or falls back to the default of 7.

**Actual:** NaN makes the age filter pass for every run, so the worktree of every seen, finished run is removed with --force. This includes uncommitted files (see the next finding).

**Root cause (verifier):** Math.max(0, NaN) is NaN; Date.now() - NaN*86400000 is NaN; and r.endedAt > NaN is false, so no run is skipped as too recent. Number('') is 0, which means cleaning everything that has finished. The UI coerces its input with Number(value) || 0, so only direct API/script callers can send NaN. The UI also forwards negative numbers (the confirm text then says 'more than -3 days ago').

**Suggested fix:** In the handler: const days = body.olderThanDays === undefined ? 7 : Number(body.olderThanDays); if (!Number.isFinite(days) || days < 0 || days > 3650) throw new HttpError(400, 'olderThanDays must be a number of days ≥ 0'). In DiskPanel, clamp to min 0 and disable Clean up for an empty or negative value.

**Suggested regression test:** Server test: create a recently finished, seen run with a worktree. POST /api/cleanup with olderThanDays 'abc', '' and -1 returns 400 (or cleans nothing), and the worktree still exists.

### S12-1 · major · POST /api/cleanup with a non-numeric olderThanDays makes days NaN, so cleanUp's age filter never matches and every finished, seen run loses its worktrees and is archived, whatever its age.

**Fix outcome: duplicate.** Fixed by t18-3: handler validation plus the cleanUp() finite-cutoff guard. Uncommitted files are also no longer force-removed, per t18-1.

Fixer's check: See t18-3: 'abc', {}, [] and 'NaN' all returned 400 on f01 and nothing was archived. JSON cannot carry 1e999 as a number; it parses to Infinity → fails the finite check (and JSON.stringify(Infinity) is null → default 7).

Tests: `test/qa-insights-cleanup-api.test.ts`

Source: code-level suspect at `src/server.ts:1971` (confirmed hands-on).

**Repro**

> Fake QA server s12 on port 4549, using a scratch repo (git init) at qa/clones/s12-demo. I started 3 solo runs through the API, waited until they were done (about 10 s) and marked them seen. I added an uncommitted file notes-uncommitted.txt to one run's worktree. POST /api/cleanup {olderThanDays:7, repo} returned {runs:0, worktrees:0}, the control. POST /api/cleanup {olderThanDays:"abc", repo} returned {runs:3, worktrees:3}. git worktree list then showed only main. All 3 runs were archived:true, with the log line 'Cleaned up: removed 1 worktree(s); branches kept'. The uncommitted file was destroyed, because removeWorktrees runs `git worktree remove --force`.

**Expected:** Reject non-numeric, non-finite or out-of-range olderThanDays with 400 and change nothing. Only runs that finished more than N days ago should be cleaned.

**Actual:** Math.max(0, Number('abc')) is NaN, so cutoff = Date.now() - NaN*86400000 = NaN. `r.endedAt > cutoff` is always false, so every finished, seen run without a watch is force-cleaned and archived, including runs that finished seconds ago.

**Root cause (verifier):** server.ts:1971 calls `Math.max(0, Number(body.olderThanDays ?? 7))` with no finiteness check, and Math.max propagates NaN. cleanUp (server.ts:2898) skips a run only when `r.endedAt > cutoff`, and every comparison with NaN is false. removeWorktrees uses --force, so uncommitted files in those worktrees are also lost.

**Suggested fix:** In the route: `const days = Number(body.olderThanDays ?? 7); if (!Number.isFinite(days) || days < 0 || days > 3650) throw new HttpError(400, 'olderThanDays must be a number of days');`. Also guard in cleanUp: `if (!Number.isFinite(cutoff)) throw ...`, so other callers cannot hit the same failure. Optionally skip worktrees with uncommitted changes, which would mean not using --force for bulk age-based cleanup.

**Suggested regression test:** API test: start a server with a finished, seen run whose worktree exists. POST /api/cleanup with olderThanDays 'abc', {}, [], 'NaN' and 1e999 must each return 400. The run must stay unarchived and its worktree must still exist. A control with olderThanDays 7 must return {runs:0}.

### S14-3 · minor · POST /api/cleanup passes Math.max(0, Number(body.olderThanDays ?? 7)) without validation. A non-numeric value yields NaN, the cutoff becomes NaN, the 'r.endedAt > cutoff' guard never skips, and every finished, seen, idle run loses its worktrees regardless of age.

**Fix outcome: duplicate.** Fixed by t18-3. Body.project and body.repo types are validated too: a non-string gets a 400, so a malformed scope can't widen what gets cleaned.

Fixer's check: See t18-3: 'seven' and {} gave 400 on f01. {project:5} gave 400 'project must be a project id' and {repo:5} gave 400.

Tests: `test/qa-insights-cleanup-api.test.ts`

Source: code-level suspect at `src/server.ts:1971` (confirmed hands-on).

**Repro**

> Fake server s14 with scratch repo R and 3 solo codex runs (POST /api/runs), all done, then POST /api/runs/:id/seen. curl POST /api/cleanup bodies: {olderThanDays:7} → {runs:0}; {olderThanDays:"7"} → {runs:0}; {olderThanDays:365} → {runs:0}; {olderThanDays:"seven"} → HTTP 200 {runs:3,worktrees:3}. Afterwards `git worktree list` showed only main, the codeflow/* branches remained, GET /api/runs/:id showed archived:true with endedAgo about 53s, and runs/<id>.jsonl ended with the 'Cleaned up…' log.

**Expected:** A non-numeric or non-finite olderThanDays should get a 400 response, or at least fall back to the default of 7 days, and nothing should be cleaned.

**Actual:** Three runs had ended about 53 seconds earlier and were marked seen. POST /api/cleanup with {olderThanDays:7}, {"7"} and {365} each returned {runs:0, worktrees:0}. {olderThanDays:"seven"} returned 200 {runs:3, worktrees:3}: all three worktrees were removed, the runs were set archived:true, and each journal logged 'Cleaned up: removed 1 worktree(s); branches kept'.

**Root cause (verifier):** Math.max(0, NaN) is NaN, so cleanUp's cutoff = Date.now() - NaN*86400000 is NaN. `r.endedAt > cutoff` is always false, so the age filter never excludes anything (server.ts:2898-2915). An invalid value behaves like olderThanDays: 0, the most aggressive setting, instead of being rejected. Mitigations: the Insights UI always sends a number (`Number(value) || 0`, ui/insights.tsx:352), branches are kept, and dirty worktrees are not force-removed. The affected runs are also silently archived.

**Suggested fix:** In the /api/cleanup handler: `const days = body.olderThanDays === undefined ? 7 : Number(body.olderThanDays); if (typeof body.olderThanDays !== "undefined" && typeof body.olderThanDays !== "number" || !Number.isFinite(days) || days < 0 || days > 3650) throw new HttpError(400, "olderThanDays must be a number of days (0–3650)");`. Also validate body.project and body.repo types.

**Suggested regression test:** Server test: create a finished, seen run with a worktree. POST /api/cleanup {olderThanDays:'seven'} (and {olderThanDays:{}}) should return 400, and the worktree directory and archived flag should be unchanged. A control with {olderThanDays:0} still cleans.

### t18-16 · minor · Insights Clean-up days field: negative values are shown as-is but mean 'everything'; an empty field silently becomes 0

**Fix outcome: fixed.** ui/insights.tsx DiskPanel now keeps the raw text in state (daysText) and derives `days` as a whole number from 0 to 365 or null (line ~347), so the field never snaps or rewrites what's typed. When days is null the input gets aria-invalid, an inline role=alert 'Enter a whole number of days from 0 to 365' appears, and Clean up is disabled, so nothing is sent. The confirm says 'all finished runs that need nothing from you' for 0, and 'runs that finished more than N day(s) ago and need nothing from you' otherwise. The button shows 'Cleaning up…' while the request runs. The server rejects negatives as well (t18-3).

Fixer's check: f01 after rebuilding the UI (r02.log, r04.log, screenshot shots/f01/002-neg.png). Filling -3: field shows -3, Clean up disabled, aria-invalid=true, alert shown. The same for '' and 400. Real keyboard select-all, Backspace, then typing -3: the field shows -3 and Clean up stays disabled; the old '0-3' snap is gone. No /api/cleanup request was sent for any of these. Confirm text for 7 and 1 says 'more than 7 days ago' and 'more than 1 day ago'; for 0 it says 'all finished runs that need nothing from you, and archive those runs?'. e2e test/e2e/qa-insights-cleanup.e2e.ts covers -3, '', 400, 1.5, the typed minus, and the 1-day and 0-day wording. Browser errors [].

Tests: `test/e2e/qa-insights-cleanup.e2e.ts`

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-24.

**Repro**

> Insights → Disk: type -3 in Days → Clean up. Or clear the field → Clean up.

**Expected:** Validation that rejects negatives and empty input, or a confirm that says 'all finished runs'.

**Actual:** The confirm reads 'finished more than -3 days ago' while the server clamps to 0, which removes every finished run's worktree. An empty field shows 0 and has the same effect.

**Root cause (verifier):** ui/insights.tsx:352 `onInput={(e) => setDays(Number(e.currentTarget.value) || 0)}`:
- Negative numbers pass straight through. Number("-3") is -3, which is truthy.
- Empty input and invalid partial input (e.g. "-" or "0-3", where input.value is "") become 0 through `|| 0`.
- The `min={0} max={365}` attributes are never enforced, because there is no form submit or validity check.
- When state is already 0 there is no re-render, so the empty DOM value stays on screen.

ui/insights.tsx:357 puts the raw `days` into the danger-confirm text ("more than ${days} days ago"), and ui/insights.tsx:359 posts it as olderThanDays.

src/server.ts:1971 quietly clamps it with `Math.max(0, Number(body.olderThanDays ?? 7))`, so -3 is treated as 0.

In src/server.ts:2898-2905 cleanUp computes the cutoff as now - 0, so every finished, seen run with nothing pending qualifies. src/ship.ts:450 then removes each worktree with `git worktree remove --force`, which also deletes uncommitted changes.

So the UI never shows the value the server actually uses, which is "all finished runs".

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/insights.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`

**Suggested fix:** UI (ui/insights.tsx DiskPanel):
- Keep the raw text in state (e.g. `const [daysText, setDaysText] = useState("7")`) and derive `days = /^\d+$/.test(daysText.trim()) ? Math.min(365, Number(daysText)) : null`, so the field never snaps or rewrites what the user types.
- Disable Clean up, or show an inline error ("Enter 0–365 days"), when days is null or the input's validity is not valid (covers negatives, blanks and badInput).
- Word the confirm by value: for 0 say "Remove the worktrees of all finished runs that need nothing from you…"; otherwise keep "finished more than N days ago".
- Optionally warn that uncommitted changes in those worktrees are discarded.

Server (src/server.ts:1971): reject rather than clamp. If olderThanDays is present and is not a finite integer in 0..365, throw HttpError(400, "olderThanDays must be a whole number of days between 0 and 365"), so API callers cannot reach "everything" by sending -3 or "abc" (Number("abc") is NaN; Math.max(0, NaN) is NaN and the cutof …

**Suggested regression test:** 1) Server, in a new focused test such as test/cleanup-api.test.ts (or the existing server API test file): POST /api/cleanup with {olderThanDays: -3} and with {olderThanDays: "abc"} must return 400 and leave a finished, seen run's worktree in place. {olderThanDays: 0} must still remove it.
2) Browser, in test/e2e/ui.e2e.ts (Insights section):
- Fill the Days field with "-3": assert the "Clean up" button is disabled or an inline error is shown, and that no "more than -3 days" confirm dialog appear …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server (v4633k on 127.0.0.1:4633, new home). I added a scratch clone of MQTT-MCP through "Open another repository", started two fake solo runs, waited until both were done and opened each one so it counted as seen. Then I opened Insights → Disk → Measure worktrees (2 runs, 2.3 MB) and tried the Days field. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4633k/ (cleanup.mjs, cleanup.log).
(B) fill("-3"): the field shows -3 and validity.rangeUnderflow is true. The UI ignores this, and the danger confirm reads "Remove the worktrees of runs that finished more than -3 days ago…" (screenshot shots/v4633k/002-fill-neg.png).
(F) Accepting -3 gives the toast "Removed 2 worktree(s) from 2 run(s)". Both worktrees were deleted, though the runs had finished seconds earlier. With 7, the result is "Nothing to clean up" and both worktrees stay.
(C) Clearing the field from 7: Preact re-renders it as "0", and the confirm says 0 days. That is visible, not silent.
(D) Clearing the field when it is already 0: the field stays visibly empty, the confirm says "more than 0 days ago", and accepting would remove every finished, seen run.
(A) An extra case the reporter missed: real keyboard input (select all, Backspace, type "-3"). Backspace snaps the field to "0", and typing then leaves "0-3" in the field (badInput, value ""). The confirm still says "0 days" (shots/v4633k/001-kbd-neg.png), so what the field shows and what the server uses differ here too.
No console or 5xx errors.
Not by design: docs/runs.md:136 defines Clean up as "finished more than N days ago" and the input declares min=0, so a negative or blank N is not valid input.
Not caused by the test environment: it happens with Playwright fill and with real keyboard input on a fresh profile.
Mitigations: the confirm states a number, branches are kept, and with N=0 "all finished runs" is the documented meaning. But removeWorktrees uses `git worktree remove --force`, so any uncommitted edits in those worktrees are discarded.

</details>

### S12-5 · minor · The Disk 'Days' input uses setDays(Number(value) || 0) and does not enforce min/max. Clearing the field or typing a negative number sends 0 or a negative value, which the server clamps to 0, so every finished run is cleaned. The confirm dialog then reads 'more than -5 days ago' or '0 days ago'.

**Fix outcome: duplicate.** Fixed by t18-16 (raw-text Days field, invalid input disables Clean up, no negative age in the confirm) plus the server-side 400 for negatives (t18-16 and t18-3). The 0 days option stays valid; it is documented as 'every finished run'.

Fixer's check: See t18-16: -5-style negatives and the cleared field disable Clean up on f01, and no request is sent.

Tests: `test/e2e/qa-insights-cleanup.e2e.ts`

Source: code-level suspect at `ui/insights.tsx:352` (confirmed hands-on).

**Repro**

> s12 fake server, 2 runs that had just finished and were marked seen, Insights → Disk. Typing -5 left the field at '-5' (input.validity.valid=false, but nothing enforces it). Clean up opened the dialog 'Remove the worktrees of runs that finished more than -5 days ago and need nothing from you?' (shots/s12/001-confirm-negative-days.png). Clearing the field snapped it to '0' and the dialog said 'more than 0 days ago'. Confirming sent POST /api/cleanup {"olderThanDays":0}, and the toast 'Removed 2 worktree(s) from 2 run(s)' confirmed that runs which finished about a minute earlier were cleaned. -5 reaches the same server path: Math.max(0, -5) = 0.

**Expected:** The field should reject values outside 1–365, with min=0 at most, or the Clean up button should be disabled while the input is invalid. The confirm text should never show a negative age.

**Actual:** Negative values pass the UI and the dialog shows a nonsensical '-5 days ago'. The server silently treats them as 0, which cleans every finished, seen run with a force removal. The cleared-field case is at least visible, since the field shows 0 and the dialog says 0.

**Root cause (verifier):** onInput sets `setDays(Number(e.currentTarget.value) || 0)` and never checks the input's min/max validity. The server clamps negative values to 0 instead of rejecting them (server.ts:1971).

**Suggested fix:** Keep the raw string in state and parse it with valueAsNumber. Disable Clean up unless the value is an integer from 1 to 365, or clamp to that range before building the dialog text. Show the number of runs and worktrees that will be affected in the confirm dialog. On the server, return 400 for values below 0 (see the NaN finding) rather than clamping.

**Suggested regression test:** Playwright test on Insights: fill Days with '-5' and assert that Clean up is disabled, or that the dialog shows a clamped and valid number of days. Fill '' and assert that no request is sent with olderThanDays 0 unless the user typed 0. API test: olderThanDays -5 returns 400.

### t17-17 · minor · Insights 'Clean up' leaves empty per-run folders behind

**Fix outcome: fixed.** RunManager.cleanUp (src/engine.ts:3720) calls the existing private tidyRunFolder(run, false) after removing the worktrees, with its signature unchanged. This removes scratch checkouts (.proof-check/.repro-check/.base-check) and the folder once it's empty, deletes the fetched codeflow-pr/<n> branch under the same rules as Archive, and logs '; removed the run's folder'. An already-archived eligible run whose worktrees are gone (e.g. cleaned by the old code) is tidied by a later Clean up and counted in `folders`. An unarchived run with no worktrees is left alone, as before. docs/runs.md:137 now says Archive… and Clean up both clear the folder.

Fixer's check: f01 (r02.log): the clean fix-review run with a .base-check scratch checkout ended with its worktree gone, its folder gone ('folder: gone'), and .base-check no longer in `git worktree list`. Its branch was kept. Its log reads 'Cleaned up: removed 1 worktree(s) and archived the run; branches kept; removed the run's folder'. Measure again no longer lists that run. The engine test 'a clean run loses its worktree and folder…' covers the .repro-check removal, the branch being kept, and the tidy-only pass for a previously cleaned run that has a .base-check leftover.

Tests: `test/qa-insights-cleanup.test.ts`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-03.

**Repro**

> With finished runs, Insights > Disk > Remove worktrees of finished runs older than 0 days > Clean up > Remove worktrees. List the worktree root.

**Expected:** Run folders are tidied the same way Archive tidies them.

**Actual:** wtroot/2610251637-25a60a07/ and wtroot/2610251637-b708c951/ stay as empty directories.

**Root cause (verifier):** In src/server.ts:2898-2914, `cleanUp()` calls only `removeWorktrees(r.repo, r.worktrees, false)` (src/ship.ts:430-466). That function runs `git worktree remove` on each worktree path and then `git worktree prune`. It never touches the parent run folder `<worktreeRoot>/<runId>`.

The step that clears and removes the run folder is `RunManager.tidyRunFolder()` (src/engine.ts:3721-3740). It is private and is only called from `archive()` (src/engine.ts:3693). It does the following:
- removes the scratch checkouts in SCRATCH_DIRS (`.proof-check`, `.repro-check`, `.base-check`; src/engine.ts:346);
- removes `.context` only when branches are deleted;
- calls `rmdir`, which only succeeds on an empty folder;
- deletes the fetched `codeflow-pr/<n>` head branch.

None of this happens on the Clean up path. That has three effects:
1. Run folders with nothing staged (e.g. fix-review) stay as empty directories. Reproduced.
2. Insights > Disk keeps listing and counting those runs at 0 B, because `diskUsage()` (src/server.ts:2883-2891) lists every run whose worktreeDir still exists. Reproduced.
3. By code reading only, not reproduced: scratch checkouts an interrupted attempt left behind are full che …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/engine-review.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** Move the worktree removal that Clean up does into RunManager so it shares the tidy step with Archive. Do not route Clean up through `archive()` itself: `archive()` also purges run memory (`memoryStore.purgeRun`) and refuses shared chat workspaces, and both would change what Clean up does today.

1. Add a public method to RunManager in src/engine.ts, for example `async removeWorktreesKeepBranches(id): Promise<{ removed: string[]; failed: string[]; folder: boolean }>`. It should:
   - call `removeWorktrees(run.repo, run.worktrees, false)`;
   - then call `this.tidyRunFolder(run, false)`;
   - merge the tidy step's `failed` entries into the result;
   - write the log line "Cleaned up: removed N worktree(s); branches kept" and add "; removed the run's folder" / "; deleted codeflow-pr/<n>" the same way `archive()` does;
   - call `emitRun(run)` so open views refresh.
2. In src/server.ts `cleanUp()` (2898-2914), call that method instead of `removeWorktrees` directly. Consider running the tid …

**Suggested regression test:** Add a test to test/engine-review.test.ts next to "archive removes the run's folder once its worktrees are gone…" (around line 461), using the same fixtures (`RunManager(withOneTurn)`, `idle`, `sh`). Call the new RunManager method directly, or if the server endpoint is kept, add a server-level test in test/server-reliability.test.ts that POSTs /api/cleanup {olderThanDays:0}.

Cases to cover:
1. A finished, seen run with nothing staged:
   - after Clean up, `existsSync(run.worktreeDir)` is false;
 …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server (v4693t1717 on 127.0.0.1:4693, new home) with the default worktree dir `<repo>/.worktrees`. The reporter had set an absolute CODEFLOW_WORKTREE_DIR; I did not. I made a scratch clone of MQTT-MCP and added it through the UI ("Open another repository"). Then I started 3 solo runs and 3 fix-review runs (codex builder, claude reviewer) through the API, and all six finished as "done". I opened 2 solo and 2 fix-review runs in the UI so they counted as seen, and left one of each unseen to use as Archive controls.

Clean up, done in the UI: Insights > Disk > Measure worktrees showed "6.9 MB in 6 runs' worktrees". I set Days to 0, clicked Clean up, then Remove worktrees. The toast said "Removed 4 worktree(s) from 4 run(s)" and the run logs said "Cleaned up: removed 1 worktree(s); branches kept".
- Each fix-review run had one worktree at `.worktrees/<id>/build`. After Clean up, `.worktrees/2610252157-f6f8e6f6/` and `.worktrees/2610252157-4cd18c13/` were left behind (`find -type d -empty` lists both).
- The Disk panel measured again by itself and still said "2.3 MB in 6 runs' worktrees", with the two cleaned fix-review runs listed as Archived at 0 B (/api/disk returns them with bytes:0). The folder still exists, so diskUsage (src/server.ts:2883) keeps counting the run.

Archive control, done in the UI: on the unseen fix-review run 2610252157-576bc845 I chose More run actions > Archive… with "Remove its 1 worktree" checked (the default) and "delete branches" unchecked. The log said "Archived: removed 1 worktree(s); branches kept; removed the run's folder", and `.worktrees/2610252157-576bc845` was gone.
So with the same inputs (same pattern, branches kept), Archive removes the folder and Clean up does not.

Things I could rule out:
- The tester's environment: this happens with the default `.worktrees` root, not only with the reporter's absolute wtroot.
- Intended design, at least for solo runs: their folders keep `.context/messages/portable-conversation.md` after both Clean up and Archive (I checked the solo control through the API). docs/runs.md says staged context is kept while branches are kept, so that part is by design.
- docs/runs.md:136 only says Clean up "removes the worktrees, not the branches". The tidy-up rules in docs/runs.md:137 are written only for Archive. Nothing in the docs or code comments says Clean up should leave the folder behind.

Cleanup afterwards: I deleted all 6 runs (3 through the run page's Delete… dialog,  …

</details>

### t18-20 · minor · Clean up leaves .worktrees/<run>/.context folders behind, so the Disk table still lists cleaned runs

**Fix outcome: duplicate.** Fixed by t17-17's change: tidyRunFolder now runs on the Clean up path, so empty run folders and scratch checkouts go and cleaned fix-review runs drop out of the Disk table. As the verifier established, a solo run's .context folder is intentionally kept while its branches are (docs/runs.md:137; Archive does the same), so such runs still appear in Disk with a few KB. That part is by design and was not changed.

Fixer's check: On f01, 'Measure again' after Clean up no longer listed the cleaned fix-review run. The hand-cleaned solo run stays at 4 KB, Archived, with only .context in its folder, the same as Archive.

Tests: `test/qa-insights-cleanup.test.ts`

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-24, GIT-23.

**Repro**

> Insights → Clean up with 0 days → Measure again.

**Expected:** The run folder is tidied as Archive does (docs/runs.md:137), and cleaned runs drop out of the Disk table.

**Actual:** '2.3 MB in 12 runs' worktrees' still lists every cleaned run with a few KB, because .worktrees/<id>/.context remains.

**Root cause (verifier):** src/server.ts:2898-2914 cleanUp() only calls removeWorktrees(r.repo, r.worktrees, false). It never does the folder tidy that Archive does in src/engine.ts:3693 (RunManager.tidyRunFolder, which is private, at src/engine.ts:3721-3741). That tidy step:
(a) removes the scratch checkouts in SCRATCH_DIRS (.proof-check, .repro-check, .base-check; src/engine.ts:346) through removeDetachedWorktree;
(b) rmdirs the run folder once it is empty (src/engine.ts:3731);
(c) deletes the fetched codeflow-pr/<n> head branch.
src/server.ts:2908 `if (!result.removed.length) continue;` also means a run whose worktrees are already gone is never tidied on a later Clean up.
src/server.ts:2883-2891 diskUsage() lists every run whose worktreeDir exists (`sizes[r.worktreeDir] !== undefined`, line 2887). So empty folders show as 0 B rows, and folders with leftover scratch checkouts keep their full size, under "N runs' worktrees".
Not a bug: a .context-only folder for a run whose branches are kept is intended (docs/runs.md:137; src/engine.ts:3713-3720 comment; test/engine-review.test.ts:466-473). Solo runs always stage .context/messages/portable-conversation.md, so their folders stay after Archive as well as afte …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/engine-review.test.ts`

**Suggested fix:** 1. Expose the tidy step. Either make RunManager.tidyRunFolder public, or (better) add `RunManager.cleanUpWorktrees(id)` in src/engine.ts, which runs removeWorktrees(run.repo, run.worktrees, false) and then tidyRunFolder(run, false), and appends its folder/prBranch results and failures to the log line.
2. In src/server.ts cleanUp(): call that method instead of removeWorktrees directly. Tidy even when result.removed is empty but the run folder still exists and no worktree path exists, so leftover scratch checkouts from earlier clean-ups are reclaimed. Count those runs, and report "freed scratch checkouts" or "removed N run folder(s)" in the result and toast.
3. Optional, Disk table: in diskUsage(), either skip runs whose worktree paths are all gone and whose folder holds only .context, or label such rows "staged context (kept for resume)" rather than counting them as "worktrees". The headline "X in N runs' worktrees" is then accurate.
4. Docs: in docs/runs.md:136, add that Clean up also  …

**Suggested regression test:** Add to test/server-reliability.test.ts (or a new test/insights-cleanup.test.ts), modelled on test/engine-review.test.ts:460:
- Start a one-turn run with no attachments and one solo run with an attachment, and mark both seen.
- Add a detached scratch checkout with `git worktree add --detach <worktreeDir>/.base-check <baseRef>` to the first run.
- POST /api/insights/cleanup {olderThanDays:0}.
- Assert the plain run's folder no longer exists (`!existsSync(plain.worktreeDir)`) and that `git worktree …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4641 on port 4641 (home had no active runs). Made my own tiny scratch repo (bare plus clone under scratchpad/qa/clones/v4641-tiny) and added it through the UI ("Open another repository", then New project "v4641 tiny"). Started 4 runs through the API, all of which finished as done: 2 solo (claude, no attachments), 1 fix-review (check "true") and 1 solo with an attachment. Before clean-up, every solo run's folder held .context/messages/portable-conversation.md, even with no attachments (the chat hand-off stages it). The fix-review folder held only "build". I opened each run in the browser to mark it seen, then went to Insights > Disk > Measure ("100 KB in 4 runs' worktrees"), set Days to 0, clicked Clean up, then Remove worktrees. The toast said "Removed 4 worktree(s) from 4 run(s)". After Measure again: "16 KB in 4 runs' worktrees", and all 4 rows were still listed as Archived (8 KB, 4 KB, 4 KB and 0 B). On disk, the 3 solo folders held only .context, and the fix-review folder was EMPTY but not removed (the 0 B row). Scripts and logs: scratchpad/qa/work/v4641/a01-setup.mjs, a02-cleanup.mjs, a02.log; screenshot scratchpad/qa/shots/v4641/002-disk-after.png.

Comparison with Archive (a03): on two new runs I archived with "Remove its worktree" and branches kept. The fix-review run was archived through the UI "More run actions > Archive…"; its log says "removed the run's folder" and the folder is gone. The solo run was archived through the same /archive endpoint (chat runs have no More menu); its folder KEPT .context, so it also stays in the Disk table at 4 KB. So the specific claim ("tidied as Archive does, and cleaned runs drop out") is wrong for .context: Archive with branches kept keeps it too. That is documented in docs/runs.md:137 ("kept otherwise: a resume or a reply copies it into the worktree") and asserted in test/engine-review.test.ts:460-473 (readdirSync == [".context"]).

Scratch leftover (a04/a05): a new fix-review run, done and seen. I simulated an interrupted proof's leftover with `git worktree add --detach <runDir>/.base-check HEAD` plus a 2 MB file. Insights > Clean up (0 days) said "Removed 1 worktree(s) from 1 run(s)". The run was still listed at 2.0 MB, .base-check was still on disk, and it was still registered in `git worktree list`. Then I did Unarchive, Archive… (UI, branches kept) on the same run; the log said "Archived: removed 0 worktree(s); branches kept; removed the run's folder", and .base-check was unregi …

</details>

### S13-1 · minor · Worktree cleanup in Insights archives every run it cleans (manager.setArchived), but the confirmation, the toast, the run log and the docs only talk about removing worktrees and keeping branches.

**Fix outcome: fixed.** Archiving is kept and now disclosed. The confirm says '…and archive those runs?'. The API returns an `archived` count. The toast says 'Removed N worktree(s) from M run(s) and archived them' (or '; archived K of them' when some were already archived). The run log line is 'Cleaned up: removed N worktree(s) and archived the run; branches kept'. docs/runs.md:136 says Clean up archives those runs.

Fixer's check: On f01 the confirm read 'Remove the worktrees of all finished runs that need nothing from you, and archive those runs?' and the toast read 'Removed 1 worktree(s) from 1 run(s) and archived them; kept 5 run(s) as they are (see below)'. The run journal has 'Cleaned up: removed 1 worktree(s) and archived the run; branches kept'. The API test asserts archived:1 and the log line; the e2e asserts the confirm and toast text.

Tests: `test/qa-insights-cleanup-api.test.ts`, `test/e2e/qa-insights-cleanup.e2e.ts`

Source: code-level suspect at `src/server.ts:2911` (confirmed hands-on).

**Repro**

> Fake-mode QA server s13 on port 4553 with a scratch git repo. (1) Through the API, created solo run 2610251539-57444c3a (fake claude) and it finished as done. (2) Opened the run in the UI, which marked it seen. The sidebar listed it, and the API showed seen=true, archived=false, worktree present. (3) Insights > Disk: set Days to 0 and clicked 'Clean up'. The dialog read 'Remove old worktrees? | Remove the worktrees of runs that finished more than 0 days ago and need nothing from you? Branches are kept, so you can still merge or resume them.' Clicked 'Remove worktrees'. (4) The toast said 'Removed 1 worktree(s) from 1 run(s)'. The API then showed archived=true and the worktree folder gone. The branch codeflow/2610251539-57444c3a/solo was kept. The sidebar showed 'No runs yet — start one on the right', and the run was only reachable through 'Show archived runs 1'. The run log contained only 'Cleaned up: removed 1 worktree(s); branches kept'. Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s13/002-cleanup-confirm-dialog.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s13/004-cleanup-after-sidebar.png

**Expected:** Before confirming, the user is told that cleaned runs also move to the archive, or the runs stay unarchived. The toast and the run log should say the runs were archived.

**Actual:** Cleaned runs silently disappear from the sidebar into the archive. The dialog, toast, run log and docs only mention removing worktrees.

**Root cause (verifier):** cleanUp() in src/server.ts (lines 2897-2915) calls manager.setArchived(r.id, true) for every run whose worktrees it removed. This was added on purpose in commit 824d79f (M7), but nothing tells the user. The confirmAction text in ui/insights.tsx:357 says 'Remove the worktrees of runs that finished more than N days ago and need nothing from you? Branches are kept, so you can still merge or resume them.' The toast says 'Removed N worktree(s) from M run(s)'. The run log line is 'Cleaned up: removed N worktree(s); branches kept'. docs/runs.md:136 says Clean up 'removes the worktrees, not the branches'. None of them mention archiving.

**Suggested fix:** Keep the archiving and disclose it. Change the dialog text to e.g. 'Remove the worktrees of ... and archive those runs? Branches are kept...'. Return { runs, worktrees, archived } from /api/cleanup and show 'Removed N worktree(s) and archived M run(s)'. Log 'Cleaned up: removed N worktree(s), archived; branches kept'. Update docs/runs.md:136. Or drop the setArchived call if archiving was not intended.

**Suggested regression test:** Server test: start a fake run, mark it seen, POST /api/cleanup {olderThanDays:0}, then assert that the response reports the archive count and that the run log line mentions archiving. In the UI e2e for the Insights Disk panel, assert that the confirm text contains 'archive'.

### S14-4 · minor · Clean-up compares body.repo verbatim with run.repo, while GET /api/disk canonicalizes the repo via requestedRepo/repoRoot. Passing a subfolder or symlink path measures disk correctly but then cleans nothing ('Nothing to clean up').

**Fix outcome: fixed.** The POST /api/cleanup handler now runs body.repo through validRepo (an absolute path, canonicalized to the repo root with repoRoot), the same way GET /api/disk does. A non-string repo or a relative path is a 400. An empty repo means no repo filter, as in /api/disk.

Fixer's check: On f01 (r03.log): repo spelled through the /tmp symlink alias, plus '/sub/' and a trailing slash. GET /api/disk listed run D for that spelling, and POST /api/cleanup with the same spelling cleaned and archived D (D's worktree gone). repo 'not-a-path' and repo 5 returned 400. The API test checks the macOS /var→/private/var alias plus subfolder and trailing slash: /api/disk and /api/cleanup cover the same run ids.

Tests: `test/qa-insights-cleanup-api.test.ts`

Source: code-level suspect at `src/server.ts:1971` (confirmed hands-on).

**Repro**

> Fake server s14, scratch repo R=/private/tmp/…/qa/clones/s14-demo with 3 finished, seen runs. Commands: GET /api/disk?repo=R/sub → total 73728, 3 runs; POST /api/cleanup {olderThanDays:0, repo:R/sub} → {runs:0,worktrees:0}; GET /api/disk?repo=/tmp/…/s14-demo → 3 runs; POST /api/cleanup {olderThanDays:0, repo:/tmp/…/s14-demo} → {runs:0}; POST {repo:R+'/'} → {runs:0}; POST {repo:'not-a-path'} → HTTP 200 {runs:0}; GET /api/disk?repo=not-a-path → HTTP 400. git worktree list still showed all 3 run worktrees after these calls.

**Expected:** POST /api/cleanup should canonicalize and validate repo exactly as /api/disk does, so the same path measures and cleans the same runs, and invalid paths get 400.

**Actual:** GET /api/disk?repo=R/sub listed 3 runs (73,728 bytes), but POST /api/cleanup {olderThanDays:0, repo:'R/sub'} → {runs:0, worktrees:0}. The /tmp alias of R gave the same result: disk listed 3 runs, cleanup cleaned 0. 'R/' with a trailing slash cleaned 0. repo:'not-a-path' → 200 {runs:0}, while /api/disk?repo=not-a-path → 400 'Repository must be an absolute path'.

**Root cause (verifier):** GET /api/disk resolves ?repo through requestedRepo → validRepo → repoRoot, giving the canonical top level. POST /api/cleanup passes `typeof body.repo === "string" ? body.repo : undefined` straight into cleanUp, which skips every run where `r.repo !== repo`. Any non-canonical spelling therefore matches no run: a subfolder, the macOS /tmp → /private/tmp symlink alias, or a trailing slash. Invalid values (a relative path) are also accepted with 200 instead of 400. The Insights UI is not affected because it sends repo.value, which comes from /api/branches' canonical info.repo. This is a direct-API inconsistency.

**Suggested fix:** In the cleanup handler: `const repo = typeof body.repo === "string" && body.repo ? await validRepo(body.repo) : undefined;` before calling cleanUp. Reject non-string repo values with 400.

**Suggested regression test:** Server test with runs in a temp repo: for repo spellings [root, root+'/sub', symlinked alias, root+'/'], GET /api/disk and POST /api/cleanup {olderThanDays:0} should cover the same run ids. A relative repo should get 400 from both.
