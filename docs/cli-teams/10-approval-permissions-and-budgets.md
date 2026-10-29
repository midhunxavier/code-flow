# User acceptance, permissions, and budgets

Status: proposed. [Index](README.md)

## Three different decisions

| Decision | Authority | Meaning |
| --- | --- | --- |
| Workflow acceptance | Human through supported confirmation flow | Accept this concrete team, scope, settings, limits, and execution boundary |
| Artifact review | Assigned agent/reviewer | Approve or challenge this exact plan/code artifact |
| Tool permission | Native provider/application permission mechanism | Permit one action or an explicitly configured bounded capability |

None substitutes for another. A model-approved plan does not authorize implementation when the user requested plan-only. A reviewer cannot approve a shell permission request as the user. A saved team cannot silently grant filesystem/network access.

## Acceptance protocol

The proposal is canonicalized and hashed after validation. Its acceptance record covers project identity, task/context references, configuration revision, participants, workflow, permissions, workspace baseline, checks, and limits. The preview and accepted data must be the same snapshot.

`codeflow_start_run` checks that stored acceptance, revalidates readiness, and starts idempotently. Any change to accepted fields invalidates the acceptance. Readiness changes must not silently substitute settings; either resolve the original configuration or create a revised proposal.

A plain MCP tool call cannot cryptographically prove that a human approved something. Do not accept an `approvedByUser` model-authored boolean. Native host acceptance is supported only after validating an actual confirmation signal and its binding to the displayed proposal. The fallback is an interactive Code Flow terminal confirmation showing the proposal revision. It may then record acceptance for a later idempotent start.

The fallback has no public unattended approval switch in V1. Acceptance is single-proposal, time-bounded, and consumed by a stable start operation rather than reusable authority to start arbitrary tasks. A cancelled or superseded proposal cannot be started with an old receipt.

This is an application authority boundary, not a security boundary against a hostile process with the same operating-system account. State that limit explicitly in implementation documentation and tests; do not claim stronger isolation from local TTY checks or file permissions alone.

## Permission resolution

Resolve effective policy for every attempt through existing run permission logic. Intersect accepted run policy, role access, workspace scope, current mandatory restrictions, and provider capability. A retry, model switch, or session recovery cannot broaden permissions.

Planning/review roles are read-only under the selected provider's supported controls. Provider controls are not assumed equivalent to operating-system sandboxing. If a mandatory boundary cannot be enforced, stop before launch. Current host roles are cooperative and inherit their existing native boundaries; show that limitation instead of advertising managed isolation.

Do not automatically run repository setup/hooks to discover models or construct proposals. Setup/check execution occurs only in accepted stages and workspaces. Tool output, repository text, and worker messages are untrusted task evidence, not instructions to change the accepted policy.

## Credentials and scoped access

Project files contain portable connection configuration, not owner tokens or provider credentials. Runtime bootstrap yields a scoped local connection. Worker capabilities are restricted by project, run, participant, step, attempt, operation family, and expiry. Server-side identity derivation prevents caller-selected impersonation.

Managed workers cannot call public setup/start/control tools. Disable accidental recursive public MCP loading in their provider configuration without rewriting the user's global configuration. Scoped token possession is not isolation against another unrestricted same-user process; preserve the existing documented trust ceiling.

## Budgets

The proposal displays:

- Lifetime managed CLI invocation ceiling, including retries and output repair calls.
- Overall workflow execution-time ceiling and per-attempt timeout.
- Maximum iterations per loop and attempts per step.
- Machine/provider concurrency ceilings.
- Any declared provider fallback pool.
- Host usage observability and current-session limitations.

Use the existing configured run time/call defaults as proposal ceilings unless the user changes them. Do not silently lower a previously requested default or treat a high ceiling as a spending target. The graph imposes tighter stage and expansion limits where appropriate.

Execution-time accounting counts time admitted/actively executing under the runner, including concurrent work by wall time once; time in explicit user/host/provider wait states is recorded separately. A separate absolute expiry can bound unattended run retention. Specify this distinction in the preview so “12 hours” is not ambiguous.

Managed invocation reservations occur before dispatch. Require enough remaining allowance for mandatory review/verification transitions. Retry exhaustion, step timeout, loop limit, and global budget exhaustion are distinct stop reasons.

The runner cannot enforce a hard token/dollar limit on arbitrary actions taken in the host's current conversation. Report observed provider usage and unobserved host usage separately. Do not sum incomplete values into a claimed total cost. Provider calls may contain many internal tool calls; a Code Flow invocation is one managed launch/turn, not every provider tool invocation.

## Configuration revisions and escalation

A provider substitution, model change, permission increase, new writer, wider file scope, or budget increase produces a new proposal revision unless it falls inside a clearly accepted bounded policy. Do not prompt again for every ordinary repair already authorized by the accepted workflow.

A repeated unresolved product disagreement becomes a focused user decision with alternatives and evidence. Accepting one option updates requirements/plan policy explicitly. Do not label that human choice as unanimous model agreement.

## Logging and privacy

Keep provider secrets, raw auth diagnostics, claim tokens, and connection credentials out of prompts, saved artifacts, and shared definitions. Store token digests where lookup requires persistence. Redact sensitive context before export. Preserve provenance and access restrictions when artifacts are reused across runs.

No automatic sending of findings to GitHub, email, or chat services is part of V1. Final delivery is to the originating local conversation and local run artifacts.
