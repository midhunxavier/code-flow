# Conversational agent teams: UX redesign plan

Status: proposed redesign, 2026-11-02. [Index](README.md)

This document defines the revised target experience for the new Claude Code and Codex CLI integration. It is a plan, not a claim that commands or tools are implemented. It replaces the initial requirement to select starter workflows or configure/save teams before use. It does not remove existing web-app workflows, templates, saved data, or legacy client behavior.

## 1. Product outcome

A user describes an outcome in their existing CLI conversation. They may specify providers, models, effort, role assignments, and review behavior in the same instruction. The assistant proposes a concrete team and process; Code Flow validates and executes that process; the user receives the actual result in the same conversation.

The everyday journey is:

**Describe the task → review the approach → start → steer → receive the result.**

Users do not need to understand graph nodes, profile references, workflow IDs, MCP tool names, or a separate dashboard. Only the settings and decisions relevant to their request appear.

### Initial scope decisions

| Area | Revised decision |
| --- | --- |
| Entry point | One conversational Code Flow skill in either supported host |
| Workflow selection | Generate the process from the instruction; no preset picker |
| Teams | Create participants for each proposal; no predefined teams |
| Saved teams | Defer team saving, listing, importing, and management |
| Preferences | Optional provider/model/effort preferences; no role-configuration wizard |
| Models | Discover actual provider capabilities; show requested and resolved selections |
| Execution | Use the existing proposed graph service, adapters, journal, and worktrees |
| Host participation | Supported where verified; strict settings use managed workers when necessary |
| Reuse | Existing runs remain readable; reusing a result creates a fresh proposal |

Plan, build, and review remain supported outcomes, not user-selectable workflow products. A simple task can use one worker; requesting a team does not automatically require every installed provider or a large roster.

## 2. What stays from the existing design

The separation between settings, roles, participants, graphs, proposals, and runs remains useful internally. Reuse [03](03-domain-model.md), [04](04-workflow-graphs.md), and [09](09-durability-and-recovery.md) for the execution foundations:

- Typed artifacts, exact-revision reviews, and checks tied to code snapshots.
- Deterministic validation, scheduling, and gates; models produce content, not authoritative state transitions.
- Bounded loops and retries, one implementation writer per run, and parallel read-only work.
- One local runtime owner, durable receipts, restart recovery, and preservation of user edits.
- Separate human acceptance, artifact approval, and provider tool permissions.
- Explicit distinction between a cooperative current CLI session and managed workers.

The change is how a proposal is created and presented. There is no need for a second scheduler or an unrestricted workflow scripting language.

## 3. First use and setup

Proposed setup remains `codeflow init` from the target Git repository. Keep existing bare `codeflow` and `codeflow client ...` behavior unchanged.

1. Detect the repository and the supported installed CLIs without paid inference.
2. Present detected readiness, such as “Claude ready; Codex needs sign-in.” Only a provider required by the requested task must be ready before execution.
3. Preview and merge project-scoped skill/MCP configuration, preserving unrelated entries. Do not require a team name, workflow, or model for every possible role.
4. Allow optional provider/model/effort preferences. Skipping preferences uses the discovered provider defaults with their provenance shown later.
5. Run `codeflow doctor` to validate discovery, transport, configuration, and compatibility. Explain a required host reload only when the tested host requires it.
6. End with one example task that the user can run from their normal conversation.

Use the proposed `.codeflow/cli-teams.json` namespace for schema version and explicit preferences if needed. Do not require `profiles/`, `teams/`, `workflows/`, or a default preset reference. Store generated definitions and runtime records privately with the run. Keep project files free of credentials and captured machine-specific paths.

The installation plan must test the exact native skill invocation supported by each host. `/codeflow ...` for Claude and `$codeflow ...` for Codex are proposed examples pending that validation. Plain-language skill discovery may supplement the documented invocation.

## 4. Describe the task

All of the following should use the same entry point:

