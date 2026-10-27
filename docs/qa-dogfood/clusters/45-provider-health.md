# Cluster 45 · provider-health

**Provider health dialog & model catalog: usage-limit display, refresh, stale catalogs, probes**

Status: **merged and independently verified** · 8 issues · branch `codex/qa-provider-health`

Planner notes: Health dialog (ui/app.tsx ~511-561): a usage-limited provider shows an empty '? used' bar instead of 'Hit a usage limit' (t04-5), because the limit the engine stores doesn't match what the render expects (src/doctor.ts, src/routing.ts). 'Check again' has no busy state and fires duplicate checks (t04-6). t04-7: 'Refresh providers' doesn't bypass the 10-minute agentCatalog cache (src/adapters/index.ts:39); add a force option. t04-19: a provider never discovered is labelled 'stale · 0 models' after a failed refresh (refresh in src/model-catalog.ts). t05-12: the compatibility probe leaves a temp directory behind (the processes.json path is fixed at import). t05-17: the 'Check this computer' heading is duplicated. t25-13: an agent stopped by a server shutdown is reported as '<agent> was cancelled', twice (describeFailure at src/adapters/process.ts:490). t21-3: a missing Docker image is reported as a generic 'capability probe failed' (src/adapters/managed-permissions.ts). fs-policy-gate owns the policy-blocked Health states.

Likely files: `ui/app.tsx`, `src/doctor.ts`, `src/routing.ts`, `src/adapters/index.ts`, `src/model-catalog.ts`, `src/adapters/process.ts`, `src/adapters/managed-permissions.ts`, `ui/dependency-health.tsx`, `ui/settings.tsx`, `src/server.ts`

## Fix and verification · 2026-10-26

| Original issue | Resolution and replay |
| --- | --- |
| t04-5 | Health uses Auto routing’s quota expiry rule, displays the usage limit and reported reset, and does not invent a percentage/bar. Actual fake-Claude usage rejection replayed in Chrome; screenshot inspected. |
| t04-6 | Health checks have an in-flight promise and disabled busy button/status; closing/reopening shares the request. A bundled real UI-state test proves an unrelated write cannot duplicate the pending health request. |
| t04-7 | Explicit provider refresh invalidates the ten-minute model cache before models/doctor discovery. Both refresh buttons and ACP refresh use the same operation. Warm-cache sign-out and sign-in recovery replayed. Independent review found and repaired an additional old inventory response race; generation guards cover inventory/model state and provider names. |
| t04-19 | Failed discovery remains unknown until there has been actual discovery evidence; a successful empty listing is still current, then stale on failure. API and visible worker-catalog refresh replays passed. |
| t05-12 | Import-only processes no longer rewrite the process registry on exit. Tracked processes still get killed and their registry cleared. The actual pinned Claude2.1.310 compatibility installer/probe passed; no cf-provider-contract-* directory remained under the dedicated TMPDIR after exit (tsx caches are separate). |
| t05-17 | Removed the nested dependency heading and obsolete hairline styling; both new and original Chrome cases verify the remaining summary/region. |
| t25-13 | Shutdown reason propagates through signals/process outcomes. Engine errors during preparation or execution and the run recovery message share explicit shutdown wording; user cancellation remains distinct. Graceful shutdown/restart and Resume replayed, including an active provider. Cluster44 supplies the duplicate transcript/recovery suppression; the integrated replay verified one visible explanation both before and after Resume. |
| t21-3 | Container probes preserve missing-image and unavailable-daemon recovery with errorKind other; bounded redacted diagnostics remain for other failures. Real Chrome composer sends a missing-image container run, with fake Docker proving --pull=never and no pull/fallback. |

Integrated validation:15 combined44/45 unit tests and18 Chrome scenarios passed with single-error assertions; Recheck sign-in now uses the shared fresh-discovery operation and shows its busy state. Typecheck passed. Logs: integrate45-typecheck.log, integrate45-tests.log, integrate44-45-e2e.log; screenshots integrate45-shots.

Validation: eight new unit/bundled-state cases;28 related unit/persistence/container cases before the final added race regression; eight new Chrome/server cases; three original dependency/Antigravity health Chrome cases; TypeScript and diff checks. Six targeted browser scenarios all failed against pre-fix9660b0a, confirming duplicate heading, warm-cache refresh, unknown catalog, hidden Docker reason, shutdown text and missing quota feedback. The active-provider fixture waits for the fake CLI invocation (its session event is emitted after its artificial sleep); an initial session-event wait was corrected as a harness error. The missing-image fixture was corrected to submit the container in loop.agentContainer and then replaced by the original composer UI sequence.

Evidence: /private/tmp/codeflow-qa-continue/health45-{tests-final,related-final,e2e-final,original,typecheck-final,baseline-e2e,compat}.log; health45-compat.json; health45-shots contains screenshots, server log and console log (no browser errors). Independent refresh-race probe: provider45-review/race.mjs. All server/model workflows used fake providers and isolated homes/repositories. The real Claude package probe was version/help only, with no credentials or model call. All owned fixture servers stopped. The historical isolation incident in finished.md remains an uncertainty; this repair does not retroactively establish whether that write occurred.

## Issues

### t04-5 · minor · Health shows a usage-limited provider as an empty quota bar '? used' instead of 'Hit a usage limit'

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-13.

**Repro**

> 1. Server whose claude CLI returns a rejected rate-limit (fake: FAKE_CLAUDE_FAIL=rejected FAKE_CLAUDE_RESETS_AT=<now+1h>).
> 2. Start an Agent run with Claude; it stops 'Stopped at the usage limit of Claude Code.'
> 3. App menu → Agents & usage.

**Expected:** Claude row says it hit its usage limit (and when it resets), e.g. the existing 'Hit a usage limit recently.' warning, not a 0% bar.

**Actual:** Badge 'Signed in · Claude subscription', row 'limit window [empty bar] ? used · resets Sun 05:12 PM'. Runs 2610251413-b28a3606 and 2610251434-e9eb73f0 (t04b); shots/t04b/001-health-slow.png.

