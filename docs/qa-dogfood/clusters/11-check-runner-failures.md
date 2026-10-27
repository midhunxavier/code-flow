# Cluster 11 · check-runner-failures

**Check/gate runner: can't-run gates, Docker daemon down, fixed timeouts, malformed package.json**

Status: **independently verified · follow-up fixes integrated into `codex/dogfood-qa-continue`** · 11 issues · branch `qa-fix/check-runner-failures`

Planner notes: Report 'the check could not run' separately from 'the check failed'. t07-3: src/engine.ts:1706 skips checkCanRun when a verification profile is set, so gates that exit 127 use up fix rounds. t07-4/t19-2: runnerMissing in src/checks.ts ignores 'Cannot connect to the Docker daemon', and src/engine.ts picks Docker when only the CLI exists (commandExists is just 'which'). Probe the daemon (src/adapters/process.ts, src/dependency-health.ts). t23-5: detected gates get a fixed 5-minute DEFAULT_CHECK_TIMEOUT (src/verification.ts:50), and a timeout shows as 'Failed' (OPCUA-MCP repro). t03-10: readiness 'Validate commands' hard-codes 120 s. t07-10: the gate timeout label uses the run's timeout. t03-8/t03-9/S11-1: detectCheckCommand calls JSON.parse on package.json unguarded, so /api/check returns 500 and 'Save project defaults' stays disabled for good. t07-9: a reviewer test that was never collected is labelled 'false alarm'. t07-12: invalid CODEFLOW_MAX_AGENTS/CHECKS values are silently ignored (engine.ts:142). Duplicate groups: [["t07-4","t19-2"],["t03-8","t03-9","S11-1"]]

Likely files: `src/engine.ts`, `src/checks.ts`, `src/verification.ts`, `src/readiness.ts`, `src/workspace-api.ts`, `src/adapters/process.ts`, `src/dependency-health.ts`, `src/run-status.ts`, `ui/project-run-settings.tsx`, `ui/workbench.tsx`

## Fix result

Commits:
- `0db32a5` Warn when slot limits from the environment are ignored
- `b97a48d` Keep check detection going past an invalid package.json
- `ba706ce` Treat gates and container checks that can't run here as blocked
- `a03bdff` Report check and gate time limits as they applied
- `1ff2f13` Cover check runner failures in unit, server and browser tests

Fixer notes for the integrator: No existing test files were edited. All new tests are in test/qa-check-runner-failures.test.ts, test/qa-check-runner-failures-server.test.ts and test/e2e/qa-check-runner-failures.e2e.ts.

Shared fixture change: test/fake-docker.mjs now answers `docker info` and `docker version` (prints 27.0.0) and supports FAKE_DOCKER_DOWN=1 (daemon down for info and run) and FAKE_DOCKER_DOWN=run (info works, run fails). Previously those subcommands exited 2 with 'unsupported', and no existing test depended on that.

Behaviour changes worth knowing when merging:
1. The engine now probes the Docker daemon (src/adapters/process.ts dockerStatus) at run start whenever loop.container, agentContainer or a lockdown is involved. Only a positive daemon-unreachable message changes behaviour. An 'unknown' probe result (e.g. other tests' docker shims that don't implement `info`) keeps the old behaviour.
2. UntrustedSourceError takes an optional second argument (dockerStopped).
3. Detected verification gates now default to the run's check timeout (limits.checkTimeoutMin, default 10 minutes) instead of a fixed 5 minutes. runVerification's default suite deadline is now the sum of gate timeouts × repeats, clamped to 15–60 minutes, instead of a flat 15 minutes. This affects both the engine and POST /api/verification.
4. Readiness 'Validate commands' can now hold the single validationSlots slot for up to checkTimeoutMin (10 minutes by default). This is the trade-off the verifier noted. Abort on request close s …

## Independent continuation verification (2026-10-26)

Validation passed: `npx tsc --noEmit`, `git diff --check`, the four original cluster unit/API files (29 tests), the broader check/environment/verification/automation regression group (59 tests, including the new independent cases), and the three Chrome suites together (13 scenarios). The new engine cases also passed separately after strengthening the quoted-argument test.

Verified from integrated commit `dba688d` in `/private/tmp/codeflow-qa-missions`, branch `codex/qa-checks-schedules-verify`. Reviewed the check/gate detection, environment classification, Docker probe, timeout, readiness, command-label and settings changes against their original repros. The original cluster unit/API/browser tests passed on the integrated version.

Independent tests found and repaired three adjacent gaps:

- With two environment-diagnosed required gates, the first missing runner was compared on the base and could set aside the entire run even when the second gate worked on the base and the change broke it. Every blocked required gate is now compared before allowing the run to be set aside. The new regression changes the second gate and verifies a failing verdict and two base comparisons.
- `sameCheckCommand` collapsed whitespace inside quoted strings, so a passing profile gate could hide a different failing primary check. Normalization is limited to the known npm/pnpm/yarn script prefix. A real engine regression now runs both distinct quoted-argument commands and retains the failing primary gate.
- A timeout of 0.025 minutes (1,500 ms) rendered as zero while still being sent as 1,500 ms. The field preserves the exact value, uses the API's one-millisecond minimum, and is wide enough to display ordinary fractional-minute values.

New evidence is in `test/qa-check-runner-independent.test.ts` and `test/e2e/qa-checks-schedules-independent.e2e.ts`. The fresh Chrome suite uses an isolated fake-provider server at 127.0.0.1:4359/4360, temporary home and scratch Git repositories. It verifies the blocked-run page, no paid fix rounds for a missing runner, Docker-down refusal before a run is created, startup warnings for invalid agent/check limits, precise gate timeout editing, and readiness with a real `sleep 125` command under a three-minute configured limit. The readiness command completes and the UI reports ready beyond the old 120-second cap.

Original issue coverage: t07-3 (environment-only and mixed-gate execution), t07-4/t19-2 (Docker unavailable and stopped mid-run, including untrusted-source host confirmation), t23-5/t07-10 (detected limits, per-gate timeout label, editable timeout and cancellation), t03-10 (readiness limits plus the 125-second real command), t03-8/t03-9/S11-1 (invalid JSON fallback and manual project-default recovery), t07-9 (uncollected reviewer evidence remains inconclusive), and t07-12 (one warning for invalid numeric slot settings).

Evidence files: `output/playwright/qa-checks-schedules-independent/` contains screenshots plus browser and server logs; `/private/tmp/codeflow-qa-continue/checks-*.log` contains test transcripts. Fake providers and fake Docker/GitHub were used; no real-agent, Docker-daemon or external-publishing claims. All owned servers and scratch data are removed by teardown. The initial independent browser harness had a collapsed-field selector error and an injected localStorage write on about:blank; those harness problems were corrected without suppressing application console/page errors.

## Issues

### t07-3 · major · Verification-profile gates that can't run (exit 127) spend fix rounds and are reported as failing checks

**Fix outcome: fixed.** src/engine.ts check(): checkCanRun now also runs when a verification profile is set. Its new `evidence` argument is the gate attempt from verification.ts environmentBlock(), which applies when the report is blocked only because every non-passing required gate is diagnosed `environment` and no required gate was skipped (integrity blocks are excluded). That attempt is compared on the base commit, run.checkCantRun is set with the gate command, and check() returns null, so there are no fix rounds, no `failing` verdict, and the label is Blocked. The blocked report stays as evidence. New sameCheckCommand() in verification.ts treats `npm test`, `npm t` and `npm run test` (pnpm and yarn too) as the same check, so engine.ts at the check() site and in checkTaskResolution no longer adds a duplicate `primary-check` gate. docs/patterns.md and docs/verification.md updated.

Fixer's check: QA server f11 (fake agents) on a fresh no-node_modules clone of IndustriAgents-Studio. Started from the composer as Fix & review, once with Lightweight and once with Standard. Lightweight run: Fix the issue, then Check: unit failed (127), then Check on base commit failed, then Review. No 'Fix failing check' rounds. checkCantRun={command:'npm run test', reason:'sh: vitest: command not found'}, verification.state blocked, verdict unset, gates [unit:environment] with no primary-check. Standard run: build and unit both environment, one base comparison, no fix rounds. Run page shows 'Verification needs attention / Fix check command' and 'Checks: Blocked · Review: Approved'. No browser errors or 5 …

Tests: `test/qa-check-runner-failures.test.ts: a verification gate whose runner is missing spends no fix rounds and reads Blocked`, `test/qa-check-runner-failures.test.ts: a gate that couldn't run alongside one that failed is still code to fix`, `test/qa-check-runner-failures.test.ts: the run's npm test and a profile's npm run test are one gate`

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-29, RUN-28.

**Repro**

> 1. Fake server; project = scratch clone of IndustriAgents-Studio (worktrees have no node_modules).
> 2. Composer > Run options > Advanced > Verification gates: 'Lightweight profile' (gate `npm run test`) or 'Standard profile' (`npm run build`, `npm run test`).
> 3. Start 'Fix & review' with any task.

**Expected:** Same as the single-check path: 'The check can't run here: sh: vitest: command not found', compared on the base commit, no 'Fix failing check' rounds, checks 'Blocked', next action 'Verification needs attention' / 'Fix check command'.

**Actual:** The gates are diagnosed 'environment' in Verification evidence ('sh: vitest: command not found', 'sh: next: command not found'), yet the engine runs 'Fix failing check (1/2)' and '(2/2)' agent rounds. Summary: 'Check `npm test` still fails after 2 fix attempts'. Checks label: 'Failed'. Next action: 'Checks need a fix' / 'Request a fix'. A 'primary-check' gate `npm test` is also added next to `npm run test`, so every round runs the same failing suite twice (three times with Standard).

**Root cause (verifier):** 1) src/engine.ts:1706 `if (doneWhen && !this.run.loop.verification && !(await this.checkCanRun(wt, result))) return null;`: when a verification profile is set, the can't-run guard is skipped completely. That means no base-commit comparison, run.checkCantRun is never set, and check() still returns a non-null result. Commit daf3108 added the `!this.run.loop.verification` clause.

2) src/engine.ts:1674 sets the profile result to `ok: verification.state === "verified"`. A state of "blocked" because of environment (src/verification.ts:127, where required gates have diagnosis "environment") therefore looks the same to callers as a real failure.

