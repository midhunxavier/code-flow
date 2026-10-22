# Team

Start with an Agent conversation and enable **Team** whenever the task needs collaboration. Choose a template and providers in Team setup. You can turn Team off and continue with the same agent, task, workspace and conversation.

## Review the proposed team

Open **Team**, enable it, and select the template, coordinator and providers code-flow may use. A coordinator inspects the repository and proposes individual members, tasks, dependencies, file ownership, and acceptance criteria. You can approve, revise, or reject that plan before workers start. Planning itself uses a CLI invocation. Approval defaults on; an explicitly saved preference or automation policy still applies.

Team is available unless disabled with `CODEFLOW_AUTO_TEAM_ENABLED=false`. Existing saved workflow and project choices are preserved. Simple conversational questions are answered by the lead without starting another team; explicit team requests and substantial work use the configured workflow. Team progress stays collapsed under its chat message. Corrections sent while a team works stop the current execution and enter a revised request, with a visible acknowledgement and preserved partial work. Existing manual patterns are available under Advanced as built-in workflow templates. It uses the same official CLI adapters, worktrees, checks, permissions, review/shipping actions, and subscription logins as other runs.

## Reusable templates in Advanced

Open **Advanced** to choose a built-in workflow, design a task graph, import/export definitions, or publish a new immutable template version. Templates can be personal or scoped to a project. Use **Import browser library** to migrate existing presets without deleting the browser originals; role/model preferences and workflow options survive, while permission grants, credentials, host bindings, and budgets do not.

Auto generates plans without needing a template. It may also reuse enabled task graphs, assign their roles, combine instances, and append task-specific instructions. The runtime preserves dependencies, acceptance criteria, and shared contracts, then applies normal plan validation and independent verification. Up to six enabled definitions of 16,000 characters each are offered per run, in ID order. Fixed workflows such as test-first, races, and councils keep their existing executors in Advanced; they are not advertised as composable Auto task graphs.

A manually selected template is mandatory. Its exact version and inputs are pinned to the run and survive cancellation/recovery; editing the library does not change an active run. The run menu's **Save as team template…** opens an editable preview. Review task-specific instructions and replace them with parameters before publishing. Saving does not enable Auto reuse automatically.

## Run permissions across providers

All new runs use one versioned permission policy, including background jobs and collaborative launches. Every planning, worker, review, repair, retry, and follow-up launch resolves that policy against current restrictions and the selected provider. Read-only planning does not reduce implementation workers to read-only access. Templates and agent messages cannot grant permissions; only an explicit user change creates a new policy revision. Child runs inherit the parent’s current trust ceiling, approval preference, mandatory restrictions, and container or remote execution environment. A child cannot increase its parent’s permissions or remove its execution boundary. Historical saved runs without a policy retain their legacy behavior.

Claude and Codex receive their native permission settings, with provider-native delegation disabled. Matching trust labels do not imply identical isolation: Codex uses its provider sandbox, while Claude's local tool rules are not an operating-system filesystem boundary. Advanced can require an agent workspace write boundary, denied agent-command network access, or disabled external tools. Unsupported combinations fail before launch or replacement dispatch. The run view records the effective settings for each turn. By default, Antigravity uses the local macOS isolated executor with supported CLI 1.4.4 or 1.4.5 and an existing native Keychain login. Interactive Agent and Team turns receive task-scoped Codeflow browser and computer tools when external tools are permitted; computer use requires Full access. It uses protected fresh settings, has no native terminal/browser/delegation or ambient MCP servers, and never resumes native sessions. Mandatory external-tool restrictions retain its file-only profile. Shared-tool live validation covers 1.4.5. Advanced also offers explicit unrestricted native Antigravity on the local host; see below. Remote/container Antigravity, ACP and extension adapters remain blocked. Claude/Codex controls are probed again at each launch, in the selected container when applicable. Unknown or missing controls stop execution.

