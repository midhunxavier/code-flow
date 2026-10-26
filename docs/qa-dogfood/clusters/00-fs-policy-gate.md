# Cluster 00 · fs-policy-gate

**Filesystem-restriction gate: shell/model-catalog/frame-policy bypass + UI blocked states**

Status: **merged · verified · repair round 1 merged into continuation · fresh re-verification passed** · 14 issues · branch `qa-fix/fs-policy-gate` (+ `qa-fix/fs-policy-gate-r1`)

Planner notes: Root cause: the FilesystemAccess.ownerGate globalPrivate list (src/filesystem-access.ts:61) is a deny-list kept by hand. It names 'shells' (the route is 'shell') and leaves out 'model-catalog' and 'frame-policy'. Fix the list; better, use an allow-list or add a test that every server route segment is classified. Then give the UI a 'paused by filesystem policy' state for 403s: Health/Agents settings (t04-4/t05-11), the Browser tab (t08-4) and greyed providers (t23-8; /api/agents drops the reason). Also stop the Terminal tab from reopening shells on its own, because those shells then block policy changes (t23-2/t08-3, the first-time effect in ui/terminal.tsx). t23-9 adds a confirmation and a 'clear restrictions' action to ui/filesystem-policy.tsx. Leave the side-panel Browser internals to the side-browser cluster; only add the 403 display. Duplicate groups: [["t08-2","t23-1","S14-1"],["t04-3","S14-2"],["t09-18","S15-7"],["t04-4","t05-11"],["t23-2","t08-3"]]

Likely files: `src/filesystem-access.ts`, `src/server.ts`, `ui/terminal.tsx`, `ui/state.ts`, `ui/filesystem-policy.tsx`, `ui/app.tsx`, `ui/settings.tsx`, `ui/model-catalog.tsx`, `src/frame-policy.ts`, `ui/rail.tsx`

## Fix result

Commits:
- `1289d90` Remove the uncalled /api/frame-policy probe
- `7e1c976` Classify every owner route under filesystem restrictions
- `9fd80ec` Make saving unchanged filesystem policy rules a no-op
- `a3ee4d6` Say what a filesystem restriction pauses instead of loading forever
- `92ee5bf` Pause the Terminal tab under restrictions and keep closed shells closed
- `9770369` Confirm a first filesystem restriction and offer to remove it
- `1578196` Cover the filesystem-restriction gate in the browser
- `5fd48a0` Keep the restart hint for a line terminal that is gone

Fixer notes for the integrator: - Behaviour change: ownerGate now uses an allow-list classification (src/filesystem-access.ts). Under any custom restriction, a top-level /api segment that is in none of RESTRICTED_PRIVATE_ROUTES / RESTRICTED_EXECUTION_ROUTES / RESTRICTION_OPEN_ROUTES is refused (403 for GET, 409 otherwise). The open list holds exactly the routes that were already ungated, so existing routes keep their behaviour. The exceptions are shell (now private, DELETE allowed), model-catalog (now private) and frame-policy (removed). I dropped the stale names "shells", "memory" and "coordination", which match no route; unknown segments are refused anyway.
- If another cluster adds a new top-level route, test/qa-fs-policy-gate.test.ts fails until the route is classified in one of the three lists. That is intended.
- The global refusal message changed from 'Custom filesystem restrictions pause app-managed execution…share host authority' to FilesystemAccess.pauseMessage(), which names the project. No existing test asserted the old text.
- GET /api/agents now carries unavailableReason:'filesystem-policy', and GET /api/projects carries filesystemRestricted:true (owner route only; shared accounts use handleSharedApi and are unaffected).
- Policy activation now counts only running shells. Exited shells no longer block it, since closing them kills nothing.
- PUT filesystem-policy with identical rules is now a no-op that returns the current snapshot.
- Edited an existing test on purpose: test/e2e/history-launch. …

## Independent verification

- **t08-2: verified** — Fresh fake-mode server v00 on 127.0.0.1:4339, built from a detached worktree at 8e170b3. Scratch repo 'v studio' has packages/core/src/scope.ts and secrets/config.env. I applied the restriction in the UI: Settings → Projects → Read deny 'packages' → 'Apply policy' → confirm. Panel said 'Filesystem policy revision 1 applied.'
API under the restriction:
- GET /api/file of the denied path → 403 (control).
- POST /api/shell → 409 in every form I tried: restricted repo, pty:true, unrestricted repo, /api/v1/shell, text/plain body, /api/Shell and /api/%73hell.
- POST /api/shell/<id>/input (text and data) and /resize → 409.
- GET /api/shell, /api/v1/shell and /api/shell/x/events → 403.
- DELETE /api …
- **t04-3: verified** — I put a `node` wrapper on PATH that logs every fake-agent.mjs invocation.
Control, with no restriction: GET /api/model-catalog logged 'claude -p --input-format stream-json …' and 'codex app-server'.
Under the restriction:
- GET /api/model-catalog?antigravityExecution=native → 403.
- POST {} → 409, and POST {allowResearch:true} → 409.
- /api/v1/model-catalog GET → 403, POST → 409.
- /api/models and /api/doctor → 403.
The log gained 0 lines during every restricted window (awk-checked across all of them). That includes UI runs that opened Run options → Advanced → 'Team — dynamic plan', clicked Settings → Refresh providers, and opened the Health dialog.
The catalog panel shows 'Model discovery i …
- **t23-2: verified** — With the restriction active, I opened the side panel on Terminal on a fresh load and after a reload. It sent no POST /api/shell (no shell or serve requests at all), and GET /api/shell → 403, so no hidden shell exists. The pane names the project and links to the policy; the link opens Settings → Projects with 'v studio' selected.
Open-terminal variation: with a running terminal, Apply policy → 409 'Close the open terminal (side panel → Terminal) and stop development services before changing filesystem policy.' The panel then offers 'Close the open terminal and apply', and clicking it closed the shell and applied revision 3.
Policy applied elsewhere (API) while the tab was open: after one 403  …
- **t09-18: verified** — src/frame-policy.ts and the /api/frame-policy route are gone, and grep finds no references left in src, ui or docs (only the new test).
Without a restriction, POST /api/frame-policy {url:'http://192.0.2.1/'} → 404 in about 3 ms, so there is no 5 s outbound HEAD; https://example.com → 404 the same way, and /api/v1/frame-policy → 404.
Under the restriction, POST /api/frame-policy and /api/v1/frame-policy → 409, because unclassified routes now fail closed. An unknown route (/api/brand-new-route) → 404 unrestricted.
- **t04-4: verified** — Under the restriction, #/settings/agents shows:
- the notice 'Provider checks and agent runs are paused: project “v studio” has a custom filesystem restriction… Review the filesystem policy';
- three 'Paused by filesystem policy' badges;
- no 'Checking health…', 'Install this CLI' or 'Not installed'.
The same holds after clicking Refresh providers.
'Health & usage' and App menu → 'Agents & usage' both open a dialog that says 'Provider health checks are paused: project “v studio”…' instead of an endless 'Checking…'. The menu subtitle reads '3 providers · paused by filesystem policy'.
Check this computer shows a pause notice, and 'Check all dependencies' is disabled.
The /api/doctor refusal is …
- **t08-4: verified** — Fresh load under the restriction, Browser tab:
- The page shows 'Interactive browsing is paused: project “v studio”…'.
- The toolbar reads 'Browser unavailable'.
- Go, New tab and Take control are disabled.
- No /api/serve or /api/browser requests in 7 s.
Variation: the Browser tab was live ('Live browser · shared with agents') when I applied the restriction through the API. Within 20 s it showed the server's 403 text, 'Interactive browsing is paused under filesystem restrictions'. Its only requests were browser/events plus browser/control probes every 15 s, with no /api/serve polling. After clearing the policy it reconnected to 'Live browser' within 20 s.
- **t23-8: verified** — With 'v studio' restricted, I opened New run in the unrestricted 'v other' project:
- The notice reads 'Agent runs are paused: project “v studio” has a custom filesystem restriction… Review the filesystem policy'.
- The composer problem reads 'Agent runs are paused by a project's filesystem restriction', not 'Pick an agent'.
- Send is disabled.
- 'Choose provider' lists Claude Code, Codex and Antigravity, each with 'Paused by filesystem policy'.
- The sidebar shows 'Filesystem restrictions pause connected projects', the same text as the server's 409.
At 390px it lays out without horizontal overflow (scrollWidth 390).
- **t23-9: verified** — The button now reads 'Apply policy'. Going from unrestricted to restricted shows the confirm 'Pause execution in every project? / Restrict file access for “v studio”? …', with Cancel and Apply restriction; Escape cancels and sends no PUT.
A restricted saved policy shows a warning and 'Remove restrictions'. Its confirm dialog leads to allow ['.'] with no denies at a new revision.
No-op saves:
- Re-applying identical rules, including '  packages/  \n\npackages', says 'No changes to apply: revision 1 already has these rules.' and sends no PUT.
- A PUT of the identical rules through the API → 200 at the same revision.
Double-clicking Apply or Remove opens one dialog and sends one PUT.

Code-review findings:
- [minor] `ui/filesystem-policy.tsx:48` 'Close the open terminal and apply' closes shells with DELETE /api/shell/:id but doesn't record SideMemory.shellsClosed. Closing through the API or another window has the same gap; only the × in ui/terminal.tsx sets it. Once restrictions are lifted, the next full page reload with the Terminal tab showing counts as a first visit (ui/terminal.tsx:93) and opens a new shell. The next policy change then fails with 409 'Close the open terminal…' again. It is recoverable with the offered button. Seen in my runs: closed via the panel or the API, cleared the policy, reloaded → 1 running shell → restric …
- [nit] `ui/terminal.tsx:47` While paused, the poll is off, so `list` keeps the shell that the policy panel just closed. `alive(memo.shell)` still accepts it, and the pane keeps showing the stale xterm with '[Terminals are paused under filesystem restrictions]' instead of the PolicyPauseNotice that names the project. It still shows that after the restriction is cleared from another tab, until a reload.
- [nit] `ui/state.ts:36` executionPaused comes only from /api/agents, which loads at boot or after a save in this app's policy panel. A restriction applied in another tab or through the API leaves the composer, settings and health surfaces showing providers as normal until a reload. The terminal and browser tabs do detect it through their 403s. The server still refuses with the plain-language message, so this is cosmetic.

Repair round 1: 2 commit(s), items review-1:fixed, review-2:fixed; merged: no

## Issues

### t04-3 · major · /api/model-catalog still spawns provider CLIs (and research fetches) while a custom filesystem restriction pauses execution

**Fix outcome: fixed.** src/filesystem-access.ts: 'model-catalog' is now in RESTRICTED_PRIVATE_ROUTES (GET 403, POST 409). src/server.ts: the model-catalog handler also refuses under hasRestrictions() before agentAvailability() or discovery runs. ui/model-catalog.tsx: when execution is paused it skips the auto-load and shows the pause notice. docs/api.md now documents the refusal.

Fixer's check: QA server f00b on 4337. I put wrapper CLIs (claude/codex/agy/gh/docker/tailscale) first on PATH; each appends its argv to invocations.log and then execs test/fake-bin. With the restriction active: POST {allowResearch:false} returned 409, GET ?antigravityExecution=native returned 403, POST {allowResearch:true} returned 409, and /api/models and /api/doctor returned 403. In the UI, Run options → Advanced → 'Team — dynamic plan' made 0 /api/model-catalog requests and showed 'Model discovery is paused: project “QA Alpha”…'. The invocation log stayed empty and no model-catalogs dir was created. After clearing the policy, POST returned 200 and spawned 'claude -p' and 'codex app-server' again.

Tests: `test/qa-fs-policy-gate.test.ts`, `test/e2e/qa-fs-policy-gate.e2e.ts`

Source: tester unit solo-runs-providers-1; observed with api; features SOL-10.

**Repro**

