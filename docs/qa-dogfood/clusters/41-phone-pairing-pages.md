# Cluster 41 · phone-pairing-pages

**Phone pairing & phone-facing pages: ghost devices, raw JSON errors, stale copy, device list**

Status: **fixed and verified including listener-aware boot** · 13 issues · branch `codex/qa-phone-pairing-pages`

Planner notes: In the '/r/' branch of handlePublic in src/server.ts (~1031-1048), every GET of the full-control link within the pairing window creates a new 30-day device (t22-2/S13-2). Skip pairing when the request already carries a valid phone session, and don't let link-preview fetches pair. The 33rd pairing throws a plain Error, which returns 500 JSON and logs the pairing secret (t22-3, src/phone-sessions.ts:50, src/log.ts). All the failure paths return raw JSON (t21-9/t22-5); render HTML pages instead. PHONE_LOCKED_PAGE and other strings point to the 'Automations page' or 'Settings → Remote access' (t21-8/t01-16/S00-6/t22-8; also ui/collab-settings.tsx). t21-10: the finished-run page footer says it refreshes every 15 s, but it doesn't (src/remote.ts:212). Devices: labels are the raw User-Agent cut at 120 characters (t21-6/t22-6), and the list never refreshes (S14-5, ui/phone-devices.tsx). Derive a friendly label and refresh the list while pairing is open. Duplicate groups: [["t22-2","S13-2"],["t21-9","t22-5"],["t21-8","t01-16","S00-6","t22-8"],["t21-6","t22-6","S14-5"]]

Likely files: `src/server.ts`, `src/phone-sessions.ts`, `src/log.ts`, `src/remote.ts`, `ui/phone-devices.tsx`, `ui/remote-access.tsx`, `ui/collab-settings.tsx`

## Continuation outcome (2026-10-26)

| Issue | Outcome and verification |
| --- | --- |
| t22-2, S13-2 | Pairing GET is side-effect free, including link preview fetches. A same-origin browser form POST pairs the device; valid sessions are reused without extending expiry. Chrome repeated scans and a cross-site QR scanner keep one record and the same cookie. No-referrer forms may send Origin:null, accepted only with browser-owned Sec-Fetch-Site:same-origin; missing or cross-site origin evidence is refused. Independent review found and repaired expired cross-site re-entry: even an expired GET can perform the cookie check, while POST refuses all new expired enrollments. A separate Chrome fixture verifies preserved session and run deep link after expiry. |
| t22-3 | The32-device cap raises typed409. Pairing renders a readable limit page and guidance to revoke one device; no cookie is set. Storage failures return503 HTML and preserve the original file. Request-failure logging removes phone capability segments, including encoded route names, and new log files use0600. Concurrent unit admissions stop at32; revoke frees a slot. Actual Chrome reaches the limit and logs contain no pairing path. |
| t21-9, t22-5 | Expired, rotated, disabled, restricted and missing-run phone links return styled HTML with no-store/frame protections and no-referrer. Existing statuses remain403/404; unknown links share a generic explanation. A failed pairing has409/503 recovery guidance. Chrome mobile layouts were checked for overflow and screenshots inspected. |
| t21-8, t01-16, S00-6, t22-8 | Locked-phone, HTTPS prerequisite and collaboration setup messages now name Settings → Connections → Share access → Connect my devices. Revocation guidance names the current Full control from remote devices toggle. Real UI revocation shows the corrected page and leaves the second phone signed in. |
| t21-10 | Finished-run pages explicitly request manual refresh. Their footer and lack of refresh metadata now agree; home/running pages retain15-second refresh. Unit checks cover all three states; Chrome opens an actual finished fake-agent run and inspects its footer/metadata. |
| t21-6, t22-6, S14-5 | New sessions store short device/browser labels; old Mozilla labels are presented readably without rewriting credentials. Rows show a short stable identifier, pairing timestamp and expiry, with distinct accessible revoke names. Visible settings poll every10seconds and display errors inline without repeated toasts. Two identical iPhone browsers appear automatically with distinguishable rows; revoking the selected device leaves the other valid. Renaming was optional and is not added. |

Validation: typecheck;36 related unit/HTTP/security checks (five new); six new real-Chrome scenarios; one original full-control phone Chrome scenario including a cross-site QR scanner. All use scratch homes, tokens, TLS certificates, repositories and fake CLIs. The actual build in the read-only scenario uses a fake Claude provider; no new real-agent evidence is claimed. All fixture child servers stop by their own PIDs and fixture state is removed.

Browser page exceptions are absent. Console capture is scoped to deliberate401/403/404/409/503 navigation failures, a favicon404, concurrent policy count409, with no local-only phone boot API errors after cluster42 integration. The narrow team-link/workspace allowance was removed; all six Chrome cases pass with the stricter classifier. Integrated evidence: `/private/tmp/codeflow-qa-continue/phone42-original.log` and `phone42-pairing-shots/`. Server logs contain only deliberate broken phone storage diagnostics; cap responses do not log a capability. Evidence: `/private/tmp/codeflow-qa-continue/pair41-{related-final,typecheck-final,e2e-final,original-ui}.log` and `pair41-shots/` (screenshots, console URLs and three server logs).

Existing tests were updated only for changed contracts: HTTP pairing helpers explicitly POST rather than expecting GET to mint a cookie; the TLS fixture includes a subjectAltName for42's certificate validation. Broader checks exposed two old expectations from previously integrated clusters: the self-capture error now names Code Flow (27), and missing-repository errors preserve Git's lowercase wording (33); those assertions now match the intended behavior without weakening status checks. A controlled-checkbox test race and a revoke/reload race were fixed by waiting for their persisted API state. The no-referrer Origin:null failure was a real browser compatibility defect in the initial implementation and was repaired, not ignored.

## Issues

### t22-2 · minor · Every GET of the full-control pairing link creates a new 30-day device session (link previews and re-opens create ghost devices)

Source: tester unit infra-remote-devices-clients-2; observed with api; features REM-16, REM-17.

**Repro**

> 1. t22 with HTTPS (Tailscale cert) and LAN_ALLOW_LOCAL=1: Settings → Connections → Share access → Connect my devices → enable Full control. 2. Copy link. 3. curl the pairing link 3 times with a link-preview User-Agent (e.g. Slackbot-LinkExpanding). 4. Refresh devices / GET /api/remote/devices.

**Expected:** A pairing link pairs one device, or at least link-preview or bot fetches do not mint full-control sessions. Re-opening the link on the same phone reuses its session.

**Actual:** The device count went from 1 to 4. Each GET minted a full-control cookie valid 30 days, labelled with the raw User-Agent. 28 more GETs filled the 32-device cap (see t22-3).

**Root cause (verifier):** src/server.ts:1036-1041. The GET /r/<controlToken> branch on the LAN listener calls phoneSessions.pair(user-agent, controlToken) every time the link is fetched inside the pairing window. It never checks whether the request already carries a valid session cookie; phoneSignedIn(req) exists at src/server.ts:450-452 but is not used here. It then overwrites the browser's single cookie (PHONE_COOKIE = codeflow_phone_<REMOTE_PORT>, src/server.ts:442). The previous device record stays live but its token is no longer held anywhere.

src/phone-sessions.ts:44-55. pair() always appends a new record. It has no de-duplication and no way to replace the caller's existing record. It also stores the raw User-Agent as the label (cut to 120 characters).

ui/phone-devices.tsx:16-21. Each row shows only the label and expiry date. Without the creation date or a "last used" time, duplicates look identical and the user cannot tell which one to revoke.

