# Cluster 18 · missions-ui

**Project missions UI: stale edit overwrite, one-click dismiss/archive, budget inputs, refused actions**

Status: **fixed and verified on continuation branch · integrated into `codex/dogfood-qa-continue`** · 11 issues · branch `codex/qa-missions-continue`

Planner notes: All in ui/project-teams.tsx unless noted. t12-1: TeamForm submit sends the live team.revision, not the revision the form was opened with, so a stale form overwrites another tab's change. Capture the revision when the form opens. t12-4/S09-2: 'Dismiss opportunity' posts reject with no confirmation and discards a verified draft. t12-18/S06-1: 'Archive mission' is immediate and cannot be undone; add confirmAction and fix the archived card's labels. t12-12/S06-2: the budget inputs allow min=1 with no max, while validateMission enforces narrower ranges; share the ranges (src/project-team-budget.ts). t12-9: the inbox card says '0 verified drafts' when only blocked items exist. t12-15: controls offer actions the server always refuses. t12-23: the assign form shows two repository selectors. t12-22: storage fault alerts need the path and repair guidance, and one damaged mission must not block mission creation for every repo (src/project-teams-api.ts, project-team-store.ts). Schedule edits in TeamForm (t12-5) are fixed in schedule-editor-tz. Duplicate groups: [["t12-4","S09-2"],["t12-12","S06-2"],["t12-18","S06-1"]]

Likely files: `ui/project-teams.tsx`, `src/project-team-model.ts`, `src/project-team-budget.ts`, `src/project-teams-api.ts`, `src/project-team-store.ts`, `src/project-teams.ts`, `src/repository-identity.ts`

## Continuation verification (2026-10-26)

Completed the interrupted implementation on `codex/qa-missions-continue`. Preserved cluster 13's embedded schedule editor, timezone fallback and `zoneRequired` while resolving the UI merge. Removed an unrelated WIP heuristic that accepted repository identities from any device number within ±1024; ownership still requires the exact verified Git metadata identity, with a regression for a different volume sharing path/inode.

Validation: `npx tsc --noEmit`; `test/qa-missions-ui.test.ts` (9 passing); `test/e2e/qa-missions-ui.e2e.ts` (6 passing scenarios). The browser suite builds this worktree and starts its own server on 127.0.0.1:4359/4360 with a temporary home, fake agents and scratch Git repositories. It creates/activates missions, runs real application cycles with fake providers, exercises two connected browser pages, confirms/cancels rejection and archive, validates all six input bounds, tests missing-check/pending-result/high-risk admission feedback, checks blocked-only inbox counts and new reusable assignments, then restarts after deliberate corruption of its own record/settings files. No application console/page errors or HTTP 5xx. An initial test captured expected disconnected stream/network errors during deliberate restarts; the final fixture navigates away before those storage-only restarts, rather than suppressing arbitrary console errors.

After the engine merge, the combined mission service suites passed 63/63 and both new Chrome suites passed 12/12; TypeScript still passed.

Screenshots, browser error log and server log: `output/playwright/qa-missions-ui/` in the continuation worktree (generated, not committed). No real-agent claims. All fixture servers and temporary repositories are removed by test teardown.

## Issues

### t12-1 · major · Stale 'Edit mission' form silently overwrites another tab's mission changes (no revision conflict)

**Continuation outcome:** Fixed. The editor retains the opened mission and revision, detects streamed changes, disables stale saves and offers Reload form. The two-page browser regression preserves maxLines=401 and does not accept the stale name.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-07.

**Repro**

> 1. Fresh QA server (fake), enable project missions, create and activate a mission on a scratch clone.
> 2. Browser B: open #/project/<id>/automation/missions and click 'Edit mission' (leave the form open).
> 3. Browser A: click 'Edit mission', open 'Schedule, budget and scope limits', set 'Maximum changed lines' 400→401, then Save mission. The API shows maxLines 401 and missionRevision N+1.
> 4. Browser B: change only 'Mission name', then Save mission.

**Expected:** B's save is rejected with 409 'This team changed. Reload before acting.' (the documented revision CAS), or B's form refreshes to the new values.

**Actual:** B's save succeeds. maxLines reverts to 400, missionRevision becomes N+2, and no alert is shown. This happened twice: maxFiles 9→8 (s30.log) and maxLines 401→400 (s31). Because it counts as a policy change, any ready results are invalidated again.

**Root cause (verifier):** ui/project-teams.tsx:76 (`TeamForm` submit) sends `revision: team.revision`. Here `team` is the live prop.
- Lines 74-75 copy every field (name, mission, maxFiles, maxLines, budget, trust, schedule and the rest) into `useState` once, when the form mounts.
- The parent `ProjectTeamsPanel` (line 34) keeps replacing `data.teams` from `project-teams:<id>` stream snapshots, and also calls `load()` on every window `focus` event.
- `TeamCard` (line 126) renders `<TeamForm team={t} …/>` without a key tied to the revision, so the form keeps its stale field values while `team.revision` moves forward.

When the user saves, the full stale mission is sent with the newest revision. `ProjectTeamStore.change` (src/project-team-store.ts:116, `expected !== team.revision`) therefore passes, and the update overwrites the other tab's changes. Because the whole mission object is replaced, a change in limits counts as a policy change: it bumps missionRevision and blocks ready results again. Even with the stream down, focusing the window refreshes the prop and has the same effect, so the conflict check only protects a tab that never receives an update.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-teams.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/project-teams.md`

**Suggested fix:** In `TeamForm`, record the revision the form was opened from and send that, never the live prop:
- Add `const [baseRevision, setBaseRevision] = useState(team?.revision)` and send `revision: baseRevision` in submit (line 76).
- When a save gets a 409, keep the user's draft and show the server message.
- When `team.revision !== baseRevision` (an update arrived through the stream or a focus refresh), show an inline notice such as "This mission changed elsewhere". Offer two buttons: "Reload form", which re-initialises the fields from `team` and sets `baseRevision = team.revision`, and "Keep editing". Saving should be refused until the user chooses, or it should 409.
- This matches the board-task behaviour described in docs/team-collaboration.md:124.
- Optionally, send only the changed fields, or have the server reject a mission body whose base missionRevision is stale.
- Audit the other places that send `team.revision` from a live prop while holding local state: `OwnerTaskForm` (line 140) b …

