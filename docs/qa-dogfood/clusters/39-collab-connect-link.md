# Cluster 39 · collab-connect-link

**Team connections & runner link: default port, wizard resume, alias duplicates, dead connect check, startup crash**

Status: **fixed and verified** · 11 issues · branch `codex/qa-collab-connect-link`

Planner notes: t13-3/t14-9/S05-3: ui/connect-computer.tsx:13 defaults to http://localhost:4318, which is the dev port. Use 4317 or the real local origin, and recognise an existing connection (t14-9). t13-4: the host-a-team wizard keeps its step and project in local state, so reopening doesn't resume. t14-11: connections compare raw origin strings, so 127.0.0.1 and localhost are saved twice. t14-14/S15-6/S06-4: server.ts (~1809) handles team-link connect and disconnect itself, so the 'local board holds N tasks' refusal in link-api.ts is dead code. Decide which behaviour is right (the docs say it refuses) and remove the dead path. t14-8/S06-3: TeamConnections.load throws a 503 when both legacy files exist, and server.ts awaits it with no catch, so the server crashes; record a fault instead. t13-17: the hub's guided setup never creates a repository mapping, so Draft with agent and Fetch aren't prefilled. auth-session-accounts owns the SameSite handoff (t13-2). Duplicate groups: [["t13-3","t14-9","S05-3"],["t14-14","S15-6","S06-4"],["t14-8","S06-3"]]

Likely files: `ui/connect-computer.tsx`, `ui/team-join-link.ts`, `ui/team-server-wizard.tsx`, `src/collab/connections.ts`, `src/collab/link-api.ts`, `src/collab/link.ts`, `src/server.ts`, `ui/collab-settings.tsx`, `ui/project-share.tsx`, `ui/task-draft.tsx`

## Continuation outcome (2026-10-26)

| Issue | Outcome and evidence |
| --- | --- |
| t13-3, t14-9, S05-3 | Fixed the installed local address to 4317, including validation and docs. Handoff checks saved connections by server identity and matching username before showing credentials. Chrome contributor → local handoff and already-linked re-entry pass without secrets in the URL. The default address is asserted but never opened against the live instance. The dialog padding regression is fixed and visually checked. |
| t13-4 | The hosting wizard remembers its selected project per target, validates it against current projects, then falls back to configured/current/first projects. Chrome close, reopen and reload preserve the selected project. It deliberately starts at Project for review; unsaved form fields and the last step are not promised. |
| t14-11 | Known loopback aliases compare equally before enrollment, within the serialized connection mutation. Actual transport/TLS URLs stay unchanged. Unit checks cover localhost, IPv4, IPv6, concurrent submissions and different ports; Chrome refuses the alias with 409 and verifies runner count is unchanged. |
| t14-14, S15-6, S06-4 | Retained the intended multiple-connection behavior: local tasks remain usable after enrollment. Removed unreachable connect/disconnect implementations in link-api and corrected both API tables. Chrome creates a local task, connects a team and rereads the task from the local board. Existing unit expectations now assert the lower-level handler does not own these routes; real HTTP uses the authoritative server router. |
| t14-8, S06-3 | Connection loading records a fault rather than terminating the whole server. Both legacy files are preserved byte-for-byte; all team connection operations report 503 with both paths and manual repair instructions. Core health, runs and project creation remain available. This is conservative degradation of all team connections, not an automatic choice or per-connection recovery. Chrome and units verify it, including identical conflicting files. |
| t13-17 | Hosting setup and first Share save known clone mappings for the target computer, preserving existing explicit mappings. Remote setup accepts only paths belonging to that host's projects. Failed mappings produce a persistent warning while keeping saved repository metadata. Actual Chrome Draft, Build and Fetch forms prefill the clone; a fake-agent build produces the checkpoint used to open Fetch. First Share is separately exercised through invitation creation and Draft. Existing manual mappings already worked, so the original “never” was overstated. |

Validation: typecheck; 43 related unit/API checks (6 new); 5 new real-Chrome scenarios; all 10 original team-onboarding Chrome scenarios. The new browser suite captures page exceptions, API errors, console warnings/errors and all three server logs. Only deliberate duplicate 409 and legacy-conflict 503 messages appeared; no unhandled page/server errors. Screenshots of the handoff dialog and legacy repair UI were visually inspected. All runs used scratch repositories, homes, tokens and fake CLIs; no real-agent evidence is claimed. Child servers are stopped by their own PIDs and fixture state is removed.

Evidence: `/private/tmp/codeflow-qa-continue/connect39-related-final.log`, `connect39-typecheck-final.log`, `connect39-e2e-final.log`, `connect39-original-ui.log`, and `connect39-shots/` (screenshots, browser-console.json, hub/computer/broken logs). Test fixtures use dynamically allocated isolated ports; no requests target live 4317/4318.

## Issues

### t13-3 · minor · Default 'Local Code Flow address' is http://localhost:4318 (dev-mode/network port) instead of the normal local port 4317

Source: tester unit human-collaboration-1; observed with code-reading; features COL-06, COL-01.

**Repro**

> 1. As a contributor on the shared board, click 'Set up this computer for coding'.
> 2. Look at the prefilled Local Code Flow address.

**Expected:** http://localhost:4317 (the port npm start uses; README and getting-started use 4317).

**Actual:** http://localhost:4318, which is the dev-mode port or the network listener of a default install (that listener refuses same-machine connections). Docs (team-collaboration.md 'Share a project…') repeat 4318.

**Root cause (verifier):** ui/connect-computer.tsx:13 hardcodes the field's starting value: `const [local, setLocal] = useState("http://localhost:4318")`. That port belongs to the dev server (package.json:22-23 `PORT=4318 ... scripts/dev.mjs`), and on a default install it is the network/remote listener (src/server.ts:291 `REMOTE_PORT = envNumber("CODEFLOW_REMOTE_PORT", PORT + 1)`), which refuses connections from the same computer (src/server.ts:1161). The normal local port is 4317 (src/config.ts:43 `PORT = envNumber("PORT", 4317, ...)`; bin/launcher.mjs:29). The same wrong example port also appears in:
- the validation error message at ui/team-join-link.ts:22 ("such as http://localhost:4318")
- the docs at docs/team-collaboration.md:269 ("the default is `http://localhost:4318`")

ui/team-server-wizard.tsx:22 also uses 4318, but there it is the team server's remote port, so it is not this bug.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/connect-computer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team-join-link.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-invitations.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/team-onboarding.e2e.ts`

