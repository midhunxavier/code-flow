# Cluster 13 · schedule-editor-tz

**ScheduleEditor & automation time zones/DST, catch-up, interval validation, stale-tab edits**

Status: **independently verified · continuation evidence integrated into `codex/dogfood-qa-continue`** · 15 issues · branch `qa-fix/schedule-editor-tz`

Planner notes: This cluster owns ScheduleEditor/SchedulePreview in ui/automations.tsx and the validateSchedule/resumeSchedule/tick timing in src/automation.ts. ScheduleEditor copies the schedule into local state once and fills in the browser zone for schedules saved without one (which mean server local time), so saving shifts the run time (t15-4/S08-3). A stale tab also silently reverts another tab's change because there is no revision check (t26-2): add a revision and 409 on the server and resync from props. ScheduleEditor reports to its parent only from its own 'Save schedule' button, so the mission form (TeamForm in ui/project-teams.tsx) drops schedule edits (t12-5/S09-1); make it controlled with onChange. t15-5: 'Next:' shows only weekday and time. t15-6/S09-3: catch-up is decided at the first tick, not at startup, and skipped runs are invisible. t15-12/S07-6/S10-2: 'Repeat at most every 5 minutes' says the opposite of the rule, values are silently clamped to 10080, and every+at is accepted. t15-17: the legacy alias Asia/Calcutta is saved. t15-20: the preview shows 'Calculating…' next to an error. t16-16/S08-2: the sweep daily time is saved in server local time without saying so (ui/sweeps.tsx:162). Duplicate groups: [["t15-4","S08-3"],["t12-5","S09-1"],["t15-6","S09-3"],["t15-12","S07-6","S10-2"],["t16-16","S08-2"]]

Likely files: `ui/automations.tsx`, `src/automation.ts`, `ui/sweeps.tsx`, `ui/project-teams.tsx`, `src/server.ts`

## Fix result

Commits:
- `5fae794` Check schedules the same way in the server and the app
- `97d954a` Refuse automation edits based on an older revision
- `25530fd` Judge missed schedule times when code-flow comes back, and record skips
- `8ea2b13` Show and save schedules as they run in the editor, mission form and sweeps
- `a15cad5` Document schedule zones, interval limits, revisions and skipped times
- `7b84bc9` Cover schedule rules, stale edits, missed times and the editor in tests
- `31860bf` Save a schedule refused only because something else changed

Fixer notes for the integrator: Continued from an earlier attempt's branch, which already had 6 commits. That branch was cut from claude/dogfood-qa-2026-10-25 when it pointed at 07d6ff7. `git merge-tree` against the current tip 86d7f94 merges cleanly.

This round:
- Reviewed and re-verified those commits.
- Added 31860bf: a schedule save refused (409) only because another field changed (e.g. the on switch in another tab) is retried on the newer revision instead of showing a false 'changed in another window' alert. The e2e covers it.

Existing tests edited on purpose:
- test/automation.test.ts:65: the expected message changed from /every 5 minutes/ to /at least 5 minutes apart/.
- test/e2e/automation-controls.e2e.ts: the sweep browser context now has timezoneId America/New_York, and the asserted schedule is {at:'08:30', timezone:'America/New_York'}, because sweeps now save the browser zone.

New files:
- src/schedule-rules.ts: browser-safe. It holds validateSchedule, canonicalTimeZone and MIN/MAX_EVERY_MINUTES, all re-exported from src/automation.ts.
- ui/schedule-draft.ts: draft, problem, sameSchedule, formatNextRun and localTimezone.
- Tests: test/qa-schedule-editor-tz.test.ts, test/qa-schedule-editor-tz-server.test.ts and test/e2e/qa-schedule-editor-tz.e2e.ts (it runs scripts/build-ui.mjs in before()).

API and behaviour changes to watch when merging other clusters:
1. validateSchedule no longer rounds or clamps. It rejects:
   - intervals that aren't whole numbers;
   - intervals under 5 or over 10080;
  …

## Independent continuation verification (2026-10-26)

Validation passed: `npx tsc --noEmit`, `git diff --check`, the four original cluster unit/API files (29 tests), the broader check/environment/verification/automation regression group (59 tests, including the new independent cases), and the three Chrome suites together (13 scenarios). The new engine cases also passed separately after strengthening the quoted-argument test.

Verified from integrated commit `dba688d` in `/private/tmp/codeflow-qa-missions`, branch `codex/qa-checks-schedules-verify`. Diff review covered shared schedule rules, current zone-name normalization, revision conflict handling and retry after unrelated edits, controlled mission-form changes, keyed preview state, load-time catch-up, recorded skips, and sweep timezone propagation. No additional schedule product defect was confirmed.

Repeated the original unit/API/Chrome tests for all issue groups: t15-4/S08-3 (zone-less schedules retain server-local semantics across browsers), t26-2 (stale edits, draft retention and explicit overwrite/reload), t12-5/S09-1 (create/edit mission saves the visible schedule without an inner save), t15-5 (date and named zone in Next), t15-6/S09-3 (startup catch-up and visible skipped events), t15-12/S07-6/S10-2 (interval bounds, no silent clamping or default substitution), t15-17 (modern zone names), t15-20 (single invalid-preview reason and disabled save), and t16-16/S08-2 (sweeps save the browser zone).

Added independent real-server/Chrome coverage in `test/e2e/qa-checks-schedules-independent.e2e.ts`. A server in America/Los_Angeles and browser in Europe/Stockholm create a real sweep through the dialog; its request and saved automation both use 09:00 Europe/Stockholm, and nextAt formats to 09:00 there. HTTP previews cover Stockholm's spring gap (02:30 moves to 03:30), fall overlap (first occurrence only), and the following day. The suite also stops its own server, writes two occurrences to its own triggers.json, and restarts with the normal 30-second scheduler tick. An occurrence about 59m50s old at startup fires once after it crosses an hour; a two-hour-old occurrence is recorded as skipped and displayed in Preview and events.

Screenshots and browser/server logs are generated under `output/playwright/qa-checks-schedules-independent/`; transcripts are `/private/tmp/codeflow-qa-continue/checks-schedules-*.log`. The server uses only assigned ports 4359/4360, a temporary home and scratch repositories with fake agents/GitHub. Browser navigation leaves the server before the deliberate restart, and application console/page errors are checked without a generic failure filter. Existing test fixtures also use isolated temporary homes and their own free ports. No live server or real project data was accessed.

## Issues

### t15-4 · major · Saving the row schedule editor rewrites a 'server local time' schedule into the browser's time zone (shifts run time); backlog sweeps are created tz-less

**Fix outcome: fixed.** ui/schedule-draft.ts (new): scheduleDraft() keeps an empty zone for a schedule saved without one. Only switching from 'off' or 'every' to a time of day starts in the browser zone. draftSchedule() omits timezone when the field is empty, and sameSchedule() compares schedules the way the server normalises them. ui/automations.tsx ScheduleEditor: an empty Time zone field means server local time, shown with the placeholder 'Server local time' and an 'Empty: it runs in the server's local time. Use my time zone (<zone>)' hint. Save schedule stays disabled until the draft differs from the saved schedule. SchedulePreview labels times 'Next runs in server local time (<server zone>)' and formats them in that zone. src/server.ts POST /automations/schedule-preview now returns the server zone in `timezone` for a time-of-day schedule saved without one. ui/sweeps.tsx no longer creates schedules without  …

Fixer's check: Server f13 (fake mode, server zone Europe/Stockholm) on 4413, started from the worktree after rebuilding the UI. Script work/schedule-editor-tz/a1.mjs.
- Created {at:'08:00'} through the API: 'every day at 08:00 (server local time)', nextAt 07:00Z.
- Opened #/settings/automations in a Chrome context with timezoneId America/New_York.
- The row read 'Next: Mon, Oct 26, 03:00 AM EDT'. The Time zone field was '' with placeholder 'Server local time'.
- The preview read 'Next runs in server local time (Europe/Stockholm): Mon, Oct 26, 2026, 08:00 AM GMT+1 …'. Save schedule was disabled.
- A forced click sent 0 POSTs. The schedule stayed {at:'08:00'} and nextAt was unchanged.
- errors=[] and server. …

Tests: `test/qa-schedule-editor-tz.test.ts: the editor keeps a schedule saved without a zone in server local time, and saving it unedited changes nothing`, `test/qa-schedule-editor-tz-server.test.ts: previews say which zone a time of day runs in; one saved without a zone keeps server local time`, `test/e2e/qa-schedule-editor-tz.e2e.ts: a schedule saved without a zone stays in server local time when edited from another zone`

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-11.

**Repro**

> 1. Have a tz-less automation, e.g. a backlog sweep saved from the UI (ui/sweeps.tsx:162 sends {at} only) or POST /api/automations with schedule {at:'08:00'}. The row reads 'every day at 08:00 (server local time)' on a Europe/Stockholm server. 2. Open the app in a browser whose zone differs (America/New_York). 3. Expand 'Schedule and next times'. The Time zone field shows America/New_York and 'Next runs' are listed in New York time. 4. Click 'Save schedule' without changing anything.

**Expected:** The editor shows and keeps the schedule's existing semantics (server local, or the server's zone). Saving without edits changes nothing.

**Actual:** The schedule becomes {at:'08:00', timezone:'America/New_York'}. nextAt moves from 07:00Z to 12:00Z (5 h later). The editor preview showed times the automation never runs at.

**Root cause (verifier):** Not by design: docs/api.md:236-238 says an omitted timezone "uses server local time", and the server follows that (src/automation.ts:192-214 nextFire uses server-local Date for tz-less schedules; src/automation.ts:259 describeSchedule prints "(server local time)"). The shared editor breaks that contract. (1) ui/automations.tsx:86 `useState(current && "at" in current ? current.timezone ?? localTimezone() : localTimezone())` replaces a missing zone with the browser zone (localTimezone at ui/automations.tsx:65). (2) ui/automations.tsx:89 always builds `{ at, timezone, days }` in daily mode, so the zone becomes explicit. (3) ui/automations.tsx:94 "Save schedule" sends `schedule` with no dirty check, so a save with no edits changes the stored schedule and src/server.ts:2244 accepts it. (4) ui/automations.tsx:73-74 SchedulePreview formats the draft in the browser zone, so the open editor shows times that contradict the row's own "Next:" (ui/automations.tsx:341, from nextAt). Source of tz-less schedules from the UI: ui/sweeps.tsx:162 posts `schedule: repeat ? { at } : undefined`, and the dialog's "Also check every day at [time]" (ui/sweeps.tsx:330-331) names no zone. src/server.ts:787 val …

**Files:** `ui/automations.tsx`, `ui/sweeps.tsx`, `src/server.ts`, `test/e2e/automation-controls.e2e.ts`, `test/automation.test.ts`

