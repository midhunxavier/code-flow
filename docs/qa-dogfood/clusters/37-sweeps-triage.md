# Cluster 37 · sweeps-triage

**Backlog sweeps & triage actions: severity defaults/filter, 25-item cap, triage state guards, warning loss**

Status: **fixed and independently replayed** · 9 issues (6 root causes) · branch `codex/qa-sweeps-triage`

Planner notes: Sweeps: dependabotAlertItems in src/sweeps.ts selects low-severity alerts by default (t16-2); the filter in ui/sweeps.tsx ignores severity (t16-3); when more than 25 items are picked by default, Start is disabled (t16-17). Triage: POST /api/runs/:id/triage (src/server.ts ~2711) returns {ok:true} and drops the run that manager.triage() returns with triage.note, so the 'visual evidence not posted' warning never shows (t16-4/S03-7). The Revise budget inputs send 0 when cleared (t16-5/S01-3, TriageActions at ui/automations.tsx:257). RunManager.triage (src/engine.ts:5611) doesn't check that triage.state is 'pending' (t16-6/S09-5). The sweep schedule time zone (t16-16) belongs to schedule-editor-tz, and sweep result titles (t16-7) to github-pr-open-picker. Duplicate groups: [["t16-4","S03-7"],["t16-5","S01-3"],["t16-6","S09-5"]]

Likely files: `src/sweeps.ts`, `ui/sweeps.tsx`, `ui/automations.tsx`, `src/server.ts`, `src/engine.ts`

## Repair outcome · 2026-10-26

Implemented in `/private/tmp/codeflow-qa-continue/sweeps-triage`, based on integration `1e3c86d7fbe96a84bbee23ac56f338d4e57986d3`. The original reports below remain intact.

| Issue(s) | Root repair and verified result |
|---|---|
| t16-2 | Dependabot and code-scanning alerts share the severity threshold. Low/unknown alerts with a fix remain available but unpicked; a package with high and low alerts stays picked. New unit tests exercise real `listSweep`, scheduled selection and webhook preview gates. The real HTTP list and Chrome checkbox replay show low jinja2 unpicked. |
| t16-3 | The filter searches severity and labels explicitly. An exact severity word matches an alert's badge, so `low` excludes a Note alert whose explanation says “Low severity.” Ordinary issue titles/labels such as `high` still work. Chrome finds both critical pyyaml and the manual leaked-secret item, one High alert and only the Low item. |
| t16-17 | Initial selection and Select shown use the first 25 eligible items, preserving existing picks outside a filter. A visible note explains the cap. Chrome shows 25 checked out of 32, enabled Start, and the same result after None → Select shown. A manually checked 26th item disables Start with the limit; the real API still rejects 26 items with 400. |
| t16-4, S03-7 | Triage persists an explicit `warning` and the route returns `{ok, triage, warning?}`. The Inbox uses the warning field for an eight-second toast instead of interpreting note text. Approval notes are retained separately when supplied. In Chrome, approving a fake Dependabot PR pushes the evidence commit to a local bare origin while fake gh rejects the comment: HTTP 200 carries the warning, the warning appears in the Inbox, and the saved result is approved with that warning. |
| t16-5, S01-3 | Revision fields retain raw text, including an empty field, and show a visible alert. Revise is disabled for empty/zero/over-limit inputs and fractional calls; the handler also guards invalid values. Chrome uses keyboard clear as well as fill, observes zero triage requests for invalid values, then sends exactly 3 calls/10 minutes and completes the real fake-agent follow-up. |
| t16-6, S09-5 | The manager requires pending triage before decisions or effects and claims the decision synchronously through completion. Approved/rejected/empty/missing triage states reject later decisions; competing decisions cannot publish twice. A publication failure releases its claim and leaves pending state. Rejection is committed only after archive succeeds, so a rejected cleanup admission can be retried. Browser/API replay rejects late approve/openPr, revise and reject with 409 after both UI decisions; rejected worktrees stay deleted, the result stays archived, and fake gh gains no PR. |

Validation and evidence:

- `CODEFLOW_HOME=/private/tmp/codeflow-qa-continue/sweeps37-command-home npx tsc --noEmit` and `git diff --check` pass.
- New `test/qa-sweeps-triage.test.ts` covers selection/filtering, alert and automation gates, terminal states, overlapping publication/retry, explicit warning/user note separation and cleanup-admission retry. Together with existing `test/sweeps.test.ts` and `test/automation.test.ts`: **46 passing tests**. Log: `/private/tmp/codeflow-qa-continue/sweeps37-broad-unit.log`.
- New `test/e2e/qa-sweeps-triage.e2e.ts`: **6 passing Chrome scenarios** against the real isolated server. Log: `/private/tmp/codeflow-qa-continue/sweeps37-browser.log`.
- Original `ui.e2e.ts` “sweep: pick open issues…”: **1 passing**; original `automation-controls.e2e.ts`: **3 passing**, including workflow/templates and partial failures. Logs: `sweeps37-original-sweep-browser.log` and `sweeps37-original-controls-browser.log` under the same scratch directory.
- Independent baseline: copied the new browser repro file into a temporary detached checkout of `1e3c86d`. The initial five scenarios each fail on the original faults (low selected, 32 selected, empty field snaps to zero, late decisions return 200, missing warning). A separate filter replay also fails with zero critical rows instead of two. Logs: `/private/tmp/codeflow-qa-continue/sweeps37-baseline.log` and `sweeps37-baseline-filter.log`. Baseline checkout removed after its server exited.
- Screenshots under `/private/tmp/codeflow-qa-continue/sweeps37-browser/`: `critical-filter.png`, `high-filter.png`, `default-25-of-32.png`, `manual-26-limit.png`, `blank-calls-inline-error.png`, `final-reject.png`, `final-approve.png`, `push-warning-toast.png`. Default selection, blank-budget and warning-toast images were visually inspected. `page-errors.json` and `server-errors.json` are empty arrays. `server.log` contains normal fake-provider startup/shutdown and the Node SQLite experimental notice; no unexpected server errors.

