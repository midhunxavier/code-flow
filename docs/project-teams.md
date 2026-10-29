# Project missions (preview)

Enable the project-mission preview, create a mission, and review its first proposal before accepting an implementation cycle. Keep budgets and publication decisions explicit.

## Start with a bounded preview

A project assignment connects an agent team and owner mission to one repository. Give it tasks directly or enable recurring discovery. Existing Automations supplies the clock, and existing Auto team runs do the investigation, implementation, checks and independent review. The team brings opportunities and verified drafts back to the owner. It never merges or publishes automatically.

## Reusable agent teams and project assignments

Open **Project → Project missions → Reusable agent teams** and choose **Create agent team**. Give it a name, choose its coordinator and worker/reviewer providers, and set model preferences. Optional role settings let the coordinator and workers use different models or effort for the same provider. Saving creates a versioned definition without starting agents or granting access to a repository.

Choose **Assign to this project**, select a repository and configure the mission, base branch, allowed paths, checks and budgets. Reusable-team assignments initially have **Run recurring discovery** turned off. Save the draft and activate it when ready. The same reusable team can be assigned to other projects with separate authority, memory and allowances. One non-archived assignment owns each underlying Git repository, including all its linked worktrees.

Existing missions are already assignments. **Edit mission → Agent team** can attach a reusable definition to one without replacing its ID, cycles, decisions, results, launch receipts or budget ledger. **Save as reusable team** copies only provider/model preferences from an existing assignment; it does not copy mission instructions, private checkpoints, sessions, project memory or permissions.

Editing a reusable team creates a new version. Assignments keep their pinned configuration until you choose a version in **Edit mission** or **Use team version …**. Each cycle and child run records its own snapshot; updates never silently change other assignments or running work. Adopting changed execution settings requires fresh verification for existing ready/accepted results and retains all prior history and charged usage.

## Give an assigned team a task

Activate the assignment, select **Give team a task**, and enter a title, instructions, acceptance criteria and an allowed category. A required verification check must be configured. The task starts an implementation Auto team immediately, skipping discovery. It uses the assignment's existing scope, permissions, implementation allocation and rolling weekly allowance. It works even with recurring discovery disabled, or when discovery is set to proposals only.

Tasks appear alongside opportunities with **Owner-assigned task** attribution. They do not claim independently discovered code evidence. Checks, independent review, exact-commit approval and publication controls are the same as for discovered opportunities. A task never resets usage or inherits a previous run's sessions. Finish or stop the active cycle before assigning another task. The task form retains the exact request after an ambiguous connection failure, so retrying cannot admit the same task twice.

Workers submit completed artifacts; Code Flow commits and integrates them, runs the configured checks and obtains independent review. Pending engine gates belong in the worker handover, not in unresolved implementation requirements. The final check can reuse passing evidence only for the same unchanged commit, checkout and verification profile. Plain documentation changes are identified from the actual diff: checks and independent review remain required, while executable fail-to-pass proof is marked not applicable. Code, configuration, executable files, binary changes and mixed diffs retain the proof requirement.

## Create a mission

1. Open **Project → More → Automation → Pursue a mission** and click **Enable project missions**. The choice applies immediately to every project on this host and is saved across restarts; no startup flag is required. Auto team must also be permitted by the host (`CODEFLOW_AUTO_TEAM_ENABLED` defaults to enabled).
2. Open a project that explicitly contains the repository. Select **Create a mission**.
3. Describe the outcome in **Mission**, then choose **Draft with AI**. One short CLI turn drafts the name, mission, intended users, priorities and exclusions from your goal. If it asks questions under **To clarify**, enter your replies and choose **Update draft with answers**. You can answer only the questions you know; the next draft incorporates your replies and preserves your edits. Failed requests keep your answers for retry. Review the updated fields before saving. **Configure manually** opens the same editable details without a model call. Drafting does not save, activate or run a mission.
4. New missions start with proposals only and recurring discovery off. The form detects the named local base branch, verification command and setup from the repository, preferring `.codeflow/config.json`. Proposals do not need a check; **Also build one eligible draft per cycle** requires a verification command. Review allowed paths, providers, categories and limits under **Mission details**. Claude, Codex and Antigravity are eligible when installed; ACP and extension providers are currently excluded from unattended project missions.
5. Review the schedule and budgets, save the draft, then **Activate**. Enable **Run recurring discovery** if desired. Use **Preview next cycle** before **Run cycle now**.