**Suggested fix:** 1. ScheduleEditor (ui/automations.tsx:84-94): keep the saved zone semantics. For an existing daily schedule, initialise the zone to `current.timezone ?? ""`. An empty field means "server local time": show that as placeholder/help text, and build the draft as `{ at, ...(timezone.trim() ? { timezone: timezone.trim() } : {}), days }`. Default to localTimezone() only when the user switches a schedule without a time of day (off or interval) to daily. 2. Add a dirty check: disable Save, or skip the POST, when the normalised draft equals `a.schedule`. 3. Have the server report its zone (for example `serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone` in the automation view at src/server.ts:995 or in /api/health). The editor can then show "Server local time (Europe/Stockholm)", and SchedulePreview can format tz-less times in the server zone instead of the browser zone. 4. ui/sweeps.tsx:162: send `timezone: localTimezone()` like the Repeat dialog, and show the zone next to the tim …

**Suggested regression test:** test/e2e/automation-controls.e2e.ts: start the fixture server with TZ=Europe/Stockholm and open the page in a browser context with timezoneId "America/New_York". Create an automation via API with schedule {at:"08:00"} and record nextAt. Expand "Schedule and next times" and assert the Time zone field does not show America/New_York (empty / "server local"). Click "Save schedule" and assert GET /api/automations returns the schedule deepEqual {at:"08:00"} (no timezone key) and the same nextAt. Secon …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server (new home v4651tz, port 4651, server on this Mac: Europe/Stockholm, CET since today 2026-10-25). Precondition via API: POST /api/automations {name, run:{repo: MQTT-MCP, pattern: solo, roles:{agent:[claude]}}, schedule:{at:"08:00"}} -> 201, schedule {"at":"08:00"}, scheduleText "every day at 08:00 (server local time)", nextAt 2026-10-26T07:00:00Z. Opened http://127.0.0.1:4651/#/automations in my own headless Chrome context with timezoneId America/New_York (no profile, only the zone differs). Row: "every day at 08:00 (server local time) ... Next: Mon 03:00 AM" (correct). Expanded "Schedule and next times": Time zone field prefilled "America/New_York"; preview "Next runs in America/New_York: Mon, Oct 26, 2026, 08:00 AM EDT ..." (wrong, never runs then), shown in the same row as the correct "Next: Mon 03:00 AM". Clicked "Save schedule" with no edits: request body {"schedule":{"at":"08:00","timezone":"America/New_York"}}; afterwards GET /api/automations: schedule {"at":"08:00","timezone":"America/New_York"}, scheduleText "(America/New_York)", nextAt 2026-10-26T12:00:00Z (+5 h). No console or 5xx errors. Control with timezoneId Europe/Stockholm: Save also rewrote to {at:"08:00",timezone:"Europe/Stockholm"}, but nextAt stayed 07:00Z. The time shifts only when the browser's zone differs from the server's: remote or shared access from another zone, or a server whose clock is in another zone (for example UTC). Sweep claim checked in code only, not in the UI: ui/sweeps.tsx:162 sends {at} only and src/server.ts:787 saves it unchanged. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4651tz/editor-open-America_New_York.png; scripts and logs in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4651tz/ (tz.mjs, ny.log, sto.log). Cleanup: the 3 probe automations were deleted with the UI Delete button, no runs were created, server v4651tz stopped, port 4651 free.

</details>

### S08-3 · minor · ScheduleEditor pre-fills the browser time zone for schedules saved without one (server local), so its preview contradicts the schedule in effect and 'Save schedule' silently converts it to an explicit zone.

**Fix outcome: duplicate.** Duplicate of t15-4; that issue carries the fix in ScheduleEditor, scheduleDraft and the schedule-preview zone.

Fixer's check: Server f13b on 4415, started with TZ=America/Los_Angeles; browser timezoneId Europe/Stockholm. Scripts b1.mjs and b3.mjs.
- A sweep saved without a zone through the API ({at:'09:00'}) has nextAt 16:00Z.
- The backlog card read 'Next: Mon, Oct 26, 05:00 PM GMT+1'. The zone field was empty.
- The preview read 'Next runs in server local time (America/Los_Angeles): Mon, Oct 26, 2026, 09:00 AM PDT …', which matches nextAt.
- Save was disabled and the schedule was unchanged.
- 'Use my time zone' filled in Europe/Stockholm, re-previewed at 09:00 AM GMT+1 and enabled Save. errors=[].

Tests: `test/e2e/qa-schedule-editor-tz.e2e.ts: a schedule saved without a zone stays in server local time when edited from another zone`

Source: code-level suspect at `ui/automations.tsx:86` (confirmed hands-on).

**Repro**

> Same setup as the sweep repro (server TZ America/Los_Angeles, browser Europe/Stockholm, saved sweep {at:'09:00'}). On Project > Automation > Process a backlog the card shows 'every day at 09:00 (server local time)' and 'Next: Mon 05:00 PM'. Directly below it, 'Schedule and next times' shows Time zone 'Europe/Stockholm' and 'Next runs in Europe/Stockholm: Mon, Oct 26, 2026, 09:00 AM GMT+1 …' (screenshot 87918-schedule-editor.png). The server preview of the saved schedule returns 2026-10-26T16:00Z. Clicking 'Save schedule' with no edits changed the stored schedule to {"at":"09:00","timezone":"Europe/Stockholm"} and nextAt from 16:00Z to 08:00Z, with no warning.

**Expected:** The editor previews the schedule actually in effect (server local time, labelled as such). Saving without edits leaves the schedule unchanged, or the change of zone is shown explicitly.

**Actual:** The preview shows 09:00 Stockholm times while the real next run is 17:00 Stockholm on the same screen. An unedited Save moves every future run by 8 hours.

**Root cause (verifier):** `useState(current && "at" in current ? current.timezone ?? localTimezone() : localTimezone())` substitutes the browser zone when current.timezone is undefined. The editor builds `schedule = { at, timezone, ... }` from that state and passes it to SchedulePreview (server-computed for that zone, then labelled 'Next runs in <browser zone>'). It also sends it unchanged on Save.

**Suggested fix:** Keep timezone undefined when the saved schedule has none: initialise state to current.timezone ?? '' and treat an empty field as 'server local time' (placeholder/label). Build the schedule without a timezone when the field is empty, so the preview label and the times reflect server local time. Optionally offer a one-click 'Use my time zone (<zone>)' that makes the conversion explicit.

**Suggested regression test:** UI/browser test rendering ScheduleEditor for an automation with schedule {at:'09:00'} under a browser timezone different from the server's. Assert the first preview time equals the automation's nextAt and the label does not name the browser zone. Click Save schedule without edits and assert the stored schedule is still {at:'09:00'}.

### t26-2 · major · Automation schedule edits from a stale tab silently revert another tab's saved change (no 409); the other tab keeps showing the lost value

