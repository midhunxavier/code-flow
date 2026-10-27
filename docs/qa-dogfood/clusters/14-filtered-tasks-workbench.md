# Cluster 14 · filtered-tasks-workbench

**Filtered tasks & repository tools: secrets classification, destructive cancel, checkpoints**

Status: **merged into continuation · targeted checks pass · original browser replays completed** · 10 issues · branch `qa-fix/filtered-tasks-workbench`

Planner notes: t23-3: sensitiveContextPath in src/context-inspection.ts tests only the last path segment, so the export and the result validation classify a committed secrets/ directory differently and every filtered task fails. t23-4/S08-5: 'Cancel task and confirm container stopped' is enabled for completed tasks, and FilteredTasks.cancel (src/filtered-tasks.ts:167) discards the importable result. Refuse, or ask for confirmation, in terminal states. t23-16: one generic validation message, and denied paths are not named. t23-11: Repository tools with no project selected says 'Create a project first' although projects exist (ui/workbench.tsx:61). Checkpoints (ui/workbench.tsx, src/workspace.ts, src/checkpoint-review.ts): refusal messages are misleading (t18-8); 'Apply selected files' deletes files missing from the checkpoint because git restore defaults to no-overlay mode (t18-9); fork accepts commits from before the run started (t18-10, src/server.ts ~2559); the folder selector offers worktrees of archived runs (t18-11). S01-5: the workspace+project branch in ActivityView is dead code (ui/activity.tsx, ui/app.tsx:149). Duplicate groups: [["t23-4","S08-5"]]

Likely files: `src/filtered-tasks.ts`, `ui/filtered-tasks.tsx`, `src/context-inspection.ts`, `ui/workbench.tsx`, `src/workspace.ts`, `src/checkpoint-review.ts`, `src/workspace-changes.ts`, `src/server.ts`, `ui/activity.tsx`, `ui/app.tsx`

## Fix result

Commits:
- `db36980` Walk a readable secrets/ folder in filtered task results
- `af8e83c` Keep a finished filtered task's result when Cancel is pressed
- `54d10d8` Say which filtered task field is invalid and why a start is refused
- `6e16047` Drop the unreachable project header from Repository tools
- `494c672` Ask for a project in Filtered tasks instead of saying none exist
- `accae0e` Explain checkpoint refusals instead of using file-draft wording
- `19b52ae` Ask before Apply selected files deletes a file the checkpoint lacks
- `27aa4e0` Fork only from checkpoints that belong to the run
- `26d701e` Hide removed and duplicate worktrees from the repository tools
- `1e9736b` Cover the checkpoint, folder and filtered task fixes with tests

Fixer notes for the integrator: No existing test files were edited; all new coverage is in test/qa-filtered-tasks-workbench*.test.ts and test/e2e/qa-filtered-tasks-workbench.e2e.ts.

Behaviour and API changes to know when merging:
1. POST /api/workspace/apply-checkpoint now returns 409 when HEAD has moved (it used to be a 400 with the file-editor text). When the restore would delete tracked files it returns 409 with confirm "deleteFiles"; callers must re-post with confirmDeletes: true. The response now includes `deleted`.
2. GET /api/workspace/checkpoints accepts an optional `base` and then adds `owned` to each item.
3. POST /runs/:id/fork still accepts the run's base and its later commits, but refuses older base-branch history with 400.
4. FilteredTasks.cancel returns 409 for finished tasks whose container is confirmed stopped.
5. Filtered task create validation now gives one 400 per field, and the two conflict messages are split.
6. WorkspaceConflictError takes an optional message; the default text is unchanged.
7. New shared module src/filtered-task-state.ts, imported by both the service and ui/filtered-tasks.tsx.
8. Removed: the unused Bell component in ui/app.tsx and its .bell CSS rule, and ActivityView's project branch. Expect a trivial conflict if another branch touches those lines.

Follow-ups left out of scope:
- The same leaf-only credential split still exists in the file browser. In src/filesystem-policy.ts, filterAllowedProjectEntries hides a `secrets/` folder and assertProjectDirectoryAccess re …

## Issues

### t23-3 · major · Filtered task always fails when the repo commits a secrets/ directory that the policy does not deny

**Fix outcome: fixed.** Took option A, which keeps today's export set. Added sensitiveDirectoryPath() (src/context-inspection.ts:17) for the Git-internal and credential-store folder segments only; sensitiveContextPath now uses it. Added allowsFilePolicyDirectory() (src/filesystem-policy.ts:45): it checks a folder by its rules (folded deny, allow root containing it or under it) plus those segments, but not the leaf credential-name pattern. FilteredTasks.scan (src/filtered-tasks.ts:157) uses it for directories, so a folder the export walked always passes; every file inside is still checked by permitted(read) and the write check. Forbidden-directory and forbidden-path errors now name the path through a redacted, length-capped listed() helper (src/filtered-tasks.ts:63). docs/filtered-tasks.md now says which credential files and folders are never exported, and that other files in a folder like secrets/ follow the po …

Fixer's check: QA server f14 on 127.0.0.1:4419, started from my worktree with a PATH shim that runs test/fake-filtered-docker.mjs before test/fake-bin. Scratch repo with README.md, src/app.py, src/allowed.txt and secrets/config.env, registered as project f14-secrets with the default unrestricted policy. In the UI: Repository tools → Filtered tasks → project → image qa-prepared:1 → Start. Result: 'Filtered task status: completed · daemon container stopped', '4 committed files' (secrets/config.env exported), no error, and Preview showed 'modified · src/allowed.txt'. Before the fix this ended 'failed' with 'Result contains a forbidden directory'. Browser errors array and server log were clean. Unit tests: the …

Tests: `test/qa-filtered-tasks-workbench.test.ts`

Source: tester unit infra-platform-memory-ml-insights-1; observed with fake-agents; features PLAT-15, PLAT-16.

**Repro**

> 1. Scratch repo that commits secrets/config.env plus src/.
> 2. Project policy unrestricted (allow '.', no denies), or any policy where secrets/ is readable.
> 3. Repository tools → Filtered tasks → image 'qa-prepared:1', a task, limit 2 min → Start filtered Docker task (fake filtered docker).

**Expected:** Either the export skips sensitive-named directories, or the task is refused up front. Running the provider turn and then rejecting a directory the agent never touched is wrong.

**Actual:** The export includes secrets/config.env ('5 committed files'). The provider turn runs. The task then ends 'failed' with 'Result contains a forbidden directory', and nothing can be imported. It works only when the policy denies reading secrets.

**Root cause (verifier):** The export and the result validation classify the same paths differently.

1. **The classifier only tests the last path segment.** src/context-inspection.ts:16-19, `sensitiveContextPath()`, rejects any segment that is in the fixed set (.git, .ssh, .aws, .gnupg, .azure, .kube). The credential-name regex `^(?:\.env(?:\..*)?|...|credentials(?:\.json)?|secrets?(?:\.json|\.ya?ml)?|...|.*\.(?:pem|key|p12|pfx|kdbx))$`, though, is applied only to `parts.at(-1)`. So 'secrets' (the directory path) is sensitive, but 'secrets/config.env' (a file inside it) is not.

2. **The export checks file paths.** src/filtered-tasks.ts:126 skips a tree entry only if `!permitted(job.policies, "read", path)`. `permitted` is defined at src/filtered-tasks.ts:60 as `!sensitiveContextPath(path) && policies.every(allowsFilePolicy(...))`. Both calls see the file path 'secrets/config.env', so the file is exported. src/filesystem-policy.ts:40 also uses the same leaf-only check.

3. **The result scan checks directory paths.** In `scan()` at src/filtered-tasks.ts:145, every directory met while walking the workspace is tested with `if (sensitiveContextPath(path) || ...) throw new FilteredTaskError("Result contains a fo …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filtered-tasks.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/context-inspection.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filesystem-policy.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/filtered-tasks.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/filtered-tasks.md`

**Suggested fix:** Use one predicate for both the export and the result scan, so a directory the service exported can never fail validation. There are two consistent options.

