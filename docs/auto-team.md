# Auto team

Choose **Auto team**, describe the goal, and select the providers code-flow may use. A coordinator inspects the repository and proposes individual members, tasks, dependencies, file ownership, and acceptance criteria. You can approve, revise, or reject that plan before workers start. Planning itself uses a CLI invocation. Approval defaults on; an explicitly saved preference or automation policy still applies.

Auto team is opt-in. Existing manual patterns remain available. It uses the same official CLI adapters, worktrees, checks, permissions, review/shipping actions, and subscription logins as other runs.

## How work proceeds

1. The runtime validates the proposed plan against installed providers, quota observations, configured model/effort pins, member/task limits, dependency cycles, and review independence.
2. New runs start ready tasks as earlier tasks finish, without waiting for unrelated workers. Saved wave-based runs retain their recorded scheduling behavior. Each member has its own identity and session, even when several members use the same provider. Tasks with overlapping file ownership run separately.
3. A worker returns a structured outcome: submitted work, a failure, or a question with a progress checkpoint. Submitted changes are integrated serially and checked before dependent work starts.
4. When a decision is needed, the coordinator can add bounded work or workers, reassign unfinished work, retire idle workers, and add shared contracts. It cannot remove approved requirements or raise its own limits.
5. An independent read-only member reviews the integrated result. Blocking findings can trigger bounded repairs, followed by another check and review of the current commit.

An implementation is verified only when required work is present, the configured check passes, independent review has no blocking findings, and fail-to-pass proof succeeds when enabled. Missing or unrunnable checks and unresolved tasks remain visible gaps. An investigation can finish with evidence-bearing artifacts and independent review without a code check. The run does not merge or publish its result automatically.

## Communication and blockers

Members send addressed questions and replies through their structured outcomes. The runtime attaches the sender, task, request ID, and origin; an agent message never becomes user authorization. A worker needing information ends its turn, saving its partial work and checkpoint. Its CLI slot is then available for other work.

The next scheduling boundary delivers an existing answer or runs a short read-only response turn for the addressed member. A question addressed to you appears in the run view and in **Needs you**. Your answer is saved before the waiting workflow is released. The run clock pauses while waiting for you. An unanswered peer request or failed task can prompt a bounded coordinator revision; exhausted limits produce an explicit blocker.

You can also send a note to an individual member. Codex app-server can receive user notes during a turn; other transports receive them on the next turn. Native permission requests remain denied under the existing adapter policy. Auto members use the structured question protocol for missing information.

Claude and Codex members also receive scoped collaboration tools when their installed CLI supports the configuration. They can send messages, ask/reply, read their inbox, publish findings, save notes, or propose project memory during a turn. Calls acknowledge durable acceptance promptly; the scheduler applies commands at recorded boundaries. A blocked member still ends its turn to release the process slot. Antigravity and unsupported configurations retain structured outcomes.

Question and wait state are one logical journal transaction. Duplicate operation IDs do not duplicate messages. Expired deadlines, unavailable recipients and cyclic waits route to the coordinator within the existing budget. Reassigned or retired attempts cannot overwrite current work. Knowledge dependencies can use evidence-bearing replies; artifact dependencies require integrated code, and completion dependencies require the upstream task to finish.

## Three memory scopes

| Scope | Contents | Who receives it |
|---|---|---|
| Private | Observable progress, attempts, unresolved questions, and a portable checkpoint | That member; a replacement receives a separately authored shared handover and artifacts |
| Team | Accepted contracts, task outcomes, questions, findings, and artifact references | Members whose assignment needs the information; reviewers receive independent review context |
| Project | Accepted conventions and reusable facts with source, revision, and applicability | Future matching runs in the same project and repository |

Private scope controls context assembly and memory APIs; it is not filesystem secrecy from a fully trusted process on the same machine. Checkpoints describe observable work, not hidden model reasoning.

The team view shows members, dependencies, messages, requirement coverage, checkpoints, and each worker turn's context references. The project-memory panel shows included and omitted entries with reasons, provenance, and branch applicability. You can create, edit, accept, delete, or rate a memory as useful, irrelevant, stale or incorrect. Edits require the displayed revision, so concurrent changes cannot silently overwrite one another.

Structured worker findings become project **proposals** after result verification. Live tools can save an earlier proposal, explicitly unverified and requiring user review. They remain tied to the result branch and commit. Accepting a branch-specific proposal does not make it a convention for every branch; changing it to **Use across this repository** is an explicit user decision. Repository membership, branch/commit ancestry, expiry, and source revisions are checked when selecting memory. Retrieval uses bounded text/path/tag matching, without embeddings. User feedback adjusts ranking only for that revision; stale or incorrect revisions are excluded. Feedback never raises trust or authorizes promotion.

Locked-down, untrusted, or unknown-origin material cannot automatically become accepted project knowledge, including through a derived summary. The user must approve the exact revision. Auto teams do not consume historical recurring lessons whose provenance is missing; explicit repository conventions and accepted project memory are separate inputs. Automatic learning is also disabled for untrusted sources.

Deleting a memory erases its stored body and derived memory bodies, removes them from retrieval, and retains deletion metadata. Source run transcripts, task checkpoints in run history, provider conversations, and user backups have separate retention. Deleting memory does not erase those source histories or a prompt already supplied to a running CLI.

