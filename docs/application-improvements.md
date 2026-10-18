# Application improvement program

This work continues the application review on branch `codex/application-improvements`, created from `main` at `abbb6be`. The original review contained defects, 14 broader product problems, and 73 feature ideas; those are tracked separately below.

Current scope: all six priority correctness packages implemented; all 14 broader
problems have concrete improvements; all 73 feature items have implemented
acceptance scopes. Full-suite acceptance passed. Results are recorded
below; feature boundaries remain explicit rather than claiming unrestricted
provider parity or complete accessibility conformance.
An item is complete only when its behavior is implemented, reachable from its
intended interface, documented, and covered by appropriate validation. A service
interface, mock, or roadmap entry alone is not an implemented feature.

## Correctness and quality gates

- [x] Destination symlink containment and exclusive worktree copying.
- [x] Repository selection and configuration responses cannot overwrite newer choices.
- [x] Notes initialization, failed-write recovery, revision history, and conflicts.
- [x] Invalid routes recover without blanking the application.
- [x] Memory deletion descriptions match actual semantics; editing resolves conflicts.
- [x] Critical browser flows are required by CI, with stable test synchronization.

## Existing product problems

- [x] 1. Simplify the first-run decisions.
- [x] 2. Give the composer room instead of opening an empty side panel.
- [x] 3. Make mobile execution controls readily accessible.
- [x] 4. Use consistent completion and verification states.
- [x] 5. Surface native tool approvals.
- [x] 6. Make execution isolation explicit and enforceable.
- [x] 7. Secure phone transport and individual sessions.
- [x] 8. Bound history startup, storage, and browsing. Streaming recovery uses four concurrent runs; archived detail uses an eight-entry/32 MiB cache and compact source-validated projections; old attention is capped and visibly paginated. Compact IDs and active/resumable metadata still scale with history. See [run storage](run-storage.md).
- [x] 9. Include inline GitHub review comments.
- [x] 10. Enforce browser correctness in CI.
- [x] 11. Make evaluation reproducible and retain experimental evidence gates.
- [x] 12. Separate core responsibilities behind tested modules. Persistence projection/recovery/cold storage, workspace operations, shared authorization, policy enforcement, remote execution, code-host operations and repository coordination have explicit tested modules. The engine retains execution authority and the server composes the route/lifecycle boundaries; further size reduction is ongoing maintenance.
- [x] 13. Improve keyboard, focus, touch, and screen-reader behavior. Theme/viewport browser audits, keyboard navigation and focus restoration, inert closed panels, contrast, target size, mobile tool selection and reduced motion are covered. Assistive-technology/user testing remains ongoing; no complete WCAG certification is claimed. See [accessibility acceptance](accessibility.md).
- [x] 14. Attribute provider results with samples and uncertainty.

## Feature acceptance backlog

