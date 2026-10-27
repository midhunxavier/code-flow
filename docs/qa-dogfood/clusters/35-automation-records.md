# Cluster 35 · automation-records

**Automation records & routes: deleted projects, no-trigger automations, stale lastError, 500s, unknown kinds**

Status: **fixed and verified (isolated fake-agent QA)** · 13 issues · branch `codex/qa-automation-records`

Planner notes: Covers Automations.update/remove/load in src/automation.ts, the routes in src/server.ts and AutomationRow in ui/automations.tsx. t15-7: deleting a project leaves its automations bound to it forever (explicit projectSelection); rehome them or allow reassignment. t15-8: the rule that an automation needs a schedule or a webhook is enforced only on create. t15-9/S09-6: update() never clears lastError ('Turned off: …'). t15-10: a corrupt triggers.json shows 'None yet', and saving returns 500 because requireWritable throws a plain Error. t15-11/t12-11: the edit/delete guards for managed (mission) triggers throw a plain Error, giving 500; use a 4xx error class. t15-14/t00-9/S01-4: ui/navigation.ts:39 accepts any automations kind; validate it like the project route does. t15-15: automations without a project are counted as 'in other projects'. t15-19: a double-click on Run now (no in-flight state). t15-23: Docker isolation and image can only be set at create. schedule-editor-tz owns ScheduleEditor and validateSchedule; missions-engine owns the project-team branches of syncProjectTeam/tick. Duplicate groups: [["t15-9","S09-6"],["t15-11","t12-11"],["t15-14","t00-9","S01-4"]]

Likely files: `src/automation.ts`, `src/server.ts`, `ui/automations.tsx`, `ui/navigation.ts`, `ui/scheduling.tsx`, `ui/projects.tsx`, `ui/state.ts`

## Issues

### t15-7 · minor · Deleting a project leaves its automations bound to the deleted project; they fail forever and cannot be reassigned

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-24.

**Repro**

> 1. Create project 't15 Temp' with a repo. Save an automation from its composer (webhook only). 2. Run now: works. 3. Projects (p) > Edit t15 Temp > Delete project. The confirm reads 'Delete the project “t15 Temp”? Its 1 run stay, in no project.' and does not mention automations. 4. Back in Scheduling, Run now gives toast 'Choose an available project before starting' (409). A webhook to it returns 202, then lastError shows the same message.

**Expected:** The delete warns about automations and offers to move or delete them, or the automations fall back to the repo's project, or the UI lets you change their project.

**Actual:** The automation stays listed and enabled but can never start, the webhook still answers 202, and there is no UI to fix it except recreating it. Grammar: 'Its 1 run stay'.

