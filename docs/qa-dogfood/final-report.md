# QA continuation report

All 55 documented fix clusters are integrated on `codex/dogfood-qa-continue`. Final review also found cross-feature repairs. On frozen source/test revision `ef60cf0`, the full unit suite passed 2,158 with 13 skipped, and the browser suite passed 594 with 17 skipped; neither had failures or cancellations. This report must not be read as a claim that every product feature or platform is proven.

## Changes by cluster

Each linked report records the original issue, root cause, actual change, regression and original workflow replay, including any not-a-bug or deferred outcome. Counts are issue headings, including related or duplicate entries; they are not a count of distinct defects. The original 508-feature discovery inventory is historical, not 508 newly repeated end-to-end tests.

| Cluster report | Changed area | Issue entries |
| --- | --- | ---: |
| [00 · fs-policy-gate](clusters/00-fs-policy-gate.md) | Filesystem-restriction gate: shell/model-catalog/frame-policy bypass + UI blocked states | 14 |
| [01 · insights-cleanup](clusters/01-insights-cleanup.md) | Insights 'Clean up' safety: NaN days, force-removal, shared chat guard, leftover folders | 13 |
| [02 · deferred-runs](clusters/02-deferred-runs.md) | Deferred runs ('Run once later'): null verification profile, retention, startup load, stale UI | 8 |
| [03 · approvals-inbox](clusters/03-approvals-inbox.md) | Approvals inbox: Codex approvals auto-declined, card swapping, question cards, expiry | 8 |
| [04 · run-worktree-lifecycle](clusters/04-run-worktree-lifecycle.md) | Run worktree/branch lifecycle: unpublished/unpersisted worktrees, run-log durability, archive, prefix races | 12 |
| [05 · merge-ship-conflicts](clusters/05-merge-ship-conflicts.md) | Merge & conflict resolution: committed conflict markers, mid-merge timeouts, merge targets | 9 |
| [06 · review-diff-comments](clusters/06-review-diff-comments.md) | Review diffs and comment sending: quoted paths, blank diffs, recipient fallback, provider lock | 9 |
| [07 · agy-unrestricted](clusters/07-agy-unrestricted.md) | Antigravity unrestricted opt-in persistence, fork-chat permission inheritance, agy isolation | 8 |
| [08 · composer-permission-menu](clusters/08-composer-permission-menu.md) | Composer permission menu vs what the run gets (trust, tool approvals, Docker, Antigravity defaults) | 8 |
| [09 · composer-draft-config](clusters/09-composer-draft-config.md) | Composer drafts vs repo config: stale check/setup/limits, deleted base, rerun leaks | 9 |
| [10 · composer-presets-global](clusters/10-composer-presets-global.md) | Templates/workflows/project defaults clobber global Agents & models settings | 6 |
| [11 · check-runner-failures](clusters/11-check-runner-failures.md) | Check/gate runner: can't-run gates, Docker daemon down, fixed timeouts, malformed package.json | 11 |
| [12 · result-verdict-evidence](clusters/12-result-verdict-evidence.md) | Run result verdicts: tampered tests shown as passed, race per-branch evidence, team verdict propagation, lifecycle API codes | 11 |
| [13 · schedule-editor-tz](clusters/13-schedule-editor-tz.md) | ScheduleEditor & automation time zones/DST, catch-up, interval validation, stale-tab edits | 15 |
| [14 · filtered-tasks-workbench](clusters/14-filtered-tasks-workbench.md) | Filtered tasks & repository tools: secrets classification, destructive cancel, checkpoints | 10 |
| [15 · team-engine-control](clusters/15-team-engine-control.md) | AI team engine: control-word cancellation, budget during plan approval, follow-ups, per-teammate settings | 9 |
| [16 · chat-thread-team-ui](clusters/16-chat-thread-team-ui.md) | Chat thread & team activity rendering: lost bubbles/question cards, raw enums, reply box errors | 8 |
| [17 · collab-attempts](clusters/17-collab-attempts.md) | Team board attempts: connection-lost recovery, current attempt choice, hand-over recipient | 9 |
| [18 · missions-ui](clusters/18-missions-ui.md) | Project missions UI: stale edit overwrite, one-click dismiss/archive, budget inputs, refused actions | 11 |
| [19 · missions-engine](clusters/19-missions-engine.md) | Project missions engine: archive invalidates drafts, orphaned missions, reconcile errors, triggers | 14 |
| [20 · code-hosts](clusters/20-code-hosts.md) | Code-host fetch/review: untrusted PR branches, 'unknown' receipts, ledger exhaustion, preview errors | 6 |
| [21 · coordinated-changes](clusters/21-coordinated-changes.md) | Coordinated changes: startup crash, revision churn, cancel/retry semantics, raw errors | 9 |
| [22 · side-browser](clusters/22-side-browser.md) | Side-panel live Browser: preview navigation loop, Pick/Box state, stale refs, console, Snapshot remnants | 10 |
| [23 · side-notes-terminal](clusters/23-side-notes-terminal.md) | Side panel notes, terminals and chat: offline draft overwrite, autosave, restart notice, pop-out | 9 |
| [24 · auth-session-accounts](clusters/24-auth-session-accounts.md) | Owner session cookie, sign-in pages and shared accounts | 11 |
| [25 · attention-counts](clusters/25-attention-counts.md) | Inbox/'Needs you' attention counts, notifications at boot, collapsed-rail badge | 12 |
| [26 · history-paging-counts](clusters/26-history-paging-counts.md) | Run history paging: counts from loaded pages, filters, bulk select, breadcrumbs | 14 |
| [27 · projects-ui-store](clusters/27-projects-ui-store.md) | Projects: moving chat runs, Repositories tab, stale edits, unreadable drafts/projects.json | 9 |
| [28 · github-pr-watch](clusters/28-github-pr-watch.md) | PR watch & PR comments: pushing blocked fixes, restart state, merged-outside, duplicate posts | 11 |
| [29 · github-pr-open-picker](clusters/29-github-pr-open-picker.md) | Opening PRs and the GitHub picker: titles from boilerplate, outsider titles in tasks, 50-item cap, GHE | 12 |
| [30 · acp-extension-providers](clusters/30-acp-extension-providers.md) | ACP & extension providers: selectable but never runnable, connection form validation | 12 |
| [31 · diagnostics-maintenance](clusters/31-diagnostics-maintenance.md) | Diagnostics redaction & export, maintenance CLI and retention | 9 |
| [32 · start-input-validation](clusters/32-start-input-validation.md) | Start-input validation & numeric run limits: 500s, silent clamps, compare setups caps | 15 |
| [33 · composer-start-feedback](clusters/33-composer-start-feedback.md) | Composer start blockers, provider/model feedback, files tree, folder picker and Improve | 15 |
| [34 · run-next-action](clusters/34-run-next-action.md) | Run next-action card & status wording: provider/usage stops, failed-no-change results, pause/priority | 14 |
| [35 · automation-records](clusters/35-automation-records.md) | Automation records & routes: deleted projects, no-trigger automations, stale lastError, 500s, unknown kinds | 13 |
| [36 · automation-webhooks](clusters/36-automation-webhooks.md) | Automation webhooks/events: duplicate runs from 'labeled', retry feedback, dry-run fencing | 7 |
| [37 · sweeps-triage](clusters/37-sweeps-triage.md) | Backlog sweeps & triage actions: severity defaults/filter, 25-item cap, triage state guards, warning loss | 9 |
| [38 · collab-task-permissions](clusters/38-collab-task-permissions.md) | Team board tasks: concurrent edit overwrite, role checks, self-review, viewer UI | 7 |
| [39 · collab-connect-link](clusters/39-collab-connect-link.md) | Team connections & runner link: default port, wizard resume, alias duplicates, dead connect check, startup crash | 11 |
| [40 · collab-connection-wording](clusters/40-collab-connection-wording.md) | Team connection selection & stale 'Settings → Team' wording, stream limit, draft loss | 9 |
| [41 · phone-pairing-pages](clusters/41-phone-pairing-pages.md) | Phone pairing & phone-facing pages: ghost devices, raw JSON errors, stale copy, device list | 13 |
| [42 · phone-listener-tls](clusters/42-phone-listener-tls.md) | Phone listener awareness and remote TLS status | 9 |
| [43 · preview-journeys](clusters/43-preview-journeys.md) | Result preview server & recorded scenarios/pins | 12 |
| [44 · run-conversation-bar](clusters/44-run-conversation-bar.md) | Run page conversation bar & message rendering: markdown, notes, drafts, toasts, provider names | 10 |
| [45 · provider-health](clusters/45-provider-health.md) | Provider health dialog & model catalog: usage-limit display, refresh, stale catalogs, probes | 8 |
| [46 · solo-check-docs](clusters/46-solo-check-docs.md) | Solo 'Done when' promises and stale docs pages (patterns, getting-started, help companion) | 8 |
| [47 · shell-dialogs-palette](clusters/47-shell-dialogs-palette.md) | App shell dialogs, toasts and command palette | 12 |
| [48 · a11y-keyboard-layout](clusters/48-a11y-keyboard-layout.md) | Accessibility, keyboard shortcuts and phone layout | 11 |
| [49 · stream-health-tabs](clusters/49-stream-health-tabs.md) | Live stream reconnect, /api/health metrics and cross-tab run deletion | 7 |
| [50 · integration-connections](clusters/50-integration-connections.md) | Integration connections view: disconnect confirmation, workflow leaks, test feedback, truncation | 9 |
| [51 · memory-ml-stats](clusters/51-memory-ml-stats.md) | Project memory analysis, ML training workspace and workflow stats | 10 |
| [52 · team-dialogs-templates](clusters/52-team-dialogs-templates.md) | AI team setup dialogs and team templates | 8 |
| [53 · ssh-clients-packaging](clusters/53-ssh-clients-packaging.md) | SSH connections, desktop/VS Code/CLI clients and packaging scripts | 12 |
| [54 · notifications](clusters/54-notifications.md) | Notification delivery: restart false failures, damaged state, redirects, history, watch keys | 5 |

