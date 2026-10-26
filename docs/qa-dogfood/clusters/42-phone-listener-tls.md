# Cluster 42 · phone-listener-tls

**Phone listener awareness and remote TLS status**

Status: **fixed and verified** · 9 issues · branch `codex/qa-phone-listener-tls`

Planner notes: The client never learns that it is on the phone/LAN listener. GET /api/ssh-context (src/server.ts:1603) answers 'local' for every owner session, so a paired phone shows a computer-switcher error (t21-4) and 'Connected projects unavailable' (t21-5/S00-7, ui/connected-projects.tsx), and logs 403/404 for team-link and workspace-projects (t22-12). Expose the listener kind (through ssh-context or a boot endpoint) and skip those requests on the phone. TLS (ui/remote-access.tsx, src/remote-tls.ts): import errors appear out of view, offer a 'Retry' that doesn't retry, and vanish within 10 s because refresh() clears the shared error state (t21-2/t22-7). Certificates from the CODEFLOW_TLS_CERT/KEY env vars are never parsed, so an expired or mismatched certificate still shows 'Secure remote access is set up' (t22-4/S13-3). After a Tailscale rename the status fields disagree (t22-11, networkHost()). Duplicate groups: [["t21-5","S00-7"],["t21-2","t22-7"],["t22-4","S13-3"]]

Likely files: `src/server.ts`, `ui/connected-projects.tsx`, `ui/ssh-projects.tsx`, `ui/connections.tsx`, `ui/main.tsx`, `ui/lib.ts`, `ui/collab-state.ts`, `ui/team-connections.tsx`, `ui/remote-access.tsx`, `src/remote-tls.ts`

## Continuation outcome (2026-10-26)

| Issues | Outcome and verification |
| --- | --- |
| t21-4 | Owner boot now reports the listener capability in `/api/auth/self`; `/api/ssh-context` reports `connections`. Paired phones omit SSH inventory calls, Refresh/Manage actions and setup forms, with neutral owner-computer guidance. Desktop SSH setup remains available. Actual phone requests still receive the intended 403 at the API boundary. |
| t21-5, S00-7 | Connected-project loading and polling stop when the listener cannot manage connections. Host projects remain visible without a permanent error or loading row. Mobile boot, board/run navigation, reload and a full polling interval produce no workspace inventory request. |
| t22-12 | Phones pin the host board (`team=local`) before boot requests, including a copied URL containing an unavailable remote team. Team-link inventory, attempts, connection picker, join/setup wizard, draft-agent action and local mapping setup respect the listener capability. Board, run and stream access remain available; forbidden team-link requests remain 404. Cluster40's ambiguous desktop connection chooser remains intact. |
| t21-2, t22-7 | Load, ordinary mutation and TLS form errors are separate. Import errors remain beside Save, scroll into view, survive polling/Refresh, and clear on editing or successful resubmission. A failed import preserves the current QR/link. Ordinary mutation errors offer Dismiss; only failed GET loads offer Retry. Chrome covers wrong-host and expired imports plus narrowly injected offline POST failures and recovery. |
| t22-4, S13-3 | Environment PEM material is parsed, size limited and key-checked; public expiry/SAN metadata is exposed. Validity is rechecked at use time, and Tailscale admission checks the selected hostname. Environment LAN links use certificate-covered names/IPs. Expired/future/wrong-host certificates report insecure/control false and open no listener. A live short-lived certificate expires, closes its listener through the timer without a settings request, and stays closed after restart. A mismatched key fails startup with a generic message and no key contents. |
| t22-11 | One TLS issue function now controls status, full control and listener binding. After a saved Tailscale certificate's hostname changes, all surfaces report the same failure, hide the QR, disable control and close the listener. Replacing it restores access. The generic disconnected hint no longer contradicts the specific certificate error. |

Validation: 44/44 targeted unit/HTTP/security checks (four new unit cases), 10/10 new real-Chrome cases, all seven original Tailscale Chrome cases, all six integrated cluster41 Chrome cases, TypeScript and `git diff --check`. All test/build/app commands use explicit scratch `CODEFLOW_HOME`; browser fixtures also use scratch repos, account/session data, certificates and fake providers/Tailscale. No real-provider or physical-phone evidence is claimed. No live app, real repositories, home state or remote services were used.

Original-case replay found a further first-action admission race: enabling Tailscale and control in one request used an unrefreshed Tailscale identity. The mutation now refreshes it before checking the next settings. The old Tailscale test expected a DNS-only certificate to authenticate a newly selected raw IP; it now verifies refusal, then restores the covered DNS at the changed IP and retains the reconnect/restart/session checks. The test certificate fixture uses portable `openssl ca` date overrides for expired/future/live-expiry cases.

Browser exceptions and unexpected console/HTTP errors: zero. The new suite records only two intentional TLS-import 400s and two injected offline POST failures. Application logs contain no errors or warnings; the process log includes the deliberate key-mismatch startup rejection. Cluster41's narrow boot-error allowance was removed and its six scenarios pass without local-only API noise; intentional pairing/policy failures remain scoped. Screenshots of the mobile computer menu and the visible persistent import error were inspected.

Evidence: `/private/tmp/codeflow-qa-continue/phone42-{related,e2e,original,tsc}.log`; `/private/tmp/codeflow-qa-phone-listener-tls/output/playwright/qa-phone-listener-tls/` contains mobile/form/TLS screenshots, `browser.json`, the process log and per-instance application logs. Integrated pairing screenshots/console/server evidence: `/private/tmp/codeflow-qa-continue/phone42-pairing-shots/`. Owned fixture servers are stopped and ports4361/4362 are released at completion.

## Issues

### t21-4 · minor · On a paired full-control phone, the computer switcher always shows an error with a 'Refresh connections' that can never succeed

Source: tester unit infra-remote-devices-clients-1; observed with real-agents; features REM-05.

**Repro**

> 1. Enable remote access over Tailscale with HTTPS (imported cert) and Full control. Pair a phone using the QR link.
> 2. On the phone, tap the 'This computer' switcher in the top bar.

**Expected:** The phone either hides SSH connection management or explains it is available only on the host computer, with no actions that cannot work.

**Actual:** The menu shows 'This computer · Current', 'Manage connections…', a red 'Manage SSH connections from the local app' error and a 'Refresh connections' item. Refresh and Manage connections can never work over the phone listener (GET /api/ssh-hosts returns 403).

