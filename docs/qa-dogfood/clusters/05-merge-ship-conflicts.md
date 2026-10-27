# Cluster 05 · merge-ship-conflicts

**Merge & conflict resolution: committed conflict markers, mid-merge timeouts, merge targets**

Status: **repair completed and verified on `codex/qa-merge-ship-repair` · integrated into `codex/dogfood-qa-continue`** · 9 issues · branch `qa-fix/merge-ship-conflicts`

Planner notes: t17-1/S10-6: the resolve-conflicts follow-up in runFollowUpInWorktree (src/engine.ts ~5811-5881) runs ctx.ask with allowFailure:true and then commits regardless. git add -A marks the conflict markers as resolved. On failure, abort the merge, and check for unmerged paths or markers before committing. t17-20: the resulting 2-parent merge makes Review diff against the wrong base; show only the run's own changes. In mergeInCheckout (src/ship.ts): a timeout after the merge commit leaves the user's checkout mid-merge while the UI says 'Merged' (t17-2), and the --no-commit path used by 'Require verification' skips the pre-merge-commit and post-merge hooks (t18-6). t18-7: MergePanel keeps the validation result only in component state and never names the failing gate. t17-18: remove the text claiming confirmation still applies. t17-5/S10-7: listBranches tags only refs/heads/codeflow/* as run branches; also keep custom-prefix run branches out of merge targets (listBranches in src/git.ts, the server merge-targets route). The PR target list (t19-17) belongs to github-pr-open-picker. Duplicate groups: [["t17-1","S10-6"],["t17-5","S10-7"]]

Likely files: `src/engine.ts`, `src/ship.ts`, `src/git.ts`, `ui/run.tsx`, `ui/review.tsx`, `ui/changes.tsx`, `ui/review-coverage.tsx`, `ui/run-evidence.tsx`, `src/server.ts`

## Repair completion · 2026-10-26

This section supersedes the earlier review-base behavior and the outstanding code-review findings below. The original reproduction and initial verification records remain for traceability.

- **t17-1 / S10-6:** Failed or marker-filled resolver turns still abort without a commit. Binary and modify/delete conflicts must now be explicitly staged: an agent that says "done" while leaving those index entries unresolved is refused and the merge is aborted. Text conflicts can still resolve by editing the original markers away; the resolver prompt asks it to stage all resolved files. Reading the unmerged index fails closed. Original failed-resolver repro and the new untouched-binary UI variation pass.
- **t17-20 / review-base regression:** Review, coverage, risk and artifact statistics keep the entire diff from the run's fixed starting commit. Files imported by conflict resolution are labelled **merged in**, with their source named in the explanatory note. They remain in review coverage even after the original base branch gains those changes, since Merge can target an older or different branch. Integrity checks separately use the run's own changes so imported tests are not attributed to the agent. The last-step view still isolates the resolution. Tests cover a target that lacks the run's base, working-file edits to an imported file, and merging elsewhere both before and after the base branch advances.
- **Large text diffs:** Marker detection first asks Git for candidate file names instead of collecting the whole patch. A 70,000,000-byte ordinary text addition successfully merges through both RunManager and the live HTTP endpoint. Candidate files are inspected individually; an individual candidate exceeding the output bound remains conservatively flagged and can use the explicit override.
- **Legitimate marker text:** The merge route returns a structured 409 that opens a **Merge with conflict markers?** dialog. Cancel preserves the target; **Merge anyway** opts in for that merge and records a warning. Marker detection uses the result tree's `.gitattributes` through an isolated temporary index and honors both shorter and longer `conflict-marker-size` values (tested at 3, 10 and 32). Documentation explains the override and marker-size option.
- **t17-2:** Slow post-merge hooks in the primary or linked checkout leave a completed merge with Git merge-state cleared, and the UI shows the warning.
- **t18-6:** Verified checkout merges run the same merge hooks as ordinary merges; a hook changing the verified tree still rolls back.
- **t18-7:** Merge validation survives reload, shows named failing gates and disables required-validation merges after a failure.
- **t17-18:** Publish text accurately explains local merge behavior.
- **t17-5 / S10-7:** Custom-prefix run branches remain excluded from target choices and rejected by the server.

Validation on this repair branch:

- `npx tsc --noEmit`: passed.
- `npx tsx --test test/qa-merge-ship-conflicts*.test.ts`: **16/16 passed**.
- Existing compatibility tests (`test/ship.test.ts`, `test/merge-tree-pin.test.ts`, `test/engine-review.test.ts`): **37/37 passed**.
- `npx tsx --test test/e2e/qa-merge-ship-conflicts.e2e.ts`: **2/2 passed**, real headless Chrome against isolated local servers with fake agent CLIs. Covers desktop and 390px layouts, accessibility checks, original merge/validation/hook/failure flows and confirmation Cancel/accept. No unexpected browser errors (the two intentionally refused 409 responses are expected).
- Additional independent live server on `127.0.0.1:4351`, own home `/private/tmp/codeflow-qa-continue/homes/merge-repair`, fake CLIs, scratch repositories only. Run `2610260918-7312027f` left an untouched binary conflict: the UI reported unresolved `asset.bin`, follow-up failed without a commit, the result ref did not move, and the worktree was clean after abort. Run `2610260918-4b80a80e` retained `target-only.txt` in Review/coverage after main advanced, then successfully merged that already-visible file into `older`. Run `2610260918-25f31e01` merged a 70 MB text file through HTTP. Browser console/page/5xx capture was empty; server output contained startup/CLI discovery only.
- Evidence: `/private/tmp/codeflow-qa-continue/merge-repair-probe/evidence.json`, probe scripts next to it, screenshots under `/private/tmp/codeflow-qa-continue/shots/merge-repair/` (`001-binary-conflict-warning-visible.png`, `002-imports-visible-after-base-advances.png`). Screenshots were visually inspected.

All new verification used fake agents or adapter stubs; no real-agent evidence is claimed. No live-server or user-repository changes were made. The isolated probe server is stopped after verification. Scratch evidence remains for the integrator.

## Fix result

Commits:
- `723df32` Never commit a conflict resolution that failed or left markers
- `050f0a3` Review a resolved result without what its merge brought in
- `0f34896` Keep every run's result branch out of merge targets
- `886b2ae` Clear git's merge state when a merge's hook outlasts it
- `a777b95` Run a merge's hooks on verified merges into a checkout
- `12367a4` Keep a merge validation across reloads and name its failing gates
- `829a9f4` Say what a local merge does in the review's publish text
- `9a043bb` Cover the merge panel's targets, validation and warnings in the browser

Fixer notes for the integrator: - Base is f14f404, where the branch was created. claude/dogfood-qa-2026-10-25 has since moved to 4c29ded; `git merge-tree` shows this branch merges into it cleanly.
- Existing test edited on purpose: test/merge-tree-pin.test.ts. Verified merges now run a merge's hooks, not the commit hooks, so its pre-commit hook that rewrote the index never fires. It now uses a post-merge hook that commits a change, and still expects /hook changed.*merge was undone/. The rollback message text changed from 'A commit hook changed the verified merge tree…' to 'A hook changed the verified merge tree…'.
- With git 2.39, a pre-merge-commit hook's `git add` is not picked up into the merge commit (I probed this), so finish()'s tree check is what catches hooks that commit.
- Behaviour changes for other clusters:
  - GET /api/branches now tags every branch a run recorded (worktrees and artifacts, archived runs included) as kind 'run', whatever its prefix.
  - listBranches(repo) without the new optional `results` argument behaves as before, so test/patterns.test.ts:279 still passes.
  - Anything filtering on kind === 'local' (the github-pr-open-picker PR target list, t19-17) will now exclude custom-prefix result branches too.
- RunManager.merge has two new refusals, both 400: `into` being any run's result branch, and a branch that adds both <<<<<<< and >>>>>>> lines relative to its merge base with `into`.
- coordinated-api's manager.merge path goes through the same guards.
- reviewBase can return a tre …

## Independent verification

- **t17-1: verified** — Fake server v05 on 4369, started with FAKE_FAIL_VENDOR=claude. Run r1a (fix-review, CONFLICT) in a scratch repo. Original repro in headless Chrome: Merge… > Merge into qa-conflict returned 200 {ok:false, conflicts:[shared.txt]} and the conflict box listed shared.txt. I picked Claude Code and clicked Ask to resolve. f1 ended failed with "claude's turn failed (claude exited with code 1: boom). code-flow undid the merge and committed nothing, so Merge… reports the conflicts again." f1 has no commit. The worktree HEAD stayed e91a990 'codex: fix the issue', there was no MERGE_HEAD, git status was clean, and shared.txt was the run's own version. The summary says "claude couldn't resolve the confli …
- **t17-20: regressed** — The original repro now behaves as expected. Run r1b conflicted with qa-CONFLICT-t, which adds target-only.txt and shared.txt; codex resolved it as f1, and the merge commit's parents are 1b573b9 and 4c43d92. Review page: '1 file · +1 −1', and the changed files list only 'M shared.txt'. target-only.txt does not appear, including at a 390px width. Review tools shows 'Human review coverage · 0/1 files'. The API agrees: /diff, /diff?last=1 and /review-coverage each give only shared.txt, and the artifact stat says 1 file. No console errors. Regression: reviewBase uses the target that was resolved against whatever branch is merged into later. I marked shared.txt reviewed (coverage 1/1, 100%). Then  …
- **t17-2: verified** — Server running with CODEFLOW_MERGE_TIMEOUT_SEC=8, and r2/.git/hooks/post-merge does 'sleep 20'. In the UI, run r2a > Merge into main (checked out), archive off. The API returned 200 after about 9.9 s with {ok:true, method:checkout, warning:'Merged into main, but git was stopped after 8 s…'}. The same warning text showed as the toast (I polled toasts every 200 ms) and as a persistent role=status .msg.warn in the panel; the plain 'Merged into main' did not appear. Checkout state: HEAD is the merge commit with the right parents, and MERGE_HEAD, MERGE_MSG and MERGE_MODE are all gone. git status says 'nothing to commit, working tree clean'. The hook log shows 'start' only, so the hook was killed. …
- **t18-6: verified** — In r3/.git/hooks, I set pre-commit, pre-merge-commit, commit-msg, post-commit and post-merge to log their names, but only when run in the r3 checkout. Run r3a: I ticked Require verification. Before validation Merge was disabled. Validate gave 'Merge verification: verified · target 7bf7f7b1325c · 1 gate · validated just now', then Merge into main returned 200 ok (checkout). Run r3b: plain Merge into main returned 200 ok. The hook log reads '--- REQUIRED r3a: pre-merge-commit, commit-msg, post-merge' and '--- PLAIN r3b: pre-merge-commit, commit-msg, post-merge': the same hooks ran for both. main ended up with two real 2-parent merges, a clean status and no MERGE_HEAD. Variation: a pre-merge-co …
- **t18-7: verified** — Run r3c's check prints 'QA gate output: …' and fails when a flag file exists. (A) Validate gave the status 'Merge verification: verified · target b2c0e0622a7c · 1 gate · validated just now', with the singular 'gate'. (B) Closing and reopening Merge… without a reload kept the status line. (C) After page.reload() and reopening, the status line was still there; ticking Require verification left Merge into main enabled. (D) I created the flag and validated again. The status read needs-changes, and the 'Merge verification gates' list showed 'run-check: failed (required)' with the gate's output in a focusable <pre>. Merge was disabled with Require ticked. (E) After another reload, the needs-change …
- **t17-18: verified** — Review > Publish changes, expanded in headless Chrome. On r1c (no check) the help reads 'Review the diff and evidence before publishing. Merge… merges into the branch you pick as soon as you click Merge, without asking again. Merging a pull request asks you to confirm.' On r3c (with a check) it adds '(tick Require verification there to test the merged result first)'. The old text 'Merge validation and confirmation still apply' is gone in both. The PR claim holds: ui/run.tsx:1451 still calls confirmAction('Merge pull request?'). No browser errors.
- **t17-5: verified** — Run r1c used Result branch name qa-t17 and produced qa-t17/build. Solo run s107 used prefix feat/qa-s10 and produced feat/qa-s10/solo (this covers S10-7). GET /api/branches tags qa-t17/build and feat/qa-s10/solo as kind 'run'; main and the qa-* branches stay 'local'. Run r1b's Merge into options are [qa-md, main, qa-CONFLICT-t, qa-conflict, qa-fixture]: no run branches of any prefix. The composer's Start-from-branch list labels qa-t17/build and feat/qa-s10/solo 'Previous task branch'. Server guard via API: merging into qa-t17/build, feat/qa-s10/solo, or another run's codeflow/* branch each returns 400 '"X" is the result of another run (<id>)…', and none of those branches moved. Merging into  …

Code-review findings:
- [major] `src/engine.ts:6070` reviewBase() starts the Review diff, coverage, risk, artifact stat and verification changedFiles at the target a conflict resolution merged in (f.commit^2), whatever branch the result is merged into later. Merge… into a different branch (reopened, the panel defaults to the base branch) still ships everything that target brought in, but Review and coverage hide it and coverage can read 100%. Reproduced: resolved against qa-CONFLICT-t, reviewed 1/1 files (shared.txt), merged into qa-other (from main), and qa-other gained target-only.txt too. Compute the base against the chosen merge target, or l …
- [minor] `src/git.ts:917` addedConflictMarkers reads the whole -U0 patch of from...to through git(), which stops at 64 MB. A result whose text diff is larger can no longer be merged at all. Reproduced: a commit adding a 70 MB text file made POST /merge return 400 'git diff … failed: git diff printed more than 64 MB', where it merged before this change. Use `git diff -G'^(<{7}|>{7})( |$)' --name-only from...to` first and read only the matching files, or treat the overflow as 'unknown' rather than a refusal.
- [minor] `src/engine.ts:4449` The new conflict-marker merge guard has no override and flags any file to which the branch adds lines starting with <<<<<<< and >>>>>>>. Legitimate content is refused: test fixtures, docs with a fenced conflict example. Reproduced: a committed test/fixtures/conflict.txt made Merge… return 400 'still has conflict markers in test/fixtures/conflict.txt'. It also ignores .gitattributes conflict-marker-size. Consider limiting the check to files that conflicted in a recorded resolution, or offering an explicit 'merge anyway'.
- [nit] `src/engine.ts:6037` unresolvedMerge only looks for text markers. An unmerged path that has none (a binary conflict, modify/delete) counts as resolved when the agent's turn succeeds, and commitAll's `add -A` then commits whichever side happens to be in the working tree. S10-6's fix approach also asked to refuse remaining unmerged paths, at least for files the agent didn't touch.

## Issues

### t17-1 · major · Failed conflict resolver still commits conflict markers, and Merge then ships them into the target

**Fix outcome: fixed.** Root cause confirmed: runFollowUpInWorktree committed every resolve-conflicts follow-up, and commitAll's `add -A` marked the conflicted files resolved even with markers still in them. Changes: (1) src/engine.ts:5900 runFollowUpInWorktree now keeps the mergeBranch result. When the merge conflicted, it calls unresolvedMerge (engine.ts:5980), which reports a failed turn or markers still present in the originally conflicted or unmerged files (new git.ts:906 conflictMarkerFiles reads the working files, so staged markers are caught too). If either is found, abortMerge (engine.ts:5989) runs `git merge --abort`. Both steps are journaled with ctx.remember. Nothing is committed, f.status is set to failed with a clear result ('... code-flow undid the merge and committed nothing, so Merge… reports the conflicts again'), a warning is logged, and the artifact is refreshed (a solo checkpoint commit sta …

Fixer's check: I started QA server f05 (port 4365, fake mode) from the worktree with FAKE_FAIL_VENDOR=claude, using a fresh home and a scratch repo whose qa-conflict branch changes shared.txt and adds target-only.txt. I ran a fix-review 'CONFLICT' run, then went to Run page > Details > Actions > Merge… > Merge into qa-conflict and got the conflict box. I picked Claude Code > Ask to resolve. f1 ended failed with commit undefined and result "claude's turn failed (claude exited with code 1: boom). code-flow undid the merge and committed nothing…". The branch did not move (tip still 'codex: fix the issue'), shared.txt has no markers, the worktree is clean and has no MERGE_HEAD. When I reopened Merge…, the pane …

Tests: `test/qa-merge-ship-conflicts.test.ts: a conflict resolution that fails commits nothing, and merging reports the conflict again`, `test/qa-merge-ship-conflicts.test.ts: a conflict resolution that leaves the markers in commits nothing, and merging reports the conflict again`, `test/qa-merge-ship-conflicts.test.ts: a result with conflict markers committed in it is never merged; a Markdown heading underline isn't one`, `test/e2e/qa-merge-ship-conflicts.e2e.ts`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-19.

**Repro**

> 1. Start a fake QA server with FAKE_FAIL_VENDOR=claude exported (a stand-in for a resolver that fails or does nothing). 2. Add a scratch clone as a project. Create branch qa-conflict with shared.txt holding different content. 3. Start a Fix & review run with 'CONFLICT' in the task (the fake agent writes shared.txt). 4. Run page > Details and publishing > Actions > Merge… > Merge into qa-conflict. The conflict box lists shared.txt. 5. Pick Claude Code > Ask to resolve. 6. Once the follow-up fails, open Merge… again > Merge into qa-conflict.

**Expected:** When conflict markers remain (or the resolver turn failed), code-flow should not commit the merge and should leave the branch unmergeable. At minimum the Merge panel should refuse or warn.

**Actual:** Follow-up f1 is marked failed ('claude exited with code 1: boom'). code-flow still commits 'Merge qa-conflict (conflicts resolved by claude, f1)', and shared.txt contains <<<<<<< ======= >>>>>>> markers. The next Merge… returns ok:true and merges the markers into qa-conflict (ref path, run 2610251600-e3ad4add). The same happened through the checkout path into qa-conflict2 in a linked worktree (run 2610251611-dfeb39c4): git diff --check reports 'leftover conflict marker' on the target.

**Root cause (verifier):** 1. src/engine.ts:5811-5817 (runFollowUpInWorktree): code-flow starts the merge with mergeBranch, leaving the worktree mid-merge with markers in the conflicted files.
2. src/engine.ts:5873-5881: after the agent turn, ctx.commit() runs for resolve-conflicts no matter whether outcome.ok is true. Nothing checks for unmerged paths or leftover markers first. A commit even after a failed turn is intended for comment/reply follow-ups (see the comment at src/engine.ts:5727-5728) but was never excluded for merges.
3. src/git.ts:596-603 (commitAll): `git add -A` marks the conflicted files as resolved, and `if (staged.code === 0 && !(await isMerging(at))) return null` forces a commit whenever MERGE_HEAD exists. The half-done merge is therefore always concluded, markers included.
4. src/engine.ts:5885: f.status is set to "failed" only after the commit has already landed on the result branch.
5. The ship side has no defence either. RunManager.merge (src/engine.ts:4360-4377) and mergeInto/mergeByRef/mergeInCheckout (src/ship.ts:153 onward) never look for conflict markers, so the next Merge… moves the target ref or merges in the checkout and reports ok:true.
6. hasConflictMarkers (src/git.ts:892)  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/git.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/ship.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/ship.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/engine-review.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/github.md`

**Suggested fix:** 1. Guard the resolver commit in src/engine.ts runFollowUpInWorktree. For f.kind === "resolve-conflicts", do these checks before ctx.commit():
   - Was the turn successful (outcome.ok)?
   - Are any paths still unmerged (`git diff --name-only --diff-filter=U`, taken before commitAll's `add -A`)?
   - Do the files being committed still contain conflict markers? Use a new git.ts helper, e.g. leftoverConflictMarkers(at): run `git add -A` then `git diff --cached --check` (or scan the originally conflicted files for /^(<{7}|={7}|>{7})( |$)/m) and return the file names.
   If any check fails:
   - Run `git merge --abort` (journaled with ctx.remember, so a resume does not redo it), putting the branch back at its pre-merge state. The solo pattern's "Checkpoint before merge" commit already keeps earlier edits.
   - Skip the commit and set f.status="failed" with a clear result, e.g. "Conflict markers remain in shared.txt; the merge was not committed. Merge… will report the conflict again."
   - L …

**Suggested regression test:** 1. In test/ship.test.ts, next to "conflicts are reported, and an agent can resolve them in the run's worktree", add "a failed or incomplete conflict resolution is not committed and cannot be merged":
   - Set up the same pipeline run and a "conflicting" branch.
   - Use withStub(["claude"], ...) to return {ok:false, error:"boom"} without touching files, then send followUp {kind:"resolve-conflicts", agent:"claude", mergeFrom:"conflicting"} and wait for the run to finish.
   - Assert: f.status === …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this on a fresh fake-mode QA server, v4661t171. I used port 4663 because 4661 was already held by another verifier's server (home v4659t1415).
1. I made a scratch bare clone and a working clone of MQTT-MCP (clones/v4661t171-mqtt). In the clone I created branch qa-conflict from main and committed shared.txt = "their version of shared".
2. I started the server with `qa-server.sh start v4661t171 4663 fake` and added the clone through the UI (Open another repository > Create project).
3. In the composer I chose Run options > Advanced > Fix & review and gave the task "QA v4661t171: CONFLICT write shared file". Run 2610252145-4e6947c7 finished as done: codex built, claude reviewed, and the worktree's shared.txt held "written by codex 498d1577".
4. I restarted the server with FAKE_FAIL_VENDOR=claude exported, so a claude write turn fails with "boom".
5. On the run page I opened Details and publishing > Actions > Merge… and clicked Merge into qa-conflict. The response was 200 {ok:false, conflicts:["shared.txt"]} and the conflict box listed shared.txt. I picked Claude Code and clicked Ask to resolve (POST /followups 200).
6. Follow-up f1 ended failed ("claude exited with code 1: boom"), but f1.commit=56d44f7 was set anyway. The worktree HEAD was "Merge qa-conflict (conflicts resolved by claude, f1)" with parents 0c666d6 and 40073be, git status was clean and there was no MERGE_HEAD. HEAD:shared.txt held the <<<<<<< HEAD / ======= / >>>>>>> qa-conflict markers, and `git diff --check HEAD^ HEAD` printed "leftover conflict marker" three times (exit 2). The run page said "Finished", the step said "Didn't finish" and the summary said "claude couldn't finish in build".
7. I opened Merge… again; the panel showed no warning. Merge into qa-conflict returned 200 {ok:true, method:"ref"} and the toast "Merged into qa-conflict". qa-conflict moved 40073be -> eb7d051, and qa-conflict:shared.txt now holds the conflict markers (`git diff --check` reports leftover conflict markers). The Merge panel's default target is main with "Archive the run afterwards" ticked, so the same markers would go into a checked-out main the same way.

Refutation attempts:
- Not by design. docs/github.md:24 says the agent "fixes the markers. Then merge again", and docs/github.md:18 says Merge… happens "only when that's safe". The resolver prompt itself demands "remove all conflict markers". The team patterns guard against exactly this case with hasConflictMarkers (src/patterns/team-strategies …

</details>

### S10-6 · major · The 'resolve-conflicts' follow-up runs with allowFailure:true, then commits 'Merge X (conflicts resolved by …)' unconditionally, never calling hasConflictMarkers; a failed agent or leftover markers end up in a merge commit on the result branch.

**Fix outcome: duplicate.** Duplicate of t17-1, which carries the fix: the resolver commit is guarded and the merge aborted in src/engine.ts runFollowUpInWorktree / unresolvedMerge / abortMerge, and RunManager.merge refuses results that add conflict markers.

Fixer's check: I re-ran the S10-6 repro on QA server f05: a solo codex run with checkpointOnFinish, main changed shared.txt, Merge… into main conflicted, and Claude Code > Ask to resolve with FAKE_FAIL_VENDOR=claude. f1 failed with commit undefined, the branch tip was unchanged, Merge into main again reported conflicts [shared.txt], and main:shared.txt stayed "main's own version".

Tests: `test/qa-merge-ship-conflicts.test.ts: a conflict resolution that fails commits nothing, and merging reports the conflict again`

Source: code-level suspect at `src/engine.ts:5874` (confirmed hands-on).

**Repro**

> Fake server s10 started with FAKE_FAIL_VENDOR=claude (fake claude exits 1 'boom' on write steps). Scratch repo: run C (solo, codex, checkpointOnFinish) committed shared.txt='written by codex …'; then I committed a different shared.txt on main. In the UI, Run C > Details and publishing > Actions > Merge… > into main (archive-after unchecked) > 'Merging would conflict in 1 file: shared.txt'. I picked 'Claude Code' and clicked 'Ask to resolve'. The follow-up ended status=failed, result 'claude exited with code 1: boom', yet commit 72456ae 'Merge main (conflicts resolved by claude, f1)' (parents 187aa89 + 158210c) was on codeflow/…/solo. Its shared.txt contains <<<<<<< HEAD / ======= / >>>>>>> main. The run page said only 'claude couldn't finish in solo' (screenshot shots/s10/003-C-after-resolve.png). Clicking Merge into main again succeeded ('Merged into main'), and scratch main:shared.txt then held the conflict markers (commit 29b6260). Scripts: work/s10/05-merge-conflict.mjs, 06-merge-again.mjs.

**Expected:** If the agent fails, or conflict markers or unmerged paths remain, Code Flow does not record a merge commit. It aborts or keeps the merge uncommitted, marks the follow-up failed with a clear 'conflicts not resolved' message, and the result branch stays mergeable only in a clean state.

**Actual:** A merge commit carrying literal conflict markers is created on the result branch whatever the outcome, and the run can then merge it into the target branch without warning. With no check configured, nothing flags it.

**Root cause (verifier):** runFollowUpInWorktree starts the merge (mergeBranch), runs ctx.ask with allowFailure:true, then calls ctx.commit(...) unconditionally for non-reply kinds. commitAll does git add -A, which marks unmerged paths as resolved, and commits because isMerging(at) is true. Neither outcome.ok nor hasConflictMarkers (git.ts:892, used in patterns/team-strategies.ts:20 and auto-team.ts:390) nor unmerged paths are checked before committing.

**Suggested fix:** For kind 'resolve-conflicts', before ctx.commit: collect unmerged paths (git diff --name-only --diff-filter=U) and run hasConflictMarkers, plus a grep for ^(<<<<<<<|=======|>>>>>>>) in the originally conflicted files after staging. If !outcome.ok, or markers or unmerged paths remain, do not commit. Run git merge --abort (or reset to `before`), set f.status='failed' with 'Conflicts were not resolved; nothing was committed', and log a warning. Only commit the merge when it is clean.

**Suggested regression test:** Engine test with the fake agent: (a) FAKE_FAIL_VENDOR set to the resolving vendor, the resolve-conflicts follow-up leaves the result branch head equal to `before` with no merge commit and no MERGE_HEAD; (b) an agent that exits 0 but leaves markers is also not committed; (c) the existing happy path still produces the merge commit.

### t17-20 · minor · After conflict resolution, Review shows the merge target's own changes as part of the run's result

**Fix outcome: fixed.** New reviewBase(run, worktree, head) in src/engine.ts:6011 (and mergedIn at :5998). It takes the latest done resolve-conflicts follow-up whose commit is in head's history. Its merged-in target T is `${f.commit}^2`, so this works for existing runs without a schema change. The changes start at T when it contains the run's base. Otherwise they start at the tree from `git merge-tree --write-tree baseRef T`, falling back to baseRef if that conflicts. It is used for: the Review diff (engine.ts diff(), including the solo workspaceDiff path), reviewCoverage (files, coverage, risk), verification changedFiles (engine.ts:1654), the artifact stat and test-integrity base (TeamContext.artifact), and conversationResult. The last-step view of a resolution merge commit (engine.ts:3771) now lists only files that differ from both parents. docs/github.md describes this.

Fixer's check: On QA server f05, after the failed claude resolution, I picked Codex > Ask to resolve. f2 was done, and the tip was 'Merge qa-conflict (conflicts resolved by codex, f2)' with 2 parents. /diff returned only [modified shared.txt], and /diff?last=1 also [shared.txt]. /review-coverage gave files [shared.txt] with changed=1 and low risk, and the artifact stat named only shared.txt. In the UI, the Review header read '1 file · +1 −1' and listed only shared.txt (target-only.txt from qa-conflict is gone). Review tools > Human review coverage read '0/1 files'. No browser errors. Unit tests cover a target that contains the base and one that does not (run based on another branch, which uses the merge-tr …

Tests: `test/qa-merge-ship-conflicts.test.ts: a resolved conflict is committed, and the review shows only the run's changes, not what the target brought in`, `test/qa-merge-ship-conflicts.test.ts: after resolving with a target that doesn't hold the run's base, the review still leaves out the target's changes`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-19, GIT-10, GIT-13.

**Repro**

> 1. Target branch qa-conflict adds target-only.txt and shared.txt. 2. A run that conflicts on shared.txt uses Ask to resolve, and the resolution succeeds. 3. Open the run's Review.

**Expected:** Review, coverage and risk show the run's changes relative to the integration target, or label the brought-in target changes.

**Actual:** The changed files list includes target-only.txt, which came from the target, as if the run wrote it. Coverage asks the human to review it.

**Root cause (verifier):** src/engine.ts:5815: a resolve-conflicts follow-up runs mergeBranch(run.repo, wt, f.mergeFrom), merging the target into the result branch. engine.ts:5874-5879 commits that as a 2-parent merge whose second parent is the target commit. Nothing records the target commit as integrated, and run.baseRef is never adjusted. Every reviewer-facing view diffs from run.baseRef, so all of the target's changes since the run started show up as the run's: (a) engine.ts:3754 `if (!last) return branchDiff(run.repo, run.baseRef, branch)`, the Review changes file list (engine.ts:3752 does the same for solo uncommitted work through workspaceDiff(..., run.baseRef)); (b) engine.ts:3756-3758, the `last` view, diffs `${branch}~1..branch`, which for the merge commit is the first-parent diff and so presents the whole target as the resolver's change; (c) engine.ts:4285 `branchDiff(run.repo, run.baseRef, head)` in reviewCoverage(), which feeds the coverage file list and assessChangeRisk(files) at 4290; (d) engine.ts:1652, the changedFiles passed to verification (verification.risk/review). src/ship.ts:45-47 branchDiff is a plain two-dot tree diff `${base}..${branch}`, so it cannot exclude merged-in content. The  …

**Files:** `src/engine.ts`, `src/ship.ts`, `ui/review.tsx`, `ui/changes.tsx`, `ui/review-coverage.tsx`, `docs/github.md`, `test/ship.test.ts`

**Suggested fix:** Derive the integrated target commits from the run's own history; no schema change is needed and it works for existing runs. For each done resolve-conflicts follow-up on this worktree whose f.commit is reachable from head, the integrated commit T is `${f.commit}^2` (keep f.mergeFrom for the label). Add an engine helper, e.g. reviewBase(run, branch, head) -> { base, integrated: [{ref: mergeFrom, commit}] }: if baseRef is an ancestor of the latest T (git merge-base --is-ancestor), use base = T, as GitHub does after you update a PR from its base (merge-base(head, T) = T). Otherwise synthesize a base tree with `git merge-tree --write-tree baseRef T`, falling back to baseRef plus labels if that merge conflicts. Use that base in diff() (engine.ts:3754 and the solo workspaceDiff path at 3752), reviewCoverage() (4285, which feeds coverage and risk) and the verification changedFiles (1652). For `last` on a merge follow-up commit, diff `${commit}^2..${commit}` (only the resolution) instead of `~1 …

**Suggested regression test:** test/ship.test.ts, test "conflicts are reported, and an agent can resolve them in the run's worktree": on the `conflicting` branch also commit target-only.txt. After the resolve-conflicts follow-up finishes, assert deepEqual((await manager.diff(run.id, branch)).map(f => f.path), [file]); deepEqual((await manager.reviewCoverage(run.id, branch)).files, [file]); and deepEqual((await manager.diff(run.id, branch, true)).map(f => f.path), [file]), meaning the last-step view shows only the resolution.  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4601t1720 on 127.0.0.1:4601. Scratch clone: bare clone of MQTT-MCP at clones/v4601t1720-mqtt.git plus working clone clones/v4601t1720-mqtt. In the clone I created branch qa-conflict from main (2b97323, which is also the run's baseRef); commit 4bea37a adds target-only.txt ("target-only change") and shared.txt ("target version of shared"). UI steps: (1) "Open another repository", then New project "v4601 conflict". (2) Composer task "QA v4601: CONFLICT write shared file", workflow fix-review, check empty. Run 2610252158-59fb6195 finished with branch codeflow/2610252158-59fb6195/build. Coverage at that point: files [shared.txt]. (3) Details > Merge… into qa-conflict with archive off returned {ok:false, conflicts:[shared.txt]}. In the conflict box I picked Codex and clicked "Ask to resolve". Follow-up f1 (resolve-conflicts, codex) finished; commit 077c99e has parents 2618021 and 4bea37a, message "Merge qa-conflict (conflicts resolved by codex, f1)". (4) Clicked "Review changes". The header read "2 files · +2 −0". Changed files listed "A shared.txt +1" and "A target-only.txt +1"; clicking target-only.txt showed "+target-only change" as a commentable diff. Review tools > Human review coverage read "0/2 files · low change risk" with a Reviewed checkbox for both shared.txt and target-only.txt (screenshot shots/v4601t1720/003-coverage.png). (5) API checks: /diff returned [shared.txt added, target-only.txt added]; /diff?last=1 returned [shared.txt modified, target-only.txt added]; /review-coverage returned files [shared.txt, target-only.txt] and coverage changed=2. (6) git: `git diff branch^2 branch` gives only "M shared.txt", and the target-only.txt blob is identical on the run branch and on qa-conflict (a9a82e1). So the file comes purely from the merge target. No console errors or 5xx responses. Not by design: docs/github.md:24 says only that code-flow merges the target into the result branch and the agent fixes the markers, and the engine already treats merged-in changes as someone else's (engine.ts:5887 skips test-integrity checks for resolve-conflicts for that reason). Cleanup: run archived with worktrees and branches removed, then deleted through the UI; server stopped; scratch clones removed.

</details>

### t17-2 · major · Merge timeout in a slow post-merge hook leaves the user's checkout mid-merge; the UI only says 'Merged'

**Fix outcome: fixed.** src/ship.ts:247, mergeInCheckout timeout branch: once the merge commit is confirmed and the checkout is still mid-merge, it runs `git merge --quit`. This removes MERGE_HEAD/MERGE_MSG/MERGE_MODE (via the checkout's git dir, so linked worktrees work too) and keeps whatever the hook wrote. If the quit fails, the warning says the checkout is still mid-merge and to run `git merge --quit` there. ui/run.tsx:1365, MergePanel.merge: when outcome.warning is set, the warning is shown as a 12 s toast (noting the archive) and as a persistent role=status notice in the panel, instead of a plain 'Merged into'. docs/github.md and docs/configuration.md updated.

Fixer's check: I started QA server f05 with CODEFLOW_MERGE_TIMEOUT_SEC=8 and added a 'sleep 20' post-merge hook to the scratch checkout (main checked out). On the run page, Merge… > Merge into main (Archive left ticked) returned ok with method checkout and warning 'Merged into main, but git was stopped after 8 s…'. The toast showed that warning plus 'The run was archived.', and the panel showed it persistently (screenshot shots/f05/005-t17-2-toast.png). The checkout had no MERGE_HEAD, MERGE_MSG or MERGE_MODE, and git status said 'nothing to commit, working tree clean' with no 'still merging'. With the hook removed, the next run's Merge into main succeeded instead of returning 400 'in the middle of another  …

Tests: `test/qa-merge-ship-conflicts-ship.test.ts: stopped in a slow post-merge hook in your checkout, the merge is done and git's merge state is cleared`, `test/qa-merge-ship-conflicts-ship.test.ts: stopped in a slow post-merge hook in a linked worktree, the merge is done and git's merge state is cleared`, `test/e2e/qa-merge-ship-conflicts.e2e.ts`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-17.

**Repro**

> 1. Start the server with CODEFLOW_MERGE_TIMEOUT_SEC=8. 2. In the scratch clone add .git/hooks/post-merge with 'sleep 20' (executable). 3. Open a finished run's Merge… panel, keep main (checked out in the clone), click Merge into main. 4. Run git status in the clone.

**Expected:** The merge counts as done (as documented), but git's merge state is cleaned up, or the user is clearly told the checkout still has MERGE_HEAD. The warning should be shown in the merge panel or toast.

**Actual:** The API returns ok with a warning ('git was stopped after 8 s...'), but the toast says only 'Merged into main'. The warning appears only under Details > Activity log. The checkout keeps MERGE_HEAD, MERGE_MSG and MERGE_MODE: git status says 'All conflicts fixed but you are still merging'. The next Merge… into main is refused ('is in the middle of another merge') until the user runs git merge --abort. Reproduced on main and on qa-conflict2 checked out in a linked worktree.

**Root cause (verifier):** 1) src/ship.ts:245-253, the timeout branch of mergeInCheckout. When git times out after making the merge commit (head !== before and parents === "<before> <merging>"), it returns finish(head, warning) without cleaning up merge state. Git runs the post-merge hook before it removes MERGE_HEAD, MERGE_MSG and MERGE_MODE, so the SIGKILL of the process group (src/git.ts:112-122) leaves all three in the checkout's git dir. The branch checks only for a leftover index.lock (line 250). The midMerge() cleanup at lines 263-268 is never reached because the function returns at line 253. The warning text (line 251) does not say the checkout is still mid-merge either.

2) ui/run.tsx:1356 (MergePanel.merge): `if (outcome.ok) showToast(`Merged into ${target}${archiveAfter ? " and archived the run" : ""}`, 3000)` ignores outcome.warning, although MergeOutcome declares warning?: string (src/ship.ts:131-134). The only place it surfaces is src/engine.ts:4373, a "warn" line in the collapsed Activity log. With the default "Archive the run afterwards" checked, that log belongs to a run that is already archived.

3) The existing regression test, test/github-review.test.ts:277-297, asserts ok, warning, HEAD  …

**Files:** `src/ship.ts`, `ui/run.tsx`, `test/github-review.test.ts`, `docs/configuration.md`, `docs/github.md`

**Suggested fix:** src/ship.ts: in the res.timedOut branch, after confirming the merge commit (head !== before and parents match), clean up the merge state.
- Condition: `await midMerge(at)` and MERGE_HEAD resolves to `merging`.
- Command: `git merge --quit` in `at` (git ≥ 2.23). It removes MERGE_HEAD, MERGE_MSG and MERGE_MODE and leaves the index and working tree as they are, keeping anything the hook already wrote. Do not use `git merge --abort`, which would reset hook changes. Run it with the normal short git timeout and hooks off. Alternatively, unlink the three files resolved through `git rev-parse --git-path MERGE_HEAD MERGE_MSG MERGE_MODE`, so linked worktrees are handled.
- If index.lock was left behind, or the cleanup fails, extend the warning: "...and left <checkout> mid-merge (MERGE_HEAD); run `git merge --quit` there before committing".

ui/run.tsx MergePanel.merge: when outcome.warning is set, show it, either as the toast (e.g. `Merged into ${target}. ${outcome.warning}`, kept up about 10 s  …

**Suggested regression test:** test/github-review.test.ts, extend "a merge whose post-merge hook outlasts git's time is reported done, with a warning" (line 277):
- `assert.equal(existsSync(join(r, ".git", "MERGE_HEAD")), false)` and the same for MERGE_MSG and MERGE_MODE;
- `assert.doesNotMatch(sh(r, "status"), /still merging/)`;
- after removing the hook, merge a second branch into main with `mergeInto` and assert it succeeds rather than throwing "is in the middle of another merge".
I verified the first assertion fails on th …

<details><summary>Verifier's independent reproduction</summary>

Fresh QA home: I moved the old v4663 home aside to homes/v4663.prev-1792964649. Port 4663 was held by another verifier's server (home v4661t171), so I used my extra port 4665. I exported CODEFLOW_MERGE_TIMEOUT_SEC=8 and started the server in fake mode ("qa-server.sh start v4663 4665 fake"); ps confirmed the env var reached the server. I made a scratch clone of MQTT-MCP (clones/v4663-t172.git plus a working clone with main checked out) and added it in the UI ("Open another repository" > new project "v4663 MQTT"). From the composer I started two fake fix-review runs (2610252145-0645019f and 2610252145-ff5ace32); both finished with one commit each on codeflow/<id>/build. Earlier solo runs had left their change uncommitted, so I did not use them.

Merge 1 (work/v4663/t17-2/a3-merge.mjs): I installed .git/hooks/post-merge in the clone ("sleep 20", chmod 755), opened run 1's Merge… panel, kept "main", unchecked Archive and clicked "Merge into main".
- API: 200 after 8.8 s with {ok:true, method:"checkout", warning:"Merged into main, but git was stopped after 8 s, once the merge commit was made: a post-merge hook ... may not have finished in <clone>."}.
- UI: the only toast, polled every 200 ms, was "Merged into main" (shots/v4663/002-after-merge-toast.png). The panel shows only a green "Merged into main" badge, and the run page shows no warning in its default view.
- The warning exists only in the collapsed "Activity log (5) · 1 warning" (shots/v4663/002-activity-log-warning.png), and it does not mention merge state.
- Clone after the merge: HEAD is the correct merge commit f89077d (parents 2b97323 + 924ef0e), `git status --porcelain` is clean, and MERGE_HEAD, MERGE_MSG and MERGE_MODE all exist. `git status` says "All conflicts fixed but you are still merging. (use "git commit" to conclude merge)". The hook log shows "start" but no "done" (the process group was SIGKILLed), and no index.lock is left.

Merge 2 (a4-merge2.mjs): with the hook removed I merged run 2 into main from its Merge… panel. The API returned 400 "<clone> is in the middle of another merge. Finish it, or run `git merge --abort` there, then merge again." and the same text appeared as a toast.

Extra consequences, tested on throwaway rsync copies of the clone:
(a) Following git's own hint (`git commit --no-edit`) creates a second, empty merge commit ede5e57 with parents f89077d + 924ef0e.
(b) The user's next unrelated `git commit -am "my unrelated work"` silently becomes a merge commit with the run …

</details>

### t18-6 · minor · With 'Require verification' on, a merge into a checked-out branch skips the user's pre-merge-commit and post-merge hooks

**Fix outcome: fixed.** src/ship.ts:232 mergeInCheckout: a verified merge (expected.tree) no longer uses `--no-commit` followed by `git commit`. Before the checkout is touched, a side-effect-free `git merge-tree --write-tree expected.target expected.source` preflight refuses a different tree (git >= 2.38). Then the same `git merge --no-ff` as a plain merge runs, so pre-merge-commit, commit-msg and post-merge run, and the commit hooks do not. finish() still checks the committed tree and rolls back with `reset --merge` when a hook changed it; its message now says 'A hook changed…' rather than 'A commit hook changed…'. The timeout handling now applies to verified merges as well. docs/verification.md says so.

Fixer's check: On QA server f05 I installed pre-commit, pre-merge-commit, commit-msg, post-commit and post-merge hooks that log their names when run in the main checkout. Run F: Merge… > tick Require verification > Validate ('verified') > Merge into main; it returned ok, method checkout. Run G: plain Merge into main. hook.log showed verified: pre-merge-commit,commit-msg,post-merge and plain: pre-merge-commit,commit-msg,post-merge, so the two now match. No browser errors. A unit test compares the hook logs of a plain and a verified mergeInto and checks HEAD^{tree} === expected.tree. The edited test/merge-tree-pin.test.ts covers rollback when a merge hook changes the verified tree.

Tests: `test/qa-merge-ship-conflicts-ship.test.ts: a merge that requires verification runs the same hooks as any other merge into your checkout`, `test/merge-tree-pin.test.ts (edited)`

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-20, GIT--GAP-01.

**Repro**

> 1. Scratch clone with main checked out. Add .git/hooks/pre-commit, pre-merge-commit and post-merge that each append their name to a log.
> 2. Two finished fix-review runs with check 'true'.
> 3. Run A: Merge… → tick 'Require verification…' → Validate → Merge into main.
> 4. Run B: Merge… with Require unticked → Merge into main.

**Expected:** The same user hooks run for both merges, as docs/security.md says ('Your own hooks still run … when code-flow merges a result into your checkout'), e.g. a post-merge `npm install`.

**Actual:** Required merge: only pre-commit ran. Plain merge: pre-merge-commit and post-merge ran. Reproduced on t18 (hook.log) and t18f (hook2.log).

**Root cause (verifier):** The cause is in src/ship.ts, `mergeInCheckout`.

- **Line 232:** when `expected?.tree` is set (Require verification, and coordinated shipping), the merge runs as `git merge --no-ff --no-commit -m <msg> <branch>`. With `--no-commit`, git never creates the merge commit itself, so it never invokes pre-merge-commit (that hook only runs when `git merge` auto-commits) or post-merge (that hook only runs after `git merge` completes a merge).
- **Line 233:** `git write-tree` checks the tree against the validated tree.
- **Line 242:** the merge is concluded with `git commit -m <msg>`. That runs the commit hook set instead: pre-commit, prepare-commit-msg, commit-msg and post-commit.

The unverified path (the same line 232 without `--no-commit`) runs pre-merge-commit, commit-msg and post-merge. So the hooks the user gets depend on whether verification was required.

- **src/engine.ts:4369** passes `verified` (with `.tree`) whenever `input.requireValidation` is set.
- **src/coordinated-api.ts:121** always sets it for coordinated shipping.

The flow came in with commit daf3108 ("Harden execution and add verified workspace workflows"). No doc or comment says these hooks are skipped on purpose. Th …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/ship.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/git-reliability.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/verification.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/security.md`

**Suggested fix:** Make the verified merge run the same `git merge` as the plain merge, so the hook set matches by construction.

1. In `mergeInCheckout` (src/ship.ts:232-243), when `expected?.tree` is set, drop `--no-commit` and the follow-up `git commit`.
2. Keep the "never commit an unverified tree" gate with a side-effect-free preflight before touching the checkout. Run `git merge-tree --write-tree <expected.target> <expected.source>` in `at`; `mergeByRef` already does this and needs git 2.38. If the resulting tree differs from `expected.tree`, refuse with the existing "different tree than validation… validate again" error.
3. Then run `git merge --no-ff -m <msg> <branch>` with the same `options` (hooks enabled, CHECKOUT_TIMEOUT_MS). This runs pre-merge-commit, commit-msg and post-merge exactly as a plain merge does.
4. Keep `finish()` (lines 223-230) as the post-commit guard. It already compares `${commit}^{tree}` with `expected.tree` and rolls back with `git reset --merge expected.target`, which ca …

**Suggested regression test:** Add a test to test/git-reliability.test.ts, next to the existing "your post-merge hook ran on the merge into your checkout" test at lines 354-364, or as its own test using `repoWithWorktree`:

1. Install pre-commit, pre-merge-commit and post-merge hooks in `<repo>/.git/hooks` that append their name to a file.
2. Commit a change on the run branch with `commitAll`. Leave main checked out and clean.
3. Compute `expected = { source: rev-parse(branch), target: rev-parse(main), tree: <first line of gi …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4613h" on port 4613, with a new, empty home at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4613h.

Setup:
1. Made a scratch bare clone and a working clone of MQTT-MCP (clones/v4613-mqtt, with main checked out).
2. Installed pre-commit, pre-merge-commit, commit-msg, post-commit and post-merge hooks in .git/hooks. Each one appends its name to work/v4613/hook.log, but only when its pwd is the main checkout.
3. Added the clone through the UI ("Open another repository" → New project "v4613 hooks").
4. Created four fix-review runs through the API with loop.check "true". All finished as done.

Merges (all through the UI: Review changes → Publish → Actions → Merge… panel, Archive unticked):
- Run A: ticked "Require verification of the current merge target" → Validate merge result (showed "verified · 1 gates") → Merge into main.
- Run B: Require unticked → Merge into main.
- Runs C and D: the same in reverse order (plain first, then verified), to rule out ordering.

Script: work/v4613/h01.mjs and h02.mjs; output in h01.log and h02.log.

hook.log:
```
--- merge REQUIRED (verified) A: pre-commit, commit-msg, post-commit
--- merge PLAIN B: pre-merge-commit, commit-msg, post-merge
--- merge PLAIN C: pre-merge-commit, commit-msg, post-merge
--- merge REQUIRED (verified) D: pre-commit, commit-msg, post-commit
```
All four were real two-parent merge commits on the checked-out main, and the checkout was clean afterwards. The UI only said "Merged into main", with no warning, and there were no console or 5xx errors.

A bare-git probe gives the same split: `git merge --no-ff --no-commit` then `git commit` (or `git merge --continue`) runs pre-commit, commit-msg and post-commit. A plain `git merge --no-ff` runs pre-merge-commit, commit-msg and post-merge. This happens on git 2.39.5.

Refutation attempts failed:
- Not the tester's script or browser profile: fresh home, fresh browser, my own selectors.
- Not ordering: the result is the same with plain-first.
- Not environmental: git itself defines this behaviour.
- Not by design. docs/security.md:97 says "Your own hooks still run where you'd expect them: when code-flow merges a result into your checkout". docs/github.md:21 and docs/configuration.md:103 promise a post-merge `npm install` / LFS has time to run on Merge…. docs/verification.md:17 describes only tree pinning and commit-hook change detection, with no hook exempti …

</details>

### t18-7 · minor · Merge panel forgets a completed validation after reload, and never shows which gate failed

**Fix outcome: fixed.** ui/run.tsx:1342, MergePanel: the validation shown is the server's run.mergeValidation for this branch, or a newer POST result held in local state, so it survives closing the panel and reloading. `validated`, which enables Merge under Require verification, is derived from that. The status line now reads 'N gate(s)' with correct pluralisation and adds 'validated <ago>'. A validation that is not verified renders the new MergeValidationGates list (ui/run-evidence.tsx:33): each gate's title or id, diagnosis, (required), reason, the last 2000 characters of its last attempt's output in a focusable <pre>, and skipped gates. The target select gets aria-label 'Merge into'. styles.css has small styles for the list.

Fixer's check: On QA server f05 I made a fix-review run with check `test ! -e <flag>` and went to Review > Publish changes > Merge… > Validate. The status read 'Merge verification: verified · target 0776fcc4d757 · 1 gate · validated just now'. After page.reload() and reopening Merge…, the same status was shown, and ticking Require verification left 'Merge into main' enabled. I then created the flag and validated again. The status read 'needs-changes', the gate list read 'run-check: failed (required)', and Merge was disabled (screenshot shots/f05/004-t18-7-failed-gate.png). No browser errors. The e2e covers both cases plus an axe scan of the panel (0 violations).

Tests: `test/e2e/qa-merge-ship-conflicts.e2e.ts`

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-20.

**Repro**

> 1. Run with a check or profile. Review → Merge… → Validate merge result → 'Merge verification: verified'.
> 2. Reload the page, open Merge…, tick 'Require verification…'.
> 3. Separately, validate a run whose required gate fails.

**Expected:** The panel shows the server's saved run.mergeValidation (verified for this target/source) so the user does not re-run a possibly long check. A failed validation shows the failing gate and its output.

**Actual:** After reload there is no status line and Merge is disabled until validation is run again, although GET /api/runs/:id still has mergeValidation. A failure shows only 'Merge verification: needs-changes · target … · 2 gates', with no gate name or output anywhere in the UI.

**Root cause (verifier):** ui/run.tsx:1337 `const [validation, setValidation] = useState<MergeValidation | null>(null);` keeps the result only in MergePanel's own component state. The panel is unmounted whenever the user toggles Merge…, navigates, or reloads, and the state is never seeded from or synced with `run.mergeValidation`. The server persists that field (src/engine.ts:4349-4356, emitted by emitRun with strip() keeping it) and honours it in merge() (src/engine.ts:4367-4368). ui/run.tsx:1340 computes `validated` only from that local state, so the Merge button at :1378 (`requireValidation && !validated`) stays disabled after a reload even though the server would accept the merge. ui/run.tsx:1382 renders only `report.state`, the short target sha and `report.checks.length`. It never iterates `report.checks` (check.id/title, diagnosis, reason, attempts[].output) or `report.skipped`, so a failed validation never says which gate failed or why.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-evidence.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ux-flows.e2e.ts`

**Suggested fix:** In MergePanel, use the server record as the source of truth. Derive `const saved = validating ? null : (validation ?? run.mergeValidation ?? null)`, or seed and resync with `useEffect(() => setValidation(run.mergeValidation ?? null), [run.mergeValidation])`, and compute `validated` and the status line from it. Keep the existing branch/into match, and optionally show "validated <time ago>" from `at`. The server still rejects a stale result if refs moved, so seeding is safe. For failures, render a compact per-gate list under the status when `report.state !== "verified"`, or always inside a <details>: `check.title ?? check.id`, diagnosis, "(required)", reason, and the tail of the last attempt's output in a <pre>, plus `report.skipped` reasons. Put the list in a small `MergeValidationGates` component next to VerificationEvidence in ui/run-evidence.tsx, which already renders this gate shape for run.verification, so the two views stay consistent. Optionally also fix the "1 gates" pluralisati …

**Suggested regression test:** Extend test/e2e/ux-flows.e2e.ts, which already opens Merge… and waits for "Validate merge result". Use a run with loop.check "true": click Validate and wait for role=status "Merge verification: verified". Then page.reload(), reopen Publish changes → Merge…, and assert that the status still contains "Merge verification: verified" and that, after ticking "Require verification of the current merge target", the "Merge into <base>" button is enabled. Add a second case with a check that fails only at  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4615t18" on 127.0.0.1:4615 with a fresh home (no runs), plus a scratch clone at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4615t18-mqtt (bare origin v4615t18-mqtt.git). I added it through the UI ("Open another repository", new project "v18 MQTT"). I started a run from the composer with Advanced workflow "loop" (because solo leaves changes uncommitted, and the Merge panel then isn't offered). Its check was `test ! -e <work>/fail-flag`. The run finished done/passed with 2 commits on codeflow/2610252206-2d7136c0/loop. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4615t18/ (a02-validate.mjs, a02.log).
A. Review → Publish changes → Merge… → Validate merge result. The status read "Merge verification: verified · target 2b97323ce7d2 · 1 gates". With "Require verification" ticked, Merge was enabled. The server's run.mergeValidation was {branch,into:main,tree:5f68099…,report.state:verified,gates:[run-check passed]}.
B. Clicking Merge… off and on again, with no reload: no status element remained (role=status count 0). Closing the panel alone is enough to lose the result.
C. After page.reload() and reopening Merge…: no status line. "Require verification" is unticked by default, which is by design: `!!run.loop.verification`, and this run only has a check. Ticking it left "Merge into main" disabled. Both GET /api/runs/:id via the API helper and a fetch from inside the page still returned mergeValidation {state: verified, into: main}. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4615t18/002-C-after-reload.png
D. I created the flag file and clicked Validate again. The UI showed only "Merge verification: needs-changes · target 2b97323ce7d2 · 1 gates". The server report had gate {id: run-check, required: true, diagnosis: failed, ok: false}. The gate id and diagnosis appear nowhere on the page. The command text is visible only in the unrelated "Not proven" banner. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4615t18/003-D-failed.png
No console errors and no 5xx responses. Reproduced once, deterministically.
Refutation checks: docs/verification.md:17 and docs/api.md:51-52 describe validatio …

</details>

### t17-18 · minor · Review publish text promises a confirmation that local Merge does not have

**Fix outcome: fixed.** Per the planner's note, I changed the text rather than adding a dialog. ui/review.tsx:149, Review > Publish changes help now reads 'Review the diff and evidence before publishing. Merge… merges into the branch you pick as soon as you click Merge, without asking again (tick Require verification there to test the merged result first). Merging a pull request asks you to confirm.' The parenthetical only appears when the run has a check or verification profile, which is when that checkbox exists.

Fixer's check: On QA server f05, the publish help in Review > Publish changes read exactly the new text: with the parenthetical for a run with a check, and without it for the fix-review run that has none. It no longer mentions 'confirmation still apply'. The e2e asserts the text.

Tests: `test/e2e/qa-merge-ship-conflicts.e2e.ts`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-15.

**Repro**

> Open Review > Publish changes, then Merge… > Merge into a branch.

**Expected:** A confirmation, or text that matches what happens.

**Actual:** The text says 'Merge validation and confirmation still apply.' The merge runs immediately on click, with no confirmation (and no validation when no check is configured).

**Root cause (verifier):** ui/review.tsx:149 shows the hard-coded help text "Merge validation and confirmation still apply." above the ArtifactCard in Review > Publish changes. It was added in commit 61c3b23 (PR #31); that commit did not add any confirmation to the local merge.

The local merge path does not do what the text says:
- ui/run.tsx:1351-1363: MergePanel.merge() posts /api/runs/:id/merge directly, with no confirmAction (compare ui/run.tsx:1431, PrMergePanel, which calls confirmAction "Merge pull request?", and ui/result-next-step.tsx:31-33).
- ui/run.tsx:1336: validation is opt-in. requireValidation = useState(!!run.loop.verification), so it is off unless an explicit verification profile is set; a plain check only shows an unticked checkbox.
- ui/run.tsx:1382: the validation row only renders when run.loop.check || run.loop.verification.
- src/engine.ts:4367-4368: the server enforces validation only when the client sends requireValidation:true.

The docs do not describe a local-merge confirmation either. docs/github.md:18-26 (Merge…) lists safety checks but no confirmation; only Merge PR… (docs/github.md:28) says "You confirm before anything happens". So this is not by design: the help text overcla …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/review.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/github.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ux-flows.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/daily-workflow.e2e.ts`

**Suggested fix:** Preferred: make the behaviour match the promise. In MergePanel.merge (ui/run.tsx:1351), call confirmAction before the POST, as PrMergePanel already does. For example:

```
if (!await confirmAction(`Merge ${branch} into ${target}?${archiveAfter ? " The run will be archived and its worktrees removed (branches kept)." : ""}${!requireValidation ? " The merge result has not been validated." : ""}`, { title: "Merge locally?", confirmLabel: `Merge into ${target}`, danger: true })) return;
```

This matters because the default target is the checked-out branch and archiving is on by default. Then update docs/github.md under **Merge…** to say "You confirm before anything happens". Also update the existing e2e tests that click "Merge into main" (test/e2e/ui.e2e.ts:199, and daily-workflow.e2e.ts if it merges) so they accept the confirmation dialog.

Minimal alternative, if no dialog is wanted: change the review.tsx:149 text to describe what really happens. For example: "Review the diff and evidenc …

**Suggested regression test:** Extend the review publish flow in test/e2e/ux-flows.e2e.ts (around lines 105-110, which already open Publish changes > Actions > Merge…). Click "Merge into <branch>" on a fixture branch that is not checked out. Assert that page.getByRole("dialog", { name: "Merge locally?" }) becomes visible, and that the branch head (git rev-parse) and run.merges are unchanged before you confirm. Click Cancel and assert nothing merged. Click again, confirm, and assert the head moved. If the text-only fix is chos …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4695 (port 4695, fresh home). I bare-cloned MQTT-MCP to a scratch clone (clones/v4695-mqtt), created the branches qa-target and qa-target2 from main, and added the clone through the UI ("Open another repository" > New project "v4695 MQTT"). I created a solo run (claude, no check) through POST /api/runs. The fake solo agent leaves its file uncommitted, so I committed it in the run's scratch worktree, as a real agent would. Without that commit the review shows the "Ask the agent to commit" text instead of the text under test.

Run 1 (no check, no verification): I opened #/review/<id>/<branch> in headless Chrome and expanded "Publish changes". The help text read exactly "Review the diff and evidence before publishing. Merge validation and confirmation still apply." I then used Actions > Merge…, picked qa-target, unticked Archive and clicked "Merge into qa-target". POST /api/runs/<id>/merge went out 38 ms after the click. 250 ms later there was no open <dialog>, no dialog.confirmation-dialog and no native dialog. A "Merged into qa-target" toast appeared, and git showed qa-target moved 2b97323c -> 099cb2c6 (a merge commit). The panel had no validation row at all.

Run 2 (check "true", no verification profile): same steps, merging into qa-target2. This time the panel showed "Require verification of the current merge target", but the box was UNCHECKED by default and the Merge button was enabled. One click merged at once (POST at 38 ms, no dialog), and qa-target2 moved 2b97323c -> ae203776.

Screenshots: shots/v4695/001-before-merge-click.png and 002-after-merge-click.png show the help text above the panel, and after the click the "Merged into" badge and toast with no confirmation step. Scripts and logs are in work/v4695 (s01-s05). No console errors or 5xx.

Note: the Merge into dropdown defaults to main, the branch checked out in the user's repo, and "Archive the run afterwards" is ticked by default. So one click on the default merges into the checked-out main and removes the run's worktrees, even though the text tells the user a confirmation is still to come.

</details>

### t17-5 · minor · Other runs' custom-prefixed result branches are offered as merge targets; merging into one silently changes that run's result

**Fix outcome: fixed.** Root cause confirmed: listBranches tagged only refs/heads/codeflow/* as 'run'. (1) src/git.ts:558: listBranches takes an optional set of recorded result branches and tags those 'run' too. (2) src/server.ts:1932: GET /api/branches passes manager.resultBranches(repo) (engine.ts:3182), which collects the worktree and artifact branches of every run in that repo, archived runs included. The composer now labels custom-prefix results 'Previous task branch', and the Merge… targets leave them out. (3) ui/run.tsx:1315 useTargetBranches also leaves out the run's own worktree branches explicitly. (4) Server guard: RunManager.merge (engine.ts:4387) refuses `into` when it is any run's result branch, naming the other run or saying it is this run's own branch. docs/github.md and docs/api.md updated.

Fixer's check: On QA server f05 I started run I with branchPrefix qa-t17 (fix-review), giving qa-t17/build. /api/branches returned qa-t17/build=run, the codeflow/* branches as run, and main and qa-conflict as local. In run H's Review > Merge… panel, the targets were ['main', 'qa-conflict']: neither qa-t17/build nor H's own branch was offered. POST /api/runs/H/merge into qa-t17/build returned 400 '"qa-t17/build" is the result of another run (2610260108-7c7c0df4), and merging into it would change that result behind its review…', and qa-t17/build did not move. No browser errors. A unit test checks the branch kinds, the refusal and that the ref did not move, and that main still accepts the merge. The e2e asser …

Tests: `test/qa-merge-ship-conflicts.test.ts: result branches with a custom prefix are runs' branches, and merging into another run's result is refused`, `test/e2e/qa-merge-ship-conflicts.e2e.ts`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-02, GIT-17.

**Repro**

> 1. Start run A with Result branch name 'qa-t17', giving branch qa-t17/build. 2. Open another run's Merge… panel. 3. The Merge into list starts with qa-trim/build, qa-t17/build, qa-race/build, ... 4. Pick qa-t17/build and merge.

**Expected:** Run result branches, whatever their prefix, are not offered as targets, or are clearly marked.

**Actual:** The merge runs inside run A's worktree (method 'checkout'; repository hooks are skipped because it is inside the worktree root). Run A's branch gains a merge commit, its diff now includes the other run's files, and run A still shows 'Approved'. Nothing is logged on run A.

**Root cause (verifier):** 1. src/git.ts:572 (listBranches) tags a branch as kind "run" only when it is under refs/heads/codeflow/. Result branches of runs started with a custom prefix (engine.ts:5229, `<branchPrefix>/<worktree>`) come back as "local".
2. ui/run.tsx:1321 (useTargetBranches, used by MergePanel at :1330) keeps every kind === "local" branch, in the for-each-ref --sort=-committerdate order from git.ts:560, so freshly written run result branches are listed before main.
3. Nothing on the server stops the merge either. src/engine.ts:4357-4377 (merge) checks only that `branch` belongs to this run, not whether `into` is another run's result branch. src/ship.ts:153 mergeInto then finds `into` checked out in that run's worktree and calls mergeInCheckout (ship.ts:198). That is intended for the run's own PR-base catch-up (comment at ship.ts:201, caller ship.ts:419). There, hooks are turned off because the checkout is inside worktreeRoot (ship.ts:226 `hooks: !isInside(worktreeRoot(repo), checkout)`).
4. The engine records the merge only on the source run (engine.ts:4371-4373). The target run gets no log event, no merges[] entry, and no reset of its review verdict or artifact stat.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/git.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/patterns.test.ts`

**Suggested fix:** 1. Tag branches by what code-flow knows, not by prefix. In the GET /api/branches handler (server.ts:1929-1931), or in a helper the engine owns, collect the result branches of every known run for that repo (run.worktrees[].branch / artifacts[].branch, archived runs included) and mark them, e.g. kind "run" plus runId. Leave listBranches' prefix test as a fallback for codeflow/* branches with no run record. If the "Start from branch" picker should keep showing custom-prefix results as "Local branch", add a separate field (resultOf: runId) instead of changing kind, and filter on that in useTargetBranches.
2. In ui/run.tsx useTargetBranches, drop branches that belong to another run, or list them in a clearly labelled "Other runs' results" group behind a confirm. Sort so the base branch and the current branch come first.
3. Add a server-side guard in engine.merge (engine.ts ~4361): refuse when `into` is a result branch of a different run, unless an explicit flag is passed. If allowed, record …

**Suggested regression test:** test/patterns.test.ts: after the existing feat/clamp run, assert that GET /api/branches (or the engine helper) marks "feat/clamp/build" as a run result (kind "run" or resultOf set). Update the current assertion `kind("feat/clamp/build") === "local"` (line ~279) to match. A new engine/ship test (e.g. in test/ship.test.ts or wherever engine.merge is covered): start two fake runs, one with branchPrefix "qa-x"; call engine.merge(runB, {branch: B's branch, into: "qa-x/build"}); assert it rejects with …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4669t175. Both assigned ports were taken by other verifiers: 4669 by v4667t174 and 4671 by v4671r. I used 4599, which no QA home had ever used. I made a scratch clone of MQTT-MCP and added it in the UI ("Open another repository" -> new project v175-mqtt). In the composer (Run options > Advanced, workflow fix-review) I started run C 2610252151-693acc26 with Result branch name 'qa-v175b', giving branch qa-v175b/build (file codex-746e00ce.txt), and run D 2610252151-3d260665 with the default prefix, giving codeflow/2610252151-3d260665/build. Two earlier solo runs A and B also existed (branches qa-v175/solo and codeflow/<B>/solo).

I put a failing pre-merge-commit hook in the clone's .git/hooks, then opened run D > Details and publishing > Actions > Merge…. The "Merge into" options were ["qa-v175b/build","main","qa-v175/solo"]; main was selected by default. /api/branches tagged qa-v175b/build and qa-v175/solo as kind "local" and both codeflow/* branches as "run". I picked qa-v175b/build, left Archive unchecked and clicked "Merge into qa-v175b/build".

Response 200 {ok:true, method:"checkout"}, toast "Merged into qa-v175b/build". The failing hook did not run. Run C's worktree HEAD became merge commit 9a84b65 (parents 5ca42c8 and 5a36308). Run C's diff went from [codex-746e00ce.txt] to [codex-5f3dffe3.txt, codex-746e00ce.txt]. Run C's page still said "Approved — branch qa-v175b/build" and "Ready to review · Review: Approved"; its artifact stat still said "1 file changed" and its merges[] stayed empty. Its .jsonl has no event after the merge; only run D logged "Merged ... into qa-v175b/build". Screenshots: shots/v4669t175/003-runD-merge-target-chosen.png and 005-runC-after.png.

I also POSTed /api/runs/<C>/merge with into=codeflow/<runB>/solo, a default-prefix branch of another run. The server accepted it ({ok:true, method:"checkout"}), so there is no server-side guard. The UI's prefix-based filter is the only barrier.

Possible refutations checked. docs/github.md describes Merge… as merging "into one of your branches" and never mentions other runs' results as targets. test/patterns.test.ts:279 does assert that a custom-prefix branch (feat/clamp/build) is kind "local". That assertion came with commit 062e264, written for the "Start from branch" picker (ui/composer.tsx:713, "Local branch" vs "Previous task branch"). The Merge panel came later (738f401, M2) and reused kind === "local" as "branches you could merge a result into", without accou …

</details>

### S10-7 · minor · listBranches tags only refs/heads/codeflow/* as kind 'run'. Result branches with a custom 'Result branch name' prefix show as 'Local branch' in the composer and appear as Merge… targets, so a user can pick another run's result branch or this run's sibling branches as the merge target.

**Fix outcome: duplicate.** Duplicate of t17-5, which carries the fix: listBranches(repo, results), /api/branches passing manager.resultBranches, the useTargetBranches filter, and the RunManager.merge guard. Custom-prefix result branches are now kind 'run', so the composer labels them 'Previous task branch' and Merge… does not offer them; the run's own sibling branches are excluded and refused too.

Fixer's check: Same QA run as t17-5: /api/branches tags qa-t17/build as 'run', and the Merge into options are only main and qa-conflict.

Tests: `test/qa-merge-ship-conflicts.test.ts: result branches with a custom prefix are runs' branches, and merging into another run's result is refused`

Source: code-level suspect at `src/git.ts:572` (confirmed hands-on).

**Repro**

> Fake server s10. In New run > Run options I set 'Result branch name' to feat/qa-s10, chose the Codex provider and clicked Send. This made run D with worktree branch feat/qa-s10/solo. GET /api/branches returned feat/qa-s10/solo as kind 'local', while every codeflow/<id>/solo was kind 'run'. In the composer's 'Start from branch' list, feat/qa-s10/solo was labelled 'Local branch' and codeflow/* 'Previous task branch' (shots/s10/001-composer-branch-list.png). In run C's Merge… panel the 'Merge into' options were ['feat/qa-s10/solo','main']. Run D's result branch is offered as a merge target, whereas codeflow/* result branches are filtered out (shots/s10/002-merge-targets-2610251745-eecf280c.png). Script: work/s10/07b-custom-prefix.mjs, 08-branch-kinds.mjs.

**Expected:** Per the BranchInfo doc comment ('a result branch from an earlier code-flow run' is kind 'run'), result branches are tagged 'run' whatever their prefix. They are therefore labelled 'Previous task branch' and kept out of Merge… targets like other run branches.

**Actual:** Custom-prefix result branches are treated as ordinary local branches: they are mislabelled in the composer and offered as merge targets for other runs (and for the run's own or sibling branches, where the user then gets 'Nothing to merge' or merges into another run's checked-out worktree).

**Root cause (verifier):** listBranches classifies by the hard-coded ref prefix refs/heads/codeflow/. Runs with a custom branchPrefix (engine.ts:5229, docs getting-started.md:153) are not consulted. useTargetBranches (ui/run.tsx:1321) relies on kind==='local' to exclude run branches.

**Suggested fix:** Have the /api/branches handler (or listBranches with an extra parameter) tag as 'run' any ref equal to or under a branchPrefix recorded by an existing run (manager.list() branchPrefix values, plus worktrees[].branch). In MergePanel, also exclude the current run's own worktree branches explicitly.

**Suggested regression test:** Server test: start a run with branchPrefix 'feat/x', then GET /api/branches returns feat/x/solo with kind 'run'. UI test: another run's Merge… target select does not list feat/x/solo, and the composer labels it 'Previous task branch'.