**Root cause (verifier):** This is a mismatch between how the engine stores a limit and how the Health dialog decides what to render.

1) While the turn runs, the Claude adapter (src/adapters/claude.ts:232-248) parses rate_limit_event {status:"rejected", rateLimitType:"five_hour", utilization:1, resetsAt}. It emits a quota event, and engine.ts:2591 records status "rejected" with windows {five_hour:{utilization:1,resetsAt}}.

2) The step then fails with errorKind usage_limit and a resetsAt. engine.ts:2635 calls RunManager.recordLimit(agent, resetsAt). At src/engine.ts:4728 that does `recordQuota(agent, "limited", resetsAt ? { limit: { resetsAt } } : …)`, which replaces the reported windows with a synthetic "limit" window that has no utilization. Routing (src/routing.ts:28-31) only needs resetsAt, so this is correct for Auto. It is also asserted in test/engine-reliability.test.ts:297.

3) ui/app.tsx HealthDialog, lines 521-533, renders bars whenever `Object.keys(h.quota.windows).length` is non-zero. It ignores h.quota.status, so the synthetic window is drawn as width 0% (`(w.utilization ?? 0)`) with pct(undefined) = "?" used. The `h.quota?.status === "limited"` branch (app.tsx:535-536, "Hit a usage limit recen …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/doctor.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/routing.ts`

**Suggested fix:** Make the Health dialog show the limited status no matter which windows are stored.

(a) Server: in GET /api/doctor (src/server.ts:1943-1950), or in doctor()/check() (src/doctor.ts), attach the routing verdict to each entry, for example `availability: exhausted(entry.id, manager.quota)`. The UI then uses the same rule as Auto, including expiry once the reset time passes and the one-hour default.

(b) UI, ui/app.tsx HealthDialog: when status is "limited"/"rejected" and the limit is still live, render a warning before the window list. It should read "Hit its usage limit · resets <when(max resetsAt)>", or "Hit a usage limit recently." when no reset time is known. A badge like "Usage limit" would also stop the row looking healthy. Render windows that have no utilization as text only, such as "Resets Sun 08:23 PM", with no bar and no "? used". Alternatively, hide the synthetic "limit" window, since the warning already gives its reset time.

(c) Optional, engine.ts:4719-4728: when the CLI's o …

**Suggested regression test:** Add a test in test/health-routing.test.ts, or a small e2e in test/e2e/settings.e2e.ts / ux-flows.e2e.ts. Seed the quota with `manager.recordLimit("claude", Date.now()+3_600_000)`, or start the fake server with FAKE_CLAUDE_FAIL=rejected and FAKE_CLAUDE_RESETS_AT=now+1h and run one Claude step. Then open Application menu → "Agents & usage" and assert three things:
- The Claude row contains /usage limit/i and the reset time.
- It does not contain "? used".
- `.health-row .bar > span` has no width-0 …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server named v4675 on port 4675, with a new home. Before starting it I exported FAKE_CLAUDE_FAIL=rejected and FAKE_CLAUDE_RESETS_AT=now+3600s (1792956231), and confirmed both variables were in the server process environment with `ps eww`. I made a scratch bare clone of MQTT-MCP plus a working clone, and added the working clone as project "v4675-mqtt" through "Open another repository", using a fresh browser profile "v4675".

Baseline: Application menu → "Agents & usage" showed "Claude Code | Signed in · Claude subscription | Quota shows after the next Claude step."

I typed "Usage limit test: create limit.txt" in the new-run composer with Claude Code as the provider and pressed Send. Run 2610251825-b615b981 ended with status "stopped" and the stop reason "Stopped at the usage limit of Claude Code."

GET /api/doctor then returned claude.quota = {"status":"limited","windows":{"limit":{"resetsAt":1792956231000}}}.

When I reopened Application menu → "Agents & usage", the Claude row still had the green badge "Signed in · Claude subscription". Below it was "limit window", an empty 0% bar and "? used · resets Sun 08:23 PM". Nothing said Claude is out of usage, and the "Hit a usage limit recently." warning never appeared. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4675/003-health-after.png. There were no console or 5xx errors.

The result does not depend on the tester's setup: I used a different port, a new home and a new profile and got the same output. The engine path is shared by every case where an adapter returns resetsAt. That includes the real Claude rejected rate_limit_event, and Codex/agy, whose resetFromText parses phrases like "try again at 5pm".

Why I don't think it is by design: docs/configuration.md:87 says Claude's 5-hour and 7-day windows are "shown from its own reports". Here, a window Claude did report (five_hour, utilization 1) is replaced by an invented "limit" window. Also, the UI has a dedicated "Hit a usage limit recently." branch, which shows the intent to warn.

Cleanup: I deleted the run through the UI (Select runs → Select loaded → Delete…), stopped server v4675 (ports 4675–4677 are free) and removed both scratch clones. A side observation, not part of this issue: bulk Delete removed the run record but left .worktrees/2610251825-b615b981/solo and branch codeflow/2610251825-b615b981/solo in the scratch clone. They w …

</details>

### t04-6 · minor · Health 'Check again' gives no busy feedback and fires duplicate checks on repeated clicks

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-13.

**Repro**

> 1. Make CLI probes slow (t04 wrapper env added `sleep 2`).
> 2. Open Agents & usage, click 'Check again', then click it twice more.

**Expected:** Button disables / shows 'Checking…' while a check is in flight; repeated clicks don't stack requests.

**Actual:** For ~6 s the button stays enabled with unchanged text, old results stay displayed, no indicator; three clicks sent three /api/doctor requests.

**Root cause (verifier):** ui/app.tsx:561 renders `<button class="btn" onClick={() => loadHealth()}>Check again</button>` with no busy state, so there is no disabled state, no label change and no aria-busy.
ui/app.tsx:511 shows "Checking…" only when `!health.value`, so after the boot check (main.tsx:113) every re-check, including the dialog-open one at app.tsx:499, runs invisibly with stale rows on screen.
ui/state.ts:696-700 `loadHealth()` exposes no in-flight signal (no `healthChecking`), so the dialog can't tell a check is running.

The reporter's "no in-flight guard / duplicate requests" claim is mostly wrong. loadHealth uses `sharedGet` (ui/lib.ts:53, 60), which returns the pending promise for an identical in-flight GET, and test/repo-selection-ui.test.ts:181 covers this deliberately. The only gap is ui/lib.ts:58, which clears the shared map on any non-GET, so a check started after a write runs alongside the older one. loadHealth then assigns whichever settles last, so an older response could in theory overwrite a newer one.

This is not by design. Sibling controls follow the busy pattern: settings.tsx:118 "Refresh providers" uses disabled + "Checking…", and dependency-health.tsx:17 uses "Checking depen …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`

**Suggested fix:** In ui/state.ts:
- Add `export const healthChecking = signal(false)`.
- Make loadHealth single-flight: keep a module-level `let inFlight: Promise<void> | null`. If it is set, return it. Otherwise set healthChecking=true, run the two sharedGets, assign results, and in `finally` clear inFlight and set healthChecking=false.
- Alternatively use a sequence number so only the latest call assigns results, which also closes the out-of-order overwrite after lib.ts:58 clears the shared map.

In HealthDialog (ui/app.tsx:559-563):
- Render `<button class="btn" disabled={healthChecking.value} aria-busy={healthChecking.value} onClick={() => void loadHealth()}>{healthChecking.value ? "Checking…" : "Check again"}</button>`.
- Set aria-busy on the dialog body and show a short "Checking…" status line (role="status") above the existing rows while a check runs. Keep the old rows visible, perhaps dimmed, rather than blanking them.
- This also covers the silent dialog-open check at app.tsx:499.

Settings "Re …

**Suggested regression test:** Unit test, test/repo-selection-ui.test.ts or a new test/health-ui.test.ts, with the existing fake fetch harness:
- Call state.loadHealth() twice and assert one /api/doctor request and that state.healthChecking.value === true.
- Settle the requests and assert healthChecking.value === false.
- Add a post() between the two calls and assert loadHealth still issues no second /api/doctor, or that only the newest result is assigned.

e2e, test/e2e/settings.e2e.ts:
- Delay the response with `page.route( …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4677 on 127.0.0.1:4677 (fresh home, no runs). To slow the CLI probes I put a `node` shim first on PATH at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4677/bin/node. It sleeps 2 s before any test/fake-agent.mjs call and logs each call to probes.log. Result: curl /api/doctor took 6 s, matching the reporter's timing.

Browser script /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4677/health.mjs (fresh profile, output in health.log) opens Application menu > "Agents & usage" and waits for the initial check. It counts /api/doctor and /api/doctor/git separately by exact pathname.

CONFIRMED (no busy feedback):
- 150 ms and 1.8 s after clicking "Check again", the button is still {disabled:false, text:"Check again", aria-busy:null}.
- The dialog shows no "Checking…" and keeps the old results for the whole 5.3 s check.
- Screenshot shots/v4677/002-in-flight.png shows an unchanged dialog mid-check.
- The opening check (app.tsx:499) is just as silent whenever earlier results exist.

NOT REPRODUCED (duplicate checks):
- Scenario A, the reporter's sequence (click, 150 ms, then two more clicks): 0 new /api/doctor requests, because the clicks joined the in-flight request, plus 3 /api/doctor/git requests. The reporter's counter, `r.url().includes("/api/doctor")` in work/t04/b10-health.mjs, also matches /api/doctor/git. That gives exactly the "3 requests" they reported.
- Scenario B (three clicks 2 s apart during one 6 s check): 1 /api/doctor and 3 /api/doctor/git. probes.log shows the server ran doctor() once (one `--version` per CLI) for those three clicks.
- /api/doctor/git only runs `git --version` (about 10 ms), so it stacks nothing costly.

Caveat: a fetch trace (trace.mjs) showed the boot check and the dialog-open check as two concurrent /api/doctor requests, the second taking 10.5 s. This happens because any non-GET request clears the shared-GET map (lib.ts:58). Real duplicates can therefore happen only if a write lands mid-check, not from repeated clicks alone.

Cleanup: no runs were created (GET /api/runs returned []). Server v4677 stopped; ports 4677 and 4678 are free. Port 4679 is held by another agent's server (home homes/v4679), which I did not touch.

</details>

### t04-7 · minor · 'Refresh providers' does not re-list models (10-minute catalog cache), so an Antigravity sign-out or new models are not detected

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-14, SOL-09.

**Repro**

> 1. With agy installed and signed in, open #/settings/agents (catalog cached).
> 2. Sign agy out (fake: export FAKE_AGY_MODELS_FAIL=signed-out in the CLI environment).
> 3. Click 'Refresh providers' (and open Health).

**Expected:** Refresh re-runs discovery so the card shows 'Signed out' and the fix text.

**Actual:** Card and Health still show 'Antigravity CLI · Signed in' with the old model list; only `agy --version/--help` ran during refresh (no `agy models`). Doctor's agy sign-in check uses the same cached catalog.

**Root cause (verifier):** src/adapters/index.ts:39-49: agentCatalog(id) returns any cached catalog younger than CATALOG_TTL_MS (10 minutes). It takes no force/maxAge option and the module exports no way to invalidate the cache; only replaceAcpAdapters clears acp:* entries and a failed fetch deletes its own entry.

ui/settings.tsx:118: "Refresh providers" only re-requests GET /api/agents, /api/models and /api/doctor. ui/app.tsx:561: Health "Check again" only calls loadHealth() (ui/state.ts:696-700). Both endpoints read the same cache: src/server.ts:2400-2409 (/api/models -> agentCatalog) and src/doctor.ts:191-196, where agy sign-in is inferred from `await agentCatalog("agy")` succeeding. Claude and Codex sign-in, by contrast, run `claude auth status` / `codex login status` fresh on every call.

The cache itself is deliberate and documented: docs/getting-started.md:142 says "Model lists are cached for 10 minutes", and test/health-routing.test.ts:44 says "Failures first: a successful model listing is cached for 10 minutes". But no doc says the explicit Refresh / Check again buttons keep using it, and both labels promise a re-check, so this is a gap rather than intended behaviour.

Not reproduced, from reading  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/index.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/doctor.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/app.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/getting-started.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/health-routing.test.ts`

**Suggested fix:** 1. In src/adapters/index.ts, add an explicit refresh: either export invalidateAgentCatalogs(ids?) or give agentCatalog an option `{ force?: true }`. Force should start a new listing unless one started after the force request is already in flight, so parallel callers still share a single `agy models`.

2. Add one server entry point for "re-check providers", e.g. POST /api/agents/refresh, or `?refresh=1` on GET /api/agents. It clears the catalog cache before returning availability. The UI already awaits loadAgents() before running loadModels() and loadHealth() in parallel, so the /api/models and /api/doctor calls that follow will share one fresh discovery promise.

3. In the UI, have "Refresh providers" (ui/settings.tsx:118), the Health dialog "Check again" (ui/app.tsx:561) and the ACP refresh helper (ui/acp-connections.tsx:18) use that refresh call. The background loads in main.tsx and app.tsx keep using the cache.

4. Optionally keep a successful catalog from being wiped by a forced re …

**Suggested regression test:** test/health-routing.test.ts: add a test that first calls doctor({}) healthy, so `agy models` succeeds and is cached. Then, with withEnv({FAKE_AGY_MODELS_FAIL: "signed-out"}), call the new refresh path (invalidateAgentCatalogs() or agentCatalog("agy", {force: true})) and then doctor({}). Assert that agy.signedIn === false and fix matches /sign in with your Google account/. Also assert that without the refresh the cached result is still signedIn === true, which pins the documented 10-minute cache. …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4679" on 127.0.0.1:4679 (home .../scratchpad/qa/homes/v4679). All CLIs were fakes from dogfood-qa/test/fake-bin. In front of them on PATH sat a wrapper, .../scratchpad/qa/work/v4679/bin/agy. It logs every agy call to agy-calls.log and reads a toggle file (agy-mode) to switch the fake into "signed-out" (FAKE_AGY_MODELS_FAIL=signed-out) or "newmodels" (adds model-three-new) without restarting the server. A restart would clear the in-memory cache, so it can't be used to sign out. The UI was driven with Playwright scripts repro.mjs, repro2.mjs and repro3.mjs in the same folder.

1) 19:27:36: opened #/settings/agents. `agy models` ran once and the Antigravity card showed "Signed in 1.3.6".
2) Switched to signed-out and clicked "Refresh providers" (finished in 713 ms). The card still said "Signed in" with no fix text. During the refresh agy ran only `--version` and `--help`, never `models`. Health & usage showed "Antigravity CLI · Signed in · Google account" (screenshot shots/v4679/003-health-dialog-signed-out.png). GET /api/doctor returned agy signedIn:true, account "Google account". GET /api/models still returned [model-one, model-two]. A full page reload changed nothing.
3) Health dialog "Check again" while signed out: still "Signed in · Google account"; again only `--version`/`--help`.
4) Switched to newmodels and clicked Refresh providers. /api/models and the Antigravity model picker still listed only Model One and Model Two (shots/v4679/002-picker-after-newmodels-refresh.png).
5) Control: after the cache entry expired (19:38), the first page load ran `agy models` and model-three-new appeared. With signed-out set before loading at 19:48:10, after the second expiry, the card showed "Signed out" with fix text "Run `agy` in a terminal once and sign in with your Google account". So the 10-minute cache is the only thing hiding the change, and neither button bypasses it.