> 1. QA server whose provider CLIs log invocations (t04 used wrappers that append to ctl/invocations.log).
> 2. PUT /api/projects/<id>/filesystem-policy {revision:0, read:{allow:['.'],deny:['mqtt-mock-server']}, write:{allow:['.'],deny:['mqtt-mock-server']}}.
> 3. GET /api/models → 403, GET /api/doctor → 403, GET /api/agents → all available:false.
> 4. POST /api/model-catalog {} → 200; or in the UI open Run options → Advanced → Team — dynamic plan.
> 5. Inspect invocations log.

**Expected:** Under a custom restriction ('pauses normal application-managed execution'; 'Health responses avoid … provider probes') the capability catalog is blocked like /api/models and /api/doctor, or serves cache only without executing CLIs/network research.

**Actual:** POST model-catalog returned 200 and spawned `codex app-server` and `claude -p --input-format stream-json … --tools ''` twice; the UI catalog load spawned `agy … models`; catalogs reported 'current'. With allowResearch on, research fetches official docs over the network.

**Root cause (verifier):** Gate:
- src/filesystem-access.ts:61: the `globalPrivate` route list used by `ownerGate` under any restrictive policy includes "models" and "doctor" but not "model-catalog".
- src/filesystem-access.ts:62: the `execution` list (non-GET) does not include it either.
So GET and POST /api/model-catalog pass the global restriction gate.

Handler (src/server.ts:2387-2399):
- Calls `agentAvailability()` directly. Unlike /api/agents at server.ts:1894, it does not check `fileAccess.hasRestrictions()`.
- For each available provider it calls `modelCatalogStore.get(..., { force: POST, offline: !a.available || body.offline })` (server.ts:2396). Offline is never forced by a restriction.
- When the cache is missing or stale (TTL 10 min), or on POST force, `ModelCatalogStore.refresh` (src/model-catalog.ts:247-254) calls `discover()`. That spawns the provider CLI via src/adapters/model-discovery.ts:25 (`startJsonlProcess`). With allowResearch on, it also calls `researchModels()` (src/model-catalog.ts:268-275 and src/model-research.ts:92-96), which fetches official docs over HTTPS.

UI trigger: ui/model-catalog.tsx:47 auto-loads on mount. ui/composer.tsx:386 mounts it whenever the template is auto-tea …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filesystem-access.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/model-catalog.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/history-launch.e2e.ts`

**Suggested fix:** 1. Primary fix, matching /api/models and /api/doctor: add "model-catalog" to the `globalPrivate` list at src/filesystem-access.ts:61. GET then returns 403 and POST returns 409 with the standard "Custom filesystem restrictions pause..." message. This also covers the /api/v1 alias. It blocks the settings write (allowResearch) along with discovery, which is acceptable because the feature cannot be used while execution is paused.
2. Defense in depth in the server.ts:2387 handler:
   - When `fileAccess.hasRestrictions()` is true, do not call `agentAvailability()` or `managedAvailability()`.
   - Pass `offline: true` to `modelCatalogStore.get`, or return synthetic available:false the way /api/agents does.
   - This keeps a cache-only path safe even if the route list changes later.
3. UI: in ui/model-catalog.tsx, on a 403 response show a calm "Model discovery is paused under filesystem restrictions" note instead of a generic alert. Also skip the auto-load when the server reports restrictions. …

**Suggested regression test:** 1. test/e2e/history-launch.e2e.ts, in the restricted-policy block:
   - Add "/models", "/doctor" and "/model-catalog" to the GET list at line 343 and assert 403 for both the /api and /api/v1 prefixes.
   - Add "/model-catalog" to the POST loop at line 349 and assert 409.
2. A focused server test, e.g. a new case in test/model-catalog.test.ts or test/server-reliability.test.ts:
   - Start a server with PATH pointing at counting wrappers around test/fake-bin, or a FAKE_INVOCATION_LOG env var added …

<details><summary>Verifier's independent reproduction</summary>

Fresh QA server v4671 on 127.0.0.1:4671 (home .../scratchpad/qa/homes/v4671, no runs). I started it with a wrapper dir first on PATH (.../scratchpad/qa/work/v4671/bin). Each wrapper for claude/codex/agy/gh/docker/tailscale appends its argv to .../work/v4671/invocations.log and then execs the repo's test/fake-bin CLI, so no real provider quota was used.
1. PUT /api/projects/p-ef01794b/filesystem-policy (MQTT-MCP) with {revision:0, read:{allow:['.'],deny:['mqtt-mock-server']}, write:{same}} returned 200 at revision 1.
2. With the restriction active: GET /api/models returned 403 and GET /api/doctor returned 403, both with "Custom filesystem restrictions pause app-managed execution...". GET /api/agents returned 200 with all three providers available:false. The invocation log stayed at 0 lines.
3. POST /api/model-catalog {"allowResearch":false} returned 200. claude and codex came back state "current" with available:true. The log showed `claude -p --input-format stream-json ... --no-chrome --tools  --settings {"disableAllHooks":true,...}` and `codex app-server`.
4. GET /api/model-catalog?antigravityExecution=native returned 200 and spawned `agy --log-file .../native-auth.log models`. The agy catalog reported current with model-one and model-two.
5. POST /api/model-catalog {"allowResearch":true} returned 200 and spawned claude and codex again. Every model got researchAttemptedAt. The claude models got documented.source=https://platform.claude.com/docs/en/models/overview. lsof on the server pid during the request showed 4 outbound :443 connections (64.239.123.193 and 160.79.104.10).
6. UI path in headless Chrome: I cleared my QA home's model-catalogs cache, then opened Run options > Advanced. "Team — dynamic plan" is the default template. That alone sent GET /api/model-catalog?antigravityExecution=isolated (200) and spawned claude -p and codex app-server. The panel showed "claude · current · 4 models" and "codex · current · 2 models" while /api/agents reported every provider unavailable (screenshot .../scratchpad/qa/shots/v4671/001-catalog-under-restriction.png).

Attempts to refute:
- Not the tester's environment: it reproduces with deterministic fake CLIs in a fresh home.
- Not by design: docs/filesystem-policy.md says "Any custom read or write restriction pauses normal application-managed execution across every project" and "Health responses avoid Python/provider probes under a restriction". The sibling endpoints /api/models and /api/doctor are explicitly block …

</details>

### t08-2 · major · Side panel terminals are not paused by a restrictive filesystem policy; shell input runs and reads denied paths

**Fix outcome: fixed.** Root cause: the hand-kept globalPrivate deny-list in FilesystemAccess.ownerGate named "shells", but the route is /api/shell, and the per-target check reads body.repo while the shell body sends cwd. Fix in src/filesystem-access.ts: the lists are now exported RESTRICTED_PRIVATE_ROUTES / RESTRICTED_EXECUTION_ROUTES / RESTRICTION_OPEN_ROUTES. "shell" is private (DELETE is exempt, so a terminal can always be closed), and any top-level segment in none of the lists is refused. Defence in depth in src/server.ts: the /api/shell block throws 403 (GET) or 409 under hasRestrictions(), except DELETE. UI fixes are in ui/terminal.tsx: the tab is paused (no poll, no auto-POST, the + menu items disabled) and shows the shared notice. A line-based ShellView now shows the server's refusal text instead of 'code-flow restarted?'; a 404 keeps the GONE restart hint.

Fixer's check: QA server f00 (127.0.0.1:4335) from the worktree, with scratch repos alpha and beta. I applied the policy through Settings → Projects (Read/Write deny 'secrets'). POST /api/shell returned 409 for the restricted repo, with pty, for the other repo and for /api/v1/shell. POST /api/shell/x/input with 'echo pwned > secrets/…' returned 409 and the marker file was never created. GET /api/shell returned 403 and DELETE returned 404, i.e. allowed through. r6: a line shell (CODEFLOW_PYTHON unset to force pipe mode) that had exited, then a restriction applied through the API: the pane read 'Terminals are paused under filesystem restrictions' instead of 'gone'. No server log errors.

Tests: `test/qa-fs-policy-gate.test.ts`, `test/e2e/qa-fs-policy-gate.e2e.ts`

Source: tester unit side-panel-previews-1; observed with api; features SIDE-13.

**Repro**

> 1. Start a QA server and add a scratch clone (t08-studio) as project 't08 Studio'.
> 2. Close all terminals. Settings → Projects → t08 Studio → Read deny paths: 'packages' → 'Stop execution and apply policy' (revision 1 applied).
> 3. GET /api/file?repo=<clone>&path=packages/core/src/scope.ts → 403 'policy denies read access' (correct).
> 4. POST /api/shell {cwd:<clone>} → 201 with a new shell id.
> 5. POST /api/shell/<id>/input {text:'head -3 packages/core/src/scope.ts > <scratch>/denied-read.txt'} → 200.
> 6. cat denied-read.txt shows the denied file's first lines.
> 7. In the UI the Terminal tab shows 'This terminal is gone (code-flow restarted?)'.

**Expected:** Per docs/filesystem-policy.md ('Any custom read or write restriction pauses … terminals'), opening a shell and sending it input are refused (403/409) while any restriction is active, and the UI explains that terminals are paused by policy.

**Actual:** Shell creation (201) and input (200) still work under the restriction, and commands run with full host access in the restricted repository: denied content was written to work/t08/denied-read.txt. The UI's shell stream fails and shows a misleading 'code-flow restarted?' message instead of a policy message. /api/browser is correctly 403.

**Root cause (verifier):** src/filesystem-access.ts:61. The globalPrivate route list in FilesystemAccess.ownerGate names "shells", but the side-panel terminal route is /api/shell (src/server.ts:2334 `if (parts[1] === "shell")`). No /api/shells route has ever existed; the typo came in with commit 702ad1e. So the global 'pause execution under any restriction' check never fires for terminals. The per-target check (filesystem-access.ts:50-56) cannot catch it either, because the shell body carries `cwd`, not `repo`/`project`, so `targetRestricted` stays false even for the restricted repo. Defence in depth is also missing:
- The shell handlers (src/server.ts:2336-2372: POST create, POST input, POST resize) have no fileAccess.hasRestrictions() check. Contrast /api/browser at src/server.ts:1644, the shell event topic at src/server.ts:1424, and /api/health interactiveTerminal at src/server.ts:1954.
- The side-panel Shells instance (src/server.ts:250 `new Shells()`) has no `enabled` guard, unlike TeamTerminals (src/server.ts:251-254 `enabled: () => !fileAccess.hasRestrictions()`).
UI side issues:
- ui/terminal.tsx:458 (line-based ShellView) replaces any stream error with GONE ('This terminal is gone (code-flow restart …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filesystem-access.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/terminal.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/filesystem-policy.test.ts`

**Suggested fix:** 1. src/filesystem-access.ts:61: change "shells" to "shell" in globalPrivate. Verified in a patched snapshot: create and input → 409, list → 403 under the restriction; 201 once the policy is cleared. Review the other globalPrivate and execution names against the real parts[1] route names for similar slips.
2. Defence in depth in src/server.ts's /api/shell block: before shells.open / write / type / resize, `if (fileAccess.hasRestrictions()) throw new HttpError(409, "Terminals are paused under filesystem restrictions")`. Optionally give Shells an `enabled` guard like TeamTerminals so no caller can spawn a host shell while a restriction is active. Keep DELETE allowed, so a stray shell can always be closed.
3. UI, ui/terminal.tsx:
   - In ShellView use `setError(ev.message || GONE)`.
   - In the Terminal tab, when GET /api/shell fails with 403/409, or /api/health reports a restriction, show 'Terminals are paused by the filesystem policy' instead of 'Loading…'.
   - Do not auto-POST /api/she …

