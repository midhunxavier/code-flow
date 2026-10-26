# Cluster 04 · run-worktree-lifecycle

**Run worktree/branch lifecycle: unpublished/unpersisted worktrees, run-log durability, archive, prefix races**

Status: **independently verified after repair** · 12 issues · branch `qa-fix/run-worktree-lifecycle`

Planner notes: t07-6 and t08-1 share openWorktreeLive in src/engine.ts (~2232). It pushes the new worktree onto run.worktrees without publish() or persistence, so the run list lacks it until the first check and a crash loses it. t26-1: the final durable run event is appended only once. A transient write failure loses it, and the banner never clears (src/engine.ts emit ~5693, src/store.ts, persistence-status). t17-6: RunManager.start (~5229) does not reserve the prefix atomically in validateBranchPrefix. t17-4: src/git.ts and src/ship.ts run an unscoped 'git worktree prune'. In RunManager.archive (~3688): side-chat runs return early and skip the folder tidy (t08-15); the archive toast ignores a failed worktree removal (t17-8, ArchiveDialog in ui/run.tsx); the checkbox state is wrong (t18-17); nothing shows 'Archived' (t18-18); chat runs have no way to clean up their worktree (t04-14). t17-13: a deleted branch is still reported as saved. t17-15: skipped copy patterns give no warning (src/repo-config.ts:97). insights-cleanup may reuse tidyRunFolder, so keep its signature stable. Duplicate groups: [["t07-6","t08-1"]]

Likely files: `src/engine.ts`, `ui/run.tsx`, `src/git.ts`, `src/ship.ts`, `src/store.ts`, `src/persistence-status.ts`, `src/repo-config.ts`, `ui/run-experience.ts`, `ui/experience.tsx`, `ui/styles.css`

## Independent verification · 2026-10-26

Verified in `codex/qa-verify-lifecycle-review-permissions`, based on integrated `c70d95f`, using an own worktree, fresh scratch repositories, isolated CODEFLOW_HOME, fake agent/gh/Docker executables, and Chrome. No live 4317/4318 or ~/.codeflow access. Audited worktree publication/journal recovery, persistence retry, prefix reservation, scoped cleanup and archive UI changes before replaying the scenarios.

| Issue | Independent outcome |
|---|---|
| t07-6, t08-1 | Pass. During the first running Codex step, the run list already contained `build`. Killed the owned server with SIGKILL, restarted, observed `interrupted` plus its worktree, resumed to `done`, opened review and successfully archived it. The browser suite also used Chat and Changes while the first step was running. |
| t26-1 | Pass. Made the owned run log and runs directory unwritable while an agent was running. Its finished state remained in memory, the browser showed a friendly persistence alert without raw paths/EACCES, restoring permissions cleared the alert, and restarting the server loaded `done` with one worktree. |
| t17-6 | Pass. Three concurrent HTTP starts for one custom prefix returned one 201 and two 400s with actionable prefix errors; a nested conflicting prefix was also refused. |
| t17-4 | Pass with repair below. A separate user's scratch worktree was moved offline during CodeFlow archive/reattachment, restored, and retained its untracked WIP. No unscoped prune. |
| t17-13 | Pass. Archive with branch deletion followed by unarchive removed the result controls and showed the deleted-work explanation. Diff returned 409 with a clear deleted-branch message. |
| t17-8 | Pass in browser replay. A substituted worktree .git caused cleanup to fail safely; the Archive dialog stayed open with the failure and emitted no success toast. The checkout remained on disk. |
| t18-17 | Pass in browser replay. Selecting branch deletion then clearing cleanup cleared and disabled the branch checkbox; reenabling cleanup did not restore the hidden choice. |
| t18-18 | Pass in browser replay. Merge-and-archive closed the merge panel, displayed archived and merged badges, and reopening did not repeat the completed target by default. |
| t04-14 | Pass. Whole chat-task archive removed its owned worktree, branch and context. Browser sidebar archive exercised the same action; active family members remain protected by the manager test. |
| t08-15 | Pass. Linked side-chat archive cleared its own context folder and retained the owner's shared worktree. |
| t17-15 | Pass. Traversal, absolute, missing and unmatched copy patterns each logged their specific reason once; a legitimate `.env` copied successfully. |

New adjacent regression: `forgetWorktree` parsed newline-delimited Git porcelain, so a missing registered checkout whose absolute directory contained a newline could not be reattached. It now requests `--porcelain -z` and matches complete raw fields. The new `test/qa-run-worktree-lifecycle-quoted-paths.test.ts` failed before the fix, then passed for Unicode, tab and newline paths, detached cleanup, and an unrelated offline checkout holding WIP. An actual HTTP follow-up also recreated a manually removed checkout under an absolute newline-containing worktree root and retained committed scratch content; follow-up status was `done`.

Validation: `npx tsc --noEmit`; 46/46 targeted cluster04/05/06/08 tests, including the two new regression files; 14/14 Chrome cluster04/06/08 e2e tests. All providers are fixtures; this does not assert real provider behavior.

Independent evidence:
- `/private/tmp/codeflow-qa-continue/verify04608-1793006908427/evidence.json` — crash/resume, branch deletion, prefix race, offline checkout, copy warnings.
- `/private/tmp/codeflow-qa-continue/verify04608-1793007039197/evidence.json` — side-chat and family cleanup.
- `/private/tmp/codeflow-qa-continue/verify04608-1793007353046/evidence.json` — actual write failure/recovery/restart.
- `/private/tmp/codeflow-qa-continue/verify046-provenance-1793007640029/merge-archive-evidence.json` — dedicated merge-and-archive replay: validation verified, merge panel closed, badges shown, reopening chose main and selecting qa-target explained the previous merge.
- `/private/tmp/codeflow-qa-continue/verify046-provenance-1793007640029/evidence.json` — newline checkout recovery; screenshot `shots/verify046-provenance/003-newline-worktree-restored.png` under the same QA scratch root.

No unresolved issue found in the assigned lifecycle fixes. Real agent and remote filesystem behavior was not exercised.

## Fix result

Commits:
- `bd399e8` Forget only code-flow's own worktree records instead of pruning
- `0ee1907` Say which copy patterns copied nothing, and why
- `a913244` Claim a chosen branch prefix as its run starts
- `b9c344b` Save a run's log again once storage works
- `d39b4f6` Say when a run's branch was deleted, and stop offering its changes
- `86efdc4` List a run's worktrees as soon as they exist, and after a crash
- `9ca7959` Show what Archive did, and let Agent conversations clean up
- `55c050b` Show archived and merged runs as such, and close the merge panel once merged
- `1890fc7` Cover the run worktree lifecycle fixes

Fixer notes for the integrator: - I edited one existing test because my fix changes what it asserts. In test/ship.test.ts, \"archive can remove worktrees and branches; PRs need a remote\" now reads run.worktrees before archiving and checks run.deletedWorktrees afterwards.
- Behaviour change: when a branch is deleted (archive with deleteBranches, or a follow-up finding it gone), its worktree moves from run.worktrees to the new optional Run.deletedWorktrees. Any code in another cluster that reads run.worktrees after such an archive should look at deletedWorktrees instead. A follow-up to a deleted worktree is still accepted, then fails with the documented message.
- archive() now returns an explicit ArchiveResult with `failed` always present. New RunManager.archiveTask(), exposed as POST /api/runs/:id/archive {task:true}.
- tidyRunFolder keeps its signature, so the insights-cleanup cluster can reuse it. It now only counts worktrees inside the run's own folder.
- ArchiveDialog moved out of ui/run.tsx into a new ui/archive-dialog.tsx, loaded lazily through an `ArchiveDialog` export in ui/run-actions.tsx. Another cluster that edits ArchiveDialog in run.tsx will conflict; apply its change in ui/archive-dialog.tsx.
- Startup bundle: test/assets.test.ts caps startup JS at 850,000 bytes. The base was at 847,934; this branch is at 848,677 (+743). After merging other clusters, rerun test/assets.test.ts, since the combined total can go over.
- There is no unscoped `git worktree prune` in src anymore; use the new exporte …

## Issues

### t07-6 · major · After a crash (kill -9), a run loses its worktree list: the resumed result has no Review card and archive leaves the worktree and branch behind

**Fix outcome: fixed.** src/engine.ts: new TeamContext.recordWorktree() lists a worktree on the run and publishes the run (emitRun) as soon as it exists. openWorktreeLive calls it right after openWorktree, before setup. worktree() calls it after a re-attach and again for a worktree replayed from the journal on resume, so a lost list comes back. RunManager.load() also merges the journal's `worktree:*` entries into a run that was running and lacks them, so an interrupted run can be archived without a resume. Commit 86efdc4.

Fixer's check: QA server f04 (port 4359, fake agents, FAKE_SLEEP_MS=2500), scratch repo registered as a project. Fix & review run with check `sleep 40; true`; I sent kill -9 to my own server PID during the Check step. The run log now has a run-patch with worktrees [build] right after the first snapshot (before the fix: only the initial snapshot with []). After restarting on the same home, GET /api/runs/<id> returned status interrupted with worktrees ["build"]. "Resume work" in the UI: the run finished done with worktrees ["build"], and the page showed "Ready to review" and "Review changes". More run actions > Archive… said "Remove its 1 worktree". With "Also delete its branches" ticked, the response had re …

Tests: `test/qa-run-worktree-lifecycle.test.ts: a new worktree is in the run list at once, and survives a crash: resume and archive still know it`, `test/qa-run-worktree-lifecycle.test.ts: a crashed run whose log predates its worktrees gets them back from the journal at load`

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-24, RUN--GAP-02.

**Repro**

