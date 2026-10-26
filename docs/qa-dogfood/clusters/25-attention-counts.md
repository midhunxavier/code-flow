# Cluster 25 · attention-counts

**Inbox/'Needs you' attention counts, notifications at boot, collapsed-rail badge**

Status: **fixed and independently verified** · 12 issues · branch `codex/qa-attention-counts`

Planner notes: t01-1 (major): the SSE 'older attention' set (streamAllRuns in src/server.ts ~1274 and the /stream runs topic ~1336) is picked without excluding the recent page, and counts are built from loaded runs only. Send an attention count from the server. t00-12: the Inbox misses solo results with uncommitted changes (src/review-inbox.ts, engine/git), so 'Needs you' and Inbox disagree. t00-3/S00-1: applyRunList calls noticeChange for runs that are only now entering the map, firing desktop notifications and screen-reader announcements at boot. t01-14: 'Older attention is paged' stays after all history has loaded. t00-13/t01-6/S09-7: the Application menu shows the Inbox count on 'Scheduling' (ui/rail.tsx:531). S14-7: the automations pending badge in the Settings nav is dead code. t00-14/S01-2/t25-5: the collapsed-rail CSS hides the Inbox .count, and '/' calls the persisted setRailCollapsed (ui/state.ts:60). history-paging-counts owns the run and project count totals. Duplicate groups: [["t00-3","S00-1"],["t00-13","t01-6","S09-7"],["t00-14","S01-2","t25-5"]]

Likely files: `src/server.ts`, `ui/state.ts`, `ui/rail.tsx`, `src/review-inbox.ts`, `src/engine.ts`, `ui/styles.css`, `ui/settings.tsx`, `ui/app.tsx`, `ui/automations.tsx`, `src/git.ts`

## Final integrated follow-up · 2026-10-26

Final review found native approval requests missing from authoritative attention totals despite correct chat navigation. Commit15a70ad derives a nonpersistent approvalPending summary field from a side-effect-free live registry projection. Counts, filters, pagination and streamed summaries agree; resolved, stopped, archived and inaccessible requests are excluded. See [attention verification](../final-approval-attention.md).

## Issues

### t01-1 · major · Inbox count, app-menu badge, 'Needs you' and tab title omit attention items older than the newest 100 runs

Source: tester unit shell-navigation-settings-2; observed with fake-agents; features SHEL-GAP-01, SHL-25.

**Repro**

> 1. Fresh fake QA server with more than 100 runs: 106 recent finished runs that were never opened, plus 100 older runs with status failed and seen=false (e.g. created 2 days earlier).
> 2. Open http://127.0.0.1:<port>/ and look at the sidebar Inbox count, the Application-menu badge, 'Needs you' and the tab title.
> 3. Open #/inbox.
> 4. Click 'Load older runs' in the sidebar twice and compare.

**Expected:** The Inbox and the badges cover all runs that need review (104 here), or clearly say they are partial. The SSE hello carries older attention items as docs/api.md describes ('at most 100 older attention items').

**Actual:** Before paging: Inbox 4, app-menu badge 4, title '(100) code-flow', Needs you 100; the Inbox page says 'Review inbox 4' and lists no failed runs. After two 'Load older runs': Inbox 104, badge 99+, title (203). The /api/events hello had 103 runs, attentionTotal 203, attentionTruncated true. The 100 failed runs needing review were invisible until the user paged history.

**Root cause (verifier):** 1. The SSE "older attention" set is chosen without excluding the recent page.
   - src/server.ts:1274 (streamAllRuns, /api/events) and src/server.ts:1336 (the /stream "runs" topic the UI actually uses, ui/state.ts:1102) call manager.attentionPage({limit:100, predicate}) with no cursor.
   - src/engine.ts:3403-3405 filters the newest-first runIndex for needsYou, then takes remaining.slice(0, limit). That is the 100 NEWEST attention items, which are exactly the runs already in page.runs. The Map merge at server.ts:1275/1337 then removes the duplicates.
   - So when 100 or more of the newest attention items are inside the recent page, no older attention is delivered. With fewer, the overlap still cuts into the 100-item budget. For example, 30 recent unseen runs plus 100 older failures delivers only 70 of the failures.
   - The bug only shows when total attention exceeds 100. needsYou (src/run-status.ts:33) counts every finished run with !seen, so routine never-opened results fill the budget even though they are not Inbox items: the Inbox uses reviewReason in src/review-inbox.ts:5-17, which needs failure, blocked, triage or a diff stat.
