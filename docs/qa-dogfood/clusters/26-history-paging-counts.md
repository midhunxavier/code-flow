# Cluster 26 · history-paging-counts

**Run history paging: counts from loaded pages, filters, bulk select, breadcrumbs**

Status: **fixed and verified** · 14 issues · branch `codex/qa-history-paging-counts`

Planner notes: The client runs map holds only the first 100-run page, but many counts read it as if it were the total. t01-2 (major): counts in the Projects dialog, the editor and the Delete-project confirmation (row()/editor in ui/projects.tsx); add server-side counts via src/project-report.ts or /api/projects. t01-7/t25-17/t26-9: the composer-mode 'Unassigned draft' row reuses the row(ALL) counts. t00-23: the same confirmation reads 'Its 1 run stay'. t01-8: the project 'Run history' count. t00-22: the archived count. Paging and filters (ui/state.ts, ui/rail.tsx): t00-5 a saved 'Only <repo>' filter stays on 'Loading history…' after reload (empty feed epoch); t00-21 'Retry history' refreshes only page 1; t00-24 the repo filter follows the composer's repo, not the project being viewed; t00-19 the bulk error is not cleared; t00-20 'Select loaded' selects rows hidden behind 'Show N more'. Crumbs (Crumbs in ui/app.tsx): t00-1 a deep link to an older run shows empty crumbs, so fetch the run when it isn't in the map; t00-10 the Settings and Repository tools crumb labels are wrong. attention-counts owns the attention and Inbox counts. Duplicate groups: [["t01-7","t25-17","t26-9"]]

Likely files: `ui/projects.tsx`, `ui/rail.tsx`, `ui/state.ts`, `ui/project.tsx`, `ui/app.tsx`, `src/server.ts`, `src/engine.ts`, `src/project-report.ts`, `src/shared-api.ts`, `src/run-status.ts`


## Continuation outcomes · 2026-10-26

- **t01-2, t00-23 fixed:** `/api/projects/counts` computes authorized complete-index totals for all projects, unassigned runs and each project, including repository membership counts. Picker/editor counts no longer depend on loaded pages. Delete refreshes the count before confirmation; singular “1 run stays” and “1 run needs you” agree. Counts unavailable errors keep a retry path instead of showing partial totals as complete. Removing a repository warns even when its runs are outside the loaded page.
- **t01-8 fixed:** archive scope is a server history filter with accurate totals/cursors and archived-match hints. Project Runs displays complete matching totals and loaded-row counts. Independent review then reproduced stale totals after live archive and a deleted cached row; live refresh now retains the requested page depth, reconciles totals, and filters durable deletion tombstones.
- **t00-22 fixed:** the global archived toggle uses complete chat-family totals. Per-project sidebar archive annotations explicitly say “loaded archived.”
- **t00-21 fixed:** Retry repeats the failed older cursor. The first browser replay found an additional boot/background-refresh race that erased the error; first-page refresh now preserves both that failed cursor and its feedback until the older-page retry succeeds.
- **t00-5, t00-24 fixed:** a first stream hello no longer discards a valid in-flight filtered page. Repository filters persist an explicit path and migrate old boolean preferences once; changing composer repositories does not retarget them.
- **t00-1, t00-10 fixed:** older non-solo deep links load their family into navigation state without altering history cursors. Settings defaults to General in breadcrumbs; the global workspace uses Repository tools.
- **t00-19, t00-20 fixed:** selection changes/new actions clear obsolete errors. Selected rows hidden in folded projects or behind Show more are disclosed in the selection total and group affordances.
- **t01-7, t25-17, t26-9 fixed together:** Unassigned draft has neither run totals nor attention badges; it is a draft destination, not a history scope.

Validation: typecheck,14 focused tests and25 broader storage/project/shared-API tests pass. Final browser runs passed all25 original history/project-navigation scenarios and eight new Chrome scenarios, including live archive/delete and preserving all requested pages. The first original run found a stale assertion for cluster22’s renamed “Browser and snapshots” dependency; its expected label is updated, without changing the feature assertion, and the existing fixture now uses127.0.0.1. No cases were appended to shared tests. Independent review checked endpoint authorization and reproduced the two live-history defects above; the final new scenario covers both. All tests use seeded scratch histories, fake provider discovery and isolated server homes; no real-agent calls. Initial browser testing also found the retry-refresh race above, plus a harness selector that incorrectly looked for a filtered-out project’s rail action; the corrected scenario changes the composer through the actual project page. Evidence: `/private/tmp/codeflow-qa-continue/history-unit-final.log`, `history-broad-unit-final.log`, `history-original-final.log`, `history-live-browser.log`, `history26-independent-review.log`, and `/private/tmp/codeflow-qa-history-paging-counts/output/playwright/qa-history-paging-counts/`. Browser/page errors are empty; the two intentionally injected HTTP500 responses are scoped by URL and phase. Screenshots were inspected with animations disabled.

## Issues

### t01-2 · major · Projects dialog, project editor and Delete-project confirmation report run counts from loaded sidebar pages only

Source: tester unit shell-navigation-settings-2; observed with fake-agents; features SHL-26, SHL-29.

**Repro**

> 1. Have a project with more runs than the sidebar has loaded (t01 Studio: 146 runs per /api/runs?project=…&limit=1 total and the project overview 'Runs this week 146').
> 2. Press 'p' (or Cmd+K > Manage projects) and read the project's row.
> 3. Click Edit, read the header, then click 'Delete project'.

**Expected:** Counts match the server (146 runs), like the project overview, which is documented as independent of the sidebar. The delete confirmation states the real number of runs that will become unassigned.

**Actual:** Row 't01 Studio · 32 runs', editor '32 runs in this project.', confirmation 'Delete the project “t01 Studio”? Its 32 runs stay, in no project.' Earlier: All projects '100 runs' vs 106, t01 Studio 29 vs 34. The menu's 'Show archived runs 0' likewise ignores the 12 unloaded archived runs.

**Root cause (verifier):** The dialog and editor count from the client's runs map. That map holds only the first history page (ui/state.ts:1000, refreshRuns fetches /api/runs?limit=100 across all projects), the running and attention items from the SSE hello, and whatever pages "Load older runs" has added (ui/state.ts:1016-1031).
- ui/projects.tsx:68-72: ProjectsDialog's counts(scope) filters [...runs.value.values()] by inScope to build each row's runs, archived and waiting numbers. This covers the "All projects", per-project and "Unassigned" rows (lines 76-96, 102). Because the "Unassigned" row only appears when orphans.runs or orphans.archived is non-zero from loaded runs, it can also be hidden wrongly.
- ui/projects.tsx:147: ProjectEditor's inProject = [...runs.value.values()].filter(projectFor(r)?.id === project.id). It feeds the header at :197 ("N runs in this project."), the delete confirmation at :170 ("Its N runs stay, in no project." or "It has no runs."), and the repository-removal warning `leaving` at :148/:237, which can be skipped when the affected runs are not loaded.
- The server already has the right numbers: src/project-report.ts:16-27 projectReport returns live, archived and sections.waiting …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-report.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/history-launch.e2e.ts`

**Suggested fix:** 1. Server: add one bounded counts endpoint so the dialog does not need one request per project, for example GET /api/projects/counts. It should return {[projectId]: {live, archived, waiting}} plus entries for ALL and NONE. Compute it in one pass over the authorized index with projectOf(run, inventory) and !fileAccess.restrictedRun(run), the same predicate the /summary route uses at src/server.ts:2025. Reuse the needsYou/section "waiting" logic from run-status. Document it next to /projects/:id/summary in docs/api.md.
2. ui/projects.tsx ProjectsDialog:
   - Fetch the counts when the dialog opens, and refetch when runs change (debounced) or on a short poll while it is open.
   - Use them in row() and in the orphans check that decides whether "Unassigned" appears.
   - While the request is in flight, or if it fails, show no number or "…" rather than the loaded-page count.
3. ui/projects.tsx ProjectEditor:
   - Load GET /api/projects/:id/summary on mount and use live + archived for the hea …

**Suggested regression test:** Add a test to test/e2e/history-launch.e2e.ts. Its fixture already seeds 127 runs into one project (126 live + 1 archived, history-000..125 plus history-cold), and the test at line 154 shows that only "101 tasks loaded" before "Load older runs". The new test should, before clicking "Load older runs":
1. page.goto(`${base}/#/project/${project.id}`) and press "p".
2. Assert the project's listitem in dialog.projects-dialog contains "126 runs (+1 archived)", and the "All projects" row contains the sa …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake server v4611c on 127.0.0.1:4611 (new home homes/v4611c, nothing reused from t01). Setup:
1. Made a scratch clone of MQTT-MCP (clones/v4611-mqtt).
2. Created project "v4611 Big" (p-60f390a1) via the API and ran one fake solo run in it (2610251839-e44878bc), which finished.
3. Stopped the server. Seeded 141 older runs into that project as jsonl files, copying the template run: 129 live and 12 archived, all done and seen. Restarted.
4. Created a second project, "v4611 Old" (p-2f71fbdf), and seeded 6 runs into it, all older than every "v4611 Big" run.

Browser: work/v4611c/repro.mjs and repro-old.mjs, fresh headless profile with no saved state. Each script opens #/project/<id>, presses p, reads the dialog rows, clicks Edit, reads the header, clicks Delete project, reads the confirmation, then cancels.

"v4611 Big": the server reports 142 runs (/api/runs?project total=142; /summary live=130, archived=12; overview card "Runs this week 142").
- Dialog row: "v4611-mqtt · 100 runs", with no archived note.
- Editor: "100 runs in this project."
- Confirmation: "Delete the project “v4611 Big”? Its 100 runs stay, in no project."