**(A) Smallest change, keeps today's export set.** In scan() (src/filtered-tasks.ts:145), stop applying the leaf credential regex to directories:
- For directories, reject only Git-internal or credential-store segments (.git, .ssh, .aws, ...). Export a small helper from context-inspection.ts, e.g. `sensitiveDirectorySegment(path)`, holding that first half of sensitiveContextPath.
- Alternatively, also allow traversal when the directory existed in the export: `job.base.some((f) => f.path.startsWith(path + "/"))`.
- Security is unchanged. Every file under the directory is still checked by `permitted(read)` at line 145, and every changed path by the write-policy check at line 147. So the agent still cannot add `.env`, `id_rsa`, `x.pem` and so on.

**(B) Stricter, matches the documented "fixed credential denies".** Make sensitiveContex …

**Suggested regression test:** Add tests to test/filtered-tasks.test.ts, reusing the existing fixture(), make(), runtime(), input() and settled() helpers.

1. **Main case.** In the fixture repo, commit `secrets/config.env` (and also `config/credentials/production.yml.enc`), then `store.set("project", {revision: 1, read: {allow: ["."], deny: []}, write: {allow: ["."], deny: []}})`. Use a runtime that only rewrites src/file.ts. Assert:
   - `(await settled(service, created.id)).status === "completed"` and `error === undefined`, …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh QA server, v4611, on 127.0.0.1:4611. The home left over from an earlier session was moved aside to homes/v4611-prev-1792970219, not deleted, so the new home started empty. The server ran from the read-only dogfood source with PATH=<my shim dir>:<dogfood>/test/fake-bin:$PATH. The shim's `docker` runs test/fake-filtered-docker.mjs, the same fixture the filtered-tasks e2e uses, with FAKE_FILTERED_DOCKER_STATE=<home>/fdocker. No real agent and no real Docker were involved.

I built two scratch repos under qa/clones that differ only in one directory name:
- v4611-secrets: README.md, src/app.py, secrets/config.env (dummy values)
- v4611-conf: README.md, src/app.py, conf/config.env

I registered each as its own project with POST /api/projects, the same call the UI's "Create project" button makes. Both projects kept the default policy: read and write allow ['.'], no denies (confirmed with GET /api/projects/:id/filesystem-policy).

Then I drove the UI with Playwright (script: qa/work/v4611/ft-secrets.mjs): Settings → Workspace → Filtered tasks → pick the project → image 'qa-prepared:1', limit 2 min, instructions → "Start filtered Docker task".

Results:
- **secrets repo** (task filtered-aea449ae834a63a1a2c622cd): the UI showed "Filtered task status: failed · daemon container stopped · 3 committed files" and the error "Result contains a forbidden directory". The job's base manifest was [README.md, secrets/config.env, src/app.py], and the workspace held secrets/config.env plus src/allowed.txt, which the provider turn wrote. So the secrets file was exported into the container, the provider turn ran, and only then was the result rejected. Screenshot: qa/shots/v4611/001-ft-secrets.png.
- **conf repo** (control, task filtered-bca715c2cfa716563db450d9): status "completed", final text "Allowed browser edit complete", and "Preview allowed import" was offered.

I also called the real functions directly, without modifying the source:
- sensitiveContextPath('secrets') = true, but sensitiveContextPath('secrets/config.env') = false.
- allowsFilePolicy(unrestricted, read, 'secrets/config.env') = true.
- The same split holds for directories named secret, credentials, .env and certs.key. A Rails repo's committed config/credentials/*.yml.enc would hit it too, since 'config/credentials' counts as sensitive.

The console 400s the page logged were GET /api/branches calls for a scratch clone from an earlier session that no longer exists, read from my persistent browser …

</details>

### t23-4 · major · 'Cancel task and confirm container stopped' on a completed filtered task discards its importable result without warning

**Fix outcome: fixed.** New pure module src/filtered-task-state.ts holds filteredTaskCancellable(): preparing, running or unknown (without importCommit), or any task whose container is not confirmed stopped; never importing. FilteredTasks.cancel (src/filtered-tasks.ts:183) refuses everything else with 409: 'This filtered task has finished and its container is confirmed stopped, so there is nothing to cancel; delete it to discard its result'. Status, revision and error stay unchanged. ui/filtered-tasks.tsx:33 renders the Cancel button only when filteredTaskCancellable(current). Updated docs/filtered-tasks.md (cancellation paragraph) and the docs/api.md cancel row.

Fixer's check: On f14 (UI): a completed task showed only ['Preview allowed import','Delete private task and export']. API POST /cancel returned 409 with the message above, and afterwards the status was still 'completed' and preview-import returned 200. A running 'linger' task showed only 'Cancel task and confirm container stopped', and cancelling it worked. Cancelled and failed tasks showed only 'Delete private task and export'. No browser errors. The unit test covers completed, imported and failed tasks (each status and error is preserved). The e2e checks Cancel has count 0 when completed and when imported. The existing filtered-tasks e2e still passes, including its running-cancel test.

Tests: `test/qa-filtered-tasks-workbench.test.ts`, `test/e2e/qa-filtered-tasks-workbench.e2e.ts`

Source: tester unit infra-platform-memory-ml-insights-1; observed with fake-agents; features PLAT-15.

**Repro**

> 1. Run a filtered task until it shows 'Filtered task status: completed · daemon container stopped'.
> 2. Click 'Cancel task and confirm container stopped'. The button is enabled for completed tasks and there is no confirmation.
> 3. Look for 'Preview allowed import'.

**Expected:** For a completed task whose container is already confirmed stopped, Cancel should be hidden or disabled, or at least confirm that the result will be discarded.

**Actual:** Status becomes 'cancelled'. The Preview button disappears. POST /preview-import returns 409 'Only a completed validated task has an import preview'. The provider turn's work can no longer be imported, and getting it back means re-running and spending quota again.