Remote workers receive and validate the complete policy, including all mandatory requirements; remote/container profiles that cannot prove a requested boundary are rejected. Required interactive approvals need the local Codex app-server and an approval handler; they cannot silently fall back to exec or combine with mandatory sandbox boundaries that approval could relax.

Claude’s external-tool restriction supplies a strict MCP configuration, disables Chrome integration, and denies WebSearch/WebFetch; Code Flow’s scoped team bridge remains available. Codex managed turns override ambient approval settings, additional writable roots, and command-network settings. A mandatory workspace write boundary also removes temporary-directory write exemptions. Native-delegation controls disable provider agent tools; they are not process-level isolation from programs invoked through an authorized shell.

These requirements describe agent execution. Browser/MCP authorization is separate from terminal network access. Setup commands, checks, and previews use their separately configured execution environment. Worktrees do not restrict file reads. The built-in shared browser/computer bridge applies the same task-scoped tool checks across Claude, Codex and Antigravity. Arbitrary provider-configured integrations and filesystem reads do not share a cross-provider sandbox.

## How work proceeds

1. The runtime validates the proposed plan against installed providers, quota observations, configured model/effort pins, member/task limits, dependency cycles, and review independence.
2. New runs start ready tasks as earlier tasks finish, without waiting for unrelated workers. Saved wave-based runs retain their recorded scheduling behavior. Each member has its own identity and session, even when several members use the same provider. Tasks with overlapping file ownership run separately.
3. A worker returns a structured outcome: submitted work, a failure, or a question with a progress checkpoint. Submitted changes are integrated serially and checked before dependent work starts.
4. When a decision is needed, the coordinator can add bounded work or workers, reassign unfinished work, retire idle workers, and add shared contracts. It cannot remove approved requirements or raise its own limits.
5. An independent read-only member reviews the integrated result. Blocking findings can trigger bounded repairs, followed by another check and review of the current commit.

An implementation is verified only when required work is present, the configured check passes, independent review has no blocking findings, and fail-to-pass proof succeeds when enabled. Unresolved tasks, blocking review findings and failing checks are gaps that stop the team. A repository without a runnable check cannot be blocked on it: the result finishes as reviewed but unverified, with no pass/fail verdict, and nothing from it is accepted into team or project memory. An investigation can finish with evidence-bearing artifacts and independent review without a code check. The run does not merge or publish its result automatically.

## Communication and blockers

Members send addressed questions and replies through their structured outcomes. The runtime attaches the sender, task, request ID, and origin; an agent message never becomes user authorization. A worker needing information ends its turn, saving its partial work and checkpoint. Its CLI slot is then available for other work.

The next scheduling boundary delivers an existing answer or runs a short read-only response turn for the addressed member. A question addressed to you appears in the run view and in **Needs you**. Your answer is saved before the waiting workflow is released. The run clock pauses while waiting for you. An unanswered peer request or failed task can prompt a bounded coordinator revision; exhausted limits produce an explicit blocker.

You can also send a note to an individual member. Codex app-server can receive user notes during a turn; other transports receive them on the next turn. Native permission requests remain denied under the existing adapter policy. Auto members use the structured question protocol for missing information.

Claude and Codex members also receive scoped collaboration tools when their installed CLI supports the configuration. They can send messages, ask/reply, read their inbox, publish findings, save notes, or propose project memory during a turn. Calls acknowledge durable acceptance promptly; the scheduler applies commands at recorded boundaries. A blocked member still ends its turn to release the process slot. Each turn may make at most 256 collaboration tool calls (messages, questions, memory reads and writes together); after that, calls fail and the member finishes with its structured outcome. New controlled runs support Claude, Codex and isolated Antigravity. Explicit unrestricted Antigravity is an exception to the native-delegation restriction; other adapters remain rejected. Older saved runs retain their recorded execution behavior.

