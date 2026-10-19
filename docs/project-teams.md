# Standing project teams (preview)

A standing team connects an owner mission to one repository. Existing Automations supplies the clock, and existing Auto team runs do the investigation, implementation, checks and independent review. The team brings opportunities and verified drafts back to the owner. It never merges or publishes automatically.

## Start a team

1. Start the host with `CODEFLOW_PROJECT_TEAMS_ENABLED=true`. Auto team must also be enabled (`CODEFLOW_AUTO_TEAM_ENABLED` defaults to enabled).
2. Open a project that explicitly contains the repository. Select **Connect a team**.
3. Enter its mission, intended users, priorities, exclusions and named local base branch. Select a coordinator and worker/reviewer providers. Claude, Codex and Antigravity are eligible when installed; ACP and extension providers are currently excluded from unattended standing teams.
4. Choose **Build within scope** and supply a required check command, or choose proposals only. Set allowed paths, categories and change limits. Models and reasoning use the existing provider catalog.
5. Review the schedule and budgets, save the draft, then **Activate**. Use **Preview next cycle** before **Run cycle now**.

The default schedule is Monday at 09:00 in the browser's time zone. Daily, selected weekdays and intervals use the existing Automations schedule editor and DST behavior. Code Flow must be running for its local scheduler to work. Cycles pin the current local branch commit; they do not fetch remote changes.

The default scope permits the repository except `.codeflow` and `.github/workflows`, with eight changed files and 400 added/deleted lines. Credential paths and binary changes are excluded. File bounds enforce mechanical scope; a model's risk and benefit estimates remain judgments to review.

Discovery reserves eight calls and 15 minutes. Implementation reserves 16 calls and 45 minutes. The rolling seven-day allowance is 48 calls and 120 allocated minutes. Calls with settled usage reclaim unused calls; time remains conservatively charged at the phase allocation. Unknown launches remain fully reserved even after seven days. Increase budgets deliberately in the mission editor when the defaults do not fit your cadence.

## What a cycle does

Discovery uses read-only Auto team workers, a separate structured report turn, then an independent reviewer. It returns at most three opportunities with source quotes, affected users, a proposed change, expected benefit, risk and acceptance criteria. Empty findings are a valid result. Discovery does not run setup, checks, proof writers or code repairs.

The host verifies quotes at the pinned Git commit, suppresses previously reported problems, and ranks eligible proposals deterministically. Automatic implementation requires allowed category/paths, low risk, sufficient confidence/alignment, and a required verification profile. Hypotheses require the explicit experiment category. A cycle can build only one proposal; reports with uncertain evidence remain proposals.

Implementation uses a fresh ordinary Auto team within its reserved budget. File, path and line limits are checked before commits and publication. A result becomes **ready** only when required checks and the independent review refer to the final branch commit. Existing fail-to-pass proof settings still apply. Failures and stale results remain visible with a reason.

There is one active cycle per repository, at most two unresolved implementation results, and at most 12 open opportunities. Unchanged inputs skip agent work until the rescan interval (28 days by default). Relevant owner decisions, local activity, configuration or base changes permit new discovery. An unchanged failed automatic cycle needs an explicit owner retry or changed inputs.

## Review and feedback

The project page contains the full opportunity cards, cycle history, selection reasons, budgets and links to existing run diffs/checks. The review inbox contains compact links to actionable standing teams.

- **Build proposal** allocates a bounded whole Auto team. High-risk, unsupported or stale work requires a revised mission or an ordinary owner-directed task.
- **Request revision** records feedback and launches a fresh bounded whole team from the pinned base, with the previous result referenced as evidence. It does not silently continue a single writer or refresh the old run's allowance.
- **Approve this commit** accepts the exact reviewed result. Open that run to use the existing PR or merge controls. Approval alone does not ship anything. A successful local merge is recorded as shipped; opening a PR is not counted as shipped.
- **Defer one week** retains the idea and feedback; once due it may be rediscovered. **Reject** suppresses the problem in later discovery. Owners may explicitly reconsider a saved proposal.
- **Pause** prevents new cycles and the next implementation stage. An already running discovery may finish into proposals. **Stop cycle** cancels owned work, retaining unresolved reservations. **Archive team** stops scheduling and retains its history.

Changing the mission makes previously ready/accepted results require new verification. Moving a result branch after review invalidates readiness. Generic run resumes, selective reruns, writer follow-ups, automatic PR-fix watchers and triage revision shortcuts are blocked for managed runs; use the standing team's revision controls.