**Suggested regression test:** Add a test in test/e2e/project-teams.e2e.ts named "a stale Edit mission form is refused, not saved over another tab's change":
1. Create and activate a mission.
2. Open the missions view in two pages, with the stream left connected. In tab B, click "Edit mission".
3. In tab A, open "Edit mission", set "Maximum changed lines" to 401 and save.
4. Wait until tab B's header shows the new mission number (the stream has delivered the snapshot).
5. In tab B, change "Mission name" and click "Save missio …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4653 on port 4653. The old v4653 home is kept at homes/v4653-prev-*. The project-teams records copied in from ~/.codeflow were faulted ("Repository metadata was replaced") and blocked team creation, so I moved them to project-teams.copied-aside and restarted. I made a scratch bare clone and working clone of MQTT-MCP. Script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4653/t12-1/setup.mjs then did everything through the UI: "Open another repository" added the clone as project "v4653 MQTT" (p-a0ea423e), then I clicked "Enable project missions" and "Create a mission", filled the form, clicked "Save draft mission" and "Activate". The team was pt-861456dbbe89f471f85ae880: rev 2, missionRev 1, maxLines 400.

Script .../t12-1/stale.mjs then used two separate browsers, A with a persistent profile and B with a fresh one:
1. B clicked "Edit mission" and left the form open. Its "Maximum changed lines" field showed 400.
2. A clicked "Edit mission", opened "Schedule, budget and scope limits", changed "Maximum changed lines" from 400 to 401 and saved. The API then showed rev 3, missionRev 2, maxLines 401.
3. B's card header updated to "mission 2" through the stream, but B's open form still showed 400.
4. B changed only "Mission name" and clicked "Save mission".
   - B's request sent `revision: 3` (the current one) with `maxLines: 400`. The server returned 200.
   - The team became rev 4, missionRev 3, maxLines 400, so A's change was lost.
   - B showed no alert and no toast, and the form closed.
   - Log: .../t12-1/stale-live.log. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4653/001-stale-live.png

Control run (`node stale.mjs p-a0ea423e nostream`): same steps, but B's /api/stream was blocked, so its team prop stayed old. B sent `revision: 4`, the server answered 409 "This team changed. Reload before acting.", the alert appeared and maxLines stayed 401 (log: .../t12-1/stale-nostream.log). So the server check works; the client is what defeats it.

Why this is not by design:
- docs/project-teams.md:87 says team edits "require the current revision"; "acting on a stale revision returns a conflict."
- docs/project-teams.md:63 says changing execution policy invalidates ready results.

It is not caused by the tester's environment either: it reproduces with two fresh, in …

</details>

### t12-4 · major · 'Dismiss opportunity' in Project briefing permanently rejects a verified draft with one click, no confirmation

**Continuation outcome:** Fixed. Briefing rejection names the consequence and requires confirmation; full-card result rejection also confirms. Browser Cancel preserves ready/approvable state; Confirm records rejection.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-14.

**Repro**

> 1. A mission produces a ready result; PROJECT BRIEFING shows a 'Verified draft' card.
> 2. Click 'Dismiss opportunity'.

**Expected:** 'Dismiss' hides the card, or a confirmation explains that it rejects the verified result and suppresses the problem from future discovery.

**Actual:** No dialog appears. The opportunity becomes 'rejected' (note 'Dismissed from the project briefing') and can no longer be approved, merged or opened as a PR (the shipping guard needs accepted). The problem key is suppressed from rediscovery, so recovering needs a paid revision. Reproduced twice (MQTT2 'Clarify empty input', MQTT 'Task four').

**Root cause (verifier):** ui/project-teams.tsx:191: ProjectBriefing's dismiss() posts {action:"reject", note:"Dismissed from the project briefing"} to /api/project-teams/:id/opportunities/:oid right away. It never calls confirmAction (ui/confirm-state.ts), which the app uses elsewhere, and it never checks whether the opportunity is a 'ready' verified result. The button at :192 is a ghost 'Dismiss opportunity' sitting next to 'Try and review draft', and nothing in the UI says the action is a rejection.

On the server, src/project-teams.ts:368 sets status 'rejected'. After that, :356 allows approve only from 'ready'. shippingGuard at :246 requires 'accepted', so merge and PR are refused. Discovery dedupe at :315 skips any candidate whose key matches a non-expired opportunity, including rejected ones, so the problem is never rediscovered. No action restores a rejected result to 'ready', so recovery needs 'revise', which is a new paid implementation cycle.

