# CLI conversation UX implementation

Status: implemented (2026-11-04). Validation evidence is recorded in [the QA report](../qa-dogfood/cli-ux-2026-11-04.md).

## Scope and sequence

1. Share readable response formatting between the terminal and MCP while retaining the structured protocol, exact references, pagination and private claim fields.
2. Derive progress from execution state: active work, worker-slot queue, questions, host assignments, pause settling, recovery and completion. Report guidance delivery accurately.
3. Supply continuation context and add `context.reuseRunId` to resolve the previous deliverable, preserved source, chat and matching participant settings on the server. Revalidate source; require a new accepted proposal.
4. Provide an explicit result handoff: evidence summary, worktree/branch, paginated diff and preview-bound application into a clean project checkout. Apply only the task delta, stage it without committing, reject conflicts/stale previews, and reconcile repeats through durable receipts. Native confirmation and terminal confirmation authorize the exact application separately from execution.
5. Put the deliverable, source, workers, commands and limits first in a compact proposal summary; retain full configuration in exact-revision approval.
6. Report live connection and installed configuration health during host discovery. Improve terminal doctor and setup guidance without inference calls.

## Validation

- Focused unit and service tests for state precedence, continuation isolation/staleness, readable responses, pagination, delivery, onboarding and handoff protections.
- Real stdio MCP and loopback transport tests, including native confirmation accept/decline, retries and conflict handling.
- CLI subprocess checks and Git fixtures covering actual applied changes and independent verification.
- Existing browser/workspace, approval, recovery and installer regressions; typecheck, build and broader automated tests.
- A bounded real-provider smoke run when the installed authenticated providers are available. Record separately from deterministic tests; never describe fixtures as real-provider evidence.

## Acceptance

A user can discover the connection, propose and approve work, understand progress, continue a plan without reconstructing references, retrieve the full result and inspect/apply its exact changes from the CLI. Browser and native sessions retain shared execution state. Read-only inspection never starts workers or modifies the checkout. Approval, scope, source, identity and accounting protections remain enforced by the service.
