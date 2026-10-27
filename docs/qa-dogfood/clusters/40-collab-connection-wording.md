# Cluster 40 · collab-connection-wording

**Team connection selection & stale 'Settings → Team' wording, stream limit, draft loss**

Status: **fixed and independently replayed** · 9 issues · branch `codex/qa-collab-connection-wording`

Planner notes: initializeTeamConnection in ui/lib.ts (:39-48) maps 2+ remote connections with no ?team to 'local' (t14-6/S07-1). Follow the server's no-guess rule and ask the user. ensureCollaborationSource always calls location.assign(), so Back needs two presses (t13-20); use replace. t14-10/S07-2: server and collab error strings still point to 'Settings → Team' (connections.ts:63, link-api.ts:92, runner.ts:244, link.ts), and a revoked runner shows only 'Offline' with a duplicated message. t13-5/S07-5: docs/team-collaboration.md and the errors use 'Settings → Connections → Share access → People', which has no route. t14-15: a Board tab beyond the 4-stream limit shows 'Reconnecting' forever; EventSource reports no status, so probe for the reason. t14-7: switching the connection reloads the page and discards an unsaved New task draft. Duplicate groups: [["t14-6","S07-1"],["t14-10","S07-2"],["t13-5","S07-5"]]

Likely files: `ui/lib.ts`, `ui/team-connections.tsx`, `ui/collab-board.tsx`, `ui/collab-state.ts`, `src/collab/connections.ts`, `src/collab/link-api.ts`, `src/collab/link.ts`, `src/collab/runner.ts`, `src/collab/hub-client.ts`, `docs/team-collaboration.md`

## Repair outcome (2026-10-26)

All nine original entries are resolved. Work was based on integration `90d5217` (including cluster 39 connection identity and handoff fixes). Only isolated temporary homes, throwaway Git repositories, fake-agent binaries, and dynamically allocated loopback listeners were used. Every app/test/build command had an outer scratch `CODEFLOW_HOME`; the live home, worktree build, and ports 4317/4318 were untouched.

| Entries | Root repair and observed outcome |
| --- | --- |
| t14-6, S07-1 | Ambiguous boot retains an unscoped URL and renders a connection chooser for Board and task links. Board, link, inbox, task polling, and team subscriptions wait for selection. Real two-hub browser checks observed no guessed team request; explicitly selected remote and local boards remain usable. |
| t13-20 | Forced local routing replaces an entry only when its hash is already the destination. Programmatic navigation still adds its destination. The original remote Board → local project People hash navigation returns to the remote board with one Back. |
| t14-10, S07-2 | Shared settings location constants replace stale backend instructions. Credentialed 401 responses normalize older duplicate hints once; wrong-password responses retain their own message. Link information explicitly reports revoked access and replaces a stale stream error with the credential reason. The computer card shows Access revoked and a functioning Disconnect to reconnect action. A real revocation, unmapped repository failure, unknown connection, and proxied 401 all show current instructions. |
| t13-5, S07-5 | Product documentation now names the actual Join a team, Manage existing connections and access → People/Connected computers, and Run on team server controls. The verifier's invented `#/settings/connections/people` address is not a product link and was not treated as a required route. Existing People and project navigation browser checks pass. |
| t14-15 | Board and Results use one bounded stream helper. Closed EventSource failures probe the HTTP refusal, show the 429 reason with Retry live updates, and retry after 30 seconds. A successful probe cancels its body immediately. Five real Board tabs and five Results tabs reproduced the cap; closing a permitted tab then using manual Board retry or automatic Results retry restored updates. |
| t14-7 | New task fields persist in tab session storage, scoped by connection, viewer, and board project. Switching between two teams, reload, settings navigation, and Back restore the correct form. Cancel/close and successful creation clear it. Invalid project restoration is rejected; unavailable storage shows a warning and adds a navigation guard. |

An adjacent confirmed defect was also repaired: consuming `?token=…` redirected to `/` and discarded a copied `?team=…` selection. The local authentication redirect now removes only `token`, retaining safe local query state and the browser fragment. Valid-token and already-authenticated stale-token controls preserve the team/task link; an unauthenticated invalid token remains rejected.

### Validation and independent comparison

- `npx tsc --noEmit` and `git diff --check` passed.
- 53 focused unit/backend tests passed across the new `test/qa-collab-connection-wording.test.ts`, existing connection/UI/link/runner tests, and cluster 39 regression tests. New tests exercise chooser request suppression, both history paths, scoped draft validation, 401 normalization, closed-stream retry/teardown, and immediate probe-body cancellation.
- All 7 new real-Chrome/server scenarios in `test/e2e/qa-collab-connection-wording.e2e.ts` passed. The draft scenario was rerun after the final project-scope guard and passed again.
- 4 original Chrome cases passed: the first-repository fixture and owning-server Board/People case in `project-navigation.e2e.ts`, plus the useful empty People board and repository-mapping/task-creation cases in `team.e2e.ts`. An initial isolated selection of the second navigation case lacked the first case's project fixture; rerunning the required pair passed.
- Independent pre-repair replay against detached `90d5217` failed all 7 new scenarios as expected. For this comparison only, normal page setup authenticated before navigating to the selected team so the separately tested token redirect defect could not mask the original chooser/history/draft failures. Failures confirmed discarded token query state, silent local selection, duplicate Back, lost draft, hidden Board/Results stream refusal, and stale repository guidance.
- The final browser captured `page-errors.json` as `[]`; host log inspection found no unexpected errors or 5xx failures. Intentional 401/404/429 cases were asserted by the scenarios.