**Suggested fix:** Export a shared constant from ui/team-join-link.ts, such as `export const DEFAULT_LOCAL_CODEFLOW = "http://localhost:4317"`, the address `npm start` and the launcher print. Use it as the starting value at ui/connect-computer.tsx:13 and in the example in the ui/team-join-link.ts:22 error message. Change docs/team-collaboration.md:269 to say the default is `http://localhost:4317` (the address Code Flow prints at startup), and note that the desktop app and `--port`/`PORT` use other ports. Optionally, remember the last address the user submitted in localStorage, wrapped in try/catch, so people on a non-default port only type it once.

**Suggested regression test:** Unit test in test/project-invitations.test.ts: assert DEFAULT_LOCAL_CODEFLOW === "http://localhost:4317", that it equals `http://localhost:${4317}` (the src/config.ts PORT fallback with no PORT env), and that computerSetupLink(DEFAULT_LOCAL_CODEFLOW, connection) is accepted. Browser test in test/e2e/team-onboarding.e2e.ts near line 101: after clicking "Set up this computer for coding", assert `await setup.getByLabel("Local Code Flow address", { exact: true }).inputValue() === "http://localhost:4 …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server v4609 on 127.0.0.1:4609 with an empty home (0 runs, no shared accounts, remote access off). As the owner I created a test account "carol" through /api/accounts, using a random password and the contributor role on MQTT-MCP (p-ef01794b). In a fresh headless Chrome with no owner cookie I opened http://127.0.0.1:4609/, signed in as carol on the "Sign in to shared projects" form, opened #/team/project/p-ef01794b and clicked "Set up this computer for coding". The "Connect this computer" dialog's "Local Code Flow address" field read http://localhost:4318. I ran this twice (scripts /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4609/t13-3.mjs and t13-3b.mjs, logs t13-3.log and t13-3b.log in the same folder) and got the same value both times. The screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4609/t13-3-dialog2.png shows the field prefilled with http://localhost:4318 under the help text "Use the address printed when Code Flow starts". No console errors. I did not click "Open local Code Flow" with the default address, because on this machine localhost:4318 is the user's live server. As a stand-in, my server's own PORT+1 with remote access off (curl localhost:4610) refused the connection (curl exit 7). I stopped the server afterwards. I created no runs, and I left no listeners or clones behind.

Why this is not by design and not caused by the tester's setup: every way a user normally starts Code Flow runs the main server on 4317 or on a random port, never on 4318.
- bin/launcher.mjs:29 defaults to 4317.
- src/config.ts:43 has PORT = 4317.
- The VS Code extension defaults to http://127.0.0.1:4317 (integrations/vscode/package.json:24).
- The desktop app picks a free port (integrations/desktop/main.cjs:66).
- Startup prints "Open http://localhost:${PORT}" (src/server.ts:2811-2812), so a default install prints 4317. README and getting-started also say 4317.
- Only `npm run dev` and `dev:real` (package.json:22-23, PORT=4318) serve on 4318, and docs/getting-started.md:74 and docs/architecture.md:93 call those development servers.
- On a default install, 4318 is the network listener (src/server.ts:291 REMOTE_PORT = PORT+1). That listener is either off, giving connection refused, or it drops connections from this computer (src/server.ts:1161 calls socket.destroy() when isOwnAd …

</details>

### t14-9 · minor · 'Connect this computer' dialog defaults to http://localhost:4318 (dev port) and does not recognise an existing connection

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-34.

**Repro**

> 1. Sign in to the hub as a shared contributor and open a task → Team server area → 'Connect this computer'.
> 2. Note the default 'Local Code Flow address'.
> 3. On a computer already linked to this hub, open it with the real port.

**Expected:** The default matches a normal install (PORT default 4317, docs/getting-started.md:56). When the server is already saved, the handoff selects that connection.

**Actual:** The default is http://localhost:4318 (the dev port, or a normal install's phone listener). On an already-linked computer the handoff opens team=local with a blank 'Connect to your team' form prefilled with server and username; submitting gives 'This team server is already saved'. Positive: the handoff carries only server, username and project, with no secrets.

**Root cause (verifier):** Two separate defects.

1. Wrong default port. ui/connect-computer.tsx:13 initialises the address with `useState("http://localhost:4318")`. The validation error at ui/team-join-link.ts:22 also cites "such as http://localhost:4318", and docs/team-collaboration.md:269 repeats the dev port. The server's normal port is 4317 (PORT default, docs/configuration.md:97). On a normal install, 4318 is the network-only remote listener (src/server.ts:291, :1179).

2. The handoff ignores an existing connection. ui/team-join-link.ts:24 (`computerSetupLink`) always builds `${local.origin}/?team=local#/settings/connections/join?connection=...`. On the receiving side, ui/lib.ts:22 pins `selectedTeamConnection` to "local" from the query string. `TeamJoinSettings` / `ThisComputerCard` (ui/collab-settings.tsx:45-50 and :60-108) then render the unlinked "Connect to your team" form for the local link. Nothing compares the hint's hub origin (`parseTeamAddress(connection).url`) with the linked entries from /api/team-link/connections. Submitting posts a second connect, which src/collab/connections.ts:70 refuses with 409 "This team server is already saved; select it from your team connections". The hub cannot  …

**Files:** `ui/connect-computer.tsx`, `ui/team-join-link.ts`, `ui/collab-settings.tsx`, `docs/team-collaboration.md`, `test/project-invitations.test.ts`, `test/e2e/team-onboarding.e2e.ts`

**Suggested fix:** 1. Default port
- Change ui/connect-computer.tsx:13 to "http://localhost:4317", the PORT default printed by `npm start`.
- Optionally remember the last address the user opened in localStorage, wrapped in try/catch, so people on non-default ports (including dev on 4318) do not retype it.
- Update the example in the ui/team-join-link.ts:22 error and the default stated in docs/team-collaboration.md:269.

2. Select the saved connection on the receiving side
- Add a pure helper next to `parseTeamAddress` in ui/team-join-link.ts, e.g. `savedConnectionFor(connections, connectionHint)`. It returns the id of a `linked` connection whose `url` equals `parseTeamAddress(hint).url`, preferring one whose `user.username` matches the hint's username.
- In `TeamJoinSettings` (ui/collab-settings.tsx:45), when a `connection` hint is present and `selectedTeamConnection` is "local", fetch /api/team-link/connections once. If a match exists, call `selectTeamConnection(id)`; it already keeps `#/settings/...` h …