**Suggested regression test:** test/filesystem-policy.test.ts: this file already boots a server with a saved restrictive policy and asserts /api/health interactiveTerminal === false and that the 'shell:missing' topic is refused (around lines 44-63). Extend that server test with:
- POST /api/shell {cwd: <restricted repo>} → 409, and the same for an unrelated unrestricted git repo (global pause).
- POST /api/shell/<any>/input {text:'touch marker'} → 409, and the marker file does not exist.
- GET /api/shell → 403.
- Optionally,  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4671 on 127.0.0.1:4671. The old homes/v4671 from an earlier session was renamed to v4671-prev-1792956364 first, so the home was fresh. Made a scratch clone of IndustriAgents-Studio (clones/v4671-studio, origin = local bare repo) and registered it as project 'v4671 Studio'.
1. UI (Playwright, s1-policy.mjs): #/settings/projects → select project → Read deny paths 'packages' → 'Stop execution and apply policy' → panel shows 'Filesystem policy revision 1 applied.' GET policy shows read.deny=['packages'].
2. curl GET /api/file?repo=<clone>&path=packages/core/src/index.ts → 403 'policy denies read access' (correct). /api/browser → 403, /api/serve → 403, POST /api/runs → 409 (correct). GET /api/shells (the name in the deny list; no such route exists) → 403.
3. POST /api/shell {cwd:<clone>} → 201, shell shmvo7yvmjc4eb, interactive:false. POST /api/shell/<id>/input {text:'head -3 packages/core/src/index.ts > work/v4671/denied-read.txt; id -un >> ...'} → 200. denied-read.txt then holds the denied file's first 3 lines plus 'mx', so the command ran with full host user authority.
4. Global scope: POST /api/shell in an unrelated, unrestricted git repo (work/v4671/tiny) → 201. Docs say any restriction pauses terminals across every project. A pty:true shell in the restricted repo → 201 too.
5. UI (s2-terminal.mjs): project page → Side panel → Terminal tab. The client sends POST /api/shell → 201, leaving a running PTY shell on the server. The xterm pane shows '[Terminals are paused under filesystem restrictions]' and disables stdin (screenshot shots/v4671/001-terminal-tab.png). So with python3 PTY available the UI message is correct. The reporter's 'This terminal is gone (code-flow restarted?)' text only appears for line-based shells: ShellView (ui/terminal.tsx:458) ignores the server message. The reporter reattached to a non-pty shell opened through the API.
6. Fix check: snapshot copy builds/v4671 with only 'shells' changed to 'shell' at src/filesystem-access.ts:61, served on 4671 (server v4671b). Under the same policy: POST /api/shell → 409 'Custom filesystem restrictions pause app-managed execution…'. POST /api/shell/x/input → 409. GET /api/shell → 403. No file was written. After clearing the policy, POST /api/shell → 201 again. With only that server change, the UI Terminal tab shows 'Loading…' forever, because the 403 from GET /api/shell is swallowed at ui/terminal.tsx:32.
Cleanup: all shells closed, policies cleared on v4671b, servers stopp …

</details>

### t23-1 · major · Terminals still run in restricted repos: /api/shell bypasses the filesystem-policy gate

**Fix outcome: duplicate.** Same root cause and fix as t08-2: the 'shells' to 'shell' route classification plus the shell-route guard in src/server.ts.

Fixer's check: Under the restriction, the input that wrote secrets/written-under-policy.txt now returns 409 and no file appears. Shell creation (pty and line, restricted and other repo) returns 409. Checked in r1 and in the server test.

Tests: `test/qa-fs-policy-gate.test.ts`

Source: tester unit infra-platform-memory-ml-insights-1; observed with api; features PLAT-12.

**Repro**

> 1. Start a fake QA server and create a project for a scratch git repo that commits secrets/config.env.
> 2. Settings → Projects → that project → Filesystem policy: Read deny 'secrets', Write deny 'secrets' → 'Stop execution and apply policy' ('revision N applied').
> 3. As owner, POST /api/shell {"cwd":"<repo>"}. Result: 201 with a running shell.
> 4. POST /api/shell/<id>/input {"text":"cat secrets/config.env; echo pwned > secrets/written-under-policy.txt"}. Result: 200, and the file appears in secrets/.
> 5. A pty shell works the same way: POST /api/shell/<id>/input {"data":"date > secrets/pty-written.txt\r"} creates the file.

**Expected:** docs/filesystem-policy.md says any custom restriction pauses app-managed execution, explicitly including terminals. Opening a terminal and sending input should fail closed (403/409), like runs, previews and services.

**Actual:** The shell opens and runs commands in the restricted repo. It wrote two files into the write-denied secrets/ directory (secrets/written-under-policy.txt, secrets/pty-written.txt). Only the output stream topic is blocked, so the UI shows 'Terminals are paused' while input is still executed.