**Root cause (verifier):** src/server.ts:1603 answers GET /api/ssh-context with `{ kind: process.env.CODEFLOW_SSH_HOST ? "host" : "local" }` for every owner session, whichever listener the request came through. A paired full-control phone (via === "lan") therefore gets kind "local", exactly like the computer itself.

The client uses only that kind to decide whether connection management is possible:
- ui/ssh-projects.tsx:44 (`useState(context.kind !== "host")`) and :51 (`useEffect(() => { if (context.kind !== "host") void refresh(); })`) call localApi('/api/ssh-hosts').
- src/server.ts:1722-1723 rejects that call with 403 "Manage SSH connections from the local app" when via !== "local" (intended per docs/api.md:451-452).
- ui/ssh-projects.tsx:63-67 still render the 'This computer' choice and 'Manage connections…'.
- ui/ssh-projects.tsx:70 renders the raw server message as role=alert with a 'Refresh connections' MenuItem that calls the same forbidden endpoint again.
- SshConnections (ui/ssh-projects.tsx:83-84, 91-92) does the same on the Settings page: a 'Refresh connections' button, a "No remote machines yet" empty state, and an Add form that would POST /api/ssh-hosts and also get a 403.

The same gap reache …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/ssh-projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/connected-projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/connections.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/tailscale.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-security-http.test.ts`

**Suggested fix:** Have the server report the listener and let the client hide what it cannot do.

1. src/server.ts:1603: include a capability in the context, e.g. `{ kind, manageConnections: via === "local" && !!sshProjects }`, or a distinct kind such as "device" for via === "lan". Keep the 403 at :1723 as the enforcement. Basing this on the server's own decision is better than the hostname guess in ui/lib.ts `onPhone`, because it also covers Tailscale/LAN hostnames and stays correct if the route rules change.

2. ui/ssh-projects.tsx: extend HostContext with the flag. In HostChoices, when manageConnections is false:
   - don't fetch /api/ssh-hosts (initial `loading` false, skip the effect);
   - show 'This computer · Current' plus a help line such as "SSH connections are managed in CodeFlow on your computer.";
   - leave out 'Manage connections…' and the error/'Refresh connections' block.
   This reuses the existing kind === "host" branch at :68. In SshConnections, take the existing kind === "host" path …

**Suggested regression test:** 1. test/e2e/tailscale.e2e.ts, in "pair through Tailscale, mutate and stream…" right after the phone tab pairs over HTTPS. Record the requests `tab` makes. Click the top-bar `.host-switcher` trigger, then assert:
   - `tab.getByRole('alert')` has count 0 inside the menu;
   - `tab.getByRole('menuitem', { name: 'Refresh connections' })` has count 0;
   - the menu contains the "managed in CodeFlow on your computer" help text;
   - no request to /api/ssh-hosts or /api/workspace-projects was made, or …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4613t214 on 127.0.0.1:4613 with the remote listener on 4614. It had HTTPS from a throwaway self-signed cert (CODEFLOW_TLS_CERT/KEY in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4613/t214/) and CODEFLOW_LAN_ALLOW_LOCAL=1, so this machine could act as the phone.

Setup: POST /api/remote {enabled:true, lan:true, transport:"lan", control:true}. The response had control:true, secure:true and an https pairing link.

Phone: a fresh Playwright Chrome context (iPhone UA, 390x844, ignoreHTTPSErrors) opened https://192.168.0.100:4614/r/<controlToken>. It paired, was redirected to https://192.168.0.100:4614/, and fetch('/api/ssh-context') returned {"kind":"local"}. I tapped the 'This computer' switcher in the top bar. The menu read: "Computer / This computer · Current / Manage connections… / [red, role=alert] Manage SSH connections from the local app / Refresh connections" (shot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4613t214/002-phone-switcher.png).
- Tapping 'Refresh connections' sent another GET /api/ssh-hosts, which returned 403, and the menu stayed the same.
- Tapping 'Manage connections…' opened #/settings/connections/workspace. That page showed "No remote machines yet. Connect your first VM below.", a working 'Refresh connections' button and the full 'Add a remote machine' form (Save / Connect and open). The only hint was the same 403 error at the bottom (shot 004-phone-manage-connections.png).
- Requests seen on the phone: 403 GET /api/ssh-hosts three times, plus 403 GET /api/workspace-projects twice (the sidebar's connected-projects poll has the same cause).

Control: the same server opened on the desktop at http://127.0.0.1:4613 shows "This computer · Current / Save a remote connection in Settings to use it here. / Manage connections…", with 200 GET /api/ssh-hosts and no errors. So the error happens only on the phone listener.

Is it by design? Partly. docs/api.md:451-452 and docs/ssh-projects.md:47 say phone and shared sessions cannot manage SSH connections, so the server's 403 is intended. Nothing documents that the client should then show a retry and management actions that can never succeed; the client simply doesn't know which listener it is on. The tester's environment and selectors don't explain it, since a fresh profile and fake agents reproduce it …

</details>

### t21-5 · minor · A paired phone's sidebar always shows 'Connected projects unavailable'

Source: tester unit infra-remote-devices-clients-1; observed with real-agents; features REM-07.

**Repro**

> 1. Pair a phone with full control (as in t21-4).
> 2. Open the app's sidebar on the phone.

**Expected:** No error is shown. Phones do not use the connected-computers directory, so the section should be hidden or say it is available on the host computer.

**Actual:** The rail shows 'Connected projects unavailable' permanently, because GET /api/workspace-projects returns 403 on the network listener and is polled every 15 s.

**Root cause (verifier):** The server cannot serve this request on the phone listener, but the UI cannot tell it is on that listener, so it keeps asking and shows a generic error.

- src/server.ts:1603: GET /api/ssh-context returns { kind: "local" } for every owner session. It does not distinguish via === "lan" (the paired-phone listener), so the phone UI thinks it is the local owner app.
- ui/connected-projects.tsx:16: useComputerProjects only skips fetching when executionHost.value.kind === "host". With kind "local" it starts pollVisible(refresh, 15_000) at :27 against /api/workspace-projects.
- src/server.ts:1718: on the phone listener that request always fails with `if (!sshProjects || via !== "local") throw new HttpError(403, "Connected projects require the local app")`. This is intentional.
- ui/connected-projects.tsx:24: the catch block maps every failure, including this permanent 403, to setError("Connected projects unavailable"). It sets no state to stop polling.
- ui/connected-projects.tsx:35: ComputerProjects then renders that error as `<p class="rail-empty" role="status">` under the project list for as long as the session lasts.

The local project list still renders, because children are rendered …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/ssh-projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/connected-projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-security-http.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`