After one click on the sidebar's "Load older runs", the same UI says "130 runs (+12 archived)", "142 runs in this project." and "Its 142 runs stay". So the numbers follow whichever sidebar pages are loaded, not the server.

"v4611 Old": the server reports 6 runs, and the overview shows 6 and lists "Old project run 0..5".
- Dialog row: "0 runs".
- Editor: "0 runs in this project."
- Confirmation: "Delete the project “v4611 Old”? It has no runs."

Screenshots: shots/v4611c/001-initial-delete-confirm.png (142 on the card behind, 100 in the confirmation) and shots/v4611c/001-old-delete-confirm.png (6 runs listed behind "It has no runs."). No console errors and no 5xx responses.

Nothing documents this as intended. docs/api.md:130 says project totals "never depend on which sidebar pages a browser has loaded". docs/project-first-navigation-plan.md:79 says the work "preserves complete project history counts". The ProjectOverview comment (ui/project.tsx:74) says the same. This is not an environment artifact: any user with more than 100 runs sees it on first load (refreshRuns loads only limit=100).

Cleanup: all 148 runs archived with cleanup and deleted (remaining total 0). Both projects deleted, server stopped, scratch clones removed, ports 4611/4612 free, nothing touched in the real MQTT-MCP repo. Leftover: only the stopped home homes/v46 …

</details>

### t01-8 · minor · Project Runs tab 'Run history' count shows loaded rows, not the project total

Source: tester unit shell-navigation-settings-2; observed with fake-agents; features SHL-35.

**Repro**

> 1. Open #/project/<id>/runs for a project with 146 runs (134 not archived).
> 2. Read the count badge next to 'Run history'.

**Expected:** The project total (or 'N of M').

**Actual:** 'Run history 100' until 'Load older runs' is clicked (then 134; 146 with Include archived). Searching 'Archived history' with archived off shows 'No runs match this view.' with no hint that 12 archived runs match.

**Root cause (verifier):** ui/project.tsx:154 renders `<Section title="Run history" count={list.length} …>`. `list` (built at ui/project.tsx:144-151) contains:
- the loaded project pages (`history`), merged with
- every run in the global sidebar store `runs.value` for this project (line 145),
- then filtered client-side for archived (`archived || !run.archived`, line 150) and for search words.

So the badge is "rows currently in memory", not the project total. read() at ui/project.tsx:137-139 types the response as `{ runs, nextCursor }` and discards the `total` the server already returns. The server side is src/engine.ts:3409-3418 `page()`, which returns `total: matches.length`.

The archived filter cannot become a server total as things stand. `/api/runs` (src/server.ts:2414-2428) and `RunManager.page` / `matchesHistoryFilter` (src/run-status.ts:41) have no archived parameter, so the server total always includes archived runs. The checkbox is applied only on the client, and it isn't in the effect deps at ui/project.tsx:143. That same client-side filter hides server search hits that are archived, which produces the bare "No runs match this view." when only archived runs match.

**Files:** `ui/project.tsx`, `src/engine.ts`, `src/server.ts`, `src/run-status.ts`, `test/e2e/project-navigation.e2e.ts`, `test/run-history.test.ts`

**Suggested fix:** 1. **Server:** add an archived option to the history filter, e.g. `archived?: "exclude" | "include" | "only"`, in src/run-status.ts `HistoryFilter` / `matchesHistoryFilter`.
   - Accept it as `?archived=` in the `/api/runs` handler (src/server.ts:2414-2428), validated like `status` and `section`.
   - Make sure `RunManager.page` (src/engine.ts:3415) treats it as a filtering input, so `total` and the cursor respect it.
   - Optionally return `archivedMatches`, the count of archived runs matching the same query and project, so the UI can hint.
2. **UI, ProjectRuns (ui/project.tsx:125-156):**
   - Send `archived: archived ? "include" : "exclude"` with each request and add `archived` to the useEffect deps.
   - Keep `page.total` in state.
   - Render the badge from the server total. Show "N of M" or "N loaded of M" when `cursor` is set; use a `Math.max(total, list.length)` guard for live runs merged in from `runs.value` after the page loaded.
   - When archived is off, the list is empty an …

**Suggested regression test:** Two tests:
1. **Unit, test/run-history.test.ts (or a new engine page test):** seed a RunManager index with 105 project runs, 5 archived. Assert:
   - `page({ project, limit: 100, archived: "exclude" }).total === 100`;
   - with `"include"`, total is 105;
   - the cursor only walks the non-archived runs when excluded.
   Add an `/api/runs?archived=` validation case: a bad value returns 400.