The full-card 'Reject' button at ui/project-teams.tsx:173 has the same one-click behaviour on ready results. It is at least labelled 'Reject'.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/application-improvements.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/experience.e2e.ts`

**Suggested fix:** 1. In ProjectBriefing.dismiss (ui/project-teams.tsx:191), import confirmAction from ./confirm-state.js and await it before posting. Use danger:true and wording that changes with status. For 'ready' or 'accepted': title 'Reject this verified draft?', body explaining that the reviewed result can no longer be approved, merged or opened as a PR, that its run and branch are kept, that the team will not propose this problem again, and that getting it back needs a new paid revision; confirmLabel 'Reject draft'. For proposals: 'Reject this proposal?' with the suppression note.
2. Rename the briefing button to 'Reject…' or 'Not interested…', or give it a title/aria-describedby, so the label matches what it does.
3. After success, show a toast ('Rejected · the team won't propose this again'), since the card disappears without a trace.
4. Apply the same confirmation to the Opportunity card's 'Reject' button (ui/project-teams.tsx:173) when o.result exists. This matches ui/automations.tsx:228.
5. O …

**Suggested regression test:** Add a test to test/e2e/experience.e2e.ts, or a project-missions e2e, using the fake fixture from this reproduction (README quote, check.mjs, prove:false, build-within-scope mission). Drive one cycle to a 'ready' opportunity, open the Project briefing and click 'Dismiss opportunity'. Assert that page.locator('dialog.confirmation-dialog[open]') becomes visible and its text mentions rejecting the verified result. Click 'Cancel' and assert via GET /api/project-teams/:id that the opportunity is still …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4659d on 127.0.0.1:4659. Before starting I seeded the home with only projects.json, so qa-server.sh did not copy the user's active project-teams. Fixture: a scratch bare clone plus a working clone of MQTT-MCP. Its committed fixture adds the README line 'Empty input is valid.' (the fake discovery quotes it), check.mjs (exit 0) and .codeflow/config.json {"prove":false}. Without that config the fake implementation is blocked as 'Not proven', which is a fixture artefact unrelated to this issue.

Steps in the UI (scripts in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4659d/):
1. a2-setup.mjs: added the clone with 'Open another repository' as project 'v4659d MQTT2', enabled project missions, created a mission (build-within-scope, check 'node check.mjs', paths *), clicked Activate, then 'Run cycle now'. After 4.5 s the cycle completed and opportunity po-9bd7d195… was 'ready' with result run 2610252037-5454b2a7. PROJECT BRIEFING showed a 'Verified draft' card with 'Try and review draft' and 'Dismiss opportunity' (shots/v4659d/001-briefing-before-dismiss.png).
2. b1-dismiss.mjs: clicked 'Dismiss opportunity'. The reporter only listened for native dialogs (page.on('dialog')), but the app uses an in-app <dialog class=confirmation-dialog> through confirmAction. So I also polled for dialog[open], [role=dialog] and [role=alertdialog] at +50, +300 and +1000 ms. Result: no native or in-app dialog. Status was already 'rejected' at +50 ms, with reason 'Dismissed from the project briefing' and decision {action:'reject'}. The briefing switched to 'No new opportunities to review' with no toast and no undo (002-briefing-after-dismiss.png). The team-details card now shows only Request revision, Defer one week and Reject; there is no Approve button. The approve API returns 400 'Only a verified ready result can be approved'. Inbox actionable count went to 0.
3. Merge via POST /api/runs/2610252037-5454b2a7/merge (scratch clone only) returned 'Approve this exact result in its standing team before publishing or merging'. Scratch main was unchanged. In the run page UI, 'Merge into main' was disabled until validation.
4. b2-after.mjs: 'Run cycle now' again. The cycle ended 'no-op', 'No new evidence-backed opportunities': the dismissed problem key 'document-empty-input' is suppressed. The only route back to a shippable result is 'Request revision', a new implementation run with a fresh …

</details>

### S09-2 · minor · Project briefing 'Dismiss opportunity' sends action 'reject' with no confirmation; this suppresses the problem in later discovery and discards a verified ready draft with one click.

**Continuation outcome:** Duplicate of t12-4; covered by the same confirmation and browser regression.

Source: code-level suspect at `ui/project-teams.tsx:191` (confirmed hands-on).

**Repro**

> Fake-mode s09: scratch repo with README 'Empty input is valid.', mission build-within-scope, check 'node --test'. Activate, then Run cycle now; the cycle completes with ready opportunity 'Clarify empty input' (work/s09/03-run-cycle.mjs). On the Project briefing click 'Dismiss opportunity' (work/s09/04-dismiss.mjs, shots/s09/002-s2-opportunity-card.png). Approve via API afterwards returns 400.

**Expected:** A one-click 'Dismiss' on a 'Verified draft' should not make an approvable, verified commit unapprovable without a confirmation or undo. The automation inbox's Reject asks 'Reject this result?' first.

**Actual:** One click and no dialog (no native or in-app dialog appeared). The opportunity became 'rejected' with reason 'Dismissed from the project briefing'. The mission card now offers only Request revision/Defer/Reject (no 'Approve this commit'). POST action=approve returns 400 'Only a verified ready result can be approved'. The only way back is Request revision, which clears the result and rebuilds with a fresh 16-call/45-min allocation.

**Root cause (verifier):** ProjectBriefing.dismiss posts {action:'reject'} directly, with no confirmAction. ProjectTeams.decide only approves from status 'ready', and there is no reopen path, so rejecting a ready result loses its approvability. Rejection with discovery suppression is documented as intended (docs/application-improvements.md:282, docs/project-teams.md:60). What is wrong is the unconfirmed, irreversible loss of a verified draft behind a 'Dismiss' label.

**Suggested fix:** Use confirmAction when the opportunity is ready or has a result, saying that the verified draft can no longer be approved and the problem will be suppressed. Consider labelling it 'Reject'. Optionally add a 'reopen' decision that restores 'ready' while the result digest still verifies.

**Suggested regression test:** UI test: clicking 'Dismiss opportunity' on a ready draft opens a confirm dialog, and Cancel leaves status 'ready' with no decision recorded. Service test (if reopen is added): reject then reopen restores 'ready' for an unchanged verified HEAD.

### t12-9 · minor · Opportunities inbox card counts '0 verified drafts · 0 proposals' when only blocked items exist

**Continuation outcome:** Fixed. Shared inbox summary includes blocked opportunities and correct singular/plural wording; the browser checks a real blocked fake-provider cycle shows “1 needs attention”.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-15.

**Repro**

> 1. A mission whose only actionable opportunities are blocked (e.g. owner tasks stopped or failed).
> 2. Open the project Overview or the global Inbox.

**Expected:** The card counts blocked items ('N need attention'), or is not shown.

**Actual:** The card 'Project team opportunities' shows '0 verified drafts · 0 proposals' with a Review button (for MQTT, IC and Product mission). Grammar: '1 verified drafts'.

**Root cause (verifier):** ui/project-teams.tsx:182 builds the card's `actionable` list from teams where `t.opportunities.some((o) => ["proposed", "ready", "blocked"].includes(o.status))` or the last cycle is "unknown". So a team whose only open items are blocked still gets a card.

ui/project-teams.tsx:184 then prints only `${ready.length} verified drafts · ${proposed.length} proposals`. Blocked opportunities are never counted or named, so a card whose only items are blocked reads "0 verified drafts · 0 proposals" next to a "Review opportunities" button. The numbers are also pasted in without singular/plural handling, giving "1 verified drafts" and "1 proposals".

Where blocked items come from (src/project-teams.ts):
- line 402: Stop cycle
- line 327: a gate or verification failure
- line 344: a build that throws
- line 145: a mission policy change
- line 281: the project losing the repository

The project page's ProjectBriefing (ui/project-teams.tsx:188) already includes blocked items. Only the compact inbox summary leaves them out.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-teams.e2e.ts`

**Suggested fix:** Move the card's summary into a small pure helper in ui/project-teams.tsx or a new ui/project-team-inbox.ts, for example `projectTeamInboxSummary(team): string`. It should:
- count ready, proposed and blocked separately;
- print only the parts that are not zero, joined with " · ";
- use a plural helper like the one in ui/projects.tsx:37: "1 verified draft" / "2 verified drafts", "1 proposal", "1 needs attention" / "2 need attention" (or "N blocked");
- keep the " · launch needs reconciliation" suffix.

Build the `actionable` filter and the counts from the same status list so they cannot drift apart again.

Optional: if blocked items should not be treated as actionable at all, drop "blocked" from line 182 instead. However, a stopped or failed owner task needs an owner decision (revise or reject), so counting it is the better fix.

**Suggested regression test:** 1. Unit test, new file test/project-team-inbox.test.ts, run with `npx tsx --test` on the extracted helper. Assert that:
   - a team with one blocked opportunity gives "1 needs attention" and does not contain "0 verified drafts";
   - 1 ready + 2 blocked gives "1 verified draft · 2 need attention";
   - 2 proposed gives "2 proposals";
   - a team with an unknown last cycle and no opportunities gives only "Launch needs reconciliation".