| Instruction | Expected behavior |
| --- | --- |
| “Fix the empty-email validation bug and test it.” | Propose a small implementation/check process; add review when required by the accepted completion policy |
| “Use Claude to draft a login-form plan and Codex to review it until both agree. Plan only.” | Propose planning, exact-target agreement, and bounded revisions; no implementation writes |
| “Review my current changes with Claude and Codex. Do not fix anything.” | Capture the selected dirty-change snapshot, review in parallel, and return findings |
| “Review these changes and fix the blocking issues.” | Propose a review, one authorized writer, checks, and re-review |
| “Have two models propose designs independently, then combine them.” | Use separate contexts for proposals, synthesis, and required reviews |

Do not restrict interpretation to three renamed presets. Compose registered operations according to the user's requested order, dependencies, independence, and stopping condition. The first release supports the planning, implementation, review, synthesis, snapshot, and verification operations defined in [04](04-workflow-graphs.md). Unsupported requests get a precise limitation or a supported narrower proposal, not an invented operation.

Ask a question only when an ambiguity materially changes the deliverable, required provider choice, allowed edits, or completion criteria. Bundle related blockers into one concise question. Put reversible assumptions in the preview, such as “Use the existing UI framework and login layout.” An explicit request to review or plan must never become implementation because of a default.

## 5. Generate and preview the approach

The host assistant interprets the instruction using its current conversation and selected repository context. It supplies a structured candidate to `codeflow_propose_run`. The application service resolves settings and validates the graph, workspace, checks, limits, and authority. Validation errors return to the host for correction before execution.

Proposal generation does not launch an additional managed planner invisibly. Host reasoning uses the host's own subscription and native tools; describe this accurately rather than claiming that proposal generation is free. Any later managed proposal generator needs its own explicit, bounded allowance.

### Default preview

Display only what the user needs to assess:

- The requested deliverable and important scope boundaries.
- Each participant's job, provider, resolved model, effort, and fresh/current-session status.
- The sequence of work, parallel stages, review conditions, and revision limits.
- The repository/base or dirty-change target, write scope, and proposed setup/check commands.
- The actual configured managed-call, execution-time, concurrency, and retry ceilings, plus unknown host usage.
- Any blocking choice and the exact next action to start or revise.

Use an ordinary text summary or table in the host conversation. A graphical workflow editor is unnecessary. Advanced details can be requested conversationally and retrieved through the same tools. Settings not included in the compact text remain part of the exact proposal presented by the supported acceptance surface.

### User's flagship example

> Use Claude Opus and Codex Sol, both with high effort, to create a login-form implementation plan. Claude drafts and Codex reviews until both agree. Then a fresh Claude Opus reviewer gives the final plan an extra-high-effort review. Resolve blocking findings before returning the plan. Plan only.

Resolve “Opus,” “Sol,” and the requested efforts through the actual catalogs before showing a ready proposal. They are user-supplied labels, not hardcoded model IDs or guaranteed capabilities. If extra-high effort is unavailable, offer the provider's supported values and wait for the user's selection; do not silently choose the maximum.

Once settings are resolved, the preview should read like this, with actual model IDs and configured numeric ceilings filled in:

```text
Outcome: Login-form design and implementation plan. No implementation writes.

Claude / <resolved Opus ID> / high       Draft and revise
Codex  / <resolved Sol ID>  / high       Review and agree
Claude / <resolved Opus ID> / <resolved effort>
                                        Fresh final reviewer

Draft → joint agreement → independent final review → final plan
Revisions return through agreement before final review runs again.
Up to 3 complete review passes; unresolved disagreement returns to you.

Context: <repository and exact source snapshot>
Limits: <managed-call ceiling>, <execution-time ceiling>, <concurrency>
Next: accept the displayed proposal through the supported confirmation flow,
or describe a change.
```

The same model serving two jobs does not imply the same participant or session. The final reviewer gets a fresh context, the current plan, requirements, and required evidence. It should not inherit the drafter's private conversation by default. The drafter's endorsement is not independent review; agreement and independent review remain separate conditions.