- [x] 1. Guided onboarding and dependency/authentication health, including explicit terminal/browser/Docker discovery and refresh.
- [x] 2. Repository readiness inspection and isolated command validation.
- [x] 3. Simple and advanced composer modes.
- [x] 4. Named versioned team presets with import/export.
- [x] 5. Editable acceptance criteria.
- [x] 6. Parameterized task templates.
- [x] 7. Effective settings and provenance inspection.
- [x] 8. Command palette.
- [x] 9. Scoped native tool approval inbox.
- [x] 10. Editable validated workflow graph.
- [x] 11. Priority queue and project fairness.
- [x] 12. Safe checkpoint pause.
- [x] 13. Fork from a checkpoint.
- [x] 14. Selective task reruns and downstream evidence invalidation, with pinned retained baselines and fresh final review/checks.
- [x] 15. Quota-aware deferred execution with durable claims, reported reset windows and explicit ambiguous-launch recovery.
- [x] 16. Token and API-equivalent usage ceilings.
- [x] 17. Conflict-aware task assignments.
- [x] 18. SSH remote workers with explicit repository mappings, worker-local credentials, bounded exact source/result bundles, heartbeats, cancellation, durable claims and receipt-only recovery. Actual encrypted loopback SSH acceptance passed. See [worker setup](remote-workers.md).
- [x] 19. Multiple verification gates.
- [x] 20. Repository verification profiles.
- [x] 21. Requirement-to-evidence mapping across workflows.
- [x] 22. Review coverage reporting.
- [x] 23. Change risk summaries.
- [x] 24. Baseline and flaky-check diagnosis.
- [x] 25. Optional mutation verification.
- [x] 26. Visual and accessibility verification gates.
- [x] 27. GitHub review threads with inline locations/replies, bounded complete-thread loading, explicit remote resolve/reopen, fresh revision/head checks and honest postflight race reporting. See [thread synchronization](github-review-threads.md).
- [x] 28. Validate the current merge target.
- [x] 29. Export verification reports.
- [x] 30. Symbol-aware code search and JavaScript/TypeScript imported references through an isolated language service.
- [x] 31. Static architecture exploration across JavaScript/TypeScript, Python, Go, Rust and Java, including manifest packages, directory boundaries, cycles, explicit unresolved/computed edges and exports. No project configuration executes. See [architecture explorer](architecture-explorer.md).
- [x] 32. File editing with save previews and conflicts.
- [x] 33. Selective file/hunk application.
- [x] 34. Three-way conflict resolution.
- [x] 35. Multi-service workspace launch profiles.
- [x] 36. Context inspection before dispatch: bounded directory expansion, explicit assembled-input measurements and warn/block ceilings. Hidden provider history and later file/image tokens are outside this scope.
- [x] 37. Concurrent workspace activity coordination with in-process workspace mutation leases across starts, resumes and owned worktrees. External/manual programs remain outside the lease system.
- [x] 38. Full checkpoint comparison and guarded staged inverse commits, alongside selective file/hunk restoration. Merge-commit mainline decisions remain manual.
- [x] 39. Memory provenance graph.
- [x] 40. Memory edit conflict resolution.
- [x] 41. Memory deletion impact preview.
- [x] 42. Stale-memory detection.
- [x] 43. Memory duplicates and supported semantic contradictions with policy synonyms/negation, structured boolean/text/numeric interval claims, unit conversion, exact source revisions and overlapping applicability. Unsupported prose is counted and no winner is selected automatically. See [semantic claims](memory-claims.md).
- [x] 44. Dedicated versioned project conventions with immutable history, conflict-safe drafts, preview restore and guarded explicit publication.
- [x] 45. Searchable revisioned notes.
- [x] 46. Curated project onboarding summaries.
- [x] 47. Explicit schedule time zones and previews.
- [x] 48. Inspectable webhook queue.
- [x] 49. Failed delivery replay.
- [x] 50. Automation dry runs.
- [x] 51. Grouped prioritized review inbox for manual and unattended questions, blocked work, failures and results.
- [x] 52. GitLab/Bitbucket code fetch, prepared-container review, comments/replies/resolution, verified-result push, new PR creation and pinned Git merge. Durable unknown-operation receipts prevent automatic replay. Unsupported native queue/policy/atomic approval capabilities are explicit and fail closed. See [code-host workflows](code-hosts.md).
- [x] 53. Linear and Jira sources.
- [x] 54. Opt-in external notifications.
- [x] 55. Documented CLI and versioned API.
- [x] 56. Multi-repository dependency DAGs, pinned verification/source policy, durable child receipts, current accepted result evidence, reviewed shipping matrices and explicit per-repository CAS merges. Actual two-repository browser acceptance passed. See [coordinated changes](coordinated-changes.md).
- [x] 57. Isolated agent containers.
- [x] 58. Secure paired phone sessions.
- [x] 59. Per-project CAS read/write allow/deny rules enforce app access and intersect current/pinned policies. Manual filtered Docker tasks use immutable prepared images, allowed committed files in a fresh Git namespace, read-only denied-write mounts, bounded outputs, confirmed cancellation and explicit source/policy/content-checked review-branch imports. Ordinary native/SSH/automated execution remains paused under restrictions. Actual Docker isolation/import/cancellation and browser acceptance passed. See [filesystem policy](filesystem-policy.md).
- [x] 60. Secret filtering for exported content.
- [x] 61. Saved per-type retention policies for archived runs, attachments, run memory and worktrees, with protected exact plans and explicit offline application.
- [x] 62. Backup and restore.
- [x] 63. History compaction and pagination.
- [x] 64. Sanitized diagnostic bundles.
- [x] 65. Persistent connection status.
- [x] 66. Continuous official supported-version CLI version/help matrix, bounded isolated installs, exact executable/version checks, protocol fixtures and retained reports. Five actual official CLI probes passed locally; GitHub Actions execution awaits a pushed branch. See [compatibility evidence](provider-compatibility.md).
- [x] 67. Task-specific provider comparisons.
- [x] 68. Human rework tracking.
- [x] 69. Critical-path timing analysis.
- [x] 70. Reproducible benchmark fixtures and model identities.
- [x] 71. Local scrypt identities, revocable expiring sessions, scoped viewer/reviewer project roles, safe results/feeds/exports and commit-anchored human review. Owner remains the sole executor. See [shared projects](shared-projects.md).
- [x] 72. Local VS Code integration with SecretStorage connection, task creation, run inspection, cancellation and result worktrees; packaged and tested in the actual editor host.
- [x] 73. Explicit trusted bundled provider/workflow plugins, negotiated API/capabilities, captured hash-verified cache bytes, atomic registration and immutable run version/hash pins. No repository auto-discovery or HTTP installation. See [extension contracts](extensions.md).

