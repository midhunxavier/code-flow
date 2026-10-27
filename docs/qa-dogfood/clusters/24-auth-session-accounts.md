# Cluster 24 · auth-session-accounts

**Owner session cookie, sign-in pages and shared accounts**

Status: **fixed and verified** · 11 issue entries (9 distinct causes) · branch `codex/qa-auth-session-accounts`

Planner notes: The hot spot is sessionCookie() in src/server.ts (~357-412). The owner cookie name is not port-scoped, unlike the shared and phone cookies (t13-6/t01-4/S06-7). It has no Max-Age, so a fixed CODEFLOW_TOKEN doesn't survive a browser restart (t01-11). It is SameSite=Strict, so the hub-started 'Set up this computer' handoff lands on the lock page (t13-2, ui/connect-computer.tsx:21, ui/team-join-link.ts). Migrate the cookie name so existing sessions don't all break at once. t01-10: an old or invalid token link at GET / returns raw JSON; render a sign-in page. src/shared-accounts.ts: the rate limiter counts successful sign-ins and other people's join attempts (t13-7); accepting an invitation signs the user out everywhere even when it grants nothing new (t13-13); the 128-account cap is permanent because accounts can't be deleted (t13-15); an unreadable store shows shared users the owner lock page, and the owner panel shows an unrelated 'draft kept' message (t13-14, ui/shared.tsx:45). t13-12: shared reviewers can't record coverage on uncommitted results because src/shared-access.ts drops the workingChanges flag. Phone pairing pages belong to phone-pairing-pages. Duplicate groups: [["t13-6","t01-4","S06-7"]]

Likely files: `src/server.ts`, `src/shared-accounts.ts`, `src/shared-access.ts`, `ui/shared.tsx`, `ui/connect-computer.tsx`, `ui/team-join-link.ts`, `ui/join-project.tsx`

## Resolution and verification · 2026-10-26

All reported causes were confirmed in the source and fixed on an isolated branch from `29de9df`. The original issue descriptions below are retained as the reproduction record.

| Issue | Resolution and evidence |
| --- | --- |
| t13-2 | The setup link uses local-only `GET /team-handoff`. A static, non-cacheable, non-framable page accepts only the join-form fragment and restarts navigation from the local origin. Strict cookies and API origin checks are unchanged. Chrome replay used an HTTPS `hub.qa.test:4360` hub mapped to loopback and a previously signed-in `127.0.0.1:4361` local app in the same browser context. The join form retained the server/project/username hints without a recovery-link detour. The network listener returns 404 for the interstitial; unrelated fragments/query redirects remain static, and foreign-origin JSON mutation is rejected. |
| t13-6, t01-4, S06-7 | Owner cookies are `codeflow_session_<PORT>`. Only a legacy cookie matching this instance's token is migrated/cleared; another instance's cookie is untouched. Two fixed-token instances remain signed in independently through shared sign-in, invitation acceptance and logout. Exact cookie names are checked; misleading prefixes do not authenticate. |
| t01-11 | A fixed `CODEFLOW_TOKEN` receives a 30-day owner cookie. A random startup token still receives a session cookie. A persistent Chrome profile retained owner identity after closing/reopening Chrome and restarting the server with the same fixed token, after initial claiming had ended. Random-token startup produced cookie expiry `-1`. |
| t13-7 | Limiter reservations are held during verification and refunded on success; invalid passwords still spend the global/socket/account budgets. New-account invitation attempts never spend an existing username's password budget. Regression tests cover 25 successful mixed sign-ins/runner verifications, normalized usernames, eight failed passwords followed by 429, and a stranger's taken-name signup after seven bad guesses. Existing two-concurrent-derivation protection passes unchanged. |
| t13-13 | An invitation that grants no additional role consumes the invitation and issues a bounded session without revising the user or revoking other sessions. UI reports existing access and that other sessions stay signed in. Real Chrome replay kept a second device signed in and its open PTY terminal usable. Role upgrades still revise the user and revoke prior sessions; invitation replay fails and the eight-session cap holds. |
| t13-14 | Anonymous HTML and sign-in/invitation/runner callers receive a generic 503; local file paths and parser/validation detail are reserved for owner account management and server logs. Recovery links still work. The owner panel hides the unavailable form and shows reload/recovery information without the unrelated draft-conflict message. A persisted invalid session timestamp survives unchanged, fails closed, and recovers after repair plus restart. Startup now labels the recovery link correctly when first-browser claiming is disabled. |
| t13-15 | Owner-only `DELETE /api/accounts/:id` requires the current state revision and an already-disabled account. The UI confirms deletion. Cleanup removes terminal and host grants even for unavailable projects, stops associated execution, and revokes linked runners; a cleanup failure leaves the disabled record for retry. Task/review/job attribution retains the old identity, while the username and account slot can be reused with a new identity. Tests fill all 128 slots, show disabling does not free one, reject enabled/stale deletion, delete/recreate, reject shared/runner administration, and reload cleanup history. |
| t13-12 | Shared coverage retains the safe `workingChanges` flag. The reviewer sees an explicit uncommitted-results explanation; file-review checkboxes and commit-comment form are unavailable until the owner commits. A fake-agent solo run produced an untracked result file. Chrome showed its diff with the explanation; API review still returned 409. After committing only the scratch worktree, Refresh enabled file coverage and a human comment. Credential-path filtering remains tested. |
| t01-10 | Invalid owner browser links return styled 403 HTML with no-store, no-referrer and no-frame headers. An already authenticated local owner reaches the clean app URL. Network-listener recovery links show the existing phone guidance; API errors remain JSON. Static auth pages include an empty favicon so browser rendering creates no spurious favicon request. |

Validation commands (all run in `/private/tmp/codeflow-qa-auth-session-accounts`, with no live worktree build):

- `node --import tsx --test --test-concurrency=1 test/qa-auth-session-accounts.test.ts test/qa-auth-session-accounts-cleanup.test.ts test/project-invitations.test.ts test/shared-accounts.test.ts test/shared-access.test.ts test/security-review.test.ts test/server-reliability.test.ts test/team-terminals.test.ts test/host-execution.test.ts` — **78/78 passed**. Log: `/private/tmp/codeflow-qa-continue/auth-final-unit.log`.
- `node --import tsx --test --test-concurrency=1 test/e2e/qa-auth-session-accounts.e2e.ts` — **8/8 passed**. Log: `/private/tmp/codeflow-qa-continue/auth-e2e.log`.
- `node node_modules/typescript/bin/tsc --noEmit` and `git diff --check` — passed. Compiler log: `/private/tmp/codeflow-qa-continue/auth-tsc.log`.

Evidence is in `/private/tmp/codeflow-qa-auth-session-accounts/output/playwright/qa-auth-session-accounts/`: `server.log`, `browser.json`, `cross-site-handoff.png`, `already-joined.png`, `uncommitted-review.png`, `account-deleted.png`, and `storage-recovery.png`. Screenshots were visually inspected. The final browser capture has zero unexpected console errors and zero page exceptions. Deliberate 403/404/503 response messages and principal-change event-stream teardown are recorded separately from unexpected application errors. Initial harness failures (DNS resolution outside Chrome, exact nested-label matching, untracked-file discovery and legacy-cookie background requests) were corrected without weakening the product assertions.

All accounts, credentials, TLS identity, Git repositories, agent work, browser profiles and data homes were disposable fixtures. Only ports 4359/4360 and 4361/4362 were used by the browser replay, after checking availability. Adjacent existing server tests used their own ephemeral listeners. No real account credentials, user app data, live servers, real projects or remote mutations were involved. No issue remains open in this cluster.

## Issues

### t13-2 · major · 'Set up this computer for coding' handoff lands on the local lock page 'Open code-flow from its link'

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-01, COL-06.

**Repro**