## 6. Provider, model, and effort selection

Use this resolution order, applied to each relevant assignment:

1. Explicit instructions for that participant or step.
2. Explicit instructions covering the whole task, such as “both with high effort.”
3. Explicitly configured preferences for the selected project, then personal preferences where no project value exists.
4. Discovered provider defaults, with unknown defaults labeled honestly.

Do not search saved teams or silently infer preferences from a past run. Define project/personal preference precedence explicitly in the schema and display the source of each inherited value. Resolve these values into the immutable proposal so changing preferences cannot change an accepted run.

“Choose the team” may select from eligible providers using configured defaults, the task's required capabilities, and the smallest adequate roster. It does not imply “use the most expensive model” or require a universal low/medium/high effort scale. Any automatic non-default effort selection must use the model's actual supported values and appear in the proposal.

Preserve requested values separately from resolved values. Unknown aliases produce a short candidate list. Unavailable models, unsupported efforts, and missing required controls produce an actionable blocking error. An unavailable pinned provider never becomes permission for silent substitution.

The current session keeps its native model, effort, tool permissions, and workspace. If an assignment requires an exact setting the host cannot verify, propose a compatible managed worker. Show whether the current session is only coordinating or also doing assigned work.

## 7. Agreement, final review, and completion

Interpret “until they agree” as a bounded convergence process. Propose three review passes by default, within the existing maximum of five per loop. User-specified lower limits take precedence; larger unsupported limits return a validation error or a supported alternative.

For the flagship planning task, use one bounded loop:

1. Produce or revise the candidate plan from the request and prior findings.
2. Obtain the required Claude and Codex verdicts on exactly that plan revision.
3. If they disagree, preserve findings and begin another pass when capacity remains; skip final review for that pass.
4. If they agree, run the fresh final reviewer on that same revision.
5. Finish only when the agreement and final-review requirements both pass on the delivered revision.
6. A blocking final finding requests another full pass; any changed plan needs renewed agreement and final review.

Compile this as a flat bounded-loop body with explicit gated paths and an aggregate exit decision. Do not implement an unbounded callback or require nested loops, which the existing V1 grammar defers. Validate that this shape is expressible during the compiler phase; extend only registered gate contracts if needed.

There is one loop counter for this example: at most three agreement review passes, and at most one final review within each qualifying pass. Retries consume attempt/call allowance separately. Preserve the last reviewed plan and findings on the last rejection; do not create an extra unreviewed revision. Insufficient remaining capacity stops before admitting incomplete required work.

For implementation, completion requires the accepted checks and required reviews on the delivered code snapshot. Reviewer agreement cannot convert a failed check into success. For review-only work, delivering findings can complete the task without implying that the reviewed code is approved. Plan-only work must not run unrelated setup or test commands merely to appear verified.

Consensus is a coordination result, not proof of correctness. Results show requirement coverage, evidence, and limitations alongside verdicts.

## 8. Start, progress, and conversational steering

### Start once

Use one concrete proposal acceptance before initial execution. Native confirmation is available only where a tested host channel binds a human action to the exact proposal. Otherwise use the existing interactive terminal fallback; state the extra step plainly. A textual “Start” example is not evidence that a host provides a native button or trusted approval signal.

Do not ask again for ordinary reviews or repairs already inside the accepted scope and ceilings. Acceptance never replaces provider tool permissions. Revisions to accepted settings invalidate prior acceptance. This redesign does not authorize unattended starts or add a model-authored approval boolean.

### Meaningful progress

Prefer updates such as:

```text
Draft ready. Codex is reviewing the accessibility and validation decisions.
Pass 1: keyboard behavior remains unresolved. Claude is revising that section.
Both accepted plan v2. The independent final review is running.
```

Report meaningful state changes, blockers, and needed decisions. Do not stream raw orchestration events by default or repeatedly report unchanged status. The user can request agent transcripts or details.