**Root cause (verifier):** Commit 217a659 (PR #44) added a strict project marker and it reached saved automations:
- ui/composer.tsx:198: runBody always sends projectSelection: "explicit".
- ui/automations.tsx:441: SaveAutomationDialog spreads that body into run, so the marker is saved.
- src/server.ts:983: automationRun's keep list includes "projectSelection", so the automation stores it.

Every fire then goes through startFromBody → buildStartInput:
- src/server.ts:878 throws HttpError(409, "Choose an available project before starting") when projectSelection is explicit and projects.get(body.project) is missing. That happens before the engine's placement code.
- If that check were passed, src/server.ts:901 (repo membership check) and :942 (requireProjectRepo) would still fail.
- src/projects.ts:192 also throws when requireRepo is set, even with lenient: true. The engine passes lenient: !!input.trigger at src/engine.ts:5244, and test/projects.test.ts:76 asserts this throw.

So the fallback documented in docs/automations.md:16 and implemented at src/engine.ts:5242-5244 / src/projects.ts:194 cannot run for any automation saved from the composer. The project-first plan (docs/project-first-navigation-plan.md:55 …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/automation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/automation.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/automations.md`

**Suggested fix:** 1. Restore the documented fallback. Keep the strict marker for interactive launches, but stop saving it into automations: drop "projectSelection" from automationRun's keep list (src/server.ts:983). Also have SaveAutomationDialog strip it (ui/automations.tsx:441), like it strips attachments, approvals and branchPrefix. The save-time check at src/server.ts:2214 can still validate strictly by calling buildStartInput({ ...run, projectSelection: body.run?.projectSelection }), so saving into a missing project is refused. Fires then reach the engine's lenient place() and land in the repository's project.

   Existing records already carry the marker. Either strip it when loading automations (src/automation.ts), or ignore projectSelection in startFromBody when extra.trigger is set. The second option relies on the engine's lenient path while still keeping repo-membership safety.

2. In ui/projects.tsx:170, also count automations whose run.project === project.id (the automations signal is alread …

**Suggested regression test:** 1. Server test in test/automation.test.ts (or the server automations route test that already exercises POST /api/automations):
   - Create a project with a repo, save an automation with run { repo, project: P.id, projectSelection: "explicit", ... }, then DELETE /api/projects/P.id.
   - POST /api/automations/:id/run must return 201, and the started run's project must be the repo's other project, or a newly placed one named after the repo.
   - A fire through the webhook must not set lastError.
   …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4657 on port 4657. An earlier v4657 home already existed, so I moved it aside to homes/v4657-prev-* first. I made a throwaway git repo at scratchpad/qa/clones/v4657-temp. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4657/repro.mjs, output in repro.log in the same folder. All steps went through the UI:
1. "Open another repository", then created the project "v4657 Temp" (p-a6b711d3).
2. Project > Automation > Repeat > "Configure a repeating task", More run actions > Schedule… > Repeat > "Only from a webhook" > Save automation. The saved automation t-bc41104f has run.project=p-a6b711d3 and run.projectSelection="explicit".
3. Scheduling > Run now opened run 2610252109-15b96a59, which finished as done in the project.
4. Pressed p, Edit v4657 Temp, Delete project. The confirm said: "Delete the project “v4657 Temp”? Its 1 run stay, in no project." It does not mention automations, and "Its 1 run stay" is ungrammatical. Afterwards the automation still exists, is enabled and keeps run.project=p-a6b711d3.
5. Run now showed the toast "Choose an available project before starting", and POST /api/automations/:id/run returned 409.
6. POST /hooks/:id returned 202 {"accepted":true}. lastError then read "Choose an available project before starting", the event was recorded as failed, and the row showed in red "couldn't start: Choose an available project before starting" (screenshot shots/v4657/004-row-after-webhook.png).
7. With "Preview and events" open, the row's only controls are: on switch, Preview and events, Run now, Webhook, Delete, a schedule select, Save schedule, Refresh preview and Retry event. Nothing changes the project or repository.

Extra checks in work/v4657/fallback.mjs (fallback.log):
- (A) I created a new project "v4657 Temp2" containing the same repo. The composer-saved automation still returned 409, so the fallback in the docs ("they start in the repository's project") never happens.
- (B) I created the same automation through the API without projectSelection, bound it to a project v4657 Temp3, then deleted that project. Run now returned 201 and the run was placed in Temp2, the repo's project.

So the lenient fallback works, and only the strict marker that composer-saved automations carry breaks it.

Why this is not by design, the environment or the test script: docs/automations.md:16 says "If that project is deleted later, they s …

</details>

### t15-8 · minor · An automation can be left enabled with no schedule and no webhook (never fires) through the row editor

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-12, SCH-10.

**Repro**

> 1. Automation with an at-time schedule and no webhook. 2. Schedule and next times > Schedule 'Only when triggered' > Save schedule. 3. Accepted: row 'only when triggered' / 'Runs when triggered', enabled true, webhook false. 4. Toggle it off and on: still enabled with nothing that can trigger it.

**Expected:** Same rule as create: 'Give it a schedule, a webhook, or both', or the UI offers to enable the webhook.

**Actual:** Accepted silently. The automation looks active but only Run now can ever start it.

**Root cause (verifier):** The rule that an automation needs a schedule or a webhook is enforced only on create.

- src/server.ts:2216 (create): `if (!schedule && !body.webhook) throw new HttpError(400, "Give it a schedule, a webhook, or both")`.
- src/server.ts:2236-2248 (update, POST /api/automations/:id): builds the patch from body.webhook and body.schedule, where `"schedule" in body` with null becomes undefined. It passes the patch straight to automations.update and never checks the resulting state.
- src/automation.ts:383-402 (Automations.update): applies the patch (`Object.assign(t, rest)`, and `if ("schedule" in patch && !patch.schedule) t.schedule = undefined;`), then clears nextAt. It never checks that the merged trigger still has t.schedule or t.webhook.

In the UI:
- ui/automations.tsx:91 (ScheduleEditor) always offers "Only when triggered" and saves `{schedule: null}` whether or not the automation has a webhook.
- ui/automations.tsx:342 shows "Runs when triggered" for any enabled automation without a nextAt.
- The row (ui/automations.tsx:279-352) has no control for turning on a webhook, so the user cannot make the automation triggerable again except by setting a schedule.
- Automations.authorize  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/automation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/automations.md`

**Suggested fix:** 1. Enforce the invariant in Automations.update (src/automation.ts) so every caller gets it. Compute the merged schedule and webhook before mutating, and throw a 400-status error "Give it a schedule, a webhook, or both" when the result has neither. Skip the check for sweeps/managed targets if they legitimately differ. Alternatively, do the check in the server update route right after building the patch, using the same message as create.
2. In ScheduleEditor (ui/automations.tsx:91), only offer "Only when triggered" when the automation has a webhook. Otherwise disable it or replace it with a "Turn on webhook" choice that saves `{schedule: null, webhook: true}`. Keep the project-teams callers (ui/project-teams.tsx:94/128), where "off" means turning the mission schedule off, working as they do now.
3. Optionally add a webhook on/off control to the row, so a schedule-only automation can become webhook-triggered without being recreated.
4. Optionally make the status line exact: "Runs from its …

**Suggested regression test:** test/automation.test.ts: create a trigger with schedule {every:60} and webhook:false, then assert that `await automations.update(t.id, { schedule: undefined })` rejects with /schedule, a webhook, or both/ and leaves t.schedule unchanged. Also assert that the same call succeeds when webhook:true, and that update(webhook:false) on a webhook-only trigger is rejected.

test/server-reliability.test.ts (next to the existing "/api/automations" Hook case near line 353): assert that POST /api/automations …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: qa-server.sh start v4659t158 4659 fake, with a new empty home. The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4659t158/r1.mjs and its log is r1.log in the same folder.

1. Checked the create rule through the API. POST /api/automations with a valid solo run on MQTT-MCP and no schedule or webhook returned 400 "Give it a schedule, a webhook, or both". Sending schedule:null with webhook:false returned the same 400.
2. Created "v4659 edit-me" through the API with schedule {at:"07:00", timezone:"Europe/Stockholm"} and webhook:false. It came back 201, enabled, with nextAt 2026-10-26T06:00Z. The row read "every day at 07:00 (Europe/Stockholm) … Next: Mon 07:00 AM".
3. In headless Chrome at http://127.0.0.1:4659/#/automations/repeat I opened "Schedule and next times", chose "Only when triggered" and clicked "Save schedule". POST /api/automations/:id returned 200, with no toast and no warning.
   - Server state afterwards: schedule undefined, scheduleText "only when triggered", webhook false, enabled true, nextAt undefined.
   - The row shows "only when triggered" and "Runs when triggered".
   - The row has no Webhook button and no control for turning a webhook on.
4. Turned the row's switch off (state enabled:false, row shows "Off"), then on again (enabled:true, row shows "Runs when triggered" again). There was no message either time. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4659t158/003-after-toggle.png
5. Confirmed that nothing can start it:
   - POST /hooks/<id> with the automation's own secret returns 404 "Not found", because Automations.authorize requires t.webhook.
   - With no nextAt, the scheduler tick never fires it.
   - The dry-run preview returns ready:true with nextTimes:[] and no warning.
   - Only Run now can start it.
6. Same gap on the API: a webhook-only automation updated with {webhook:false} returned 200 with enabled true and no trigger. The UI cannot do this one, since the row has no webhook toggle.

I saw no browser or 5xx errors. Cleanup: deleted both test automations through the API (no runs were created) and stopped the server.

Is it by design? Partly arguable but not convincing. docs/automations.md "When it runs" lists Run now as a way to run, and the update path deliberately clears the schedule. But create (src/server.ts …

</details>

### t15-9 · minor · Automation lastError is never cleared by fixing or re-enabling it; the row keeps showing a stale 'couldn't start' error

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-10, SCH-23.

**Repro**

> 1. Make triggers.json contain an automation with an unreadable schedule (e.g. {every:2}) and restart. It is turned off with lastError 'Turned off: its schedule couldn't be read; set it again'. 2. In its row set a valid schedule (07:00 UTC), Save, and turn it on. 3. The row shows 'Next: Mon 08:00 AM · couldn't start: Turned off: its schedule couldn't be read; set it again'.

**Expected:** Fixing the schedule or re-enabling clears the stale error.

**Actual:** The stale error remains until a later successful run.

**Root cause (verifier):** src/automation.ts:982 (readTrigger): on load, an unreadable schedule or sweep becomes lastError = "Turned off: <problems>". That reuses the field the UI shows as a start failure (ui/automations.tsx:350 renders " · couldn't start: {lastError}").

src/automation.ts:383-401 (Automations.update): applies schedule, enabled, run and other patches but never touches t.lastError. So setting a valid schedule or turning the automation back on leaves the load note in place.

The note is cleared only by a successful fire: src/automation.ts:653 (fireOne), 755 and 823 (sweep paths). Because it is saved to triggers.json and read back at src/automation.ts:982 (`typeof raw.lastError === "string" ? raw.lastError : undefined`), it also survives restarts.

There is a second, cosmetic problem: even before the fix, the UI puts "couldn't start:" in front of a message that is not a start failure.

**Files:** `src/automation.ts`, `test/automation.test.ts`, `ui/automations.tsx`

**Suggested fix:** In Automations.update() (src/automation.ts, right after the rotateToken line ~389), clear the note from loading once the user acts on it:

```ts
// The note load left ("Turned off: its schedule couldn't be read…") is answered once you set the schedule or turn it on again.
if (t.lastError?.startsWith("Turned off:") && ("schedule" in patch || patch.enabled === true)) t.lastError = undefined;
```

A cleaner alternative is to keep load problems out of lastError altogether. Store them in their own field (for example `disabledReason`), clear it on a schedule edit or when the automation is turned on, and have the UI show it as "Turned off: …" rather than "couldn't start: …". Real start failures (rate limits, startRun errors) can keep their current behaviour: they stay until the next successful fire.

I tried the minimal fix in my snapshot copy (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4661, not the read-only s …

**Suggested regression test:** Extend test/automation.test.ts, test "triggers.json that can't be read is moved aside and never written over", directly after `assert.match(partial.get("t-odd")!.lastError!, /schedule couldn't be read/);`:

```ts
await partial.update("t-odd", { schedule: { at: "07:00" } });
assert.equal(partial.get("t-odd")!.lastError, undefined, "the stale Turned off note is cleared once the schedule is set again");
assert.equal(partial.get("t-odd")!.enabled, false);
```

Optionally add a second case where upda …

<details><summary>Verifier's independent reproduction</summary>

Fresh home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4661t159 (server name v4661t159, fake mode, port 4661). Before the first start I wrote triggers.json with one automation "Bad schedule" (id t-badsched): enabled:true, schedule {every:2}, solo pattern, repo = a scratch git repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4661-t159-repo. I drove it with /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4661/t15-9-repro.mjs (fresh browser profile, log in t15-9-repro.log next to it).
- After loading: API returns enabled:false and lastError "Turned off: its schedule couldn't be read; set it again". The row reads "Off · couldn't start: Turned off: ...".
- In the row's "Schedule and next times" editor I chose "At a time", 07:00, time zone UTC, and clicked Save schedule. The schedule saved ("every day at 07:00 (UTC)") but lastError did not change.
- I turned the row's switch on. API: enabled:true, nextAt set, lastError unchanged. The row reads "Next: Mon 08:00 AM · couldn't start: Turned off: its schedule couldn't be read; set it again" in red (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4661t159/002-t159-after-on.png).
- A page reload shows the same text. triggers.json now holds the stale lastError. After qa-server.sh restart the API still returns that lastError with enabled:true.
- No console errors and no 5xx responses.
The reporter's selectors and environment play no part: the stale value is in the API response and on disk, not only in the UI.

Checked whether this is by design:
- docs/automations.md:132 says only that an automation whose schedule can't be read "is kept but turned off".
- test/automation.test.ts:485 says "off until its schedule is set again". The message itself tells the user to "set it again".
- The analogous notifications code does clear its lastError when settings are saved again (src/notifications.ts:182).
So keeping the note after the user has fixed the schedule is not intended.

</details>

### S09-6 · minor · update() never clears lastError, so 'Turned off: its schedule couldn't be read' persists after the user sets a new schedule or re-enables the automation. It can also be re-enabled with no schedule.

Source: code-level suspect at `src/automation.ts:383` (confirmed hands-on).

**Repro**

> Fake s09: stopped the server, added an automation with schedule {at:'25:99'} to the QA home's triggers.json, restarted (server.log: 'was turned off: its schedule couldn't be read'). In Scheduling, then Repeat: open 'Schedule and next times', choose At a time 08:15, Save schedule, then toggle the switch on (work/s09/08-lasterror.mjs, shots/s09/002-s6-after-fix.png).

**Expected:** After setting a valid schedule and turning the automation back on, the stale load-time error should disappear.

**Actual:** Row meta after loading: 'Off · couldn't start: Turned off: its schedule couldn't be read; set it again'. After 'Save schedule' at 08:15 the message is unchanged. After turning the switch on: 'Next: Mon 08:15 AM · couldn't start: Turned off: its schedule couldn't be read; set it again' (red). The API confirms lastError is still set with enabled=true and the new schedule. readTrigger keeps raw.lastError across restarts, so it stays until the next fire. Secondary: update() allows enabled with no schedule and no webhook (create() rejects that with 'Give it a schedule, a webhook, or both'). The UI shows 'Runs when triggered', and the same state can be reached for any automation via 'Only when triggered'.

**Root cause (verifier):** readTrigger stores load problems in lastError ('Turned off: …'). Automations.update() changes enabled/schedule and nextAt but never resets lastError, which only fireOne/fireSweep overwrite. The UI shows any lastError as 'couldn't start: …'.

**Suggested fix:** In update(), clear lastError when the schedule or enabled state changes (at least when it starts with 'Turned off:'), or keep load problems in a separate field that a successful schedule update clears. Optionally apply create()'s 'schedule or webhook' rule when enabling.

**Suggested regression test:** Automation unit test: load a triggers.json entry with schedule {at:'25:99'}; update(id,{schedule:{at:'08:15'},enabled:true}); expect lastError undefined and nextAt set; restart (load again) and expect still no lastError.

### t15-10 · minor · Unreadable or corrupt triggers.json is not surfaced in the UI ('None yet'), and saving then returns HTTP 500

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-23.

**Repro**

> 1. Stop the server, chmod 000 triggers.json (18 automations), start. 2. Scheduling > Repeat shows 'None yet. Set up a run…'. 3. Save a new automation from the composer: the dialog shows the message, but the API status is 500. 4. Variant: write invalid JSON. It is moved aside to triggers.json.corrupt-* and the list is empty with no notice. Only server.log mentions it.

**Expected:** The Scheduling page shows that automations are unavailable or were moved aside (with the path), and storage refusals return 4xx/503.

**Actual:** Users are told they have no automations. The webhook secrets moved aside are only discoverable in server.log.

**Root cause (verifier):** There are three parts.
(1) src/automation.ts:864-866: requireWritable() throws a plain `new Error("Automations can't be changed: …")` with no status. save(strict) at about line 875 does the same ("Automations storage is unavailable").
(2) src/server.ts:2217: `await automations.create(...)` in POST /api/automations is not wrapped in attempt() and is not mapped to a status. The same is true of update (server.ts:2247), remove (server.ts:2228) and the scheduled-sweep create in startSweep (server.ts:790). So the error reaches the generic listener at server.ts:2800, which turns any non-HttpError into a 500 and logs it as a server failure.
(3) The load-time problem is never exposed. Automations.load() (src/automation.ts:313-350) only calls logError for an unreadable file (line ~321) and for a set-aside file (setAside, line ~352-361). It sets this.writable=false or renames the file but keeps no reason or path a caller can read. GET /api/automations (server.ts:2208) returns only automations.list(). The UI's loadAutomations (ui/automations.tsx:54-60) swallows errors, and the card at ui/automations.tsx:152-157 always renders "None{here} yet. Set up a run…" when the list is empty.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/automation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/automations.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/automation.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`

**Suggested fix:** 1) src/automation.ts:
- Add `export class AutomationStorageError extends Error { readonly status = 503 }` and throw it from requireWritable() and from save(strict).
- Record why storage is degraded during load(): `this.problem = { state: "unavailable", file, reason }` when the file can't be read or can't be moved aside, or `{ state: "recovered", file, aside, reason, kept: n }` after setAside() succeeds. Expose it through a `storage()` getter. Clear it on a clean load.
2) src/server.ts:
- Map AutomationStorageError to its status. Either add it to the attempt() status list at line 583, or wrap automations.create, update and remove (lines 2217, 2228, 2247) and the startSweep create at line 790 so they become HttpError(503, message).
- Expose the storage status without breaking the array shape of GET /api/automations. Options: a new GET /api/automations/storage, or a `storage` field in /api/health or in the existing bootstrap payload. Redact any token.
3) ui/automations.tsx:
- Fetch the st …

