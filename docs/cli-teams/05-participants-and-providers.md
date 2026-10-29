# Participants and provider integration

Status: proposed. [Index](README.md)

## Managed participant contract

Reuse the existing [adapter contract](../../src/adapters/types.ts) rather than creating vendor calls inside workflow nodes. Wrap it with graph participant identity, explicit output validation, artifact references, policy resolution, and attempt accounting.

A managed participant has one provider, resolved model/effort settings, role membership, workspace policy, and private session chain. Resume only the exact recorded provider session associated with that participant and role context. Do not use `--last` or a provider-wide most recent conversation.

A new role requiring independent judgment gets a fresh context even when another role uses the same profile. The same provider login may serve several participants; this does not make their identities or private messages interchangeable.

The worker adapter must report structured final output, process outcome, observed session ID, normalized errors, usage with source/provenance, and available capabilities. A successful process exit without a valid required artifact is not a successful workflow step.

## Current-session participant contract

The existing Claude/Codex conversation remains user-facing and may perform compatible roles. Its binding is established by the project-scoped connection, not an arbitrary `participantId` supplied by the model. Provider/model/effort metadata supplied by the host is labeled verified, reported, or unknown according to the actual integration mechanism.

The host calls `claim_step`, obtains the exact assignment and opaque claim token, performs the work using its native tools, then calls `submit_step`. Code Flow validates outputs and controls progression. The host may request a change, but it cannot invent successful downstream steps.

Default V1 host roles are plan drafting, synthesis, and review, when independent context requirements permit them. Host implementation is supported only after the integration proves the active workspace matches the accepted run workspace and ownership can be coordinated. When it cannot, assign a managed builder and explain that choice in the proposal.

Do not pretend MCP controls native tool permissions, current-session model settings, working-directory changes, or the host's remaining token budget. These are compatibility conditions, not fields the server can enforce by declaring them.

## Host availability and leases

The local bridge maintains connection liveness separately from model tool calls. A claim is bound to the connection generation, step, attempt, and workspace. Heartbeats renew liveness; they do not prove that the model is making progress.

Loss of the bridge, a deadline, or missed heartbeats marks the assignment waiting/uncertain. Read-only work can be reassigned after explicit cancellation and revocation. Write work requires workspace/process reconciliation before another writer is admitted. Mere lease expiry is not permission to overwrite or duplicate work.

Reconnection can rebind the same run through a local-user-authorized session attachment. Old tokens are revoked. An unrelated host session cannot seize a claim by presenting its run ID. V1 may use terminal `codeflow attach RUN_ID` for explicit reattachment when a trusted host continuation identity is unavailable.

## Discovery and settings

Use existing model discovery and provider capability probes. The cache key includes provider, executable identity/version, environment, and relevant configuration revision. Expose supported effort levels for each model; do not translate every provider into a universal numeric effort scale.

Resolution order: explicit run override -> accepted team/profile version -> explicitly chosen provider default. Never fall back silently from a pinned model or effort. A current-session binding uses current observed/reported settings; the proposal must show that rather than the desired managed-worker settings.

Readiness distinguishes installed, authenticated, unknown authentication, compatible, unavailable, and temporarily limited. A list operation does not perform paid inference. Live compatibility evidence records the tested CLI version and transport. Unknown mandatory permission/capability support blocks dispatch.

## Authentication and tool exposure

Invoke official installed CLIs through existing adapters and their supported authentication mechanisms. Never copy OAuth tokens into project files, prompts, artifacts, or the public MCP connection. Do not claim that CLI authentication guarantees every account entitlement or usage arrangement.

Managed child workers receive only assignment-scoped collaboration tools. Avoid recursively loading the public host connector and its team-start skill into workers. The existing adapters already control selected MCP/tool exposure; extend those controls with regression tests while preserving project instructions and supported native features. Do not mutate users' global provider settings to achieve isolation.

The host can retain its native tools, subject to its own permissions. A worker does not automatically inherit those tools or the host conversation. Native browser/picker sharing is outside V1.

## Provider failure and replacement

- Authentication failure: wait for user recovery; do not loop on inference.
- Rate limit/transient failure: bounded retry with backoff, recorded attempts, and remaining budget checks.
- Missing session: resume from a portable checkpoint in a new session only after reconciling possible side effects.
- Unsupported model/flag: return compatibility failure; no quiet downgrade.
- Provider replacement: only within a preaccepted fallback policy or a newly accepted assignment revision. Preserve role independence and require fresh review where needed.

## Compatibility evidence to obtain

For each host/provider combination, test discovery, explicit settings, structured output, continuation, cancellation, permission questions, project MCP loading, independent worker context, and full artifact return. Current-session model detection, native approval signaling, host workspace selection, and connection continuation are explicit phase-zero probes.

Official interface references consulted during design:

- [Codex non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [Codex project MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Codex skills](https://learn.chatgpt.com/docs/build-skills)
- [Claude Code programmatic execution](https://code.claude.com/docs/en/headless)
- [Claude Code project MCP](https://code.claude.com/docs/en/mcp)
- [Claude Code skills](https://code.claude.com/docs/en/skills)

Documentation describes available interfaces, not completed Code Flow integration tests. Pin a tested compatibility range during release and recheck it on upgrades.