Poll with cursors and bounded waits while the host is active. Do not promise unsolicited messages after the host closes. State whether managed work can continue and whether a required host assignment will wait. Status/attach restores the conversation when notification support is absent.

### Steering

| User says | Behavior |
| --- | --- |
| “What is happening?” | Return the current stage, blockers, and last meaningful result |
| “Use the existing form components.” | Attach clarification within scope, or revise the proposal if it changes accepted requirements |
| “Switch the reviewer to another model.” | Pause affected dispatch at a safe boundary, resolve the selection, and present a revised proposal |
| “Also implement the plan.” | Create a new accepted scope/continuation with writes and checks; do not expand a plan-only run implicitly |
| “Pause” / “resume” / “cancel” | Apply durable control and report the effective state, including any process uncertainty |

Show which work can be reused and which review/check evidence becomes stale after a material change. Preserve completed unaffected work. Cancellation preserves artifacts and owned worktree changes for inspection.

## 9. Recovery and actionable failures

Every interruption should answer: what happened, what is preserved, and what the user can do next.

| Situation | User-facing response |
| --- | --- |
| Required provider needs sign-in | Identify it and the recovery action; preserve the draft or completed work |
| Explicit effort is unsupported | List supported values for that model; wait for a selection |
| Reviewers reach the pass limit | Show the last reviewed plan and specific disagreement; offer a focused decision or accepted extension |
| Check cannot run | State the failed prerequisite and missing evidence; do not label the changes verified |
| Required host disconnects | Mark the run waiting for that host; explain how to attach |
| Run already started but the reply was lost | Return the original run through its idempotency receipt |
| A write process may still be running | Show recovering/uncertain; reconcile ownership before another writer starts |

Automatic retry stays inside accepted bounds and never substitutes a provider or increases authority. No hard dollar estimate should be displayed as a guarantee when provider or host usage is unobservable.

## 10. Result delivery

Deliver the requested output in the conversation, not just “run completed” or a filesystem path:

- Planning: the plan, accepted design decisions, requirement coverage, review outcome, and remaining limitations.
- Implementation: what changed, branch/worktree, checks and their target, review outcome, and unresolved findings.
- Review: prioritized findings with evidence, the reviewed snapshot, and an explicit statement of whether edits were made.
- Stopped/blocked work: usable partial artifacts, exact stopping reason, and a concrete next action.

Retrieve long artifacts in bounded pages without silently dropping the end. Provide a readable result and an exact artifact reference for retrieval. “Implement this plan” starts a fresh proposal referencing the immutable plan and revalidates the repository context; it does not reuse stale authorization.

## 11. MCP surface: ten core tools

These are assistant-facing APIs, not ten commands the user must learn. Keep distinct contracts where lifecycle and authority differ.

| Tool | Responsibility |
| --- | --- |
| `codeflow_list_providers` | Readiness and provider capabilities without inference |
| `codeflow_list_models` | Catalog, aliases where known, supported efforts, and default provenance |
| `codeflow_propose_run` | Validate/resolve a host-supplied task and graph candidate; create or revise a proposal |
| `codeflow_start_run` | Start exactly the accepted proposal revision/hash, idempotently |
| `codeflow_get_run` | State, incremental progress, questions, ready host assignments, and result refs |
| `codeflow_steer_run` | Record instruction/task answers or produce a material proposal revision |
| `codeflow_control_run` | Pause, resume, or cancel with a durable receipt |
| `codeflow_get_artifact` | Retrieve an exact artifact with bounded pagination |
| `codeflow_claim_step` | Claim an assignment for the bound current host session |
| `codeflow_submit_step` | Submit that claim's exact-target typed output |

Replace the proposed `codeflow_propose_team` with `codeflow_propose_run`. Remove `teamRef`, `workflowRef`, and saved-team overrides from its public V1 inputs. Its revised request contains task, explicit context, a structured candidate with run-local profiles/participants/graph, explicit setting overrides, and optional proposal ID/revision for edits. A request without an executable candidate may return unresolved inputs; it must not silently launch an inference worker.