2. **E2E, test/e2e/project-navigation.e2e.ts (or history-launch.e2e.ts, whose fixture already seeds more th …

<details><summary>Verifier's independent reproduction</summary>

Reproduced on a fresh fake-mode QA server, v4623 on 127.0.0.1:4623. My extra port 4625 was held by another verifier (home v4625h), so I waited for 4623 to free up.

To rule out the reporter's hand-written jsonl seeding, I created all the runs through the real server API instead:
- A throwaway git repo (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4623-count), added to a new project "v4623 Count" (p-76bc280b) via POST /api/projects.
- 138 genuine fake solo runs via POST /api/runs.
- 8 of them archived via POST /api/runs/:id/archive: 4 on the first page and 4 on the second.
- Server state: GET /api/runs?project=..&limit=100 gives total=138 (page1=100, page2=38); the project summary gives live=130, archived=8.

I then opened http://127.0.0.1:4623/#/project/p-76bc280b/runs in a fresh headless Chrome profile (scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4623/seed.mjs, seed-more.mjs and observe.mjs; output in observe2.log in the same folder):
- **Initial:** the "Run history" badge reads **100** with 100 rows, although the project has 130 live runs. Page 1 held only 96 live runs; the other 4 rows came from the sidebar's own loaded pages ("104 tasks loaded"). So the badge also depends on unrelated sidebar paging.
- **After the project's "Load older runs":** badge 130.
- **With "Include archived runs" on:** badge 138, 8 Archived pills.
- **Search "archived-probe" with archived off:** the server response has total=8 (all archived), but the UI shows "No runs match this view." with no badge and no hint that archived runs match.
- **Same search with archived on:** badge 8.

Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4623/001-initial.png and 003-search-archived-off.png. No console errors or 5xx responses.

**Why this is not by design:** docs/*.md never say what this badge counts. The sibling Overview in the same file is documented as "Counts and paged results cover the project" and uses page.total. The sidebar labels its own number honestly as "N tasks loaded" and adds the note "Filters apply to loaded pages". The Runs tab shows a bare count with neither.

**Cleanup:** all 138 runs archived with cleanup (worktrees and branches) and then deleted, the project deleted, the server stopped and the scratch repo removed. …

</details>

### t00-22 · minor · Archived count on the sidebar toggle and menu counts only loaded pages

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-17.

**Repro**

> 1. Archive 6 runs, two of them older than the first 100.
> 2. Reload; read 'Show archived runs N'; click Load older runs.

**Expected:** The total archived count (the server knows it), or wording that says it counts loaded runs.

**Actual:** Shows 4 until Load older runs, then 6.

**Root cause (verifier):** The count comes only from the runs the browser has loaded so far.
- ui/rail.tsx:117 builds `tasks` from `runs.value`. That holds only the first history page from the stream hello and refreshRuns (`/api/runs?limit=100`, ui/state.ts:999), plus attention and related runs, plus any pages added by loadOlderRuns (ui/state.ts:1016-1033).
- ui/rail.tsx:132 `const archivedCount = all.filter(taskArchived).length;` therefore counts loaded archived tasks only.
- That number is shown in the sidebar toggle at ui/rail.tsx:453 and in the Application menu at ui/rail.tsx:535.
- ui/rail.tsx:453 also renders the toggle only when `archivedCount || view.archived`. If every archived run is older than the first page, the button disappears and the menu says 0.
- The per-project "N archived" counts (ui/rail.tsx:347, shown at :273) have the same limit.
- Archived runs never count as needing you (src/run-status.ts:26), so the attention page never brings old archived runs in.
- The server cannot report the true number today. engine.page() (src/engine.ts:3409-3418) returns `total` for the whole filter but no archived count, and the stream hello (src/server.ts:1276 and 1338) only passes total and nextCursor.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/shared-api.ts`

**Suggested fix:** Preferred fix: have the server send the number of archived tasks the browser has not loaded yet.
- In engine.page() (src/engine.ts), add `archivedBeyond`: the archived tasks in `matches` that come after the returned slice. Count by chatTaskId so a solo family counts once, and only when every chat in it is archived, matching taskArchived in the UI. Use the same predicate so access rules still apply.
- Pass it through /api/runs, both stream hello payloads (src/server.ts:1276 and 1338) and shared-api.ts.
- In ui/state.ts, keep a `historyArchivedBeyond` signal. Set it in the hello handler, refreshRuns and loadOlderRuns, the same way historyTotal is set.
- In ui/rail.tsx, show `archivedCount + historyArchivedBeyond`. The loaded part stays live as runs are archived or unarchived. Render the toggle when that sum is above 0 or view.archived is on, so it no longer disappears.
- Do the same for the per-project group counts, or leave them loaded-only with a "loaded" label.

Cheaper UI-only fallba …

**Suggested regression test:** Two tests, one in the server and one in the browser.
- Unit test in test/run-storage.test.ts (it already exercises page() and cold archived runs): seed 106 runs, archive 2 older than the first 100 and 4 inside it, then assert `page({ limit: 100 }).archivedBeyond === 2`. Also assert that a solo family with one unarchived chat is not counted.
- E2E assertion in test/e2e/history-launch.e2e.ts: its fixture already has a cold archived run ("history-cold") older than the first page. Before clicking "L …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4683t22 on 127.0.0.1:4683, with a new home. Its project was a scratch clone of MQTT-MCP at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4683t22-mqtt.
1. Created 106 fake solo runs ("Seed task #000".."#105") with POST /api/runs (script work/v4683t22/seed.mjs). Marked all as seen so the attention page would not pull old runs in. Archived #000, #001, #050, #060, #070 and #080 (work/v4683t22/prep.mjs).
2. Server state: GET /api/runs?limit=100 returned total 106, a nextCursor, and 4 archived runs on page 1. Page 2 held #000-#005, including 2 archived. Six runs are archived in all.
3. Opened #/inbox in a fresh headless Chrome profile (work/v4683t22/repro.mjs):
   - Before loading more, the sidebar toggle read "Show archived runs 4". The Application menu item also read "Show archived runs 4", and the footer said "100 tasks loaded".
   - After clicking "Load older runs", both read "Hide archived runs 6" and the footer said "106 tasks loaded".
   - Screenshots: shots/v4683t22/001-before-load-older.png and 002-after-load-older.png. No console errors.
4. Worse variant (work/v4683t22/variant.mjs): I unarchived #050-#080, leaving only the 2 old runs archived, and reloaded. The sidebar archive toggle was not rendered at all (count 0). The menu item read "Show archived runs 0" even though the server holds 2 archived runs. After "Load older runs" the toggle came back as "Show archived runs 2". Screenshot: shots/v4683t22/001-only-old-archived.png.

Not by design: no docs/*.md text says this count covers only loaded pages. docs/runs.md:138 presents "show archived runs" and the archive button as a plain toggle. The rail does say elsewhere that it works on loaded pages ("100 tasks loaded", "Filters apply to loaded pages"), but the archived count has no such wording. Not the tester's environment: it reproduced the same way from a fresh profile and a fresh home.

Cleanup: all 106 runs were deleted with DELETE /api/runs/:id (server total back to 0). Those deletes left the run worktrees in place, so I removed the whole scratch clone and its bare repo. Server v4683t22 is stopped and port 4683 is free. The only leftover is the QA home homes/v4683t22, which is in scratch.

</details>

### t00-21 · minor · 'Retry history' after a failed 'Load older runs' only refreshes the first page

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-24.

**Repro**

> 1. With more than 100 runs, make /api/runs?…&cursor=… fail once (simulated 500) and click Load older runs.
> 2. Click 'Retry history'.

**Expected:** Retry loads the older page that failed.

**Actual:** The error clears but the count stays '116 tasks loaded'. The older page isn't loaded until Load older runs is clicked again.

**Root cause (verifier):** Two pieces of code combine to cause this.

1. ui/rail.tsx:514 always wires the button to refreshRuns, which loads only the first page:
   `{historyError.value ? <div class="help" role="alert">{historyError.value}<button class="btn small" onClick={() => void refreshRuns()}>Retry history</button></div> : null}`

2. ui/state.ts:1016-1036, loadOlderRuns: if the cursor request fails, the catch at 1033-1034 writes to the same `historyError` signal (declared at ui/state.ts:900) that first-page failures use. Nothing records which request failed.

When Retry calls refreshRuns (ui/state.ts:991-1014), it fetches only `/api/runs?limit=100`. On success it sets `historyError.value = ""` (line 1008). Because historyPages is still 1, line 1005 puts the same first-page nextCursor back. The result:
- the error disappears;
- historyTotal and the loaded runs stay as they were ('100 tasks loaded');
- the older page is never fetched again until the user clicks 'Load older runs' a second time.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-history-ui.test.ts`

**Suggested fix:** In ui/state.ts, record which history request failed and export one retry entry point:

- Add a module-level `let historyFailed: "refresh" | "older" | null = null` (or a signal).
- In the refreshRuns catch, set it to "refresh". In the loadOlderRuns catch, set it to "older".
- Clear it wherever `historyError.value = ""` is set: refreshRuns success, the start of loadOlderRuns, and prepareHistoryQuery.
- Export `retryHistory()`. It calls loadOlderRuns() when historyFailed === "older" and historyNextCursor.value is set. Otherwise it calls refreshRuns().

In ui/rail.tsx:514, change the button to `onClick={() => void retryHistory()}`.

Caveat: loadOlderRuns returns early while historyLoading is true. retryHistory should either wait for the refresh in flight to finish or disable the button while historyLoading is true, the same way 'Load older runs' does.

An alternative is to give older-page failures their own error state and put a 'Retry' button next to 'Load older runs'. That keeps 'Retry h …

**Suggested regression test:** Add a case to test/run-history-ui.test.ts. Extend the fake fetch harness so a request can fail, e.g. a `fail(query, cursor)` helper that resolves `new Response(JSON.stringify({ error: "boom" }), { status: 500 })`. Then:
1. Run refreshRuns() and answer it with `{ runs: [run("new")], total: 2, nextCursor: "cursor-a" }`.
2. Run loadOlderRuns() and fail the cursor-a request. Assert that state.historyError.value is not empty.
3. Call the new state.retryHistory().
4. Assert that the next pending /api/ …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server with home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4681r on port 4681. The earlier v4681 home already held a run from another session, so I left it alone. Before starting the server I seeded 120 finished solo runs, in the same format as test/e2e/history-launch.e2e.ts, using /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4681/seed.mjs. They point at a scratch git repo. A direct call to GET /api/runs?limit=100 returned 100 runs, total 120, plus a nextCursor.

I then ran a Playwright script in a fresh browser with no profile: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4681/retry.mjs (log in retry.log next to it). It logs every /api/runs request.
- S0: the sidebar showed '100 tasks loaded | Load older runs'.
- I routed **/api/runs?limit=100&cursor=* to return a 500 the first time only, then clicked 'Load older runs'.
- S1: the sidebar showed '100 tasks loaded | Load older runs | Simulated older page failure | Retry history'. The only request was ?limit=100&cursor=eyJ... (the older page).
- I clicked 'Retry history'.
- S2: the only request was '?limit=100', the first page. The cursor page was never asked for again (the cursor route was hit once in total). The alert disappeared, the text still said '100 tasks loaded', 'Load older runs' was still shown, and no older runs were added.
- S3: clicking 'Load older runs' again sent the same cursor request, which now succeeded: '120 tasks loaded'.

Screenshots of the UI before and after Retry are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4681r/001-after-failed-load-older.png and 002-after-retry-history.png. The only errors collected were the simulated 500 and its console line.

Why this is not by design: docs/*.md never mention 'Retry history', and no comment in the code says Retry should only reload the first page. Why it is not caused by the environment: I reproduced it from a fresh home, a fresh browser and my own script. The selectors are role-based and match the reporter's.

Severity stays minor. Nothing is lost and 'Load older runs' stays visible, so one more click recovers. However, Retry silently does something other than what failed, and because the error cle …

</details>

### t00-5 · minor · Saved 'Only <repo>' filter: after reload the sidebar is stuck on 'Loading history…' with loaded-page matches only, for about 30 s

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-16, SHL-24.

**Repro**

> 1. Fake QA server with more than 100 runs across several repos. Pick a repo in the composer.
> 2. App menu → View and filter runs → tick 'Only <repo>' (the list shows 32 of 112 tasks, from the server).
> 3. Reload the page and wait 4 s; repeat the reload twice.

**Expected:** The repo-filtered history loads from the server as before the reload (32 matching tasks) and the footer shows the count.

**Actual:** 3/3 reloads show '25 of 103 tasks' (only matches in the unfiltered first page), and the footer says 'Loading history…' indefinitely. It corrects itself only when the 30 s poll refreshes ('32 of 112 tasks'). Network shows /api/runs?limit=100 followed by two /api/runs?limit=100&repo=… requests whose results are discarded.

**Root cause (verifier):** At boot (ui/main.tsx:118-125), two filtered history requests start before the runs stream has ever said hello, so both capture feed.epoch === "". (a) setRepo(saved, false) at main.tsx:120 ends with `if (runFilter.value.thisRepo) void refreshRuns()` (ui/state.ts:219). (b) watchAllRuns(notifyFinished) at main.tsx:123 subscribes to "runs", and on the same tick pollVisible(...) at main.tsx:125 runs its immediate tick (ui/polling.ts `void tick()`), which calls refreshRuns() again. Request (b) supersedes (a) through the historyRefresh counter (state.ts:996/1001). The first "runs" hello then arrives while (b) is in flight. The hello handler sets feed.epoch from "" to the server epoch (state.ts:1112). Because the previous epoch was empty, restarted is false (state.ts:1110), and since historyRequestQuery() is non-empty it neither sets historyTotal nor calls refreshRuns (state.ts:1118-1122: `else if (restarted) void refreshRuns()`). It only merges the unfiltered first page (applyRunList, state.ts:1117). When (b) resolves, refreshRuns fails `feed.epoch !== epoch` ("" vs the new epoch) at state.ts:1001 and returns without setting historyTotal or historyNextCursor. So historyTotal stays null, w …

**Files:** `ui/state.ts`, `test/run-history-ui.test.ts`

**Suggested fix:** In refreshRuns (ui/state.ts:1001), discard a page only when a known epoch changed, not when the stream had not yet said hello: `if ((epoch && feed.epoch !== epoch) || generation !== historyGeneration || query !== historyRequestQuery() || request !== historyRefresh) return;`. Do the same in loadOlderRuns (state.ts:1027): `(epoch && feed.epoch !== epoch)`. This is safe because applyRunList's fresher callback (`(feed.runSeq.get(id) ?? 0) > seq`, with seq = 0 captured before the hello) already keeps every streamed snapshot over the fetched one. A real server restart after the first hello still has a non-empty captured epoch and is still discarded. I validated this patch in my snapshot copy (unit and browser). An alternative is for the hello handler to refresh when the previous epoch was "" and a history query is active (`else if (restarted || !previousEpoch) void refreshRuns()`). That costs an extra request on every filtered boot. A third option is a one-retry loop like loadAgentChats.

**Suggested regression test:** Add a case to test/run-history-ui.test.ts, or a new file such as test/run-history-first-hello.test.ts, because module state must be fresh: feed.epoch must still be "". Steps: localStorage.getItem("runFilter") returns a saved filter. Call state.setRunFilter({ agent: "codex" }) (a thisRepo filter behaves the same), start `const p = state.refreshRuns()`, then call `state.watchAllRuns(() => {})`. Send the FakeEventSource a hello `{type:"hello", epoch:"server-one", seq:5, total:112, nextCursor:"c1",  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4651h" on port 4651 with a new home and a fresh browser profile. I made four tiny scratch git repos (v4651-a..d) and created 112 solo runs through POST /api/runs; repo a has 32 of them (the API reports total 32, and 112 for all runs). In the UI I opened project v4651-a's composer (#/project/p-2deacc8c/new), so the composer repo was v4651-a. Then App menu -> View and filter runs -> ticked "Only v4651-a": the rail said "32 of 103 tasks" and the footer "32 matching tasks loaded". I reloaded 3 times and waited 4 s each time (work/v4651h/r1.mjs). All 3 reloads showed "29 of 100 tasks" (only the matches in the unfiltered first page) with the footer stuck on "Loading history…" and no "Load older runs" button, while the header said "Connected" (screenshot shots/v4651h/003-reload1.png). After waiting about 30 s, the poll fired one /api/runs?limit=100&repo=… request and the rail recovered to "32 of 103 tasks" / "32 matching tasks loaded". Network order on each reload: /api/runs?limit=100, then two /api/runs?limit=100&repo=… requests. I instrumented fetch and EventSource in the page (r2.mjs, 2 more reloads): the filtered fetches start at about 144-210 ms, the "runs" topic hello (epoch=…, 100 runs, total 112) arrives at about 161-247 ms, and the last filtered fetch resolves after the hello. The footer then flips to "Loading history…" and stays. That is 5/5 reproductions, no console or 5xx errors. Refutation checks: no doc or code comment describes this as intended (docs/api.md and docs/run-storage.md say totals never depend on loaded pages, and main.tsx calls the 30 s poll "a safety net if the event stream drops"). It is not the environment: fresh server, fresh profile, real UI flow, and it shows in a plain unit test too. Unit-level repro: a new test in my snapshot copy (builds/v4651h/test/run-history-first-hello.test.ts) fails on unpatched code with historyTotal null !== 32. Fix check: with the patch below applied to my snapshot, the new test passes, the existing test/run-history-ui.test.ts passes (5/5), and against the patched server with the same home 3/3 reloads show "32 of 103 tasks" / "32 matching tasks loaded" after 4 s (r3.mjs).

</details>

### t00-1 · minor · Deep link to an older non-solo run shows empty breadcrumbs permanently (and no active sidebar row)

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-05.

**Repro**

> 1. Start a fake QA server and create more than 100 runs, the oldest being a non-solo one (e.g. pattern loop or fix-review).
> 2. Reload the app and open #/run/<id of that oldest loop run> directly (it is not in the first history page).
> 3. Wait 6+ seconds, reload, wait again.

**Expected:** The top bar shows '<Project> / <task line>' once the run is shown, like for newer runs.

**Actual:** The run page renders fully ('Ancient needle: tidy the MQTT topic docs'), but 'Where you are' stays empty indefinitely, also after reload. No sidebar row is active. A solo run at the same depth does get crumbs because its chat family is loaded. Reproduced with 2 runs: 2610251358-6a198f81 (loop) and 2610251358-6a38e575 (fix-review).

**Root cause (verifier):** The top-bar crumbs read only from the global run list:
- ui/app.tsx:236 (Crumbs) does `runs.value.get(r.id)`.
- ui/state.ts:407 (side panel scope) does the same.

That list is filled only by:
- the /events hello: the first 100 runs, running runs and up to 100 attention items;
- history paging (refreshRuns, loadOlderRuns);
- global "run" events (watchAllRuns, ui/state.ts:1128-1133);
- loadAgentChats (ui/state.ts:956-965).

The run page itself gets its snapshot from the per-run feed (ui/run-feed.ts, `feed.pending = ev.run` / `feed.run`), which never writes into `runs`. The run page calls loadAgentChats only for solo runs: ui/run.tsx:119-123 `if (run?.pattern !== "solo") return; rememberAgentTab(run); void loadAgentChats(id)...`. The solo guard came in with the Agent/Team workspace (commit 29628ea) to restore agent tabs, and fixing crumbs for solo deep links was a side effect.

So a finished, already-seen non-solo run beyond the first 100 never enters `runs` until "Load older runs" reaches it. Crumbs render nothing and the side panel falls back to the composer scope ("No repository chosen"). The server side already works: GET /api/runs/:id/chats (src/server.ts:2546) filters by chatTas …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-history-ui.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Keep `rememberAgentTab` for solo runs only. Load the run family for any run that isn't already in the global list, through the existing loadAgentChats, which is epoch- and seq-safe. I verified this in my snapshot build:

```ts
// ui/run.tsx:119-123
useEffect(() => {
  if (!run) return;
  if (run.pattern === "solo") rememberAgentTab(run);
  // A deep link beyond the loaded history: bring the run (and its chats) into the run list so the breadcrumbs and side panel know it.
  if (run.pattern === "solo" || !runs.value.has(id)) void loadAgentChats(id).catch(error => showToast(`Could not load this task’s chats: ${error.message}`));
}, [id, run?.pattern]);
```

`runs` is already imported in run.tsx. Optionally rename loadAgentChats to something like loadRunFamily and update its doc comment ("Restore all tabs/side chats…") to say it also adds a deep-linked run outside the loaded history. Do not write the per-run feed's snapshot straight into `runs`. That feed numbers its events differently (see …

**Suggested regression test:** Unit test in test/run-history-ui.test.ts, which already fakes fetch and EventSource:
1. Load one history page `{ runs: [run("new")], total: 101, nextCursor: "c" }`.
2. Call the family loader (state.loadAgentChats("old"), or the renamed helper), answer GET /api/runs/old/chats with `[run("old")]`. The helper already uses pattern "pipeline".
3. Assert `state.runs.value.get("old")` exists and that historyTotal/nextCursor are unchanged.

If the decision moves into state.ts (e.g. `ensureRunListed(run) …

<details><summary>Verifier's independent reproduction</summary>

Setup: a fresh fake-mode server with a new home (name v4643-t001, port 4643; the existing v4643 home had leftovers, so I didn't use it). I made a scratch git repo, registered it as project "Tiny QA" and created runs through the API in this order: "Ancient loop" (loop), "Ancient fix-review" (fix-review), "Ancient solo" (solo), 101 newer solo runs, then "Recent loop: control run". That is 105 runs, all finished and marked seen. GET /api/runs?limit=100 gave total 105 and a nextCursor. The three ancient runs were not in the first page or in `related`; the control run was.

Test: a fresh headless Chrome with no profile (rules out a stale profile) opened each deep link #/run/<id> and waited 6.5 s.
- loop: crumbs "", no active row.
- fix-review: crumbs "", no active row.
- old solo: crumbs "Tiny QA / Ancient solo: rename a helper".
- recent loop control: crumbs "Tiny QA / Recent loop: control run", active row 1.
- After reloading on the old loop run and waiting 7 s, crumbs were still "".
- After clicking "Load older runs", crumbs became "Tiny QA / Ancient loop: tidy the topic docs". This confirms the missing entry in the run list is the cause.
- No console errors and no 5xx responses.
- Screenshot 005-reload-loop-cdbf.png shows the run page fully rendered with an empty top bar. Screenshot 004 is the control run, with crumbs.

Extra impact found: the side panel reads the same run list (ui/state.ts:407). On the old loop run it showed "Following · No repository chosen" and a generic "Chat with Claude Code" prompt for a new chat. On the control run it showed "Tiny QA › Recent loop…" and "Chat about this run" (the run's worktree). See shots/v4643-t001/001-side-cdbf.png and 002-side-ff1c.png.

Fix check: in my snapshot build I applied the fix below, rebuilt, restarted on the same home and reran both scripts. The old loop and fix-review runs then got crumbs right away and after reload, and the side panel followed the run ("Reads the run's worktree; changes nothing."). No errors.

Claims that don't hold up: "no active sidebar row" is not a separate bug. The rail shows 5 rows per project with "Show 95 more", so even the old solo run (which is in the list) and the old loop after "Load older runs" have no visible active row. Nothing in the docs makes the missing crumbs intentional. docs/project-first-navigation-plan.md:245 says #/run/:id should "derive project breadcrumbs from the result's recorded context". The bug only shows when the old run is already seen. For an unseen …

</details>

### t00-10 · cosmetic · Breadcrumb naming mismatches: #/settings shows only 'Settings' while General is displayed; Repository tools page is crumbed 'Repositories'

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-05.

**Repro**

> Open #/settings (or app menu → Settings / Cmd+,); then open #/workspace (palette 'Repository tools').

**Expected:** 'Settings / General' when General is shown; the crumb uses the page's name 'Repository tools'.

**Actual:** #/settings crumb is just 'Settings' with General content (#/settings/general shows 'Settings / General'). #/workspace crumb is 'Repositories' while its heading and the palette/app-menu entries say 'Repository tools'.

**Root cause (verifier):** This is two independent label bugs in the `Crumbs()` function of /Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx.

1. ui/app.tsx:303-304: the crumb map for the global activity views hard-codes `workspace: "Repositories"`. The page itself uses `workspace: "Repository tools"` as its h1 (ui/activity.tsx:14), and the palette (ui/command-palette.tsx:25), the app menu (ui/rail.tsx:529) and the settings section label (ui/settings-sections.ts:10) all use the same name. PR #44 (217a659) introduced the split. The project-scoped variant (#/project/:id/workspace or /repositories) correctly says "Repositories", because its h1 is "<name> repositories".

2. ui/app.tsx:305-321: `const section = r.section ? SETTINGS_SECTIONS.find(...) : undefined`. When the route has no section, only the single "Settings" crumb is rendered. The route comes from ui/navigation.ts:36, which leaves `section` undefined for #/settings, and #/settings is where Cmd+, (app.tsx:403), the app menu (rail.tsx:527) and the palette (command-palette.tsx:21) all navigate. Meanwhile `SettingsView` defaults `section = "general"` (ui/settings.tsx:36) and marks General with aria-current=page. Sett …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/settings.e2e.ts`

**Suggested fix:** Both fixes are in ui/app.tsx `Crumbs()`.

1. Workspace crumb: when `r.view === "workspace"` and there is no `r.project`, use "Repository tools". Keep "Repositories" only when `r.project` is set, which keeps the project trail "<Project> / Repositories" in line with its "<name> repositories" heading. For example: `workspace: r.project ? "Repositories" : "Repository tools"`. A cleaner option is to take the label from `SETTINGS_SECTIONS` / one shared `DESTINATION_LABELS` map that ActivityView's h1 also uses, so the two cannot drift apart again.

2. Settings crumb: resolve the section with the same default the view uses: `const section = SETTINGS_SECTIONS.find(item => item.id === settingsSection(r.section))` (import `settingsSection` from ./settings-sections.js). Then #/settings renders "Settings / General", the same as #/settings/general. The first crumb stays a link to #/settings.

An alternative is to normalise the route instead, by having parseRouteHash/navigate turn #/settings into sec …

**Suggested regression test:** Extend test/e2e/settings.e2e.ts in two places.

1. In the test "operational tools are direct destinations and old Settings links still work" (around line 295), after the heading waitFor in the loop, add: `assert.equal(await page.locator('.crumbs-bar [aria-current="page"]').textContent(), name)`. This covers workspace/"Repository tools" as well as Scheduling, Inbox and Insights.

2. Add a check that goes to `#/settings`, then also presses Meta+Comma from `#/`, and asserts that `page.locator('.cru …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server ("qa-server.sh start v4661 4661 fake", source dogfood-qa at f14f404) and drove it with a fresh headless Chrome. I used no saved profile, so cookies and localStorage played no part. The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4661/crumbs.mjs and its output is crumbs.log in the same folder. For each route it read the `.crumbs-bar .crumb` texts, the aria-current crumb, the main h1 and the active Settings nav item.

Results:
- #/settings: crumbs ["Settings"]. The active Settings nav item is "General" (aria-current=page) and the General panel is shown.
- Cmd+, and App menu → Settings both land on #/settings with the same result: crumbs ["Settings"], General shown.
- #/settings/general shows the same content, but its crumbs are ["Settings","General"].
- Palette "Repository tools" (the only match, detail "Workspace · code, checks and repositories"), App menu → Repository tools and the direct #/workspace link all give crumbs ["Repositories"] with h1 "Repository tools".
- For comparison, #/project/<MQTT-MCP>/repositories and #/project/<id>/workspace give crumbs ["MQTT-MCP","Repositories"], which is consistent.

The screenshots match the DOM data: 001-hash-settings.png shows the bar reading "Settings" while General is highlighted, and 005-palette-repo-tools.png shows the bar reading "Repositories" above the heading "Repository tools". Both are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4661/. There were no console, page or 5xx errors.

Checks for whether this is by design:
- docs/project-first-navigation-plan.md:95 says "Use Repositories for the destination and Repository tools for actions inside it". However, line 125 requires "the same display terms in visible labels, accessible names, breadcrumbs, command search".
- test/e2e/settings.e2e.ts:295 asserts that "Repository tools" is both the h1 and the palette name of #/workspace, so "Repository tools" is the intended name of the global page.
- Before PR #44 (217a659), the crumb and the h1 both said "Repository workspace". That commit renamed the h1 to "Repository tools" and the crumb to "Repositories", which is where they diverged.
- Inbox, Scheduling and Insights all have crumbs that match their headings; #/workspace is the only one that does not.

Nothing in the setup could explain the result: the brows …

</details>

### t00-24 · minor · 'Only <repo>' filter follows the composer's repository, not the project page being viewed

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-16.

**Repro**

> 1. Pick the QA MQTT draft in the composer, tick View and filter runs → 'Only t00-MQTT-MCP'.
> 2. Open the QA Health project page (#/project/<health id>) and open the filters again.

**Expected:** The filter is clearly tied to a repository the user chose here, or follows the page in view (the Rail docstring says nothing depends on a pick made elsewhere).

**Actual:** On the QA Health page the sidebar still says 'Only t00-MQTT-MCP' and lists MQTT runs.

**Root cause (verifier):** The sidebar's repository filter is a boolean. The repository it applies to comes from the composer's draft destination when the filter is evaluated, not from anything chosen in the filter.
- ui/state.ts:1047-1048: `RunFilter.thisRepo: boolean`, documented as "Only runs in the selected repository".
- ui/state.ts:163: `repo = computed(() => repoInfo.value?.repo)` is the composer's repository. switchComposer (ui/state.ts:1276) changes it through setRepo, for example from a project page's "New run".
- ui/state.ts:910: historyRequestQuery sends `repo=repo.value` when thisRepo is set.
- ui/state.ts:1065: matchesFilter filters loaded runs by `repo.value`.
- ui/state.ts:219: setRepo refreshes the list whenever the composer repository changes and thisRepo is on, so a composer pick re-scopes the sidebar.
- ui/rail.tsx:491: the label shows `Only ${baseName(repo.value)}`.

Together these break the Rail contract at ui/rail.tsx:95-96 and the plan's rule (docs/project-first-navigation-plan.md, context section and Phase 2) that global list filters are separate from composer destination state. The visible results:
- A project page (route.view === "project", ui/rail.tsx:116) shows a sidebar scoped t …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-history-ui.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-navigation.e2e.ts`

**Suggested fix:** Store the repository in the filter itself so it no longer depends on the composer.
1. Replace `thisRepo: boolean` with `repo: string` in RunFilter (ui/state.ts:1041-1051). Add a one-time migration in the runFilter initializer: a stored `thisRepo: true` becomes `repo: store.get("repo") ?? ""`, and a stale `thisRepo` key is dropped.
2. In historyRequestQuery (ui/state.ts:910), use `f.repo`. In matchesFilter (ui/state.ts:1065), pass `repo: f.repo || undefined`. Update filterActive (ui/state.ts:1062) and the Clear button (ui/rail.tsx:501) to set `repo: ""`.
3. Remove the `runFilter.value.thisRepo` refresh in setRepo (ui/state.ts:219). Composer picks should no longer touch list filters.
4. In ui/rail.tsx:490-492, replace the checkbox with a `<select aria-label="Repository">`, matching the Pattern and Agent selects. Offer "Any repository" plus the repositories of the known projects, labelled by project and folder name with the full path as the title. Optionally default the first choice to th …

**Suggested regression test:** Unit test in test/run-history-ui.test.ts: adapt "status, provider and repository filters have independent server cursors..." (line 83). Set `state.runFilter.value = {..., repo: "/first"}`, then set `state.repoInfo.value` to "/second" (simulating a composer switch). Assert that `state.historyRequestQuery()` still contains `repo=%2Ffirst`, that `state.matchesFilter(run with repo "/second")` is false, and that a "/first" run matches. Add a migration test: stored `{"thisRepo":true}` with store repo  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4685 on port 4685. The old v4685 home was moved aside first. I used the API to create 3 solo fake runs with check "true": 2 in MQTT-MCP (p-ef01794b) and 1 in industriHealth (p-acdbb4ae). Then I drove the UI with Playwright, using profile v4685 at http://127.0.0.1:4685. Scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4685/repro.mjs and repro2.mjs. Logs: repro.log and repro2.log in the same folder.

S1: I opened the MQTT-MCP composer at #/project/p-ef01794b/new, then Application menu, then View and filter runs. The checkbox reads "Only MQTT-MCP".
S3: After ticking it, the hint reads "2 of 3 tasks". The request is /api/runs?limit=100&repo=.../MQTT-MCP and the sidebar lists only the two MQTT runs.
S4: I opened the industriHealth project page (#/project/p-acdbb4ae, heading "industriHealth"). The sidebar still says "Only MQTT-MCP" (checked, 2 of 3 tasks) and lists the MQTT runs. Its Projects section is empty, so the project being viewed is not in the sidebar at all, while the main page shows the Health run. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4685/002-health-page-filter-still-mqtt.png
T0: The state survives a reload.
T1: I clicked the page's "New run" (a composer pick only, never touching the filters). The sidebar filter changed by itself to "Only industriHealth" (1 of 3 tasks).
T2: On the MQTT-MCP project page the sidebar now shows only the industriHealth run.

The browser recorded no console or 5xx errors.

Why it is not by design: the Rail docstring at ui/rail.tsx:95-96 says "Nothing in it depends on a project you picked somewhere else". In docs/project-first-navigation-plan.md, the context section and Phase 2 say to "Separate the project being viewed, the composer draft's destination and the filter used by global lists" and "Separate global list filters from composer destination state". The e2e test title in test/e2e/project-navigation.e2e.ts:107 says "...without changing global filters", but it never checks this filter.

What argues for minor: the label names the repository truthfully, nothing is lost, and Clear restores the list. The RunFilter field comment at ui/state.ts:1047 ("Only runs in the selected repository") and test/run-history-ui.test.ts:84-91 show the coupling to the composer predates the project-first plan. It is legacy behavi …

</details>

### t00-19 · minor · Bulk-selection error message stays after 'Clear selection' and after later successful bulk actions

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-23.

**Repro**

> 1. Select runs; force one archive to fail (500), so the error 'Run X: …' shows.
> 2. Click Clear selection, then do a successful bulk delete.

**Expected:** The error clears when the selection changes or the next action succeeds.

**Actual:** The archive error stays under the bulk actions through Clear selection and through a later bulk delete (S7–S9).

**Root cause (verifier):** ui/rail.tsx:108: `bulkError` is local state in Rail(). Only two places clear it:
- ui/rail.tsx:156, in archiveSelected (`setBulkBusy(true); setBulkError("")`)
- ui/rail.tsx:441, in the "Select runs"/"Done selecting" toggle (`setSelecting(!selecting); setSelected(new Set()); setBulkError("")`)

Nothing else that changes the selection or performs a bulk action resets it:
- toggleSelected (ui/rail.tsx:141) and deselect (ui/rail.tsx:140)
- the "Select loaded"/"Clear selection" button (ui/rail.tsx:444)
- the eligibility-pruning effect (ui/rail.tsx:136-139)
- deleteTasks (ui/rail.tsx:148-154), which opens DeleteRunsDialog
- DeleteRunsDialog's success path (ui/run-actions.tsx:44-55), which reports through its own `error` state and onDeleted/onClose (ui/rail.tsx:541) and never touches the rail's bulkError

The alert at ui/rail.tsx:450 therefore keeps rendering the last archive failure until the user archives again or leaves selection mode.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** The bulk error should describe only the latest bulk action, and only while the runs it names are still part of the selection. Changes in ui/rail.tsx:
1. Call `setBulkError("")` at the start of deleteTasks (line 148), so starting a bulk or row delete clears the stale archive error. Bulk delete failures already show inside DeleteRunsDialog.
2. Clear it when the user changes the selection by hand: in toggleSelected (line 141) and in the Select loaded / Clear selection onClick (line 444).

Recommended, more robust option: store the failures as `{id, message}[]` instead of a joined string. Render only the entries whose id is still in `selected`, and drop an entry in `deselect`, in the pruning effect at 136-139, and on deletion. Then an error disappears once its run is unchecked, archived or deleted, but stays visible while the failed run is still selected, which is when it is useful for a retry. Keep the existing resets at 156 and 441.

**Suggested regression test:** Extend test/e2e/ui.e2e.ts "bulk run selection archives and deletes with partial failure recovery" (line 1448), or add a sibling test:
1. Create 3 stopped solo runs and search for them.
2. Click "Select runs" and "Select loaded".
3. Route POST `${BASE}/api/runs/${ids[0]}/archive` to `route.fulfill({ status: 500, json: { error: "Simulated archive failure" } })`, then click Archive.
4. Assert that `rail.getByRole("alert").filter({ hasText: "Simulated archive failure" })` is visible and the status r …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server (name v4677t19, port 4677, new home) and pointed it at a throwaway git repo in the scratch clones folder. Through the API I created 5 finished solo runs named "QA bulk 1..5". Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4677t19/ (seed.mjs, repro.mjs, repro2.mjs) and the logs are repro.log and repro2.log in the same folder.

repro.mjs, run in a fresh browser profile:
1. In the rail I searched "QA bulk", clicked "Select runs" and checked runs 1 and 2.
2. I made POST /api/runs/<run1>/archive return 500 {"error":"Simulated archive failure"} with page.route, then clicked Archive. The rail showed "1 selected", the toast "1 run archived" and role=alert "QA bulk 1: tweak README line 1: Simulated archive failure". So far this is correct.
3. I unchecked run 1 (0 selected). The alert stayed.
4. I clicked "Select loaded" (4 selected), then "Clear selection" (0 selected). The alert stayed both times.
5. I checked runs 3 and 4, clicked Delete… and then "Delete 2 runs". The dialog closed, the toast said "2 runs deleted" and the API returned 404 for both runs. The alert still said the archive had failed. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4677t19/003-C1-after-delete.png shows "0 selected", the stale archive error and the "2 runs deleted" toast together.
6. A later successful bulk Archive cleared the alert. So did toggling Done selecting / Select runs. Those are the only two places that reset it.

repro2.mjs: I made the archive of run 1 fail again, then bulk-deleted run 1 itself. The run was gone (API 404, rail list empty), but the alert still said "QA bulk 1 …: Simulated archive failure" about a run that no longer exists.

Refutation checks:
- The 500 comes from route interception, as in the reporter's script. That only creates the error. Whether the error persists is pure client state, so the script is not the cause. The server's archive endpoint can also fail for real (src/engine.ts:3603-3604: "Stop the run before archiving it", "Wait for the new chat…"), and that sets the same state.
- Nothing in docs/*.md or the code comments says a bulk error is meant to stay until the next archive.
- The existing e2e test ("bulk run selection archives and deletes with partial failure recovery", test/e2e/ui.e2e.ts:1448) only covers a delete failure, which liv …

</details>

### t00-20 · minor · 'Select loaded' also selects runs hidden behind 'Show N more' (113 selected while 28 rows are visible)

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-23.

**Repro**

> 1. Project grouping with several projects with more than 5 runs; fold one project.
> 2. Select runs → Select loaded.

**Expected:** The help text says it includes folded projects; it should also say it includes runs hidden behind 'Show N more' (or not select them).

**Actual:** '113 selected' with only 28 checkboxes visible. Archive or Delete would act on about 85 runs the user can't see. The help mentions only folded projects.

**Root cause (verifier):** The selection and the rendering use different sets of runs.

- ui/rail.tsx:133: `const eligible = list.filter(run => !taskRunning(run));` covers every loaded run that matches the filter, whether it is visible or not.
- ui/rail.tsx:444: Select loaded does `setSelected(new Set(eligible.map(run => run.id)))`.
- The rendering truncates on its own. ui/rail.tsx:69 sets `PER_PROJECT = 5`. ui/rail.tsx:286 has `const shown = folded ? … : showAll ? g.runs : g.runs.slice(0, PER_PROJECT);`, and ui/rail.tsx:287 sets `hidden = g.runs.length - shown.length` (the "Show N more" button at :307-310).
- The "N selected" status (ui/rail.tsx:441) counts `selectedRuns` from `eligible`. Nothing tells the user how many selected runs are off screen.
- ui/rail.tsx:449 says only "Select loaded includes matching runs in folded projects."
- ui/rail.tsx:445 / archiveSelected (rail.tsx:159-169) archives every selected run immediately, with no confirmation.

Why this is not just "by design": the button is named "Select loaded" (all loaded history pages), and the help says it deliberately reaches folded projects. So selecting off-screen runs is intended. Leaving out the "Show N more" runs from the help, and showing …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Keep the "select all loaded" behaviour, but make it visible and honest.
1. In the rail.tsx:449 help text, also mention collapsed rows. For example: "Select loaded includes matching runs in folded projects and behind 'Show N more'."
2. Count the selected runs that are not rendered. In projectGroup, use per-group `g.runs.length - shown.length` against `selected`. Show that count in the status, e.g. "21 selected · 6 not shown". Also show it on the hidden-run affordances, e.g. "Show 3 more (3 selected)" on the rail-more button and "6 · 6 selected" on a folded project's count badge.
3. Optional: when the selection includes runs that are not shown, have Archive ask first ("Archive 21 runs, 6 not shown?"). Delete already confirms and lists them.

An alternative is to have Select loaded select only rendered rows. That would contradict the existing intent to include folded projects, so I don't recommend it.

**Suggested regression test:** Add a test to test/e2e/ui.e2e.ts next to "bulk run selection archives and deletes with partial failure recovery".
- Setup: create 7 stopped solo runs in one project via POST /api/runs, then POST /api/runs/:id/seen for each.
- In a fresh page with Project grouping, assert the project shows 5 `.rail-run-row` rows and a "Show 2 more" button.
- Click Select runs, then Select loaded.
- Assert `rail.getByRole('status')` has text /^7 selected · 2 not shown$/ (or similar), that `input.rail-run-check:che …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (v4679 on 127.0.0.1:4679, empty runs dir). I made three throwaway `git init` repos and registered them as projects "V alpha", "V beta" and "V gamma". Then I seeded 8, 7 and 6 finished fake solo/claude runs and marked them seen, so they leave "Needs you" and appear under their projects. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4679/ (seed.mjs, repro.mjs, archive.mjs, cleanup.mjs, *.log).

The browser used a fresh profile, Project grouping and the default view.
- Before selecting: every project showed 5 rows, followed by "Show 1 more" (gamma), "Show 2 more" (beta) and "Show 3 more" (alpha).
- Select runs, then Select loaded, with nothing folded: the status said "21 selected" but only 15 checkboxes were visible, all checked. The 6 runs behind "Show N more" were selected without being visible. The help text read "Only stopped runs on this computer. Select loaded includes matching runs in folded projects." It does not mention runs behind "Show N more". Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4679/001-S1-select-loaded-unfolded.png
- Same steps with V gamma folded: "21 selected", 10 visible checkboxes.
- Delete… opened "Delete 21 runs?" listing all 21 titles, so delete asks for confirmation and names every run.
- Archive has no confirmation. One click archived all 21 runs. The API showed the 6 runs that never appeared on screen (V gamma task 1, V beta task 1–2, V alpha task 1–3) as archived=true.
- I restored them in the UI (Show archived runs, Select loaded, Unarchive: 0 of 21 archived), then deleted all 21 with the UI's bulk delete. The API returned 0 runs.

No console errors or 5xx responses. This matches the reporter's "113 selected vs 28 visible"; a fresh home with 21 runs is enough, so the reporter's environment is not the cause.

Cleanup: QA server v4679 stopped, port 4679 free, the 3 throwaway repos (including their run worktrees) removed. Only my own QA home keeps the 3 test project entries and the deleted-run tombstones. Real project repos were never touched.

</details>

### t01-7 · cosmetic · Composer-mode Projects dialog 'Unassigned draft' row shows counts for all projects

Source: tester unit shell-navigation-settings-2; observed with fake-agents; features SHL-26.

**Repro**

> 1. Open the composer (#/), click a neutral area and press 'p'.
> 2. Read the first row.

**Expected:** The 'Unassigned draft' row shows unassigned counts, or none.

**Actual:** 'Unassigned draft | 100 | Recover a draft that needs a destination · 100 runs': the waiting badge and run count of ALL projects.

**Root cause (verifier):** The relabel in commit 217a6595 (PR #44, "Simplify project navigation…") left the counts behind:
- `ui/projects.tsx:118` builds the first picker row as `row(ALL, composer ? "Unassigned draft" : "All projects", composer ? "Recover a draft that needs a destination" : "show all projects on this computer")`. That commit changed only the label and detail text for composer mode.
- `row()` (`ui/projects.tsx:79-101`) always calls `counts(id)`, defined at `ui/projects.tsx:71-75`.
- `counts()` filters runs with `inScope(r, scope)`, and `inScope` returns true for every run when `scope === ALL` (`ui/state.ts:279-280`, with `ALL = ""` at `ui/state.ts:228`).
- So in composer mode the "Unassigned draft" row shows the waiting badge (`plural(c.waiting, "run") need you`) and the "· N runs (+M archived)" detail for every run on the computer.

The row stands for the unassigned saved draft (`composerProject === ""`), not for a set of runs. Truly unassigned runs belong to scope NONE, and that row is hidden in composer mode (`ui/projects.tsx:120`).

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-navigation.e2e.ts`

**Suggested fix:** In `ProjectsDialog`, stop showing run counts on the composer-mode "Unassigned draft" row. It is a draft, not a filter scope.

- Option 1: give `row()` an optional flag such as `{ counts: false }` and pass it for the composer-mode ALL row.
- Option 2: inside `row()`, compute `const c = projectPickerPurpose.value === "composer" && id === ALL ? null : counts(id)`. When `c` is null, render neither the `.count` badge nor the " · N runs (+M archived)" suffix. The detail then reads just "Recover a draft that needs a destination".
- Filter mode keeps `counts(ALL)` for "All projects", which is correct there.

Using `counts(NONE)` instead is possible, but I don't recommend it. It would put orphaned-run numbers on a draft row whose meaning ("needs a destination") is different from "runs whose project was deleted".

**Suggested regression test:** Add a case to `test/e2e/project-navigation.e2e.ts`.

Setup:
- Create a project with at least one finished, unseen run, so that "All projects" has runs and a waiting badge.
- Open the composer at `#/`, click the heading and press `p` (or click `.where .project-btn`).

Assert on the composer-mode dialog (`dialog.projects-dialog`):
- The first `getByRole("listitem")` has text matching `/^Unassigned draft/`.
- `.locator(".count")` has count 0.
- Its text does not match `/\d+ runs?/`.

Then close the …

<details><summary>Verifier's independent reproduction</summary>

Port 4621 was taken by another agent's server (home v4619k), which I left alone. The existing v4621 home was not clean either: an earlier verifier had left a custom filesystem policy that refused new runs. So I started a brand-new fake-mode server on my extra port: `qa-server.sh start v4621b 4623 fake`. The new home had the user's 8 projects and no runs.

1. Seeded 3 fake solo runs through `POST /api/runs`, in two throwaway git repos in the scratchpad (`clones/v4621-alpha` and `clones/v4621-beta`), so the user's repos were not touched. The server created a project for each repo: v4621-alpha (2 runs) and v4621-beta (1 run). All 3 runs finished unseen, so all 3 count as "needs you". No run was outside a project.
2. In a fresh headless Chrome profile I opened `http://127.0.0.1:4623/#/`, clicked `main h1` and pressed `p` (the reporter's steps). Script: `/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4621/t01-7.mjs`.
   - Composer-mode first row: `'Unassigned draft | 3 | Recover a draft that needs a destination · 3 runs'`. Badge tooltip: "3 runs need you".
   - Project rows: `'v4621-alpha | 2 | … · 2 runs'` and `'v4621-beta | 1 | … · 1 run'`.
   - So the draft row shows the total of every project (3 = 2 + 1), with 0 runs actually unassigned.
   - Screenshot (shows "Unassigned draft (3) … · 3 runs"): `/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4621b/001-t01-7-composer-p1.png`
   - In filter mode (Insights), the same row reads `'All projects | 3 | … · 3 runs'`. The numbers are the same; only the label changes.
3. Deleted project v4621-beta through the API, which left one run truly unassigned, then ran the script again (log: `/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4621/t01-7-p2.log`).
   - Filter mode correctly shows `'Unassigned | 1 | runs whose project was deleted · 1 run'`.
   - The composer's `'Unassigned draft | 3 | … · 3 runs'` was unchanged.
   - So the draft row reflects neither unassigned runs nor the draft. It is always the all-projects total.
4. No console errors or 5xx responses.

Reproduced 2 out of 2 times.

Not by design:
- `docs/getting-started.md:112` only says ambiguous drafts "remain **Unassigned draft** in the composer project picker until you choose a destination". It says nothing about run counts.
- No uni …

</details>

### t25-17 · cosmetic · Projects dialog (composer mode): the 'Unassigned draft' row shows the all-projects run count and needs-you badge

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-05.

**Repro**

> 1. On a fresh fake server with runs in one project, open the composer and press 'p'.

**Expected:** The 'Unassigned draft' row shows no run count, or only unassigned runs.

**Actual:** It reads 'Unassigned draft [1] · Recover a draft that needs a destination · 4 runs', later '12' and '20 runs'. Those are the totals for all projects, the same numbers 'All projects' shows in filter mode.

**Root cause (verifier):** ui/projects.tsx:118 renders the composer's "Unassigned draft" row by calling the shared helper `row(ALL, …)`:
`{row(ALL, projectPickerPurpose.value === "composer" ? "Unassigned draft" : "All projects", …)}`

`row()` (projects.tsx:78-96) always calls `counts(id)` and renders the needs-you badge (lines 86-90) and "· N runs (+N archived)" (lines 93-94).

`counts()` (projects.tsx:69-72) filters runs with `inScope(r, scope)`. In ui/state.ts:279-280, `inScope` returns `true` for every run when `scope === ALL`, and `ALL` is `""` (state.ts:228).

The empty-string key does two jobs:
- the "All projects" filter scope
- the key of the unassigned draft (state.ts:1215 uses `id || "Unassigned draft"`)

So in composer mode the draft row shows the counts for every project. A draft has no runs: launching needs a destination project, and runs with no project are NONE ("none"), not ALL.

This came in with commit 217a659 (PR #44), which relabeled the row for the composer without changing what it counts.

**Files:** `ui/projects.tsx`, `test/e2e/ui.e2e.ts`

**Suggested fix:** In ui/projects.tsx, let `row()` skip the counts. For example, add an `options` argument (`{ counts?: boolean }`), or compute `c` only when the row is a real scope. Then render the composer's Unassigned draft row with no badge and no "· N runs" suffix, and keep the totals for the filter-mode "All projects" row.

Don't swap in `counts(NONE)`: runs "whose project was deleted" are a different idea from the draft that needs a destination, and showing them would mislead in a new way.

Optional follow-ups:
- Make the detail line say whether an unassigned draft exists (e.g. "No unassigned draft" vs "Recover a draft that needs a destination").
- Hide the row in composer mode when no draft is stored under the `""` key. In my baseline it appeared on a fresh profile even with nothing to recover.

**Suggested regression test:** Add a case to test/e2e/ui.e2e.ts next to the project-picker steps around line 886 (or a focused projects e2e):
1. With at least one run in a named project, open the composer and press `p` (or click `.composer .project-btn`).
2. Find `page.locator(".projects-dialog .project-row", { hasText: "Unassigned draft" })` and assert `row.locator(".count")` has count 0.
3. Assert its `.pr-detail` text does not match `/\d+ runs?/`.
4. Then open the picker from Inbox (filter mode) and assert that the "All pr …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server on port 4603 with a new home (`v4603t25`; the old `v4603` home had leftover state) and the user's projects.json. Browser at http://127.0.0.1:4603 with a persistent profile.
1. Baseline, no runs: opened the composer and pressed `p`. The dialog showed "Unassigned draft | Recover a draft that needs a destination · 0 runs".
2. In the MQTT-MCP composer I typed two tasks and clicked Send, which created 2 fake solo runs. Both finished with status done.
3. Moved one of them to OPCUA-MCP with POST /api/runs/<id>/project, the endpoint the Move dialog uses. The project chip isn't shown on a chat's run page.
4. Created a third MQTT-MCP run via POST /api/runs and never opened it, so it stays unseen and counts as needs-you.
5. Final state: MQTT-MCP has 2 runs (1 needs you), OPCUA-MCP has 1, and 0 runs are unassigned (every run has a project).
6. Composer mode (#/project/p-ef01794b/new, press `p`, help text "Open a project's saved draft…"): the first row read "Unassigned draft [1]", with the badge title "1 run need you", and "Recover a draft that needs a destination · 3 runs". The MQTT-MCP row read "· 2 runs" with badge 1, and OPCUA-MCP read "· 1 run". So the Unassigned draft row shows the sum of every project.
7. Filter mode (#/inbox, press `p`): "All projects [1] · show all projects on this computer · 3 runs". These are the same numbers. No "Unassigned" row appears because no run is orphaned.
8. No console errors and no 5xx responses.

Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4603t25/001-p-composer.png
Logs: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4603t25/04.log

Ways I tried to refute it, none of which held:
- Docs: docs/getting-started.md:112 describes "Unassigned draft" only as a migrated draft without a destination. Nothing says it should show run totals.
- Git history: commit 217a659 (PR #44) changed the label of the old "All projects" row ("new runs go in their repository's project"), where all-project counts made sense, to "Unassigned draft" in composer mode. It kept `row(ALL, …)`, and with it the all-project counts. This looks like an oversight, not a design choice.
- Tester's setup: not the cause. The numbers come straight from the code path, and I reproduced them on a fresh server and browser profile.

Cleanup:
- Archived all 3 runs with cleanup and deleteBranch …

</details>

### t26-9 · minor · Projects dialog from the composer shows an 'Unassigned draft' row whose counts are all runs (e.g. '27 runs (+2 archived)', badge 22)

Source: tester unit usability-failure-cases-2; observed with fake-agents.

**Repro**

> 1. Have runs only in named projects (none unassigned).
> 2. On the composer, press p.

**Expected:** The 'Unassigned draft' row shows unassigned counts (0), or no run counts at all.

**Actual:** It reads 'Unassigned draft 22 · Recover a draft that needs a destination · 27 runs (+2 archived)', the totals for every project, which suggests 27 unassigned runs.

**Root cause (verifier):** In ui/projects.tsx:118 (ProjectsDialog), composer purpose renames the ALL row (id "") to "Unassigned draft" / "Recover a draft that needs a destination". It still goes through the shared row() helper (ui/projects.tsx:79-104), and that helper always calls counts(id). counts (lines 70-73) filters runs with inScope(r, scope), and ui/state.ts:279-283 returns true for every run when scope === ALL (""). So the draft-slot row shows the total run count, the archived count and the needs-you badge (titled "N runs need you") for every project.

In composer purpose, id "" means the draft that has no project (composerProject, ui/state.ts:236; draft key "" in ui/state.ts:1215), not "all runs". A run count has no meaning on that row. The filter purpose's NONE row (line 120), which counts runs with no project, is hidden in composer purpose, so the dialog never shows the correct unassigned count either.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** In ui/projects.tsx, give row() a way to omit run statistics, such as a `stats = true` parameter or a null-returning counts. When stats is off, render no waiting badge and no " · N runs (+M archived)" suffix. At line 118, pass stats=false when projectPickerPurpose.value === "composer", so the row reads only "Unassigned draft / Recover a draft that needs a destination". The "All projects" filter row keeps its totals.

Don't swap in counts(NONE): the row stands for a draft, not a run scope. Showing NONE's counts would just move the confusion, because runs with no project are not the draft. Optionally, the row could also be shown only when an unassigned draft actually exists (draftStore has key "") or when composerProject is ""; the docs describe it as a recovery slot. That would be a separate polish item.

**Suggested regression test:** In test/e2e/ui.e2e.ts, near the project-picker steps (around line 886), make sure at least one run exists in a named project (earlier tests already create some). Go to `${BASE}/#/new`, press "p" (or click .project-btn in the composer), and take the row `page.locator('dialog.projects-dialog .project-row', { hasText: 'Unassigned draft' })`. Assert `await row.locator('.count').count() === 0` and assert its `.pr-detail` innerText does not match /\d+ runs?/, for example `assert.equal(await row.locato …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server named v4653t26 on port 4653, with a new home and no runs. I made a scratch git repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4653t26-scratch and added it through the API as the project "Scratch QA". I then started 5 runs in that repo through POST /api/runs. One of them used the AUTO-QUESTION prompt. Every run was assigned to project p-23c222b9, so no run was unassigned and none was archived.

The browser script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4653t26/probe.mjs. It runs a fresh Playwright profile, goes to /#/ and presses "n" (the route becomes #/new/unassigned), then presses "p". The Projects dialog opened with the help text "Open a project's saved draft…". Its first row read "Unassigned draft [badge 5] Recover a draft that needs a destination · 5 runs", while the "Scratch QA" row also read "5 · 5 runs". All other projects showed 0 runs. Opening the dialog with the composer's .project-btn gave the same row.

The badge's tooltip ("5 runs need you") and the "5 runs" detail both count runs from every project, so the row looks like it holds 5 unassigned runs. The screenshot is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4653t26/001-composer-p-dialog.png. No console errors or 5xx responses occurred.

I checked whether this is by design. docs/getting-started.md:112 says drafts that can't be placed "remain **Unassigned draft** in the composer project picker until you choose a destination". That covers the row existing, but nothing in the docs or code comments says the row should show run totals. No e2e test covers this row; test/e2e/ui.e2e.ts:886 only tests the "All projects" filter row. The tester's environment didn't cause this: I reproduced it with a fresh browser profile, a fresh home and 5 runs instead of their 27.

Cleanup: I cancelled and deleted all 5 runs and the Scratch QA project through the API, stopped v4653t26, and confirmed ports 4653 and 4654 are free. Deleting the runs left their worktrees and codeflow/* branches in my scratch repo, so I removed that repo with rm -rf; it lived only in the scratchpad. Nothing is left over. The old v4653 home from an earlier session was not touched.

</details>

### t00-23 · cosmetic · Delete-project confirmation grammar: 'Its 1 run stay, in no project.'

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-18.

**Repro**

> Project editor (sidebar … on a project with one run) → Delete project.

**Expected:** 'Its 1 run stays, in no project.'

**Actual:** 'Delete the project “QA Temp”? Its 1 run stay, in no project.'

**Root cause (verifier):** ui/projects.tsx:170 builds the message as `Its ${plural(inProject.length, "run")} stay, in no project.`. The helper `plural` (ui/projects.tsx:37, `${n} ${word}${n === 1 ? "" : "s"}`) only adds or drops the "s" on the noun. The verb "stay" is a fixed string, so it does not agree with the noun when the count is 1. The same fault is at ui/projects.tsx:87: `title={`${plural(c.waiting, "run")} need you`}` shows "1 run need you" in the project picker's count badge.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/projects.tsx`

**Suggested fix:** Make the verb follow the count. The smallest fix in ui/projects.tsx:
- line 170: `Its ${plural(n, "run")} ${n === 1 ? "stays" : "stay"}, in no project.`
- line 87: `${plural(c.waiting, "run")} ${c.waiting === 1 ? "needs" : "need"} you`

For a cleaner fix, move the wording into a small pure helper in a .ts module that tests already import from (for example a new ui/project-text.ts). Something like `projectDeletePrompt(name, runCount)`, plus a `countVerb(n, singular, plural)` helper or a `pluralVerb` sibling to `plural`, used for both strings. Then projects.tsx calls those helpers instead of fixed text.

**Suggested regression test:** Add test/project-text.test.ts, run with npx tsx --test test/project-text.test.ts and importing from "../ui/project-text.js" (the same way test/model-order.test.ts imports ../ui/model-order.js). Assert:
- `projectDeletePrompt("QA", 1)` === 'Delete the project “QA”? Its 1 run stays, in no project.'
- `projectDeletePrompt("QA", 2)` ends with 'Its 2 runs stay, in no project.'
- `projectDeletePrompt("QA", 0)` ends with 'It has no runs.'
- the waiting tooltip reads '1 run needs you' for 1 and '2 runs  …

<details><summary>Verifier's independent reproduction</summary>

I started a new fake-mode server, v4687g on port 4687, with a new home. I made two small scratch git repos under qa/clones and set up the starting state through the API: project "QA One" with 1 fake solo run, "QA Two" with 2 runs, and "QA Empty" with no repositories and no runs. Then I used headless Chrome on a clean profile (script work/v4687g/confirm.mjs). For each project I expanded "11 more projects" in the rail, hovered the project, clicked "Edit <name>", then clicked "Delete project" and read the confirm dialog.
- QA One: "Delete the project “QA One”? Its 1 run stay, in no project." (screenshot shots/v4687g/002-confirm-QA-One.png)
- QA Two: "Its 2 runs stay, in no project." (correct)
- QA Empty: "It has no runs." (correct)

There were no console errors or 5xx responses. Deleting the projects through the UI showed the toast "Deleted the project …", and the runs stayed with no project, so the wording describes the behaviour correctly apart from the verb.

I also checked the project picker ("Choose project"): the waiting-count tooltip has the same fault, "QA One => 1 run need you", while QA Two shows "2 runs need you".

Nothing in docs/*.md or the code comments asks for this wording. The comment at src/engine.ts:3656 ("Its runs stay, in no project") is where the plural verb came from. The fault does not depend on the environment: the 1-run case always produces it.

Cleanup: I deleted all 3 runs and the 3 projects through the UI, stopped v4687g, and removed both scratch repos along with their worktrees. Nothing is left over apart from the home folder homes/v4687g.

</details>
