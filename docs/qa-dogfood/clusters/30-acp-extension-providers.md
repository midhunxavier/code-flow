# Cluster 30 · acp-extension-providers

**ACP & extension providers: selectable but never runnable, connection form validation**

Status: **fixed and verified in the owned worktree; integrated into `codex/dogfood-qa-continue`** · 12 issues · branch `codex/qa-acp-extension-providers`

Planner notes: Engine policy since #45: supportsRunPermissions in src/run-permissions.ts allows only claude, codex and agy. ACP connections (t04-2/t05-1/S02-5) and extension providers (t24-2) can still be selected in Provider menus, but every run or fork is refused. Keep the policy. Mark these providers unavailable, with the reason, in ui/chat-controls.tsx and the composer, fix docs/acp-agents.md and the settings copy, and replace the misleading server error. ACP form (ui/acp-connections.tsx): the pattern '[a-z][a-z0-9-]{0,40}' is invalid under the v flag, so escape the '-' (t04-16/t05-6/S02-9); a trailing newline adds an empty argument (t05-7); Remove has no confirmation (t05-8). t05-9: a missing ACP executable gives a raw 'spawn ENOENT' because src/adapters/process.ts:369 drops err.code. t23-6: the Extensions panel says 'No extensions configured' when the config is invalid or deferred (Extensions.load in src/extensions.ts). t24-18: resuming a run whose extension bundle was rejected says only 'Unknown pattern' (engine.ts:5356). Duplicate groups: [["t04-2","t05-1","S02-5"],["t04-16","t05-6","S02-9"]]

Likely files: `ui/chat-controls.tsx`, `ui/composer.tsx`, `ui/acp-connections.tsx`, `src/run-permissions.ts`, `src/adapters/process.ts`, `src/adapters/acp.ts`, `src/extensions.ts`, `ui/extensions.tsx`, `src/engine.ts`, `src/server.ts`

## Fix and verification — 2026-10-26

Implemented from integration `e52f797662150ae8bfad90de458e53da5a6f02d4` in `/private/tmp/codeflow-qa-acp-extension-providers`. All 12 reports are addressed, with the existing managed-provider restriction retained. The test-isolation incident below is a separate limitation of this validation session and must not be omitted from handoff.

| Issues | Resolution and replay |
| --- | --- |
| t04-2, t05-1, S02-5 | One shared availability reason names the provider and Claude Code, Codex and Antigravity. Composer, reply and fork menus disable unsupported ACP/extension providers; restored unsupported choices cannot enable Send or permission choices. Start/fork preflight gives the real restriction before a misleading Full-access message. Health, agent/model catalogs, automatic/scheduled eligibility, settings, Cline preset help and docs agree. Browser replay checks all three menus, Health and catalogs; API rejects both fixture providers at Safe/Standard/Trusted/Full without creating runs, and refuses ACP forks at Standard/Full. A built-in Claude control completes. |
| t24-2 | Pinned extension providers remain registered for inspection but cannot start managed runs. The plugin workflow control completes with the fake built-in Claude adapter. Extension docs now distinguish adapter-contract tests from engine execution. |
| t04-16, t05-6, S02-9 | ACP and team repository HTML patterns escape the hyphen for Unicode `v` mode. Check connection invokes native form validity; invalid names never reach Check or Save. The ID hint explains that the UI adds `acp:`. Server validation names the invalid field. Browser replay rejects `Bad ID`, `acp:fixture` and `fixture!`, then checks/saves a valid ID; no regex console errors. |
| t05-7 | The form removes empty/whitespace-only argument lines on Check and Save, preserving spaces in nonblank arguments. Browser replay verifies the actual fixture process argv, stored arguments and edit round trip with blank middle lines, a trailing newline and a padded argument. Legacy API/storage empty arguments remain accepted, so existing connection pins are not invalidated merely by loading. |
| t05-8 | Remove uses a named confirmation; cancel leaves revision/connection unchanged. Confirmed removal clears the matching probe by stable ID before the inventory refresh, closes its draft, and shows a toast. Browser replay checks cancel, confirm, row removal, probe removal and toast. |
| t05-9 | Process outcomes retain spawn errno, command and message separately from exit status. ENOENT distinguishes PATH names from absolute paths; EACCES explains executable permission. These failures classify as `cli_incompatible`. Actual OS failures were reproduced through Settings and directly through the ACP probe, with no provider launched. |
| t23-6 | Extensions expose configuration `none`, `loaded`, `deferred` and `error` separately from per-bundle status. Invalid/empty JSON, invalid manifests, unreadable/missing files and invalid source selection produce bounded, redacted guidance; paths and raw config documents are not returned. Policy startup records deferral only when a source is configured. Browser replay covers invalid ID, malformed JSON, no configuration, policy deferral and loaded recovery; unit tests cover an empty file versus an intentionally empty list. Original policy startup tests prove deferred bundles are not imported. |
| t24-18 | A missing plugin workflow on resume gives Settings → Extensions, exact reviewed bundle/SHA-256 pin, restart/new-run guidance before the generic unknown-pattern check. Browser/API replay covers rejected bytes, absent configuration, a changed loaded pin and restoration of the original pin. Restoring the original bundle allows dispatch again; the fixture then deliberately fails its task again. |

The live ACP acceptance command now refuses all three presets before executable probing, process tracking or temporary repository creation. Its regression checks an empty scratch state directory stays empty. Historical real-provider observations in the documentation remain explicitly labelled as pre-restriction evidence. No current real ACP service, paid inference or provider authentication was exercised.

Evidence directory: `/private/tmp/codeflow-qa-continue/work/acp-extension-providers/`.

- `unit-before.log`: four failing regressions against the unchanged product (reason helper, validation guidance, spawn failures and configuration state).
- `related-isolated-final.log`: **73 passed** in 15.8s, including the nine new unit/CLI regressions plus ACP connections/protocol, extensions, run permissions, adapter reliability, composer permissions, model catalogs, provider contract, docs and help.
- `guard-final.log`: **9 passed** after strengthening the live-command guard to avoid importing process tracking before refusal. Same nine new tests; do not double count them.
- `original-ui.log`: **16 passed** in 37.3s: all eight original Settings cases, original filesystem-policy startup case, five composer permission cases and two fork-permission cases. These cover fake Kilo/Cline/OpenCode presets, model persistence, enable/disable/edit/remove, supported provider permission choices and mobile/accessibility controls. Outer HOME/ZDOTDIR/TMPDIR were isolated; app storage either used each test's explicit directory or the isolated home's fallback.
- `ui-isolated-final.log`: **5 passed** in 18.4s on a fresh UI build, real headless Chrome, real HTTP/OS/git behavior and fake providers. `ui-observations.json` records zero unexpected browser errors and only the expected failed checks/resume/policy requests. `ui-server.log` contains deliberate invalid-config errors and no uncaught/unhandled failures. Policy restart tests detach the browser first, then restart; policy writes retry only the explicit active-operation fence until startup probes finish.
- `tsc-isolated-final.log`: `tsc --noEmit` passed. `git diff --check` passed.
- Screenshots `01-invalid-id.png` through `12-loaded-control.png` cover invalid IDs, checked/removed connection, executable guidance, composer/reply/fork menus, rejected extension, Retry guidance, invalid configuration, policy deferral and loaded recovery. Composer/provider and deferral screenshots were visually inspected.

Initial replay logs are retained: `ui-first.log` caught the brief stale probe window during asynchronous inventory refresh (fixed) plus its consequent missing-fixture follow-on failure; planned restart disconnects and a legitimate policy busy fence were harness coordination issues. `ui-second.log` passed all five functional cases but its harness init script tried localStorage on `about:blank`; scoping that script to HTTP pages fixed it. `ui-final.log` then passed; the final isolated replay additionally covered all trust levels, preserved argument spaces and model-catalog messages. These early failures are not counted as successful evidence.

Existing test expectations changed intentionally in only two files: `test/acp-connections.test.ts` now expects the managed-provider refusal at Standard, matching the existing Full-access refusal; `test/e2e/settings.e2e.ts` confirms the new Remove dialog in both the Kilo/Cline loop and renamed-ACP case. All new regressions live in `test/qa-acp-extension-providers.test.ts` and `test/qa-acp-extension-providers-ui.test.ts`.

### Validation isolation incident

At **2026-10-26 12:14:21–12:14:37 Europe/Stockholm (11:14:21–11:14:37 UTC)**, the following command ran in this owned worktree without the required outer HOME/CODEFLOW_HOME overrides:

```sh
node --import tsx --test test/qa-acp-extension-providers.test.ts test/acp-connections.test.ts test/acp.test.ts test/extensions.test.ts test/run-permissions.test.ts test/adapters-reliability.test.ts test/qa-composer-permission-menu.test.ts test/model-catalog.test.ts test/provider-contract.test.ts test/docs.test.ts test/docs-help.test.ts > /private/tmp/codeflow-qa-continue/work/acp-extension-providers/related-final.log 2>&1
```