2. Browser test, test/e2e/project-teams.e2e.ts: after giving a …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4669t129 on port 4669. Its home held only projects.json and no copied project-teams. I made a throwaway 1-commit git repo in the scratch clones folder with check.mjs, README.md and index.mjs. Everything below was done through the UI with Playwright; the scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4669t129/.

1. Setup (s01-setup.mjs):
   - "Open another repository", then New project "v4669 demo" (p-3619e073).
   - Automation > Missions: Enable project missions, Create a mission.
   - Mission settings: check "node check.mjs", "Run recurring discovery" unchecked (manual tasks only), coordinator claude.
   - Save draft mission, then Activate.
2. Stopped task (s02-block.mjs):
   - "Give team a task" (Document add(), docs). Once the cycle was building, I clicked "Stop cycle".
   - API state: cycle cancelled; opportunity status=blocked with reason "Implementation stopped by owner; request a new bounded revision to continue".
   - Project Overview card text: "Project team opportunities | v4669 demo mission | 0 verified drafts · 0 proposals | Review opportunities".
   - Global Inbox (#/inbox) showed the same card text. The Review inbox panel underneath said "Nothing to review".
   - Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4669t129/001-overview-card.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4669t129/002-inbox-card.png.
3. Failed task: I gave a second task, "Add usage example". Under fake agents its cycle ended blocked with "The implementation lacks required checks and independent review at its final commit"; the run's events show fail-to-pass proof was unproven. With 2 blocked items the card still read "0 verified drafts · 0 proposals".
4. Grammar (s04-ready.mjs):
   - Edit mission: check changed to "test -f claude-alpha.txt". Then I gave the task "Add alpha marker", which became ready.
   - Overview and Inbox both read "1 verified drafts · 0 proposals". The 2 blocked items were not mentioned at all.
   - Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4669t129/001-inbox-card-ready.png.

No console errors or 5xx responses.

Trying to refute it:
- Not by design: docs/p …

</details>

### t12-12 · minor · Mission budget inputs allow values the server rejects (min=1, no max), errors only after submit

**Continuation outcome:** Fixed. UI and server share all six budget ranges; the browser rejects both out-of-range boundaries and proves an invalid submission sends no POST.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-02.

**Repro**

> Create a mission > Schedule, budget and scope limits > Calls per discovery 3 (or 500) > Save draft mission.

**Expected:** Inputs carry the server ranges (discovery calls 8–40, minutes 1–60, build calls 4–80, build minutes 1–120, weekly calls 4–500, weekly minutes 1–1440).

**Actual:** Native validation passes. The server returns 'Invalid discovery calls: use 8–40', one field at a time (3, 500 and weekly minutes 5000 tried).

**Root cause (verifier):** ui/project-teams.tsx:96 renders all six budget inputs from one map with a hard-coded `min={1}` and no `max`:

`<input class="field" type="number" min={1} value={advanced.budget[field]} .../>`

The authoritative ranges live only in the server validator at src/project-team-model.ts:103:
- discoveryCalls 8–40
- discoveryMinutes 1–60
- buildCalls 4–80
- buildMinutes 1–120
- weeklyCalls 4–500
- weeklyMinutes 1–1440

Errors come from `integer()` at src/project-team-model.ts:26, which throws on the first bad field, so the user learns about one field per round-trip.

There is no shared constant, and the UI cannot import runtime values from project-team-model.ts because it imports node:crypto and node:path. The ranges therefore drifted. The submit handler (ui/project-teams.tsx:76) clears `error` only when onSubmit fires, so a stale server alert stays visible when native validation later blocks a submit.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-team-budget.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-team-model.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-teams.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`

**Suggested fix:** Put a single source of truth in the browser-safe module src/project-team-budget.ts. It is already imported at runtime by the UI (ui/project-teams.tsx:11) and imports only types:

`export const PROJECT_TEAM_BUDGET_RANGES = { discoveryCalls: { min: 8, max: 40, default: 8 }, discoveryMinutes: { min: 1, max: 60, default: 15 }, buildCalls: { min: 4, max: 80, default: 16 }, buildMinutes: { min: 1, max: 120, default: 45 }, weeklyCalls: { min: 4, max: 500, default: 48 }, weeklyMinutes: { min: 1, max: 1440, default: 120 } } as const`

Then:
1. Rewrite src/project-team-model.ts:103 to build the budget by iterating this constant. The labels/error text stay the same ("discovery calls", …).
2. In ui/project-teams.tsx:96, set `min={R[field].min} max={R[field].max} step={1} required` from the constant, and seed the default budget at line 75 from `.default`. Native validation then blocks out-of-range values on the right field before any request.
3. Optionally show the range in each label (e.g. "Calls  …

**Suggested regression test:** 1. Unit, test/project-teams.test.ts (or project-team-budget.test.ts): for each key in PROJECT_TEAM_BUDGET_RANGES, assert validateMission accepts min and max, and rejects min-1 and max+1 with /Invalid .*: use {min}–{max}/. This ties server behaviour to the shared constant.
2. Browser, test/e2e/project-teams.e2e.ts, in the create-mission test after opening "Schedule, budget and scope limits":
   - Assert each budget input's min/max attributes equal the constant (e.g. `getByLabel("Calls per discove …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4675 on port 4675 with a new home (the old v4675 home was moved aside to homes/v4675-prev-214149). Made a scratch clone of MQTT-MCP (clones/v4675-mqtt), added it through the UI (Open another repository > new project "v4675 mqtt", p-8af21451), clicked Enable project missions, then Create a mission. Filled Mission, Intended users and Required check command, and opened "Schedule, budget and scope limits". Script: scratchpad/qa/work/v4675/r1.mjs, log r1.log.

1) DOM inspection: all six budget inputs (Calls/Minutes per discovery, per implementation, per rolling week) have min="1" and no max attribute. The sibling inputs do have both: Maximum changed files 1–100, Maximum changed lines 1–10000, Rescan days 1–90.

2) For each out-of-range value, checkValidity() passed on every field, the form POSTed /api/project-teams, and the server returned 400. The error then appeared as a single role=alert line under the form:
- discovery calls 3 and 500: "Invalid discovery calls: use 8–40"
- discovery minutes 61: "use 1–60"
- build calls 2: "use 4–80"
- build minutes 121: "use 1–120"
- weekly calls 1: "use 4–500"
- weekly minutes 5000: "use 1–1440"
No team was created.

3) Control: discovery calls 0 is blocked natively ("Value must be greater than or equal to 1."), so native validation does work wherever attributes exist. Side observation: the earlier "Invalid weekly minutes" alert stayed on screen, because onSubmit never runs and so never clears `error`.