Evidence: `/private/tmp/codeflow-qa-continue/collab40-browser/` contains the three isolated host logs and screenshots `ambiguous-board.png`, `single-back-remote-board.png`, `restored-alpha-draft.png`, `team-stream-limit.png`, `team-stream-recovered.png`, `results-stream-limit.png`, `results-stream-recovered.png`, and `revoked-access.png`. Test logs are `/private/tmp/codeflow-qa-continue/collab40-{final-unit,browser,baseline,original-navigation,original-team,draft-final}.log`. The baseline checkout was removed after comparison. No unresolved cluster 40 issue remains; listener-specific phone restrictions are tracked separately in cluster 42.

## Issues

### t14-6 · minor · Without ?team and with 2+ team connections, the UI silently opens 'This computer's own board'

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-30.

**Repro**

> 1. Link t14b to two hubs (http://127.0.0.1:4419 and http://127.0.0.1:4423).
> 2. Open http://127.0.0.1:4421/#/team (no ?team, e.g. an old bookmark or a link from a notification).

**Expected:** Per the docs, an unscoped selection with multiple remotes is ambiguous (the API returns 409 'Choose a team connection'). The UI should ask which team to open.

**Actual:** The URL is rewritten to ?team=local and the local board ('Local only task') is shown with 'This computer's own board' selected. No hint is shown that the user's team tasks are on another connection.

**Root cause (verifier):** ui/lib.ts:45, inside initializeTeamConnection (lines 39-48). It runs at boot (ui/main.tsx:71) for any tab whose URL has no ?team:
`selectedTeamConnection = remotes.length === 1 ? remotes[0]!.id : "local";`
then it writes ?team=<value> into the URL with history.replaceState. With 2+ linked remotes this silently pins the tab to "local", so:
- apiPath (lib.ts:34) adds teamConnection=local to every /api/team* call;
- watchTeam subscribes to team:local (ui/collab-state.ts:92);
- TeamConnectionPicker never reaches its intended empty state. Its code is `selected = selectedTeamConnection || (remotes.length === 1 ? … : remotes.length === 0 ? "local" : "")` (ui/team-connections.tsx:19), which would select "Choose a team…", but by then selectedTeamConnection is already "local".
This is the opposite of the API contract: src/collab/connections.ts:57-61 returns 409 for an unscoped request with more than one remote, and docs/team-collaboration.md:256 describes that. The 0-remote and 1-remote cases are correct. Only the 2+ case is wrong.

**Files:** `ui/lib.ts`, `ui/collab-board.tsx`, `ui/collab-task.tsx`, `ui/team-connections.tsx`, `test/team-connection-ui.test.ts`

**Suggested fix:** 1. In initializeTeamConnection (ui/lib.ts:45), stop defaulting to local when there are 2+ remotes. Use `remotes.length === 1 ? remotes[0].id : remotes.length === 0 ? "local" : ""`, and only rewrite ?team when the value is non-empty. The tab then stays unpinned, and the picker shows its existing "Choose a team…" state.
2. Give the empty selection a proper "choose a team" view on #/team routes. In collab-board.tsx:40 and collab-task.tsx:61, when selectedTeamConnection is "" and there are 2+ remotes, do not fetch the board/task (that only produces the 409). Instead render the TeamConnectionPicker with a prompt such as "You have N team connections; choose which board to open." Keep "This computer's own board" as one of the options.
3. For #/team/task/<id> without ?team, an optional improvement: check each linked connection for the task (GET /api/team/tasks/<id>?teamConnection=X). If exactly one has it, call selectTeamConnection(X) with the hash kept; otherwise show the chooser.
4. Check th …

**Suggested regression test:** Add test/team-connection-ui-multi.test.ts. It must be a separate file because selectedTeamConnection is evaluated once at module import. Copy the stubbing pattern from test/team-connection-ui.test.ts, with location set to http://localhost:4317/#/team/task/t-1111111111111111 and a fetch stub returning connections [{id:"local",linked:false},{id:"c-1111111111111111",linked:true},{id:"c-2222222222222222",linked:true}]. After `await initializeTeamConnection()`, assert:
- `address.searchParams.has("te …

<details><summary>Verifier's independent reproduction</summary>

I used fresh QA homes in fake mode: hub v4641mh on 127.0.0.1:4643 and client v4641m on 127.0.0.1:4641. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4641m/ (s1-setup.mjs, s2-repro.mjs, s1.log, s2.log).
1. Hub setup through the API: projects "V4641 Team Alpha" and "V4641 Team Beta" (each backed by a throwaway git repo in scratch), contributor accounts alice (Alpha) and bob (Beta), and one task per project ("Alpha team task" t-e6944c96dc146cc5, "Beta team task").
2. In the client UI (Settings > Connections > join), I connected http://127.0.0.1:4643 as alice, then used "Add team connection" to connect http://localhost:4643 as bob. That gives 2 linked remote connections, c-b34c507b7c8e4d62 and c-ec5735105f1437a3. Only two ports were assigned, so the same hub is reached through two loopback origins, each as a different account with a different project. The picker lists: Choose a team… / This computer's own board / mx · alice · connected / mx · bob · connected. I then created "Local only task" on the client's own board (?teamConnection=local).
3. Unscoped API check: GET /api/team/board returns 409 {"error":"Choose a team connection before opening its board"}, as documented.
4. I opened http://127.0.0.1:4641/#/team (no ?team) in a fresh browser profile and again in a persistent one. Both behaved the same. The URL was rewritten to /?team=local#/team. Every team request went out with teamConnection=local (/api/team/board, /api/team-link, /api/team/inbox). The select shows "This computer's own board", the board shows only "Local only task" (Alpha and Beta tasks are absent), and nothing hints that tasks live on other connections. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4641m/001-fresh-no-team-two-remotes.png
5. Variant: a copied or old task link without ?team, http://127.0.0.1:4641/#/team/task/t-e6944c96dc146cc5. It is rewritten to ?team=local and shows "Task not found", even though the task exists on a saved connection. Screenshot: .../shots/v4641m/002-fresh-alpha-task-no-team.png
6. Control: the same task opened with ?team=c-b34c507b7c8e4d62 loads correctly (s3.log).
Ruled out:
- Tester environment: reproduces with both a fresh and a persistent profile, and with a different hub layout from the reporter's.
- By design: docs/team-collaboration.md:256 says an omitted selecto …

</details>

### S07-1 · minor · initializeTeamConnection silently selects 'local' when there are 2+ remote team connections and no ?team param, although the server refuses to guess (409).

Source: code-level suspect at `ui/lib.ts:45` (confirmed hands-on).

**Repro**

> Fake QA client s07 (4529) linked twice to a fake hub s07h (4531): http://127.0.0.1:4531 and http://localhost:4531, test account alice (contributor). API: GET /api/team/board with no selector -> 409 'Choose a team connection before opening its board'. UI (Playwright): open http://127.0.0.1:4529/#/team -> URL is rewritten to /?team=local#/team. The picker shows 'This computer's own board' (its 'Choose a team…' option is disabled and never selected). The page shows 'Not connected to a team server — Connect this computer in Connections → Share access…' and the empty local board ('Your board is ready for its first task', New task button active). Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s07/001-team-no-param.png

**Expected:** With exactly one remote the board opens it (current behaviour). With two or more remotes the UI should not pick one for the user. It should ask the user to choose a team ('Choose a team…' picker state, no board yet) or restore the team last used in this browser if it is still saved. It should never say 'Not connected to a team server' while linked connections exist.

**Actual:** The tab is pinned to team=local without asking. The user sees their own, possibly empty, board with a false 'Not connected to a team server' banner, and New task creates tasks on the local board.

**Root cause (verifier):** ui/lib.ts:45 `selectedTeamConnection = remotes.length === 1 ? remotes[0]!.id : "local";` maps both 0 and 2+ remotes to 'local' and writes ?team=local into the URL. The server's no-guess rule (src/collab/connections.ts:60) and the picker's 'Choose a team…' placeholder (ui/team-connections.tsx:19,23) are never reached from boot.

**Suggested fix:** In initializeTeamConnection: 0 remotes -> 'local'; 1 remote -> that id; 2+ remotes -> a remembered last choice (localStorage, validated against the inventory), otherwise leave selectedTeamConnection '' and do not set ?team. The board then gets the server's 409; collab-board already renders TeamConnectionPicker in its !board branch, so turn that into a 'Choose a team' state instead of an error. Hide the 'Not connected to a team server' banner when the inventory has linked remotes.

**Suggested regression test:** E2E (or Playwright with a routed /api/team-link/connections returning two linked connections): open #/team without ?team and assert (1) the picker value is '' with 'Choose a team…' shown, (2) no /api/team/board?teamConnection=local request is made, (3) the 'Not connected to a team server' text is absent. Then choose a team and assert the URL gets ?team=<id>.

### t13-20 · cosmetic · After the forced team=local reload, Back needs two presses to return to the remote board

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-07.

**Repro**

> 1. On a linked computer open ?team=<remote>#/team.
> 2. Navigate (hash) to #/project/<localId>/people; the page reloads to ?team=local.
> 3. Press Back.

**Expected:** Back returns to the remote board.

**Actual:** The first Back lands on the same team=local People page (the intermediate entry re-redirects); the second Back reaches the remote board.

**Root cause (verifier):** ui/lib.ts:30-33, ensureCollaborationSource(), always calls location.assign(collaborationHref(hash, "local")). It is called from two places with different history states:

1. ui/main.tsx:99, readRoute on hashchange/popstate. Here the browser has already added (or moved to) an entry for the new hash under the old ?team=<remote> query: /?team=<remote>#/project/<id>/people. location.assign then adds a second entry, /?team=local#/project/<id>/people, so the first entry is left in between.

2. ui/main.tsx:88, the route effect. This runs before its pushState, so the current entry is still the previous page and assign is correct there.

On Back from the ?team=local entry, the browser reloads the in-between entry. ui/lib.ts:22 then forces selectedTeamConnection to "local" for any collaboration hash, and initializeTeamConnection (ui/lib.ts:39) uses replaceState to rewrite that entry to ?team=local. The user lands on the same local People page again and needs a second Back to reach the remote board. The reporter's suspected cause is correct, but changing assign to replace everywhere would break call site 2: it would drop the remote-board entry from history.

**Files:** `ui/lib.ts`, `test/e2e/project-navigation.e2e.ts`

**Suggested fix:** In ensureCollaborationSource, replace the current entry only when that entry already holds the collaboration address (the hashchange/popstate path), and keep assign for the programmatic route-effect path:

  const href = collaborationHref(hash, "local");
  if (location.hash === hash) location.replace(href); else location.assign(href);
  return false;

An equivalent alternative is an explicit flag, ensureCollaborationSource(hash, { replace: true }), passed only from readRoute in ui/main.tsx:99. I tested the location.hash === hash version in a snapshot build: hash-only navigation then needs one Back, and in-app links (collaborationHref, command palette) are unchanged because they navigate straight to ?team=local and never pass through this branch with a matching hash.

**Suggested regression test:** Add to the existing test "project Board and People use the owning server despite colliding linked project IDs" in test/e2e/project-navigation.e2e.ts (around line 218). It already routes /api/team/board for the fake connection c-1111111111111111. Steps:
1. page.goto(`${base}/?team=${remote}#/team/project/${projectA}`) and wait for the "Remote colliding task" button.
2. page.evaluate(id => { location.hash = `#/project/${id}/people` }, projectA), then waitForURL(/\?team=local#\/project\/.*\/people$ …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4643t1320, on 127.0.0.1:4643. I did not use the reporter's home or profile. Port 4645 belonged to another verifier's server (v4645d), so I left it alone. Instead the server linked to itself over loopback: as the server owner I created a test shared account "qabob" (random password) with contributor access to MQTT-MCP (p-ef01794b), then called POST /api/team-link/connect with url http://127.0.0.1:4643. That produced linked connection c-386d5e69d8b3153e. The bug is pure client-side history handling, so it doesn't matter which hub is on the other end.

Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4643t1320/back.mjs, run in a fresh headless Chrome. Output: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4643t1320/back.log

Scenario A (the reporter's steps): open /?team=c-386d…#/team (remote Board), then set location.hash = '#/project/p-ef01794b/people'. The page reloads to /?team=local#/project/p-ef01794b/people and history.length goes from 3 to 5.
- Back 1: still /?team=local#/project/p-ef01794b/people. The navigation type is back_forward (a full reload) and the page shows "MQTT-MCP > People / People and access". Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4643t1320/003-A2-back1.png
- Back 2: /?team=c-386…#/team, the remote Board.

Scenario B (typing the address, i.e. page.goto with only the hash changed): same result. Two Backs are needed.

Scenario C (control, an in-app link): on /?team=<remote>#/project/p-ef01794b, click the "N members" link. Its href is /?team=local#/project/p-ef01794b/people, built by collaborationHref(…,'local'). One Back returns to /?team=<remote>#/project/p-ef01794b. In-app links are not affected; only hash-only navigation is (typed or pasted addresses, bare #/project/… links, and Back/Forward onto such an entry).

Fix check: I took a snapshot copy (builds/v4643t1320), applied the fix below to ui/lib.ts there, rebuilt the UI, restarted the same server from the snapshot and reran the script (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4643t1320/back-fixed.log). In A and B, history.length goes 3 to 4 and the first Back lands on /?team=<remote>#/team with the remote Board vis …

</details>

### t14-10 · minor · Errors still point to the removed 'Settings → Team'; revoked runner shown as merely 'Offline' with a duplicated message

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-41, COL-36.

**Repro**

> 1. Hub owner revokes a teammate's runner (Manage → Connected computers → Revoke).
> 2. On the teammate's computer open Settings → Connections → Join a team (?team=<that connection>), or the task page.

**Expected:** The card says this computer's access was revoked and how to reconnect, using the current location (Settings → Connections → Share access).

**Actual:** Card: Connection 'Offline', Computer connection 'Not reported yet', error 'This runner credential is not valid; connect this computer again in Settings → Team; reconnect in Settings → Team'. 'Settings → Team' also appears in the 404 unknown-connection error and the mapping hint.

**Root cause (verifier):** There are three separate faults.
(1) Duplicate message. src/server.ts:403 (handleRunnerRequest) answers a revoked or invalid runner with 401 "This runner credential is not valid; connect this computer again in Settings → Team". On the teammate's side, src/collab/hub-client.ts:153 (readError) appends "; reconnect in Settings → Team" to every 401 on a credentialed call, without checking whether the hub's message already carries a hint. src/collab/link.ts:207 stores that combined message as connectionError, and link.ts:139 state() exposes it as link.error, so the card shows the hint twice.
(2) Stale location. "Settings → Team" no longer exists in the UI (docs/team-collaboration.md:19; ui/navigation.ts:35 only redirects old bookmarks). It is still hard-coded in:
- src/server.ts:403
- src/collab/hub-client.ts:153
- src/collab/link-api.ts:92 ("no longer lists this computer's runner")
- src/collab/connections.ts:63 (404 unknown connection)
- src/collab/runner.ts:244 (unmapped repository)
- src/collab/api.ts:74 (runner-only route refusal)
- src/collab/link.ts:122 and 163 (log messages)
- src/collab/link.ts:140 (409 "not connected; connect it in Settings → Team")
The last three were not in  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/hub-client.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/link.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/link-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/connections.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/runner.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-link.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-runner.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/team.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`

**Suggested fix:** 1. Add the location hint in one place only. Have the hub (src/server.ts:403, and the reauthorize message on line 409) answer with a location-free text such as "This runner credential is not valid (revoked, or the account was disabled)". The hub cannot know which UI version the client runs. Let src/collab/hub-client.ts readError add the local hint once, on the client: "; connect this computer again in Settings → Connections → Share access → Join a team". As a guard, readError should skip the suffix when the message already contains "connect this computer again".
2. Replace every remaining "Settings → Team" with the current path, ideally from one shared constant:
- connections.ts:63 → "choose a saved team under Settings → Connections → Share access → Join a team"
- runner.ts:244 → "Map repository X to a folder in Settings → Connections → Share access → Join a team (Repositories)…"
- api.ts:74
- link-api.ts:92
- link.ts:122, 140, 163
Then align the docs/team-collaboration.md:185 wording w …

**Suggested regression test:** 1. test/collab-link.test.ts, phase "revoking bob's runner…" (lines 188-198). Replace the /Settings → Team/ assertions with:
- `assert.doesNotMatch(state.error, /Settings → Team/)`
- `assert.equal((state.error.match(/connect this computer again|reconnect/g) ?? []).length, 1)` (hint appears exactly once)
- `assert.match(state.error, /Settings → Connections/)`
- `assert.equal(state.revoked, true)` (new field)
Apply the same not-stale assertions to `proxied` and `direct`.
2. test/collab-runner.test. …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode servers with new homes: hub v4649h on 127.0.0.1:4649 and teammate v4649m on 127.0.0.1:4651. Setup via the hub API: a project "V4649 Team" on the scratch git repo qa/clones/v4649-repo, a contributor account "bob" with a random password, and repository key "app". Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4649/ (setup.mjs, connect.mjs, revoke.mjs, connect.log, revoke.log).
1) Teammate UI, #/settings/connections/join: entered http://127.0.0.1:4649, bob, the password and machine "bob-v4649", then clicked "Connect this computer". The card showed Connection "Connected" and Computer connection "Online".
2) Before revoking, POST /api/team-link/tasks/<id>/start with the "app" key unmapped returned 400 "Map repository app to a folder in Settings → Team, or choose the folder when starting".
3) Hub UI, #/settings/connections/manage → Connected computers → bob-v4649 → Revoke → "Revoke access". The hub then listed it as "Revoked".
4) Teammate UI, ?team=c-5932a14773d6ec01#/settings/connections/join. The "This computer" card read: intro "Connected to your team server. Choose your repository folder below…", Connection "Offline", Computer connection "Not reported yet", and the alert "This runner credential is not valid; connect this computer again in Settings → Team; reconnect in Settings → Team". Screenshot: shots/v4649m/002-bob-join-after-revoke.png. GET /api/team-link returned the same duplicated error. GET /api/team/board returned 401 with the single (stale) message.
5) Teammate task page after the revoke: "This runner credential is not valid; connect this computer again in Settings → Team Retry Back to the board" (shots/v4649m/003).
6) ?team=c-00000000deadbeef: the card showed "The team link could not be read: This team connection is unavailable; choose a saved team in Settings → Team" (shots/v4649m/004). The API returned 404 with the same text.
Attempts to refute:
- Not by design. docs/team-collaboration.md:19 says Settings → Team was removed and only old bookmarks still redirect (ui/navigation.ts:35). docs/team-collaboration.md:185 gives the intended 401 text as "…connect this computer again in Settings → Connections → Share access → People", so the code disagrees with its own docs.
- Not caused by the environment. It reproduces from fresh homes and fresh browser profiles over loopback in fake mode, and it does not depend on agents.
- The tests pin  …

</details>

### S07-2 · minor · User-facing errors still name a 'Settings → Team' location that no longer exists (connections.ts:63, link-api.ts:92, runner.ts:244, link.ts:122, api.ts:74).

Source: code-level suspect at `src/collab/connections.ts:63` (confirmed hands-on).

**Repro**

> Same QA setup. (1) Disconnected one connection, then opened /?team=<removed id>#/team. The board alert reads 'This team connection is unavailable; choose a saved team in Settings → Team'. (2) The hub owner revoked the runner (DELETE /api/team/runners/<id> on 4531), then I opened /?team=<id>#/settings/connections/join. The page shows 'This runner credential is not valid; connect this computer again in Settings → Team; reconnect in Settings → Team' (the advice appears twice, from server.ts:403 on the hub plus hub-client.ts:153), and the board shows the first half. The Settings nav lists General, Agents & models, Run defaults, Notifications, Connections, Integrations, Projects, Extensions, Data & storage, Advanced. There is no Team entry. The legacy hash #/settings/team does redirect to #/settings/connections/manage, but the error text is plain prose, not a link. Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s07/001-stale-connection.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s07/001-revoked-join.png

**Expected:** Messages point to the current location, e.g. 'Settings → Connections → Share access → Join a team' for reconnecting or mapping repositories, or '… → Manage existing connections and access'. Each advice appears only once.

**Actual:** Messages say 'Settings → Team', a location that does not exist in the Settings nav. The revoked-credential message repeats the advice twice.

**Root cause (verifier):** The settings IA moved Team into Connections → Share access (docs/team-collaboration.md:19 notes that only old bookmarks still redirect), but the server-side strings were not updated: connections.ts:63, link-api.ts:92, runner.ts:244, api.ts:74, plus more than the claim listed: server.ts:403, hub-client.ts:153 (appends its own 'reconnect in Settings → Team' to a hub message that already has one), link.ts:140 and link.ts:163. link.ts:122 is a server log line only.

**Suggested fix:** Replace every 'Settings → Team' string with the current path, ideally one shared constant (e.g. TEAM_SETTINGS_PATH = 'Settings → Connections → Share access → Join a team'). In hub-client.ts:153, append reconnect advice only when the hub message does not already contain it.

**Suggested regression test:** A unit/lint test that fails if any file under src/ or ui/ contains the string 'Settings → Team', plus a collab-link test asserting the 401 reconnect message mentions 'Connections → Share access' exactly once.

### t13-5 · cosmetic · Docs and error text send users to 'Settings → Connections → Share access → People', which has no route (#/settings/connections/people opens 'Work on another computer')

Source: tester unit human-collaboration-1; observed with code-reading; features COL-02.

**Repro**

> 1. Open http://127.0.0.1:<port>/#/settings/connections/people (the place docs/team-collaboration.md lines 71, 80, 112 and the runner 401 message 'connect this computer again in Settings → Connections → Share access → People' point to).

**Expected:** A People section, or a redirect to Share access → Manage where the People/Team server/This computer cards are.

**Actual:** The SSH 'Work on another computer' purpose is selected; nothing about people is shown.

**Root cause (verifier):** This is wording drift after a navigation redesign.
How it happened:
- Commit e211862 put a "People" card directly under Share access, and the docs (5033590) were written as "Settings → Connections → Share access → People → …".
- Commit 3e1dfd7 (guided device connections) moved those cards behind the "manage" sub-view without updating the docs. That is ui/connections.tsx:17 (sharing = ["sharing","devices","join","host","manage"]) and ui/connections.tsx:46-50 (the People card and TeamSettings render only when purpose === "manage", reached via the "Manage existing connections and access" link at :45).
Stale doc references:
- docs/team-collaboration.md:67, 76, 80, 94, 108, 110 and 114 point to "Settings → Connections → Share access → People …".
- docs/architecture.md:13 does the same.
- Line 108's "→ This computer" also doesn't match: an unlinked computer sees the card titled "Connect to your team" (ui/collab-settings.tsx:82).
Stale error text still saying "Settings → Team" (from 56e39ce, when Settings had a Team section; now only the legacy hash #/settings/team survives, ui/navigation.ts:35):
- src/server.ts:403 (runner 401)
- src/collab/hub-client.ts:153 ("reconnect in Settings → Tea …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/architecture.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/hub-client.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/connections.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/connections.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/navigation.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-link.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-ui.test.ts`

**Suggested fix:** 1. Rewrite the doc paths to match what users see.
   - "Settings → Connections → Share access → Manage existing connections and access", then name the card: People, Team server, Repositories, Run teammates' tasks on this computer, Teammate terminals.
   - For the member side, use "Share access → Join a team" (or Manage → "Connect to your team" / "This computer").
   - Apply this in docs/team-collaboration.md (lines 67, 76, 80, 94, 108, 110, 114) and docs/architecture.md:13.
2. Replace "Settings → Team" in the server error strings.
   - Files: src/server.ts:403, src/collab/hub-client.ts:153, src/collab/connections.ts:63, src/collab/api.ts:74.
   - New wording, e.g. "connect this computer again in Settings → Connections → Share access → Join a team".
   - Better: keep the location in one shared constant so it can't drift again.
   - Also relabel ui/collab-settings.tsx:150 ("Settings → Remote access" becomes "Share access → Connect my devices").
3. Optional robustness: make ui/connections …

**Suggested regression test:** - test/collab-link.test.ts:194 currently asserts the stale text (/connect this computer again in Settings → Team/). Change it to assert the new path. Add a small test that every "Settings → …" location string in src/collab/*.ts and src/server.ts names only labels that exist: the SETTINGS_SECTIONS labels in ui/settings-sections.ts, the CONNECTION_PURPOSES labels in ui/connections.tsx and the journey titles.
- In test/collab-ui.test.ts, if the alias is added, assert parseRouteHash("#/settings/conn …

<details><summary>Verifier's independent reproduction</summary>

Started a fake-mode QA server: qa-server.sh start v4613 4613 fake. Ran the Playwright script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4613/t13-5.mjs (fresh browser, no profile). Its output is in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4613/t13-5.log and the screenshots are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4613/.
(1) #/settings/connections/people selects "Work on another computer" and shows the SSH cards. #/settings/connections/xyz does exactly the same, so this is the generic fallback for any unknown group, not something special about "people".
(2) Walking the UI path the docs give: Settings → Connections → "Share access" (#/settings/connections/sharing) shows only three journey cards (Connect my devices, Join a team, Host a team), a "One project, a clear place to work" card and a "Manage existing connections and access" button. There is no link, button, tab or heading called People (all counts 0).
(3) After clicking "Manage existing connections and access" (#/settings/connections/manage, which is also where the legacy #/settings/team leads), the page shows cards headed People, Host a team, Connect to your team, Repositories, Team server, Run teammates' tasks on this computer, Host queue, Teammate terminals and Connected computers. So everything the docs describe exists, one unmentioned click further in.
(4) curl to /api/team/board with a random tr- bearer returned 401 {"error":"This runner credential is not valid; connect this computer again in Settings → Team"}. The reporter misquoted this message: it does not mention "Share access → People". But "Settings → Team" is also stale, because the Settings sidebar has no Team section.
No console or 5xx errors. I created no runs. The server is stopped.
Corrections to the report:
- Nothing in the code, docs or git history (git log --all -S"connections/people" finds nothing) ever linked to or defined #/settings/connections/people. The "no route" URL is a tester construct; the docs describe a UI path, not a URL.
- The quoted 401 text is wrong (see 4).
What is real is stale navigation wording in the docs and in the server error messages. Nothing is functionally broken, and the target is one click away and found by the Settings search for "team" or "people".

</details>

### S07-5 · cosmetic · Docs describe 'Settings → Connections → Share access → People → Team server / This computer / Repositories / Runners / Run teammates' tasks / Teammate terminals', but there is no People sub-tab, and docs say 'Run on host computer' where the button reads 'Run on team server'.

Source: code-level suspect at `docs/team-collaboration.md:67` (confirmed hands-on).

**Repro**

> UI on QA s07: #/settings/connections/sharing offers only 'Connect my devices', 'Join a team', 'Host a team' and a 'Manage existing connections and access' link. There is no People link or tab (count 0). The Manage page (#/settings/connections/manage) has these sibling h3 cards: People, Host a team, Connect to your team (titled 'This computer' only once linked), Repositories, Team server, Run teammates' tasks on this computer, Host queue, Teammate terminals, Connected computers. 'People' is one card among them, not a parent level. Source: the button label is 'Run on team server' (ui/host-execution.tsx:77, asserted in test/e2e/team.e2e.ts:592); the docs say 'Run on host computer' (line 82). Affected doc lines: 67, 76, 80, 82, 94, 108, 110, 114. There is no 'Runners' card; it is 'Connected computers'.

**Expected:** Docs name the real path, e.g. 'Settings → Connections → Share access → Manage existing connections and access → Team server', or '… → Join a team' for This computer and Repositories, and the real button label 'Run on team server'.

**Actual:** The docs send users to a non-existent 'Share access → People' level and a 'Run on host computer' button that does not exist. 'This computer' is titled 'Connect to your team' at the moment the docs tell the user to use it.

**Root cause (verifier):** The docs were not updated after the Share access journeys and the Manage page replaced the old People/Team settings tab, and after the host-execution button was renamed.

**Suggested fix:** Rewrite the navigation paths on the listed lines to 'Share access → Manage existing connections and access → <card>' (or 'Join a team' for connecting and mapping repositories). Change 'Run on host computer' to 'Run on team server'. Mention that the This computer card is titled 'Connect to your team' until linked.

**Suggested regression test:** A docs-consistency script/test that extracts bolded UI labels from docs/team-collaboration.md and checks each one appears as a string in ui/*.tsx, flagging 'Run on host computer' and 'Share access → People'.

### t14-15 · minor · Shared Board tab beyond the 4-stream limit shows a perpetual 'Reconnecting' with no reason

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-43.

**Repro**

> 1. Sign in as a shared user (incognito) and open the shared dashboard Board tab in 5 tabs.

**Expected:** The 5th tab explains 'Too many team event streams; close another tab and retry' (the server's 429 body).

**Actual:** Tabs 1–4 show Connected. Tab 5 shows 'Reconnecting' indefinitely with no explanation, until another tab is closed. Its board still renders but receives no live updates.

**Root cause (verifier):** The problem is in two places.

1. ui/collab-state.ts:102-110 (`openTeamEvents`). The stream uses the browser's `EventSource`. When the server answers with a non-200 status, the browser only fires `onerror` with `readyState === CLOSED`; it exposes neither the status (429) nor the JSON body. Line 108 (`current.onerror = () => { onState?.("reconnecting"); ... retry = setTimeout(open, TEAM_EVENTS_RETRY_MS) }`) therefore reports exactly the same "reconnecting" state for three different cases: a network drop, a session that ended, and the 4-per-account cap. The `onState` type (`"connected" | "reconnecting"`) has no way to carry a reason.

2. ui/shared.tsx:68 (`streamState`) maps that state to the bare text "Reconnecting". Line 77 picks the pill style and line 78 renders `<span class="cs-label">{connection}</span>` with no reason or title.

The server builds the message at src/collab/api.ts:163: `throw new HttpError(429, "Too many team event streams; close another tab and retry")`, with STREAMS_PER_USER = 4 at line 159. That message never reaches the user.

The Results tab has the same blind spot and also never retries. ui/shared.tsx:72 sets `stream.onerror = () => streamState("reconnecti …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/shared.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-ui.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/shared-projects.md`

**Suggested fix:** Keep the server's 429. The runner link in src/collab/link.ts:151 already relies on it. Fix the UI only.

1. In ui/collab-state.ts, widen the callback to `onState(state: "connected" | "reconnecting" | "limited", reason?: string)`.
   - In `onerror`, when `current.readyState === EventSource.CLOSED`, the browser has given up, which means an HTTP error rather than a network drop. In that case, before the 30 s retry, make one probe: `fetch(apiPath("/api/team/events"), { headers: { accept: "text/event-stream" }, signal })`.
   - If the probe is not OK, read `{ error }` and report `onState(status === 429 ? "limited" : "reconnecting", error)`. Keep the 30 s timer. A 401 still goes through the existing checkIdentity path.
   - If the probe returns 200, abort it at once so the server releases the slot, and reopen the EventSource.
   - Alternative: replace EventSource with the fetch-based SSE reader pattern that src/collab/link.ts:199-206 already uses, so status and body are always readable.
2. M …

**Suggested regression test:** In test/collab-ui.test.ts, extend the existing test "team stream frames set the unread count ... every frame but a refusal reloads the pages".

1. Open the stream with `const states: unknown[] = []; const close = openTeamEvents((s, r) => states.push([s, r]))`.
2. Call `source.fail()`. The fake sets readyState to CLOSED, as a browser does after an HTTP error.
3. Answer the probe request for /api/team/events with status 429 and body `{ error: "Too many team event streams; close another tab and ret …

<details><summary>Verifier's independent reproduction</summary>

Port 4659 was already held by another verifier's server (home v4657h), so I left it alone. I started a fresh fake-mode server on my extra port 4661: `qa-server.sh start v4659t1415 4661 fake`. Through the API I created one test account ("dana", random password, viewer on the MQTT-MCP project p-ef01794b). No runs, repos or clones were touched.

Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4659t1415/tabs.mjs. It uses a fresh incognito Chrome context, signs in on http://127.0.0.1:4661, opens 5 tabs, clicks Board in each, and records every /api/team/events response with the body of any error.

Log /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4659t1415/board.log:
- Statuses were [200,200,200,200,429]. The 429 body was {"error":"Too many team event streams; close another tab and retry"}.
- Tabs 1-4 show "Connected". Tab 5 shows only "Reconnecting".
- In tab 5, [role=status] text is ["Reconnecting","0 tasks"] and the page body never contains "Too many". The status pill has no title or tooltip.
- The board itself rendered from its normal requests.
- Tab 5 retried every 30 s (21 s 429, 51 s 429). After I closed tab 2 at 61.5 s it stayed "Reconnecting" until the next retry at 81 s (200), then showed "Connected".
- The only other signal was a console 429 error.

Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4659t1415/board-tab5-refused.png. It shows the amber "Reconnecting" pill next to a fully rendered board, with no explanation anywhere.

So the reporter's claim holds. One refinement: the stream is not stuck. It retries every 30 s (TEAM_EVENTS_RETRY_MS), so after another tab closes it recovers within up to 30 s.

Related finding, same setup, Results tab (results.log): /api/events gave [200,200,200,200,429] with body "Too many shared event streams; close another tab and retry". Tab 5 showed "Reconnecting" and never retried: 40 s after tab 2 closed it was still "Reconnecting", with no further /api/events request. That tab stays stale until the user switches tabs or reloads.

Not by design: no doc describes this behaviour. The comment on TEAM_EVENTS_RETRY_MS (ui/collab-state.ts:95) names the 4-stream cap only to justify the 30 s retry. The server writes a user-facing reason that the UI can never show. Not environmental  …

</details>

### t14-7 · minor · Switching the Team connection discards an unsaved New task draft without warning

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-30.

**Repro**

> 1. On a computer with two team connections, open Board (?team=A) → New task, type a title.
> 2. Change the 'Team connection' select to team B, then back to A.

**Expected:** Warn before discarding the draft, or keep it.

**Actual:** A full page navigation happens. The draft title is gone after switching, and still gone after switching back (the form is not open).

**Root cause (verifier):** ui/team-connections.tsx:6-10: `selectTeamConnection()` sets `?team=`, forces the hash to #/team and calls `location.assign(url.href)`, which reloads the whole document. It does not check for unsaved work. The picker at ui/team-connections.tsx:22 calls it directly from the select's onChange.

ui/collab-board.tsx:121-125: NewTaskForm keeps title, goal, acceptance, baseRef, owner and reviewer only in component-local useState. It has no beforeunload handler (unlike ui/conventions.tsx:23-27 and ui/code-browser.tsx:42) and no sessionStorage persistence (unlike the run composer draft at ui/run.tsx:1768/1783).

ui/collab-board.tsx:75: the form is only mounted while `creating` is set, and that state resets on every mount. So the reload, and any other unmount (hash navigation, reload), throws the draft away silently, and switching back cannot restore it.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team-connections.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-board.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/lib.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/team.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/team-connection-ui.test.ts`

**Suggested fix:** Keep the full reload: it is the designed isolation boundary between connections. Guard it and keep the draft:

1. Add a small unsaved-work registry in ui/lib.ts, for example `registerUnsaved(key, isDirty)` and `hasUnsavedChanges()`.
2. NewTaskForm registers itself while title, goal, acceptance or baseRef is non-empty. While dirty it also adds a beforeunload warning, the same pattern as conventions.tsx:23-27.
3. In the TeamConnectionPicker onChange (or inside selectTeamConnection), when `hasUnsavedChanges()` is true, ask with confirm(): "Discard the unsaved New task draft and switch teams?". If the user cancels, reset `event.currentTarget.value` to the current selection and return, so the select doesn't show the wrong team.
4. Better still, persist the draft fields in sessionStorage, keyed by connection id and project (for example `team-new-draft:<connection>:<project>`), the same pattern as run.tsx's `agent-draft:<id>`. Reopen and restore it when the board for that connection mounts. C …

**Suggested regression test:** Primary, browser test: in test/e2e/team.e2e.ts (it has a fake hub plus a linked runner), add a case with two connections:
1. Open Board, click New task and fill the Title.
2. Register page.on('dialog') to dismiss, then selectOption the other id on `section.team-connection-picker select`.
3. Assert that a dialog fired, the URL's `team` param is unchanged, the select still shows the original connection, and the Title input still holds the text.
4. Then accept the dialog and switch. Assert the URL  …

<details><summary>Verifier's independent reproduction</summary>

Port 4643 was already taken by another verifier's server (v4641mh, home homes/v4641mh), so I left it alone and used my extra port. I started a fresh fake-mode server with a new home: `qa-server.sh start v4643k7 4645 fake`. Using the API, I created project "V4643 Team MQTT" on a scratch bare+working clone of MQTT-MCP, a test account "alice" (contributor, random password) and repository key "mqtt". Then, in the UI under Settings → Connections → join, I connected this computer to http://127.0.0.1:4645 as alice. That gave two entries in the Team connection select: "This computer’s own board" (local) and "mx · alice · connected" (c-103c2a838697f19d). This is the same client code path as the reporter's two remote hubs.

Steps in work/v4643/repro.mjs (log in work/v4643/repro.log), using a persistent profile:
1. Open ?team=c-103c2a838697f19d#/team and click "New task". Type the Title "Draft title v4643 should survive" and a Goal. The form is open and the draft is present (screenshot shots/v4643k7/001-draft-before-switch.png).
2. Set window.__noReload=true, then selectOption('local') on section.team-connection-picker select. The URL became ?team=local#/team. __noReload was gone, so this was a full document reload. The form was closed, the draft was not visible, and no dialog of any kind appeared (page.on('dialog') recorded nothing).
3. Switch back to the remote connection. The URL is ?team=c-103c...#/team, the form is closed (#team-new-title count 0) and the draft was not restored (shots/v4643k7/003-after-switch-back.png shows the empty board).

Control checks:
- Opening the form, changing the hash to #/settings and pressing history.back() also discards the draft silently.
- page.reload() with a draft open shows no beforeunload prompt and the draft is lost.

So the New task form has no dirty guard or persistence at all. The team switch is the most surprising case because the picker sits directly above the open form and its help text says "Switch teams without interrupting running tasks". There were no console or 5xx errors.

Why it is not by design:
- docs/team-collaboration.md:7,110 explains that the ?team pin and the reload isolate requests per connection, but nothing says drafts are discarded.
- Elsewhere the app works hard to keep drafts: the task page keeps unsaved Goal/Acceptance (collab-task.tsx:36-41,148-152; docs/team-collaboration.md:124), run composer drafts go to sessionStorage (ui/run.tsx:1768,1783), and conventions.tsx:23-27 and code-browser.tsx:42 wa …

</details>