**Suggested fix:** Have the server tell the UI which listener it is on, rather than guessing from the hostname.

1. In src/server.ts:1603, return `{ kind: "local", connections: via === "local" && !!sshProjects }` from /api/ssh-context. Alternatively a `listener: "network"` flag; either way, a boolean avoids adding a new kind that would ripple through the many `kind === "local"` checks.
2. Extend HostContext in ui/ssh-projects.tsx with an optional `connections?: boolean`.
3. In useComputerProjects (ui/connected-projects.tsx:16), return early with no polling when `executionHost.value.kind === "host" || executionHost.value.connections === false`.
4. In ComputerProjects (:35), render the children with no error and no "Loading projects…" in that same case.
5. Defense in depth: in the catch at :24, treat an ApiError with status 403 as "not available here". Clear the error, keep directory null and stop polling, instead of showing "Connected projects unavailable". That message should stay for real failures, such …

**Suggested regression test:** 1. test/e2e/ui.e2e.ts, test "phone: with full control, the phone link signs a phone in to the whole app" (around lines 437-443). Before tab.goto, record requests with `tab.on("request", r => { if (new URL(r.url()).pathname === "/api/workspace-projects") hits.push(r.url()) })`. After `await tab.locator(".rail.open").waitFor()`, assert:
   - `await tab.locator(".rail-empty", { hasText: "Connected projects unavailable" }).count() === 0`
   - `hits.length === 0`

   This works with the existing 127. …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server with a new home: `qa-server.sh start v4615t215 4615 fake`, with CODEFLOW_LAN_ALLOW_LOCAL=1 and CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL=1 exported. The test/e2e/ui.e2e.ts phone test uses these same flags; they only let this machine act as the phone. They do not change the code path under test.

Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4615t215/phone.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4615t215/phone.log.

Steps, as the owner at http://127.0.0.1:4615 under Settings > Connections > Devices:
1. Turned on Enable remote access, set Connection to "Wi-Fi · local network" and turned on Full control from remote devices. /api/remote then reported control=true and lanUrls http://192.168.0.100:4616/r/….
2. In a fresh browser context set up like a phone (390x844, isMobile, iPhone user agent), opened the LAN pairing link. It paired and landed on http://192.168.0.100:4616/.
3. Pressed "Show runs" to open the sidebar.

What I saw:
- The rail's .rail-empty texts were ['Connected projects unavailable', 'No runs yet — start one on the right'].
- After waiting 35 s, the message was still there.
- From the phone, /api/ssh-context returned {"kind":"local"}, and /api/workspace-projects returned 403 {"error":"Connected projects require the local app"}.
- Network log: 403 GET /api/workspace-projects at 22:43:03 (twice), 22:43:07, 22:43:18 and 22:43:33. That is a retry about every 15 s that can never succeed.
- Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4615t215/phone-sidebar-later.png shows "Connected projects unavailable" under the Projects heading, just below "8 more projects".

Control: the owner's desktop app at 127.0.0.1:4615 showed only 'No runs yet — start one on the right'. The local projects list on the phone still works; only the error line and the useless polling are wrong.

Why this is not by design and not the tester's environment:
- The 403 itself is intended. docs/api.md ("SSH projects") says connection management is owner-only on the local listener, and docs/ssh-projects.md:47 says phone sessions cannot create SSH connections.
- No doc says the phone should show an error. ui/connected-projects.tsx already hides this section silently for the 'host' context, b …

</details>

### S00-7 · minor · Over the phone/LAN link GET /api/workspace-projects is refused with 403 ('Connected projects require the local app'), so the sidebar Projects section always shows 'Connected projects unavailable' for phone users.

Source: code-level suspect at `ui/connected-projects.tsx:24` (confirmed hands-on).

**Repro**

> Fake server s00 with CODEFLOW_LAN_ALLOW_LOCAL=1 and CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL=1. Through the API: remote {enabled, lan:true} then {control:true}. A phone-sized browser opened the full-control pairing link on 127.0.0.1:4502 and tapped 'Show runs'. The sidebar's Projects section shows '9 more projects' followed by 'Connected projects unavailable' (screenshot shots/s00/phone-rail.png). fetch('/api/workspace-projects') from the phone returns 403 {"error":"Connected projects require the local app"}, and the hook repeats it every 15 s. On the computer listener the same sidebar shows no such message. Remote access was turned off afterwards.

**Expected:** A phone session with full control shows the local projects without a false error. Either it is treated as a single-computer workspace or connected computers are hidden quietly.

**Actual:** Every phone session shows a persistent 'Connected projects unavailable' status line under Projects and polls a refused endpoint every 15 s.

**Root cause (verifier):** useComputerProjects skips the request only when executionHost.kind === 'host'. On the phone listener it calls localApi('/api/workspace-projects'), which the server rejects for via !== 'local' (src/server.ts:1718). The catch branch then sets the error 'Connected projects unavailable', which ComputerProjects renders below the children.

**Suggested fix:** In useComputerProjects, return early when onPhone (ui/lib.ts) is true, rendering the children with no error. Alternatively, have the server answer via 'lan' with {currentComputerId:'local', computers:[]}, or have the UI treat a 403 from this endpoint as 'no connected computers' rather than an error.

**Suggested regression test:** In the phone full-control e2e, after opening the rail on the phone context, assert 'Connected projects unavailable' is not visible (and optionally that no /api/workspace-projects 403 was requested).

### t22-12 · minor · Paired phone's full app logs repeated 403/404 errors for team-link and workspace-projects endpoints

Source: tester unit infra-remote-devices-clients-2; observed with real-agents; features REM-16.

**Repro**

> 1. Pair a phone over the remote port. 2. Open the app on the phone and watch the console/network.

**Expected:** Endpoints that are unavailable on the phone listener are not requested, or fail silently.

**Actual:** Each load logs 404 GET /api/team-link, /api/team-link/connections, /api/team-link/attempts and 403 GET /api/workspace-projects as console errors.

**Root cause (verifier):** The server refusals are intentional, and the client never learns which listener it is on.

Server, by design (these should stay):
- src/server.ts:1717-1718: /api/workspace-projects throws 403 "Connected projects require the local app" when via !== "local".
- src/server.ts:1805-1806: /api/team-link* throws 404 when via !== "local". The comment at :1802 says "The link itself ... is always local and the owner's own".