Reproduced in the browser with zero console or 5xx errors. Ruled out as tester artifacts: the selectors (direct API reads agree with the UI), the browser profile (a fresh profile was used) and credentials (fake CLIs only).

</details>

### t04-19 · cosmetic · Model catalog labels a never-discovered provider 'stale · 0 models' after a failed refresh

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-10.

**Repro**

> Advanced → Team — dynamic plan with an agy that can't be discovered (isolation unsupported) → summary 'agy · unknown · 0 models' → Refresh model catalog.

**Expected:** Remains 'unknown' (nothing was ever discovered).

**Actual:** Becomes 'agy · stale · 0 models'.

**Root cause (verifier):** src/model-catalog.ts, ModelCatalogStore.refresh:
- Line 257 (discovery-failure catch) builds `prior ? { ...prior, attemptedAt: now, state: "stale", issue: "discovery-unavailable" } : {... state: "unknown" ...}`. It keys on whether a prior record exists, not on whether anything was ever discovered. The first failed GET persists a placeholder record (discoveredAt 0, models [], revision 0, state unknown). From then on every failed refresh sees a `prior` and relabels the placeholder "stale". That covers a forced POST /api/model-catalog from the "Refresh model catalog" button and any GET after the 10-minute TTL.
- Line 251 (offline branch) has the same flaw: `prior ? { ...prior, state: "stale", issue: "offline" } : ...unknown`. It is reached for unavailable providers (server.ts:2397 passes `offline: !a.available || body.offline`) and under CODEFLOW_MODEL_NETWORK=offline.
- Line 249 (cache hit) correctly uses `!prior.discoveredAt ? "unknown" : ...`, so the same record reads "unknown" on a cached GET and "stale" after a refresh.