3) src/patterns/prompts.ts:214 (fixUntilGreen) loops on `check && !check.ok`, so it spends the full `checkFixes` attempts. src/patterns/pipeline.ts:105/171/174 then logs "still fails after N fix attempts", sets verdict "failing" (ctx.hasCheck is still true because checkCantRun was never set; engine.ts:1105) and skips review.

4) src/run-status.ts:12 `if (run.verdict === "failing") return "Failed";` is checked before line 13's verification-state mapping (blocked -> "Blocked"), so the label becomes "Failed". ui/run-experience.ts then shows "Checks  …

**Files:** `src/engine.ts`, `src/patterns/prompts.ts`, `src/patterns/pipeline.ts`, `src/run-status.ts`, `src/verification.ts`, `ui/run-experience.ts`, `ui/composer.tsx`, `test/improvement-engine.test.ts`, `test/run-status.test.ts`

**Suggested fix:** In Engine.check(), after a profile run, check whether the verification is blocked only because of environment: every non-passing required gate has diagnosis "environment", nothing was skipped, and it is not an integrity block. If so, route it through the same can't-run settlement as the single-check path. Concretely: drop the `!this.run.loop.verification` clause at engine.ts:1706, or add a profile-specific branch. Pick the environment-diagnosed gate's attempt (or the primary) as the CheckResult. Run compareWithBase on that gate's command; if it fails the same way on the base commit, set run.checkCantRun, log the "Not spending fix rounds" warning and return null. That way fixUntilGreen/proveOrAsk/pipeline skip fix rounds, hasCheck turns false, no "failing" verdict is set, and checkEvidence tells the reviewer the tests never ran. Keep verification.state "blocked" in the evidence. If the gate runs on base, keep treating it as a failure, since the change broke the environment.

Separately, …