Standing team runs can be archived individually or in a sidebar selection. They cannot be deleted: cycle recovery, budgets and exact-result approvals retain their run history. Ordinary runs still support individual and bulk deletion. The mission editor's searchable model picker includes the same free-model filter and badges as the composer; its selections update only that team's mission.

Existing notification destinations receive actionable cycle outcomes using their saved event/project scope. Child completions and no-op cycles do not produce duplicate alerts. Destinations remain opt-in.

## Recovery and storage

Team aggregates are private files under `$CODEFLOW_HOME/project-teams/`. Each mutation validates and fsyncs its snapshot before acknowledgment. A cycle claim and its full budget allocation are saved before starting a run; the initial run identity is fsynced and attached to the claim before any agent dispatch.

Recovery adopts only a matching team/cycle/claim/input/attempt receipt. An ambiguous launch is marked **unknown** and is never automatically replayed. Inspect its run and host process state, then stop the cycle if abandoning it; stopping does not pretend unknown usage is zero. A storage error remains visible, and corrupt team files are preserved for repair. Duplicate repository ownership blocks both records.

Automations stores only a managed target and a display projection. Mission settings remain authoritative in the team aggregate. Managed schedules cannot be edited through generic automation controls. Schedule occurrences use stable operation IDs, so replaying a due occurrence cannot launch a second cycle. The existing one-hour missed-run grace and DST rules apply.

History is bounded to 100 cycles, 200 opportunities, 2,000 decisions and 2,000 operation receipts, with a 16 MiB aggregate ceiling. At the limit, archive the team and retain its file before creating a replacement. History is not silently pruned; rejection feedback is never silently forgotten within a team.

Backups include team evidence and missions. Restore pauses teams, cancels active cycle admission while retaining unknown reservations, and invalidates ready/accepted results. Inspect repository membership, providers and retained receipts before reactivation. ACP executable settings and other existing credential exclusions remain excluded from portable backups.

Owner APIs, managed child runs and the project-scoped event topic are unavailable to shared accounts, because the child tasks include private owner mission and decision context. Custom filesystem restrictions block the feature alongside other host execution/private-data surfaces. Removing project membership stops owned work. There is no cloud scheduler or new agent runtime.

## API

All mutations use a client-generated `operationId`. Team edits and opportunity decisions require the current `revision`; opportunity decisions also require `opportunityRevision`. A replay with the same operation and content is idempotent; changing its content or acting on a stale revision returns a conflict.

| Method and path | Purpose |
|---|---|
| `GET /api/project-teams?project=ID` | Scoped teams, storage faults and provider eligibility |
| `POST /api/project-teams` | Create a draft with projectId, repo, name and mission |
| `GET /api/project-teams/:id` | Aggregate and remaining allowance |
| `POST /api/project-teams/:id` | Update mission/name/status with revision |
| `GET /api/project-teams/:id/preview` | Readiness and schedule preview without model calls |
| `POST /api/project-teams/:id/cycle` | Explicit cycle admission |
| `POST /api/project-teams/:id/stop` | Stop owned cycle with revision |
| `POST /api/project-teams/:id/opportunities/:opportunityId` | approve, build, revise, reject or defer |

The existing stream broker multiplexes `project-teams:<projectId>`. Generic run bodies cannot supply managed metadata or launch callbacks.

## Validation and rollout

`npm run evaluate:project-teams -- --fake --cycles 10 --out /tmp/my-standing-pilot` exercises two isolated fixture repositories and saves a report plus private run evidence. The default is synthetic. `--real --confirm` explicitly opts into signed-in CLI use, capped at 24 invocations and 60 allocated minutes per cycle. Use `--help` first. Neither mode merges or pushes.

Tests cover the full cycle, exact-commit approval, scope violations, failed checks, provider exclusions, budget limits, duplicate admission, durable receipt failure, restart adoption/ambiguity, cancellation, membership removal, feedback retention, storage corruption, restored authority, notifications, owner-only APIs, filesystem restrictions and shared browser transport.

The initial synthetic ten-cycle pilot produced two ready drafts and eight no-ops across two fixture repositories. It establishes mechanics only. Real-provider quality, novelty, usefulness and owner acceptance have not been measured; keep the flag opt-in until that separate pilot is assessed.