The UI shows the value verbatim at ui/model-catalog.tsx:49 (`{p.provider} · {p.catalog.state} · {p.catalog.models.length} models`). The value also reaches the co …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/model-catalog.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/model-catalog.test.ts`

**Suggested fix:** In ModelCatalogStore.refresh (src/model-catalog.ts), base the failure state on whether anything was ever discovered, not on whether a record exists:
- Line 257: `state: prior?.discoveredAt ? "stale" : "unknown"`.
- Line 251: `state: prior?.discoveredAt ? "stale" : "unknown"`.

Optionally, factor out a small helper shared with line 249, such as `const evidenceState = (c, now) => !c.discoveredAt ? "unknown" : now - c.discoveredAt < TTL ? "current" : "stale"`, and force "stale" over "current" on failure/offline paths only when discoveredAt > 0. That way all three branches agree. Keep the issue field ("discovery-unavailable" / "offline") so the details still explain why. No UI change is needed.

**Suggested regression test:** Add a case to test/model-catalog.test.ts, modelled on the scratch test at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4607/test/model-catalog-never-discovered.test.ts. Build `new ModelCatalogStore(home, async () => { throw Error('x') }, () => now)` and assert that `get('agy')` returns state 'unknown'. Then assert 'unknown' with discoveredAt 0 for each of: `get('agy', { force: true })`, `get('agy', { offline: true }) …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4607 on 127.0.0.1:4607. The previous v4607 home was moved aside first, so there was no model-catalogs dir. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4607/t04-19.mjs (log t04-19.log in the same directory).