Minting a session on any GET with no confirmation step is a deliberate design choice. The comment at src/server.ts:490-496 explains it: the sign-in page avoids a redirect so the SameSite=Strict cookie survives QR-scanner handoff. The multi-device behaviour i …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/phone-sessions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/phone-devices.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-security-http.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-sessions.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/automations.md`

**Suggested fix:** 1. Required fix: re-use the session of an already signed-in device. In the /r/<controlToken> branch (src/server.ts:1036), check `phoneSignedIn(req)` before calling pair(). If it is true, reply with signingInPage(target) and send no new Set-Cookie, so no device is created. Optionally refresh that device's record. Also let pair() take the caller's current cookie: if that cookie matches a live record from the current generation (or one that is expired or invalid), revoke or replace that record in the same change() call, so a re-pair never leaves an orphan.

2. Optional hardening against link fetchers: make the GET side-effect free. The GET would return the signing-in page, and its inline script would do a same-origin `fetch(POST /r/<token>/pair)` that mints the cookie and then calls location.replace(target). Clients that don't run JavaScript (preview bots, prefetchers) would then never mint a session. This keeps the SameSite reasoning in the src/server.ts:490-496 comment intact, because t …

**Suggested regression test:** Add a test to test/phone-security-http.test.ts named "re-opening the pairing link on a paired device reuses its session". Start a TLS instance and turn on control. Pair once with `phone(secure, info.phonePath)` and keep `first` = the cookie. Then call `phone(secure, info.phonePath, first)` again. Assert status 200 and that the response has no new Set-Cookie (or the same token). Assert `(await local(secure, "/api/remote/devices")).body.length === 1`, and that `/api/runs` with `first` is still 200 …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server named v4677t222 on port 4677, with remote port 4678. I gave it a self-signed TLS cert through CODEFLOW_TLS_CERT and CODEFLOW_TLS_KEY, the same method test/phone-security-http.test.ts uses, and set CODEFLOW_LAN_ALLOW_LOCAL=1. I did not use Tailscale. The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4677/t22-2.mjs and its output is in t22-2.log in the same folder.

1. In the UI (Settings > Connections > Connect my devices) I turned on remote access, chose Wi-Fi and turned on Full control. The API then reported control=true, secure=true and a pairing window of 10 minutes.
2. Device count was 0. One GET of the link with an iPhone User-Agent paired a device. The cookie had HttpOnly, SameSite=Strict, Secure and Max-Age=2592000 (30 days). Count went to 1.
3. Three GETs with the User-Agent "Slackbot-LinkExpanding" each returned 200 with a Set-Cookie. Count went to 4.
4. The iPhone GET'd the link again, sending its still-valid cookie (/api/runs returned 200 with it). The server issued a new cookie and both the old and new cookies stayed valid. Count went to 5. The new device has the same label as the first.
5. In a real headless Chrome with an iPhone User-Agent, opening the link went through "Signing in…" and landed on "/". Reloading did not create a device (6 stayed 6), because location.replace leaves the link. Opening the link again did create one (6 to 7). The browser holds only one cookie, codeflow_phone_4678, so the earlier device record is orphaned: nobody holds its token, but it stays listed as active for 30 days.
6. The UI showed "Paired devices · 7". Four rows had the identical iPhone User-Agent, and each row shows only the label, the expiry date and a Revoke button. There is no way to tell which row is the phone actually in use. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4677t222/002-paired-devices.png. No console errors or 5xx responses.
7. To check the environment, I restarted without CODEFLOW_LAN_ALLOW_LOCAL and turned control back on. A GET with the Slackbot User-Agent from this machine, to both 127.0.0.1:4678 and 192.168.0.100:4678, was cut off during the TLS handshake (curl exit 35). It created 0 devices.
8. I then turned remote access, LAN and control off, confirmed nothing was listening on 4678, and stopped the server. I created no  …

</details>

### S13-2 · minor · Every GET of the full-control pairing URL within its 10-minute window calls phoneSessions.pair and creates a new device record. Reloads, re-scans and link-preview or prefetch fetchers create duplicate or ghost paired devices until the 32-device cap blocks pairing.

Source: code-level suspect at `src/server.ts:1038` (confirmed hands-on).

**Repro**

> QA server s13 (fake mode) started with CODEFLOW_TLS_CERT/KEY and CODEFLOW_LAN_ALLOW_LOCAL=1. In Settings > Connections > Share access > Connect my devices I turned on 'Enable remote access', chose 'Wi-Fi · local network' and turned on 'Full control from remote devices'. (a) One headless Chrome context with an iPhone user agent (a single phone with one cookie jar) opened https://127.0.0.1:4554/r/<controlToken> three times. Each returned 200 and landed on '/'. GET /api/remote/devices then listed 3 devices with the same 'Mozilla/5.0 (iPhone; ...' label, and the Settings card showed 'Paired devices · 3' (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/s13/remote-devices-card.png). (b) After a fresh link, 33 curl GETs with user agent 'Slackbot-LinkExpanding 1.0': requests 1-32 returned 200 and created 32 devices. Request 33 returned HTTP 500 {"error":"Too many paired devices; revoke an existing device first"}, so no real phone can pair until devices are revoked by hand. Remote access was turned off right afterwards and port 4554 was confirmed closed. Side note: the server log line for that failure records the full pairing path, 'GET /r/2d42d7b9…<full control token> failed: Too many paired devices'.

**Expected:** Opening the pairing link again from a device that is already paired (valid phone cookie) reuses or refreshes that device instead of adding one. Non-browser fetchers should not get a full-control session. Hitting the cap should give a clear 4xx (409/429) message, and the pairing token should not be written to the server log.

**Actual:** Each GET adds a device: 3 records for one phone. 32 prefetch or preview GETs fill the cap, after which pairing fails with HTTP 500.

**Root cause (verifier):** handlePublic() (src/server.ts:1034-1043) calls phoneSessions.pair() on every LAN GET of /r/<controlToken> while pairingUntil has not passed. It never checks whether the request already carries a valid phone cookie, and the link is not single-use. PhoneSessions.pair (src/phone-sessions.ts) always appends a new StoredDevice. When there are 32 live devices it throws a plain Error, which the public handler turns into HTTP 500. A browser that re-opens the link gets a new cookie, and its previous record stays live server-side for 30 days with a token nobody holds.

**Suggested fix:** In the /r/<controlToken> branch, if phoneSignedIn(req) is already true, skip pair() and just send signingInPage. Optionally make GET render a 'Pair this device' page that sets the cookie on a same-origin POST (or JS-initiated fetch), so link unfurlers and prefetchers that only GET never create sessions. Map the cap error to HttpError(409) and redact /r/<token> paths in request-failure logging.

**Suggested regression test:** In test/phone-security-http.test.ts: GET the pairing link twice with the cookie returned by the first response and assert that /api/remote/devices has length 1. GET it 33 times without cookies and assert the 33rd returns 409 with the cap message, not 500. If the POST-confirm design is adopted, assert that a plain GET creates 0 devices.

### t22-3 · minor · 33rd pairing returns HTTP 500 with raw JSON to the phone and logs the pairing secret to the server log

Source: tester unit infra-remote-devices-clients-2; observed with api; features REM-17, REM-16.

**Repro**

> 1. With full control on and a valid pairing window, open the pairing link until 32 devices exist (or use curl in a loop). 2. Open it once more.

**Expected:** A clear phone-facing page (4xx) saying the device limit is reached and how to revoke. No secrets in logs.

**Actual:** HTTP 500 with body {"error":"Too many paired devices; revoke an existing device first"} shown as raw JSON. server.out records 'code-flow: GET /r/09a32b5a8a22d92c7f433354a88fceb2dd78bb3f851450d7 failed: Too many paired devices', i.e. the full-control pairing token.

**Root cause (verifier):** 1. Wrong status. src/phone-sessions.ts:50 throws a plain Error inside PhoneSessions.pair(): `if (live.length >= 32) throw new Error("Too many paired devices; revoke an existing device first")`. src/server.ts:1038 (the /r/<token> handler, which does `await phoneSessions.pair(...)`) does not catch it. The error reaches listener() at src/server.ts:2800, which maps anything that is not an HttpError to status 500.

2. Raw JSON on the phone. src/server.ts:2803 always answers errors with send() from src/http.ts:7, which always writes application/json, even on the /r/ browser route. The 403 "This pairing link expired" at src/server.ts:1037 also reaches the phone as raw JSON, so the problem covers every error on that route, not only the cap.

3. Secret in logs. src/server.ts:2801 runs `if (status >= 500) logError(`${req.method} ${req.url?.split("?")[0]} failed`, err)` without redacting. The /r/<token> path segment is the read-only token or the full-control pairing token. logError (src/log.ts:42-45) writes it both to the console (server.out) and to CODEFLOW_HOME/server.log through appendFileSync. server.log is created with the default 0644 mode, while remote.json is 0600. Any other 5xx on /r …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/phone-sessions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/log.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-sessions.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-security-http.test.ts`