**Suggested regression test:** Add a test to test/improvement-engine.test.ts, next to "required verification gates cannot be hidden by a passing primary check". It starts a RunManager run in a temp git repo whose pattern calls `fixUntilGreen(ctx, { agent: "claude", role: "builder", wt, attempts: 2 })` and then `if (ctx.hasCheck) ctx.setVerdict(...)`. Use loop `{ check: "missing-runner-xyz run", verification: { name: "lightweight", checks: [{ id: "unit", kind: "unit", command: "missing-runner-xyz run", required: true, timeoutM …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server, v4687 on 127.0.0.1:4687. I made a scratch clone of IndustriAgents-Studio (bare clone at qa/clones/v4687-studio.git, working clone at qa/clones/v4687-studio, no node_modules) and added it through the UI with "Open another repository" as project "v4687 Studio". I started every run from the composer UI with Run options > Advanced > workflow "Fix & review" and the task "Add a one-line comment at the top of README.md...". Scripts are in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4687/.

(1) Lightweight profile, run 2610252009-6fb40fa4. The composer said "Required gates: npm run test" and the check field was auto-filled with "npm test". The stored loop was check "npm test" with verification gate unit = "npm run test". Steps were: Fix the issue; Check: unit failed; Check: primary-check failed; Fix failing check (1/2); unit and primary-check failed again; Fix failing check (2/2); unit and primary-check failed again. No review ran. verification.state was "blocked", and both gates had diagnosis "environment" ("sh: vitest: command not found"). verdict was "failing" and checkCantRun was undefined. Summary: "Check `npm test` still fails after 2 fix attempts". The run page showed Checks "Failed", the banner "Finished — but the check still fails", and next action "Checks need a fix ... Request a fix".

(2) Standard profile with check npm test, run 2610252010-4452aae8. Same pattern, but each round ran three gates (build: "sh: next: command not found"; unit and primary-check: vitest not found), plus two fix rounds and verdict failing.

(3) Control: single configured check "npm test" with no profile, run 2610252009-190ac13b. Steps were: Fix the issue; Check failed; Check on base commit failed; Review (round 1). There were no fix rounds. checkCantRun was {command:"npm test", reason:"sh: vitest: command not found"}. The UI showed Checks "Blocked" and next action "Verification needs attention / Fix check command".

(4) Deterministic unit check in my snapshot copy (builds/v4687). This was a temporary test file that I have since removed. It ran a pattern calling fixUntilGreen with loop.check equal to a missing binary. Without a profile: 0 fix rounds, checkCantRun set, checksLabel "Blocked" (pass). With a one-gate profile using the same command, so no primary-check was added: fixRounds 2, verdict failing, state blocked, diag [environment], label "Failed" (fail).  …

</details>

### t07-4 · major · A Docker check with the Docker daemon stopped is treated as a failing check; agents spend fix rounds on it

**Fix outcome: fixed.** src/adapters/process.ts: new dockerStatus() probe (`docker info --format {{.ServerVersion}}`, 5 s timeout) returning running, unreachable, missing or unknown, plus a DOCKER_UNREACHABLE pattern. src/engine.ts start(): an explicit loop.container or agentContainer with an unreachable daemon is rejected early with "Docker isn't running (…). Start Docker and try again." If the probe result is unknown, behaviour is unchanged. src/checks.ts: runCheck marks container results `container: true`, and runnerMissing treats daemon-unreachable output, docker run exit 125 and "Docker isn't installed" as can't-run for container runs only. So cantRunReason, proofOutcome and reproOutcome now return can't-run or unverified, and a daemon that stops mid-run sets the check aside instead of spending fix rounds. test/fake-docker.mjs now answers `info`/`version` and supports FAKE_DOCKER_DOWN=1 or FAKE_DOCKER_DOWN …

Fixer's check: f11 used the real Docker CLI 29.4.3 with Docker Desktop stopped, and fake agents via PATH wrappers. The original POST /api/runs {pattern:fix-review, loop:{check:'true', container:{image:'alpine:3'}}} now returns 400 "Isolation runs checks in a Docker container, but Docker isn't running (Cannot connect to the Docker daemon at unix:///Users/mx/.docker/run/docker.sock. Is the docker daemon running?). Start Docker and try again." The node:22-alpine variant returns the same 400. No run is created and no agent turns are spent. For the mid-run case, f11b ran fake docker with FAKE_DOCKER_DOWN=run: Check failed, then Check on base commit failed, then Review. No fix rounds. checkCantRun reason is the  …

Tests: `test/qa-check-runner-failures.test.ts: a container check that can't reach Docker's daemon is a check that can't run, not a failing one`, `test/qa-check-runner-failures.test.ts: a container run with Docker's daemon stopped doesn't start`, `test/qa-check-runner-failures.test.ts: Docker's daemon stopping during a run sets the check aside instead of spending fix rounds`

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-29.

**Repro**

> 1. Docker CLI installed, Docker Desktop not running.
> 2. Start a server whose PATH has the real docker but fake agents (I used qa-server.sh start t07b 4381 real with PATH=<dir with claude/codex/agy wrappers to the fake agent>:$PATH).
> 3. POST /api/runs {pattern:'fix-review', roles:{builder:['codex'],reviewer:['claude']}, loop:{check:'true', container:{image:'alpine:3'}}} (the container option is only reachable via the API or an inherited loop).
> 4. Wait for the run to finish.

**Expected:** The check is recognised as unable to run here ('Cannot connect to the Docker daemon … Is the docker daemon running?'): CantRunNote, no fix rounds, 'Fix check command'.

**Actual:** 'Check: Failed (exit code 1)' three times with output 'Cannot connect to the Docker daemon at unix:///Users/mx/.docker/run/docker.sock…'. Two 'Fix failing check' agent rounds run. Summary 'Check `true` still fails after 2 fix attempts'. Next action 'Request a fix'.

**Root cause (verifier):** 1. src/checks.ts:367-381, `runnerMissing`. It only returns a reason for exit 127/126 or a few pytest/uv/poetry patterns. The Docker client's "Cannot connect to the Docker daemon … Is the docker daemon running?" exits 1 and matches none of them.

2. src/checks.ts:333-361, `cantRunReason`. It calls runnerMissing, then returns undefined for any command that isn't pytest. So the engine's `checkCanRun` (src/engine.ts:1734-1753) never sets the check aside, never runs it on the base commit (compareWithBase, engine.ts:1756), and never sets run.checkCantRun. The fix-review loop then spends its fix rounds on the error and stops before review with verdict "failing".

3. Contributing causes:
   - src/checks.ts:203-205 (`runCheck`) only turns a spawn ENOENT into "Docker isn't installed". It does not treat a container run's exit 125 (docker's own error), or the daemon-connection messages, as environment failures.
   - src/engine.ts:5153-5155 checks only `commandExists("docker")` at run start, and src/engine.ts:5199-5202 picks Docker for locked-down runs on the same test, so a stopped daemon is accepted.
   - The same gap makes `proofOutcome` and `reproOutcome` (src/checks.ts:389-419, through `in …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/checks.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/fake-docker.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/check-env.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/patterns.md`

**Suggested fix:** 1. In `runnerMissing` (src/checks.ts:367), recognise the Docker client being unable to reach its daemon:
   - /^Cannot connect to the Docker daemon\b/
   - /Is the docker daemon running\?/
   - /permission denied while trying to connect to the Docker daemon/
   - /^(docker: )?error during connect:/ (Windows / npipe)
   Return the first matching line. cantRunReason and inconclusive both call runnerMissing, so this covers the fix loop, the base-commit comparison, proofOutcome and reproOutcome together.

2. In `runCheck` (src/checks.ts:144), when `opts.container` is set:
   - mark the result as a container run (e.g. `container: true` on CheckResult);
   - treat exit 125 (docker's own failure: image not found or pull denied, bad mount) as can't-run in runnerMissing. A plain host check can legitimately exit 125, so key this on the container flag rather than the exit code alone.
   - Optionally prefix the output with a clear line such as "Docker's daemon isn't running or reachable".

3. Opti …

**Suggested regression test:** Both tests go in test/check-env.test.ts.

1. Unit test, alongside the existing cantRunReason asserts at lines 70-87:
   - `assert.equal(cantRunReason(result("Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", 1, "npm test")), "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?")`
   - `assert.equal(proofOutcome(sameResult).status, "unverified")`
   - `assert.equal(reproOutcome(sameResult).status, "unv …

<details><summary>Verifier's independent reproduction</summary>

Environment: Docker CLI 29.4.3 at /usr/local/bin/docker, Docker Desktop not running. Running `docker run --rm --init alpine:3 /bin/sh -c true` by hand prints "Cannot connect to the Docker daemon at unix:///Users/mx/.docker/run/docker.sock. Is the docker daemon running?" and exits 1, not 125 or 127.

Steps:
1. Wrote wrappers in /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4689/agents/{claude,codex,agy} that exec test/fake-agent.mjs by absolute path. Put that folder first on PATH so the real docker stays reachable.
2. Created a throwaway git repo (/private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4689-tiny).
3. Ran `qa-server.sh start v4689 4689 real` on a fresh home with no runs.
4. Sent POST /api/runs with {repo, task:"Add a subtract function to index.js", pattern:"fix-review", roles:{builder:["codex"],reviewer:["claude"]}, loop:{check:"true", container:{image:"alpine:3"}}}. Run id: 2610252008-7949d042.

Result:
- Status done, verdict "failing", checkCantRun undefined, usage.checks=3.
- Steps: "Fix the issue", Check failed, "Fix failing check (1/2)", Check failed, "Fix failing check (2/2)", Check failed. Each check logged "Failed (exit code 1)". The last log line was "The check still fails after 2 fix attempts; stopping before review", so the review never ran.
- Summary: "Check `true` still fails after 2 fix attempts", and "Last failure" shows the Docker daemon message.
- Run page in headless Chrome (screenshot /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4689/001-run-top.png): "Checks need a fix … Request a fix" banner, "Checks: Failed · Review: Not recorded". The page has no "can't run here" text and no "Fix check command" action. No console or 5xx errors.

Direct check of the classifier: importing src/checks.ts read-only and passing that exact output (exit 1) gives cantRunReason=undefined and runnerMissing=undefined. proofOutcome gives status "proven", so a fail-to-pass proof run with the daemon down would also be counted as proof.

Why this is not by design: docs/patterns.md:48-52 says "A check that can't run isn't a failing check … the environment is wrong, not the code", with no fix rounds and a "can't run here" message. A stopped Docker daemon is exactly that kind of environment failure; the docs list only gives examples  …

</details>

### t19-2 · major · Untrusted runs pick Docker when the CLI exists but the daemon is stopped; checks fail and agents waste fix attempts

**Fix outcome: duplicate.** Same root cause as t07-4 (Docker chosen because the CLI exists, without checking the daemon); the fix is in t07-4's commit ba706ce. Specific to this report: the lockdown branch in src/engine.ts start() now picks a container only when dockerStatus() is running or unknown. With the daemon unreachable it falls through to allowUntrusted/lockdownOnHost or to UntrustedSourceError, whose message now says "Docker is installed but isn't running: start it so code-flow can run checks in a container, or confirm…". docs/github.md now reads 'Without Docker installed and running'.

Fixer's check: f11 used the real Docker CLI with the daemon stopped, fake gh, and issue #2 by @mallory (authorAssociation NONE). In the UI: Run actions, Use template…, Fix an issue, issue #2, Done when 'test -f README.md', Start run. POST /api/runs returns 409 confirm=allowUntrusted. The 'Run checks locally?' dialog opens with the new 'Docker is installed but isn't running' text. After 'Run checks' the run has loop.container undefined and lockdownOnHost true, and its checks pass on the host. No 'Fix failing check' steps. The banner says 'checks run on this machine because you allowed it'. The only console entry is the expected 409 of the confirmation flow.

Tests: `test/qa-check-runner-failures.test.ts: an untrusted source asks before running checks here when Docker is installed but stopped`

Source: tester unit github-codehosts-imports-1; observed with fake-agents; features GH-04.

**Repro**

> 1. Docker Desktop installed but not running (this machine). Start a QA server whose PATH has fake gh + fake agents and /usr/local/bin (real docker CLI), e.g. PATH=<dir with fake gh/claude/codex>:/usr/local/bin:/usr/bin:/bin.
> 2. Use template 'Fix an issue' on an issue by a non-member (authorAssociation NONE) or 'Fix failing CI' on a fork PR; Done when 'test -f README.md'; Start run.

**Expected:** No container is chosen when the daemon is unreachable: the start asks 'Run checks locally?' (as when docker is absent) or fails early with 'Docker isn't running'.

**Actual:** No confirm dialog; run starts with loop.container node:22 network false; every check step fails 'Cannot connect to the Docker daemon at unix:///Users/mx/.docker/run/docker.sock. Is the docker daemon running?', the builder makes 2 'Fix failing check' attempts, result card 'Checks need a fix · Request a fix'. Runs t19b 2610251625-1ef6415d (issue #2) and 2610251725-05e2476a (fork PR #102).

**Root cause (verifier):** The engine checks only that the docker binary is on PATH, never that the daemon is reachable.

- **src/adapters/process.ts:480-487:** `commandExists()` only runs `which <binary>`.
- **src/engine.ts:5199, the reported path:** `} else if (await commandExists("docker")) { loop.container = { image: config.image ?? "node:22", network: false }; }`. A locked-down run (untrusted issue author or fork PR) picks a container whenever the CLI is installed. It never reaches the `allowUntrusted`/`lockdownOnHost` branch or the `throw new UntrustedSourceError(lockdown)` at :5203-5204. That error is what makes ui/composer.tsx:445-452 (`postConfirmed`) show the "Run checks locally?" dialog.
- **src/checks.ts:151:** each check then runs `docker run …` (dockerArgs, checks.ts:112). The daemon-connection error comes back as an ordinary failed check. The fix-review loop then sends the builder "Fix failing check (1/2)" and "(2/2)" with the daemon message as the failure, and the run ends with verdict "failing" ("Checks need a fix · Request a fix").
- **src/engine.ts:5153, same flaw:** an explicit `loop.container` (automations' "Run checks and setup in a Docker container") also checks only the binary. Its er …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/adapters/process.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/dependency-health.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/checks.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/fake-docker.mjs`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/github.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/github.md`

**Suggested fix:** 1. **Add a daemon probe.** Put a bounded `dockerStatus()` next to `commandExists` in src/adapters/process.ts:
   - It returns `{ installed, running, detail }`.
   - It runs `docker info --format {{.ServerVersion}}` with childEnv() and a 5 s timeout, and accepts `/^\d+\.\d+/` the way dependency-health.ts does.
   - Make dependency-health.ts reuse it.
   - Optionally cache a positive result for a few seconds so a sweep doesn't run the probe 25 times.

2. **Use it for the lockdown choice (engine.ts:5199).** Pick a container only when `running` is true. Otherwise fall through to the existing branches:
   - `allowUntrusted` / `lockdownOnHost` (run on the host only if the user confirmed)
   - `UntrustedSourceError` when there is a check or setup command

   The composer's "Run checks locally?" dialog then works as documented, and automations and sweeps (which never pass allowUntrusted) stop with a clear error instead of burning agent turns. Give `UntrustedSourceError` a reason so its text sa …

**Suggested regression test:** test/github.test.ts: add a test next to "without Docker, an untrusted source's checks only run on this machine if you confirm" (~line 377), titled "with Docker installed but its daemon stopped, an untrusted source still asks before running checks here".

Setup:
- Build the same restricted PATH: fake agents, fake gh, linked git/which/sh/env/ps/uname.
- Add a `docker` wrapper running test/fake-docker.mjs with FAKE_DOCKER_DOWN=1.

Assertions:
- For issue #6 (mallory, NONE) with loop.check "true", ` …

<details><summary>Verifier's independent reproduction</summary>

Fresh QA home "v4635-dk" on port 4635. Docker Desktop is installed but stopped: `docker info` prints "Cannot connect to the Docker daemon at unix:///Users/mx/.docker/run/docker.sock. Is the docker daemon running?".

Setup:
- The standard fake mode puts test/fake-bin first on PATH, and that includes a fake docker that hides this bug. So I made /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4635-dk/bin with wrappers for fake claude, codex, agy, gh and tailscale, but no docker.
- Started the server with PATH=<that bin>:/usr/local/bin:/usr/bin:/bin (the real docker CLI is /usr/local/bin/docker) and FAKE_GH_STATE set to a state file with:
  - issue #2 by @mallory, authorAssociation NONE
  - PR #102 from a fork (isCrossRepository true, CONTRIBUTOR, head fork-fix pushed to refs/pull/102/head)
- Made a scratch repo plus a bare origin under qa/clones/v4635-dk-scratch. It holds README.md and package.json.
- The app's own GET /api/doctor/dependencies on this server reported docker {installed:true, ready:false, detail:"Docker is installed, but its daemon is unavailable or access is denied."}.

Run 1, all through the UI:
1. Open another repository → scratch clone → Create project.
2. Run actions ⋯ → Use template… → "Fix an issue" → issue #2.
3. Run options → "Done when this passes" = `test -f README.md` → Start run.
4. Result: POST /api/runs returned 201 straight away and no "Run checks locally?" dialog opened.
5. Run 2610252254-511f7fe8:
   - lockdown "Issue #2 comes from @mallory, who isn't one of its maintainers (none)", trust safe
   - loop.container {image:"node:22", network:false}
   - steps: Fix the issue (done), Check failed, Fix failing check 1/2, Check failed, Fix failing check 2/2, Check failed
   - all 3 check results: "Cannot connect to the Docker daemon at unix:///Users/mx/.docker/run/docker.sock. Is the docker daemon running?"
   - verdict "failing"
   - UI card: "Checks need a fix … Request a fix". The banner still says "checks run in Docker without network".

Run 2 (2610252255-fa4d3847): template "Fix failing CI" on fork PR #102, same check. Same result: no dialog, lockdown "Pull request #102 comes from @forker, from a fork", container node:22 with network false, 3 failed checks with the daemon error, 2 wasted fix attempts.

I could not refute it:
- **Not by design:**
  - docs/github.md:122 says "Without Docker, code-flow asks before running that person's tests on your machine" …

</details>

### t23-5 · major · Repository verification cannot verify OPCUA-MCP: detected gate has a fixed 5-minute timeout, and a timeout is shown as 'Failed'

**Fix outcome: fixed.** src/verification.ts detectVerificationProfile: detected gates use the repo's limits.checkTimeoutMin from .codeflow/config.json (default 10 minutes, the same as runs), capped at 30 minutes, instead of a fixed 5 minutes. runVerification: when no deadline is passed, the suite deadline is the sum of gate timeouts × repeats, at least 15 minutes and at most 1 hour, so a 30-minute gate gets its full 30 minutes through POST /api/verification. diagnoseChecks: when every attempt timed out, the reason is "Timed out after N before the check finished. If it's only slow, raise this gate's timeout (at most 30 min)." (`regression` plus that reason when the baseline passed). The Markdown report shows 'failed (timed out)'. ui/workbench.tsx: each gate has a 'Timeout (min)' input, the badge reads 'Timed out' with the reason under it, and a running verification shows elapsed time with a 'Cancel verification' …

Fixer's check: f11 on a fresh OPCUA-MCP clone, Repository tools > Verification > Detect checks. The unit gate 'cd tests && uv run --no-sync pytest -q' with setup 'uv sync --all-packages' now shows Timeout (min) 10. The page shows 'Running verification · N s so far' with Cancel, updating each minute. With a 0.25-minute timeout (body timeoutMs 15000) the result is a 'Timed out' badge with reason 'Timed out after 15 s before the check finished…'. Cancel after 5 s shows the toast, leaves no result, and leaves no uv or pytest processes behind. At the default 10 minutes (machine loaded by parallel test suites) the gate timed out at 10 min with the timeout reason, not a bare 'Failed'. Set to 20 minutes (body time …

Tests: `test/qa-check-runner-failures.test.ts: a gate its timeout stopped says so, and the label gives the limit that applied`, `test/qa-check-runner-failures.test.ts: a 30-minute gate gets its 30 minutes when no deadline is given`, `test/qa-check-runner-failures.test.ts: detected gates get the repository's check timeout`, `test/e2e/qa-check-runner-failures.e2e.ts: verification shows and edits each gate's timeout, reports a timeout as one, and can be cancelled`

Source: tester unit infra-platform-memory-ml-insights-1; observed with real-agents; features PLAT-14.

**Repro**

> 1. Project for an OPCUA-MCP scratch clone → Repository tools → Verification → Detect checks. Result: unit = 'cd tests && uv run --no-sync pytest -q', setup 'uv sync --all-packages'.
> 2. Run verification with 1 attempt and no baseline.
> 3. The page shows only 'Working…' for about 5 minutes, with no progress and no cancel.

**Expected:** The gate timeout should be visible and adjustable (the API allows up to 30 min), and a timeout should be labelled as a timeout or environment problem.

**Actual:** After 302 s: 'Result: needs-changes', unit = 'Failed', output ends with '[timed out after 300s]' at about 10% of the suite. The UI has no timeout field and no import for an edited profile, so this repository can never pass. With 2 attempts plus a baseline the UI sat at 'Working…' for over 10 minutes.

**Root cause (verifier):** Several defects combine.

1. Detected gates get a fixed timeout. src/verification.ts:50 sets DEFAULT_CHECK_TIMEOUT = 5 * 60_000, and every detected gate gets it: line 103 for package.json scripts, line 108 for detectCheckCommand results such as the uv/pytest check. Detection never reads .codeflow/config.json limits.checkTimeoutMin (src/repo-config.ts:34), unlike the run engine (src/engine.ts:1651, 2140).

2. The UI cannot change it. ui/workbench.tsx:93 renders only command and Required per gate; there is no timeoutMs input. ui/workbench.tsx:94 hard-codes timeoutMs: 300000 for custom gates. There is 'Export profile' (line 99) but no import, so an edited profile with a longer timeout can only be sent by calling the API directly (docs/verification.md: 'Export the report or profile for reuse through the API').

3. The API caps the gate lower than documented. src/workspace-api.ts:77 calls runVerification(path, profile, { signal, repeats, baseline, execute }) with no timeoutMs, so src/verification.ts:151 applies a 15-minute suite deadline and line 165 clamps each gate to min(check.timeoutMs, remaining). The effective per-gate maximum is 15 minutes, while docs/verification.md says '30 min …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/workbench.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/verification.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/workspace-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/verification.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/verification.test.ts`

**Suggested fix:** 1. In ui/workbench.tsx, add a per-gate 'Timeout (min)' number input (1–30, default from check.timeoutMs) next to Required. Add an 'Import profile' file input that parses the JSON, validates it on the server (or by posting it) and sets profile and setup. Show the effective timeout in the help text ('Each gate stops after N min').

2. In src/workspace-api.ts, accept an optional body.timeoutMs suite deadline (bounded to one hour) and pass it to runVerification. Otherwise derive the deadline from the profile, for example sum(check.timeoutMs × repeats), capped at one hour. Then a 30-minute gate is honoured as documented. Consider making the setup bound configurable too.

3. In detectVerificationProfile (src/verification.ts:103/108), use the repository's .codeflow/config.json limits.checkTimeoutMin, and its check and setup, when present, before falling back to 5 minutes.

4. In diagnoseChecks, when every failing attempt timedOut, return a distinct, explained result. Either add a 'timed-out'  …

**Suggested regression test:** test/verification.test.ts:
(a) diagnoseChecks([{ ok:false, timedOut:true, exitCode:null, output:'[timed out after 300s]' }]) returns a timeout-specific diagnosis or reason (assert.match(reason, /timed out/i)), and resultState does not produce plain 'needs-changes' with no reason.
(b) A server-API test (POST /api/verification with an execute stub, or a runVerification call mirroring workspace-api) where a profile gate has timeoutMs 30*60_000 asserts that the timeoutMs passed to execute equals 1_8 …

<details><summary>Verifier's independent reproduction</summary>

Fresh QA server v4615t235 on port 4615 (fake mode; verification runs no agents). I made a fresh scratch clone of OPCUA-MCP (bare clone plus working clone under qa/clones/v4615t235-opcua, at 8f33f52) and added it through the UI (Settings, Manage projects, New project). Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4615t235/ver.mjs.

1. Repository tools, Verification, Detect checks. The UI showed 'Detected from tests/pyproject.toml and uv.lock (a uv workspace)'. unit = 'cd tests && uv run --no-sync pytest -q', setup = 'uv sync --all-packages'. The card's only controls are the profile select, the command input, the Required checkbox, Commit/branch, Compare baseline, Attempts and Setup. There is no timeout control and no import control (0 matches for each).
2. Ran with 1 attempt and no baseline. At 20 s the page showed only 'Working…'. Run verification was disabled and there was no cancel or stop button (screenshot 003-working-20s.png).
3. After 303 s: 'Result: needs-changes', unit = 'Failed'. The POST /api/verification response gave check timeoutMs 300000, diagnosis 'failed', reason undefined, attempt timedOut=true, durationMs 300009. The output stopped at about 10% with '[timed out after 300s]', the same point as in the reporter's log. Screenshots are in qa/shots/v4615t235/ (005-result.png, 006-result-expanded.png). Log: qa/work/v4615t235/ver.log.

Checks to try to refute the report:
(a) I ran the same suite outside CodeFlow in the same clone (own process group, stdin ignored, CI=1): it was at 13% after 420 s. Run uncapped, it finished in 525.8 s (8 min 45 s): '1 failed, 2957 passed, 406 skipped'. So the suite really takes about 9 minutes; the timeout is not caused by CodeFlow's environment. The slowest tests are the secure-connection and resilience e2e tests at about 15 to 47 s each. CONTRIBUTING's '~50s' is out of date.
(b) The one failure is unit/test_contract_codegen.py::test_differential_property_corpus..., 'Build the Node server before running contract differential checks'. So even with a long enough timeout, the detected profile cannot pass this repo: it would also need an npm build in setup. That part is the repo's own requirement, not this bug.
(c) The API accepts check timeoutMs=1800000 and rejects 1800001 with 'Check timeout must be between 1 ms and 1800000 ms'.
(d) In the snapshot build, a probe calling runVerification without opts.timeoutMs (as workspace-api doe …

</details>

### t07-10 · minor · Verification gate timeout is labelled with the run's check timeout ('Timed out after 10 min' after 5 minutes)

**Fix outcome: fixed.** src/engine.ts command() (now split into commandStep): the effective limit `limitMs = timeoutMs ?? timerMs(checkTimeoutMin*60_000, 1_000)` is computed once, passed to runCheck, and used for the label 'Timed out after ${formatTimeout(limitMs)}'. formatTimeout is new in src/checks.ts. A gate's own timeout, a gate cut short by the suite deadline, and a clamped run limit therefore all show the limit that actually applied.

Fixer's check: Ran the verifier's fast repro on f11b: a slowgate repo (test script sleeps 30 s), fix-review, loop {check:'npm run test', checkTimeoutMin:2, verification gate unit timeoutMs 5000}. Steps s2, s4 and s6 'Check: unit' each read 'Timed out after 5 s' (previously 'Timed out after 2 min'), and the gate reason says 'Timed out after 5 s before the check finished…'. The run page shows the same label. The Fix failing check rounds after a timeout are normal Fix & review behaviour.

Tests: `test/qa-check-runner-failures.test.ts: a timed-out step says the limit that stopped it: the gate's own, or the clamped run limit`

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-30.

**Repro**

> 1. Fake server; OPCUA scratch clone (detected gate `cd tests && uv run --no-sync pytest -q`, setup `uv sync --all-packages`).
> 2. Choose 'Lightweight profile' and start 'Fix & review'.
> 3. The real pytest suite runs longer than the 5-minute gate timeout.

**Expected:** 'Timed out after 5 min' (the gate's timeoutMs 300000).

**Actual:** Every 'Check: unit' step lasted exactly 300s but says 'Timed out after 10 min' (loop.checkTimeoutMin). The timeout is also fed to 2 'Fix failing check' rounds.

**Root cause (verifier):** The step label uses the run-level timeout instead of the timeout that was actually applied.

- src/engine.ts:2140: command() runs `runCheck(wt.path, command, { timeoutMs: timeoutMs ?? timerMs(this.run.loop.checkTimeoutMin * 60_000, 1_000), ... })`. When a verification gate calls it (src/engine.ts:1661 passes opts.timeoutMs, which is min(gate.timeoutMs, remaining suite deadline) from src/verification.ts:165), the effective timeout is the gate's, e.g. 300000 ms.
- src/engine.ts:2161-2162: the step's finalText and status event always say `Timed out after ${this.run.loop.checkTimeoutMin} min` (default 10, from src/run-projection.ts:7). It ignores the timeoutMs argument, so any gate-specific timeout, or a gate cut short by the 15-min suite deadline, gets a wrong label.

The same line also mislabels a plain check when checkTimeoutMin is clamped by timerMs(..., 1_000). For example, with checkTimeoutMin 0.01 the label says "0.01 min" but the real timeout is 1s.

The label also points users the wrong way. Raising limits.checkTimeoutMin, which the label suggests, does not change a detected gate's 5-minute timeout.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/integration-audit-engine.test.ts`

**Suggested fix:** In Engine.command() (src/engine.ts around line 2130), work out the effective timeout once, before the try block:

`const effectiveTimeoutMs = timeoutMs ?? timerMs(this.run.loop.checkTimeoutMin * 60_000, 1_000);`

Then:
- Pass it to runCheck.
- Build the label from it, for example `Timed out after ${formatTimeout(effectiveTimeoutMs)}`. formatTimeout is a small helper: under 60s it prints whole seconds ("5 s"), otherwise minutes, rounded or with one decimal place ("5 min", "4.5 min").

That way gate timeouts, suite-deadline-trimmed gates and clamped plain checks all show the timeout that was really applied. It also matches the "[timed out after Ns]" text that runCheck already adds to the output.

Optional follow-ups (separate issues):
1. Show the gate timeout in the composer's "Required gates" help, or let it follow limits.checkTimeoutMin.
2. Stop adding a duplicate "primary-check" when loop.check ("npm test") and the detected gate ("npm run test") run the same script.

**Suggested regression test:** Add a test to test/integration-audit-engine.test.ts. That file already starts runs with loop.verification through manager.start.

1. Start a solo run with loop { check: "sleep 5", checkTimeoutMin: 10, verification: { name: "Gate", checks: [{ id: "unit", kind: "unit", command: "sleep 5", required: true, timeoutMs: 1000 }] } } and wait until it is idle.
2. Find the step where kind === "check" and title is "Check: unit". Assert finalText matches /Timed out after 1 s/ and does not match /10 min/.
3. …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server named v4605t0710 on port 4605, with a new home under scratchpad/qa/homes/v4605t0710. I also made a tiny scratch repo of my own (clones/v4605-slowgate). Its package.json has the script "test": "echo 'running slow suite'; sleep 420; echo 'done'". That rules out OPCUA, uv, pytest and anything else in the tester's setup.

Repro 1 (UI, matches the report):
- Added the repo with "Open another repository" and created the project "slowgate".
- In Run options I chose workflow "Fix & review" and set Verification gates to "Lightweight profile". The composer showed "Required gates: npm run test".
- Started the run 2610252015-4075531c.
- The server recorded loop.checkTimeoutMin=10 and verification.checks[0] = {id:"unit", command:"npm run test", timeoutMs:300000}.
- At 300s, step s2 "Check: unit" failed. Events in the run jsonl:
  - tool_result output ends with "[timed out after 300s]" (correct)
  - status / step.finalText is "Timed out after 10 min" (wrong)
- The run page (screenshot shots/v4605t0710/002-a-timedout.png) shows "Check: unit · Timed out after 10 min · 5m 0s". The label contradicts the duration next to it.

Repro 2 (fast; the run was started over the API, which only set up a custom gate timeout):
- Same project and pattern, with loop {check:"npm run test", checkTimeoutMin:2, verification:{checks:[{id:"unit", command:"npm run test", timeoutMs:5000}]}}. Run 2610252025-0cc8152a.
- s2, s4 and s6 "Check: unit" each failed after 5s, labelled "Timed out after 2 min", with "Fix failing check (1/2)" and "(2/2)" in between. This is the same shape the reporter saw: 3 checks and 2 fix rounds.
- So the label always shows the run's checkTimeoutMin, never the gate's timeout.

Why it is not by design or an environment problem:
- docs/api.md:91 says a gate's timeoutMs defaults to five minutes (DEFAULT_CHECK_TIMEOUT in src/verification.ts:50).
- runCheck's own output gives the right value. Only the engine's label is wrong.

About "fed to 2 Fix failing check rounds": the fixer prompt (checkSection in src/patterns/prompts.ts:62-65) only says "timed out" plus the output "[timed out after Ns]", which is correct. The wrong label is not passed to agents. The fix rounds after a timed-out gate are normal Fix & review behaviour.

Side observation (separate issue, not this bug): on a package.json repo the Lightweight gate is "npm run test" but loop.check is "npm test". The engine (src/engine.ts:1651) therefore adds a second "primary-check" gate w …

</details>

### t03-10 · minor · Repository readiness 'Validate commands' times out every command after 120 s, regardless of the repo's check timeout

**Fix outcome: fixed.** src/readiness.ts inspectReadiness: Validate commands runs setup and the check with the timeout runs use, timerMs((config.limits.checkTimeoutMin ?? DEFAULT_LOOP.checkTimeoutMin) * 60_000, 1_000), instead of a fixed 120 s. A timed-out item says 'Timed out after N, the limit a run gives it (limits.checkTimeoutMin…)'. The response includes checkTimeoutMin. docs/getting-started.md updated.

Fixer's check: f11 with a scratch repo whose .codeflow/config.json is {check:'sleep 125; echo ok', limits:{checkTimeoutMin:10}}. Composer > Run options > Repository readiness > Validate commands took 125.7 s. Check execution passed with 'ok', and the summary reads 'Commands validated · ready'. Previously it failed with '[timed out after 120s]'. checkTimeoutMin is 10 in the response. No browser errors.

Tests: `test/qa-check-runner-failures.test.ts: readiness validation times commands out at the repository's check timeout, not 120 s`

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-28.

**Repro**

> 1. OPCUA-MCP scratch clone (no config): New run > Run options > Repository readiness > Validate commands (setup 'uv sync --all-packages', check 'cd tests && uv run --no-sync pytest -q').
> 2. Wait about 2 minutes.
> Alternative: set the check to 'sleep 125; echo ok' and Validate.

**Expected:** The check is validated with the same timeout a run would use (limits.checkTimeoutMin, default 10 min), or the UI says validation is capped at 2 minutes.

**Actual:** 'Commands validated · needs attention', Check execution Failed '…[timed out after 120s]', although the suite passes in a run. Reproduced twice.

**Root cause (verifier):** src/readiness.ts:39: `const result = await runCheck(path, command, { timeoutMs: 120_000, signal: input.signal });` hard-codes 120 s for both the setup and the check command during "Validate commands". It ignores `config.limits?.checkTimeoutMin`, even though `inspectReadiness` already loads that config at src/readiness.ts:20 via readRepoConfig, parsed at src/repo-config.ts:62. It also ignores the run default `DEFAULT_LOOP.checkTimeoutMin = 10` (src/run-projection.ts:7).
Runs instead resolve the limit at src/engine.ts:5122 (config.limits.checkTimeoutMin merged into loop) and src/engine.ts:5149 (default 10). They then execute both setup and check with `timeoutMs ?? timerMs(this.run.loop.checkTimeoutMin * 60_000, 1_000)` at src/engine.ts:2140, so a run and its own preflight disagree.
Nothing documents the cap. There is no code comment, and docs/getting-started.md:88 and docs/api.md:28 describe Validate commands as running setup and the check "so you can resolve setup failures before spending agent calls". The UI help text (ui/onboarding.tsx:60) mentions no limit either. The timeout message comes from src/checks.ts:199. The client sends no timeout field: ui/onboarding.tsx:51 posts {repo …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/readiness.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/workspace-api.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/onboarding.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/api.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/docs/getting-started.md`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/readiness.test.ts`

**Suggested fix:** In inspectReadiness, compute the timeout the same way a run does: `const minutes = input.checkTimeoutMin ?? config.limits?.checkTimeoutMin ?? DEFAULT_LOOP.checkTimeoutMin;` then `timeoutMs = timerMs(minutes * 60_000, 1_000)`. Use it for both setup-run and check-run, since runs use the same limit for setup at engine.ts:2140. Return the effective value in the report, for example `checkTimeoutMin`, and put it in the detail text of a timed-out item ("timed out after 10 min (limits.checkTimeoutMin)").
Optionally add a `checkTimeoutMin` field to ReadinessInput and to the POST /api/readiness body, validated like server.ts:853 (number 1–120). That way a per-run override from the composer or API gets the same limit, and docs/api.md:28 should list it.
Trade-off: validationSlots is a single global slot (readiness.ts:14), shared with merge-validation and checkpoint-review through inTemporaryWorktree. A 10-minute validation can therefore queue those operations. Abort on request close is already wir …

**Suggested regression test:** test/readiness.test.ts: create a temp git repo with .codeflow/config.json {"check":"node -e \"setTimeout(()=>console.log('ok'),1500)\"","limits":{"checkTimeoutMin":0.05}} and call inspectReadiness({repo, execute:true}). Assert that the check-run item fails with a timeout of about 3 s (the configured value, not 120 s). Run it again with limits.checkTimeoutMin set to 1 and assert that check-run passes. A third case with no config should assert that the effective timeout reported in the result equa …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server v4653 on 127.0.0.1:4653 with a fresh home and browser profile v4653. I made a scratch git repo at /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4653-slowcheck. Its .codeflow/config.json is {"check":"sleep 125; echo ok","limits":{"checkTimeoutMin":10}}, so the repo explicitly sets a 10-minute timeout, which is stronger than the reporter's no-config case. I added the repo through the UI ("Open another repository", Create project "v4653-slow").
(1) Validation, script work/v4653/validate.mjs: New run > Run options. "Done when this passes" was prefilled with "sleep 125; echo ok". Repository readiness > Validate commands. The request took 120366 ms. The summary read "Commands validated · needs attention", Setup execution was Skipped, and Check execution was Failed with " | [timed out after 120s]". "Repository configuration: Using .codeflow/config.json" passed, so the config was read but its limit was ignored. Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4653/001-readiness-validate.png. No console errors or 5xx responses.
(2) Run on the same project, script work/v4653/run2.mjs: I started a "Fix & review" run from the composer. The API showed run.loop = {checkTimeoutMin:10, check:"sleep 125; echo ok"}. The run's Check step finished as done with "Passed in 125s" (startedAt to endedAt = 125028 ms). The same command passes in a run but fails validation. A first "Agent — one agent" run did not execute the check at all, because the conversational solo pattern only checks with checkpointOnFinish, so it was not used for the comparison.
Cleanup: I cancelled run 2 through the UI (Stop checks > Stop work) and deleted both runs with the UI bulk delete (total runs 0). Run deletion keeps worktrees and branches by design; they existed only inside my own scratch repo, which I then removed. I stopped QA server v4653, and ports 4653 and 4655 are free. No codeflow-validation-* temp dir was left. No target repo was touched. Leftovers: the QA home homes/v4653 (it has the registered project "v4653-slow") and profiles/v4653.

</details>

### t03-8 · minor · A malformed package.json makes GET /api/check return 500, and the composer silently shows no check

**Fix outcome: fixed.** src/checks.ts: new detectCheck() wraps the package.json parse in try/catch and strips a UTF-8 BOM, which npm accepts. An invalid file records the warning 'package.json is not valid JSON, so its test script was skipped' and detection continues to Cargo, go, pytest and Makefile. detectCheckCommand keeps its signature. src/server.ts GET /api/check returns 200 with {command…, warning} and is wrapped in attempt(). src/readiness.ts uses detectCheck and adds 'Detection: …' to the Verification command item. ui/state.ts has a new checkWarning signal, set from the warning or from a failed lookup. ui/composer.tsx shows it under 'Done when this passes' (aria-describedby) and clears it when you type. src/verification.ts profile detection also tolerates a BOM.

Fixer's check: f11 with a repo whose package.json is '{ not json' plus a Makefile 'test:' target. GET /api/check returns 200 {command:'make test', source:'Makefile', warning:…}. Without the Makefile it returns 200 {command:null, warning}. POST /api/readiness returns 200 with all items, and the check detail ends 'Detection: package.json is not valid JSON…'. The composer's Done when field shows 'make test' or stays empty, with 'Detection: package.json is not valid JSON, so its test script was skipped.' under it. server.out has no 'GET /api/check failed', and the browser shows no 5xx.

Tests: `test/qa-check-runner-failures.test.ts: an invalid package.json is skipped with a warning, and detection goes on`, `test/qa-check-runner-failures-server.test.ts: an invalid package.json is a detection warning, and other runners are still found`, `test/e2e/qa-check-runner-failures.e2e.ts: the composer explains an empty Done when for an invalid package.json`

Source: tester unit composer-run-options-2; observed with api; features CMP-24.

**Repro**

> 1. Create a git repo whose package.json is '{ not json' (optionally with a Makefile 'test:' target) and open it as a project.
> 2. curl -H 'authorization: Bearer <token>' 'http://127.0.0.1:<port>/api/check?repo=<repo>'.
> 3. Open its New run > Run options.

**Expected:** Detection reports the malformed package.json (4xx, or a hint) and still falls back to other runners. The composer tells the user why no check was found.

**Actual:** HTTP 500 {"error":"Expected property name or '}' in JSON at position 2…"} and server.out logs 'GET /api/check failed'. The composer shows an empty 'Done when' field with no message (console shows the 500). The Makefile fallback is never reached.

**Root cause (verifier):** src/checks.ts:47: `const pkg = JSON.parse(await readFile(join(repo, "package.json"), "utf8").catch(() => "{}"));`. The .catch only covers readFile errors. A SyntaxError from JSON.parse escapes detectCheckCommand, so the Cargo/go/pytest/Makefile fallbacks below it (lines 54-61) never run.
src/server.ts:2265-2267: the GET /api/check route calls detectCheckCommand(repo) without attempt() (defined at server.ts:579), so the plain SyntaxError falls through to the generic handler and becomes HTTP 500, logged as "GET /api/check failed".
The same throw also breaks src/readiness.ts:21 (Promise.all inside inspectReadiness), so "Inspect readiness" fails as a whole with the raw parse message, and src/verification.ts:107 (fallback path).
UI: ui/state.ts:854-855 (loadCheck) catch only sets checkHint.value = "". The composer shows an empty "Done when" field with no explanation, and Run details says "Not configured".
ui/project-run-settings.tsx:32-37 uses Promise.all over /api/repo-config and /api/check, so a detection failure also sets the error state, and line 52 disables "Save project defaults".

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/checks.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/server.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/state.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-run-settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/loop.test.ts`

**Suggested fix:** 1) src/checks.ts (detectCheckCommand): parse package.json in a try/catch. If the JSON is invalid, skip the npm branch and keep going, so Cargo, go, pytest and Makefile are still tried. Record a warning such as "package.json is not valid JSON; skipped its test script". Add an optional `warning?: string` to DetectedCheck. When nothing else is found, return { command: null, warning } instead of throwing, which means the function's return type has to allow that. inspectReadiness and detectVerificationProfile then stop failing on this case; readiness can show the warning in its "Verification command" detail.
2) src/server.ts:2265-2267: as defence in depth, wrap the route in attempt(() => detectCheckCommand(repo)) so any remaining detection error is a 4xx with a message, not a 500.
3) ui/state.ts loadCheck: when the response has command null plus a warning, set checkHint to the warning; otherwise keep "No test command found in this repo.". When command is set and a warning exists, append it  …

**Suggested regression test:** In test/loop.test.ts, test "detects the repo's test command":
- assert.equal((await detectCheckCommand(dir({ "package.json": "{ not json", "Makefile": "test:\n\techo ok\n" })))?.command, "make test"), and check that its warning mentions package.json.
- assert.doesNotReject / deepEqual for dir({ "package.json": "{ not json" }), expecting command null and a warning matching /package\.json is not valid JSON/.
In a server API test (or an extension of test/repo-selection-ui.test.ts), GET /api/check o …

<details><summary>Verifier's independent reproduction</summary>

I started a fresh fake-mode QA server (v4649, port 4649, new home, no runs). I made two scratch git repos under scratchpad/qa/clones: v4649-badpkg has package.json = '{ not json' and a Makefile with a 'test:' target, committed. v4649-makeonly has the same Makefile and no package.json, as a control.
1) API: curl -H 'authorization: Bearer qa-v4649-token' 'http://127.0.0.1:4649/api/check?repo=<badpkg>' three times. Every call returned HTTP 500 {"error":"Expected property name or '}' in JSON at position 2 (line 1 column 3)"}, and server.out logged 'code-flow: GET /api/check failed: Expected property name…' three times. The Makefile fallback was never reached. For comparison, GET /api/verification/profile?preset=standard on the same repo returns a clear HTTP 400 "Cannot detect verification: package.json is not valid JSON", and /api/repo-config returns 200.
2) UI (work/v4649/s01.mjs, Playwright). I opened both repos through "Open another repository" > Create project, then went to #/project/<id>/new and expanded Run options and Advanced.
   - Control (MakeOnly): #checkCmd = "make test", and the Run details row reads "Verification command  make test  Detected from Makefile."
   - Broken: #checkCmd is empty and there is no alert or hint anywhere near "Done when this passes" (screenshot shots/v4649/003-Broken-options.png). The Run details row says "No automated command  Not configured". The intended no-command hint is "No test command found in this repo.", so the user is not even told that much. The only trace is the console error "Failed to load resource: 500". Clicking Repository readiness > "Inspect readiness" gives HTTP 400 and shows the raw message "Expected property name or '}' in JSON at position 2 (line 1 column 3)". That message does not name package.json (004-Broken-readiness.png).
3) Additional impact (work/v4649/s02.mjs): in Settings > Projects with "v4649 Broken" selected, Run defaults shows "Could not load repository defaults: Expected property name or '}' in JSON…" with a Retry button that keeps failing. "Save project defaults" stays disabled, so the user cannot save a check command for this repo on that page.
Nothing points to the environment or the reporter's script. The server was fresh, the projects were added through the UI, a fresh browser profile was used, and the control repo behaves correctly. Nothing in docs/patterns.md ("auto-detected from the repo") and no code comment says this is intended. The sibling verification detector deliberately r …

</details>

### t03-9 · minor · Settings > Projects 'Save project defaults' is permanently disabled for a repo whose detection fails (e.g. malformed package.json)

**Fix outcome: fixed.** ui/project-run-settings.tsx: repo-config and /api/check are loaded with Promise.allSettled, so a failed or warning detection only shows a non-blocking 'Detection: …' or "Couldn't detect a check command…" note. '!!error' was removed from the Save button's disabled condition. Commands typed before a retry are kept through an `edited` ref. The server-side cause (the /api/check 500) is fixed under t03-8.

Fixer's check: f11 with 3 broken repos (malformed package.json alone, with Makefile, trailing comma plus Cargo.toml). Settings > Projects shows the detection note with no 'Could not load repository defaults' error. Save project defaults is enabled before typing. Typing 'node -e 1' and 'echo setup-ok' then Save shows 'Project defaults saved.' and both values land in localStorage. After a reload the value is still there (e2e). No browser errors.

Tests: `test/e2e/qa-check-runner-failures.e2e.ts: an invalid package.json leaves project defaults saveable and says why nothing was detected`

Source: tester unit composer-run-options-2; observed with fake-agents; features CMP-43.

**Repro**

> 1. Project whose repo has package.json '{ not json'.
> 2. Settings > Projects > select that project.
> 3. The panel shows 'Could not load repository defaults: Expected property name…' with Retry loading defaults.
> 4. Type a Default check command (e.g. 'node -e 1').
> 5. Try to save; click Retry.

**Expected:** The user can still save a manual check and setup. That is the fix for a repo whose detection fails.

**Actual:** Save project defaults stays disabled before and after typing, and Retry fails again, so no defaults can be saved for that repo.

**Root cause (verifier):** The root cause has two parts.

1) src/checks.ts:47: detectCheckCommand calls `JSON.parse(await readFile(join(repo, "package.json"), "utf8").catch(() => "{}"))`. The .catch guards only the read, not the parse. A malformed package.json, or a valid one with a UTF-8 BOM, throws a SyntaxError. That surfaces from src/server.ts:2265-2267 (GET /api/check) as HTTP 500. Every other detector (Cargo, go, pytest, Makefile) is skipped as well. src/readiness.ts:20-21 and src/verification.ts:107 call the same function and are exposed to the same throw.

2) ui/project-run-settings.tsx:32-37: the panel loads repo-config and detection with Promise.all. Any rejection lands in the catch at line 37, which sets `error`. Line 55 then gates the button with `disabled={loading || !!error || ...}`. A failure in best-effort command detection therefore blocks saving everything in the panel: check, setup, verification profile and Docker defaults, even though the inputs (line 50-51, disabled only by `loading`) stay editable. Retry (line 56) only re-runs the same failing request. Because the catch at line 37 resets `commands` to the stored values, Retry also discards what the user typed.

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/checks.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/ui/project-run-settings.tsx`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/loop.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/e2e/ui.e2e.ts`

**Suggested fix:** Fix both layers.

(a) Server, src/checks.ts:47: strip a leading BOM (`text.replace(/^﻿/, "")`) and wrap the parse in try/catch. On failure, treat the package as having no test script and fall through to the other detectors, so detection returns a normal result or null instead of throwing. This also removes the 500 for /api/check, readiness and verification (t03-8). Optionally return a `warning` such as "package.json is not valid JSON" so the UI can explain why nothing was detected.

(b) UI, ui/project-run-settings.tsx: make detection best-effort.
- Use Promise.allSettled, or give the /api/check call its own `.catch(() => ({}))`, so a detection failure only loses the suggestion and shows a non-blocking hint ("Could not detect a check command; enter one manually").
- Drop `!!error` from the Save `disabled` condition at line 55. Keep blocking only while `loading` and for Docker without an image. The inputs are already editable, and save() writes only local values.
- On Retry, keep values  …

**Suggested regression test:** Unit, in test/loop.test.ts next to the existing detectCheckCommand cases (around line 55-61):
- `assert.equal(await detectCheckCommand(dir({ "package.json": "{ not json" })), null)` shows it does not throw.
- `assert.equal((await detectCheckCommand(dir({ "package.json": "{ not json", "go.mod": "" })))?.command, "go test ./...")` shows it falls through to other detectors.
- `assert.equal((await detectCheckCommand(dir({ "package.json": "﻿" + JSON.stringify({ scripts: { test: "vitest run" } }) }))) …

<details><summary>Verifier's independent reproduction</summary>

Fresh fake-mode QA server "v4651" on 127.0.0.1:4651 with a new home, and a fresh browser with no stored profile, which rules out leftover localStorage. I made a new scratch git repo /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/clones/v4651-brokenpkg containing package.json "{ not json" plus a README, committed on main. I added it through the UI (Open another repository, then Create project "v4651 Broken"). Script: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/work/v4651/r1.mjs; log in r1.log in the same folder.

Observed:
- GET /api/check returns 500 {"error":"Expected property name or '}' in JSON at position 2 ..."}. GET /api/repo-config returns 200 {config:{},found:false}.
- In Settings > Projects with "v4651 Broken" selected, the panel shows "Could not load repository defaults: Expected property name or '}'..." and a "Retry loading defaults" button.
- Save project defaults is disabled from the start, while the check and setup inputs are enabled.
- I typed check "node -e 1" and setup "echo setup-ok" and set verification to Lightweight. Save stayed disabled, and clicking it timed out because the button is disabled.
- After Retry: the same error comes back, Save is still disabled, and the check field is reset to "" (the typed value is lost).
- No check:/setup: keys were written to localStorage.
- Screenshot: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4651/002-after-typing.png

A more realistic trigger reproduces it too (r2.mjs, 001-bom-blocked.png): package.json = UTF-8 BOM + {"name":"bom","version":"1.0.0","scripts":{"test":"node -e 1"}}. npm runs its test script fine, but /api/check returns 500 "Unexpected token '﻿'..." and Save stays disabled after typing a check.

Arguments against the report that I checked and ruled out:
- Not by design. docs/configuration.md and the panel help say "Configure each repository once", nothing says detection must succeed first, and git history (636d2a3) has no rationale for the gate.
- Not caused by the tester's environment. It reproduces with a fresh profile, a fresh home and my own repo.
- The composer offers no workaround for saving a default. It only uses the draft-only setRunCheck/setRunSetup (ui/state.ts:746-752), so the only workarounds are typing the check on every run, committing .codeflow/con …

</details>

### S11-1 · minor · detectCheckCommand calls JSON.parse on package.json without a try/catch. Malformed JSON throws instead of falling through to Cargo/Go/pytest/Makefile detection, and GET /api/check returns 500.

**Fix outcome: duplicate.** Same root cause and fix as t03-8 (commit b97a48d): detectCheck no longer throws on an invalid package.json and falls through to the other detectors.

Fixer's check: f11 with the S11 repo: a package.json with a trailing comma plus Cargo.toml. GET /api/check returns 200 {command:'cargo test', source:'Cargo.toml', warning}. POST /api/readiness returns 200 with git and provider items present. Settings > Projects saves normally.

Tests: `test/qa-check-runner-failures.test.ts: an invalid package.json is skipped with a warning, and detection goes on`

Source: code-level suspect at `src/checks.ts:47` (confirmed hands-on).

**Repro**

> Fake-mode server s11 on 4545. I made a scratch repo containing package.json with a trailing comma (`{"name":"x","scripts":{"test":"node --test"},}`) plus Cargo.toml. (1) `GET /api/check?repo=<badpkg>` returns HTTP 500 `{"error":"Expected double-quoted property name in JSON at position 57 (line 4 column 1)"}`. Control: the same Cargo.toml with no package.json returns 200 `{"command":"cargo test","source":"Cargo.toml"}`. (2) `POST /api/readiness {repo}` returns 400 with the same message, so the Git and provider readiness items are lost too. (3) UI: Settings > Projects > project 'S11 badpkg' shows 'Could not load repository defaults: Expected double-quoted property name in JSON at position 57'. 'Save project defaults' is disabled, so the user cannot save even a manual check command (screenshot shots/s11/001-badpkg-settings-projects.png). The browser logged http 500 on /api/check. (4) A scratch tsx test in builds/s11: detectCheckCommand(dir) threw a SyntaxError instead of returning {command:'cargo test'}.

**Expected:** An invalid package.json is skipped (or reported as 'package.json is not valid JSON'). Detection falls through to Cargo.toml (`cargo test`). /api/check returns 200, or at worst a 4xx that names the file. Project defaults stay saveable.

**Actual:** Unhandled SyntaxError. /api/check returns 500 with a parser message that does not name package.json. Readiness fails entirely. The Settings save button is disabled.

**Root cause (verifier):** `JSON.parse(await readFile(...).catch(() => "{}"))`: the `.catch` covers only the file read, not the parse. A SyntaxError escapes detectCheckCommand. The GET /api/check route (server.ts:2265) is not wrapped in attempt(), so the error becomes a 500 with the raw parser message. inspectReadiness calls the same function, so /api/readiness fails as a whole (400). Note that verification.ts deliberately turns the same case into a clear 'package.json is not valid JSON' error, but detectCheckCommand neither falls through nor names the file.

**Suggested fix:** In detectCheckCommand, wrap the parse: `let pkg; try { pkg = JSON.parse(raw) } catch { pkg = undefined }` and skip the package.json branch when parsing fails (optionally return a note such as source 'package.json is not valid JSON'). Wrap the /api/check handler in attempt() so other errors become 4xx. In ui/project-run-settings.tsx, do not disable Save when only detection failed.

**Suggested regression test:** test/checks.test.ts: a temp dir with malformed package.json plus Cargo.toml gives detectCheckCommand() === {command:'cargo test', source:'Cargo.toml'}. Server test: GET /api/check on that repo returns 200, and POST /api/readiness returns 200 with the git/provider items present.

### t07-9 · minor · A reviewer test that was never collected is labelled 'Passes: a false alarm' in the timeline, while the finding says it couldn't run

**Fix outcome: fixed.** src/engine.ts: command() now delegates to commandStep(), which returns {result, step}. A new restate(step, ok, text) helper sets the status and finalText and re-emits the status and step events. reproduceLive calls restate(step, false, "Couldn't tell: ${missed}") when reproMissed reclassifies a passing reviewer's test as unverified. The persisted step and live views now match the finding.

Fixer's check: f11b with FAKE_IMPORT_TEST=1 FAKE_REPRO=passes. Started from the composer: Fix & review, Done when 'node --test feature.test.mjs', Max review rounds 1. Step s5 'Reviewer's test: Off-by-one in the loop bound' is now failed with "Couldn't tell: `node --test feature.test.mjs` ran 1 tests with it, as many as without, so it didn't run null.test.mjs". The UI step row shows ✕ and that text instead of 'Passes: a false alarm'. The finding is unverified and blocking, which is consistent. No browser errors.

Tests: `test/qa-check-runner-failures.test.ts: a reviewer's test the check never ran reads Couldn't tell in its step, as in its finding`

Source: tester unit run-workspace-2; observed with fake-agents; features RUN-27.

**Repro**

> 1. export FAKE_IMPORT_TEST=1 FAKE_REPRO=passes; start a fake server.
> 2. Start 'Fix & review' with check `node --test feature.test.mjs`, options maxRounds 1.
> 3. The reviewer raises 'Off-by-one' with repro null.test.mjs, which the check never runs.

**Expected:** The step 'Reviewer's test: Off-by-one…' says the test couldn't be confirmed (not collected), consistent with the finding.

**Actual:** Step s5 is done (green) with 'Passes: a false alarm'. The finding in the artifact card says 'Couldn't run the reviewer's test — `node --test feature.test.mjs` ran 1 tests with it, as many as without, so it didn't run null.test.mjs' and it still 'Blocks'.

**Root cause (verifier):** src/engine.ts:1948-1958 (`reproduceLive`). The `describe` callback passed to `this.command("check", title, checkout, repro.command, …)` sets the step's outcome at lines 1949-1952. It maps a passing run (reproOutcome "refuted") to `{ ok: true, text: "Passes: a false alarm" }`. `command()` then finalises the step and emits it at src/engine.ts:2155-2165: `step.status = … "done"`, `step.finalText = described.text`, then `emit({type:"step"})`.

Only after that, at lines 1955-1958, does `reproduceLive` call `this.reproMissed(...)` (src/engine.ts:1975-2000). That call reclassifies the passing result as "unverified" in three situations:
- as many tests ran with the test as without it
- no tests ran
- the output never mentions the test

`reproduceLive` then returns `make("unverified", missed)`. Nothing updates or re-emits step s5 afterwards. The finding (and therefore `blocks()` and the summary) is unverified and blocking, while the persisted step keeps status "done" and "Passes: a false alarm".

The same mismatch affects every `reproMissed` branch:
- the run's check (this case)
- `tests === 0`
- a silent runner
- the reviewer's own command with an equal count. Here the extra "(without the  …

**Files:** `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/src/engine.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/findings.test.ts`, `/Users/mx/Documents/Work/MX/Research/code-flow/.claude/worktrees/dogfood-qa/test/engine-review.test.ts`

**Suggested fix:** After `reproMissed` reclassifies the result, update the reviewer's-test step so it agrees with the finding. Two ways to do it:

(a) Add a small helper, e.g. `private restate(step: Step, ok: boolean, text: string)`. It sets `step.status` (done/failed, keeping an aborted status if `this.signal.aborted`) and `step.finalText`, then emits the same `status` agent event and a `{type:"step"}` event that `command()` emits at src/engine.ts:2164-2165. Have `command()` give the caller the step, either through a variant that returns `{ result, step }` or an optional out-parameter. In `reproduceLive`, when `missed` is set, call `restate(step, false, \`Couldn't tell: ${missed}\`)`. That matches the wording and red/failed status that the describe callback already uses for other "unverified" outcomes.

(b) Run the `reproMissed` decision before the step is finalised. This is harder, because `reproMissed` can itself run a second command, "(without the test)", in the same checkout.

Option (a) is the smal …

**Suggested regression test:** Add to the existing test "pipeline: a test the check never runs refutes nothing; the finding blocks on the reviewer's word" in test/findings.test.ts (around line 167; FAKE_REPRO=uncollected, check `node --test`, maxRounds 1). Assert on the reviewer's test step:

`const step = r.steps.find(s => s.title.startsWith("Reviewer's test"))!; assert.notEqual(step.status, "done"); assert.match(step.finalText!, /^Couldn't tell: .*as many as without, so it didn't run notes\/bound\.spec\.txt/); assert.doesNo …

<details><summary>Verifier's independent reproduction</summary>

Used a fresh fake-mode QA server: `export FAKE_IMPORT_TEST=1 FAKE_REPRO=passes; qa-server.sh start v4603t079 4603 fake`. I checked with `ps eww` that both env vars reached the server process. I created a throwaway git repo in the scratchpad (README and package.json, one commit) and added it through the UI ("Open another repository", then "Create project" named "v4603 tiny"). In the composer I set Permissions to "Approve for me" and Workflow to "Fix & review". I set "Done when this passes" to `node --test feature.test.mjs` and "Max review rounds" to 1, then sent the task "Add a feature module with a test."

Run 2610252014-a3813622 finished in a few seconds. Its steps were:
- s1 "Fix the issue": done
- s2 "Check": "Passed in 0s (1 tests)"
- s3 "Proof": weak proof
- s4 "Review (round 1)": changes_requested, raising 'Off-by-one in the loop bound' with repro {path: null.test.mjs, command: ""}
- s5 "Reviewer's test: Off-by-one in the loop bound": status done, finalText "Passes: a false alarm"

The tool_result for s5 in the run's .jsonl shows that only `# Subtest: feature` ran (1..1, 1 test), so null.test.mjs was never collected. The finding in run.findings has check.status "unverified" with the detail "`node --test feature.test.mjs` ran 1 tests with it, as many as without, so it didn't run null.test.mjs" and blocking: true. The summary reads "Not approved … couldn't run its test (…) · blocks".

In the UI, with "5 steps" expanded, the s5 row shows a green check plus "Check  Passes: a false alarm", and its body ends with "Passes: a false alarm". On the same screen, "Open review findings" says the finding couldn't run its test and blocks. Screenshots: /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4603t079/002-s5-row.png and /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/shots/v4603t079/004-finding-visible.png. No console errors or 5xx responses.

I found nothing that refutes the report:
- It is not by design. docs/patterns.md:89 lists "the test never ran: as many tests ran with it as without" among the cases where "code-flow can't tell". For those cases the code's own wording is "Couldn't tell: …", not "Passes: a false alarm".
- It is not caused by the tester's environment. The reporter's fakecopy only adds an MDTEST branch, and I used the unmodified test/fake-bin.

Cleanup: I deleted the run through the UI (Run menu, " …

</details>

### t07-12 · minor · Invalid CODEFLOW_MAX_AGENTS / CODEFLOW_MAX_CHECKS values are silently ignored (no warning)

**Fix outcome: fixed.** src/config.ts envNumber gains an `integer` option; a rejected value warns 'must be a whole number, at least 1'. src/engine.ts reads CODEFLOW_MAX_AGENTS and CODEFLOW_MAX_CHECKS with envNumber(…, {min:1, integer:true}). src/watch.ts reads CODEFLOW_WATCH_INTERVAL_MS with envNumber(min 1000 ms, max MAX_TIMER_MS). docs/configuration.md already describes this behaviour.

Fixer's check: f11b started with CODEFLOW_MAX_AGENTS=30m and CODEFLOW_MAX_CHECKS=3x. server.out has 'code-flow: ignoring CODEFLOW_MAX_AGENTS="30m" (must be a whole number, at least 1); using 6' and the same for MAX_CHECKS, and /api/health shows busy.agents.max 6 and checks.max 3. Restarted with 2.5 and 0: both are warned about and fall back to 6 and 3 (previously 2.5 was accepted silently and 0 ignored silently).

Tests: `test/qa-check-runner-failures.test.ts: whole-number settings refuse fractions and zero with one warning`, `test/qa-check-runner-failures-server.test.ts: invalid slot limits fall back to their defaults with a warning`

Source: tester unit run-workspace-2; observed with fake-agents; features RUN--GAP-01.

**Repro**

> 1. export CODEFLOW_MAX_AGENTS=30m; qa-server.sh start t07f 4379 fake.
> 2. Look at server.out and GET /api/health busy.agents.max.
> 3. Compare with CODEFLOW_STEP_TIMEOUT_MIN=30m.

**Expected:** Per docs/configuration.md: 'A numeric setting that isn't a valid number (`30m`, say) or is out of range falls back to its default, with a warning in the terminal.'

**Actual:** MAX_AGENTS=30m falls back to 6 with no warning. STEP_TIMEOUT_MIN=30m prints 'code-flow: ignoring CODEFLOW_STEP_TIMEOUT_MIN="30m" … using 30'. Fractional or zero values for these two are also not range-checked (Number() || default).

**Root cause (verifier):** src/engine.ts:142-143 read the two limits with `new Slots(Math.max(1, Number(process.env.CODEFLOW_MAX_AGENTS) || 6))` and `new Slots(Math.max(1, Number(process.env.CODEFLOW_MAX_CHECKS) || 3))`. That skips envNumber() at src/config.ts:16, the helper that range-checks a value and prints a single warning when it rejects one. The effect: NaN ("30m") and 0 fall back to the default without a warning; negative values are clamped to 1 without a warning; fractions (2.5) are accepted, give Slots a non-integer size (src/slots.ts:12, `used < size` at line 26, which effectively rounds up), and show up as busy.agents.max at src/engine.ts:3256 and in the wait messages at lines 2128 and 2602. src/watch.ts:67 has the same problem: `Number(process.env.CODEFLOW_WATCH_INTERVAL_MS) || 60_000` is also documented and also never warns.

**Files:** `src/engine.ts`, `src/config.ts`, `src/watch.ts`, `test/foundation.test.ts`

**Suggested fix:** In src/engine.ts:142-143, replace the Number(...) || default reads with envNumber("CODEFLOW_MAX_AGENTS", 6, { min: 1 }) and envNumber("CODEFLOW_MAX_CHECKS", 3, { min: 1 }). That way "30m", "0" and negative values fall back to the default and print a single warning, the same way CODEFLOW_STEP_TIMEOUT_MIN already does. Slot counts must be whole numbers, so also add an `integer?: boolean` option to envNumber in src/config.ts. With it set, Number.isInteger(value) is required, and the warning says "must be a whole number, at least 1". Use that option for both slot limits rather than silently applying Math.floor. A sensible max, such as 256, is optional. Make the same switch in src/watch.ts:67: envNumber("CODEFLOW_WATCH_INTERVAL_MS", 60_000, { min: 1000 }), or whatever minimum the watcher can tolerate. No docs change is needed, because docs/configuration.md:124 already describes the fixed behaviour.

**Suggested regression test:** Two tests. (1) Unit test in test/foundation.test.ts, next to "envNumber falls back on values setTimeout would misread": with CF_TEST_NUM="2.5", envNumber("CF_TEST_NUM", 6, { min: 1, integer: true }) returns 6, and the same for "0" and "-1", while "4" returns 4. Spy on console.warn and assert it was called once with a message containing `ignoring CF_TEST_NUM="2.5"`. (2) Subprocess test, for example in test/foundation.test.ts or a new test/slot-limits-config.test.ts: spawn `node --import tsx -e "c …

<details><summary>Verifier's independent reproduction</summary>

I used a fresh fake-mode home, v4609a. The existing v4609 home already had state from an earlier run, so I left it alone. (1) I ran `export CODEFLOW_MAX_AGENTS=30m CODEFLOW_MAX_CHECKS=3x CODEFLOW_STEP_TIMEOUT_MIN=30m; qa-server.sh start v4609a 4609 fake`. In /private/tmp/claude-501/-Users-mx--codex-worktrees-60c0-code-flow/ba3a9652-8309-41b7-b10b-ba3be5f2219e/scratchpad/qa/homes/v4609a/server.out, the only warning was `code-flow: ignoring CODEFLOW_STEP_TIMEOUT_MIN="30m" (must be a number, at least 0.01, at most 1440); using 30`. Nothing mentioned CODEFLOW_MAX_AGENTS or CODEFLOW_MAX_CHECKS. GET /api/health returned busy = {agents:{max:6}, checks:{max:3}}, so both fell back to their defaults without a warning. (2) I stopped the server and restarted it with CODEFLOW_MAX_AGENTS=2.5 and CODEFLOW_MAX_CHECKS=0. There was again no warning. /api/health returned busy.agents.max = 2.5, which is not an integer and is shown as-is. Because Slots grants a slot while used < size, this setting allows 3 agents at once, and the wait message would read "2.5 agents run at once". busy.checks.max = 3 because "0" is falsy and silently becomes the default. Neither value went through a range check. Docs/configuration.md:124 says: "A numeric setting that isn't a valid number (`30m`, say) or is out of range falls back to its default, with a warning in the terminal." That line covers these two variables, which the table at lines 104-105 lists. No code comment or doc exempts them, so this is not by design. It also does not depend on the environment: the server reads the variables at module load, and the fake/real mode makes no difference. I created no runs, and I stopped the server. The only leftover is the home directory homes/v4609a.

</details>