Steps through the UI: opened Run options, then Advanced, and picked "Team — dynamic plan" in #workflow-select.
- Initial GET summaries: "claude · current · 4 models", "codex · current · 2 models", "agy · unknown · 0 models".
- On-disk agy record after that GET: state=unknown, discoveredAt=0, revision=0, issue=discovery-unavailable.
- Clicked "Refresh model catalog": the summary became "agy · stale · 0 models", and the disk record became state=stale with discoveredAt still 0 and revision still 0. A second refresh gave the same result.
- The expanded agy details show "Unsupported for managed workers: Isolated Antigravity requires macOS, CLI 1.4.4…1.4.7 …" and "discovery-unavailable".
- Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4607/001-catalog-initial.png (unknown) and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4607/002-catalog-after-refresh.png (stale).

The label also flips back and forth. Reloading the page (t04-19-reload.mjs, a cached GET within the 10-minute TTL) shows "agy · unknown · 0 models" again for the same persisted record that was marked stale.

Unit level, in my snapshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4607/test/model-catalog-never-discovered.test.ts uses a ModelCatalogStore whose discover always throws. The first get gives unknown and a cached get gives unknown. After that, three paths each return 'stale' with discoveredAt=0: a forced refresh, an offline read, and an unforced get after the TTL expired. The test fails ('stale' !== 'unknown').

Why it is not by design or environmental: docs/auto-team.md:129 promises distinct "stale/unknown states", and docs/auto-team.md:131 says failed refreshes "retain previous evidence". Here there is no previous evidence. The cache-hit branch at src/model-catalog.ts:249 already maps discoveredAt 0 to "unknown", so the failure branches simply disagree with the store's own rule. The agy failure under fake-agents only supplies the …

</details>

### t05-12 · minor · Provider compatibility probe leaves a temp directory behind after every successful install

Source: tester unit solo-runs-providers-2; observed with api; features SOLO-GAP-04.

**Repro**

> 1. In a copy of the repo run `node --import tsx scripts/check-provider-compatibility.ts codex 0.162.1 /tmp/out.json`. Also try claude 2.1.302.
> 2. Afterwards `ls -d $TMPDIR/cf-provider-contract-*`: one directory per probe remains, containing state/processes.json ({"server":<pid>,"boot":…,"groups":[]}).

**Expected:** The script's `finally { rm(directory) }` leaves nothing behind.

**Actual:** 4 of 5 probes left a directory: every one that installed a binary. The failed npm install (codex 0.0.1) did not.

**Root cause (verifier):** The reporter's suspected cause (an async write landing after the rm) is not quite right. src/adapters/process.ts:75 fixes GROUPS_FILE = join(CODEFLOW_HOME, "processes.json") at import time. The script sets CODEFLOW_HOME=<directory>/state at scripts/check-provider-compatibility.ts:56, before it imports doctor.js at :57. Through adapters/index.js, that import loads process.ts, which registers `process.once("exit", ...)` at src/adapters/process.ts:77-83. That hook always calls persistGroups(), even though no group was ever tracked (probeProviderContract and its helpers in src/doctor.ts use plain spawn/execFile, never trackGroup). persistGroups at src/adapters/process.ts:90-96 runs mkdirSync(CODEFLOW_HOME, { recursive: true }) and then writes processes.json synchronously.

The script's `finally { await rm(directory, ...) }` is at scripts/check-provider-compatibility.ts:67 (the report says :66). It runs at the end of top-level await, before the 'exit' event, so the exit hook recreates <directory>/state/processes.json afterwards. When npm install fails, doctor.js is never imported (only privacy.js, which does not load process.ts), so no hook exists and nothing is left behind.

Side effec …

**Files:** `src/adapters/process.ts`, `scripts/check-provider-compatibility.ts`, `test/foundation.test.ts`

**Suggested fix:** Main fix, in src/adapters/process.ts: have the exit hook persist only when it actually changes something on disk. For example: `const pending = liveGroups.size + dyingGroups.size > 0; ...kill/clear...; if (pending) persistGroups();`. trackGroup, untrackGroup and killGroup's timer already persist after each change, so when both maps are empty the file on disk is already correct. This stops a process that never spawned a tracked group, like the probe, from creating or overwriting CODEFLOW_HOME/processes.json.

Optional belt-and-braces in scripts/check-provider-compatibility.ts: after the dynamic import at line 57, register `process.once("exit", () => rmSync(directory, { recursive: true, force: true }))`. Exit listeners run in registration order, so it runs after process.ts's hook and removes anything recreated at exit.

**Suggested regression test:** Add a test in test/foundation.test.ts next to "a process group a crashed code-flow left behind is killed at the next start". It spawns a child `node --import tsx -e` with CODEFLOW_HOME=<mkdtemp>/state. The child imports src/adapters/process.ts (or src/doctor.ts), runs rmSync(<mkdtemp>, {recursive:true}) and exits normally. After the child exits, assert.equal(existsSync(<mkdtemp>), false).