## Final cross-feature findings

- An unchanged linked PR retains its update/merge actions, while empty review/preview controls remain hidden.
- Team planning accepts a provider-reported canonical model identity for a selected alias, preserves model/effort pairs and rejects unselected models.
- A grouped chat opens the root, fork or side chat waiting for a native approval; authoritative attention counts and history filters use the same live state. Routing also works when a pending summary arrives before the approval details.
- Archive counts participate in the button's accessible name. Host action errors survive background queue refresh. Team counters use singular wording when appropriate.
- Onboarding preserves literal whitespace and distinct branch/path conditions when eliminating exact duplicate guidance. Published sections retain those conditions.
- Restricted conventions and repository-default discovery pause at their actual project/repository scope, preserving local drafts through policy changes. An unrestricted project remains usable when a different repository is restricted. Following the policy link between projects sharing a repository retains unsaved defaults without silently saving them.
- Stopping a preview invalidates its matching queued automatic navigation while preserving replacement and manual navigation. The repair does not claim to cancel backend work already dispatched.
- Issue, pull-request and CI handoffs wait for project draft restoration, explain the wait and preserve existing draft/error behavior.
- Snapshot inspection detects same-size edits across Git index timestamp boundaries. Rollback restores the original staged/unstaged split, and staging-only changes produce an explicit warning. Separate baseline reproductions and linked-worktree review verify these repairs.
- Git staging limits report the actual 256 MiB/20,000-file refusal and are checked before destination object import or the push effect boundary.