**Disable project missions** prevents new cycles on this host. Stop active or unresolved cycles first. Individual teams keep their activation state; enabling the feature again resumes schedules for teams already active. `CODEFLOW_PROJECT_TEAMS_ENABLED` remains an optional initial default until a UI choice is saved in `CODEFLOW_HOME/project-teams/settings.json`. Separate local and SSH hosts keep their own settings.

The default schedule is Monday at 09:00 in the browser's time zone. Daily, selected weekdays and intervals use the existing Automations schedule editor and DST behavior. In the mission form, **Save draft mission** or **Save mission** saves the schedule shown; **Run recurring discovery** turns it off. Code Flow must be running for its local scheduler to work. Cycles pin the current local branch commit; they do not fetch remote changes.

The default scope permits the repository except `.codeflow` and `.github/workflows`, with eight changed files and 400 added/deleted lines. Credential paths and binary changes are excluded. File bounds enforce mechanical scope; a model's risk and benefit estimates remain judgments to review.

New missions reserve 40 calls and 60 minutes for discovery, and 80 calls and 120 minutes for implementation. The rolling seven-day allowance is 500 calls and 1,440 minutes. Teams allow six members, six attempts per task, and four implementation repair rounds; discovery stays read-only. Existing missions retain their saved budgets until edited. Each launch reserves its full limit before starting. An exact, durable terminal-run receipt replaces that reservation with observed calls and elapsed time rounded up to whole minutes, including cancelled, failed and stopped runs. Original allocation fields and historical mission budgets remain saved. Unknown or interrupted launches remain fully reserved even after seven days; missing evidence never becomes zero usage. Legacy runs can gain additive usage receipts without resetting their history. Increase budgets deliberately in the mission editor when the defaults do not fit your cadence.

## What a cycle does

Discovery uses read-only Auto team workers, a separate structured report turn, then an independent reviewer. It returns at most three opportunities with source quotes, affected users, a proposed change, expected benefit, risk and acceptance criteria. Empty findings are a valid result. Discovery does not run setup, checks, proof writers or code repairs.

The host verifies quotes at the pinned Git commit, suppresses previously reported problems, and ranks eligible proposals deterministically. Automatic implementation requires allowed category/paths, low risk, sufficient confidence/alignment, and a required verification profile. Hypotheses require the explicit experiment category. A cycle can build only one proposal; reports with uncertain evidence remain proposals.

Implementation uses a fresh ordinary Auto team within its reserved budget. File, path and line limits are checked before commits and publication. A result becomes **ready** only when required checks and the independent review refer to the final branch commit. Existing fail-to-pass proof settings still apply. Failures and stale results remain visible with a reason.

There is one active cycle per repository, at most two unresolved implementation results, and at most 12 open opportunities. Unchanged inputs skip agent work until the rescan interval (28 days by default). Relevant owner decisions, local activity, configuration or base changes permit new discovery. An unchanged failed automatic cycle needs an explicit owner retry or changed inputs.

## Review and feedback

Project → Automation → Pursue a mission contains the full opportunity cards, cycle history, selection reasons, budgets and links to existing run diffs/checks. Project Overview and the global Inbox contain compact links to actionable mission opportunities. Their approval and evidence requirements stay the same.