## Implementation boundaries

Mutation, visual and accessibility gates execute explicitly configured repository
scripts; they do not supply mutation engines or image baselines. External
provider APIs were validated with HTTP fixtures and real local Git repositories,
not live third-party account writes. GitLab/Bitbucket code fetching is explicit;
ordinary source-text imports remain read-only. Native containers and encrypted
loopback SSH use fake CLIs, with no inference quota. Official compatibility
probes execute only version/help. Shared roles grant review access; phone pairing
grants owner control. Critical-path metrics use observed time, not predictions.

Architecture and semantic-memory analysis are bounded static/deterministic tools,
not complete runtime dependency discovery or unrestricted natural-language
reasoning. Extensions are trusted full-authority server code. Remote workers
must be provisioned explicitly. Code-host native queues and unsupported policy
semantics require the provider UI. These are documented implementation boundaries,
not silently simulated success.

## Validation

Use fake agents for development. Never spend real provider quota, publish results,
send external notifications, or mutate third-party accounts as a side effect of
the test suite. Account-dependent features require explicit configured credentials
for live acceptance testing; fixture coverage is recorded separately.

The first checkpoint passed 621 unit tests with three opt-in Docker cases skipped;
those three native Docker cases passed separately. Its full browser suite passed
35/35. The second batch's unit run passed 688/688 executed checks (three optional
Docker cases skipped). Focused browser acceptance also covers conventions,
dependency discovery, deferred restart/receipt recovery, selective reruns,
retention, context budgets, commit reversions and language-service references.
The final full browser rerun passed 45/45 after the folder-picker race fix.
The VS Code extension passed actual host acceptance on installed VS Code 1.141.0,
and the packaged VSIX passed the same host acceptance after isolated installation,
including delayed-response connection/disconnection regressions. No real provider
quota, external notifications or third-party account mutations were used.
The test runner limits unit concurrency to four files and browser concurrency to
two because these suites launch real Git, server and browser processes.

The final implementation checkpoint passed 812 unit checks with six optional
native-runtime checks skipped. Those five real Docker checks and the encrypted
loopback SSH check passed separately. The full browser suite passed 64/64.
The last filtered-task concurrency changes passed 31 focused unit checks and
2/2 browser flows after the main suite had started. Native acceptance includes
fresh-home credential seeding with dummy credentials, denied-file/original-Git
absence, read-only mounts, exact review-branch import and confirmed cancellation.
The packaged VSIX passed actual installed VS Code host acceptance again.
Typecheck, UI/worker builds, 68 accessibility renderings and local documentation
links passed. Provider version/help probes used actual official binaries; no
live inference, account mutation or notification delivery occurred.