**Root cause (verifier):** Server, src/filtered-tasks.ts:167-169 (FilteredTasks.cancel): the only refusals are a revision mismatch, an import claim, status "importing", and "unknown" with importCommit. Every other status is accepted, including the terminal ones "completed", "failed", "cancelled" and "imported". The method then unconditionally runs `save(job, { status: "cancelled", containerStopped: true, error: "Owner cancelled; ..." })`. Because preview() (line 171) and import() (line 176) require status === "completed", and reconcile() (line 198) only handles "unknown" + importCommit, a cancelled completed job can never be previewed or imported again. The route src/filtered-tasks-api.ts:18 passes the call straight through.
UI, ui/filtered-tasks.tsx:29: the "Cancel task and confirm container stopped" button is `disabled={busy || ["importing", "imported"].includes(current.status)}`. It stays enabled for completed, failed and cancelled tasks, including ones whose containerStopped is already true. It has no confirmation, unlike the Delete flow, whose label at least says it is destructive. The label also reads like a harmless "confirm stopped" step, not "discard result".

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filtered-tasks.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/filtered-tasks.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/filtered-tasks.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/filtered-tasks.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/filtered-tasks.md`

**Suggested fix:** Server (the real guard): in FilteredTasks.cancel, accept only states where cancel means something: "preparing", "running", and "unknown" without importCommit, or any job whose containerStopped is false. For completed, failed, cancelled and imported jobs that are already confirmed stopped, refuse with a 409 such as "This task has finished and its container is confirmed stopped; delete it to discard the result". An idempotent alternative is to re-run runtime.stop() and return the job unchanged, but status must never be rewritten to "cancelled". If discarding a completed result without deleting it is ever wanted, add it as a separate explicit action. Do not route it through cancel.
UI (ui/filtered-tasks.tsx:29): show the Cancel button only while `!current.containerStopped || ["preparing", "running"].includes(current.status) || (current.status === "unknown" && !current.importCommit)`. Hide it for finished, stopped jobs, so the "Preview allowed import" / "Delete private task and export" pai …

**Suggested regression test:** Unit, test/filtered-tasks.test.ts: new test "cancel cannot discard a completed, failed or imported result". Run the fixture runtime to "completed" and call service.cancel(id, revision). Assert it rejects (409, matching /finished|confirmed stopped/). Assert service.get(id).status is still "completed" and the revision is unchanged, and that service.preview(id) still succeeds. Then import the job and assert cancel(id, revision) also rejects, with the status still "imported". Keep the existing runni …

<details><summary>Verifier's independent reproduction</summary>

Fresh QA home "v4613-t23" on port 4613, started with qa-server.sh in "real" mode, but with PATH="<work>/fbin:<dogfood>/test/fake-bin:$PATH". So `docker` was a shim to test/fake-filtered-docker.mjs (FAKE_FILTERED_DOCKER_STATE pointed at my own dir) and claude/codex were the fake CLIs. No provider quota was used. Precondition: a scratch git repo in qa/clones/v4613-filtered (src/allowed.txt + README.md, one commit), registered as project "v4613-filtered" through POST /api/projects. No filesystem policy is needed.
Browser (fresh profile, script qa/work/v4613/t23.mjs, log t23.log):
1. Project -> Repository tools -> Filtered tasks. Image "qa-prepared:1", instructions "Edit the allowed source file", clicked "Start filtered Docker task".
2. Status became "Filtered task status: completed · daemon container stopped". Buttons were [Cancel task and confirm container stopped, Preview allowed import, Delete private task and export], all enabled. API preview-import returned 200 with "modified src/allowed.txt". I clicked "Preview allowed import" and the review section with "Import into new review branch" appeared.
3. Clicked "Cancel task and confirm container stopped". No window.confirm or dialog appeared (the dialog listener caught nothing). Status became "cancelled · daemon container stopped" with a red "Owner cancelled; daemon container absence confirmed". The Preview button, the open preview region and the Import button all disappeared. Revision went 4 -> 5.
4. Afterwards: POST /preview-import gave 409 "Only a completed validated task has an import preview". POST /import gave 409 "Refresh and review the exact current completed result before import". POST /receipt gave 409 "There is no matching interrupted import receipt". The UI and API have no path back to `completed`. The result files are still on disk in <home>/filtered-tasks/<id>/workspace, so only a manual copy can recover them.
Screenshots: qa/shots/v4613-t23/001-completed-before-cancel.png and 002-completed-after-cancel.png. No console or 5xx errors.
Extra finding (t23b.mjs, API only because the UI disables this button): I ran a second task through import (branch codeflow/filtered-d96b... created), then POSTed /cancel with the current revision. It returned 200 and changed the status from `imported` to `cancelled` while importBranch/importCommit remained. So the server guard also lets cancel overwrite another terminal state.
Ruled out:
- By design: docs/filtered-tasks.md and docs/api.md:436 describe cancel only  …

</details>

### S08-5 · major · 'Cancel task and confirm container stopped' is enabled for completed (and failed) tasks, and FilteredTasks.cancel unconditionally rewrites the status to 'cancelled', destroying a completed task's Preview/Import path.

**Fix outcome: duplicate.** Duplicate of t23-4, which carries the fix: the UI hides Cancel and the server returns 409 for finished, confirmed-stopped tasks, so a failed task also keeps its failure reason.

Fixer's check: Covered by t23-4: on f14 the Cancel button is absent on completed and failed tasks, and API cancel on a completed task returns 409 with the status left at completed. The unit test asserts the failed job's error is unchanged after a refused cancel.

Tests: `test/qa-filtered-tasks-workbench.test.ts`

Source: code-level suspect at `ui/filtered-tasks.tsx:29` (confirmed hands-on).

**Repro**

> QA server s08 (fake mode, snapshot fake-bin/docker pointed at test/fake-filtered-docker.mjs, FAKE_FILTERED_DOCKER_STATE set). Settings > Repositories > Filtered tasks, project s08-proj, image 'prepared-qa:1', instructions 'Change the allowed source through the filtered task', Start filtered Docker task. Status became 'completed · daemon container stopped' with 'Preview allowed import' shown next to an enabled 'Cancel task and confirm container stopped' (screenshot 43053-filtered-completed.png). Clicking Cancel (no confirmation) changed the status to 'cancelled' and the notice to 'Owned daemon container absence confirmed.'. The Preview button disappeared. POST /api/filtered-tasks/<id>/preview-import then returned 409 'Only a completed validated task has an import preview'.

**Expected:** Cancel is only offered and accepted for active or unconfirmed jobs (preparing/running/unknown). A completed job keeps its validated result and import path; a failed job keeps its error.

**Actual:** One unconfirmed click on a completed job permanently removes its import path (the provider turn has to be rerun). On a failed job it replaces the failure reason with 'Owner cancelled'.

**Root cause (verifier):** The UI disables the Cancel button only for ['importing','imported']. FilteredTasks.cancel (src/filtered-tasks.ts:169) checks only revision, import claims and the ambiguous-import case. It then saves status 'cancelled' with error 'Owner cancelled; daemon container absence confirmed' regardless of the current terminal status. preview()/import() require status === 'completed', so a cancelled completed job can never be imported again. For a failed job the failure reason is overwritten.

**Suggested fix:** UI: enable Cancel only when status is preparing, running or unknown, or when !containerStopped. Server: in cancel(), when the job is terminal (completed/failed/cancelled/imported) and containerStopped is true, reject with 409 'Nothing to cancel'. If a stop confirmation is still wanted, re-confirm daemon absence without changing status/error.

**Suggested regression test:** In test/filtered-tasks.test.ts: run a job to 'completed', call service.cancel(id, revision), and assert it rejects (or status stays 'completed') and preview(id) still succeeds. Do the same for a 'failed' job, asserting its error text is unchanged. In e2e/filtered-tasks.e2e.ts, assert the Cancel button is disabled once the status is completed.

### t23-16 · minor · Filtered task errors are vague: one generic validation message, an irrelevant one-at-a-time clause, and denied paths not named

**Fix outcome: fixed.** src/filtered-tasks.ts:112-122. The conflict check is split into two 409s: 'Another filtered task is still preparing, running, importing or awaiting a confirmed container stop; wait for it or cancel it…' and 'Filtered task history is full (100 tasks); delete a finished task before starting another'. The single compound validation is now ordered per-field 400s: project, absolute repository path, instructions, the 24 KB UTF-8 byte limit, provider, prepared image (also rejects blank), network boolean, and 1–30 whole minutes. scan() (src/filtered-tasks.ts:161) collects every write-denied path and names up to 5 plus 'and N more'. UI (ui/filtered-tasks.tsx:19-27): counts UTF-8 bytes with TextEncoder, shows a warning and disables Start over 24 KB, sets maxLength to the byte limit, and holds Start with a hint while a task in the project is active. The 'shown twice in the card' sub-claim was refut …

Fixer's check: On f14, API POST /api/filtered-tasks returned field-specific 400s: maxMinutes 0, 31 and 1.5 gave 'Choose a time limit of 1–30 whole minutes'; 'C:\Users\x\repo' gave 'Choose a repository by its absolute path'; agent gpt gave 'Choose a supported provider…'; a blank task gave 'Enter the filtered task instructions'; image 5 gave 'Enter a prepared local Docker image'; network 'yes' gave 'Network access must be true or false'. A second task while one lingered got the 409 'Another filtered task is still … running …', and the UI Start button was disabled with its hint. In the UI, 24000 'é' showed 'Instructions are 47 KB as UTF-8; the limit is 24 KB' and Start was disabled. With write deny ['src'], t …

Tests: `test/qa-filtered-tasks-workbench.test.ts`, `test/e2e/qa-filtered-tasks-workbench.e2e.ts`

Source: tester unit infra-platform-memory-ml-insights-1; observed with fake-agents; features PLAT-15, PLAT-16.

**Repro**

> 1. POST /api/filtered-tasks with maxMinutes 0, 31 or 1.5, or a Windows repo path.
> 2. Start a second task while one runs.
> 3. Write-deny src and run a task that writes src/allowed.txt.

**Expected:** Field-specific validation, a clear 'a task is already running', and the offending path in the denial.

**Actual:** (1) Always 'Choose a project, repository, task, supported provider, prepared image and 1–30 minute limit'. (2) 'Wait for the current filtered task; history is bounded to 100 tasks'. (3) 'Result modified a path outside the write policy; nothing will be imported' with no path, shown twice in the card.

**Root cause (verifier):** src/filtered-tasks.ts:109 checks two different conditions in one `if` and throws one message for both. `this.jobs.size + this.reservations >= MAX_JOBS` (history full) and `this.reservations || this.active()` (a task is already preparing/running) both throw FilteredTaskError("Wait for the current filtered task; history is bounded to 100 tasks"). With a task running, the history clause doesn't apply. With history full and nothing running, "Wait for the current filtered task" is wrong and hides the real fix (delete old tasks).

src/filtered-tasks.ts:110 is one compound boolean over every field: project/repo type, repo.startsWith("/"), blank task, Buffer.byteLength(task) > 24*1024, agent enum, image type, network type, Number.isInteger(maxMinutes) within 1..30. It throws a single FilteredTaskError("Choose a project, repository, task, supported provider, prepared image and 1–30 minute limit", 400) with no field named and no mention of the 24 KiB task limit. ui/filtered-tasks.tsx:22 sets textarea maxLength={24000} in UTF-16 code units, while the server limit is UTF-8 bytes. That mismatch is why the generic message reaches real users with non-ASCII instructions.

src/filtered-tasks.ts:147 …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filtered-tasks.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/filtered-tasks.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/filtered-tasks.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/filtered-tasks.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/filtered-tasks.md`