4) Boundaries (r2.mjs): 41 returns 400; discovery calls 40 with weekly minutes 1440 returns 201 and saves a draft with those values. The server ranges are exactly as reported.

Refutation attempts:
- Not by design. docs/project-teams-implementation-plan.md:23 says discovery requires at least eight allocated calls, so the server range is intentional and the UI simply does not reflect it.
- Not caused by the reporter's script. I reproduced it with my own selectors, and the DOM attributes prove it without any submit.

Environmental note (unrelated to this issue): a fresh QA home copies ~/.codeflow/project-teams, and those records report faults ("Repository metadata was replaced"). That makes any valid create fail with "Repair damaged team records…". I moved the copies aside inside my own QA home only (homes/v4675/copied-teams-aside) before step 4.

Cleanup: server stopped, ports 4675/4676 free, no runs or worktrees created, scratch clones removed. The leftover draft mission exists only in the stopped …

</details>

### S06-2 · cosmetic · Mission budget inputs use min=1 with no max, while validateMission enforces narrower ranges. Invalid values are only reported by the server after submit.

**Continuation outcome:** Duplicate of t12-12; same shared ranges and browser/native-validation coverage.

Source: code-level suspect at `ui/project-teams.tsx:96` (confirmed hands-on).

**Repro**

> Fake QA server s06, script work/s06/mission-budget.mjs. Create a mission > open 'Schedule, budget and scope limits' > set 'Calls per discovery'=2 and 'Minutes per rolling week'=5000. Native validity was true for both, and the attributes were min=1, max=null. Save showed 'Invalid discovery calls: use 8–40' below the form, far from the field (shots/s06/002-budget-error-1.png). Fixing that field and saving again showed a second error, 'Invalid weekly minutes: use 1–1440'. Each mistake costs a round trip and only one is reported at a time. Nothing was saved (teams=0).

**Expected:** Inputs carry the server's ranges (min/max), so the browser flags invalid values next to the field before submit, or the labels state the allowed range.

**Actual:** Values like 2 or 5000 pass client validation. The server reports one range error at a time, in a single alert at the bottom of a long form.

**Root cause (verifier):** The six budget inputs are rendered with `type=number min={1}` and no max. validateMission enforces discoveryCalls 8-40, discoveryMinutes 1-60, buildCalls 4-80, buildMinutes 1-120, weeklyCalls 4-500 and weeklyMinutes 1-1440 (src/project-team-model.ts:103). The adjacent maxFiles/maxLines/rescanDays inputs do carry matching min/max attributes, so the form is inconsistent.

**Suggested fix:** Export the budget bounds from project-team-model.ts, for example `BUDGET_LIMITS = { discoveryCalls: [8, 40], ... }`, use them in validateMission, and render `min`/`max` (and optionally a range hint) on each input from the same table.

**Suggested regression test:** Unit: each budget input's min/max attributes equal BUDGET_LIMITS, and validateMission accepts the bounds and rejects bound±1. Browser: entering 2 in 'Calls per discovery' makes the input :invalid and no POST is sent.

### t12-15 · minor · Mission controls offer actions the server always refuses (refusals appear only after filling forms)

**Continuation outcome:** Fixed. Shared task/build admission checks explain missing checks, pending work and policy refusals. Existing ownership disables new creation; risky work offers Give as a task. Owner tasks can be explicitly rebuilt against a moved base. Unit and browser scenarios cover these paths.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-11, MIS-12, MIS-02.

**Repro**

> (a) Mission with 2 pending results: 'Give team a task' is enabled; fill and submit gives 'Review pending work before assigning another task'. (b) Propose mission without a check: same, 'Configure a required verification check'. (c) Repo already has a mission: 'Create a mission' is enabled; fill and submit gives 409. (d) High-risk proposal, or a blocked owner task after the base moved: 'Build proposal' gives 'Opportunity is stale or outside policy. Update the mission if needed and discover again.' (owner tasks cannot be rediscovered).

**Expected:** Buttons are disabled with an explanation, or the action is offered in a form that can succeed (e.g. 'Give the task again').

**Actual:** The full form is filled, then refused. The guidance in (d) does not apply to owner tasks.

