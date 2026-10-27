# Cluster 50 · integration-connections

**Integration connections view: disconnect confirmation, workflow leaks, test feedback, truncation**

Status: **fixed and verified** · 9 issues · branch `codex/qa-integration-connections`

Planner notes: All in ui/integration-connections-view.tsx unless noted. t20-5: Disconnect deletes the credential and every project binding with no confirmation. S13-5, in ssh-connections, covers SSH Remove with the same confirmAction pattern. t20-6: 'Start task from issue' for GitLab, Linear or Jira keeps the pattern from a previous GitHub template (applyTemplate/setPattern in ui/state.ts). t20-7: a failed Test connection shows its error off-screen, and 'Retry' doesn't retry the test (act() shares one error slot). t20-8: result.truncated is dropped at the 1000-item cap. t20-9: an invalid CODEFLOW_INTEGRATIONS_JSON hides app-managed connections behind 'storage is unavailable' (the load gating at src/server.ts:247). t20-11: in code-hosts.e2e the 'Review pull request' click is lost because busy starts false before the initial load. t20-12: 'Review result and create PR' drops the branch and lands on the run page without showing the PR action. t20-15: wording and docs. S14-6: the legacy IntegrationsView (ui/integrations.tsx) and its /api/integrations routes are dead code.

Likely files: `ui/integration-connections-view.tsx`, `src/integration-connections.ts`, `src/integration-connections-api.ts`, `src/integrations.ts`, `src/server.ts`, `ui/state.ts`, `ui/navigation.ts`, `ui/integrations.tsx`, `ui/settings.tsx`

## Resolution and verification · 2026-10-26

All nine reports were confirmed against the current implementation or their already-integrated precursor fix, and completed in the isolated worktree `/private/tmp/codeflow-qa-integration-connections`.

| Issue | Outcome |
| --- | --- |
| t20-5 | Disconnect now confirms credential deletion, every distinct affected project, and notification cancellation when applicable. The summary API exposes only project IDs, never credentials. Cancel preserves the encrypted store byte-for-byte; confirmation removes every binding and shows a success message. |
| t20-6 | `applyExternalIssue` selects the issue template (Fix & review, with Agent fallback), resets earlier criteria/source state, and attaches the selected external source last. GitLab, Linear and Jira each reset a prior Review council draft and its manually entered acceptance criterion. |
| t20-7 | Failed actions stay beside their connection with its readable name. Retry repeats the failed action, including the same test POST. A list refresh failure after a successful mutation remains a separate list error and cannot retry the completed mutation. |
| t20-8 | The picker preserves provider truncation, displays the count and limit notice, and hides Load more at the cap. A 1,040-issue fixture displays 1,000 results; refreshing a smaller response clears the notice. |
| t20-9 | Invalid administrator source or notification configuration warns explicitly while the encrypted connection registry still loads. Notification configuration tolerance is opt-in and limited to the administrator configuration phase; damaged delivery storage still fails closed, remains unchanged, and marks notification destinations unavailable while other services work. |
| t20-11 | The incoming base already initialized loading before first paint. Kind buttons now remain usable during slow requests, and generation checks discard both stale listings and stale imports after a kind switch or unmount. The original code-host cases and both delayed-response cases pass. |
| t20-12 | GitHub completed work opens the exact chosen branch in Review, expands publishing and artifact actions, and focuses its PR panel. The target branch and enabled Push & open PR control are visible. The intent is consumed once; reload closes publishing. No PR POST, fake GitHub state mutation, or local origin ref change occurs from the handoff. |
| t20-15 | Linear/Jira use Choose issue, Jira validation names Jira site URL, Settings has one Integrations heading at desktop and 390 px, and product documentation describes the current flow. |
| S14-6 | Removed the unreferenced `ui/integrations.tsx`. The documented direct `/api/integrations` API remains supported and is exercised after disconnect; product docs distinguish it from the current project Connections UI. |

Validation:

- `test/qa-integration-connections.test.ts` plus the existing integration-connections, integrations and notifications suites: **26/26 passed** (five new cases), including notification preference preservation and damaged-delivery byte preservation.
- `test/e2e/qa-integration-connections.e2e.ts`: **12/12 passed** in real Chrome against fresh isolated servers. Includes all original UI paths, cancel/confirm, missing credentials, exact Retry POSTs, request abort and recovery, slow list/import races, pagination cap/reset, three external providers, selected-branch PR handoff, mobile layout, invalid-admin restarts and final log assertions.
- Original `integration-connections.e2e.ts`: **5/5 passed**; original `code-hosts.e2e.ts`: **2/2 passed**. The existing disconnect test now confirms the new dialog. These cover both-theme phone accessibility, reconnect/authentication, controlled notification delivery, untrusted source/run startup, and fake-provider review/publication.
- TypeScript `tsc --noEmit` and `git diff --check`: **passed**.
- Final browser log contains no unexpected console errors or page exceptions. Four expected resource failures are scoped to their injected connection test URLs (two missing-credential 400s, one aborted request, one missing Jira URL 400). The application log contains exactly the deliberately invalid source JSON diagnostic plus normal shutdown entries. A prior run recorded one `GET /api/health failed` / `The backend is stopping` during intentional shutdown; the test now records that exact diagnostic only within captured shutdown windows separately from application failures. The final run had none.

All test/build/application invocations used explicit scratch `CODEFLOW_HOME`; child processes also use scratch OS homes, a non-login shell wrapper, fake agent/GitHub CLIs, a local bare Git origin, and a fixture transport that rejects nonfixture outbound fetches. No live server, real credentials, user project, external delivery or remote mutation was used. Fixture compatibility does not establish live provider account compatibility.

Evidence (local): `/private/tmp/codeflow-qa-continue/connections50-unit.log`, `connections50-final-browser.log` (18-case combined pass before the added stale-import case), `connections50-final-new.log` (final 12-case pass), and `connections50-tsc.log`. Final screenshots and browser/server/application logs are under `output/playwright/qa-integration-connections/` in the isolated worktree; `disconnect-impact.png`, `card-test-failure.png`, `truncated-issues.png`, and `review-pr-handoff.png` show the key outcomes. Owned servers are stopped after tests.

Notification handoff for cluster54: `Notifications.load(input?, { allowInvalidAdministratorConfig: true })` preserves strict default behavior and tolerates only implicit administrator configuration failures. Server startup opts in; `configurationWarning` is surfaced in Connections. A delivery-state failure still prevents notification `applyManaged`, test/setup and delivery, and preserves the file. This cluster does not change enqueue, retry or recovery semantics.

## Issues

### t20-5 · minor · Disconnect deletes the credential and all project bindings with no confirmation