- **Build proposal** allocates a bounded whole Auto team. High-risk, unsupported or stale work requires a revised mission or an ordinary owner-directed task.
- **Request revision** records feedback and launches a fresh bounded whole team from the pinned base, with the previous result referenced as evidence. It does not silently continue a single writer or refresh the old run's allowance.
- **Approve this commit** accepts the exact reviewed result. Open that run to use the existing PR or merge controls. Approval alone does not ship anything. A successful local merge is recorded as shipped; opening a PR is not counted as shipped.
- **Defer one week** retains the idea and feedback; once due it may be rediscovered. **Reject** suppresses the problem in later discovery. Owners may explicitly reconsider a saved proposal.
- **Pause** prevents new cycles and the next implementation stage. An already running discovery may finish into proposals. **Stop cycle** cancels owned work, retaining unresolved reservations. **Archive team** stops scheduling and retains its history.

Changing execution policy makes previously ready/accepted results require new verification. Changing only the schedule, recurring-discovery toggle or assignment name preserves those results and can be done during a cycle. The current schedule is stored separately; historical mission and cycle snapshots retain their original timing. Full-mission schedule updates from older clients receive the same behavior. Moving a result branch after review invalidates readiness. Generic run resumes, selective reruns, writer follow-ups, automatic PR-fix watchers and triage revision shortcuts are blocked for managed runs; use the project mission's revision controls.

Project mission runs can be archived individually or in a sidebar selection. Settled mission runs can be deleted once their cycle has ended and its usage receipt is saved, including blocked discovery attempts. Runs still needed for cycle recovery or budget accounting remain protected, as do implementation results awaiting approval or shipping; archive those runs instead. Deleting the original project also deletes all its run history, including archived mission runs; active runs must be stopped first. Runs left behind by older versions can still be deleted individually or in bulk. This removes their conversation and run history while keeping the mission's saved records, budget accounting, Git branches and worktrees. Ordinary runs still support individual and bulk deletion. The mission editor's searchable model picker includes the same free-model filter and badges as the composer; its selections update only that team's mission.

Existing notification destinations receive actionable cycle outcomes using their saved event/project scope. Child completions and no-op cycles do not produce duplicate alerts. Destinations remain opt-in.

## Recovery and storage

Team aggregates are private files under `$CODEFLOW_HOME/project-teams/`. Each mutation validates and fsyncs its snapshot before acknowledgment. A cycle claim and its full budget allocation are saved before starting a run; the initial run identity is fsynced and attached to the claim before any agent dispatch.

Recovery adopts only a matching team/cycle/claim/input/attempt receipt. An ambiguous launch is marked **unknown** and is never automatically replayed. Inspect its run and host process state, then stop the cycle if abandoning it; stopping does not pretend unknown usage is zero. A storage error remains visible, and corrupt team files are preserved for repair. Duplicate repository ownership blocks both records.

On first load, legacy assignments gain a shared Git metadata identity. This additive upgrade preserves their IDs, immutable mission/cycle history, operation receipts and usage. Linked worktree aliases cannot acquire separate ownership. Replacing a repository's Git metadata blocks dispatch rather than silently adopting the replacement. Reusable definitions are separate `at-*.json` files in the same directory, with at most 100 definitions, 100 versions per definition and a 2 MiB per-definition ceiling; damaged definitions are preserved and reported without preventing unrelated existing missions from loading. At the 100-version limit, create a new reusable team to keep editing; existing versions and operation replays remain available.

Automations stores only a managed target and a display projection. Mission settings remain authoritative in the team aggregate. Managed schedules cannot be edited through generic automation controls. Schedule occurrences use stable operation IDs, so replaying a due occurrence cannot launch a second cycle. The existing one-hour missed-run grace and DST rules apply.

History is bounded to 100 cycles, 200 opportunities, 2,000 decisions and 2,000 operation receipts, with a 16 MiB aggregate ceiling. At the limit, archive the team and retain its file before creating a replacement. History is not silently pruned; rejection feedback is never silently forgotten within a team.