**Root cause (verifier):** src/filesystem-access.ts:61. The global gate in ownerGate lists "shells" in `globalPrivate`, but the route is `parts[1] === "shell"` (src/server.ts:2334: GET list, POST open, POST /input, /resize, DELETE). The `execution` list on line 62 has no "shell" either. The repo-target check on lines 50-56 does not catch it: it reads `body.repo`, and the shell API sends `cwd`. So POST /api/shell, /input and /resize all pass ownerGate (server.ts:1636). The shell handler (server.ts:2334-2375) never checks `fileAccess.hasRestrictions()` before `shells.open`, `shells.type` or input. The only check is in the output stream topic (server.ts:1424), which is why the UI shows "Terminals are paused" while the shell process is running and still takes input. On the client, the side-panel terminal still auto-opens a shell (POST /api/shell) when the tab is shown. That orphaned process then trips the activation guard in server.ts:1617 (`shells.list().length`), which blocks any policy change until the user closes a terminal that looks paused. All other gated names I checked are real routes; "shells" is the one singular/plural mismatch I found.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filesystem-access.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/terminal.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/filesystem-policy.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/filesystem-policy.test.ts`

**Suggested fix:** 1. In src/filesystem-access.ts:61, change "shells" to "shell" in globalPrivate. Under any custom restriction, GET /api/shell then returns 403 and POST open/input/resize returns 409, matching serve/preview.
2. Defense in depth, the same pattern as the browser route at server.ts:1644: at the top of the `parts[1] === "shell"` block (server.ts:2334), add `if (fileAccess.hasRestrictions() && req.method !== "DELETE") throw new HttpError(409, "Terminals are paused under filesystem restrictions")`, so a future gate-list typo cannot reopen this. Optionally let DELETE through so any leftover shell can always be closed.
3. UI (the side-panel terminal component; the auto-open is in the built terminal-*.js bundle): when restrictions are active, for example when /api/health reports interactiveTerminal false or the shell list returns 403, show a "Terminals are paused under filesystem restrictions" notice. Do not auto-POST /api/shell or offer "New terminal".
4. Optionally add a guard, in a test or at  …

**Suggested regression test:** test/e2e/filesystem-policy.e2e.ts, in the existing "persisted restrictions …" test (the "restricted" project denies reads of "private"):
- `POST /api/shell {cwd: repo}` returns 409, and so does `POST /api/shell {cwd: unrestrictedRepo, pty: true}` (the pause is global).
- `GET /api/shell` returns 403.
- `POST /api/shell/<anything>/input {text: "touch <marker>"}` returns 403 or 409, and `existsSync(marker)` is false afterwards.
- A PUT to the policy is not blocked by a "Close terminals" 409 after  …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode server with a new home (qa-server.sh start v4607t23 4607 fake; the old v4607 home had been used before, so I left it alone). Source: dogfood-qa at f14f404.
1. Created a scratch repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4607-t23-secrets (git init, committed secrets/config.env containing a fake test value). Registered it as project "t23 secrets" (p-21c32541) with POST /api/projects.
2. UI: Settings > Projects > Filesystem policy. Set Read deny "secrets" and Write deny "secrets", then clicked "Stop execution and apply policy". The UI showed "Filesystem policy revision 1 applied."; GET /api/projects/p-21c32541/filesystem-policy returned revision 1 with both denies.
3. Control requests under the same policy were refused, so the gate was active: POST /api/runs returned 409, GET /api/serve returned 403, and GET /api/shells (a plural route that does not exist) returned 403.
4. POST /api/shell {cwd: repo} returned 201 with a running line shell. POST /api/shell/<id>/input {text: "cat secrets/config.env > /dev/null && echo pwned > secrets/written-under-policy.txt"} returned 200, and the file appeared in secrets/ containing "pwned".
5. POST /api/shell {cwd: repo, pty: true} returned 201. /resize returned 200. /input {data: "date > secrets/pty-written.txt\r"} returned 200, and the file appeared in secrets/.
6. Read-deny bypass: GET /api/file?path=secrets/config.env was correctly refused ("policy denies read access"). I then sent shell input "cp secrets/config.env leaked.txt", and GET /api/file?path=leaked.txt returned the secret's full contents. Both read-deny and write-deny are bypassed end to end.
7. UI path (ui-term2.mjs): picked project "t23 secrets" and opened Side panel > Terminal. The UI itself sent POST /api/shell, which returned 201, and a real `scripts/pty.py /bin/zsh` child process started in the restricted repo. The pane showed "[Terminals are paused under filesystem restrictions]" (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4607t23/003-terminal-tab.png). xterm disables typing after the stream error, so text typed in the UI did not run; executing commands needs the raw API, as the reporter said. But the shell opened by the UI then blocked clearing the policy: PUT filesystem-policy (revision 1, no denies) returned 409 "Close terminals and stop developmen …

</details>

### S14-1 · major · The global restriction list names 'shells', but the terminal route segment is 'shell' (server.ts:2334). So POST /api/shell, /api/shell/:id/input and /resize are not blocked under custom filesystem restrictions. The per-project gate also misses it, because it resolves body.repo or ?repo while shells send body.cwd. Host commands run after a policy is applied, even though the shell topic says 'Terminals are paused under filesystem restrictions'.

**Fix outcome: duplicate.** Same as t08-2. The route-classification test (test/qa-fs-policy-gate.test.ts) scans server.ts and the mounted APIs. It fails if a routed segment is unclassified or a listed name matches no route, which is the 'shells'-style drift S14-1 asked to guard against.

Fixer's check: Same as t08-2. The unit test asserts GET /api/shell 403, POST create/input/resize 409, DELETE allowed, and the /api/v1 alias refused.

Tests: `test/qa-fs-policy-gate.test.ts`

Source: code-level suspect at `src/filesystem-access.ts:61` (confirmed hands-on).

**Repro**

> Ran a fake-mode QA server s14 (port 4557) from my snapshot, with a scratch git repo R (README.md, sub/a.txt) added as project p-53091e4a. PUT /api/projects/p-53091e4a/filesystem-policy {revision:0, read:{allow:['.'],deny:['sub']}, write:{allow:['.'],deny:['sub']}} → 200. Controls: GET /api/shells → 403 'Custom filesystem restrictions pause…', POST /api/serve → 409, GET /api/workspace/file?path=sub/a.txt → 403. Then POST /api/shell {cwd:R} → 201 {id:shmvo4nn3n617d, status:running}. POST /api/shell/shmvo4nn3n617d/input {text:'cat sub/a.txt > $W/leak.txt; echo policy-bypass >> sub/a.txt; pwd >> $W/leak.txt'} → 200; leak.txt then held the denied content and sub/a.txt was modified. Browser script term.mjs opened Terminal → New terminal and the API shell count went 1→2; screenshot shots/s14/003-terminal-opened-under-restriction.png. Restriction removed and shells closed afterwards.

**Expected:** docs/filesystem-policy.md says any custom restriction pauses app-managed execution, explicitly including terminals, and that activation requires closed terminals. POST /api/shell, /input and /resize should return 409 (as POST /api/serve does) while any restriction is active. Path-denied reads and writes must not be possible through an app terminal.

**Actual:** Under a restrictive policy, POST /api/shell {cwd: repo} returns 201 and starts /bin/zsh. POST /api/shell/:id/input {text} returns 200 and the command runs on the host. In the repro, the command read the policy-denied sub/a.txt into a file outside the repo (leak.txt contained 'x') and appended to the write-denied sub/a.txt ('policy-bypass'). In the UI, Side panel → Terminal → New terminal → s14-demo raised the shell count from 1 to 2 while the pane showed only '[Terminals are paused under filesystem restrictions]'. Only GET /api/shell/:id/events is refused (by the topic).

**Root cause (verifier):** FilesystemAccess.ownerGate's globalPrivate list has "shells", but the router dispatches on parts[1] === "shell" (server.ts:2334-2384), and no route is named "shells". The per-project check (targetRestricted) only looks at body.repo, ?repo, a run id or a project id, and the shell route sends body.cwd. Unlike /api/browser (server.ts:1644) and the shell SSE topic (server.ts:1424), the shell HTTP route has no fileAccess.hasRestrictions() guard of its own. The result is that terminals can be created and fed commands under any restriction. Only their output stream is refused.

**Suggested fix:** In src/filesystem-access.ts:61, replace or extend "shells" with "shell" in globalPrivate. Keep GET list and DELETE allowed so the owner can still close terminals; for example, allow parts[1]==="shell" && req.method==="DELETE". As defence in depth, at the top of the shell route in server.ts add `if (fileAccess.hasRestrictions() && req.method === "POST") throw new HttpError(409, "Terminals are paused under filesystem restrictions")`. For the per-project gate, also resolve body.cwd (repoRoot or manager.worktreeAt) as the request target. In ui/terminal.tsx, hide or disable 'New terminal' when health.interactiveTerminal is false because of restrictions, instead of showing a paused message over a live shell.

**Suggested regression test:** Server test: create a project with a temp repo and PUT a restrictive policy. Then assert POST /api/shell {cwd: repo} → 409, POST /api/shell/<id>/input → 409, the /api/v1 alias also → 409, and DELETE stays allowed. Add a table-driven test that pulls every parts[1] literal from the server.ts router and checks that each is either in the restriction lists or in an explicit allowlist, so name drift like 'shells'/'shell' fails CI.

### S14-2 · minor · 'model-catalog' is missing from the global restriction lists while 'models' is present. GET/POST /api/model-catalog (server.ts:2387-2398) still calls agentAvailability() and modelCatalogStore.get (force on POST), which runs provider CLI discovery and contradicts the policy's deferral of CLI probes.

**Fix outcome: duplicate.** Same fix as t04-3.

Fixer's check: Same as t04-3. The server test also asserts that no wrapper CLI ran and no model-catalogs dir was written.

Tests: `test/qa-fs-policy-gate.test.ts`

Source: code-level suspect at `src/filesystem-access.ts:61` (confirmed hands-on).

**Repro**

> Server s14 in fake mode from snapshot builds/s14. I wrapped the snapshot's test/fake-bin/claude and codex to append each invocation to $FAKE_INVOKE_LOG. With the policy from the shell repro active: GET /api/models → 403; GET /api/agents → all available:false. GET /api/model-catalog → 200 (claude current, 4 models, rev 1; codex current, 2 models, rev 1), and the log showed '1792950945 claude -p --input-format stream-json …' and '1792950945 codex app-server'. POST /api/model-catalog {} → 200 (rev 2, discoveredAt 1792950946388), and the log again showed claude -p … and codex app-server.

**Expected:** Behave like /api/models and /api/agents: either refuse (403/409) under restrictions, or return only cached catalogs offline with providers marked unavailable, without spawning provider CLIs. Impact is limited because discovery runs in a temp directory with --tools "" and no prompt, so no project files are exposed. It is a policy inconsistency, not a data leak.

**Actual:** With a restrictive policy active: GET /api/agents → all available:false and GET /api/models → 403. But GET /api/model-catalog → 200 with available:true, and the fake-CLI invocation log recorded `claude -p --input-format stream-json …` and `codex app-server`. POST /api/model-catalog {} → 200 and spawned both CLIs again; catalog revision went 1→2 with a new discoveredAt.

**Root cause (verifier):** The model-catalog route has no hasRestrictions() guard, and "model-catalog" is not in globalPrivate ("models" is). Under a restriction it still runs agentAvailability() and modelCatalogStore.get(provider, {force: POST}). When the cached catalog is missing or past TTL (always on POST), that calls adapter.discoverModels, which spawns `claude -p --input-format stream-json …` and `codex app-server` (src/adapters/model-discovery.ts). Elsewhere the code defers provider probes under restrictions: /api/agents returns available:false (server.ts:1894) and startup skips agentAvailability (server.ts:2809).

**Suggested fix:** Add "model-catalog" to globalPrivate in src/filesystem-access.ts. Alternatively, in the route: `if (fileAccess.hasRestrictions())` return providers with available:false and catalog from modelCatalogStore.get(id, {offline: true}), and reject POST with 409.

**Suggested regression test:** Server test with a restrictive policy and FAKE_RECORD-style invocation logging (or a stub discover function): GET and POST /api/model-catalog must return 403/409, or offline catalogs, and spawn no claude/codex process. Assert that the invocation log stays empty and the catalog revision is unchanged.

### t23-2 · minor · Terminal tab starts a hidden shell under a restriction, says 'paused', and that shell then blocks every policy change

**Fix outcome: fixed.** ui/terminal.tsx: under a restriction the tab asks for nothing. It knows from executionPaused (every provider reports unavailableReason 'filesystem-policy') or from a 403 on GET /api/shell, so it does not poll /api/shell or /api/serve, does not auto-POST, and shows the notice naming the project. Server side, POST /api/shell is refused (t08-2), and policy activation counts only running shells (src/server.ts). The 409 now says 'Close the open terminal…'. ui/filesystem-policy.tsx offers 'Close the open terminal and apply' on that 409, because the side panel in Settings can't show the terminal.

Fixer's check: r2: with the restriction active, I opened the project → Side panel → Terminal and reloaded. That made 0 /api/shell or /api/serve requests and 0 POST /api/shell in total, and the pane showed 'Terminals are paused: project “QA Alpha” has a custom filesystem restriction… Review the filesystem policy'. r3: in Settings, Remove restrictions returned 'revision 2 applied' with no 409. I left a terminal open and applied a policy: the alert offered 'Close the open terminal and apply', and clicking it gave 'revision 3 applied'. The e2e also checks this.

Tests: `test/e2e/qa-fs-policy-gate.e2e.ts`

Source: tester unit infra-platform-memory-ml-insights-1; observed with real-agents; features PLAT-11, PLAT-12.

**Repro**

> 1. With a custom restriction active, open the side panel on the Terminal tab (the open state persists, so any page load does this).
> 2. The pane shows '[Terminals are paused under filesystem restrictions]', but GET /api/shell lists a new running interactive shell in the restricted repo.
> 3. Settings → Projects → Filesystem policy → change anything, including clearing it → 'Stop execution and apply policy'.

**Expected:** Under a restriction the terminal tab should not create a shell. If it does, the policy editor should name the blocking terminal or offer to close it.

**Actual:** Error: 'Close terminals and stop development services before changing filesystem policy'. The pane says terminals are paused, so the user has no obvious terminal to close. The only workaround is the small × on the terminal tab or DELETE /api/shell/<id>. Every page load spawned a new shell (seen 3 times).

**Root cause (verifier):** 1. src/filesystem-access.ts:61 (`ownerGate`): the `globalPrivate` list contains "shells", but the route segment is "shell" (src/server.ts:2334). So under any custom restriction, GET /api/shell, POST /api/shell and POST /api/shell/:id/input are not gated. `targetRestricted` does not catch them either, because the shell body carries `cwd`, not `repo`. Only the stream topic is blocked (src/server.ts:1424, "Terminals are paused under filesystem restrictions"). That is why the pane says "paused" while a live, unrestricted PTY runs behind it.

2. ui/terminal.tsx:75-83: the "first time here" effect calls `create()` (ui/terminal.tsx:44-58, POST at :50) whenever the tab is shown, the list has loaded and no terminal is open. It never checks for a restriction. The `started` guard is only set when this effect runs, so if a remembered shell was already open at mount, closing it with × (`close`, ui/terminal.tsx:85-94) leaves `started.current !== s.key` and the effect starts a new shell. That is why the first × click respawns one.

3. src/server.ts:1616: activation refuses while `shells.list().length` is non-zero, and that count includes exited shells (src/shell.ts:144). The error does not name t …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filesystem-access.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/terminal.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/filesystem-policy.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/filesystem-policy.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/filesystem-policy.test.ts`

**Suggested fix:** (a) Server, which also fixes t23-1: in src/filesystem-access.ts:61, change "shells" to "shell" (or gate `parts[1] === "shell"` explicitly). GET /api/shell then returns 403 and POST returns 409 under any custom restriction. Exempt DELETE /api/shell/:id, because closing only reduces authority and must never be blocked.

(b) UI: in TerminalTab, track a "paused" state when GET /api/shell returns 403/409; today `refresh` swallows the error. While paused, skip the auto-start effect and show "Terminals are paused under filesystem restrictions" instead of "Loading…". Also set `started.current = s.key` when the first-show effect finds terminals already open, so closing the last terminal never auto-starts a new one.

(c) Policy editor: at src/server.ts:1616, count only running shells and put the blocking terminals (count and cwd) in the 409. In ui/filesystem-policy.tsx, offer a "Close N terminals" action (DELETE each) next to the error, or let activation close idle, non-busy shells itself.

**Suggested regression test:** 1. test/e2e/filesystem-policy.e2e.ts already starts a server with a saved restriction. Add these assertions: `fetch(base+'/api/shell',{headers})` returns 403. POST /api/shell with {cwd: repo, pty:true} and with {cwd: unrestrictedRepo, pty:true} both return 409. POST /api/shell/x/input returns 403/409. Afterwards no shell exists.

