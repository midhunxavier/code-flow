# Requirements and V1 scope

Status: proposed. [Index](README.md)

## Product promise

Use one familiar Claude Code or Codex CLI conversation to organize and work with agents from both providers. The user describes an outcome, reviews a proposed team and workflow, accepts it, and receives the complete deliverable in the same conversation. They do not have to operate the Code Flow dashboard or copy responses between providers.

Both provider backends must be installed and authenticated when required by the accepted team. One user interface does not imply one backend connection. Account access and observed provider limits remain provider-specific.

## Primary journeys

### Automatic team creation

1. User asks for a mixed-provider task.
2. Host skill supplies explicit task context and project identity.
3. Code Flow discovers eligible profiles and generates a bounded proposal, preferably by selecting and parameterizing a known workflow.
4. User sees role assignments, exact settings or clearly labeled inherited settings, workflow graph, workspace, checks, and limits.
5. User accepts, edits, or cancels. No implementation is dispatched while acceptance is pending.
6. Code Flow executes, reports meaningful transitions, and exposes real outputs.
7. User may save the team and workflow before or after execution.

V1 uses the host's existing reasoning plus deterministic template selection/validation to produce the proposal. It does not start a separate managed inference call during team selection. A future optional proposal-generation call must have an explicit, bounded preflight allowance.

### Planning scenarios

- Codex drafts; Claude reviews; Codex revises until required reviewers approve the same final plan.
- Claude and Codex independently propose; participants cross-review; a designated synthesizer combines proposals; final reviewers approve or request another revision.
- Multiple models from either provider participate independently.
- A supplied user plan enters the same review process.
- The workflow can stop with a plan, then a later run builds from that exact plan reference after checking whether repository context has changed.

### Implementation scenarios

- Codex plans, Claude reviews the plan, Claude builds, and Codex reviews the build.
- Reverse any provider assignment without modifying workflow code.
- Review existing working changes without editing them.
- With explicit fix authorization, send findings to a builder and repeat review/checks.
- Use the current session for compatible work; use managed workers for other roles.

## Requirements and acceptance criteria

| ID | Requirement | Acceptance |
| --- | --- | --- |
| R01 | One conversation | Either host starts a workflow and receives its full result without a dashboard |
| R02 | Automatic proposal | A task produces an editable, validated configuration before dispatch |
| R03 | Explicit acceptance | Only the accepted proposal revision can start; edits invalidate prior acceptance |
| R04 | Saved teams | Team/workflow versions can be saved, reused, and overridden per run without changing the saved version |
| R05 | Flexible assignments | A role supports multiple distinct participants, providers, models, and supported effort values |
| R06 | Generic graphs | The three V1 workflows run through the same graph executor |
| R07 | Exact agreement | Reviews attach to an immutable target; stale or missing votes never approve |
| R08 | Host participation | A compatible current session can claim and submit a role assignment |
| R09 | Provider compatibility | Unsupported settings or mandatory controls stop admission with a clear explanation |
| R10 | Durable recovery | Completed outcomes survive restart; uncertain effects are reconciled before retry |
| R11 | Safe workspace use | Unrelated user edits and the user's Git index survive setup, review, cancellation, and cleanup |
| R12 | Evidence-based delivery | Check results and approvals match the delivered code snapshot |
| R13 | Useful controls | Steer, pause, resume, and cancel have defined, observable behavior |
| R14 | Bounded execution | Concurrency, call admission, time, retries, and loop iterations are capped |
| R15 | Honest status | Missing checks, unavailable providers, unknown usage, and uncertainty are shown explicitly |
| R16 | Project portability | Shared definitions contain no credentials or machine-specific execution paths |
| R17 | Isolation of authority | Workers cannot start nested workflows, change permissions, or approve human requests |
| R18 | Existing compatibility | Legacy runs, existing HTTP clients, and provider integrations continue to work |

## Initial workflows

| Workflow ID | Behavior |
| --- | --- |
| `plan-agreement` | One or more proposals, synthesis where needed, revision loop, exact-plan agreement |
| `feature` | Plan agreement, one builder, checks, independent review, bounded repair |
| `review-changes` | Snapshot existing changes, independent review, optional authorized repair and re-review |

`review-changes` defaults to review-only. The `allowFixes` input is included in the accepted proposal; a reviewer cannot activate it.

## V1 exclusions

- Desktop browser, picker, and UI control sharing.
- Remote runners, cloud hosting, or multiple machines writing one run journal.
- Arbitrary workflow scripts, general expression evaluation, or graph plugins downloaded at runtime.
- Concurrent implementation writers inside a run; parallel readers are supported.
- Automatic merge, push, publication, or production deployment.
- Invisible provider substitution or automatic budget extensions.
- Guaranteed token/dollar caps for the existing host conversation.
- Public plugin marketplace publication as an installation dependency.

The domain model may accommodate later extensions, but V1 validation rejects unsupported execution modes rather than pretending they work.

## Default usability rules

Propose the smallest adequate team. Show model/effort settings without asking users to configure irrelevant roles. Ask product questions only when the answer affects the plan. Preserve dissent as actionable findings rather than pressuring agents to agree. Display the final plan or actual result, not only an orchestration summary. A reusable workflow and a saved team may be selected together as one preset in the CLI.
