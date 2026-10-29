# Implementation plan

Status: proposed. [Index](README.md)

Build these work packages in dependency order. The checkboxes are intentionally unchecked: this documentation does not claim the feature is implemented. Each package includes implementation, meaningful tests, and user-visible failure behavior. Avoid starting with a visual workflow editor or a second orchestration service.

## P0 — Prove the host integration boundaries

Dependencies: none.

- [ ] Record supported Claude/Codex CLI versions and native project skill/MCP behavior.
- [ ] Build an isolated fixture bridge that can propose, start, report progress, and return a plan artifact.
- [ ] Prove a host can claim and submit a planning/review step with exact input references.
- [ ] Determine whether model/effort and workspace metadata are verified, reported, or unavailable.
- [ ] Prove the acceptance signal; implement interactive terminal acceptance as the fallback.
- [ ] Demonstrate disconnect/reconnect behavior without assuming unsolicited host notifications.
- [ ] Confirm worker configuration can exclude the public host connector and avoid recursive team creation.

Touchpoints: existing adapters, model discovery, internal MCP clients, host skills in proposed `integrations/claude-code/` and `integrations/codex/` directories. Keep probes in isolated test directories and use explicit small live-call budgets.

Exit: a compatibility matrix with observed evidence for both CLIs. No product claim depends on an unverified host capability. If host writing cannot be coordinated, ship managed builders and cooperative host planning/review first; do not block the whole feature or pretend host write isolation works.

## P1 — Versioned contracts and schema validation

Dependencies: P0 decisions.

- [ ] Implement types and runtime schemas for all entities in [03](03-domain-model.md).
- [ ] Implement canonical hashes, IDs, immutable version refs, and expected-revision conflicts.
- [ ] Validate role cardinality, provider/model/effort selections, capabilities, and policies.
- [ ] Implement typed artifacts, review submissions, finding lifecycle, and gate outcomes.
- [ ] Convert [13](13-worked-examples.md) into fixtures, with fake provider catalogs.

Proposed files: `src/cli-teams/model.ts`, `validation.ts`, `schemas/`, `artifacts.ts`.

Exit: valid examples round-trip, malformed/unsupported input fails before side effects, and all public structures have size bounds and unknown-field policy.

## P2 — Durable application service and owner lifecycle

Dependencies: P1.

- [ ] Add the single runtime owner/discovery lock and authenticated project-scoped bootstrap.
- [ ] Create the shared command service used by both CLI and MCP.
- [ ] Implement durable idempotency receipts and per-run serialized mutations.
- [ ] Persist graph transitions in the existing recovery journal namespace; derive legacy run projections.
- [ ] Implement artifact-before-reference durability and crash reconciliation.
- [ ] Preserve legacy runs and existing `codeflow client` behavior.

Touchpoints: [engine.ts](../../src/engine.ts), [store.ts](../../src/store.ts), [server.ts](../../src/server.ts), [bin/launcher.mjs](../../bin/launcher.mjs). Proposed files: `service.ts`, `runtime.ts`, `reducer.ts`.

Exit: duplicate starts return one run; two simultaneous bootstrap attempts create one owner; lost responses and storage faults do not acknowledge nonexistent work. Existing dashboard and headless entry points cannot independently own the same run store.

## P3 — Graph compiler and execution

Dependencies: P1, P2.

- [ ] Implement the seven node types and deterministic role fan-out.
- [ ] Implement acyclic validation and explicit bounded loops, with no arbitrary evaluator.
- [ ] Resolve typed inputs and immutable per-iteration reviewer rosters.
- [ ] Implement exact-target plan agreement and build completion gates.
- [ ] Add provider capacity, per-project fairness, workspace ownership, and budget reservation.
- [ ] Persist readiness, dispatch intent, completion, gate decisions, and next iteration before dependent work.

Touchpoints: [team-scheduler.ts](../../src/team-scheduler.ts), [patterns/index.ts](../../src/patterns/index.ts), existing verification/finding helpers. Proposed files: `compiler.ts`, `executor.ts`, `gates.ts`, `budgets.ts`.

Exit: the three V1 workflows execute against fake providers through one engine, including multiple planners and models. A stale vote or check cannot pass a gate. Infinite cycles, oversized fan-out, impossible independence, and insufficient budgets fail admission.

## P4 — Provider and host participants

Dependencies: P2, P3.