2. test/filesystem-policy.test.ts: add a table test that calls FilesystemAccess.ownerGate with a restrictive policy cached for ["api","shell"] with GET (expect FilePoli …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4609 on port 4609. The old v4609 home was moved aside to homes/v4609.prev-t23-2 first. I made a scratch git repo with a secrets/ dir at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4609/repo and drove everything in headless Chrome. Scripts and logs are s1-s5 .mjs/.log in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4609/.

(s1) I created project "v4609-t232" through the UI. GET /api/shell returned []. In Settings → Projects → Filesystem policy I set Read deny "secrets" and clicked "Stop execution and apply policy". Result: "Filesystem policy revision 1 applied.", and there were still 0 shells.

(s2) I opened the project page, then the side panel, then the Terminal tab. The browser sent POST /api/shell and got 201 back (shell shmvog5ezc2c7d, interactive, cwd = the restricted repo). The pane showed "[Terminals are paused under filesystem restrictions]" next to a visible "repo ×" chip (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4609/001-terminal-tab-under-restriction.png). I reloaded twice with the panel still open: the same shell was reused and no new one appeared.

(s3) In Settings I cleared Read deny, leaving no restriction at all, and clicked apply. The UI showed "Close terminals and stop development services before changing filesystem policy Your draft is kept." and the policy did not change (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4609/001-clear-policy-blocked.png). The Settings page has no hint that a terminal exists. I then ran DELETE /api/shell/<id> and reloaded the project page: a new shell (shmvog6auna3bd) was created at once. That is the cause of the report's "every page load spawns a shell": a load only creates one after the previous shell was closed, otherwise it reuses the running one.

(s4/s5) New finding: the reporter's × workaround is unreliable. On a page load where the remembered shell already exists, the first × click closes it and the tab immediately starts another one (shmvog6auna3bd → shmvog8oq44b42, and later shmvog8oq44b42 → shmvog9i8cfdb2). The second × sticks. After that and closing the panel, clearing the policy worked ("revision 2 applied", 0 shells).

Root …

</details>

### t08-3 · minor · Visible Terminal tab keeps reopening shells, so a filesystem policy can't be applied ('Close terminals…' 409)

**Fix outcome: duplicate.** Fixed with t23-2 in ui/terminal.tsx. The first-visit effect now marks a scope as seen whenever it is shown with its list loaded, including when terminals are already open. close() remembers shellsClosed in SideMemory (ui/state.ts) so it survives reloads. Closing the last terminal leaves a 'No terminal is open here. Open a terminal' state instead of reopening one. docs/runs.md documents this.

Fixer's check: r3 on f00 followed the tester's flow. The page opened a shell; I reloaded, the same pill came back, and I clicked × once. The only request was DELETE; there was no POST in the next 5 s, 0 running shells remained, and the pane showed 'No terminal is open here. Open a terminal'. For A→B→A, B opened its shell and A stayed empty; × on B also didn't reopen. A restrictive policy then applied (revision 3). The e2e test covers both flows; its run and two reruns passed.

Tests: `test/e2e/qa-fs-policy-gate.e2e.ts`

Source: tester unit side-panel-previews-1; observed with fake-agents; features SIDE-13.

**Repro**

> 1. With the side panel open on the Terminal tab, close every shell (× on each, or DELETE /api/shell/:id).
> 2. Go to Settings → Projects and apply a restrictive filesystem policy.

**Expected:** Once I close the terminals, the policy applies, or the panel stops reopening a shell while a policy change is pending.

**Actual:** The Terminal tab's first-shell effect creates a new shell as soon as the tab is shown with no live shells. Apply then fails with 409 'Close terminals and stop development services before changing filesystem policy'. It worked only after I switched the panel to Notes, closed it, and closed the shells again.

**Root cause (verifier):** ui/terminal.tsx:73-82, the "first time here" effect. Line 76 is `if (!shown || !list || open.length || started.current === s.key) return;`. `started.current` is set (line 79) only when the effect itself opens or adopts a shell. If the tab mounts with live shells already in this scope (a page load/reload, a new window, or the component remounting after sideScope.waiting), the effect returns early on `open.length` and `started` stays "". The same happens when you return to a scope you visited before: `started` holds only the most recently started key, so A→B→A leaves it at B. When the user then closes the last shell, `open.length` drops to 0, either through close() at ui/terminal.tsx:85-94 or through the 3 s poll after an external DELETE. The guard no longer matches, so the effect treats the empty scope as "first time here" and calls create(cwd) → POST /api/shell. The server correctly refuses policy changes while any shell exists (src/server.ts:1616, `shells.list().length` → 409), so the reopened shell blocks activation. The behaviour is not by design. docs/runs.md:98 says "The first one opens when you show the tab", and the code comment says "The first time here". Closing the last t …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/terminal.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/filesystem-policy.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Make auto-open a once-per-scope event that is recorded whenever the scope is first seen with the tab shown, not only when the effect creates a shell. In the effect, once `shown && list` are ready, mark the scope as started (a Set of keys, or a `started` flag kept in SideMemory via rememberSide so it survives reloads) before the `open.length` check. Do this even when shells already exist. Also have close() mark the scope as deliberately emptied (for example `rememberSide({ shells: [], closedAll: true })`) so nothing reopens a shell until the user presses + or Split. Reset the flag when the user opens a terminal.
Replace the "Opening a shell…" placeholder in the deliberately-empty state with an empty state that has an "Open a terminal" button (ui/terminal.tsx:142).
Optional UX hardening: while a restrictive filesystem policy is pending, or whenever the server reports a restriction, skip auto-open. In ui/filesystem-policy.tsx, turn the 409 into an actionable message: list the open shells  …

**Suggested regression test:** Add a case in test/e2e/ui.e2e.ts next to the "side panel: ... terminals" test, using fake agents and a temp repo:
1. Open the project page with the panel on Terminal and wait for the first `.sess`.
2. Call page.reload() and wait for the same pill, so the mount starts with live shells.
3. Click every `#side-pane-terminal button.sess-x` once and wait about 4 s (longer than the 3 s poll).
4. Assert GET /api/shell returns [] and that no POST /api/shell happened after the DELETE (use page.on('request …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4673 on 127.0.0.1:4673 (previous v4673 home moved aside, fresh browser profile). Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4673/ (r1-r4.mjs, logs r*.log). Screenshots are in .../scratchpad/qa/shots/v4673/.
(r1) Control case: on #/project/MQTT-MCP I opened the side panel and showed Terminal. The first shell opened, which is by design. I closed it with ×. After 8s there were 0 shells, so the guard works when this same mount opened the shell. The pane then shows "Opening a shell…" forever (002-p1-after-close.png). The policy applied (revision 1).
(r3) Exact user flow, after resetting the policy: page load on the MQTT-MCP project opened shell shmvo83ja1e74f. I reloaded the page; the panel came back on Terminal with 1 pill. I clicked × once on that pill. The browser sent DELETE /api/shell/shmvo83ja1e74f and, 100 ms later, POST /api/shell. A new shell shmvo83q8od30c appeared as a new MQTT-MCP pill (001-r3-after-x.png). I went to #/settings/projects, picked MQTT-MCP, set Read deny "npm" and clicked "Stop execution and apply policy". The response was HTTP 409 {"error":"Close terminals and stop development services before changing filesystem policy"} and the UI alert read "...filesystem policy Your draft is kept." (002-r3-apply-409.png). On the Settings page the side panel follows "No repository chosen" and shows "Choose a repository first." with no pills, so the user cannot see or close the shell that blocks them.
(r4) No reload needed: I went project A (MQTT-MCP, shell opened), then project B (OPCUA-MCP, shell opened), then back to A. Clicking × on A's only pill sent DELETE and then immediately POST /api/shell in MQTT-MCP, and a new pill appeared.
(r2) Clicking × a second time on the replacement shell sticks, and then the policy applies. That matches the reporter's workaround.
I created no runs. All shells were closed, the policy was reset to unrestricted, and the server is stopped with ports 4673/4675 free.

</details>

### t09-18 · minor · /api/frame-policy has no UI and bypasses the filesystem-restriction gate that covers preview and snapshot

**Fix outcome: fixed.** Removed the dead endpoint: the /api/frame-policy route and import in src/server.ts, src/frame-policy.ts (inspectFramePolicy/embeddingBlocked had no other users), and its helper tests in test/app-preview.test.ts. The route classification also makes any future unclassified route fail closed under a restriction.

Fixer's check: On f00, POST /api/frame-policy returns 404 with no restriction and 409 under one, for both /api and /api/v1 (refused before any handler, so no outbound HEAD). grep finds no frame-policy references left in src, ui, docs or tests. The route-scan unit test asserts it is gone.

Tests: `test/qa-fs-policy-gate.test.ts`

Source: tester unit side-panel-previews-2; observed with code-reading; features SIDE-33.

**Repro**

> Code reading: src/filesystem-access.ts:61 lists 'preview' and 'snapshot' in globalPrivate but not 'frame-policy'. The route at src/server.ts:2313 makes outbound HEAD requests (verified over the API to example.com and github.com).

**Expected:** Removed if dead, or gated like preview and snapshot.

**Actual:** Callable while 'Custom filesystem restrictions pause app-managed execution…' blocks the others.

**Root cause (verifier):** The gate:
- src/filesystem-access.ts:61, in FilesystemAccess.ownerGate, `globalPrivate` is a hand-maintained deny-list of route names. It has "serve", "preview" and "snapshot" but not "frame-policy".
- The `execution` list on line 62 doesn't cover it either. So under a global restriction, ownerGate falls through for POST /api/frame-policy.

The route:
- src/server.ts:2313-2317 handles `parts[1] === "frame-policy"` with no gate of its own. Contrast /api/browser at src/server.ts:1644, which checks `fileAccess.hasRestrictions()`.
- It calls inspectFramePolicy (src/frame-policy.ts:31-58), which resolves DNS and sends an outbound HEAD request from the server.

Why it's dead:
- Its only UI consumer was removed from the side panel in commit 29628ea ("Add desktop Agent and Team workspace…"), when PageFrame and the frame-blocked iframe fallback were replaced by the live in-app browser.
- The endpoint and src/frame-policy.ts's inspectFramePolicy were left behind with no caller.

Contributing design issue: globalPrivate is a deny-list, so any new or orphaned top-level route is ungated by default.

Side note from reading the code, not exercised: inspectFramePolicy only refuses loopback/link-lo …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/frame-policy.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filesystem-access.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/app-preview.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/history-launch.e2e.ts`

**Suggested fix:** Preferred: remove the dead endpoint.
- Delete the `frame-policy` route at src/server.ts:2313-2317 and the `inspectFramePolicy` import at src/server.ts:65.
- Delete inspectFramePolicy from src/frame-policy.ts.
- Keep embeddingBlocked only if something still uses it; otherwise delete the module and the matching cases in test/app-preview.test.ts.

If the endpoint is meant to stay for a future UI:
- Add "frame-policy" to `globalPrivate` in src/filesystem-access.ts:61, next to "preview" and "snapshot".
- Or mirror the /api/browser check: `if (fileAccess.hasRestrictions()) throw new HttpError(403, …)`.
- Also consider refusing RFC1918/ULA addresses in inspectFramePolicy.

Longer term, consider an allow-list (or a per-route `restrictionSafe` flag) for routes callable under a global restriction, instead of the deny-list, so orphaned or new routes fail closed.

**Suggested regression test:** In test/e2e/history-launch.e2e.ts, in the test "filesystem policy enforces scoped app reads/writes and globally blocks execution until explicitly removed", around line 345, add "/frame-policy" to the existing loop over ["/runs", "/readiness", …, "/preview", "/snapshot", …].
- If the route is gated, assert status 409 under the restriction, for both /api and /api/v1. Use a loopback body such as {url:"http://127.0.0.1:1/"} so the test never makes an outbound request: today that returns 400, after t …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server: qa-server.sh start v4675 4675 fake, after moving an old v4675 home with a leftover policy aside to homes/v4675-prev-*. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4675/t09-18-frame-policy.mjs, log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4675/t09-18.log.

Steps and results:
(1) Baseline with no policy: POST /api/frame-policy {url:"http://127.0.0.1:1/"} returned 400 "External page inspection cannot reach loopback…". POST /api/preview returned 200.
(2) Through the UI (Settings > Projects > MQTT-MCP > Filesystem policy) I set Read deny = "qa-secret-dir" and clicked "Stop execution and apply policy". The page showed "Filesystem policy revision 1 applied." (screenshot 001-t09-18-policy-applied.png).
(3) Under that restriction:
- POST /api/preview: 409 "Custom filesystem restrictions pause app-managed execution and unscoped private data access globally…"
- POST /api/snapshot: 409 (same message)
- GET /api/serve: 403 (same message)
- GET /api/browser?scope=none: 403 "Interactive browsing is paused under filesystem restrictions"
- POST /api/frame-policy: not gated.
  - With loopback: still 400 from inspectFramePolicy itself, not the gate.
  - With https://example.com/: 200 {blocked:false,url:"https://example.com/"}, so a real outbound HEAD went out while the restriction was active.
  - With https://github.com/: 400 "The operation was aborted", the 5 s HEAD timeout. That is network variance, but it also shows the request passed the gate.
(4) No UI caller:
- `grep -rl frame-policy` finds nothing in ui/ or in the built public/ bundle. public/assets/chunk-TK6JP642.js does contain /api/snapshot.
- The page made 0 requests to /api/frame-policy while I loaded the app and opened the side panel under the restriction.
- git history: the only caller (PageFrame in the side panel, `post("/api/frame-policy", { url })`) and its e2e mock were deleted in commit 29628ea, when the iframe browser was replaced by the live agent browser. Only test/app-preview.test.ts still imports inspectFramePolicy/embeddingBlocked, and it tests the functions directly, not the route.
(5) Cleared the policy through the same UI (revision 2, unrestricted). /api/preview returned 200 again. Server stopped, ports 4675-4677 free, 0 runs created.

Refutation attempts:
- Not by design: docs/filesystem-policy.md says  …

</details>

### S15-7 · minor · POST /api/frame-policy has no UI caller and no route-level test, makes outbound HEAD requests, and is missing from the filesystem-restriction lists. It looks orphaned.

**Fix outcome: duplicate.** Same fix as t09-18: the orphaned route and module were removed.

Fixer's check: Same as t09-18.

Tests: `test/qa-fs-policy-gate.test.ts`

Source: code-level suspect at `src/server.ts:2313` (confirmed hands-on).

**Repro**

> QA server s15. grep finds no '/api/frame-policy' in ui/ (removed in 29628ea, diff lines -post("/api/frame-policy"...)). POST /api/frame-policy {url:'http://127.0.0.1:4317/'} → 400 loopback refusal (no connection). {url:'http://192.0.2.1/'} → 400 'The operation was aborted' after 5005 ms, an outbound HEAD attempt. Created scratch project p-88fca8d2 (QA home only) and PUT a restrictive filesystem policy (read deny ['secret']). POST /api/snapshot → 409 'Custom filesystem restrictions pause app-managed execution...', GET /api/journeys → 403 with the same message, but POST /api/frame-policy {url:'http://192.0.2.1/'} → still attempted (400 after 5003 ms, not 409). The policy was reverted afterwards. (Script: qa/work/s15/s6-frame.mjs)

**Expected:** Either the route is removed with its caller, or, if kept, it pauses under restrictions like snapshot/preview and has a route-level test.

**Actual:** The route is live with no caller, makes outbound requests even under filesystem restrictions, and is covered only by a unit test of the helper.

**Root cause (verifier):** The only UI caller (PageFrame in the Browser panel, which posted /api/frame-policy for external URLs) and its e2e route mock were removed in commit 29628ea ('Add desktop Agent and Team workspace...') when the panel moved to the live in-app browser. The server route and inspectFramePolicy were left behind. src/filesystem-access.ts ownerGate lists 'snapshot', 'preview', 'journeys' and others in globalPrivate, but not 'frame-policy'. Under a custom filesystem restriction, the outbound page-fetching snapshot route is therefore paused while this outbound HEAD route keeps working. inspectFramePolicy blocks only loopback and link-local addresses (addressKind), so private LAN addresses are reachable (owner-only).

**Suggested fix:** Delete the /api/frame-policy route and src/frame-policy.ts (and the corresponding app-preview.test.ts cases) unless a near-term caller is planned. If it is kept, add 'frame-policy' to the globalPrivate list in filesystem-access.ts and add a route test.

**Suggested regression test:** Route test: with a restrictive policy active, POST /api/frame-policy returns 409 (or 404 once removed). Static check: every /api route under parts[1] has either a UI caller or an entry in docs/api.md.

### t04-4 · minor · Under a filesystem restriction Health dialog and Agents settings spin on 'Checking…' forever and tell the user to install CLIs

**Fix outcome: fixed.** Server (src/server.ts): GET /api/agents adds unavailableReason:'filesystem-policy' under a restriction, and GET /api/projects marks filesystemRestricted. FilesystemAccess.pauseMessage() replaces the jargon refusal with plain words that name the project and point to Settings → Projects. ui/state.ts adds executionPaused (computed from agents) and healthError; loadHealth and loadModels skip refused probes. The new ui/policy-pause.tsx notice names the project and links to its policy. ui/settings.tsx cards show 'Paused by filesystem policy' instead of 'Checking health…' and 'Install this CLI'. ui/app.tsx HealthDialog shows the notice, or the error, never an endless 'Checking…'. ui/rail.tsx subtitle reads '3 providers · paused by filesystem policy' instead of 'need setup'. ui/prompt-improvement.tsx shows the paused label instead of 'Not installed'.

Fixer's check: r2 on f00 under the restriction, with UI rebuilt. #/settings/agents had no 'Checking health…', 'Install this CLI' or 'Not installed', and 3 'Paused by filesystem policy' badges, still true after Refresh providers. The notice read 'Provider checks and agent runs are paused: project “QA Alpha”…'. The Health dialog had no 'Checking…' and showed 'Provider health checks are paused…'. The app menu read '3 providers · paused by filesystem policy'. Screenshots are in qa/shots/f00. The only browser console errors are by-design one-off 403s for /api/team-rollout and /api/experience at boot.

Tests: `test/qa-fs-policy-gate.test.ts`, `test/e2e/qa-fs-policy-gate.e2e.ts`

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-13, SOL-14.

**Repro**

> 1. Apply any restrictive project filesystem policy (as in t04-3 step 2).
> 2. App menu → 'Agents & usage'.
> 3. Open #/settings/agents and click Refresh providers.

**Expected:** A clear message that provider health is unavailable while a filesystem restriction is active (403 explained).

**Actual:** Health dialog shows only 'Checking…' indefinitely (403 swallowed). Settings cards show 'Checking health…' and 'Install this CLI on the current machine to configure its models.' for installed CLIs. Screens: shots/t04b/001-policy-agents.png, 002-policy-health.png.

**Root cause (verifier):** The server deliberately blocks these routes. src/filesystem-access.ts:61 puts "doctor" and "models" in the globalPrivate list, so GET /api/doctor, /api/doctor/git and /api/models return 403 whenever any project has a restriction. src/server.ts:1894 makes GET /api/agents return every adapter with available:false under a restriction, with no reason field. The UI cannot tell "blocked by policy" apart from "still loading" or "not installed":
- ui/state.ts:696-700 loadHealth uses Promise.allSettled and sets health.value = null on any rejection. The ApiError (status 403 and the server's message) is dropped, and there is no error or reason signal.
- ui/app.tsx:511 HealthDialog renders "Checking…" whenever health.value is falsy. Null means both "loading" and "failed", so it spins forever. git is also blocked by the 403 and is hidden silently.
- ui/settings.tsx:121 AgentSettings shows the badge "Checking health…" when there is no health entry, and "Install this CLI on the current machine to configure its models." whenever agent.available is false. That is wrong under a policy, because the CLIs are installed and only paused.
- ui/rail.tsx:170 counts each !agent.available as a problem, so the …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/rail.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/types.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`

**Suggested fix:** Keep the server-side blocking as it is; it is documented policy. Fix how the UI reports it:
(1) src/server.ts:1894: under hasRestrictions(), add a reason to each /api/agents entry, e.g. `unavailableReason: "filesystem-policy"`, and add the optional field to AgentInfo in ui/types.ts.
(2) ui/state.ts loadHealth: add `healthError = signal<{status:number; message:string} | null>` and `healthLoading`. On a rejected /api/doctor, store the ApiError's status and message instead of only setting null, and clear it on success.
(3) ui/app.tsx:511 HealthDialog: show "Checking…" only while a request is in flight. On a 403, render a msg warn such as "Provider health is unavailable while a project filesystem restriction is active. Clear the restriction in Settings > Projects to check CLIs again." and link to #/settings/projects. On other errors, show the server message with Check again.
(4) ui/settings.tsx:121: when agent.unavailableReason === "filesystem-policy" (or healthError is a 403), show a neut …

**Suggested regression test:** Add an e2e case to test/e2e/filesystem-policy.e2e.ts (or test/e2e/settings.e2e.ts) that starts a server with a saved restrictive policy (e.g. read deny ["secrets"]) and then:
(a) goes to #/settings/agents and asserts that no card contains "Install this CLI" or "Checking health…" and each provider card contains "filesystem" (the paused message);
(b) opens App menu > Agents & usage and, within 5 s, asserts that dialog.health does not contain "Checking…" and does contain "unavailable while a projec …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4673 on 127.0.0.1:4673 (new home, no runs). Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4673 (r1.mjs, r2.mjs; logs r1.log, r2.log, r2-fresh.log).
1) Baseline with no restriction. #/settings/agents showed all three cards as "Signed in" with model rows. The Health & usage dialog listed Claude Code, Codex, Antigravity and git OK. /api/agents, /api/doctor, /api/doctor/git and /api/models all returned 200.
2) Applied a restriction through the UI. In Settings > Projects I picked MQTT-MCP (p-ef01794b), set Read deny paths to "secrets" and clicked "Stop execution and apply policy". The panel showed "Filesystem policy revision 1 applied."
3) Reloaded and went to #/settings/agents. All three cards (Claude Code, Codex, Antigravity CLI) show the badge "Checking health…" and the text "Install this CLI on the current machine to configure its models." Clicking Refresh providers changed nothing. Network: /api/agents returned 200 with available:false for every agent. /api/models, /api/doctor and /api/doctor/git returned 403 {"error":"Custom filesystem restrictions pause app-managed execution and unscoped private data access globally because current backends share host authority"}.
4) In the App menu, the "Agents & usage" subtitle read "3 providers · 3 need setup". Clicking it opened the Health dialog, which still showed only "Checking…" after 15 s and again after "Check again". The 403s are repeated on each check and the server's message is never shown. Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4673/001-policy-agents.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4673/002-policy-health.png.
5) Repeated steps 3-4 in a fresh browser profile with the same result (001-fresh-policy-agents.png, 002-fresh-policy-health.png in the same folder). So the tester's profile is not the cause, and fake vs real CLIs does not matter, because the server never runs the CLIs under a restriction.
Attempts to refute it: blocking the endpoints is by design. docs/filesystem-policy.md says diagnostics are unavailable while any custom restriction is active and that health avoids provider probes, and filesystem-access.ts lists "doctor" and "models" as globally private. Nothing in the docs or code comments …