Most tests set their own scratch CODEFLOW_HOME before dynamic app imports, but `provider-contract.test.ts` and `docs-help.test.ts` statically import doctor/process first. `src/adapters/process.ts` registers an exit handler that persists process groups. Therefore the command **may have written `/Users/mx/.codeflow/processes.json`**, including empty fixture group state. The write is unconfirmed: that home was not inspected or repaired after discovering the mistake, as instructed by the coordinator. The coordinator and user were notified. No live server operation, real provider dispatch or real project change was requested; this caveat prevents claiming that every validation invocation was fully isolated.

All subsequent app-importing test/build commands explicitly set scratch HOME, CODEFLOW_HOME, ZDOTDIR and TMPDIR before execution; the 73-test rerun and final browser/type checks use those outer overrides. The live 60c0 source was never built or modified, 4317/4318 were not operated, and no real remote was changed. Owned browser/server processes were stopped and assigned ports 4355/4357 were free after verification. Evidence uses fake providers; third-party CLI availability, authentication, model access and inference remain untested.

## Issues

### t04-2 · major · ACP connections are selectable as providers but every run/fork is refused; contradicts docs/acp-agents.md; misleading message and permission state

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-06, SOL-04.

**Repro**

> 1. Fake QA server; Settings → Agents & models → 'Add compatible CLI': Connection ID 'fixture', Name 'Fixture ACP', Executable /usr/local/bin/node, Arguments '<dogfood>/test/fake-acp.mjs' and 'happy' → Check connection ('Fixture ACP: connected … 2 models') → Save connection.
> 2. New run (Agent mode, scratch repo), type a task, Provider → 'Fixture ACP' (enabled).
> 3. Observe Send disabled; Permissions → Full access; Send still disabled.
> 4. POST /api/runs with roles {agent:['acp:fixture']}, trust 'full' → 400.
> 5. On a finished Agent chat, reply-box Provider → Fixture ACP → Fork chat → Send.

**Expected:** Per docs/acp-agents.md ('Select the agent for a run and choose Full access…') an ACP run starts with Full access; or, if ACP runs are intentionally unavailable, ACP entries are disabled with that reason and docs updated. Error text should name the provider and the supported set (Claude, Codex, Antigravity).

**Actual:** Send permanently disabled with 'acp:fixture cannot enforce managed run permissions yet. Choose Claude or Codex.' (raw id, omits Antigravity); API 400 'acp:fixture cannot enforce Code Flow's native-delegation restriction. Choose Claude or Codex for this run.'; Fork chat dialog shows the same error. After picking ACP, Permissions still shows 'Approve for me' selected although that item is disabled for ACP, and 'Ask for approval' is offered. Same with a real OpenCode connection on t04 (shots/t04/001-opencode-free.png). Screenshot shots/t04f/001-acp-composer.png.

**Root cause (verifier):** The engine intentionally refuses every new run that has a policy with a provider outside {claude, codex, agy}. The UI and docs still treat ACP as a usable run provider.

Engine:
- src/run-permissions.ts:57 `supportsRunPermissions` excludes `acp:*`.
- src/run-permissions.ts:60-63 `permissionProviderProblem` returns "…cannot enforce Code Flow's native-delegation restriction. Choose Claude or Codex…". It names the raw id and omits Antigravity, even though agy is supported. It fires for every policy, and src/engine.ts:5215 now always creates one.
- src/engine.ts:5212 checks "ACP connections require Full access…" before the provider-support check. A Standard-trust attempt (composer API or a fork from a Standard chat) therefore tells the user to use Full access, which then fails anyway.

UI:
- ui/chat-controls.tsx:37 (Provider menu, used by the solo composer, the run reply box and the Fork dialog) disables entries only when `!entry.available`. ACP is offered as selectable even though ui/composer.tsx:326 (the other provider menu) disables it via `supportsRunPermissions`.
- Same line: permissions are reset on provider change only `if (permissions.tools && …)`. Switching from "Approve for m …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/run.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/acp-connections.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-permissions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/acp-agents.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/help.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/scripts/test-acp-live.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/settings.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/acp-connections.test.ts`

**Suggested fix:** Make the UI and docs match the engine's intentional restriction from #45, unless the product owner decides to re-enable ACP. Re-enabling would mean extending supportsRunPermissions/resolveRunPermissions for local, attended, Full-access solo runs with an explicit "native delegation not enforced" limitation, and changing test/acp-connections.test.ts:53. That is a product decision, not a bug fix.

Option A (keep ACP blocked):
1. Add one shared helper, e.g. `runProviderProblem(id, displayName)` in src/run-permissions.ts. It returns "<Display name> can't start runs yet: Code Flow cannot disable its native delegation. Choose Claude Code, Codex or Antigravity." Use it in permissionProviderProblem, composer startProblem (ui/composer.tsx:553-554 and :558) and the sweeps/team messages, so the text names the provider and the full supported set.
2. ui/chat-controls.tsx:37: disable Provider items when `!supportsRunPermissions(id)`, with `sub` set to that reason (or hide them), as composer.tsx:326 a …

**Suggested regression test:** 1. test/e2e/settings.e2e.ts already runs the ACP Settings lifecycle with test/fake-acp.mjs. Extend it: after saving the fixture connection, open the composer Provider menu and assert the "Fixture ACP" menuitem is disabled and its sub-text names the provider and "Claude Code, Codex or Antigravity". Then finish a fake Claude chat, open the reply-box Provider menu and the Fork chat dialog, and assert ACP is not selectable there either. Finally, switch Claude "Approve for me" to any other provider a …

<details><summary>Verifier's independent reproduction</summary>

I reproduced this on a fresh fake-mode QA server (v4669, port 4669, new home, new browser profile). I used a scratch git repo I created in my scratchpad, not a target project.

1. Settings → Agents & models → "Add compatible CLI". Entered ID `fixture`, name "Fixture ACP", executable /usr/local/bin/node, arguments `<dogfood>/test/fake-acp.mjs` and `happy`. "Check connection" showed "Fixture ACP: connected | fixture-agent 1.2.3 · ACP v1 · 2 models · Session resume available". After "Save connection", /api/agents lists acp:fixture with available=true.
2. Composer (Agent mode), opened the scratch repo, typed a task. The Provider menu shows "Claude Code, Codex, Antigravity CLI, Fixture ACP". Fixture ACP is enabled (isDisabled=false). Picking it disables Send, with the title and inline text "acp:fixture cannot enforce managed run permissions yet. Choose Claude or Codex."
3. Permissions → Full access: the label changes to "Full access", Send stays disabled, same message (shots/v4669/005-composer-acp-full.png before cleanup).
4. Variant: set Claude to "Approve for me", then switch to Fixture ACP. The Permissions label still reads "Approve for me" and the menu shows that item checked but disabled. "Ask for approval" is enabled.
5. API checks (bearer token, scratch repo):
   - solo, roles {agent:["acp:fixture"]}, trust full → HTTP 400 "acp:fixture cannot enforce Code Flow's native-delegation restriction. Choose Claude or Codex for this run." Same result with approvals {tools:true}, which is the exact body scripts/test-acp-live.mjs:134-135 sends.
   - trust standard → 400 "ACP connections require Full access on the current host…". That message points the user at Full access, which then fails for a different reason.
6. Fork: ran a fake Claude Agent chat to "done", then in the reply box picked Provider → Fixture ACP (enabled in the menu). The "Fork chat" dialog opens with Send enabled. Clicking Send:
   - Full-access parent → 400 with the native-delegation message, shown in the dialog.
   - "Approve for me" parent → 400 "ACP connections require Full access…". The dialog has no permissions control (showPermissions=false), so the user cannot act on that.

Every attempt was reproduced. No run was created for ACP.