## Budgets, restart, and resume

The run's maximum steps is also Auto team's actual CLI invocation ceiling; an explicit smaller `maxInvocations` lowers that ceiling for planning and scheduling too. Provider retries and schema repairs count. At most `min(4, floor(limit / 4))` invocations may be coordination calls, and the runtime reserves a turn for independent review when admitting work. At least four invocations are required for a new team. These are bounds on authorized invocations, not a claim that coordination will always be 25% of actual usage.

The team view reports lifetime invocations, coordination share, questions, blocked turns, and revisions. Provider-reported tokens and API-equivalent cost remain unknown where the provider does not report them; cost is not a subscription bill.

Launch reservations are recorded before starting a CLI. After a crash in the interval between that write and process launch, lifetime counts conservatively retain the reservation; the runtime cannot prove whether an external process started.

Accepted decisions and outcomes use the existing fsynced replay journal. A failed authoritative write stops dependent dispatch. Recovery ignores an incomplete final journal record, removes that incomplete tail before the next append, and rejects malformed complete records. Event logs remain best-effort projections. SSE reconnects across server restarts reconcile an authoritative snapshot before continuing the stream.

A blocked Auto run is **stopped**, with its work available and its workflow unfinished. **Resume** replays completed allocations, including their final review and repair steps, then grants a fresh bounded allocation. Interrupted allocations continue their recorded workflow. Lifetime usage remains visible across resumes; replayed calls do not spend again. A missing provider session falls back to a fresh session with explicit task context. As with other patterns, a CLI can perform work immediately before a crash, so recovery does not promise exactly-once external execution.

During a run, **Revise goal** stops the old execution, retains its branches and supplied context, then opens a linked team plan for your changed requirements. It uses a new explicit budget and the configured approval checkpoint. Ordinary member notes leave the accepted requirement set intact. Source trust and lockdown follow both forms of continuation.

After completion, **Whole team · new run** plans and verifies your follow-up against the result branch. The reply box exposes its new call/time allocation; direct follow-ups can use a one-call budget and also enforce an explicit launch ceiling including retries. A provider-addressed follow-up starts outside the team's private member sessions, then can continue its own conversation. A direct agent follow-up that changes the integrated result clears its previous team approval, even if its check passes. The run displays that it needs whole-team verification again.

## Adapter capabilities

| Capability in code-flow | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Structured outcomes and session continuation | Supported | Supported | Supported |
| Addressed questions at turn boundaries | Supported | Supported | Supported |
| User notes during a running turn | Next turn | App-server steering; next-turn fallback with exec | Next turn |
| Native permission requests | Existing allowlist policy | Declined | Existing sandbox/permission policy |
| Agent-accessible collaboration tools | Scoped per-turn MCP and allowlist | Scoped per-turn MCP, app-server and exec | Structured-outcome fallback |

The capabilities panel distinguishes tested, unsupported and unknown behavior using adapter protocol fixtures and installed CLI probes. Model behavior is measured separately. Native Claude and Codex agent-spawning tools are disabled for scoped team turns so code-flow retains ownership of the roster. Antigravity nested-agent controls and separate vendor-native token accounting remain unknown.

The live bridge binds a random loopback port and issues an expiring credential for one active member attempt. Credentials are stored in temporary files with mode 0600 and removed when the turn exits; they are absent from prompts, command-line arguments, run records and logs. The engine derives identity and provenance. A read-only reviewer can communicate without receiving source-write permissions; sandbox/network restrictions are not relaxed to enable collaboration.

## Implementation and evaluation

The implementation uses `src/teams.ts`, `src/patterns/auto-team-model.ts`, and `src/patterns/auto-team.ts`, with engine metadata and replay helpers. `src/memory.ts` provides versioned atomic file persistence; `src/team-memory.ts` applies run provenance and Git/project applicability. No native dependency or database migration is required, and Node 20 remains supported.

Tests use fake vendor CLIs and isolated repositories. They exercise plan validation/approval, same-provider identities, dependency waves, peer and user questions, restart/resume, member replacement, independent verification, storage failures, memory trust/revision/deletion, and the browser workflow. They demonstrate behavior, not model quality or subscription savings. `npm run evaluate:teams -- --fake` runs an isolated comparison without model calls. Use `--real --runs 1 --providers claude,codex --max-steps 12 --max-minutes 5 --out /absolute/output` for a bounded comparison through signed-in CLIs. Reports record mode, CLI versions, actual calls, coverage, coordinator overhead, peer waiting and journal-load size/time. Estimated avoidable barrier delay is labeled separately from observed waiting.

Insights shows evaluations and the recorded rollout decision. Fake or unknown runs cannot justify beta/default promotion. Auto remains experimental until the evidence meets the documented thresholds; default rollout requires a larger representative sample. See [implementation evidence](dynamic-teams-evaluation.md).

Set `CODEFLOW_AUTO_TEAM_ENABLED=false` to disable creation of new Auto runs. Existing teams remain inspectable and resumable; manual patterns and saved automations retain their compatibility. The feature does not require a database or new Node baseline.

The evaluation runner also accepts `--register-home /absolute/codeflow-home` to copy immutable reports into a chosen installation for Insights. This is explicit: it does not copy transcripts or change rollout settings. Reports are also available in the isolated evaluation home's `team-evaluations/` folder.