Question and wait state are one logical journal transaction. Duplicate operation IDs do not duplicate messages. Expired deadlines, unavailable recipients and cyclic waits route to the coordinator within the existing budget. Reassigned or retired attempts cannot overwrite current work. Knowledge dependencies can use evidence-bearing replies; artifact dependencies require integrated code, and completion dependencies require the upstream task to finish.

## Three memory scopes

| Scope | Contents | Who receives it |
|---|---|---|
| Private | Observable progress, attempts, unresolved questions, and a portable checkpoint | That member; a replacement receives a separately authored shared handover and artifacts |
| Team | Accepted contracts, task outcomes, questions, findings, and artifact references | Members whose assignment needs the information; reviewers receive independent review context |
| Project | Accepted conventions and reusable facts with source, revision, and applicability | Future matching runs in the same project and repository |

Private scope controls context assembly and memory APIs; it is not filesystem secrecy from a fully trusted process on the same machine. Checkpoints describe observable work, not hidden model reasoning.

The team view shows members, dependencies, messages, requirement coverage, checkpoints, and each worker turn's context references. The project-memory panel shows included and omitted entries with reasons, provenance, and branch applicability. You can create, edit, accept, delete, or rate a memory as useful, irrelevant, stale or incorrect. Saving an edit never accepts a proposal: a proposal stays a proposal until you accept it, and an accepted entry you edit is recorded as accepted by you. Edits require the displayed revision, so concurrent changes cannot silently overwrite one another.

Structured worker findings become project **proposals** after result verification. Live tools can save an earlier proposal, explicitly unverified and requiring user review. They remain tied to the result branch and commit. Accepting a branch-specific proposal does not make it a convention for every branch; changing it to **Use across this repository** is an explicit user decision. Repository membership, branch/commit ancestry, expiry, and source revisions are checked when selecting memory. Retrieval uses bounded text/path/tag matching, without embeddings. User feedback adjusts ranking only for that revision; stale or incorrect revisions are excluded. Feedback never raises trust or authorizes promotion.

Locked-down, untrusted, or unknown-origin material cannot automatically become accepted project knowledge, including through a derived summary. The user must approve the exact revision. Auto teams do not consume historical recurring lessons whose provenance is missing; explicit repository conventions and accepted project memory are separate inputs. Automatic learning is also disabled for untrusted sources.