**Suggested fix:** 1. src/filtered-tasks.ts:109: split into two checks with distinct messages.
   - `if (this.reservations || this.active())` throws 409 "A filtered task is already preparing or running; cancel it or wait for it to finish before starting another".
   - `if (this.jobs.size + this.reservations >= MAX_JOBS)` throws 409 "Filtered task history is full (100 tasks); delete a finished task to start another".

2. src/filtered-tasks.ts:110: replace the compound condition with a short ordered list of field checks, each throwing a 400 that names its field. Examples:
   - "Choose a project"
   - "Choose an absolute repository path"
   - "Enter task instructions"
   - "Task instructions exceed 24 KB (UTF-8)"
   - "Choose a supported provider: claude, codex or agy"
   - "Enter a prepared image name"
   - "network must be true or false"
   - "Time limit must be a whole number of minutes from 1 to 30"

   Keep the 400 status and the check order (cheap checks first). In ui/filtered-tasks.tsx:22, enforce th …

**Suggested regression test:** Add to test/filtered-tasks.test.ts (run with npx tsx --test test/filtered-tasks.test.ts in a snapshot):

(a) Table test against service.create(input(repo) with overrides). Assert rejects with status 400 and a field-specific regex for each case:
   - maxMinutes 0 / 31 / 1.5 → /whole number of minutes from 1 to 30/
   - repo "C:\\repo" → /absolute repository/
   - agent "gpt" → /supported provider/
   - task "   " → /instructions/
   - task "é".repeat(24000) → /24 KB/

   Also assert that the mess …

<details><summary>Verifier's independent reproduction</summary>

Fresh QA server v4635 on 127.0.0.1:4635 with a new home (the old one was moved aside). Started in real mode, but with PATH = <work>/fbin (shim to test/fake-filtered-docker.mjs) followed by test/fake-bin, so every CLI was a fake, and FAKE_FILTERED_DOCKER_STATE set. Scratch repo /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4635-ft (src/main.txt, docs/notes.txt), registered as project v4635-ft. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4635/ (api1, ui1, ui3, cap .mjs/.log). Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4635/001-validation-alert.png, 002-second-task-alert.png, 001-denied-card.png.

(1) Validation. POST /api/filtered-tasks with maxMinutes 0, 31, 1.5 or "5", repo "C:\Users\x\repo" or "repo", agent "gpt", image 5, task "   ", a 25 KB task, or network "yes": every one returns 400 with the same text, "Choose a project, repository, task, supported provider, prepared image and 1–30 minute limit". In the UI, minutes 0, 31 and 1.5 never reach the server. The number input's min/max/step blocks them with clear browser messages ("Value must be greater than or equal to 1." and so on), so the minutes part is API-only. The generic message does reach the UI in one case: a task of 24000 'é' characters. The textarea allows it (maxLength=24000 counts characters), but it is 48000 bytes, over the server's 24 KiB byte limit. The UI showed the generic alert, which never mentions a size limit, so the user can't tell what to fix. The same happens for roughly 8.2k CJK characters.

(2) Second task. Through the UI, started a "linger" task (running), then clicked Start again. The Start button is still enabled while a task runs. Got 409 and the alert "Wait for the current filtered task; history is bounded to 100 tasks". I then filled history to 100 finished tasks through the API, with none active (cap.log: "final count 100 active: 0"). The 101st request returned 409 with the same "Wait for the current filtered task…" text, although nothing was running. Waiting can never help there: docs say there is no implicit retention deletion, so the user has to delete tasks.

(3) Denied write. Policy PUT read allow ["."], write allow ["."] deny ["src"]. A UI task whose fake container writes a new file, src/allowed …

</details>

### t23-11 · minor · Repository tools → Filtered tasks with no project says 'Create a project in Settings first' although projects exist

**Fix outcome: fixed.** ui/workbench.tsx:78 preselects the only project when exactly one exists (with several, the user picks). ui/workbench.tsx:142: when no project is chosen, the select shows a disabled placeholder option ('Choose a project', 'No projects yet' or 'Loading projects…') and is disabled when there are no projects. The note reads 'Choose a project above to run a filtered task in it.' when projects exist, 'Create a project in Settings first.' only once projects have loaded and there are none, and 'Loading projects…' before that. The cosmetic 'Choose a repository in New run first.' note beside the chooser is unchanged; the verifier noted it is partly intended.

Fixer's check: On f14, a fresh browser with no repo chosen and 2 projects: #/workspace → Filtered tasks gave select value '' showing 'Choose a project', the note 'Choose a project above to run a filtered task in it.', and 0 occurrences of 'Create a project in Settings first.' (screenshot shots/f14/001-t23-11-noproject.png). Choosing the project rendered the Filtered Docker task panel. No browser errors. The e2e asserts the same.

Tests: `test/e2e/qa-filtered-tasks-workbench.e2e.ts`

Source: tester unit infra-platform-memory-ml-insights-1; observed with fake-agents; features PLAT-13.

**Repro**

> 1. Fresh browser with no repo chosen → #/workspace → Filtered tasks tab.

**Expected:** A prompt to choose a project, or the first project preselected.

**Actual:** The 'Filtered tasks project' select is blank and the text says 'Create a project in Settings first.' while 10 projects exist. Picking a project from the select fixes it. The no-repo page also shows the project chooser and the full tool panel at once, with 'Choose a repository in New run first.'

**Root cause (verifier):** ui/workbench.tsx:61 computes taskProject = project ?? projects.find(id === taskProjectId) ?? projects.find(p => p.repos.includes(selectedRun?.repo ?? folder)). On #/workspace (and #/settings/workspace) with no repo chosen, all three are empty: projectId is undefined, taskProjectId starts as "" (line 57) and folder is "". So taskProject is undefined.

ui/workbench.tsx:111 then renders <select value={taskProject?.id ?? ""}> with only project options and no "" placeholder, so the browser shows selectedIndex -1 (blank). Its else branch always prints "Create a project in Settings first.", which is only true when projects.value is empty.

The same wrong message would appear when a repo is chosen that belongs to no project. I inferred that from the code and did not run it.