**Suggested regression test:** Unit test in test/automation.test.ts. Extend "triggers.json that can't be read is moved aside and never written over":
- After the chmod 000 load(), assert that `locked.storage().state === "unavailable"` and that create() rejects with an error that is an instance of AutomationStorageError and has status 503.
- After the corrupt-JSON load, assert that `broken.storage()` has state "recovered" and that aside matches /triggers\.json\.corrupt-/.
Server test in test/server-reliability.test.ts, using t …

<details><summary>Verifier's independent reproduction</summary>

Used a fresh fake-mode QA server, v4663t1510 on 127.0.0.1:4663, with a new home and a fresh browser profile each time.
1) Setup: created 2 disabled automations through POST /api/automations (v-sched: every 60 min; v-hook: webhook) on MQTT-MCP. The baseline page #/project/p-ef01794b/automation/repeat listed both (shot 001-baseline-list.png).
2) Variant A: stopped the server, ran chmod 000 on homes/v4663t1510/triggers.json and restarted it. server.out/server.log logged "Couldn't read …/triggers.json; automations are off…". GET /api/automations returned 200 with []. The card read "Repeating tasks and webhooks | None in MQTT-MCP yet. Set up a run in the composer…" and the page had no unavailable/couldn't/corrupt text (shots/v4663t1510/001-unreadable-list.png). In the UI I went Configure a repeating task, then Send menu, then Schedule…, then Repeat, then 'Only from a webhook', then Save automation. The dialog showed "Automations can't be changed: …/triggers.json couldn't be read when code-flow started (see server.log). Fix or remove it, then restart code-flow." The network response was 'POST /api/automations -> 500', the browser console logged "Failed to load resource: … 500", and server.out logged "POST /api/automations failed: …" as a server error (002-unreadable-save.png).
3) Variant B: stopped the server, restored the mode to 600, wrote the first 400 bytes of the real file (invalid JSON) and restarted. The server renamed it to triggers.json.corrupt-2026-10-25T21-12-20-390Z and logged that in server.out only. GET /api/automations returned [], and both the project page and the global #/automations/repeat page said "None yet…" with no notice and no path (001-corrupt-list.png, 001-corrupt-global.png).
Things I ruled out:
- The tester's environment: it reproduced in a fresh home and a fresh browser.
- The selector: I read the card text directly and also saw the network status.
- Intended behaviour: docs/automations.md:132 documents moving the file aside, logging it to server.log and starting without the automations. It says nothing about the UI or the HTTP status. The project's own convention for unavailable storage is a clear 503 (server.ts:1625 filtered tasks, :1639 ML storage, :1857 notifications; team-collaboration.md says "every change fails with 503"). The project-teams UI also has an explicit pp-unavailable alert.
Severity stays minor. No data is lost (the file is kept and never overwritten) and the save dialog does explain the refusal. But users are told …

</details>

### t15-11 · minor · DELETE/POST on a managed (project-team) automation returns HTTP 500 instead of a 4xx

Source: tester unit scheduling-inbox-notifications-1; observed with api; features SCH-15.

**Repro**

> 1. Create a draft project team (mission). Its managed automation t-pt-… appears. 2. DELETE /api/automations/t-pt-… returns 500 'Archive this automation through its standing project team'. 3. POST /api/automations/t-pt-… {name} returns 500 'Edit this automation through its standing project team'.

**Expected:** 409/400 with the same message.

**Actual:** 500 (logged as a server error).