</details>

### t05-11 · minor · Under a restrictive filesystem policy, Agents settings stays on 'Checking health…' forever and Check this computer shows an internal-jargon error

**Fix outcome: duplicate.** Fixed with t04-4, plus the plain-language refusal message from FilesystemAccess.pauseMessage(), which names the project and links to Settings → Projects. ui/dependency-health.tsx shows the notice and disables 'Check all dependencies' while paused.

Fixer's check: r2: under Check this computer the button is disabled and the notice names “QA Alpha”. Under the restriction, POST /api/acp-connections/check (409) and GET /api/doctor/dependencies (403) now return 'Paused by the filesystem restriction on project “QA Alpha”… Review it in Settings → Projects.' instead of the 'share host authority' text.

Tests: `test/qa-fs-policy-gate.test.ts`, `test/e2e/qa-fs-policy-gate.e2e.ts`

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOL-15.

**Repro**

> 1. On a fake QA server with no browser tab open, PUT /api/projects/<id>/filesystem-policy {revision, read:{allow:['.'], deny:['secrets']}, write:{allow:['.'], deny:[]}}.
> 2. Open #/settings/agents. Every provider card shows 'Checking health…' indefinitely: /api/health and /api/models return 403.
> 3. Open 'Check this computer' → 'Check all dependencies': it shows 'Custom filesystem restrictions pause app-managed execution and unscoped private data access globally because current backends share host authority'.
> 4. 'Check <ACP>' shows the same text.

**Expected:** A clear statement that a project's filesystem policy pauses provider checks, naming the project and linking to Settings → Projects to review it. Provider cards should show that state rather than an endless loading label.

**Actual:** An endless loading label and an opaque message.

**Root cause (verifier):** The server blocks these routes on purpose, but the UI has no state for a policy-blocked response, so it treats the failure as "still loading" or "not installed".