**Suggested fix:** 1. Typed limit error. In src/phone-sessions.ts:50, throw a typed error instead of a plain Error: either HttpError(409, ...) imported from ./http.js, or an exported PhoneDeviceLimitError that server.ts maps. Make the storage-unreadable failure (line 23) map to 503.

2. Phone-facing HTML page. In the /r/ handler (src/server.ts:1036-1042), wrap phoneSessions.pair() and the expired-link check, and answer with a small HTML page instead of JSON. Model it on signingInPage (src/server.ts:497) and keep the same no-store, NO_FRAMES and no-referrer headers. Use status 409 for "This computer already has 32 paired devices. On the computer, open Settings > Remote access and revoke a device, then choose New link." Use 403 for an expired link and 503 for unavailable storage.

3. Redact secret paths. In listener() (src/server.ts:2801), redact secret-bearing path segments before logging, e.g. `const path = (req.url ?? "").split("?")[0].replace(/^\/r\/[^/]+/, "/r/<redacted>")`. Better still, add a centra …

**Suggested regression test:** 1. test/phone-sessions.test.ts: pair 32 devices on one generation, then assert that the 33rd `sessions.pair(...)` rejects with the typed limit error (instanceof HttpError with status 409, or PhoneDeviceLimitError). Also revoke one device and assert that pairing succeeds again.

2. test/phone-security-http.test.ts: in the TLS instance, call phone(secure, info.phonePath) 33 times. Assert:
   - the 33rd returns status 409 (not 500);
   - its body starts with "<!doctype html" or contains "revoke" an …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4679 on port 4679 with the remote listener on 4680. I moved the old v4679 home aside first so the home was new. Before starting I exported CODEFLOW_TLS_CERT and CODEFLOW_TLS_KEY pointing at a throwaway self-signed cert, plus CODEFLOW_LAN_ALLOW_LOCAL=1. This is the same setup test/phone-security-http.test.ts uses, so full control ran over real HTTPS and did not need the insecure-dev override.

1. POST /api/remote {enabled:true, lan:true, control:true} with the owner bearer. The response showed secure:true, control:true and a pairingUntil 10 minutes ahead.
2. curl -k https://127.0.0.1:4680/r/<controlToken> 32 times, each with a different User-Agent. All 32 returned 200, and GET /api/remote/devices then listed 32 devices.
3. The 33rd request returned "HTTP/1.1 500 Internal Server Error", content-type application/json, body {"error":"Too many paired devices; revoke an existing device first"}.
4. I opened the same link in headless Chrome with a fresh profile and iPhone viewport/UA, ignoring HTTPS errors. It got status 500 and the page showed only the raw JSON in Chrome's JSON viewer with a "Pretty-print" checkbox (screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4679/t22-33rd-phone.png).
5. I grepped the home for the full control token:
   - server.out had 1 hit: "code-flow: GET /r/<CONTROL_TOKEN> failed: Too many paired devices; revoke an existing device first".
   - server.log had 1 hit: a JSON line with message "GET /r/<CONTROL_TOKEN> failed" and a stack trace.
   - server.log is mode 0644, while remote.json and phone-devices.json are 0600. So the secret goes from an owner-only file into a world-readable log file that is kept across restarts.

Cleanup: I POSTed /api/remote {enabled:false, lan:false, control:false}, which closed 4680. I then stopped v4679 with qa-server.sh and deleted the test cert and key. I created no runs, and nothing is left listening.

Checks that it is not by design or caused by the tester's setup:
- None of docs/automations.md, docs/security.md or docs/api.md mentions a device cap or this response.
- The only limit test, test/phone-sessions.test.ts, does not cover the cap.
- A fresh profile, real TLS and plain curl reproduce it, so the tester's environment is not the cause.

Partly mitigating: the logged token only pairs a phone while the 10-minute pairingUntil window is open. Pairing also has to come from a no …

</details>

### t21-9 · minor · Human-facing phone links return raw JSON errors

Source: tester unit infra-remote-devices-clients-1; observed with api; features REM-11.

**Repro**

> 1. Open an expired pairing link on a phone (after 10 min), or
> 2. Open the read-only link while a project filesystem restriction is active, or
> 3. Open a rotated (old) /r link.

**Expected:** A small styled HTML page explaining what happened and what to do, like the lock page.

**Actual:** The phone browser shows plain JSON, e.g. {"error":"This pairing link expired. Choose New link on this computer to pair a phone."} or {"error":"Phone views are unavailable under custom filesystem restrictions"} or {"error":"Not found"}.

**Root cause (verifier):** src/server.ts:1031-1048, in handlePublic's `/r/` branch. Five failure paths all `throw new HttpError(...)`:
- :1033 remote access disabled → 404
- :1037 pairing link expired → 403
- :1045 unknown, rotated or read-only token mismatch → 404
- :1046 `fileAccess.hasRestrictions()` → 403
- :1048 `renderRemote` returned null for an unknown run → 404

