# CLI teams: implementation design

Status: proposed implementation specification. Created 2026-10-29.

Code Flow coordinates agents from multiple providers inside the CLI conversation a user already uses. Providers perform the reasoning and work; Code Flow owns workflow transitions, durable assignments, revision tracking, verification, and recovery.

This pack describes work to implement. New commands, MCP tools, graph schemas, and source modules below are proposed interfaces, not features already shipped. Source links identify existing foundations inspected while preparing this design. No application implementation is included in this folder.

## Read and build in this order

| Document | Purpose |
| --- | --- |
| [01 — Requirements](01-requirements.md) | User journeys, V1 scope, acceptance requirements, and exclusions |
| [02 — System architecture](02-system-architecture.md) | Components, process ownership, deployment, and reuse boundaries |
| [03 — Domain model](03-domain-model.md) | Versioned entities, typed artifacts, identities, and state machines |
| [04 — Workflow graphs](04-workflow-graphs.md) | Graph grammar, loops, parallelism, gates, and scheduling semantics |
| [05 — Participants and providers](05-participants-and-providers.md) | Current-session and managed-worker execution contracts |
| [06 — MCP contract](06-mcp-contract.md) | Public tool inputs, outputs, errors, limits, and authorization |
| [07 — CLI and project setup](07-cli-and-project-setup.md) | Installation, project files, saved teams, host skills, and everyday usage |
| [08 — Workspaces and verification](08-workspaces-and-verification.md) | Snapshots, file ownership, checks, review evidence, and delivery |
| [09 — Durability and recovery](09-durability-and-recovery.md) | Journal ownership, idempotency, leases, cancellation, and crash handling |
| [10 — Approval, permissions, and budgets](10-approval-permissions-and-budgets.md) | Human acceptance, execution boundaries, limits, and honest accounting |
| [11 — Implementation plan](11-implementation-plan.md) | Dependency-ordered work packages, repository touchpoints, and exit gates |
| [12 — Test and release plan](12-test-and-release-plan.md) | Fault matrix, end-to-end scenarios, compatibility evidence, and release checklist |
| [13 — Worked examples](13-worked-examples.md) | Complete proposed definitions and user/MCP interaction scenarios |
| [14 — Decisions and risks](14-decisions-and-risks.md) | Architectural decisions, unresolved integration probes, and deferred scope |

## Core decisions

1. One local runner owns execution state; CLI, MCP, and the existing UI are clients of that same owner.
2. Agent profiles, role contracts, team definitions, workflow definitions, proposals, and runs are separate objects.
3. A workflow references roles and typed artifacts, not provider names.
4. Multiple agents can fill a role, including multiple models from the same provider.
5. The current CLI can participate cooperatively. It is not a managed process, and its permissions, model, and effort must not be assumed controllable.
6. The user reviews a concrete proposal before paid workflow execution. An agent review verdict is never human authorization.
7. Graph cycles exist only through bounded loop nodes. Agent-generated workflow definitions use the same validator as manually authored definitions.
8. Artifacts and approvals refer to exact revisions and code snapshots.
9. Reuse the existing provider adapters and persistence primitives. Do not create a second scheduler or store that competes with RunManager for the same run.
10. Ship three workflows first: plan agreement, agreed-plan implementation, and review/fix of existing work. Multiple planners/reviewers are V1; concurrent builders in one run are not.

## Completion bar

The project is complete only when both native CLI integrations pass the release gates in [12](12-test-and-release-plan.md), including actual artifact delivery, current-session participation, restart recovery, safe approval handling, and preservation of user changes. Do not describe a fixture-only demo as a supported live integration.

A saved template is reusable configuration. An accepted run is an immutable configuration snapshot plus evolving execution state. Neither provider changes nor mutable defaults may silently change that accepted snapshot.

## Documentation conventions

- MUST denotes a release requirement; SHOULD denotes the recommended implementation unless an explicit decision records an alternative.
- Paths under `src/cli-teams/` and new integration directories are proposed module locations.
- Example model IDs are fixture identifiers; resolve real models from live provider discovery before actual execution.
- Commands labeled proposed are specification examples. This pack does not authorize live provider calls, installation, deployment, or publishing.
- The folder is an engineering design pack, linked internally for repository use. Publishing it in the product's documentation navigation is a later implementation task.