**Root cause (verifier):** The guards throw plain Error at src/automation.ts:386 (`if (t.target) throw new Error("Edit this automation through its standing project team")` in update()) and src/automation.ts:413 (`throw new Error("Archive this automation through its standing project team")` in remove()). The route handlers call them without attempt(): src/server.ts:2228 `await automations.remove(id);` and src/server.ts:2247 `return send(res, 200, describeAutomation(await automations.update(id, patch)));`. A non-HttpError then reaches the top-level listener (src/server.ts:2799-2803), which maps it to 500 and calls logError. The sibling routes (events retry, preview, run at server.ts:2223-2232) wrap their calls in attempt() (server.ts:579-585), which turns a plain Error into a 400.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/automation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`

**Suggested fix:** Make the managed-target rejection a typed conflict instead of wrapping the whole call in attempt(). Wrapping everything would also turn requireWritable() failures into a 400, and an unreadable triggers.json is a genuine server-state error.

1. In src/automation.ts, export `class ManagedAutomationError extends Error { status = 409 }` and throw it from update() at :386 and remove() at :413.
2. In src/server.ts, either add ManagedAutomationError to the err.status list inside attempt() at :583 and wrap `automations.remove(id)` (:2228) and `automations.update(id, patch)` (:2247) in attempt(), or check up front in the route, before parsing the patch: `if (automations.get(id)?.target) throw new HttpError(409, "Edit this automation through its standing project team")`, and the same for DELETE with "Archive …".

Either way, the client gets 409 with the existing message, and logError no longer fires.

Optional: the run-now path already returns 400 for a draft team. For consistency, PATCH-like ca …

**Suggested regression test:** Add a server-level test in test/server-reliability.test.ts, which already boots the server and calls /api/automations. Set CODEFLOW_PROJECT_TEAMS_ENABLED=true (or POST /api/project-teams/settings {enabled:true}). Register a temp git repo as a project and create a draft team via POST /api/project-teams.

Then assert:
- DELETE /api/automations/t-<teamId> returns status 409, with body.error matching /standing project team/.
- POST /api/automations/t-<teamId> {name:"x"} returns 409 with the same mes …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server v4665 on 127.0.0.1:4665. The previous v4665 home was moved aside to homes/v4665.prev-221125. The new home copied two pt-*.json team records from ~/.codeflow, and they had faults ("Repository metadata was replaced"), which blocked team creation with 400 "Repair damaged team records". I moved those copies, from my QA home only, to work/v4665/pt-copied-aside and restarted.

Next I made a throwaway git repo at scratchpad/qa/clones/v4665-scratch (git init, one commit on main) and registered it as project p-69395876 via POST /api/projects. Then I created a draft standing team via POST /api/project-teams: 201, pt-0e267858fa137141aee1066b, status draft. GET /api/automations then listed the managed automation t-pt-0e267858fa137141aee1066b with target {kind:"project-team"}. Script: work/v4665/managed.mjs, output in work/v4665/managed.log.

Results:
- DELETE /api/automations/t-pt-… returned 500 {"error":"Archive this automation through its standing project team"}.
- POST with {name:"renamed"}, with {enabled:false} and with {} each returned 500 {"error":"Edit this automation through its standing project team"}.
- The automation was unchanged afterwards (name and enabled as before), so the guard itself works. Only the status code is wrong.
- For contrast, POST …/run, which is wrapped in attempt(), correctly returned 400 "Activate this team before starting a cycle".
- server.out and server.log logged all four as level=error "… failed", with stacks at automation.ts:413 (remove) and automation.ts:386 (update), called from server.ts:2228 and server.ts:2247.

Refutation attempts:
- By design? Rejecting these calls is by design (docs/project-teams.md:77 says managed schedules cannot be edited through generic automation controls, and test/project-teams.test.ts:128 asserts the rejection). Nothing documents a 500 status, and a 500 contradicts the attempt() convention used by the neighbouring routes.
- Tester environment or script? No. It reproduces from a fresh home with my own script.
- Reachability: the UI does not expose this. ui/automations.tsx:287 returns early for a.target and renders only a "Mission, cycles and opportunities" button, without the edit or delete buttons. No other UI code calls these routes for managed automations. So only direct API or CLI clients hit it, plus spurious error-log entries.

Cleanup: server stopped. No runs, worktrees or branches were created; the scratch repo has only main. The draft team and project exist  …

</details>

### t12-11 · minor · Generic automation edit/delete on a managed mission trigger returns HTTP 500

Source: tester unit project-missions-1; observed with api; features MIS-09.

**Repro**

> POST /api/automations/t-pt-<id> with {name}, {webhook:true} or {enabled:true}, or DELETE /api/automations/t-pt-<id>, using the bearer token.

**Expected:** 4xx (409 or 400) with the refusal message.

**Actual:** 500 {"error":"Edit this automation through its standing project team"} (and 'Archive this automation...' for DELETE). The server log records it as a failure.

**Root cause (verifier):** The guards throw plain Errors and the routes pass them on unchanged:
- src/automation.ts:386 (`if (t.target) throw new Error("Edit this automation through its standing project team")` in Automations.update)
- src/automation.ts:413 (`throw new Error("Archive this automation through its standing project team")` in Automations.remove)

The routes call these methods directly, without `attempt()`:
- src/server.ts:2228 `await automations.remove(id)`
- src/server.ts:2247 `describeAutomation(await automations.update(id, patch))`

The top-level handler at src/server.ts:2800-2801 maps any non-HttpError to status 500 and calls logError. Every other user-correctable error on these routes is wrapped by `attempt()` (src/server.ts:579-585), which maps a plain Error to 400 and known conflict classes to 409.

Side effects of the wrong status:
- logError writes an error-level log entry with a stack trace.
- src/performance.ts:18 counts each call in the http.errors metric.
- API clients that retry on 5xx would treat a permanent refusal as a transient server fault.

No state is changed: the throw happens before Object.assign and before the filter.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/automation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-teams.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/project-teams.e2e.ts`

**Suggested fix:** 1. In src/automation.ts, add an exported `ManagedAutomationError extends Error { status = 409 }`. Throw it at :386 and :413 instead of a plain Error. A route-level check alone would leave the model guard returning the wrong status for any other caller.
2. In src/server.ts:
   - Add `ManagedAutomationError` to the 409 branch of `attempt()` (alongside RunConflictError etc., lines 579-585).
   - Wrap the two calls: `await attempt(() => automations.remove(id))` at :2228 and `await attempt(() => automations.update(id, patch))` at :2247.
3. Simpler alternative: in server.ts, right after the 404 check at :2220, add `if (id && automations.get(id)?.target && (req.method === "DELETE" || (req.method === "POST" && !parts[3]))) throw new HttpError(409, …)`, keeping the model guard as defence in depth.
4. Caveat on the `attempt()` wrapping: requireWritable()'s "Automations can't be changed: triggers.json couldn't be read" error would then become a 400. Either keep it out of `attempt()`, or give it i …

**Suggested regression test:** Unit level, in test/project-teams.test.ts next to line 128:
- `await assert.rejects(f.automations.update(`t-${f.team.id}`, { name: "x" }), (e) => e.status === 409 && /standing project team/.test(e.message))`
- The same check for `f.automations.remove(`t-${f.team.id}`)` with /Archive/.
- Assert that `f.automations.get(`t-${f.team.id}`)` is still present and unchanged.

HTTP level, in test/e2e/project-teams.e2e.ts near line 165, where a managed team and the `api` helper already exist:
- `assert.eq …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4673 on 127.0.0.1:4673. I seeded the home with projects.json and model-catalog-settings.json only. I deliberately did not copy ~/.codeflow/project-teams: qa-server.sh would have copied it, and it contains the user's active vibesboard mission, which was inside its 21:04 grace window. The previous v4673 home was archived as homes/v4673-prev-214100.

1. Created a throwaway git repo at scratchpad/qa/clones/v4673-mini (one commit on main).
2. In the UI (work/v4673/v1.mjs): added the repo as project "v4673 mini" (p-4d5c711e) via Open another repository, enabled project missions, Create a mission, then Save draft mission. This created team pt-7a3d33c6fe96c7cbf7c35e3e and managed trigger t-pt-7a3d33c6fe96c7cbf7c35e3e. No alerts, no console errors.
3. Called the API with bearer qa-v4673-token (work/v4673/v2.mjs):
   - POST /api/automations/t-pt-… {name}, {webhook:true}, {enabled:true} and {enabled:false}: each returned 500 {"error":"Edit this automation through its standing project team"}.
   - DELETE /api/automations/t-pt-…: returned 500 {"error":"Archive this automation through its standing project team"}.
   - The trigger was unchanged afterwards (same name, enabled:false, webhook:false, same target), so the refusal works and only the status is wrong.
   - Controls: an unknown id returned 404 for both POST and DELETE, and POST …/preview on the managed trigger returned 200.
4. homes/v4673/server.out logged each call as "code-flow: POST /api/automations/t-pt-… failed: Edit this automation…" (and DELETE: "Archive this…"). server.log has level:error entries with stacks at Automations.update (src/automation.ts:386:25) via handle (src/server.ts:2247:66), and Automations.remove (src/automation.ts:413:40) via src/server.ts:2228:25.

Attempts to refute:
- The refusal is by design (docs/project-teams.md:77: "Managed schedules cannot be edited through generic automation controls"; implementation plan line 203).
- No doc, comment or test says it should be a 500. test/project-teams.test.ts:128 only checks the model-level rejection message, not an HTTP status.
- It does not depend on the tester's environment: it reproduced on a fresh home, a fresh profile and a new repo.

UI exposure: none. ui/automations.tsx:287 returns early for a.target rows, with no switch, edit or delete. :118 hides managed rows from the project Repeat and Backlog views (a screenshot confirmed zero rows there). So only direct API clients reach the 500.

</details>

### t15-14 · minor · #/automations/<unknown kind> silently shows Repeat (marked current) while the URL keeps the bad kind

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-01.

**Repro**

> 1. Open http://127.0.0.1:<port>/#/automations/bogus and reload. 2. The Repeat purpose is aria-current and its content shows. The URL stays /bogus. 3. Compare #/project/<id>/automation/bogus, which shows 'This link is invalid'.

**Expected:** Consistent handling: an invalid-link message, or a redirect to #/automations/repeat.

**Actual:** Silent fallback with a mismatched URL.

**Root cause (verifier):** ui/navigation.ts:39, `if (view === "automations") return { view, ...(id ? { kind: id } : {}) };`, accepts any kind string and ignores extra segments. Compare ui/navigation.ts:48, where the project route checks kind against ["once","repeat","backlog","missions"] and returns { view: "invalid", hash }.

Because hashFor (ui/navigation.ts:63) re-encodes the unknown kind, the URL sync effect in ui/main.tsx:86-97 sees no change, so the bad URL stays. The extra segment is dropped, which is why /once/extra gets rewritten.

ui/scheduling.tsx:19, `SCHEDULE_KINDS.find(item => item.id === kind) ?? SCHEDULE_KINDS[1]`, then silently picks Repeat and marks it aria-current="page" (line 26).

The kind list is also duplicated: once in navigation.ts:48 and once in SCHEDULE_KINDS in scheduling.tsx:11.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/navigation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/scheduling.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-context.test.ts`