Every app/test/build command had an explicit outer scratch `CODEFLOW_HOME`; fixtures also assign private homes before application imports. Only scratch repositories, fake providers, fake gh and a local bare origin were used. OS-assigned loopback ports avoided the live servers; owned servers stopped during fixture teardown. No live checkout, live home or real remote was touched, and no real PR was created. No unresolved issue remains in this cluster. Scheduling time-zone and PR-title ownership remains with their separate clusters.

## Issues

### t16-2 · minor · Security-alert sweep picks low-severity Dependabot alerts by default, contrary to the docs

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-33, SCH-35.

**Repro**

> 1. In the fake gh state, add a Dependabot alert with security_advisory.severity 'low' and a first_patched_version (here #4, jinja2).
> 2. Open Project → Automation → Process a backlog → Fix security alerts.
> 3. Look at the checkboxes, or call GET /api/github/sweep?kind=alerts.

**Expected:** docs/github.md: 'Picked by default: high and medium alerts that have a fix'. Low-severity alerts should start unpicked, as code-scanning low/note alerts do ('Low severity').

**Actual:** '#4 jinja2 (pip) / Low' is checked by default and the API returns selected:true. A daily alerts sweep would therefore start agent runs for low-severity Dependabot alerts, and webhooks would accept them.

**Root cause (verifier):** The bug is in src/sweeps.ts, `dependabotAlertItems`, around line 232: the item sets `selected: !covered && !!patched` and its note covers only the "covered" and "no fix" cases. It works out `severity` from the worst alert in the package group (line 216) but never uses it for selection.

The code-scanning branch of `alertItems` in the same file (lines 157-158) does gate on severity: `const serious = severityRank(severity) <= severityRank("medium")` (severityRank is in src/github.ts:561, order critical, high, error, medium, warning, low, note). It then sets `selected: serious` and `note: "Low severity"`.

Everything downstream trusts `item.selected`:
- the scheduled or "Run now" sweep (src/sweeps.ts:374 nextSweepItems, and the dry run at src/automation.ts:583);
- the webhook gate (src/automation.ts:810: `if (!item.selected) return { skipped: "the sweep wouldn't pick it: ..." }`).

So a low-severity Dependabot alert with a patched version is pre-checked in the dialog, picked by daily sweeps and accepted from webhooks.

The existing test fixture never has this case. test/sweeps.test.ts:98 has its only low Dependabot alert (left-pad) with `fixed: null`, which hides the gap.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/sweeps.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/sweeps.test.ts`

**Suggested fix:** In `dependabotAlertItems` (src/sweeps.ts), apply the same severity gate that code scanning uses:

```ts
const serious = severityRank(severity) <= severityRank("medium");
selected: !covered && !!patched && serious,
note: covered ? `Dependabot PR #${covered.number} already upgrades it` : !patched ? "No patched version yet" : !serious ? "Low severity" : undefined,
```

`severity` is already the worst alert in the package, so a package with one high and one low alert stays picked.

Better still, move the threshold into one helper, e.g. `const picksByDefault = (s?: string) => severityRank(s) <= severityRank("medium")`, and use it in both the code-scanning and Dependabot branches so they can't drift apart again.

An "unknown" severity ranks last, so it would start unpicked. That matches code scanning and the docs ("high and medium").

The webhook and automation paths need no change, because they already respect `selected` and `note`. The skip reason will then read "the sweep wouldn't pick it …

**Suggested regression test:** Add a test in test/sweeps.test.ts.

1. Add a low-severity Dependabot alert that has a fix to the fixture, e.g. `advisory(8, "minimist", "low", "< 1.2.6", "1.2.6", "Prototype pollution in minimist")`. This needs no matching Dependabot PR.
2. In "alerts sweep: Dependabot alerts per package..." assert:
   - `by["dependabot#8"].selected === false`
   - `by["dependabot#8"].note` matches `/Low severity/`
   - its task still says `upgrade it to 1.2.6` (it stays available to pick by hand)
3. Assert that …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server named v4693t162 on port 4693, with a new home at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4693t162. Before starting it I wrote fake-gh.json with these alerts:
- Dependabot #3 urllib3: high, with a fix
- Dependabot #5 requests: medium, with a fix
- Dependabot #4 jinja2: low, first_patched_version 3.1.5
- Dependabot #6 left-pad: low, no fix
- Code scanning #31: high
- Code scanning #32: security_severity_level low

1. In a fresh browser profile (no saved profile) I opened MQTT-MCP → Automation → backlog and clicked the "Fix security alerts" sweep chip (script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4693t162/r1.mjs, screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4693t162/002-alerts-default.png).
   - The "Needs work 4" view shows four rows, all checked: #31 High, #3 High, #5 Medium and "#4 jinja2 (pip) / Low". The button reads "Start 4 runs".
   - Under "All 6", code scanning #32 (Low) is unchecked with the note "Low severity", and left-pad is unchecked with "No patched version yet". Low jinja2 stays checked.
   - No console, page or 5xx errors.
2. GET /api/github/sweep?kind=alerts returned dependabot#4 {sev:"low", selected:true, no note} and code-scanning#32 {sev:"low", selected:false, note:"Low severity"}.
3. Automation and webhook paths (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4693t162/r2.mjs):
   - I saved a daily alerts sweep through POST /api/sweeps with a schedule. Its only item was absent from GitHub's list, so no run started (runs stayed []).
   - Dry run POST /api/automations/<id>/preview {via:"manual"}: selected [code-scanning#31, dependabot#3, dependabot#5, dependabot#4]. It skipped code-scanning#32 ("Low severity") and dependabot#6.
   - Preview {via:"webhook", source: dependabot alert #4}: selected ["dependabot#4"].
   - The same preview for low code-scanning #32: selected [].

So the daily sweep and webhooks would both start agent runs for a low-severity Dependabot alert.

Why this is not by design: docs/github.md:62 (sweep table) says "Picked by default: high and medium alerts that have a fix". docs/automations.md:43 says a webhook is accepted only if the list picks it: "not a l …

</details>

### t16-3 · minor · Sweep filter does not match severity although its placeholder says it does

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-33.

**Repro**

> 1. Open Fix security alerts and switch to All 8.
> 2. Type 'critical' in the 'Filter by number, title, label, severity…' box.

**Expected:** The critical pyyaml alert and the leaked-secret alert are listed.

**Actual:** Nothing is listed; the list says 'Nothing matches your filter.'

**Root cause (verifier):** ui/sweeps.tsx:121 builds the filter text from `${i.ref} ${i.title} ${i.detail} ${i.note ?? ""}`, so it never searches `i.severity` (or `i.labels`). The server keeps severity in its own field, separate from `detail`: src/sweeps.ts:167 for code scanning, :187 for secrets ("critical") and :231 for Dependabot. None of the `detail` strings contain the severity word (src/sweeps.ts:165, :185, :229). The UI shows severity as a separate badge (ui/sweeps.tsx:270), while the placeholder at ui/sweeps.tsx:225 says severity is searchable. Labels only work today because issue items happen to copy them into `detail` (src/sweeps.ts:96).

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/sweeps.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** In ui/sweeps.tsx:121, add the severity (and the labels, so the placeholder is fully honest) to the filter text. Example: `[i.ref, i.title, i.detail, i.note, i.severity, ...(i.labels ?? [])].filter(Boolean).join(" ").toLowerCase().includes(q)`. It would also help to move the text building into a small pure helper, e.g. `sweepFilterText(i)`, so a unit test can call it directly. Optional: if exact severity matching is wanted ("low" should not match the "Low severity" note on a Note item), treat a query that equals a known severity word as an exact match on `i.severity`. The plain substring fix is enough to deliver what the placeholder promises.

**Suggested regression test:** In test/e2e/ui.e2e.ts, next to the existing "sweep: pick open issues…" test, seed ghState with dependabotAlerts (one critical with no patched version), codeScanningAlerts (one high) and secretAlerts (one). Open "Fix security alerts", click "All N", fill the "Filter" field with "critical", and assert that the visible .sweep-item rows are exactly the pyyaml (critical) row and the leaked-secret row, and that "Nothing matches your filter." is absent. Then fill "high" and assert the high code-scannin …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4695 on 127.0.0.1:4695 with a fresh home. The fake-gh.json fixture was generated with the reporter's generator (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/t16/gh-state.mjs). It holds 5 Dependabot alerts (they group into 4 package items), 3 code-scanning alerts and 1 leaked secret. I made a throwaway local git repo (clones/v4695-alerts with a local bare origin), opened it in the UI with "Open another repository" and created the project "v4695 Alerts". Then I went to Project > Automation > backlog, clicked "Fix security alerts" and switched to "All 8". Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4695/repro.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4695/repro.log.

The 8 rows show severity badges Critical, Critical, High, High, High, Medium, Low, Note. The filter's placeholder reads "Filter by number, title, label, severity…". I typed each term key by key with pressSequentially:
- "critical" and "CRITICAL": 0 rows and "Nothing matches your filter." (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4695/002-v4695-filter-critical.png)
- "high": 0 rows, although 3 rows carry the High badge. Same result in the "Needs work" scope.
- "low": 1 row, but it is the wrong one. It matched #32 "Unused import", which has severity Note, only because its note text says "Low severity". The jinja2 row with the Low badge was not listed.
- Control terms worked: "pyyaml" 1 row, "#41" 1 row, "GitHub Personal" 1 row, "CodeQL" 3 rows.

The API at /api/github/sweep?kind=alerts returns `severity` on every item ("critical" for dependabot#5 and secret#41). No console or page errors. The behaviour does not depend on the reporter's setup: I used a fresh home, a fresh repo and my own profile, and the filter code is purely client side. The docs do not describe severity filtering as unsupported, and the placeholder explicitly promises it, so this is not by design. Cleanup: no runs were created, server v4695 is stopped, ports 4695/4696 are free, and the scratch clones are deleted.

</details>

### t16-17 · minor · When a backlog has more than 25 items picked by default, Start is disabled until the user unticks items by hand

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-34.

**Repro**

> 1. Have 30 or more open, unlabelled issues.
> 2. Open Fix open issues.

**Expected:** Pick the first 25 by default, or offer 'Pick first 25'.

**Actual:** 'Needs work 32 · 32 selected'. The 'Start 32 runs' button is disabled with 'Pick at most 25; the rest can go in a later sweep', so the user has to untick 7 items one by one.

**Root cause (verifier):** In ui/sweeps.tsx:99, when the list loads, the dialog picks every item the server marks `selected`. src/sweeps.ts:99 marks every issue that isn't labelled "not a fix" as selected, with no cap. ui/sweeps.tsx:117 then sets `chosen` to all of those picks. ui/sweeps.tsx:122 reports `chosen.length > MAX_SWEEP` (MAX_SWEEP = 25, ui/sweeps.tsx:37) as a blocking `problem`, which disables the Start button (`disabled={!!problem || ...}` in the footer). Two more things leave per-item unticking as the only way out:
- `pickShown(true)` (ui/sweeps.tsx:146-150, "Select shown") also adds every shown item with no regard for the cap.
- There is no control that picks only the first 25.

The same path affects the Dependabot and security-alert sweeps whenever more than 25 items are picked by default.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/sweeps.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/github.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Fix this in the UI and keep the server's 25-item guard (src/server.ts:783) as it is.

1. In ui/sweeps.tsx:99, cap the default pick: take the items that are `selected` and pickable, in list order, and keep only the first MAX_SWEEP of them. Ideally pull this into a small pure helper such as `defaultPicks(items, max)` so it can be unit-tested.
2. When the cap trimmed the default, show a short note that it isn't an error, e.g. "Picked the first 25 of 32; the rest can go in a later sweep". It could replace or sit next to the "N selected" count.
3. Make "Select shown" (pickShown(true), ui/sweeps.tsx:146) add shown pickable items only until the selection reaches MAX_SWEEP. Alternatively, keep it as is and add a "Pick first 25" link that appears whenever chosen.length > MAX_SWEEP.
4. Keep the existing message at ui/sweeps.tsx:122 for the case where the user ticks more than 25 by hand.
5. Update the "Picked by default" text in docs/github.md:58-60 and the note at line 71: issues are picked in l …

**Suggested regression test:** Add a test in test/e2e/ui.e2e.ts, next to the existing "sweep: pick open issues…" test:
- Seed ghState with 30 or more unlabelled issues.
- Open "Fix open issues".
- Assert the dialog shows "Needs work 30", 25 checked boxes and "25 selected", and that the "Start 25 runs" button is enabled.
- Click "None", then "Select shown" (or the new "Pick first 25" link), and assert the count is 25 again and Start is still enabled.
- Tick one more box by hand and assert the status shows "Pick at most 25" and …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server named "v4627-t1617" on port 4627 with a new, empty home. The existing "v4627" home already held another session's runs, so I left it alone. Before starting the server I seeded its fake-gh.json with 32 open, unlabelled issues (#101-#132). The browser script is at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4627-t1617/sweep25.mjs and uses a fresh profile, the same flow as test/e2e/ui.e2e.ts. It opens #/project/<MQTT-MCP id>/automation/backlog and clicks the "Fix open issues" sweep chip.

What I saw:
- On open: "Needs work 32 · All 32 · 32 selected", all 32 boxes ticked, the button reads "Start 32 runs" and is disabled, and the footer status says "Pick at most 25; the rest can go in a later sweep".
- The dialog's only buttons are Needs work, All, Select shown, None, Cancel and Start. None of them picks the first 25.
- "None" gives 0 selected. "Select shown" goes back to 32 selected with Start disabled.
- After unticking 7 boxes one by one: 25 selected, "Start 25 runs" is enabled and the status reads "Results wait in the inbox…".
- Cancel and reopen: back to 32 selected with Start disabled. The cap does not carry over.

No console errors or 5xx responses, and no runs were created. Screenshots are at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4627-t1617/001-initial-32-selected.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4627-t1617/003-after-untick-7.png.

Why it is not by design: docs/github.md:58-60 says Fix open issues picks "all" issues by default except non-fix labels, and docs/github.md:71 says "At most 25 runs start per sweep". Neither says the user should get an unstartable default and untick items by hand. The 25 limit on the server (src/server.ts:764/783) is deliberate. The UI's default pick is the part that breaks it. This is not caused by the environment or the tester's script: the selectors match the project's own e2e, and the behaviour follows directly from the code.

Cleanup: I stopped the server (port 4627 is no longer listening) and created no runs, worktrees or clones. One leftover: in my first command I overwrote fake-gh.json in the older QA home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/home …

</details>

### t16-4 · minor · 'Approve & push to PR #N' toast hides the warning that visual evidence was not posted

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-41.

**Repro**

> 1. With fake gh, start a Dependabot sweep run for failing PR #7 so it ends with triage pending.
> 2. Commit a .codeflow/evidence/after.png on the run branch, and set commentError:true in fake-gh.json.
> 3. In Inbox, click 'Approve & push to PR #7'.

**Expected:** The toast shows the warning 'The fix was pushed, but visual evidence could not be added to the PR: …'.

**Actual:** The toast says only 'Approved — pushed to PR #7'. The warning is saved silently in run.triage.note and appears only in the run log. Reproduced on PR #7 and on PR #11.

**Root cause (verifier):** This is a contract mismatch between the server route and the UI, added in commit 57d34c8. That commit changed the UI to read the triage response as a RunSummary but left the route unchanged.
- src/engine.ts:4577-4579: pushToPr catches the commentOnPr failure and returns {url, sha, warning}.
- src/engine.ts:5641-5647: triage() puts that warning into run.triage.note (`note: publicationWarning || input.note`) and returns run.
- src/server.ts:2708-2712: the POST /api/runs/:id/triage handler awaits manager.triage(...) but ignores its result and always replies `send(res, 200, { ok: true })`.
- ui/automations.tsx:231-233: TriageActions does `const result = await post<RunSummary>(...)` and checks `result.triage?.note?.startsWith("The fix was pushed, but")`. result is {ok:true}, so result.triage is always undefined and the toast falls back to `Approved — pushed to PR #N`.
After approval the item leaves the Inbox, so the only remaining trace is the run log and the stored triage.note.
A secondary weakness: even if the server sent triage back, finding the warning by string prefix on triage.note mixes it up with the user's own approval note, which uses the same field.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/sweeps.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Return the publication warning explicitly and show it the same way the run page does.
1. src/engine.ts triage(): also expose the warning, e.g. return `Object.assign(run, ...)` or, better, give triage an approve result such as `{ run, warning: publicationWarning }`. Keep saving it in run.triage.note for history.
2. src/server.ts:2711: capture the result and send it back, e.g. `const outcome = await attempt(() => manager.triage(...)); return send(res, 200, { ok: true, warning: outcome?.warning, triage: (await manager.getAsync(run.id))?.triage });`. The smallest possible fix is just returning `{ ok: true, triage: run.triage }` after the await, which satisfies the existing UI check.
3. ui/automations.tsx:231-233: type the response as `{ ok: boolean; warning?: string }`. Use `result.warning` instead of the startsWith check on triage.note. Show it with a longer duration, `showToast(result.warning, 8000)`, matching ui/run.tsx:1056.

**Suggested regression test:** 1. Engine level, test/sweeps.test.ts, in the Dependabot test around line 328: before `manager.triage(run.id, { decision: "approve", pushPr: true })`, commit a .codeflow/evidence/x.png on run.artifacts[0].branch and set fake gh `commentError = true`. Assert the triage result carries `warning` matching /fix was pushed, but visual evidence could not be added/, that the origin head still advanced, and that run.triage.state is "approved".
2. Route/UI level, test/e2e/ui.e2e.ts, next to the Inbox appro …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server, v4601 on port 4601. The old v4601 home was moved to homes/v4601.prev-222011 and I used a new browser profile, v4601t164.
1. Setup: I made a scratch bare clone of MQTT-MCP at clones/v4601-t164.git and a working clone at clones/v4601-t164. I pushed the branch dependabot/pip/paho-mqtt-2.0 with one commit and set refs/pull/7/head to it. homes/v4601/fake-gh.json was seeded with PR #7 (Dependabot, failOn "all").
2. UI: I clicked "Open another repository" and created project "v4601 t164". On Backlog I opened "Fix Dependabot PRs"; the only item was "#7 ... CI failing". I set the roles to claude/codex and the check to `test -f README.md`, then started it. Result: POST /api/sweeps 201, run 2610252120-154bb2c6. It ended with status done, verdict passed and triage {state:"pending"}, with a 2-file diff.
3. In the run worktree I committed .codeflow/evidence/after.png (a 1x1 PNG) on codeflow/2610252120-154bb2c6/build. I set commentError:true in fake-gh.json.
4. UI: In Inbox the item showed the buttons [Revise, ✓ Approve, Approve & push to PR #7, Reject]. I clicked "Approve & push to PR #7".
Observed:
- Request: {"decision":"approve","note":"","pushPr":true}. Response: 200 {"ok":true}.
- Toast: "Approved — pushed to PR #7", unchanged after 1.5 s.
- The push did happen: origin dependabot head moved 2563a9a6 -> 722584b3. PR #7 has 0 comments.
- GET /api/runs/<id> shows triage {state:"approved", note:"The fix was pushed, but visual evidence could not be added to the PR: gh pr comment failed: GitHub comment permission denied"}.
- The item left the Inbox, and the warning text appears 0 times on the Inbox page. The run log has the warn event (jsonl seq 66), and the warning appears only once on the run page, in the step log.
- Scripts: work/v4601-t164/a1-setup.mjs and a2-approve-push.mjs. Logs: a1.log and a2.log. Screenshots: shots/v4601/002-t164-toast.png and 003-t164-run-page.png.
Not by design: docs/github.md:79 says "A failed comment is reported separately from a successful push". The run page's own Push to PR button does show this warning (ui/run.tsx:1055-1056 uses result.warning in an 8 s toast). Only the Inbox triage path loses it.
It does not depend on the environment or the script: the fake gh comment failure is the documented test hook (test/github.test.ts:596), and the button and selectors are the real Inbox ones.
Cleanup: I deleted the run via the Inbox bulk "Delete…" (0 runs left) and stopped the v4601 server; ports 4601 and 4603  …

</details>

### S03-7 · minor · TriageActions reads result.triage.note to show 'The fix was pushed, but …', but POST /api/runs/:id/triage returns {ok:true}, so the warning toast never appears and the user sees 'Approved — pushed to PR #N' even when posting the visual evidence failed.

Source: code-level suspect at `ui/automations.tsx:233` (confirmed hands-on).

**Repro**

> Fake server s03 with a scratch repo and a bare origin. In fake-gh.json, PR #1 (dependabot[bot], head 'feature', failOn 'all', refs/pull/1/head published). Setup via POST /api/sweeps kind=dependabot, Agent/codex, check 'true': the run finished with triage pending and a change on codeflow/<id>/solo. Committed .codeflow/evidence/result.png in the run worktree (as the github.test.ts visual-evidence test does) and set fake-gh commentError=true. Then in the UI Inbox clicked 'Approve & push to PR #1' (triage.mjs). The network response was 200 '{"ok":true}' and the only toast was 'Approved — pushed to PR #1'. Origin 'feature' moved to the evidence commit (push succeeded). GET /api/runs/<id> shows triage.note = 'The fix was pushed, but visual evidence could not be added to the PR: gh pr comment failed: GitHub comment permission denied', and the run log has the warn line. The item then disappeared from the Inbox.

**Expected:** Toast: 'The fix was pushed, but visual evidence could not be added to the PR: …'.

**Actual:** Toast: 'Approved — pushed to PR #1'. The warning is only in run.triage.note and the run log, which nobody is pointed to.

**Root cause (verifier):** src/server.ts:2711 discards manager.triage()'s return value (the updated Run with triage.note) and sends {ok:true}. The client casts the response to RunSummary, so result.triage is undefined and the warning branch never runs.

**Suggested fix:** Return the run from the route, e.g. `const run = await attempt(() => manager.triage(...)); return send(res, 200, summary(run))` (whatever serializer other run routes use), or return {ok:true, warning: run.triage?.note}. Have the client read that field. Keep the client check consistent with the server text.

**Suggested regression test:** Server/HTTP test: with fake gh commentError=true and committed evidence on a sweep run from a PR, POST /api/runs/:id/triage {decision:'approve', pushPr:true} returns a body whose triage.note (or warning) matches /fix was pushed, but visual evidence could not be added/. A UI test asserts the toast text.

### t16-5 · minor · Clearing a Revise budget field sends 0 and the server rejects the revision

Source: tester unit scheduling-inbox-notifications-2; observed with fake-agents; features SCH-42.

**Repro**

> 1. In Inbox, type a note in 'What should change?' on any triage-pending item.
> 2. Open 'Revision budget' and clear 'Maximum calls' (or 'Maximum minutes').
> 3. Click Revise.

**Expected:** An empty field either falls back to the default budget or disables Revise with an inline explanation.

**Actual:** The summary reads 'Revision budget · 0 calls · 240 min'. The request body has budget {maxSteps:0, maxInvocations:0}, the server answers 400 and the toast says 'Follow-up budget needs 1–200 calls and 1–720 minutes'.

**Root cause (verifier):** ui/automations.tsx:257 (TriageActions): both budget inputs use onInput={(event) => setCalls(Number(event.currentTarget.value))} and the same with setMinutes. An empty number input (or partial input such as "e" or "-") has value "", and Number("") is 0. Because the input is controlled (value={calls}), the field then re-renders as "0" and the summary shows "0 calls".

ui/automations.tsx:258-260: the Revise button is disabled only on running || busy || !note.trim(). There is no check that calls is in 1–200 or minutes in 1–720, and no inline message.

ui/automations.tsx:231 sends budget {maxSteps: calls, maxInvocations: calls, maxMinutes: minutes} unchanged. src/engine.ts:699 (followUpBudget) correctly rejects values outside 1–200 / 1–720 with "Follow-up budget needs 1–200 calls and 1–720 minutes", which reaches the user only as a 400 toast.

The same out-of-range path covers values above the maximum (calls > 200, minutes > 720) and fractional calls such as 2.5, which fail isSafeInteger.

Compare ui/run.tsx:1834: const budgetValid = Number.isInteger(followupSteps) && followupSteps >= minimumCalls && followupSteps <= 200 && Number.isFinite(followupMinutes) && followupMinutes >= 1 && fol …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/automations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/automation-controls.e2e.ts`

**Suggested fix:** In TriageActions (ui/automations.tsx), copy the run.tsx pattern:
1. Add const budgetValid = Number.isInteger(calls) && calls >= 1 && calls <= 200 && Number.isFinite(minutes) && minutes >= 1 && minutes <= 720.
2. Disable Revise when note.trim() && !budgetValid.
3. Inside the details (or above the buttons) render <p class="msg err" role="alert">Choose 1–200 calls and 1–720 minutes.</p> while the budget is invalid. Consider opening the details automatically when invalid so the error can be seen.
4. Optionally stop the field snapping to "0" by reading event.currentTarget.valueAsNumber (NaN when empty), so it stays blank and fails budgetValid. The summary would then show "—" instead of "0 calls".

Better still, move the budget inputs, validity check and message into one shared BudgetFields component used by ui/run.tsx (follow-up and goal revision), ui/team.tsx (task rerun) and ui/automations.tsx (triage revise), so the three editors cannot diverge again.

Keep the server check in src/engine …

**Suggested regression test:** Add a browser test to test/e2e/automation-controls.e2e.ts (fake agents), or a new inbox-triage e2e:
1. POST /api/automations with a solo run (loop maxSteps 5, maxMinutes 10), POST /api/automations/:id/run, and wait for triage.state === "pending".
2. Go to #/inbox, fill 'What should change? (for Revise)', click .followup-budget > summary and fill getByLabel('Revision maximum calls') with "".
3. Assert the Revise button isDisabled() === true and getByRole('alert') contains "1–200 calls".
4. Record …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server (v4603t165 on port 4603, new home) with a new scratch repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4603t165-tiny. Through the API I created a solo automation (maxSteps 5, maxMinutes 10) and used Run now. Run 2610252120-f1fd810d finished with status done and triage {state: pending}. I then opened a fresh headless Chrome with no profile at http://127.0.0.1:4603/#/inbox and did the rest like a user (script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4603t165/revise.mjs, log: revise.log in the same folder):

1. Typed "Please also add a goodbye line" in 'What should change? (for Revise)'. The summary read "Revision budget · 5 calls · 10 min".
2. Opened the budget and cleared 'Maximum calls' with the keyboard (Cmd+A, Backspace), not with Playwright fill(). The summary changed to "Revision budget · 0 calls · 10 min". The field snapped to the value "0" (validity.rangeUnderflow=true). Revise stayed enabled and no inline error appeared.
3. Clicked Revise. The request was {"decision":"revise","note":"…","budget":{"maxSteps":0,"maxInvocations":0,"maxMinutes":10}}. The server answered 400 {"error":"Follow-up budget needs 1–200 calls and 1–720 minutes"}, and that text appeared as the toast.
4. Set calls back to 5 and cleared 'Maximum minutes'. The summary read "5 calls · 0 min" and Revise was still enabled. The request had maxMinutes 0 and got the same 400 and toast.

The run stayed done/pending with 0 follow-ups, and the browser console logged two 400 errors. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4603t165/002-after-revise-cleared-calls.png.

Control (control.mjs): Revise with the default budget (5 calls, 10 min) returned 200, the toast said "Sent — the agent is revising it", and a follow-up finished. So the 400 comes only from the 0 value.

Why this is not by design and not caused by the environment:
- The fake agent plays no part; the bug is client-side validation plus the server's range check.
- Clearing with real keystrokes gives the same result, so it is not a selector or fill() artifact.
- The other budget editors in the same UI do guard this case. ui/run.tsx:1834/1945/2005 computes budgetValid, disables Send and shows "Send is off until the budget below allows N–200 c …

</details>

### S01-3 · minor · Revision budget inputs use Number(value). Clearing a field sends 0 with no client-side validation despite min=1.

Source: code-level suspect at `ui/automations.tsx:256` (confirmed hands-on).

**Repro**

> Fake server s01: automation → manual fire → run done with triage pending. In #/inbox, type a Revise note, open 'Revision budget', and clear 'Revision maximum calls'. The input value becomes '0', validity.valid is false, and the summary reads 'Revision budget · 0 calls · 10 min'. Revise stays enabled. Clicking it POSTs /api/runs/<id>/triage {decision:'revise', budget:{maxSteps:0,maxInvocations:0,maxMinutes:10}}, which returns 400 'Follow-up budget needs 1–200 calls and 1–720 minutes', shown as a 5 s toast (shots/s01/002-triage-after-revise.png). The server guard (engine.ts followUpBudget) prevents any bad state, and the note is kept.

**Expected:** Inline validation like the run view: an error next to the fields, Revise disabled (or no request sent) while the budget is out of range, and an empty field not snapping to 0.

**Actual:** An invalid budget is sent, rejected by the server and reported only in a transient toast. The cleared field shows 0.

**Root cause (verifier):** TriageActions binds the inputs with onInput={e => setCalls(Number(e.currentTarget.value))}. Number('') is 0, so the controlled input immediately shows '0'. act('revise') posts the budget without checking it. The run view's equivalent follow-up and resume budgets (ui/run.tsx:1834 budgetValid, :303 allocationValid) show an inline 'Choose 1–200 calls and 1–720 minutes' error. The Inbox triage panel has neither the check nor a disabled button.

**Suggested fix:** Keep the raw string state, or use valueAsNumber with NaN handling. Compute budgetValid = Number.isInteger(calls) && calls>=1 && calls<=200 && Number.isFinite(minutes) && minutes>=1 && minutes<=720. Disable Revise when it is false and render <p class="msg err" role="alert">Choose 1–200 calls and 1–720 minutes.</p> inside the details, reusing the run.tsx pattern.

**Suggested regression test:** e2e (automation-controls or ui suite): on a pending triage item, fill the note, clear 'Revision maximum calls', and assert Revise is disabled and the inline error is visible. Assert no POST to /triage is made. Then enter 3 and assert the request carries maxSteps 3.

### t16-6 · minor · Triage API accepts decisions on runs already approved or rejected

Source: tester unit scheduling-inbox-notifications-2; observed with api; features SCH-39.

**Repro**

> 1. Reject a sweep result in Inbox. Its worktrees and branches are deleted and it is archived.
> 2. POST /api/runs/<id>/triage {"decision":"approve"}.
> 3. Separately, approve a result, then POST /api/runs/<id>/triage {"decision":"approve","openPr":true}.

**Expected:** 409/400 'This result was already approved/rejected'.

**Actual:** Step 2 returns 200 and triage flips from rejected to approved on an archived run with no branches. Step 3 returns 200, pushes the branch and opens PR #15 for an already-approved result. The UI hides the buttons once triage is no longer pending, so only API callers or stale tabs can do this.

**Root cause (verifier):** The cause is in src/engine.ts:5611-5655, triage(). After managedContinuation(), the method checks only `!run.trigger` (line 5614) and `this.busyRun(run)` (line 5615). It never checks `run.triage?.state === "pending"`, so every decision branch runs on a run you have already decided:
- 'reject' (5634-5637) overwrites the state and runs archive again.
- 'approve' (5638-5655) overwrites approved or rejected with approved, and with openPr/pushPr it calls pullRequest() or pushToPr() first. It succeeds on an approved run and fails with a raw git error on a rejected run whose branch is gone.
- 'revise' (5618-5632) sets `run.triage = {state:"pending"}` at line 5625 before calling followUp() or resume(). followUp un-archives the run, so a rejected run with deleted branches goes back into the Inbox even though its follow-up then fails.

src/server.ts:2707-2711 (POST /runs/:id/triage) checks only that decision is one of approve/revise/reject before calling manager.triage(). The UI gate (ui/automations.tsx:216, ui/run.tsx:325 render TriageActions only when triage.state === "pending") is the only thing enforcing a single decision, and it applies only in the browser.

Severity stays minor. A norm …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/automation.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`

**Suggested fix:** In src/engine.ts triage(), add a guard right after the busyRun check, before any decision branch and before any state changes or side effects:

```ts
if (run.triage?.state !== "pending") throw new RunConflictError(run.triage ? `This result was already ${run.triage.state === "empty" ? "archived with no changes" : run.triage.state}` : "This run isn't waiting in the inbox");
```

RunConflictError is already defined at engine.ts:847, and attempt() in server.ts:583 maps it to 409, so the endpoint returns 409 with no server.ts change. Because the guard runs first, pullRequest/pushToPr/archive/followUp are never reached and nothing is pushed, deleted or un-archived.

Keep the "empty" archive outside triage: it is revisited through ordinary replies, and toInbox() puts it back to pending. Optionally, make the UI toast in TriageActions refresh the run on 409, for a tab that lost its live connection. Add a row for POST /runs/:id/triage to docs/api.md: decisions are accepted only while triage is p …

**Suggested regression test:** Extend test/automation.test.ts. In "revise sends your note to the agent and returns to the inbox; reject archives and deletes", after the reject assertions, add:
- `await assert.rejects(manager.triage(run.id, { decision: "approve" }), /already rejected/)`
- `await assert.rejects(manager.triage(run.id, { decision: "revise", note: "x" }), /already rejected/)`
- assert that run.triage.state is still "rejected", run.archived is still true, and run.followUps.length is unchanged.

In "a scheduled run  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4605t166 on 127.0.0.1:4605, with a new home. I made a scratch bare clone of MQTT-MCP plus a working clone, so the clone's origin was the scratch bare repo. Through the API I created a webhook-only automation (solo pattern, fake claude, check off) and fired it twice. That gave run A (2610252122-75194d22) and run B (2610252122-1f3bf95c), both status=done with triage=pending and a one-file diff.

In the UI (headless Chrome), on run A's page I clicked Reject and then 'Reject result' in the confirm dialog. Run A became triage=rejected and archived=true, and its worktree and branch were deleted. On run B's page I clicked '✓ Approve', which set triage=approved. On both pages the triage buttons disappeared. A second tab already open on run A also hid its buttons live after the reject, so a stale tab only matters if it has lost its live connection.

Then I called the API with the bearer token:
(1) POST /api/runs/A/triage {decision:"approve"} returned 200 {ok:true}. Run A became triage=approved while still archived=true, with no branch or worktree. The log reads "You approved the result".
(2) POST /api/runs/A/triage {decision:"reject"} returned 200 again, re-running archive (log: "Archived: removed 0 worktree(s); branches kept").
(3) POST /api/runs/A/triage {decision:"approve",openPr:true} returned 400 with a raw git error ("git rev-parse --verify refs/heads/codeflow/.../solo^{commit} failed"), because the branch had been deleted.
(4) An extra case beyond the report: POST /api/runs/A/triage {decision:"revise",note:"Change the greeting"} returned 200. The follow-up failed ("Branch ... was deleted, so the work in solo is gone"), but triage was already set back to pending and the run was un-archived. The rejected run reappeared in the Inbox ('Results to review', 1 item) with Revise / Approve / Approve & open PR / Reject buttons, although it has no work left.
(5) POST /api/runs/B/triage {decision:"approve",openPr:true} on the already-approved run B returned 200. It pushed the branch to the scratch origin and fake gh opened PR #1 (run.prs records https://github.com/o/r/pull/1), and the run log says "You approved the result and opened ...".

I looked for evidence that this is intended and found none. docs/automations.md 'The inbox' describes Approve / Revise / Reject as one decision, with Reject deleting the worktrees and branches. docs/api.md has no entry for re-deciding. engine.ts toInbox() at line 5588 says "you already decided" and …

</details>

### S09-5 · minor · triage() checks only run.trigger and busy state, not that triage.state is 'pending', so approve can be sent after reject and approve/openPr can be repeated.

Source: code-level suspect at `src/engine.ts:5611` (confirmed hands-on).

**Repro**

> Fake s09: automation (solo/claude) on the scratch repo, 'Run now' via the Scheduling UI, run done with triage pending. Two tabs on #/run/<id>: tab A Reject, then 'Reject result'. Then API approve, reject, approve, all 200 (work/s09/07-triage.mjs, output work/s09/07b.log).

**Expected:** Once a result is rejected (worktrees and branches deleted, run archived), or decided at all, a later approve/reject should fail with 409 'already decided' (or be an idempotent replay of the same decision).

**Actual:** After a UI Reject (confirmed, branch deleted, archived=true), POST /api/runs/:id/triage {decision:'approve'} returned 200, and triage became {state:'approved', note:'late approve'} with no branches left. A further reject and approve also returned 200 and flipped the state again. The run log shows 'You approved the result' after 'Archived: removed 1 worktree(s) and 1 branch(es)'. The UI hides TriageActions when the state is not 'pending' (tab B updated over SSE), so exposure is stale or racing clients, phone/remote clients and direct API callers.

**Root cause (verifier):** Manager.triage() has no state guard. Reject sets triage 'rejected' and archives with deleteBranches, and approve unconditionally overwrites run.triage to 'approved' (and runs pullRequest/pushToPr when openPr/pushPr is set) whatever the prior decision was.

**Suggested fix:** At the top of triage(): if run.triage?.state !== 'pending', throw a 409-style error (e.g. 'This result was already approved/rejected'). Optionally accept an idempotent replay of the same decision. Keep revise allowed only from pending or empty as product rules require.

**Suggested regression test:** Engine test: automation run reaches pending; triage reject; then triage approve rejects with /already/ and triage.state stays 'rejected'. Second test: approve with openPr twice; the second call is rejected (or no-ops) without another push or PR call.