> 1. Hub with HTTPS team access (here https://localhost:4414 with an imported certificate; in real use a Tailscale name) and a contributor account.
> 2. The teammate's own Code Flow (http://127.0.0.1:4415) is already open in the same browser via its ?token link.
> 3. Sign in to the hub as the contributor, open Board → 'Set up this computer for coding', set Local Code Flow address = http://127.0.0.1:4415, click 'Open local Code Flow'.

**Expected:** The local Code Flow opens Settings → Join a team with the team server URL, username and project filled in.

**Actual:** The local server answers 401 with the lock page 'Open code-flow from its link'. Reload is also 401. Following the page's advice (open the ?token link) drops the #/settings/connections/join?connection=… hash. Only retyping the URL in the address bar works. Reproduced 3/3.

**Root cause (verifier):** The hub starts the handoff navigation itself, and the local server's owner cookie is SameSite=Strict, so the cookie is not sent.

- ui/connect-computer.tsx:21: `location.assign(computerSetupLink(local, hint))` starts a top-level navigation from the hub origin (in real use https://<tailnet-name>, here https://hub.qa.test:4608) to the local Code Flow (http://localhost:4317). That is a cross-site navigation.
- ui/team-join-link.ts:25 makes the target a plain GET "/" (`${local.origin}/?team=local#/settings/connections/join?connection=…`).
- src/server.ts:411: the owner cookie `codeflow_session` is `SameSite=Strict`, so the browser leaves it off any navigation the hub starts.
- src/server.ts:1557-1561: with no owner cookie, no shared session, no first-browser claim (mayClaim, src/server.ts:373-377, is false once the server has been opened) and no shared accounts on the teammate's server, GET "/" answers 401 with LOCKED_PAGE (src/server.ts:475-481).
- src/server.ts:1548-1554: the lock page's advice, the ?token link, redirects 302 to "/". The printed link carries no fragment, so the handoff hints are lost. Going back to the hub and clicking again fails again because that navigation is als …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/team-join-link.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/connect-computer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/team-onboarding.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-invitations.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`

**Suggested fix:** Recommended: add a narrow public interstitial that re-starts the navigation from the local origin. This is the same technique the phone link already uses (signingInPage).

1. Make computerSetupLink (ui/team-join-link.ts:25) return `${local.origin}/team-handoff#/settings/connections/join?connection=…`.
2. In src/server.ts, before the auth gate and on the local listener only (via === "local"; answer 404 on the network listener), add GET /team-handoff. It answers 200 with headers `cache-control: no-store`, NO_FRAMES and `referrer-policy: no-referrer`, and a lockedPage("opening", …) body. That body's inline script accepts only a fragment matching `^#\/settings\/connections\/join\?connection=[^#]*$` and then calls `location.replace("/?team=local" + location.hash)`. The follow-up navigation is started by the local origin itself (same-origin), so the Strict cookie goes along and the app opens the prefilled join form. Any other fragment gets a static "Open your Code Flow" message and nothing m …

**Suggested regression test:** Three tests:

1. test/e2e/team-onboarding.e2e.ts, in "joined teammate connects a separate CodeFlow computer…": before clicking "Open local Code Flow", sign the member's own browser context into the runner the way the launcher does (`await member.goto(`${runnerBase}/?token=${token}`)`), then return to `${remote}/#/team/project/${projectId}`. Click the button and assert in the same `member` page:
   - `await member.getByText("Open code-flow from its link").count() === 0`
   - `member.getByLabel("T …

<details><summary>Verifier's independent reproduction</summary>

I started two new fake-mode QA servers with fresh homes. The hub was "v4607hub" on 127.0.0.1:4607. I exported CODEFLOW_LAN_ALLOW_LOCAL=1, enabled its network listener on :4608 with an imported self-signed certificate for "hub.qa.test", and mapped that name to 127.0.0.1 in Chrome with --host-resolver-rules. This gives the hub a different site from 127.0.0.1, like a tailnet name, without using "localhost". The teammate's own Code Flow was "v4607tm" on 127.0.0.1:4609. Through the API I created project "V4607 Shared" with a scratch repo, the team repo key "app" and a contributor invitation. The contributor "dana" joined through the UI at https://hub.qa.test:4608/#/join/<token>. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4607/ (setup-hub.mjs, repro.mjs, assign-compare.mjs). Logs are r0-unclaimed.log, r1-claimed.log, r3-claimed.log, r5-claimed.log and r4-assign.log. Each run used a fresh headless Chrome context.

Reported scenario (repro.mjs), run 3 times (r1, r3, r5) with the same result each time:
1. Opened http://127.0.0.1:4609/?token=… first, as the launcher does at startup. This set codeflow_session (SameSite=Strict).
2. Signed in to https://hub.qa.test:4608 as dana, opened #/team/project/<id>, clicked "Set up this computer for coding", set "Local Code Flow address" to http://127.0.0.1:4609 and clicked "Open local Code Flow".
   Result: the document request http://127.0.0.1:4609/?team=local returned 401 (sec-fetch-site=cross-site, cookie not sent). The page showed "Open code-flow from its link" (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4607/01-claimed-tls-handoff.png).
3. Reload: 401 again (still cross-site, cookie not sent).
4. Followed the lock page's advice and opened the ?token link: 302 then 200, but the #/settings/connections/join?connection=… fragment was gone and no join form appeared.
5. Went back to the hub and clicked "Open local Code Flow" again, with the cookie now in the jar: 401 again. Every navigation the hub starts is cross-site, so no amount of signing in fixes it.
6. Typed the handoff URL into the address bar instead: 200 (sec-fetch-site=none, cookie sent). The join form loaded with Team server URL = https://hub.qa.test:4608/#/connect?username=dana&project=p-484dd41b and Username = dana.

Controls:
- Unclaimed (r0): if nobody has opened the local Code F …

</details>

### t13-6 · minor · Shared sign-in on one Code Flow signs the owner out of another Code Flow on the same host but a different port

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-01, COL-09.

**Repro**

> 1. In one browser open http://127.0.0.1:4415/?token=<t13b token> (teammate's own Code Flow).
> 2. In the same browser sign in as a shared user on the hub at http://127.0.0.1:4413.
> 3. Reload http://127.0.0.1:4415/.

**Expected:** Each instance keeps its own sign-in (shared and phone cookies already include the port).

**Actual:** 4415 shows 'Open code-flow from its link'. The shared login response clears the owner cookie 'codeflow_session' for the host, which is the same cookie 4415 uses. This affects same-machine multi-instance setups (testing, or a team server and a personal instance on one machine).

**Root cause (verifier):** The owner session cookie has the same name on every port. In src/server.ts:357 it is `const COOKIE = "codeflow_session";`. The shared cookie (src/server.ts:358, `codeflow_shared_${PORT}`) and the phone cookie (src/server.ts:442, `codeflow_phone_${REMOTE_PORT}`) both include the port.

Browsers key cookies by name, domain and path, not by port. So every Code Flow on the same host name writes the same cookie, `codeflow_session` at domain 127.0.0.1 and path /.

That cookie is changed in four places:
- **Shared login:** src/server.ts:1532-1533 sends `clearCookie(COOKIE)`.
- **Invitation accept:** src/server.ts:1524-1525 sends `clearCookie(COOKIE)`.
- **Logout:** src/server.ts:1542 sends `clearCookie(COOKIE)`.
- **Owner link (`?token=`):** src/server.ts:1553, via `sessionCookie()` at src/server.ts:410-411, writes `codeflow_session=<this instance's token>`.

Each of these clears or replaces the other instance's owner cookie. On the next request the other instance's `signedIn()` (src/server.ts:428-431) finds no cookie whose value matches its own token, `owner` comes out false, and it serves LOCKED_PAGE with 401.

The comment on readCookies at src/server.ts:414-418 only plans for a cookie  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/security-review.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/shared-projects.md`

**Suggested fix:** **Rename the owner cookie per port.** In src/server.ts:357, set `const COOKIE = \`codeflow_session_${PORT}\`` so it matches SHARED_COOKIE and PHONE_COOKIE. The preview proxy strips cookies matching `/^codeflow_/` (src/preview.ts:50), so the new name is still kept away from previewed apps.

**Migrate existing sessions without signing anyone out:**
- Keep a `LEGACY_COOKIE = "codeflow_session"`.
- In signedIn(), also accept a legacy value only when it matches this instance's token. On that request, set the port-scoped cookie again and clear the legacy one.
- In the login, invitation-accept and logout handlers, clear the legacy name only when the request's legacy value matches this instance's token. That stops one instance from wiping another instance's legacy cookie.

**Optional:** apply the same port suffix to the cookie set by the first-browser claim path.

**Docs and tests:**
- Add a sentence to docs/shared-projects.md and docs/security.md saying that owner, shared and phone cookies ar …

**Suggested regression test:** Add a test to test/server-reliability.test.ts (or test/http-shared.test.ts) that starts two server instances on different ports with different CODEFLOW_TOKENs and creates a shared account on instance A.

1. GET B/?token=<B token> and capture B's Set-Cookie pair.
2. POST A/api/auth/login as the shared user, with Origin set and JSON content-type. Assert that no Set-Cookie line in the response names B's owner cookie, whether to clear it or to set it.
3. Simulate a cookie jar: apply A's Set-Cookie l …

<details><summary>Verifier's independent reproduction</summary>

I started two fresh fake-mode QA servers: v4615ck on 127.0.0.1:4615 (the hub) and v4617ck on 127.0.0.1:4617 (the second Code Flow). Through the owner API I created one shared account on the hub (alice, viewer on MQTT-MCP) and one invitation. The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4615ck/repro.mjs and its output is in repro.log in the same folder. Each scenario used a new, empty Chrome profile.

Scenario A (the reported flow):
1. Opened 4617/?token=qa-v4617ck-token. /api/auth/self returned owner, and the cookie jar held codeflow_session@127.0.0.1/=qa-v4617ck-token.
2. Went to 4615/, got the "Sign in to shared projects" form, filled in username and password in the UI and clicked Sign in. The login response set three cookies: codeflow_shared_4615=..., codeflow_session= (Max-Age=0) and codeflow_phone_4616=. Afterwards the jar held only codeflow_shared_4615, so 4617's owner cookie was gone.
3. Reloaded 4617/. It answered HTTP 401 with the "Open code-flow from its link" page (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4615ck/02-A-other-after.png), and /api/auth/self returned anonymous.

Scenario C (accepting the invitation instead of signing in): POST /api/auth/invitations/accept on 4615 returned 200. Afterwards 4617 also answered 401 and anonymous.

Scenario D (the reverse direction): signed in as the shared user on 4615, then opened 4617's owner link, then reloaded 4615. 4615 was still signed in as shared, because the shared cookie name includes the port.

Scenario B (control, no shared sign-in): opened 4617/?token, then 4615/?token, then reloaded 4617. 4617 again showed 401 and the lock page. So the owner cookie also clobbers between two owner sessions. The shared sign-in path in the report is one case of this wider problem.

What rules out the reporter's environment: the bug reproduced in fresh profiles, the sign-in went through the real UI form, and it happens on 127.0.0.1 with nothing but the port different. It is also not by design. docs/shared-projects.md says "Shared sign-in clears the owner browser cookie", which is meant for the same instance. The comment on PHONE_COOKIE says the name "carries the port because cookies ignore ports, and a second code-flow on this machine has a link of its own", so separate sessions per instance are what the code intends.

Cleanup: I …

</details>

### t01-4 · minor · Owner session cookie is not port-scoped: signing in to one local code-flow signs you out of another

Source: tester unit shell-navigation-settings-2; observed with fake-agents; features SHL-44.

**Repro**

> 1. Run two code-flow servers on 127.0.0.1 (ports 4341 and 4343), each with its own token.
> 2. In one browser open http://127.0.0.1:4343/?token=<t2>, then reload / (200).
> 3. Open http://127.0.0.1:4341/?token=<t1>.
> 4. Go back to http://127.0.0.1:4343/.

**Expected:** Both sessions stay signed in. The phone and shared cookies already include the port in their names.

**Actual:** 4343 now returns 401 'Open code-flow from its link'. Only one cookie remains: codeflow_session for domain 127.0.0.1, path /.

**Root cause (verifier):** src/server.ts:357 `const COOKIE = "codeflow_session";` is a fixed name with no port. sessionCookie() at src/server.ts:410-411 sets `codeflow_session=<token>; HttpOnly; SameSite=Strict; Path=/` for host-only 127.0.0.1 or localhost. Browsers do not separate cookies by port, so a second code-flow on the same host overwrites the first one's cookie when its link redirects (src/server.ts:1553) or when a first browser claims it (src/server.ts:1564).
signedIn() at src/server.ts:431 then finds no cookie value that matches auth.token. The link sign-in has already set auth.claimable=false, so GET / returns 401 LOCKED_PAGE (src/server.ts:1557-1559) and every API call returns 401 with signIn (src/server.ts:1602). In an open tab, ui/lib.ts:74/83 then reloads onto the locked page.
The other two cookies already avoid this: SHARED_COOKIE = `codeflow_shared_${PORT}` (src/server.ts:358) and PHONE_COOKIE = `codeflow_phone_${REMOTE_PORT}` (src/server.ts:442). Only the owner cookie was left unscoped.

**Files:** `src/server.ts`, `test/server-reliability.test.ts`, `test/security-review.test.ts`, `test/e2e/ui.e2e.ts`, `docs/getting-started.md`

**Suggested fix:** Scope the owner cookie to the port the server listens on, the same way the shared cookie is scoped: `const COOKIE = \`codeflow_session_${PORT}\`;` at src/server.ts:357. sessionCookie(), signedIn(), and the clearCookie(COOKIE) calls in the shared login, invitation and logout paths (src/server.ts:1525/1533/1542) then pick up the new name with no other change. readCookies() matches `${name}=` exactly, so codeflow_session_4317 never matches codeflow_session_43171.
The preview proxy already strips cookies with /^codeflow_/ (src/preview.ts:50), so a rename needs no change there.
Optional migration: for one release, also accept the legacy unscoped `codeflow_session` in signedIn(). This only helps users with a fixed CODEFLOW_TOKEN; other servers get a new token on restart anyway. When setting the new cookie, add clearCookie("codeflow_session") so old values disappear.
Update the literal `codeflow_session=` strings in test/server-reliability.test.ts (lines 153, 158-161, 177), test/security-revi …

**Suggested regression test:** In test/server-reliability.test.ts, start two test servers on different ports with different CODEFLOW_TOKENs. Sign in to A with its `/?token=` link and capture A's set-cookie. Assert that the cookie name includes A's port, e.g. /^codeflow_session_<portA>=/. Do the same for B. Then send both cookies together, the way a browser sends both for the same host, and assert that `GET /` and `/api/patterns` return 200 on A and on B. Today both servers set the same name, so the second cookie replaces the  …

<details><summary>Verifier's independent reproduction</summary>

I started two fresh fake-mode QA servers: v4615 on 127.0.0.1:4615 (token qa-v4615-token) and v4615b on 127.0.0.1:4617 (token qa-v4615b-token). Then I drove one fresh headless Chrome context (no saved profile) with /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4615/cookie-clobber.mjs. The log is cookie-clobber.log in the same folder.
1) Opened 4617/?token=... and got 200 with one cookie, codeflow_session@127.0.0.1/ = the 4617 token.
2) Reloaded 4617/ and got 200. /api/auth/self returned kind owner and /api/patterns returned 200.
3) Opened 4615/?token=... and got 200, but that single codeflow_session cookie was overwritten with the 4615 token.
4) Went back to 4617/ and got 401 with the locked page "Open code-flow from its link / This code-flow server is already in use...". The cookie jar still held only the one codeflow_session cookie, with the 4615 value.
5) 4615/ still returned 200.
6) The 4617 server was still up: a bearer request with its token to /api/auth/self returned 200. Its credential was fine; only the browser cookie had been replaced.
7-8) Opening the 4617 link again signed 4617 back in, and then 4615/ returned 401. The two servers keep signing each other out.
9-11) Control: when I opened 4615 at http://localhost:4615 and 4617 at http://127.0.0.1:4617, both stayed signed in. The two host names keep separate cookies, which matches the name-collision explanation.
In a second script (open-tab.mjs), a tab already open on 4617 was signed out as soon as the user signed in to 4615 in another tab. The next API call in that tab (GET /api/ml/settings on navigating to #/settings) returned 401 with signIn:true. ui/lib.ts:83 signInAgain() then reloaded the tab onto the locked page (screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4615-tabB-after.png). There were no console or page errors.
Why this is not by design, the environment or the test script: the comment above PHONE_COOKIE (src/server.ts:436-441) says its name carries the port "because cookies ignore ports, and a second code-flow on this machine has a link of its own". SHARED_COOKIE (src/server.ts:358) is port-scoped for the same reason. No doc says the owner session is meant to be shared across instances. The repo's own `npm run dev` runs on PORT=4318 next to the default 4317 (package.json:22). Each server prints its link as http://localho …

</details>

### S06-7 · minor · The owner session cookie 'codeflow_session' is not port-scoped, so two CodeFlow instances on the same host overwrite each other's owner sign-in in one browser.

Source: code-level suspect at `src/server.ts:357` (confirmed hands-on).

**Repro**

> Fake servers s06 (4525) and s06b (4527), script work/s06/cookie.mjs in one browser context. (1) Open http://127.0.0.1:4525/?token=qa-s06-token: cookie codeflow_session=qa-s06-token, GET /api/patterns 200. (2) In another tab, open http://127.0.0.1:4527/?token=qa-s06b-token: the jar now holds a single codeflow_session=qa-s06b-token. (3) Reload the 4525 tab: /api/patterns returned 401 and the page showed 'Open code-flow from its link. This code-flow server is already in use…' (shots/s06/002-4525-after-4527-signin.png). 4527 still returned 200.

**Expected:** Signing in to one instance does not sign the browser out of another instance on a different port of the same host.

**Actual:** The most recent sign-in wins. The other instance falls back to the token-link page, whose 'already in use' wording doesn't explain why.

**Root cause (verifier):** `const COOKIE = "codeflow_session"` with Path=/. Cookies ignore ports, so every CodeFlow on 127.0.0.1 or localhost writes the same jar entry. The shared and phone cookies were deliberately port-scoped (`codeflow_shared_${PORT}`, `codeflow_phone_${REMOTE_PORT}` with the comment 'cookies ignore ports'), but the owner cookie was not. The docs recommend running `npm start` (4317) and `npm run dev` (4318) side by side on localhost, which triggers this.

**Suggested fix:** Name the owner cookie `codeflow_session_${PORT}` (preview.ts already strips anything matching /^codeflow_/). For migration, also accept a legacy `codeflow_session` whose value matches this server's token, but only ever set the port-scoped name. Do not clear the legacy cookie, since that would sign out older instances. Update the tests that hard-code the name (server-reliability, security-review, collab-runner, preview).

**Suggested regression test:** Start two servers on different ports and sign in to both with one cookie jar (e.g. undici CookieAgent or Playwright context). Both GET /api/patterns calls return 200. The legacy cookie name with the right token is still accepted.

### t01-11 · minor · Fixed CODEFLOW_TOKEN does not keep browsers signed in after the browser restarts (session cookie)

Source: tester unit shell-navigation-settings-2; observed with fake-agents; features SHEL-GAP-03.

**Repro**

> 1. Start code-flow with CODEFLOW_TOKEN=<fixed> and sign in with the link in a persistent Chrome profile.
> 2. Start a run (so claiming is impossible), close the browser, restart the server with the same token.
> 3. Reopen the browser and go to /.

**Expected:** docs/configuration.md:107 says to set CODEFLOW_TOKEN 'to keep browsers signed in across restarts', so a reopened browser stays signed in.

**Actual:** 401 locked page; the cookie has expires=-1 (session cookie), so closing Chrome drops it. An open browser does survive a server restart.

**Root cause (verifier):** src/server.ts:410-412 `sessionCookie()` returns `${COOKIE}=${auth.token}; HttpOnly; SameSite=Strict; Path=/` with no Max-Age or Expires. Both places that issue the owner cookie use it: the link sign-in at src/server.ts:1553 and the first-browser claim at src/server.ts:1564. So the cookie is always a browser-session cookie, and browsers drop it when they quit (unless session restore is on). This happens even when the token is fixed with CODEFLOW_TOKEN (src/server.ts:352). The token survives restarts, but the browser's copy does not.
Compare the phone cookie (src/server.ts:446-447, Max-Age 30 days, with a comment explaining it) and the shared cookie (src/server.ts:388, Max-Age 43200). No comment or doc says the owner cookie is meant to end when the browser closes.
docs/configuration.md:107 says to set CODEFLOW_TOKEN "to keep browsers signed in across restarts". That holds for server restarts while the browser stays open, but not when the browser is restarted.
The impact is limited: the first-browser claim (mayClaim, src/server.ts:373) often signs a reopened browser back in after a server restart, and with a fixed token the same link always works. That is why minor is the right severi …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/configuration.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/getting-started.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`

**Suggested fix:** In src/server.ts, record whether the token is fixed, e.g. `fixed: !!process.env.CODEFLOW_TOKEN` on `auth`. When it is fixed, sessionCookie() adds a Max-Age, for example `; Max-Age=${30 * 86_400}` to match PHONE_COOKIE_DAYS. With a random per-start token, keep the plain session cookie: a cookie that outlives the browser would be useless after the next restart anyway. Logout already clears the cookie with Max-Age=0. No Secure flag is needed on the 127.0.0.1 listener.
The trade-off: the owner's full API token would then sit on disk in the browser's cookie store. Chrome encrypts that store on macOS and Windows, but not always on Linux. A stronger variant would issue a per-browser session id, persisted in CODEFLOW_HOME like phoneSessions, instead of putting the raw token in the cookie.
Then update docs/configuration.md:107 to say what is promised, e.g. "browsers stay signed in for 30 days, across server and browser restarts". Add a sentence under docs/getting-started.md "Signing in" too.
If …

**Suggested regression test:** test/server-reliability.test.ts: start a server with startServer({ CODEFLOW_TOKEN: "fixed-token" }) and assert that GET /?token=fixed-token (redirect manual) returns 302 with a set-cookie matching /^codeflow_session=fixed-token;.*Max-Age=\d+/. In a second instance with CODEFLOW_TOKEN: "" (random token), assert the claimed cookie from GET / has no Max-Age. Optionally, in test/security-review.test.ts, assert that the claim-path cookie follows the same rule. A browser-level check is the Playwright  …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4629 on 127.0.0.1:4629. qa-server.sh always sets a fixed CODEFLOW_TOKEN=qa-v4629-token. Before starting it I moved a leftover v4629 home aside to homes/v4629-prev-*. I used my own Playwright script, work/v4629/t0111-cookie.mjs (log in t0111.log), with persistent Chrome profiles. I did not use openApp, because openApp always visits ?token= first and would hide the bug.
(0) The raw Set-Cookie from GET /?token=qa-v4629-token is `codeflow_session=qa-v4629-token; HttpOnly; SameSite=Strict; Path=/`. It has no Max-Age or Expires.
(1) Signed in with the link in persistent profile P. ctx.cookies() shows codeflow_session expires -1, and GET / returned 200. As a control, I added a 1-day probe cookie and a session probe cookie in P. Profile Q got the same sign-in, then its codeflow_session was rewritten with a 7-day expiry to emulate a fix. Browser R stayed open throughout.
(2a) Closed P with the server still running and claiming already off, then relaunched P. Only qa_probe_persistent survived: codeflow_session and qa_probe_session were gone. GET / returned 401 "Open code-flow from its link". So quitting the browser alone signs you out; no server restart is needed.
(2b) Restarted the server with the same token, then turned claiming off with another link sign-in. R (left open) reloaded with 200, so the documented server-restart case works. Relaunched P: 401, the locked page. Relaunched Q, which has the persistent cookie: 200, signed in. This shows the harness keeps persistent cookies and that a cookie with an expiry would fix it.
(3) Restarted again and reopened P before anything else signed in: 200, because the first-browser claim gives a fresh session cookie (expires -1). This means the bug is hidden when nothing has signed in or started since the restart.
Cleanup: no runs were created. The server is stopped, the test profiles are deleted and ports 4629-4631 are free.

</details>

### t13-7 · minor · Sign-in rate limiter counts successful sign-ins and other people's join attempts against a username

Source: tester unit human-collaboration-1; observed with api; features COL-09, COL-06.

**Repro**

> 1. Within 15 minutes from one machine: join as bob, sign in to the hub twice, enrol two runners with bob (all successful).
> 2. Another person uses an invitation 'Create my account' with the taken username 'bob' (409).
> 3. Bob makes one wrong-password attempt, then accepts an invitation with 'Sign in with an existing account' and the correct password.

**Expected:** Only failed attempts (or at least only bob's own attempts) count toward bob's lockout.

**Actual:** Step 3 returns 429 'Too many sign-in attempts; try again later' on bob's 8th counted call; 5 of the earlier calls were successful and one was someone else's join attempt. Every caller from one address also shares a 20-per-15-min bucket.

**Root cause (verifier):** The cause is in src/shared-accounts.ts.
- Lines 73-81: LoginLimiter.check() keeps three buckets, each over 15 minutes: global (100), `ip:<socket address>` (20) and `user:<sha256(name)>` (8). Line 78 refuses a call if any bucket is already full. Line 79 then increments all three buckets on every call, before the password has been checked. Nothing ever takes a count back after a success.
- Line 199: the private verify() calls limiter.check() before key derivation. verify() is the single password check behind three things: browser sign-in (login(), called from src/server.ts:1531), runner enrolment (verifyCredentials() at line 170, called from src/collab/api.ts:202 for POST /api/team/runners/connect), and "Sign in with an existing account" during invitation acceptance (line 132). So every successful sign-in, enrolment and existing-account join counts toward the lockout.
- Line 133: during invitation acceptance with a new account (existing:false), limiter.check(address, String(input.username)) also runs against whatever username the joiner typed. A different person who picks a taken name such as "bob" therefore uses up bob's bucket, even though that is not a password guess against bob.  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/shared-accounts.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/shared-accounts.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/shared-projects.md`

**Suggested fix:** Make the limiter count denials only.
1. Change LoginLimiter.check() so it still checks all three buckets before key derivation and still reserves a count, then returns a release() callback. Reserving first keeps the bound tight while derivations are in flight.
2. In verify(), call release() after a successful password match. That refunds the user, ip and global counts, or at least clears the user bucket and refunds the others.
3. For new-account invitation acceptance (line 133), stop using the user:<typed name> key. Limit that path by the address and global buckets only, and count only joins that fail: a taken username (409), a bad display name or a bad password. A successful join already uses up its single-use invitation.
4. Lowercase any name used as a key, to match verify().
5. Optional: include the remaining wait in the 429 message ("try again in N minutes").
6. Update the sentence in docs/shared-projects.md:19 to say the limits count failed sign-in attempts.

**Suggested regression test:** Add these to test/shared-accounts.test.ts:
1. "successful sign-ins and verifications never count toward lockout": create one account, then make 25 calls from one address at 127.0.0.1, mixing successful login() and verifyCredentials(). All must succeed. Keep the existing assertion that 8 failed attempts for unknown-user still lead to a 429 on the 9th.
2. "a stranger's new-account join with a taken username does not lock out that user": create bob and two invitations. Make 7 failed bob logins with …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server "v4617rl" on 127.0.0.1:4619. Port 4617 was held by another verifier's server, started 42 s earlier (v4617ck), so I left it running. As the owner I created four accounts through POST /api/accounts with random 27-character passwords: bob (contributor on MQTT-MCP p-ef01794b) and alice, carol and dave (viewers). I sent every anonymous call the way the browser forms do: a same-origin JSON POST from 127.0.0.1. I restarted the server between scenarios because the limiter lives only in memory. Scripts and logs are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617rl/ (s1.mjs, s2.mjs, s3.mjs and their .log files).

Scenario 1, successful sign-ins only:
- bob signed in 8 times with the correct password through POST /api/auth/login, and all 8 returned 200.
- I made the 9th sign-in through the real UI in a fresh headless Chrome with no token, using the "Sign in to shared projects" form and the correct password. It returned 429, and the form showed "Too many sign-in attempts; try again later". Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4617rl-s1-bob-429.png
- alice then signed in on the same form from the same address and got 200 (/api/auth/self returned alice). So bob's username bucket was the one blocking him.

Scenario 2, after a restart:
- bob made 6 successful sign-ins (200) and 1 successful runner enrolment through POST /api/team/runners/connect (201).
- The owner created two invitations.
- A different person used invitation A's "Create my account" with the taken username bob and their own password. This returned 409 "That username is already in use…".
- bob then accepted invitation B with existing:true and his correct password. This returned 429 "Too many sign-in attempts; try again later", and so did a plain bob sign-in.
- carol, on the same address, got 200. Both invitations stayed unaccepted, and bob's roles did not change.

Scenario 3, after a restart:
- 20 successful sign-ins from 127.0.0.1, split as alice 7, carol 7 and dave 6. Each user stayed under the per-username limit of 8, and all 20 returned 200.
- bob's first-ever attempt, with the correct password, returned 429 because the per-address bucket was full.

Refutation checks:
- The reporter's environment or script is not the cause: everything above ran on a fresh home with fresh accounts, and th …

</details>

### t13-13 · minor · Accepting an invitation with an existing account signs the user out everywhere, even when it grants nothing new

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-06.

**Repro**

> 1. Bob is a contributor in project P and is signed in on other browsers and devices.
> 2. Owner creates a viewer invitation for P; Bob accepts it with 'Sign in with an existing account'.

**Expected:** The invitation is reported as granting nothing new (or isn't consumed), and Bob's other sessions stay valid since his roles didn't change.

**Actual:** Accepted; roles unchanged (contributor kept) but the revision goes 1→2 and all other sessions are deleted; the invitation is consumed.

**Root cause (verifier):** src/shared-accounts.ts:143-148, in `acceptInvitation()`, the existing-account branch:
```ts
if (!roleAtLeast(user.roles[invite.projectId], invite.role)) user.roles[invite.projectId] = invite.role;
user.revision++; user.updatedAt = now;
state.sessions = state.sessions.filter(session => session.userId !== user.id);
```
Only the role assignment depends on the `roleAtLeast` check. The revision bump and the deletion of all the user's sessions run every time, even when no role changed.
- authenticate() (src/shared-accounts.ts:190) rejects any session whose revision differs from the user's, so the bump alone would already invalidate sessions held elsewhere in memory.
- Open team terminals are also bound to the account revision (src/collab/terminals.ts:70 `accountRevision`), so a no-op acceptance also kills any open team terminal of that user.
- Compare login() (src/shared-accounts.ts:171-183), which deliberately keeps the 7 newest other sessions.

The invitation is always consumed (`invite.acceptedAt = now`). The response (src/server.ts:1520-1526, `{user, projectId}`) has no field saying whether anything was granted, so ui/join-project.tsx and the board can't tell the user the link change …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/shared-accounts.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/join-project.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/project-invitations.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/team-collaboration.md`

**Suggested fix:** 1. **Only touch revision and sessions on a real change.** In acceptInvitation's existing-account branch (src/shared-accounts.ts:146-148), compute `const granted = !roleAtLeast(user.roles[invite.projectId], invite.role)`.
   - When `granted` is true: set the role, bump the revision, set updatedAt and drop the user's sessions. This matches the documented rule that role changes invalidate every session.
   - When `granted` is false: leave the user record and its sessions alone.
2. **Keep the per-account cap.** When existing sessions are kept, enforce the documented "at most eight sessions per account" the same way login() does: keep the user's 7 newest live sessions plus the new one.
3. **Report the outcome.** Add `granted` (or `changed`) to the acceptInvitation result and include it in the `/api/auth/invitations/accept` response (src/server.ts:1526).
   - ui/join-project.tsx (or the board's "You're in" card) can then say something like "You already have Contributor access to MQTT-MCP; th …

**Suggested regression test:** In test/project-invitations.test.ts, rewrite the "existing members prove their password, preserve other projects and never downgrade access" test:
- Accept the p-one contributor invitation while the user is already maintainer, then assert:
  - `store.authenticate(signed.token)` is still defined and has the same revision;
  - `result.user.revision` equals the pre-accept revision;
  - `result.granted === false`;
  - the invitation's acceptedAt is set.
  This replaces the current line 49 assertion, …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: `qa-server.sh start v4629 4629 fake`. The old v4629 home from an earlier session was first moved aside to homes/v4629.prev-t1313, so the new home had no shared-accounts.json. Then I ran the script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4629/t1313-repro.mjs with headless Chrome, giving each device its own fresh browser context. I ran it twice, once as `bob` and once as `carol`. The carol run is clean end to end. Its log is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4629/t1313-repro-carol.log.

Steps:
1. As the owner, through the API, I created account carol as **contributor** on project MQTT-MCP (p-ef01794b).
2. Carol signed in through the UI sign-in form on device A and on device B. The store then had 2 sessions for carol, both at revision 1.
3. As the owner, through the API, I created a **viewer** invitation for the same project.
4. On device C I opened `/#/join/<token>`. The page said "You've been invited as a Viewer". I chose "Sign in with an existing account", entered carol's credentials and clicked "Join project".

Results:
- The accept call returned 200 and C landed on the board ("You're in MQTT-MCP. Your project access is ready.").
- C's `/api/auth/self` showed `revision:2, roles:{p-ef01794b:"contributor"}`. The role was unchanged but the revision went from 1 to 2.
- Devices A and B immediately returned `/api/auth/self` = `{"kind":"anonymous"}`. Their event streams broke (console `net::ERR_INCOMPLETE_CHUNKED_ENCODING` on both). Reloading A showed the "Sign in to shared projects" page with no explanation.
- The store dropped from 2 sessions to 1 (only C's new session). The invitation was marked accepted, and replaying the token now returns 410.
- Nothing in the UI says the viewer link granted nothing, or that other devices were signed out.

Control: carol signed back in on A, then signed in normally on a new device D. A and C both stayed signed in, and the store held 3 sessions. So an ordinary sign-in keeps other sessions; only accepting the invitation wipes them. The bob run gave the same result (revision 1→2, contributor kept, A and B signed out).

Why I don't think this is by design or an environment issue:
- docs/shared-projects.md:21 lists what invalidates every session: "Role/display-name/enabled/password changes and owner revocation". Accepting an …

</details>

### t13-14 · minor · Unreadable shared-account store: shared users get the owner lock page, and the owner panel shows an unrelated 'draft kept' message

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-09, COL-08.

**Repro**

> 1. Stop the hub; make shared-accounts.json invalid (e.g. a session whose lastSeenAt is before createdAt).
> 2. Start the hub. Open / in a fresh browser; open Settings → Connections → Share access → Manage as owner.

**Expected:** Shared users see that shared sign-in is temporarily unavailable. The owner sees which file is unreadable and what to do.

**Actual:** Visitors see 'Open code-flow from its link… find the ?token line in the terminal', instructions meant for the owner. The owner panel shows 'Shared account storage is unavailable; use the owner recovery link Your draft has been kept; reload current accounts before retrying a conflicting save.' The owner is already signed in and there is no draft. POST /api/auth/login returns 503. Runner credentials also stop working until it is fixed.

**Root cause (verifier):** 1. ui/shared.tsx:45 appends " Your draft has been kept; reload current accounts before retrying a conflicting save." to every `error`. The same `error` state is set by the initial load at ui/shared.tsx:33 (GET /api/accounts returning 503) and by the revoke-sessions action, not only by a 409 on save. There is also no separator between the two sentences.

2. src/shared-accounts.ts:206: `require()` always says "use the owner recovery link", even to the owner, who is already signed in that way. It does not name the file or the reason. At src/shared-accounts.ts:98 the load catch replaces the real validation error (here "Invalid shared account session", from validateState at :67 where `s.lastSeenAt < s.createdAt`) with a generic message. src/server.ts:211 logs only that wrapper, so neither the UI nor the terminal tells the owner which file is bad or why.

3. src/server.ts:1556-1560: when `sharedAccounts.available` is false, `sharedLogin` is false. The page treats "storage unreadable" the same as "no shared sign-in configured" and serves the generic LOCKED_PAGE (src/server.ts:475-481), whose instructions are written for the owner. src/server.ts:353 also makes the server unclaimable, yet t …

**Files:** `ui/shared.tsx`, `src/shared-accounts.ts`, `src/server.ts`, `test/shared-accounts.test.ts`, `test/e2e/shared-projects.e2e.ts`, `docs/shared-projects.md`

**Suggested fix:** 1. ui/shared.tsx (SharedAccountsPanel): record which action failed and its HTTP status. Append the "draft kept / reload before retrying" hint only when a save or revoke returns 409, and add proper sentence spacing. When the initial load fails (state is null), show a storage-unavailable notice with only "Reload accounts" and hide or disable the empty "New account…" form, rather than leaving a draftable form under a misleading alert.

2. src/shared-accounts.ts: keep the load failure reason in a private field, and log it at server.ts:211. Give owner routes a message that names the file and the next step, the way the team store does. For example: "Shared account storage (<home>/shared-accounts.json) could not be read: Invalid shared account session. Repair or move the file aside, then restart code-flow." Keep a generic message, with no path, for unauthenticated callers (login, accept invitation, runner connect): "Shared sign-in is temporarily unavailable; contact the project owner."

3. sr …

**Suggested regression test:** 1. test/shared-accounts.test.ts, in the existing "account corruption … fail closed" test: write a state with sessions[0].lastSeenAt = createdAt - 1 and load it. Assert that `available === false` and that `snapshot()` throws a SharedAccountError with status 503 whose owner-facing message contains "shared-accounts.json" and "Invalid shared account session", and does not contain "use the owner recovery link". Assert that the login/verify path rejects with 503 and a generic message containing no pat …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server, v4631 on 127.0.0.1:4631, with home /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4631.
1. As owner (bearer qa-v4631-token) I created a test shared account, vera4631, as contributor on MQTT-MCP with a random password, via POST /api/accounts. I then signed it in with POST /api/auth/login to create a session (200 plus a shared cookie). Before the change, GET / with no cookie returned 200, the shared sign-in page.
2. I stopped the server and set sessions[0].lastSeenAt = createdAt - 1 in shared-accounts.json, then restarted. server.out logged: "Shared accounts unavailable; owner recovery remains available: Shared accounts cannot be read; owner recovery remains available and the account file was left untouched". It gave no file path and no reason. The banner still printed "(the first browser to open code-flow signs in without it)".
3. Requests after the restart:
   - GET / with no cookie returned 401 and the generic LOCKED_PAGE: "Open code-flow from its link … Find the line Open http://localhost:4631/?token=… where code-flow was started". Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4631/t1314-visitor.png
   - POST /api/auth/login returned 503 "Shared accounts cannot be read; …".
   - GET /api/accounts and GET /api/accounts/invitations returned 503 "Shared account storage is unavailable; use the owner recovery link".
   - POST /api/team/runners/connect returned 503.
4. In a fresh headless Chrome, the owner opened ?token=… and then #/settings/connections/manage. The SharedAccountsPanel shows an editable "New account…" form with Create disabled, and this role=alert: "Shared account storage is unavailable; use the owner recovery link Your draft has been kept; reload current accounts before retrying a conflicting save." Clicking "Reload accounts" gives the same text again. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4631/t1314-owner-alert.png
5. Runner check: I restored the valid file, restarted, and enrolled a runner (201). With the valid store, GET /api/team/board using the runner bearer returned 200. I made the file invalid again and restarted. The same request now returns 401 "This runner credential is not valid; connect this computer again in Settings → Team", and conne …

</details>

### t13-15 · minor · 128-account cap is permanent: accounts can't be deleted, so disabled accounts consume slots forever

Source: tester unit human-collaboration-1; observed with api; features COL-08.

**Repro**

> 1. Create accounts until 128 exist (here via POST /api/accounts).
> 2. Try to create another, or have a new person accept an invitation with 'Create my account'.

**Expected:** The owner can delete departed accounts to free slots.

**Actual:** 'At most 128 shared accounts may be created'; invitation acceptance would fail with 'This server has reached its account limit; contact the owner'. There is no DELETE /api/accounts/:id and no UI control, only 'Account enabled'.

**Root cause (verifier):** Account records can only be added or disabled. Nothing removes them.

- src/shared-accounts.ts:24: `const MAX_USERS = 128` is a hard limit on `state.users.length`.
- The limit counts every account, enabled or not:
  - create() at src/shared-accounts.ts:163: `if (state.users.length >= MAX_USERS) throw new SharedAccountError("At most 128 shared accounts may be created")`
  - acceptInvitation() at src/shared-accounts.ts:151: `if (state.users.length >= MAX_USERS) throw new SharedAccountError("This server has reached its account limit; contact the owner", 409)`
- validateState() at src/shared-accounts.ts:53 also refuses to load a file with more than MAX_USERS users.
- The SharedAccounts class has create/update/revokeSessions but no remove() that splices `state.users`. update() can only set `enabled:false` (src/shared-accounts.ts:166).
- The owner route block at src/server.ts:1752-1770 handles GET/POST /api/accounts, PUT /api/accounts/:id and POST /api/accounts/:id/revoke-sessions. A DELETE on /api/accounts/:id (also reached by /api/v1) falls through to `throw new HttpError(404, "Unknown shared account operation")` at line 1769.
- The UI in ui/shared.tsx:30-46 (SharedAccountsPanel, used  …

**Files:** `src/shared-accounts.ts`, `src/server.ts`, `ui/shared.tsx`, `docs/shared-projects.md`, `test/shared-accounts.test.ts`, `test/project-invitations.test.ts`

**Suggested fix:** Add owner-only account deletion and document the limit.

1. src/shared-accounts.ts: add `remove(id, {revision})` built on `change()`:
   - Check the revision with cas() and require the account to exist (find()).
   - Optionally allow it only for accounts that are already disabled, so deletion becomes a deliberate second step.
   - Splice it out of `state.users` and drop its sessions from `state.sessions`. The listeners already notified by change() then revoke streams and terminals (server.ts:257 and :1296) and trigger a team resync.
2. src/server.ts: add `if (parts.length === 3 && req.method === "DELETE") return send(res, 200, await attempt(() => sharedAccounts.remove(parts[2]!, body)))` to the /api/accounts block. Keep the route owner-only; shared-access.test.ts already asserts that /accounts maps to owner.
3. Clean up references to the deleted user id:
   - Remove it from host-execution and terminal grants, and revoke any runners linked under it in src/collab/store.ts.
   - Board his …

**Suggested regression test:** 1. test/shared-accounts.test.ts:
   - Fill a temp CODEFLOW_HOME to 128 accounts, then assert create() rejects the 129th with "At most 128".
   - Disable one account and assert create() still rejects.
   - Call remove(id, {revision}) on it. Assert snapshot().users.length === 127, that its session token no longer authenticate()s, and that it is gone from the stored file.
   - Assert create() for a new user, and for the freed username, now succeeds.
   - Assert remove() with a stale revision return …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: `qa-server.sh start v4633b 4633 fake`. The new home was /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4633b. I used it instead of the existing v4633 home because that one had state left from an earlier check.

1. Precondition script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4633/t13-15-fill.mjs (log t13-15-fill.log in the same folder):
   - Created 128 viewer accounts on MQTT-MCP with POST /api/accounts (about 27 s).
   - 129th POST returned 400 {"error":"At most 128 shared accounts may be created"}.
   - Disabled qa-user-001 with PUT {enabled:false, roles:{}} (200). The 129th POST still returned the same 400, so a disabled account keeps its slot.
   - DELETE /api/accounts/:id, the same request with a JSON body, and DELETE /api/v1/accounts/:id all returned 404 {"error":"Unknown shared account operation"}.
   - The final list still had 128 users, 1 of them disabled.
2. UI script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4633/t13-15-ui.mjs (log t13-15-ui.log):
   - In Settings > Connections > Manage > Shared project accounts, I filled in qa-user-129 and clicked "Create account". The alert said "At most 128 shared accounts may be created Your draft has been kept; reload current accounts before retrying a conflicting save." (screenshot 001).
   - Selecting the disabled account shows only "Save account changes", "Reload accounts", "Sign out all sessions" and an "Account enabled" checkbox. No delete or remove-account control exists there (screenshot 002), nor in Project > People > Advanced administration (screenshot 003).
3. Invitation path, same script:
   - Created an invitation by API. A fresh browser with no owner session opened /#/join/<token>, chose "Create my account" and clicked "Join project".
   - POST /api/auth/invitations/accept returned 409 and the page showed "This server has reached its account limit; contact the owner" (t13-15-join-full.png). The owner has no remedy to offer.
   - The invitation stayed unaccepted; I revoked it afterwards.

Screenshots are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4633b/.

Refutation attempts, none of which held:
- docs/shared-projects.md only says "revoke acc …

</details>

### t13-12 · minor · Shared reviewers can't record file coverage on an owner's uncommitted result; the dashboard shows '0 of 0 visible files' while listing the file

Source: tester unit human-collaboration-1; observed with fake-agents; features COL-10.

**Repro**

> 1. Owner runs a default 'Agent' task (no check command) in the shared project; changes stay uncommitted in the worktree.
> 2. A reviewer opens it in the shared dashboard (Results).

**Expected:** Coverage counts the visible changed files, or the dashboard says the result isn't committed yet and coverage can be recorded after the owner commits.

**Actual:** Shows '0 of 0 visible files reviewed at <base commit>' above a diff with 1 file and an enabled 'Reviewed <file>' checkbox. Ticking it fails with 'Commit the workspace changes before recording review coverage.', an action only the owner can take.

**Root cause (verifier):** Coverage and diff come from different sources for an uncommitted solo (Agent) result. The owner UI reconciles them with the workingChanges flag; the shared path drops that flag and the shared UI never checks it.

- src/engine.ts:4284-4290 (reviewCoverage): `files` comes from branchDiff(baseRef, committed head). For uncommitted work that is [] and head is the base commit, alongside `workingChanges: true`. engine.ts:4297 (recordFileReview) then refuses with RunConflictError "Commit the workspace changes before recording review coverage." This refusal is by design: docs/runs.md:64 and docs/github.md:12 say recorded approval applies to committed code.
- src/engine.ts:3751-3752 (diff): for a solo run without checkpointOnFinish whose worktree exists, it returns workspaceDiff, i.e. the uncommitted working files. So the shared diff lists files that coverage does not.
- src/shared-access.ts:45-48 (sharedCoverageProjection): an allow-list projection used by src/shared-api.ts:65/131 for shared GET and POST review-coverage. It keeps only head, files, reviewed and stale, so workingChanges is dropped and the shared client cannot know the result is uncommitted.
- ui/shared.tsx:63: the Coverage in …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/shared-access.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/shared.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/shared-access.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/shared-projects.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/shared-projects.md`

**Suggested fix:** 1. src/shared-access.ts:45: accept `workingChanges?: boolean` in sharedCoverageProjection and pass through `workingChanges: !!value.workingChanges`. It is a boolean only, so no paths leak.
2. ui/shared.tsx:63: add `workingChanges?: boolean` to the Coverage interface.
3. ui/shared.tsx:86, when coverage.workingChanges is set, mirror ui/review-coverage.tsx:30,34:
   - Replace the "N of M visible files reviewed at <head>" line with a status note, e.g. "These are uncommitted working changes. File coverage can be recorded after the owner commits them."
   - Hide the per-file "Reviewed <file>" checkbox, or render it with `disabled={!reviewer || busy || !!coverage.workingChanges}`.
   - Optionally head the list "Working changes", as ui/review.tsx:157 does.
4. Keep the server-side 409 in engine.recordFileReview as the guard; it is correct.
5. Consider the same treatment for the reviewer comment form (`Comment on this result commit`). From reading the code (not verified in the UI), comments.add  …

**Suggested regression test:** 1. test/shared-access.test.ts (unit): assert that `sharedCoverageProjection({ head: "a".repeat(40), files: [], reviewed: [], workingChanges: true })` includes `workingChanges: true`. Update the existing deepEqual at line 44 to expect `workingChanges: false`.
2. test/e2e/shared-projects.e2e.ts (browser): add a fixture solo run whose result worktree has an uncommitted file (write src/answer.ts without `git commit`, pattern "solo", no checkpointOnFinish). Signed in as the reviewer, open it and asse …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode server v4627 on 127.0.0.1:4627 with a new home. I used a scratch clone of MQTT-MCP (clones/v4627-mqtt) as the project repo.
1. Preconditions through the owner API: created project "V4627 Shared MQTT" (p-32eda025) with the clone, and a shared account "rita" with role reviewer on it (random password).
2. As the owner, in the composer UI (#/project/p-32eda025/new), submitted a default Agent task "Add a CHANGELOG note about topic validation (QA v4627 fake run)." The run summary showed no check command. Run 2610252058-ce490419 finished with pattern solo, checkpointOnFinish undefined. The fake agent left claude-27bbe0e8.txt untracked in the worktree.
   - Owner API GET review-coverage returned {head: 2b97323 (the base commit), workingChanges: true, files: [], coverage 0/0}.
   - Owner GET diff returned ["claude-27bbe0e8.txt"].
3. As the reviewer, in a fresh headless Chrome with no owner token: signed in through the shared login form, opened Results and clicked the run. The page showed:
   - "0 of 0 visible files reviewed at 2b97323ce7d2"
   - one diff card for claude-27bbe0e8.txt
   - an enabled, unchecked "Reviewed claude-27bbe0e8.txt" checkbox
   - no note about uncommitted changes
   The shared GET /review-coverage response has no workingChanges field: {scope, omittedCount:0, head:2b97323…, files:[], reviewed:[], stale:false, coverage:{changed:0,…}}.
4. Ticked the checkbox. POST /review-coverage returned 409 {"error":"Commit the workspace changes before recording review coverage."}. The checkbox reverted, and the page-level alert showed that message. A reviewer cannot commit. Screenshots: shots/v4627/rev-uncommitted-1-before-tick.png and rev-uncommitted-2-after-tick.png.
5. Contrast, owner #/review/<run>/<branch>: the "Human review coverage" panel says "The diff includes working changes. Commit them before recording review coverage." It shows 0 checkboxes, and the file list is headed "Working changes" (shots/v4627/001-owner-review-coverage.png).
6. Committed the untracked file in the scratch-clone run worktree and reran the reviewer script. The page then showed "0 of 1 visible files reviewed at f83edd5ca337". Ticking returned POST 200 and the line changed to "1 of 1". So the refusal for uncommitted work is intended; the defect is only how the shared dashboard presents it.

Reproduced 1/1 on a fresh server and profile; the reporter saw it 2/2. It is not caused by the tester's environment: the selectors are the dashboard's own classes, the accou …

</details>

### t01-10 · minor · Opening an old or invalid token link shows raw JSON instead of a sign-in page

Source: tester unit shell-navigation-settings-2; observed with fake-agents; features SHL-44.

**Repro**

> 1. Restart a server with a random token (or use any wrong token).
> 2. Open http://127.0.0.1:<port>/?token=<old>.

**Expected:** The HTML locked page, explaining the link expired and where to find the new one.

**Actual:** HTTP 403 with body {"error":"That link is from an earlier code-flow session; use the one printed when it last started"} rendered as plain JSON text.

**Root cause (verifier):** The cause is in src/server.ts:1551, inside the top-level GET "/" branch (lines 1547-1556): `if (!tokenMatches(given, auth.token)) throw new HttpError(403, "That link is from an earlier code-flow session; ...")`.
The thrown HttpError reaches the generic catch in listener() at src/server.ts:2799-2803, which always replies with send(res, status, { error, confirm, signIn }), meaning JSON. That catch has no HTML branch for page navigations and does not add the NO_FRAMES headers.
The sibling at line 1550 has the same problem: the LAN listener answers ?token= with a 403 JSON "Use a phone pairing link..." error.
The no-cookie path a few lines below (1558-1560) does writeHead(401, text/html + NO_FRAMES) and ends with LOCKED_PAGE / PHONE_LOCKED_PAGE, both built with lockedPage() at src/server.ts:464-488. That is the HTML page the stale link should also show.
The check also runs before the owner cookie is considered, so a browser that is already signed in gets raw JSON instead of the app.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/security-review.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/installation.md`

**Suggested fix:** 1. In src/server.ts, next to LOCKED_PAGE, add a STALE_LINK_PAGE built with lockedPage("link expired", ...). It should say something like: "That link is from an earlier code-flow session. code-flow makes a new link each time it starts: find the line `Open http://localhost:${PORT}/?token=…` where code-flow was last started (the terminal, or the preview's server log) and open that link here."
2. At line 1551, replace the throw with:
   `res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", ...NO_FRAMES }); return res.end(STALE_LINK_PAGE);`
   The referrer-policy header keeps the stale token out of any outgoing Referer.
3. Do the same at line 1550 for the LAN listener: answer with PHONE_LOCKED_PAGE (or a variant of it) as HTML instead of throwing JSON.
4. Optional: if the request already carries a valid owner session (`owner` is true), 302 to "/" without a set-cookie instead of showing the error, so an old bookmark o …

**Suggested regression test:** In test/security-review.test.ts (it already spawns real servers with fake agents and has the get() and noFrames() helpers), add a test named "an old or wrong token link shows the HTML sign-in page, not JSON". It should:
- Call r = await get(byLink.port, "/?token=" + "0".repeat(48)) and assert r.status === 403, that r.headers["content-type"] matches /^text\/html/, that the body matches /earlier code-flow session/ and /<title>code-flow/, and that it does not match /^\{"error"/. Also call noFrames( …

<details><summary>Verifier's independent reproduction</summary>

I started my own fake-mode QA server: qa-server.sh start v4627 4627 fake (home .../scratchpad/qa/homes/v4627).
1) curl -i "http://127.0.0.1:4627/?token=old-stale-token-123" returned HTTP/1.1 403, content-type: application/json, body {"error":"That link is from an earlier code-flow session; use the one printed when it last started"}. The response also had no x-frame-options or CSP frame-ancestors headers.
2) I ran headless Chrome with the script .../scratchpad/qa/work/v4627/stale-link.mjs (log: stale-link.log):
 - A: a fresh browser context with no cookie opened /?token=<48-hex wrong token>. It got status 403, application/json, an empty title, and Chrome's raw JSON viewer showing the error string (screenshot .../scratchpad/qa/shots/v4627/A-fresh-stale-link.png).
 - A2: the same browser opened plain "/". It got 401 text/html and the styled "Open code-flow from its link" locked page (A2-fresh-plain-root.png). So the HTML page exists, but the stale-link path never uses it.
 - B: a browser already signed in with the correct link and a valid owner cookie opened a stale link, for example from history or old terminal scrollback. It still got the 403 raw JSON (B-signedin-stale-link.png). Plain "/" in that browser returns 200 and the app.
Reproduced every time (4/4 across curl and the browser). The code path does not depend on fake vs real agents, the browser profile or the tester's script: it is a plain GET / with a non-matching token. Restarting the server gives the same result, because auth.token = CODEFLOW_TOKEN || randomBytes(24) at src/server.ts:352 makes every earlier link invalid after a restart.
Not by design:
 - docs/installation.md:79 says "A restart creates a new session; use the new link if your browser asks you to sign in", which describes a sign-in page.
 - No test asserts JSON for a wrong token. test/security-review.test.ts covers only the valid-link 302.
 - The same request handler deliberately serves HTML LOCKED_PAGE / PHONE_LOCKED_PAGE for the 401 case.
Cleanup: I stopped the server (port 4627/4628 have no listeners) and created no runs or worktrees. The QA home already held a run file (runs/2610251807-6763cef1.deleted) timestamped before my session; it is not mine.

</details>