**Suggested fix:** Validate the global route the same way as the project route, from one shared list.

In ui/navigation.ts:
1. Add `export const AUTOMATION_KINDS = ["once", "repeat", "backlog", "missions"] as const;` and a helper `automationKind(kind)`.
2. Line 39 becomes: `if (view === "automations") return rest.length || id && !automationKind(id) ? { view: "invalid", hash } : { view, ...(id ? { kind: id } : {}) };`
3. Line 48 uses `automationKind(repository)` instead of the inline array.

In ui/scheduling.tsx, take SCHEDULE_KINDS ids from AUTOMATION_KINDS (or assert the two lists match) so they cannot drift. The `?? SCHEDULE_KINDS[1]` default can stay for the kind-less #/automations and #/settings/automations aliases, which should still open Repeat.

Unknown kinds then reuse the existing "This link is invalid" recovery screen (ui/app.tsx:161-166), matching the project route and the docs.

The alternative is to drop the unknown kind in the parser so main.tsx's replaceState rewrites the URL to #/automati …

**Suggested regression test:** In test/project-context.test.ts:29, add "#/automations/unknown", "#/automations/Once" and "#/automations/once/extra" to the list of hashes asserted to parse to view "invalid". Keep the round-trip check in test/composer-tools.test.ts:82, which confirms the four valid kinds still parse, along with "#/automations" → { view: "automations" }. I confirmed this assertion fails on the current code (actual 'automations') and passes with the fix.

Optionally, add an e2e check: open #/automations/bogus and …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server ("qa-server.sh start v4671 4671 fake"; home had no runs or schedules) and used a fresh headless Chrome with no profile. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4671/t15-14.mjs (log: t15-14.log in the same folder). For each hash it does goto + reload, then reads the "Scheduling purpose" nav's aria-current link, the description, any role=alert and the final location.hash.