**Root cause (verifier):** The UI enable conditions don't include the server's admission rules. The server refusals themselves are intended (docs/project-teams.md:21-23 and :57), but no doc says the controls should stay enabled. The card already explains a disabled state up front for budget (ui/project-teams.tsx:119), so the missing explanations are an inconsistency, not a design choice.
(a, b) ui/project-teams.tsx:122: "Give team a task" is disabled only on busy, !enabled, a running cycle, status !== "active" or !taskBudgetAvailable. The server also refuses at src/project-teams.ts:381 (pending(t) >= PT_LIMITS.pending (2) or openOpportunities(t) >= 12, helpers at src/project-teams.ts:34-35). It refuses again at src/project-teams.ts:387: assignTask runs candidateProblem, and src/project-team-model.ts:166 returns "Configure a required verification check" for proposals-only missions without a check.
(c) ui/project-teams.tsx:45: "Create a mission" checks only data.enabled, autoTeamEnabled and repos.length. TeamForm (ui/project-teams.tsx:79) lists every project repo, including ones already owned. The store rejects at src/project-team-store.ts:106 with a 409. AssignmentForm (ui/project-teams.tsx:62) already detect …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-team-model.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/project-teams.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-teams.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`

**Suggested fix:** 1) Move pending() and openOpportunities() from src/project-teams.ts:34-35 into src/project-team-model.ts. Add a shared taskAdmissionProblem(team) that returns the first refusal reason or undefined, covering: not active, active cycle, pending or open limits, no required check, insufficient allowance. Use it in assignTask. In TeamCard, disable "Give team a task" and show the reason as help text, the same way the budget hint at ui/project-teams.tsx:119 works.
2) Add an ownership map (repo -> owning mission name, non-archived, across all projects) to the GET /api/project-teams inventory. In TeamForm, filter the repository options to unowned repos. Disable "Create a mission" with "This repository already has a mission (<name>); edit it below" when no repo is free.
3) In Opportunity, compute buildProblem client-side: candidateProblem(o, team.mission) (already exported from src/project-team-model.ts) plus the pending and active checks. Disable Build with that reason. For high-risk or out-of-p …

**Suggested regression test:** test/e2e/project-teams.e2e.ts: (1) A proposals-only mission without a check: assert getByRole("button", {name: "Give team a task"}).isEnabled() === false and the help text contains "Configure a required verification check". (2) After two ready owner tasks (fake mode, .codeflow/config.json {"prove": false}): Give task disabled with "Review pending work". (3) A project whose only repo already has a mission: "Create a mission" disabled, or the repo absent from the Repository options. (4) A PT-HIGH- …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server "v4681mc" on 127.0.0.1:4681 (new home). The harness had copied the user's two mission records into that home. They were faulted there ("Repository metadata was replaced"), which blocks every mission create, so I moved them aside inside my own QA home and restarted. Nothing in ~/.codeflow was touched. I made four tiny scratch git repos (README containing "Empty input is valid.", check.mjs that exits 0, branch main) and added each as its own project through "Open another repository". Through the Project missions UI I created and activated: A (build within scope, check "node check.mjs"), B (proposals only, no check), C (build within scope, mission text containing PT-HIGH-RISK), D (build within scope). Scripts and logs: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4681mc/m01-m06 (.mjs/.log). Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4681mc/.
(b) B: "Give team a task" was enabled. I filled title, instructions and criteria and clicked Start: POST /tasks returned 400 and the form showed "Configure a required verification check".
(c) Project A, whose only repo already had an active mission: "Create a mission" was enabled. I filled the whole form and clicked Save draft mission: POST /api/project-teams returned 409 and the form showed "This repository already has a standing team (including its linked worktrees)".
(d1) C: Run cycle now produced one proposal ("high risk · Code evidence verified", base unchanged). "Build proposal" was enabled. Clicking it gave 400 and the toast "Opportunity is stale or outside policy. Update the mission if needed and discover again." No cycle was created.
(d2) D: I gave an owner task with AUTO-FAILURE, which ended blocked, then committed to D's main. "Build proposal" was enabled on the "Owner-assigned task" card. Clicking it gave 400 with the same "...discover again" toast. Repeated on A's blocked owner task after committing .codeflow/config.json {"prove": false} to A's main: same result.
(a) A: I gave two tasks through the UI. Both became ready (pending=2, and Preview next cycle said "Review pending results before starting more work"). "Give team a task" was still enabled. Fill and submit gave 400 and "Review pending work before assigning another task".
No console errors or 5xx responses. All 4 sub-cases reproduced on the first attempt.
Clean …

</details>

### t12-18 · minor · Archive mission is immediate and irreversible without confirmation; archived card shows misleading labels

**Continuation outcome:** Fixed. Archive requires an irreversible-action confirmation including pending-result counts, and archived cards say read-only history. API preview/cycle explain that archived missions cannot run. Browser verifies Cancel and Confirm.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-10.

**Repro**

> On a mission card click 'Archive mission'.

**Expected:** A confirmation stating that it is permanent and the history becomes immutable.

**Actual:** Archived instantly (0 dialogs). The archived card still says 'Recurring discovery enabled'. A cycle API call on an archived mission says 'Activate this team before starting a cycle' (it cannot be activated).

**Root cause (verifier):** All three symptoms come from the archive code paths below.
1. No confirmation: ui/project-teams.tsx:125. The "Archive mission" button calls act("", { status: "archived" }) directly; there is no confirmAction (from ui/confirm-state.ts) like the other destructive actions use.
2. Archive cannot be undone and blocks shipping: on the server, src/project-teams.ts:143 rejects every later update to an archived team ("Archived team history is immutable"). That includes un-archiving and re-activating. :351 (decide) and :244 (shippingGuard) also reject approve/revise/reject and publishing or merging results the team already produced. test/project-teams.test.ts:358-383 checks that pullRequest and mergePr reject /Archived/. So one click permanently strands any ready or accepted drafts in CodeFlow's managed controls; their branches stay, and only a manual git merge can ship them.
3. Misleading label: ui/project-teams.tsx:121 picks between "Manual tasks only" and "Recurring discovery enabled" from t.scheduleEnabled alone and ignores t.status === "archived". The schedule trigger is disabled on archive (syncProjectTeam), yet the label still says it is enabled.
4. Misleading cycle error: src/project …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/project-teams.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-teams.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`

**Suggested fix:** (a) ui/project-teams.tsx:125: import confirmAction from "./confirm-state.js". Make the Archive handler run `if (!await confirmAction(msg, { title: "Archive this mission?", confirmLabel: "Archive mission", danger: true })) return;` before act(). The message should say: it cannot be undone; scheduling stops; the mission becomes read-only and its history, budget ledger, runs and branches are kept; results awaiting approval or shipping can no longer be approved, published or merged from this mission; and a new mission can be created for this repository afterwards. If the team has ready or accepted opportunities, include their count.
(b) ui/project-teams.tsx:121: when t.status === "archived", replace the schedule fragment with something like "Archived · read-only history" instead of "Recurring discovery enabled".
(c) src/project-teams.ts:170: in cycle(), check `if (t.status === "archived") throw new Error("This mission is archived and read-only; create a new mission for this repository")` b …

**Suggested regression test:** 1. test/e2e/project-teams.e2e.ts:
   - Create a draft mission and click "Archive mission".
   - Assert getByRole('dialog', { name: 'Archive this mission?' }) appears, with text saying it cannot be undone.
   - Click Cancel and assert the API status is still 'draft'.
   - Click again and confirm with "Archive mission". Assert status is 'archived', the card no longer contains 'Recurring discovery enabled', and it shows the archived/read-only label.
2. test/project-teams.test.ts, extending "archive …

<details><summary>Verifier's independent reproduction</summary>

Used a fresh fake-mode QA server "v4687m" on port 4687 (new home, so not the existing v4687 home). The harness copies the user's ~/.codeflow/project-teams/pt-*.json into every fresh home. Those copies faulted with "Repository metadata was replaced", which blocks creating any team. That is an environment artifact, not this issue, so I moved the copies out of MY QA home only and restarted. I made a scratch clone of MQTT-MCP (clones/v4687-mqtt) and added it through the UI as project "v4687 MQTT" (p-432ec48b). Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4687/arch1.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4687/arch1.log.

The reporter's script only counted native dialogs (page.on('dialog')), but the app's confirmations use an in-page <dialog> (confirmAction). So I checked for both: native dialogs, plus open dialog / role=dialog / role=alertdialog elements at 150 ms and at 1.6 s after the click.

Results:
(1) Mission A (draft, recurring discovery on). Clicked "Archive mission": 0 native dialogs, 0 in-page dialogs at both checks, 0 toasts, and GET showed status=archived straight away. Every action button disappeared. There is no un-archive: POST status:'active' and status:'paused' both return 400 "Archived team history is immutable".
(2) The archived card A still reads "Custom agent team · Recurring discovery enabled" (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4687m/002-A-after-archive.png). Its automation trigger t-<id> is actually enabled:false. Mission B had recurring discovery off and shows "Manual tasks only", so the misleading label only appears when scheduleEnabled was true.
(3) POST /api/project-teams/<archived>/cycle returns 400 "Activate this team before starting a cycle". GET /preview on the archived mission gives the same warning. The mission cannot be activated, so the message is wrong.
(4) Mission B was first activated through the UI (status active), then archived. Again there was no confirmation and it archived immediately.