**Suggested regression test:** Unit, in test/project-invitations.test.ts:
- Assert `savedConnectionFor([{id:"local",linked:false},{id:"c-1",linked:true,url:"https://hub.example:4318",user:{username:"alice"}}], teamConnectionLink("https://hub.example:4318","alice","p-shared"))` returns "c-1".
- Assert it returns undefined for a different hub origin and for unlinked entries.

E2E, in test/e2e/team-onboarding.e2e.ts:
- Near line 102, assert the "Local Code Flow address" input's default value is "http://localhost:4317".
- After t …

<details><summary>Verifier's independent reproduction</summary>

I started two fresh fake-mode QA servers with new homes. The hub was v4647x on 127.0.0.1:4647. The contributor's computer was v4647z on 127.0.0.1:4699, because my assigned extra port 4649 was already held by another verifier's server (v4649h), which I did not touch. On the hub, through the API, I created project "V4647 Shared" (p-65b9f989) on a scratch git repo with repository key "scratch". I also created a contributor account alice with a random password and task t-8768721623d0a360 owned by alice. Precondition: POST /api/team-link/connect on the computer with url http://127.0.0.1:4647 returned 201 and saved linked connection c-5b3d0beb7cd07373.

Then I drove the UI with Playwright (scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4647x/repro.mjs; log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4647x/repro.log).

(1) In a fresh incognito browser, alice signed in on the hub with the shared sign-in form and opened the task. Under "Where should this task run?" I clicked "Connect this computer". The "Local Code Flow address" field was prefilled with http://localhost:4318 (screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4647x/01-hub-dialog-default.png).

(2) I changed the address to http://127.0.0.1:4699 and clicked "Open local Code Flow". It navigated to http://127.0.0.1:4699/?team=local#/settings/connections/join?connection=http%3A%2F%2F127.0.0.1%3A4647%2F%23%2Fconnect%3Fusername%3Dalice%26project%3Dp-65b9f989. The link carried no token, password or invitation; the reporter's positive note holds.

(3) I opened that link in the computer owner's browser, signed in with the token. The Team connection picker showed "This computer's own board", although the option "mx · alice · connected" existed. Below it was a blank "Connect to your team" form, prefilled with the server URL and username alice. The "Your team projects" card was absent (screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4647x/02-pc-handoff-landing.png).

(4) I entered the password and clicked "Connect this computer". The response was 409 POST /api/team-link/connect?teamConnection=local, and the page showed the alert "This team server is already saved; select it from  …

</details>

### S05-3 · minor · The 'Connect this computer' dialog defaults the teammate's local Code Flow address to http://localhost:4318, while default installs listen on 4317, so 'Open local Code Flow' lands on the wrong listener for normal installs.

Source: code-level suspect at `ui/connect-computer.tsx:13` (confirmed hands-on).

**Repro**

> Fake-mode s05: created a test contributor account (POST /api/accounts) and signed in as it in a fresh browser at http://127.0.0.1:4521/. Board → #/team/project/<id> → 'Set up this computer for coding'. The 'Local Code Flow address' field is prefilled with http://localhost:4318. Clicking 'Open local Code Flow' navigates to http://localhost:4318/?team=local#/settings/connections/join?connection=…. I intercepted and aborted that navigation so it never reached the user's live 4318 listener. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s05/tm-connect-dialog.png. Side observation, not part of this suspect: in this dialog, '.team-setup-fields { padding: 0 }' overrides '.dialog-body' padding, so the steps, label and input sit flush against the dialog's left and right edges (computed padding 0px).