See [validation evidence](final-validation.md), [daily Agent and Team workflows](final-partials-daily.md), [Git and remote workflows](final-partials-git-remote.md), and [Team, collaboration and ML workflows](final-partials-team-ml.md). The [53-row partial-feature reconciliation](final-partial-coverage.md) records 40 gaps replayed within their stated methods, 12 qualified partial features and one blocked feature.

## Real versus simulated evidence

Real Chrome drove the isolated application; most provider and code-host responses were deterministic fixtures. Packaged macOS Electron crash/quit/relaunch checks and an isolated VS Code extension-host acceptance run passed; their providers remained fake. Actual loopback OpenSSH covered remote workspace browsing, fake-agent execution, browser actions, preview HTTP/WebSocket transport and resumable ML dataset transfer. This verifies transport and UI behavior; a fake training recipe is not evidence of real model training quality.

Three deliberately small real-provider workflows were run on scratch repositories with Haiku/low: an Agent task passed; the first Team task stopped conservatively at its coordinator budget after exposing the alias mismatch; the corrected Team task passed planning, implementation, independent review and the unchanged check. Its worker message was durably saved and visible after restart/reload, queued for the next coordinator turn. No second turn consumed it. Provider-reported API-equivalent cost for these workflows was approximately $0.045; this is not a subscription bill.

