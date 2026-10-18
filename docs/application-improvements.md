# Application improvement program

This work continues the application review on branch `codex/application-improvements`, created from `main` at `abbb6be`. The original review contained defects, 14 broader product problems, and 73 feature ideas; those are tracked separately below.

Current scope: all six priority correctness packages implemented; 11 broader problems addressed and three partially addressed; 52 feature items implemented, 15 partial, and six pending. This is not completion of all 73 feature ideas.
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
- [ ] **Partial.** 8. Bound history startup, storage, and browsing. Checkpoint caches, compaction and cursor browsing exist. All run metadata still loads into memory, and old attention items can enlarge the feed.
- [x] 9. Include inline GitHub review comments.
- [x] 10. Enforce browser correctness in CI.
- [x] 11. Make evaluation reproducible and retain experimental evidence gates.
- [ ] **Partial.** 12. Separate core responsibilities behind tested modules. New responsibilities have tested modules, but the core engine and server still need further decomposition.
- [ ] **Partial.** 13. Improve keyboard, focus, touch, and screen-reader behavior. Keyboard, mobile, labels and focus flows improved; a complete accessibility audit remains open.
- [x] 14. Attribute provider results with samples and uncertainty.

## Feature acceptance backlog

- [ ] **Partial.** 1. Guided onboarding and dependency/authentication health. First-run guide and provider/Git health implemented; optional browser/terminal dependency discovery is incomplete.
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
- [ ] **Pending.** 14. Selective task reruns and downstream evidence invalidation. Requires selective replay planning and downstream evidence invalidation.
- [ ] **Pending.** 15. Quota-aware deferred execution. Requires durable deferred dispatch against provider quota/reset windows.
- [x] 16. Token and API-equivalent usage ceilings.
- [x] 17. Conflict-aware task assignments.
- [ ] **Pending.** 18. Remote execution workers. Requires a selected remote worker protocol, configured target and live worker acceptance.
- [x] 19. Multiple verification gates.
- [x] 20. Repository verification profiles.
- [x] 21. Requirement-to-evidence mapping across workflows.
- [x] 22. Review coverage reporting.
- [x] 23. Change risk summaries.
- [x] 24. Baseline and flaky-check diagnosis.
- [x] 25. Optional mutation verification.
- [x] 26. Visual and accessibility verification gates.
- [ ] **Partial.** 27. Inline GitHub review synchronization. Inline comments, replies, locations and truncation are ingested and watched; remote thread resolution is absent.
- [x] 28. Validate the current merge target.
- [x] 29. Export verification reports.
- [ ] **Partial.** 30. Symbol-aware code search. Bounded declaration search exists; language-server symbols and reference resolution are absent.
- [ ] **Partial.** 31. Dependency and architecture exploration. JavaScript/TypeScript relative imports are explored; dynamic, package and other-language architecture analysis is absent.
- [x] 32. File editing with save previews and conflicts.
- [x] 33. Selective file/hunk application.
- [x] 34. Three-way conflict resolution.
- [x] 35. Multi-service workspace launch profiles.
- [ ] **Partial.** 36. Context inspection before dispatch. Explicit file previews, redaction and size estimates exist; directory expansion and final provider-context budgets are absent.
- [ ] **Partial.** 37. Concurrent workspace activity coordination. Active workspace editing is blocked and overlapping task paths serialize; there is no general workspace lease system.
- [ ] **Partial.** 38. Checkpoint comparison and revert. Checkpoint lists, selected file/hunk comparison and restoration exist; full commit comparison/revert is absent.
- [x] 39. Memory provenance graph.
- [x] 40. Memory edit conflict resolution.
- [x] 41. Memory deletion impact preview.
- [x] 42. Stale-memory detection.
- [ ] **Partial.** 43. Memory duplicates and contradictions. Exact and lexical duplicate suggestions exist; semantic contradiction analysis is absent.
- [ ] **Partial.** 44. Versioned project conventions. Existing conventions are Git files and can be edited/restored; a dedicated versioned conventions library is absent.
- [x] 45. Searchable revisioned notes.
- [x] 46. Curated project onboarding summaries.
- [x] 47. Explicit schedule time zones and previews.
- [x] 48. Inspectable webhook queue.
- [x] 49. Failed delivery replay.
- [x] 50. Automation dry runs.
- [ ] **Partial.** 51. Grouped prioritized review inbox. Project-scoped automation review exists; a grouped, prioritized review inbox is absent.
- [ ] **Partial.** 52. GitLab and Bitbucket adapters. GitLab/Bitbucket read-only metadata imports exist; PR code fetching, push and full review/merge parity are absent.
- [x] 53. Linear and Jira sources.
- [x] 54. Opt-in external notifications.
- [x] 55. Documented CLI and versioned API.
- [ ] **Pending.** 56. Coordinated multi-repository changes. Requires cross-repository dependency, validation and shipping coordination.
- [x] 57. Isolated agent containers.
- [x] 58. Secure paired phone sessions.
- [ ] **Partial.** 59. Filesystem access policies. Symlink containment, worktree guards and container mounts are enforced; configurable per-project filesystem allow/deny policies are absent.
- [x] 60. Secret filtering for exported content.
- [ ] **Partial.** 61. Retention and deletion policies. Offline archived run-log retention exists; separate saved policies for attachments, memory and worktrees are absent.
- [x] 62. Backup and restore.
- [x] 63. History compaction and pagination.
- [x] 64. Sanitized diagnostic bundles.
- [x] 65. Persistent connection status.
- [ ] **Partial.** 66. Provider contract fixtures and compatibility checks. Provider/process fixtures and installed-CLI health checks exist; a continuous supported-version compatibility matrix is absent.
- [x] 67. Task-specific provider comparisons.
- [x] 68. Human rework tracking.
- [x] 69. Critical-path timing analysis.
- [x] 70. Reproducible benchmark fixtures and model identities.
- [ ] **Pending.** 71. Shared projects and role permissions. Requires an identity system and server-enforced project roles.
- [ ] **Pending.** 72. Editor integrations. Requires a selected editor integration and its host acceptance environment.
- [ ] **Partial.** 73. Versioned provider/workflow extension contracts. Versioned HTTP operations and typed adapter capabilities exist; provider/workflow plugin loading and version negotiation are absent.

## Implementation boundaries

Mutation, visual and accessibility gates execute explicitly configured repository scripts; they do not supply mutation engines, browser rules or image baselines. External source adapters were validated with HTTP fixtures, not live third-party accounts, and import source text/metadata without fetching PR code. Native agent containers were tested with Docker and fake CLIs; real provider credentials/quota were not used. Critical-path metrics use observed time, not predictions. Phone pairing grants owner control rather than project roles.

Remote workers, shared identity/roles, editor hosts, selective task replay, deferred quota dispatch and multi-repository coordination remain pending. These are new systems rather than small fixes, and are not represented as completed by scaffolding.

## Validation

Use fake agents for development. Never spend real provider quota, publish results,
send external notifications, or mutate third-party accounts as a side effect of
the test suite. Account-dependent features require explicit configured credentials
for live acceptance testing; fixture coverage is recorded separately.

The full browser suite passed 34/34 on the implemented integration surface. The unit suite passed 621 tests with three opt-in Docker cases skipped; those three native Docker cases passed separately. Thirty-five post-audit unit checks and the three workspace browser cases, including draft recovery, also passed. A final full-browser rerun includes the new draft case. The test runner limits unit concurrency to four files and browser concurrency to two because these suites launch real Git, server and browser processes.