The phone is a full owner on the lan listener, but src/server.ts:1536 (/api/auth/self) returns only {kind:"owner", streamSharing}, with no listener or remote indicator. So the UI boots exactly like the local owner app and calls the local-only endpoints without any gate:
- ui/main.tsx:71 initializeTeamConnection() calls ui/lib.ts:42 GET /api/team-link/connections.
- ui/app.tsx:127 watchTeam() calls ui/collab-state.ts:87 loadTeamLink() (GET /api/team-link, line 53) and ui/collab-state.ts:89 GET /api/team-link/connections.
- ui/run.tsx:125 loadLocalAttempts() calls ui/collab-state.ts:59 GET /api/team-link/attempts.
- ui/collab-board.tsx:34, ui/collab-settings.tsx:27/48 and ui/collab-task.tsx:51 poll loadTeamLink every 15 s for any non-shared viewer.
- ui/team-connections.ts …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/main.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/lib.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team-connections.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/connected-projects.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-board.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-task.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-security-http.test.ts`

**Suggested fix:** Keep the server refusals; they are a security boundary. Have the server tell the client which listener it is on, and skip the local-only calls on the phone.

1. In src/server.ts:1536, add a listener flag to the owner identity from /api/auth/self, for example `{ kind: "owner", streamSharing, remote: via === "lan" }` (or `localOnlyApis: via === "local"`). Document the field in docs/api.md.
2. In ui/main.tsx boot(), store it in a signal in ui/lib.ts, e.g. `ownerOnComputer`. Do not rely on the hostname-based `onPhone` check.
3. When the owner is not on the computer:
   - make initializeTeamConnection a no-op that pins "local";
   - have watchTeam skip loadTeamLink and the connections inventory but keep the team stream;
   - have loadTeamLink and loadLocalAttempts return early with null / []. This covers collab-board, collab-settings, collab-task and run.tsx without touching each poll.
4. In ui/team-connections.tsx, don't poll on the phone. Hide TeamConnectionPicker, or show a neutral "Team …

**Suggested regression test:** 1. Extend test/e2e/ui.e2e.ts, test "phone: with full control, the phone link signs a phone in to the whole app" (line 409).
   - Before `tab.goto(PHONE + phonePath)`, attach `tab.on("response")` to collect URLs under /api/ with status >= 400.
   - After the existing land-and-open-rail steps, also navigate to `#/team` and a run page, then wait more than one 15 s poll (or fake timers).
   - Assert no 4xx was recorded for /api/team-link* or /api/workspace-projects.
   - Assert the open rail (.rail. …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4601t2212, on port 4601 with remote port 4602. It used a throwaway self-signed TLS cert for 192.168.0.100 via CODEFLOW_TLS_CERT/KEY, plus CODEFLOW_LAN_ALLOW_LOCAL=1 so this machine could act as the phone. The reporter used real agents and a Tailscale cert; the problem does not depend on either.

1. In the owner UI at http://127.0.0.1:4601, under Settings > Connections > devices, I ticked "Enable remote access", chose "Wi-Fi · local network" and ticked "Full control from remote devices". /api/remote then reported secure:true and control:true.
2. In a fresh mobile Chrome context (390x844, iPhone user agent, ignoreHTTPSErrors) I opened the pairing link https://192.168.0.100:4602/r/<tok>. The phone landed in the full app, and /api/auth/self on the phone returned {kind:"owner"}.
3. I recorded every 4xx response and console error on the phone (script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4601t2212/r1.mjs, log r1.log).
   - First load: 404 GET /api/team-link/connections (twice), 404 GET /api/team-link and 403 GET /api/workspace-projects (twice).
   - After 20 s idle: another 403 /api/workspace-projects.
   - After a reload: the same set again.
   - Each failure appeared as a Chrome console error "Failed to load resource: the server responded with a status of 404/403".
4. With the saved phone cookie I opened the rail, then #/team for 34 s, then a run page (r2.mjs, log r2.log).
   - On #/team, GET /api/team-link and /api/team-link/connections returned 404 every 15 s (+6 s, +21 s, +36 s). /api/workspace-projects returned 403 every 15 s on every page.
   - Opening #/run/<id> added 404 GET /api/team-link/attempts.
   - 15 console errors in about 45 s.

This is more than console noise; two errors are visible in the phone UI:
- The rail shows "Connected projects unavailable" (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4601t2212/phone-rail-open.png).
- The Team board's "Team connection" card shows an empty select and a red "Not found" alert (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4601t2212/phone-team.png).

The owner app on 127.0.0.1 had no such 4xx responses. Nothing else is broken: the board loads and the composer works. For that reason I rated it minor, not co …

</details>

### t21-2 · minor · HTTPS certificate import errors appear out of view at the top of the Remote access card, offer a misleading 'Retry', and vanish within 10 s

Source: tester unit infra-remote-devices-clients-1; observed with real-agents; features REM-12.

**Repro**

> 1. On a QA server, open Settings, Connections, Share access, Connect my devices, then Enable remote access and choose Tailscale.
> 2. Click 'Set up secure remote access', choose 'Import certificate files', and enter the ts.net hostname.
> 3. Choose a cert/key pair for another hostname (e.g. CN=qa-wrong.example) and click 'Save and apply HTTPS'.
> 4. Watch the form for 10 s.

**Expected:** The error (e.g. 'The certificate does not cover this hostname or IP address') appears next to the import form and stays until the user acts.

**Actual:** The error is shown in the card-level alert at the top of the Remote access card, scrolled out of view above the form, with a 'Retry' button that only reloads settings and does not retry the import. The next 10-s poll clears it (s12b: visible at +1..+7 s, gone at +8 s). In s12 two of six invalid imports showed no visible error at all when checked 2.5 s later.

**Root cause (verifier):** ui/remote-access.tsx has one `error` state shared by load errors and save errors.
- refresh() at ui/remote-access.tsx:41 does `setInfo(value); setError("")` on every successful GET.
- refresh() is run every 10 s by pollVisible at ui/remote-access.tsx:47.
- set() at ui/remote-access.tsx:60 writes server save errors into that same state. The poll's guards (saving.current / generation) only protect the request while the POST is in flight. The first poll after the POST resolves wipes the save error, 0-10 s later.
- The shared error renders at ui/remote-access.tsx:73, at the top of the card. Its Retry button is wired to refresh(true), which is only right for load failures ("Remote access settings could not be loaded."). For a failed save it just reloads settings and clears the message.
- SecureRemoteSetup gets `save={(body) => set(body, "/api/remote/tls")}` at ui/remote-access.tsx:98, and set() returns false instead of throwing. So submit() at ui/remote-access.tsx:140 and :144 silently ignores the failure. Its own error state (:138/:148, rendered next to the submit button at :172) only ever shows client-side checks such as missing files or size limits.
- Server side is correct: src/serv …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/remote-access.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/tailscale.e2e.ts`

**Suggested fix:** 1. Report TLS save failures inside the form. Give set() a way to return the error, for example `{ ok: false, error }`, or let it rethrow when called with a `{ local: true }` option, so it does not write the card-level `error`. In SecureRemoteSetup.submit(), when save fails, call setError(message) so the message renders in the form's existing role="alert" paragraph (ui/remote-access.tsx:172), next to "Save and apply HTTPS". It stays until the user edits a field or submits again, and the background poll cannot touch it.
2. Keep load errors and action errors apart in RemoteAccess. Use `loadError` (set and cleared by refresh) and `actionError` (set by set(), cleared only by the next action or by dismissing it). Show Retry only for loadError; for actionError use no button or a "Dismiss" button. Then the 10 s poll can no longer erase errors from Enable, Connection, Full control or New link either.
3. Optional: after a failed submit, move focus to or scroll the form alert into view so it cann …

**Suggested regression test:** Extend test "secure access setup imports and renews certificates in Settings without a server restart" in test/e2e/tailscale.e2e.ts (around lines 294-295). After the wrong-hostname import:
- Scope the assertion to the form: `section.locator('form.secure-remote-form').getByRole('alert').filter({ hasText: 'does not cover' }).waitFor()`.
- Assert the card-level alert has no Retry button for it.
- Then force a poll and assert the form alert is still there. Use page.clock to fast-forward 11 s, or cal …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4609t212" on port 4609 with a new home. Fake Tailscale was set up through FAKE_TAILSCALE_STATUS to report "connected", dnsName codeflow.tail-test.ts.net, IP 100.101.102.199. I generated a self-signed cert/key for CN/SAN qa-wrong.example. Browser: a fresh headless Chrome profile.
1. Clicked through Settings > Connections > Share access > Connect my devices, enabled remote access, chose "Tailscale · access anywhere". Clicked "Set up secure remote access", chose "Import certificate files". The hostname was prefilled with codeflow.tail-test.ts.net. Chose other.pem/other.key and clicked "Save and apply HTTPS".
2. Result at 1440x900 (scratchpad/qa/work/v4609t212/repro.log): POST /api/remote/tls returned 400 {"error":"The certificate does not cover this hostname or IP address"} within 0.1 s. The message appeared only in the card-level alert (`section > .msg.err`). The form's own alert (`form [role=alert]`) stayed empty every time. The card alert sat at the very top of the viewport (top=48), and inserting it pushed "Save and apply HTTPS" below the fold (button top 866 -> 915). The next poll (GET /api/remote at +4.8 s) cleared it: visible from +0.5 s to +4.7 s, gone at +5.2 s after the click. How long it stays depends on poll phase, anywhere from 0 to 10 s. Screenshots: shots/v4609t212/001-a1-err-visible.png and 002-a1-err-gone.png.
3. Retry: on a second failed import I clicked the "Retry" button in the alert. It sent only GET /api/remote?refresh=1 (plus a plain GET), never POST /api/remote/tls. The error disappeared and nothing was retried. Shot: 004-after-retry.png.
4. At 1366x768 and 390x844 (viewports.log): 0.4 s after the click the error's bounding box was at top=-476 and top=-653, entirely above the viewport. The submit button was in view and the form showed no alert. In shots/v4609t212/001-vp-1366x768.png the user sees the unchanged form and nothing that says the import failed. The only red text is an unrelated lanError, which comes from my fake tailnet IP and would not appear on a real tailnet.
5. Same root cause on the recommended path (tsmode.log): "Get Tailscale certificate" failed with 400 "Tailscale could not issue the certificate…". The error showed in the card alert at +3.0 s and the next poll cleared it at +10.6 s; the form alert stayed empty.
The 2.5 s gaps in the reporter's s12.log are explained the same way: the two empty cases (16:53:37 and 16:53:47) are exactly one 10 s poll apart.
Not by design:
- docs/automations.m …

</details>

### t22-7 · minor · Certificate import errors appear away from the form, offer a 'Retry' that does not retry, vanish within 10s and hide the working link/QR

Source: tester unit infra-remote-devices-clients-2; observed with fake-agents; features REM-14.

**Repro**

> 1. Connect my devices → Tailscale → Set up secure remote access → Import certificate files. 2. Choose an expired cert/key and click 'Save and apply HTTPS'. 3. Watch the area near the button, then wait 10s.

**Expected:** The error is shown inside the setup form next to the submit button (the form already has its own error slot) and stays until the user changes something. The existing read-only link and QR stay visible.

**Actual:** The error renders at the top of the Remote access card, often out of view, with a 'Retry' button that only re-reads settings. The QR code and Copy link disappear while it is shown. The 10s poll clears the error automatically, and the QR then comes back.

**Root cause (verifier):** All in ui/remote-access.tsx:
- set(), lines 50-63: a server error from post() is caught (line 59) and written to the card-level `error` state with setError (line 60), and set() returns false. It never throws to its caller, so the try/catch in SecureRemoteSetup.submit (lines 137-149, catch at 148) only ever sees client-side errors: missing files (142) or size (143). The form's own slot at line 172 therefore never shows server errors.
- Line 73: the card-level error renders at the top of the section with a "Retry" button that calls refresh(true), a GET /api/remote?refresh=1. It does not resubmit the form.
- Line 67: `links = !info || expired || error ? [] : ...` empties the links whenever `error` is set. That hides the QR (line 108) and the Copy link rows (line 113) even though nothing changed on the server. Line 111's `!error` also hides the "No remote link until…" hint.
- Line 41: refresh() calls setError("") on any successful GET, and the useEffect at line 47 runs refresh via pollVisible every 10_000 ms. So the mutation error is wiped within 10s whether or not the user did anything.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/remote-access.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/tailscale.e2e.ts`

**Suggested fix:** 1. Keep load errors and mutation errors apart in RemoteAccess. Use one state for refresh/load failures, shown with Retry only when it is a load error, and a separate state (or a returned/thrown error) for save failures.
2. For the TLS form, have set() accept an option to rethrow, or give it a path that returns `{ ok: false, error }`. That way SecureRemoteSetup.save surfaces the server message in its own `error` slot next to the submit button (line 172), and the card-level `error` is never set. One simple way: let SecureRemoteSetup's save prop return `Promise<string | true>`, and have submit call setError(message) when it gets a string. Clear the form error in onInput/onChange of the hostname, file and method fields.
3. Other set() callers (enable, transport, control, rotate): show their failures next to the control, or as a card message without a Retry that only refreshes. If a card-level message stays, label it "Dismiss" or have it repeat the last mutation.
4. Do not derive `links` fr …

**Suggested regression test:** Extend the secure-setup test in test/e2e/tailscale.e2e.ts, "secure access setup imports and renews certificates in Settings without a server restart", around lines 294-295.
- After the "wrong.example" submit, scope the assertion to the form: `section.locator(".secure-remote-form").getByRole("alert").filter({ hasText: "does not cover" }).waitFor()`.
- Assert that `section.locator(":scope > .msg.err")` has count 0.
- Assert that `.phone-qr` still has count 1 and a "Copy link" button is still prese …

<details><summary>Verifier's independent reproduction</summary>

I started a brand-new fake-mode QA server, "v4687c", on port 4687 with a fresh home. The remote port was 4688. To fake a connected Tailscale I used the repo's own e2e fixture: NODE_OPTIONS="--import test/tailscale-network-fixture.mjs", FAKE_TAILSCALE_STATUS pointing at a "Running" status for codeflow.tail-test.ts.net / 100.101.102.103, and CODEFLOW_LAN_ALLOW_LOCAL=1. I made an expired self-signed cert/key with openssl (valid 2020-01-01 to 2020-02-01, SAN codeflow.tail-test.ts.net). Each script opened a fresh browser with no profile at Settings > Connections > devices. The scripts are /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4687-t22-7/r1.mjs and r2.mjs. They tick Enable remote access, choose "Tailscale · access anywhere" and wait for the QR. Before the import there was 1 QR and 1 Copy link. They then click Set up secure remote access, choose Import certificate files (hostname is prefilled), pick exp.crt/exp.key and click Save and apply HTTPS.

What happened:
- POST /api/remote/tls returned 400 {"error":"The certificate is expired or not valid yet"}.
- The only alert was the card-level `<p class="msg err" role="alert">` with the text "The certificate is expired or not valid yet Retry". It is a direct child of .phone-card, not inside the form. The form's own error slot (form .msg.err) had 0 elements.
- At 1280x720 the alert sat at y=-517, off screen, while the submit button stayed in view at y=367. Screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4687c/001-after-submit.png shows no feedback anywhere near the button, and only "New link" is left in the link box.
- At 1440x900 the alert happened to be visible near the top. Inserting it pushed the submit button down to y=914, below the fold.
- While the error showed, the QR and Copy link went from 1/1 to 0/0. The form stayed open with its files still chosen.
- Clicking Retry sent only GET /api/remote?refresh=1. Nothing was POSTed to /api/remote/tls. The alert disappeared and the QR came back.
- Without clicking Retry, the 10s poll (GET /api/remote) cleared the alert. After 11s there were 0 alerts, 1 QR and 1 Copy link.

I also checked over the API that a failed import changes nothing on the server: the tailscaleUrl hash was f7b47a0003de before and after, and secure stayed false. So the link the UI hides keeps working the whole time.

I found nothi …

</details>

### t22-4 · minor · Expired or mismatched environment TLS certificate is reported as 'Secure remote access is set up' and still allows full control

Source: tester unit infra-remote-devices-clients-2; observed with fake-agents; features REM-14.

**Repro**

> 1. openssl req -x509 ... -not_before 20250101000000Z -not_after 20250201000000Z for the Tailscale name. 2. Start a server with CODEFLOW_TLS_CERT/CODEFLOW_TLS_KEY pointing at it (QA used fake tailscale fixture, port 4471). 3. Settings → Connections → Connect my devices: enable, choose Tailscale, check Full control.

**Expected:** Like a saved certificate, an expired or not-yet-valid env certificate is flagged (error and no full control), or at least the UI shows its expiry date.

**Actual:** /api/remote shows secure:true, tls {editable:false, source:'environment'}, no error. The UI says 'Secure remote access is set up' / 'Encrypted HTTPS'. Full control was enabled, and the listener serves the expired cert and pairs devices (with ignoreHTTPSErrors). A strict browser gets a certificate error while Code Flow reports everything as fine.

**Root cause (verifier):** The certificate from CODEFLOW_TLS_CERT/KEY is never parsed or validated, and every health check covers only the saved certificate.
- src/server.ts:306 reads the env cert and key as raw bytes into `phoneTls`. They never go through validateRemoteCertificate (src/remote-tls.ts:23) or an X509Certificate parse, so validFrom/validTo, subject names and key match are never recorded.
- src/server.ts:314-316: remoteTlsIssue() returns only tlsLoadError or `savedCertificate.expiresAt <= now`. savedCertificate stays undefined when tlsConfigured (the load at :2758 is skipped), so an env cert can never produce an issue.
- Because of that, these checks all pass for an expired or not-yet-valid env cert:
  - the full-control gates at :279/:283 and phoneControl() at :444
  - `secure: !!phoneTls && !remoteTlsIssue()` at :1068
  - the listener gate at :1119
- src/server.ts:1069: for source "environment", tls.hostname and tls.expiresAt come from savedCertificate and are therefore undefined, and error is undefined.
- src/server.ts:1076 and :1120: the check for a certificate that belongs to a different Tailscale name only looks at savedCertificate.hostname, so a mismatched env cert passes too.
- ui/remote …

**Files:** `src/server.ts`, `src/remote-tls.ts`, `ui/remote-access.tsx`, `docs/automations.md`, `docs/security.md`, `test/phone-security-http.test.ts`

**Suggested fix:** 1. In src/remote-tls.ts, add `inspectEnvironmentCertificate(cert, key)`. It parses with X509Certificate, checks the key matches (checkPrivateKey plus createSecureContext), and returns { validFrom, expiresAt, cert }. It must never include key contents in errors.
2. In src/server.ts near :306, call it when tlsConfigured and keep the result as `environmentCertificate`. A cert that cannot be parsed or does not match its key should still fail startup with a clear message, as it does today when createSecureServer throws later.
3. Extend remoteTlsIssue() (:314):
   - If environmentCertificate.expiresAt <= now, or validFrom > now, return an error such as "The HTTPS certificate from CODEFLOW_TLS_CERT is expired or not valid yet. Replace the files and restart Code Flow."
   - Because it is evaluated per call, an env cert that expires while the server runs also turns off secure, control and the listener through the existing gates at :279/:283/:444/:1068/:1119. The periodic remote sync must close  …

**Suggested regression test:** Add a test to test/phone-security-http.test.ts. Use the existing start() helper with a third cert generated by `openssl req -x509 ... -not_before 20250101000000Z -not_after 20250201000000Z`; this needs a small helper parameter for the cert and key paths.
- Assert that GET /api/remote returns secure === false, tls.source === "environment", and tls.error matching /expired or not valid yet/.
- Assert that tls.expiresAt equals Date.parse('2025-02-01T00:00:00Z').
- Assert that POST /api/remote {enabl …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4681t224" on port 4681 (remote listener 4682). Before `qa-server.sh start` I exported CODEFLOW_TLS_CERT/KEY, FAKE_TAILSCALE_STATUS (Running, TUN, 100.101.102.103, DNSName codeflow.tail-test.ts.net.), CODEFLOW_LAN_ALLOW_LOCAL=1, CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL=0, and NODE_OPTIONS=--import test/tailscale-network-fixture.mjs. This is the same setup test/e2e/tailscale.e2e.ts uses.

Case A, expired: `openssl req -x509 ... -subj /CN=codeflow.tail-test.ts.net -addext subjectAltName=DNS:codeflow.tail-test.ts.net -not_before 20250101000000Z -not_after 20250201000000Z`. Script work/v4681/t224-repro.mjs used a fresh browser, no profile.
- Before any change, GET /api/remote already returned secure:true and tls {"editable":false,"source":"environment"}.
- In the UI (Settings > Connections > Connect my devices) I ticked "Enable remote access" and chose "Tailscale · access anywhere". The "Full control from remote devices" checkbox was enabled, I ticked it, and it stayed on.
- The UI showed "Secure remote access is set up", "HTTPS is managed by this server's environment configuration." and "Encrypted HTTPS". It showed no expiry date and no error, plus a full-control pairing QR and link (screenshot shots/v4681t224/001-expired-env-tls.png).
- The API returned secure:true, control:true, lanError undefined, and a tailscaleUrl.
- A TLS probe of :4682 got the cert valid_to "Feb 1 00:00:00 2025 GMT". A strict Node TLS client that trusts that cert as CA failed with CERT_HAS_EXPIRED.
- A Chrome context with ignoreHTTPSErrors (Tailscale name mapped to loopback) opened the pairing link: 200, Secure cookie codeflow_phone_4682 set, /api/remote 200 from the device, and the device appeared in /api/remote/devices. Plain Chrome failed with ERR_CERT_AUTHORITY_INVALID because the cert is self-signed.
- server.out logged no certificate warning at startup.

Case B, hostname mismatch: I restarted the same server with a currently valid 30-day cert for other.tail-test.ts.net. The result was the same: secure:true, control:true, no lanError, same UI wording. The listener served CN=other.tail-test.ts.net, a strict client got ERR_TLS_CERT_ALTNAME_INVALID, and a device paired with ignoreHTTPSErrors.

For contrast, saved certificates are checked. phone-security-http.test.ts:195-200 expects secure:false, tls.error /invalid or expired/ and control refused (400). The reporter's selector, profile and credentials are not the cause; this comes from the server's logic.

</details>

### S13-3 · minor · remoteTlsIssue() only checks expiry of the saved (Settings-managed) certificate. Certificates given through CODEFLOW_TLS_CERT/KEY are never checked for expiry or hostname, so an expired environment certificate still reports secure: true and full control stays enabled.

Source: code-level suspect at `src/server.ts:314` (confirmed hands-on).

**Repro**

> Created a self-signed certificate valid only from 2024-01-01 to 2024-02-01, CN/SAN qa-s13.invalid (openssl 3.6, -not_before/-not_after). Started fake QA server s13 with CODEFLOW_TLS_CERT/CODEFLOW_TLS_KEY pointing at it. GET /api/remote returned secure:true and tls:{editable:false, source:'environment'}, with no error and no expiresAt. In the UI (Settings > Connections > Connect my devices) I enabled remote access and Wi-Fi. The card said 'Secure remote access is set up', the 'Full control from remote devices' checkbox was enabled, checking it succeeded (control:true), and the help line read 'Encrypted HTTPS. Pairing links expire after ten minutes.' The listener served the expired certificate on 0.0.0.0:4554, and phones paired over it (with ignoreHTTPSErrors). It also advertised LAN and Tailscale-IP URLs for which the certificate's hostname doesn't match. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s13/remote-devices-card.png. Remote access was turned off afterwards and port 4554 was confirmed closed.

**Expected:** An expired (or not yet valid) environment certificate is treated like an expired saved certificate: remoteTlsIssue() reports it, secure is false, full control is refused and the listener is not opened. The UI shows the expiry date and an error.

**Actual:** An expired environment certificate is reported as secure, full control can be turned on, the pairing link works, and phones only see a browser certificate warning.

**Root cause (verifier):** When tlsConfigured is true (src/server.ts:304-306), phoneTls is read straight from the environment files. savedCertificate stays undefined, because the startup validation at line 2757 runs only when tlsConfigured is false. remoteTlsIssue() (line 314) returns tlsLoadError or an expiry message based on savedCertificate only. For environment certificates it always returns undefined, so remoteInfo().secure = !!phoneTls && !remoteTlsIssue() is true. phoneControl() and changeSavedRemote() then allow full control, and networkHost() opens the listener. validateRemoteCertificate() in src/remote-tls.ts is never applied to environment certificates. docs/security.md says expired saved certificates disable the listener without an HTTP fallback; the environment path has no equivalent check at all.

**Suggested fix:** At startup, when tlsConfigured, parse the environment certificate with new X509Certificate(cert) (and checkPrivateKey). Store an envCertificate {expiresAt, validFrom, names}. Extend remoteTlsIssue() to return an expiry or not-yet-valid message for it, and expose expiresAt in remoteInfo().tls. Optionally re-read the files periodically, as the renewal timer does, so a replaced certificate is picked up. Environment certificates have no configured hostname, so expiry and validity are the minimum. Hostname matching could be checked against lanAddresses() or the Tailscale DNS name and shown as a warning.

**Suggested regression test:** Start the server in a test with CODEFLOW_TLS_CERT/KEY pointing to a fixture certificate that expired in 2024 (generated with openssl or a checked-in PEM). Assert GET /api/remote gives secure:false with tls.error set, that POST /api/remote {enabled:true, lan:true, control:true} returns 400 'Full phone control requires HTTPS', and that nothing listens on REMOTE_PORT.

### t22-11 · minor · After a Tailscale name change the card still reads 'Secure remote access is set up / Encrypted HTTPS / Tailscale connected' while the listener is off

Source: tester unit infra-remote-devices-clients-2; observed with fake-agents; features REM-15.

**Repro**

> 1. Fake tailscale fixture (t22f): get a Tailscale cert for codeflow.tail-test.ts.net. 2. Change the status DNSName to codeflow-renamed.tail-test.ts.net. 3. Refresh Tailscale.

**Expected:** The heading and status reflect that HTTPS access is unavailable until secure access is set up again.

**Actual:** The correct red error 'The HTTPS certificate belongs to a different Tailscale name…' shows lower down. The heading still says 'Secure remote access is set up' and 'Encrypted HTTPS. Pairing links expire…', next to 'No remote link until Tailscale is connected…' while the status says 'Tailscale connected'.

**Root cause (verifier):** The rule that the certificate name must match the Tailscale name is written out separately in only two places, so the status fields disagree.

- src/server.ts:1120, networkHost(): returns undefined when savedCertificate.hostname !== tailscaleStatus.dnsName, which closes the listener.
- src/server.ts:1076, remoteInfo(): lanError builds the "different Tailscale name" message inline.
- src/server.ts:1068: `secure: !!phoneTls && !remoteTlsIssue()`. remoteTlsIssue() (src/server.ts:314) covers only tlsLoadError and expiry, not the name mismatch, so secure stays true.
- src/server.ts:1069: tls.error uses remoteTlsIssue() too, so the secure-setup card has no error.
- src/server.ts:1067 and :444: `control: phoneControl()` ignores the mismatch, so the Full control checkbox stays checked and enabled.

The UI then trusts these fields:
- ui/remote-access.tsx:151, heading: "Secure remote access is set up" because info.secure is true.
- ui/remote-access.tsx:103: "Encrypted HTTPS. Pairing links expire…" because info.secure and full are true.
- ui/remote-access.tsx:100: the control checkbox is enabled because info.secure is true.
- ui/remote-access.tsx:111: shows the generic "No remote link until T …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/remote-access.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/tailscale.e2e.ts`

**Suggested fix:** In src/server.ts, add one helper and use it everywhere the mismatch matters:

```ts
function tailscaleNameIssue() {
  return savedCertificate && remote.transport === "tailscale" && tailscaleStatus.state === "connected" && savedCertificate.hostname !== tailscaleStatus.dnsName
    ? "The HTTPS certificate belongs to a different Tailscale name. Set up secure access again for this computer."
    : undefined;
}
const remoteCertificateIssue = () => remoteTlsIssue() || tailscaleNameIssue();
```

Use remoteCertificateIssue() in four places:
- remoteInfo `secure` (line 1068): `!!phoneTls && !remoteCertificateIssue()`.
- remoteInfo `tls.error` (line 1069), so the secure-setup card shows the error next to its heading.
- remoteInfo `lanError` (line 1076), replacing the inline copy.
- networkHost() (line 1120), so the listener rule and the status message share one condition.

Optionally have phoneControl() (line 444) or remoteInfo.control report false while the names differ. The checkbox would then …

**Suggested regression test:** Add a test to test/e2e/tailscale.e2e.ts after the existing "secure access setup imports and renews certificates…" test, which leaves a Tailscale certificate for codeflow.tail-test.ts.net:
1. Turn control on, then call `setStatus({ ...connected(), Self: { Online: true, DNSName: "codeflow-renamed.tail-test.ts.net." } })` and `refreshUI()`.
2. Assert `(await api()).secure === false`.
3. Assert `tls.error` matches /different Tailscale name/ and `tailscaleUrl` is undefined.
4. Run `assertNoListener() …

<details><summary>Verifier's independent reproduction</summary>

Fresh home v4695ts, fake mode, port 4695 (remote port 4696). Fixture in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4695t2211/fx: an openssl self-signed 60-day cert for codeflow.tail-test.ts.net and status.json (Running, 100.101.102.103, DNSName codeflow.tail-test.ts.net.). Started with FAKE_TAILSCALE_STATUS/CERT/KEY/BIND_LOG exported, CODEFLOW_LAN_ALLOW_LOCAL=1, NODE_OPTIONS=--import <dogfood>/test/tailscale-network-fixture.mjs. These are the same fixtures that test/e2e/tailscale.e2e.ts uses.

Script r1.mjs (same directory), all through the UI with a fresh browser profile:
1. Opened #/settings/connections/devices, turned on Enable remote access and chose Tailscale. It showed "Tailscale connected".
2. Set up secure remote access, then Get Tailscale certificate. The heading changed to "Secure remote access is set up". Turned on Full control. /api/remote returned secure:true and control:true, tailscaleUrl was https://codeflow.tail-test.ts.net:4696/..., and the listener on 4696 was open.
3. Changed status.json DNSName to codeflow-renamed.tail-test.ts.net. and clicked Refresh Tailscale.

Result, unchanged after another 11 s poll: /api/remote returned secure:true, control:true, tls.error undefined, tailscaleUrl undefined, and lanError "The HTTPS certificate belongs to a different Tailscale name. Set up secure access again for this computer." The listener on 4696 was closed.

The card still read "Tailscale connected / Tailscale is connected. codeflow-renamed... · 100.101.102.103", "Secure remote access is set up", "Automatic renewal is on", and "Encrypted HTTPS. Pairing links expire after ten minutes..." The Full control checkbox stayed checked and enabled. Below that came the red alert about the different name, then "No remote link until Tailscale is connected and Codeflow can listen on its address", even though Tailscale is connected. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4695t2211/card-after-rename.png. No console or 5xx errors.

Attempts to refute:
- Not by design. docs/automations.md ("Remote access with Tailscale" and "Set up HTTPS in Settings") and docs/security.md say the certificate must match the name. Nothing in them says the card should still report secure access as set up after the name changes.
- Not caused by the environment. The fake tailscale and network fixture are the pr …

</details>