Secondary point: ui/activity.tsx:19-20 renders the "Choose a project or open a repository" chooser and also renders <WorkbenchView/> below it with no folder. Every folder-dependent tool then shows "Choose a repository in New run first." (workbench.tsx:85) beside the chooser. This is cosmetic. It is partly intended, because Coordinated changes and Filtered tasks work without a folder.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/workbench.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/activity.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/filtered-tasks.e2e.ts`

**Suggested fix:** In ui/workbench.tsx:111:
1. When taskProject is undefined and projects.value.length > 0, add an explicit placeholder <option value="" disabled>Choose a project</option> to the select, so it reads as a prompt instead of a blank control.
2. Make the else branch depend on whether projects exist. With projects.value.length === 0, keep "Create a project in Settings first." Otherwise show "Choose a project above to run a filtered task."
3. Optionally preselect the only project when exactly one exists. I would not auto-pick the first of many, because filtered tasks are tied to a specific project's file policy. If the first project should be preselected anyway, do it in a fallback: `?? (projects.value.length === 1 ? projects.value[0] : undefined)`.
4. While projects are still loading (projectsLoaded false), show "Loading projects…" instead of either message.
Optional cosmetic fix: in ui/activity.tsx:20 (or workbench.tsx:85), when no folder is chosen and the project chooser is already shown, hi …

**Suggested regression test:** Add a case to test/e2e/filtered-tasks.e2e.ts, or to a UI unit test that renders WorkbenchView with projects.value seeded and repo.value empty. Seed at least one project (the existing fixture writes projects.json with "Filtered project") and do NOT set localStorage "repo". Then:
1. Go to #/workspace and click "Filtered tasks".
2. Assert the "Filtered tasks project" select shows a "Choose a project" placeholder, or a preselected project when there is only one, rather than selectedIndex -1.
3. Asse …

<details><summary>Verifier's independent reproduction</summary>

Started a fake-mode QA server on port 4625. The old v4625 home was reused from an earlier session, so I stopped it and used a new home, v4625f, which had 8 projects copied from projects.json and 0 runs. I used a fresh headless Chrome with no profile: localStorage was empty and repo was null. GET /api/projects returned the 8 projects. Opened http://127.0.0.1:4625/#/workspace and clicked the "Filtered tasks" tool.
- #filtered-tasks-project select: value="", selectedIndex=-1, not disabled, with all 8 project options. It renders blank.
- The only .wb-note is "Create a project in Settings first.", while 8 projects exist.
- #wb-folder shows the single placeholder "Choose a repository in New run".
- The Verification tab shows "Choose a repository in New run first." and Detect checks is disabled.
- After selectOption(index 0) the select becomes p-3b74eba4 (OPCUA-MCP), the note changes to "Manage project filesystem rules in Settings → Projects & access." and the "Filtered Docker task" panel renders.
- No console or 5xx errors.
Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4625f/001-t23-11-noproject.png (bug), /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4625f/003-t23-11-after-pick.png (after picking a project). Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4625/t23-11.mjs, log t23-11.log next to it.
Refutation attempts:
- docs/filtered-tasks.md, docs/configuration.md and the git history of the line give no reason for a blank default or for this message.
- The reporter's environment did not cause it: it happens with a fresh browser and a fresh home.
- The only test, test/e2e/filtered-tasks.e2e.ts, sets localStorage repo and then calls selectOption("project") explicitly, so it never covers the no-repo default.
Cleanup: server v4625f stopped and ports 4625/4626 are free. No runs, clones or worktrees were created. Leftovers: home dirs /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4625f (mine) and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4625. The v4625 home came from an earlier session and still holds a "v4625 fixture" project that points at clones/v4625-fx.

</details>

### t18-8 · minor · Checkpoint revert/apply/hunk refusals show misleading messages (verification and file-draft wording)

**Fix outcome: fixed.** WorkspaceConflictError now takes an optional message (src/workspace.ts:9); the default is the file-editor text. New CHECKPOINT_HEAD_MOVED message. Each call site has its own wording:
- previewCommitRevert and applyCheckpoint use CHECKPOINT_HEAD_MOVED.
- applyCheckpointHunks: 'The worktree HEAD changed since these hunks were compared. Compare hunks again.'
- applyReviewedRevert (src/checkpoint-review.ts:66-77) runs the porcelain status check before verificationIntegrity, so tracked and staged edits get 'Commit or save all existing changes before reverting a commit'.
- Integrity failures are reworded: hidden flags (checked with ls-files -v) get 'Git flags hid tracked files from comparison … Clear them before reverting a commit'; a race gets 'The worktree changed while the revert was being checked…'.
- A moved HEAD and a fingerprint mismatch are now separate errors: 'This revert changed sin …

Fixer's check: On f14, History on a run worktree with a run-made commit C1 → Preview inverse commit:
- Edit tracked README.md, then Stage: alert 'Commit or save all existing changes before reverting a commit' (was the Verification message).
- Preview, commit in the worktree, then Stage: 'The worktree HEAD changed since checkpoints were loaded. Load checkpoints again and retry.' Apply selected files gave the same text.
- Apply chosen hunks after HEAD moved: 'The worktree HEAD changed since these hunks were compared. Compare hunks again.'
- API apply-revert with fingerprint 'a'×64: 409 'This revert changed since you previewed it…'.
- API apply-checkpoint with a stale expectedHead: 409, not 400.
Only the expe …

Tests: `test/qa-filtered-tasks-workbench-checkpoints.test.ts`, `test/qa-filtered-tasks-workbench-routes.test.ts`

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-27, GIT-28, GIT-29.

**Repro**

> 1. History → select a run worktree → Load checkpoints → choose a non-merge commit → Preview inverse commit.
> 2. Edit a tracked file in the worktree, then click 'Stage reviewed inverse change'.
> 3. Clean the worktree, preview again, commit something in the worktree, then click Stage. The same happens for Apply selected files, Apply chosen hunks after HEAD moved, and API apply-revert with a forged fingerprint.

**Expected:** Dirty: 'Commit or save all existing changes before reverting a commit' (the message in the code). Moved HEAD or stale preview: 'The worktree HEAD moved; load checkpoints/preview again'.

**Actual:** Dirty → 'Verification starting checkout changed tracked files, the staged tree or the checkout commit, or hid tracked files from comparison. The original commit was not verified.' Moved HEAD, stale or forged → 409 'This file changed since it was loaded. Reload and compare your draft before saving.'

**Root cause (verifier):** 1) src/checkpoint-review.ts:63 calls verificationIntegrity(repo) before the status check at :64-65. verificationIntegrity (src/verification-integrity.ts:23, the message is built at :21) runs assert("starting checkout") straight away. That assert throws VerificationIntegrityError ("Verification starting checkout changed tracked files ... The original commit was not verified.") whenever there is an unstaged tracked diff or the index tree differs from HEAD^{tree}. So "Commit or save all existing changes before reverting a commit" (:65) only appears for untracked-only dirt. The same verification wording would also come from integrity.assert("revert preview") at :67. The revert route in workspace-api.ts (around line 115) does not map VerificationIntegrityError, so it arrives as a generic 400.

2) WorkspaceConflictError (src/workspace.ts:9) hard-codes the file-editor text "This file changed since it was loaded. Reload and compare your draft before saving." It is reused for non-file conditions:
- a moved HEAD in previewCommitRevert (src/checkpoint-review.ts:32); applyCommitRevert re-runs the preview first, so moved-HEAD apply attempts land here;
- a forged or stale fingerprint, or a HEAD  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/checkpoint-review.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/workspace.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/workspace-changes.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/workspace-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/checkpoint-review.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/workspace-changes.test.ts`

**Suggested fix:** (a) Give WorkspaceConflictError an optional message, e.g. constructor(readonly currentHash: string, message = "This file changed since it was loaded. Reload and compare your draft before saving."). Alternatively add a subclass such as CheckoutMovedError extends WorkspaceConflictError. Either way the existing `instanceof WorkspaceConflictError → 409` mappings keep working. Pass purpose-specific text at each call site:
- checkpoint-review.ts:32 and workspace.ts:127 → "The worktree HEAD moved since checkpoints were loaded. Load checkpoints and preview again."
- workspace-changes.ts:52 → "The worktree HEAD moved since these hunks were compared. Compare hunks again."
- checkpoint-review.ts:66, split into two cases: fingerprint mismatch → "This revert preview is out of date. Preview the inverse commit again."; HEAD mismatch → the moved-HEAD text.
- :74 → "The worktree changed while the revert was applied; inspect it before retrying."

