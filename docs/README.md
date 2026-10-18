# code-flow docs

- [Getting started](getting-started.md): install, sign in, your first run, giving agents context, models and effort, worktrees and branches.
- [Team patterns, checks and limits](patterns.md): manual patterns, Auto roles, and the loop code-flow runs around the agents.
- [Auto team](auto-team.md): dynamic team creation, dependency workflows, member communication, private/team/project memory, and recovery.
- [Runs](runs.md): the run view, talking to a running team, replies, projects, the side panel (chat, files, terminal, browser, notes), restarts and resume, Insights.
- [GitHub, review and shipping](github.md): review and merge results, start from issues and PRs, review councils, PR follow-through, untrusted text.
- [Automations and away mode](automations.md): schedules, webhooks, the inbox, Docker isolation, the phone view.
- [Configuration](configuration.md): `.codeflow/config.json`, permissions, health, environment variables.
- [Security, subscriptions and caveats](security.md): how the CLIs and their logins are used, what runs where, known limits.
- [Verification profiles](verification.md): required gates, baseline/flaky diagnosis, requirements, human review and merge-target checks.
- [API and CLI](api.md): authenticated versioned operations and the local HTTP client.
- [Agent containers](agent-containers.md): explicit images, authentication volumes, filesystem mounts and cancellation.
- [Service launch profiles](launch-profiles.md): named dependent services, readiness, logs and cleanup.
- [Dependency discovery](dependency-discovery.md): explicit Git, provider, terminal, browser and Docker readiness checks.
- [Selective task reruns](task-reruns.md): pinned baselines, downstream resets and fresh final verification.
- [Deferred starts](deferred-runs.md): durable start conditions, quota windows and ambiguous-launch recovery.
- [Context inspection](context-inspection.md): folder previews, explicit input budgets and recorded measurements.
- [Project conventions](project-conventions.md): private version history and guarded publication to committed instructions.
- [Commit comparison and revert](checkpoint-review.md): complete comparisons and reviewed staged inverse changes.
- [Review inbox](review-inbox.md): grouped and prioritized attention across manual and unattended runs.
- [Code intelligence](code-intelligence.md): isolated JavaScript/TypeScript symbol and reference resolution.
- [VS Code integration](../integrations/vscode/README.md): local authenticated task creation, run inspection and result worktrees.
- [External sources](external-sources.md): read-only GitLab, Bitbucket, Linear and Jira imports.
- [Notifications](notifications.md): opt-in outbound destinations, scopes, retries and delivery history.
- [Backup and maintenance](maintenance.md): encrypted recovery, safe restore, retention, compaction and startup checkpoints.
- [Application improvement checklist](application-improvements.md): implemented behavior, partial coverage and remaining roadmap work.
- [Architecture and development](architecture.md): the code layout, adding patterns and agents, the dev server, tests, what's next.
- [Dynamic teams implementation plan](dynamic-teams-implementation-plan.md): architecture, completed P0–P8 packages, and evaluation gates.
- [Dynamic team implementation evidence](dynamic-teams-evaluation.md): automated checks, real CLI trials, comparison measurements and the rollout decision.
- [Review 1 of the implementation](dynamic-teams-implementation-review-1.md): what was fixed, what remains open, and what to avoid.
- [Review 0 of the plan](dynamic-teams-plan-review-0.md): the original plan review that re-sequenced the work.

Back to the [README](../README.md).