Add a companion case that keeps the current behaviour: the child calls trackGroup on a detached `sleep` and …

<details><summary>Verifier's independent reproduction</summary>

I worked in a snapshot copy (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/builds/v4623). Each run had its own empty TMPDIR so other testers' directories could not get mixed in. I did not start any QA server; this is a CLI script.

1) Real success probe: `TMPDIR=<work>/tmp-real node --import tsx scripts/check-provider-compatibility.ts codex 0.162.1 <work>/compat-codex-0.162.1.json` exited 0. The report says installed:true, version "codex-cli 0.162.1", compatible:true. Afterwards <work>/tmp-real/cf-provider-contract-Gi9rUn/state/processes.json was still there, containing {"server":37658,"boot":1792927484604,"groups":[]}. The npm install and the isolated home inside it had been removed; only state/processes.json came back.

2) Real failed probe: `TMPDIR=<work>/tmp-fail ... codex 0.0.1` exited 1 with the npm install error in the report. No cf-provider-contract-* directory remained, which matches the reporter's 4 of 5.

3) Minimal offline check of the mechanism: a script mkdtemp's cf-provider-contract-*, sets CODEFLOW_HOME=<dir>/state, imports ../src/doctor.js, then runs `finally { rm(dir) }`. It printed "after finally rm, exists: false". After the process exited, <dir>/state/processes.json existed with groups:[]. So the directory really is deleted and then recreated by a synchronous exit hook. It is not an async write racing the rm.

Not by design: docs/provider-compatibility.md says probes run in isolated directories and documents running the probe locally. No doc or comment accepts a leftover. Not environmental: the leftover is created by CodeFlow's own exit hook, not by the tester's script or setup. Reports kept in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4623/compat-codex-0.162.1.json and compat-codex-0.0.1.json. Temp directories were removed and no server was left running.

</details>

### t05-17 · cosmetic · 'Check this computer' heading is duplicated (summary plus h3)

Source: tester unit solo-runs-providers-2; observed with real-agents; features SOL-15.

**Repro**

> 1. Settings → Agents & models → expand 'Check this computer'.
> 2. The same title appears again as an h3 directly underneath.

**Expected:** A single heading.

**Actual:** Duplicate heading. Playwright getByText resolves to 2 elements.

**Root cause (verifier):** The same title is rendered twice, once by each of two nested components:
- ui/settings.tsx:116: AgentSettings wraps the component as `<details class="settings"><summary>Check this computer</summary><div class="settings-body"><DependencyDiscovery /></div></details>`.
- ui/dependency-health.tsx:16: DependencyDiscovery renders its own `<h3>Check this computer</h3>` as the first child of its `<section aria-label="Guided dependency discovery">`.

History: commit ceca9d2 added DependencyDiscovery at the bottom of FirstRunGuide in ui/onboarding.tsx. There the outer summary was "Getting started", so the h3 and its hairline separator made sense; the CSS comment at ui/styles.css:2133 still says 'Getting started: numbered steps, then "Check this computer" under a hairline'. PR #30 (636d2a3) moved the component out of onboarding into Settings and put a summary with the same text around it. The component's own h3 was left in, and so were its divider styles (ui/styles.css:2134, `padding-top:16px; border-top:1px solid var(--border)`) and h3 styles (ui/styles.css:2135). The result is a duplicate heading plus a stray hairline under the summary. Settings at ui/settings.tsx:116 is the only consumer.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/dependency-health.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/styles.css`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/history-launch.e2e.ts`

**Suggested fix:** 1. Keep the <summary> in ui/settings.tsx:116 as the single title, since it is the disclosure control.
2. Remove `<h3>Check this computer</h3>` from ui/dependency-health.tsx:16 and keep the help paragraph and button.
3. Keep the section's aria-label "Guided dependency discovery" so the region role and the existing e2e locator still work. Optionally rename it to "Check this computer" to match the visible label.
4. In ui/styles.css, delete the onboarding-era styles:
   - At :2134, drop `padding-top:16px; border-top:1px solid var(--border)` from `.dependency-discovery`. `.settings-body` already supplies the spacing.
   - Delete the `.dependency-discovery h3` rule at :2135.
   - Update the stale comment at :2133.
5. Optional cleanup in test/e2e/history-launch.e2e.ts:242: once the text is unique, the `.first()` can go.

Another option is to move the <details>/<summary> into DependencyDiscovery and drop the wrapper in settings.tsx. That works too, but removing the h3 is the smallest change.

**Suggested regression test:** In test/e2e/history-launch.e2e.ts, in the "guided onboarding inspects required and optional dependencies..." test:
- Replace `page.getByText("Check this computer", { exact: true }).first().click()` with `page.locator("details.settings > summary", { hasText: "Check this computer" }).click()`.
- After expanding, assert `await page.getByText("Check this computer", { exact: true }).count() === 1`.
- Assert `await panel.getByRole("heading", { name: "Check this computer" }).count() === 0`, so the pane …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server ("qa-server.sh start v4633 4633 fake") with a fresh home that had no runs. I used a fresh headless browser with no profile, so no stale cookies, localStorage or drafts were involved. The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4633/t05-17.mjs and its log is t05-17.log in the same folder. It opened http://127.0.0.1:4633/#/settings/agents and clicked the summary "Check this computer".

Results:
- Collapsed: getByText("Check this computer", {exact:true}) found 2 elements, 1 of them visible. The h3 is in the DOM but hidden inside the closed <details>.
- Expanded: it found 2 elements, both visible: SUMMARY at y=451 and H3 at y=530, about 80px apart inside the same <details>.
- DOM outline of the details: SUMMARY "Check this computer" > SECTION[aria-label="Guided dependency discovery"] > H3 "Check this computer".
- The element screenshot (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4633/t05-17-details.png) shows the title twice, one under the other. It also shows an extra hairline between them, which is the section's border-top.
- No console errors and no 5xx responses.