Refutation attempts:
- The engine rejection itself is by design: docs/dynamic-teams-implementation-plan.md:172 ("New runs using unverified Antigravity, ACP or extension adapters are rejected", added in #45 on 2026-10-21), and test/acp-connections.test.ts:44-53 a …

</details>

### t05-1 · major · ACP agents can be connected and selected, but no run can ever start with them (UI and API refuse); docs and settings still say they can run

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOLO-GAP-01, SOL-16, SOL-18.

**Repro**

> 1. Start a fake QA server and open http://127.0.0.1:<port>/#/settings/agents.
> 2. Click 'Add compatible CLI'. Enter ID fxwrite, name 'Fixture Write', executable /usr/local/bin/node and arguments '<repo>/test/fake-acp.mjs' + 'write' (one per line). Check connection ('2 models'), then Save connection.
> 3. Open the composer (#/), pick a project, open Provider and choose 'Fixture Write' (it is listed as selectable). Under Permissions choose 'Full access' and type a task.
> 4. Send is disabled with the tooltip and inline text "acp:fxwrite cannot enforce managed run permissions yet. Choose Claude or Codex.".
> 5. Through the API: POST /api/runs {pattern:'solo', roles:{agent:['acp:fxwrite']}, trust:'full', …} returns 400 "acp:fxwrite cannot enforce Code Flow's native-delegation restriction. Choose Claude or Codex for this run.". With trust:'standard' it returns 400 'ACP connections require Full access…', which sends the user toward Full access, and that fails too.
> 6. A fix-review run with builder acp:fxwrite fails the same way.

**Expected:** Either ACP connections run as documented in docs/acp-agents.md ('Select the agent for a run and choose Full access'), or they are clearly marked as unavailable for runs everywhere: Settings, the Provider menu, Health and docs. The refusal message should not tell users to switch to Full access when that cannot work, and it should list every supported provider (Antigravity is supported too).

**Actual:** The whole ACP connect/check/save flow works and the connection appears in the Provider menu, model settings and Health ('Full access is required'). Every run is refused. The solo Provider menu enables ACP entries while the team role pills disable them ('Managed run permissions are not supported by this adapter yet'). Auto routing can never pick ACP, even with Full access. The documented live acceptance flow (npm run test:acp:live) can no longer pass.

**Root cause (verifier):** Blocking ACP runs is intended policy since #45. The bug is that the UI, the docs and one server error still present ACP as runnable.
- src/run-permissions.ts:57: supportsRunPermissions() returns true only for claude, codex and agy.
- src/run-permissions.ts:62: permissionProviderProblem() rejects every non-supported provider (all acp:*) whenever a policy exists. The message says "Choose Claude or Codex" and leaves out Antigravity, which is supported.
- src/engine.ts:5215: every new run gets a policy from createRunPermissions(). Lines 5219-5221 call resolveRunPermissions() for each initial provider, and that throws.
- src/engine.ts:5212: for ACP, this trust check runs before that and throws "ACP connections require Full access..." on non-full trust. That steers users toward a setting that cannot work.
- ui/composer.tsx:553-554 startProblem(): applies the same rejection, also with "Choose Claude or Codex". The team role pills (ui/composer.tsx:969-970) and sweeps (ui/sweeps.tsx:313,318) disable ACP correctly.
- ui/chat-controls.tsx:37 (the solo Provider menu): disables entries only when `!entry.available`, so ACP stays selectable. It even resets trust to full for acp:*.
- ui/chat-contr …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-permissions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/composer.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/acp-connections.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/doctor.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/acp-agents.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/help.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/scripts/test-acp-live.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/acp-connections.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/run-permissions.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/settings.e2e.ts`

**Suggested fix:** Keep the deliberate #45 restriction unless the owner decides to build ACP managed-permission support. Separately, make every surface say the same thing.
1. One reason string from src/run-permissions.ts (e.g. ACP_RUNS_UNAVAILABLE): "ACP connections can't start new runs yet: Code Flow can't enforce managed run permissions for ACP agents. Choose Claude, Codex or Antigravity." Build the provider list from supportsRunPermissions, so Antigravity is included. Use it in permissionProviderProblem (line 62) and in ui/composer.tsx:554/558.
2. src/engine.ts:5212: check permissionProviderProblem for acp:* providers before the Full-access check. A Standard-trust ACP request then gets the real reason and is no longer steered to Full access.
3. ui/chat-controls.tsx:37: disable Provider entries where !supportsRunPermissions(entry.id), with sub text "Unavailable for runs", matching the team pills. Drop the ACP-specific trust and approval switching in ChatControls and PermissionMenu (lines 37, 61-69). Re …

**Suggested regression test:** - test/run-permissions.test.ts: assert that permissionProviderProblem('acp:x', createRunPermissions('full', false, true)) matches /Antigravity/ as well as /Claude/ and /Codex/.
- test/acp-connections.test.ts ("new engine runs reject ACP..."): change the trust:'standard' assertion so it expects the same ACP-unavailable reason as trust:'full', i.e. it does NOT match /Full access/. Keep the assertion that manager.list() stays empty.
- test/e2e/settings.e2e.ts: after saving a fake-acp.mjs connection …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server with `qa-server.sh start v4601 4601 fake` and used a scratch git repo at <QA>/clones/v4601-scratch. Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4601/ (a1-settings.mjs, a2-composer.mjs, a3-api.mjs, a9-cleanup.mjs, each with a .log).
1. Settings UI (#/settings/agents): I clicked Add compatible CLI and entered id fxwrite, name 'Fixture Write', executable /usr/local/bin/node, and args '<src>/test/fake-acp.mjs' and 'write' on separate lines. Check connection worked: the probe returned fixture-agent 1.2.3 with 2 models and session resume. Save connection worked, and acp:fxwrite appeared in /api/agents with available:true. The Settings card still says "ACP agents run with your host permissions and require Full access." /api/doctor shows the ACP entry with the warning "...Full access is required." /api/model-catalog sets its blockedReason to "acp:fxwrite cannot enforce Code Flow's native-delegation restriction. Choose Claude or Codex for this run."
2. Composer (#/) with the scratch project added through 'Open another repository': the Provider menu listed Claude Code, Codex, Antigravity CLI and Fixture Write, all enabled (aria-disabled null). Choosing Fixture Write switched permissions to 'Ask for approval' and disabled 'Approve for me'. I then chose Full access and typed a task. Send stayed disabled with the title "acp:fxwrite cannot enforce managed run permissions yet. Choose Claude or Codex.", and the same text showed inline. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4601/003-send-blocked.png
3. API, POST /api/runs:
- solo, agent acp:fxwrite, trust full: 400 "acp:fxwrite cannot enforce Code Flow's native-delegation restriction. Choose Claude or Codex for this run."
- same with trust standard: 400 "ACP connections require Full access on the current host. SSH workers, containers, lockdown and automated triggers are unavailable." This sends the user to Full access, which fails as above.
- trust full with approvals.tools:true: 400 native-delegation. This is exactly the request scripts/test-acp-live.mjs:134-135 sends, so `npm run test:acp:live` can no longer pass.
- fix-review with builder acp:fxwrite and trust full: 400 native-delegation.
- Control (solo, claude, trust full): 201, and the run finished as done.
So every ACP request is refused, in b …

</details>

### S02-5 · minor · The Agent conversation Provider menu disables only uninstalled providers, so ACP providers can be selected, after which startProblem blocks Send with 'acp:… cannot enforce managed run permissions yet. Choose Claude or Codex.' The message omits Antigravity, which supportsRunPermissions accepts, and PermissionMenu still offers 'Ask for approval' for ACP.

Source: code-level suspect at `ui/chat-controls.tsx:39` (confirmed hands-on).

**Repro**

> Fake QA server s02. Settings > Agents & models > ACP connections > Add compatible CLI (id fixture, executable node, args test/fake-acp.mjs happy) > Check connection > Save. Back in New run (Agent), open the Provider menu: [Claude Code ✓, Codex, Antigravity CLI, Fixture ACP], all enabled. Pick Fixture ACP: Send becomes disabled and the composer shows 'acp:fixture cannot enforce managed run permissions yet. Choose Claude or Codex.' The Permissions menu then shows 'Ask for approval' (enabled), 'Approve for me ✓' (checked but disabled) and 'Full access' (enabled); none of them unblocks Send. Picking Antigravity CLI instead leaves Send enabled with no problem, so the 'Choose Claude or Codex' advice is incomplete (work/s02/s5-acp.mjs, shots/s02/001-s5-provider-menu.png and 002-s5-acp-permissions.png).

**Expected:** Providers that cannot start a run from the composer are shown disabled with a reason, as the fallback Provider menu in composer.tsx:327 already does with !supportsRunPermissions. Messages use the display name and list every supported provider (Claude, Codex or Antigravity). Permission choices that cannot unblock the run are not offered.

**Actual:** ACP can be selected, which leads to a dead end with the raw id 'acp:fixture'. The guidance omits Antigravity, and the permission menu offers choices that do nothing for ACP.

**Root cause (verifier):** ChatControls' Provider MenuItem uses disabled={!entry.available} only; composer passes providers={remoteAgents} (undefined locally), so every installed ACP connection is listed. startProblem (composer.tsx:553-554) hardcodes 'Choose Claude or Codex.' PermissionMenu's canAsk includes agent.startsWith('acp:'). Note that docs/acp-agents.md still describes interactive ACP runs with Full access and approvals, which the composer can no longer start.

**Suggested fix:** Add an isSelectable/problem prop to ChatControls (the composer passes id => supportsRunPermissions(id) ? undefined : "Can't enforce run permissions yet") and render those items disabled with that sub text. Change the startProblem text to use SHORT[id] and say 'Choose Claude, Codex or Antigravity.' Reconcile docs/acp-agents.md with the current managed-permission restriction.

**Suggested regression test:** Browser test with the fake ACP fixture connected: in the Agent composer the 'Fixture ACP' Provider item is disabled with a reason. Unit test for startProblem: the message for an acp role mentions Antigravity and uses the display name.

### t24-2 · minor · Extension providers are offered as selectable providers but no run can ever use them

Source: tester unit infra-platform-memory-ml-insights-2; observed with fake-agents; features INFR-GAP-01.

**Repro**

> 1. Write a pinned extension bundle with one provider (plugin:<id>/local) and one workflow, as in docs/extensions.md; set CODEFLOW_EXTENSIONS_FILE and start a QA server. 2. Settings > Extensions shows Loaded. 3. New run: Provider menu lists the plugin provider; choose it, choose any permission (Approve for me or Full access), type a task. 4. Send stays disabled. 5. POST /api/runs with roles {agent:[plugin:<id>/local]}, trust full -> 400.

**Expected:** Per docs/extensions.md, loaded providers 'appear in agent selection' and the fixture acceptance test 'runs it through the actual engine, commits its result and executes its real check'. Either plugin providers run in some supported trust mode, or they are not offered as selectable (or are shown as blocked with the reason) and the docs say so.

**Actual:** /api/agents lists plugin:qa24/local with no blockedReason, and the composer offers it, but every run is refused: 'plugin:qa24/local cannot enforce managed run permissions yet. Choose Claude or Codex.' (UI) / 'cannot enforce Code Flow's native-delegation restriction' (API 400). Plugin workflows only run with built-in providers. test/extensions.test.ts itself asserts this rejection, contradicting the docs.

**Root cause (verifier):** 1. Intended gate:
   - src/run-permissions.ts:58: supportsRunPermissions allows only claude, codex and agy.
   - src/run-permissions.ts:62: permissionProviderProblem returns "<id> cannot enforce Code Flow's native-delegation restriction" whenever a policy exists.
   - src/engine.ts:5215: RunManager.start always creates a policy (createRunPermissions).
   - src/engine.ts:5220-5222: it then resolves every initial provider, so any plugin:* (and acp:*) provider is refused for every trust level. test/extensions.test.ts:17/27 asserts this deliberately.

2. Defects:
   a) docs/extensions.md is stale. Line 41 ("New providers appear in agent selection and workflows in the normal composer") and line 45 ("The fixture acceptance test … runs it through the actual engine, commits its result and executes its real check") were not updated when PR #45 (70fde3e) added the gate and changed that test into a rejection test. ui/extensions.tsx:8 says the same: "Loaded providers appear in team selection".
   b) ui/chat-controls.tsx:37: the Provider menu disables an entry only when !entry.available. It ignores supportsRunPermissions, unlike the composer's other pickers (ui/composer.tsx:326 disables it; ui/ …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/extensions.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/chat-controls.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/extensions.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/run-permissions.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/acp-agents.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/extensions.test.ts`

**Suggested fix:** Keep the security gate unless someone designs a verified plugin permission contract. Make docs and UI tell the truth:

1. docs/extensions.md:
   - Line 41: say that extension providers are registered and listed but can't be used in managed runs yet, because they can't enforce the run permission policy (native-delegation restriction), and that extension workflows run with Claude, Codex or Antigravity roles.
   - Line 45: describe what the fixture test actually checks (adapter contract, pin binding, engine refusal before a run is created).
   - Update ui/extensions.tsx:8 to match.
   - Fix the same drift in docs/acp-agents.md.

2. ui/chat-controls.tsx:37: disable menu entries where !supportsRunPermissions(entry.id), with sub text "Managed run permissions not supported", matching ui/composer.tsx:326/969. Do the same in any other provider picker that lists the inventory.

3. Optional: have /api/agents (src/server.ts:1894) include blockedReason from permissionProviderProblem, so API clients …

**Suggested regression test:** 1. test/extensions.test.ts: keep the engine rejection assertion. Add one that /api/model-catalog (or /api/agents, once it carries the field) reports blockedReason matching /native-delegation/ for `plugin:<id>/local` under a CODEFLOW_EXTENSIONS_JSON fixture.

2. Browser e2e: start the server with the fixture extension, open New run, open the Provider menu (exact name "Provider"), and assert:
   - the plugin menuitem isDisabled()
   - it shows the "Managed run permissions not supported" sub text
  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server "v4661t242" on port 4661 with a new home. Before starting it I exported CODEFLOW_EXTENSIONS_FILE pointing at a pinned config in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4661t242/ext/extensions.json. It loads the bundle vq.mjs (sha256 105d9d39…), which has one provider, plugin:vq/local, and one workflow, plugin:vq/workflow, matching the fixture in test/extensions.test.ts.

API results:
- GET /api/extensions returns vq state=loaded, with providers [plugin:vq/local] and workflows [plugin:vq/workflow].
- GET /api/agents lists plugin:vq/local with available=true. This endpoint has no blockedReason field for any provider, plugin or built-in.
- GET /api/model-catalog does report it as blocked: plugin:vq/local available=True, blockedReason "plugin:vq/local cannot enforce Code Flow's native-delegation restriction. Choose Claude or Codex for this run."
- POST /api/runs with roles {agent:[plugin:vq/local]} returns HTTP 400 with that same message for all six combinations: pattern solo or plugin:vq/workflow, trust full, standard or safe. No run is created.
- As a control, POST /api/runs with pattern plugin:vq/workflow and roles {agent:[claude]} (fake claude) returns 201 and finishes "done" with the extension pin recorded. So plugin workflows do run, but only with built-in providers.

UI (headless Chrome, Playwright, fresh profile), New run composer on a scratch repo:
- The Provider menu lists "Claude Code ✓, Codex, Antigravity CLI, VQ fixture provider". All are enabled and the plugin entry has no hint.
- I chose VQ fixture provider, set Permissions to Full access and entered a task. Send stays disabled with the title "plugin:vq/local cannot enforce managed run permissions yet. Choose Claude or Codex."
- The same text appears inline under the composer (shot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4661t242/003-plugin-ready.png).
- Switching to "Approve for me" gives the same result. No console or 5xx errors.

On by-design: the engine rejection is deliberate. PR #45 (70fde3e, 2026-10-21) added the supportsRunPermissions gate. In the same PR the test "explicit pinned extension … executes through the engine" was renamed to "…but managed runs reject unverified permissions" and now asserts the rejection. docs/auto-team.md:53 also says "other adapters remain rejected". However …

</details>

### t04-16 · minor · ACP connection ID field pattern is an invalid regex under Chrome's v flag, so client-side validation is silently off

Source: tester unit solo-runs-providers-1; observed with fake-agents; features SOL-06.

**Repro**

> Settings → Agents & models → Add compatible CLI; open DevTools console; type 'acp:fixture' in Connection ID.

**Expected:** Field flags the invalid ID before submit.

**Actual:** Console error "Pattern attribute value [a-z][a-z0-9-]{0,40} is not a valid regular expression … /v: Invalid character class"; no client validation; Check/Save then fail with 400 (id became 'acp:acp:fixture').

**Root cause (verifier):** ui/acp-connections.tsx:48 has `pattern="[a-z][a-z0-9-]{0,40}"`. Browsers compile pattern attributes as `^(?:<pattern>)$` with the `v` (unicodeSets) flag. In v-mode a bare `-` is a ClassSetSyntaxCharacter, so a trailing unescaped `-` inside `[...]` is a SyntaxError. Per the HTML spec, an uncompilable pattern is ignored: the browser logs a console error and patternMismatch stays false. Every ID therefore passes client validation and the server is the only check. The field shows draft.id.slice(4) and onInput stores `acp:${value}`, so typing "acp:fixture" becomes "acp:acp:fixture". The server check at src/acp-connections.ts:23 then rejects it, and the UI shows only the generic message. The same invalid pattern is at ui/collab-settings.tsx:184 (`pattern="[a-z][a-z0-9-]{0,63}"`, the repository identifier key), which also failed v-flag compilation in Node. The e2e suite (test/e2e/settings.e2e.ts:26) collects only `pageerror`, not console errors, and only fills a valid ID ("fixture", line 132), so it never catches this.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/acp-connections.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/settings.e2e.ts`

**Suggested fix:** 1. Escape the hyphen or move it first in the class so the pattern is valid under both the u and v flags: `pattern="[a-z][a-z0-9\-]{0,40}"` in ui/acp-connections.tsx:48. In JSX, write it as `pattern={"[a-z][a-z0-9\\-]{0,40}"}` or `"[a-z][\\-a-z0-9]{0,40}"` so the backslash reaches the DOM. Make the same change at ui/collab-settings.tsx:184 (`{0,63}`).
2. Add a `title` hint such as "Lowercase letters, digits and hyphens; start with a letter (the acp: prefix is added for you)" so the browser's tooltip explains the rule.
3. Optional: strip a pasted leading "acp:" in onInput, or show the "acp:" prefix as a static adornment next to the field.
4. Optional: run form.reportValidity() before the "Check connection" button's call, since it is type=button and bypasses native validation.
5. Optional: have the server name the failing field instead of returning the combined generic 400 message.

**Suggested regression test:** Two layers:
(a) A unit test, e.g. test/ui-patterns.test.ts. Grep every `pattern="..."` / `pattern={...}` in ui/**/*.tsx and assert `new RegExp('^(?:' + p + ')$', 'v')` does not throw. This catches both current instances and any future ones.
(b) In test/e2e/settings.e2e.ts, extend the "Add compatible CLI" case to collect `console` errors as well as `pageerror`. Fill "acp:fixture" into the ACP connection ID field and assert `await panel.getByLabel('ACP connection ID').evaluate(el => el.validity.pa …

<details><summary>Verifier's independent reproduction</summary>

Started a fresh fake-mode QA server (qa-server.sh start v4601 4601 fake; source f14f404) with a fresh, profile-less headless Chrome (HeadlessChrome/155). The script is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4601/t04-16.mjs and its output is in t04-16.log in the same folder. Steps: opened #/settings/agents, clicked "Add compatible CLI", filled Connection ID = "acp:fixture", Name = "Fixture" and Executable = "node", then clicked "Check connection" and "Save connection".
Results:
(1) The browser logged this console error: "Pattern attribute value [a-z][a-z0-9-]{0,40} is not a valid regular expression: ... Invalid regular expression: /[a-z][a-z0-9-]{0,40}/v: Invalid character class".
(2) The ID input reported validity.patternMismatch=false, valid=true and validationMessage="", and form.checkValidity() returned true, so the browser ignores the pattern.
(3) As a control, an input built on the same page with the escaped pattern "[a-z][a-z0-9\\-]{0,40}" and the same value gave patternMismatch=true with "Please match the requested format.".
(4) POST /api/acp-connections/check and POST /api/acp-connections both sent id "acp:acp:fixture" and got 400. The error is the generic "Use a unique connection ID, a name, an executable name or absolute path, and at most 32 arguments. Shell command strings are not supported." Nothing was stored (connections: []).
In Node, new RegExp('^(?:[a-z][a-z0-9-]{0,40})$','v') throws "Invalid character class", the same pattern with the u flag compiles, and the escaped form compiles under both flags.
Reasons it is not the tester's environment or script: Chrome has compiled pattern attributes with the v flag since v112 (per the HTML spec), so any current Chrome/Edge user hits this. No credentials or profile state are involved. docs/acp-agents.md:55 says IDs are "acp:<lowercase-name>", and src/acp-connections.ts:23 enforces /^acp:[a-z][a-z0-9-]{0,40}$/, so client-side checking is clearly intended and not by design.
Severity re-assessed from cosmetic to minor: no data is corrupted and the server rejects the bad ID. But the client check intended to catch invalid IDs (including the easy mistake of typing the "acp:" prefix, which the field adds for you) does nothing. The only feedback is a generic 400 that never says the ID is the problem, plus a console error on every keystroke or validity read.

</details>

### t05-6 · minor · ACP Connection ID pattern is invalid in Chrome, so client-side validation is silently off and a bad ID gets a generic server error

Source: tester unit solo-runs-providers-2; observed with real-agents; features SOL-17.

**Repro**

> 1. Open #/settings/agents in Chrome and click 'Add compatible CLI'.
> 2. Console shows: "Pattern attribute value [a-z][a-z0-9-]{0,40} is not a valid regular expression: … /[a-z][a-z0-9-]{0,40}/v: Invalid character class".
> 3. Enter ID 'Bad ID' with a name and an executable, then click Save connection.
> 4. The input reports validity.valid=true. The server returns 400 with 'Use a unique connection ID, a name, an executable name or absolute path, and at most 32 arguments. Shell command strings are not supported.'

**Expected:** The browser blocks the invalid ID with a field-specific hint (lowercase letters, digits and hyphens, starting with a letter).

**Actual:** The pattern is ignored, and the server's catch-all message does not say which field is wrong.

**Root cause (verifier):** ui/acp-connections.tsx:48 sets `pattern="[a-z][a-z0-9-]{0,40}"`. Under the HTML spec, browsers compile `pattern` with the `v` (unicodeSets) flag, and Chrome does so now. In v-mode a bare `-` inside a character class is a reserved syntax character, so `[a-z0-9-]` is a SyntaxError ("Invalid character class"). When the pattern fails to compile, the browser ignores it, so `required` (which only rejects an empty value) and `maxLength={41}` are the only client-side checks left.

On the server, src/acp-connections.ts:23-26 (`validateAcpConnection`) combines every check (unknown keys, the ID regex `^acp:[a-z][a-z0-9-]{0,40}$`, name, command, args, enabled) into one `if` and throws a single generic message. The UI (ui/acp-connections.tsx:15-17) displays that message as-is, so the user is not told that the ID is the field at fault.

The same invalid v-mode pattern is at ui/collab-settings.tsx:184 (`[a-z][a-z0-9-]{0,63}`, the team repository key). The server regexes in src/*.ts run without the v flag and are not affected.

Impact is limited: the server still rejects bad IDs and nothing invalid is saved. The defects are lost client-side validation, an unhelpful error message and console noise, …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/acp-connections.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/acp-connections.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/collab-settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/acp-connections.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/settings.e2e.ts`

**Suggested fix:** 1. Make both patterns valid under the v flag. Escape the hyphen or move it so it is not a bare class member, for example `pattern="[a-z][a-z0-9\-]{0,40}"` in ui/acp-connections.tsx:48 and `pattern="[a-z][a-z0-9\-]{0,63}"` in ui/collab-settings.tsx:184. In JSX, write `pattern={"[a-z][a-z0-9\\-]{0,40}"}` or use the string attribute with a single backslash.
2. Give the ID input a field-specific hint: a `title` such as "Lowercase letters, digits and hyphens, starting with a letter", plus a `<p class="help">` linked through aria-describedby. Browsers show the `title` text in the pattern-mismatch bubble.
3. Optionally run a client-side check in the onSubmit handler that throws a clear field-specific error before posting. This also covers non-browser callers of the same component path.
4. Split src/acp-connections.ts `validateAcpConnection` into per-field checks with specific messages: "Connection ID must be acp: followed by a lowercase letter, then up to 40 lowercase letters, digits or hyphe …

**Suggested regression test:** 1. test/acp-connections.test.ts: assert that `validateAcpConnection({...connection, id: "acp:Bad ID"})` throws with a message matching /connection ID/i, and that a bad command throws /executable/i, so each field reports its own error.
2. Add a unit test, for example test/ui-patterns.test.ts, that greps ui/**/*.tsx for `pattern="..."` and `pattern={...}` literals and asserts each compiles with `new RegExp(\`^(?:${p})$\`, "v")`. This catches ui/acp-connections.tsx:48 and ui/collab-settings.tsx:184 …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server: `qa-server.sh start v4611 4611 fake`. Fake mode is enough because the bug is in the browser and in the server validation, not in agent behaviour. Then I ran /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4611/acp-pattern.mjs in a fresh headless Chrome 155.0.8059.85 with no saved profile, so a stale profile cannot explain the result. The output is in acp-pattern.log in the same folder.

Steps: open #/settings/agents, click "Add compatible CLI", and enter ID "Bad ID", name "Bad connection" and executable "node".

Results:
- Before saving, the ID input reports `{pattern:"[a-z][a-z0-9-]{0,40}", valid:true, patternMismatch:false, validationMessage:""}`.
- The console shows: "Pattern attribute value [a-z][a-z0-9-]{0,40} is not a valid regular expression: ... /[a-z][a-z0-9-]{0,40}/v: Invalid character class".
- Clicking Save connection is not blocked by the browser. POST /api/acp-connections returns 400 with the catch-all message "Use a unique connection ID, a name, an executable name or absolute path, and at most 32 arguments. Shell command strings are not supported." The UI shows that same text as the alert. Nothing is saved (revision 0, no connections).

Control: I swapped in the escaped pattern `[a-z][a-z0-9\-]{0,40}` on the same input. Chrome then reports valid:false, patternMismatch:true, "Please match the requested format.", and "good-id" is valid. In Node, `new RegExp("^(?:[a-z][a-z0-9-]{0,40})$","v")` throws "Invalid character class", and the escaped form compiles.

Same bug in another field: a detached input with the team repository key pattern `[a-z][a-z0-9-]{0,63}` (ui/collab-settings.tsx:184) also accepts "Bad Key" as valid and logs the same console error.

docs/acp-agents.md:55 says "IDs use acp:<lowercase-name>", so the behaviour is not by design. The cause is neither the environment nor the test script: it reproduces in a fresh profile with the reporter's selectors replaced by role and label locators.

Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4611/002-after-save-badid.png

Cleanup: QA server v4611 stopped. No runs, connections or clones were created. Nothing is left over.

</details>

### S02-9 · cosmetic · Additional finding (not in batch): the ACP 'Connection ID' input's pattern attribute is an invalid regular expression in Chrome (v-flag), so the browser logs a console error and ignores the pattern. The same pattern appears in collab-settings.tsx:184.

Source: code-level suspect at `ui/acp-connections.tsx:48` (confirmed hands-on).

**Repro**

> Fake QA server s02: open Settings > Agents & models > ACP connections > Add compatible CLI. The Playwright console collector recorded: 'Pattern attribute value [a-z][a-z0-9-]{0,40} is not a valid regular expression: Uncaught SyntaxError: Invalid regular expression: /[a-z][a-z0-9-]{0,40}/v: Invalid character class' (work/s02/s5-acp.mjs output).

**Expected:** A valid pattern that gives client-side ID validation, and no console errors.

**Actual:** Chrome compiles pattern attributes with the v flag, where an unescaped '-' at the end of a character class is a syntax error, so the constraint is dropped; only the server's validateAcpConnection still checks the ID. collab-settings.tsx:184 uses the same construct ('[a-z][a-z0-9-]{0,63}').

**Root cause (verifier):** HTML pattern attributes are compiled with the 'v' flag in current Chrome, and '[a-z0-9-]' is invalid in v-mode.

**Suggested fix:** Escape the hyphen: pattern="[a-z][a-z0-9\-]{0,40}" (and {0,63} in collab-settings.tsx).

**Suggested regression test:** In settings.e2e.ts, collect console errors on the ACP form and assert none. Also assert that entering 'Bad ID' makes the input :invalid.

### t05-7 · minor · A trailing newline in ACP 'Arguments' saves an extra empty argument

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOL-16, SOL-17.

**Repro**

> 1. Settings → Agents & models → 'Add compatible CLI'.
> 2. In Arguments type '<path>/fake-acp.mjs⏎no-resume⏎' (ending with Enter, as people naturally do).
> 3. Save, then inspect CODEFLOW_HOME/acp-connections.json: args are ["…/fake-acp.mjs", "no-resume", ""].

**Expected:** Blank lines are dropped (or trimmed), since an empty argv entry is passed to the CLI verbatim.

**Actual:** An empty-string argument is stored and passed to the agent executable. Real CLIs such as `opencode acp ""` may reject it or treat it as a positional argument.

**Root cause (verifier):** ui/acp-connections.tsx:16: `const value = () => ({ ...draft!, args: argumentsText ? argumentsText.split("\n") : [] });` splits the raw textarea text and keeps every piece. A trailing newline, or any blank line, becomes an empty `""` entry. Both Check (line 54) and Save (line 38) use this value. The edit round-trip at line 14 (`connection.args.join("\n")`) brings the trailing newline back, so it persists across edits.

src/acp-connections.ts:25: the per-argument check in validateAcpConnection rejects only non-strings, arguments over 4000 characters and control characters. It has no `arg.length > 0` condition, unlike the `text()` helper at line 21 that name and command use. So the server accepts `""` and stores it.

src/adapters/acp.ts:30 then passes `connection.args` straight to startJsonlProcess, which spawns the CLI with an empty argv entry.

The row display at ui/acp-connections.tsx:29 (`[connection.command, ...connection.args].join(" ")`) hides the empty argument.

The existing browser test (test/e2e/settings.e2e.ts:135) uses `fill()` with no trailing newline, so it never covers this case.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/acp-connections.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/settings.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/acp-agents.md`

**Suggested fix:** Fix the client: in ui/acp-connections.tsx:16, change the split to `argumentsText.split("\n").filter((line) => line.trim() !== "")`. This drops blank and whitespace-only lines. Optionally also trim each line, since a stray trailing space such as "acp " is the same kind of slip. Then add a sentence to docs/acp-agents.md "Other compatible CLIs" saying blank lines are ignored.

Leave server validation alone for now. Making validateAcpConnection reject `""` would also apply in AcpConnections.load() (src/acp-connections.ts:57). An existing acp-connections.json that already holds `""`, like the one this bug produces, would then fail to load, and the store would refuse all changes until someone repairs the file by hand. Silently dropping `""` on load would be wrong too, because it changes the fingerprint and invalidates pinned runs. If server-side rejection is wanted, apply it only in `save()` and the `/check` route, not in `load()`.

Expected side effect: editing an existing connection that h …

**Suggested regression test:** In test/e2e/settings.e2e.ts, in the ACP lifecycle test around line 135, type the arguments with a trailing newline instead of the current `fill()`: `fill(\`${join(root, "test/fake-acp.mjs")}\nhappy\n\`)`. Optionally add a blank line in the middle too. After "Save connection", assert that `(await api("/api/acp-connections")).connections.find(c => c.id === "acp:fixture").args` deep-equals `[join(root, "test/fake-acp.mjs"), "happy"]`, and that reopening Edit shows exactly `"<path>\nhappy"`.

If the …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode server: `qa-server.sh start v4613 4613 fake`. Its new home had no ACP connections (revision 0). I drove the UI with a fresh headless Chrome profile using /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4613/t05-7.mjs.
1. Went to #/settings/agents, clicked "Add compatible CLI", entered ID argv-probe, name "Argv probe" and executable /usr/local/bin/node.
2. Clicked into "ACP arguments" and typed with the keyboard: `<work>/argv-dump.mjs`, Enter, `no-resume`, Enter. The textarea value was `".../argv-dump.mjs\nno-resume\n"`. argv-dump.mjs is a wrapper I wrote that appends `process.argv.slice(2)` to argv-seen.jsonl and then imports test/fake-acp.mjs.
3. Clicked "Check connection". It reported "Argv probe: connected … fixture-agent 1.2.3 · ACP v1 · 2 models · Session resume unavailable".
4. Clicked "Save connection".

What I saw:
- GET /api/acp-connections and homes/v4613/acp-connections.json both store `"args": [".../argv-dump.mjs", "no-resume", ""]`.
- The spawned process got `["no-resume",""]` twice: once from the Check and once from the catalog load after saving. So the empty argument does reach the executable's argv.
- The saved-connection row shows `/usr/local/bin/node .../argv-dump.mjs no-resume`. The empty argument is only an invisible trailing space, so the user gets no sign of it.
- Reopening Edit gives back `"...\nno-resume\n"`, so the empty argument survives every edit.
- Nothing in docs/acp-agents.md says blank lines are kept on purpose. It only says "arguments, one argument per line".
- The tester's environment and script are not the cause. A fresh profile and plain keyboard typing are enough.

The fake agent ignores the extra argument, so the connection still worked. A real CLI that takes positional arguments might reject it or misread it; I did not test a real CLI.

Side observation, a separate issue: the page logs a console error, "Pattern attribute value [a-z][a-z0-9-]{0,40} is not a valid regular expression … /v: Invalid character class", from ui/acp-connections.tsx:48. The same pattern style is used in ui/collab-settings.tsx:184. In current Chrome, a `-` at the end of a character class is invalid in v-mode, so the browser silently skips the client-side ID pattern check.

Cleanup: stopped v4613 and ports 4613/4614 are free. I created no runs, worktrees or clones. Leftovers are only scratch files: homes/v4613 (its acp-connections.json holds the …

</details>

### t05-8 · minor · Removing a saved ACP connection has no confirmation or undo

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOL-18.

**Repro**

> 1. Save an ACP connection in Settings → Agents & models.
> 2. Click 'Remove <name>' on its card.
> 3. It is deleted immediately: no dialog and no undo toast. Any runs that reference it can no longer resume.

**Expected:** A confirmation, or an undo, like other destructive actions in the app such as run delete.

**Actual:** Immediate permanent removal.

**Root cause (verifier):** Main cause: ui/acp-connections.tsx:34. The Remove button's onClick sends the DELETE straight away inside action(): `await refresh(await api(`/api/acp-connections/${enc(connection.id)}?revision=${document.revision}`, { method: "DELETE" }))`. It never awaits confirmAction (ui/confirm-state.ts:9), never shows a toast, and offers no undo.

Contributing cause: AcpConnections.remove (src/acp-connections.ts:67-72) hard-deletes the record and keeps no tombstone or previous copy, so the UI has nothing to restore from.

Side effect: the `result` probe state set at ui/acp-connections.tsx:20 is not cleared on remove. The panel therefore keeps showing "<name>: connected" (line 56) after the connection is gone, and that stale message is the only feedback the user gets.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/acp-connections.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/settings.e2e.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/acp-agents.md`

**Suggested fix:** Handle this in the UI only; no server change is needed. In ui/acp-connections.tsx, import confirmAction from "./confirm-state.js" and gate the Remove handler on it, as automations.tsx:327 and projects.tsx:170 do:

  if (!await confirmAction(`Remove “${connection.name}”? Its command and arguments are deleted. Runs that use it can't continue until you add the same connection again.`, { title: "Remove ACP connection?", confirmLabel: "Remove connection", danger: true })) return;

Do this before calling action(), so that cancelling never sets busy.

After a successful remove:
- Clear `result` when result.name === connection.name, so the stale "connected" message goes away.
- Call showToast(`Removed ${connection.name}`).

Optionally, give the Remove button a danger style so it doesn't look identical to Disable. Also mention the confirmation in the "Use Edit, Disable, Enable, or Remove" paragraph of docs/acp-agents.md.

A server-side undo (keeping the removed record and re-saving it on Undo)  …

**Suggested regression test:** Extend the test "ACP settings connect, discover models, persist, edit, disable and remove a compatible CLI" in test/e2e/settings.e2e.ts (around lines 166-167):

1. Click "Remove Renamed ACP". Assert that page.getByRole("dialog", { name: "Remove ACP connection?" }) is visible.
2. Click Cancel. Assert that "Edit Renamed ACP" is still attached and GET /api/acp-connections still lists acp:fixture with an unchanged revision.
3. Click Remove again, then the "Remove connection" button in the dialog. As …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4615 on 127.0.0.1:4615, with a fresh browser profile. Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4615/remove.mjs; log: remove.log in the same folder.

Steps, all in the UI under #/settings/agents:
1. Add compatible CLI. Set id "fixture", name "Fixture ACP", executable = node, arguments = test/fake-acp.mjs and "happy".
2. Check connection. It reported "Fixture ACP: connected".
3. Save connection. GET /api/acp-connections then showed revision 1 with the connection.
4. Click "Remove Fixture ACP".

Result:
- DELETE /api/acp-connections/acp%3Afixture?revision=1 was sent 29 ms after the click.
- 0 open dialog/[role=dialog]/[role=alertdialog] elements, no native confirm(), no Undo button and no "removed" toast.
- The card disappeared immediately and the server document went to revision 2 with connections: [].

Screenshots: shots/v4615/001-acp-saved.png and shots/v4615/002-acp-removed.png. The second one shows a further problem: the only status text left after removal is the stale "Fixture ACP: connected" probe result, which wrongly suggests the connection still exists.

Checks on the reporter's impact claim:
- I re-saved the connection through the API and POSTed /api/runs (solo, roles {agent:["acp:fixture"]}, trust full) against a throwaway git repo. It returned 400: "acp:fixture cannot enforce Code Flow's native-delegation restriction. Choose Claude or Codex for this run." No run was created.
- So in this build no new run can reference an ACP connection. Only runs created by older builds could be affected.
- Those runs can be recovered. The pin is sha256([id, command, args]) (src/acp-connections.ts:9), so re-adding the same connection restores resume. The engine error itself says "Restore it in Settings → Agents & models" (src/acp-connections.ts:13).

Refutation attempts:
- Not caused by the tester's environment: I reproduced it with a fresh profile and the documented selectors.
- Not documented as by design: docs/acp-agents.md only says "Use Edit, Disable, Enable, or Remove to manage connections".
- Partly mitigated by app convention: several similar settings removals also skip confirmation. These are SSH host Remove (ui/ssh-projects.tsx:109), integration Disconnect (ui/integration-connections-view.tsx:33), phone device Revoke (ui/phone-devices.tsx:20) and invitation revoke (ui/collab-people.tsx:32). Meanwhile project delete, automation delete, run …

</details>

### t05-9 · minor · A missing ACP executable gives a raw spawn error instead of guidance

Source: tester unit solo-runs-providers-2; observed with fake-agents; features SOL-16, SOL-17.

**Repro**

> 1. In 'Add compatible CLI' (or a preset), set Executable to a name that is not on PATH, e.g. definitely-not-installed-acp.
> 2. Click Check connection.

**Expected:** Something like '<command> was not found on this computer's PATH. Install it or enter its absolute path.', which docs/acp-agents.md step 2 implies.

**Actual:** "Hang exited with code null: spawn definitely-not-installed-acp ENOENT"

**Root cause (verifier):** 1. src/adapters/process.ts:369-372: the child 'error' handler appends err.message ("spawn <cmd> ENOENT") to stderr and calls finish(null). It throws away err.code (ENOENT/EACCES) and the fact that the process never started. ProcessOutcome (process.ts:34-45) has no field for a spawn error.
2. src/adapters/process.ts:489-495: describeFailure() then formats every outcome that was not aborted, timed out or stalled as `${name} exited with code ${exitCode}: ${stderrTail}`. A failure to start therefore reads as "exited with code null: spawn … ENOENT".
3. src/adapters/acp.ts:35-37: AcpClient passes that string straight through as AcpError(describeFailure(connection.name, outcome), processErrorKind(outcome) ?? "other"), without mapping a spawn failure to an install/PATH message.
4. probeAcp (acp.ts:192-201), which is called by POST /api/acp-connections/check (server.ts:1783-1791), never checks commandExists() first. The UI (ui/acp-connections.tsx:16-17, 56) shows the error text as-is in role=alert.
Run dispatch is not affected: server.ts:670 checks adapter.available (commandExists) and gives the friendly "not installed or not on PATH" message. The gap is limited to Check connection and cata …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/process.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/acp.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/acp.test.ts`

**Suggested fix:** Record spawn failures separately from exits and describe them:
1. In process.ts, add `spawnError?: string` (the errno code) to ProcessOutcome. In the child 'error' handler, set it from (err as NodeJS.ErrnoException).code, and still append err.message to stderr so the existing tail behaviour is unchanged.
2. In describeFailure(), before the "exited with code" line, handle the spawn cases:
   - spawnError === "ENOENT": "<name> could not start: `<command>` was not found on this computer's PATH. Install it or enter its absolute path." For an absolute path, say "was not found at <path>" instead. This needs the command, so either pass it as an optional third argument or keep it on the outcome.
   - spawnError === "EACCES": "`<command>` is not executable. Check its permissions or choose the CLI's executable."
   - Any other spawn error: "<name> could not start: <message>". Never "exited with code null".
3. In acp.ts:35-37, give these failures a specific errorKind, either "cli_incompatible" or …

**Suggested regression test:** Add to test/acp.test.ts:
test("a missing or non-executable ACP command explains how to fix it"). It should:
- call probeAcp({ id: "acp:missing", name: "Missing ACP", command: "definitely-not-installed-acp-" + Date.now(), args: [], enabled: true });
- assert.rejects with a message matching /not found on this computer's PATH/ and /absolute path/, and doesNotMatch /exited with code null/ or /ENOENT/;
- run the same with an absolute non-existent path (join(home, "nope")) and with a chmod 0o644 file  …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server ("qa-server.sh start v4617 4617 fake"). Then I ran /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617/missing-exe.mjs in a fresh headless Chrome with no profile. It opened http://127.0.0.1:4617/#/settings/agents and used the "ACP connections" region. The log is /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617/missing-exe.log.
(1) Add compatible CLI with ID "missing", name "My Agent", executable "definitely-not-installed-acp" and argument "acp", then Check connection. Within 78 ms the role=alert showed "My Agent exited with code null: spawn definitely-not-installed-acp ENOENT".
(2) Executable set to the absolute path "/opt/nowhere/my-agent", which does not exist: "My Agent exited with code null: spawn /opt/nowhere/my-agent ENOENT".
(3) Executable set to an existing file without the execute bit: "My Agent exited with code null: spawn <path>/not-executable.sh EACCES".
(4) Connect OpenCode preset (opencode / acp) with the executable changed to "opencode-not-installed": "OpenCode exited with code null: spawn opencode-not-installed ENOENT". Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4617/002-preset-missing-name.png.
(5) A direct POST to /api/acp-connections/check returned 400 {"error":"X Agent exited with code null: spawn definitely-not-installed-acp ENOENT"}.
Nothing was saved. The only console errors were the expected 400 responses.

Why I could not refute it:
- It is not caused by the environment or the script: the reporter's selectors and executable value are correct, a fresh browser behaves the same, and the result does not depend on fake or real mode, because the failure is Node's spawn error before any agent runs.
- It is not by design: docs/acp-agents.md step 2 says "If code-flow cannot find it, enter its absolute executable path", and the "Other compatible CLIs" section says "Executables must be names on the server's PATH or absolute paths". Both imply the check tells the user when it cannot find the executable. No code comment says the raw error is intended.
- The rest of the app already uses friendly wording for missing CLIs, for example server.ts:670/716 "`X` (`bin`) is not installed or not on PATH" and checks.ts:204 "Docker isn't installed or not on PATH".

Severity s …

</details>

### t23-6 · minor · Extensions panel says 'No extensions configured' when extensions are deferred by a policy or the config is invalid

Source: tester unit infra-platform-memory-ml-insights-1; observed with fake-agents; features PLAT-01.

**Repro**

> A: Apply a custom filesystem restriction, then restart with CODEFLOW_EXTENSIONS_FILE set to a valid config → Settings → Extensions.
> B: Restart with CODEFLOW_EXTENSIONS_FILE pointing to a config with an invalid id ('Bad_ID') → Settings → Extensions.

**Expected:** The panel should say the configured extensions are deferred by the filesystem policy, or that the configuration could not be loaded, and give the reason.

**Actual:** Both cases show 'Host extension API 1.0 · No extensions configured.' The only signals are a server log line (B) or nothing visible at all (A).

**Root cause (verifier):** src/extensions.ts:60-63 (Extensions.load): config-level failures throw before any ExtensionStatus is pushed, so this.statuses stays []. These include two sources set, a relative path, a readBundle error, more than 128 KiB, a JSON.parse error, and parseManifests rejecting e.g. id "Bad_ID" at src/extensions.ts:41-48. Only per-bundle failures after parsing (lines 65-90) produce a "rejected" status. src/server.ts:2747 catches that throw and only calls logError (stderr plus server.log). src/server.ts:2748 skips load() entirely when fileAccess.hasRestrictions() and only calls logWarn, which writes to the home's server.log and not to stderr. Neither path records anything that the Extensions instance or /api/extensions exposes. src/server.ts:1781 returns { api, extensions: extensions.list() } with no configured/deferred/error field. ui/extensions.tsx:12 renders "No extensions configured." whenever status.extensions.length is 0, so "no config", "config invalid" and "deferred by policy" all look the same. The panel has no data that could tell them apart.

**Files:** `src/extensions.ts`, `src/server.ts`, `ui/extensions.tsx`, `test/extensions.test.ts`, `docs/extensions.md`

**Suggested fix:** 1. Give Extensions a top-level load state:
   - `source?: "file" | "json"`, plus `state: "none" | "loaded" | "deferred" | "error"` and `error?: string`. Bound the error to about 1000 chars and pass it through redactExport, like the per-bundle errors.
   - load() sets "none" when neither env var is set. Wrap the config-level steps (source choice, read, size, JSON.parse, parseManifests) in a try that records state "error" with the message, then rethrow or return as now.
   - Add a defer(reason) method, called from src/server.ts:2748 instead of only logging. It records state "deferred" only when CODEFLOW_EXTENSIONS_FILE or CODEFLOW_EXTENSIONS_JSON is actually set, so an unconfigured restricted server still shows "none". Keep the reason short, e.g. "A custom filesystem policy is active; clear it and restart to load extensions".
2. Expose it: GET /api/extensions (src/server.ts:1781) returns { api, configuration: { state, source?, error? }, extensions }. Never include the path or document, a …

**Suggested regression test:** In test/extensions.test.ts:
- Invalid id ("Bad_ID", plus the existing undefined and array cases): after `await assert.rejects(loader.load(), /Invalid extension identity/)` (or a non-throwing load, if the API changes), assert that the load-state accessor returns { state: "error", error: /Invalid extension identity/ } and that list() is still [].
- JSON source with malformed JSON: expect state "error".
- No env vars: expect state "none".
- With CODEFLOW_EXTENSIONS_JSON set, calling defer("...") wi …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4617t236" on 127.0.0.1:4617 with a brand-new home. Fixture: a self-contained provider-only bundle /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4617t236/qa-fixture.mjs, with two configs in the same folder: valid.json (correct sha256) and invalid.json (same entry but id "Bad_ID"). Each step opened Settings and clicked Extensions in headless Chrome using script ext.mjs.
0) Control: started with CODEFLOW_EXTENSIONS_FILE=valid.json. The panel shows "qa-fixture 1.0.0 · Loaded · plugin:qa-fixture/local", so the fixture and config are valid.
B) Restarted with CODEFLOW_EXTENSIONS_FILE=invalid.json. The panel reads "Host extension API 1.0 / No extensions configured." and GET /api/extensions returns {"api":{"major":1,"minor":0},"extensions":[]}. The only signal is a stderr line: "Extension configuration could not be loaded; built-in workflows remain available: Invalid extension identity, pinned bundle, version or capability requirements". Screenshot: shots/v4617t236/001-b-invalid-config.png.
A) Restarted with no extension env. In Settings → Projects → MQTT-MCP → Filesystem policy I set Read deny = "secrets" and clicked "Stop execution and apply policy" (revision 1 applied). Then I restarted with CODEFLOW_EXTENSIONS_FILE=valid.json. The panel again reads "No extensions configured." and the API returns extensions:[]. Nothing reaches server.out (stderr). The only trace is a JSON line in the home's server.log: {"level":"warn","message":"Extensions deferred: custom filesystem policy cannot isolate trusted plugin initialization; ..."}. Screenshot: shots/v4617t236/001-a-deferred-by-policy.png.
Control 2: cleared the policy through the UI (revision 2) and restarted with the same valid.json. The extension shows Loaded again, so the policy deferral was the only cause in A.
Ruled out:
- By design: docs/extensions.md says "Settings → Extensions reports loaded/rejected bundles" and that GET /api/extensions returns "status ... with bounded redacted error details". Config-level failures and deferral are reported nowhere. The Filesystem policy panel has a general help line ("Extensions are deferred on restricted startup"), but the Extensions panel itself makes a false statement.
- Tester environment: reproduced from a fresh home and a fresh profile, and the valid control loads.
Same code at f14f404 in the dogfood source and in the primary worktree. Server stopped. No runs create …

</details>

### t24-18 · cosmetic · Retrying a run whose extension bundle was rejected only says 'Unknown pattern'

Source: tester unit infra-platform-memory-ml-insights-2; observed with fake-agents; features INFR-GAP-01.

**Repro**

> 1. Run the plugin workflow once (pinned sha A). 2. Edit the bundle without updating its sha256 pin; restart -> Settings shows the extension Rejected. 3. Open the old run and click 'Retry unfinished work'.

**Expected:** The documented guidance: restore the exact reviewed bundle / SHA-256 pin, or create a new run.

**Actual:** Toast/API error 'Unknown pattern "plugin:qa24/workflow"'. The helpful pin message only appears when a different version is loaded.

**Root cause (verifier):** src/engine.ts:5356-5357 (RunManager.resume): `const pattern = this.findPattern(run.pattern); if (!pattern) throw new Error(`Unknown pattern "${run.pattern}"`);` runs before the pin check. The pin check is at src/engine.ts:5366 `await this.assertExecutionAllowed(run.repo, run, "run resume")`, which reaches `assertExtensionBindings(run)` at src/engine.ts:3209.
When an extension is rejected (hash mismatch) or not configured, Extensions.load never registers its workflows. src/server.ts:165 register callback; src/extensions.ts load() throws before register, so findPattern returns undefined and resume stops with the generic message.
The pin-aware messages are never reached:
- src/extensions.ts:20 extensionBindings: 'Restore the pinned extension for <id> before running this workflow' (missing binding)
- src/extensions.ts:25 assertExtensionBindings: '…version changed; restore its exact SHA-256 pin or create a new run' (changed binding)
Those messages only appear when a plugin *provider* is missing behind a built-in pattern, or when a different version of the same workflow is loaded.
src/server.ts:2565-2568 forwards err.message as HTTP 400, and the UI shows it as-is. Related sites give the  …

**Files:** `src/engine.ts`, `src/extensions.ts`, `src/server.ts`, `ui/run-experience.ts`, `test/extensions.test.ts`

**Suggested fix:** In RunManager.resume (src/engine.ts ~5356), when findPattern(run.pattern) misses and the pattern is an extension ID (run.pattern.startsWith("plugin:"), or run.extensions has an entry for that namespace), throw pin-specific guidance instead of the generic error. For example: `This run's workflow extension ${id} ${version} (SHA-256 ${sha.slice(0,12)}…) isn't loaded — Settings → Extensions shows it rejected or missing. Restore the exact reviewed bundle / SHA-256 pin and restart, or create a new run.`
Running `assertExtensionBindings(run)` before the findPattern lookup is a good complement: it is pure and synchronous, and it already covers the rejected case through extensionBindings' 'Restore the pinned extension' error. Do not rely on it alone, because a stale in-process binding would mask the problem.
Reword extensions.ts:20 to add 'or create a new run' so the missing and changed cases give the same documented guidance.
Optionally:
- Give buildStartInput (server.ts:889) and the deferred  …

**Suggested regression test:** In test/extensions.test.ts (fake-bin on PATH as the engine tests do), load a pinned workflow-only bundle with Extensions and start a run of its 'plugin:<id>/workflow' with a role defaulting to 'claude', using a RunManager whose finder knows the pattern. The workflow throws on its first execution, so the run ends 'failed' with run.extensions pinned. Then create a second RunManager on the same CODEFLOW_HOME with a finder that returns undefined for that pattern, which simulates a rejected or remove …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4693-t2418 on port 4693 with a new home. CODEFLOW_EXTENSIONS_FILE pointed at my own bundle, work/v4693-t2418/ext/qa2418.mjs. It is a workflow-only plugin, 'plugin:qa2418/workflow', whose only role defaults to built-in 'claude'. It throws on the keyword PLUGIN-FAIL after one agent turn and a commit. Its manifest pins sha256 b471a8d7ef0e792b6642d645d2d719e6b6a8dddea824ac306d948a1ac7fba7d4. GET /api/extensions reported it as loaded.
1) I created a scratch project (a tiny local git repo in my scratchpad) and started the run via POST /api/runs as a precondition. Run 2610252346-52867728 went to status=failed with error 'QA2418 fixture failed on purpose'. It recorded extensions=[{id:qa2418, version:1.0.0, sha256:b471a8d7...}].
2) I appended a comment line to the bundle without changing the pin and restarted. /api/extensions and Settings → Extensions (fresh headless browser, screenshot 001-rejected-settings.png) showed 'qa2418 1.0.0 Rejected … Plugin bundle changed; review it and update its SHA-256 pin explicitly'.
3) In the UI I opened #/run/2610252346-52867728. The banner 'The run could not finish' offered 'Retry unfinished work', and I clicked it. Network: POST 400 runs/2610252346-52867728/resume {"error":"Unknown pattern \"plugin:qa2418/workflow\""}. That text then showed inline in red under the banner (screenshot shots/v4693-t2418/003-rejected-run-after-retry.png), with no hint about extensions, pins, or creating a new run.
Contrast A: I pinned the edited bundle (sha dae834ed…), restarted, and clicked Retry again. Response: POST 400 {"error":"This run's provider/workflow extension version changed; restore its exact SHA-256 pin or create a new run"}. This is the helpful guidance, and it only appears when a different version is loaded.
Contrast B: I restarted with no extension config at all (/api/extensions → []). curl POST /resume → 400 'Unknown pattern "plugin:qa2418/workflow"'.
Reproduced 2 ways, in the UI and with curl. Not caused by the environment or the reporter's script: I used my own bundle, a fresh home and a fresh browser profile. Not by design: docs/extensions.md says 'Resume or further dispatch refuses a missing or changed pin; restore the exact reviewed bundle or create a fresh run.' The refusal itself is correct and safe; only the guidance is missing. That is why I rate it cosmetic: no data or safety impact, but the message doesn't tell the owner how to recover.

</details>