Nothing in the docs makes this intentional. docs/project-teams.md:61 only says "Archive team stops scheduling and retains its history". It does not say archiving is permanent, or that it blocks approving and shipping results. Elsewhere the app gates comparable  …

</details>

### S06-1 · minor · 'Archive mission' archives immediately with no confirmation, and archiving cannot be undone.

**Continuation outcome:** Duplicate of t12-18; same archive confirmation and browser coverage.

Source: code-level suspect at `ui/project-teams.tsx:125` (confirmed hands-on).

**Repro**

> Fake QA server s06 on 4525 (CODEFLOW_PROJECT_TEAMS_ENABLED=true) with a scratch repo project. Browser script work/s06/mission-archive.mjs: Create a mission > Save draft mission > Archive mission. No native dialog and no [role=dialog]/[role=alertdialog] appeared. Team status went draft->archived (rev 1->2) and the card showed 0 buttons (screenshot shots/s06/003-after-archive.png). POST /api/project-teams/:id {status:'paused'} returned 400 'Archived team history is immutable'. Snapshot test builds/s06/test/qa-s06-archive.test.ts: after a full fake cycle the opportunity was 'ready'. After archiving, decide(approve), manager.merge and update(status:paused) all failed with 'Archived team history is immutable'. A verified draft is stranded by one click. Workaround: create a new mission for the repo (it succeeded, 201) or merge the branch by hand with git.

**Expected:** An irreversible action asks for confirmation first, like the rest of the app. The message should say that history is kept, that the assignment can't be reactivated, and that pending ready/accepted results can no longer be approved or merged through CodeFlow.

**Actual:** One click archives the mission permanently. Ready results can no longer be approved or merged. Separately, the archived card still reads 'Recurring discovery enabled'.

**Root cause (verifier):** The Archive button calls act("", { status: "archived" }) directly. It does not use confirmAction(), which the app uses for its other irreversible actions (delete automation, reject result, delete project, delete board task). After archiving, ProjectTeams.update, decide and shippingGuard all throw 'Archived team history is immutable' (src/project-teams.ts:143, 244, 351), and the card hides every action (`t.status !== "archived"` guards).

**Suggested fix:** Wrap the Archive onClick in `if (!await confirmAction(...)) return;` with a danger confirmation. Mention the count of ready/accepted opportunities when there are any. Optionally the server could refuse to archive while results are ready/accepted unless a `force`/acknowledge flag is sent. Show 'Archived' instead of 'Recurring discovery enabled' on archived cards.

**Suggested regression test:** UI/e2e: click 'Archive mission', expect a confirmation dialog; Cancel leaves the status unchanged and Confirm archives. Unit: with a ready opportunity, archiving without acknowledgement is refused, or the dialog text lists the stranded results.

### t12-23 · cosmetic · 'Assign to this project' form shows two repository selectors

**Continuation outcome:** Fixed. AssignmentForm owns the repository picker; its nested mission form hides the duplicate. New-assignment browser regression counts one repository selector.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-18.

**Repro**

> Reusable agent teams > Assign to this project.

**Expected:** One repository selector.

**Actual:** 'Repository for team assignment' select, plus the inner TeamForm 'Repository' select (single option).

**Root cause (verifier):** The duplicate comes from how AssignmentForm and TeamForm fit together in ui/project-teams.tsx:
- ui/project-teams.tsx:64: AssignmentForm renders its own repository picker, the select with aria-label "Repository for team assignment".
- ui/project-teams.tsx:66: it then renders `<TeamForm key={repo} repos={[repo]} ... team={existing} />`. `existing` is undefined when the chosen repository has no non-archived assignment.
- ui/project-teams.tsx:79: TeamForm has `{!team && <label>Repository<select ...>{repos.map(...)}</select></label>}`. This select is meant for the "Create a mission" path, where TeamForm receives the whole project repo list. Inside AssignmentForm it renders whenever there is no existing assignment, with exactly one option (the repo already picked above). It can never change anything, and `key={repo}` remounts TeamForm whenever the outer select changes.

When an assignment already exists, `team` is set and the inner select is hidden. That is why the e2e test (test/e2e/project-teams.e2e.ts:153-160, which assigns onto a repo that already has a mission) never sees it.

