# Workspaces, context, and verification

Status: proposed. [Index](README.md)

## Repository identity and baselines

Resolve the canonical repository root through existing repository/Git helpers. Store identity independently from a user-facing path. Detect moved/replaced metadata before dispatch and recovery. A path that now points to another repository must not silently inherit the former run's authority.

Every run selects an explicit baseline mode:

| Mode | Meaning |
| --- | --- |
| `committed` | Exact commit/tree; excludes uncommitted changes |
| `working_changes` | Immutable capture of selected staged/unstaged changes and explicitly included untracked files |
| `artifact` | Prior code snapshot or agreed plan, checked against the current repository identity |

The proposal shows the selected mode. A user asking to review current changes should not accidentally receive a review of HEAD alone.

## Working-change capture

Capture the source without changing the user's branch, worktree contents, or index. Use private Git index/object operations or a bounded immutable manifest, building on existing snapshot helpers after auditing their semantics. Preserve base commit, source index state, selected path contents, and deletions in the manifest. Do not follow symlinks outside the authorized repository or copy ignored secrets by default.

Obtain before/after fingerprints while capturing. If the source changes during capture, reject the inconsistent snapshot and ask for a fresh one; do not silently mix versions. Coordination locks protect Code Flow operations, not external editors, so a lock alone is insufficient evidence.

Review and checks execute against the captured result. Later host edits do not retroactively change what was reviewed. Refreshing the snapshot invalidates dependent approvals/checks.

## Implementation workspace

Managed writes use a run-owned worktree and branch based on the accepted snapshot. Persist workspace ownership and base references before dispatch. Reviewers use an immutable checkout/snapshot; if they run reproduction tests, do so in a disposable verification workspace rather than editing the builder's workspace.

V1 allows one writer per run workspace. Readers may run concurrently only against immutable inputs. A writer lease is released only after the process and workspace outcome are known. Background commands spawned by a provider must be accounted for before declaring the workspace free.

The current host may implement only when a supported integration proves its active workspace is the run workspace and ownership is coordinated. Otherwise use a managed builder. Never tell the user that a read-only MCP assignment enforces read-only behavior on all native host tools.

## Context manifest

Record explicit task text, requirement references, selected files or attachments, relevant repository instructions, baseline snapshot, and prior artifacts. Each item includes origin, content hash/version, access scope, and inclusion reason. Provider conversations and credentials are excluded unless a user explicitly supplies a portable excerpt appropriate for the task.

A review receives the original requirements, target artifact, relevant source, and verification evidence. It does not automatically receive the builder's private conversation. A fresh reviewer session should not be told that another reviewer already approved before it performs its independent assessment.

Enforce per-assignment context limits. Prefer requirement summaries and artifact references; fetch full evidence when needed. Truncation is explicit and must not remove acceptance criteria silently.

## Verification profiles

Reuse existing check/profile execution where it already enforces workspace and permission constraints. A profile is versioned and accepted with the proposal. Record check command, required/optional status, timeout, expected environment, and requirement coverage.

Planning and proposal-only workflows do not run repository setup or a full test suite by default. Readiness inspection distinguishes “needed to inspect/plan” from “needed to build/test.” A missing Docker daemon must not prevent a source-only design review unless the accepted workflow actually requires it.

Checks yield `passed`, `failed`, `unavailable`, or `cancelled`. Record code snapshot, profile hash, environment fingerprint, output, exit status, and timing. A baseline environment failure is not evidence that new code is correct; it is an explicit verification gap.

Required verification unavailable -> waiting/stopped with an unverified result. Changing a required check into an optional check requires an accepted policy revision. Failure does not authorize rewriting the check configuration to make the result pass.

## Review and repair

Code reviewers inspect requirements and current changes, not just compliance with the plan. Use existing finding validation and reproduction helpers where applicable. False positives may be disputed with evidence; they do not have to be “fixed” by unnecessary code changes.

The repair assignment carries stable finding IDs, exact targets, and reproduction evidence. A new implementation produces a new code snapshot. Relevant checks and required review rerun against that snapshot. Prior green checks on a different hash cannot satisfy the final gate.

Protect test integrity using existing mechanisms, including detection of deleted/skipped tests and weakened assertions. Apply fail-to-pass proof where meaningful for the task; documentation changes and non-behavioral work need an explicit appropriate verification strategy rather than artificial tests.

## Delivery and cleanup

Final results include actual output, baseline/target references, changed files, checks, review decisions, remaining findings, and worktree/branch location. Plan-only results include the complete agreed plan. No-change results explain the cause and evidence.

Do not merge, push, deploy, or remove the user's current changes as part of generic completion. Such actions need a separate explicit request and their existing application checks. Cleanup is separate from completion and cancellation. It refuses active or uncertain ownership and preserves artifacts needed for recovery.

Existing foundations: [git.ts](../../src/git.ts), [checks.ts](../../src/checks.ts), [patterns/findings.ts](../../src/patterns/findings.ts), [patterns/prompts.ts](../../src/patterns/prompts.ts), [run-permissions.ts](../../src/run-permissions.ts).