- **src/filesystem-access.ts:61-63:** when any project policy is restrictive, `globalPrivate` includes "models" and "doctor", so every /api/doctor* and /api/models GET throws `FilePolicyError` with the generic host-authority message (403, or 409 for non-GET such as POST /api/acp-connections/check). The response body is only {error:string}. It has no machine-readable code and does not say which project is restricted.
- **src/server.ts:1894:** under a restriction, /api/agents returns `available:false` for every adapter. The UI cannot tell "paused by policy" apart from "not installed".
- **ui/state.ts:696-699 (`loadHealth`):** uses `Promise.allSettled` and sets `health.value = null` on rejection, discarding the error.
- **ui/settings.tsx:120-121:** renders "Checking health…" whenever the provider's status is undefined, so a 403 looks like loading forever. When `agent.available` is false it renders "Install this CLI on the current machine…".
- **ui/app.tsx:511 (HealthDialog):** shows "Checking…" when `!health.value`.
- **ui/d …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filesystem-access.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/dependency-health.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/acp-connections.tsx`

**Suggested fix:** 1. **Server:** give the global-restriction `FilePolicyError` (filesystem-access.ts:63) a stable `code` such as "filesystem_restricted" and list the restricted projects, e.g. `restrictedProjects:[{id,name}]` from the cached policies where `policyIsRestrictive` is true. Pass these through the `HttpError` into the JSON body. Optionally rewrite the message in plain language: "Filesystem restrictions on project MQTT-MCP pause provider checks and agent execution on this computer. Review them in Settings → Projects." Also expose `restricted:true` on /api/agents (server.ts:1894) so the UI can tell this case apart from "not installed".
2. **UI state:** in `loadHealth`, keep the rejection and add a `healthBlocked` signal (or store `{blocked, projects}`) instead of collapsing it to null.
3. **Settings → Agents:** when blocked, show one `msg warn` banner above the provider cards naming the projects, with a link to #/settings/projects. Give each card a "Paused by filesystem policy" badge instead of …

**Suggested regression test:** 1. **Server, test/server-reliability.test.ts (or a new test/filesystem-access.test.ts):** apply a restrictive policy to a fixture project. Assert GET /api/doctor returns 403 with body.code === "filesystem_restricted" and body.restrictedProjects containing that project's id and name. Assert /api/agents marks restricted:true. Assert /api/health stays 200.
2. **UI, a new e2e (e.g. test/e2e/filesystem-policy-settings.e2e.ts, beside test/e2e/filtered-tasks.e2e.ts):** PUT a restrictive policy, open #/ …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server, v4621 on 127.0.0.1:4621, with a new QA home. Before any policy, /api/doctor, /api/doctor/git, /api/doctor/dependencies, /api/models and /api/health all returned 200. With no browser open I sent PUT /api/projects/p-ef01794b/filesystem-policy (MQTT-MCP) with {revision:0, read:{allow:['.'],deny:['secrets']}, write:{allow:['.'],deny:[]}} and got revision 1. After that:
- /api/doctor, /api/doctor/git, /api/doctor/dependencies and /api/models return 403 with "Custom filesystem restrictions pause app-managed execution and unscoped private data access globally because current backends share host authority".
- /api/health still returns 200. The reporter was wrong to list it as a 403; the call that fails is /api/doctor.
- /api/agents returns 200, but every agent has available:false.

Fresh headless Chrome, no saved profile (scripts /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4621/r1.mjs and r2.mjs, logs r1.log and r2.log):
(1) On #/settings/agents, after 12 s every provider card (Claude Code, Codex, Antigravity CLI) still showed "Checking health…". Each card also said "Install this CLI on the current machine to configure its models", and the Prompt improvement section said "Claude Code · Not installed". The fake CLIs are installed, so both messages are wrong. Clicking "Refresh providers" changed nothing. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4621/001-agents-12s.png
(2) Check this computer → Check all dependencies showed only the jargon message in red. It names no project and has no link. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4621/002-deps.png
(3) Connect OpenCode → Check connection: POST /api/acp-connections/check returned 409, and the panel's alert showed the same text.
(4) Additional finding: the Health & usage dialog stayed on "Checking…" after 8 s.
(5) Settings → Projects shows no notice that MQTT-MCP's policy is causing any of this.

Why this is not by design or environmental: docs/filesystem-policy.md:15 says blocking provider probes is intended ("Health responses avoid Python/provider probes under a restriction"). Nothing in the docs or comments covers how the UI should show that. Other panels already handle the same state gracefully: ui/host-execution.t …

</details>

### t08-4 · minor · Browser tab under a filesystem policy shows 'Starting your browser…' forever instead of the 403 reason

**Fix outcome: fixed.** ui/interactive-browser.tsx, with the diff kept small and only the 403 display added. When executionPaused is set, the panel opens no EventSource and does not poll /api/serve; it shows the pause notice, the toolbar reads 'Browser unavailable', and Go, new tab and Take control are disabled. If a policy applied elsewhere makes the stream close (readyState CLOSED), it probes GET /api/browser/control once, shows the 4xx reason, stops polling and re-probes every 15 s. Clearing the policy in the app reconnects immediately.

Fixer's check: r2 (restriction known at boot): the Browser tab showed 'Interactive browsing is paused: project “QA Alpha”…' and 'Browser unavailable', Go was disabled, and there were 0 /api/serve or /api/browser requests over 12 s. r4 (tester's Run B): with the panel connected ('Live browser · shared with agents'), I applied a policy through the API. Within 5 s the panel showed 'Browser unavailable' and 'Interactive browsing is paused under filesystem restrictions', with 0 serve/browser requests over the next 12 s. I lifted the policy through the API and it reconnected to 'Live browser · shared with agents' without a reload.

Tests: `test/e2e/qa-fs-policy-gate.e2e.ts`

Source: tester unit side-panel-previews-1; observed with fake-agents; features SIDE-16.

**Repro**

> 1. Apply a restrictive filesystem policy (as in t08-2).
> 2. Open side panel → Browser.

**Expected:** A message such as 'Interactive browsing is paused under filesystem restrictions' (the server's 403 text).

**Actual:** The toolbar says 'Connecting to Chrome…' and the page says 'Starting your browser…' indefinitely. Meanwhile the panel polls /api/serve every 3-5s, getting 403 each time (console error spam).

**Root cause (verifier):** The server correctly rejects the requests. src/server.ts:1644 throws HttpError(403, "Interactive browsing is paused under filesystem restrictions") for every /api/browser* request, including GET /api/browser/events, whenever fileAccess.hasRestrictions() is true. src/filesystem-access.ts:61-63 also puts "serve" in globalPrivate, so GET /api/serve returns 403.

The client does not handle that 403:
- ui/interactive-browser.tsx:59-75: the EventSource effect only handles messages. Under the EventSource spec, a non-200 response fails the connection permanently: readyState becomes CLOSED, the browser does not reconnect, and the error event carries no status or body. The handler at line 73 (`events.onerror = () => setConnected(false)`) records nothing else. So `state` stays undefined, the toolbar at line 174 renders "Connecting to Chrome…", and the surface at line 188 renders "Starting your browser…" indefinitely.
- The effect's deps are only [visible, scope], so nothing re-opens the closed EventSource after the policy changes or is lifted. That explains the stuck panel in Run B.
- `error` is only set by send() (lines 49-50), so the 403 text appears only after a user action. Even then, lin …

**Files:** `ui/interactive-browser.tsx`, `ui/terminal.tsx`, `ui/lib.ts`, `src/server.ts`, `test/e2e/filesystem-policy.e2e.ts`

**Suggested fix:** In ui/interactive-browser.tsx:
1. Add a `blocked` state, e.g. `{message: string} | undefined`. In `events.onerror`, check `events.readyState === EventSource.CLOSED`, which means the connection failed with a non-200 status. In that case, probe the reason with a cheap request that returns the same 403 body, such as `api(`/api/browser/control?scope=…`)` (GET returns control state when allowed). On ApiError with status 403, 404 or 400, set `blocked` to err.message and stop.
2. When `blocked` is set, render the toolbar status as "Browser unavailable" instead of "Connecting to Chrome…". Replace "Starting your browser…" in the surface with the server's message (role=status or alert), plus a hint that links to Settings → Projects & access for filesystem policy. Disable Take control, Go and new-tab while blocked.
3. Let the panel recover. Re-run the EventSource effect from a `retry` counter: bump it on a backoff timer (for example 15-30 s) while blocked, or on window focus or tab re-selection.  …

**Suggested regression test:** Add a browser case to test/e2e/filesystem-policy.e2e.ts, or to test/e2e/shared-browser.e2e.ts:
1. Start the fake server with a saved restrictive policy (read deny "packages"). Open the app, open the side panel and click #side-tab-browser.
2. Assert that within 5 s `#side-pane-browser` contains the text "Interactive browsing is paused under filesystem restrictions".
3. Assert the toolbar `[role=status]` does not contain "Connecting to Chrome" and the surface does not contain "Starting your browse …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4675 on 127.0.0.1:4675 with a clean home (no runs, no policies). Browser was a fresh headless Chrome with no profile. Scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4675/repro.mjs and live.mjs. Logs are repro.log and live.log in the same folder.

Run A (UI only):
1. Settings → Projects → MQTT-MCP. Set Read deny paths to "npm" and click "Stop execution and apply policy". Result: "Filesystem policy revision 1 applied."
2. Direct API checks: GET /api/serve → 403 "Custom filesystem restrictions pause app-managed execution…". POST /api/browser → 403 "Interactive browsing is paused under filesystem restrictions". GET /api/browser/events → 403.
3. Home → Side panel → Browser tab, then waited 25 s. The toolbar status said "Connecting to Chrome…", the surface said "Starting your browser…", and there was no alert. Network: GET /api/browser/events → 403 once (the EventSource never retried) and GET /api/serve → 403 five times (every 5 s). Each 403 logged a "Failed to load resource: 403" console error. Screenshot: shots/v4675/002-browser-under-policy-25s.png.
4. Typed example.com and clicked Go. POST /api/browser → 403, and only now the red alert "Interactive browsing is paused under filesystem restrictions" appeared. The toolbar still said "Connecting to Chrome…" and the surface still said "Starting your browser…", contradicting it (shots/v4675/003-browser-under-policy-after-go.png).
5. Control: cleared the deny list (revision 2) and reopened the Browser tab. The toolbar showed "Live browser · shared with agents", the start page rendered, and /api/serve returned 200.

Run B (Browser panel already open; policy changed through the API as a precondition):
1. The panel was connected ("Live browser · shared with agents").
2. Applied deny ["npm"] (revision 3). The server ended the events stream, the reconnect got 403 once, and the toolbar became "Connecting to Chrome…" while the stale "No website open" page stayed visible. No reason was shown.
3. Lifted the policy (revision 4). After 15 s the panel was still stuck on "Connecting to Chrome…", even though /api/serve was back to 200. Recovery needs the user to close and reopen the tab or change scope (shots/v4675/003-live-policy-lifted-while-open.png).

Refutation checks:
- Not caused by the tester's environment: fresh profile, scope "none" and project scope hit the same server check, which runs before scope handling …

</details>

### t23-8 · minor · Under a restriction in one project, other projects' composer shows greyed providers with no explanation

**Fix outcome: fixed.** ui/composer.tsx: startProblem returns 'Agent runs are paused by a project's filesystem restriction' before the 'Pick an agent' checks. The composer shows the PolicyPauseNotice naming the restricted project with a link to #/settings/projects (it pre-selects that project). Provider menu entries and team pills say 'Paused by filesystem policy' instead of nothing or 'isn't installed', and ui/chat-controls.tsx does the same instead of 'Not installed'. ui/connected-projects.tsx shows 'Filesystem restrictions pause connected projects' and stops its 15 s 409 poll for the local workspace.

Fixer's check: r2: with the restriction on QA Alpha, I opened the New run page for QA Beta. The notice read 'Agent runs are paused: project “QA Alpha” has a custom filesystem restriction…' and linked to #/settings/projects. Send was disabled with the title and problem 'Agent runs are paused by a project's filesystem restriction'. The provider menu listed each provider with 'Paused by filesystem policy'. The sidebar shows 'Filesystem restrictions pause connected projects', with no repeated /api/workspace-projects requests.

Tests: `test/e2e/qa-fs-policy-gate.e2e.ts`

Source: tester unit infra-platform-memory-ml-insights-1; observed with fake-agents; features PLAT-12.

**Repro**

> 1. Apply a custom filesystem restriction to project A.
> 2. Open New run for an unrestricted project B.

**Expected:** A notice saying execution is globally paused because of the filesystem policy in project A, with a link to the policy.

**Actual:** Send is disabled with 'Pick an agent for Agent'. 'Choose provider' lists Claude Code, Codex and Antigravity all greyed out, and the sidebar shows 'Connected projects unavailable'. Nothing mentions the policy, so the CLIs look broken.