Source: tester unit github-codehosts-imports-2; observed with fake-agents; features GH-22.

**Repro**

> 1. Connect GitLab or Bitbucket with a token and bind it to a project repo. 2. Open the row's '…' menu (Test connection / Reconnect / Remove from project / Disconnect). 3. Click Disconnect.

**Expected:** A confirmation that names the credential and the affected projects (Disconnect sits directly below 'Remove from project'), or an undo.

**Actual:** No native dialog, no <dialog>, no toast. The connection, its encrypted secret and every binding disappeared immediately (T20 Bitbucket).

**Root cause (verifier):** UI:
- ui/integration-connections-view.tsx:61: the Disconnect MenuItem calls `act(c, "disconnect")` directly.
- ui/integration-connections-view.tsx:29-35: `act()` sends DELETE /api/integration-connections/:id at line 33 with no confirmAction gate. Afterwards it only reloads; there is no toast or undo.
- The project view's ConnectionPage only holds the current project's bindings (`data.bindings` from GET /projects/:id). The UI therefore cannot even tell the user which other projects will lose the connection.
Server:
- src/integration-connections-api.ts:51 routes DELETE to `connections.disconnect()`.
- src/integration-connections.ts:226-229 removes the connection and every binding with that id (`next.bindings.filter(b => b.connectionId !== id)`), across all projects.
- src/integration-connections.ts:131-133: `change()` prunes secrets no longer referenced, so the encrypted token is erased from connections.enc. There is no server-side undo or retention.
- For Slack/webhook destinations, src/notifications.ts:170 also cancels queued deliveries ("Destination disconnected or changed").
Severity stays minor. It is recoverable by reconnecting, but the user must re-obtain the provider token (G …

**Files:** `ui/integration-connections-view.tsx`, `src/integration-connections.ts`, `test/e2e/integration-connections.e2e.ts`, `test/integration-connections.test.ts`, `docs/project-integrations.md`

**Suggested fix:** 1) In ui/integration-connections-view.tsx, import `confirmAction` from ./confirm-state.js. In the disconnect branch, before setBusy/DELETE, await something like: `confirmAction("Disconnect <name> (<scope>)? Its saved credential is deleted from this server and it is removed from <N> project(s): <names>. The token is not revoked at <provider>. To keep it for other projects, use Remove from project instead.", { title: "Disconnect <name>?", confirmLabel: "Disconnect", danger: true })`. Return without changes if cancelled.
2) The project view only knows its own bindings, so the server must expose usage. In src/integration-connections.ts `list()`, add a `projects: string[]` (distinct projectIds from state.bindings) or a `bindingCount` to each app-managed ConnectionSummary. The UI maps the ids to names via `projects.value`.
3) For notification providers, add "Pending deliveries are cancelled" to the message.
4) After a successful disconnect, call `showToast("Disconnected <name>")`.
5) Optiona …

**Suggested regression test:** test/e2e/integration-connections.e2e.ts, the "...and disconnect removes bindings" test around line 150:
- After clicking menuitem "Disconnect", assert `page.getByRole("dialog", { name: /Disconnect Project GitLab/ })` is visible and its text contains the bound project's name and "credential".
- Click "Cancel". Via the API, assert the connection still exists and the binding remains.
- Reopen the menu, click Disconnect, then click the dialog's "Disconnect" button. Then assert the existing expectati …

<details><summary>Verifier's independent reproduction</summary>

Fresh home: an earlier v4653 home existed, so I moved it aside to homes/v4653.prev-232044 and started from an empty home. Started with `SOURCE_IMPORT_KEY=<random hex>`, `NODE_OPTIONS=--import <dogfood>/test/fake-integration-transport.mjs` and `qa-server.sh start v4653 4653 fake`. I used only the repo's stock fixture, not the reporter's t20 fixture. Fresh headless browser (no profile), driven by script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4653/t20-5-disconnect.mjs (log at work/v4653/t20-5.log).
1) Settings -> Integrations -> GitLab -> Connect. Private token = test key, name "V4653 GitLab", project MQTT-MCP, scope group/repo, API base https://source-fixture.invalid/api/v4/. Test connection said "Connection verified. Repository or workspace is accessible.", then Connect. connections.enc grew to 800 bytes.
2) OPCUA-MCP -> Connections -> "Use in this project". Result: one binding in MQTT-MCP and one in OPCUA-MCP.
3) On the OPCUA-MCP Connections page I opened "Manage V4653 GitLab connection". Menu items: [Test connection, Reconnect, Remove from project, Disconnect]; Disconnect sits directly below Remove from project (shots/v4653/002-t20-5-menu-open.png). I clicked Disconnect and polled for 3 s with a page 'dialog' listener attached.
Result: native dialogs [], open <dialog> max 0, .confirmation-dialog 0, toasts [], alerts []. The connection was gone from GET /api/integration-connections after 145 ms. Bindings for both MQTT-MCP and OPCUA-MCP were [], including the other project the user was not looking at. connections.enc shrank from 800 to 156 bytes, so the encrypted token was pruned. The card now reads "Not connected" (shots/v4653/003-t20-5-after-disconnect.png). No console or 5xx errors.
Refutation attempts:
- Not caused by the tester's environment: reproduced from a fresh server, fresh browser, stock fixture and a different provider path (GitLab, not Bitbucket).
- Not documented as intentional: docs/project-integrations.md:13 describes what Disconnect removes but says nothing about skipping confirmation.
- The app's comparable destructive actions all go through confirmAction, e.g. team "Disconnect this computer" (ui/collab-settings.tsx:77), delete project (ui/projects.tsx:170), delete automation and replace webhook secret (ui/automations.tsx:327 and :364). A few minor removals don't (SSH host Remove, phone devices), so the codebase is not uniform. It still reads as an oversig …

</details>

### t20-6 · minor · 'Start task from issue' for GitLab/Linear/Jira keeps the workflow from a previous GitHub template (e.g. Review council)

Source: tester unit github-codehosts-imports-2; observed with fake-agents; features GH-24.

**Repro**

