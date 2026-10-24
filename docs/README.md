# Your agents. A clear path forward.

Code Flow brings coding CLIs into one workspace for planning, implementation, review and verification. Start with a small task, follow the evidence, and decide when the result is ready to ship.

<div class="cards">
<a href="getting-started.md"><strong>Start your first run ↗</strong><span>Install the app, connect a CLI and take a task from prompt to review.</span></a>
<a href="patterns.md"><strong>Choose a workflow ↗</strong><span>Plan and build, test first, compare candidates or ask a team to investigate.</span></a>
<a href="runs.md"><strong>Find your way around ↗</strong><span>Follow agent activity, ask questions and open files, changes and terminals.</span></a>
<a href="verification.md"><strong>Review with confidence ↗</strong><span>Understand checks, review evidence and when a result is ready to ship.</span></a>
</div>

## From task to reviewed result

1. **Open a project.** Choose Open repository, confirm its project, then describe the outcome and add context.
2. **Choose the team.** Assign roles yourself or review a proposed Auto-team plan.
3. **Follow the work.** Answer questions, inspect changes and watch the checks.
4. **Review and ship.** Read the evidence before merging or opening a pull request.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/run-dark.png">
  <img src="images/run-light.png" alt="The Code Flow workspace with a completed demo run and review actions." width="100%">
</picture>

*Captured from the local application with demo agents. See [screenshot provenance](documentation.md#screenshots).*

## Work with agents

- [Team patterns](patterns.md) · [Auto team](auto-team.md) · [Project missions](project-teams.md)
- [Runs and the workspace](runs.md) · [Review inbox](review-inbox.md) · [Verification](verification.md)
- [GitHub and shipping](github.md) · [GitHub review threads](github-review-threads.md)
- [Selective task reruns](task-reruns.md) · [Deferred starts](deferred-runs.md)

## Make the workspace yours

- [Configuration](configuration.md) · [ACP agents](acp-agents.md) · [Context inspection](context-inspection.md)
- [Project conventions](project-conventions.md) · [Checkpoints and reversions](checkpoint-review.md)
- [Service launch profiles](launch-profiles.md) · [Code intelligence](code-intelligence.md) · [Architecture explorer](architecture-explorer.md)
- [Project memory and knowledge graph](memory-storage.md) · [Semantic claim review](memory-claims.md)
- [Coordinated repository changes](coordinated-changes.md) · [Model training preview](model-training.md)

## Connect and collaborate

- [Team collaboration](team-collaboration.md) · [Shared project accounts](shared-projects.md)
- [SSH projects](ssh-projects.md) · [Remote workers](remote-workers.md)
- [GitLab and Bitbucket workflows](code-hosts.md) · [External sources](external-sources.md)
- [Automations and remote access](automations.md) · [Notifications](notifications.md)
- [VS Code integration](../integrations/vscode/README.md)

## Operate safely

- [Security and execution boundaries](security.md) · [Filesystem policies](filesystem-policy.md)
- [Agent containers](agent-containers.md) · [Filtered Docker tasks](filtered-tasks.md)
- [Dependency discovery](dependency-discovery.md) · [Backup and maintenance](maintenance.md)

## Build and extend

- [Architecture and development](architecture.md) · [API and CLI](api.md) · [Extensions](extensions.md)
- [Provider compatibility](provider-compatibility.md) · [Accessibility](accessibility.md)
- [Performance](performance.md) · [Run storage](run-storage.md)
- [Documentation and GitHub Pages](documentation.md)

## Engineering records

These documents record implementation decisions and evidence at a particular point in time. Use the guides above for current product instructions.

- [Application improvement program](application-improvements.md)
- [Project navigation review and implementation plan](project-first-navigation-plan.md) (proposed)
- [Dynamic-team evaluation](dynamic-teams-evaluation.md) and [implementation plan](dynamic-teams-implementation-plan.md)
- [Implementation review](dynamic-teams-implementation-review-1.md) and [original plan review](dynamic-teams-plan-review-0.md)
- [Standing-team implementation plan](project-teams-implementation-plan.md)
- [Local and remote ML automation implementation plan](ml-training-implementation-plan.md)
- [Measured performance](performance-results.md)

[Project README](../README.md) · [Getting started](getting-started.md)

Project collaboration lives in **More → Board** and **More → People**. Scheduled tasks, backlogs and missions live in **More → Automation**; configured Board and Automation tabs stay visible. Global Inbox and Scheduling cover the current computer.