**Root cause (verifier):** The server drops the reason, and the UI has no restriction state to read.
- src/server.ts:1894: GET /api/agents returns every adapter with available:false whenever fileAccess.hasRestrictions() is true. It sends no reason field, and no endpoint the UI loads exposes hasRestrictions() (src/filesystem-access.ts:18). /api/health (src/server.ts:1952-1954) has no such flag either.
- ui/composer.tsx:325-326: the provider Menu disables each entry with !entry.available and gives no reason. With nothing available, no role gets a default provider, so startProblem() returns "Pick an agent for ${role.label}" (ui/composer.tsx:555). That becomes the Send label and the message under the composer.
- ui/composer.tsx:969-970 (Run options role chips) reads "${displayName} isn't installed".
- ui/prompt-improvement.tsx:18-19 shows " · Not installed" from agents.available.
- ui/chat-controls.tsx:37 shows the sub-label "Not installed" for unavailable providers in the run thread.
- ui/connected-projects.tsx:24 catches the 409 "Filesystem restrictions pause connected projects" and replaces it with a generic "Connected projects unavailable".

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filesystem-access.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/main.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/prompt-improvement.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/connected-projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/types.ts`

**Suggested fix:** 1) Server (src/server.ts:1894): under hasRestrictions(), keep available:false but add unavailableReason: "filesystem-policy" to each entry. Also expose the restriction state through an endpoint the UI already loads, for example executionPaused: { reason: "filesystem-policy", projects: [{id, name}] }. The project list can come from FilesystemAccess's cache via a new restrictedProjectIds() helper beside hasRestrictions() in src/filesystem-access.ts. Project names and policy metadata are already allowed for the owner under a restriction, so this exposes nothing new.
2) UI: store that state in a signal (ui/state.ts loadAgents / ui/main.tsx boot). In startProblem (ui/composer.tsx), check it before the role and provider checks and return "Agent runs are paused while a custom filesystem policy is active in <Project A>". Show a notice in the composer with a link to #/settings/projects for that project.
3) Give disabled provider entries (composer.tsx:326, 969-970, chat-controls.tsx:37, prompt-i …

**Suggested regression test:** 1) Server: in test/filesystem-policy.test.ts, after applying a restrictive policy to project A, assert that GET /api/agents (and /api/v1/agents) entries have available:false with unavailableReason "filesystem-policy". Assert that the restriction-status payload lists A and not B. After the policy is cleared, assert the reason is gone.
2) Browser: in test/e2e/filesystem-policy.e2e.ts, restrict project A, open #/project/<B>/new and fill a task. Assert that a visible notice mentions the filesystem p …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: qa-server.sh start v4621t238 4621 fake. It used a new home, because the old v4621 home had state from an earlier verification. I drove it with Playwright from a fresh profile. Scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4621t238/r1.mjs, r2.mjs and r3.mjs, with logs next to them.
1) Baseline: opened #/project/p-52a3c516/new (IndustriStudio, project B). The composer showed "Claude Code · Default model", Send was enabled, and GET /api/agents returned available:true for claude, codex and agy (shot 001-baseline-composer-B.png).
2) Settings → Projects, chose MQTT-MCP (p-ef01794b, project A), set "Read deny paths" to "secrets", clicked "Stop execution and apply policy". The page showed "Filesystem policy revision 1 applied." B's policy stayed at revision 0 (allow ".", no deny).
3) GET /api/agents now returned 200 with available:false for all three. Reloaded B's New run page and typed a task. The provider control read "Choose provider". Send was disabled with the label "Pick an agent for Agent", and the same text appeared under the composer. The sidebar showed "Connected projects unavailable". The provider menu listed Claude Code, Codex and Antigravity CLI, all disabled with no title or reason. Run options were expanded too. None of the page text contained "filesystem", "policy", "restriction" or "paused" (shots 003-restricted-composer-B.png, 001-restricted-provider-menu-b.png, 002-restricted-run-options.png).
4) Settings → Agents & models goes further: its Prompt improvement section labels the installed fake CLIs "Claude Code · Not installed" (shot 003-settings-agents.png).
5) The server does have specific reasons, but the UI never shows them. POST /api/runs for B returned 409 "Custom filesystem restrictions pause app-managed execution ... globally". GET /api/workspace-projects returned 409 "Filesystem restrictions pause connected projects". GET /api/doctor returned 403.
Cleanup: cleared A's deny list through the same UI (revision 2), after which /api/agents showed available:true again. No runs were created (runs=[], no worktrees). I stopped the server, and ports 4621/4622 are free.
Not refuted: docs/filesystem-policy.md says pausing execution in every project under any custom restriction is intended. The panel help text in ui/filesystem-policy.tsx:12 says the same, but only on the policy page at the moment of applying. Nothing in the docs o …

</details>

### t23-9 · minor · Filesystem policy applies a global execution pause with no confirmation, and has no 'clear restrictions' action

**Fix outcome: fixed.** ui/filesystem-policy.tsx: the button is now 'Apply policy'. Going from unrestricted to restricted calls confirmAction ('Pause execution in every project?' / 'Apply restriction'), which lists what pauses. A restricted saved policy shows a warning and a 'Remove restrictions' button (confirmed) that restores allow '.' with no denies. An unchanged draft says 'No changes to apply'. Server: ProjectFilePolicies.unchanged() and FilesystemAccess.update() return the saved snapshot for identical rules, with no new revision and nothing paused or closed. docs/filesystem-policy.md is updated.

Fixer's check: r1: Apply showed the confirmation; Cancel sent 0 PUTs and the revision stayed 0. Accepting gave 'revision 1 applied' and a 'Remove restrictions' button. Re-applying gave 'No changes to apply: revision 1 already has these rules', still revision 1 with 1 PUT. r3: Remove restrictions → confirm → 'revision 2 applied', the saved rules were allow ['.'] with no denies, and agents were available again. The unit and e2e tests cover this as well.

Tests: `test/qa-fs-policy-gate.test.ts`, `test/e2e/qa-fs-policy-gate.e2e.ts`

Source: tester unit infra-platform-memory-ml-insights-1; observed with fake-agents; features PLAT-11.

**Repro**

> 1. Settings → Projects → any project → Filesystem policy: type one deny path → 'Stop execution and apply policy'.
> 2. Try to undo the restriction.

**Expected:** A confirmation that names the effect (all agents, terminals, services and automations across every project pause) before committing, and a one-click 'Remove restrictions'.

**Actual:** It applies immediately. To clear, the user must rewrite allow '.' and empty both deny lists by hand. Re-applying an identical policy also creates a new revision.

**Root cause (verifier):** - **No confirmation:** in ui/filesystem-policy.tsx:15 the form's onSubmit sends PUT /api/projects/:id/filesystem-policy directly. It never calls confirmAction (ui/confirm-state.ts:9), even when the draft takes the project from unrestricted to restricted. That transition pauses execution in every project and hides unscoped data such as stats, memory and notifications (see the check at src/filesystem-policy.ts:37 and the gate at :44-45).
- **No way to clear:** the actions row at ui/filesystem-policy.tsx:17 has only apply, reload-keep-draft and use-saved. Nothing resets the draft to the unrestricted default (allow ["."], deny [] for both read and write).
- **Identical saves create revisions:** src/filesystem-policy.ts:88 always builds snapshot(previous.revision + 1, ...) without checking whether the rules match the previous ones.
- **No-op saves have side effects:** src/server.ts:1617 still runs withIdleExecution, pausePolicyBackground() and previews.closeAll()/sshPreviews.closeAll() on an unchanged save. So re-applying an identical policy bumps the revision and closes all previews.
- **Misleading label:** "Stop execution and apply policy" stops nothing. Activation fails with 409 if a …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/filesystem-policy.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/filesystem-policy.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/history-launch.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/filesystem-policy.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/filesystem-policy.md`

**Suggested fix:** **UI (ui/filesystem-policy.tsx):**
- Add a small pure helper, `isRestrictive(rules)`, in the UI or a shared pure module. src/filesystem-policy.ts imports node:fs and crypto, so the UI cannot import it.
- In onSubmit, build `next` and compare it with `saved`:
  - If the rules are unchanged, show "No changes to apply" and skip the PUT.
  - If `next` is restrictive and `saved` is not, call `await confirmAction(...)` first. Suggested message: "Restrict file access for <project>? While any project has a restriction, all app-managed agents, terminals, setup/checks, development services, previews, automations, PR watches and notifications pause across every project, and unscoped history, stats and memory become unavailable. Runs already started keep their pinned policy." Use `{title: "Pause execution everywhere?", confirmLabel: "Apply restriction", danger: true}`.
  - Optionally use a lighter confirm when editing an already restrictive policy.
- Rename the button to "Apply policy", since acti …

**Suggested regression test:** **test/e2e/history-launch.e2e.ts (around lines 331-364)**
- After filling "Read deny paths" and clicking "Apply policy", assert that `page.locator("dialog.confirmation-dialog")` is visible and its text includes "every project".
- Click Cancel. Assert that no PUT was sent and that GET policy still shows revision 0.
- Click apply again and accept. Assert the status says "revision 1 applied".
- Replace the manual clear at line 364 with a click on "Remove restrictions" and accept the confirmation. A …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (v4623, port 4623, with a fresh home) and ran the Playwright script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4623/pol.mjs. Output is in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4623/pol.log. I used my own isolated browser profile, a registered project and the real UI selectors, so the tester's environment did not cause this.
1. Opened #/settings/projects and selected MQTT-MCP (p-ef01794b). The policy was at revision 0 and unrestricted. GET /api/stats returned 200. The panel's only buttons were "Stop execution and apply policy", "Reload saved policy and keep draft" and "Use saved policy".
2. Typed "secrets" into "Read deny paths" and clicked "Stop execution and apply policy". No confirmation appeared: no open <dialog>, no alertdialog and no native dialog. The PUT went through straight away and the status line said "Filesystem policy revision 1 applied." That was the only feedback; the screenshot at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4623/002-v-policy-applied.png shows nothing saying execution is now paused.
3. The effect reached other projects. GET /api/stats changed to 403. POST /api/runs for a different project (IndustriStudio) returned 409 with "Custom filesystem restrictions pause app-managed execution and unscoped private data access globally...".
4. After applying, the panel still offered the same three buttons. A search for a clear, remove, reset or unrestrict button found 0 matches. I grepped ui/ and found no other place to clear restrictions.
5. Clicking apply again with identical content gave "Filesystem policy revision 2 applied." (rev 1 to 2, same rules).
6. To lift the restriction I had to empty both deny lists, type "." in both allow lists and apply again. That gave revision 3, after which /api/stats returned 200 again.
There were no console errors and no 5xx responses. I also checked whether this is by design. docs/filesystem-policy.md and the panel's help text describe the global pause, but they ask for no confirmation and describe no reset action. The e2e test test/e2e/history-launch.e2e.ts:364 clears the policy the same manual way. Other high-impact actions in the app (delete project, remove worktrees, replace webhook secret) all go through confirmAction …

</details>


## Continuation integration · 2026-10-26

Repair round 1 merged into `codex/dogfood-qa-continue`. Typecheck and all 4 targeted tests pass. Independent browser re-verification is running on a detached integrated build; prior evidence above describes the earlier session.

Fresh continuation Chrome replay: all 3 scenarios pass: close/reload terminal and policy confirmation; every restricted surface pauses without host probes; stale policy editor reports conflicts. Evidence uses fake CLIs, scratch repositories and isolated ports. Logs: `/private/tmp/codeflow-qa-continue/step1-browser.log` and `step1-browser-repaired.log`.

Continuation repair: independently reproduced the verifier's terminal-closure finding with a new browser scenario (failed before the fix: a running shell reappeared after settings closure, policy removal and reload). The terminal now treats vanished remembered sessions as closed, and renders the policy pause notice ahead of stale terminal contents. Typecheck and all 4 policy browser scenarios pass. Logs: `/private/tmp/codeflow-qa-continue/policy-terminal-repro.log` and `policy-terminal-repaired.log`.

## Final policy follow-through

The final combined replay found two remaining automatic private reads in Settings. `950e81b` pauses conventions using the selected project’s policy while retaining its draft and CAS revision. `65b3cc1` pauses repository-default discovery using every owner of that repository, leaving unrelated repositories usable. `cda10e1` preserves unsaved defaults through the new shared-owner policy link without saving them. Independent Chrome reviews covered delayed responses, project/repository scope and one-use handoff; see [conventions review](../final-conventions-policy-review.md) and [defaults review](../final-repo-defaults-review.md). The backend gate remains unchanged. Fixture activity synchronization keeps the exact policy admission,403 and revision-conflict assertions. Final combined results are recorded in [validation](../final-validation.md).