## Independent review

[Security and persistence review](final-security-review.md), [UI state/workflow review](final-ui-state-review.md), and [final production-delta review](final-delta-review.md) document inspected paths, independent evidence and limits. Findings led to additional repairs; these reviews are not a security certification. [The late memory/ML review](final-memory-review.md) found and verified the exact-text and applicability repair; [independent follow-through](final-memory-correctness-review.md) found and verified literal path/branch rendering. The memory review reports no remaining finding in its documented scope. [Conventions follow-through](final-conventions-policy-review.md) independently exercises five delayed-response boundaries and ten related policy checks. [Repository-defaults review](final-repo-defaults-review.md) found and verified the shared-owner draft handoff, including exact scope and one-use consumption. [Git snapshot follow-through](final-git-index-review.md) independently verifies copied-index timestamp safety, staging-only detection and faithful rollback. [Preview navigation follow-through](final-preview-navigation-followthrough.md) records the stopped-preview race and its boundaries; [draft handoff readiness](final-integration-draft-readiness.md) records the separately reproduced initialization race. [Cross-feature follow-through review](final-after-races-review.md) found no remaining actionable issue in the three latest changes, within its documented limits.

## Limits and cleanup

External Tailscale enrollment/certificate issuance, Linux/systemd service operation, unavailable Docker/WSL paths, real desktop foreground permissions, actual quota exhaustion and the full real-provider beta matrix remain explicitly qualified. The original real isolated Antigravity prohibited-URL call was not reached. Final feature status is based on evidence per row, not a blanket pass.

85 historical temporary QA worktrees were removed: 74 clean, merged checkouts after preserving 47 output archives, then 11 inactive checkouts after complete verified recovery snapshots. All 26 merged `qa-fix/*` branches were deleted; the unmerged `codex/qa-team-dialogs-templates` tip remains recoverable. [The recovery report](cleanup-historical-worktrees.md) records exclusions, manifests and recovery refs. Exact mappings and checksums are under `/private/tmp/codeflow-qa-continue/` in `cleanup-results.json`, `cleanup-branches.json` and `cleanup-local-changes-results.json`. A further nine inactive final-lane checkouts were removed after preserving their evidence and the detached review checkout, bringing the current total to 94. [Final-lane cleanup](cleanup-final-worktrees.md) records exact paths and archive mappings. The seven remaining repair checkouts were then fully archived, verified and removed, bringing the total to101. One additional unchanged authentication-replay checkout was then preserved and removed (102 total). [Last repair cleanup](cleanup-last-repair-worktrees.md) records their exact archive paths/checksums and preserved branch refs. The last four reviewed fix checkouts were also preserved and removed, bringing registered QA removals to106. [Final fix cleanup](cleanup-final-owned-fixes.md) records their branches, archive hashes and two separately removed diagnostic copies. The clean unchanged phone replay checkout and three reviewed repair checkouts were subsequently preserved and removed, bringing the registered QA total to 110. [Recent cleanup](cleanup-recent-fixes.md) records the evidence and exact archive mappings. Seventeen registered paths remain, including the integration checkout and excluded user paths; two unregistered diagnostic copies were removed separately.

The seven historical MQTT-MCP `.worktrees/<id>/.context` directories remain a manual cleanup item because the real project repository is outside this QA task's mutation boundary. Their exact paths are in [remaining work](remaining.md). User-owned OPCUA worktrees remain excluded.

Historical isolation incident: earlier QA commands omitted the outer scratch `CODEFLOW_HOME` before static imports. An exit hook may have written an empty registry to `/Users/mx/.codeflow/processes.json`; this was not confirmed and the live home was not inspected or repaired. The exact exposures and mitigation are preserved in [finished work](finished.md). The later import-only registry fix does not resolve that historical uncertainty.

No main merge, external remote push, real PR or external publication was performed. Existing suites used disposable local bare Git remotes. The live application was not restarted, rebuilt or driven for this continuation.