The generic catch in `listener()` at src/server.ts:2798-2804 turns every HttpError into JSON through `send()` (src/http.ts:7-10, content-type application/json). That suits /api clients but not these browser navigations. The success paths on the same route write HTML directly: `signingInPage` at :1040-1041 and `renderRemote` at :1049-1050. The styled builder `lockedPage` already exists at :464 and is used for PHONE_LOCKED_PAGE at :483/:1560, but the `/r/` error paths never use it.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-security-http.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/server-reliability.test.ts`

**Suggested fix:** In handlePublic's `/r/` GET branch, write a styled HTML page instead of throwing HttpError. Keep the same status codes (403/404) so the existing status-only tests and the security semantics are unchanged.

1. Next to PHONE_LOCKED_PAGE, add constants built with the existing `lockedPage(title, body)` (src/server.ts:464):
   - PAIRING_EXPIRED_PAGE: "This pairing link expired". Body: "On your computer, open code-flow → Remote access, choose New link and scan the new QR code. Links last ten minutes."
   - PHONE_RESTRICTED_PAGE: "Phone view is paused". Body: "This computer has custom filesystem restrictions, so the read-only phone view is off. Remove the restrictions in Settings → Projects & access to use it again."
   - PHONE_LINK_GONE_PAGE: a single generic "This link doesn't work" page. Body: "It may have been replaced by a new link, or remote access may be off. Ask for the current link on the computer running code-flow."

   Use one generic page for all 404s (disabled, unknown, rotated t …

**Suggested regression test:** 1. test/phone-security-http.test.ts, test "expired pairing links stay expired after restart…": next to the existing `status === 403` assertion on `phone(instance, info.phonePath)`, assert:
   - the response content-type starts with text/html (expose `response.headers["content-type"]` from the `phone()` helper)
   - the body matches /pairing link expired/i and /New link/
   - `body.trim().startsWith("{")` is false
   - there is no set-cookie header

2. test/server-reliability.test.ts, phone test  …

<details><summary>Verifier's independent reproduction</summary>

I started my own fake-mode server: `qa-server.sh start v4625 4625 fake`, with CODEFLOW_LAN_ALLOW_LOCAL=1 so a phone on the same machine can connect and CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL=1 to allow pairing over HTTP. The home had no remote.json and no live runs. I set up preconditions through the API and opened every link in a separate Playwright context set up as a phone: 390x844, mobile, iPhone user agent, no owner cookie. Scripts: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4625/t21-9-a.mjs and t21-9-b.mjs. Logs: t21-9-a.log and t21-9-b.log in the same folder.

Read-only link on 127.0.0.1:4625 (remote access on):
- The valid /r/<tok> link returned 200 text/html, the styled page "No runs yet".
- /r/<tok>/run/nope returned 404 application/json `{"error":"Not found"}`.
- After "New link" (POST /api/remote {rotate:true}), the old /r/<tok> returned 404 application/json `{"error":"Not found"}`.
- With a read deny on project MQTT-MCP (PUT /api/projects/p-ef01794b/filesystem-policy, read.deny=["secrets"]), the current link returned 403 application/json `{"error":"Phone views are unavailable under custom filesystem restrictions"}`. After I cleared the policy it returned 200 HTML again.
- With remote access turned off, the link returned 404 JSON `{"error":"Not found"}`.

Pairing link: I did not wait 10 minutes. I stopped the server, set remote.json in my QA home to enabled, lan, control and pairingUntil = now-60s, then restarted. Opening http://127.0.0.1:4626/r/<controlToken> returned 403 application/json `{"error":"This pairing link expired. Choose New link on this computer to pair a phone."}`. The old pairing link after rotation returned 404 JSON `{"error":"Not found"}`.

For comparison, an unsigned phone opening http://127.0.0.1:4626/ gets the styled 401 HTML "Scan the QR code again" card. Screenshots ro-restricted.png and pair-expired.png in the work folder show Chrome's raw JSON viewer at desktop scale: tiny monospace text on a blank page. phone-lock-page.png shows the styled card.

Aggravating factor: the read-only view refreshes itself every 15 s (src/remote.ts:193). A phone left open on it switches to the JSON page as soon as the owner rotates the link, turns access off or applies a restriction, and it stays there because the JSON page doesn't refresh.

Why I could not refute it:
- The docs (filesystem-policy.md: "Public read-only phone views are disabled under any custom re …

</details>

### t22-5 · minor · Phone-facing pairing errors are raw JSON (expired link → 403 JSON)

Source: tester unit infra-remote-devices-clients-2; observed with api; features REM-16.

**Repro**

> 1. Enable full control and copy the pairing link. 2. Wait more than 10 minutes, or pair after a restart where control was already on. 3. Open the link on a phone.

**Expected:** An HTML page in the style of the existing locked pages, telling the user to choose New link on the computer.

**Actual:** The phone browser shows the raw text {"error":"This pairing link expired. Choose New link on this computer to pair a phone."}.

**Root cause (verifier):** src/server.ts:1037, in the GET /r/<token> handler: when via === "lan", phone control is on and the token matches remote.controlToken, an expired link throws `new HttpError(403, "This pairing link expired. ...")`. The generic listener catch at src/server.ts:2797-2803 then sends every HttpError as JSON (`send(res, status, { error: err.message, ... })`), whether the request came from a fetch or from a top-level browser navigation.

/r/ is only ever reached by a top-level navigation: a QR scanner handing over the link, or a pasted link. Only the signed-out "/" path renders HTML for phones (src/server.ts:1557-1560 serving PHONE_LOCKED_PAGE, defined at src/server.ts:483 with lockedPage() at :464).

The same pattern applies to src/server.ts:1043 (`throw new HttpError(404, "Not found")` for a rotated or unknown token, which is what an old link shows after New link) and :1032 (remote access disabled).

Severity stays minor. The JSON text does tell the user what to do, the owner UI correctly hides the expired QR code and explains it, and security is unaffected. But on a phone the result looks like a crash: tiny, unstyled text in a JSON viewer, unlike every other phone-facing page.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-security-http.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/tailscale.e2e.ts`

**Suggested fix:** 1. Next to PHONE_LOCKED_PAGE (src/server.ts around line 488), add a static page built with lockedPage(), for example PAIRING_EXPIRED_PAGE = lockedPage("pairing link expired", "<h1>This pairing link expired</h1><p>Pairing links work for ten minutes. On your computer, open code-flow's <b>Remote access</b> settings, choose <b>New link</b> and scan the new QR code.</p><p>A new link signs out phones that are already paired.</p>"). The second paragraph matters because rotating does sign every device out.

2. In the /r/ handler at src/server.ts:1037, replace the throw with `res.writeHead(403, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...NO_FRAMES, "referrer-policy": "no-referrer" }); res.end(PAIRING_EXPIRED_PAGE); return true;`. Keep status 403, because the existing tests and e2e assert it, and set no cookie.

3. Optionally, give the via === "lan" 404 at :1043 (rotated or unknown token) the same treatment with a generic "This link doesn't work any more — scan  …

**Suggested regression test:** 1. test/phone-security-http.test.ts, in the test "expired pairing links stay expired after restart while existing device sessions retain their expiry" (lines 97 and 106): capture `const expired = await phone(instance, info.phonePath)` and assert:
   - `expired.status === 403`
   - `expired.cookie === undefined`
   - `/^<!doctype html>/i.test(expired.body)`
   - `/pairing link expired/i.test(expired.body)`
   - `/New link/.test(expired.body)`

   Optionally extend the phone() helper to return con …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4683, on port 4683 (remote listener on 4684) with CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL=1, the documented development switch that allows phone control over plain HTTP. I also set CODEFLOW_LAN_ALLOW_LOCAL=1, the same setting test/phone-security-http.test.ts uses, so a browser on this machine can act as the phone.

1. Owner side, through the UI at http://127.0.0.1:4683/#/settings/remote-access: turned on "Enable remote access", set Connection to "Wi-Fi · local network", and turned on "Full control from remote devices". The QR code appeared. /api/remote reported control:true and pairingUntil about 10.00 minutes ahead.
2. Control check: a fresh mobile Chrome context (iPhone user agent, 390x844) opened http://127.0.0.1:4684/r/<controlToken>. It got 200 with text/html, then the "Signing in…" page, then the app. One device was paired. A valid link works.
3. Expiry, using the restart path from the report and the project's own test (phone-security-http.test.ts:94): stopped the server, set pairingUntil to now minus 1s in my QA home's remote.json, and started it again. The owner UI correctly showed "Pairing link expired. Choose New link to pair another device." with no QR code and no Copy link button.
4. A fresh unpaired mobile context opened the old copied link. Result: 403, content-type application/json, empty title. The screen showed Chrome's raw JSON viewer (tiny monospace text and a "Pretty-print" checkbox) reading {"error":"This pairing link expired. Choose New link on this computer to pair a phone."}. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4683/phone-expired-link.png. The deep link /r/<token>/run/abc123 gave the same 403 JSON.
5. Comparison: the same unpaired phone opening "/" got 401 text/html with the styled "Scan the QR code again" page (PHONE_LOCKED_PAGE). Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4683/phone-signed-out-root.png.
6. Related case: after "New link" (rotate), the old link returned 404 application/json {"error":"Not found"}, which is also raw and gives no guidance.

Checked against the docs: docs/automations.md:127 and docs/security.md:29 only say that pairing links expire after ten minutes, including across restarts, and that they "expire closed". That is about security, not presentation. The code's own comments (ser …

</details>

### t21-8 · minor · Phone 'Scan the QR code again' page sends users to the Automations page, which no longer has Remote access

Source: tester unit infra-remote-devices-clients-1; observed with real-agents; features REM-11.

**Repro**

> 1. Pair a phone, then revoke it (or open the network listener root without a session).
> 2. Reload on the phone.

**Expected:** Guidance points to Settings, Connections, Share access, Connect my devices (Remote access).

**Actual:** 'On your computer, open code-flow's Automations page and scan the QR code under Remote access.'