The tester's environment and script are not the cause: a fresh server and fresh profile give the same result, and the cause is in the static markup. It is also not by design. No doc mentions this layout, and git history shows the duplicate came from moving the component (see rootCause). The existing e2e test history-launch.e2e.ts:242 uses getByText("Check this computer").first(), which works around the duplicate. Cleanup: I stopped server v4633, created no runs and made no clones, so nothing is left behind.

</details>

### t25-13 · minor · Agent stopped by a server shutdown is reported as '<agent> was cancelled', twice

Source: tester unit usability-failure-cases-1; observed with real-agents; features UX-13.

**Repro**

> 1. Start a run (real codex on a scratch clone, or a fake agent with FAKE_SLEEP_MS=25000).
> 2. While the agent is working, run qa-server.sh stop <name>, then start it again.
> 3. Open the run.

**Expected:** The message says the agent was stopped because code-flow shut down (matching the 'Interrupted' badge), not that it was cancelled.

**Actual:** Real codex run 2610251738-97bca5c4 shows 'codex was cancelled' in a red box, and it stays in the transcript after Resume completes. With fake claude, 'claude was cancelled' appears twice (in the step details and in the transcript), followed by 'code-flow was shut down while this run was in progress'. The user never cancelled anything.

**Root cause (verifier):** Three cooperating spots produce the message, and a fourth shows it twice.

1. `src/adapters/process.ts:490`: `describeFailure()` returns `${name} was cancelled` for any aborted process. Adapters only see that the signal was aborted, not why. The manager's shutdown abort at `src/engine.ts:5662` (`for (const controller of this.controllers.values()) controller.abort();`) passes no reason, so a shutdown is indistinguishable from a user cancel.

2. The adapters both emit and return that text:
   - `src/adapters/claude.ts:300` builds it and `:307` emits `onEvent({ kind: "error", message: error })`; the event goes into the run log and transcript.
   - `src/adapters/codex.ts:241` and `:249` do the same.
   - `src/adapters/agy.ts:282` does the same.
   - The adapter returns the same text as `result.error`.

3. `src/engine.ts:2645-2646` sets `step.error = result.error` without changing it. It does set `step.status = this.signal.aborted ? this.abortedStatus() : ...`, and `abortedStatus()` at `engine.ts:2170-2171` correctly returns "interrupted" while `manager.isShuttingDown`. So the status says Interrupted but the error still says cancelled. Line 2647 already rewrites `step.error` for one oth …

**Files:** `src/engine.ts`, `src/adapters/process.ts`, `src/adapters/claude.ts`, `src/adapters/codex.ts`, `src/adapters/agy.ts`, `ui/run.tsx`, `test/persistence.test.ts`

**Suggested fix:** 1. Make the step message match the step status in the engine. In `runStep`, right after `step.status` is computed (`src/engine.ts:2646`), when `this.signal.aborted && this.controller.signal.aborted`, replace `step.error` according to the status:
   - "interrupted": "Interrupted: code-flow shut down while this turn was running. Resume to continue."
   - "stopped": `Stopped at the ${run.stopReason}`
   - "cancelled": keep "<agent> was cancelled"

   Put this in a shared helper so `failStep` and the check step at `engine.ts:2156` say the same thing.

2. Fix the transcript event at its source. Abort with a reason: in `RunManager.shutdown()` call `controller.abort(new ShutdownAbort())`, or abort with a "shutdown" string. Then either:
   - let `describeFailure` and `processErrorKind` read `signal.reason` (pass it through `ProcessOutcome`, e.g. `outcome.abortReason`) and produce "<agent> was stopped because code-flow shut down"; or
   - have the engine's `onEvent` wrapper rewrite or drop an a …

**Suggested regression test:** Extend the existing test in `test/persistence.test.ts` named "shutdown interrupts a run; a new process resumes it without redoing finished steps". It already sets `FAKE_SLEEP_VENDOR=codex` and `FAKE_SLEEP_MS=5000`, waits for "Implement plan" to run, and calls `a.shutdown()`. After `a.shutdown()`, add:

```ts
const step = run.steps.find(s => s.title === "Implement plan")!;
assert.equal(step.status, "interrupted");
assert.doesNotMatch(step.error ?? "", /was cancelled/);
assert.match(step.error ??  …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode QA server: `FAKE_SLEEP_MS=25000 qa-server.sh start v4691sd 4691 fake`, with a new home and the source at f14f404. I made a scratch clone of MQTT-MCP at `/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4691sd-mqtt` and opened it through the UI ("Open another repository", then "Open this repository", then "Create project"). I typed a task and pressed Send, which started run 2610252312-c95f7b57. The API showed step "Your task" (claude) as running.

1. While the agent was still working I ran `qa-server.sh stop v4691sd`. The server log printed "Stopping code-flow (SIGTERM): interrupting running runs so they can be resumed…". The run log `runs/2610252312-c95f7b57.jsonl` then contained:
   - an agent event `{"kind":"error","message":"claude was cancelled"}`
   - a step with status "interrupted" and error "claude was cancelled"
   - run.error "code-flow was shut down while this run was in progress. Resume to continue."
2. I restarted the server and opened `#/run/2610252312-c95f7b57` in headless Chrome. Screenshot `/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4691sd/001-after-restart.png` shows:
   - an "Interrupted" pill on the run and an "Interrupted" badge on the step
   - two red boxes reading "claude was cancelled": one inside the work transcript, one below it
   - then "code-flow was shut down while this run was in progress. Resume to continue." and a Resume button
   - `main.innerText` contains "claude was cancelled" exactly 2 times.
3. I clicked Resume and the run finished with status done. Screenshot `/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4691sd/001-after-resume.png` shows the run marked Finished. The first turn still carries its "Interrupted" badge and both red "claude was cancelled" boxes, and the shutdown explanation is gone because the recovery box only shows for unfinished runs. So after a resume the history says only "cancelled", which the user never did.