Results on the unmodified source:
- #/automations/bogus: the URL stays #/automations/bogus. "Repeat" has aria-current="page", the Repeat description and "Configure a repeating task" render, and there is no alert. Screenshot: shots/v4671/001-global-bogus.png.
- #/automations/Once (wrong case): the same silent Repeat fallback, URL kept.
- Navigating in the app (from #/inbox, set location.hash to #/automations/bogus): the same silent fallback.
- #/automations/once/extra: silently rewritten to #/automations/once.
- #/project/p-ef01794b/automation/bogus (MQTT-MCP): shows "This link is invalid" (role=alert). Screenshot: shots/v4671/006-project-bogus.png.
- #/automations and #/automations/repeat: Repeat, as expected.

No 5xx responses or page errors; the 403/409 console lines are unrelated fake-mode 4xx. The selector, profile and credentials cannot explain this: the parser itself accepts any kind.

Why it is not by design:
- docs/project-first-navigation-plan.md:32 says invalid targets get an "Explicit recovery state".
- docs/project-first-navigation-plan.md:350 says old bookmarks resolve to the "Correct destination ... or a clear recoverable invalid-link state".
- git history: the project route got kind validation in #44 (217a659, 2026-10-21), with a test in test/project-context.test.ts:29. The global route, which took kinds in #38 (e211862), was never brought in line.

Fix checked in a snapshot copy (builds/v4671; the read-only source was not touched):
- With the fix below, test/project-context.test.ts and test/composer-tools.test.ts pass (15/15).
- With the original navigation.ts, the new assertion fails (expected 'invalid', actual 'automations').
- A fake server from the rebuilt snapshot on 4671 shows "This link is invalid" for #/automations/bogus, /Once and /once/extra. #/automations, #/automations/repeat and the project routes are unchanged (shots/v4671fix/*).

Cleanup: both of my servers (v4671, v4671fix) are stopped and no runs were created. Leftover: the modifi …

</details>

### t00-9 · cosmetic · Unknown destinations fall back silently instead of the invalid-link page (#/foo, #/review/x, #/settings/bogus, #/automations/<anything>)

Source: tester unit shell-navigation-settings-1; observed with fake-agents; features SHL-02, SHL-03.

**Repro**

> Open each in turn: #/foo, #/review/x, #/settings/bogus, #/automations/zzz-bogus. Compare with #/project/<id>/automation/bogus.

**Expected:** Unsupported addresses consistently show 'This link is invalid' (as #/project/a/unknown does).

**Actual:** #/foo and #/review/x become #/ (composer); #/settings/bogus becomes #/settings/general; #/automations/zzz-bogus is kept and shows the Repeat tab. #/project/<id>/automation/bogus is rejected as invalid, so behaviour is inconsistent.

**Root cause (verifier):** The defect is in the global Scheduling route only. ui/navigation.ts:39 (`if (view === "automations") return { view, ...(id ? { kind: id } : {}) };`) accepts any kind and ignores extra path segments. ui/navigation.ts:48 does validate the project automation kind against ["once","repeat","backlog","missions"]. hashFor at ui/navigation.ts:62 writes the bogus kind back, so the address keeps it. ui/scheduling.tsx:19 (`SCHEDULE_KINDS.find(item => item.id === kind) ?? SCHEDULE_KINDS[1]`) then shows Repeat without saying anything.

The reporter's other cases are intended. Their line numbers are stale: the settings fallback is navigation.ts:36 plus settings-sections.ts:20, the review route needs a branch at navigation.ts:33, and the final composer fallback is navigation.ts:55. Unit tests and the navigation plan doc lock these in, so they should not be changed under this issue.

Severity is cosmetic. Nothing is launched, lost or sent to the wrong target. The only symptom is an address that names a tab that does not exist, which is inconsistent with the project-scoped route.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/navigation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/scheduling.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-context.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/simplification.e2e.ts`

**Suggested fix:** 1. In ui/navigation.ts, export one list of kinds, e.g. `export const SCHEDULE_KIND_IDS = ["once", "repeat", "backlog", "missions"] as const`. Use it at line 48 in place of the inline array. Have ui/scheduling.tsx take its IDs from it (or the reverse), so the two lists cannot drift apart.
2. Change line 39 to reject unknown kinds and extra segments, as the project route already does:
   `if (view === "automations") return rest.length || (id && !SCHEDULE_KIND_IDS.includes(id)) ? { view: "invalid", hash } : { view, ...(id ? { kind: id } : {}) };`
   An acceptable alternative is to normalise to #/automations/repeat. The alias replaceState in ui/main.tsx would then rewrite the URL. Rejecting is still better because it matches #/project/:id/automation/<unknown>.
3. Leave the settings, team, run/review and top-level composer fallbacks alone. They are deliberate and tested.
Optional enhancement (not a bug): send #/review/<id> without a branch to #/run/<id> instead of the composer.

**Suggested regression test:** In test/project-context.test.ts, next to the existing invalid-hash loop at line 29, add:
- "#/automations/zzz-bogus" and "#/automations/repeat/extra" to the hashes that must parse to view "invalid";
- a check that each of once/repeat/backlog/missions round-trips: assert.deepEqual(parseRouteHash(hashFor({ view: "automations", kind })), { view: "automations", kind }).
Also extend the deep-link loop in test/e2e/simplification.e2e.ts:241 with "#/automations/zzz-bogus", expecting the heading "This li …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (qa-server.sh start v4659 4659 fake) and ran /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4659/t00-9.mjs in a fresh headless Chrome with no saved profile. The script opens each address in two ways: (A) a full page load in a new tab and (B) an in-app location.hash change. Both ways gave the same results (log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4659/t00-9.log):
- #/foo -> URL becomes #/ and the composer opens ("What would you like to work on?").
- #/review/x -> URL becomes #/ and the composer opens.
- #/settings/bogus -> URL becomes #/settings/general, showing Settings with General selected.
- #/automations/zzz-bogus -> URL stays #/automations/zzz-bogus. The Scheduling page shows the Repeat tab with aria-current=page (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4659/load-_automations_zzz_bogus.png).
- #/project/p-ef01794b/automation/bogus, #/project/a/unknown and #/project/p-ef01794b/bogus -> "This link is invalid".
- Controls: #/new -> #/ (composer); #/team/other -> #/team (Board); #/run/ -> #/ (composer).
There were no console errors or 5xx responses.

So the reported behaviour reproduces exactly. Most of it is intended, though:
1. #/settings/<unknown> -> General is checked by a unit test: test/composer-tools.test.ts:14 asserts parseRouteHash("#/settings/unknown") equals {view:"settings",section:"general"}.
2. Incomplete or unknown top-level links falling back to the composer are also tested. test/composer-tools.test.ts:22 asserts "#/run/" -> composer. test/collab-ui.test.ts:40-42 asserts that "#/team/task", "#/team/project" and "#/team/other" land on the board, matching the comment at navigation.ts:52 ("anything else under #/team is the board").
3. The docs define the legacy #/ and #/new as composer aliases (docs/project-first-navigation-plan.md:16). They limit the explicit invalid-link state to "Malformed project route, missing project or removed repository" (line 32).
4. ui/main.tsx:94-95 replaces alias addresses on purpose ("Replace legacy addresses so Back cannot get stuck on an alias").
#/review/x (no branch) behaves like the tested #/run/ case.

The one real inconsistency is #/automations/<unknown>. The project-scoped twin #/project/:id/automation/<unknown> is …

</details>

### S01-4 · cosmetic · #/automations/<kind> accepts any kind (SchedulingView falls back to Repeat and the bad URL stays) while #/project/<id>/automation/<bad> is invalid; #/settings/automations/<kind> drops the kind.

Source: code-level suspect at `ui/navigation.ts:39` (confirmed hands-on).

**Repro**

> Fake server s01: #/automations/bogus renders the 'Scheduling' page with 'Repeat' highlighted (aria-current) and the URL stays #/automations/bogus (shots/s01/001-automations-bogus.png). #/project/<id>/automation/bogus renders 'This link is invalid'. #/automations/once/extra is accepted and rewritten to #/automations/once. #/settings/automations/once redirects to #/automations (Repeat). That last part is harmless: git history shows the #/settings/automations redirect (61c3b23, #31) predates schedule kinds (SCHEDULE_KINDS added in e211862, #38), so no legacy link ever carried a kind. docs/automations.md only promises that 'Older #/settings/automations links open the Scheduling page'.

**Expected:** Global and project scheduling routes treat unknown kinds the same way: either both show the invalid-link page, or both canonicalise to a valid kind and rewrite the URL.

**Actual:** An unknown global kind silently shows Repeat and keeps the bad URL. The equivalent project URL is reported as invalid.

**Root cause (verifier):** parseRouteHash returns {view:'automations', kind:id} for any id and ignores extra segments. The project route checks the kind against ['once','repeat','backlog','missions'] and rejects extras (covered by test/project-context.test.ts:29). SchedulingView silently uses SCHEDULE_KINDS[1] (Repeat) for unknown kinds.

**Suggested fix:** In parseRouteHash: `if (view === 'automations') return rest.length || id && !SCHEDULE_KIND_IDS.includes(id) ? { view: 'invalid', hash } : { view, ...(id ? { kind: id } : {}) }`, sharing one constant with the project branch. Leave the #/settings/automations legacy redirect as is.

**Suggested regression test:** test/project-context.test.ts: parseRouteHash('#/automations/bogus').view === 'invalid', parseRouteHash('#/automations/once/extra').view === 'invalid', and parseRouteHash('#/automations/backlog') returns kind 'backlog'.

### t15-15 · minor · Automations without a project are counted as 'in other projects' and can only be filtered when orphan runs exist

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-04.

**Repro**

> 1. Create an automation whose repo is in no project (or in two projects, e.g. IndustriConnect-MCPs owned by 'connect' and 'IndustriConnect'). 2. Scheduling, scope = t15 MQTT: 'N more in other projects' includes it. 3. Press p: there is no 'Unassigned' choice until a run is orphaned by a project deletion. Only then does Unassigned list these automations.

**Expected:** An always-available 'Without a project' scope when such automations exist, and counts worded accordingly.

**Actual:** These automations can only be found under All projects.

**Root cause (verifier):** These automations end up in the NONE scope, the picker offers NONE only when orphan runs exist, and the hint calls them "other projects".

1. ui/automations.tsx:19-20 `automationProject()` returns undefined in two cases: (a) run.project names a deleted project (the `projects.value.find` misses), and (b) a legacy automation with no run.project whose repo belongs to more than one project. Case (b) is deliberate, per the comment "infer legacy placement only for a uniquely owned repository".
2. ui/automations.tsx:23-27 `automationInScope()` then places these automations only in scope NONE (`scope === NONE ? !p`). That scope is designed to work: forced through storage, it lists them.
3. ui/projects.tsx:105 `const orphans = counts(NONE)` counts only runs. ui/projects.tsx:120 renders the NONE row only when `orphans.runs || orphans.archived`, with the detail text "runs whose project was deleted". Project-less automations are not considered, and neither is the case where NONE is already the active scope. So the scope cannot be selected until some run is orphaned.
4. ui/automations.tsx:150 `<Elsewhere count={matching.length - list.length} what={n => `${n} more in other projects`}>` counts ev …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/automations.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/runs.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** 1. Move the `automations` signal and `automationProject()` from ui/automations.tsx into ui/state.ts, or a small shared module next to it. This avoids an import cycle, because automations.tsx already imports ProjectButton from projects.tsx.
2. In ProjectsDialog (ui/projects.tsx:105 and :120), count project-less automations alongside orphan runs. Render the NONE row when orphan runs exist, when project-less automations exist, or when currentProject is already NONE. Label it consistently "Without a project", the same wording as the inbox grouping and notifications. Give it a detail such as "2 runs · 1 automation in no project" instead of "runs whose project was deleted".
3. In AutomationsView (ui/automations.tsx:140 and :150), split the out-of-scope remainder into automations in other projects and automations with no project. Word the second part "N without a project", with its own button that calls selectProject(NONE). Keep "Show all" for the rest.
4. Optional: list the affected automati …

**Suggested regression test:** Add an e2e case in test/e2e/ui.e2e.ts next to the "Schedules are a separate destination but keep the same project scope" block (around line 908), or in test/e2e/automation-controls.e2e.ts:
1. Create project X holding the fixture repo, and POST /api/automations with run.project = X and projectSelection "explicit".
2. DELETE project X, then select the repo's own project.
3. Assert that `.automations .rail-hint` contains "1 without a project" and does NOT contain "in other projects".
4. Open `.proj …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4673 on 127.0.0.1:4673. I moved the previous verifier's home aside to homes/v4673-prev-<ts> and the new home has only the copied projects.json, no runs and no automations. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4673/ (a2-flow.mjs/a2.log, a3-ambiguous.mjs/a3.log).

Scenario A uses only UI steps after one API precondition:
1. Precondition over the API: POST /api/projects {name:"v4673 Temp", repos:[MQTT-MCP]}.
2. UI: #/project/<temp>/automation/repeat, then "Configure a repeating task", fill in the task, then Run actions, Schedule..., Repeat, and Save automation. Saved t-b84a2bee with run.project = the temp id, set explicitly.
3. UI: Projects dialog, "Edit v4673 Temp", Delete. The confirmation only says "It has no runs." and says nothing about the automation. The project is deleted and the server has 0 runs.
4. Scheduling > Repeat with the scope set to MQTT-MCP (the repo's own project): no rows, the hint "1 more in other projects / Show all", and "None in MQTT-MCP yet". I also tried every project scope and none of them lists the automation.
5. Pressing p opens the picker with: All projects, connect, IndustriConnect, industriHealth, IndustriStudio, MQTT-MCP, OntoLab, OPCUA-MCP, Vibesboard. There is no Unassigned or "Without a project" row.
6. The automation only appears under All projects. Screenshots are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4673/: 002-a2-scope-mqtt.png and 003-a2-picker.png.

Scenario B is legacy-shaped, like the reporter's: POST /api/automations with no run.project for IndustriConnect-MCPs, which both 'connect' and 'IndustriConnect' own, as webhook-only. The scopes connect, IndustriConnect and MQTT-MCP each show "2 more in other projects", and All lists both automations. When I forced the stored filter to "none" (localStorage project=none) and reloaded, both automations were listed and the button read "Unassigned". In that state the picker still has no Unassigned row and no row marked as selected, so the active scope cannot be seen or picked again.

The browser recorded no console errors or 5xx responses. Cleanup: I deleted both automations through the UI, deleted the temp project through the UI, created no runs, and stopped the server.

Attempts to refute it:
- The reporter's ambiguous case was created over the API with pr …

</details>

### t15-19 · cosmetic · Double-clicking Run now opens the run and also shows a 'Skipped: it's starting a run right now' error toast

Source: tester unit scheduling-inbox-notifications-1; observed with fake-agents; features SCH-14.

**Repro**

> 1. Scheduling > Repeat, double-click 'Run now' on an idle automation. 2. One run starts and the page navigates to it. 3. A toast 'Skipped: it's starting a run right now' also appears on the run page.

**Expected:** The button is disabled while starting, or the second click is ignored quietly.

**Actual:** An error-looking toast next to a successful start.

**Root cause (verifier):** The Run now button at ui/automations.tsx:303-318 (in AutomationRow) has an onClick that fires post(`/api/automations/${a.id}/run`) with no in-flight state. The button is never disabled and repeat clicks are not ignored. Its error handler at ui/automations.tsx:314 is `(e) => showToast(e.message, 5000)`, which shows every rejection, including the expected duplicate guard.
On the server, the first request adds the id to `starting` at src/automation.ts:642 and keeps it until :660. A second request in that window gets busy() = "it's starting a run right now" (src/automation.ts:667). Once the first run is running, it gets "the previous run (<id>) is still running" instead (src/automation.ts:669). src/server.ts:2233 turns either one into HttpError 409 "Skipped: …".
The 201 handler sets route.value to the run, so the 5-second toast from the losing request shows up on the run page next to the successful start. The server is correct; only the client behavior is wrong.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/automation-controls.e2e.ts`

**Suggested fix:** Give AutomationRow's Run now an in-flight state, using the same useState busy pattern this file already uses in TriageActions (line ~224) and the events panel (line ~383).
- Add `const [starting, setStarting] = useState(false)`.
- In onClick, return right away if `starting` is set. Otherwise call setStarting(true) and clear it in `.finally`.
- Render the button with `disabled={starting}` and `aria-busy`, and change its label to "Starting…" while the request is in flight.
- Use a ref (useRef) for the guard as well as state, so two click events in the same frame can't both get past a stale render. A state-only guard could still let a 0 ms Playwright dblclick through before the re-render.
- Optionally, when navigating to the started run, ignore a later 409 from the same row within a short window.
Keep the server's 409 unchanged: it is the documented guard (docs/automations.md:30) and still applies to scheduled fires and to a second tab or client. The sweep branch (several ids, stays on th …

**Suggested regression test:** Add a case to test/e2e/automation-controls.e2e.ts using the fake server.
Setup: create an automation and open #/automations/repeat. Count the requests to /api/automations/<id>/run.
Action: double-click "Run now" on the row (locator.dblclick(), plus a variant with two mouse clicks about 80 ms apart).
Assertions:
- Exactly one POST /run is sent, or at least no 409 reaches the UI.
- The page lands on #/run/<id>.
- page.locator('.toast') never contains "Skipped:" during the following ~2 s.
- The API …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4681t1519 on 127.0.0.1:4681, with a new home. I made a scratch clone of MQTT-MCP (clones/v4681-mqtt.git plus a working clone) and registered it as project "v4681 mqtt scratch". As preconditions I created the automation "v4681 dbl" through the API: fix-review, claude/claude, checks off, every 1440 min. Then I used headless Chrome with a fresh profile (no persisted state) on /#/automations/repeat and recorded the POST /api/automations/<id>/run traffic and the .toast text.
(1) Playwright btn.dblclick() sent two POSTs 0 ms apart. Results: 409 {"error":"Skipped: it's starting a run right now"} at +16 ms, then 201 {id} at +205 ms. The page went to #/run/<id> and the toast "Skipped: it's starting a run right now" appeared on the run page. Screenshot: shots/v4681t1519/001-t1519-dbl.png. Only 1 run was created (the server guard works). The console showed "Failed to load resource: 409 (Conflict)".
(2) To rule out an artifact of Playwright's dblclick, I sent raw mouse down/up pairs with a pause between the two clicks. At 40 ms and 90 ms: same 409 and the same toast. At 150 ms the second POST arrived after the run had started, so the toast became "Skipped: the previous run (2610252116-71dafc5b) is still running". That names the run the user had just opened, which is even more confusing. At 250 ms the page had already navigated before the second click: one POST, no toast.
(3) Control, a single click: one 201, navigation, no toast.
So this is not caused by the tester's script, selector or browser profile. A normal double-click produces it. The toast uses the neutral .toast style (role=status, no error class), so it reads as wrong information rather than an error banner.
By design? Only partly. docs/automations.md:30 says Run now is skipped while the previous run "is still going (or still starting)", so the server's 409 is intended. Nothing documents or justifies showing that skip message for the user's own double-click.
Cleanup: deleted all 7 runs (bulk "Select runs > Delete 7 runs") and the automation through the UI, stopped v4681t1519, and removed the scratch clones v4681-mqtt and v4681-mqtt.git, which also removes their worktrees and branches. Ports 4681 and 4682 are free. 4683 is held by another verifier's server (home homes/v4683, pid 41403), which I did not touch. No real agents were used.

</details>

### t15-23 · minor · Docker isolation and image can only be set when an automation is created

Source: tester unit scheduling-inbox-notifications-1; observed with code-reading; features SCH-08.

**Repro**

> 1. Save an automation with 'Run checks and setup in a Docker container' unchecked (the dialog still saves image 'node:22'). 2. In Scheduling there is no control to turn isolation on or change the image. Only the schedule editor exists. The API accepts {isolate, image}.

**Expected:** The row exposes isolation and image editing, as the API allows.

**Actual:** Delete and recreate is the only UI path, and recreating changes the webhook URL and secret.

**Root cause (verifier):** Two causes, one in the UI and one in the save request.

1. **Missing control (main cause).** In ui/automations.tsx:280-385, `AutomationRow` shows `a.isolate`/`a.image` only as read-only text (line 300: `{a.isolate ? \` · checks in ${a.image || "node:22"}\` : ""}`). Its only editor is `<ScheduleEditor automation={a} save={update} />` at line 352. Its other `update()` calls send only `enabled` (line 290) and `rotateToken` (line 368). Nothing sends `isolate`/`image`, even though the server accepts both:
   - src/server.ts:2244-2245
   - src/automation.ts:383 (the `update()` signature includes "isolate" | "image")
   - docs/api.md:228

   The same row also has no webhook on/off control, though the API accepts `webhook`.

2. **Phantom image (contributing cause).** ui/automations.tsx:434 does `useState("node:22")`, and lines 448-449 always post `isolate, image`. So an automation saved with isolation off still stores `image:"node:22"`, as seen in the server response.
   - Server side, src/server.ts:2217 keeps any non-empty string.
   - When an automation fires, src/automation.ts:647 and :836 use `t.image || "node:22"` and never look at the repository's `.codeflow/config.json` `image`.  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/automation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/automation-controls.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/automations.md`

**Suggested fix:** 1. **Row editor.** In ui/automations.tsx add a small `IsolationEditor` (a `<details>` titled "Check isolation") next to `ScheduleEditor` in `AutomationRow`. It needs:
   - a checkbox "Run checks and setup in a Docker container" (aria-label `Docker isolation for ${a.name}`)
   - an image input shown when the box is ticked, prefilled with `a.image ?? ""` and a placeholder like "repo config image or node:22"
   - a "Save isolation" button that calls `update({ isolate, image })`

   `update()` already POSTs to /api/automations/:id, which keeps id, token and hookPath. A webhook on/off checkbox (`update({ webhook })`) could go in the same editor, since the API supports it.
2. **Dialog.** In `SaveAutomationDialog`, send `image` only when `isolate` is true (`...(isolate ? { image } : {})`), or start the field empty so that blank means "use the repository default".
3. **Server (optional).**
   - In the create and update routes, or `Automations.create`/`update`, drop `image` when `isolate` is …

**Suggested regression test:** **E2E test.** In test/e2e/automation-controls.e2e.ts, add a test that:
1. creates a trigger through the API with `isolate:false, webhook:true` and records its `id`, `token` and `hookPath`;
2. opens #/settings/automations and, in that automation's `.auto-row`, opens "Check isolation", ticks `getByLabel("Docker isolation for Automation QA")`, fills the image with "python:3.12-slim" and clicks "Save isolation";
3. waits until GET /api/automations shows that trigger with `isolate===true` and `image= …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server: `qa-server.sh start v4689s 4689 fake`. I used a new home name because homes/v4689 held runs from an earlier session. The new home had 0 automations and 0 runs. I drove it with a fresh headless Chrome (no profile) using script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4689s/r1-sch08.mjs; its output is in r1.log in the same folder.

1. In project MQTT-MCP, I went to Automation > Repeat > "Configure a repeating task", typed a task, then chose Run actions > Schedule… > Repeat. In the Save dialog I ticked "Also start it from a webhook" and left "Run checks and setup in a Docker container" unticked (the image field was hidden). Then I clicked Save automation.
   - The captured request was POST /api/automations with `isolate:false, image:"node:22", webhook:true`.
   - The server saved `{id:t-66341216, isolate:false, image:"node:22", hookPath:/hooks/t-66341216}`.
2. On Scheduling > Repeat I expanded everything in the row: Schedule and next times, Preview and events, and Webhook. I listed every control in the row:
   - on/off switch
   - Preview and events, Run now, Webhook and Delete buttons
   - schedule select, time, time zone, 7 day checkboxes and Save schedule
   - Refresh preview
   - Copy and New secret

   Nothing on the whole page matches /docker|isolat|image|container/. The dry run shows "Permissions: standard · commands on this machine" with no way to change it. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4689s/002-row-expanded.png
3. The backend does allow the change. POST /api/automations/t-66341216 `{isolate:true, image:"python:3.12-slim"}` returned 200, kept the id and hookPath, and after a reload the row read "· checks in python:3.12-slim". I reverted it through the API.
4. The only UI path is delete and recreate. I clicked Delete > Delete automation, then saved again through the dialog with Docker ticked and image python:3.12-slim. The new automation is t-48d5bba5 with hookPath /hooks/t-48d5bba5: the webhook URL, secret and id all changed. Recreating also loses the event history, the webhook dedupe list and, for sweeps, the list of items already handled.

Attempts to refute it:
- Selector or profile mistake: no. The reporter's script used the real role/label selectors, and I reproduced it with a fresh browser.
- By design: not found. doc …

</details>



## Continuation outcome — 2026-10-26

Implemented and verified from integration `653d38c` in `/private/tmp/codeflow-qa-automation-records`, branch `codex/qa-automation-records`. All 13 reported issue IDs are covered below. Historical reports above remain unchanged.

| Issues | Fix and verification |
| --- | --- |
| t15-7 | The create/update API validates the current explicit project choice, then omits the interactive-only `projectSelection` marker from saved automation payloads. Triggered starts also normalize legacy saved markers. The engine's existing lenient placement policy can therefore choose the repository's project after deletion. A composer-created webhook automation ran before deletion, then ran manually and by webhook after deletion into the remaining repository owner. A seeded legacy explicit record also fell back; an interactive run still returned 409 for the deleted project. The deletion dialog retains correct singular run grammar and explains automation retention/future placement. |
| t15-8 | `Automations.update` checks the merged schedule/webhook state before changing revision, token or any record field. Removing the final trigger returns 400 and leaves disk/in-memory data unchanged. The row disables “Only when triggered” until a webhook exists; execution settings can enable the webhook first. Mission schedule editors keep their existing independent off behavior. |
| t15-9, S09-6 | A repaired load-time schedule warning clears when valid trigger settings are saved or re-enabled. The row renders a load warning directly rather than calling it a failed start. A bad interval was seeded, repaired through Chrome, re-enabled and reloaded without stale error text. Genuine provider start failures remain through rename, schedule edits and re-enable; sweep warnings are not erased by the schedule editor. |
| t15-10 | `GET /api/automations/storage` returns ready/recovered/unavailable, source basename and a bounded reason/backup basename. The original list endpoint remains an array. Corrupt records retain their backup and show a recovery notice; unreadable records show an unavailable notice and mutation returns typed 503. A real chmod000 fixture was restored after testing; the unreadable file remained byte-for-byte identical, including its secret. Corrupt JSON text is not echoed in the status or notice. |
| t15-11, t12-11 | Managed update/delete guards use typed 409 errors with project-mission guidance. Verified seeded records and the projection of a mission actually created in Chrome: both refused generic edit/delete with no record change. |
| t15-14, t00-9, S01-4 | Global/project routes share the once/repeat/backlog/missions allowlist. Bogus case-sensitive values and extra/trailing segments show the invalid-link page. All four valid destinations and the legacy Settings alias work. Other documented route fallbacks remain unchanged. |
| t15-15 | A shared automation state module lets the project picker expose “Without a project” when only orphan/ambiguous automation records exist. Elsewhere counts distinguish these records from other projects and link directly to their filter. Chrome verified the choice while authoritative orphan run counts were zero. |
| t15-19 | Run now uses a synchronous ref guard plus disabled/aria-busy Starting state. Two same-tick browser clicks yielded one real request; a held request made the pending UI observable. Two independent API callers still returned 201+409, preserving server duplicate protection. |
| t15-23 | Rows have revision-checked execution/webhook editing, including Docker isolation and image. Edits survive reload and preserve ID, secret, hook URL, creation time and nonempty event history. A concurrent update keeps the user's draft and offers “Use saved settings.” Turning isolation off is supported; the composer no longer sends a hidden image when isolation is off. Existing node:22 automation fallback is retained and explicitly described by the editor. |

### Evidence and checks

Evidence directory: `/private/tmp/codeflow-qa-continue/work/automation-records/`.

- `unit-before.log`: all five new regression tests failed against the starting implementation, confirming the storage, merged-trigger, load-warning, managed-status and route defects.
- `related-final.log`: 51/51 tests passed across `test/qa-automation-records.test.ts`, `test/automation.test.ts`, `test/project-context.test.ts` and `test/server-reliability.test.ts`.
- `guards-final.log`: 17/17 passed across the new record tests and the existing schedule-editor unit/server files; five record cases overlap the previous total.
- `original-ui-final.log`: 8/8 existing Chrome cases passed in `test/e2e/automation-controls.e2e.ts` and `test/e2e/qa-schedule-editor-tz.e2e.ts`.
- `ui-final.log`: 8/8 new live Chrome/API scenarios passed in 20.5s. New coverage lives in `test/qa-automation-records-ui.test.ts`; it creates a fresh server/home/repo and uses fake providers. These are actual app routes and browser interactions, with one request held before forwarding to make double-click concurrency deterministic; no response mocking.
- `tsc-final.log`: `tsc --noEmit` passed; `git diff --check` passed. Total 79 distinct tests (51+12+8+8), excluding repeated runs.
- `browser-errors.json`: no unexpected page/console/API errors. The intentional unreadable-storage save generated 503 and the corresponding browser resource error, recorded separately as expected. `server.log` contains the intentional invalid-schedule warning, corrupt-file backup, EACCES and typed 503 mutation refusal; no unexpected error or managed-route 500.
- Screenshots01–11 cover invalid navigation, execution conflict, in-flight Run now, deletion warning, unassigned hint/list, repaired schedule, corrupt/unreadable storage, failed save and managed mission. `02-execution-conflict.png`, `04-project-delete-warning.png` and `09-storage-unavailable.png` were visually inspected; final screenshots disable finite animations to capture the visible confirmation.

The existing project-persistence unit fixture previously removed its schedule while keeping webhook=false. It now enables the webhook in that same update, retaining the test's placement/restart assertions while respecting the intentional new invariant. No existing assertion was weakened. The first broader UI pass exposed a new editor's transient conflict alert when its draft was untouched; conflict is now shown only for an actual dirty draft, and the original two-window schedule test passes. A separate initial failure was the scratch HOME lacking Playwright's video encoder; the rerun points `PLAYWRIGHT_BROWSERS_PATH` at the already installed cache, without installing or modifying it. Initial UI harness selector failures and all failed logs are preserved.

Every build, test and application command was launched with explicit scratch `CODEFLOW_HOME`, `HOME`, `ZDOTDIR` and `TMPDIR` before imports. New live UI used 4355/4357, original suites used isolated ephemeral local ports, all providers/gh were fake, and all Git work used temporary repositories. Servers were stopped after testing. No live 60c0 build/server, 4317/4318, real CodeFlow home, real provider account, project remote or push was used. Docker settings were verified as persisted metadata; no real Docker execution or external webhook service was claimed. Actual container image inheritance was not changed. Global QA index/status/coverage files were not edited.