**Root cause (verifier):** src/server.ts:483-488, the PHONE_LOCKED_PAGE constant, still has the old wording: "open code-flow's <b>Automations</b> page and scan the QR code under <b>Remote access</b>" (line 486). Commit 3e1dfd7 ("Add guided device connections and project invitations") moved the RemoteAccess component out of the Automations view into ui/connections.tsx:34 (Settings → Connections → Share access → Connect my devices, route #/settings/connections/devices). ui/automations.tsx:160 now holds only a pointer link, and the view is labelled "Scheduling" (ui/rail.tsx:416, ui/app.tsx:304), so nothing in the UI is called "Automations" any more. The page's second line (line 487) is also stale: it says "turning off full control from your phone", but the toggle is now labelled "Full control from remote devices" (ui/remote-access.tsx:98). It also leaves out "Revoke device", which is the action that produced this page in the repro. The page is served at src/server.ts:1560 to any network-listener visitor without a session.

Severity re-assessed from cosmetic to minor: the misdirection lands on exactly the person who has to re-pair. Following it leads to a page with no QR code. That page does link onward in one m …

**Files:** `src/server.ts`, `test/phone-security-http.test.ts`, `test/e2e/ui.e2e.ts`

**Suggested fix:** Rewrite the PHONE_LOCKED_PAGE body in src/server.ts (lines 486-487) to match the current UI. Suggested text: "This device isn't signed in to code-flow. On your computer, open <b>Settings → Connections → Share access → Connect my devices</b> and scan the QR code under <b>Remote access</b>." Then: "Revoking this device, making a new link, or turning off <b>Full control from remote devices</b> signs devices out." Optionally keep the wording in sync with the UI labels by building the path from the labels in ui/connections.tsx (CONNECTION_PURPOSES and "Connect my devices"), or note in a comment beside ConnectionsView that this server-rendered page names that path. Also check the similar stale label in ui/collab-settings.tsx:148 ("Settings → Remote access").

**Suggested regression test:** Add to test/phone-security-http.test.ts, in "phone control requires TLS and secure device sessions remain independently revocable", right after the revoked cookie returns 401 on /api/runs: const locked = await phone(secure, "/", first); assert.equal(locked.status, 401); assert.match(locked.body, /Connections → Share access → Connect my devices/); assert.doesNotMatch(locked.body, /Automations/). Optionally, in test/e2e/ui.e2e.ts at line 462, also check that the "Scan the QR code again" page conta …

<details><summary>Verifier's independent reproduction</summary>

Started a fresh fake-mode QA server, v4623t218, on port 4623, with network listener port 4624. I exported two development overrides: CODEFLOW_LAN_ALLOW_LOCAL=1, so a "phone" on this machine can reach the network listener, and CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL=1, so full control works over HTTP. Neither override changes the locked-page text. The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4623t218/repro.mjs and its output is in repro.log in the same folder.

Steps, all through the UI:
1. As the owner, opened Settings > Connections > Share access > Connect my devices (#/settings/connections/devices), ticked "Enable remote access", chose "Wi-Fi · local network" and ticked "Full control from remote devices".
2. A separate mobile-sized browser context (the phone) opened the pairing link http://192.168.0.100:4624/r/… and landed in the app as a signed-in phone. "Paired devices" then showed 1.
3. The owner clicked "Revoke device", and the count went to 0.
4. The phone reloaded http://192.168.0.100:4624/. It got 401 with the title "code-flow — scan the QR code". The page text was: "Scan the QR code again. This phone isn't signed in to code-flow. On your computer, open code-flow's Automations page and scan the QR code under Remote access. Making a new link, or turning off full control from your phone, signs phones out." Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4623t218/phone-2-after-revoke.png
5. A brand-new browser opening the listener root got the same 401 page, with the heading "Scan the QR code again".
6. Followed the instructions on the owner computer and opened #/automations. The page is now titled "Scheduling", in both the nav and the breadcrumb. It has no "Remote access" heading and no QR code, only the line "To access this computer from another device, open Connections → Share access." Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4623t218/003-automations-page.png

No console errors and no 5xx responses. Cleanup: turned remote access off through the UI (the listener on 4624 closed), stopped the server, created no runs, left nothing running.

Why this is not by design: docs/automations.md "Phone view" and docs/team-collaboration.md:11-15 both put the QR code under Settings → Connection …

</details>

### t01-16 · minor · Phone locked page points to a non-existent 'Automations page' for the QR code

Source: tester unit shell-navigation-settings-2; observed with code-reading; features SHL-44.

**Repro**

> 1. Enable the Wi-Fi/LAN listener with phone control.
> 2. Open the LAN URL on a phone that is not signed in.

**Expected:** Directions to the current location of the QR code (Settings → Connections → Connect my devices / Remote access).

**Actual:** The text reads 'open code-flow's Automations page and scan the QR code under Remote access'. 'Automations' is now 'Scheduling' and has no QR code; its own page says 'To access this computer from another device, open Connections → Share access'.

**Root cause (verifier):** src/server.ts:483-488: the PHONE_LOCKED_PAGE copy is hard-coded as "On your computer, open code-flow's <b>Automations</b> page and scan the QR code under <b>Remote access</b>." The copy dates from commit db247ed, when the RemoteAccess card was on the Automations page. RemoteAccess has since moved to ui/connections.tsx:36, purpose "devices", reached through Settings → Connections → Share access → Connect my devices. The Automations view was renamed "Scheduling" (ui/rail.tsx:416, ui/app.tsx:304, ui/activity.tsx:14, ui/settings-sections.ts:12), and ui/automations.tsx:160 now only links to "Connections → Share access". The server string was never updated. src/server.ts:1557-1560 serves it on the network listener to any browser that is not signed in.

There are similar stale paths nearby, though they are not part of this issue. src/server.ts:280 ("Settings → Remote access") and ui/collab-settings.tsx:149-150 ("Settings → Remote access") name a top-level 'Remote access' settings entry that no longer exists, although their links go to the right route.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-security-http.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-settings.tsx`

**Suggested fix:** Rewrite the PHONE_LOCKED_PAGE paragraph at src/server.ts:486 to match the current navigation and the docs. Suggested text: "This phone isn't signed in to code-flow. On your computer, open <b>Settings → Connections → Share access → Connect my devices</b> and scan the QR code under <b>Remote access</b>." Keep the second paragraph about new links signing phones out.

The next copy pass could align two related strings in the same way: the "Settings → Remote access" wording at src/server.ts:280 and ui/collab-settings.tsx:148-150.

Optionally, define the location text once (for example a constant shared by the server copy and the docs) so the next navigation rename cannot leave it stale.

**Suggested regression test:** In test/phone-security-http.test.ts the server already starts with CODEFLOW_LAN_ALLOW_LOCAL=1. Add a test that fetches `${remote}/` on the network listener with no cookie and asserts:
- the status is 401;
- the body matches /Settings → Connections → Share access/;
- the body does not match /Automations/.

As a lighter UI check, extend the existing step in test/e2e/ui.e2e.ts:462 so it also asserts that the locked page does not contain 'Automations' and does contain 'Connections → Share access'.

<details><summary>Verifier's independent reproduction</summary>

1. Exported CODEFLOW_LAN_ALLOW_LOCAL=1 and CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL=1. The first lets this computer reach the network listener, as test/e2e/ui.e2e.ts and test/phone-security-http.test.ts do. The second allows full control over HTTP. Then started a fake-mode QA server: qa-server.sh start v4639 4639 fake. The home had no remote.json, so remote access started off.
2. In a Playwright script (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4639/phone-locked.mjs) I opened http://127.0.0.1:4639/#/settings/connections/devices. Through the UI I ticked 'Enable remote access', set Connection to 'Wi-Fi · local network' and ticked 'Full control from remote devices'. The QR code ('Scan with your phone') appears there, inside the card titled 'Remote access' under Settings / Connections. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4639/001-settings-devices-qr.png
3. Opened #/automations. The h1 and the rail item read 'Scheduling'. No nav link is named 'Automations'. The page has 0 .phone-qr elements and 0 'Remote access' sections. Its own help says 'To access this computer from another device, open Connections → Share access.' Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4639/002-scheduling-page.png
4. In a fresh phone-sized browser context (390x844, isMobile, no cookies) I opened http://127.0.0.1:4640/ (the network listener). It returned HTTP 401 with the title 'code-flow — scan the QR code' and this text: "Scan the QR code again. This phone isn't signed in to code-flow. On your computer, open code-flow's Automations page and scan the QR code under Remote access." Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4639/phone-locked.png
5. Turned full control, Wi-Fi and remote access back off through the UI. /api/remote reported enabled:false, lan:false, control:false. Nothing listened on 4640 afterwards. No console errors and no 5xx responses. Stopped the server, and ports 4639/4640 are free. I created no runs.

Attempts to refute it:
- docs/automations.md:88-93 and docs/team-collaboration.md:11-15 both say the QR code is in Settings → Connections → Share access (→ Connect my devices). So the docs contradict the locked pa …

</details>

### S00-6 · minor · The phone locked page tells users to open the 'Automations' page and scan the QR code under 'Remote access', but remote access now lives in Settings → Connections → Share access → Connect my devices.

Source: code-level suspect at `src/server.ts:486` (confirmed hands-on).

**Repro**

> Fake server s00 started with CODEFLOW_LAN_ALLOW_LOCAL=1. Remote access was enabled through the API (Wi-Fi, briefly; turned off afterwards). GET http://127.0.0.1:4502/ without a phone cookie returns 401 with the page 'Scan the QR code again … open code-flow's Automations page and scan the QR code under Remote access.' (screenshot shots/s00/phone-locked.png). Following that on the computer: #/automations (labelled 'Scheduling' in the sidebar) has no 'Remote access' heading and no QR code, only the line 'To access this computer from another device, open Connections → Share access.' #/settings/connections/devices has the 'Remote access' heading and the QR code.

**Expected:** The page points to where the QR code now lives: Settings → Connections → Share access → Connect my devices (Remote access). docs/automations.md 'Phone view' already says Settings → Connections → Share access.

**Actual:** It names a page that is no longer called Automations in the navigation and has no QR code. A user signed out on their phone only reaches the QR code through an extra hop.

**Root cause (verifier):** PHONE_LOCKED_PAGE text was not updated when remote access moved from the Automations page to Settings → Connections (the 'Connect my devices' purpose in ui/connections.tsx).

**Suggested fix:** Change the copy to: 'On your computer, open code-flow's Settings → Connections → Share access → Connect my devices and scan the QR code under Remote access.'

**Suggested regression test:** In the phone e2e (test/e2e/ui.e2e.ts, the step that waits for 'Scan the QR code again'), assert the page mentions 'Connections' and 'Connect my devices' and does not mention 'Automations'.

### t22-8 · minor · Phone-side and error instructions point to pages that no longer exist ('Automations page', 'Settings → Remote access')

Source: tester unit infra-remote-devices-clients-2; observed with fake-agents; features REM-17.

**Repro**

> 1. Pair a phone, then revoke it (or press New link). 2. Reload the app on the phone.

**Expected:** Directions to the current location: Settings → Connections → Share access → Connect my devices.

**Actual:** 'Scan the QR code again — On your computer, open code-flow's Automations page and scan the QR code under Remote access.' Remote access now lives only under Settings → Connections. The 400 for enabling control without HTTPS also says 'Settings → Remote access'.

**Root cause (verifier):** Both strings are left over from before Remote access moved. The RemoteAccess component used to render in ui/automations.tsx (commit 43bcea4). It was moved out (commit fd93482) and now renders only in ui/connections.tsx:34 (Share access → Connect my devices, #/settings/connections/devices) and ui/connections.tsx:40 (Manage). The old Automations view is now titled "Scheduling" (ui/settings-sections.ts automations label; ui/app.tsx:304).
1) src/server.ts:483-487: the PHONE_LOCKED_PAGE body reads "open code-flow's <b>Automations</b> page and scan the QR code under <b>Remote access</b>." The server sends it at src/server.ts:1560 for any GET / on the network listener that has no session, for example after New link, turning off full control, a pairing expiry or a Wi-Fi/Tailscale switch.
2) src/server.ts:280: the HttpError(400) for control:true without HTTPS reads "Choose Set up secure remote access in Settings → Remote access." No Settings section has that name. The old hash #/settings/remote-access does redirect to the right place (ui/navigation.ts:35), but the text is wrong.
Related stale wording with the same cause: ui/collab-settings.tsx:149-150 shows "Set up/Turn on secure remote acc …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** In src/server.ts:486, change the PHONE_LOCKED_PAGE text to the current path, for example: "On your computer, open code-flow's <b>Settings → Connections → Share access → Connect my devices</b> and scan the QR code under <b>Remote access</b>." The trailing sentence about signing out can stay. In src/server.ts:280, change the message to "Full phone control requires HTTPS. Choose Set up secure remote access in Settings → Connections → Share access → Connect my devices." Update the visible text in ui/collab-settings.tsx:149-150 in the same way; its hrefs are already correct. Optionally, define the path once as a shared string constant (for example REMOTE_ACCESS_LOCATION) so the server messages and UI hints cannot drift apart again. The remote-tls.ts messages ("Remote access settings") are acceptable, because the card on that page is still headed "Remote access".

**Suggested regression test:** Extend the phone test in test/e2e/ui.e2e.ts. It already ends with `await tab.getByText("Scan the QR code again").waitFor()` after `api("/api/remote", { rotate: true })` (around line 462). Add assertions that the phone page text contains "Settings → Connections → Share access" (or "Connect my devices") and does not match /Automations/. For the 400, add a server-level test that starts the server without CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL and TLS (as test/e2e/tailscale.e2e.ts does with CODEFLOW_ …

<details><summary>Verifier's independent reproduction</summary>

I started QA server v4689 on port 4689 in fake mode. Its home had no remote.json and loaded 0 runs. Phase 1 exported CODEFLOW_LAN_ALLOW_LOCAL=1 so a local browser could act as the phone on the network listener (4690). HTTPS stayed enforced. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4689/t22-8-phase1.mjs. Log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4689/phase1.log.
(a) #/automations now opens a page titled "Scheduling". It has no Remote access card and no QR code (0 matches). It shows "To access this computer from another device, open Connections → Share access" (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4689/001-automations-page.png).
(b) The Settings nav lists General | Agents & models | Run defaults | Notifications | Connections | Integrations | Projects | Extensions | Data & storage | Advanced. It has no "Remote access" entry.
(c) On #/settings/connections/devices I used the UI to turn on Enable remote access and choose Wi-Fi. The full-control checkbox was disabled because there is no HTTPS. POST /api/remote {control:true} returned 400 {"error":"Full phone control requires HTTPS. Choose Set up secure remote access in Settings → Remote access."}.
(d) A fresh mobile browser context loading http://127.0.0.1:4690/ got a 401 page reading "Scan the QR code again — This phone isn't signed in to code-flow. On your computer, open code-flow's Automations page and scan the QR code under Remote access." (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4689/phase1-phone-locked.png).
Phase 2 restarted with CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL=1 so a phone could pair over HTTP (script t22-8-phase2.mjs, log phase2.log in the same folder). Through the UI I turned on remote access, chose Wi-Fi and turned on Full control. I paired a 390px phone context through the /r/<controlToken> link, and it reached the "What would you like to work on?" screen. I then pressed New link and confirmed Replace link. After a reload the phone showed the same text naming the Automations page and Remote access.
Cleanup: remote access was turned off through the UI (final enabled/lan/control all false) and port 4690 was no longer listening. The ser …

</details>

### t21-10 · cosmetic · Finished-run phone page says 'refreshes every 15 s' but does not refresh

Source: tester unit infra-remote-devices-clients-1; observed with fake-agents; features REM-11.

**Repro**

> 1. Enable remote access and open the read-only link.
> 2. Open a finished run.

**Expected:** The footer matches the behaviour (no refresh claim on static pages).

**Actual:** The run page has no meta refresh (refresh=0 in s17) but the footer still says 'Read-only view of code-flow · refreshes every 15 s'.

**Root cause (verifier):** src/remote.ts:191-212, in `page(title, body, refresh = true)`. The meta tag is conditional at line 193 (`${refresh ? '<meta http-equiv="refresh" content="15">' : ""}`), but the footer at line 212 is a fixed string: `<p class="foot">Read-only view of code-flow · refreshes every 15 s</p>`. src/remote.ts:242 (`renderRemote`) renders run pages with `page(..., renderRun(...), run.status === "running")`. Any run whose status is done, failed, cancelled, stopped or interrupted (Status, src/engine.ts:158) therefore gets no auto-refresh but still claims a 15 s refresh. The home page (line 237) uses the default `refresh = true`, so its claim is accurate.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/remote.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/automation.test.ts`

**Suggested fix:** Make the footer depend on the same `refresh` flag as the meta tag in `page()`, for example `<p class="foot">Read-only view of code-flow${refresh ? " · refreshes every 15 s" : " · reload for updates"}</p>`, or drop the suffix entirely when `refresh` is false. Optional alternative: give finished run pages a slow refresh (e.g. 60 s) instead of none, and render the footer from the same interval value. An interrupted run that is resumed goes back to "running", and its static phone page would never notice; a single interval constant would keep the meta tag and the footer from drifting apart again.

**Suggested regression test:** Extend the "phone view: read-only HTML with everything escaped" test in test/automation.test.ts (around line 557), which already renders the home page and a finished run's detail page with renderRemote.
- Home: `assert.match(home, /http-equiv="refresh"/)` and `assert.match(home, /refreshes every 15 s/)`.
- Finished run detail: `assert.doesNotMatch(detail, /http-equiv="refresh"/)` and `assert.doesNotMatch(detail, /refreshes every/)`.
- Optionally, render a run while it is still running and assert …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4627 on 127.0.0.1:4627. The home had no runs and no remote.json. Steps:
1. Precondition, set up through the API: one solo fake run on MQTT-MCP with checks off (run 2610252246-826908aa). It reached status "done".
2. Through the UI: Settings -> Connections -> Share access -> Connect my devices. Ticked "Enable remote access" and left the connection on "This computer only". Took the read-only link from the "Open" button (/r/<token>) and opened it on 127.0.0.1:4627 in a new tab at 390x844.
3. Home page: 1 `<meta http-equiv="refresh" content="15">`, footer "Read-only view of code-flow · refreshes every 15 s". A JS marker set on the page was gone after 17 s, so it really reloaded.
4. Clicked the finished run (badge "Done"). The run page has 0 meta refresh tags, but the footer still says "Read-only view of code-flow · refreshes every 15 s". After 20 s there were 0 main-frame navigations and the JS marker was still set, so the page never reloaded. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4627/ro-run-foot.png. Script and log: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4627/t21-10.mjs and t21-10.log in the same folder. No console errors or 5xx responses.

Attempts to refute:
- Not by design. docs/automations.md:90 says only that the view "refreshes itself"; nothing documents static run pages. No code comment explains it. The conditional refresh and the fixed footer have both been unchanged since the original M6 commit 45d491a.
- Not caused by the tester's environment: the footer is a server-rendered constant, so the browser profile, selectors and credentials make no difference.
- The existing test (test/automation.test.ts:557, "phone view: read-only HTML with everything escaped") does not check refresh or the footer.

Cleanup:
- Remote access turned off through the UI (api/remote enabled=false).
- Run deleted through the rail's Run actions -> Delete… menu. The delete dialog says by design that branches and worktrees are kept, so I removed my run's worktree, its branch codeflow/2610252246-826908aa/solo and its leftover .worktrees/2610252246-826908aa/.context folder from MQTT-MCP myself.
- Server v4627 stopped; nothing listens on 4627 or 4628. No leftovers.

</details>

### t21-6 · minor · Paired devices are labelled with the raw User-Agent, cut at 120 characters, so phones cannot be told apart

Source: tester unit infra-remote-devices-clients-1; observed with real-agents; features REM-11, REM-12.

**Repro**

> 1. Enable full control and pair two devices with ordinary mobile browsers (e.g. two iPhones).
> 2. Open Remote access, then 'Paired devices'.

**Expected:** Each device has a readable, distinguishable name (e.g. 'iPhone · Safari · paired 17:00') or can be renamed before you revoke it.

**Actual:** Each row shows the User-Agent string truncated at 120 characters, e.g. 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E1'. The distinguishing tail is cut off, so revoking the right device is guesswork.

**Root cause (verifier):** 1. `src/server.ts:1038`: on pairing, `phoneSessions.pair(String(req.headers["user-agent"] ?? "Phone"), remote.controlToken)` stores the raw User-Agent header as the device label.
2. `src/phone-sessions.ts:44`, in `pair()`: `label.replace(/[\x00-\x1f]/g, "").slice(0, 120) || "Phone"` strips control characters and cuts the label to 120 characters, so real mobile UAs (about 130–150 chars) lose their end. `src/phone-sessions.ts:25`, in `load()`, rejects stored labels over 120 characters, which locks that limit into the storage format.
3. `ui/phone-devices.tsx:18`: `<span class="pd-name">{device.label}</span>` renders the label as is.
4. `ui/phone-devices.tsx:19`: shows only `expires {toLocaleDateString()}`. There is no pairing time and `createdAt` is never displayed, so devices paired on the same day look identical.
5. `ui/phone-devices.tsx:20`: every row has the same "Revoke device" button text and no aria-label.
6. `src/server.ts:2171-2174`: the devices API supports only GET and DELETE, so a device can't be renamed.

Impact: with identical rows, the owner can't tell which row is a lost phone. That phone has full owner control. Picking the wrong row leaves it signed in. The workaround …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/phone-sessions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/phone-devices.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-sessions.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/automations.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`

**Suggested fix:** 1. Make a short, readable label at pairing time. Add a small pure function, e.g. `deviceLabel(userAgent)` in `src/phone-sessions.ts` or a new `src/device-label.ts`. It maps the UA to "<device> · <browser>", for example:
   - "iPhone · Safari", "iPhone · Chrome" (CriOS), "iPhone · Firefox" (FxiOS)
   - "iPad · Safari", including iPadOS UAs that claim to be a Mac
   - "Android · Chrome", "Mac · Safari", "Windows · Edge"
   - "Phone" as the fallback

   Call it in `src/server.ts:1038` in place of the raw header. Optionally store the cleaned raw UA (still capped) in a separate `userAgent` field for a details tooltip. Keep accepting existing version-1 records, and turn their old raw-UA labels into short ones when listing.
2. Make same-type devices distinguishable. Two same-model phones will still both be "iPhone · Safari":
   - In `ui/phone-devices.tsx`, show "paired <date time>" from `createdAt` (already in the API) next to the expiry.
   - Add a numeric suffix when labels clash ("iPhone · …

**Suggested regression test:** 1. `test/phone-sessions.test.ts`: add a unit test for `deviceLabel()`:
   - Fixed real UAs map to the expected labels. The iOS Safari, CriOS, Android Chrome and iPadOS-desktop UAs give "iPhone · Safari", "iPhone · Chrome", "Android · Chrome" and "iPad · Safari".
   - An empty or garbage UA gives "Phone".
   - No result is longer than about 40 characters or contains control characters.
2. Same file, a `pair()` + `rename()` test:
   - `rename()` saves the new name, survives a reload through a new  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: `qa-server.sh start v4617 4617 fake` with `CODEFLOW_LAN_ALLOW_LOCAL=1` and `CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL=1` exported. Both are the documented development and test overrides, also used by `test/security-review.test.ts`. The home had no `remote.json` or `phone-devices.json`.

Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617/t21-6.mjs (log in t21-6.log next to it).

Steps, all in the UI at http://127.0.0.1:4617/#/settings/connections/devices:
1. Turned on "Enable remote access", set Connection to "Wi-Fi · local network", and turned on "Full control from remote devices".
2. Opened the pairing link on 127.0.0.1:4618 from four separate fresh Chrome contexts, each with an ordinary mobile User-Agent:
   - two identical iPhone Safari iOS 18.0 UAs (135 chars)
   - one iPhone Chrome (CriOS) UA (142 chars)
   - one iOS 18.1 Safari UA with the tester's " QA-t21-phone" suffix (148 chars)
3. Each phone got 200 and a `codeflow_phone_4618` cookie.
4. Reloaded the owner page and opened "Paired devices".

Result: "Paired devices · 4". Every `.pd-name` is exactly 120 characters, the raw UA cut off, for example "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E1".
- Rows 1 and 2 are byte-identical in label and in "expires 11/24/2026", and both buttons say just "Revoke device", with no title or aria-label to tell them apart. Nothing visible distinguishes the two iPhones.
- The CriOS row ends in "...CriOS/130.0.6723.90 Mobi".
- The suffix selector `.pd-name:has-text("QA-t21-phone")` matched 0 rows.
- There are no rename controls (0 inputs, no "Rename" button).
- `/api/remote/devices` returns `createdAt`, but the UI never shows it.

Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4617/t21-6-devices-detail.png.

Attempts to refute:
- The docs (`docs/automations.md` "Full control from your phone", `docs/security.md:29`, `docs/api.md:62`) only promise that one phone can be revoked. Nothing says devices are labelled by UA or that the list is meant to be unreadable, so this is not by design.
- The tester's "QA-t21-phone" suffix is a test artifact; real phones don't add one, and for real iPhones the cut-off tail ("Mobile/15E148 Safari/604.1") is the same on every device. The real defect is bigger than …

</details>

### t22-6 · minor · Paired devices list never refreshes on its own, and device labels are raw User-Agent strings

Source: tester unit infra-remote-devices-clients-2; observed with fake-agents; features REM-17.

**Repro**

> 1. Open Settings → Connections → Connect my devices with full control on and expand 'Paired devices · 0'. 2. Pair a phone using the link. 3. Wait 12+ seconds without clicking Refresh.

**Expected:** The new device appears (the rest of the card polls every 10s), with a readable label such as 'iPhone · Safari'.

**Actual:** It stays 'Paired devices · 0' until 'Refresh devices' is clicked. Rows are labelled with the full UA string ('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) ...'), so devices are hard to tell apart.

**Root cause (verifier):** 1. The list loads only once. In ui/phone-devices.tsx:8-9, `load` calls GET /api/remote/devices, and `useEffect(() => { void load(); }, [])` runs only on mount, with no polling and no refresh trigger from the parent. The parent ui/remote-access.tsx:47 polls only GET /api/remote every 10s through `pollVisible`. ui/remote-access.tsx:104 remounts the list only when `key={`${info.transport}-${info.pairingUntil}`}` changes. Pairing does not change pairingUntil: src/server.ts:1036-1038 only calls phoneSessions.pair. So a newly paired phone stays invisible until "Refresh devices" is clicked or the page is reloaded.
2. Labels are raw User-Agent strings. src/server.ts:1038 passes `String(req.headers["user-agent"] ?? "Phone")` as the device label. src/phone-sessions.ts:47 stores it after stripping control characters and cutting it to 120 characters, which removes the browser name. ui/phone-devices.tsx:18 renders `device.label` as is; the row also shows the expiry date but not the pairing date (createdAt) or any other way to tell devices apart.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/phone-devices.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/remote-access.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/phone-sessions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-sessions.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/phone-security-http.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/tailscale.e2e.ts`

**Suggested fix:** Two separate fixes.

1. Make the list refresh on its own. In PhoneDevices, replace the one-time useEffect with `useEffect(() => pollVisible(load, 10_000), [])`, using the same ui/polling.ts helper as the rest of the card. Optionally, poll only while the details element is open, and stop it from showing a toast every 10s when requests keep failing. A cheaper alternative: add `devices: number` (or a devices generation counter) to the GET /api/remote response and include it in the PhoneDevices key, or pass it as a prop that triggers a reload. That reuses the card's existing 10-second poll.

2. Store a readable label. Add a small `describeUserAgent(ua)` helper next to phone-sessions.ts that returns names like "iPhone · Safari", "iPad · Safari", "Android · Chrome", "Mac · Firefox" or "Windows · Edge", and falls back to "Phone". Use it at src/server.ts:1038 (or inside PhoneSessions.pair) instead of the raw header. Apply the same mapping when listing, so devices stored under the old raw UA la …

**Suggested regression test:** 1. Unit test in test/phone-sessions.test.ts (or a new test/user-agent.test.ts): describeUserAgent("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1") === "iPhone · Safari"; an Android Chrome UA gives "Android · Chrome"; an empty or unknown UA gives "Phone".
2. HTTP test in test/phone-security-http.test.ts: pair with an iPhone User-Agent header, then assert that `(await local(secure, "/api/remote/devices")).bod …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server named v4685t226 on port 4685, with its remote listener on 4686. I exported three settings first: FAKE_TAILSCALE_STATUS pointing at a status JSON that uses this machine's own tailnet IP 100.73.173.37, so the listener bound to the tailnet only and never to the LAN; CODEFLOW_ALLOW_INSECURE_PHONE_CONTROL=1, so full control works without TLS; and CODEFLOW_LAN_ALLOW_LOCAL=1, so a phone browser on the same machine can pair. I drove everything from the UI with the Playwright script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4685t226/r1.mjs; its output is in r1.log in the same folder.

Steps on the owner page (#/settings/connections/devices):
1. Ticked "Enable remote access", chose "Tailscale · access anywhere" and ticked "Full control from remote devices".
2. Expanded "Paired devices · 0" and clicked "Copy link".

A separate headless Chrome context then acted as the phone. It used a real iPhone Safari User-Agent ("Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1"). It opened the link, got HTTP 200 and was redirected into the app.

Right after pairing, GET /api/remote/devices already returned one device. The owner's summary still read "Paired devices · 0" at every 3-second check from +3s to +27s. The page's network log shows why: during those 27 seconds the card polled GET /api/remote three times (its 10-second poll) but never requested /api/remote/devices. After clicking "Refresh devices" the summary changed to "Paired devices · 1".

The row label was the raw User-Agent cut off mid-token at 120 characters: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E1". The browser name ("Safari") was cut off. The row shows only that label and an expiry date, so two phones of the same model would look identical. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4685t226/003-after-refresh.png. There were no console or 5xx errors.

Checked against design intent: docs/automations.md ("Full control from your phone"), docs/security.md and docs/api.md say nothing about refreshing the list by hand or about how devices are named. The manual "Refresh devices" button is an implementation choice, not a documented contract, and it i …

</details>

### S14-5 · minor · The paired-devices list loads only on mount or when the remote-access key changes, and never polls. A phone that pairs while the page is open does not appear until 'Refresh devices' is pressed.

Source: code-level suspect at `ui/phone-devices.tsx:9` (confirmed hands-on).

**Repro**

> Started s14 (fake) with exported CODEFLOW_TLS_CERT/KEY (self-signed, in work/s14) and CODEFLOW_LAN_ALLOW_LOCAL=1. Browser script phone.mjs: #/settings/remote-access → click 'Enable remote access' → Connection 'Wi-Fi · local network' → click 'Full control from remote devices' (secure:true, control:true) → expand Paired devices: '· 0'. Paired a 'phone' with an HTTPS GET to 127.0.0.1:4558<phonePath> with UA 'QA Phone s14' → 200 + Set-Cookie; /api/remote/devices → ['QA Phone s14']. The UI summary stayed '· 0' at +5/+12/+25s (screenshot shots/s14/002-devices-after-25s-no-refresh.png). Clicking 'Refresh devices' showed '· 1' (003-devices-after-refresh.png). I then revoked the device in the UI and turned remote access off; port 4558 was confirmed not listening.

**Expected:** While the Remote access card is open with full control on, a newly paired device should appear within the card's normal polling interval (about 10s). This matters for noticing an unexpected device that has full owner control. Nothing in docs/security.md or docs/automations.md says the list is manual-only; the Refresh button is the only cue.

**Actual:** After a phone paired successfully (the server listed it at once in /api/remote/devices), the open Remote access card still showed 'Paired devices · 0 / No paired devices.' at t+5s, t+12s and t+25s, across at least two /api/remote polls. Only clicking 'Refresh devices' showed 'Paired devices · 1 — QA Phone s14'.

**Root cause (verifier):** PhoneDevices calls load() once in `useEffect(() => { void load(); }, [])`. RemoteAccess (ui/remote-access.tsx:104) remounts it only when its key `${info.transport}-${info.pairingUntil}` changes. Pairing a phone (server.ts:1036-1038, phoneSessions.pair) does not change pairingUntil or transport. So although RemoteAccess polls /api/remote every 10s, the devices list is never refetched.

**Suggested fix:** Have PhoneDevices poll /api/remote/devices with pollVisible(load, 10_000) while the <details> is open or while the pairing window (pairingUntil) is active. Alternatively, add a device count or revision to the /api/remote response and include it in the PhoneDevices key, or call load() from RemoteAccess's refresh.

**Suggested regression test:** UI/e2e test: start a server with CODEFLOW_LAN_ALLOW_LOCAL=1 and a test TLS cert, enable remote access with Wi-Fi and full control, and open 'Paired devices' (0). Pair through https://127.0.0.1:<remotePort><phonePath>, then expect a .pd-row to appear within about 12s without clicking Refresh.