**Expected:** The prefilled address matches what a normal install prints (http://localhost:4317), or the dialog detects the local instance, so one click opens the teammate's own Code Flow.

**Actual:** The prefilled address is localhost:4318. For default npm start or launcher installs this is connection refused, because the network listener refuses loopback. On developer machines it is the dev server or another instance. Users must notice and edit the port.

**Root cause (verifier):** ComputerSetup uses useState('http://localhost:4318'). The standard installs listen elsewhere: `npm start` and the `codeflow` launcher on 4317 (src/config.ts:43 PORT default; bin/launcher.mjs 'default: PORT or 4317'), and the desktop app on a random free port. 4318 is only used by `npm run dev`/`dev:real` and by the network listener at PORT+1. That listener binds to a LAN or Tailscale address, not loopback, and destroys connections from the machine's own addresses (server.ts:1160), so localhost:4318 never reaches a normal install. The team-server wizard and SSH projects use 4318 for a separately installed team server, which is probably where the value came from. The same wrong example is repeated in team-join-link.ts:22 and docs/team-collaboration.md:269.

**Suggested fix:** Change the default to http://localhost:4317, the documented and launcher default. Update the example in ui/team-join-link.ts:22 and docs/team-collaboration.md:269 to match. Optionally try 4317 first with a short no-cors probe, or remember the last address used in localStorage.

**Suggested regression test:** A unit test asserting that the dialog's default local address port equals the launcher and config default (4317). For example, export the default constant from connect-computer.tsx and compare it with the PORT default in src/config.ts and bin/launcher.mjs. Plus a docs check that team-collaboration.md names the same default.

### t13-4 · minor · Host-a-team wizard does not resume the project being set up; reopening selects the first project in the list

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-03.

**Repro**

> 1. Settings → Connections → Share access → Host a team.
> 2. Step 1: 'Create a new project…' named 'T13 Team MQTT', Save and continue; save repositories; 'Set up access later'; 'Add teammates later'.
> 3. Close setup, reopen Host a team.

**Expected:** Setup reopens on the project that was set up (and ideally the step reached), as the docs' 'Saved steps remain if you close and reopen setup' suggests.

**Actual:** Step 1 reopens with Project = OPCUA-MCP (the first project), not 'T13 Team MQTT'. Clicking Save and continue would start configuring a different, unrelated project; the steps can't be used until the project is reselected.

**Root cause (verifier):** In ui/team-server-wizard.tsx, TeamServerWizard (lines 19-86) mounts TeamServerSteps (lines 88+). TeamServerSteps keeps all its state locally:
- `useState(0)` for the step (line 91)
- `useState("")` for the project id (line 95)

Close setup unmounts it. In ui/connections.tsx:36, onClose sets the hash to #/settings/connections/sharing; in ui/collab-settings.tsx:29 it calls setSetup(false). Either way, reopening builds a fresh component.

On load, ui/team-server-wizard.tsx:132 runs `if (!projectId && nextProjects.length) setProjectId(nextProjects[0]!.id);`. That picks whichever project is first in /api/projects, which is registration order, so OPCUA-MCP. A project created in the wizard is appended at the end (line 144: `setProjects((current) => [...current, chosen!])`).

Nothing remembers the last project chosen in the wizard, and load() ignores the board it has just fetched (`nextBoard.projects[].repositories`), even though that shows which project actually has team setup. The step button handler (line 186) then loads the selected project's repositories, which is why step 2 shows OPCUA-MCP's blank "App" row.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team-server-wizard.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/team.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`

**Suggested fix:** 1. Remember the wizard's project per target. Keep it in a module-level Map keyed by `prefix || "local"`, or in sessionStorage/localStorage under a key like `teamWizardProject:<target>`, wrapped in try/catch. Write it whenever step 0 saves (in next(), after `chosen` is known) and whenever the Project select changes to an existing project.

2. In load() (line 132), replace the first-project default with a helper, for example `initialWizardProject(nextProjects, nextBoard, remembered, currentProjectForLocal)`. It returns the first of these that still exists in nextProjects:
   - the remembered id
   - the last board project that has team repositories configured
   - for the local target only, the app's currentProject
   - nextProjects[0]

3. Optionally restore progress too: remember the last step, or open on step 5 (Share) when the remembered project already has repositories, since the "Edit …" buttons there make it a natural resume point.

4. Clarify the docs sentence at docs/team-collabo …

**Suggested regression test:** In test/e2e/team.e2e.ts, in the test "the hosting wizard configures the local board even from another team and honestly reports incomplete access", after Close setup and clicking "Set up team server" again:
- Remove `selectOption(added.id)` (line 502).
- Add `assert.equal(await wizard.getByLabel("Project", { exact: true }).inputValue(), added.id, "reopening resumes the project being set up")`.
- Keep the existing Save and continue check that "Repository name" is "Service".

Also add a focused un …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4611t13, port 4611). I did not reuse the old v4611 home, because it already had team state from an earlier session. I drove the UI with a fresh headless Chrome using /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4611t13/r1.mjs; output is in r1.log in the same folder.

Steps:
1. Opened Settings → Connections → Share access → Host a team. Step 1 already had Project = OPCUA-MCP selected.
2. Set name to "Hub Owner", chose "Create a new project…", named it "T13 Team MQTT" with an empty folder, and clicked Save and continue.
3. Entered Repository name "MQTT" and clicked Save repositories and continue.
4. Clicked Set up access later, then Add teammates later. The review showed "Project: T13 Team MQTT | Repositories: MQTT".
5. Clicked Close setup, which returns to #/settings/connections/sharing, then clicked Host a team again.

What I saw after reopening:
- Heading is "Step 1 of 5: Project". The name field keeps "Hub Owner" (it is loaded from the board profile).
- The Project select shows OPCUA-MCP, and the help text reads "Use OPCUA-MCP and keep its existing settings and members." Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4611t13/003-reopen.png
- Clicking the "2 Repositories" step without reselecting shows a blank "App" row for OPCUA-MCP. Saving there would put a repository on the wrong project.
- After reselecting T13 Team MQTT and clicking Save and continue, the saved "MQTT" repository appears. So the saved server settings do persist; only the project choice is lost.
- /api/projects lists the new project last (OPCUA-MCP … industriHealth / T13 Team MQTT). The board shows only T13 Team MQTT with repositories ([mqtt]), so the wizard had enough data to choose a better default.
- No console errors or 5xx responses.

What partly argues against the report:
- The docs line "Saved steps remain if you close and reopen setup" (docs/team-collaboration.md:53) and the wizard text "Saved settings stay in place when you close setup" (ui/team-server-wizard.tsx:183) only promise that saved server state persists, and it does.
- The existing e2e test (test/e2e/team.e2e.ts:502) reselects the project after reopening before it checks that the reposito …

</details>

### t14-11 · minor · The same team server can be saved twice via a host alias (127.0.0.1 vs localhost), creating two runners for one machine

Source: tester unit human-collaboration-2; observed with api; features COL-29.

**Repro**

> 1. t14b already linked to http://127.0.0.1:4419 as alice.
> 2. Connect again to http://localhost:4419 as alice.

**Expected:** Refused as 'already saved' (same server), as with the exact URL.

**Actual:** 201: a second connection with its own runner (two 'alice-mbp' runners online on the hub). Unscoped requests then return 409, and repository mappings and attempts are split across connections.

**Root cause (verifier):** - src/collab/connections.ts:70 (the reporter cited line 73): `if (this.all().some(({ link }) => link.linked && link.url === url))` compares raw origin strings.
- `url` comes from validateHubUrl (src/collab/link.ts:52-59), which returns `new URL(value).origin`. That function accepts http for any of `LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "[::1]"}` (link.ts:38, 57) but never maps those names onto one form.
- So http://127.0.0.1:4653, http://localhost:4653 and http://[::1]:4653 all pass validation as different origins, and the duplicate check never fires.
- TeamLink.connect (link.ts:148-158) then enrols again at the hub's /api/team/runners/connect. The hub has no per-user or per-machine uniqueness and mints a second runner credential.
- The hub's 201 body (src/collab/api.ts:205) carries only `hub.name` and the user, with no stable hub id, so the client has nothing else to compare.
- The existing test (test/team-connections.test.ts:43) only covers a trailing-slash variant of the same hostname.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/connections.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/link.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/team-connections.test.ts`

**Suggested fix:** Main fix (verified in my snapshot):
- In link.ts, export an identity helper next to validateHubUrl:
  `export function hubIdentity(origin: string): string { const url = new URL(origin); if (LOOPBACK_HOSTS.has(url.hostname)) url.hostname = "127.0.0.1"; return url.origin; }`
- In connections.ts:70, compare `hubIdentity(link.url) === hubIdentity(url)` instead of `link.url === url`.
- Keep the stored URL as the user typed it. Only the comparison key changes, so existing saved links and the address used for requests stay the same.

Optional backstop for non-loopback aliases (an https DNS name vs a tailnet name vs an IP) and for names that are already saved twice:
- After enrolment, if the returned `user.userId` (a random `u-<uuid>` per hub account) equals an existing linked connection's user.userId, revoke the freshly minted runner (DELETE /api/team/runners/:id) and refuse with the same 409.
- Alternatively, have the hub return a stable hub instance id in the connect response and compare th …