No console errors or 5xx responses. The behaviour matches the report in both the fake case and the reported real-codex case: codex goes through the same `describeFailure` path at `codex.ts:241`. I did not spend a real-agent run.

Checks that it is not by design:
- `docs/runs.md:112` and `docs/runs.md:123` say a clean shutdown "stops run …

</details>

### t21-3 · minor · A missing Docker image fails with a generic 'Container CLI capability probe failed' instead of saying the image is missing

Source: tester unit infra-remote-devices-clients-1; observed with fake-agents; features REM-10.

**Repro**

> 1. Start Docker. In the composer, enable Agent isolation with image 'qa-missing-image-real:none' (not present locally) and explicitly choose Approve for me.
> 2. Send.

**Expected:** The run fails quickly without pulling, and the error says the image is not available locally and must be built or loaded first, as docs/agent-containers.md describes.

**Actual:** The step and run fail with 'Could not verify claude permission controls: Container CLI capability probe failed' (errorKind cli_incompatible). Docker's 'Unable to find image ... locally / No such image' is discarded. Resume fails the same way. No pull or host fallback happens, which is correct.

**Root cause (verifier):** src/adapters/managed-permissions.ts:14-19: in container mode the probe runs `runJsonlProcess({ command: provider, ..., agentContainer: { config, mode: "read" } })`. That call returns an outcome with `stderr`, and src/adapters/process.ts:341-356 collects it. Line 18 then throws a fixed message:

`if (result.exitCode !== 0 || result.aborted || result.timedOut || text.length > 128000) throw new Error("Container CLI capability probe failed");`

The `result.stderr` holding Docker's "No such image: X" is never read. The catch at line 34 wraps the error as `Could not verify ${provider} permission controls: ...` with `errorKind: "cli_incompatible"` (via `fail`, line 8). That kind is wrong for this case: per src/adapters/types.ts:108 it means "the installed CLI rejected a flag".

The kind also changes behaviour:
- src/engine.ts:3046 (`recoverableProviderFailure`) treats cli_incompatible as recoverable;
- src/engine.ts:2446 (`retryCompatibility`) handles it specially on resume.

The same generic text hides other Docker failures too: daemon not running, and auth volume or mount errors. src/engine.ts:5139 only checks that a `docker` binary exists (`commandExists`), not that the image exists or …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/managed-permissions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/agent-container.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/fake-agent-docker.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/agent-container.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/agent-containers.md`

**Suggested fix:** 1. In the managed-permissions.ts container probe, keep the outcome on failure. Classify Docker-level errors before falling back to the generic message:
   - "No such image" or "Unable to find image" (Docker run exits 125): throw "Docker image <image> is not available locally. Agent isolation never pulls images; build or load it first (docker build / docker load), then resume." Return errorKind "other" (or a new "config" kind), not cli_incompatible, so it does not get recoverable/compatibility-retry handling.
   - "Cannot connect to the Docker daemon": "Docker is installed but its daemon is not running".
   - Anything else: use `describeFailure("docker " + provider + " " + args[0], result)`, so the stderr tail (already redacted or bounded by stderrTail) reaches the step error.
   Keep cli_incompatible only when the container actually ran the CLI and its help or version output lacked the needed flags.
2. Optionally, add a cheap pre-launch check in agent-container.ts, a helper called from …

**Suggested regression test:** Add a missing-image mode to test/fake-agent-docker.mjs: when the image after `--entrypoint <cmd>` matches, for example, `missing/*` (or FAKE_DOCKER_MISSING_IMAGE is set), write "docker: Error response from daemon: No such image: <image>" to stderr and exit 125.

In test/agent-container.test.ts, add a test "a missing agent image fails with Docker's reason and is never pulled":
- for claudeAdapter and codexAdapter, call `run({ prompt, cwd: worktree, mode: "write", agentContainer: { image: "missing …

<details><summary>Verifier's independent reproduction</summary>

Docker Desktop was not running (`docker info` could not connect). The task rules say not to start it, so I used a Docker emulator instead. Real Docker cannot be used for this check without starting Docker Desktop. The reporter's s20e.log already shows the same message on real Docker (run 2610251715-8698d828).

Note: the reporter's fake-docker evidence (s20b2.log and s20d.log) proves nothing on its own. test/fake-docker.mjs cannot handle agent-container launches: it expects `-w` and treats the last argument as a shell command. That makes the probe fail for every image, not only a missing one.

1. I wrote a missing-image Docker emulator at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4611t213/bin/docker. For `run --pull=never` it prints real Docker 28's stderr and exits 125:
   `docker: Error response from daemon: No such image: <img>` / `Run 'docker run --help' for more information`
   It also supports `--version`, `info` and `rm`, and logs every call. Next to it I put wrappers for the fake claude, codex and agy CLIs, using absolute paths to test/fake-agent.mjs.
2. I started a fresh QA server, v4611t213, on port 4611 with that bin directory first on PATH.
3. Through the UI (script r1.mjs) on MQTT-MCP:
   - typed the task and picked Claude Code as provider;
   - opened Run options > Agent isolation, checked "Run agents in a prebuilt Docker image" and entered image `qa-missing-image-real:none`;
   - chose Permissions > "Approve for me" and clicked Send.
   The POST body contained `agentContainer:{image:"qa-missing-image-real:none",network:true}`.
4. Run 2610252244-de46c8b7 failed about 0.4 s after the step started. Run error and step error were both: "Could not verify claude permission controls: Container CLI capability probe failed".
   - The screenshot (shots/v4611t213/002-run-failed.png) shows only that text, twice: once as a red banner and once as the run summary.
   - "No such image" appears nowhere: not in the run .jsonl and not in server.out.
   - The docker call log shows a single `docker run ... --pull=never ... --entrypoint claude qa-missing-image-real:none --help`, then `docker rm --force` of the same container. There was no `docker pull` and no host fallback.
5. I clicked Resume in the UI. A new step s2 failed with the same generic message, and the call log shows the same single probe.

The cli_incompatible errorKind is not persisted on the step record, but the adapter r …

</details>