**Fix outcome: fixed.** Server side:
- src/automation.ts: Trigger has a `revision`. create() sets it to 1, a missing value on load reads as 1, and update() counts it up.
- update() given a revision different from the current one throws AutomationConflictError (status 409, 'This automation was changed in another window, so your change wasn't saved') and changes nothing.
- src/server.ts POST /automations/:id accepts an optional integer `revision` (400 if invalid) and maps the conflict to 409. describeAutomation returns the revision.

UI side, ui/automations.tsx ScheduleEditor:
- Save sends the revision the edit started from.
- An untouched editor reseeds from the polled or saved schedule.
- When the saved schedule changes during an edit, or a save is refused, it keeps the draft and shows an alert: 'This schedule was changed in another window…' with 'Use saved schedule' and 'Save mine over it'.
- Commit 31860bf: w …

Fixer's check: f13, two tabs in one Stockholm context. Script a2.mjs, original repro steps.
- Tab A saved 04:00. Tab B, still showing 03:00, changed only the zone to UTC and clicked Save. The response was 409 and B showed the conflict alert with its draft '03:00 UTC' kept. The server still had {at:'04:00', timezone:'Europe/Stockholm'}.
- After A's poll, A's header and fields both showed 04:00. 'Use saved schedule' in B showed 04:00 Europe/Stockholm.
- Run 2: B's own 15 s poll resynced its untouched editor to 05:00. A zone-only change then saved {at:'05:00', timezone:'UTC'}.
- New check: A flipped the row's on switch (revision 4 to 6 overall) and B, before polling, saved 07:15. B's POSTs were [409, 200], th …

Tests: `test/qa-schedule-editor-tz.test.ts: a change based on an older revision is refused with 409 and changes nothing`, `test/qa-schedule-editor-tz-server.test.ts: a schedule saved from a stale window is refused with 409 and the newer one is kept`, `test/e2e/qa-schedule-editor-tz.e2e.ts: two windows: an untouched editor follows the saved schedule; a stale edit is refused and kept`

Source: tester unit usability-failure-cases-2; observed with fake-agents; features UX-22.

**Repro**

> 1. Create a repeating task (here via POST /api/automations, disabled) 'every day at 03:00'.
> 2. Open #/automations in tab A and tab B and expand 'Schedule and next times' in both.
> 3. Tab A: change the time to 04:00 and click Save schedule. GET /api/automations returns {at:'04:00', timezone:'Europe/Stockholm'}.
> 4. Tab B, which still shows 03:00: change only the time zone to UTC and click Save schedule.

**Expected:** Tab B gets a conflict ('changed in another window', draft kept), or only the field it changed is saved.

**Actual:** The server stores {at:'03:00', timezone:'UTC'}, so tab A's 04:00 is silently reverted. Neither tab shows an error, and tab A still displays 04:00. The unattended agent will run at a time the user did not choose.

**Root cause (verifier):** Three defects combine.

1. ui/automations.tsx:82-89 (ScheduleEditor) copies `a.schedule` into local useState (mode, at, timezone, days, every) once, on mount. Nothing resyncs it when the `automations` signal is refreshed by the 15 s pollVisible(loadAutomations) poll (line ~105) or by update().then(loadAutomations) (line 284). The row header (`a.scheduleText`, line ~297) updates, but the editor and its SchedulePreview keep showing the old schedule.

2. ui/automations.tsx:89 builds the whole schedule from that local state, and line 94 sends it: `save({ schedule: schedule ?? null })` through AutomationRow.update (line 284), which POSTs /api/automations/:id. A change to one field therefore resends every field as this tab last knew it.

3. On the server, src/server.ts:2236-2247 builds the patch with no revision or expected-value field (line 2244: `if ("schedule" in body) patch.schedule = validateSchedule(body.schedule)`). src/automation.ts:383-402 Automations.update() then does `Object.assign(t, rest)` and recomputes nextAt without any check. The Trigger type (src/automation.ts:19) has no revision or updatedAt, so a stale write cannot be detected and is never answered with 409. The same …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/automation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/automation.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/automation-controls.e2e.ts`

**Suggested fix:** Server: add a monotonically increasing `revision` to Trigger. Set it to 1 in create(), treat a missing value on load as 1, and increment it on every user-visible update(); markHandled and fire bookkeeping need not bump it. POST /automations/:id should accept an optional `revision` (or `expectedRevision`, as coordinated-changes uses). When it is present and differs from t.revision, throw a 409 such as "This automation changed in another window. Your edit was not saved." and include the current describeAutomation(t) in the body, as ConventionsError does. Return the new revision in describeAutomation.

UI: every update() call in AutomationRow sends `revision: a.revision`. In ScheduleEditor:
(a) Re-seed the local state when the saved schedule changes and the editor is not dirty. Track the base schedule JSON in a ref; when JSON.stringify(a.schedule) differs from that base and the local values still equal it, reset them.
(b) When the editor is dirty and the server value has changed, show an  …

**Suggested regression test:** Unit test in test/automation.test.ts: create a trigger and read its revision r. update(id, { schedule: {at:"04:00", timezone:"Europe/Stockholm"}, revision: r }) succeeds and returns r+1. A second update(id, { schedule: {at:"03:00", timezone:"UTC"}, revision: r }) rejects with status 409. Assert that list() still has {at:"04:00", timezone:"Europe/Stockholm"} and nextAt is unchanged.

E2E test in test/e2e/automation-controls.e2e.ts: create an automation at 03:00 Europe/Stockholm and open two pages …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4639 on 127.0.0.1:4639, fresh browser (no profile). Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4639/stale.mjs (variant 2 is stale2.mjs). Logs are run1.log, run2.log and run3.log in the same folder.

Setup: POST /api/automations creates a disabled automation (solo claude on MQTT-MCP) with schedule {at:"03:00", timezone:"Europe/Stockholm"}. Two tabs in one browser context open #/automations, and each expands "Schedule and next times" on that row.

Run 1 (and run 3, same result):
1. Tab A sets the time to 04:00 and clicks Save schedule. Server: {"at":"04:00","timezone":"Europe/Stockholm"}.
2. Tab B still shows 03:00. It changes only the time zone to UTC and clicks Save schedule. Server: {"at":"03:00","timezone":"UTC"}. Tab A's 04:00 is lost.
3. No toast or alert in either tab, and errors=[].
4. After tab A's 15 s poll, its row header reads "every day at 03:00 (UTC)", but the expanded editor in the same row still shows 04:00 Europe/Stockholm. Its "Next runs" list also still shows 04:00 AM GMT+1. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4639/002-A-after-poll.png.

Run 2 (stronger case): tab B stays in front for 17 s after A's save, so its poll runs. B's row header updates to "every day at 04:00 (Europe/Stockholm)", but B's editor fields still show 03:00. Changing only the time zone to UTC still saves {"at":"03:00","timezone":"UTC"}. So a tab that has already polled the new value still reverts it. Reloading the page is the only way to resync the editor. Any later Save in tab A would also silently overwrite B's change.

Not by design: docs/automations.md and docs/api.md (POST /automations/:id, "changed fields") say nothing about last-write-wins. Comparable settings already reject stale saves: ACP connections ("The API rejects saves based on an older settings revision"), conventions (409), the notes conflict UI in ui/side.tsx:360, and templates ("changed elsewhere"). Not environmental: the test used my own selectors scoped to the row, a fresh profile and a fresh home.

Cleanup: deleted the 3 test automations through the API (list is now []). No runs were created. Server v4639 is stopped. No leftovers.

</details>

### t12-5 · major · Schedule changes in the Create/Edit mission form are silently dropped unless the inner 'Save schedule' is clicked

**Fix outcome: fixed.** ui/automations.tsx: ScheduleEditor has a controlled mode. With `onChange`, every edit is sent to the parent, there is no inner Save button and no 'Only when triggered' option. ui/project-teams.tsx TeamForm uses onChange={(schedule) => setAdvanced((current) => ({ ...current, schedule }))} with zoneRequired, so 'Save draft mission' and 'Save mission' send the schedule shown. 'Run recurring discovery' still turns scheduling off. TeamCard's own editor keeps its explicit Save schedule. docs/project-teams.md now says this.

Fixer's check: f13. Scripts a3.mjs and a5.mjs.
- Create form: set Time 14:30 and ticked Wed, then 'Save draft mission' with no inner Save, because there is none (count 0). mission.schedule was {at:'14:30', days:[1,3], timezone:'Europe/Stockholm'}.
- Edit mission: Time 11:45 and Maximum changed files 9, then Save mission. The schedule became 11:45 and maxFiles 9.
- Edit: 'Every N minutes' 30, then Save mission, gave {every:30}.
- Active mission (a5): Edit mission, Time 06:15, Save mission. team.schedule and the managed trigger were both 06:15 (nextAt 05:15Z), missionRevision was kept at 2, and the card editor showed 06:15. errors=[].

Tests: `test/e2e/qa-schedule-editor-tz.e2e.ts: the mission form saves the schedule it shows, without a separate schedule save`

Source: tester unit project-missions-1; observed with fake-agents; features MIS-08.

**Repro**

> 1. Active mission > Edit mission > expand 'Schedule, budget and scope limits' > 'Schedule and next times'.
> 2. Change Time (for example 11:45→07:30), or switch to 'At a time 06:15'.
> 3. Click 'Save mission' (the form closes with no error).
> 4. Check team.schedule via the API, the card schedule, or triggers.json.

**Expected:** Save mission saves the visible schedule, or blocks or warns about unsaved schedule edits.

**Actual:** The schedule is unchanged (11:45, and later 'every 5'). Clicking the inner 'Save schedule' first does apply the change. Reproduced twice (s19.log, s49).

**Root cause (verifier):** ui/automations.tsx:82-94: ScheduleEditor keeps its draft in its own local useState (mode, at, timezone, days, every; lines 84-88). It derives `schedule` (line 89) and passes it to its parent only through `save()`, which only the inner "Save schedule" button calls (line 94).

ui/project-teams.tsx:94: TeamForm embeds this editor with a save callback that only does setAdvanced({...advanced, schedule}) (or setScheduleEnabled(false) for "Only when triggered").

ui/project-teams.tsx:76: the outer submit builds `value = { ...advanced, ... }` and posts mission.schedule = advanced.schedule. That is the value from when the form opened (line 75) or from the last inner "Save schedule". Edits still sitting in ScheduleEditor's local state are never read.

The inner button is labelled "Save schedule" but in this form it only stages the value; it doesn't persist anything. That makes the two-step flow even harder to discover. The e2e (test/e2e/project-teams.e2e.ts:188-195) covers only the card-level ScheduleEditor (project-teams.tsx:128), which persists directly, so this path has no test.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-teams.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-teams.e2e.ts`

**Suggested fix:** Make ScheduleEditor usable as a controlled or "live" editor inside forms.

Option 1: add an optional `onChange(schedule | null)` prop to ScheduleEditor (ui/automations.tsx). Call it from each setter (or from a useEffect on the derived `schedule`), and hide the "Save schedule" button when `onChange` is provided (e.g. an `embedded` prop). In TeamForm (ui/project-teams.tsx:94), pass onChange={(s) => s === null ? setScheduleEnabled(false) : setAdvanced(a => ({ ...a, schedule: s }))}, using a functional update so other advanced edits are not clobbered. The outer "Save mission"/"Save draft mission" then always sends the visible schedule.

Option 2: lift the mode/at/timezone/days/every state into TeamForm.

Either way, "Only when triggered" inside the form should map to scheduleEnabled=false and keep the stored schedule, as it does now. The card-level editor (project-teams.tsx:128) and the Automations page (automations.tsx:352) keep their explicit "Save schedule" behaviour.

A lighter alterna …

**Suggested regression test:** test/e2e/project-teams.e2e.ts has two cases to extend.

Create case (around lines 87-98): before "Save draft mission", open "Schedule and next times", fill Time with "07:30", and do NOT click "Save schedule". Then assert that `(await api('/api/project-teams?project='+id)).body.teams[0].mission.schedule.at === '07:30'`.

Edit case (around line 159, the assignment form's "Save mission"): change Time, or switch the Schedule select to "every" with Minutes 30. Click only "Save mission", then assert ` …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4661t125" on 127.0.0.1:4661 with home .../scratchpad/qa/homes/v4661t125 and a fresh browser profile. The harness had copied two of the user's project-team records into the home. They were damaged ("Repository metadata was replaced") and blocked mission creation, so I moved them into homes/v4661t125/pt-copied-backup and restarted. That is a harness artefact, separate from this issue.

Setup: scratch clone .../clones/v4661t125-mqtt (MQTT-MCP), added through the UI as project "v4661t125 MQTT". Ran work/v4661t125/r1.mjs and r2.mjs (logs r1.log and r2.log).

- A. Create form: changed Time from 09:00 to 07:30 (the form showed 07:30), then clicked "Save draft mission". The form closed with no alert. Server mission.schedule = {at:"09:00",days:[1]}.
- Activated the draft. triggers.json then had 09:00 with nextAt 2026-10-26T08:00Z.
- B. Edit mission > Schedule, budget and scope limits > Schedule and next times: changed Time from 09:00 to 11:45 (screenshot shots/v4661t125/002-B-edit-form-edited.png shows 11:45), then clicked "Save mission". The form closed with no alert. team.schedule, the trigger and the card's own schedule editor all still said 09:00.
- C. Edit form: switched to "Every N minutes" with 30, then Save mission. Schedule unchanged (09:00).
- D. Control: Edit form, Time 06:15, then the inner "Save schedule" (the server was still at 09:00 at that point, because the inner button only updates form state), then Save mission. Schedule became 06:15 and the trigger nextAt was 05:15Z.
- E. Edit form: changed "Maximum changed files" to 9 and Time to 08:05, then Save mission. maxFiles=9 saved, schedule stayed 06:15. So the other fields save and only the schedule is dropped, silently.
- r2: captured the POST /api/project-teams/:id body after setting Time to 22:10 and clicking Save mission. The browser sent mission.schedule={at:"06:15",...}, the stale value. The stale value comes from the client; the server applies whatever schedule it receives (shown by D).

No console errors and no 5xx responses. Not caused by the test setup: Playwright fill() does fire onInput (D works with the same fill), and the selectors target the form's own ScheduleEditor. Not by design: docs/project-teams.md step 5 says "Review the schedule and budgets, save the draft", which implies the outer save keeps the schedule. The form gives no unsaved-change warning.

</details>

### S09-1 · major · Mission form embeds ScheduleEditor whose own 'Save schedule' button is the only way to push schedule edits into form state; editing time/zone/days then pressing 'Save draft mission' silently drops them.

**Fix outcome: duplicate.** Duplicate of t12-5; that issue carries the fix in ScheduleEditor onChange and TeamForm.

Fixer's check: Same runs as t12-5 (a3.mjs and a5.mjs on f13). Create with 14:30 and Mon/Wed, then 'Save draft mission', saved {at:'14:30', days:[1,3], timezone:'Europe/Stockholm'}. Edit 17:45, then 'Save mission', saved 17:45 in the e2e.

Tests: `test/e2e/qa-schedule-editor-tz.e2e.ts: the mission form saves the schedule it shows, without a separate schedule save`

Source: code-level suspect at `ui/project-teams.tsx:94` (confirmed hands-on).

**Repro**

> Fake-mode server s09 (port 4537), scratch repo added via 'Open another repository'. Project, then Automation, then Pursue a mission, then Create a mission. Fill name/mission/users/check. Expand 'Schedule, budget and scope limits', then 'Schedule and next times'. Set Time 14:30 and tick Wed. The in-form preview shows Mon/Wed 2:30 PM. Click 'Save draft mission' (not the inner 'Save schedule'). GET /api/project-teams?project=<id> shows the schedule unchanged (script work/s09/02-mission-schedule.mjs, screenshot shots/s09/001-mission-form-edited-schedule.png). Edit path: work/s09/09-edit-mission-schedule.mjs.

**Expected:** The mission saves the schedule shown in the form (preview listed Mon/Wed 14:30 Europe/Stockholm), i.e. mission.schedule {at:'14:30',days:[1,3]}.

**Actual:** Saved team had mission.schedule {at:'09:00',days:[1],timezone:'Europe/Stockholm'} (the default) and no error or hint. Edit mission has the same problem: Time changed to 17:45 plus Maximum changed files changed to 9, then 'Save mission'. maxFiles saved as 9, but the schedule stayed 09:00 Mon.

**Root cause (verifier):** ScheduleEditor (ui/automations.tsx:82-95) keeps mode/at/timezone/days/every in its own useState and calls its `save` prop only from its own type=button 'Save schedule'. TeamForm.submit builds the mission from `advanced.schedule`, which only changes through that callback, so unsaved edits in the nested editor never reach the submitted body.

**Suggested fix:** Give ScheduleEditor a controlled mode: an onChange(schedule|null) prop called on every edit, with the Save button hidden. TeamForm uses it to keep advanced.schedule (and scheduleEnabled for 'Only when triggered') in sync. Or have TeamForm read the editor's current value on submit. Keep the explicit Save button only for the standalone editors (automation rows, TeamCard).

**Suggested regression test:** UI/e2e: create a mission, change Time to 14:30 and add Wed in the nested editor, click 'Save draft mission' without the inner Save. Assert the API returns mission.schedule {at:'14:30',days:[1,3]}. Repeat for 'Edit mission' then 'Save mission'.

### t15-5 · minor · Automation row 'Next:' shows only weekday and time in browser-local time, with no date or zone

**Fix outcome: fixed.** ui/schedule-draft.ts formatNextRun(at, schedule, now) formats with weekday, month, day, time and zone name, and adds the year when it differs from now. A time-of-day schedule with its own zone is formatted in that zone, so it matches scheduleText; anything else uses the browser zone with the zone named. If the zone is invalid it falls back to the browser zone. ui/automations.tsx AutomationRow uses it for 'Next:'.

Fixer's check: f13, browser America/New_York. Script a1.mjs.
- every 10080: 'Next: Sun, Nov 1, 11:02 PM EST' (a week away, not 'today').
- 06:30 UTC: header 'every day at 06:30 (UTC)' and 'Next: Mon, Oct 26, 06:30 AM UTC'.
- 09:15 America/Los_Angeles: 'Next: Mon, Oct 26, 09:15 AM PDT'.
- errors=[].

Tests: `test/qa-schedule-editor-tz.test.ts: the next run shows its date and zone: a week away never reads as today`, `test/e2e/qa-schedule-editor-tz.e2e.ts (Next has a date and names the zone, in the first and third tests)`

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-09, SCH-05, SCH-06.

**Repro**

> 1. On a Sunday, save 'Repeatedly' every 20000 minutes (clamped to 10080) or any weekly schedule. The row reads 'Next: Sun 04:49 PM' although the next run is next Sunday. 2. Save 'At a time' 06:30 in UTC. The same row reads 'Mon … at 06:30 (UTC)' and 'Next: Mon 07:30 AM'. 3. An LA 09:15 schedule shows 'Next: Sun 05:15 PM'.

**Expected:** Next shows a date, plus the schedule's zone or an explicit local-zone label, consistent with the scheduleText.

**Actual:** A weekday+time without a date makes a run a week away look like today, and mixing schedule-zone text with browser-local Next is confusing.

**Root cause (verifier):** The bug is at ui/automations.tsx:342 in AutomationRow: `Next: ${new Date(a.nextAt).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })}`. This formats the next run with no year, month or day, no `timeZone` and no `timeZoneName`.

The schedule's own text works differently. scheduleText comes from describeSchedule in src/automation.ts:254-260 and names the schedule's IANA zone (or "server local time"). The Next value is always shown in the viewer's browser zone with no label.

Weekly schedules and the 10080-minute maximum (src/automation.ts:141) fire 7 days apart, so the weekday-only format makes a run a week away look like today. It can even make it look like it already happened. The full dated, zone-labelled list exists only inside the collapsed SchedulePreview (ui/automations.tsx:78), which explains why the problem is minor rather than major. The same weekday+time-only pattern also appears at ui/app.tsx:502 in the health dialog, which is not part of this issue.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/automation-controls.e2e.ts`

**Suggested fix:** 1. In ui/automations.tsx, add one exported pure helper, for example `formatNextRun(at, schedule, now = Date.now())`, and use it for both the row and the preview.
2. Make the helper always include the date: `{ weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" }`, plus the year when it differs from `now`. Optionally prefix "today" or "tomorrow", or append a relative hint ("in 7 days") so a week-away run cannot read as today.
3. For an `at` schedule with an explicit `timezone`, format in that zone, the same way SchedulePreview does at line 78, so it matches scheduleText ("every day at 06:30 (UTC)" then "Next: Mon, Oct 26, 06:30 UTC"). If the schedule zone differs from the browser's, optionally add the local time in parentheses. That matches the intent stated at src/automation.ts:217.
4. For `every` schedules and zone-less `at` schedules, use browser-local time but keep `timeZoneName`, so the zone is always stated.
5. Wrap the Intl  …

**Suggested regression test:** 1. Add a focused unit test, test/automation-next-ui.test.ts. Import the exported `formatNextRun` from ui/automations.tsx, using the same globalThis window/location/localStorage stubs that test/run-history-ui.test.ts uses. With `now` = Sun 2026-10-25T21:08Z, assert that:
   - an `{every:10080}` nextAt of 2026-11-01T21:08Z produces text containing "Nov 1" (not just "Sun");
   - `{at:"06:30", timezone:"UTC"}` with nextAt 2026-10-26T06:30Z contains "06:30" and "UTC";
   - `{at:"09:15", timezone:"Ame …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, "v4653t155", on 127.0.0.1:4653. It used a new home at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4653t155. I used a new home because the existing v4653 home already held another tester's trigger. As a precondition I created one automation through the API: POST /api/automations, solo pattern, MQTT-MCP, schedule {every:600}. All schedule changes after that went through the UI. In headless Chrome I opened Scheduling > Repeat, expanded "Schedule and next times", picked an option, clicked "Save schedule" and read the row's `.ar-meta` line. The browser's zone was Europe/Stockholm, locale en-US, and the clock read Sun 2026-10-25 22:08 CET.
- "Every N minutes" = 20000: saved as every 168 h. The row said "Next: Sun 10:08 PM". The real nextAt is 2026-11-01T21:08Z, a week away, yet the row reads as today, right now. The collapsed preview correctly listed "Sun, Nov 1, 2026, 10:08 PM GMT+1".
- "At a time" 06:30, zone UTC: the header said "every day at 06:30 (UTC)" while the row said "Next: Mon 07:30 AM". That Next time is browser-local and has no zone label, so the two lines contradict each other.
- 09:15 America/Los_Angeles: the header said "(America/Los_Angeles)" and the row said "Next: Mon 05:15 PM". The tester saw "Sun 05:15 PM" because they ran this before 17:15 CET.
- Sunday only, 09:00 Europe/Stockholm, saved Sunday 22:08: the row said "Next: Sun 09:00 AM". It looks like this morning, already past. The real nextAt is 2026-11-01T08:00Z.

The browser reported no console or page errors. Screenshots are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4653t155/ (002-every-20000.png, 003-at-0630-utc.png, 004-at-0915-la.png, 006-sun-only-0900.png). The log is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4653t155/next.log.

Why it is not by design or caused by the environment:
- docs/automations.md and docs/api.md say nothing about the row format.
- src/automation.ts:217 says "clients format them in both the chosen zone and their local zone". The row does neither: it has no date and no zone.
- Deferred runs (ui/deferred-runs.tsx:9) and the schedule preview (ui/automations.tsx:78) both show full dates.
- The line dates from the original M6 commit 45d491a, before explicit time zones (improvement 47) exi …

</details>

### t15-6 · minor · Missed-schedule catch-up is decided at the first tick (not at startup), and skipped runs are invisible in the UI

**Fix outcome: fixed.** Changes in src/automation.ts:
- load() remembers each past nextAt it kept, in a `resumed` map with the load time.
- tick() judges a kept occurrence against the load time instead of the tick time, unless the computer slept again for more than the grace period after load. So the first tick fires what load() kept, even when that tick is past the hour.
- New recordMissed() logs the skip and writes a schedule event with state 'skipped' and the reason 'Missed the <time in schedule zone> run: code-flow was closed or the computer asleep then…'. It is called when load() moves a missed nextAt on, and when tick() skips one, for managed triggers too.
- load() saves when it recorded a miss.
- docs/automations.md says where skipped times appear.

Fixer's check: f13 (scripts c1.mjs and c2.mjs, original repro). Created three daily 03:00 Europe/Stockholm automations, stopped the server, and wrote nextAt as now-59m40s (catch-a), now-2h (catch-b) and now-58m (catch-c, control). Then restarted it with the default 30 s tick.
- Before the first tick, catch-b had already moved on, with a 'skipped' schedule event 'Missed the Mon 26 Oct, 03:03 CET run…' and a server.log line.
- At the first tick catch-a was 3622 s late and still fired ('started' event, Last: just now (Done)); catch-c fired too.
- The UI 'Preview and events' for catch-b listed the skipped row. errors=[].

Tests: `test/qa-schedule-editor-tz.test.ts: a missed time kept when code-flow comes back fires at the first tick, even past the hour by then`, `test/qa-schedule-editor-tz.test.ts: a time skipped while code-flow was closed or asleep is recorded in the event history`, `test/qa-schedule-editor-tz-server.test.ts: a time missed while code-flow was closed shows in the automation's event history`

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-22.

**Repro**

> 1. Stop the server. In triggers.json set an at-time automation's nextAt to now-59m40s, another to now-2h. 2. Start with the default CODEFLOW_SCHEDULER_TICK_MS=30000. 3. On load the first is kept (within the 1h grace), but the first tick runs 30s later. It is then 60m11s late and skipped: server.log 'skipped its … run: code-flow was closed or asleep then'. 4. The 2h-late and excluded-day schedules move on silently, with no log line at all.

**Expected:** Grace is evaluated against startup time (or a tick runs immediately on start), and skipped occurrences are recorded where the user looks (event history or row).

**Actual:** Anything 59m30s-60m late at startup is lost. All skips are only in server.log (or nowhere), and the automation row and event history show nothing.

**Root cause (verifier):** The catch-up decision is made twice, at two different times, and neither decision is shown to the user.

1. src/automation.ts:347 (load) calls resumeSchedule(t.schedule, t.nextAt, now) using the startup time. resumeSchedule (src/automation.ts:246-252) keeps a past nextAt only if stillDue() at that moment. Otherwise it quietly replaces it with nextFire(now): no log, no event, no field on the trigger (catch-b, catch-d).

2. src/automation.ts:418-421 (start) only calls setInterval(tick, tickMs). The interval comes from src/server.ts:269 (CODEFLOW_SCHEDULER_TICK_MS, default 30000). There is no immediate tick, so the first tick runs tickMs after startup.

3. src/automation.ts:443-469 (tick) checks stillDue(t.schedule, due, now) again with the tick's own now. stillDue (src/automation.ts:233-234) compares that against MISSED_GRACE_MS = HOUR (src/automation.ts:129). A time that load() kept because it was 59m30s-60m late is more than 60m late by the first tick. It is then skipped with only logInfo(...) at src/automation.ts:468.

4. The skip never calls recordEvent/updateEvent (src/automation.ts:603-623) and never sets lastError or lastFiredAt. So the row UI (ui/automations.tsx:342-350) and  …

**Files:** `src/automation.ts`, `src/server.ts`, `ui/automations.tsx`, `docs/automations.md`, `test/automation.test.ts`

**Suggested fix:** 1. Make the grace decision once, at startup. Either:
   (a) have start() run a first tick right away, e.g. setImmediate(() => void this.tick().catch(...)) before or alongside the setInterval, so the time load() kept is fired at startup; or
   (b) have load() note which triggers it kept a past nextAt for (an in-memory Set or a catchUpUntil timestamp), and have tick() evaluate stillDue for those against the load time, so a kept time always fires on the first tick.
   Optionally add one tick of slack (MISSED_GRACE_MS + tickMs) for the computer-asleep case, where the first tick after wake can also come up to tickMs late.

2. Record every skipped occurrence where the user looks. Add a helper, e.g. recordMissed(t, due, reason), that calls recordEvent(t, { via: "schedule" }) and then updateEvent(..., "skipped", `Missed the ${time} run: code-flow was closed or the computer asleep for more than an hour`). Optionally also set a persisted t.lastMissedAt / t.lastMissed, shown on the row as "· miss …

**Suggested regression test:** Add to test/automation.test.ts, next to "a schedule's next time is saved and honoured on load…".

Test 1, startup catch-up:
- Create an every-60 or at-time automation and persist nextAt = T.
- Construct a new Automations on the same file and await load(T + 59*60_000 + 50_000).
- Then await tick(T + 60*60_000 + 20_000), i.e. the first interval tick 30s later. Assert the run started: started deepEquals ["schedule"].
- Alternatively, with fix (a): call start(30_000) and assert a tick ran without ad …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4655m on port 4655 (default CODEFLOW_SCHEDULER_TICK_MS=30000). Scratch clone of MQTT-MCP added as project p-112833bb. Created 5 "every day at 03:00" automations through the API: catch-a, catch-a2, catch-b, catch-c, and catch-d (days Mon-Fri). Stopped the server and wrote nextAt values into triggers.json so they were late by these amounts at write time: catch-a 3580s (59m40s), catch-a2 3550s, catch-b 7200s, catch-c 3480s (control), catch-d 600s (on a Sunday). Restarted right away. The server was healthy 1.2s later.

GET /api/automations before the first tick: catch-a (3581s late), catch-a2 and catch-c kept their past nextAt, so load() decided they could still fire. catch-b and catch-d had already moved to Mon 03:00, with nothing in server.log or server.out.

First tick at 21:10:05.818Z, 30.7s after start. catch-a2 (about 3580s late) and catch-c fired runs, and each got a "started" event. catch-a was about 3611s late by then. It was skipped and its nextAt moved to Mon 03:00. The only trace was a server.log line: "Automation \"catch-a 59m35s\" skipped its 10/25/2026, 9:09:55 PM run: code-flow was closed or asleep then".

GET /api/automations/<id>/events returns [] for catch-a, catch-b and catch-d. In the UI (Scheduling > Repeat), the catch-a row shows only "Next: Mon 03:00 AM", with no Last, no skip note and no error. Its "Preview and events" panel says "No events recorded yet." The catch-a2 row next to it, about 30s less late, shows "Last: just now (Done)". Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4655m/001-v4655m-scheduling.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4655m/002-v4655m-catch-a-events.png. Raw state is in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4655m/after-load.txt and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4655m/after-tick.txt.

Refutation attempts:
- docs/automations.md:28 promises that a missed time "fires once when code-flow is back, if it's at most an hour late". The code checks lateness one tick later instead, so this is not by design.
- The test at test/automation.test.ts:399-422 only says the kept time fires "on the next tick". It never covers the boundary.
- The e …

</details>

### S09-3 · minor · start() does not tick immediately, so a time missed by just under an hour can be skipped at the first tick about 30 s after startup. Interval schedules also drift up to one tick per fire.

**Fix outcome: duplicate.** Duplicate of t15-6; that issue carries the fix (load-time grace decision plus recorded skips). The interval-drift part of the claim was refuted by the verifier and needs no change.

Fixer's check: Same catch-up run as t15-6: an occurrence 59m40s late at startup fired at the first tick 3622 s after it was due. The unit test covers the 59m45s edge (load(T+1h-15s), then tick(T+1h+15s) fires once).

Tests: `test/qa-schedule-editor-tz.test.ts: a missed time kept when code-flow comes back fires at the first tick, even past the hour by then`

Source: code-level suspect at `src/automation.ts:418` (confirmed hands-on).

**Repro**

> Stopped s09, injected triggers into the QA home's triggers.json (every:1440, nextAt = now-59m45s, and a control at now-50m), restarted. Checked server.log and /api/automations after the first tick. Scratch test /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/s09/test/s09-scheduler.test.ts (S3a, S3b) passes, showing the skip and the bounded drift.

**Expected:** docs/automations.md:28: a missed time 'fires once when code-flow is back, if it's at most an hour late'. An occurrence 59m46s late when the server came back should fire.

**Actual:** Live server log: load at 15:01:47.99 kept the 'S3 grace edge' occurrence due 15:02:02 the previous hour (59m46s late). The first tick at 15:02:17.997 logged 'skipped its 3:02:02 PM run: code-flow was closed or asleep then'. A control trigger 50 min late fired on the same tick. Focused test: load(now0) keeps nextAt=now0-59m45s; tick(now0+30s) fires 0 times. The drift part does not hold: a 2 h simulation on a 30 s tick grid with growing timer lateness gave fire gaps of 300006-300015 ms for every:5. Only the first fire after creation or restart lands on the next tick (at most 30 s), and the phase restarting from the fire time matches 'every N minutes'.

**Root cause (verifier):** load() applies resumeSchedule/stillDue against load time, but start() only arms setInterval. tick() evaluates stillDue(schedule, due, now) again with now = first tick time (30 s or more after start, plus startup delay), so an occurrence inside the grace window at startup can fall outside it by the first tick.

**Suggested fix:** In start(), run one tick right away (void this.tick()) after arming the interval. Or mark occurrences resumed in grace at load (e.g. a transient graceUntil = loadTime-based flag) so the first tick fires them even if it is a few seconds past the hour. Interval schedules need no change.

**Suggested regression test:** Automations unit test: triggers.json with every:1440 and nextAt = now0-(1h-15s); await load(now0); await tick(now0+30_000); expect exactly one fire. Or: start() then expect a fire before the first interval elapses.

### t15-12 · minor · Interval validation: confusing 'Repeat at most every 5 minutes', silent clamp to 10080, silent defaults, every+at accepted

**Fix outcome: fixed.** New file src/schedule-rules.ts, browser-safe, with validateSchedule moved there and re-exported from src/automation.ts:
- MIN_EVERY_MINUTES=5 and MAX_EVERY_MINUTES=10080.
- Messages: 'Runs must be at least 5 minutes apart', 'Runs can be at most 10080 minutes (7 days) apart' (no more clamping) and 'Choose a whole number of minutes between runs'.
- every+at is rejected ('Choose either every (minutes) or at (HH:MM), not both'), and so is every with days or timezone.

ui/automations.tsx SaveAutomationDialog:
- Keeps the interval as typed text, so an emptied field stays empty: no snap back to 60, no '6015'.
- draftProblem() runs the same rules client-side and disables Save automation. It shows the reason once, in the preview.
- Adds max=10080 and step=1 to the input. The save error clears when the fields change.
- ui/styles.css widens .num so five digits fit.

ScheduleEditor gets the same han …

Fixer's check: f13 (a3.mjs).
- Dialog with Repeatedly, 3 minutes: 'Runs must be at least 5 minutes apart' shown once in the dialog, Save disabled.
- Backspace twice from 60 gave '6' then '' (stays empty); the preview said 'Enter the minutes between runs' and Save was disabled. Typing 15 gave '15'.
- 20000 gave 'Runs can be at most 10080 minutes (7 days) apart', Save disabled, and the field fits five digits.
- Saving 15 stored {every:15}.
- API: {every:'x'} returned 400 'Choose a whole number…'. {every:10, at:'07:00'} and {every:10, at:'nonsense', days:['bad']} returned 400 'Choose either every (minutes) or at (HH:MM), not both'. {every:20000} returned 400.
- errors=[].

Tests: `test/qa-schedule-editor-tz.test.ts: intervals are 5 to 10080 whole minutes, said the right way round, and never clamped; a schedule is an interval or a time`, `test/qa-schedule-editor-tz.test.ts: the editor says why its fields can't be saved, before they're sent`, `test/qa-schedule-editor-tz-server.test.ts: interval and zone rules: no clamping, no ambiguous schedules, current zone names`, `test/e2e/qa-schedule-editor-tz.e2e.ts: the save-automation dialog keeps an emptied interval empty and blocks what it can't save`

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-06, SCH-13.

**Repro**

> 1. Save automation > Repeatedly. 2. Enter 3: error 'Repeat at most every 5 minutes', shown twice (preview error and save error). 3. Clear the field: it silently becomes 60. 4. Enter 20000: saved as {every:10080} ('every 168 h') while the field still shows 20000. 5. API schedule-preview {every:'x'} returns the same 'at most' text, and {every:10, at:'07:00'} is accepted as every 10.

**Expected:** Wording like 'Repeat at most once every 5 minutes / at least 5 minutes apart', a visible max (10080) or rejection, and rejection of ambiguous every+at.

**Actual:** As described.

**Root cause (verifier):** - src/automation.ts:138-141 (validateSchedule): `if (raw.every !== undefined)` runs first and returns `{every}` straight away, so `at`, `days` and `timezone` are never looked at. That is why every+at, and even an invalid `at`, are accepted.
- src/automation.ts:140: the same message, `Repeat at most every ${MIN_EVERY_MINUTES} minutes`, covers both a non-numeric value and a value under 5. "At most every 5 minutes" reads as the opposite of the rule, which docs/automations.md:24 states as "at least 5".
- src/automation.ts:141: `Math.min(every, 7 * 24 * 60)` silently clamps to 10080. The constant has no name and no comment, and no maximum is documented.
- ui/automations.tsx:508 (SaveAutomationDialog): `setEvery(Number(e.currentTarget.value) || 60)` turns an empty field (and 0) into 60. Because the input is controlled, the field snaps back to "60" while the user is deleting digits, which produces values like 6015. The input has no `max`.
- ui/automations.tsx:92 (ScheduleEditor): has `max={10080}`, but nothing enforces it or warns about it.
- ui/automations.tsx:79 and :535: SchedulePreview and the dialog each render the same server error. The dialog's `error` state is only cleared when Sa …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/automation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/automation.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/automations.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`

**Suggested fix:** Server, in validateSchedule (src/automation.ts):
- Add `MAX_EVERY_MINUTES = 7 * 24 * 60`.
- Reject a schedule that has both `every` and `at` with "Choose either every (minutes) or at (HH:MM), not both".
- Reject a non-integer or non-finite value with "Repeat interval must be a whole number of minutes".
- Reject values outside the range with "Runs must be at least 5 minutes apart" and "Runs can be at most 10080 minutes (7 days) apart", instead of clamping.
- Stored triggers already go through readTrigger (src/automation.ts:940), which flags a bad schedule as "couldn't be read; set it again". Saved values were always clamped to 10080 or less, so existing data still loads.

UI (ui/automations.tsx):
- In SaveAutomationDialog, keep the raw string in state (`everyText`), so an empty field stays empty.
- Derive `every = Number(everyText)` and disable Save, with an inline hint, when the field is empty or out of range. Do not fall back to 60.
- Add `max={10080}` to the input and widen `.num` so …

**Suggested regression test:** Unit tests in test/automation.test.ts, in the existing validateSchedule test near line 65:
- `assert.throws(() => validateSchedule({ every: 3 }), /at least 5 minutes/)`
- `assert.throws(() => validateSchedule({ every: "x" }), /whole number/)`
- `assert.throws(() => validateSchedule({ every: 20000 }), /10080|7 days/)`
- `assert.throws(() => validateSchedule({ every: 10, at: "07:00" }), /either/)`
- `assert.deepEqual(validateSchedule({ every: 10080 }), { every: 10080 })`

Browser e2e for the Save  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server under a new home: `qa-server.sh start v4667-t1512 4667 fake`. The name v4667 already had a home left over from an earlier session, so I did not reuse it. My script was /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4667-t1512/r1.mjs and its output is in r1.log in the same folder. In headless Chrome I went to MQTT-MCP project, then Automation > Repeat > Configure a repeating task, typed a task, opened Schedule… > Repeat and picked "Repeatedly" in the "Save as automation" dialog.

What I saw:
1. Typing 3 shows "Repeat at most every 5 minutes" under the preview ("Calculating…" stays on screen). Pressing Save shows the same text a second time at the bottom of the dialog. The save error stays visible after I changed the value to a valid 20000, until the next save (screenshots 002-every-3-save.png and 003-every-20000-before-save.png in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4667-t1512/).
2. fill("") makes the field show "60" and the preview show hourly times.
3. Something worse than reported: I put the cursor at the end of "60" and pressed Backspace twice. The first press gives "6". The second gives "" and the field snaps back to "60". Typing "15" then produces "6015", and the preview shows runs about 4 days apart. A user cannot clear the field and type a new number.
4. 20000: the field still shows 20000, but the preview steps weekly (Nov 1, 8, 15…). Saving gives `{"schedule":{"every":10080},"scheduleText":"every 168 h"}`. No message says the value was changed. The input has min=5 and no max attribute, and it is too narrow, so the field displays ")000".
5. In the row's "Schedule and next times" editor, the field has max=10080, but 20000 still previews weekly with no warning. Clearing that field gives 0 and the same "at most" error.
6. API calls to /api/automations/schedule-preview:
   - {every:"x"} → 400 "Repeat at most every 5 minutes"
   - {every:3} → 400, same text
   - {every:20000} → 200 with weekly times
   - {every:10, at:"07:00"} → 200 with times 10 minutes apart
   - {every:10, at:"nonsense", days:["bad"]} → 200. `at` and `days` are never validated when `every` is present.

The only errors in the console were the expected 400s. I checked whether this is by design: docs/automations.md:24 says "every N minutes (at least 5)", docs/api.md:238 says only "{every: min …

</details>

### S07-6 · minor · Interval schedules under 5 minutes fail with 'Repeat at most every 5 minutes', which means the opposite of the real rule (at least 5 minutes).

**Fix outcome: duplicate.** Duplicate of t15-12; that issue carries the new wording in src/schedule-rules.ts.

Fixer's check: f13 (a3.mjs). A 3-minute interval in the Save as automation dialog shows 'Runs must be at least 5 minutes apart' once, with no 'Calculating…'. Save automation is disabled and nothing is saved.

Tests: `test/qa-schedule-editor-tz.test.ts: intervals are 5 to 10080 whole minutes, said the right way round, and never clamped; a schedule is an interval or a time`

Source: code-level suspect at `src/automation.ts:140` (confirmed hands-on).

**Repro**

> UI on fake QA s07 (scratch project 'S07 Auto'): composer → Run actions → Schedule… → Repeat → 'Repeatedly' → Minutes 3. The schedule preview immediately shows alert 'Repeat at most every 5 minutes', together with a stuck 'Calculating…' line. Clicking 'Save automation' shows the same error and nothing is saved (GET /api/automations -> []). Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s07/002-every-3-save.png. docs/automations.md says 'every N minutes (at least 5)'. The same message appears from Scheduling → Repeat → 'Schedule and next times' (ScheduleEditor) and the project-team mission schedule editor, since all use validateSchedule.

**Expected:** A message such as 'Repeat at most once every 5 minutes' or 'Choose an interval of at least 5 minutes'.

**Actual:** 'Repeat at most every 5 minutes' reads as 'the interval may be at most 5 minutes', which contradicts the user's 3-minute entry and the docs.

**Root cause (verifier):** Wrong wording in validateSchedule: `throw new Error(`Repeat at most every ${MIN_EVERY_MINUTES} minutes`)`.

**Suggested fix:** Change the text to `Choose an interval of at least ${MIN_EVERY_MINUTES} minutes`. Optionally have SchedulePreview hide 'Calculating…' when it has an error.

**Suggested regression test:** Unit test in test/automation*.test.ts: assert.throws(() => validateSchedule({ every: 3 }), /at least 5 minutes/), and validateSchedule({ every: 5 }) returns { every: 5 }.

### S10-2 · minor · The ScheduleEditor Minutes input max is 10080, but typed values above it are sent and silently clamped by validateSchedule (src/automation.ts:141), with no feedback to the user.

**Fix outcome: duplicate.** Duplicate of t15-12; that issue removes the clamp and adds client-side validation to ScheduleEditor. The editor also reseeds from the saved schedule after a save (t26-2/t15-17), so the field shows what was stored.

Fixer's check: f13 (a1.mjs). In the row editor, 'Every N minutes' with 20000 shows 'Runs can be at most 10080 minutes (7 days) apart' in the preview, and Save schedule is disabled. Changing to 10080 saved {every:10080}.

Tests: `test/e2e/qa-schedule-editor-tz.e2e.ts: the row editor refuses fields it can't save with one reason, and shows what was saved`

Source: code-level suspect at `ui/automations.tsx:92` (confirmed hands-on).

**Repro**

> Fake server s10. Precondition: a webhook-only automation created by API. Under Scheduling > Repeat > 'Schedule and next times', I chose Schedule 'Every N minutes' and typed 20000 in Minutes. The input was :invalid (validity.rangeOverflow=true) but showed no error styling or message. I clicked 'Save schedule': no toast. The stored schedule was {"every":10080} (scheduleText 'every 168 h'), and the Minutes field still showed 20000. The preview listed runs a week apart, which hints at the clamp only indirectly. Script: work/s10/11-schedule-clamp.mjs. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s10/002-schedule-after-save.png

**Expected:** A value above the 7-day maximum is refused with a message (as values below 5 are), or the editor shows that it will run every 10080 minutes.

**Actual:** Saved as 10080 (twice as often as the requested 20000). The editor keeps showing 20000. The only signals are the preview dates and the 'every 168 h' row label. docs/automations.md mentions only the minimum of 5.

**Root cause (verifier):** validateSchedule returns { every: Math.min(every, 7*24*60) } and does not throw. The input is not inside a form, so the browser's max constraint is never enforced or shown. ScheduleEditor initialises its state from the automation once and does not re-sync after save.

**Suggested fix:** Reject every > 10080 in validateSchedule with 'Repeat at least every 7 days (10080 minutes)', or validate in the UI: show an inline error and disable 'Save schedule' when every is outside 5..10080. Re-key or re-sync ScheduleEditor from the saved schedule so the field shows what is stored. Document the maximum in docs/automations.md.

**Suggested regression test:** Unit: validateSchedule({every: 20000}) throws a clear error. UI e2e: typing 20000 shows an alert and Save is disabled, or after save the field equals the stored value.

### t15-17 · cosmetic · Time zone 'asia/kolkata' is saved and shown as the legacy alias 'Asia/Calcutta'

**Fix outcome: fixed.** src/schedule-rules.ts canonicalTimeZone() resolves a zone through Intl, which validates it and fixes letter case. It then maps ICU's legacy primary names to current IANA names through a commented table (Asia/Calcutta to Asia/Kolkata, Europe/Kiev to Europe/Kyiv, Asia/Saigon to Asia/Ho_Chi_Minh, and others). validateSchedule uses it, and so do stored triggers and project-team schedules when they are read or synced. Firing is unchanged. The ui/schedule-draft.ts localTimezone() default uses it too, and the ScheduleEditor field reseeds to the stored value after a save.

Fixer's check: f13 (a2.mjs). Typing 'asia/kolkata' and saving stored Asia/Kolkata, the header read 'every day at 03:00 (Asia/Kolkata)' and the field showed 'Asia/Kolkata' without a reload. Typing Europe/Kyiv stored Europe/Kyiv.

Tests: `test/qa-schedule-editor-tz.test.ts: time zones are saved by their current IANA names, with the letter case fixed`, `test/e2e/qa-schedule-editor-tz.e2e.ts: the row editor refuses fields it can't save with one reason, and shows what was saved`

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-11.

**Repro**

> 1. In a row editor, type 'asia/kolkata' as the zone and Save schedule. 2. The row shows '(Asia/Calcutta)' and the field still shows 'asia/kolkata'.

**Expected:** Canonical modern name (Asia/Kolkata), and the field synced to the saved value.

**Actual:** Legacy alias returned by Intl resolvedOptions.

**Root cause (verifier):** There are two causes.

1. src/automation.ts:150, in validateSchedule: `timezone = new Intl.DateTimeFormat("en", { timeZone: raw.timezone.trim() }).resolvedOptions().timeZone`. This is meant to validate the zone and fix its letter case, but V8/ICU also swaps current IANA names for its legacy primary IDs: Asia/Kolkata becomes Asia/Calcutta, Europe/Kyiv becomes Europe/Kiev, Asia/Ho_Chi_Minh becomes Asia/Saigon, Asia/Kathmandu becomes Asia/Katmandu, and so on. It does this even when the modern name is typed exactly. The stored value then flows to describeSchedule (src/automation.ts:259, the "(Asia/Calcutta)" row text via src/server.ts:995) and to the reloaded editor.

2. ui/automations.tsx:86 and ui/automations.tsx:352: ScheduleEditor sets its timezone state from a.schedule only once, in useState. The automation row mounts it without a key, so the field keeps the typed text after Save until the page reloads. ui/project-teams.tsx:128 avoids this by passing key={JSON.stringify(schedule)}.

Related: ui/automations.tsx:65 (localTimezone), ui/project-teams.tsx:75 and ui/ml/schedules.tsx:4 take their default zone from the browser's resolvedOptions().timeZone, so a user in India also gets "As …

**Files:** `src/automation.ts`, `ui/automations.tsx`, `test/automation.test.ts`, `test/e2e/automation-controls.e2e.ts`

**Suggested fix:** 1. Add one shared helper, normalizeTimeZone(input), in src/ (for example src/time-zone.ts or inside src/automation.ts) that both the server and the UI import. It should:
   - Validate the input with Intl.DateTimeFormat; it throws on an invalid zone.
   - Take `resolved` from resolvedOptions().timeZone.
   - Return `CURRENT_IANA_NAME[resolved] ?? resolved`, using a small frozen table that maps ICU legacy primaries to current IANA names. That table covers: Asia/Calcutta→Asia/Kolkata, Europe/Kiev→Europe/Kyiv, Asia/Saigon→Asia/Ho_Chi_Minh, Asia/Katmandu→Asia/Kathmandu, Asia/Rangoon→Asia/Yangon, America/Godthab→America/Nuuk, Pacific/Enderbury→Pacific/Kanton, Atlantic/Faeroe→Atlantic/Faroe, Pacific/Truk→Pacific/Chuuk, Pacific/Ponape→Pohnpei, America/Buenos_Aires→America/Argentina/Buenos_Aires, and so on. Add a comment explaining why the table exists.
   This keeps the case fixing ("asia/kolkata" becomes "Asia/Kolkata") and stores the modern name. Firing is unchanged because the names are ali …

**Suggested regression test:** Unit (test/automation.test.ts, next to the time-zone test at line 72): assert that validateSchedule({at:"07:00", timezone:"asia/kolkata"})?.timezone equals "Asia/Kolkata"; that "Asia/Kolkata" stays "Asia/Kolkata"; that "Europe/Kyiv" stays "Europe/Kyiv"; that "europe/stockholm" becomes "Europe/Stockholm" (case fixing kept); that "Not/AZone" still throws /IANA/; and that nextFire for Asia/Kolkata equals nextFire for Asia/Calcutta.

e2e (test/e2e/automation-controls.e2e.ts, after the America/New_Yo …

<details><summary>Verifier's independent reproduction</summary>

Server: started a fake-mode QA server, v4677 on 127.0.0.1:4677. Its home had no triggers.json and no live runs (only one old .deleted run tombstone), so automation state was fresh.

Setup (API): created a disabled automation, "TZ alias QA", with schedule {at:"03:00", timezone:"Europe/Stockholm"}, pointing at a scratch git repo.

UI script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4677/tz-alias.mjs (log: tz-alias.log in the same folder). In a fresh headless Chrome it opened /#/settings/automations, expanded "Schedule and next times" on the row, filled the Time zone field and clicked "Save schedule". For each value it waited for the 15 s row poll, then read the saved value back from the API.

Results:
- Typed "asia/kolkata": saved as Asia/Calcutta. The row shows "every day at 03:00 (Asia/Calcutta)" but the field still shows "asia/kolkata".
- Typed "Asia/Kolkata" (the exact modern name): also saved as Asia/Calcutta; the field still shows "Asia/Kolkata". Screenshot: shots/v4677/002-after-save-Asia_Kolkata.png.
- Typed "Europe/Kyiv": saved as Europe/Kiev; the field still shows "Europe/Kyiv".
- After a page reload the field finally shows the saved legacy name ("Europe/Kiev").
- The preview before saving uses the typed name ("Next runs in Asia/Kolkata", GMT+5:30), so the preview and the saved row disagree.
- Fire times are correct: same offset, valid IANA link name. No console errors and no 5xx responses.

Direct check (Node 22.14, ICU 76.1, tz 2024b): new Intl.DateTimeFormat("en",{timeZone:"Asia/Kolkata"}).resolvedOptions().timeZone returns "Asia/Calcutta". Kyiv, Ho_Chi_Minh and Kathmandu behave the same way. Intl.supportedValuesOf("timeZone") lists only the legacy names. Headless Chrome also returns Asia/Calcutta.

Why not by design: docs/api.md:236 only specifies "IANA/Zone", and no code comment explains the canonicalization. The existing tests (test/automation.test.ts:72-86, test/e2e/automation-controls.e2e.ts:58-60) only use zones that are unaffected (Europe/Stockholm, America/New_York). ML schedules (src/ml/schedule-model.ts:30) validate the same way but store the input as typed, so the two paths disagree.

Cleanup: deleted the automation (200; GET /api/automations returns []), no runs created, stopped v4677 (ports 4677 and 4678 free), removed the scratch repo.

</details>

### t15-20 · minor · Schedule preview shows 'Calculating…' together with the validation error; Save stays enabled for an invalid zone

**Fix outcome: fixed.** ui/automations.tsx SchedulePreview takes a `problem` prop from draftProblem(). With a problem it does not call the server and shows only that alert. It keeps results keyed by schedule, so times from an earlier schedule are never formatted under a new zone (the five 'Choose a valid time zone' rows are gone). 'Calculating…' appears only while a request is pending, and the DST note only next to real times. SaveAutomationDialog disables Save automation, and ScheduleEditor disables Save schedule, while a problem exists: invalid or empty required zone, no days, bad interval.

Fixer's check: f13.
- Dialog (a3.mjs), zone Mars/Olympus: only 'Choose a valid IANA time zone…'. 'Calculating…' count 0, list items 0, Save disabled.
- Dialog, empty zone: 'Choose a time zone, such as Europe/Stockholm', Save disabled.
- Row editor (a2.mjs), Mars/Olympus or all days unchecked: one alert, 'Calculating…' count 0, Save schedule disabled.
- errors=[].

Tests: `test/e2e/qa-schedule-editor-tz.e2e.ts: the row editor refuses fields it can't save with one reason, and shows what was saved`, `test/e2e/qa-schedule-editor-tz.e2e.ts: the save-automation dialog keeps an emptied interval empty and blocks what it can't save`

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-05, SCH-11.

**Repro**

> 1. Save automation dialog: type zone 'Mars/Olympus', or uncheck all days in the row editor. 2. 'Next runs' shows 'Calculating…' and the error below it. 3. 'Save automation' is still enabled and fails on click.

**Expected:** Show only the error and disable Save until it is valid.

**Actual:** Mixed messages.

**Root cause (verifier):** - ui/automations.tsx:79 (SchedulePreview render): `times.length ? <ol>…</ol> : <p class="help">{schedule ? "Calculating…" : "No schedule"}</p>` only checks whether times is empty. After a failed preview, the rejection handler at line 74 sets times to [] and error to err.message. So "Calculating…" renders permanently together with `{error ? <p class="msg err" role="alert">…}`. There is no loading state at all.
- ui/automations.tsx:72-78: when the schedule key changes, the old times are kept for the 200 ms debounce. The format() function (line 78) re-renders them with the new, invalid timeZone, and its catch prints "Choose a valid time zone" once per row.
- ui/automations.tsx:541 (SaveAutomationDialog): `disabled={saving || !name.trim() || kind === "daily" && !days.length}`. Save only knows the name and days. It cannot see the preview's error or check whether the time zone is valid, so an invalid or empty zone is only rejected by the server (src/automation.ts:148-151 via src/server.ts:2212).
- ui/automations.tsx:94 (ScheduleEditor, row editor): the "Save schedule" button has no disabled condition at all. Both an invalid zone and no days (src/automation.ts:145) are only caught after t …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/automation-controls.e2e.ts`

**Suggested fix:** 1. Give SchedulePreview an explicit status ("loading" | "ok" | "error"):
   - When the schedule key changes, clear times (or mark them stale) and set status to loading.
   - Render "Calculating…" only while loading.
   - On error, render only the alert: no "Calculating…" and no stale times.
   - Also render the DST note only when status is ok.
   - This removes the brief list of five "Choose a valid time zone" rows.
2. Let the parents see whether the schedule is valid, either with an `onValidity?(valid: boolean, error?: string)` prop or by moving the fetch into a `useSchedulePreview(schedule)` hook that returns `{ times, error, loading }`.
3. Add a cheap synchronous client-side check, `isValidTimeZone(tz) = tz.trim() && (() => { try { new Intl.DateTimeFormat("en", { timeZone: tz.trim() }); return true } catch { return false } })()`, mirroring src/automation.ts:149-151, so Save can be disabled immediately without waiting for the debounce.
4. SaveAutomationDialog (line 541): also disable …

**Suggested regression test:** Extend test/e2e/automation-controls.e2e.ts with two checks.

Row editor: on the "Automation QA" row, open "Schedule and next times" and fill Time zone with "Mars/Olympus". Then assert:
- `row.getByLabel("Next scheduled times").getByRole("alert")` contains "Choose a valid IANA time zone".
- `row.getByLabel("Next scheduled times").getByText("Calculating…")` has count 0.
- The "Save schedule" button is disabled.
Then restore a valid zone, uncheck all seven day checkboxes in the fieldset, and assert …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server ("qa-server.sh start v4683 4683 fake") at http://127.0.0.1:4683 with project MQTT-MCP (p-ef01794b). The scripts are /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4683/r1-preview.mjs (Save dialog) and r2-row.mjs (row editor). Logs are r1.log and r2.log in the same folder.

Save as automation dialog (Scheduling > Repeat > Configure a repeating task, type a task, switch the builder to Claude Code in Run options, Run actions > Schedule… > Repeat):
- Default: 5 next times shown, Save enabled.
- Time zone set to "Mars/Olympus":
  - Within the 200 ms debounce the preview briefly lists "Choose a valid time zone" five times. The old times are re-formatted with the invalid zone.
  - After 1.5 s and still after 5.5 s it shows "Next runs in Mars/Olympus: | Calculating… | Runs once per local day… | Choose a valid IANA time zone, such as Europe/Stockholm". That is one role=alert plus one "Calculating…" that never goes away.
  - Save automation stays enabled. Clicking it keeps the dialog open with the inline error "Choose a valid IANA time zone, such as Europe/Stockholm" and saves nothing (/api/automations returns []).
- Empty zone: "Next runs: | Calculating… | Choose a valid IANA time zone…" and Save is still enabled.
- All days off in the dialog: "Calculating…" plus "Choose at least one valid day of the week", but here Save automation IS disabled. The reporter's "Save stays enabled" claim does not hold for the no-days case in this dialog.

Row schedule editor (Scheduling list > automation row > "Schedule and next times" > At a time), tested on a webhook-only automation I saved through the dialog:
- Zone "Mars/Olympus": "Calculating…" plus the error, and Save schedule is enabled. Clicking it shows the toast "Choose a valid IANA time zone…" and the schedule is unchanged.
- All 7 days unchecked: "Calculating…" plus "Choose at least one valid day of the week", and Save schedule is enabled. Clicking it shows the toast "Choose at least one valid day of the week" and the schedule is unchanged.

Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4683/001-v4683-invalid-zone.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4683/002-v4683-row-no-days.png. The only console errors were the expected 400s …

</details>

### t16-16 · minor · Daily sweep time is saved in server local time without saying so in the dialog

**Fix outcome: fixed.** ui/sweeps.tsx: 'Also check every day at' sends {at, timezone: localTimezone()} and shows the zone beside the time: 'Also check every day at [time] (Europe/Stockholm) and start runs…'. docs/automations.md and docs/github.md say the time uses the browser's zone. Older sweeps saved without a zone keep server local time and are shown that way (t15-4).

Fixer's check: f13b (TZ=America/Los_Angeles server, Stockholm browser), script b2.mjs: Fix open issues, then tick 'Also check every day at' and set 09:00.
- The label read 'Also check every day at (Europe/Stockholm) and start runs for new ones (up to 5 each time)'.
- The captured POST /api/sweeps schedule was {at:'09:00', timezone:'Europe/Stockholm'}.
- The saved automation reads 'every day at 09:00 (Europe/Stockholm)', nextAt 08:00Z, which is 09:00 for the user.
- errors=[].

Tests: `test/e2e/automation-controls.e2e.ts (edited: sweep context timezoneId America/New_York; asserts schedule {at:'08:30', timezone:'America/New_York'})`

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-35.

**Repro**

> 1. In a sweep dialog, tick 'Also check every day at' and set 03:00.
> 2. Start, then look at the saved automation.

**Expected:** The dialog states the time zone, or saves the browser's time zone as the Repeat dialog does.

**Actual:** The POST sends schedule {at:'03:00'} with no timezone. Only the saved row says 'every day at 03:00 (server local time)'. A user on a phone or remote browser in another zone gets a different run time from the one they picked.

**Root cause (verifier):** - **ui/sweeps.tsx:162** sends `schedule: repeat ? { at } : undefined` with no timezone. Nearby, ui/sweeps.tsx:64 keeps only `at` state, and the label at ui/sweeps.tsx:330-331 names no zone.
- **src/server.ts:787-790** saves it as is. `validateSchedule` (src/automation.ts:147-153) adds a timezone only when one is given, so `nextFire` (src/automation.ts:205-215) uses the server process's local `Date`. `describeSchedule` (src/automation.ts:259) then appends "(server local time)".
- **ui/automations.tsx:86** compounds it. For a saved schedule with no zone, `ScheduleEditor` falls back to `current.timezone ?? localTimezone()`, then previews and offers to save `{at, timezone: <browser zone>}`. So the edit form shows the browser zone and wrong next times for a schedule that actually fires in server local time.
- The Repeat form already sends the zone: ui/automations.tsx:430 holds `useState(localTimezone())` and line 446 sends `{ at, days, timezone }`.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/sweeps.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/automation-controls.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/github.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/automations.md`

**Suggested fix:** 1. In ui/sweeps.tsx, send the browser zone the way the Repeat form does. Export the `localTimezone` helper from ui/automations.tsx (or move it to ui/lib.ts) and use `schedule: repeat ? { at, timezone: localTimezone() } : undefined`.
2. Show the zone in the dialog, for example "Also check every day at [03:00] (Europe/Stockholm) …". Optionally add an editable zone field like the Repeat form's "Automation time zone", or show `SchedulePreview` when repeat is ticked.
3. In ui/automations.tsx `ScheduleEditor`, stop presenting a zone-less schedule as if it ran in the browser zone. When `current.timezone` is undefined, either:
   - show "Server local time" and preview without a timeZone override, labelled as server time; or
   - prefill the browser zone but show a visible note that saving changes it from server local time.
4. Optionally migrate existing zone-less sweep automations. Server-side normalisation is not enough here, because the server cannot know the browser's zone.
5. Update docs/g …

**Suggested regression test:** Assertion changes in test/e2e/automation-controls.e2e.ts:
- **Line 210:** replace `assert.deepEqual(submitted.schedule, { at: "08:30" })` with an assertion that `submitted.schedule` deep-equals `{ at: "08:30", timezone: <zone> }`. Create the sweepPage browser context with an explicit `timezoneId` (for example "America/New_York") so `<zone>` is deterministic and differs from the server's zone.
- **In the same test:** assert the dialog shows the zone text next to "Time of day".
- **After the real  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4625 on 127.0.0.1:4625. The home had no runs or automations. fake-gh.json held one open issue (#41). The server ran in the machine zone, Europe/Stockholm (CET).

The script was /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4625/sweep-tz.mjs. It used headless Chrome with a browser context set to timezoneId America/New_York, standing in for a phone or remote browser.

Steps through the UI:
1. Opened #/project/p-ef01794b/automation/backlog (MQTT-MCP) and clicked "Fix open issues".
2. Set "Done when" to `true`, ticked "Also check every day at" and set Time of day to 03:00.
3. Clicked "Start 1 run".

What I saw:
- The dialog's only text is "Also check every day at [03:00] and start runs for new ones (up to 5 each time)". It names no time zone (screenshot shots/v4625/001-sweep-dialog-0300.png).
- The captured POST /api/sweeps body had schedule `{"at":"03:00"}`, with no timezone.
- The saved automation is schedule `{at:"03:00"}`, scheduleText "every day at 03:00 (server local time)", nextAt 1792980000000. That instant is Mon 26 Oct 03:00 CET, which is Sun 25 Oct 22:00 in New York. The user picked 03:00 and gets 22:00 the evening before.

Worse than reported: on the saved row (Project → Automation → Scheduled backlog work, shots/v4625/021-sweep-editor.png) three statements contradict each other:
- "every day at 03:00 (server local time)"
- "Next: Sun 10:00 PM" (correct, shown in browser time)
- The "Schedule and next times" editor prefills Time zone "America/New_York" and previews "Next runs in America/New_York: Mon, Oct 26, 2026, 03:00 AM EDT …". The server never fires at those times.

No console, page or 5xx errors.

Trying to refute it:
- docs/api.md:236-238 documents that an omitted timezone falls back to server local time. That is an API compatibility fallback, not a UI decision.
- Every other scheduling UI defaults to the browser zone: the Repeat form (ui/automations.tsx:430/446), ScheduleEditor (:86), ML schedules (ui/ml/schedules.tsx:4) and project teams (ui/project-teams.tsx:75). docs/application-improvements.md item 47 is "Explicit schedule time zones and previews".
- History shows an oversight. The sweep dialog's `{ at }` schedule came first (ead0e56, 2026-10-16). Time zones were added two days later (daf3108, 2026-10-18) and were never wired into ui/sweeps.tsx.
- The only thing pinning the current shape is test/e2e/automation-controls.e2e.ts:210, `as …

</details>

### S08-2 · minor · 'Also check every day at…' saves schedule {at} with no timezone, so the recurring sweep runs in server local time even though the UI implies the browser's local time.

**Fix outcome: duplicate.** Duplicate of t16-16; that issue carries the fix in ui/sweeps.tsx.

Fixer's check: Same run as t16-16 on f13b (LA server, Stockholm browser): the sweep was saved with timezone Europe/Stockholm, nextAt 08:00Z (09:00 CET), not 16:00Z.

Tests: `test/e2e/automation-controls.e2e.ts (sweep schedule carries the browser zone)`

Source: code-level suspect at `ui/sweeps.tsx:162` (confirmed hands-on).

**Repro**

> QA server s08 was started with TZ=America/Los_Angeles. Playwright browser used timezoneId Europe/Stockholm. Project s08-proj > Automation > Process a backlog > Fix open issues: selected #41, checked 'Also check every day at', set 09:00, Start 1 run. GET /api/automations then returned schedule {"at":"09:00"}, scheduleText 'every day at 09:00 (server local time)', nextAt 2026-10-26T16:00:00Z. That is 17:00 CET for the Stockholm user who picked 09:00. The dialog had no time-zone indication (screenshot 62049-sweep-repeat-checked.png).

**Expected:** The daily sweep fires at 09:00 in the zone of the user who picked it, saving {at, timezone: browser zone}, as every other schedule editor does. At minimum the dialog should say the time is server local time.

**Actual:** It fires at 09:00 server time (8 hours later for this user). Only the saved automation's card later says '(server local time)'.

**Root cause (verifier):** SweepPicker.start posts `schedule: repeat ? { at } : undefined` with no timezone and no days. docs/api.md says an omitted timezone means server local time. The other schedule UIs (SaveAutomationDialog, ScheduleEditor, project teams) send Intl...resolvedOptions().timeZone. The sweep dialog shows no zone and no SchedulePreview.

**Suggested fix:** In ui/sweeps.tsx send `schedule: repeat ? { at, timezone: localTimezone() } : undefined` (export localTimezone from automations.tsx). Optionally render <SchedulePreview schedule={{ at, timezone }} /> next to the checkbox. Server /api/sweeps already validates the schedule through validateSchedule.

**Suggested regression test:** Browser test with a page timezoneId different from the server TZ: start a sweep with the repeat box checked and assert the saved automation's schedule.timezone equals the browser zone and nextAt equals 09:00 in that zone. Alternatively, a UI unit test asserting the POST /api/sweeps body includes schedule.timezone.