**Suggested regression test:** In test/team-connections.test.ts, using the existing fixture():
1. Connect `http://127.0.0.1:4419`.
2. `await assert.rejects(connections.connect({ url }), /already saved/)` for each of `http://localhost:4419`, `http://[::1]:4419` and `http://LOCALHOST:4419/`.
3. Assert that only one `/runners/connect` request was sent ("aliases never mint a second runner credential").
4. Assert that `connections.inventory()` holds exactly one non-local connection.
5. Add a positive case: `http://localhost:4421`  …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server "v4651b" on 127.0.0.1:4653 with a fresh home. My assigned port 4651 was already held by another verifier's server (home v4649m), so I didn't touch it. Because the duplicate check runs only on the connecting side, this server also acted as its own team server.

Setup, through the API (script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4651/setup.mjs):
- created project p-bc1b5b4f on a throwaway `git init` repo
- created shared account "alice" (random password) with the contributor role

Feature steps, through the UI at /#/settings/connections/join (script .../work/v4651/alias-ui.mjs; logs alias-ui.log and alias-ui2.log in the same folder):
1. Connected http://127.0.0.1:4653 as alice, machine "alice-mbp". Saved as c-1345e19b926d17be with runner r-bd916aab950ac2f4, connected.
2. Control: "Add team connection" with http://127.0.0.1:4653/ was refused with 409 "This team server is already saved; select it from your team connections", shown as an alert. Exact duplicates are caught correctly.
3. "Add team connection" with http://localhost:4653 returned **201** with no alert. It created c-44f146a5e25a1f44 with runner r-7cc34233a48c5f30.

