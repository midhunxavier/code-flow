# Durability, concurrency, and recovery

Status: proposed. [Index](README.md)

## One authoritative execution log

Reuse durable append/fsync primitives from [store.ts](../../src/store.ts). The current system has a run event stream plus a recovery journal. For graph-backed runs, graph transitions and command receipts are authoritative in the recovery journal under a new versioned namespace. Run event snapshots are derived projections for existing UI/history consumers. Do not update one projection and assume the other committed atomically.

One runtime owner per canonical state directory and one serialized mutation queue per graph run enforce command ordering. Existing per-process queues alone do not prevent two processes writing the same file, so the runtime owner lock is mandatory. The lock must validate owner identity/liveness; never remove it merely because a stored PID could have been reused.

Each authoritative record includes schema version, run ID, sequence, command/operation ID where applicable, expected prior revision, event type, and complete transition payload. Replay validates sequence and schema. Derived indexes/snapshots can be rebuilt; corrupt authoritative records cannot be silently skipped.

## Mutation algorithm

1. Authenticate the connection and resolve project/run authority.
2. Enter the serialized run mutation queue.
3. Look up the operation ID and payload digest. Return the original receipt or reject a conflicting reuse.
4. Check expected revision, policy, participant claim, input revisions, and budgets.
5. Write any immutable artifact body to a private temporary file, sync it, rename atomically, and sync the containing directory where supported.
6. Append one authoritative transition containing artifact references, state effects, and the operation receipt; await durable completion.
7. Update in-memory projections and publish events.
8. Only now acknowledge success or admit dependent dispatch.

If a crash occurs after artifact write but before the journal transition, the orphan is not visible as accepted output. Garbage collection may remove it after recovery and a retention delay. If the journal commits but the response is lost, replaying the same operation ID returns the committed receipt.

## Dispatch protocol

Persist `dispatch_intent` with attempt ID, participant, workspace, input hashes, settings, policy revision, and reserved budget before spawning. Record observed process/session identity as soon as available. Record the terminal outcome durably before releasing ownership and unlocking dependencies.

A crash between spawn and identity persistence leaves an uncertain attempt. Search only within runtime-owned process/workspace records; absence of a provider session ID is not proof the process never started. Do not blindly relaunch a writer.

Exactly-once graph transition acknowledgement is an application objective. Exactly-once shell commands, network effects, or provider inference cannot be guaranteed. Recovery must explicitly account for the gap between external effects and recorded outcomes.

## Claim and fencing rules

Host claims and managed attempts have unique tokens/generations. The server accepts output only from the current attempt and exact input set. Revoked/older generations may not publish new authoritative results.

A lease protects coordinator ownership, not the operating system from an already-running process. On expiry, mark uncertain, fence submissions, and reconcile before handing a writable workspace to another participant. Never assume an old agent stopped because its token expired.

Read-only claims can be cancelled and reissued after revocation if their input snapshot remains valid. Their old results remain rejected even if they arrive later.

## Failure matrix

| Crash/failure point | Recovery |
| --- | --- |
| Before start transition commits | No run is started; retry same operation ID |
| Start committed, response lost | Return same run ID and receipt |
| Artifact written, transition absent | Artifact stays unreferenced; no downstream step |
| Transition committed, event projection missing | Rebuild and republish projection from journal |
| Dispatch intent saved, launch uncertain | Reconcile process/workspace before retry |
| Provider finished, result not recorded | Inspect retained output/workspace; adopt only validated evidence or stop for recovery |
| Host disconnects while writing | Wait and inspect ownership; no automatic replacement writer |
| Storage unavailable | Stop new dispatch; preserve running process information and report uncertain outcomes |
| Truncated final record | Recover only under the existing tested tail-repair rules; never discard an acknowledged committed operation |
| Damaged interior record/new schema | Stop that run with recovery guidance; do not skip forward |
| Source repository changed/replaced | Block dispatch until identity and baseline are explicitly resolved |

## Pause, cancel, resume

Pause prevents new dispatch. It does not claim already-running processes stopped. Show active attempts and allow them to finish to a safe boundary unless the user separately requests cancellation.

Cancel records intent, revokes new claims, requests process termination through the adapter, and waits for bounded confirmation. Preserve files and artifacts. If termination is uncertain, retain an uncertain state and workspace ownership rather than showing a fully cancelled/free workspace.

Resume rebuilds state from the authoritative journal, reconciles outstanding attempts, rechecks capabilities and repository identity, and admits only unfinished work. Completed outcomes are reused without inference. Lifetime budget is preserved. Continuing after a limit requires a newly accepted allocation; retries and schema repairs count.

When a provider session cannot be resumed, portable artifacts may start a fresh role session after reconciliation. Do not substitute a provider-wide latest session.

## Scheduling and capacity

Use per-provider semaphores plus a machine concurrency ceiling. Waiting for a user, host, or retry deadline consumes no agent slot. A fair queue rotates among projects rather than draining one project indefinitely. Reserve invocation capacity before launch; release reservations when launch is definitively not performed, and charge attempted launches/retries according to recorded outcomes.

A final-review reservation prevents a builder from consuming every admitted invocation before a required independent review. If the accepted budget cannot support a meaningful minimum workflow, reject the proposal rather than start a guaranteed partial run.

## Recovery observability

Expose current step, reason for waiting, last durable sequence, active attempt identity, pending recovery action, and artifact references. Diagnostics redact sensitive prompts and provider credentials. Report managed invocations, retries, elapsed execution time, review rounds, and observed usage separately. Missing usage is unknown, never zero.

Measure replay duration and journal growth in release fixtures. Add indexes/checkpoints when measured need justifies them; no second authoritative database is required for V1.