(b) In applyReviewedRevert, run the `status --porcelain - …

**Suggested regression test:** test/checkpoint-review.test.ts:
- Tighten line 41 so a tracked edit rejects with /Commit or save all existing changes/, and assert.doesNotMatch on /Verification/ for that message.
- Add a staged-only case (git add a new file) with the same expectation.
- Line 39 (forged fingerprint): expect /preview .*again|out of date/i and assert the message is not /draft/.
- Line 44 (preview with a stale expectedHead): expect /HEAD moved/.
- Keep the hidden-file test at :57 matching /hid tracked files/.

test …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4617" on 127.0.0.1:4617. I moved an old, stopped v4617 home aside to v4617-prev-* so the home was fresh. I made a scratch clone of MQTT-MCP (clones/v4617-mqtt.git plus a working clone) and added it through the UI ("Open another repository", new project "v4617-mqtt"). I started one solo fake run (claude) through the API, and it finished as "done". Inside the run worktree I committed the agent's note file, giving a non-merge HEAD C1. Then I opened Project → Repositories → History in headless Chrome, selected the run worktree and clicked Load checkpoints.

UI results (scripts and logs in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617/v02-revert.mjs, v02.log, v03-apply.mjs, v03.log):
- Select C1 → Preview inverse commit → append a line to tracked README.md → Stage reviewed inverse change. The alert reads "Verification starting checkout changed tracked files, the staged tree or the checkout commit, or hid tracked files from comparison. The original commit was not verified." (screenshot shots/v4617/001-F0-dirty-tracked-alert.png).
- Staged-only new file → Stage: the same verification message.
- Control case, untracked file only → Stage: the alert correctly reads "Commit or save all existing changes before reverting a commit". So line 65 is reachable only for untracked files.
- Clean worktree → preview → commit in the worktree (HEAD moved) → Stage: "This file changed since it was loaded. Reload and compare your draft before saving." (409).
- Apply selected files after HEAD moved: the same file-draft message, returned as 400 rather than 409.
- Compare hunks → tick one → commit (HEAD moved) → Apply chosen hunks: the same file-draft message (409, shots/v4617/003-G-apply-hunks-moved.png).

API results on a clean worktree with a revertable commit:
- apply-revert with fingerprint "a"×64 → 409 with the file-draft message.
- apply-revert with a stale expectedHead → 409, same message.
- preview-revert with a stale expectedHead → 409, same message.
- apply-hunks with a stale expectedHead → 409, same message.
- apply-checkpoint with a stale expectedHead → 400, same message.

Every refusal left the worktree unchanged, so safety holds and only the wording is wrong.

Refutation checks:
- docs/checkpoint-review.md says dirty, stale and forged requests are refused (by design) but gives no wording.
- test/checkpoint-review.test.ts:41 accepts either /changed tracked|existin …

</details>

### t18-9 · minor · 'Apply selected files' silently deletes files that do not exist in the checkpoint

**Fix outcome: fixed.** Kept git restore's deletion semantics but made them explicit. applyCheckpoint (src/workspace.ts:148) first lists the tracked paths that are present at HEAD and absent at the source, using diff --diff-filter=D with literal pathspecs. Without confirmDeletes: true it throws CheckpointDeletionError, which names the paths. The result now includes `deleted`. The route maps the error to 409 with confirm: 'deleteFiles'. History (ui/workbench.tsx:128-137) catches that, asks through the app's confirm dialog ('Delete files from the worktree?' / 'Apply and delete'), then re-posts with confirmDeletes. The toast names what was deleted, and the help text says missing files are deleted after asking. docs/api.md apply-checkpoint row updated.

Fixer's check: On f14, History → run worktree → checkpoint = run base → path = the file the run added → Apply selected files opened the dialog 'This file isn't in checkpoint 1ae17d7e, so applying it deletes it from the worktree: codex-03457e33.txt.', and git status was still clean. Cancel left the worktree unchanged and the file present. Apply and delete gave the toast 'Checkpoint files applied; deleted codex-03457e33.txt. Review before committing', and status showed 'D codex-03457e33.txt'. Unit tests cover a directory pathspec (dir/new.txt, dir/old.txt) and that nothing is staged. The route test asserts 409 with confirm=deleteFiles, then 200 with deleted.

Tests: `test/qa-filtered-tasks-workbench-checkpoints.test.ts`, `test/qa-filtered-tasks-workbench-routes.test.ts`, `test/e2e/qa-filtered-tasks-workbench.e2e.ts`

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-28.

**Repro**

> 1. History → run worktree → Load checkpoints → choose an older checkpoint from before a file was added (e.g. the run's first commit).
> 2. Type the later-added file (e.g. proof-xxxx.test.mjs) in 'Checkpoint paths' → Apply selected files.

**Expected:** A warning that the path will be deleted (or it is refused), since the help text says 'Files to restore from this checkpoint'.

**Actual:** Toast 'Selected checkpoint files applied; review before committing', and `git status` shows 'D proof-….test.mjs'. The file is deleted without notice (recoverable, since it is unstaged).

**Root cause (verifier):** src/workspace.ts:132 runs `git --literal-pathspecs restore --source=<checkpoint> --worktree -- <paths>`. Git restore defaults to no-overlay mode, so tracked paths (or files under a directory pathspec) that are missing from the source tree are deleted from the worktree. src/workspace.ts:134 then returns only `{ head, source, paths, staged: false }`, with nothing saying which paths were deleted rather than restored. ui/workbench.tsx:107 always shows the same toast, "Selected checkpoint files applied; review before committing", and its placeholder ("Files to restore from this checkpoint") and help text never say that an absent path will be removed. src/workspace-api.ts:144-149 passes the result through unchanged. Deleting is consistent with the design (src/workspace-changes.ts:36 sends deleted files to whole-file apply); the defect is the missing disclosure and confirmation, which is worse for directory paths that can remove many files.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/workspace.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/workbench.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/workspace-changes.test.ts`

**Suggested fix:** Keep the deletion semantics, since whole-file apply is the documented route for deleted files, but disclose them.

1. In applyCheckpoint (src/workspace.ts), after `git restore` succeeds, run `git --literal-pathspecs diff --name-status -z HEAD -- <paths>` (or `git status --porcelain -z -- <paths>`). Return `restored: string[]` and `deleted: string[]` (optionally `added`) next to the existing fields.
2. In ui/workbench.tsx, base the toast on that result. When `deleted.length` is non-zero, say so, for example "Applied N files; deleted M that don't exist in this checkpoint: a, b…; review before committing", using a warning tone or a persistent alert.
3. Change the placeholder and help text to say that a path missing from the checkpoint is removed from the worktree.
4. Optional but better: add a preview/confirm step. Either use a dry-run endpoint, or add a `confirmDeletes` flag so the server refuses with 409 and lists the paths when deletions would happen and the flag is absent. The UI then …

**Suggested regression test:** Add a case to test/workspace-changes.test.ts using the existing fixture(). Commit `later.txt` on top of base, call `applyCheckpoint(repo, { source: base, paths: ["later.txt", "file.txt"], expectedHead: head })`, and assert:
- `result.deleted` deep-equals `["later.txt"]` and `result.restored` includes "file.txt";
- `existsSync(join(repo, "later.txt")) === false` and `git diff --cached` is empty.

If the confirm variant is implemented, also assert that the call without `confirmDeletes` rejects wit …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4619 on port 4619. I bare-cloned and then cloned MQTT-MCP into scratchpad/qa/clones/v4619-mqtt and added it through the UI as the new project "v4619 MQTT" (Open another repository, then New project). From the composer I started a fake Claude Code run, 2610252209-b00bf77a, which finished as done. The fake agent left claude-5cb2a819.txt untracked, so I committed it on the run branch codeflow/.../solo in the scratch clone (commit d0379e2) to get a clean worktree. This matches the reporter's setup, where the run file was committed.

Then in the browser (work/v4619/v03-apply.mjs) I went to Project → Repository tools → History, picked the run worktree, clicked Load checkpoints and ran four cases:
- Case A: chose checkpoint 2b97323, from before the run file existed, and entered "claude-5cb2a819.txt" → Apply selected files. Result: toast "Selected checkpoint files applied; review before committing", no alert, and `git status` showed " D claude-5cb2a819.txt" (deleted from disk, unstaged). Screenshot shots/v4619/001-A-after-apply.png shows only the success toast.
- Case B: checkpoint ce90afc with paths "mqtt-python/tests/test_observation_integrity.py" (added in 2b97323) and README.md. Same toast; status "M README.md / D mqtt-python/tests/test_observation_integrity.py".
- Case C: a path that exists in neither the checkpoint nor HEAD. Correctly refused with the alert "pathspec ... did not match".
- Case D: the directory "mqtt-python/tests". Same success toast, and it also silently deleted test_observation_integrity.py under that directory, so a directory path can remove several later-added files at once.

A direct POST to /api/workspace/apply-checkpoint for case A returned only {head, source, paths, staged:false}, so neither the server nor the UI can report the deletion. Every deletion was recoverable with `git restore`: the change is worktree-only, HEAD still has the file, and the worktree has to be clean beforehand, so no uncommitted work can be lost.

Refutation attempts:
- Not caused by the environment or the reporter's script: it reproduces on a fresh home and a fresh profile, with my own selectors.
- The deletion itself appears intentional. The hunks refusal message at src/workspace-changes.ts:36 says "Apply added, deleted, renamed or binary files as complete files instead", which points users to Apply selected files for deleted files. Restoring a path to a checkpoint where it is absent therefore deleting it looks like the …