Results:
- `GET /api/team-link/connections` listed two linked connections for the same server (http://127.0.0.1:4653 and http://localhost:4653).
- The server's own runner list (`GET /api/team/runners?teamConnection=local`) showed two "alice-mbp" runners for the same userId, both online.
- Unscoped `GET /api/team/board` and `/api/team/runners` now returned 409 "Choose a team connection before opening its board".
- In the UI, the "Team connection" picker showed two identical options, "mx · alice · connected", which can't be told apart (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4651b/004-after-alias.png).

Unit-level check in my snapshot (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4651): a new test, test/team-connections-alias.test.ts, connects http://127.0.0.1:4419 and then tries localhost, [::1] and LOCALHOST aliases. On the current code it fails with "Missing expected rejection: http://localhost:4419". With the fix below applied in the snapshot, it passes together with the existing test/team-connections.test.ts (4/4).

Why this is not by design: do …

</details>

### t14-14 · cosmetic · Docs say connecting is refused while the local board has tasks; the code never refuses (dead check)

Source: tester unit human-collaboration-2; observed with fake-agents; features COL-29.

**Repro**

> 1. On a teammate instance, create a project with a repo key and a task on its own board.
> 2. Connect it to a hub (Settings → Connections → Join a team).

**Expected:** Docs and code agree. The docs API table (team-collaboration.md:236) says '409 … while the local board has tasks'; line 111 says 'Your own board remains available even when it holds tasks'.

**Actual:** The connection succeeds and the local task stays. The refusal in link-api.ts is unreachable because the server handles /api/team-link/connect itself.

**Root cause (verifier):** src/server.ts:1809-1813 matches `parts[1]==="team-link" && parts[2]==="connect" && parts.length===3 && POST` and answers directly through `teamConnections.connect()` (src/collab/connections.ts:65-74). That function only refuses a duplicate URL or more than 20 servers. The other `/api/team-link/*` routes go to `handleTeamLinkApi` at server.ts:1823, which is never reached for connect, so the connect branch in src/collab/link-api.ts:101-108 is dead in production. That branch holds the "already connected" refusal (line 103), the local-board-has-tasks refusal (line 104), the `onLinkChanged` call and the reconcile kick. Aliases do not reach it either, because `/api/v1/...` is canonicalised at server.ts:1499 first.

The docs were half-updated in PR #33 (8afda6c). Prose at docs/team-collaboration.md:108 says "Your own board remains available even when it holds tasks" and "Adding the same server twice is refused". The API table rows still say "refused (409) while already connected or while the local board has tasks": docs/team-collaboration.md:233 (the issue's ":236" is off by a few lines) and the same row in docs/api.md:343. Both phrases are wrong now, since several teams can be saved and  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/collab/link-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/collab-runner.test.ts`

**Suggested fix:** Keep the current behaviour, which PR #33 intended, and align the docs and code with it.
1. In the API table rows of docs/team-collaboration.md:233 and docs/api.md:343, replace "refused (409) while already connected or while the local board has tasks" with something like "adds a saved team connection (up to 20); refused (409) when the same server is already saved or 20 are saved; the local board and its tasks stay available; returns the new connection `id`". Then regenerate public/docs.
2. Delete the dead `head === "connect"` branch in src/collab/link-api.ts:101-108, so a connect that reaches `handleTeamLinkApi` falls through to the 404 "Unknown team link operation". Alternatively, make server.ts the only owner of connect and add a comment there. Note that the live path never calls `onLinkChanged`; the multi-connection design relies on `onEvent(id, {type:"resync"})` and `watch()` instead, so nothing is lost.
3. Update test/collab-runner.test.ts:441/458-460: drop the local-board refusal  …

**Suggested regression test:** Add a server-level test that goes through the real HTTP router, not `handleTeamLinkApi`, for example in test/collab-link.test.ts, which already starts hub and linked servers.
- Create a task on the linked instance's local board, then POST /api/team-link/connect to a loopback hub. Assert 201 with a `c-…` id.
- Assert that GET /api/team/tasks/<id>?teamConnection=local still returns 200 afterwards.
- Assert that a second connect to the same URL returns 409 matching /already saved/.

Optionally add  …

<details><summary>Verifier's independent reproduction</summary>

I started two fresh fake-mode servers. The hub was v4657h on 127.0.0.1:4659. The teammate was v4657 on 127.0.0.1:4657, with a fresh home; the old home was moved aside to homes/v4657-prev-*. Port 4657 was briefly held by another agent's server (home v4655kb), so I waited about 140 s until it was released.
1. Hub (work/v4657/h00-hub.mjs): created project "V4657 Team MQTT" on a scratch clone of MQTT-MCP and account alice as contributor, with a random password.
2. Teammate (work/v4657/t01-connect.mjs): created local project "Mate local" on a second scratch clone, set repository key "mine" (PUT 200), and created task "Local only task" (201, t-6fca38d6b8473e10). The local board had 1 task; connections were only [local].
3. In the UI at #/settings/connections/join I filled in Team server URL http://127.0.0.1:4659, alice, the password and machine name mate-mbp, then clicked "Connect this computer". No alert appeared and the page navigated to the connected state.
4. Afterwards (t02-after.mjs):
   - /api/team-link/connections listed local plus c-7ab0d10bb6f18867 (linked, alice, mate-mbp).
   - GET /api/team/tasks/t-6fca...?teamConnection=local returned 200 "Local only task".
   - The hub's /api/team/runners listed mate-mbp as online.
   - The UI board at ?team=local#/team still showed the card "Local only task" (screenshot shots/v4657/002-local-board-after.png). There were no console or 5xx errors.
5. t03-dup.mjs: a second POST /api/team-link/connect to the same hub returned 409 "This team server is already saved; select it from your team connections". A body with an extra field returned 400 "Unknown connection field". Both are the wording of server.ts / connections.ts, not link-api.ts, which would say "already connected … disconnect it first", "holds 1 task", or "Unknown connect field". So the link-api connect branch never runs.

Current behaviour is intended: commit 8afda6c (PR #33, multiple team connections) deliberately replaced the old prose "Linking is refused (409) … while its own board holds tasks" with "Your own board remains available even when it holds tasks." Only the API table rows and the dead link-api branch were left behind, so the defect is the stale docs and code, not the connect behaviour.

Cleanup: I disconnected the test link (DELETE /api/team-link?teamConnection=c-7ab0..., which revokes the runner), stopped v4657 and v4657h (ports 4657-4660 are free), and removed the scratch clones v4657-mqtt{.git,-hub,-mate}. No runs were created. Leftovers: h …

</details>

### S15-6 · minor · link-api's POST /api/team-link/connect and DELETE /api/team-link handlers (including the 'local board holds N tasks' refusal) are shadowed by server.ts, which routes them to TeamConnections. That code is dead, and the two paths have drifted.

Source: code-level suspect at `src/collab/link-api.ts:101` (confirmed hands-on).

**Repro**

> QA server s15 (fake). Defined repository key 'app' on local project p-3b74eba4 and created a local board task (POST /api/team/tasks → 201), so the board holds 1 task. POST /api/team-link/connect {url:'http://127.0.0.1:4563',username:'alice',password:<random>} → 502 'The team server at http://127.0.0.1:4563 is unreachable (ECONNREFUSED...)'. The server went to the network, and the 409 'holds 1 task' check that link-api performs 'before the network is touched' never ran. DELETE /api/team-link with no remote connection → 409 'The local board cannot be disconnected', while link-api (and its unit test) returns 200 {linked:false}. Meanwhile `npx tsx --test --test-name-pattern='refuses linking while the local board has tasks' test/collab-runner.test.ts` passes in snapshot s15, so the test certifies unreachable behaviour. (Script: qa/work/s15/s5-teamlink.mjs)

**Expected:** One implementation of connect/disconnect, with tests and API docs that describe what the server does.

**Actual:** Two divergent implementations. The tested one (link-api) is unreachable in production, and the API tables document the dead behaviour.

**Root cause (verifier):** server.ts (around line 1809) handles POST /api/team-link/connect with teamConnections.connect() and DELETE /api/team-link (parts.length===2) with teamConnections.disconnect() before it ever calls handleTeamLinkApi. The multi-connection design is intended (docs/team-collaboration.md:108: 'Your own board remains available even when it holds tasks'). However, dispatch() in link-api still implements the old single-link refusals, test/collab-runner.test.ts:458-461 still asserts them by calling handleTeamLinkApi directly, and the API tables (docs/api.md:343 and docs/team-collaboration.md:233) still say connect is 'refused (409) while already connected or while the local board has tasks'. Disconnect has drifted as well: link-api returns 200 {linked:false} for an unlinked DELETE, but the server returns 409.

**Suggested fix:** Remove the head===undefined DELETE branch and the connect branch from link-api dispatch() (letting them fall through to 404, or asserting that they are handled upstream). Move the connect/disconnect assertions in collab-runner.test.ts to a server-level test against TeamConnections (collab-link.test.ts already covers connect). Update the docs/api.md:343 and docs/team-collaboration.md:233 rows: no 409 while the local board has tasks, 409 'already saved' for a duplicate URL, and DELETE requires ?teamConnection when there are several connections.

**Suggested regression test:** Server-level test (collab-link.test.ts harness): with a task on the local board, POST /api/team-link/connect to a live test hub returns 201, and DELETE /api/team-link with no remote connection returns 409 'The local board cannot be disconnected'.

### S06-4 · minor · POST /api/team-link/connect never refuses when the local board has tasks. The documented 409 exists only in link-api.ts and is unreachable, and the docs contradict themselves.

Source: code-level suspect at `src/server.ts:1809` (confirmed hands-on).

**Repro**

> Fake servers s06 (4525) and s06b hub (4527). On the hub, created project 'S06 Hub' and a contributor account qa-alice with a random password. On s06: PUT /api/team/projects/p-22713d2a/repositories?teamConnection=local, then POST /api/team/tasks?teamConnection=local → 201, board tasks=1. POST /api/team-link/connect {url:'http://127.0.0.1:4527', username:'qa-alice', ...} returned 201 with id c-5aacd55a1b8a9f0e and linked:true, not the documented 409. The local board still had 1 task. Disconnected afterwards (200). Log: work/s06/connect.log.

**Expected:** The API documentation and the implementation agree. The intended (current) behaviour is to allow connecting while the local board holds tasks, so the API tables should say so, the unreachable branch should be removed, and the test should target the real route.

**Actual:** The docs promise a 409 refusal ('while already connected or while the local board has tasks') that the server never returns. Dead code and a test that exercises only that dead code keep the stale contract looking valid.

**Root cause (verifier):** server.ts handles `team-link/connect` itself and calls TeamConnections.connect. That method only refuses a URL that is already saved or a 21st connection. The local-board-has-tasks and already-connected refusals in src/collab/link-api.ts:101-108 are no longer reachable from the server. The behaviour matches the newer prose (docs/team-collaboration.md:108 'Your own board remains available even when it holds tasks'). The API tables in docs/team-collaboration.md:233 and docs/api.md:343 still say 'refused (409) while already connected or while the local board has tasks'. test/collab-runner.test.ts:440 still asserts the 409 by calling handleTeamLinkApi directly, so it covers the dead path and not the real route.

**Suggested fix:** Update docs/api.md:343 and docs/team-collaboration.md:233. Connect adds a saved connection; 409 only for a URL that is already saved or more than 20 connections; the local board is unaffected. Delete the connect branch in link-api.ts dispatch, or route the server through it. Rewrite the collab-runner test to call the server/TeamConnections path and assert that connect succeeds with local tasks present and that a duplicate URL returns 409.

**Suggested regression test:** API test against TeamConnections/server: with one local board task, connect to a loopback hub returns 201, the local board keeps its task, and connecting the same URL again returns 409 'already saved'. A docs lint/grep test can check that the API table no longer mentions the local-board refusal.

### t14-8 · minor · Both legacy link files present → the whole server exits with an uncaught exception

Source: tester unit human-collaboration-2; observed with api; features COL-31.

**Repro**

> 1. Fresh home with a linked team-link.json; start it. It migrates to team-connections/legacy.json.
> 2. Stop it, put a linked team-link.json back next to legacy.json (e.g. restored from a backup or copied), start again.

**Expected:** Team connections are reported unavailable with the two file paths named, while the rest of Code Flow (runs, projects) still starts. Other unreadable team stores degrade to 503 the same way.

**Actual:** The server never becomes healthy: 'code-flow: Uncaught exception: Both legacy team connection files exist; repair them before starting'. All features are down, and the message does not say which files to repair.

**Root cause (verifier):** The throw: src/collab/connections.ts:41-42. When team-link.json is linked and team-connections/legacy.json already exists, `load()` throws `new CollabError("Both legacy team connection files exist; repair them before starting", 503)`. The message has no paths, and the throw happens before `this.make("local", local)` at :46, so not even the local board entry is created.

The crash: src/server.ts:2742 `await teamConnections.load();` is a top-level await with no `.catch`, unlike the peer stores (sharedAccounts.load at :211, acpConnections at :2740, projectTeams at :2751, and others). The rejection goes to the generic uncaughtException handler (server.ts:152-153), which logs "Uncaught exception". Module evaluation stops before `createServer(...).listen` at server.ts:2808, so the process exits without ever listening.

A bare `.catch` in server.ts would not be enough. With no "local" entry, `teamConnections.get()` would return a misleading 404 ("choose a saved team in Settings → Team") for the local board, and hostExecution's `resolveRepo` (server.ts:225/253 → `get("local")`) would fail the same way.

**Files:** `src/collab/connections.ts`, `src/server.ts`, `test/team-connections.test.ts`, `test/server-reliability.test.ts`, `docs/team-collaboration.md`

**Suggested fix:** 1. In TeamConnections.load() (src/collab/connections.ts), stop throwing on the conflict:
   - If both files hold the same connection (same url and runnerId, or the bytes are equal), move team-link.json aside (for example `team-link.json.duplicate-<timestamp>`, 0600) and carry on. That handles the copied or restored case on its own.
   - Otherwise, record a fault such as `this.fault = \`Two saved copies of the legacy team connection exist: ${legacyFile} and ${join(directory, "legacy.json")}; keep the one you want, move the other out of ${this.home}, then restart code-flow\`` and leave both files untouched.
   - Still load the other `c-*.json` connections.
   - Do not build "local" from the linked team-link.json, because that would reuse the runner credential.
2. Have get()/use() for "legacy", "local" and unscoped selection throw `CollabError(this.fault, 503)` while the fault is set. Have inventory() expose the fault so Settings → Team can show it.
3. In src/server.ts:2742, add a safety  …

**Suggested regression test:** 1. test/team-connections.test.ts, new test "a leftover team-link.json next to a migrated legacy.json degrades team connections instead of throwing". Use `fixture(t)` and write `document("https://old-team.example")` to both team-link.json and team-connections/legacy.json, giving the second one a different runnerId. Assert:
   - `await connections.load()` resolves.
   - `connections.get("legacy")` and `connections.get()` throw CollabError with status 503, and the message matches both `team-link.js …

<details><summary>Verifier's independent reproduction</summary>

Fresh home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4645L. Port 4645 was already taken by another verifier's server (home v4643k7), so I used my extra port, 4647.
1. Before the first start I wrote a linked team-link.json by hand (mode 0600): version 1, url http://127.0.0.1:9, a random r-<16 hex> runnerId, a random tr-<43> token, a test user, empty mappings.
2. `qa-server.sh start v4645L 4647 fake` became healthy. team-link.json had moved to team-connections/legacy.json (0600). GET /api/team-link/connections listed `local` (unlinked) and `legacy` (linked, reconnecting, since nothing listens on that address). So the migration works.
3. `qa-server.sh stop v4645L`, then `cp -p team-connections/legacy.json team-link.json`. This puts back a linked legacy file next to legacy.json, as a restored or copied file would.
4. `qa-server.sh start v4645L 4647 fake` returned exit=1 with "server did not become healthy". The last line of server.out was `code-flow: Uncaught exception: Both legacy team connection files exist; repair them before starting`. The server.log stack was `TeamConnections.load (src/collab/connections.ts:42:48)` ← `src/server.ts:2742:1`. The process (pid 73603) exited and nothing was listening, so runs, projects and every other feature were down. The message names neither team-link.json nor team-connections/legacy.json.

I looked for a by-design reason and found none. docs/team-collaboration.md:112 only says team-link.json "is automatically moved"; no doc says the server refuses to start. The guard uses a CollabError with HTTP status 503, which is the per-feature "unavailable" pattern, not a deliberate startup refusal like acquireLock's `console.error` + `process.exit(1)` at server.ts:140-143. The comment at server.ts:147-149 says a stray throw must not take everything down. The neighbouring loads at server.ts:2740 and 2743-2779 (acpConnections, fileAccess, ml, projectTeams, teamTerminals, hostExecution) and sharedAccounts at :211 all catch and degrade. Only the phrase "before starting" hints at intent, and even then the missing file paths would still be a defect. The tester's environment did not cause this; the same steps fail deterministically. Real ways to reach this state: a hand copy or restore of team-link.json (backups leave it out), or running an older build (for example another worktree) on the same home, linking there, then going back to the new build.

</details>

### S06-3 · minor · `await teamConnections.load()` has no catch, so a 503 CollabError from TeamConnections.load (both team-link.json and team-connections/legacy.json present) stops the whole server from starting.

Source: code-level suspect at `src/server.ts:2742` (confirmed hands-on).

**Repro**

> Made a QA home s06x containing a linked team-link.json (url http://127.0.0.1:4599, runnerId r-0123456789abcdef, random tr- token, user, machineName) and a linked team-connections/legacy.json. Ran `qa-server.sh start s06x 4527 fake`. Result: 'server did not become healthy', the log showed only 'code-flow: Uncaught exception: Both legacy team connection files exist; repair them before starting', the process exited, and nothing listened on 4527. Runs, projects and every other non-team feature were unavailable.

**Expected:** As with the other optional stores, CodeFlow starts, logs a repair instruction that names both file paths, and keeps team connections unavailable. The local board and other connections could even load, while the team-link routes answer 503 with the repair message. The docs say other teams and the local board keep working.

**Actual:** The whole server refuses to start. The error is printed as an uncaught exception and gives no file paths.

**Root cause (verifier):** TeamConnections.load (src/collab/connections.ts:42) throws CollabError('Both legacy team connection files exist; repair them before starting', 503) when a linked team-link.json and team-connections/legacy.json both exist. The startup sequence awaits it at top level with no .catch. The neighbouring optional subsystems (acpConnections, projectTeams, teamTerminals, hostExecution, fileAccess) all catch, log and degrade. The process dies with only 'code-flow: Uncaught exception: …', and the message does not name the file paths. This state can occur when an older (single-link) build is reconnected on a migrated home, or when team-link.json is restored from a backup.

**Suggested fix:** Change the call to `await teamConnections.load().catch((error) => { teamConnections.fault = error.message; logError('Team connections unavailable; repair <home>/team-link.json and <home>/team-connections/legacy.json', error); })`. Have TeamConnections.get/connect/inventory throw that 503 while faulted. Alternatively, inside load(), skip only the conflicting legacy file, still register 'local' and the other c-*.json connections, and record the fault. Include both absolute paths in the message.

**Suggested regression test:** Server-level test: start with both files present, then assert /api/health returns 200, GET /api/team-link/connections returns 503 (or lists 'local' plus a fault) with a message naming both files, and /api/runs works.

### t13-17 · minor · On the team server, the repository path for Draft with agent and Fetch to this computer is never prefilled

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-15, COL-22.

**Repro**

> 1. On the hub owner's board choose 'Draft with agent' for a project whose repository is registered on this computer; or open a checkpoint's 'Fetch to this computer…'.

**Expected:** The project's registered clone (the folder the wizard used) is prefilled, as it is on linked computers through their mappings.

**Actual:** Empty 'Repository folder' / 'Repository path'; the owner must paste an absolute path.

**Root cause (verifier):** The three dialogs read their prefill correctly. They use only this computer's repository mappings, and on the hub the guided setup never creates one, even though it knows the folder.

Where the prefill comes from:
- ui/task-draft.tsx:15 `useState(teamLink.value?.mappings[projectId]?.[repository] ?? "")`
- ui/collab-task.tsx:122: the Fetch dialog's `initial=link?.mappings[...]`; line 121 (Accept and download) does the same.
- ui/collab-task.tsx:299: the Build dialog's `mapped = link?.mappings[...]`.
- On the server, src/collab/runner.ts:242-245 resolves a repository only from an explicit path or the mapping.

On an unlinked hub, the mappings are the local board's mappings, stored in team-link.json (docs/team-collaboration.md:112). They can be set under Settings → Share access → Manage → Repositories (ui/collab-settings.tsx:111-133). The e2e test at test/e2e/team.e2e.ts:84-99 maps by hand before the Draft test at :509-516. So mapping-driven prefill works on the hub by design, and the report's "never prefilled" overstates it.

What actually causes the gap:
- ui/team-server-wizard.tsx:115-118 stores the chosen folder as `sourcePath` on each row. Step 1's save (line 153) sends only key/ …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team-server-wizard.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-share.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/task-draft.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-task.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/team.e2e.ts`

**Suggested fix:** 1. Record the mapping when the folder is known (main fix).
   - Wizard, step 1: after the repository keys are saved, for each row that has a `sourcePath`, call PUT /api/team-link/mappings with {projectId, repository: key, path: sourcePath}.
   - Do this only when the wizard is configuring this computer's own board, or the path is among that host's own `/api/projects` repos, so a local path is never mapped onto an SSH team server.
   - If the project was just created from the "Local repository folder" field, map the first key to that folder.
   - Project Share dialog (`prepareRepositories`): map each generated key to its folder.
   - In both places, skip keys that already have a mapping, and treat failures as best effort. `setMapping` already checks that the folder is a Git repository.
   - Change the wizard text so the owner knows this computer's folder is remembered.
2. Add a fallback in the dialogs for boards set up before this fix. Write a small shared helper, e.g. `suggestedRepoPat …

**Suggested regression test:** test/e2e/team.e2e.ts: extend the test "the hosting wizard configures the local board even from another team…" (around line 462). Create the project with a real Git fixture folder in "Local repository folder (optional)" and pick it under "Existing repository 1". After saving step 2, assert that `(await api('/api/team-link')).mappings[added.id][key]` equals that folder. Then open Board → Draft with agent and assert that `getByLabel('Repository folder').inputValue()` equals the folder, without the  …

<details><summary>Verifier's independent reproduction</summary>

I reproduced the issue on a fresh fake-mode server: name v4637t1317, port 4637, a new home, and a scratch clone of MQTT-MCP at qa/clones/v4637t1317-mqtt. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4637t1317/ (s1–s4 .mjs/.log).

s1: In the UI I opened Settings → Connections → Host a team → Set up team server. Step 1: I created project "V4637 Prefill MQTT" with that clone as its local repository folder. Step 2: under "Use an existing repository" I picked the clone, then chose Save repositories and Close setup. What the server then held:
- /api/projects: the project's repos = [the clone].
- Board: repository key v4637t1317-mqtt.
- /api/team-link: linked=false, mappings={}.
- Board → Draft with agent: Repository folder = "" (placeholder /absolute/path/to/your/clone). "Use current repository" was disabled because this browser had no composer repository yet.

s2:
- I set the task's Owner to Hub Owner (you) and opened Build with agents: the "Repository path for v4637t1317-mqtt" field was also "". This third dialog isn't in the report.
- I typed the path and ran a fake solo attempt. It finished and published checkpoint 767427ae (bundle available).
- Fetch to this computer…: the Repository path was "" and Fetch stayed disabled (screenshot shots/v4637t1317/003-fetch-dialog-empty.png). Typing the path into Build with agents had not been remembered.
- Settings → Share access → Manage existing connections → Repositories showed this repository as "Choose a repository folder on this computer." with a "Use detected folder: <clone>" button.

s3: I clicked Use detected folder, then Save. Mappings became {p-becd2515:{v4637t1317-mqtt:<clone>}}. After that, Draft with agent, Build with agents and Fetch to this computer were all prefilled with the clone.

No console, page or 5xx errors. The result does not depend on the browser profile or test credentials: the prefill comes only from server-side mappings, which were empty.

</details>
