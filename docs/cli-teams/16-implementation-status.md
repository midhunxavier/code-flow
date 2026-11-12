# Conversational teams: implementation status

Updated 2026-11-03. [Index](README.md). Current user instructions: [CLI conversation guide](../cli-conversational-teams.md) and [conversational web tasks](../conversational-tasks.md).

## Scope

The initial task-first implementation is in `src/cli-teams/`. It adds a private `cli-team` pattern to the existing RunManager without adding it to the web workflow picker. Existing web workflows, templates, saved-team storage, and HTTP client commands retain their behavior.

Implemented components:

- Strict candidate and preference contracts, model/effort discovery and pin resolution, source capture, immutable proposals, native MCP form confirmation, and browser or terminal acceptance as a fallback.
- Task-generated participant definitions and seven structured node types; no initial preset or saved-team APIs.
- A deterministic executor using the existing journal, provider adapters, worktrees, shared agent/check slots, command evidence, and run controls.
- Exact-target agreement, fresh final reviewers, bounded revision loops, serialized managed writes, and verification tied to the delivered snapshot.
- Plain-plan completion without false agreement, checks-only completion when no independent review was requested, and verification-only continuations that retain completed code without launching another writer. These remain explicit outcomes rather than presets.
- Fourteen project-scoped public MCP tools, stdio protocol negotiation, separate loopback session capabilities, bounded reads, heartbeats, host claim fencing, and artifact pagination.
- Reuse of the web owner or headless bootstrap of the same server; existing state-directory locking arbitrates competing startups.
- Transactional project configuration/skill installation, doctor, explicit preferences, interactive host attachment, terminal status/result/control commands, and ownership-aware uninstall.
- Lifetime launch/time accounting, shared transport/schema attempt ceilings per assignment, conservative accounting of unsettled invocation time, and worktree-preserving accepted continuations.
- Packaged runtime and skill resources; TOML parsing is bundled so the distributed package needs no dependency installation.

## Unified chat experience

**New chat** is now the default local-owner entry point. **Agent** uses the normal provider session, permissions and tools. **Team** uses a read-only contextual lead to answer, clarify, record guidance or propose a task-specific approach. Workers wait for exact-revision **Start task** acceptance. One chat holds multiple tasks and canonical results with one sidebar entry; existing workflows remain under their compatibility routes.

The chat adapter adds per-chat serialized mutations, durable idempotent receipts, separate event records, cursor polling, frozen message queues, private content-addressed files, browser-persisted drafts/attachments, and owned Agent/provider/Team source handoffs. Mode changes affect future work; accepted executions keep their settings. A shared lead allowance bounds preparation; execution allowances and exact-target gates use the existing CLI-team engine.

The fixed composer and independent reading area preserve reader position. Task details contains settings, allowances, queued messages, file context, actual participant/session receipts, guidance delivery, prior executions and worktrees. The primary result contains the final deliverable, with evidence fetched separately.

The public MCP surface now has fourteen tools, including explicit diff preview and checkout handoff. The private lead/preparation patterns are excluded from the workflow picker. Legacy workflows, templates, saved drafts, other providers, remote/container execution, automation and human collaboration retain their compatibility paths. See the [chat guide](../conversational-tasks.md).

A bounded real-provider acceptance run `2611022351-02ef53a8` completed with `verified_changes`: Claude `claude-haiku-5-5` at high effort implemented a small fix, the unchanged test passed, and Codex `gpt-6-luna` at high effort independently approved the same code. Both assignments recorded native CLI session receipts. The original checkout and staging index remained unchanged. This proves the local managed-provider path on the installed versions; it does not certify every CLI version or native-host interaction.

## Reconciliation of the original design

The redesign in [15](15-conversational-ux-redesign.md) governs initial UX. The following are deliberate contract changes from documents 01–14, not additional user choices:

| Earlier contract | Implemented contract |
| --- | --- |
| R04 saved-team CRUD and presets | Run-local generated participants/settings/processes; explicit project/personal preferences; saved-team management deferred |
| `plan-agreement`, `feature`, `review-changes` as selected workflow IDs | Planning, implementation, and review are composition outcomes; the instruction supplies the process |
| Separate required profile/team/workflow libraries | Immutable resolved definitions stored with the accepted run; no prior saved definitions required |
| Arbitrary graph edges plus seven node types | Ordered structured blocks of the same seven kinds; explicit input references, parallel tasks, joins, gate-controlled bounded loops; no arbitrary back edges or nested loops |
| `codeflow_propose_team` | `codeflow_propose_run`, requiring a host-authored candidate |
| Twelve public MCP tools | Ten, excluding list/save teams; see `src/cli-teams/tools.ts` for authoritative schemas |
| Global expected run revisions on all controls | Proposal revision/hash for acceptance/start; serialized idempotent run controls; exact attempt/token fencing for host claims |
| Desired current-session model binding | Current-session settings remain unverified; strict pins require managed workers; host writes are rejected |
| Optional native host acceptance | `start_run` requests a native form on hosts declaring support; the server-request reply confirms the exact revision/hash. Terminal acceptance remains a fallback |
| Public propose/run commands that select saved configurations | Primary invocation is the host skill/MCP connection; terminal commands handle setup, acceptance, inspection, attachment, and control |
| P7 preset/package work and T29 saved-team reuse | Lean onboarding/package work and preference inheritance/immutability; existing web definitions remain regression coverage |

Unchanged requirements include one runtime owner, revision-specific artifact evidence, no automatic permission/budget escalation, preservation of source files and index, explicit partial results, idempotent durable receipts, and no automatic merge/push/deployment.

Provider defaults and preferences are resolved during proposal creation. A proposal snapshot retains those values. Explicit model/effort selections do not silently change on dispatch. Available catalog entries are not a guarantee of account entitlement or successful inference.

## Evidence

`test/cli-teams.test.ts` exercises the complete service with real RunManager worktrees/journal/checks and fixture providers, plus the stdio/loopback transport. It covers the flagship agreement/final-review process, explicit model/effort settings, stale proposal acceptance, duplicate starts, actual command verification, host reattachment, UTF-8 pagination, staged/unstaged source capture, installer ownership, and durable replay after provider failure. An additional scenario uses the actual Claude/Codex adapters against the fake CLI executables instead of stubbing adapter results.

Historical validation on 2026-11-02 (before unified chat):

- `npm run typecheck` and `npm run package:npm` pass.
- Conversational-team and web-task service checks pass all 39 tests (29 CLI-team and 10 web-task tests); documentation and documentation-help checks pass all 12 tests. The new regression covers direct worker assignments and durable input attribution even when artifact prose misstates who ran.
- The browser run passes all 21 tests: five new conversational journeys and 16 existing project/automation journeys. The five new journeys also pass after the final result-layout changes, covering mobile layout, draft restoration, source preservation, clarification, rejected design checkpoints, and owner restart.
- The final packaged-install suite passes all 13 tests, including an installed package outside the checkout that bootstraps one owner, executes through MCP with fixture CLI providers, retrieves the plan, and uninstalls its owned configuration.
- Focused existing engine, adapter, Codex app-server, permissions, status, and review regression suites pass all 103 tests.
- The earlier full regression run was not green: 22 failures and three cancellations. The new guide's missing navigation registration was fixed; affected documentation, ACP, automation, and port-fixture rechecks pass. Two preview-browser cases still timed out in grouped rechecks and passed when run in isolation on both this checkout and the untouched baseline. This does not establish a clean full-suite run; keep that limitation in release reporting.

A fixture test is not native live evidence. Full-suite and bounded live certification remain release checks.

Native read-only discovery on 2026-11-02 (`node --import tsx scripts/probe-cli-teams-hosts.mjs`):

| Host | Skill found | Public MCP tools | Inference calls |
| --- | --- | --- | --- |
| Claude Code 2.1.316 | Yes | 10, connected | 0 |
| Codex CLI 0.165.0 | Yes | 10, connected | 0 |

The probe uses an ephemeral Codex thread and temporary project/state directories. Both hosts declare form elicitation support. A native Codex `mcpServer/tool/call` roundtrip requests confirmation and returns the probe client's decline, with no run created and zero inference calls. Claude's read-only probe verifies the capability declaration and discovery; it does not exercise an interactive human dialog or a paid model turn. Codex stdio configuration must forward `CODEFLOW_HOME` to retain an explicitly selected state directory; the installer declares that environment variable by name without committing a path. Native discovery is separate from paid agent execution and human acceptance.

An installed-launcher read-only check against an existing owner under a custom `CODEFLOW_HOME` also reports `approvalMethod: native_form`, exposes ten tools, and reuses that owner's PID. The real pending proposal was not approved or started by this check. Existing MCP processes must reconnect to load the updated wrapper and instructions.