Nothing in docs/project-teams.md:13 suggests two selectors are intended ("Choose Assign to this project, s …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-teams.e2e.ts`

**Suggested fix:** Show TeamForm's own Repository select only when it is actually choosing among repositories. The simplest change at ui/project-teams.tsx:79 is `{!team && repos.length > 1 && ...}`. AssignmentForm always passes `repos={[repo]}`, so the duplicate disappears there. "Create a mission" in a multi-repo project keeps its picker. In a single-repo project, "Create a mission" would lose a select that has only one choice anyway.

If the repository should stay visible in single-repo create flows, add an explicit prop instead: for example `hideRepository` (or `fixedRepo`) passed by AssignmentForm, with line 79 changed to `{!team && !hideRepository && ...}`. The outer "Repository for team assignment" select stays the single source of truth; TeamForm's `repo` state already defaults to repos[0], which is what it submits.

**Suggested regression test:** In test/e2e/project-teams.e2e.ts, add a new-assignment case: assign a reusable team to a project or repo with no existing mission, the same flow as the MIS-18 path (it could use the repo from the earlier "Create a mission" test before that mission exists, or a second fixture repo).

Assert:
- `await assignment.getByRole("combobox", { name: /^Repository/ }).count() === 1`
- `await assignment.getByLabel("Repository for team assignment", { exact: true }).isVisible()`

Also keep a check that the "Cr …

<details><summary>Verifier's independent reproduction</summary>

Started a new fake-mode QA server named v4601t23 on port 4601 (new home: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4601t23). Project missions were already enabled, and the home had one reusable team, "Reliability & Usability", copied from the seeded project-teams directory. MQTT-MCP (p-ef01794b) had no assignment.

Script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4601t23/r1.mjs uses a fresh headless browser profile. It opens #/project/p-ef01794b/automation/missions, expands "Reusable agent teams (1)" and clicks "Assign to this project". Inside the region "Assign agent team to project" it found these selects in order:
- [0] aria-label "Repository for team assignment", one option: the MQTT-MCP path
- [1] label "Repository", one option: the same MQTT-MCP path
- [2] "Agent team"
- [3] "Autonomy"
- Schedule and Execution permissions

Screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4601t23/002-assign-viewport.png shows both full-width repository dropdowns with the same path, separated only by "Mission name". No console errors.

Control case (r2.mjs): I saved a draft assignment through the form. The first attempt failed with "Repair damaged team records…" because the two pt-*.json records copied from the user's home were faulted in the QA home. That is an environment quirk unrelated to this issue; I moved those copies into pt-aside inside my QA home and restarted. Saving then created draft pt-30c836569732a1da2bafbddc. When I reopened "Assign to this project" for the same repository, only "Repository for team assignment" was shown, along with the note "Its mission history and charged usage stay…".

So the duplicate appears exactly on the new-assignment path (MIS-18). It is not caused by a wrong selector or a fresh profile, and the reporter's s16.log shows the same text.

</details>

### t12-22 · minor · Storage fault alerts give no path or repair guidance; one damaged mission blocks mission creation for every repository

**Continuation outcome:** Fixed. Structured fault details expose the affected file and repair guidance, corrupt settings show unavailable, and creation is disabled before form filling when ownership is unknown. Valid quarantined ownership blocks only its repository. Exact ownership checks remain intact. Browser corrupt-record/settings restarts and store tests cover both.

Source: tester unit project-missions-1; observed with fake-agents; features MIS-21, MIS-01.

**Repro**

> Stop the server, truncate homes/<name>/project-teams/pt-<id>.json, start, open any project's missions page and try Create a mission. Also: corrupt settings.json.

**Expected:** The alert names the file location and how to repair or restore it. Unrelated repos can still get missions, or the block is explained. A corrupt-settings state is labelled as unavailable.

**Actual:** 'Mission storage needs repair (pt-6aee…): Unterminated string in JSON at position 56' on every project. The affected mission card disappears. Create anywhere gives 'Repair damaged team records before creating teams'. With corrupt settings the UI says 'Off on this host · saved across restarts'.

**Root cause (verifier):** 1) ui/project-teams.tsx:51: the alert renders only `Mission storage needs repair ({id}): {reason}`. The API at src/project-teams-api.ts:23 returns `faults` as a bare id→message map. It carries no file path (only docs/project-teams.md:71 says files live in $CODEFLOW_HOME/project-teams/), no kind (settings, corrupt file, ownership quarantine) and no repair or restore hint. A corrupt document never enters `teams` or `quarantinedHistory` (src/project-team-store.ts:45), so its card disappears, and deletionHistory (lines 91-94) fails closed, so there is no in-app repair path.
2) ui/project-teams.tsx:47: the status text is `{data.enabled ? "Enabled on this host" : "Off on this host"} · saved across restarts` and ignores `data.source`. When src/project-team-store.ts:64 returns {enabled:false, source:"unavailable"} because settings.json is corrupt, the UI shows "Off · saved across restarts".
3) src/project-team-store.ts:102: `if (this.faults.size)` blocks create on any fault, including faults whose repository is known. ui/project-teams.tsx:45 still enables Create a mission (only `data.enabled`, `autoTeamEnabled` and `repos` are checked), so the user finds out only after filling and submitti …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-teams-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/project-team-store.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/project-teams.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/repository-identity.ts`

**Suggested fix:** 1. Store and API: give each fault a structured shape, for example {id, kind: "settings"|"corrupt"|"ownership"|"storage", message, file: "<CODEFLOW_HOME>/project-teams/<id>.json", repo?/projectId?}. Keep the repo for quarantined teams, since their history is valid.
2. Alert text: for corrupt files, name the full path and say how to recover. Options: restore it from a Maintenance backup (maintenance.ts already restores project-teams/pt-*.json), or move it out of the folder and restart. For ownership faults, link to the existing archive/delete flow. Label the settings fault as "Project missions setting is unreadable" rather than "Mission storage".
3. Settings label: when `source === "unavailable"`, render "Unavailable: the saved setting can't be read" instead of "Off on this host · saved across restarts".
4. Create button: when any fault blocks creation, disable Create a mission and the library Assign action, and show the explanation next to the button. Optionally narrow store.create so a …

**Suggested regression test:** test/project-teams.test.ts: write garbage to a pt-<24hex>.json and to settings.json, call load(), then GET /api/project-teams through handleProjectTeams. Assert that the fault entry carries kind "corrupt" and a file path ending in project-teams/pt-….json, and that settings yields kind "settings" with source "unavailable". If narrowing is adopted, assert that create() for an unrelated repo still rejects with /ownership cannot be determined/ for a corrupt file but succeeds when the only fault is a …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4695 on port 4695. I moved the old home aside to homes/v4695.prev-*. The harness copies ~/.codeflow/project-teams into every fresh home. Both copied pt-*.json teams were quarantined immediately ("Repository metadata was replaced; inspect ownership before dispatch"; see the adjacent finding below). I set those copies aside to work/v4695/copied-teams to get a clean state and restarted. Faults were then {} and Create a mission was enabled.
Steps (scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4695/: probe.mjs, clean.log, corrupt.log, badsettings.log):
1. In the UI I opened MQTT-MCP > Automation > Pursue a mission, clicked Create a mission, filled the form and clicked Save draft mission. This created pt-fd466774ea13ff459ebceac4.json.
2. I stopped the server, truncated that file to 56 bytes (head -c 56) and started the server again. The MQTT-MCP and IndustriStudio missions pages both showed only "Mission storage needs repair (pt-fd466774ea13ff459ebceac4): Unterminated string in JSON at position 56 (line 1 column 57)". The alert gives no file path and no repair or restore hint. The MQTT-MCP mission card disappeared (API teams: 0), and the briefing still said "Assign and activate an agent team below". Create a mission stayed enabled. On IndustriStudio, an unrelated repo, filling the form and saving returned HTTP 400 and the inline error "Repair damaged team records before creating teams; repository ownership cannot be determined".
3. I stopped the server, restored the mission file, wrote '{"version":1,"enab' to settings.json and restarted. GET /api/project-teams/settings returned {enabled:false, revision:0, source:"unavailable"}. Every project still showed "Off on this host · saved across restarts", with the Enable button and Create a mission disabled, plus the alert "Mission storage needs repair (settings): Unterminated string…". The saved value was actually enabled:true and is now unreadable, so the label is wrong.
Screenshots are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4695/ (001-corrupt-MQTT-MCP.png, 004-corrupt-after-save.png, 001-badsettings-MQTT-MCP.png).
Refutation check: blocking creation on every repo when a corrupt file's repository is unknown is an intentional fail-closed choice. See the comment at src/project-team-store.ts:102 and docs/proj …

</details>