</details>

### t18-10 · minor · Fork from checkpoint accepts commits from before the run started (any ancestor of its branch)

**Fix outcome: fixed.** POST /runs/:id/fork (src/server.ts:2585) now also requires `merge-base --is-ancestor run.baseRef checkpoint`. A checkpoint must lie on a run branch and descend from, or equal, the run's base. Otherwise it returns 400: 'The checkpoint is not part of this run: it was made before the run started…'. I kept the base itself as a valid fork point: the existing phone-security fork test forks a solo run whose branch head equals its base. GET /workspace/checkpoints takes an optional `base` and marks each commit `owned`, computed with rev-list --ancestry-path (src/workspace.ts:123). History passes the run's baseRef, labels earlier commits '· before this run', and disables Fork for them with help text. docs/api.md checkpoints and fork rows updated.

Fixer's check: On f14, History for run K (base 1ae17d7e, run commit 0b409187) listed ['0b409187 · run work K','1ae17d7e · base commit','a60c6fdd · older commit · before this run']. Selecting the older commit disabled Fork and showed 'This commit is from before the run started, so it holds none of the run's work…'; selecting the base enabled it. API fork with the older commit returned 400 with the new message, and no child run was created. The route test also forks from the run's own commit and gets 201. The existing phone-security fork test passes.

Tests: `test/qa-filtered-tasks-workbench-routes.test.ts`, `test/qa-filtered-tasks-workbench-checkpoints.test.ts`, `test/e2e/qa-filtered-tasks-workbench.e2e.ts`

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-30.

**Repro**

> 1. History → select a finished run's worktree → Load checkpoints (the list includes main history from before the run).
> 2. Choose the run's base commit (or any older main commit) → Fork from checkpoint.

**Expected:** Only commits the run made (between run.baseRef and its branch head) count as 'part of this run', or the UI says the fork contains none of the run's work.

**Actual:** A new run 2610251623-8c3e7100 was created with parentRunId pointing at the run, but its base is the pre-run main commit and none of the run's work is included. The checkpoint list offers 50 commits, mostly from before the run.

**Root cause (verifier):** src/server.ts:2559-2560 (POST /runs/:id/fork) treats a checkpoint as "owned" when `git merge-base --is-ancestor <checkpoint> <tree.branch>` succeeds for any run worktree. A run branch starts at run.baseRef, so every commit of the base branch's history before the run also passes. Nothing checks that the checkpoint descends from run.baseRef (src/engine.ts:393 `baseRef: string` already stores the resolved commit). On the UI side, the "Fork from checkpoint" button (ui/workbench.tsx:106-107) uses the list from /api/workspace/checkpoints, which is src/workspace.ts:116-120 `checkpoints()`: `git log --max-count=50 HEAD` of the worktree. That list is shared with compare, revert and apply, mostly holds pre-run main commits, and nothing distinguishes the run's commits. The resulting fork is an ordinary new run from an old main commit, but it gets parentRunId (shown as "↩ previous conversation" at ui/run.tsx:284-287, and it holds the parent under the retention policy at src/retention-policy.ts:168), so its lineage is misleading. There is no security escalation: any user could start a run from that commit anyway, and the fork inherits the parent's lockdown and trust.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/workbench.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/workspace.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-security-http.test.ts`

**Suggested fix:** Server (src/server.ts fork handler): accept a checkpoint only if it lies on the run's own ancestry path. That means checkpoint != run.baseRef, run.baseRef is an ancestor of the checkpoint, and the checkpoint is an ancestor of some tree.branch. Equivalently, the checkpoint appears in `git rev-list --ancestry-path <run.baseRef>..<tree.branch>`. The ancestry-path form also rejects main commits merged into the run branch later, since those do not descend from baseRef. Keep the 400 "The checkpoint is not part of this run" error, and optionally add "it was made before the run started". If restarting from the base is a wanted feature, expose it as a separate "Run again from its base" action rather than as a fork. UI (ui/workbench.tsx History): when a run worktree is selected, mark which listed commits belong to the run. Options are an optional `base`/`runId` query on /api/workspace/checkpoints that returns `owned: true`, or a separate "This run's commits" / "Before this run" grouping. Disable …