> 1. Fresh browser. Project → Connections → GitHub → Choose issue or PR → Review pull request → Load PR preview (#8) → 'Review pull request' (composer shows 'Template: Review council'). 2. Back to Connections → GitLab connection → Choose issue → 'Start task from issue'.

**Expected:** The issue task starts from a neutral or issue-appropriate workflow, or the stale template is cleared.

**Actual:** The composer shows the task 'Address the selected issue…' with 'Template: Review council' and Workflow = council.

**Root cause (verifier):** ui/integration-connections-view.tsx:108. ProjectConnectionActions.start() sends GitHub items through applyTemplate(), which calls setPattern(t.pattern) at ui/state.ts:1184-1191 and setPattern at ui/state.ts:727-732. setPattern persists the pattern to the draft and to localStorage("pattern"). The external-source branch, `else if (preview.source) { source.value = null; externalSource.value = preview.source; setTask("Address the selected issue…"); }`, only replaces source, externalSource and task. It never chooses a workflow, so whatever pattern the per-project draft or browser preference last held stays in place. After a GitHub "Review pull request" that is the read-only council pattern (src/templates.ts:43-48 → src/patterns/council.ts: "Read-only — nothing is changed"). It also leaves acceptance criteria from an earlier template in place. The composer label at ui/composer.tsx:328 (`Template: ${p?.name}`) then shows "Template: Review council" on the issue task. The engine puts no workflow restriction on externalSource runs (src/engine.ts:5185-5195 only locks down trust and checks), so the run goes ahead as a review council.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/integration-connections-view.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/integration-connections.e2e.ts`

**Suggested fix:** Add a state helper in ui/state.ts next to applyTemplate, e.g. `applyExternalIssue(src: ExternalSource)`, and call it from integration-connections-view.tsx:108 instead of the three bare assignments.

Inside one batch() it should:
- pick the issue workflow the same way GitHub issues do: `const t = templates.value.find(x => x.id === "fix-issue")`, then `setPattern(t?.pattern ?? "solo")`. setPattern also clears selectedTeamTemplate.
- set an issue-shaped task, ideally the same trusted framing GitHub uses: issueRepairTask("the selected issue") from src/repair-strategy.ts, or keep today's "Address the selected issue…" text.
- clear template leftovers with setAcceptanceCriteria([]).
- set `source.value = null`, then `externalSource.value = src`. This must come last, because applyTemplate clears externalSource.

That lines GitLab, Bitbucket, Linear and Jira issues up with the GitHub issue path (fix-issue → Fix & review). If the team prefers a neutral default instead, use "solo" (the app defaul …

**Suggested regression test:** In test/e2e/integration-connections.e2e.ts, extend "GitHub reuses CLI auth and opens review and failing-check tasks…". After the final GitHub "Review pull request" step, which leaves Workflow=council, run connectionsPage() → card("GitLab") → "Choose issue or PR" → "Choose issue" → Source preview "Start task from issue". Then open Run options → Advanced and assert:
- `await page.getByLabel("Workflow", { exact: true }).inputValue()` is not "council" (equals "fix-review", or "solo" if that default  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4655t206" on port 4655, started with a fresh home. It used fake gh, with PR #8 (green) and issue #3 in fake-gh.json. NODE_OPTIONS loaded --import test/fake-integration-transport.mjs, and CODEFLOW_INTEGRATIONS_JSON held one admin GitLab source (source-fixture.invalid, random SOURCE_IMPORT_KEY). The project pointed at a throwaway scratch git repo created via the API. I used a fresh headless browser with no profile (script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4655t206/repro.mjs, log repro.log).

Steps, all through the UI:
1. Connected GitHub through the wizard (Connect → Continue → Test connection → Connect). Attached the GitLab admin source with "Use in this project".
2. CONTROL: GitLab → Choose issue or PR → Choose issue → Start task from issue. The composer had task "Address the selected issue…", workflow=solo, no "Template:" label, and localStorage had no pattern. So a fresh draft starts neutral.
3. GitHub → Choose issue or PR → Review pull request → Load PR preview (#8) → Review pull request. Composer: "Template: Review council", Workflow select=council, localStorage pattern=council.
4. Back to Connections → GitLab → Choose issue or PR → Choose issue → Start task from issue. Composer: task "Address the selected issue. Add appropriate checks and explain the result.", the External context banner for gitlab issue 7, "Template: Review council", Workflow select=council. The summary under the composer reads "Claude Code and Codex review on their own, read-only → … nothing is changed or posted". Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4655t206/003-step2-gitlab-issue-after-review.png
5. Comparison: GitHub → Choose issue → Start task from issue goes through applyTemplate(fix-issue). The composer resets to "Template: Fix & review" and workflow=fix-review. So only the GitLab/Linear/Jira path keeps the stale workflow.

I reproduced it twice, each time in a fresh browser (repro.mjs, then send.mjs). In the second pass I pressed Start run without changing anything. Run 2610252222-5481b9e6 started with pattern=council, trust=safe and externalSource gitlab #7 (untrusted). It finished as "Review council: Changes requested — 2 reviewers (claude, codex)" with 0 artifacts. The issue was reviewed read-only instead of addressed; with real agents that is three agent invoc …

</details>

### t20-7 · minor · Failed 'Test connection' feedback appears off-screen at the top of the page; 'Retry' does not retry the test

Source: tester unit github-codehosts-imports-2; observed with fake-agents; features GH-18, GH-22.

**Repro**

> 1. Configure an admin integration whose credential env is unset (e.g. Linear). 2. Settings → Integrations (or project Connections), scroll to the Linear card, open '…' → Test connection.

**Expected:** The error appears next to the card or as a toast, uses the connection name, and Retry repeats the test.

**Actual:** The alert 'Credentials are unavailable for integration admin-missing Retry' is rendered above the grid (box.y -440 and -629), so nothing visible happens. It uses the internal id. Retry only reloads the list and clears the error.

**Root cause (verifier):** All of these are in ui/integration-connections-view.tsx unless noted.
- Line 29-37, act(): the 'test' action shares one catch block with disconnect, attach and detach. On failure it calls setError(message) (line 36), which is screen-level state. On success it calls showToast (line 32), a fixed element at the bottom of the viewport (ui/styles.css:1003).
- Line 48: the error renders once, above the .integration-grid. Nothing scrolls it into view, focuses it, or shows it on the card that failed. The card's own feedback slot (line 67) shows only 'Working…' while busy.
- Line 48, Retry: the button calls reload(), which re-fetches the list, then setError(''). It never repeats the failed action, so it clears the error without retrying.
- src/integrations.ts:304 and :310 (also :242): the message uses the internal id: `Credentials are unavailable for integration ${c.id}`. testExisting (src/integration-connections.ts:199-205) passes it through unchanged.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/integration-connections-view.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/integrations.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/integration-connections.e2e.ts`

**Suggested fix:** 1. Show action errors on the card. Keep failures from act() per connection, e.g. a state like {id, action, message}. Render the failure inside that .integration-connection next to the existing 'Working…' slot (line 67) as <p class="msg err" role="alert">. Prefix it with the connection name, e.g. 'Test failed for Admin Jira (no key): …'. Also consider showToast for a failed test, to match the success path.
2. Make Retry repeat the failed action. The per-card Retry should call act(connection, failed.action). Keep the screen-level alert at line 48 only for failures loading the list (the useEffect at line 27), where Retry = reload is correct. Clear the error only once the retried action succeeds.
3. Use the connection name in the server message. In src/integrations.ts:242, 304 and 310, use c.name: `Credentials are unavailable for ${c.name}`. Or have testExisting catch this case and return 'Credentials are unavailable for <name>. Ask the administrator to set them, or reconnect.'
4. Optional …

**Suggested regression test:** Extend test/e2e/integration-connections.e2e.ts:
- Add an admin integration with an unset credentialEnv to CODEFLOW_INTEGRATIONS_JSON (line 29), e.g. a Jira entry, which sits lower in the grid.
- Set a short viewport (1366x768), scroll that card into view, open its Manage menu and click Test connection.
- Assert that an alert inside that card's .integration-connection (not section > p.msg.err) contains the connection name, is in the viewport, and does not contain the raw id.
- Count POST requests …

<details><summary>Verifier's independent reproduction</summary>

Fresh home: the old v4657 home was moved to homes/v4657-prev-*. Fake-mode server: qa-server.sh start v4657 4657 fake. First run: CODEFLOW_INTEGRATIONS_JSON had one admin Linear integration (id admin-missing, credentialEnv unset). Restart: added an admin Jira integration (id admin-jira, OPS, credential and username envs unset). Script work/v4657/t20-7.mjs used a fresh browser profile. For each page (Settings > Integrations, and Project MQTT-MCP > Connections) it measured the card's position before scrolling, scrolled the card into view only if it was below the fold, opened 'Manage ... connection' > Test connection, then recorded the alert's bounding box, any toast, and the network requests. Then it clicked Retry and recorded requests again.

Results:
(a) Off-screen, viewport-dependent.
- Settings 1440x900, Jira: the card starts at y=1113, so the user must scroll. After the test the alert is at y=-260..-232, not visible, and no toast appears (shot shots/v4657/001-settings-after-test-Jira-1440x900.png shows no change).
- Settings 1366x768, Linear: the alert is at y=-2..26, hidden behind the 48px sticky top bar (shot 001-settings-after-test-Linear-1366x768.png).
- With only one connection at 1440x900, Linear's alert stayed visible (y=422 settings, y=365 project). So the off-screen part depends on viewport height and card position; the reporter's -440/-629 came from extra GitLab/Bitbucket/Jira connections making the cards taller. Not a script artifact: a real user has to scroll to reach these cards.
(b) Wording: the alert reads 'Credentials are unavailable for integration admin-jira' (internal id, not the 'Admin Jira (no key)' name). App-managed ids are conn-<24 hex>.
(c) Retry, on both pages: the test sent 'POST /api/integration-connections/<id>/test'. Retry sent only 'GET /api/integration-connections' (or the project endpoint), never the test again. The alert vanished and no toast appeared, so the failure looks resolved.

The success path uses showToast, a fixed toast at the bottom of the viewport, so failures get weaker feedback than successes. Nothing is by design: docs/project-integrations.md only says to Test connection and says nothing about where errors appear. Console errors were only the expected 400s from the test POSTs.

Cleanup: server stopped, ports 4657/4659 free, no runs created.

</details>

### t20-8 · minor · Issue list stops at 1000 items with no truncation notice

Source: tester unit github-codehosts-imports-2; observed with fake-agents; features GH-24.

**Repro**

> 1. GitLab connection with more than 1000 open issues (fixture: 1040). 2. Connections → Choose issue or PR → click 'Load more' 19 times.

**Expected:** The UI says the list is truncated (the server returns truncated:true) and points to the provider for the rest.

**Actual:** After 1000 items the Load more button simply disappears; no notice.

**Root cause (verifier):** ui/integration-connections-view.tsx:91 (ProjectConnectionActions.load) keeps only result.items and result.nextCursor from the ExternalSourcePage and drops result.truncated. The type is declared at src/integrations.ts:51 as { items; nextCursor?; truncated: boolean }. ui/integration-connections-view.tsx:118 shows 'Load more' only while cursor is set (and disables it at 1000 items), and there is no else-branch that renders a notice. The server does report truncation. In the GitLab adapter (src/integrations.ts:98), page 20 returns nextCursor undefined and truncated: more && page >= 20. In Bitbucket (src/integrations.ts:116) the logic is the same, and an extension adapter can set it too (src/integrations.ts:274). So when the 20th page arrives, the cursor becomes undefined, the button disappears, and the UI cannot tell a capped list from a complete one. ui/integrations.tsx:13/31/59 handles the same page type correctly; the newer connections view was written without that state. A related gap I found in the code but did not reproduce: for GitHub connections, src/integration-connections-api.ts:39-40 calls listIssues/listPullRequests, which run `gh ... --limit 50` (src/github.ts:155-157, 234 …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/integration-connections-view.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/integration-connections-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/github.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/external-sources.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/integration-connections.e2e.ts`

**Suggested fix:** In ProjectConnectionActions (ui/integration-connections-view.tsx), add `const [truncated, setTruncated] = useState(false)`. Reset it to false in the [kind] effect alongside setItems([]) and setCursor(undefined). In load(), call setTruncated(result.truncated) when a page arrives (on a refresh with no cursor, replace the value rather than OR-ing it). Below the list, render the same notice the older view uses: `{truncated || (cursor && items.length >= 1000) ? <p class="help" role="status">The listing reached its limit of 1,000 {kind === "issue" ? "issues" : "pull requests"}. Narrow the project on {SERVICE_NAMES[connection.provider]} or open it there to see the rest.</p> : null}`. Optionally link the provider's project issues URL if one can be derived safely. Change the Load more condition to `cursor && items.length < 1000`, so the button is hidden at the cap rather than shown disabled with no reason, matching ui/integrations.tsx:58. For GitHub, in src/integration-connections-api.ts:39-40, …

**Suggested regression test:** Extend test/e2e/integration-connections.e2e.ts. Teach test/fake-integration-transport.mjs, or a test-local fetch preload, to answer the list endpoint with a 1040-issue GitLab project: per_page pages plus an x-next-page header. Then: Connections, then the GitLab card, 'Choose issue or PR', and click 'Load more' until it is gone. Assert: 1000 `.connection-item` elements; `getByRole("button", { name: "Load more" })` has count 0; and the section `getByRole("region", { name: "Connected project action …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4659t208, on port 4659 with a new home at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4659t208. The v4659 home already had another verifier's state, so I gave mine a new name. I wrote my own fetch fixture, /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4659t208/gitlab-fixture.mjs, preloaded through NODE_OPTIONS. It answers GitLab issue requests on gitlab-v4659.invalid with 1040 open issues, honours per_page, and sets x-next-page. The connection was administrator-managed through CODEFLOW_INTEGRATIONS_JSON (id gl1040, provider gitlab, project org/repo, random token). The browser script used a fresh profile, not the reporter's: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4659t208/repro.mjs, log in repro.log in the same folder. Steps: MQTT-MCP project, then #/project/p-ef01794b/connections, then the GitLab card, 'Use in this project' (this binding is saved only in the QA home), then 'Choose issue or PR'. The first page showed 50 items. I clicked 'Load more' 19 times. Result: 1000 items shown, the last one '1000 · Fixture issue 1000', and the Load more button gone (count 0). The page-20 response captured in the browser was {n:50, nextCursor: undefined, truncated: true}, and a direct API call to cursor=20 returned the same. The text below the last item is only 'Body 1000 / Choose issue'. Inside the section there is no role=status, alert or help text about a limit. The screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4659t208/001-gitlab-1000-bottom.png shows the list ending after item 1000, followed directly by 'Advanced · server configuration', the same as a list that is complete. No console or 5xx errors. I tried to refute it as by design. docs/external-sources.md:56 says 'GitLab/Bitbucket numeric pagination stops at page 20 and reports truncation; the UI also limits displayed items to 1,000'. So the 1,000 cap is intended, but hiding it is not: the older External sources screen (ui/integrations.tsx:59) shows 'The listing reached its limit. Narrow the configured project or open the service to inspect additional items.' for exactly this case, and every other bounded list in the app shows its truncation. This  …

</details>

### t20-9 · minor · Invalid admin CODEFLOW_INTEGRATIONS_JSON hides all app-managed connections behind a misleading 'storage is unavailable' message

Source: tester unit github-codehosts-imports-2; observed with api; features GH-26, GH-18.

**Repro**

> 1. Start a server with CODEFLOW_INTEGRATIONS_JSON='[{bad'. 2. Open Settings → Integrations.

**Expected:** App-managed connections still load. The UI reports that the administrator integration configuration is invalid.

**Actual:** The UI shows 'Integration connection storage is unavailable. Check the server log before reconnecting'; app-managed connections (GitHub, Slack…) are unavailable. The log says 'External sources disabled: invalid integration configuration…'.

**Root cause (verifier):** src/server.ts:247 runs IntegrationConnections.load() only when integrationsReady && notificationsReady:
`if (integrationsReady && notificationsReady) await integrationConnections.load().catch(...)`
integrationsReady is false whenever the administrator config fails to parse or validate (src/server.ts:243 → src/integrations.ts:186-189 throws "Integration configuration is not valid JSON"). notificationsReady behaves the same way for CODEFLOW_NOTIFICATIONS_JSON (src/server.ts:245).
When load() is skipped, IntegrationConnections.ready stays false. Then list(), bindings(), testDraft() and change() all call assertReady() (src/integration-connections.ts:94), which throws the generic "Integration connection storage is unavailable. Check the server log before reconnecting". The API returns that as a 400, and ui/integration-connections-view.tsx:27/48 shows it as the page alert over empty cards, which all read "Not connected".
The gate is not needed for sources. After a failed Integrations.load(), administratorConfigs is still [], so Integrations.applyManaged() (src/integrations.ts:213-223) loads the app-managed configs without trouble. GitHub records skip both subsystems entirely (integration …

**Files:** `src/server.ts`, `src/integration-connections.ts`, `src/integrations.ts`, `src/integration-connections-api.ts`, `ui/integration-connections-view.tsx`, `test/integration-connections.test.ts`, `test/e2e/integration-connections.e2e.ts`

**Suggested fix:** 1) Change src/server.ts:247 to always call integrationConnections.load(). Pass which subsystems are available, e.g. `new IntegrationConnections({ integrations, notifications, sourcesAvailable: integrationsReady, notificationsAvailable: notificationsReady })`.
2) In IntegrationConnections.apply(), skip integrations.applyManaged when sources are unavailable and notifications.applyManaged when notifications are unavailable, instead of letting one failure fail load(). Keep the encrypted store and the bindings usable either way. This keeps the notification fail-closed behaviour (damaged delivery state is never rewritten) without hiding GitHub, GitLab, Linear or Jira connections.
3) Keep the load error in Integrations (e.g. a `loadError` field set in load()) and in Notifications. Return it from GET /api/integration-connections as something like `warnings: [{ scope: "administrator-integrations", message: "CODEFLOW_INTEGRATIONS_JSON/FILE is invalid: <reason>. Administrator-managed sources are  …

**Suggested regression test:** Unit test in test/integration-connections.test.ts: build `new Integrations({ environment: { CODEFLOW_INTEGRATIONS_JSON: "[{bad" } })` and assert its load() rejects. Then create IntegrationConnections with a temporary directory and a loaded Notifications. Pre-seed it with a Slack connection and a GitHub connection (using the githubTest stub), and construct it the way server.ts would with sourcesAvailable:false. Assert that:
- load() resolves;
- list() returns both app-managed connections with adm …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server named v4661t9 (new home, port 4661).
1) With no CODEFLOW_INTEGRATIONS_* env set, I created an app-managed Slack connection through the UI: Settings → Integrations → Slack → Connect → test webhook URL → Continue → Test connection → Connect. GET /api/integration-connections returned 200 with one app-managed connection, connection-18a615d75c720fa3458d68f3 "QA Slack".
2) I stopped the server and started it again on the same home with CODEFLOW_INTEGRATIONS_JSON='[{bad' exported. The server log contains only "External sources disabled: invalid integration configuration: Integration configuration is not valid JSON". It has no line about connection storage, so the UI's "check the server log" hint points at nothing relevant.
3) Settings → Integrations (screenshot shots/v4661t9/001-bad-settings-integrations.png):
   - A red alert says "Integration connection storage is unavailable. Check the server log before reconnecting".
   - Every card, including Slack, shows "Not connected", although the encrypted connection is still on disk.
   - Connect → Test connection in the Slack dialog fails with the same storage message (002-bad-connect-attempt.png).
   - GET /api/integration-connections and GET /api/integration-connections/projects/<OPCUA-MCP> both return 400 with that message. /api/integrations and /api/notifications return [].
4) I restarted on the same home without the env var. The QA Slack connection came back unchanged, so the storage was never damaged.
5) Same symptom with CODEFLOW_NOTIFICATIONS_JSON='[{bad' instead: 400 storage-unavailable, and the log says only "Notifications disabled: ... not valid JSON".
6) Probe in a snapshot copy (builds/v4661t9, no source edits): after Integrations.load() failed on '[{bad', IntegrationConnections.list() threw the storage error. Calling IntegrationConnections.load() anyway then worked: testDraft and connect for Slack succeeded and list() returned the app-managed connection. So the startup gate is the only thing blocking it.

Not by design: docs/project-integrations.md says app-managed connections need no restart and administrator configs "keep working"; no doc or comment says an invalid admin config should disable app-managed connections. Fail-closed is documented only for a damaged or missing key or data in integration-secrets.

Severity stays minor: it only happens when an admin config is broken, the log does name the real cause, nothing is lost, and fixing the env and restarting recover …

</details>

### t20-11 · minor · code-hosts.e2e.ts fails consistently: 'Review pull request' click right after the actions section mounts is lost

Source: tester unit github-codehosts-imports-2; observed with fake-agents; features GH-33, GH-24.

**Repro**

> 1. scratchpad qa-server.sh snapshot t20. 2. In builds/t20 run `npx tsx --test test/e2e/code-hosts.e2e.ts` (3 times).

**Expected:** 2/2 pass.

**Actual:** 0/2 every time. Test 1 times out waiting for 'Load PR preview'; the page still shows 'No open issues found' with kind=issue (shots/t20/e2e-debug.png). Test 2 then fails on run.reviewBase undefined. With a 1.5 s wait before the click, both tests pass. Not reproducible manually: 5 fast-click attempts on the QA server worked.

**Root cause (verifier):** The cause is in ui/integration-connections-view.tsx, in `ProjectConnectionActions`:
- Line 87: `useState(false)` makes `busy` start as false.
- Line 92: the initial load is started only from a `useEffect` (`useEffect(() => { …; void load(); }, [kind])`). Preact runs that effect after the next paint, about 40 ms after mount.
- Line 91: `load()` immediately calls `setBusy(true)`.
- Line 112: the kind buttons are rendered with `disabled={busy}`.

So the "Start task from issue" and "Review pull request" buttons are enabled on the first frame and become disabled about 40 ms later, for the length of the issue load. A disabled `<button>` gets no click event, so a click that lands in that moment is silently dropped and `kind` stays "issue".

The same first frame also briefly shows "No open issues found. Refresh" before "Loading…", because line 116 checks `!busy && !items.length`.

test/e2e/code-hosts.e2e.ts lines 34-35 click "Choose issue or PR" and then "Review pull request" immediately. Playwright passes its enabled and stable checks just before the effect disables the button, then sends the mouse events to the disabled button. The click at line 36 then waits for "Load PR preview", which …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/integration-connections-view.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/code-hosts.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/integration-connections.e2e.ts`

**Suggested fix:** Fix the component; both options below were verified.

Preferred, fix B: switching kind should never be blocked by a load.
- Remove `disabled={busy}` from the two kind buttons at line 112. Optionally add `aria-pressed={kind === "issue"}` and `aria-pressed={kind === "pr"}`.
- Make `load()` ignore stale responses with a request counter:
  `const request = useRef(0); const load = async (next) => { const id = ++request.current; setBusy(true); …; const result = await api(...); if (id !== request.current) return; setItems/setCursor …; catch: if (id === request.current) setError; finally: if (id === request.current) setBusy(false) }`
- Apply the same guard to `pick()`, so an import that finishes after a kind switch cannot set a preview for the old kind.
- This also lets users switch to PRs while a slow GitHub or GitLab issue list is still loading.

Minimal alternative, fix A: initialize `busy` to `true` at line 87. The buttons are then disabled from the first render, Playwright waits for them  …

**Suggested regression test:** In test/e2e/code-hosts.e2e.ts, or as a new case in test/e2e/integration-connections.e2e.ts:
1. Make the fixture's items response slow, for example with `page.route('**/items?*kind=issue*', async r => { await new Promise(a => setTimeout(a, 500)); await r.continue(); })`.
2. Click "Choose issue or PR", then click "Review pull request" immediately with no wait.
3. Assert that a `kind=pr` items request is made, using `page.waitForRequest(/kind=pr/)`, that the GitLab/Bitbucket PR help text is visible …

<details><summary>Verifier's independent reproduction</summary>

1. Ran `qa-server.sh snapshot v4665` for a fresh copy of the dogfood source at f14f404 (clean tree). The test starts its own fixture server in a temp dir, so no QA server was needed.
2. In /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4665 I ran `npx tsx --test test/e2e/code-hosts.e2e.ts` twice on unmodified code. Both runs gave 0/2, with the same errors as the report:
   - test 1: `locator.click: Timeout 15000ms exceeded … waiting for getByRole('button', { name: 'Load PR preview' })` at line 36
   - test 2: `Cannot read properties of undefined (reading 'reviewBase')`. This is only a follow-on failure: line 47 looks up the GitLab run that test 1 never created.
   Logs: work/v4665/run1.log and run2.log.
3. I wrote an instrumented copy of steps 33-36 in my snapshot. It logs pointer, mouse and click events, `disabled` changes on the "Review pull request" button, `/items` fetches and scroll. Over 3 runs (work/v4665/trace3-{1,2,3}.log) the timing was the same each time:
   - t=273: click on "Choose issue or PR", and the section mounts.
   - t≈311: the mount effect fetches `kind=issue`, and "Review pull request" becomes `disabled=true`.
   - t≈313: Playwright's pointerdown and pointerup land on the disabled button. Chrome sends no mousedown, mouseup or click.
   - t≈353: the button is enabled again.
   No `kind=pr` request is ever made, so the panel stays on "No open issues found". The button's position never moved (top=753, document scrollTop 0), so `scrollIntoView` plays no part. Playwright's log shows it judged the button "visible, enabled and stable" at about the moment it became disabled. Its enabled check is not repeated just before the mouse events are sent.
4. Small delays hide the bug. In one trace run, two extra `evaluate` calls before the click were enough: the button was already disabled when Playwright checked, so Playwright waited for it to be enabled again and the click worked (trace2.log). This matches the reporter's result that a 1.5 s wait passes.
5. I tested fixes on my snapshot copy only, with the unmodified test:
   - Fix A, initial `busy` set to true: 2/2 passes in 3 of 3 runs (fixA-*.log).
   - Fix B, kind buttons no longer disabled plus a stale-load guard: 2/2 passes in 3 of 3 runs (fixB-*.log). `test/e2e/integration-connections.e2e.ts` also passed 5/5 with fix B (ic-fixB.log).
   I then restored the snapshot to match the source.

Attempts to refute it:
- It is …

</details>

### t20-12 · minor · 'Review result and create PR' lands on the run page without surfacing the PR action

Source: tester unit github-codehosts-imports-2; observed with real-agents; features GH-25.

**Repro**

> 1. Connections → GitHub → Choose issue or PR → Create pull request from completed work → choose a result → 'Review result and create PR'.

**Expected:** The run opens with the Open PR step visible or focused.

**Actual:** The run page shows 'Ready to review' with Review changes / Preview. 'Open PR…' is only reachable through More options → Details and publishing → artifact actions.

**Root cause (verifier):** ui/integration-connections-view.tsx:136. The GitHub button runs `onClick={() => { if (choice) route.value = { view: "run", id: choice.run.id }; }}`. This drops `choice.artifact.branch` and passes no intent to open publishing. It also writes `route.value` directly instead of calling `navigate()` (ui/state.ts:572).

The Route union in ui/navigation.ts:18-19 (`{ view: "run"; id }` and `{ view: "review"; id; branch }`) has no field to carry that intent.

On the run page:
- The result area, ResultStudio (ui/experience.tsx:92-94), offers only Review changes and Preview.
- The "Details and publishing" disclosure (ui/run.tsx:390) renders closed.
- Inside it, ArtifactCard (ui/run.tsx:1012-1013) starts with `panel = null`, and its `<details class="artifact-actions">` (ui/run.tsx:1033) is closed.
- So "Open PR…" (ui/run.tsx:1066-1070) and the PrPanel (ui/run.tsx:1089) only appear after two manual disclosures and a click.

The review page has the same behaviour: `details.review-delivery` (ui/review.tsx:149) is closed. For GitLab and Bitbucket the same component renders the publish flow inline as a CodeHostsPanel, so only GitHub hands off to a page without the action.

**Files:** `ui/integration-connections-view.tsx`, `ui/navigation.ts`, `ui/state.ts`, `ui/review.tsx`, `ui/run.tsx`, `test/e2e/integration-connections.e2e.ts`, `test/collab-ui.test.ts`

**Suggested fix:** 1. Keep the chosen result. In CompletedPullRequest, call `navigate({ view: "review", id: choice.run.id, branch: choice.artifact.branch })` instead of setting `route.value = { view: "run", ... }`. This keeps the selected branch and goes through the side-panel handoff.

2. Carry a one-time publish intent, either way:
   - an optional `publish?: "pr"` on the review Route, serialized as `#/review/<id>/<branch>?publish=pr` and parsed in parseRouteHash/hashFor, or
   - a one-shot `publishIntent` signal in ui/state.ts, set to `{ runId, branch, panel: "pr" }` just before navigating.

3. Consume the intent:
   - In ui/review.tsx, render `details.review-delivery` open when the intent matches.
   - Give ArtifactCard an `initialPanel` prop (or read the intent) so `.artifact-actions` starts open and `panel` starts as "pr" for that branch.
   - Scroll the PrPanel into view and focus it (heading or "Push & open PR"), then clear the intent so a reload or back-navigation does not reopen it.

Pushing st …

**Suggested regression test:** In test/e2e/integration-connections.e2e.ts, extend the GitHub test (or add one):
1. Create a passing non-chat run through the API, for example pattern "fix-review" with check "true" and prove false. The solo runBody is not offered in the completed-work list.
2. Go Connections → GitHub → Choose issue or PR → Create pull request from completed work, select `<runId>:<branch>`, and click "Review result and create PR".
3. Assert that the location hash is `#/review/<runId>/<branch>` (or `?publish=pr`) …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this on a fresh fake-mode QA server, v4667t2012 on port 4667, with a brand-new home. The project was a tiny scratch repo with a local bare origin and .codeflow/config.json set to check "true" and prove false. As preconditions I created the project and a fix-review run through the API (codex builder, claude reviewer, check "true"). The run finished as done, Checks: Passed, Review: Approved, with artifact codeflow/2610252225-71970a05/build.

In the UI I connected GitHub with the fake gh: Connect, Continue, Test connection, Connect. Then I followed the reported path: Connections, GitHub, Choose issue or PR, Create pull request from completed work. I picked "Update README wording for QA v4667 · Result" and clicked "Review result and create PR". Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4667t2012/repro.mjs. Log: repro-pipe.log in the same folder.

What I saw:
- The URL changed to #/run/2610252225-71970a05 and focus was on BODY.
- The viewport showed the "Ready to review" card with only "Review changes" and "Preview", then "More options" and a collapsed "Details and publishing".
- An "Open PR…" button was not in the DOM at all (0 found, 0 visible), and the visible page text did not mention a pull request or PR anywhere.
- Opening "Details and publishing" still gave 0 "Open PR…" buttons. Only after also opening the Result card's "Actions" disclosure did one appear (1 visible).
- The other route is Review changes (#/review/<id>/<branch>), which also shows 0 at first; "Publish changes" followed by "Actions" then shows 1.

Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4667t2012/002-landed-71970a05.png (landing, no PR affordance) and 003-pathA-71970a05.png (Open PR… after two disclosures). There were no console or 5xx errors.

One correction to the report: "Open PR…" is not under "More options". It sits under "Details and publishing", then the Result card's "Actions", or under Review changes, then Publish changes, then Actions. This does not change the verdict.

I also ran a race run whose candidate-b was the only eligible result. Its branch selection survived only because candidate-b was already the default choices[0] on the run page. The chosen branch is never actually passed along (see root cause), so I did not show a wrong-branch case.

Why this is not by design: docs/proje …

</details>

### t20-15 · cosmetic · Integrations wording and docs inconsistencies

Source: tester unit github-codehosts-imports-2; observed with code-reading; features GH-18, GH-20, GH-32.

**Repro**

> 1. Bind Linear or Jira to a project: the card button reads 'Choose issue or PR' although they are issue-only. 2. Jira wizard with no site URL → error 'Enter a valid HTTPS API address' (field is 'Jira site URL'). 3. Settings → Integrations at 390 px: 'Integrations' heading appears twice. 4. docs/external-sources.md:52 describes an 'external-sources screen' with a 'Use as task context' button; that UI (ui/integrations.tsx:7 IntegrationsView) is never imported, so /api/integrations is API-only.

**Expected:** Labels match capabilities, errors name the visible field, one heading, docs match the UI.

**Actual:** As described.

**Root cause (verifier):** 1. ui/integration-connections-view.tsx:70 renders the same fixed label for every service that is not a notification: `{projectId && connected(c) && !notification(provider) ? <button ...>Choose issue or PR</button> : null}`. It ignores both `c.capabilities` (src/integration-connections.ts:31 returns ["Issues"] for linear and jira) and the `codeHost` gate in ProjectConnectionActions (line 89). That gate hides "Review pull request" for Linear and Jira, so the panel the button opens has issues only.

2. src/integration-connections.ts:176-177: for Jira the default baseUrl is "" and it goes into `https(record.baseUrl, "API address")`. Line 38 then throws `Enter a valid HTTPS ${label}`, which becomes "Enter a valid HTTPS API address". The wizard (ui/connection-setup.tsx:58) labels this field "Jira site URL" for Jira, and "API base URL (optional)" for the others under Advanced. So the Jira error names a field the user cannot see.

3. ui/settings.tsx:68 always renders `<div class="settings-section-heading"><h2>{item.label}</h2>` with label "Integrations" (from ui/settings-sections.ts:9). The `IntegrationsScreen` it mounts at line 73 renders its own `<header class="connections-heading">…<h2> …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/integration-connections-view.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/integration-connections.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/external-sources.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/integrations.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/integration-connections.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/integration-connections.test.ts`

**Suggested fix:** 1. In integration-connections-view.tsx:70, choose the label from capabilities: `c.capabilities.includes("Pull requests") ? "Choose issue or PR" : "Choose issue"`. Equivalently, use "Choose issue" for linear and jira.

2. In src/integration-connections.ts:177, pass a label per provider: `https(record.baseUrl, input.provider === "jira" ? "Jira site URL" : "API base URL")`. Better still, check for a missing Jira URL before that call and throw "Enter your Jira site URL". This makes the error name the field the user sees.

3. Remove the duplicate heading. Either let IntegrationsScreen take an `embedded` or `hideHeading` prop when it is mounted from settings.tsx:73 (keep only the "Bring issues…" help text), or skip `.settings-section-heading` for section === "integrations" the way other self-titled sections are handled.

4. Rewrite docs/external-sources.md:52 to describe the current flow: project **Connections** → **Choose issue or PR** → **Choose issue** → **Start task from issue**. Keep th …

**Suggested regression test:** Changes to test/e2e/integration-connections.e2e.ts:
- Configure an administrator-managed Linear or Jira connection through the controlled transport and bind it to the project. Assert that `card("Jira").getByRole("button", { name: "Choose issue", exact: true })` is visible and `{ name: "Choose issue or PR" }` has count 0. Keep the existing assertions that GitHub and GitLab still show "Choose issue or PR".
- On #/settings/integrations, assert `page.getByRole("heading", { name: "Integrations", exac …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4673, on port 4673. The old v4673 home was moved aside to homes/v4673.prev-232542. Linear (team ENG) and Jira (project APP, base https://qa-example.atlassian.net/) were configured as administrator-managed connections through an exported CODEFLOW_INTEGRATIONS_JSON, with random test credential env vars. No request left 127.0.0.1; the script logged outgoing non-local requests and found none.

Script work/v4673/s1-labels.mjs:
- Opened #/project/p-ef01794b/connections (MQTT-MCP) and clicked "Use in this project" on the Linear and Jira cards.
- Both cards then show one primary button, "Choose issue or PR". Each card's own description reads "Issues to agent tasks", and the server returns capabilities ["Issues"] for both (shot shots/v4673/001-jira-linear-bound.png).
- Opened Jira "Connect another", entered a test username and token, clicked Continue, and entered project key APP. The only URL field visible is labeled "Jira site URL"; the Advanced section has no URL field for Jira. I left it blank and clicked Test connection. The dialog shows "Enter a valid HTTPS API address" (shot 002-jira-wizard-error.png).
- Afterwards I removed both bindings through the UI menu ("Remove from project"); bindings went back to [].

Script work/v4673/s2-heading.mjs:
- Opened #/settings/integrations at 390x844 and at 1440x900. There are two visible h2 headings reading "Integrations" at both widths (getByRole heading count = 2). One is in .settings-section-heading and the other in .connections-heading under the eyebrow "Your services" (shots 001-settings-integrations-390.png and -1440.png).
- So this is not specific to phone width; it happens at every width.

Docs:
- `grep -rl "Use as task context"` in the built bundle public/assets finds nothing.
- The same text is published in the in-app docs at public/docs/external-sources.html and in search.json.
- The only use of `IntegrationsView` is its own definition in ui/integrations.tsx:7. Commit a0b046a (2026-10-24) replaced `<IntegrationsView .../>` with `<IntegrationsScreen />` in ui/settings.tsx, edited 4 lines of docs/external-sources.md, and left line 52 unchanged.
- One part of the report needs correcting: listing and importing are still possible in the UI through the new Connections flow ("Choose issue or PR" → "Choose issue" → "Start task from issue"). Only the legacy /api/integrations endpoint and the old screen and button names are gone, so what is actually wrong is that the docs name a scr …

</details>

### S14-6 · cosmetic · IntegrationsView, the legacy external-source picker that uses /api/integrations, is not imported anywhere. It is dead code, and its API routes (GET /api/integrations, items, import) are now reachable only through direct API calls.

Source: code-level suspect at `ui/integrations.tsx:7` (confirmed hands-on).

**Repro**

> grep across ui/, src/ and test/: no importer of ./integrations.js or IntegrationsView (only ui/integrations.tsx itself). grep of the snapshot bundle: 'Use as task context' only in public/docs/external-sources.html and search.json, and the assets JS has 0 matches for 'sources-panel|External sources'. Browser script nav.mjs on s14 (#/settings/integrations): External sources section present? false; Integrations screen? true; /api/integrations requests: [] (screenshot shots/s14/003-settings-integrations.png).

**Expected:** No unreachable UI modules, and docs that describe the current screen (project Connections → 'Choose issue or PR' → 'Choose issue').

**Actual:** The only ui reference to IntegrationsView is its own definition. The built bundle (builds/s14/public/assets/*.js) contains no 'Use as task context', 'External sources' or 'sources-panel' strings; they appear only in public/docs. In the browser, #/settings/integrations renders section.integrations-screen, no section[aria-label='External sources'] exists, and no /api/integrations request is made.

**Root cause (verifier):** Settings → Integrations was rebuilt as IntegrationsScreen (ui/integration-connections.tsx → integration-connections-view.tsx). The new screen lists administrator-managed (env) integrations together with app-managed ones and imports through /api/integration-connections/projects/:pid/:cid/items|import. The old IntegrationsView in ui/integrations.tsx was never deleted, and no module imports it, so esbuild leaves it out of the bundle. The /api/integrations routes being API-only is by design: docs/external-sources.md documents them in its '## API' table. However, the same doc's sentence 'The external-sources screen lists a page of up to 50 items. Selecting **Use as task context**…' describes the removed screen and is stale.

**Suggested fix:** Delete ui/integrations.tsx. Update the docs/external-sources.md paragraph about 'external-sources screen … Use as task context' to describe the project Connections flow. Keep the documented /api/integrations routes.

**Suggested regression test:** Add an unused-module check to CI (e.g. knip or ts-prune, or an esbuild metafile test asserting every ui/*.tsx is reachable from the UI entry), plus a docs check that quoted UI labels exist in the bundle.