Backups include team evidence and missions. Restore pauses teams, cancels active cycle admission while retaining unknown reservations, and invalidates ready/accepted results. Inspect repository membership, providers and retained receipts before reactivation. ACP executable settings and other existing credential exclusions remain excluded from portable backups.

Owner APIs, managed child runs and the project-scoped event topic are unavailable to shared accounts, because the child tasks include private owner mission and decision context. Custom filesystem restrictions block the feature alongside other host execution/private-data surfaces. Removing project membership stops owned work. There is no cloud scheduler or new agent runtime.

## API

All saved mutations use a client-generated `operationId`. Team edits and opportunity decisions require the current `revision`; opportunity decisions also require `opportunityRevision`. A replay with the same operation and content is idempotent; changing its content or acting on a stale revision returns a conflict. Draft generation is a cancellable model request and creates no saved mission. It shares prompt improvement's private workspace, execution lease, provider quota handling and concurrency limit; AI output cannot set executable commands or execution policy.

| Method and path | Purpose |
|---|---|
| `GET /api/project-teams?project=ID` | Scoped assignments, reusable team summaries, storage faults and provider eligibility |
| `GET /api/project-teams/defaults?project=ID&repo=PATH` | Detect editable branch, verification and setup defaults for a project repository |
| `POST /api/project-teams/draft` | Draft prose from projectId, repo, text and optional agent; returns draft and agent without saving |
| `GET /api/project-teams/definitions` | Reusable team summaries and definition storage faults |
| `GET /api/project-teams/definitions/:id` | One definition and its retained versions |
| `POST /api/project-teams/definitions` | Create from name/configuration, or name/sourceTeamId |
| `POST /api/project-teams/definitions/:id` | Save a new version with revision, name and configuration |
| `POST /api/project-teams` | Create a draft with projectId, repo, name, mission, optional definition `{id, revision}` and scheduleEnabled |
| `GET /api/project-teams/:id` | Aggregate and remaining allowance |
| `POST /api/project-teams/:id` | Update mission/name/status, schedule/scheduleEnabled or adopt a definition with revision; definition `null` detaches the reusable reference while keeping configuration |
| `POST /api/project-teams/:id/tasks` | Admit an owner task with revision, title, instructions, acceptance array and optional category |
| `GET /api/project-teams/:id/preview` | Readiness and schedule preview without model calls |
| `POST /api/project-teams/:id/cycle` | Explicit cycle admission |
| `POST /api/project-teams/:id/stop` | Stop owned cycle with revision |
| `POST /api/project-teams/:id/opportunities/:opportunityId` | approve, build, revise, reject or defer |

The existing stream broker multiplexes `project-teams:<projectId>`. Generic run bodies cannot supply managed metadata or launch callbacks.

## Validation and rollout

`npm run evaluate:project-teams -- --fake --cycles 10 --out /tmp/my-standing-pilot` exercises two isolated fixture repositories and saves a report plus private run evidence. The default is synthetic. `--real --confirm` explicitly opts into signed-in CLI use, capped at 24 invocations and 60 allocated minutes per cycle. Use `--help` first. Neither mode merges or pushes. Provenance is checked before running: a source archive records `applicationRevision: "unknown"` and `applicationDirty: null` in fake mode; real mode requires a committed Git checkout. A cycle or shutdown failure still writes completed-cycle evidence and its error to the report. Repository trees unavailable at reporting time are null.

Tests cover the full cycle, exact-commit approval, scope violations, failed checks, provider exclusions, budget limits, duplicate admission, durable receipt failure, restart adoption/ambiguity, cancellation, membership removal, feedback retention, storage corruption, restored authority, notifications, owner-only APIs, filesystem restrictions and shared browser transport.

The initial synthetic ten-cycle pilot produced two ready drafts and eight no-ops across two fixture repositories. It establishes mechanics only. Real-provider quality, novelty, usefulness and owner acceptance have not been measured; keep the flag opt-in until that separate pilot is assessed.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)