**Suggested regression test:** In test/phone-security-http.test.ts, next to "forking an untrusted run preserves lockdown…" (around line 149), or in a new focused server test: after the original run finishes, read `original.baseRef` and the HEAD of its branch. Assert that POST /api/runs/:id/fork with { commit: original.baseRef } returns 400 with body.error matching /not part of this run/. Assert the same for an older commit, for example `git rev-parse <baseRef>~1` after adding one extra commit to the fixture repo before the ru …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4621 on 127.0.0.1:4621. The leftover home from an earlier verifier held a filesystem policy that returned 403, so I moved it to homes/v4621.prev-* and started with a clean home. I made a scratch clone of MQTT-MCP (bare clone plus working clone in qa/clones/v4621-mqtt*) and added it through the UI with "Open another repository" as project v4621-mqtt.
1. Started a Fix & review run through the composer (run 2610252206-63a08030). It finished with baseRef 2b97323 and one run-made commit, 127931c "codex: fix the issue", on codeflow/2610252206-63a08030/build. A solo run made first left its work uncommitted, so it was not used.
2. Opened Project → Repositories → History, picked the run worktree and clicked Load checkpoints. The dropdown offered 44 commits (the whole history of the 43-commit repo plus the run's commit). Only 1 of the 44 was made by the run. Nothing in the list marks which commits belong to the run.
3. Selected 2b97323 (the run's own baseRef, made before the run) and clicked "Fork from checkpoint". No error appeared. The app went to new run 2610252206-a1119bc8 with parentRunId=2610252206-63a08030 and baseRef=2b97323. Its branch does NOT contain 127931c (git merge-base --is-ancestor gave "no").
4. Repeated with 0dd64d8, a main commit 4 commits older than the run's base. New run 2610252206-9a47da56 was created with parentRunId pointing at the run and baseRef=0dd64d8, again without the run's work.
5. Both child run views show a "↩ previous conversation" link to the parent (screenshot shots/v4621/004-fork-older-view.png). The child therefore looks like a continuation of the run, although it shares none of the run's code. No console or 5xx errors. Logs: qa/work/v4621/v3.log.
Ruled out environment and selector problems: the dropdown values come from the server's /api/workspace/checkpoints, and the server accepted the fork.
Checked whether this is by design: docs/api.md:44 says "Begin a child run from an owned checkpoint", and the server's own error text says "The checkpoint is not part of this run". Both mean run-owned commits. No doc says a pre-run commit should count. Forking from the base could pass as "restart with the same settings", but a commit older than the base never could.
Checked the proposed rule with git on the same data, using rev-list --ancestry-path baseRef..branch: 127931c is still accepted, while 2b97323 and 0dd64d8 are now rejected. The current check accepts all three.
Cleanup: all 4 runs were archived with w …

</details>

### t18-11 · minor · Repository tools folder selector offers worktrees of archived or removed runs (and duplicate chat tabs); choosing one gives a raw git error

**Fix outcome: fixed.** New ui/workbench-folders.ts:
- workbenchFolders() gives one entry per worktree path. An archived run's folder is included only if it is confirmed present. A shared chat folder belongs to the chat that owns the workspace, not to its provider tabs.
- presentFolders() probes archived folders by listing each repository's worktree root, then only the run folders still there, instead of one request per folder.
ui/workbench.tsx uses them for the folder options and for selectedRun; archived folders that are still present are tagged '· archived'. A project deep link to a removed worktree shows 'This run's worktree was removed when the run was archived. Resume the run to recreate it, or choose a repository above.' In non-project pages, a folder that drops out of the list falls back to the repository.

Fixer's check: On f14, with runs K (live), R (archived with cleanup; its worktree is gone) and chat S plus a provider tab sharing S's folder, the History folder options were [repo, 'Solo chat S for duplicate tabs · solo', 'Add feature K note file · solo']. There were 0 duplicate values, R was not listed, and choosing S's folder showed S's own run card instead of snapping to the tab. A deep link to R's removed worktree showed the 'removed when the run was archived' message instead of the raw 'isn't a checkout' error. No browser errors. Unit tests cover the helper. The e2e asserts that the removed worktree's option count is 0.

Tests: `test/qa-filtered-tasks-workbench-folders.test.ts`, `test/e2e/qa-filtered-tasks-workbench.e2e.ts`

Source: tester unit git-review-merge-2; observed with fake-agents; features GIT-25.

**Repro**

> 1. Archive a run with 'Remove its worktree' (or merge with 'Archive afterwards').
> 2. Project → Repositories → History → open 'Repository or run worktree'. The removed run's '· build' entry is still listed (a chat and its provider tab appear twice for the same path).
> 3. Choose it → Load checkpoints.

**Expected:** Removed worktrees are hidden, or shown as unavailable.

**Actual:** Alert: '…/.worktrees/2610251606-98abece3/build isn't a checkout of …/t18-mqtt (no git folder of …'s names it), so code-flow …'

**Root cause (verifier):** The cause is in ui/workbench.tsx.

- **Line 58:** `availableRuns = [...runs.value.values()].filter(run => repositories.includes(run.repo) && (...project match...))` has no `run.archived` check and no check that the worktree is still on disk.
- **Line 79:** `availableRuns.flatMap(run => run.worktrees.map(tree => <option value={tree.path}>…))` renders every recorded worktree. It doesn't check that the folder still exists and doesn't dedupe by path. A chat and its provider tab (chatLink.kind "tab", same workspaceId) both carry the same worktree record, so the select gets two options with the same value. The browser always resolves that value to the first one.
- **Line 59:** `selectedRun = availableRuns.find(run => run.worktrees.some(tree => tree.path === folder))` picks the first run that shares the path, so the second tab can never be chosen.
- **Line 72:** the "unavailable" guard only fires when no run claims the path, so a removed worktree passes it.

On the server side, `Engine.archive` (src/engine.ts:3683-3711) removes the folders through removeWorktrees but keeps `run.worktrees` on purpose, because Resume and follow-ups recreate the worktrees from those records. So a worktree re …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/workbench.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/side.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/git.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/workspace.e2e.ts`

**Suggested fix:** 1. Move the folder-option logic out of WorkbenchView into a small pure helper, e.g. `workbenchFolders(runs, repositories, projectId, presentPaths)` in a new file ui/workbench-folders.ts. It returns one entry per distinct worktree path, each with an owner run. Use it for both the `<option>` list (line 79) and `selectedRun`/`selectedTree` (lines 59-60).
2. Hide removed worktrees. For archived runs, include a worktree only when its folder is confirmed present. Reuse the side panel's probe (ui/side.tsx:191-204: `api('/api/fs?path=...')` per archived worktree, run in an effect keyed on the archived runs), or have the server add a cheap `present`/`removed` flag to worktree records once archive cleanup succeeds. Archived runs whose worktree was kept (archive with cleanup:false) can still be listed, optionally tagged "(archived)".
3. Dedupe shared workspaces. Group runs by `chatLink?.workspaceId ?? run.id` (the same rule as ui/run.tsx:413), or simply by `tree.path`. Show one option per path, l …

**Suggested regression test:** Unit test: a new test/workbench-folders.test.ts, run with `npx tsx --test`, against the extracted helper. ui helpers are already unit-tested this way (e.g. test/confirm-state.test.ts, test/composer-tools.test.ts). Assert that:
- an archived run whose worktree path is not in `presentPaths` produces no option;
- an archived run whose worktree is still present produces one option;
- a chat plus a provider-chat tab (chatLink.kind "tab", workspaceId set to the chat id) sharing one path produces exact …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server named v4623t11 on port 4623 with a new home. Its repo was a scratch clone of MQTT-MCP at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4623-mqtt, added through the UI with "Open another repository" and "Create project" (named "v4623 MQTT").

Preconditions, set up through the API:
- Two fix-review runs, "Add feature R note file" and "Add feature K note file". Each finished with a `build` worktree.
- A solo chat, "Solo chat S for duplicate tabs", plus a provider-chat tab off it, "Second tab on the same workspace S". The tab has chatLink kind "tab" with workspaceId set to the chat, and it shares the same `.worktrees/<chat>/solo` path.

Steps, in a headless browser at http://127.0.0.1:4623 (scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4623t11/, files s1*.mjs, s2-repro.mjs and s3-dup.mjs, with logs s1.log, s1b.log, s2.log and s3.log):
1. Before archiving, I opened Project → Repositories → History. The "Repository or run worktree" select listed the repo, both build worktrees, and the solo worktree twice (once for the chat, once for its tab, with the same option value).
2. I archived run R through its run menu (Archive…), ticked "Remove its 1 worktree", and clicked Archive. The API then returned archived=true but still had `worktrees=[{name:"build", path:".../.worktrees/2610252208-75ef9958/build"}]`, and `existsSync(path)` was false.
3. I reloaded and opened History again. "Add feature R note file · build" was still offered. Values that appear more than once: only the shared solo path.
4. I chose the removed worktree. The card still showed live run controls (Open run, Priority, Export run evidence). I clicked "Load checkpoints". The alert said: "/…/clones/v4623-mqtt/.worktrees/2610252208-75ef9958/build isn't a checkout of /…/clones/v4623-mqtt (no git folder of /…/clones/v4623-mqtt's names it), so code-flow didn't run git there." That was a 400 in the console. The Code and Verification tabs showed the same raw error. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4623t11/002-history-removed-wt.png
5. The duplicate tab has a further effect. Choosing the "Solo chat S for duplicate tabs · solo" option snaps the select back to "Second tab on the same workspace S · solo …

</details>

### S01-5 · cosmetic · Dead branch: {view:'workspace', project} is routed to ProjectView, so ActivityView's project title and 'Back to project' never render; Bell (app.tsx:338) is unused.

**Fix outcome: fixed.** ui/activity.tsx: removed the unreachable project title and 'Back to project' branch, plus the current.project handling, and WorkbenchView is rendered without projectId. The project workspace route still goes to ProjectView in ui/app.tsx, and the ActivityView key is now just the view. Deleted the unused Bell export from ui/app.tsx, its setDesktopNotifications import and its `.bell[aria-pressed]` rule in ui/styles.css.

Fixer's check: On f14, #/project/<id>/workspace rendered ProjectView (h1 'f14-secrets', 0 'Back to project' links), and #/workspace rendered the 'Repository tools' heading. The project-navigation, workspace, accessibility and simplification e2e suites pass (35/35 across the related e2e files). tsc passes.

Source: code-level suspect at `ui/activity.tsx:12` (confirmed hands-on).

**Repro**

> Fake server s01: #/project/<id>/workspace renders ProjectView (h1 'S01 Demo', repositories section). No '<name> repositories' heading and no 'Back to project' link (count 0; shots/s01/003-project-workspace.png). Static grep confirms no other caller of ActivityView with a project and no usage of Bell.

**Expected:** No unreachable UI code.

**Actual:** The project-scoped ActivityView header and the Bell component are dead code. No user-visible impact.

**Root cause (verifier):** app.tsx:149-150 checks `route.value.view === 'workspace' && route.value.project` before the ActivityView branch at line 151, so ActivityView only receives workspace routes with an empty project. That makes `name` and the 'Back to project' link (activity.tsx:12,15) unreachable. `export function Bell()` in app.tsx:338 is referenced nowhere in ui/ or test/ (grep -w Bell finds only its definition).

**Suggested fix:** Remove the `name`/'Back to project' logic and the `current.project` handling in ActivityView, and narrow its prop to non-project workspace routes. Delete the unused Bell export, or wire it up if a notifications toggle button is still wanted.

**Suggested regression test:** Add an unused-export check (e.g. knip or ts-prune in CI) and keep the existing project-navigation e2e asserting that #/project/<id>/workspace renders the project's Repositories section.


## Continuation integration · 2026-10-26

Merged into `codex/dogfood-qa-continue` in `/Users/mx/.codex/worktrees/dogfood-qa-continue/code-flow`. Typecheck passes. All 17 targeted tests pass. Conflict resolution retains missing-file 404 handling alongside checkpoint deletion and stale-HEAD protections.

Fresh continuation Chrome replay: both scenarios pass: filtered-task input and finished controls; History worktree filtering, checkpoint ownership and explicit deletion confirmation. Evidence uses fake CLIs and scratch repositories. Logs: `/private/tmp/codeflow-qa-continue/step1-browser.log` and `step1-browser-repaired.log`.