2. The client counts only loaded runs and never s …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-storage.test.ts`

**Suggested fix:** 1. In both hello builders (src/server.ts:1274 and :1336), page attention from after the recent page: manager.attentionPage({limit:100, cursor: page.nextCursor, predicate}). Skip it when there is no nextCursor; running runs are still always included. The 100 slots then really are "older attention items", as docs/api.md says. The cursor ordering (compareRuns/afterRunCursor) already matches page().
2. Within that older budget, put real Inbox reasons first (answer, blocked, failed, triage/review, via reviewReason) ahead of plain unseen-done runs, so failures and questions are never pushed out by unopened results. Alternatively, add a separate bounded "inbox" selection.
3. Send authoritative counts computed over the whole authorized index in the hello, and keep them current on run events: for example attentionTotal (already sent) plus a new inboxTotal. When attentionTruncated is true, the UI should show the server totals for the Inbox count, app-menu badge and tab title (or "N+"), not loade …

**Suggested regression test:** Server test in test/server-reliability.test.ts, next to the existing /api/events?limit=100 test at line ~506; add the same case for the /stream "runs" topic:
- Seed 106 unseen done runs (no artifacts) newer than 100 unseen failed runs.
- Read the first hello and assert every one of the 100 older failed run IDs is in hello.runs, i.e. the number of hello runs outside the recent page equals min(100, older attention).
- Assert attentionTruncated is false when older attention is 100 or less, and true …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake QA server, v4609t on port 4609 (new home: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4609t). I made a scratch git repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4609-tiny and started one real fake fix-review run in it to use as a template. That run ended done, unseen, with a diff artifact, so it is one Inbox item. I stopped the server and seeded 206 run logs from the template with /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4609t/seed.mjs:
- 106 "recent" runs created 20 to 126 minutes ago: done, seen=false, no artifacts. They count as "needs you" but are not Inbox items.
- 100 "older" runs created 2 days ago: status failed, seen=false. These are Inbox "failed" items.

After restarting, the API gave GET /api/runs?status=attention total 207, all runs 207, failing 100. The SSE hello from /api/events?limit=100 had runs=100, total=207, attentionTotal=207, attentionTruncated=true and an attentionNextCursor. It delivered 0 of the 100 older failed runs and 99 of the recent ones, so every attention slot went to runs already in the recent page.

UI, fresh browser, script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4609t/inbox.mjs, log inbox.log in the same folder:
- On load: tab title "(100) code-flow", sidebar Inbox count 1 (aria "Inbox, 1 need attention"), app-menu badge 1, "Needs you" 100. #/inbox shows "Review inbox 1" with only the template run and none of the 100 failed runs. The page has no notice that the list is partial.
- The rail history area does say "207 running or attention items at last refresh. Older attention is paged; use Load older runs to include more."
- After the first "Load older runs": Inbox 94, badge 94, Needs you 200, title (200).
- After the second: Inbox 101, badge 99+, Needs you 207, title (207). All 100 failed runs now appear in #/inbox.

Screenshots are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4609t/ (001-initial.png, 002-inbox-before.png, 003-inbox-after.png, 004-menu-after.png). The browser reported no errors.

Why this is not by design, and not caused by the environment:
- docs/api.md:138-142 says the hello …

</details>

### t00-12 · minor · 'Needs you' count (and tab title) disagrees with the Inbox count

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-12.

**Repro**

> 1. Fake QA server; create several solo runs that finish without changes and leave them unseen, plus a few with diffs.
> 2. Look at the sidebar 'Needs you' badge, the tab title and the Inbox link.

**Expected:** The attention counts agree, or the difference is explained.

**Actual:** Sidebar 'Needs you 14' and tab title '(14) code-flow', but Inbox 'Inbox, 6 need attention' and the Inbox page 'Review inbox 6' (All projects). Eight unseen results without changes are 'Needs you' but are not in the Inbox.

**Root cause (verifier):** There are three causes. Only the first two are defects.

(1) The Inbox misses Agent (solo) results whose changes are uncommitted. This is the main gap.
- src/patterns/solo.ts:54 (and engine.ts:5866-5869 for replies) calls `conversationResult` when `checkpointOnFinish` is off, which is the default Agent mode.
- src/engine.ts:2383-2386 stores `stat = diffStat(at, baseRef)`.
- src/git.ts:645-646 computes that as `git diff --stat base..HEAD`, which only counts commits. New and modified files in the worktree are ignored, so `stat` is "".
- src/review-inbox.ts:16 only returns "review" when `artifact.stat?.trim()` is non-empty.
- Result: an Agent run that changed files never appears in the Inbox, while it stays in "Needs you". That contradicts docs/runs.md:64 ("Review changes includes new and uncommitted files") and the intent of test/review-inbox.test.ts:18 ("manual results ... appear alongside automation results until viewed").

(2) The tab title counts runs, but the sidebar counts tasks.
- ui/state.ts:1038 `waitingCount = [...runs].filter(needsYou).length` counts every run, so each provider/side chat in a task counts separately.
- ui/rail.tsx:122 and 165 count `waiting = list.filter(ta …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/git.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/review-inbox.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/review-inbox.md`

**Suggested fix:** (a) Uncommitted Agent results. In `conversationResult` (src/engine.ts:2383), compute a stat that includes the working tree. Add a helper in src/git.ts, for example `workingDiffStat(at, base)`, that runs `git diff --stat <base>` (worktree compared with base, tracked files) and adds untracked files from `git ls-files --others --exclude-standard` (for example "N new files"). The Inbox card then shows the uncommitted changes and `reviewReason` returns "review" without changing its rule. Another option is a `dirty` or `uncommitted` flag on the Workspace artifact that `reviewReason` also accepts. Recompute it on every conversation turn, as already happens.

(b) Tab title. Build `waitingCount` from the same unit as the rail: `groupChatTasks([...runs.value.values()]).filter(task => task.chats.some(needsYou)).length`. Better still, share one helper with rail.tsx `taskNeedsYou` so the two cannot drift apart. Do not apply the rail's search filter to the title.

(c) Optional cosmetic change. Keep  …

**Suggested regression test:** 1. test/review-inbox.test.ts, or an engine test using the fake agent (for example in test/patterns.test.ts): run a solo task without `checkpointOnFinish` where fake claude writes `claude-<id>.txt` without committing. Assert that `run.artifacts[0].stat` is non-empty and `reviewReason(run) === "review"`. Assert that a clean no-op solo run (FAKE_NOOP_VENDOR) still gives `undefined`.
2. A UI unit test (alongside test/chat-family.test.ts, or a new test of the shared count helper): use two unseen runs …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake server (`qa-server.sh start v4665 4665 fake`) with `FAKE_NOOP_VENDOR=codex` exported. I moved the old v4665 home aside first. All runs used a scratch clone of MQTT-MCP. Using the API, I created 11 solo runs and left all of them unseen:
- 5 codex runs that made no changes (worktree clean, `/diff` returns []).
- 3 default claude Agent runs that wrote a file but did not commit it. `/api/runs/<id>/diff` lists `claude-*.txt` as added, but `artifacts[0].stat` is "".
- 3 claude runs with `checkpointOnFinish:true`, so their changes were committed and `stat` is non-empty.

In a fresh headless browser:
- The tab title was "(11) code-flow".
- The rail showed "Needs you 11".
- The Inbox link label was "Inbox, 3 need attention".
- The Inbox page showed "Review inbox 3" (All projects), listing only the 3 committed runs.
- `/api/runs?status=attention` returned 11.
- No console errors. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4665/002-inbox.png

So I reproduced the count mismatch. But 3 of the 8 runs missing from the Inbox did change files; their changes were uncommitted.

Next I started a provider chat (`POST /api/runs/<no-change run>/provider-chat`) on one of the no-change runs. The tab title went to "(12) code-flow", the rail stayed at "Needs you 11" with 11 rows, and the Inbox stayed at 3. So the tab title also disagrees with the sidebar "Needs you" count.

Where the reported claim is by design: an unseen, finished run with no changes appearing in "Needs you" but not in the Inbox is documented behaviour.
- docs/runs.md:125 says "Needs you: finished runs you haven't opened, and interrupted runs ... The browser tab shows the count".
- docs/review-inbox.md:7-9 limits the Inbox to questions, blocked teams, unread failed/interrupted runs and pending results.
- test/review-inbox.test.ts:10 asserts that an unseen `done` run with no artifacts is left out of the Inbox.

Making the two counts equal, as the issue's expected result suggests, would contradict that design. The confirmed defects are the two below.

Cleanup: I deleted all 12 runs through the sidebar (Select runs, Select loaded, Delete 12 runs). That dialog keeps branches and worktrees by design, so I removed the scratch clones v4665-mqtt and v4665-mqtt.git, then stopped server v4665 (ports 4665 and 4667 are free). Leftovers:
- My QA home homes/v4665, which includes a project p-6d03828f that was create …

</details>

### t00-3 · minor · Every page load fires a desktop notification and SR announcement for an old, already-waiting run outside the first history page

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-24.

**Repro**

> 1. Fake QA server. Create a pipeline run with approvals {plan:true} so it waits on 'Approve the plan'.
> 2. Create 100+ newer runs so the waiting run is not in GET /api/runs?limit=100 (it still arrives through the SSE hello attention list).
> 3. Grant notification permission (desktop notifications default on) and load or reload the app twice.

**Expected:** No notification for a run that was already waiting before the page loaded. Notifications only for new transitions.

**Actual:** On each load a Notification 'code-flow: approve the plan' (body 'Awaiting plan: approve the vitals refactor') was constructed, and the live region announced 'approve the plan: …'. Reproduced 2/2 reloads.

**Root cause (verifier):** Startup order:
- ui/main.tsx:118-123 awaits refreshRuns(), which is GET /api/runs?limit=100 and holds only the newest 100 runs. onFinished is still unset at that point, so the baseline is silent.
- Only after that does it call watchAllRuns(notifyFinished); ui/state.ts:1096 sets onFinished.

The server's first "hello" (src/server.ts:1335-1338 for the runs topic, also :1274-1276) merges page.runs with manager.attentionPage(...).runs. Attention runs include every running/awaiting run regardless of age, so it sends runs the client has never seen.

The client applies the hello with applyRunList(data.runs, () => false, !restarted) at ui/state.ts:1117. applyRunList (ui/state.ts:945-953) then calls noticeChange(before.get(run.id), run) for every run (line 952), including runs that are not in `before`. For a first-seen run, before is undefined, so this check fires:
`else if (run.awaiting && !before?.awaiting) onFinished(run)` (ui/state.ts:939)
The team-answer and PR-watch "needs-you" branches on lines 940-941 fire the same way.

notifyFinished (ui/app.tsx:353-382) then sets announcement.value (line 368) whatever the permission, and constructs `new Notification(...)` (line 372) when canNotif …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-history-ui.test.ts`

**Suggested fix:** Treat a run that first appears in a list snapshot (the hello, a history page, a search page or a chat family) as baseline, not as a transition. In applyRunList (ui/state.ts:952), call noticeChange only when the run already existed:
`for (const run of next.values()) { const prior = before.get(run.id); if (prior) noticeChange(prior, run); }`
Live per-run "run" events (state.ts:1137) keep calling noticeChange(before, run) unchanged, so real transitions still alert.

Optional refinement: to still alert for a run that was created and paused while the stream was disconnected (a resync hello after the replay ring was exceeded), allow first-seen runs to notify when run.createdAt is later than the time the page booted or the stream last connected.

Alternative: pass an explicit `notifyNew=false` flag from the initial hello, loadOlderRuns, refreshRuns and loadAgentChats instead of changing the default.

**Suggested regression test:** In test/run-history-ui.test.ts, which already stubs fetch and EventSource and drives state.watchAllRuns, add a test that:
1. Records calls with `const seen: string[] = []; state.watchAllRuns(r => seen.push(r.id))` instead of `() => undefined`.
2. Calls refreshRuns() and answers it with a page that lacks run "old-waiter".
3. Sends `{type:"hello", epoch, seq, runs:[run("new"), {...run("old-waiter","x","running"), awaiting:{kind:"plan", title:"Approve the plan"}}]}`. Assert `seen` stays empty.
4. S …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4647 on port 4647. The old v4647 home from an earlier verifier was moved aside to homes/v4647-prev-*, so the server started with zero runs. For the repo I used a scratch clone of MQTT-MCP (clones/v4647-MQTT-MCP, origin = local bare repo).
1. Through the API, created pipeline run 2610251850-2d6447af, "Old waiter: approve the topic validation plan", with approvals {plan:true}. It reached status=running with awaiting.title="Approve the plan".
2. Created 105 newer solo filler runs. All finished and were marked seen.
3. Control: created a second plan-gated pipeline run, 2610251851-57c7c24d, "New waiter: approve the broker retry plan". It is in the same waiting state but newest, so it is inside the first history page.
4. API check: GET /api/runs?limit=100 returned total 107 and 100 runs. The old waiter was NOT in the page; the new waiter was; nextCursor was set.
5. Browser script work/v4647/t00-3/repro.mjs, run as headless Chrome via qa-browser.mjs. It does NOT use a fake Notification class: it calls context.grantPermissions(["notifications"]) and wraps the real window.Notification constructor in a Proxy to record calls. A MutationObserver records the .sr-only[role=status][aria-live=polite] live region. The script loads "/" and then reloads twice, waiting 5s each time.
Results:
- Fresh browser context: on all 3 of 3 loads exactly one Notification was constructed, {title:"code-flow: approve the plan", body:"Old waiter: approve the topic validation plan", tag:"2610251850-2d6447af"}, and the live region announced "approve the plan: Old waiter: approve the topic validation plan". Nothing fired for the New waiter control run.
- Persistent profile (v4647-notify): same result on 3 of 3 loads.
- No notification permission (Notification.permission="default"): no desktop notification, but the screen-reader announcement for the old waiter still fired on 3 of 3 loads.
- The screenshot shows both runs under "Needs you (2)" and "101 tasks loaded", so the UI treats them the same; only the one outside the first page triggers an alert.
- No console or page errors and no 5xx responses.
The tester's environment does not explain it: the bug reproduces with real Chrome permission, with both fresh and persistent profiles, and without any mock.
It is not by design. docs/runs.md:125 says the bell notifies "when a run finishes or needs you", and the noticeChange comment describes it as a diff "between two snapshots of a run". The identical run inside the first pa …

</details>

### S00-1 · minor · applyRunList calls noticeChange(before.get(id), run) for every run in the merged map, so runs that only now enter the map (hello attention items outside the first /api/runs page, Load older runs, search, loadAgentChats) fire desktop notifications and aria announcements as if they had just started waiting.

Source: code-level suspect at `ui/state.ts:952` (confirmed hands-on).

**Repro**

> Fake-mode server s00 (port 4501). Started an auto-team run with approvals.plan=true through the API; it paused on 'Approve Auto team' (run.awaiting set). Browser script work/s00/notify.mjs: Notification permission granted, window.Notification wrapped to record calls. (a) Reload with the sidebar filter set to All: no notification, empty announcement. (b) Sidebar menu > View and filter runs > 'Passed' (kept in localStorage runFilter), then reload: on every reload Notification('code-flow: approve auto team', body 'Awaiting plan demo: implement the sample') fires and the sr-only live region announces 'approve auto team: ...' for a run that had been waiting for about 45 s. A second reload fires it again. Setting the filter back to All stops it. Unit level: scratch test builds/s00/test/qa-s00-notice.test.ts (npx tsx --test). It loads first page [new], calls watchAllRuns, sends hello [new, old-waiting], then loadOlderRuns returns [older-waiting]. notify is called for ['old-waiting','older-waiting'].

**Expected:** Notifications and announcements fire only when a known run changes into a waiting state (or a new run starts waiting during this session). They do not fire when a run that was already waiting is first loaded into this window.

**Actual:** Each page load or tab with a remembered status, pattern, agent or this-repo filter (or with more than 100 newer runs) re-notifies every awaiting run outside the first page. Load older runs, search pages and deep-linked chat families do the same.

**Root cause (verifier):** boot() runs refreshRuns() (filtered and limited to 100) before watchAllRuns sets onFinished. The unfiltered hello snapshot (page plus attentionPage runs) and later list loads go through applyRunList, which calls noticeChange(before.get(run.id), run) with before === undefined for runs it has not seen yet. noticeChange then treats run.awaiting && !before?.awaiting, the teamAwaitingAnswer request id differing from undefined, and watchNeedingYou(run) && !watchNeedingYou(undefined) as fresh transitions.

**Suggested fix:** In applyRunList, call noticeChange only for runs that were already present (const prior = before.get(run.id); if (prior) noticeChange(prior, run)). To avoid missing runs created and paused while the stream was down, a run that was not loaded before should notify only when its waiting timestamp (awaiting.at, team request time or watch handback time) is later than the moment watchAllRuns started or the last connected time.

**Suggested regression test:** Extend test/run-history-ui.test.ts: refreshRuns returns [new]; watchAllRuns(spy); hello with [new, waiting('old')]; loadOlderRuns returns [waiting('older')]. Assert spy not called. Then a 'run' event that turns 'new' into awaiting must call the spy once.

### t01-14 · cosmetic · Sidebar keeps saying 'Older attention is paged; use Load older runs' after all history is loaded

Source: tester unit shell-navigation-settings-2; observed with fake-agents; features SHEL-GAP-01.

**Repro**

> 1. With more than 200 attention items, click 'Load older runs' until the button disappears.

**Expected:** The truncation notice disappears once everything is loaded.

**Actual:** '218 tasks loaded / 203 running or attention items at last refresh. Older attention is paged; use Load older runs to include more.' remains with no button.

**Root cause (verifier):** ui/state.ts:1108 sets `attentionTruncated` from the stream's `hello` frame. `hello` is only sent on a first connect, a server restart or a stale reconnect cursor; a resumed hello carries no attention fields. `loadOlderRuns()` (ui/state.ts:1016-1035) and `refreshRuns()` (ui/state.ts:991-1014) update `historyNextCursor` and `historyTotal` but never touch `attentionTruncated` or `attentionTotal`. ui/rail.tsx:513 renders the notice on `attentionTruncated.value` alone (`{attentionTruncated.value ? <span ...>... use Load older runs to include more.</span> : null}`). It doesn't check whether there is anything left to load, even though the 'Load older runs' button on the line above (rail.tsx:512) is gated on `historyNextCursor.value`. Once unfiltered history is fully paged (`historyNextCursor` becomes null), every run is in the client map, so every attention item is too. The flag is never cleared, so the notice stays until the next full hello, which normally means a page reload.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/history-launch.e2e.ts`

**Suggested fix:** Two options:
- Smallest fix: in ui/rail.tsx:513, show the notice only while there is more history to load, i.e. `attentionTruncated.value && historyNextCursor.value`. That keeps the instruction consistent with the button it refers to.
- More robust fix in ui/state.ts: clear the flag once unfiltered paging reaches the end. In `loadOlderRuns()`, after `historyNextCursor.value = page.nextCursor ?? null`, add `if (!query && !page.nextCursor) attentionTruncated.value = false;`. Do the same in `refreshRuns()` when there is no query and no `nextCursor`. Optionally set `attentionTotal` from the loaded runs (`[...runs.value.values()].filter(needsYou).length`) so the count stays current.

With a filter active, the cursor belongs to the filtered query. So either keep the rail gate as well, or reword the text to talk about history rather than 'Load older runs' while a filter is on. Don't clear the flag on a filtered end-of-pages.

**Suggested regression test:** In test/e2e/history-launch.e2e.ts, add a fixture (or a second server home) with more than 100 unseen non-archived runs and more than 100 total runs, so the hello sets attentionTruncated=true. The test should:
- assert that the 'Run history pages' region shows 'Older attention is paged' while the 'Load older runs' button is visible;
- click 'Load older runs' until the button count is 0;
- assert `history.getByText(/Older attention is paged/)` has count 0, and that the 'Needs you' count equals the …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode server (home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4635f, port 4635), not the reporter's home. I also used a fresh browser profile (no persistent profile), so their environment and script can't explain the result.
1. Before startup, /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4635f/seed.mjs wrote 225 run records against a throwaway git repo. 210 were unseen 'failed' runs (attention) and 15 were seen 'done' runs. The record shape is the same one test/e2e/history-launch.e2e.ts uses.
2. I started the server with `qa-server.sh start v4635f 4635 fake`. /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4635f/repro.mjs opened the app and clicked 'Load older runs' until the button was gone. Results (repro.log):
   - start: '100 tasks loaded / Load older runs / 210 running or attention items at last refresh. Older attention is paged; use Load older runs to include more.'
   - after load 1: '200 tasks loaded / Load older runs / 210 running or attention ...'
   - after load 2: '225 tasks loaded / 210 running or attention items at last refresh. Older attention is paged; use Load older runs to include more.', with 0 'Load older runs' buttons.
3. At that point every attention run was loaded. The rail's 'Needs you' showed 210, 210 'Seeded unseen failed' rows were in the rail, the oldest one ('run 209') was in the DOM, and the server's /api/runs?status=attention total was 210. The notice still told the user to press a button that no longer exists.
4. I waited 35 s for the 30 s visible-tab poll (refreshRuns). The notice was unchanged. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4635f/003-after-poll.png. No console errors or 5xx.

Why it isn't by design: docs/api.md:138-142 and docs/run-storage.md:17 only say the rail 'displays the truncation' and that older attention 'remains accessible through history'. Nothing says the notice should stay after all history is loaded. 'At last refresh' explains the count, not the 'use Load older runs' instruction. The e2e fixture (test/e2e/history-launch.e2e.ts) has only one unseen run, so no test ever reaches truncation in the UI. Severity stays cosmetic: the text is stale and misleading an …

</details>

### t00-13 · minor · Application menu shows the Inbox attention count on the 'Scheduling' item

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-12.

**Repro**

> With runs in the Inbox (e.g. 6), open the sidebar footer 'Application menu'.

**Expected:** The count appears on an Inbox entry, or nowhere; Scheduling has no attention items.

**Actual:** Menu shows 'Scheduling 6' with aria-label '6 runs need attention' on the Scheduling item.

**Root cause (verifier):** ui/rail.tsx:531: the "Scheduling" MenuItem (go({view:"automations"})) renders `{pending ? <span class="rail-menu-meta" aria-label={`${pending} runs need attention`}>{pending}</span> : null}`. `pending` is `inbox().length` (ui/rail.tsx:167, from ui/automations.tsx:62 prioritizedReviewRuns), so it counts Inbox items. The badge is left over from an older layout. `git log -L` shows it was added in 636d2a3, when this item was "Automations" and opened Settings → automations. That page rendered AutomationsView mode "all", which included the Inbox section (ui/automations.tsx:124-136). Later commits (61c3b23, then e211862 "Consolidate overlapping app workflows and navigation") split Inbox out into its own route (#/inbox renders AutomationsView mode="inbox") and pointed #/automations at SchedulingView (ui/activity.tsx:17-18). The item was renamed to "Scheduling" but kept the Inbox count. The sidebar's Scheduling nav-item (ui/rail.tsx:416) correctly has no count.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/settings.e2e.ts`

**Suggested fix:** In ui/rail.tsx:531, remove the `{pending ? ... : null}` meta span from the Scheduling MenuItem so Scheduling shows no attention count. The Inbox count already appears on the sidebar Inbox nav-item (line 415) and in the menu trigger total (line 522). If the menu should still say where the trigger's total comes from, add an "Inbox" MenuItem that does go({view:"inbox"}) and carries the `pending` meta with aria-label `${pending} runs need attention`, matching the Board item, which shows `unread` on Board. Do not move the count to any Scheduling-related entry.

**Suggested regression test:** Add a scenario to test/e2e/settings.e2e.ts next to the existing "Application menu" checks around lines 173-227. Seed one unseen run that lands in the Inbox, for example a loop run with check "false", or a failed run. Then open the "Application menu" and assert:
- `page.getByRole("menuitem", { name: /Scheduling/ }).locator(".rail-menu-meta")` has count 0, and its accessible name/innerText does not match /\d/ or /need attention/.
- If an Inbox menuitem is added, it shows the same number as the sid …

<details><summary>Verifier's independent reproduction</summary>

1. Started a fresh fake-mode QA server: qa-server.sh start v4667 4667 fake.
2. Used the API to create 3 loop runs in MQTT-MCP with roles {workers:["claude"]} and loop {check:"false", maxSteps:2}. All 3 ended as status "stopped" and unseen, so reviewReason() puts them in the Inbox as "blocked". Two earlier solo runs ended "done" with an empty diff and three crash runs ended "cancelled" after I stopped them, so none of those five counted.
3. Opened http://127.0.0.1:4667/#/settings in a fresh headless Chrome profile so no run page marked anything seen, then clicked the sidebar footer button "Application menu".
Observed:
- Sidebar Inbox nav: aria-label "Inbox, 3 need attention", badge 3.
- Menu trigger: badge "3 items need attention".
- Menu items: [..., "Insights", "Scheduling\n3", "Notifications", ...]. The Scheduling item's .rail-menu-meta has aria-label "3 runs need attention".
- The menu has no Inbox entry at all.
- The sidebar's own Scheduling nav item shows no count.
- Clicking Scheduling opens the SchedulingView (Run once later / Repeat / Process a backlog / Pursue a mission). It lists none of the 3 runs and only says "Results return to the Inbox for review".
- #/inbox lists all 3 runs.
Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4667/001-appmenu-with-inbox.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4667/002-scheduling-page-with-inbox.png.
No console errors and no 5xx responses.
Ruled out other explanations: it does not depend on the environment or the tester's script (fresh profile, fake mode, plain role selectors). It is not by design either. docs/automations.md:12 says "Inbox is a separate sidebar destination", and activity.tsx:18 renders SchedulingView for the automations route, which shows no attention items.
Cleanup: deleted all 8 of my runs with the UI bulk delete. Delete keeps worktrees by design (engine.ts:3610), so I removed my 8 codeflow/<runId> branches and .worktrees/<runId> directories in MQTT-MCP by hand, using exact IDs only. The MQTT-MCP main checkout is clean on main. Stopped the v4667 server. Nothing is left over.

</details>

### t01-6 · minor · App-menu 'Scheduling' item shows the review-inbox count although Scheduling has no inbox

Source: tester unit shell-navigation-settings-2; observed with fake-agents; features SHL-25.

**Repro**

> 1. Have some failed or review runs, so the sidebar 'Inbox' shows N.
> 2. Open the sidebar footer 'Application menu'.
> 3. Note the 'Scheduling N' badge (aria-label 'N runs need attention') and click it.

**Expected:** The count sits on an Inbox entry, or there is none. Scheduling should not claim runs need attention.

**Actual:** 'Scheduling 6' / 'Scheduling 104'. The Scheduling page (#/automations) shows only Run once later/Repeat/Backlog/Mission and none of those runs; they live on #/inbox.

**Root cause (verifier):** ui/rail.tsx:531 renders the inbox count on the Application-menu Scheduling item:
`<span>Scheduling</span>{pending ? <span class="rail-menu-meta" aria-label={`${pending} runs need attention`}>{pending}</span> : null}`
Here `pending = inbox().length` (ui/rail.tsx:167). `inbox` is defined at ui/automations.tsx:62 as prioritizedReviewRuns over all runs, i.e. the review inbox.

This is a leftover. The badge was added when this item was "Automations" and that page held the review inbox (commit fd93482). Commit e211862 (#38) split the views and renamed the item to Scheduling but kept the badge. Now #/automations renders SchedulingView (ui/activity.tsx:18). SchedulingView uses AutomationsView mode="automations" (ui/scheduling.tsx:33-34), and the inbox section is skipped for that mode (ui/automations.tsx:136, `mode !== "automations"`). The inbox lives only at #/inbox (ui/activity.tsx:17, mode="inbox").

The sidebar Scheduling link (ui/rail.tsx:416) correctly has no count, so the two Scheduling entries disagree.

Related: the menu trigger badge at ui/rail.tsx:524 sums `unread + pending`, but no item in the menu leads to the inbox. Part of that count points nowhere in the menu.

Similar dead  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`

**Suggested fix:** In ui/rail.tsx:531, remove the `{pending ? <span class="rail-menu-meta" aria-label=... runs need attention>...}` meta from the Scheduling MenuItem, so it reads just "Scheduling", like the sidebar link at :416.

Then pick one option for the trigger badge at :524:
- (a) Count only `unread` (Board items reachable from the menu). The Inbox count is already in the sidebar destinations.
- (b) If the attention count should stay on the collapsed/mobile menu trigger, add an "Inbox" MenuItem (go({view:"inbox"})) that carries the `pending` meta with an accurate label, e.g. "N need attention".

Optionally, clean up the dead `entry.id === "automations" && pending` count/title in ui/settings.tsx:59 and the `pending` at :52.

No docs change is needed: docs/automations.md already says Inbox is separate from Scheduling.

**Suggested regression test:** Add a case to test/e2e/simplification.e2e.ts (or settings.e2e.ts, which already opens the "Application menu").
- Setup: seed at least one attention run, e.g. a fake run left unseen with status failed/stopped (FAKE_CRASH_VENDOR=claude), or seed an unseen failed run record.
- Assert the sidebar link `Inbox, N need attention` shows the count.
- Open the "Application menu" and assert getByRole("menuitem", { name: "Scheduling", exact: true }) exists.
- Assert the item contains no `[aria-label$="need  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server: qa-server.sh start v4619k 4621 fake. I used my extra port because 4619 was held by another verifier's server (home v4617d), which I left alone. I made a throwaway git repo in scratchpad/qa/clones/v4619k-scratch, so no target project was touched. The first 6 plain solo runs ended "done" with an empty diff stat, so they did not count as inbox items. I then restarted my own server with FAKE_CRASH_VENDOR=claude exported and started 4 solo runs through POST /api/runs. All 4 ended "stopped" and unseen, which counts as "Blocked work".

Browser script work/v4619k/repro.mjs (fresh headless profile, http://127.0.0.1:4621), log work/v4619k/repro2.log:
- Sidebar Inbox: aria-label "Inbox, 4 need attention", count 4.
- Sidebar "Scheduling" link: no count.
- Footer "Application menu" button opened. The menu has no Inbox entry. Items: Settings, Agents & usage, Repository tools, Insights, "Scheduling 4", Notifications, ...
- The Scheduling badge has aria-label "4 runs need attention". The trigger "Code Flow 4" also counts these runs.
- Clicking Scheduling opens #/automations: heading Scheduling, tabs Run once later/Repeat/Process a backlog/Pursue a mission, "Repeating tasks and webhooks: None yet". There is no #inbox-title and none of the 4 runs appear.
- #/inbox shows "Review inbox 4" with all four runs.
- No console or 5xx errors.

Screenshots: shots/v4619k/001-appmenu-open.png (menu shows "Scheduling 4" while the sidebar Scheduling link has no count), 002-scheduling-page.png (Scheduling page with no inbox items), 003-inbox-page.png.

This matches the reporter's steps and result. Ruled out:
- Tester environment: reproduced on a fresh home and fresh browser profile.
- Selector error: confirmed by the screenshots.
- By design: docs/automations.md:12 says "Inbox is a separate sidebar destination", and docs/project-first-navigation-plan.md's Application menu spec lists "Scheduling across projects" with no attention count.

Cleanup: I deleted all 10 runs through the UI (Select runs > Select loaded > Delete... > Delete 10 runs), stopped server v4619k, and removed the scratch repo. Nothing is left over. Home dir scratchpad/qa/homes/v4619k remains, with no runs.

Side observation, not part of this issue: run deletion (src/engine.ts:3611 deleteRun) left the runs' worktrees and codeflow/* branches in place in the scratch repo.

</details>

### S09-7 · cosmetic · In the rail application menu, the Inbox attention count is shown as a badge on the 'Scheduling' item, so attention appears to belong to Scheduling.

Source: code-level suspect at `ui/rail.tsx:531` (confirmed hands-on).

**Repro**

> Fake s09 with one triage-pending automation run: open the rail footer 'Code Flow …' Application menu, read the Scheduling menuitem, click it, inspect the page (work/s09/06-rail-menu.mjs, shots/s09/001-s7-menu-open.png, 002-s7-scheduling-page.png).

**Expected:** The attention count belongs to the Inbox (which lists the pending review). Scheduling should carry no '1 runs need attention' badge, because the Scheduling page shows no attention items.

**Actual:** With one automation result pending review, the Application menu showed 'Scheduling 1' (aria-label '1 runs need attention'), and the menu has no Inbox entry. Clicking it opens #/automations (Run once later / Repeat / backlog / missions) with no review inbox and no Approve/Reject controls. The pending item is only under Inbox, which the rail nav already badges ('Inbox, 1 need attention').

**Root cause (verifier):** A leftover from earlier navigation. The menu item once opened Settings, then Automations (whose AutomationsView included the review inbox). PR #38 renamed it 'Scheduling' and routed it to SchedulingView, which no longer renders the inbox, but kept `pending` (inbox().length) as its badge.

**Suggested fix:** Remove the `pending` badge from the Scheduling menu item. Optionally add an 'Inbox' menu item carrying the count, matching the rail nav and the footer total.

**Suggested regression test:** UI test: with one pending triage run, open the Application menu and assert the Scheduling menuitem has no .rail-menu-meta count, and that the Inbox link/item shows 1.

### S14-7 · cosmetic · The Settings nav filters out the workspace, automations and insights entries, and the 'Tools & activity' group is not rendered. The 'automations' pending-count badge and title in the nav link can therefore never display (dead UI).

Source: code-level suspect at `ui/settings.tsx:54` (confirmed hands-on).

**Repro**

> Browser script nav.mjs on fake server s14: dumped the nav groups and items (listed above; screenshot shots/s14/001-settings-nav.png shows Scheduling only in the left rail). Opening #/settings/automations ended at hash #/automations with no .settings-section-heading. Searching 'schedule' and clicking the result went to #/automations. Static proof: the filter at ui/settings.tsx:54 excludes 'automations' before the `entry.id === "automations"` badge test.

**Expected:** No unreachable code paths. The pending badge belongs where Scheduling is actually linked (the rail, which already shows it).

**Actual:** The Settings nav shows Preferences (General, Agents & models, Run defaults, Notifications), Connections (Connections, Integrations) and Management (Projects, Extensions, Data & storage, Advanced), with no Scheduling link and therefore no badge. #/settings/automations redirects to #/automations with no settings heading. Settings search for 'schedule' → 'Scheduling' navigates to #/automations.

**Root cause (verifier):** The nav renders only the groups ['Preferences','Connections','Management'] and also filters out ids workspace, automations and insights, so `entry.id === "automations" && pending` inside the map can never be true. On top of that, parseRouteHash (ui/navigation.ts:33) redirects #/settings/{workspace,automations,insights} to standalone views, and SettingsView.go() does the same. As a result, SettingsView's `section === "workspace"/"insights"/"automations"` render branches (settings.tsx:74-76) and the 'settings-tools' class are also unreachable. No user-visible loss: the rail shows Scheduling and its own pending count (ui/rail.tsx:167).

**Suggested fix:** Remove the automations badge/title logic from the settings nav link, and the unreachable workspace/insights/automations branches and 'settings-tools' class from SettingsView. Keep those entries in SETTINGS_SECTIONS only for search and the command palette (or move them to a separate TOOL_DESTINATIONS list).

**Suggested regression test:** A unit test on SETTINGS_SECTIONS and parseRouteHash asserting that tool sections route to standalone views, plus an unused-code or lint check. Alternatively, a UI test asserting the settings nav has no Scheduling link while the rail Scheduling entry shows the inbox count.

### t00-14 · minor · Collapsed sidebar hides the Inbox count, and pressing '/' permanently un-collapses it

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-10.

**Repro**

> 1. Sidebar 'Collapse sidebar' with Inbox items present.
> 2. Look at the bell; then press '/' outside inputs and reload.

**Expected:** The collapsed rail keeps a visible Inbox badge; '/' expands temporarily or keeps the user's collapsed preference.

**Actual:** The bell has no badge (only aria-label 'Inbox, 6 need attention' and the app-menu badge). After '/', the rail stays expanded across reload (railCollapsed is saved as expanded).

**Root cause (verifier):** 1) Hidden badge. ui/rail.tsx:415 renders the Inbox link as `<Icon name="bell" /><span>Inbox</span>{pending ? <span class="count">{pending}</span> : null}`, so the count is a span child of .nav-item just like the label. ui/styles.css:3335, `.rail-collapsed .rail-destinations .nav-item > span { display: none; }`, was meant to hide the label but also matches span.count. No rule turns the count into a corner badge, unlike `.rail-collapsed .rail-menu-count { position:absolute; top:0; right:-3px }` at ui/styles.css:1896.
Also, ui/styles.css:3334-3335 sit outside the `@media (min-width: 761px)` block (ui/styles.css:1882-1898) that holds every other collapsed-rail rule. As a result, the desktop collapsed preference also strips the Inbox and Scheduling labels and the count from the full-width phone drawer.
2) '/' persistence. ui/app.tsx:420 (onShortcut, case "/") calls setRailCollapsed(false). ui/state.ts:61-64 writes store.set("railCollapsed", "0") on every call, so a temporary expansion to reveal #run-search overwrites the saved collapsed preference. The same persisting call is used by the collapsed search icon (ui/rail.tsx:418) and by "View and filter runs" (ui/rail.tsx:534).

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Badge:
- Give the label its own class in rail.tsx:415-416 (`<span class="nav-label">Inbox</span>`).
- Hide only `.nav-label` when collapsed.
- Show `.count` as a corner badge on the bell, matching the app-menu badge: `.rail-collapsed .rail-destinations .nav-item { position: relative }` and `.rail-collapsed .rail-destinations .count { position: absolute; top: 2px; right: 8px; margin: 0; min-width: 16px; font-size: 10px }`.
- Move the styles.css:3334-3335 rules inside the `@media (min-width: 761px)` block so the phone drawer always shows labels and counts.
- Keep the aria-label as it is.

'/' and the search icon:
- Add a non-persisting expansion. Either `setRailCollapsed(value, { persist = true })`, or a separate `railPeek` signal that the `.app` class and `collapsed` in rail.tsx read as `railCollapsed && !railPeek`.
- Use it in app.tsx:420, rail.tsx:418 and rail.tsx:534.
- Clear the peek when the search box loses focus or gets Escape with an empty query and no filters open. The rail the …

**Suggested regression test:** Add a test to test/e2e/ui.e2e.ts, for example "collapsed sidebar keeps the Inbox count and the collapsed preference":
- Use a fresh page with addInitScript setting localStorage railCollapsed="1", and make sure the fixture has at least one unseen failed run in the Inbox.
- At 1440x900, assert `.rail-destinations .count` isVisible(), its text matches /\d+/, and its boundingBox lies within nav.rail's 64px width.
- Click main and press "/". Assert #run-search is focused and the rail is wider than 64 …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode server, v4669x on port 4669 with a new home and a new browser profile. The server ran with FAKE_FAIL_VENDOR=claude. Through POST /api/runs I created four solo runs against a tiny scratch git repo in my scratchpad. All four ended failed and unseen, so reviewReason returns "failed" and the Inbox count is 4. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4669x/rail.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4669x/rail.log. Viewport 1440x900.
- E1, expanded: rail is 248px. `.rail-destinations .count` shows "4". The aria-label is "Inbox, 4 need attention".
- C1, after clicking "Collapse sidebar": rail is 64px and localStorage railCollapsed="1". The `.count` element is still in the DOM with text "4", but its computed display is none, so it is not visible. The app-menu badge (.rail-menu-count) is still visible in the corner with "4" ("4 items need attention"). The screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4669x/002-collapsed.png shows a bare bell with no count; only the bottom app-menu icon has a 4.
- C2, after reload: still 64px. The preference persists, as intended.
- S1: I clicked main (focus on MAIN#main-content) and pressed '/'. The rail went to 248px, #run-search got focus, and localStorage railCollapsed became "0".
- S2/S3: Escape left the rail at 248px. After reload it was still 248px and the toggle read "Collapse sidebar". The collapsed preference is lost.
- G1/G2, a parity check: clicking the collapsed rail's own search icon (.rail-search-button) does the same thing. It expands, focuses the search box and persists "0" across reload.
- P1, an extra finding: with railCollapsed="1" stored, I resized to 390x844 and opened the phone drawer ("Show runs"). The drawer is otherwise fully expanded, yet the Inbox and Scheduling labels and the Inbox count are display:none. Only bare bell and clock icons show (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4669x/003-phone-drawer.png).
- No console errors and no 5xx responses.

The reporter's environment did not cause this: I reproduced it on a fresh home with a fresh profile. It is not by design either. docs/automations.md:20 says "The **Inbox** count in …

</details>

### S01-2 · minor · In the collapsed sidebar, '.rail-destinations .nav-item > span {display:none}' also hides the Inbox '.count' badge.

Source: code-level suspect at `ui/styles.css:3335` (confirmed hands-on).

**Repro**

> Fake server s01: fire an automation so one run has triage pending (Inbox count = 1), then click 'Collapse sidebar'. Playwright: .rail-destinations a[href='#/inbox'] .count exists, but computed display is 'none' and it is not visible. aria-label is 'Inbox, 1 need attention'. Screenshot shots/s01/001-rail-collapsed.png: the bell icon has no badge. Correction to the claim: the count is not only in the aria-label. The app-menu avatar at the bottom still shows an aggregate badge '1' (unread + pending). That menu has no Inbox item, though; the number appears next to 'Scheduling'.

**Expected:** docs/automations.md: 'The Inbox count in the sidebar counts attention items across projects, so nothing waiting for you is out of sight.' The Inbox icon should keep a badge or dot when the sidebar is collapsed.

**Actual:** The Inbox destination shows no count while collapsed. The only visual cue is the aggregate badge on the app menu, which leads to a menu without Inbox.

**Root cause (verifier):** The Inbox link renders <span>Inbox</span> and <span class="count">N</span> as direct children (rail.tsx:415). The collapsed-rail rule meant to hide the text label also matches the count span. No collapsed-mode rule repositions the count, unlike .rail-collapsed .rail-menu-count at styles.css:1896.

**Suggested fix:** Change the selector to `.rail-collapsed .rail-destinations .nav-item > span:not(.count)`. Add `.rail-collapsed .rail-destinations .nav-item { position: relative }` and `.rail-collapsed .rail-destinations .count { position:absolute; top:2px; right:6px; }`, like .rail-menu-count. Alternatively give the label a class (.label) and hide only that.

**Suggested regression test:** e2e: with one pending inbox item, collapse the sidebar and assert `.rail-destinations a[href="#/inbox"] .count` is visible and shows '1'. Add it to the accessibility/visual suite in both themes.

### t25-5 · minor · Pressing '/' to search permanently un-collapses a collapsed sidebar

Source: tester unit usability-failure-cases-1; observed with fake-agents; features UX-04.

**Repro**

> 1. On a fresh fake server at 1440x900, click 'Collapse sidebar'.
> 2. Focus main and press '/'; the rail expands and search is focused.
> 3. Press Escape, then reload the page.

**Expected:** The sidebar returns to its collapsed state once search is left (or at least on reload), because the user chose to collapse it.

**Actual:** The rail stays expanded after Escape and after reload: localStorage railCollapsed becomes '0'. The user has to collapse it again after every quick search. The collapsed rail's search button (rail.tsx:418) behaves the same way.

**Root cause (verifier):** The temporary need to show the search box goes through the persisted preference setter.
- ui/state.ts:60-63: railCollapsed is read from localStorage, and setRailCollapsed(value) always writes store.set('railCollapsed', '0'|'1').
- ui/app.tsx:420, in the '/' case of onShortcut, calls setRailCollapsed(false). It was added in 636d2a3 so the hidden #run-search can be focused. This overwrites the saved choice, nothing re-collapses on Escape or blur, and it also runs at phone widths, where railOpen already handles visibility and collapse has no visual effect.
- ui/rail.tsx:418: the collapsed rail's 'Search runs' button does the same, setRailCollapsed(false) and then focuses #run-search.
- ui/rail.tsx:534: the 'View and filter runs' menu item also calls setRailCollapsed(false), so it has the same pattern.
- ui/styles.css:1882-1893: under min-width 761px, .rail-collapsed hides .rail-search, which is why the code expands the rail at all.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Separate a temporary 'peek' from the saved preference.
1. In ui/state.ts, add a non-persisted signal, railPeek = signal(false). Derive the shown state as railCollapsed.value && !railPeek.value, and use it for the .app class in ui/app.tsx:137, for `collapsed` in ui/rail.tsx:169, and in sideMaxWidth.
2. In the '/' handler (app.tsx:420), the rail Search button (rail.tsx:418) and 'View and filter runs' (rail.tsx:534), set railPeek.value = true instead of calling setRailCollapsed(false).
3. Clear railPeek when focus leaves the rail: a focusout handler on nav.rail where relatedTarget is outside the rail. Also clear it when a run is chosen from the results. Escape in #run-search already blurs, so it re-collapses.
4. The explicit 'Collapse/Expand sidebar' toggle keeps calling setRailCollapsed and also clears railPeek.
5. On phone widths (innerWidth <= 760), the '/' path should only set railOpen and must not touch the stored railCollapsed.
The search box keeps working, and the saved choice surv …

**Suggested regression test:** Add a Playwright test to test/e2e/ui.e2e.ts, next to 'insights and run search' at around line 481:
1. Open a fresh page at 1440x900, click 'Collapse sidebar', then press '/'.
2. Assert that #run-search is focused and visible.
3. Press Escape. Assert that .app has the class rail-collapsed again and localStorage.getItem('railCollapsed') === '1'.
4. Reload and assert the rail is still collapsed.
5. Repeat with a click on the collapsed rail's 'Search runs' button.
6. At 390x844 with railCollapsed='1 …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake server with a new home: qa-server.sh start v4675r 4675 fake. The browser was a fresh headless Chrome context at 1440x900 with no saved profile. The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4675r/repro.mjs and its output is in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4675r/repro.log. Each step records localStorage railCollapsed and the .app.rail-collapsed class:
A. Fresh load: store=null, expanded.
B. Clicked the 'Collapse sidebar' button: store='1', collapsed.
C. Focused main (#main-content), pressed '/': store='0', expanded, focus in #run-search.
D. Pressed Escape: store='0', still expanded.
E. Reloaded: store='0', expanded. Screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4675r/003-after-reload-slash.png shows the full sidebar.
F. Collapsed again (store='1'), then clicked the collapsed rail's 'Search runs' button: store='0', expanded. It stayed expanded after Escape and after a reload.
G. Control: collapsing and then reloading with nothing else touched keeps store='1' and the rail collapsed. So collapse itself persists, and the reset comes only from the search paths.
H. Extra finding: at 390px phone width the collapsed style does not apply (it sits inside @media (min-width: 761px)). Pressing '/' there still flipped store from '1' to '0', and going back to 1440px showed an expanded rail. So a quick search on a phone silently overwrites the desktop preference.
No console errors or 5xx responses. No runs were created, and the server is stopped.

Refutation attempts:
- No doc in docs/*.md says that searching should expand the sidebar for good. docs/runs.md:138 only says the sidebar 'has search (/)'.
- The tester's environment is not the cause: it reproduced with a fresh home and a fresh browser profile.
- The selector is not the cause: the bundled public/assets/chunk-TK6JP642.js contains the same case"/" code, qn(!1), as the source.
The expansion is deliberate, because the collapsed rail hides .rail-search with display:none. But commit 636d2a3 (#30) used the persisting setter, not a temporary expand, and nothing restores the user's choice. I rate it a UX defect, not by-design behaviour. Minor: it costs one click to re-collapse, with no data loss.

</details>



## Repair and independent verification — 2026-10-26

Worktree: `/private/tmp/codeflow-qa-continue/attention-counts`, branch `codex/qa-attention-counts`, based on integration `29e2c0c`. Cluster26's shared complete-count foundation (`fd9d378`, applied here as `ff12947`) and single sidebar watcher mount (`ddc6a1d`, applied here as `b504e2b`) are explicit dependencies. This cluster does not introduce another count endpoint or alter history cursor semantics.

### Per-issue outcome

| Issue | Outcome and evidence |
| --- | --- |
| t01-1 | Fixed. Both SSE hello builders use a separate initial attention selection which excludes the recent page and its related chats before spending the 100 older-item budget. Real review reasons precede plain unseen no-op results; all running work remains included. Complete authorized counts drive Inbox, application badge, unfiltered Needs you and tab title. With 106 recent unseen no-ops + 100 older failures + one even older approval, both real feeds return 200 distinct summaries: 100 recent, the question and 99 failures. The full totals are 207 attention tasks and 101 Inbox runs. The Inbox explicitly shows `Showing 100 of 101 review items`; paging reveals the remainder. The exact 106+100 case also verifies all 100 failures in the unit regression. |
| t00-12 | Fixed the two defects while retaining the documented distinction between Needs you and Inbox. Conversation result evidence now includes tracked working changes plus a NUL-delimited count of nonignored untracked files. A real fake Claude solo run leaves its branch at the original commit, yet its uncommitted file yields nonempty evidence and appears in Inbox; a fake Codex no-op has empty evidence and stays outside Inbox. Title counts chat families, matching Needs you: three provider/side chats in one family plus a second task count as two tasks. |
| t00-3 | Fixed. First-seen list/snapshot entries establish a silent baseline. Two actual browser loads of the older approval produce neither desktop Notification calls nor an aria-live announcement. A new pipeline approval after boot produces both, using a browser notification constructor recorder with granted permission. |
| S00-1 | Fixed through the same list-baseline rule. New tests cover hello, history, chat-family loading, an old team question and PR watch; live new approval, changed team question and completion still notify. |
| t01-14 | Fixed. The older-attention paging message requires an available history cursor and disappears after the final history page. A filtered query does not clear the global attention-truncated state. Inbox partial-history controls first clear sidebar filters when those filters prevent loading the missing review items. |
| t00-13 | Fixed. Application menu now includes Inbox with its complete Inbox count; Scheduling has no Inbox badge. Actual menu assertions verify both destinations. |
| t01-6 | Fixed by the same menu destination repair. Scheduling continues to open the standalone scheduling page. |
| S09-7 | Fixed by the same menu destination repair; aggregate application attention now has a matching Inbox destination. |
| S14-7 | Fixed. Removed unreachable Settings workspace/insights/automations render branches, automations badge/title logic, unused imports and obsolete settings-tools CSS. Search entries and legacy scheduling addresses still navigate to the standalone destination in the real browser. |
| t00-14 | Fixed. Collapsed navigation hides only destination labels; Inbox retains a visible corner badge capped visually at 99+ while its accessible label retains the complete count. Search expands via temporary state and preserves saved collapse preference `1`. Slash, search icon, Escape, reload and outside focus were exercised. |
| S01-2 | Fixed by label-specific desktop CSS and viewport-aware collapsed layout. At 390px the open drawer shows Inbox and Scheduling labels fully inside the viewport, even with a saved desktop collapse preference. |
| t25-5 | Fixed. Slash, the collapsed search icon and View and filter runs use temporary expansion; explicit Collapse/Expand remains the persisted preference. Browser tests also exercise focus transfer after replacing the search icon and closing the temporary view after focus moves outside. |

### Validation and evidence

New regression files:

- `test/qa-attention-counts.test.ts`: distinct older attention budget, all running items, related-chat exclusion, priority ordering, clean/changed/ignored/untracked working evidence (including a newline/Unicode raw Git filename).
- `test/qa-attention-counts-ui.test.ts`: snapshot baseline notifications versus live transitions, family counts, authoritative totals versus loaded subset, saved desktop preference versus temporary/phone layout.
- `test/e2e/qa-attention-counts.e2e.ts`: six real HTTP/server/Chrome scenarios reproducing the reported flows plus adjacent cases. Private temporary home/repository, fake providers, ephemeral localhost port; scratch state and server are cleaned up.

Checks:

- `npx tsc --noEmit` — passed.
- New regression files plus original `run-history-ui.test.ts` and `review-inbox.test.ts` — **16 passed**.
- Earlier broadened run adding original `run-storage.test.ts` and `server-reliability.test.ts` — **44 passed** (before the one additional complete-count UI assertion was added).
- Real server/browser regression — **6 passed**. No browser errors. Logs contain normal startup/shutdown and the expected Node SQLite experimental warning, with no application errors.
- `git diff --check` — passed.
- One final screenshot refresh hit a Chrome launch timeout before any scenario ran; only that test run’s identified processes were stopped. The retry passed all six scenarios, with mobile label bounds checked after drawer animation. The infrastructure-only timeout is retained in `/private/tmp/codeflow-qa-continue/attention25-browser-launch-timeout.log`.

Independent baseline worktree at `29e2c0c` reproduced failures before the repair: the real feed delivered **100 rather than 200** summaries, so the older approval was not visible; UI baseline tests emitted old approval/team/watch notifications and counted **4 rather than 2** attention families. Baseline logs are retained separately; this temporary worktree was then removed.

Evidence directory: `/private/tmp/codeflow-qa-continue/attention25-browser/` (partial/complete Inbox, collapsed badge, mobile destinations, silent snapshots, live approval and server log). Test logs: `/private/tmp/codeflow-qa-continue/attention25-browser-test.log`, `/private/tmp/codeflow-qa-continue/attention25-unit-api-test.log`, `/private/tmp/codeflow-qa-continue/attention25-final-unit.log`. Baseline evidence: `/private/tmp/codeflow-qa-continue/attention25-baseline-unit.log` and `/private/tmp/codeflow-qa-continue/attention25-baseline-browser-test.log`.

### Boundaries and remaining limitations

No unresolved cluster25 defect remains in these scenarios. The initial feed remains intentionally bounded, so more than 100 older attention items still require history paging; authoritative totals and loaded-of-total Inbox text make that explicit. The prioritized initial set has no chronological `attentionNextCursor`; chronological history and `attentionPage` cursors are unchanged. Needs you counts task families (including unseen no-op results), while Inbox counts review-worthy runs, so those two numbers are intentionally not identical. Cluster26 owns the shared count endpoint/watcher and the global count-unavailable footer. No live4317/4318, live repository build, home data, real agents, remote changes, pushes or PRs were used.

### Final summary-before-payload routing follow-through

`f88b0f0` repairs a confirmed cross-stream race: the rail now uses a running chat’s authoritative `approvalPending` summary before the separate approval payload arrives, retaining the older-host payload fallback. A new deterministic Chrome case fails before and passes after the fix; all 16 original daily cases and 11 related checks pass. [Evidence](../final-pending-approval-routing.md) and [independent review](../final-pending-routing-review.md).