- [ ] Wrap existing adapters with participant/attempt identity and output schemas.
- [ ] Implement exact session continuation per role and portable checkpoint fallback.
- [ ] Implement connection-bound host claims, renewal, revocation, and submission fencing.
- [ ] Implement explicit managed-worker substitution when a host cannot satisfy pinned settings or workspace requirements.
- [ ] Normalize authentication, rate-limit, unsupported-setting, stalled, and uncertain-process outcomes.
- [ ] Keep public owner tools out of managed workers.

Proposed file: `participants.ts`; extend adapter integration without duplicating vendor process code.

Exit: both live providers can plan/review with explicit supported settings; separate same-provider participants retain distinct identities; host disconnect never releases an uncertain writable workspace.

## P5 — Workspace snapshots, checks, and results

Dependencies: P3, P4.

- [ ] Capture committed and working-change baselines without changing the user's index or files.
- [ ] Verify before/after snapshot fingerprints and repository identity.
- [ ] Use owned worktrees for managed implementation and immutable review targets.
- [ ] Associate checks and review artifacts with exact code snapshots.
- [ ] Preserve existing test-integrity/reproduction checks where applicable.
- [ ] Assemble complete result artifacts and no-change/unverified explanations.

Touchpoints: [git.ts](../../src/git.ts), [checks.ts](../../src/checks.ts), [patterns/findings.ts](../../src/patterns/findings.ts), [team-responses.ts](../../src/team-responses.ts).

Exit: existing dirty work is reviewed accurately and preserved; check-unavailable is never success; final output contains the deliverable rather than only orchestration commentary.

## P6 — Public MCP and native host skills

Dependencies: P2–P5.

- [ ] Implement all twelve tools from [06](06-mcp-contract.md).
- [ ] Add protocol negotiation, structured/text responses, argument bounds, cursors, and bounded waits.
- [ ] Implement proposal preview and revision-bound acceptance.
- [ ] Implement consistent error codes and actionable next steps.
- [ ] Author host skills for setup, proposal, participation, result retrieval, and explicit user steering.
- [ ] Add host integration tests that exercise real conversation entry and result display.

Proposed file: `mcp.ts`; proposed packaged skill sources under `integrations/claude-code/` and `integrations/codex/`.

Exit: a user can begin from either CLI and finish without the dashboard. If a host requires terminal acceptance fallback, onboarding and tests disclose that interaction rather than claiming an unsupported native approval integration.

## P7 — Project installation and saved presets

Dependencies: P1, P6.

- [ ] Add proposed commands to the existing launcher with backward-compatible routing.
- [ ] Implement idempotent project setup, config merging, owned-entry uninstall, and doctor.
- [ ] Add portable project profile/team/workflow files with local overrides outside Git.
- [ ] Support save-from-proposal, immutable versions, and per-run overrides.
- [ ] Package skills/bridge/runtime files through the existing release builder.
- [ ] Ship Plan, Feature, and Review starter workflows; offer Fix as a parameterized preset.

Touchpoints: [bin/launcher.mjs](../../bin/launcher.mjs), [scripts/package-npm.mjs](../../scripts/package-npm.mjs), [team-template-store.ts](../../src/team-template-store.ts). Proposed file: `install.ts`.

Exit: installation preserves existing MCP entries; a teammate can clone definitions, install the compatible release, authenticate providers, and run doctor. Uninstall leaves unrelated configuration and work intact.

## P8 — Recovery, scale, and release evidence

Dependencies: all prior packages.

- [ ] Complete the fault and compatibility matrix in [12](12-test-and-release-plan.md).
- [ ] Measure bounded parallel scheduling, cancellation latency, journal replay, and event pagination.
- [ ] Verify current-session accounting limitations and fallback behavior are visible.
- [ ] Run existing relevant regression suites and package checks.
- [ ] Produce release notes and actual supported-version evidence.
- [ ] Complete one real task per flagship workflow from each host with an explicit small test budget.

Exit: all release requirements passed, no unresolved state-corruption or workspace-safety defects, and every supported path has observed evidence.

## Suggested reviewable change sequence

1. Contracts, fixtures, and reducer tests.
2. Runtime ownership and persistence service.
3. Graph compiler, gates, and fake-provider execution.
4. Managed participants, then host participation.
5. Workspaces/checks/result artifacts.
6. MCP/skills and confirmation path.
7. Installer/presets/package integration.
8. Recovery hardening, live evidence, and documentation.

Each change should leave legacy execution usable. Keep graph execution opt-in until release gates pass. Do not migrate historical run semantics merely to make the new schema uniform.