A bounded live web continuation on 2026-11-02 (`2611022102-bdb9fa87`) completed six managed assignments: three using Claude `claude-haiku-5-5` at high effort and three using Codex `gpt-6-luna` at high effort. Both independent strategies, both cross-reviews, consolidation, and the final Codex review have native session receipts. The transcript records no nested agent CLI launch/probe attempts. The original repository HEAD, status, diff, and staging index remained unchanged. The final review confirms the runtime attributions and retains one content-priority correction; this is `plan_ready`, not unanimous agreement. This validates the repaired web planning path, rather than certifying every host, permission profile, or live-provider behavior.

## Release boundaries

Native skill discovery, exact current-session model metadata, native form presentation, and live model behavior remain provider/version-dependent. The implementation uses documented project configuration, capability-negotiated form elicitation, and an explicit terminal fallback. Automated tests exercise accept/decline/cancel, stale revisions, duplicate starts, disconnects, and rejection of model-authored approval arguments. Full release certification still requires bounded live walkthroughs in both native hosts, with the tested versions, settings, output delivery, and limitations recorded.

Do not label the integration as release-certified from fake-provider tests alone. Keep the CLI guide's experimental label until the live evidence required by [12](12-test-and-release-plan.md) is available. Interrupted writes without durable completion are preserved and require inspection/a fresh continuation proposal; they are not blindly relaunched.

## CLI visual workspace stages 1–3

Implemented: stable task links; explicit `codeflow open` / `codeflow_open_task`; durable project/chat/task association; native or browser acceptance of the same exact revision; shared progress, questions, guidance, controls and recovery; startup reconciliation; visible disconnected CLI assignments. The public MCP surface now has fourteen tools, including exact diff preview and confirmed checkout application. The existing web workflow engine is preserved. Embedded MCP Apps UI and mirroring a native host's full transcript remain deferred.

Validation covers both form-capable and tool-only MCP hosts, a real browser with isolated fixture providers, exact-revision fencing, duplicate starts, continuation approvals, both providers participating, journal recovery, cross-repository isolation and expiring browser handoffs. Fixture checks do not claim live vendor inference certification.

## CLI reliability follow-up

Attachment transport now accommodates the supported file limits and returns correlated validation errors. Artifact discovery and recorded changed-file metadata paginate independently. MCP exposes recorded participant settings, sessions, snapshot evidence, last review decisions and continuation context. Recent/unfinished work can be discovered without a known run ID. Terminal status connections are never offered as attachment targets; expired sessions are rejected.

Setup/status output is readable by default with `--json` for scripts. Deterministic snapshot/check nodes no longer require host-authored instructions. Attempt timeouts are capped by the run's execution allowance. Completed work returns an explicit no-op on resume. Start preflight checks every managed provider's availability before dispatch, while doctor distinguishes model discovery from authentication and execution permissions.

The 2026-11-03 native read-only probe passed with Codex CLI 0.165.0 and Claude Code 2.1.317: both discovered all twelve tools and the skill, and both declared form support. Codex's confirmation was safely declined without creating a run. This probe used zero inference calls and does not certify live worker behaviour or Claude's interactive approval dialog.

## CLI conversation UX (2026-11-04)

MCP text now uses readable summaries alongside structured data. Progress distinguishes worker queues, host/user waits, pause settling and interrupted work; guidance receipts describe actual delivery. A compact proposal summary precedes full exact-revision confirmation. Host-side discovery checks live connection and project configuration without inference.

`context.reuseRunId` resolves the prior deliverable, chat, source and matching participant settings while retaining source freshness checks. Verified results include check/review evidence and a handoff action. `codeflow diff` and `codeflow apply` preview and stage the exact task delta in a clean checkout after native/terminal confirmation. Retained implementation remains included across continuations; pre-existing user source changes are excluded. Durable effect receipts prevent duplicate application and fence interrupted writes.

See [implementation plan](17-cli-ux-implementation.md).

## Simple surface (2026-11-12)

A CLI is now shown six tools by default: `codeflow_run` (three fixed recipes: review, plan, implement), `codeflow_start_run`, `codeflow_status`, `codeflow_steer_run`, `codeflow_apply` and `codeflow_providers`. They are composed in the host-side bridge from the fourteen owner operations, which are unchanged and listed after `codeflow tools all`. Starting returns at once; results are written to a file; `codeflow run` and `codeflow wait` give the same flow to any shell. Local funnel metrics, a Claude Code plugin and a live canary script are included.

Design, decisions and limits: [CLI host simplification](../design/cli-host-simplification.md). Validation is with fixture providers only (`test/cli-simple.test.ts`); no live host or provider run has exercised this surface yet.