> 1. qa-server.sh start t07 4377 fake (FAKE_SLEEP_MS=2500); scratch clone project.
> 2. Start 'Fix & review' with check `sleep 40; true`.
> 3. While the Check step runs (about 8s in), kill -9 the server pid (own server only).
> 4. Start the server again with the same home.
> 5. GET /api/runs/<id>: status interrupted, worktrees [] (the worktree .worktrees/<id>/build and branch codeflow/<id>/build exist with the builder's commit).
> 6. Resume, wait for done, open the run.
> 7. Archive with cleanup + delete branches (UI or POST /archive {cleanup:true, deleteBranches:true}).

**Expected:** The run keeps its worktree record. After resume, 'Ready to review' / 'Review changes' appear. Archiving removes the worktree and branch.

**Actual:** worktrees stays [] even after the resumed run finishes ('Approved, and `sleep 40; true` passes'; artifacts lists the branch). The run page has no result studio and no 'Review changes' button. Archive returns {"removed":[],"deletedBranches":[]}, and the worktree and branch stay in the repo; deleting the run then orphans them. A graceful restart (SIGTERM/SIGINT) did not lose the list.

**Root cause (verifier):** The run's worktree list is never written to disk before the crash, and a resume never adds it back.

1. src/engine.ts:2232-2234 (TeamContext.openWorktreeLive) pushes the new worktree into run.worktrees but does not call this.publish() / manager.emitRun(). The run log stores run state only as "run" or "run-patch" snapshots (src/engine.ts:5680-5697 emitRun/emit; src/store.ts header). Step, agent and log events do not carry run.worktrees. For a fix-review run, the first snapshot after the initial one is written only when the run ends, or on graceful shutdown, which marks it interrupted and emits a full snapshot. After kill -9, the log rebuilt by RunManager.load (src/engine.ts:3260-3305) holds the initial `worktrees: []`. The chat-workspace path at src/engine.ts:2183 does publish, so the two paths are inconsistent.

2. On resume, TeamContext.worktree (src/engine.ts:2193) gets the worktree from the journal through remember("worktree", ...) (src/engine.ts:1595-1612), which returns the recorded value without calling openWorktreeLive. Nothing adds it back to run.worktrees, so the list stays [] for the rest of the run.

Effects downstream:
- ui/run.tsx:199 sets hasResult only when run.workt …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/persistence.test.ts`

**Suggested fix:** In src/engine.ts, add a helper to TeamContext:

```ts
private recordWorktree(wt: Worktree) {
  if (this.run.worktrees.some((w) => w.name === wt.name)) return;
  this.run.worktrees.push({ name: wt.name, branch: wt.branch, path: wt.path });
  this.publish();
}
```

1. In openWorktreeLive, replace the bare push at lines 2232-2234 with this.recordWorktree(wt). The list is then in a run snapshot on disk as soon as the worktree exists, and stays recorded even if setup (npm ci) is killed.
2. In worktree(), call this.recordWorktree(wt) right after `let wt = await this.remember("worktree", ...)`. A replayed (journaled) worktree is then listed again on resume, which also repairs runs whose logs were written by the current code.

I prototyped both changes in my snapshot copy. The focused test then passes: worktrees ["build"] after crash and load, ["build"] after resume, and archive removes the worktree and deletes the branch. A variant that blanks loaded.worktrees, to simulate an old log, also pa …

**Suggested regression test:** In test/persistence.test.ts, extend "a run that crashed (no clean shutdown) loads as interrupted" or add a sibling test:
1. Start a pipeline run with FAKE_SLEEP_VENDOR=codex and FAKE_SLEEP_MS=5000, wait until "Implement plan" is running, then await flushWrites().
2. Create a new RunManager and call load(). Assert `loaded.worktrees.map(w => w.name)` deep-equals ["build"].
3. Cancel the first manager's run, call b.resume(id) and await finished. Assert the worktrees still deep-equal ["build"] and t …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server "v4693" on port 4693 with FAKE_SLEEP_MS=2500, and a scratch clone of MQTT-MCP that I added through the UI ("Open another repository", project "v4693 MQTT").
1. From the composer UI I started a 'Fix & review' run (workflow-select=fix-review) with check `sleep 40; true`. Run id: 2610252011-dcbd40d5.
2. About 4 s into the Check step, GET /api/runs/<id> showed the worktree "build" in memory. I copied runs/<id>.jsonl and ran kill -9 on my own server pid. The log had exactly one run snapshot: seq 1, the initial full one, with `worktrees: []`. After it came only step, agent and log events ("Created worktree ...", s1 done, a commit, s2 running). The journal did have `worktree:build#1`.
3. I restarted with the same home. GET /api/runs/<id> returned status interrupted, worktrees [] and artifacts []. `git worktree list` and `git branch` still showed .worktrees/<id>/build and codeflow/<id>/build at the builder's commit.
4. I clicked "Resume work" in the UI and waited about 4 min. The run finished done with verdict passed and summary "Approved, and `sleep 40; true` passes". Artifacts listed the branch, but worktrees was still [].
5. On the run page there was no "Ready to review" card and no "Review changes" or "Preview" buttons (screenshot shots/v4693/001-crashed-done.png).
6. I archived through the UI (More run actions > Archive…). The dialog said "Remove its 0 worktrees". With cleanup and "Also delete its branches" ticked, POST /archive {cleanup:true, deleteBranches:true} returned 200 {"archived":true,"removed":[],"deletedBranches":[],"failed":[]}. The worktree and branch stayed in the repo.
7. I deleted the run through the UI. The worktree and branch stayed behind, orphaned.

Control run 2610252016-50763291: same workflow, check `sleep 2; true`, no crash. It had worktrees ["codeflow/.../build"], the page showed "Ready to review · Checks: Passed · Review: Approved", "Review changes" and "Preview". The archive dialog said "Remove its 1 worktree", and the archive removed both the worktree and the branch.

Unit level, in my snapshot copy (builds/v4693, test/v4693-crash-worktrees.test.ts, modelled on the crash test in test/persistence.test.ts): a pipeline run, flushWrites while "Implement plan" runs, then a new RunManager.load(), resume and archive. Output: "after crash+load worktrees: []", "after resume: done worktrees: [] artifacts: [codeflow/.../build]", "archive: {removed:[],deletedBranches:[]}". The test fails.

Not by design: docs …

</details>

### t08-1 · major · Run list summary lacks the run's worktree/branch until the first check ends, so the side panel can't do side chats, Files or Changes on a running run's first step

**Fix outcome: duplicate.** Same root cause as t07-6 (openWorktreeLive pushed into run.worktrees without publishing). Fixed by recordWorktree() in t07-6's commit 86efdc4, which publishes the run, so the run list and side panel learn of the worktree at once.

Fixer's check: On f04 (FAKE_SLEEP_MS=2500), a fix-review run with builder codex and check 'sleep 20; exit 0'; I polled GET /api/runs/<id> and GET /api/runs about once a second. The list had worktrees=1 from 0.7 s, while "Fix the issue" was still running (before: 0 until about 24 s). The side panel Chat tab said "Chat about this run" throughout. Files offered "build · codeflow/<id>/build" and Changes showed the run's branch instead of "no branch yet". A message typed in the Chat tab during the first step became side follow-up f1 (kind side, worktree build, pending), and no separate run was created. Browser errors [].

Tests: `test/qa-run-worktree-lifecycle.test.ts: a new worktree is in the run list at once... (asserts manager.list() has it while the first step runs)`, `test/e2e/qa-run-worktree-lifecycle.e2e.ts: the side panel works in a run's worktree while its first step is still running`

Source: tester unit side-panel-previews-1; observed with fake-agents; features SIDE-05, SIDE-06, SIDE-10, SIDE-11.

**Repro**

> 1. Start a fake QA server (FAKE_SLEEP_MS=3000) and add a scratch clone as a project.
> 2. Start a fix-review run with check 'sleep 20; exit 0' (composer, or POST /api/runs).
> 3. Open the run right away and open side panel → Chat.
> 4. Compare GET /api/runs/<id> (worktrees: 1 from 0s) with GET /api/runs (the list; worktrees: 0 until about 24s, after the first check).
> 5. Meanwhile the Chat tab says 'A separate chat — This run has no result worktree for a side chat to work in yet'. Type a message and press Enter.
> 6. The Files folder picker offers only '<repo> · repository'. Changes says 'This run has no branch yet'.

**Expected:** Once the run's worktree exists (right away, as /api/runs/:id shows), the panel offers 'Chat about this run' (Ask/Change, queued until the team finishes, per docs/runs.md), and Files and Changes show the run's worktree and branch.

**Actual:** For the whole first agent step plus its check (24s with fake agents; with real agents the entire first turn, often minutes), the list/feed summary has worktrees=[]. A message typed in the Chat tab became a separate Single-agent run on HEAD (e.g. 2610251501-b22caaf7, 2610251504-0164bc2b) instead of a side chat on the run. Files can't show the worktree and Changes reports no branch even after the builder has committed.

**Root cause (verifier):** src/engine.ts:2232-2234, in openWorktreeLive. The new worktree is pushed onto this.run.worktrees without this.publish(). The chatLink path at src/engine.ts:2183 does call this.publish() after the same push.

GET /api/runs/:id returns the live, mutable Run object (manager.get, src/engine.ts:3428), so it sees the push at once. The run list and the UI's "runs" stream topic are served from runIndex (manager.list → allSummaries, src/engine.ts:3366-3370). Only emitRun (src/engine.ts:5680-5686: runIndex.set(strip(run)) and bus "*") refreshes runIndex. The "step", "log" and "agent" events emitted during the first agent step and its check do not.

For non-team patterns (fix-review, pipeline, ...), the first emitRun after worktree creation is the lastCheck publish at src/engine.ts:1699, after the first check. Team runs get an earlier publish at agent launch (src/engine.ts:2823).

The side panel reads only that summary:
- ui/state.ts:431-444: sideScope builds the panel's run from runs.value.
- ui/side-chat.tsx:84: takesSideChats needs resultWorktree (ui/panel-bits.tsx:28) to find run.worktrees, so the panel falls back to the "A separate chat" composer. That composer POSTs a new solo run from  …

**Files:** `src/engine.ts`, `test/ship.test.ts`

**Suggested fix:** In Engine.openWorktreeLive (src/engine.ts:2232-2234), call this.publish() right after `this.run.worktrees.push(...)`, mirroring line 2183. Publishing before prepareWorktree means the list and the panel also see the worktree during a long setup (npm ci etc.). That is safe because side turns still queue behind the team.

Validated in a patched snapshot: the list had the worktree at 1s, Chat showed "Chat about this run", Files listed the worktree, Changes loaded, and the 10 side-chat tests in test/ship.test.ts pass.

Optional hardening, not needed for this issue: refresh runIndex when other summary fields that are mutated in place change, or have the UI's side scope prefer the run-stream snapshot when one is subscribed. The one-line publish is the minimal correct fix.

**Suggested regression test:** Add a test to test/ship.test.ts next to "a side chat's turn sent while the team works waits for it" (line 178):
1. Set FAKE_SLEEP_VENDOR=codex and FAKE_SLEEP_MS=1500 (or a fix-review run with check 'sleep 3').
2. Start a run with manager.start.
3. Wait until the live run.worktrees has "build" while the first agent step is still running (run.steps.at(-1).status === "running").
4. Assert `manager.list().find(r => r.id === run.id)!.worktrees.some(w => w.name === "build")`. Optionally also subscribe …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server "v4669t08" on 127.0.0.1:4669 with FAKE_SLEEP_MS=3000 exported (checked in the server process env), new QA home, new browser profile. My own scratch clone of MQTT-MCP (bare and working clone v4669t08-mqtt), added as project "v4669t08 mqtt" through the UI ("Open another repository", then Create project).

1. Lag probe (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4669t08/s2-lag.mjs, log s2.log). Started a fix-review run via POST /api/runs (builder codex, reviewer claude, check 'sleep 20; exit 0'). Opened /#/run/<id>, opened the side panel, then about once a second read GET /api/runs/<id>, GET /api/runs, and the Chat, Files and Changes tabs.
   - 1s to 23s: one.wt=1 but list.wt=0. Chat said "A separate chat — This run has no result worktree for a side chat to work in yet". The Files folder picker offered only ["v4669t08-mqtt · repository"]. Changes said "This run has no branch yet: its changes show here once an agent has worked."
   - 24s (first check done): list.wt=1. Chat said "Chat about this run", Files offered "build · codeflow/<id>/build", and Changes loaded.
   - Screenshot shots/v4669t08/001-chat-during-window.png showed the main thread running the check in "worktree build" while the panel said there was no worktree.

2. Run event log (homes/v4669t08/runs/2610251928-a9de2cef.jsonl):
   - 0.0s: "run" snapshot with wt=0.
   - 0.1s: "Created worktree …".
   - 3.5s: "Committed 27dd8258 on codeflow/…/build".
   - 3.6s: check running.
   - 23.7s: the first run-patch, which is the first event carrying worktrees.

3. Send probe (s3-send.mjs, log s3.log).
   - At 3.9s the run's branch already had commit 1ef0dd4 beyond HEAD, yet list.wt=0. Chat showed "A separate chat" with no "Start from" options.
   - I typed a message in the Chat tab and pressed Enter. It created a separate Single-agent run 2610251929-44bb6eca (pattern solo, parentRunId = the run, baseRef 2b97323 = repo HEAD, its own "solo" worktree at HEAD). Nothing was added to the run's followUps.
   - Control: after the list caught up (24.5s), the same panel showed "Chat about this run", and the same action created side follow-up f1 (kind side, worktree build, status pending, queued behind the team), which is the behaviour docs/runs.md describes.

4. Fix validation. I made a private snapshot copy (builds/v4669t08fix), added this.publish() after the push in openWorktreeLive, started it on 4671, and ran the …

</details>

### t26-1 · major · Transient run-log write failure loses events permanently; banner never clears after storage recovers; a finished run comes back as Interrupted after restart

**Fix outcome: fixed.** src/engine.ts emit(): a line that fails to save goes into a per-run in-memory hold, in seq order and capped at 8 MB per run; later lines for that run wait behind it. resaveRuns() retries with backoff from 1 s up to 30 s, and once more in shutdown(). When storage works it writes the held lines, says how many it had to drop, re-emits the steps whose updates were dropped, then writes a full synced snapshot, which sets the status to saved. Unsaved runs aren't moved to cold storage, and delete clears them. The earlier attempt's resave never rescheduled after a failed retry (scheduleResave was blocked by its own `resaving` flag); I fixed that and added a test that fails without the fix. src/store.ts appendLine: new onSaved callback. src/persistence-status.ts track(): takes the friendly message, so the raw EACCES text with its private path no longer replaces it (the raw error still goes to the  …

Fixer's check: QA server f04b (port 4361, FAKE_SLEEP_VENDOR=codex, FAKE_SLEEP_MS=25000). Codex solo run "Persistence test"; 1.5 s in, I ran chmod 444 on the run's jsonl and chmod 555 on the runs folder. The run finished done. The banner read "Run changes have not been saved. Check disk space and permissions; code-flow keeps retrying and clears this once they're saved." It had no path and no EACCES, and sat inside .thread (x 432, width 824, within the thread at 404/880). It stayed through retries that failed for 6+ s. After I restored the permissions it cleared on the next retry. The log went from 9 to 14 lines with seqs ascending, ending in a full `run` snapshot: done, 1 worktree. After a reload: no banner …

Tests: `test/qa-run-worktree-lifecycle-persistence.test.ts: a failed save keeps the friendly message, never the raw error with its path`, `test/qa-run-worktree-lifecycle-persistence.test.ts: a run whose log stopped saving is written again once storage works, and reloads finished`, `test/e2e/qa-run-worktree-lifecycle.e2e.ts: a run whose log stopped saving says so in its column, and stops once it's saved again`

Source: tester unit usability-failure-cases-2; observed with fake-agents; features UX-18, UX-19.

**Repro**

> 1. export FAKE_SLEEP_MS=25000 FAKE_SLEEP_VENDOR=codex; qa-server.sh start t26 4491 fake.
> 2. Open http://127.0.0.1:4491/?token=qa-t26-token, open a scratch repo, pick Codex, send 'Persistence test'.
> 3. Within 3 s: chmod 444 <home>/runs/<runId>.jsonl; chmod 555 <home>/runs.
> 4. Wait about 22 s. The run page shows the alert 'Run changes have not been saved: EACCES: permission denied, open <absolute path>', and the run finishes (Finished, Ready to review).
> 5. chmod 755 <home>/runs; chmod 644 the jsonl. The banner stays, also after reload, and the jsonl stays at 8 lines; nothing is re-saved.
> 6. qa-server.sh restart t26 and reopen the run.

**Expected:** Once storage works again, code-flow retries the failed appends or re-writes a full run snapshot, then clears the banner. A run that finished before the restart is never shown as Interrupted. The banner shows the friendly 'Check disk space and permissions' text.

**Actual:** Restart turns the finished run into 'Interrupted, code-flow stopped while this run was in progress. Resume to continue.' Its summary is gone and worktrees go from 1 to 0, while the worktree still holds the agent's uncommitted file. A follow-up turn does clear the banner, because it writes a new snapshot, but the first turn's events stay lost on disk (seq gap 365 to 372 in run 2610251726-42674b14). The banner is raw unstyled red text, flush left above the run header, with the full private path.

**Root cause (verifier):** 1. src/engine.ts:5693-5696 (`emit`): the final `run` event of a finished run is the only durable one (`durable = status !== "running"`, sync+strict). It is passed to appendLine once. On failure, `onFailed` only calls `logWriter.forget(run.id)` and `persistence.failure(...)`. `forget` makes the next snapshot get written whole, but a finished run emits nothing more. Nothing retries the failed records and nothing re-persists the snapshot once storage works again. The only existing recovery is that a later event for the same run writes a full snapshot.
2. src/store.ts:161-228 (`appendLine`): when the queued write throws (try/catch at ~191-198), it just rejects, and the batch text is dropped. There is no retry queue for failed records, and flushWrites() at shutdown (engine.ts ~5674) only syncs writes that succeeded. On restart, src/engine.ts:3283-3292 (`load`) sees the last persisted snapshot as status "running" and rewrites it to "interrupted" with error "code-flow stopped while this run was in progress…". That snapshot was taken before the worktree was recorded, so worktrees=[] and summary=undefined. Resume then finishes with worktrees still [], which orphans the agent's worktree.
3.  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/persistence-status.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/performance-boundaries.test.ts`

**Suggested fix:** 1. Engine repair loop. In engine.ts, have `onFailed` add the run id to a `needsResave` set and start a backoff timer (for example 1 s, rising to 30 s). On each tick, for every run in the set, emit a full durable snapshot with the current state: `this.logWriter.forget(id)` followed by `this.emit(run, { type: "run", run: strip(run) })`, which yields a sync+strict full line with a checkpoint. When that write resolves, `persistence.track` moves the state to "saved" with a newer seq, the banner clears, and the id leaves the set. The full snapshot restores status, summary and worktrees, so the run cannot come back as Interrupted. Also attempt this resave in `shutdown()` before `flushWrites()`, and log loudly if it still fails. If lost step and agent events matter, keep the failed lines per run in a bounded in-memory buffer and re-append them before the snapshot. Otherwise, document that only the run snapshot is recovered.
2. persistence-status.ts. In `track`'s rejection handler, keep an exis …

**Suggested regression test:** 1. test/performance-boundaries.test.ts, tracker unit test: track(run, 3, rejected 'EACCES … /abs/path') after failure(run, 3, friendly) must keep the friendly text and must not contain '/abs/path'.
2. New focused engine test, e.g. test/engine-persistence-recovery.test.ts, with a temp CODEFLOW_HOME and the fake agent. Start a run. Before its final snapshot, make <home>/runs/<id>.jsonl read-only (or stub fs appendFile to throw EACCES once). Assert manager.persistence.get(id).state === 'error'. Res …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake QA server: `export FAKE_SLEEP_MS=25000 FAKE_SLEEP_VENDOR=codex; qa-server.sh start v4637p 4637 fake`. The home was new and the target was a throwaway `git init` repo at qa/clones/v4637-scratch. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4637/p1.mjs, log in p1.log.

1. In the UI I clicked "Open another repository", picked Codex and sent "Persistence test: add a one-line note to README". That created run 2610252324-c0fa17d1.
2. About 2 s later the jsonl had 8 lines. I ran `chmod 444 <home>/runs/<id>.jsonl; chmod 555 <home>/runs`.
3. 22 s later the run reached Finished / Ready to review. A role=alert appeared: "Run changes have not been saved: EACCES: permission denied, open '/private/tmp/.../homes/v4637p/runs/2610252324-c0fa17d1.jsonl'". The server log showed "couldn't save run data", and /api/health reported writes.failures=7.
4. I restored permissions (755 / 644) and watched for 15 s, then reloaded the page. The banner was still there after the reload (shot 004-after-reload.png). It is unstyled red text, flush left at the edge of the main pane, above the centred run header, and it shows the full absolute path. The jsonl stayed at 8 lines. The only `run` snapshot in it is seq 1 with status=running and 0 worktrees. Seqs 2-8 are log, step and agent events.
5. `qa-server.sh restart v4637p`, then GET /api/runs/<id> returned status=interrupted, error "code-flow stopped while this run was in progress. Resume to continue.", summary null, worktrees [] (after-restart.json). `git worktree list` still showed .worktrees/<id>/solo, which held the agent's untracked file codex-e043f11a.txt. The banner was gone because the tracker lives only in memory.
6. Extra check (p2.mjs): clicking Resume replays the journal and sets the run to "Finished" with a summary, but worktrees stays []. The step still shows "Interrupted · code-flow stopped before this step finished", and there is no "Ready to review" card or Review changes button. The agent's work is left in a worktree the run no longer tracks.

The bug comes from the product code, not from the tester's setup:
- I used a fresh browser profile and a fresh home.
- The fault only stands in for a real transient storage error such as ENOSPC.
- The app's own message ("Check disk space and permissions before closing the app") tells the user that fixing storage before closing is enough, and it is not.
- No document (docs/run-storage.md or …

</details>

### t17-6 · major · Branch prefix validation is not atomic: concurrent starts are all accepted, then fail with a raw git error

**Fix outcome: fixed.** src/engine.ts: RunManager.claimBranchPrefix(), called in startResolved right after validateBranchPrefix, checks and claims a custom prefix synchronously. A start fails if another start holds an equal or nested prefix, or any known run in the repo (runIndex, including archived) owns one. start() releases the pending claim once the run is registered; from then on the run's record keeps it. Default codeflow/<id> prefixes skip the claim. Errors are plain messages, so server.ts returns 400. docs/getting-started.md updated. Commit a913244.

Fixer's check: On f04b: two concurrent POST /api/runs with branchPrefix "qa-race" gave one 201 and one 400 ("Another run being started has the branch prefix \"qa-race/\"; pick another prefix"). Three concurrent with "qa-race3" gave one 201 and two 400 ("Run <id> already has the branch prefix ..."). Both winners finished done on qa-race/build and qa-race3/build, and no run failed with git's "already checked out". A sequential reuse of qa-race returned 400 "Branches under \"qa-race/\" already exist".

Tests: `test/qa-run-worktree-lifecycle.test.ts: concurrent starts can't share a branch prefix, nor can a later run while the first is known`

Source: tester unit git-review-merge-1; observed with api; features GIT-02.

**Repro**

> 1. Capture the composer's POST /api/runs body. 2. Send it 2 or 3 times concurrently with the same new branchPrefix (qa-race, then qa-race2).

**Expected:** Only one run can claim the prefix; the others get the same 400 as a sequential reuse ('Branches under ... already exist').

**Actual:** All requests return 201. One run finishes; the others fail with "git worktree add ... qa-race/build failed: ... fatal: 'qa-race/build' is already checked out".

**Root cause (verifier):** The prefix is checked once, in RunManager.start, and nothing reserves it.

- src/engine.ts:5229-5230: `const branchPrefix = ...; await validateBranchPrefix(repo, branchPrefix);`. validateBranchPrefix (src/git.ts:580-590) only looks at existing git refs (`show-ref refs/heads/<prefix>` and `for-each-ref refs/heads/<prefix>/`). It runs outside any lock and records no claim.
- The first `<prefix>/<name>` branch is created much later, after start() has returned 201, in openWorktree (src/git.ts:503-528, called from engine.ts:2223-2229 openWorktreeLive).
- Every concurrent start therefore sees no refs and passes. Wrapping the validator in withRepoLock (git.ts:267) would not help, because the branch does not exist yet when the lock is released.
- In openWorktree (git.ts:517-519), when the branch already exists it takes the re-attach path, `git worktree add <path> <branch>`, and does not check who owns the branch.
  - While the winner's worktree is still checked out, git refuses with "already checked out". That error reaches the user unmodified through gitOk.
  - Once the winner's worktree is gone (archived with branches kept, or the folder deleted), a resume of the loser re-attaches the wi …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/git.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/patterns.test.ts`

**Suggested fix:** 1. Make the prefix claim atomic in RunManager.start (engine.ts ~5229).
   - After `await validateBranchPrefix(repo, prefix)`, check and claim the prefix synchronously, with no await between the check and the claim. Node is single-threaded, so that makes the pair atomic.
   - The check: reject when a per-repo in-memory `pendingPrefixes` set, or any known non-deleted run with the same repo, has a branchPrefix equal to the new prefix or path-nested with it (`a === b || a.startsWith(b + "/") || b.startsWith(a + "/")`).
   - Throw the same "Branches under "<prefix>/" already exist; pick another prefix" error, so the server returns 400 (server.ts already maps start errors to 400).
   - Remove the pending claim once the run is in this.runs. The persisted run's branchPrefix then keeps it reserved across restarts. Also remove it in the catch path when start() throws before registering.
   - Default `codeflow/<id>` prefixes are unique by id and can skip this.

2. Add an ownership check on the re …

**Suggested regression test:** In test/patterns.test.ts, next to "result branches use the chosen prefix, which can't be reused" (line ~262), add "concurrent starts can't share a branch prefix".

- Use one `new RunManager()` and call `Promise.allSettled([m.start({pattern: findPattern("pipeline")!, task: "a", repo, roles, options: {}, branchPrefix: "feat/race"}), m.start({...same, task: "b"})])`.
- Assert exactly one result is fulfilled and the other is rejected with /already exist/. Wait for the fulfilled run to finish, then a …

<details><summary>Verifier's independent reproduction</summary>

Setup: a fresh fake-mode QA server, v4671r on 127.0.0.1:4671, with a fresh home. I used a scratch clone of MQTT-MCP (clones/v4671r-mqtt, origin set to a local bare repo) and added it in the UI with "Open another repository" as project "MQTT v4671r". Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4671r/ (race.mjs, retry.mjs, cleanup.mjs), with logs race.log, retry.log and cleanup.log.

1. I started a fix-review run through the composer with branch prefix "qa-vcap" and captured its POST /api/runs body. The run finished as done on qa-vcap/build.

2. Sequential reuse works as intended. Sending the same body again with branchPrefix "qa-vcap" returned 400 {"error":"Branches under \"qa-vcap/\" already exist; pick another prefix"}.

3. Concurrent starts are not protected.
   - Two concurrent POSTs with branchPrefix "qa-vrace" both returned 201 (2610252149-9f68bd9a and 2610252149-38837e60). 38837e60 finished done on qa-vrace/build. 9f68bd9a failed with 0 steps and worktrees [], showing the raw error "git worktree add .../2610252149-9f68bd9a/build qa-vrace/build failed: Preparing worktree (checking out 'qa-vrace/build') fatal: 'qa-vrace/build' is already checked out at '.../2610252149-38837e60/build'".
   - Three concurrent POSTs with "qa-vrace3" all returned 201. One finished done and two failed with the same fatal error.
   - The run page shows this raw git text both in "The run could not finish" and in the Failed card, next to a "Retry unfinished work" button (screenshot shots/v4671r/003-failed-race-run.png).

4. Escalation: the failed run takes over the other run's branch on retry.
   - I archived the winning run 38837e60 through the UI with "clean up worktrees" on and branches kept. Then I clicked "Retry unfinished work" on the losing run 9f68bd9a (POST .../resume, 200).
   - The losing run re-attached the winner's existing branch qa-vrace/build. Its only log line was "Reusing existing worktree ... (branch qa-vrace/build); it was never fully set up, so setting it up now". It then committed e682f6a on top of the winner's commit 229b624 and finished done.
   - Its diff now contains the winner's file as well as its own.
   - During cleanup, archiving the loser with "delete branches" deleted qa-vrace/build, which was the winner's result branch. The winner's run record still pointed at that branch.

The issue reproduced from a fresh server, so it is not an artifact of the test …

</details>

### t17-4 · minor · Re-attach and Archive run 'git worktree prune', which breaks the user's own temporarily missing worktrees

**Fix outcome: fixed.** src/git.ts: new forgetWorktree(repo, path, branch?) replaces every unscoped `git worktree prune`, in openWorktree's re-attach, removeDetachedWorktree, and src/ship.ts removeWorktrees for a folder already gone. It reads `git worktree list --porcelain` and removes, by the path git recorded, only entries that are missing and are either code-flow's own path (compared after resolving the existing part of the path, so /tmp and /private/tmp or a symlinked CODEFLOW_WORKTREE_DIR match) or, when re-attaching, have that same code-flow branch. docs/getting-started.md says code-flow never prunes. Commit bd399e8.

Fixer's check: On f04b with a scratch repo, I created two user worktrees (git worktree add ../app-user-wt1 and ../app-user-wt2), each with a staged WIP.txt. (A) I moved user-wt2 away (prunable), then ran More run actions > Archive… > Remove its 1 worktree on a fix-review run. The run log said "Archived: removed 1 worktree(s)" and user-wt2 was still registered. (B) I moved user-wt1 away and replied to the archived run in the composer. The log said "Re-attached build ...", the follow-up finished, and user-wt1 was still registered. After moving both folders back, `git status --porcelain` in each printed "A  WIP.txt" (before the fix: "fatal: not a git repository"). Browser errors [].

Tests: `test/qa-run-worktree-lifecycle.test.ts: code-flow never prunes your own worktrees whose folder is missing just now (re-attach, removeWorktrees, scratch checkout, symlinked path)`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-01, GIT-07, GIT-03.

**Repro**

> 1. In the scratch clone: git worktree add ../t17-mqtt-stale -b qa-stale main. Move that folder away (stands in for an unmounted drive or renamed folder). 2. In code-flow, reply to an archived run so its worktree is re-attached (or Archive… any run with worktree removal). 3. Move the folder back and run git status inside it.

**Expected:** code-flow leaves other worktrees' metadata alone. The startup housekeeping comment says pruning would 'drop your own worktrees on a drive that isn't mounted right now'.

**Actual:** After the re-attach (run2 reply) the 'prunable' record was gone. After moving the folder back: 'fatal: not a git repository: .../.git/worktrees/t17-mqtt-stale'. Archiving run2 did the same to t17-mqtt-stale2, which held uncommitted WIP.txt.

**Root cause (verifier):** Three helpers run an unscoped `git worktree prune` on the whole repository. With no --expire, git deletes the admin dir (.git/worktrees/<id>) of every linked worktree whose folder is currently missing, including the user's own:

- src/git.ts:518, openWorktree. In the re-attach branch (the branch exists but the folder doesn't), it runs `git worktree prune` before `git worktree add path branch`. It is reached from src/engine.ts:2209 (reply/resume on an archived or cleaned-up run) and engine.ts:2224.
- src/git.ts:546, removeDetachedWorktree. After `worktree remove --force` and `rm -rf` of its own path, it runs a global prune. It is also called first by openDetachedWorktree (git.ts:532), so a prune happens on every base-commit check (engine.ts:1775/1784 checkOnBase, when a check fails), every scratch/proof checkout (engine.ts:2018/2055 scratchAt), tidyRunFolder on archive (engine.ts:3727), and readiness validation (src/readiness.ts:85/87 inTemporaryWorktree).
- src/ship.ts:462, removeWorktrees. After removing the run's own worktrees with `git worktree remove --force`, it runs a global prune. It is reached from Archive… with cleanup (engine.ts:3692), the automatic archive of runs with n …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/git.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/ship.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/git-reliability.test.ts`

**Suggested fix:** Replace the three global prunes with a path-scoped helper in src/git.ts, for example `forgetMissingWorktree(repo, path)`:
1. Read `git worktree list --porcelain` and find the entry whose worktree path matches `path`. Compare realpaths of the parent folders, because macOS maps /tmp to /private/tmp.
2. If that entry exists and its folder is missing, run `git worktree remove --force <path>`, and retry with `--force --force` if it is locked. This works on missing registered worktrees (verified on git 2.39). Optional fallback: delete only the matching .git/worktrees/<id> admin dir, found through its gitdir file.

Where to use it:
- openWorktree (git.ts:518): call forgetMissingWorktree(repo, path) instead of prune before `worktree add path branch`.
- removeDetachedWorktree (git.ts:546): call it for `path` after the rm -rf.
- removeWorktrees (ship.ts:462): call it for each wt.path that no longer exists on disk, instead of the final prune.

Do not use `git worktree add -f`, because it also ove …

**Suggested regression test:** Add a test to test/git-reliability.test.ts (it already imports openWorktree, removeDetachedWorktree and removeWorktrees), named for example "code-flow never prunes your own worktrees whose folder is temporarily missing".

Setup:
- Init a repo.
- Run `git worktree add ../user-wt -b user`, write user-wt/WIP.txt and `git add` it, then rename user-wt to user-wt.away.

Exercise each path:
(a) Re-attach: openWorktree(repo, "build", p, "codeflow/r1/build", "HEAD"), rm -rf p, then call openWorktree agai …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4667t174" on 127.0.0.1:4669. I used 4669 because 4667 was taken by another session's server (home v4665b), which I did not touch. Scratch clone: bare + working clone of MQTT-MCP at scratchpad/qa/clones/v4667-mqtt. In it I made two "user" worktrees with `git worktree add ../v4667-user-wt -b qa-user-v4667` and `../v4667-user-wt2 -b qa-user2-v4667`, each holding an uncommitted WIP.txt. I added the clone through the UI with Open another repository > Create project "v4667mqtt".

(A) Archive. I moved v4667-user-wt2 away, and git listed it as "prunable gitdir file points to non-existent location". I started a fix-review run (2610252149-ed1e409f) from the composer with the check empty. It finished, and the user record was still there, so creating a run does not prune. I then used More run actions > Archive… with "Remove its 1 worktree" checked and branches kept. The response was 200 {removed:[.../build], failed:[]}, the toast said "Archived", and the run log said "Archived: removed 1 worktree(s); branches kept". After that, `git worktree list` no longer had user-wt2 and .git/worktrees/v4667-user-wt2 was deleted. I moved the folder back and `git status` printed "fatal: not a git repository: .../v4667-mqtt/.git/worktrees/v4667-user-wt2". WIP.txt and the branch were still on disk.

(B) Re-attach. I moved v4667-user-wt away (prunable), then replied in "Reply to Codex…" on the archived run, whose worktree had been removed while its branch was kept. The response was 200 /followups with the toast "Sent — the agent is on it". The log said "Re-attached build at .../.worktrees/2610252149-ed1e409f/build" and the follow-up finished. The user-wt record and its admin dir were gone afterwards. I moved the folder back and `git status` printed "fatal: not a git repository: .../.git/worktrees/v4667-user-wt".

Plain sidebar "Archive" (no cleanup) on a solo run did not prune. The UI showed no error (errors []), so the side effect is silent.

Standalone git 2.39.5 check in a scratch repo: a bare `git worktree prune` drops every missing entry at once (no --expire grace period). `git worktree remove --force <missing path>` drops only that entry. A `git worktree lock`ed entry survives prune. `git worktree add <path> <branch>` onto a missing-but-registered path fails with "use 'add -f' to override, or 'prune' or 'remove' to clear", and a scoped `remove --force` then `add` re-attaches cleanly.

Refutation attempts that failed:
- Not by design: src/engine.ts:3351 …

</details>

### t17-13 · minor · After a run's branch is deleted, the run page still claims the work is saved and shows a raw git error

**Fix outcome: fixed.** src/engine.ts: new optional Run.deletedWorktrees. forgetDeletedBranch() moves a worktree out of run.worktrees when its branch is deleted, both on archive with deleteBranches and when a follow-up finds the branch gone. assertResultBranch() makes reviewCoverage, diff, validateMerge, merge, mergePr, pullRequest, push-pr and the PR watch answer with a RunConflictError (409): "Branch X was deleted, so this run's changes on it are gone. Start a new run instead." followUp() still accepts a deleted worktree, so the follow-up fails with the documented message. UI: ui/run-experience.ts branchesGone() makes nextRunAction return null. ui/run.tsx shows a "branch was deleted" note and no "Saved work" or result studio; ArtifactCard shows a "Branch deleted" badge with no actions; the composer drops deleted worktrees as reply targets and starts a new run from the base. ui/changes.tsx explains there are n …

Fixer's check: On f04b, a fix-review run archived through the dialog with "Also delete its branches" (toast "Archived · removed 1 worktree and 1 branch"), then Unarchive from the menu. The page had no "Branches and files are kept" banner, no result-studio and no "Fix check command". It showed "This run's branch was deleted, so its changes are gone. Start a new run to continue from here.", with no rev-parse or fatal alert. Under Details: a "Branch deleted" badge, no Merge…, no Open PR…. The composer targeted "Whole team · new run" instead of "Codex · build". A reply via POST /followups (worktree build) returned 200 and the follow-up failed with "Branch codeflow/<id>/build was deleted, so the work in build i …

Tests: `test/qa-run-worktree-lifecycle.test.ts: a run whose branch was deleted says so, and offers no review or merge from it`, `test/e2e/qa-run-worktree-lifecycle.e2e.ts: a run whose branch was deleted says its changes are gone and offers no review or merge`, `test/ship.test.ts: archive can remove worktrees and branches; PRs need a remote (updated)`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-07.

**Repro**

> 1. Archive a run with Also delete its branches. 2. Reply to it.

**Expected:** The run states the branch is gone. The result card offers no review or merge.

**Actual:** The follow-up failure text is right, but the banner still says 'Saved work: 1 worktree. Branches and files are kept.' The result card shows 'git rev-parse --verify refs/heads/codeflow/.../build^{commit} failed: fatal: Needed a single revision' next to Review changes.

**Root cause (verifier):** The run's worktree records are never updated when a branch is deleted, and the UI uses those records as proof that the result is still there.
- src/engine.ts:3692 (archive). `removeWorktrees(run.repo, run.worktrees, deleteBranches)` deletes the branches, but `run.worktrees` keeps every {name, branch, path} entry unchanged and nothing marks a branch as deleted.
- src/engine.ts:5453 (resume, used by follow-ups) sets `run.archived = false`. The Unarchive menu action does the same through setArchived(false). The follow-up then fails at src/engine.ts:2196-2197, as intended, but nothing records that the branch is gone. The only guard in the UI is `run.archived`: see the comment in ui/run-experience.ts:46 ("Archived runs are history. Their worktree records do not imply folders remain"), plus ui/experience.tsx:67 and ui/run.tsx:199. That guard stops applying once the run is unarchived.
- ui/run.tsx:304 shows "Saved work: N worktree(s). Branches and files are kept." whenever `finished && run.worktrees.length`, without checking that the branch exists.
- ui/run-experience.ts:49 (nextRunAction) still picks the artifact and branch, so the run gets "Fix check command … continuation from the save …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/ship.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/experience.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/types.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/hardening.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`

**Suggested fix:** 1. Record the deletion on the server. In RunManager.archive (src/engine.ts ~3692), for each branch in `result.deletedBranches`, set a flag on the matching `run.worktrees` entry, e.g. `branchDeleted: number` (a timestamp), and persist it. Add the optional field to the worktree type at src/engine.ts:435 and to the UI types. In Engine.worktree() (src/engine.ts:2196), also set the flag when `branchExists` is false, so branches deleted outside code-flow are handled too. Keep the record itself so history and the follow-up error still work.
2. Return clear errors from the API. In reviewCoverage (src/engine.ts:4284), the diff endpoint, and merge/PR/serve for a run branch, check `branchExists` (or the flag) first. If the branch is gone, throw a RunConflictError (409) such as "Branch X was deleted when this run was archived; its changes are no longer available. Start a new run." instead of passing gitOk's text through.
3. Make the UI use only live worktrees. Add a helper such as `liveWorktrees(r …

**Suggested regression test:** 1. test/hardening.test.ts: extend "follow-ups: … a deleted branch fails just that follow-up". After `manager.archive(run.id, { cleanup: true, deleteBranches: true })` and the failed reply, assert:
   - `run.archived === false`
   - `run.worktrees.find(w => w.name === 'build')!.branchDeleted` is set
   - `await assert.rejects(manager.reviewCoverage(run.id, branch), (e) => /was deleted/.test(e.message) && !/rev-parse/.test(e.message))`
2. test/run-experience.test.ts: next to "archived history does …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4685t1713, on 127.0.0.1:4685 with a new home. I made a scratch clone of MQTT-MCP (clones/v4685t1713-mqtt) and added it in the UI with "Open another repository" as a new project, "v4685 MQTT". Everything below was done in the UI with Playwright; scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4685t1713/.
1. Started a Fix & review run, 2610252154-e99129e9. It finished as "done" with one worktree, build, on branch codeflow/2610252154-e99129e9/build. The page looked normal.
2. Opened More run actions, chose Archive…, and ticked both "Remove its 1 worktree" and "Also delete its branches (nothing from this run has been merged yet)". The response was 200 with deletedBranches set to [codeflow/.../build]. `git branch --list` was empty and the folder was gone, but run.worktrees still held the build record. While archived, the page correctly showed no banner and no result card.
3. Replied in the composer: "QA v4685: reply after branch deleted". The reply unarchived the run (archived=false). The follow-up failed with the correct text, "Branch codeflow/2610252154-e99129e9/build was deleted, so the work in build is gone. Start a new run instead.", and the run stayed done, which docs/configuration.md:53 describes as intended.
4. On the run page:
   - The banner still said "No automated check is configured … You can configure a continuation from the saved result branch. Saved work: 1 worktree. Branches and files are kept." and offered "Fix check command".
   - The "Ready to review" card showed Review changes and Preview, with a role=alert error: "git rev-parse --verify refs/heads/codeflow/2610252154-e99129e9/build^{commit} failed: fatal: Needed a single revision". GET /api/runs/:id/review-coverage returned 400 with that same raw text.
   - Clicking Review changes opened a review page with two raw git errors (`git -c failed: fatal: ambiguous argument '2b97323…..codeflow/…/build': unknown revision…` and the rev-parse error) and "Loading diff…" that never finished.
   - Under "Details and publishing", the artifact card still offered Review changes, Merge…, Open PR…, Copy diff cmd and Copy path.
   - The composer still targeted "Codex · build".
   - The browser logged six 400 console errors.
5. A second run, 2610252156-f666a65b, was archived the same way and then restored with More run actions, Unarchive, with no reply sent. It showed the same bann …

</details>

### t17-8 · minor · Archive dialog toast says 'Archived' when worktree removal failed

**Fix outcome: fixed.** The Archive dialog moved to ui/archive-dialog.tsx and is lazily loaded through ui/run-actions.tsx. It reads the response: with `failed` it stays open with a styled role=alert ("Archived, but this couldn't be removed:" plus each reason) and a Close button; otherwise the toast says what happened ("Archived · removed N worktree(s) and N branch(es)" / "; branches kept" / "worktrees and branches kept"). src/engine.ts: archive() has an explicit ArchiveResult type with `failed` always present. A merge or PR merge that archives afterwards now returns what couldn't be removed as a warning, and MergePanel/PrMergePanel show it. Commits 9ca7959 and 55c050b.

Fixer's check: On f04b, a fix-review run whose worktree .git I replaced with a symlink to the repo's .git. More run actions > Archive… > Archive returned 200 with failed ["... isn't the checkout code-flow expects (its .git is a symbolic link) ..."]. The dialog stayed open with that reason in a styled alert, and a MutationObserver saw no toast. The worktree was still on disk. With .git restored, a control archive removed it. Re-verified after the dialog became lazily loaded. Browser errors [].

Tests: `test/qa-run-worktree-lifecycle.test.ts: archive reports a worktree it refused to remove`, `test/e2e/qa-run-worktree-lifecycle.e2e.ts: Archive… shows what it will do and says what it couldn't remove`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-08.

**Repro**

> 1. Break a run worktree's .git (make it a symlink to the main .git, or point it at another repository). 2. More run actions > Archive… > Remove its worktree > Archive.

**Expected:** The user is told the worktree could not be removed, and why.

**Actual:** The response holds failed: ['... isn't the checkout code-flow expects (its .git is a symbolic link)...'], but the toast only says 'Archived'. The failure is only in the Activity log. The worktree stays on disk.

**Root cause (verifier):** The cause is in ui/run.tsx:1666-1674, in the ArchiveDialog Archive button. It calls `post(`/api/runs/${run.id}/archive`, { cleanup, deleteBranches }).then(() => { showToast("Archived"); onClose(); }, ...)` and throws away the response body. The server reports partial cleanup failure as HTTP 200 with a non-empty `failed` array:
- src/server.ts:2591-2592 returns `{ archived: true, ...result }`.
- src/engine.ts:3682-3708 is Engine.archive. It collects `failed` from removeWorktrees, and tidyRunFolder's failures are added to it.
- src/ship.ts:442-454 is removeWorktrees. It pushes the assertWorktree refusal ("isn't the checkout code-flow expects…") or a `git worktree remove` error into `failed` and continues.
Because the request "succeeded", the UI always shows the generic 2-second "Archived" toast, the same text as a clean archive. The only record of the failure is the warn-level "Couldn't remove: …" line in the run's activity log, and the worktree stays on disk.
The same response is also ignored server-side when a merge archives the run afterwards: src/engine.ts:4375, 4470 and 4495 call `await this.archive(id, { cleanup: true })` and discard the result. The rail bulk archive (ui/rail.t …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/connections.e2e.ts`

**Suggested fix:** Fix ArchiveDialog in ui/run.tsx:
- Type the response as post<{ archived: boolean; removed?: string[]; deletedBranches?: string[]; failed?: string[]; retained?: string }>.
- When `failed?.length` is non-zero, do not show the plain "Archived". Show a message such as "Archived, but couldn't remove N worktree(s): <first reason>". Either keep the dialog open with an inline role="alert" error listing every `failed` entry, or show a long toast (about 8 s) that names the first reason and points to the Activity log.
- Optionally show `retained` too ("Archived; shared chat workspace kept") so the cleanup:true case that skips removal is also honest.
- A clean archive with cleanup can say "Archived and removed N worktree(s)".
Optionally, in Engine.archive, change the summary log line to level "warn" when result.failed is non-empty, so the Activity entry doesn't open with an info-level "Archived: removed 0 worktree(s)".
For the merge-then-archive paths (engine.ts:4375/4470/4495), add the archive re …

**Suggested regression test:** Add an e2e test, either in test/e2e/connections.e2e.ts (which already drives More run actions > Archive…) or in a new test/e2e/archive.e2e.ts. Steps:
1. Create a fake fix-review run and wait for it to finish.
2. Replace its worktree's .git with a symlink to the repo's .git, or delete it.
3. Open More run actions > Archive…, leave "Remove its 1 worktree" checked, and click Archive.
4. Assert that a toast or role=alert containing "couldn't remove" and "isn't the checkout code-flow expects" appears …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this on a fresh fake-mode QA server I started myself: name v4675t178 on port 4675, home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4675t178. I used a new browser profile and a new scratch clone of MQTT-MCP made with a bare clone plus a working clone.
1. In the UI I clicked "Open another repository" and created the project "v4675 mqtt scratch" for the scratch clone.
2. Through the API I created a fix-review run, 2610252150-846aa36f, and it finished with status done. It had one worktree, .worktrees/<run>/build. A solo run is a chat and has no "More run actions" menu, so it can't be used for this.
3. I backed up the worktree's .git file and replaced it with a symlink to the clone's main .git.
4. In the UI (script work/v4675t178/s2-archive.mjs, log s2.log) I opened #/run/<id> and clicked More run actions > Archive…. In the dialog, "Remove its 1 worktree" was checked by default. I clicked Archive.
Results:
- POST /api/runs/<id>/archive returned 200 with {"archived":true,"removed":[],"deletedBranches":[],"failed":["…/.worktrees/2610252150-846aa36f/build isn't the checkout code-flow expects (its .git is a symbolic link), so code-flow didn't run git there… Nothing was changed."]}.
- The only toast shown was "Archived". A MutationObserver recorded every .toast and saw nothing else. There was no role=alert, the dialog closed, and the screenshot shots/v4675t178/003-after-archive-click.png shows only the "Archived" toast.
- The worktree folder was still on disk and run.worktrees still listed it.
- The failure appears only in the run's event log, as an info line "Archived: removed 0 worktree(s); branches kept" followed by a warn line "Couldn't remove: …".
Control: I restored .git, unarchived, and archived again through the UI with "Also delete its branches" checked. The response was removed:[build], deletedBranches:[branch], failed:[], and the toast was again "Archived". The success and failure cases are indistinguishable to the user.
Refutation checks:
- docs/api.md and docs/runs.md describe Archive… as removing the worktrees and say nothing about failures being silent.
- The server deliberately returns failed[] and logs a warning, so the information is there; the UI simply drops it.
- The reporter's environment and selectors are not involved: I reproduced it independently with a fresh server, a fresh profile and my own script.
Cleanup:
- Both runs were removed (worktrees and …

</details>

### t18-17 · cosmetic · Archive dialog keeps 'Also delete its branches' ticked (disabled) after 'Remove its worktree' is unticked

**Fix outcome: fixed.** ui/archive-dialog.tsx: the delete-branches box renders checked={cleanup && deleteBranches}. Unticking "Remove its worktree" clears it, so re-ticking doesn't bring back a hidden choice, and the request posts the effective value. The hint reads "(only with its worktrees)". ui/styles.css dims a disabled `.small-dialog label.check`. Commit 9ca7959.

Fixer's check: On f04b (also after the lazy-load change): tick delete, then untick remove gave {rm:false, del:false, delDisabled:true}, label "Also delete its branches (only with its worktrees)", opacity 0.55. Re-ticking remove gave del:false. Archiving with remove unticked posted {"cleanup":false,"deleteBranches":false}; the toast read "Archived · worktrees and branches kept", and the branch and worktree were kept. Browser errors [].

Tests: `test/e2e/qa-run-worktree-lifecycle.e2e.ts: Archive… shows what it will do and says what it couldn't remove`

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-21.

**Repro**

> Run → More run actions → Archive… → tick 'Also delete its branches' → untick 'Remove its 1 worktree' → Archive.

**Expected:** The delete-branches box unticks, or reads as not applicable.

**Actual:** It stays checked but disabled, so it looks like branches will be deleted. The server ignores it and keeps branches and the worktree.

**Root cause (verifier):** ui/run.tsx:1656 renders the box as `<input type="checkbox" checked={deleteBranches} disabled={!cleanup} .../>`, so the display depends only on deleteBranches, not on whether deletion can apply. The cleanup checkbox's onChange at ui/run.tsx:1652 (`setCleanup(e.currentTarget.checked)`) never clears or masks deleteBranches. ui/run.tsx:1669 posts `{ cleanup, deleteBranches }` as-is, so the request can say deleteBranches:true with cleanup:false. The server ignores the flag in that case: src/server.ts:2591 passes it to engine.archive, and src/engine.ts:3687 (`if (!opts.cleanup) return { removed: [], deletedBranches: [] };`) returns before any removal or "Archived: ... branches kept" log line. The dialog's label CSS (ui/styles.css:1345 `.small-dialog label.check`) has no disabled style, so the label text doesn't dim either.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`

**Suggested fix:** In ArchiveDialog (ui/run.tsx:1640-1680), derive the effective value, `const willDeleteBranches = cleanup && deleteBranches;`. Render the second box with `checked={willDeleteBranches}` (the same pattern as ui/sweeps.tsx:264) and post `{ cleanup, deleteBranches: willDeleteBranches }`, so the request matches what is shown. If re-ticking "Remove its worktree" should not bring back a hidden ticked delete box, also call setDeleteBranches(false) in the cleanup onChange when it is unticked. Optionally, when cleanup is off, change the hint to something like "(only when its worktrees are removed)". Add a disabled style such as `.small-dialog label.check:has(input:disabled) { opacity: .55 }` so the whole row reads as not applicable. As a stretch, make the success toast say what happened, e.g. "Archived · worktrees and branches kept", using the response's removed and deletedBranches.

**Suggested regression test:** Add a Playwright case next to the existing archive-dialog flow in test/e2e/connections.e2e.ts (lines 167-169 already open "Archive this run" and uncheck the first box). Before unchecking, tick "Also delete its branches", then uncheck "Remove its N worktree". Assert `expect(dialog.getByRole('checkbox', { name: /Also delete its branches/ })).not.toBeChecked()` and `.toBeDisabled()`. Capture the /archive request with page.waitForRequest and assert its JSON body equals {cleanup:false, deleteBranches …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4635t18" on 127.0.0.1:4635 with a fresh home, using my own scratch clone of MQTT-MCP (bare at qa/clones/v4635-mqtt.git, working clone at qa/clones/v4635-mqtt). I added the clone as project "v4635-mqtt" through the UI (Open another repository, then Create project). I created 2 fix-review fake runs via the API (builder and reviewer both claude, check "true"). Both finished "done" with branch codeflow/<id>/build. Solo runs don't work for this: they are chat runs, and run.tsx:252 hides "More run actions" when `chat` is true. Script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4635t18/archive.mjs (log in archive.log in the same folder), run A, went: open run, More run actions, Archive…, tick "Also delete its branches", untick "Remove its 1 worktree". Checkbox state was then {rm:false, del:true, delDisabled:true}. The label colour is the same rgb(79,83,74) for both rows, so only the box itself greys out (screenshots qa/shots/v4635t18/A-dialog-body-zoom.png and 001-A-dialog-before-archive.png show a greyed but still-ticked box next to full-contrast "Also delete its branches" text). Clicking Archive POSTs {"cleanup":false,"deleteBranches":true}. The only feedback is the toast "Archived". The run log gets no "Archived: ..." line because engine.archive returns before its logging when cleanup is false. Afterwards the worktree was present and the branch was kept, so the dialog showed something the server didn't do. Run B: tick delete, untick remove, re-tick remove, giving {rm:true, del:true, delDisabled:false}. The hidden ticked state comes back active once cleanup is re-enabled. I then cancelled. No console or 5xx errors. Not by design: docs/github.md:34 and docs/api.md:53 say branch deletion is an optional extra on top of worktree removal, and cleanup:false keeps worktrees and branches, so a ticked "delete" box is never meaningful here. The codebase's own convention for a disabled, not-applicable checkbox is to render it unchecked: ui/sweeps.tsx:264 uses checked={picked.has(i.key) && pickable(i)}. No data loss, because the mismatch errs toward keeping more. The user may still believe their branches were deleted and leave stale codeflow/* branches behind, so it stays cosmetic. Cleanup: I re-archived both fix-review runs through the UI with both boxes ticked (the positive path worked: worktrees and branches removed). I archived my 2 solo chat fixture runs via the  …

</details>

### t18-18 · minor · Archived or merged runs show no 'Archived' state; the Review merge panel stays active after merge+archive

**Fix outcome: fixed.** ui/run-experience.ts runStateBadges(); ui/run.tsx renders "Archived" and "Merged into X" pills in the run kicker, with a shrinkable style in ui/styles.css. MergePanel takes onMerged: a successful merge clears the stale verification and closes the panel, both on the run page and the Review page. Reopened, it defaults to a target the branch hasn't been merged into, and shows "Already merged into X: merging again brings only what's new..." when one is picked. docs/runs.md header line updated. Commit 55c050b.

Fixer's check: On f04b, Review page > Publish changes > Actions > Merge… > qa-target > Validate merge result (verified) > Merge into qa-target with "Archive the run afterwards". Toast: "Merged into qa-target and archived the run". After that, the panel was closed, with 0 "Merge into qa-target" buttons and 0 "Merge verification" lines. After a reload, Merge… opened on target main (not qa-target); choosing qa-target showed the already-merged hint. The run page kicker read "Finished · Archived · Merged into qa-target · Fix & review". Browser errors [].

Tests: `test/qa-run-worktree-lifecycle.test.ts: the header says a run is archived and where it was merged`, `test/e2e/qa-run-worktree-lifecycle.e2e.ts: Archive… ... (asserts the kicker shows Archived)`

Source: tester unit git-review-merge-2; observed with real-agents; features GIT-21.

**Repro**

> Merge a result with 'Archive the run afterwards' → open the run page and its Review page.

**Expected:** An 'Archived' badge on the run, and the merge panel disabled or replaced by 'Merged into X'.

**Actual:** The run page shows only 'Finished' (Unarchive is visible only inside the menu). The Review page still shows an enabled 'Merge into qa-target' with the old 'Merge verification: verified' line next to the 'Merged into qa-target' badge.

**Root cause (verifier):** 1) ui/run.tsx:245-251 (run-kicker): renders only the status pill from executionLabel(run) (ui/run-experience.ts:15-20, which maps status "done" to "Finished") and the pattern name. Nothing reads run.archived or run.merges, so an archived or merged run looks the same as a live finished one. The only archive cue is the menu label at run.tsx:258.
2) ui/run.tsx:1012-1088 ArtifactCard / 1330-1394 MergePanel: the panel is local state (`panel`, set by "Merge…"), and the "Merge…" button is gated only on `worktree && !run.testRun` (line 1040). Engine.archive (src/engine.ts:3682-3709) removes the worktree directories but leaves run.worktrees in place, so `worktree` stays truthy after archive.
3) MergePanel never reads run.archived or run.merges, and merge() (lines 1350-1361) does not close the panel or clear `validation` when a merge succeeds. As a result, the enabled "Merge into <target>" button and the "Merge verification: verified" line (line 1379) sit next to the new "Merged into" badge (lines 1024-1028).
The server guard in src/engine.ts:4366 (isAncestor, "Nothing to merge") stops a duplicate merge, so nothing is corrupted. The cost is a misleading UI and a click that fails with a 400.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-experience.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-experience.test.ts`

**Suggested fix:** (a) Run header: in the run-kicker (ui/run.tsx ~250), add `{run.archived ? <span class="status-pill">Archived</span> : null}`, plus a "Merged into X" pill when run.merges.length, the same way ui/project.tsx:205-206 RunRow does. The label can live in a small helper in ui/run-experience.ts (e.g. runStateBadges(run)) so it can be unit-tested. Consider an inline "Unarchive" link and disabling or hinting the reply composer for archived runs.
(b) MergePanel / ArtifactCard: on a successful merge, call setPanel(null) through a callback prop such as onMerged, and clear `validation`.
(c) When the branch has already been merged into the selected target, or the run is archived (worktrees removed), replace the button row with a read-only line: "Merged into <into> (<commit 8>) · run archived", like PrMergePanel's MERGED message. Either hide the "Merge…" action in ArtifactCard for archived runs, or keep it to merge into a different target but default the select to a branch not already in run.merges an …

**Suggested regression test:** test/e2e/ui.e2e.ts, right after the existing `await page.getByRole("button", { name: "Merge into main" }).click(); await page.locator(".badge", { hasText: "Merged into main" }).waitFor();` (~line 198-200), assert:
- `await page.getByRole("button", { name: "Merge into main" }).count() === 0`, or that the button is disabled.
- No `.ship-panel` contains "Merge verification".
- `page.locator(".run-kicker")` contains "Archived" after archiveAfter.
For a cheap unit test, put the header badge logic in  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4637 on 127.0.0.1:4637. Made a scratch bare clone and working clone of MQTT-MCP (clones/v4637-mqtt, plus a local branch qa-target) and added it through the UI ("Open another repository" -> new project "v4637 MQTT"). Started a Fix & review run through the composer (check "true"). It finished with artifact codeflow/2610252218-3eb4e75e/build. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4637 (s1-s4, z-cleanup).
Steps on the Review page: Publish changes -> Actions -> Merge… -> target qa-target -> Validate merge result (shows "Merge verification: verified · target 2b97323ce7d2 · 1 gates") -> Merge into qa-target, with "Archive the run afterwards" ticked by default.
Server state afterwards (API): archived=true, one merge recorded into qa-target, worktree directory removed. git log on qa-target shows the merge commit.
UI on the same Review page (shots/v4637/002-review-after-merge.png):
- The "Merged into qa-target" badge appears.
- The merge panel stays open with an enabled "Merge into qa-target" button and the old "Merge verification: verified" line.
After a full reload of the Review page:
- The panel is closed, but Actions still offers "Merge…".
- Reopening it shows an enabled "Merge into main" (the target falls back to the run's base).
Clicking the stale button for qa-target again only fails on the server: HTTP 400 and the toast "Nothing to merge: qa-target already has everything on …". qa-target was unchanged.
Run page after reload (shots/v4637/004-run-archived.png): the kicker is only "Finished · Fix & review", there is no Archived text anywhere on the page, and the reply composer is still active. "Unarchive" exists only inside the More run actions menu (menu items: Save as team template…, Edit & run again, Unarchive, Delete…).
Why this is not the tester's environment: it reproduces from a fresh home, in fake mode, through the UI with selectors driven by role and label. Why it is not by design: no doc says archived runs should be unmarked. docs/runs.md:13 says only that the header shows execution status. The rest of the UI does mark archived runs: the project history row (ui/project.tsx:205-206 shows "Archived" and "Merged" pills), the rail (ui/rail.tsx:236 "· archived"), Insights (ui/insights.tsx:386), and the GitHub PrMergePanel, which hides its actions once the PR is merged (run.tsx ~1447-1468). Cleanup: both runs deleted throug …

</details>

### t04-14 · minor · Agent conversation runs have no UI path to remove their worktree/branch; deleting runs leaves them behind

**Fix outcome: fixed.** src/engine.ts: new RunManager.archiveTask(id, {cleanup, deleteBranches}). It resolves the whole chat task (chatTaskId: tabs, side chats, team task runs) and refuses with 409 while any member runs. It archives every member, removes each workspace owner's worktrees once (branches too with deleteBranches), records deleted branches on every member that listed them, then tidies every member's folder. src/server.ts: POST /api/runs/:id/archive accepts `task: true`. ui/rail.tsx: the sidebar row menu gains "Archive and clean up…" ("Clean up…" when archived), which opens the Archive dialog in conversation mode. The Delete dialog points to it. Per-tab archive still keeps the shared workspace. docs/api.md, docs/runs.md and docs/getting-started.md updated. Commit 9ca7959.

Fixer's check: On f04b, a claude Agent chat plus a side chat sent from the side panel. The chat's header still has no More run actions, as before. The sidebar row Run actions menu listed [Archive, Archive and clean up…, Delete…]. The dialog "Archive this conversation" said "Archives the conversation with its agent tabs and side chats. Remove its 1 worktree ...". With "Also delete its branches" ticked, the request was {cleanup:true, deleteBranches:true, task:true} and the toast read "Archived · removed 1 worktree and 1 branch". Both runs ended up archived with 0 worktrees, and the conversation's worktree, codeflow branch and .worktrees folders were gone. The only worktrees left belonged to other chats. Re-v …

Tests: `test/qa-run-worktree-lifecycle.test.ts: an Agent conversation can be archived as a whole, removing the worktree and branch its chats share`, `test/qa-run-worktree-lifecycle.test.ts: a chat task can't be archived as a whole while one of its chats runs`, `test/e2e/qa-run-worktree-lifecycle.e2e.ts: an Agent conversation is archived and cleaned up from the sidebar`

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-01.

**Repro**

> 1. Create several Agent chats on a scratch repo.
> 2. Open a finished chat: no 'More run actions' (Archive…/Delete…) menu in its header.
> 3. Sidebar → Select runs → Select loaded → Delete… (or row menu Archive).
> 4. `git worktree list` in the repo.

**Expected:** Some UI action (Archive with 'Remove its worktree' / delete branches) is available for chats, as for other runs.

**Actual:** After deleting all 26 runs via the UI, the scratch clone still had 23 worktrees under .worktrees and 23 codeflow/* branches.

**Root cause (verifier):** These are design decisions that each make sense alone, but together they leave chats with no way to clean up:
- ui/run.tsx:196 sets `const chat = !!p?.chat && !run.checkpointOnFinish`, and ui/run.tsx:252 renders `{finished && !chat ? <Menu label="More run actions" …>`. That menu holds the only ArchiveDialog (ui/run.tsx:1639–1680, with "Remove its N worktrees" / "Also delete its branches"), so a chat never gets it. test/e2e/ui.e2e.ts:1188 asserts the menu is absent for Agent chats, so this is deliberate.
- ui/rail.tsx:143–147 `archiveTask` posts `{ archived, cleanup: false }` for every member of the family. The sidebar row menu (ui/rail.tsx:239–245) and bulk Archive (ui/rail.tsx:445) only offer that non-cleaning archive.
- src/engine.ts:3688–3691 `archive()` returns "Shared chat workspace retained" for any run with chatLink, teamTurns, taskExecution or a sibling whose chatLink.workspaceId points to it. Cleaning one tab must not discard another tab's files (test/chat-options.test.ts:103). There is no family-level "clean the whole task" operation, so even a correct UI request for a multi-tab task would be refused. A standalone chat passes this check, as step 6 showed.
- src/engine.ts: …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run-actions.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/getting-started.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`

**Suggested fix:** 1. Engine: add a task-level cleanup, e.g. `archiveTask(rootId, {cleanup, deleteBranches})` or `POST /api/runs/:id/archive {family:true}`. It resolves the whole chat family (chats, side chats, provider forks, task executions), refuses while any member is running, and archives every member. Only then does it remove the shared workspace's worktrees, delete the codeflow/<id>/* branches when asked, tidy each .worktrees/<id> folder and purge run memory, all once. It keeps the existing per-tab protection: one tab of a multi-tab task still cannot discard the others' files.
2. UI, sidebar: rename the row and bulk "Archive" to "Archive…" and open a task-level dialog matching ArchiveDialog: "Remove the task's worktree (uncommitted changes in it are lost)" plus "Also delete its branches". Show the uncommitted-changes count from the workspace status. Default cleanup to off for chats, so today's quick-archive behaviour stays available.
3. UI, delete: in DeleteRunsDialog, add an optional "Also remove …

**Suggested regression test:** Engine: in test/chat-options.test.ts, next to the existing shared-workspace test at around line 103, add a test that creates a source chat plus a provider fork and a side chat, then calls the new task-level archive with {cleanup:true, deleteBranches:true}. Assert that every member is archived, the shared worktree path no longer exists, `git branch --list 'codeflow/<id>/*'` is empty, and .worktrees/<id> is gone. Keep the existing assertion that a per-tab archive of one child still leaves unsaved. …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4693 on 127.0.0.1:4693, with a scratch clone of MQTT-MCP (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4693-mqtt) added through "Open another repository" as project v4693-scratch. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4693/ (a1–a7, with logs).
1. Composer, default Agent mode (AI team Off), Claude Code: sent three chats ("Create a file chat-N.txt…"). Each finished "done", pattern solo, with worktree .worktrees/<id>/solo on branch codeflow/<id>/solo. Fake work is left uncommitted, so each branch still equals main. Git showed 4 worktrees and 4 branches.
2. Opened finished chat 1. getByRole('button', {name: 'More run actions'}) count was 0 and .run-actions was empty (screenshot shots/v4693/001-row-menu.png). The result card's "More options" holds only Mark as test run / Preview settings / Record your assessment / Show me what changed / Try two alternatives. The sidebar row menu "Run actions" holds only [Archive, Delete…].
3. Sidebar row Archive on chat 2 sent POST /api/runs/<c2>/archive {"archived":true,"cleanup":false}. The run was archived and the worktree stayed. The archived chat still had no header menu.
4. Select runs → checked chat 3 → Delete…. The dialog says "Git branches, worktrees and repository files are kept. Archive instead if you want to keep the conversation." After confirming, GET /api/runs/<c3> returned 404, but .worktrees/<c3>/solo and its branch were still in git.
5. Trying to refute it: Insights → Disk → Measure → days=0 → Clean up → "Remove worktrees". This sent POST /api/cleanup {olderThanDays:0} and the toast said "Removed 2 worktree(s) from 2 run(s)". The worktrees of chats 1 and 2 were removed. Their branches stayed, as did the empty .worktrees/<id>/ folders. Chat 1's uncommitted file (claude-93d75e96.txt) was lost along with the worktree. Deleted chat 3 no longer appears in Insights, so nothing in the UI can reach its worktree.
6. Backend check on a fourth standalone chat, via the API because no UI offers it: POST archive {archived:true, cleanup:true, deleteBranches:true} returned 200 with removed=[worktree] and deletedBranches=[codeflow/<c4>/solo]. The server can already clean a standalone chat; the UI just never asks.
7. Show archived runs → Select runs → Select loaded → Delete 3 runs. /api/runs became []. git still listed 1 wor …

</details>

### t08-15 · minor · Archive with worktree and branch cleanup, then delete, of an Agent side-chat run leaves its .worktrees/<id>/.context folder

**Fix outcome: fixed.** src/engine.ts archive(): a run that is only a linked chat (chatLink, no teamTurns or taskExecution, not itself an owner) still keeps the shared workspace (retained), but now runs tidyRunFolder on its own folder and reports failures. tidyRunFolder now only counts worktrees inside the run's own folder, so the shared workspace it lists no longer blocks tidying its own .context; .context still goes only with deleteBranches. Its signature is unchanged. Commit 9ca7959.

Fixer's check: On f04b, a solo claude run; a side chat sent from the side panel Chat tab created a kind=side run that had its own .worktrees/<side>/.context. POST /archive {cleanup:true, deleteBranches:true} returned retained "Shared chat workspace retained" with failed []; then DELETE. .worktrees/<side> was gone, the source's shared worktree was kept, and .worktrees listed only other runs' folders.

Tests: `test/qa-run-worktree-lifecycle.test.ts: archiving a side chat with its branches clears its own folder and keeps the shared workspace`

Source: tester unit side-panel-previews-1; observed with api; features SIDE-07.

**Repro**

> 1. On a solo Agent run, Chat tab → Side chat → send (creates a provider-chat kind=side run).
> 2. Archive that side-chat run with cleanup:true and deleteBranches:true (the endpoint the Archive dialog uses), then delete it.
> 3. ls <repo>/.worktrees.

**Expected:** Per docs/runs.md, archiving with branches removed also clears the run's folder in .worktrees/, including its staged context.

**Actual:** <repo>/.worktrees/2610251509-1a63cf7d/.context/{messages/portable-conversation.md, attachments/chat-handoff-…md} (8KB) remains after the run is gone.

**Root cause (verifier):** src/engine.ts:3688-3691 (RunManager.archive): `if (run.chatLink || run.teamTurns?.length || run.taskExecution || …) return { …, retained: "Shared chat workspace retained" }`. This returns before both removeWorktrees, which is correct because the worktree is shared, and tidyRunFolder (engine.ts:3693), which is wrong to skip. Every chat-linked run (side chat or chat tab) still gets a private folder: start() sets worktreeDir = <repo>/.worktrees/<childId> (engine.ts:5233) and prepareContext stages .context there (engine.ts:5238). Nothing ever removes it. deleteRun (engine.ts:3610-3628) deliberately touches no files. tidyWorktrees (engine.ts:3356) only logs orphans. Insights Clean up (server.ts:2898) only removes worktrees.

There is a second blocker. Removing the early return alone would not fix this, because tidyRunFolder (engine.ts:3724) only runs when `!run.worktrees.some(w => existsSync(w.path))`. A linked chat's run.worktrees holds the owner's shared solo checkout, pushed at engine.ts:2183. That checkout still exists, so the tidy step would be skipped anyway.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/chat-options.test.ts`

**Suggested fix:** In archive() (engine.ts:3688), keep refusing to remove the shared worktree. When the run is only a linked chat (run.chatLink set, no teamTurns/taskExecution, and no other chat uses it as its workspaceId), still call tidyRunFolder(run, !!opts.deleteBranches). Return its failed list together with retained:"Shared chat workspace retained".

In tidyRunFolder (engine.ts:3724), check only the worktrees inside the run's own folder. Filter run.worktrees to paths where relative(resolve(run.worktreeDir), resolve(w.path)) is non-empty, does not start with "..", and is not absolute. A linked chat's entry for the shared workspace (under the owner's folder) then no longer blocks removing its own .context and scratch checkouts. The existing semantics stay: .context is removed only with deleteBranches, and the folder is removed only once empty.

I applied exactly this in my snapshot copy. The new test passed and all 6 tests in test/chat-options.test.ts passed, including the shared-worktree and unsaved …

**Suggested regression test:** test/chat-options.test.ts, in the provider-tab test after `await manager.archive(child.id, { cleanup: true, deleteBranches: true })` (line 103), add `assert.ok(!existsSync(child.worktreeDir))` alongside the existing unsaved.txt retention assertion. Or add a dedicated test:
1. Start a solo run and write an unsaved file in its worktree.
2. Call startProviderChat(source.id, { agent: "codex", kind: "side", message: "…" }) and wait until idle. Assert existsSync(join(side.worktreeDir, ".context")).
3. …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4601 on port 4601. The old v4601 home was moved aside first. I used a scratch clone of MQTT-MCP at clones/v4601-t0815-mqtt, added through the UI with "Open another repository" plus a new project.
1. Started a solo Codex run through the API (2610251938-e3f40456). It finished with .worktrees/2610251938-e3f40456/{solo,.context}.
2. In the UI I opened #/run/<id>, went to Side panel → Chat, typed into "Ask Claude Code about this run…" and pressed Send. This POSTs to /provider-chat with kind:"side" and created run 2610251939-c039d55e with chatLink {kind:"side", workspaceId: owner}. Its worktrees list only the owner's shared solo path. Its own folder .worktrees/2610251939-c039d55e/.context/{attachments/chat-handoff-2610251938-e3f40456.md, messages/portable-conversation.md} is 8 KB.
3. POST /api/runs/<side>/archive {cleanup:true, deleteBranches:true} returned {"removed":[],"deletedBranches":[],"failed":[],"retained":"Shared chat workspace retained"}. DELETE /api/runs/<side> returned {deleted:true}. The side chat's .context folder was still there.
4. For comparison, archiving the owner with the same flags removed its worktree, its branch, its .context and the whole .worktrees/2610251938-e3f40456 folder. Only .worktrees/2610251939-c039d55e/.context/... was left. It holds a copy of the conversation transcript ("Conversation handoff…", "Original user request…").
5. After restarting the QA server, server.log warns at startup: "Worktree folders no run owns (left alone; remove them if you don't need them)" folders:[…/.worktrees/2610251939-c039d55e]. CodeFlow itself treats this leftover as an orphan.
6. In a snapshot copy (builds/v4601) I wrote a focused node:test. It runs startProviderChat(kind:"side"), then archive with cleanup and deleteBranches, then deleteRun, and asserts !existsSync(side.worktreeDir). It fails on current code.

Things I checked while trying to refute it:
- The shared-workspace guard is intentional: comment at engine.ts:3689, and test/chat-options.test.ts:103-104 asserts the shared worktree survives. But neither the code nor the docs say the linked chat's own staging folder should be kept.
- Delete keeping files is by design: the run-actions.tsx:40 dialog text and docs/api.md:54.
- The reporter's step 2 is only reachable through the API: the UI hides "Archive…" for chats (run.tsx:252, `finished && !chat`) and the sidebar archive sends cleanup:false (rail.tsx:146). The endpoint defaults to cleanup:true and is do …

</details>

### t17-15 · minor · Copy patterns that are skipped (absolute path, '..', missing file) produce no warning

**Fix outcome: fixed.** src/repo-config.ts copyIntoWorktree now also returns `skipped`, each with a reason. Patterns that are absolute, use `..`, `.` or empty parts, or name a folder are flagged invalid. A missing file is "it isn't in your checkout" and a glob with no match is "no file in your checkout matches it". For `/.env` it suggests writing `.env`, only when that file exists in the repo. src/engine.ts prepareWorktree logs each skipped or refused pattern once per run (invalid ones as warn, missing optional files as info), and refusals no longer repeat per worktree. docs/configuration.md updated. Commit 0ee1907.

Fixer's check: On f04b, a scratch repo whose committed .codeflow/config.json had copy [.env, link.env (symlink), README.md, ../chat/README.md, /etc/hosts, missing.env, config/*.local.json, ./sub/../.env, /.env]. In a solo run and in a 3-worktree race, the run log had exactly one line for each pattern: symlink and not-ignored refusals (warn); ../chat/README.md and ./sub/../.env flagged for `..`/`.` parts (warn); /etc/hosts as an absolute path, with no suggestion (warn); missing.env "isn't in your checkout" (info); config/*.local.json "no file in your checkout matches it" (info); and /.env as absolute "(for the one in the repository, write `.env`)" (warn). No line repeated per worktree in the race.

Tests: `test/qa-run-worktree-lifecycle.test.ts: copy patterns that copied nothing say why`

Source: tester unit git-review-merge-1; observed with fake-agents; features GIT-05.

**Repro**

> Set .codeflow/config.json copy to include '../t17-studio/README.md', '/etc/hosts' and 'missing.env', then start a run.

**Expected:** The run log says which copy patterns were ignored and why.

**Actual:** The log mentions only copied files and refusals for symlinked or tracked files. The other three patterns disappear without a trace.

**Root cause (verifier):** src/repo-config.ts:97 drops invalid patterns (empty, absolute "/...", NUL, or any "", "." or ".." segment) with a bare `continue` and does not add them to `refused`. src/repo-config.ts:99-100: for a non-glob pattern, expand() returns it unchanged, and when the file is missing `lstat` returns null, so `if (!info) continue;` skips it silently. A glob that matches nothing makes expand() (src/repo-config.ts:255-274) return [], so that is silent as well. src/repo-config.ts:105 (`if (!info.isFile()) continue;`) silently skips directories too. The only caller that reports anything is Engine.prepareWorktree (src/engine.ts:2264-2267), which logs only `copied` and `refused`. The base and scratch check worktrees (src/engine.ts:1778, 2020, 2031) ignore the result entirely. readRepoConfig (src/repo-config.ts:55) also silently drops copy entries that are not strings.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/repo-config.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/configuration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/repo-config-copy.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/workspace.test.ts`

**Suggested fix:** In copyIntoWorktree, put the raw pattern into `refused` (or into a new `skipped` list) instead of a bare `continue`, with a reason for each case:
- absolute pattern: "it's an absolute path; copy patterns are relative to the repository root". For a leading "/", suggest the version without the slash, because gitignore users write "/.env".
- pattern with "..", "." or empty segments: "it reaches outside the repository or isn't a plain repo-relative path".
- non-glob pattern whose file is missing: "it isn't in your checkout".
- non-glob pattern that is a directory: "it's a folder; list the files or use a * pattern".
- glob that matches nothing: "no files match".
Return the missing and no-match cases as a separate `skipped` array (or with a flag), so prepareWorktree can log them at info level and keep the invalid-pattern cases at warn. Optional entries such as ".env.local" are legitimately absent in some checkouts and should not raise a warning. In Engine.prepareWorktree, log each pattern on …

**Suggested regression test:** In test/repo-config-copy.test.ts, add a test with the existing fixture (gitignored .env). Call copyIntoWorktree(repo, worktree, ["/.env", "../outside/credentials", "./a/../.env", "missing.env", "nomatch/*.json", ".env"]). Assert that copied equals [".env"]. Assert that refused (or skipped) contains entries for "/.env" (why matches /absolute/), "../outside/credentials" and "./a/../.env" (why matches /outside the repository|repo-relative/), "missing.env" (why matches /isn't in your checkout|not fo …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4689-t1715 on 127.0.0.1:4689, with a new home. I made a scratch clone (bare clone, then clone) of MQTT-MCP. In it I committed .codeflow/config.json with check "true", prove false and copy [".env", "link.env", "README.md", "../t01-MQTT-MCP/README.md", "/etc/hosts", "missing.env", "config/*.local.json", "./sub/../.env"]. I also created a gitignored .env and a link.env symlink. I added the clone through the UI (Open another repository, then New project "v4689 copy") and started a default run from the composer (run 2610252154-4bc77e9b, finished "done"). The run's loop.copy held all 8 patterns, but the run log (homes/v4689-t1715/runs/<id>.jsonl) had only three copy lines:
- [info] "Copied .env from your checkout into solo"
- [warn] "Didn't copy link.env: it's a symbolic link"
- [warn] "Didn't copy README.md: git doesn't ignore it, so it would be committed with the agents' work"
Nothing mentioned ../t01-MQTT-MCP/README.md (that file exists), /etc/hosts, missing.env, config/*.local.json (no match) or ./sub/../.env. There were no console or 5xx errors.

I also called copyIntoWorktree directly via tsx in a scratch dir, with patterns ["/.env", "../repo/.env", "missing.env", "nomatch/*.json"], on a repo that has a gitignored .env. It returned {"copied":[],"refused":[]}. So "/.env", which is how .gitignore anchors a file to the repo root and therefore a likely way to write it, quietly copies nothing.

Reasons it is not by design or environmental: docs/configuration.md:50 says only that "Patterns can't reach outside the repo". It never says rejected patterns go unreported. The function's own docstring (src/repo-config.ts:80) says it "Returns the copied paths and the ones refused (with why)", yet these never appear in refused. The tester's setup is not the cause; I reproduced it on a fresh server with my own config. Existing tests only assert copied ([test/workspace.test.ts:87-91] and repo-config-copy.test.ts "source parent links..." assert refused[0] is the symlink case), so this gap was never covered.

Why minor and not higher: the skip is the safe outcome, since nothing leaks outside the repo. The cost is diagnosability. A mistyped or gitignore-style pattern leaves the worktree without its .env and nothing says why. Warning on missing files needs care, because the documented example lists optional entries like ".env.local".

</details>

## Final snapshot follow-through

A complete-suite failure led to three independently reproduced snapshot boundaries. `cb2692f` preserves a conservative copied-index timestamp so same-size recent edits remain visible without changing the real index. `20b70da` compares working-tree and index trees from the same stash capture, detects staging-only changes and restores the saved staging state with `stash apply --index`. Existing content/commit warning behavior remains; otherwise invisible index changes report staging paths. Five new regressions plus19 related tests pass. [Fix evidence](../final-snapshot-index-review.md) and [independent linked-worktree review](../final-git-index-review.md) preserve baseline failures, unchanged controls, original index bytes/mtime and parent-checkout checks. Final combined validation remains in [validation](../final-validation.md).
