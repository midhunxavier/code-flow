# Public MCP interface

Status: proposed. [Index](README.md)

## Connection and authority

One project-scoped public MCP bridge exposes the host tools. Bootstrap binds the canonical repository identity, local owner, installation identity, and host connection generation. Repositories and actors are not selected by arbitrary tool argument paths. Managed workers use a narrower internal interface and never inherit these owner-level tools.

MCP version/capability negotiation follows the installed host's supported protocol. V1 needs only ordinary tools and bounded polling; sampling, host callbacks, background notifications, and MCP task extensions are optional enhancements, never correctness dependencies.

## Common contract

All tools return versioned structured content plus a concise text rendering. Use `protocolVersion: 1` for the Code Flow application contract, separate from the negotiated MCP protocol version.

Mutating tools require `operationId`. Edits to an existing mutable object additionally require `expectedRevision` or `expectedVersion`. The server stores the operation's scope, canonical argument digest, and receipt durably. Same ID/same payload returns the original receipt; same ID/different payload returns `idempotency_conflict`. There is no implicit second run on retry.

```json
{
  "protocolVersion": 1,
  "ok": true,
  "operationId": "operation-123",
  "data": {"runId": "run-123", "revision": 1, "state": "ready"}
}
```

Errors use `ok: false`, a stable `error.code`, readable `message`, `retryable`, and optional structured `details`/`nextAction`. Domain errors are also marked as MCP tool errors. Never expose credentials, raw provider auth output, or unrestricted local paths in errors.

## Tool definitions

| Tool | Arguments beyond common fields | Result and behavior |
| --- | --- | --- |
| `codeflow_list_providers` | optional `refresh` | Bounded readiness/capability records; no paid inference |
| `codeflow_list_models` | `providerId`, optional `cursor`, `limit`, `refresh` | Available models, supported efforts, defaults/provenance, next cursor |
| `codeflow_list_teams` | optional `scope`, `cursor`, `limit`, `includeHistory` | Team definitions with pinned workflow/profile refs and version summaries |
| `codeflow_propose_team` | `task`, explicit `context`, optional `teamRef`, `workflowRef`, `candidate`, `overrides`, `proposalId` | New immutable proposal revision, validation findings, readable preview, unresolved inputs, acceptance instructions |
| `codeflow_save_team` | `sourceProposalRef` or `definition`, `scope`, `name`, optional existing `teamId`, `expectedVersion` | Validated immutable saved version; excludes task-specific history, host connection IDs, credentials, and runtime state |
| `codeflow_start_run` | `proposalId`, `expectedRevision`, `proposalHash` | Checks stored user acceptance and readiness; returns stable run ID promptly; no `approved: true` argument |
| `codeflow_get_run` | `runId`, optional `afterCursor`, `limit`, `waitMs` | Current state/revision, incremental events, ready host assignments, questions, artifact refs, usage provenance |
| `codeflow_claim_step` | `runId`, `stepId`, `expectedRevision` | Atomic claim for the bound host participant; assignment, exact inputs, opaque claim token and deadline |
| `codeflow_submit_step` | `runId`, `stepId`, `attemptId`, `claimToken`, `inputRefs`, typed `output` | Validated durable outcome receipt; rejects stale target, wrong participant, expired/revoked attempt, or invalid schema |
| `codeflow_get_artifact` | `runId`, exact `artifactRef`, optional `cursor`, `maxBytes` | Typed content plus readable body, integrity metadata, and continuation cursor |
| `codeflow_steer_run` | `runId`, `expectedRevision`, `message`, optional `questionId` | Instruction/answer receipt or new proposal revision if scope/configuration changes; never implicitly increases authority |
| `codeflow_control_run` | `runId`, `expectedRevision`, `action: pause|resume|cancel`, optional `reason` | Durable control receipt, effective state, active/uncertain work, and next action |

For `propose_team`, an existing `proposalId` requires `expectedRevision`; a new proposal does not. For `save_team`, `expectedVersion: 0` means create. Run-wide revisions may change while workers run; clients refresh after a conflict instead of guessing a revision.

A claim token binds the accepted step and attempt, so `submit_step` need not require the latest global run revision. This avoids unrelated parallel completions invalidating an otherwise correct submission. Relevant configuration/input changes revoke the token.

`get_artifact` takes an exact reference; “latest” is resolved by `get_run`, not by silently switching revisions during a paged read. Artifact pagination includes the fixed hash and byte offsets. Content caps must not cut UTF-8 characters or silently omit the end of a plan.

## Proposal generation

V1 uses the host's supplied structured candidate or validated template selection; it does not start an independent managed inference call while the user is still selecting a team. Schema repair happens in the host conversation. A later optional managed proposal generator needs an explicit preflight allowance.

The proposal response contains role assignments, actual/unknown settings, workflow stages, read/write scope, checks, lifetime limits, current-session limitations, and a stable hash. Missing required choices are returned as questions rather than guessed silently.

## Acceptance path

`start_run` cannot mint human acceptance. A separate trusted confirmation channel records acceptance for the proposal hash, project, policy revision, and bounded start window. Support a native host confirmation adapter only when its actual signal is tested. Otherwise show the terminal confirmation command from [07](07-cli-and-project-setup.md).

Neither `submit_step` nor `steer_run` can answer permission approval requests as the human. Agent findings and user decisions remain separately typed and attributed.

## Bounded responses and waiting

Suggested initial bounds: 64 KiB request payload, 32 KiB text page, 100 events/page, 50 models/teams per page, 25-second `get_run` wait, and four concurrent bridge requests. Host-authored text submissions are limited to 32 KiB in V1 and rejected with a precise size error if larger; they are never silently truncated. Managed outputs and code bodies can use engine-owned file capture. Large stored artifacts use paged reads under the artifact service. V1 does not include an arbitrary file-upload/path-read tool.

A waiter holds no worker slot. The bridge never waits for the entire workflow inside `start_run`. Long polling can end on state change, timeout, disconnection, or cancellation. Push notifications may improve responsiveness but the cursor API remains authoritative.

## Error codes

| Code | Required handling |
| --- | --- |
| `validation_failed` | Show field-level errors; no side effects |
| `revision_conflict` | Refresh the object and reapply intended changes |
| `idempotency_conflict` | Use the original operation receipt or a genuinely new operation ID |
| `acceptance_required` / `acceptance_stale` | Present the exact proposal for user acceptance |
| `provider_unavailable` / `unsupported_settings` | Explain missing backend/model/effort support |
| `permission_incompatible` | Select an allowed execution profile; never broaden permissions automatically |
| `claim_conflict` / `claim_revoked` | Stop host work and retrieve current assignment state |
| `artifact_stale` | Review/submit against the current required target |
| `budget_exhausted` | Preserve work; require an accepted extension to continue |
| `recovery_required` | Reconcile process/workspace state before redispatch |
| `storage_unavailable` | Stop new dispatch; retain the original operation ID for reconciliation |
| `scope_denied` | Do not retry against another project implicitly |

## Example host participation

1. Propose and preview a Feature team.
2. User accepts the displayed proposal through the supported confirmation channel.
3. `start_run` returns `run-123`.
4. `get_run` reports a ready host review assignment targeting plan v2.
5. `claim_step` binds that exact target and returns a token.
6. Host reads the artifact and submits a structured review.
7. Engine sends findings to the managed planner or advances after agreement.
8. Host retrieves the final artifact and displays its substantive content.

Every tool can be called repeatedly without changing meaning when its idempotency and revision rules are respected. Implement the contract with schema-driven tests; do not rely solely on the skill telling the model to behave correctly.