Keep the existing operation IDs, conflict rules, acceptance binding, claim fencing, artifact integrity, and pagination contracts from [06](06-mcp-contract.md). Discovery may be cached; not every task requires two new discovery calls. A normal managed-only run uses propose → start → get_run → get_artifact after discovery; claim/submit apply only to host participation.

Do not expose `codeflow_list_teams` or `codeflow_save_team` in initial V1. There is no public MCP “approve as user” tool. Managed workers retain their separately scoped collaboration tools and never receive this owner-level surface. The existing internal worker tool count is not part of these ten public tools.

## 12. Documentation and contract changes

The rest of the design pack is the earlier baseline until reconciled. For conflicts about presets, saved teams, proposal naming, and the initial UX, this redesign is the revised target. Unchanged durability, isolation, workspace, acceptance, and integrity requirements still apply.

| Document | Required reconciliation before implementation is merged |
| --- | --- |
| [01 — Requirements](01-requirements.md) | Replace R04 saved teams with run-local team generation and explicit preference inheritance; make generic composition R06's acceptance; remove initial preset selection and saved-team journey |
| [02 — Architecture](02-system-architecture.md) | Replace required library/preset lookup with catalog/preferences plus host-generated candidates; keep one owner/service |
| [03 — Domain model](03-domain-model.md) | Allow immutable run-local profile/team/graph definitions without prior saved versions; define preference scope and provenance |
| [04 — Graphs](04-workflow-graphs.md) | Add the agreement-plus-final-review fixture and any required registered aggregate gate; retain existing bounds |
| [05 — Providers](05-participants-and-providers.md) | Replace saved-profile precedence with explicit task/project/personal/default resolution; retain strict pin and host limitations |
| [06 — MCP](06-mcp-contract.md) | Define the ten-tool contract, rename propose, and remove saved-team APIs/inputs |
| [07 — Setup/CLI](07-cli-and-project-setup.md) | Remove team list/configure/save and preset wizard; use task-first examples, lean configuration, and supported acceptance fallback |
| [08 — Workspaces](08-workspaces-and-verification.md) | Check that examples use generated run-local definitions; preserve snapshot and edit-protection rules |
| [09 — Recovery](09-durability-and-recovery.md) | Include generated definitions in durable accepted snapshots; preserve command receipts and reconciliation |
| [10 — Acceptance](10-approval-permissions-and-budgets.md) | Show compact preview plus actual ceilings; ensure preferences cannot mutate accepted settings |
| [11 — Implementation](11-implementation-plan.md) | P1/P3 add task-generated composition; P6 uses ten tools; P7 replaces saved presets with lean setup/preferences |
| [12 — Tests](12-test-and-release-plan.md) | Defer T29 saved-team reuse; add the UX scenarios below; replace package/preset expectations and worker save-tool references |
| [13 — Examples](13-worked-examples.md) | Keep useful graph tests but express task-generated run-local definitions; add flagship natural-language fixture |
| [14 — Decisions](14-decisions-and-risks.md) | Record no initial presets/saved teams, preference precedence, ten public tools, and retained host constraints |

Old saved-team fixtures may remain as clearly deferred examples, but must not be required by the revised release checklist. Existing released web data and behavior are preserved; no deletion or migration of those teams is part of this plan.

## 13. Implementation sequence and exit criteria

Implement this as focused changes on top of P0–P8, keeping the feature opt-in until release evidence exists.