Deleting a memory erases its stored body, removes it from retrieval, and retains deletion metadata. Entries that list it in their provenance (it was in a member's context when they were written) keep their own text and the origins they inherited from it, so a running or resumed team that still cites it keeps working. Private checkpoints and team records are retired when their run is archived with cleanup; project knowledge is never removed that way. A run may hold at most 512 private and team records. Source run transcripts, task checkpoints in run history, provider conversations, and user backups have separate retention. Deleting memory does not erase those source histories or a prompt already supplied to a running CLI.

## Budgets, restart, and resume

The run's maximum steps is also Auto team's actual CLI invocation ceiling; an explicit smaller `maxInvocations` lowers that ceiling for planning and scheduling too. Provider retries and schema repairs count. Up to one quarter of the invocation allowance may be coordinator calls, and the runtime reserves a turn for independent review when admitting work. New runs default to 200 calls over 240 minutes, allowing up to 50 coordinator calls. At least four invocations are required for a new team. These are bounds on authorized invocations, not a claim that coordination will always be 25% of actual usage.

When a run stops, edit **Maximum calls** and **Maximum minutes** before resuming, or choose **Use extended budget** for 200 calls and 240 minutes. Resume grants a fresh allocation, reuses completed results and worktrees, and retains lifetime usage. Saved runs keep their existing limits until you explicitly change them.

The team view reports lifetime invocations, coordination share, questions, blocked turns, and revisions. Provider-reported tokens and API-equivalent cost remain unknown where the provider does not report them; cost is not a subscription bill.

Launch reservations are recorded before starting a CLI. After a crash in the interval between that write and process launch, lifetime counts conservatively retain the reservation; the runtime cannot prove whether an external process started.

Accepted decisions and outcomes use the existing fsynced replay journal. A failed authoritative write stops dependent dispatch. Recovery ignores an incomplete final journal record, removes that incomplete tail before the next append, and rejects malformed complete records. Event logs remain best-effort projections. SSE reconnects across server restarts reconcile an authoritative snapshot before continuing the stream.

A blocked Auto run is **stopped**, with its work available and its workflow unfinished. **Resume** replays completed allocations, including their final review and repair steps, then grants a fresh bounded allocation. Interrupted allocations continue their recorded workflow. Lifetime usage remains visible across resumes; replayed calls do not spend again. A missing provider session falls back to a fresh session with explicit task context. As with other patterns, a CLI can perform work immediately before a crash, so recovery does not promise exactly-once external execution.

During a run, **Revise goal** stops the old execution, retains its branches and supplied context, then opens a linked team plan for your changed requirements. It uses a new explicit budget and the configured approval checkpoint. Ordinary member notes leave the accepted requirement set intact. Source trust and lockdown follow both forms of continuation.

After completion, **Whole team · new run** plans and verifies your follow-up against the result branch. The reply box exposes its new call/time allocation; direct follow-ups can use a one-call budget and also enforce an explicit launch ceiling including retries. A provider-addressed follow-up starts outside the team's private member sessions, then can continue its own conversation. A direct agent follow-up that changes the integrated result clears its previous team approval, even if its check passes. The run displays that it needs whole-team verification again.

## Adapter capabilities

| Capability in code-flow | Claude Code | Codex | Antigravity |
|---|---|---|---|
| Structured outcomes and session continuation | Supported | Supported | Structured outcomes; fresh turns with portable context |
| Addressed questions at turn boundaries | Supported | Supported | Supported |
| User notes during a running turn | Next turn | App-server steering; next-turn fallback with exec | Next turn |
| Native permission requests | Existing allowlist policy | Declined | Protected file-only policy; no interactive approvals |
| Agent-accessible collaboration tools | Scoped per-turn MCP and allowlist; `--strict-mcp-config`, so your own and the repository's MCP servers are not loaded in these turns | Scoped per-turn MCP, app-server and exec | Structured-outcome fallback |

The capabilities panel distinguishes tested, unsupported and unknown behavior using adapter protocol fixtures and installed CLI probes. Inventory probe results are kept for ten minutes; an unknown result (a CLI missing or not signed in, or a probe that timed out) is kept for two, while managed launch controls are checked afresh before each turn. Model behavior is measured separately. Native Claude and Codex agent-spawning tools are disabled for scoped team turns so code-flow retains ownership of the roster. Default Antigravity uses a protected file-tool allowlist and macOS process/filesystem restrictions; native delegation is excluded. The explicit unrestricted option does not enforce these restrictions. Its built-in local task bookkeeping tool can remain visible. Separate vendor-native token accounting remains unknown.

The live bridge binds a random loopback port and issues an expiring credential for one active member attempt. Credentials are stored in temporary files with mode 0600 and removed when the turn exits; they are absent from prompts, command-line arguments, run records and logs. The path of the credential file is on the command line, and every CLI on this machine runs as your user: a member that can run shell commands could read another member's credential while that turn is starting. The bridge client deletes the file as soon as it has read it, which narrows the window to process start; this is isolation between members and the application's own token, not between members. The engine derives identity and provenance. A read-only reviewer can communicate without receiving source-write permissions; sandbox/network restrictions are not relaxed to enable collaboration.

## Implementation and evaluation

The implementation uses `src/teams.ts`, `src/patterns/auto-team-model.ts`, and `src/patterns/auto-team.ts`, with engine metadata and replay helpers. `src/memory.ts` applies versioned memory rules over `src/memory-sqlite.ts`; `src/team-memory.ts` applies run provenance and Git/project applicability. Structured memory uses SQLite with automatic JSON migration and evidence-linked graph retrieval. Node 22.13 or newer is required; no native npm addon is needed. See [Memory storage](memory-storage.md).

Tests use fake vendor CLIs and isolated repositories. They exercise plan validation/approval, same-provider identities, dependency waves, peer and user questions, restart/resume, member replacement, independent verification, storage failures, memory trust/revision/deletion, and the browser workflow. They demonstrate behavior, not model quality or subscription savings. `npm run evaluate:teams -- --fake` runs an isolated comparison without model calls. Use `--real --runs 1 --providers claude,codex --max-steps 12 --max-minutes 5 --out /absolute/output` for a bounded comparison through signed-in CLIs. Reports record mode, CLI versions, actual calls, coverage, coordinator overhead, peer waiting and journal-load size/time. Estimated avoidable barrier delay is labeled separately from observed waiting.

Insights shows evaluations and the recorded rollout decision. Fake or unknown runs cannot justify beta/default promotion. Promotion beyond the experimental stage requires the documented evidence thresholds; default rollout requires a larger representative sample. See [implementation evidence](dynamic-teams-evaluation.md).

Set `CODEFLOW_AUTO_TEAM_ENABLED=false` to disable creation of new Auto runs. Existing teams remain inspectable and resumable; manual patterns and saved automations retain their compatibility. The feature does not require a database or new Node baseline.

The evaluation runner also accepts `--register-home /absolute/codeflow-home` to copy immutable reports into a chosen installation for Insights. This is explicit: it does not copy transcripts or change rollout settings. Reports are also available in the isolated evaluation home's `team-evaluations/` folder.

---

[Documentation library](README.md) · [Getting started](getting-started.md) · [Ask code-flow](help.md)

## Automatic worker models

New Auto runs discover candidates through the connected CLI: Claude's stream-control initialization, Codex app-server `model/list`, and Antigravity `agy models`. The coordinator keeps the provider, model and effort selected by the user, including existing CLI defaults. Workers and reviewers use automatic selection unless their Advanced pool/model/effort settings pin or restrict them. Global coordinator defaults do not silently pin workers.

Advanced → Automatic worker selection shows cached model IDs, exact effort support, stale/unknown states and refresh. Official-document research is opt-in. Local catalog previews do not establish remote/container availability: those environments discover their own models when a run starts. Antigravity worker discovery runs inside the same macOS executor with a separate catalog identity. Its model listings do not establish per-model inference or effort support. The coordinator sees the effective file and task-tool capabilities and rejects unsupported execution environments. Every launch rechecks the CLI version and creates a clean protected profile. See [permission verification](worker-permission-verification.md#existing-login-reuse-and-managed-file-workers).

Catalogs live under `CODEFLOW_HOME/model-catalogs`, partitioned by provider and execution environment. Discovery has a ten-minute cache; failed refreshes retain previous evidence. `CODEFLOW_MODEL_NETWORK=offline` disables discovery and documentation fetches and uses cached entries. This switch does not disable provider inference or the run's separately configured tools. Documentation research uses official origins, bounded downloads and a closed schema, with a seven-day attempt cache. Web text cannot grant permissions or prove account access. Unknown context, pricing, capabilities and effort support remain unknown; an explicit empty effort list means no effort control.

CLI-reported availability, advertised compatibility, documented facts and measured run observations are distinct. A listed model is a candidate, not a guarantee that a paid inference call will succeed. Exact accepted worker choices, rationale, environment and catalog revision/source are saved with the step; discovery revisions have immutable snapshots. Recovery reuses recorded choices and rechecks eligibility before another execution. Failed members can be replaced within existing revision/invocation limits using portable checkpoints; native sessions stay with their provider/member.

The first version uses existing routing and budget checks, not a learned performance ranker. Costs and token limits retain their existing provider-reporting limitations; unknown pricing cannot supply an exact prospective cost guarantee. Run observations are diagnostic evidence, not benchmark scores or authority to enable a model. Public documentation only augments CLI-reported IDs; it does not make a public-only model eligible.

See [the live permission verification report](worker-permission-verification.md) for tested versions, native-control fixes and remaining boundaries.

If an isolated Antigravity worker cannot use or refresh its native login, check or unlock the login in Antigravity's normal interactive session and select **Resume**. Code Flow verifies it again through isolated model discovery before clearing the signed-out cooldown. Cached models or offline discovery cannot establish login access. Recovery keeps the recorded assignment and portable work, then starts a fresh restricted worker; it never imports a native conversation or widens permissions to refresh credentials. Native authentication diagnostics are withheld from run history.

### Unrestricted Antigravity with an existing login

Enable **Advanced → Antigravity execution → Use unrestricted Antigravity with my existing login** for a new local attended run. This explicitly grants Antigravity full native access using the existing login and provider configuration. Shared Codeflow tools are added through a private temporary configuration overlay. It skips the isolated profile and vendor sandbox and uses the CLI's permission-skip flag. It requires a valid saved login; it does not provide anonymous access or guarantee that the provider will never require reauthentication.

Terminal, browser, MCP, hooks and native agents follow the native provider configuration. Code Flow cannot enforce workspace boundaries or read-only access in this mode. Native agent usage is outside Code Flow's worker budget. The selection is visible in Advanced, run details, coordinator inventory and each step's permission receipt (`agy-native-v1`). Claude and Codex keep the ordinary run policy.

The option is rejected with mandatory permission requirements, Safe mode, narrowed turn trust, interactive tool approvals, remote/container workers or unattended/locked-down execution. Templates and model choices cannot enable it. A continuation inherits the parent's choice and may narrow it to isolated execution, but cannot upgrade an isolated parent. Existing saved runs stay isolated; there is no automatic fallback on authentication or sandbox errors.

Native model discovery uses the existing profile, with a catalog identity distinct from isolated discovery. Both modes keep portable checkpoints and start fresh managed turns without native session reuse. Recovery after an authentication failure requires a fresh successful discovery in the recorded mode; cached/offline results cannot clear the failure. Private authentication diagnostics are checked for observed persistence failures and deleted without entering run history. Actual expired-token refresh remains unverified unless observed during normal provider operation.

### Steering and recovery in a conversation

Keep using the main composer while Team works. Name a worker, assignment, or owned file when correcting a specific part—for example, “For api.txt, use the revised wording.” Code Flow stops that assignment and invalidates dependent work while unrelated teammates continue. Its acknowledgement means the revised instructions reached the assignment, not that the change has passed review. Ambiguous corrections affect the whole graph. Corrections during planning or final verification safely restart the delegated execution with its preserved context and remaining budget.

The Browser panel has **Take control** and **Let agents continue**. Taking control waits for the current action to settle, then pauses queued agent browser calls. You and the agents keep the same tabs, cookies, uploads and downloads. Ordinary mouse/keyboard input briefly takes control and releases it afterward. Agents can release their browser lease through `browser_control`; idle leases expire after 30 seconds, and queued calls have a bounded 90-second wait. A new owner must inspect the current page before acting.

Team coordination, workers and review can continue with another eligible provider from the configured pool after a provider failure. The replacement receives the current assignment, files and recorded tool-action history in a fresh provider session. Model pins, tool permissions, independence requirements and the remaining budget still apply. An unavailable strict independent reviewer blocks completion when no eligible replacement exists. The advanced Auto workflow option `providerFailover: false` retains manual provider recovery. Provider changes are recorded under Team activity.

If your edits overlap a team result, open **Team activity → Resolve conflicts**. Compare the starting version, your version and the team version; keep either version or edit a text result. Non-overlapping edits merge automatically. Code Flow rejects stale comparisons and preserves your branch and staging area. Applying a resolution runs the configured checks, including verification-profile gates, against the combined workspace. This check does not replace independent review of newly edited text. Binary and symbolic-link conflicts require choosing an existing version; complex repository conflicts can still be resolved in an editor.