| Phase | Deliverables | Exit criterion |
| --- | --- | --- |
| A. Reconcile scope and prove hosts | Update the pack/contracts; validate native invocation, confirmation, settings provenance, and fallback | Both hosts have a documented tested path; no unverified native capability is required |
| B. Task-to-proposal | Define candidate/preference schemas; resolve models/efforts; generate run-local roles and graphs through the host skill | One plain instruction produces a valid editable proposal without a preset/team selection |
| C. Validate and execute | Extend existing planned compiler/service/participants; add exact-target final-review composition and durable snapshots | Fake providers execute simple and custom processes with correct limits, evidence, and recovery |
| D. Ten-tool conversation | Implement MCP contracts, preview, start, progress, host assignments, steering, and result presentation | Either host completes a task and displays the deliverable without a dashboard |
| E. Lean onboarding/package | Implement configuration merge, doctor, preferences, headless owner reuse, and packaged skills | A fresh project works without saved definitions; uninstall preserves unrelated config and data |
| F. Release evidence | Focused regression, fault, package, and bounded live host/provider tests | Both host paths pass the acceptance scenarios and disclose tested limitations |

Preserve P0 boundary probes, P2 durability, P4 host fencing, and P5 workspace/evidence work; a simpler interface does not remove those prerequisites. No implementation work, provider launch, package install, or live test is performed by this document.

## 14. UX acceptance scenarios

Add traceable tests alongside the existing release scenarios. Use fake catalogs for model-specific names and bounded explicit live budgets only for actual compatibility evidence.

| ID | Scenario | Acceptance |
| --- | --- | --- |
| UX01 | First task without preferences | No preset/team wizard; one concrete proposal with visible defaults |
| UX02 | Only one provider installed | A compatible single-provider task works; another provider is not required by setup |
| UX03 | Flagship login-form instruction | Correct role-specific providers/models/efforts; distinct final-review context; no implementation writes |
| UX04 | Unknown alias or unsupported extra-high effort | Focused supported choices; no silent pin changes or worker dispatch |
| UX05 | Explicit task setting conflicts with defaults | Task setting wins; proposal records the source and resolved value |
| UX06 | Final reviewer requests a revision | Prior votes become stale after edits; renewed agreement and final review target the new revision |
| UX07 | Persistent disagreement or insufficient allowance | Bounded stop; last reviewed artifact and findings delivered; no unreviewed extra revision |
| UX08 | User changes a model before start | New proposal revision; old acceptance cannot start it |
| UX09 | In-scope repair during execution | No repeated workflow acceptance; ordinary native tool permissions still apply |
| UX10 | Plan-only followed by “implement it” | New proposal with writes/checks and context-freshness validation |
| UX11 | Strict role incompatible with current host settings | Managed worker shown explicitly or actionable error; no claim of host reconfiguration |
| UX12 | Disconnect, restart, or lost start reply | Work preserved; one run; truthful waiting/recovery state and usable reattachment |
| UX13 | Long plan or review result | Complete retrievable artifact and useful content in the original conversation |
| UX14 | Ten-tool schema and worker scope | Exactly ten public tools; no preset/save APIs; worker owner-level calls denied |
| UX15 | Existing web teams and legacy clients | Behavior and stored data unchanged |
| UX16 | Staged/unstaged changes reviewed without fixes | Exact target reviewed; original files and index unchanged |
| UX17 | Requested work order differs from old starter flows | Accepted ordering is represented in the compiled graph; no hidden rewrite to a preset |

During usability walkthroughs, record setup steps, questions before a ready proposal, repeated acceptance prompts, tool errors, and whether users can explain who will do what and what “done” means. Optimize avoidable configuration and repeated prompts without weakening correctness or hiding required decisions. Measure provider latency separately from Code Flow interaction overhead.

## 15. Deferred scope

- Built-in named teams, workflow preset selection, saved-team CRUD, and template marketplaces.
- A graphical workflow editor, arbitrary workflow scripts, and runtime-downloaded operation plugins.
- Remote participants, concurrent implementation writers, automatic merge/push/deployment, and guaranteed host cost caps.
- Claims that model consensus proves correctness or that every provider has equivalent effort values and isolation.

Consider user-created saved approaches only after observing repeated requests for the same process. That later feature should be optional, retain explicit versions, and never carry execution authority. The initial release remains one task-first conversational entry point with generated teams.
